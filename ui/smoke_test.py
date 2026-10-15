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


def check(name, value, expect=None):
    ok = (value == expect) if expect is not None else bool(value)
    RESULT["checks"].append((name, ok, repr(value)[:180]))
    return ok


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

            # 13) CSS 是否加载（检查一个只有样式表里才有的变量）
            bg = win.evaluate_js(
                "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"
            )
            check("style.css 已加载", bg == "#0f1216", True)

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
    watchdog = threading.Timer(40, lambda: os._exit(3))
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
