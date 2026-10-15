'use strict';
/*
 * 在 asar 里全局搜关键词（不限 CSS），用于定位运行时动态注入的样式。
 * 只读。
 *
 * 用法：node tools/grep-asar.js <关键词> [--limit N]
 */
const fs = require('fs');

const ASAR = '<local-path>';
const kw = process.argv[2];
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 10;

if (!kw) { console.log('用法: node tools/grep-asar.js <关键词>'); process.exit(2); }

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const tree = JSON.parse(jb.toString('utf8'));
const base = 16 + jsonLen;

const files = [];
(function walk(n, pre) {
  for (const k of Object.keys(n.files || {})) {
    const f = n.files[k];
    const q = pre ? pre + '/' + k : k;
    if (f.files) walk(f, q);
    else files.push({ path: q, size: f.size, offset: Number(f.offset), unpacked: f.unpacked });
  }
})(tree, '');

console.log(`在 ${files.length} 个文件里搜 "${kw}"…`);
console.log();

const needle = Buffer.from(kw, 'utf8');
let hits = 0;
for (const f of files) {
  if (f.unpacked || !f.size || f.size > 40e6) continue;
  let buf;
  try {
    buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, base + f.offset);
  } catch { continue; }
  let i = buf.indexOf(needle);
  if (i === -1) continue;

  console.log('─'.repeat(72));
  console.log('文件:', f.path, `(${(f.size / 1024).toFixed(1)} KB)`);
  // 显示前 3 处上下文
  let n = 0;
  while (i !== -1 && n < 3) {
    const s = Math.max(0, i - 120);
    const e = Math.min(buf.length, i + 200);
    const ctx = buf.subarray(s, e).toString('utf8').replace(/\s+/g, ' ');
    console.log(`  @${i}: …${ctx}…`);
    i = buf.indexOf(needle, i + 1);
    n++;
  }
  hits++;
  if (hits >= LIMIT) { console.log(); console.log(`（已达上限 ${LIMIT}，还有更多）`); break; }
}
if (!hits) console.log('（未找到）');
fs.closeSync(fd);
