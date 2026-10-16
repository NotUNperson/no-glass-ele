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

4. **护栏是代码，不是注释。** --restart 需二次确认；
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sessions  # noqa: E402  （与 lib/sessions.js 同一套磁盘契约）


# ─────────────────────────── 路径与常量 ───────────────────────────

UI_DIR = Path(__file__).resolve().parent
ROOT = UI_DIR.parent
WEB_DIR = UI_DIR / "web"
GEN_JS = ROOT / "gen.js"
INJECTOR = ROOT / "injector" / "noglass.js"
PROFILES_DIR = ROOT / "profiles"
CSS_DIR = ROOT / "css"

# 隐藏子进程的控制台窗口。
#
# 为什么需要：UI 由 pythonw.exe 启动（GUI 子系统，没有控制台），
# 而 node.exe 是控制台子系统程序。不加这个标志，Windows 会为它
# **新分配一个控制台窗口** —— 用户会看到一个空终端（输出其实被我们的
# 管道接走了，所以窗口里什么都没有）。
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# ── overview 缓存 ──
#
# get_overview 要跑两次 gen.js（各起一个 node 进程，实测合计约 1.7 秒）。
# 前端若每次轮询都调，就会持续派生进程。所以加 TTL 缓存：
# 过期才真跑，其余时候读缓存（会话列表仍实时刷新，因为它读磁盘、很廉价）。
OVERVIEW_TTL_SEC = 5.0
_overview_lock = threading.Lock()
_overview_cache = {"at": 0.0, "data": None}

# ── 进程列表缓存（新建向导用）──
#
# list_running_processes 要起一个 PowerShell（约 1-2 秒）。
# 向导打开时才需要，所以缓存久一点。
PROCESS_LIST_TTL_SEC = 20.0
_proc_lock = threading.Lock()
_proc_cache = {"at": 0.0, "data": []}

