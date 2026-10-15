#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py —— no-glass-ele 管理界面（pywebview 宿主）

设计要点：

1. **不重新实现任何判断逻辑。** profile 的状态（是否生成、是否过期、有什么问题）
   全部来自 `node gen.js ... --json`。在 Python 里重写一遍会造出两个真相源，
   而"产物是否过期"这类判断依赖 Node 侧的指纹算法，必须只有一个出处。

2. **日志用游标轮询，不用主动 push。** 子进程输出由独立线程写进环形缓冲，
   前端每 300ms 带游标来取。比从 Python 侧调 evaluate_js 更稳 —— 后者在
   页面还没加载完时会静默失败。

3. **子进程显式指定 UTF-8。** Windows 默认 cp936，Node 输出含中文时
   不指定编码会直接抛 UnicodeDecodeError。这是本项目已经踩过的同类坑
   （.cmd 的 GBK 问题）。

4. **护栏是代码，不是注释。** QQ/微信硬拒绝；--restart 需二次确认；
   停止只杀注入器、不杀用户的应用。

零新增依赖：只用 Python 标准库 + 已安装的 pywebview。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import webview
except ImportError:
    print("需要 pywebview。请先安装：pip install pywebview", file=sys.stderr)
    sys.exit(1)


# ─────────────────────────── 路径与常量 ───────────────────────────

UI_DIR = Path(__file__).resolve().parent
ROOT = UI_DIR.parent
WEB_DIR = UI_DIR / "web"
GEN_JS = ROOT / "gen.js"
INJECTOR = ROOT / "injector" / "noglass.js"
PROFILES_DIR = ROOT / "profiles"

# 绝不接触的应用。用户明确要求（账号封禁风险）。
#
# 为什么要两套规则：只用词边界匹配会漏掉 QQNT.exe（整串是一个词，
# 边界匹配不到里面的 "qq"）；只用子串匹配又会误伤 QQMusic 这类。
# 所以短名（qq/微信）用词边界，长名（qqnt/wechat/tencent）用子串。
FORBIDDEN_WORD_BOUNDED = ("qq", "微信")
FORBIDDEN_SUBSTRING = ("qqnt", "wechat", "weixin", "tencent")

LOG_LIMIT = 4000          # 环形缓冲行数上限
POLL_HINT_MS = 300        # 提示前端轮询间隔


class ForbiddenApp(Exception):
    """目标应用在禁止名单里。"""


def check_forbidden(*texts):
    """
    QQ / 微信 硬拒绝。

    任何要启动应用、探测 exe、或写 profile 的入口都必须先过这里。
    这是代码级护栏，不是注释级约定 —— 用户明确要求避免账号风险。

    匹配范围含完整路径，所以 <local-path> 也会被拦下。
    """
    for t in texts:
        if not t:
            continue
        low = str(t).lower()

        for bad in FORBIDDEN_WORD_BOUNDED:
            # 词边界：避免 QQMusic 这类含 "qq" 的合法应用被误伤
            if re.search(r"(^|[^a-z])" + re.escape(bad) + r"([^a-z]|$)", low):
                raise ForbiddenApp(
                    f"拒绝操作：{t} 命中禁止名单（QQ / 微信）。"
                    "这是刻意的护栏，避免账号风险。"
                )

        for bad in FORBIDDEN_SUBSTRING:
            if bad in low:
                raise ForbiddenApp(
                    f"拒绝操作：{t} 命中禁止名单（QQ / 微信）。"
                    "这是刻意的护栏，避免账号风险。"
                )


# ─────────────────────────── 子进程与日志 ───────────────────────────

