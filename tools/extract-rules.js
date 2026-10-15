'use strict';
/*
 * 从 asar 里提取指定选择器的完整 CSS 规则，用于精确覆盖。
 * 只读。
 *
 * 用法：node tools/extract-rules.js <选择器关键词> [更多关键词...]
 */
const fs = require('fs');

const ASAR = '<local-path>';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const tree = JSON.parse(jb.toString('utf8'));
const base = 16 + jsonLen;

function readFileInAsar(want) {
  let found = null;
  (function walk(n, pre) {
    for (const k of Object.keys(n.files || {})) {
      const f = n.files[k];
      const q = pre ? pre + '/' + k : k;
      if (f.files) walk(f, q);
      else if (q === want) found = f;
    }
  })(tree, '');
  if (!found) return null;
  const buf = Buffer.alloc(found.size);
  fs.readSync(fd, buf, 0, found.size, base + Number(found.offset));
  return buf.toString('utf8');
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('用法: node tools/extract-rules.js <关键词> [...]');
  process.exit(2);
}

const files = ['css/index.b690735e.css', 'css/chunk-common.00231b0c.css', 'css/widget.2b65319e.css'];
const all = [];
for (const f of files) {
  const css = readFileInAsar(f);
  if (css) all.push({ file: f, css });
}

for (const kw of targets) {
  console.log('='.repeat(74));
  console.log('关键词:', kw);
  console.log('='.repeat(74));
  let shown = 0;
  for (const { file, css } of all) {
    // 抓 "选择器{...}" 里选择器含关键词的
    const re = /([^{}]{1,300})\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css)) !== null && shown < 14) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel.includes(kw)) continue;
      if (sel.length > 200) continue;
      const body = m[2].replace(/\s+/g, ' ').trim();
      if (!body) continue;
      // 只显示含颜色属性的
      if (!/color|background|border/.test(body)) continue;
      console.log(`  [${file.replace('css/', '')}]`);
      console.log(`    ${sel.slice(0, 150)}`);
      console.log(`      { ${body.slice(0, 230)} }`);
      shown++;
    }
  }
  if (!shown) console.log('  （无匹配）');
  console.log();
}
fs.closeSync(fd);
