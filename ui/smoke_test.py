#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI 冒烟测试 —— 真的开一个窗口，验证渲染与 API 桥，然后自动关闭。

为什么要真的开窗口：pywebview 的桥和页面加载时序有坑（pywebviewready
事件可能错过、CSP 可能拦脚本），只做静态检查发现不了。

有硬超时保护，绝不会挂住会话。
"""
import os
import subprocess
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import webview  # noqa: E402
import app as A  # noqa: E402

RESULT = {"checks": [], "error": None}


def check(name, value, expect=None, note=""):
    """
    断言并记录。
    expect 给定时按相等比较，否则按真值判断。
    note 只是失败时显示的补充信息 —— 别把消息塞进 expect（那是早期版本的一个 bug）。
    """
    ok = (value == expect) if expect is not None else bool(value)
    detail = repr(value)[:180]
    if not ok and note:
        detail = f"{note}  (value={detail})"
    RESULT["checks"].append((name, ok, detail))
    return ok


def _is_light(rgb):
    """判断 'rgb(r, g, b)' 是否偏亮。用于验证浅色主题真的生效。"""
    try:
        nums = [int(x) for x in str(rgb).replace("rgba", "").replace("rgb", "")
                .strip("() ").split(",")[:3]]
        return sum(nums) / 3 > 180
    except Exception:                                    # noqa: BLE001
        return False


def run():
    httpd, port = A.start_static_server()
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"[smoke] serving {url}")

    api = A.Api()
    win = webview.create_window("smoke", url, js_api=api, width=1000, height=700)

    def driver():
        # 等页面加载 + app.js 初始化。
        #
        # 不用固定 sleep：首屏要等 get_overview 跑完（它内部会调 node 的
        # list + doctor，本机实测约 4 秒）。固定 6 秒在机器忙时会不够，
        # 于是"profile 列表已渲染"偶发失败 —— 那是测试的时序问题，
        # 不是产品缺陷。这里改成轮询真实条件（最多 25 秒）。
        deadline = time.time() + 25
        while time.time() < deadline:
            try:
                if win.evaluate_js("document.querySelectorAll('#profileList .item').length") > 0:
                    break
            except Exception:
                pass
            time.sleep(0.4)
        time.sleep(0.5)   # 让渲染收尾
        try:
            # 1) 页面标题（证明 HTML 被解析）
            title = win.evaluate_js("document.title")
            check("页面标题", title, "no-glass-ele")

            # 2) pywebview 桥是否暴露（app.js 依赖它）
            has_bridge = win.evaluate_js("typeof window.pywebview !== 'undefined'")
            check("pywebview 桥暴露", has_bridge, True)

            # 3) app.js 是否执行（它会给 #rootPath 写入路径）
            root_text = win.evaluate_js("document.getElementById('rootPath').textContent")
            check("app.js 已执行（rootPath 非空）", bool(root_text and root_text != "…"), True)

            # 4) profile 列表是否渲染出条目（证明 API 往返成功）
            n_items = win.evaluate_js("document.querySelectorAll('#profileList .item').length")
            check("profile 列表已渲染", n_items and n_items > 0, True)

            # 5) node 徽章状态（证明 get_state 返回被处理）
            node_badge = win.evaluate_js("document.getElementById('nodeBadge').textContent")
            check("node 徽章已更新", node_badge and "?" not in node_badge, True)

            # 6) 校验徽章
            task_badge = win.evaluate_js("document.getElementById('taskBadge').textContent")
            check("校验徽章已更新", bool(task_badge), True)

            # 7) 点击第一个 profile → 详情区应出现
            win.evaluate_js("document.querySelector('#profileList .item').click()")
            time.sleep(2.5)
            detail_visible = win.evaluate_js(
                "!document.getElementById('detailBody').classList.contains('hidden')"
            )
            check("点击后详情区显示", detail_visible, True)

            # 8) 详情里的 fuse 表是否有行（证明 profile 数据绑定成功）
            n_fuse = win.evaluate_js("document.querySelectorAll('#dFuses tr').length")
            check("fuse 表已渲染", n_fuse and n_fuse > 0, True)

            # 9) 表单是否渲染（编辑能力）
            n_fields = win.evaluate_js("document.querySelectorAll('#dForm [data-key]').length")
            check("编辑表单已渲染", n_fields and n_fields > 0, True)

            # 10) 预设徽章
            n_presets = win.evaluate_js("document.querySelectorAll('#dPresets .preset').length")
            check("预设徽章已渲染", n_presets == 4, True)

            # 11) 打开向导
            win.evaluate_js("document.getElementById('btnNew').click()")
            time.sleep(1.0)
            wiz_open = win.evaluate_js("!document.getElementById('wizard').classList.contains('hidden')")
            check("新建向导能打开", wiz_open, True)
            win.evaluate_js("document.getElementById('wizClose').click()")
            time.sleep(0.5)

            # 12) 日志区存在且可写（模拟一行）
            win.evaluate_js(
                "document.getElementById('log').insertAdjacentHTML('beforeend','<span class=\"l-ok\">smoke-test-line</span>')"
            )
            log_text = win.evaluate_js("document.getElementById('log').textContent")
            check("日志区可写入", "smoke-test-line" in (log_text or ""), True)

            # 13) CSS 是否加载（--bg 变量应已定义且是合法颜色）
            # 注意：不能断言具体色值 —— 未显式设 data-theme 时跟随系统，
            # 系统是浅色就会解析成浅色值。所以只验证"已定义且像颜色"。
            bg = (win.evaluate_js(
                "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"
            ) or "")
            check("style.css 已加载", bg.startswith("#") and len(bg) >= 4, True,
                  f"--bg={bg!r}")

            # 14) 确认界面自己没有用毛玻璃（本工具的主题一致性）
            blur = win.evaluate_js("""
              (() => { let n=0;
                for (const el of document.querySelectorAll('*')) {
                  const v = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter;
                  if (v && v !== 'none') n++;
                }
                return n; })()
            """)
            check("界面自身零 backdrop-filter", blur == 0, True)

            # 15) 会话标签区存在（多会话监控）
            check("会话标签容器存在",
                  win.evaluate_js("!!document.getElementById('sessionTabs')"), True)

            # 15b) 日志隔离：伪造两个会话，来回切，内容应各自独立且完整保留。
            # 用伪造会话而不是真启动两个应用 —— 这样测试是确定性的、秒级完成，
            # 且不依赖任何外部程序。
            iso = win.evaluate_js("""
              (() => {
                // 造两个会话 + 各自的缓冲
                STATE.sessions = [
                  { key: 'sess:A', profile: 'A', displayName: 'A', running: true, port: 1 },
                  { key: 'sess:B', profile: 'B', displayName: 'B', running: true, port: 2 },
                ];
                STATE.logBuffers['sess:A'] = { lines: ['A-第一行', 'A-第二行'], cursor: 2, scrollTop: null, atBottom: true };
                STATE.logBuffers['sess:B'] = { lines: ['B-第一行', 'B-第二行', 'B-第三行'], cursor: 3, scrollTop: null, atBottom: true };

                // 切到 A
                switchSession('sess:A', { silent: true });
                const textA1 = document.getElementById('log').textContent;
                // 切到 B
                switchSession('sess:B', { silent: true });
                const textB = document.getElementById('log').textContent;
                // 切回 A —— 历史应完整回来（这正是用户报的 bug）
                switchSession('sess:A', { silent: true });
                const textA2 = document.getElementById('log').textContent;

                return JSON.stringify({
                  a1HasA: textA1.includes('A-第一行') && textA1.includes('A-第二行'),
                  a1HasB: textA1.includes('B-第一行'),
                  bHasB: textB.includes('B-第一行') && textB.includes('B-第三行'),
                  bHasA: textB.includes('A-第一行'),
                  // 切回来应仍有 A 的两行（旧实现里这里只剩空或新内容）
                  aBackKeeps: textA2.includes('A-第一行') && textA2.includes('A-第二行'),
                  bufCount: Object.keys(STATE.logBuffers).length
                });
              })()
            """)
            try:
                import json as _json
                iso_d = _json.loads(iso) if iso else {}
            except Exception:
                iso_d = {}
            check("切标签显示各自内容", iso_d.get("a1HasA") and iso_d.get("bHasB"), True, str(iso_d))
            check("切标签不串内容", not iso_d.get("a1HasB") and not iso_d.get("bHasA"), True, str(iso_d))
            check("切回后历史仍在（原 bug）", iso_d.get("aBackKeeps") is True, True, str(iso_d))

            # 15b-2) 任务标签：这是短任务输出（probe / build / doctor）的
            # 唯一入口。以前有会话在跑时任务输出永远看不见 —— 根因是前端
            # 用"没有 activeSession"当作看任务日志的条件。
            task_tab = win.evaluate_js("""
              (() => {
                STATE.ready = false;              // 冻结轮询，避免干扰
                STATE.sessions = [
                  { key: 'sess:A', profile: 'A', displayName: 'A', running: true, port: 1 },
                ];
                STATE.logBuffers = {
                  'sess:A': { lines: ['会话A的输出'], cursor: 1, scrollTop: null, atBottom: true },
                  '__task__': { lines: ['任务输出-第一行', '任务输出-第二行'], cursor: 2, scrollTop: null, atBottom: true },
                };
                STATE.taskRunning = true;
                renderSessionTabs();

                const tabs = [...document.querySelectorAll('#sessionTabs .stab')].map(e => e.dataset.key);
                const hasTaskTab = tabs.includes('__task__');
                // 任务标签应排在第一位（固定位置，不随会话增减移动）
                const taskFirst = tabs[0] === '__task__';

                // 切到任务标签 —— 即便有会话在跑，也必须能看到任务输出
                switchSession('__task__', { silent: true });
                const taskText = document.getElementById('log').textContent;
                const titleWhenTask = document.getElementById('logTitle').textContent;

                // 切回会话，任务缓冲不该被清掉
                switchSession('sess:A', { silent: true });
                const sessText = document.getElementById('log').textContent;
                const taskBufKept = (STATE.logBuffers['__task__']?.lines || []).length === 2;

                STATE.ready = window.__smokeReadySave0 === undefined ? true : window.__smokeReadySave0;
                return JSON.stringify({
                  hasTaskTab, taskFirst,
                  taskVisibleWithSession: taskText.includes('任务输出-第一行'),
                  taskTabNoSessionLeak: !taskText.includes('会话A的输出'),
                  titleMentionsTask: titleWhenTask.includes('任务'),
                  sessTextOk: sessText.includes('会话A的输出'),
                  taskBufKept,
                });
              })()
            """)
            try:
                import json as _json_t
                task_d = _json_t.loads(task_tab) if task_tab else {}
            except Exception:
                task_d = {}
            check("任务标签存在且排第一",
                  task_d.get("hasTaskTab") and task_d.get("taskFirst"), True, str(task_d))
            check("有会话时也能看到任务输出（原 bug）",
                  task_d.get("taskVisibleWithSession") is True, True, str(task_d))
            check("任务标签不串会话内容",
                  task_d.get("taskTabNoSessionLeak") is True, True, str(task_d))
            check("任务缓冲切走后保留", task_d.get("taskBufKept") is True, True, str(task_d))

            # 15b-2) 文件型会话的日志必须**增量追加**，不能整体重写。
            #
            # 这条直接对应用户报告的现象：「日志窗口尝试选择内容，结果每隔几秒
            # 就重新从头开始选择了」—— 因为整体 innerHTML 重写会销毁所有 DOM
            # 节点，选中随之丢失。断言方式：记住日志区第一个子节点，跑两轮
            # 轮询后它必须还是**同一个节点**（重写会造出新节点，=== 就不成立）。
            win.evaluate_js("""
              (() => {
                window.__smokeLogNodes = null;
                const save = { ready: STATE.ready, active: STATE.activeSession,
                               sessions: STATE.sessions, buffers: STATE.logBuffers };
                STATE.ready = false;        // 冻结真实轮询，我们手动驱动

                // 伪造一个"文件型"会话（没有 localId → 走 session_id 分支）
                STATE.sessions = [{ key: 'file:1', id: 'fakesess', profile: 'F',
                                    running: true, localId: null, pid: 4242 }];
                STATE.activeSession = 'file:1';
                STATE.logBuffers = { 'file:1': { lines: ['第一行'], cursor: 10, scrollTop: null, atBottom: true } };
                document.getElementById('log').innerHTML =
                  '<span class="">第一行</span>';

                const realApi = window.pywebview.api;
                let round = 0;
                const fake = Object.create(realApi);
                fake.get_session_log = () => {
                  round++;
                  if (round === 1) {
                    // 第二轮：增量（reset=false）—— 只多一行
                    return Promise.resolve({ ok: true, live: false, reset: false,
                                             cursor: 20, lines: ['第二行'] });
                  }
                  return Promise.resolve({ ok: true, live: false, reset: false,
                                           cursor: 20, lines: [] });
                };
                window.pywebview.api = fake;

                (async () => {
                  const box = document.getElementById('log');
                  const firstBefore = box.firstChild;
                  await pollSessionLog();                 // 第 1 轮：追加"第二行"
                  const firstAfterAppend = box.firstChild;
                  const text1 = box.textContent;
                  await pollSessionLog();                 // 第 2 轮：无新增
                  const firstAfterIdle = box.firstChild;
                  window.pywebview.api = realApi;
                  STATE.ready = save.ready; STATE.activeSession = save.active;
                  STATE.sessions = save.sessions; STATE.logBuffers = save.buffers;
                  window.__smokeLogNodes = JSON.stringify({
                    sameNodeAfterAppend: firstBefore === firstAfterAppend,
                    sameNodeAfterIdle: firstBefore === firstAfterIdle,
                    appended: text1.includes('第二行') && text1.includes('第一行'),
                  });
                })();
                return true;
              })()
            """)
            for _ in range(40):
                if win.evaluate_js("window.__smokeLogNodes"):
                    break
                time.sleep(0.1)
            try:
                import json as _json_ln
                ln_d = _json_ln.loads(win.evaluate_js("window.__smokeLogNodes") or "{}")
            except Exception:
                ln_d = {}
            check("增量追加不重建节点（选中不被清空）",
                  ln_d.get("sameNodeAfterAppend") is True, True, str(ln_d))
            check("无新增时也不重建节点",
                  ln_d.get("sameNodeAfterIdle") is True, True, str(ln_d))
            check("增量内容正确追加", ln_d.get("appended") is True, True, str(ln_d))

            # 15c) 过期响应不污染当前视图：
            # 模拟"请求发出后用户切走了" —— 过期响应应只充实缓冲、不动 DOM。
            #
            # 为什么用"结果写全局变量 + 轮询读"而不是直接求值 async：
            # pywebview 的 evaluate_js 拿不到 Promise 的解析值（会返回 None），
            # 那样断言会被静默跳过 —— 测试看起来通过其实没跑。这是本测试自己
            # 踩过的坑：把异步结果落到 window 上再同步读出来。
            win.evaluate_js("""
              (() => {
                window.__smokeStale = null;
                // 冻结后台轮询：这两个定时器会调 pruneLogBuffers，
                // 把下面伪造的会话缓冲清掉，导致断言偶发失败。
                // 冻结方式就是让 startPolling 的两个回调都提前 return。
                window.__smokeReadySave = STATE.ready;
                STATE.ready = false;
                STATE.sessions = [
                  { key: 'sess:X', profile: 'X', displayName: 'X', running: true, localId: 'x#1' },
                  { key: 'sess:Y', profile: 'Y', displayName: 'Y', running: true, localId: 'y#1' },
                ];
                STATE.logBuffers = {
                  'sess:X': { lines: ['X-OLD'], cursor: 1, scrollTop: null, atBottom: true },
                  'sess:Y': { lines: ['Y-OLD'], cursor: 1, scrollTop: null, atBottom: true },
                };

                // 造一个"慢"的 api：X 的请求挂 50ms 才返回
                const realApi = window.pywebview.api;
                const fake = Object.create(realApi);
                fake.get_session_log = (localId) =>
                  new Promise((res) => setTimeout(() => res({
                    ok: true, live: true, cursor: 99,
                    lines: [localId === 'x#1' ? 'X-LATE' : 'Y-LATE'],
                  }), 50));
                window.pywebview.api = fake;

                (async () => {
                  STATE.activeSession = 'sess:X';
                  const p = pollSessionLog();          // 请求 X（慢）
                  switchSession('sess:Y', { silent: true });  // 还没回来就切到 Y
                  await p;
                  await new Promise((r) => setTimeout(r, 150));
                  window.pywebview.api = realApi;
                  STATE.ready = window.__smokeReadySave;   // 解冻
                  const dom = document.getElementById('log').textContent;
                  window.__smokeStale = JSON.stringify({
                    domHasY: dom.includes('Y-OLD'),
                    domHasXLate: dom.includes('X-LATE'),
                    xBufHasLate: (STATE.logBuffers['sess:X']?.lines || []).includes('X-LATE'),
                  });
                })();
                return true;
              })()
            """)
            for _ in range(40):     # 最多等 4 秒
                if win.evaluate_js("window.__smokeStale"):
                    break
                time.sleep(0.1)
            raw_stale = win.evaluate_js("window.__smokeStale")
            try:
                import json as _json2
                stale_d = _json2.loads(raw_stale) if raw_stale else {}
            except Exception:
                stale_d = {}
            check("过期响应不污染 DOM（竞态）",
                  stale_d.get("domHasXLate") is False, True, str(stale_d) or "未拿到结果")
            check("过期响应仍进各自缓冲",
                  stale_d.get("xBufHasLate") is True, True, str(stale_d) or "未拿到结果")

            # 15d) 停止语义：当前应用无会话时，不该误停别的应用的会话。
            win.evaluate_js("""
              (() => {
                window.__smokeStop = null;
                // 同样冻结后台轮询：它会用真实数据覆盖下面伪造的 STATE.sessions
                window.__smokeReadySave2 = STATE.ready;
                STATE.ready = false;
                const realApi = window.pywebview.api;
                const calls = [];
                const fake = Object.create(realApi);
                fake.stop_session = (lid, sid, pid) => {
                  calls.push(['session', lid, sid, pid]);
                  return Promise.resolve({ ok: true });
                };
                fake.stop_task = () => { calls.push(['task']); return Promise.resolve({ ok: true }); };
                window.pywebview.api = fake;

                // 场景：左侧选中 A，但只有 B 在跑
                STATE.current = 'A';
                STATE.taskRunning = false;
                STATE.sessions = [{ key: 'sess:B', profile: 'B', running: true, localId: 'b#1' }];

                // 把 stopSession 内部会间接调到的接口也挡住 ——
                // 否则 updateTaskUI 会去调真实的 get_overview（约 4 秒），
                // 而测试的等待窗口只有 3 秒 → 断言拿不到结果。
                fake.get_task_status = () => Promise.resolve({ ok: true, task: {} });
                fake.get_overview = () => Promise.resolve({ ok: true, sessions: STATE.sessions });

                (async () => {
                  await stopTask();
                  window.pywebview.api = realApi;
                  STATE.ready = window.__smokeReadySave2;
                  window.__smokeStop = JSON.stringify({
                    calls,
                    stoppedB: calls.some((c) => c[1] === 'b#1'),
                  });
                })();
                return true;
              })()
            """)
            for _ in range(60):
                if win.evaluate_js("window.__smokeStop"):
                    break
                time.sleep(0.1)
            raw_stop = win.evaluate_js("window.__smokeStop")
            try:
                import json as _json3
                stop_d = _json3.loads(raw_stop) if raw_stop else {}
            except Exception:
                stop_d = {}
            check("停止不误伤其他应用（语义）",
                  stop_d.get("stoppedB") is False, True, str(stop_d) or "未拿到结果")

            # 15e) 停止语义：当前应用**有**会话时，应精确停它。
            win.evaluate_js("""
              (() => {
                window.__smokeStop2 = null;
                window.__smokeReadySave3 = STATE.ready;
                STATE.ready = false;
                const realApi = window.pywebview.api;
                const calls = [];
                const fake = Object.create(realApi);
                fake.stop_session = (lid, sid, pid) => {
                  calls.push([lid, sid, pid]);
                  return Promise.resolve({ ok: true });
                };
                window.pywebview.api = fake;

                STATE.current = 'A';
                STATE.taskRunning = false;
                STATE.sessions = [
                  { key: 'sess:A', profile: 'A', running: true, localId: 'a#1' },
                  { key: 'sess:B', profile: 'B', running: true, localId: 'b#1' },
                ];

                // 同上：挡住 updateTaskUI 会调到的真实接口，保证测试隔离且快
                fake.get_task_status = () => Promise.resolve({ ok: true, task: {} });
                fake.get_overview = () => Promise.resolve({ ok: true, sessions: STATE.sessions });

                (async () => {
                  await stopTask();
                  window.pywebview.api = realApi;
                  STATE.ready = window.__smokeReadySave3;
                  window.__smokeStop2 = JSON.stringify({
                    calls,
                    stoppedA: calls.some((c) => c[0] === 'a#1'),
                    stoppedB: calls.some((c) => c[0] === 'b#1'),
                  });
                })();
                return true;
              })()
            """)
            for _ in range(60):
                if win.evaluate_js("window.__smokeStop2"):
                    break
                time.sleep(0.1)
            raw_stop2 = win.evaluate_js("window.__smokeStop2")
            try:
                import json as _json4
                stop2_d = _json4.loads(raw_stop2) if raw_stop2 else {}
            except Exception:
                stop2_d = {}
            check("停止精确命中当前应用",
                  stop2_d.get("stoppedA") is True and stop2_d.get("stoppedB") is False,
                  True, str(stop2_d) or "未拿到结果")

            # 15f) 启动按钮：单会话语义（隔离复选框**不影响**禁用状态）
            #
            # 规则：该应用已有注入会话在跑 → 禁用启动，与「隔离数据」勾选无关。
            # 隔离是启动方式（用独立数据目录），不是多开一个实例 ——
            # 早期版本曾让勾隔离就放行，那实际上是在鼓励多实例，已改回。
            # 同步函数，直接调用后读按钮状态即可，不用等 Promise。
            btn = win.evaluate_js("""
              (() => {
                const save = { cur: STATE.current, sess: STATE.sessions, ready: STATE.ready };
                STATE.ready = false;        // 冻结轮询，避免它覆盖 STATE.sessions
                const iso = document.getElementById('optIsolate');
                const btnL = document.getElementById('btnLaunch');

                STATE.current = 'A';
                STATE.sessions = [{ key: 'sess:A', profile: 'A', running: true, isolate: false }];

                iso.checked = false; syncLaunchButtons();
                const blockedWhenPlain = btnL.disabled;
                const tip = btnL.title;

                iso.checked = true; syncLaunchButtons();
                const stillBlockedWhenIsolate = btnL.disabled;   // ★ 勾隔离不该放行

                // 没有会话时两种情况都应放行
                STATE.sessions = [];
                iso.checked = false; syncLaunchButtons();
                const freeWhenNoSession = !btnL.disabled;
                iso.checked = true; syncLaunchButtons();
                const freeWhenNoSessionIsolate = !btnL.disabled;

                // 恢复现场
                iso.checked = false;
                STATE.current = save.cur; STATE.sessions = save.sess; STATE.ready = save.ready;
                syncLaunchButtons();
                return JSON.stringify({
                  blockedWhenPlain, stillBlockedWhenIsolate,
                  freeWhenNoSession, freeWhenNoSessionIsolate,
                  hasReason: /已有注入会话/.test(tip),
                });
              })()
            """)
            try:
                import json as _json5
                bd = _json5.loads(btn) if btn else {}
            except Exception:
                bd = {}
            check("有会话在跑→禁用启动", bd.get("blockedWhenPlain") is True, True, str(bd))
            check("勾「隔离数据」不改变禁用状态（单会话语义）",
                  bd.get("stillBlockedWhenIsolate") is True, True, str(bd))
            check("无会话→放行", bd.get("freeWhenNoSession") is True, True, str(bd))
            check("无会话且勾隔离→仍放行", bd.get("freeWhenNoSessionIsolate") is True, True, str(bd))
            check("禁用时给出原因", bd.get("hasReason") is True, True, str(bd))
            # 复选框文案必须是"数据隔离"语义，不能是"多开实例"
            iso_label = win.evaluate_js(
                "document.querySelector('label.check input#optIsolate')"
                " ? document.querySelector('label.check input#optIsolate').parentElement.textContent : ''"
            ) or ""
            check("复选框文案是数据隔离语义",
                  ("隔离数据" in iso_label) and ("不影响正在运行" not in iso_label), True, iso_label[:60])

            # 16) 自定义 CSS 编辑器存在且可写
            win.evaluate_js(
                "document.getElementById('cssEditor').value = '/* smoke */ .x{color:red}'"
            )
            check("CSS 编辑器可写",
                  "smoke" in (win.evaluate_js("document.getElementById('cssEditor').value") or ""), True)

            # 16b) 深色模式卡片（Dark Reader）
            check("深色模式卡片存在",
                  win.evaluate_js("!!document.getElementById('drMode')"), True)
            # 关闭 / 跟随系统 / 强制深色 / 强制浅色
            check("模式下拉含 4 项",
                  win.evaluate_js("document.querySelectorAll('#drMode option').length") == 4, True)
            # dynamicTheme / staticTheme / cssFilter / svgFilter
            check("引擎下拉含 4 项",
                  win.evaluate_js("document.querySelectorAll('#drEngine option').length") == 4, True)
            check("亮度滑块存在",
                  win.evaluate_js(
                      "(() => { const e = document.getElementById('drBright');"
                      "return !!e && e.type === 'range'; })()"), True)
            check("立即生效按钮存在",
                  win.evaluate_js("!!document.getElementById('btnApplyDr')"), True)
            check("set_darkreader 对未知 profile 安全报错",
                  api.set_darkreader("_smoke_nope_", "auto").get("ok") is False, True)

            # 17) 配色模拟下拉存在，且含 dark/light 选项
            n_opts = win.evaluate_js("document.querySelectorAll('#optEmulate option').length")
            check("配色模拟下拉存在", n_opts == 3, True)

            # 18) 传给应用的参数输入框存在
            check("appArgs 输入框存在",
                  win.evaluate_js("!!document.getElementById('optAppArgs')"), True)

            # 19) 详情表单里出现了新字段（配色模拟 / appArgs）
            has_new_fields = win.evaluate_js("""
              (() => {
                const keys = [...document.querySelectorAll('#dForm [data-key]')]
                  .map(e => e.dataset.key);
                return keys.includes('emulateColorScheme') && keys.includes('appArgs');
              })()
            """)
            check("表单含新字段", has_new_fields, True)

            # 20) list_sessions API（从 Python 侧直接调 —— evaluate_js 无法 await Promise）
            ls = api.list_sessions()
            check("list_sessions 可调用", ls.get("ok") is True, True)
            check("list_sessions 返回列表", isinstance(ls.get("sessions"), list), True)

            # 21) 自定义 CSS 读写往返（用临时 profile 名，测完删掉）
            tmp_name = "_smoke_css_test"
            w = api.save_custom_css(tmp_name, "/* smoke */\n.x { color: red; }\n")
            check("save_custom_css 可写", w.get("ok") is True, True)
            r = api.get_custom_css(tmp_name)
            check("get_custom_css 可读", r.get("ok") is True and "smoke" in (r.get("css") or ""), True)
            # 清理
            try:
                import os as _os
                if w.get("path"):
                    _os.unlink(w["path"])
            except Exception:
                pass

            # 22) 会话停止接口对不存在的会话应报错而不是崩
            st = api.stop_session(local_id="不存在的会话", session_id=None)
            check("stop_session 对未知会话安全报错", st.get("ok") is False, True)

            # 23) 端口唯一性校验（bug 5）
            #
            # 规则：与其他 profile 的 defaultPort 重复就拒绝。这是权威层 ——
            # 前端 suggestPort() 可能读到过期的 profile 列表，后端这一关不能少。
            existing = sorted(A.list_profiles_on_disk())
            if existing:
                victim = existing[0]
                victim_port = A.read_profile(victim).get("defaultPort")
                tmp = "_smoke_port_test"
                data = {
                    "name": tmp, "displayName": tmp, "exe": "X:/none.exe",
                    "processName": tmp, "styleId": "__smoke__",
                    "defaultPort": victim_port, "reservedPorts": [],
                }
                r = api.save_profile(tmp, data)
                check("撞其他 profile 端口→拒绝",
                      r.get("ok") is False and "冲突" in (r.get("error") or ""), True,
                      str(r)[:120])
                check("拒绝信息说明了与谁冲突",
                      victim in (r.get("error") or ""), True, str(r)[:120])

                # 落在自身 reservedPorts 范围里也要拒绝
                data2 = dict(data, defaultPort=9700, reservedPorts=[9690, 9710])
                r2 = api.save_profile(tmp, data2)
                check("端口落在自身保留段→拒绝",
                      r2.get("ok") is False and "reservedPorts" in (r2.get("error") or ""),
                      True, str(r2)[:120])

                # 空闲端口应通过
                data3 = dict(data, defaultPort=9799, reservedPorts=[])
                r3 = api.save_profile(tmp, data3)
                check("空闲端口→保存成功", r3.get("ok") is True, True, str(r3)[:120])

                # 不误伤：内部改写路径（set_darkreader 走 write_profile）不该被端口校验拦住。
                # 用上面刚建好的临时 profile（9799），它端口合法，应当仍能保存成功。
                # 注意顺序：这一步必须在删文件之前 —— 早期版本先删了再调，报的
                # "profile 不存在" 会被误读成校验误伤。
                dr_res = api.set_darkreader(tmp, "auto")
                check("端口校验不误伤内部改写（set_darkreader）",
                      dr_res.get("ok") is True, True, str(dr_res)[:140])
                # 清理临时 profile（set_darkreader 会把它写回磁盘）
                try:
                    import os as _os3
                    _os3.unlink(str(A.PROFILES_DIR / f"{tmp}.json"))
                except Exception:
                    pass
            else:
                check("端口校验（跳过：没有可用的 profile）", True, True)

            # 23) 主题切换：深色 → 浅色时背景色应真的变化
            win.evaluate_js("document.getElementById('btnTheme').click()")  # -> 深色
            time.sleep(0.4)
            dark_bg = win.evaluate_js(
                "getComputedStyle(document.body).backgroundColor"
            )
            # 循环到浅色
            win.evaluate_js("document.getElementById('btnTheme').click()")
            time.sleep(0.4)
            light_bg = win.evaluate_js(
                "getComputedStyle(document.body).backgroundColor"
            )
            check("主题按钮能切换", dark_bg != light_bg, True,
                  f"dark={dark_bg} light={light_bg}")
            check("浅色主题是浅底", _is_light(light_bg), True,
                  f"light_bg={light_bg}")

            # 24) 主题选择应被记住（localStorage）
            saved = win.evaluate_js("localStorage.getItem('noglass-ui-theme')")
            check("主题选择已记住", saved in ("dark", "light"), True,
                  f"saved={saved}")

            # 25) 开机自启动弹窗（中转器模式）
            check("顶栏有「开机自启」按钮",
                  win.evaluate_js("!!document.getElementById('btnAutostart')"), True)

            win.evaluate_js("document.getElementById('btnAutostart').click()")
            # 打开时要读一次状态。这一度是 1.6 秒（起 node + PowerShell 解析
            # 启动文件夹里全部 .lnk 的属性），用户表现为"复选框那块要等几秒"。
            # 现在是纯 Python 读 JSON，毫秒级 —— 等 50×0.1s 只是兜底。
            for _ in range(50):
                if win.evaluate_js(
                        "document.querySelectorAll('#asList .as-item').length > 0"):
                    break
                time.sleep(0.1)
            check("弹窗可见",
                  win.evaluate_js(
                      "!document.getElementById('autostartModal').classList.contains('hidden')"),
                  True)
            n_as = win.evaluate_js("document.querySelectorAll('#asList .as-item').length")
            n_prof = len(A.list_profiles_on_disk())
            check("弹窗列出了全部 profile", n_as == n_prof, True,
                  f"as={n_as} profiles={n_prof}")
            check("有「打开用户启动文件夹」按钮",
                  win.evaluate_js("!!document.getElementById('asOpenUser')"), True)
            check("有「打开系统启动文件夹」按钮",
                  win.evaluate_js("!!document.getElementById('asOpenSystem')"), True)
            check("有运行器检测按钮",
                  win.evaluate_js("!!document.getElementById('asDetect')"), True)

            # 19) 弹窗里的操作按钮必须有可见的底色与边框
            #
            # 真实体验问题：这些按钮原本用 `.btn.ghost`，而 ghost 的定义是
            # `background: transparent; border-color: transparent` —— 在弹窗里
            # 看起来就是一行纯文字，用户"看不太清那是按钮"。
            # 新建向导弹窗里同类的「浏览…」用的是实心 `.btn`，两处风格也不一致。
            #
            # 断言方式：读计算样式。ghost 的底色是 transparent、边框也透明；
            # 实心按钮两者都非透明。颜色值可能是 rgb() 或 rgba()，统一按
            # "含 0 透明度" 判掉。
            _btn_style = win.evaluate_js("""
              (() => {
                const ids = ['asOpenUser', 'asOpenSystem', 'asDetect', 'asClose2'];
                const out = {};
                for (const id of ids) {
                  const e = document.getElementById(id);
                  if (!e) { out[id] = null; continue; }
                  const s = getComputedStyle(e);
                  out[id] = {
                    bg: s.backgroundColor,
                    bw: s.borderTopWidth,
                    bc: s.borderTopColor,
                    cls: e.className,
                  };
                }
                return JSON.stringify(out);
              })()
            """)
            try:
                _btns = _json_btn = __import__('json').loads(_btn_style or "{}")
            except Exception:                            # noqa: BLE001
                _btns = {}

            def _opaque(color, width="0px"):
                """颜色是否不透明（非 transparent / 非 rgba(...,0)）。"""
                c = str(color or "").replace(" ", "").lower()
                if not c or c == "transparent":
                    return False
                if c.startswith("rgba(") and c.rstrip(")").endswith(",0"):
                    return False
                return True

            _bad = []
            for _id in ("asOpenUser", "asOpenSystem", "asDetect", "asClose2"):
                _b = _btns.get(_id) or {}
                if not _opaque(_b.get("bg")) or not _opaque(_b.get("bc")):
                    _bad.append(f"{_id}:bg={_b.get('bg')},bc={_b.get('bc')}")
            check("弹窗操作按钮有可见底色与边框（ghost 不可读）",
                  not _bad, True, "; ".join(_bad)[:180])

            # 20) 顶栏的「开机自启」「刷新」也不能是 ghost（同样看不见）
            _top_cls = win.evaluate_js("""
              JSON.stringify({
                auto: document.getElementById('btnAutostart').className,
                refresh: document.getElementById('btnRefresh').className,
              })
            """)
            try:
                _tc = __import__('json').loads(_top_cls or "{}")
            except Exception:                            # noqa: BLE001
                _tc = {}
            check("顶栏按钮不是 ghost",
                  'ghost' not in (_tc.get("auto", "") + " " + _tc.get("refresh", "")),
                  True, str(_tc))
            check("有初始延迟输入框",
                  win.evaluate_js(
                      "(() => { const e = document.getElementById('asInitial');"
                      "return !!e && e.type === 'number'; })()"), True)
            check("有逐条间隔输入框",
                  win.evaluate_js("!!document.getElementById('asDelay')"), True)

            # 预计时间文案：改数字后应立即更新
            win.evaluate_js(
                "(() => { const e = document.getElementById('asInitial');"
                "e.value = '3'; e.dispatchEvent(new Event('input')); })()")
            est = win.evaluate_js("document.getElementById('asEstimate').textContent") or ""
            check("改延迟后更新预计时间", "预计" in est or "没有勾选" in est, True, est[:60])

            # 状态 API 结构
            st_as = api.get_autostart_state()
            check("get_autostart_state 可调用", st_as.get("ok") is True, True, str(st_as)[:120])
            check("返回 relay 状态", isinstance(st_as.get("relay"), dict), True,
                  str(st_as.get("relay"))[:100])
            check("返回 settings", isinstance(st_as.get("settings"), dict), True,
                  str(st_as.get("settings"))[:100])
            check("返回 profiles 列表", isinstance(st_as.get("profiles"), list), True)

            # 18) get_autostart_state 必须是纯 Python，不起 node 进程
            #
            # 真实体验问题：原先它调 `listManaged({withRelayDetail:true})`，
            # 为了拿中转器的 target/args 去解析启动文件夹里**全部** .lnk 的属性，
            # 实测 1533-1615 ms。用户表现为"刚打开设置，复选框那块要等几秒"。
            # 而前端只用 relay.exists —— target/args 一个都没读。
            #
            # 断言方式：把 _node_json 换成计数器，调一次状态接口，必须为 0。
            _orig_node_json = A.Api._node_json
            _node_calls = {"n": 0}

            # 注意：_node_json 是 @staticmethod。
            #
            # 两个坑（都踩过）：
            #   1. 包装函数不能声明 self —— staticmethod 调用时不会传实例，
            #      多一个参数会把 script 挤到 timeout 的位置。
            #   2. 还原时必须用 staticmethod(...) 包回去。直接赋裸函数会让它
            #      变成普通方法，之后 self 会被当成 script 传进去。
            _orig_node_json = A.Api.__dict__['_node_json']

            def _counting_node_json(*a, **kw):
                _node_calls["n"] += 1
                return _orig_node_json.__func__(*a, **kw)

            A.Api._node_json = staticmethod(_counting_node_json)
            try:
                _t0 = time.time()
                _fast = api.get_autostart_state()
                _ms = (time.time() - _t0) * 1000
            finally:
                A.Api._node_json = _orig_node_json
            check("get_autostart_state 不起 node（性能回归）",
                  _node_calls["n"], 0, f"node 调用 {_node_calls['n']} 次")
            check("get_autostart_state 是毫秒级",
                  _ms < 200, True, f"{_ms:.0f} ms")
            check("纯 Python 版仍返回 enabled/legacy",
                  isinstance(_fast.get("enabled"), list)
                  and isinstance(_fast.get("legacy"), list),
                  True, str({k: _fast.get(k) for k in ('enabled', 'legacy')})[:140])

            # 设置往返
            w_set = api.set_autostart_settings({"neverWarnStartup": True})
            check("写自启动设置成功", w_set.get("ok") is True, True, str(w_set)[:120])
            r_set = api.get_autostart_state().get("settings") or {}
            check("设置能读回", r_set.get("neverWarnStartup") is True, True, str(r_set)[:120])
            api.set_autostart_settings({"neverWarnStartup": False})   # 还原

            # 17) 保存其它设置不得把手选的运行器重置为「自动检测」
            #
            # 真实 bug：write_autostart_settings 原先用
            # `patch.get("pythonw") is None or isinstance(...)` —— patch 里没有
            # 这个键时 .get() 也返回 None，条件成立，于是每次保存任何设置都会
            # 把 pythonw 清成 None（= 自动检测）。而重建 .lnk 只在 "pythonw" in patch
            # 时才发生 → UI 显示"自动"、.lnk 仍指向旧路径，界面与实际不一致。
            #
            # 直接测纯函数，不经 Api.set_autostart_settings —— 后者在 patch 含
            # pythonw 时会真的重建中转器 .lnk，测试不该有那个副作用。
            import json as _json_s
            _sfile = A.SETTINGS_FILE
            _orig = _sfile.read_text(encoding="utf-8") if _sfile.exists() else None
            try:
                A.write_autostart_settings({"pythonw": r"C:\fake\pythonw.exe"})
                A.write_autostart_settings({"neverWarnStartup": True})
                _after = A.read_autostart_settings()
                check("保存其它设置不重置 pythonw（回归）",
                      _after.get("pythonw"), r"C:\fake\pythonw.exe",
                      str(_after.get("pythonw")))

                # 显式传 None 仍应能清成「自动检测」—— None 是合法值，不能一刀切
                A.write_autostart_settings({"pythonw": None})
                _after2 = A.read_autostart_settings()
                check("显式传 None 仍可切回自动检测",
                      _after2.get("pythonw") is None, True, str(_after2.get("pythonw")))
            finally:
                # 还原原文件（不存在就删掉，别留一份测试产生的设置）
                if _orig is None:
                    try:
                        _sfile.unlink()
                    except Exception:                    # noqa: BLE001
                        pass
                else:
                    _sfile.write_text(_orig, encoding="utf-8", newline="\n")

            # 上次失败摘要 API（通常没有文件，只验不崩）
            last = api.get_autostart_last()
            check("get_autostart_last 可调用", last.get("ok") is True, True, str(last)[:100])

            # 运行器检测：真跑一次，至少要能跑通（可能一个都没有，那不报错）
            det = api.detect_pythonw()
            check("detect_pythonw 可调用", det.get("ok") is True and isinstance(det.get("items"), list),
                  True, str(det)[:140])

            win.evaluate_js("document.getElementById('asClose').click()")
            time.sleep(0.3)
            check("弹窗能关闭",
                  win.evaluate_js(
                      "document.getElementById('autostartModal').classList.contains('hidden')"),
                  True)

            # 27) 切换 profile 不得重复查「应用自启动项」（性能回归守卫）
            #
            # 背景（真实 bug）：loadAppAutostart 原先每次切换都调
            # get_app_autostart → 起一个 node + 一个 PowerShell，实测 1.5 秒/次。
            # 快速点 10 下 = 16 秒 + 10 个 PowerShell，用户表现为"切换列表卡顿"。
            # 现在改成批量一次查完 + 前端缓存，切换时纯内存读取。
            #
            # 断言方式：统计 get_app_autostart_all 的调用次数 ——
            # 连续切 5 次同一个/不同 profile，它只该被调用 1 次（首次）。
            perf = win.evaluate_js("""
              (() => {
                const save = { ready: STATE.ready, cur: STATE.current,
                               all: STATE.appAutostartAll,
                               promise: STATE.appAutostartAllPromise };
                STATE.ready = false;
                STATE.appAutostartAll = null;            // 清缓存，从头计数
                STATE.appAutostartAllPromise = null;

                const realApi = window.pywebview.api;
                let calls = 0;
                const fake = Object.create(realApi);
                fake.get_app_autostart_all = () => {
                  calls++;
                  return Promise.resolve({ ok: true, items: {} });
                };
                window.pywebview.api = fake;

                (async () => {
                  const names = ['A', 'B', 'C', 'A', 'B'];
                  for (const n of names) {
                    STATE.current = n;
                    await loadAppAutostart();
                  }
                  window.pywebview.api = realApi;
                  STATE.ready = save.ready; STATE.current = save.cur;
                  STATE.appAutostartAll = save.all;
                  STATE.appAutostartAllPromise = save.promise;
                  window.__smokePerf = JSON.stringify({ calls, switches: names.length });
                })();
                return true;
              })()
            """)
            for _ in range(40):
                if win.evaluate_js("window.__smokePerf"):
                    break
                time.sleep(0.1)
            try:
                import json as _json_perf
                pd = _json_perf.loads(win.evaluate_js("window.__smokePerf") or "{}")
            except Exception:
                pd = {}
            check("切换 5 次只查一次应用自启动项（性能回归）",
                  pd.get("calls") == 1, True, str(pd))

            # 28) 批量 API 应可用且返回 dict
            aa = api.get_app_autostart_all()
            check("get_app_autostart_all 可调用", aa.get("ok") is True, True, str(aa)[:120])
            check("批量结果按 profile 名索引",
                  isinstance(aa.get("items"), dict), True, str(aa.get("items"))[:120])

            # 29) listManaged 默认不读 .lnk 详情（doctor 少一次 PowerShell）
            #
            # 这是 node 侧的行为，用 python 起一次 node 验证 —— 不经过 UI。
            lm = subprocess.run(
                ["node", "-e",
                 "const a=require('./lib/autostart');"
                 "process.stdout.write(JSON.stringify({"
                 "  plain: a.listManaged().relay,"
                 "  detail: a.listManaged({withRelayDetail:true}).relay"
                 "}));"],
                cwd=str(A.ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=60,
                creationflags=A.CREATE_NO_WINDOW,
            )
            try:
                import json as _json_lm
                lmd = _json_lm.loads(lm.stdout or "{}")
            except Exception:
                lmd = {}
            plain = lmd.get("plain") or {}
            detail = lmd.get("detail") or {}
            check("listManaged 默认不读详情（target 为 null）",
                  plain.get("target") is None, True, str(plain)[:120])
            if detail.get("exists"):
                check("显式要求时才读详情（target 非 null）",
                      detail.get("target") is not None, True, str(detail)[:120])
            else:
                check("显式要求时才读详情（中转器不存在，跳过）", True, True)


            badges = win.evaluate_js("""
              (() => {
                const save = { profiles: STATE.profiles, ready: STATE.ready };
                STATE.ready = false;
                STATE.profiles = [
                  { name: 'A', displayName: 'A', autostartEnabled: true, autostartArgsDiffer: false },
                  { name: 'B', displayName: 'B', autostartEnabled: true, autostartArgsDiffer: true },
                ];
                renderList();
                const auto = document.querySelectorAll('#profileList .auto-dot').length;
                const args = document.querySelectorAll('#profileList .args-dot').length;
                STATE.profiles = save.profiles; STATE.ready = save.ready;
                renderList();
                return JSON.stringify({ auto, args });
              })()
            """)
            try:
                import json as _json_as
                bd_as = _json_as.loads(badges) if badges else {}
            except Exception:
                bd_as = {}
            check("已启用自启动→淡绿徽章", bd_as.get("auto") == 2, True, str(bd_as))
            check("参数不同→浅黄徽章", bd_as.get("args") == 1, True, str(bd_as))

            # 30) 模板的 displayName 必须是 null
            #
            # 真实 bug：模板里写的是 "MyApp"，而 gen.js new 用
            # `tpl.displayName || name` —— 那个字符串是 truthy，所以 || 永远
            # 走不到右边。结果每个新建 profile 都显示成 MyApp，生成的启动器
            # 文件头也写 "MyApp no-glass launcher"。用户自己的 profile 都是
            # make-profiles.js 显式写 displayName 的，所以一直没暴露。
            import json as _json_tpl
            tpl_path = A.ROOT / "profiles" / "_template.json"
            tpl = _json_tpl.loads(tpl_path.read_text(encoding="utf-8"))
            # 注意 check() 的 expect=None 是「按真值判断」而非「等于 None」，
            # 所以这里显式比较 is None 再把布尔结果交给 check。
            check("模板 displayName 为 null（否则 gen.js new 会填成 MyApp）",
                  tpl.get("displayName") is None, True, str(tpl.get("displayName")))

            # 31) gen.js new 的默认 displayName 应取 exe 文件名
            tmp_name = "_smoke_dn"
            tmp_prof = A.PROFILES_DIR / f"{tmp_name}.json"
            try:
                newp = subprocess.run(
                    ["node", str(A.GEN_JS), "new", tmp_name,
                     "--exe", os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                           "System32", "notepad.exe")],
                    cwd=str(A.ROOT), capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=120,
                    creationflags=A.CREATE_NO_WINDOW,
                )
                if tmp_prof.exists():
                    dnp = _json_tpl.loads(tmp_prof.read_text(encoding="utf-8"))
                    check("gen.js new 用 exe 文件名作 displayName",
                          dnp.get("displayName"), "notepad", str(dnp.get("displayName")))
                else:
                    check("gen.js new 用 exe 文件名作 displayName",
                          False, True, (newp.stderr or newp.stdout or "")[:200])
            finally:
                try:
                    tmp_prof.unlink()
                except Exception:                        # noqa: BLE001
                    pass

            # 32) 状态轮询不得再走 get_overview（CPU 回归守卫）
            #
            # 背景（真实 bug）：updateTaskUI 每 2 秒调一次 get_overview，
            # 而后者一旦过了 5 秒 TTL 就要跑 `gen.js list` + `gen.js doctor`
            # 两个 node 进程（实测 2023ms，其中 PowerShell 读自启动项占 1.7s）。
            # 于是 UI 待机时每 5-6 秒来一次 2 秒的满核突发 —— 用户看到的
            # 「CPU 过山车」。而 overview 里的 profile/doctor 数据对会话标签
            # 毫无用处，会话列表用 list_sessions 就够了（实测 0.03ms）。
            #
            # 断言方式：fake 掉两个 API 并计数，调一次 updateTaskUI，
            # get_overview 必须为 0、list_sessions 必须 >= 1。
            win.evaluate_js("""
              (() => {
                const save = { ready: STATE.ready, sessions: STATE.sessions,
                               taskRunning: STATE.taskRunning };
                STATE.ready = false;          // 冻结后台定时器，避免干扰计数
                const realApi = window.pywebview.api;
                let overview = 0, list = 0;
                const fake = Object.create(realApi);
                fake.get_task_status = () => Promise.resolve({ ok: true, task: {} });
                fake.get_overview = () => {
                  overview++;
                  return Promise.resolve({ ok: true, sessions: [] });
                };
                fake.list_sessions = () => {
                  list++;
                  return Promise.resolve({ ok: true, sessions: [] });
                };
                window.pywebview.api = fake;
                (async () => {
                  await updateTaskUI();
                  window.pywebview.api = realApi;
                  STATE.ready = save.ready;
                  STATE.sessions = save.sessions;
                  STATE.taskRunning = save.taskRunning;
                  window.__smokePoll = JSON.stringify({ overview, list });
                })();
                return true;
              })()
            """)
            for _ in range(40):
                if win.evaluate_js("window.__smokePoll"):
                    break
                time.sleep(0.1)
            try:
                pd2 = _json_tpl.loads(win.evaluate_js("window.__smokePoll") or "{}")
            except Exception:
                pd2 = {}
            check("状态轮询不触发 get_overview（CPU 回归）",
                  pd2.get("overview"), 0, str(pd2))
            check("状态轮询改用 list_sessions",
                  pd2.get("list", 0) >= 1, True, str(pd2))

            # ── 33-38) 核心逻辑的回归守卫（node 侧）──
            #
            # 这些都是实测确认过的 bug，用子进程跑 node 验证，不经过 UI。
            # 统一放在这里，避免和 UI 断言混在一起。

            def _node_json_snippet(code, timeout=120):
                """跑一段 node -e，返回 (解析后的 JSON, 原始输出, 退出码)。"""
                r = subprocess.run(
                    ["node", "-e", code],
                    cwd=str(A.ROOT), capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=timeout,
                    creationflags=A.CREATE_NO_WINDOW,
                )
                try:
                    return _json_tpl.loads(r.stdout or "null"), r.stdout, r.returncode
                except Exception:                        # noqa: BLE001
                    return None, (r.stdout or "") + (r.stderr or ""), r.returncode

            # 33) 指纹必须覆盖 runtime / prefersColorScheme / markers
            #
            # 真实 bug：这三个都影响产物（planPresets 决定是否生成
            # start-native.cmd；README 的「行为特征」「深色建议」也读它们），
            # 但原先不在 fingerprint 里 → 改了再 build，产物变了，
            # doctor 比对指纹仍说"最新"。
            fp_data, fp_raw, _ = _node_json_snippet("""
              const r = require('./lib/render');
              const base = {
                name:'x', displayName:'X', exe:'C:/a.exe', processName:'a',
                styleId:'s', defaultPort:9333, reservedPorts:[], appArgs:[],
                native:{}, notes:{}, runtime:'electron',
                detected:{ electron:'30', fuses:null, canUseNative:true,
                  windowLayerGlass:false, hasPageGlass:true, singleInstance:false,
                  userDataOverride:null, prefersColorScheme:false, markers:[] },
              };
              const a = r.fingerprint(base, 'start.cmd');
              const diff = (p) => r.fingerprint(p, 'start.cmd') !== a;
              process.stdout.write(JSON.stringify({
                runtime: diff({...base, runtime:'tauri'}),
                detectedRuntime: diff({...base, detected:{...base.detected, runtime:'tauri'}}),
                prefersColorScheme: diff({...base, detected:{...base.detected, prefersColorScheme:true}}),
                markers: diff({...base, detected:{...base.detected, markers:['x']}}),
                probedAtOnly: diff({...base, detected:{...base.detected, probedAt:'2020-01-01'}}),
              }));
            """)
            fp_data = fp_data or {}
            check("指纹覆盖 runtime", fp_data.get("runtime") is True, True, fp_raw[:160])
            check("指纹覆盖 detected.runtime", fp_data.get("detectedRuntime") is True, True, fp_raw[:160])
            check("指纹覆盖 prefersColorScheme", fp_data.get("prefersColorScheme") is True, True, fp_raw[:160])
            check("指纹覆盖 markers", fp_data.get("markers") is True, True, fp_raw[:160])
            # 反向：不该进指纹的字段（probedAt）不应让产物"过期"
            check("指纹不包含 probedAt（避免无谓过期）",
                  fp_data.get("probedAtOnly") is False, True, fp_raw[:160])

            # 34) CLI profile 名必须校验（防路径穿越）
            #
            # 实测过：`node gen.js new ../../evil --exe ...` 会把 JSON 写到
            # profiles/ 之外（真的生成了 D:\Projects-Working-DIR\evil.json）。
            trav = subprocess.run(
                ["node", str(A.GEN_JS), "new", "../../_smoke_evil",
                 "--exe", os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                       "System32", "notepad.exe")],
                cwd=str(A.ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=120,
                creationflags=A.CREATE_NO_WINDOW,
            )
            outside = (A.ROOT.parent / "_smoke_evil.json")
            check("CLI 拒绝路径穿越的 profile 名",
                  trav.returncode == 2, True, f"exit={trav.returncode}")
            check("路径穿越未写出 profiles/ 之外",
                  outside.exists(), False, str(outside))
            try:
                outside.unlink()
            except Exception:                            # noqa: BLE001
                pass

            # 35) new 遇到同名 profile 默认拒绝，--force 才覆盖并备份
            _dup = A.PROFILES_DIR / "_smoke_dup.json"
            _dup_bak = A.PROFILES_DIR / "_smoke_dup.json.bak"
            try:
                _exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                    "System32", "notepad.exe")
                subprocess.run(["node", str(A.GEN_JS), "new", "_smoke_dup", "--exe", _exe],
                               cwd=str(A.ROOT), capture_output=True, timeout=120,
                               creationflags=A.CREATE_NO_WINDOW)
                # 手填一个字段，模拟用户的定制
                if _dup.exists():
                    _j = _json_tpl.loads(_dup.read_text(encoding="utf-8"))
                    _j["notes"] = {"extra": "SMOKE-SENTINEL"}
                    _dup.write_text(_json_tpl.dumps(_j, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
                _again = subprocess.run(
                    ["node", str(A.GEN_JS), "new", "_smoke_dup", "--exe", _exe],
                    cwd=str(A.ROOT), capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=120,
                    creationflags=A.CREATE_NO_WINDOW)
                check("new 遇到同名 profile 默认拒绝",
                      _again.returncode == 2, True, f"exit={_again.returncode}")
                _kept = _json_tpl.loads(_dup.read_text(encoding="utf-8"))
                check("被拒绝时手填字段未被覆盖",
                      (_kept.get("notes") or {}).get("extra"), "SMOKE-SENTINEL",
                      str(_kept.get("notes")))

                _forced = subprocess.run(
                    ["node", str(A.GEN_JS), "new", "_smoke_dup", "--exe", _exe, "--force"],
                    cwd=str(A.ROOT), capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=120,
                    creationflags=A.CREATE_NO_WINDOW)
                check("--force 能覆盖", _forced.returncode == 0, True,
                      f"exit={_forced.returncode} {( _forced.stderr or '')[:120]}")
                check("--force 覆盖前会备份 .bak", _dup_bak.exists(), True, str(_dup_bak))
            finally:
                for _p in (_dup, _dup_bak):
                    try:
                        _p.unlink()
                    except Exception:                    # noqa: BLE001
                        pass

            # 36) 隔离目录：processName 缺失且没有 appPid 时不得删
            #
            # 真实 bug：cleanupOwnedDataDir 原先只靠 psCount(processName)，
            # 而 psCount 在 processName 为空时直接返回 0 → 注入器一退出就删掉
            # 应用**正在使用**的数据目录。
            # 这里用假的 cfg 直接调函数，验证它不会真删。
            _iso = A.ROOT / "run" / "_smoke_iso_dir"
            _iso.mkdir(parents=True, exist_ok=True)
            (_iso / "keep.txt").write_text("sentinel", encoding="utf-8")
            iso_ret, iso_raw, _ = _node_json_snippet("""
              const fs = require('fs');
              const path = require('path');
              const src = fs.readFileSync('injector/noglass.js', 'utf8');
              // 从源码里抠出 cleanupOwnedDataDir + pidAlive + psCount，单独求值
              const grab = (re) => { const m = src.match(re); if (!m) throw new Error('not found'); return m[0]; };
              const psCount = grab(/const psCount = \\(processName\\) => \\{[\\s\\S]*?\\n\\};/);
              const pidAlive = grab(/function pidAlive\\(pid\\) \\{[\\s\\S]*?\\n\\}/);
              const cleanup = grab(/function cleanupOwnedDataDir\\(cfg\\) \\{[\\s\\S]*?\\n\\}/);
              const warns = [];
              const warn = (m) => warns.push(m);
              const fsMod = fs;
              const evalFn = new Function('fs', 'warn', psCount + '\\n' + pidAlive + '\\n' + cleanup + '\\nreturn cleanupOwnedDataDir;');
              const fn = evalFn(fsMod, warn);
              const dir = path.join('run', '_smoke_iso_dir');
              // 关键用例：没有 processName、没有 appPid
              fn({ dataDirOwned: true, dataDir: dir, processName: null, name: 'X' });
              process.stdout.write(JSON.stringify({
                survived: fs.existsSync(path.join(dir, 'keep.txt')),
                warned: warns.length > 0,
              }));
            """)
            iso_ret = iso_ret or {}
            check("隔离目录：无 processName 时保留（不误删）",
                  iso_ret.get("survived") is True, True, str(iso_ret) + iso_raw[:120])
            check("隔离目录：保留时给出警告",
                  iso_ret.get("warned") is True, True, str(iso_ret))
            try:
                import shutil as _sh
                _sh.rmtree(_iso, ignore_errors=True)
            except Exception:                            # noqa: BLE001
                pass

            # 37) build 会清掉本次未生成的旧预设
            #
            # 真实场景：应用重新 probe 后 fuse 加固 → 不再生成 start-native.cmd，
            # 但旧文件还留着 → UI 继续显示"可用"，双击必然失败。
            _bp = A.PROFILES_DIR / "_smoke_build.json"
            _bdir = A.ROOT / "apps" / "_smoke_build"
            try:
                _exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                    "System32", "notepad.exe")
                subprocess.run(["node", str(A.GEN_JS), "new", "_smoke_build", "--exe", _exe],
                               cwd=str(A.ROOT), capture_output=True, timeout=120,
                               creationflags=A.CREATE_NO_WINDOW)
                if _bp.exists():
                    subprocess.run(["node", str(A.GEN_JS), "build", "_smoke_build"],
                                   cwd=str(A.ROOT), capture_output=True, timeout=120,
                                   creationflags=A.CREATE_NO_WINDOW)
                    # 塞一个"上次遗留"的预设进去，再 build 一次
                    _bdir.mkdir(parents=True, exist_ok=True)
                    _stale = _bdir / "start-native.cmd"
                    _stale.write_text("rem stale\r\n", encoding="utf-8")
                    subprocess.run(["node", str(A.GEN_JS), "build", "_smoke_build"],
                                   cwd=str(A.ROOT), capture_output=True, timeout=120,
                                   creationflags=A.CREATE_NO_WINDOW)
                    _made = {p.name for p in _bdir.glob("*.cmd")}
                    _want = {p["file"] for p in __import__('json').loads(
                        subprocess.run(
                            ["node", "-e",
                             "const r=require('./lib/render');"
                             "const p=require('./profiles/_smoke_build.json');"
                             "process.stdout.write(JSON.stringify(r.planPresets(p)));"],
                            cwd=str(A.ROOT), capture_output=True, text=True,
                            encoding="utf-8", timeout=60,
                            creationflags=A.CREATE_NO_WINDOW).stdout or "[]")}
                    check("build 只留下本次生成的预设",
                          _made, _want, f"made={sorted(_made)} want={sorted(_want)}")
            finally:
                for _p in (_bp,):
                    try:
                        _p.unlink()
                    except Exception:                    # noqa: BLE001
                        pass
                try:
                    import shutil as _sh2
                    _sh2.rmtree(_bdir, ignore_errors=True)
                except Exception:                        # noqa: BLE001
                    pass

            # 39) doctor 的「自启动参数不同」是 warning，不该让退出码变非零
            #
            # 真实缺陷：这条消息自己写着"有意配置时正常"，却 push 进 issues
            # → problemCount → `node gen.js doctor` exit 1。任何用了
            # autostart.appArgs 的 profile 都会让 CI 永远红。
            _warn_prof = A.PROFILES_DIR / "smokewarn.json"
            _warn_apps = A.ROOT / "apps" / "smokewarn"
            try:
                _exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                    "System32", "notepad.exe")
                subprocess.run(["node", str(A.GEN_JS), "new", "smokewarn", "--exe", _exe],
                               cwd=str(A.ROOT), capture_output=True, timeout=120,
                               creationflags=A.CREATE_NO_WINDOW)
                if _warn_prof.exists():
                    _wj = _json_tpl.loads(_warn_prof.read_text(encoding="utf-8"))
                    # 用 Electron 的探测结果覆盖掉 notepad 的（否则会多出一条
                    # "未探测到 fuse 表"的 issue，与本条断言无关）。
                    _wj["runtime"] = "electron"
                    _wj["detected"] = {
                        # 用当天日期：否则会触发"探测结果已 N 天"的 issue
                        "probedAt": time.strftime("%Y-%m-%d"),
                        "runtime": "electron",
                        "electron": "30.0.0",
                        "fuses": {"version": 1, "count": 1, "hardened": [],
                                  "table": {"EnableNodeCliInspectArguments": "on"}},
                        "canUseNative": True,
                        "windowLayerGlass": False,
                        "hasPageGlass": True,
                        "singleInstance": False,
                        "userDataOverride": None,
                        "prefersColorScheme": False,
                        "markers": [],
                    }
                    _wj["appArgs"] = ["--manual"]
                    _wj["autostart"] = {"enabled": False, "appArgs": ["--boot"]}
                    _warn_prof.write_text(_json_tpl.dumps(_wj, ensure_ascii=False, indent=2),
                                          encoding="utf-8")
                    subprocess.run(["node", str(A.GEN_JS), "build", "smokewarn"],
                                   cwd=str(A.ROOT), capture_output=True, timeout=120,
                                   creationflags=A.CREATE_NO_WINDOW)
                    _wd = subprocess.run(
                        ["node", str(A.GEN_JS), "doctor", "--json"],
                        cwd=str(A.ROOT), capture_output=True, text=True,
                        encoding="utf-8", errors="replace", timeout=180,
                        creationflags=A.CREATE_NO_WINDOW)
                    _wdata = _json_tpl.loads(_wd.stdout or "{}")
                    _wrow = next((r for r in _wdata.get("profiles", [])
                                  if r.get("name") == "smokewarn"), {})
                    check("参数差异进 warnings 而不是 issues",
                          len(_wrow.get("warnings") or []), 1,
                          str(_wrow)[:200])
                    # 只看这个 profile 的贡献：全机可能还有别的问题
                    # （例如别的 profile 没 build），所以断言它的 issues 为空，
                    # 而不是断言整机 problemCount == 0。
                    check("参数差异不进入该 profile 的 issues",
                          _wrow.get("issues") or [], [],
                          str(_wrow.get("issues"))[:200])
                    check("参数差异计入 warningCount",
                          (_wdata.get("warningCount") or 0) >= 1, True,
                          str(_wdata.get("warningCount")))
                else:
                    check("参数差异进 warnings 而不是 issues", False, True, "临时 profile 未生成")
            finally:
                try:
                    _warn_prof.unlink()
                except Exception:                        # noqa: BLE001
                    pass
                try:
                    import shutil as _sh3
                    _sh3.rmtree(_warn_apps, ignore_errors=True)
                except Exception:                        # noqa: BLE001
                    pass

            # 40) 剩余的操作按钮不能是 ghost（只留 ✕ 图标按钮）
            #
            # 上一轮只修了弹窗 4 个 + 顶栏 2 个，剩下的 7 个仍是透明底 ——
            # 同样"看不出能点"。这条断言防再漏。
            _ghost_info = win.evaluate_js("""
              (() => {
                const all = [...document.querySelectorAll('button.btn')];
                const ghosts = all.filter((b) => b.classList.contains('ghost'));
                return JSON.stringify({
                  total: all.length,
                  // 同时给出 id 和文本 —— 只看 id 会把 ✕ 图标按钮误判成违规
                  ghosts: ghosts.map((b) => ({
                    id: b.id || null,
                    text: b.textContent.trim(),
                  })),
                });
              })()
            """)
            try:
                _gi = _json_tpl.loads(_ghost_info or "{}")
            except Exception:                            # noqa: BLE001
                _gi = {}
            # 允许 ghost 的只有关闭类图标按钮（文本是 ✕）
            _bad_ghosts = [
                (g.get("id") or g.get("text") or "?")
                for g in (_gi.get("ghosts") or [])
                if "✕" not in str(g.get("text") or "")
            ]
            check("除 ✕ 图标按钮外不应再有 ghost",
                  _bad_ghosts, [], str(_bad_ghosts))

            # 41) Esc 能关闭设置弹窗
            _esc_ok = win.evaluate_js("""
              (() => {
                const m = document.getElementById('autostartModal');
                m.classList.remove('hidden');
                const before = !m.classList.contains('hidden');
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                const after = m.classList.contains('hidden');
                return JSON.stringify({ before, after });
              })()
            """)
            try:
                _eo = _json_tpl.loads(_esc_ok or "{}")
            except Exception:                            # noqa: BLE001
                _eo = {}
            check("Esc 能关闭设置弹窗", _eo.get("after") is True, True, str(_eo))

            # 42) 注入器拒绝同一 profile 的第二个会话
            #
            # 真实 bug：UI 有防重复，但双击 start.cmd 两次就绕过去了 ——
            # 两个注入器抢同一个调试端口、写两份注册项。
            # 验证方式：造一条"活着的"注册项（pid 用本测试进程），
            # 起注入器，它应该在连端口之前就拒绝。
            _fake_id = "_smoke_dup_session"
            _fake = A.ROOT / "run" / "sessions" / f"{_fake_id}.json"
            try:
                _fake.parent.mkdir(parents=True, exist_ok=True)
                _fake.write_text(_json_tpl.dumps({
                    "id": _fake_id,
                    "profile": "_smoke_dup_prof",
                    "pid": os.getpid(),
                    "alive": True,
                    "startedAt": "2026-10-17T00:00:00Z",
                    "lastTick": "2026-10-17T00:00:00Z",
                }), encoding="utf-8")
                # 造一个最小 profile（不启动应用，只跑到重复检查）
                _sp = A.PROFILES_DIR / "_smoke_dup_prof.json"
                _sp.write_text(_json_tpl.dumps({
                    "name": "_smoke_dup_prof", "displayName": "_smoke_dup_prof",
                    "exe": os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                        "System32", "notepad.exe"),
                    "processName": "notepad", "styleId": "__smoke_dup__",
                    "defaultPort": 19999, "appArgs": [],
                }), encoding="utf-8")
                try:
                    _dup_run = subprocess.run(
                        ["node", str(A.INJECTOR), "--profile", str(_sp), "--list"],
                        cwd=str(A.ROOT), capture_output=True, text=True,
                        encoding="utf-8", errors="replace", timeout=40,
                        creationflags=A.CREATE_NO_WINDOW)
                    _out = (_dup_run.stdout or "") + (_dup_run.stderr or "")
                    check("注入器拒绝重复会话",
                          _dup_run.returncode == 3, True,
                          f"exit={_dup_run.returncode} {_out[:160]}")
                    check("拒绝信息指出已有会话的 pid",
                          ("已有注入会话" in _out) and (str(os.getpid()) in _out),
                          True, _out[:160])
                finally:
                    try:
                        _sp.unlink()
                    except Exception:                    # noqa: BLE001
                        pass
            finally:
                try:
                    _fake.unlink()
                except Exception:                        # noqa: BLE001
                    pass
                for _suffix in (".stop",):
                    try:
                        (A.ROOT / "run" / "sessions" / f"{_fake_id}{_suffix}").unlink()
                    except Exception:                    # noqa: BLE001
                        pass
                try:
                    (A.ROOT / "run" / "logs" / f"{_fake_id}.log").unlink()
                except Exception:                        # noqa: BLE001
                    pass

        except Exception:
            RESULT["error"] = traceback.format_exc()
        finally:
            try:
                win.destroy()
            except Exception:
                pass
            try:
                httpd.shutdown()
            except Exception:
                pass
            os._exit(0)

    threading.Thread(target=driver, daemon=True).start()
    webview.start()


if __name__ == "__main__":
    # 看门狗：测试项目多了以后要留足时间（有若干 sleep 等异步渲染）。
    # 自启动测试里 detect_pythonw 要真跑几个候选解释器（每个约 0.2-1s），
    # 所以给到 150 秒。
    watchdog = threading.Timer(150, lambda: os._exit(3))
    watchdog.daemon = True
    watchdog.start()

    run()

    print()
    print("=" * 66)
    passed = sum(1 for _, ok, _ in RESULT["checks"] if ok)
    total = len(RESULT["checks"])
    for name, ok, val in RESULT["checks"]:
        print(("  OK   " if ok else "  FAIL ") + name.ljust(28) + ("" if ok else "-> " + val))
    if RESULT["error"]:
        print()
        print("异常：")
        print(RESULT["error"])
    print("=" * 66)
    print(f"{passed}/{total} 通过")
    sys.exit(0 if passed == total and not RESULT["error"] else 1)
