"""`717 超级糖果` 的判据（task-28 · 2026-09-30 · 第 2 批第一条）。

描述逐字：「造成物伤，**自己获得萌化：本次技能威力+60**。」

**语义**：**本手无条件平值威力** ⇒ `skill.power += 60`
  ⚠ 手法**照既有先例** ✓ —— `env` 里 `foe_switch_power_flat` 就是 `dataclasses.replace(skill, power=…+N)` ✓
  ⇒ ⇒ **不动伤害公式、不加旋钮** ✗（`power` 本来就是公式读的入参 ✓）

**两条效果两条门** ✓（与 `720` 同一口径「按效果判」✓ **不把键合掉** ✗）：
  · 「自己获得萌化」⇒ `damage.moe_mark` ✓（写 `marks` ✓）
  · 「本次技能威力+60」⇒ `damage.self_power_flat` ✓（改本手 `power` ✓）

⚠ **本件我自己撞到的坑（已修 ✓ 写进判据当守卫）**：**第一版只接了状态支** ✗
  ⇒ `717` 是**攻击技** ⇒ **一个字都没生效** ✗（无事件 · `power_used=100` 没加 · `marks={}` ✓）
  ⇒ ⇒ **`ast.parse` 过、`grep` 也看不出来** —— **唯一抓得到的是"真打一手"** ✓
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

SID = "skill_000717"
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
    return E.step_joint(state, rs, a, foe), rs


class SelfPowerFlatTest(unittest.TestCase):
    def test_runtime_really_adds_the_power(self):
        """⚠ **真打一手**（唯一抓得到"漏接攻击支"的方法 ✓）：本手威力必须 **+60** ✓。

        ⚠ **读对字段**：`power_used` = 本手实际用的威力 ✓（这里它就等于"基础+60" ✓）；
          别把它和 `power_multiplier`（倍率）搞混 ✗ —— 本条走的是**平值**不是倍率 ✓。
        """
        after, rs = _play()
        base = int(rs.skills[SID].power or 0)
        applied = [e.detail for e in after.events if e.kind == "self_power_flat_applied"]
        self.assertEqual(len(applied), 1, f"应恰有一条 `self_power_flat_applied` ✗ 实际={applied}")
        self.assertEqual(applied[0].get("amount"), 60, f"加的量应为 60 ✗ 实际={applied[0]}")
        self.assertEqual(applied[0].get("power_after"), base + 60,
                         f"加完后本手威力应为 {base + 60} ✗")
        dmg = [e.detail for e in after.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertTrue(dmg, "攻击技应有伤害事件 ✗")
        self.assertEqual(dmg[0].get("power_used"), float(base + 60),
                         f"`power_used` 应为 {base + 60}（= 基础 + 60）✗ —— 别只读基础威力 ✗")

    def test_both_effects_land(self):
        """⚠ **两条效果都要见** ✓（`720` 那件的教训 ✓ —— "只做一半"是本族最容易犯的 ✗）。"""
        after, _ = _play()
        self.assertEqual(int((after.player.field_pet.marks or {}).get("萌化", 0) or 0), 1,
                         "① 萌化授予那半也要真落地 ✗")
        self.assertTrue([e for e in after.events if e.kind == "self_power_flat_applied"],
                        "② 本手威力那半也要真落地 ✗")

    def test_two_gates_each_required(self):
        """**两件事各有门** ✓：关任一个 ⇒ 未结算 ✓（不是恒真 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for key in ("moe_mark", "self_power_flat"):
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
        self.assertIn("本手威力加成", v["settled"], "`settled` 必须有这一条（否则两边空 ⇒ 打架 ✗）")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空**（这条才是「真的认领了」）✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")

    def test_evidence_does_not_swallow_the_sibling_mechanism(self):
        """⚠ **两半的 evidence 各只许覆盖自己那半** ✗（取整句会吞掉同句兄弟机制 ✓ 撞过两次 ✓）。"""
        rs = D.load_ruleset()
        effs = P.resolve_moe_colon(rs.skills[SID], declared=True, flat_declared=True,
                                   power_declared=True).effects
        grant = [e for e in effs if e.kind == "self_mark"]
        power = [e for e in effs if e.kind == "self_power_flat"]
        self.assertTrue(grant and power, f"两半都该产出 ✗ 实际={[e.kind for e in effs]}")
        self.assertEqual(grant[0].evidence, "自己获得萌化", f"授予那半的 evidence 不对：{grant[0].evidence!r} ✗")
        self.assertEqual(power[0].evidence, "本次技能威力+60", f"威力那半的 evidence 不对：{power[0].evidence!r} ✗")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗（⚠ 2026-09-30：`721`/`728` 已实现 ⇒ 从本清单移出 ✓ 换 `533` 顶上 ✓ **只移不删** ✓）：`724`/`721`/`728`/`533` **仍如实未结算** ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        # ⚠ 2026-09-30（第 2 批 `724`）**改钉**：`724` **已实现**（条件门 ✓）⇒ 移出本清单 ✓
        #   （正向钉子见 `test_cond_self_debuff_power.py` ✓ —— **只移不删** ✓）
        for sid in ("skill_000533",):
            v = C.settlement_verdict(rs.skills[sid], declared=caps)
            self.assertFalse(v["resolved"], f"{sid} 还没做 ⇒ 不许被顺手放行 ✗")
            self.assertTrue(v["unsettled"], f"{sid} 必须如实点名 ✗")


if __name__ == "__main__":
    unittest.main()