class LogBuffer:
    """线程安全的行缓冲。前端按游标取增量。"""

    def __init__(self, limit=LOG_LIMIT):
        self._lines = deque(maxlen=limit)
        self._lock = threading.Lock()
        self._seq = 0          # 累计写入行数（游标基于它）

    def add(self, line):
        with self._lock:
            self._lines.append(line.rstrip("\r\n"))
            self._seq += 1

    def since(self, cursor):
        """返回 (新行列表, 新游标)。cursor 是上次拿到的序号。"""
        with self._lock:
            total = self._seq
            start = max(0, total - len(self._lines))
            cur = max(cursor or 0, start)
            if cur >= total:
                return [], total
            # deque 的起点对应序号 start
            offset = cur - start
            return list(self._lines)[offset:], total

    def clear(self):
        with self._lock:
            self._lines.clear()
            # 不清 _seq：游标必须单调递增，否则前端会重复取到旧行
            return self._seq


class TaskRunner:
    """跑一个子进程，把输出逐行喂进 LogBuffer。同一时刻只允许一个任务。"""

    def __init__(self):
        self.log = LogBuffer()
        self._proc = None
        self._lock = threading.Lock()
        self._thread = None
        self._kind = None       # 'task' | 'injector'
        self._exit_code = None

    # ── 通用启动 ──
    def _spawn(self, argv, cwd, kind, env_extra=None):
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return False, "已有任务在运行，请先停止。"

            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            # 让 Node 的输出也走 UTF-8，避免 Windows 下中文乱码
            env["NODE_DISABLE_COLORS"] = "1"
            if env_extra:
                env.update(env_extra)

            self.log.add(f"$ {' '.join(argv)}")
            try:
                self._proc = subprocess.Popen(
                    argv,
                    cwd=str(cwd),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    encoding="utf-8",        # 关键：Windows 默认 cp936 会炸
                    errors="replace",        # 万一有非法字节也不中断
                    bufsize=1,
                    shell=False,
                    env=env,
                )
            except FileNotFoundError as e:
                self._proc = None
                return False, f"找不到可执行文件：{e}"
            except Exception as e:                       # noqa: BLE001
                self._proc = None
                return False, f"启动失败：{e}"

            self._kind = kind
            self._exit_code = None
            self._thread = threading.Thread(target=self._pump, daemon=True)
            self._thread.start()
            return True, ""

    def _pump(self):
        proc = self._proc
        try:
            for line in proc.stdout:
                self.log.add(line)
        except Exception as e:                           # noqa: BLE001
            self.log.add(f"[ui] 读取输出失败：{e}")
        finally:
            try:
                proc.stdout.close()
            except Exception:                            # noqa: BLE001
                pass
            code = proc.wait()
            self._exit_code = code
            self.log.add(f"—— 结束（退出码 {code}）——")
            with self._lock:
                self._proc = None

    # ── 具体入口 ──
    def run_node(self, args, deep_ok=True):
        """跑 gen.js 的一个子命令。args 是参数列表（不含 node）。"""
        argv = ["node", str(GEN_JS)] + [str(a) for a in args]
        return self._spawn(argv, ROOT, "task")

    def launch_injector(self, profile_name, extra_args=None, isolate=False):
        """
        启动注入器（常驻）。
        注意：注入器会用 detached + unref 启动目标应用 —— 所以停掉注入器
        **不会**关掉用户正在用的应用窗口。这个语义要告诉用户。
        """
        prof_path = PROFILES_DIR / f"{profile_name}.json"
        if not prof_path.exists():
            return False, f"profile 不存在：{prof_path}"

        # 护栏：读 profile 里的目标应用，确认不在禁止名单
        try:
            data = json.loads(prof_path.read_text(encoding="utf-8"))
            check_forbidden(data.get("name"), data.get("displayName"),
                            data.get("processName"), data.get("exe"))
        except ForbiddenApp as e:
            return False, str(e)
        except Exception as e:                           # noqa: BLE001
            return False, f"读取 profile 失败：{e}"

        args = ["--profile", str(prof_path), "--launch", "--watch"]
        if isolate:
            args.append("--isolate")
        if extra_args:
            args.extend(extra_args)
        argv = ["node", str(INJECTOR)] + args
        return self._spawn(argv, ROOT, "injector")

    def stop(self):
        """
        停止当前任务。
        只结束注入器/任务本身 —— 目标应用是 detached 启动的，不受影响。
        """
        with self._lock:
            proc = self._proc
        if not proc or proc.poll() is not None:
            return False, "当前没有在运行的任务。"

        kind = self._kind
        try:
            if os.name == "nt":
                # 用 taskkill /T 连子进程一起收，但注入器 spawn 的应用是
                # detached（DETACHED_PROCESS），不在同一进程树里，所以安全。
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True, timeout=10,
                )
            else:
                proc.terminate()
        except Exception as e:                           # noqa: BLE001
            return False, f"停止失败：{e}"

        self.log.add(f"[ui] 已停止（{kind}）。目标应用不受影响。")
        with self._lock:
            self._proc = None
        return True, ""

    def status(self):
        with self._lock:
            proc = self._proc
            kind = self._kind
        running = bool(proc and proc.poll() is None)
        return {
            "running": running,
            "kind": kind if running else None,
            "pid": proc.pid if running else None,
        }


