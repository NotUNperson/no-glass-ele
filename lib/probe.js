'use strict';
/**
 * probe.js —— Electron 应用的**只读**静态探测
 *
 * 设计约束（重要）：
 *   1. 绝不启动目标应用。全部结论来自读文件字节。
 *   2. 绝不遍历文件系统。只读被点名的那个 exe；唯一允许的目录读取是
 *      `readdirSync` 单个父目录（用于版本化安装路径），不递归。
 *   3. exe 用分块流式扫描，不把整个文件读进内存（打包版 exe 常有 300MB+）。
 *      命中哨兵后立即停止读取。
 *
 * 为什么坚持这三条：git bash 下对大目录做递归遍历在 Windows 上极耗 CPU
 * （每个 stat 一次系统调用）。探测应该是"读一个文件"，不是"扫一片磁盘"。
 *
 * 能测出什么：
 *   · Electron 版本（exe 内的 UA 字符串）
 *   · fuse 表（exe 内的哨兵 + 状态字节）
 *   · 窗口层玻璃 / 单实例锁 / 自绘标题栏（需 --deep，读 app.asar）
 *
 * 测不出什么（诚实地留给人工）：
 *   · 运行时端口占用
 *   · 运行时是否真的启用了单实例锁（只看到代码里有调用）
 *   · 页面上到底有没有毛玻璃
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─────────────────────────── fuse ───────────────────────────

/** Electron fuse 的定位哨兵。见 @electron/fuses README。 */
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** 状态字节 → 可读状态。48/49 是 ASCII 的 '0'/'1'，114 是 'r'，144 是 INHERIT。 */
const FUSE_STATES = {
  0x30: 'off',       // '0'
  0x31: 'on',        // '1'
  0x72: 'removed',   // 'r'
  0x90: 'inherit',   // INHERIT，@electron/fuses 2.x 新增
};

/**
 * fuse 在线路上的顺序（按 Electron 加入的先后）。
 * 注意：不同 Electron 版本只写自己有的那几个，所以数组长度 = 该版本的 fuse 数量。
 * 8 个 = Electron 33~38 一代；9 个 = 41+（多了 WasmTrapHandlers）。
 */
const FUSE_ORDER = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

/** 每个 fuse 的默认值，用于判断"是否被加固过"。 */
const FUSE_DEFAULTS = {
  RunAsNode: true,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: true,
  EnableNodeCliInspectArguments: true,
  EnableEmbeddedAsarIntegrityValidation: false,
  OnlyLoadAppFromAsar: false,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true,
};

/**
 * 流式读取文件，在 8MB 分块中查找哨兵。命中即停。
 * @returns {{offset:number, buffer:Buffer}|null} 命中位置与该块内容
 */
