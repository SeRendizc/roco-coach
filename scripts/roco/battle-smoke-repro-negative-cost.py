#!/usr/bin/env python3
"""B 段 · **负能耗整局中断**的最小、自足复现（不依赖任何一次冒烟的随机轨迹）。

被复现的缺陷（人类 2026-09-29 口径：这一条要进**机制缺口**那一列，不算「可玩」）：

    一个**已经出现在合法动作列表里**的技能，会在同一回合结算到一半时变成非法，
    而引擎把这个矛盾以「未处理异常」的形式抛出去 —— **整局中断**，不是把这一手作废。

  机制侧：`skill_000494`「绞轮」（基础能耗 5）的描述是
      「造成物伤，每受到1次抵抗的技能攻击（不含连击），本技能能耗永久-1。」
      —— 引擎**实现了一半**：`skill_ramps[skill_000494].cost` 真的每回合往下走；
      缺的是「能耗被压到 0 以下怎么办」（术语没定义，MC-018），引擎按纪律 fail closed。

  缺陷侧（接口不自洽）：
      1. 回合开始时 ramp = -5 ⇒ `effective_skill_cost` = 0 ⇒ `legal_actions` 把它列为**合法**，
         对手策略据此选中它；
      2. 同一回合的行动顺序里，我方先出手且这一下被**属性抵抗** ⇒ `_accumulate_on_hit_ramps`
         再 -1 ⇒ ramp = -6；
      3. 轮到它结算时 `_execute` **重新**算一次能耗 = 5 + (-6) = **-1**
         ⇒ `env.py:928` 抛 `UnsupportedEffect`；
      4. `step_joint` 不接这个异常，`service.battle_advance` 只接 `ValueError/RulesetError`
         ⇒ 服务层兜底 `internal_error` ⇒ Node 报 HTTP 400 ⇒ 玩家那一手打不出去、**重试必复现**。

复现配方（确定性）：
    我方：黑羽夫人（`pet_000446`）+ 5 只确定性补位，配招含 `skill_000696`「鸣叫」（翼系·能耗 0）
    对手：溯源钟（`pet_000482`）+ 5 只确定性补位，配招含 `skill_000494`「绞轮」
    打法：换出→换入（覆盖入场），随后**反复用鸣叫**打对手场上那只（翼系打机械系 = 属性抵抗）
          ⇒ ramp 每次都 -1；到 -5 那一回合，对手策略会选中绞轮，而我们在同一回合先出手。

用法：
    python3 scripts/roco/battle-smoke-repro-negative-cost.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import service as SVC  # noqa: E402
from roco_env import env as env_mod  # noqa: E402
from roco_env import data as DATA  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import Action  # noqa: E402

SMOKE = os.path.join(ROOT, "reports", "roco", "battle-smoke")
CONFIG_ID = "mobile_s4_candidate_v3"
OVERRIDES = [{
    "path": "turn_order.speed_tie", "value": "random_seeded",
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "同速平手裁决在候选配置里是 UNKNOWN（MC-E05 未录制）",
    "microcase_id": "MC-E05",
}]
ATTACKER = "pet_000446"      # 黑羽夫人：翼系，配招里有「鸣叫」skill_000696（能耗 0）
TARGET = "pet_000482"        # 溯源钟：机械系/幻系，配招里有「绞轮」skill_000494
RESISTED = "skill_000696"    # 鸣叫
RAMPLED = "skill_000494"     # 绞轮


def pick_fillers(rs, exclude: List[str], n: int = 5) -> List[str]:
    out = []
    for pid in sorted(rs.pets):
        if pid in exclude:
            continue
        out.append(pid)
        if len(out) >= n:
            break
    return out


def digest(state) -> Dict[str, Any]:
    d = state.to_dict()
    out: Dict[str, Any] = {"turn": d.get("turn"), "phase": d.get("phase"), "result": d.get("result")}
    for side in ("player", "enemy"):
        s = d.get(side) or {}
        out[side] = {"active": s.get("active"), "pets": [{
            "slot": p.get("slot"), "pet_id": p.get("pet_id"),
            "hp": p.get("hp"), "max_hp": p.get("max_hp"), "energy": p.get("energy"),
            "fainted": p.get("fainted"),
            "skill_ramps": p.get("skill_ramps") or {},
            "energy_cost_mods": p.get("energy_cost_mods") or [],
        } for p in (s.get("pets") or [])]}
    return out


def cost_now(state, rs, side: str, skill_id: str) -> Optional[int]:
    """和引擎**同一个读点**算一遍（配置也要同一份，否则 ramp 这一档根本不参与）。"""
    try:
        cfg = RC.get_rule_config(state.ruleset_config_id or None)
        pet = getattr(state, side).field_pet
        return env_mod.effective_skill_cost(pet, rs.skill(skill_id), cfg,
                                            weather=state.weather,
                                            foe_status_layers=env_mod._poison_layers(state, side))
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    svc = SVC.RocoService()
    rs, why = svc.cache.get(DATA.DEFAULT_RULESET)
    if rs is None:
        print(json.dumps({"ok": False, "error": why}, ensure_ascii=False))
        return 2

    team = [ATTACKER] + pick_fillers(rs, [ATTACKER, TARGET])
    enemy = [TARGET] + pick_fillers(rs, [ATTACKER, TARGET] + team)
    loadouts = {pid: list(rs.candidate_moveset(pid)) for pid in set(team + enemy)}
    if RESISTED not in loadouts[ATTACKER] or RAMPLED not in loadouts[TARGET]:
        return 3

    status, env = svc.battle_new({
        "team": team, "enemy_team": enemy, "seed": 20260921, "strategy": "greedy_damage",
        "ruleset_config_id": CONFIG_ID, "unverified_overrides": OVERRIDES,
        "state_version": 0, "loadouts": loadouts,
    })
    if not env.get("ok"):
        print(json.dumps({"ok": False, "stage": "battle_new", "status": status,
                          "error": env.get("error")}, ensure_ascii=False))
        return 2
    r = env["result"]
    state_dict, sv = r["state"], r["state_version"]

    timeline: List[Dict[str, Any]] = []
    cancels: List[Dict[str, Any]] = []
    failure: Optional[Dict[str, Any]] = None
    switched_out = switched_in = False
    interesting = False          # 已经过了「ramp 到 0、下回合被压到负」那一段
    max_turns_seen = 0

    for i in range(240):
        live, rs2, early = svc._private_state(
            {"state": state_dict, "ruleset_config_id": CONFIG_ID, "state_version": sv},
            time.perf_counter())
        if early is not None:
            break
        if live.result:
            break
        legal = env_mod.legal_actions(live, rs2, "player")
        if not legal:
            break
        ramps = dict(live.enemy.field_pet.skill_ramps or {})
        ramp_cost = (ramps.get(RAMPLED) or {}).get("cost")
        eff = cost_now(live, rs2, "enemy", RAMPLED)
        in_legal = any(a.kind == "skill" and a.skill_id == RAMPLED
                       for a in env_mod.legal_actions(live, rs2, "enemy"))
        timeline.append({
            "i": i, "turn": live.turn, "phase": live.phase,
            "enemy_field": live.enemy.field_pet.pet_id,
            "my_field": live.player.field_pet.pet_id,
            "enemy_ramp_skill_000494": ramp_cost,
            "enemy_effective_cost_skill_000494": eff,
            "rampled_in_enemy_legal": in_legal,
        })
        if eff is None or eff < 0:
            interesting = True

        # ── 打法：先「换出 → 换入」覆盖入场，再用鸣叫刷抵抗命中（每次给绞轮 -1），
        # 过了那一段之后改用最强攻击把这一局**打完**（要的是「能结算」）。
        switches = [a for a in legal if a.kind == "switch"]
        skills = [a for a in legal if a.kind == "skill"]
        if live.phase == "replace":
            action = switches[0] if switches else None
        elif not interesting:
            if live.player.field_pet.pet_id != ATTACKER or live.player.field_pet.fainted:
                back = next((a for a in switches if a.target_index == 0), None)
                action = back or (switches[0] if switches else (skills[0] if skills else None))
            else:
                action = (next((a for a in skills if a.skill_id == RESISTED), None)
                          or (skills[0] if skills else None))
        else:
            def _power(a):
                sk = rs2.skills.get(a.skill_id)
                pw = getattr(sk, "power", None) if sk is not None else None
                return float(pw) if isinstance(pw, (int, float)) else -1.0
            action = (max(skills, key=_power) if skills
                      else (next((a for a in legal if a.kind == "charge"), None)
                            or (switches[0] if switches else legal[0])))
            if live.player.field_pet.fainted and switches:
                action = switches[0]
        if action is None:
            break
        if action.kind == "switch":
            if live.player.field_pet.pet_id == ATTACKER and action.target_index != 0:
                switched_out = True
            elif switched_out and action.target_index == 0:
                switched_in = True

        try:
            status, env2 = svc.battle_advance({"state": state_dict, "action": action.to_dict(),
                                               "strategy": "greedy_damage", "state_version": sv})
        except Exception as exc:  # noqa: BLE001 —— 修前就是从这里炸出去的
            failure = {"stage": "exception", "at_index": i, "turn": live.turn,
                       "action": action.to_dict(),
                       "exception_type": type(exc).__name__, "message": str(exc),
                       "traceback": traceback.format_exc().splitlines()[-16:],
                       "state_before": digest(live)}
            break
        if not env2.get("ok"):
            failure = {"stage": "engine_error", "at_index": i, "turn": live.turn,
                       "action": action.to_dict(),
                       "status": status, "error_type": env2.get("error_type"),
                       "error": env2.get("error"), "state_before": digest(live)}
            break
        r = env2["result"]
        state_dict, sv = r["state"], r["state_version"]
        max_turns_seen = max(max_turns_seen, r["turn"])
        for e in r.get("events") or []:
            if e.get("kind") == "action_cancelled":
                cancels.append({"turn": e.get("turn"), "detail": e.get("detail"),
                                "text": e.get("text")})

    final_unsupported = state_dict.get("unsupported") or []
    settled = state_dict.get("result") in ("win", "loss", "draw")

    before = None
    before_path = os.path.join(SMOKE, "negative-energy-cost-repro.before.json")
    if os.path.exists(before_path):
        try:
            with open(before_path, encoding="utf-8") as fh:
                b = json.load(fh)
            before = {
                "artifact": b.get("artifact"),
                "outcome": "crash" if b.get("reproduced") else "settled",
                "turn": (b.get("failure") or {}).get("state_before", {}).get("turn"),
                "exception_type": (b.get("failure") or {}).get("exception_type"),
                "message": (b.get("failure") or {}).get("message"),
                "timeline_tail": (b.get("timeline") or [])[-3:],
            }
        except Exception:  # noqa: BLE001
            before = None

    out = {
        "schema_version": 2,
        "artifact": "battle-smoke-repro-negative-cost",
        "how": "自足复现：不依赖任何一次冒烟的轨迹，按配方现打一遍（引擎确定性 ⇒ 逐位可复现）",
        "ruleset_id": rs.ruleset_id,
        "ruleset_config_id": CONFIG_ID,
        "seed": 20260921,
        "team": team, "enemy_team": enemy,
        "attacker": {"pet_id": ATTACKER, "name": rs.pets[ATTACKER].name, "skill": RESISTED,
                     "skill_name": rs.skill(RESISTED).name},
        "rampled": {"pet_id": TARGET, "name": rs.pets[TARGET].name, "skill": RAMPLED,
                    "skill_name": rs.skill(RAMPLED).name,
                    "desc": rs.skill(RAMPLED).desc, "base_energy": rs.skill(RAMPLED).energy},
        "outcome": "crash" if failure else ("settled" if settled else "unfinished"),
        "crash": failure,
        "battle_result": state_dict.get("result"),
        "turns": max_turns_used if (max_turns_used := state_dict.get("turn")) is not None else max_turns_seen,
        "cancellations": cancels,
        "unsupported_entries": final_unsupported,
        "timeline": timeline,
        "reading": {
            "① 合法动作口径": (
                "绞轮的有效能耗被压到负值之后，`legal_actions` **不再提供这一手**"
                "（timeline 里 `rampled_in_enemy_legal` 从 true 翻成 false），"
                "与 `_execute` 的扣费口径读的是同一个 `resolved_skill_cost`。"),
            "② 兜底": (
                "被压到负值的那**一个回合**（合法动作表是回合开始时算的，中途才被改）"
                "由 `_cancel_unresolvable_skill` 在执行前拦下：这一手不结算、如实登记、"
                "产出一条可结算的 `action_cancelled{reason: energy_cost_unresolved}`，**整局继续**。"),
            "缺口计数": (
                "skill_000494 仍然在②机制核验那一列的缺口里 —— 引擎**没有**给负能耗定下限，"
                "这一条只修「别炸整局」，不是「这条机制现在支持了」。"),
        },
        "before_after": {
            "before": before,
            "after": {"outcome": "crash" if failure else ("settled" if settled else "unfinished"),
                      "battle_result": state_dict.get("result"),
                      "cancellations": len(cancels),
                      "unsupported_entries": len(final_unsupported)},
        },
        "repro_command": "python3 scripts/roco/battle-smoke-repro-negative-cost.py",
    }
    os.makedirs(SMOKE, exist_ok=True)
    with open(os.path.join(SMOKE, "negative-energy-cost-repro.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps({"outcome": out["outcome"], "battle_result": out["battle_result"],
                      "turns": out["turns"], "cancellations": len(cancels),
                      "unsupported_entries": len(final_unsupported),
                      "crash": (failure or {}).get("message")}, ensure_ascii=False))
    print("→ reports/roco/battle-smoke/negative-energy-cost-repro.json")
    # 修好之后期望：能结算 + 至少一条 action_cancelled（原因可读）+ 无未处理异常
    ok = failure is None and settled and any(
        (c.get("detail") or {}).get("reason") == "energy_cost_unresolved" for c in cancels)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
