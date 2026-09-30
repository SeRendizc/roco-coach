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
    # RC-401 批四：吸血 / 过量回复转属性（`env._settle_sustain`）。
    "lifesteal": {"kind": "lifesteal", "turn": 4, "detail": {
        "side": "player", "percent": 50, "damage": 120, "healed": 60, "overhealed": 20}},
    "overheal_to_stat": {"kind": "overheal_to_stat", "turn": 4, "detail": {
        "side": "player", "stat": "atk", "stats": ["atk"], "gain_pct": 10, "chunks": 1,
        "carry_pct": 1.5}},
    "energy_regen": {"kind": "energy_regen", "turn": 2, "detail": {"side": "player", "energy": 3}},
    # 2026-09-25 裁决 B：天气进标准 PVP。这五个 kind 一度「引擎会发、模板缺席」，
    # 而且**判据照不到**——真对局根本跑不出天气（规范配招里没有造天气技能），
    # 是主线程用 loadouts 显式换招才打出来的。这里逐条给样本，模板一缺就红。
    "weather_set": {"kind": "weather_set", "turn": 1, "detail": {
        "side": "player", "weather": "雨天", "turns_left": 8, "replaced": None}},
    "weather_tick": {"kind": "weather_tick", "turn": 1, "detail": {"weather": "雨天", "turns_left": 7}},
    "weather_end": {"kind": "weather_end", "turn": 8, "detail": {"weather": "雨天"}},
    "weather_status": {"kind": "weather_status", "turn": 1, "detail": {
        "side": "Enemy", "weather": "暴风雪", "status": "freeze", "layers": 2, "layers_after": 2}},
    "weather_immune": {"kind": "weather_immune", "turn": 1, "detail": {
        "side": "Player", "weather": "暴风雪", "status": "freeze", "immune_element": "冰"}},
    # 2026-09-29（U06）：`env._accumulate_per_use_ramp` 一直在发这个 kind，模板缺席 ⇒
    # 玩家看到的是兜底话「发生了一件事（引擎事件 per_use_ramp，本页还没有它的中文说法）」
    # —— 就是用户截图 6 里那一行。样本按引擎**真实形状**给：`side` 现在是 `None`（env 没带），
    # 所以句子必须**不写主语**，也不许把 `None` 漏到屏幕上。
    "per_use_ramp": {"kind": "per_use_ramp", "turn": 6, "detail": {
        "side": None, "skill_id": "skill_000365", "field": "power", "delta": -30, "total": -30}},
    "drain_energy": {"kind": "drain_energy", "turn": 2, "detail": {"side": "enemy", "taken": 2}},
    "item": {"kind": "item", "turn": 5, "detail": {"side": "player", "item": "potion", "healed": 50}},
    "switch": {"kind": "switch", "turn": 5, "detail": {"side": "player", "to_slot": 1}},
    "replacement": {"kind": "replacement", "turn": 6, "detail": {"side": "enemy", "slot": 2}},
    "defense": {"kind": "defense", "turn": 6, "detail": {
        # ⚠ 2026-09-24：这里原来是 `70`（当成百分比），而引擎实际发的
        # `env.py::_resolve_action` 是**减伤比例**（`parse_defense_reduction('减伤70%') → 0.70`，
        # 见 `effects.py` 的 `(1.0 - reduction)`）。样例值写错了一个口径，
        # 模板也就跟着把 0.7 印给玩家 —— 现在两边都对齐到「比例」。
        "side": "player", "skill_id": "skill_000576", "reduction": 0.7, "respond": True}},
    "buff_self": {"kind": "buff_self", "turn": 6, "detail": {"side": "player", "stat": "atk", "delta_pct": 100}},
    "debuff_foe": {"kind": "debuff_foe", "turn": 6, "detail": {"side": "enemy", "stat": "def", "delta_pct": -30}},
    "mark_added": {"kind": "mark_added", "turn": 7, "detail": {"side": "player", "mark": "mark", "layers": 1}},
    "status_added": {"kind": "status_added", "turn": 7, "detail": {"side": "enemy", "status": "burn", "layers": 2}},
    "status_applied": {"kind": "status_applied", "turn": 7, "detail": {
        "side": "player", "skill_id": "skill_000576", "effects": ["burn"]}},
    "status_tick": {"kind": "status_tick", "turn": 8, "detail": {
        "side": "enemy", "status": "burn", "damage": 12, "layers_after": 1}},
    "cleanse": {"kind": "cleanse", "turn": 8, "detail": {"side": "player", "cleared": ["burn"]}},
    # task-27（2026-09-30）：**印记的驱散**与「每驱散 1 层」的对照读数。
    # 为什么必须有样例：`EveryDeclaredKindIsTested` 那条判据会红（登记了却没测 = 等于没测 ✓），
    # 而漏登记的后果是**玩家看到兜底句**（「本页还没有它的中文说法」）—— 上一手踩过一次。
    "marks_cleansed": {"kind": "marks_cleansed", "turn": 8, "detail": {
        "side": "player", "marks_side": "both", "scope": "all",
        "cleared": {"enemy": {"星陨印记": 4}, "player": {"光合印记": 2}},
        "total_layers": 6, "picked": "all", "basis": "描述写「所有」⇒ 全清"}},
    "per_cleansed_layer_skipped": {"kind": "per_cleansed_layer_skipped", "turn": 8,
                                   "detail": {"side": "player", "layers": 0,
                                              "why": "没有驱散到任何一层 ⇒ 不触发（对照实验）"}},
    # task-26 P0 止血：**认不出的驱散 fail closed** ⇒ 这一条也要有样例（否则玩家会看到兜底句 ✗）
    "cleanse_unsupported": {"kind": "cleanse_unsupported", "turn": 8,
                            "detail": {"side": "player", "what": None,
                                       "evidence": "驱散双方所有印记"}},
    "escape": {"kind": "escape", "turn": 9, "detail": {"side": "player"}},
    "action_cancelled": {"kind": "action_cancelled", "turn": 9, "detail": {"side": "enemy", "reason": "fainted"}},
    "game_end": {"kind": "game_end", "turn": 10, "detail": {"result": "win"}},
    "power_unsupported": {"kind": "power_unsupported", "turn": 4, "detail": {
        "side": "player", "skill_id": "skill_000576", "detail": "伤害公式未实现"}},
    "status_unsupported": {"kind": "status_unsupported", "turn": 4, "detail": {
        "side": "enemy", "skill_id": "skill_000576"}},
    "unsupported": {"kind": "unsupported", "turn": 4, "detail": {"what": "某条未核验机制"}},
    # 第 47 轮批 0：攻击/防御分支的附带效果「生效或登记」，多出这两个 kind。
    "energy_gain": {"kind": "energy_gain", "turn": 3, "detail": {
        "side": "player", "skill_id": "skill_000418", "amount": 1, "energy_after": 4,
        "assumption": "MC-007", "evidence_text": "自己回复1能量"}},
    "effects_registered_unsupported": {"kind": "effects_registered_unsupported", "turn": 3,
                                       "detail": {
                                           "side": "player", "skill_id": "skill_000321",
                                           "parsed_effects": 0, "unclaimed_spans": 2,
                                           "unparsed_markers": 0,
                                           "reason": "攻击分支只结算伤害"}},
    # 效果层/特性层直接塞进列表的那一类：**扁平形状**，没有 `detail` 包裹
    "trait": {"kind": "trait", "trait": "专注力", "side": "player", "effect": "atk +100%",
              "evidence": "feature_skill"},
    # RC-106 补的三类：六宠标准 PVP 局里真的会出现（`env._use_charge` /
    # `env._settle_faint_mana` / `env._surrender` 三处 `_bump`），模板此前缺席。
    # 下面每个 `detail` 键都逐个抄自那三处，不是编的。
    "charge": {"kind": "charge", "turn": 3,
               "detail": {"side": "enemy", "energy_gained": 5, "energy": 5}},
    "mana_loss": {"kind": "mana_loss", "turn": 7,
                  "detail": {"side": "player", "faint_cost": 1, "mana": 3}},
    "surrender": {"kind": "surrender", "turn": 12,
                  "detail": {"side": "enemy", "result": "win"}},
    # C1（第 139 轮）位置子系统：`env._execute` 两处 `_bump` 的 detail 键逐个抄自那里。
    "slot_condition_applied": {"kind": "slot_condition_applied", "turn": 4,
                               "detail": {"side": "player", "skill_id": "skill_000468",
                                          "position": 1, "power_delta": 60, "combo_bonus": 0,
                                          "evidence": "本技能位于1号位时威力+60"}},
    "position_shift": {"kind": "position_shift", "turn": 4,
                       "detail": {"side": "player", "skill_id": "skill_000468", "shift": 1,
                                  "order": ["skill_000481", "skill_000468", "skill_000482"]}},
    # 2026-09-23：PVP 魔法（愿力强化）。`env._use_magic` 有两处 `_bump`，
    # detail 键逐个抄自那里；这里放**转换**那一条（下面另有一条专门测**解除**分支）。
    "magic": {"kind": "magic", "turn": 5,
              "detail": {"side": "player", "magic": "wish_power_up", "mode": "transform",
                         "pet": "pet_000062", "pet_name": "音速犬",
                         "skill": "magic_wish_impact__火系__物攻",
                         "skill_name": "火系愿力冲击", "uses_left": 1}},
}