function findSentinel(filePath, sentinel, maxBytes = 0) {
  const needle = Buffer.from(sentinel, 'latin1');
  const CHUNK = 8 * 1024 * 1024;
  const OVERLAP = needle.length - 1;
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const limit = maxBytes > 0 ? Math.min(size, maxBytes) : size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let tail = Buffer.alloc(0);

    while (pos < limit) {
      const want = Math.min(CHUNK, limit - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;

      // 把上一块的尾巴接上，避免哨兵正好跨块边界时漏掉
      const hay = tail.length ? Buffer.concat([tail, buf.subarray(0, got)]) : buf.subarray(0, got);
      const base = pos - tail.length;
      const idx = hay.indexOf(needle);
      if (idx !== -1) {
        // 命中：返回该位置起足够读完 fuse wire 的字节
        const start = base + idx;
        const need = needle.length + 2 + FUSE_ORDER.length + 8;
        const out = Buffer.allocUnsafe(need);
        const n = fs.readSync(fd, out, 0, need, start);
        return { offset: start, buffer: out.subarray(0, n) };
      }

      tail = Buffer.from(hay.subarray(Math.max(0, hay.length - OVERLAP)));
      pos += got;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读 fuse 表。
 * 格式：sentinel | version(1B) | count(1B) | count × state(1B)
 */
function readFuses(exePath) {
  let hit;
  try {
    hit = findSentinel(exePath, FUSE_SENTINEL);
  } catch (e) {
    return { ok: false, error: `读取 exe 失败：${e.message}` };
  }
  if (!hit) {
    return {
      ok: false,
      error: '未找到 fuse 哨兵 —— 不是 Electron 应用，或使用了裁剪/自定义构建。',
    };
  }

  const b = hit.buffer;
  const off = FUSE_SENTINEL.length;
  const version = b[off];
  const count = b[off + 1];

  if (count === undefined || count > 64) {
    return { ok: false, error: `fuse wire 长度异常（${count}），可能不是有效哨兵。` };
  }

  const fuses = {};
  const unknown = [];
  for (let i = 0; i < count; i++) {
    const raw = b[off + 2 + i];
    const state = FUSE_STATES[raw] || `0x${(raw || 0).toString(16)}`;
    const name = FUSE_ORDER[i] || `fuse${i}`;
    if (!FUSE_ORDER[i]) unknown.push(i);
    fuses[name] = state;
  }

  // 与默认值比较，找出被加固过的项
  const hardened = Object.keys(fuses).filter((k) => {
    const def = FUSE_DEFAULTS[k];
    if (def === undefined) return false;
    const actual = fuses[k] === 'on';
    return actual !== def;
  });

  return {
    ok: true,
    version,
    count,
    fuses,
    hardened,
    offset: hit.offset,
    unknownIndexes: unknown,
  };
}

// ─────────────────── Electron 版本 ───────────────────

/**
 * 从 exe 中提取 Electron 版本。
 * 用 UA 字符串 `Electron/41.0.3`。注意这是**运行时**版本，
 * 与 fuse 表长度可能不一致（例如 Chromium 的 UA 里也带 Electron 版本号）。
 */
function readElectronVersion(exePath) {
  const CHUNK = 8 * 1024 * 1024;
  const re = /Electron\/(\d+\.\d+\.\d+)/g;
  const fd = fs.openSync(exePath, 'r');
  const found = new Map();
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let tail = '';
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      const text = tail + buf.subarray(0, got).toString('latin1');
      let m;
      while ((m = re.exec(text))) found.set(m[1], (found.get(m[1]) || 0) + 1);
      tail = text.slice(-64);
      pos += got;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!found.size) return null;
  // 出现次数最多的那个最可信
  const sorted = [...found.entries()].sort((a, b) => b[1] - a[1]);
  return { version: sorted[0][0], all: [...found.keys()] };
}

// ─────────────────── asar 标记扫描（--deep）───────────────────

/**
 * 在 app.asar 里找决定启动行为的代码标记。
 *
 * 为什么扫 asar 而不是解包：asar 是简单拼接格式，内容以明文存在，
 * 直接搜字符串就够了，不需要解包（也就不会产生任何文件）。
 *
 * 注意：这是**启发式**判断 —— 命中说明代码里出现了这个调用，
 * 不等于运行时一定生效。README 里会明确标注为"需人工确认"。
 */
const ASAR_MARKERS = [
  {
    key: 'singleInstanceLock',
    needles: ['requestSingleInstanceLock'],
    question: '能否开第二个实例',
    meaning: '命中：应用有单实例锁 → 第二个实例会退出。启动注入前需先完全退出，或用隔离参数。',
  },
  {
    key: 'secondInstance',
    needles: ['second-instance'],
    question: '第二实例如何被处理',
    meaning: '命中：第二个实例会把参数转交老实例后自杀 → 端口不会开。',
  },
  {
    key: 'userDataOverride',
    needles: ['setPath("userData"', "setPath('userData'", 'setPath(`userData`'],
    question: 'userData 是否被应用覆盖',
    meaning: '命中：应用自己改了 userData 路径 → `--user-data-dir` 可能失效，隔离需应用私有开关（如 ZCode 的 ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA）。',
  },
  {
    key: 'transparent',
    needles: ['transparent: true', 'transparent:true'],
    question: '窗口是否透明（窗口层玻璃）',
    meaning: '命中：窗口是透明的 → 玻璃来自**窗口层**，CSS 管不到，需系统设置或 --native。',
  },
  {
    key: 'vibrancy',
    needles: ['vibrancy'],
    question: 'macOS 原生毛玻璃',
    meaning: '命中：用了 vibrancy（macOS 的亚克力）→ 窗口层玻璃。',
  },
  {
    key: 'backgroundMaterial',
    needles: ['backgroundMaterial'],
    question: 'Windows 系统亚克力',
    meaning: '命中：用了 backgroundMaterial（Windows 的亚克力）→ 窗口层玻璃，CSS 管不到。',
  },
  {
    key: 'titleBarOverlay',
    needles: ['setTitleBarOverlay'],
    question: '自绘标题栏覆盖层',
    meaning: '命中：标题栏由系统绘制且可能透明 → 需要 --native 才能改（CSS 够不到）。',
  },
  {
    key: 'frameless',
    needles: ['frame: false', 'frame:false'],
    question: '无边框窗口',
    meaning: '命中：无边框窗口，自绘标题栏。',
  },
  {
    key: 'backdropFilter',
    needles: ['backdrop-filter', 'backdropFilter'],
    question: '页面内毛玻璃',
    meaning: '命中：页面里用了 backdrop-filter → **CSS 注入有效**，这是本工具的主战场。',
  },
  {
    key: 'prefersColorScheme',
    needles: ['prefers-color-scheme'],
    question: '应用自带深色模式吗',
    meaning: '命中：写了 @media (prefers-color-scheme) → profile 里设 emulateColorScheme 就能让它跟随系统深浅色。未命中：应用没有深色模式，只能靠 darkreader 或手写 CSS。',
  },
];

/**
 * 在 asar 中搜索标记。
 * asar 头部是 JSON（文件表），之后是原始文件内容拼接。标记通常出现在
 * 内容区，所以整块搜即可；文件表里的路径名也可能命中（如文件名带 backdrop）。
 */
function scanAsar(asarPath) {
  const markers = {};
  let size;
  try {
    size = fs.statSync(asarPath).size;
  } catch (e) {
    return { ok: false, error: `无法读取 app.asar：${e.message}` };
  }

  const needleList = [];
  for (const m of ASAR_MARKERS) {
    for (const n of m.needles) needleList.push({ key: m.key, needle: Buffer.from(n, 'utf8') });
  }

  const CHUNK = 8 * 1024 * 1024;
  const MAX_NEEDLE = Math.max(...needleList.map((n) => n.needle.length));
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let tail = Buffer.alloc(0);
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      const hay = tail.length ? Buffer.concat([tail, buf.subarray(0, got)]) : buf.subarray(0, got);
      for (const { key, needle } of needleList) {
        if (hay.indexOf(needle) !== -1) markers[key] = true;
      }
      tail = Buffer.from(hay.subarray(Math.max(0, hay.length - (MAX_NEEDLE - 1))));
      pos += got;
    }
  } finally {
    fs.closeSync(fd);
  }

  // 补全 false，便于调用方直接读
  const out = {};
  for (const m of ASAR_MARKERS) out[m.key] = markers[m.key] === true;
  return { ok: true, markers: out, size };
}

