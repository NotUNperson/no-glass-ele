'use strict';
/*
 * gen-dark-css.js —— 从应用源码**自动生成**深色覆盖 CSS
 *
 * 思路（比"跑起来看哪里不对再补"可靠得多）：
 *   1. 扫应用 asar 里自己的 CSS（排除 node_modules）
 *   2. 分类：
 *        · 浅色背景规则  → 需要压深
 *        · 深色文字规则  → 需要提亮（但要排除品牌色）
 *   3. 把选择器归类成"可以批量处理"的组，生成覆盖规则
 *
 * 为什么能自动化：应用的类名有规律（.todo-* / .sidebar-* / .base-layout__* /
 * .el-* / .fc-* / .mx-*），按前缀分组就能覆盖绝大多数。
 * 少数零散的长尾，由 --uncovered 列出来人工补。
 *
 * 用法：
 *   node tools/gen-dark-css.js                  # 输出生成的 CSS 到 stdout
 *   node tools/gen-dark-css.js --write <file>   # 写入文件
 *   node tools/gen-dark-css.js --uncovered      # 列出没被规则覆盖的选择器
 */

const fs = require('fs');
const path = require('path');

const ASAR = process.env.NOGLASS_ASAR || '<local-path>';
const args = process.argv.slice(2);
const WRITE = args.includes('--write') ? args[args.indexOf('--write') + 1] : null;
const UNCOVERED = args.includes('--uncovered');

// ── 读 asar ──
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

function parseColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
const lum = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;

/**
 * 是不是"品牌色"——这些要保留，不能压成灰白。
 * 判据：色相偏青绿（g 和 b 都明显高于 r），这是本应用的主题色系
 * （#11abac / #008d8e / #007c7d / #016d6e 都落在这里）。
 */
function isBrandish(c) {
  if (!c) return false;
  return c.g > 90 && c.b > 90 && (c.g - c.r) > 30 && (c.b - c.r) > 20;
}

// ── 收集规则 ──
const files = listFiles().filter((f) =>
  /\.css$/i.test(f.path) && !f.unpacked && !f.path.includes('node_modules') && f.size > 200);

const lightBgSels = new Set();
const darkTextSels = new Set();
const allColorSels = new Set();

for (const f of files) {
  const css = read(f);
  if (!css) continue;
  const re = /([^{}]{1,400})\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (!sel || sel.startsWith('@') || sel.length > 300) continue;

    const bgM = body.match(/background(?:-color)?\s*:\s*([^;!}]+)/i);
    const fgM = body.match(/(?:^|;)\s*color\s*:\s*([^;!}]+)/i);
    if (!bgM && !fgM) continue;
    allColorSels.add(sel);

    if (bgM) {
      const c = parseColor(bgM[1].trim());
      if (c && c.a > 0.4 && lum(c) > 190) lightBgSels.add(sel);
    }
    if (fgM) {
      const c = parseColor(fgM[1].trim());
      if (c && c.a > 0.4 && lum(c) < 110 && !isBrandish(c)) darkTextSels.add(sel);
    }
  }
}
fs.closeSync(fd);

// ── 追加：运行时采集到的类名 ──
//
// 为什么需要这一步（重要）：
//   只从 CSS 文件提取有一个盲区 —— **Vue 运行时注入的 scoped 样式**。
//   实测：悬浮番茄钟的 `.tomato[data-v-45545968] { background:#fff }`
//   不在任何 .css 文件里，是组件挂载时动态插 <style> 的。
//   只扫文件必然漏掉它（实测漏了一个 4750px² 的白块）。
//
// 采集方式：tools/harvest-selectors.js 在运行中的应用上读计算样式，
// 输出类名清单，存到 tools/harvested-selectors.json。
const HARVEST = path.join(__dirname, 'harvested-selectors.json');
let harvested = { lightBg: [], darkText: [] };
if (fs.existsSync(HARVEST)) {
  try {
    harvested = JSON.parse(fs.readFileSync(HARVEST, 'utf8'));
  } catch (e) {
    console.error(`警告：${HARVEST} 解析失败 — ${e.message}`);
  }
}
const extraBg = new Set(harvested.lightBg || []);
const extraFg = new Set(harvested.darkText || []);

// ── 把选择器归组：去掉 [data-v-xxx] 与 :hover 等伪类，取"基名" ──
function baseName(sel) {
  return sel
    .split(',')[0]                                  // 多选择器取第一个
    .replace(/\[data-v-[0-9a-f]+\]/g, '')           // 去 scoped 属性
    .replace(/::?[a-z-]+(\([^)]*\))?/gi, '')        // 去伪类/伪元素
    .replace(/\s*>\s*/g, ' > ')                     // 规范化
    .trim();
}

const groups = new Map();   // 基名 -> { bg: bool, fg: bool }
function addGroup(sel, kind) {
  const b = baseName(sel);
  if (!b) return;
  if (!groups.has(b)) groups.set(b, { bg: false, fg: false });
  groups.get(b)[kind] = true;
}
for (const s of lightBgSels) addGroup(s, 'bg');
for (const s of darkTextSels) addGroup(s, 'fg');

