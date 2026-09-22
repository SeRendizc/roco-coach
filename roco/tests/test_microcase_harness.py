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
import tempfile
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


class TestReportGeneratorsAreIdempotent(unittest.TestCase):
    """三个报告生成器连跑两次，工作区必须干净。

    为什么值得一条测试：这些脚本的产物**要入库**（它们是证据）。
    如果产物里带易变字段（时间戳、HEAD、未提交文件数），
    每次跑完 `git status` 都会显示「文档被改了」—— 久了就没人看它的 diff，
    而 diff 正是这些文档唯一的用处。

    所以纪律是：**稳定字段入库，易变字段另存 `*-run.json`**（已在 .gitignore 里）。
    这条测试就是那条纪律的执行者。
    """

    #: 这两份是**全量**产物（参数固定），可以放一起「连跑两次比字节」。
    #: 基准不在这里：它的产物取决于命令行给的 `--positions`，
    #: 而测试为了跑得快只给 6 —— 拿它跟仓库里那份（120）比字节毫无意义。
    #: 基准的等价性质由下面 `TestBenchmarksAreReproducible` 单独测。
    GENERATORS = [
        os.path.join("scripts", "roco", "run-microcase-harness.py"),
        os.path.join("scripts", "roco", "build-progress-dashboard.py"),
    ]

    @staticmethod
    def _cmd(script: str):
        return [sys.executable, os.path.join(_ROOT, script)]

    def test_second_run_produces_no_diff(self):
        env = dict(os.environ, PYTHONPATH=os.path.join(_ROOT, "roco", "src"))

        def dirty():
            """工作树里**本套件负责的产出根**下的脏文件。

            为什么不再看整个 `git status`：`verify-release` 会把多个套件放在一起跑，
            **别的套件（浏览器验收等）在同一时间窗口里也会改写自己的报告** ——
            整树 diff 会把这些正常更新误判成「这里的产物有易变字段」。
            2026-09-22 实测：`reports/roco/workshop-acceptance/browser-workshop-acceptance.json`
            被算成了本套件的新脏文件，于是门禁在 env 这一环变红；单独跑 env 则全绿。
            所以这里只看本套件产出所在的根目录；**产物内容**仍按 `produced` 的 sha256 逐字节比对
            （那条才是真正抓易变字段的判据，一字未放松）。
            """
            out = subprocess.run(["git", "status", "--porcelain"], cwd=_ROOT,
                                 capture_output=True, text=True)
            roots = ("reports/roco/microcases/", "docs/roco/MICROCASE-HARNESS.md",
                     "reports/roco/dashboard.json", "docs/roco/PROGRESS.md")
            rows = []
            for line in out.stdout.splitlines():
                if not line.strip():
                    continue
                path = line[3:].strip().strip('"')
                if path.startswith(roots):
                    rows.append(line)
            return rows

        # 先跑一遍，把产物落到「已提交」的状态
        for script in self.GENERATORS:
            subprocess.run([sys.executable, os.path.join(_ROOT, script)],
                           cwd=_ROOT, env=env, capture_output=True, timeout=180)
        # 记下产物的**内容摘要**，而不是只看 git status ——
        # 只看 git status 有个盲区：如果第一次运行就把文件弄脏了，
        # 基线里已经带着那个脏状态，第二次再变也看不出来。
        # （真踩过：顶层漏了一个 dirty_files 字段，测试没红。）
        import hashlib
        produced = [
            os.path.join(_ROOT, "reports", "roco", "microcases", "harness.json"),
            os.path.join(_ROOT, "reports", "roco", "microcases", "harness.md"),
            os.path.join(_ROOT, "docs", "roco", "MICROCASE-HARNESS.md"),
            os.path.join(_ROOT, "reports", "roco", "dashboard.json"),
            os.path.join(_ROOT, "docs", "roco", "PROGRESS.md"),
        ]

        def digests():
            out = {}
            for path in produced:
                if os.path.exists(path):
                    with open(path, "rb") as fh:
                        out[path] = hashlib.sha256(fh.read()).hexdigest()
            return out

        baseline = set(dirty())
        before = digests()
        # 再跑一遍：产物内容必须**逐字节**一致
        for script in self.GENERATORS:
            subprocess.run(self._cmd(script), cwd=_ROOT, env=env,
                           capture_output=True, timeout=300)
        after = set(dirty())
        new = sorted(after - baseline)
        # 只看**本套件自己的产出目录**：`verify-release` 在同一时间窗口里还会跑别的套件
        # （浏览器验收等），它们改写自己的报告是正常的 —— 整树 diff 会把那些算到这里来，
        # 实测就是门禁在 env 这一环变红、而单独跑 env 全绿。真正抓「易变字段」的判据是
        # 下面那条**逐字节**比对，它一字未放松。
        own = [row for row in new if "reports/roco/microcases/" in row]
        self.assertEqual(own, [],
                         f"第二次运行在本套件产出目录里新增了脏文件：{own}")
        changed = sorted(k for k in before if before[k] != digests().get(k))
        changed = sorted(k for k in before if before[k] != digests().get(k))
        self.assertEqual(changed, [],
                         f"第二次运行改了产物内容（说明里面有易变字段）：{changed}")


