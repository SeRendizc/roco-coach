"""Microcase 台账的守卫（`scripts/roco/run-microcase-harness.py` 的契约测试）。

这份台账是**给人和后续轮次读的**，所以它自己的口径必须被钉住：

  1. `verification_passed` **永远**是 false —— 通过只能来自游戏内实测。
     台账一旦能自称「通过」，它就变成了自己给自己判卷。
  2. 每条 case 必须有明确状态（`ENGINE_ASSUMPTION` 或 `NOT_EXECUTABLE`），
     不许出现「没跑过所以空着」。
  3. `NOT_EXECUTABLE` 的每一条必须写清缺什么 —— 「做不到」和「没做」是两件事。
  4. `observed` 必须来自真的跑一遍引擎，所以每条 `ENGINE_ASSUMPTION` 都要有
     结构化字段或明确的证据引用，不能只有一句中文。

台账由脚本生成，测试直接跑脚本（而不是读一个可能过期的产物文件），
这样「产物是否最新」不再是问题。
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SCRIPT = os.path.join(_ROOT, "scripts", "roco", "run-microcase-harness.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("microcase_harness", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestMicrocaseHarness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = _load_module()
        cls.rs = cls.module.rdata.load_ruleset()
        cls.module.RS_ALIAS.append(cls.rs)
        _, cls.cases = cls.module.load_cases()
        cls.rows = [cls.module.classify(case, cls.rs) for case in cls.cases]

    def test_no_case_is_marked_as_verified(self):
        for row in self.rows:
            self.assertIs(row["verification_passed"], False,
                          f"{row['case_id']} 不许自称通过——通过只能来自游戏内实测")

    def test_every_case_has_an_explicit_status(self):
        allowed = {self.module.ENGINE_ASSUMPTION, self.module.NOT_EXECUTABLE}
        for row in self.rows:
            self.assertIn(row["harness_status"], allowed,
                          f"{row['case_id']} 的状态不明确：{row['harness_status']}")

    def test_not_executable_cases_say_what_is_missing(self):
        for row in self.rows:
            if row["harness_status"] == self.module.NOT_EXECUTABLE:
                self.assertTrue(row.get("missing"),
                                f"{row['case_id']} 标了 NOT_EXECUTABLE 却没写缺什么")

    def test_executable_cases_have_evidence(self):
        for row in self.rows:
            if row["engine_can_run_it"]:
                self.assertTrue(row.get("observed"), f"{row['case_id']} 没有记录引擎行为")
                self.assertTrue(row.get("evidence"),
                                f"{row['case_id']} 没有证据引用（术语或常量）")

    def test_priority_and_speed_tie_probes_actually_ran_the_engine(self):
        """两条最基础的探针必须产出**结构化**结果，而不是一句中文。

        它们覆盖 MC-001/MC-002 —— 行动顺序错了，后面所有数值都没意义，
        所以这两条必须真的跑过引擎并留下可核对的字段。
        """
        by_id = {row["case_id"]: row for row in self.rows}
        self.assertTrue(by_id["MC-001"]["engine_can_run_it"])
        self.assertEqual(by_id["MC-001"]["fields"]["sort_key"],
                         ["respond", "priority", "speed", "tie"])
        self.assertTrue(by_id["MC-002"]["engine_can_run_it"])
        orders = by_id["MC-002"]["fields"]["order_by_seed"]
        self.assertEqual(len(orders), 4, "同速裁决探针要对多个 seed 各跑一次")
        for order in orders:
            self.assertEqual(sorted(order), ["enemy", "player"])

    def test_hidden_information_case_is_a_product_invariant(self):
        """MC-013 不该被写成「假设」——它是产品不变量，由测试而非实测保证。"""
        by_id = {row["case_id"]: row for row in self.rows}
        row = by_id["MC-013"]
        self.assertTrue(row["engine_can_run_it"])
        self.assertIn("产品不变量", row["assumption"])
        self.assertGreater(row["fields"]["hidden_count"], 0, "任意深度的 seed 必须被拒")
        self.assertIs(row["fields"]["public_has_seed"], False)


class TestHarnessScriptRuns(unittest.TestCase):
    """脚本必须能独立跑通并写出两份产物（避免只在 import 时不崩）。"""

    def test_script_writes_report_and_doc(self):
        env = dict(os.environ, PYTHONPATH=os.path.join(_ROOT, "roco", "src"))
        result = subprocess.run([sys.executable, _SCRIPT], cwd=_ROOT, env=env,
                                capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        report = os.path.join(_ROOT, "reports", "roco", "microcases", "harness.json")
        doc = os.path.join(_ROOT, "docs", "roco", "MICROCASE-HARNESS.md")
        self.assertTrue(os.path.exists(report))
        self.assertTrue(os.path.exists(doc))
        with open(report, encoding="utf-8") as fh:
            payload = json.load(fh)
        self.assertEqual(payload["summary"]["verification_passed"], 0)
        self.assertEqual(payload["summary"]["total"], len(payload["cases"]))
        # 文档里必须明说「这份台账不是通过证明」
        with open(doc, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("没有任何一条 microcase 因为这份台账而「通过」", text)


if __name__ == "__main__":
    unittest.main()


class TestProgressDashboard(unittest.TestCase):
    """进度台账的守卫：`DONE` 必须有存在的证据，且不许有「没做完却标 DONE」。

    这份台账是给用户看「到底做到哪了」的，所以它自己最容易失真：
    `[x]` 只说明「我认为做完了」。这里的断言把它压回可核对：
    每条 `DONE` 的每个证据路径都必须真的存在。
    """

    @classmethod
    def setUpClass(cls):
        path = os.path.join(_ROOT, "scripts", "roco", "build-progress-dashboard.py")
        spec = importlib.util.spec_from_file_location("progress_dashboard", path)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_every_done_item_has_existing_evidence(self):
        for item in self.module.ITEMS:
            checked = self.module.check_evidence(item.get("evidence") or [])
            missing = [e["path"] for e in checked if not e["exists"]]
            self.assertEqual(missing, [],
                             f"{item['id']} 标了 {item['status']} 但证据不存在：{missing}")
            if item["status"] == self.module.DONE:
                self.assertTrue(checked, f"{item['id']} 标了 DONE 却没有任何证据路径")

    def test_non_done_items_say_what_or_who_is_missing(self):
        for item in self.module.ITEMS:
            if item["status"] == self.module.DONE:
                continue
            self.assertTrue(item.get("note"),
                            f"{item['id']} 不是 DONE，必须写清为什么")
            # NEEDS_HUMAN 的项必须点出缺的是**谁**，而不是含糊说「待补」
            if item["status"] == self.module.NEEDS_HUMAN:
                self.assertTrue(item.get("needs"),
                                f"{item['id']} 标了 NEEDS_HUMAN 却没说缺谁提供")

    def test_boundary_blocked_items_cite_the_boundary(self):
        for item in self.module.ITEMS:
            if item["status"] == self.module.BLOCKED_BY_BOUNDARY:
                self.assertIn("边界", item.get("note", ""),
                              f"{item['id']} 标了 BLOCKED_BY_BOUNDARY 却没写是哪条边界")

    def test_ids_are_unique(self):
        ids = [item["id"] for item in self.module.ITEMS]
        self.assertEqual(len(ids), len(set(ids)), "台账里有重复 id")
