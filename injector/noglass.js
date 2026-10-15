#!/usr/bin/env node
/**
 * noglass.js —— 通用 Electron 应用「去毛玻璃」注入器
 *
 * 零依赖（Node 18+，实测 Node 24）。走 Chrome DevTools Protocol。
 * 不改动目标应用的任何文件：全部通过调试协议在运行时注入。
 *
 * ── 原理 ────────────────────────────────────────────────────────────────
 * 毛玻璃可能来自两层，本工具处理第一层：
 *
 *   ① 渲染进程（页面内）：CSS 的 backdrop-filter。
 *      → 注入样式表清掉。这是本工具的主战场。
 *
 *   ② 主进程 + 系统（窗口层）：建窗时的 backgroundMaterial（Windows 亚克力）
 *      / vibrancy（macOS），配合刻意透明的外壳让系统模糊透上来。
 *      → CSS 管不到。用 --native 调 Electron API 处理，或去系统设置里
 *        关「透明效果」（设置 → 辅助功能 → 视觉效果）。
 *
 * ── 为什么必须"带参数启动"一次 ──────────────────────────────────────────
 *   Electron 的 --remote-debugging-port 只能在启动时传。
 *   所以要么用 --launch 启动，要么目标应用本来就有调试端口。
 *
 * ── 为什么 fuse 拦不住本工具 ────────────────────────────────────────────
 *   Electron 的 nodeCliInspect fuse 会禁掉 --inspect（以及 NODE_OPTIONS、
 *   ELECTRON_RUN_AS_NODE）。但 --remote-debugging-port 走的是 Chromium 的
 *   调试体系，不在该 fuse 的管辖范围内 —— 所以**页面注入对所有 Electron
 *   应用都可用**，包括加固过的。受影响的只有 --native（它依赖 --inspect）。
 *
 * 用法：
 *   node noglass.js --profile profiles/agenthub.json --launch --watch
 *   node noglass.js --exe <path> --process-name Foo --launch --watch
 *   node noglass.js --port 9333 --list
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HERE = __dirname;
const DEFAULT_PORT = 9333;
const DEFAULT_STYLE_ID = '__noglass__';
const POLL_MS = 400;          // 目标扫描间隔：越短，注入延迟越小
const NATIVE_EVERY = 25;      // watch 模式下约每 N 次扫描补一次窗口侧设置
const STOP_POLL_MS = 1000;    // 停止文件检查间隔
const LIVENESS_EVERY = 5;     // 每 N 次巡检做一次目标应用存活性检查

// ─────────────────────── 会话注册表（run/ 目录）───────────────────────
/**
 * 为什么要一个注册表：
 *   注入器是 detached 后台进程，启动它的人（UI / .cmd / 自启动项）未必一直活着。
 *   把会话状态落到磁盘上，任何一方都能看到「现在有哪些注入在跑」，也能请求停止。
 *
 * 文件布局（这就是与 gen.js / app.py 的契约，三处必须一致）：
 *   run/sessions/<id>.json   会话状态：pid/port/profile/exe/startedAt/source
 *   run/sessions/<id>.stop   停止请求：文件存在即请求停止
 *   run/logs/<id>.log        该会话日志（追加写）
 *
 * 为什么用「停止文件」而不是直接杀进程：
 *   注入器启动目标应用时虽然用了 detached，但 Windows 进程表里仍记录着父子关系。
 *   用 taskkill /T 会顺着进程树把目标应用一起杀掉 —— 那会关掉用户正在用的窗口。
 *   所以停止走协作式：请求方放一个文件，注入器自己优雅退出，目标应用不受影响。
 */
const RUN_DIR = path.join(HERE, '..', 'run');
const SESS_DIR = path.join(RUN_DIR, 'sessions');

// Dark Reader 引擎（可选功能，借它给「完全没有深色模式」的应用上深色）。
// 只有 profile 里开了 darkreader 才会读，读不到就跳过 —— 不因为缺文件而失败。
const DR_ENGINE = path.join(HERE, '..', 'vendor', 'darkreader.js');
const LOG_DIR = path.join(RUN_DIR, 'logs');

function ensureRunDirs() {
  for (const d of [SESS_DIR, LOG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在或无权限，后面写入时会报 */ }
  }
}

/** 会话 id：profile 名（已净化）+ pid，保证唯一且文件系统安全。 */
function makeSessionId(cfg) {
  const slug = String(cfg.profile.name || cfg.name || 'app').replace(/[^A-Za-z0-9._-]/g, '-');
  return `${slug}-${process.pid}`;
}

class SessionRegistry {
  constructor(cfg, opts = {}) {
    this.id = makeSessionId(cfg);
    this.file = path.join(SESS_DIR, `${this.id}.json`);
    this.stopFile = path.join(SESS_DIR, `${this.id}.stop`);
    this.logFile = path.join(LOG_DIR, `${this.id}.log`);
    this.active = false;
    this._logStream = null;
    this._meta = null;

    this.meta = {
      id: this.id,
      pid: process.pid,
      profile: cfg.profile.name || cfg.name,
      profilePath: cfg.profile.__path || null,
      displayName: cfg.profile.displayName || cfg.name,
      appName: cfg.name,
      processName: cfg.processName || null,
      exe: cfg.exe || null,
      port: cfg.port,
      inspectPort: cfg.inspectPort,
      watch: !!cfg.watch,
      isolate: !!cfg.isolate,
      native: !!cfg.native,
      css: cfg.css || null,
      cssExtra: cfg.cssExtra || null,
      emulateColorScheme: cfg.emulateColorScheme || null,
      // 深色方案状态：让 UI/CLI 能看出这个会话在用哪种
      darkreader: cfg.darkreader || null,
      darkreaderTheme: cfg.darkreaderTheme || null,
      startedAt: new Date().toISOString(),
      source: opts.source || 'cli',
    };
  }

  /** 写注册项并打开日志文件。失败不致命（只读目录等），只是失去可观测性。 */
  open() {
    try {
      ensureRunDirs();
      // 上一次的停止请求不应该影响这一次启动
      try { fs.unlinkSync(this.stopFile); } catch { /* 不存在是常态 */ }

      this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      fs.writeFileSync(this.file, JSON.stringify(this.meta, null, 2) + '\n', 'utf8');
      this.active = true;
      return true;
    } catch (e) {
      this.active = false;
      this.openError = e.message;
      return false;
    }
  }

