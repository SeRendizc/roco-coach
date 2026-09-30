#!/usr/bin/env python3
"""分计划 01 只读勘察探针：把公开面逐字段读出来（不写任何源码/数据）。

跑法：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-01-fields.py

只做四件事：
  1. reset 一局真对局 → 取 `public_planner_state` / `ui_public_view` / `observation_for`；
  2. 逐字段列出「顶层键 / self / opponent / bench」的**逐字键名**；
  3. 对比 `public_planner_state.opponent.bench` 与 `ui_public_view.opponent.bench` 的键差；
  4. 扫隐藏真值（seed / _pending_* / 真实六维 / 真实四技能）是否出现在公开面里。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env import schema as rschema
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent


def keys_of(obj):
    return sorted(obj.keys()) if isinstance(obj, dict) else None


def main() -> int:
    rs = load_ruleset()
    # 用真名取真 id（不写死占位 id：写死会让「物种身份」这条读数本身失真）
    team = [rs.pets_by_name(n)[0].pet_id
            for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
    state = renv.reset(team, team, seed=20260930, rs=rs)

    pub = renv.public_planner_state(state, rs, "player")
    ui = renv.ui_public_view(state, rs, "player")
    obs = rschema.observation_for(state, rs, "player")

    report = {
        "ruleset_id": rs.ruleset_id,
        "seed_used": 20260930,
        "state_version": state.state_version,
        "turn": state.turn,
        "phase": state.phase,
    }

    # ---- 1. 顶层键 ----
    report["top_keys"] = {
        "public_planner_state": keys_of(pub),
        "ui_public_view": keys_of(ui),
        "observation_for": keys_of(obs),
    }

    # ---- 2. self / opponent 键 ----
    report["self_keys"] = {
        "public_planner_state.self": keys_of(pub.get("self")),
        "ui_public_view.self": keys_of(ui.get("self")),
        "observation_for.self": keys_of(obs.get("self")),
    }
    report["opponent_keys"] = {
        "public_planner_state.opponent": keys_of(pub.get("opponent")),
        "ui_public_view.opponent": keys_of(ui.get("opponent")),
        "observation_for.opponent": keys_of(obs.get("opponent")),
    }

    # ---- 3. 场上与后备的逐宠键 ----
    def pet_keys(container, path):
        out = {}
        if not isinstance(container, dict):
            return out
        pets = container.get("pets")
        if isinstance(pets, list) and pets:
            out[f"{path}.pets[0]"] = keys_of(pets[0])
        field = container.get("field")
        if isinstance(field, dict):
            out[f"{path}.field"] = keys_of(field)
        bench = container.get("bench")
        if isinstance(bench, list) and bench:
            out[f"{path}.bench[0]"] = keys_of(bench[0])
        return out

    report["pet_row_keys"] = {}
    report["pet_row_keys"].update(pet_keys(pub.get("self"), "public.self"))
    report["pet_row_keys"].update(pet_keys(pub.get("opponent"), "public.opponent"))
    report["pet_row_keys"].update(pet_keys(ui.get("self"), "ui.self"))
    report["pet_row_keys"].update(pet_keys(ui.get("opponent"), "ui.opponent"))
    report["pet_row_keys"].update(pet_keys(obs.get("self"), "obs.self"))
    report["pet_row_keys"].update(pet_keys(obs.get("opponent"), "obs.opponent"))

    # ---- 4. bench 键差（Codex 修订计划点名的那条链）----
    pub_bench = pub["opponent"].get("bench") or []
    ui_bench = ui["opponent"].get("bench") or []
    obs_bench = [p for i, p in enumerate(obs["opponent"]["pets"]) if i != obs["opponent"]["active"]]
    report["bench_key_diff"] = {
        "public_planner_state.opponent.bench[0]": keys_of(pub_bench[0]) if pub_bench else None,
        "ui_public_view.opponent.bench[0]": keys_of(ui_bench[0]) if ui_bench else None,
        "observation_for.opponent.bench[0]": keys_of(obs_bench[0]) if obs_bench else None,
        "public_minus_ui": sorted(set(pub_bench[0]) - set(ui_bench[0])) if (pub_bench and ui_bench) else None,
        "obs_minus_ui": sorted(set(obs_bench[0]) - set(ui_bench[0])) if (obs_bench and ui_bench) else None,
        "public_first_row": pub_bench[0] if pub_bench else None,
        "ui_first_row": ui_bench[0] if ui_bench else None,
    }

    # ---- 5. 隐藏真值扫描 ----
    hidden_probe = {
        "real_seed": state.seed,
        "foe_pending": {k: repr(v) for k, v in vars(state.enemy).items() if k.startswith("_pending")},
        "foe_bench_real_hp": [p.hp for p in state.enemy.pets],
        "foe_bench_real_loadout": dict(state.enemy.loadouts or {}),
        "foe_field_real_hp": state.enemy.field_pet.hp,
    }
    pub_s = json.dumps(pub, ensure_ascii=False, sort_keys=True)
    ui_s = json.dumps(ui, ensure_ascii=False, sort_keys=True)
    obs_s = json.dumps(obs, ensure_ascii=False, sort_keys=True)

    leaks = {}
    for label, blob in (("public_planner_state", pub_s), ("ui_public_view", ui_s),
                        ("observation_for", obs_s)):
        found = []
        if str(state.seed) in blob:
            found.append(f"real_seed_value({state.seed})")
        for name in ("_pending", "pending_action", "seed"):
            if name in blob:
                found.append(f"token:{name}")
        leaks[label] = found
    report["hidden_leak_scan"] = leaks
    report["hidden_probe"] = hidden_probe

    # ---- 6. 对手后备物种身份泄漏的直接读数 ----
    report["foe_bench_identity_leak"] = {
        "public_planner_state.opponent.bench_pet_ids":
            [b.get("pet_id") for b in pub_bench],
        "ui_public_view.opponent.bench_pet_ids":
            [b.get("pet_id") for b in ui_bench],
        "observation_for.opponent.bench_pet_ids":
            [b.get("pet_id") for b in obs_bench],
        "observation_for.opponent.bench_names":
            [b.get("name") for b in obs_bench],
    }

    # ---- 7. 公开面体积 ----
    report["sizes_bytes_utf8"] = {
        "public_planner_state": len(pub_s.encode("utf-8")),
        "ui_public_view": len(ui_s.encode("utf-8")),
        "observation_for": len(obs_s.encode("utf-8")),
    }

    (OUT / "raw-fields.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (OUT / "raw-public_planner_state.json").write_text(
        json.dumps(pub, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (OUT / "raw-ui_public_view.json").write_text(
        json.dumps(ui, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (OUT / "raw-observation_for.json").write_text(
        json.dumps(obs, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({k: report[k] for k in (
        "top_keys", "opponent_keys", "bench_key_diff", "hidden_leak_scan",
        "foe_bench_identity_leak", "sizes_bytes_utf8")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
