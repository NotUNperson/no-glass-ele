'use strict';
/*
 * find-ipc-windows.js —— 从主进程里找出"开新窗口"的 IPC 通道
 *
 * 背景：应用的独立窗口（悬浮番茄钟 / 编辑窗口 / 小组件）是按需创建的。
 * 要验证它们能否被注入，得先知道怎么触发。
 * 主进程代码是压缩过的，所以这里用关键词定位 + 上下文提取。
 *
 * 用法：node tools/find-ipc-windows.js
 */
const fs = require('fs');

const ASAR = process.env.NOGLASS_ASAR || '<local-path>';
const MAIN = process.env.NOGLASS_MAIN || 'background.js';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const tree = JSON.parse(jb.toString('utf8'));
const base = 16 + jsonLen;

let entry = null;
(function walk(n, pre) {
  for (const k of Object.keys(n.files || {})) {
    const f = n.files[k];
    const q = pre ? pre + '/' + k : k;
    if (f.files) walk(f, q);
    else if (q === MAIN) entry = f;
  }
})(tree, '');
if (!entry) { console.log('未找到', MAIN); process.exit(1); }

const buf = Buffer.alloc(entry.size);
fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
const js = buf.toString('utf8');
fs.closeSync(fd);

console.log(`${MAIN}: ${(entry.size / 1024).toFixed(1)} KB`);
console.log();

// ── 1. 关键词频次 ──
const KWS = ['BrowserWindow', 'loadURL', 'loadFile', 'widget.html',
  'floating', 'todo-edit-window', 'createWindow', 'ipcMain',
  'ipcMain.handle', 'ipcMain.on', 'new-window', 'openWindow',
  'setWindowOpenHandler', 'webPreferences', 'show:'];

console.log('=== 关键词频次 ===');
for (const kw of KWS) {
  let n = 0, i = 0;
  while ((i = js.indexOf(kw, i)) !== -1) { n++; i += kw.length; }
  console.log(`  ${kw.padEnd(24)} ${n}`);
}

// ── 2. 提取含 widget.html / 路由 hash 的代码片段 ──
function ctx(keyword, before = 260, after = 160, limit = 4) {
  console.log();
  console.log(`=== "${keyword}" 附近的代码 ===`);
  let i = 0, n = 0;
  while ((i = js.indexOf(keyword, i)) !== -1 && n < limit) {
    const s = js.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' ');
    console.log(`  @${i}: …${s}…`);
    console.log();
    i += keyword.length;
    n++;
  }
  if (!n) console.log('  （无）');
}

ctx('widget.html');
ctx('todo-edit-window');
ctx('floating');

// ── 3. 找 ipcMain 的通道名 ──
console.log();
console.log('=== ipcMain 通道名（推断哪些会开窗口）===');
const chanRe = /ipcMain\.(?:handle|on)\(\s*["']([^"']{1,60})["']/g;
let m;
const chans = new Set();
while ((m = chanRe.exec(js)) !== null) chans.add(m[1]);
for (const c of [...chans].sort()) console.log('  ' + c);
console.log();
console.log(`共 ${chans.size} 个通道`);

// ── 4. 找 createWindow 类的函数定义 ──
console.log();
console.log('=== 疑似"创建窗口"的函数 ===');
const fnRe = /function\s+([A-Za-z_$][\w$]{2,40})\s*\([^)]{0,80}\)\s*\{/g;
let fm;
const cands = [];
while ((fm = fnRe.exec(js)) !== null) {
  const name = fm[1];
  if (!/win|window|create|open|show|floating|widget|edit/i.test(name)) continue;
  const bodyStart = fm.index + fm[0].length;
  const body = js.slice(bodyStart, bodyStart + 400);
  if (!/BrowserWindow|loadURL|loadFile/.test(body)) continue;
  cands.push({ name, at: fm.index, body: body.replace(/\s+/g, ' ').slice(0, 200) });
}
for (const c of cands.slice(0, 12)) {
  console.log(`  ${c.name}()  @${c.at}`);
  console.log(`      ${c.body}`);
}
if (!cands.length) console.log('  （压缩后函数名丢失，见上面的代码片段）');
