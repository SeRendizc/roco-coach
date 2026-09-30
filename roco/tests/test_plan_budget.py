"""04.3 规划定向判据：R3（coverage 是计数比）· R5（束宽裁剪逐类留痕）· R8（深度/预算截断语义）。

跑法（仓库根）：
  `wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.3.sh`
或在 `roco/` 下：
  `PYTHONPATH=src python3 -m unittest tests.test_plan_budget -v`

这一组钉三件事，每件都两向（改坏必红 / 不改坏不红）：
  ① **R5**：被裁掉的候选 + 留下的候选 = **全部**合法动作（一个不多一个不少），
     且逐条给出「谁、什么类别、值多少、按什么规则被裁」；
  ② **R3**：`coverage` 是**计数比**（分子/分母/单位/`is_confidence:false`），
     分母是 beam **裁剪之后**的候选数 —— 单看 `coverage` 会读成「把握度」；
  ③ **R8**：`depth_truncated`（请求被 MAX_DEPTH 截断）与 `depth_capped_by_max`
     （已到引擎上限）分开写；超时与深度的关系有明确判据。
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402
from roco_env import service as svc_mod     # noqa: E402

# 夹具与金标参数**只有一处实现**（test_plan_scenarios）；这里复用，避免两套夹具漂移。
from tests.test_plan_scenarios import (     # noqa: E402
    PLAN_BEAM, PLAN_BUDGET_MS, PLAN_DEPTH, PLAN_SEEDS,
    canon, public_state, service_public, plan_body,
)

RS = rdata.load_ruleset()


def legal_actions(state, side="player"):
    return [a for a in renv.legal_actions(state, RS, side) if a.kind != "escape"]


class TruncationTraceTest(unittest.TestCase):
    """R5：束宽/类别保底裁剪必须逐类留痕，且「裁掉的 + 留下的 = 全部」。"""

    def test_dropped_and_kept_partition_all_legal_actions(self):
        state, _ = public_state()
        actions = legal_actions(state)
        self.assertGreater(len(actions), PLAN_BEAM, "夹具要有「束宽装不下」的动作，否则这条判据是空的")
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        tr = plan["truncation"]
        self.assertEqual(tr["candidates_total"], len(actions))
        self.assertEqual(tr["candidates_kept"] + tr["candidates_dropped"], tr["candidates_total"])
        self.assertEqual(sum(tr["kept_by_kind"].values()), tr["candidates_kept"])
        self.assertEqual(sum(tr["dropped_by_kind"].values()), tr["candidates_dropped"])
        # 逐条：「裁掉的」∪「留下的」= 全部合法动作（按标签比 —— 标签是回执里唯一的对外名字）
        kept_labels = {pm._label(RS, a) for a in actions[:0]}      # 占位，下面用 dropped 的补集算
        kept_labels = sorted(set(pm._label(RS, a) for a in actions) - {r["action"] for r in tr["dropped"]})
        all_labels = sorted(pm._label(RS, a) for a in actions)
        dropped_labels = [r["action"] for r in tr["dropped"]]
        self.assertEqual(sorted(set(dropped_labels) | set(kept_labels)), all_labels,
                         "「被裁掉的」∪「留下的」必须**恰好**是全部合法动作")
        self.assertEqual(len(set(dropped_labels) & set(kept_labels)), 0, "同一条动作不许既被裁又被留")
        self.assertEqual(len(dropped_labels), len(set(dropped_labels)), "dropped 里不许有重复行")
        # 每条被裁的都要给「为什么」与「类别」，值的顺序按一手推演值降序（可核对）
        for row in tr["dropped"]:
            self.assertIn(row["kind"], ("skill", "switch", "item"))
            self.assertTrue(row["why"])
            if row["value"] is None:
                self.assertIn("算不出来", row["why"])
        values = [r["value"] for r in tr["dropped"] if r["value"] is not None]
        self.assertEqual(values, sorted(values, reverse=True), "dropped 必须按一手推演值降序")
        self.assertIn("类别保底", tr["rule"])
        self.assertIs(tr["is_probability"], False)

    def test_beam8_keeps_everything(self):
        """beam=8 时不得有候选被裁（否则说明「留痕」本身漏数）。"""
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=2, beam=pm.MAX_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        tr = plan["truncation"]
        self.assertEqual(tr["candidates_dropped"], 0)
        self.assertEqual(tr["dropped"], [])
        self.assertEqual(tr["candidates_kept"], tr["candidates_total"])


class CoverageRatioTest(unittest.TestCase):
    """R3：coverage 是计数比，不是把握度；分母是 beam 裁剪之后的候选数。"""

    def test_coverage_detail_is_a_count_ratio(self):
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        detail = plan["coverage_detail"]
        self.assertEqual(detail["unit"], "count_ratio")
        self.assertIs(detail["is_confidence"], False)
        self.assertIs(detail["is_probability"], False)
        self.assertEqual(detail["denominator"], plan["truncation"]["candidates_kept"],
                         "分母必须是 beam 裁剪后的候选数（不是全部合法动作）")
        self.assertLess(detail["denominator"], plan["truncation"]["candidates_total"],
                        "夹具里 beam 确实裁掉了候选 ⇒ 两个分母必须不同（否则这条判据量不到东西）")
        self.assertAlmostEqual(detail["numerator"] / detail["denominator"], plan["coverage"], places=9)
        self.assertIn("不是", detail["note"])
        self.assertIn("把握度", detail["note"])

    def test_timeout_makes_numerator_smaller_than_denominator(self):
        """超时后 coverage 的分子必须如实变小（不许仍报「全覆盖」）。"""
        state, _ = public_state()
        ticks = iter([0.0] + [1.0] * 64)           # start=0，之后全部超预算
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=50,
                               clock=lambda: next(ticks)).to_dict()
        self.assertIs(plan["timed_out"], True)
        detail = plan["coverage_detail"]
        self.assertLess(detail["numerator"], detail["denominator"])
        self.assertEqual(plan["coverage"], 0.0)


class BudgetSemanticsTest(unittest.TestCase):
    """R8：请求被 MAX_DEPTH 截断 vs 已到引擎上限，两种「到顶」分开写。"""

    def test_depth_within_limit_is_not_truncated(self):
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=800,
                               clock=lambda: 0.0).to_dict()
        b = plan["budget"]
        self.assertEqual(b["depth_requested"], 2)
        self.assertEqual(b["depth_effective"], 2)
        self.assertEqual(b["depth_searched"], 2)
        self.assertEqual(b["depth_max"], pm.MAX_DEPTH)
        self.assertIs(b["depth_truncated"], False)
        self.assertIs(b["depth_capped_by_max"], False)
        self.assertIs(b["beam_truncated"], False)
        self.assertEqual(b["nodes"], plan["branches_evaluated"])

    def test_request_over_max_depth_is_marked_truncated(self):
        state, _ = public_state()
        plan = pm.plan_actions(state, RS, depth=pm.MAX_DEPTH + 2, beam=pm.MAX_BEAM + 1,
                               budget_ms=800, clock=lambda: 0.0).to_dict()
        b = plan["budget"]
        self.assertEqual(b["depth_requested"], pm.MAX_DEPTH + 2)
        self.assertEqual(b["depth_effective"], pm.MAX_DEPTH)
        self.assertEqual(b["depth_searched"], pm.MAX_DEPTH)
        self.assertIs(b["depth_truncated"], True, "请求超过上限必须标出来")
        self.assertIs(b["depth_capped_by_max"], True, "到达引擎上限也必须标出来")
        self.assertEqual(b["beam_requested"], pm.MAX_BEAM + 1)
        self.assertEqual(b["beam_effective"], pm.MAX_BEAM)
        self.assertIs(b["beam_truncated"], True)
        # 深度语义与既有字段一致：depth_searched 就是搜索到的层数
        self.assertEqual(plan["depth_searched"], b["depth_searched"])

    def test_timeout_is_reported_in_budget(self):
        state, _ = public_state()
        ticks = iter([0.0] + [1.0] * 64)
        plan = pm.plan_actions(state, RS, depth=2, beam=PLAN_BEAM, budget_ms=50,
                               clock=lambda: next(ticks)).to_dict()
        b = plan["budget"]
        self.assertIs(plan["timed_out"], True)
        self.assertIs(b["timed_out"], True)
        # note 里声明的判据必须**当场成立**：没截断、没搜到要求深度 ⇒ 只可能是超时
        self.assertIs(b["depth_truncated"], False)
        self.assertLess(b["depth_searched"], b["depth_effective"])
        self.assertIn("timed_out=true", b["note"])


class ServiceTraceAggregationTest(unittest.TestCase):
    """04.3：三块在 `/battle/plan` 回执里逐种子可查，且不许被压成一个数。"""

    def setUp(self):
        self.svc, self.public = service_public()

    def test_receipt_carries_three_blocks_per_seed(self):
        status, env = self.svc.battle_plan(plan_body(self.public))
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        detail = payload["coverage_detail"]
        self.assertEqual(detail["unit"], "count_ratio")
        self.assertIs(detail["is_confidence"], False)
        self.assertEqual(sorted(detail["by_seed"]), [str(s) for s in PLAN_SEEDS])
        for row in detail["by_seed"].values():
            self.assertIsInstance(row["numerator"], int)
            self.assertIsInstance(row["denominator"], int)
            self.assertLessEqual(row["numerator"], row["denominator"])

        tr = payload["truncation"]
        self.assertIn("类别保底", tr["rule"])
        self.assertEqual(sorted(tr["by_seed"]), [str(s) for s in PLAN_SEEDS])
        self.assertTrue(tr["dropped"], "夹具里 beam 装不下 ⇒ 必须逐条列出被裁的候选")
        self.assertIs(tr["is_probability"], False)
        for row in tr["by_seed"].values():
            self.assertEqual(row["candidates_kept"] + row["candidates_dropped"],
                             row["candidates_total"])

        budget = payload["budget"]
        self.assertEqual(budget["depth_requested"], PLAN_DEPTH)
        self.assertEqual(budget["beam_effective"], PLAN_BEAM)
        self.assertIs(budget["timed_out"], False)
        self.assertEqual(budget["nodes"], payload["branches_evaluated"],
                         "聚合的 nodes 必须等于逐种子 branches_evaluated 之和")
        self.assertEqual(budget["depth_searched_max"], payload["depth_searched"])
        # 信封里必须点名 coverage 的口径（否则「覆盖率」会被读成把握度）
        limitations = env.get("limitations") or []
        self.assertTrue(any("计数比" in line for line in limitations), limitations)

    def test_over_max_depth_is_rejected_not_silently_clamped(self):
        """`/battle/plan` 对超上限的 depth/beam **直接 400**，不静默 clamp。

        为什么这条比「clamp 后标记 truncated」更重要：静默 clamp 会让调用方以为
        自己拿到的是 depth=5 的结果。引擎的 `depth_truncated`（R8）是给**直接调用
        `plan_actions()`** 的场景（脚本/基准）用的；服务这一层必须 fail closed。
        """
        for name, value in (("depth", pm.MAX_DEPTH + 2), ("beam", pm.MAX_BEAM + 1)):
            body = plan_body(self.public, **{name: value})
            status, env = self.svc.battle_plan(body)
            self.assertEqual(status, 400, f"{name}={value} 必须 400，实际 {status}")
            self.assertEqual(env["error_type"], "bad_request")
            self.assertIn(name, env["error"] or "")
            self.assertIn("1..", env["error"] or "")

    def test_valid_limits_are_reported_untruncated(self):
        status, env = self.svc.battle_plan(plan_body(self.public))
        self.assertEqual(status, 200, env.get("error"))
        budget = env["result"]["budget"]
        self.assertEqual(budget["depth_requested"], PLAN_DEPTH)
        self.assertEqual(budget["depth_searched_max"], PLAN_DEPTH)
        self.assertEqual(budget["depth_searched_max"], env["result"]["depth_searched"])
        self.assertIs(budget["depth_truncated"], False)
        self.assertIs(budget["beam_truncated"], False)
        self.assertIs(env["result"]["timed_out"], False,
                      "到上限≠没算完：不许把「已到引擎上限」报成超时")


if __name__ == "__main__":
    unittest.main(verbosity=2)
