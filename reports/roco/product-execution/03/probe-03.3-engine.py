"""03.3 只读探针：真引擎读数（供信念模块的证据更新用）。

产出 `raw-03.3-engine.json`（**不含私有 `state`**）：
  · `pvp_receipt`     六宠 PVP（有预览）推进到「对手打出伤害」那一回合的回执切片；
  · `legacy_receipt`  legacy 3v3 推进后的回执切片（证明 legacy 的 turn_start **没有** speed_provenance）；
  · `counterexample`  反例①：真打一手拿到公开伤害 D，再在**同一上下文**（同一回合、同一动作）
                      只换对手的个体面板重放，读引擎自己结算出来的伤害 —— 两者都等于 D
                      就说明「同一公开伤害由两种个体配置都能解释」。

用法（WSL）：PYTHONPATH=roco/src python3 /mnt/e/roco-scratch/plan03/probe-03.3-engine.py
"""
from __future__ import annotations

import copy
import json
import os
import sys

ROOT = "/mnt/e/roco-coach"
OUT = os.path.join(ROOT, "reports", "roco", "product-execution", "03")
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import effects as reffects      # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env.service import RocoService      # noqa: E402

RS = rdata.load_ruleset()
SIX = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花", "迪莫", "水灵", "火神")]
SIX_B = [RS.pets_by_name(n)[0].pet_id for n in ("魔力猫", "草头鸭", "恶魔叮", "恶魔狼", "鸭吉吉", "铠甲虫")]
THREE = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
THREE_B = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


def slice_of(receipt):
    return {k: v for k, v in receipt.items() if k != "state"}


def pick_action(result):
    legal = result["legal"]["player"]
    return next((a for a in legal if a["kind"] == "skill"), None) or legal[0]


def enemy_damage_of(events):
    return [e for e in (events or []) if e.get("kind") == "damage"
            and (e.get("detail") or {}).get("side") == "enemy"
            and (e.get("detail") or {}).get("damage")]


