"""04.4 规划定向判据：稳健排序（先避有证据的重大损失）· 相近动作并列 · R1/R2 机器可检声明。

跑法（仓库根）：
  `wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.4.sh`
或在 `roco/` 下：
  `PYTHONPATH=src python3 -m unittest tests.test_plan_ranking -v`

这一组钉四件事，每件都两向（改坏必红 / 不改坏不红）：
  ① **必做反例②**：一个真实公开面上，「期望高但某个**有证据的**分支会崩」的动作
     必须被「没有崩盘分支的保守动作」压下去（旧口径 `(expected, worst)` 会选前者）；
  ② **「有证据」三个字**：fail closed 哨兵（算不出来的分支）**不算**损失证据；
  ③ **相近动作并列**：容差内并列列出，不假装一条严格更优；
  ④ **R1/R2**：`declarations` 把「不是胜率/不是概率/不是把握度」落到机器可检字段，
     且 `robustness`/`declarations` 里的 `is_probability` 一律 false。
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402
from roco_env import service as svc_mod     # noqa: E402
from roco_env.service import RocoService    # noqa: E402

# 夹具与金标参数**只有一处实现**（test_plan_scenarios）；这里复用，避免两套夹具漂移。
from tests.test_plan_scenarios import (     # noqa: E402
    PLAN_BEAM, PLAN_BUDGET_MS, PLAN_SEEDS, canon, public_state, service_public, plan_body,
)

RS = rdata.load_ruleset()
#: 必做反例②的夹具（**实测搜出来的**，见 04.4 报告 §3）：
#: 「寂灭骨龙/海豹船长/黑猫巫师」对同阵容，己方场上那只压到 1 HP。
#: 旧口径推「使用能量果」（expected ≈ +0.44，但最坏分支 ≈ -1.52 是**算出来的**），
#: 稳健口径推「换上第3位」（expected ≈ -0.89，但没有崩盘分支）。
COUNTER_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


def counter_example_public(*, hp: int = 1, seed: int = 1):
    """反例②的公开面：把己方场上那只压到 `hp`（公开信息，不是隐藏真值）。"""
    svc = RocoService()
    status, envelope = svc.battle_new({"team": COUNTER_TEAM, "enemy_team": COUNTER_TEAM,
                                       "seed": seed, "state_version": 0})
    assert status == 200, envelope
    public = json.loads(json.dumps(envelope["result"]["public"]))
    active = int(public["self"]["active"])
    public["self"]["pets"][active]["hp"] = hp
    return public


def old_order_top(ranked):
    """旧口径（04.4 之前）的首选：`(expected, worst)` 字典序。"""
    return max(ranked, key=lambda row: (row["expected"], row["worst"]))


class CounterExampleTest(unittest.TestCase):
    """① 必做反例②：纯「期望/伤害分」高，不能盖过**有证据的**重大损失。"""

    def setUp(self):
        self.public = counter_example_public(hp=1)
        self.state = renv.state_from_public_planner(self.public, RS, analysis_seed=11)
        self.plan = pm.plan_actions(self.state, RS, depth=2, beam=4, budget_ms=800,
                                    clock=lambda: 0.0).to_dict()

    def test_robust_order_picks_the_conservative_branch(self):
        rob = self.plan["robustness"]
        ranked = rob["candidates_ranked"]
        old = old_order_top(ranked)
        # 前置条件（否则这条判据是空的）：旧首选**确实**有有证据的重大损失，
        # 且存在一条没有重大损失的候选。
        self.assertTrue(old["material_loss"],
                        f"夹具必须让旧口径选中一个「有证据的重大损失」的动作，实际 {old}")
        safe = [row for row in ranked if not row["material_loss"]]
        self.assertTrue(safe, "必须存在没有重大损失的候选（保守分支）")
        # ① 稳健口径的首选**不是**旧口径那个；
        self.assertNotEqual(self.plan["recommended_label"], old["action"],
                            "有证据的重大损失不许被高期望盖过")
        # ② 稳健口径的首选**没有**重大损失；
        self.assertIs(rob["top"]["material_loss"], False)
        # ③ 规则确实**生效**（不是碰巧换了个动作）
        self.assertTrue(rob["primary_rule_applied"])
        material_labels = [row["action"] for row in rob["material_loss_actions"]]
        self.assertIn(old["action"], material_labels, "被压下去的动作必须留痕")
        self.assertNotIn(self.plan["recommended_label"], material_labels,
                         "推荐的动作不许自己就带重大损失（还有别的选择时）")
        # ④ 旧首选仍出现在逐候选留痕里（没有被藏起来）：它的期望更高、最坏更差，都可核对
        self.assertGreater(old["expected"], rob["top"]["expected"],
                           "反例的要点就是：被压下去的那个动作**期望更高**")
        self.assertLess(old["worst"], rob["top"]["worst"])
        # ⑤ 关键：新首选**不是**按期望挑的（期望降序里的第一名就是被压下去的那个）
        self.assertNotEqual(max(ranked, key=lambda row: row["expected"])["action"],
                            self.plan["recommended_label"])
        # ⑥ 回执的 note 必须写明「为什么没推荐那一手」
        self.assertIn("有证据的重大损失", self.plan["note"])

    def test_material_loss_needs_evidence_not_the_fail_closed_sentinel(self):
        """② 「有证据」：fail closed 哨兵（算不出来的分支）**不**构成重大损失证据。

        直接钉**产品里的那个判据函数**（不是测试里重写一遍规则）：
        最坏 -1.5 但那一支是哨兵（`worst_computed=False`）⇒ 不是重大损失；
        没有对手分布 ⇒ 也不是。
        """
        self.assertIs(pm.is_material_loss(row_worst=-1.5, worst_computed=True,
                                          has_opponent_distribution=True), True)
        self.assertIs(pm.is_material_loss(row_worst=-1.5, worst_computed=False,
                                          has_opponent_distribution=True), False,
                      "哨兵不是损失证据")
        self.assertIs(pm.is_material_loss(row_worst=-1.5, worst_computed=True,
                                          has_opponent_distribution=False), False,
                      "没有对手分布的行不是分支损失证据")
        self.assertIs(pm.is_material_loss(row_worst=-pm.MATERIAL_LOSS, worst_computed=True,
                                          has_opponent_distribution=True), True,
                      "恰好等于阈值算「达到」")
        # 排序上的后果：没有损失证据时，期望高的仍然排前面
        losing = {"action": "A", "expected": 1.0, "worst": -1.5, "material_loss": True,
                  "worst_computed": True, "uncomputable_branches": 0}
        uncomputed = {**losing, "material_loss": False, "worst_computed": False,
                      "uncomputable_branches": 1}
        safe = {"action": "B", "expected": 0.3, "worst": -0.2, "material_loss": False,
                "worst_computed": True, "uncomputable_branches": 0}
        self.assertEqual(sorted([losing, safe], key=pm.robust_sort_key, reverse=True)[0]["action"],
                         "B")
        self.assertEqual(sorted([uncomputed, safe], key=pm.robust_sort_key, reverse=True)[0]["action"],
                         "A", "没有损失证据时，期望高的仍然排前面（哨兵不算证据）")
        # 真实回执里也必须能看见这个区分：`worst_computed` / `uncomputable_branches` 都在
        for row in self.plan["robustness"]["candidates_ranked"]:
            self.assertIn("worst_computed", row)
            self.assertIn("uncomputable_branches", row)
            if row["material_loss"]:
                self.assertIs(row["worst_computed"], True,
                              "只有**算出来的**最坏分支才能算重大损失证据")

    def test_old_order_would_have_picked_the_losing_action(self):
        """反证：把稳健规则摘掉（用旧键排序），首选必须回到那个「会崩」的动作。

        这条是「判据本身有牙」的自证：规则不是摆设，去掉它结果就变。
        """
        ranked = self.plan["robustness"]["candidates_ranked"]
        old_top = old_order_top(ranked)
        self.assertTrue(old_top["material_loss"])
        self.assertNotEqual(old_top["action"], self.plan["recommended_label"])


class TieTest(unittest.TestCase):
    """③ 相近动作并列：容差内不假装一条严格更优。"""

    def test_ties_are_reported_not_hidden(self):
        """容差内并列、容差外不并列、重大损失等级不同不并列（钉**产品里的** `close_calls`）。"""
        top = {"action": "A", "expected": 0.5, "worst": -0.1, "material_loss": False}
        near = {"action": "B", "expected": 0.5 - pm.TIE_EPSILON / 2,
                "worst": -0.1 - pm.TIE_EPSILON / 2, "material_loss": False}
        far = {"action": "C", "expected": 0.5 - pm.TIE_EPSILON * 10, "worst": -0.9,
               "material_loss": False}
        tier = {"action": "D", "expected": 0.5, "worst": -0.1, "material_loss": True}
        tied = [row["action"] for row in pm.close_calls([top, near, far, tier], top)]
        self.assertEqual(tied, ["B"],
                         "容差内并列；容差外不并列；重大损失等级不同**不算并列**（那是实质差别）")
        # 真实回执的字段必须在（哪怕是空的）
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        self.assertIn("tied_with_top", plan["robustness"])
        self.assertIsInstance(plan["robustness"]["tie_epsilon"], float)
        self.assertGreater(plan["robustness"]["tie_epsilon"], 0)


class DeclarationTest(unittest.TestCase):
    """④ R1/R2：口径声明落成机器可检字段（引擎 + 服务两层）。"""

    def test_engine_declarations_are_machine_checkable(self):
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        decl = plan["declarations"]
        self.assertIs(decl["is_probability"], False)
        self.assertIs(decl["is_winrate"], False)
        for key in ("expected", "worst", "best", "first_second_margin", "coverage",
                    "risk", "opponent_weights"):
            self.assertIn(key, decl, f"{key} 必须有口径声明")
            self.assertIs(decl[key]["is_probability"], False, f"{key} 必须声明不是概率")
            self.assertTrue(decl[key]["basis"], f"{key} 必须写清依据")
        self.assertIs(decl["coverage"]["is_confidence"], False)
        self.assertEqual(decl["coverage"]["unit"], "count_ratio")
        self.assertEqual(decl["expected"]["unit"], "score")
        self.assertEqual(plan["robustness"]["is_probability"], False)
        # 声明只讲口径、**不许含数字结论**：出现「胜率」字样必须是**否定**句
        self.assertIn("不是", decl["note"])

    def test_service_declarations_and_stable_ties(self):
        svc, public = service_public()
        status, env = svc.battle_plan(plan_body(public))
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        decl = payload["declarations"]
        self.assertIs(decl["is_probability"], False)
        self.assertIs(decl["by_seed_consistent"], True,
                      "同一份公开面跨种子的口径声明必须一致")
        rob = payload["robustness"]
        self.assertIs(rob["is_probability"], False)
        self.assertEqual(sorted(rob["by_seed"]), [str(s) for s in PLAN_SEEDS])
        for row in rob["by_seed"].values():
            self.assertIn("top", row)
            self.assertIn("primary_rule_applied", row)
            self.assertIn("tied_with_top", row)
            self.assertIn("material_loss_actions", row)
        # 「稳定并列」= 每个种子都并列的那些；不许只报某一个种子的巧合
        for label in rob["tied_with_top_stable"]:
            for row in rob["by_seed"].values():
                self.assertIn(label, row["tied_with_top"])
        limitations = env.get("limitations") or []
        self.assertTrue(any("稳健优先" in line for line in limitations), limitations)
        self.assertTrue(any("declarations" in line for line in limitations), limitations)

    def test_counter_example_visible_at_service_level(self):
        """反例②在**服务回执**里也要看得见（不能只在 planner 级）。"""
        svc = RocoService()
        svc.plan_clock = lambda: 0.0      # O-36：service 级判据不靠挂钟
        public = counter_example_public(hp=1)
        status, env = svc.battle_plan({"state_version": public.get("state_version"),
                                       "public": public, "depth": 2, "beam": 4,
                                       # 与其它 service 级判据同一口径：预算给到上限，
                                       # 留足余量（O-36：service 级无法注入时钟）
                                       "budget_ms": PLAN_BUDGET_MS, "analysis_seeds": [11]})
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        rob = payload["robustness"]
        self.assertTrue(rob["primary_rule_applied"])
        self.assertTrue(rob["material_loss_actions"], "被压下去的动作必须留痕")
        self.assertNotIn(payload["recommended_label"],
                         [row["action"] for row in rob["material_loss_actions"]])
        # 服务回执的顶层没有 `note`（它逐种子在 per_seed[] 里）——按真实字段读，不猜
        self.assertIn("有证据的重大损失", payload["per_seed"][0]["note"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
