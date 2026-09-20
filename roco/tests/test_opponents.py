"""对手策略池（S01）的测试。

本文件要守住的是三条**结构性**性质，而不是「策略表现好不好」：

  1. **隐藏信息纪律**：策略只能读自己的 observation。这里不满足于「断言它
     没偷看」，而是用一个专门的越界策略去**撞**边界，确认越界真的会失败
     并留下记录。策略拿不到 state，所以偷看没有入口。
  2. **确定性**：同一 (seed, turn) 必得同一手；不同 seed 允许不同。
  3. **合法性**：策略的返回值必须来自 legal_actions，从不自己构造动作。

用标准库 unittest（本机 Python 3.9 没有 pytest，项目不允许加依赖）：

    cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import opponents as ropp        # noqa: E402
from roco_env.schema import (                 # noqa: E402
    ACTION_ESCAPE, ACTION_SKILL, Action, observation_for,
)

RS = rdata.load_ruleset()

# A 组六只（MC-014…019 的那六只）：本模块只用它们，因为引擎对它们有逐条的特性核验记录
A_GROUP = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
PETS = [RS.pets_by_name(n)[0].pet_id for n in A_GROUP]
TEAM_A = PETS[:3]
TEAM_B = PETS[3:]

ropp.bind_ruleset(RS)


def fresh(seed=7, team_a=None, team_b=None):
    return renv.reset(team_a or TEAM_A, team_b or TEAM_B, seed=seed, rs=RS)


def action_sets(seed=7):
    """(observation, legal_actions) —— 每个策略都会被喂这一对。"""
    state = fresh(seed=seed)
    obs = observation_for(state, RS, "player")
    return obs, renv.legal_actions(state, RS, "player")


class TestRegistry(unittest.TestCase):
    """注册表：调用方要能列出名字与版本。"""

    def test_exactly_five_named_by_behaviour(self):
        names = ropp.STRATEGIES.names()
        self.assertEqual(names, [
            "random_legal", "greedy_damage", "conservative_switch",
            "status_control", "shallow_search",
        ])
        # 名字必须描述行为，不能是名次
        for banned in ("best", "strong", "t0", "top", "s_tier", "meta"):
            for name in names:
                self.assertNotIn(banned, name.lower())

    def test_every_strategy_has_name_and_version(self):
        for entry in ropp.list_strategies():
            self.assertTrue(entry["name"])
            self.assertIsInstance(entry["version"], int)
            self.assertGreaterEqual(entry["version"], 1)
            self.assertTrue(entry["note"], f"{entry['name']} 需要一行行为说明")

    def test_registry_does_not_rank_strategies(self):
        blob = json.dumps(ropp.describe_registry(), ensure_ascii=False)
        self.assertIn("不按强弱排序", blob)
        for word in ("胜率", "T0", "最强"):
            self.assertNotIn(word, blob)

    def test_unknown_strategy_fails_loudly(self):
        with self.assertRaises(KeyError):
            ropp.get_strategy("no_such_strategy")

    def test_ruleset_must_be_bound(self):
        import threading
        box = {}

        def run():
            try:
                ropp.get_strategy("greedy_damage").act(
                    observation_for(fresh(), RS, "player"),
                    renv.legal_actions(fresh(), RS, "player"), 1, 1)
            except Exception as exc:      # noqa: BLE001 - 这里就是要看它抛什么
                box["exc"] = exc

        thread = threading.Thread(target=run)
        thread.start()
        thread.join()
        self.assertIsInstance(box.get("exc"), ropp.RulesetNotBound)


class TestHiddenInformationBoundary(unittest.TestCase):
    """MC-013 不变量：策略看不到对手的待执行动作、后备血量、真实种子。

    「不可能」是这样做到的：策略函数只拿到一个按 observation **实际存在的键**
    逐层构造的白名单代理，拿不到 state。下面的测试分三层证明它：

      A. 越界读取**现在就会失败**（不是将来可能失败）
      B. 越界的尝试会被记账，合格值是 0 次
      C. 正常跑完 25 组配对，一次越界都没有
    """

    def test_observation_has_no_hidden_keys_to_begin_with(self):
        obs = observation_for(fresh(), RS, "player")
        blob = repr(obs)
        for hidden in ("_pending", "enemy_action", "pending_player", "seed"):
            self.assertNotIn(hidden, blob)
        # 区分场上与后备：对手**场上**那只的面板是公开的（血条/能量/异常画在屏幕上），
        # 后备的才隐藏。这一区分是 2026-09-21 修正的——原来的实现连场上那只都不给面板，
        # 那是真 bug（教练无法判断「这一击够不够收」）。
        for pet in obs["opponent"]["pets"]:
            if pet.get("field"):
                for visible in ("hp", "max_hp", "energy", "statuses", "marks"):
                    self.assertIn(visible, pet, "对手场上面板是公开信息：" + visible)
                for hidden in ("buffs", "loadouts", "charge", "defense_cooldown"):
                    self.assertNotIn(hidden, pet, "对手场上也不该暴露：" + hidden)
            else:
                for hidden in ("hp", "max_hp", "energy", "buffs", "statuses", "marks"):
                    self.assertNotIn(hidden, pet, "对手后备不该暴露 " + hidden)

    def test_forbidden_read_raises_and_is_recorded(self):
        """A+B：越界读取必须立刻失败，并留下路径。"""
        ropp.reset_hidden_reads()
        obs = observation_for(fresh(), RS, "player")
        view = ropp.wrap_observation(obs, "probe", 1)

        # 对手**后备**的血量：观察里根本没有这个键（场上那只是公开的，不能拿它当反例）
        with self.assertRaises(KeyError):
            view.opponent.pets[1].hp
        # 对手的配招：公开信息里没有
        with self.assertRaises(KeyError):
            view.opponent.pets[0].loadouts
        # 代理自己的内部状态：不是 observation 的一部分
        with self.assertRaises(KeyError):
            view._raw
        with self.assertRaises(KeyError):
            view.__dict__

        self.assertEqual(ropp.hidden_read_snapshot().get("probe"), 4)
        self.assertEqual(len(ropp.hidden_read_paths()), 4)
        self.assertIn("opponent.pets[1].hp", ropp.hidden_read_paths())

    def test_cheating_strategy_is_impossible(self):
        """一个专门去偷看的策略必须**拿不到**任何东西。"""
        grabs = []

        def _cheater(obs, legal, rng):
            for attempt in (
                lambda: obs.opponent.pets[1].hp,          # 后备血量（属性读取）
                lambda: obs["_pending_enemy"],            # 对手待执行动作（下标读取）
                lambda: obs.__dict__,                     # 代理内部状态
                lambda: obs["opponent"]["pets"][0]["loadouts"],   # 对手配招
            ):
                try:
                    grabs.append(attempt())
                except (KeyError, AttributeError) as exc:
                    grabs.append(type(exc).__name__)
            return legal[0]

        cheating = ropp.Strategy("cheater", 1, _cheater, "测试用：专门越界读取")
        ropp.reset_hidden_reads()
        state = fresh()
        obs = observation_for(state, RS, "player")
        legal = renv.legal_actions(state, RS, "player")
        chosen = cheating.act(obs, legal, seed=1, turn=1)

        self.assertIn(chosen, legal, "即使偷看失败，返回的动作仍必须合法")
        self.assertEqual(grabs, ["KeyError", "KeyError", "KeyError", "KeyError"],
                         "四种偷看手段都必须失败")
        self.assertEqual(ropp.hidden_read_snapshot().get("cheater"), 4)
        self.assertNotIn("'hp'", repr(grabs))

    def test_nested_view_has_no_get_either(self):
        """嵌套视图也不能靠 .get() 把「没有」洗成 None。"""
        obs = observation_for(fresh(), RS, "player")
        view = ropp.wrap_observation(obs, "probe3", 1)
        with self.assertRaises(KeyError):
            view.self.pets[0].buffs.get("atk")

    def test_view_has_no_anonymous_key_lookup(self):
        """代理**没有** get()：匿名取键会把「没有」和「不允许」混成一个返回值。"""
        obs = observation_for(fresh(), RS, "player")
        view = ropp.wrap_observation(obs, "probe2", 1)
        self.assertNotIn("get", ropp._VIEW_METHODS)
        with self.assertRaises(KeyError):
            view["_pending_enemy"]          # 匿名取键没有后门

    def test_strategy_receives_only_the_observation_object(self):
        """策略签名里只有 (obs, legal, rng)：没有 state、没有 rs、没有对手动作。"""
        import inspect
        for strategy in ropp.STRATEGIES:
            params = list(inspect.signature(strategy.decide).parameters)
            self.assertEqual(params, ["obs", "legal", "rng"], strategy.name)

    def test_no_pair_ever_reads_a_hidden_field(self):
        """C：真正跑 25 组配对，隐藏读取次数必须是 0。"""
        ropp.reset_hidden_reads()
        for name_a in ropp.STRATEGIES.names():
            for name_b in ropp.STRATEGIES.names():
                ropp.play_match(RS, TEAM_A, TEAM_B, name_a, name_b, seed=11)
        self.assertEqual(ropp.hidden_read_snapshot(), {},
                         "有策略碰了限制字段：" + json.dumps(
                             ropp.hidden_read_snapshot(), ensure_ascii=False))
        self.assertEqual(ropp.hidden_read_paths(), [])


class TestDeterminism(unittest.TestCase):
    """确定性：同一 (seed, turn) 必得同一手；不读时钟、不用全局 random。"""

    def test_same_seed_same_action_for_every_strategy(self):
        obs, legal = action_sets(seed=7)
        for strategy in ropp.STRATEGIES:
            first = strategy.act(copy.deepcopy(obs), legal, seed=99, turn=3)
            second = strategy.act(copy.deepcopy(obs), legal, seed=99, turn=3)
            self.assertEqual(first, second, strategy.name)

    def test_turn_is_part_of_the_seed(self):
        """(seed, turn) 都是输入：换 turn 允许换手，但必须仍是合法动作。"""
        obs, legal = action_sets(seed=7)
        for strategy in ropp.STRATEGIES:
            for turn in (1, 2, 3):
                self.assertIn(strategy.act(copy.deepcopy(obs), legal, 5, turn), legal,
                              strategy.name)

    def test_deterministic_strategies_ignore_seed_entirely(self):
        """四个非随机策略不该因为 seed 变了就换手——它们没有随机性可用。"""
        obs, legal = action_sets(seed=7)
        for name in ("greedy_damage", "conservative_switch", "status_control", "shallow_search"):
            strategy = ropp.get_strategy(name)
            picks = {strategy.act(copy.deepcopy(obs), legal, seed=s, turn=1)
                     for s in range(1, 12)}
            self.assertEqual(len(picks), 1, f"{name} 应当与 seed 无关")

    def test_random_legal_actually_varies_with_seed(self):
        """对照组要真的随机，否则「随机基线」是假的。"""
        obs, legal = action_sets(seed=7)
        strategy = ropp.get_strategy("random_legal")
        picks = {strategy.act(copy.deepcopy(obs), legal, seed=s, turn=1)
                 for s in range(40)}
        self.assertGreater(len(picks), 1)

    def test_whole_match_is_reproducible(self):
        a = ropp.play_match(RS, TEAM_A, TEAM_B, "shallow_search", "status_control", seed=21)
        b = ropp.play_match(RS, TEAM_A, TEAM_B, "shallow_search", "status_control", seed=21)
        self.assertEqual(a.to_dict(), b.to_dict())

    def test_match_replays_through_the_engine(self):
        """记录必须能交给 env.replay() 重放，且结果一致。"""
        record = ropp.play_match(RS, TEAM_A, TEAM_B, "greedy_damage",
                                 "conservative_switch", seed=4)
        state = renv.replay(record.replay_plan(), RS)
        self.assertEqual(state.result, {"player": "win", "enemy": "loss",
                                        "draw": "draw"}.get(record.winner, state.result))
        self.assertEqual(state.turn, record.total_turns)


class TestLegality(unittest.TestCase):
    """策略只从 legal_actions 里挑，从不自己构造动作。"""

    def test_every_strategy_returns_a_member_of_legal(self):
        for seed in (1, 2, 3, 5, 8, 13):
            state = fresh(seed=seed)
            obs = observation_for(state, RS, "player")
            legal = renv.legal_actions(state, RS, "player")
            for strategy in ropp.STRATEGIES:
                chosen = strategy.act(obs, legal, seed, state.turn)
                self.assertIn(chosen, legal, f"{strategy.name} @seed={seed}")
                self.assertTrue(any(chosen is a for a in legal),
                                "必须是 legal 里的同一个动作对象")

    def test_illegal_return_is_rejected(self):
        """越过 legal 的返回值必须当场炸，而不是被静默接受。"""
        bogus = Action(ACTION_SKILL, skill_id="skill_does_not_exist")
        bad = ropp.Strategy("bad", 1, lambda obs, legal, rng: bogus, "测试用")
        obs, legal = action_sets()
        with self.assertRaises(AssertionError):
            bad.act(obs, legal, seed=1, turn=1)

    def test_empty_legal_set_is_an_error_not_an_invention(self):
        obs, _legal = action_sets()
        with self.assertRaises(ValueError):
            ropp.get_strategy("random_legal").act(obs, [], 1, 1)

    def test_replacement_phase_only_switches(self):
        """补位局面：策略只能选换人。"""
        state = fresh()
        state.enemy.pets[0].hp = 0
        state.enemy.pets[0].fainted = True
        state.player.pets[0].hp = 0
        state.player.pets[0].fainted = True
        state.phase = "replace"
        state.replace_queue = ["player", "enemy"]
        legal = renv.legal_actions(state, RS, "player")
        obs = observation_for(state, RS, "player")
        for strategy in ropp.STRATEGIES:
            chosen = strategy.act(obs, legal, seed=2, turn=state.turn)
            self.assertIn(chosen, legal, strategy.name)
            self.assertTrue(chosen.kind == "switch", strategy.name)


class TestMatchRecord(unittest.TestCase):
    """记录里必须能查出「谁打的、什么版本、什么数据、打成了什么」。"""

    def setUp(self):
        self.record = ropp.play_match(RS, TEAM_A, TEAM_B, "status_control",
                                      "shallow_search", seed=9)

    def test_identifies_both_strategies_with_version(self):
        d = self.record.to_dict()
        self.assertEqual(d["strategies"]["player"]["name"], "status_control")
        self.assertEqual(d["strategies"]["enemy"]["name"], "shallow_search")
        self.assertEqual(d["strategies"]["player"]["version"],
                         ropp.get_strategy("status_control").version)
        self.assertEqual(d["strategies"]["enemy"]["version"],
                         ropp.get_strategy("shallow_search").version)

    def test_identifies_ruleset_and_snapshot(self):
        d = self.record.to_dict()
        self.assertEqual(d["ruleset_id"], RS.ruleset_id)
        self.assertEqual(d["snapshot_fingerprint"], RS.snapshot_fingerprint())
        self.assertEqual(len(d["snapshot_fingerprint"]), 64)

    def test_records_loadouts_and_teams(self):
        d = self.record.to_dict()
        self.assertEqual(d["team_a"], TEAM_A)
        self.assertEqual(d["team_b"], TEAM_B)
        for pid in PETS:
            self.assertIn(pid, d["loadouts"])
            self.assertTrue(d["loadouts"][pid], f"{pid} 的配招不能为空")

    def test_result_is_a_known_verdict(self):
        self.assertIn(self.record.winner, ("player", "enemy", "draw", "escaped", "unfinished"))
        self.assertGreater(self.record.turns, 0)
        self.assertFalse(self.record.truncated)

    def test_per_turn_actions_and_observation_hashes(self):
        d = self.record.to_dict()
        # actions 含补位步骤，所以条数 >= 战斗回合数；观察哈希只在战斗回合产生
        self.assertGreaterEqual(len(d["actions"]), self.record.battle_turns)
        self.assertEqual(len(d["observation_trace"]), self.record.battle_turns)
        self.assertGreaterEqual(self.record.turns, self.record.battle_turns)
        for entry in d["observation_trace"]:
            self.assertTrue(entry["player_obs_hash"])
            self.assertTrue(entry["enemy_obs_hash"])

    def test_record_is_json_serializable_and_roundtrips(self):
        d = self.record.to_dict()
        text = json.dumps(d, ensure_ascii=False)
        back = ropp.MatchRecord.from_dict(json.loads(text))
        self.assertEqual(back.to_dict(), d)

    def test_matches_end_and_do_not_stall(self):
        """每局都必须有一个明确结局，且不撞回合上限、不停滞。"""
        winners = set()
        for seed in range(12):
            record = ropp.play_match(RS, TEAM_A, TEAM_B, "greedy_damage",
                                     "conservative_switch", seed=seed)
            self.assertIsNone(record.error, f"seed={seed}: {record.error}")
            self.assertFalse(record.truncated, f"seed={seed} 撞上回合上限")
            self.assertLess(record.turns, 300)
            self.assertIn(record.winner, ("player", "enemy", "draw"))
            winners.add(record.winner)
        # 谁赢是引擎的事；这里只断言「有结局」。胜负分布属于先导报告，
        # 而且**不能**当成强度结论——见 run_pilot.py 的免责声明。
        self.assertEqual(winners & {"player", "enemy", "draw"}, winners)


class TestStrategiesDiffer(unittest.TestCase):
    """五个策略要真的不同，否则「策略池」是自欺。

    只断言「行为不同」，**不**断言谁更好——本项目没有天梯数据。
    """

    def _decision_trace(self, name, seed=17):
        """让某策略真打完一局，记录它每一手选了什么（种子相同、局面相同）。"""
        strategy = ropp.get_strategy(name)
        state = fresh(seed=seed)
        ropp.bind_ruleset(RS)
        trace = []
        for _ in range(120):
            if state.result or state.phase == "replace":
                break
            pool = ropp._pool(state, RS, "player")
            obs = observation_for(state, RS, "player")
            action = strategy.act(obs, pool, seed, state.turn)
            trace.append(str(action.to_dict()))
            enemy = ropp.get_strategy("random_legal").act(
                observation_for(state, RS, "enemy"), ropp._pool(state, RS, "enemy"),
                seed, state.turn)
            renv.step_joint(state, RS, action, enemy)
        return trace

    def test_strategies_behave_differently_across_a_game(self):
        traces = {name: self._decision_trace(name) for name in ropp.STRATEGIES.names()}
        distinct = {tuple(v) for v in traces.values()}
        self.assertGreaterEqual(
            len(distinct), 4,
            "至少四种不同的决策序列，实际：" + json.dumps(traces, ensure_ascii=False))
        for name, trace in traces.items():
            self.assertTrue(trace, f"{name} 的决策序列不能为空")

    def test_conservative_switch_switches_when_badly_off(self):
        """把场上那只削到残血，保守策略应当换人（或至少不空过）。"""
        state = fresh()
        state.player.field_pet.hp = 1
        # 让后备看起来明显更能扛
        obs = observation_for(state, RS, "player")
        legal = renv.legal_actions(state, RS, "player")
        chosen = ropp.get_strategy("conservative_switch").act(obs, legal, 3, state.turn)
        self.assertIn(chosen, legal)
        self.assertIn(chosen.kind, ("switch", "item"))

    def test_status_control_prefers_a_control_skill_when_available(self):
        """显式给一套含状态技能的配招，状态策略应当优先用它。"""
        pid = PETS[0]
        from roco_env import parse as rparse
        pool = sorted(RS.learnsets[pid].all_skill_ids)
        controls = [sid for sid in pool
                    if RS.skills[sid].is_status
                    and rparse.parse_skill(RS.skills[sid]).fully_supported]
        if not controls:
            self.skipTest("该精灵没有解析器完全支持的状态技能，无法构造该局面")
        attacks = [sid for sid in pool if RS.skills[sid].is_attack and RS.skills[sid].power]
        self.assertTrue(attacks)
        loadouts = {pid: tuple(controls[:1] + attacks[:3]),
                    PETS[1]: RS.candidate_moveset(PETS[1]),
                    PETS[2]: RS.candidate_moveset(PETS[2])}
        state = renv.reset(TEAM_A, TEAM_B, seed=3, rs=RS, loadouts=loadouts)
        state.player.field_pet.energy = 6
        obs = observation_for(state, RS, "player")
        legal = renv.legal_actions(state, RS, "player")
        chosen = ropp.get_strategy("status_control").act(obs, legal, 3, state.turn)
        self.assertEqual(chosen.kind, ACTION_SKILL)
        self.assertTrue(RS.skills[chosen.skill_id].is_status,
                        "有可用的控制技能时应当先挂状态")

    def test_greedy_damage_prefers_the_bigger_attack(self):
        state = fresh()
        state.player.field_pet.energy = 6
        obs = observation_for(state, RS, "player")
        legal = renv.legal_actions(state, RS, "player")
        chosen = ropp.get_strategy("greedy_damage").act(obs, legal, 3, state.turn)
        self.assertIn(chosen.kind, (ACTION_SKILL, "switch", "item"))

    def test_status_control_skips_mechanics_the_engine_cannot_settle(self):
        """未核验效果不能被反复选中。

        真实事故：两个 `status_control` 都在用「取念」（描述是「每回合随机变成
        敌方任意精灵的技能」，解析器明确标注未覆盖），结果是 300 回合的僵局——
        双方各用一次 0 能耗的空技能。策略必须把「引擎不知道」当成降权信号。
        """
        from roco_env import parse as rparse
        pid = PETS[1]                     # 海豹船长：配招里就有「取念」
        pool = sorted(RS.learnsets[pid].all_skill_ids)
        unresolved = [sid for sid in pool
                      if not RS.skills[sid].is_attack
                      and any(m in (RS.skills[sid].desc or "")
                              for m in rparse.UNPARSED_MARKERS)]
        if not unresolved:
            self.skipTest("该精灵没有未覆盖的非攻击技能，无法构造该局面")
        attacks = [sid for sid in pool
                   if RS.skills[sid].is_attack and RS.skills[sid].power
                   and RS.skills[sid].energy <= 2]
        if not attacks:
            self.skipTest("该精灵没有入场能量下可用的攻击技能")
        loadout = {pid: tuple(unresolved[:1] + attacks[:1]),
                   PETS[0]: RS.candidate_moveset(PETS[0]),
                   PETS[2]: RS.candidate_moveset(PETS[2])}
        state = renv.reset([pid, PETS[0], PETS[2]], [pid, PETS[0], PETS[2]],
                           seed=5, rs=RS, loadouts=loadout)
        # 入场能量是 2（假设，见 env.reset），所以攻击必须是这个能耗下真的能用的，
        # 否则「转输出」这条路根本不存在，测试会误报。
        had_attack = any(a.kind == ACTION_SKILL and RS.skills[a.skill_id].is_attack
                         for a in renv.legal_actions(state, RS, "player"))
        self.assertTrue(had_attack, "配招里需要一个当前能量下可用的攻击技能")
        obs = observation_for(state, RS, "player")
        legal = renv.legal_actions(state, RS, "player")
        chosen = ropp.get_strategy("status_control").act(obs, legal, 5, state.turn)
        self.assertNotEqual(chosen.skill_id, unresolved[0],
                            "未核验的技能不该被优先选中")
        self.assertTrue(RS.skills[chosen.skill_id].is_attack,
                        "没有可用的控制时应当转输出，而不是空转")

    def test_mirror_match_does_not_stall(self):
        """两支相同队伍、同一策略也必须走到结局，不能靠空技能互相僵住。"""
        pid = PETS[1]
        team = [pid, PETS[0], PETS[2]]
        record = ropp.play_match(RS, team, team, "status_control", "status_control", seed=20261224)
        self.assertFalse(record.truncated, "镜像对局不该撞上回合上限")
        self.assertIn(record.winner, ("player", "enemy", "draw"))
        self.assertLess(record.turns, 300)

    def test_random_legal_never_returns_escape_when_escape_is_not_offered(self):
        """跑对局时我们把「撤退」从候选里去掉（见 opponents._pool）。"""
        state = fresh()
        pool = ropp._pool(state, RS, "player")
        self.assertNotIn(ACTION_ESCAPE, {a.kind for a in pool})
        self.assertTrue(pool)
        self.assertIn(ACTION_ESCAPE, {a.kind for a in renv.legal_actions(state, RS, "player")},
                      "引擎本身仍然提供撤退，去掉它只是运行设置")


if __name__ == "__main__":
    unittest.main(verbosity=2)
