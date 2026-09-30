"""只读探针：01.1 字段矩阵的**机器可读**读数（只写键树与极小的标识值，不写私有状态）。

产出：
  · `raw-field-matrix.json` —— 三条公开协议 + `serialize()`/`history` 的键树；
  · `raw-leg-receipt.json` —— **给 Node 那一跳**用的回执切片（**不含 `state`**，
    因为 `publicView` 本来就读不到它；这样证据里不落私有状态）。

用法（仓库根）：
  PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-09-field-matrix.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "..", "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env.service import RocoService    # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


def keytree(node, depth: int = 2):
    """键树：dict → 键；list → 只取第一个元素的形状（避免把整队展开）。"""
    if depth <= 0:
        return type(node).__name__
    if isinstance(node, dict):
        return {k: keytree(v, depth - 1) for k, v in sorted(node.items())}
    if isinstance(node, list):
        return [keytree(node[0], depth - 1)] if node else []
    return type(node).__name__


def main() -> int:
    svc = RocoService()
    status, envelope = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                       "enemy_team": B_TEAM, "seed": 5, "state_version": 0,
                                       "opening_preview": True})
    result = envelope["result"]
    # 推进一回合：让「已出招」这一类字段也出现在读数里
    action = next(a for a in result["legal"]["player"] if a["kind"] == "skill")
    status2, envelope2 = svc.battle_advance({"state": result["state"],
                                             "state_version": result["state_version"],
                                             "action": action})
    result2 = envelope2["result"]
    state = renv.deserialize(result2["state"], RS)

    out = {
        "battle_new_status": status,
        "battle_advance_status": status2,
        "rules_version": result2["rules_version"],
        "match_id": result2["match_id"],
        "decision_id": result2["decision_id"],
        "faces": {
            "public_planner_state": keytree(renv.public_planner_state(state, RS, "player")),
            "ui_public_view": keytree(renv.ui_public_view(state, RS, "player")),
            "observation_for": keytree(renv.observation_for(state, RS, "player")),
        },
        "private": {
            "serialize_top_keys": sorted(renv.serialize(state).keys()),
            "history_entry_keys": sorted(state.history[0].keys()) if state.history else [],
            "history_entries": len(state.history),
        },
        "receipt": {
            "top_keys": sorted(envelope2.keys()),
            "result_keys": sorted(result2.keys()),
        },
        "legs": {
            "python_public": "env.public_planner_state",
            "python_ui": "env.ui_public_view",
            "python_observation": "schema.observation_for（env.observe 转发）",
            "node_bridge_public": "src/server/roco-service.js plannerPublicOf → client.planActions",
            "node_view": "src/server/roco-service.js publicView",
            "client_context": "src/client/roco.js coachRocoBattle 快照",
            "coach_tool": "src/coach/toolbox.js / runtime.js",
            "session_cache": "src/server/roco-service.js sessions（match_id/battle_id/state_version/rules_version）",
            "replay": "env.replay(record.replay_plan())",
        },
    }
    with open(os.path.join(HERE, "raw-field-matrix.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")

    # 给 Node 那一跳的回执切片（**去掉 state**）：publicView 只读这些键
    leg = {k: v for k, v in result2.items() if k != "state"}
    with open(os.path.join(HERE, "raw-leg-receipt.json"), "w", encoding="utf-8") as fh:
        json.dump(leg, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")

    print(json.dumps({k: out[k] for k in ("match_id", "rules_version", "decision_id",
                                          "receipt", "private")}, ensure_ascii=False, indent=1)[:2500])
    print("WROTE raw-field-matrix.json / raw-leg-receipt.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