  /** 追加一行日志（同时给控制台用；控制台由 log() 负责）。 */
  append(text) {
    if (!this.active || !this._logStream) return;
    try {
      this._logStream.write(text + '\n');
    } catch { /* 忽略写失败 */ }
  }

  /** 请求方是否要求停止。 */
  stopRequested() {
    try { return fs.existsSync(this.stopFile); } catch { return false; }
  }

  /** 更新注册项里的字段（如页面数变化）。 */
  update(patch) {
    if (!this.active) return;
    Object.assign(this.meta, patch);
    try { fs.writeFileSync(this.file, JSON.stringify(this.meta, null, 2) + '\n', 'utf8'); } catch { /* 忽略 */ }
  }

  /** 清理：删注册项与停止文件，关闭日志流。退出路径上必须调用。 */
  close() {
    if (!this.active) return;
    try { this._logStream && this._logStream.end(); } catch { /* 忽略 */ }
    try { fs.unlinkSync(this.file); } catch { /* 忽略 */ }
    try { fs.unlinkSync(this.stopFile); } catch { /* 忽略 */ }
    this.active = false;
  }
}

// ─────────────────────────── 参数 ───────────────────────────

/**
 * 读取 profile。profile 是 JSON，描述"这个应用是谁、怎么启动"。
 * 命令行参数优先级高于 profile。
 */
function loadProfile(p) {
  if (!p) return {};
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`profile 不存在: ${abs}`);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`profile 解析失败（${abs}）：${e.message}`);
  }
  return { __path: abs, __dir: path.dirname(abs), ...j };
}

function parseArgs(argv) {
  const o = {
    profile: null,
    port: null, inspectPort: null,
    launch: false, restart: false, native: false,
    watch: false, list: false, isolate: false,
    exe: null, css: null,
    dataDir: null, timeout: 45000,
    processName: null, styleId: null,
    displayName: null,
    quiet: false,
    source: 'cli',
    // 传给**目标应用**的额外参数（不是传给本注入器）。
    // 用途：Chromium 渲染开关，例如 --disable-lcd-text（强制灰度抗锯齿）、
    // --font-render-hinting=none。这些参数 Chromium 只在启动时读，所以要透传给应用。
    appArgs: [],
    // 传给本注入器的额外参数（由 --app-arg 之外的场景使用，如自启动脚本标记来源）
    emulateColorScheme: null,
    cssExtra: null,
    // Dark Reader：借它的引擎给「完全没有深色模式」的应用上深色。
    // 值 = 模式（auto / dark / light / off），false/null = 不用。
    darkreader: null,
    // Dark Reader 的主题参数（引擎、亮度、对比度…），见 resolveConfig。
    darkreaderTheme: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    switch (a) {
      case '--profile': o.profile = next(); break;
      case '--port': o.port = Number(next()); break;
      case '--inspect-port': o.inspectPort = Number(next()); break;
      case '--launch': o.launch = true; break;
      case '--restart': o.restart = true; o.launch = true; break;
      case '--native': o.native = true; break;
      case '--watch': o.watch = true; break;
      case '--list': o.list = true; break;
      case '--isolate': o.isolate = true; o.launch = true; break;
      case '--exe': o.exe = next(); break;
      case '--css': o.css = path.resolve(next()); break;
      case '--css-extra': o.cssExtra = path.resolve(next()); break;
      case '--data-dir': o.dataDir = path.resolve(next()); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--process-name': o.processName = next(); break;
      case '--style-id': o.styleId = next(); break;
      case '--name': o.displayName = next(); break;
      case '--emulate-color-scheme': o.emulateColorScheme = next(); break;
      case '--darkreader': o.darkreader = next(); break;
      case '--darkreader-engine': {
        const v = next();
        o.darkreaderTheme = { ...(o.darkreaderTheme || {}), engine: v };
        break;
      }
      case '--source': o.source = next(); break;
      case '-q': case '--quiet': o.quiet = true; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default:
        // --app-arg=<flag> / --app-arg <flag>：透传给目标应用
        if (a === '--app-arg') { o.appArgs.push(next()); break; }
        if (a.startsWith('--app-arg=')) { o.appArgs.push(a.slice('--app-arg='.length)); break; }
        if (a.startsWith('--')) {
          // 这里刻意不 exit(2)：以前的行为是「未知参数直接崩」，
          // 导致 `start.cmd --font-render-hinting=none` 把注入器打死而不是把参数交给应用。
          // 现在把不认识的参数当作「想传给目标应用」处理，并明确告知。
          o.appArgs.push(a);
          console.error(`[noglass] 未识别的参数 ${a} —— 按目标应用参数处理（等同 --app-arg=${a}）`);
          break;
        }
    }
  }
  return o;
}

/**
 * 合并 profile 与命令行，得到最终生效配置。
 * 命令行显式给出的值覆盖 profile。
 */
