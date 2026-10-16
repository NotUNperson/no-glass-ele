#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sessions.py —— 注入会话的读取与停止请求（Python 侧）

这是 `lib/sessions.js` 的 Python 镜像。**两处必须保持契约一致**：

    run/sessions/<id>.json   会话状态（注入器启动时写，退出时删）
    run/sessions/<id>.stop   停止请求（文件存在即请求停止）
    run/logs/<id>.log        该会话日志（注入器追加写）

为什么用文件而不是信号/杀进程：
    注入器启动目标应用时虽然用了 detached，但 Windows 进程表里仍记录父子关系。
    用 taskkill /T 会顺进程树把目标应用一起杀掉 —— 那会关掉用户正在用的窗口。
    文件是协作式的：注入器自己优雅退出，目标应用不受影响。

═══ 性能设计（重要，改之前先读）═══════════════════════════════════════════

这里曾经犯过一个严重的错误：把「进程表查询」放在了 UI 的 300ms 轮询路径上。
每次查询都要启动一个 PowerShell（实测 1-2 秒）和若干 tasklist，
于是调用严重重叠 → 进程雪崩 → 实测 25+ 个 powershell、100% CPU、
内存从 11GB 掉到 583MB。

现在改成：

  1. **读磁盘注册表是廉价的**（几个 JSON 文件），可以随时调用。
  2. **进程表查询是昂贵的**，只在后台线程里按固定间隔（默认 8 秒）做一次，
     结果缓存起来；前台只读缓存。
  3. **存活检查不调 tasklist**。Windows 上用 OpenProcess 系统调用（毫秒级），
     不用起进程。这样每个会话的存活判断是免费的。
  4. **所有昂贵查询都有 TTL 缓存 + 防重入**，绝不会并发跑两个。

结果：UI 常开时不再持续派生进程，CPU 占用可忽略。
"""

import datetime
import json
import os
import threading
import time
from pathlib import Path

UI_DIR = Path(__file__).resolve().parent
ROOT = UI_DIR.parent
RUN_DIR = ROOT / "run"
SESS_DIR = RUN_DIR / "sessions"
LOG_DIR = RUN_DIR / "logs"

# 外部注入器发现（进程表查询）的刷新间隔。慢是有意的：
# 这是兜底机制，用于发现"旧版本启动、没有登记"的注入器，不需要实时。
EXTERNAL_TTL_SEC = 8.0

# 单次进程表查询的超时。查询本身很快，给足余量但不无限等。
PS_TIMEOUT_SEC = 15

# ── 心跳判定的两个阈值（见 _is_zombie）──
#
# 为什么需要宽限期：会话刚启动时 lastTick 还没写过（第一次巡检要等一个
# 周期），此时不能判它是残留。60 秒足够覆盖"启动 → 首次写心跳"的窗口。
ZOMBIE_GRACE_SEC = 60.0

# 心跳过期阈值。注入器的巡检间隔是 20 秒（事件驱动模式下），
# 取 4.5 倍 = 90 秒，容忍偶发的系统卡顿/文件写入延迟。
ZOMBIE_STALE_SEC = 90.0


def _parse_ts(s):
    """解析 ISO 时间戳。失败返回 None（不抛错 —— 字段缺失是常态）。"""
    if not s or not isinstance(s, str):
        return None
    try:
        # 兼容 "2026-10-16T05:16:30.932Z" 与无毫秒的形式
        t = s.replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(t)
    except Exception:                                    # noqa: BLE001
        return None


def _is_zombie(meta, now=None):
    """
    判断一个注册项是否为「僵尸会话」—— 硬关机（或强杀）留下的残留。

    为什么光看 pid 不够：注入器靠 process.on('exit') 与 SIGINT/SIGTERM 清
    注册项，但 Windows 关机**不派发信号**、exit 钩子也不跑，于是注册项留在
    磁盘上。而 pid 存活判断只回答"这个 PID 有没有进程"，不回答"它是不是那个
    注入器"—— 开机后 PID 被复用，残留项就被显示成「运行中」，且点停止没反应
    （停止文件没人消费），prune 也清不掉（它不是 alive=False）。

    判据（三条同时成立）：
      1. pid 存在（否则本来就是 dead，走原有路径）
      2. 启动已超过宽限期（避开启动竞态）
      3. lastTick 缺失或已过期（注入器在写心跳，它没写 = 它不在）

    注意：这只是**显示层**的廉价判断。真正的权威判定在 cleanup_residual()
    —— 那边用 .stop 文件探活，不会误判（见该函数说明）。
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    started = _parse_ts(meta.get("startedAt"))
    if started is None:
        return False          # 连启动时间都没有，不猜
    if (now - started).total_seconds() < ZOMBIE_GRACE_SEC:
        return False          # 还在宽限期内

    tick = _parse_ts(meta.get("lastTick"))
    if tick is None:
        # 从未写过心跳。可能是：watch 模式没开（非 watch 会话不进巡检循环，
        # 压根不写 lastTick）—— 那种情况下不能判它死。
        return False
    return (now - tick).total_seconds() > ZOMBIE_STALE_SEC


