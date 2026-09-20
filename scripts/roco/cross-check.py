#!/usr/bin/env python3
"""M1 交叉核验：主快照（wiki-rocom-snapshot）vs NRC_AI SQLite（独立来源）。

边界：
  - 只读 SQLite（标准库 sqlite3），不执行任何第三方 Python。
  - 不覆盖任何一方数据；不一致一律写入 reports/roco/m1-data/cross-check.json，
    由 importer 汇总进 data/roco/conflicts.jsonl。
  - NRC_AI 快照为 2026-04，早于 S4（2026-09-10），所以 S4 新精灵必然缺席。
    缺席记为 not_present_in_cross_source，**不是**冲突，也不补数据。
"""

import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "data/roco/raw/extracted/NRC_AI/data/nrc.db")
NORM = os.path.join(ROOT, "data/roco/normalized/roco-world-s4-2026-09-10/pets.json")
OUT = os.path.join(ROOT, "reports/roco/m1-data/cross-check.json")

STAT_MAP = {
    "hp": "base_hp",
    "atk": "base_atk",
    "def": "base_def",
    "spa": "base_spatk",
    "spd": "base_spdef",
    "spe": "base_speed",
}


def main():
    with open(NORM, encoding="utf-8") as fh:
        norm = json.load(fh)
    pets = norm["pets"]

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    rows = cur.execute(
        "SELECT name, element, base_hp, base_atk, base_def, base_spatk, base_spdef, base_speed "
        "FROM pokemon"
    ).fetchall()
    by_name = {}
    for r in rows:
        by_name.setdefault(r["name"], []).append(dict(r))

    results = []
    for pet_id, pet in sorted(pets.items(), key=lambda kv: kv[1]["target"]["order"]):
        name = pet["name"]
        entry = {
            "pet_id": pet_id,
            "name": name,
            "title": pet["title"],
            "target_group": pet["target"]["group"],
            "status": None,
            "differences": [],
            "primary": {
                "types": pet["types"],
                "stats": pet["stats"],
                "game_id": pet["game_id"],
            },
            "cross_source": None,
        }
        cand = by_name.get(name)
        if not cand:
            entry["status"] = "not_present_in_cross_source"
            entry["reason"] = (
                "NRC_AI 快照为 2026-04，晚出的 S4 精灵不在其中；"
                "该精灵本轮只有单一来源，不能声明交叉核验通过。"
            )
            results.append(entry)
            continue
        if len(cand) > 1:
            entry["differences"].append(
                {
                    "field": "name",
                    "kind": "same_name_multiple_records_in_cross_source",
                    "detail": f"交叉来源有 {len(cand)} 条同名记录",
                    "cross_values": cand,
                }
            )
        x = cand[0]
        entry["cross_source"] = {
            "element": x["element"],
            "stats": {k: x[v] for k, v in STAT_MAP.items()},
        }

        # 属性比对：主快照是 "火系"/"虫系"，交叉来源是单字符串，可能用 "火"/"虫" 或 "火系"
        primary_types = [t.replace("系", "") for t in pet["types"]]
        cross_elems = [e.strip().replace("系", "") for e in (x["element"] or "").replace("/", "|").split("|") if e.strip()]
        if sorted(primary_types) != sorted(cross_elems):
            entry["differences"].append(
                {
                    "field": "types",
                    "kind": "value_mismatch",
                    "primary": pet["types"],
                    "cross_source": x["element"],
                    "note": "两边属性集合不同。不取平均、不覆盖；两条都保留待人工核验。",
                }
            )

        # 种族值比对
        for k, col in STAT_MAP.items():
            pv = pet["stats"].get(k)
            xv = x[col]
            if pv is not None and xv is not None and pv != xv:
                entry["differences"].append(
                    {
                        "field": f"stats.{k}",
                        "kind": "value_mismatch",
                        "primary": pv,
                        "cross_source": xv,
                        "delta": pv - xv,
                    }
                )

        entry["status"] = "cross_checked_with_differences" if entry["differences"] else "cross_checked_match"
        results.append(entry)

    summary = {
        "match": sum(1 for r in results if r["status"] == "cross_checked_match"),
        "with_differences": sum(1 for r in results if r["status"] == "cross_checked_with_differences"),
        "not_present_in_cross_source": sum(1 for r in results if r["status"] == "not_present_in_cross_source"),
    }

    payload = {
        "primary_source": {
            "source_id": "wiki-rocom-snapshot",
            "revision": "aff808eb60003457fe8a260d1ac3c9bd95d53872",
        },
        "cross_source": {
            "source_id": "nrc-ai-sqlite",
            "revision": "9b5801b08d349c6505a233c513faa5075f427035",
            "snapshot_period": "2026-04",
            "license_note": "MIT 覆盖仓库代码；上游数据权利未声明，故此来源仅作核验，标 REFERENCE_ONLY。",
        },
        "summary": summary,
        "results": results,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"cross-check: match={summary['match']} with_differences={summary['with_differences']} "
          f"not_present={summary['not_present_in_cross_source']}")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
