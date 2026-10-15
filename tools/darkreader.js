'use strict';
/*
 * darkreader.js —— 用 Dark Reader 的纯 JS 引擎给正在运行的 Electron 应用上深色。
 *
 * 为什么用纯 JS 而不是浏览器扩展：
 *   实测 Electron 里扩展的 content_scripts 匹配不上自定义协议
 *   （app:// 协议被 manifest 校验直接拒：Invalid scheme），<all_urls> 也不覆盖。
 *   而 Dark Reader 的 API 构建（npm 包）不依赖任何扩展 API —— 它自己会
 *   给 chrome.runtime 打桩，所以能整份注入页面跑。
 *
 * 用法：
 *   node tools/darkreader.js <调试端口> auto     跟随系统（推荐）
 *   node tools/darkreader.js <调试端口> dark     强制深色
 *   node tools/darkreader.js <调试端口> light    强制浅色（=关闭）
 *   node tools/darkreader.js <调试端口> off      卸载，恢复原样
 *
 * 依赖 run/_dr/package/darkreader.js（npm 包 darkreader，MIT）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || 9343);
const MODE = process.argv[3] || 'auto';

// 可选参数：--engine <name> / --brightness <n> / --contrast <n>
// （UI 会带这些参数调本脚本，这样「保存并立即生效」不用重启注入器）
function optValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const OPT_ENGINE = optValue('--engine');
const OPT_BRIGHTNESS = optValue('--brightness');
const OPT_CONTRAST = optValue('--contrast');

// 引擎位置：优先 vendor/（正式位置），退回 run/_dr（早期测试时下载的）
const ENGINE_CANDIDATES = [
  path.resolve(__dirname, '..', 'vendor', 'darkreader.js'),
  path.resolve(__dirname, '..', 'run', '_dr', 'package', 'darkreader.js'),
];

const DR_VERSION = '4.9.133';

function findEngine() {
  for (const p of ENGINE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// 引擎缺失时自动下载一次（npm 包内含 API 构建，MIT 许可）。
// npm registry 直连即可；若不通，让用户自己下 —— 不猜代理端口。
function ensureEngine() {
  let p = findEngine();
  if (p) return p;
  const dest = ENGINE_CANDIDATES[0];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tgz = path.join(path.dirname(dest), '_dl.tgz');
  const url = `https://registry.npmjs.org/darkreader/-/darkreader-${DR_VERSION}.tgz`;
  console.log(`引擎缺失，尝试下载 darkreader@${DR_VERSION} …`);
  try {
    execFileSync('curl', ['-sL', '--max-time', '90', '-o', tgz, url], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', tgz, '-C', path.dirname(dest), '--strip-components=1', 'package/darkreader.js'], { stdio: 'inherit' });
    fs.unlinkSync(tgz);
  } catch (e) {
    console.error(`下载失败：${e.message}`);
    console.error('手动下载：');
    console.error(`  curl -sL -o dr.tgz ${url}`);
    console.error(`  tar -xzf dr.tgz package/darkreader.js`);
    console.error(`  把 package/darkreader.js 放到 ${dest}`);
    process.exit(1);
  }
  p = findEngine();
  if (!p) { console.error('下载后仍找不到引擎文件。'); process.exit(1); }
  console.log(`已就绪：${p}`);
  return p;
}

const DR_PATH = ensureEngine();
const SRC = fs.readFileSync(DR_PATH, 'utf8');

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('CDP 连接失败'));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  return {
    ready,
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const myId = ++id;
        pending.set(myId, { res, rej });
        ws.send(JSON.stringify({ id: myId, method, params }));
        setTimeout(() => {
          if (pending.has(myId)) { pending.delete(myId); rej(new Error(`${method} 超时`)); }
        }, 45000);
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

// 主题参数：命令行可覆盖（UI 的滑块走这里）
const OPTIONS = {
  brightness: OPT_BRIGHTNESS != null ? Number(OPT_BRIGHTNESS) : 100,
  contrast: OPT_CONTRAST != null ? Number(OPT_CONTRAST) : 100,
  sepia: 0,
};
// 引擎锁 dynamicTheme（效果最好，保留品牌色）；filter 类会把彩色一起反掉。
if (OPT_ENGINE) OPTIONS.engine = OPT_ENGINE;

// 每个页面各自执行。整份引擎注入一次，之后只调 API。
//
// 为什么每次都先 disable() 再启用：Dark Reader 在"已启用"状态下会把
// enable() 的参数与上一次比对，若主题选项相同就跳过重算 —— 于是改了
// brightness 却看不到变化（实测：dark(60) 之后回 auto 仍停在暗的）。
// 先关再开，保证新参数一定被重新应用。
function scriptFor(mode) {
  const ensure = `if (typeof DarkReader === 'undefined') { ${SRC} }`;
  const reset = `if (typeof DarkReader !== 'undefined' && DarkReader.isEnabled()) DarkReader.disable();`;
  switch (mode) {
    case 'dark':
      return `${ensure}
        ${reset}
        DarkReader.auto(false);
        DarkReader.enable(${JSON.stringify(OPTIONS)});
        JSON.stringify({ mode: 'dark', enabled: DarkReader.isEnabled(), opts: ${JSON.stringify(OPTIONS)} });`;
    case 'light':
      // 强制浅色 = 确保不启用
      return `${ensure}
        DarkReader.auto(false);
        DarkReader.disable();
        JSON.stringify({ mode: 'light', enabled: typeof DarkReader !== 'undefined' && DarkReader.isEnabled() });`;
    case 'auto':
      // auto() 读 matchMedia('(prefers-color-scheme: dark)')，跟随系统
      return `${ensure}
        ${reset}
        DarkReader.auto(${JSON.stringify(OPTIONS)});
        JSON.stringify({
          mode: 'auto',
          enabled: DarkReader.isEnabled(),
          systemPrefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
          opts: ${JSON.stringify(OPTIONS)}
        });`;
    case 'off':
      return `(() => {
        if (typeof DarkReader === 'undefined') return JSON.stringify({ mode: 'off', note: '引擎未加载' });
        try { DarkReader.auto(false); DarkReader.disable(); } catch (e) {}
        document.querySelectorAll('style[class*="darkreader"]').forEach((el) => el.remove());
        document.documentElement.classList.forEach((c) => {
          if (c.startsWith('darkreader')) document.documentElement.classList.remove(c);
        });
        document.documentElement.style.removeProperty('background-color');
        return JSON.stringify({ mode: 'off', tags: document.querySelectorAll('style[class*="darkreader"]').length });
      })()`;
    default:
      throw new Error(`未知模式：${mode}（可用 auto / dark / light / off）`);
  }
}

(async () => {
  let pages;
  try {
    pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch (e) {
    console.error(`连不上调试端口 ${PORT}：${e.message}`);
    console.error('（应用需带 --remote-debugging-port 启动，用本工具的启动器即可）');
    process.exit(1);
  }
  const targets = pages.filter((t) => t.type === 'page');
  if (!targets.length) { console.error('没有可注入的页面。'); process.exit(1); }

  console.log(`模式 ${MODE} → ${targets.length} 个页面`);
  const expr = scriptFor(MODE);

  for (const t of targets) {
    const c = cdp(t.webSocketDebuggerUrl);
    try {
      await c.ready;
      await c.send('Runtime.enable');
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) {
        console.log(`  ✗ ${t.url.slice(0, 60)}`);
        console.log('    ', JSON.stringify(r.exceptionDetails).slice(0, 200));
      } else {
        console.log(`  ✓ ${t.url.slice(0, 60)}`);
        console.log(`    ${r.result.value}`);
      }
    } catch (e) {
      console.log(`  ✗ ${t.url.slice(0, 60)} -> ${e.message}`);
    } finally {
      c.close();
    }
  }

  if (MODE === 'auto') {
    console.log('\n注：auto 模式下，切换 Windows 深/浅色会即时生效（DarkReader 监听 matchMedia 变化）。');
    console.log('    当前页面感知：prefersDark=' +
      (await systemPrefersDark(PORT)));
  }
})();

async function systemPrefersDark(port) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = pages.find((x) => x.type === 'page');
    if (!t) return '未知';
    const c = cdp(t.webSocketDebuggerUrl);
    await c.ready;
    const r = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify(matchMedia('(prefers-color-scheme: dark)').matches)`,
      returnByValue: true,
    });
    c.close();
    return r.result.value;
  } catch { return '未知'; }
}