LOG_LIMIT = 4000          # 环形缓冲行数上限
POLL_HINT_MS = 300        # 提示前端轮询间隔


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
    """
    跑子进程并收集输出。

    两类任务，语义不同：

      · **短任务**（probe / build / doctor / list）—— 一次性、会写文件，
        所以串行执行，共用一块日志缓冲 `_task_log`。

      · **注入会话**（--launch --watch）—— 常驻、每个应用一个。
        各自独立的 LogBuffer 与进程句柄，**不限数量**，
        这样多个应用的注入能同时被监控。
    """

    def __init__(self):
        self._lock = threading.Lock()
        # 短任务：单槽 + 单一日志
        self._task_proc = None
        self._task_log = LogBuffer()
        self._thread = None
        # 注入会话：localId -> {profile, proc, log, startedAt, exitCode, endedAt}
        self._sessions = {}
        # 兼容旧字段（外部仍读 .log）
        self.log = self._task_log

    # ── 通用启动 ──
    def _spawn(self, argv, cwd, kind, env_extra=None):
        with self._lock:
            # 短任务（probe/build/doctor）串行 —— 它们会写文件，并发没有意义。
            # 注入会话不限数量：每个应用一个，各自独立。
            if kind == "task" and self._task_proc and self._task_proc.poll() is None:
                return False, "已有短任务在运行，请先等待它结束。"
            if kind == "task":
                log = self._task_log
            else:
                return False, "内部错误：注入会话请用 launch_injector。"

            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            # 让 Node 的输出也走 UTF-8，避免 Windows 下中文乱码
            env["NODE_DISABLE_COLORS"] = "1"
            if env_extra:
                env.update(env_extra)

            log.add(f"$ {' '.join(argv)}")
            try:
                self._task_proc = subprocess.Popen(
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
                    creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            except FileNotFoundError as e:
                self._task_proc = None
                return False, f"找不到可执行文件：{e}"
            except Exception as e:                       # noqa: BLE001
                self._task_proc = None
                return False, f"启动失败：{e}"

            self._thread = threading.Thread(
                target=self._pump, args=(self._task_proc, log, "task"), daemon=True)
            self._thread.start()
            return True, ""

    def _pump(self, proc, log, kind, session_id=None):
        """读子进程输出直到结束。"""
        try:
            for line in proc.stdout:
                log.add(line)
        except Exception as e:                           # noqa: BLE001
            log.add(f"[ui] 读取输出失败：{e}")
        finally:
            try:
                proc.stdout.close()
            except Exception:                            # noqa: BLE001
                pass
            code = proc.wait()
            log.add(f"—— 结束（退出码 {code}）——")
            with self._lock:
                if kind == "task":
                    self._task_proc = None
                elif session_id and session_id in self._sessions:
                    self._sessions[session_id]["proc"] = None
                    self._sessions[session_id]["exitCode"] = code
                    self._sessions[session_id]["endedAt"] = time.time()

    # ── 具体入口 ──
    def run_node(self, args, deep_ok=True):
        """跑 gen.js 的一个子命令。args 是参数列表（不含 node）。"""
        argv = ["node", str(GEN_JS)] + [str(a) for a in args]
        return self._spawn(argv, ROOT, "task")

    def launch_injector(self, profile_name, extra_args=None, isolate=False,
                        emulate=None, app_args=None, detached=False):
        """
        启动一个注入会话（常驻）。**可以同时跑多个** —— 每个应用一个。

        detached=False（UI 用）：stdout 接管道，输出实时喂给 UI 的日志面板。
        detached=True（自启动/无窗口用）：stdout 接 DEVNULL 并真正脱离父进程。
            为什么不接管道：父进程（pythonw）拉起注入器后就退出了，
            管道读端关闭；注入器下次往 stdout 写就会 EPIPE 崩溃。
            脱离后它靠自己的 run/logs/<id>.log 留痕。

        注意语义：注入器用 detached + unref 启动目标应用，所以停掉注入器
        **不会**关掉用户正在用的应用窗口。这个语义要在 UI 上说明。
        """
        prof_path = PROFILES_DIR / f"{profile_name}.json"
        if not prof_path.exists():
            return {"ok": False, "error": f"profile 不存在：{prof_path}"}

        try:
            json.loads(prof_path.read_text(encoding="utf-8"))
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": f"读取 profile 失败：{e}"}

        # 同一个 profile 已经在跑就不重复启动（否则会争同一个调试端口）
        if not detached:
            with self._lock:
                for sid, s in self._sessions.items():
                    if s.get("profile") == profile_name and s.get("proc") and s["proc"].poll() is None:
                        return {"ok": False,
                                "error": f"{profile_name} 已经在运行中（会话 {sid}）。"}
        else:
            # 无窗口模式也要防重复：查注册表 + 进程表
            try:
                for r in sessions.list_all():
                    if r.get("profile") == profile_name and r.get("alive"):
                        return {"ok": False,
                                "error": f"{profile_name} 已经在运行中（pid {r.get('pid')}）。"}
            except Exception:                            # noqa: BLE001
                pass

        args = ["--profile", str(prof_path), "--launch", "--watch",
                "--source", "autostart" if detached else "ui"]
        if isolate:
            args.append("--isolate")
        if emulate:
            args.extend(["--emulate-color-scheme", str(emulate)])
        for a in (app_args or []):
            args.extend(["--app-arg", str(a)])
        if extra_args:
            args.extend(extra_args)
        argv = ["node", str(INJECTOR)] + args

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["NODE_DISABLE_COLORS"] = "1"

        if detached:
            # 完全脱离：不接管道，独立进程组，无控制台窗口。
            # DETACHED_PROCESS 让子进程没有控制台；CREATE_NO_WINDOW 保证不新建。
            flags = 0
            if os.name == "nt":
                DETACHED_PROCESS = 0x00000008
                flags = DETACHED_PROCESS | CREATE_NO_WINDOW
            try:
                proc = subprocess.Popen(
                    argv, cwd=str(ROOT),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    shell=False, env=env, creationflags=flags,
                    close_fds=True,
                )
            except FileNotFoundError as e:
                return {"ok": False, "error": f"找不到可执行文件：{e}"}
            except Exception as e:                       # noqa: BLE001
                return {"ok": False, "error": f"启动失败：{e}"}
            # 注入器会自己写 run/logs/<profile>-<pid>.log，不依赖我们的管道
            return {"ok": True, "localId": None, "pid": proc.pid, "detached": True}

        log = LogBuffer()
        log.add(f"$ {' '.join(argv)}")
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                shell=False,
                env=env,
                # 关键：UI 是 pythonw（无控制台）启动的，而 node.exe 是控制台
                # 子系统程序。不加这个标志，Windows 会给它分配一个新控制台窗口
                # —— 用户会看到一个空终端（输出其实被我们管道接走了）。
                creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except FileNotFoundError as e:
            return {"ok": False, "error": f"找不到可执行文件：{e}"}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": f"启动失败：{e}"}

        # 会话 id 由注入器自己生成并登记；这里先用 pid 做本地键，
        # 稍后从注册表把真正的 id 关联上（见 reconcile()）。
        local_id = f"{profile_name}#{proc.pid}"
        with self._lock:
            self._sessions[local_id] = {
                "localId": local_id,
                "profile": profile_name,
                "proc": proc,
                "log": log,
                "startedAt": time.time(),
                "exitCode": None,
                "endedAt": None,
            }
        threading.Thread(target=self._pump,
                         args=(proc, log, "injector", local_id),
                         daemon=True).start()
        return {"ok": True, "localId": local_id, "pid": proc.pid}

    def stop_session(self, local_id):
        """
        停止一个注入会话。

        **绝不 taskkill /T**：注入器启动的目标应用虽然 detached，但父子关系
        仍在进程表里，/T 会顺树把应用一起杀掉，关掉用户正在用的窗口。

        优先走协作式停止：从注册表找到该会话的 id，放一个停止文件。
        兜底才按 PID 单杀（不带 /T）。
        """
        with self._lock:
            s = self._sessions.get(local_id)
        if not s:
            return {"ok": False, "error": f"没有这个会话：{local_id}"}

        proc = s.get("proc")
        if not proc or proc.poll() is not None:
            return {"ok": False, "error": "该会话已结束。"}

        # 找到它在注册表里的 id（注入器启动后自己登记的）
        reg_id = None
        try:
            for r in sessions.list_registered(force=True):
                if r.get("pid") == proc.pid:
                    reg_id = r.get("id")
                    break
        except Exception:                                # noqa: BLE001
            pass

        if reg_id:
            okr, err = sessions.request_stop(reg_id)
            if not okr:
                return {"ok": False, "error": f"停止请求失败：{err}"}
            s["log"].add("[ui] 已发送停止请求（协作式）。目标应用不会被关闭。")
            # 给它一点时间优雅退出
            for _ in range(30):
                if proc.poll() is not None:
                    return {"ok": True, "graceful": True}
                time.sleep(0.2)
            s["log"].add("[ui] 优雅停止超时，改为按 PID 结束注入器（不带 /T，应用不受影响）。")

        # 兜底：只杀注入器自己的 PID。**不加 /T。**
        okk, err = sessions.force_kill(proc.pid)
        if not okk:
            return {"ok": False, "error": f"结束失败：{err}"}
        s["log"].add("[ui] 注入器已结束。目标应用不受影响。")
        return {"ok": True, "graceful": False}

    def stop_task_only(self):
        """
        只停「短任务」（probe / build / doctor），**绝不碰任何注入会话**。

        为什么单独拆出来：界面上的「停止」按钮原来是转调 stop()，而它会
        在「当前应用没有会话」时顺手停掉字典里第一个活会话 —— 那是个与
        用户意图无关的会话。现在按钮语义明确为"停当前应用"，短任务走这里。

        这里的 taskkill 带 /T：短任务只跑 `node gen.js <子命令>`，不启动
        目标应用，所以沿进程树杀是安全的（注入会话那条路径才是绝不能 /T，
        因为应用是注入器 detached 启动的、进程表里仍算它的子进程）。
        """
        with self._lock:
            p = self._task_proc
        if not p or p.poll() is not None:
            return False, "当前没有在运行的任务。"
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                               capture_output=True, timeout=10)
            else:
                p.terminate()
        except Exception as e:                           # noqa: BLE001
            return False, f"停止失败：{e}"
        return True, ""

    def stop(self):
        """遗留：停止「任意一个」运行中的注入会话。

        前端已不再调用（它停谁取决于字典插入序，与界面语义无关）。
        保留是为了兼容可能存在的旧调用方。
        """
        with self._lock:
            for lid, s in self._sessions.items():
                if s.get("proc") and s["proc"].poll() is None:
                    return self.stop_session(lid)
        # 没有注入会话时，若有短任务在跑就结束它
        return self.stop_task_only()

    def status(self):
        """短任务状态 + 所有注入会话的概要。"""
        with self._lock:
            tp = self._task_proc
            sessions_snapshot = {
                lid: {
                    "profile": s["profile"],
                    "pid": s["proc"].pid if s.get("proc") else None,
                    "running": bool(s.get("proc") and s["proc"].poll() is None),
                    "startedAt": s.get("startedAt"),
                    "exitCode": s.get("exitCode"),
                }
                for lid, s in self._sessions.items()
            }
        task_running = bool(tp and tp.poll() is None)
        any_session = any(v["running"] for v in sessions_snapshot.values())
        return {
            # 兼容旧前端字段
            "running": task_running or any_session,
            "kind": "task" if task_running else ("injector" if any_session else None),
            "pid": tp.pid if task_running else None,
            # 新增
            "taskRunning": task_running,
            "sessions": sessions_snapshot,
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
            creationflags=CREATE_NO_WINDOW,
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

    **强制 UTF-8 输出。** Windows PowerShell 默认按控制台代码页（中文系统
    是 GBK）输出，用 UTF-8 解码会得到乱码（实测：`小程序` 变成 `С����`）。
    解法是先设 `[Console]::OutputEncoding`。

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
            creationflags=CREATE_NO_WINDOW,
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

    def get_overview(self, force=False):
        """
        profile 列表 + 校验结果 + 会话列表。

        profile/doctor 数据来自 `gen.js --json`，每次调用要起两个 node 进程
        （实测合计约 1.7 秒）。所以结果带 TTL 缓存 —— 前端高频刷新时读缓存，
        只有缓存过期才真的跑 node。会话列表另走 sessions 模块（它自带缓存）。

        force=True 用于「用户点了刷新」这类明确要求最新数据的场景。
        """
        global _overview_cache
        now = time.time()

        with _overview_lock:
            fresh = (now - _overview_cache["at"]) < OVERVIEW_TTL_SEC
            if fresh and not force:
                cached = _overview_cache["data"]
                if cached:
                    # 会话列表是实时的（读磁盘注册表，廉价），单独刷新
                    out = dict(cached)
                    try:
                        out["sessions"] = self.list_sessions().get("sessions", [])
                    except Exception:                    # noqa: BLE001
                        out["sessions"] = []
                    try:
                        out["task"] = RUNNER.status()
                    except Exception:                    # noqa: BLE001
                        pass
                    return out

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

        try:
            sess = self.list_sessions().get("sessions", [])
        except Exception:                                # noqa: BLE001
            sess = []

        out = {
            "ok": True,
            "profiles": listing.get("profiles", []),
            "doctorOk": doctor.get("ok", False),
            "problemCount": doctor.get("problemCount", 0),
            "task": RUNNER.status(),
            "sessions": sess,
        }
        with _overview_lock:
            _overview_cache["at"] = time.time()
            _overview_cache["data"] = dict(out)
        return out

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
            args = ["probe", exe] + (["--deep"] if deep else []) + ["--json"]
            data = run_node_json(args, timeout=240)
            return {"ok": True, "data": data}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _task_args(task, name, exe, deep, as_json):
        if task == "probe":
            if not exe:
                raise RuntimeError("缺少 exe 路径")
            return ["probe", exe] + (["--deep"] if deep else []) + (["--json"] if as_json else [])
        if task == "build":
            return ["build"] + ([name] if name else ["--all"])
        if task == "doctor":
            return ["doctor"] + (["--json"] if as_json else [])
        if task == "list":
            return ["list"] + (["--json"] if as_json else [])
        return None

    def launch(self, name, isolate=False, extra=None, emulate=None, appArgs=None):
        try:
            extra_args = None
            if extra:
                # 只接受数组，避免任意命令注入
                if isinstance(extra, str):
                    extra_args = [a for a in extra.split() if a]
                elif isinstance(extra, list):
                    extra_args = [str(a) for a in extra]
            if emulate not in (None, "", "none", "auto"):
                if emulate not in ("dark", "light"):
                    return {"ok": False, "error": f"配色模拟只能是 dark 或 light，收到 {emulate!r}"}
            else:
                emulate = None
            aa = [str(a) for a in (appArgs or []) if str(a).strip()] or None
            return RUNNER.launch_injector(
                name, extra_args=extra_args, isolate=bool(isolate),
                emulate=emulate, app_args=aa,
            )
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ── 会话（多进程监控）──
    def list_sessions(self):
        """
        列出所有注入会话：本地启动的 + 从注册表读到的 + 进程表发现的。

        每个会话都带一个**稳定的 key**，前端用它做标签身份与日志游标。
        为什么必须有 key：外部发现的注入器既没有 localId 也没有 id
        （旧版本没登记），早期版本直接返回 None，前端 `localId || id`
        得到空值 —— 所有外部标签撞成同一个空 key，点一下日志区就永久空白。

        key 的构成（按优先级）：
          1. localId（本地启动的，有实时日志缓冲）
          2. id（注册表登记的，如 obsidian-1234）
          3. ext:<pid>（外部发现的，pid 一定存在）
        """
        try:
            status = RUNNER.status()
            local = status.get("sessions", {})
        except Exception:                                # noqa: BLE001
            local = {}

        # 注册表（含外部发现）
        try:
            reg = sessions.list_all()
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": f"读取会话注册表失败：{e}", "sessions": []}

        out = []
        seen_pids = set()

        # 先放本地启动的（有实时日志缓冲）
        for lid, s in local.items():
            pid = s.get("pid")
            # 从注册表补齐元数据
            meta = next((r for r in reg if r.get("pid") == pid), None)
            reg_id = meta.get("id") if meta else None
            out.append({
                # key 永不为空：localId 一定有值（字典键）
                "key": lid or (reg_id or (f"ext:{pid}" if pid else None)),
                "localId": lid,
                "id": reg_id,
                "profile": s.get("profile"),
                "displayName": (meta or {}).get("displayName") or s.get("profile"),
                "pid": pid,
                "port": (meta or {}).get("port"),
                "running": s.get("running"),
                "zombie": bool((meta or {}).get("zombie")),
                "startedAt": (meta or {}).get("startedAt"),
                "source": (meta or {}).get("source") or "ui",
                "external": False,
                "hasLiveLog": True,
                "pages": (meta or {}).get("pages"),
                "cssExtra": (meta or {}).get("cssExtra"),
                "emulateColorScheme": (meta or {}).get("emulateColorScheme"),
                "darkreader": (meta or {}).get("darkreader"),
                "darkreaderTheme": (meta or {}).get("darkreaderTheme"),
            })
            if pid:
                seen_pids.add(pid)

        # 再放注册表里其余（外部启动的、或本地已结束但仍登记的）
        for r in reg:
            if r.get("pid") in seen_pids:
                continue
            pid = r.get("pid")
            reg_id = r.get("id")
            out.append({
                # 外部发现的一定有 pid，所以 key 也一定非空
                "key": reg_id or (f"ext:{pid}" if pid else None),
                "localId": None,
                "id": reg_id,
                "profile": r.get("profile"),
                "displayName": r.get("displayName") or r.get("appName") or r.get("profile"),
                "pid": pid,
                "port": r.get("port"),
                # zombie 是"pid 还在但心跳早停了"（硬关机残留）—— 它不能算
                # 运行中，否则 UI 上就是个点不动的标签。
                "running": bool(r.get("alive")) and not r.get("zombie"),
                "zombie": bool(r.get("zombie")),
                "startedAt": r.get("startedAt"),
                "source": r.get("source") or ("external" if r.get("external") else "cli"),
                "external": bool(r.get("external")),
                "hasLiveLog": False,
                "pages": r.get("pages"),
                "cssExtra": r.get("cssExtra"),
                "emulateColorScheme": r.get("emulateColorScheme"),
                "darkreader": r.get("darkreader"),
                "darkreaderTheme": r.get("darkreaderTheme"),
            })

        # 过滤掉连 pid 都没有的僵尸项（理论上不该出现）
        out = [x for x in out if x.get("key")]

        out.sort(key=lambda x: (not x.get("running"), str(x.get("startedAt") or "")))
        return {"ok": True, "sessions": out}

    def stop_session(self, local_id=None, session_id=None, pid=None):
        """
        停止一个会话。三种定位方式，按优先级：
          1. localId —— 本 UI 启动的，进程句柄在我们手上
          2. sessionId —— 注册表登记的，用 .stop 文件探活（见下）
          3. pid —— 外部发现的注入器，命令行已验证含 noglass.js

        **绝不 taskkill /T**：注入器启动的目标应用虽然 detached，
        但 Windows 进程表里仍记录父子关系，/T 会顺树把应用一起杀掉。

        关于第 2 条为什么用 cleanup_residual 而不是直接写停止文件：
        直接写文件对**活着的**注入器有效（它 1 秒内消费），但对**已死的**
        注入器完全无效 —— 没人消费那个文件，注册项永远留着，表现就是
        "点多少次都停不掉"（硬关机残留）。cleanup_residual 用文件本身
        探活，两种情况下都能给出确定结果，且不对任何 pid 发 kill
        （那个 pid 可能已被复用给无关进程）。
        """
        try:
            if local_id:
                return RUNNER.stop_session(local_id)

            if session_id:
                result, msg = sessions.cleanup_residual(session_id)
                if result == "missing":
                    return {"ok": False, "error": msg}
                if result == "error":
                    return {"ok": False, "error": msg}
                return {"ok": True, "graceful": (result == "stopped"),
                        "residual": (result == "cleaned"), "message": msg}

            if pid:
                # 外部注入器：先看它是否其实有登记项（可能只是注册表被清了）
                try:
                    for r in sessions.list_registered(force=True):
                        if str(r.get("pid")) == str(pid):
                            result, msg = sessions.cleanup_residual(r.get("id"))
                            if result in ("stopped", "cleaned"):
                                return {"ok": True, "graceful": (result == "stopped"),
                                        "residual": (result == "cleaned"), "message": msg}
                            break
                except Exception:                        # noqa: BLE001
                    pass
                # 走到这里说明它没有可用登记项。这个 pid 是**外部发现**来的，
                # 而外部发现要求命令行含 noglass.js —— 身份已验证，可以强停。
                okk, err = sessions.force_kill(pid)
                if not okk:
                    return {"ok": False, "error": err}
                return {"ok": True, "graceful": False,
                        "note": "这是外部发现的注入器（命令行已验证），已按 pid 结束。目标应用未受影响。"}

            return {"ok": False, "error": "需要 localId / sessionId / pid 之一"}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def get_session_log(self, local_id=None, session_id=None, cursor=0, pid=None):
        """
        取某会话的日志。

        · 本地会话走内存缓冲（增量、游标）
        · 外部会话（有登记项）读磁盘日志文件
        · 外部发现的旧版注入器没有日志文件，返回明确提示而不是空白
        """
        try:
            if local_id:
                with RUNNER._lock:                       # noqa: SLF001
                    s = RUNNER._sessions.get(local_id)   # noqa: SLF001
                if not s:
                    return {"ok": False, "error": "会话不存在", "lines": [], "cursor": cursor}
                lines, new_cursor = s["log"].since(int(cursor or 0))
                return {"ok": True, "lines": lines, "cursor": new_cursor, "live": True}

            if session_id:
                text, _ = sessions.read_log(session_id)
                lines = text.splitlines()
                if not lines:
                    return {"ok": True, "lines": [], "cursor": 0, "live": False,
                            "path": sessions.log_path(session_id),
                            "note": "该会话暂无日志文件内容。"}
                return {"ok": True, "lines": lines[-400:], "cursor": 0,
                        "live": False, "path": sessions.log_path(session_id)}

            if pid:
                # 外部发现的旧版注入器：查它有没有登记项
                try:
                    for r in sessions.list_registered(force=True):
                        if str(r.get("pid")) == str(pid):
                            text, _ = sessions.read_log(r.get("id"))
                            lines = text.splitlines()
                            return {"ok": True, "lines": lines[-400:], "cursor": 0,
                                    "live": False,
                                    "path": sessions.log_path(r.get("id"))}
                except Exception:                        # noqa: BLE001
                    pass
                return {"ok": True, "lines": [], "cursor": 0, "live": False,
                        "note": "这是外部发现的旧版注入器 —— 它不写 run/logs/，"
                                "所以没有可读日志。重启该注入器后即可看到日志。"}

            return {"ok": False, "error": "需要 localId / sessionId / pid",
                    "lines": [], "cursor": cursor}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "lines": [], "cursor": cursor}

    def prune_sessions(self):
        try:
            n = sessions.prune()
            return {"ok": True, "removed": n}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def stop_task(self):
        ok, err = RUNNER.stop_task_only()
        return {"ok": ok, "error": err} if not ok else {"ok": True}

    def get_task_status(self):
        return {"ok": True, "task": RUNNER.status()}

    # ── 日志（短任务）──
    def get_logs(self, cursor=0):
        try:
            lines, new_cursor = RUNNER._task_log.since(int(cursor or 0))  # noqa: SLF001
            return {"ok": True, "lines": lines, "cursor": new_cursor}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "lines": [], "cursor": cursor}

    def clear_logs(self):
        cur = RUNNER._task_log.clear()                   # noqa: SLF001
        return {"ok": True, "cursor": cur}

    # ── 应用自己的启动参数 ──
    def get_app_autostart(self, name):
        """
        读该 profile 对应应用**自己**的自启动命令行（含私有启动参数）。

        用途：应用自己启动时带 `--hidden` 这类"后台启动"标志，我们启动时
        没带 → 本该静默到托盘的应用会弹窗。前端拿这个结果提示用户
        「要不要把这个参数填进 appArgs」。

        实现：调 node 侧（那边已有 lib/autostart.js 的 .lnk + 注册表读取），
        不为它再写一套 Python 镜像 —— 那正是本项目反复踩的坑
        （两侧存活判定机制不一致那次）。
        """
        try:
            prof = read_profile(name)
            exe = prof.get("exe")
            if not exe:
                return {"ok": True, "hits": [], "args": []}
            script = (
                "const a=require('./lib/autostart');"
                "const path=require('path');"
                f"const hits=a.findAppAutostart({json.dumps(exe)}, {json.dumps(prof.get('processName') or '')});"
                "const args=[...new Set(hits.flatMap(h=>h.args||[]))];"
                "process.stdout.write(JSON.stringify({hits,args}));"
            )
            r = subprocess.run(
                ["node", "-e", script],
                cwd=str(ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30,
                creationflags=CREATE_NO_WINDOW,
            )
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or "读取失败")[:300], "hits": [], "args": []}
            data = json.loads(r.stdout or "{}")
            return {"ok": True, "hits": data.get("hits", []), "args": data.get("args", [])}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "hits": [], "args": []}

    # ── 自定义 CSS ──
    def get_custom_css(self, name):
        """
        读该 profile 的自定义 CSS 片段。
        约定路径：css/<name>.custom.css（profile 的 cssExtra 可覆盖）。
        """
        try:
            path = self._custom_css_path(name)
            if not path.exists():
                return {"ok": True, "exists": False, "path": str(path), "css": ""}
            return {"ok": True, "exists": True, "path": str(path),
                    "css": path.read_text(encoding="utf-8")}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def save_custom_css(self, name, css):
        """
        写自定义 CSS 片段。写入后注入器会通过热重载自动重新注入，
        不需要重启应用（前提是注入器在运行且监听该文件）。
        """
        try:
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(name)):
                return {"ok": False, "error": "profile 名不合法"}
            path = self._custom_css_path(name)
            CSS_DIR.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(css if css is not None else "")
            return {"ok": True, "path": str(path)}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _custom_css_path(name):
        """解析该 profile 的自定义 CSS 路径（尊重 profile 里的 cssExtra）。"""
        try:
            prof = read_profile(name)
        except Exception:                                # noqa: BLE001
            prof = {}
        extra = prof.get("cssExtra")
        if extra:
            p = Path(extra)
            return p if p.is_absolute() else (PROFILES_DIR / p)
        return CSS_DIR / f"{name}.custom.css"

    # ── 深色模式（Dark Reader）──
    def set_darkreader(self, name, mode, engine=None, brightness=None, contrast=None):
        """
        保存 Dark Reader 配置到 profile，并对**正在运行的**会话立即生效。

        为什么用「对运行中的注入器推一次」而不是重启：
        重启注入器 = 重启目标应用 = 打断用户正在做的事。而深色模式只是样式，
        完全可以对已连接的页面直接生效。走 tools/darkreader.js 那条已实测的通道。
        """
        try:
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(name)):
                return {"ok": False, "error": "profile 名不合法"}

            MODES = ("", "auto", "dark", "light", "off")
            m = (mode or "").strip()
            if m not in MODES:
                return {"ok": False, "error": f"模式不合法：{mode}（可用 auto/dark/light 或留空关闭）"}
            ENGINES = ("dynamicTheme", "staticTheme", "cssFilter", "svgFilter")
            eng = (engine or "dynamicTheme").strip()
            if eng not in ENGINES:
                return {"ok": False, "error": f"引擎不合法：{engine}"}

            # 1) 写 profile（整份读改写，与 save_profile 一致）
            prof = read_profile(name)
            prof["darkreader"] = None if m in ("", "off") else m
            theme = {"engine": eng}
            if brightness is not None:
                theme["brightness"] = int(brightness)
            if contrast is not None:
                theme["contrast"] = int(contrast)
            prof["darkreaderTheme"] = theme
            write_profile(name, prof)

            # 2) 若该 profile 有会话在跑，立即推送
            #    （找不到会话就只保存 —— 下次启动时生效）
            try:
                reg = sessions.list_all()
            except Exception:                            # noqa: BLE001
                reg = []
            live = [r for r in reg
                    if r.get("profile") == name and r.get("alive") and r.get("port")]

            if not live:
                return {"ok": True, "applied": 0,
                        "reason": "该应用当前没有运行中的注入，下次启动时生效。"}

            total = 0
            errors = []
            for r in live:
                port = r.get("port")
                push_mode = m if m else "off"
                okk, err = self._push_darkreader(port, push_mode, eng,
                                                 brightness, contrast)
                if okk:
                    total += okk
                else:
                    errors.append(f"端口 {port}：{err}")

            if total == 0 and errors:
                return {"ok": False, "error": "；".join(errors)}
            res = {"ok": True, "applied": total}
            if errors:
                res["reason"] = "部分会话失败：" + "；".join(errors)
            return res
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _push_darkreader(port, mode, engine, brightness, contrast):
        """
        对某个调试端口执行一次 Dark Reader 注入（不重启任何东西）。
        复用 tools/darkreader.js 里已经实测过的逻辑。
        返回 (注入的页面数, 错误信息)。
        """
        script = ROOT / "tools" / "darkreader.js"
        if not script.exists():
            return 0, f"找不到 {script}"
        # 亮度/对比度只在 enable/auto 时才传，off 传不传无所谓
        args = [str(script), str(port), mode, "--engine", engine]
        if brightness is not None:
            args += ["--brightness", str(brightness)]
        if contrast is not None:
            args += ["--contrast", str(contrast)]
        try:
            r = subprocess.run(
                ["node", *args],
                capture_output=True, text=True, timeout=60,
                encoding="utf-8", errors="replace",
                creationflags=CREATE_NO_WINDOW,
            )
            out = (r.stdout or "") + (r.stderr or "")
            # 从输出里数 "✓" 的个数（每注入一个页面一行）
            n = out.count("✓")
            if r.returncode != 0 and n == 0:
                tail = "\n".join(out.strip().splitlines()[-3:]) or "无输出"
                return 0, tail
            return n, ""
        except subprocess.TimeoutExpired:
            return 0, "注入超时"
        except Exception as e:                           # noqa: BLE001
            return 0, str(e)

    # ── 新建向导辅助 ──
    def list_running(self):
        """
        列出可选的运行中进程（新建向导用）。

        带 TTL 缓存：这个查询要起一个 PowerShell（约 1-2 秒），
        而向导可能被反复打开。缓存 20 秒足够，用户不会察觉。
        """
        now = time.time()
        with _proc_lock:
            if (now - _proc_cache["at"]) < PROCESS_LIST_TTL_SEC and _proc_cache["data"]:
                return {"ok": True, "processes": list(_proc_cache["data"]), "cached": True}
        data = list_running_processes()
        with _proc_lock:
            _proc_cache["at"] = time.time()
            _proc_cache["data"] = data
        return {"ok": True, "processes": data}

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
            return {"ok": True, "exe": str(path)}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def create_profile(self, name, data):
        """向导最后一步：写 profile（与 save_profile 同路径，语义上分开更清楚）。"""
        return self.save_profile(name, data)


