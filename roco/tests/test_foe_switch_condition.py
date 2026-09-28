"""RC-401 批次十一：**「若敌方本回合更换精灵，<效果>」**（12 条技能 / **46 只**精灵带得上）。

为什么是它：修完尺子后的可达性工作单里，「若敌方本回合更换精灵」是**最大的一条**（46 只）。
条件本身在结算时是**已知事实**（对手这一手提交的就是换人 ⇒ `Action.kind == 'switch'`），
所以不需要猜先后手、也不需要模拟 —— 与批次八（先手条件）同一套做法。

判据（每条都有必红方向）：

  ① **读得出 + 认得领**：条件后面那几种有把握的写法（威力平加 / 威力翻倍 / 自己回能 /
     敌方失能 / 属性增减）逐条读出来；**读不出的残余一律不认领**（`草虫冲击` 的「无视敌方系别抵抗」、
     `嘲弄` 的平值「速度+70」）；
  ② **条件成立才算**：对手换人 ⇒ 加成/回能真的生效；对手攻击或聚能 ⇒ **不算**，并如实记
     `foe_switch_condition_skipped`（这不是"未实现"，是"这一回合没满足"）；
  ③ **legacy 逐位不变**：没声明能力的配置里，同一个局面威力、能量与事件一个字节都不变；
  ④ **反证**：把能力位换成 False（连取配置那一步一起换掉）⇒ 加成消失。
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
from roco_env.schema import Action, ACTION_CHARGE, ACTION_SKILL, ACTION_SWITCH   # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
CLUB = "skill_000316"        # 当头棒喝：本次技能威力+100
SPIN = "skill_000685"        # 回旋踢：本次技能威力翻倍
NEEDLE = "skill_000374"      # 针刺射击：自己回复7点能量
RECYCLE = "skill_000763"     # 回收：敌方失去4能量
ROCK = "skill_000528"        # 砂石冲撞：自己获得物防+100%
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
# `skill_000374 针刺射击` 在新层有 **20 只** FULL_VERIFIED 精灵学得到，但**没有任何一只**的
# 规范配招带它（旧层的载体 `pet_000008 草头鸭` 当时是按需推算的 SIMULATABLE_UNVERIFIED，
# 推算配招里带针刺射击；新层它进了冻结层，规范配招由抓包选择器重选为
# `skill_000678/000286/000362/000683`，不再带针刺射击）。**技能没被撤下、载体也没被撤下**，
# 断的只是"默认配招正好带它"这条线索 ⇒ 回落顺序：
#   ① 先照旧找「规范配招里带它」的（数据回到那种形态时行为一字不变）；
#   ② 找不到再找「冻结学招表里学得到它」的 FULL_VERIFIED 精灵，并由**判据显式把它装上**
#      （`loadouts=`，与 `test_position_subsystem._run` 同一套做法 —— 引擎的纪律本来就是
#      「图鉴可学 ≠ 这场带得上」，合法动作按配招算）。
# 判据一条都没动：对手换人 ⇒ 回 7 点能量 / 威力 +100 / 威力翻倍；对手攻击或聚能 ⇒ 不加成
# 且如实记 `foe_switch_condition_skipped`；legacy 逐位不变；能力位关掉加成消失 —— 全部逐字
# 照旧，没有一处放宽。
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


class FoeSwitchParseTest(unittest.TestCase):
    def test_conditional_effects_are_read(self):
        want = {
            CLUB: [("foe_switch_power_flat", {"amount": 100})],
            SPIN: [("foe_switch_power_mult", {"multiplier": 2})],
            NEEDLE: [("self_energy", {"amount": 7})],
            RECYCLE: [("foe_energy_loss", {"amount": 4})],
            ROCK: [("self_stat", {"stat": "def", "delta_pct": 100})],
        }
        for sid, expect in want.items():
            parsed = rparse.parse_skill(RS.skills[sid])
            got = [(e.kind, dict(e.value)) for e in parsed.foe_switch_effects]
            self.assertEqual(got, expect, f"{sid} {RS.skills[sid].name} 的条件效果读错了")
            self.assertEqual(parsed.foe_switch_leftover, "", f"{sid} 不该有残余")

    def test_residual_text_blocks_the_claim(self):
        """反证：条件后面还有读不出来的东西 ⇒ **不许认领**（宁可这一条不结算）。"""
        for sid, marker in ((  "skill_000656", "无视敌方系别抵抗"), ("skill_000755", "速度+70")):
            skill = RS.skills[sid]
            parsed = rparse.parse_skill(skill)
            self.assertIn(marker, parsed.foe_switch_leftover, f"{sid} 的残余额应当{marker}")
            resolved = rparse.resolve_foe_switch_condition(skill, declared=True, parsed=parsed)
            self.assertFalse(any(getattr(e.value, "get", lambda *_: None)("requires") == "foe_switch"
                                 for e in resolved.effects if isinstance(e.value, dict)),
                             f"{sid} 读不全就一个条件效果都不许补")
            spans = rparse.unclaimed_mechanic_spans(skill, parsed=resolved)
            self.assertTrue(any("更换精灵" in s or "若" in s for s in spans),
                            f"{sid} 未认领片段必须留着，实际 {spans}")

    def test_declared_capability_claims_the_clause(self):
        skill = RS.skills[CLUB]
        off = rparse.unclaimed_mechanic_spans(skill, parsed=rparse.parse_skill(skill))
        self.assertTrue(any("若" in s for s in off), f"未声明时必须仍未认领，实际 {off}")
        on = rparse.resolve_foe_switch_condition(skill, declared=True)
        self.assertEqual(rparse.unclaimed_mechanic_spans(skill, parsed=on), [])
        # 档位跟着能力走：没声明 PARTIAL、声明了可模拟
        caps = rcov.declared_capabilities_of()
        self.assertEqual(rcov.classify_skill(skill)["support"], rcov.SUPPORT_PARTIAL)
        self.assertEqual(rcov.classify_skill(skill, foe_switch_condition_declared=caps["foe_switch_condition"])["support"],
                         rcov.SUPPORT_SIMULATABLE_UNVERIFIED)


class FoeSwitchEngineTest(unittest.TestCase):
    def _state(self, skill_id, config_id=V3, team_size=6):
        cfg = rc.get_rule_config(config_id)
        carrier = _carrier(skill_id)
        team = [carrier] + [p for p in RS.pets if p != carrier][:team_size - 1]
        foe = ["pet_000050"] + [p for p in RS.pets if p not in (carrier, "pet_000050")][:team_size - 1]
        kwargs = {"unverified_overrides": OVERRIDES} if cfg.has_mana or cfg.allowed_kinds else {}
        # 2026-09-28：`_carrier(skill_id)` 现在可能落到「冻结学招表里学得到、但规范配招没带它」
        # 的精灵上（见 `_carrier` 上方的改钉说明）⇒ 由判据自己把探针技能装进配招。
        # 规范配招本来就带它的那几条（`当头棒喝` / `回旋踢`）走的还是旧路径，一个字节没变。
        loadouts = None
        if skill_id not in (RS.candidate_moveset(carrier) or ()):
            loadouts = {carrier: _loadout_with(carrier, skill_id)}
        state = renv.reset(team, foe, seed=7, rs=RS, config=cfg, loadouts=loadouts, **kwargs)
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = 10
        return state, cfg

    #: 对手首发（`_state` 里固定用它）。
    FOE_LEAD = "pet_000050"

    def _foe_attack(self):
        """对手**首发那只**的普通攻击：从配招里挑，不依赖某一刻的局面。

        ⚠️ 第一版是"从当前局面的合法动作里挑"，结果第一次 `step_joint`（对手换人）之后
        局面里那只已经不是首发了，挑出来的技能在**新开的一局**里不合法（实测报
        「坟场搏击 不合法」）。夹具要按**配招**挑，不按局面挑。
        """
        for sid in (RS.candidate_moveset(self.FOE_LEAD) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and skill.is_attack and not skill.is_defense and (skill.power or 0) > 0:
                return Action(kind=ACTION_SKILL, skill_id=sid)
        raise AssertionError("对手首发没有可用的普通攻击，夹具失效")

    def _events(self, state, kind):
        return [e for e in state.events if e.kind == kind]

    def test_power_bonus_applies_only_when_the_foe_switches(self):
        state, cfg = self._state(CLUB)
        self.assertTrue(cfg.damage_foe_switch_condition, "v3 必须声明这条能力")
        switched = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CLUB),
                                   Action(kind=ACTION_SWITCH, target_index=1))
        dmg = [e for e in switched.events if e.kind == "damage" and e.detail.get("skill_id") == CLUB][-1]
        self.assertEqual(dmg.detail["power_used"], 180, "80 + 100 = 180")
        applied = self._events(switched, "foe_switch_power_applied")
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0].detail["amount"], 100)
        # 反证：对手换成攻击 / 聚能 ⇒ 不加成，并且**如实记 skipped**
        for foe_action in (self._foe_attack(), Action(kind=ACTION_CHARGE)):
            state2, _ = self._state(CLUB)
            other = renv.step_joint(state2, RS, Action(kind=ACTION_SKILL, skill_id=CLUB), foe_action)
            dmg2 = [e for e in other.events if e.kind == "damage" and e.detail.get("skill_id") == CLUB][-1]
            self.assertEqual(dmg2.detail["power_used"], 80, f"对手没换人就不许加成（{foe_action.kind}）")
            self.assertEqual(len(self._events(other, "foe_switch_power_applied")), 0)
            skipped = self._events(other, "foe_switch_condition_skipped")
            self.assertEqual(len(skipped), 1)
            self.assertIn("没有更换精灵", skipped[0].detail["reason"])

    def test_power_multiplier_doubles_only_on_switch(self):
        state, _ = self._state(SPIN)
        switched = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=SPIN),
                                   Action(kind=ACTION_SWITCH, target_index=1))
        dmg = [e for e in switched.events if e.kind == "damage" and e.detail.get("skill_id") == SPIN][-1]
        self.assertEqual(dmg.detail["power_used"], 160, "80 × 2 = 160")

    def test_energy_effect_applies_only_on_switch(self):
        """`针刺射击`：「若敌方本回合更换精灵，自己回复7点能量」——只在对手换人时结算。

        ⚠️ 能量要**先留出空间**再量：v3 的开局能量就是上限（10），满能量时 +7 会被上限吃掉，
        余额一点不变（第一版就是这么写的，实测假红）。这里把能量压到 5：出手付 3 ⇒ 2，
        条件成立再 +7 ⇒ 9。
        """
        skill = RS.skills[NEEDLE]
        cost = int(skill.energy)
        state, _ = self._state(NEEDLE)
        state.player.field_pet.energy = 5
        state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=NEEDLE),
                                Action(kind=ACTION_SWITCH, target_index=1))
        self.assertEqual(state.player.field_pet.energy, 5 - cost + 7,
                         "对手换人 ⇒ 那 7 点能量必须到账")
        state2, _ = self._state(NEEDLE)
        state2.player.field_pet.energy = 5
        state2 = renv.step_joint(state2, RS, Action(kind=ACTION_SKILL, skill_id=NEEDLE),
                                 self._foe_attack())
        self.assertEqual(len(self._events(state2, "foe_switch_condition_skipped")), 1)
        self.assertEqual(state2.player.field_pet.energy, 5 - cost,
                         "对手没换人 ⇒ 一点都不许多给")

    def test_legacy_is_bit_identical(self):
        state, cfg = self._state(CLUB, config_id=LEGACY, team_size=3)
        self.assertFalse(cfg.damage_foe_switch_condition, "legacy 不该凭空多出这条能力")
        state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CLUB),
                                Action(kind=ACTION_SWITCH, target_index=1))
        dmg = [e for e in state.events if e.kind == "damage" and e.detail.get("skill_id") == CLUB][-1]
        self.assertEqual(dmg.detail["power_used"], 80)
        self.assertEqual([e for e in state.events if e.kind.startswith("foe_switch")], [])

    def test_reverse_proof_switching_the_capability_off(self):
        from unittest import mock
        state, cfg = self._state(CLUB)
        flipped = dataclasses.replace(cfg, damage_foe_switch_condition=False)
        with mock.patch.object(renv._rule_config, "get_rule_config", lambda *a, **k: flipped):
            state2 = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=CLUB),
                                     Action(kind=ACTION_SWITCH, target_index=1))
        dmg = [e for e in state2.events if e.kind == "damage" and e.detail.get("skill_id") == CLUB][-1]
        self.assertEqual(dmg.detail["power_used"], 80, "能力位关掉就不许加成")


if __name__ == "__main__":
    unittest.main()
