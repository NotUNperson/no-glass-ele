'use strict';
/*
 * 列出页面上"仍然偏亮"的大元素，用于补齐深色 CSS。
 * 只读。
 *
 * 用法：node tools/find-bright.js <port> [最小面积]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const MIN_AREA = Number(process.argv[3] || 3000);

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时')); } }, 15000);
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

  const expr = `JSON.stringify((() => {
    const MIN = ${MIN_AREA};
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < MIN) continue;
      const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
      if (!m) continue;
      const parts = m[1].split(',').map(Number);
      const [rr, gg, bb] = parts;
      const aa = parts.length > 3 ? parts[3] : 1;
      if (aa === 0) continue;
      const lum = rr * 0.299 + gg * 0.587 + bb * 0.114;
      if (lum <= 200) continue;   // 只报亮的

      // 生成一个尽量唯一的选择器：标签 + 类名（取前 3 个类）
      const cls = String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 3);
      const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                  cls.map(c => '.' + c).join('');

      out.push({
        sel,
        bg: cs.backgroundColor,
        color: cs.color,
        area: Math.round(area),
        lum: Math.round(lum),
        text: (el.textContent || '').trim().slice(0, 34)
      });
    }
    // 按面积从大到小，去重
    out.sort((a, b) => b.area - a.area);
    const seen = new Set();
    const uniq = [];
    for (const o of out) {
      const k = o.sel + '|' + o.bg;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(o);
      if (uniq.length >= 40) break;
    }
    return uniq;
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const items = JSON.parse(r.result.value);

  console.log(`页面: ${page.url}`);
  console.log(`仍偏亮的大元素（面积 >= ${MIN_AREA}px²，去重后前 40）: ${items.length}`);
  console.log();
  for (const it of items) {
    console.log(`  lum=${String(it.lum).padStart(3)}  ${String(it.area).padStart(7)}px²  bg=${it.bg.padEnd(22)}`);
    console.log(`      sel: ${it.sel.slice(0, 120)}`);
    if (it.text) console.log(`      txt: ${it.text}`);
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
