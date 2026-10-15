'use strict';
/*
 * nav.js —— 在运行中的应用里切换路由（只改 hash，不重载页面）
 *
 * 为什么需要：验证深色主题要覆盖应用的**所有视图**（today / calendar / …），
 * 而直接改 location.href 会重载页面、可能触发登出。
 * 用 history.pushState + popstate 事件让 Vue Router 走客户端跳转。
 *
 * 用法：node tools/nav.js <端口> <路由，如 /todo-list/calendar>
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const ROUTE = process.argv[3];

if (!ROUTE) {
  console.log('用法: node tools/nav.js <端口> <路由>');
  process.exit(2);
}

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时')); } }, 20000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('没有页面'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const before = await cdp.send('Runtime.evaluate', {
    expression: 'location.hash', returnByValue: true,
  });
  console.log('切换前:', before.result.value);

  // 用 history API 做客户端跳转，避免整页重载。
  //
  // 注意：如果当前 hash 已经被写坏（例如被 git bash 的路径转换搞成
  // "#/C:/Program Files/Git/..."），Vue Router 会解析失败。
  // 所以先 replaceState 清成根路径，再 pushState 到目标路由。
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const route = ${JSON.stringify(ROUTE)};
      try {
        history.replaceState(null, '', '#/');
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      } catch (e) { /* ignore */ }
      history.pushState(null, '', '#' + route);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      return location.hash;
    })()`,
    returnByValue: true,
  });
  console.log('切换后:', r.result.value);

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
