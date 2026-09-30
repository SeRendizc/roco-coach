"""task-28（2026-09-30）：`skill_000689 疾风刺`「造成物伤，1连击，**若先于敌方攻击，改为3连击**」
—— 先手条件的 **`hits` 形状**（与「威力+N%」那条同族、**共用同一个 `initiative_power` effect** ✓）。

⚠ 这一条**两个方向都要钉**（只钉"能加成"会把"恒 3"放过去 ✗）：
  · **先手成立** ⇒ `initiative_condition_applied{hits: 3}` ✓
  · **不先手**   ⇒ `initiative_condition_skipped` ✓（**基础 1 连击** ✓）

⚠ 构造这一对局面踩过的坑（都写在这里，省下一次重踩）：
  ① `RS.species` **不存在** ✗ —— 速度在 **`RS.pets[pid].stats["spe"]`**（`Pet` 记录里；另有 `speed_tier`）✓
     ⇒ **先 dump 再写扫描** ✓（我第一版猜 `RS.species[...]` ⇒ 全是 -1 ⇒ 构造不出局面 ✗）
  ② **敌方那一手不能是 `聚能`** ✗ —— 聚能有**固定先手度**（`env.py:110` 一带的既有口径）⇒ 我方再快也后动 ✗
     ⇒ **让敌方出一手普通攻击**，速度差才说话 ✓（这一条与 `462`/`483` 那几次"刺激给错"是同一族 ✓）
"""
import unittest

from roco_env import data as rdata, env, rule_config as RC
from roco_env.schema import Action, ACTION_SKILL

SID = "skill_000689"
OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "单测（速度平手与本批无关）",
        "microcase_id": "MC-E05"}]


class InitiativeHitsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()
        cls.v3 = RC.get_rule_config("mobile_s4_candidate_v3")
        cls.pid = next(p for p in sorted(cls.rs.pets)
                       if cls.rs.learnsets.get(p) and SID in cls.rs.learnsets[p].all_skill_ids)

    def _spe(self, pid):
        # ⚠ 速度就在 `Pet.stats` 里（`RS.species` 这个容器不存在 ✓ 别猜 ✗）
        return int(self.rs.pets[pid].stats.get("spe") or 0)

    def _run(self, foe_pid):
        pid = self.pid
        ids = sorted(self.rs.learnsets[pid].all_skill_ids)
        pool = sorted([p for p in sorted(self.rs.pets) if p != pid], key=self._spe)
        team = [pid] + [x for x in pool if x != foe_pid][:5]
        st = env.reset(team, [foe_pid] + [x for x in team if x != foe_pid][:5], seed=7, rs=self.rs,
                       config=self.v3, loadouts={pid: (SID,) + tuple(s for s in ids if s != SID)[:3]},
                       unverified_overrides=OVR)
        st.player.field_pet.energy = 99
        st.enemy.field_pet.energy = 99
        # ⚠ 敌方必须出**攻击**（聚能有固定先手度 ⇒ 我方永远后动 ⇒ 条件永不成立 ✗）
        foe = [a for a in env.legal_actions(st, self.rs, "enemy")
               if a.kind == "skill" and self.rs.skills[a.skill_id].is_attack]
        self.assertTrue(foe, "敌方这一手应当是攻击（否则测不到先手条件）")
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=SID), foe[0])
        return [(v.kind, v.detail.get("hits")) for v in after.events
                if v.kind.startswith("initiative_condition")]

    def test_applied_when_acting_first(self):
        pool = sorted([p for p in sorted(self.rs.pets) if p != self.pid], key=self._spe)
        slow = pool[0]
        self.assertLess(self._spe(slow), self._spe(self.pid), "要挑一只**更慢**的对手")
        ev = self._run(slow)
        self.assertEqual(ev, [("initiative_condition_applied", 3)],
                         f"先手成立 ⇒ 改为3连击（我{self._spe(self.pid)} vs 敌{self._spe(slow)}）")

    def test_not_applied_when_acting_second(self):
        pool = sorted([p for p in sorted(self.rs.pets) if p != self.pid], key=self._spe)
        fast = pool[-1]
        self.assertGreater(self._spe(fast), self._spe(self.pid), "要挑一只**更快**的对手")
        ev = self._run(fast)
        self.assertEqual(ev, [("initiative_condition_skipped", None)],
                         f"不先手 ⇒ 基础 1 连击（我{self._spe(self.pid)} vs 敌{self._spe(fast)}）")

    def test_parse_shape_and_claim(self):
        """判据侧：`hits` 形状进 `initiative_power`；`evidence` 盖住「若先于敌方攻击」那条 span ✓。"""
        from roco_env import parse as P, coverage as cov
        sk = self.rs.skills[SID]
        caps = cov.declared_capabilities_of("mobile_s4_candidate_v3")
        q = P.resolve_initiative_condition(sk, declared=True, parsed=P.parse_skill(sk))
        eff = [e for e in q.effects if e.kind == "initiative_power"]
        self.assertEqual(len(eff), 1, "恰好一条 effect ✓（**不新造 kind** ✓）")
        self.assertEqual(int(eff[0].value.get("hits") or 0), 3)
        self.assertIn("若先于敌方攻击", str(eff[0].evidence))
        v = cov.settlement_verdict(sk, declared=caps)
        self.assertTrue(v["resolved"], "判据：这一段真的被认领了")


if __name__ == "__main__":
    unittest.main()
