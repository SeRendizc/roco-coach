#!/usr/bin/env python3
"""独立验收用的 **427 并集打架 + 台账 totals** 探针（harness-verifier 自建）。

刻意**不复用**实现者的脚本：自己读 census、自己算两把尺子、自己分类方向。
口径（与判据 `test_tier_verdict_agreement` 同源，但代码独立书写）：
  · 档位 = service.RocoService()._skill_record(rs, skill, with_tier=True)["support_tier"]
  · 判据 = coverage.settlement_verdict(skill)["resolved"]
  · 打架 = (档位 in (SIMULATABLE_UNVERIFIED, FULL_VERIFIED)) != 判据
用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-union-totals.py [--dump]
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import service as S  # noqa: E402

CENSUS_CANDIDATES = (
    os.path.join("tests", "data", "pets100-skills-census.json"),
    os.path.join("roco", "tests", "data", "pets100-skills-census.json"),
)


def census_ids() -> list[str]:
    for path in CENSUS_CANDIDATES:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                rows = json.load(fh)["rows"]
            return sorted({row["skill_id"] for row in rows})
    raise SystemExit("census 找不到")


def main(argv: list[str]) -> int:
    dump = "--dump" in argv
    import hashlib
    for mod in (C, S, D):
        path = getattr(mod, "__file__", None)
        if path and os.path.exists(path):
            with open(path, "rb") as fh:
                print(f"STAMP {os.path.basename(path)} {hashlib.sha256(fh.read()).hexdigest()} {path}")
    rs = D.load_ruleset()
    svc = S.RocoService()
    sim = (C.SUPPORT_SIMULATABLE_UNVERIFIED, C.SUPPORT_FULL_VERIFIED)
    ids = census_ids()
    bad = []
    rows = []
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        tier = svc._skill_record(rs, sk, with_tier=True)["support_tier"]
        v = C.settlement_verdict(sk)
        resolved = bool(v["resolved"])
        tier_sim = tier in sim
        rows.append((sid, tier, resolved))
        if tier_sim != resolved:
            direction = "判据 true / 档位 " + str(tier) if resolved else "判据 false / 档位 " + str(tier)
            bad.append((sid, direction, list(v.get("unsettled") or [])))
    print(f"census_ids={len(ids)} union_mismatches={len(bad)}")
    for sid, direction, unsettled in bad:
        print(f"  MISMATCH {sid} | {direction} | unsettled={unsettled}")
    totals = C.build_coverage(rs)["totals"]
    print(f"totals.simulatable_entities={totals.get('simulatable_entities')} "
          f"totals.keys={sorted(totals)}")
    if dump:
        for sid, tier, resolved in rows:
            print(f"  ROW {sid} tier={tier} resolved={resolved}")
    return 0 if not bad else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
