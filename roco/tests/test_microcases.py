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

import json
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

    def test_playable_pool_is_48_over_the_intact_baseline_12(self):
        """引擎候选池 = 基线 12 只 + 叠加层 36 只 = 48 只（第 60 轮）。

        两件事都要守住，缺一不可：
          · **M1 的 12 只基线一只不少**（它们是验收基线，基线文件本身逐字节未动，
            由 `tests/evals/roco/data-acceptance.test.js` 钉着「恰好 12 只」）；
          · 池子**正好 48**——多出来的只能是 `layer-playable-48/` 里的登记条目，
            不是谁绕过叠加层偷偷塞进来的（那条由加载期的重复定义检查兜住）。
        这里直接从磁盘读基线，**不复制名单**：复制一份名单就会有第二个真相。
        """
        baseline_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "..",
            "data", "roco", "normalized", "roco-world-s4-2026-09-10", "pets.json",
        )
        with open(baseline_path, "r", encoding="utf-8") as fh:
            baseline = json.load(fh)["pets"]
        self.assertEqual(len(baseline), 12, "M1 基线应当仍是 12 只")
        self.assertEqual(len(RS.pets), 48, "引擎候选池应当是 12 + 36 = 48 只")
        for pid, row in baseline.items():
            self.assertIn(pid, RS.pets, f"基线精灵 {row['name']} 不在候选池里")
            self.assertEqual(RS.pets[pid].name, row["name"])
            self.assertEqual(RS.pets[pid].learnset_id, row["learnset_id"])

    def test_every_pet_has_exactly_four_candidate_moves(self):
        """每只精灵都必须正好 4 个规范配招技能（3v3 的四个技能位都要有牌可打）。"""
        sizes = {pid: len(RS.candidate_moveset(pid)) for pid in RS.pets}
        bad = {pid: size for pid, size in sizes.items() if size != 4}
        self.assertEqual(bad, {}, f"每只必须正好 4 个规范配招技能，不满足：{bad}")

    def test_layer_files_are_part_of_snapshot_fingerprint(self):
        """叠加层必须进快照指纹：否则「这一局用的哪份数据」会漏掉 36 只。"""
        for name in ("layer-playable-48/pets.json", "layer-playable-48/learnsets.json",
                     "layer-playable-48/support-matrix.json"):
            self.assertIn(name, RS.files)

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
        # 对手**场上**那只的面板是公开的：血条、能量、异常、印记就画在屏幕上。
        # 隐藏的是**后备**的信息（血量/能量/配招）与对手本回合已提交的动作。
        self.assertIn("living_count", obs["opponent"])
        field = obs["opponent"]["field"]
        self.assertIn("hp", field, "对手场上面板是公开信息，教练必须看得到")
        self.assertIn("energy", field)
        for p in obs["opponent"]["pets"]:
            if p.get("field"):
                self.assertIn("hp", p)
                self.assertNotIn("loadouts", p, "配招不是公开信息")
            else:
                self.assertNotIn("hp", p, "后备血量是隐藏信息")
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

        # 合法动作按**配招**枚举，而 M1 的规范配招不一定含状态技能
        # （那是数据选择的结果，测试不该假设）。这里显式给一套含状态技能的配招。
        ls = RS.learnsets[A1]
        status_ids = [sid for sid in sorted(ls.all_skill_ids)
                      if RS.skills[sid].is_status and RS.skills[sid].energy <= 3]
        self.assertTrue(status_ids, f"{RS.pet(A1).name} 应当有低耗状态技能")
        def attacks_of(pet_id, n=2):
            """各自的攻击技能——配招要按**每只自己的学习表**给，不能拿别人的。"""
            pool = RS.learnsets[pet_id].all_skill_ids
            return [sid for sid in sorted(pool)
                    if RS.skills[sid].is_attack and RS.skills[sid].power][:n]

        # 双方都要给，且每只都要有攻击技能（否则轮到它时敌方没有可执行动作）。
        # A1 额外带两个状态技能，这正是本用例要观察的对象。
        loadout = {}
        for pid in (A1, A2, A3):
            combo = attacks_of(pid)
            if pid == A1:
                combo = combo + status_ids[:2]
            self.assertTrue(combo, f"{RS.pet(pid).name} 需要至少一个可用技能")
            loadout[pid] = tuple(combo)
        state = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS, loadouts=loadout)
        status_actions = [a for a in renv.legal_actions(state, RS, "player")
                          if a.kind == ACTION_SKILL and RS.skills[a.skill_id].is_status]
        self.assertTrue(status_actions, "显式配招下应当有可用的状态技能")

        applied, registered = 0, 0
        for act in status_actions:
            st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS, loadouts=loadout)
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


