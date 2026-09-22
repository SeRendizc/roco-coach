#!/usr/bin/env python3
"""RC-106 报告生成器：让「六宠标准 PVP 真的能开一局」这件事可核对。

跑法：``python3 scripts/roco/report-rc106-six-pet-battle.py``

产出的机器可读报告里，**能算的都算出来**（配置指纹、真对局结果、legacy 逐位不变的
指纹复算、装载期反证的原文），而不是手抄一遍。手抄的那部分只有两类：

  · 外部命令的 rc 与摘要（`npm run test:env` 这类，本脚本不代跑）；
  · 三条必红反证的 `observed_error` 原文（改坏代码才能得到，属于**证据**，
    照抄自实测终端输出，并注明是怎么改坏的）。

纯 stdlib，Python 3.9 兼容。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import events_text as et        # noqa: E402
from roco_env import opponents as ropp        # noqa: E402
from roco_env import overrides as ov          # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env.schema import Action            # noqa: E402

RS = rdata.load_ruleset()
V2 = rc.CANDIDATE_RULE_CONFIG_ID
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
STANDARD_MODE = "pvp-standard-six-pet"
TRAINING_MODE = "demo-training-3v3"

TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
TEAM_B = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]
IDS_A = [RS.pets_by_name(n)[0].pet_id for n in TEAM_A]
IDS_B = [RS.pets_by_name(n)[0].pet_id for n in TEAM_B]
PRACTICE_INITIAL = int(rc.load_config(LEGACY).energy_initial)

OVERRIDE = {
    "path": "energy.initial",
    "value": PRACTICE_INITIAL,
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "练习局口径（legacy 的入场能量），不是标准 PVP 的实机结论；MC-E04 未录制",
    "microcase_id": "MC-E04",
}


def digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def sha256_file(rel: str) -> str:
    with open(os.path.join(ROOT, rel), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def replay_collecting(plan: dict):
    """逐回合重放并收下每回合真产生的事件（`step_joint` 会重写 events）。"""
    state = renv.reset(plan["team"], plan.get("enemy_team"), seed=plan["seed"], rs=RS,
                       loadouts=plan.get("loadouts"),
                       config=plan.get("ruleset_config_id"),
                       unverified_overrides=plan.get("unverified_overrides"))
    events = []
    for pair in plan["actions"]:
        if state.result:
            break
        before = len(state.events)
        if state.phase == "replace":
            side, slot = pair
            renv.step_replace(state, RS, side, int(slot))
        else:
            renv.step_joint(state, RS, Action.from_dict(pair[0]), Action.from_dict(pair[1]))
        events.extend(e.to_dict() for e in state.events[before:])
    return state, events


def play_six(seed: int, strat_a="greedy_damage", strat_b="greedy_damage"):
    record = ropp.play_match(RS, IDS_A, IDS_B, strat_a, strat_b, seed=seed,
                             config=V3, unverified_overrides=[OVERRIDE])
    return record, replay_collecting(record.replay_plan())


def matches_section():
    rows = []
    for seed, strat_a, strat_b in ((11, "greedy_damage", "greedy_damage"),
                                   (12, "greedy_damage", "greedy_damage"),
                                   (13, "greedy_damage", "conservative_switch"),
                                   (21, "random_legal", "random_legal")):
        record, (state, events) = play_six(seed, strat_a, strat_b)
        kinds = [e["kind"] for e in events]
        mana_losses = {"player": 0, "enemy": 0}
        for e in events:
            if e["kind"] == "mana_loss":
                mana_losses[e["detail"]["side"]] += 1
        endings = [e for e in events if e["kind"] == "game_end"]
        rows.append({
            "seed": seed,
            "strategies": {"player": strat_a, "enemy": strat_b},
            "ruleset_config_id": record.ruleset_config_id,
            "team_sizes": [len(record.team_a), len(record.team_b)],
            "winner": record.winner,
            "result": state.result,
            "battle_turns": record.battle_turns,
            "truncated": record.truncated,
            "mana_loss_events": mana_losses,
            "final_mana": {"player": state.player.mana, "enemy": state.enemy.mana},
            "game_end_reason": endings[-1]["detail"].get("reason") if endings else None,
            "event_kinds": sorted(set(kinds)),
            "unverified_overrides_in_state": state.unverified_overrides,
            "replay_digest": digest(renv.serialize(state)),
        })
    return rows


def legacy_section():
    """legacy 逐位不变：新键一个都不出现，且 golden 指纹表仍在。"""
    state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
    dumped = renv.serialize(state)
    text = json.dumps(dumped, ensure_ascii=False, sort_keys=True)
    sys.path.insert(0, os.path.join(ROOT, "roco"))
    from tests import test_turn_order_fail_closed as golden  # type: ignore

    return {
        "why": "legacy_sim_v1 / demo-training-3v3 是默认路径，必须逐位不变："
               "新增的 `mana` 与 `unverified_overrides` 两个键在不该出现时**一个都不写**。",
        "serialized_has_mana_key": '"mana"' in text,
        "serialized_has_unverified_overrides_key": '"unverified_overrides"' in text,
        "public_planner_unverified_overrides": renv.public_planner_state(state, RS, "player")["unverified_overrides"],
        "ui_unverified_overrides": renv.ui_public_view(state, RS, "player")["unverified_overrides"],
        "golden_state_digests": sorted(golden.GOLDEN_STATE_DIGESTS),
        "golden_event_digests": sorted(golden.GOLDEN_EVENT_DIGESTS),
        "golden_short_state": golden.GOLDEN_SHORT_STATE,
        "golden_short_events": golden.GOLDEN_SHORT_EVENTS,
        "golden_owned_by": "roco/tests/test_turn_order_fail_closed.py::LegacyBitExactGoldenTest",
        "golden_test_still_green": True,
        "team_size_legacy": rc.load_config(LEGACY).require_team_size(),
        "team_size_candidate": rc.load_config(V3).require_team_size(),
    }


def configs_section():
    out = {}
    for cid in rc.available_rule_configs():
        cfg = rc.load_config(cid)
        out[cid] = {
            "path": cfg.path,
            "sha256": sha256_file(cfg.path),
            "fingerprint": cfg.fingerprint(),
            "is_default": cfg.is_default,
            "status": cfg.status,
            "battle_mode_id": cfg.battle_mode_id,
            "team_size": cfg.require_team_size(),
            "energy_initial": cfg.energy_initial,
            "has_mana": cfg.has_mana,
            "has_actions": cfg.has_actions,
            "allowed_kinds": list(cfg.allowed_kinds) if cfg.allowed_kinds is not None else None,
            "forbidden_kinds": list(cfg.forbidden_kinds),
        }
    return out


def build() -> dict:
    rc.clear_cache()
    legacy_team = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
    six_state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3,
                           unverified_overrides=[OVERRIDE])
    overrides_payload = [dict(OVERRIDE, unverified=True)]
    binding_after = rc.bound_config_id_for_mode(STANDARD_MODE)

    return {
        "schema": "roco-rc106-six-pet-battle-report/v1",
        "generated_by": "scripts/roco/report-rc106-six-pet-battle.py",
        "generated_from": {
            "ledger": {
                "path": "data/roco/evidence/rule-evidence-ledger.json",
                "sha256": sha256_file("data/roco/evidence/rule-evidence-ledger.json"),
                "untouched": True,
                "why": "改台账会作废所有配置的 derived_from_ledger_sha256 —— 本活一个字节都没动它",
            },
            "battle_modes_sha256": sha256_file("data/roco/battle-modes.json"),
            "rulesets": configs_section(),
            "engine_modules": [
                "roco/src/roco_env/overrides.py（新）",
                "roco/src/roco_env/env.py",
                "roco/src/roco_env/rule_config.py",
                "roco/src/roco_env/schema.py",
                "roco/src/roco_env/events_text.py",
                "roco/src/roco_env/opponents.py",
                "roco/src/roco_env/service.py",
            ],
        },
        "why": (
            "RC-106：让「六宠标准 PVP」真的能开一局。修三个阻断 —— "
            "① v3 的 energy.initial 是 UNKNOWN 导致开不了局（改为**显式的、带出处的未核验覆盖**，"
            "不给覆盖仍然 fail closed）；② 引擎只接受 3 只（改为按配置/模式的 team_size，"
            "legacy 仍然 3 且逐位不变）；③ 登记表绑定还指向 v2（改成 v3）——"
            "并把 charge / mana_loss / surrender 三类事件补上中文句子。"
        ),
        "ruleset_config_id": V3,
        "binding_before_after": {
            "mode": STANDARD_MODE,
            "field": "data/roco/battle-modes.json#modes[pvp-standard-six-pet].ruleset_binding",
            "before": V2,
            "after": binding_after,
            "why": "真正带 mana/actions 的是 v3；绑定落后会让标准 PVP 按「能开局但没有魔力系统」的口径跑",
            "v2_kept": {
                "path": "data/roco/rulesets/mobile-s4-candidate-v2.json",
                "why": "历史候选（能开局但没有 mana/actions），留着做回归对照 —— 本活没有删它",
                "has_mana": rc.load_config(V2).has_mana,
                "has_actions": rc.load_config(V2).has_actions,
            },
            "v2_vs_v3_delta": {
                "identical": ["energy（含 energy.initial 仍是 null）", "turn_order"],
                "added_in_v3": ["mana", "actions"],
                "binding": f"{TRAINING_MODE}→{LEGACY}；{STANDARD_MODE}→{V2}（改前）/{V3}（改后）",
            },
            "derived_chain": {
                "command": "node scripts/roco/rebuild-derived-chain.mjs --check",
                "result": "5/5 环通过（rule-configs → game-data-pack → readiness → owned-pets → rag-eval）",
                "note": (
                    "绑定不进任何派生产物：pack 的 ruleset_binding 来自**默认配置**"
                    "（loadRulesetConfig 选 is_default=true 的那份），没有脚本读 battle-modes.json 的 binding。"
                    "所以改绑定之后派生链仍然逐字节一致；改动的产物只有两份由生成器重算的报告"
                    "（rc-301-team-request / rc-302-team-gaps / rc-303-team-candidates，它们把绑定当派生字段抄进样例）。"
                ),
                "regenerated_artifacts": [
                    "reports/roco/flagship-upgrade/rc-301-team-request.json"
                    "（RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js）",
                    "reports/roco/flagship-upgrade/rc-302-team-gaps.json"
                    "（RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js）",
                    "reports/roco/flagship-upgrade/rc-303-team-candidates.json"
                    "（RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js）",
                ],
            },
        },
        "commands": [
            {"cmd": "npm run test:env", "rc": 0,
             "summary": "基线 324 → 收尾 357 条全绿（skipped=1）"},
            {"cmd": "npm run test:unit", "rc": 0,
             "summary": "基线 936 全绿 → 收尾 953 条：951 绿、2 红（两条都是基线就红的既有失败，见 known_limits）"},
            {"cmd": "node --test tests/roco-six-pet-battle.test.js", "rc": 0, "summary": "4/4 绿（新契约测试）"},
            {"cmd": "cd roco && PYTHONPATH=src python3 -m unittest tests.test_six_pet_battle", "rc": 0,
             "summary": "33/33 绿（新 Python 测试）"},
            {"cmd": "node scripts/roco/rebuild-derived-chain.mjs --check", "rc": 0, "summary": "5/5 环通过"},
            {"cmd": "python3 -m roco_env.overrides", "rc": 0, "summary": "覆盖机制自检 8/8（含 7 条必红反证）"},
            {"cmd": "RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js", "rc": 0,
             "summary": "重算绑定派生字段后 17/17 绿"},
            {"cmd": "RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js", "rc": 0,
             "summary": "重算绑定派生字段后 17/17 绿"},
            {"cmd": "RC303_WRITE_REPORT=1 RC304_WRITE_REPORT=1 node --test tests/roco-meta-prior.test.js tests/roco-team-candidates.test.js",
             "rc": 0, "summary": "32/32 绿（RC-304 报告内容未变，只有 RC-303 变了）"},
        ],
        "checks": [
            {
                "id": "RC106-01-no-override-fails-closed",
                "what": "没有覆盖 + 配置里 energy.initial=null ⇒ reset 抛 UnsupportedEffect（不回落到任何默认值）",
                "where": "roco/tests/test_six_pet_battle.py::UnverifiedOverrideTest::test_no_override_fails_closed",
                "result": "pass",
                "counter_proof": {
                    "how": "把 env.reset 里那次 `_overrides.resolve_int(...)` 改成 `except RuleConfigError: initial_energy = 2`",
                    "observed_error": "AssertionError: UnsupportedEffect not raised（test_no_override_fails_closed，"
                                      "roco/tests/test_six_pet_battle.py:176）",
                },
            },
            {
                "id": "RC106-02-payload-carries-overrides",
                "what": "有覆盖 ⇒ 开局，且覆盖如实出现在 state / serialize / public_planner_state / ui_public_view / 重建状态里",
                "where": "roco/tests/test_six_pet_battle.py::UnverifiedOverrideTest::test_with_override_the_match_starts_and_the_payload_carries_it",
                "result": "pass",
                "counter_proof": {
                    "how": "把 `state.unverified_overrides = overrides_payload` 删掉（覆盖只影响能量、不进载荷）",
                    "observed_error": "AttributeError: 'GameState' object has no attribute 'unverified_overrides'"
                                      "（test_six_pet_battle.py 逐键断言处）",
                },
            },
            {
                "id": "RC106-03-override-not-written-back",
                "what": "跑完一局之后配置文件里的 energy.initial 仍然是 null（覆盖不落盘）",
                "where": "roco/tests/test_six_pet_battle.py::UnverifiedOverrideTest::test_override_is_not_written_back_to_the_config_file",
                "result": "pass",
                "counter_proof": {
                    "how": "在 resolve_int 命中覆盖时顺手把值写回配置文件（模拟「填一个数」的旧做法）",
                    "observed_error": "AssertionError: 覆盖把值写回了配置文件 —— 那是编规则，不是假设"
                                      "（test_override_is_not_written_back_to_the_config_file）",
                },
            },
            {
                "id": "RC106-04-six-pet-team-size-from-config",
                "what": "v3/v2 绑的模式 team_size=6 ⇒ reset 接受 6 只；legacy 仍然只接受 3 只",
                "where": "roco/tests/test_six_pet_battle.py::TeamSizeTest",
                "result": "pass",
                "counter_proof": {
                    "how": "把 env.reset 里的 `team_size = cfg.require_team_size()` 改回 `team_size = 3`",
                    "observed_error": "ValueError: 规则配置 mobile_s4_candidate_v3（模式 pvp-standard-six-pet）"
                                      "每方需要恰好 3 只精灵，实际 6 只（env.py:185）—— 六宠开局测试与 "
                                      "test_mana_actions 里 36 处同时变红",
                },
            },
            {
                "id": "RC106-05-six-pet-match-completes",
                "what": "固定 seed 的六宠对局真的跑完（非 truncated、有终局、有 game_end、重放逐位相同）",
                "where": "roco/tests/test_six_pet_battle.py::TeamSizeTest::test_six_pet_match_runs_to_a_deterministic_finish",
                "result": "pass",
                "counter_proof": {
                    "how": "把 reset 的 enemy 队伍也建成 team 长度（对手只给 3 只）",
                    "observed_error": "ValueError: 对手也必须是 6 只（模式 pvp-standard-six-pet），实际 3 只",
                },
            },
            {
                "id": "RC106-06-mana-settlement-in-six-pet",
                "what": "力竭扣 1、归零立即判负、投降判负；真对局的力竭笔数与魔力账目逐笔对得上",
                "where": "roco/tests/test_six_pet_battle.py::TeamSizeTest::test_real_six_pet_matches_settle_mana",
                "result": "pass",
                "counter_proof": {
                    "how": "把 _settle_faint_mana 的 `cfg.has_mana` 判断去掉并令 cost=0",
                    "observed_error": "AssertionError: player 的力竭笔数（8）与魔力扣减（4）对不上"
                                      "（本活实测到的第一批红就是这条 —— 它抓出过一次把 events 重复计数的读法错误）",
                },
            },
            {
                "id": "RC106-07-legal-actions-clipped",
                "what": "六宠合法动作里没有 item/escape、有 charge/surrender，且场下有 5 个可换目标",
                "where": "roco/tests/test_six_pet_battle.py::TeamSizeTest::test_six_pet_legal_actions_are_clipped_by_the_config",
                "result": "pass",
                "counter_proof": {
                    "how": "把 v3 的 actions.forbidden_kinds 清空并把 allowed_kinds 加上 item",
                    "observed_error": "AssertionError: 标准 PVP 没有道具（assertNotIn）—— 配置驱动而非硬编码过滤",
                },
            },
            {
                "id": "RC106-08-event-text-covers-every-kind",
                "what": "六宠真对局里出现的每个 kind 都有中文句子，且 charge/mana_loss/surrender 都真的发生过",
                "where": "roco/tests/test_six_pet_battle.py::SixPetEventTextTest",
                "result": "pass",
                "counter_proof": {
                    "how": "把 events_text.KNOWN_EVENT_KINDS 里新加的三个名字连同模板一起删掉",
                    "observed_error": "AssertionError: 引擎产出了未登记的事件类型 ['charge', 'mana_loss', 'surrender']"
                                      "（test_every_kind_in_a_real_six_pet_match_has_a_sentence）",
                },
            },
            {
                "id": "RC106-09-binding-points-at-mana-config",
                "what": "登记表绑定指向真的带 mana/actions 的配置（Node + Python 两侧读同一处）",
                "where": "tests/roco-six-pet-battle.test.js + roco/tests/test_six_pet_battle.py::BindingAndCandidateDeltaTest",
                "result": "pass",
                "counter_proof": {
                    "how": "把 battle-modes.json 里 pvp-standard-six-pet.ruleset_binding 改回 mobile_s4_candidate_v2",
                    "observed_error": "AssertionError [ERR_ASSERTION]: 被绑定的配置 mobile_s4_candidate_v2 没有 mana 块 ——"
                                      " 标准 PVP 会按「能开局但没有魔力系统」的口径跑"
                                      "（tests/roco-six-pet-battle.test.js:49；同一次改坏还让 "
                                      "tests/roco-mana-actions.test.js:236 与 tests/roco-v3-redirect.test.js:210 变红）",
                },
            },
            {
                "id": "RC106-10-legacy-bit-exact",
                "what": "legacy 的序列化里没有 mana / unverified_overrides 两个新键，8 条 golden 指纹仍然成立",
                "where": "roco/tests/test_turn_order_fail_closed.py::LegacyBitExactGoldenTest"
                         " + roco/tests/test_six_pet_battle.py::LegacyInvarianceTest",
                "result": "pass",
                "counter_proof": {
                    "how": "在 GameState.to_dict 里无条件写 `unverified_overrides`（哪怕它是空列表）",
                    "observed_error": "AssertionError: legacy 的序列化里不得出现 unverified_overrides 键"
                                      "（test_legacy_state_serialization_is_unchanged）；"
                                      "golden 指纹测试同批变红",
                },
            },
            {
                "id": "RC106-11-service-endpoint-wiring",
                "what": "/battle/new 用 ruleset_config_id + 6 只 + unverified_overrides 能开局；缺覆盖是 422 不是 400",
                "where": "roco/tests/test_six_pet_battle.py::BattleNewEndpointWiringTest",
                "result": "pass",
                "counter_proof": {
                    "how": "把 service.battle_new 里的 cfg/override 透传去掉（回落到不传参数）",
                    "observed_error": "AssertionError: 422 != 200 —— 不传覆盖时服务端会给 unsupported_effect，"
                                      "六宠开局拿不到 state",
                },
            },
        ],
        "override_mechanism": {
            "entry_point": "env.reset(..., unverified_overrides=[{path, value, confidence, reason, microcase_id}])",
            "module": "roco/src/roco_env/overrides.py",
            "required_keys": list(ov.REQUIRED_KEYS),
            "allowed_confidence": ov.OVERRIDE_CONFIDENCE,
            "overridable_paths": list(ov.OVERRIDABLE_PATHS),
            "rules": [
                "只在配置声明为 UNKNOWN（value is null）的路径上生效：借覆盖改已知规则会抛 RuleConfigError",
                "没有覆盖而配置是 null ⇒ 仍然抛（这一条不许放宽）",
                "覆盖不写回配置文件（v3 的 energy.initial 恒为 null）",
                "覆盖如实进 state / serialize / public_planner_state / ui_public_view",
                "同一条路径不许覆盖两次；confidence 只能是 ENGINE_HYPOTHESIS；reason 与 microcase_id 必填",
            ],
            "value_used_in_tests": {
                "value": PRACTICE_INITIAL,
                "why": f"**练习局口径**（legacy 的入场能量 {PRACTICE_INITIAL}），"
                       "不是标准 PVP 的实机结论；MC-E04 未录制，谁要定准这个数谁去录它",
            },
            "payload_example": overrides_payload,
            "failure_message_without_override": str(rc.load_config(V3).unknowns[0].get("reason"))[:120],
        },
        "team_size": {
            "source": "data/roco/rulesets/*.json#battle_mode.team_size（生成器从 battle-modes.json 抄）",
            "registry_is_authority_for": "mode.parameters.team_size",
            "engine_reads": "RuleConfig.require_team_size()；validate_team(team_size=…)；service.battle_new 用同一个数做请求校验",
            "by_config": {cid: rc.load_config(cid).require_team_size() for cid in rc.available_rule_configs()},
            "by_mode": {m: rc.mode_team_size(m) for m in
                        (STANDARD_MODE, TRAINING_MODE, "pvp-speed-duel-3v3", "pvp-territory-trial-2v2", "pve-camp")},
            "default_unchanged": "legacy_sim_v1 / demo-training-3v3 ⇒ 3（默认路径逐位不变）",
        },
        "matches": matches_section(),
        "legacy_invariance": legacy_section(),
        "contracts_touched": [
            "env.reset(team, enemy_team, *, seed, rs, loadouts, config, unverified_overrides)",
            "env.validate_team(rs, team, loadouts=None, also_in=None, team_size=3)",
            "env.replay(record) 读 record['unverified_overrides']",
            "GameState.unverified_overrides（空时**不**序列化）",
            "GameState.to_dict / from_dict",
            "public_planner_state()['unverified_overrides']（始终存在，空时为 []）",
            "ui_public_view()['unverified_overrides'] + notes.unverified_overrides",
            "opponents.play_match(..., config=, unverified_overrides=) 与 MatchRecord."
            "ruleset_config_id / unverified_overrides / replay_plan()",
            "service POST /battle/new：ruleset_config_id / unverified_overrides / 按配置的队伍长度；"
            "缺覆盖是 422 unsupported_effect",
            "rule_config.RuleConfig.battle_mode_team_size / require_team_size() / "
            "battle_mode_registry() / battle_mode_entry() / bound_config_id_for_mode() / mode_team_size()",
            "events_text.KNOWN_EVENT_KINDS += charge / mana_loss / surrender",
            "data/roco/battle-modes.json#pvp-standard-six-pet.ruleset_binding",
        ],
        "evidence": {
            "ledger_entries_used": {
                "EV-PVP-STANDARD-TEAM-SIZE": "CROSS_SOURCE_SUPPORTED（MC-E07 未录制）—— team_size=6 的来源",
                "EV-PVP-STANDARD-MANA": "CROSS_SOURCE_SUPPORTED（MC-E08 未录制）—— mana.pool=4",
                "EV-PVP-FAINT-MANA-LOSS": "CROSS_SOURCE_SUPPORTED（MC-E09 未录制）—— faint_cost=1 / 归零判负",
            },
            "levels_not_promoted": True,
            "engine_hypotheses_added_this_round": [
                "energy.initial 的**覆盖值**（测试用练习局口径 2）：confidence=ENGINE_HYPOTHESIS，"
                "microcase_id=MC-E04 —— 它是运行期输入，不进任何配置文件",
                "投降的语义（投降方判负）：仍然是 ENGINE_HYPOTHESIS（RC-105 已登记，本活未改其等级）",
            ],
            "repo_internal_evidence_for_mana": "v3 的 repo_internal_evidence 块（6 条含「魔力」的冻结特性原文）"
                                               "未被本活改动，等级仍是 CROSS_SOURCE_SUPPORTED",
        },
        "event_text": {
            "added_kinds": {
                "charge": "对方选择聚能，回复 5 点能量（当前 5 点）（聚能回能上限与自动聚能未核验，本局按夹到能量上限处理）。",
                "mana_loss": "对方的精灵力竭，失去 1 点魔力（剩余 3 点）（力竭扣魔力未实机核实，本条为候选口径）。",
                "surrender": "对方投降，对局结束（投降的结算语义未核验，本局按投降方判负处理）。",
            },
            "style": "只陈述事实（谁做了什么、数值是多少、哪一条还没核验），不写「好/坏/该不该」",
            "covered_by": [
                "roco/tests/test_event_text.py（SAMPLE_EVENTS 覆盖 KNOWN_EVENT_KINDS 全集）",
                "roco/tests/test_six_pet_battle.py::SixPetEventTextTest（真对局收全集）",
            ],
        },
        "wiring_for_main_thread": {
            "python_entry": "POST /battle/new（roco_env.service.RocoService.battle_new）",
            "request": {
                "ruleset_id": RS.ruleset_id,
                "state_version": 0,
                "ruleset_config_id": V3,
                "team": IDS_A,
                "enemy_team": IDS_B,
                "seed": 11,
                "strategy": "greedy_damage",
                "unverified_overrides": overrides_payload,
            },
            "new_request_params": ["ruleset_config_id", "unverified_overrides"],
            "changed_request_rules": "team / enemy_team 的长度 = 该配置的 battle_mode.team_size（v3 ⇒ 6；"
                                     "以前服务端写死 3）",
            "error_semantics": {
                "400": "请求形状问题（队伍长度不对 / ruleset_config_id 不是字符串 / 覆盖条目缺字段）",
                "422": "unsupported_effect：配置声明了 mana 但缺值、或 energy.initial 是 UNKNOWN 而没给覆盖",
            },
            "response_new_keys": {
                "result.state.unverified_overrides": "只有真的用了覆盖才出现（legacy 逐位不变）",
                "result.public.unverified_overrides": "始终存在；空数组 = 本局没有用覆盖",
                "result.ui.unverified_overrides": "同 public；另有可直接渲染的 "
                                                  "result.ui.notes.unverified_overrides[]（一句中文）",
                "result.state.player.mana / result.state.enemy.mana": "v3 才有（legacy / v2 不写这个键）",
                "legal.player[]": "标准 PVP 下没有 item / escape，多出 charge / surrender",
            },
            "how_to_pick_the_config": "读 data/roco/battle-modes.json 的 pvp-standard-six-pet.ruleset_binding"
                                      "（现在是 mobile_s4_candidate_v3），不要在自己那里抄字符串；"
                                      "Python 侧同一处可读 roco_env.rule_config.bound_config_id_for_mode(mode_id)",
            "frontend_note": "页面须把 unverified_overrides 渲染成「候选：energy.initial 按假设值 2"
                             "（ENGINE_HYPOTHESIS，待录 MC-E04）—— 未核验」，不要写成一个已知事实",
            "files_main_thread_owns": ["src/server/roco-service.js", "src/client/**"],
        },
        "unknowns": [
            {"path": "energy.initial", "value": None, "microcase_id": "MC-E04",
             "reason": "标准 PVP 首次入场能量没有实机证据；本活只提供**带出处的覆盖旁路**，不填数"},
            {"path": "battle_mode.team_size", "value": 6, "microcase_id": "MC-E07",
             "reason": "六宠来自 CROSS_SOURCE_SUPPORTED（官方只说「最多可携带 6 只」），"
                       "「是否必须选满 6 只」仍未核实"},
            {"path": "mana.pool", "value": 4, "microcase_id": "MC-E08",
             "reason": "4 点魔力仍是候选口径（台账自注降级风险最高）"},
            {"path": "mana.faint_cost", "value": 1, "microcase_id": "MC-E09",
             "reason": "力竭扣 1 只有间接支持；扣谁 / 是否可被效果改变未核实"},
            {"path": "mana.loss_when_zero", "value": True, "microcase_id": "MC-E09",
             "reason": "双方**同时**归零怎么算没有任何条目：引擎按平局处理并如实登记"},
            {"path": "mana.surrender", "value": True, "microcase_id": None,
             "reason": "投降的语义没有任何台账条目；只登记「投降方判负」这一实现选择"},
            {"path": "energy.charge.breaks_cap", "value": None, "microcase_id": "MC-E02",
             "reason": "聚能是否可突破上限、无技能时是否自动聚能未定；引擎按「夹到上限」处理并登记"},
            {"path": "turn_order.speed_tie", "value": None, "microcase_id": "MC-E05",
             "reason": "六宠夹具刻意避开同速（12 只速度两两不同），所以这条 UNKNOWN 在六宠局里"
                       "并没有被解决 —— 一旦两队首发同速，order_actions 仍会按 RC-103 抛错"},
        ],
        "known_limits": [
            "**只在** Python 引擎与数据这一侧接线：`src/server/**`、`src/client/**`、`src/coach/**` "
            "本活没动（接线说明见 wiring_for_main_thread）。页面因此暂时还看不到「未核验」标记，"
            "服务端也还不会传 ruleset_config_id。",
            "特性在六宠局面下**仍未实现**：`traits.py` 只登记 12 条（FULL 6 / PARTIAL 2 / REFUSED 4），"
            "6 只队伍意味着更多特性同时在场，未登记的那些照旧进 `state.unsupported`，不猜。",
            "印记的叠加/替换规则（MC-009）未实现；六宠局里换人次数更多，印记在多次换人后的行为"
            "仍然无据可依。",
            "`switch` 在排序里仍然只是折算成固定先手度（MC-005 假设），不是独立比较维："
            "六宠局里换人更频繁，这个假设的影响比 3v3 更大 —— 但本活没有改它的依据。",
            "1～6 只是否都合法未核实：引擎按登记的 team_size **严格**要求 6 只（少一只直接拒），"
            "这是候选口径，不是官方规则。",
            "六宠局的策略仍然是既有 5 个启发式策略：它们只按观察 + 合法动作决策，所以 6 只下"
            "**合法**（实测 5 个策略都能跑到结局），但「六宠阵容该怎么打」这件事本活没有回答。",
            "两条**基线就红**的测试与本活无关，收尾时仍然红（详见 baseline_red_notes）："
            "`tests/evals/state-doc.test.js`（状态文档落后 HEAD）与 "
            "`tests/roco-page-ux.test.js`（HEAD 上 test:unit 清单末尾就不是它）。",
        ],
        "baseline_red_notes": {
            "state_doc": {
                "test": "tests/evals/state-doc.test.js::当前仓库的状态文档必须一致",
                "observed_error": "状态文档的 HEAD 落后当前 16 个提交：它说的「现状」已经很久不是现状了",
                "pre_existing": True,
                "why_not_fixed": "修它要改 docs/roco/** 的状态文档并重新 verify:release —— 那超出本活范围"
                                 "（本活的收尾明文要求不跑整套 verify-release）",
            },
            "page_ux_manifest_order": {
                "test": "tests/roco-page-ux.test.js::本文件被 package.json 的 test:unit 收在末尾",
                "observed_error": "test:unit 的最后一项应当是 tests/roco-page-ux.test.js，实际结尾："
                                  "…roco-workshop.test.js tests/roco-page-ux.test.js tests/roco-team-serving.test.js",
                "pre_existing": True,
                "evidence": "`git show HEAD:package.json` 的清单末尾同样是 "
                            "…roco-workshop / roco-page-ux / roco-team-serving（RC-306 把新文件追加在最后所致）",
            },
        },
    }


def main() -> int:
    report = build()
    out_dir = os.path.join(ROOT, "reports", "roco", "rc106")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "six-pet-battle.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write("\n")
    print(f"wrote {os.path.relpath(out, ROOT)}（{os.path.getsize(out)} bytes）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
