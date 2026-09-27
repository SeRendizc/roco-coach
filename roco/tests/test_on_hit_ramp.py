"""RC-401 批次十三：**「每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N」**。

可达性工作单第一名：`skill_000500 岩土暴击`（「造成物伤，**每被攻击1次。本技能能耗永久-1**。」）
**35 只精灵的配招里都带**；同族 `skill_000494 绞轮`（每受到1次**抵抗的**技能攻击，能耗永久-1，2 只）、
`skill_000492 微型斥候`（同条件，威力永久+20）。

判据（每条都有必红方向）：

  ① **读得出 + 认得领**：三种写法都从原文取数；「抵抗的」那两条把这个限定词也读进结构里；
     没声明能力时那段文本仍是「未认领机制」（连 `（不含连击）` 里的「连击」也算未认领）；
  ② **挨打才累加，而且只翻身上带着的技能**：岩土暴击挨一次打 ⇒ 能耗 8 → 7；没挨打 ⇒ 不变；
  ③ **「抵抗的」是硬条件**：`绞轮` 只在**被抵抗**的那一次累加（同一局面用不被抵抗的攻击 ⇒ 一次都不加）；
  ④ **一次攻击只算一次**（「不含连击」）：连击技能打过来，`on_hit_ramp` 事件也只有一条；
  ⑤ **legacy 逐位不变** + **反证**（能力位关掉 ⇒ 加成消失）。
"""

from __future__ import annotations

import dataclasses
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as rcov        # noqa: E402
from roco_env import data as rdata           # noqa: E402
from roco_env import effects as fx           # noqa: E402
from roco_env import env as renv             # noqa: E402
from roco_env import parse as rparse         # noqa: E402
from roco_env import rule_config as rc       # noqa: E402
from roco_env.schema import Action, ACTION_SKILL   # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
ROCK = "skill_000500"        # 岩土暴击：每被攻击1次。本技能能耗永久-1
WINCH = "skill_000494"       # 绞轮：每受到1次抵抗的技能攻击（不含连击），本技能能耗永久-1
SCOUT = "skill_000492"       # 微型斥候：同条件，威力永久+20
OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
              "confidence": "ENGINE_HYPOTHESIS", "reason": "MC-E05 未录制", "microcase_id": "MC-E05"}]
FOE_LEAD = "pet_000050"


def _carrier(skill_id):
    for pid in sorted(RS.pets):
        if skill_id in (RS.candidate_moveset(pid) or ()):
            return pid
    raise AssertionError(f"语料里找不到带 {skill_id} 的精灵，夹具失效")


class OnHitRampParseTest(unittest.TestCase):
    def test_structures_are_read(self):
        rock = rparse.parse_skill(RS.skills[ROCK]).on_hit_ramp
        self.assertEqual((rock["field"], rock["delta"], rock["requires_resisted"]), ("cost", -1, False))
        winch = rparse.parse_skill(RS.skills[WINCH]).on_hit_ramp
        self.assertEqual((winch["field"], winch["delta"], winch["requires_resisted"]), ("cost", -1, True))
        scout = rparse.parse_skill(RS.skills[SCOUT]).on_hit_ramp
        self.assertEqual((scout["field"], scout["delta"], scout["requires_resisted"]), ("power", 20, True))

    def test_claim_follows_the_declared_capability(self):
        for sid in (ROCK, WINCH):
            skill = RS.skills[sid]
            off = rparse.parse_skill(skill)
            self.assertNotIn("on_hit_ramp", [e.kind for e in off.effects], "未声明时不许自己补效果")
            self.assertTrue(any("每" in s for s in rparse.unclaimed_mechanic_spans(skill, parsed=off)),
                            f"{sid} 未声明时那段必须是未认领")
            on = rparse.resolve_on_hit_ramp(skill, declared=True)
            self.assertEqual(rparse.unclaimed_mechanic_spans(skill, parsed=on), [],
                             f"{sid} 声明后不该再有未认领片段（含「（不含连击）」里的「连击」）")
        caps = rcov.declared_capabilities_of()
        self.assertEqual(rcov.classify_skill(RS.skills[ROCK])["support"], rcov.SUPPORT_PARTIAL)
        self.assertEqual(rcov.classify_skill(RS.skills[ROCK],
                                             on_hit_ramp_declared=caps["on_hit_ramp"])["support"],
                         rcov.SUPPORT_SIMULATABLE_UNVERIFIED)


