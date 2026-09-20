"""本地对局驱动端点与两个信任域的边界测试。

这一组测试回答一个问题：**为了演示而新增的私有端点，有没有把教练侧的信息边界放松？**

答案必须是没有，而且要有反证：

  1. ``/battle/new|legal|advance`` 能完整驱动一局（这是演示页的地基）；
  2. 三个端点显式声明 ``trust_domain: "local_sim"``，回执里也带这句话；
  3. 私有状态里**确实**有真实 seed，而它产出的公开面里**没有** seed；
  4. 把私有状态递给教练端点 ``/battle/plan``，**仍然**被拒（400 hidden_information）。
     第 4 条是这一组里最重要的一条：如果它绿不了，说明信任域的声明变成了
     全局后门，而不只是新端点自己的性质；
  5. 教练域里 ``state.seed`` / ``state.foo.seed`` 照旧一律被拒（没有例外）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_sim_endpoints -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env.service import (              # noqa: E402
    PRIVATE_TRUST_DOMAIN,
    RocoService,
    find_hidden_keys,
)

RS = rdata.load_ruleset()
RULESET_ID = RS.ruleset_id
TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
BASE = {"ruleset_id": RULESET_ID}


#: 对局可能的结果。`escaped` 是逃跑成功——它是**正常结果**，不是错误；
#: `random_legal` 策略真的会逃，所以这里必须包含它，否则测试会把自己的策略当成 bug。
RESULTS = ("win", "loss", "draw", "escaped")


def open_match(svc, seed=7, strategy="greedy_damage"):
    status, env = svc.battle_new({
        **BASE, "state_version": 0, "team": TEAM, "seed": seed, "strategy": strategy,
    })
    assert status == 200 and env["ok"], f"开局失败：{status} {env.get('error')}"
    return env["result"]


def play_out(svc, seed=7, strategy="greedy_damage", max_advances=500):
    """用先手合法动作把一局打完，返回 (最后一次 result, 推进次数)。"""
    result = open_match(svc, seed=seed, strategy=strategy)
    advances = 0
    for _ in range(max_advances):
        if result["result"]:
            break
        if result["phase"] == "replace":
            switch = [a for a in result["legal"]["player"] if a["kind"] == "switch"]
            assert switch, "补位阶段必须有换人动作"
            action = {"kind": "switch", "target_index": switch[0]["target_index"]}
        else:
            first = result["legal"]["player"][0]
            action = {k: v for k, v in first.items()
                      if k in ("kind", "skill_id", "target_index", "item_id")}
        status, env = svc.battle_advance({
            **BASE, "state_version": result["state_version"],
            "state": result["state"], "action": action, "strategy": strategy,
        })
        assert status == 200 and env["ok"], f"推进失败：{status} {env.get('error')}"
        result = env["result"]
        advances += 1
    return result, advances


def play_out_auto(svc, seed=7, strategy="greedy_damage", player_strategy="greedy_damage",
                  max_advances=400):
    """两边都交给策略，自动打完一局。用 `player_strategy` 而不是手挑动作。"""
    result = open_match(svc, seed=seed, strategy=strategy)
    advances = 0
    while not result["result"] and advances < max_advances:
        status, env = svc.battle_advance({
            **BASE, "state_version": result["state_version"], "state": result["state"],
            "strategy": strategy, "player_strategy": player_strategy,
        })
        assert status == 200 and env["ok"], f"推进失败：{status} {env.get('error')}"
        result = env["result"]
        advances += 1
    return result, advances


class TestSimEndpointsDriveAMatch(unittest.TestCase):
    def setUp(self):
        self.svc = RocoService()

    def test_new_returns_private_state_public_face_and_legal_actions(self):
        result = open_match(self.svc)
        self.assertEqual(result["trust_domain"], PRIVATE_TRUST_DOMAIN)
        self.assertEqual(result["phase"], "battle")
        self.assertEqual(result["turn"], 1)
        self.assertIsNone(result["result"])
        # 私有面
        self.assertIn("seed", result["state"])
        self.assertEqual(result["state"]["seed"], 7)
        # 公开面
        self.assertIn("public", result)
        self.assertNotIn("seed", json.dumps(result["public"]))
        # 双方合法动作都带人类可读标签（页面要渲染按钮）
        for side in ("player", "enemy"):
            self.assertTrue(result["legal"][side], f"{side} 应当有合法动作")
            for action in result["legal"][side]:
                self.assertIn("label", action)
                self.assertTrue(action["label"])
        labels = [a["label"] for a in result["legal"]["player"]]
        self.assertIn("撤退", labels, "合法动作里应当能看到撤退")

    def test_full_match_reaches_a_result_without_errors(self):
        result, advances = play_out(self.svc)
        self.assertIn(result["result"], RESULTS)
        self.assertGreater(advances, 5, "一局不该几步就结束")
        self.assertGreater(result["turn"], 1)

    def test_advance_reports_the_events_of_that_turn(self):
        result = open_match(self.svc)
        first = result["legal"]["player"][0]
        action = {k: v for k, v in first.items()
                  if k in ("kind", "skill_id", "target_index", "item_id")}
        status, env = self.svc.battle_advance({
            **BASE, "state_version": result["state_version"], "state": result["state"], "action": action,
        })
        self.assertEqual(status, 200)
        self.assertTrue(env["ok"])
        self.assertEqual(env["result"]["event"], "battle_advance")
        self.assertTrue(env["result"]["events"], "推进后应当有本回合事件")
        self.assertEqual(env["result"]["state_version"], env["result"]["state"]["state_version"])

    def test_illegal_action_is_rejected_not_guessed(self):
        result = open_match(self.svc)
        status, env = self.svc.battle_advance({
            **BASE, "state_version": result["state_version"], "state": result["state"],
            "action": {"kind": "skill", "skill_id": "skill_does_not_exist"},
        })
        self.assertEqual(status, 400)
        self.assertFalse(env["ok"])
        self.assertEqual(env["error_type"], "bad_request")
        self.assertIsNone(env["result"])

    def test_unknown_strategy_is_rejected_by_name(self):
        status, env = self.svc.battle_new({
            **BASE, "state_version": 0, "team": TEAM, "strategy": "not_a_strategy",
        })
        self.assertEqual(status, 400)
        self.assertIn("未知策略", env["error"])
        # 报错里要列出可选项，调用方不必去翻代码
        self.assertIn("greedy_damage", env["error"])

    def test_missing_state_is_bad_request(self):
        status, env = self.svc.battle_legal({**BASE, "state_version": 0})
        self.assertEqual(status, 400)
        self.assertIn("state", env["error"])

    def test_all_five_strategies_can_drive_a_match(self):
        """五种对手策略都能把一局打完，且**不靠手挑动作**。

        用 `player_strategy` 让两边都由策略驱动：以前这条测试用「玩家总选第一个
        合法动作」推进，`conservative_switch` 会跟它无限僵持（600 步还没结束）——
        那是测试的推进方式有问题，不是策略有问题。让双方都按策略出招，
        对局才会自然收敛。
        """
        from roco_env import opponents as opp

        for entry in opp.list_strategies():
            name = entry["name"]
            result, advances = play_out_auto(self.svc, seed=3, strategy=name)
            self.assertIn(result["result"], RESULTS,
                          f"策略 {name} 没有把对局打完（advances={advances}）")
            self.assertGreater(advances, 0)


class TestTrustDomainBoundary(unittest.TestCase):
    """新增私有端点之后，教练侧的边界必须一条都没松。"""

    def setUp(self):
        self.svc = RocoService()

    def test_private_state_is_still_rejected_by_the_coach_endpoint(self):
        result = open_match(self.svc)
        private = result["state"]
        self.assertIn("seed", private)          # 它确实是私有状态
        status, env = self.svc.battle_plan({**BASE, "state_version": 0, "public": private})
        self.assertEqual(status, 400)
        self.assertEqual(env["error_type"], "hidden_information")
        self.assertIsNone(env["result"])
        self.assertIn("seed", env["error"])

    def test_public_face_of_the_same_match_is_accepted_by_the_coach_endpoint(self):
        """对照组：同一局的**公开面**必须能规划。

        没有这条，「私有状态被拒」也可能只是因为端点根本没接上。
        """
        result = open_match(self.svc)
        status, env = self.svc.battle_plan({
            **BASE, "state_version": 0, "public": result["public"],
            "depth": 1, "beam": 2, "analysis_seeds": [11],
        })
        self.assertEqual(status, 200, env.get("error"))
        self.assertTrue(env["ok"])
        self.assertIsNotNone(env["result"])

    def test_seed_rejected_at_every_depth_in_the_coach_domain(self):
        for payload in ({"seed": 1}, {"state": {"seed": 1}},
                        {"state": {"foo": {"seed": 1}}},
                        {"state": {"history": [{"seed": 9}]}}):
            self.assertTrue(find_hidden_keys(payload), f"漏了 {payload}")

    def test_private_domain_does_not_leak_into_other_endpoints(self):
        """私有域只是那三个端点自己的性质，不是服务级别的开关。"""
        result = open_match(self.svc)
        private = result["state"]
        # 规则查询：body 里带私有状态 → 仍然被拒（它不在私有域白名单里）
        status, env = self.svc.rules_query({
            **BASE, "state_version": 0, "kind": "pet", "pet_id": TEAM[0], "extra": private,
        })
        self.assertEqual(status, 400)
        self.assertEqual(env["error_type"], "hidden_information")
        # 阵容评估同理
        status, env = self.svc.team_evaluate({
            **BASE, "state_version": 0, "team": TEAM, "state": private,
        })
        self.assertEqual(status, 400)
        self.assertEqual(env["error_type"], "hidden_information")


if __name__ == "__main__":
    unittest.main()
