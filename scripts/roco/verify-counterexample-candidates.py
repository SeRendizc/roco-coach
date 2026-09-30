#!/usr/bin/env python3
"""找「缺陷 B 补类」的**过度放宽反例候选**（只读，不改任何东西）。

要回答：有没有技能**描述里出现**「回复/回能/吸取/偷取/失去」这类词，但引擎运行时**并不结算**
—— 若补类时按宽词匹配（例如裸 `回复`），这些行会被顺带翻正 = **收窄/补类过宽**。

输出候选 + 它们当前为什么仍未结算（其它闸给出的 `unsettled`），便于挑一条真打一手。
用法: cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-counterexample-candidates.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402

WORDS = ("回复", "回能", "吸取", "偷取", "失去", "扣能", "扣除")
TARGET_KINDS = {"heal", "self_energy", "drain_energy", "foe_team_energy_loss"}


def main() -> int:
    rs = D.load_ruleset()
    rep = C.build_coverage(rs).get("skills") or {}
    rows = []
    for sid in sorted(rep):
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        desc = str(getattr(sk, "desc", "") or "")
        hit = [w for w in WORDS if w in desc]
        if not hit:
            continue
        v = C.settlement_verdict(sk)
        parsed = v.get("parsed")
        kinds = {getattr(e, "kind", "") for e in (getattr(parsed, "effects", None) or [])}
        rows.append({
            "skill_id": sid, "name": getattr(sk, "name", ""), "desc": desc,
            "hits": hit, "effects": sorted(kinds),
            "has_target_effect": bool(kinds & TARGET_KINDS),
            "resolved": bool(v["resolved"]),
            "unsettled": [str(x) for x in (v.get("unsettled") or [])],
            "tier": rep[sid]["support"],
        })
    risky = [r for r in rows if not r["resolved"]]
    print(f"DESC_HIT {len(rows)}  UNRESOLVED {len(risky)}")
    print("--- 仍未结算的（补类若按宽词匹配，这些会被误翻正）---")
    for r in risky:
        print(f"{r['skill_id']} {r['name']} | tier={r['tier']} | hits={r['hits']} "
              f"| effects={r['effects']} | unsettled={r['unsettled'][:2]}")
        print(f"    desc={r['desc'][:90]}")
    print()
    print("--- 其中「含目标类效果但判未结算」（补类应翻正的正例）---")
    for r in rows:
        if r["has_target_effect"] and not r["resolved"]:
            print(f"{r['skill_id']} {r['name']} | unresolved 但 effects={r['effects']}")
    print()
    print("--- 已结算的（补类后仍应结算）---")
    for r in rows:
        if r["resolved"]:
            print(f"{r['skill_id']} {r['name']} | effects={r['effects']} | hits={r['hits']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
