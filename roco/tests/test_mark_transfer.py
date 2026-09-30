"""`722 反弹` 的判据（task-28 · 2026-09-30 · H 族萌化第三条）。

描述逐字：「**将自己的萌化转移给敌方。**」

**语义 = 搬家**（`self → foe`，**自己那份清零** ✗ **不是复制** ✗）
  · 描述**没有层数** ⇒ 搬的是"自己现有的层数" ✓ ⇒ **0 层 = 无事发生** ✓
  · ⇒ 所以它带 `requires:"self_has_mark"`（**条件 = 自己有这个标记** ✓ 与 `736` 的 `foe_switch` 同族 ✓）

**为什么它不是"只在判据侧认领"的 kind**（Lead 2026-09-30 裁决 ✓）：
  「**真施加必须真写**」✓ —— 它要**真的搬家** ⇒ effect 必须进 `_apply_effect_batch` 的写点 ✓
  （若做成纯认领 kind ⇒ 要么 ⓐ 写了没人读 ✗、要么"判据说已结算而运行时没搬" ✗✗ 两头不讨好）

**验收三条同时** ✓：`verdict=True` **且** `spans==[]` **且** 真打一手有 Δ ✓
**两条反证同时** ✓✗：自己有 ⇒ 敌方得 + **自己清零** ✓；**自己没有 ⇒ 两边都不许变** ✓
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import coverage as C  # noqa: E402
from roco_env import parse as P  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

SID = "skill_000722"
_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(self_layers: int):
    """真打一手：**先手动给自己 N 层萌化**（造出可观测前提 ✓）⇒ 出 722。"""
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if SID in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([SID] + [s for s in rs.candidate_moveset(mine) if s != SID][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    if self_layers:
        state.player.field_pet.marks["萌化"] = self_layers
    a = Action(ACTION_SKILL, skill_id=SID)
    assert a in E.legal_actions(state, rs, "player"), f"{SID} 不合法"
    foe = next(x for x in E.legal_actions(state, rs, "enemy")
               if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe)


class MarkTransferTest(unittest.TestCase):
    def test_parse_shape_carries_the_condition_flag(self):
        """⚠ **`requires:"self_has_mark"` 必须在**（否则条件门认不出 ⇒ 会无条件搬 ✗）。"""
        rs = D.load_ruleset()
        # ⚠ 裸 `parse_skill` **不产出**它 ✗ —— 它由 **resolver** 产出（带 `declared=True` ✓）
        #   （我第一版写成裸解析 ⇒ 判据自己红 ✓ —— 这正是"判据要真判行为"的价值 ✓）
        effs = [e for e in P.resolve_mark_transfer(rs.skills[SID], declared=True).effects
                if e.kind == "transfer_mark"]
        self.assertEqual(len(effs), 1, "应读出 1 条转移效果 ✗")
        self.assertEqual(effs[0].value.get("mark"), "萌化", "标记名应为「萌化」✗")
        self.assertEqual(effs[0].value.get("requires"), "self_has_mark",
                         "**必须带 `requires:'self_has_mark'`** ✗ 否则会无条件搬 ✗✗")

    def test_counter_proof_moves_and_clears_the_source(self):
        """**反证①**：自己有 1 层 ⇒ 敌方得 1 层 **且自己清零** ✓（**搬家不是复制** ✗）。"""
        after = _play(self_layers=1)
        self.assertEqual(int((after.player.field_pet.marks or {}).get("萌化", 0) or 0), 0,
                         "搬家后**自己那份必须清零** ✗（不是复制 ✗）")
        self.assertEqual(int((after.enemy.field_pet.marks or {}).get("萌化", 0) or 0), 1,
                         "敌方应得到 1 层 ✗")
        moved = [e for e in after.events if e.kind == "mark_transferred"]
        self.assertEqual(len(moved), 1, "应恰有一条 `mark_transferred` ✗")
        self.assertEqual(moved[0].detail.get("layers"), 1, f"事件字段不对：{moved[0].detail}")

    def test_counter_proof_no_source_layers_means_nothing_happens(self):
        """**反证②**：自己没有萌化 ⇒ **两边都不许变** ✓ + 条件被如实记 skipped ✓。"""
        after = _play(self_layers=0)
        self.assertEqual(dict(after.player.field_pet.marks or {}), {}, "自己不该有 ✗")
        self.assertEqual(dict(after.enemy.field_pet.marks or {}), {}, "敌方也不该有 ✗")
        self.assertTrue([e for e in after.events if e.kind == "self_mark_condition_skipped"],
                        "没可搬的应如实发 `self_mark_condition_skipped` ✗")
        self.assertEqual([e for e in after.events if e.kind == "mark_transferred"], [],
                         "没可搬的不许发 `mark_transferred` ✗")

    def test_acceptance_three_conditions_hold_together(self):
        """**验收三条同时** ✓（只看 `verdict` 会被词表过滤骗过 ✗）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        v = C.settlement_verdict(sk, declared=caps)
        self.assertTrue(v["resolved"], "① 产品口径必须说已结算 ✗")
        self.assertIn("转移标记", v["settled"], "`settled` 必须有这一条（否则永远 False ✗）")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空**（这条才是「真的认领了」）✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")

    def test_counter_proof_capability_off_means_unsettled(self):
        """**反证**：关能力位 ⇒ 两把尺子都说未结算 ✓（不是恒真 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        off = dict(C.declared_capabilities_of("mobile_s4_candidate_v3"))
        off["moe_mark"] = False
        flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
        self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"], "判据必须说未结算 ✗")
        self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                         "档位必须说 PARTIAL ✗")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗：`731 月光合奏`（读层数 · 全队范围 = 设计 §7 那块）仍如实未结算 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        self.assertFalse(C.settlement_verdict(rs.skills["skill_000731"], declared=caps)["resolved"],
                         "731 还没做 ⇒ 不许被顺手放行 ✗")


if __name__ == "__main__":
    unittest.main()