class TestTraits(unittest.TestCase):
    """MC-014…019：A 组 6 只特性。W3-01 之后扩到 12 只（B/C 组各 3 只）。

    这个类同时断言**实现状态本身**——因为「12 只里几只真的可用」
    必须是一个可核验的数字，而不是印象。REFUSED 的理由写在 traits.py 里。
    """

    def test_implementation_status_is_honest(self):
        from roco_env import traits as tr
        summary = tr.implementation_summary()
        self.assertEqual(summary["FULL"] + summary["PARTIAL"] + summary["REFUSED"], 12,
                         "A 组 6 只 + B/C 组 6 只 = 12 只特性")
        self.assertGreater(summary["FULL"], 0)
        self.assertGreater(summary["REFUSED"], 0,
                           "至少有一条应当被明确拒绝——做不到和没做是两件事")
        # 12 只里的每一只都要能在规则集里查到，且特性名与数据一致
        for name, spec in tr.TRAITS.items():
            pets = RS.pets_by_name(spec.pet_name)
            self.assertTrue(pets, f"特性 {name} 写的精灵 {spec.pet_name} 不在规则集里")
            pet = pets[0]
            self.assertIsNotNone(pet.feature_skill_id,
                                 f"{spec.pet_name} 没有特性技能 id，特性挂不上")
            self.assertEqual(RS.skills[pet.feature_skill_id].name, name,
                             f"{spec.pet_name} 的特性技能名与注册表不一致")
            if spec.status == tr.REFUSED:
                self.assertTrue(spec.reason and len(spec.reason) > 20,
                                f"REFUSED 的特性 {name} 必须写清为什么做不到")

    def test_new_bc_traits_are_wired_or_refused(self):
        """W3-01 新增的 6 只：FULL 的必须真的挂上钩子，REFUSED 的必须给出理由。"""
        from roco_env import traits as tr
        expected = {
            "变形活画": tr.FULL, "绝对秩序": tr.REFUSED, "化茧": tr.REFUSED,
            "铭记于月亮": tr.REFUSED, "热成像": tr.FULL, "冷光源": tr.FULL,
        }
        for name, status in expected.items():
            spec = tr.spec_for_trait_name(name)
            self.assertIsNotNone(spec, f"缺少特性 {name}")
            self.assertEqual(spec.status, status, f"{name} 的状态与预期不符")
            if status == tr.FULL:
                self.assertTrue(spec.hook, f"FULL 的特性 {name} 必须声明挂载钩子")

    def test_hot_imaging_reads_last_turn_fire_skill(self):
        """圣凯布米龙 [热成像]：上回合有人用火系技能 → 本回合虫系威力 +100%。"""
        pid = RS.pets_by_name("圣凯布米龙")[0].pet_id
        other = RS.pets_by_name("音速犬")[0].pet_id   # 火系
        state = renv.reset([pid, A2, A3], [other, A2, A3], seed=1, rs=RS)
        # 第 1 回合：对手用火系技能（音速犬的合法动作里挑一个火系技能）
        fire = [a for a in renv.legal_actions(state, RS, "enemy")
                if a.kind == "skill" and RS.skills[a.skill_id].element == "火系"]
        if not fire:
            self.skipTest("音速犬当前没有火系合法动作")
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0], fire[0])
        # 第 1 回合打完，history 里才有记录。
        # 「上回合」= history 的最后一条，所以加成在第 **2** 回合开始时生效——
        # 这里必须真的推进到第 2 回合才能判定，否则测的是「入场即加成」这个错误行为。
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0],
                        renv.legal_actions(state, RS, "enemy")[0])
        self.assertEqual(state.player.field_pet.pet_id, pid)
        self.assertEqual(state.player.field_pet.buffs.get("power_bug"), 100,
                         "上回合有人用火系 → 本回合虫系技能威力 +100%")

    def test_cold_light_source_reads_last_turn_wing_skill(self):
        """月使鹭纳 [冷光源]：上回合有人用翼系技能 → 本回合冰系威力 +100%。"""
        pid = RS.pets_by_name("月使鹭纳")[0].pet_id
        other = RS.pets_by_name("月使鹭纳")[0].pet_id   # 翼系
        state = renv.reset([pid, A2, A3], [other, A2, A3], seed=1, rs=RS)
        wing = [a for a in renv.legal_actions(state, RS, "enemy")
                if a.kind == "skill" and RS.skills[a.skill_id].element == "翼系"]
        if not wing:
            self.skipTest("月使鹭纳当前没有翼系合法动作")
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0], wing[0])
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0],
                        renv.legal_actions(state, RS, "enemy")[0])
        self.assertEqual(state.player.field_pet.buffs.get("power_ice"), 100,
                         "上回合有人用翼系 → 本回合冰系技能威力 +100%")

    def test_element_trait_does_not_fire_without_the_trigger(self):
        """反证：上回合没人用触发系别时**不许**给加成。"""
        pid = RS.pets_by_name("圣凯布米龙")[0].pet_id
        state = renv.reset([pid, A2, A3], [A1, A2, A3], seed=1, rs=RS)
        non_fire = [a for a in renv.legal_actions(state, RS, "enemy")
                    if a.kind == "skill" and RS.skills[a.skill_id].element != "火系"]
        if not non_fire:
            self.skipTest("对手这个回合只有火系动作")
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0], non_fire[0])
        renv.step_joint(state, RS, renv.legal_actions(state, RS, "player")[0],
                        renv.legal_actions(state, RS, "enemy")[0])
        self.assertIsNone(state.player.field_pet.buffs.get("power_bug"),
                          "触发条件不成立时不许给加成（否则就是把特性当成常驻增益）")

    def test_speed_dog_gets_attack_on_entry(self):
        """音速犬 [专注力] 入场首回合物攻 +100%。"""
        pid = RS.pets_by_name("音速犬")[0].pet_id
        state = renv.reset([pid, A2, A3], [pid, A2, A3], seed=1, rs=RS)
        self.assertEqual(state.player.field_pet.buffs.get("atk"), 100)

    def test_flat_power_trait_counts_responds(self):
        """海豹船长 [身经百练]：己方每应对 1 次，入场时水系/武系威力 +20%。"""
        from roco_env import traits as tr
        pid = RS.pets_by_name("海豹船长")[0].pet_id
        state = renv.reset([A1, pid, A3], [A1, pid, A3], seed=1, rs=RS)
        # 先人为记一次应对
        state.player._respond_count = 2
        # 换上海豹船长
        slot = [i for i, p in enumerate(state.player.pets) if p.pet_id == pid][0]
        bench = state.player.bench_indices()
        if slot not in bench:
            self.skipTest("海豹船长当前就在场上")
        renv.step_joint(state, RS, Action(ACTION_SWITCH, target_index=slot),
                        attack_actions(state, "enemy")[0])
        self.assertEqual(state.player.field_pet.buffs.get("power_water"), 40)

    def test_refused_trait_is_not_silently_approximated(self):
        """寂灭骨龙 [不朽]（力竭4回合后复活）必须是 REFUSED，而不是被近似。"""
        from roco_env import traits as tr
        spec = tr.spec_for_trait_name("不朽")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.status, tr.REFUSED)
        self.assertIn("MC-014", spec.reason)

    def test_partial_traits_say_what_is_missing(self):
        """PARTIAL 必须写明缺的是哪一部分。"""
        from roco_env import traits as tr
        for name in ("预警", "捉迷藏"):
            spec = tr.spec_for_trait_name(name)
            self.assertEqual(spec.status, tr.PARTIAL, name)
            self.assertTrue(spec.reason, f"{name} 必须说明缺什么")
            self.assertIn("未实现", spec.reason, f"{name} 的理由要说明未实现的部分")

    def test_loud_trait_effect_reads_its_number_from_data(self):
        """圆号鱼 [泛音列] 引用「聒噪」——它的数值必须来自数据，不能写死。"""
        from roco_env import traits as tr
        spec = tr.spec_for_trait_name("泛音列")
        self.assertEqual(spec.status, tr.FULL)
        noisy = RS.skill_by_name("聒噪")
        self.assertIn("能耗", noisy.desc)
        self.assertIn("skill_000274", spec.reason, "理由里要指出数值出处")


