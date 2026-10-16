'use strict';
/*
 * local-paths.js —— 解析本机路径，同时让仓库里不含任何本机路径
 *
 * 背景：这批工具需要一个 asar 路径才能工作。但如果把路径写死在源码里，
 * 它就会随仓库一起被带走（含用户名、目录结构的绝对路径不该公开）。
 *
 * 解析顺序：
 *   1. 命令行参数（各工具自己传进来）
 *   2. 环境变量 NOGLASS_ASAR
 *   3. local/tools-config.json 的 "asar" 字段（本机配置，被 .gitignore 排除）
 *
 * 三者都没有就报错退出，并说明怎么配 —— 不静默失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'local', 'tools-config.json');

/** 读本机配置；不存在或损坏都返回 {}（不抛异常）。 */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

/** 解析 asar 路径。explicit 一般是 process.argv 里那一个。 */
function resolveAsar(explicit) {
  const p = explicit || process.env.NOGLASS_ASAR || readConfig().asar;
  if (!p) {
    console.error('✗ 没有指定 asar 路径。三种给法：');
    console.error('   1) 命令行传参：node tools/<脚本> <app.asar 路径>');
    console.error('   2) 环境变量：  NOGLASS_ASAR=<app.asar 路径>');
    console.error(`   3) 本机配置：  在 ${CONFIG} 里写 { "asar": "<app.asar 路径>" }`);
    process.exit(2);
  }
  return p;
}

module.exports = { resolveAsar, readConfig };