// ─────────────────── exe 发现（零遍历）───────────────────

function ps(command) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 12000, windowsHide: true }
    ).trim();
  } catch {
    return '';
  }
}

/**
 * 从**正在运行的进程**里读 exe 路径。这是零文件系统成本的发现方式
 * （走 Windows 的进程表，不扫盘）。
 */
function exeFromProcess(processName) {
  if (!processName) return null;
  const safe = String(processName).replace(/['"`;]/g, '');
  const out = ps(
    `(Get-Process -Name '${safe}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)`
  );
  return out && fs.existsSync(out) ? out : null;
}

/**
 * 解析 `exeGlob`：形如 `app-*\\App.exe`。
 * 只 readdirSync **一个**父目录，按版本号取最高。不递归。
 */
function resolveExeGlob(rootDir, pattern) {
  const parts = pattern.split(/[\\/]/);
  if (parts.length < 2) return null;
  const fileName = parts[parts.length - 1];
  const dirPattern = parts.slice(0, -1).join(path.sep);

  if (!dirPattern.includes('*')) {
    const p = path.join(rootDir, dirPattern, fileName);
    return fs.existsSync(p) ? p : null;
  }

  // 只允许"最后一段目录"带通配，且必须是 app-* / 版本目录 这类形态
  const dirRe = new RegExp(
    '^' + dirPattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
  );
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory() && dirRe.test(e.name)).map((e) => e.name);

  // 版本号排序：取最高的那个
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
    const p = path.join(rootDir, d, fileName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─────────────────── 顶层探测 ───────────────────

/**
 * 对一个 exe 做完整静态探测。
 * @param {string} exePath
 * @param {{deep?:boolean}} opts
 */
function probeExe(exePath, opts = {}) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, error: `exe 不存在：${exePath}` };
  }

  const result = {
    ok: true,
    exe: exePath,
    size: fs.statSync(exePath).size,
    fuses: null,
    electron: null,
    deep: null,
    warnings: [],
  };

  // fuse
  const fuseRes = readFuses(exePath);
  if (fuseRes.ok) {
    result.fuses = {
      version: fuseRes.version,
      count: fuseRes.count,
      table: fuseRes.fuses,
      hardened: fuseRes.hardened,
      offset: fuseRes.offset,
    };
  } else {
    result.warnings.push(fuseRes.error);
  }

  // Electron 版本
  const ev = readElectronVersion(exePath);
  if (ev) result.electron = ev.version;
  else result.warnings.push('未能从 exe 中识别 Electron 版本。');

  // 一致性检查：fuse 数量应随 Electron 大版本递增
  if (result.electron && result.fuses) {
    const major = Number(result.electron.split('.')[0]);
    const expect9 = major >= 39;   // WasmTrapHandlers 约在 39+ 出现
    if (expect9 && result.fuses.count === 8) {
      result.warnings.push(
        `Electron ${result.electron} 却只有 8 个 fuse（预期 9）。可能 fuse 表被自定义过，或版本串与实际运行时不一致。`
      );
    }
  }

  // 深层：asar 标记
  if (opts.deep) {
    result.deep = deepScan(path.dirname(exePath), result.warnings);
  }

  return result;
}

