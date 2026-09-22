"""RC-401/403 效果覆盖台账的守卫：**覆盖率是「数据 × 已声明能力」的属性**，不是一句口号。

四条判据，每条都有必红方向：
  ① 总量守恒：分档之和 == 实体总数（技能 579 + 特性 245），覆盖率由分档**重算**得到；
  ② 分类**由数据驱动**：改一条 desc（内存副本）必须改变它的档位；
  ③ **能力声明会影响覆盖率**：同一条「3连击」技能，声明了连击能力才算可模拟；
  ④ 台账不吹牛：可模拟档只要求「描述被完整读出且引擎会结算」，**不等于**实机核验。
"""

from __future__ import annotations

import os
import sys
import dataclasses
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as cov     # noqa: E402
from roco_env import data as rdata       # noqa: E402
from roco_env import parse as parse_mod  # noqa: E402

RS = rdata.load_ruleset()


class CoverageLedgerTest(unittest.TestCase):
    def setUp(self):
        self.report = cov.build_coverage(RS)

    def test_totals_add_up(self):
        totals = self.report["totals"]
        levels = self.report["support_levels"]
        for key in ("battle_skills", "traits"):
            self.assertEqual(sum(levels[key].values()), totals[key],
                             f"{key} 的分档之和不等于总数（账目对不上）")
        self.assertEqual(totals["battle_skills"], 579)
        self.assertEqual(totals["traits"], 245)
        self.assertEqual(totals["entities"], 824)

    def test_ratio_is_recomputed_from_the_buckets(self):
        levels = self.report["support_levels"]
        tally = levels["battle_skills"][cov.SUPPORT_SIMULATABLE_UNVERIFIED] \
            + levels["battle_skills"][cov.SUPPORT_FULL_VERIFIED] \
            + levels["traits"][cov.SUPPORT_SIMULATABLE_UNVERIFIED] \
            + levels["traits"][cov.SUPPORT_FULL_VERIFIED]
        self.assertEqual(tally, self.report["totals"]["simulatable_entities"])
        self.assertAlmostEqual(tally / 824, self.report["totals"]["simulatable_ratio"], places=4)

    def test_declared_capability_changes_the_verdict(self):
        """同一条静态 3 连击技能：声明了能力才算可模拟 —— 否则这条判据是空的。"""
        skill = RS.skills["skill_000258"]
        without = cov.classify_skill(skill, multi_hit_declared=False)
        with_it = cov.classify_skill(skill, multi_hit_declared=True)
        self.assertEqual(without["support"], cov.SUPPORT_KNOWLEDGE_ONLY,
                         f"没声明能力时应当是只有资料，实际 {without}")
        self.assertEqual(with_it["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         f"声明之后应当可模拟，实际 {with_it}")
        self.assertIn("连击×3", with_it["claimed_by_capability"])
        # 整份报告的覆盖率也必须跟着变（否则分类只是装饰）
        narrow = cov.build_coverage(RS, declared_capabilities={"multi_hit": False})
        self.assertLess(narrow["totals"]["simulatable_entities"],
                        self.report["totals"]["simulatable_entities"],
                        "关掉连击能力之后可模拟实体数必须**下降**")

    def test_classification_follows_the_text_not_a_name_list(self):
        """反证：把 desc 改成一句未实现机制，档位必须变 —— 分类不是按技能名硬编码的。"""
        class _Skill:
            skill_id = "skill_test"
            name = "测试技能"
            is_trait = False
            # 真实字段：`plain_attack`（纯伤害判定）要求是攻击且带威力 —— 少了它们，
            # 「造成物伤。」会被 fail-closed 判成 PARTIAL，那是 fixture 不真实而不是判据错。
            is_attack = True
            power = 40
            desc = "造成物伤，2连击。"

        without = cov.classify_skill(_Skill(), multi_hit_declared=False)
        self.assertEqual(without["support"], cov.SUPPORT_KNOWLEDGE_ONLY)
        _Skill.desc = "造成物伤，2连击，敌方获得2层星陨印记，本次技能连击数+1。"
        still_dynamic = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertNotEqual(still_dynamic["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "动态连击不能被算成完全可模拟")
        _Skill.desc = "造成物伤。"
        plain = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertEqual(plain["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         "纯伤害技能走伤害路径，属于可模拟")

    def test_ranking_is_the_next_step_evidence(self):
        """排序必须把「未被登记的特性」与「连击」放在最前 —— 它就是下一步该做什么的依据。"""
        ranking = {row["primitive"]: row for row in self.report["coverage_ranking"]}
        self.assertIn("连击", ranking)
        self.assertGreater(ranking["连击"]["skills"], 0, "统计口径里的连击应当还有剩余（动态那批）")
        # 这条**从登记表长度推导**，不写死数字：每入库一批特性，未登记数就应当自动跟着降。
        from roco_env import traits as traits_mod
        self.assertEqual(ranking["未被登记"]["traits"], 245 - len(traits_mod.TRAITS),
                         "「未被登记」的条数必须等于 245 减去已登记条数")


class SupportTierMatchesEngineTest(unittest.TestCase):
    """C3（2026-09-22）：**档位必须与引擎真的会不会结算一致**。

    人类那条红线：「未知即 unknown / fail closed；**未支持的效果不得暗中按普通伤害结算**」。
    在数据上它有一个可执行的等价形式：

        「标为 SIMULATABLE（引擎会按描述结算）」 ⟺ 「描述里**没有**任何没被读出的片段」

    只要存在「标为可结算、但描述里有未认领片段」的技能，那条片段就会被引擎**默默跳过**
    （比如「造成高额物理伤害，自己下回合获得眩晕」只结算伤害、眩晕消失）—— 这正是要禁止的事。
    """

    def test_fully_simulatable_means_nothing_unparsed(self):
        rs = rdata.load_ruleset()
        offenders = []
        counts = {}
        for sid, skill in rs.skills.items():
            if getattr(skill, "is_trait", False):
                continue
            tier = cov.classify_skill(skill, multi_hit_declared=True)
            counts[tier["support"]] = counts.get(tier["support"], 0) + 1
            # 用**分类器自己**输出的 `unparsed`（它按声明的能力摘掉静态连击那一条），
            # 而不是裸解析器 —— 第一版拿 `parse_skill` 直接比，把「声明了连击」算成不一致（判据自己错）。
            unparsed = list(tier.get("unparsed") or [])
            plain = bool(getattr(parse_mod.parse_skill(skill), "plain_attack", False))
            has_effects = bool(tier.get("effects"))
            if tier["support"] == cov.SUPPORT_SIMULATABLE_UNVERIFIED:
                # 可结算 ⟹ 没有未认领片段，且「纯伤害」这个结论必须由解析器的 plain_attack 背书
                if unparsed:
                    offenders.append((skill.name, unparsed[:1]))
                claimed = list(tier.get("claimed_by_capability") or [])
                if not has_effects and not plain and not claimed:
                    offenders.append((skill.name,
                        "判了可结算，但既没有解析出的效果、也不是纯伤害、也没有能力声明认领"))
            elif tier["support"] == cov.SUPPORT_PARTIAL:
                # PARTIAL 有两种来源：有未认领片段，**或**「有机制但读不出、也没登记片段」（fail closed）
                if not unparsed and (has_effects or plain):
                    offenders.append((skill.name, "判了读不全，但既没有未认领片段、也不是纯伤害"))
            elif tier["support"] == cov.SUPPORT_KNOWLEDGE_ONLY:
                if not unparsed:
                    offenders.append((skill.name, "只有资料的档位却没给出未认领片段"))
        self.assertEqual(
            offenders, [],
            f"档位与解析结果不一致（前 5 条）：{offenders[:5]}")
        # 敏感性：语料不能是空的，否则这条判据是空转
        self.assertGreaterEqual(counts.get(cov.SUPPORT_SIMULATABLE_UNVERIFIED, 0), 50,
                                f"可结算技能太少，判据可能空转：{counts}")
        self.assertGreaterEqual(
            counts.get(cov.SUPPORT_PARTIAL, 0) + counts.get(cov.SUPPORT_KNOWLEDGE_ONLY, 0), 10,
            f"读不全的技能太少，判据可能空转：{counts}")

    def test_classifier_reads_unparsed_segments_from_the_description(self):
        """C3-c 转正：绊线响过之后（unexpected success）正式成为判据。"""
        """**绊线（2026-09-22 实测缺口）**：不认识的机制句子没有被记成 unparsed。

        把一条技能的描述换成「造成伤害，应对防御时额外施加一个本仓库尚未实现的效果。」，
        分类器**仍然**判 `SIMULATABLE_UNVERIFIED` —— 因为解析器在这句里没读出效果、
        也没把「尚未实现的效果」记成未认领片段，于是落到「没有附带效果（纯伤害/纯状态）」
        那一档。后果正是人类那条红线要防的：**未支持的效果被默默跳过，只按普通伤害结算**。

        语义：这里用 `expectedFailure` 把它做成**会响的绊线** ——
        · 现在：按预期失败，门禁不红，但缺口在测试名单里可见、可复算；
        · 一旦解析器补上「不认识的尾巴必须记成 unparsed」，这条会变成
          `unexpected success`（unittest 会报失败），逼着下一轮把它改成正式判据。

        修法方向（下一轮 C1）：让解析器对**没被任何已实现模式吃掉的残句**记 unparsed，
        而不是「没读出效果就算纯伤害」。这是「unknown 即 fail closed」在解析层的落点。
        """
        rs = rdata.load_ruleset()
        target = None
        for sid, skill in rs.skills.items():
            if getattr(skill, "is_trait", False):
                continue
            tier = cov.classify_skill(skill, multi_hit_declared=True)
            if tier["support"] in (cov.SUPPORT_PARTIAL, cov.SUPPORT_KNOWLEDGE_ONLY):
                target = skill
                break
        self.assertIsNotNone(target, "至少要有一条读不全的技能")
        rewritten = dataclasses.replace(
            target, desc="造成物伤，附带一个本仓库尚未实现的效果。")
        parsed = parse_mod.parse_skill(rewritten)
        tier = cov.classify_skill(rewritten, multi_hit_declared=True)
        self.assertFalse(parsed.plain_attack,
                         "探针句必须让解析器**否认**它是纯伤害，否则这条判据没测到新分支")
        self.assertNotEqual(tier["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "描述里带未实现机制却被判成可结算 —— 分类器没在读描述")

    def test_a_simulatable_skill_actually_settles_in_a_real_battle(self):
        """可结算不能只是纸面结论：真的拿它打一回合，引擎必须推进（而不是抛异常）。"""
        from roco_env import env as env_mod, opponents as opp
        rs = rdata.load_ruleset()
        pick = None
        for pid in rs.pets:
            for sid in (rs.candidate_moveset(pid) or ()):
                skill = rs.skills.get(sid)
                if skill is None or getattr(skill, "is_trait", False):
                    continue
                tier = cov.classify_skill(skill, multi_hit_declared=True)
                if tier["support"] == cov.SUPPORT_SIMULATABLE_UNVERIFIED and skill.power:
                    pick = (pid, sid, skill)
                    break
            if pick:
                break
        self.assertIsNotNone(pick, "至少要找到一只配招里有「可结算且有威力」技能的精灵")
        pid, sid, skill = pick
        team_a = [pid] + [p for p in list(rs.pets)[:6] if p != pid][:5]
        team_b = [p for p in list(rs.pets) if p not in team_a][:6]
        state = env_mod.reset(team_a, team_b, seed=7, rs=rs, config="mobile_s4_candidate_v3",
                              unverified_overrides=[
                                  # `energy.initial` 已登记为 10（用户实机核对）→ 不许用覆盖改它。
                                  {"path": "turn_order.speed_tie", "value": "random_seeded",
                                   "confidence": "ENGINE_HYPOTHESIS", "reason": "test",
                                   "microcase_id": "MC-E05"}])
        opp.bind_ruleset(rs)
        action = None
        for row in env_mod.legal_actions(state, rs, "player"):
            if row.kind == "skill" and getattr(row, "skill_id", None) == sid:
                action = row
                break
        if action is None:
            self.skipTest(f"这一手引擎没给「{skill.name}」（可能能耗不足）—— 不算失败，换一手")
        enemy = opp.get_strategy("greedy_damage").act(
            env_mod.observe(state, rs, "enemy"), env_mod.legal_actions(state, rs, "enemy"), 7, state.turn)
        before = (state.turn, state.player.field_pet.hp, state.enemy.field_pet.hp)
        after_state = env_mod.step_joint(state, rs, action, enemy)
        after = (after_state.turn, after_state.player.field_pet.hp, after_state.enemy.field_pet.hp)
        self.assertNotEqual(before, after,
                            f"用「{skill.name}」打了一手，局面却没有任何变化（引擎没结算）")
