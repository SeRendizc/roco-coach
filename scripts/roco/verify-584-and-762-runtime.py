#!/usr/bin/env python3
"""独立验收用的 **584 / 762 运行时取证**（harness-verifier 自建，Lead 指派）。

背景：
  · `584 引雷`「造成魔伤，2连击，**迸发：本次技能威力+20**。」在 306 基线里是 `SIMULATABLE_UNVERIFIED`，
    现在被降成 `PARTIAL`（诊断为「迸发」形状没被 effect 覆盖）⇒ **是真是假要真打一手**：
    引擎的 `effects.effective_power()` 是**读 desc 的**（`if "迸发" in desc` 且
    `attacker._burst_active`）⇒ 即使解析层没产出 effect，运行时**照样可能加威力**。
  · `762 小型打劫`「敌方队伍中所有精灵失去1能量。」台账判 `PARTIAL`（`SETTLED_PATTERNS` 缺「扣能」类），
    但它**真发** `foe_team_energy_loss` ⇒ 需要运行时报据判定 306 基线这一行是不是陈旧的。

**控件（缺一不可）**：
  · 正对照 `313 天旋地转`(+30) / `581 电弧`(+40)`：台账说这两条**已接线** ⇒ 夹具必须量到迸发加成，
    否则「584 没加成」可能只是夹具没触发。
  · `762` 用**两条独立通道**互证：`foe_team_energy_loss` 事件数 **与** 敌方全队能量实际下降量。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-584-and-762-runtime.py [--json PATH]
退出码: 0 = 取证完成（读数照实打印，不预设对错）；1 = 夹具全废。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import parse as P  # noqa: E402

OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "verifier 584/762 取证", "microcase_id": "MC-E05"}]
POOL = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086",
        "pet_000127", "pet_000013", "pet_000550", "pet_000225", "pet_000190",
        "pet_000445", "pet_000417", "pet_000124", "pet_000003", "pet_000004",
        "pet_000008", "pet_000011", "pet_000025", "pet_000047", "pet_000072"]

ROWS = [
    ("skill_000584", "被降档的那条：迸发 威力+20（power 35）"),
    ("skill_000313", "正对照：迸发 威力+30（台账说已接线，power 60）"),
    ("skill_000581", "正对照：迸发 威力+40（台账说已接线，power 80）"),
    ("skill_000583", "同族：迸发 能耗-2（台账说没产出，power 90）"),
    ("skill_000598", "同族：迸发 使用次数+1（台账说没产出，power 50）"),
    ("skill_000762", "SETTLED 缺「扣能」：敌方全队 -1 能量"),
    ("skill_000273", "CAND 族：回复生命（判据未翻正、unsettled 为空）"),
    ("skill_000344", "CAND 族：同上"),
    ("skill_000346", "CAND 族：同上"),
    ("skill_000472", "CAND 族：同上"),
    ("skill_000756", "CAND 族：同上"),
]


def base_power_of(rs, sid):
    return getattr(rs.skills.get(sid), "power", None) or 0


def run(rs, sid):
    sk = rs.skills.get(sid)
    if sk is None:
        return {"skill_id": sid, "fixture": "no_skill"}
    pid = next((p for p in sorted(rs.pets) if rs.is_learnable(p, sid)), None)
    if pid is None:
        return {"skill_id": sid, "fixture": "no_learner"}
    moves = tuple([sid] + [x for x in sorted(rs.learnsets[pid].all_skill_ids)
                           if x in rs.skills and x != sid][:3])
    team_a = [pid] + [p for p in POOL if p != pid][:5]
    team_b = [p for p in sorted(rs.pets) if p not in team_a][:6]
    st = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                 loadouts={pid: moves}, unverified_overrides=OVR)
    mine = [a for a in E.legal_actions(st, rs, "player") if getattr(a, "skill_id", None) == sid]
    if not mine:
        return {"skill_id": sid, "fixture": "skill_not_legal", "learner": pid, "moves": list(moves)}
    legal_foe = E.legal_actions(st, rs, "enemy")
    foe = next((a for a in legal_foe if getattr(a, "kind", "") == "charge"), legal_foe[0])
    pet = st.player.field_pet
    burst_before = getattr(pet, "_burst_active", None)
    energy_before = getattr(pet, "energy", None)
    enemy_energy_before = [getattr(p, "energy", None) for p in st.enemy.pets]
    hp_before = getattr(pet, "hp", None)
    after = E.step_joint(st, rs, mine[0], foe)
    events = [e.to_dict() for e in after.events]
    dmg = [e["detail"] for e in events
           if e.get("kind") == "damage" and e["detail"].get("skill_id") == sid]
    base = base_power_of(rs, sid)
    used = max([d.get("power_used") or 0 for d in dmg] or [0])
    parsed = P.parse_skill(sk)
    effects = [getattr(e, "kind", "") for e in (getattr(parsed, "effects", None) or [])]
    gaps = {
        "respond_clause_gaps": C.respond_clause_gaps(sk, parsed),
        "compound_clause_gaps": C.compound_clause_gaps(sk, parsed),
        "diagnostic_shape_gaps": C.diagnostic_shape_gaps(sk, parsed),
        "residual_spans": C.residual_mechanic_spans(sk, parsed,
                                                    C.claimed_mechanic_words(parsed, C._flags_of(None))),
    }
    return {
        "skill_id": sid, "name": getattr(sk, "name", ""), "desc": str(getattr(sk, "desc", "")),
        "category": getattr(sk, "category", None), "learner": pid,
        "base_power": base,
        "burst_active_before_step": burst_before,
        "power_used": used,
        "burst_bonus_applied": bool(base and used > base),
        "conditional_reason": next((d.get("conditional_reason") for d in dmg
                                    if d.get("conditional_reason")), None),
        "parsed_effects": effects,
        "energy_before": energy_before,
        "energy_after": getattr(after.player.field_pet, "energy", None),
        "hp_before": hp_before, "hp_after": getattr(after.player.field_pet, "hp", None),
        "enemy_energy_before": enemy_energy_before,
        "enemy_energy_after": [getattr(p, "energy", None) for p in after.enemy.pets],
        "event_kinds": [e.get("kind") for e in events],
        "foe_team_energy_loss_events": sum(1 for e in events
                                           if e.get("kind") == "foe_team_energy_loss"),
        "heal_events": sum(1 for e in events if e.get("kind") == "heal"),
        "energy_gain_events": sum(1 for e in events if e.get("kind") == "energy_gain"),
        "unsupported": [str(x) for x in (getattr(after, "unsupported", None) or [])],
        "gaps": gaps,
        "tier_now": C.classify_skill_declared(sk).get("support"),
        "verdict_resolved": bool(C.settlement_verdict(sk)["resolved"]),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="json_path", default=None)
    args = ap.parse_args()
    rs = D.load_ruleset()
    out = []
    for sid, why in ROWS:
        r = run(rs, sid)
        r["why_row"] = why
        out.append(r)
        print("ROW " + json.dumps(r, ensure_ascii=False, default=str))
    print()
    # ── 控件与判读（只登记，不预设结论）──
    ctl = {r["skill_id"]: r for r in out}
    print("CONTROL 313_burst_applied", ctl.get("skill_000313", {}).get("burst_bonus_applied"))
    print("CONTROL 581_burst_applied", ctl.get("skill_000581", {}).get("burst_bonus_applied"))
    print("CONTROL 584_burst_applied", ctl.get("skill_000584", {}).get("burst_bonus_applied"))
    print("CONTROL 762_event_and_energy_drop",
          {"events": ctl.get("skill_000762", {}).get("foe_team_energy_loss_events"),
           "before": ctl.get("skill_000762", {}).get("enemy_energy_before"),
           "after": ctl.get("skill_000762", {}).get("enemy_energy_after")})
    verdict_ok = all(r.get("fixture") is None for r in out)
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2, default=str)
        print(f"WROTE {args.json_path}")
    return 0 if verdict_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
