'use strict';
/**
 * autostart.js —— 自启动项管理（Windows 启动文件夹快捷方式）
 *
 * 做法：在用户启动文件夹放一个 .lnk，指向
 *     pythonw.exe  "<repo>\ui\app.py"  --headless --start <profile>
 *
 * 为什么绕一层 Python 而不直接指向 node.exe：
 *   pythonw.exe 是 GUI 子系统程序，没有控制台；它用 CREATE_NO_WINDOW 启动
 *   node.exe，所以不会闪出终端窗口。直接让 .lnk 指向 node.exe 的话，
 *   node 是控制台程序，会留下一个常驻的黑色终端窗口。
 *
 * 为什么用启动文件夹而不是注册表 Run 键：
 *   启动文件夹是文件，看得见、好删、不需要写注册表，卸载干净。
 *   用户机器上本来就有这个习惯（启动文件夹里已有多个 .lnk）。
 *
 * 冲突检测很重要：
 *   很多应用自己已经有自启动项（例如用户机器上
 *   HKCU\...\Run 的 com.eve.todolist 就指向 Todo清单.exe）。
 *   如果应用自己已经自启，我们再启一个会撞单实例锁 ——
 *   所以 on 之前必须检查并警告。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_APP = path.join(ROOT, 'ui', 'app.py');

/** 启动文件夹路径（用户级）。 */
function startupDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) throw new Error('读不到 %APPDATA%，无法定位启动文件夹。');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** 快捷方式文件名。用 profile 名保证一一对应。 */
function lnkPath(profile) {
  return path.join(startupDir(), `no-glass · ${profile}.lnk`);
}

/** 找一个可用的 pythonw.exe。优先 PATH，其次已知安装位置。 */
function findPythonw() {
  try {
    const out = execFileSync('where', ['pythonw'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    const first = out.split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* 继续找 */ }

  const la = process.env.LOCALAPPDATA || '';
  const cands = [];
  for (const v of ['Python314', 'Python313', 'Python312', 'Python311']) {
    cands.push(path.join(la, 'Programs', 'Python', v, 'pythonw.exe'));
  }
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** 用 PowerShell 的 WScript.Shell COM 创建 .lnk。 */
function createShortcut(lnk, target, args, workdir, description) {
  // 参数里的引号要转义成 PowerShell 能认的形式
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell;",
    `$sc = $ws.CreateShortcut('${q(lnk)}');`,
    `$sc.TargetPath = '${q(target)}';`,
    `$sc.Arguments = '${q(args)}';`,
    `$sc.WorkingDirectory = '${q(workdir)}';`,
    `$sc.Description = '${q(description)}';`,
    "$sc.WindowStyle = 7;",     // 7 = 最小化；配合 pythonw 实际不可见
    "$sc.Save();",
  ].join(' ');

  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).slice(0, 400) };
  }
}

/**
 * 读一个注册表 Run 键下的所有值。
 *
 * 为什么不用 `reg query`：它按控制台代码页（中文系统是 GBK）输出，
 * 用 UTF-8 解码会得到乱码 —— 于是 `Todo清单` 这类中文名字永远匹配不上，
 * 冲突检测静默失效。PowerShell 里先设 [Console]::OutputEncoding 就没这问题。
 */
function readRunKey(hive) {
  const key = `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    `$k = '${key}';`,
    'if (Test-Path $k) {',
    '  $item = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue;',
    '  $item.PSObject.Properties |',
    "    Where-Object { $_.Name -notlike 'PS*' } |",
    "    ForEach-Object { \"$($_.Name)`t$($_.Value)\" }",
    '}',
  ].join(' ');
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
    if (!out) return [];
    return out.split(/\r?\n/).map((line) => {
      const idx = line.indexOf('\t');
      if (idx < 0) return { name: line.trim(), value: '' };
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    }).filter((x) => x.name);
  } catch {
    return [];
  }
}

