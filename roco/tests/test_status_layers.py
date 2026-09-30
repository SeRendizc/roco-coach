"""第三轮⑥：**持续状态的层数与持续回合**真正结算的判据（2026-09-29）。

这一组回答三个问题，每个都有必红方向：

  1. **改前 / 改后同种子对照**：同一批招、同一种子，
     未声明本地规则的配置（legacy / v2）走老口径（固定百分比、层数只影响衰减、无持续回合）；
     声明了的配置（v3）走本地规则（基础% + 每层% × (层数−1)、持续回合、封顶）。
  2. **反证**：引擎**没实现**的状态（冻结 / 引电 / 萌化）必须仍然如实报不支持
     —— 不许把"新拉起三类"顺手说成"一律已实现"。
  3. **状态招不得假报伤害**（人类逐字）：用状态技能那一手只产生状态事件，
     不产生 `damage` 事件；敌方掉的血只能来自回合末 `status_tick`。

规则数字的出处是 `data/roco/rulesets/mobile-s4-candidate-v3.json` 的 `status.end_of_turn`
（`confidence=ENGINE_HYPOTHESIS` + `value_status=LOCAL_RULE`：**本地模拟规则，不是真游戏数据**；
人类 2026-09-29 逐字「所有不冲突规则都列为引擎有效规则」「我本身就是个模拟，不需要那么严谨」）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_status_layers -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import effects as fx            # noqa: E402
from roco_env import parse as parse_mod       # noqa: E402
from roco_env import rule_config as RC        # noqa: E402
from roco_env.schema import ACTION_SKILL      # noqa: E402
from roco_env.service import RocoService      # noqa: E402

RS = rdata.load_ruleset()
SEED = 20260929
#: 黑猫巫师：学得到引燃(10层灼烧) / 毒孢子(5层中毒)；另外两招是普通攻击（凑满四格）
CASTER = "pet_000445"
LOADOUT = {CASTER: ["skill_000387", "skill_000614", "skill_000251", "skill_000260"]}
#: 霜降：敌方获得 4 层冻结 —— 反证用（冻结没有回合末实现）
FREEZE_SKILL = "skill_000535"
#: 通电：造成物伤，敌方获得 1 层引电 —— 反证用（引电没有回合末实现）
VOLT_SKILL = "skill_000606"
#: 通电 的持有者（黑猫巫师学不到它）——补位技能从**它自己的学习表**里现取，不抄一份名单
VOLT_OWNER = "pet_000165"


def _learnable(pid):
    learn = RS.learnsets.get(pid)
    out = set()
    for attr in ("native", "blood", "stones"):
        values = getattr(learn, attr, None)
        if values:
            out |= {str(x) for x in values}
    return out
TEAM6 = ["pet_000445", "pet_000001", "pet_000007", "pet_000022", "pet_000118", "pet_000137"]
FOES6 = ["pet_000003", "pet_000004", "pet_000005", "pet_000006", "pet_000009", "pet_000010"]
TEAM3 = TEAM6[:3]
FOES3 = FOES6[:3]

CFG_V3 = RC.get_rule_config("mobile_s4_candidate_v3")
CFG_V2 = RC.get_rule_config("mobile_s4_candidate_v2")
CFG_LEGACY = RC.get_rule_config("legacy_sim_v1")


def _teams(cfg):
    size = cfg.require_team_size()
    return (TEAM6[:size], FOES6[:size])


def _open(cfg, loadouts=None):
    team, foes = _teams(cfg)
    return renv.reset(team, foes, seed=SEED, rs=RS, loadouts=loadouts or LOADOUT, config=cfg)


def _skill_actions(state, cfg, side):
    return [a for a in renv.legal_actions(state, RS, side, cfg) if a.kind == ACTION_SKILL]


def _pick(state, cfg, side, skill_id):
    for a in _skill_actions(state, cfg, side):
        if a.skill_id == skill_id:
            return a
    raise AssertionError(f"{side} 这一手没有 {skill_id}（{RS.skills[skill_id].name}）—— 测试前提不成立")


def _enemy_defense_or_first(state, cfg):
    acts = renv.legal_actions(state, RS, "enemy", cfg)
    for a in acts:
        if a.kind == ACTION_SKILL and RS.skills[a.skill_id].is_defense:
            return a
    for a in acts:
        if a.kind == ACTION_SKILL:
            return a
    return acts[0]


def _play(state, cfg, player_skill, enemy_skill=None):
    """走一手，返回这一手之后的事件（kind, detail）列表。"""
    p = _pick(state, cfg, "player", player_skill)
    e = _enemy_defense_or_first(state, cfg) if enemy_skill is None else _pick(state, cfg, "enemy", enemy_skill)
    before = len(state.events)
    state = renv.step_joint(state, RS, p, e)
    return state, [(ev.kind, ev.detail) for ev in state.events[before:]]


def _kinds(events):
    return [k for k, _ in events]


class LocalStatusRuleDeclarationTest(unittest.TestCase):
    """规则文件里**显式**声明了层数与持续回合（而不是引擎里写死）。"""

    def test_only_v3_declares_local_status_rules(self):
        self.assertIsNone(CFG_LEGACY.status_end_of_turn,
                          "legacy 不该有本地状态规则（没有这一块 = 老口径）")
        self.assertIsNone(CFG_V2.status_end_of_turn,
                          "v2 不该有本地状态规则（没有这一块 = 老口径）")
        rules = CFG_V3.status_end_of_turn
        self.assertIsNotNone(rules, "v3 必须声明 status.end_of_turn")
        self.assertEqual(sorted(rules), sorted(["中毒", "灼烧", "寄生"]),
                         f"v3 应当声明三个有回合末实现的状态，实际 {sorted(rules)}")
        # 逐值钉住（改钉不删）：值来自 rulesets/mobile-s4-candidate-v3.json
        self.assertEqual(
            {k: (v["base_percent"], v["per_layer_percent"], v["max_layers"],
                 v["duration_turns"], v["decays"], v["decay"]) for k, v in rules.items()},
            {"中毒": (3.0, 1.0, 10, 5, False, "none"),
             "灼烧": (2.0, 1.0, 10, 4, True, "half_ceil"),
             "寄生": (2.0, 0.5, 10, 5, False, "none")},
        )
        for name, rule in rules.items():
            self.assertEqual(rule.get("source"), "LOCAL_RULE",
                             f"{name} 必须标明这是本地规则，不是原始资料")

    def test_shape_validation_fails_closed(self):
        """形状不对必须**加载期炸**（不是静默错算）。"""
        bad = {
            "schema": "roco-ruleset-config/v1", "ruleset_config_id": "x",
            "status_rules": {"note": "本地规则", "end_of_turn": {"灼烧": {"value": {
                "base_percent": "2%",  # ← 字符串
                "per_layer_percent": 1.0, "max_layers": 10, "duration_turns": 4,
                "decays": True, "decay": "half_ceil", "tick_damage_basis": "max_hp",
                "rounding": "floor"},
                "confidence": "ENGINE_HYPOTHESIS", "reason": "x"}}},
        }
        problems = RC._validate_status(bad, lambda m: None)
        self.assertIsNone(problems)  # 形状校验只回报给 bad()；这里用收集器再跑一遍
        collected = []
        RC._validate_status(bad, collected.append)
        self.assertTrue(any("base_percent" in p for p in collected),
                        f"字符串百分比必须被拒，实际问题：{collected}")


class LayerDamageTest(unittest.TestCase):
    """伤害 = 最大生命 × (基础% + 每层% × (层数−1))，逐值可算。"""

    def test_layers_scale_the_damage(self):
        spec = CFG_V3.status_end_of_turn["灼烧"]
        self.assertEqual(fx.layered_status_tick(400, 400, "灼烧", 1, spec), 8)    # 2%
        self.assertEqual(fx.layered_status_tick(400, 400, "灼烧", 5, spec), 24)   # 2% + 4×1% = 6%
        self.assertEqual(fx.layered_status_tick(400, 400, "灼烧", 10, spec), 44)  # 2% + 9×1% = 11%
        # 单层 vs 十层必须不同 —— 否则「层数」只是一个装饰数字（改前的实际状态）
        self.assertNotEqual(fx.layered_status_tick(400, 400, "灼烧", 1, spec),
                            fx.layered_status_tick(400, 400, "灼烧", 10, spec))

    def test_damage_never_exceeds_current_hp(self):
        spec = CFG_V3.status_end_of_turn["灼烧"]
        self.assertEqual(fx.layered_status_tick(3, 400, "灼烧", 10, spec), 3,
                         "状态伤害最多扣到 0，不许出现负血")

    def test_old_helpers_are_untouched(self):
        """老口径的助手**一个字都不改**（legacy 逐位不变靠它们）。"""
        self.assertEqual(fx.decay_layers(1, half=True), 1)
        self.assertEqual(fx.decay_layers(4, half=True), 2)
        self.assertEqual(fx.status_tick(340, 340, "灼烧"), 6)


class BeforeAfterSameSeedTest(unittest.TestCase):
    """同种子、同招、同出手顺序：改前（v2，老口径）vs 改后（v3，本地规则）。"""

    def _run(self, cfg):
        state = _open(cfg)
        hp_before = state.enemy.field_pet.hp
        state, events = _play(state, cfg, "skill_000387")
        return hp_before, state, events

    def test_before_and_after_are_both_settled_but_different(self):
        hp_before_v2, state_v2, ev_v2 = self._run(CFG_V2)
        hp_before_v3, state_v3, ev_v3 = self._run(CFG_V3)

        # 两支都**真的结算了**状态（不是 unsupported）—— 这一条是本次任务的起点结论：
        # 状态原语本来就是活的，之前的「零状态事件」是**这些招根本不在任何候选配招里**。
        for label, events in (("v2", ev_v2), ("v3", ev_v3)):
            self.assertIn("status_added", _kinds(events), f"{label} 必须有 status_added")
            self.assertIn("status_applied", _kinds(events), f"{label} 必须有 status_applied")
            self.assertIn("status_tick", _kinds(events), f"{label} 必须有回合末结算")
            self.assertNotIn("effects_registered_unsupported", _kinds(events),
                             f"{label} 这一手不该再报未结算")

        added_v2 = {k: ev for k, ev in ev_v2}["status_added"]
        added_v3 = {k: ev for k, ev in ev_v3}["status_added"]
        tick_v2 = {k: ev for k, ev in ev_v2}["status_tick"]
        tick_v3 = {k: ev for k, ev in ev_v3}["status_tick"]

        # 改前（老口径）：10 层，没有持续回合；每回合固定 2% 且**不看层数**
        # 老路径的 detail 只有三个键（`test_turn_order_fail_closed` 的 golden 指纹钉着它）
        self.assertEqual(added_v2, {"side": "enemy", "status": "灼烧", "layers": 10})
        self.assertNotIn("turns_left", added_v2, "老口径没有持续回合概念")
        self.assertEqual(tick_v2["damage"], 6)
        self.assertEqual(tick_v2, {"side": "enemy", "status": "灼烧", "damage": 6, "layers_after": 5},
                         "老口径的 status_tick 必须逐键不变")
        self.assertNotIn("turns_left_after", tick_v2)
        self.assertEqual(tick_v2["layers_after"], 5)

        # 改后（本地规则）：10 层 + 4 回合；伤害按层数放大（11% × 340 = 37）
        self.assertEqual(added_v3["layers_total"], 10)
        self.assertEqual(added_v3["turns_left"], 4)
        self.assertEqual(added_v3["damage_rule"], "LOCAL_RULE")
        self.assertEqual(tick_v3["damage"], 37)
        self.assertEqual(tick_v3["layers_after"], 5)
        self.assertEqual(tick_v3["turns_left_after"], 3)

        # 关键读数：同样的招、同样的种子，改后的回合末伤害**明显更大**（层数真的进了公式）
        self.assertGreater(tick_v3["damage"], tick_v2["damage"],
                           "层数没进伤害公式的话，这里不该变大")

        # 掉血量 = 状态伤害，且**没有**普通伤害事件（状态招不得假报伤害）
        self.assertEqual(hp_before_v3 - state_v3.enemy.field_pet.hp, tick_v3["damage"])
        self.assertNotIn("damage", _kinds(ev_v3), "引燃是状态招，不该产生 damage 事件")
        self.assertEqual(hp_before_v2 - state_v2.enemy.field_pet.hp, tick_v2["damage"])
        self.assertNotIn("damage", _kinds(ev_v2))

    def test_status_expires_by_duration_under_local_rules(self):
        """本地规则下「10 层灼烧」真的会打完（4 个回合末之后状态消失）。"""
        state, _ = _play(_open(CFG_V3), CFG_V3, "skill_000387")
        pet = state.enemy.field_pet
        self.assertIn("灼烧", pet.statuses)
        seen = []
        for _ in range(6):
            renv._end_turn_status_tick(state, RS, state.enemy, pet, CFG_V3)
            seen.append(dict(pet.statuses.get("灼烧") or {}))
        self.assertNotIn("灼烧", pet.statuses, f"持续回合用尽后必须移除，实际轨迹 {seen}")
        self.assertLessEqual(len([s for s in seen if s]), 4, f"最多 4 个回合末，实际 {seen}")

    def test_old_rule_never_expires_which_is_the_bug(self):
        """改钉不删：**老口径下灼烧永不消失**（ceil(1/2)=1）—— 这是本轮实测到的真缺陷。

        旧断言（=改前的行为）：层数 10 → 5 → 3 → 2 → 1 → 1 → 1…
        现在把它们钉成"老口径的证据"，而新口径由上一个用例守护。
        """
        state, _ = _play(_open(CFG_V2), CFG_V2, "skill_000387")
        pet = state.enemy.field_pet
        layers = []
        for _ in range(8):
            renv._end_turn_status_tick(state, RS, state.enemy, pet, CFG_V2)
            layers.append(int((pet.statuses.get("灼烧") or {}).get("layers", 0)))
        self.assertIn("灼烧", pet.statuses, "老口径：8 个回合末之后依然在（永不消失）")
        self.assertEqual(layers[:6], [3, 2, 1, 1, 1, 1],
                         f"老口径的衰减轨迹（ceil 半衰、卡在 1 层），实际 {layers}")


class StackingTest(unittest.TestCase):
    """重复施加：层数继续叠、封顶、持续回合刷新。"""

    def test_layers_are_capped_and_duration_refreshed(self):
        state = _open(CFG_V3)
        skill = RS.skills["skill_000387"]
        pet = state.enemy.field_pet
        parsed = parse_mod.Parsed(skill_id=skill.skill_id, skill_name=skill.name)
        parsed.effects = [parse_mod.Effect(kind="foe_status", target="foe",
                                           value={"status": "灼烧", "layers": 10},
                                           evidence="敌方获得10层灼烧。", term="1002")]
        renv._apply_effect_batch(state, RS, "player", skill, parsed, CFG_V3)
        self.assertEqual(pet.statuses["灼烧"], {"layers": 10, "turns_left": 4})
        # 走一个回合末，把回合数烧掉 1
        renv._end_turn_status_tick(state, RS, state.enemy, pet, CFG_V3)
        self.assertEqual(pet.statuses["灼烧"]["turns_left"], 3)
        # 再施加一次：层数叠到 20 → 封顶 10；持续回合**刷新**回 4
        ev_before = len(state.events)
        renv._apply_effect_batch(state, RS, "player", skill, parsed, CFG_V3)
        added = [ev for ev in state.events[ev_before:] if ev.kind == "status_added"][-1]
        # 回合末先扣了一次：10 层 → 5 层；再施加 10 层 ⇒ 15 层被压到上限 10
        self.assertEqual(added.detail["capped_from"], 15)
        self.assertEqual(added.detail["max_layers"], 10)
        self.assertEqual(pet.statuses["灼烧"], {"layers": 10, "turns_left": 4})


class NegativeControlTest(unittest.TestCase):
    """反证：**没实现**的状态必须仍然如实报不支持。"""

    def test_freeze_still_unsupported(self):
        self.assertNotIn("冻结", fx.END_OF_TURN_STATUS,
                         "冻结不该有回合末实现（反证的前提）")
        loadout = {CASTER: [FREEZE_SKILL, "skill_000614", "skill_000251", "skill_000260"]}
        state, events = _play(_open(CFG_V3, loadout), CFG_V3, FREEZE_SKILL)
        self.assertIn("status_unsupported", _kinds(events),
                      f"冻结没实现 ⇒ 必须报 status_unsupported，实际 {_kinds(events)}")
        self.assertNotIn("status_added", _kinds(events), "不许把没实现的状态说成加上了")
        self.assertNotIn("冻结", state.enemy.field_pet.statuses)
        self.assertTrue(any("冻结" in str(row.get("what", "")) for row in state.unsupported),
                        f"unsupported 里必须点名冻结，实际 {state.unsupported}")

    def test_volt_still_unsupported(self):
        # 通电 只有另外一批精灵学得到（黑猫巫师学不到）⇒ 换持有者，队伍其余照旧
        filler = [s for s in sorted(_learnable(VOLT_OWNER)) if s != VOLT_SKILL][:3]
        self.assertEqual(len(filler), 3, "反证前提：持有者至少要能凑满 4 格")
        loadout = {VOLT_OWNER: [VOLT_SKILL] + filler}
        team = [VOLT_OWNER] + TEAM6[1:6]
        state = renv.reset(team, FOES6, seed=SEED, rs=RS, loadouts=loadout, config=CFG_V3)
        state, events = _play(state, CFG_V3, VOLT_SKILL)
        # 通电是**攻击**技能（「造成物伤，敌方获得1层引电。」），走攻击分支：
        # 它照常结算伤害，但引电那一段必须登记为"没结算"（攻击分支报 effects_registered_unsupported，
        # 状态分支报 status_unsupported —— 两个分支的登记事件名不同，语义相同：不许静默丢弃）。
        self.assertIn("damage", _kinds(events), "攻击技能该结算的伤害照常结算")
        self.assertIn("effects_registered_unsupported", _kinds(events),
                      f"引电没实现 ⇒ 必须登记为未结算，实际 {_kinds(events)}")
        self.assertNotIn("引电", state.enemy.field_pet.statuses, "不许把没实现的状态说成加上了")
        self.assertTrue(any("引电" in str(row.get("what", "")) for row in state.unsupported),
                        f"unsupported 里必须点名引电，实际 {state.unsupported}")


class MechanicsResolvedTest(unittest.TestCase):
    """`mechanics.resolved` 必须跟着**实际接线**走（本轮的"接进去"）。"""

    def setUp(self):
        self.svc = RocoService()

    def _mechanics(self, skill_id):
        status, env = self.svc.rules_query({"ruleset_id": RS.ruleset_id, "state_version": 0,
                                            "kind": "skill", "skill_id": skill_id})
        self.assertEqual(status, 200)
        return env["result"]["mechanics"], env.get("unsupported") or []

    def test_lifted_classes_report_resolved(self):
        for skill_id, name in (("skill_000387", "引燃"), ("skill_000614", "毒孢子"),
                               ("skill_000609", "腐蚀酸液"), ("skill_000276", "咆哮(双攻-60%)")):
            mech, unsupported = self._mechanics(skill_id)
            self.assertTrue(mech["resolved"], f"{name} 已经能结算，不该再报未结算：{mech}")
            self.assertEqual(unsupported, [], f"{name} 的 envelope 不该再说未实现")

    def test_unimplemented_classes_still_report_unresolved(self):
        mech, unsupported = self._mechanics(FREEZE_SKILL)
        self.assertFalse(mech["resolved"], "冻结没有实现 ⇒ 必须仍然 unresolved")
        self.assertIn("冻结", str(mech["reason"]))
        self.assertTrue(unsupported, "envelope 也要如实说不支持")
        mech_v, _ = self._mechanics(VOLT_SKILL)
        self.assertFalse(mech_v["resolved"], "引电没有实现 ⇒ 必须仍然 unresolved")
        self.assertIn("引电", str(mech_v["reason"]))


if __name__ == "__main__":
    unittest.main()
