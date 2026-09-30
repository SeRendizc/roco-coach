"""task-27：**印记的驱散**（B/E）+ **驱散自己的减益**（C）的判据（2026-09-30）。

五条都要（缺一条就是半成品）：**能跑通 · 判据绿 · 运行时报据 · 反证 · 对照实验**。

覆盖范围（本批）：
  · **B** 印记驱散：`408 焚烧烙印`（双方所有）· `332 倾泻`（双方所有）· `650 翅刃`（敌方所有）
    · `415 焚尽`（自己所有）· `652 食腐`（敌方**一个** ⇒ 按层数最多，带 picked+basis）
  · **E** 消费者：`408`（每驱散 1 层 ⇒ 敌方 5 层灼烧）· `415`（每层 ⇒ 物攻+50%）· `652`（每层 ⇒ 回血 10%）
  · **C** 驱散自己的减益：`441/719/446/409`
**未做**（如实点名，见文档）：**D**（`703 飞羽` / `628 溶解`「驱散敌方 1 种增益」）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_cleanse_marks -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata              # noqa: E402
from roco_env import env as renv                # noqa: E402
from roco_env import parse as parse_mod         # noqa: E402
from roco_env import rule_config as RC          # noqa: E402
from roco_env.schema import ACTION_SKILL        # noqa: E402

RS = rdata.load_ruleset()
CFG = RC.get_rule_config("mobile_s4_candidate_v3")      # 声明了 damage.cleanse_marks
V2 = RC.get_rule_config("mobile_s4_candidate_v2")       # 没声明 ⇒ 连结构都不产出
TEAM = ["pet_000062", "pet_000002", "pet_000040", "pet_000083", "pet_000086", "pet_000127"]
FOES = ["pet_000550", "pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000124"]
BURN, EXHAUST, SCAVENGE, BAPTISM = "skill_000408", "skill_000415", "skill_000652", "skill_000441"
FEATHER, MELT = "skill_000703", "skill_000628"


def _learn(pid: str) -> set:
    learn = RS.learnsets.get(pid)
    out = set()
    for attr in ("native", "blood", "stones"):
        values = getattr(learn, attr, None)
        if values:
            out |= {str(x) for x in values}
    return out


def _cast(skill_id, *, self_marks=None, foe_marks=None, self_buffs=None, foe_buffs=None,
          hp_loss=0, enemy_attack=False, cfg=CFG):
    """把这一手真打出去，返回 `(事件列表, 之后的状态快照)`。"""
    owner = next(p for p in RS.pets if skill_id in _learn(p))
    team = [owner] + TEAM[1:]
    fillers = [x for x in sorted(_learn(owner)) if x != skill_id][:3]
    state = renv.reset(team, FOES, seed=7, rs=RS,
                       loadouts={owner: [skill_id] + fillers}, config=cfg)
    me, foe = state.player.field_pet, state.enemy.field_pet
    me.marks.update(self_marks or {})
    foe.marks.update(foe_marks or {})
    me.buffs.update(self_buffs or {})
    foe.buffs.update(foe_buffs or {})
    if hp_loss:
        me.hp = max(1, me.hp - hp_loss)
    actions = [a for a in renv.legal_actions(state, RS, "player", cfg)
               if a.kind == ACTION_SKILL and a.skill_id == skill_id]
    assert actions, f"{skill_id} 不在合法动作里 —— 测试前提不成立"
    enemy = [a for a in renv.legal_actions(state, RS, "enemy", cfg) if a.kind == ACTION_SKILL]
    if enemy_attack:
        attacks = [a for a in enemy if RS.skills[a.skill_id].is_attack]
        assert attacks, "构造前提：对手这一手要有攻击招"
        enemy = attacks
    before = len(state.events)
    state = renv.step_joint(state, RS, actions[0], enemy[0])
    events = [(e.kind, e.detail) for e in state.events[before:]]
    snap = {"self_marks": dict(me.marks), "foe_marks": dict(foe.marks),
            "self_buffs": dict(me.buffs), "foe_buffs": dict(foe.buffs), "self_hp": me.hp,
            "foe_statuses": {k: dict(v) for k, v in foe.statuses.items()}}
    return events, snap


def _of(events, kind):
    return [detail for k, detail in events if k == kind]


class MarksCleanseRuntimeTest(unittest.TestCase):
    """B + E：印记真的被清掉、层数真的被消费者用掉。"""

    def test_burn_clears_both_sides_and_consumes_layers(self):
        events, snap = _cast(BURN, self_marks={"光合印记": 2}, foe_marks={"星陨印记": 4})
        cleansed = _of(events, "marks_cleansed")
        self.assertEqual(len(cleansed), 1, f"应当恰好发一条 marks_cleansed，实际 {events}")
        self.assertEqual(cleansed[0]["cleared"], {"enemy": {"星陨印记": 4}, "player": {"光合印记": 2}})
        self.assertEqual(cleansed[0]["total_layers"], 6)
        self.assertEqual(cleansed[0]["picked"], "all")
        # E：6 层 ⇒ 敌方获得 6×5=30 层灼烧（受本地规则上限 10 约束 ⇒ layers_total=10）
        follow = [d for d in _of(events, "status_added") if d.get("from") == "per_cleansed_layer"]
        self.assertEqual(len(follow), 1)
        self.assertEqual(follow[0]["per_layer"], 5)
        self.assertEqual(follow[0]["cleansed_layers"], 6)
        self.assertEqual(follow[0]["layers"], 30)
        self.assertEqual(follow[0]["layers_total"], 10)
        # 双方印记真的空了
        self.assertEqual(snap["self_marks"], {})
        self.assertEqual(snap["foe_marks"], {})
        # **不许**同时给一句假的"没执行"（老 fail-closed 支）
        self.assertEqual(_of(events, "cleanse_unsupported"), [], "印记清掉了，就不许再说「没有执行」")

    def test_control_no_marks_delta_is_zero(self):
        """对照：没有可驱散物 ⇒ 消费者一次都不触发（Δ=0）。"""
        events, snap = _cast(BURN)
        cleansed = _of(events, "marks_cleansed")
        self.assertEqual(len(cleansed), 1)
        self.assertEqual(cleansed[0]["cleared"], {})
        self.assertEqual(cleansed[0]["total_layers"], 0)
        self.assertEqual(_of(events, "per_cleansed_layer_skipped")[0]["layers"], 0)
        self.assertEqual([d for d in _of(events, "status_added") if d.get("from") == "per_cleansed_layer"],
                         [], "0 层时「每驱散1层」不许触发")
        base = [d for d in _of(events, "status_added") if not d.get("from")]
        self.assertEqual([d["layers"] for d in base], [5], "只该有技能本体那 5 层")
        self.assertEqual(len(_of(events, "status_added")), 1, "消费者不许再发一条")
        # ⚠ 快照是**回合末结算之后**的（灼烧半衰 5→3）—— 别拿它当"技能本体施加了几层"的判据
        self.assertEqual(snap["foe_statuses"].get("灼烧", {}).get("layers"), 3)

    def test_exhaust_consumes_self_marks_into_stat(self):
        events, snap = _cast(EXHAUST, self_marks={"风起印记": 3})
        cleansed = _of(events, "marks_cleansed")[0]
        self.assertEqual(cleansed["cleared"], {"player": {"风起印记": 3}})
        buffs = [d for d in _of(events, "buff_self") if d.get("from") == "per_cleansed_layer"]
        self.assertEqual(buffs[0]["delta_pct"], 150)      # 3 层 × 50%
        self.assertEqual(buffs[0]["cleansed_layers"], 3)
        self.assertEqual(snap["self_marks"], {})

    def test_scavenge_picks_most_layers_and_heals_per_layer(self):
        events, snap = _cast(SCAVENGE, foe_marks={"星陨印记": 2, "湿润印记": 5}, hp_loss=200)
        cleansed = _of(events, "marks_cleansed")[0]
        self.assertEqual(cleansed["scope"], "one")
        self.assertEqual(cleansed["picked"], "most_layers")
        self.assertIn("most_layers", cleansed["basis"] + cleansed["picked"])
        self.assertEqual(cleansed["cleared"], {"enemy": {"湿润印记": 5}}, "没有「所有」⇒ 只清层数最多的一个")
        heals = [d for d in _of(events, "heal") if d.get("from") == "per_cleansed_layer"]
        self.assertEqual(heals[0]["cleansed_layers"], 5)
        self.assertGreater(heals[0]["healed"], 0, "先掉血再用 ⇒ 必须能观察到真实回复")
        self.assertEqual(snap["foe_marks"], {"星陨印记": 2}, "没被选中的印记不许动")


class SelfDebuffCleanseTest(unittest.TestCase):
    """C：驱散自己的减益（4 条）——清的是**自己**身上值为负的 buffs。"""

    def test_baptism_clears_only_own_negative_buffs(self):
        events, snap = _cast(BAPTISM, self_buffs={"atk": -60, "spe": -20, "spa": 40})
        cleansed = _of(events, "cleanse")
        self.assertEqual(len(cleansed), 1, f"应当发一条 cleanse，实际 {events}")
        self.assertEqual(cleansed[0]["cleared"], ["atk", "spe"])
        self.assertEqual(cleansed[0]["target"], "self")
        self.assertEqual(snap["self_buffs"], {"spa": 40}, "增益不许被清掉")

    def test_control_no_debuffs_delta_is_zero(self):
        events, snap = _cast(BAPTISM, self_buffs={"spa": 40})
        cleansed = _of(events, "cleanse")[0]
        self.assertEqual(cleansed["cleared"], [])
        self.assertEqual(snap["self_buffs"], {"spa": 40})


class BuffsOneCleanseTest(unittest.TestCase):
    """D：`驱散敌方 1 种增益`（2 条）—— 选法是**本地规则**，事件必须带 `picked`+`basis`。"""

    def test_feather_picks_largest_abs_positive_only(self):
        events, snap = _cast(FEATHER, foe_buffs={"spa": 40, "atk": -60, "spe": -20})
        rows = _of(events, "cleanse")
        self.assertEqual(len(rows), 1, f"应当恰好一条 cleanse，实际 {events}")
        row = rows[0]
        self.assertEqual(row["cleared"], ["spa"], "只清绝对增幅最大**且为正**的那一个")
        self.assertEqual(row["picked"], "spa")
        self.assertEqual(row["picked_delta"], 40)
        self.assertIn("绝对增幅最大", row["basis"])   # 选法在事件文本里可核（不是悄悄选）
        self.assertEqual(row["from"], "cleanse_buffs_one")
        self.assertIn("ENGINE_HYPOTHESIS", row["basis"], "本地规则必须自报等级")
        self.assertEqual(snap["foe_buffs"], {"atk": -60, "spe": -20}, "减益与未被选中的增益不许动")

    def test_melt_cleanses_only_on_successful_respond(self):
        """`628 溶解` 是**应对招**：只有应对成功才清（条件未成立 ⇒ 不触发）。"""
        events, snap = _cast(MELT, foe_buffs={"spa": 40}, enemy_attack=True)
        self.assertTrue([d for k, d in events if k == "defense" and d.get("respond")],
                        "构造前提：这一手必须应对成功")
        row = _of(events, "cleanse")[0]
        self.assertEqual(row["cleared"], ["spa"])
        self.assertEqual(snap["foe_buffs"], {})

    def test_control_without_buffs_delta_is_zero(self):
        events, snap = _cast(FEATHER)
        row = _of(events, "cleanse")[0]
        self.assertEqual(row["cleared"], [])
        self.assertIsNone(row["picked"])
        self.assertEqual(snap["foe_buffs"], {})

    def test_parser_gated_by_the_capability_bit(self):
        for skill_id in (FEATHER, MELT):
            skill = RS.skills[skill_id]
            declared = {e.kind for e in parse_mod.resolve_cleanse_marks(skill, declared=True).effects}
            not_declared = {e.kind for e in parse_mod.resolve_cleanse_marks(skill, declared=False).effects}
            raw = {e.kind for e in parse_mod.parse_skill(skill).effects}
            self.assertIn("cleanse_buffs_one", declared)
            self.assertNotIn("cleanse_buffs_one", not_declared)
            self.assertEqual(not_declared, raw, f"{skill_id}：未声明时必须与 parse_skill 原始输出逐字相同")


class CapabilityGatingTest(unittest.TestCase):
    """没声明能力位 ⇒ **连结构都不产出**（legacy / v2 的 unsupported 与指纹逐位不变）。"""

    def test_parser_produces_nothing_without_the_bit(self):
        for skill_id in (BURN, EXHAUST, SCAVENGE, BAPTISM):
            skill = RS.skills[skill_id]
            declared = {e.kind for e in parse_mod.resolve_cleanse_marks(skill, declared=True).effects}
            not_declared = {e.kind for e in parse_mod.resolve_cleanse_marks(skill, declared=False).effects}
            raw = {e.kind for e in parse_mod.parse_skill(skill).effects}
            self.assertIn("cleanse_marks" if skill_id != BAPTISM else "cleanse_self_debuffs", declared)
            self.assertNotIn("cleanse_marks", not_declared)
            self.assertNotIn("cleanse_self_debuffs", not_declared)
            self.assertEqual(not_declared, raw, f"{skill_id}：未声明时必须与 parse_skill 原始输出逐字相同")

    def test_v2_battle_has_no_new_events(self):
        events, _ = _cast(BURN, self_marks={"光合印记": 2}, foe_marks={"星陨印记": 4}, cfg=V2)
        kinds = {k for k, _ in events}
        self.assertNotIn("marks_cleansed", kinds)
        self.assertNotIn("per_cleansed_layer_skipped", kinds)

    def test_config_bit_is_declared_in_v3_only(self):
        self.assertTrue(getattr(CFG, "damage_cleanse_marks", False), "v3 必须声明 damage.cleanse_marks")
        self.assertFalse(getattr(V2, "damage_cleanse_marks", False), "v2 不许声明")


class EventTextTest(unittest.TestCase):
    """新事件必须有中文（否则玩家看到兜底句 —— 上一手踩过）。"""

    def test_texts_are_chinese_not_fallback(self):
        from roco_env import events_text as et
        samples = [
            {"kind": "marks_cleansed", "turn": 1, "detail": {
                "side": "player", "cleared": {"enemy": {"星陨印记": 4}}, "total_layers": 4}},
            {"kind": "marks_cleansed", "turn": 1, "detail": {
                "side": "player", "cleared": {}, "total_layers": 0}},
            {"kind": "per_cleansed_layer_skipped", "turn": 1, "detail": {"side": "player", "layers": 0}},
        ]
        for event in samples:
            text = et.event_text(event)
            self.assertNotIn("本页还没有它的中文说法", text, f"{event['kind']} 缺中文模板")
            self.assertTrue(text.strip())
        self.assertIn("marks_cleansed", et.KNOWN_EVENT_KINDS)
        self.assertIn("per_cleansed_layer_skipped", et.KNOWN_EVENT_KINDS)


if __name__ == "__main__":
    unittest.main()


class BuffsLayersCleanseTest(unittest.TestCase):
    """RC-401 批次十八（2026-09-30 **E 族缺口一**）：`322 消毒法`「驱散敌方5层增益」。

    量纲是**层数**（与 `cleanse_buffs_one` 的「N 种」**分开**）。本地规则（ENGINE_HYPOTHESIS）：
    **一层 = 一个非零增益键**，按 `abs(百分比)` 从大到小最多清 N 层。
    """

    def test_dispel_n_layers_positive(self):
        """正例：两个正增益 ⇒ 请求 5 层、实清 2 层（**先清绝对值大的**）。"""
        ev, snap = _cast("skill_000322", foe_buffs={"spa": 70, "def": 30})
        c = _of(ev, "cleanse")[0]
        self.assertEqual(c["from"], "cleanse_buffs_layers")
        self.assertEqual(c["cleared"], ["spa", "def"], "两个正增益键都要被清")
        self.assertEqual(c["layers_requested"], 5)
        self.assertEqual(c["layers_cleared"], 2, "只有 2 层可清 ⇒ **不许凑成 5**")
        self.assertEqual(c["picked_deltas"], [70, 30], "按 abs 从大到小")
        self.assertEqual(snap["foe_buffs"], {}, "快照里增益真的没了（Δ≠0）")

    def test_control_polarity_mismatch_delta_is_zero(self):
        """Δ=0 反证（**极性不符**，比空输入强 ✗）：敌方挂**减益**、请求驱散**增益** ⇒
        `cleared=[]` **且那个减益必须存活**（证明它**不会多清**）。"""
        ev, snap = _cast("skill_000322", foe_buffs={"atk": -40})
        c = _of(ev, "cleanse")[0]
        self.assertEqual(c["from"], "cleanse_buffs_layers")
        self.assertEqual(c["cleared"], [], "极性不符 ⇒ 一层都不许清")
        self.assertEqual(c["layers_cleared"], 0)
        self.assertEqual(snap["foe_buffs"], {"atk": -40}, "那个减益必须原样存活")