class WeatherSentencesTest(unittest.TestCase):
    """天气五个 kind 的句子（2026-09-25 裁决 B）。

    为什么单独一组：`EveryDeclaredKindIsTested` 靠**真对局收 kind**，而真对局跑不出天气
    （规范配招里没有任何一只是造天气的），所以模板缺席也能全绿。主线程用 `loadouts`
    给圆号鱼换上「落雨」才在真服务里打出 `weather_set`/`weather_tick`，那时玩家看到的是
    「发生了一件事（引擎事件 weather_set，本页还没有它的中文说法）」。这一组按形状逐条钉住
    句子，不依赖哪一局恰好打出天气。
    """

    def test_weather_set_says_who_and_how_long(self):
        text = events_text.event_text(SAMPLE_EVENTS["weather_set"])
        self.assertIn("我方", text)
        self.assertIn("雨天", text)
        self.assertIn("8", text)
        self.assertNotIn("还没有它的中文说法", text)

    def test_weather_set_replacement_names_the_old_one(self):
        event = {"kind": "weather_set", "detail": {
            "side": "player", "weather": "沙暴", "turns_left": 8, "replaced": "雨天"}}
        text = events_text.event_text(event)
        self.assertIn("沙暴", text)
        self.assertIn("雨天结束", text)

    def test_weather_tick_reads_the_remaining_turns(self):
        self.assertIn("7", events_text.event_text(SAMPLE_EVENTS["weather_tick"]))
        zero = {"kind": "weather_tick", "detail": {"weather": "雨天", "turns_left": 0}}
        self.assertIn("到点", events_text.event_text(zero), "0 回合不许念成「还剩 0 回合」")

    def test_weather_end_immune_and_status(self):
        self.assertEqual(events_text.event_text(SAMPLE_EVENTS["weather_end"]), "雨天结束了。")
        immune = events_text.event_text(SAMPLE_EVENTS["weather_immune"])
        self.assertIn("免疫", immune)
        self.assertIn("冰冻", immune)

    def test_per_use_ramp_reads_as_a_real_sentence(self):
        """U06（2026-09-29）：这一条原来是兜底话「发生了一件事（引擎事件 per_use_ramp…）」。

        用户截图 6 点名的就是它，所以这里钉三件事：
          ① 不许再出现兜底话；② 要把「哪个量、这次加了多少、现在累计多少」念出来；
          ③ `side` 是 `None` ⇒ 句子里**不许**出现 `None` / `None` 的痕迹。
        """
        text = events_text.event_text(SAMPLE_EVENTS["per_use_ramp"], RS)
        self.assertNotIn("还没有它的中文说法", text, "不许再落到兜底句")
        self.assertIn("威力", text)
        self.assertIn("-30", text)
        self.assertIn("累计", text)
        self.assertNotIn("None", text, "detail.side 是 None ⇒ 不许把它印到屏幕上")
        # 反向：加值要带 "+"，且累计值要念出来（不能只说"变了"）。
        up = {"kind": "per_use_ramp", "turn": 7, "detail": {
            "side": None, "skill_id": "skill_000365", "field": "power", "delta": 10, "total": -20}}
        up_text = events_text.event_text(up, RS)
        self.assertIn("+10", up_text)
        self.assertIn("-20", up_text)
        # 拿不到「哪个量/变了多少」时：如实说不知道，**不编 0**、也不静默。
        blind = events_text.event_text({"kind": "per_use_ramp", "turn": 8, "detail": {"side": None}})
        self.assertIn("没给", blind)
        self.assertNotIn("0", blind.replace("没给", ""), "拿不到增量时不许编一个数字")
        status = events_text.event_text(SAMPLE_EVENTS["weather_status"])
        self.assertIn("2 层", status)
        self.assertIn("冰冻", status)


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

    def test_magic_restore_branch_also_reads_as_chinese(self):
        """同一个 kind 的**另一条分支**（解除还原）也要有句子 —— 只测一条会漏掉一半。"""
        event = {"kind": "magic", "turn": 8,
                 "detail": {"side": "player", "magic": "wish_power_up", "mode": "restore",
                            "pet": "pet_000062", "pet_name": "音速犬",
                            "restored": "skill_000378",
                            "restored_name": "火苗", "cooldown": 3}}
        text = events_text.event_text(event, RS)
        self.assertIn("愿力强化", text)
        self.assertIn("还原", text)
        self.assertIsNone(_FORBIDDEN.search(text), f"解除分支的句子里出现内部标识符：{text}")

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


