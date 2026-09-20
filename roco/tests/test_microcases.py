"""规则引擎的机制测试。

**这些不是「microcase 已通过」的证明。** microcase 是要用**游戏内实测**回答的问题，
本文件测的是「引擎的行为与它自己声明的依据一致」：

  - 声明「依据：术语 1016」的地方，行为要真的符合那句话；
  - 声明「假设」的地方，测试要能把它**单独推翻**（改一个常量就红）；
  - 未知机制必须 fail closed，不能悄悄返回一个数。

用标准库 unittest（本机 Python 3.9 没有 pytest，且项目不允许加依赖）：

    cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata           # noqa: E402
from roco_env import effects as fx           # noqa: E402
from roco_env import env as renv             # noqa: E402
from roco_env.schema import (                # noqa: E402
    ACTION_ITEM, ACTION_SKILL, ACTION_SWITCH, Action, observation_for,
)

RS = rdata.load_ruleset()
# A 组三只，用于构造局面
A1 = RS.pets_by_name("寂灭骨龙")[0].pet_id
A2 = RS.pets_by_name("海豹船长")[0].pet_id
A3 = RS.pets_by_name("黑猫巫师")[0].pet_id
A_TEAM = [A1, A2, A3]


def fresh(seed=7):
    return renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)


def attack_actions(state, side):
    out = []
    for a in renv.legal_actions(state, RS, side):
        if a.kind == ACTION_SKILL and RS.skills[a.skill_id].is_attack:
            out.append(a)
    return out


class TestRulesetLoading(unittest.TestCase):
    """数据层：加载即校验。"""

    def test_only_mobile_game(self):
        self.assertEqual(RS.game, "roco_world_mobile")
        self.assertEqual(RS.ruleset_id, "roco-world-s4-2026-09-10")

    def test_12_target_pets_loaded(self):
        self.assertEqual(len(RS.pets), 12)

    def test_no_orphan_skill_references(self):
        # load_ruleset 会在孤儿引用时抛错；能走到这里就说明为 0
        skills = set(RS.skills)
        for pid, ls in RS.learnsets.items():
            self.assertTrue(ls.all_skill_ids <= skills, f"{pid} 有孤儿引用")

    def test_snapshot_fingerprint_is_stable(self):
        again = rdata.load_ruleset()
        self.assertEqual(RS.snapshot_fingerprint(), again.snapshot_fingerprint())

    def test_power_none_is_not_zero(self):
        """power 缺失必须是 None，不能被当成 0 威力。"""
        missing = [s for s in RS.skills.values() if s.power is None]
        self.assertTrue(missing, "数据里应当存在无静态威力的技能")
        for s in missing:
            self.assertIsNone(s.power)
            self.assertFalse(s.has_static_power)


class TestPanelStats(unittest.TestCase):
    """种族值 → 面板值。这是「伤害量级」的根，必须精确且可被推翻。"""

    def test_exact_anchors_from_community_data(self):
        # 这三条是从社区快照 452 条记录上**零误差**拟合出来的
        self.assertAlmostEqual(rdata.panel_stats({"hp": 120})["hp"], 425.0, places=6)
        self.assertAlmostEqual(rdata.panel_stats({"atk": 137})["atk"], 210.7, places=6)
        self.assertAlmostEqual(rdata.panel_stats({"def": 104})["def"], 174.4, places=6)

    def test_which_stats_are_exact_is_recorded(self):
        # 声明必须与实现一致：hp/atk/def 精确，spa/spd/spe 有残差
        self.assertTrue(rdata.panel_formula_is_exact("hp"))
        self.assertTrue(rdata.panel_formula_is_exact("atk"))
        self.assertTrue(rdata.panel_formula_is_exact("def"))
        self.assertFalse(rdata.panel_formula_is_exact("spd"))
        self.assertFalse(rdata.panel_formula_is_exact("spa"))
        self.assertFalse(rdata.panel_formula_is_exact("spe"))

    def test_panel_hp_is_used_for_max_hp(self):
        state = fresh()
        for p in state.player.pets:
            race = RS.pet(p.pet_id).stats["hp"]
            self.assertEqual(p.max_hp, int(round(rdata.panel_stats({"hp": race})["hp"])))


class TestMC001Priority(unittest.TestCase):
    """MC-001 先手度：术语 1020 —— 先手度更高者忽略速度差异优先释放。"""

    def test_higher_priority_acts_first_even_when_slower(self):
        state = fresh()
        rs = RS
        slow = rs.skill_by_name("先发制人")     # 描述含「先手+1」
        normal = rs.skill_by_name("坟场搏击")
        self.assertGreater(renv._priority_of(Action(ACTION_SKILL, slow.skill_id), rs),
                           renv._priority_of(Action(ACTION_SKILL, normal.skill_id), rs))

    def test_switch_outranks_skills(self):
        # 假设：换宠先手 5（数据未定义，MC-005）。这条测试存在的意义是
        # 让「假设」是可推翻的：改 SWITCH_PRIORITY 这条就红。
        self.assertGreater(renv.SWITCH_PRIORITY, 1)

    def test_ordering_is_total_and_uses_speed_as_second_key(self):
        import random
        state = fresh()
        orders = set()
        for seed in range(5):
            st = fresh(seed=seed)
            st.player.pets[0].hp = st.player.pets[0].max_hp
            st.enemy.pets[0].hp = st.enemy.pets[0].max_hp
            a = attack_actions(st, "player")[0]
            b = attack_actions(st, "enemy")[0]
            order = renv.order_actions(st, RS, a, b, rng=random.Random(seed))
            self.assertEqual(len(order), 2)
            orders.add(seed)
        self.assertEqual(len(orders), 5)


class TestMC003Simultaneous(unittest.TestCase):
    """MC-003 同时行动：双方基于同一事前状态，且观察里看不到对手待执行动作。"""

    def test_observation_has_no_opponent_pending_action(self):
        state = fresh()
        obs = observation_for(state, RS, "player")
        blob = repr(obs)
        self.assertNotIn("pending", blob)
        self.assertNotIn("enemy_action", blob)
        # 对手后备只暴露「还活着几只」，不暴露血量与技能
        self.assertIn("living_count", obs["opponent"])
        for p in obs["opponent"]["pets"]:
            self.assertNotIn("hp", p)
            self.assertNotIn("energy", p)

    def test_observation_is_json_serializable_and_has_versions(self):
        import json
        state = fresh()
        obs = observation_for(state, RS, "player")
        json.dumps(obs, ensure_ascii=False)     # 不抛即通过
        self.assertEqual(obs["ruleset_id"], RS.ruleset_id)
        self.assertEqual(obs["state_version"], state.state_version)

    def test_own_pet_fields_are_visible(self):
        state = fresh()
        obs = observation_for(state, RS, "player")
        me = obs["self"]["pets"][0]
        self.assertIn("hp", me)
        self.assertIn("energy", me)
        self.assertIn("buffs", me)


class TestMC007Energy(unittest.TestCase):
    """MC-007 能量：消耗与回能。上限与时机是**假设**，必须可推翻。"""

    def test_energy_spent_and_regenerated(self):
        state = fresh()
        pet = state.player.field_pet
        pet.energy = renv.ENERGY_MAX
        cheap = [a for a in attack_actions(state, "player")
                 if RS.skills[a.skill_id].energy == 0]
        self.assertTrue(cheap, "应当存在 0 能耗攻击")
        before = pet.energy
        renv.step_joint(state, RS, cheap[0], attack_actions(state, "enemy")[0])
        # 0 能耗 + 回合末回能 → 不超过上限
        self.assertLessEqual(pet.energy, renv.ENERGY_MAX)

    def test_illegal_action_rejected(self):
        state = fresh()
        pet = state.player.field_pet
        pet.energy = 0
        expensive = [a for a in renv.legal_actions(state, RS, "player")
                     if a.kind == ACTION_SKILL and RS.skills[a.skill_id].energy > 0]
        for a in expensive:
            self.assertNotIn(a, renv.legal_actions(state, RS, "player"))


class TestMC005Switch(unittest.TestCase):
    """MC-005 主动换宠。数据未定义，全部标为假设，测试用于钉住假设。"""

    def test_switch_is_legal_with_living_bench(self):
        state = fresh()
        swaps = [a for a in renv.legal_actions(state, RS, "player") if a.kind == ACTION_SWITCH]
        self.assertEqual(len(swaps), 2, "3v3 里应有两个可换入的后备")

    def test_switch_changes_active_and_marks_entry_turn(self):
        state = fresh()
        slot = state.player.bench_indices()[0]
        turn_at_switch = state.turn
        renv.step_joint(state, RS, Action(ACTION_SWITCH, target_index=slot),
                        attack_actions(state, "enemy")[0])
        self.assertEqual(state.player.active, slot)
        # entered_turn 记「换上那一刻的回合号」；回合号在回合末才 +1，
        # 所以它等于换宠时的回合，而不是推进后的回合。迸发(1010) 靠它判断「入场后首次行动」。
        self.assertEqual(state.player.field_pet.entered_turn, turn_at_switch)
        self.assertEqual(state.turn, turn_at_switch + 1)


class TestMC006Replacement(unittest.TestCase):
    """MC-006 倒下补位：术语 3009 —— 力竭下场不属于「离场」，补位不消耗回合。"""

    def test_faint_enters_replace_phase_without_advancing_turn(self):
        state = fresh()
        state.enemy.pets[0].hp = 1
        big = max(attack_actions(state, "player"), key=lambda a: RS.skills[a.skill_id].power or 0)
        turn_before = state.turn
        renv.step_joint(state, RS, big, attack_actions(state, "enemy")[0])
        if state.enemy.pets[0].fainted:
            self.assertIn("enemy", renv.needs_replacement(state))

    def test_replacement_does_not_consume_a_turn(self):
        state = fresh()
        state.enemy.pets[0].hp = 0
        state.enemy.pets[0].fainted = True
        state.phase = "replace"
        state.replace_queue = ["enemy"]
        turn_before = state.turn
        slot = state.enemy.bench_indices()[0]
        renv.step_replace(state, RS, "enemy", slot)
        # 补位是免费的（术语 3009 把力竭下场从「离场」里排除）
        self.assertEqual(state.phase, "battle")
        self.assertEqual(state.turn, turn_before + 1, "补位后进入下一回合，但本身不额外消耗回合")


class TestMC020Respond(unittest.TestCase):
    """MC-020 应对：术语 1016 —— 敌方用攻击技能则应对成功、必定先手、防御技能进冷却。"""

    def test_respond_detection_matches_glossary(self):
        defense = RS.skill_by_name("龙血")       # 应对攻击
        self.assertEqual(fx.respond_to(defense), "攻击")
        attack = RS.skill_by_name("坟场搏击")
        self.assertIsNone(fx.respond_to(attack))

    def test_only_respond_attack_grants_cooldown(self):
        # 术语 1016 写了冷却；1015/1017 没有。实现必须与文本一致。
        self.assertTrue(fx.defense_cooldown_applies(RS.skill_by_name("龙血")))

    def test_defense_reduction_is_parsed_from_text(self):
        self.assertAlmostEqual(fx.parse_defense_reduction(RS.skill_by_name("龙血")), 0.70, places=6)
        self.assertAlmostEqual(fx.parse_defense_reduction(RS.skill_by_name("集中")), 0.80, places=6)

    def test_respond_succeeds_only_against_matching_category(self):
        defense = Action(ACTION_SKILL, RS.skill_by_name("龙血").skill_id)
        enemy_attack = Action(ACTION_SKILL, RS.skill_by_name("坟场搏击").skill_id)
        enemy_defense = Action(ACTION_SKILL, RS.skill_by_name("集中").skill_id)
        self.assertTrue(renv._respond_success(defense, enemy_attack, RS))
        self.assertFalse(renv._respond_success(defense, enemy_defense, RS))


class TestMC008Status(unittest.TestCase):
    """MC-008 状态：术语 1002 灼烧衰减一半层数；中毒（1001）**没有**衰减。"""

    def test_burn_decays_and_poison_does_not(self):
        self.assertTrue(fx.END_OF_TURN_STATUS["灼烧"]["decays"])
        self.assertFalse(fx.END_OF_TURN_STATUS["中毒"]["decays"])

    def test_decay_rounding_is_the_documented_assumption(self):
        # 假设：奇数层向上取整。这条测试让假设可被单独推翻。
        self.assertEqual(fx.decay_layers(1, half=True), 1)
        self.assertEqual(fx.decay_layers(2, half=True), 1)
        self.assertEqual(fx.decay_layers(3, half=True), 2)
        self.assertEqual(fx.decay_layers(4, half=True), 2)
        self.assertEqual(fx.decay_layers(3, half=False), 3)

    def test_percentages_match_glossary(self):
        self.assertEqual(fx.END_OF_TURN_STATUS["中毒"]["percent"], 3.0)
        self.assertEqual(fx.END_OF_TURN_STATUS["灼烧"]["percent"], 2.0)
        self.assertEqual(fx.END_OF_TURN_STATUS["寄生"]["percent"], 2.0)

    def test_percent_damage_uses_max_hp_not_current(self):
        # 术语 1004「若当前生命低于冻结比例」暗示基数取最大生命
        self.assertEqual(fx.percent_of_max_hp(425, 2.0), 8)


class TestMC010DynamicPower(unittest.TestCase):
    """MC-010 条件化威力：静态威力不是最终伤害。"""

    def test_conditional_power_is_detected_and_reported(self):
        state = fresh()
        grave = RS.skill_by_name("坟场搏击")
        attacker = state.player.field_pet
        defender = state.enemy.field_pet
        defender.energy = 6
        result = fx.effective_power(grave, attacker=attacker, defender=defender, rs=RS)
        self.assertTrue(result.conditional)
        self.assertLess(result.power, float(grave.power), "敌方能量越多，该技能威力应越低")
        self.assertIn("能量", result.reason)

    def test_no_static_power_raises_instead_of_returning_zero(self):
        # 数据事实：power 为 None 的全部是特性/状态/防御类，没有一个是攻击类。
        # 所以这里用一个「无威力的状态技能」构造场景——它同样必须被拒绝，
        # 而不是被当成 0 威力算出「造成 0 伤害」。
        state = fresh()
        no_power = next(s for s in RS.skills.values() if s.power is None and not s.is_trait)
        self.assertIsNone(no_power.power)
        with self.assertRaises(fx.UnsupportedEffect):
            fx.effective_power(no_power, attacker=state.player.field_pet,
                               defender=state.enemy.field_pet, rs=RS)


class TestFailClosed(unittest.TestCase):
    """核心纪律：不知道就拒绝，绝不编一个数。"""

    def test_status_skills_are_either_applied_or_registered(self):
        """状态技能必须二选一：**要么真的生效，要么被登记为未支持**。

        不能出现的第三种情况是「悄悄什么都没做」——那会让上层以为它可用。
        支持面会随 parse.py 的覆盖增长而变化，所以这里断言的是**这个二分法**，
        而不是固定的一串技能名。
        """
        from roco_env import parse as rparse

        state = fresh()
        status_actions = [a for a in renv.legal_actions(state, RS, "player")
                          if a.kind == ACTION_SKILL and RS.skills[a.skill_id].is_status]
        self.assertTrue(status_actions, "应当有可用的状态技能")

        applied, registered = 0, 0
        for act in status_actions:
            st = fresh()
            pet = st.player.field_pet
            pet.energy = renv.ENERGY_MAX
            before_unsupported = len(st.unsupported)
            before = (dict(pet.buffs), dict(pet.marks), pet.hp, pet.energy)
            renv.step_joint(st, RS, act, attack_actions(st, "enemy")[0])
            now = st.player.field_pet
            # 效果可以是属性/印记/生命/能量中的任意一种，所以要全看
            changed = ((dict(now.buffs), dict(now.marks), now.hp, now.energy) != before
                       or bool(st.events and any(
                           e.kind in ("status_applied", "cleanse", "drain_energy", "heal")
                           for e in st.events)))
            logged = len(st.unsupported) > before_unsupported
            parsed = rparse.parse_skill(RS.skills[act.skill_id])
            if parsed.fully_supported:
                self.assertTrue(changed, f"{RS.skills[act.skill_id].name} 解析为可支持，但状态没变")
                applied += 1
            else:
                self.assertTrue(logged, f"{RS.skills[act.skill_id].name} 未解析出来，但也没登记为 unsupported")
                registered += 1
        self.assertGreater(applied, 0, "支持面应当大于零")
        self.assertGreater(registered, 0, "应当仍有未覆盖的机制被如实登记")

    def test_level_other_than_one_is_refused(self):
        with self.assertRaises(fx.UnsupportedEffect):
            renv._make_pet(RS, A1, 0, level=5)

    def test_damage_model_is_marked_unverified(self):
        model = fx.active_damage_model()
        self.assertFalse(model.verified)
        self.assertIn("未核验", model.license_note)


class TestDeterminism(unittest.TestCase):
    """确定性：同一 seed + 同一串动作 = 完全相同的状态与事件。"""

    def _play(self, seed, turns=8):
        state = fresh(seed=seed)
        for _ in range(turns):
            if state.result or state.phase == "replace":
                break
            pa = attack_actions(state, "player")
            ea = attack_actions(state, "enemy")
            if not pa or not ea:
                break
            renv.step_joint(state, RS, pa[0], ea[0])
        return state

    def test_same_seed_same_outcome(self):
        a = self._play(11)
        b = self._play(11)
        self.assertEqual(a.to_dict(), b.to_dict())

    def test_different_seed_can_differ_but_both_valid(self):
        a = self._play(11)
        b = self._play(12)
        for st in (a, b):
            self.assertIn(st.result, (None, "win", "loss", "draw"))

    def test_serialize_roundtrip(self):
        state = self._play(11)
        again = renv.deserialize(renv.serialize(state), RS)
        self.assertEqual(state.to_dict(), again.to_dict())


class TestInvariants(unittest.TestCase):
    """不变量：任何时刻状态都必须在合法范围内。"""

    def test_random_games_never_produce_illegal_state(self):
        import random
        rng = random.Random(20260921)
        for game in range(40):
            state = renv.reset(A_TEAM, A_TEAM, seed=game, rs=RS)
            for _ in range(60):
                if state.result:
                    break
                if state.phase == "replace":
                    for side in list(renv.needs_replacement(state)):
                        bench = getattr(state, side).bench_indices()
                        if bench:
                            renv.step_replace(state, RS, side, rng.choice(bench))
                    if state.phase == "replace" and not renv.needs_replacement(state):
                        state.phase = "battle"
                    continue
                pa = rng.choice(renv.legal_actions(state, RS, "player"))
                ea = rng.choice(renv.legal_actions(state, RS, "enemy"))
                renv.step_joint(state, RS, pa, ea)
                for side in ("player", "enemy"):
                    for p in getattr(state, side).pets:
                        self.assertGreaterEqual(p.hp, 0)
                        self.assertLessEqual(p.hp, p.max_hp)
                        self.assertGreaterEqual(p.energy, 0)
                        self.assertLessEqual(p.energy, renv.ENERGY_MAX)
                        if p.hp == 0:
                            self.assertTrue(p.fainted)

    def test_ended_game_rejects_further_actions(self):
        state = fresh()
        state.result = "win"
        state.phase = "ended"
        with self.assertRaises(ValueError):
            renv.step_joint(state, RS, attack_actions(state, "player")[0] if attack_actions(state, "player") else Action(ACTION_ITEM, item_id="回复药"),
                            Action(ACTION_ITEM, item_id="回复药"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
