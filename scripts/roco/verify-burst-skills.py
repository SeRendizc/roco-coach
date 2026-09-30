#!/usr/bin/env python3
"""独立验收用的 **「迸发」收窄/豁免专项探针**（harness-verifier 自建）。

背景：用户裁决 A ⇒ 给「迸发：**本次技能威力**+N」加**已结算形状豁免**、钉子 `306 → 309`。
本探针把**所有**含「迸发」的技能逐条摊开，防两件事：
  ① 豁免**过宽**：把「迸发：本技能能耗-2 / 使用次数+1 / 负面效果翻倍」这类**没产出**的也放行；
  ② 豁免**过窄**：真有运行时加成的行仍被判未结算。

每条读数：`parsed_effects` / `diagnostic_shape_gaps` / 档位 / 判据 + **真打一手**的
`power_used` vs 静态 `power`（`conditional_reason` 原文）。
控件：至少一条「威力型」必须量到加成、至少一条「非威力型」必须量不到加成。

用法: cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-burst-skills.py [--runtime]
退出码: 0 = 读数已产出（无硬判据）；3 = 控件失败。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import parse as P  # noqa: E402
from roco_env import service as S  # noqa: E402

OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "verifier 迸发专项", "microcase_id": "MC-E05"}]
POOL = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086",
        "pet_000127", "pet_000013", "pet_000550", "pet_000225", "pet_000190",
        "pet_000445", "pet_000417", "pet_000124", "pet_000003", "pet_000004"]
POWER_BURST = re.compile(r"迸发[^，。；]*本次技能威力\s*\+\s*(\d+)")


def runtime(rs, sid):
    sk = rs.skills.get(sid)
    pid = next((p for p in sorted(rs.pets) if rs.is_learnable(p, sid)), None)
    if sk is None or pid is None:
        return {"fixture": "no_learner"}
    moves = tuple([sid] + [x for x in sorted(rs.learnsets[pid].all_skill_ids)
                           if x in rs.skills and x != sid][:3])
    team_a = [pid] + [p for p in POOL if p != pid][:5]
    team_b = [p for p in sorted(rs.pets) if p not in team_a][:6]
    st = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                 loadouts={pid: moves}, unverified_overrides=OVR)
    mine = [a for a in E.legal_actions(st, rs, "player") if getattr(a, "skill_id", None) == sid]
    foe = E.legal_actions(st, rs, "enemy")
    if not mine or not foe:
        return {"fixture": "not_legal", "mine": len(mine)}
    pickup = next((a for a in foe if getattr(a, "kind", "") == "charge"), foe[0])
    after = E.step_joint(st, rs, mine[0], pickup)
    evs = [e.to_dict() for e in after.events]
    dmg = [e["detail"] for e in evs if e.get("kind") == "damage"
           and e["detail"].get("skill_id") == sid]
    used = max([d.get("power_used") or 0 for d in dmg] or [0])
    return {"power_used": used,
            "conditional_reason": next((d.get("conditional_reason") for d in dmg
                                        if d.get("conditional_reason")), None)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", action="store_true")
    args = ap.parse_args()
    rs = D.load_ruleset()
    svc = S.RocoService()
    rep = C.build_coverage(rs).get("skills") or {}

    rows = []
    for sid in sorted(rep):
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        desc = str(getattr(sk, "desc", "") or "")
        if "迸发" not in desc:
            continue
        parsed = P.parse_skill(sk)
        kinds = sorted({getattr(e, "kind", "") for e in (getattr(parsed, "effects", None) or [])})
        v = C.settlement_verdict(sk)
        m = POWER_BURST.search(desc)
        rows.append({
            "skill_id": sid, "name": getattr(sk, "name", ""),
            "power": getattr(sk, "power", None),
            "burst_kind": f"威力+{m.group(1)}" if m else "非威力型",
            "desc": desc,
            "parsed_effects": kinds,
            "diag_gaps": C.diagnostic_shape_gaps(sk, parsed),
            "tier": svc._skill_record(rs, sk, with_tier=True)["support_tier"],
            "resolved": bool(v["resolved"]),
            "settled": list(v.get("settled") or []),
            "unsettled": [str(x) for x in (v.get("unsettled") or [])],
        })
    if args.runtime:
        for r in rows:
            r["runtime"] = runtime(rs, r["skill_id"])

    print(f"BURST_SKILLS {len(rows)}")
    for r in rows:
        print(f"{r['skill_id']} {r['name']} | {r['burst_kind']} | power={r['power']} "
              f"| effects={r['parsed_effects']} | diag={r['diag_gaps']} | tier={r['tier']} "
              f"| resolved={r['resolved']} | settled={r['settled']}")
        print(f"    desc={r['desc']}")
        if "runtime" in r:
            print(f"    runtime={json.dumps(r['runtime'], ensure_ascii=False)}")
    power_rows = [r for r in rows if r["burst_kind"] != "非威力型"]
    other_rows = [r for r in rows if r["burst_kind"] == "非威力型"]
    print(f"POWER_TYPE {len(power_rows)} -> {[r['skill_id'] for r in power_rows]}")
    print(f"NON_POWER_TYPE {len(other_rows)} -> {[r['skill_id'] for r in other_rows]}")
    print(f"TIER_SUMMARY {json.dumps({r['skill_id']: r['tier'] for r in rows}, ensure_ascii=False)}")

    fails = []
    if args.runtime:
        applied = [r["skill_id"] for r in power_rows
                   if (r.get("runtime") or {}).get("power_used", 0) > (r["power"] or 0)]
        # 反向控件：**不是**威力型的迸发行（583/598/607）必须仍判未结算；
        # 587 的迸发子句里自带「威力+10」⇒ 它会有威力变化，但同样必须仍判未结算。
        still_unresolved = [r["skill_id"] for r in other_rows if not r["resolved"]]
        wrongly_resolved = [r["skill_id"] for r in other_rows if r["resolved"]]
        print(f"CTL power_type_bonus_applied {applied}")
        print(f"CTL non_power_type_still_unresolved {still_unresolved}")
        print(f"CTL non_power_type_wrongly_resolved {wrongly_resolved}（必须为空）")
        if not applied:
            fails.append("控件失败：没有任何「威力型」迸发量到加成 ⇒ 夹具无效")
        if wrongly_resolved:
            fails.append(f"豁免过宽：非威力型迸发行被放行 {wrongly_resolved}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
