"""整局胜负基准的**量具校准**（`scripts/roco/benchmark-planner-matches.py`）。

这个文件存在的理由是一次真实的错误读数。当时的做法是：

    planner: --swapped 打 80 局（正向 40 + 换边 40）
    baseline: 只有默认座位 40 局，而且 `use_planner=False` 那条路**完全忽略**
              `planner_side`

于是表里的「44/80 vs 18/40」不是同一批座位暴露：一半样本多暴露了一次先手，
差值里混进了座位效应。更糟的是报告用「两个 Wilson 区间有没有重叠」去判断差异，
把 0.441~0.602 这段重叠说成「几乎不重叠、弱证据」。

所以这里钉四件事，任何一件被改坏都必须变红：

  1. `--swapped` 下两侧样本数必须相等，且等于 `2 × fixtures`；
  2. 配对键 `(fixture_id, seat)` 在两侧**逐一对齐**；
  3. 主比较必须是配对检验（McNemar 精确二项 + 配对 bootstrap），
     而不是两个独立区间的比较；
  4. 故意把「换边时基线只打一个座位」塞回去，`run_benchmark` 必须报错。
"""

from __future__ import annotations

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SCRIPT = os.path.join(_ROOT, "scripts", "roco", "benchmark-planner-matches.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("benchmark_matches", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPairedStatistics(unittest.TestCase):
    """统计部分先单独钉住：它的输入可以手算。"""

    @classmethod
    def setUpClass(cls):
        cls.module = _load_module()

    def test_mcnemar_counts_only_discordant_pairs(self):
        planner = [True, True, False, False, True]
        baseline = [False, True, False, True, True]
        got = self.module.paired_test(planner, baseline)
        self.assertEqual(got["pairs"], 5)
        self.assertEqual(got["planner_only_wins"], 1)   # 第 0 对
        self.assertEqual(got["baseline_only_wins"], 1)  # 第 3 对
        self.assertEqual(got["both_win"], 2)            # 第 1、4 对
        self.assertEqual(got["both_lose"], 1)           # 第 2 对
        self.assertEqual(got["discordant"], 2)
        self.assertAlmostEqual(got["mean_paired_diff"], 0.0, places=6)

    def test_mcnemar_p_value_is_exact_binomial(self):
        # 6 个不一致对、全落一侧：双侧精确 p = 2 * P(X>=6|n=6,p=0.5) = 2/64 = 0.03125
        planner = [True] * 6
        baseline = [False] * 6
        got = self.module.paired_test(planner, baseline)
        self.assertAlmostEqual(got["mcnemar_exact_p"], 0.03125, places=6)
        self.assertTrue(got["significant_at_95"])
        # 对半分时不该显著
        planner = [True, True, False, False]
        baseline = [False, False, True, True]
        got = self.module.paired_test(planner, baseline)
        self.assertAlmostEqual(got["mcnemar_exact_p"], 1.0, places=6)
        self.assertFalse(got["significant_at_95"])

    def test_no_discordant_pairs_is_not_significant(self):
        got = self.module.paired_test([True, False], [True, False])
        self.assertEqual(got["discordant"], 0)
        self.assertAlmostEqual(got["mcnemar_exact_p"], 1.0, places=6)
        self.assertFalse(got["significant_at_95"])

    def test_paired_test_refuses_unequal_lengths(self):
        """长度不一致是最该拦的输入——它正是「80 对 40」的形状。"""
        with self.assertRaises(ValueError):
            self.module.paired_test([True] * 80, [True] * 40)

    def test_wilson_is_descriptive_only(self):
        """Wilson 只描述单方胜率；这份文件不该出现「区间是否重叠」这种判据。"""
        with open(_SCRIPT, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn("区间重叠与否不能替代差异检验", source)
        self.assertNotIn("几乎不重叠", source)
        self.assertNotIn("弱证据", source)


class TestSwappedRunIsPaired(unittest.TestCase):
    """真跑一遍小规模基准（几局），检查对齐与分层。"""

    @classmethod
    def setUpClass(cls):
        cls.module = _load_module()
        cls.report = cls.module.run_benchmark(
            games=3, opponents=["greedy_damage"], depth=2, beam=3,
            budget_ms=120, swapped=True)

    def test_both_sides_play_two_seats(self):
        entry = self.report["results"]["greedy_damage"]
        fixtures = self.report["settings"]["fixtures"]
        # 换边 = 每个 fixture 两个座位；两侧样本数必须**相等**
        self.assertEqual(entry["planner"]["games"], 2 * fixtures)
        self.assertEqual(entry["greedy_baseline"]["games"], 2 * fixtures,
                         "换边时基线也必须打两个座位，否则 80 对 40 的错误读数会重现")
        self.assertEqual(self.report["settings"]["seats"], ["player", "enemy"])

    def test_seats_are_stratified_on_both_sides(self):
        entry = self.report["results"]["greedy_damage"]
        for seat in ("player", "enemy"):
            self.assertIn(seat, entry["by_seat"])
            self.assertIn(seat, entry["greedy_baseline_by_seat"])
            self.assertEqual(entry["by_seat"][seat]["games"],
                             entry["greedy_baseline_by_seat"][seat]["games"],
                             f"{seat} 座位两侧样本数不一致")
            self.assertEqual(entry["by_seat"][seat]["seats"], [seat])

    def test_paired_test_is_reported_and_uses_matched_pairs(self):
        entry = self.report["results"]["greedy_damage"]
        paired = entry["paired"]
        self.assertEqual(paired["pairs"], entry["planner"]["games"])
        self.assertEqual(paired["pairs"], entry["greedy_baseline"]["games"])
        for key in ("planner_only_wins", "baseline_only_wins", "mean_paired_diff",
                    "paired_diff_ci95", "mcnemar_exact_p", "significant_at_95"):
            self.assertIn(key, paired)
        self.assertEqual(entry["delta_win_rate"], paired["mean_paired_diff"],
                         "delta 必须来自配对差，不能来自两个独立胜率相减")
        self.assertIn("pairing_key", " ".join(self.report["comparison_protocol"]))

    def test_rows_carry_alignment_keys(self):
        """分层汇总里每一层都要能追到 games/fallback/timeout。"""
        entry = self.report["results"]["greedy_damage"]
        for bucket in (entry["planner"], entry["greedy_baseline"]):
            for key in ("games", "wins", "fallbacks", "timed_out_decisions", "decisions"):
                self.assertIn(key, bucket)


class TestBrokenMeasurementIsCaught(unittest.TestCase):
    """**反证**：把「换边时基线只打一个座位」塞回去，必须报错。

    没有这一条，前面那些断言只证明「现在是对的」，不证明「错了会被发现」。
    """

    @classmethod
    def setUpClass(cls):
        cls.module = _load_module()

    def test_asymmetric_baseline_raises(self):
        original = self.module.play_one
        calls = {"n": 0}

        def broken(rs, team_a, team_b, seed, opponent_strategy, *, use_planner,
                   depth, beam, budget_ms, planner_side="player", fixture_id=None):
            # 复刻旧行为：基线那条路忽略 planner_side，永远坐 player。
            if use_planner:
                return original(rs, team_a, team_b, seed, opponent_strategy,
                                use_planner=True, depth=depth, beam=beam,
                                budget_ms=budget_ms, planner_side=planner_side,
                                fixture_id=fixture_id)
            calls["n"] += 1
            return original(rs, team_a, team_b, seed, opponent_strategy,
                            use_planner=False, depth=depth, beam=beam,
                            budget_ms=budget_ms, planner_side="player",
                            fixture_id=fixture_id)

        self.module.play_one = broken
        try:
            with self.assertRaises(RuntimeError) as ctx:
                self.module.run_benchmark(games=2, opponents=["greedy_damage"],
                                          budget_ms=100, swapped=True)
            self.assertIn("配对样本不对齐", str(ctx.exception))
        finally:
            self.module.play_one = original


if __name__ == "__main__":
    unittest.main()
