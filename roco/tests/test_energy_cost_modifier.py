"""RC-401 批三：**技能能耗修正**机制 + `抓到你了` / 冻结钩子分派。

人类计划（`docs/roadmap/HANDOFF-2026-09-23.md` §3.4）点名的两件事：
  · `抓到你了`（雪影冰灵）第二句「使敌方获得冻结时，也会使其获得全技能能耗+1」
    → 触发点已存在（`after_freeze_applied`），但那个钩子**写死了 `捉迷藏`**，而且
    **「技能能耗修正」机制本身不存在**（旧实现只有一个没人读的 `_energy_cost_delta_all` 标记）。
  · 纪律：机制只在**配置声明**（`energy.cost_modifier`）时生效，legacy / v2 逐位不变；
    复合顺序与下限未定义（MC-018）→ 不设下限，负值 fail closed。

这个文件里的每一条都对应一个**会红的方向**，不是「跑一遍没报错」：
  ① 声明了机制 → 修正真的改可付性与扣费；
  ② 关掉机制（legacy / v2）→ 动作与扣费**逐位不变**（同一条状态，两种配置对照）；
  ③ 负能耗不编下限：合法动作里不出现、扣费抛错；
  ④ 到期修正按回合清掉；
  ⑤ 钩子按特性分派：`捉迷藏` 与 `抓到你了` 都结算，写死任何一条都会让另一条红；
  ⑥ trait 侧与 env 侧的状态层数语义必须一致（孪生实现不许漂）。
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import effects as fx          # noqa: E402
from roco_env import rule_config as rc      # noqa: E402
from roco_env import traits as tr           # noqa: E402
from roco_env.schema import ACTION_SKILL, Action   # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
#: 抓到你了 / 贪得无厌 的持有者与两条对照精灵（都在冻结 48 名单里或图鉴里）
PET_TRAIT = "pet_000546"      # 雪影冰灵（抓到你了）
PET_ICE_DOLL = "pet_000112"   # 雪影娃娃（捉迷藏）
TEAM_A = [PET_TRAIT, PET_ICE_DOLL, "pet_000062", "pet_000417", "pet_000484", "pet_000330"]
TEAM_B = ["pet_000130", "pet_000137", "pet_000139", "pet_000143", "pet_000152", "pet_000153"]


def _overrides() -> list:
    return [{
        "path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS",
        "reason": "同速平手裁决未核验（MC-E05 未录制），按已登记的工程权宜走",
        "microcase_id": "MC-E05",
    }]


def _state(config_id: str = V3):
    rc.clear_cache()
    return renv.reset(TEAM_A, TEAM_B, seed=5, rs=RS, config=rc.load_config(config_id),
                      unverified_overrides=_overrides())


def _cfg(config_id: str = V3):
    rc.clear_cache()
    return rc.load_config(config_id)


def _loadout_attack(state, pet_id: str):
    """从**这一场的配招**里挑一条带静态威力、能耗 > 0 的攻击技能。

    ⚠ 必须来自配招：`legal_actions` 按配招枚举（图鉴可学 ≠ 这场带得上），
    拿学习表里的技能去比合法动作只会得到空列表 —— 那会让判据变成恒真的空转。
    """
    row = tuple(state.player.loadouts.get(pet_id) or ())
    for sid in row:
        skill = RS.skills.get(sid)
        if skill is not None and skill.is_attack and skill.energy > 0 and skill.has_static_power:
            return skill
    raise AssertionError(f"{RS.pets[pet_id].name} 的配招里没有可用的攻击技能，判据没法构造")


class TestEffectiveCost(unittest.TestCase):
    def test_declared_config_applies_modifier(self):
        """① 声明了机制 → 修正真的进「有效能耗」，可付性与扣费都按它算。"""
        cfg = _cfg(V3)
        self.assertTrue(cfg.energy_cost_modifier, "v3 必须声明 energy.cost_modifier")
        state = _state()
        pet = state.player.field_pet
        skill = _loadout_attack(state, pet.pet_id)
        base = renv.effective_skill_cost(pet, skill, cfg)
        self.assertEqual(base, skill.energy, "没有修正时有效能耗 = 基础能耗")
        tr.grant_energy_cost_mod(pet, scope="all", delta=2, source="测试")
        self.assertEqual(renv.effective_skill_cost(pet, skill, cfg), skill.energy + 2)
        # 可付性：只剩基础能耗时，+2 之后这一手必须从合法动作里消失
        pet.energy = skill.energy
        legal = [a for a in renv.legal_actions(state, RS, "player", cfg)
                 if a.kind == ACTION_SKILL and a.skill_id == skill.skill_id]
        self.assertEqual(legal, [], "能量只够基础能耗时，+2 修正必须让这一手不合法")

    def test_scope_is_respected(self):
        """作用域不是装饰：`attack` 修正不许动防御 / 状态技能。"""
        cfg = _cfg(V3)
        state = _state()
        pet = state.player.field_pet
        attack = _loadout_attack(state, pet.pet_id)
        defense = next(s for s in RS.skills.values() if s.is_defense and not s.is_trait and s.energy > 0)
        tr.grant_energy_cost_mod(pet, scope="attack", delta=3, source="测试")
        self.assertEqual(renv.effective_skill_cost(pet, attack, cfg), attack.energy + 3)
        self.assertEqual(renv.effective_skill_cost(pet, defense, cfg), defense.energy,
                         "attack 作用域不许影响防御技能")

    def test_legacy_and_v2_are_bit_identical(self):
        """② 反向对照：没声明机制的配置里，修正**一个字节都不生效**。"""
        # legacy 是 3v3、v2 是六宠（模式规模由登记表决定），两队都要按各自规模给
        cases = ((LEGACY, TEAM_A[:3], TEAM_B[:3], None),
                 (rc.CANDIDATE_RULE_CONFIG_ID, TEAM_A, TEAM_B, _overrides()))
        for config_id, team_a, team_b, overrides in cases:
            cfg = _cfg(config_id)
            self.assertFalse(cfg.energy_cost_modifier, f"{config_id} 不该声明能耗修正机制")
            state = renv.reset(team_a, team_b, seed=5, rs=RS, config=cfg, unverified_overrides=overrides)
            pet = state.player.field_pet
            skill = _loadout_attack(state, pet.pet_id)
            tr.grant_energy_cost_mod(pet, scope="all", delta=9, source="测试")
            self.assertEqual(renv.effective_skill_cost(pet, skill, cfg), skill.energy,
                             f"{config_id}：没声明机制时修正不许生效")
            pet.energy = skill.energy
            legal = [a for a in renv.legal_actions(state, RS, "player", cfg)
                     if a.kind == ACTION_SKILL and a.skill_id == skill.skill_id]
            self.assertTrue(legal, f"{config_id}：机制关闭时这一手仍然合法（逐位不变）")

    def test_negative_cost_fails_closed(self):
        """③ 下限未定义（MC-018）→ 不编一个 0：合法动作里不出现，扣费抛错。"""
        cfg = _cfg(V3)
        state = _state()
        pet = state.player.field_pet
        skill = _loadout_attack(state, pet.pet_id)
        tr.grant_energy_cost_mod(pet, scope="all", delta=-(int(skill.energy) + 5), source="测试")
        self.assertLess(renv.effective_skill_cost(pet, skill, cfg), 0)
        legal = [a for a in renv.legal_actions(state, RS, "player", cfg)
                 if a.kind == ACTION_SKILL and a.skill_id == skill.skill_id]
        self.assertEqual(legal, [], "有效能耗为负 → 拿不到定价，不提供这一手")
        pet.energy = 10
        with self.assertRaises(fx.UnsupportedEffect):
            renv._execute(state, RS, "player", Action(ACTION_SKILL, skill_id=skill.skill_id), cfg)

    def test_expiring_modifier_is_cleared_at_turn_end(self):
        """④ 到期修正按回合清掉（`until_turn`），永久修正留着。"""
        state = _state()
        pet = state.player.field_pet
        tr.grant_energy_cost_mod(pet, scope="all", delta=1, source="永久")
        tr.grant_energy_cost_mod(pet, scope="all", delta=2, source="三回合", until_turn=state.turn + 2)
        self.assertEqual(len(pet.energy_cost_mods), 2)
        for _ in range(4):
            state.turn += 1
            renv._tick_energy_cost_mods(state)
        left = [m["source"] for m in pet.energy_cost_mods]
        self.assertEqual(left, ["永久"], f"到期的那条应当被清掉，实际剩下 {left}")


class TestFreezeTraitHooks(unittest.TestCase):
    def test_hook_dispatches_by_trait_not_by_name(self):
        """⑤ 钩子按**特性登记的 hook** 分派：两条特性都要结算。"""
        # 捉迷藏（雪影娃娃）与 抓到你了（雪影冰灵）都声明了 after_freeze_applied
        specs = {name: spec for name, spec in tr.TRAITS.items()
                 if tr.implements_hook(spec, "after_freeze_applied")}
        self.assertIn("捉迷藏", specs)
        self.assertIn("抓到你了", specs)
        for pet_id, trait_name in ((PET_ICE_DOLL, "捉迷藏"), (PET_TRAIT, "抓到你了")):
            state = _state()
            side = "player"
            me = state.player
            me.active = next(i for i, p in enumerate(me.pets) if p.pet_id == pet_id)
            # 入场钩子在 reset 里已经跑过一轮（抓到你了 会留下修正）→ 清干净再单独驱动这一个钩子
            for side_state in (state.player, state.enemy):
                for p in side_state.pets:
                    p.energy_cost_mods = []
            events = []
            tr.after_freeze_applied(RS, state, side, events)
            self.assertEqual([e["trait"] for e in events], [trait_name],
                             f"{trait_name} 必须被钩子分派到（写死任何一条都会让另一条红）")
            foe_pet = state.enemy.field_pet
            self.assertEqual([m["source"] for m in foe_pet.energy_cost_mods], [trait_name])

    def test_on_enter_applies_two_freeze_layers_and_cost_rider(self):
        """`抓到你了`：入场给对方 2 层冻结（只记账），并沿同一条链给敌方 +1 全技能能耗。

        走**端到端**：`reset` 自己会跑首发入场钩子，所以不再手动调一次 `on_enter`
        （我第一版手动又调了一遍，层数变成 4 —— 这条判据自己抓住了这个写错法）。
        """
        state = _state()
        state.player.active = next(i for i, p in enumerate(state.player.pets) if p.pet_id == PET_TRAIT)
        # 把这只换上场 → 入场钩子按新人结算（`field_pet` 就是它）
        state.player.pets[0], state.player.pets[state.player.active] = (
            state.player.pets[state.player.active], state.player.pets[0])
        state.player.active = 0
        foe_pet = state.enemy.field_pet
        foe_pet.statuses.clear()
        foe_pet.energy_cost_mods = []
        events = []
        tr.on_enter(RS, state, "player", events)
        self.assertEqual(foe_pet.statuses.get("冻结", {}).get("layers"), 2,
                         "入场必须给对方叠 2 层冻结")
        kinds = [e["kind"] for e in events]
        self.assertIn("status_added", kinds)
        self.assertIn("trait", kinds)
        self.assertEqual([m["delta"] for m in foe_pet.energy_cost_mods], [1],
                         "冻结骑手：敌方全技能能耗 +1")
        self.assertEqual(foe_pet.energy_cost_mods[0]["scope"], "all")
        # 冻结的回合末结算**仍未实现**（术语 1004 没写时序）→ 状态存在但不在 END_OF_TURN_STATUS
        self.assertNotIn("冻结", fx.END_OF_TURN_STATUS,
                         "术语 1004 没写时序，冻结的回合末结算不该被悄悄实现")

    def test_status_layer_semantics_match_env(self):
        """⑥ 孪生实现不许漂：trait 侧与 env 侧叠层数的语义必须一致。"""
        state = _state()
        pet = state.enemy.field_pet
        pet.statuses.clear()          # reset 的入场钩子可能已经叠过（抓到你了 首发就在队里）
        first = tr.apply_status_layers(state, pet, "冻结", 2)
        second = tr.apply_status_layers(state, pet, "冻结", 3)
        self.assertEqual((first, second), (2, 5))
        self.assertEqual(pet.statuses["冻结"], {"layers": 5})

    def test_legacy_battle_does_not_gain_the_mechanism(self):
        """反向对照：legacy 配置下就算挂上修正，动作与扣费也不变（端到端）。"""
        state = renv.reset(TEAM_A[:3], TEAM_B[:3], seed=5, rs=RS, config=_cfg(LEGACY))
        pet = state.player.field_pet
        skill = _loadout_attack(state, pet.pet_id)
        tr.grant_energy_cost_mod(pet, scope="all", delta=4, source="测试")
        pet.energy = skill.energy
        acts = [a for a in renv.legal_actions(state, RS, "player", _cfg(LEGACY))
                if a.kind == ACTION_SKILL and a.skill_id == skill.skill_id]
        self.assertTrue(acts, "legacy：机制关闭时这一手必须还在")
        renv._execute(state, RS, "player", Action(ACTION_SKILL, skill_id=skill.skill_id), _cfg(LEGACY))
        self.assertEqual(pet.energy, skill.energy - skill.energy,
                         "legacy：扣的仍然是基础能耗（没有 +4）")


if __name__ == "__main__":
    unittest.main()
