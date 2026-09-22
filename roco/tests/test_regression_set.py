"""RC-404 代表性回归集的守卫。

这一组钉四件事（每条都有必红方向）：
  ① **空转不算通过**：每个场景声明的期望证据必须真的出现（`expect_kinds`），
     声明「找一条带某机制的精灵」时那条技能必须**真的用出来过**；
  ② **不可达要如实登记**：数据里根本没有精灵的规范配招带某机制时，进 `unreachable`
     并写明原因——「没出现在报告里」与「登记为不可达」是两件事；
  ③ **指纹可比对**：`check_against()` 必须能抓到终局摘要或事件分布的变化；
  ④ **确定性**：同一份输入跑两遍，指纹逐字节相同。
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata       # noqa: E402
from roco_env import regression as reg   # noqa: E402

RS = rdata.load_ruleset()


class RegressionSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = reg.build_regression_set(RS)
        cls.rows = {row["id"]: row for row in cls.report["scenarios"]}

    def test_no_vacuous_scenario(self):
        """期望证据缺失必须进 `problems` —— 这条红了说明有场景在空转。"""
        self.assertEqual(self.report["problems"], [], f"有场景空转：{self.report['problems']}")

    def test_expectations_actually_appeared(self):
        for scenario in reg.SCENARIOS:
            row = self.rows[scenario["id"]]
            if row.get("unreachable"):
                self.assertTrue(any("规范配招" in reason for reason in row["unreachable"]))
                continue
            for want in scenario.get("expect_kinds", []):
                self.assertGreater(row["event_kinds"].get(want, 0), 0,
                                   f"{scenario['id']} 缺期望证据 {want}")
            if scenario.get("find_lead"):
                self.assertIn(row["lead_skill"], row["used_skills"],
                              f"{scenario['id']} 找到的首发技能一次都没用出来")

    def test_deterministic(self):
        again = reg.build_regression_set(RS)
        self.assertEqual(json.dumps(again, ensure_ascii=False, sort_keys=True),
                         json.dumps(self.report, ensure_ascii=False, sort_keys=True))

    def test_legacy_scenario_is_in_the_set(self):
        """迁移夹具那条必须在：legacy 的行为也要有代表性场景兜着。"""
        legacy = [row for row in self.report["scenarios"] if row["config"] == reg.LEGACY]
        self.assertEqual(len(legacy), 1, "至少要有一条 legacy 场景")
        self.assertGreater(legacy[0]["event_kinds"].get("damage", 0), 0)


class CheckAgainstTest(unittest.TestCase):
    """反证：指纹变了必须被抓到（否则这套回归集没有牙）。"""

    def setUp(self):
        self.report = reg.build_regression_set(RS)

    def test_identical_reports_have_no_problems(self):
        self.assertEqual(reg.check_against(self.report, reg.build_regression_set(RS)), [])

    def test_tampered_digest_is_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"][0]["state_digest"] = "0" * 64
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("终局指纹变了" in row for row in problems), problems)

    def test_tampered_event_kinds_are_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"][0]["event_kinds"]["damage"] = 999
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("事件分布变了" in row for row in problems), problems)

    def test_missing_scenario_is_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"] = tampered["scenarios"][1:]
        # 磁盘上的指纹表少了一个场景 ⇒ 重跑时它是「新的」，必须提示重新生成指纹表。
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("是新的" in row or "消失了" in row for row in problems), problems)
