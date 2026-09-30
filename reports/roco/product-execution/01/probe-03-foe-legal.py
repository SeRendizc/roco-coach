#!/usr/bin/env python3
"""分计划 01 只读反例探针 3：`ui_public_view.legal.enemy` 泄漏对手真实配招的比率。

跑法：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py

口径：对 N 个 seed、标准六宠配置各开一局，比较
  A = `state.enemy.loadouts[对手场上那一只]`（**真实**四技能，隐藏真值）
  B = `ui_public_view(...)["legal"]["enemy"]` 里 kind=='skill' 的 skill_id 集合（浏览器可见）
输出：B 恢复 A 的比率、以及 B 里**不在** A 的项（引擎给的合法动作集合 ⊋ 配招，因为含通用动作）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent


def main() -> int:
    rs = load_ruleset()
    cfg = "mobile_s4_candidate_v3"
    team = ["pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000112", "pet_000062"]
    seeds = [11, 29, 47, 222, 519, 646, 758, 900, 991]
    rows = []
    for seed in seeds:
        # 对手故意换一组，避免「镜像队伍」把泄漏读成巧合
        foe = ["pet_000062", "pet_000112", "pet_000417", "pet_000225", "pet_000190", "pet_000445"]
        st = renv.reset(team, foe, seed=seed, rs=rs, config=cfg)
        ui = renv.ui_public_view(st, rs, "player")
        active_id = st.enemy.field_pet.pet_id
        real = sorted(set(st.enemy.loadouts.get(active_id) or []))
        leaked = sorted({a.get("skill_id") for a in ui["legal"]["enemy"]
                         if a.get("kind") == "skill" and a.get("skill_id")})
        recovered = sorted(set(real) & set(leaked))
        rows.append({
            "seed": seed,
            "turn": st.turn,
            "foe_active": active_id,
            "foe_active_name": rs.pet(active_id).name,
            "real_loadout": real,
            "browser_visible": leaked,
            "recovered": recovered,
            "recovery_ratio": (len(recovered) / len(real)) if real else None,
            "extra_not_in_loadout": sorted(set(leaked) - set(real)),
        })

    summary = {
        "ruleset_config_id": cfg,
        "seeds": seeds,
        "rows": rows,
        "mean_recovery_ratio": round(
            sum(r["recovery_ratio"] for r in rows if r["recovery_ratio"] is not None)
            / len([r for r in rows if r["recovery_ratio"] is not None]), 4),
        "seeds_with_full_recovery": sum(1 for r in rows if r["recovery_ratio"] == 1.0),
        "total_seeds": len(rows),
        "note": ("`ui_public_view` 随 `_sim_envelope` 的 `result.ui` 下发到 Node，"
                 "`publicView()` 只取 `ui.legal.player`，但 `result.ui` 整份在 Node 内存里；"
                 "`/battle/new` 的回执把裁剪后的 view 给浏览器，原始 result.ui 不出浏览器。"),
    }
    (OUT / "raw-foe-legal-leak.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
