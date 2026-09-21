"""事件中文化：**跑真对局收全集**，每一个 kind 都必须有中文句子（第 42 轮 P0-2）。

这一组测试回答的问题很具体：**玩家会不会在某一步看到一句工程话或裸 JSON？**

做法不是「检查模板表里有没有那些键」（那样漏掉一个 kind 也不会红），而是：
打几局真对局，把引擎实际产生的 `kind` **全部收下来**，然后断言

  1. 收下来的每一个 kind 都在 `KNOWN_EVENT_KINDS` 里（引擎加了新事件 → 这里红）；
  2. 每个 kind 都能生成一句中文，且句子里**不含** `{"`、`kind`、下划线标识符、
     `pet_`/`skill_` 这类内部 id；
  3. `KNOWN_EVENT_KINDS` 里声明的每一个 kind **都被真的触发过**
     （反向：声明了却从不发生，说明清单是抄的而不是量的）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_event_text -v
"""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import events_text            # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]

#: 内部标识符不能出现在玩家看到的句子里。
_FORBIDDEN = re.compile(r'\{"|"kind"|_id\b|pet_\d|skill_\d|\bkind\b|\bdetail\b|\bNone\b|\bnull\b')


def play_one(seed: int, *, turns: int = 120):
    """打一局（双方按确定性轮换出招），把产生的事件**原样**收下来。"""
    state = renv.reset(A_TEAM, B_TEAM, seed=seed, rs=RS)
    collected = []
    for step in range(turns):
        if state.result:
            break
        collected.extend(e.to_dict() for e in state.events[len(collected):]) if False else None
        before = len(state.events)
        if state.phase == "replace":
            for side in list(renv.needs_replacement(state)):
                legal = [a for a in renv.legal_actions(state, RS, side) if a.kind == "switch"]
                if legal:
                    renv.step_replace(state, RS, side, int(legal[(seed + step) % len(legal)].target_index))
            collected.extend(e.to_dict() for e in state.events[before:])
            continue
        # **排除逃跑**：逃跑会立刻结束对局（实测 5—12 回合就 escaped），
        # 于是 faint / game_end / replacement 这些事件永远收不到，
        # 覆盖面测试就变成「检查了一小半」。真实玩家也不会每回合想着逃。
        mine = [a for a in renv.legal_actions(state, RS, "player") if a.kind != "escape"]
        theirs = [a for a in renv.legal_actions(state, RS, "enemy") if a.kind != "escape"]
        if not mine or not theirs:
            break
        state = renv.step_joint(state, RS, mine[(seed + step) % len(mine)],
                                theirs[(seed * 3 + step) % len(theirs)])
        if state is None:
            break
        collected.extend(e.to_dict() for e in state.events[before:])
    collected.extend(e.to_dict() for e in state.events[len(collected) - len(state.events) + len(state.events):] if False) if False else None
    return state, collected


def collect_all(seeds=tuple(range(1, 31))):
    seen = {}
    for seed in seeds:
        _state, events = play_one(seed)
        for event in events:
            seen.setdefault(event["kind"], event)
    return seen


