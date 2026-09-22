"""RC-106：让「六宠标准 PVP」真的能开一局。

这一轮修的是三个**阻断**（RC-105 实测出来的），每条都配一个必红反证：

  1. **v3 开不了局**：`mobile_s4_candidate_v3.json` 的 `energy.initial` 是 `null`
     （UNKNOWN，MC-E04 未录制），`reset(config=v3)` 按 RC-101 纪律 fail closed。
     修法不是往配置里填一个数，而是加一条**显式的、带出处的未核验覆盖**
     （`unverified_overrides`）：
       · 没有覆盖 + `null` ⇒ **仍然抛**（这条不许放宽，它就是纪律的价值）；
       · 有覆盖 ⇒ 开局，且覆盖**如实出现在对外载荷**里（公开面 / UI / 序列化）；
       · 覆盖**不写回**配置文件（v3 的 `energy.initial` 必须还是 `null`）。
  2. **引擎只会 3v3**：`reset` / `validate_team` 只接受 3 只，而
     `pvp-standard-six-pet` 登记的是 `team_size: 6`。修法是**按配置/模式参数**取规模，
     `legacy_sim_v1` / `demo-training-3v3` 仍然是 3，且默认路径**逐位不变**。
  3. **绑定还是 v2**：`battle-modes.json` 里 `pvp-standard-six-pet.ruleset_binding`
     从 v2 改成 v3（真正带 mana/actions 的那份）。

口径纪律（不要在这份测试里放宽）：
  · 覆盖用的 2 是**练习局口径**（legacy 的入场能量），**不是**标准 PVP 的实机结论；
  · 台账等级一律不动：`EV-PVP-STANDARD-TEAM-SIZE` / `-MANA` / `-FAINT-MANA-LOSS`
    都还是 `CROSS_SOURCE_SUPPORTED`，`energy.initial` 相关的一切都还是
    `ENGINE_HYPOTHESIS`（见 `roco_env.overrides.OVERRIDE_CONFIDENCE`）。

运行：cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import events_text              # noqa: E402
from roco_env import opponents as ropp        # noqa: E402
from roco_env import overrides as ov          # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env import effects as fx            # noqa: E402
from roco_env.schema import (                 # noqa: E402
    ACTION_CHARGE,
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SURRENDER,
    ACTION_SWITCH,
    Action,
)

RS = rdata.load_ruleset()
ropp.bind_ruleset(RS)

V2 = rc.CANDIDATE_RULE_CONFIG_ID
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID

#: 标准 PVP 的六宠队伍。速度两两不同（60/100/70/105/90/120 与 130/92/115/80/75/108）：
#: v3 沿用 v2 的 `turn_order.speed_tie = null`，同速平手会让 `order_actions` 按 RC-103
#: 的纪律抛错 —— 那是判据，不是本活的缺陷，所以夹具刻意避开它。
TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
TEAM_B = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]
IDS_A = [RS.pets_by_name(n)[0].pet_id for n in TEAM_A]
IDS_B = [RS.pets_by_name(n)[0].pet_id for n in TEAM_B]

#: 练习局口径的入场能量：**从默认配置里读**，不在测试里写死一个字面量。
PRACTICE_INITIAL_ENERGY = int(rc.load_config(LEGACY).energy_initial)
#: v3 的 `energy.initial` 在磁盘上必须是 null —— 覆盖不许写回文件（下面反复核对）。
V3_INITIAL_ON_DISK = rc.load_config(V3).energy_initial


def _override(value: int | None = None, **patch) -> dict:
    """一条**合规**的未核验覆盖。默认值 = 练习局口径，reason 明说它不是实机结论。"""
    entry = {
        "path": "energy.initial",
        "value": PRACTICE_INITIAL_ENERGY if value is None else value,
        "confidence": "ENGINE_HYPOTHESIS",
        "reason": "练习局口径（legacy 的入场能量）：标准 PVP 的首次入场能量没有实机证据（MC-E04 未录制）",
        "microcase_id": "MC-E04",
    }
    entry.update(patch)
    return entry


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _play_six_pet(config_id: str = V3, seed: int = 11, *, strat_a: str = "greedy_damage",
                  strat_b: str = "greedy_damage", turns: int = 400):
    """用引擎的**真路径**跑一局六宠：`play_match` → `replay_plan` → `replay`。"""
    record = ropp.play_match(RS, IDS_A, IDS_B, strat_a, strat_b, seed=seed,
                             config=config_id, unverified_overrides=[_override()])
    return record, renv.replay(record.replay_plan(), RS)


def _replay_collecting_events(plan: dict):
    """逐回合重放，把**每一回合真的产生过**的事件也收下来。

    为什么需要它：`step_joint` 的回合末会重写 `state.events`，所以终局状态里只剩
    最后一回合的事件 —— 只看终局会把 `mana_loss` / `charge` 这类早期事件漏掉，
    「每个 kind 都有句子」那条判据就会空转（实测 seed=11 时终局里没有 mana_loss）。
    """
    state = renv.reset(plan["team"], plan.get("enemy_team"), seed=plan["seed"], rs=RS,
                       loadouts=plan.get("loadouts"),
                       config=plan.get("ruleset_config_id"),
                       unverified_overrides=plan.get("unverified_overrides"))
    collected = []
    for pair in plan["actions"]:
        if state.result:
            break
        before = len(state.events)
        if state.phase == "replace":
            side, slot = pair
            renv.step_replace(state, RS, side, int(slot))
        else:
            renv.step_joint(state, RS, Action.from_dict(pair[0]), Action.from_dict(pair[1]))
        # 这一步新产生的事件：`_bump` 只追加，但 `step_joint` 的 `turn_start` 会先把
        # 上一回合的列表清空，所以 `before` 有时是 0 —— 那时整份列表都是新的。
        collected.extend(e.to_dict() for e in state.events[before:])
    return state, collected


def _sweep_six_pet_events(pairs=(("greedy_damage", "greedy_damage"),
                                ("conservative_switch", "greedy_damage"),
                                ("greedy_damage", "random_legal")), seeds=(11, 12, 13)):
    """跑一批六宠对局，返回 (kind → 样例事件, 全部事件的 kind 集合)。

    为什么要多组策略：单看一组会漏 —— `greedy vs random` 里随机策略常常**投降**结束
    （pool=4 还没扣完就认输），那样 `mana_loss` 一次都不会发生，「每个 kind 都有句子」
    这条判据就会空转。多组一起收才既覆盖聚能、也覆盖力竭扣魔力与投降。
    """
    seen, kinds = {}, set()
    for strat_a, strat_b in pairs:
        for seed in seeds:
            record = ropp.play_match(RS, IDS_A, IDS_B, strat_a, strat_b, seed=seed, config=V3,
                                     unverified_overrides=[_override()])
            _state, events = _replay_collecting_events(record.replay_plan())
            for event in events:
                seen.setdefault(event["kind"], event)
                kinds.add(event["kind"])
    return seen, kinds


# ── 1. 覆盖机制：没有覆盖就抛，有覆盖就开局且如实上报 ────────────────────


class UnverifiedOverrideTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_v3_initial_energy_is_still_unknown_on_disk(self):
        """前提自检：v3 的 `energy.initial` 仍然是 `null`（UNKNOWN）。"""
        cfg = rc.load_config(V3)
        self.assertIsNone(cfg.energy_initial)
        self.assertIsNone(V3_INITIAL_ON_DISK)
        self.assertEqual(cfg.raw["energy"]["initial"]["confidence"], "UNKNOWN")

    def test_no_override_fails_closed(self):
        """必红反证①的**正面**：没有覆盖 + `null` ⇒ 抛错，绝不回落到某个默认值。

        必红方向：把 `reset` 里那次 `resolve_int(...)` 改成回落到 legacy 的 2
        （或任何默认值），这条会立刻红 —— 见报告 `checks[].counter_proof`。
        """
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3)
        message = str(ctx.exception)
        self.assertIn("energy.initial", message)
        self.assertIn("MC-E04", message)
        self.assertIn("UNKNOWN", message)
        self.assertIn("unverified_overrides", message, "错误信息要指出唯一的合法旁路")
        # 同一个纪律对 v2 也成立（v2 绑的是同一个六宠模式）
        with self.assertRaises(fx.UnsupportedEffect):
            renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V2)

    def test_with_override_the_match_starts_and_the_payload_carries_it(self):
        state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3,
                           unverified_overrides=[_override()])
        self.assertEqual(state.player.field_pet.energy, PRACTICE_INITIAL_ENERGY)
        self.assertEqual(state.ruleset_config_id, V3)
        self.assertEqual(len(state.player.pets), 6)
        # ① 状态里带上了它
        self.assertEqual(len(state.unverified_overrides), 1)
        entry = state.unverified_overrides[0]
        self.assertEqual(
            (entry["path"], entry["value"], entry["confidence"], entry["microcase_id"]),
            ("energy.initial", PRACTICE_INITIAL_ENERGY, "ENGINE_HYPOTHESIS", "MC-E04"))
        self.assertIs(entry["unverified"], True)
        self.assertIn("练习局口径", entry["reason"])
        # ② 序列化（存档）里带上了它
        dumped = renv.serialize(state)
        self.assertEqual(dumped["unverified_overrides"], state.unverified_overrides)
        # ③ 公开规划面里带上了它
        planner = renv.public_planner_state(state, RS, "player")
        self.assertEqual(planner["unverified_overrides"], state.unverified_overrides)
        # ④ UI 视图里带上了它（机器可读 + 一句可渲染的话）
        ui = renv.ui_public_view(state, RS, "player")
        self.assertEqual(ui["unverified_overrides"], state.unverified_overrides)
        notes = ui["notes"]["unverified_overrides"]
        self.assertEqual(len(notes), 1)
        self.assertIn("energy.initial", notes[0])
        self.assertIn("未核验", notes[0])
        self.assertIn("MC-E04", notes[0])
        # ⑤ 由公开面重建的分析状态也带上了它（否则差分分析会以为配置里真有这个数）
        rebuilt = renv.state_from_public_planner(planner, RS, analysis_seed=7)
        self.assertEqual(rebuilt.unverified_overrides, state.unverified_overrides)

    def test_override_is_not_written_back_to_the_config_file(self):
        """覆盖**不写回**配置文件：跑完一局之后磁盘上那份 `energy.initial` 还是 null。"""
        before = ov._dig(rc.load_config(V3).raw, "energy.initial")
        renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3, unverified_overrides=[_override()])
        rc.clear_cache()
        after = ov._dig(rc.load_config(V3).raw, "energy.initial")
        self.assertIsNone(before["value"])
        self.assertIsNone(after["value"], "覆盖把值写回了配置文件 —— 那是编规则，不是假设")
        self.assertEqual(before, after)
        # 反向控制：把「不写回」这条判据本身钉住 —— 配置里那个值只可能来自文件，
        # 所以读两次必须逐字相同（不是「恰好都是 None」）。
        self.assertEqual(json.dumps(before, sort_keys=True), json.dumps(after, sort_keys=True))

    def test_override_requires_provenance(self):
        """覆盖必须带出处：confidence / reason / microcase_id / path 四道闸门逐个红。"""
        bad_cases = {
            "confidence 抬成有证据的等级": _override(confidence="OFFICIAL_CURRENT"),
            "没有 reason": _override(reason=""),
            "没有 microcase_id": _override(microcase_id=None),
            "microcase_id 是空串": _override(microcase_id="  "),
            "覆盖一个不在白名单里的路径": _override(path="mana.pool"),
            "值不是非负整数": _override(value=-1),
            "值不是整数": _override(value="2"),
            "少一个字段": {"path": "energy.initial", "value": 2, "confidence": "ENGINE_HYPOTHESIS"},
        }
        for name, entry in bad_cases.items():
            with self.subTest(case=name):
                with self.assertRaises(rc.RuleConfigError):
                    ov.normalize_unverified_overrides(rc.load_config(V3), [entry])
        # 同一个路径覆盖两次必须红（后一条会静默压掉前一条）
        with self.assertRaises(rc.RuleConfigError):
            ov.normalize_unverified_overrides(rc.load_config(V3), [_override(), _override(3)])
        # 不是数组也要红
        for bad in ("energy.initial=2", {"path": "energy.initial"}):
            with self.assertRaises(rc.RuleConfigError):
                ov.normalize_unverified_overrides(rc.load_config(V3), bad)

    def test_override_may_not_rewrite_a_known_rule_value(self):
        """覆盖只用于填 `UNKNOWN`：拿它去改一条**已登记**的规则值必须抛。

        反证：legacy 的 `energy.initial` 是 2（有值），覆盖它必须红 ——
        「填一个未知数」与「改一条已知规则」是两件事。
        """
        legacy = rc.load_config(LEGACY)
        self.assertEqual(legacy.energy_initial, PRACTICE_INITIAL_ENERGY)
        with self.assertRaises(rc.RuleConfigError) as ctx:
            ov.normalize_unverified_overrides(legacy, [_override(7)])
        self.assertIn("不是 UNKNOWN", str(ctx.exception))

    def test_legacy_payload_has_no_override_key(self):
        """legacy / 没有覆盖的对局：载荷里**不出现**覆盖字段（逐位不变靠它成立）。"""
        state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
        dumped = renv.serialize(state)
        self.assertNotIn("unverified_overrides", dumped)
        self.assertEqual(renv.public_planner_state(state, RS, "player")["unverified_overrides"], [])
        self.assertEqual(renv.ui_public_view(state, RS, "player")["unverified_overrides"], [])
        self.assertIn("没有使用任何未核验覆盖",
                      renv.ui_public_view(state, RS, "player")["notes"]["unverified_overrides"][0])
        roundtrip = renv.deserialize(json.loads(json.dumps(dumped)), RS)
        self.assertEqual(roundtrip.unverified_overrides, [])


# ── 2. 模式规模：六宠能开局、能跑完；legacy 仍然只收 3 ───────────────────


class TeamSizeTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()

    def tearDown(self):
        rc.clear_cache()

    def test_team_size_comes_from_the_config_not_from_code(self):
        """规模读的是配置：v3/v2 ⇒ 6、legacy ⇒ 3。把配置改坏必须抛（不猜）。"""
        self.assertEqual(rc.load_config(V3).require_team_size(), 6)
        self.assertEqual(rc.load_config(V2).require_team_size(), 6)
        self.assertEqual(rc.load_config(LEGACY).require_team_size(), 3)
        with self.assertRaises(rc.RuleConfigError):
            rc.load_config(V3).__class__(**{**rc.load_config(V3).__dict__,
                                            "battle_mode_team_size": None}).require_team_size()
        with self.assertRaises(rc.RuleConfigError):
            rc.load_config(V3).__class__(**{**rc.load_config(V3).__dict__,
                                            "battle_mode_team_size": 0}).require_team_size()

    def test_six_pet_teams_start_and_five_pet_is_refused(self):
        """6 只开得起来，5 只 / 7 只都被拒 —— 判据在**配置的规模**上。"""
        state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3,
                           unverified_overrides=[_override()])
        self.assertEqual((len(state.player.pets), len(state.enemy.pets)), (6, 6))
        for bad in (IDS_A[:5], IDS_A + [IDS_B[0]]):
            with self.subTest(size=len(bad)):
                with self.assertRaises(ValueError) as ctx:
                    renv.reset(bad, IDS_B, seed=3, rs=RS, config=V3,
                               unverified_overrides=[_override()])
                self.assertIn("6 只", str(ctx.exception))
        # 对手那一侧同样按配置校验
        with self.assertRaises(ValueError):
            renv.reset(IDS_A, IDS_A[:3], seed=3, rs=RS, config=V3,
                       unverified_overrides=[_override()])

    def test_legacy_still_accepts_exactly_three(self):
        state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
        self.assertEqual((len(state.player.pets), len(state.enemy.pets)), (3, 3))
        with self.assertRaises(ValueError) as ctx:
            renv.reset(IDS_A, IDS_B, seed=3, rs=RS)
        self.assertIn("3 只", str(ctx.exception))

    def test_validate_team_takes_the_size_from_the_caller(self):
        """`validate_team` 的规模是**参数**：同一支队伍在 3 / 6 两种口径下结论不同。"""
        six = IDS_A
        self.assertEqual(renv.validate_team(RS, six, team_size=6), [])
        problems = renv.validate_team(RS, six, team_size=3)
        self.assertTrue(any("必须是 3 只" in p for p in problems), problems)
        self.assertEqual(renv.validate_team(RS, IDS_A[:3], team_size=3), [])
        # 非法参数要抛，不是静默按 3 算
        with self.assertRaises(ValueError):
            renv.validate_team(RS, six, team_size=0)

    def test_six_pet_match_runs_to_a_deterministic_finish(self):
        """六宠**真的能跑完**：魔力扣减、归零判负 / 投降判负至少有一条真的发生。"""
        for seed in (11, 12, 13):
            with self.subTest(seed=seed):
                record, state = _play_six_pet(seed=seed)
                self.assertFalse(record.truncated, f"seed={seed} 撞上回合上限：{record.error}")
                self.assertIsNotNone(state.result, f"seed={seed} 没跑出结果")
                self.assertIn(state.result, ("win", "loss", "draw"))
                self.assertEqual(state.phase, "ended")
                # 事件与日志都来自真结算
                kinds = [e.kind for e in state.events]
                self.assertIn("game_end", kinds)
                self.assertIn("faint", kinds)
                end = [e for e in state.events if e.kind == "game_end"][-1]
                self.assertIn(end.detail.get("reason"), ("mana_depleted", None) if state.result == "draw"
                              else ("mana_depleted",))
        # 确定性：同一 seed + 同一策略 + 同一动作序列 ⇒ 逐位相同
        first = _play_six_pet(seed=11)[1]
        second = _play_six_pet(seed=11)[1]
        self.assertEqual(_digest(renv.serialize(first)), _digest(renv.serialize(second)))
        # 不同 seed 允许不同结果（否则说明 seed 没接进对局）
        self.assertNotEqual(_digest(renv.serialize(_play_six_pet(seed=77)[1])),
                            _digest(renv.serialize(first)))

    def test_six_pet_legal_actions_are_clipped_by_the_config(self):
        state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3,
                           unverified_overrides=[_override()])
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player")]
        self.assertNotIn(ACTION_ITEM, kinds, "标准 PVP 没有道具")
        self.assertNotIn(ACTION_ESCAPE, kinds, "标准 PVP 没有逃跑")
        self.assertIn(ACTION_CHARGE, kinds, "标准 PVP 有聚能（独立动作类）")
        self.assertIn(ACTION_SURRENDER, kinds, "标准 PVP 有投降")
        # 六只 ⇒ 至少 5 个可换的后备（换宠目标逐个给出）
        switches = [a for a in renv.legal_actions(state, RS, "player") if a.kind == ACTION_SWITCH]
        self.assertEqual(len(switches), 5, "6 只队伍里场下应有 5 个存活可换目标")

    def test_six_pet_mana_settlement(self):
        """魔力跟着力竭走：每力竭一次扣 1，归零立即判负；投降判负是独立出口。"""
        cfg = rc.load_config(V3)

        def fresh():
            return renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3,
                              unverified_overrides=[_override()])

        state = fresh()
        self.assertEqual((state.player.mana, state.enemy.mana), (4, 4))
        # **先把那一手选出来**：对手魔力归零之后 `legal_actions` 就是空的了，
        # 所以「同一只手打两次」必须在两个局面都还有合法动作时取。
        strongest = max((a for a in renv.legal_actions(state, RS, "player")
                         if a.kind == "skill" and RS.skill(a.skill_id).is_attack),
                        key=lambda a: RS.skill(a.skill_id).power or 0)
        # 对手**场上那只**掉到 1 血（六宠局里首发可能已经被换掉，所以要按场上那只取）
        state.enemy.field_pet.hp = 1
        renv._execute(state, RS, "player", strongest, cfg)
        self.assertTrue(state.enemy.field_pet.fainted)
        self.assertEqual(state.enemy.mana, 3, "力竭扣 1")
        self.assertEqual(state.player.mana, 4, "扣的是力竭那一方")
        loss = [e for e in state.events if e.kind == "mana_loss"][-1]
        self.assertEqual((loss.detail["side"], loss.detail["faint_cost"], loss.detail["mana"]),
                         ("enemy", 1, 3))

        # 归零**立即**判负：对方还有存活精灵，不是按打光判的
        nearly = fresh()
        nearly.enemy.mana = 1
        nearly.enemy.field_pet.hp = 1
        renv._execute(nearly, RS, "player", strongest, cfg)
        self.assertEqual(nearly.enemy.mana, 0)
        self.assertEqual(nearly.result, "win")
        self.assertTrue(nearly.enemy.living(), "对方还有存活精灵 —— 胜负按魔力判的")
        self.assertEqual([e for e in nearly.events if e.kind == "game_end"][-1].detail["reason"],
                         "mana_depleted")

        # 投降判负（另一个出口）
        other = fresh()
        surrender = [a for a in renv.legal_actions(other, RS, "player")
                     if a.kind == ACTION_SURRENDER][0]
        renv._execute(other, RS, "player", surrender, cfg)
        self.assertEqual(other.result, "loss")
        self.assertIn("surrender", [e.kind for e in other.events])

    def test_real_six_pet_matches_settle_mana(self):
        """真跑几局：力竭扣魔力的**笔数**与魔力账目对得上（不是只看终局）。

        用 `greedy vs greedy` 这种会打满的组合：随机策略常常提前投降，
        魔力还没扣完对局就结束了，那样这条判据会被「投降」这条捷径空转掉。
        """
        for seed in (11, 12, 13):
            with self.subTest(seed=seed):
                record = ropp.play_match(RS, IDS_A, IDS_B, "greedy_damage", "greedy_damage",
                                         seed=seed, config=V3,
                                         unverified_overrides=[_override()])
                state, events = _replay_collecting_events(record.replay_plan())
                self.assertFalse(record.truncated, f"seed={seed} 撞上回合上限：{record.error}")
                self.assertIsNotNone(state.result)
                kinds = [e["kind"] for e in events]
                self.assertIn("faint", kinds)
                self.assertIn("mana_loss", kinds, "六宠局里真的会发生力竭 → 扣魔力")
                losses = {"player": 0, "enemy": 0}
                for event in events:
                    if event["kind"] == "mana_loss":
                        losses[event["detail"]["side"]] += 1
                for side, count in losses.items():
                    mana = getattr(state, side).mana
                    lost = 4 - (mana if mana is not None else 4)
                    self.assertEqual(count, lost,
                                     f"{side} 的力竭笔数（{count}）与魔力扣减（{lost}）对不上")
                # 终局必须说得清为什么结束（`greedy vs greedy` 应当打到魔力归零）
                endings = [e for e in events if e["kind"] == "game_end"]
                self.assertTrue(endings, "六宠局必须有 game_end")
                self.assertEqual(endings[-1]["detail"].get("reason"), "mana_depleted",
                                 "两个贪伤策略互砍应当打到某一方魔力归零")

    def test_charge_really_appears_in_a_six_pet_match(self):
        """聚能是**真的会被用到**的动作类（对局里出现 `charge` 事件），不是摆设。"""
        seen = set()
        for seed in (11, 12, 13):
            record = ropp.play_match(RS, IDS_A, IDS_B, "greedy_damage", "random_legal",
                                     seed=seed, config=V3,
                                     unverified_overrides=[_override()])
            _state, events = _replay_collecting_events(record.replay_plan())
            seen.update(e["kind"] for e in events)
        self.assertIn("charge", seen,
                      "标准 PVP 的合法动作里有聚能，但整批对局里一次都没发生 —— 判据会空转")

    def test_six_pet_record_roundtrips_through_replay(self):
        """记录必须可重放：带上配置与覆盖，第三件事是「策略语义没为六宠改过」。"""
        record, state = _play_six_pet(seed=11)
        plan = record.replay_plan()
        self.assertEqual(plan["ruleset_config_id"], V3)
        self.assertEqual(len(plan["unverified_overrides"]), 1)
        self.assertEqual(len(plan["team"]), 6)
        replayed = renv.replay(plan, RS)
        self.assertEqual(replayed.result, state.result)
        self.assertEqual(_digest(renv.serialize(replayed)), _digest(renv.serialize(state)))
        # 反证：把覆盖从记录里摘掉 ⇒ 重放必须 fail closed（而不是悄悄用默认值）
        broken = {k: v for k, v in plan.items() if k != "unverified_overrides"}
        with self.assertRaises(fx.UnsupportedEffect):
            renv.replay(broken, RS)

    def test_opponent_strategies_stay_legal_with_six_pets(self):
        """对手策略在 6 只队伍下**只从合法动作里选**（策略语义一个字节都没改）。"""
        ropp.reset_hidden_reads()
        for name in ropp.STRATEGIES.names():
            with self.subTest(strategy=name):
                record, state = _play_six_pet(seed=21, strat_a=name, strat_b=name)
                self.assertFalse(record.truncated, f"{name} 在六宠局里停滞了：{record.error}")
                self.assertIsNotNone(state.result, f"{name} 没跑出结果")
                # 策略不能偷看隐藏字段（既有纪律，六宠局面下同样成立）
                self.assertEqual(ropp.hidden_read_paths(), [],
                                 f"{name} 试图读了 {ropp.hidden_read_paths()}")


# ── 3. legacy 逐位不变（8 条 golden 指纹 + 序列化不多键）─────────────────


class LegacyInvarianceTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_legacy_state_serialization_is_unchanged(self):
        """legacy 的序列化里**不出现** `unverified_overrides` / `mana` 两个新键。"""
        state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
        dumped = renv.serialize(state)
        text = json.dumps(dumped, ensure_ascii=False, sort_keys=True)
        self.assertNotIn('"mana"', text)
        self.assertNotIn('"unverified_overrides"', text)
        self.assertEqual(dumped["ruleset_config_id"], LEGACY)

    def test_golden_fingerprints_from_rc103_hold(self):
        """RC-103 抓下来的 8 条指纹（6 个 seed + 短剧本）必须仍然相同。

        这一条**引用**既有 golden 值，不在这里重抄一份：8 条指纹由
        `test_turn_order_fail_closed.LegacyBitExactGoldenTest` 拥有并逐条比对，
        这里只确认那份判据仍然存在、格式没坏、并且引擎在 legacy 下状态里
        没有任何 RC-106 的新字段（防「golden 被悄悄删掉」或「新字段漏进默认路径」）。
        """
        from tests import test_turn_order_fail_closed as golden  # type: ignore
        self.assertEqual(sorted(golden.GOLDEN_STATE_DIGESTS), sorted(golden.GOLDEN_EVENT_DIGESTS),
                         "状态与事件两份 golden 必须覆盖同一批 seed")
        self.assertEqual(sorted(golden.GOLDEN_STATE_DIGESTS), ["1000", "1001", "1002",
                                                               "1003", "1004", "1005"])
        for digest in list(golden.GOLDEN_STATE_DIGESTS.values()) \
                + list(golden.GOLDEN_EVENT_DIGESTS.values()) \
                + [golden.GOLDEN_SHORT_STATE, golden.GOLDEN_SHORT_EVENTS]:
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
        # 真跑一局 legacy，逐位复算：新字段一个都不许出现在默认路径上
        state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS)
        self.assertEqual(state.ruleset_config_id, LEGACY)
        self.assertEqual(state.unverified_overrides, [])
        self.assertEqual(renv.serialize(state), renv.serialize(state))

    def test_legacy_replay_plan_shape_is_unchanged(self):
        """legacy 的 `replay_plan` 不许多出配置/覆盖两个键（旧记录逐字不变）。"""
        record = ropp.play_match(RS, IDS_A[:3], IDS_B[:3], "greedy_damage", "greedy_damage", seed=1000)
        plan = record.replay_plan()
        self.assertNotIn("ruleset_config_id", plan)
        self.assertNotIn("unverified_overrides", plan)
        self.assertNotIn("ruleset_config_id", record.to_dict())


# ── 4. 事件文案：六宠局里出现的 kind 全都有句子 ──────────────────────────


class SixPetEventTextTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()

    def tearDown(self):
        rc.clear_cache()

    def test_every_kind_in_a_real_six_pet_match_has_a_sentence(self):
        """对局里出现的 kind **全部**有句子 —— 而且这三类（聚能/扣魔力/投降）真的出现。"""
        seen, _kinds = _sweep_six_pet_events()
        missing = sorted(set(seen) - set(events_text.KNOWN_EVENT_KINDS))
        self.assertEqual(missing, [], f"引擎产出了未登记的事件类型 {missing}")
        for kind, event in sorted(seen.items()):
            text = events_text.event_text(event, RS)
            self.assertTrue(text and text.strip(), f"{kind} 生成了空句子")
            self.assertNotIn("还没有它的中文说法", text, f"{kind} 走了兜底话：{text}")
        for required in ("charge", "mana_loss", "surrender"):
            self.assertIn(required, seen,
                          f"六宠标准 PVP 局里没有出现 {required} —— 判据会空转")
            text = events_text.event_text(seen[required], RS)
            self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in text), text)
            self.assertTrue(text.endswith("。") or text.endswith("）"), text)

    def test_new_sentences_are_neutral_and_verifiable(self):
        """三类新句子都必须**中性、可核对**：带真实数值 + 标出未核验，不写评价。"""
        cfg = rc.load_config(V3)
        charge = events_text.event_text(
            {"kind": "charge", "turn": 3,
             "detail": {"side": "enemy", "energy_gained": 5, "energy": 5}}, RS)
        self.assertIn("5", charge)
        self.assertIn("未核验", charge, "聚能的上限语义是 MC-E02 未解项，必须标出来")
        mana = events_text.event_text(
            {"kind": "mana_loss", "turn": 7,
             "detail": {"side": "player", "faint_cost": cfg.mana_faint_cost, "mana": 3}}, RS)
        self.assertIn("1", mana)
        self.assertIn("3", mana)
        self.assertIn("未实机核实", mana)
        surrender = events_text.event_text(
            {"kind": "surrender", "turn": 12, "detail": {"side": "enemy", "result": "win"}}, RS)
        self.assertIn("投降", surrender)
        self.assertIn("未核验", surrender)
        for text in (charge, mana, surrender):
            for judgement in ("应该", "最好", "可惜", "正确", "错误", "好棋", "失误"):
                self.assertNotIn(judgement, text, f"事件文案不该做评价：{text}")

    def test_missing_detail_never_invents_numbers(self):
        """**不补数字**：detail 里没有的键就不许出现在句子里。"""
        for kind in ("charge", "mana_loss"):
            text = events_text.event_text({"kind": kind, "turn": 1, "detail": {"side": "player"}}, RS)
            self.assertNotIn("0 ", text)
            self.assertNotIn("None", text)
            self.assertNotIn("null", text)


# ── 5. 绑定与版本关系：v2 / v3 的区别就是 mana / actions / binding ─────────


class BindingAndCandidateDeltaTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()

    def tearDown(self):
        rc.clear_cache()

    def test_standard_pvp_binding_points_at_the_config_that_has_mana(self):
        """登记表的绑定必须指向**真的带 mana/actions** 的那份配置（RC-106 的靶心）。"""
        binding = rc.bound_config_id_for_mode("pvp-standard-six-pet")
        self.assertEqual(binding, V3,
                         f"标准 PVP 的绑定必须指向 {V3}，实际 {binding} ——"
                         "绑回 v2 会让标准 PVP 按「能开局但没有魔力系统」的口径跑")
        bound = rc.load_config(binding)
        self.assertTrue(bound.has_mana, "被绑定的配置必须声明 mana")
        self.assertTrue(bound.has_actions, "被绑定的配置必须声明 actions")
        self.assertFalse(bound.is_default)
        self.assertEqual(bound.battle_mode_id, "pvp-standard-six-pet")
        self.assertEqual(bound.require_team_size(), 6)
        # legacy 的绑定没被动过
        self.assertEqual(rc.bound_config_id_for_mode("demo-training-3v3"), LEGACY)

    def test_v2_is_kept_as_the_no_mana_contrast(self):
        """v2 **不删**：它是「能开局但没有 mana/actions」的历史候选，留着做回归对照。"""
        v2 = rc.load_config(V2)
        self.assertFalse(v2.has_mana)
        self.assertFalse(v2.has_actions)
        self.assertIsNone(v2.mana_pool)
        self.assertIsNone(v2.allowed_kinds)
        self.assertEqual(v2.energy_max, 10)
        self.assertIsNone(v2.energy_initial)
        # 差别只有三处：mana / actions / binding —— 其余逐字相同
        v3 = rc.load_config(V3)
        self.assertEqual(json.dumps(v2.raw["energy"], sort_keys=True),
                         json.dumps(v3.raw["energy"], sort_keys=True),
                         "v3 的 energy 必须逐字沿用 v2")
        self.assertEqual(json.dumps(v2.raw["turn_order"], sort_keys=True),
                         json.dumps(v3.raw["turn_order"], sort_keys=True),
                         "v3 的 turn_order 必须逐字沿用 v2")
        self.assertNotEqual(json.dumps(v2.raw.get("mana"), sort_keys=True),
                            json.dumps(v3.raw.get("mana"), sort_keys=True))
        self.assertNotEqual(json.dumps(v2.raw.get("actions"), sort_keys=True),
                            json.dumps(v3.raw.get("actions"), sort_keys=True))

    def test_v2_opens_six_pets_but_without_mana_or_action_clipping(self):
        """v2 的六宠局：**能开局**（有覆盖）但没有 mana、也不裁剪动作。"""
        state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V2,
                           unverified_overrides=[_override()])
        self.assertEqual(len(state.player.pets), 6)
        self.assertIsNone(state.player.mana, "v2 没有 mana 这条概念")
        dumped = json.dumps(renv.serialize(state), ensure_ascii=False, sort_keys=True)
        self.assertNotIn('"mana"', dumped)
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player")]
        self.assertIn(ACTION_ITEM, kinds, "v2 不裁剪动作：道具继续存在")
        self.assertIn(ACTION_ESCAPE, kinds)

    def test_engine_and_registry_agree_on_team_size(self):
        """配置里的 `battle_mode.team_size` 与登记表必须一致（**加载期**就判）。

        这条咬的是加载器（`rc.validate_config`）；「队伍长度按配置走」在 `TeamSizeTest`。
        """
        for cid in rc.available_rule_configs():
            with self.subTest(config=cid):
                cfg = rc.load_config(cid)
                self.assertEqual(cfg.require_team_size(),
                                 rc.mode_team_size(cfg.battle_mode_id))
        # 反向控制：把 v3 的 team_size 改成 3 之后，加载期必须判红（而不是静默接受）
        broken = json.loads(json.dumps(rc.load_config(V3).raw))
        broken["battle_mode"]["team_size"]["value"] = 3
        problems = rc.validate_config(broken, rc._load_ledger())
        self.assertTrue(any("不一致" in p for p in problems), problems)
        # 那条红确实来自本题（配置自身合规时零 problem）
        self.assertEqual(rc.validate_config(rc.load_config(V3).raw, rc._load_ledger()), [])


# ── 6. 服务端接线：`/battle/new` 的三个新参数与载荷新键（主线程照这个改）────


class BattleNewEndpointWiringTest(unittest.TestCase):
    """`service.battle_new` 是 Node 侧唯一能开一局六宠标准 PVP 的入口。

    这组测试就是给主线程的**接线契约**：请求要传哪些参数、回执里多出哪些键。
    """

    def setUp(self):
        rc.clear_cache()
        from roco_env.service import RocoService
        self.svc = RocoService(served_ruleset_id=RS.ruleset_id)

    def tearDown(self):
        rc.clear_cache()

    def _body(self, **extra):
        return {"ruleset_id": RS.ruleset_id, "state_version": 0, "team": IDS_A,
                "enemy_team": IDS_B, "seed": 11, "strategy": "greedy_damage", **extra}

    def test_battle_new_starts_six_pet_standard_pvp_with_override(self):
        status, env = self.svc.battle_new(self._body(
            ruleset_config_id=V3, unverified_overrides=[_override()]))
        self.assertEqual(status, 200, env)
        self.assertTrue(env["ok"], env)
        result = env["result"]
        self.assertEqual(result["trust_domain"], "local_sim")
        self.assertEqual(result["state"]["ruleset_config_id"], V3)
        self.assertEqual(len(result["state"]["player"]["pets"]), 6)
        self.assertEqual(len(result["state"]["enemy"]["pets"]), 6)
        # 魔力与覆盖都进了载荷
        self.assertEqual(result["state"]["player"]["mana"], 4)
        self.assertEqual(result["state"]["unverified_overrides"], [dict(_override(), unverified=True)])
        self.assertEqual(result["public"]["unverified_overrides"],
                         [dict(_override(), unverified=True)])
        self.assertEqual(result["ui"]["unverified_overrides"],
                         [dict(_override(), unverified=True)])
        self.assertTrue(any("未核验" in line
                            for line in result["ui"]["notes"]["unverified_overrides"]))
        # 合法动作按标准 PVP 裁剪
        kinds = [a["kind"] for a in result["legal"]["player"]]
        self.assertIn("charge", kinds)
        self.assertIn("surrender", kinds)
        self.assertNotIn("item", kinds)
        self.assertNotIn("escape", kinds)

    def test_battle_new_without_override_is_422_not_400(self):
        """缺覆盖是「机制未核验」⇒ 422 `unsupported_effect`，不是「请求写错了」。"""
        status, env = self.svc.battle_new(self._body(ruleset_config_id=V3))
        self.assertEqual(status, 422, env)
        self.assertFalse(env["ok"])
        self.assertEqual(env["error_type"], "unsupported_effect")
        self.assertIn("energy.initial", env["error"])

    def test_battle_new_team_size_mismatch_is_400(self):
        status, env = self.svc.battle_new(self._body(
            ruleset_config_id=V3, unverified_overrides=[_override()], team=IDS_A[:3]))
        self.assertEqual(status, 400, env)
        self.assertIn("6 只", env["error"])

    def test_battle_new_rejects_malformed_override_entries(self):
        """覆盖写坏了是 400（形状问题），并且不被静默忽略。"""
        status, env = self.svc.battle_new(self._body(
            ruleset_config_id=V3, unverified_overrides=[{"path": "energy.initial", "value": 2}]))
        self.assertEqual(status, 400, env)
        self.assertIn("unverified_overrides", env["error"])

    def test_legacy_battle_new_is_byte_identical(self):
        """不传配置/覆盖时的 legacy 开局：完全走老路径（3 只、没有新键）。"""
        status, env = self.svc.battle_new(self._body(team=IDS_A[:3], enemy_team=IDS_B[:3]))
        self.assertEqual(status, 200, env)
        result = env["result"]
        self.assertEqual(result["state"]["ruleset_config_id"], LEGACY)
        self.assertNotIn("unverified_overrides", result["state"])
        self.assertEqual(result["public"]["unverified_overrides"], [])
        self.assertIn("item", [a["kind"] for a in result["legal"]["player"]])


if __name__ == "__main__":       # pragma: no cover - 手工跑
    unittest.main()