RUNNER = TaskRunner()


# ─────────────────────────── Node 调用 ───────────────────────────

def run_node_json(args, timeout=180):
    """跑 gen.js 并解析 JSON 输出。失败时抛出带 stderr 的异常。"""
    argv = ["node", str(GEN_JS)] + [str(a) for a in args]
    try:
        p = subprocess.run(
            argv, cwd=str(ROOT), capture_output=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError("找不到 node。请确认 Node 18+ 已安装并在 PATH 中。")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"命令超时（{timeout}s）：{' '.join(argv)}")

    out = (p.stdout or "").strip()
    if not out:
        raise RuntimeError(f"命令无输出（退出码 {p.returncode}）：{(p.stderr or '').strip()[:400]}")

    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # gen.js 的 --json 可能因为前置错误打印了非 JSON（如 "exe 不存在"）
        raise RuntimeError(f"输出不是合法 JSON：{out[:400]}")


def list_profiles_on_disk():
    if not PROFILES_DIR.exists():
        return []
    return sorted(
        f.stem for f in PROFILES_DIR.glob("*.json") if not f.name.startswith("_")
    )


def read_profile(name):
    p = PROFILES_DIR / f"{name}.json"
    if not p.exists():
        raise RuntimeError(f"profile 不存在：{name}")
    return json.loads(p.read_text(encoding="utf-8"))


def write_profile(name, data):
    # 护栏：不允许把禁止名单里的应用写进 profile
    check_forbidden(name, data.get("displayName"), data.get("processName"), data.get("exe"))
    # 名字必须是安全标识符，避免路径穿越
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
        raise RuntimeError("profile 名只能含字母、数字、点、下划线、连字符（1-64 位）。")

    p = PROFILES_DIR / f"{name}.json"
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    # newline="\n"：显式写 LF。
    # Windows 上 Path.write_text 默认会把 \n 转成 \r\n，而 gen.js 生成的产物
    # 是 LF —— 两者混用会让 git 每次都说"文件被改动"，也破坏指纹比对的可读性。
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return str(p)


# ─────────────────────────── 进程查询（只读进程表，不扫盘）───────────────────────────

