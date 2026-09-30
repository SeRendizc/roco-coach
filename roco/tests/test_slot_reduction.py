"""F 族第五种形状「**本技能位于N号位时额外减伤N%**」（RC-401 批次十八 · 2026-09-30）。

⚠ **合成 loadout 测得；`skill_000491 相位移动` 在冻结语料的配招里不可达** ✓
（全体 `candidate_moveset` 命中 0 ⇒ **没有任何一手会用出它** ✗ ⇒ 见 `reports/roco/rc401/UNREACHABLE-LEDGER.md`）。
⇒ 所以本文件的数值断言**测的是"复合口径"这条**本地规则**本身** ✓，不是"实盘会不会发生" ✓。

⚠ **复合口径 = 本地规则** ✓：`pet._defense_reduction` 是**单值** ✗，原始资料与代码**均未定义**
「基础减伤 + 额外减伤」如何复合 ⇒ **本地取加法** ✓（人类授权「缺参数在本地规则显式定义并与原始资料区分」✓）。
"""
import types
import unittest

from roco_env import coverage as cov
from roco_env import effects as fx
from roco_env import env as env_mod
from roco_env import rule_config as rc_mod
from roco_env.data import load_ruleset


def _state_with(skill_id: str):
    """合成一个只含"配招里带这条技能"的最小 state（helper 只读 `loadouts` + `field_pet.pet_id` ✓）。"""
    rs = load_ruleset()
    pid = next(iter(rs.pets))
    side = types.SimpleNamespace(
        loadouts={pid: (skill_id,)},
        field_pet=types.SimpleNamespace(pet_id=pid))
    return types.SimpleNamespace(player=side, enemy=side), rs


class SlotReductionShapeTest(unittest.TestCase):
    """`skill_000491 相位移动`「减伤50%，本技能位于1号位或3号位时，额外减伤40%，应对攻击，传动1。」"""

    @classmethod
    def setUpClass(cls):
        cls.rs = load_ruleset()
        cls.skill = cls.rs.skills["skill_000491"]
        cls.caps = cov.declared_capabilities_of()
        cls.cfg = rc_mod.get_rule_config("mobile_s4_candidate_v3")

    def test_positive_slot_reduction_is_claimed(self):
        """正例：声明了号位能力 ⇒ 「号位时额外减伤40%」被认领 ⇒ `resolved=True` 且 `unsettled` 清空。"""
        v = cov.settlement_verdict(self.skill, declared=self.caps)
        self.assertTrue(v["resolved"], f"000491 应已结算，实际 unsettled={v['unsettled']}")
        self.assertEqual(v["unsettled"], [], "那条「号位（出现在：…额外减伤40%…）」应当被认领掉")

    def test_control_flag_off_restores_the_old_path(self):
        """Δ=0 反证（更强版）：**关掉 `slot_condition`** ⇒ 回到旧路径 —— 那条 span 必须**逐字**回来。

        反证方向：若"认领"不看旗标，这条会红 ⇒ 它钉住的是**门控真的在起作用** ✓。
        """
        off = {**self.caps, "slot_condition": False}
        v = cov.settlement_verdict(self.skill, declared=off)
        self.assertFalse(v["resolved"], "关掉号位能力后必须回到未结算 ✗")
        self.assertTrue(any(str(r).startswith("号位（") for r in v["unsettled"]),
                        f"关旗标后那条标记必须原样回来，实际 {v['unsettled']}")

    def test_numeric_composition_is_additive_local_rule(self):
        """🔑 数值断言（**本文件最强的一条** ✓）：**基础 0.5 + 额外 0.4 ⇒ 0.90**（本地规则：加法 ✓）。

        关旗标 ⇒ **0.50**（回到只有基础减伤 ⇒ 那一半是**门控的数值证据** ✓）。
        浮点用 `assertAlmostEqual` ✗ 不用 `==`。
        """
        st, _ = _state_with("skill_000491")
        base = fx.parse_defense_reduction(self.skill)
        self.assertAlmostEqual(base, 0.5, places=9, msg="基础减伤应为 0.50")
        on = base + env_mod._slot_extra_reduction(st, "player", self.skill, self.cfg) / 100.0
        self.assertAlmostEqual(on, 0.9, places=9,
                               msg="本地规则取加法 ⇒ 0.50 + 0.40 = 0.90（若改成乘法会红 ✗）")
        off_cfg = __import__("dataclasses").replace(self.cfg, damage_slot_condition=False)
        off = base + env_mod._slot_extra_reduction(st, "player", self.skill, off_cfg) / 100.0
        self.assertAlmostEqual(off, 0.5, places=9, msg="关旗标后必须只剩基础减伤 0.50")


if __name__ == "__main__":
    unittest.main()