// 过滤掉太泛的（比如 html/body/*，我们已手工处理）
const SKIP = new Set(['html', 'body', '*', '#app', 'html > body']);
const items = [...groups.entries()].filter(([k]) => !SKIP.has(k) && k.length < 160);

if (UNCOVERED) {
  console.log('=== 需要覆盖的基名（按类型）===');
  console.log();
  const bgOnly = items.filter(([, v]) => v.bg && !v.fg).map(([k]) => k).sort();
  const fgOnly = items.filter(([, v]) => v.fg && !v.bg).map(([k]) => k).sort();
  const both = items.filter(([, v]) => v.bg && v.fg).map(([k]) => k).sort();
  console.log(`-- 仅浅色背景 (${bgOnly.length}) --`);
  bgOnly.forEach((s) => console.log('  ' + s));
  console.log();
  console.log(`-- 仅深色文字 (${fgOnly.length}) --`);
  fgOnly.forEach((s) => console.log('  ' + s));
  console.log();
  console.log(`-- 两者都有 (${both.length}) --`);
  both.forEach((s) => console.log('  ' + s));
  process.exit(0);
}

// ── 生成 CSS ──
//
// 策略：**前缀聚合**。
// 1898 个选择器逐条列举太长且脆弱（应用升级就变）。观察它们的命名规律：
//   .todo-* / .sidebar-* / .base-layout__* / .el-* / .fc-* / .mx-* / .modal-* …
// 所以提取"前缀"（第一个类名的前两段），按前缀生成通配规则。
// 这样既短又抗改名（同前缀的新组件自动被覆盖）。
//
// 但通配会过度命中（例如把品牌色的按钮也压灰），
// 所以生成两段：先通配压平，再把该保留的还原回来（见文末"还原"段）。

/** 取一个选择器的"类名前缀"，如 .todo-list-item__min[data-v-x] -> todo-list */
function prefixOf(sel) {
  const b = baseName(sel);
  // 取第一个类名
  const m = b.match(/\.([a-zA-Z][\w-]*)/);
  if (!m) return null;
  const cls = m[1];
  // 按 BEM 分隔切：todo-list-item__min -> [todo, list, item]
  const segs = cls.split(/__|--|-/).filter(Boolean);
  if (!segs.length) return null;
  // 注意：返回**不带点**的类名前缀 —— [class*="..."] 匹配的是 class 属性
  // 的字面内容，属性里没有点号。带点会永远匹配不到（早期版本的 bug）。
  //
  // 单段类名（如 .tomato / .tag / .card）也要收 ——
  // 早期版本跳过它们，结果漏掉了悬浮番茄钟的 .tomato（实测是个 4750px² 白块）。
  // 单段虽然泛，但配合"还原段"可以接受；漏掉则是硬伤。
  return segs.join('-');
}

const bgPrefixes = new Map();   // prefix -> count
const fgPrefixes = new Map();
for (const s of lightBgSels) {
  const p = prefixOf(s);
  if (p) bgPrefixes.set(p, (bgPrefixes.get(p) || 0) + 1);
}
for (const s of darkTextSels) {
  const p = prefixOf(s);
  if (p) fgPrefixes.set(p, (fgPrefixes.get(p) || 0) + 1);
}

// 只保留出现 >= 2 次的前缀（一次性的零散类名交给长尾清单）
const bgList = [...bgPrefixes.entries()].filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1]).map(([p]) => p);
const fgList = [...fgPrefixes.entries()].filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1]).map(([p]) => p);

// 运行时采集的类名直接并入。
//
// 注意：这里用**精确类选择器**（.tomato），不是前缀通配（[class*="tomato"]）。
// 因为采集到的就是确切的类名，用通配会过度命中 ——
// 例如采集到 "tip" 时，[class*="tip"] 会连 tooltip / multiselect__tip 一起压掉。
const bgExact = [...extraBg].sort();
const fgExact = [...extraFg].sort();

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const L = [];
L.push('/* ==========================================================================');
L.push('   自动生成：深色覆盖（基于应用源码的类名前缀）');
L.push('   --------------------------------------------------------------------------');
L.push(`   来源：${ASAR}`);
L.push(`   浅色背景规则 ${lightBgSels.size} 条 → ${bgList.length} 个前缀`);
L.push(`   深色文字规则 ${darkTextSels.size} 条 → ${fgList.length} 个前缀`);
L.push('   ');
L.push('   生成方式：tools/gen-dark-css.js');
L.push('   重新生成：node tools/gen-dark-css.js --write <此文件>');
L.push('   ========================================================================== */');
L.push('');

