"""`720 示弱` 的判据（task-28 · 2026-09-30 · H 族冒号句构第一条）。

描述逐字：「**自己获得萌化：速度永久+130。**」

**口径**（Lead 裁决 ✓ 文档 §2 已登记 ✓）：**冒号 = 顺带（并列）** ✓ ⇒ 两件都做 ✓
  `<效果>` **无条件执行** ✓（不依赖萌化是否生效 ✓）；⚠ 改点注释在 `parse.resolve_moe_colon` 末尾 ✓

**两条效果各有各的门** ✓（Lead 2026-09-30 ④「按效果判」✓ **不把两个键合掉** ✗）：
  · **萌化授予** ⇒ `damage.moe_mark` ✓ ⇒ 写 `PetState.marks` ✓（走 `env` **现成**的 `self_mark` 支 ✓）
  · **平值速度** ⇒ `damage.stat_gain_flat` ✓ ⇒ 写 `PetState.buffs_flat` ✓（走 `env:1884` **现成**写点 ✓）
  ⇒ ⇒ **关一个 ⇒ 另一个照常** ✓（反证两条 ✓ —— 这正是"没合键"的证据 ✓）

⚠ 本件最容易犯的错 = **"只做一半"** ✗（`723` 就是"已产出 `heal` 却缺萌化那截"的例子 ✓）
  ⇒ 所以判据第一条就钉 **`marks` 有 Δ 且 `buffs_flat` 有 Δ** ✓✓
⚠ **只摘这一族**再收一层 ✓：`717`/`721`/`728` 的 `<效果>` **机制不存在** ✗ ⇒ resolver **一个字都不产出** ✓
  ⇒ 它们**仍如实未结算** ✓（收了三条假绿的教训：授予的 evidence 含「获得」⇒ 会把**同句另一半**也覆盖 ✗）
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

SID = "skill_000720"
_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play():
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
    foe = next(x for x in E.legal_actions(state, rs, "enemy")
               if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe)


class MoeColonGrantTest(unittest.TestCase):
    def test_both_effects_land(self):
        """⚠ **两条效果都要见** ✓（**"只做一半"是本族最容易犯的错** ✗ —— `723` 就是例子 ✓）。"""
        after = _play()
        me = after.player.field_pet
        self.assertEqual(int((me.marks or {}).get("萌化", 0) or 0), 1,
                         "① 萌化授予必须真落地（`marks` 有 Δ）✗")
        self.assertEqual(int((me.buffs_flat or {}).get("spe", 0) or 0), 130,
                         "② 平值速度必须真落地（`buffs_flat` 有 Δ）✗")
        kinds = [e.kind for e in after.events]
        self.assertIn("mark_added", kinds, "应发 `mark_added` ✗")
        self.assertIn("buff_self_flat", kinds, "应发 `buff_self_flat` ✗")

    def test_two_gates_each_required_and_independent(self):
        """**两件事各有门** ✓：关任一个 ⇒ 未结算 ✓（**不是恒真** ✓）· **聚合键则做不到这点** ✓。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for key in ("moe_mark", "stat_gain_flat"):
            off = dict(caps)
            off[key] = False
            flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
            self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"],
                             f"关掉 `{key}` 后判据必须说未结算 ✗")
            self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                             f"关掉 `{key}` 后档位必须说 PARTIAL ✗")

    def test_acceptance_three_conditions_hold_together(self):
        """**验收三条同时** ✓（只看 `verdict` 会被词表过滤骗过 ✗）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        v = C.settlement_verdict(sk, declared=C.declared_capabilities_of("mobile_s4_candidate_v3"))
        self.assertTrue(v["resolved"], "① 产品口径必须说已结算 ✗")
        self.assertTrue(v["settled"], "⚠ **`settled` 必须有东西** —— 否则 `unsettled` 空 + `settled` 空 ⇒ 打架 ✗")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空**（这条才是「真的认领了」）✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族**（再收一层 ✓）：`717`/`721`/`728`（`<效果>` 机制不存在 ✗）+ `723` 仍如实未结算 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        # ⚠ 2026-09-30（第 2 批 `717`）**改钉**：`717` **已实现**（本手威力 ✓）⇒ 从本清单移出 ✓
        #   （正向钉子见 `test_self_power_flat.py` ✓ —— **只移不删** ✓）
        # ⚠ 2026-09-30（`723`）**改钉**：`723` **已实现**（双向授予 + heal ✓）⇒ 移出本清单 ✓
        #   （正向钉子见 `test_moe_bidirectional.py` ✓ —— **只移不删** ✓）
        for sid in ("skill_000533",):
            v = C.settlement_verdict(rs.skills[sid], declared=caps)
            self.assertFalse(v["resolved"],
                             f"{sid} 的 <效果> 那半还没做 ⇒ 不许被「授予萌化」那半带成已结算 ✗")
            self.assertTrue(v["unsettled"], f"{sid} 必须如实点名 ✗")

    def test_evidence_does_not_swallow_the_sibling_mechanism(self):
        """⚠ **授予的 evidence 不许覆盖同句里另一条机制** ✗（实测撞到过三条假绿 ✓ 与 `289` 同一个坑 ✓）。"""
        rs = D.load_ruleset()
        effs = [e for e in P.resolve_moe_colon(rs.skills[SID], declared=True,
                                               flat_declared=True).effects]
        grants = [e for e in effs if e.kind == "self_mark"]
        self.assertTrue(grants, "应产出授予效果 ✗")
        self.assertEqual(grants[0].evidence, "自己获得萌化",
                         f"授予的 evidence 只许是「自己获得萌化」，实际={grants[0].evidence!r} ✗"
                         "（取整句会把同句另一半也覆盖成已认领 ✗）")


if __name__ == "__main__":
    unittest.main()
