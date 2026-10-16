'use strict';
/**
 * sessions.js —— 注入会话的读取与停止请求
 *
 * 这是 `injector/noglass.js`、`gen.js`、`ui/app.py` 三方共用的**契约**。
 * 三处必须对同一套路径与字段达成一致，所以集中在这里定义一次。
 *
 * 磁盘布局：
 *   run/sessions/<id>.json   会话状态（注入器启动时写，退出时删）
 *   run/sessions/<id>.stop   停止请求（文件存在即请求停止）
 *   run/logs/<id>.log        该会话日志（注入器追加写）
 *
 * 为什么停止用「文件」而不是杀进程：
 *   注入器启动目标应用时虽然用了 detached，但 Windows 进程表里仍记录父子关系。
 *   用 taskkill /T 会顺进程树把目标应用一起杀掉 —— 那会关掉用户正在用的窗口。
 *   文件是协作式的：注入器自己优雅退出，目标应用不受影响。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN_DIR = path.join(ROOT, 'run');
const SESS_DIR = path.join(RUN_DIR, 'sessions');
const LOG_DIR = path.join(RUN_DIR, 'logs');

// ── 心跳判定的两个阈值 ──
//
// 必须与 ui/sessions.py 的 ZOMBIE_GRACE_SEC / ZOMBIE_STALE_SEC 保持一致，
// 否则 `gen.js ps` 与 UI 会对同一个会话给出不同结论（实测过这种不一致：
// 两边连存活判定机制都不同 —— JS 用 process.kill(pid,0)，Python 用
// OpenProcess）。改这里记得同步改那边。
const ZOMBIE_GRACE_SEC = 60.0;    // 启动宽限期：首次写心跳之前的窗口
const ZOMBIE_STALE_SEC = 90.0;    // 心跳过期：4.5 × 注入器的 20s 巡检间隔

/**
 * 同步睡眠。这个模块的接口是同步的（CLI 直接调），所以不能用 Promise
 * —— 事件循环在调用方返回前不会被调度，await 会永远等下去。
 * Atomics.wait 是同步阻塞的正确做法。与 gen.js 的同名实现一致。
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function ensureDirs() {
  for (const d of [SESS_DIR, LOG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ }
  }
}

/** 解析 ISO 时间戳；失败返回 null（字段缺失是常态，不抛错）。 */
function parseTs(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 判断注册项是否为「僵尸会话」—— 硬关机（或强杀）留下的残留。
 *
 * 为什么光看 pid 不够：注入器靠 process.on('exit') 与 SIGINT/SIGTERM 清
 * 注册项，但 Windows 关机**不派发信号**、exit 钩子也不跑，注册项就留在磁盘上。
 * 而 pid 存活判断只回答"这个 PID 有没有进程"，不回答"它是不是那个注入器"
 * —— 开机后 PID 被复用，残留项就被显示成「运行中」且关不掉。
 *
 * 判据（三条同时成立）：pid 存在 + 过了宽限期 + 心跳缺失或过期。
 * 与 ui/sessions.py 的 _is_zombie 逐条对应。
 */
function isZombie(meta, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const started = parseTs(meta && meta.startedAt);
  if (started === null) return false;
  if ((now - started) / 1000 < ZOMBIE_GRACE_SEC) return false;

  const tick = parseTs(meta && meta.lastTick);
  // 从未写过心跳：可能是非 watch 会话（不进巡检循环，压根不写）。
  // 那种情况下不能判它死。
  if (tick === null) return false;
  return (now - tick) / 1000 > ZOMBIE_STALE_SEC;
}

/** 读磁盘上登记的会话。损坏的注册项会被跳过而不是抛错。 */
function listRegistered() {
  let files;
  try { files = fs.readdirSync(SESS_DIR); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SESS_DIR, f);
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      meta.__file = p;
      meta.__stopFile = path.join(SESS_DIR, `${meta.id || f.replace(/\.json$/, '')}.stop`);
      meta.__logFile = path.join(LOG_DIR, `${meta.id || f.replace(/\.json$/, '')}.log`);
      meta.alive = isAlive(meta.pid);
      meta.zombie = meta.alive && isZombie(meta, now);
      out.push(meta);
    } catch { /* 半写入或损坏，跳过 */ }
  }
  return out.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但没权限（Windows 上少见），也算活着
    return e.code === 'EPERM';
  }
}

/**
 * 发现**没有登记**的注入器 —— 即旧版本启动的、或注册项被删掉的。
 * 走进程表查询（零文件系统遍历）。
 */
