'use strict';
/**
 * 按本机清单批量重建 profile（覆盖同名文件）。
 * 用法：node tools/make-profiles.js
 *
 * ⚠️ 应用清单在 `local/profiles-config.js`（**不进版本库**）——
 * 因为里面的 exe 是本机绝对路径，不该随仓库走。
 *
 * 通用的建 profile 方式是 `node gen.js new <name> --exe <path>`；
 * 这个脚本只是本机的批量重建快捷方式：清单里一次写好多个应用的
 * 人工字段（端口、隔离变量、注意事项），改完一键重建。
 *
 * 想用它：照着下面 CONFIG 的形状建 `local/profiles-config.js`，
 * 导出一个 APPS 数组即可（模板见 profiles/_template.json 的字段说明）。
 *
 * 为什么要有这个脚本：profile 里的 exe 是 Windows 绝对路径，
 * 在 bash 里用 \\\\ 转义极易被折叠成错路径。交给 Node 处理就没这问题。
 * 探测结果也是现算的，不依赖中间文件。
 */

const fs = require('fs');
const path = require('path');
const probe = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'local', 'profiles-config.js');

if (!fs.existsSync(CONFIG)) {
  console.error(`✗ 找不到本机应用清单：${CONFIG}`);
  console.error('  这个脚本需要一份本机清单（含 exe 绝对路径，不进版本库）。');
  console.error('  单个应用请用：node gen.js new <name> --exe "<path>"');
  process.exit(2);
}

const APPS = require(CONFIG);

function toDetected(pr) {
  const c = probe.conclusions(pr);
  const d = {
    probedAt: new Date().toISOString().slice(0, 10),
    electron: pr.electron || null,
    fuses: pr.fuses
      ? { version: pr.fuses.version, count: pr.fuses.count, table: pr.fuses.table, hardened: pr.fuses.hardened }
      : null,
    canUseNative: c.canUseNative,
    windowLayerGlass: c.windowLayerGlass,
    windowLayerReasons: c.windowLayerReasons,
    hasPageGlass: c.hasPageGlass,
    singleInstance: c.singleInstance,
    userDataOverride: c.userDataOverride,
  };
  if (pr.deep && pr.deep.markers) {
    d.markers = pr.deep.markers;
    d.asarScanned = pr.deep.asarName || null;
  }
  return d;
}

let ok = 0, fail = 0;
for (const app of APPS) {
  if (!fs.existsSync(app.exe)) {
    console.error(`✗ ${app.name}: exe 不存在 ${app.exe}`);
    fail++;
    continue;
  }
  const pr = probe.probeExe(app.exe, { deep: true });
  if (!pr.ok) { console.error(`✗ ${app.name}: ${pr.error}`); fail++; continue; }

  const prof = {
    name: app.name,
    displayName: app.displayName,
    exe: app.exe,
    exeGlob: null,
    processName: app.processName,
    styleId: `__noglass_${app.name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
    defaultPort: app.defaultPort,
    reservedPorts: app.reservedPorts,
    singleInstance: pr.deep && pr.deep.markers ? pr.deep.markers.singleInstanceLock === true : null,
    isolateEnv: app.isolateEnv,
    dataDirEnv: app.dataDirEnv,
    urlFilter: app.urlFilter,
    css: null,
    native: app.native,
    notes: app.notes,
    detected: toDetected(pr),
  };

  const out = path.join(ROOT, 'profiles', `${app.name}.json`);
  fs.writeFileSync(out, JSON.stringify(prof, null, 2) + '\n', 'utf8');
  const d = prof.detected;
  console.log(
    `✓ ${app.name.padEnd(10)} electron=${d.electron}  fuses=${d.fuses ? d.fuses.count : '?'}  ` +
      `native=${d.canUseNative}  pageGlass=${d.hasPageGlass}  winGlass=${d.windowLayerGlass}  ` +
      `single=${d.singleInstance}  asar=${d.asarScanned || '-'}`
  );
  ok++;
}
console.log(`\n生成 ${ok} 个，失败 ${fail} 个`);
process.exit(fail ? 1 : 0);
