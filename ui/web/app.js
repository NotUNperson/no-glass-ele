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
  logCursor: 0,        // 短任务日志游标
  taskRunning: false,
  sessions: [],        // 运行中的注入会话
  activeSession: null, // 当前查看日志的会话 key（localId 或 id）
  sessionCursors: {},  // key -> 游标（每个会话独立）
  cssDirty: false,
  wizard: null,        // 向导状态
};

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
    if (!quiet) toast(res.error || '操作失败', res.forbidden ? 'warn' : 'err', res.forbidden ? 6000 : 3600);
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
}

async function refresh() {
  const res = unwrap(await api().get_overview());
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
  if (d.electron) badges.push(`<span class="badge">Electron ${esc(d.electron)}</span>`);
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
  const facts = [
    ['exe', p.exe ? (meta.exeExists ? '存在' : '不存在') : '未设置', p.exe ? (meta.exeExists ? 'yes' : 'no') : 'unk'],
    ['进程名', p.processName || '—', ''],
    ['CDP 端口', p.defaultPort != null ? p.defaultPort : '—', ''],
    ['页面内毛玻璃', yn(d.hasPageGlass), d.hasPageGlass === true ? 'yes' : d.hasPageGlass === false ? 'unk' : 'unk'],
    ['窗口层玻璃', yn(d.windowLayerGlass), d.windowLayerGlass === true ? 'yes' : 'unk'],
    ['单实例锁', yn(d.singleInstance), d.singleInstance === true ? 'yes' : 'unk'],
    ['userData 被覆盖', yn(d.userDataOverride), d.userDataOverride === true ? 'yes' : 'unk'],
    ['--native', d.canUseNative === false ? '不可用' : '可用', d.canUseNative === false ? 'no' : 'yes'],
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

  if (keepScroll) $('.pane-detail').scrollTop = scrollTop;
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

async function buildProfile() {
  if (!STATE.current) return;
  const res = unwrap(await api().run_task('build', STATE.current));
  if (!res) return;
  toast('开始生成启动器…', 'ok');
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
    toast(res.error || '启动失败', res.forbidden ? 'warn' : 'err', res.forbidden ? 7000 : 4000);
    return;
  }
  toast('已启动注入器（--watch 常驻）', 'ok');
  // 立刻切到这个会话的日志
  if (res.localId) STATE.activeSession = res.localId;
  await refresh();
  await updateTaskUI();
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

async function stopTask() {
  // 旧的「停止」按钮：停当前选中的会话，没有就停任意一个
  const key = STATE.activeSession;
  if (key) return stopSession(key);
  const running = STATE.sessions.find((s) => s.running);
  if (running) return stopSession(running.localId || running.id);
  toast('没有运行中的注入会话', 'warn');
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
  const mine = sess.find((s) => s.profile === cur && s.running);
  $('btnStop').disabled = !mine && !STATE.taskRunning;
  $('btnLaunch').disabled = !!mine;
}

function renderSessionTabs() {
  const box = $('sessionTabs');
  // 只显示有 key 的（后端保证非空；这里再兜一层，防御脏数据）
  const live = STATE.sessions.filter((s) => s.key);

  // 若当前查看的会话没了，回退到第一个
  const keys = live.map((s) => s.key);
  if (STATE.activeSession && !keys.includes(STATE.activeSession)) {
    STATE.activeSession = keys[0] || null;
  }
  if (!STATE.activeSession && keys.length) STATE.activeSession = keys[0];

  box.innerHTML = live.map((s) => {
    const key = s.key;
    const nm = s.displayName || s.profile || '(未知)';
    const cls = ['stab'];
    if (s.running) cls.push('run'); else cls.push('dead');
    if (key === STATE.activeSession) cls.push('active');
    const port = s.port != null ? `<span class="pt">:${s.port}</span>` : '';
    const ext = s.external ? '<span class="ext" title="外部启动的注入器（无实时日志，可看磁盘日志）">外部</span>' : '';
    const x = s.running ? `<span class="x" data-stop="${esc(key)}" title="停止（不关应用）">✕</span>` : '';
    return `<span class="${cls.join(' ')}" data-key="${esc(key)}" title="${esc(nm)}">
      <span class="dot"></span><span class="nm">${esc(nm)}</span>${port}${ext}${x}
    </span>`;
  }).join('');

  // 切标签
  box.querySelectorAll('.stab').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.stop) return;   // 点的是 ✕
      const k = el.dataset.key;
      if (!k) return;                      // 没有 key 就不切（不该发生）
      if (STATE.activeSession === k) return;  // 重复点同一个：不重绘，避免闪
      STATE.activeSession = k;
      $('log').innerHTML = '';
      $('logTitle').textContent = '输出 · 加载中…';
      renderSessionTabs();
      pollSessionLog();
    };
  });
  // 停止按钮
  box.querySelectorAll('[data-stop]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      stopSession(el.dataset.stop);
    };
  });

  const cur = STATE.sessions.find((s) => s.key === STATE.activeSession);
  $('logTitle').textContent = cur
    ? `输出 · ${cur.displayName || cur.profile}${cur.external ? '（外部）' : ''}`
    : '输出';
}

