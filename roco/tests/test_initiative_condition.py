"""RC-401 批次八：**先手条件**（「若先于敌方攻击，本次技能威力+N%」）。

为什么是它（可达性秤砣给的顺序）：`reports/roco/rc401/effect-coverage.json` 的
`reachability.top_blocked_by_reach` 里，**一条技能卡住 47 只精灵**排在最前 —— 就是
`skill_000687 扇风`（翼系，威力 75，描述「造成物伤，**若先于敌方攻击，本次技能威力+50%**。」）。
在此之前它被解析器读成"什么都没有"，引擎既不结算、台账也只说得出「未识别机制」。

判据（每条都有必红方向）：

  ① **结构读得出来、但没声明能力时一段都不许认领**：`若先于敌方攻击` 在未声明口径下
     仍然出现在 `unclaimed_mechanic_spans()` 里（引擎照旧把它写进 `state.unsupported`）；
     声明了才由 `resolve_initiative_condition()` 补一条 `initiative_power` 效果
     —— 它的 `evidence` 正好盖住那段文本，于是"已认领"是**同一把尺子**算出来的；
  ② **条件成立与否按事实判**：只有「我这一手排在敌方那一手之前」**且**「敌方那一手是攻击」
     才加成；敌方换人 / 聚能 / 拿不到动作时**不加成**（描述写的是"先于敌方**攻击**"）；
  ③ **legacy 逐位不变**：没声明能力的配置里，同一个局面 `power_used` 一个字节都不变；
  ④ **顺手修掉一条真 bug**：`疾风刺`（`skill_000689`：「造成物伤，1连击，若先于敌方攻击，
     **改为3连击**。」）原来被读成**恒定 3 连击** —— 只要用它就白拿三倍伤害，而条件根本没实现。
     现在「改为N连击」算动态（不结算、如实登记），静态基数回到 1。
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
FAN = "skill_000687"          # 扇风
GUST = "skill_000689"         # 疾风刺
OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
              "confidence": "ENGINE_HYPOTHESIS", "reason": "MC-E05 未录制", "microcase_id": "MC-E05"}]

#: 学得到「扇风」而且**速度最快**的载体（实测 spe=135；对手取最慢的一只 spe=26）
#: —— 选这一对是为了让「谁先动」**确定性**地由速度决定，不靠运气。
CARRIER = "pet_000228"          # 魔眷鸟
SLOW_FOE = "pet_000050"         # 一窝蜂（spe=26，配招里有攻击技能）
#: 会「应对攻击」的防御技能（应对成功 ⇒ **必定先手**，用来造"敌方先动"的局面）。
RESPOND_GUARD = "skill_000286"


class InitiativeParseTest(unittest.TestCase):
    def test_structure_is_read_but_not_claimed_until_declared(self):
        skill = RS.skills[FAN]
        parsed = rparse.parse_skill(skill)
        self.assertEqual(parsed.initiative_power, {"pct": 50,
                                                   "evidence": "若先于敌方攻击，本次技能威力+50%"})
        self.assertEqual([e.kind for e in parsed.effects], [], "没声明能力时不许自己补效果")
        spans_off = rparse.unclaimed_mechanic_spans(skill, parsed=parsed)
        self.assertTrue(any("若先于敌方攻击" in s for s in spans_off),
                        f"未声明口径下那段文本必须是**未认领**的，实际 {spans_off}")
        resolved = rparse.resolve_initiative_condition(skill, declared=True, parsed=parsed)
        spans_on = rparse.unclaimed_mechanic_spans(skill, parsed=resolved)
        self.assertIn("initiative_power", [e.kind for e in resolved.effects])
        self.assertFalse(any("若先于敌方攻击" in s for s in spans_on),
                         f"声明并结算之后不许再登记成未认领，实际 {spans_on}")

    def test_legacy_never_gets_the_effect(self):
        parsed = rparse.resolve_initiative_condition(RS.skills[FAN], declared=False)
        self.assertEqual([e.kind for e in parsed.effects], [])

    def test_conditional_combo_is_dynamic_not_static(self):
        """反证：把「改为3连击」当静态值 ⇒ 这一手白拿三倍伤害（修前实测就是 3）。"""
        parsed = rparse.parse_skill(RS.skills[GUST])
        self.assertEqual(parsed.hit_count, 1, "静态基数只有「1连击」；「改为3连击」是条件化改写")
        self.assertTrue(any("动态连击数" in row for row in parsed.unparsed))
        hits, resolved = rparse.resolve_hit_count(RS.skills[GUST], declared=True)
        self.assertEqual(hits, 1)
        self.assertTrue(any("动态连击数" in row for row in resolved.unparsed))
        level = rcov.classify_skill(RS.skills[GUST], multi_hit_declared=True)["support"]
        self.assertNotEqual(level, rcov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "有未结算的条件化改写 ⇒ 不许再被算成可模拟（修前是 SIMULATABLE）")
        # 实档案位是 `PARTIAL`（2026-09-25 第 39 轮改钉）：基础伤害与「1连击」照常结算，
        # 没结算的是「若先于敌方攻击，改为3连击」那一段 —— 那是"一部分结算了"。
        # （旧口径是 `KNOWLEDGE_ONLY`，因为分类器当时不看未认领机制片段。）
        self.assertEqual(level, rcov.SUPPORT_PARTIAL)


# ── 2026-09-28 改钉（夹具补一条**显式配招**；判据与断言一条都没动，也没有放宽）──────────
# 改了哪里：`_state()` 现在把 `loadouts={CARRIER: tuple([FAN] + 规范配招里其余三个)}` 传给
# `reset()`。旧写法（留档，不许删）是**不传** `loadouts`，靠 `reset()` 的默认值 ——
# 省略时用 `Ruleset.candidate_moveset`（M1 选定的规范配招）。
#
# 凭什么改（事实，不是猜的）：
#   · 引擎侧的行为**没错**，也没变：`legal_actions()` 明确「按**配招**枚举，不是整个学习表
#     （图鉴可学 ≠ 这场带得上）」（`env.py` 那段注释），`reset()` 的 docstring 同样写着省略
#     loadouts 时才回落到规范配招。所以"这一手合不合法"取决于配招，这是设计，不是缺陷。
#   · 变的是数据：本轮可玩层从旧 36 只换成纯抓包的 530 只（人类 2026-09-28 逐字「就用现在
#     抓包得到的数据吧，别的不找不要了，问题数据也不要了。所有精灵实装」）。`CARRIER`
#     `pet_000228 魔眷鸟` 旧层里**没有**它（它是按需推算的 SIMULATABLE_UNVERIFIED，推算出来的
#     配招里带「扇风」）；新层里它是 **FULL_VERIFIED**，规范配招由抓包选择器重选为
#     `skill_000686 / skill_000286 / skill_000717 / skill_000298` —— **不含扇风**（实测），
#     于是 `step_joint(..., skill_id=FAN, ...)` 报「player 的行动不合法：扇风」。
#   · 「扇风」本身没被撤下：`skill_000687` 在新层有 **57 只** FULL_VERIFIED 精灵学得到，
#     `魔眷鸟` 自己就学得到（`native_skills` 里，冻结学招表）。撤下的是"默认配招正好带它"
#     这个巧合 ⇒ 把它**显式装上**即可，判据量的仍然是「若先于敌方攻击，本次技能威力+50%」，
#     一字未变：威力 112 = 75×1.5、非攻击不加成、legacy 逐位不变、能力位关掉回到 75。
#   · 顺带把注释里那条事实钉住：`CARRIER=魔眷鸟 spe=135`、`SLOW_FOE=一窝蜂 spe=26` 在新层
#     **逐值不变**（实测），所以"谁先动由速度确定性决定"这条夹具前提照旧成立，没有换载体。
def _loadout_with(carrier: str, skill_id: str) -> tuple:
    """把探针技能放进配招（其余三位取该精灵的规范配招，保证全部真在冻结学招表里）。"""
    base = list(RS.candidate_moveset(carrier) or ())
    return tuple([skill_id] + [s for s in base if s != skill_id][:3])


class InitiativeEngineTest(unittest.TestCase):
    def _state(self, config_id, team_size=6, config=None):
        cfg = config if config is not None else rc.get_rule_config(config_id)
        team = [CARRIER] + [p for p in RS.pets if p != CARRIER][:team_size - 1]
        foe = [SLOW_FOE] + [p for p in RS.pets if p not in (CARRIER, SLOW_FOE)][:team_size - 1]
        kwargs = {"unverified_overrides": OVERRIDES} if cfg.has_mana or cfg.allowed_kinds else {}
        state = renv.reset(team, foe, seed=7, rs=RS, config=cfg,
                           loadouts={CARRIER: _loadout_with(CARRIER, FAN)}, **kwargs)
        # 把能量补足：legacy 的开局能量比 v3 少，扇风（3 能耗）在 legacy 里可能不是合法动作
        # —— 这条判据要量的是**先手条件**，不该被"付不起"挡住。
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = max(pet.energy, 10)
        return state, cfg

    def _foe_attack(self):
        """对手那一手用**普通攻击**（不带应对，避免"应对成功必定先手"把顺序翻过来）。"""
        for sid in (RS.candidate_moveset(SLOW_FOE) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and skill.is_attack and (skill.power or 0) > 0 and not skill.is_defense:
                return sid
        raise AssertionError("对手没有可用的普通攻击技能，夹具失效")

    def _damage_event(self, state, skill_id=FAN):
        for event in reversed(state.events):
            if event.kind == "damage" and event.detail.get("skill_id") == skill_id:
                return event.detail
        return None

    def test_declared_config_applies_power_bonus_when_acting_first(self):
        state, cfg = self._state(V3)
        self.assertTrue(cfg.damage_initiative_condition, "v3 必须声明先手条件能力")
        state = self._step(state, foe_skill=self._foe_attack())
        damage = self._damage_event(state)
        self.assertIsNotNone(damage, "这一步应当产生伤害事件")
        self.assertEqual(damage["power_used"], 112, "75 × 1.5 = 112（取整）")
        applied = [e for e in state.events if e.kind == "initiative_condition_applied"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0].detail["power_pct"], 50)

    def test_non_attack_from_the_foe_does_not_count(self):
        """反证：敌方这一手不是攻击（聚能）⇒ 描述说的是"先于敌方**攻击**"，不许加成。"""
        state, _ = self._state(V3)
        state = renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=FAN),
                                Action(kind=ACTION_CHARGE))
        damage = self._damage_event(state)
        self.assertIsNotNone(damage)
        self.assertEqual(damage["power_used"], 75)
        skipped = [e for e in state.events if e.kind == "initiative_condition_skipped"]
        self.assertEqual(len(skipped), 1)
        self.assertIn("不是攻击", skipped[0].detail["reason"])

    def test_legacy_is_bit_identical(self):
        """legacy 没声明能力 ⇒ 同一个局面威力与事件都不变（`power_used` 仍是 75）。"""
        state, cfg = self._state(LEGACY, team_size=3)
        self.assertFalse(cfg.damage_initiative_condition, "legacy 不该凭空多出先手条件能力")
        damage = self._damage_event(self._step(state, foe_skill=self._foe_attack()))
        self.assertIsNotNone(damage)
        self.assertEqual(damage["power_used"], 75)
        self.assertEqual([e for e in state.events if e.kind.startswith("initiative_condition")], [])

    def test_reverse_proof_switching_the_flag_off_removes_the_bonus(self):
        """反证：把能力位在内存里改成 False 再开一局 ⇒ 同一局面必须回到 75。

        证明「加成来自这条能力位」，而不是别的什么顺手把它加上了。
        """
        state, cfg = self._state(V3)
        foe_skill = self._foe_attack()
        self.assertEqual(self._damage_event(self._step(state, foe_skill=foe_skill))["power_used"], 112,
                         "对照组：声明了就是 112")
        flipped = dataclasses.replace(cfg, damage_initiative_condition=False)
        state2, _ = self._state(V3, config=flipped)
        # ⚠ 引擎在结算时是**按 `state.ruleset_config_id` 重新取配置**的（这是"配置是唯一事实源"
        # 的代价），所以内存里换一个 config 对象不生效 —— 反证必须把取配置这一步也一起换掉。
        from unittest import mock
        with mock.patch.object(renv._rule_config, "get_rule_config", lambda *a, **k: flipped):
            damage = self._damage_event(self._step(state2, foe_skill=foe_skill))
        self.assertEqual(damage["power_used"], 75, "能力位关掉就不许再加成")

    def _step(self, state, foe_skill="skill_000286"):
        for side in (state.player, state.enemy):
            for pet in side.pets:
                pet.energy = max(pet.energy, 10)
        return renv.step_joint(state, RS, Action(kind=ACTION_SKILL, skill_id=FAN),
                               Action(kind=ACTION_SKILL, skill_id=foe_skill))


if __name__ == "__main__":
    unittest.main()
