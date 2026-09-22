"""C1（第 139 轮）：位置子系统 —— 号位条件 + 传动。

为什么这两条必须一起做：实测带「本技能位于N号位」的 5 条技能**全部同时带「传动」**，
只做一条解锁 0 条。位置在构建时已知（配招有序），所以是**确定性**条件。

纪律（与 `damage.multi_hit` 同一套）：两条能力**只有配置声明了才生效**；
未声明时（legacy / v2）一个字节都不变 —— 本文件里 legacy 那两条就是这条纪律的判据。
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as parse_mod     # noqa: E402
from roco_env import opponents as opp       # noqa: E402

RS = rdata.load_ruleset()
opp.bind_ruleset(RS)   # 策略要先绑规则集（play_match 会自动绑，这里手工绑）
V3 = "mobile_s4_candidate_v3"
LEGACY = "legacy_sim_v1"


def _pet_with(skill_id: str) -> str:
    for pid in RS.pets:
        if skill_id in (RS.candidate_moveset(pid) or ()):
            return pid
    raise AssertionError(f"没有精灵带 {skill_id}")


def _run(loadout_first: str, config: str, overrides=None):
    carrier = _pet_with(loadout_first)
    base = list(RS.candidate_moveset(carrier) or ())
    order = [loadout_first] + [s for s in base if s != loadout_first][:3]
    others = [p for p in RS.pets if p != carrier][:5]
    team_a = [carrier] + others
    team_b = [p for p in RS.pets if p not in team_a][:6]
    state = renv.reset(team_a, team_b, seed=5, rs=RS, config=config,
                       loadouts={carrier: tuple(order)},
                       unverified_overrides=overrides)
    return state, carrier


class SlotConditionTest(unittest.TestCase):
    def setUp(self):
        self._overrides = [
            {"path": "turn_order.speed_tie", "value": "random_seeded",
             "confidence": "ENGINE_HYPOTHESIS", "reason": "test", "microcase_id": "MC-E05"},
        ]

    def test_slot_condition_applies_when_the_skill_is_in_that_slot(self):
        """械斗在 1 号位 → 引擎必须记一条 slot_condition_applied（威力 +60）。"""
        state, carrier = _run("skill_000468", V3, self._overrides)
        state.player.field_pet.energy = 10
        action = next(a for a in renv.legal_actions(state, RS, "player")
                      if a.kind == "skill" and a.skill_id == "skill_000468")
        # 直接执行**我方这一手**：用 `step_joint` 时敌方可能先手把我的精灵打倒，
        # 技能根本不执行（第一版就是这么拿到空事件的）。`_execute` 是同一段引擎代码。
        renv._execute(state, RS, "player", action, renv._rule_config.get_rule_config(V3))
        applied = [e for e in state.events if e.kind == "slot_condition_applied"]
        self.assertTrue(applied, "1 号位的械斗必须触发号位条件")
        self.assertEqual(applied[0].detail["power_delta"], 60)
        self.assertEqual(applied[0].detail["position"], 1)

    def test_slot_condition_does_not_apply_in_the_wrong_slot(self):
        """同一只技能放到 4 号位 → 不许触发（位置不匹配）。"""
        carrier = _pet_with("skill_000468")
        base = list(RS.candidate_moveset(carrier) or ())
        order = [s for s in base if s != "skill_000468"][:3] + ["skill_000468"]
        others = [p for p in RS.pets if p != carrier][:5]
        team_a = [carrier] + others
        team_b = [p for p in RS.pets if p not in team_a][:6]
        state = renv.reset(team_a, team_b, seed=5, rs=RS, config=V3,
                           loadouts={carrier: tuple(order)}, unverified_overrides=self._overrides)
        state.player.field_pet.energy = 10
        action = next(a for a in renv.legal_actions(state, RS, "player")
                      if a.kind == "skill" and a.skill_id == "skill_000468")
        renv._execute(state, RS, "player", action, renv._rule_config.get_rule_config(V3))
        applied = [e for e in state.events if e.kind == "slot_condition_applied"]
        self.assertFalse(applied, "4 号位的械斗不该拿到 1 号位的加成")

    def test_undeclared_capability_changes_nothing(self):
        """没声明能力（这里用同一份 v3 配置把两条关掉）⇒ 既没有号位事件、也没有传动事件。

        这就是**必红方向**：把「声明了才生效」写成「一律生效」，这条立刻红。
        （不用 legacy 配置本身：它是 3v3 模式，塞 6 只精灵会被规模校验先挡下。）
        """
        import dataclasses as _dc
        from roco_env import rule_config as rc
        state, carrier = _run("skill_000468", V3, self._overrides)
        cfg = _dc.replace(rc.get_rule_config(V3),
                          damage_slot_condition=False, damage_position_shift=False)
        state.player.field_pet.energy = 10
        action = next(a for a in renv.legal_actions(state, RS, "player")
                      if a.kind == "skill" and a.skill_id == "skill_000468")
        renv._execute(state, RS, "player", action, cfg)
        kinds = {e.kind for e in state.events}
        self.assertNotIn("slot_condition_applied", kinds)
        self.assertNotIn("position_shift", kinds)
        # 配置层面也钉一下：legacy / v2 两条都是 False（缺字段 = False）。
        self.assertFalse(rc.get_rule_config("legacy_sim_v1").damage_slot_condition)
        self.assertFalse(rc.get_rule_config("mobile_s4_candidate_v2").damage_position_shift)

    def test_position_shift_moves_the_skill(self):
        """传动：用后这个技能在配招里的位置要变（v3 才生效）。"""
        state, carrier = _run("skill_000468", V3, self._overrides)
        before = list(state.player.loadouts[carrier])
        state.player.field_pet.energy = 10
        action = next(a for a in renv.legal_actions(state, RS, "player")
                      if a.kind == "skill" and a.skill_id == "skill_000468")
        renv._execute(state, RS, "player", action, renv._rule_config.get_rule_config(V3))
        shifted = [e for e in state.events if e.kind == "position_shift"]
        self.assertTrue(shifted, "械斗带传动1，用后必须记一条移位事件")
        self.assertEqual(shifted[0].detail["shift"], 1)
        self.assertNotEqual(list(state.player.loadouts[carrier]), before,
                            "传动之后配招顺序必须真的变了")


if __name__ == "__main__":
    unittest.main()
