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
RUN_DIR = ROOT / "run"
AUTOSTART_LOG_DIR = RUN_DIR / "logs" / "autostart"
AUTOSTART_LOG = AUTOSTART_LOG_DIR / "autostart.log"
AUTOSTART_LAST = RUN_DIR / "autostart-last.json"
SETTINGS_FILE = ROOT / "local" / "autostart.json"

# 中转器快捷方式的文件名。必须与 lib/autostart.js 的 relayLnkPath() 一致 ——
# 两边指向同一个文件，改一处就要改另一处。
RELAY_LNK_NAME = "no-glass · autostart.lnk"

# 与 lib/settings.js 的 DEFAULTS 必须一致 —— 两边读写同一份文件。
# 改字段时两处都要改。
AUTOSTART_DEFAULTS = {
    "initialDelayMs": 8000,
    "delayMs": 6000,
    "neverPromptDelete": False,
    "neverWarnStartup": False,
    "pythonw": None,
}

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
# 单独一把锁用来**串行化计算**：保证同一时刻只有一个人在跑 node。
# 与 _overview_lock 分开是为了让「读缓存」与「让缓存失效」永远不必等 4 秒的计算。
_overview_compute_lock = threading.Lock()
_overview_cache = {"at": 0.0, "data": None}

# ── 「应用自己的自启动项」缓存 ──
#
# 每次查询要起 node + PowerShell，实测单次约 1.6 秒。而前端每次切换 profile
# 都会查一次 —— 快速切换 10 次就是 16 秒。应用自己的自启动项是低频变化的
# （用户装/卸应用才变），所以缓存 30 秒。
APP_AUTOSTART_TTL_SEC = 30.0
_app_autostart_cache = {}          # name -> { at, data }
_app_autostart_all_cache = {"at": 0.0, "data": None}   # 批量版（全部 profile）

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

        # 同一个 profile 只允许一个注入会话。
        #
        # 为什么不按 isolate 分种类放行：隔离是**启动方式**（本次启动用独立
        # 数据目录），不是"多开一个实例"。允许两个会带来一堆歧义 ——
        # 标签页多一个、停止按钮该停哪个、日志归属谁；而且很多应用有单实例锁
        # 根本开不起来。想换启动方式就先停掉现有的。
        if not detached:
            with self._lock:
                for sid, s in self._sessions.items():
                    if s.get("profile") != profile_name:
                        continue
                    if not (s.get("proc") and s["proc"].poll() is None):
                        continue
                    return {"ok": False,
                            "error": f"{profile_name} 已经在运行中（会话 {sid}）。"
                                     f"想换启动方式（例如改用隔离数据）请先停止它。"}
        else:
            # 无窗口模式也要防重复：查注册表 + 进程表
            try:
                for r in sessions.list_all():
                    if r.get("profile") == profile_name and r.get("alive"):
                        return {"ok": False,
                                "error": f"{profile_name} 已经在运行中"
                                         f"（pid {r.get('pid')}）。"}
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
                "isolate": bool(isolate),
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


