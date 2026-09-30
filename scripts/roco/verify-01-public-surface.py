#!/usr/bin/env python3
"""独立验收用的 **01 公开面探针**（harness-verifier 自建）。

设计要点（防 01 那三类假绿，见 reports/roco/product-execution/01/README-INDEX.md）：
  · 泄漏度量 = **递归扫描整个载荷**里出现的 `skill_*` 字符串，再与对手真实配招取交集
    （扣掉己方技能）。**不看任何一条已知路径** ⇒ 路径被删/改名也躲不过。
  · **差分控件**（本探针独有）：同一把尺子、同一组 id，在
      正域（私有：`legal_actions(st, rs, "enemy")` 里的真实技能 id）**必须量得到**；
      负域（公开：三条投影）**必须量不到**。
    两边一正一负才说明「0 泄漏」不是度量死了 —— 单独一个 0 什么都不证明。
  · 另外三条：三条投影的后备键集对齐且无 pet_id/name；「只改隐藏真值 ⇒ 公开面逐字节相同」；
    （若已实现）`opening_roster_revealed` / `match_id` / `event_seq` / `decision_id` 的存在性与同源性。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-01-public-surface.py --json /tmp/p.json
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-01-public-surface.py --seeds 9
退出码: 0 = 全部期望成立；3 = 有硬失败（逐条打印）；1 = 探针自身异常。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import data as D  # noqa: E402
from roco_env import env as renv  # noqa: E402
from roco_env import schema as rschema  # noqa: E402


def collect_skill_ids(node, acc=None):
    """递归收集任意嵌套里所有 `skill_*` 形状的字符串（判定字符串放在最前面）。"""
    acc = set() if acc is None else acc
    if isinstance(node, str):
        if node.startswith("skill_"):
            acc.add(node)
    elif isinstance(node, dict):
        for v in node.values():
            collect_skill_ids(v, acc)
    elif isinstance(node, (list, tuple, set)):
        for item in node:
            collect_skill_ids(item, acc)
    return acc


def collect_keys(node, acc=None):
    """递归收集任意嵌套里出现过的所有 dict 键名。"""
    acc = set() if acc is None else acc
    if isinstance(node, dict):
        for k, v in node.items():
            acc.add(str(k))
            collect_keys(v, acc)
    elif isinstance(node, (list, tuple, set)):
        for item in node:
            collect_keys(item, acc)
    return acc


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def pick_teams(rs, n=6):
    cand = list(rs.candidate_movesets)
    if len(cand) < 2 * n:
        raise SystemExit(f"候选池不足：{len(cand)}")
    team, foe = cand[:n], cand[n:2 * n]
    if set(team) & set(foe):
        raise SystemExit("己方/对手队伍重叠 ⇒ 度量会把对手技能当己方扣掉（假绿）")
    return team, foe


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=9)
    ap.add_argument("--config", default="mobile_s4_candidate_v3")
    ap.add_argument("--json", dest="json_path", default=None)
    ap.add_argument("--label", default="verify01")
    args = ap.parse_args(argv)

    rs = D.load_ruleset()
    team, foe = pick_teams(rs)
    seeds = [11, 29, 47, 222, 519, 646, 758, 900, 991][:max(1, args.seeds)]
    cfg = args.config
    fails: list[str] = []
    report: dict = {"label": args.label, "team_player": list(team), "team_foe": list(foe),
                    "seeds": seeds, "config": cfg}

    st0 = renv.reset(team, foe, seed=seeds[0], rs=rs, config=cfg)
    ui0 = renv.ui_public_view(st0, rs, "player")
    pub0 = renv.public_planner_state(st0, rs, "player")
    obs0 = rschema.observation_for(st0, rs, "player")
    foe_real0 = sorted({s for ids in (st0.enemy.loadouts or {}).values() for s in ids})
    own0 = {s for ids in (st0.player.loadouts or {}).values() for s in ids}
    private0 = [{"kind": a.kind, "skill_id": getattr(a, "skill_id", None)}
                for a in renv.legal_actions(st0, rs, "enemy")]

    # ── 差分控件：同一把尺子、同一组 id，正域必须量得到 ─────────────────────
    ctl_private = sorted(set(foe_real0) & collect_skill_ids(private0))
    ctl_synth = sorted({"skill_900001", "skill_900002"} & collect_skill_ids({"x": ["skill_900001", "skill_900002"]}))
    ctl_own_public = sorted(set(own0) & collect_skill_ids(ui0))
    report["controls"] = {
        "private_enemy_legal_recovered": ctl_private,
        "private_enemy_legal_expected_n": len(foe_real0),
        "synthetic_ids_scanner_finds": ctl_synth,
        "own_skill_ids_found_in_public_ui": ctl_own_public,
        "own_loadout_n": len(own0),
    }
    if ctl_synth != ["skill_900001", "skill_900002"]:
        fails.append("控件失败：递归扫描器连注入的合成 id 都找不到 ⇒ 度量已死")
    if not ctl_private:
        fails.append("控件失败：私有域（enemy legal）里量不到对手真实技能 ⇒ 差分控件无正域")
    if not ctl_own_public:
        fails.append("控件失败：公开 UI 里连己方技能 id 都量不到 ⇒ 载荷里根本没有 skill_* 字符串")

    # ── A：跨 seed 的公开面泄漏回收率（三条投影全覆盖）──────────────────────
    rows = []
    for seed in seeds:
        st = renv.reset(team, foe, seed=seed, rs=rs, config=cfg)
        surfaces = {
            "ui_public_view": renv.ui_public_view(st, rs, "player"),
            "public_planner_state": renv.public_planner_state(st, rs, "player"),
            "observation_for": rschema.observation_for(st, rs, "player"),
        }
        real_all = sorted({s for ids in (st.enemy.loadouts or {}).values() for s in ids})
        own_all = {s for ids in (st.player.loadouts or {}).values() for s in ids}
        row = {"seed": seed, "foe_real_n": len(real_all)}
        for name, blob in surfaces.items():
            got = collect_skill_ids(blob)
            row[f"{name}_foe_leaked"] = sorted((set(real_all) - own_all) & got)
        priv = [{"kind": a.kind, "skill_id": getattr(a, "skill_id", None)}
                for a in renv.legal_actions(st, rs, "enemy")]
        row["private_enemy_legal_recovered_n"] = len(set(real_all) & collect_skill_ids(priv))
        rows.append(row)
    leaked = sum(len(r[f"{n}_foe_leaked"]) for r in rows
                 for n in ("ui_public_view", "public_planner_state", "observation_for"))
    report["A_leak_rows"] = rows
    report["A_total_leaked_ids"] = leaked
    if leaked:
        fails.append(f"公开面泄漏对手真实技能 id 共 {leaked} 处：{rows[:2]}")

    # ── B：三条投影的后备键集对齐 + 无身份字段 ──────────────────────────────
    bench_pub = pub0["opponent"]["bench"]
    bench_ui = ui0["opponent"]["bench"]
    obs_bench = [p for i, p in enumerate(obs0["opponent"]["pets"]) if i != obs0["opponent"]["active"]]
    keys_pub = sorted(bench_pub[0].keys()) if bench_pub else None
    keys_ui = sorted(bench_ui[0].keys()) if bench_ui else None
    keys_obs = sorted(obs_bench[0].keys()) if obs_bench else None
    report["B_bench"] = {
        "public_planner_state_keys": keys_pub,
        "ui_public_view_keys": keys_ui,
        "observation_for_keys": keys_obs,
        # ⚠ 说明：`observation_for` 的后备行是「逐号位标记行」形状
        # （{slot, fainted, active, field}），另两条投影是 {slot, fainted}。
        # 键集**字面**不同 ≠ 泄漏；硬判据是「后备不得带身份字段」。
        "keys_aligned_literally": keys_pub == keys_ui == keys_obs,
        "bench_keys_two_projections_aligned": keys_pub == keys_ui,
        "identity_free": all(
            not any(k in item for k in ("pet_id", "name", "skills", "loadout"))
            for group in (bench_pub, bench_ui, obs_bench) for item in group),
        "field_has_pet_id": "pet_id" in (pub0["opponent"].get("field") or {}),
        "obs_active_row_has_pet_id": bool(obs0["opponent"]["pets"][obs0["opponent"]["active"]].get("pet_id")),
    }
    if not report["B_bench"]["identity_free"]:
        fails.append("后备里出现身份字段（pet_id/name/skills/loadout）")

    # ── C：只改隐藏真值 ⇒ 公开面逐字节相同 ─────────────────────────────────
    a_pub = dumps(renv.public_planner_state(renv.reset(team, foe, seed=7, rs=rs, config=cfg), rs, "player"))
    b_pub = dumps(renv.public_planner_state(renv.reset(team, foe, seed=12345, rs=rs, config=cfg), rs, "player"))
    st2 = renv.reset(team, foe, seed=20260930, rs=rs, config=cfg)
    pre = (dumps(renv.public_planner_state(st2, rs, "player")), dumps(renv.ui_public_view(st2, rs, "player")),
           dumps(rschema.observation_for(st2, rs, "player")))
    idx = [i for i in range(len(st2.enemy.pets)) if i != st2.enemy.active]
    st2.enemy.pets[idx[0]].hp = 7
    st2.enemy.pets[idx[0]].energy = 3
    post = (dumps(renv.public_planner_state(st2, rs, "player")), dumps(renv.ui_public_view(st2, rs, "player")),
            dumps(rschema.observation_for(st2, rs, "player")))
    report["C_invariance"] = {
        "seed_change_public_identical": a_pub == b_pub,
        "bench_hp_energy_change_identical": [x == y for x, y in zip(pre, post)],
        "surfaces": ["public_planner_state", "ui_public_view", "observation_for"],
    }
    if not report["C_invariance"]["seed_change_public_identical"]:
        fails.append("换 seed 后公开 planner 载荷变了 ⇒ 公开面吸收了种子（隐藏真值）")
    if not all(report["C_invariance"]["bench_hp_energy_change_identical"]):
        fails.append("改后备隐藏 hp/energy 后公开面变了")

    # ── D：契约字段 / 预览事件（未实现则如实登记为 absent，不算失败）────────
    try:
        from roco_env import service as S  # noqa: E402
        svc = S.RocoService()
        status, env = svc.battle_new({
            "ruleset_id": getattr(rs, "ruleset_id", None), "state_version": 0,
            "team": list(team), "enemy_team": list(foe), "seed": 11,
            "strategy": "greedy_damage", "ruleset_config_id": cfg,
        })
        keys = sorted(collect_keys(env))
        priv = (env.get("result") or {}).get("private") if isinstance(env, dict) else None
        state = (priv or {}).get("state") if isinstance(priv, dict) else None
        if state is None and isinstance(env, dict):
            state = (env.get("result") or {}).get("state")
        events = (state or {}).get("events") if isinstance(state, dict) else None
        report["D_receipt"] = {
            "http_status": status,
            "ok": (env or {}).get("ok"),
            "has_match_id": "match_id" in keys,
            "has_event_seq": "event_seq" in keys,
            "has_decision_id": "decision_id" in keys,
            "has_rules_version": "rules_version" in keys,
            "has_opening_roster_revealed": "opening_roster_revealed" in keys,
            "state_events_n": len(events) if isinstance(events, list) else None,
            "state_version": (state or {}).get("state_version") if isinstance(state, dict) else None,
            "event_kinds": sorted({e.get("kind") for e in events if isinstance(e, dict)})
                           if isinstance(events, list) else None,
            "top_level_keys": sorted((env or {}).keys()) if isinstance(env, dict) else None,
        }
    except Exception as exc:  # noqa: BLE001 - 探针只登记，不改
        report["D_receipt"] = {"probe_error": f"{type(exc).__name__}: {exc}"}

    print(f"CONTROLS {json.dumps(report['controls'], ensure_ascii=False)}")
    print(f"A_total_leaked_ids {leaked}")
    print(f"B_keys_aligned_literally {report['B_bench']['keys_aligned_literally']} "
          f"identity_free {report['B_bench']['identity_free']} "
          f"obs_keys={report['B_bench']['observation_for_keys']}")
    print(f"C_invariance {json.dumps(report['C_invariance'], ensure_ascii=False)}")
    print(f"D_receipt {json.dumps(report.get('D_receipt'), ensure_ascii=False)}")
    print(f"FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        print(f"WROTE {args.json_path}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
