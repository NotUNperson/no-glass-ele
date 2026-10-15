'use strict';
/*
 * harvest-selectors.js —— 从**运行中的应用**采集"实际用到且偏亮/偏暗"的选择器
 *
 * 为什么需要（这是源码驱动的重要补充）：
 *   从 CSS 文件里提取规则有一个盲区 —— **Vue 运行时注入的 scoped 样式**。
 *   实测：悬浮番茄钟窗口的 `.tomato[data-v-45545968] { background:#fff }`
 *   既不在 index.css 也不在 widget.css 里，是组件挂载时注入 <style> 的。
 *   只扫 CSS 文件必然漏掉它。

 *   所以既要"读源码"（静态、全量），也要"读运行时"（真实、能覆盖动态注入）。
 *   两者合并才是完整的。
 *
 * 采集内容：所有面积够大的元素，其 background-color 偏亮 / color 偏暗的，
 * 取它的类名。输出可直接喂给 gen-dark-css.js 的前缀聚合。
 *
 * 用法：
 *   node tools/harvest-selectors.js <端口> [url关键词] [最小面积]
 *   node tools/harvest-selectors.js 9343 floating 1500
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const URL_KW = process.argv[3] || null;
const MIN_AREA = Number(process.argv[4] || 1000);

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 25000);
    });
  }
}

async function harvestOne(target, label) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const expr = `JSON.stringify((() => {
    const MIN = ${MIN_AREA};
    const lightBg = new Set();
    const darkText = new Set();
    const samples = [];

    function parseCss(c) {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      const a = p.length > 3 ? p[3] : 1;
      if (a < 0.5) return null;
      return { r: p[0], g: p[1], b: p[2] };
    }
    const lum = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
    // 品牌色（青绿）：保留，不算"该改的深色文字"
    const brandish = (c) => c.g > 90 && c.b > 90 && (c.g - c.r) > 30 && (c.b - c.r) > 20;

    function className(el) {
      // 取第一个有意义的类名（跳过 scoped 属性与其他）
      const cls = String(el.className || '').split(/\\s+/).filter(Boolean);
      return cls[0] || null;
    }

    for (const el of document.querySelectorAll('*')) {
      const rc = el.getBoundingClientRect();
      const area = rc.width * rc.height;
      if (area < MIN) continue;
      const cs = getComputedStyle(el);
      const bg = parseCss(cs.backgroundColor);
      const fg = parseCss(cs.color);

      if (bg && lum(bg) > 190) {
        const c = className(el);
        if (c) {
          lightBg.add(c);
          if (samples.length < 25) samples.push({ kind: 'bg', cls: c, val: cs.backgroundColor, area: Math.round(area), txt: (el.textContent||'').trim().slice(0,30) });
        }
      }
      // 文字：只查直接含文字的元素，避免把容器也算进来
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (hasText && fg && lum(fg) < 110 && !brandish(fg)) {
        const c = className(el);
        if (c) darkText.add(c);
      }
    }

    return JSON.stringify({
      lightBg: [...lightBg].sort(),
      darkText: [...darkText].sort(),
      samples
    });
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  let d = r.result && r.result.value;
  // CDP 有时会把字符串再包一层 JSON（取决于表达式与序列化路径），
  // 所以循环解析直到拿到对象为止，而不是只解一次。
  for (let i = 0; i < 3 && typeof d === 'string'; i++) {
    try { d = JSON.parse(d); } catch (e) {
      throw new Error(`返回不是合法 JSON（第 ${i + 1} 层）：${String(d).slice(0, 200)}`);
    }
  }
  if (!d || typeof d !== 'object') {
    throw new Error(`返回类型异常：${typeof d} — ${String(d).slice(0, 200)}`);
  }
  if (!Array.isArray(d.lightBg) || !Array.isArray(d.darkText)) {
    throw new Error(`返回结构不对：${JSON.stringify(d).slice(0, 200)}`);
  }
  ws.close();
  return d;
}

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  let pages = list.filter((t) => t.type === 'page');
  if (URL_KW) {
    pages = pages.filter((t) => String(t.url).includes(URL_KW));
    if (!pages.length) {
      console.log(`没有匹配 "${URL_KW}" 的页面。现有：`);
      for (const t of list.filter((x) => x.type === 'page')) console.log('  -', t.url);
      process.exit(1);
    }
  }

  console.log(`采集 ${pages.length} 个页面（面积 >= ${MIN_AREA}px²）:`);
  console.log();

  const allLight = new Set();
  const allDark = new Set();

  for (const p of pages) {
    console.log(`── ${p.url}`);
    try {
      const d = await harvestOne(p, p.title);
      for (const c of d.lightBg) allLight.add(c);
      for (const c of d.darkText) allDark.add(c);
      console.log(`   浅底类名: ${d.lightBg.length} 个`);
      console.log(`   深字类名: ${d.darkText.length} 个`);
      for (const s of d.samples.slice(0, 8)) {
        console.log(`     [${s.kind}] .${s.cls.padEnd(30)} ${String(s.val).padEnd(22)} ${s.area}px² ${s.txt}`);
      }
    } catch (e) {
      console.log(`   失败: ${e.message}`);
    }
    console.log();
  }

  console.log('═'.repeat(74));
  console.log(`合并去重后：浅底 ${allLight.size} 个类名，深字 ${allDark.size} 个类名`);
  console.log();
  console.log('=== 浅底类名 ===');
  console.log([...allLight].sort().join('\n'));
  console.log();
  console.log('=== 深字类名 ===');
  console.log([...allDark].sort().join('\n'));
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
