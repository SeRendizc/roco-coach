"""`723 甜心续航` 的判据（task-28 · 2026-09-30 · H 族冒号句构 · **双向**）。

描述逐字：「**自己和敌方**获得萌化：**回复40%生命**。」

**三份效果 · 两个方向** ✓：
  · 我方 `self_mark{萌化,1}` ✓ · 敌方 `foe_mark{萌化,1}` ✓（**双向授予** ✓ 两个写点都现成 ✓）
  · 我方 `heal{40%}` ✓ —— ⚠ **"回复给谁"是拍的口径** ✓：**给我方自己** ✓
    理由：技能名叫「甜心**续航**」✓（"续航"就是"给自己续" ✓）+ **"回复"默认主语 = 技能使用者** ✓
    ⇒ 登记 `ENGINE_HYPOTHESIS` ✓ + **"若人类改判为'双方各 40%' ⇒ 只改这一处"的改点注释** ✓

⚠ **本件只动了 `parse` 的守卫** ✓ —— 第三半「回复N%生命」**本来就由既有 heal 路径结算** ✓（裸解析就有 `heal` ✓）
  ⇒ 放行它**不产生假绿** ✓（与 `717`/`721` 那种"机制不存在"的情况**不同** ✗：
    那两种若放行 ⇒ 同句另一半没实现 ⇒ 假绿 ✗）
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

SID = "skill_000723"
_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(hp: int = 200):
    """真打一手；**先把血打掉** ⇒ `heal` 才可观测 ✓（满血时回复会被上限吃掉 ✗）。"""
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if SID in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([SID] + [s for s in rs.candidate_moveset(mine) if s != SID][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    state.player.field_pet.hp = hp
    a = Action(ACTION_SKILL, skill_id=SID)
    assert a in E.legal_actions(state, rs, "player"), f"{SID} 不合法"
    foe = next(x for x in E.legal_actions(state, rs, "enemy")
               if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe)


class MoeBidirectionalTest(unittest.TestCase):
    def test_three_effects_both_directions(self):
        """⚠ **三份效果 · 两个方向** ✓（**双向**是本条与 `720` 最大的不同 ✗）。"""
        after = _play()
        me, foe = after.player.field_pet, after.enemy.field_pet
        self.assertEqual(int((me.marks or {}).get("萌化", 0) or 0), 1, "我方应得 1 层萌化 ✗")
        self.assertEqual(int((foe.marks or {}).get("萌化", 0) or 0), 1, "**敌方也应得 1 层** ✗（双向 ✓）")
        self.assertEqual(len([e for e in after.events if e.kind == "mark_added"]), 2,
                         "应恰有**两条** `mark_added`（我方 + 敌方）✗")

    def test_heal_goes_to_self(self):
        """⚠ **"回复给谁"是拍的口径** ✓：**给我方自己** ✓（改点见 `parse.resolve_moe_colon` 末尾 ✓）。"""
        after = _play(hp=200)
        heals = [e.detail for e in after.events if e.kind == "heal"]
        self.assertTrue(heals, "应发 `heal` ✗")
        self.assertGreater(after.player.field_pet.hp, 200, "**我方自己**必须回血（口径 ✓）✗")
        self.assertEqual(int((after.enemy.field_pet.marks or {}).get("萌化", 0) or 0), 1,
                         "敌方只拿萌化、**不回血**（口径 ✓）✗")

    def test_counter_proof_capability_off_means_unsettled(self):
        """**反证**：关 `moe_mark` ⇒ 两把尺子都说未结算 ✓（不是恒真 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        off = dict(C.declared_capabilities_of("mobile_s4_candidate_v3"))
        off["moe_mark"] = False
        flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
        self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"], "判据必须说未结算 ✗")
        self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                         "档位必须说 PARTIAL ✗")

    def test_acceptance_three_conditions_hold_together(self):
        """**验收三条同时** ✓。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        v = C.settlement_verdict(sk, declared=C.declared_capabilities_of("mobile_s4_candidate_v3"))
        self.assertTrue(v["resolved"], "① 产品口径必须说已结算 ✗")
        self.assertTrue(v["settled"], "⚠ `settled` 必须有东西（否则两边空 ⇒ 打架 ✗）")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空** ✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")

    def test_evidence_covers_only_the_grant_part(self):
        """⚠ **授予的 evidence 只许覆盖"自己和敌方获得萌化"那一小段** ✗（取整句会吞掉 heal 那半 ✓）。"""
        rs = D.load_ruleset()
        effs = P.resolve_moe_colon(rs.skills[SID], declared=True).effects
        grants = [e for e in effs if e.kind in ("self_mark", "foe_mark")]
        self.assertEqual(len(grants), 2, f"应产出两条授予 ✗ 实际={[e.kind for e in effs]}")
        for g in grants:
            self.assertEqual(g.evidence, "自己和敌方获得萌化",
                             f"授予的 evidence 不对：{g.evidence!r} ✗（整句会吞掉 heal 那半 ✗）")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗（⚠ 2026-09-30 `721`/`728` 已实现 ⇒ 从本清单移出 ✓ **只移不删** ✓）：`721`/`728`（"全技能"作用域 ✗）+ `533`（冻结没做 ⇒ 连带做不了 ✗）仍如实未结算 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for sid in ("skill_000533",):
            v = C.settlement_verdict(rs.skills[sid], declared=caps)
            self.assertFalse(v["resolved"], f"{sid} 还没做 ⇒ 不许被顺手放行 ✗")
            self.assertTrue(v["unsettled"], f"{sid} 必须如实点名 ✗")


if __name__ == "__main__":
    unittest.main()
