"""W4-01 / W4-05 的守卫：任务集与判定器必须真的能当门禁用。

三件事必须同时成立，缺一个任务集就只是文档：

  1. **每条任务都可程序化判定** —— 至少有一个机器可查的判据；
  2. **切分真的隔离** —— 留出的家族/机制/模板不出现在训练集里，
     且每个类别在 train/val/test 三侧都有样本（某侧为空 = 那一侧没评估它）；
  3. **判定器两个方向都能抓** —— 正确轨迹全过、故意违规全挂。
     没有对照组的话，「判定器全判通过」也可能是因为它根本没在判。

这组测试直接跑生成器与判定器（而不是读一份可能过期的产物），
所以「产物是不是最新」不再是问题。
"""

from __future__ import annotations

import collections
import importlib.util
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_BUILD = os.path.join(_ROOT, "scripts", "roco", "build-agent-tasks.py")
_VERIFY = os.path.join(_ROOT, "scripts", "roco", "verify-agent-tasks.py")
TASKS = os.path.join(_ROOT, "tests", "evals", "agent-tasks-v1.jsonl")


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTaskSetIsUsableAsAGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = _load("agent_task_builder", _BUILD)
        cls.verify = _load("agent_task_verifier", _VERIFY)
        cls.rows, cls.header = cls.build.build()

    def test_every_task_has_a_machine_checkable_expectation(self):
        checkable = ("tool", "args_must_match", "max_tool_calls", "max_reply_chars",
                     "must_not_fabricate", "must_mention_limitation", "must_keep_locked",
                     "must_not_claim_winrate", "must_surface_conflict", "must_not_use_stale",
                     "must_not_speak")
        for row in self.rows:
            hits = [k for k in checkable if k in row["expect"]]
            self.assertTrue(hits, f"{row['case_id']} 没有任何可程序化判定的判据")

    def test_holdout_dimensions_never_leak_into_train(self):
        for dim in ("family", "mechanism", "template"):
            holdout = set(self.header["holdout"][dim])
            in_train = {r["split"][dim] for r in self.rows if r["split"]["side"] == "train"}
            self.assertEqual(holdout & in_train, set(),
                             f"留出的 {dim} 出现在训练集里：{sorted(holdout & in_train)}")

    def test_every_category_has_samples_on_all_three_sides(self):
        side = collections.defaultdict(collections.Counter)
        for row in self.rows:
            side[row["category"]][row["split"]["side"]] += 1
        for category in self.header["categories"]:
            counts = side[category]
            self.assertGreater(counts["train"], 0, f"{category} 在 train 里没有样本")
            self.assertGreater(counts["val"], 0, f"{category} 在 val 里没有样本")
            self.assertGreater(counts["test"], 0, f"{category} 在 test 里没有样本")

    def test_messages_are_unique(self):
        """句子必须真的不同：同一句话重复多次会把数据集灌水。"""
        messages = [r["message"] for r in self.rows]
        dupes = [m for m, c in collections.Counter(messages).items() if c > 1]
        self.assertEqual(dupes, [], f"有重复句子：{dupes[:3]}")

    def test_case_ids_are_unique(self):
        ids = [r["case_id"] for r in self.rows]
        self.assertEqual(len(ids), len(set(ids)))

    def test_backfill_is_accounted_for(self):
        """为保证每类三侧都有样本而补搬的条目必须**记账**，不能偷偷改侧。"""
        backfilled = [r for r in self.rows if r["split"].get("backfilled")]
        self.assertEqual(len(backfilled), len(self.header["side_backfill"]),
                         "补搬的条目数与 header 里记的不一致")
        for row in backfilled:
            self.assertEqual(row["split"]["held_out_dimensions"], [],
                             "补搬的条目不应当还标着「留出维度命中」")


class TestVerifierDiscriminates(unittest.TestCase):
    """判定器必须两个方向都抓得住。"""

    @classmethod
    def setUpClass(cls):
        cls.verify = _load("agent_task_verifier2", _VERIFY)
        cls.tasks = cls.verify.load_tasks()

    def test_selftest_passes(self):
        result = subprocess.run([sys.executable, _VERIFY, "--selftest"],
                                cwd=_ROOT, capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0,
                         f"判定器自检失败：{result.stdout[-400:]} {result.stderr[-400:]}")
        self.assertIn("应当全过", result.stdout)
        self.assertIn("应当全挂", result.stdout)

    def test_selftest_actually_reports_both_directions(self):
        result = subprocess.run([sys.executable, _VERIFY, "--selftest"],
                                cwd=_ROOT, capture_output=True, text=True, timeout=300)
        lines = {line.split("：")[0]: line.split("：")[1].strip()
                 for line in result.stdout.splitlines() if "：" in line}
        total = str(len(self.tasks))
        self.assertEqual(lines.get("对照（应当全过）"), f"{total}/{total}")
        self.assertEqual(lines.get("对照（应当全挂）"), f"{total}/{total}")

    def test_a_single_violation_fails_a_task(self):
        """逐条判据都要能单独把一条任务判挂 —— 不能只看总分。"""
        task = next(t for t in self.tasks if t["expect"].get("tool"))
        good = {"tool_calls": [{"tool": task["expect"]["tool"],
                                "args": dict(task["expect"].get("args_must_match") or {})}],
                "reply": "已核对。"}
        self.assertTrue(self.verify.check_task(task, good)["passed"])
        bad = {"tool_calls": [], "reply": "已核对。"}
        result = self.verify.check_task(task, bad)
        self.assertFalse(result["passed"])
        self.assertTrue(result["violations"])

    def test_silence_task_rejects_any_tool_call_or_reply(self):
        task = next(t for t in self.tasks if t["expect"].get("must_not_speak"))
        self.assertTrue(self.verify.check_task(task, {"tool_calls": [], "reply": ""})["passed"])
        for bad in ({"tool_calls": [{"tool": "query_rules", "args": {}}], "reply": ""},
                    {"tool_calls": [], "reply": "我建议你换一只。"}):
            self.assertFalse(self.verify.check_task(task, bad)["passed"])

    def test_fabrication_is_caught_when_the_engine_refused(self):
        task = next(t for t in self.tasks if t["expect"].get("must_not_fabricate")
                    and t["expect"].get("must_mention_limitation"))
        bad = {"tool_calls": [], "reply": "这一招能打 250 点伤害。",
               "engine_refused": True}
        result = self.verify.check_task(task, bad)
        self.assertFalse(result["passed"])
        self.assertTrue(any("数字" in v for v in result["violations"]),
                        f"没有抓住编造：{result['violations']}")


if __name__ == "__main__":
    unittest.main()
