#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diag-session-zombie.py —— 复现「硬关机后的僵尸会话标签」

背景（详见 docs/TODO-未修问题.md 第 4 条）
────────────────────────────────────────
硬关机时 Windows 不向进程派发信号，注入器的 cleanup() 不会跑，于是
run/sessions/<profile>-<pid>.json 残留在磁盘上。而存活判断只看
「该 PID 有没有进程」（OpenProcess），不校验它是不是那个注入器 ——
开机后 PID 被复用，僵尸会话就被显示成「运行中」，且：

  · 点停止没反应（协作式停止文件没人消费）
  · prune 清不掉（它不是 alive=False）

这个脚本用**完全可控、可清理**的方式复现那个状态：
伪造一个陈旧注册项，并把它的 pid 指向一个真实存在的进程
（默认就用本脚本自己的 python 进程），然后用 UI 的同一套接口
观察「它被判为活着 / 停止无反应」的现象。

用法
────
  python tools/diag-session-zombie.py            # 只观察，不写任何文件
  python tools/diag-session-zombie.py --repro    # 写伪造注册项并观察（结束后自动清理）
  python tools/diag-session-zombie.py --clean    # 只清理可能残留的伪造项

安全
────
伪造项的 id 固定为 `__diag_zombie__`，与真实会话不可能重名；
`--repro` 结束（含 Ctrl+C）时会删掉它，不会影响你的真实会话。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ui"))

import sessions  # noqa: E402  （ui/sessions.py）

FAKE_ID = "__diag_zombie__"
FAKE_FILE = sessions.SESS_DIR / f"{FAKE_ID}.json"


def observe(label):
    """打印当前所有会话的存活判定，以及那个伪造项的停止行为。"""
    print(f"\n=== {label} ===")
    regs = sessions.list_registered(force=True)
    if not regs:
        print("  （没有登记项）")
    for r in regs:
        tag = "  ← 伪造项" if r.get("id") == FAKE_ID else ""
        print(f"  id={r.get('id')}")
        print(f"     pid      : {r.get('pid')}")
        print(f"     alive    : {r.get('alive')}   ← 只看 PID 是否存在{tag}")
        print(f"     lastTick : {r.get('lastTick')}   ← 只写不读，没有心跳校验")
        print(f"     appPid   : {r.get('appPid')}   ← 只写不读")

    # 对伪造项发起停止请求，看它会不会真的消失
    if FAKE_FILE.exists():
        ok, err = sessions.request_stop(FAKE_ID)
        print(f"\n  对伪造项请求停止：ok={ok} err={err!r}")
        print("  （它写了 run/sessions/__diag_zombie__.stop，但没有任何注入器会来消费）")
        time.sleep(1.5)
        still = FAKE_FILE.exists()
        print(f"  1.5 秒后伪造项还在吗：{still}   ← True 即复现「关不掉」")


def write_fake():
    """写一个伪造的陈旧注册项，pid 指向本进程（一个确实存在的进程）。"""
    sessions.ensure_dirs()
    meta = {
        "id": FAKE_ID,
        "pid": os.getpid(),              # 真实存在的 PID —— 模拟"PID 被复用"
        "profile": "__diag__",
        "displayName": "【诊断】僵尸会话",
        "appName": "__diag__",
        "processName": None,
        "exe": None,
        "port": 0,
        "inspectPort": 0,
        "watch": True,
        "isolate": False,
        "native": False,
        "css": None,
        "cssExtra": None,
        "emulateColorScheme": None,
        "darkreader": None,
        "darkreaderTheme": None,
        # 关键：把心跳时间设成很久以前 —— 它明明已经"没有心跳"了，
        # 但当前逻辑不会因此判它死（因为 lastTick 根本没人读）。
        "startedAt": "2020-01-01T00:00:00.000Z",
        "lastTick": "2020-01-01T00:00:00.000Z",
        "appPid": None,
        "source": "diag",
    }
    FAKE_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    return FAKE_FILE


def clean():
    n = 0
    for p in (FAKE_FILE, sessions.SESS_DIR / f"{FAKE_ID}.stop"):
        try:
            p.unlink()
            n += 1
            print(f"  已删除 {p.name}")
        except FileNotFoundError:
            pass
        except Exception as e:                           # noqa: BLE001
            print(f"  删除 {p.name} 失败：{e}")
    if not n:
        print("  （没有需要清理的伪造项）")


def main():
    ap = argparse.ArgumentParser(description="复现僵尸会话标签")
    ap.add_argument("--repro", action="store_true",
                    help="写伪造注册项并观察（结束后自动清理）")
    ap.add_argument("--clean", action="store_true", help="只清理伪造项后退出")
    args = ap.parse_args()

    if args.clean:
        print("清理伪造项：")
        clean()
        return 0

    print(f"注册表目录：{sessions.SESS_DIR}")
    observe("当前状态（未伪造）")

    if not args.repro:
        print("\n想复现僵尸标签，加 --repro 重新运行。")
        return 0

    print("\n写入伪造注册项（pid=本进程，lastTick=2020 年）…")
    f = write_fake()
    print(f"  已写 {f}")

    try:
        observe("伪造后")
        print("\n【结论】")
        print("  上面的 alive=True 就是问题所在：该会话的 lastTick 停在 2020 年，")
        print("  但判定只看'PID 有没有进程'，所以它永远显示运行中、且停止无效。")
        print("  真实场景里，那个 PID 是开机后被系统复用给别的进程的。")
    finally:
        print("\n清理：")
        clean()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n中断，清理中…")
        clean()
        sys.exit(130)
