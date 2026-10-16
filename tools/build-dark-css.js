'use strict';
/*
 * build-dark-css.js —— 组装最终的深色 CSS 文件
 *
 * 组成：
 *   1. 头部说明 + 变量定义（手工维护）
 *   2. 自动生成的通配覆盖 + 还原段（由 gen-dark-css.js 生成）
 *   3. 手工精修段（结构性覆盖、登录页、浮层、滚动条等）
 *
 * 为什么分成三段而不是一个大文件：
 *   自动生成的部分会随应用升级重新生成，手工部分不该被覆盖。
 *   这个脚本把两者拼起来，源文件各自独立维护。
 *
 * 用法：node tools/build-dark-css.js <profile名>
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const name = process.argv[2] || 'todo-list';

const HEAD = path.join(ROOT, 'local', 'dark', `dark-head-${name}.css`);
const TAIL = path.join(ROOT, 'local', 'dark', `dark-tail-${name}.css`);
const OUT = path.join(ROOT, 'css', `${name}.custom.css`);

// 1) 生成中段
const genTmp = path.join(require('os').tmpdir(), `noglass-gen-${name}.css`);
execFileSync(process.execPath, [path.join(__dirname, 'gen-dark-css.js'), '--write', genTmp], {
  stdio: 'inherit',
});

const parts = [];
for (const [label, p] of [['head', HEAD], ['generated', genTmp], ['tail', TAIL]]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少 ${label} 部分：${p}`);
    if (label !== 'generated') process.exit(1);
    continue;
  }
  parts.push(fs.readFileSync(p, 'utf8').trimEnd());
}

const out = parts.join('\n\n\n') + '\n';
fs.writeFileSync(OUT, out, 'utf8');
console.log();
console.log(`已组装 ${OUT}`);
console.log(`  ${out.length} 字节，${out.split('\n').length} 行`);
console.log(`  来源：head + generated(${fs.statSync(genTmp).size}B) + tail`);
