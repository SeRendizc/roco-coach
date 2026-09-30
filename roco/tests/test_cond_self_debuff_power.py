"""`724 破罐破摔` 的判据（task-28 · 2026-09-30 · 第 2 批第二条）。

描述逐字：「造成魔伤，**自己有减益时**，本次技能威力+60。」

**与 `717` 的关系**（设计 §3 ✓）：**加成那半完全一样** ✓（同一个 kind `self_power_flat` ✓ 同一个写点 ✓）；
  **只有"条件"是新的** ✗ ⇒ 效果带 `requires:"self_has_debuff"` ✓（由 `env._gate_self_debuff_effects` 筛 ✓）。

⚠ **"减益"的口径**（Lead 2026-09-30 裁决 ✓）：**只算 `buffs` / `buffs_flat` 的负值** ✓ ·
  **中毒/灼烧那些"状态层数"不算** ✓（术语里没有依据 ⇒ 算进来 = **发明语义** ✗）
  ⇒ 改点写在 `env._gate_self_debuff_effects` 的 docstring 里 ✓（"只改这一处" ✓）+ 生成器 `reason` ✓。

⚠ **语料里同形状的不止一条** ✓ —— 本件实测**连带翻正 `skill_000334 急中生智`**
  「自己有减益时，本次技能威力**+40**」（**同句构、同条件、只有数值不同** ✓）
  ⇒ ⇒ 这正是"一份设计覆盖两条"的兑现 ✓（也提醒：**别假设一条形状只对应一条技能** ✓）
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

SID = "skill_000724"
_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(debuff: bool, sid: str = SID):
    """真打一手；`debuff=True` ⇒ **先挂一个负值 buff**（造出可观测前提 ✓）。"""
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if sid in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([sid] + [s for s in rs.candidate_moveset(mine) if s != sid][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    if debuff:
        state.player.field_pet.buffs["atk"] = -30      # 负值 = 减益 ✓（口径 ✓）
    a = Action(ACTION_SKILL, skill_id=sid)
    assert a in E.legal_actions(state, rs, "player"), f"{sid} 不合法"
    foe = next(x for x in E.legal_actions(state, rs, "enemy")
               if x.kind == ACTION_SKILL and x.skill_id)
    return E.step_joint(state, rs, a, foe), rs


class CondSelfDebuffPowerTest(unittest.TestCase):
    def test_counter_proof_with_debuff_adds_power(self):
        """**反证①**：自己有减益 ⇒ `power_used` = 基础 **+60** ✓。"""
        after, rs = _play(debuff=True)
        base = int(rs.skills[SID].power or 0)
        applied = [e.detail for e in after.events if e.kind == "self_power_flat_applied"]
        self.assertEqual(len(applied), 1, f"应恰有一条 `self_power_flat_applied` ✗ 实际={applied}")
        self.assertEqual(applied[0].get("amount"), 60, f"应 +60 ✗ 实际={applied[0]}")
        dmg = [e.detail for e in after.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertEqual(dmg[0].get("power_used"), float(base + 60),
                         f"`power_used` 应为 {base + 60}（基础 {base} + 60）✗")

    def test_counter_proof_without_debuff_adds_nothing(self):
        """**反证②**：自己没有减益 ⇒ **不许 +60** ✓ + 条件被如实记 skipped ✓。"""
        after, rs = _play(debuff=False)
        base = int(rs.skills[SID].power or 0)
        self.assertEqual([e for e in after.events if e.kind == "self_power_flat_applied"], [],
                         "没有减益 ⇒ 不许加威力 ✗")
        skipped = [e for e in after.events if e.kind == "self_debuff_condition_skipped"]
        self.assertTrue(skipped, "没有减益应如实发 `self_debuff_condition_skipped` ✗")
        dmg = [e.detail for e in after.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertEqual(dmg[0].get("power_used"), float(base),
                         f"`power_used` 应保持基础 {base} ✗")

    def test_status_layers_do_not_count_as_debuff(self):
        """⚠ **口径钉子**：**中毒/灼烧那些状态层数不算"减益"** ✓（算进来 = 发明语义 ✗）。"""
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        mine = next(p for p, l in rs.learnsets.items()
                    if SID in l.all_skill_ids and p != "pet_000417")
        pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
        team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
        loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
        loadouts[mine] = tuple([SID] + [s for s in rs.candidate_moveset(mine) if s != SID][:3])
        state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                        config=cfg, unverified_overrides=_OVERRIDES)
        state.player.field_pet.statuses["中毒"] = {"layers": 3}   # 只有状态层数 ✓ 没有负值 buff ✓
        a = Action(ACTION_SKILL, skill_id=SID)
        assert a in E.legal_actions(state, rs, "player")
        foe = next(x for x in E.legal_actions(state, rs, "enemy")
                   if x.kind == ACTION_SKILL and x.skill_id)
        after = E.step_joint(state, rs, a, foe)
        self.assertEqual([e for e in after.events if e.kind == "self_power_flat_applied"], [],
                         "**状态层数不算减益** ⇒ 不许加威力 ✗（这是本地规则 ✓ 改点写在 env 的 docstring 里 ✓）")

    def test_two_gates_each_required(self):
        """**两条门**：条件门 + 加成那半的门 ✓ · 关任一个 ⇒ 未结算 ✓（不是恒真 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for key in ("cond_self_debuff_power", "self_power_flat"):
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
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         "② **spans 必须为空** ✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, "③ 两把尺子必须一致 ✗")
        # ⚠ `724` 的缺口**不是 span 给的**，是 `diagnostic_shape_gaps` 的「条件：自身增益/减益」✓
        #   ⇒ 它靠**效果的 evidence 覆盖**消失 ✓（所以上面 ② 通过 ⇒ 那条缺口也确实没了 ✓）
        self.assertEqual([g for g in v["unsettled"] if "条件：自身增益/减益" in g], [],
                         "「条件：自身增益/减益」那条缺口必须已被 evidence 覆盖 ✓")

    def test_same_shape_sibling_also_settles(self):
        """⚠ **同形状的兄弟**：`334 急中生智`（+40）**也应变已结算** ✓（别假设一条形状只对应一条技能 ✓）。"""
        rs = D.load_ruleset()
        sk = rs.skills["skill_000334"]
        self.assertIn("有减益时", sk.desc or "", "334 应仍是同形状（语料变了吗？）")
        self.assertTrue(C.settlement_verdict(
            sk, declared=C.declared_capabilities_of("mobile_s4_candidate_v3"))["resolved"],
            "334 与 724 同形状 ⇒ 必须一起翻正 ✓（若它没翻 ⇒ 说明 resolver 漏了 ✓）")

    def test_only_this_family_is_claimed(self):
        """**只摘这一族** ✗（⚠ 2026-09-30 `721`/`728` 已实现 ⇒ 从本清单移出 ✓ **只移不删** ✓）：`721`/`728`（"全技能"作用域 ✗）与 `533`（冻结没做 ⇒ 连带做不了 ✗）仍如实未结算 ✓。"""
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for sid in ("skill_000533",):
            v = C.settlement_verdict(rs.skills[sid], declared=caps)
            self.assertFalse(v["resolved"], f"{sid} 还没做 ⇒ 不许被顺手放行 ✗")
            self.assertTrue(v["unsettled"], f"{sid} 必须如实点名 ✗")


if __name__ == "__main__":
    unittest.main()
