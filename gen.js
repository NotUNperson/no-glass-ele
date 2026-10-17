#!/usr/bin/env node
'use strict';
/**
 * gen.js —— no-glass-ele 生成器 CLI
 *
 * 命令：
 *   probe  <exe> [--deep]          只读探测，输出可粘贴的 profile 片段
 *   new    <name> --exe <path>     probe + 模板 → profiles/<name>.json
 *   build  <name>|--all [--bundle] 渲染 apps/<name>/ 下的启动器与 README
 *   list                           列出 profiles 与探测状态
 *   doctor                         校验：exe 存在、端口冲突、fuse 与预设矛盾
 *   env                            环境自检：Node / Python / pywebview / PowerShell
 *
 * 设计约束：
 *   · 只读静态探测，**绝不启动**目标应用。
 *   · **绝不遍历文件系统**。只读被点名的 exe，或 readdirSync 单个目录。
 *   · 零依赖（Node 18+）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const probe = require('./lib/probe');
const render = require('./lib/render');
const sessions = require('./lib/sessions');
const autostart = require('./lib/autostart');

/**
 * 同步睡眠。gen.js 是纯同步 CLI，没有事件循环可等，
 * 所以用 Atomics.wait 而不是 Promise —— 后者在这个上下文里根本不会被调度。
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

const ROOT = __dirname;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const APPS_DIR = path.join(ROOT, 'apps');
const CSS_FILE = path.join(ROOT, 'css', 'no-glass.css');
const INJECTOR = path.join(ROOT, 'injector', 'noglass.js');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' }
  : { dim: '', b: '', g: '', y: '', r: '', c: '', x: '' };

const say = (m = '') => console.log(m);
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const wrn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const dim = (m) => `${C.dim}${m}${C.x}`;

// ─────────────────────────── 参数解析 ───────────────────────────

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { o.flags[key] = next; i++; }
      else o.flags[key] = true;
    } else o._.push(a);
  }
  return o;
}

// ─────────────────────────── profiles IO ───────────────────────────

function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function loadProfile(name) {
  const p = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`profile 不存在: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveProfile(name, obj) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const p = path.join(PROFILES_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * 把一个探测结果折算成 profile 的 detected 块。
 * 这里只放"探测得到的客观事实"，不放任何猜测。
 */
function toDetected(pr) {
  const c = probe.conclusions(pr);
  const d = {
    probedAt: new Date().toISOString().slice(0, 10),
    // 运行时：决定"怎么开调试端口"（Electron 命令行 / Tauri 环境变量）
    runtime: pr.runtime || 'unknown',
    electron: pr.electron || null,
    tauri: pr.tauri || null,
    fuses: pr.fuses
      ? { version: pr.fuses.version, count: pr.fuses.count, table: pr.fuses.table, hardened: pr.fuses.hardened }
      : null,
    canUseNative: c.canUseNative,
    windowLayerGlass: c.windowLayerGlass,
    windowLayerReasons: c.windowLayerReasons,
    hasPageGlass: c.hasPageGlass,
    singleInstance: c.singleInstance,
    userDataOverride: c.userDataOverride,
    // 应用自带深色模式吗（决定要不要 darkreader / emulateColorScheme）
    prefersColorScheme: c.prefersColorScheme === undefined ? null : c.prefersColorScheme,
  };
  if (pr.deep && pr.deep.markers) d.markers = pr.deep.markers;
  // Tauri：前端玻璃证据（分栏，不下结论）
  if (pr.deep && pr.deep.kind === 'tauri') {
    d.frontend = {
      scannedDirs: pr.deep.scannedDirs,
      files: pr.deep.frontendFiles,
      glassCssHits: pr.deep.glass.cssHits,
      glassCssFiles: pr.deep.glass.cssFiles.map((f) => f.file),
      glassJsHits: pr.deep.glass.jsHits,
      glassJsFiles: pr.deep.glass.jsFiles.map((f) => f.file),
    };
  }
  return d;
}

// ─────────────────────────── probe ───────────────────────────

function cmdProbe(args) {
  const exe = args._[0];
  if (!exe) {
    bad('用法: node gen.js probe <exe> [--deep]');
    process.exit(2);
  }
  const abs = path.resolve(exe);
  if (!fs.existsSync(abs)) {
    bad(`exe 不存在: ${abs}`);
    process.exit(2);
  }

  const deep = args.flags.deep === true;
  const asJson = args.flags.json === true;
  if (!asJson) {
    say(`${C.b}探测${C.x} ${abs}`);
    if (deep) say(dim('  （--deep：Electron 扫 asar 找行为标记；Tauri 扫前端资源找玻璃证据）'));
    say();
  }

  const t0 = Date.now();
  const pr = probe.probeExe(abs, { deep });
  const ms = Date.now() - t0;

  if (!pr.ok) {
    if (asJson) { say(JSON.stringify({ ok: false, error: pr.error, exe: abs }, null, 2)); process.exit(1); }
    bad(pr.error); process.exit(1);
  }

  const c = probe.conclusions(pr);

  // 应用**自己**的自启动项（含它的启动参数）。
  // 用途：把 `--hidden` 这类"后台启动"标志建议进 appArgs —— 不补它，
  // 注入器启动时本该静默到托盘的应用会弹窗（用户实际报过这个问题）。
  let appAutostartInfo = [];
  try {
    appAutostartInfo = autostart.findAppAutostart(abs, path.basename(abs, '.exe'));
  } catch { /* 读不到不阻塞探测 */ }

  // JSON 模式：一次给出全部结论，供 UI 使用
  if (asJson) {
    const suggested = {
      name: path.basename(abs, '.exe').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      displayName: path.basename(abs, '.exe'),
      exe: abs,
      processName: path.basename(abs, '.exe'),
    };
    say(JSON.stringify({
      ok: true, exe: abs, elapsedMs: ms,
      runtime: pr.runtime, electron: pr.electron, tauri: pr.tauri, size: pr.size,
      fuses: pr.fuses, conclusions: c, warnings: pr.warnings,
      deep: pr.deep ? {
        asar: pr.deep.asar, asarName: pr.deep.asarName, asarSize: pr.deep.asarSize,
        markers: pr.deep.markers,
        // Tauri：前端玻璃证据（css/js 分栏）
        kind: pr.deep.kind, glass: pr.deep.glass, frontendFiles: pr.deep.frontendFiles,
        scannedDirs: pr.deep.scannedDirs,
      } : null,
      detected: toDetected(pr),
      suggested,
      appAutostart: appAutostartInfo,
    }, null, 2));
    return;
  }

  say(`${C.b}文件${C.x}`);
  if (pr.runtime === 'tauri') {
    say(`  运行时        ${C.g}Tauri${C.x} ${dim('（WebView2 渲染）')}`);
    if (pr.tauri && pr.tauri.version) {
      say(`  Tauri 版本    ${pr.tauri.version}${pr.tauri.wryVersion ? dim(`  (wry ${pr.tauri.wryVersion})`) : ''}`);
    }
  } else if (pr.runtime === 'electron') {
    say(`  运行时        ${C.g}Electron${C.x} ${pr.electron ? dim(pr.electron) : dim('(版本未识别)')}`);
  } else {
    say(`  运行时        ${C.y}未识别${C.x} ${dim('（既没有 Electron fuse，也没有 Tauri 标记）')}`);
  }
  say(`  大小          ${(pr.size / 1024 / 1024).toFixed(1)} MB`);
  say();

  if (pr.fuseNote) {
    say(dim(`  ${pr.fuseNote}`));
    say();
  }

  if (pr.fuses) {
    say(`${C.b}fuse 表${C.x} ${dim(`(${pr.fuses.count} 项, 版本 ${pr.fuses.version}, 偏移 ${pr.fuses.offset})`)}`);
    for (const [k, v] of Object.entries(pr.fuses.table)) {
      const mark = v === 'on' ? `${C.g}开${C.x}` : v === 'off' ? `${C.dim}关${C.x}` : `${C.y}${v}${C.x}`;
      const isHardened = pr.fuses.hardened.includes(k);
      say(`  ${isHardened ? C.y + '*' + C.x : ' '} ${k.padEnd(40)} ${mark}`);
    }
    if (pr.fuses.hardened.length) {
      say();
      say(`  ${C.y}*${C.x} = 偏离 Electron 默认值（被加固过）：${pr.fuses.hardened.join(', ')}`);
    } else {
      say();
      say(`  ${C.dim}全部为 Electron 默认值，未加固。${C.x}`);
    }
  } else if (pr.runtime !== 'tauri') {
    say(`${C.y}fuse${C.x}  ${dim('未找到哨兵')}`);
  }
  say();

  say(`${C.b}结论${C.x}`);
  say(`  CSS 注入（主战场）  ${C.g}可用${C.x} ${dim('— --remote-debugging-port 不受任何 fuse 影响')}`);
  if (pr.runtime === 'tauri') {
    say(`  --native            ${C.dim}不适用${C.x} ${dim('— Tauri 主进程是 Rust，没有 JS 可调')}`);
  } else {
    say(`  --native            ${c.canUseNative ? C.g + '可用' + C.x : C.r + '不可用' + C.x + dim(c.nativeBlockedBy ? ` — ${c.nativeBlockedBy} 已关闭` : '')}`);
  }
  if (c.windowLayerGlass) {
    say(`  窗口层玻璃          ${C.y}有${C.x} ${dim('— ' + c.windowLayerReasons.join('；'))}`);
  } else if (pr.deep && pr.runtime !== 'tauri') {
    say(`  窗口层玻璃          ${C.dim}未发现${C.x}`);
  }
  if (pr.deep && pr.deep.markers) {
    say(`  页面内毛玻璃        ${c.hasPageGlass ? C.g + '有' + C.x : C.dim + '未在 asar 中找到' + C.x}`);
    say(`  单实例锁            ${c.singleInstance ? '有' : dim('未发现')}`);
    say(`  userData 被覆盖     ${c.userDataOverride ? C.y + '是' + C.x : dim('否')}`);
  }
  say();

  // ── Tauri：前端玻璃证据（分栏，不下结论）──
  if (pr.deep && pr.deep.kind === 'tauri') {
    const g = pr.deep.glass;
    say(`${C.b}前端玻璃证据${C.x} ${dim(`（扫了 ${pr.deep.frontendFiles} 个文件，目录：${pr.deep.scannedDirs.join(', ') || '仅 exe'}）`)}`);
    say();
    if (g.cssHits) {
      say(`  ${C.g}.css 文件${C.x} ${dim('（大概率是真样式）')}  ${g.cssHits} 处`);
      for (const f of g.cssFiles) {
        say(`    ${f.file}  ${dim(`×${f.hits}`)}`);
        for (const s of f.samples.slice(0, 2)) {
          say(dim(`      …${s.snippet.slice(0, 110)}…`));
        }
      }
    } else {
      say(`  ${C.dim}.css 文件  无命中${C.x}`);
    }
    say();
    if (g.jsHits) {
      say(`  ${C.y}.js / exe${C.x} ${dim('（可能是误报，需看片段）')}  ${g.jsHits} 处`);
      for (const f of g.jsFiles.slice(0, 5)) {
        say(`    ${f.file}  ${dim(`×${f.hits}`)}`);
      }
      say();
      say(dim(`  ⚠ ${g.caveat}`));
    }
    say();
    say(dim('  这个扫描刻意不下结论 —— 请按上面的片段自己判断。'));
    say();
  }

  if (c.notes.length) {
    say(`${C.b}注意${C.x}`);
    for (const n of c.notes) say(`  · ${n}`);
    say();
  }
  if (pr.warnings.length) {
    say(`${C.b}警告${C.x}`);
    for (const w of pr.warnings) wrn(w);
    say();
  }

  // ── 应用自己的自启动参数 ──
  // 这是「注入器启动时本该静默的应用却弹窗」的直接解法：
  // 应用自己启动时会带私有标志（如 --hidden），我们启动时没带。
  if (appAutostartInfo.length) {
    const argsAll = [...new Set(appAutostartInfo.flatMap((h) => h.args || []))];
    say(`${C.b}应用自己的启动方式${C.x}`);
    for (const h of appAutostartInfo) {
      say(`  ${dim(h.where)}  ${h.name}`);
      say(`    ${h.commandLine}`);
    }
    say();
    if (argsAll.length) {
      say(`  ${C.g}发现私有启动参数：${C.x}${C.c}${argsAll.join(' ')}${C.x}`);
      say(`  ${dim('建议填进 profile 的 appArgs —— 不加它，注入器启动时应用会弹窗（本该静默到托盘）。')}`);
      say(`  ${dim(`也可以临时试：node injector/noglass.js --profile profiles/<name>.json --launch --watch --app-arg=${argsAll[0]}`)}`);
    } else {
      say(dim('  （命令行里没有私有参数，注入器启动时行为应与它自己启动一致）'));
    }
    say();
  }

  // 输出可粘贴的 profile 片段
  const suggested = {
    name: path.basename(abs, '.exe').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    displayName: path.basename(abs, '.exe'),
    exe: abs,
    processName: path.basename(abs, '.exe'),
    detected: toDetected(pr),
  };
  say(`${C.b}可粘贴的 profile 片段${C.x} ${dim('(还需人工补齐 defaultPort 等)')}`);
  say(JSON.stringify(suggested, null, 2));
  say();
  say(dim(`探测耗时 ${ms} ms。`));
}

