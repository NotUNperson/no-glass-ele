'use strict';
/*
 * trigger-window.js —— 触发应用的独立窗口（走应用自己的 IPC 通道）
 *
 * 为什么需要：独立窗口（小组件/编辑窗口/悬浮番茄钟）只在用户操作时创建，
 * 靠"点界面"很难可靠触发。
 *
 * 做法：**直接 emit 应用自己注册的 ipcMain 事件** ——
 * 走的是应用真实的代码路径（同样的窗口参数、同样的 URL），
 * 不是我另外造一个窗口。这样验证的才是真实情况。
 *
 * 只做"打开窗口"，不改数据。
 *
 * 用法：node tools/trigger-window.js <主进程端口> <通道名>
 *   node tools/trigger-window.js 9344 list          # 列出可用通道
 *   node tools/trigger-window.js 9344 show-tomato-floating
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9344);
const CHAN = process.argv[3] || 'list';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d)); })
      .on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 20000);
    });
  }
}

// 从主进程读 ipcMain 上注册的监听器名字。
// Node 的 EventEmitter 可以用 listeners() / eventNames() 读出来。
const LIST_EXPR = `(() => {
  try {
    const { createRequire } = process.getBuiltinModule('module');
    const electron = createRequire(process.execPath)('electron');
    const ipc = electron.ipcMain;
    if (!ipc || typeof ipc.eventNames !== 'function') return JSON.stringify({ ok:false, err:'ipcMain 不支持 eventNames' });
    const names = ipc.eventNames().map(String).sort();
    return JSON.stringify({ ok:true, count:names.length, names });
  } catch (e) { return JSON.stringify({ ok:false, err:e.message }); }
})()`;

const EMIT_EXPR = (chan) => `(() => {
  try {
    const { createRequire } = process.getBuiltinModule('module');
    const electron = createRequire(process.execPath)('electron');
    const ipc = electron.ipcMain;
    const chan = ${JSON.stringify(chan)};
    if (!ipc.eventNames().includes(chan)) {
      return JSON.stringify({ ok:false, err:'主进程没有注册这个通道: ' + chan });
    }
    const before = electron.BrowserWindow.getAllWindows().length;
    // emit 时第一个参数是 event；应用大多不用它，给一个最小 stub
    const fakeEvent = { sender: null, returnValue: undefined, reply: () => {} };
    ipc.emit(chan, fakeEvent);
    const after = electron.BrowserWindow.getAllWindows().length;
    return JSON.stringify({ ok:true, before, after, created: after - before });
  } catch (e) { return JSON.stringify({ ok:false, err:e.message }); }
})()`;

(async () => {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const target = list.find((x) => x.webSocketDebuggerUrl);
  if (!target) { console.log('主进程调试目标不可达'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  if (CHAN === 'list') {
    const r = await cdp.send('Runtime.evaluate', { expression: LIST_EXPR, returnByValue: true });
    const d = JSON.parse(r.result.value);
    if (!d.ok) { console.log('读取失败:', d.err); process.exit(1); }
    console.log(`主进程注册了 ${d.count} 个 ipcMain 通道：`);
    console.log();
    // 高亮可能与窗口有关的
    for (const n of d.names) {
      const hot = /window|widget|floating|tomato|edit|show|open|create/i.test(n);
      console.log(`  ${hot ? '*' : ' '} ${n}`);
    }
    console.log();
    console.log('（带 * 的很可能与窗口创建有关）');
  } else {
    const r = await cdp.send('Runtime.evaluate', { expression: EMIT_EXPR(CHAN), returnByValue: true });
    const d = JSON.parse(r.result.value);
    if (!d.ok) { console.log('触发失败:', d.err); process.exit(1); }
    console.log(`触发 ${CHAN}：窗口数 ${d.before} -> ${d.after}（新建 ${d.created} 个）`);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