function discoverExternal() {
  if (process.platform !== 'win32') return [];
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" |',
    'Where-Object { $_.CommandLine -like "*noglass.js*" } |',
    'Select-Object ProcessId,ParentProcessId,CommandLine |',
    'ConvertTo-Json -Compress',
  ].join(' ');
  let raw = '';
  try {
    raw = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
  } catch { return []; }
  if (!raw) return [];

  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (data && !Array.isArray(data)) data = [data];

  return data.map((d) => {
    const cl = String(d.CommandLine || '');
    const profMatch = cl.match(/--profile\s+"?([^"\s]+)"?/);
    const portMatch = cl.match(/--port\s+(\d+)/);
    return {
      pid: d.ProcessId,
      parentPid: d.ParentProcessId,
      commandLine: cl,
      profilePath: profMatch ? profMatch[1] : null,
      profile: profMatch ? path.basename(profMatch[1], '.json') : null,
      port: portMatch ? Number(portMatch[1]) : null,
      // 与 ui/sessions.py 一致：没登记的注入器只能从命令行判断是否隔离。
      // 不判断的话，「外部起的隔离实例」会被当成普通会话限制按钮与守卫。
      isolate: /(^|\s)--isolate(\s|$)/.test(cl),
      external: true,
      alive: true,
      source: 'external',
    };
  });
}

/**
 * 合并「已登记」与「外部发现」，按 pid 去重。
 * 已登记的优先（它有更多字段）。
 */
function listAll() {
  const registered = listRegistered();
  const seen = new Set(registered.map((r) => r.pid));
  const external = discoverExternal().filter((e) => !seen.has(e.pid));
  return [...registered, ...external];
}

/** 请求停止：放一个停止文件。注入器会在 1 秒内发现并优雅退出。 */
function requestStop(id) {
  ensureDirs();
  const stopFile = path.join(SESS_DIR, `${id}.stop`);
  try {
    fs.writeFileSync(stopFile, `stop requested at ${new Date().toISOString()}\n`, 'utf8');
    return { ok: true, stopFile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 处理「点停止但没反应」的残留会话。**绝不对该 pid 发 kill。**
 *
 * 为什么不能 kill：残留项的 pid 可能**已经被系统复用给无关进程**
 * （这正是僵尸会话的成因）。对它 taskkill 会杀掉无辜进程。
 *
 * 做法是用 .stop 文件本身探活 —— 现成的、零风险的握手：
 *   写 .stop → 等一会儿 → 注册项消失 = 注入器活着并已退出（正常停止）
 *                        注册项仍在 = 注入器早没了，清掉残留项
 * 两种结果都不需要碰任何进程。与 ui/sessions.py 的 cleanup_residual 对应。
 *
 * 同步实现（Node 侧被 CLI 调用，没有 UI 那种不能阻塞的约束）。
 * 返回 { result, message }，result ∈ stopped | cleaned | missing | error
 */
function cleanupResidual(id, waitSec = 2.0) {
  const sessFile = path.join(SESS_DIR, `${id}.json`);
  if (!fs.existsSync(sessFile)) {
    return { result: 'missing', message: '该会话的注册项不存在（可能已被清理）。' };
  }
  const r = requestStop(id);
  if (!r.ok) return { result: 'error', message: `写入停止请求失败：${r.error}` };

  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(sessFile)) {
      return { result: 'stopped', message: '已请求停止，注入器已优雅退出。目标应用不受影响。' };
    }
    sleepSync(100);
  }

  const removed = [];
  for (const p of [sessFile, path.join(SESS_DIR, `${id}.stop`)]) {
    try { fs.unlinkSync(p); removed.push(path.basename(p)); } catch { /* 忽略 */ }
  }
  if (removed.length) {
    return {
      result: 'cleaned',
      message: `该注入器早已退出（注册项是硬关机留下的残留），已清理：${removed.join('、')}`,
    };
  }
  return { result: 'error', message: '残留项存在但删除失败（可能被占用）。' };
}

/**
 * 兜底强停：仅当优雅停止在超时内没生效时才用。
 *
 * **绝不用 /T。** /T 会顺进程树杀掉目标应用 —— 注入器启动应用时虽然
 * detached，但父子关系仍在进程表里，/T 会一路杀下去，把用户正在用的
 * 窗口一起关掉。这里只杀注入器自己的 PID。
 */
function forceKill(pid) {
  if (!pid) return { ok: false, error: '缺少 pid' };
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/F'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 读某会话的日志（tail 若干行）。 */
function readLog(id, lines = 200) {
  const p = path.join(LOG_DIR, `${id}.log`);
  try {
    const text = fs.readFileSync(p, 'utf8');
    const arr = text.split(/\r?\n/);
    return { ok: true, path: p, lines: arr.slice(-lines) };
  } catch (e) {
    return { ok: false, error: e.message, path: p };
  }
}

/**
 * 清理残留注册项。两类都清：
 *   · alive 为假      —— 进程真的没了
 *   · zombie 为真     —— pid 还在但心跳早停了（硬关机残留）
 *
 * 以前只清第一类，僵尸永远够不到（它不是 alive=false），
 * 于是每次硬关机都累积一个「关不掉的标签」。
 */
function prune() {
  let removed = 0;
  for (const s of listRegistered()) {
    if (s.alive && !s.zombie) continue;
    try { fs.unlinkSync(s.__file); removed++; } catch { /* 忽略 */ }
    try { fs.unlinkSync(s.__stopFile); } catch { /* 忽略 */ }
  }
  return removed;
}

module.exports = {
  RUN_DIR, SESS_DIR, LOG_DIR,
  ensureDirs,
  listRegistered,
  discoverExternal,
  listAll,
  requestStop,
  cleanupResidual,
  forceKill,
  readLog,
  prune,
  isAlive,
  isZombie,
};
