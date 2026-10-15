'use strict';
/*
 * watch-targets.js —— 持续监听新出现的页面目标
 *
 * 用途：独立窗口（悬浮番茄钟、编辑窗口、小组件）是**按需创建**的，
 * 只在用户操作时才存在。这个工具盯着调试端口，一旦有新目标出现就
 * 立刻报告它的注入状态 —— 用于发现"某些页面注入不到"的问题。
 *
 * 用法：node tools/watch-targets.js <端口> [监听秒数]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const DURATION = Number(process.argv[3] || 60);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d)); })
      .on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
        return;
      }
      if (m.method && this.handlers.has(m.method)) {
        for (const h of this.handlers.get(m.method)) { try { h(m.params); } catch { /* ignore */ } }
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 12000);
    });
  }
}

async function inspect(target, label) {
  try {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const st = document.querySelector('style[data-by="Todo清单"], #__noglass_todo_list__');
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        let light = 0, total = 0;
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          const rc = el.getBoundingClientRect();
          if (rc.width * rc.height < 2000) continue;
          total++;
          const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
          if (!m) continue;
          const p = m[1].split(',').map(Number);
          const a = p.length > 3 ? p[3] : 1;
          if (a < 0.5) continue;
          if (p[0]*0.299 + p[1]*0.587 + p[2]*0.114 > 190) light++;
        }
        return { injected: !!st, bodyBg, light, total, ready: document.readyState };
      })())`,
      returnByValue: true,
    });
    const d = JSON.parse(r.result.value);
    ws.close();
    const ok = d.injected && d.light === 0;
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    console.log(`      url   : ${target.url}`);
    console.log(`      注入  : ${d.injected ? '是' : '否'}   bodyBg: ${d.bodyBg}   ready: ${d.ready}`);
    console.log(`      亮底  : ${d.light} / ${d.total} 个大元素`);
    return ok;
  } catch (e) {
    console.log(`  ? ${label}`);
    console.log(`      url: ${target.url}`);
    console.log(`      连接失败: ${e.message}`);
    return false;
  }
}

(async () => {
  // 先列现有的
  console.log('=== 现有页面目标 ===');
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const pages = list.filter((t) => t.type === 'page' || t.type === 'webview');
  const seen = new Set(pages.map((t) => t.id));
  for (const t of pages) await inspect(t, t.title || '(无标题)');

  // 订阅浏览器级事件，等新目标
  console.log();
  console.log(`=== 监听新窗口（${DURATION} 秒）===`);
  console.log('（现在去应用里打开独立窗口：悬浮番茄钟、编辑待办、日历小组件等）');
  console.log();

  const ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`));
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const found = [];
  cdp.handlers.set('Target.targetCreated', [(p) => {
    const t = p && p.targetInfo;
    if (!t) return;
    if (t.type !== 'page' && t.type !== 'webview') return;
    if (seen.has(t.targetId)) return;
    seen.add(t.targetId);
    found.push(t);
    console.log(`[新窗口] ${t.title || '(无标题)'}`);
    console.log(`         ${t.url}`);
  }]);

  await new Promise((r) => setTimeout(r, DURATION * 1000));
  ws.close();

  console.log();
  if (!found.length) {
    console.log('没有新窗口出现 —— 独立窗口未被触发，或它们不通过调试端口暴露。');
  } else {
    console.log(`出现 ${found.length} 个新窗口，逐个检查注入状态：`);
    console.log();
    // 重新查 /json/list 拿 webSocketDebuggerUrl
    const list2 = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
    for (const t of found) {
      const live = list2.find((x) => x.id === t.targetId);
      if (live) await inspect(live, t.title || '(无标题)');
      else console.log(`  - ${t.title || '(无标题)'}  已消失`);
    }
  }
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
