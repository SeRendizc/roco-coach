#!/usr/bin/env python3
"""B 段 · 全量逐只最小战斗冒烟（**引擎侧**，进程内直调产品的引擎入口）。

为什么走 `RocoService` 而不是 `env.reset`：
    Node 的 `RocoClient` 把请求发给 `roco/src/roco_env/service.py` 起的 HTTP 服务；
    `RocoService.battle_new / battle_advance` 就是那个服务在 `_dispatch` 里调的函数。
    进程内直调 = 同一个入口、同一份结算代码，只省掉 socket。产品链路上
    「开局 → 出手 → 结算」要过的每一道校验（`validate_team`、合法动作裁剪、
    未核验覆盖、fail closed）在这里一模一样地过。

产出（`reports/roco/battle-smoke/engine-sweep.json`）每只一条记录：
    ① 能被选进队（实例 → 物种在规则集里）
    ② 组成合法六只（reset/validate_team 通过）
    ③ 开局（battle_new 200、turn=1、有合法动作）
    ④ 出手（它那四个技能逐个真的被引擎接受 / 换出换入）
    ⑤ 打到结算（state.result != None）
**两列分开**：`playable`（上面五步）与 `mechanism`（决定性效果引擎实现了没有、
有没有实机核验）。引擎没实现的子效果走 `state.unsupported` 如实登记，绝不算成结算。

用法：
    python3 scripts/roco/battle-smoke-engine.py                     # 全量 542
    python3 scripts/roco/battle-smoke-engine.py --limit 20          # 冒烟
    python3 scripts/roco/battle-smoke-engine.py --only own-0001,own-0002
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import service as SVC  # noqa: E402
from roco_env import data as DATA  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402

OWNED = os.path.join(ROOT, "data", "roco", "owned", "owned-pets.json")
OUT_DIR = os.path.join(ROOT, "reports", "roco", "battle-smoke")

MODE_ID = "pvp-standard-six-pet"
CONFIG_ID = "mobile_s4_candidate_v3"
TEAM_SIZE = 6
# 与 src/server/roco-service.js 的 STANDARD_PVP_UNVERIFIED_OVERRIDES 同一份（逐字）。
UNVERIFIED_OVERRIDES = [{
    "path": "turn_order.speed_tie",
    "value": "random_seeded",
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "同速平手裁决在候选配置里是 UNKNOWN（MC-E05 未录制）。不声明它就打不下去（引擎按纪律抛错）",
    "microcase_id": "MC-E05",
}]
STRATEGY = "greedy_damage"
MAX_TURNS = 160          # 世界上限：到这个回合还没结算就如实记 turn_cap
ACTION_KEYS = ("kind", "skill_id", "target_index", "item_id", "magic_id")


def energy_max() -> Optional[int]:
    """能量上限**从规则配置读**（`energy.max`），不在这里抄一个常数。

    RC-101 的结构契约：上限/回能/初始能量这一组字面量只许住在规则配置里。
    抄一个 10 进来，规则一改这条判据就开始骗人。
    """
    try:
        return int(RC.get_rule_config(CONFIG_ID).energy_max)
    except Exception:  # noqa: BLE001 —— 读不到就说读不到，不补一个默认值
        return None


def load_owned() -> Dict[str, Any]:
    with open(OWNED, "r", encoding="utf-8") as fh:
        return json.load(fh)


def species_power_rank(rs) -> List[Tuple[str, float, str]]:
    """物种按「配招里最高威力」升序 —— 用来确定性地挑一只低威胁的对手队。

    目的不是平衡，是**隔离变量**：这只冒烟要量的是「目标精灵能不能出手」，
    对手越弱，目标越不容易在被量到之前倒下。
    """
    rows = []
    for pid in rs.pets:
        best = 0.0
        for sid in rs.candidate_moveset(pid):
            sk = rs.skills.get(sid)
            if sk is None:
                continue
            power = getattr(sk, "power", None)
            if isinstance(power, (int, float)):
                best = max(best, float(power))
        rows.append((pid, best, str(rs.pets[pid].name)))
    rows.sort(key=lambda r: (r[1], r[0]))
    return rows


def pick_enemy(rs, power_rows, exclude: Sequence[str], *, weak: bool, size: int = TEAM_SIZE) -> List[str]:
    """确定性对手队：弱队取威力最低、标准队取威力中位带跨系别。

    两只都必须与 `exclude` 不重复（引擎不允许同一只重复上场）。
    """
    ex = set(exclude)
    if weak:
        picked = []
        for pid, _p, _n in power_rows:
            if pid in ex:
                continue
            picked.append(pid)
            if len(picked) >= size:
                break
        return picked
    mid = len(power_rows) // 2
    order = power_rows[mid:] + power_rows[:mid]
    picked, seen_types = [], set()
    for pid, _p, _n in order:
        if pid in ex:
            continue
        types = tuple(sorted(getattr(rs.pets[pid], "types", []) or []))
        if types in seen_types and len(picked) < size - 2:
            continue
        seen_types.add(types)
        picked.append(pid)
        if len(picked) >= size:
            break
    return picked


def filler_pool(power_rows, exclude: Sequence[str]) -> List[str]:
    """5 只补位：确定性挑「威力中位、跨系别」的物种，与目标不重复。"""
    ex = set(exclude)
    mid = len(power_rows) // 2
    order = power_rows[mid:] + power_rows[:mid]
    out = []
    for pid, _p, _n in order:
        if pid in ex:
            continue
        out.append(pid)
        if len(out) >= 5:
            break
    return out


def slim(action: Dict[str, Any]) -> Dict[str, Any]:
    return {k: action[k] for k in ACTION_KEYS if k in action and action[k] is not None}


def greedy_pick(rs, legal: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """最强的合法攻击（威力降序，来源没给威力的排最后，不补 0）。

    只用于「不是目标精灵在场上」的那些回合 —— 目的只是让这局能正常打完，
    不是当战术。
    """
    def power(a: Dict[str, Any]) -> float:
        sk = rs.skills.get(a.get("skill_id") or "")
        p = getattr(sk, "power", None) if sk is not None else None
        return float(p) if isinstance(p, (int, float)) else -1.0

    skills = [a for a in legal if a.get("kind") == "skill"]
    if skills:
        return max(skills, key=power)
    for a in legal:
        if a.get("kind") == "charge":
            return a
    return legal[0] if legal else None


def skill_of(rs, sid: str) -> Dict[str, Any]:
    sk = rs.skills.get(sid)
    if sk is None:
        return {"skill_id": sid, "name": None, "energy": None, "power": None,
                "category": None, "in_ruleset": False}
    return {"skill_id": sid, "name": sk.name, "energy": getattr(sk, "energy", None),
            "power": getattr(sk, "power", None), "category": getattr(sk, "category", None),
            "element": getattr(sk, "element", None),
            "is_trait": bool(getattr(sk, "is_trait", False)), "in_ruleset": True}


class CallLog:
    """把每一次引擎往返的原文留档（失败原因要**原文**，不许笼统说「不支持」）。"""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def record(self, endpoint: str, status: int, env: Dict[str, Any]) -> None:
        self.calls.append({
            "endpoint": endpoint, "status": status, "ok": bool(env.get("ok")),
            "error_type": env.get("error_type"), "error": env.get("error"),
        })

    def failure(self) -> Optional[Dict[str, Any]]:
        for c in self.calls:
            if not c["ok"]:
                return c
        return None


def drive_battle(svc, rs, *, team: Sequence[str], enemy: Sequence[str], loadouts: Dict[str, Any],
                 target: str, skills4: Sequence[str], seed: int,
                 target_loadout: Optional[Sequence[str]] = None,
                 do_switch_cycle: bool = True) -> Dict[str, Any]:
    """跑完一局，逐回合只做一件事：让 `target` 这一只把它的四个技能**逐个出出来**。

    返回的每一步都带引擎原文；任何一步失败就在 `failure` 里停住并如实记下。
    """
    real_loadout = list(target_loadout or skills4)
    log = CallLog()
    out: Dict[str, Any] = {
        "battle_new": None, "turns": 0, "result": None, "phase": None,
        "failure": None, "skills": {}, "switch_out": False, "switch_in": False,
        "took_damage": False, "target_fainted": False, "faints_seen": 0,
        "unsupported_for_target": [], "unsupported_for_target_skills": [],
        "effects_registered_unsupported_for_target": [],
        "events_seen": 0, "replacement_calls": 0,
    }
    for sid in skills4:
        out["skills"][sid] = {"offered": False, "used": False, "used_turn": None}
    out["target_loadout"] = real_loadout
    out["loadout_skills"] = {sid: {"offered": False, "used": False, "used_turn": None}
                             for sid in real_loadout}

    try:
        status, env = svc.battle_new({
            "team": list(team), "enemy_team": list(enemy), "seed": seed,
            "strategy": STRATEGY, "ruleset_config_id": CONFIG_ID,
            "unverified_overrides": UNVERIFIED_OVERRIDES, "state_version": 0,
            "loadouts": loadouts,
        })
    except Exception as exc:  # noqa: BLE001 —— 兜底：HTTP 层会把它变成 500 internal_error
        out["failure"] = {"step": "start", "kind": "exception",
                          "text": f"{type(exc).__name__}: {exc}",
                          "traceback": traceback.format_exc().splitlines()[-3:]}
        return out
    log.record("/battle/new", status, env)
    out["battle_new"] = {"status": status, "ok": bool(env.get("ok")), "error": env.get("error")}
    if not env.get("ok"):
        out["failure"] = {"step": "start", "kind": "engine_error", "status": status,
                          "error_type": env.get("error_type"), "text": env.get("error")}
        return out

    r = env["result"]
    state, sv = r["state"], r["state_version"]
    out["phase"] = r["phase"]
    out["turns"] = r["turn"]
    legal_player = r.get("legal", {}).get("player") or []
    out["battle_new"]["legal_count"] = len(legal_player)
    if r["phase"] != "battle" or not legal_player:
        out["failure"] = {"step": "start", "kind": "no_legal_action",
                          "text": f"开局后 phase={r['phase']}，玩家合法动作 {len(legal_player)} 个"}
        return out

    # 出手前先「换出 → 换入」：覆盖验收要求的「换入」那一段，也顺带触发入场类特性。
    switched_out = False
    switched_in = False
    seen_slots = {p["pet_id"]: p["slot"] for p in r["ui"]["self"]["pets"]}
    target_slot = seen_slots.get(target)

    for _ in range(MAX_TURNS):
        if r.get("result"):
            out["result"] = r["result"]
            break
        legal = r.get("legal", {}).get("player") or []
        if not legal:
            out["failure"] = {"step": "act", "kind": "no_legal_action",
                              "text": f"第 {r['turn']} 回合玩家没有合法动作"}
            break

        if r["phase"] == "replace":
            queue = r.get("needs_replacement") or []
            bench = [a for a in legal if a.get("kind") == "switch"]
            if not bench:
                out["failure"] = {"step": "act", "kind": "no_bench",
                                  "text": f"补位局面但合法动作里没有 switch（queue={queue}）"}
                break
            pick = next((a for a in bench if a.get("target_index") == target_slot), bench[0])
            action = slim(pick)
            out["replacement_calls"] += 1
        else:
            active = state["player"]["pets"][state["player"]["active"]]
            field, field_alive = active["pet_id"], not active.get("fainted")
            skill_acts = [a for a in legal if a.get("kind") == "skill"]
            switch_acts = [a for a in legal if a.get("kind") == "switch"]
            if field == target:
                for a in skill_acts:
                    if a.get("skill_id") in out["skills"]:
                        out["skills"][a["skill_id"]]["offered"] = True
                    if a.get("skill_id") in out["loadout_skills"]:
                        out["loadout_skills"][a["skill_id"]]["offered"] = True
            to_target = next((a for a in switch_acts if a.get("target_index") == target_slot), None)
            away = next((a for a in switch_acts if a.get("target_index") != target_slot), None)

            if (do_switch_cycle and field == target and field_alive
                    and not switched_out and not switched_in and away):
                pick = away            # ① 主动换出
            elif switched_out and not switched_in and to_target:
                pick = to_target       # ② 主动换入
            elif field == target and field_alive:
                def _cost(sid: str) -> float:
                    sk = rs.skills.get(sid)
                    c = getattr(sk, "energy", None) if sk is not None else None
                    return float(c) if isinstance(c, (int, float)) else -1.0
                # **贵的先出**：能量是有限的、这一只还可能中途倒下，
                # 先出便宜的后出贵的 = 贵的永远出不来（旧顺序踩到过）。
                unused = sorted((s for s in real_loadout if not out["loadout_skills"][s]["used"]),
                                key=lambda sid: (-_cost(sid), sid))
                by_id = {a.get("skill_id"): a for a in skill_acts}
                pick = next((by_id[sid] for sid in unused if sid in by_id), None)
                if pick is None:
                    pick = next((a for a in legal if a.get("kind") == "charge"), None)
                if pick is None:
                    pick = greedy_pick(rs, legal)
            else:
                pick = greedy_pick(rs, legal)
            if pick is None:
                out["failure"] = {"step": "act", "kind": "no_action",
                                  "text": f"第 {r['turn']} 回合选不出一手（legal={len(legal)}）"}
                break
            action = slim(pick)

        try:
            status, env2 = svc.battle_advance({
                "state": state, "action": action, "strategy": STRATEGY, "state_version": sv,
            })
        except Exception as exc:  # noqa: BLE001
            out["failure"] = {"step": "act", "kind": "exception", "turn": r["turn"],
                              "action": action, "text": f"{type(exc).__name__}: {exc}",
                              "traceback": traceback.format_exc().splitlines()[-3:]}
            break
        log.record("/battle/advance", status, env2)
        if not env2.get("ok"):
            out["failure"] = {"step": "act", "kind": "engine_error", "status": status,
                              "turn": r["turn"], "action": action,
                              "error_type": env2.get("error_type"), "text": env2.get("error")}
            break

        # 这一手真的被接受了 —— 记在对应技能上（换人单独记，只在 battle 阶段算「主动换」）
        if action.get("kind") == "switch":
            if r["phase"] == "battle":
                if not switched_out and action.get("target_index") != target_slot:
                    switched_out = True
                elif switched_out and action.get("target_index") == target_slot:
                    switched_in = True
        elif action.get("kind") == "skill":
            sid = action.get("skill_id")
            if sid in out["skills"]:
                out["skills"][sid]["used"] = True
                out["skills"][sid]["used_turn"] = r["turn"]
                out["loadout_skills"][sid]["used"] = True
                out["loadout_skills"][sid]["used_turn"] = r["turn"]

        prev = r
        r = env2["result"]
        state, sv = r["state"], r["state_version"]
        out["turns"] = r["turn"]
        out["phase"] = r["phase"]
        for e in r.get("events") or []:
            out["events_seen"] += 1
            d = e.get("detail") or {}
            if e.get("kind") == "faint":
                out["faints_seen"] += 1
            if d.get("side") == "player" and d.get("target_slot") == target_slot:
                out["took_damage"] = True
            if (e.get("kind") == "effects_registered_unsupported" and d.get("side") == "player"
                    and d.get("skill_id") in out["loadout_skills"]):
                out["effects_registered_unsupported_for_target"].append(
                    {"turn": e.get("turn"), "skill_id": d.get("skill_id"), "text": e.get("text")})
        for p in state["player"]["pets"]:
            if p["pet_id"] == target and p.get("fainted"):
                out["target_fainted"] = True
        if r.get("result"):
            out["result"] = r["result"]
            break
        if r["phase"] == "ended" and not r.get("result"):
            out["failure"] = {"step": "settle", "kind": "ended_without_result",
                              "text": f"phase=ended 但 result={r.get('result')!r}"}
            break
    else:
        out["failure"] = {"step": "settle", "kind": "turn_cap",
                          "text": f"打到第 {MAX_TURNS} 回合仍未结算（上限）"}

    out["switch_out"] = switched_out
    out["switch_in"] = switched_in
    # 未核验机制：只挑**属于这只**的那些（按技能 id 归属，不按对手/补位）
    mine = set(real_loadout) | set(skills4)
    for u in state.get("unsupported") or []:
        ev = str(u.get("evidence") or "")
        if ev in mine:
            out["unsupported_for_target_skills"].append(u)
    # 直接把 target 的四个技能在这一局里出现的所有 unsupported 原文带出去（去重）
    out["calls"] = log.calls
    return out


def run_one(svc, rs, power_rows, inst: Dict[str, Any], build: Dict[str, Any]) -> Dict[str, Any]:
    species = inst["species_id"]
    skills4 = list(build.get("ordered_skills") or inst.get("skills") or [])
    name = inst.get("species_name")
    types = list(getattr(rs.pets[species], "types", []) or []) if species in rs.pets else []
    rec: Dict[str, Any] = {
        "instance_id": inst["instance_id"], "species_id": species, "species_name": name,
        "effective_form": build.get("effective_form"),
        "ruleset_types": types,
        "level": inst.get("level"),
        "requested_skills": [skill_of(rs, s) for s in skills4],
        "steps": {}, "playable": False, "failure": None, "scenarios": [],
    }
    if species not in rs.pets:
        rec["steps"]["select"] = {"ok": False, "detail": f"{species} 不在这份规则集的精灵表里"}
        rec["failure"] = {"step": "select", "text": f"规则集里没有物种 {species}（{name}）"}
        return rec
    rec["steps"]["select"] = {"ok": True, "detail": f"{inst['instance_id']} → {species}（{name}）在规则集里"}

    fillers = filler_pool(power_rows, exclude=[species])
    if len(fillers) < 5:
        rec["failure"] = {"step": "legal_six", "text": "候选宇宙不足，凑不出 5 只补位"}
        rec["steps"]["legal_six"] = {"ok": False, "detail": rec["failure"]["text"]}
        return rec
    team = [species] + fillers

    loadouts = {species: skills4}
    for pid in fillers:
        loadouts[pid] = list(rs.candidate_moveset(pid))

    canonical = list(rs.candidate_moveset(species))
    rec["canonical_moveset"] = [skill_of(rs, s) for s in canonical]

    def loadouts_with(target_skills: Sequence[str]) -> Dict[str, Any]:
        lo = dict(loadouts)
        lo[species] = list(target_skills)
        return lo

    # 场景：先弱对手（隔离变量、让目标能自由出手），再标准对手（更接近真实对局）。
    # 如果请求的那四个技能**根本进不了战斗**（学不到 / 不在技能表），再加一档
    # 「引擎规范配招」的补救 —— 这一档的结论是「换一套合法配招能打」，不是「原配招能打」。
    attempts: List[Tuple[str, bool, int, Sequence[str], bool]] = [
        ("weak-enemy-switch-cycle", True, 20260921, skills4, True),
        ("weak-enemy-stay-in", True, 20260921, skills4, False),
        ("weak-enemy-stay-in-seed2", True, 20260922, skills4, False),
        ("weak-enemy-stay-in-seed3", True, 7, skills4, False),
        ("standard-enemy-stay-in", False, 20260921, skills4, False),
    ]
    if canonical and canonical != list(skills4):
        # 四个技能里有**根本进不了战斗**的（学不到/不在技能表）时，再给一档
        # 「引擎规范配招」的补救 —— 结论是「换一套合法配招能打」，不是「原配招能打」。
        attempts.append(("weak-enemy-canonical-loadout", True, 20260921, canonical, False))

    best: Optional[Dict[str, Any]] = None
    for label, weak, seed, target_skills, use_cycle in attempts:
        enemy = pick_enemy(rs, power_rows, exclude=team, weak=weak)
        if len(enemy) < TEAM_SIZE:
            continue
        try:
            res = drive_battle(svc, rs, team=team, enemy=enemy,
                               loadouts=loadouts_with(target_skills),
                               target=species, skills4=skills4, target_loadout=target_skills,
                               seed=seed, do_switch_cycle=use_cycle)
        except Exception as exc:  # noqa: BLE001
            res = {"failure": {"step": "start", "kind": "exception",
                               "text": f"{type(exc).__name__}: {exc}"},
                   "skills": {s: {"offered": False, "used": False} for s in skills4},
                   "calls": []}
        res["scenario"] = label
        res["enemy_team"] = enemy
        res["target_skills_used"] = list(target_skills)
        res["switch_cycle"] = use_cycle
        rec["scenarios"].append({k: res[k] for k in
                                 ("scenario", "enemy_team", "target_skills_used", "loadout_skills", "switch_cycle",
                    "battle_new",
                                  "turns", "result", "phase", "failure", "switch_out", "switch_in",
                                  "took_damage", "target_fainted", "faints_seen", "events_seen",
                                  "effects_registered_unsupported_for_target",
                                  "unsupported_for_target_skills", "calls")
                                 if k in res}
                                | {"skills": res.get("skills")})
        settled_ok = res.get("result") in ("win", "loss", "draw") and res.get("failure") is None
        lo_used = [k for k, v in (res.get("loadout_skills") or {}).items() if v.get("used")]
        cycle_ok = (not use_cycle) or (res.get("switch_out") and res.get("switch_in"))
        full = (settled_ok and target_skills and len(lo_used) == len(target_skills) and cycle_ok)

        def score(r: Dict[str, Any], used: int, cyc: bool) -> Tuple[int, int, int, int]:
            st = r.get("result") in ("win", "loss", "draw") and r.get("failure") is None
            return (1 if st else 0, used, 1 if cyc else 0, 1 if r.get("switch_in") else 0)

        if full:
            best = res
            break
        if best is None:
            best = res
        else:
            b_lo = len([k for k, v in (best.get("loadout_skills") or {}).items() if v.get("used")])
            b_cyc = bool(best.get("switch_out") and best.get("switch_in"))
            if score(res, len(lo_used), bool(res.get("switch_out") and res.get("switch_in"))) > score(best, b_lo, b_cyc):
                best = res
    rec["chosen_scenario"] = best.get("scenario") if best else None
    rec["loadout_used"] = list(best.get("target_skills_used") or skills4) if best else list(skills4)
    rec["loadout_replaced"] = rec["loadout_used"] != list(skills4)
    if best is None:
        rec["failure"] = {"step": "start", "text": "所有场景都没能开局"}
        return rec

    skills = best.get("skills") or {}
    used = [s for s in skills4 if skills.get(s, {}).get("used")]
    offered = [s for s in skills4 if skills.get(s, {}).get("offered")]
    rec["skills_used"] = used
    rec["skills_offered"] = offered
    rec["skills_never_offered"] = [s for s in skills4 if s not in offered]
    rec["skills_never_used"] = [s for s in skills4 if s not in used]
    lo = best.get("loadout_skills") or {}
    rec["loadout_skills_used"] = [s for s in rec["loadout_used"] if lo.get(s, {}).get("used")]
    rec["loadout_skills_never_used"] = [s for s in rec["loadout_used"] if not lo.get(s, {}).get("used")]
    rec["switch_out"] = bool(best.get("switch_out"))
    rec["switch_in"] = bool(best.get("switch_in"))
    rec["took_damage"] = bool(best.get("took_damage"))
    rec["target_fainted"] = bool(best.get("target_fainted"))
    rec["faints_seen"] = best.get("faints_seen")
    rec["turns"] = best.get("turns")
    rec["battle_result"] = best.get("result")
    rec["events_seen"] = best.get("events_seen")
    rec["unsupported_for_target_skills"] = best.get("unsupported_for_target_skills") or []
    rec["effects_registered_unsupported_for_target"] = (
        best.get("effects_registered_unsupported_for_target") or [])
    rec["calls"] = best.get("calls") or []

    steps_ok = True
    rec["steps"]["legal_six"] = {"ok": True, "detail": f"六只 = {team}（目标 + 5 只确定性补位）"}
    started = bool((best.get("battle_new") or {}).get("ok"))
    rec["steps"]["start"] = {"ok": started, "detail": best.get("battle_new")}
    acted = bool(rec["loadout_skills_used"]) or bool(best.get("switch_in")) or bool(best.get("switch_out"))
    rec["steps"]["act"] = {
        "ok": acted,
        "detail": {"skills_used": used, "skills_offered": offered,
                   "loadout_used": rec["loadout_used"],
                   "loadout_skills_used": rec["loadout_skills_used"],
                   "switch_out": rec["switch_out"], "switch_in": rec["switch_in"]},
    }
    settled = best.get("result") in ("win", "loss", "draw")
    rec["steps"]["settle"] = {"ok": settled, "detail": {"result": best.get("result"),
                                                        "turns": best.get("turns")}}
    for k in ("select", "legal_six", "start", "act", "settle"):
        if not rec["steps"].get(k, {}).get("ok"):
            steps_ok = False
    rec["playable"] = steps_ok
    if not steps_ok or best.get("failure"):
        f = best.get("failure")
        rec["failure"] = f or {"step": "unknown", "text": "有一步没到位，但引擎没给失败原文"}
    # 四个技能没全用出来：给出**准确原因**与**合法可运行的替代**
    # 换出/换入没被选中的那一档覆盖到时，单独补一局**只为验这一步**（不拿它当主记录）
    if not (rec["switch_out"] and rec["switch_in"]):
        try:
            chk = drive_battle(svc, rs, team=team,
                               enemy=pick_enemy(rs, power_rows, exclude=team, weak=True),
                               loadouts=loadouts, target=species, skills4=skills4,
                               target_loadout=skills4, seed=20260921, do_switch_cycle=True)
            rec["switch_check"] = {"ok": bool(chk.get("switch_out") and chk.get("switch_in")),
                                   "switch_out": bool(chk.get("switch_out")),
                                   "switch_in": bool(chk.get("switch_in")),
                                   "scenario": "weak-enemy-switch-check",
                                   "failure": chk.get("failure")}
            if rec["switch_check"]["ok"]:
                rec["switch_out"] = True
                rec["switch_in"] = True
        except Exception as exc:  # noqa: BLE001
            rec["switch_check"] = {"ok": False, "failure": {"step": "switch_check",
                                                            "text": f"{type(exc).__name__}: {exc}"}}

    rec["used_all_four"] = (not rec["loadout_replaced"]
                            and len(rec.get("skills_used") or []) == len(skills4))
    never = [s for s in skills4 if s not in used] if not rec["loadout_replaced"] else list(skills4)
    if never:
        rec["skill_gaps"] = explain_skill_gaps(rs, species, skills4, {**rec, "skills_never_used": never})
    return rec


def explain_skill_gaps(rs, species: str, skills4: Sequence[str], rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    """四个技能里没用出来的那几个：为什么，以及合法可运行的替代是什么。

    「跑不了」的判据（按顺序）：
      · 规则集里没有这个技能 id            → in_ruleset=False
      · 加载表里学不到（validate_team 会 400）→ learnable=False
      · 是特性不是招式（引擎不会把它列进合法动作）
      · 能耗 > 能量上限                    → 永远付不起
      · 否则：这一局里它没被引擎列进合法动作（offered=False）—— 如实记「这一局没出现」
    替代：这只精灵的**引擎规范配招**（`rs.candidate_moveset`，按构造一定可学），
    并标出它与原四个技能的交集大小。
    """
    out = []
    trait_ids = set()
    for sid in skills4:
        sk = rs.skills.get(sid)
        if sk is not None and bool(getattr(sk, "is_trait", False)):
            trait_ids.add(sid)
    canonical = list(rs.candidate_moveset(species))
    learn = rs.learnsets.get(species)
    learnable_all = set(learn.all_skill_ids) if learn else set()
    for sid in rec.get("skills_never_used") or []:
        sk = rs.skills.get(sid)
        reason = None
        kind = None
        if sk is None:
            kind, reason = "not_in_ruleset", f"技能 {sid} 不在这份规则集的技能表里"
        elif bool(getattr(sk, "is_trait", False)):
            kind, reason = "is_trait", f"「{sk.name}」是特性（trait），引擎不会把它列进合法动作"
        elif sid not in learnable_all:
            kind, reason = "not_learnable", (
                f"「{sk.name}」不在这只精灵的学习表里（引擎 validate_team 会 400："
                f"{rs.pets[species].name} 学不到 {sk.name}）")
        else:
            cfg_energy_max = energy_max()
            cost = getattr(sk, "energy", None)
            if (isinstance(cost, (int, float)) and cfg_energy_max is not None
                    and cost > cfg_energy_max):
                kind, reason = "unaffordable", (
                    f"「{sk.name}」能耗 {cost} > 能量上限 {cfg_energy_max}"
                    f"（读自规则配置 {CONFIG_ID} 的 energy.max），永远付不起 ⇒ 不提供这一手")
            elif sid in set(rec.get("skills_offered") or []):
                kind, reason = "offered_but_not_used", (
                    f"「{sk.name}」可学、能耗 {cost}、这一局也被引擎列进过合法动作，"
                    "但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，"
                    "不是这一招跑不了**")
            else:
                kind, reason = "never_offered", (
                    f"「{sk.name}」可学、能耗 {cost}，但这一局它**从没被列进合法动作**"
                    "（引擎按配招 + 能量 + 冷却裁剪合法动作；这一条要单独查）")
        out.append({
            "skill_id": sid, "name": getattr(sk, "name", None), "kind": kind, "reason": reason,
            "canonical_replacement": [skill_of(rs, s) for s in canonical],
            "replacement_overlap": sorted(set(canonical) & set(skills4)),
        })
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--only", type=str, default=None, help="逗号分隔的 instance_id")
    ap.add_argument("--out", type=str, default=os.path.join(OUT_DIR, "engine-sweep.json"))
    ap.add_argument("--no-mechanism", action="store_true")
    args = ap.parse_args(argv)

    started = time.time()
    svc = SVC.RocoService()
    rs, why = svc.cache.get(DATA.DEFAULT_RULESET)
    if rs is None:
        print(json.dumps({"ok": False, "error": f"规则集装不起来：{why}"}, ensure_ascii=False))
        return 2

    doc = load_owned()
    instances = doc["instances"]
    builds = {b["owned_pet_instance_id"]: b for b in doc["battle_builds"]}
    if args.only:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        instances = [i for i in instances if i["instance_id"] in want]
    if args.limit:
        instances = instances[:args.limit]

    power_rows = species_power_rank(rs)
    fprint = rs.snapshot_fingerprint()

    records = []
    for n, inst in enumerate(instances, 1):
        build = builds.get(inst["instance_id"]) or {}
        try:
            rec = run_one(svc, rs, power_rows, inst, build)
        except Exception as exc:  # noqa: BLE001 —— 一只炸了不许带走整轮
            rec = {"instance_id": inst["instance_id"], "species_id": inst["species_id"],
                   "species_name": inst.get("species_name"), "playable": False,
                   "failure": {"step": "harness", "kind": "exception",
                               "text": f"{type(exc).__name__}: {exc}"}}
        records.append(rec)
        if n % 25 == 0 or n == len(instances):
            ok = sum(1 for r in records if r.get("playable"))
            print(f"[engine] {n}/{len(instances)} 可玩 {ok} 用时 {time.time()-started:.0f}s",
                  file=sys.stderr, flush=True)

    out = {
        "schema_version": 1,
        "artifact": "battle-smoke-engine",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "ruleset_id": rs.ruleset_id,
        "snapshot_fingerprint": fprint,
        "mode_id": MODE_ID,
        "ruleset_config_id": CONFIG_ID,
        "team_size": TEAM_SIZE,
        "strategy": STRATEGY,
        "max_turns": MAX_TURNS,
        "unverified_overrides": UNVERIFIED_OVERRIDES,
        "entry": "roco_env.service.RocoService.battle_new / battle_advance（进程内直调产品引擎入口）",
        "counts": {
            "total": len(records),
            "playable": sum(1 for r in records if r.get("playable")),
            "blocked": sum(1 for r in records if not r.get("playable")),
            "settled": sum(1 for r in records if (r.get("steps") or {}).get("settle", {}).get("ok")),
            "all_four_used": sum(1 for r in records
                                 if len(r.get("loadout_skills_used") or []) == len(r.get("loadout_used") or [])),
            "used_at_least_one": sum(1 for r in records if r.get("loadout_skills_used")),
            "all_four_used_on_requested_loadout": sum(
                1 for r in records
                if not r.get("loadout_replaced")
                and len(r.get("skills_used") or []) == len(r.get("requested_skills") or [])),
            "loadout_replaced": sum(1 for r in records if r.get("loadout_replaced")),
            "switch_out_ok": sum(1 for r in records if r.get("switch_out")),
            "switch_in_ok": sum(1 for r in records if r.get("switch_in")),
            "took_damage": sum(1 for r in records if r.get("took_damage")),
            "target_fainted": sum(1 for r in records if r.get("target_fainted")),
            "any_unsupported_seen": sum(1 for r in records if r.get("unsupported_for_target_skills")
                                        or r.get("effects_registered_unsupported_for_target")),
        },
        "records": records,
        "elapsed_s": round(time.time() - started, 1),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(json.dumps(out["counts"], ensure_ascii=False))
    print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