function resolveConfig(opts) {
  const prof = loadProfile(opts.profile);

  const name = opts.displayName || prof.displayName || prof.name || 'app';
  const profName = prof.name || null;
  const cfg = {
    profile: prof,
    name,
    processName: opts.processName || prof.processName || null,
    styleId: opts.styleId || prof.styleId || DEFAULT_STYLE_ID,
    port: opts.port != null ? opts.port : (prof.defaultPort || DEFAULT_PORT),
    inspectPort: opts.inspectPort,
    exe: opts.exe || prof.exe || null,
    exeGlob: prof.exeGlob || null,
    css: opts.css || (prof.css
      ? path.resolve(prof.__dir, prof.css)
      : path.join(HERE, '..', 'css', 'no-glass.css')),
    dataDir: opts.dataDir,
    launch: opts.launch, restart: opts.restart, native: opts.native,
    watch: opts.watch, list: opts.list, isolate: opts.isolate,
    timeout: opts.timeout,
    isolateEnv: prof.isolateEnv || null,
    dataDirEnv: prof.dataDirEnv || null,
    urlFilter: prof.urlFilter || null,
    nativeColors: prof.native || null,
    notes: prof.notes || {},
    appArgs: [...(prof.appArgs || []), ...(opts.appArgs || [])],
    emulateColorScheme: opts.emulateColorScheme || prof.emulateColorScheme || null,
    darkreader: opts.darkreader || prof.darkreader || null,
    // Dark Reader 的引擎与参数。engine 默认锁 dynamicTheme —— 这是效果最好的
    // 那种；filter 类引擎会把彩色图标/标签一起反掉（"颜色丢失"的来源）。
    darkreaderTheme: opts.darkreaderTheme || prof.darkreaderTheme || null,
    source: opts.source || 'cli',
    profileName: profName,
  };
  if (cfg.inspectPort == null) cfg.inspectPort = cfg.port + 1;

  // css 兜底：profile 没写、默认路径也不存在时，退回同目录
  if (!fs.existsSync(cfg.css)) {
    const alt = path.join(HERE, 'no-glass.css');
    if (fs.existsSync(alt)) cfg.css = alt;
  }

  // ── 自定义 CSS 片段（追加在内置样式表之后）──
  // 两条来源，后者优先：
  //   1. 约定文件 css/<profile名>.custom.css —— 无需配置，存在即生效
  //   2. profile.cssExtra / --css-extra 显式指定
  // 这样用户给「电脑端没有深色模式」的应用补样式时，不用改内置样式表，
  // 也不会因为工具升级覆盖掉自己的片段。
  cfg.cssExtra = null;
  if (opts.cssExtra) {
    cfg.cssExtra = opts.cssExtra;
  } else if (prof.cssExtra) {
    cfg.cssExtra = path.resolve(prof.__dir, prof.cssExtra);
  } else if (profName) {
    const conv = path.join(HERE, '..', 'css', `${profName}.custom.css`);
    if (fs.existsSync(conv)) cfg.cssExtra = conv;
  }

  if (cfg.isolate && !cfg.dataDir) {
    const slug = String(cfg.name).replace(/[^A-Za-z0-9._-]/g, '-');
    cfg.dataDir = path.join(os.tmpdir(), `noglass-${slug}-${process.pid}`);
  }
  return cfg;
}

/**
 * 拼出最终注入的 CSS：内置样式表 + （可选）自定义片段。
 * 中间插一行注释，便于在 DevTools 里看出分界。
 */
function composeCss(cfg) {
  let css = '';
  try { css = fs.readFileSync(cfg.css, 'utf8'); } catch { css = ''; }

  if (cfg.cssExtra && fs.existsSync(cfg.cssExtra)) {
    let extra = '';
    try { extra = fs.readFileSync(cfg.cssExtra, 'utf8'); } catch { extra = ''; }
    if (extra.trim()) {
      css += `\n\n/* ===== 以下是自定义片段：${path.basename(cfg.cssExtra)} ===== */\n` + extra;
    }
  }
  return css;
}

function printHelp() {
  console.log(`
noglass —— 给 Electron 应用注入「去毛玻璃」样式（通用版）

  --profile <path>  profile JSON（描述目标应用；命令行可覆盖其中字段）
  --launch          启动一个带调试端口的应用，然后注入
  --restart         先结束正在运行的应用，再按 --launch 启动（会打断当前会话）
  --native          连主进程：移除系统亚克力 + 把系统标题栏改成实色
                    需要应用未被 nodeCliInspect fuse 加固，否则会跳过
  --watch           常驻运行；刷新/新窗口自动重新注入（推荐）
  --list            列出可注入页面后退出
  --isolate         独立数据目录启动，不影响现有实例（含 --launch，便于测试）
  --port <n>        CDP 端口（默认取 profile，否则 ${DEFAULT_PORT}）
  --inspect-port <n> 主进程调试端口，配合 --native（默认 port+1）
  --exe <path>      目标应用 exe 路径（默认取 profile，否则自动探测）
  --css <path>      自定义样式表（默认 css/no-glass.css）
  --data-dir <path> 指定配置/数据目录
  --timeout <ms>    等待调试端口超时（默认 45000）
  --process-name <n> 进程名（用于探测/结束进程）
  --style-id <id>   注入的 <style> 元素 id（默认 ${DEFAULT_STYLE_ID}）
  --name <name>     日志中显示的应用名
  --css-extra <path> 追加的自定义样式片段（默认自动找 css/<profile>.custom.css）
  --emulate-color-scheme <dark|light>
                    让页面认为系统处于深色/浅色模式。
                    只对已写 @media (prefers-color-scheme: ...) 的应用有效。
  --darkreader <auto|dark|light|off>
                    借 Dark Reader 引擎上深色（读 vendor/darkreader.js）。
                    auto  = 跟随系统深浅色（推荐）
                    dark  = 强制深色
                    light = 强制浅色
                    同时会覆盖新开的窗口/弹窗。与自定义 CSS 可叠加，但**不建议**
                    （两份深色方案会互相干扰，见 README）。
  --darkreader-engine <name>
                    Dark Reader 的引擎（默认 dynamicTheme，效果最好）：
                    dynamicTheme / staticTheme / cssFilter / svgFilter
                    后两者是整页反色，会把彩色图标和标签一起反掉。
  --app-arg=<flag>  传给**目标应用**的额外参数（可重复）。
                    用于 Chromium 渲染开关，如 --disable-lcd-text（强制灰度抗锯齿）、
                    --font-render-hinting=none。
  --source <tag>    会话来源标记（写入注册表，如 ui / autostart）
  -q, --quiet       减少输出

会话注册表：
  注入器会在 run/sessions/<id>.json 登记自己，日志写到 run/logs/<id>.log。
  用 \`node gen.js ps\` 查看、\`node gen.js stop <id>\` 停止。
  停止是协作式的：注入器自己退出，**不会关掉目标应用**。
`);
}

// ─────────────────────────── 工具 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLoggers(cfg) {
  const prefix = `[noglass${cfg && cfg.name ? ':' + cfg.name : ''}]`;
  return {
    log: (m) => { if (!cfg || !cfg.quiet) console.log(`${prefix} ${m}`); },
    warn: (m) => console.warn(`${prefix} ${m}`),
  };
}

let log = () => {};
let warn = () => {};

async function fetchJson(url, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.ok ? await res.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function ps(command) {
  try {
    return execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 12000, windowsHide: true }).trim();
  } catch { return ''; }
}

