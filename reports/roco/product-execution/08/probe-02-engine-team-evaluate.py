"""08.1 只读探针（引擎侧）：`/team/evaluate` 到底给什么、能不能当「同一把尺子」比两种配招。

用法（仓库根）：PYTHONPATH=roco/src python3 reports/roco/product-execution/08/probe-02-engine-team-evaluate.py
产出：raw-engine-team-evaluate.json
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "..", "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env.service import RocoService    # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


def keytree(node, depth=2):
    if depth <= 0:
        return type(node).__name__
    if isinstance(node, dict):
        return {k: keytree(v, depth - 1) for k, v in sorted(node.items())}
    if isinstance(node, list):
        return [keytree(node[0], depth - 1)] if node else []
    return type(node).__name__


def main() -> int:
    svc = RocoService()
    lead = A_TEAM[0]
    canonical = list(RS.candidate_moveset(lead))
    swapped = sorted(sid for sid in RS.learnsets[lead].all_skill_ids if sid not in canonical)[:1]
    alt = canonical[:-1] + swapped if swapped else canonical

    base_status, base_env = svc.team_evaluate({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                               "state_version": 0})
    alt_status, alt_env = svc.team_evaluate({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                             "loadouts": {lead: alt}, "state_version": 0})

    base = base_env.get("result")
    alt = alt_env.get("result")

    def shallow_diff(a, b):
        """顶层逐键：相同 / 不同（只为「同一把尺子」这一问给读数，不做深比较）。"""
        if not isinstance(a, dict) or not isinstance(b, dict):
            return None
        out = {}
        for key in sorted(set(a) | set(b)):
            out[key] = "same" if a.get(key) == b.get(key) else "different"
        return out

    out = {
        "base_status": base_status,
        "alt_status": alt_status,
        "base_result_keys": sorted(base.keys()) if isinstance(base, dict) else None,
        "alt_result_keys": sorted(alt.keys()) if isinstance(alt, dict) else None,
        "result_shape": keytree(base) if isinstance(base, dict) else None,
        "top_level_diff": shallow_diff(base, alt),
        "same_response_when_only_loadout_changes": json.dumps(base, ensure_ascii=False, sort_keys=True)
        == json.dumps(alt, ensure_ascii=False, sort_keys=True),
        "base_features": (base or {}).get("features"),
        "alt_features": (alt or {}).get("features"),
        "base_strengths": (base or {}).get("strengths"),
        "alt_strengths": (alt or {}).get("strengths"),
        "base_weaknesses": (base or {}).get("weaknesses"),
        "alt_weaknesses": (alt or {}).get("weaknesses"),
        "lead_skill_before": canonical,
        "lead_skill_after": alt,
        "limitations": (base_env.get("limitations") if isinstance(base_env, dict) else None),
        "note": "只读：不写盘、不训练、不动 data/**",
    }
    with open(os.path.join(HERE, "raw-engine-team-evaluate.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    print(json.dumps({k: out[k] for k in ("base_status", "alt_status", "base_result_keys",
                                          "same_response_when_only_loadout_changes", "note")},
                     ensure_ascii=False, indent=1))
    print("WROTE raw-engine-team-evaluate.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
