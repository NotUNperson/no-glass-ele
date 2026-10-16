'use strict';
/*
 * list-routes.js —— 从应用源码里列出所有路由
 *
 * 目的：深色覆盖是按"页面"验证的，所以得先知道**有哪些页面**。
 * 靠手点会漏，直接读源码里的路由定义最全。
 *
 * 用法：node tools/list-routes.js
 */
const fs = require('fs');
const { resolveAsar } = require('./local-paths');

const ASAR = resolveAsar();
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

// 只看应用自己的 js（排除 node_modules）
const files = listFiles().filter((f) =>
  /\.(js|mjs)$/i.test(f.path) && !f.unpacked && !f.path.includes('node_modules') && f.size > 1000);

console.log(`扫 ${files.length} 个 js 文件…`);
console.log();

const routes = new Map();      // path -> { file, component }
const lazyImports = new Set();
let iframeUse = 0;
let webviewUse = 0;
const iframeSamples = [];

for (const f of files) {
  const js = read(f);
  if (!js) continue;

  // 1) 路由 path: "xxx"  或 path:'xxx'
  const rePath = /path\s*:\s*["'`]([^"'`]{1,80})["'`]/g;
  let m;
  while ((m = rePath.exec(js)) !== null) {
    const p = m[1];
    if (!p.startsWith('/')) continue;
    if (!routes.has(p)) routes.set(p, { file: f.path.split('/').pop(), component: null });
  }

  // 2) name: "xxx" 紧邻 path 的，用来推断组件名（粗略）
  // 3) 懒加载 import()：webpackChunkName
  const reChunk = /webpackChunkName\s*:\s*["']([^"']+)["']/g;
  while ((m = reChunk.exec(js)) !== null) lazyImports.add(m[1]);

  // 4) iframe / webview 使用
  const nIframe = (js.match(/<iframe|createElement\(["']iframe["']\)|iframe/gi) || []).length;
  const nWebview = (js.match(/<webview|webview/gi) || []).length;
  if (nIframe) {
    iframeUse += nIframe;
    if (iframeSamples.length < 5) iframeSamples.push({ file: f.path.split('/').pop(), n: nIframe });
  }
  if (nWebview) webviewUse += nWebview;
}

console.log('=== 路由（按路径排序）===');
const sorted = [...routes.keys()].sort();
for (const p of sorted) {
  const r = routes.get(p);
  console.log(`  ${p.padEnd(42)} [${r.file}]`);
}
console.log();
console.log(`共 ${sorted.length} 个路由`);
console.log();

console.log('=== 懒加载 chunk 名（推断页面模块）===');
const chunks = [...lazyImports].sort();
for (const c of chunks) console.log('  ' + c);
console.log();

console.log('=== iframe / webview 使用 ===');
console.log(`  iframe 提及: ${iframeUse} 次`);
for (const s of iframeSamples) console.log(`    ${s.file}: ${s.n} 次`);
console.log(`  webview 提及: ${webviewUse} 次`);
if (webviewUse > 0) {
  console.log('  ⚠ 用了 webview —— 那是独立渲染进程，CSS 注入需要单独覆盖');
}

fs.closeSync(fd);
