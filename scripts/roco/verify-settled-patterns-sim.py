#!/usr/bin/env python3
"""**隔离进程内的模拟**（不改任何文件）：如果判据能认出「回复生命/回能/吸取能量/扣能」这 4 类已结算，
读数会怎么变？—— 把「修 `SETTLED_PATTERNS`」的后果从**推论**变成**测量**。

做法：只在本进程里包一层 `coverage.settlement_verdict` —— 当
  `resolved is False` 且 `unsettled == []` 且 解析效果里有 heal / self_energy / drain_energy /
  foe_team_energy_loss 之一时，判为已结算。
（这正是缺失的那几个 `SETTLED_PATTERNS` 类的作用；**不设计文本词表**，避免替实现者做设计。）

然后测四件事：totals · 产品档位 · 并集打架 · 关闸反证计数，外加**旁及行数**（有多少行被顺带翻正）。
用法:
    cd <隔离副本>/roco && PYTHONPATH=src python3 <本脚本>
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import service as S  # noqa: E402

WANT = {"heal", "self_energy", "drain_energy", "foe_team_energy_loss"}
CENSUS = ("tests/data/pets100-skills-census.json",
          "roco/tests/data/pets100-skills-census.json")
SIM = (C.SUPPORT_SIMULATABLE_UNVERIFIED, C.SUPPORT_FULL_VERIFIED)


def census_ids():
    for path in CENSUS:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return sorted({r["skill_id"] for r in json.load(fh)["rows"]})
    return []


def snapshot(svc, rs, ids):
    rows = {}
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        rows[sid] = {
            "tier": svc._skill_record(rs, sk, with_tier=True)["support_tier"],
            "resolved": bool(C.settlement_verdict(sk)["resolved"]),
        }
    return rows


def union_mismatches(svc, rs, ids):
    bad = []
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        tier = svc._skill_record(rs, sk, with_tier=True)["support_tier"]
        if (tier in SIM) != bool(C.settlement_verdict(sk)["resolved"]):
            bad.append(sid)
    return bad


def gates_off_count(svc, rs, ids):
    real_gaps, real_words = C.respond_clause_gaps, C.UNSETTLED_WORDS
    try:
        C.respond_clause_gaps = lambda skill, parsed: []
        C.UNSETTLED_WORDS = ()
        return union_mismatches(svc, rs, ids)
    finally:
        C.respond_clause_gaps, C.UNSETTLED_WORDS = real_gaps, real_words


def main() -> int:
    rs = D.load_ruleset()
    svc = S.RocoService()
    all_ids = sorted((C.build_coverage(rs).get("skills") or {}))
    union = census_ids()

    before_all = snapshot(svc, rs, all_ids)
    totals_before = C.build_coverage(rs)["totals"]["simulatable_entities"]
    union_before = union_mismatches(svc, rs, union)
    off_before = gates_off_count(svc, rs, union)

    real_verdict = C.settlement_verdict

    def patched(skill, *, declared=None):
        v = real_verdict(skill, declared=declared)
        if v["resolved"] or v.get("unsettled"):
            return v
        parsed = v.get("parsed")
        kinds = {getattr(e, "kind", "") for e in (getattr(parsed, "effects", None) or [])}
        if kinds & WANT:
            v = dict(v)
            v["resolved"] = True
        return v

    C.settlement_verdict = patched
    try:
        after_all = snapshot(svc, rs, all_ids)
        totals_after = C.build_coverage(rs)["totals"]["simulatable_entities"]
        union_after = union_mismatches(svc, rs, union)
        off_after = gates_off_count(svc, rs, union)
    finally:
        C.settlement_verdict = real_verdict

    changed = [sid for sid in all_ids if before_all[sid] != after_all[sid]]
    print("SIM_PATCH 4 类效果（heal/self_energy/drain_energy/foe_team_energy_loss）识别为已结算")
    print(f"TOTALS before={totals_before} after={totals_after}")
    print(f"UNION_MISMATCHES before={len(union_before)} after={len(union_after)} "
          f"{union_after[:8]}")
    print(f"GATES_OFF_COUNT before={len(off_before)} after={len(off_after)}")
    print(f"CHANGED_ROWS {len(changed)} -> {changed}")
    for sid in changed:
        print(f"   {sid}: {before_all[sid]} -> {after_all[sid]} "
              f"({rs.skills[sid].name if sid in rs.skills else '?'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
