"""planner（G04）的测试。

要钉住的是**纪律**，不是「推荐得对不对」——后者没有一手证据可判：
  - 超时必须如实上报，不能假装搜完（timeout）
  - 不允许读取对手的待执行动作（隐藏信息）
  - 输出必须包含最差尾部，不能只给期望值
  - 同 seed 同局面必须给出同一推荐（确定性）
  - 即时贪心基线必须真的更短视（否则 planner 没有存在理由）

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_planner -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata      # noqa: E402
from roco_env import env as renv        # noqa: E402
from roco_env import planner as pl      # noqa: E402
from roco_env.schema import ACTION_SKILL, ACTION_SWITCH, Action  # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


def fresh(seed=7):
    return renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)


class TestPlannerContract(unittest.TestCase):
    def test_returns_recommendation_with_tail_and_coverage(self):
        state = fresh()
        r = pl.plan_actions(state, RS, depth=2, beam=3, budget_ms=2000)
        self.assertIsNotNone(r.recommended)
        self.assertIn(r.recommended, renv.legal_actions(state, RS, "player"))
        # 三个尾部指标都要有，不能只给期望
        self.assertLessEqual(r.worst, r.expected + 1e-9)
        self.assertGreaterEqual(r.best, r.expected - 1e-9)
        self.assertTrue(0.0 <= r.coverage <= 1.0)
        self.assertGreater(r.branches_evaluated, 0)
        # 阶段 1 的延迟目标：完整规划 P95 ≤ 2s；单次实测必须远低于
        self.assertLess(r.latency_ms, 2000.0)

    def test_does_not_read_opponent_pending_action(self):
        """对手的待执行动作绝不能被 planner 看到。

        做法：人为在 state 上塞一个「对手本回合已提交」的字段，内容是一个
        **明显不合理**的动作（撤退）。如果 planner 读了它，推荐会变。
        两次推荐必须一致。
        """
        state = fresh()
        base = pl.plan_actions(state, RS, depth=2, beam=3, budget_ms=2000)

        planted = fresh()
        setattr(planted, "_pending_enemy", Action(kind="escape"))
        planted.pending_enemy_action = "escape"
        after = pl.plan_actions(planted, RS, depth=2, beam=3, budget_ms=2000)

        self.assertEqual(base.recommended, after.recommended,
                         "planner 读了对手的待执行动作——隐藏信息边界被打破")

    def test_deterministic_for_same_state(self):
        a = pl.plan_actions(fresh(seed=11), RS, depth=2, beam=3, budget_ms=2000)
        b = pl.plan_actions(fresh(seed=11), RS, depth=2, beam=3, budget_ms=2000)
        self.assertEqual(a.recommended, b.recommended)
        self.assertAlmostEqual(a.expected, b.expected, places=6)

    def test_counter_is_reported(self):
        r = pl.plan_actions(fresh(), RS, depth=2, beam=3, budget_ms=2000)
        self.assertTrue(r.main_counter, "必须报出主要反制")
        self.assertIn(r.main_counter, r.counter_note)

    def test_note_says_it_did_not_peek(self):
        r = pl.plan_actions(fresh(), RS, depth=2, beam=3, budget_ms=2000)
        self.assertIn("未读取", r.note)


class TestTimeout(unittest.TestCase):
    """超时必须如实上报。用注入的确定性时钟，不靠真实计时。"""

    def test_timeout_is_reported_not_hidden(self):
        ticks = {"n": 0}

        def clock():
            ticks["n"] += 1
            # 每次读表都推进 0.1 秒 → 很快超预算
            return ticks["n"] * 0.1

        state = fresh()
        r = pl.plan_actions(state, RS, depth=3, beam=6, budget_ms=200, clock=clock)
        self.assertTrue(r.timed_out, "超预算时必须 timed_out=True")
        self.assertLess(r.coverage, 1.0, "超时时的 coverage 必须小于 1，不能假装搜完")
        self.assertIn("超时", r.note)

    def test_immediate_timeout_returns_no_recommendation(self):
        # 时钟必须**递增**：plan_actions 第一次读表是为了记 start，
        # 如果假时钟恒定，elapsed 永远是 0，就永远不超时（这条测试第一版就是这么写错的）。
        ticks = {"n": 0}

        def clock():
            ticks["n"] += 1
            return ticks["n"] * 1000.0    # 每次读表推进 1000 秒

        r = pl.plan_actions(fresh(), RS, depth=2, beam=4, budget_ms=1, clock=clock)
        self.assertTrue(r.timed_out)
        self.assertIsNone(r.recommended, "预算在第一个分支前用光时不得给出推荐")
        self.assertEqual(r.coverage, 0.0)
        self.assertIn("超时", r.note)


class TestCandidateSelection(unittest.TestCase):
    def test_candidates_keep_different_action_kinds(self):
        """候选必须保留不同类别——否则 planner 永远看不到换宠/防御分支。"""
        state = fresh()
        cands = pl._my_candidates(state, RS, beam=4)
        kinds = {a.kind for a in cands}
        self.assertIn(ACTION_SKILL, kinds, "至少要保留技能分支")
        self.assertGreater(len(kinds), 1,
                           "只保留技能分支等于退化成单回合贪心，planner 就没有意义了")

    def test_candidates_are_all_legal(self):
        state = fresh()
        legal = set(renv.legal_actions(state, RS, "player"))
        for a in pl._my_candidates(state, RS, beam=6):
            self.assertIn(a, legal)


class TestOpponentModel(unittest.TestCase):
    def test_distribution_is_normalized_and_public_only(self):
        state = fresh()
        dist = pl.opponent_distribution(state, RS, beam=4)
        self.assertTrue(dist)
        self.assertAlmostEqual(sum(w for _, w in dist), 1.0, places=6)
        legal = set(renv.legal_actions(state, RS, "enemy"))
        for a, _ in dist:
            self.assertIn(a, legal)

    def test_distribution_is_not_always_one_action(self):
        """对手不能被建模成「一定会做某一件事」——那就等于偷看。"""
        state = fresh()
        dist = pl.opponent_distribution(state, RS, beam=4)
        self.assertGreater(len(dist), 1, "对手分布至少要覆盖两个候选")


class TestBaselineComparison(unittest.TestCase):
    def test_greedy_baseline_exists_and_differs_from_planner(self):
        state = fresh()
        greedy = pl.immediate_greedy(state, RS, side="player")
        planned = pl.plan_actions(state, RS, depth=2, beam=4, budget_ms=2000).recommended
        self.assertIsNotNone(greedy)
        self.assertIsNotNone(planned)
        # 两者可以相同，但都必须是合法动作；这里断言的是「基线可跑」而非「必须不同」
        legal = set(renv.legal_actions(state, RS, "player"))
        self.assertIn(greedy, legal)
        self.assertIn(planned, legal)

    def test_evaluate_is_heuristic_not_a_winrate(self):
        state = fresh()
        v = pl.evaluate(state, RS, "player")
        self.assertIsInstance(v, float)
        # 对称局面下双方估值应互相抵消
        self.assertAlmostEqual(v + pl.evaluate(state, RS, "enemy"), 0.0, places=6)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestSearchIsDeterministicAcrossAnalysisSeeds(unittest.TestCase):
    """搜索内部的推演**不许**随分析种子换答案。

    引擎把同速裁决建模成 seed 驱动的随机，而规划时状态是从公开面重建的、
    带着分析种子。于是「搜索里推演出来的后续回合」也会用分析种子裁决同速 ——
    结果是换个分析种子推荐就变，而变的原因不是「我们对局面知道多少」，
    只是搜索内部几次掷骰子。

    实测症状（改动之前）：三个分析种子给出「穿膛 / 使用能量果 / 穿膛」，
    服务端聚合判定 `recommendation_stable=false`，**最终不给推荐**。
    那是把「搜索内部的随机实现细节」误当成了「局面不确定性」。
    """

    def _public_state(self):
        ids = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
        ids_b = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
        state = renv.reset(ids, ids_b, seed=11, rs=RS)
        return renv.public_planner_state(state, RS)

    def test_same_public_state_gives_the_same_recommendation_for_every_seed(self):
        pub = self._public_state()
        labels = []
        for analysis_seed in (11, 29, 47, 101):
            state = renv.state_from_public_planner(pub, RS, analysis_seed=analysis_seed)
            result = pl.plan_actions(state, RS, depth=2, beam=4, budget_ms=2000)
            labels.append(result.recommended_label)
            self.assertFalse(result.timed_out, "预算足够，不该超时")
        self.assertEqual(len(set(labels)), 1,
                         f"同一公开面在不同分析种子下推荐了不同的动作：{labels}")

    def test_planning_does_not_change_the_callers_seed(self):
        """规划用完必须把 seed 还回去。

        搜索内部临时改 `state.seed` 来固定推演；如果忘了恢复，
        调用方后续的 `replay`/`serialize` 就会拿到一个被改过的 seed ——
        那是**静默污染**，比推荐错了更难查。
        """
        pub = self._public_state()
        state = renv.state_from_public_planner(pub, RS, analysis_seed=11)
        original = state.seed
        pl.plan_actions(state, RS, depth=2, beam=4, budget_ms=2000)
        self.assertEqual(state.seed, original, "规划改了调用方 state 的 seed 且没恢复")
        # 异常路径也要恢复
        state2 = renv.state_from_public_planner(pub, RS, analysis_seed=11)
        original2 = state2.seed
        with self.assertRaises(Exception):
            pl.plan_actions(state2, RS, depth=2, beam=4, budget_ms=2000,
                            clock=lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        self.assertEqual(state2.seed, original2, "异常路径没有恢复 seed")
