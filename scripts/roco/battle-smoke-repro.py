#!/usr/bin/env python3
"""B 段 · 把「入口侧打不完」的那一局**逐手复现**出来，并打印引擎原文 + traceback。

为什么必须有这一份：入口侧冒烟会给出「哪一只、失败在第几手、引擎原文」，但那还是
**一局**里的一次失败。要判断「这是脚本的问题还是产品的问题」，必须拿同一串动作
再跑一遍，看到引擎抛在哪一行、当时双方的状态是什么。

引擎是确定性的（同一 seed + 同一串动作 = 同一局），所以复现是逐位的：
`entry-sweep.json` 的 `settle_records[].trace` 就是那一串动作。

用法：
    python3 scripts/roco/battle-smoke-repro.py                 # 复现所有入口侧失败的那几局
    python3 scripts/roco/battle-smoke-repro.py --only own-0442
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import service as SVC  # noqa: E402
from roco_env import env as env_mod  # noqa: E402
from roco_env.schema import Action  # noqa: E402

SMOKE = os.path.join(ROOT, "reports", "roco", "battle-smoke")
OWNED = os.path.join(ROOT, "data", "roco", "owned", "owned-pets.json")
CONFIG_ID = "mobile_s4_candidate_v3"
OVERRIDES = [{
    "path": "turn_order.speed_tie", "value": "random_seeded",
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "同速平手裁决在候选配置里是 UNKNOWN（MC-E05 未录制）",
    "microcase_id": "MC-E05",
}]


def parse_action(tok: str) -> Dict[str, Any]:
    kind, _, arg = tok.partition(":")
    if kind == "switch":
        return {"kind": "switch", "target_index": int(arg)}
    if kind == "skill":
        return {"kind": "skill", "skill_id": arg}
    if kind == "item":
        return {"kind": "item", "item_id": arg}
    if kind == "magic":
        return {"kind": "magic", "magic_id": arg}
    return {"kind": kind}


def digest(state: Dict[str, Any], rs) -> Dict[str, Any]:
    out: Dict[str, Any] = {"turn": state.get("turn"), "phase": state.get("phase"),
                           "result": state.get("result")}
    for side in ("player", "enemy"):
        s = state.get(side) or {}
        pets = []
        for p in s.get("pets") or []:
            pid = p.get("pet_id")
            pets.append({
                "slot": p.get("slot"), "pet_id": pid,
                "name": rs.pets[pid].name if pid in rs.pets else None,
                "hp": p.get("hp"), "energy": p.get("energy"), "fainted": p.get("fainted"),
                "energy_cost_mods": p.get("energy_cost_mods") or [],
                "skill_ramps": p.get("skill_ramps") or {},
            })
        out[side] = {"active": s.get("active"), "pets": pets,
                     "loadouts": s.get("loadouts")}
    return out


def deep_step(svc, state_dict: Dict[str, Any], sv: Any, tok: str) -> Dict[str, Any]:
    """在**活着的那份 GameState**上重放这一手，好看到抛错那一刻的真正状态。

    为什么不能只看 `battle_advance` 的入参：它内部 `deserialize` 出一份**新的**
    GameState 再改；异常抛出时那份对象就没了，入参那份字典一个字节都没变。
    要判断「谁的哪一下把能耗压到负数」，必须自己拿同一份活对象。
    """
    import time as _time
    state, rs2, early = svc._private_state(
        {"state": state_dict, "ruleset_config_id": CONFIG_ID, "state_version": sv},
        _time.perf_counter())
    if early is not None:
        return {"ok": False, "stage": "private_state", "error": early}
    strategy, why = svc._sim_strategy({"strategy": "greedy_damage"}, _time.perf_counter())
    if why is not None:
        return {"ok": False, "stage": "strategy", "error": why}
    legal_enemy = env_mod.legal_actions(state, rs2, "enemy")
    obs = env_mod.observe(state, rs2, "enemy")
    enemy_action = strategy.act(obs, legal_enemy, int(state.seed), int(state.turn))
    player_action = Action.from_dict(parse_action(tok))
    out: Dict[str, Any] = {
        "enemy_action": enemy_action.to_dict(),
        "enemy_legal": [a.to_dict() for a in legal_enemy],
        "player_action_legal": player_action in env_mod.legal_actions(state, rs2, "player"),
        "turn": state.turn, "energy_cost_mods": {
            "player": state.player.field_pet.energy_cost_mods,
            "enemy": state.enemy.field_pet.energy_cost_mods},
        "skill_ramps": {"player": dict(state.player.field_pet.skill_ramps or {}),
                        "enemy": dict(state.enemy.field_pet.skill_ramps or {})},
        "weather": state.weather,
    }
    try:
        env_mod.step_joint(state, rs2, player_action, enemy_action)
        out["ok"] = True
        out["result"] = state.result
        return out
    except Exception as exc:  # noqa: BLE001
        out.update({
            "ok": False,
            "exception_type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc().splitlines()[-16:],
            "log_tail_after": [str(x) for x in (state.log or [])[-8:]],
            "events_after": [e.to_dict() for e in (state.events or [])],
            "live_state_after": digest(state.to_dict(), rs2),
        })
        return out


def replay(svc, rs, rec: Dict[str, Any], by_instance: Dict[str, str],
           *, verbose: bool = True) -> Dict[str, Any]:
    # 入口侧记录的是 own-XXXX（页面选的是个体）；引擎的名单是物种级。
    # 这层换算在产品里由 `src/server/roco-service.js` 的 `resolveBattleTeamIds` 做，
    # 复现脚本照同一条规则做（owned-pets.json: instance_id → species_id）。
    def to_species(ids):
        out = []
        for i in ids:
            out.append(by_instance[i] if i.startswith("own-") else i)
        return out

    team = to_species(rec["team"])
    enemy = to_species(rec["enemy_team"])
    loadouts = rec["submitted_loadouts"]
    trace = rec.get("trace") or []
    status, env = svc.battle_new({
        "team": team, "enemy_team": enemy, "seed": 20260921, "strategy": "greedy_damage",
        "ruleset_config_id": CONFIG_ID, "unverified_overrides": OVERRIDES,
        "state_version": 0, "loadouts": loadouts,
    })
    if not env.get("ok"):
        return {"reproduced": False, "stage": "battle_new", "status": status,
                "error": env.get("error")}
    r = env["result"]
    state, sv = r["state"], r["state_version"]
    for i, tok in enumerate(trace):
        action = parse_action(tok)
        if r.get("result"):
            return {"reproduced": False, "stage": "ended_before_trace_end",
                    "at_index": i, "result": r["result"]}
        if r.get("phase") == "replace" and action.get("kind") != "switch":
            return {"reproduced": False, "stage": "phase_drift", "at_index": i,
                    "detail": f"复现到第 {i} 手时局面是 replace，而记录的动作是 {tok}"}
        try:
            status, env2 = svc.battle_advance({"state": state, "action": action,
                                               "strategy": "greedy_damage", "state_version": sv})
        except Exception as exc:  # noqa: BLE001 —— 这就是要找的「未处理异常」
            # `state` 是**原地**被改的：抛错之前这一手已经结算的部分留在里面。
            # 这是判断「谁的哪一下把能耗压下去的」的唯一直接证据。
            return {"reproduced": True, "stage": "exception", "at_index": i, "action": tok,
                    "exception_type": type(exc).__name__, "message": str(exc),
                    "traceback": traceback.format_exc().splitlines()[-14:],
                    "state_before": digest(state, rs),
                    "deep_step": deep_step(svc, state, sv, tok)}
        if not env2.get("ok"):
            return {"reproduced": True, "stage": "engine_error", "at_index": i, "action": tok,
                    "status": status, "error_type": env2.get("error_type"),
                    "error": env2.get("error"), "state_before": digest(state, rs),
                    "deep_step": deep_step(svc, state, sv, tok)}
        r = env2["result"]
        state, sv = r["state"], r["state_version"]
        if i == len(trace) - 1:
            return {"reproduced": False, "stage": "trace_end_no_failure",
                    "result": r.get("result"), "turn": r.get("turn")}
    return {"reproduced": False, "stage": "empty_trace"}


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=str, default=None, help="逗号分隔的 instance_id")
    ap.add_argument("--out", type=str, default=os.path.join(SMOKE, "repro-failures.json"))
    args = ap.parse_args(argv)

    entry = json.load(open(os.path.join(SMOKE, "entry-sweep.json"), encoding="utf-8"))
    owned = json.load(open(OWNED, encoding="utf-8"))
    by_instance = {i["instance_id"]: i["species_id"] for i in owned["instances"]}

    suspects = []
    for rec in entry.get("settle_records") or []:
        if rec.get("full_playable"):
            continue
        if args.only and rec["instance_id"] not in {s.strip() for s in args.only.split(",")}:
            continue
        suspects.append(rec)
    # 也把「入口 playable 但没跑到结算」的算进来
    for rec in entry.get("records") or []:
        if rec.get("steps", {}).get("settle", {}).get("ok") is False:
            if args.only and rec["instance_id"] not in {s.strip() for s in args.only.split(",")}:
                continue
            if not any(s["instance_id"] == rec["instance_id"] for s in suspects):
                suspects.append(rec)

    svc = SVC.RocoService()
    rs, why = svc.cache.get("roco-world-s4-2026-09-10")
    if rs is None:
        print(json.dumps({"ok": False, "error": why}, ensure_ascii=False))
        return 2

    results = []
    for rec in suspects:
        if not rec.get("trace"):
            results.append({"instance_id": rec["instance_id"], "reproduced": False,
                            "stage": "no_trace", "detail": "这一局没有留下逐手痕迹（没跑到推进阶段）"})
            continue
        row = {"instance_id": rec["instance_id"], "species_id": by_instance.get(rec["instance_id"]),
               "team": rec.get("team"), "enemy_team": rec.get("enemy_team")}
        row.update(replay(svc, rs, rec, by_instance))
        results.append(row)
        print(f"[repro] {rec['instance_id']} → {row.get('stage')} "
              f"{row.get('exception_type') or row.get('error_type') or ''} "
              f"{row.get('message') or row.get('error') or ''}"[:220], file=sys.stderr, flush=True)

    if not suspects:
        # 没有嫌疑局：**不要**把上一次留下的复现证据覆盖成空文件（那是销毁证据）
        print("入口侧没有打不完的局，无需复现；保留上一次的产物不动。")
        print(f"（上一次的逐手 trace 复现见 {os.path.relpath(os.path.join(SMOKE, 'repro-own-0442-from-trace.json'), ROOT)}；"
              "不依赖任何轨迹的自足复现见 scripts/roco/battle-smoke-repro-negative-cost.py）")
        return 0

    out = {"schema_version": 1, "artifact": "battle-smoke-repro",
           "how": "对 entry-sweep.json 每一局失败留下的 trace 逐手重放（引擎确定性）",
           "total_suspects": len(suspects),
           "reproduced": sum(1 for r in results if r.get("reproduced")),
           "results": results}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps({"suspects": len(suspects), "reproduced": out["reproduced"]}, ensure_ascii=False))
    print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
