#!/usr/bin/env python3
"""独立验收用的 **族③ 运行时差分**（harness-verifier 自建）。

问题：`global_skill_mods` 的**非冒号体**认领（`430/441/531/532/534/682`）到底有没有运行时写点？
没有写点 ⇒ 不许认领；有写点却被删了 ⇒ 就是**误伤**（收窄做过头）。

做法：真开局、真出招。对每条技能：
  · 找一只学得会的精灵，把它放进配招，`env.reset(config=mobile_s4_candidate_v3)`；
  · 对**每一个合法敌手动作**各重置一次再 `step_joint`（避免状态串味）；
  · 数 `global_skill_mod_applied` 事件，并读 `player.field_pet.global_skill_mods`。

**差分控件**：正域 = 冒号体 `721 赤子之心` / `728 撒娇`（已知有写点），它们必须 >0；
负域 = 六条非冒号体，必须 0。两边一正一负才说明「0」不是探针瞎了。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-family3-runtime.py
退出码: 0 = 差分成立（负域全 0 且正域 >0）；3 = 不成立；1 = 夹具搭不起来。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402

OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "verifier 族③差分", "microcase_id": "MC-E05"}]
POOL = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086",
        "pet_000127", "pet_000013", "pet_000550", "pet_000225", "pet_000190",
        "pet_000445", "pet_000417", "pet_000124", "pet_000003", "pet_000004",
        "pet_000008", "pet_000011", "pet_000025", "pet_000047", "pet_000072"]
NEGATIVE = ["skill_000430", "skill_000441", "skill_000531",
            "skill_000532", "skill_000534", "skill_000682"]
POSITIVE = ["skill_000721", "skill_000728"]


def probe(rs, sid):
    sk = rs.skills.get(sid)
    if sk is None:
        return None
    pid = next((p for p in sorted(rs.pets) if rs.is_learnable(p, sid)), None)
    if pid is None:
        return {"skill_id": sid, "fixture": "no_learner"}
    moves = tuple([sid] + [x for x in sorted(rs.learnsets[pid].all_skill_ids)
                           if x in rs.skills and x != sid][:3])
    team_a = [pid] + [p for p in POOL if p != pid][:5]
    team_b = [p for p in sorted(rs.pets) if p not in team_a][:6]
    base = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                   loadouts={pid: moves}, unverified_overrides=OVR)
    foe_actions = E.legal_actions(base, rs, "enemy")
    applied = 0
    mods_seen = set()
    kinds = []
    tried = 0
    for fa in foe_actions:
        st = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                     loadouts={pid: moves}, unverified_overrides=OVR)
        mine = [a for a in E.legal_actions(st, rs, "player")
                if getattr(a, "skill_id", None) == sid]
        if not mine:
            continue
        after = E.step_joint(st, rs, mine[0], fa)
        tried += 1
        evs = [e.to_dict() for e in after.events]
        applied += sum(1 for e in evs if e.get("kind") == "global_skill_mod_applied")
        kinds.append(",".join(e.get("kind") for e in evs)[:70])
        mods_seen.add(json.dumps(dict(getattr(after.player.field_pet, "global_skill_mods", None) or {}),
                                 ensure_ascii=False, sort_keys=True))
    return {"skill_id": sid, "name": getattr(sk, "name", ""),
            "category": getattr(sk, "category", None), "desc": str(getattr(sk, "desc", "")),
            "learner": pid, "enemy_actions_tried": tried,
            "global_skill_mod_applied_events": applied,
            "final_global_skill_mods": sorted(mods_seen),
            "sample_event_kinds": kinds[:3]}


def main() -> int:
    rs = D.load_ruleset()
    neg = [probe(rs, s) for s in NEGATIVE]
    pos = [probe(rs, s) for s in POSITIVE]
    for r in neg + pos:
        print("ROW " + json.dumps(r, ensure_ascii=False, default=str))
    fails = []
    for r in neg:
        if not r or r.get("fixture"):
            fails.append(f"{r}: 夹具搭不起来")
            continue
        if r["global_skill_mod_applied_events"] != 0:
            fails.append(f"{r['skill_id']}: 非冒号体竟然发了 "
                         f"{r['global_skill_mod_applied_events']} 次写点事件 ⇒ 收窄是误伤")
        if r["enemy_actions_tried"] == 0:
            fails.append(f"{r['skill_id']}: 一次都没打出（夹具无效）")
    for r in pos:
        if not r or r.get("fixture"):
            fails.append(f"{r}: 正域夹具搭不起来")
            continue
        if r["global_skill_mod_applied_events"] <= 0:
            fails.append(f"{r['skill_id']}: 正域（冒号体）没有写点事件 ⇒ 控件失败，负域的 0 不可信")
    neg_total = sum(r["global_skill_mod_applied_events"] for r in neg if r)
    pos_total = sum(r["global_skill_mod_applied_events"] for r in pos if r)
    print(f"DIFFERENTIAL neg_applied={neg_total} pos_applied={pos_total} "
          f"neg_tried={sum(r['enemy_actions_tried'] for r in neg if r)}")
    print(f"RUNTIME_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
