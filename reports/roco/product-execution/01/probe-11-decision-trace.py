"""01.4 对照读数：同一 `decision_id` 下 **UI / 工具输入 / 回放** 三处同源。

要证明的三件事（对应 01 通过条件第 2 条「同一决策的 UI、Coach、回放可追溯到同一观察序列」）：
  1. 同一次决策点上，`ui_public_view` / `public_planner_state` / `/battle/plan` 回执的
     `decision_id` / `match_id` / `rules_version` **同一份**；
  2. `state.history[i]["pre_observation_hash"]` == 决策前 `observation_for` 的哈希
     —— 也就是「快照确实取自决策前」，且它与 `decision_id` 的关系**可推导**
     （`decision_id = <match_id>:v{history[i].state_version - len(history[i].events)}`）；
  3. 回放同一份 `MatchRecord` ⇒ `history` 的观察哈希序列与对局当时记录下的
     `observation_trace` **逐条相同**（同一观察序列可复现）。

产出：`raw-decision-trace.json`。用法（仓库根）：
  PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-11-decision-trace.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "..", "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402
from roco_env.service import RocoService    # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
ENVELOPE_KEYS = ("match_id", "rules_version", "decision_id")


def digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def main() -> int:
    svc = RocoService()
    state = renv.reset(A_TEAM, B_TEAM, seed=20260930, rs=RS)
    mine = RS.candidate_moveset(A_TEAM[0])[0]
    theirs = RS.candidate_moveset(B_TEAM[0])[0]

    turns = []
    for _ in range(3):
        version_before = state.state_version
        obs_player = renv.observation_for(state, RS, "player")
        ui = renv.ui_public_view(state, RS, "player")
        pub = renv.public_planner_state(state, RS, "player")
        pre_hash = renv._obs_hash(obs_player)

        status, envelope = svc.battle_plan({"public": pub, "state_version": pub["state_version"],
                                            "depth": 1, "beam": 2, "analysis_seeds": [11]})
        plan = envelope.get("result") or {}

        renv.step_joint(state, RS,
                        Action(kind=ACTION_SKILL, skill_id=mine),
                        Action(kind=ACTION_SKILL, skill_id=theirs))
        entry = state.history[-1]
        event_count = len(entry["events"])
        derived_version_before = entry["state_version"] - event_count

        turns.append({
            "turn": entry["turn"],
            "version_before": version_before,
            "decision_id_before": f'{ui["match_id"]}:v{version_before}',
            "match_id": ui["match_id"],
            "rules_version": ui["rules_version"],
            "ui_decision_id": ui["decision_id"],
            "public_decision_id": pub["decision_id"],
            "plan_status": status,
            "plan_decision_id": plan.get("decision_id"),
            "plan_match_id": plan.get("match_id"),
            "plan_rules_version": plan.get("rules_version"),
            "three_faces_same_decision_id": (
                ui["decision_id"] == pub["decision_id"] == plan.get("decision_id")
                == f'{ui["match_id"]}:v{version_before}'),
            "observation_has_envelope_identity": any(k in obs_player for k in ENVELOPE_KEYS),
            "pre_obs_hash_recomputed": pre_hash,
            "history_pre_observation_hash": entry["pre_observation_hash"],
            "history_hash_matches": entry["pre_observation_hash"] == pre_hash,
            "history_state_version": entry["state_version"],
            "history_event_count": event_count,
            "derived_version_before_from_history": derived_version_before,
            "derived_decision_id_from_history": f'{ui["match_id"]}:v{derived_version_before}',
            "derived_matches_before": derived_version_before == version_before,
            "history_event_kinds": [e["kind"] for e in entry["events"]],
            "decision_id_is_derivable_not_recorded": "decision_id" not in entry,
        })

    # ── 回放腿：同一份 MatchRecord 重放两次，并与**对局当时**记下的观察哈希序列比 ──
    record = ropp.play_match(RS, A_TEAM, B_TEAM, "greedy_damage", "greedy_damage", seed=20260930)
    replayed = renv.replay(record.replay_plan(), RS)
    replayed_again = renv.replay(record.replay_plan(), RS)
    trace = list(record.observation_trace)
    history = list(replayed.history)
    trace_hashes = [row["player_obs_hash"] for row in trace]
    history_hashes = [row["pre_observation_hash"] for row in history]
    replay = {
        "trace_rows": len(trace),
        "history_rows": len(history),
        "trace_equals_replay_history": trace_hashes == history_hashes,
        "replay_is_deterministic": history == replayed_again.history,
        "history_digest": digest(history),
        "match_id": renv.match_id_of(replayed, RS),
        "rules_version": renv.rules_version_of(replayed, RS),
        "final_decision_id": renv.decision_id_of(replayed, RS),
        "record_has_match_id_field": hasattr(record, "match_id"),
        "record_fields": sorted(record.to_dict().keys()),
    }

    out = {
        "scripted": {
            "turns": turns,
            "all_three_faces_same_decision_id": all(t["three_faces_same_decision_id"] for t in turns),
            "all_history_hashes_match": all(t["history_hash_matches"] for t in turns),
            "all_derived_versions_match": all(t["derived_matches_before"] for t in turns),
        },
        "replay": replay,
        "boundaries": {
            "history_stores_hashes_not_payloads": True,
            "history_has_no_match_id_or_decision_id": True,
            "step_free_not_in_history": True,
            "browser_render_not_verified": "前端入口属分计划 02，本轮不做",
        },
    }

    with open(os.path.join(HERE, "raw-decision-trace.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")

    print(json.dumps({
        "scripted_ok": out["scripted"]["all_three_faces_same_decision_id"],
        "history_hash_match": out["scripted"]["all_history_hashes_match"],
        "derived_version_match": out["scripted"]["all_derived_versions_match"],
        "replay_trace_equals_history": replay["trace_equals_replay_history"],
        "replay_deterministic": replay["replay_is_deterministic"],
        "replay_rows": replay["history_rows"],
        "first_turn": turns[0],
    }, ensure_ascii=False, indent=1)[:2600])
    print("WROTE raw-decision-trace.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
