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
from roco_env import env as env_mod         # noqa: E402
from roco_env import effects as fx          # noqa: E402
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


class TestCapabilitiesMatchTheWiring(unittest.TestCase):
    """能力声明必须与实际接线一致（F02 回归发现三个端点被报成 false）。"""

    def setUp(self):
        self.svc = RocoService()

    def test_declared_capabilities_match_the_reachable_endpoints(self):
        from roco_env.service import CAPABILITIES

        # 声明为 true 的，必须真的能在不报错的情况下答上来
        self.assertTrue(CAPABILITIES["team.evaluate"], "阵容评估已接上规则 baseline")
        self.assertTrue(CAPABILITIES["team.compare"])
        self.assertTrue(CAPABILITIES["battle.plan"])
        status, env = self.svc.team_evaluate({**BASE, "state_version": 0, "team": TEAM})
        self.assertEqual(status, 200)
        self.assertTrue(env["ok"])
        # 换人对比要求两支队伍**只差一只**（服务端就是这么校验的）
        other = RS.pets_by_name("雪影娃娃")[0].pet_id
        status, env = self.svc.team_compare({**BASE, "state_version": 0,
                                            "team_before": TEAM, "team_after": [TEAM[0], TEAM[1], other]})
        self.assertEqual(status, 200, env.get("error"))
        self.assertTrue(env["ok"])

    def test_health_reports_the_same_capabilities(self):
        env = self.svc.health()
        caps = env["result"]["capabilities"]
        from roco_env.service import CAPABILITIES
        self.assertEqual(caps, CAPABILITIES, "/health 里的能力表必须就是服务声明的那张表")

    def test_unimplemented_endpoint_is_501_not_404(self):
        """"还没做"与"地址写错了"必须分得开。"""
        from roco_env.service import NOT_IMPLEMENTED

        self.assertIn("/battle/summary", NOT_IMPLEMENTED, "至少要有一条真实未实现的能力，否则 501 不可达")
        status, env = self.svc.not_implemented("/battle/summary", {**BASE, "state_version": 0})
        self.assertEqual(status, 501)
        self.assertEqual(env["error_type"], "not_implemented")
        self.assertEqual(env["coverage"], 0.0)
        self.assertIsNone(env["result"])
        self.assertEqual(env["unsupported"][0]["code"], "battle_summary")
        # 对照组：真的不存在的路径仍然是 404
        status, env = self.svc.unknown_path("/no/such/thing")
        self.assertEqual(status, 404)
        self.assertEqual(env["error_type"], "not_found")


class TestPlanCoverageIsHonest(unittest.TestCase):
    """F02 回归发现：只有换人可做时 branches=0、timed_out=False、coverage=1.0，三个字段互相矛盾。"""

    def test_replace_phase_plan_is_actually_evaluated(self):
        """补位局面必须真的被算过。

        F02 回归发现：补位时每个 rollout 都因 `step_joint` 抛异常被丢弃，
        于是 branches_evaluated=0、timed_out=False、coverage=1.0，
        而推荐其实来自 `_safe_step` 失败后原样返回的状态（等于没算）。
        现在补位走 `step_replace`（补位是公开信息，枚举对手的换人是合法的）。
        """
        from roco_env import env as env_mod
        from roco_env import planner as pm

        st = env_mod.reset(TEAM, TEAM, seed=11, rs=RS)
        st.player.pets[0].hp = 0
        st.player.pets[0].fainted = True
        st.phase = "replace"
        st.replace_queue = ["player"]
        plan = pm.plan_actions(st, RS, depth=2, beam=3, budget_ms=2000)
        self.assertFalse(plan.timed_out, "没超时就说没超时")
        self.assertIsNotNone(plan.recommended, "补位局面必须给出一个换人候选")
        self.assertEqual(plan.dropped_branches, {},
                         f"补位分支不该被丢弃（丢弃原因：{plan.dropped_branches}）")
        self.assertIsNotNone(plan.expected)
        # 补位局面里对手分布是有内容的（对手也要换人），所以覆盖率不该是 0
        self.assertGreater(plan.coverage, 0.0)
        payload = plan.to_dict()
        for key in ("branches_evaluated", "no_counter_branches", "dropped_branches", "coverage", "timed_out"):
            self.assertIn(key, payload, f"回执里必须有 {key}，否则看的人分不清「搜完了」与「没算」")

    def test_normal_battle_reports_real_branches_and_full_coverage(self):
        from roco_env import env as env_mod
        from roco_env import planner as pm

        st = env_mod.reset(TEAM, TEAM, seed=11, rs=RS)
        plan = pm.plan_actions(st, RS, depth=2, beam=3, budget_ms=5000)
        self.assertGreater(plan.branches_evaluated, 0)
        self.assertEqual(plan.no_counter_branches, 0, "正常对局里对手分布不为空")
        self.assertAlmostEqual(plan.coverage, 1.0, places=6)
        self.assertFalse(plan.timed_out)
        # 回执里必须同时能看到三个字段，别只给一个 coverage
        payload = plan.to_dict()
        for key in ("branches_evaluated", "no_counter_branches", "coverage", "timed_out"):
            self.assertIn(key, payload)