def list_running_processes():
    """
    列出有路径的进程，供"从运行中的应用里挑 exe"。

    两个必须做的处理：

    1. **强制 UTF-8 输出。** Windows PowerShell 默认按控制台代码页（中文系统
       是 GBK）输出，用 UTF-8 解码会得到乱码（实测：`小程序` 变成 `С����`）。
       解法是先设 `[Console]::OutputEncoding`。

    2. **过滤禁止名单。** 进程表里本来就有 QQ / 微信 —— 它们绝不该出现在
       可选列表里，哪怕用户只是"看到"。所以这里直接剔除，不给误点的机会。

    只查进程表，不遍历文件系统。
    """
    if os.name != "nt":
        return []

    ps = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        "Get-Process | Where-Object { $_.Path } | "
        "Select-Object ProcessName, Path | "
        "Sort-Object ProcessName -Unique | "
        "ConvertTo-Json -Compress"
    )
    try:
        p = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, encoding="utf-8", errors="replace", timeout=25,
        )
        raw = (p.stdout or "").strip()
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]

        out = []
        for d in data:
            name = d.get("ProcessName") or ""
            path = d.get("Path") or ""
            if not path or not path.lower().endswith(".exe"):
                continue

            # 禁止名单：连展示都不展示
            try:
                check_forbidden(name, path)
            except ForbiddenApp:
                continue

            # 跳过明显不是主程序的（Electron 的 helper 进程等）
            low = Path(path).name.lower()
            if any(k in low for k in ("crashpad", "uninstall", "setup", "elevate", "helper")):
                continue

            # 跳过 Windows 系统目录里的进程 —— 那些不是用户想注入的应用
            plow = path.lower()
            if "\\windows\\" in plow or "\\windowsapps\\" in plow:
                continue

            out.append({"processName": name, "exe": path})
        return sorted(out, key=lambda x: x["processName"].lower())
    except Exception:                                    # noqa: BLE001
        return []


# ─────────────────────────── 本地静态服务 ───────────────────────────

