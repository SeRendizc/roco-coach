"""`289 无畏之心` 的两条机制判据（task-28 · 2026-09-30 · 427 并集 D 族余项）。

描述逐字：「减伤100%，**应对攻击：减免的伤害变为回复自己生命**，且本技能**能耗永久+2**。」

**两条机制、两个能力位**（各自独立 ✓）：
  ① 「减免的伤害变为回复自己生命」⇒ `damage.respond_reduction_to_heal`（task-28 新叶子）
     数值口径 = `DamageOutcome.raw − DamageOutcome.damage`（两个量在 `effects.py` 现成 ✓，不新增管线 ✓）
  ② 「且本技能能耗永久+2」⇒ **复用** `damage.triggered_ramp` ✓（task-26 批一那套，**没另造一套** ✗）

**判据要钉的三件事**（每条都有"该触发/不该触发"两侧 ✓）：
  · 应对**成立** ⇒ hp 真的涨（**且必须先把血打掉** ⇒ 否则满血时回复被上限吃掉、Δ=0 看不出机制 ✗）
  · 应对**不成立**（对手出状态技）⇒ **Δhp = 0** ✓
  · **没有那条子句的**减伤技能（`286 防御`）⇒ **不许有回复** ✓（防"所有防御技都回复"那种顺手放宽 ✗）
  · 能耗永久+2：应对成功 ⇒ `skill_ramps` 写入 + 第二手能耗 5→7 ✓
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]

#: 对手这一手：攻击（构成"应对攻击" ✓）vs 状态（不构成 ⇒ 对照 ✓）
_FOE_ATTACK = "skill_000418"
_FOE_STATUS = "skill_000286"


def _battle(rs, cfg, sid, foe_sid, hp=None):
    mine = next(p for p, l in rs.learnsets.items()
                if sid in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([sid] + [s for s in rs.candidate_moveset(mine) if s != sid][:3])
    loadouts["pet_000417"] = tuple(
        [foe_sid] + [s for s in rs.candidate_moveset("pet_000417") if s != foe_sid][:3])
    for pid, moves in loadouts.items():
        assert len(moves) == 4 and all(m in rs.learnsets[pid].all_skill_ids for m in moves), pid
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    if hp is not None:
        # ★ **先造出可观测变化**：满血时"回血"会被 hp 上限吃掉 ⇒ Δ=0，看不出机制 ✗
        state.player.field_pet.hp = hp
    return state


def _play(rs, cfg, sid, foe_sid, hp=None):
    state = _battle(rs, cfg, sid, foe_sid, hp)
    before = state.player.field_pet.hp
    mine = Action(ACTION_SKILL, skill_id=sid)
    foe = Action(ACTION_SKILL, skill_id=foe_sid)
    assert mine in E.legal_actions(state, rs, "player"), f"{sid} 不合法"
    assert foe in E.legal_actions(state, rs, "enemy"), f"{foe_sid} 不合法"
    after = E.step_joint(state, rs, mine, foe)
    return after, before


class ReductionToHealTest(unittest.TestCase):
    """① 「应对攻击：减免的伤害变为回复自己生命」。"""

    def test_respond_success_converts_the_mitigated_part_into_healing(self):
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, before = _play(rs, cfg, "skill_000289", _FOE_ATTACK, hp=300)
        me = after.player.field_pet
        heals = [e for e in after.events if e.kind == "heal"]
        self.assertTrue(heals, "应对成立时应发 `heal`（减免转回复）✗")
        dmg = next(e for e in after.events if e.kind == "damage")
        mitigated = heals[0].detail.get("mitigated")
        # 语义钉子：**回复的是"被减伤挡掉的那部分"**（= raw − 实际伤害），不是"整下伤害都不吃" ✗
        # ⚠ `raw` 不在事件里（事件只给最终 `damage`）⇒ 这里按**可判定的关系**钉：
        #   ① 减免量 > 0 ✓ ② 回复量 ≤ 减免量 ✓ ③ 净变化 = 回复 − 残余伤害 ✓
        self.assertGreater(mitigated, 0, "减免量必须 > 0（这一手被减伤挡掉了东西）✗")
        self.assertGreater(heals[0].detail["healed"], 0, "回复量必须 > 0 ✗")
        self.assertLessEqual(heals[0].detail["healed"], mitigated, "回复不得超过减免量 ✗")
        # 净变化 = 回复 − 穿过去的残余伤害（289 减伤 100% 仍有 1 的下限 ✓）
        self.assertEqual(me.hp - before,
                         heals[0].detail["healed"] - dmg.detail["damage"],
                         "hp 净变化应 = 回复 − 残余伤害 ✗")
        self.assertGreater(me.hp, before, "先掉血到 300 后应对成功 ⇒ 净变化必须是**涨**的 ✗")

    def test_counter_proof_no_respond_no_healing(self):
        """**对照**：对手出**状态技**（不构成"应对攻击"）⇒ 无减免 ⇒ **Δhp = 0** ✓。"""
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, before = _play(rs, cfg, "skill_000289", _FOE_STATUS, hp=300)
        self.assertEqual([e for e in after.events if e.kind == "heal"], [],
                         "没构成应对 ⇒ 不许有回复 ✗")
        self.assertEqual(after.player.field_pet.hp, before, "没构成应对 ⇒ Δhp 必须是 0 ✗")

    def test_counter_proof_plain_defense_skill_gets_no_healing(self):
        """**对照**：`286 防御`「减伤70%，应对攻击。」**没有**那条子句 ⇒ 不许有回复 ✓。"""
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, before = _play(rs, cfg, "skill_000286", _FOE_ATTACK, hp=300)
        self.assertEqual([e for e in after.events if e.kind == "heal"], [],
                         "286 没有那条「减免转回复」子句 ⇒ 不许有回复 ✗")
        self.assertLess(after.player.field_pet.hp, before, "286 挨打应该掉血 ✗")


class CostRampTest(unittest.TestCase):
    """② 「且本技能能耗永久+2」—— **复用** `damage.triggered_ramp` ✓。"""

    def test_permanent_cost_ramp_on_respond_success(self):
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, _ = _play(rs, cfg, "skill_000289", _FOE_ATTACK, hp=300)
        ramps = dict(after.player.field_pet.skill_ramps or {})
        self.assertEqual(ramps.get("skill_000289", {}).get("cost"), 2,
                         f"应对成功应把本技能能耗永久 +2，实际 ramps={ramps} ✗")

    def test_counter_proof_no_respond_no_ramp(self):
        """**对照**：没构成应对 ⇒ `skill_ramps` **不许**写入 ✓。"""
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, _ = _play(rs, cfg, "skill_000289", _FOE_STATUS, hp=300)
        ramps = dict(after.player.field_pet.skill_ramps or {})
        self.assertNotIn("skill_000289", ramps, f"没应对成功 ⇒ 不许累加，实际={ramps} ✗")


class CompoundClauseNeedsBothClaimsTest(unittest.TestCase):
    """**一个子句里塞了两条机制 ⇒ 两条都得被认领**（task-28 · `coverage.compound_clause_gaps`）。

    为什么要单独钉：`_EXTRA_MECHANIC` 词表里**没有「能耗」** ⇒ 「且本技能能耗永久+2」那段
    **不产生 span** ⇒ 光靠 `unclaimed_mechanic_spans` 点不出来 ✗；而同句里另一条机制的
    `evidence` 又**会把整句覆盖掉** ⇒ **关掉 `triggered_ramp` 也判可模拟** ✗（实测过的假绿 ✗）。
    本判据就是那次假绿的**回归钉** ✓。
    """

    def test_both_claims_on_no_gap(self):
        from roco_env import coverage as C
        rs = D.load_ruleset()
        sk = rs.skills["skill_000289"]
        parsed = C.settlement_verdict(
            sk, declared=C.declared_capabilities_of("mobile_s4_candidate_v3"))["parsed"]
        self.assertEqual(C.compound_clause_gaps(sk, parsed), [],
                         "两条能力位都声明时不该报缺口 ✗")

    def test_missing_claims_are_named(self):
        """**反证**：裸解析（= 两条都没被认领）⇒ **两条机制都要点名** ✓。"""
        from roco_env import coverage as C, parse as P
        rs = D.load_ruleset()
        sk = rs.skills["skill_000289"]
        gaps = C.compound_clause_gaps(sk, P.parse_skill(sk))
        self.assertEqual(len(gaps), 2, f"两条机制都该点名，实际={gaps}")
        self.assertTrue(any("永久修正" in g for g in gaps), f"ramp 那条必须点名：{gaps}")
        self.assertTrue(any("减免转回复" in g for g in gaps), f"回复那条必须点名：{gaps}")

    def test_tier_flips_to_partial_when_ramp_is_undeclared(self):
        """**验收条件**：关 `triggered_ramp`（新叶子仍开）⇒ 289 必须翻 **PARTIAL** ✓。"""
        from roco_env import coverage as C
        rs = D.load_ruleset()
        sk = rs.skills["skill_000289"]
        off = dict(C.declared_capabilities_of("mobile_s4_candidate_v3"))
        off["triggered_ramp"] = False
        flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
        self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                         "关掉 ramp 能力位后，289 的档位必须说 PARTIAL ✗（那条假绿的回归钉）")
        self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"],
                         "产品口径判据也必须说未结算 ✗")

    def test_plain_respond_ramp_skills_are_untouched(self):
        """**别修一个坏一个** ✗：`422`/`423`（整句就是 ramp、**没有「，且」**）⇒ 不受影响 ✓。"""
        from roco_env import coverage as C
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for sid in ("skill_000422", "skill_000423"):
            sk = rs.skills[sid]
            v = C.settlement_verdict(sk, declared=caps)
            self.assertTrue(v["resolved"], f"{sid} 应仍可结算 ✗")
            self.assertEqual(C.compound_clause_gaps(sk, v["parsed"]), [],
                             f"{sid} 不该被新形状判据碰到 ✗")


if __name__ == "__main__":
    unittest.main()