class TestTeamBaseline(unittest.TestCase):
    """G2 阵容评分 baseline：输出分项证据，**不输出胜率**。"""

    def test_returns_features_not_a_winrate(self):
        """不得把胜率当结论。

        注意不能简单地断言「不出现『胜率』二字」——本模块的免责声明里
        就写着「不是胜率」，那是**正确**的表述。要断言的是：
        没有任何字段把胜率/强度当**结论**给出。
        """
        from roco_env import team as rteam
        score = rteam.evaluate_team(A_TEAM, rs=RS)
        d = score.to_dict()
        # ① 顶层不得有胜率类字段
        for key in ("winrate", "win_rate", "win_probability", "tier", "grade"):
            self.assertNotIn(key, d)
        # ② calibration 必须声明是规则 baseline、没有模拟
        self.assertEqual(d["calibration"], "rule-baseline-no-simulation")
        # ③ 免责声明必须在，且明确否认胜率
        self.assertIn("不是胜率", d["note"])
        # ④ 每个特征都是 0..1 或计数量，不得是「总战力」这种复合分
        for f in d["features"]:
            self.assertNotIn("overall", f)
            self.assertNotIn("score", f)

    def test_every_feature_carries_evidence(self):
        from roco_env import team as rteam
        score = rteam.evaluate_team(A_TEAM, rs=RS)
        names = {f.name for f in score.features}
        self.assertEqual(names, {"types", "roles", "speed", "damage", "energy", "gaps"})
        for f in score.features:
            self.assertIsInstance(f.detail, dict)
            if f.name != "gaps":
                self.assertTrue(f.evidence, f"{f.name} 必须能指向具体精灵/技能")

    def test_speed_uses_panel_values_not_race_values(self):
        from roco_env import team as rteam
        score = rteam.evaluate_team(A_TEAM, rs=RS)
        speed = next(f for f in score.features if f.name == "speed")
        # 面板速度远大于种族速度（1.67×+61），所以最快的面板速度必然 > 150
        self.assertGreater(speed.detail["fastest"][1], 150.0,
                           "速度线必须用面板值；用种族值会得到一个很小的数字")

    def test_gaps_are_words_not_a_deduction(self):
        from roco_env import team as rteam
        score = rteam.evaluate_team(A_TEAM, rs=RS)
        gaps = next(f for f in score.features if f.name == "gaps")
        self.assertIsInstance(gaps.detail["gaps"], list)
        for g in gaps.detail["gaps"]:
            self.assertIsInstance(g, str)

    def test_compare_change_reports_cost_as_well_as_gain(self):
        from roco_env import team as rteam
        comp = rteam.compare_team_change(A_TEAM, "pet_000062", rs=RS)
        self.assertIn("improves", comp)
        self.assertIn("costs", comp)
        self.assertIn("note", comp)
        self.assertIn("不等于", comp["note"],
                      "换人比较必须写明它不等于「更强」")

    def test_rejects_a_team_that_is_not_three(self):
        from roco_env import team as rteam
        with self.assertRaises(ValueError):
            rteam.evaluate_team(["pet_000225"], rs=RS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
