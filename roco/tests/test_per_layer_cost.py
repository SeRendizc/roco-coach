"""RC-401 批次九：**动态能耗修正** —— 「敌方每有 N 层中毒效果，本技能能耗 -M」。

为什么是它（可达性工作单第一名）：`reports/roco/rc401/effect-coverage.json` 的
`reachability.top_blocked_by_reach` 里，`skill_000612 毒液渗透`（「造成魔伤，敌方每有1层中毒效果，
本技能能耗-1，敌方获得1层中毒。」）**51 只精灵的配招里都带**，而它卡住的那一段就是这条动态能耗。

判据（每条都有必红方向）：

  ① **结构读得出、未声明能力时一段都不许认领**：`敌方每有1层中毒效果` 在未声明口径下仍出现在
     `unclaimed_mechanic_spans()` 里（引擎照旧写 `state.unsupported`）；
  ② **只按对手场上那只的中毒层数算**：0 层 ⇒ 原价；N 层 ⇒ 每层减 M；
  ③ **可付性跟着变**：能量不够时，中毒层数把能耗压到付得起 ⇒ 这一手**必须出现**在合法动作里；
     层数不够 ⇒ 不出现（这是"动态"两个字唯一有产品意义的地方）；
  ④ **legacy 逐位不变**：没声明能力的配置里，同一个局面能耗与合法动作一个字节都不变；
  ⑤ **反证**：把能力位换成 False（连取配置那一步一起换掉）⇒ 能耗回到原价。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as rcov        # noqa: E402
from roco_env import data as rdata           # noqa: E402
from roco_env import env as renv             # noqa: E402
from roco_env import parse as rparse         # noqa: E402
from roco_env import rule_config as rc       # noqa: E402
from roco_env.schema import Action, ACTION_SKILL   # noqa: E402

RS = rdata.load_ruleset()
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID
VENOM = "skill_000612"          # 毒液渗透
OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
              "confidence": "ENGINE_HYPOTHESIS", "reason": "MC-E05 未录制", "microcase_id": "MC-E05"}]
#: 学得到「毒液渗透」的一只（实测 51 只配招里都有它）。
CARRIER = "pet_000617" if "pet_000617" in RS.pets else None


def _carrier():
    for pid in sorted(RS.pets):
        if VENOM in (RS.candidate_moveset(pid) or ()):
            return pid
    raise AssertionError("语料里找不到带「毒液渗透」的精灵，夹具失效")


class PerLayerCostParseTest(unittest.TestCase):
    def test_structure_is_read_but_not_claimed_until_declared(self):
        skill = RS.skills[VENOM]
        parsed = rparse.parse_skill(skill)
        self.assertEqual(parsed.per_layer_cost,
                         {"status": "中毒", "layer_step": 1, "delta": -1,
                          "evidence": "敌方每有1层中毒效果，本技能能耗-1"})
        self.assertNotIn("per_layer_cost", [e.kind for e in parsed.effects],
                         "没声明能力时不许自己补效果")
        spans_off = rparse.unclaimed_mechanic_spans(skill, parsed=parsed)
        self.assertTrue(any("每" in s for s in spans_off), f"未声明时必须仍未认领，实际 {spans_off}")
        resolved = rparse.resolve_per_layer_cost(skill, declared=True, parsed=parsed)
        spans_on = rparse.unclaimed_mechanic_spans(skill, parsed=resolved)
        self.assertIn("per_layer_cost", [e.kind for e in resolved.effects])
        self.assertEqual(spans_on, [], f"声明并结算之后不许再登记成未认领，实际 {spans_on}")

    def test_legacy_never_gets_the_effect(self):
        parsed = rparse.resolve_per_layer_cost(RS.skills[VENOM], declared=False)
        self.assertNotIn("per_layer_cost", [e.kind for e in parsed.effects])
        self.assertEqual(rcov.classify_skill(RS.skills[VENOM])["support"], rcov.SUPPORT_PARTIAL)
        caps = rcov.declared_capabilities_of()
        self.assertEqual(rcov.classify_skill(RS.skills[VENOM],
                                             per_layer_cost_declared=caps["per_layer_cost"])["support"],
                         rcov.SUPPORT_SIMULATABLE_UNVERIFIED)


class PerLayerCostEngineTest(unittest.TestCase):
    def _state(self, config_id, team_size=6):
        cfg = rc.get_rule_config(config_id)
        carrier = _carrier()
        team = [carrier] + [p for p in RS.pets if p != carrier][:team_size - 1]
        foe = ["pet_000050"] + [p for p in RS.pets if p not in (carrier, "pet_000050")][:team_size - 1]
        kwargs = {"unverified_overrides": OVERRIDES} if cfg.has_mana or cfg.allowed_kinds else {}
        return renv.reset(team, foe, seed=7, rs=RS, config=cfg, **kwargs), cfg

    def _poison(self, state, layers):
        pet = state.enemy.field_pet
        if layers:
            pet.statuses["中毒"] = {"layers": int(layers)}
        else:
            pet.statuses.pop("中毒", None)

    def test_cost_follows_the_foe_poison_layers(self):
        state, cfg = self._state(V3)
        self.assertTrue(cfg.energy_per_layer_cost, "v3 必须声明动态能耗修正能力")
        pet = state.player.field_pet
        skill = RS.skills[VENOM]
        base = int(skill.energy)
        for layers, want in ((0, base), (1, base - 1), (3, base - 3)):
            self._poison(state, layers)
            got = renv.effective_skill_cost(pet, skill, cfg, weather=state.weather,
                                            foe_status_layers=renv._poison_layers(state, "player"))
            self.assertEqual(got, want, f"{layers} 层中毒时能耗应当是 {want}（基础 {base}）")

    def test_affordability_follows_the_layers(self):
        """能量只够付 0 的时候：毒层够 ⇒ 这一手合法；毒层不够 ⇒ 不合法。"""
        state, cfg = self._state(V3)
        pet = state.player.field_pet
        skill = RS.skills[VENOM]
        pet.energy = int(skill.energy) - 2          # 只付得起「减 2」
        action = Action(kind=ACTION_SKILL, skill_id=VENOM)
        self._poison(state, 0)
        self.assertNotIn(action, renv.legal_actions(state, RS, "player"),
                         "没有中毒层数时这一手付不起，不该出现")
        self._poison(state, 2)
        self.assertIn(action, renv.legal_actions(state, RS, "player"),
                      "2 层中毒把能耗压到付得起 ⇒ 必须出现（这是动态能耗唯一有产品意义的地方）")

    def test_legacy_is_bit_identical(self):
        state, cfg = self._state(LEGACY, team_size=3)
        self.assertFalse(cfg.energy_per_layer_cost, "legacy 不该凭空多出这条能力")
        pet = state.player.field_pet
        skill = RS.skills[VENOM]
        self._poison(state, 3)
        self.assertEqual(renv.effective_skill_cost(pet, skill, cfg, weather=state.weather,
                                                  foe_status_layers=renv._poison_layers(state, "player")),
                         int(skill.energy), "legacy 的能耗必须与层数无关")

    def test_reverse_proof_switching_the_capability_off(self):
        from unittest import mock
        state, cfg = self._state(V3)
        pet = state.player.field_pet
        skill = RS.skills[VENOM]
        self._poison(state, 3)
        layers = renv._poison_layers(state, "player")
        self.assertEqual(renv.effective_skill_cost(pet, skill, cfg, weather=state.weather,
                                                   foe_status_layers=layers),
                         int(skill.energy) - 3, "对照组：声明了就是减 3")
        flipped = __import__("dataclasses").replace(cfg, energy_per_layer_cost=False)
        # ⚠ 这里必须传 `cfg=None`：`effective_skill_cost` 只在**没拿到配置**时才去 `get_rule_config()`，
        # 直接传 cfg 会让"换掉取配置那一步"这个反证落空（第一版就是这么写的，实测假绿）。
        with mock.patch.object(renv._rule_config, "get_rule_config", lambda *a, **k: flipped):
            self.assertEqual(renv.effective_skill_cost(pet, skill, None, weather=state.weather,
                                                      foe_status_layers=layers),
                             int(skill.energy), "能力位关掉就不许再减")


if __name__ == "__main__":
    unittest.main()
