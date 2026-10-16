'use strict';
/*
 * assess-portability.js —— 评估一个 Electron 应用"迁到 Rust + WebView"的可行度
 *
 * 核心问题：前端代码能不能原样搬走？
 *   Tauri 的 webview 里没有 Node.js、没有 Electron 模块。
 *   所以前端只要直接用了 Node/Electron API，那部分就必须重写。
 *
 * 这个脚本统计前端的"耦合点"，据此估算可移植比例。
 * 只读。
 *
 * 用法：node tools/assess-portability.js [asar路径]
 */
const fs = require('fs');
const { resolveAsar } = require('./local-paths');

const ASAR = resolveAsar(process.argv[2]);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(ASAR)) {
  die(`找不到文件：${ASAR}\n  用法：node tools/assess-portability.js <app.asar 路径>`);
}
if (fs.statSync(ASAR).isDirectory()) {
  die(`${ASAR} 是目录，不是 asar 文件。\n  正确路径形如：<应用目录>/resources/app.asar`);
}

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

// asar 头：pickle 格式，第 4/8 字节是类型与长度，第 12 字节起是 JSON 表长度。
// 拿普通文件（或空文件）喂进来时这里会是垃圾值 —— 检查一下，
// 免得后面 Buffer.alloc 收到负数抛一堆看不懂的栈。
const jsonLen = head.readUInt32LE(12);
if (!Number.isInteger(jsonLen) || jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) {
  die(`${ASAR} 不是有效的 asar 文件（头部 JSON 长度 = ${jsonLen}）。\n  正确路径形如：<应用目录>/resources/app.asar`);
}
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
let tree;
try {
  tree = JSON.parse(jb.toString('utf8'));
} catch (e) {
  die(`${ASAR} 不是有效的 asar 文件（头部不是 JSON）：${e.message}`);
}
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

const all = listFiles();
console.log(`asar: ${ASAR}`);
console.log(`文件总数: ${all.length}`);
console.log();

// ── 1. 分类：前端代码 vs 主进程代码 vs 依赖 ──
const isNodeModules = (p) => p.startsWith('node_modules/');

