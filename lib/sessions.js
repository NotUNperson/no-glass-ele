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

function ensureDirs() {
  for (const d of [SESS_DIR, LOG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ }
  }
}

/** 读磁盘上登记的会话。损坏的注册项会被跳过而不是抛错。 */
function listRegistered() {
  let files;
  try { files = fs.readdirSync(SESS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SESS_DIR, f);
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      meta.__file = p;
      meta.__stopFile = path.join(SESS_DIR, `${meta.id || f.replace(/\.json$/, '')}.stop`);
      meta.__logFile = path.join(LOG_DIR, `${meta.id || f.replace(/\.json$/, '')}.log`);
      meta.alive = isAlive(meta.pid);
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

/** 清理孤儿注册项（pid 已死但文件还在）。 */
function prune() {
  let removed = 0;
  for (const s of listRegistered()) {
    if (!s.alive) {
      try { fs.unlinkSync(s.__file); removed++; } catch { /* 忽略 */ }
      try { fs.unlinkSync(s.__stopFile); } catch { /* 忽略 */ }
    }
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
  forceKill,
  readLog,
  prune,
  isAlive,
};
