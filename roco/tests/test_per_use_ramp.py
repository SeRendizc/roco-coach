"""RC-401 批次十二：**「每次使用后，本技能<威力|能耗|连击数>永久±N」**。

为什么是它（可达性工作单第一名）：`skill_000421 水炮`（「造成魔伤，每次使用后，本技能能耗永久-1」）
**25 只精灵的配招里都带**；同族还有 `重击`（+1 能耗，6 只）、`迫近攻击`（威力+45，1 只）、`吹火`（威力+20）。

判据（每条都有必红方向）：

  ① **读得出 + 认得领**：四种写法（威力/能耗/连击数 × 正负）都从描述原文取数；没声明能力时那段文本
     仍是「未认领机制」，`PetState.skill_ramps` 也不会被写；
  ② **累计真的生效，而且只对这一个技能**：水炮连用三次 ⇒ 能耗 5 → 4 → 3；同一只精灵的**别的**技能不受影响；
  ③ **连击数累计加在出手次数上**（`迫近攻击` 那种威力累计同理，走伤害事件的 `power_used`）；
  ④ **legacy 逐位不变**：没声明能力的配置里，同一个局面能耗与序列化一个字节都不变；
  ⑤ **反证**：把能力位换成 False（连取配置那一步一起换掉）⇒ 第二次出手的能耗回到原价。
"""

from __future__ import annotations

import dataclasses
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as rcov        # noqa: E402
from roco_env import data as rdata           # noqa: E402
from roco_env import env as renv             # noqa: E402
from roco_env import parse as rparse         # noqa: E402
from roco_env import rule_config as rc       # noqa: E402
from roco_env.schema import Action, ACTION_SKILL   # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
CANNON = "skill_000421"      # 水炮：每次使用后能耗永久-1
HEAVY = "skill_000264"       # 重击：每次使用后能耗永久+1
CHARGE = "skill_000250"      # 迫近攻击：每次使用后威力永久+45
BLOW = "skill_000381"        # 吹火：每次使用后威力永久+20
OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
              "confidence": "ENGINE_HYPOTHESIS", "reason": "MC-E05 未录制", "microcase_id": "MC-E05"}]


# ── 2026-09-28 改钉（夹具的载体查找多一条回落 + 一条判据显式装探针技能）──────────────────
# 旧写法（留档，不许删）：
#     def _carrier(skill_id):
#         for pid in sorted(RS.pets):
#             if skill_id in (RS.candidate_moveset(pid) or ()):
#                 return pid
#         raise AssertionError(f"语料里找不到带 {skill_id} 的精灵，夹具失效")
#
# 凭什么改（实测，不是猜的）：本轮可玩层从旧 36 只换成纯抓包的 530 只（合并冻结 542；人类
# 2026-09-28 逐字「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。所有精灵实装」）。
# `skill_000250 迫近攻击` 在新层有 **11 只** FULL_VERIFIED 精灵学得到，但**没有任何一只**的
# 规范配招带它（旧层的载体 `pet_000392 兽花蕾` 当时是按需推算的 SIMULATABLE_UNVERIFIED，
# 推算配招里带迫近攻击；新层它进了冻结层，规范配招由抓包选择器重选为
# `skill_000321/000453/000361/000346`，不再带迫近攻击）。**技能没被撤下、载体也没被撤下**，
# 断的只是"默认配招正好带它"这条线索 ⇒ 回落顺序：
#   ① 先照旧找「规范配招里带它」的（数据回到那种形态时行为一字不变）；
#   ② 找不到再找「冻结学招表里学得到它」的 FULL_VERIFIED 精灵，并由**判据显式把它装上**
#      （`loadouts=`，与 `test_position_subsystem._run` 同一套做法 —— 引擎的纪律本来就是
#      「图鉴可学 ≠ 这场带得上」，合法动作按配招算）。
# 判据一条都没动：威力累计 90 → 135（`seen[1] == base_power + 45`）、能耗累计 -3、legacy 逐位
# 不变、能力位关掉回到原价 —— 全部逐字照旧，没有一处放宽。
def _learns(skill_id):
    for pid in sorted(RS.pets):
        if RS.build_support_of(pid) == rdata.SUPPORT_FULL_VERIFIED and RS.is_learnable(pid, skill_id):
            return pid
    return None


