#!/usr/bin/env python3
"""独立验收用的 **族② 运行时反例**（harness-verifier 自建，差分设计）。

要回答的（不复述实现者的话）：收窄「应对…：本次技能威力N倍」这条闸，**真的**抓到了一段
没结算的子句吗？还是把一条本来整条结算的技能误降了？

**差分夹具**（同一 seed、同一配招、同一只精灵，**只改敌方出什么招**）：
  · A 组：敌方出**状态**技 ⇒ 「应对状态」应对成功（`_respond_succeeded=True`）
  · B 组：敌方出**攻击**技 ⇒ 应对失败
两组对照 ⇒ 威力那半必须**只在 A 组**翻倍（控件：证明夹具真的触发了应对成功）。
再看「赋予灼烧翻倍」那半：`status_added.layers` 在 A/B 两组是否相同 ⇒
  · 相同 ⇒ 那半**零实现**（收窄成立，398 就是这样）
  · A 组更大 ⇒ 那半**真的结算了**（收窄就是误伤 ⇒ 报告）

控件（缺一不可）：
  `ctl_fixture_flips_power` = A 翻倍 且 B 不翻倍（夹具有效）
  `ctl_status_event_seen`  = 至少读到一条 `status_added`（层数探测器不是瞎的）

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-family2-runtime.py [skill_id ...]
退出码: 0 = 逐条判据成立；3 = 有反例不成立；1 = 夹具搭不起来。
"""
from __future__ import annotations

import copy
import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402

OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "verifier 族②差分反例",
        "microcase_id": "MC-E05"}]
POOL = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086",
        "pet_000127", "pet_000013", "pet_000550", "pet_000225", "pet_000190",
        "pet_000445", "pet_000417", "pet_000124", "pet_000003", "pet_000004",
        "pet_000008", "pet_000011", "pet_000025", "pet_000047", "pet_000072"]


def _holder(rs, exclude, want_status):
    for pid in sorted(rs.pets):
        if pid in exclude:
            continue
        for sid in sorted(rs.learnsets[pid].all_skill_ids):
            sk = rs.skills.get(sid)
            if sk is None or getattr(sk, "is_trait", False):
                continue
            if bool(getattr(sk, "is_status", False)) is want_status and (
                    want_status or getattr(sk, "power", None)):
                return pid, sid
    return None, None


def _run_case(rs, sid, want_status):
    """跑一组（敌方出状态技 A / 出攻击技 B）。"""
    sk = rs.skills[sid]
    pid = next((p for p in sorted(rs.pets) if rs.is_learnable(p, sid)), None)
    if pid is None:
        return None
    my_moves = [sid] + [x for x in sorted(rs.learnsets[pid].all_skill_ids)
                        if x in rs.skills and x != sid][:3]
    team_a = [pid] + [p for p in POOL if p != pid][:5]
    e_pid, e_skill = _holder(rs, set(team_a), want_status)
    team_b = [e_pid] + [p for p in sorted(rs.pets) if p not in team_a and p != e_pid][:5]
    st = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                 loadouts={pid: tuple(my_moves), e_pid: (e_skill,)}, unverified_overrides=OVR)
    mine = [a for a in E.legal_actions(st, rs, "player") if getattr(a, "skill_id", None) == sid]
    foe = [a for a in E.legal_actions(st, rs, "enemy") if getattr(a, "skill_id", None) == e_skill]
    if not mine or not foe:
        return {"fixture": "unbuildable", "mine": len(mine), "foe": len(foe)}
    after = E.step_joint(st, rs, mine[0], foe[0])
    events = [e.to_dict() for e in after.events]
    mine_dmg = [e["detail"] for e in events
                if e.get("kind") == "damage" and e["detail"].get("skill_id") == sid]
    added = [e["detail"] for e in events if e.get("kind") == "status_added"
             and e["detail"].get("side") == "enemy"]
    base_power = getattr(sk, "power", None) or 0
    used = max([d.get("power_used") or 0 for d in mine_dmg] or [0])
    return {
        "foe_pet": e_pid, "foe_skill": e_skill,
        "foe_skill_name": getattr(rs.skills.get(e_skill), "name", None),
        "foe_skill_is_status": bool(getattr(rs.skills.get(e_skill), "is_status", False)),
        "respond_succeeded": getattr(after.player.field_pet, "_respond_succeeded", None),
        "base_power": base_power, "power_used": used,
        "power_doubled": bool(base_power and used >= 1.9 * base_power),
        "conditional_reason": next((d.get("conditional_reason") for d in mine_dmg
                                    if d.get("conditional_reason")), None),
        "status_added": added,
        "layers": max([a.get("layers") or 0 for a in added] or [0]),
        "enemy_statuses_after": after.enemy.field_pet.statuses,
        "unsupported": list(getattr(after, "unsupported", None) or []),
        "event_kinds": [e.get("kind") for e in events],
    }


def main(argv=None) -> int:
    ids = [a for a in (argv if argv is not None else sys.argv[1:]) if a.startswith("skill_")]
    if not ids:
        ids = ["skill_000398", "skill_000255", "skill_000637"]
    rs = D.load_ruleset()
    fails = []
    for sid in ids:
        a = _run_case(rs, sid, want_status=True)     # 应对成功
        b = _run_case(rs, sid, want_status=False)    # 应对失败
        print("=" * 72)
        print(f"{sid} {getattr(rs.skills[sid], 'name', '')} | {getattr(rs.skills[sid], 'desc', '')}")
        print(f"  A(敌状态技) {json.dumps(a, ensure_ascii=False, default=str)}")
        print(f"  B(敌攻击技) {json.dumps(b, ensure_ascii=False, default=str)}")
        if not a or not b or a.get("fixture") == "unbuildable" or b.get("fixture") == "unbuildable":
            fails.append(f"{sid}: 夹具搭不起来 A={a} B={b}")
            continue
        ctl_flip = a["power_doubled"] and not b["power_doubled"]
        # 层数探测器的控件只在**该技能真的施加状态**时才有意义（398 就是被问的那一行）；
        # 255/637 整条就是威力形状、不施加状态 ⇒ 这一项 N/A，不是失败，也不静默跳过。
        needs_status_ctl = (sid == "skill_000398") or bool(a["status_added"])
        ctl_status = bool(a["status_added"]) if needs_status_ctl else None
        print(f"  ctl_fixture_flips_power={ctl_flip} "
              f"ctl_status_event_seen={ctl_status if ctl_status is not None else 'n/a(不施加状态)'} "
              f"layers A={a['layers']} B={b['layers']}")
        if not ctl_flip:
            fails.append(f"{sid}: 控件失败——A/B 没能把威力翻倍翻出来（A={a['power_used']} "
                         f"B={b['power_used']}，respond A={a['respond_succeeded']}）")
        if needs_status_ctl and not ctl_status:
            fails.append(f"{sid}: 控件失败——A 组没有 status_added ⇒ 层数探测器是瞎的")
            continue
        if sid == "skill_000398":
            if a["layers"] != b["layers"]:
                fails.append(f"{sid}: 「赋予灼烧翻倍」那半 A={a['layers']} B={b['layers']} "
                             f"⇒ 应对成功真的改了层数（收窄=误伤）")
        else:
            if not a["power_doubled"]:
                fails.append(f"{sid}: 整条形状却没翻倍 ⇒ 收窄可能误伤")
    print("=" * 72)
    print(f"RUNTIME_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