/**
 * 选一个"最可能有应用代码"的 asar 来扫。
 *
 * 为什么不能只认 resources/app.asar：有些应用把它当加载器存根
 * （Obsidian 的 app.asar 只有 71KB，真实代码在 obsidian.asar），
 * 只扫 app.asar 会得出"没有毛玻璃"的**假阴性**。
 *
 * 做法：readdirSync 一次 resources/（**单个目录，不递归**），
 * 在候选 asar 里挑最大的那个。
 */
function pickAsarResources(appDir) {
  const resDir = path.join(appDir, 'resources');
  let entries;
  try {
    entries = fs.readdirSync(resDir, { withFileTypes: true });
  } catch {
    return { resDir, candidates: [], unpacked: false };
  }

  const candidates = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.asar')) {
      const p = path.join(resDir, e.name);
      try { candidates.push({ path: p, size: fs.statSync(p).size, name: e.name }); } catch { /* skip */ }
    }
  }
  candidates.sort((a, b) => b.size - a.size);

  let unpacked = false;
  try { unpacked = fs.statSync(path.join(resDir, 'app')).isDirectory(); } catch { /* not unpacked */ }

  return { resDir, candidates, unpacked };
}

/** 在候选 asar 上跑标记扫描，挑出信息量最大的那个。 */
function deepScan(appDir, warnings) {
  const { candidates, unpacked } = pickAsarResources(appDir);

  if (!candidates.length) {
    if (unpacked) {
      warnings.push(
        `未找到任何 .asar，但存在解包目录 resources/app。标记扫描需要 asar；此项跳过，` +
        `页面玻璃与单实例锁均标记为"未知（需人工确认）"。`
      );
      return { asar: null, unpacked: true, markers: null };
    }
    warnings.push('未找到 resources/*.asar，跳过标记扫描。');
    return null;
  }

  // 按大小从大到小试，第一个扫出关键标记的就用它
  const KEY = ['backdropFilter', 'singleInstanceLock', 'backgroundMaterial', 'transparent'];
  let best = null;
  for (const c of candidates) {
    const s = scanAsar(c.path);
    if (!s.ok) { warnings.push(s.error); continue; }
    const score = KEY.filter((k) => s.markers[k]).length;
    if (!best || score > best.score) best = { ...s, score, chosen: c };
    if (score === KEY.length) break;   // 全都命中，不用再找
  }

  if (!best) return null;

  // 挑中的不是 app.asar 时要说清楚，避免读者以为扫的是默认文件
  if (best.chosen.name !== 'app.asar') {
    warnings.push(
      `app.asar 不是应用主体；实际扫描的是 ${best.chosen.name}（${(best.chosen.size / 1024 / 1024).toFixed(1)} MB）。` +
      `候选共 ${candidates.length} 个 asar。`
    );
  }
  if (candidates.length > 1 && best.chosen.name === 'app.asar' && best.chosen.size < 1024 * 1024) {
    warnings.push(
      `app.asar 只有 ${(best.chosen.size / 1024).toFixed(0)} KB，可能是加载器存根。` +
      `扫描结果可能不完整。`
    );
  }

  return {
    asar: best.chosen.path,
    asarName: best.chosen.name,
    markers: best.markers,
    asarSize: best.chosen.size,
    asarCandidates: candidates.map((c) => c.name),
  };
}