# ─────────────────────────── 入口 ───────────────────────────

def run_headless(profiles, isolate=False):
    """
    无窗口模式：拉起指定 profile 的注入器，然后立刻退出。

    这是**自启动**的实现方式。为什么绕一层 Python 而不让 .lnk 直接指向 node.exe：

      · pythonw.exe 是 GUI 子系统程序，没有控制台。它用 CREATE_NO_WINDOW
        启动 node.exe，就不会闪出一个终端窗口。
      · 直接让 .lnk 指向 node.exe 的话，node 是控制台程序，会留下一个
        常驻的黑色终端窗口。

    注入器是 detached 启动的，所以本进程退出后它继续运行，
    并且会把自己登记到 run/sessions/，之后打开 UI 就能看到并管理它。
    """
    ok_all = True
    for name in profiles:
        name = name.strip()
        if not name:
            continue
        try:
            # detached=True 是关键：本进程马上就要退出，若把子进程的 stdout
            # 接到管道上，读端一关，注入器下次写日志就会 EPIPE 崩溃。
            res = RUNNER.launch_injector(name, isolate=isolate, detached=True)
        except Exception as e:                           # noqa: BLE001
            print(f"[ui] 启动 {name} 失败：{e}", file=sys.stderr)
            ok_all = False
            continue
        if res.get("ok"):
            print(f"[ui] 已启动 {name} 的注入（pid {res.get('pid')}，后台运行）。")
        else:
            print(f"[ui] 启动 {name} 失败：{res.get('error')}", file=sys.stderr)
            ok_all = False

    # 给注入器一点时间完成登记，这样紧接着打开 UI 就能看到它
    time.sleep(1.5)
    return 0 if ok_all else 1


