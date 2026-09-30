#!/usr/bin/env python3
"""分计划 01：为 legacy 黄金指纹改钉产出**精确**读数（改前 / 改后各跑一次）。

跑法：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-06-golden-digests.py <标签>

产出：六局 + 短局的
  · state_full_digest      —— 现状口径（serialize() 全量，**含 history**）
  · state_no_history_digest—— 收窄口径（剔除 history）
  · history_digest         —— history 单独留一枚指纹（不静默丢字段）
  · events_digest
  · field_set_ok           —— 证明 history 是唯一被剔除的键（不是把别的字段漏掉）
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env import opponents as ropp
from roco_env import rule_config as rc
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent
LABEL = sys.argv[1] if len(sys.argv) > 1 else "unlabeled"
ROSTER_IDS = ["pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000112",
              "pet_000062", "pet_000474", "pet_000451", "pet_000124", "pet_000608",
              "pet_000601", "pet_000611"]


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def main() -> int:
    rs = load_ruleset()
    os.environ.pop(rc.ENV_VAR, None)
    rc.clear_cache()
    names = list(ropp.STRATEGIES.names())
    out: dict = {"label": LABEL}

    for index, seed in enumerate((1000, 1001, 1002, 1003, 1004, 1005)):
        team_a = [ROSTER_IDS[index % 12], ROSTER_IDS[(index + 1) % 12], ROSTER_IDS[(index + 2) % 12]]
        team_b = [ROSTER_IDS[(index + 3) % 12], ROSTER_IDS[(index + 4) % 12], ROSTER_IDS[(index + 5) % 12]]
        record = ropp.play_match(rs, team_a, team_b, names[index % len(names)],
                                 names[(index + 2) % len(names)], seed)
        state = renv.replay(record.replay_plan(), rs)
        full = renv.serialize(state)
        no_hist = {k: v for k, v in full.items() if k != "history"}
        out[str(seed)] = {
            "state_full_digest": _digest(full),
            "state_no_history_digest": _digest(no_hist),
            "history_digest": _digest(state.history),
            "events_digest": _digest([e.to_dict() for e in state.events]),
            "field_set_ok": (set(full) - set(no_hist)) == {"history"},
            "removed_keys": sorted(set(full) - set(no_hist)),
        }

    st = renv.reset(ROSTER_IDS[:3], ROSTER_IDS[3:6], seed=3, rs=rs)
    for _ in range(4):
        if st.result:
            break
        if st.phase == "replace":
            side = st.replace_queue[0]
            renv.step_replace(st, rs, side, getattr(st, side).bench_indices()[0])
            continue
        la = renv.legal_actions(st, rs, "player")
        lb = renv.legal_actions(st, rs, "enemy")
        renv.step_joint(st, rs, la[0], lb[1 % len(lb)])
    full = renv.serialize(st)
    no_hist = {k: v for k, v in full.items() if k != "history"}
    out["short"] = {
        "state_full_digest": _digest(full),
        "state_no_history_digest": _digest(no_hist),
        "history_digest": _digest(st.history),
        "events_digest": _digest([e.to_dict() for e in st.events]),
        "field_set_ok": (set(full) - set(no_hist)) == {"history"},
    }

    (OUT / f"raw-golden-{LABEL}.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
