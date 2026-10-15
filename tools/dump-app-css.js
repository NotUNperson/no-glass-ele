'use strict';
/*
 * dump-app-css.js —— 从应用 asar 里导出它自己的 CSS 规则（排除 node_modules）
 *
 * 目的：**先读源码，再写覆盖**。
 * 之前是"跑一下看哪里不对 → 补一条 → 再看"，靠审计迭代，慢且容易漏。
 * 正确做法是把应用自己声明的颜色规则全导出来，按"浅色背景 / 深色文字"
 * 分类，然后一次性生成覆盖列表。
 *
 * 用法：
 *   node tools/dump-app-css.js                    # 概览
 *   node tools/dump-app-css.js --light-bg         # 只列浅色背景的规则
 *   node tools/dump-app-css.js --dark-text        # 只列深色文字的规则
 *   node tools/dump-app-css.js --selectors        # 只列选择器（去重）
 *   node tools/dump-app-css.js --json             # 机器可读
 */

const fs = require('fs');
const path = require('path');

const ASAR = process.env.NOGLASS_ASAR || '<local-path>';
const args = process.argv.slice(2);
const MODE = args[0] || '--summary';

// ── 打开 asar ──
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const tree = JSON.parse(jb.toString('utf8'));
const base = 16 + jsonLen;

function listFiles() {
  const out = [];
  (function walk(n, pre) {
    for (const k of Object.keys(n.files || {})) {
      const f = n.files[k];
      const q = pre ? pre + '/' + k : k;
      if (f.files) walk(f, q);
      else out.push({ path: q, size: f.size, offset: Number(f.offset), unpacked: f.unpacked });
    }
  })(tree, '');
  return out;
}

function read(entry) {
  if (entry.unpacked) return null;
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset);
  return buf.toString('utf8');
}

// ── 颜色判定 ──
function parseColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();

  // #rgb / #rrggbb / #rrggbbaa
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  // rgb()/rgba()
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  // hsl 太少见，忽略
  return null;
}

const lum = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;

function isLight(c) { return c && c.a > 0.4 && lum(c) > 190; }
function isDarkText(c) { return c && c.a > 0.4 && lum(c) < 110; }

// ── 提取规则 ──
const files = listFiles().filter((f) =>
  /\.css$/i.test(f.path) &&
  !f.unpacked &&
  !f.path.includes('node_modules') &&
  f.size > 200
);

const rules = [];
for (const f of files) {
  const css = read(f);
  if (!css) continue;
  const re = /([^{}]{1,400})\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (!sel || sel.startsWith('@')) continue;
    if (sel.length > 300) continue;

    const bgM = body.match(/background(?:-color)?\s*:\s*([^;!}]+)/i);
    const fgM = body.match(/(?:^|;)\s*color\s*:\s*([^;!}]+)/i);
    if (!bgM && !fgM) continue;

    const bg = bgM ? parseColor(bgM[1].trim()) : null;
    const fg = fgM ? parseColor(fgM[1].trim()) : null;

    rules.push({
      file: path.basename(f.path),
      sel,
      bgRaw: bgM ? bgM[1].trim() : null,
      fgRaw: fgM ? fgM[1].trim() : null,
      bg, fg,
      lightBg: isLight(bg),
      darkText: isDarkText(fg),
      important: /!important/i.test(body),
      scoped: /\[data-v-[0-9a-f]+\]/.test(sel),
    });
  }
}

fs.closeSync(fd);

// ── 输出 ──
if (MODE === '--json') {
  console.log(JSON.stringify({ count: rules.length, rules }, null, 2));
  process.exit(0);
}

console.log(`asar: ${ASAR}`);
console.log(`应用自身 CSS 文件: ${files.length} 个`);
console.log(`含颜色声明的规则: ${rules.length} 条`);
console.log(`  其中浅色背景: ${rules.filter((r) => r.lightBg).length} 条`);
console.log(`  其中深色文字: ${rules.filter((r) => r.darkText).length} 条`);
console.log(`  带 [data-v-xxx]（Vue scoped）: ${rules.filter((r) => r.scoped).length} 条`);
console.log();

if (MODE === '--light-bg') {
  console.log('=== 浅色背景的规则（按背景亮度降序）===');
  console.log();
  for (const r of rules.filter((x) => x.lightBg).sort((a, b) => lum(b.bg) - lum(a.bg))) {
    console.log(`  bg=${r.bgRaw.padEnd(24)} ${r.important ? '!' : ' '} ${r.sel.slice(0, 120)}`);
  }
}

if (MODE === '--dark-text') {
  console.log('=== 深色文字的规则 ===');
  console.log();
  for (const r of rules.filter((x) => x.darkText)) {
    console.log(`  color=${r.fgRaw.padEnd(22)} ${r.important ? '!' : ' '} ${r.sel.slice(0, 120)}`);
  }
}

if (MODE === '--selectors') {
  console.log('=== 所有涉及颜色的选择器（去重）===');
  console.log();
  const uniq = [...new Set(rules.map((r) => r.sel))].sort();
  for (const s of uniq) console.log('  ' + s.slice(0, 150));
  console.log();
  console.log(`共 ${uniq.length} 个唯一选择器`);
}
