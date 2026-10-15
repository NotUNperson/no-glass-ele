'use strict';
/*
 * 检查元素的**内联样式**（style 属性）—— 用来确认某个颜色是运行时写死的，
 * 还是来自 CSS 规则。这决定了 CSS 注入能否覆盖它。
 * 只读。
 *
 * 用法：node tools/check-inline.js <port> <选择器>
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const SEL = process.argv[3];

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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const expr = `JSON.stringify((() => {
    const el = document.querySelector(${JSON.stringify(SEL)});
    if (!el) return { error: '未找到' };
    const out = { inline: el.getAttribute('style') || '', nodes: [] };
    // 往上 4 级看谁带内联颜色
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      const st = cur.getAttribute('style') || '';
      if (/color/i.test(st)) {
        out.nodes.push({
          tag: cur.tagName.toLowerCase(),
          cls: String(cur.className || '').slice(0, 50),
          style: st.slice(0, 220),
        });
      }
      cur = cur.parentElement;
    }
    // 同时统计整页有多少元素带内联 color
    let n = 0;
    const samples = [];
    for (const e of document.querySelectorAll('[style*="color"]')) {
      n++;
      if (samples.length < 6) {
        samples.push({
          cls: String(e.className || '').slice(0, 44),
          style: (e.getAttribute('style') || '').slice(0, 90),
        });
      }
    }
    out.inlineColorCount = n;
    out.samples = samples;
    return out;
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const d = JSON.parse(r.result.value);
  if (d.error) { console.log(d.error); process.exit(1); }

  console.log('选择器:', SEL);
  console.log();
  console.log('该元素自身的 style 属性:', JSON.stringify(d.inline));
  console.log();
  console.log('向上 5 级里带内联颜色的:');
  if (!d.nodes.length) console.log('  （无）');
  for (const n of d.nodes) {
    console.log(`  ${n.tag}.${n.cls}`);
    console.log(`    style="${n.style}"`);
  }
  console.log();
  console.log(`整页带内联 color 的元素数: ${d.inlineColorCount}`);
  for (const s of d.samples) {
    console.log(`  .${s.cls.padEnd(46)} style="${s.style}"`);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
