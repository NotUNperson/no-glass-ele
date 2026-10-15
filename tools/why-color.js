'use strict';
/*
 * 用 CDP 的 CSS 域做**权威**样式溯源：直接问浏览器"这条 color 是哪条规则给的"。
 * 这是查"为什么颜色不对"最可靠的手段 —— 不靠推断。
 * 只读。
 *
 * 用法：node tools/why-color.js <port> <选择器>
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 20000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);

  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Runtime.enable');

  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const found = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: SEL,
  });
  if (!found.nodeId) { console.log('未找到元素:', SEL); process.exit(1); }

  const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: found.nodeId });

  console.log('选择器:', SEL);
  console.log();

  console.log('=== 命中的规则（按优先级，浏览器给的顺序）===');
  const all = [];
  for (const m of matched.matchedCSSRules || []) {
    const rule = m.rule;
    const sel = rule.selectorList ? rule.selectorList.text : '?';
    const props = (rule.style.cssProperties || []).filter((p) => p.name === 'color' || p.name === 'background-color');
    if (!props.length) continue;
    const origin = rule.origin || '?';
    const sheet = rule.styleSheetId;
    all.push({ sel, props, origin, sheet });
  }
  for (const r of all) {
    console.log(`  [${r.origin}] ${r.sel.slice(0, 130)}`);
    for (const p of r.props) {
      console.log(`      ${p.name}: ${p.value}${p.important ? ' !important' : ''}`);
    }
  }

  console.log();
  console.log('=== 内联样式 ===');
  const inl = (matched.inlineStyle && matched.inlineStyle.cssProperties || [])
    .filter((p) => p.name === 'color' || p.name === 'background-color');
  if (!inl.length) console.log('  （无内联颜色）');
  for (const p of inl) console.log(`  ${p.name}: ${p.value}`);

  console.log();
  console.log('=== 继承来的（inherited）===');
  for (const inh of matched.inherited || []) {
    for (const m of inh.matchedCSSRules || []) {
      const props = (m.rule.style.cssProperties || []).filter((p) => p.name === 'color');
      if (!props.length) continue;
      console.log(`  来自 ${inh.inlineStyle ? 'inline' : (m.rule.selectorList ? m.rule.selectorList.text.slice(0, 110) : '?')}`);
      for (const p of props) console.log(`      color: ${p.value}`);
    }
  }

  // 关键：问浏览器"color 的实际值 + 是否有规则在管它"
  const ev = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((()=>{const el=document.querySelector(${JSON.stringify(SEL)});const cs=getComputedStyle(el);return {color:cs.color, bg:cs.backgroundColor};})())`,
    returnByValue: true,
  });
  console.log();
  console.log('最终计算值:', ev.result.value);

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
