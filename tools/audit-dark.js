'use strict';
/*
 * 深色主题质量审计：找出所有仍然偏亮的元素（不限大小）+ 文字对比度不足的地方。
 * 只读。
 *
 * 用法：node tools/audit-dark.js <port> [最小面积，默认 0]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9343);
const MIN_AREA = Number(process.argv[3] || 0);

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

  const expr = `JSON.stringify((() => {
    const MIN = ${MIN_AREA};

    function parse(c) {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      const [r, g, b] = p;
      const a = p.length > 3 ? p[3] : 1;
      return { r, g, b, a };
    }
    const lum = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;

    // 找元素实际生效的背景（向上找第一个不透明的祖先）
    function effectiveBg(el) {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = parse(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0.5) return c;
        cur = cur.parentElement;
      }
      const c = parse(getComputedStyle(document.documentElement).backgroundColor);
      return c || { r: 255, g: 255, b: 255, a: 1 };
    }

    // WCAG 相对亮度
    function relLum(c) {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    function contrast(fg, bg) {
      const l1 = relLum(fg), l2 = relLum(bg);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    }

    const lightEls = [];
    const lowContrast = [];
    let total = 0;

    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < MIN) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      total++;

      const cls = String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 3);
      const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls.map(c => '.' + c).join('');

      // 1) 亮背景
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0.5 && lum(bg) > 190) {
        lightEls.push({ sel, bg: cs.backgroundColor, area: Math.round(area), text: (el.textContent||'').trim().slice(0,28) });
      }

      // 2) 文字对比度（只查直接含文字的元素）
      const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (hasText) {
        const fg = parse(cs.color);
        if (fg && fg.a > 0.5) {
          const ebg = effectiveBg(el);
          const ratio = contrast(fg, ebg);
          if (ratio < 3.0) {
            lowContrast.push({
              sel, color: cs.color, bg: 'rgb(' + ebg.r + ',' + ebg.g + ',' + ebg.b + ')',
              ratio: Math.round(ratio * 100) / 100,
              text: (el.textContent || '').trim().slice(0, 30)
            });
          }
        }
      }
    }

    const dedupe = (arr, key) => {
      const seen = new Set(); const out = [];
      for (const o of arr.sort((a,b)=>b.area-a.area)) {
        const k = key(o);
        if (seen.has(k)) continue; seen.add(k); out.push(o);
        if (out.length >= 30) break;
      }
      return out;
    };

    return {
      total,
      lightCount: lightEls.length,
      light: dedupe(lightEls, o => o.sel + o.bg),
      lowCount: lowContrast.length,
      low: lowContrast.sort((a,b)=>a.ratio-b.ratio).slice(0, 25),
    };
  })())`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const d = JSON.parse(r.result.value);

  console.log(`页面: ${page.url}`);
  console.log(`检查元素: ${d.total}`);
  console.log();

  console.log(`=== 仍是亮背景的元素: ${d.lightCount} 个（去重后列前 30）===`);
  if (!d.light.length) console.log('  无 ✓');
  for (const it of d.light) {
    console.log(`  ${String(it.area).padStart(8)}px²  ${it.bg.padEnd(22)} ${it.sel.slice(0, 80)}`);
    if (it.text) console.log(`             txt: ${it.text}`);
  }

  console.log();
  console.log(`=== 文字对比度不足（<3.0）: ${d.lowCount} 处（最差 25）===`);
  if (!d.low.length) console.log('  无 ✓');
  for (const it of d.low) {
    console.log(`  ratio=${String(it.ratio).padStart(5)}  fg=${it.color.padEnd(22)} bg=${it.bg.padEnd(20)} ${it.sel.slice(0, 60)}`);
    if (it.text) console.log(`             txt: ${it.text}`);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
