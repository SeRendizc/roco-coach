#!/usr/bin/env python3
"""独立验收用的 **缺陷 B（SETTLED_PATTERNS 补类）复验**（harness-verifier 自建）。

Lead 授权 plan00-closer 补「回复生命 / 回能 / 吸取能量 / 扣能」类。本探针验四件事：
  1. **恰好 6 行变化、零旁及**（对照改前全量快照 `readings-78766db-all.json`）；
  2. 那 6 行 **`settled` 非空**（不是只翻 `resolved` 标志）；
  3. `totals 306` · `union 0` · 关闸反证 `5`；
  4. **反例（防补类过宽）**：改前「有目标类效果但判未结算」的行**必须仍判未结算**；
     另加 `269 吞噬`（描述声称「回复6能量」但 `effects=[]`）——真打一手证明**零事件**。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-defectB-settled-classes.py \
        --baseline <改前快照.json> [--runtime]
退出码: 0 = 四项全过；3 = 有失败（逐条打印）；2 = 用法错误。
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
from roco_env import service as S  # noqa: E402

SIM = (C.SUPPORT_SIMULATABLE_UNVERIFIED, C.SUPPORT_FULL_VERIFIED)
EXPECTED_FLIP = {"skill_000273", "skill_000344", "skill_000346",
                 "skill_000472", "skill_000756", "skill_000762"}
TARGET_KINDS = {"heal", "self_energy", "drain_energy", "foe_team_energy_loss"}
TARGET_WATCH = ("heal", "energy_gain", "drain_energy", "foe_team_energy_loss")
CENSUS = ("tests/data/pets100-skills-census.json",
          "roco/tests/data/pets100-skills-census.json")
OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "verifier 缺陷B反例", "microcase_id": "MC-E05"}]
POOL = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086",
        "pet_000127", "pet_000013", "pet_000550", "pet_000225", "pet_000190",
        "pet_000445", "pet_000417", "pet_000124", "pet_000003", "pet_000004"]


def read_all(svc, rs, ids):
    out = {}
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        v = C.settlement_verdict(sk)
        out[sid] = {"tier": svc._skill_record(rs, sk, with_tier=True)["support_tier"],
                    "resolved": bool(v["resolved"]),
                    "settled": list(v.get("settled") or []),
                    "unsettled": [str(x) for x in (v.get("unsettled") or [])],
                    "effects": sorted({getattr(e, "kind", "") for e in
                                       (getattr(v.get("parsed"), "effects", None) or [])})}
    return out


def census_ids():
    for path in CENSUS:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return sorted({r["skill_id"] for r in json.load(fh)["rows"]})
    return []


def union_count(svc, rs, ids):
    bad = []
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        tier = svc._skill_record(rs, sk, with_tier=True)["support_tier"]
        if (tier in SIM) != bool(C.settlement_verdict(sk)["resolved"]):
            bad.append(sid)
    return bad


def gates_off(svc, rs, ids):
    g, w = C.respond_clause_gaps, C.UNSETTLED_WORDS
    try:
        C.respond_clause_gaps = lambda skill, parsed: []
        C.UNSETTLED_WORDS = ()
        return union_count(svc, rs, ids)
    finally:
        C.respond_clause_gaps, C.UNSETTLED_WORDS = g, w


GUARD_RUNTIME = ["skill_000269", "skill_000366", "skill_000369", "skill_000537",
                 "skill_000745", "skill_000760", "skill_000793"]


def runtime_zero_events(rs, sid):
    """真打一手：**只统计归因给本技能的事件**（`detail.skill_id == sid` 或副作用在己方）。

    ⚠ 归因很重要：12 组里总会有 1 组敌方技能 `skill_000378` 自己回能 —— 那不是被测技能的产出
    （第一版就是把它误当成「被测技能有事」）。
    """
    sk = rs.skills.get(sid)
    if sk is None:
        return {"fixture": "no_skill"}
    pid = next((p for p in sorted(rs.pets) if rs.is_learnable(p, sid)), None)
    if pid is None:
        return {"fixture": "no_learner"}
    moves = tuple([sid] + [x for x in sorted(rs.learnsets[pid].all_skill_ids)
                           if x in rs.skills and x != sid][:3])
    team_a = [pid] + [p for p in POOL if p != pid][:5]
    team_b = [p for p in sorted(rs.pets) if p not in team_a][:6]
    base = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                   loadouts={pid: moves}, unverified_overrides=OVR)
    foe_actions = E.legal_actions(base, rs, "enemy")
    attributed, tried, kinds = [], 0, []
    for fa in foe_actions:
        st = E.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                     loadouts={pid: moves}, unverified_overrides=OVR)
        mine = [a for a in E.legal_actions(st, rs, "player") if getattr(a, "skill_id", None) == sid]
        if not mine:
            continue
        after = E.step_joint(st, rs, mine[0], fa)
        tried += 1
        evs = [e.to_dict() for e in after.events]
        kinds.append(",".join(e.get("kind") for e in evs)[:70])
        for d in evs:
            det = d.get("detail") or {}
            if d.get("kind") not in TARGET_WATCH:
                continue
            if det.get("skill_id") == sid or det.get("side") == "player":
                attributed.append({"kind": d["kind"], **{k: det.get(k) for k in
                                                         ("side", "skill_id", "amount", "healed")}})
    return {"skill_id": sid, "desc": str(getattr(sk, "desc", "")), "tried": tried,
            "attributed_events": attributed, "sample_event_kinds": kinds[:2]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--runtime", action="store_true")
    args = ap.parse_args(argv)

    rs = D.load_ruleset()
    svc = S.RocoService()
    with open(args.baseline, encoding="utf-8") as fh:
        snap = json.load(fh)
    before = snap["rows"]
    print(f"BASELINE_SNAPSHOT {args.baseline} stamp={json.dumps(snap.get('stamp'), ensure_ascii=False)}")

    ids = sorted((C.build_coverage(rs).get("skills") or {}))
    now = read_all(svc, rs, ids)
    fails = []

    changed = sorted(sid for sid in ids
                     if sid in before and (
                         before[sid]["tier"] != now[sid]["tier"]
                         or before[sid]["resolved"] != now[sid]["resolved"]))
    # `settled` 列表变化（只应「多标注」、不应带动 tier/resolved）
    settled_changed = sorted(sid for sid in ids
                             if sid in before
                             and sorted(before[sid].get("settled") or []) != sorted(now[sid]["settled"]))
    settled_only = [sid for sid in settled_changed if sid not in changed]
    print(f"SETTLED_CHANGED_ROWS {len(settled_changed)}（其中未带动 tier/resolved 的 {len(settled_only)}）")
    for sid in settled_changed[:50]:
        print(f"   {sid} settled {before[sid].get('settled')} -> {now[sid]['settled']} "
              f"| tier_resolved_changed={sid in changed}")
    print(f"CHANGED_ROWS {len(changed)} -> {changed}")
    print(f"EXPECTED      {len(EXPECTED_FLIP)} -> {sorted(EXPECTED_FLIP)}")
    if set(changed) != EXPECTED_FLIP:
        fails.append(f"变化行集合 != 期望 6 行：多 {sorted(set(changed) - EXPECTED_FLIP)} / "
                     f"少 {sorted(EXPECTED_FLIP - set(changed))}")

    for sid in sorted(EXPECTED_FLIP):
        r = now.get(sid) or {}
        print(f"  {sid} tier={r.get('tier')} resolved={r.get('resolved')} "
              f"settled={r.get('settled')} unsettled={r.get('unsettled')}")
        if not r.get("resolved"):
            fails.append(f"{sid}: 未翻正")
        if not r.get("settled"):
            fails.append(f"{sid}: settled 仍为空 ⇒ 只翻了标志，没真补类（消费方要求 settled 非空）")
        if r.get("tier") not in SIM:
            fails.append(f"{sid}: 档位未回到 SIM（{r.get('tier')}）")

    # 反例 1：改前「有目标类效果但未结算」的行必须仍未被翻正
    guard = [sid for sid in ids if sid in before
             and not before[sid]["resolved"]
             and set(before[sid].get("effects") or ()) & TARGET_KINDS
             and sid not in EXPECTED_FLIP]
    wrong = [sid for sid in guard if now[sid]["resolved"]]
    print(f"GUARD_ROWS（改前有目标类效果但未结算）{len(guard)} -> 被误翻正 {len(wrong)} {wrong[:8]}")
    if wrong:
        fails.append(f"补类过宽：{len(wrong)} 行被顺带翻正 {wrong[:8]}")
    # 反例 1b：改前「未结算且 unsettled 非空」的行必须仍未结算（覆盖面最大的一条）
    guard_b = [sid for sid in ids if sid in before
               and not before[sid]["resolved"]
               and (before[sid].get("unsettled") or [])
               and sid not in EXPECTED_FLIP]
    wrong_b = [sid for sid in guard_b if now[sid]["resolved"]]
    print(f"GUARD_ROWS_B（改前未结算且 unsettled 非空）{len(guard_b)} -> 被误翻正 {len(wrong_b)} "
          f"{wrong_b[:8]}")
    if wrong_b:
        fails.append(f"补类过宽（unsettled 非空组）：{len(wrong_b)} 行被翻正 {wrong_b[:8]}")

    # 反例 2：`269 吞噬`（描述声称回复，effects=[]）必须仍未结算
    if "skill_000269" in now:
        r269 = now["skill_000269"]
        print(f"GUARD 269 吞噬 resolved={r269['resolved']} unsettled={r269['unsettled']} "
              f"effects={r269['effects']}")
        if r269["resolved"]:
            fails.append("269 吞噬：描述声称回能但解析无效果/无事件，却被翻正 ⇒ 补类过宽")

    totals = C.build_coverage(rs)["totals"]["simulatable_entities"]
    union = union_count(svc, rs, census_ids())
    off = gates_off(svc, rs, census_ids())
    print(f"TOTALS {totals}（期望 306）")
    print(f"UNION_MISMATCHES {len(union)} {union[:6]}（期望 0）")
    print(f"GATES_OFF_COUNT {len(off)} {off[:6]}（期望 5）")
    if totals != 306:
        fails.append(f"totals {totals} != 306")
    if union:
        fails.append(f"并集打架 {len(union)} 条")
    if len(off) != 5:
        fails.append(f"关闸反证 {len(off)} != 5")

    if args.runtime:
        for sid in GUARD_RUNTIME:
            r = runtime_zero_events(rs, sid)
            print(f"RUNTIME_GUARD {json.dumps(r, ensure_ascii=False, default=str)}")
            if r.get("attributed_events"):
                fails.append(f"{sid} 竟然发了归因给自己的回能/回复事件 {r['attributed_events'][:3]} "
                             f"⇒ 「零事件」前提动摇，需重新取证")
            elif r.get("tried", 0) == 0:
                fails.append(f"{sid}: 一次都没打出来（夹具无效）")

    print(f"DEFECT_B_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