// ─────────────────────────── new ───────────────────────────

function cmdNew(args) {
  const name = args._[0];
  const exe = args.flags.exe;
  if (!name || !exe) {
    bad('用法: node gen.js new <name> --exe <path> [--deep] [--port <n>]');
    process.exit(2);
  }
  const abs = path.resolve(exe);
  if (!fs.existsSync(abs)) { bad(`exe 不存在: ${abs}`); process.exit(2); }

  const deep = args.flags.deep !== false; // new 默认做深层探测
  const pr = probe.probeExe(abs, { deep });
  if (!pr.ok) { bad(pr.error); process.exit(1); }

  const existing = listProfiles();
  let port = args.flags.port ? Number(args.flags.port) : 9333;
  if (!args.flags.port) {
    // 自动避开已占用的默认端口：在 9333 之后按 10 递增
    const used = new Set(existing.map((n) => { try { return loadProfile(n).defaultPort; } catch { return null; } }));
    while (used.has(port)) port += 10;
  }

  const tpl = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, '_template.json'), 'utf8'));
  const c = probe.conclusions(pr);

  const prof = {
    ...tpl,
    name,
    // 默认用 exe 文件名，与 probe / UI 向导的默认显示名一致。
    // 不能依赖模板里的值：模板的 displayName 是 null（曾经是 "MyApp"，
    // 那会让每个新建 profile 都显示成 MyApp）。
    displayName: tpl.displayName || path.basename(abs, '.exe') || name,
    exe: abs,
    processName: path.basename(abs, '.exe'),
    styleId: `__noglass_${name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
    defaultPort: port,
    runtime: pr.runtime,          // electron / tauri —— 决定怎么开调试端口
    detected: toDetected(pr),
  };

  // 依据探测结果预填几个字段（只填有依据的）
  if (c.userDataOverride) {
    prof.notes = prof.notes || {};
    prof.notes.extra =
      '此应用覆盖了 userData 路径（见 detected.userDataOverride）。若需要 `--isolate`，' +
      '必须在 profile 的 isolateEnv 里填上该应用的私有开关，否则隔离不生效。';
  }
  // 应用自己的自启动参数 → 建议补进 appArgs（否则静默启动的应用会弹窗）
  try {
    const appHits = autostart.findAppAutostart(abs, path.basename(abs, '.exe'));
    const privateArgs = [...new Set(appHits.flatMap((h) => h.args || []))];
    if (privateArgs.length) {
      prof.appArgs = privateArgs;
      prof.notes = prof.notes || {};
      const lines = [
        `探测到应用**自己**的自启动命令行里带了参数：\`${privateArgs.join(' ')}\``,
        `已预填进 appArgs —— 不加它，注入器启动时应用会弹窗（本该静默到托盘）。`,
        `来源：`,
        ...appHits.map((h) => `  · ${h.where} → ${h.commandLine}`),
      ];
      prof.notes.extra = prof.notes.extra ? prof.notes.extra + '\n\n' + lines.join('\n') : lines.join('\n');
    }
  } catch { /* 探测失败不阻塞 */ }
  if (!c.canUseNative) {
    prof.notes = prof.notes || {};
    prof.notes.extra = (prof.notes.extra ? prof.notes.extra + '\n\n' : '') +
      '此应用的 `--inspect` 被 fuse 禁用，`--native` 不可用。窗口层玻璃请去系统设置关闭：' +
      '设置 → 辅助功能 → 视觉效果 → 透明效果。';
  }

  const p = saveProfile(name, prof);
  ok(`已生成 ${p}`);
  say();
  say(`${C.b}下一步${C.x}`);
  say(`  1. 打开该文件，确认/补齐这些**人工字段**：`);
  say(`     ${C.y}defaultPort${C.x}     当前 ${port}（已避开其他 profile 占用的端口）`);
  say(`     ${C.y}reservedPorts${C.x}  该应用自身占用的端口，避免冲突（如网关、本地服务）`);
  say(`     ${C.y}isolateEnv${C.x}     隔离所需的私有环境变量（若 userData 被覆盖）`);
  say(`     ${C.y}urlFilter${C.x}      只注入应用页面、放过第三方网页的正则`);
  say(`     ${C.y}notes${C.x}          该应用特有的注意事项`);
  say(`  2. 运行 ${C.c}node gen.js build ${name}${C.x} 生成启动脚本`);
  say(`  3. 运行 ${C.c}node gen.js doctor${C.x} 校验`);
}