def _carrier(skill_id):
    for pid in sorted(RS.pets):
        if skill_id in (RS.candidate_moveset(pid) or ()):
            return pid
    fallback = _learns(skill_id)
    if fallback is not None:
        return fallback
    raise AssertionError(f"语料里找不到带 {skill_id} 的精灵，夹具失效")


def _loadout_with(carrier, skill_id):
    """把探针技能放进配招（其余三位取该精灵的规范配招，保证全部真在冻结学招表里）。"""
    base = list(RS.candidate_moveset(carrier) or ())
    return tuple([skill_id] + [s for s in base if s != skill_id][:3])


def _foe_attack():
    for sid in (RS.candidate_moveset("pet_000050") or ()):
        skill = RS.skills.get(sid)
        if skill is not None and skill.is_attack and not skill.is_defense and (skill.power or 0) > 0:
            return Action(kind=ACTION_SKILL, skill_id=sid)
    raise AssertionError("对手首发没有可用的普通攻击，夹具失效")


class PerUseRampParseTest(unittest.TestCase):
    def test_all_four_writings_are_read(self):
        want = {
            CANNON: ("cost", -1),
            HEAVY: ("cost", 1),
            CHARGE: ("power", 45),
            BLOW: ("power", 20),
        }
        for sid, (field, delta) in want.items():
            parsed = rparse.parse_skill(RS.skills[sid])
            self.assertIsNotNone(parsed.per_use_ramp, f"{sid} 应当读出「每次使用后」")
            self.assertEqual(parsed.per_use_ramp["field"], field)
            self.assertEqual(parsed.per_use_ramp["delta"], delta)
            self.assertIn("每次使用后", parsed.per_use_ramp["evidence"])

    def test_claim_follows_the_declared_capability(self):
        skill = RS.skills[CANNON]
        off = rparse.parse_skill(skill)
        self.assertNotIn("per_use_ramp", [e.kind for e in off.effects], "未声明时不许自己补效果")
        self.assertTrue(any("每" in s for s in rparse.unclaimed_mechanic_spans(skill, parsed=off)))
        on = rparse.resolve_per_use_ramp(skill, declared=True)
        self.assertIn("per_use_ramp", [e.kind for e in on.effects])
        self.assertEqual(rparse.unclaimed_mechanic_spans(skill, parsed=on), [])
        caps = rcov.declared_capabilities_of()
        self.assertEqual(rcov.classify_skill(skill)["support"], rcov.SUPPORT_PARTIAL)
        self.assertEqual(rcov.classify_skill(skill, per_use_ramp_declared=caps["per_use_ramp"])["support"],
                         rcov.SUPPORT_SIMULATABLE_UNVERIFIED)


