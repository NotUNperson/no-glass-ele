'use strict';
/* ==========================================================================
   no-glass-ele 管理界面 —— 前端逻辑

   两条约束：
   1. 不重新实现任何判断。profile 的状态（是否生成/过期/有何问题）全部来自
      Python 侧调用的 `gen.js --json`。这里只做展示与编辑。
   2. pywebview 的桥不是一开始就绪的。必须等 `pywebviewready` 事件，
      否则 window.pywebview 是 undefined。
   ========================================================================== */

// ─────────────────────────── 基础 ───────────────────────────

const $ = (id) => document.getElementById(id);
const api = () => window.pywebview && window.pywebview.api;

let STATE = {
  ready: false,
  profiles: [],
  current: null,       // 当前选中的 profile 名
  data: null,          // 当前 profile 的完整数据
  dirty: false,
  taskRunning: false,
  appAutostartArgs: [],   // 应用自己自启动命令行里的私有参数（探测得到）
  sessions: [],        // 运行中的注入会话
  activeSession: null, // 当前查看日志的会话 key（localId 或 id）
  // 每会话一份日志缓冲：key -> { lines, cursor }
  //
  // 为什么把内容存在这里而不是只留在 DOM 里：日志区只有一个 DOM 节点，
  // 切换会话时若直接清空它，另一个会话已渲染的历史就永久丢了 ——
  // 而游标还停在上次位置，所以切回来只能拿到"游标之后的新行"，
  // 表现为"历史不见了、只剩新内容"。
  logBuffers: {},
  cssDirty: false,
  wizard: null,        // 向导状态
};

// 每个会话在缓冲里保留的最大行数。与后端 LogBuffer 的上限（app.py 的
// LOG_LIMIT = 4000）对齐 —— 超出后端的部分本来就取不到，前端留更多没意义。
const LOG_BUFFER_MAX = 4000;

// 「任务」虚拟标签的 key。
//
// 为什么需要它：短任务（probe / build / doctor）的输出走的是后端的
// _task_log 通道，与注入会话的日志是两个来源。以前前端只在
// STATE.activeSession 为空时才显示任务日志 —— 而只要有会话在跑，
// activeSession 就非空，于是**任务输出永远看不见**（实测点了「校验全部」，
// 后端有 10 行输出、前端一个字都不显示）。
//
// 改成把任务当成一个常驻的虚拟标签，与真实会话并列，两个通道都能看到。
const TASK_KEY = '__task__';

function toast(msg, kind = '', ms = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 统一处理 API 返回值：{ok:false,error} 一律弹 toast 并返回 null。 */
function unwrap(res, quiet = false) {
  if (!res) { if (!quiet) toast('界面桥未就绪', 'err'); return null; }
  if (res.ok === false) {
    if (!quiet) toast(res.error || '操作失败', 'err', 3600);
    return null;
  }
  return res;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const yn = (v) => v === true ? '是' : v === false ? '否' : '未知';

// ─────────────────────────── 界面主题 ───────────────────────────

/**
 * 三态循环：跟随系统 → 深色 → 浅色 → 跟随系统 …
 *
 * 实现方式：把选择写到 <html data-theme>。不设置时 CSS 里有一段
 * @media (prefers-color-scheme: light) 覆盖，自动跟随系统。
 * 选择记在 localStorage，下次打开还记得。
 */
const THEME_KEY = 'noglass-ui-theme';
const THEMES = ['', 'dark', 'light'];   // '' = 跟随系统
const THEME_LABEL = { '': '跟随系统', dark: '深色', light: '浅色' };

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme) html.setAttribute('data-theme', theme);
  else html.removeAttribute('data-theme');
  const b = $('btnTheme');
  if (b) b.textContent = `主题：${THEME_LABEL[theme] || '跟随系统'}`;
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch (_) { /* 无 localStorage 就算了，只影响记忆 */ }
}

function initTheme() {
  let saved = '';
  try { saved = localStorage.getItem(THEME_KEY) || ''; } catch (_) { saved = ''; }
  if (!THEMES.includes(saved)) saved = '';
  applyTheme(saved);
}

function cycleTheme() {
  let cur = '';
  try { cur = localStorage.getItem(THEME_KEY) || ''; } catch (_) { cur = ''; }
  if (!THEMES.includes(cur)) cur = '';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  toast(`界面主题：${THEME_LABEL[next]}`, 'ok', 2200);
}

// ─────────────────────────── 初始化 ───────────────────────────

window.addEventListener('pywebviewready', init);
// 兜底：万一事件已经错过
if (api()) init();

let inited = false;
async function init() {
  if (inited) return;
  inited = true;
  STATE.ready = true;

  initTheme();
  bindUI();

  const st = unwrap(await api().get_state());
  if (st) {
    $('rootPath').textContent = st.root || '';
    const nb = $('nodeBadge');
    nb.textContent = st.nodeOk ? 'node ✓' : 'node ✗';
    nb.className = 'badge ' + (st.nodeOk ? 'ok' : 'err');
    if (!st.nodeOk) toast('找不到 node，无法运行探测与注入', 'err', 8000);
  }

  await refresh();
  startPolling();
  checkAutostartLast();
}

/**
 * 上次开机自启有失败吗？有就提示一句。
 *
 * 只读一个小 JSON（run/autostart-last.json），毫秒级 —— 不违反低负载要求。
 * 为什么需要：中转器的失败只写日志文件，而用户不会主动去翻那个文件；
 * 但 UI 是他会打开的，所以在入口提示一下。
 */
async function checkAutostartLast() {
  try {
    const res = await api().get_autostart_last();
    const last = res && res.last;
    if (!last || !last.failed) return;
    toast(
      `上次开机自启有 ${last.failed} 个失败（${last.at}）—— 点「开机自启」查看，或 node gen.js autostart log`,
      'warn',
      9000
    );
  } catch (_) { /* 忽略：提示失败不该影响界面 */ }
}

async function refresh(force = false) {
  const res = unwrap(await api().get_overview(force));
  if (!res) return;
  STATE.profiles = res.profiles || [];
  renderList();

  const db = $('taskBadge');
  if (res.doctorOk) { db.textContent = '校验通过'; db.className = 'badge ok'; }
  else { db.textContent = `${res.problemCount} 项待处理`; db.className = 'badge warn'; }

  // 刷新时如果当前选中的 profile 还在，重载它
  if (STATE.current && STATE.profiles.some((p) => p.name === STATE.current)) {
    await selectProfile(STATE.current, true);
  }
}

// ─────────────────────────── 列表 ───────────────────────────

