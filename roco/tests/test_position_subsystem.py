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


# ── 2026-09-28 改钉（夹具的**载体查找**多一条回落；判据与断言一条都没动，也没有放宽）──────
# 旧写法（留档，不许删）：
#     def _pet_with(skill_id: str) -> str:
#         for pid in RS.pets:
#             if skill_id in (RS.candidate_moveset(pid) or ()):
#                 return pid
#         raise AssertionError(f"没有精灵带 {skill_id}")
#
# 凭什么改（实测，不是猜的）：本轮可玩层从旧 36 只换成纯抓包的 530 只（合并冻结 542；人类
# 2026-09-28 逐字「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。所有精灵实装」）。
# 层里的 `support-matrix.json` 是**重新生成的规范配招**，`skill_000468 械斗` 在新层有
# **167 只** FULL_VERIFIED 精灵学得到，但**没有任何一只**的规范配招带它（旧层同样是 0 只：
# 旧的载体 `pet_000500 小鼓象 / pet_000501 巨鼓象` 当时是按需推算的 SIMULATABLE_UNVERIFIED，
# 推算出来的配招恰好把械斗排在 4 号位；新层它们进了冻结层，规范配招重选后不再带械斗）。
# ⇒ 「规范配招」这条线索在新层断了，但**技能本身没被撤下**、载体也没被撤下。回落顺序：
#   ① 先照旧找「规范配招里带它」的（数据回到那种形态时行为一字不变）；
#   ② 找不到再找「冻结学招表里学得到它」的 FULL_VERIFIED 精灵 —— 本文件本来就**显式传
#      `loadouts`**（`_run` / 第三条判据都是），所以配招由判据自己装，载体只要能学得到即可。
# 判据本身（1 号位 +60 / 4 号位不触发 / 未声明能力一个事件都没有 / 传动 1 后配招顺序真的变）
# 逐条照旧，没有一个字被放宽。
def _learns(skill_id: str) -> str | None:
    for pid in sorted(RS.pets):
        if RS.build_support_of(pid) == rdata.SUPPORT_FULL_VERIFIED and RS.is_learnable(pid, skill_id):
            return pid
    return None


def _pet_with(skill_id: str) -> str:
    for pid in RS.pets:
        if skill_id in (RS.candidate_moveset(pid) or ()):
            return pid
    fallback = _learns(skill_id)
    if fallback is not None:
        return fallback
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
