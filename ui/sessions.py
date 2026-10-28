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
import re
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
#
# 为什么从 8 秒提到 30 秒：单次查询要起一个 PowerShell 跑 Get-CimInstance，
# 实测 1.7 秒。UI 每 2 秒轮询一次会话列表，8 秒的 TTL 意味着每 8 秒就有
# 一次满核突发 —— 与 get_overview 的 5 秒 TTL 叠加，就是用户看到的
# 「CPU 过山车」（实测 30 秒窗口内占空比 37%）。
# 现在所有注入器都会写注册项，这条兜底路径很少真的命中，30 秒足够。
EXTERNAL_TTL_SEC = 30.0

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


# ─────────────────── 启动守卫：进程身份校验 ───────────────────

# 一次列出所有 node.exe 进程（不只 noglass.js）。
#
# 为什么用 '[]' 而不是空输出：必须区分「查询成功但一个都没有」与
# 「PowerShell 起不来」。前者能证明某个 pid 已被别的进程占用（可以删残留），
# 后者什么都不能确定（只能退回心跳判断）。
#
# 为什么要连无关的 node 进程一起列：PID 复用的新主人很可能也是 node.exe
# （VS Code、开发服务器…）。只筛 noglass.js 的话，这类 pid 不在结果里，
# 就只能靠映像名猜；列出全部 node 后可以直接看它的命令行。
_NODE_PS = (
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
    "$p = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | "
    "Select-Object ProcessId,CommandLine); "
    "if ($p.Count -eq 0) { '[]' } else { $p | ConvertTo-Json -Compress }"
)


def _query_node_processes():
    """
    列出所有 node.exe 进程，返回 {pid: commandLine|None}。

    查询失败返回 None；查询成功但没有进程返回空字典。
    None 值表示「进程在，但命令行读不到」（跨权限），不能当成空字符串。
    """
    if os.name != "nt":
        return None
    import subprocess
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _NODE_PS],
            capture_output=True, encoding="utf-8", errors="replace",
            timeout=PS_TIMEOUT_SEC,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        raw = (r.stdout or "").strip()
        if not raw:
            return None
        data = json.loads(raw)
    except Exception:                                    # noqa: BLE001
        return None

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return None

    out = {}
    for d in data:
        try:
            pid = int(d.get("ProcessId"))
        except (TypeError, ValueError, AttributeError):
            continue
        if pid > 0:
            cl = d.get("CommandLine")
            out[pid] = None if cl is None else str(cl)
    return out


def _cmdline_profile(command_line):
    """从命令行里取 --profile 的值（支持带引号/不带引号）。"""
    m = re.search(r'--profile\s+(?:"([^"]+)"|\'([^\']+)\'|(\S+))',
                  str(command_line or ""))
    if not m:
        return None
    return m.group(1) or m.group(2) or m.group(3) or None


def _cmdline_matches_session(meta, command_line):
    """
    命令行的 noglass 进程是否就是 meta 这条注册项对应的那个注入器。

    先比 profile 绝对路径；路径写法不同（相对路径、搬家后的另一份副本）
    就退一步比文件名。没有 --profile 的旧式启动不猜，按「是」处理 ——
    宁可拦住，也不能误删一条真会话。
    """
    cl = str(command_line or "")
    if "noglass.js" not in cl.lower():
        return False
    prof = _cmdline_profile(cl)
    if not prof:
        return True

    meta_path = meta.get("profilePath")
    if meta_path:
        try:
            if os.path.normcase(os.path.normpath(prof)) == \
                    os.path.normcase(os.path.normpath(meta_path)):
                return True
        except Exception:                                # noqa: BLE001
            pass
        try:
            if Path(prof).stem.lower() == Path(meta_path).stem.lower():
                return True
        except Exception:                                # noqa: BLE001
            pass

    try:
        return Path(prof).stem.lower() == str(meta.get("profile") or "").lower()
    except Exception:                                    # noqa: BLE001
        return False


