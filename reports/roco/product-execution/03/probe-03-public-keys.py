"""03.1 只读探针（Q2 证据）：三条公开投影里「对手」那一块的**确切键路径**。

只读引擎、只打印键与形状（不落私有状态）。用法（WSL，仓库根）：
    PYTHONPATH=roco/src python3 /mnt/e/roco-scratch/plan03/public-keys-probe.py
"""
from __future__ import annotations

import json
import os
import sys

ROOT = "/mnt/e/roco-coach"
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import schema as rschema      # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


def shape(node, depth: int = 1):
    """键 → 类型名（list 只取第一个元素，dict 只下钻 depth 层）。"""
    if isinstance(node, dict):
        if depth <= 0:
            return "dict"
        return {k: shape(v, depth - 1) for k, v in sorted(node.items())}
    if isinstance(node, list):
        return [shape(node[0], depth - 1)] if node else []
    if isinstance(node, bool):
        return "bool"
    if isinstance(node, (int, float)):
        return "number"
    if node is None:
        return "null"
    return type(node).__name__


def scan_tokens(node, tokens, path="$"):
    """在整棵投影里找 token（用来证明 speed / speed_band 到底在不在公开面里）。"""
    hits = []
    stack = [(node, path)]
    while stack:
        cur, at = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                if any(t in str(k) for t in tokens):
                    hits.append(f"{at}.{k}")
                stack.append((v, f"{at}.{k}"))
        elif isinstance(cur, list):
            for i, v in enumerate(cur[:3]):
                stack.append((v, f"{at}[{i}]"))
        elif isinstance(cur, str):
            if any(t == cur for t in tokens):
                hits.append(f"{at}=<{cur}>")
    return sorted(hits)


def main() -> int:
    svc = RocoService()
    status, env0 = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                   "enemy_team": B_TEAM, "seed": 5, "state_version": 0,
                                   "opening_preview": True})
    result = env0["result"]
    action = next(a for a in result["legal"]["player"] if a["kind"] == "skill")
    status2, env1 = svc.battle_advance({"state": result["state"],
                                        "state_version": result["state_version"],
                                        "action": action})
    result2 = env1["result"]
    state = renv.deserialize(result2["state"], RS)

    ui = renv.ui_public_view(state, RS, "player")
    pub = renv.public_planner_state(state, RS, "player")
    obs = rschema.observation_for(state, RS, "player")

    def rows_of(doc, side_key="opponent"):
        side = doc.get(side_key) or {}
        field = side.get("field") or {}
        bench = side.get("bench") or []
        return {
            "side_keys": sorted(side.keys()),
            "field_keys": sorted(field.keys()),
            "field_shape": shape(field, 1),
            "bench_n": len(bench),
            "bench_row_keys": sorted(bench[0].keys()) if bench else [],
        }

    out = {
        "status_battle_new": status,
        "status_battle_advance": status2,
        "turn": state.turn,
        "ui_public_view.opponent": rows_of(ui),
        "public_planner_state.opponent": rows_of(pub),
        "observation_for.opponent": rows_of(obs),
        "observation_for.opponent.bench_row_keys": sorted((obs.get("opponent") or {}).get("pets", [{}])[0].keys())
        if isinstance((obs.get("opponent") or {}).get("pets"), list) else None,
        # 「哪些字段在公开面上」：三面各自扫描
        "token_scan": {
            "ui_public_view": {"speed": scan_tokens(ui, ["speed"]),
                               "speed_band": scan_tokens(ui, ["speed_band"])},
            "public_planner_state": {"speed": scan_tokens(pub, ["speed"]),
                                     "speed_band": scan_tokens(pub, ["speed_band"])},
            "observation_for": {"speed": scan_tokens(obs, ["speed"]),
                                "speed_band": scan_tokens(obs, ["speed_band"])},
        },
        # 公开面上对手场上那只是一份什么样的行（**只给键、不给个体真值**）
        "ui_opponent_field_keys": sorted((ui.get("opponent", {}).get("field") or {}).keys()),
        "public_opponent_field_keys": sorted((pub.get("opponent", {}).get("field") or {}).keys()),
        "obs_opponent_field_keys": sorted(((obs.get("opponent", {}).get("field") or {}) if
                                           isinstance(obs.get("opponent", {}).get("field"), dict) else {}).keys()),
        "observed_roster_n": len((ui.get("opponent", {}) or {}).get("revealed", {}).get("opponent_roster", []) or []),
        "revealed_skills_pets": sorted(((ui.get("opponent", {}) or {}).get("revealed", {}) or {})
                                       .get("opponent_skills", {}).keys())
        if isinstance(((ui.get("opponent", {}) or {}).get("revealed", {}) or {}).get("opponent_skills"), dict) else [],
    }
    print(json.dumps(out, ensure_ascii=True, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