const psCount = (processName) => {
  if (!processName) return 0;
  const safe = String(processName).replace(/['"`;]/g, '');
  return Number(ps(`@(Get-Process -Name '${safe}' -ErrorAction SilentlyContinue).Count`)) || 0;
};

/**
 * 解析 exe 路径。顺序：
 *   1. --exe / profile.exe
 *   2. profile.exeGlob（版本化目录，只 readdirSync 一个父目录）
 *   3. 从正在运行的进程读路径（零文件系统成本）
 *   4. 少量候选路径（existsSync）
 * 不做任何递归遍历。
 */
function resolveExe(cfg) {
  if (cfg.exe) {
    if (!fs.existsSync(cfg.exe)) throw new Error(`exe 不存在: ${cfg.exe}`);
    return cfg.exe;
  }
  if (cfg.exeGlob) {
    const roots = [cfg.profile.__dir, process.cwd(), 'C:\\', 'D:\\'];
    for (const r of roots) {
      const hit = tryGlob(r, cfg.exeGlob);
      if (hit) return hit;
    }
  }
  if (cfg.processName) {
    const safe = String(cfg.processName).replace(/['"`;]/g, '');
    const fromProc = ps(
      `(Get-Process -Name '${safe}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)`
    );
    if (fromProc && fs.existsSync(fromProc)) return fromProc;
  }
  return null;
}

function tryGlob(root, pattern) {
  const parts = String(pattern).split(/[\\/]/);
  if (parts.length < 2) return null;
  const fileName = parts[parts.length - 1];
  const dirPattern = parts.slice(0, -1).join(path.sep);
  const base = path.join(root, dirPattern.includes('*') ? '' : dirPattern);
  if (!fs.existsSync(base)) return null;
  if (!dirPattern.includes('*')) {
    const p = path.join(base, fileName);
    return fs.existsSync(p) ? p : null;
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dirRe = new RegExp('^' + dirPattern.split('*').map(esc).join('.*') + '$');
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory() && dirRe.test(e.name)).map((e) => e.name);
  const verOf = (s) => (s.match(/\d+(?:\.\d+)*/g) || ['0']).map(Number);
  dirs.sort((a, b) => {
    const va = verOf(a), vb = verOf(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] || 0) - (va[i] || 0);
      if (d) return d;
    }
    return b.localeCompare(a);
  });
  for (const d of dirs) {
    const p = path.join(base, d, fileName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ────────────────────────── CDP 客户端 ───────────────────────────

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl; this.nextId = 1;
    this.pending = new Map(); this.handlers = new Map();
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      ws.onclose = () => {
        this.closed = true;
        for (const { reject: rj } of this.pending.values()) rj(new Error('连接已关闭'));
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rj(new Error(m.error.message || 'CDP 错误')) : rs(m.result);
          return;
        }
        if (m.method && this.handlers.has(m.method)) {
          for (const h of this.handlers.get(m.method)) { try { h(m.params); } catch { /* ignore */ } }
        }
      };
    });
  }
  send(method, params = {}, timeoutMs = 12000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

// ────────────────────────── 注入脚本 ───────────────────────────

function buildInjectScript(css, styleId, appName) {
  return `(() => {
  const CSS_TEXT = ${JSON.stringify(css)};
  const ID = ${JSON.stringify(styleId)};
  const BY = ${JSON.stringify(appName)};
  function apply() {
    if (!document.documentElement) return false;
    let s = document.getElementById(ID);
    if (!s) {
      s = document.createElement('style');
      s.id = ID;
      s.setAttribute('data-by', BY);
      (document.head || document.documentElement).appendChild(s);
    }
    if (s.textContent !== CSS_TEXT) s.textContent = CSS_TEXT;
    return true;
  }
  if (!apply()) {
    const obs = new MutationObserver(() => { if (apply()) obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
    setTimeout(() => { apply(); obs.disconnect(); }, 2000);
  }
  window.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  return true;
})()`;
}

// ─────────── Dark Reader 注入脚本（可选功能）───────────

/**
 * 拼出 Dark Reader 的注入脚本。
 *
 * 为什么要拼成"先装引擎、再调 API"的一整段：
 * Page.addScriptToEvaluateOnNewDocument 只在页面**新文档诞生时**执行一次，
 * 所以这段必须自给自足 —— 不能依赖外面先跑过什么。
 * 每个新窗口/新页面都会重跑这段，于是弹窗也会被覆盖。
 *
 * 引擎只在页面里不存在时才整份注入（页面刷新后自然就没有了，
 * 会被重新注入，这是期望行为）。
 *
 * 关于四种引擎（Dark Reader 的 ThemeEngine 枚举，通过 theme.engine 指定）：
 *   dynamicTheme —— 动态解析样式表、逐条改写颜色。**效果最好**，默认。
 *   staticTheme  —— 预生成一套固定规则，不看页面实际样式。快但糙。
 *   cssFilter    —— 整页 filter: invert() 反色。会破坏图片/彩色图标。
 *   svgFilter    —— 同上但用 SVG 滤镜，可调项更多。
 * 你看到"标签颜色丢失"，通常是落到了 filter 类引擎（它会把彩色一起反掉）。
 * 所以这里默认锁死 dynamicTheme，并允许 profile 显式改。
 */
function buildDarkReaderScript(mode, engineSrc, themeOpts) {
  const OPTIONS = { brightness: 100, contrast: 100, sepia: 0, ...(themeOpts || {}) };
  const ensure = `if (typeof DarkReader === 'undefined') { ${engineSrc} }`;

  let action;
  if (mode === 'dark') {
    action = `DarkReader.auto(false); DarkReader.enable(${JSON.stringify(OPTIONS)});`;
  } else if (mode === 'light') {
    action = `DarkReader.auto(false); DarkReader.disable();`;
  } else {
    // auto：读 matchMedia('(prefers-color-scheme: dark)') 并监听其变化，
    // 所以系统切深浅色时页面会自己跟着变。
    action = `DarkReader.auto(${JSON.stringify(OPTIONS)});`;
  }

  return `(() => {
  try {
    ${ensure}
    ${action}
    return true;
  } catch (e) {
    // 深色失败不该影响去毛玻璃，所以吞掉异常只做记录
    try { console.warn('[noglass] Dark Reader 失败：' + (e && e.message)); } catch (_) {}
    return false;
  }
})()`;
}

function buildVerifyScript(styleId) {
  return `JSON.stringify((() => {
    let blurred = 0;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const v = cs.backdropFilter || cs.webkitBackdropFilter;
      if (v && v !== 'none') blurred++;
    }
    const root = document.documentElement, body = document.body;
    return {
      page: (location.pathname.split('/').pop() || 'index.html'),
      stillBlurred: blurred,
      styleTag: !!document.getElementById(${JSON.stringify(styleId)}),
      htmlBg: root ? getComputedStyle(root).backgroundColor : null,
      bodyBg: body ? getComputedStyle(body).backgroundColor : null
    };
  })())`;
}

// ─────────────── 页面会话：长连接 + 新文档即注入 ───────────────

/**
 * 每个 page 目标开一条独立长连接。
 * 为什么不关闭：Page.addScriptToEvaluateOnNewDocument 的注册
 * 只在该连接存活期间有效 —— 连接一断，页面刷新后注入就没了。
 * 所以会话必须保持打开，这也是 --watch 的价值所在。
 */
class PageSession {
  constructor(target, cfg) {
    this.target = target;
    this.cfg = cfg;
    this.cdp = null;
    this.dead = false;
    this.report = null;
    this._drSrc = null;
  }

  async start() {
    const cdp = new CDP(this.target.webSocketDebuggerUrl);
    await cdp.connect();
    this.cdp = cdp;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 配色方案模拟：让页面认为系统处于深色/浅色模式。
    // 只对**已经写了** @media (prefers-color-scheme: dark) 的应用有效 ——
    // 如果应用桌面版 CSS 里根本没有这段媒体查询，模拟不会产生任何变化，
    // 那种情况只能靠自定义 CSS 片段（css/<name>.custom.css）。
    if (this.cfg.emulateColorScheme) {
      try {
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: this.cfg.emulateColorScheme }],
        });
      } catch { /* 老版本不支持就算了，不致命 */ }
    }

    await this.applyCss();

    cdp.handlers.set('Page.frameNavigated', [() => {
      // 刷新/跳转后自动补一次（注册通常已覆盖，这是兜底）。
      // 注意：导航后 emulated media 会失效，所以要重新设置。
      if (this.cfg.emulateColorScheme) {
        cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: this.cfg.emulateColorScheme }],
        }).catch(() => {});
      }
      cdp.send('Runtime.evaluate', { expression: this._src, returnByValue: true }).catch(() => {});
      // Dark Reader 也补一次（注册已经管了，这里防的是"注册丢失"的边缘情况）
      if (this._drSrc) {
        cdp.send('Runtime.evaluate', { expression: this._drSrc, returnByValue: true }).catch(() => {});
      }
    }]);

    this.report = await this.verify();
    return this;
  }

  /** 注入当前 CSS（可重复调用 —— 热重载就靠它）。 */
  async applyCss() {
    if (!this.cdp || this.dead) return;
    const src = buildInjectScript(this.cfg.cssText, this.cfg.styleId, this.cfg.name);
    this._src = src;
    // Dark Reader（可选）：跟 CSS 一样走 addScriptToEvaluateOnNewDocument，
    // 这样**新开的窗口/弹窗**一诞生就带上深色，不用等下一次巡检。
    let drSrc = null;
    if (this.cfg.darkreaderSrc && this.cfg.darkreader) {
      drSrc = buildDarkReaderScript(this.cfg.darkreader, this.cfg.darkreaderSrc, this.cfg.darkreaderTheme);
      this._drSrc = drSrc;
    }
    // 持久化：此后每次导航/刷新都会先执行
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src, runImmediately: true });
    if (drSrc) {
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: drSrc, runImmediately: true });
    }
    // 立即对当前文档生效
    await this.cdp.send('Runtime.evaluate', { expression: src, returnByValue: true });
    if (drSrc) {
      await this.cdp.send('Runtime.evaluate', { expression: drSrc, returnByValue: true });
    }
  }

  async verify() {
    try {
      const r = await this.cdp.send('Runtime.evaluate', {
        expression: buildVerifyScript(this.cfg.styleId), returnByValue: true
      });
      const v = r.result && r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch { return null; }
  }

  close() { this.dead = true; if (this.cdp) this.cdp.close(); }
}