def ensure_dirs():
    for d in (SESS_DIR, LOG_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:                                # noqa: BLE001
            pass


# ─────────────────────── 存活检查（不起进程）───────────────────────

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    def _pid_alive(pid):
        """
        用 OpenProcess + GetExitCodeProcess 判断进程是否存活。

        为什么不用 tasklist：那要起一个进程（约 30-50ms + 内存），
        而 UI 每次刷新都要对每个会话判断一次。系统调用是毫秒级的。
        """
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return False
        if pid <= 0:
            return False
        h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = wintypes.DWORD()
            if not _kernel32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            _kernel32.CloseHandle(h)

else:
    def _pid_alive(pid):
        if not pid:
            return False
        try:
            os.kill(int(pid), 0)
            return True
        except OSError:
            return False


# ─────────────────────── 磁盘注册表（廉价）───────────────────────

# 磁盘注册表读取的缓存间隔。
#
# 读文件本身很廉价（几个 JSON），但每个会话要做一次存活检查
# （Windows 上是 OpenProcess 系统调用）。加上短 TTL 后，
# UI 的 2 秒轮询最多只做一次真实检查，开销可忽略。
REGISTERED_TTL_SEC = 1.5

_reg_lock = threading.Lock()
_reg_cache = {"at": 0.0, "data": []}


def list_registered(force=False):
    """
    读磁盘上登记的会话。损坏的注册项会被跳过而不是抛错。

    带短 TTL 缓存（1.5 秒）—— 见上面的说明。
    force=True 时绕过缓存（stop/prune 这类要求准确的操作用）。
    """
    if not force:
        with _reg_lock:
            if (time.time() - _reg_cache["at"]) < REGISTERED_TTL_SEC:
                return list(_reg_cache["data"])

    if not SESS_DIR.exists():
        with _reg_lock:
            _reg_cache["at"] = time.time()
            _reg_cache["data"] = []
        return []
    out = []
    try:
        files = sorted(SESS_DIR.glob("*.json"))
    except Exception:                                    # noqa: BLE001
        return []
    for f in files:
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
        except Exception:                                # noqa: BLE001
            continue
        sid = meta.get("id") or f.stem
        meta["id"] = sid
        meta["__file"] = str(f)
        meta["__stopFile"] = str(SESS_DIR / f"{sid}.stop")
        meta["__logFile"] = str(LOG_DIR / f"{sid}.log")
        meta["alive"] = _pid_alive(meta.get("pid"))
        # 僵尸判定：pid 存在但心跳早停了（硬关机留下的残留）。
        # 这类项若仍按 alive 显示会变成"关不掉的标签"，所以单独标出来。
        meta["zombie"] = bool(meta["alive"]) and _is_zombie(meta)
        out.append(meta)
    out.sort(key=lambda m: str(m.get("startedAt") or ""))
    with _reg_lock:
        _reg_cache["at"] = time.time()
        _reg_cache["data"] = list(out)
    return out


# ─────────────────── 外部发现（昂贵，带缓存）───────────────────

_ext_lock = threading.Lock()
_ext_cache = {"at": 0.0, "data": [], "inFlight": False}
_ext_thread = None


def _discover_external_blocking():
    """真正去查进程表。只应由后台线程调用。"""
    if os.name != "nt":
        return []
    import subprocess
    ps = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | "
        "Where-Object { $_.CommandLine -like '*noglass.js*' } | "
        "Select-Object ProcessId,ParentProcessId,CommandLine | "
        "ConvertTo-Json -Compress"
    )
    try:
        raw = (subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, encoding="utf-8", errors="replace",
            timeout=PS_TIMEOUT_SEC,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout or "").strip()
    except Exception:                                    # noqa: BLE001
        return []
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:                                    # noqa: BLE001
        return []
    if isinstance(data, dict):
        data = [data]

    out = []
    for d in data:
        cl = str(d.get("CommandLine") or "")
        prof = None
        port = None
        idx = cl.find("--profile")
        if idx >= 0:
            rest = cl[idx + len("--profile"):].strip()
            if rest.startswith('"'):
                prof = rest[1:].split('"')[0]
            elif rest.split():
                prof = rest.split()[0]
        pidx = cl.find("--port")
        if pidx >= 0:
            rest = cl[pidx + len("--port"):].strip()
            tok = rest.split()[0] if rest.split() else ""
            if tok.isdigit():
                port = int(tok)
        out.append({
            "id": None,
            "pid": d.get("ProcessId"),
            "parentPid": d.get("ParentProcessId"),
            "commandLine": cl,
            "profilePath": prof,
            "profile": Path(prof).stem if prof else None,
            "port": port,
            # 没登记的注入器只能从命令行判断是否隔离。不判断的话，
            # 「外部起的隔离实例」会被当成普通会话来限制按钮与守卫 ——
            # 用户勾了隔离仍被拒绝，且提示自相矛盾。
            "isolate": "--isolate" in cl,
            "external": True,
            "alive": True,
            "source": "external",
        })
    return out


