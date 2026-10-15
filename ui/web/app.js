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
  logCursor: 0,
  taskRunning: false,
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

// ─────────────────────────── 初始化 ───────────────────────────

window.addEventListener('pywebviewready', init);
// 兜底：万一事件已经错过
if (api()) init();

let inited = false;
async function init() {
  if (inited) return;
  inited = true;
  STATE.ready = true;

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

  const res = await api().launch(STATE.current, isolate, extra || null);
  if (!res) { toast('界面桥未就绪', 'err'); return; }
  if (res.ok === false) {
    toast(res.error || '启动失败', res.forbidden ? 'warn' : 'err', res.forbidden ? 7000 : 4000);
    return;
  }
  toast('已启动注入器（--watch 常驻）', 'ok');
  await updateTaskUI();
}

async function stopTask() {
  const res = unwrap(await api().stop_task());
  if (!res) return;
  toast('已停止注入器。目标应用不受影响。', 'ok');
  await updateTaskUI();
}

async function updateTaskUI() {
  const res = await api().get_task_status();
  const running = !!(res && res.ok && res.task && res.task.running);
  STATE.taskRunning = running;
  const b = $('taskBadge');
  if (running) {
    b.textContent = res.task.kind === 'injector' ? '注入中' : '任务运行中';
    b.className = 'badge ok';
  } else {
    b.textContent = '空闲';
    b.className = 'badge';
  }
  $('btnStop').disabled = !running;
  $('btnLaunch').disabled = running;
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
  const res = await api().get_logs(STATE.logCursor);
  if (!res || res.ok === false) return;
  STATE.logCursor = res.cursor;
  appendLog(res.lines || []);
}

function startPolling() {
  const tick = async () => {
    if (!STATE.ready) return;
    try { await pollLogs(); } catch (_) { /* 忽略瞬时错误 */ }
    try { await updateTaskUI(); } catch (_) { /* 忽略 */ }
  };
  setInterval(tick, 300);
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
    const res = await api().clear_logs();
    if (res && res.ok) { STATE.logCursor = res.cursor; $('log').innerHTML = ''; }
  };

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