function renderList() {
  const box = $('profileList');
  if (!STATE.profiles.length) {
    box.innerHTML = '<p class="dim tiny" style="padding:10px">还没有 profile。<br>点「+ 新建」开始。</p>';
    return;
  }
  box.innerHTML = STATE.profiles.map((p) => {
    const flags = [];
    if (p.stale) flags.push('<span class="stale-dot" title="产物与 profile 不一致，需重新生成">⚠ 待生成</span>');
    if (p.issues && p.issues.length) flags.push('<span class="warn-dot" title="校验有问题">●</span>');
    // 自启动状态：淡绿 = 已启用；浅黄 = 开机参数与手动参数不同
    if (p.autostartEnabled) flags.push('<span class="auto-dot" title="已启用开机自启动">自启</span>');
    if (p.autostartArgsDiffer) flags.push('<span class="args-dot" title="开机启动参数与手动启动参数不同（见 profile 的 autostart.appArgs）">参数不同</span>');
    const native = p.canUseNative === false ? 'native✗' : p.canUseNative === true ? 'native✓' : 'native?';
    const glass = p.hasPageGlass === true ? '玻璃✓' : p.hasPageGlass === false ? '玻璃✗' : '玻璃?';
    return `
      <div class="item ${p.name === STATE.current ? 'active' : ''}" data-name="${esc(p.name)}">
        <div class="name">
          <b>${esc(p.displayName || p.name)}</b>
          <span>${flags.join(' ')}</span>
        </div>
        <div class="meta">
          <span>${esc(p.electron || '?')}</span>
          <span>:${esc(p.port != null ? p.port : '?')}</span>
          <span>${native}</span>
          <span>${glass}</span>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.item').forEach((el) => {
    el.onclick = () => selectProfile(el.dataset.name);
  });
}

// ─────────────────────────── 详情 ───────────────────────────

async function selectProfile(name, keepScroll = false) {
  const res = unwrap(await api().get_profile(name));
  if (!res) return;

  STATE.current = name;
  STATE.data = res.data;
  STATE.dirty = false;
  renderList();
  renderDetail(keepScroll);
  await loadCustomCss();

  // 立刻刷新按钮状态。
  //
  // 为什么不靠轮询：按钮的可用性取决于「当前应用有没有在跑的会话」，
  // 而那只在 updateTaskUI 里更新（2 秒一次轮询驱动）。不在这里补一次的话，
  // 切换应用后按钮状态会滞后最多 2 秒 —— 看起来像点了没反应。
  updateTaskUI().catch(() => { /* 忽略：轮询会兜底 */ });
}

function renderDetail(keepScroll = false) {
  const p = STATE.data;
  if (!p) return;
  $('detailEmpty').classList.add('hidden');
  $('detailBody').classList.remove('hidden');

  const scrollTop = keepScroll ? $('.pane-detail').scrollTop : 0;

  $('dTitle').textContent = p.displayName || p.name;

  const meta = STATE.profiles.find((x) => x.name === p.name) || {};
  const d = p.detected || {};

  // 徽章
  const badges = [];
  // 运行时徽章放最前 —— 它决定"怎么开调试端口"，是最基础的信息
  const rt = p.runtime || d.runtime || 'electron';
  if (rt === 'tauri') {
    badges.push(`<span class="badge">Tauri${d.tauri && d.tauri.version ? ' ' + esc(d.tauri.version) : ''}</span>`);
  } else if (rt === 'electron') {
    if (d.electron) badges.push(`<span class="badge">Electron ${esc(d.electron)}</span>`);
  } else {
    badges.push('<span class="badge warn">运行时未识别</span>');
  }
  badges.push(`<span class="badge ${d.canUseNative === false ? 'warn' : 'ok'}">native ${d.canUseNative === false ? '不可用' : '可用'}</span>`);
  if (d.hasPageGlass === true) badges.push('<span class="badge ok">页面玻璃 ✓</span>');
  else if (d.hasPageGlass === false) badges.push('<span class="badge">未发现玻璃</span>');
  if (d.windowLayerGlass === true) badges.push('<span class="badge warn">窗口层玻璃</span>');
  if (d.fuses && d.fuses.hardened && d.fuses.hardened.length) {
    badges.push(`<span class="badge warn">已加固 ${d.fuses.hardened.length} 项</span>`);
  }
  if (meta.stale) badges.push('<span class="badge warn">产物待更新</span>');
  $('dBadges').innerHTML = badges.join('');

  // 事实
  const rtName = rt === 'tauri' ? 'Tauri / WebView2' : (rt === 'electron' ? 'Electron' : '未识别');
  const facts = [
    ['运行时', rtName, rt === 'unknown' ? 'no' : 'yes'],
    ['exe', p.exe ? (meta.exeExists ? '存在' : '不存在') : '未设置', p.exe ? (meta.exeExists ? 'yes' : 'no') : 'unk'],
    ['进程名', p.processName || '—', ''],
    ['CDP 端口', p.defaultPort != null ? p.defaultPort : '—', ''],
    ['页面内毛玻璃', yn(d.hasPageGlass), d.hasPageGlass === true ? 'yes' : d.hasPageGlass === false ? 'unk' : 'unk'],
    ['窗口层玻璃', yn(d.windowLayerGlass), d.windowLayerGlass === true ? 'yes' : 'unk'],
    ['单实例锁', yn(d.singleInstance), d.singleInstance === true ? 'yes' : 'unk'],
    ['userData 被覆盖', yn(d.userDataOverride), d.userDataOverride === true ? 'yes' : 'unk'],
    ['--native', d.canUseNative === false ? (rt === 'tauri' ? '不适用（Tauri）' : '不可用') : '可用', d.canUseNative === false ? 'no' : 'yes'],
    ['探测日期', d.probedAt || '—', ''],
  ];
  $('dFacts').innerHTML = facts.map(([k, v, cls]) => `
    <div class="fact"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>
  `).join('');

  // fuse 表
  const ft = d.fuses && d.fuses.table;
  if (ft) {
    const hard = new Set(d.fuses.hardened || []);
    $('dFuses').innerHTML = Object.entries(ft).map(([k, v]) => {
      const label = v === 'on' ? '开' : v === 'off' ? '关' : v;
      return `<tr class="${hard.has(k) ? 'hardened' : ''}"><td>${esc(k)}</td><td>${esc(label)}</td></tr>`;
    }).join('');
    $('dFuses').closest('.fuse-wrap').classList.remove('hidden');
  } else {
    $('dFuses').closest('.fuse-wrap').classList.add('hidden');
  }

  // 校验问题
  const issues = meta.issues || [];
  if (issues.length) {
    $('dIssuesCard').classList.remove('hidden');
    $('dIssues').innerHTML = issues.map((i) => `<li>${esc(i)}</li>`).join('');
  } else {
    $('dIssuesCard').classList.add('hidden');
  }

  // 预设
  const ALL = ['start', 'start-debug', 'start-isolated', 'start-native'];
  const have = new Set(meta.presets || []);
  $('dPresets').innerHTML = ALL.map((x) =>
    `<span class="preset ${have.has(x) ? 'available' : 'missing'}" title="${have.has(x) ? '已生成' : '未生成（不适用或未 build）'}">${x}.cmd</span>`
  ).join('');

  renderForm(p);
  loadDarkreader();
  loadAppAutostart();

  if (keepScroll) $('.pane-detail').scrollTop = scrollTop;
}

/**
 * 显示「应用自己的启动参数」并支持一键填入。
 *
 * 为什么需要：应用自己启动时带 `--hidden` 这类后台标志，我们启动时没带
 * → 本该静默到托盘的应用会弹窗。这个卡片把探测到的参数摆出来，
 * 一键填进上方的 appArgs 输入框（再点启动就生效）。
 */
async function loadAppAutostart() {
  const card = $('appArgsCard');
  if (!card) return;
  card.classList.add('hidden');
  $('appArgsStatus').textContent = '';
  if (!STATE.current) return;

  const res = await api().get_app_autostart(STATE.current);
  if (!res || res.ok === false || !res.args || !res.args.length) return;

  STATE.appAutostartArgs = res.args;
  $('appArgsSrc').textContent = res.hits.map((h) => `${h.where}: ${h.commandLine}`).join('  |  ');
  card.classList.remove('hidden');

  // 已经在 appArgs 里了就不提示
  const cur = ($('optAppArgs').value || '').trim();
  if (res.args.every((a) => cur.includes(a))) {
    $('appArgsStatus').textContent = '已填入';
  }
}

/** 把探测到的应用私有参数填进启动参数框。 */
function adoptAppArgs() {
  const args = STATE.appAutostartArgs || [];
  if (!args.length) return;
  const cur = ($('optAppArgs').value || '').trim();
  const merged = [...new Set([...cur.split(/\s+/).filter(Boolean), ...args])];
  $('optAppArgs').value = merged.join(' ');
  $('appArgsStatus').textContent = '已填入（点「启动」生效）';
  toast(`已填入 ${args.join(' ')} —— 这样注入器启动时应用不会弹窗`, 'ok', 5000);
}

// ─────────────────────────── 表单 ───────────────────────────

/** 字段定义：只有这些是"人工决策"，工具测不出来。 */
const FIELDS = [
  { key: 'displayName', label: '显示名', type: 'text', note: '出现在日志与生成的 README 里' },
  { key: 'processName', label: '进程名', type: 'text', note: '不含 .exe，用于探测运行状态与 --restart' },
  { key: 'defaultPort', label: 'CDP 端口', type: 'number', note: '必须与其他 profile 不同' },
  { key: 'reservedPorts', label: '保留端口', type: 'list', note: '该应用自身占用的端口，逗号分隔' },
  { key: 'exe', label: 'exe 路径', type: 'text', wide: true },
  { key: 'exeGlob', label: 'exeGlob（版本化安装路径）', type: 'text', wide: true, note: '如 app-*\\App.exe，取最高版本；填了就不用 exe' },
  { key: 'urlFilter', label: 'urlFilter（正则）', type: 'text', wide: true, note: '只注入匹配的页面，放过第三方网页' },
  { key: 'isolateEnv', label: 'isolateEnv（私有隔离开关）', type: 'kv', wide: true, note: 'JSON 对象；应用覆盖了 userData 时必需' },
  { key: 'dataDirEnv', label: 'dataDirEnv', type: 'text', note: '指定数据目录的环境变量名' },
  { key: 'emulateColorScheme', label: '配色模拟', type: 'enum', options: ['', 'dark', 'light'], note: '只对已写 prefers-color-scheme 的应用有效' },
  { key: 'darkreader', label: '深色模式（Dark Reader）', type: 'enum', options: ['', 'auto', 'dark', 'light', 'off'], note: '给没有深色模式的应用用；上方卡片可一键生效' },
  { key: 'darkreaderTheme', label: 'Dark Reader 参数', type: 'kv', wide: true, note: 'JSON 对象；常用 {"engine":"dynamicTheme","brightness":100,"contrast":100}' },
  { key: 'appArgs', label: '传给应用的启动参数', type: 'strlist', wide: true, note: '逗号分隔；如 --disable-lcd-text（Chromium 只在启动时读）' },
  { key: 'native.enabled', label: '启用 --native', type: 'bool', note: 'fuse 禁用 --inspect 时不可用' },
  { key: 'native.darkBg', label: '深色窗口底色', type: 'text' },
  { key: 'native.lightBg', label: '浅色窗口底色', type: 'text' },
  { key: 'notes.watchRequired', label: 'notes: 为何必须 --watch', type: 'textarea', wide: true },
  { key: 'notes.portConflict', label: 'notes: 已知端口冲突', type: 'textarea', wide: true },
  { key: 'notes.extra', label: 'notes: 其他补充', type: 'textarea', wide: true },
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
}

function renderForm(p) {
  $('dForm').innerHTML = FIELDS.map((f) => {
    const v = getPath(p, f.key);
    const wide = f.wide ? ' wide' : '';
    let input;

    if (f.type === 'bool') {
      input = `<label class="check"><input type="checkbox" data-key="${f.key}" ${v === true ? 'checked' : ''}> 启用</label>`;
    } else if (f.type === 'textarea') {
      input = `<textarea data-key="${f.key}" placeholder="（可留空）">${esc(v || '')}</textarea>`;
    } else if (f.type === 'enum') {
      const opts = (f.options || []).map((o) =>
        `<option value="${esc(o)}" ${String(v || '') === o ? 'selected' : ''}>${o === '' ? '（不模拟）' : o}</option>`
      ).join('');
      input = `<select data-key="${f.key}" class="select-inline">${opts}</select>`;
    } else if (f.type === 'strlist') {
      const s = Array.isArray(v) ? v.join(', ') : (v || '');
      input = `<input type="text" data-key="${f.key}" value="${esc(s)}" placeholder="如 --disable-lcd-text, --font-render-hinting=none">`;
    } else if (f.type === 'list') {
      const s = Array.isArray(v) ? v.join(', ') : (v || '');
      input = `<input type="text" data-key="${f.key}" value="${esc(s)}" placeholder="如 9527, 8080">`;
    } else if (f.type === 'kv') {
      const s = v && Object.keys(v).length ? JSON.stringify(v) : '';
      input = `<input type="text" data-key="${f.key}" value="${esc(s)}" placeholder='如 {"APP_ALLOW_MULTI":"1"}'>`;
    } else {
      input = `<input type="${f.type}" data-key="${f.key}" value="${esc(v == null ? '' : v)}">`;
    }

    return `<div class="field${wide}">
      <label>${esc(f.label)}</label>
      ${input}
      ${f.note ? `<span class="note">${esc(f.note)}</span>` : ''}
    </div>`;
  }).join('');

  // 输入即标记脏
  $('dForm').querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', () => { STATE.dirty = true; });
    el.addEventListener('change', () => { STATE.dirty = true; });
  });
}

/** 把表单值收回 profile 对象。解析失败会抛错，调用方负责提示。 */
function collectForm() {
  const out = JSON.parse(JSON.stringify(STATE.data));
  for (const f of FIELDS) {
    const el = $('dForm').querySelector(`[data-key="${f.key}"]`);
    if (!el) continue;

    if (f.type === 'bool') {
      setPath(out, f.key, el.checked);
      continue;
    }
    const raw = el.value.trim();

    if (f.type === 'list') {
      const arr = raw ? raw.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n)) : [];
      setPath(out, f.key, arr);
    } else if (f.type === 'strlist') {
      const arr = raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [];
      setPath(out, f.key, arr);
    } else if (f.type === 'enum') {
      setPath(out, f.key, raw === '' ? null : raw);
    } else if (f.type === 'kv') {
      if (!raw) { setPath(out, f.key, null); continue; }
      let obj;
      try { obj = JSON.parse(raw); }
      catch { throw new Error(`「${f.label}」不是合法 JSON：${raw}`); }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error(`「${f.label}」必须是 JSON 对象，如 {"KEY":"1"}`);
      }
      setPath(out, f.key, obj);
    } else if (f.type === 'number') {
      if (raw === '') { setPath(out, f.key, null); continue; }
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`「${f.label}」必须是数字`);
      setPath(out, f.key, n);
    } else {
      setPath(out, f.key, raw === '' ? null : raw);
    }
  }
  return out;
}

// ─────────────────────────── 动作 ───────────────────────────

async function saveProfile() {
  if (!STATE.data) return;
  let payload;
  try { payload = collectForm(); }
  catch (e) { toast(e.message, 'err', 6000); return; }

  const res = unwrap(await api().save_profile(STATE.current, payload));
  if (!res) return;
  STATE.dirty = false;
  toast('已保存。记得点「重新生成启动器」', 'ok');
  await refresh();
}

/**
 * 切到「任务」标签 —— 短任务的输出只在那里显示。
 *
 * 为什么任务开始时要主动切：否则用户点了「校验全部」却看不到任何反应
 * （输出在另一个标签里）。这是"点了按钮像没生效"的直接来源。
 */
function focusTaskTab() {
  if (STATE.activeSession !== TASK_KEY) switchSession(TASK_KEY);
}

async function buildProfile() {
  if (!STATE.current) return;
  const res = unwrap(await api().run_task('build', STATE.current));
  if (!res) return;
  toast('开始生成启动器…', 'ok');
  focusTaskTab();
}

async function launchInjector() {
  if (!STATE.current) return;
  const isolate = $('optIsolate').checked;
  const extra = $('optExtra').value.trim();
  const emulate = $('optEmulate').value || null;
  const appArgsRaw = $('optAppArgs').value.trim();
  // 按空格切分，但保留带引号的整体（简单处理：够用且可预期）
  const appArgs = appArgsRaw ? appArgsRaw.match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, '')) : [];

  const res = await api().launch(STATE.current, isolate, extra || null, emulate, appArgs);
  if (!res) { toast('界面桥未就绪', 'err'); return; }
  if (res.ok === false) {
    toast(res.error || '启动失败', 'err', 4000);
    return;
  }
  toast('已启动注入器（--watch 常驻）', 'ok');
  await refresh();
  await updateTaskUI();

  // 切到新会话的日志标签。
  //
  // 为什么要等：注入器刚起来时它还没把自己登记到 run/sessions/，于是
  // 这一次 updateTaskUI 拉到的列表里没有它。若此刻直接 switchSession，
  // renderSessionTabs 会发现这个 key 不在列表里而回退到第一个标签 ——
  // 把刚设好的选择覆盖掉（实测就是这个表现：启动后停在旧标签）。
  // 所以轮询等它出现，最多约 3 秒。
  if (res.localId) {
    const key = res.localId;
    for (let i = 0; i < 8; i++) {
      if (STATE.sessions.some((s) => s.key === key)) break;
      await new Promise((r) => setTimeout(r, 400));
      await updateTaskUI();
    }
    if (STATE.sessions.some((s) => s.key === key)) {
      switchSession(key);
    } else {
      // 没等到（启动慢或失败了）—— 不静默，提示用户去标签里找
      toast('注入器已启动，但会话标签还没出现（可稍后在右栏查看）', 'warn', 5000);
    }
  }
}

async function stopSession(key) {
  const s = STATE.sessions.find((x) => x.key === key);
  const nm = s ? (s.displayName || s.profile) : key;

  // 外部发现的旧版注入器既没有 localId 也没有 id —— 只能按 pid 强停。
  // 后端 stop_session 也认 pid（通过 ext:<pid> 形式的 key 或直接传 pid）。
  const res = await api().stop_session(
    s && s.localId ? s.localId : null,
    s && s.id ? s.id : null,
    s && s.pid ? s.pid : null
  );
  if (!res) { toast('界面桥未就绪', 'err'); return; }
  if (res.ok === false) { toast(res.error || '停止失败', 'err', 5000); return; }

  toast(`已请求停止 ${nm}。目标应用不会被关闭。`, 'ok', 5000);
  await updateTaskUI();
}

/**
 * 「启动注入」卡片里的停止按钮。
 *
 * 语义：停**左侧当前选中应用**的注入会话 —— 与这个按钮的禁用条件
 * （STATE.current 有没有运行中的会话）保持一致。
 *
 * 以前这里取的是 STATE.activeSession（右侧日志标签），而禁用条件看的却是
 * STATE.current（左侧选中应用）—— 两个字段毫无同步，于是出现在左侧切到
 * 应用 A、点停止却停掉了日志标签 B 的情况。
 */
async function stopTask() {
  const cur = STATE.current;
  if (cur) {
    const mine = STATE.sessions.find((s) => s.key && s.profile === cur && s.running);
    if (mine) return stopSession(mine.key);
  }
  // 当前应用没有注入会话时，才考虑停短任务（probe / build / doctor）
  if (STATE.taskRunning) {
    const res = await api().stop_task();
    if (!res) { toast('界面桥未就绪', 'err'); return; }
    if (res.ok === false) { toast(res.error || '停止失败', 'err', 5000); return; }
    toast('已请求停止当前任务。', 'ok', 4000);
    await updateTaskUI();
    return;
  }
  toast(cur ? `「${cur}」没有运行中的注入。` : '没有运行中的注入会话', 'warn');
}

async function updateTaskUI() {
  const res = await api().get_task_status();
  const st = (res && res.ok && res.task) || {};
  STATE.taskRunning = !!st.taskRunning;

  // 会话列表走 get_overview —— 它带 5 秒 TTL 缓存，且内部会实时刷新
  // 会话部分（读磁盘注册表，很廉价）。这样高频轮询不会反复跑 node。
  let sess = [];
  try {
    const sr = await api().get_overview();
    if (sr && sr.ok) sess = sr.sessions || [];
  } catch (_) { /* 忽略 */ }
  STATE.sessions = sess;

  // 清掉已消失会话的日志缓冲（当前查看的那个会保留，便于回看结束后的输出）
  pruneLogBuffers(sess.map((s) => s.key).filter(Boolean));

  renderSessionTabs();

  const running = sess.filter((s) => s.running);
  const b = $('taskBadge');
  if (running.length) {
    b.textContent = `${running.length} 个注入中`;
    b.className = 'badge ok';
  } else if (STATE.taskRunning) {
    b.textContent = '任务运行中';
    b.className = 'badge ok';
  } else {
    b.textContent = '空闲';
    b.className = 'badge';
  }

  const cur = STATE.current;
  syncLaunchButtons();
}

/**
 * 「启动 / 停止」两个按钮的可用状态。
 *
 * 规则：该应用**已经有注入会话在跑**就禁用启动 —— 与后端守卫是同一套规则
 * （ui/app.py 的 launch_injector：同 profile 已有会话就拒绝）。
 * 两边不一致就会出现「按钮能点，点了报错」或「按钮灰着，其实能起」。
 *
 * 注意：这里**不看「隔离数据」复选框**。
 * 隔离是**启动方式**（本次启动用独立数据目录，不写进你平时用的数据），
 * 不是"多开一个实例"。本工具不运行同一应用的多个实例 —— 那会带来
 * 标签页/停止按钮/日志归属的一堆歧义，而且很多应用有单实例锁根本开不起来。
 * 想换启动方式就先停掉现有的（或先退出应用）。
 */
function syncLaunchButtons() {
  const cur = STATE.current;
  const sess = STATE.sessions || [];
  const mine = sess.find((s) => s.profile === cur && s.running);
  $('btnStop').disabled = !mine && !STATE.taskRunning;
  $('btnLaunch').disabled = !!mine;
  // 灰着的时候给个理由，并说明出路
  $('btnLaunch').title = mine
    ? `「${cur}」已有注入会话在运行。想换启动方式（例如改用隔离数据）请先停止它。`
    : '';
}

function renderSessionTabs() {
  const box = $('sessionTabs');
  // 只显示有 key 的（后端保证非空；这里再兜一层，防御脏数据）
  const live = STATE.sessions.filter((s) => s.key);

  // 「任务」是常驻虚拟标签，永远可用（它是短任务输出的唯一入口）。
  const keys = [TASK_KEY, ...live.map((s) => s.key)];

  // 若当前查看的会话没了，回退。
  // 注意：这里**不直接改 STATE.activeSession** —— 切换要连带把 DOM 换成
  // 新会话的缓冲内容，所以统一走 switchSession()，避免出现"标题变了、
  // 内容还是上一个会话的"这种半切换状态。
  const wanted = keys.includes(STATE.activeSession)
    ? STATE.activeSession
    : (live.length ? live[0].key : TASK_KEY);
  if (wanted !== STATE.activeSession) {
    // 延到本次渲染之后（本函数还会被 switchSession 反过来调用，直接调会递归）
    setTimeout(() => switchSession(wanted, { silent: true }), 0);
  }

  // 任务标签排在最前面 —— 它是"工具输出"的固定位置，不随会话增减移动。
  const taskTab = (() => {
    const cls = ['stab', 'task'];
    if (STATE.activeSession === TASK_KEY) cls.push('active');
    if (STATE.taskRunning) cls.push('run'); else cls.push('dead');
    const spin = STATE.taskRunning ? '运行中' : '空闲';
    return `<span class="${cls.join(' ')}" data-key="${TASK_KEY}" title="工具输出（probe / build / doctor）· ${spin}">
      <span class="dot"></span><span class="nm">任务</span>
    </span>`;
  })();

  box.innerHTML = taskTab + live.map((s) => {
    const key = s.key;
    const nm = s.displayName || s.profile || '(未知)';
    const cls = ['stab'];
    if (s.running) cls.push('run'); else cls.push('dead');
    if (key === STATE.activeSession) cls.push('active');
    const port = s.port != null ? `<span class="pt">:${s.port}</span>` : '';
    const ext = s.external ? '<span class="ext" title="外部启动的注入器（无实时日志，可看磁盘日志）">外部</span>' : '';
    // 残留项（硬关机留下的）没有注入器会消费停止请求，所以 ✕ 改成"清理"。
    let mark = '';
    if (s.zombie) {
      mark = '<span class="residual" title="这是硬关机留下的残留注册项：注入器早已退出，点 ✕ 只会清掉这条残留，不会动任何进程">残留</span>';
    }
    const x = s.running
      ? `<span class="x" data-stop="${esc(key)}" title="停止（不关应用）">✕</span>`
      : (s.zombie ? `<span class="x" data-stop="${esc(key)}" title="清理残留注册项（不会动任何进程）">✕</span>` : '');
    return `<span class="${cls.join(' ')}" data-key="${esc(key)}" title="${esc(nm)}">
      <span class="dot"></span><span class="nm">${esc(nm)}</span>${port}${ext}${mark}${x}
    </span>`;
  }).join('');

  // 切标签
  box.querySelectorAll('.stab').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.stop) return;   // 点的是 ✕
      const k = el.dataset.key;
      if (!k) return;                      // 没有 key 就不切（不该发生）
      if (STATE.activeSession === k) return;  // 重复点同一个：不重绘，避免闪
      switchSession(k);
    };
  });
  // 停止按钮
  box.querySelectorAll('[data-stop]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      stopSession(el.dataset.stop);
    };
  });

  if (STATE.activeSession === TASK_KEY) {
    $('logTitle').textContent = STATE.taskRunning ? '输出 · 任务（运行中）' : '输出 · 任务';
  } else {
    const cur = STATE.sessions.find((s) => s.key === STATE.activeSession);
    $('logTitle').textContent = cur
      ? `输出 · ${cur.displayName || cur.profile}${cur.external ? '（外部）' : ''}`
      : '输出';
  }
}

/**
 * 切换当前查看的会话 —— **唯一入口**。
 *
 * 为什么必须收敛成一个函数：日志区只有一个 DOM 节点，而切换涉及三件事
 * 必须一起发生（换 activeSession、换 DOM 内容、恢复滚动位置）。
 * 以前分散在标签点击、渲染回退、启动成功三处各写一半，于是出现
 * "标题是新会话、内容还是旧会话"的半切换状态。
 *
 * 内容从 STATE.logBuffers 取 —— 每个会话各自留了一份，所以切回来能
 * 立刻看到完整历史（包括切走期间攒下的输出，因为轮询一直在充实缓冲）。
 */
function switchSession(key, opts = {}) {
  const prev = STATE.activeSession;

  // 离开旧会话前，把滚动位置记下来，切回来能回到原处
  if (prev && prev !== key) {
    const b = STATE.logBuffers[prev];
    if (b) {
      const box = $('log');
      b.scrollTop = box.scrollTop;
      b.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    }
  }

  STATE.activeSession = key || null;
  renderLogFromBuffer();

  if (!opts.silent) {
    renderSessionTabs();
    // 立即拉一次，不用等下一个 300ms 周期
    pollSessionLog().catch(() => { /* 忽略 */ });
  }
}

/** 把当前会话（或短任务）的缓冲内容整体渲染到日志区。 */
function renderLogFromBuffer() {
  const box = $('log');
  const key = STATE.activeSession;

  if (!key) {
    // 没有会话：短任务日志走 appendLog 那条路，这里不清（避免把正在看的清掉）
    return;
  }

  const b = STATE.logBuffers[key];
  const follow = $('optFollow').checked;
  const atBottom = b ? b.atBottom : true;

  if (!b || !b.lines.length) {
    // 缓冲还没建（刚切过来、首轮还没回来）——给提示而不是空白
    if (key === TASK_KEY) {
      box.innerHTML = '<span class="l-dim">（任务暂无输出；点「校验全部」或「重新生成启动器」会产生输出）</span>';
      return;
    }
    const sess = STATE.sessions.find((x) => x.key === key);
    box.innerHTML = sess
      ? '<span class="l-dim">（加载中…）</span>'
      : '<span class="l-dim">（该会话已结束）</span>';
    return;
  }

  box.innerHTML = b.lines
    .map((l) => `<span class="${classify(l)}">${esc(l)}</span>`).join('\n');

  if (follow && atBottom) box.scrollTop = box.scrollHeight;
  else if (b.scrollTop != null) box.scrollTop = b.scrollTop;
}

/** 取（或创建）某会话的日志缓冲。 */
function bufferFor(key) {
  if (!STATE.logBuffers[key]) STATE.logBuffers[key] = { lines: [], cursor: 0, scrollTop: null, atBottom: true };
  return STATE.logBuffers[key];
}

/**
 * 丢弃已消失会话的缓冲，但**保留当前查看的那个**。
 *
 * 为什么要留当前这个：会话结束后你往往还想回头看一眼它的输出
 * （比如注入为什么失败）。一结束就清掉，标签虽然还在（dead 态）却空了。
 */
function pruneLogBuffers(liveKeys) {
  const keep = new Set(liveKeys);
  if (STATE.activeSession) keep.add(STATE.activeSession);
  for (const k of Object.keys(STATE.logBuffers)) {
    if (!keep.has(k)) delete STATE.logBuffers[k];
  }
}

/**
 * 轮询当前选中会话的日志。
 *
 * 关键约定（修"日志混在一起"）：请求发出前把 key 快照下来，
 * 回来时若 activeSession 已经变了，就**只充实那个会话的缓冲、不碰 DOM**。
 * 之前没有这个检查，两个会话的响应会先后落进同一个 DOM 节点，
 * 日志就混在一起了。
 *
 * 任务标签（TASK_KEY）走的是另一条后端通道（_task_log），在这里分流。
 */
async function pollSessionLog() {
  const key = STATE.activeSession;
  if (!key) {
    // 没有任何选中项（理论上不该发生，标签里至少有"任务"）
    return pollTaskLog();
  }
  if (key === TASK_KEY) {
    return pollTaskLog();
  }
  const s = STATE.sessions.find((x) => x.key === key);
  if (!s) {
    const b = STATE.logBuffers[key];
    if (!b || !b.lines.length) {
      const box = $('log');
      if (!box.textContent.trim()) box.innerHTML = '<span class="l-dim">（该会话已结束）</span>';
    }
    return;
  }

  const buf = bufferFor(key);
  const res = await api().get_session_log(
    s.localId || null, s.id || null, buf.cursor, s.pid || null
  );
  if (!res || res.ok === false) {
    // 后端明确报错时也要让用户看见，而不是留一片空白
    if (key === STATE.activeSession) {
      const box = $('log');
      if (!box.textContent.trim()) {
        box.innerHTML = `<span class="l-err">（读日志失败：${esc((res && res.error) || '未知错误')}）</span>`;
      }
    }
    return;
  }

  // 先把结果写进**它自己的**缓冲（无论现在看的是不是它）
  if (res.live) {
    buf.cursor = res.cursor;
    if (res.lines && res.lines.length) {
      buf.lines.push(...res.lines);
      if (buf.lines.length > LOG_BUFFER_MAX) {
        buf.lines.splice(0, buf.lines.length - LOG_BUFFER_MAX);
      }
    }
  } else if (res.reset) {
    // 文件型会话：后端要求重置（首读、或文件被截断/轮转）→ 整体替换缓冲
    buf.lines = (res.lines || []).slice(-LOG_BUFFER_MAX);
    if (!buf.lines.length && res.note) buf.lines = [res.note];
    buf.cursor = res.cursor || 0;
  } else {
    // 文件型会话的**增量**：只追加新行。
    // 为什么这条分支重要：以前它走的是"整体替换 + 重渲染"，而重渲染会销毁
    // 日志区所有 DOM 节点 —— 用户刚选中的文字每 300ms 被清空一次（实测反馈：
    // 选择内容每隔几秒就重新从头开始）。增量追加不碰已有节点，选中得以保留。
    if (res.lines && res.lines.length) {
      buf.lines.push(...res.lines);
      if (buf.lines.length > LOG_BUFFER_MAX) {
        buf.lines.splice(0, buf.lines.length - LOG_BUFFER_MAX);
      }
    }
    buf.cursor = res.cursor || buf.cursor;
  }

  // 只有"回来时看的还是它"才动 DOM —— 过期响应只充实缓冲
  if (key !== STATE.activeSession) return;

  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

  if (res.live || !res.reset) {
    // 增量追加（比整体重渲染便宜，且不破坏用户的选择）
    if (res.lines && res.lines.length) {
      appendLog(res.lines, atBottom);
    } else if (!buf.lines.length && !box.textContent.trim()) {
      box.innerHTML = '<span class="l-dim">（该会话暂无输出）</span>';
    }
  } else {
    // 后端要求重置（首读 / 文件被截断）：只能整段重画
    renderLogFromBuffer();
  }
}

/**
 * 短任务日志（probe / build / doctor）—— 走「任务」虚拟标签。
 *
 * 与会话日志同一套缓冲机制（logBuffers[TASK_KEY]），所以：
 *   · 切走再切回，任务输出完整保留
 *   · 有过期响应检查（回来时若已切走，只充实缓冲不动 DOM）
 */
async function pollTaskLog() {
  const buf = bufferFor(TASK_KEY);
  const res = await api().get_logs(buf.cursor);
  if (!res || res.ok === false) return;

  buf.cursor = res.cursor;
  const lines = res.lines || [];
  if (lines.length) {
    buf.lines.push(...lines);
    if (buf.lines.length > LOG_BUFFER_MAX) {
      buf.lines.splice(0, buf.lines.length - LOG_BUFFER_MAX);
    }
  }

  // 只有还停在任务标签时才动 DOM
  if (STATE.activeSession !== TASK_KEY) return;

  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (lines.length) {
    appendLog(lines, atBottom);
  } else if (!buf.lines.length && !box.textContent.trim()) {
    box.innerHTML = '<span class="l-dim">（任务暂无输出；点「校验全部」或「重新生成启动器」会产生输出）</span>';
  }
}

// ─────────────────────────── 日志轮询 ───────────────────────────

function classify(line) {
  if (/^\$ /.test(line)) return 'l-cmd';
  if (/—— 结束（退出码 0）——/.test(line)) return 'l-ok';
  if (/—— 结束（退出码 [1-9]/.test(line)) return 'l-err';
  if (/\[noglass\].*(出错|失败|超时)/.test(line)) return 'l-err';
  if (/\[ui\]/.test(line)) return 'l-dim';
  if (/已注入 ✓|调试端口已就绪|全部通过|✓ /.test(line)) return 'l-ok';
  if (/⚠|warn|警告|跳过/.test(line)) return 'l-warn';
  return '';
}

/**
 * 把新行追加到日志区，并维护滚动。
 *
 * 注意：这里**不写缓冲** —— 缓冲由 pollSessionLog 负责（它得先判定
 * "这条响应属于哪个会话"，再决定是否动 DOM）。本函数只管显示。
 *
 * @param lines    要追加的行
 * @param atBottom 追加前是否已经在底部（不在底部时不要抢用户的滚动位置）
 */
function appendLog(lines, atBottom) {
  if (!lines || !lines.length) return;
  const box = $('log');
  const wasAtBottom = atBottom !== undefined
    ? atBottom
    : (box.scrollHeight - box.scrollTop - box.clientHeight < 40);
  const html = lines.map((l) => `<span class="${classify(l)}">${esc(l)}</span>`).join('\n');
  box.insertAdjacentHTML('beforeend', (box.textContent ? '\n' : '') + html);

  // 限制 DOM 节点数，避免长时间运行后卡顿。
  // 缓冲里另有一份同样的上限（LOG_BUFFER_MAX），切换会话时会整体重建 DOM，
  // 所以这里多删一点不会丢内容。
  if (box.childNodes.length > LOG_BUFFER_MAX + 2000) {
    for (let i = 0; i < 1500; i++) box.removeChild(box.firstChild);
  }
  if ($('optFollow').checked && wasAtBottom) box.scrollTop = box.scrollHeight;
}

async function pollLogs() {
  await pollSessionLog();
}

/**
 * 分层轮询 —— 这是修「进程雪崩」的关键。
 *
 * 之前是每 300ms 同时做两件事：拉日志 + 刷新会话列表。
 * 而刷新会话列表要查进程表（起 PowerShell，1-2 秒），于是调用严重重叠，
 * 实测派生出 25+ 个 powershell、CPU 100%、内存掉到 583MB。
 *
 * 现在分开：
 *   · 日志轮询 300ms —— 纯内存读取（本地会话读缓冲区，外部会话读一个小文件）
 *   · 会话/任务状态 2 秒 —— 且后端本身还有 TTL 缓存兜底
 *
 * 另外每个轮询都有「在飞」标志，防止上一次没回来就发下一次（防重入）。
 */
const POLL_LOG_MS = 300;
const POLL_STATE_MS = 2000;

const _inFlight = { log: false, state: false };

function startPolling() {
  // 日志：高频，但很轻
  setInterval(async () => {
    if (!STATE.ready || _inFlight.log) return;
    _inFlight.log = true;
    try { await pollLogs(); } catch (_) { /* 忽略 */ }
    finally { _inFlight.log = false; }
  }, POLL_LOG_MS);

  // 状态：低频。后端另有 TTL 缓存，即使这里发得勤也不会真去查进程表。
  setInterval(async () => {
    if (!STATE.ready || _inFlight.state) return;
    _inFlight.state = true;
    try { await updateTaskUI(); } catch (_) { /* 忽略 */ }
    finally { _inFlight.state = false; }
  }, POLL_STATE_MS);

  // 首次立刻刷新一次状态，不用等 2 秒
  setTimeout(async () => {
    if (_inFlight.state) return;
    _inFlight.state = true;
    try { await updateTaskUI(); } catch (_) { /* 忽略 */ }
    finally { _inFlight.state = false; }
  }, 100);
}

// ─────────────────────────── 深色模式（Dark Reader）───────────────────────────

/** 把 profile 里的 darkreader 配置回填到卡片控件。 */
function loadDarkreader() {
  const p = STATE.data || {};
  const mode = p.darkreader || '';
  const th = p.darkreaderTheme || {};

  $('drMode').value = mode;
  $('drEngine').value = th.engine || 'dynamicTheme';
  $('drBright').value = th.brightness != null ? th.brightness : 100;
  $('drContrast').value = th.contrast != null ? th.contrast : 100;
  $('drBrightVal').textContent = $('drBright').value;
  $('drContrastVal').textContent = $('drContrast').value;

  // 状态提示：应用自身有没有深色模式 + 会话在不在跑（跑着的话带上它实际用的模式）
  const d = p.detected || {};
  const parts = [];
  if (d.prefersColorScheme === true) {
    parts.push('该应用自带深色模式（可先用「配色模拟」，不必开这里）');
  } else if (d.prefersColorScheme === false) {
    parts.push('该应用没有深色模式');
  }
  const sess = STATE.sessions.find((s) => s.profile === p.name && s.running);
  if (sess) {
    // 会话注册项里记的是**启动时**的模式，可能与表单里刚改的还没保存的值不同
    const live = sess.darkreader || '未启用';
    parts.push(`运行中 · 会话：${esc(live)}`);
  } else {
    parts.push('未运行注入');
  }
  $('drStatus').textContent = parts.length ? `（${parts.join(' · ')}）` : '';
  $('drHint').textContent = '';
}

/** 保存并立即生效：写 profile + 推给正在运行的注入器。 */
async function applyDarkreader() {
  if (!STATE.current) return;
  const mode = $('drMode').value || null;
  const engine = $('drEngine').value || 'dynamicTheme';
  const brightness = Number($('drBright').value);
  const contrast = Number($('drContrast').value);

  const res = await api().set_darkreader(STATE.current, mode, engine, brightness, contrast);
  if (!res) { toast('界面桥未就绪', 'err'); return; }
  if (res.ok === false) {
    toast(res.error || '保存失败', 'err', 6000);
    return;
  }

  // 同步本地缓存，避免「未保存修改」的脏标记干扰
  STATE.data.darkreader = mode;
  STATE.data.darkreaderTheme = { engine, brightness, contrast };

  if (res.applied) {
    toast(`已保存并立即生效（${res.applied} 个页面）。`, 'ok', 5000);
    $('drHint').textContent = `已应用到 ${res.applied} 个页面`;
  } else if (res.reason) {
    toast(`已保存。${res.reason}`, 'ok', 6000);
    $('drHint').textContent = '已保存到 profile';
  } else {
    toast('已保存。该应用当前没有运行中的注入，下次启动时生效。', 'ok', 5000);
    $('drHint').textContent = '已保存到 profile';
  }
  await refreshProfiles();
  renderDetail(true);
}

// ─────────────────────────── 自定义 CSS ───────────────────────────

async function loadCustomCss() {
  if (!STATE.current) return;
  const res = await api().get_custom_css(STATE.current);
  if (!res) return;
  if (res.ok === false) {
    $('cssStatus').textContent = res.error || '读取失败';
    return;
  }
  $('cssEditor').value = res.css || '';
  STATE.cssDirty = false;
  $('cssPathHint').textContent = res.exists ? '（已有片段）' : '（尚未创建，保存后自动创建）';
  $('cssStatus').textContent = '';
}

async function saveCustomCss() {
  if (!STATE.current) return;
  const css = $('cssEditor').value;
  const res = await api().save_custom_css(STATE.current, css);
  if (!res) { toast('界面桥未就绪', 'err'); return; }
  if (res.ok === false) {
    toast(res.error || '保存失败', 'err', 5000);
    return;
  }
  STATE.cssDirty = false;

  // 如果该应用正在被注入，注入器会通过热重载自动重新注入
  const running = STATE.sessions.find((s) => s.profile === STATE.current && s.running);
  if (running) {
    toast('已保存。注入器会自动重新注入（无需重启应用）。', 'ok', 5000);
    $('cssStatus').textContent = '已保存 · 等待热重载';
    setTimeout(() => { $('cssStatus').textContent = ''; }, 3000);
  } else {
    toast('已保存。该应用当前没有运行中的注入，下次启动时生效。', 'ok', 5000);
  }
  await loadCustomCss();
}

// ─────────────────────────── 新建向导 ───────────────────────────

function openWizard() {
  STATE.wizard = { exe: null, probe: null, name: null };
  $('wizExe').value = '';
  $('wizProbeResult').classList.add('hidden');
  $('wizProbeResult').innerHTML = '';
  $('wizForm').innerHTML = '';
  $('wizRunning').classList.add('hidden');
  $('wizCreate').disabled = true;
  $('wizStatus').textContent = '';
  $('wizard').classList.remove('hidden');
}

function closeWizard() {
  $('wizard').classList.add('hidden');
  STATE.wizard = null;
}

async function wizBrowse() {
  const res = await api().pick_exe();
  if (!res) return;
  if (res.ok === false) {
    if (res.cancelled) return;
    toast(res.error || '选择失败', 'err', 3600);
    return;
  }
  $('wizExe').value = res.exe;
}

async function wizFromRunning() {
  const box = $('wizRunning');
  box.innerHTML = '<p class="dim tiny" style="padding:8px">读取进程列表…</p>';
  box.classList.remove('hidden');

  const res = unwrap(await api().list_running(), true);
  const procs = (res && res.processes) || [];
  if (!procs.length) {
    box.innerHTML = '<p class="dim tiny" style="padding:8px">没读到可用的进程。</p>';
    return;
  }
  box.innerHTML = procs.map((p) => `
    <div class="running-item" data-exe="${esc(p.exe)}">
      <span class="pn">${esc(p.processName)}</span>
      <span class="pp">${esc(p.exe)}</span>
    </div>`).join('');

  box.querySelectorAll('.running-item').forEach((el) => {
    el.onclick = () => {
      $('wizExe').value = el.dataset.exe;
      box.classList.add('hidden');
    };
  });
}

async function wizProbe() {
  const exe = $('wizExe').value.trim();
  if (!exe) { toast('请先填写或选择 exe 路径', 'warn'); return; }

  $('wizStatus').textContent = '探测中…';
  $('wizProbeResult').classList.add('hidden');
  $('wizCreate').disabled = true;

  // 直接拿结构化结果（不经过日志通道），一次调用搞定
  const res = await api().probe_json(exe, true);
  $('wizStatus').textContent = '';

  if (!res || res.ok === false) {
    toast((res && res.error) || '探测失败', 'err', 6000);
    return;
  }

  STATE.wizard.probe = res.data;
  STATE.wizard.name = res.data.suggested.name;
  // 渲染表单前强制刷新一次 profile 列表：suggestPort() 从 STATE.profiles
  // 算"已用端口"，而那份数据有 5 秒 TTL 缓存 —— 刚建的 profile 可能还不在
  // 里面，于是分配到同一个端口（这就是「连续新建撞端口」的成因）。
  // force=true 绕过缓存（多跑两个 node，但只在打开向导时发生一次）。
  await refresh(true);
  renderWizardResult(res.data);
  $('wizCreate').disabled = false;
}

function renderWizardResult(pr) {
  const c = pr.conclusions || {};
  const d = pr.detected || {};
  const rows = [
    ['Electron', pr.electron || '未识别'],
    ['fuse 项数', pr.fuses ? pr.fuses.count : '未找到'],
    ['已加固', pr.fuses && pr.fuses.hardened.length ? pr.fuses.hardened.join(', ') : '无'],
    ['页面内毛玻璃', yn(c.hasPageGlass)],
    ['窗口层玻璃', yn(c.windowLayerGlass)],
    ['单实例锁', yn(c.singleInstance)],
    ['--native', c.canUseNative ? '可用' : '不可用'],
  ];
  const box = $('wizProbeResult');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="card">
      <div class="facts">
        ${rows.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
      </div>
      ${(pr.warnings || []).length ? `<p class="hint">${pr.warnings.map(esc).join('<br>')}</p>` : ''}
    </div>`;

  // 预填向导表单
  $('wizForm').innerHTML = `
    <div class="field">
      <label>profile 名</label>
      <input id="wizName" value="${esc(pr.suggested.name)}">
      <span class="note">用于文件名与 styleId，只能含字母数字点下划线连字符</span>
    </div>
    <div class="field">
      <label>显示名</label>
      <input id="wizDisplay" value="${esc(pr.suggested.displayName)}">
    </div>
    <div class="field">
      <label>进程名</label>
      <input id="wizProc" value="${esc(pr.suggested.processName)}">
    </div>
    <div class="field">
      <label>CDP 端口</label>
      <input id="wizPort" type="number" value="${suggestPort()}">
      <span class="note">已避开其他 profile 占用的端口</span>
    </div>
    <div class="field wide">
      <label>保留端口（该应用自身占用的）</label>
      <input id="wizReserved" placeholder="逗号分隔，可留空">
    </div>`;
}

function suggestPort() {
  const used = new Set(STATE.profiles.map((p) => p.port).filter((x) => x != null));
  let port = 9333;
  while (used.has(port)) port += 10;
  return port;
}

async function wizCreate() {
  const pr = STATE.wizard && STATE.wizard.probe;
  if (!pr) return;

  const name = $('wizName').value.trim();
  const display = $('wizDisplay').value.trim() || name;
  const proc = $('wizProc').value.trim();
  const port = Number($('wizPort').value);
  const reserved = $('wizReserved').value.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n > 0);

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    toast('profile 名只能含字母、数字、点、下划线、连字符', 'err', 5000);
    return;
  }
  if (Number.isNaN(port)) { toast('端口必须是数字', 'err'); return; }

  const data = {
    name,
    displayName: display,
    exe: pr.exe,
    exeGlob: null,
    processName: proc || name,
    styleId: `__noglass_${name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
    defaultPort: port,
    reservedPorts: reserved,
    singleInstance: (pr.detected || {}).singleInstance === undefined ? null : pr.detected.singleInstance,
    isolateEnv: null,
    dataDirEnv: null,
    urlFilter: null,
    css: null,
    native: { enabled: false, darkBg: '#161616', lightBg: '#f8f8f8', darkSymbol: '#f5f5f5', lightSymbol: '#1f1f1f' },
    notes: { watchRequired: null, portConflict: null, extra: null },
    detected: pr.detected || null,
  };

  const res = await api().create_profile(name, data);
  if (!res || res.ok === false) {
    toast((res && res.error) || '创建失败', 'err', 6000);
    return;
  }

  toast(`已创建 ${name}。正在生成启动器…`, 'ok');
  closeWizard();
  await api().run_task('build', name);
  focusTaskTab();            // 生成过程有输出，切过去让用户看见
  await refresh();
  await selectProfile(name);
}

// ─────────────────────────── 开机自启动 ───────────────────────────

/**
 * 打开「开机自启动」弹窗。
 *
 * 为什么是全局弹窗而不是详情区卡片：自启动是**全局**设置（一个中转器拉起
 * 所有启用的应用），而详情区在没选中 profile 时整体隐藏 —— 放里面会看不到。
 */
async function openAutostart() {
  $('autostartModal').classList.remove('hidden');
  $('asStatus').textContent = '';
  $('asRunners').classList.add('hidden');
  await loadAutostartState();
}

function closeAutostart() {
  $('autostartModal').classList.add('hidden');
}

async function loadAutostartState() {
  const res = unwrap(await api().get_autostart_state(), true);
  if (!res) {
    $('asStatus').textContent = '读取自启动状态失败';
    return;
  }
  STATE.autostart = res;

  // ── profile 勾选列表 ──
  const enabledSet = new Set((res.enabled || []).map((x) => x.name));
  const legacySet = new Set((res.legacy || []).map((x) => x.profile));
  const list = $('asList');
  const names = res.profiles || [];
  if (!names.length) {
    list.innerHTML = '<p class="dim tiny">还没有 profile。</p>';
  } else {
    list.innerHTML = names.map((n) => {
      const on = enabledSet.has(n);
      const legacy = legacySet.has(n) ? '<span class="tag legacy" title="存在旧式启动项">旧</span>' : '';
      return `
        <label class="as-item">
          <input type="checkbox" data-as-name="${esc(n)}" ${on ? 'checked' : ''}>
          <span class="nm">${esc(n)}</span>
          ${legacy}
          <span class="tag${on ? '' : ' hidden'}">已启用</span>
        </label>`;
    }).join('');
  }

  // ── 中转器状态 ──
  const relay = res.relay || {};
  $('asRelayState').textContent = relay.exists
    ? '中转器快捷方式已创建（启用任一应用时自动维护）。'
    : '中转器快捷方式尚未创建 —— 勾选任一应用后会自动创建。';

  // ── 节奏与开关 ──
  const st = res.settings || {};
  $('asInitial').value = Math.round((st.initialDelayMs || 0) / 1000);
  $('asDelay').value = Math.round((st.delayMs || 0) / 1000);
  $('asNeverWarn').checked = !!st.neverWarnStartup;
  $('asNeverPrompt').checked = !!st.neverPromptDelete;
  $('asRunnerState').textContent = st.pythonw
    ? `手动指定：${st.pythonw}`
    : '自动检测';

  updateAutostartEstimate();
}

/** 显示「预计 N 秒内全部启动」。 */
function updateAutostartEstimate() {
  const n = $('asList').querySelectorAll('input[type=checkbox]:checked').length;
  const initial = Number($('asInitial').value) || 0;
  const delay = Number($('asDelay').value) || 0;
  if (!n) {
    $('asEstimate').textContent = '当前没有勾选任何应用。';
    return;
  }
  const total = initial + delay * Math.max(0, n - 1);
  $('asEstimate').textContent = `预计 ${total} 秒内全部启动（${n} 个应用，最后一个在第 ${total} 秒）。`;
}

/** 勾选/取消某个 profile 的自启动（立即生效，不等“保存设置”）。 */
async function toggleAutostart(name, enabled) {
  const res = await api().set_autostart(name, enabled);
  if (!res || res.ok === false) {
    toast((res && res.error) || '操作失败', 'err', 6000);
    await loadAutostartState();
    return;
  }
  // 关掉最后一项时，问是否删除中转器
  if (!enabled && res.shouldPromptDelete) {
    const st = STATE.autostart && STATE.autostart.settings;
    if (!(st && st.neverPromptDelete)) {
      const del = window.confirm(
        '现在没有任何应用启用自启动了。\n\n'
        + '要删除中转器快捷方式吗？\n'
        + '（留着的话，开机它会起来、发现没东西可启动、然后退出）'
      );
      if (del) await api().remove_relay_lnk();
    }
  }
  toast(enabled ? `已启用 ${name} 的开机自启动` : `已关闭 ${name} 的开机自启动`, 'ok');
  await loadAutostartState();
  await refresh();
}

/** 检测可用的 pythonw（真跑一次）。 */
async function detectRunners() {
  $('asRunnerState').textContent = '检测中…（会真的运行每个候选，约几秒）';
  const res = await api().detect_pythonw();
  const box = $('asRunners');
  box.classList.remove('hidden');
  if (!res || res.ok === false) {
    $('asRunnerState').textContent = '检测失败：' + ((res && res.error) || '未知错误');
    return;
  }
  $('asRunnerState').textContent = res.selected
    ? '当前会使用：' + res.selected
    : '没有可用运行器';
  box.innerHTML = (res.items || []).map((it) => `
    <div class="as-runner ${it.ok ? '' : 'bad'}" data-runner="${esc(it.path)}" data-ok="${it.ok ? '1' : '0'}">
      <span>${it.ok ? '✓' : '✗'}</span>
      <span style="flex:1">${esc(it.path)}</span>
      <span class="ver">${esc(it.version || '不可用')}</span>
      ${it.selected ? '<span class="pick">当前</span>' : ''}
    </div>`).join('') || '<p class="dim tiny">没有找到任何候选。</p>';
}

async function saveAutostartSettings() {
  const patch = {
    initialDelayMs: Math.max(0, Math.min(120, Number($('asInitial').value) || 0)) * 1000,
    delayMs: Math.max(0, Math.min(120, Number($('asDelay').value) || 0)) * 1000,
    neverWarnStartup: $('asNeverWarn').checked,
    neverPromptDelete: $('asNeverPrompt').checked,
  };
  const res = await api().set_autostart_settings(patch);
  if (!res || res.ok === false) {
    toast((res && res.error) || '保存失败', 'err', 6000);
    return;
  }
  if (res.relayWarning) toast('设置已保存，但重建中转器失败：' + res.relayWarning, 'warn', 8000);
  else toast('自启动设置已保存', 'ok');
  await loadAutostartState();
}

// ─────────────────────────── 绑定 ───────────────────────────

function bindUI() {
  $('btnRefresh').onclick = refresh;
  $('btnTheme').onclick = cycleTheme;
  $('btnNew').onclick = openWizard;
  // 开机自启动弹窗
  $('btnAutostart').onclick = openAutostart;
  $('asClose').onclick = closeAutostart;
  $('asClose2').onclick = closeAutostart;
  $('asSave').onclick = saveAutostartSettings;
  $('asDetect').onclick = detectRunners;
  $('asOpenUser').onclick = () => api().open_startup_folder('user');
  $('asOpenSystem').onclick = () => api().open_startup_folder('system');
  // 勾选变化：立即生效 + 更新预计时间
  $('asList').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb && cb.dataset && cb.dataset.asName) {
      toggleAutostart(cb.dataset.asName, cb.checked);
    }
  });
  // 点运行器行：切到手动指定
  $('asRunners').addEventListener('click', async (e) => {
    const row = e.target.closest('.as-runner');
    if (!row) return;
    if (row.dataset.ok !== '1') {
      toast('这个候选实测不可用，不能选它', 'warn');
      return;
    }
    const p = row.dataset.runner;
    const r = await api().set_autostart_settings({ pythonw: p });
    if (r && r.ok) {
      toast('已切换到该运行器，并重建中转器', 'ok');
      if (r.relayWarning) toast('但重建中转器失败：' + r.relayWarning, 'warn', 8000);
      await loadAutostartState();
    } else {
      toast((r && r.error) || '切换失败', 'err');
    }
  });
  $('asInitial').addEventListener('input', updateAutostartEstimate);
  $('asDelay').addEventListener('input', updateAutostartEstimate);
  $('btnDoctor').onclick = async () => {
    unwrap(await api().run_task('doctor'));
    focusTaskTab();          // 输出在任务标签里，切过去才看得见
    setTimeout(refresh, 1500);
  };
  $('btnLaunch').onclick = launchInjector;
  $('btnAdoptArgs').onclick = adoptAppArgs;
  $('btnStop').onclick = stopTask;
  $('btnSave').onclick = saveProfile;
  $('btnBuild').onclick = buildProfile;
  $('btnRevert').onclick = () => {
    if (STATE.current) selectProfile(STATE.current);
    toast('已撤销未保存的修改', 'ok');
  };
  $('btnClearLog').onclick = async () => {
    const key = STATE.activeSession;
    if (key === TASK_KEY) {
      // 任务标签：清前端缓冲 + 让后端把游标推到当前（这样旧行不会重新拉回来）
      STATE.logBuffers[TASK_KEY] = { lines: [], cursor: 0, scrollTop: null, atBottom: true };
      const res = await api().clear_logs();
      if (res && res.ok) STATE.logBuffers[TASK_KEY].cursor = res.cursor;
      $('log').innerHTML = '<span class="l-dim">（已清空显示；新输出会继续出现）</span>';
    } else if (key) {
      // 只清当前会话的缓冲（其他会话的历史不该被连带清掉）
      STATE.logBuffers[key] = { lines: [], cursor: 0, scrollTop: null, atBottom: true };
      $('log').innerHTML = '<span class="l-dim">（已清空显示；新输出会继续出现）</span>';
      // 注意：不清后端缓冲 —— 它通过 get_session_log 的游标取增量，
      // 把前端游标归零反而会把旧内容重新拉回来（后端 _seq 只增不减）。
      await pollSessionLog();
    }
  };
  $('btnPrune').onclick = async () => {
    const res = await api().prune_sessions();
    if (res && res.ok) {
      toast(res.removed ? `已清理 ${res.removed} 个残留注册项` : '没有需要清理的', 'ok');
      await updateTaskUI();
    }
  };
  $('btnSaveCss').onclick = saveCustomCss;
  $('btnReloadCss').onclick = loadCustomCss;

  $('btnApplyDr').onclick = applyDarkreader;
  // 滑块实时显示数值（真正的应用要等点按钮，避免拖动时反复调后端）
  $('drBright').addEventListener('input', () => {
    $('drBrightVal').textContent = $('drBright').value;
    $('drHint').textContent = '未应用';
  });
  $('drContrast').addEventListener('input', () => {
    $('drContrastVal').textContent = $('drContrast').value;
    $('drHint').textContent = '未应用';
  });
  $('drMode').addEventListener('change', () => { $('drHint').textContent = '未应用'; });
  $('drEngine').addEventListener('change', () => { $('drHint').textContent = '未应用'; });

  $('cssEditor').addEventListener('input', () => {
    STATE.cssDirty = true;
    $('cssStatus').textContent = '未保存';
  });

  $('wizClose').onclick = closeWizard;
  $('wizCancel').onclick = closeWizard;
  $('wizBrowse').onclick = wizBrowse;
  $('wizFromRunning').onclick = wizFromRunning;
  $('wizProbe').onclick = wizProbe;
  $('wizCreate').onclick = wizCreate;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('wizard').classList.contains('hidden')) closeWizard();
  });
}
