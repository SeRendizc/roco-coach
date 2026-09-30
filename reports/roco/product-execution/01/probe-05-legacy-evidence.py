#!/usr/bin/env python3
"""分计划 01 证据探针：区分「引擎行为被改」与「观察载荷被改」。

跑法（同一支脚本跑两次：一次在改动前、一次在改动后）：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-05-legacy-evidence.py <标签>

输出四个互相独立的指纹，用来把「结算改变」与「观察载荷改变」分开：

  F1 decision_digest : 每一步双方实际选出的动作序列（**这是引擎行为**）
  F2 events_digest   : state.events（**结算产物**）
  F3 state_no_history: serialize() 但**剔除 history**（结算状态本体）
  F4 history_digest  : state.history（**决策前观察载荷** —— 预期只有它会变）
  F5 obs_digest      : 终局 observation_for(state, rs, "player")
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env import opponents as ropp
from roco_env import rule_config as rc
from roco_env import schema as rschema
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent
LABEL = sys.argv[1] if len(sys.argv) > 1 else "unlabeled"
ROSTER_IDS = ["pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000112",
              "pet_000062", "pet_000474", "pet_000451", "pet_000124", "pet_000608",
              "pet_000601", "pet_000611"]


def digest(obj) -> str:
    blob = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def main() -> int:
    rs = load_ruleset()
    # 与 test_turn_order_fail_closed.LegacyBitExactGoldenTest 的默认路径同形：
    # 不设 ROCO_RULE_CONFIG（legacy 默认），用 STRATEGIES 配对 play_match。
    for var in (rc.ENV_VAR,):
        import os
        os.environ.pop(var, None)
    rc.clear_cache()

    names = list(ropp.STRATEGIES.names())
    report: dict = {"label": LABEL, "legacy_default_config": rc.get_rule_config(None).ruleset_config_id,
                    "per_seed": {}}

    for index, seed in enumerate((1000, 1001, 1002, 1003, 1004, 1005)):
        team_a = [ROSTER_IDS[index % 12], ROSTER_IDS[(index + 1) % 12], ROSTER_IDS[(index + 2) % 12]]
        team_b = [ROSTER_IDS[(index + 3) % 12], ROSTER_IDS[(index + 4) % 12], ROSTER_IDS[(index + 5) % 12]]
        record = ropp.play_match(rs, team_a, team_b,
                                 names[index % len(names)],
                                 names[(index + 2) % len(names)], seed)
        state = renv.replay(record.replay_plan(), rs)
        serialized = renv.serialize(state)
        no_hist = {k: v for k, v in serialized.items() if k != "history"}
        report["per_seed"][str(seed)] = {
            "F1_decision_digest": digest(record.actions),
            "F2_events_digest": digest([e.to_dict() for e in state.events]),
            "F3_state_no_history_digest": digest(no_hist),
            "F4_history_digest": digest(state.history),
            "F5_obs_digest": digest(rschema.observation_for(state, rs, "player")),
            "actions_n": len(record.actions),
            "events_n": len(state.events),
            "history_n": len(state.history),
            "result": state.result,
            "turn": state.turn,
            "unsupported_n": len(state.unsupported),
        }

    # 短脚本局（test_short_scripted_game_is_bit_identical 的形状）
    def _fresh(seed: int):
        import roco_env.env as e
        st = e.reset(ROSTER_IDS[:3], ROSTER_IDS[3:6], seed=seed, rs=rs)
        return st

    st = _fresh(3)
    picks = []
    for _ in range(4):
        if st.result:
            break
        if st.phase == "replace":
            side = st.replace_queue[0]
            slot = getattr(st, side).bench_indices()[0]
            picks.append(["replace", side, slot])
            renv.step_replace(st, rs, side, slot)
            continue
        la = renv.legal_actions(st, rs, "player")
        lb = renv.legal_actions(st, rs, "enemy")
        pa, pb = la[0], lb[1 % len(lb)]
        picks.append([pa.to_dict(), pb.to_dict()])
        renv.step_joint(st, rs, pa, pb)
    serialized = renv.serialize(st)
    no_hist = {k: v for k, v in serialized.items() if k != "history"}
    report["short_scripted"] = {
        "F1_picks_digest": digest(picks),
        "F2_events_digest": digest([e.to_dict() for e in st.events]),
        "F3_state_no_history_digest": digest(no_hist),
        "F4_history_digest": digest(st.history),
        "picks": picks,
    }

    (OUT / f"raw-legacy-{LABEL}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