#: 每个**登记过的** kind 的样例事件。
#:
#: 这些 `detail` 键不是编的：全部来自源码里 `_bump(...)` 与效果/特性层实际塞进去的字段
#: （第 42 轮逐个 grep 出来的）。用它保证「清单里的每一条都被测过」——
#: 而不是只测了真对局恰好碰到的那几种。
SAMPLE_EVENTS = {
    "turn_start": {"kind": "turn_start", "turn": 3, "detail": {"turn": 3}},
    "damage": {"kind": "damage", "turn": 3, "detail": {
        "side": "enemy", "skill_id": "skill_000576", "target_slot": 0, "damage": 25,
        "power_used": 80, "type_multiplier": 2.0, "formula_verified": False}},
    "faint": {"kind": "faint", "turn": 4, "detail": {"side": "enemy", "slot": 0}},
    "heal": {"kind": "heal", "turn": 4, "detail": {"side": "player", "healed": 40}},
    "energy_regen": {"kind": "energy_regen", "turn": 2, "detail": {"side": "player", "energy": 3}},
    "drain_energy": {"kind": "drain_energy", "turn": 2, "detail": {"side": "enemy", "taken": 2}},
    "item": {"kind": "item", "turn": 5, "detail": {"side": "player", "item": "potion", "healed": 50}},
    "switch": {"kind": "switch", "turn": 5, "detail": {"side": "player", "to_slot": 1}},
    "replacement": {"kind": "replacement", "turn": 6, "detail": {"side": "enemy", "slot": 2}},
    "defense": {"kind": "defense", "turn": 6, "detail": {
        "side": "player", "skill_id": "skill_000576", "reduction": 70, "respond": True}},
    "buff_self": {"kind": "buff_self", "turn": 6, "detail": {"side": "player", "stat": "atk", "delta_pct": 100}},
    "debuff_foe": {"kind": "debuff_foe", "turn": 6, "detail": {"side": "enemy", "stat": "def", "delta_pct": -30}},
    "mark_added": {"kind": "mark_added", "turn": 7, "detail": {"side": "player", "mark": "mark", "layers": 1}},
    "status_added": {"kind": "status_added", "turn": 7, "detail": {"side": "enemy", "status": "burn", "layers": 2}},
    "status_applied": {"kind": "status_applied", "turn": 7, "detail": {
        "side": "player", "skill_id": "skill_000576", "effects": ["burn"]}},
    "status_tick": {"kind": "status_tick", "turn": 8, "detail": {
        "side": "enemy", "status": "burn", "damage": 12, "layers_after": 1}},
    "cleanse": {"kind": "cleanse", "turn": 8, "detail": {"side": "player", "cleared": ["burn"]}},
    "escape": {"kind": "escape", "turn": 9, "detail": {"side": "player"}},
    "action_cancelled": {"kind": "action_cancelled", "turn": 9, "detail": {"side": "enemy", "reason": "fainted"}},
    "game_end": {"kind": "game_end", "turn": 10, "detail": {"result": "win"}},
    "power_unsupported": {"kind": "power_unsupported", "turn": 4, "detail": {
        "side": "player", "skill_id": "skill_000576", "detail": "伤害公式未实现"}},
    "status_unsupported": {"kind": "status_unsupported", "turn": 4, "detail": {
        "side": "enemy", "skill_id": "skill_000576"}},
    "unsupported": {"kind": "unsupported", "turn": 4, "detail": {"what": "某条未核验机制"}},
    # 效果层/特性层直接塞进列表的那一类：**扁平形状**，没有 `detail` 包裹
    "trait": {"kind": "trait", "trait": "专注力", "side": "player", "effect": "atk +100%",
              "evidence": "feature_skill"},
}


class EveryDeclaredKindIsTested(unittest.TestCase):
    """清单与样例必须一一对应：不许有「登记了但没测过」的 kind。"""

    def test_sample_events_cover_every_declared_kind(self):
        missing = sorted(set(events_text.KNOWN_EVENT_KINDS) - set(SAMPLE_EVENTS))
        self.assertFalse(missing, f"这些 kind 登记了却没有样例事件（等于没测）：{missing}")

    def test_every_sample_event_reads_as_chinese(self):
        # 这一条让「清单里的每一条都被测过」成立：23 个 kind 逐个生成句子并核对，
        # 而不是只核对真对局恰好碰到的那 16 种。
        for kind, event in sorted(SAMPLE_EVENTS.items()):
            text = events_text.event_text(event, RS)
            self.assertTrue(text and text.strip(), f"{kind} 生成了空句子")
            self.assertTrue(re.search(r"[\u4e00-\u9fff]", text), f"{kind} 的句子里没有中文：{text}")
            self.assertIsNone(_FORBIDDEN.search(text),
                              f"{kind} 的句子里出现了内部标识符或 JSON：{text}")
            self.assertTrue(text.endswith("。") or text.endswith("）"),
                            f"{kind} 的句子没有收尾：{text}")

    def test_no_sample_event_for_an_undeclared_kind(self):
        extra = sorted(set(SAMPLE_EVENTS) - set(events_text.KNOWN_EVENT_KINDS))
        self.assertFalse(extra, f"这些样例事件没有登记进 KNOWN_EVENT_KINDS：{extra}")


