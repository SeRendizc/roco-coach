"""RC-401 批次二：**特性层的工作清单** + 两条条件可判的入场特性。

为什么要清单：RC-403 显示 609 只精灵卡在特性那一件上，而特性有 245 条 —— 不能一起上。
所以先按**覆盖收益**排序（实现它能让多少只精灵变成「全可模拟」），再挑「触发钩子已知 +
描述能被完整读出」的那批动手。判据（每条都有必红方向）：

  ① 清单覆盖全部 245 条特性（按 `skill_id` 索引——按名字索引会把同名特性合并掉，实测 245→242）；
  ② `ready` 必须**同时**满足「触发钩子已知」与「描述全解析」；
  ③ 触发词只认闭集里那几个（映射到引擎真的有的钩子），识别不到就是 `trigger_unknown`
     —— 猜触发时点比不结算更糟；
  ④ 入库的那两条条件特性：**声明了魔力的配置里才结算**（legacy 里 `mana` 是 None，
     条件不可判 ⇒ 不结算，行为逐位不变）。
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as cov     # noqa: E402
from roco_env import data as rdata       # noqa: E402
from roco_env import env as renv         # noqa: E402
from roco_env import traits as tr        # noqa: E402

RS = rdata.load_ruleset()


class TraitWorklistTest(unittest.TestCase):
    def setUp(self):
        self.worklist = cov.build_trait_worklist(RS)
        self.rows = {row["skill_id"]: row for row in self.worklist["worklist"]}

    def test_covers_every_trait_by_skill_id(self):
        trait_ids = {t.skill_id for t in RS.skills.values() if t.is_trait}
        self.assertEqual(len(trait_ids), 245)
        self.assertEqual(set(self.rows), trait_ids, "清单必须按 skill_id 覆盖全部特性")

    def test_ready_requires_both_trigger_and_effect(self):
        for row in self.rows.values():
            if row["readiness"] == "ready":
                self.assertTrue(row["trigger_known"], row)
                self.assertTrue(row["effect_clean"], row)
            if row["readiness"] == "effect_unparsed":
                self.assertTrue(row["trigger_known"], row)
                self.assertFalse(row["effect_clean"], row)
            if row["readiness"] == "trigger_unknown":
                self.assertFalse(row["trigger_known"], row)

    def test_trigger_vocabulary_only_maps_to_real_hooks(self):
        hooks = set(self.worklist["trigger_vocabulary"].values())
        source = open(tr.__file__, "r", encoding="utf-8").read()
        for hook in hooks:
            self.assertIn(f"def {hook}(", source, f"触发词映射到了引擎里不存在的钩子 {hook}")
        # 反证：一句没有闭集触发词的描述必须落到 trigger_unknown（不许猜）
        self.assertFalse(cov.trigger_hook_of("每受到1次攻击伤害，自己回复5%生命")["known"])
        self.assertTrue(cov.trigger_hook_of("入场时，自己获得双攻+10%。")["known"])

    def test_ranking_is_by_coverage_benefit(self):
        blocked = [row["pets_blocked"] for row in self.worklist["worklist"]]
        self.assertEqual(blocked, sorted(blocked, reverse=True),
                         "清单必须按「能解锁多少只精灵」降序——它是排序依据，不是印象")
        self.assertGreater(self.worklist["pets_blocked_by_traits"], 0,
                           "至少要真有精灵卡在特性上，否则这份清单没有意义")


class ManaConditionedTraitsTest(unittest.TestCase):
    """入库的两条：条件 = 魔力值是否为 1。"""

    def _trait_pet(self, skill_id):
        return next(p.pet_id for p in RS.pets.values() if p.feature_skill_id == skill_id)

    def _state(self, pet_id, *, mana):
        others = [p.pet_id for p in list(RS.pets.values()) if p.pet_id != pet_id][:2]
        state = renv.reset([pet_id, *others], [pet_id, *others], seed=7, rs=RS)
        state.player.mana = mana
        state.enemy.mana = None if mana is None else 2
        return state

    def test_图书守卫者_fires_only_when_mana_is_one(self):
        pet_id = self._trait_pet("skill_000142")
        state = self._state(pet_id, mana=1)
        events = []
        tr.on_enter(RS, state, "player", events)
        self.assertEqual(state.player.field_pet.buffs.get("atk"), 100)
        self.assertEqual(state.player.field_pet.buffs.get("spa"), 100)
        self.assertTrue(any(e.get("trait") == "图书守卫者" for e in events), events)

    def test_legacy_has_no_mana_so_the_condition_cannot_be_judged(self):
        """legacy：`mana` 是 None ⇒ 条件不可判 ⇒ **不结算**（这是逐位不变的前提）。"""
        pet_id = self._trait_pet("skill_000142")
        state = self._state(pet_id, mana=None)
        events = []
        tr.on_enter(RS, state, "player", events)
        self.assertIsNone(state.player.field_pet.buffs.get("atk"))
        self.assertEqual([e for e in events if e.get("trait") == "图书守卫者"], [])

    def test_registry_entries_point_at_real_pets(self):
        for name in ("图书守卫者", "构装契约者"):
            spec = tr.TRAITS[name]
            self.assertTrue(RS.pets_by_name(spec.pet_name), f"{name} 写的精灵不在规则集里")
            self.assertEqual(spec.hook, "on_enter")
            self.assertEqual(spec.status, tr.FULL)
