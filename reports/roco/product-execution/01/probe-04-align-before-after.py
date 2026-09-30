#!/usr/bin/env python3
"""分计划 01 步骤 A/B 的**前后对照**探针（只读引擎，不改数据）。

跑法（同一支脚本跑两次，把输出存成 before/after）：
    cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-04-align-before-after.py <标签>

它量四件事：
  A `ui_public_view.legal.enemy` 里对手**真实配招**的回收率（目标 < 1.0）
  B `public_planner_state.opponent.bench` / `ui_public_view.opponent.bench` /
    `observation_for.opponent.pets[i≠active]` 三者的键集是否**已对齐**
  C `_sim_envelope` 口径的 `result.legal.enemy`（**不在本次改动范围**，只登记是否仍然存在）
  D 「只改对手隐藏真值 ⇒ 公开面逐字段相同」的不变性读数
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from roco_env import env as renv
from roco_env import schema as rschema
from roco_env.data import load_ruleset

OUT = Path(__file__).resolve().parent
LABEL = sys.argv[1] if len(sys.argv) > 1 else "unlabeled"


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def main() -> int:
    rs = load_ruleset()
    # ⚠ 队伍**必须不重叠**：第一版把对手设成己方六只的排列，于是 `own_all` 把
    #   对手技能全部抵消掉了，度量恒为 0（假绿）。这里从候选宇宙取两组互不相交的六只。
    cand = [p for p in rs.candidate_movesets]
    team = cand[0:6]
    foe = cand[6:12]
    assert not (set(team) & set(foe)), "己方与对手队伍必须不相交，否则度量无效"
    seeds = [11, 29, 47, 222, 519, 646, 758, 900, 991]
    cfg = "mobile_s4_candidate_v3"

    report: dict = {"label": LABEL, "ruleset_config_id": cfg, "seeds": seeds,
                    "team_player": list(team), "team_foe": list(foe)}

    # ---- A：对手真实配招回收率（**扫描整个 UI blob**，不只看某一条已知路径）----
    #
    # 为什么不用「读 `ui.legal.enemy[].skill_id`」来量：那条路径一旦被删掉，
    # 度量本身就会退化成恒 0（第一版就是这么写出一个假绿的）。这里改成**递归收集
    # 整个公开载荷里出现过的所有 skill_* 形状的字符串**，再看对手真实配招有多少个
    # 能在里面找到。⇒ 换路径、改字段名、嵌套到别处都躲不过这条度量。
    def all_skill_ids(node, acc):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and v.startswith("skill_"):
                    acc.add(v)
                all_skill_ids(v, acc)
        elif isinstance(node, list):
            for item in node:
                all_skill_ids(item, acc)
        return acc

    rows = []
    # 控：证明这条度量**能**发现泄漏（否则「0 个泄漏」可能只是度量死了）。
    # 把对手技能 id 手动放进一个副本里，度量必须报「全部可见」。
    _ctl = renv.reset(team, foe, seed=11, rs=rs, config=cfg)
    _ctl_ui = renv.ui_public_view(_ctl, rs, "player")
    _ctl_id = _ctl.enemy.field_pet.pet_id
    _ctl_real = sorted(set(_ctl.enemy.loadouts.get(_ctl_id) or []))
    _ctl_own = {s for ids in (_ctl.player.loadouts or {}).values() for s in ids}

    def _visible(blob, real_ids, own_ids):
        got = all_skill_ids(blob, set())
        return sorted((set(real_ids) & got) - own_ids)

    _injected = dict(_ctl_ui)
    _injected["__control__"] = _ctl_real
    control = {
        "real_foe_active_skills_n": len(_ctl_real),
        "visible_without_injection": len(_visible(_ctl_ui, _ctl_real, _ctl_own)),
        "visible_with_injection": len(_visible(_injected, _ctl_real, _ctl_own)),
        "metric_can_detect_leak": len(_visible(_injected, _ctl_real, _ctl_own)) == len(_ctl_real),
    }

    for seed in seeds:
        st = renv.reset(team, foe, seed=seed, rs=rs, config=cfg)
        ui = renv.ui_public_view(st, rs, "player")
        pub = renv.public_planner_state(st, rs, "player")
        active_id = st.enemy.field_pet.pet_id
        # 对手**全体**真实配招（不只场上那只）：任何一只的技能 id 出现在公开载荷里都算泄漏
        real_all = sorted({s for ids in (st.enemy.loadouts or {}).values() for s in ids})
        real_active = sorted(set(st.enemy.loadouts.get(active_id) or []))
        in_ui = all_skill_ids(ui, set())
        in_pub = all_skill_ids(pub, set())
        # 己方技能当然会出现——把它扣掉，剩下的才是「对手的」泄漏
        own_all = {s for ids in (st.player.loadouts or {}).values() for s in ids}
        foe_leaked_ui = _visible(ui, real_all, own_all)
        rec_active = sorted(set(real_active) & set(foe_leaked_ui))
        rows.append({
            "seed": seed, "foe_active": active_id,
            "foe_real_loadout_n": len(real_active),
            "foe_all_skills_n": len(real_all),
            "foe_skills_visible_in_ui_n": len(foe_leaked_ui),
            "recovered_active_n": len(rec_active),
            "recovery_ratio_active": (len(rec_active) / len(real_active)) if real_active else None,
            "foe_skills_visible_in_public_planner_n": len(_visible(pub, real_all, own_all)),
            "own_skills_visible_in_ui_n": len(_visible(ui, sorted(own_all), set())),
        })
    report["A_foe_loadout_recovery"] = {
        "metric": "递归扫描整个 blob 里出现的 skill_* 字符串，与对手真实配招取交集（扣掉己方技能）",
        "control": control,
        "rows": rows,
        "mean_recovery_ratio": round(
            sum(r["recovery_ratio_active"] for r in rows if r["recovery_ratio_active"] is not None)
            / len([r for r in rows if r["recovery_ratio_active"] is not None]), 4),
        "seeds_with_full_recovery": sum(1 for r in rows if r["recovery_ratio_active"] == 1.0),
        "total_seeds": len(rows),
        "ui_legal_enemy_key_present": "enemy" in renv.ui_public_view(
            renv.reset(team, foe, seed=11, rs=rs, config=cfg), rs, "player").get("legal", {}),
    }

    # ---- B：三条协议的后备键集对齐 ----
    st = renv.reset(team, foe, seed=20260930, rs=rs, config=cfg)
    pub = renv.public_planner_state(st, rs, "player")
    ui = renv.ui_public_view(st, rs, "player")
    obs = rschema.observation_for(st, rs, "player")
    obs_bench = [p for i, p in enumerate(obs["opponent"]["pets"]) if i != obs["opponent"]["active"]]
    report["B_bench_keys"] = {
        "public_planner_state": sorted(pub["opponent"]["bench"][0].keys()) if pub["opponent"]["bench"] else None,
        "ui_public_view": sorted(ui["opponent"]["bench"][0].keys()) if ui["opponent"]["bench"] else None,
        "observation_for": sorted(obs_bench[0].keys()) if obs_bench else None,
        "all_three_aligned": (
            sorted(pub["opponent"]["bench"][0].keys())
            == sorted(ui["opponent"]["bench"][0].keys())
            == sorted(obs_bench[0].keys())
        ) if (pub["opponent"]["bench"] and ui["opponent"]["bench"] and obs_bench) else None,
        "public_bench_id_free": not any("pet_id" in b for b in pub["opponent"]["bench"]),
        "obs_bench_id_free": not any("pet_id" in p for p in obs_bench),
        "obs_bench_name_free": not any("name" in p for p in obs_bench),
        "field_still_has_pet_id": "pet_id" in (pub["opponent"].get("field") or {}),
        "public_bench_raw": pub["opponent"]["bench"],
        "obs_bench_raw": obs_bench,
    }

    # ---- C：result.legal.enemy（不在改动范围，只登记） ----
    pl = renv.legal_actions(st, rs, "enemy")
    report["C_envelope_legal_enemy"] = {
        "note": "`service._sim_envelope` 的 `result.legal.enemy`（私有域回执）**未改**；cpu_legal_count 依赖它",
        "count": len(pl),
        "has_skill_ids": any(a.kind == "skill" for a in pl),
    }

    # ---- D：只改隐藏真值 ⇒ 公开面逐字段相同 ----
    # D1：换真实 seed
    a = dump(renv.public_planner_state(renv.reset(team, foe, seed=7, rs=rs, config=cfg), rs, "player"))
    b = dump(renv.public_planner_state(renv.reset(team, foe, seed=12345, rs=rs, config=cfg), rs, "player"))
    # D2：只改对手后备真实 hp/energy
    st2 = renv.reset(team, foe, seed=20260930, rs=rs, config=cfg)
    before_pub, before_ui = dump(renv.public_planner_state(st2, rs, "player")), dump(renv.ui_public_view(st2, rs, "player"))
    idx = [i for i in range(len(st2.enemy.pets)) if i != st2.enemy.active]
    st2.enemy.pets[idx[0]].hp = 7
    st2.enemy.pets[idx[0]].energy = 3
    after_pub, after_ui = dump(renv.public_planner_state(st2, rs, "player")), dump(renv.ui_public_view(st2, rs, "player"))
    report["D_invariance"] = {
        "D1_seed_change_public_identical": a == b,
        "D2_hidden_bench_hp_energy_change_public_identical": before_pub == after_pub,
        "D2_hidden_bench_hp_energy_change_ui_identical": before_ui == after_ui,
        "D3_individual_panel_change": "blocked:needs_injection_entry",
        "D3_why": ("`reset(individuals=...)` 只按玩家位次解析（env.py:249 resolve_snapshots(individuals, list(team))），"
                   "对手侧 panel 恒为 {}（实测 Q4c）。引擎没有对局内改对手个体的入口 ⇒ 不猜、不静默跳过。"),
    }

    (OUT / f"raw-align-{LABEL}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("A_foe_loadout_recovery", "B_bench_keys",
                                             "C_envelope_legal_enemy", "D_invariance")},
                     ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