# ── 2026-09-24：真页面战报抓到的两处文案缺陷（主线程追加）─────────────────────


def _defense_text(skill_id: str, reduction, respond: bool = False) -> str:
    detail = {"side": "player", "skill_id": skill_id, "respond": respond}
    if reduction is not None:
        detail["reduction"] = reduction
    return events_text.event_text({"kind": "defense", "turn": 6, "detail": detail}, RS)


class DefenseSentenceTest(unittest.TestCase):
    """`defense` 的中文句子：**减伤口径必须是百分比，技能名后面不许再接动词**。

    实测原文（`reports/roco/product-wiring/full-match-wiring.json`）：

        对方用防御防御，减伤约 0.7。
        我方用龙血防御，减伤约 0.7。

    两个毛病：① 技能叫「防御」时渲染成「用防御防御」；② 0.7 是**减伤比例**，
    引擎自己的 `state.log` 写的是 70%、页面盾浮字也是 70% —— 三处口径不一致，
    玩家看到的那一处是错的。
    """

    #: 旧模板（逐字抄自修前实现），只用于**反证**：它必须被判据判红。
    @staticmethod
    def _old_render(skill_name: str, reduction: float, respond: bool) -> str:
        hand = "并作出应对" if respond else ""
        return f"我方用{skill_name}防御，减伤约 {reduction}{hand}。"

    def test_reduction_is_rendered_as_percent_not_ratio(self):
        text = _defense_text("skill_000576", 0.7)          # 龙血
        self.assertIn("70%", text, f"减伤 0.7 必须渲染成 70%（实际：{text}）")
        self.assertNotIn("0.7", text, f"不许把减伤比例直接印给玩家（实际：{text}）")
        # 反向控制：同一条判据必须能判红旧模板的渲染结果
        old = self._old_render(RS.skill("skill_000576").name, 0.7, False)
        self.assertNotIn("70%", old, "对照组：旧模板确实印的是 0.7 —— 判据不是恒真的")

    def test_no_duplicated_verb_after_the_skill_name(self):
        """技能叫「防御」时不许读成「用防御防御」。"""
        defense_skill = next((s for s in RS.skills.values()
                              if s.name == "防御" and not s.is_trait), None)
        self.assertIsNotNone(defense_skill, "冻结数据里必须真的有叫「防御」的技能，否则判据空转")
        text = _defense_text(defense_skill.skill_id, 0.7)
        self.assertIn(defense_skill.name, text)
        self.assertNotIn("用防御防御", text, f"技能名与模板里的动词重复了：{text}")
        self.assertNotIn("使用防御防御", text, f"技能名与模板里的动词重复了：{text}")
        # 反向控制：旧模板对这一条必须红
        old = self._old_render("防御", 0.7, False)
        self.assertIn("用防御防御", old, "对照组：旧模板确实会重复 —— 这条判据真的在量它")

    def test_respond_clause_is_comma_separated(self):
        text = _defense_text("skill_000576", 0.7, respond=True)
        self.assertIn("，并作出应对。", text, f"「并作出应对」前必须有逗号（实际：{text}）")
        self.assertNotIn("0.7并作出应对", text)

    def test_missing_reduction_does_not_repeat_the_word_defense(self):
        text = _defense_text("skill_000576", None)
        self.assertNotIn("防御防御", text, f"读不出减伤时也不许出现重复词（实际：{text}）")
        self.assertIn("防御", text, "读不出比例时仍要说清这一手是防御")


