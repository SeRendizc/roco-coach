"""E04 / E05 的验收不变量。

E04 的验收原文是「固定 seed 的 100 条回放逐事件一致；终止后不能继续行动」；
E05 是「随机 1,000 场无非法状态；双方 observation 泄漏测试为 0」。
这个文件把四条都变成会变红的断言，而不是写在文档里的一句话。

**为什么值得单独一个文件**：回放与不变量是「引擎能不能被信任」的地基 ——
数值对不对是另一回事（那要靠实测），但「同一记录重放两次结果一样」和
「对局结束后不能再行动」是引擎自己必须保证的。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import team as rteam          # noqa: E402
from roco_env.schema import (               # noqa: E402
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SKILL,
    ACTION_SWITCH,
    Action,
)

RS = rdata.load_ruleset()
ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]
ROSTER_IDS = [RS.pets_by_name(n)[0].pet_id for n in ROSTER]


#: 策略名列表。`ropp.STRATEGIES` 是一个注册表对象，不是 dict/list，
#: 所以统一用 `names()` —— 第一版直接拿它迭代，结果把 Strategy 对象当键用了。
NAMES = list(ropp.STRATEGIES.names())


def observation_leaks(obs) -> list:
    """observation 里出现了隐藏信息就返回命中的路径。

    用**字符串扫描**而不是读字段：后者只能查到我记得去查的字段，
    而泄漏往往出现在我没想到的新字段上（这一条是踩过的）。
    """
    import json
    blob = json.dumps(obs, ensure_ascii=False)
    hits = []
    for forbidden in ("_pending_", "seed", "replace_queue", "_respond_", "hidden"):
        if forbidden in blob:
            hits.append(forbidden)
    return hits


class TestReplayDeterminism(unittest.TestCase):
    """E04：固定 seed 的 100 条回放逐事件一致。"""

    def test_one_hundred_fixed_seed_replays_are_event_identical(self):
        seeds = list(range(1000, 1100))
        compared = 0
        for i, seed in enumerate(seeds):
            team_a = [ROSTER_IDS[i % 12], ROSTER_IDS[(i + 1) % 12], ROSTER_IDS[(i + 2) % 12]]
            team_b = [ROSTER_IDS[(i + 3) % 12], ROSTER_IDS[(i + 4) % 12], ROSTER_IDS[(i + 5) % 12]]
            strat_a = NAMES[i % len(NAMES)]
            strat_b = NAMES[(i + 2) % len(NAMES)]
            record = ropp.play_match(RS, team_a, team_b, strat_a, strat_b, seed=seed)
            plan = record.replay_plan()
            first = renv.replay(plan, RS)
            second = renv.replay(plan, RS)
            self.assertEqual(
                [e.to_dict() for e in first.events],
                [e.to_dict() for e in second.events],
                f"seed={seed} 两次回放的事件序列不一致",
            )
            self.assertEqual(renv.serialize(first), renv.serialize(second),
                             f"seed={seed} 两次回放的最终状态不一致")
            compared += 1
        self.assertEqual(compared, 100, "必须真的跑满 100 条")

    def test_replay_reproduces_the_match_result(self):
        """回放出来的结局必须与记录一致 —— 否则 replay 只是「能跑」而不是「能复现」。"""
        for i, seed in enumerate((2001, 2002, 2003)):
            record = ropp.play_match(RS, ROSTER_IDS[0:3], ROSTER_IDS[3:6],
                                     "greedy_damage", "shallow_search", seed=seed)
            state = renv.replay(record.replay_plan(), RS)
            expected = {"player": "win", "enemy": "loss", "draw": "draw",
                        "escaped": "escaped"}.get(record.winner, state.result)
            self.assertEqual(state.result, expected, f"seed={seed} 回放结局与记录不符")
            self.assertEqual(state.turn, record.total_turns, f"seed={seed} 回合数不符")
            self.assertFalse(record.truncated, f"seed={seed} 这一局被截断了，换一个种子")


class TestTerminalStateIsClosed(unittest.TestCase):
    """E04：终止后不能继续行动。"""

    def _finished_state(self):
        st = renv.reset(ROSTER_IDS[0:3], ROSTER_IDS[3:6], seed=31, rs=RS)
        for _ in range(200):
            if st.result:
                break
            if st.phase == "replace":
                queue = renv.needs_replacement(st)
                for side in queue:
                    legal = [a for a in renv.legal_actions(st, RS, side) if a.kind == ACTION_SWITCH]
                    if legal:
                        renv.step_replace(st, RS, side, int(legal[0].target_index))
                continue
            mine = renv.legal_actions(st, RS, "player")
            theirs = renv.legal_actions(st, RS, "enemy")
            if not mine or not theirs:
                break
            renv.step_joint(st, RS, mine[0], theirs[0])
        return st

    def test_finished_match_has_no_legal_actions(self):
        st = self._finished_state()
        self.assertIsNotNone(st.result, "这一局没打完，测试前提不成立")
        for side in ("player", "enemy"):
            self.assertEqual(renv.legal_actions(st, RS, side), [],
                             f"对局已结束，{side} 不该还有合法动作")

    def test_step_after_finish_raises(self):
        st = self._finished_state()
        action = Action(ACTION_SKILL, skill_id="skill_000750")
        with self.assertRaises(ValueError):
            renv.step_joint(st, RS, action, action)


class TestRandomInvariants(unittest.TestCase):
    """E05：随机对局里不许出现非法状态。"""

    def test_no_illegal_state_in_randomised_matches(self):
        import random

        rng = random.Random(20260921)
        checked = 0
        for i in range(120):
            team_a = rng.sample(ROSTER_IDS, 3)
            team_b = rng.sample(ROSTER_IDS, 3)
            strat_a = rng.choice(NAMES)
            strat_b = rng.choice(NAMES)
            st = renv.reset(team_a, team_b, seed=rng.randrange(1, 10 ** 6), rs=RS)
            ropp.bind_ruleset(RS)
            a, b = ropp.get_strategy(strat_a), ropp.get_strategy(strat_b)
            for _ in range(120):
                if st.result:
                    break
                if st.phase == "replace":
                    queue = renv.needs_replacement(st)
                    if not queue:
                        break
                    for side in queue:
                        legal = [x for x in renv.legal_actions(st, RS, side) if x.kind == ACTION_SWITCH]
                        if not legal:
                            continue
                        action = a.act(renv.observe(st, RS, side), legal, 1, st.turn) \
                            if side == "player" else b.act(renv.observe(st, RS, side), legal, 1, st.turn)
                        renv.step_replace(st, RS, side, int(action.target_index))
                    continue
                lp = renv.legal_actions(st, RS, "player")
                le = renv.legal_actions(st, RS, "enemy")
                if not lp or not le:
                    break
                ap = a.act(renv.observe(st, RS, "player"), lp, 1, st.turn)
                ae = b.act(renv.observe(st, RS, "enemy"), le, 1, st.turn)
                self.assertIn(ap, lp, "策略给了非法动作")
                self.assertIn(ae, le, "策略给了非法动作")
                renv.step_joint(st, RS, ap, ae)

                # 不变量：生命/能量范围、倒下标记一致、队伍引用完整
                for side in (st.player, st.enemy):
                    for pet in side.pets:
                        self.assertGreaterEqual(pet.hp, 0, "生命不能为负")
                        self.assertLessEqual(pet.hp, pet.max_hp, "生命不能超过上限")
                        self.assertGreaterEqual(pet.energy, 0, "能量不能为负")
                        self.assertLessEqual(pet.energy, renv.ENERGY_MAX, "能量不能超过上限")
                        self.assertEqual(pet.fainted, pet.hp <= 0,
                                         "倒下标记必须与生命一致")
                        self.assertIn(pet.pet_id, RS.pets, "队伍引用了不存在的精灵")
                    self.assertEqual(len(side.pets), 3, "队伍必须始终是 3 只")
                checked += 1
        self.assertGreater(checked, 200, "至少检查 200 个回合状态")


class TestObservationDoesNotLeak(unittest.TestCase):
    """E05：双方 observation 泄漏测试为 0。"""

    def test_observations_never_contain_hidden_fields(self):
        import random

        rng = random.Random(7)
        leaks = []
        for _ in range(60):
            team_a = rng.sample(ROSTER_IDS, 3)
            team_b = rng.sample(ROSTER_IDS, 3)
            st = renv.reset(team_a, team_b, seed=rng.randrange(1, 10 ** 6), rs=RS)
            for side in ("player", "enemy"):
                hits = observation_leaks(renv.observe(st, RS, side))
                if hits:
                    leaks.append((side, hits))
            # 打几个回合，让状态技能/印记也进来
            for _ in range(4):
                if st.result or st.phase == "replace":
                    break
                lp = renv.legal_actions(st, RS, "player")
                le = renv.legal_actions(st, RS, "enemy")
                if not lp or not le:
                    break
                renv.step_joint(st, RS, lp[0], le[0])
            for side in ("player", "enemy"):
                hits = observation_leaks(renv.observe(st, RS, side))
                if hits:
                    leaks.append((side, hits))
        self.assertEqual(leaks, [], f"observation 泄漏了隐藏信息：{leaks[:3]}")

    def test_public_planner_state_never_contains_hidden_fields(self):
        from roco_env import service as svc

        leaks = []
        for i, seed in enumerate(range(3000, 3060)):
            team_a = [ROSTER_IDS[i % 12], ROSTER_IDS[(i + 1) % 12], ROSTER_IDS[(i + 2) % 12]]
            st = renv.reset(team_a, ROSTER_IDS[0:3], seed=seed, rs=RS)
            pub = renv.public_planner_state(st, RS)
            hits = observation_leaks(pub)
            if hits or svc.find_hidden_keys(pub):
                leaks.append((seed, hits, svc.find_hidden_keys(pub)))
        self.assertEqual(leaks, [], f"公开 planner state 泄漏：{leaks[:3]}")


if __name__ == "__main__":
    unittest.main()