def _refresh_external():
    """后台刷新一次外部发现结果。"""
    try:
        data = _discover_external_blocking()
        with _ext_lock:
            _ext_cache["data"] = data
            _ext_cache["at"] = time.time()
    except Exception:                                    # noqa: BLE001
        pass
    finally:
        with _ext_lock:
            _ext_cache["inFlight"] = False


def discover_external(force=False):
    """
    取外部注入器列表。

    默认**只读缓存**，绝不阻塞调用方 —— 这是 UI 轮询路径上的关键约束。
    缓存过期时在后台线程里刷新，本次调用仍返回旧数据。
    force=True 时才同步等待（仅用于 CLI 这类一次性场景）。
    """
    global _ext_thread
    now = time.time()
    with _ext_lock:
        fresh = (now - _ext_cache["at"]) < EXTERNAL_TTL_SEC
        if fresh and not force:
            return list(_ext_cache["data"])

    if force:
        # 同步路径（CLI 用）：直接查一次
        _refresh_external()
        with _ext_lock:
            return list(_ext_cache["data"])

    # 异步路径（UI 用）：起后台线程，立刻返回旧缓存
    with _ext_lock:
        if _ext_cache["inFlight"]:
            return list(_ext_cache["data"])
        _ext_cache["inFlight"] = True
    _ext_thread = threading.Thread(target=_refresh_external, daemon=True)
    _ext_thread.start()
    with _ext_lock:
        return list(_ext_cache["data"])


# ─────────────────────── 合并视图 ───────────────────────

def list_all(force=False):
    """合并「已登记」与「外部发现」，按 pid 去重（已登记优先，字段更全）。"""
    registered = list_registered()
    seen = {r.get("pid") for r in registered}
    external = [e for e in discover_external(force=force)
                if e.get("pid") not in seen]
    return registered + external


# ─────────────────────── 操作 ───────────────────────

def request_stop(session_id):
    """放一个停止文件。注入器会在 1 秒内发现并优雅退出。"""
    ensure_dirs()
    try:
        p = SESS_DIR / f"{session_id}.stop"
        p.write_text(f"stop requested at {time.strftime('%Y-%m-%dT%H:%M:%S')}\n",
                     encoding="utf-8")
        return True, ""
    except Exception as e:                               # noqa: BLE001
        return False, str(e)


