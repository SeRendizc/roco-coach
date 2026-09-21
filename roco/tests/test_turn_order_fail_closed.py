"""RC-103：回合顺序与回合末的**登记表** + 未知顺序 fail closed。

判据（每条都有必红方向，反证就写在同一条用例里或紧邻那条）：

  1. **登记表是引擎行为的如实快照**：legacy 的 `turn_order` 声明等于代码里真的在做的
     那件事（respond → priority → speed；平手 = seed 随机，如实登记为工程权宜）；
  2. **回合末按配置声明的阶段顺序结算**，不是按代码里写死的顺序
     （把声明反过来的那份配置必须真的把事件顺序也反过来）；
  3. 配置声明里**多一个**（引擎不认识的）阶段、或**少一个**（引擎要结算的）阶段
     → `fx.UnsupportedEffect`，消息点名阶段与配置 id，不静默跳过、不退回默认顺序；
  4. `speed_tie` 是 UNKNOWN（null）且真的出现平手 → 抛错；**没有平手时不抛**
     —— 证明它不是「一律抛」；
  5. **legacy 默认路径逐位不变**：改动前抓下来的状态/事件 sha256 指纹必须仍然相同。

第 5 条是这份文件存在的主要理由：前四条都是**新**行为，只有它能把「新行为没顺手改掉
旧行为」变成一条会变红的断言（既有 275 条测试是回归网，golden 指纹是网上的牙齿）。

运行：cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest
from dataclasses import replace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import effects as fx          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import rule_config as rc      # noqa: E402
from roco_env.schema import (               # noqa: E402
    ACTION_ESCAPE,
    ACTION_SKILL,
    ACTION_SWITCH,
    Action,
)

RS = rdata.load_ruleset()

#: 与 `test_replay_invariants.py` 同一份名单：这里只借它跑「固定 seed 的整局」，
#: 不把任何一只精灵的数值写死进断言。
ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]
ROSTER_IDS = [RS.pets_by_name(n)[0].pet_id for n in ROSTER]

#: 改动前（RC-103 之前的引擎 + 当时的 legacy 配置）抓下来的逐位指纹。
#: 抓法：固定 seed 的 6 局 `opponents.play_match` → `env.replay` → serialize 的 sha256，
#: 外加一段 4 回合的固定动作序列。**这六个数就是「默认路径没变」的判据本体**。
GOLDEN_STATE_DIGESTS = {
    "1000": "17643bea171d411561ebaea9b494d64381105732e432ebda0e5e0e56af4f83f6",
    "1001": "0c218971216b86a713ea3f94af49e0a43ecd14d92b53cc73cda9dbff2cebab55",
    "1002": "cd4d136fbdbc0bf0714db7b082d9cd160dd84e7f164afb74e1dbead455fe8895",
    "1003": "ab3dd5f379783dee763cb185b5555e19b1c5112cdbe748fedd2bb6f8e7870554",
    "1004": "7453cecc1037d7a510d62ce28406e2082b33c5c26354e4a9de8607a4894de87a",
    "1005": "ece1377e831fc414e812604a4a240abede461687fab8fde8fc36ada90c0446bf",
}
GOLDEN_EVENT_DIGESTS = {
    "1000": "96d3b2d623ecae95a89b5020fa0de2bbe7fefb8cb9132a9dfe181ff805194168",
    "1001": "3d7f7b793a7cdd52310816e7571a7333baab65653b6acb55f9d3c8813178bfd0",
    "1002": "037a9520db47e1455f04c9c69a18beb80b3d5358349e94f0253388cdece4ad22",
    "1003": "fd36fa8db78d5a8d90bf7f58c096315dc587d0bf52690fe2bab7c926325607f5",
    "1004": "6a96c3b147c7980c5b02a7a8b9e8a423bc9584ed7854b574c8519a0bcd6b7da2",
    "1005": "d414c3969c66ed020a18bb524c2201934aaed8bdc4207fd11f14ede69a9024a5",
}
GOLDEN_SHORT_STATE = "244e53d35370f824cfd7352d52413bf8956ced9b2996353c96eee4052b8f70e6"
GOLDEN_SHORT_EVENTS = "1458c52ee892de4b5806d761186569fbcb155f7627b0c06ab32c940147a42a87"


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _legacy_cfg() -> rc.RuleConfig:
    rc.clear_cache()
    return rc.load_config(rc.DEFAULT_RULE_CONFIG_ID)


def _fresh_state(seed: int = 7):
    return renv.reset(ROSTER_IDS[0:3], ROSTER_IDS[0:3], seed=seed, rs=RS)


def _first_skill(state, side: str) -> Action:
    return pick_action(state, side, 0)


def pick_action(state, side: str, index: int) -> Action:
    """这一方第 index 个技能（没有技能就退回换宠）。

    固定动作序列要跨「测试」与「报告脚本」复用同一份取法：各写一遍就会各漂一遍
    （报告脚本 import 本模块，不另抄）。
    """
    acts = [a for a in renv.legal_actions(state, RS, side) if a.kind == ACTION_SKILL]
    if not acts:
        acts = [a for a in renv.legal_actions(state, RS, side) if a.kind == ACTION_SWITCH]
    return acts[min(index, len(acts) - 1)]


def _status_kinds(state, since: int):
    return [event.kind for event in state.events[since:]]


class LegacyRegistryIsEngineTruthTest(unittest.TestCase):
    """判据 1：登记表必须如实等于引擎真的在做的事。"""

    def setUp(self):
        rc.clear_cache()

    def tearDown(self):
        rc.clear_cache()

    def test_legacy_turn_order_registry_matches_engine(self):
        cfg = _legacy_cfg()
        self.assertEqual(cfg.action_order, ("respond", "priority", "speed"),
                         "legacy 的 action_order 必须如实等于 order_actions 的排序键维度")
        self.assertEqual(cfg.speed_tie, "random_seeded",
                         "legacy 的平手策略就是 seed 随机，必须如实登记（这是工程权宜，不是规则）")
        self.assertEqual(cfg.end_turn_order, ("status_tick", "regen"))
        self.assertFalse(cfg.end_turn_unknown_stages_allowed)
        # 平手策略真的取得到，而且是那条**如实登记**的策略
        self.assertEqual(cfg.require_speed_tie(), "random_seeded")
        # 声明的维度都必须是引擎认识的名字（否则 order_actions 会抛错）
        self.assertEqual(renv.require_declared_action_order(cfg), cfg.action_order)

    def test_engine_implemented_stages_are_exactly_the_declared_ones(self):
        cfg = _legacy_cfg()
        self.assertEqual(tuple(cfg.end_turn_order), tuple(renv.END_TURN_STAGES_IMPLEMENTED))
        # 引擎不认识的名字不许悄悄混进「认识」清单里
        self.assertEqual(tuple(renv.ACTION_ORDER_DIMENSIONS), ("respond", "switch", "priority", "speed"))

    def test_candidate_speed_tie_is_unknown_and_refuses_to_guess(self):
        candidate = rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID)
        self.assertIsNone(candidate.speed_tie, "candidate 的平手策略必须是 UNKNOWN（null）")
        with self.assertRaises(rc.RuleConfigError) as ctx:
            candidate.require_speed_tie()
        message = str(ctx.exception)
        self.assertIn("speed_tie", message)
        self.assertIn("MC-E05", message, "UNKNOWN 的错误信息必须点名待录 microcase")
        # 必红反证：把策略填成「看起来合理」的 random_seeded 之后同一调用必须不再抛
        # —— 证明上面那条红是 UNKNOWN 造成的，而不是 require_speed_tie 恒抛
        patched = replace(candidate, speed_tie="random_seeded")
        self.assertEqual(patched.require_speed_tie(), "random_seeded")

    def test_unknown_action_dimension_fails_closed(self):
        cfg = _legacy_cfg()
        broken = replace(cfg, action_order=("respond", "weather", "priority", "speed"))
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv.require_declared_action_order(broken)
        self.assertIn("weather", str(ctx.exception), "错误信息必须点名那个没实现的维度")
        self.assertIn(cfg.ruleset_config_id, str(ctx.exception), "错误信息必须点名配置 id")
        # 必红反证：把守卫换成一个「直接放行」的版本，同一条判据必须翻白
        with mock.patch.object(renv, "require_declared_action_order",
                               lambda c: tuple(c.action_order)):
            self.assertEqual(renv.require_declared_action_order(broken), broken.action_order)


class EndTurnStageOrderTest(unittest.TestCase):
    """判据 2/3：回合末按声明结算；多一个/少一个都抛。"""

    def setUp(self):
        rc.clear_cache()
        self.cfg = _legacy_cfg()

    def tearDown(self):
        rc.clear_cache()

    def _tick(self, cfg, seed: int = 7):
        state = _fresh_state(seed)
        for side in (state.player, state.enemy):
            side.field_pet.statuses["中毒"] = {"layers": 1}
        since = len(state.events)
        renv._end_of_turn(state, RS, cfg)
        return state, _status_kinds(state, since)

    def test_legacy_order_is_status_then_regen(self):
        _, kinds = self._tick(self.cfg)
        self.assertEqual(kinds, ["status_tick", "energy_regen", "status_tick", "energy_regen"],
                         "legacy 的回合末顺序必须仍是「先状态伤害、再回能」（逐位不变）")

    def test_declared_order_is_really_used(self):
        """把声明反过来，事件顺序必须跟着反过来 —— 否则「按配置声明的顺序」只是句空话。"""
        reversed_cfg = replace(self.cfg, end_turn_order=("regen", "status_tick"))
        _, kinds = self._tick(reversed_cfg)
        self.assertEqual(kinds, ["energy_regen", "status_tick", "energy_regen", "status_tick"],
                         f"声明了 regen→status_tick，实际事件顺序是 {kinds}")
        self.assertNotEqual(kinds, ["status_tick", "energy_regen", "status_tick", "energy_regen"],
                            "反过来的声明产出了同样的顺序 —— 说明顺序根本不是从配置读的")

    def test_engine_stage_missing_from_config_raises(self):
        missing = replace(self.cfg, end_turn_order=("status_tick",))
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv._end_of_turn(_fresh_state(), RS, missing)
        message = str(ctx.exception)
        self.assertIn("regen", message, "错误信息必须点名引擎需要、配置却没声明的阶段")
        self.assertIn(self.cfg.ruleset_config_id, message, "错误信息必须点名是哪份配置")
        # 必红反证①：补回那个阶段，同一次调用不许抛（证明这条红不是「_end_of_turn 恒抛」）
        renv._end_of_turn(_fresh_state(), RS, self.cfg)
        # 必红反证②：把守卫换成「照配置声明跑」的版本，缺阶段的配置也不会抛
        #             —— 判据真的咬在守卫上，而不是咬在一句注释上
        with mock.patch.object(renv, "require_declared_end_turn_stages",
                               lambda c: tuple(c.end_turn_order)):
            renv._end_of_turn(_fresh_state(), RS, missing)

    def test_config_stage_not_implemented_by_engine_raises(self):
        extra = replace(self.cfg, end_turn_order=("status_tick", "regen", "weather_tick"))
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv._end_of_turn(_fresh_state(), RS, extra)
        message = str(ctx.exception)
        self.assertIn("weather_tick", message, "错误信息必须点名引擎不认识的阶段")
        self.assertIn(self.cfg.ruleset_config_id, message)
        # 必红反证：把那个不认识的阶段去掉之后不许抛
        renv._end_of_turn(_fresh_state(), RS, self.cfg)

    def test_unknown_stages_allowed_true_raises(self):
        allowed = replace(self.cfg, end_turn_unknown_stages_allowed=True)
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv._end_of_turn(_fresh_state(), RS, allowed)
        self.assertIn("unknown_stages_allowed", str(ctx.exception))
        # 必红反证：false 的那份不许抛
        renv._end_of_turn(_fresh_state(), RS, self.cfg)


class SpeedTieFailClosedTest(unittest.TestCase):
    """判据 4：平手策略 UNKNOWN 时，**只有真的出现平手**才抛。"""

    def setUp(self):
        rc.clear_cache()
        self.cfg = _legacy_cfg()
        self.state = _fresh_state(seed=7)
        # 双方同一只精灵、同一手技能 → (应对, 先手度, 速度) 三维完全相同 = 真的平手
        skill = _first_skill(self.state, "player")
        self.tie_actions = (skill, skill)

    def tearDown(self):
        rc.clear_cache()

    def _order(self, cfg):
        return renv.order_actions(self.state, RS, self.tie_actions[0], self.tie_actions[1],
                                  rng=renv._rng_for(self.state), cfg=cfg)

    def test_scenario_really_is_a_tie(self):
        """用例前提自检：这两手在排序键的前三维上必须真的相同。"""
        state = self.state
        entries = []
        for side, action, opp in (("player", self.tie_actions[0], self.tie_actions[1]),
                                  ("enemy", self.tie_actions[1], self.tie_actions[0])):
            entries.append((renv._respond_success(action, opp, RS),
                            renv._priority_of(action, RS),
                            state.player.field_pet.pet_id == state.enemy.field_pet.pet_id))
        self.assertEqual(entries[0][0], entries[1][0], "应对结果必须两边相同才构成平手")
        self.assertEqual(entries[0][1], entries[1][1], "先手度必须两边相同才构成平手")
        self.assertTrue(all(e[2] for e in entries), "双方必须是同一只精灵才有同速前提")
        self.assertTrue(renv._tie_is_decisive([
            {"respond": entries[0][0], "priority": entries[0][1], "speed": 1},
            {"respond": entries[1][0], "priority": entries[1][1], "speed": 1},
        ]))

    def test_unknown_speed_tie_raises_only_when_there_is_a_tie(self):
        unknown = replace(self.cfg, speed_tie=None, speed_tie_microcase_id="MC-E05")
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            self._order(unknown)
        message = str(ctx.exception)
        self.assertIn("speed_tie", message)
        self.assertIn("MC-E05", message, "错误信息必须点名待录 microcase")
        self.assertIn(self.cfg.ruleset_config_id, message, "错误信息必须点名是哪份配置")
        # 必红反证①：填回那条**如实登记**的策略之后，同一个平手局面必须能排出来，
        # 而且是**可复现**的（同一 seed → 同一顺序）；顺序谁先谁后不重要，
        # 重要的是它不是规则给的，是 seed 给的。
        ordered = self._order(self.cfg)
        self.assertEqual(sorted(side for side, _ in ordered), ["enemy", "player"])
        self.assertEqual(ordered, self._order(self.cfg), "同 seed 的平手裁决必须可复现")

    def test_unknown_speed_tie_does_not_raise_without_tie(self):
        """没有平手时不许抛 —— 否则「不知道就抛」会退化成「一律抛」。"""
        unknown = replace(self.cfg, speed_tie=None)
        # 一手技能 vs 一次逃跑：先手度 99 对技能的先手度，绝不相等 → 排序用不到平手这一维
        skill = self.tie_actions[0]
        ordered = renv.order_actions(self.state, RS, skill, Action(kind=ACTION_ESCAPE),
                                     rng=renv._rng_for(self.state), cfg=unknown)
        self.assertEqual(len(ordered), 2)
        self.assertEqual(ordered[0][0], "enemy", "逃跑（先手度 99）应当先动")
        # 前提自检：这对手确实不是平手
        self.assertFalse(renv._tie_is_decisive([
            {"respond": renv._respond_success(skill, Action(kind=ACTION_ESCAPE), RS),
             "priority": renv._priority_of(skill, RS), "speed": 1},
            {"respond": False, "priority": renv._priority_of(Action(kind=ACTION_ESCAPE), RS), "speed": 1},
        ]))

    def test_guard_removed_makes_the_tie_criterion_red(self):
        """必红反证②：把「这一刻真的需要平手裁决」的判定摘掉，UNKNOWN 就不抛了。"""
        unknown = replace(self.cfg, speed_tie=None)
        with mock.patch.object(renv, "_tie_is_decisive", lambda entries: False):
            ordered = renv.order_actions(self.state, RS, self.tie_actions[0], self.tie_actions[1],
                                         rng=renv._rng_for(self.state), cfg=unknown)
        self.assertEqual(len(ordered), 2,
                         "守卫摘掉之后仍然抛错 —— 那说明这条判据咬的不是「真的出现平手」")

    def test_illegal_speed_tie_policy_fails_closed_at_load(self):
        """非法策略值（例如自造的 "speed_first"）必须在配置加载期就被判红。"""
        broken = json.loads(json.dumps(self.cfg.raw))
        broken["turn_order"]["speed_tie"]["value"] = "speed_first"
        problems = rc.validate_config(broken, rc._load_ledger())
        self.assertTrue(any("speed_tie" in p for p in problems), problems)
        # 必红反证：合法的那份一个 problem 都没有
        self.assertEqual(rc.validate_config(self.cfg.raw, rc._load_ledger()), [])


class LegacyBitExactGoldenTest(unittest.TestCase):
    """判据 5：legacy 默认路径逐位不变（golden 指纹是改动前抓的）。"""

    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_default_path_is_bit_identical_to_pre_rc103(self):
        names = list(ropp.STRATEGIES.names())
        for index, seed in enumerate((1000, 1001, 1002, 1003, 1004, 1005)):
            team_a = [ROSTER_IDS[index % 12], ROSTER_IDS[(index + 1) % 12], ROSTER_IDS[(index + 2) % 12]]
            team_b = [ROSTER_IDS[(index + 3) % 12], ROSTER_IDS[(index + 4) % 12], ROSTER_IDS[(index + 5) % 12]]
            record = ropp.play_match(RS, team_a, team_b, names[index % len(names)],
                                     names[(index + 2) % len(names)], seed=seed)
            state = renv.replay(record.replay_plan(), RS)
            self.assertEqual(_digest(renv.serialize(state)), GOLDEN_STATE_DIGESTS[str(seed)],
                             f"seed={seed} 的最终状态与 RC-103 之前不一致 —— 默认路径被改动了")
            self.assertEqual(_digest([e.to_dict() for e in state.events]), GOLDEN_EVENT_DIGESTS[str(seed)],
                             f"seed={seed} 的事件序列与 RC-103 之前不一致")

    def test_short_scripted_game_is_bit_identical(self):
        state = _fresh_state(seed=3)
        for _ in range(4):
            if state.result:
                break
            if state.phase == "replace":
                side = state.replace_queue[0]
                renv.step_replace(state, RS, side, getattr(state, side).bench_indices()[0])
                continue
            renv.step_joint(state, RS, pick_action(state, "player", 0), pick_action(state, "enemy", 1))
        self.assertEqual(_digest(renv.serialize(state)), GOLDEN_SHORT_STATE)
        self.assertEqual(_digest([e.to_dict() for e in state.events]), GOLDEN_SHORT_EVENTS)

    def test_golden_digest_would_move_if_the_engine_changed(self):
        """必红反证：篡改一个事件字段后，指纹必须变 —— 否则上面两条可能是恒真的。"""
        state = _fresh_state(seed=3)
        renv._end_of_turn(state, RS)
        events = [e.to_dict() for e in state.events]
        before = _digest(events)
        mutated = json.loads(json.dumps(events))
        self.assertTrue(mutated, "必须至少有一个事件才谈得上篡改")
        mutated[-1]["kind"] = mutated[-1]["kind"] + "-被篡改"
        self.assertNotEqual(_digest(mutated), before)


class RegistryConfigShapeTest(unittest.TestCase):
    """配置层的形状判据：缺字段 / 非法值一律 fail closed。"""

    def setUp(self):
        rc.clear_cache()
        self.cfg = _legacy_cfg()

    def tearDown(self):
        rc.clear_cache()

    def _problems(self, mutate):
        raw = json.loads(json.dumps(self.cfg.raw))
        mutate(raw)
        return rc.validate_config(raw, rc._load_ledger())

    def test_missing_turn_order_fields_are_reported(self):
        for path, mutate in (
            ("turn_order.action_order", lambda raw: raw["turn_order"].pop("action_order")),
            ("turn_order.speed_tie", lambda raw: raw["turn_order"].pop("speed_tie")),
            ("turn_order.end_turn.unknown_stages_allowed",
             lambda raw: raw["turn_order"]["end_turn"].pop("unknown_stages_allowed")),
        ):
            problems = self._problems(mutate)
            self.assertTrue(any(path in p for p in problems),
                            f"删掉 {path} 必须被判红，实际 {problems}")
        # 必红反证：完整的那份一个 problem 都没有
        self.assertEqual(rc.validate_config(self.cfg.raw, rc._load_ledger()), [])

    def test_stage_list_shape_is_checked(self):
        empty = self._problems(lambda raw: raw["turn_order"]["end_turn"]["order"].__setitem__("value", []))
        self.assertTrue(any("非空数组" in p for p in empty), empty)
        dup = self._problems(lambda raw: raw["turn_order"]["end_turn"]["order"].__setitem__(
            "value", ["status_tick", "regen", "regen"]))
        self.assertTrue(any("重复" in p for p in dup), dup)
        not_string = self._problems(lambda raw: raw["turn_order"]["action_order"].__setitem__(
            "value", ["respond", 3]))
        self.assertTrue(any("非空字符串" in p for p in not_string), not_string)

    def test_unknown_stages_allowed_true_is_rejected_by_config_layer_too(self):
        problems = self._problems(
            lambda raw: raw["turn_order"]["end_turn"]["unknown_stages_allowed"].__setitem__("value", True))
        self.assertTrue(any("unknown_stages_allowed" in p for p in problems), problems)
        # 必红反证：false（现状）不许被判红
        self.assertEqual(rc.validate_config(self.cfg.raw, rc._load_ledger()), [])


if __name__ == "__main__":       # pragma: no cover - 手工跑
    unittest.main()
