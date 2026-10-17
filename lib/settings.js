'use strict';
/**
 * settings.js —— 本机设置（`local/autostart.json`）
 *
 * 为什么单独一个模块：
 *   · Node 侧（gen.js）与 Python 侧（ui/app.py）都要读写同一份设置，
 *     格式必须一致。放一个地方定义，两边都按这个契约来。
 *   · 文件**可能不存在**（别人 clone 下来、或用户删了）—— 那种情况用内置默认值，
 *     不报错。这是刻意的：设置文件是可选的，不是必需品。
 *
 * 为什么默认值写在代码里、不提供模板文件：
 *   少一个文件，少一处可能不同步的地方。`local/` 整个不进仓库，
 *   模板放那儿也没用。
 *
 * ⚠️ 与 `ui/app.py` 的 `read_autostart_settings()` 保持一致。
 *    改字段时两边都要改（Python 那边是同样的默认值字典）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'local', 'autostart.json');

/**
 * 默认设置。
 *
 * initialDelayMs：开机后等多久再启动第一个。8 秒是"等系统稳定"与"用户等待"
 *   之间的折中 —— 15 秒太久（开机想立刻用应用会觉得没反应），
 *   太短则可能与系统自身的启动负载撞在一起。
 * delayMs：逐条之间的间隔，给上一个应用留启动缓冲。
 * neverPromptDelete：关闭最后一项时不再询问是否删除中转项。
 * neverWarnStartup：中转器发现"没有任何启用项"时不再拉 UI 警告。
 * pythonw：null = 自动检测；字符串 = 手动指定的绝对路径；"" = 明确不用。
 */
const DEFAULTS = {
  initialDelayMs: 8000,
  delayMs: 6000,
  neverPromptDelete: false,
  neverWarnStartup: false,
  pythonw: null,
};

/** 读设置。文件不存在/损坏时返回默认值（不抛错）。 */
function read() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };

  // 只取认识的字段，且校验类型 —— 用户手改坏一个值不该让整个功能崩掉。
  const out = { ...DEFAULTS };
  if (Number.isFinite(raw.initialDelayMs) && raw.initialDelayMs >= 0) {
    out.initialDelayMs = Math.min(raw.initialDelayMs, 120000);
  }
  if (Number.isFinite(raw.delayMs) && raw.delayMs >= 0) {
    out.delayMs = Math.min(raw.delayMs, 120000);
  }
  if (typeof raw.neverPromptDelete === 'boolean') out.neverPromptDelete = raw.neverPromptDelete;
  if (typeof raw.neverWarnStartup === 'boolean') out.neverWarnStartup = raw.neverWarnStartup;
  if (raw.pythonw === null || typeof raw.pythonw === 'string') out.pythonw = raw.pythonw;
  return out;
}

/** 写设置（合并式）。只写认识的字段。 */
function write(patch) {
  const cur = read();
  const next = { ...cur };
  if (patch && typeof patch === 'object') {
    if (Number.isFinite(patch.initialDelayMs)) next.initialDelayMs = patch.initialDelayMs;
    if (Number.isFinite(patch.delayMs)) next.delayMs = patch.delayMs;
    if (typeof patch.neverPromptDelete === 'boolean') next.neverPromptDelete = patch.neverPromptDelete;
    if (typeof patch.neverWarnStartup === 'boolean') next.neverWarnStartup = patch.neverWarnStartup;
    if (patch.pythonw === null || typeof patch.pythonw === 'string') next.pythonw = patch.pythonw;
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // 先写临时文件再改名：避免写一半断电留下损坏的 JSON
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
    return { ok: true, path: FILE, settings: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { read, write, DEFAULTS, FILE };