/**
 * 检查某个 exe 是否已经出现在系统的自启动配置里。
 *
 * 查三处：用户启动文件夹、HKCU Run、HKLM Run。
 * 这是只读检查，不改任何东西。
 *
 * 为什么要做这件事：很多应用自己就有自启动项。如果它自己会开机启动，
 * 我们的注入器再启动一次会撞单实例锁 —— 第二次启动直接退出，
 * 调试端口开不起来，注入静默失败。必须让用户先决定关掉哪一个。
 */
function findExistingAutostart(exePath, exeName) {
  const hits = [];
  const base = exeName || (exePath ? path.basename(exePath) : null);
  if (!base) return hits;

  const baseNoExt = base.toLowerCase().replace(/\.exe$/, '');
  const exeLower = exePath ? String(exePath).toLowerCase() : null;
  // 路径匹配时同时看正斜杠形式，避免分隔符差异导致漏判
  const exeAlt = exeLower ? exeLower.replace(/\//g, '\\') : null;

  const valueMatches = (v) => {
    if (!v) return false;
    const low = String(v).toLowerCase();
    if (low.includes(base.toLowerCase())) return true;
    if (exeLower && low.includes(exeLower)) return true;
    if (exeAlt && low.includes(exeAlt)) return true;
    return false;
  };

  // 1) 启动文件夹：快捷方式名字里带 exe 名，或指向该 exe
  try {
    const dir = startupDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.lnk')) continue;
        // 我们自己的项不算冲突
        if (f.startsWith('no-glass · ')) continue;
        if (f.toLowerCase().includes(baseNoExt)) {
          hits.push({ where: '启动文件夹', name: f, how: '文件名匹配' });
        }
      }
    }
  } catch { /* 忽略 */ }

  // 2) 注册表 Run 键（HKCU + HKLM）
  for (const hive of ['HKCU', 'HKLM']) {
    for (const item of readRunKey(hive)) {
      if (valueMatches(item.value)) {
        hits.push({
          where: `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`,
          name: item.name,
          how: '值匹配',
          value: item.value,
        });
      }
    }
  }

  return hits;
}

/** 列出本工具创建的所有自启动项。 */
function listManaged() {
  const out = [];
  let dir;
  try { dir = startupDir(); } catch { return out; }
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('no-glass · ') || !f.toLowerCase().endsWith('.lnk')) continue;
    const profile = f.replace(/^no-glass · /, '').replace(/\.lnk$/, '');
    out.push({ profile, lnk: path.join(dir, f), file: f });
  }
  return out;
}

/** 创建自启动项。 */
function enable(profile, opts = {}) {
  if (!fs.existsSync(UI_APP)) {
    return { ok: false, error: `找不到 ${UI_APP}` };
  }
  const py = findPythonw();
  if (!py) {
    return {
      ok: false,
      error: '找不到 pythonw.exe。请确认 Python 已安装并在 PATH 中。',
    };
  }

  // 冲突检测：该应用是否已经有别的自启动项？
  const conflicts = findExistingAutostart(opts.exe, opts.processName);
  if (conflicts.length && opts.ignoreConflicts !== true) {
    return {
      ok: false,
      conflict: true,
      conflicts,
      error: `检测到 ${conflicts.length} 个已有的自启动项指向这个应用。`,
    };
  }

  let lnk;
  try { lnk = lnkPath(profile); } catch (e) { return { ok: false, error: e.message }; }

  const args = `"${UI_APP}" --headless --start ${profile}${opts.isolate ? ' --isolate' : ''}`;
  const r = createShortcut(lnk, py, args, ROOT,
    `no-glass-ele: 启动 ${profile} 的注入（无窗口）`);
  if (!r.ok) return { ok: false, error: r.error };

  return { ok: true, lnk, pythonw: py, args };
}

/** 删除自启动项。 */
function disable(profile) {
  let lnk;
  try { lnk = lnkPath(profile); } catch (e) { return { ok: false, error: e.message }; }
  if (!fs.existsSync(lnk)) {
    return { ok: false, error: `自启动项不存在：${lnk}` };
  }
  try {
    fs.unlinkSync(lnk);
    return { ok: true, lnk };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  startupDir,
  lnkPath,
  findPythonw,
  findExistingAutostart,
  listManaged,
  enable,
  disable,
};
