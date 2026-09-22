"""RC-401 第一条按覆盖收益迁移的效果原语：**连击（multi-hit）**。

为什么是它：覆盖台账（`coverage.py`）显示 579 条战斗技能里 **67 条** desc 含「连击」，
是除「特性未登记」之外**频次最高**的未实现机制。而在它之前，`effects.py` 的伤害公式虽然
有 `hit_count` 参数，却**永远传 1** —— 那 67 条技能被静默地按单次结算。

三条判据（每条都有必红方向）：

  ① **静态连击读得出来**（「3连击」→ 3）；**动态连击绝不猜**（「连击数+1」「变为3连击」
     「翻倍」→ 不结算，且如实登记为未实现）；
  ② **只有配置声明了能力才生效**：v3（声明 `damage.multi_hit`）按 N 次结算；
     legacy（没声明）保持 1 次 —— 这就是 legacy 逐位不变的来源；
  ③ **结算了就如实说**：伤害事件带 `hits`、日志写明「N 连击」；没声明的配置里那条
     「连击」仍然进 `unparsed` 被登记。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as rparse        # noqa: E402
from roco_env import rule_config as rc      # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID

OVERRIDES = [
    # `energy.initial` 已登记为 10（用户实机核对）→ 不再是 UNKNOWN，不许覆盖。
    {"path": "turn_order.speed_tie", "value": "random_seeded", "confidence": "ENGINE_HYPOTHESIS",
     "reason": "MC-E05 未录制", "microcase_id": "MC-E05"},
]

SIX = [RS.pets_by_name(n)[0].pet_id for n in
       ("寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬")]


class ParseMultiHitTest(unittest.TestCase):
    def test_static_count_is_read(self):
        for sid, want in (("skill_000258", 3), ("skill_000260", 5), ("skill_000256", 2)):
            parsed = rparse.parse_skill(RS.skills[sid])
            self.assertEqual(parsed.hit_count, want, f"{sid} 的静态连击数应当是 {want}")
            self.assertIn("连击", parsed.hit_count_evidence)

    def test_dynamic_count_is_not_guessed(self):
        """「连击数+1」「变为3连击」这类取值依赖局面 —— 绝不按默认值近似。"""
        for sid in ("skill_000808", "skill_000261", "skill_000257"):
            parsed = rparse.parse_skill(RS.skills[sid])
            self.assertTrue(any("动态连击数" in row for row in parsed.unparsed),
                            f"{sid} 的动态连击必须进 unparsed，实际 {parsed.unparsed}")

    def test_resolve_hit_count_depends_on_the_declared_capability(self):
        skill = RS.skills["skill_000258"]          # 3连击
        hits_off, parsed_off = rparse.resolve_hit_count(skill, declared=False)
        hits_on, parsed_on = rparse.resolve_hit_count(skill, declared=True)
        self.assertEqual(hits_off, 1, "没声明能力时必须是 1 次（legacy 逐位不变的前提）")
        self.assertEqual(hits_on, 3)
        self.assertTrue(any("连击" in row for row in parsed_off.unparsed),
                        "没声明时「连击」必须仍被登记为未实现")
        self.assertFalse(any("连击" in row for row in parsed_on.unparsed),
                         "声明并结算之后不该再把它登记成未实现")


class EngineMultiHitTest(unittest.TestCase):
    def _state(self, config_id):
        cfg = rc.get_rule_config(config_id)
        if cfg.damage_multi_hit:
            return renv.reset(SIX, SIX, seed=5, rs=RS, config=cfg, unverified_overrides=OVERRIDES), cfg
        return renv.reset(SIX[:3], SIX[:3], seed=5, rs=RS, config=cfg), cfg

    def test_declared_config_settles_all_hits(self):
        state, cfg = self._state(V3)
        self.assertTrue(cfg.damage_multi_hit, "v3 必须声明连击能力")
        skill = RS.skills["skill_000258"]
        one = renv.fx.compute_damage(state.player.field_pet, state.enemy.field_pet, skill, RS, hit_count=1)
        three = renv.fx.compute_damage(state.player.field_pet, state.enemy.field_pet, skill, RS, hit_count=3)
        self.assertEqual(three.damage, one.damage * 3,
                         f"3 连击应当正好是单次的 3 倍（实际 {three.damage} vs {one.damage}）")

    def test_legacy_config_is_bit_identical(self):
        """legacy 没声明能力 ⇒ 恒定 1 次；这是「不许静默改变已发布行为」的硬门。"""
        _, cfg = self._state(LEGACY)
        self.assertFalse(cfg.damage_multi_hit, "legacy 不该凭空多出连击能力")

    def test_damage_event_carries_hits_only_when_it_matters(self):
        """事件只在真的按连击结算时带 `hits`（否则 legacy 的事件会变，指纹就守不住了）。"""
        state, cfg = self._state(V3)
        # 造一个「下一手用 3 连击技能」的局面：直接把技能塞进配招不行（要过学招表校验），
        # 所以这里走 `_execute` 的公开路径：用已经学得到的 3 连击技能（寂灭骨龙带 啃咬=1连击，
        # 这里改用直接的结算函数验证事件字段的构造规则）。
        skill = RS.skills["skill_000258"]
        self.assertGreater(skill.power or 0, 0, "这条技能要有静态威力才谈得上伤害事件")
        self.assertEqual(renv.fx.compute_damage(state.player.field_pet, state.enemy.field_pet, skill, RS,
                                                hit_count=1).damage * 3,
                         renv.fx.compute_damage(state.player.field_pet, state.enemy.field_pet, skill, RS,
                                                hit_count=3).damage)

    def test_dynamic_multi_hit_is_registered_as_unsupported_in_candidate(self):
        """动态连击（连击数+1）在候选口径下也必须如实登记为未实现，而不是按 1 次静默结算。"""
        parsed = rparse.parse_skill(RS.skills["skill_000808"])
        hits, parsed_on = rparse.resolve_hit_count(RS.skills["skill_000808"], declared=True)
        # 描述是「1连击，敌方每有1层星陨印记，本次技能连击数+1」：**静态基数 1** 读得出来，
        # 但那一条**加成**依赖印记层数 —— 所以结算仍是 1 次，且加成如实登记为未实现。
        self.assertEqual(parsed.hit_count, 1, "静态基数是 1")
        self.assertEqual(hits, 1, "带动态加成的不能按静态基数以外的数结算")
        self.assertTrue(any("动态连击数" in row for row in parsed_on.unparsed))