def check_port_conflicts(name, data):
    """
    校验端口的唯一性与合法性，返回问题列表（空 = 没问题）。

    规则必须与 `gen.js doctor` 的那套**完全一致**（见 gen.js 的
    "端口冲突" 与 "端口落在自身保留段里" 两段）—— 否则会出现
    "界面让保存、doctor 报错" 这种自相矛盾。改这里记得同步改那边。

    为什么要在保存时拦：CDP 端口是"带参数启动"时才用的，两个 profile
    撞端口不会当场报错，而是等到启动时才发现（端口被先起的那个占着）。
    等到那时用户已经忘了自己填过什么，所以在这里就拒绝并说明与谁冲突。
    这是**面向用户的保存入口**的校验，write_profile 本身不加判断 ——
    set_darkreader 这类内部改写不该被它拦住。
    """
    issues = []
    port = data.get("defaultPort")
    if port is None:
        return issues                     # 未填端口由 doctor 报"未设置 defaultPort"

    # 与其他 profile 的 defaultPort 冲突
    for other in list_profiles_on_disk():
        if other == name:
            continue
        try:
            op = read_profile(other).get("defaultPort")
        except Exception:                                # noqa: BLE001
            continue
        if op is not None and op == port:
            issues.append(f"defaultPort {port} 与 profile 「{other}」冲突（它也是 {op}）")

    # 落在自己的保留端口范围内
    reserved = data.get("reservedPorts")
    if isinstance(reserved, list) and reserved:
        lo, hi = min(reserved), max(reserved)
        if lo <= port <= hi:
            issues.append(f"defaultPort {port} 落在自身 reservedPorts 范围 {lo}-{hi} 内")

    return issues


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
        （实测合计约 4 秒，doctor 内部还要起 3 个 PowerShell 读自启动项）。
        所以结果带 TTL 缓存 —— 前端高频刷新时读缓存，只有缓存过期才真的跑 node。
        会话列表另走 sessions 模块（它自带缓存）。

        force=True 用于「用户点了刷新」这类明确要求最新数据的场景。

        ⚠️ 昂贵计算必须**在锁内**（这里踩过一个真坑）：
        早期版本只在判断/写缓存时加锁，跑 node 的那 4 秒在锁外 —— 于是并发的
        N 个调用者**各跑一份**。实测 8 个并发 → 同时存在 9 个 PowerShell
        （每个 doctor 起 3 个）。启动 UI 时 init/向导/刷新按钮/updateTaskUI
        本来就容易叠在一起，开机后 PowerShell 冷启动又特别慢，窗口一拉长就
        叠出几十个进程 —— 用户实测见到 70+。

        现在整段计算在锁内，后到的调用者会等第一个算完；
        它们醒来时看到的是**比自己进入函数还新的**缓存，直接复用，不再各跑一份。
        """
        global _overview_cache
        entered = time.time()

        # 用独立的锁**串行化计算**，而不是让所有调用者去抢缓存锁。
        #
        # 为什么分开两把锁：计算要跑 4 秒。若把计算放在 _overview_lock 里，
        # save_profile 的「让缓存失效」也得排队等这 4 秒 —— 用户会觉得保存卡住。
        # 分开之后：_overview_lock 只保护字典读写（微秒级），
        # _compute_lock 只保证「同一时刻只有一个人在跑 node」。
        with _overview_compute_lock:
            # 拿到计算权后重新看缓存：可能刚才那个计算者已经算好了。
            # 判据是「缓存比我还新」—— 我进函数时它还没有，说明是别人替我算的。
            with _overview_lock:
                cached = _overview_cache["data"]
                cache_at = _overview_cache["at"]
                now = time.time()
                reuse = bool(cached) and (
                    cache_at >= entered                      # 别人在我等待期间算好了
                    or ((now - cache_at) < OVERVIEW_TTL_SEC and not force)
                )
            if reuse:
                # 会话列表是实时的（读磁盘注册表，廉价），单独刷新
                out = dict(cached)
                try:
                    out["sessions"] = self.list_sessions().get("sessions", [])
                except Exception:                        # noqa: BLE001
                    out["sessions"] = []
                try:
                    out["task"] = RUNNER.status()
                except Exception:                        # noqa: BLE001
                    pass
                return out

            # 真的需要算 —— 此刻只有我一个人在算
            try:
                listing = run_node_json(["list", "--json"], timeout=60)
            except Exception as e:                       # noqa: BLE001
                return {"ok": False, "error": str(e)}
            try:
                doctor = run_node_json(["doctor", "--json"], timeout=60)
            except Exception as e:                       # noqa: BLE001
                doctor = {"ok": False, "profiles": [], "problemCount": 0, "error": str(e)}

            issues = {p["name"]: p.get("issues", []) for p in doctor.get("profiles", [])}
            for prof in listing.get("profiles", []):
                prof["issues"] = issues.get(prof["name"], [])

            try:
                sess = self.list_sessions().get("sessions", [])
            except Exception:                            # noqa: BLE001
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
            conflicts = check_port_conflicts(name, data)
            if conflicts:
                return {"ok": False, "error": "；".join(conflicts) + "。请换一个端口。"}
            path = write_profile(name, data)
            # 让 get_overview 的 TTL 缓存立即失效 —— 否则刚保存的 profile
            # 在缓存过期（最多 5 秒）前不在 STATE.profiles 里，向导据此算的
            # "下一个可用端口"就会重复（这是「连续新建撞端口」的直接成因）。
            global _overview_cache
            with _overview_lock:
                _overview_cache["at"] = 0.0
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
                # isolate 以**注册表**为准（它是注入器自己写的实际值）；
                # 本地字典里的那份只是启动时的请求，注入器可能因端口被占
                # 而改用别的端口 —— 但 isolate 本身不会变，两者一致。
                "isolate": bool((meta or {}).get("isolate", s.get("isolate"))),
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
                "isolate": bool(r.get("isolate")),
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
        · 外部会话（有登记项）读磁盘日志文件 —— 也是**增量**的（见下）
        · 外部发现的旧版注入器没有日志文件，返回明确提示而不是空白

        为什么文件型会话也要增量：原先每次都整段返回最后 400 行，前端只能
        整体重写日志区 —— 重写会销毁所有 DOM 节点，用户刚选中的文字每 300ms
        被清空一次（实测反馈："选择内容每隔几秒就重新从头开始"）。
        现在按字节游标读新增部分，返回 reset 标记让前端知道何时必须整段重画。
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
                text, new_off, reset = sessions.read_log_since(session_id, int(cursor or 0))
                lines = text.splitlines()
                if reset and not lines:
                    return {"ok": True, "lines": [], "cursor": new_off, "live": False,
                            "reset": True, "path": sessions.log_path(session_id),
                            "note": "该会话暂无日志文件内容。"}
                return {"ok": True, "lines": lines, "cursor": new_off,
                        "live": False, "reset": reset,
                        "path": sessions.log_path(session_id)}

            if pid:
                # 外部发现的旧版注入器：查它有没有登记项
                try:
                    for r in sessions.list_registered(force=True):
                        if str(r.get("pid")) == str(pid):
                            text, new_off, reset = sessions.read_log_since(
                                r.get("id"), int(cursor or 0))
                            return {"ok": True, "lines": text.splitlines(),
                                    "cursor": new_off, "live": False, "reset": reset,
                                    "path": sessions.log_path(r.get("id"))}
                except Exception:                        # noqa: BLE001
                    pass
                return {"ok": True, "lines": [], "cursor": 0, "live": False,
                        "reset": False,
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
    def get_app_autostart_all(self):
        """
        一次查出**全部** profile 对应的"应用自己的自启动项"。

        为什么要有批量版（踩过）：单次查询要起 node + PowerShell，约 1.5 秒。
        前端每切换一次 profile 就查一次，首次浏览 7 个应用要 10 秒 ——
        用户表现为"快速切换列表卡顿、派生很多 PowerShell"。

        批量版在**一个 node 进程**里查完全部：PowerShell 只起一次，
        总耗时约等于单次（实测 7 个 1.4 秒）。

        结果缓存 30 秒（应用自己的自启动项是低频变化的）。
        """
        global _app_autostart_all_cache
        now = time.time()
        if _app_autostart_all_cache["data"] is not None \
                and (now - _app_autostart_all_cache["at"]) < APP_AUTOSTART_TTL_SEC:
            return {"ok": True, "items": _app_autostart_all_cache["data"], "cached": True}

        items = []
        try:
            for n in list_profiles_on_disk():
                try:
                    prof = read_profile(n)
                except Exception:                        # noqa: BLE001
                    continue
                if not prof.get("exe"):
                    continue
                items.append({
                    "name": n,
                    "exe": prof.get("exe"),
                    "processName": prof.get("processName") or "",
                })
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "items": {}}

        if not items:
            return {"ok": True, "items": {}}

        script = (
            "const a=require('./lib/autostart');"
            f"const items={json.dumps(items, ensure_ascii=False)};"
            "process.stdout.write(JSON.stringify(a.findAppAutostartBatch(items)));"
        )
        try:
            r = subprocess.run(
                ["node", "-e", script],
                cwd=str(ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=60,
                creationflags=CREATE_NO_WINDOW,
            )
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or "读取失败")[:300], "items": {}}
            data = json.loads(r.stdout or "{}")
            _app_autostart_all_cache = {"at": now, "data": data}
            return {"ok": True, "items": data}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "items": {}}

    def get_app_autostart(self, name):
        """
        读该 profile 对应应用**自己**的自启动命令行（含私有启动参数）。

        用途：应用自己启动时带 `--hidden` 这类"后台启动"标志，我们启动时
        没带 → 本该静默到托盘的应用会弹窗。前端拿这个结果提示用户
        「要不要把这个参数填进 appArgs」。

        实现：调 node 侧（那边已有 lib/autostart.js 的 .lnk + 注册表读取），
        不为它再写一套 Python 镜像 —— 那正是本项目反复踩的坑
        （两侧存活判定机制不一致那次）。

        ⚠️ **必须缓存**（踩过）：
        每次调用要起一个 node，node 里还要起一个 PowerShell 读三处自启动项，
        实测**单次约 1.6 秒**。而前端每次切换 profile 都会调它 ——
        快速点 10 下就是 16 秒的串行开销 + 10 个 PowerShell 进程，
        用户表现为"切换列表卡顿"。
        应用自己的自启动项是**低频变化**的（用户装/卸应用才变），
        所以缓存 30 秒完全安全。前端也有一层缓存，这里是权威兜底。
        """
        global _app_autostart_cache
        now = time.time()
        hit = _app_autostart_cache.get(name)
        if hit and (now - hit["at"]) < APP_AUTOSTART_TTL_SEC:
            return hit["data"]

        try:
            prof = read_profile(name)
            exe = prof.get("exe")
            if not exe:
                data = {"ok": True, "hits": [], "args": []}
                _app_autostart_cache[name] = {"at": now, "data": data}
                return data
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
            out = {"ok": True, "hits": data.get("hits", []), "args": data.get("args", [])}
            _app_autostart_cache[name] = {"at": now, "data": out}
            return out
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e), "hits": [], "args": []}

    # ── 开机自启动（中转器）──
    #
    # 这些都调 node 侧（lib/autostart.js），不在 Python 里重写判断逻辑 ——
    # 两侧各写一套是本项目反复踩的坑（见 get_app_autostart 的注释）。
    # 例外：run_autostart_all 必须在 Python 里（它是中转器本体，由 .lnk 直接拉起）。

    @staticmethod
    def _node_json(script, timeout=60):
        """跑一段 node -e 并解析 JSON。失败返回 None（调用方给默认值）。"""
        try:
            r = subprocess.run(
                ["node", "-e", script],
                cwd=str(ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout,
                creationflags=CREATE_NO_WINDOW,
            )
            if r.returncode != 0:
                return None, (r.stderr or "node 执行失败")[:400]
            return json.loads(r.stdout or "null"), None
        except Exception as e:                           # noqa: BLE001
            return None, str(e)

    def get_autostart_state(self):
        """
        自启动的完整状态，供 UI 弹窗渲染。

        返回：
          relay    — 中转器 .lnk 是否存在（target/args 恒为 null，见下）
          enabled  — 启用了自启动的 profile 列表
          legacy   — 旧式 per-profile .lnk（待清理）
          settings — local/autostart.json 的内容（含默认值）
          profiles — 全部 profile 名（弹窗要列出来，包括未启用的）

        ⚠️ **纯 Python 实现，不起 node 进程**（踩过）：
        原先这里调 `listManaged({withRelayDetail:true})` —— 为了拿中转器的
        target/args 去读启动文件夹里**全部** .lnk 的属性，实测 1533-1615 ms。
        而前端只用 `relay.exists`（判断"中转器在不在"），target/args 一个都没读。
        用户表现为"刚打开设置，复选框那块要等好几秒才出来"。

        现在：relay 只做一次 existsSync（微秒级）；enabled/legacy 直接读
        profiles/*.json 与启动文件夹的文件名。全加起来毫秒级。

        target/args 恒为 null —— 需要真实内容时用 `gen.js autostart list`
        （CLI 场景，一次性，慢一点无所谓）。
        """
        # 中转器是否存在 —— 与 lib/autostart.js 的 relayLnkPath() 同一个路径
        relay = {"exists": False, "lnk": None, "target": None, "args": None}
        startup = None
        try:
            startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" \
                / "Start Menu" / "Programs" / "Startup"
            rl = startup / RELAY_LNK_NAME
            relay = {"exists": rl.exists(), "lnk": str(rl), "target": None, "args": None}
        except Exception:                                # noqa: BLE001
            pass

        # 启用了自启动的 profile（纯读 JSON）
        enabled = []
        for name, prof in scan_enabled_profiles():
            au = prof.get("autostart") or {}
            raw = au.get("appArgs", None)
            enabled.append({
                "name": name,
                "displayName": prof.get("displayName") or name,
                # 实际生效的参数（已折算 null → 顶层 appArgs）
                "appArgs": effective_app_args(prof),
                # 原始配置：null = 继承顶层；[] = 明确无参数；[...] = 用它。
                # 前端要靠这个区分「继承」和「显式空」，否则编辑框没法回显。
                "appArgsRaw": list(raw) if isinstance(raw, list) else None,
                # 顶层 appArgs，供前端显示「继承的是什么」
                "topAppArgs": list(prof.get("appArgs") or []),
            })

        # 旧式 per-profile 项（只列文件名，不解析内容）
        legacy = []
        try:
            if startup is not None and startup.exists():
                for f in startup.iterdir():
                    if not f.name.startswith("no-glass · ") \
                            or f.suffix.lower() != ".lnk":
                        continue
                    if f.name == RELAY_LNK_NAME:         # 中转器不算旧式
                        continue
                    legacy.append({
                        "profile": f.name[len("no-glass · "):-len(".lnk")],
                        "lnk": str(f),
                        "file": f.name,
                    })
        except Exception:                                # noqa: BLE001
            pass

        names = []
        try:
            names = [p.stem for p in sorted(PROFILES_DIR.glob("*.json"))
                     if not p.name.startswith("_")]
        except Exception:                                # noqa: BLE001
            pass

        return {
            "ok": True,
            "relay": relay,
            "enabled": enabled,
            "legacy": legacy,
            "settings": read_autostart_settings(),
            "profiles": names,
        }

    def set_autostart(self, name, enabled):
        """开关一个 profile 的开机自启动。"""
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(name or "")):
            return {"ok": False, "error": "profile 名不合法"}
        try:
            prof = read_profile(name)
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

        fn = "enable" if enabled else "disable"
        # 注意最后一段是普通字符串、不是 f-string：那里的 } 不会被转义，
        # 写成 }} 会拼出两个右花括号，node -e 直接报语法错误
        # （表现为设置面板里显示一串 "Expected"）。
        script = (
            "const a=require('./lib/autostart');"
            f"const r=a.{fn}({json.dumps(name)},"
            f"{{exe:{json.dumps(prof.get('exe') or '')},"
            f"processName:{json.dumps(prof.get('processName') or '')},"
            "ignoreConflicts:true});"
            "process.stdout.write(JSON.stringify(r));"
        )
        data, err = self._node_json(script)
        if data is None:
            return {"ok": False, "error": err or "操作失败"}
        return data

    def detect_pythonw(self):
        """检测所有候选 pythonw（UI 的「检测」按钮）。真跑一次才算数。"""
        script = (
            "const a=require('./lib/autostart');"
            "process.stdout.write(JSON.stringify(a.detectPythonw()));"
        )
        data, err = self._node_json(script, timeout=120)
        if data is None:
            return {"ok": False, "error": err or "检测失败", "items": [], "selected": None}
        return {"ok": True, **data}

    def remove_relay_lnk(self):
        """删除中转器快捷方式（用户在「关闭最后一项」时选择删除）。"""
        script = (
            "const a=require('./lib/autostart');"
            "process.stdout.write(JSON.stringify(a.removeRelayLnk()));"
        )
        data, err = self._node_json(script)
        if data is None:
            return {"ok": False, "error": err or "删除失败"}
        return data

    def set_autostart_app_args(self, name, args):
        """
        设置某个 profile 的「开机启动专用参数」（autostart.appArgs）。

        三态，与 lib/autostart.js 的 effectiveAppArgs 保持一致：
          None  → 继承顶层 appArgs（删除这个键的效果）
          []    → 明确无参数（覆盖顶层的）
          [...] → 用这组

        为什么单独一个 API 而不是走 save_profile：整份 profile 保存时，
        前端表单不包含这个字段（它只存在于 autostart 弹窗里），
        走 save_profile 有把它冲掉的风险。这里只改一个键。
        """
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(name or "")):
            return {"ok": False, "error": "profile 名不合法"}
        if args is not None:
            if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
                return {"ok": False, "error": "参数必须是字符串数组或 null"}
            args = [a for a in args if a.strip()]
        try:
            prof = read_profile(name)
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

        au = prof.get("autostart")
        if not isinstance(au, dict):
            au = {}
        if args is None:
            au.pop("appArgs", None)
        else:
            au["appArgs"] = args
        prof["autostart"] = au
        try:
            write_profile(name, prof)
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}
        return {"ok": True, "appArgs": args,
                "effective": effective_app_args(prof)}

    def set_autostart_settings(self, patch):
        """写 local/autostart.json（合并式）。"""
        if not isinstance(patch, dict):
            return {"ok": False, "error": "参数必须是对象"}
        r = write_autostart_settings(patch)
        if r.get("ok"):
            # 中转器 .lnk 里存的是 pythonw 的绝对路径 —— 改了运行器就得重建，
            # 否则下次开机还是用旧路径。
            if "pythonw" in patch:
                script = (
                    "const a=require('./lib/autostart');"
                    "const r=a.ensureRelayLnk();"
                    "process.stdout.write(JSON.stringify(r));"
                )
                data, err = self._node_json(script)
                if data is not None and not data.get("ok"):
                    r["relayWarning"] = data.get("error") or err
        return r

    def get_autostart_last(self):
        """读上次开机自启的失败摘要（run/autostart-last.json）。"""
        try:
            data = json.loads(AUTOSTART_LAST.read_text(encoding="utf-8"))
            return {"ok": True, "last": data}
        except Exception:                                # noqa: BLE001
            return {"ok": True, "last": None}

    def open_startup_folder(self, which="user"):
        """
        用文件管理器打开启动文件夹（只读浏览，不列内容）。

        为什么不在 UI 里列启动项：每次打开都读一遍启动文件夹 + 解析 .lnk
        是真实开销（用户抱怨过 CPU）。给个按钮让用户自己看，零成本。
        """
        try:
            script = (
                "const a=require('./lib/autostart');"
                f"process.stdout.write(JSON.stringify({{p:{json.dumps('system' if which == 'system' else 'user')}"
                "==='system'?a.systemStartupDir():a.startupDir()}));"
            )
            data, err = self._node_json(script)
            if data is None or not data.get("p"):
                return {"ok": False, "error": err or "取不到启动文件夹路径"}
            p = data["p"]
            subprocess.Popen(["explorer.exe", p], creationflags=CREATE_NO_WINDOW)
            return {"ok": True, "path": p}
        except Exception as e:                           # noqa: BLE001
            return {"ok": False, "error": str(e)}

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

# ─────────────────────────── 开机自启动（中转器）───────────────────────────
#
# 设计要点（与 lib/settings.js、lib/autostart.js 保持同一套契约）：
#
#   · **一个**中转器快捷方式（`no-glass · autostart.lnk`）→
#     `pythonw ui/app.py --autostart-all`
#   · 中转器扫描 profiles/*.json 里 autostart.enabled 为真的那些，逐条启动、带延迟
#   · 每个应用照常走自己的 session（登记到 run/sessions/，ps 能看到、能单独停）
#
# 为什么不在快捷方式里写参数：参数一旦进了 .lnk 就有转义问题（cmd/PowerShell
# 对引号的消耗方式不同），而且它是"隐藏状态"（不在任何日常会打开的文件里）。
# 记在 profile 里则天然可读、可 diff、可注释。


def read_autostart_settings():
    """
    读 local/autostart.json。文件不存在/损坏时返回默认值（不抛错）。

    与 lib/settings.js 的 read() 规则一致：只取认识的字段、校验类型。
    """
    out = dict(AUTOSTART_DEFAULTS)
    try:
        raw = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:                                    # noqa: BLE001
        return out
    if not isinstance(raw, dict):
        return out
    v = raw.get("initialDelayMs")
    if isinstance(v, (int, float)) and v >= 0:
        out["initialDelayMs"] = min(int(v), 120000)
    v = raw.get("delayMs")
    if isinstance(v, (int, float)) and v >= 0:
        out["delayMs"] = min(int(v), 120000)
    if isinstance(raw.get("neverPromptDelete"), bool):
        out["neverPromptDelete"] = raw["neverPromptDelete"]
    if isinstance(raw.get("neverWarnStartup"), bool):
        out["neverWarnStartup"] = raw["neverWarnStartup"]
    if raw.get("pythonw") is None or isinstance(raw.get("pythonw"), str):
        out["pythonw"] = raw.get("pythonw")
    return out


def write_autostart_settings(patch):
    """合并式写设置（原子写：先写临时文件再改名）。"""
    cur = read_autostart_settings()
    if isinstance(patch, dict):
        for k in ("initialDelayMs", "delayMs"):
            if isinstance(patch.get(k), (int, float)):
                cur[k] = int(patch[k])
        for k in ("neverPromptDelete", "neverWarnStartup"):
            if isinstance(patch.get(k), bool):
                cur[k] = patch[k]
        # pythonw 必须用 `in patch` 判断，不能只看值。
        #
        # 踩过的坑：原先是 `patch.get("pythonw") is None or isinstance(...)`。
        # patch 里没有这个键时 `.get()` 也返回 None，条件成立 —— 于是**任何一次
        # 保存设置都会把手选的运行器重置成"自动检测"**。而 set_autostart_settings
        # 只在 `"pythonw" in patch` 时才重建中转器 .lnk，结果 UI 显示"自动"、
        # .lnk 仍指向旧路径，界面与实际不一致且用户无从察觉。
        #
        # None 是合法值（= 自动检测），所以不能靠真假区分，只能靠键是否存在。
        if "pythonw" in patch and (patch["pythonw"] is None or isinstance(patch["pythonw"], str)):
            cur["pythonw"] = patch["pythonw"]
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8", newline="\n")
        tmp.replace(SETTINGS_FILE)
        return {"ok": True, "path": str(SETTINGS_FILE), "settings": cur}
    except Exception as e:                               # noqa: BLE001
        return {"ok": False, "error": str(e)}


def scan_enabled_profiles():
    """
    扫描启用了自启动的 profile，按名字母序返回 [(name, profile_dict)]。

    ⚠️ **直接读 profiles/*.json，绝不调 get_overview** ——
    那个函数内部会跑 `gen.js list` + `gen.js doctor`（约 4 秒 + 多个 PowerShell），
    正是开机时最不该有的负载。读几个小 JSON 是毫秒级。
    """
    out = []
    if not PROFILES_DIR.exists():
        return out
    for f in sorted(PROFILES_DIR.glob("*.json")):
        if f.name.startswith("_"):
            continue
        try:
            prof = json.loads(f.read_text(encoding="utf-8"))
        except Exception:                                # noqa: BLE001
            continue                                     # 单个坏了跳过（由调用方记日志）
        au = prof.get("autostart") or {}
        if au.get("enabled") is True:
            out.append((f.stem, prof))
    out.sort(key=lambda x: x[0])
    return out


def effective_app_args(prof):
    """
    自启动时实际用的 app 参数（与 lib/autostart.js 的 effectiveAppArgs 一致）：
      · autostart.appArgs 缺失/null → 回落到顶层 appArgs
      · []                          → 明确无参数（覆盖顶层）
      · 非空数组                     → 用它
    """
    au = (prof.get("autostart") or {})
    a = au.get("appArgs", None)
    if a is None:
        top = prof.get("appArgs")
        return list(top) if isinstance(top, list) else []
    return list(a) if isinstance(a, list) else []


class AutostartLog:
    """中转器的日志。写 run/logs/autostart/autostart.log。"""

    def __init__(self):
        self.path = AUTOSTART_LOG
        self._fh = None
        try:
            AUTOSTART_LOG_DIR.mkdir(parents=True, exist_ok=True)
            self._fh = open(self.path, "a", encoding="utf-8", newline="\n")
        except Exception:                                # noqa: BLE001
            self._fh = None

    def _line(self, level, msg):
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] [{level}] {msg}"
        # 统一走 stdout：混用 stderr 会让输出顺序错乱（管道里两个流分别缓冲）。
        # 级别已经在行内标出来了，不需要靠流来区分。
        print(line, file=sys.stdout)
        if self._fh:
            try:
                self._fh.write(line + "\n")
                self._fh.flush()
            except Exception:                            # noqa: BLE001
                pass

    def info(self, msg):
        self._line("INFO", msg)

    def warn(self, msg):
        self._line("WARN", msg)

    def error(self, msg):
        self._line("ERROR", msg)

    def close(self):
        if self._fh:
            try:
                self._fh.close()
            except Exception:                            # noqa: BLE001
                pass


def write_autostart_summary(ok_count, fail_count, failures):
    """写 run/autostart-last.json —— UI 启动时读一次，用来提示上次失败。"""
    try:
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        data = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ok": ok_count,
            "failed": fail_count,
            "failures": failures[:20],
            "log": str(AUTOSTART_LOG),
        }
        AUTOSTART_LAST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8", newline="\n")
    except Exception:                                    # noqa: BLE001
        pass


def run_autostart_all(dry_run=False):
    """
    中转器：扫描已启用的 profile，逐条带延迟拉起注入器，然后退出。

    关键约束（都是踩过的坑，别改）：

    1. **逐条 spawn 后立刻返回，不等端口就绪。**
       注入器等调试端口最长 45 秒；若串行等待，N 个应用会变成几分钟。
       `launch_injector(detached=True)` 是 Popen 后立即返回，符合要求。

    2. **失败隔离。** 某个 profile 的 exe 不存在 / JSON 坏了 / 注入器秒退 →
       记日志、继续下一条，绝不中断整个流程。

    3. **除日志外不做任何写操作。** 不改 profile、不删残留、不重建 .lnk。
       这是"开机自启"不是"维护"，写操作留给人主动触发。

    4. **没有启用项时**：写日志；若未设 neverWarnStartup 则拉起 UI 提示。
       此时**不等待延迟**（没东西要启动，没必要空等）。

    5. **直接读 profiles/*.json**，不调 get_overview（见 scan_enabled_profiles）。
    """
    cfg = read_autostart_settings()
    log = AutostartLog()
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    log.info(f"=== 开机自启动开始（{started}）===")

    entries = scan_enabled_profiles()
    if not entries:
        log.warn("没有应用启用自启动（所有 profile 的 autostart.enabled 都是 false）")
        if not dry_run and not cfg["neverWarnStartup"]:
            log.info("按设置拉起 UI 提示用户（neverWarnStartup=false）")
            try:
                # 无参数 = 打开图形界面（见 main()）
                subprocess.Popen(
                    [sys.executable, str(UI_DIR / "app.py")],
                    cwd=str(ROOT),
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=CREATE_NO_WINDOW,
                )
            except Exception as e:                       # noqa: BLE001
                log.error(f"拉起 UI 失败：{e}")
        log.info("=== 结束（没有需要启动的应用）===")
        log.close()
        if not dry_run:
            write_autostart_summary(0, 0, [])
        return 0

    log.info(f"共 {len(entries)} 个应用：{', '.join(n for n, _ in entries)}")
    if dry_run:
        for name, prof in entries:
            args = effective_app_args(prof)
            log.info(f"  [dry-run] 将启动 {name}（appArgs={args}）")
        log.info("=== dry-run 结束（未实际启动）===")
        log.close()
        return 0

    delay = cfg["delayMs"] / 1000.0
    initial = cfg["initialDelayMs"] / 1000.0
    log.info(f"初始延迟 {initial:.1f}s，逐条间隔 {delay:.1f}s")
    if initial > 0:
        time.sleep(initial)

    ok_count = 0
    failures = []
    for idx, (name, prof) in enumerate(entries):
        exe = prof.get("exe")
        if exe and not Path(exe).exists():
            msg = f"exe 不存在，跳过：{exe}"
            log.error(f"{name}: {msg}")
            failures.append({"name": name, "error": msg})
            continue
        args = effective_app_args(prof)
        try:
            res = RUNNER.launch_injector(name, app_args=args, detached=True)
        except Exception as e:                           # noqa: BLE001
            log.error(f"{name}: 启动异常：{e}")
            failures.append({"name": name, "error": str(e)})
            continue
        if res.get("ok"):
            log.info(f"{name}: 已启动（pid {res.get('pid')}，appArgs={args}）")
            ok_count += 1
        else:
            log.error(f"{name}: 启动失败：{res.get('error')}")
            failures.append({"name": name, "error": str(res.get("error"))})

        # 最后一条也睡：简单，且不影响结果（进程已 detached）
        if idx < len(entries) - 1 and delay > 0:
            time.sleep(delay)

    log.info(f"=== 结束：成功 {ok_count}，失败 {len(failures)} ===")
    log.close()
    write_autostart_summary(ok_count, len(failures), failures)
    return 0 if not failures else 1


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
    o = {"headless": False, "start": [], "isolate": False, "help": False,
         "autostart_all": False, "dry_run": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            o["help"] = True
        elif a == "--headless":
            o["headless"] = True
        elif a == "--isolate":
            o["isolate"] = True
        elif a == "--autostart-all":
            o["autostart_all"] = True
        elif a == "--dry-run":
            o["dry_run"] = True
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
        "  python app.py --autostart-all          开机自启动中转器（扫描已启用的 profile，逐条拉起）\n"
        "  python app.py --autostart-all --dry-run\n"
        "                                         只打印会启动哪些，不实际启动\n"
        "  python app.py --headless --start <name>[,<name>...]\n"
        "                                         无窗口拉起指定 profile 的注入器后退出\n"
        "  python app.py --headless --start <name> --isolate\n"
        "                                         隔离实例启动（独立数据目录）\n"
        "\n"
        "配合 pythonw.exe 使用可完全无窗口：\n"
        "  pythonw app.py --autostart-all\n"
        "\n"
        "自启动项由 `node gen.js autostart on <profile>` 创建，不需要手写这一串。\n"
    )


def main():
    opts = parse_ui_args(sys.argv[1:])
    if opts["help"]:
        ui_usage()
        return 0

    # 中转器模式：扫描已启用的 profile，逐条拉起后退出。
    # 放在 headless 之前判断 —— 它不需要 gen.js，也不该被 gen.js 缺失拦住。
    if opts["autostart_all"]:
        return run_autostart_all(dry_run=opts["dry_run"])

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
