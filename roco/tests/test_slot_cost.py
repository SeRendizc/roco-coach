"""F 族第四种形状「**本技能位于N号位时能耗-N**」（RC-401 批次十八 · 2026-09-30）。

为什么单开一个文件：这一条是**号位条件里第三种效果类型**（既有两种＝威力+X / 连击+X ✓），
而它的落点是**能耗**（不是伤害/连击）⇒ 判据要同时钉住**正例**与**关掉旗标后的 Δ=0 反证** ✓。
"""
import unittest

from roco_env import coverage as cov
from roco_env.data import load_ruleset


class SlotCostShapeTest(unittest.TestCase):
    """`skill_000481 齿轮切开`「造成物伤，本技能位于1号或3号位时能耗-2，传动1。」"""

    @classmethod
    def setUpClass(cls):
        cls.rs = load_ruleset()
        cls.skill = cls.rs.skills["skill_000481"]
        cls.caps = cov.declared_capabilities_of()

    def test_positive_slot_cost_is_claimed(self):
        """正例：声明了号位能力 ⇒ 「号位时能耗-2」被认领 ⇒ `resolved=True` 且 `unsettled` 清空。"""
        v = cov.settlement_verdict(self.skill, declared=self.caps)
        self.assertTrue(v["resolved"], f"000481 应已结算，实际 unsettled={v['unsettled']}")
        self.assertEqual(v["unsettled"], [], "那条「号位（出现在：…能耗-2…）」应当被认领掉")

    def test_control_flag_off_restores_the_old_path(self):
        """Δ=0 反证（更强版）：**关掉 `slot_condition`** ⇒ 回到旧路径 —— 那条 span 必须**逐字**回来。

        反证方向：若"认领"是无条件的（不看旗标），这条会红 ⇒ 它钉住的是**门控真的在起作用** ✓。
        """
        off = {**self.caps, "slot_condition": False}
        v = cov.settlement_verdict(self.skill, declared=off)
        self.assertFalse(v["resolved"], "关掉号位能力后必须回到未结算 ✗")
        self.assertTrue(any(str(r).startswith("号位（") for r in v["unsettled"]),
                        f"关旗标后那条标记必须原样回来，实际 {v['unsettled']}")


if __name__ == "__main__":
    unittest.main()
