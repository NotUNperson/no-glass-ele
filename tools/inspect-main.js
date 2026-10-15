'use strict';
/*
 * inspect-main.js —— 连上主进程，列出它管理的所有 BrowserWindow
 *
 * 这是排查"某些窗口注入不到"的权威手段：
 * 直接问主进程要窗口清单（URL / 尺寸 / 是否可见），
 * 而不是靠猜或靠点。
 *
 * 依赖：注入器启动时带了 --inspect（主进程端口 = CDP 端口 + 1）
 *
 * 用法：node tools/inspect-main.js <主进程端口，默认 9344>
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9344);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d)); })
      .on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 15000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const target = list.find((x) => x.webSocketDebuggerUrl);
  if (!target) { console.log('主进程没有可用调试目标'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  // 主进程是 ESM，用 process.getBuiltinModule 拿 electron
  const expr = `(() => {
    try {
      const { createRequire } = process.getBuiltinModule('module');
      const electron = createRequire(process.execPath)('electron');
      const { BrowserWindow, webContents } = electron;

      const wins = BrowserWindow.getAllWindows().map((w) => {
        let url = null, title = null;
        try { url = w.webContents.getURL(); } catch {}
        try { title = w.getTitle(); } catch {}
        return {
          id: w.id,
          url,
          title,
          visible: (() => { try { return w.isVisible(); } catch { return null; } })(),
          destroyed: (() => { try { return w.isDestroyed(); } catch { return null; } })(),
          bounds: (() => { try { const b = w.getBounds(); return b.width + 'x' + b.height; } catch { return null; } })(),
          frame: (() => { try { return w.isFrameless ? w.isFrameless() : null; } catch { return null; } })(),
        };
      });

      // 所有 webContents（含 BrowserView / WebContentsView 里的）
      const allWc = webContents.getAllWebContents().map((wc) => {
        let url = null, type = null;
        try { url = wc.getURL(); } catch {}
        try { type = wc.getType(); } catch {}
        return { id: wc.id, type, url };
      });

      return JSON.stringify({ ok: true, wins, allWc }, null, 2);
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  })()`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const raw = r.result && r.result.value;
  let d;
  try { d = JSON.parse(raw); } catch { console.log('原始返回:', String(raw).slice(0, 400)); process.exit(1); }

  if (!d.ok) { console.log('主进程报错:', d.error); process.exit(1); }

  console.log('=== BrowserWindow 清单 ===');
  console.log(`共 ${d.wins.length} 个窗口`);
  console.log();
  for (const w of d.wins) {
    console.log(`  #${String(w.id).padEnd(4)} ${w.visible ? '显示' : '隐藏'}  ${w.bounds || ''}`);
    console.log(`        title: ${w.title || '(无)'}`);
    console.log(`        url  : ${w.url || '(无)'}`);
  }

  console.log();
  console.log('=== 所有 webContents ===');
  console.log(`共 ${d.allWc.length} 个`);
  console.log();
  for (const wc of d.allWc) {
    console.log(`  #${String(wc.id).padEnd(4)} ${String(wc.type).padEnd(12)} ${wc.url || '(无)'}`);
  }

  // 关键：找出哪些 webContents 的 URL 不在 CDP 目标列表里（= 没被注入）
  console.log();
  console.log('=== 交叉检查：哪些 webContents 不在 CDP 目标列表 ===');
  const cdpTargets = JSON.parse(await get(`http://127.0.0.1:${PORT - 1}/json/list`));
  const cdpUrls = new Set(cdpTargets.map((t) => t.url));
  let missing = 0;
  for (const wc of d.allWc) {
    if (!wc.url || wc.url === 'devtools://' || wc.url.startsWith('devtools')) continue;
    const inCdp = cdpUrls.has(wc.url);
    if (!inCdp) {
      missing++;
      console.log(`  ✗ 未出现在 CDP 目标: #${wc.id} [${wc.type}] ${wc.url}`);
    }
  }
  if (!missing) console.log('  ✓ 全部 webContents 都在 CDP 目标列表里（可被注入）');

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