class QuietHandler(SimpleHTTPRequestHandler):
    """只服务 web/ 目录，静默日志（否则会污染控制台）。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):                   # noqa: A003
        pass

    def end_headers(self):
        # 开发期禁用缓存，避免改了 HTML 却看到旧页面
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


def start_static_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


# ─────────────────────────── 暴露给 JS 的 API ───────────────────────────

class Api:
    """
    所有方法都会被 pywebview 暴露成 window.pywebview.api.<name>()。
    返回值一律是可 JSON 序列化的 dict。
    """

    # ── 基础状态 ──
    def get_state(self):
        try:
            node_ok = shutil.which("node") is not None
        except Exception:                                # noqa: BLE001
            node_ok = False
        return {
            "ok": True,
            "root": str(ROOT),
            "nodeOk": node_ok,
            "hasGen": GEN_JS.exists(),
            "hasInjector": INJECTOR.exists(),
            "pollHintMs": POLL_HINT_MS,
            "task": RUNNER.status(),
        }

    def get_overview(self):
        """profile 列表 + 校验结果。两者都来自 gen.js --json。"""
        try:
            listing = run_node_json(["list", "--json"])
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}
        try:
            doctor = run_node_json(["doctor", "--json"])
        except Exception as e:                           # noqa: BLE001
            doctor = {"ok": False, "profiles": [], "problemCount": 0, "error": str(e)}

        issues = {p["name"]: p.get("issues", []) for p in doctor.get("profiles", [])}
        for prof in listing.get("profiles", []):
            prof["issues"] = issues.get(prof["name"], [])
        return {
            "ok": True,
            "profiles": listing.get("profiles", []),
            "doctorOk": doctor.get("ok", False),
            "problemCount": doctor.get("problemCount", 0),
            "task": RUNNER.status(),
        }

    # ── profile 读写 ──
    def get_profile(self, name):
        try:
            return {"ok": True, "name": name, "data": read_profile(name)}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def save_profile(self, name, data):
        try:
            path = write_profile(name, data)
            return {"ok": True, "path": path}
        except ForbiddenApp as e:
            return {"ok": False, "error": str(e), "forbidden": True}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ── 任务 ──
    def run_task(self, task, name=None, exe=None, deep=True):
        """task: probe | build | doctor | list —— 输出走日志通道，供人看。"""
        try:
            args = self._task_args(task, name, exe, deep, as_json=False)
            if args is None:
                return {"ok": False, "error": f"未知任务：{task}"}
            ok, err = RUNNER.run_node(args)
            if not ok:
                return {"ok": False, "error": err}
            return {"ok": True}
        except ForbiddenApp as e:
            return {"ok": False, "error": str(e), "forbidden": True}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def probe_json(self, exe, deep=True):
        """
        同步探测并返回**结构化结果**（不经过日志通道）。

        与 run_task('probe') 的分工：
          · run_task  —— 把输出打进日志，让人看见过程
          · probe_json —— 直接拿 JSON，让界面填表单
        向导需要后者，否则得靠"跑完再从日志里抠 JSON"，脆弱且慢。
        """
        try:
            check_forbidden(exe)
            args = ["probe", exe] + (["--deep"] if deep else []) + ["--json"]
            data = run_node_json(args, timeout=240)
            return {"ok": True, "data": data}
        except ForbiddenApp as e:
            return {"ok": False, "error": str(e), "forbidden": True}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _task_args(task, name, exe, deep, as_json):
        if task == "probe":
            if not exe:
                raise RuntimeError("缺少 exe 路径")
            check_forbidden(exe)
            return ["probe", exe] + (["--deep"] if deep else []) + (["--json"] if as_json else [])
        if task == "build":
            return ["build"] + ([name] if name else ["--all"])
        if task == "doctor":
            return ["doctor"] + (["--json"] if as_json else [])
        if task == "list":
            return ["list"] + (["--json"] if as_json else [])
        return None

    def launch(self, name, isolate=False, extra=None):
        try:
            check_forbidden(name)
            extra_args = None
            if extra:
                # 只接受数组，避免任意命令注入
                if isinstance(extra, str):
                    extra_args = [a for a in extra.split() if a]
                elif isinstance(extra, list):
                    extra_args = [str(a) for a in extra]
            ok, err = RUNNER.launch_injector(name, extra_args=extra_args, isolate=bool(isolate))
            return {"ok": ok, "error": err} if not ok else {"ok": True}
        except ForbiddenApp as e:
            return {"ok": False, "error": str(e), "forbidden": True}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def stop_task(self):
        ok, err = RUNNER.stop()
        return {"ok": ok, "error": err} if not ok else {"ok": True}

    def get_task_status(self):
        return {"ok": True, "task": RUNNER.status()}

    # ── 日志 ──
    def get_logs(self, cursor=0):
        try:
            lines, new_cursor = RUNNER.log.since(int(cursor or 0))
            return {"ok": True, "lines": lines, "cursor": new_cursor}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "lines": [], "cursor": cursor}

    def clear_logs(self):
        cur = RUNNER.log.clear()
        return {"ok": True, "cursor": cur}

    # ── 新建向导辅助 ──
    def list_running(self):
        return {"ok": True, "processes": list_running_processes()}

    def pick_exe(self):
        """原生文件选择框。不扫盘，只让用户点。"""
        try:
            result = webview.windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("Executable (*.exe)", "All files (*.*)"),
            )
            if not result:
                return {"ok": False, "cancelled": True}
            path = result[0] if isinstance(result, (list, tuple)) else result
            check_forbidden(path)
            return {"ok": True, "exe": str(path)}
        except ForbiddenApp as e:
            return {"ok": False, "error": str(e), "forbidden": True}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def create_profile(self, name, data):
        """向导最后一步：写 profile（与 save_profile 同路径，语义上分开更清楚）。"""
        return self.save_profile(name, data)


# ─────────────────────────── 入口 ───────────────────────────

def main():
    if not GEN_JS.exists():
        print(f"找不到 gen.js：{GEN_JS}", file=sys.stderr)
        return 1
    if not WEB_DIR.exists():
        print(f"找不到前端目录：{WEB_DIR}", file=sys.stderr)
        return 1

    httpd, port = start_static_server()
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"[ui] no-glass-ele 管理界面：{url}")
    print(f"[ui] 项目根目录：{ROOT}")

    api = Api()
    window = webview.create_window(
        "no-glass-ele · Electron 去毛玻璃管理",
        url,
        js_api=api,
        width=1180,
        height=780,
        min_size=(900, 600),
        background_color="#0f1216",
    )
    # 用 winforms + edgechromium（WebView2）；已在本机实测可用
    webview.start()
    try:
        httpd.shutdown()
    except Exception:                                    # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