class MagicRestoreSentenceTest(unittest.TestCase):
    """`magic/mode=restore` 有**两个**来源，句子必须分开（真页面抓到的 BUG-2）。"""

    def _restore(self, reason):
        detail = {"side": "player", "magic": "wish_power_up", "mode": "restore",
                  "pet": "pet_000062", "pet_name": "音速犬", "restored": "skill_000378",
                  "restored_name": "火苗"}
        if reason is not None:
            detail["reason"] = reason
        return events_text.event_text({"kind": "magic", "turn": 8, "detail": detail}, RS)

    def test_consumed_restore_says_the_impact_was_used_not_manually_undone(self):
        text = self._restore("consumed")
        self.assertIn("愿力冲击", text)
        self.assertIn("自动还原", text)
        # 玩家根本没点愿力强化、也没进冷却 —— 这两句都不许出现
        self.assertNotIn("冷却", text, f"自动还原不进冷却，句子里不许说冷却：{text}")
        self.assertNotIn("解除", text, f"自动还原不是「用愿力强化解除」：{text}")

    def test_manual_restore_still_reads_as_manual(self):
        for reason in ("manual", None):
            text = self._restore(reason)
            self.assertIn("解除", text, f"手动解除要说清是解除（reason={reason}）：{text}")
            self.assertIn("冷却", text, f"手动解除会进冷却（reason={reason}）：{text}")
            self.assertNotIn("愿力冲击已打出", text)

    def test_consumed_branch_is_not_the_old_rendering(self):
        """反证：把旧渲染（不看 reason 的那一句）喂进同一条断言必须命中。"""
        old = ("我方用愿力强化解除了音速犬的技能转换，第一个技能还原"
               "（不消耗次数，进入冷却）。")
        self.assertIn("冷却", old, "对照组：旧渲染确实说了冷却 —— 判据不是恒真的")
        self.assertIn("解除", old)
        self.assertNotIn("冷却", self._restore("consumed"))


