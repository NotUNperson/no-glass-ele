'use strict';
/*
 * list-targets.js —— 列出调试端口上的所有页面目标（含独立窗口）
 *
 * 应用有多个独立 BrowserWindow（悬浮番茄钟、编辑窗口、小组件…），
 * 每个是独立渲染进程。这个工具看它们是否都被注入到了。
 *
 * 用法：node tools/list-targets.js <端口>
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时')); } }, 12000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const pages = list.filter((t) => t.type === 'page' || t.type === 'webview');

  console.log(`端口 ${PORT} 上的页面目标: ${pages.length} 个`);
  console.log();

  for (const t of pages) {
    console.log('─'.repeat(74));
    console.log(`  title : ${t.title || '(无)'}`);
    console.log(`  url   : ${t.url}`);
    console.log(`  type  : ${t.type}  id: ${t.id}`);

    try {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const cdp = new CDP(ws);
      await cdp.send('Runtime.enable');

      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify((() => {
          const st = document.getElementById('__noglass_todo_list__') || document.getElementById('__noglass__');
          const bg = getComputedStyle(document.body).backgroundColor;
          // 统计亮底大元素
          let light = 0;
          for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            const rc = el.getBoundingClientRect();
            if (rc.width * rc.height < 3000) continue;
            const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
            if (!m) continue;
            const p = m[1].split(',').map(Number);
            const a = p.length > 3 ? p[3] : 1;
            if (a < 0.5) continue;
            const lum = p[0]*0.299 + p[1]*0.587 + p[2]*0.114;
            if (lum > 190) light++;
          }
          return {
            injected: !!st,
            styleId: st ? st.id : null,
            bodyBg: bg,
            lightBig: light,
            readyState: document.readyState,
            hasApp: !!document.querySelector('#app, .base-layout, [class*="tomato"], [class*="todo"]')
          };
        })())`,
        returnByValue: true,
      });
      const d = JSON.parse(r.result.value);
      console.log(`  注入  : ${d.injected ? '✓ 已注入 (' + d.styleId + ')' : '✗ 未注入'}`);
      console.log(`  bodyBg: ${d.bodyBg}`);
      console.log(`  亮底大元素: ${d.lightBig}${d.lightBig > 0 ? '  <-- 需要处理' : ' ✓'}`);
      console.log(`  就绪  : ${d.readyState} | 有内容: ${d.hasApp}`);
      ws.close();
    } catch (e) {
      console.log(`  连接失败: ${e.message}`);
    }
  }

  console.log();
  console.log('─'.repeat(74));
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