class OnHitRampEngineTest(unittest.TestCase):
    def _state(self, skill_id, config_id=V3, team_size=6):
        cfg = rc.get_rule_config(config_id)
        carrier = _carrier(skill_id)
        team = [carrier] + [p for p in RS.pets if p != carrier][:team_size - 1]
        foe = [FOE_LEAD] + [p for p in RS.pets if p not in (carrier, FOE_LEAD)][:team_size - 1]
        kwargs = {"unverified_overrides": OVERRIDES} if cfg.has_mana or cfg.allowed_kinds else {}
        state = renv.reset(team, foe, seed=7, rs=RS, config=cfg, **kwargs)
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = 20
                pet.max_hp = 9999
                pet.hp = 9999
        return state, cfg

    def _foe_attacks(self, state):
        """对手**首发**能用的技能攻击，按"是否被抵抗"分成两组（相性倍率由引擎自己算）。"""
        defender = state.player.field_pet
        foe_pet = state.enemy.field_pet
        out = {"resisted": None, "normal": None}
        for sid in (RS.candidate_moveset(foe_pet.pet_id) or ()):
            skill = RS.skills.get(sid)
            if skill is None or not skill.is_attack or skill.is_defense or not (skill.power or 0):
                continue
            mult = fx.compute_damage(foe_pet, defender, skill, RS).type_multiplier
            key = "resisted" if mult < 1 else "normal"
            out.setdefault(key, Action(kind=ACTION_SKILL, skill_id=sid))
            if out[key] is None:
                out[key] = Action(kind=ACTION_SKILL, skill_id=sid)
        return out

    def _idle(self, state):
        """玩家这一手用一个**不含 ramp** 的技能（免得自己的 ramp 干扰读数）。"""
        for sid in (RS.candidate_moveset(state.player.field_pet.pet_id) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and not rparse.parse_skill(skill).on_hit_ramp:
                return Action(kind=ACTION_SKILL, skill_id=sid)
        return Action(kind=ACTION_SKILL, skill_id=ROCK)

    def test_cost_ramps_each_time_the_holder_is_attacked(self):
        state, cfg = self._state(ROCK)
        self.assertTrue(cfg.damage_on_hit_ramp, "v3 必须声明这条能力")
        skill = RS.skills[ROCK]
        base = int(skill.energy)
        attacks = self._foe_attacks(state)
        self.assertIsNotNone(attacks["normal"], "夹具需要一个不被抵抗的攻击")
        self.assertEqual(renv.effective_skill_cost(state.player.field_pet, skill, cfg,
                                                  weather=state.weather), base, "还没挨打")
        for index in (1, 2):
            state = renv.step_joint(state, RS, self._idle(state), attacks["normal"])
            self.assertEqual(renv.effective_skill_cost(state.player.field_pet, skill, cfg,
                                                      weather=state.weather), base - index,
                             f"挨了 {index} 次打之后应当是 {base - index}")
        self.assertEqual(len([e for e in state.events if e.kind == "on_hit_ramp"]), 2)

    def test_counter_attack_only_once_per_attack_even_for_multi_hit(self):
        """「不含连击」：连击技能打过来，`on_hit_ramp` 也只许记一条。"""
        state, _ = self._state(ROCK)
        multi = None
        for sid in (RS.candidate_moveset(FOE_LEAD) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and skill.is_attack and (rparse.parse_skill(skill).hit_count or 1) > 1:
                multi = Action(kind=ACTION_SKILL, skill_id=sid)
                break
        if multi is None:
            self.skipTest("对手首发的配招里没有连击技能，这一条在本夹具里驱动不出来")
        state = renv.step_joint(state, RS, self._idle(state), multi)
        ramps = [e for e in state.events if e.kind == "on_hit_ramp"]
        self.assertEqual(len(ramps), 1, f"一次攻击只算一次，实际 {len(ramps)} 条")

    def test_resisted_qualifier_is_enforced(self):
        """`绞轮` 只在**被抵抗**时累加（硬条件，不是"挨打就算"）。"""
        state, cfg = self._state(WINCH)
        skill = RS.skills[WINCH]
        base = int(skill.energy)
        attacks = self._foe_attacks(state)
        if attacks["resisted"] is None:
            self.skipTest("这对夹具里对手首发没有被抵抗的攻击，这一条驱动不出来")
        # 不被抵抗的那一种 ⇒ 一点都不许加
        if attacks["normal"] is not None:
            s1 = renv.step_joint(state, RS, self._idle(state), attacks["normal"])
            self.assertEqual(renv.effective_skill_cost(s1.player.field_pet, skill, cfg,
                                                      weather=s1.weather), base,
                             "没被抵抗就不许累加")
            self.assertFalse(getattr(s1.player.field_pet, "skill_ramps", None))
        # 被抵抗的那一种 ⇒ 加 1
        s2 = renv.step_joint(state, RS, self._idle(state), attacks["resisted"])
        self.assertEqual(renv.effective_skill_cost(s2.player.field_pet, skill, cfg,
                                                  weather=s2.weather), base - 1)
        self.assertTrue(any(e.kind == "on_hit_ramp" and e.detail.get("resisted") for e in s2.events))

    def test_legacy_is_bit_identical(self):
        state, cfg = self._state(ROCK, config_id=LEGACY, team_size=3)
        self.assertFalse(cfg.damage_on_hit_ramp, "legacy 不该凭空多出这条能力")
        skill = RS.skills[ROCK]
        attacks = self._foe_attacks(state)
        action = attacks["normal"] or attacks["resisted"]
        state = renv.step_joint(state, RS, self._idle(state), action)
        self.assertEqual(renv.effective_skill_cost(state.player.field_pet, skill, cfg,
                                                  weather=state.weather), int(skill.energy))
        self.assertFalse(getattr(state.player.field_pet, "skill_ramps", None))

    def test_reverse_proof_switching_the_capability_off(self):
        from unittest import mock
        state, cfg = self._state(ROCK)
        skill = RS.skills[ROCK]
        attacks = self._foe_attacks(state)
        flipped = dataclasses.replace(cfg, damage_on_hit_ramp=False)
        with mock.patch.object(renv._rule_config, "get_rule_config", lambda *a, **k: flipped):
            state2 = renv.step_joint(state, RS, self._idle(state), attacks["normal"])
        self.assertEqual(renv.effective_skill_cost(state2.player.field_pet, skill, flipped,
                                                  weather=state2.weather), int(skill.energy),
                         "能力位关掉就不许累加")


if __name__ == "__main__":
    unittest.main()
