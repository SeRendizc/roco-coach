"""RC-401 批四：**吸血 / 过量回复转化**原语 + `贪得无厌`（恶魔男爵）。

人类计划（`HANDOFF-2026-09-23.md` §3.4）把 `贪得无厌` 列为 RC-401 的 `ready` 之一，
并判断它「需要伤害后钩子」—— 实现下来更省的切法是**把两条机制做成引擎原语**
（`PetState.sustain` + `env._settle_sustain`），特性只负责在入场时把**解析出来的**参数写进去。
理由与纪律一致：引擎里结算的地方只有一处，特性不该各写一遍数值。

每条判据都有会红的方向，不是「跑一遍没报错」：
  ① 解析器要把「获得50%吸血」与「每过量回复5%生命转化为10%物攻」读成**两个**效果，
     而且**不能**把后者读成一次 5% 回血（旧实现在这里读错语义，实测复现）；
  ② 数值全部来自解析器 —— trait spec 里一个数字都不写死（改数据就跟着变）；
  ③ 吸血按**实际造成的伤害**（不是理论伤害）的 50% 回复；
  ④ 溢出按最大生命的 5% 满档转 10% 物攻，余数 carry 到下一次（这条口径是假设，已登记）；
  ⑤ 反向对照：没有 `sustain` 的精灵，结算前后**一个字节都不变**（不产生新事件）；
  ⑥ `PetState.sustain` 不做序列化污染：空 dict 不进 `to_dict()`（legacy / v2 指纹不变）。
"""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as parse_mod     # noqa: E402
from roco_env import rule_config as rc      # noqa: E402
from roco_env import traits as tr           # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
PET_GREEDY = "pet_000588"      # 恶魔男爵（贪得无厌）
PET_PLAIN = "pet_000062"       # 音速犬（专注力，没有 sustain）
TRAIT_SKILL = "skill_000239"   # 贪得无厌
TEAM_A = [PET_GREEDY, PET_PLAIN, "pet_000112", "pet_000417", "pet_000484", "pet_000330"]
TEAM_B = ["pet_000130", "pet_000137", "pet_000139", "pet_000143", "pet_000152", "pet_000153"]


def _overrides():
    return [{"path": "turn_order.speed_tie", "value": "random_seeded",
             "confidence": "ENGINE_HYPOTHESIS",
             "reason": "同速平手裁决未核验（MC-E05 未录制），按已登记的工程权宜走",
             "microcase_id": "MC-E05"}]


def _state(config_id: str = V3):
    rc.clear_cache()
    return renv.reset(TEAM_A, TEAM_B, seed=5, rs=RS, config=rc.load_config(config_id),
                      unverified_overrides=_overrides())


def _events_of(state, kind):
    return [e for e in state.events if getattr(e, "kind", None) == kind]


class TestParserReadsTheTwoMechanics(unittest.TestCase):
    def test_lifesteal_and_overheal_convert_are_two_effects(self):
        """① 一条描述里读出**两个**效果：吸血 + 过量转化。"""
        parsed = parse_mod.parse_skill(RS.skills[TRAIT_SKILL])
        kinds = [e.kind for e in parsed.effects]
        self.assertIn("self_lifesteal", kinds, "「获得50%吸血」必须被读成吸血")
        self.assertIn("overheal_to_stat", kinds, "「每过量回复5%生命转化为10%物攻」必须被读成转化规则")
        lifesteal = next(e for e in parsed.effects if e.kind == "self_lifesteal")
        convert = next(e for e in parsed.effects if e.kind == "overheal_to_stat")
        self.assertEqual(lifesteal.value["percent"], 50)
        self.assertEqual(convert.value["chunk_pct"], 5)
        self.assertEqual(convert.value["gain_pct"], 10)
        self.assertEqual(convert.value["stats"], ["atk"])
        self.assertEqual(parsed.unparsed, [])

    def test_overheal_phrase_is_not_read_as_a_plain_heal(self):
        """①b 必红方向：旧实现把「回复5%生命」当成本体回血 —— 这条钉住它不回来。"""
        parsed = parse_mod.parse_skill(RS.skills[TRAIT_SKILL])
        heals = [e for e in parsed.effects if e.kind == "heal"]
        self.assertEqual(heals, [], "「每过量回复5%生命转化为…」不是一次 5% 回血")

    def test_plain_heal_still_parses(self):
        """反向对照：真正的回血技能照旧被读成 `heal`（没有把 `_HEAL` 一起废掉）。"""
        heal_skills = [s for s in RS.skills.values()
                       if not s.is_trait and "回复" in (s.desc or "") and "生命" in (s.desc or "")]
        self.assertTrue(heal_skills)
        found = 0
        for skill in heal_skills:
            if any(e.kind == "heal" for e in parse_mod.parse_skill(skill).effects):
                found += 1
        self.assertGreater(found, 0, "语料里应当至少有一条本体回血技能仍被解析出 heal")