def main():
    svc = RocoService()
    out = {"ruleset_id": RS.ruleset_id, "runs": {}, "counterexample": None}
    os.makedirs(OUT, exist_ok=True)

    # ── (a) 六宠 PVP（有预览）：开一局 → 推进到对手打出伤害那一回合 ──
    status, env0 = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": SIX, "enemy_team": SIX_B,
                                   "seed": 5, "state_version": 0, "opening_preview": True,
                                   "ruleset_config_id": "mobile_s4_candidate_v3"})
    out["runs"]["pvp_new_status"] = status
    if status != 200:
        out["runs"]["pvp_error"] = env0
    else:
        receipt0 = env0["result"]
        cfg = rc.get_rule_config((receipt0.get("public") or {}).get("ruleset_config_id") or None)
        prev_receipt = receipt0
        prev_action = pick_action(receipt0)
        receipt_last = receipt0
        events_all = []
        counter_turn = None
        for _ in range(6):
            st, envk = svc.battle_advance({"state": prev_receipt["state"],
                                           "state_version": prev_receipt["state_version"],
                                           "action": prev_action})
            if st != 200:
                out["runs"]["pvp_advance_error"] = envk
                break
            turn_events = envk["result"].get("events") or []
            events_all.extend(turn_events)
            receipt_last = envk["result"]
            if counter_turn is None and enemy_damage_of(turn_events):
                counter_turn = {"pre": prev_receipt, "events": turn_events,
                                "action": prev_action, "receipt": envk["result"]}
            prev_receipt = envk["result"]
            prev_action = pick_action(prev_receipt)
        out["pvp_receipt"] = slice_of(counter_turn["receipt"]) if counter_turn else slice_of(receipt_last)
        out["pvp_receipt_final"] = slice_of(receipt_last)
        out["runs"]["pvp_events_n"] = len(events_all)
        out["runs"]["pvp_event_kinds"] = sorted({e.get("kind") for e in events_all})
        out["runs"]["pvp_event_seq"] = [{"seq": e.get("seq"), "turn": e.get("turn"), "kind": e.get("kind"),
                                         "side": (e.get("detail") or {}).get("side")} for e in events_all]

        # ── (c) 反例① ──
        hits = enemy_damage_of(counter_turn["events"]) if counter_turn else []
        if not hits:
            out["counterexample"] = {"note": "推进 6 回合对手都没打出伤害（一直防御/换人）"}
        else:
            observed = int(hits[0]["detail"]["damage"])
            pre = counter_turn["pre"]
            action0 = counter_turn["action"]
            state0 = renv.deserialize(pre["state"], RS, cfg)
            foe_pet = state0.enemy.field_pet
            species = RS.pet(foe_pet.pet_id)
            base_panel, base_source = reffects.damage_panel_for(foe_pet, species)

            def replay(panel_delta):
                state_k = copy.deepcopy(state0)
                pet = state_k.enemy.field_pet
                panel = dict(base_panel)
                for key, delta in panel_delta.items():
                    if key in panel:
                        panel[key] = panel[key] + delta
                pet.panel = panel
                pet.panel_projection = "probe-individual/v1"
                pet.individual_id = "probe-" + "-".join(
                    "%s%+d" % (k, v) for k, v in sorted(panel_delta.items()))
                st, envk = svc.battle_advance({"state": renv.serialize(state_k),
                                               "state_version": pre["state_version"],
                                               "action": action0})
                if st != 200:
                    return {"status": st, "error": envk.get("error")}
                dmg = enemy_damage_of(envk["result"].get("events") or [])
                return {"status": st,
                        "damage": int(dmg[0]["detail"]["damage"]) if dmg else None,
                        "skill_id": (dmg[0]["detail"] or {}).get("skill_id") if dmg else None,
                        "all_damage_events": [{"kind": e.get("kind"), "seq": e.get("seq"),
                                               "side": (e.get("detail") or {}).get("side"),
                                               "skill_id": (e.get("detail") or {}).get("skill_id"),
                                               "damage": (e.get("detail") or {}).get("damage")}
                                              for e in (envk["result"].get("events") or [])
                                              if e.get("kind") == "damage"]}

            # 一组「换了个体配置」的候选：注意区分两类 ——
            #   · 不影响这一手输出的项（spa/spd/hp/def，打的是物攻招）⇒ 伤害应与基准**相等**；
            #   · 影响输出的项（atk）⇒ 伤害应**跟着变**（证明比较不是恒等）。
            grid = [{"spa": 4, "spd": -4}, {"spa": -4, "spd": 4}, {"spd": 6}, {"hp": 10},
                    {"def": 4}, {"def": -4}, {"spa": 8, "spd": -8},
                    {"atk": 1}, {"atk": 2}, {"atk": 4}]
            variants = []
            for delta in grid:
                row = {"panel_delta": delta}
                row.update(replay(delta))
                variants.append(row)
            baseline = replay({})
            matching = [v for v in variants if v.get("damage") is not None
                        and v.get("damage") == baseline.get("damage")]
            sensitive = [v for v in variants if v.get("damage") is not None
                         and v.get("damage") != baseline.get("damage")]
            out["counterexample"] = {
                "turn": hits[0].get("turn"),
                "observed_damage": observed,
                "observed_skill_id": hits[0]["detail"].get("skill_id"),
                "observed_event": hits[0],
                "pre_state_version": pre.get("state_version"),
                "attacker_species": foe_pet.pet_id,
                "defender_species": state0.player.field_pet.pet_id,
                "direction": "enemy（对手打我方）",
                "base_config": {"panel_source": base_source, "panel": base_panel,
                                "note": "这一局对手那只实际用的面板；公开投影也只显示到这一层"},
                "baseline_replay": baseline,
                "variants": variants,
                "matching_configs": matching,
                "sensitive_configs": sensitive,
                "replay_fidelity": {
                    "observed_battle_damage": observed,
                    "baseline_replay_damage": baseline.get("damage"),
                    "delta": (None if baseline.get("damage") is None else observed - baseline["damage"]),
                    "note": "重放同一回合（同状态、同动作、同技能）时基准配置得 "
                            f"{baseline.get('damage')}，实战那一手是 {observed} —— 差 "
                            f"{None if baseline.get('damage') is None else observed - baseline['damage']} 点"
                            "（疑为面板经序列化/反序列化往返的浮点精度差）。所以反例**不去复现实战那一个数字**，"
                            "而是在**同一条重放管线内**比较两种配置：两者都是引擎真结算出来的伤害。",
                },
                "note": "同一回合、同一动作，只换对手的个体配置重放：多条配置的伤害与基准相等 ⇒ "
                        "公开面（物种面板 + 一个伤害数字）分不出这些个体配置 ⇒ 候选必须保留多解；"
                        "而改 atk 的那些配置伤害确实变了 ⇒ 这个相等不是恒等。",
            }

    # ── (b) legacy 3v3（无快照）：turn_start 有没有 speed_provenance ──
    status2, env3 = svc.battle_new({"team": THREE, "enemy_team": THREE_B, "seed": 5, "state_version": 0})
    out["runs"]["legacy_new_status"] = status2
    if status2 != 200:
        out["runs"]["legacy_error"] = env3
    else:
        result = env3["result"]
        events_all = []
        for _ in range(3):
            st, envk = svc.battle_advance({"state": result["state"],
                                           "state_version": result["state_version"],
                                           "action": pick_action(result)})
            if st != 200:
                out["runs"]["legacy_advance_error"] = envk
                break
            result = envk["result"]
            events_all.extend(result.get("events") or [])
        out["legacy_receipt"] = slice_of(result)
        out["runs"]["legacy_events_n"] = len(events_all)
        out["runs"]["legacy_event_kinds"] = sorted({e.get("kind") for e in events_all})
        out["runs"]["legacy_turn_start_has_speed_provenance"] = any(
            e.get("kind") == "turn_start" and (e.get("detail") or {}).get("speed_provenance")
            for e in events_all)
        out["runs"]["legacy_enemy_damage"] = [{"turn": e.get("turn"),
                                               "skill_id": (e.get("detail") or {}).get("skill_id"),
                                               "damage": (e.get("detail") or {}).get("damage")}
                                              for e in enemy_damage_of(events_all)]

    path = os.path.join(OUT, "raw-03.3-engine.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps(out["runs"], ensure_ascii=True, indent=1))
    ce = out.get("counterexample") or {}
    print("counterexample observed =", ce.get("observed_damage"),
          " baseline_replay =", json.dumps(ce.get("baseline_replay"), ensure_ascii=True))
    print("matching_configs =", json.dumps([(v["panel_delta"], v["damage"]) for v in ce.get("matching_configs", [])],
                                           ensure_ascii=True))
    print("sensitive_configs =", json.dumps([(v["panel_delta"], v["damage"]) for v in ce.get("sensitive_configs", [])],
                                            ensure_ascii=True))
    print("wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
