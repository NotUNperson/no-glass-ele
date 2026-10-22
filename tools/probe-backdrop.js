'use strict';
/*
 * 统计页面里仍带 backdrop-filter 的元素，以及 ::backdrop 伪元素的情况。
 * 只读。
 *
 * 用法：node tools/probe-backdrop.js <port>
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时')); } }, 20000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('没有可注入页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const expr = `JSON.stringify((() => {
    const out = {
      total: 0,
      withBackdrop: 0,
      samples: [],
      styleSheets: 0,
      styleIdPresent: false,
      twVarsSet: 0,
    };
    const all = document.querySelectorAll('*');
    out.total = all.length;
    for (const el of all) {
      const cs = getComputedStyle(el);
      const v = cs.backdropFilter || cs.webkitBackdropFilter;
      if (v && v !== 'none') {
        out.withBackdrop++;
        if (out.samples.length < 8) {
          out.samples.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 70),
            val: v,
          });
        }
      }
    }
    // 注入的样式表是否在
    out.styleIdPresent = !![...document.querySelectorAll('style[id]')]
      .find(e => /noglass/i.test(e.id));
    out.styleIds = [...document.querySelectorAll('style[id]')].map(e => e.id);
    out.styleSheets = document.styleSheets.length;
    // Tailwind 变量是否被清掉
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const pcs = getComputedStyle(probe);
    out.twBlurVar = pcs.getPropertyValue('--tw-backdrop-blur').trim();
    probe.remove();
    return out;
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
  ws.close();
})();