def _pid_image_name(pid):
    """
    用 tasklist 取某个 pid 的映像名。

    PowerShell 进程表查询失败时的廉价兜底：只要映像名不是 node.exe，
    就能确定这个 pid 已被别的软件占用，没必要再保守拦截。
    """
    if os.name != "nt":
        return None
    import subprocess
    try:
        r = subprocess.run(
            ["tasklist", "/FI", f"PID eq {int(pid)}", "/FO", "CSV", "/NH"],
            capture_output=True, encoding="utf-8", errors="replace",
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        line = (r.stdout or "").strip()
        if not line.startswith('"'):
            return None                     # 没匹配到进程（或本地化的提示行）
        return line.split('","', 1)[0].strip('"').lower() or None
    except Exception:                                    # noqa: BLE001
        return None


def _remove_registration(meta):
    """删除一条已被证明失效的注册项（JSON + 停止文件）。不碰日志。"""
    for key in ("__file", "__stopFile"):
        p = meta.get(key)
        if not p:
            continue
        try:
            Path(p).unlink()
        except Exception:                                # noqa: BLE001
            pass


def find_live_session(profile_name):
    """
    找出某个 profile **真正**还在跑的注入会话；没有则返回 None。

    为什么不能只看 pid：硬关机留下的注册项在开机后会撞上 Windows PID
    复用，pid 随便被 svchost / 别的软件拿到，只看存活就会永远报
    「已经在运行中」，开机自启全部失败（实测日志里有 pid 25324/17088）。

    判定：
      · pid 存活 → 一次进程表查询核对命令行（noglass.js + profile）；
      · 查询成功且不匹配 → 删除该注册项，继续；
      · 查询失败 → 心跳 zombie + tasklist 映像名兜底（不删真会话）；
      · 再查已缓存的外部发现，覆盖「旧版本启动 / 注册项被删」的注入器。

    本函数只删除**已被证明失效**的注册项，不会对任何 pid 发 kill。
    """
    regs = list_registered(force=True)
    candidates = [r for r in regs
                  if r.get("alive") and r.get("profile") == profile_name]

    # 没有候选就不查进程表 —— 正常启动路径不付 PowerShell 的开销。
    procs = _query_node_processes() if candidates else None
    live = None
    removed = False
    for r in candidates:
        if procs is None:
            # 无法核对命令行：心跳过期才当残留；否则再用 tasklist 看一眼
            # 映像名 —— 只要不是 node.exe，就能确定是 PID 复用。
            if r.get("zombie"):
                continue
            _image = _pid_image_name(r.get("pid"))
            if _image and _image != "node.exe":
                _remove_registration(r)
                removed = True
                continue
            if live is None:
                live = r
            continue

        _pid = int(r.get("pid") or 0)
        if _pid not in procs:
            # 不是 node.exe。再用 tasklist 确认一次（WMI 可能漏掉刚启动的）。
            _image = _pid_image_name(_pid)
            if _image and _image != "node.exe":
                _remove_registration(r)
                removed = True
            elif live is None:
                # 映像名是 node.exe 或读不到 → 无法证明是残留，保守拦住。
                live = r
            continue

        cl = procs.get(_pid)
        if not cl:
            # 是 node.exe，但命令行读不到（跨权限）—— 不能证明不是真会话。
            if live is None:
                live = r
        elif _cmdline_matches_session(r, cl):
            if live is None:
                live = r
        else:
            # 同一个 pid 是 node.exe，但命令行不是本 profile 的 noglass.js
            # （无关 node 进程，或另一个 profile 的注入器）→ 旧会话已死。
            _remove_registration(r)
            removed = True

    if removed:
        # 下一次 list_registered 必须重新读盘，否则 UI 还会显示刚删掉的项。
        with _reg_lock:
            _reg_cache["at"] = 0.0

    if live is not None:
        return live

    # 未登记的外部注入器（旧版本启动 / 注册项被手工删掉）。
    # 只读 30 秒缓存，不阻塞启动路径；缓存项也要复核 pid 是否还活着。
    try:
        for r in discover_external():
            if r.get("profile") != profile_name:
                continue
            if not _pid_alive(r.get("pid")):
                continue
            return r
    except Exception:                                    # noqa: BLE001
        pass
    return None


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


def read_log_since(session_id, offset=0, max_bytes=200_000):
    """
    增量读日志：从 offset 字节处读到文件尾。返回 (文本, 新偏移, 是否重置)。

    为什么需要它（修一个真 bug）：
      文件型会话（外部启动的注入器，如自启动项拉起的）原先每次都整段返回
      最后 400 行。前端拿到后只能**整体重写**日志区 —— 而重写会销毁所有
      DOM 节点，于是用户刚选中的文字每 300ms 被清空一次（实测反馈：
      "选择内容每隔几秒就重新从头开始"）。顺带每次轮询都全量读文件，
      日志越长越慢。

    重置语义（第三个返回值）：
      offset 为 0、或文件比 offset 短（被截断/轮转过）时，返回尾部快照
      并要求前端**整体重渲染**（reset=True）。其余情况只返回新增部分。

    注意 max_bytes 截断：只有在"要读的尾巴超过 max_bytes"时才会丢掉开头，
    那时也必须让前端重置，否则它会把半截内容当成增量追加。
    """
    p = LOG_DIR / f"{session_id}.log"
    try:
        size = p.stat().st_size
    except Exception:                                    # noqa: BLE001
        return "", 0, True                               # 没有文件：让前端显示"暂无日志"

    # 文件变小 = 被截断/轮转，或前端游标来自上一个文件 → 重新给尾部快照
    truncated = offset <= 0 or offset > size
    if truncated:
        start = max(0, size - max_bytes)
        try:
            with open(p, "rb") as f:
                f.seek(start)
                data = f.read()
            return data.decode("utf-8", errors="replace"), size, True
        except Exception:                                # noqa: BLE001
            return "", size, True

    # 增量：只读 offset 之后的新内容
    try:
        with open(p, "rb") as f:
            f.seek(offset)
            data = f.read()
        return data.decode("utf-8", errors="replace"), size, False
    except Exception:                                    # noqa: BLE001
        return "", offset, False


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
