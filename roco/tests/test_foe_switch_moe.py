"""`736 转圈圈` 的判据（task-28 · 2026-09-30 · H 族萌化第二条）。

描述逐字：「造成魔伤，**若敌方本回合更换精灵**，本次攻击**使**敌方获得萌化。」

**与 `285` 的两处不同**（裸 dump 出来的 ✓ 不猜）：
  ① 措辞是「**使**敌方获得萌化」（**不是**「获得」✗ 也**不带层数**✗）⇒ 解析层**原本读不出**（`leftover` 就是这句 ✓）
  ② **条件式**（"若敌方本回合更换精灵"）⇒ 走 `env._gate_foe_switch_effects`（**现成** ✓）

**口径**（照 `H萌化原语设计-2026-09-30.md` + Lead 批准 ✓）：
  · **复用** `foe_status`（**不新开 kind** ✗）⇒ `_apply_effect_batch` 同一支就吃到 ⇒ 走 `285` 那条 `marks` 路由 ✓
  · ⚠ 产出**必须带 `requires:"foe_switch"`** ✗ —— 否则 `_gate_foe_switch_effects` 的第二道检查
    认不出它是条件效果 ⇒ **会无条件结算** ✗✗（= 敌方没换人也给萌化，正是本件的反证 ✗）
  · **层数默认 1** = **本地规则** ✓（描述没写 ⇒ 与同族 `285`/`732` 明写的「1层」一致 ✓ 已登记进生成器 `reason` ✓）
  · 条件式授予**两道门都要**：`damage.moe_mark`（真写 ✓）+ `damage.foe_switch_condition`（条件筛选 ✓）

**验收三条同时** ✓：`verdict=True` **且** `spans==[]` **且** 真打一手有 Δ ✓
**两条反证同时** ✓✗：换人 ⇒ 给萌化 ✓；**没换人 ⇒ `marks` 不许有 且 span 仍如实点名** ✓
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
from roco_env.schema import ACTION_SKILL, ACTION_SWITCH, Action  # noqa: E402

SID = "skill_000736"
_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(enemy_switches: bool):
    """真打一手：我方出 736；敌方**换人**或**出招**（两条反证的刺激 ✓）。"""
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if SID in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([SID] + [s for s in rs.candidate_moveset(mine) if s != SID][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    a = Action(ACTION_SKILL, skill_id=SID)
    assert a in E.legal_actions(state, rs, "player"), f"{SID} 不合法"
    if enemy_switches:
        foe = next(x for x in E.legal_actions(state, rs, "enemy") if x.kind == ACTION_SWITCH)
    else:
        foe = next(x for x in E.legal_actions(state, rs, "enemy")
                   if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe)


class FoeSwitchMoeGrantTest(unittest.TestCase):
    def test_parse_shape_carries_the_condition_flag(self):
        """⚠ **`requires:"foe_switch"` 必须在**（否则条件筛选认不出它 ⇒ 无条件结算 ✗）。"""
        rs = D.load_ruleset()
        parsed = P.parse_skill(rs.skills[SID])
        effs = [e for e in parsed.foe_switch_effects if e.kind == "foe_status"]
        self.assertEqual(len(effs), 1, f"应读出 1 条条件式授予，实际={parsed.foe_switch_effects}")
        self.assertEqual(effs[0].value.get("status"), "萌化", "状态名应为「萌化」✗")
        self.assertEqual(effs[0].value.get("requires"), "foe_switch",
                         "**必须带 `requires:'foe_switch'`** ✗ 否则会无条件结算 ✗✗")
        self.assertEqual(parsed.foe_switch_leftover, "", "子句体应被读干净（leftover 为空）✗")

    def test_counter_proof_enemy_switched_grants_the_mark(self):
        """**反证①**：敌方**换人** ⇒ `marks={'萌化':1}` ✓。"""
        after = _play(enemy_switches=True)
        self.assertEqual(dict(after.enemy.field_pet.marks or {}).get("萌化"), 1,
                         "敌方换人时应获得 1 层萌化 ✗")
        self.assertTrue([e for e in after.events if e.kind == "mark_added"], "应发 `mark_added` ✗")

    def test_counter_proof_enemy_did_not_switch_grants_nothing(self):
        """**反证②**：敌方**没换人** ⇒ `marks` 不许有 ✓ **且**条件被如实记 skipped ✓。"""
        after = _play(enemy_switches=False)
        self.assertEqual(dict(after.enemy.field_pet.marks or {}), {},
                         "敌方没换人 ⇒ 一个字都不许写 ✗")
        skipped = [e for e in after.events if e.kind == "foe_switch_condition_skipped"]
        self.assertTrue(skipped, "没换人应发 `foe_switch_condition_skipped`（如实登记 ✓）✗")

    def test_acceptance_three_conditions_hold_together(self):
        """**验收三条同时** ✓（只看 `verdict` 会被词表过滤骗过 ✗）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        v = C.settlement_verdict(sk, declared=caps)
        self.assertTrue(v["resolved"], "① 产品口径必须说已结算 ✗")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空**（这条才是「真的认领了」）✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")

    def test_gating_two_leaves_both_required(self):
        """**两道门都要** ✓：关任一个 ⇒ 两把尺子都说未结算 ✓（不是恒真 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for key in ("moe_mark", "foe_switch_condition"):
            off = dict(caps)
            off[key] = False
            flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
            self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"],
                             f"关掉 `{key}` 后判据必须说未结算 ✗")
            self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                             f"关掉 `{key}` 后档位必须说 PARTIAL ✗")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗：`722 转移` / `731 读层数` 仍如实未结算 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        # ⚠ 2026-09-30（task-28 · `722 反弹`）**改钉**：`722` **已实现** ⇒ 从本清单移出 ✓
        #   （它的正向钉子见 `test_mark_transfer.py` ✓ —— **只移不删** ✓）；`731 月光合奏`
        #   （**读层数 · 全队范围** = 设计 §7 里"还没做"的那一块 ✓）**仍必须如实未结算** ✓
        for sid in ("skill_000731",):
            self.assertFalse(C.settlement_verdict(rs.skills[sid], declared=caps)["resolved"],
                             f"{sid} 还没做 ⇒ 不许被顺手放行 ✗")


if __name__ == "__main__":
    unittest.main()
