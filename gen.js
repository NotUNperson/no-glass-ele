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
  say(`${C.b}探测${C.x} ${abs}`);
  if (deep) say(dim('  （--deep：额外扫描 resources/app.asar 找行为标记）'));
  say();

  const t0 = Date.now();
  const pr = probe.probeExe(abs, { deep });
  const ms = Date.now() - t0;

  if (!pr.ok) { bad(pr.error); process.exit(1); }

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

  const c = probe.conclusions(pr);
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

function cmdList() {
  const names = listProfiles();
  if (!names.length) { say('（还没有 profile。用 `node gen.js new <name> --exe <path>` 创建）'); return; }

  // 先算出纯文本，再上色 —— 否则 ANSI 转义序列会破坏 padEnd 的宽度计算
  const rows = names.map((n) => {
    let p;
    try { p = loadProfile(n); } catch (e) { return { err: `${n}: ${e.message}` }; }
    const d = p.detected || {};
    const appDir = path.join(APPS_DIR, n);
    let cmds = 0;
    try { cmds = fs.readdirSync(appDir).filter((f) => f.endsWith('.cmd')).length; } catch { /* none */ }
    return {
      name: n,
      electron: String(d.electron || '?'),
      port: String(p.defaultPort || '?'),
      native: d.canUseNative === false ? '不可用' : d.canUseNative === true ? '可用' : '?',
      nativeTone: d.canUseNative === false ? 'r' : d.canUseNative === true ? 'g' : 'dim',
      glass: d.hasPageGlass === true ? '有' : d.hasPageGlass === false ? '未发现' : '?',
      glassTone: d.hasPageGlass === true ? 'g' : 'dim',
      cmds: cmds ? `${cmds} 个` : '未生成',
      cmdsTone: cmds ? 'plain' : 'dim',
    };
  });

  const bad_rows = rows.filter((r) => r.err);
  const good = rows.filter((r) => !r.err);

  // 按显示宽度对齐（中文按 2 列算）
  const w = (s) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
  const col = {
    name: Math.max(4, ...good.map((r) => w(r.name))) + 2,
    electron: Math.max(8, ...good.map((r) => w(r.electron))) + 2,
    port: Math.max(4, ...good.map((r) => w(r.port))) + 2,
    native: Math.max(6, ...good.map((r) => w(r.native))) + 2,
    glass: Math.max(8, ...good.map((r) => w(r.glass))) + 2,
  };
  const tone = (s, t) => (t === 'dim' ? dim(s) : t === 'g' ? `${C.g}${s}${C.x}` : t === 'r' ? `${C.r}${s}${C.x}` : s);

  say(`${C.b}profiles${C.x} ${dim(`(${names.length})`)}`);
  say();
  say(`  ${pad('名称', col.name)}${pad('Electron', col.electron)}${pad('端口', col.port)}${pad('native', col.native)}${pad('页面玻璃', col.glass)}启动器`);
  say(`  ${'-'.repeat(col.name + col.electron + col.port + col.native + col.glass + 10)}`);
  for (const r of good) {
    say(
      `  ${pad(r.name, col.name)}${pad(r.electron, col.electron)}${pad(r.port, col.port)}` +
        `${tone(pad(r.native, col.native), r.nativeTone)}${tone(pad(r.glass, col.glass), r.glassTone)}${tone(r.cmds, r.cmdsTone)}`
    );
  }
  for (const r of bad_rows) bad(r.err);
  say();
}

// ─────────────────────────── doctor ───────────────────────────

function cmdDoctor() {
  const names = listProfiles();
  if (!names.length) { say('（还没有 profile）'); return; }

  let problems = 0;
  const ports = new Map();

  say(`${C.b}校验 profiles${C.x}`);
  say();

  for (const n of names) {
    let p;
    try { p = loadProfile(n); } catch (e) { bad(`${n}: profile 解析失败 — ${e.message}`); problems++; continue; }

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
          const m = txt.match(/profile-fingerprint: ([0-9a-f]{12})/) ||
                    txt.match(/profile-fingerprint: `([0-9a-f]{12})`/);
          if (!m) { stale = true; break; }
          if (m[1] === wantFp) { found = true; break; }
        }
      } catch { /* ignore */ }
      if (stale) issues.push('生成产物缺少指纹（旧版本生成）→ 重新 build');
      else if (!found) issues.push('生成产物与当前 profile 不一致 → 重新 build');
    }

    if (issues.length) {
      say(`  ${C.y}${n}${C.x}`);
      for (const i of issues) say(`    ${C.y}!${C.x} ${i}`);
      problems += issues.length;
    } else {
      say(`  ${C.g}${n}${C.x} ${dim('无问题')}`);
    }
  }

  say();
  if (problems) {
    say(`${C.y}共 ${problems} 项待处理。${C.x}`);
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

${C.b}选项${C.x}
  --deep      深层探测：额外扫描 resources/app.asar 找行为标记
  --bundle    生成自包含版本（配置与样式内联，目录可单独拷走）
  --port <n>  new 时指定默认端口

${C.b}说明${C.x}
  · 全程**不启动**目标应用，只读 exe / asar 的字节。
  · **不遍历文件系统**：只读被点名的文件，目录读取仅限单个父目录。
  · 零依赖，Node 18+。
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
    case 'list': case 'ls': return cmdList();
    case 'doctor': case 'check': return cmdDoctor();
    case undefined: case '-h': case '--help': case 'help': return usage();
    default:
      bad(`未知命令: ${cmd}`);
      usage();
      process.exit(2);
  }
}

main();