class TestTraitWiring(unittest.TestCase):
    def test_on_enter_writes_parsed_values(self):
        """② 入场把**解析出来的**数值写进 `sustain`（trait spec 里不写死数字）。"""
        state = _state()
        pet = state.player.pets[0]
        self.assertEqual(rs_name(pet.pet_id), "恶魔男爵")
        self.assertEqual(pet.sustain.get("lifesteal_pct"), 50)
        conv = pet.sustain.get("overheal") or {}
        self.assertEqual((conv.get("chunk_pct"), conv.get("gain_pct"), conv.get("stats")),
                         (5, 10, ["atk"]))
        # 登记表的分档：这条只到 PARTIAL（两条口径是假设）
        self.assertEqual(tr.TRAITS["贪得无厌"].status, tr.PARTIAL)
        self.assertIn("ENGINE_HYPOTHESIS", tr.TRAITS["贪得无厌"].reason)

    def test_values_come_from_the_parser_not_literals(self):
        """②b 反证：把解析器换一组数字，`sustain` 必须跟着变 —— 证明没有写死任何比例。"""
        import dataclasses
        from roco_env import parse as parse_mod

        original = parse_mod.parse_skill

        def fake(skill):
            real = original(skill)
            if skill is None or skill.skill_id != TRAIT_SKILL:
                return real
            effects = [
                dataclasses.replace(e, value={"percent": 37}) if e.kind == "self_lifesteal" else e
                for e in real.effects
            ]
            effects = [
                dataclasses.replace(e, value={"chunk_pct": 7, "gain_pct": 13, "stats": ["spa"]})
                if e.kind == "overheal_to_stat" else e
                for e in effects
            ]
            return dataclasses.replace(real, effects=effects)

        state = _state()
        pet = state.player.pets[0]
        pet.sustain = {}
        parse_mod.parse_skill = fake
        try:
            tr.on_enter(RS, state, "player", [])
        finally:
            parse_mod.parse_skill = original
        self.assertEqual(pet.sustain.get("lifesteal_pct"), 37, "吸血比例必须来自解析器")
        conv = pet.sustain.get("overheal") or {}
        self.assertEqual((conv.get("chunk_pct"), conv.get("gain_pct"), conv.get("stats")),
                         (7, 13, ["spa"]), "转化参数必须来自解析器")

class TestSettlement(unittest.TestCase):
    def setUp(self):
        self.state = _state()
        self.me = self.state.player
        self.pet = self.me.pets[0]

    def _damage(self, amount):
        renv._settle_sustain(self.state, RS, "player", amount)

    def test_lifesteal_heals_half_of_the_actual_damage(self):
        """③ 吸血 = 实际伤害的 50%，且不超过最大生命。"""
        self.pet.hp = 100
        self.pet.buffs.clear()
        self._damage(120)
        self.assertEqual(self.pet.hp, 100 + 60, "120 × 50% = 60 点回复")
        ev = _events_of(self.state, "lifesteal")
        self.assertEqual(ev[-1].detail["healed"], 60)
        self.assertEqual(ev[-1].detail["percent"], 50)
        self.assertEqual(ev[-1].detail["overhealed"], 0)

    def test_overheal_converts_in_five_percent_chunks_with_carry(self):
        """④ 溢出满 5% 最大生命 → +10% 物攻；余数 carry 到下一次。"""
        self.pet.buffs.clear()
        self.pet.hp = self.pet.max_hp
        self._damage(self.pet.max_hp)          # 全部溢出：50% × max_hp 的回复全浪费
        conv = self.pet.sustain["overheal"]
        # 回复量 = max_hp × 50% = 最大生命的 50% → 10 档；每档 10% 物攻 = +100%
        self.assertEqual(self.pet.buffs.get("atk"), 100)
        self.assertAlmostEqual(conv["carry_pct"], 0.0, places=6)
        ev = _events_of(self.state, "overheal_to_stat")
        self.assertEqual(ev[-1].detail["chunks"], 10)

    def test_carry_accumulates_across_heals(self):
        """④b 余数不丢：多次小额溢出合起来能凑满一档（这条是假设口径的守卫）。"""
        self.pet.buffs.clear()
        self.pet.hp = self.pet.max_hp
        per_hit = max(1, int(self.pet.max_hp * 4 / 100))     # 回复量 ≈ 2% 最大生命
        gains = []
        for _ in range(3):
            self._damage(per_hit)
            gains.append(self.pet.buffs.get("atk") or 0)
        self.assertEqual(gains, [0, 0, 10],
                         f"三次约 2% 的溢出应当在第三次凑满 5% 那一档：{gains}")
        self.assertLess(self.pet.sustain["overheal"]["carry_pct"], 5)

    def test_no_sustain_means_no_change(self):
        """⑤ 反向对照：没有 `sustain` 的精灵，结算前后一个字节都不变。"""
        foe = self.state.enemy.field_pet
        self.assertEqual(foe.sustain, {}, "对面那只没有吸血特性 → sustain 必须是空的")
        before = (foe.hp, dict(foe.buffs), len(self.state.events))
        renv._settle_sustain(self.state, RS, "enemy", 999)
        self.assertEqual((foe.hp, dict(foe.buffs)), (before[0], before[1]),
                         "没有 sustain 的一方，结算前后一个字节都不许变")
        self.assertEqual([getattr(e, "kind", None) for e in self.state.events[before[2]:]], [],
                         "也不该产生任何新事件")

    def test_assumption_is_registered(self):
        """④c 两条假设必须登记（不是只有代码注释里有）。"""
        self.pet.buffs.clear()
        self.pet.hp = self.pet.max_hp
        self._damage(self.pet.max_hp * 2)
        whats = [str(getattr(u, "what", u)) for u in self.state.unsupported]
        self.assertTrue(any("过量回复" in w for w in whats),
                        f"「过量回复转化」的口径假设必须登记进 unsupported：{whats[:5]}")


