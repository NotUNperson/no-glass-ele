'use strict';
/**
 * 生成三个示例 profile。
 * 用法：node tools/make-profiles.js
 *
 * 为什么要有这个脚本：profile 里的 exe 是 Windows 绝对路径，
 * 在 bash 里用 \\\\ 转义极易被折叠成错路径。交给 Node 处理就没这问题。
 * 探测结果也是现算的，不依赖中间文件。
 */

const fs = require('fs');
const path = require('path');
const probe = require('../lib/probe');

const ROOT = path.join(__dirname, '..');

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

const APPS = [
  {
    name: 'zcode-ce',
    displayName: 'ZCode-CE',
    exe: '<local-path>',
    processName: 'ZCode-CE',
    defaultPort: 9333,
    reservedPorts: [],
    isolateEnv: { ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: '1' },
    dataDirEnv: 'ZCODE_DATA_BASE_DIR',
    urlFilter: null,
    native: { enabled: false, darkBg: '#161616', lightBg: '#f8f8f8', darkSymbol: '#f5f5f5', lightSymbol: '#1f1f1f' },
    notes: {
      watchRequired: null,
      portConflict: null,
      extra: [
        '**这个应用有窗口层玻璃**：主进程建窗时写死 `backgroundMaterial: "acrylic"`，',
        '配合刻意透明的外壳（`html, body, #root { background: 0 0 !important }`）让系统亚克力从底下透上来。',
        'CSS 够不到这一层。',
        '',
        '关闭方式：设置 → 辅助功能 → 视觉效果 → **透明效果**（关闭）。',
        '这一步关掉的是窗口层的系统亚克力，一次对所有应用生效。',
        '',
        '也可以用 `--native` 从主进程调 Electron API 移除（此应用 fuse 未禁用 `--inspect`，可用）。',
      ].join('\n'),
    },
  },
  {
    name: 'agenthub',
    displayName: 'AgentHub',
    exe: '<local-path>',
    processName: 'AgentHub',
    defaultPort: 9401,
    reservedPorts: [9527],
    // 应用自带的开发旁路：跳过单实例锁 + 把数据隔离到 AgentHub-dev
    isolateEnv: { AGENTHUB_ALLOW_MULTI: '1' },
    dataDirEnv: null,
    urlFilter: null,
    native: { enabled: false, darkBg: '#0a0c0f', lightBg: '#f4f6f9', darkSymbol: '#f5f5f5', lightSymbol: '#1f1f1f' },
    notes: {
      watchRequired: [
        '它有关闭窗口即**销毁渲染进程**的轻量模式（源码注释：「只有 destroy() 才会让渲染进程整只消失」）。',
        '窗口被销毁后唤回会重建，不加 `--watch` 时重建的新页面不会被注入。',
      ].join('\n'),
      portConflict: [
        '主进程内置反代网关，默认监听 `127.0.0.1:9527`（托盘常驻期间持续提供 API）。',
        '所以**不能并发跑第二个实例**——第二个实例的网关会与第一个抢 9527。',
        '正确用法是先完整退出 AgentHub，再通过本工具启动。',
        '',
        '例外：应用自带开发旁路 `AGENTHUB_ALLOW_MULTI=1`，会跳过单实例锁并把数据隔离到',
        '`AgentHub-dev` 目录，可在不影响现有实例的前提下测试。本 profile 的 `isolateEnv` 已填此项，',
        '`start-isolated.cmd` 可直接用。',
      ].join('\n'),
      extra: [
        '**这个应用没有窗口层玻璃**：建窗时用的是不透明实色底（深色 `#0a0c0f` / 浅色 `#f4f6f9`），',
        '没有 `transparent` / `vibrancy` / `backgroundMaterial`。所以页面内的 `backdrop-filter` 是唯一一层，',
        '去掉它就是干净删除，**连系统设置的「透明效果」都不需要动**。',
        '',
        '它是玻璃重度使用者：全套 `--glass-*` 变量 + 70 处 `backdrop-filter`',
        '（主面板 `blur(30px)`、卡片/工具栏 `blur(18px)`、右键菜单 `blur(20px)`、表头 `blur(16px)`）。',
        '一条通配规则全部覆盖。',
      ].join('\n'),
    },
  },
  {
    name: 'obsidian',
    displayName: 'Obsidian',
    exe: '<local-path>',
    processName: 'Obsidian',
    defaultPort: 9411,
    reservedPorts: [],
    isolateEnv: null,
    dataDirEnv: null,
    urlFilter: null,
    native: { enabled: false, darkBg: '#1e1e1e', lightBg: '#ffffff', darkSymbol: '#f5f5f5', lightSymbol: '#1f1f1f' },
    notes: {
      watchRequired: null,
      portConflict: null,
      extra: [
        '**这个应用被主动加固过**：`RunAsNode`、`NodeOptions`、`NodeCliInspect` 三个 fuse 全部关闭',
        '（均非 Electron 默认值）。',
        '',
        '影响：`--native` **不可用**（它依赖 `--inspect`，已被 fuse 拦死）。',
        '但**页面注入不受影响**——`--remote-debugging-port` 走 Chromium 调试体系，不在该 fuse 管辖范围内。',
        '已实测：带调试端口启动后注入成功，模糊元素清零。',
        '',
        '窗口层玻璃请去系统设置关：设置 → 辅助功能 → 视觉效果 → 透明效果。',
        '',
        '注意：asar 里出现 `vibrancy` 标记，但那是 macOS 的亚克力 API，在 Windows 上不生效。',
        'Windows 版的实际窗口层由系统设置控制。',
      ].join('\n'),
    },
  },
];

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
