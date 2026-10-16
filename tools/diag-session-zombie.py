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
        print(f"     alive    : {r.get('alive')}")
        print(f"     zombie   : {r.get('zombie')}   ← 心跳判定（True = 硬关机残留）{tag}")
        print(f"     lastTick : {r.get('lastTick')}")

    if FAKE_FILE.exists():
        print("\n  ── 对它点「停止」会怎样 ──")
        print("  （走 cleanup_residual：写 .stop 探活 → 没人消费 → 清残留）")
        result, msg = sessions.cleanup_residual(FAKE_ID, wait_sec=1.5)
        print(f"    结果: {result}")
        print(f"    说明: {msg}")
        still = FAKE_FILE.exists()
        print(f"    注册项还在吗: {still}   ← False 即已被清理（修复后应如此）")
        print(f"    伪造 pid ({os.getpid()}) 是否存活: {sessions._pid_alive(os.getpid())}")
        print("    ↑ 必须是 True —— 证明清理过程**没有**对那个 pid 发任何 kill")
        return not still

    return True


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
        # 关键：心跳时间设成很久以前。修复后这应当被识别为 zombie；
        # 修复前它会被当成"运行中"，且点停止没反应。
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

    ok = False
    try:
        ok = observe("伪造后")
        print("\n【结论】")
        print("  期望：zombie=True（心跳停在 2020 年），且点停止会清掉残留项，")
        print("        同时那个 pid 指向的进程**依然存活**（证明没误杀）。")
        print("  修复前的表现：zombie 字段不存在、判定只看 pid，")
        print("        于是它显示成运行中且停止无效（点多少次都没反应）。")
    finally:
        print("\n清理：")
        clean()
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n中断，清理中…")
        clean()
        sys.exit(130)
