"""06.3 只读探针（task-14 勘察）：`decision_id` 两种口径在「带开局预览」的局里对不对得上。

01.4 给出的推导（`01.4-decision-trace.md` §2）：
    version_before = history[k].state_version − len(history[k].events)
    decision_id    = <match_id> : v{version_before}
本探针用真服务各开一局（`opening_preview` 开 / 关），比较：
    · 视图自己给的 `decision_id`（引擎 `observation_contract` 的产物）；
    · 用上面那条推导算出来的 `decision_id`；
并读出开局那一刻 `state.events` 里有几条事件（预览事件会不会把 `state_version` 顶高一格）。

产出 `raw-06.3-decision-id.json`。用法（WSL）：bash /mnt/e/roco-scratch/plan06/run-probe-decision-id.sh
"""
from __future__ import annotations

import json
import os
import sys
import traceback

ROOT = "/mnt/e/roco-coach"
OUT_DIR = os.path.join(ROOT, "reports", "roco", "product-execution", "06")
OUT = os.path.join(OUT_DIR, "raw-06.3-decision-id.json")
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env.service import RocoService      # noqa: E402

RS = rdata.load_ruleset()
CFG = "mobile_s4_candidate_v3"
SIX = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花", "迪莫", "水灵", "火神")]
SIX_B = [RS.pets_by_name(n)[0].pet_id for n in ("魔力猫", "草头鸭", "恶魔叮", "恶魔狼", "鸭吉吉", "铠甲虫")]


def probe(preview: bool):
    svc = RocoService()
    status, env0 = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": SIX, "enemy_team": SIX_B,
                                   "seed": 5, "state_version": 0, "opening_preview": bool(preview),
                                   "ruleset_config_id": CFG})
    if status != 200:
        return {"status": status, "error": env0}
    receipt = env0["result"]
    view = {"state_version": receipt.get("state_version"), "turn": receipt.get("turn"),
            "phase": receipt.get("phase"), "decision_id": receipt.get("decision_id"),
            "events_n": len(receipt.get("events") or []),
            "event_kinds": [(e.get("kind")) for e in (receipt.get("events") or [])],
            "opening_reveal": bool(receipt.get("opening_reveal"))}
    legal = (receipt.get("legal") or {}).get("player") or []
    action = next(({k: v for k, v in a.items() if k != "skill"} for a in legal if a.get("kind") == "skill"), None)
    status2, env1 = svc.battle_advance({"state": receipt["state"],
                                        "state_version": receipt.get("state_version"), "action": action})
    if status2 != 200:
        return {"status": status, "view": view, "advance_status": status2, "advance_error": env1}
    after = env1["result"]
    row = (after.get("state") or {}).get("history", [{}])[-1]
    derived = None
    if isinstance(row.get("state_version"), int):
        derived = row["state_version"] - len(row.get("events") or [])
    return {"status": status, "view": view,
            "history_row0": {"turn": row.get("turn"), "state_version": row.get("state_version"),
                             "events_n": len(row.get("events") or []),
                             "pre_observation_hash": row.get("pre_observation_hash")},
            "derived_decision_id_before": f"{view['decision_id'].split(':v')[0]}:v{derived}" if derived is not None and view.get("decision_id") else None,
            "view_decision_id": view.get("decision_id"),
            "match": (view.get("decision_id") or "").endswith(":v%d" % derived) if derived is not None else None}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out = {"ruleset_id": RS.ruleset_id, "ruleset_config_id": CFG, "runs": {}}
    try:
        out["runs"]["opening_preview_on"] = probe(True)
        out["runs"]["opening_preview_off"] = probe(False)
    except Exception as exc:
        out["notes"] = ["EXCEPTION: %s" % exc]
        out["traceback"] = traceback.format_exc()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print("OUT=%s bytes=%d" % (OUT, os.path.getsize(OUT)))
    for key, row in out["runs"].items():
        view = row.get("view") or {}
        print("%-20s state_version=%s events_at_open=%s kinds=%s decision_id=%s derived=%s match=%s" % (
            key, view.get("state_version"), view.get("events_n"), view.get("event_kinds"),
            row.get("view_decision_id"), row.get("derived_decision_id_before"), row.get("match")))
    for note in out.get("notes", []):
        print("NOTE: %s" % note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
