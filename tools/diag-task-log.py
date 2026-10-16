import sys, time
from pathlib import Path
# 脚本自己的位置推导仓库根 —— 不写死本机路径
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ui"))
import app, webview

httpd, port = app.start_static_server()
api = app.Api()
win = webview.create_window("diag", f"http://127.0.0.1:{port}/index.html", js_api=api, width=1000, height=760)

def run(w):
    time.sleep(4)
    w.evaluate_js("""
      (() => { const it=[...document.querySelectorAll('#profileList .item')]
        .find(e=>(e.textContent||'').includes('todo')); if(it) it.click(); })()
    """)
    time.sleep(4)
    print("STATE=" + str(w.evaluate_js(
        "JSON.stringify({active:STATE.activeSession,run:STATE.sessions.filter(s=>s.running).length,"
        "domLen:document.getElementById('log').textContent.length})")), flush=True)

    w.evaluate_js("document.getElementById('btnDoctor').click()")
    print("CLICKED", flush=True)

    for i in range(5):
        time.sleep(2)
        print("T%d=%s" % (2*(i+1), w.evaluate_js(
            "JSON.stringify({active:STATE.activeSession,taskRunning:STATE.taskRunning,"
            "domLen:document.getElementById('log').textContent.length})")), flush=True)

    # 后端短任务日志里有没有内容（关键：区分"没产生"还是"没显示"）
    logs = api.get_logs(0)
    lines = logs.get("lines") or []
    print("BACKEND_TASK_LINES=%d" % len(lines), flush=True)
    for l in lines[:4]:
        print("  LINE: " + str(l)[:90], flush=True)

    # 会话缓冲里有没有 doctor 的输出（判断是否串进了会话通道）
    print("DOMHAS_VALIDATE=" + str(w.evaluate_js(
        "document.getElementById('log').textContent.indexOf('校验') >= 0")), flush=True)
    w.destroy()

webview.start(run, win, gui="edgechromium")
httpd.shutdown()
