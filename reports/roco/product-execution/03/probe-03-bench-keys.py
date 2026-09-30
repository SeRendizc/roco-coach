"""03.1 只读探针 #2（G9 取证）：**无预览**局里，对手后备行各面到底有哪些键。

用法（WSL，仓库根）：
    PYTHONPATH=roco/src python3 /mnt/e/roco-scratch/plan03/bench-keys-no-preview.py
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


def row_keys(bench):
    return sorted(bench[0].keys()) if bench else []


def main() -> int:
    svc = RocoService()
    out = {}
    for label, preview in (("no_preview", False), ("with_preview", True)):
        status, env0 = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                       "enemy_team": B_TEAM, "seed": 5, "state_version": 0,
                                       "opening_preview": preview})
        result = env0["result"]
        state = renv.deserialize(result["state"], RS)
        ui = renv.ui_public_view(state, RS, "player")
        pub = renv.public_planner_state(state, RS, "player")
        obs = rschema.observation_for(state, RS, "player")
        out[label] = {
            "status": status,
            "turn": state.turn,
            "has_opening_reveal_key": "opening_reveal" in result,
            "ui_bench_row_keys": row_keys((ui.get("opponent") or {}).get("bench")),
            "ui_bench_n": len((ui.get("opponent") or {}).get("bench") or []),
            "public_bench_row_keys": row_keys((pub.get("opponent") or {}).get("bench")),
            "public_bench_n": len((pub.get("opponent") or {}).get("bench") or []),
            "obs_opponent_keys": sorted((obs.get("opponent") or {}).keys()),
            "obs_pets_row_keys": sorted(((obs.get("opponent") or {}).get("pets") or [{}])[0].keys()),
            "public_revealed_key_present": "revealed" in (pub.get("opponent") or {}),
            "ui_revealed_key_present": "revealed" in (ui.get("opponent") or {}),
            "ui_bench_sample": (ui.get("opponent") or {}).get("bench"),
            "public_bench_sample": (pub.get("opponent") or {}).get("bench"),
        }
    print(json.dumps(out, ensure_ascii=True, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
