#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI 冒烟测试 —— 真的开一个窗口，验证渲染与 API 桥，然后自动关闭。

为什么要真的开窗口：pywebview 的桥和页面加载时序有坑（pywebviewready
事件可能错过、CSP 可能拦脚本），只做静态检查发现不了。

有硬超时保护，绝不会挂住会话。
"""
import os
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
        time.sleep(6)  # 等页面加载 + app.js 初始化
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

            # 16) 自定义 CSS 编辑器存在且可写
            win.evaluate_js(
                "document.getElementById('cssEditor').value = '/* smoke */ .x{color:red}'"
            )
            check("CSS 编辑器可写",
                  "smoke" in (win.evaluate_js("document.getElementById('cssEditor').value") or ""), True)

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
    # 看门狗：测试项目多了以后要留足时间（有若干 sleep 等异步渲染）
    watchdog = threading.Timer(90, lambda: os._exit(3))
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
