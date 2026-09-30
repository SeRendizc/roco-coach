#!/usr/bin/env python3
"""独立验收用的 **01 契约深检**（harness-verifier 自建，配合 `verify-01-contract.py`）。

覆盖 Lead 点名的读数：
  D1 `match_id` 确定性：**同己方队伍 + 同规则** 两局相同；换己方队员 ⇒ 变；换 config ⇒ 变；换 seed ⇒ **不变**；
  D2 `decision_id = <match_id>:v<state_version>`，且**推进后跟随** state_version；
  D3 `state_version == len(state.events)`，且每条事件的 `seq` == 其下标（0-based 追加序号）；
  D4 `opening_preview=true` ⇒ `opening_roster_revealed` 在 `state.events` 与回执 `opening_reveal` **同源**；
     事件只含展示字段（slot/pet_id/name），**不含** hp/energy/stats/loadout/skill_*；
  D5 **无预览 ⇒ 一条事件都不多、公开面逐字段不变**；且**只改隐藏真值**（对手真实配招 / 后备资源）
     ⇒ 公开面**逐字节相同**；
  D6 **改已展示的阵容** ⇒ 观察里的 `revealed` 确实变（反向对照，防「恒空」）。

用法: cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-01-contract-deep.py
退出码: 0 = 全过；3 = 有硬失败（逐条打印）。
"""
from __future__ import annotations

import copy
import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import schema as rschema  # noqa: E402
from roco_env import service as S  # noqa: E402

CFG = "mobile_s4_candidate_v3"
PREVIEW_KIND = "opening_roster_revealed"
SHOWN = {"slot", "pet_id", "name"}


def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False, sort_keys=True)


def battle_new(svc, rs, team, foe, *, seed=11, cfg=CFG, preview=None):
    body = {"ruleset_id": getattr(rs, "ruleset_id", None), "state_version": 0,
            "team": list(team), "enemy_team": list(foe), "seed": seed,
            "strategy": "greedy_damage", "ruleset_config_id": cfg}
    if preview is not None:
        body["opening_preview"] = preview
    status, env = svc.battle_new(body)
    return status, (env or {}), ((env or {}).get("result") or {})