class TestLifestealOnlyTrait(unittest.TestCase):
    """`渴求`（恶魔叮）：「入场时获得50%吸血」——同一族原语，但没有转化那半句。"""

    def test_lifesteal_only_trait_has_no_overheal_rule(self):
        rc.clear_cache()
        state = renv.reset(["pet_000009", PET_PLAIN, "pet_000112", "pet_000417", "pet_000484", "pet_000330"],
                           TEAM_B, seed=5, rs=RS, config=rc.load_config(V3),
                           unverified_overrides=_overrides())
        pet = state.player.pets[0]
        self.assertEqual(pet.sustain, {"lifesteal_pct": 50},
                         "只写了吸血 → sustain 里不该凭空多出 overheal 参数")
        pet.hp = 100
        renv._settle_sustain(state, RS, "player", 200)
        self.assertEqual(pet.hp, 200, "200 × 50% = 100 点回复")
        self.assertEqual([e.kind for e in state.events if e.kind == "overheal_to_stat"], [],
                         "没有转化规则时不许产出转化事件")
        self.assertEqual(tr.TRAITS["渴求"].status, tr.FULL)
        # 按解析结果分派：两条特性走的是同一段实现（改名字不影响）
        for name in ("贪得无厌", "渴求"):
            row = tr.trait_skill(RS, tr.TRAITS[name].pet_name and
                                 next(p for p in RS.pets.values() if p.name == tr.TRAITS[name].pet_name).pet_id)
            self.assertTrue(tr.is_sustain_only(parse_mod.parse_skill(row)), name)


class TestSchemaDiscipline(unittest.TestCase):
    def test_empty_sustain_is_not_serialized(self):
        """⑥ 空 `sustain` 不进序列化 —— legacy / v2 的往返形状与指纹都不变。

        ⚠ 用**冻结名单里真实存在**的精灵（legacy 12 只练习队），而不是把恶魔男爵塞进去：
        特性钩子本身**不受配置开关约束**（它是游戏机制），所以只要队里有那只精灵，
        legacy 局里它也会生效 —— 而冻结的 legacy/v2 名单里没有它（下一条判据钉住这一点），
        这就是「legacy 逐位不变」成立的原因。
        """
        rc.clear_cache()
        legacy = rc.load_config(LEGACY)
        frozen_a = [RS.pets_by_name(n)[0].pet_id for n in
                    ("寂灭骨龙", "海豹船长", "黑猫巫师")]
        frozen_b = [RS.pets_by_name(n)[0].pet_id for n in
                    ("秩序鱿墨", "画间沉铁兽", "月使鹭纳")]
        state = renv.reset(frozen_a, frozen_b, seed=5, rs=RS, config=legacy)
        for pet in state.player.pets + state.enemy.pets:
            self.assertEqual(pet.sustain, {})
            self.assertNotIn("sustain", pet.to_dict(), "没这条概念时序列化里不该出现这个键")
            self.assertNotIn("energy_cost_mods", pet.to_dict())

    def test_round_trip_keeps_sustain(self):
        """有值时必须能往返（否则服务端每次规划都会把特性状态丢掉）。"""
        state = _state()
        pet = state.player.pets[0]
        again = pet.from_dict(pet.to_dict())
        self.assertEqual(again.sustain, pet.sustain)
        self.assertIn("sustain", pet.to_dict())

    def test_frozen_roster_has_no_sustain_pet(self):
        """机制对冻结 48 名单纯属惰性：那条特性属于图鉴里的精灵（回归指纹因此不变）。"""
        rc.clear_cache()
        frozen_path = os.path.join(ROOT, "data", "roco", "normalized",
                                   "roco-world-s4-2026-09-10", "layer-playable-48", "pets.json")
        with open(frozen_path, encoding="utf-8") as handle:
            frozen = json.load(handle)["pets"]
        self.assertNotIn(PET_GREEDY, frozen, "恶魔男爵不在冻结 48 名单里 —— 这正是回归指纹不变的原因")
        self.assertIn(PET_GREEDY, RS.pets, "但它在图鉴层（622）里存在")


def rs_name(pet_id: str) -> str:
    return RS.pets[pet_id].name


if __name__ == "__main__":
    unittest.main()