class PerUseRampEngineTest(unittest.TestCase):
    def _state(self, config_id=V3, team_size=6):
        cfg = rc.get_rule_config(config_id)
        carrier = _carrier(CANNON)
        team = [carrier] + [p for p in RS.pets if p != carrier][:team_size - 1]
        foe = ["pet_000050"] + [p for p in RS.pets if p not in (carrier, "pet_000050")][:team_size - 1]
        kwargs = {"unverified_overrides": OVERRIDES} if cfg.has_mana or cfg.allowed_kinds else {}
        state = renv.reset(team, foe, seed=7, rs=RS, config=cfg, **kwargs)
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = 10
        return state, cfg

    def test_cost_ramp_accumulates_on_this_skill_only(self):
        """水炮连用三次 ⇒ 能耗 5 → 4 → 3，而且**同一只精灵的别的技能不受影响**。

        ⚠️ 夹具要点：把双方场上那只的生命调到很高，避免中途有人力竭进补位局面
        （第一版没做这件事，实测报「水炮 行动不合法」——载体被换下去之后它当然不合法）。
        这条判据要量的是**能耗累计**，不该被补位/力竭的支线干扰。
        """
        state, cfg = self._state()
        self.assertTrue(cfg.damage_per_use_ramp, "v3 必须声明这条能力")
        skill = RS.skills[CANNON]
        base = int(skill.energy)
        for index in range(3):
            for side_name in ("player", "enemy"):
                pet_field = getattr(state, side_name).field_pet
                pet_field.max_hp = 9999
                pet_field.hp = 9999
            # 能量给足：水炮 5 费、每用一次降 1，而能量上限是 10 —— 用完两次就只剩 1 点，
            # 第三次会**因为付不起**而不合法（第一版实测正是这么红的）。
            state.player.field_pet.energy = 30
            pet = state.player.field_pet
            self.assertEqual(renv.effective_skill_cost(pet, skill, cfg, weather=state.weather),
                             base - index, f"第 {index + 1} 次出手前应当是 {base - index}")
            state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CANNON),
                                    _foe_attack())
        pet = state.player.field_pet
        self.assertEqual(pet.skill_ramps[CANNON]["cost"], -3, "三次出手累计 -3")
        # 反证：同一只精灵的**别的**技能不受影响
        other = next(sid for sid in (RS.candidate_moveset(pet.pet_id) or ()) if sid != CANNON)
        self.assertEqual(renv.effective_skill_cost(pet, RS.skills[other], cfg, weather=state.weather),
                         int(RS.skills[other].energy), "只对本技能生效")

    def test_power_ramp_shows_up_in_the_damage_event(self):
        cfg = rc.get_rule_config(V3)
        carrier = _carrier(CHARGE)
        team = [carrier] + [p for p in RS.pets if p != carrier][:5]
        foe = ["pet_000050"] + [p for p in RS.pets if p not in (carrier, "pet_000050")][:5]
        # 2026-09-28：`_carrier(CHARGE)` 现在可能落到「冻结学招表里学得到、但规范配招没带它」的
        # 精灵上（见 `_carrier` 上方的改钉说明）⇒ 由判据自己把 `迫近攻击` 装进配招。
        # 判据量的仍然是「每次使用后本技能威力永久+45」：90 → 135，一个字没变。
        loadouts = None
        if CHARGE not in (RS.candidate_moveset(carrier) or ()):
            loadouts = {carrier: _loadout_with(carrier, CHARGE)}
        state = renv.reset(team, foe, seed=7, rs=RS, config=cfg, unverified_overrides=OVERRIDES,
                           loadouts=loadouts)
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = 10
        skill = RS.skills[CHARGE]
        base_power = int(skill.power)
        seen = []
        for _ in range(2):
            state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CHARGE), _foe_attack())
            dmg = [e for e in state.events if e.kind == "damage" and e.detail.get("skill_id") == CHARGE][-1]
            seen.append(dmg.detail["power_used"])
        self.assertEqual(seen[0], base_power, "第一次出手用原威力")
        self.assertEqual(seen[1], base_power + 45, "第二次出手 +45")

    def test_legacy_is_bit_identical(self):
        state, cfg = self._state(LEGACY, team_size=3)
        self.assertFalse(cfg.damage_per_use_ramp, "legacy 不该凭空多出这条能力")
        skill = RS.skills[CANNON]
        pet = state.player.field_pet
        state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CANNON), _foe_attack())
        self.assertEqual(renv.effective_skill_cost(pet, skill, cfg, weather=state.weather), int(skill.energy))
        self.assertFalse(getattr(pet, "skill_ramps", None), "legacy 里连这个字段都不该被写")
        self.assertNotIn("skill_ramps", pet.to_dict(), "序列化里也不许出现（golden 指纹）")

    def test_reverse_proof_switching_the_capability_off(self):
        from unittest import mock
        state, cfg = self._state()
        skill = RS.skills[CANNON]
        state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CANNON), _foe_attack())
        pet = state.player.field_pet
        self.assertEqual(renv.effective_skill_cost(pet, skill, cfg, weather=state.weather),
                         int(skill.energy) - 1, "对照组：声明了就是减 1")
        flipped = dataclasses.replace(cfg, damage_per_use_ramp=False)
        with mock.patch.object(renv._rule_config, "get_rule_config", lambda *a, **k: flipped):
            self.assertEqual(renv.effective_skill_cost(pet, skill, None, weather=state.weather),
                             int(skill.energy), "能力位关掉就不许再减")


if __name__ == "__main__":
    unittest.main()
