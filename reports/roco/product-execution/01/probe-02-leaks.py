#!/usr/bin/env python3
"""分计划 01 只读反例探针 2：隐藏真值泄漏面（不写任何源码/数据）。

跑法：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-02-leaks.py

回答四个问题（全部用读数回答，不靠推断）：
  Q1 `ui_public_view.legal.enemy` 是否泄漏对手**真实四技能**（与 `state.enemy.loadouts` 比）；
  Q2 `public_planner_state.opponent.bench` 是否泄漏对手**后备物种身份**（对比 UI/契约）；
  Q3 `observation_for` 是否泄漏对手整队身份（含真名）；
  Q4 只改隐藏真值（天分/六维/后备真实血量）时，公开面是否逐字段不变（01.6 不变性预演）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env import schema as rschema
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def main() -> int:
    rs = load_ruleset()
    team = [rs.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
    # 对手用候选宇宙里另外三只（真名从规则集取，不写死占位 id）
    foe_ids = [rs.pets_by_name(n)[0].pet_id
               for n in ("圆号鱼", "雪影娃娃", "音速犬")]
    foe = foe_ids
    state = renv.reset(team, foe, seed=20260930, rs=rs)

    ui = renv.ui_public_view(state, rs, "player")
    pub = renv.public_planner_state(state, rs, "player")
    obs = rschema.observation_for(state, rs, "player")

    report = {"ruleset_id": rs.ruleset_id, "state_version": state.state_version}

    # ---- Q1：对手真实四技能 vs ui.legal.enemy ----
    foe_loadouts = {k: list(v) for k, v in (state.enemy.loadouts or {}).items()}
    foe_active_pet = state.enemy.field_pet.pet_id
    real_active_skills = sorted(foe_loadouts.get(foe_active_pet, []))
    legal_enemy_skill_ids = sorted({a.get("skill_id") for a in ui["legal"]["enemy"]
                                    if a.get("kind") == "skill" and a.get("skill_id")})
    report["Q1_enemy_legal_vs_real_loadout"] = {
        "foe_active_pet_id": foe_active_pet,
        "real_loadout_of_foe_active": real_active_skills,
        "ui_legal_enemy_skill_ids": legal_enemy_skill_ids,
        "overlap": sorted(set(real_active_skills) & set(legal_enemy_skill_ids)),
        "real_loadout_leaked_fully": set(real_active_skills) <= set(legal_enemy_skill_ids),
        "foe_public_state_has_loadouts_key": "loadouts" in (pub["opponent"].get("field") or {}),
        "ui_field_has_skills_key": "skills" in ui["opponent"]["field"],
        "note": "ui.legal.enemy 在浏览器可见载荷里；含 skill_id/skill_name/skill.desc/power/energy",
        "ui_legal_enemy_rows_sample": [
            {k: a.get(k) for k in ("kind", "skill_id", "skill_name", "item_id", "target_index")}
            for a in ui["legal"]["enemy"][:8]
        ],
    }
    # 对手后备的真实配招是否也被 legal.enemy 之外的路带出去
    report["Q1b_ui_opponent_bench_rows"] = ui["opponent"]["bench"]

    # ---- Q2：public vs ui 后备身份 ----
    report["Q2_bench_identity"] = {
        "public_planner_state": pub["opponent"]["bench"],
        "ui_public_view": ui["opponent"]["bench"],
        "public_leaks_pet_id": any("pet_id" in b for b in pub["opponent"]["bench"]),
        "ui_leaks_pet_id": any("pet_id" in b for b in ui["opponent"]["bench"]),
    }

    # ---- Q3：observation_for 整队身份 ----
    report["Q3_observation_for_leaks"] = {
        "bench_rows": [p for i, p in enumerate(obs["opponent"]["pets"])
                       if i != obs["opponent"]["active"]],
        "leaks_pet_id": any("pet_id" in p for i, p in enumerate(obs["opponent"]["pets"])
                            if i != obs["opponent"]["active"]),
        "leaks_name": any(p.get("name") for i, p in enumerate(obs["opponent"]["pets"])
                          if i != obs["opponent"]["active"]),
    }

    # ---- Q4：只改隐藏真值 → 公开面不变性预演 ----
    # 4a：换一个真实 seed（改的是隐藏随机源）。
    state_seed2 = renv.reset(team, foe, seed=777, rs=rs)
    pub_seed2 = renv.public_planner_state(state_seed2, rs, "player")
    report["Q4a_seed_change_public_identical"] = dump(pub) == dump(pub_seed2)

    # 4b：只改对手后备的**真实血量**（一个隐藏真值），不推进任何事件。
    state_hp = renv.reset(team, foe, seed=20260930, rs=rs)
    bench_idx = [i for i in range(len(state_hp.enemy.pets)) if i != state_hp.enemy.active]
    before_pub = dump(renv.public_planner_state(state_hp, rs, "player"))
    before_ui = dump(renv.ui_public_view(state_hp, rs, "player"))
    # 直接改后备真实血量（模拟「隐藏真值变了、公开史不变」）
    state_hp.enemy.pets[bench_idx[0]].hp = 7
    state_hp.enemy.pets[bench_idx[0]].energy = 3
    after_pub = dump(renv.public_planner_state(state_hp, rs, "player"))
    after_ui = dump(renv.ui_public_view(state_hp, rs, "player"))
    report["Q4b_hidden_bench_hp_change"] = {
        "changed_slot": state_hp.enemy.pets[bench_idx[0]].slot,
        "public_planner_state_identical": before_pub == after_pub,
        "ui_public_view_identical": before_ui == after_ui,
        "ui_legal_enemy_identical": dump(ui["legal"]["enemy"]) == dump(
            renv.ui_public_view(state_hp, rs, "player")["legal"]["enemy"]),
    }

    # 4c：只改对手个体面板（隐藏天分/六维）——当前引擎没有对局内改面板的入口，
    #     所以这里只登记「能不能改」，不改（不猜入口）。
    report["Q4c_individual_panel_entry"] = {
        "PetState_has_panel_field": hasattr(state.enemy.field_pet, "panel"),
        "foe_field_panel_value": dict(state.enemy.field_pet.panel),
        "note": "对手侧 panel 由 reset 的 individuals 注入决定；对局内没有改它的入口（未找到）",
    }

    (OUT / "raw-leaks.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