class TestBuffDamageWiring(unittest.TestCase):
    """属性增减**有没有接进伤害**（程序不变量），以及**倍率是不是手游真值**（不知道）。

    监工复核时的硬性要求，这一组按它写：

      已证实、可以断言的是**程序接线与生命周期**：
        · 零 buff 与旧基线逐字节一致（改了公式不许悄悄挪动基线）；
        · 正/负增减**单调**；
        · 增减只生效**一次**（重复计入会让倍率平方）；
        · 防御减伤只在声明的回合窗口内生效、下一回合清除；
        · 按动作记录 replay 完全确定（同一记录两次结果一致）；
        · 事件仍然带 `formula_verified: false`。

      **不能**断言成「手游真值」的是：
        · 「+100% 恰好等于 ×2」；
        · 攻防增减是相加还是相乘；
        · 减伤百分比与结算时机。
      这些属 `COMMUNITY_HYPOTHESIS_V1`（MC-010/011/020），没有一手来源。
      所以下面的断言分成两组：一组只用**关系**（单调、一次、清零），
      另一组显式对齐**社区假设模型**，并在名字里写明它验证的是模型自洽而非官方机制。
    """

    def setUp(self):
        self.rs = RS

    def _pure(self, st, side):
        return [a for a in env_mod.legal_actions(st, self.rs, side)
                if a.kind == "skill" and not self.rs.skills[a.skill_id].is_status
                and not self.rs.skills[a.skill_id].is_defense]

    def _state(self, **buffs):
        st = env_mod.reset(TEAM, TEAM, seed=11, rs=self.rs)
        for key, value in buffs.items():
            if key.startswith("foe_"):
                st.enemy.field_pet.buffs[key[4:]] = value
            else:
                st.player.field_pet.buffs[key] = value
        return st

    def _player_damage(self, st):
        env_mod.step_joint(st, self.rs, self._pure(st, "player")[0], self._pure(st, "enemy")[0])
        hits = [e for e in st.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertTrue(hits, "纯攻击对纯攻击必须产生一次我方伤害事件")
        return hits[0].detail

    # ── 组 ①：程序接线与生命周期（这些是事实，可以强断言）──────────────

    def test_zero_buff_keeps_the_old_baseline(self):
        """没有任何增减时，伤害必须与「接线之前的历史基线」一致。

        基线值 130 是从**接线之前的代码**上跑出来的（`诡刺` 40 威力、
        属性 ×2、本系 ×1.5、面板 210.7 对 174.4）。它记在这里的意义是：
        改动只许在「有 buff」时生效，不许把零 buff 的基线一起挪走。
        """
        detail = self._player_damage(self._state())
        self.assertEqual(detail["damage"], 130, "零 buff 的基线被动过了")
        self.assertEqual(detail["damage_model"], "community-hypothesis-v1")
        self.assertIs(detail["formula_verified"], False, "伤害公式仍未核验，这个标记不能变成 true")

    def test_buff_effects_are_monotone(self):
        base = self._player_damage(self._state())["damage"]
        up = self._player_damage(self._state(atk=60))["damage"]
        up_more = self._player_damage(self._state(atk=120))["damage"]
        down = self._player_damage(self._state(atk=-30))["damage"]
        self.assertGreater(up, base)
        self.assertGreater(up_more, up)
        self.assertLess(down, base)
        # 守方物防：升防伤害更低、降防伤害更高
        guarded = self._player_damage(self._state(foe_def=50))["damage"]
        exposed = self._player_damage(self._state(foe_def=-40))["damage"]
        self.assertLess(guarded, base)
        self.assertGreater(exposed, base)

    def test_buff_is_applied_exactly_once(self):
        """增益只许进公式一次。

        判据：把伤害拆回「未加成面板」再乘上模型自己的预言系数，
        应当等于实际伤害。若增益被算了两次，实际值会是预言的平方量级。
        """
        st = self._state(atk=100)
        detail = self._player_damage(st)
        predicted_multiplier = fx.buff_damage_multiplier({"atk": 100}, {})
        baseline = self._player_damage(self._state())["damage"]
        self.assertAlmostEqual(detail["damage"] / baseline, predicted_multiplier, delta=0.02,
                               msg="实际倍率与模型预言不符——说明增益被算了不止一次")
        self.assertAlmostEqual(detail["damage"] / baseline, 2.0, delta=0.02,
                               msg="社区假设模型下 +100% 预言 ×2（**这是假设，不是手游真值**）")

    def test_opponent_own_buffs_do_not_change_my_damage(self):
        base = self._player_damage(self._state())["damage"]
        self.assertEqual(self._player_damage(self._state(foe_atk=100))["damage"], base,
                         "对手的物攻增益不该影响我打它的伤害（方向写错会在这里红）")

    def test_defense_reduction_only_lasts_the_declared_turn(self):
        """防御减伤只在使用的那个回合有效，下一回合必须清零。

        这里**不**断言减伤的具体比例（那是未核验的游戏语义），
        只断言「上一回合设进去的值不会活到下一回合」这个生命周期不变量。
        """
        st = self._state()
        setattr(st.player.field_pet, "_defense_reduction", 0.7)
        env_mod.step_joint(st, self.rs, self._pure(st, "player")[0], self._pure(st, "enemy")[0])
        self.assertEqual(getattr(st.player.field_pet, "_defense_reduction", 0.0), 0.0,
                         "上一回合的防御减伤活到了下一回合")

    def test_replay_is_deterministic_through_the_real_record_format(self):
        """按动作记录 replay 必须完全确定，且回放出来的伤害同样带未核验标记。

        **不在这里手工设 buff。** `replay` 是从 `reset(seed)` 重新开始的，
        只重放记录里的**动作**；手工预置的状态不在记录里，回放自然对不上
        （我第一版就是手工设 buff 再断言事件一致，红得很对：那不是 replay 的输入）。
        属性增减的正确来源是**状态技能**，它会作为动作进记录，所以能正常重放。
        """
        actions = []
        st = env_mod.reset(TEAM, TEAM, seed=11, rs=self.rs)
        for _ in range(6):
            if st.result:
                break
            mine = self._pure(st, "player")
            theirs = self._pure(st, "enemy")
            if not mine or not theirs:
                break
            actions.append([mine[0].to_dict(), theirs[0].to_dict()])
            env_mod.step_joint(st, self.rs, mine[0], theirs[0])
        self.assertTrue(actions, "至少要推进一回合")
        record = {"team": list(TEAM), "enemy_team": list(TEAM), "seed": 11,
                  "loadouts": {k: list(v) for k, v in st.player.loadouts.items()},
                  "actions": actions}
        first = env_mod.replay(record, self.rs)
        second = env_mod.replay(record, self.rs)
        self.assertEqual(env_mod.serialize(first), env_mod.serialize(second),
                         "同一记录回放两次结果不一致")
        self.assertEqual([e.to_dict() for e in first.events], [e.to_dict() for e in st.events],
                         "回放的事件序列与原局不一致")
        for event in first.events:
            if event.kind == "damage":
                self.assertIs(event.detail.get("formula_verified"), False,
                              "回放出来的伤害事件也必须带未核验标记")

    def test_status_skill_buff_reaches_damage_and_survives_replay(self):
        """状态技能写的属性增减：既进伤害，也能被回放。

        用**配招**把「力量增效」（自己获得物攻+100%，能耗 1）放进队伍。
        直接改 `pet.buffs` 不行：`replay` 从 `reset(seed)` 重新开始，
        手工预置的状态不在记录里（我第一版就是这么写的，红得对）。
        """
        loadouts = {TEAM[0]: ["skill_000271"] + [s for s in self.rs.candidate_moveset(TEAM[0])
                                                  if s != "skill_000271"][:3]}
        st = env_mod.reset(TEAM, TEAM, seed=3, rs=self.rs, loadouts=loadouts)
        buff_action = [a for a in env_mod.legal_actions(st, self.rs, "player")
                       if a.skill_id == "skill_000271"]
        self.assertTrue(buff_action, "力量增效（能耗 1）在开局就该是合法动作")
        enemy_action = self._pure(st, "enemy")[0]
        env_mod.step_joint(st, self.rs, buff_action[0], enemy_action)
        self.assertEqual(st.player.field_pet.buffs.get("atk"), 100,
                         "状态技能写的物攻+100% 必须落在 PetState 上")

        # 记录里**必须**带 loadouts：合法动作按配招枚举，缺了它 reset 会退回
        # 规范配招，「力量增效」就不再合法（这正是 replay 缺 loadouts 那个 bug）。
        record = {"team": list(TEAM), "enemy_team": list(TEAM), "seed": 3,
                  "loadouts": {k: list(v) for k, v in st.player.loadouts.items()},
                  "actions": [[buff_action[0].to_dict(), enemy_action.to_dict()]]}
        replayed = env_mod.replay(record, self.rs)
        self.assertEqual(replayed.player.field_pet.buffs.get("atk"), 100,
                         "回放没有复原状态技能造成的属性增减")
        self.assertEqual([e.to_dict() for e in replayed.events],
                         [e.to_dict() for e in st.events],
                         "回放的事件序列与原局不一致")
        for event in replayed.events:
            if event.kind == "damage":
                self.assertIs(event.detail.get("formula_verified"), False)

    # ── 组 ②：与社区假设模型对齐（验证模型自洽，**不**声称手游真值）─────

    def test_matches_the_community_hypothesis_model(self):
        """实际伤害倍率与 `COMMUNITY_HYPOTHESIS_V1` 的折算一致。

        这条证明的是「模型被正确实现」，**不是**「手游就是这么算的」——
        两者差一次 microcase 实测。名字与断言都按这个口径写。
        """
        base = self._player_damage(self._state())["damage"]
        for kw in ({"atk": 60}, {"atk": -30}, {"foe_def": 50}, {"foe_def": -60}):
            with self.subTest(**kw):
                st = self._state(**kw)
                detail = self._player_damage(st)
                attacker = {"atk": kw["atk"]} if "atk" in kw else {}
                defender = {"def": kw["foe_def"]} if "foe_def" in kw else {}
                predicted = fx.buff_damage_multiplier(attacker, defender)
                self.assertAlmostEqual(detail["damage"] / base, predicted, delta=0.02)
                self.assertIs(detail["formula_verified"], False)


class TestReplayCarriesLoadouts(unittest.TestCase):
    """E04 的确定性回放：记录必须自带配招。

    `replay()` 只传了 team / enemy_team / seed 时，`reset()` 会退回**规范配招**；
    而合法动作是按配招枚举的（一只精灵只带 4 个技能）。于是用非规范配招打出来的
    记录回放时会抛「行动不合法」——这不是「回放不稳定」，是**记录不完整**。
    这个 bug 是写「状态技能增减能否重放」的测试时撞出来的。
    """

    def setUp(self):
        self.rs = RS

    def test_match_with_nonstandard_loadout_replays(self):
        from roco_env import opponents as ropp

        team_a = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
        team_b = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
        # 换成非规范配招：把「力量增效」塞进第一只
        loadouts = {team_a[0]: ["skill_000271", "skill_000750", "skill_000576", "skill_000744"]}
        record = ropp.play_match(self.rs, team_a, team_b, "greedy_damage", "greedy_damage",
                                 seed=5, loadouts=loadouts)
        # replay_plan() 必须带上配招
        self.assertIn("loadouts", record.replay_plan(), "replay_plan 必须带 loadouts")
        state = env_mod.replay(record.replay_plan(), self.rs)
        self.assertEqual(state.turn, record.total_turns, "回放的回合数与记录不符")
        self.assertEqual(state.result,
                         {"player": "win", "enemy": "loss", "draw": "draw",
                          "escaped": "escaped"}.get(record.winner, state.result))

    def test_replay_without_loadouts_is_rejected_rather_than_silently_wrong(self):
        """反证：记录里少了配招时，回放要**抛错**，不能悄悄换一套配招算出一局假的。"""
        action = {"kind": "skill", "skill_id": "skill_000271"}   # 只在非规范配招里
        enemy = {"kind": "skill", "skill_id": "skill_000286"}
        record = {"team": list(TEAM), "enemy_team": list(TEAM), "seed": 3,
                  "actions": [[action, enemy]]}
        with self.assertRaises(ValueError) as ctx:
            env_mod.replay(record, self.rs)
        self.assertIn("不合法", str(ctx.exception),
                      "缺配招时应当明确报「行动不合法」，而不是换一套配招继续算")