def parse_ui_args(argv):
    """极简参数解析。UI 只有几个开关，不需要 argparse。"""
    o = {"headless": False, "start": [], "isolate": False, "help": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            o["help"] = True
        elif a == "--headless":
            o["headless"] = True
        elif a == "--isolate":
            o["isolate"] = True
        elif a == "--start":
            i += 1
            if i < len(argv):
                o["start"].extend(x for x in argv[i].split(",") if x.strip())
        elif a.startswith("--start="):
            o["start"].extend(x for x in a.split("=", 1)[1].split(",") if x.strip())
        i += 1
    return o


def ui_usage():
    print(
        "no-glass-ele 管理界面\n"
        "\n"
        "  python app.py                          打开图形界面\n"
        "  python app.py --headless --start <name>[,<name>...]\n"
        "                                         无窗口拉起注入器后退出（自启动用）\n"
        "  python app.py --headless --start <name> --isolate\n"
        "                                         隔离实例启动\n"
        "\n"
        "配合 pythonw.exe 使用可完全无窗口：\n"
        "  pythonw app.py --headless --start todo-list\n"
        "\n"
        "自启动项由 `node gen.js autostart on <name>` 创建，不需要手写这一串。\n"
    )


def main():
    opts = parse_ui_args(sys.argv[1:])
    if opts["help"]:
        ui_usage()
        return 0

    if not GEN_JS.exists():
        print(f"找不到 gen.js：{GEN_JS}", file=sys.stderr)
        return 1

    # 无窗口模式：拉起注入器就走
    if opts["headless"]:
        if not opts["start"]:
            print("[ui] --headless 需要配合 --start <name>", file=sys.stderr)
            return 2
        return run_headless(opts["start"], isolate=opts["isolate"])

    if not WEB_DIR.exists():
        print(f"找不到前端目录：{WEB_DIR}", file=sys.stderr)
        return 1

    httpd, port = start_static_server()
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"[ui] no-glass-ele 管理界面：{url}")
    print(f"[ui] 项目根目录：{ROOT}")

    # 预热外部注入器发现：让后台线程先跑一次，
    # 这样用户第一次打开会话列表时缓存已有数据，不必等进程表查询。
    try:
        sessions.warm_up()
    except Exception:                                    # noqa: BLE001
        pass

    api = Api()
    webview.create_window(
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