// ─────────────────────────── build ───────────────────────────

function buildOne(name, opts = {}) {
  const prof = loadProfile(name);
  const presets = render.planPresets(prof);
  const outDir = opts.bundle ? path.join(APPS_DIR, `${name}-bundle`) : path.join(APPS_DIR, name);
  fs.mkdirSync(outDir, { recursive: true });

  // 指纹含预设列表与 bundle 标志：预设集合变化也算"产物过期"
  const fp = render.fingerprint(prof, presets.map((p) => p.file).join(',') + (opts.bundle ? '|bundle' : ''));

  const results = { name, outDir, files: [], skipped: [], fingerprint: fp };

  if (opts.bundle) {
    // 自包含：内核 + 内联配置 + 内联样式
    const src = fs.readFileSync(INJECTOR, 'utf8');
    const cssText = fs.readFileSync(CSS_FILE, 'utf8');
    const bundled = render.renderBundle(src, prof, cssText);
    const f = path.join(outDir, 'noglass.js');
    fs.writeFileSync(f, bundled, 'utf8');
    results.files.push(f);

    for (const p of presets) {
      const cmd = render.renderCmd({
        title: p.title,
        appName: prof.displayName || name,
        asciiFallback: name,
        invocation: 'node "%~dp0noglass.js"',
        defaultArgs: p.args,
        notes: [...p.notes, 'Bundled build: profile and stylesheet are inlined in noglass.js.'],
        preset: p.preset,
        fingerprint: fp,
      });
      const cf = path.join(outDir, p.file);
      fs.writeFileSync(cf, cmd, 'ascii');
      results.files.push(cf);
    }
  } else {
    // 共享内核：启动器调用根目录的 injector
    const relInjector = path.relative(outDir, INJECTOR);
    const relProfile = path.relative(outDir, path.join(PROFILES_DIR, `${name}.json`));
    for (const p of presets) {
      const cmd = render.renderCmd({
        title: p.title,
        appName: prof.displayName || name,
        asciiFallback: name,
        invocation: `node "${relInjector}" --profile "${relProfile}"`,
        defaultArgs: p.args,
        notes: p.notes,
        preset: p.preset,
        fingerprint: fp,
      });
      const cf = path.join(outDir, p.file);
      fs.writeFileSync(cf, cmd, 'ascii');
      results.files.push(cf);
    }
  }

  // 记录被跳过的预设，便于向用户解释原因
  const all = ['start.cmd', 'start-debug.cmd', 'start-isolated.cmd', 'start-native.cmd'];
  const made = presets.map((p) => p.file);
  for (const f of all) {
    if (made.includes(f)) continue;
    if (f === 'start-isolated.cmd') {
      results.skipped.push({
        file: f,
        why: '应用覆盖了 userData 且 profile 未声明 isolateEnv —— 隔离不会生效，故不生成。',
      });
    } else if (f === 'start-native.cmd') {
      results.skipped.push({
        file: f,
        why: 'fuse 关闭了 --inspect，--native 必然失败，故不生成。',
      });
    }
  }

  // README
  const md = render.renderAppReadme(prof, CSS_FILE, presets, { fingerprint: fp });
  const mf = path.join(outDir, 'README.md');
  fs.writeFileSync(mf, md, 'utf8');
  results.files.push(mf);

  return results;
}

