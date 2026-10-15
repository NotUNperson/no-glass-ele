'use strict';
/*
 * 查一个元素的颜色继承链 —— 找出"谁把它染成了黑色"。
 * 只读。
 *
 * 用法：node tools/trace-color.js <port> <选择器>
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
    const start = document.querySelector(${JSON.stringify(SEL)});
    if (!start) return { error: '未找到 ' + ${JSON.stringify(SEL)} };

    const chain = [];
    let cur = start;
    while (cur && cur !== document.documentElement.parentElement) {
      const cs = getComputedStyle(cur);
      const r = cur.getBoundingClientRect();
      const cls = String(cur.className || '').split(/\\s+/).filter(Boolean).slice(0, 4);
      chain.push({
        tag: cur.tagName.toLowerCase(),
        id: cur.id || '',
        cls: cls.join(' '),
        color: cs.color,
        bg: cs.backgroundColor,
        display: cs.display,
        area: Math.round(r.width * r.height),
        // 是否"自己"声明了 color（而不是继承）：比较父子值
        ownColor: null,
      });
      cur = cur.parentElement;
      if (chain.length > 14) break;
    }

    // 逐级判断"color 是在这一级变的"
    for (let i = 0; i < chain.length; i++) {
      const child = i === 0 ? null : chain[i - 1];
      chain[i].colorChangedHere = !child || child.color !== chain[i].color;
    }

    // 再查一下这个元素命中的所有 color 规则（用 CDP 的 CSS 域做不到，用近似办法：
    // 遍历样式表找匹配的规则）
    const matched = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (!rule.selectorText || !rule.style) continue;
          if (!rule.style.color && !rule.style.backgroundColor) continue;
          try {
            if (start.matches(rule.selectorText)) {
              matched.push({
                from: sheet.href ? sheet.href.split('/').pop() : (sheet.ownerNode && sheet.ownerNode.id) || 'inline',
                sel: rule.selectorText.slice(0, 130),
                color: rule.style.color || '',
                bg: rule.style.backgroundColor || '',
                important: rule.style.getPropertyPriority('color') || rule.style.getPropertyPriority('background-color') || ''
              });
            }
          } catch { /* 无效选择器 */ }
        }
      }
    } catch { /* ignore */ }

    return { chain, matched: matched.slice(0, 20) };
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const d = JSON.parse(r.result.value);
  if (d.error) { console.log(d.error); process.exit(1); }

  console.log('选择器:', SEL);
  console.log();
  console.log('=== 颜色继承链（从元素往上）===');
  for (const c of d.chain) {
    const mark = c.colorChangedHere ? '  <== color 在此级确定' : '';
    console.log(`  ${c.tag}${c.id ? '#' + c.id : ''}${c.cls ? '.' + c.cls.replace(/ /g, '.') : ''}`);
    console.log(`      color=${c.color.padEnd(22)} bg=${c.bg.padEnd(22)} ${c.area}px²${mark}`);
  }

  console.log();
  console.log(`=== 匹配到该元素的样式规则（含颜色，${d.matched.length} 条）===`);
  for (const m of d.matched) {
    console.log(`  [${m.from}]`);
    console.log(`    ${m.sel}`);
    if (m.color) console.log(`      color: ${m.color}${m.important ? ' !important' : ''}`);
    if (m.bg) console.log(`      background: ${m.bg}${m.important ? ' !important' : ''}`);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