// ─────────────────── 窗口侧（主进程）：亚克力 + 标题栏 ───────────────────

/**
 * 用 CDP 连上主进程，调 Electron API 去掉系统亚克力。
 * 依赖 --inspect，因此会被 nodeCliInspect fuse 挡住 —— 调用方需先检查。
 */
async function fixNativeWindow(cfg) {
  const list = await fetchJson(`http://127.0.0.1:${cfg.inspectPort}/json/list`, 3000);
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, error: `主进程调试端口 ${cfg.inspectPort} 不可达（可能被 fuse 禁用，或未带 --inspect 启动）` };
  }
  const t = list.find((x) => x.webSocketDebuggerUrl);
  if (!t) return { ok: false, error: '主进程没有可用调试目标' };

  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    await cdp.send('Runtime.enable');
    // 主进程是 ESM（没有 require），Runtime.evaluate 里也没有动态 import 回调。
    // 可靠路径：process.getBuiltinModule('module') → createRequire(process.execPath) → 'electron'。
    const darkBg = (cfg.nativeColors && cfg.nativeColors.darkBg) || '#161616';
    const lightBg = (cfg.nativeColors && cfg.nativeColors.lightBg) || '#f8f8f8';
    const darkSym = (cfg.nativeColors && cfg.nativeColors.darkSymbol) || '#f5f5f5';
    const lightSym = (cfg.nativeColors && cfg.nativeColors.lightSymbol) || '#1f1f1f';
    const expr = `(() => {
      const out = { ok: false, windows: [], titleBar: [], error: null };
      try {
        const { createRequire } = process.getBuiltinModule('module');
        const electron = createRequire(process.execPath)('electron');
        const { BrowserWindow } = electron;
        if (!BrowserWindow) throw new Error('拿不到 BrowserWindow');
        const dark = !!(electron.nativeTheme && electron.nativeTheme.shouldUseDarkColors);
        const solid = dark ? ${JSON.stringify(darkBg)} : ${JSON.stringify(lightBg)};
        const sym = dark ? ${JSON.stringify(darkSym)} : ${JSON.stringify(lightSym)};
        const wins = BrowserWindow.getAllWindows();
        if (!wins.length) throw new Error('没有窗口');

        for (const w of wins) {
          const info = { id: w.id, material: null, color: null };
          try {
            if (typeof w.setBackgroundMaterial === 'function') {
              w.setBackgroundMaterial('none');
              info.material = 'none';
            } else info.material = 'no-api';
          } catch (e) { info.material = 'err: ' + e.message; }
          try { w.setBackgroundColor(solid); info.color = solid; }
          catch (e) { info.color = 'err: ' + e.message; }
          out.windows.push(info);

          // 标题栏覆盖层由系统绘制，CSS 够不到；应用常把它设成全透明，
          // 所以那条会露出亚克力。注意 Electron 只有 setter、没有 getter。
          const tb = { id: w.id, applied: false, err: null };
          try {
            if (typeof w.setTitleBarOverlay === 'function') {
              w.setTitleBarOverlay({ color: solid, symbolColor: sym });
              tb.applied = true;
            } else tb.err = 'no-api';
          } catch (e) { tb.err = e.message; }
          out.titleBar.push(tb);
        }
        out.ok = true;
      } catch (e) { out.error = e.message; }
      return JSON.stringify(out);
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = r.result && r.result.value;
    return (typeof v === 'string' ? JSON.parse(v) : v) || { ok: false, error: '无返回' };
  } finally { cdp.close(); }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const cfg = resolveConfig(opts);
  ({ log, warn } = makeLoggers(cfg));

  if (!fs.existsSync(cfg.css)) throw new Error(`样式表不存在: ${cfg.css}`);
  cfg.cssText = composeCss(cfg);

  // ── Dark Reader 引擎（可选）──
  // 注意顺序：必须在建 SessionRegistry **之前** 把 darkreaderTheme 的默认
  // 引擎补上，否则注册项里记的是 null，UI 会话标签显示不出引擎。
  // 读一次放内存，之后每个页面会话复用它。读不到就降级为"不用它"，
  // 不因为缺文件而让整个注入失败。
  cfg.darkreaderSrc = null;
  if (cfg.darkreader && cfg.darkreader !== 'off' && cfg.darkreader !== 'false') {
    try {
      cfg.darkreaderSrc = fs.readFileSync(DR_ENGINE, 'utf8');
      // 引擎锁死 dynamicTheme（作者标注效果最好）。filter 类引擎会把彩色
      // 图标/标签一起反色 —— 那正是"颜色丢失"的来源，所以默认不用。
      // 想换风格可在 profile 里写 darkreaderTheme.engine，或 --darkreader-engine。
      cfg.darkreaderTheme = { engine: 'dynamicTheme', ...(cfg.darkreaderTheme || {}) };
    } catch (e) {
      warn(`Dark Reader 引擎读取失败，已跳过：${e.message}`);
      warn(`  期望位置：${DR_ENGINE}`);
      cfg.darkreaderSrc = null;
    }
  }

  // 会话登记：让 UI / CLI / 自启动脚本都能看到这个后台注入器。
  // 登记失败不致命（可能目录只读），只是失去可观测性。
  const registry = new SessionRegistry(cfg, { source: cfg.source });
  if (registry.open()) {
    // 把日志同时写一份到 run/logs/<id>.log，供 UI 统一查看
    const origLog = log, origWarn = warn;
    log = (m) => { origLog(m); registry.append(`[noglass] ${m}`); };
    warn = (m) => { origWarn(m); registry.append(`[noglass] ${m}`); };
    log(`会话已登记：${registry.id}（run/sessions/${registry.id}.json）`);
  } else {
    warn(`会话登记失败（${registry.openError || '未知原因'}）—— 不影响注入，但 UI 里看不到它。`);
  }

  if (cfg.profile.__path) log(`profile: ${cfg.profile.__path}`);
  if (cfg.cssExtra) log(`自定义片段：${cfg.cssExtra}`);
  if (cfg.emulateColorScheme) log(`模拟配色方案：${cfg.emulateColorScheme}`);
  if (cfg.darkreaderSrc) {
    log(`Dark Reader 引擎已加载（${(cfg.darkreaderSrc.length / 1024).toFixed(0)} KB），模式：${cfg.darkreader}，引擎：${cfg.darkreaderTheme.engine}`);
    if (cfg.darkreader === 'auto') {
      log('  auto 模式会读 matchMedia(prefers-color-scheme)，跟随系统深浅色。');
    }
  }

  // 退出路径统一走这里，保证注册项被清理
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { registry.close(); } catch { /* 忽略 */ }
  };
  process.on('exit', cleanup);

  // 1) 端口上是否已有可用的 CDP
  let version = await fetchJson(`http://127.0.0.1:${cfg.port}/json/version`, 1500);
  if (version) {
    log(`发现已开启调试端口的应用：${version.Browser || 'Electron'}`);
  } else if (cfg.launch) {
    const exe = resolveExe(cfg);
    if (!exe) {
      throw new Error(
        `找不到 ${cfg.name} 的可执行文件。请用 --exe 指定路径，或在 profile 里填 exe / exeGlob。`
      );
    }
    const running = psCount(cfg.processName);
    if (running > 0 && !cfg.restart && !cfg.isolate) {
      warn(`检测到已有 ${running} 个 ${cfg.name} 进程，它们没有开启调试端口。`);
      warn('调试端口只能在启动时设置，因此注入需要「带参数重启」一次。');
      warn(`请先退出 ${cfg.name} 再重试，或用 --restart 代为重启（会打断当前会话），`);
      warn('或用 --isolate 跑独立实例。');
      cleanup();
      process.exit(3);
    }
    if (running > 0 && cfg.restart) {
      log(`结束现有 ${cfg.name} 进程…`);
      const safe = String(cfg.processName || '').replace(/['"`;]/g, '');
      if (safe) ps(`Stop-Process -Name '${safe}' -Force -ErrorAction SilentlyContinue`);
      await sleep(2500);
    }

    const args = [`--remote-debugging-port=${cfg.port}`, `--inspect=${cfg.inspectPort}`];
    const env = { ...process.env };
    if (cfg.isolate) {
      // 应用若在代码里覆盖了 userData，Electron 的默认目录就不生效，
      // 而单实例锁绑在 userData 上 —— 需要应用私有的开关让它退回默认值。
      if (cfg.isolateEnv) {
        for (const [k, v] of Object.entries(cfg.isolateEnv)) env[k] = v;
        log(`隔离开关：${Object.keys(cfg.isolateEnv).join(', ')}`);
      } else if (cfg.profile.detected && cfg.profile.detected.userDataOverride) {
        warn('此应用覆盖了 userData，但 profile 未声明 isolateEnv —— 隔离可能不生效。');
      }
      args.push(`--user-data-dir=${cfg.dataDir}`);
    } else if (cfg.dataDir) {
      if (cfg.dataDirEnv) env[cfg.dataDirEnv] = cfg.dataDir;
      else args.push(`--user-data-dir=${cfg.dataDir}`);
    }

    // 目标应用的额外参数（如 Chromium 字体渲染开关）。
    // 放在最后：Chromium 的参数解析对位置不敏感，但用户参数应能覆盖我们的默认。
    if (cfg.appArgs.length) {
      args.push(...cfg.appArgs);
      log(`目标应用参数：${cfg.appArgs.join(' ')}`);
    }

    log(`启动 ${cfg.name}：${exe}`);
    log(`  调试端口 ${cfg.port}，主进程端口 ${cfg.inspectPort}${cfg.dataDir ? `，数据目录 ${cfg.dataDir}` : ''}`);

    // 保留 spawn 句柄：应用被外部结束时要能感知（配合 browserCdp.onclose 与巡检兜底）
    let appProc = null;
    try {
      appProc = spawn(exe, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
      appProc.unref();
      appProc.on('error', (e) => warn(`启动应用出错：${e.message}`));
    } catch (e) {
      throw new Error(`启动 ${cfg.name} 失败：${e.message}`);
    }
    registry.update({ appPid: appProc ? appProc.pid : null });

    log('等待调试端口就绪…');
    const deadline = Date.now() + cfg.timeout;
    while (Date.now() < deadline) {
      version = await fetchJson(`http://127.0.0.1:${cfg.port}/json/version`, 2000);
      if (version && version.webSocketDebuggerUrl) break;
      // 应用可能在启动过程中就退出了（崩溃 / 单实例锁冲突）——不必等满超时
      if (appProc && appProc.exitCode !== null) {
        throw new Error(`应用在调试端口就绪前已退出（退出码 ${appProc.exitCode}）。`);
      }
      await sleep(400);
    }
    if (!version) throw new Error(`等待调试端口 ${cfg.port} 超时。`);
    log(`调试端口已就绪：${version.Browser || 'Electron'}`);
  } else {
    warn(`端口 ${cfg.port} 上没有调试端点。`);
    warn(`打包版默认不开放调试端口；请加 --launch，或用生成的启动脚本。`);
    cleanup();
    process.exit(3);
  }

  // 2) --list
  const fetchTargets = async () => {
    const list = await fetchJson(`http://127.0.0.1:${cfg.port}/json/list`, 4000);
    let targets = (Array.isArray(list) ? list : []).filter((t) =>
      t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') &&
      !String(t.url || '').startsWith('devtools://'));
    // urlFilter：只注入匹配的页面（正则），避免误伤内置浏览器里的第三方网页
    if (cfg.urlFilter) {
      let re;
      try { re = new RegExp(cfg.urlFilter); } catch { re = null; }
      if (re) targets = targets.filter((t) => re.test(String(t.url || '')));
    }
    return targets;
  };

  if (cfg.list) {
    const targets = await fetchTargets();
    log(`可注入页面共 ${targets.length} 个：`);
    for (const t of targets) log(`  · [${t.type}] ${t.title || '(无标题)'} — ${t.url}`);
    if (cfg.urlFilter) log(`（已应用 urlFilter: ${cfg.urlFilter}）`);
    return;
  }

  // 3) 会话维护
  const sessions = new Map(); // targetId -> PageSession
  let nativeLogged = false;

  async function sweep() {
    const targets = await fetchTargets();
    const live = new Set();
    let added = 0;

    for (const t of targets) {
      live.add(t.id);
      const cur = sessions.get(t.id);
      if (cur && !cur.dead) continue;           // 已接管且连接健在
      if (cur) sessions.delete(t.id);           // 连接已死，重建

      const s = new PageSession(t, cfg);
      try {
        await s.start();
        sessions.set(t.id, s);
        added++;
        const r = s.report;
        if (r) {
          const ok = r.stillBlurred === 0 && r.styleTag;
          log(`已注入 ${ok ? '✓' : '⚠'} ${r.page}  (仍带模糊元素: ${r.stillBlurred}, 样式表: ${r.styleTag ? '已挂载' : '缺失'})`);
        } else {
          log(`已注入 ${t.title || t.url}`);
        }
      } catch (e) {
        warn(`注入失败（${String(t.url).slice(0, 70)}）：${e.message}`);
        s.close();
      }
    }

    for (const [id, s] of [...sessions]) {
      if (!live.has(id) || s.dead) { s.close(); sessions.delete(id); }
    }
    return { count: targets.length, added };
  }

  // 4) 窗口侧设置（--native）
  async function applyNative() {
    if (!cfg.native) return;
    try {
      const r = await fixNativeWindow(cfg);
      if (r.ok && !nativeLogged) {
        log('窗口侧处理完成：');
        for (const w of r.windows) log(`    窗口 #${w.id}: backgroundMaterial=${w.material}, 背景色=${w.color}`);
        for (const tb of r.titleBar) log(`    标题栏 #${tb.id}: ${tb.applied ? '已改为实色' : '未处理(' + tb.err + ')'}`);
        nativeLogged = true;
      } else if (!r.ok && !nativeLogged) {
        warn(`窗口侧处理未完成：${r.error || '未知原因'}`);
        if (cfg.profile.detected && cfg.profile.detected.canUseNative === false) {
          warn('（此应用已被 fuse 禁用主进程调试，--native 预期不可用）');
        }
        warn('窗口层玻璃可在系统设置里关闭：设置 → 辅助功能 → 视觉效果 → 透明效果。');
        nativeLogged = true;
      }
    } catch (e) { if (!nativeLogged) { warn(`--native 失败：${e.message}`); nativeLogged = true; } }
  }

  log(`等待 ${cfg.name} 页面…`);
  let first = await sweep();
  // 页面是异步建的：给它一点时间出现
  for (let i = 0; i < 25 && first.count === 0; i++) { await sleep(400); first = await sweep(); }
  if (first.count === 0) warn('还没等到任何页面（窗口可能创建失败）。');

  await applyNative();

  // 5) 收尾 / watch
  if (!cfg.watch) {
    for (const s of sessions.values()) s.close();
    log(`完成，共处理 ${sessions.size} 个页面（调试连接已关闭）。`);
    log('注意：连接关闭后，注入只在当前页面生命周期内有效，刷新会失效。');
    log('如需刷新后仍生效，请加 --watch 常驻。');
    return;
  }

  log('进入 watch 模式（事件驱动 + 慢速兜底巡检）。Ctrl+C 退出。');

  // 先声明所有需要在 shutdown 里清理的句柄。
  // 必须在 shutdown 定义之前用 let 声明（而不是后面用 const）——
  // 否则 shutdown 在声明前被调用会踩到 TDZ，那是最难查的一类崩溃。
  let timer = null;
  let stopTimer = null;
  let cssWatcher = null;

  let eventsSeen = 0;
  const browserCdp = version.webSocketDebuggerUrl ? new CDP(version.webSocketDebuggerUrl) : null;
  if (browserCdp) {
    try {
      await browserCdp.connect();
      let pending = null;
      const kick = () => {
        // 合并短时间内的多个事件，避免连续创建窗口时重复扫描
        if (pending) return;
        pending = setTimeout(async () => {
          pending = null;
          try { await sweep(); } catch { /* ignore */ }
        }, 60);
      };
      browserCdp.handlers.set('Target.targetCreated', [(p) => {
        const t = p && p.targetInfo;
        if (t && (t.type === 'page' || t.type === 'webview')) { eventsSeen++; kick(); }
      }]);
      browserCdp.handlers.set('Target.targetDestroyed', [() => { kick(); }]);
      await browserCdp.send('Target.setDiscoverTargets', { discover: true });
      log('已启用目标事件订阅（新窗口即时注入）。');
    } catch (e) {
      warn(`目标事件订阅失败，退回轮询模式：${e.message}`);
      browserCdp.close();
    }
  } else {
    warn('浏览器级端点不可用，退回轮询模式。');
  }

  // ── 退出路径 ──
  let shuttingDown = false;
  const shutdown = (reason, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (timer) clearInterval(timer); } catch { /* 忽略 */ }
    try { if (stopTimer) clearInterval(stopTimer); } catch { /* 忽略 */ }
    try { if (cssWatcher) cssWatcher.close(); } catch { /* 忽略 */ }
    if (browserCdp) browserCdp.close();
    for (const s of sessions.values()) s.close();
    log(reason);
    cleanup();
    process.exit(code);
  };

  // ── 应用退出自感知 ──
  // 目标应用被关掉后，注入器必须自己退出，否则会留下一个空转的后台进程
  // （UI 里显示「运行中」、终端窗口不关）。
  // 主信号：浏览器级 CDP 连接断开 —— 应用进程死亡时它会关。
  if (browserCdp && !browserCdp.closed) {
    const origOnClose = browserCdp.ws.onclose;
    browserCdp.ws.onclose = (ev) => {
      try { origOnClose && origOnClose(ev); } catch { /* 忽略 */ }
      // 只有在 watch 期间断开才意味着应用没了；启动阶段由别处处理
      if (!shuttingDown) {
        setTimeout(() => {
          if (!shuttingDown) shutdown('目标应用已退出（调试连接断开），注入器随之退出。');
        }, 500);
      }
    };
  }

  // 兜底：有些情况下 websocket 不会立刻关（网络层缓冲等），
  // 所以再按进程名做一次低频存活检查。
  const canPollProcess = !!cfg.processName;
  if (!canPollProcess) {
    warn('profile 未设 processName，无法在应用退出后自动收尾（建议补上）。');
  }

  // ── CSS 热重载 ──
  // 改完样式不用重启应用：文件一变就重新读取并注入到所有页面。
  let reloadTimer = null;
  const watchTargets = [cfg.css, cfg.cssExtra].filter(Boolean);
  if (watchTargets.length) {
    try {
      cssWatcher = fs.watch(path.dirname(watchTargets[0]), (evt, fname) => {
        if (!fname) return;
        const hit = watchTargets.some((t) => path.basename(t) === fname.toString());
        if (!hit) return;
        // 编辑器保存往往触发多次事件，合并一下
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          try {
            cfg.cssText = composeCss(cfg);
            log('检测到样式表变更，正在重新注入…');
            for (const s of sessions.values()) {
              try { await s.applyCss(); } catch { /* 单个页面失败不影响其他 */ }
            }
            log(`已重新注入 ${sessions.size} 个页面。`);
          } catch (e) {
            warn(`重新注入失败：${e.message}`);
          }
        }, 250);
      });
      log('已启用样式热重载（改 CSS 后自动重新注入，无需重启应用）。');
    } catch (e) {
      warn(`样式热重载不可用：${e.message}`);
    }
  }

  // 慢速兜底：只用来修复意外（连接断开、事件丢失），不承担主要发现职责。
  const SAFETY_MS = browserCdp && !browserCdp.closed ? 20000 : POLL_MS;
  log(`兜底巡检间隔：${(SAFETY_MS / 1000).toFixed(1)}s`);
  let ticks = 0;
  timer = setInterval(async () => {
    ticks++;
    try { await sweep(); } catch { /* 忽略瞬时错误 */ }
    if (ticks % NATIVE_EVERY === 0) await applyNative();  // 应用主题/缩放变化会重设标题栏，定期补涂
    if (canPollProcess && ticks % LIVENESS_EVERY === 0) {
      // 进程数为 0 说明应用已经没了。给一点宽容度：应用重启瞬间也会是 0。
      const alive = psCount(cfg.processName);
      if (alive === 0) {
        registry.update({ lastSeenAlive: false });
        shutdown(`目标应用（${cfg.processName}）已退出，注入器随之退出。`);
      }
    }
    registry.update({ pages: sessions.size, lastTick: new Date().toISOString() });
  }, SAFETY_MS);

  // ── 停止请求轮询 ──
  // 用文件而不是信号/杀进程：请求方可能来自另一个进程（UI / CLI），
  // 而且这样注入器能自己收尾（清注册项、关日志），目标应用不受影响。
  stopTimer = setInterval(() => {
    if (registry.stopRequested()) {
      shutdown('收到停止请求，已优雅退出（目标应用保持运行）。');
    }
  }, STOP_POLL_MS);

  const onSignal = () => shutdown('收到中断信号，已退出。');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (require.main === module) {
  main().catch((e) => { console.error(`[noglass] 出错：${e.message}`); process.exit(1); });
}

module.exports = {
  main,
  resolveConfig,
  parseArgs,
  composeCss,
  buildInjectScript,
  buildVerifyScript,
  SessionRegistry,
  RUN_DIR,
  SESS_DIR,
  LOG_DIR,
};
