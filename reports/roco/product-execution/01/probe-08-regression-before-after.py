"""只读探针：回归产物重建**前后**的逐场景对照（分计划 01.3 的 state_digest 收窄）。

用法（仓库根）：
  PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-08-regression-before-after.py [before.json]

`before.json` 默认取 `reports/roco/product-execution/01/.work-backup/regression-set.before-01-3.json`
（**工作副本，不入库**）。产出：`raw-regression-before-after.json`。

要证明的三件事：
  1. 除 `state_digest`（口径变了）与新增的 `history_digest` 之外，**没有别的字段变**；
  2. 新 `state_digest`（剔除 history）与旧的「全量」指纹不同 —— 那正是口径变化本身；
  3. 旧产物没有 `history_digest`（所以 `--check` 会要求重建一次），重建后一致。
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BEFORE = os.path.join(HERE, ".work-backup", "regression-set.before-01-3.json")
AFTER = os.path.join("reports", "roco", "rc404", "regression-set.json")
OUT = os.path.join(HERE, "raw-regression-before-after.json")


def main() -> int:
    before_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BEFORE
    with open(before_path, "r", encoding="utf-8") as fh:
        before = json.load(fh)
    with open(AFTER, "r", encoding="utf-8") as fh:
        after = json.load(fh)

    old = {row["id"]: row for row in before["scenarios"]}
    new = {row["id"]: row for row in after["scenarios"]}
    per_scenario = {}
    fields_changed: dict = {}
    digest_changed = []
    for sid in sorted(set(old) & set(new)):
        changed = [key for key in sorted(set(old[sid]) | set(new[sid]))
                   if key not in ("state_digest", "history_digest")
                   and old[sid].get(key) != new[sid].get(key)]
        if changed:
            fields_changed[sid] = changed
        if old[sid]["state_digest"] != new[sid]["state_digest"]:
            digest_changed.append(sid)
        per_scenario[sid] = {
            "old_state_digest_wide": old[sid]["state_digest"],
            "new_state_digest_no_history": new[sid]["state_digest"],
            "new_history_digest": new[sid].get("history_digest"),
            "other_fields_changed": changed,
        }

    summary = {
        "before": before_path,
        "after": AFTER,
        "scenarios": len(per_scenario),
        "state_digest_moved": len(digest_changed),
        "other_fields_changed_scenarios": sorted(fields_changed),
        "old_artifact_had_history_digest": any("history_digest" in row for row in old.values()),
        "totals_unchanged": before.get("totals") == after.get("totals"),
        "problems_unchanged": before.get("problems") == after.get("problems"),
        "unreachable_unchanged": before.get("unreachable") == after.get("unreachable"),
        "dimensions_unchanged": before.get("dimensions") == after.get("dimensions"),
        "event_kinds_unchanged": all(old[sid]["event_kinds"] == new[sid]["event_kinds"] for sid in old),
        "why_unchanged": before.get("why") == after.get("why"),
    }
    payload = {"summary": summary, "per_scenario": per_scenario}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    print(json.dumps(summary, ensure_ascii=False, indent=1, sort_keys=True))
    print("WROTE", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