function cmdBuild(args) {
  const all = args.flags.all === true;
  const bundle = args.flags.bundle === true;
  const names = all ? listProfiles() : args._;

  if (!names.length) {
    bad('用法: node gen.js build <name> | --all [--bundle]');
    say(dim(`  可用 profile: ${listProfiles().join(', ') || '(无)'}`));
    process.exit(2);
  }

  for (const n of names) {
    try {
      const r = buildOne(n, { bundle });
      ok(`${n}${bundle ? ' (bundle)' : ''} → ${path.relative(ROOT, r.outDir)}`);
      for (const f of r.files) say(dim(`    ${path.basename(f)}`));
      for (const s of r.skipped) say(`    ${C.y}跳过 ${s.file}${C.x} ${dim('— ' + s.why)}`);
    } catch (e) {
      bad(`${n}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// ─────────────────────────── list ───────────────────────────

/**
 * 采集 list 需要的结构化数据。
 *
 * 文本输出与 --json 共用这一份 —— 这样 UI 拿到的状态与终端看到的永远一致，
 * 不会出现"两套判断逻辑各说各话"。
 */
function collectListData() {
  const names = listProfiles();
  const rows = names.map((n) => {
    let p;
    try { p = loadProfile(n); } catch (e) { return { name: n, error: `${n}: ${e.message}` }; }
    const d = p.detected || {};
    const appDir = path.join(APPS_DIR, n);
    let cmds = [];
    try { cmds = fs.readdirSync(appDir).filter((f) => f.endsWith('.cmd')); } catch { /* none */ }

    // 产物是否与当前 profile 一致（复用 doctor 的指纹判断）
    let stale = null;
    if (!cmds.length) stale = true;
    else {
      const presets = render.planPresets(p);
      const wantFp = render.fingerprint(p, presets.map((x) => x.file).join(','));
      stale = true;
      try {
        for (const f of [...cmds, 'README.md']) {
          const txt = fs.readFileSync(path.join(appDir, f), 'utf8');
          const m = txt.match(/profile-fingerprint: `?([0-9a-f]{12})`?/);
          if (m && m[1] === wantFp) { stale = false; break; }
        }
      } catch { /* 读不到就当作过期 */ }
    }

    return {
      name: n,
      displayName: p.displayName || n,
      electron: d.electron || null,
      port: p.defaultPort != null ? p.defaultPort : null,
      processName: p.processName || null,
      exe: p.exe || null,
      exeExists: p.exe ? fs.existsSync(p.exe) : false,
      canUseNative: d.canUseNative === undefined ? null : d.canUseNative,
      hasPageGlass: d.hasPageGlass === undefined ? null : d.hasPageGlass,
      windowLayerGlass: d.windowLayerGlass === undefined ? null : d.windowLayerGlass,
      singleInstance: d.singleInstance === undefined ? null : d.singleInstance,
      userDataOverride: d.userDataOverride === undefined ? null : d.userDataOverride,
      hardened: (d.fuses && d.fuses.hardened) || [],
      reservedPorts: p.reservedPorts || [],
      presets: cmds.map((f) => f.replace(/\.cmd$/, '')),
      generated: cmds.length > 0,
      stale,
      probedAt: d.probedAt || null,
      // 开机自启动状态 —— 供 UI 列表上的两个徽章用。
      // 都是纯内存计算（autostart 字段就在 p 里），不产生额外开销。
      autostartEnabled: !!(p.autostart && p.autostart.enabled === true),
      autostartArgsDiffer: autostart.appArgsDiffer(p),
    };
  });
  return { profiles: rows };
}

function cmdList(args) {
  const data = collectListData();
  if (args && args.flags.json === true) { say(JSON.stringify(data, null, 2)); return; }

  if (!data.profiles.length) { say('（还没有 profile。用 `node gen.js new <name> --exe <path>` 创建）'); return; }

  const rows = data.profiles.map((r) => {
    if (r.error) return r;
    return {
      ...r,
      electronText: String(r.electron || '?'),
      portText: String(r.port != null ? r.port : '?'),
      nativeText: r.canUseNative === false ? '不可用' : r.canUseNative === true ? '可用' : '?',
      nativeTone: r.canUseNative === false ? 'r' : r.canUseNative === true ? 'g' : 'dim',
      glassText: r.hasPageGlass === true ? '有' : r.hasPageGlass === false ? '未发现' : '?',
      glassTone: r.hasPageGlass === true ? 'g' : 'dim',
      cmdsText: r.presets.length ? `${r.presets.length} 个` : '未生成',
      cmdsTone: r.presets.length ? (r.stale ? 'y' : 'plain') : 'dim',
    };
  });

  const bad_rows = rows.filter((r) => r.error);
  const good = rows.filter((r) => !r.error);

  // 按显示宽度对齐（中文按 2 列算）
  const w = (s) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
  const col = {
    name: Math.max(4, ...good.map((r) => w(r.name))) + 2,
    electron: Math.max(8, ...good.map((r) => w(r.electronText))) + 2,
    port: Math.max(4, ...good.map((r) => w(r.portText))) + 2,
    native: Math.max(6, ...good.map((r) => w(r.nativeText))) + 2,
    glass: Math.max(8, ...good.map((r) => w(r.glassText))) + 2,
  };
  const tone = (s, t) =>
    t === 'dim' ? dim(s) : t === 'g' ? `${C.g}${s}${C.x}` : t === 'r' ? `${C.r}${s}${C.x}` : t === 'y' ? `${C.y}${s}${C.x}` : s;

  say(`${C.b}profiles${C.x} ${dim(`(${data.profiles.length})`)}`);
  say();
  say(`  ${pad('名称', col.name)}${pad('Electron', col.electron)}${pad('端口', col.port)}${pad('native', col.native)}${pad('页面玻璃', col.glass)}启动器`);
  say(`  ${'-'.repeat(col.name + col.electron + col.port + col.native + col.glass + 10)}`);
  for (const r of good) {
    say(
      `  ${pad(r.name, col.name)}${pad(r.electronText, col.electron)}${pad(r.portText, col.port)}` +
        `${tone(pad(r.nativeText, col.native), r.nativeTone)}${tone(pad(r.glassText, col.glass), r.glassTone)}${tone(r.cmdsText, r.cmdsTone)}`
    );
  }
  for (const r of bad_rows) bad(r.error);
  say();
}

// ─────────────────────────── ps / stop / logs ───────────────────────────

/** 采集会话列表（文本与 --json 共用）。 */
function collectSessionData() {
  const all = sessions.listAll();
  const dead = all.filter((s) => s.alive === false);
  const residual = all.filter((s) => s.zombie === true);
  return {
    sessions: all.map((s) => ({
      id: s.id || null,
      pid: s.pid,
      parentPid: s.parentPid || null,
      profile: s.profile || null,
      displayName: s.displayName || null,
      appName: s.appName || null,
      processName: s.processName || null,
      port: s.port,
      watch: s.watch === undefined ? null : s.watch,
      isolate: s.isolate === undefined ? null : s.isolate,
      native: s.native === undefined ? null : s.native,
      source: s.source || null,
      startedAt: s.startedAt || null,
      pages: s.pages === undefined ? null : s.pages,
      lastTick: s.lastTick || null,
      cssExtra: s.cssExtra || null,
      emulateColorScheme: s.emulateColorScheme || null,
      darkreader: s.darkreader || null,
      darkreaderTheme: s.darkreaderTheme || null,
      alive: s.alive !== false,
      // 残留：pid 还在但心跳早停了（硬关机留下的）。不算运行中。
      zombie: s.zombie === true,
      external: !!s.external,
      logFile: s.__logFile || null,
      commandLine: s.commandLine || null,
    })),
    dead,
    residual,
    registered: all.filter((s) => !s.external).length,
    external: all.filter((s) => s.external).length,
  };
}

function cmdPs(args) {
  const data = collectSessionData();
  if (args.flags.json === true) { say(JSON.stringify(data, null, 2)); return; }

  // 残留项（pid 还在但心跳早停）不算运行中，单独列出 —— 否则它们看起来
  // 像活会话，而"停止"对它们无效（停不掉的标签就是这么来的）。
  const live = data.sessions.filter((s) => s.alive && !s.zombie);
  const residual = data.sessions.filter((s) => s.zombie);

  if (!live.length && !residual.length) {
    say('当前没有运行中的注入会话。');
    say(dim('  启动一个：node injector/noglass.js --profile profiles/<name>.json --launch --watch'));
    return;
  }

  if (live.length) {
    say(`${C.b}注入会话${C.x} ${dim(`(${live.length} 个运行中 · ${data.registered} 已登记 · ${data.external} 外部发现)`)}`);
    say();
    for (const s of live) {
      const name = s.displayName || s.appName || s.profile || '(未知)';
      const tags = [];
      if (s.external) tags.push(`${C.y}外部${C.x}`);
      else tags.push(`${C.g}已登记${C.x}`);
      if (s.watch) tags.push('watch');
      if (s.isolate) tags.push('isolate');
      if (s.native) tags.push('native');

      say(`  ${C.b}${name}${C.x}  ${dim(tags.join(' '))}`);
      say(`    pid ${s.pid}  端口 ${s.port == null ? '?' : s.port}  ${s.source ? `来源 ${s.source}` : ''}`);
      if (s.startedAt) say(dim(`    启动于 ${s.startedAt}`));
      if (s.pages != null) say(dim(`    页面 ${s.pages}`));
      if (s.cssExtra) say(dim(`    自定义 CSS ${s.cssExtra}`));
      if (s.emulateColorScheme) say(dim(`    配色模拟 ${s.emulateColorScheme}`));
      if (s.darkreader) {
        const eng = (s.darkreaderTheme && s.darkreaderTheme.engine) || 'dynamicTheme';
        say(dim(`    Dark Reader ${s.darkreader}（引擎 ${eng}）`));
      }
      if (s.id) say(dim(`    id ${s.id}`));
      else say(dim(`    无 id —— 这是旧版本启动的注入器，无法用 stop 优雅停止`));
      say();
    }
  }

  if (residual.length) {
    say(`${C.y}${residual.length} 个残留会话${C.x} ${dim('（pid 还在但心跳已停 —— 通常是硬关机留下的；对它们「停止」只会清理残留项）')}`);
    say();
    for (const s of residual) {
      const name = s.displayName || s.appName || s.profile || '(未知)';
      say(`  ${C.y}${name}${C.x}  ${dim(`pid ${s.pid}`)}`);
      if (s.id) say(dim(`    id ${s.id}`));
      if (s.lastTick) say(dim(`    最后心跳 ${s.lastTick}`));
    }
    say();
    say(dim(`  清理：${C.c}node gen.js prune${C.x}`));
    say();
  }

  if (data.dead.length) {
    // 注意：真正能清的是独立的 `prune` 子命令。以前这里写的是
    // "ps --prune"，而 cmdPs 根本不处理那个 flag —— 照着敲什么都不会发生。
    say(`${C.y}${data.dead.length} 个注册项对应的进程已不存在${C.x}（运行 ${C.c}node gen.js prune${C.x} 清理）`);
    say();
  }
}

function cmdStop(args) {
  const target = args._[0];
  if (!target) {
    bad('用法: node gen.js stop <id|profile|pid>');
    say(dim('  用 `node gen.js ps` 查看可停止的会话。'));
    process.exit(2);
  }

  const all = sessions.listAll();
  // 三种定位方式：完整 id、profile 名、pid
  const hit = all.find((s) => s.id === target)
    || all.find((s) => s.profile === target)
    || all.find((s) => String(s.pid) === String(target));

  if (!hit) {
    bad(`没找到会话：${target}`);
    say(dim('  用 `node gen.js ps` 查看。'));
    process.exit(1);
  }

  if (hit.external || !hit.id) {
    // 旧版本注入器没有登记，也就没有停止文件通道
    wrn('这是一个「外部发现」的注入器（旧版本启动，未登记）。');
    wrn('它不支持协作式停止。若强行结束它，目标应用**不会被关闭**（我们不用 /T），');
    wrn(`但注入也会随之失效（刷新页面即恢复原样）。`);
    if (args.flags.force !== true) {
      say();
      say(`要强行结束，请加 ${C.c}--force${C.x}：`);
      say(`  node gen.js stop ${hit.pid} --force`);
      process.exit(1);
    }
    const r = sessions.forceKill(hit.pid);
    if (r.ok) ok(`已结束外部注入器 pid ${hit.pid}（目标应用未受影响）。`);
    else bad(`结束失败：${r.error}`);
    return;
  }

  const r = sessions.requestStop(hit.id);
  if (!r.ok) { bad(`停止请求失败：${r.error}`); process.exit(1); }

  const name = hit.displayName || hit.appName || hit.profile;
  say(`已发送停止请求给 ${C.b}${name}${C.x}（${hit.id}）。`);
  say(dim('  注入器会在 1 秒内优雅退出。'));
  say(`${C.g}目标应用不会被关闭。${C.x}`);

  // 等一会儿确认真的退了
  const deadline = Date.now() + 6000;
  let gone = false;
  while (Date.now() < deadline) {
    const still = sessions.listRegistered().find((s) => s.id === hit.id);
    if (!still || !sessions.isAlive(still.pid)) { gone = true; break; }
    sleepSync(300);
  }
  if (gone) ok('注入器已退出，注册项已清理。');
  else wrn('注入器尚未退出。可稍后用 `node gen.js ps` 复查。');
}

function cmdLogs(args) {
  const target = args._[0];
  if (!target) {
    bad('用法: node gen.js logs <id|profile|pid> [-n 行数]');
    process.exit(2);
  }
  const all = sessions.listAll();
  const hit = all.find((s) => s.id === target)
    || all.find((s) => s.profile === target)
    || all.find((s) => String(s.pid) === String(target));

  if (!hit) { bad(`没找到会话：${target}`); process.exit(1); }
  if (!hit.id) {
    bad('这是外部发现的注入器，没有日志文件（旧版本不写 run/logs/）。');
    process.exit(1);
  }

  const n = args.flags.n ? Number(args.flags.n) : 200;
  const r = sessions.readLog(hit.id, n);
  if (!r.ok) { bad(`读日志失败：${r.error}`); process.exit(1); }

  const name = hit.displayName || hit.appName || hit.profile;
  say(`${C.b}${name}${C.x} 的日志 ${dim(`(${r.path})`)}`);
  say();
  for (const line of r.lines) {
    if (!line) continue;
    const cls = /已注入 ✓|就绪|已退出|已重新注入/.test(line) ? C.g
      : /失败|出错|错误|超时/.test(line) ? C.r
      : /警告|⚠|跳过/.test(line) ? C.y : '';
    say(cls ? `${cls}${line}${C.x}` : line);
  }
}

function cmdPrune(args) {
  const n = sessions.prune();
  if (args.flags.json === true) { say(JSON.stringify({ ok: true, removed: n })); return; }
  if (n) ok(`已清理 ${n} 个孤儿注册项。`);
  else say('没有需要清理的注册项。');
}

// ─────────────────────────── autostart ───────────────────────────

function cmdAutostart(args) {
  const action = args._[0];
  const name = args._[1];

  // ── list ──
  if (action === 'list' || action === undefined) {
    // 需要中转器的 target/args 详情 → 显式要求（会起一次 PowerShell）
    const st = autostart.listManaged({ withRelayDetail: true });
    if (args.flags.json === true) { say(JSON.stringify({ ok: true, ...st }, null, 2)); return; }

    say(`${C.b}开机自启动${C.x}`);
    say();
    if (st.relay && st.relay.exists) {
      say(`  ${C.g}中转器已就位${C.x} ${dim('（一个快捷方式拉起全部已启用的应用）')}`);
      say(dim(`    ${st.relay.lnk}`));
    } else {
      say(`  ${C.y}中转器不存在${C.x} ${dim('—— 启用任一 profile 时会自动创建')}`);
    }
    say();

    if (st.enabled.length) {
      say(`  已启用的 profile ${dim(`(${st.enabled.length})`)}`);
      for (const e of st.enabled) {
        const a = e.appArgs && e.appArgs.length ? dim(`  appArgs: ${e.appArgs.join(' ')}`) : '';
        say(`    ${C.b}${e.displayName || e.name}${C.x}${a}`);
      }
    } else {
      say(dim('  （没有 profile 启用自启动）'));
    }

    if (st.legacy.length) {
      say();
      say(`  ${C.y}发现旧式启动项${C.x} ${dim('（每 profile 一个 .lnk，会与新中转器重复启动）')}`);
      for (const l of st.legacy) say(`    ${l.file}`);
      say(dim(`    清理：node gen.js autostart on <profile> 会自动删掉对应的旧项`));
    }
    say();
    say(dim('  开启：node gen.js autostart on <profile>'));
    say(dim('  关闭：node gen.js autostart off <profile>'));
    return;
  }

  // ── run（手动跑一次中转器，调试用）──
  if (action === 'run') {
    const dry = args.flags['dry-run'] === true || args.flags.dry === true;
    const argv = ['python', path.join(ROOT, 'ui', 'app.py'), '--autostart-all'];
    if (dry) argv.push('--dry-run');
    try {
      execFileSync(argv[0], argv.slice(1), { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      bad(`运行中转器失败：${e.message}`);
      process.exit(1);
    }
    return;
  }

  // ── log（看中转器日志）──
  if (action === 'log') {
    const p = path.join(ROOT, 'run', 'logs', 'autostart', 'autostart.log');
    if (!fs.existsSync(p)) {
      say('（还没有中转器日志 —— 开机自启还没跑过，或从没启用过）');
      say(dim(`  期望位置：${p}`));
      return;
    }
    const n = args.flags.n ? Number(args.flags.n) : 100;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    say(`${C.b}中转器日志${C.x} ${dim(`(${p})`)}`);
    say();
    for (const l of lines.slice(-n)) if (l) say(l);
    return;
  }

  // ── config（读写本机设置）──
  if (action === 'config') {
    const settings = require('./lib/settings');
    if (args.flags.json === true) { say(JSON.stringify(settings.read(), null, 2)); return; }

    const setArg = args.flags.set;          // --set key=value（可重复不行，gen.js 解析器限制）
    if (setArg) {
      const eq = String(setArg).indexOf('=');
      if (eq < 0) { bad('格式：--set key=value'); process.exit(2); }
      const k = String(setArg).slice(0, eq);
      let v = String(setArg).slice(eq + 1);
      const patch = {};
      if (k === 'initialDelayMs' || k === 'delayMs') patch[k] = Number(v);
      else if (k === 'neverPromptDelete' || k === 'neverWarnStartup') patch[k] = (v === 'true' || v === '1');
      else if (k === 'pythonw') patch[k] = v === 'auto' ? null : v;
      else { bad(`未知设置项：${k}`); say(dim('  可用：initialDelayMs / delayMs / neverPromptDelete / neverWarnStartup / pythonw')); process.exit(2); }
      const r = settings.write(patch);
      if (!r.ok) { bad(r.error); process.exit(1); }
      ok(`已保存：${k} = ${JSON.stringify(patch[k])}`);
      say(dim(`  ${r.path}`));
      return;
    }

    const cur = settings.read();
    say(`${C.b}开机自启动设置${C.x} ${dim(`(${settings.FILE})`)}`);
    say();
    say(`  初始延迟      ${cur.initialDelayMs} ms ${dim('（开机后等多久再启动第一个）')}`);
    say(`  逐条间隔      ${cur.delayMs} ms ${dim('（给上一个应用留启动缓冲）')}`);
    say(`  关闭最后一项时不再询问  ${cur.neverPromptDelete}`);
    say(`  无启用项时不再警告      ${cur.neverWarnStartup}`);
    say(`  运行器        ${cur.pythonw === null ? '自动检测' : (cur.pythonw || '（明确不用）')}`);
    say();
    say(dim('  改：node gen.js autostart config --set delayMs=8000'));
    say(dim('  运行器自动检测结果：node gen.js env（或 UI 里的「检测」按钮）'));
    return;
  }

  if (!name) {
    bad(`用法: node gen.js autostart ${action} <profile>`);
    process.exit(2);
  }

  // profile 必须存在
  const profPath = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(profPath)) {
    bad(`profile 不存在：${profPath}`);
    say(dim(`  可用：${listProfiles().join(', ') || '(无)'}`));
    process.exit(1);
  }
  const prof = loadProfile(name);

  // ── on ──
  if (action === 'on') {
    const r = autostart.enable(name, {
      exe: prof.exe,
      processName: prof.processName,
      ignoreConflicts: args.flags.force === true,
    });

    if (!r.ok && r.conflict) {
      wrn(`检测到该应用**已经**有自启动项：`);
      say();
      for (const c of r.conflicts) {
        say(`    ${C.y}${c.where}${C.x}  ${c.name}  ${dim(`(${c.how})`)}`);
      }
      say();
      say('这意味着开机后应用会自己启动一次，而我们的中转器也会再启动一次。');
      say('两者会撞单实例锁：第二次启动会直接退出，调试端口也就开不起来。');
      say();
      say(`建议二选一：`);
      say(`  ${C.c}1)${C.x} 保留应用自己的自启动，改用「手动注入」——`);
      say(`     开机后应用已在运行，此时用 ${C.c}node gen.js ps${C.x} 看不到它（没有调试端口），`);
      say(`     需要先退出应用再用本工具启动。`);
      say(`  ${C.c}2)${C.x} 关掉应用自己的自启动项，改用本工具代理（推荐）：`);
      say(`     删除上面列出的那个启动项，然后：`);
      say(`     ${C.c}node gen.js autostart on ${name} --force${C.x}`);
      say();
      say(dim('  --force 会跳过这个检查。'));
      process.exitCode = 1;
      return;
    }
    if (!r.ok) { bad(r.error); process.exit(1); }

    ok(`已启用开机自启动：${name}`);
    say();
    say(`  中转器    ${r.relay}`);
    say(`  运行器    ${r.pythonw}`);
    if (r.removedLegacy && r.removedLegacy.length) {
      say(`  ${C.y}已删除旧式启动项${C.x} ${dim('（避免与中转器重复启动）')}`);
      for (const l of r.removedLegacy) say(`    ${l}`);
    }
    say();
    say(dim('  下次登录时，中转器会按字母序逐个拉起已启用的应用（带间隔）。'));
    say();
    // 用户指定：提示自定义开机参数要改 profile
    say(`${C.y}需要给开机启动单独设置参数？${C.x}改这个文件：`);
    say(`  ${C.c}${r.profilePath}${C.x}`);
    say(dim('  在里面加 "autostart": { "appArgs": ["--hidden"] }（null = 沿用顶层 appArgs）。'));
    return;
  }

  // ── off ──
  if (action === 'off') {
    const r = autostart.disable(name);
    if (!r.ok) { bad(r.error); process.exit(1); }
    ok(`已关闭开机自启动：${name}`);
    if (r.shouldPromptDelete) {
      say();
      say(dim('  现在没有任何 profile 启用自启动了。'));
      say(dim('  中转器快捷方式还留着（开机后会起来、发现没东西可启动、然后退出）。'));
      say(dim('  想删掉它：node gen.js autostart off --cleanup'));
    }
    return;
  }

  // ── off --cleanup（删除中转器快捷方式）──
  if (action === 'cleanup') {
    const r = autostart.removeRelayLnk();
    if (!r.ok) { bad(r.error); process.exit(1); }
    ok(r.already ? '中转器本来就不存在' : `已删除中转器：${r.lnk}`);
    return;
  }

  bad(`未知动作：${action}（可用：on / off / list / run / log / config / cleanup）`);
  process.exit(2);
}

// ─────────────────────────── doctor ───────────────────────────

/**
 * 采集 doctor 需要的结构化数据（文本与 --json 共用）。
 * 返回 { ok, profiles: [{ name, issues: [] }], problemCount }
 */
function collectDoctorData() {
  const names = listProfiles();
  const ports = new Map();
  const profiles = [];
  let problemCount = 0;

  // ── 自启动信息只读一次 ──
  //
  // 踩过的坑：最初把 findAppAutostart 直接放进下面的 per-profile 循环，
  // 于是每个 profile 都要起两次 PowerShell（读 HKCU/HKLM Run 键 + 读启动
  // 文件夹的 .lnk）。7 个 profile → doctor 从 2 秒变成 29 秒，UI 的
  // get_overview 也跟着卡（它内部会调 doctor）。
  //
  // 现在预读一次、按 exe 建索引，循环里只做内存匹配。
  // 这与 ui/sessions.py 文件头记的那条教训是同一个：昂贵的查询不能放热路径。
  const autostartIndex = [];
  try {
    for (const hive of ['HKCU', 'HKLM']) {
      for (const item of autostart.readRunKey(hive)) {
        autostartIndex.push({
          where: `${hive}\\...\\Run`,
          name: item.name,
          commandLine: item.value,
          args: autostart.appPrivateArgs(extractArgsFromCommand(item.value)),
        });
      }
    }
    for (const sc of autostart.readStartupShortcuts()) {
      if (sc.file.startsWith('no-glass · ')) continue;   // 本工具自己的不算
      autostartIndex.push({
        where: '启动文件夹',
        name: sc.file,
        target: sc.target,
        commandLine: `${sc.target} ${sc.args}`.trim(),
        args: autostart.appPrivateArgs(sc.args),
      });
    }
  } catch { /* 读不到就当没有 */ }

  // 中转器状态与运行器可用性 —— 也预读一次，循环里纯内存判断。
  //
  // relayExists：中转器 .lnk 在不在（readAutostartAll 已缓存，零额外成本）
  // pythonwOk：**不实测**，只看设置项/where 能否定位到文件。
  //   doctor 在热路径上（UI 的 get_overview 会调它），实测 -c 要 100ms+ 起进程，
  //   不能放这里 —— 真正的实测留给 UI 的「检测」按钮和 `gen.js env`。
  let relayExists = false;
  try {
    const st = autostart.listManaged();
    relayExists = !!(st.relay && st.relay.exists);
  } catch { /* 忽略 */ }
  // pythonw 只在**有 profile 启用自启动时**才需要 —— 没启用就不查，
  // 省掉一次进程启动（doctor 在热路径上，UI 的 get_overview 会调它）。
  //
  // 注意：此处 `profiles` 数组还没填充（循环在下面），所以直接看 names +
  // 读 profile 文件。只读几个小 JSON，毫秒级。
  let pythonwOk = true;
  let anyAutostartEnabled = false;
  try {
    for (const n of names) {
      try {
        const p = loadProfile(n);
        if (p.autostart && p.autostart.enabled === true) { anyAutostartEnabled = true; break; }
      } catch { /* 单个坏了跳过 */ }
    }
  } catch { /* 忽略 */ }
  if (anyAutostartEnabled) {
    try {
      const cfg = require('./lib/settings').read();
      if (cfg.pythonw === '') {
        pythonwOk = false;                 // 用户明确说不用 Python
      } else if (typeof cfg.pythonw === 'string' && cfg.pythonw) {
        pythonwOk = fs.existsSync(cfg.pythonw);
      } else {
        // 自动模式：只看 where 能不能找到（不起进程实测）
        try {
          const out = execFileSync('where', ['pythonw'], {
            encoding: 'utf8', timeout: 5000, windowsHide: true,
          }).trim();
          pythonwOk = !!out;
        } catch { pythonwOk = false; }
      }
    } catch { /* 忽略 */ }
  }

  /** 从一条命令行里剥出参数部分。 */
  function extractArgsFromCommand(cmd) {
    const v = String(cmd || '').trim();
    if (!v) return '';
    if (v.startsWith('"')) return v.slice(v.indexOf('"', 1) + 1).trim();
    const m = v.match(/^\S+\s+(.*)$/);
    return m ? m[1].trim() : '';
  }

  /** 在预读的索引里找某个 exe 自己的自启动项（纯内存，无外部调用）。 */
  function lookupAutostart(exePath, processName) {
    const base = processName || (exePath ? path.basename(exePath, '.exe') : null);
    if (!base) return [];
    const baseLower = base.toLowerCase();
    const exeLower = exePath ? String(exePath).toLowerCase().replace(/\//g, '\\') : null;
    return autostartIndex.filter((it) => {
      const hay = `${it.name} ${it.commandLine} ${it.target || ''}`.toLowerCase().replace(/\//g, '\\');
      if (hay.includes(baseLower)) return true;
      if (exeLower && hay.includes(exeLower)) return true;
      return false;
    });
  }

  for (const n of names) {
    let p;
    try { p = loadProfile(n); }
    catch (e) { profiles.push({ name: n, parseError: e.message, issues: [`profile 解析失败 — ${e.message}`] }); problemCount++; continue; }

    const d = p.detected || {};
    const issues = [];

    // exe 存在性
    if (!p.exe) issues.push('未设置 exe 路径');
    else if (!fs.existsSync(p.exe)) issues.push(`exe 不存在: ${p.exe}`);

    // 端口冲突
    const port = p.defaultPort;
    if (port == null) issues.push('未设置 defaultPort');
    else {
      if (ports.has(port)) issues.push(`defaultPort ${port} 与 profile "${ports.get(port)}" 冲突`);
      else ports.set(port, n);
    }

    // 端口落在自身保留段里
    if (port != null && Array.isArray(p.reservedPorts) && p.reservedPorts.length) {
      const lo = Math.min(...p.reservedPorts), hi = Math.max(...p.reservedPorts);
      if (port >= lo && port <= hi) issues.push(`defaultPort ${port} 落在自身 reservedPorts 范围 ${lo}-${hi} 内`);
    }

    // fuse 与预设矛盾（Tauri 没有 fuse，跳过）
    const runtime = p.runtime || d.runtime || 'electron';
    const isTauri = runtime === 'tauri';
    const fuses = d.fuses && d.fuses.table;
    const inspectOk = !fuses || fuses.EnableNodeCliInspectArguments === 'on';
    if (!isTauri && !inspectOk && p.native && p.native.enabled === true) {
      issues.push('fuse 禁用了 --inspect，但 profile 里 native.enabled=true（--native 必然失败）');
    }
    // Tauri 上 --native 本来就不可能成功，开了就是配错了
    if (isTauri && p.native && p.native.enabled === true) {
      issues.push('Tauri 应用不支持 --native（主进程是 Rust，没有 JS 可调），请把 native.enabled 设为 false');
    }

    // runtime 值域
    if (p.runtime != null && !['electron', 'tauri', 'unknown'].includes(p.runtime)) {
      issues.push(`runtime 值非法："${p.runtime}"（只能是 electron / tauri / unknown）`);
    }

    // 隔离声明与 userData 覆盖矛盾（Tauri 走 WEBVIEW2_USER_DATA_FOLDER，不适用这条）
    if (!isTauri && d.userDataOverride === true && !p.isolateEnv) {
      issues.push('detected.userDataOverride=true，但未声明 isolateEnv → --isolate 不会生效（不会生成 start-isolated.cmd）');
    }

    // 探测陈旧
    if (d.probedAt) {
      const age = (Date.now() - new Date(d.probedAt).getTime()) / 86400000;
      if (age > 180) issues.push(`探测结果已 ${Math.round(age)} 天，应用可能已更新，建议重跑 probe`);
    }
    // 只有 Electron 才该有 fuse 表；Tauri 没有是正常的，不该报问题
    if (!isTauri && !d.fuses) {
      issues.push('未探测到 fuse 表（可能是非 Electron 应用或裁剪构建）');
    }

    // ── 后台启动标志缺失 ──
    // 应用自己启动时带私有标志（如 Todo清单 的 --hidden），而我们启动时
    // 没带 → 本该静默到托盘的应用会弹窗。这里对照应用自己的自启动命令行，
    // 发现"它有、我们没配"就提醒。
    if (p.exe && fs.existsSync(p.exe)) {
      try {
        const hits = lookupAutostart(p.exe, p.processName);
        const priv = [...new Set(hits.flatMap((h) => h.args || []))];
        const have = new Set(p.appArgs || []);
        const missing = priv.filter((a) => !have.has(a));
        if (missing.length) {
          issues.push(
            `应用自己的自启动命令行带参数 ${missing.join(' ')}，但 profile 的 appArgs 里没有 → ` +
            `注入器启动时应用会弹窗（本该静默）。来源：${hits[0].where} ${hits[0].commandLine}`
          );
        }
      } catch { /* 读不到不报错 */ }
    }

    // ── 开机自启动（中转器）──
    //
    // 全部用**内存里已有**的数据判断，不再起进程/PowerShell：
    //   · relayState / pythonw 在循环外预读一次（见下面）
    //   · autostart.appArgs 与 appArgs 的比对是纯内存
    // 这条纪律来自第 10 条的教训（昂贵查询不能进热路径）。
    const au = p.autostart || {};
    const auEnabled = au.enabled === true;

    if (auEnabled && !relayExists) {
      issues.push(
        'autostart.enabled 为 true，但中转器快捷方式不存在 → 开机不会启动任何东西。' +
        ' 重新执行 `node gen.js autostart on ' + n + '` 会重建它。'
      );
    }
    if (autostart.appArgsDiffer(p)) {
      const eff = autostart.effectiveAppArgs(p);
      const top = Array.isArray(p.appArgs) ? p.appArgs : [];
      issues.push(
        `自启动参数与手动启动参数不同：手动用 [${top.join(' ')}]，开机用 [${eff.join(' ')}]。` +
        ' 这是有意配置（autostart.appArgs 覆盖顶层 appArgs）时正常；' +
        ' 若你只是想沿用顶层参数，把 autostart.appArgs 设为 null。'
      );
    }
    if (auEnabled && !pythonwOk) {
      issues.push(
        '已启用开机自启动，但找不到可用的 pythonw.exe → 开机时中转器不会被拉起。' +
        ' 在 UI 的「自启动运行器」里点「检测」，或 `node gen.js autostart config --set pythonw=<路径>`。'
      );
    }

    // ── Dark Reader 字段校验 ──
    // 这是 profile 里唯一有明确值域约束的字段组，之前没有校验：
    // 写错值（如 "blue"）会被注入器静默当成 auto 用，doctor 完全无感。
    const DR_MODES = ['auto', 'dark', 'light', 'off'];
    const drOn = p.darkreader && DR_MODES.includes(p.darkreader) && p.darkreader !== 'off';
    if (p.darkreader != null && !DR_MODES.includes(p.darkreader)) {
      issues.push(`darkreader 值非法："${p.darkreader}"（只能是 ${DR_MODES.join(' / ')}，或留空关闭）`);
    }
    if (drOn) {
      // 引擎文件是可选的，但开了 darkreader 就必须有
      const enginePath = path.join(ROOT, 'vendor', 'darkreader.js');
      if (!fs.existsSync(enginePath)) {
        issues.push('启用了 darkreader，但 vendor/darkreader.js 不存在（运行 tools/darkreader.js 会自动下载，或手工放入）');
      }
      const eng = (p.darkreaderTheme && p.darkreaderTheme.engine) || 'dynamicTheme';
      const ENGINES = ['dynamicTheme', 'staticTheme', 'cssFilter', 'svgFilter'];
      if (!ENGINES.includes(eng)) {
        issues.push(`darkreaderTheme.engine 值非法："${eng}"（只能是 ${ENGINES.join(' / ')}）`);
      } else if (eng === 'cssFilter' || eng === 'svgFilter') {
        issues.push(`darkreaderTheme.engine=${eng} 是整页反色，会把彩色图标和标签一起反掉（"颜色丢失"的来源），一般不建议`);
      }
      // 两份深色方案会互相干扰（Dark Reader 会把已有深色再算一遍）
      const convCss = path.join(ROOT, 'css', `${n}.custom.css`);
      const hasCss = !!(p.cssExtra || fs.existsSync(convCss));
      if (hasCss) {
        issues.push('同时启用了 darkreader 和自定义深色 CSS → 两份方案会互相干扰（彩色标签会被压平），建议二选一');
      }
    }

    // 生成产物是否最新 —— 用内容指纹比对，不用 mtime
    // （mtime 在 git clone/checkout 后全被刷成同一刻，判断不了新旧）
    const appDir = path.join(APPS_DIR, n);
    if (!fs.existsSync(appDir)) issues.push('尚未生成启动器（运行 build）');
    else {
      const presets = render.planPresets(p);
      const wantFp = render.fingerprint(p, presets.map((x) => x.file).join(','));
      let found = false, stale = false;
      try {
        for (const f of fs.readdirSync(appDir)) {
          if (!f.endsWith('.cmd') && f !== 'README.md') continue;
          const txt = fs.readFileSync(path.join(appDir, f), 'utf8');
          const m = txt.match(/profile-fingerprint: `?([0-9a-f]{12})`?/);
          if (!m) { stale = true; break; }
          if (m[1] === wantFp) { found = true; break; }
        }
      } catch { /* ignore */ }
      if (stale) issues.push('生成产物缺少指纹（旧版本生成）→ 重新 build');
      else if (!found) issues.push('生成产物与当前 profile 不一致 → 重新 build');
    }

    problemCount += issues.length;
    profiles.push({ name: n, issues });
  }

  return { ok: problemCount === 0, profiles, problemCount };
}

function cmdDoctor(args) {
  const data = collectDoctorData();
  if (args && args.flags.json === true) {
    say(JSON.stringify(data, null, 2));
    if (!data.ok) process.exitCode = 1;
    return;
  }

  if (!data.profiles.length) { say('（还没有 profile）'); return; }

  say(`${C.b}校验 profiles${C.x}`);
  say();

  for (const r of data.profiles) {
    if (!r.issues.length) { say(`  ${C.g}${r.name}${C.x} ${dim('无问题')}`); continue; }
    say(`  ${C.y}${r.name}${C.x}`);
    for (const i of r.issues) say(`    ${C.y}!${C.x} ${i}`);
  }

  say();
  if (data.problemCount) {
    say(`${C.y}共 ${data.problemCount} 项待处理。${C.x}`);
    process.exitCode = 1;
  } else {
    ok('全部通过。');
  }
}

// ─────────────────────────── env（环境自检）───────────────────────────

/**
 * 检查运行环境是否满足要求。
 *
 * 为什么单独做一个命令而不是塞进 doctor：
 *   · doctor 检查的是**你的 profile 配置**（端口冲突、产物过期…），
 *     前提是环境已经能跑
 *   · env 检查的是**这台机器能不能跑这个工具**（Node 版本、Python、
 *     pywebview、PowerShell）。第一次 clone 下来的人该先跑这个。
 *
 * 分两档：
 *   必需 —— 缺了核心功能就不能用（Node）
 *   可选 —— 缺了只是某个功能不可用（Python/pywebview 只影响图形界面）
 */
function cmdEnv(args) {
  const asJson = args && args.flags.json === true;
  const rows = [];

  const add = (key, label, required, ok, detail, hint) => {
    rows.push({ key, label, required, ok, detail, hint });
  };

  // 1) Node —— 核心必需
  const nodeVer = process.version;                    // v24.13.0
  const major = Number(nodeVer.replace(/^v/, '').split('.')[0]);
  const nodeOk = major >= 18;
  add('node', 'Node.js', true, nodeOk, `${nodeVer}（需要 18+）`,
    nodeOk ? null : '去 https://nodejs.org 装 Node 18 或更高版本。'
      + '本工具的 CLI 与注入器完全靠它，缺了不能用。');

  // 2) PowerShell —— 核心必需（探测运行中进程、管理自启动项都用它）
  let psOk = false, psDetail = '未找到';
  if (process.platform === 'win32') {
    try {
      const v = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
      psOk = !!v;
      psDetail = v || '可用';
    } catch { psDetail = '调用失败'; }
  } else {
    psDetail = `非 Windows（${process.platform}）—— 本工具目前只支持 Windows`;
  }
  add('powershell', 'PowerShell', true, psOk, psDetail,
    psOk ? null : 'Windows 自带的 Windows PowerShell 5.1 即可，通常不需要额外安装。');

  // 3) Python —— 可选（只有图形界面需要）
  let pyOk = false, pyDetail = '未找到', pyVer = '';
  for (const cmd of ['python', 'py', 'python3']) {
    try {
      const v = execFileSync(cmd, ['--version'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (v) { pyOk = true; pyVer = v; pyDetail = `${v}（${cmd}）`; break; }
    } catch { /* 试下一个 */ }
  }
  add('python', 'Python 3', false, pyOk, pyDetail,
    pyOk ? null : '只有图形界面需要它。不装也能用命令行。装：https://python.org');

  // 4) pywebview —— 可选（图形界面的依赖）
  let wvOk = false, wvDetail = '未检测';
  if (pyOk) {
    try {
      // 注意：pywebview 没有 __version__ 属性（实测 6.1 报 AttributeError），
      // 所以用 importlib.metadata 拿版本，拿不到就退化成"已安装"。
      const v = execFileSync('python', ['-c',
        'import importlib.metadata as m; print(m.version("pywebview"))'],
        { encoding: 'utf8', timeout: 20000, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      wvOk = !!v;
      wvDetail = v ? `pywebview ${v}` : '已安装';
    } catch {
      // 再退一步：只 import 看能不能用（版本拿不到不代表装没装）
      try {
        execFileSync('python', ['-c', 'import webview'],
          { encoding: 'utf8', timeout: 20000, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] });
        wvOk = true;
        wvDetail = '已安装（版本未知）';
      } catch {
        wvDetail = '未安装';
      }
    }
  } else {
    wvDetail = '（需要先装 Python）';
  }
  add('pywebview', 'pywebview', false, wvOk, wvDetail,
    wvOk ? null : '图形界面的依赖。装：pip install pywebview');

  // 4b) pythonw（开机自启动的运行器，可选）
  //
  // 用与 autostart.findPythonw 相同的判据（实测能跑）—— 不实测就会
  // 把商店版别名误判成不可用（existsSync 对它返回 false，见 lib/autostart.js 注释）。
  const { execFileSync: _exef } = require('child_process');
  let pywOk = false, pywDetail = '未找到';
  try {
    const pyw = autostart.findPythonw();
    if (pyw) { pywOk = true; pywDetail = pyw; }
  } catch { /* 忽略 */ }
  add('pythonw', 'pythonw（开机自启用）', false, pywOk, pywDetail,
    pywOk ? null : '开机自启用它才不会闪黑窗口。没装 Python 时可用任务计划程序替代（见 CLI.md 第六节）。');

  // 5) 项目文件完整性（自己是不是被完整拷来了）
  const missing = [];
  for (const [p, label] of [
    [path.join(ROOT, 'injector', 'noglass.js'), '注入器'],
    [path.join(ROOT, 'lib', 'probe.js'), '探测模块'],
    [path.join(ROOT, 'profiles', '_template.json'), 'profile 模板'],
  ]) {
    if (!fs.existsSync(p)) missing.push(label);
  }
  add('files', '项目文件', true, missing.length === 0,
    missing.length ? `缺少：${missing.join('、')}` : '完整',
    missing.length ? '文件不齐 —— 重新完整 clone 或解压一次。' : null);

  // 5b) 模块能否真正加载（`node --check` 查不出的那类错）
  //
  // 为什么单独检这一项：`node --check` 只验语法，**不验标识符是否存在**。
  // 实测踩过：删掉一个函数却漏了 module.exports 里的引用 —— 语法完全合法，
  // --check 通过、doctor 全绿，但注入器一启动就 ReferenceError 崩掉。
  // 唯一可靠的静态手段是**真正 require 一次**（模块顶层会立刻执行到
  // module.exports 那行，未定义的引用当场抛错）。
  const modErrs = [];
  for (const rel of [
    'injector/noglass.js', 'lib/probe.js', 'lib/render.js',
    'lib/sessions.js', 'lib/autostart.js',
  ]) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      require(abs);
    } catch (e) {
      modErrs.push(`${rel}: ${String(e.message).split('\n')[0]}`);
    }
  }
  add('modules', '模块可加载', true, modErrs.length === 0,
    modErrs.length ? modErrs.join('；') : '全部可 require',
    modErrs.length ? '模块里有未定义的引用（语法检查查不出的那类）—— 见上面报错。' : null);

  // 6) Dark Reader 引擎（可选，深色功能用）
  const drPath = path.join(ROOT, 'vendor', 'darkreader.js');
  const drOk = fs.existsSync(drPath);
  add('darkreader', 'Dark Reader 引擎', false, drOk,
    drOk ? `已就位（${(fs.statSync(drPath).size / 1024).toFixed(0)} KB）` : '缺失',
    drOk ? null : '深色模式功能需要它。缺失时 tools/darkreader.js 会自动下载，'
      + '也可手工放入 vendor/darkreader.js。');

  const requiredFail = rows.filter((r) => r.required && !r.ok);
  const optionalFail = rows.filter((r) => !r.required && !r.ok);

  if (asJson) {
    say(JSON.stringify({
      ok: requiredFail.length === 0,
      rows,
      requiredFailed: requiredFail.length,
      optionalFailed: optionalFail.length,
    }, null, 2));
    if (requiredFail.length) process.exitCode = 1;
    return;
  }

  say(`${C.b}环境自检${C.x}`);
  say();
  for (const r of rows) {
    const mark = r.ok ? `${C.g}✓${C.x}` : (r.required ? `${C.r}✗${C.x}` : `${C.y}○${C.x}`);
    const tag = r.required ? '' : dim('（可选）');
    say(`  ${mark} ${r.label.padEnd(18)} ${r.detail} ${tag}`);
  }
  say();

  if (requiredFail.length) {
    say(`${C.r}必需组件缺失，无法运行：${C.x}`);
    for (const r of requiredFail) say(`  · ${r.hint}`);
    say();
    process.exitCode = 1;
    return;
  }

  say(`${C.g}必需组件齐全，可以用。${C.x}`);
  if (optionalFail.length) {
    say();
    say(dim('可选组件缺失（只影响对应功能）：'));
    for (const r of optionalFail) say(dim(`  · ${r.hint}`));
  }
  say();
  say(dim('下一步：'));
  say(dim('  node gen.js probe <exe> --deep    探测一个应用'));
  say(dim('  node gen.js new <name> --exe <exe>  生成 profile'));
  say(dim('  node gen.js build <name>          生成启动脚本'));
  if (wvOk) say(dim('  双击 ui/ui.cmd                    打开图形界面'));
}

// ─────────────────────────── help ───────────────────────────

function usage() {
  say(`
${C.b}no-glass-ele${C.x} —— 为任意 Electron 应用生成「去毛玻璃」启动脚本

${C.b}命令${C.x}
  ${C.c}probe${C.x} <exe> [--deep]          只读探测：Electron 版本、fuse 表、行为标记
  ${C.c}new${C.x}   <name> --exe <path>     probe + 模板 → profiles/<name>.json
  ${C.c}build${C.x} <name> | --all [--bundle]
                                   渲染 apps/<name>/ 下的启动器与 README
  ${C.c}list${C.x}                          列出 profiles 与探测状态
  ${C.c}doctor${C.x}                        校验 exe 存在性、端口冲突、fuse 与预设矛盾
  ${C.c}env${C.x}                           环境自检：Node / Python / pywebview / PowerShell

${C.b}后台会话${C.x}
  ${C.c}ps${C.x}                            列出运行中的注入会话（含外部启动的）
  ${C.c}stop${C.x} <id|profile|pid>         请求停止（优雅退出，**不关目标应用**）
                             加 --force 可强停「外部发现」的旧版注入器
  ${C.c}logs${C.x} <id|profile|pid> [-n N]  查看某会话的日志
  ${C.c}prune${C.x}                         清理已退出会话残留的注册项

${C.b}选项${C.x}
  --deep      深层探测：额外扫描 resources/*.asar 找行为标记
  --bundle    生成自包含版本（配置与样式内联，目录可单独拷走）
  --port <n>  new 时指定默认端口
  --json      probe / list / doctor / ps 输出 JSON（供 UI 调用，人类可读输出不变）

${C.b}说明${C.x}
  · 全程**不启动**目标应用做探测，只读 exe / asar 的字节。
  · **不遍历文件系统**：只读被点名的文件，目录读取仅限单个父目录。
  · 零依赖，Node 18+。
  · 停止是协作式的：注入器在 run/sessions/<id>.json 登记自己，
    stop 只放一个停止文件让它自己退出 —— 目标应用不受影响。
`);
}

// ─────────────────────────── main ───────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parse(argv.slice(1));

  switch (cmd) {
    case 'probe': return cmdProbe(args);
    case 'new': return cmdNew(args);
    case 'build': return cmdBuild(args);
    case 'list': case 'ls': return cmdList(args);
    case 'doctor': case 'check': return cmdDoctor(args);
    case 'env': return cmdEnv(args);
    case 'ps': case 'sessions': return cmdPs(args);
    case 'stop': return cmdStop(args);
    case 'logs': case 'log': return cmdLogs(args);
    case 'prune': return cmdPrune(args);
    case 'autostart': return cmdAutostart(args);
    case undefined: case '-h': case '--help': case 'help': return usage();
    default:
      bad(`未知命令: ${cmd}`);
      usage();
      process.exit(2);
  }
}

main();
