'use strict';
/**
 * autostart.js —— 开机自启动管理（Windows 启动文件夹 + profile 字段）
 *
 * 做法：启动文件夹里放**一个**固定的中转器快捷方式：
 *     pythonw.exe  "<repo>\ui\app.py"  --autostart-all
 * 它扫描 profiles/*.json 里 autostart.enabled 为真的那些，按字母序逐条拉起。
 *
 * 为什么不再"每个 profile 一个 .lnk"（曾经是这样）：
 *   · **状态只有一个来源**：哪些应用参与由 profile 决定，不再有"`.lnk` 在不在"
 *     与"profile 里怎么写"两份状态打架。
 *   · **没有参数转义问题**：`Arguments` 字段固定，不含用户内容。
 *     要自定义开机参数就改 profile（JSON 不需要转义）。
 *   · **开机负载错峰**：以前 N 个应用同时起来；现在逐条带间隔。
 *   · **失败隔离**：某个应用起不来只记日志，继续下一条。
 *
 * 为什么用启动文件夹而不是注册表 Run 键：
 *   启动文件夹是文件，看得见、好删、不需要写注册表，卸载干净。
 *   Run 键只在**冲突检测**时只读（应用自己注册了自启动，我们不知道就会撞单实例锁）。
 *
 * 冲突检测很重要：
 *   很多应用自己已经有自启动项。如果应用自己已经自启，我们再启一个会撞
 *   单实例锁 —— 所以 on 之前必须检查并警告。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_APP = path.join(ROOT, 'ui', 'app.py');
const PROFILES_DIR = path.join(ROOT, 'profiles');

/** 启动文件夹路径（用户级）。 */
function startupDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) throw new Error('读不到 %APPDATA%，无法定位启动文件夹。');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** 系统级启动文件夹（只读浏览用；写入需管理员，本工具不写）。 */
function systemStartupDir() {
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(pd, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** 旧式：每个 profile 一个快捷方式。现在只用于**清理**。 */
function lnkPath(profile) {
  return path.join(startupDir(), `no-glass · ${profile}.lnk`);
}

/** 新式：**唯一的**中转器快捷方式。 */
function relayLnkPath() {
  return path.join(startupDir(), 'no-glass · autostart.lnk');
}

/**
 * 找一个**真的能跑**的 pythonw.exe。
 *
 * 为什么不能只看 `where` 的第一条：
 *   用户机器上 `where pythonw` 可能返回多个（实测有 3 个），其中有的可能是
 *   商店版别名、失效的旧版本、或指向已卸载目录的符号链接。只看第一条 =
 *   赌它是对的。
 *
 * 判据为什么是"实测 -c"而不是文件大小：
 *   曾经以为 109 字节的那个是坏存根、应该按大小过滤 —— **实测证明那是错的**，
 *   它是微软 Python Manager 的合法别名，能正常执行并报告版本。
 *   唯一可靠的判据是真的跑一次 `pythonw -c "..."`。
 *
 * 顺序：
 *   1. 设置项 `pythonw` 是路径 → 用它（并校验能跑）
 *   2. 设置项是 ""（空串）→ 明确表示不用，返回 null
 *   3. `where pythonw` 的全部候选 → 逐个实测 → 第一个通过的胜出
 *   4. 已知安装位置兜底
 */
function findPythonw() {
  const settings = require('./settings');
  const configured = settings.read().pythonw;

  if (configured === '') return null;              // 明确表示不用 Python
  if (typeof configured === 'string' && configured) {
    return probePythonw(configured) ? configured : null;
  }

  const cands = [];
  try {
    const out = execFileSync('where', ['pythonw'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p) cands.push(p);
    }
  } catch { /* where 失败，走下面的兜底 */ }

  const la = process.env.LOCALAPPDATA || '';
  for (const v of ['Python314', 'Python313', 'Python312', 'Python311']) {
    cands.push(path.join(la, 'Programs', 'Python', v, 'pythonw.exe'));
  }

  for (const p of cands) {
    if (probePythonw(p)) return p;
  }
  return null;
}

/**
 * 实测一个 pythonw 能不能跑。返回 true/false。
 *
 * ⚠️ 不能用 `fs.existsSync()` 做前置判断（踩过）：
 *   Microsoft Store 的应用执行别名（`...\WindowsApps\pythonw.exe`）是一个
 *   指向受保护目录（`C:\Program Files\WindowsApps\...`）的符号链接。
 *   `statSync` 对它返回 **EACCES**，于是 `existsSync` 返回 **false** ——
 *   但它**实际完全可执行**（实测 172ms 跑出 3.14.3）。
 *   所以唯一可靠的判据是"真的跑一次"，执行失败才判定不可用。
 *
 * 超时给 8 秒（不是 3 秒）：`detectPythonw` 会连续探测多个候选，
 * 冷启动时（尤其开机初期）单个解释器启动可能超过 1 秒。
 * 3 秒实测会误判 —— 我踩过：连续探测 6 个候选时超时了，被误报成 ✗。
 */
function probePythonw(p) {
  if (!p) return false;
  try {
    const out = execFileSync(p, ['-c', 'import sys; print(sys.version.split()[0])'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    }).trim();
    return /^\d+\.\d+/.test(out);
  } catch {
    return false;
  }
}

/**
 * 列出所有候选并逐个实测（UI 的「检测」按钮用）。
 * 与 findPythonw 用同一套判据，保证"检测结果"与"实际会选哪个"一致。
 */
function detectPythonw() {
  const settings = require('./settings');
  const configured = settings.read().pythonw;

  const cands = [];
  try {
    const out = execFileSync('where', ['pythonw'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !cands.includes(p)) cands.push(p);
    }
  } catch { /* 忽略 */ }

  const la = process.env.LOCALAPPDATA || '';
  for (const v of ['Python314', 'Python313', 'Python312', 'Python311']) {
    const p = path.join(la, 'Programs', 'Python', v, 'pythonw.exe');
    if (!cands.includes(p)) cands.push(p);
  }

  // 手动指定的路径排在最前 —— 用户明确选它，优先探它（也顺带保证 selected 正确）
  if (typeof configured === 'string' && configured) {
    const i = cands.indexOf(configured);
    if (i > 0) { cands.splice(i, 1); cands.unshift(configured); }
    else if (i < 0) cands.unshift(configured);
  }

  const items = [];
  let selected = null;
  for (const p of cands) {
    // 注意：不预判 existsSync —— 商店版别名会因 EACCES 被误判为不存在，
    // 但它实际可执行。直接试跑，用结果说话（见 probePythonw 的注释）。
    let version = null;
    let ok = false;
    try {
      version = execFileSync(p, ['-c', 'import sys; print(sys.version.split()[0])'], {
        encoding: 'utf8', timeout: 8000, windowsHide: true,
      }).trim() || null;
      ok = !!version && /^\d+\.\d+/.test(version);
    } catch { ok = false; }
    // "会选哪个"与 findPythonw 同规则：手动指定优先
    const isSelected = configured
      ? (p === configured)
      : (ok && selected === null);
    if (isSelected) selected = p;
    items.push({ path: p, exists: ok, ok, version, selected: isSelected });
  }
  return { items, selected, configured };
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
 * 读启动文件夹里所有 .lnk 的 TargetPath / Arguments。
 *
 * 为什么要读这个：判断某个应用有没有自启动，光看 .lnk 的文件名会漏 ——
 * 而更关键的是**自启动命令行里往往带着应用私有的启动参数**
 * （例如 `Todo清单.exe --hidden` 表示"静默到托盘启动"）。
 * 那个参数正是我们启动应用时该补上的东西：不补，本该静默的应用会弹窗。
 *
 * 用 WScript.Shell COM 读（与创建时同一套 API，已实测可用）。
 */
/**
 * 读启动文件夹里所有 .lnk 的 TargetPath / Arguments。
 *
 * 为什么要读这个：判断某个应用有没有自启动，光看 .lnk 的文件名会漏 ——
 * 而更关键的是**自启动命令行里往往带着应用私有的启动参数**
 * （例如 `Todo清单.exe --hidden` 表示"静默到托盘启动"）。
 * 那个参数正是我们启动应用时该补上的东西：不补，本该静默的应用会弹窗。
 *
 * 实现走 readAutostartAllCached()（一次 PowerShell 读三处），不再单独起进程。
 */
function readStartupShortcuts() {
  return readAutostartAllCached().lnk;
}

/**
 * 拆出「应用私有的启动参数」——即那些不像 Chromium/Electron 通用开关的参数。
 *
 * 为什么要过滤：自启动命令行里可能混着 `--user-data-dir=...`、
 * `--remote-debugging-port=...` 这类通用开关，把它们当"应用私有参数"
 * 建议给用户是错的。这里只保留看起来是应用自己的（短横线开头且不在已知列表里）。
 */
const COMMON_FLAGS = [
  '--remote-debugging-port', '--inspect', '--user-data-dir', '--no-sandbox',
  '--disable-gpu', '--enable-logging', '--lang', '--proxy-server',
];

function appPrivateArgs(argString) {
  if (!argString) return [];
  // 简单分词：保留引号内的整体
  const parts = String(argString).match(/"[^"]*"|\S+/g) || [];
  const out = [];
  for (const raw of parts) {
    const a = raw.replace(/^"|"$/g, '');
    if (!a.startsWith('-')) continue;                       // 不是开关，跳过
    const name = a.split('=')[0];
    if (COMMON_FLAGS.includes(name)) continue;              // 通用开关，不算私有
    out.push(a);
  }
  return out;
}

/**
 * 找某个应用**自己**的自启动项，并带上它的启动命令行。
 *
 * 与 findExistingAutostart 的区别：
 *   · findExistingAutostart —— 判断"有没有冲突"，只看有没有命中（用于 autostart on 的护栏）
 *   · 本函数 —— 关心"它的启动参数是什么"，用于探测建议（把 --hidden 补进 appArgs）
 * 两者都排除本工具自己创建的项（以 `no-glass · ` 开头）。
 */
/**
 * 一次查出**多个应用**自己的自启动项（按 profile 名返回）。
 *
 * 为什么需要批量版（踩过）：
 *   `findAppAutostart` 单次调用要起一个 node + 一个 PowerShell，实测约 1.5 秒。
 *   前端每切换一次 profile 就查一次 —— 首次浏览 7 个应用就是 10 秒。
 *   批量版在**同一个 node 进程**里查完全部：PowerShell 只起 1 次
 *   （`readAutostartAllCached` 是进程级缓存），总耗时约等于单次。
 *
 * @param {Array<{name:string, exe:string, processName?:string}>} items
 * @returns {Object} name -> { hits, args }
 */
function findAppAutostartBatch(items) {
  const out = {};
  for (const it of (items || [])) {
    if (!it || !it.name) continue;
    try {
      const hits = findAppAutostart(it.exe, it.processName);
      const args = [...new Set(hits.flatMap((h) => h.args || []))];
      out[it.name] = { hits, args };
    } catch {
      out[it.name] = { hits: [], args: [] };
    }
  }
  return out;
}

function findAppAutostart(exePath, exeName) {
  const hits = [];
  const base = exeName || (exePath ? path.basename(exePath) : null);
  if (!base) return hits;
  const baseNoExt = base.toLowerCase().replace(/\.exe$/, '');
  const exeLower = exePath ? String(exePath).toLowerCase().replace(/\//g, '\\') : null;

  const matches = (s) => {
    if (!s) return false;
    const low = String(s).toLowerCase().replace(/\//g, '\\');
    if (low.includes(base.toLowerCase())) return true;
    if (exeLower && low.includes(exeLower)) return true;
    return false;
  };

  // 1) 启动文件夹的 .lnk（读 Target + Arguments）
  for (const sc of readStartupShortcuts()) {
    if (sc.file.startsWith('no-glass · ')) continue;         // 本工具自己的
    if (matches(sc.file) || matches(sc.target)) {
      hits.push({
        where: '启动文件夹',
        name: sc.file,
        target: sc.target,
        commandLine: `${sc.target} ${sc.args}`.trim(),
        args: appPrivateArgs(sc.args),
      });
    }
  }

  // 2) 注册表 Run 键（值本身就是完整命令行）
  for (const hive of ['HKCU', 'HKLM']) {
    for (const item of readRunKey(hive)) {
      if (!matches(item.value)) continue;
      // 从值里剥出 exe 路径之后的参数部分
      const v = item.value.trim();
      let rest = '';
      if (v.startsWith('"')) rest = v.slice(v.indexOf('"', 1) + 1).trim();
      else {
        const m = v.match(/^\S+\s+(.*)$/);
        rest = m ? m[1].trim() : '';
      }
      hits.push({
        where: `${hive}\\...\\Run`,
        name: item.name,
        commandLine: v,
        args: appPrivateArgs(rest),
      });
    }
  }

  return hits;
}

/**
 * 读一个注册表 Run 键下的所有值。
 *
 * 实现走 readAutostartAll()（一次 PowerShell 把三处自启动信息全读完）——
 * 单独读一处也要起一个 PowerShell，而那正是 doctor 慢的原因。
 * 想一次要三份数据就直接调 readAutostartAll()，别连调三次本函数。
 */
function readRunKey(hive) {
  const all = readAutostartAllCached();
  const h = String(hive).toUpperCase();
  if (h === 'HKCU') return all.hkcu;
  if (h === 'HKLM') return all.hklm;
  return [];
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
  //    用缓存里的 .lnk 清单（与「读注册表」共用同一次 PowerShell 调用）
  for (const sc of readAutostartAllCached().lnk) {
    const f = sc.file;
    if (f.startsWith('no-glass · ')) continue;      // 我们自己的项不算冲突
    if (f.toLowerCase().includes(baseNoExt)) {
      hits.push({ where: '启动文件夹', name: f, how: '文件名匹配' });
      continue;
    }
    if (valueMatches(sc.target) || valueMatches(sc.args)) {
      hits.push({ where: '启动文件夹', name: f, how: '目标匹配' });
    }
  }

  // 2) 注册表 Run 键（HKCU + HKLM）
  const all = readAutostartAllCached();
  for (const [hive, items] of [['HKCU', all.hkcu], ['HKLM', all.hklm]]) {
    for (const item of items) {
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

/**
 * 一次 PowerShell 调用读**全部**自启动信息（HKCU Run + HKLM Run + 启动文件夹 .lnk）。
 *
 * 为什么要合并：这三处原先各起一个 PowerShell，而 PowerShell 冷启动在 Windows 上
 * 是 0.3–1.5 秒（开机初期磁盘争抢时更慢）。doctor 每次都要读这三处，
 * 实测**单个 doctor 就要 4 秒**，其中绝大部分是三次进程启动的串行等待。
 * 合并成一次调用后同样的信息只需一次启动开销。
 *
 * 输出用段标记解析，避免三个来源的行混在一起分不清：
 *   @@HKCU@@ / @@HKLM@@ / @@LNK@@ 各占一行，之后跟着该段的记录。
 * 记录内部用 \t 分隔字段（Run 键是 name\tvalue，.lnk 是 path\ttarget\targs）。
 *
 * 读注册表为什么不用 `reg query`：它按控制台代码页（中文系统 GBK）输出，
 * 用 UTF-8 解码会乱码 —— `Todo清单` 这类中文名永远匹配不上，冲突检测静默失效。
 * PowerShell 里先设 [Console]::OutputEncoding 就没这问题。
 */
function readAutostartAll() {
  const out = { hkcu: [], hklm: [], lnk: [] };

  let dir = null;
  try { dir = startupDir(); } catch { /* 拿不到就跳过启动文件夹部分 */ }
  const lnkNames = (dir && fs.existsSync(dir))
    ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk'))
    : [];

  const q = (s) => String(s).replace(/'/g, "''");
  // 注意：块内**不能用 '; ' 拼接** —— 管道符 `|` 后面必须换行，
  // 拼成 `|; Where-Object` 会让 PowerShell 报 "不能使用空管道元素" 而整段失效
  // （实测踩过：注册表读回 0 项、冲突检测静默失灵）。所以用换行拼接。
  const runKeyBlock = (hive, marker) => [
    `'${marker}'`,
    `$k = '${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';`,
    'if (Test-Path $k) {',
    '  Get-ItemProperty -Path $k -ErrorAction SilentlyContinue |',
    '    ForEach-Object { $_.PSObject.Properties } |',
    "    Where-Object { $_.Name -notlike 'PS*' } |",
    "    ForEach-Object { \"$($_.Name)`t$($_.Value)\" }",
    '}',
  ].join('\n');

  const lnkBlock = lnkNames.length ? [
    "'@@LNK@@'",
    '$ws = New-Object -ComObject WScript.Shell;',
    `foreach ($p in @(${lnkNames.map((n) => `'${q(path.join(dir, n))}'`).join(',')})) {`,
    '  try {',
    '    $sc = $ws.CreateShortcut($p);',
    '    "$($p)`t$($sc.TargetPath)`t$($sc.Arguments)`t$($sc.WorkingDirectory)"',
    '  } catch { }',
    '}',
  ].join('\n') : '';

  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    runKeyBlock('HKCU', '@@HKCU@@'),
    runKeyBlock('HKLM', '@@HKLM@@'),
    lnkBlock,
  ].filter(Boolean).join('\n');

  try {
    const raw = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
    if (!raw) return out;

    let section = null;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t === '@@HKCU@@') { section = 'hkcu'; continue; }
      if (t === '@@HKLM@@') { section = 'hklm'; continue; }
      if (t === '@@LNK@@') { section = 'lnk'; continue; }
      if (!t || !section) continue;

      const parts = line.split('\t');
      if (section === 'lnk') {
        const [lnk, target, args, workdir] = parts;
        if (!lnk) continue;
        out.lnk.push({
          file: path.basename(lnk),
          lnk: lnk.trim(),
          target: (target || '').trim(),
          args: (args || '').trim(),
          workdir: (workdir || '').trim(),
        });
      } else {
        const idx = line.indexOf('\t');
        const name = (idx < 0 ? line : line.slice(0, idx)).trim();
        const value = idx < 0 ? '' : line.slice(idx + 1).trim();
        if (name) out[section].push({ name, value });
      }
    }
  } catch {
    return out;    // 读失败返回空集合（与旧实现一致：不抛错，只是没有自启动信息）
  }
  return out;
}

/**
 * readAutostartAll 的**进程内缓存**版本。
 *
 * 为什么要缓存：一个 doctor 进程里会有多次读自启动的需求（预读建索引、
 * 冲突检测……）。不缓存的话每次都要起 PowerShell —— 那正是 4 秒的来源。
 * 缓存只活在这一个进程里（CLI 一次性运行），不存在"数据过期"的问题。
 * 需要绕过缓存时用 readAutostartAll() 本体。
 */
let _autostartAllCache = null;
function readAutostartAllCached() {
  if (_autostartAllCache === null) _autostartAllCache = readAutostartAll();
  return _autostartAllCache;
}

/** 路径比较：绝对化 + 小写。Windows 上大小写与斜杠都不敏感。 */
function samePath(a, b) {
  try {
    return path.resolve(String(a)).toLowerCase()
      === path.resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 中转器快捷方式是否指向**当前这份仓库**。
 *
 * 快捷方式里存的是创建时的绝对路径，仓库搬家后不会自动更新。老目录还在
 * 时开机会静默启动老副本，而 UI/doctor 只看「.lnk 在不在」，发现不了。
 *
 * @returns {boolean|null} null = 参数读不到，无法判断
 */
function relayTargetsCurrentCopy(target, args, workdir) {
  const text = String(args || '').trim();
  if (!text) return null;
  const m = /^\s*"([^"]+)"/.exec(text) || /^\s*(\S+)/.exec(text);
  if (!m) return null;

  const script = m[1] || m[2];
  if (!samePath(script, UI_APP)) return false;
  // 工作目录为空时（旧式 .lnk）不据此判死，只看脚本路径。
  if (workdir && !samePath(workdir, ROOT)) return false;
  return true;
}

/**
 * 读中转器 .lnk 的实际属性（只读这一个文件，一次 PowerShell）。
 *
 * 与 readAutostartAll() 的区别：后者会把启动文件夹里**全部** .lnk 和
 * 注册表 Run 键一起读，约 1.5 秒；这里只回答「中转器指向哪」。
 */
function readRelayLnk() {
  let lnk;
  try { lnk = relayLnkPath(); } catch (e) { return { ok: false, error: e.message }; }

  const expectedArgs = `"${UI_APP}" --autostart-all`;
  if (!fs.existsSync(lnk)) {
    return {
      ok: true, exists: false, lnk,
      target: null, args: null, workdir: null,
      expectedArgs, current: null, stale: false,
    };
  }

  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$ws = New-Object -ComObject WScript.Shell;',
    `$sc = $ws.CreateShortcut('${q(lnk)}');`,
    '[pscustomobject]@{ target=$sc.TargetPath; args=$sc.Arguments; workdir=$sc.WorkingDirectory } | ConvertTo-Json -Compress',
  ].join(' ');

  let raw = '';
  try {
    raw = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
  } catch (e) {
    return {
      ok: false, exists: true, lnk,
      target: null, args: null, workdir: null,
      expectedArgs, current: null, stale: false,
      error: String(e.message || e).slice(0, 400),
    };
  }

  let j;
  try { j = JSON.parse(raw); } catch {
    return {
      ok: false, exists: true, lnk,
      target: null, args: null, workdir: null,
      expectedArgs, current: null, stale: false,
      error: '解析 WScript.Shell 输出失败',
    };
  }

  const target = String(j.target || '').trim();
  const args = String(j.args || '').trim();
  const workdir = String(j.workdir || '').trim();
  // 我们的中转器参数固定非空；.lnk 存在但 Arguments 为空，说明它不是
  // 我们创建的那个（或已被改坏），按 stale 处理。
  const current = args ? relayTargetsCurrentCopy(target, args, workdir) : false;
  return {
    ok: true, exists: true, lnk, target, args, workdir,
    expectedArgs, current, stale: current === false,
  };
}

/** 中转器是否指向别处。读不到详情时按「不判定」处理（返回 false）。 */
function relayIsStale(relay) {
  if (!relay || !relay.exists) return false;
  if (relay.current === true) return false;
  if (relay.current === false) return true;
  if (!relay.args) return false;
  return relayTargetsCurrentCopy(relay.target, relay.args, relay.workdir) === false;
}

/**
 * 列出本工具的自启动状态。
 *
 * 语义已改：不再"每个 profile 一个 .lnk"，而是**一个中转器 .lnk** +
 * 一组"哪些 profile 启用了"（记在各自 profile 的 autostart.enabled 里）。
 *
 * 返回：
 *   relay:   { exists, lnk, target, args, workdir, current, expectedArgs }
 *            —— current=false 表示快捷方式仍指向旧目录（仓库搬家后）
 *   enabled: [{ name, displayName, appArgs }] —— 启用了自启动的 profile
 *   legacy:  [{ profile, lnk, file }]       —— 旧式 per-profile 项（待清理）
 */
function listManaged(opts = {}) {
  const out = { relay: null, enabled: [], legacy: [] };
  const expectedArgs = `"${UI_APP}" --autostart-all`;

  // 中转器
  //
  // ⚠️ 默认**不读** .lnk 的 target/args（那要起 PowerShell）。
  // doctor 只需要知道"在不在"，而它在热路径上 —— 多一次 PowerShell
  // 就多约 1 秒（实测 doctor 从 1.4s 涨到 2.5s）。
  // 需要 target/args 时传 { withRelayDetail: true }。
  try {
    const rl = relayLnkPath();
    if (fs.existsSync(rl)) {
      let target = null, args = null, workdir = null, current = null;
      if (opts.withRelayDetail) {
        try {
          const all = readAutostartAllCached();
          const hit = all.lnk.find((x) => x.lnk === rl || x.file === path.basename(rl));
          target = hit ? hit.target : null;
          args = hit ? hit.args : null;
          workdir = hit ? (hit.workdir || null) : null;
          // hit 存在但 Arguments 为空 = 快捷方式坏了，按 stale 处理；
          // hit 不存在 = 没读到详情，留 null（不判定）。
          current = hit
            ? (args ? relayTargetsCurrentCopy(target, args, workdir) : false)
            : null;
        } catch { /* 读不到就留 null */ }
      }
      out.relay = { exists: true, lnk: rl, target, args, workdir, current, expectedArgs };
    } else {
      out.relay = {
        exists: false, lnk: rl, target: null, args: null,
        workdir: null, current: null, expectedArgs,
      };
    }
  } catch (e) {
    out.relay = {
      exists: false, error: e.message, lnk: null, target: null, args: null,
      workdir: null, current: null, expectedArgs,
    };
  }

  // 启用了自启动的 profile
  let dir;
  try { dir = PROFILES_DIR; } catch { /* 忽略 */ }
  if (dir && fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (p.autostart && p.autostart.enabled === true) {
          out.enabled.push({
            name: p.name || f.replace(/\.json$/, ''),
            displayName: p.displayName || p.name || f.replace(/\.json$/, ''),
            appArgs: effectiveAppArgs(p),
          });
        }
      } catch { /* 单个坏了跳过 */ }
    }
  }
  out.enabled.sort((a, b) => a.name.localeCompare(b.name));

  // 旧式 per-profile 项（迁移时要清掉，否则会重复启动）
  try {
    const sd = startupDir();
    if (fs.existsSync(sd)) {
      for (const f of fs.readdirSync(sd)) {
        if (!f.startsWith('no-glass · ') || !f.toLowerCase().endsWith('.lnk')) continue;
        if (f === path.basename(relayLnkPath())) continue;      // 中转器不算旧式
        out.legacy.push({
          profile: f.replace(/^no-glass · /, '').replace(/\.lnk$/, ''),
          lnk: path.join(sd, f),
          file: f,
        });
      }
    }
  } catch { /* 忽略 */ }

  return out;
}

/**
 * 自启动时**实际**会用的 app 参数。
 *
 * 规则（用户选定）：autostart.appArgs
 *   · 字段缺失（undefined/null）→ 回落到顶层 appArgs
 *   · []（空数组）           → 明确"无参数"，覆盖顶层
 *   · 非空数组                → 用它
 */
function effectiveAppArgs(profile) {
  const a = profile && profile.autostart ? profile.autostart.appArgs : undefined;
  if (a === undefined || a === null) return Array.isArray(profile.appArgs) ? [...profile.appArgs] : [];
  return Array.isArray(a) ? [...a] : [];
}

/** 两个参数数组是否不同（用于 doctor 的"参数不同"提示）。 */
function appArgsDiffer(profile) {
  const a = profile && profile.autostart ? profile.autostart.appArgs : undefined;
  if (a === undefined || a === null) return false;     // 没配置 = 回落到顶层，不算不同
  const top = Array.isArray(profile.appArgs) ? profile.appArgs : [];
  const own = Array.isArray(a) ? a : [];
  if (top.length !== own.length) return true;
  return top.some((v, i) => v !== own[i]);
}

/** 确保中转器 .lnk 存在（内容固定，不含用户参数）。 */
function ensureRelayLnk(opts = {}) {
  if (!fs.existsSync(UI_APP)) {
    return { ok: false, error: `找不到 ${UI_APP}` };
  }
  const py = opts.pythonw || findPythonw();
  if (!py) {
    return {
      ok: false,
      error: '找不到可用的 pythonw.exe。请确认 Python 已安装，'
        + '或在 UI 的「自启动运行器」里手动指定路径。',
    };
  }

  let lnk;
  try { lnk = relayLnkPath(); } catch (e) { return { ok: false, error: e.message }; }

  // 参数是**固定的**：不含任何用户内容，所以没有转义问题。
  const args = `"${UI_APP}" --autostart-all`;
  const r = createShortcut(lnk, py, args, ROOT,
    'no-glass-ele: 开机自启动（逐条拉起已启用的应用）');
  if (!r.ok) return { ok: false, error: r.error };

  return { ok: true, lnk, pythonw: py, args };
}

/** 删除中转器 .lnk。 */
function removeRelayLnk() {
  let lnk;
  try { lnk = relayLnkPath(); } catch (e) { return { ok: false, error: e.message }; }
  if (!fs.existsSync(lnk)) return { ok: true, lnk, already: true };
  try {
    fs.unlinkSync(lnk);
    return { ok: true, lnk };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 批量应用自启动改动（UI 的「保存设置」用）。
 *
 * 为什么需要批量版：`enable()` 每个 profile 要读一次文件、调一次
 * ensureRelayLnk（内部要探测 pythonw，实测约 1 秒），UI 里 7 个应用
 * 就是 7 次串行。这里只读一次、只确保一次中转器。
 *
 * 与 enable/disable 的差异：
 *   · 不做 findExistingAutostart 冲突检测 —— UI 侧本来就传 ignoreConflicts，
 *     而且那段要起 PowerShell（1.5 秒）。CLI 的 on/off 仍走 enable/disable。
 *   · 不逐个重建中转器：全部写完后再确保一次。
 *   · 失败不中断：单个 profile 坏了只记进 errors，其余照常应用。
 *
 * @param {Array<{name:string, enabled:boolean, appArgs:null|string[]}>} changes
 * @returns {{ok:boolean, applied:string[], errors:Array, relay?:object,
 *            anyEnabled:boolean, shouldPromptDelete:boolean, removedLegacy:string[]}}
 */
function applyBatch(changes) {
  const applied = [];
  const errors = [];
  const removedLegacy = [];

  for (const ch of Array.isArray(changes) ? changes : []) {
    const name = ch && ch.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      errors.push({ name: String(name), error: 'profile 名不合法' });
      continue;
    }
    const profPath = path.join(PROFILES_DIR, `${name}.json`);
    let prof;
    try {
      prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
    } catch (e) {
      errors.push({ name, error: `读取失败：${e.message}` });
      continue;
    }

    const au = (prof.autostart && typeof prof.autostart === 'object')
      ? { ...prof.autostart } : {};
    au.enabled = ch.enabled === true;

    // appArgs 三态：null = 继承顶层；[] = 明确无参数；[...] = 用它。
    // 没传这个键时保持原值不动（UI 只改 enabled 的场合）。
    if ('appArgs' in ch) {
      const a = ch.appArgs;
      if (a === null) delete au.appArgs;
      else if (Array.isArray(a)) au.appArgs = a.filter((x) => typeof x === 'string');
      else { errors.push({ name, error: 'appArgs 必须是数组或 null' }); continue; }
    }
    prof.autostart = au;

    try {
      fs.writeFileSync(profPath, JSON.stringify(prof, null, 2) + '\n', 'utf8');
    } catch (e) {
      errors.push({ name, error: `写入失败：${e.message}` });
      continue;
    }
    applied.push(name);

    // 旧式 per-profile .lnk 会与中转器重复启动 —— 只在启用时清
    if (au.enabled) {
      try {
        const old = lnkPath(name);
        if (fs.existsSync(old)) { fs.unlinkSync(old); removedLegacy.push(old); }
      } catch { /* 忽略：清不掉不影响主流程 */ }
    }
  }

  const anyEnabled = applied.some((n) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${n}.json`), 'utf8'));
      return !!(p.autostart && p.autostart.enabled === true);
    } catch { return false; }
  });

  let relay = null;
  if (anyEnabled) {
    const r = ensureRelayLnk({});
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        applied, errors, removedLegacy,
        anyEnabled: true,
        shouldPromptDelete: false,
      };
    }
    relay = { lnk: r.lnk, pythonw: r.pythonw, args: r.args };
  }

  const st = listManaged();
  return {
    ok: errors.length === 0,
    applied,
    errors,
    removedLegacy,
    relay,
    anyEnabled,
    shouldPromptDelete: !anyEnabled && !!(st.relay && st.relay.exists),
  };
}

/**
 * 打开一个 profile 的开机自启动（写 profile 字段 + 确保中转器存在）。
 *
 * 注意：**不再创建 per-profile .lnk**。参数也不写进快捷方式 ——
 * 用户要自定义开机参数就改 profile（见返回里的 profilePath 提示）。
 */
function enable(profileName, opts = {}) {
  const profPath = path.join(PROFILES_DIR, `${profileName}.json`);
  if (!fs.existsSync(profPath)) {
    return { ok: false, error: `profile 不存在：${profPath}` };
  }

  // 冲突检测：该应用自己是否已有自启动项？（保留原逻辑）
  if (opts.exe || opts.processName) {
    const conflicts = findExistingAutostart(opts.exe, opts.processName);
    if (conflicts.length && opts.ignoreConflicts !== true) {
      return {
        ok: false,
        conflict: true,
        conflicts,
        error: `检测到 ${conflicts.length} 个已有的自启动项指向这个应用。`,
      };
    }
  }

  // 写 profile
  let prof;
  try {
    prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `读取 profile 失败：${e.message}` };
  }
  prof.autostart = { ...(prof.autostart || {}), enabled: true };
  if (prof.autostart.appArgs === undefined) prof.autostart.appArgs = null;
  try {
    fs.writeFileSync(profPath, JSON.stringify(prof, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `写入 profile 失败：${e.message}` };
  }

  // 确保中转器
  const r = ensureRelayLnk(opts);
  if (!r.ok) return { ok: false, error: r.error };

  // 清理旧式 per-profile 项（否则会与中转器重复启动）
  const removed = [];
  try {
    const old = lnkPath(profileName);
    if (fs.existsSync(old)) { fs.unlinkSync(old); removed.push(old); }
  } catch { /* 忽略 */ }

  return {
    ok: true,
    profilePath: profPath,
    relay: r.lnk,
    pythonw: r.pythonw,
    args: r.args,
    removedLegacy: removed,
  };
}

/**
 * 关闭一个 profile 的开机自启动。
 *
 * 若关闭后**没有任何** profile 启用，返回 shouldPromptDelete: true，
 * 让调用方（CLI / UI）决定要不要删中转器 —— 这里不擅自删。
 */
function disable(profileName) {
  const profPath = path.join(PROFILES_DIR, `${profileName}.json`);
  if (!fs.existsSync(profPath)) {
    return { ok: false, error: `profile 不存在：${profPath}` };
  }

  let prof;
  try {
    prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `读取 profile 失败：${e.message}` };
  }
  prof.autostart = { ...(prof.autostart || {}), enabled: false };
  if (prof.autostart.appArgs === undefined) prof.autostart.appArgs = null;
  try {
    fs.writeFileSync(profPath, JSON.stringify(prof, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `写入 profile 失败：${e.message}` };
  }

  const st = listManaged();
  return {
    ok: true,
    profilePath: profPath,
    anyEnabled: st.enabled.length > 0,
    shouldPromptDelete: st.enabled.length === 0 && !!(st.relay && st.relay.exists),
  };
}

module.exports = {
  startupDir,
  systemStartupDir,
  lnkPath,
  relayLnkPath,
  findPythonw,
  probePythonw,
  detectPythonw,
  findExistingAutostart,
  findAppAutostart,
  findAppAutostartBatch,
  readAutostartAll,
  readAutostartAllCached,
  readStartupShortcuts,
  readRunKey,
  appPrivateArgs,
  effectiveAppArgs,
  appArgsDiffer,
  applyBatch,
  ensureRelayLnk,
  removeRelayLnk,
  readRelayLnk,
  relayIsStale,
  relayTargetsCurrentCopy,
  listManaged,
  enable,
  disable,
};
