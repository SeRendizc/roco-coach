#!/usr/bin/env python3
"""独立验收用的 **族② 分句级复核**（harness-verifier 自建，对 `plan00-family2.md` 的逐条断言）。

它**不复述**实现者的表格，而是自己重算三件事：
  1. 579 条战斗技能里，**前缀正则** `RESPOND_POWER_SETTLED_RE` 命中描述的到底有几条（实现者称 12）；
  2. 这 12 条的**分句**里，有几条是「整条就是已结算形状」（实现者称 11，只有 398 不是）；
  3. 这 12 条在 **306 真基线**里的档位 vs 现在的档位（实现者称只有 398 换档）。

`_CLAUSE_SPLIT_RE` 是 `[，。；]`；本脚本**同时**打印用它切出来的分句与命中情况，
便于核对；谓词用**我自己的**正则（与实现者同语义但独立书写）+ 直接调用实现者谓词对照。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-family2-clauses.py
    # 更强的口径：拿**改前**全量读数快照（579 行）当对照，判定「哪些行在本次收窄中换了档」
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-family2-clauses.py --pre /tmp/rd-83ed968-all.json
退出码: 0 = 三项都与实现者声明一致；3 = 有不一致（逐条打印）。
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

BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                        "reports", "roco", "rc401", "effect-coverage.json")
# 我自己的「整条已结算」正则（独立书写，不 import 实现者的）
MY_FULL = re.compile(r"应对(?:状态|攻击|防御)?\s*[:：]\s*本次技能威力\s*(?:变为|改为)?\s*"
                     r"(?:\d+(?:\.\d+)?\s*倍|翻倍)")
MY_PREFIX = re.compile(r"应对(?:状态|攻击|防御)?\s*[:：]\s*本次技能威力")
SPLIT = re.compile(r"[，。；]")
SIM = ("SIMULATABLE_UNVERIFIED", "FULL_VERIFIED")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pre", default=None, help="改前全量读数快照（verify-readings.py --all --dump）")
    args = ap.parse_args()
    pre_rows = {}
    if args.pre:
        with open(args.pre, encoding="utf-8") as fh:
            pre = json.load(fh)
        pre_rows = pre.get("rows") or {}
        print(f"PRE {args.pre} stamp={json.dumps(pre.get('stamp'), ensure_ascii=False)}")
    rs = D.load_ruleset()
    with open(BASELINE, encoding="utf-8") as fh:
        base = json.load(fh)["skills"]
    report = C.build_coverage(rs)
    ids = sorted((report.get("skills") or {}))
    rows = []
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        desc = str(getattr(sk, "desc", "") or "")
        if not MY_PREFIX.search(desc):
            continue
        clauses = [c.strip() for c in SPLIT.split(desc) if c.strip()]
        my_hits = [c for c in clauses if MY_FULL.fullmatch(c)]
        impl_hits = [c for c in clauses if C._is_settled_respond_power_clause(c)]
        tier_now = report["skills"][sid]["support"]
        tier_base = base.get(sid, {}).get("support")
        tier_pre = (pre_rows.get(sid) or {}).get("tier")
        rows.append({
            "skill_id": sid, "name": getattr(sk, "name", ""), "desc": desc,
            "my_fullmatch_clauses": my_hits, "impl_fullmatch_clauses": impl_hits,
            "my_prefix_only": not my_hits, "tier_base": tier_base, "tier_now": tier_now,
            "tier_pre": tier_pre,
            "changed_vs_base": tier_base != tier_now,
            "changed_vs_pre": (tier_pre != tier_now) if tier_pre else None,
        })

    print(f"PREFIX_MATCHED_SKILLS {len(rows)}（实现者声明 12）")
    print(f"SKILLS_SCANNED {len(ids)}")
    full11 = [r for r in rows if r["my_fullmatch_clauses"]]
    prefix_only = [r for r in rows if not r["my_fullmatch_clauses"]]
    print(f"WHOLE_CLAUSE_SETTLED {len(full11)}（实现者声明 11）")
    print(f"PREFIX_ONLY {len(prefix_only)} -> {[r['skill_id'] for r in prefix_only]}（实现者声明只有 398）")
    for r in rows:
        print(f"\n{r['skill_id']} {r['name']} | base306={r['tier_base']} pre={r['tier_pre']} "
              f"now={r['tier_now']}")
        print(f"    desc={r['desc']}")
        print(f"    my_fullmatch={r['my_fullmatch_clauses']} impl_fullmatch={r['impl_fullmatch_clauses']}")

    mismatches = []
    if len(rows) != 12:
        mismatches.append(f"前缀命中行数 {len(rows)} != 12")
    if len(full11) != 11:
        mismatches.append(f"整条结算行数 {len(full11)} != 11")
    if [r["skill_id"] for r in prefix_only] != ["skill_000398"]:
        mismatches.append(f"仅前缀命中的行 = {[r['skill_id'] for r in prefix_only]} != ['skill_000398']")
    # 我的谓词与实现者谓词必须逐条一致（否则是「两把尺子」）
    for r in rows:
        if r["my_fullmatch_clauses"] != r["impl_fullmatch_clauses"]:
            mismatches.append(f"{r['skill_id']}: 我的谓词与本仓谓词判定不同 "
                              f"{r['my_fullmatch_clauses']} vs {r['impl_fullmatch_clauses']}")
    # 与 306 真基线的差异（登记；实现者的「换了档」是相对**改前工作树**说的）
    changed_base = [r["skill_id"] for r in rows if r["changed_vs_base"]]
    print(f"\nVS_306_BASELINE_CHANGED {changed_base}（登记用）")
    # 相对改前快照 —— 这才是「本次收窄真的生效」的判据
    if pre_rows:
        changed_pre = [r["skill_id"] for r in rows if r["changed_vs_pre"]]
        print(f"VS_PRE_SNAPSHOT_CHANGED {changed_pre}（实现者声明只有 skill_000398）")
        if changed_pre != ["skill_000398"]:
            mismatches.append(f"相对改前快照的换档行 = {changed_pre} != ['skill_000398']")
        r398 = next((r for r in rows if r["skill_id"] == "skill_000398"), None)
        if r398 and not (r398["tier_pre"] in SIM and r398["tier_now"] not in SIM):
            mismatches.append(f"398 相对改前方向不符：{r398['tier_pre']} -> {r398['tier_now']}")
    else:
        print("VS_PRE_SNAPSHOT_CHANGED <未提供 --pre，跳过>")
    print(f"\nDECLARATION_MISMATCHES {len(mismatches)}")
    for m in mismatches:
        print(f"  MISMATCH {m}")
    return 0 if not mismatches else 3


if __name__ == "__main__":
    raise SystemExit(main())
