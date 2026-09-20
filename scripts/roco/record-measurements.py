#!/usr/bin/env python3
"""记录**游戏内实测**：这是把「假设」变成「核验」的唯一入口。

为什么需要它
------------

项目的 30 条 microcase 一条都没通过，原因只有一个：**没有任何游戏内实测**。
引擎里对每条待验机制都选了一个明确行为并登记成假设（见
`docs/roco/MICROCASE-HARNESS.md`），但「引擎这么做」不等于「游戏这么算」。

这个脚本负责把一次实测**规范化**地记下来：字段齐、来源清、时间戳有、
不许留空。它**不**判断实测是否支持引擎的假设 —— 那一步在
`scripts/roco/calibrate-from-measurements.py` 里做，而且**由人设定判定规则**。

一条实测最少要有
----------------

  · `case_id`      —— 关联到哪条 microcase（MC-010 之类）
  · `kind`         —— `damage`（一次伤害）/ `speed_tie`（同速谁先动）/ `buff`（带增减的伤害）
  · `observed_at`  —— 什么时候观察到的（ISO 时间）
  · `source`       —— `manual`（你自己在游戏里看的）还是别的
  · 按 `kind` 的必填字段（见下）

用法::

    # 交互式录入（会逐项追问，回车确认）
    python3 scripts/roco/record-measurements.py --interactive

    # 从命令行一次录一条
    python3 scripts/roco/record-measurements.py \
        --case-id MC-010 --kind damage \
        --attacker 寂灭骨龙 --defender 海豹船长 \
        --skill 坟场搏击 --defender-guarded no --damage 143 \
        --note "练习对局，敌方能量 2"

    # 只校验已有文件，不写
    python3 scripts/roco/record-measurements.py --check

写入 `data/roco/measurements.jsonl`（一行一条，追加）。**永远不覆盖**：
实测是原始证据，追加式记录才可追溯。
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from typing import Any, Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

OUT = os.path.join("data", "roco", "measurements.jsonl")

#: 每种实测的必填字段。缺一个就拒收——**不许留空**，
#: 因为空字段会在标定阶段被当成「没测这一项」，而不是「忘了填」。
REQUIRED: Dict[str, List[str]] = {
    "damage": ["attacker", "defender", "skill", "damage"],
    "speed_tie": ["pet_a", "pet_b", "first_moved", "repeats"],
    "buff": ["attacker", "defender", "skill", "buff_desc", "damage"],
}

#: `damage` / `buff` 里「是否防御」必填：它决定减伤有没有生效，
#: 而减伤是否无条件正是 MC-020/MC-029 要回答的问题。
EXTRA_REQUIRED: Dict[str, List[str]] = {
    "damage": ["defender_guarded"],
    "buff": ["defender_guarded", "baseline_damage"],
}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def validate(record: Dict[str, Any]) -> List[str]:
    """返回问题列表（空 = 合法）。"""
    problems: List[str] = []
    kind = record.get("kind")
    if kind not in REQUIRED:
        problems.append(f"kind 必须是 {sorted(REQUIRED)} 之一，实际 {kind!r}")
        return problems
    for field in REQUIRED[kind] + EXTRA_REQUIRED.get(kind, []):
        if record.get(field) in (None, "", []):
            problems.append(f"{kind} 缺必填字段 {field}")
    for field in ("case_id", "observed_at", "source"):
        if record.get(field) in (None, ""):
            problems.append(f"缺必填字段 {field}")
    if kind in ("damage", "buff") and record.get("damage") is not None:
        try:
            value = int(record["damage"])
        except (TypeError, ValueError):
            problems.append("damage 必须是整数（游戏里显示的是整数）")
        else:
            if value <= 0:
                problems.append("damage 必须为正——0 多半是「没打中」而不是「伤害为 0」，"
                                "请用 note 说明")
    if kind == "speed_tie":
        if record.get("first_moved") not in ("a", "b", "same_time", "unknown"):
            problems.append("first_moved 必须是 a / b / same_time / unknown")
        try:
            repeats = int(record.get("repeats") or 0)
        except (TypeError, ValueError):
            problems.append("repeats 必须是整数")
        else:
            if repeats < 1:
                problems.append("repeats 至少为 1（只观察一次说明不了是否随机）")
    if kind == "buff":
        try:
            if int(record.get("baseline_damage") or 0) <= 0:
                problems.append("buff 需要 baseline_damage（同一技能、无增减时的伤害）")
        except (TypeError, ValueError):
            problems.append("baseline_damage 必须是整数")
    return problems


def append(record: Dict[str, Any]) -> None:
    path = os.path.join(_ROOT, OUT)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_all() -> List[Dict[str, Any]]:
    path = os.path.join(_ROOT, OUT)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                out.append(json.loads(line))
            except ValueError as exc:
                print(f"[record-measurements] 第 {i} 行不是合法 JSON：{exc}", file=sys.stderr)
    return out


def ask(prompt: str, *, default: Optional[str] = None) -> str:
    suffix = f"（默认 {default}）" if default is not None else ""
    answer = input(f"{prompt}{suffix}：").strip()
    return answer or (default or "")


def interactive(case_id: Optional[str]) -> int:
    print("一次实测录入。括号里是必填项的说明，直接回车表示用默认值/留空。")
    cid = case_id or ask("case_id（例如 MC-010）")
    kind = ask("kind（damage / speed_tie / buff）", default="damage")
    record: Dict[str, Any] = {
        "case_id": cid, "kind": kind, "observed_at": _now(),
        "source": ask("source（默认 manual=你自己在游戏里看到的）", default="manual"),
        "note": ask("note（这次观察的上下文，越具体越好）"),
    }
    if kind == "damage":
        record.update({
            "attacker": ask("我方/攻击方精灵名"),
            "defender": ask("被攻击方精灵名"),
            "skill": ask("技能名"),
            "defender_guarded": ask("被攻击方是否用了防御技能（yes/no）", default="no"),
            "damage": ask("实际伤害数字"),
        })
    elif kind == "speed_tie":
        record.update({
            "pet_a": ask("A 方精灵名"),
            "pet_b": ask("B 方精灵名"),
            "first_moved": ask("谁先动（a / b / same_time / unknown）"),
            "repeats": ask("重复观察了几次"),
        })
    else:
        record.update({
            "attacker": ask("攻击方精灵名"),
            "defender": ask("被攻击方精灵名"),
            "skill": ask("技能名"),
            "buff_desc": ask("用了什么增减（例如 自己获得物攻+100%）"),
            "defender_guarded": ask("被攻击方是否用了防御（yes/no）", default="no"),
            "baseline_damage": ask("无增减时同一技能的伤害"),
            "damage": ask("带增减后的实际伤害"),
        })
    problems = validate(record)
    if problems:
        print("\n拒收，以下字段有问题：")
        for problem in problems:
            print("  -", problem)
        print("\n（没有写入任何内容。）")
        return 2
    append(record)
    print(f"\n已追加到 {OUT}：{json.dumps(record, ensure_ascii=False)}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="记录游戏内实测")
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--check", action="store_true", help="只校验已有文件")
    parser.add_argument("--case-id")
    parser.add_argument("--kind", default="damage")
    parser.add_argument("--attacker")
    parser.add_argument("--defender")
    parser.add_argument("--skill")
    parser.add_argument("--damage", type=int)
    parser.add_argument("--defender-guarded", default="no")
    parser.add_argument("--pet-a")
    parser.add_argument("--pet-b")
    parser.add_argument("--first-moved")
    parser.add_argument("--repeats", type=int)
    parser.add_argument("--buff-desc")
    parser.add_argument("--baseline-damage", type=int)
    parser.add_argument("--note", default="")
    parser.add_argument("--source", default="manual")
    args = parser.parse_args(argv)

    if args.check:
        records = load_all()
        if not records:
            print(f"{OUT} 里还没有任何实测记录。")
            return 0
        bad = 0
        for i, record in enumerate(records, 1):
            problems = validate(record)
            if problems:
                bad += 1
                print(f"第 {i} 条（{record.get('case_id')}）：{'；'.join(problems)}")
        print(f"共 {len(records)} 条，{len(records) - bad} 条合法，{bad} 条有问题。")
        return 1 if bad else 0

    if args.interactive:
        return interactive(args.case_id)

    if not args.case_id:
        parser.error("需要 --case-id（或用 --interactive / --check）")

    record: Dict[str, Any] = {
        "case_id": args.case_id, "kind": args.kind, "observed_at": _now(),
        "source": args.source, "note": args.note,
    }
    if args.kind == "damage":
        record.update({
            "attacker": args.attacker, "defender": args.defender, "skill": args.skill,
            "defender_guarded": args.defender_guarded, "damage": args.damage,
        })
    elif args.kind == "speed_tie":
        record.update({
            "pet_a": args.pet_a, "pet_b": args.pet_b,
            "first_moved": args.first_moved, "repeats": args.repeats,
        })
    elif args.kind == "buff":
        record.update({
            "attacker": args.attacker, "defender": args.defender, "skill": args.skill,
            "buff_desc": args.buff_desc, "defender_guarded": args.defender_guarded,
            "baseline_damage": args.baseline_damage, "damage": args.damage,
        })

    problems = validate(record)
    if problems:
        print("拒收，以下字段有问题：", file=sys.stderr)
        for problem in problems:
            print("  -", problem, file=sys.stderr)
        return 2
    append(record)
    print(f"已追加到 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