def cleanup_residual(session_id, wait_sec=2.0):
    """
    处理「点停止但没反应」的残留会话。**绝不对该 pid 发 kill。**

    为什么不能 kill：残留项的 pid 可能**已经被系统复用给无关进程**
    （这正是僵尸会话的成因）。对它 taskkill 会杀掉无辜进程 —— 实测中
    那个 pid 甚至可能指向用户自己的应用。

    做法是用 .stop 文件本身探活 —— 它是现成的、零风险的握手：
      1. 写 run/sessions/<id>.stop
      2. 等一会儿
         · 注册项消失 → 注入器还活着，它消费了停止请求并自行退出（正常停止）
         · 注册项仍在 → 注入器早就不在了，没人消费 → 删掉残留项与 stop 文件
    两种结果都不需要碰任何进程。

    返回 (结果, 说明)：
      ("stopped",  ...)   注入器还活着，已优雅停止
      ("cleaned",  ...)   注入器早已退出，残留项已清理
      ("missing",  ...)   注册项不存在
    """
    sess_file = SESS_DIR / f"{session_id}.json"
    if not sess_file.exists():
        return "missing", "该会话的注册项不存在（可能已被清理）。"

    ok, err = request_stop(session_id)
    if not ok:
        return "error", f"写入停止请求失败：{err}"

    # 等注入器消费（它的停止轮询是 1 秒一次，给两倍余量）
    deadline = time.time() + wait_sec
    while time.time() < deadline:
        if not sess_file.exists():
            return "stopped", "已请求停止，注入器已优雅退出。目标应用不受影响。"
        time.sleep(0.1)

    # 还在 —— 说明没人消费这个停止请求，注入器早死了。清残留。
    removed = []
    for p in (sess_file, SESS_DIR / f"{session_id}.stop"):
        try:
            p.unlink()
            removed.append(p.name)
        except Exception:                                # noqa: BLE001
            pass
    if removed:
        return "cleaned", ("该注入器早已退出（注册项是硬关机留下的残留），已清理："
                           + "、".join(removed))
    return "error", "残留项存在但删除失败（可能被占用）。"


def force_kill(pid):
    """
    兜底强停。**绝不用 /T。**
    /T 会顺进程树杀掉目标应用 —— 注入器启动应用时虽然 detached，
    但父子关系仍在进程表里，/T 会一路杀下去，关掉用户正在用的窗口。
    """
    if not pid:
        return False, "缺少 pid"
    import subprocess
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.kill(int(pid), 9)
        return True, ""
    except Exception as e:                               # noqa: BLE001
        return False, str(e)


def read_log(session_id, max_bytes=200_000):
    """读某会话的日志（取尾部）。返回 (文本, 字节偏移)。"""
    p = LOG_DIR / f"{session_id}.log"
    try:
        size = p.stat().st_size
    except Exception:                                    # noqa: BLE001
        return "", 0
    start = max(0, size - max_bytes)
    try:
        with open(p, "rb") as f:
            f.seek(start)
            data = f.read()
        return data.decode("utf-8", errors="replace"), size
    except Exception:                                    # noqa: BLE001
        return "", size


def log_path(session_id):
    return str(LOG_DIR / f"{session_id}.log")


def prune():
    """
    清理已退出会话残留的注册项。

    清理两类：
      · alive == False  —— 进程真的没了
      · zombie == True  —— pid 还在但心跳早停了（硬关机残留）。
        以前只清第一类，僵尸永远够不到（它不是 alive=False），
        于是每次硬关机都累积一个「关不掉的标签」。
    """
    n = 0
    for s in list_registered(force=True):
        if s.get("alive") and not s.get("zombie"):
            continue
        try:
            Path(s["__file"]).unlink()
            n += 1
        except Exception:                                # noqa: BLE001
            pass
        try:
            Path(s["__stopFile"]).unlink()
        except Exception:                                # noqa: BLE001
            pass
    return n


def warm_up():
    """
    预热：让外部发现的后台线程先跑起来。
    UI 启动时调一次，这样用户第一次看会话列表时缓存已有数据。
    """
    discover_external()


if __name__ == "__main__":
    import pprint
    pprint.pprint(list_all(force=True))
