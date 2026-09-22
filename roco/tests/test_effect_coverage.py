"""RC-401/403 效果覆盖台账的守卫：**覆盖率是「数据 × 已声明能力」的属性**，不是一句口号。

四条判据，每条都有必红方向：
  ① 总量守恒：分档之和 == 实体总数（技能 579 + 特性 245），覆盖率由分档**重算**得到；
  ② 分类**由数据驱动**：改一条 desc（内存副本）必须改变它的档位；
  ③ **能力声明会影响覆盖率**：同一条「3连击」技能，声明了连击能力才算可模拟；
  ④ 台账不吹牛：可模拟档只要求「描述被完整读出且引擎会结算」，**不等于**实机核验。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as cov     # noqa: E402
from roco_env import data as rdata       # noqa: E402

RS = rdata.load_ruleset()


class CoverageLedgerTest(unittest.TestCase):
    def setUp(self):
        self.report = cov.build_coverage(RS)

    def test_totals_add_up(self):
        totals = self.report["totals"]
        levels = self.report["support_levels"]
        for key in ("battle_skills", "traits"):
            self.assertEqual(sum(levels[key].values()), totals[key],
                             f"{key} 的分档之和不等于总数（账目对不上）")
        self.assertEqual(totals["battle_skills"], 579)
        self.assertEqual(totals["traits"], 245)
        self.assertEqual(totals["entities"], 824)

    def test_ratio_is_recomputed_from_the_buckets(self):
        levels = self.report["support_levels"]
        tally = levels["battle_skills"][cov.SUPPORT_SIMULATABLE_UNVERIFIED] \
            + levels["battle_skills"][cov.SUPPORT_FULL_VERIFIED] \
            + levels["traits"][cov.SUPPORT_SIMULATABLE_UNVERIFIED] \
            + levels["traits"][cov.SUPPORT_FULL_VERIFIED]
        self.assertEqual(tally, self.report["totals"]["simulatable_entities"])
        self.assertAlmostEqual(tally / 824, self.report["totals"]["simulatable_ratio"], places=4)

    def test_declared_capability_changes_the_verdict(self):
        """同一条静态 3 连击技能：声明了能力才算可模拟 —— 否则这条判据是空的。"""
        skill = RS.skills["skill_000258"]
        without = cov.classify_skill(skill, multi_hit_declared=False)
        with_it = cov.classify_skill(skill, multi_hit_declared=True)
        self.assertEqual(without["support"], cov.SUPPORT_KNOWLEDGE_ONLY,
                         f"没声明能力时应当是只有资料，实际 {without}")
        self.assertEqual(with_it["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         f"声明之后应当可模拟，实际 {with_it}")
        self.assertIn("连击×3", with_it["claimed_by_capability"])
        # 整份报告的覆盖率也必须跟着变（否则分类只是装饰）
        narrow = cov.build_coverage(RS, declared_capabilities={"multi_hit": False})
        self.assertLess(narrow["totals"]["simulatable_entities"],
                        self.report["totals"]["simulatable_entities"],
                        "关掉连击能力之后可模拟实体数必须**下降**")

    def test_classification_follows_the_text_not_a_name_list(self):
        """反证：把 desc 改成一句未实现机制，档位必须变 —— 分类不是按技能名硬编码的。"""
        class _Skill:
            skill_id = "skill_test"
            name = "测试技能"
            is_trait = False
            desc = "造成物伤，2连击。"

        without = cov.classify_skill(_Skill(), multi_hit_declared=False)
        self.assertEqual(without["support"], cov.SUPPORT_KNOWLEDGE_ONLY)
        _Skill.desc = "造成物伤，2连击，敌方获得2层星陨印记，本次技能连击数+1。"
        still_dynamic = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertNotEqual(still_dynamic["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "动态连击不能被算成完全可模拟")
        _Skill.desc = "造成物伤。"
        plain = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertEqual(plain["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         "纯伤害技能走伤害路径，属于可模拟")

    def test_ranking_is_the_next_step_evidence(self):
        """排序必须把「未被登记的特性」与「连击」放在最前 —— 它就是下一步该做什么的依据。"""
        ranking = {row["primitive"]: row for row in self.report["coverage_ranking"]}
        self.assertIn("连击", ranking)
        self.assertGreater(ranking["连击"]["skills"], 0, "统计口径里的连击应当还有剩余（动态那批）")
        self.assertEqual(ranking["未被登记"]["traits"], 233)
