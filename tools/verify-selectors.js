'use strict';
/*
 * 用"造隐藏元素"的办法验证 CSS 选择器是否命中 —— 不改动页面真实内容，只读结论。
 * 用于验证登录页的选择器（直接跳登录路由会把用户登出，所以不能那么测）。
 *
 * 用法：node tools/verify-selectors.js <port>
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

  // 造一批隐藏元素（不影响布局：display:none 的元素 getComputedStyle 仍能读到规则值，
  // 但为了拿到真实计算值，用 visibility:hidden + 绝对定位 + 0 尺寸）
  const expr = `JSON.stringify((() => {
    const cases = [
      ['登录页容器',        'div', 'login-page'],
      ['登录框',            'div', 'login-box'],
      ['登录卡片',          'div', 'login-card'],
      ['auth 容器',         'div', 'auth-page'],
      ['登录输入框',        'input', 'el-input__inner'],
      ['侧栏',              'div', 'base-layout__sidebar'],
      ['底部条',            'div', 'base-layout__footer'],
      ['待办条目',          'div', 'todo-list-item'],
      ['番茄钟',            'div', 'tomato-timer'],
      ['新建输入区',        'div', 'todo-input-add'],
      ['mx 日期输入',       'input', 'mx-input'],
      ['Element 表格',      'div', 'el-table'],
      ['Element 对话框',    'div', 'el-dialog'],
      ['Element 卡片',      'div', 'el-card'],
    ];
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
    document.body.appendChild(host);

    const out = [];
    for (const [label, tag, cls] of cases) {
      const el = document.createElement(tag);
      // 登录相关的要放在一个 .login-page 祖先里，才能命中后代选择器
      if (/login|auth/i.test(cls)) {
        const wrap = document.createElement('div');
        wrap.className = 'login-page';
        wrap.appendChild(el);
        host.appendChild(wrap);
      } else {
        host.appendChild(el);
      }
      el.className = cls;
      const cs = getComputedStyle(el);
      out.push({ label, cls, bg: cs.backgroundColor, color: cs.color });
    }
    host.remove();
    return out;
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const items = JSON.parse(r.result.value);

  console.log(`页面: ${page.url}`);
  console.log();
  console.log('选择器命中验证（造隐藏元素读计算样式）:');
  console.log();
  let hit = 0;
  for (const it of items) {
    const m = String(it.bg).match(/rgba?\(([^)]+)\)/);
    let lum = null;
    if (m) {
      const parts = m[1].split(',').map(Number);
      const [rr, gg, bb] = parts;
      // 注意：rgb() 只有 3 个分量，没有 alpha。
      // 早期版本把 undefined 当成"透明"，导致所有 rgb() 结果都被误判 —— 这里显式区分。
      const alpha = parts.length > 3 ? parts[3] : 1;
      lum = alpha === 0 ? null : Math.round(rr * 0.299 + gg * 0.587 + bb * 0.114);
    }
    const verdict = lum === null ? '透明（无背景规则）'
      : lum < 100 ? '✓ 深色' : lum > 200 ? '✗ 仍是亮色' : '~ 中间色';
    if (lum !== null && lum < 100) hit++;
    console.log(`  ${it.label.padEnd(14)} bg=${String(it.bg).padEnd(24)} ${verdict}`);
  }
  console.log();
  console.log(`命中深色: ${hit}/${items.length}`);

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
