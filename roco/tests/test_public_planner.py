"""公开 planner state 与隐藏信息边界（MC-013）的反证测试。

这一组测试是为了回答一个问题：**教练规划时能不能利用真实对局 seed？**
答案必须是不能。做法不是「我们保证不读」，而是把它变成会失败的检查：

  1. 公开 schema 里**没有** seed / pending / 对手后备血量这些字段
  2. 任何深度、任何位置的 `seed` 都被隐藏信息检测拒绝（没有例外）
  3. **同一公开观察 + 不同真实内部 seed → 请求内容与推荐必须一致**
     （如果推荐随真实 seed 变化，就说明真实 seed 漏进去了）
  4. 真实 seed 只影响对局内同速裁决；分析用与它无关的 analysis seeds，
     并跨种子聚合，所以结论是区间而不是单点

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env.service import RocoService, find_hidden_keys  # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


class TestPublicSchemaHasNoSecrets(unittest.TestCase):
    def test_schema_carries_no_seed_pending_or_bench_detail(self):
        for seed in (3, 17, 999):
            st = renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)
            pub = renv.public_planner_state(st, RS)
            blob = json.dumps(pub, ensure_ascii=False)
            for forbidden in ("seed", "pending", "_pending", "rng", "random"):
                self.assertNotIn(forbidden, blob,
                                 f"公开 planner state 里出现了 {forbidden}（seed={seed}）")

    def test_opponent_bench_exposes_only_public_facts(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        for entry in pub["opponent"]["bench"]:
            self.assertEqual(set(entry.keys()), {"slot", "pet_id", "fainted"},
                             "对手后备只应有位次/id/是否倒下；血量与配招是隐藏信息")
        # 场上那只的面板是公开的（屏幕上就写着）
        field = pub["opponent"]["field"]
        self.assertIn("hp", field)
        self.assertIn("energy", field)

    def test_assumptions_are_declared(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertIn("assumptions", pub)
        self.assertIn("opponent_bench", pub["assumptions"])


class TestHiddenKeyDetectionHasNoException(unittest.TestCase):
    """任何深度、任何位置的 seed 都必须被拒。上一版给 state.seed 开了后门，已移除。"""

    def test_seed_rejected_at_every_depth(self):
        cases = [
            {"seed": 1},
            {"state": {"seed": 1}},
            {"state": {"foo": {"seed": 1}}},
            {"state": {"history": [{"seed": 9}]}},
            {"public": {"seed": 1}},
            {"public": {"self": {"pets": [{"seed": 1}]}}},
            {"analysis": {"rng_seed": 3}},
            {"deep": {"a": {"b": {"c": {"random_seed": 7}}}}},
        ]
        for payload in cases:
            hits = find_hidden_keys(payload)
            self.assertTrue(hits, f"隐藏信息检测漏了：{payload}")

    def test_pending_opponent_action_rejected(self):
        for payload in ({"state": {"_pending_enemy": {}}},
                        {"state": {"pending_enemy_action": {}}},
                        {"_pending_player": {}}):
            self.assertTrue(find_hidden_keys(payload), f"漏了 {payload}")

    def test_clean_public_payload_passes(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertEqual(find_hidden_keys({"public": pub, "state_version": pub["state_version"]}), [])


class TestRealSeedCannotLeak(unittest.TestCase):
    """核心反证：真实内部 seed 不影响规划请求，也不影响推荐。"""

    def test_public_state_is_identical_across_internal_seeds(self):
        a = renv.public_planner_state(renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS), RS)
        b = renv.public_planner_state(renv.reset(A_TEAM, A_TEAM, seed=12345, rs=RS), RS)
        # 除了 state_version（会随事件推进）以外，公开信息应当完全一致
        a.pop("state_version", None)
        b.pop("state_version", None)
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False),
                         "不同真实 seed 的公开观察不一致——说明有内部信息泄进了公开 schema")

    def test_recommendation_identical_across_internal_seeds(self):
        svc = RocoService()
        results = []
        for seed in (7, 12345, 999):
            st = renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)
            pub = renv.public_planner_state(st, RS)
            status, env = svc.battle_plan({
                "public": pub, "state_version": pub["state_version"],
                "depth": 2, "beam": 3, "analysis_seeds": [11, 29],
            })
            self.assertEqual(status, 200)
            self.assertTrue(env["ok"])
            r = env["result"]
            # 只比**实质规划结果**。不要整对象比较：result 里带 state_version，
            # 那一项会随事件推进而变化，跟 seed 泄漏无关（我第一版就是这么假红的）。
            results.append(json.dumps({
                "recommended_stable": r["recommendation_stable"],
                "labels_by_seed": r["recommended_by_seed"],
                "expected": r["expected"],
                "worst": r["worst"],
                "main_counter": r["main_counter"],
                "branches": r["branches_evaluated"],
                "per_seed_labels": [p["recommended_label"] for p in r["per_seed"]],
                "per_seed_expected": [round(p["expected"], 6) for p in r["per_seed"]],
            }, sort_keys=True, ensure_ascii=False))
        self.assertEqual(len(set(results)), 1,
                         "推荐随真实内部 seed 变化——真实 seed 被利用了")

    def test_reconstruction_uses_analysis_seed_not_real_seed(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=777, rs=RS)
        pub = renv.public_planner_state(st, RS)
        back = renv.state_from_public_planner(pub, RS, analysis_seed=4242)
        self.assertEqual(back.seed, 4242)
        self.assertNotEqual(back.seed, 777, "重建状态不能沿用真实对局 seed")


class TestServiceRejectsPrivateState(unittest.TestCase):
    def test_private_serialize_is_refused_because_of_seed(self):
        svc = RocoService()
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        status, env = svc.battle_plan({"state": renv.serialize(st),
                                       "state_version": st.state_version})
        self.assertEqual(status, 400)
        self.assertEqual(env["error_type"], "hidden_information")
        self.assertIn("seed", env["error"])

    def test_plan_without_public_is_a_clear_bad_request(self):
        svc = RocoService()
        status, env = svc.battle_plan({"state_version": 0})
        self.assertEqual(status, 400)
        self.assertIn("public", env["error"])

    def test_aggregation_reports_a_range_not_a_point(self):
        svc = RocoService()
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        pub = renv.public_planner_state(st, RS)
        status, env = svc.battle_plan({"public": pub, "state_version": pub["state_version"],
                                       "depth": 2, "beam": 3,
                                       "analysis_seeds": [1, 2, 3, 4]})
        self.assertEqual(status, 200)
        r = env["result"]
        self.assertEqual(r["analysis_seeds"], [1, 2, 3, 4])
        exp = r["expected"]
        self.assertLessEqual(exp["min"], exp["max"], "期望值必须给区间而不是单点")
        self.assertIn("worst", r)
        # limitations 必须说明这不是胜率、且随机性与真实 seed 无关
        joined = " ".join(env["limitations"])
        self.assertIn("不是胜率", joined)
        self.assertIn("真实 seed", joined)


if __name__ == "__main__":
    unittest.main(verbosity=2)