// 前端 bundle 的发现：解析 HTML 里的 <script src> / <link href>。
//
// 实测过两种引用写法，都要认：
//   app://./js/chunk.js        Todo清单（自定义协议 + 绝对路径）
//   ./assets/index-xxx.js      AgentHub（Vite 默认的相对路径）
// 只认第一种会漏掉整个前端，然后"0 处阻碍"看起来像好消息，其实是没扫到 ——
// 这种假阴性比漏报更危险，所以宁可按多种形式都试一遍。
function resolveRef(raw, htmlPath) {
  let p = raw.trim();
  if (!p) return null;
  if (/^(https?:|data:|blob:|mailto:|#)/i.test(p)) return null;
  p = p.replace(/^app:\/\/\.?\/?/, '');       // app://./xxx 或 app://xxx
  p = p.replace(/^file:\/\/\/?/i, '');
  p = p.replace(/^\/+/, '');                  // 站点绝对路径 → 当作 asar 根
  if (p.startsWith('.')) {
    // 相对路径：按 HTML 所在目录解析（Vite 产物全在 dist/ 下）
    let dir = htmlPath.includes('/') ? htmlPath.slice(0, htmlPath.lastIndexOf('/')) : '';
    while (p.startsWith('../')) {
      p = p.slice(3);
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    p = p.replace(/^\.\//, '');
    p = dir ? `${dir}/${p}` : p;
  }
  return p.split('?')[0].split('#')[0] || null;
}

const htmlEntries = all.filter((f) => /\.html$/i.test(f.path) && !isNodeModules(f.path));
const refs = new Set();
for (const h of htmlEntries) {
  const html = read(h);
  if (!html) continue;
  const ATTR_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = ATTR_RE.exec(html)) !== null) {
    const r = resolveRef(m[1], h.path);
    if (r) refs.add(r);
  }
}

const frontendFiles = all.filter((f) => refs.has(f.path));
let frontendBytes = 0, frontendCode = 0;
for (const f of frontendFiles) {
  if (/\.(js|css)$/i.test(f.path)) {
    frontendBytes += f.size;
    if (/\.js$/i.test(f.path)) frontendCode += f.size;
  }
}

const mainFiles = all.filter((f) =>
  !isNodeModules(f.path) && /\.(js|cjs|mjs)$/i.test(f.path) && !refs.has(f.path));
let mainBytes = mainFiles.reduce((a, f) => a + f.size, 0);

let depBytes = 0, depCount = 0;
for (const f of all) if (isNodeModules(f.path)) { depBytes += f.size; depCount++; }

console.log('=== 代码构成 ===');
console.log(`  HTML 入口: ${htmlEntries.length ? htmlEntries.map((h) => h.path).join(', ') : '(无)'}`);
console.log(`  被 HTML 直接引用的资源: ${refs.size} 个`);
console.log();
console.log(`  前端 bundle`);
console.log(`      文件 ${frontendFiles.length} 个，JS ${(frontendCode / 1024 / 1024).toFixed(1)} MB`);
console.log(`  主进程代码（非 node_modules、非前端引用）`);
console.log(`      文件 ${mainFiles.length} 个，${(mainBytes / 1024 / 1024).toFixed(1)} MB`);
for (const f of mainFiles.slice(0, 6)) {
  console.log(`        ${(f.size / 1024).toFixed(0).padStart(7)} KB  ${f.path}`);
}
console.log(`  第三方依赖（node_modules）`);
console.log(`      文件 ${depCount} 个，${(depBytes / 1024 / 1024).toFixed(1)} MB`);
console.log();

// 没找到前端时，后面所有"✓ 无"都是噪音 —— 会让人误以为迁移很轻松。
// 明确标出这是"没扫到"而不是"没有耦合"。
const FRONTEND_MISSING = frontendFiles.filter((f) => /\.js$/i.test(f.path)).length === 0;
if (FRONTEND_MISSING) {
  console.log('  ⚠️ 没找到前端 bundle —— 下面的"耦合点"统计**不成立**。');
  console.log('     可能原因：前端不在 asar 里（外置目录）、HTML 在子目录且引用方式不常见、');
  console.log('     或是用了 file:// 之外的加载方式。此时请手工确认前端位置，别采信下面的 ✓ 无。');
  console.log();
}

// ── 2. 前端耦合点扫描 ──
console.log('=== 前端对 Node/Electron 的耦合点（决定可移植性）===');
console.log();

// preload 把桥挂在 window 上的名字 —— 每个应用都不一样，
// 硬编码 window.electron 会漏报（AgentHub 叫 window.agenthub）。
//
// 两个来源，优先级从高到低：
//   1. preload 脚本里的 contextBridge.exposeInMainWorld('name', ...) —— 权威
//   2. 前端自己引用的 window.<xxx>API / window.<xxx>Bridge 之类的名字 —— 兜底
//      （Todo清单 的桥是运行时由 asar 外的逻辑挂上的，第 1 条读不到，
//        只能靠这条：实测 window.electronStoreAPI 13 处）
const exposedNames = new Set();
const BRIDGE_NAME_RE = /exposeInMainWorld\s*\(\s*["'`]([^"'`]+)["'`]/g;
let bridgeFromPreload = false;
for (const f of mainFiles) {
  if (!/preload/i.test(f.path)) continue;
  const js = read(f);
  if (!js) continue;
  let bm;
  while ((bm = BRIDGE_NAME_RE.exec(js)) !== null) { exposedNames.add(bm[1]); bridgeFromPreload = true; }
}

// 兜底：从前端里找"看起来像桥"的 window 属性
if (!bridgeFromPreload) {
  const CANDIDATE_RE = /window\s*\.\s*([A-Za-z_$][\w$]*(?:API|Bridge|Client|SDK|Electron|ipc)[\w$]*)/g;
  const seen = new Map();
  for (const f of frontendFiles) {
    if (!/\.js$/i.test(f.path)) continue;
    const js = read(f);
    if (!js) continue;
    let cm;
    while ((cm = CANDIDATE_RE.exec(js)) !== null) {
      const nm = cm[1];
      // 标准 Web API 不算桥
      if (/^(localStorage|sessionStorage|indexedDB|speechSynthesis)$/i.test(nm)) continue;
      seen.set(nm, (seen.get(nm) || 0) + 1);
    }
  }
  // 只保留出现 >= 2 次的：偶发的一次可能只是变量名巧合
  for (const [nm, n] of seen) if (n >= 2) exposedNames.add(nm);
}

const MARKERS = [
  { key: 'ipcRenderer', re: /ipcRenderer/g, why: 'IPC 调用 —— 要改成 Tauri 的 invoke' },
  { key: "require('electron')", re: /require\(\s*["']electron["']\s*\)/g, why: '直接依赖 electron 模块 —— 必须重写' },
  { key: 'window.require', re: /window\.require/g, why: 'nodeIntegration 风格的 require' },
  { key: 'process.platform', re: /process\.platform/g, why: '平台判断 —— 需 polyfill 或用 Tauri API' },
  { key: 'process.versions', re: /process\.versions/g, why: '版本判断 —— 需 polyfill' },
  { key: 'node:fs / fs', re: /\brequire\(\s*["'](?:node:)?fs["']\s*\)/g, why: '文件系统 —— 要改成 Rust 侧的 command' },
  { key: 'node:path', re: /\brequire\(\s*["'](?:node:)?path["']\s*\)/g, why: '路径处理 —— 需 polyfill' },
  { key: 'child_process', re: /child_process/g, why: '子进程 —— 要改成 Rust 侧' },
  { key: '__dirname', re: /__dirname/g, why: 'Node 专有变量' },
  { key: 'electron-store', re: /electron-store/g, why: '配置存储 —— 要换实现' },
];

// 桥的调用点单独统计：名字是从 preload 读出来的，可能一个都没有
// （前端完全没走桥 = 迁移最省事的情况）。
for (const nm of exposedNames) {
  const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  MARKERS.push({
    key: `window.${nm}`,
    re: new RegExp(`window\\s*\\.\\s*${esc}\\b|window\\s*\\[\\s*["'\`]${esc}["'\`]\\s*\\]`, 'g'),
    why: 'preload 暴露的桥 —— 要换成 Tauri 的 invoke',
  });
}
// 桥名未知时的兜底（老写法）
if (!exposedNames.size) {
  MARKERS.push({ key: 'window.electron', re: /window\.electron|window\.api\b/g, why: 'preload 暴露的桥' });
}
// 这些是"纯 Web 代码"的标志，越多越好
const OK_MARKERS = [
  { key: 'vue/react', re: /\bVue\b|\breact\b/gi, why: '框架代码 —— 可直接复用' },
  { key: 'fetch', re: /\bfetch\s*\(/g, why: '网络请求 —— 标准 Web API，可直接用' },
  { key: 'localStorage', re: /localStorage/g, why: '标准 Web API，可直接用' },
  // 应用自己写了"没有 electron 时怎么办"的分支 —— 这是最强的可移植信号：
  // 作者已经抽象过一层，前端本来就能在纯浏览器里跑。
  { key: '浏览器降级分支', re: /typeof\s+window\s*[<!=]|"浏览器预览"|浏览器预览下未实现/g, why: '已具备脱离 Electron 运行的能力' },
];
for (const m of OK_MARKERS) MARKERS.push({ key: `[ok] ${m.key}`, re: m.re, why: m.why });

const counts = {};
const channels = new Set();          // ipcRenderer 用到的频道名（去重）
// 压缩后的 bundle 两种写法都有：
//   ipcRenderer.invoke('chan')
//   s["ipcRenderer"].invoke("chan")      ← 实测主流（webpack 导出对象取属性）
//   s["ipcRenderer"]["invoke"]("chan")
const CHANNEL_RE = /ipcRenderer["']?\]?\s*\.?\s*\[?\s*["']?(?:invoke|send|sendSync|on|once|removeListener|removeAllListeners)["']?\]?\s*\(\s*["'`]([^"'`]+)["'`]/g;

for (const f of frontendFiles) {
  if (!/\.js$/i.test(f.path)) continue;
  const js = read(f);
  if (!js) continue;
  for (const m of MARKERS) {
    const n = (js.match(m.re) || []).length;
    if (n) counts[m.key] = (counts[m.key] || 0) + n;
  }
  let cm;
  while ((cm = CHANNEL_RE.exec(js)) !== null) {
    // REMOTE_BROWSER_* 是 Electron 自己 remote 模块的内部频道，不是应用的
    if (!cm[1].startsWith('REMOTE_BROWSER_')) channels.add(cm[1]);
  }
}

// ── 架构判定：单入口分发器 vs 每频道一个方法 ──
//
// 实测两种，迁移成本差一个量级：
//   Todo清单  s["ipcRenderer"].invoke("todo-db:call", {method, args})
//             前端直连 154 个频道，每个都得单独接
//   AgentHub  window.agenthub.invoke(cmd, args)  ← preload 只暴露一个 invoke
//             前端所有后端调用走同一个入口，主进程用 switch 分发
//
// 单入口的价值：迁移时前端调用点几乎不用动（桥同名同签名即可），
// 成本集中在"实现一个 dispatcher 的 N 个分支"，而不是散落改 N 个调用点。
// 判据：preload 暴露的方法里有没有一个通用的 invoke/send/call。
let genericBridge = null;
for (const f of mainFiles) {
  if (!/preload/i.test(f.path)) continue;
  const js = read(f);
  if (!js) continue;
  const m = js.match(/\b(invoke|send|call|ipc)\s*:\s*(?:async\s*)?\(/);
  if (m) { genericBridge = m[1]; break; }
}

const bad = MARKERS.filter((m) => !m.key.startsWith('[ok]'));
const good = MARKERS.filter((m) => m.key.startsWith('[ok]'));

if (exposedNames.size) {
  const src = bridgeFromPreload ? 'preload 脚本' : '前端引用（preload 里没读到，可能是运行时挂载）';
  console.log(`  preload 桥名（来源：${src}）: ${[...exposedNames].join(', ')}`);
  console.log();
}

console.log('  ── 阻碍项（用了就必须重写对应部分）──');
let badTotal = 0;
for (const m of bad) {
  const n = counts[m.key] || 0;
  badTotal += n;
  const mark = n === 0 ? '✓ 无' : `${n} 处`;
  console.log(`    ${String(mark).padEnd(10)} ${m.key.padEnd(22)} ${m.why}`);
}

console.log();
console.log('  ── 可复用标志（标准 Web 代码）──');
for (const m of good) {
  const n = counts[m.key] || 0;
  const label = m.key.replace(/^\[ok\]\s*/, '');
  const hint = n && m.key.includes('浏览器降级') ? '  ← 可直接跑在纯浏览器/webview 里' : '';
  console.log(`    ${String(n + ' 处').padEnd(10)} ${label}${hint}`);
}

console.log();
console.log(`  阻碍项总计: ${badTotal} 处`);

// IPC 频道数是**真正的工作量单位**：调用点多但频道少，
// 说明改动集中在少数几个函数里；频道多才是真的散。
if (channels.size) {
  console.log();
  console.log(`  前端直连的 IPC 频道（去重后）: ${channels.size} 个`);
  const list = [...channels].sort();
  console.log(`    ${list.slice(0, 12).join(', ')}${list.length > 12 ? ` … 等 ${list.length} 个` : ''}`);
}

// 主进程注册的频道数 —— 这才是"Rust 侧要写多少个 command"的权威数字。
// 前端引用的会比它多：多出来的那部分是主进程主动 push 的
// （webContents.send），不需要 Rust 侧提供入口。
const HANDLER_RE = /ipcMain\s*\.\s*(?:handle|handleOnce|on|once)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const handlers = new Set();
let dynamicHandlers = 0;
for (const f of mainFiles) {
  const js = read(f);
  if (!js) continue;
  let hm;
  while ((hm = HANDLER_RE.exec(js)) !== null) handlers.add(hm[1]);
  dynamicHandlers += (js.match(/ipcMain\s*\.\s*(?:handle|on)\s*\(\s*`/g) || []).length;
}
console.log();
console.log(`  主进程注册的处理频道: ${handlers.size} 个 —— Rust 侧约需这么多 #[tauri::command]`);
if (dynamicHandlers) {
  console.log(`    ⚠ 另有 ${dynamicHandlers} 处频道名是模板字符串动态拼的，无法静态数清，实际会更多`);
}

// ── IPC 架构：这个结论直接影响"前端要不要改"──
console.log();
console.log('=== IPC 架构（决定前端改动量）===');
if (genericBridge) {
  console.log(`  ✅ 单入口分发：preload 只暴露一个 \`${genericBridge}(cmd, args)\``);
  console.log(`     前端所有后端调用都经它转发，调用点**不用逐个改** ——`);
  console.log(`     在 Rust 侧实现一个同名 dispatcher，把 ${handlers.size} 个命令名分派下去即可。`);
  console.log(`     代价：dispatcher 是个大 switch，命令实现仍是 ${handlers.size} 份工作。`);
} else if (handlers.size || channels.size) {
  console.log('  ⚠️ 分散式：每个功能一个频道/桥方法，前端逐个直连。');
  console.log(`     迁移时前端 ${channels.size || handlers.size} 个调用点要逐个换成 invoke，`);
  console.log('     但换来的是类型清晰、不用维护大分发器。');
} else {
  console.log('  （未检测到 IPC —— 前端可能完全不需要后端通道）');
}

// ── 3. 主进程依赖的原生模块（Rust 侧要重写）──
console.log();
console.log('=== 主进程用到的关键依赖（Rust 侧都需要对应实现）===');
// 每项：[匹配名, 说明]。匹配用"包名相同或以 `匹配名-` 开头" ——
// 因为生态里到处是变体：better-sqlite3-multiple-ciphers / node-pty-prebuilt-multiarch。
// 只做精确匹配会漏报（实测漏掉过 better-sqlite3-multiple-ciphers）。
const NATIVE = [
  ['better-sqlite3', 'SQLite 数据库 —— Rust 有 rusqlite'],
  ['sqlite3', 'SQLite —— Rust 有 rusqlite'],
  ['electron-updater', '自动更新 —— Tauri 有自己的 updater'],
  ['electron-store', '配置持久化 —— 可换成 Rust 侧实现'],
  ['sharp', '图像处理 —— Rust 有 image crate'],
  ['node-pty', '伪终端 —— Rust 有 portable-pty'],
  ['keytar', '系统凭据 —— Rust 有 keyring'],
  ['node-machine-id', '设备指纹'],
  ['auto-launch', '开机自启 —— Tauri 有 plugin-autostart'],
  ['tesseract', 'OCR'],
  ['ffmpeg', '音视频'],
  ['bcrypt', '加密'],
  ['ws', 'WebSocket —— Rust 有 tokio-tungstenite'],
  ['express', 'HTTP 服务 —— Rust 有 axum/actix'],
];

const depNames = new Set();
for (const f of all) {
  const m = f.path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) depNames.add(m[1]);
}

// `ws` 这种短名用前缀匹配会误伤（`wsl`、`wsdl`…），所以按名长分策略：
// 精确匹配，或名长 >= 6 时允许 `name-xxx` 变体。
function matchDep(dep, pat) {
  if (dep === pat) return true;
  return pat.length >= 6 && dep.startsWith(pat + '-');
}

let nativeHits = 0;
const nativeFound = [];
for (const [name, note] of NATIVE) {
  const hit = [...depNames].filter((d) => matchDep(d, name));
  if (hit.length) {
    console.log(`  ✓ ${hit.join(', ').padEnd(34)} ${note}`);
    nativeHits++;
    nativeFound.push(...hit);
  }
}
console.log();
console.log(`  node_modules 顶层包总数: ${depNames.size}`);
console.log(`  其中需要 Rust 侧对应实现的: ${nativeHits} 个（上表）`);
if (nativeFound.length) {
  console.log(`  ↑ 命中包名：${nativeFound.join(', ')}`);
}

fs.closeSync(fd);