/**
 * 轮询当前选中会话的日志。
 * 每个会话有独立游标，所以切标签不会互相污染。
 */
async function pollSessionLog() {
  const key = STATE.activeSession;
  if (!key) {
    // 没有会话时退回短任务日志
    return pollTaskLog();
  }
  const s = STATE.sessions.find((x) => x.key === key);
  if (!s) {
    // 会话可能刚好消失了 —— 不要静默留空白，给一句提示
    const box = $('log');
    if (!box.textContent.trim()) {
      box.innerHTML = '<span class="l-dim">（该会话已结束）</span>';
    }
    return;
  }

  const cursor = STATE.sessionCursors[key] || 0;
  const res = await api().get_session_log(
    s.localId || null, s.id || null, cursor, s.pid || null
  );
  if (!res || res.ok === false) {
    // 后端明确报错时也要让用户看见，而不是留一片空白
    const box = $('log');
    if (!box.textContent.trim()) {
      box.innerHTML = `<span class="l-err">（读日志失败：${esc((res && res.error) || '未知错误')}）</span>`;
    }
    return;
  }

  if (res.live) {
    STATE.sessionCursors[key] = res.cursor;
    appendLog(res.lines || []);
    if (!res.lines.length && !$('log').textContent.trim()) {
      $('log').innerHTML = '<span class="l-dim">（该会话暂无输出）</span>';
    }
  } else {
    // 外部会话：整段返回，直接替换显示（避免重复追加）
    const box = $('log');
    if (res.lines && res.lines.length) {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = res.lines
        .map((l) => `<span class="${classify(l)}">${esc(l)}</span>`).join('\n');
      if ($('optFollow').checked && atBottom) box.scrollTop = box.scrollHeight;
    } else if (!box.textContent.trim()) {
      box.innerHTML = `<span class="l-dim">（${esc(res.note || '该会话没有日志')}）</span>`;
    }
  }
}

/** 短任务日志（probe / build / doctor）—— 没有会话时显示这个。 */
async function pollTaskLog() {
  const res = await api().get_logs(STATE.logCursor);
  if (!res || res.ok === false) return;
  STATE.logCursor = res.cursor;
  appendLog(res.lines || []);
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

function appendLog(lines) {
  if (!lines.length) return;
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const html = lines.map((l) => `<span class="${classify(l)}">${esc(l)}</span>`).join('\n');
  box.insertAdjacentHTML('beforeend', (box.textContent ? '\n' : '') + html);

  // 限制 DOM 节点数，避免长时间运行后卡顿
  if (box.childNodes.length > 6000) {
    for (let i = 0; i < 1500; i++) box.removeChild(box.firstChild);
  }
  if ($('optFollow').checked && atBottom) box.scrollTop = box.scrollHeight;
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
    toast(res.error || '保存失败', res.forbidden ? 'warn' : 'err', 5000);
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
    toast(res.error || '选择失败', res.forbidden ? 'warn' : 'err', res.forbidden ? 7000 : 3600);
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
    toast((res && res.error) || '探测失败', res && res.forbidden ? 'warn' : 'err', 6000);
    return;
  }

  STATE.wizard.probe = res.data;
  STATE.wizard.name = res.data.suggested.name;
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
    toast((res && res.error) || '创建失败', res && res.forbidden ? 'warn' : 'err', 6000);
    return;
  }

  toast(`已创建 ${name}。正在生成启动器…`, 'ok');
  closeWizard();
  await api().run_task('build', name);
  await refresh();
  await selectProfile(name);
}

// ─────────────────────────── 绑定 ───────────────────────────

function bindUI() {
  $('btnRefresh').onclick = refresh;
  $('btnTheme').onclick = cycleTheme;
  $('btnNew').onclick = openWizard;
  $('btnDoctor').onclick = async () => {
    unwrap(await api().run_task('doctor'));
    setTimeout(refresh, 1500);
  };
  $('btnLaunch').onclick = launchInjector;
  $('btnStop').onclick = stopTask;
  $('btnSave').onclick = saveProfile;
  $('btnBuild').onclick = buildProfile;
  $('btnRevert').onclick = () => {
    if (STATE.current) selectProfile(STATE.current);
    toast('已撤销未保存的修改', 'ok');
  };
  $('btnClearLog').onclick = async () => {
    const key = STATE.activeSession;
    if (key) {
      STATE.sessionCursors[key] = 0;
      $('log').innerHTML = '';
      await pollSessionLog();
    } else {
      const res = await api().clear_logs();
      if (res && res.ok) { STATE.logCursor = res.cursor; $('log').innerHTML = ''; }
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
