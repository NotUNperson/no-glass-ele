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
 *
 * 设计约束：
 *   · 只读静态探测，**绝不启动**目标应用。
 *   · **绝不遍历文件系统**。只读被点名的 exe，或 readdirSync 单个目录。
 *   · 零依赖（Node 18+）。
 */

const fs = require('fs');
const path = require('path');
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
    // 应用自带深色模式吗（决定要不要 darkreader / emulateColorScheme）
    prefersColorScheme: c.prefersColorScheme === undefined ? null : c.prefersColorScheme,
  };
  if (pr.deep && pr.deep.markers) d.markers = pr.deep.markers;
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
    if (deep) say(dim('  （--deep：额外扫描 resources/app.asar 找行为标记）'));
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
      electron: pr.electron, size: pr.size,
      fuses: pr.fuses, conclusions: c, warnings: pr.warnings,
      deep: pr.deep ? { asar: pr.deep.asar, asarName: pr.deep.asarName, asarSize: pr.deep.asarSize, markers: pr.deep.markers } : null,
      detected: toDetected(pr),
      suggested,
    }, null, 2));
    return;
  }

  say(`${C.b}文件${C.x}`);
  say(`  Electron      ${pr.electron || dim('(未识别)')}`);
  say(`  大小          ${(pr.size / 1024 / 1024).toFixed(1)} MB`);
  say();

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
  } else {
    say(`${C.y}fuse${C.x}  ${dim('未找到哨兵')}`);
  }
  say();

  say(`${C.b}结论${C.x}`);
  say(`  CSS 注入（主战场）  ${C.g}可用${C.x} ${dim('— --remote-debugging-port 不受任何 fuse 影响')}`);
  say(`  --native            ${c.canUseNative ? C.g + '可用' + C.x : C.r + '不可用' + C.x + dim(c.nativeBlockedBy ? ` — ${c.nativeBlockedBy} 已关闭` : '')}`);
  if (c.windowLayerGlass) {
    say(`  窗口层玻璃          ${C.y}有${C.x} ${dim('— ' + c.windowLayerReasons.join('；'))}`);
  } else if (pr.deep) {
    say(`  窗口层玻璃          ${C.dim}未发现${C.x}`);
  }
  if (pr.deep && pr.deep.markers) {
    say(`  页面内毛玻璃        ${c.hasPageGlass ? C.g + '有' + C.x : C.dim + '未在 asar 中找到' + C.x}`);
    say(`  单实例锁            ${c.singleInstance ? '有' : dim('未发现')}`);
    say(`  userData 被覆盖     ${c.userDataOverride ? C.y + '是' + C.x : dim('否')}`);
  }
  say();

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
    displayName: tpl.displayName || name,
    exe: abs,
    processName: path.basename(abs, '.exe'),
    styleId: `__noglass_${name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
    defaultPort: port,
    detected: toDetected(pr),
  };

  // 依据探测结果预填几个字段（只填有依据的）
  if (c.userDataOverride) {
    prof.notes = prof.notes || {};
    prof.notes.extra =
      '此应用覆盖了 userData 路径（见 detected.userDataOverride）。若需要 `--isolate`，' +
      '必须在 profile 的 isolateEnv 里填上该应用的私有开关，否则隔离不生效。';
  }
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
      external: !!s.external,
      logFile: s.__logFile || null,
      commandLine: s.commandLine || null,
    })),
    dead,
    registered: all.filter((s) => !s.external).length,
    external: all.filter((s) => s.external).length,
  };
}

function cmdPs(args) {
  const data = collectSessionData();
  if (args.flags.json === true) { say(JSON.stringify(data, null, 2)); return; }

  const live = data.sessions.filter((s) => s.alive);
  if (!live.length) {
    say('当前没有运行中的注入会话。');
    say(dim('  启动一个：node injector/noglass.js --profile profiles/<name>.json --launch --watch'));
    return;
  }

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

  if (data.dead.length) {
    say(`${C.y}${data.dead.length} 个注册项对应的进程已不存在${C.x}（运行 ${C.c}node gen.js ps --prune${C.x} 清理）`);
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
    const items = autostart.listManaged();
    if (args.flags.json === true) { say(JSON.stringify({ ok: true, items }, null, 2)); return; }
    if (!items.length) {
      say('没有由本工具创建的自启动项。');
      say(dim('  创建一个：node gen.js autostart on <profile>'));
      return;
    }
    say(`${C.b}本工具创建的自启动项${C.x} ${dim(`(${items.length})`)}`);
    say();
    for (const it of items) {
      say(`  ${C.b}${it.profile}${C.x}`);
      say(dim(`    ${it.lnk}`));
    }
    say();
    say(dim('  删除：node gen.js autostart off <profile>'));
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
      isolate: args.flags.isolate === true,
      ignoreConflicts: args.flags.force === true,
    });

    if (!r.ok && r.conflict) {
      wrn(`检测到该应用**已经**有自启动项：`);
      say();
      for (const c of r.conflicts) {
        say(`    ${C.y}${c.where}${C.x}  ${c.name}  ${dim(`(${c.how})`)}`);
      }
      say();
      say('这意味着开机后应用会自己启动一次，而我们的注入器也会再启动一次。');
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
      say(dim('  --force 会跳过这个检查，两个自启动项并存。'));
      process.exitCode = 1;
      return;
    }
    if (!r.ok) { bad(r.error); process.exit(1); }

    ok(`已创建自启动项：${r.lnk}`);
    say();
    say(`  指向      ${r.pythonw}`);
    say(`  参数      ${r.args}`);
    say();
    say(dim('  下次登录时自动拉起注入（无窗口，后台运行）。'));
    say(dim('  之后打开 UI 就能在会话列表里看到并管理它。'));
    return;
  }

  // ── off ──
  if (action === 'off') {
    const r = autostart.disable(name);
    if (!r.ok) { bad(r.error); process.exit(1); }
    ok(`已删除自启动项：${r.lnk}`);
    return;
  }

  bad(`未知动作：${action}（可用：on / off / list）`);
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

    // fuse 与预设矛盾
    const fuses = d.fuses && d.fuses.table;
    const inspectOk = !fuses || fuses.EnableNodeCliInspectArguments === 'on';
    if (!inspectOk && p.native && p.native.enabled === true) {
      issues.push('fuse 禁用了 --inspect，但 profile 里 native.enabled=true（--native 必然失败）');
    }

    // 隔离声明与 userData 覆盖矛盾
    if (d.userDataOverride === true && !p.isolateEnv) {
      issues.push('detected.userDataOverride=true，但未声明 isolateEnv → --isolate 不会生效（不会生成 start-isolated.cmd）');
    }

    // 探测陈旧
    if (d.probedAt) {
      const age = (Date.now() - new Date(d.probedAt).getTime()) / 86400000;
      if (age > 180) issues.push(`探测结果已 ${Math.round(age)} 天，应用可能已更新，建议重跑 probe`);
    }
    if (!d.fuses) issues.push('未探测到 fuse 表（可能是非 Electron 应用或裁剪构建）');

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