L.push('/* ── 浅色背景 → 压深 ──────────────────────────────────────────────── */');
L.push('/* 用 [class*="前缀"] 匹配，前缀新增的子组件自动覆盖 */');
for (const c of chunk(bgList, 6)) {
  L.push(c.map((p) => `[class*="${p}"]`).join(',\n') + ' {');
  L.push('  background-color: var(--t-bg-soft) !important;');
  L.push('}');
  L.push('');
}

L.push('/* ── 深色文字 → 提亮（品牌色已排除）──────────────────────────────── */');
for (const c of chunk(fgList, 6)) {
  L.push(c.map((p) => `[class*="${p}"]`).join(',\n') + ' {');
  L.push('  color: var(--t-text) !important;');
  L.push('}');
  L.push('');
}

// ── 运行时采集到的（精确选择器）──
if (bgExact.length || fgExact.length) {
  L.push('/* ── 运行时采集到的类名（精确匹配）──────────────────────────────');
  L.push('   来源：tools/harvest-selectors.js 在运行中的应用上读计算样式。');
  L.push('   必要性：Vue 运行时注入的 scoped 样式不在任何 .css 文件里，');
  L.push('   只扫文件会漏（实测漏过悬浮番茄钟的 .tomato 白块）。');
  L.push('   ────────────────────────────────────────────────────────────── */');
  if (bgExact.length) {
    L.push(bgExact.map((c) => `.${c}`).join(',\n') + ' {');
    L.push('  background-color: var(--t-bg-soft) !important;');
    L.push('}');
    L.push('');
  }
  if (fgExact.length) {
    L.push(fgExact.map((c) => `.${c}`).join(',\n') + ' {');
    L.push('  color: var(--t-text) !important;');
    L.push('}');
    L.push('');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 还原段：把通配误伤的强调色还回来
// ──────────────────────────────────────────────────────────────────────
// [class*="el-button"] 这类通配会把**主按钮**也压成灰底，
// 但主按钮应该是品牌色。所以通配之后必须把该保留的还原。
// 顺序很重要：同特异性下，后出现的规则胜出。
L.push('/* ══════════════════════════════════════════════════════════════════');
L.push('   还原段：通配会误伤这些强调色，必须放在最后');
L.push('   ══════════════════════════════════════════════════════════════════ */');
L.push('');
L.push('/* 主按钮 / 激活态 / 链接：保持品牌色 */');
L.push('.el-button--primary,');
L.push('.el-button--primary:hover,');
L.push('.fc-button-primary:not(:disabled).fc-button-active,');
L.push('.todo-tag__item:active,');
L.push('.todo-date-segment.is-active {');
L.push('  background-color: var(--t-brand) !important;');
L.push('  border-color: var(--t-brand) !important;');
L.push('  color: #fff !important;');
L.push('}');
L.push('');
L.push('/* 品牌色文字：品牌色文字（#008d8e 系）不在覆盖清单里，');
L.push('   但被 [class*=...] 通配波及的元素要还原 */');
L.push('.el-button--text,');
L.push('.title--tag,');
L.push('.todo-tag__item,');
L.push('.sidebar-nav-item--active,');
L.push('.el-pager li.active,');
L.push('.todo-category__item,');
L.push('.mx-time-column .mx-time-item.active,');
L.push('.mx-time-option.active {');
L.push('  color: var(--t-brand) !important;');
L.push('}');
L.push('');
L.push('/* 分类色：应用用内联 --category-color 设色，读回来保留 */');
L.push('.todo-category__item {');
L.push('  color: var(--category-color, var(--t-text-2)) !important;');
L.push('}');
L.push('');
L.push('/* 完成态：变暗 + 删除线 */');
L.push('.title--del,');
L.push('.todo-list-item--done .title {');
L.push('  color: var(--t-text-3) !important;');
L.push('  text-decoration: line-through;');
L.push('}');
L.push('');
L.push('/* 搜索高亮：改成暖色，深色下才看得清 */');
L.push('.search-highlight {');
L.push('  background-color: #4a3a12 !important;');
L.push('  color: #ffd666 !important;');
L.push('}');
L.push('');
L.push('/* 输入框保持"凹陷"色，不要跟面板同色 */');
L.push('.el-input__inner,');
L.push('.el-textarea__inner,');
L.push('.mx-input,');
L.push('.todo-input-add__input {');
L.push('  background-color: var(--t-bg-inset) !important;');
L.push('  border-color: var(--t-line) !important;');
L.push('  color: var(--t-text) !important;');
L.push('}');
L.push('');
L.push('/* 番茄钟计时数字用品牌色 */');
L.push('.tomato-timer__time,');
L.push('.tomato__time {');
L.push('  color: var(--t-brand) !important;');
L.push('}');
L.push('');

const out = L.join('\n');

if (WRITE) {
  fs.writeFileSync(WRITE, out, 'utf8');
  console.log(`已写入 ${WRITE}`);
  console.log(`  ${out.length} 字节，${out.split('\n').length} 行`);
  console.log(`  浅色背景选择器: ${bgList.length}`);
  console.log(`  深色文字选择器: ${fgList.length}`);
} else {
  console.log(out);
}