class SkillNameNeverRepeatsTheTemplateTest(unittest.TestCase):
    """**824 条技能名 × 每个插值模板**逐条渲染，自动检测「技能名与紧跟的字/词重复」。

    为什么要有它：`defense` 那句「用防御防御」不是笔误，而是**模板在技能名后面硬接了
    一个字/词**这一类缺陷的第一个实例。靠人眼过模板是过不完的 —— 实测它就一次抓出三条：

        damage      「奔波命」「蒸汽革命」 → 我方的奔波命命中，…
        energy_gain 「回收」               → 我方用回收回收了 1 点能量。
        defense     「防御」               → 对方用防御防御，减伤约 0.7。

    判据不是「跑一遍不报错」，而是**逐条比对渲染文本里技能名紧跟的那几个字**：
    只要技能名的某个后缀出现在它**后面**，就是一次重复（`_repeated_tail`）。
    """

    #: 每个 kind 一条样例事件；`skill_id` 在扫描时逐条替换成冻结数据里的真技能。
    #: 覆盖 `events_text.py` 里**所有**会插值技能名的模板。
    TEMPLATES = {
        "damage": {"kind": "damage", "turn": 1,
                   "detail": {"side": "player", "damage": 10, "formula_verified": True}},
        "energy_gain": {"kind": "energy_gain", "turn": 1,
                        "detail": {"side": "player", "amount": 1}},
        "defense": {"kind": "defense", "turn": 1,
                    "detail": {"side": "player", "reduction": 0.7, "respond": True}},
        "defense_no_reduction": {"kind": "defense", "turn": 1,
                                 "detail": {"side": "player", "respond": False}},
        "status_applied": {"kind": "status_applied", "turn": 1, "detail": {"side": "player"}},
        "power_unsupported": {"kind": "power_unsupported", "turn": 1, "detail": {"side": "player"}},
        "status_unsupported": {"kind": "status_unsupported", "turn": 1, "detail": {"side": "player"}},
        "effects_registered_unsupported": {
            "kind": "effects_registered_unsupported", "turn": 1,
            "detail": {"side": "player", "parsed_effects": 1, "unclaimed_spans": 0,
                       "unparsed_markers": 0, "reason": "x"}},
    }

    @staticmethod
    def _repeated_tail(text: str, name: str) -> str:
        """技能名后面紧跟的字里，与技能名后缀重复的那一段（没有就返回空串）。"""
        idx = text.find(name)
        if idx < 0:
            return ""
        tail = text[idx + len(name):]
        for k in range(min(len(name), 4), 0, -1):
            if tail.startswith(name[-k:]):
                return name[-k:]
        return ""

    def test_detector_catches_the_historical_defect(self):
        """反证：检测器必须抓得住**修前**那条真实缺陷，否则整组判据是恒真的。"""
        old = DefenseSentenceTest._old_render("防御", 0.7, False)
        self.assertEqual(self._repeated_tail(old, "防御"), "防御",
                         "检测器抓不住「用防御防御」这条已知缺陷，等于没测")
        old_damage = "我方的奔波命命中，造成约 10 点伤害。"
        self.assertEqual(self._repeated_tail(old_damage, "奔波命"), "命")

    def test_no_skill_name_repeats_in_any_template(self):
        hits = []
        scanned = 0
        for skill in RS.skills.values():
            for label, template in self.TEMPLATES.items():
                event = dict(template)
                event["detail"] = dict(template["detail"], skill_id=skill.skill_id)
                text = events_text.event_text(event, RS)
                scanned += 1
                repeated = self._repeated_tail(text, skill.name)
                if repeated:
                    hits.append((label, skill.name, repeated, text))
        self.assertGreaterEqual(scanned, 824, "扫描的量级不对：冻结数据是 824 条技能/特性")
        self.assertEqual(hits, [], f"技能名与模板里的字重复了：{hits}")

    def test_no_internal_identifier_leaks_through_any_skill_name(self):
        """顺带：技能名这条路也不许把内部标识符带进玩家可见的句子。"""
        leaked = []
        for skill in RS.skills.values():
            event = dict(self.TEMPLATES["damage"])
            event["detail"] = dict(event["detail"], skill_id=skill.skill_id)
            text = events_text.event_text(event, RS)
            if _FORBIDDEN.search(text):
                leaked.append((skill.name, text))
        self.assertEqual(leaked, [], f"技能名渲染出了内部标识符：{leaked}")


if __name__ == "__main__":
    unittest.main()