def main() -> int:
    rs = D.load_ruleset()
    svc = S.RocoService()
    cand = list(rs.candidate_movesets)
    team_a, team_b, team_c = cand[0:6], cand[6:12], cand[12:18]
    fails = []

    # ── D1 match_id 确定性 ─────────────────────────────────────────────
    _, _, r1 = battle_new(svc, rs, team_a, team_b, seed=11)
    _, _, r2 = battle_new(svc, rs, team_a, team_b, seed=7)
    _, _, r3 = battle_new(svc, rs, team_a[:5] + [cand[18]], team_b, seed=11)
    # 换 config：legacy 是 3v3 模式 ⇒ 必须用 3 只，否则是 400（第一版就踩了这个）
    _, _, r4 = battle_new(svc, rs, team_a[:3], team_b[:3], seed=11, cfg="legacy_sim_v1")
    m1, m2, m3, m4 = (r.get("match_id") for r in (r1, r2, r3, r4))
    print(f"D1 match_id same_team_same_rules_diff_seed: {m1!r} vs {m2!r} -> {m1 == m2}")
    print(f"D1 own_team_change: {m1!r} -> {m3!r} differs={m1 != m3}")
    print(f"D1 config_change:   {m1!r} -> {m4!r} differs={m1 != m4}")
    if not m1 or m1 != m2:
        fails.append(f"同队同规则换 seed 后 match_id 变了：{m1} vs {m2}")
    if m1 == m3:
        fails.append("换己方队员后 match_id 没变")
    if m1 == m4:
        fails.append("换规则配置后 match_id 没变")

    # ── D2/D3 契约与事件序号 ───────────────────────────────────────────
    st0, env0, res0 = battle_new(svc, rs, team_a, team_b, preview=True)
    state0 = res0.get("state") or {}
    ev0 = state0.get("events") or []
    print(f"D2 decision_id={res0.get('decision_id')!r} match_id={res0.get('match_id')!r} "
          f"state_version={res0.get('state_version')!r}")
    if res0.get("decision_id") != f"{res0.get('match_id')}:v{res0.get('state_version')}":
        fails.append(f"decision_id 不可由 match_id+state_version 派生：{res0.get('decision_id')}")
    seqs = [e.get("seq") for e in ev0]
    print(f"D3 state_version={res0.get('state_version')} len(state.events)={len(ev0)} "
          f"state_event_seqs={seqs} envelope_rows={len(res0.get('events') or [])}")
    if res0.get("state_version") != len(ev0):
        fails.append(f"state_version({res0.get('state_version')}) != len(events)({len(ev0)})")

    # 推进一手：decision_id 跟随 state_version；envelope 行的 seq 必须指向 state.events 的下标
    legal = ((res0.get("legal") or {}).get("player") or [])
    if legal:
        a_status, a_env = svc.battle_advance(
            {"ruleset_id": getattr(rs, "ruleset_id", None),
             "state_version": res0.get("state_version"),
             "state": state0, "strategy": "greedy_damage", "action": legal[0]})
        res1 = (a_env or {}).get("result") or {}
        sv1 = res1.get("state_version")
        ev1 = (res1.get("state") or {}).get("events") or []
        rows1 = res1.get("events") or []
        seqs1 = [r.get("seq") for r in rows1]
        print(f"D2b advanced status={a_status} decision_id={res1.get('decision_id')!r} "
              f"state_version={sv1} len(state.events)={len(ev1)} envelope_seqs={seqs1}")
        if res1.get("match_id") != m1:
            fails.append(f"推进后 match_id 变了：{res1.get('match_id')} != {m1}")
        if res1.get("decision_id") != f"{m1}:v{sv1}":
            fails.append(f"推进后 decision_id 未跟随 state_version：{res1.get('decision_id')}")
        if sv1 != len(ev1):
            fails.append(f"推进后 state_version({sv1}) != len(events)({len(ev1)})")
        # envelope 行是**本跳新增**的事件：seq 必须等于它在 state.events 里的下标
        expect = list(range(len(ev1) - len(rows1), len(ev1)))
        if seqs1 != expect:
            fails.append(f"事件 seq 与 state.events 下标不符：{seqs1} != {expect}")
        kinds_state = [e.get("kind") for e in ev1[-len(rows1):]] if rows1 else []
        kinds_rows = [r.get("kind") for r in rows1]
        if kinds_state != kinds_rows:
            fails.append(f"envelope 事件与 state.events 尾部不同源：{kinds_rows} vs {kinds_state}")

    # ── D4 预览事件：同源 + 只含展示字段 ────────────────────────────────
    prev_ev = [e for e in ev0 if e.get("kind") == PREVIEW_KIND]
    rec_prev = res0.get("opening_reveal")
    print(f"D4 preview_in_state={len(prev_ev)} receipt_opening_reveal={'present' if rec_prev else 'absent'}")
    if not prev_ev or not rec_prev:
        fails.append(f"预览事件未两处齐备：state={len(prev_ev)} receipt={bool(rec_prev)}")
    else:
        # 「同源」的判法：**实质载荷（kind/turn/detail）逐字相同**；回执行允许带信封装饰键
        # （`seq`/`text` 是 `_sim_envelope` 给每一条事件行统一加的，不是第二份事实）。
        se, re_ = prev_ev[0], rec_prev
        core = lambda d: dumps({k: d.get(k) for k in ("kind", "turn", "detail")})  # noqa: E731
        extra = sorted(set(re_) - set(se))
        print(f"D4 same_source(kind/turn/detail)={core(se) == core(re_)} "
              f"receipt_extra_keys={extra}")
        if core(se) != core(re_):
            fails.append("预览事件与回执 opening_reveal 的实质载荷不同（不是同源）")
        if set(extra) - {"seq", "text"}:
            fails.append(f"回执 opening_reveal 多出非信封键：{sorted(set(extra) - {'seq', 'text'})}")
        detail = prev_ev[0].get("detail") or {}
        roster = detail.get("roster") or []
        keys = sorted({k for row in roster for k in row})
        blob = dumps(detail)
        bad = [k for k in ("hp", "max_hp", "energy", "stats", "loadout", "panel", "talent",
                           "nature", "skills") if k in blob]
        print(f"D4 roster_rows={len(roster)} row_keys={keys} forbidden_in_blob={bad}")
        if not roster:
            fails.append("预览事件 roster 为空")
        if set(keys) - SHOWN:
            fails.append(f"预览事件含展示字段之外的键：{sorted(set(keys) - SHOWN)}")
        if bad:
            fails.append(f"预览事件含隐藏字段：{bad}")

    # ── D5 无预览：不多事件、公开面逐字段不变；只改隐藏真值不影响公开面 ──
    _, _, off1 = battle_new(svc, rs, team_a, team_b, preview=None)
    _, _, off2 = battle_new(svc, rs, team_a, team_b, preview=False)
    off_ev = (off1.get("state") or {}).get("events") or []
    print(f"D5 no_preview events={[e.get('kind') for e in off_ev]} "
          f"state_version={off1.get('state_version')} opening_reveal_key={'opening_reveal' in (off1 or {})}")
    if off_ev:
        fails.append(f"无预览却有事件：{[e.get('kind') for e in off_ev]}")
    if off1.get("state_version") != 0:
        fails.append(f"无预览 state_version={off1.get('state_version')} != 0")
    if "opening_reveal" in off1:
        fails.append("无预览却给了 opening_reveal 键")
    if dumps(off1.get("public")) != dumps(off2.get("public")):
        fails.append("省略 opening_preview 与显式 false 的公开面不同")

    # 只改隐藏真值：对手真实配招 / 后备资源 / 隐藏面板 ⇒ 公开面逐字节相同
    st_a = E.reset(team_a, team_b, seed=20260930, rs=rs, config=CFG)
    base_pub = dumps(E.public_planner_state(st_a, rs, "player"))
    base_ui = dumps(E.ui_public_view(st_a, rs, "player"))
    base_obs = dumps(rschema.observation_for(st_a, rs, "player"))

    st_b = E.reset(team_a, team_b, seed=20260930, rs=rs, config=CFG)
    foe_pid = st_b.enemy.field_pet.pet_id
    real = list((st_b.enemy.loadouts or {}).get(foe_pid) or [])
    swapped = False
    if len(real) >= 2:
        # 换掉对手这一只的**真实配招**里的一招（隐藏真值）
        decoy = next((s for s in sorted(rs.skills)
                      if s not in real and s != real[0]), None)
        if decoy:
            st_b.enemy.loadouts[foe_pid] = [decoy] + real[1:]
            swapped = True
    idx = [i for i in range(len(st_b.enemy.pets)) if i != st_b.enemy.active]
    st_b.enemy.pets[idx[0]].hp = 7
    st_b.enemy.pets[idx[0]].energy = 3
    pub_b = dumps(E.public_planner_state(st_b, rs, "player"))
    ui_b = dumps(E.ui_public_view(st_b, rs, "player"))
    obs_b = dumps(rschema.observation_for(st_b, rs, "player"))
    print(f"D5 hidden_truth_change public_same={base_pub == pub_b} ui_same={base_ui == ui_b} "
          f"obs_same={base_obs == obs_b} (opponent loadout swapped={swapped})")
    if not (base_pub == pub_b and base_ui == ui_b and base_obs == obs_b):
        fails.append("改对手隐藏真值后公开面变了（泄漏）")

    # ── D6 改已展示阵容 ⇒ revealed 确实变（反向对照） ────────────────────
    _, _, pb = battle_new(svc, rs, team_a, team_b, preview=True)
    _, _, pc = battle_new(svc, rs, team_a, team_c, preview=True)
    rb = (pb.get("state") or {}).get("events") or []
    rc = (pc.get("state") or {}).get("events") or []
    ro_b = [e for e in rb if e.get("kind") == PREVIEW_KIND]
    ro_c = [e for e in rc if e.get("kind") == PREVIEW_KIND]
    names_b = [r.get("pet_id") for r in ((ro_b[0].get("detail") or {}).get("roster") or [])] if ro_b else []
    names_c = [r.get("pet_id") for r in ((ro_c[0].get("detail") or {}).get("roster") or [])] if ro_c else []
    print(f"D6 roster_B={names_b} roster_C={names_c} differ={names_b != names_c}")
    if not names_b or not names_c or names_b == names_c:
        fails.append("换已展示阵容后 revealed 没变（反向对照失败）")

    print(f"DEEP_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