class TestBenchmarksAreReproducible(unittest.TestCase):
    """基准报告在同参数下必须**逐字节**可复现。

    这与上一类的区别：基准的产物取决于命令行参数（`--positions`），
    所以不能用「仓库里那份 vs 测试的小样本」比 —— 那是两回事。
    正确的不变量是：**同一份参数跑两次，产物必须完全一致**。

    为什么重要：这些报告要入库当证据。如果一个数字重复跑不出来，
    它就不该被引用。
    """

    def _run(self, script, args, out_rel):
        env = dict(os.environ, PYTHONPATH=os.path.join(_ROOT, "roco", "src"))
        result = subprocess.run(
            [sys.executable, os.path.join(_ROOT, script), *args],
            cwd=_ROOT, env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(result.returncode, 0, result.stderr[-500:])
        with open(os.path.join(_ROOT, out_rel), "rb") as fh:
            import hashlib
            return hashlib.sha256(fh.read()).hexdigest()

    # 这一组要守的是**可复现**（同参数两次跑出的字节一致），
    # 而不是「把入库的那份完整报告重算一遍」。原来它直接写
    # `reports/roco/planner-benchmark.json`，于是跑一次测试就把入库的完整样本
    # 覆盖成 `--positions 6` 的小样本——第 11 轮这么丢过一次，第 43 轮又发生了
    # （`loadouts` 修复让数字变了，diff 一出来才发现是测试写的）。
    # 现在输出到临时目录：既保持可复现断言，也不碰入库产物。
    def test_one_ply_benchmark_is_reproducible(self):
        script = os.path.join("scripts", "roco", "benchmark-planner.py")
        with tempfile.TemporaryDirectory() as tmp:
            out_one = os.path.join(tmp, "one.json")
            out_two = os.path.join(tmp, "two.json")
            first = self._run(script, ["--positions", "6", "--out", out_one], out_one)
            second = self._run(script, ["--positions", "6", "--out", out_two], out_two)
        self.assertEqual(first, second, "同参数两次跑出的基准报告不一致")

    def test_planner_calibration_is_reproducible(self):
        script = os.path.join("scripts", "roco", "check-planner-calibration.py")
        with tempfile.TemporaryDirectory() as tmp:
            out_one = os.path.join(tmp, "one.json")
            out_two = os.path.join(tmp, "two.json")
            first = self._run(script, ["--games", "3", "--out", out_one], out_one)
            second = self._run(script, ["--games", "3", "--out", out_two], out_two)
        self.assertEqual(first, second, "同参数两次跑出的标定报告不一致")

    def test_committed_benchmark_is_not_a_selftest_sample(self):
        # 反向守卫：入库那份必须是**完整样本**，不是自检跑的小样本。
        # 测试写坏入库产物这件事发生过两次，所以给它一条会红的检查。
        import json as _json
        for rel, floor in (("reports/roco/planner-benchmark.json", 50),
                           ("reports/roco/planner-calibration.json", 20)):
            with open(os.path.join(_ROOT, rel), encoding="utf-8") as fh:
                payload = _json.load(fh)
            if "planner" in payload:
                n = payload["planner"].get("positions") or 0
            else:
                n = (payload.get("summary") or {}).get("games") or 0
            self.assertGreaterEqual(
                n, floor,
                f"{rel} 只有 {n} 个样本（下限 {floor}）：它多半被自检覆盖了，"
                "重建命令见 docs/roco/BENCHMARKS.md")
