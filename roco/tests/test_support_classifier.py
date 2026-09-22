"""RC-403 精灵支持等级分类的守卫。

这一组钉四件事（每条都有必红方向）：
  ① **「能上场」≠「能模拟」**：一只配招可用的精灵，若特性没登记，整体档必须是 `PARTIAL`
     （而不是 `KNOWLEDGE_ONLY`——那句话说「只有资料」，是错的；也不是
     `SIMULATABLE_UNVERIFIED`——那句话说它的行为都在按规则走，也是错的）；
  ② **不可上场 ⇒ `KNOWLEDGE_ONLY`**：配招来源是「没登记」时，整体档必须如实降级；
  ③ **明确拒绝的部件要单独列出来**（`refused_pieces`），不能混在「未实现」里含糊过去；
  ④ **确定性**：同一份输入跑两遍逐字节相同。
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata       # noqa: E402
from roco_env import support as sup      # noqa: E402

RS = rdata.load_ruleset()


class _StubRuleset:
    """最小桩：让「不可上场」这条判据能被真的驱动（而不是只靠真实数据里恰好没有）。"""

    def __init__(self, *, pets, skills, movesets, build_support):
        self.pets = pets
        self.skills = skills
        self.candidate_movesets = movesets
        self._build_support = build_support
        self.ruleset_id = "stub"

    def candidate_moveset(self, pet_id):
        return self.candidate_movesets.get(pet_id, ())

    def build_support_of(self, pet_id):
        return self._build_support.get(pet_id)


class ClassifyAllTest(unittest.TestCase):
    def setUp(self):
        self.report = sup.classify_all(RS)

    def test_every_pet_has_exactly_one_level(self):
        totals = self.report["totals"]
        self.assertEqual(totals["pets"], 622)
        counted = sum(v for k, v in totals.items() if k != "pets")
        self.assertEqual(counted, 622, f"分档之和与总数不符：{totals}")
        self.assertEqual(set(self.report["pets"]), set(RS.pets))

    def test_fieldable_but_unverified_trait_is_partial(self):
        """反证方向：把它判成 KNOWLEDGE_ONLY 或 SIMULATABLE_UNVERIFIED 都是错的。"""
        row = self.report["pets"]["pet_000001"]      # 喵喵：按需配招 + 特性未登记
        self.assertTrue(row["fieldable"], "它必须能上场（RC-402 之后 622 只都能上场）")
        self.assertEqual(row["support"], sup.SUPPORT_PARTIAL,
                         f"能上场但特性未实现 ⇒ 部分模拟，实际 {row['support']}")
        self.assertTrue(any("trait:" in item for item in row["unsimulated_pieces"]),
                        "「没在按规则走」的清单里必须点名那个特性")

    def test_summary_is_not_vacuous(self):
        """全 622 只都必须是「有部件未核验」或「全核验」——不允许出现第三种含糊状态。"""
        for pid, row in self.report["pets"].items():
            self.assertIn(row["support"], (sup.SUPPORT_FULL_VERIFIED,
                                           sup.SUPPORT_SIMULATABLE_UNVERIFIED,
                                           sup.SUPPORT_PARTIAL,
                                           sup.SUPPORT_KNOWLEDGE_ONLY,
                                           sup.SUPPORT_REFUSED), pid)
            if row["support"] == sup.SUPPORT_SIMULATABLE_UNVERIFIED:
                self.assertEqual(row["unsimulated_pieces"], [],
                                 f"{pid} 说全可模拟却列着「根本没在按规则走」的部件")
            if row["support"] == sup.SUPPORT_PARTIAL:
                self.assertTrue(row["unsimulated_pieces"] or row["refused_pieces"],
                                f"{pid} 说部分模拟却列不出任何未实现/被拒的部件")

    def test_refused_pieces_are_named(self):
        """明确拒绝实现的那几条（特化的 4 条）必须在自己的精灵上被点名。"""
        refused = {pid: row["refused_pieces"] for pid, row in self.report["pets"].items()
                   if row["refused_pieces"]}
        self.assertTrue(refused, "至少要有精灵带被拒部件，否则这条判据是空转")
        for pid, pieces in refused.items():
            self.assertTrue(all(isinstance(x, str) and x for x in pieces), pid)

    def test_deterministic(self):
        again = sup.classify_all(RS)
        self.assertEqual(json.dumps(again, ensure_ascii=False, sort_keys=True),
                         json.dumps(self.report, ensure_ascii=False, sort_keys=True))


class UnfieldableTest(unittest.TestCase):
    def test_unfieldable_pet_is_knowledge_only(self):
        """配招来源「没登记」⇒ 整体 `KNOWLEDGE_ONLY`（这条在真实数据里已经不出现，必须用桩驱动）。"""
        class _Pet:
            pet_id = "pet_x"
            name = "桩精灵"
            feature_skill_id = None
        class _Skill:
            skill_id = "skill_x"
            name = "桩技能"
            is_trait = False
            desc = "造成物伤。"
        stub = _StubRuleset(pets={"pet_x": _Pet()}, skills={"skill_x": _Skill()},
                            movesets={"pet_x": ("skill_x",) * 4}, build_support={"pet_x": None})
        row = sup.classify_pet(stub, "pet_x")
        self.assertFalse(row["fieldable"])
        self.assertEqual(row["support"], sup.SUPPORT_KNOWLEDGE_ONLY)

    def test_unknown_pet_is_knowledge_only(self):
        row = sup.classify_pet(RS, "pet_不存在")
        self.assertEqual(row["support"], sup.SUPPORT_KNOWLEDGE_ONLY)
        self.assertIn("不在当前规则集的精灵表里", row["reasons"][0])