/**
 * 把探测结果转成对启动有意义的**结论**（而非原始数据）。
 * 这是给 render.js 和 doctor 用的判断层。
 */
function conclusions(probe) {
  if (!probe.ok) return { ok: false, error: probe.error };
  const f = probe.fuses ? probe.fuses.table : null;
  // 注意：deep 存在但 markers 为 null，表示"探测了但没扫到 asar"——
  // 这与"扫了但没找到标记"是两回事，不能混为一谈（前者是未知，后者是"没有"）。
  const scanned = !!(probe.deep && probe.deep.markers);
  const d = scanned ? probe.deep.markers : null;

  const c = {
    ok: true,
    canInjectCss: true,           // --remote-debugging-port 不受任何 fuse 影响
    canUseNative: true,           // 需要 --inspect，受 NodeCliInspectArguments 管
    nativeBlockedBy: null,
    windowLayerGlass: false,
    windowLayerReasons: [],
    hasPageGlass: null,           // 只有 --deep 才知道
    singleInstance: null,
    userDataOverride: null,
    notes: [],
  };

  if (f && f.EnableNodeCliInspectArguments !== 'on') {
    c.canUseNative = false;
    c.nativeBlockedBy = 'EnableNodeCliInspectArguments';
    c.notes.push(
      'fuse 关闭了 --inspect：主进程调试不可用，--native 无法工作。' +
        '窗口层玻璃请改用系统设置（设置 → 辅助功能 → 视觉效果 → 透明效果）。'
    );
  }

  if (d) {
    if (d.transparent || d.vibrancy || d.backgroundMaterial) {
      c.windowLayerGlass = true;
      if (d.transparent) c.windowLayerReasons.push('BrowserWindow 设了 transparent: true');
      if (d.vibrancy) c.windowLayerReasons.push('使用了 vibrancy（macOS 原生亚克力）');
      if (d.backgroundMaterial) c.windowLayerReasons.push('使用了 backgroundMaterial（Windows 亚克力）');
    }
    if (d.titleBarOverlay) {
      c.notes.push('应用使用 setTitleBarOverlay 自绘标题栏 → 只有 --native 能改，CSS 够不到。');
    }
    c.hasPageGlass = d.backdropFilter === true;
    c.singleInstance = d.singleInstanceLock === true;
    c.userDataOverride = d.userDataOverride === true;
    c.prefersColorScheme = d.prefersColorScheme === true;

    if (c.singleInstance) {
      c.notes.push('检测到单实例锁代码 → 启动注入前需先完全退出该应用（或用隔离参数）。');
    }
    if (c.userDataOverride) {
      c.notes.push('应用自己覆盖了 userData 路径 → `--user-data-dir` 可能不生效，隔离需应用私有开关。');
    }
    if (c.hasPageGlass === false) {
      c.notes.push('未在 asar 中找到 backdrop-filter → 页面内可能没有毛玻璃，注入可能无效果（需人工确认）。');
    }
    if (c.prefersColorScheme) {
      c.notes.push('应用写了 prefers-color-scheme → profile 里设 emulateColorScheme 即可跟随系统深浅色，不需要 darkreader。');
    } else {
      c.notes.push('应用没有深色模式（未找到 prefers-color-scheme）→ 想要深色只能用 darkreader，或手写 CSS。');
    }
  }

  return c;
}

module.exports = {
  FUSE_SENTINEL,
  FUSE_ORDER,
  FUSE_DEFAULTS,
  FUSE_STATES,
  ASAR_MARKERS,
  readFuses,
  readElectronVersion,
  scanAsar,
  resolveExeGlob,
  exeFromProcess,
  probeExe,
  conclusions,
  ps,
};