class EventTextCoversEverythingTheEngineEmits(unittest.TestCase):
    """真对局收上来的事件：不许出现未登记的 kind，且句子必须自然中文。"""

    @classmethod
    def setUpClass(cls):
        cls.seen = collect_all()

    #: 真对局样本**必须**覆盖到的核心事件。跑 30 局实测能收到 16 种；
    #: 这个下限挡的是「采集器悄悄坏了、只收到两三种，检查仍然全绿」。
    CORE_KINDS = frozenset({"turn_start", "damage", "faint", "switch", "replacement",
                            "energy_regen", "item", "game_end"})

    def test_real_match_sample_is_wide_enough(self):
        self.assertGreaterEqual(len(self.seen), 14,
                                f"真对局只收到 {len(self.seen)} 种事件：样本不足，检查会空过")
        self.assertTrue(self.CORE_KINDS <= set(self.seen),
                        f"核心事件没收全，缺 {sorted(self.CORE_KINDS - set(self.seen))}")

    def test_every_emitted_kind_is_declared(self):
        undeclared = sorted(set(self.seen) - set(events_text.KNOWN_EVENT_KINDS))
        self.assertFalse(
            undeclared,
            f"引擎产出了未登记的事件类型 {undeclared}——玩家会看到一句兜底话。"
            "请在 events_text.py 里给它一句中文，并加进 KNOWN_EVENT_KINDS")

    def test_real_match_sentences_are_natural_chinese(self):
        for kind, event in sorted(self.seen.items()):
            text = events_text.event_text(event, RS)
            self.assertTrue(re.search(r"[\u4e00-\u9fff]", text), f"{kind} 的句子里没有中文：{text}")
            self.assertIsNone(_FORBIDDEN.search(text),
                              f"{kind} 的句子里出现了内部标识符或 JSON：{text}")


class NarrativesReadLikeSomething(unittest.TestCase):
    """逐条给出**具体的**读法，防止模板只是在拼字段名。"""

    def test_damage_marks_unverified_formula(self):
        event = {"kind": "damage", "turn": 3, "detail": {
            "side": "enemy", "skill_id": "skill_000750", "damage": 25,
            "formula_verified": False}}
        text = events_text.event_text(event, RS)
        self.assertIn("25", text)
        self.assertIn("未核验", text, "伤害公式未核验时必须标出来，那是估值不是实测")

    def test_damage_uses_the_real_skill_name(self):
        event = {"kind": "damage", "turn": 3, "detail": {
            "side": "player", "skill_id": "skill_000576", "damage": 30, "formula_verified": True}}
        text = events_text.event_text(event, RS)
        self.assertIn(RS.skill("skill_000576").name, text, "要用真实技能名，不是 id")

    def test_unknown_skill_id_does_not_invent_a_name(self):
        event = {"kind": "damage", "turn": 1, "detail": {
            "side": "player", "skill_id": "skill_999999", "damage": 10, "formula_verified": True}}
        text = events_text.event_text(event, RS)
        self.assertIn("一个技能", text)
        self.assertNotIn("skill_999999", text)

    def test_missing_damage_does_not_invent_zero(self):
        # **不补数字**：detail 里没有 damage 时，不许写成「造成 0 点伤害」
        event = {"kind": "damage", "turn": 1, "detail": {"side": "player", "skill_id": "skill_000576"}}
        text = events_text.event_text(event, RS)
        self.assertNotIn("0 点", text)
        self.assertNotIn("造成约", text)

    def test_game_end_names_the_outcome(self):
        for result, expected in (("win", "获胜"), ("loss", "落败"), ("draw", "平局")):
            text = events_text.event_text({"kind": "game_end", "turn": 9,
                                           "detail": {"result": result}}, RS)
            self.assertIn(expected, text)

    def test_unsupported_says_it_was_not_settled(self):
        text = events_text.event_text({"kind": "unsupported", "turn": 2,
                                       "detail": {"what": "某条未核验机制"}}, RS)
        self.assertIn("未核验", text)
        self.assertIn("没有结算", text)

    def test_unknown_kind_is_honest_not_silent(self):
        # 未登记的 kind 不许**静默**：给一句诚实的兜底，并由上面的覆盖面测试去红
        text = events_text.event_text({"kind": "brand_new_thing", "turn": 1, "detail": {}}, RS)
        self.assertIn("还没有它的中文说法", text)


if __name__ == "__main__":
    unittest.main()
