"""`285 退化` 的判据（task-28 · 2026-09-30 · H 族萌化第一条）。

描述逐字：「**敌方获得1层萌化。**」

**口径**（照 `H萌化原语设计-2026-09-30.md` ✓ Lead 已批 ✓）：
  · **「萌化」是带层数的标记** ⇒ 写 `PetState.marks`（**复用现成字段** ✓ 不新造 ✗）
    语料依据逐字：`285`/`732` 都写「**1层**萌化」✓；10 条里**没有一条**让萌化自己造成效果 ✓
  · ⚠ **不进** `END_OF_TURN_STATUS` ✗ —— 进了就是"凭空 tick" ⇒ 静默假绿 ✗（与 `冻结` 同型的坑 ✓）
  · **刻意不做衰减/上限** ✓（术语里没有萌化的独立条目 ⇒ 做了就是编 ✗）
  · 能力位 `damage.moe_mark`（**一个叶子** ✓ —— 实测**没有**第二道"分派门" ✓）

**验收三条同时成立**（Lead 明令 ✓ —— 只看 `verdict` 会被"词表过滤"骗过 ✗ 我今天栽过一次 ✓）：
  ① `settlement_verdict(...)['resolved'] is True`
  ② `parse.unclaimed_mechanic_spans(skill, parsed=parsed) == []`  ← **这条才是"真的认领了"**
  ③ 真打一手 ⇒ `marks` 真有 Δ
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import coverage as C  # noqa: E402
from roco_env import effects as FX  # noqa: E402
from roco_env import parse as P  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(sid):
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if sid in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([sid] + [s for s in rs.candidate_moveset(mine) if s != sid][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    a = Action(ACTION_SKILL, skill_id=sid)
    assert a in E.legal_actions(state, rs, "player"), f"{sid} 不合法"
    foe = next(x for x in E.legal_actions(state, rs, "enemy")
               if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe)


class MoeMarkTest(unittest.TestCase):
    def test_acceptance_three_conditions_hold_together(self):
        """**验收三条同时成立** ✓（只看 `verdict` 会被词表过滤骗过 ✗）。"""
        rs = D.load_ruleset()
        sk = rs.skills["skill_000285"]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        v = C.settlement_verdict(sk, declared=caps)
        self.assertTrue(v["resolved"], "① 产品口径必须说已结算 ✗")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **`spans` 必须为空** —— 这条才是「真的认领了」✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 档位必须一致（别两处打架）✗")

    def test_runtime_really_writes_the_mark(self):
        """**真打一手**（纪律③：`ast.parse` 照样过，唯一抓得到的是这个 ✓）⇒ `marks` 真有 Δ ✓。"""
        after = _play("skill_000285")
        marks = dict(after.enemy.field_pet.marks or {})
        self.assertEqual(marks.get("萌化"), 1, f"敌方应获得 1 层萌化，实际={marks} ✗")
        added = [e for e in after.events if e.kind == "mark_added"]
        self.assertTrue(added, "应发 `mark_added` 事件 ✗")
        self.assertEqual(added[0].detail.get("mark"), "萌化", f"事件字段不对：{added[0].detail}")

    def test_frozen_is_still_not_a_tick_status(self):
        """⚠ 反向守卫：**萌化不许进 `END_OF_TURN_STATUS`** ✗（进了就是凭空 tick ⇒ 假绿 ✗）。"""
        self.assertNotIn("萌化", FX.END_OF_TURN_STATUS,
                         "「萌化」是**标记**不是回合末状态 ⇒ 加进去就是「凭空 tick」✗")
        self.assertIn("萌化", E.STATUS_AS_MARK, "「萌化」应在 `STATUS_AS_MARK`（标记化名单）里 ✓")

    def test_counter_proof_capability_off_means_unsettled(self):
        """**反证**：关能力位 ⇒ 两把尺子都说未结算 ✓（不是恒真 ✓）+ 运行时一个字都不写 ✓。"""
        rs = D.load_ruleset()
        sk = rs.skills["skill_000285"]
        caps = dict(C.declared_capabilities_of("mobile_s4_candidate_v3"))
        caps["moe_mark"] = False
        flags = {f: bool(caps.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
        self.assertFalse(C.settlement_verdict(sk, declared=caps)["resolved"], "判据必须说未结算 ✗")
        self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                         "档位必须说 PARTIAL ✗")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗：`722 转移` / `731 读层数` **不许**被顺手放行 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        # ⚠ 2026-09-30（task-28 · `722 反弹`）**改钉**：`722` **已实现**（转移 ✓ 真搬家 ✓）
        #   ⇒ 从本清单移出 ✓（正向钉子见 `test_mark_transfer.py` ✓ **只移不删** ✓）；
        #   `731 月光合奏`（**读层数 · 全队范围** = 设计 §7 "还没做"那块 ✓）**仍必须如实未结算** ✓
        for sid in ("skill_000731",):
            v = C.settlement_verdict(rs.skills[sid], declared=caps)
            self.assertFalse(v["resolved"],
                             f"{sid} 还没做（读层数是另一块）⇒ 不许说已结算 ✗")


if __name__ == "__main__":
    unittest.main()
