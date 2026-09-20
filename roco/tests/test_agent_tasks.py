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
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_BUILD = os.path.join(_ROOT, "scripts", "roco", "build-agent-tasks.py")
_VERIFY = os.path.join(_ROOT, "scripts", "roco", "verify-agent-tasks.py")
TOOLBOX = os.path.join(_ROOT, "src", "coach", "toolbox.js")
TASKS = os.path.join(_ROOT, "tests", "evals", "agent-tasks-v1.jsonl")


def tool_argument_keys():
    """从工具箱源码里读每个工具**允许**的参数名。

    为什么不在这里抄一份：抄下来的那份会随工具箱改动悄悄过期，于是
    「任务期望里的参数名」可以一直是一个工具根本不接受的键，而测试仍然是绿的。
    真实发生过：任务集里 `query_rules` 的期望参数写成 `skill_name`，
    工具契约里只有 `name` —— 任何 Agent 照做都会被 `validToolArgs` 判成非法参数，
    于是「接线自检」这一类轨迹全数变红，而没有任何测试能提前发现。
    """
    with open(TOOLBOX, encoding="utf-8") as handle:
        source = handle.read()
    contracts = source.split("export const TOOL_CONTRACTS=", 1)[1].split("\n};", 1)[0]
    allowed = {}
    for line in contracts.splitlines():
        match = re.match(r"\s*([a-z_]+):\{description:", line)
        if not match:
            continue
        body = line.split("arguments:{", 1)[1] if "arguments:{" in line else ""
        allowed[match.group(1)] = set(re.findall(r"([A-Za-z_][A-Za-z0-9_]*):", body))
    return allowed


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

    def test_expected_arguments_are_arguments_the_tool_actually_accepts(self):
        """期望里的参数名必须是工具箱真的接受的键，否则任务不可能被完成。"""
        allowed = tool_argument_keys()
        self.assertIn("query_rules", allowed, "没能从 toolbox.js 里解析出工具契约")
        for row in self.rows:
            expect = row["expect"]
            tool = expect.get("tool")
            if not tool:
                continue
            self.assertIn(tool, allowed, f"{row['case_id']} 期望的工具 {tool} 不存在")
            want = expect.get("args_must_match") or {}
            unknown = sorted(set(want) - allowed[tool])
            self.assertEqual(unknown, [], f"{row['case_id']} 的期望参数 {unknown} 不是 {tool} 接受的键")

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

    def test_committed_task_set_matches_a_fresh_build(self):
        """产物必须与**现在**的生成器一致。

        没有这条的时候，改生成器（比如把期望参数改成工具不接受的键）不会让任何测试变红：
        其它用例用的是内存里重新 build 的结果，产物还是旧的，而产物才是下游
        （轨迹集、门禁）真正读的东西。这个盲点在守卫自检里被注入实验抓到过。
        """
        # 在**独立进程**里重新生成，而不是调同一个模块的 build()：
        # `build()` 会往模块级的累加器里追加，重复调用**不是幂等**的
        # （第一次 14 条、之后只返回增量）。在进程内调用会把这条测试变成一个
        # 靠调用顺序才能通过的测试——那种测试比没有更糟。
        result = subprocess.run(
            [sys.executable, _BUILD, "--json"], cwd=_ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, f"生成器失败：{result.stderr[-300:]}")
        fresh = result.stdout
        fresh_rows = [json.loads(line) for line in fresh.splitlines()
                      if line.strip() and json.loads(line).get("record_type") == "agent_task"]
        fresh_digest = hashlib.sha256(
            ("\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in fresh_rows))
            .encode("utf-8")).hexdigest()
        committed = [
            json.loads(line) for line in open(TASKS, encoding="utf-8")
            if line.strip() and json.loads(line).get("record_type") == "agent_task"
        ]
        committed_digest = hashlib.sha256(
            ("\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in committed))
            .encode("utf-8")).hexdigest()
        self.assertEqual(
            len(fresh_rows), len(committed),
            f"产物条数 {len(committed)} 与现场生成 {len(fresh_rows)} 不一致："
            "改了生成器却没有重跑 `python3 scripts/roco/build-agent-tasks.py`")
        self.assertEqual(
            fresh_digest, committed_digest,
            "产物的任务内容与现场生成不一致（同样的键、同样的顺序）：请重跑生成器")

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
