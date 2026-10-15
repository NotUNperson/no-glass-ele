'use strict';
/*
 * 通过 CDP 读页面真实计算样式，验证深色 CSS 是否生效。
 * 只读：不发任何修改命令。
 *
 * 用法：node tools/inspect-page.js <port> [选择器...]
 */

const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const EXTRA = process.argv.slice(3);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(d));
    }).on('error', reject);
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); }
      }, 15000);
    });
  }
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('没有可注入页面'); process.exit(1); }

  console.log('页面:', page.title);
  console.log('URL :', page.url);
  console.log();

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const expr = `JSON.stringify((() => {
    const out = { url: location.href, samples: [], counts: {} };

    function info(el, label) {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        label,
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || '',
        bg: cs.backgroundColor,
        color: cs.color,
        w: Math.round(r.width), h: Math.round(r.height)
      };
    }

    // 1) 关键根元素
    for (const [sel, label] of [
      ['html', 'html'], ['body', 'body'], ['#app', '#app'],
      ['.el-container', '.el-container'], ['.el-main', '.el-main'],
      ['.el-aside', '.el-aside'], ['.el-header', '.el-header'],
      ['.el-card', '.el-card'], ['.el-input__inner', '.el-input__inner'],
      ['.el-button', '.el-button'],
    ]) {
      const el = document.querySelector(sel);
      if (el) { const i = info(el, label); if (i) out.samples.push(i); }
    }

    // 2) 统计页面上还有多少"白底"元素（面积 > 5000px² 才算，避免数图标）
    let whiteBig = 0, totalBig = 0, darkBig = 0;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 5000) continue;
      totalBig++;
      const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
      if (!m) continue;
      const [rr, gg, bb, aa] = m[1].split(',').map(Number);
      if (aa === 0) continue;
      const lum = (rr * 0.299 + gg * 0.587 + bb * 0.114);
      if (lum > 200) whiteBig++;
      else if (lum < 90) darkBig++;
    }
    out.counts = { whiteBig, darkBig, totalBig };

    // 3) 有没有注入标记
    const st = document.getElementById('__noglass_todo_list__') || document.getElementById('__noglass__');
    out.styleTag = !!st;
    out.styleId = st ? st.id : null;
    // 自定义片段的标记
    out.hasCustomCss = st ? /Todo清单 深色主题/.test(st.textContent || '') : false;

    return out;
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const data = JSON.parse(r.result.value);

  console.log('=== 计算样式 ===');
  for (const s of data.samples) {
    console.log(`  ${s.label.padEnd(18)} bg=${s.bg.padEnd(24)} color=${s.color.padEnd(22)} ${s.w}x${s.h}`);
  }
  console.log();
  console.log('=== 大元素背景统计（面积 > 5000px²）===');
  console.log(`  总大元素: ${data.counts.totalBig}`);
  console.log(`  亮底(白): ${data.counts.whiteBig}   <- 越少越好`);
  console.log(`  暗底    : ${data.counts.darkBig}`);
  console.log();
  console.log('=== 注入状态 ===');
  console.log('  style 标签存在:', data.styleTag, '| id:', data.styleId);
  console.log('  自定义片段已注入:', data.hasCustomCss);

  if (EXTRA.length) {
    console.log();
    console.log('=== 额外选择器 ===');
    for (const sel of EXTRA) {
      const e2 = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify((()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const cs=getComputedStyle(el);return {sel:${JSON.stringify(sel)},bg:cs.backgroundColor,color:cs.color};})())`,
        returnByValue: true,
      });
      const v = e2.result.value;
      console.log('  ', v === 'null' ? `${sel} -> (未找到)` : v);
    }
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
