#!/usr/bin/env python3
"""task-5 · **负能耗入口全扫**：把「能耗可能被压到 0 以下」的每一类都当场打一遍。

为什么要有这一份：修 `skill_000494`「绞轮」时最怕的是「只把这一只堵上」。
真正的入口是**一类**：有效能耗 = 基础 + 逐技能 ramp + 每条能耗修正 + 每层中毒 + 天气，
任何一项把总数压到 < 0 都走同一条路。所以这里按**机制**而不是按技能名扫：

  ① `skill_ramps`（「本技能能耗永久±N」）—— 12 条会**减**的技能，逐条打；
  ② `energy_cost_mods`（特性/印记给的全技能或分作用域修正）—— 对一个基础能耗 0 的技能也能压负；
  ③ 组合（ramp + 修正）—— 单看每一项都不为负、合起来为负。

每一类都要同时成立三件事（这就是「口径自洽」的判据）：
  A. 有效能耗 < 0 时 **`legal_actions` 不提供这一手**；
  B. 直接调 `_execute` 仍然 `raise UnsupportedEffect`（fail closed，**不猜 0**）；
  C. 走 `step_joint` 时，**合法动作表算完之后才被压负**的那一手不会炸整局 ——
     变成一条可结算的 `action_cancelled{reason: energy_cost_unresolved}` 事件，回合走完。

用法：
    python3 scripts/roco/battle-smoke-negative-cost-scan.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as DATA  # noqa: E402
from roco_env import env as env_mod  # noqa: E402
from roco_env import effects as fx  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env import traits as tr  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

SMOKE = os.path.join(ROOT, "reports", "roco", "battle-smoke")
CONFIG_ID = "mobile_s4_candidate_v3"
OVERRIDES = [{
    "path": "turn_order.speed_tie", "value": "random_seeded",
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "同速平手裁决在候选配置里是 UNKNOWN（MC-E05 未录制）",
    "microcase_id": "MC-E05",
}]
PLAIN = "需要 1 点能量的对照技能"          # 见 owner_of_skill：不参与，只是占位文档


def _loadout_with(rs, pet_id: str, skill_id: str) -> Optional[List[str]]:
    """把 `skill_id` 塞进这只精灵的四个技能里（其余用规范配招补齐，保证可学）。"""
    base = [s for s in rs.candidate_moveset(pet_id) if s != skill_id][:3]
    if not rs.is_learnable(pet_id, skill_id):
        return None
    return [skill_id] + base


def owner_of_skill(rs, skill_id: str) -> Optional[str]:
    """找一个**学得到**这条技能的物种（优先已拥有清单里的，保证是真实用法）。"""
    for pid in sorted(rs.pets):
        if rs.is_learnable(pid, skill_id):
            return pid
    return None


def make_state(rs, cfg, owner: str, skill_id: str):
    """建一局：这一只首发，配招含目标技能。对手用确定性的一队。"""
    loadout = _loadout_with(rs, owner, skill_id)
    if loadout is None:
        return None
    others = [p for p in sorted(rs.pets) if p != owner][:5]
    team = [owner] + others
    enemy = [p for p in sorted(rs.pets) if p not in team][:6]
    loadouts = {pid: list(rs.candidate_moveset(pid)) for pid in set(team + enemy)}
    loadouts[owner] = loadout
    try:
        return env_mod.reset(team, enemy, seed=20260921, rs=rs, loadouts=loadouts,
                             config=cfg, unverified_overrides=OVERRIDES)
    except Exception:  # noqa: BLE001
        return None


def legal_has(state, rs, cfg, skill_id: str) -> bool:
    return any(a.kind == ACTION_SKILL and a.skill_id == skill_id
               for a in env_mod.legal_actions(state, rs, "player", cfg))


def run_case(rs, cfg, *, skill_id: str, mechanism: str,
             ramp: Optional[int], mods: List[int]) -> Dict[str, Any]:
    owner = owner_of_skill(rs, skill_id)
    row: Dict[str, Any] = {"skill_id": skill_id, "mechanism": mechanism,
                           "owner": owner, "ramp": ramp, "mods": mods}
    if owner is None:
        row.update({"ok": None, "skipped": True, "reason": (
            "规则集的学习表里**没有任何物种**学得到这条技能（`is_learnable` 全 False）"
            "⇒ 它不可能出现在任何配招里，够不到这条入口")})
        return row
    state = make_state(rs, cfg, owner, skill_id)
    if state is None:
        row.update({"ok": False, "reason": "建局失败（配招不可学 / 队伍不合规模）"})
        return row
    pet = state.player.field_pet
    row["pet_id"] = pet.pet_id
    row["base_energy"] = int(rs.skill(skill_id).energy)
    if ramp is not None:
        pet.skill_ramps = dict(pet.skill_ramps or {})
        pet.skill_ramps[skill_id] = {"cost": int(ramp), "power": 0, "hits": 0}
    for delta in mods:
        tr.grant_energy_cost_mod(pet, scope="all", delta=delta, source="负能耗扫描")

    eff = env_mod.resolved_skill_cost(state, "player", rs.skill(skill_id), cfg)
    row["effective_cost"] = eff
    row["A_legal_when_negative"] = legal_has(state, rs, cfg, skill_id)
    # B：直接调 `_execute`（测试/脚本这条入口）仍须 fail closed
    pet.energy = cfg.energy_max
    before_events = len(state.events)
    try:
        env_mod._execute(state, rs, "player", Action(ACTION_SKILL, skill_id=skill_id), cfg)
        exc_type = None
    except fx.UnsupportedEffect as exc:
        exc_type = type(exc).__name__
        row["B_execute_raise"] = str(exc)
    except Exception as exc:  # noqa: BLE001
        exc_type = f"{type(exc).__name__}: {exc}"
        row["B_execute_raise"] = exc_type
    else:
        row["B_execute_raise"] = None
    row["B_fail_closed"] = exc_type == "UnsupportedEffect"
    row["B_energy_untouched"] = int(pet.energy) == int(cfg.energy_max)
    del before_events

    # C：把「合法表算完之后才被压负」那一幕演出来 —— 但**不能**用 `step_joint` 直接演：
    # `step_joint` 开头会用**当时的**状态重算一次合法动作表，我先改 ramp 就会被它拦成
    # `ValueError(行动不合法)`（那是脚本演错了，不是引擎的问题）。
    # 真实窗口是「合法表在回合开始时算好 → 同一回合里先出手的一方把能耗压下去」，
    # 所以这里演的是**那一刻**：先把「cost == 0 时的合法」拿到手，再把能耗压负，
    # 然后调执行前的那道守卫 `_cancel_unresolvable_skill`（`step_joint` 在同一位置调它）。
    # 端到端集成由 `scripts/roco/battle-smoke-repro-negative-cost.py` 用真实对局证明。
    state2 = make_state(rs, cfg, owner, skill_id)
    if state2 is None:
        row["C_guard_ok"] = None
        return row
    pet2 = state2.player.field_pet
    zero_ramp = -int(rs.skill(skill_id).energy)          # 让 cost 恰好 = 0
    pet2.skill_ramps = dict(pet2.skill_ramps or {})
    pet2.skill_ramps[skill_id] = {"cost": zero_ramp, "power": 0, "hits": 0}
    # 基础能耗 0 的技能靠 ramp 到不了负数，用一条全技能修正补（同一类入口）
    if zero_ramp == 0 and not mods:
        tr.grant_energy_cost_mod(pet2, scope="all", delta=-1, source="负能耗扫描")
    row["C_cost_at_list_time"] = env_mod.resolved_skill_cost(
        state2, "player", rs.skill(skill_id), cfg)
    row["C_listed_at_zero"] = legal_has(state2, rs, cfg, skill_id)
    # 中途再压一格：合法表已经算过了
    if zero_ramp != 0:
        pet2.skill_ramps[skill_id]["cost"] = zero_ramp - 1
    else:
        tr.grant_energy_cost_mod(pet2, scope="all", delta=-1, source="负能耗扫描-中途")
    row["C_cost_at_execute_time"] = env_mod.resolved_skill_cost(
        state2, "player", rs.skill(skill_id), cfg)
    energy_before = int(pet2.energy)
    version_before = int(state2.state_version)
    try:
        cancelled = env_mod._cancel_unresolvable_skill(
            state2, rs, "player", Action(ACTION_SKILL, skill_id=skill_id), cfg)
        row["C_guard_exception"] = None
    except Exception as exc:  # noqa: BLE001
        cancelled = None
        row["C_guard_exception"] = f"{type(exc).__name__}: {exc}"
    row["C_cancelled"] = cancelled
    cancels = [e.detail for e in state2.events
               if e.kind == "action_cancelled"
               and (e.detail or {}).get("reason") == "energy_cost_unresolved"]
    row["C_cancelled_events"] = cancels
    row["C_energy_untouched"] = int(pet2.energy) == energy_before
    row["C_unsupported_recorded"] = any(
        u.get("evidence") == skill_id for u in (state2.unsupported or []))
    row["C_state_version_bumped"] = int(state2.state_version) > version_before
    # 这一手的 ramp 触发时机能不能落进同回合的窗口里（**启发式**，只用来分类，不当判据）
    desc = str(rs.skill(skill_id).desc or "")
    row["C_window_heuristic"] = (
        "同回合窗口可能（对手先出手就会改能耗）"
        if any(k in desc for k in ("每受到", "每被攻击", "应对")) else
        "同回合窗口不存在（这一手的能耗由自己出手/回合末决定）")
    row["ok"] = (
        eff is not None and eff < 0
        and row["A_legal_when_negative"] is False
        and row["B_fail_closed"] is True
        and row["B_energy_untouched"] is True
        and row["C_listed_at_zero"] is True
        and row["C_cost_at_execute_time"] is not None and row["C_cost_at_execute_time"] < 0
        and cancelled is True
        and len(cancels) == 1
        and row["C_energy_untouched"] is True
        and row["C_unsupported_recorded"] is True
    )
    return row


def residual_unsupported_probe(rs, cfg) -> Dict[str, Any]:
    """② 的另一半：**非能耗**的残留 unsupported 也要分开判 ——
    「玩家路径能结算」+「planner 那条路仍然抛（-inf 信号不丢）」。

    样例用的是「硬门」`skill_000671`：一条**描述里读不出减伤比例**的防御技能。
    它和绞轮是同一类缺陷（**合法动作 → 结算时解不出 → 未处理异常炸整局**），
    只是触发点不在能耗上。所以这里必须证明两件事同时成立：
      · `step_joint` 默认（搜索/推演走这条）仍然抛 `UnsupportedEffect`；
      · 玩家路径 `service.battle_advance`（它传 `tolerate_unsupported=True`）能结算。
    """
    from roco_env import service as SVC
    rows = [s for s in rs.skills.values() if s.name == "硬门"]
    if not rows:
        return {"ok": False, "reason": "规则集里找不到「硬门」"}
    hard = rows[0].skill_id
    owners = [pid for pid in sorted(rs.pets) if rs.is_learnable(pid, hard)]
    if not owners:
        return {"ok": False, "reason": "没有物种学得到「硬门」"}
    owner = owners[0]
    others = [p for p in sorted(rs.pets) if p != owner][:5]
    team = [owner] + others
    enemy = [p for p in sorted(rs.pets) if p not in team][:6]
    loadouts = {pid: list(rs.candidate_moveset(pid)) for pid in set(team + enemy)}
    loadouts[owner] = [hard]
    svc = SVC.RocoService()
    status, env = svc.battle_new({
        "team": team, "enemy_team": enemy, "seed": 1, "strategy": "greedy_damage",
        "ruleset_config_id": CONFIG_ID, "unverified_overrides": OVERRIDES,
        "state_version": 0, "loadouts": loadouts,
    })
    out: Dict[str, Any] = {"skill_id": hard, "skill_name": rows[0].name, "owner": owner}
    if not env.get("ok"):
        out.update({"ok": False, "reason": f"battle_new 失败：{env.get('error')}"})
        return out
    r = env["result"]
    out["in_player_legal"] = any(a.get("skill_id") == hard for a in r["legal"]["player"])
    live, rs2, early = svc._private_state(
        {"state": r["state"], "ruleset_config_id": CONFIG_ID, "state_version": 0},
        time.perf_counter())
    enemy_skill = next((a for a in env_mod.legal_actions(live, rs2, "enemy")
                        if a.kind == ACTION_SKILL), None)
    try:
        env_mod.step_joint(live, rs2, Action(ACTION_SKILL, skill_id=hard), enemy_skill)
        out["default_step_joint_raises"] = False
    except fx.UnsupportedEffect as exc:
        out["default_step_joint_raises"] = True
        out["default_step_joint_message"] = str(exc)
    except Exception as exc:  # noqa: BLE001
        out["default_step_joint_raises"] = f"{type(exc).__name__}: {exc}"
    status2, env2 = svc.battle_advance({
        "state": r["state"], "action": {"kind": ACTION_SKILL, "skill_id": hard},
        "strategy": "greedy_damage", "state_version": r["state_version"]})
    out["player_path_ok"] = bool(env2.get("ok"))
    out["player_path_status"] = status2
    out["player_path_error_type"] = env2.get("error_type")
    if env2.get("ok"):
        evs = [e for e in (env2["result"].get("events") or [])
               if e.get("kind") == "action_cancelled"]
        out["player_path_cancellations"] = [e.get("detail") for e in evs]
        out["player_path_cancel_text"] = [e.get("text") for e in evs]
        out["player_path_unsupported"] = env2["result"].get("unsupported_seen") or []
    out["ok"] = (out["in_player_legal"] is True
                 and out["default_step_joint_raises"] is True
                 and out["player_path_ok"] is True
                 and len(out.get("player_path_cancellations") or []) == 1)
    return out


def main() -> int:
    started = time.time()
    rs = DATA.load_ruleset()
    cfg = RC.get_rule_config(CONFIG_ID)
    ramp_skills = sorted({s.skill_id for s in rs.skills.values()
                          if s.desc and "能耗永久" in s.desc and (
                              "能耗永久-1" in s.desc or "能耗永久-2" in s.desc
                              or "能耗永久-3" in s.desc or "能耗永久-5" in s.desc
                              or "能耗永久-6" in s.desc)})
    # 基础能耗 0 的那几条（洄游/机械变式/赤子之心）单靠 ramp 到不了负数 —— 用能耗修正那一类补
    cases: List[Tuple[str, str, Optional[int], List[int]]] = []
    for sid in ramp_skills:
        cases.append((sid, "skill_ramps（本技能能耗永久-N）",
                      -(int(rs.skill(sid).energy) + 1), []))
    # ② 能耗修正：拿一条基础能耗 0 的技能，挂 -1 的全技能修正 —— 0 也能被压负
    zero_base = next((s.skill_id for s in rs.skills.values()
                      if not s.is_trait and int(s.energy or 0) == 0 and not s.is_defense), None)
    if zero_base:
        cases.append((zero_base, "energy_cost_mods（全技能修正把 0 压成 -1）", None, [-1]))
    # ③ 组合：ramp 只压一半，剩下靠修正 —— 单看每一项都不为负
    combo = next((sid for sid in ramp_skills if int(rs.skill(sid).energy) >= 4), None)
    if combo:
        half = -int(rs.skill(combo).energy) // 2
        cases.append((combo, "组合（ramp 一半 + 修正一半）", half, [-(int(rs.skill(combo).energy) - abs(half)) - 1]))

    rows = []
    for sid, mech, ramp, mods in cases:
        try:
            rows.append(run_case(rs, cfg, skill_id=sid, mechanism=mech, ramp=ramp, mods=mods))
        except Exception as exc:  # noqa: BLE001
            rows.append({"skill_id": sid, "mechanism": mech, "ok": False,
                         "reason": f"扫描本身炸了：{type(exc).__name__}: {exc}"})

    out = {
        "schema_version": 1,
        "artifact": "battle-smoke-negative-cost-scan",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "ruleset_id": rs.ruleset_id, "ruleset_config_id": CONFIG_ID,
        "why": ("修绞轮最怕「只堵这一只」。入口是一**类**：有效能耗 = 基础 + ramp + 能耗修正 + "
                "每层中毒 + 天气，任一项把总数压到 <0 都走同一条路。这里按机制逐类当场打一遍。"),
        "criteria": {
            "A": "有效能耗 < 0 ⇒ legal_actions 不提供这一手",
            "B": "直接 _execute 仍 UnsupportedEffect（fail closed，不猜 0，且没扣能量）",
            "C": "走 step_joint：合法表算完之后才被压负 ⇒ 不炸整局，产出 1 条 "
                 "action_cancelled{reason: energy_cost_unresolved} 且回合走完",
        },
        "ramp_skill_count": len(ramp_skills),
        "cases": rows,
        "residual_unsupported_probe": residual_unsupported_probe(rs, cfg),
        "counts": {"cases": len(rows), "ok": sum(1 for r in rows if r.get("ok") is True),
                   "skipped": sum(1 for r in rows if r.get("skipped")),
                   "failed": sum(1 for r in rows if r.get("ok") is False)},
        "elapsed_s": round(time.time() - started, 1),
    }
    os.makedirs(SMOKE, exist_ok=True)
    with open(os.path.join(SMOKE, "negative-cost-scan.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps(out["counts"], ensure_ascii=False))
    probe = out["residual_unsupported_probe"]
    print("  ② 残留 unsupported（非能耗，样例「硬门」）:", json.dumps(
        {k: probe.get(k) for k in ("skill_id", "in_player_legal", "default_step_joint_raises",
                                    "player_path_ok", "player_path_status",
                                    "player_path_cancel_text", "ok")},
        ensure_ascii=False))
    for r in rows:
        if r.get("skipped"):
            print("  SKIP", r.get("skill_id"), r.get("reason"))
            continue
        if not r.get("ok"):
            print("  FAIL", r.get("skill_id"), r.get("mechanism"), "|",
                  r.get("reason") or {k: r.get(k) for k in
                                      ("effective_cost", "A_legal_when_negative", "B_fail_closed",
                                       "C_listed_at_zero", "C_step_joint_continues",
                                       "C_exception", "C_cancelled_events")})
    print(f"→ {os.path.join(SMOKE, 'negative-cost-scan.json')}")
    return 0 if (out["counts"]["failed"] == 0
                 and out["residual_unsupported_probe"].get("ok") is True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
