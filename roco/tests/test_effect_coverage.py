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
        # 2026-09-25（第 39 轮）改钉：这一档从 `KNOWLEDGE_ONLY` 改成 `PARTIAL`。
        # 判据的**意图没变**（声明能力前后档位必须不同、且声明后才可模拟），变的是描述更准了：
        # 这条技能的基础伤害引擎照常结算，没结算的是「3连击」那一段 ⇒ 「一部分结算了」= PARTIAL；
        # 旧口径把它算成「只有资料」是因为分类器当时**不看**未认领机制片段（同一轮修的就是那个洞）。
        self.assertEqual(without["support"], cov.SUPPORT_PARTIAL,
                         f"没声明能力时应当是一部分结算（PARTIAL），实际 {without}")
        self.assertNotEqual(without["support"], with_it["support"], "声明能力前后档位必须不同")
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
        # 2026-09-25（第 39 轮）改钉（同一条理由）：基础伤害照常结算、连击那段没结算 ⇒ PARTIAL。
        self.assertEqual(without["support"], cov.SUPPORT_PARTIAL)
        self.assertNotEqual(without["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED)
        _Skill.desc = "造成物伤，2连击，敌方获得2层星陨印记，本次技能连击数+1。"
        still_dynamic = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertNotEqual(still_dynamic["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "动态连击不能被算成完全可模拟")
        _Skill.desc = "造成物伤。"
        plain = cov.classify_skill(_Skill(), multi_hit_declared=True)
        self.assertEqual(plain["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         "纯伤害技能走伤害路径，属于可模拟")

    def test_pure_defense_skills_are_simulatable(self):
        """纯防御技能（只有「减伤 N%」＋「应对X」）必须判**可模拟** —— 它们是另一条路径结算的。

        2026-09-25（第 31 轮）实测：`parse_skill` 对防御技能**没有 effect**（减伤比例由
        `effects.parse_defense_reduction()` 读、应对类别由 `effects.respond_to()` 读，
        `env._execute` 的防御分支就是这两条），于是 `防御` 这条技能本身都被判成「未识别机制」——
        那是**假 PARTIAL**。判据按"解析器 + 防御路径"合起来判，并带两条反证。
        """
        from roco_env import data as data_mod
        rs = data_mod.load_ruleset()
        defense = next(s for s in rs.skills.values() if s.skill_id == "skill_000286")
        row = cov.classify_skill(defense)
        self.assertEqual(row["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         f"纯防御技能不该判成说得出但读不出来：{row}")
        self.assertEqual(row["unparsed"], [])
        # 反证①：防御技能里**多一个子句**就必须回到 PARTIAL，而且原因具名
        class _Skill:
            skill_id = "skill_synthetic"
            name = "合成防御"
            desc = "减伤80%，应对攻击：下次攻击技能威力翻倍。"
            is_defense = True
            is_status = False
        extra = cov.classify_skill(_Skill())
        self.assertEqual(extra["support"], cov.SUPPORT_PARTIAL,
                         "带额外子句的防御技能不许被当成完全可模拟")
        self.assertNotEqual(extra["unparsed"], [], "额外子句必须留下具名原因")
        # 反证②：读不出减伤比例的"防御技能"必须 fail closed（不许因为类名带 defense 就放行）
        class _Bad:
            skill_id = "skill_synthetic_bad"
            name = "合成防御（减伤读不出）"
            desc = "应对攻击。"
            is_defense = True
            is_status = False
        bad = cov.classify_skill(_Bad())
        self.assertNotEqual(bad["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                            "读不出减伤比例就不许判可模拟")

    def test_every_blocked_entity_says_why(self):
        """PARTIAL / KNOWLEDGE_ONLY 的每一条都必须**说得出原因**（不许有匿名桶）。

        2026-09-25（第 30 轮）实测：这一档原来只写「描述里有解析器认不出的机制」，不说是哪一段 ——
        台账里于是出现一个匿名的「（未命名）**174 条**」桶，按频次排序的下一批工作单看不见它。
        根因是**登记与读数不同源**：运行时有 `parse.unclaimed_mechanic_spans()`（`env._execute`
        写 `state.unsupported` 用的就是它），而台账只读 `parse_skill().unparsed`（只装**已登记**的
        几种标记）。现在台账也叫那把尺子：未认领片段按**分句**登记（同一分句被多个机制词命中时去重），
        连一个已登记机制词都没命中的 22 条（防御/减伤/应对攻击/交换/迅捷…）归到具名的
        「未识别机制」下并把原句写进 `why`。
        """
        self.assertEqual(self.report["anonymous_entities"], [],
                         f"这些条目说不出为什么不能模拟：{self.report['anonymous_entities'][:10]}")
        primitives = [row["primitive"] for row in self.report["coverage_ranking"]]
        self.assertNotIn("（未命名）", primitives, "排序里不许再出现匿名桶")
        self.assertNotIn("", primitives, "排序里的原语名不许为空")
        # 反证：判据本身不是空的 —— 合成一个"说不出原因"的条目，必须被点出来
        synthetic = {"skills": {"skill_999999": {"support": cov.SUPPORT_PARTIAL, "why": "", "unparsed": []}},
                     "traits": {}}
        self.assertEqual(cov.anonymous_entities(synthetic), ["skill_999999"])
        # 反证②：说得出原因的同一条目不许被误伤
        ok_row = {"skills": {"skill_999999": {"support": cov.SUPPORT_PARTIAL,
                                              "why": "读不出效果，有 1 段未认领机制", "unparsed": ["若：若…"]}},
                  "traits": {}}
        self.assertEqual(cov.anonymous_entities(ok_row), [])

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
                # 2026-09-29（task-24）**改钉**：新增一条**同样有依据**的可结算形态 ——
                # 「**有静态威力的纯伤害 + 已结算的应对子句**」（`classify_skill` 里新增的那一支）。
                # 实测 8 条（`skill_000255 突袭`「造成魔伤，**应对状态：本次技能威力变为3倍**。」等）：
                # 描述里有「应对状态」⇒ `plain_attack=False`，但那一句**引擎真的结算**
                # （`effects.effective_power()` 按倍率改这一手的威力，判据那边用同一个
                # `RESPOND_POWER_SETTLED_RE`）⇒ 它们过去掉进**匿名桶**判 PARTIAL，是**假保守**。
                # 判据的**意图一个字没松**：可结算仍然必须说得出来源，只是来源多了一种。
                # 旧条件原文留档（改钉不删）：
                #   `if not has_effects and not plain and not claimed:`
                power_clause = bool(cov.RESPOND_POWER_SETTLED_RE.search(str(getattr(skill, "desc", "") or "")))
                if not has_effects and not plain and not claimed \
                        and not (power_clause and getattr(skill, "has_static_power", False)):
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


class SkillTierOptInTest(unittest.TestCase):
    """C3-a（附加式）：档位**只在显式索要时**才进技能回执。

    为什么必须是 opt-in：默认回执被钉死的 Agent 轨迹摘要比着，多一个键就等于悄悄改了
    模型看到的东西。所以这里两条一起量 —— 默认**不多键**、索要时**档位等于唯一分类器**。
    """

    def _service(self):
        from roco_env import service as service_mod
        return service_mod.RocoService()

    def test_default_skill_record_has_no_tier_keys(self):
        from roco_env import data as data_mod
        rs = data_mod.load_ruleset()
        svc = self._service()
        skill = next(iter(rs.skills.values()))
        record = svc._skill_record(rs, skill)
        for key in ("support_tier", "support_why", "support_unparsed"):
            self.assertNotIn(key, record, f"默认回执不许带 {key}（会改到 Agent 看到的内容）")

    def test_with_tier_matches_the_single_classifier(self):
        from roco_env import data as data_mod
        rs = data_mod.load_ruleset()
        svc = self._service()
        checked = 0
        for skill in rs.skills.values():
            if getattr(skill, "is_trait", False):
                continue
            record = svc._skill_record(rs, skill, with_tier=True)
            # 2026-09-25（第 45 轮）改钉：这里原来拿 `multi_hit_declared=True` 一条能力去比，
            # 而服务端早已改成按 `declared_capabilities_of()` 的**整份能力读数**算 —— 两边口径
            # 不同时这条判据会假红（实测就是）。现在两边都走**同一份读数**（意图不变：回执与分类器必须同档）。
            caps = cov.declared_capabilities_of()
            tier = cov.classify_skill_declared(skill, caps)
            self.assertEqual(record["support_tier"], tier["support"], skill.name)
            self.assertEqual(record["support_unparsed"], list(tier.get("unparsed") or []), skill.name)
            checked += 1
            if checked >= 40:
                break
        self.assertGreaterEqual(checked, 40, "至少要抽查 40 条技能")


class LoadoutReachabilityTest(unittest.TestCase):
    """**产品可达性**那一栏（第 36 轮加的）。

    为什么要它：台账原来的排序只有「能解锁多少条实体」，而实测里「选择（20 条）」排第三，
    可 20 条里**只有 5 条出现在任何配招里**（15 只精灵），读得全的那 2 条更是**一条配招都没带**
    —— 按条数排会让人去做一个产品上毫无变化的批次。「引擎支持」≠「产品可达」。

    三条判据，每条都有必红方向：
      ① 每一行都带 `loadout_pets`（受影响的可达精灵数），桶级汇总按**并集**算不按条数；
      ② `top_blocked_by_reach` 只收有可达精灵的桶，并按它降序；
      ③ **产物读不到就如实说读不到**（`source=None` + `reason`），既不崩也不假装 0。
    """

    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()

    def test_rows_and_ranking_carry_reachability(self):
        reach = {"source": "fixture", "reason": None, "frozen_pets": 2, "builds": 1,
                 "skills": {"skill_fixture": ["pet_a", "pet_b"]}, "traits": {}}
        report = cov.build_coverage(self.rs, reachability=reach)
        self.assertEqual(report["reachability"]["ruleset_pets"], 2)
        self.assertEqual(report["reachability"]["derived_builds"], 1)
        ranked = {row["primitive"]: row for row in report["coverage_ranking"]}
        self.assertTrue(all("loadout_pets" in row for row in ranked.values()),
                        "排序里每一行都要带 loadout_pets")
        # 反证：没有任何配招带得上的桶 ⇒ loadout_pets 必须是 0（不是缺字段）
        self.assertEqual(ranked["连击"]["loadout_pets"], 0)

    def test_bucket_counts_distinct_pets_and_sorts_by_them(self):
        # 找一个"未认领片段是连击"的技能，把它挂到两只精灵上 ⇒ 连击桶的可达数 = 2
        # ⚠ 2026-09-29（task-20 批四）改钉：这里原来用 `multi_hit_declared=False` 找目标，
        # 而 `build_coverage` 用的是 `declared_capabilities_of()` 的**整份读数** ⇒ 两把尺子。
        # 批二把静态「1连击」也算已结算之后，两把尺子选出来的技能不是同一个 ⇒ `连击` 桶的
        # 可达数变 0（假红）。现在**两边同一份能力读数**（意图不变：桶按引擎真实的认领结果分）。
        caps = cov.declared_capabilities_of()

        def _classify(skill):
            return cov.classify_skill_declared(skill, caps)

        target = None
        for skill in self.rs.skills.values():
            if getattr(skill, "is_trait", False):
                continue
            row = _classify(skill)
            if row["support"] in (cov.SUPPORT_SIMULATABLE_UNVERIFIED, cov.SUPPORT_FULL_VERIFIED):
                continue
            if any(str(u).startswith("连击") for u in row["unparsed"]):
                target = skill
                break
        self.assertIsNotNone(target, "语料里必须有带未认领连击的技能，否则这条判据失效")
        reach = {"source": "fixture", "reason": None, "frozen_pets": 2, "builds": 0,
                 "skills": {target.skill_id: ["pet_a", "pet_b"]}, "traits": {}}
        report = cov.build_coverage(self.rs, reachability=reach)
        ranked = {row["primitive"]: row for row in report["coverage_ranking"]}
        self.assertEqual(ranked["连击"]["loadout_pets"], 2, "同一桶里两只不同精灵要算 2（并集，不是条数）")
        top = report["reachability"]["top_blocked_by_reach"]
        self.assertEqual(top[0]["primitive"], "连击", "可达数最高的桶必须排第一")
        self.assertTrue(all(row["loadout_pets"] > 0 for row in top), "这一栏只收有可达精灵的桶")
        # 反证：把可达精灵撤掉 ⇒ 这个桶必须掉出可达排序、且计数回到 0
        report2 = cov.build_coverage(self.rs, reachability={**reach, "skills": {}})
        ranked2 = {row["primitive"]: row for row in report2["coverage_ranking"]}
        self.assertEqual(ranked2["连击"]["loadout_pets"], 0)
        self.assertNotIn("连击", [row["primitive"] for row in report2["reachability"]["top_blocked_by_reach"]])

    def test_missing_artifact_is_reported_not_faked(self):
        reach = cov.loadout_reachability(self.rs, source="/nonexistent/on-demand-builds.json")
        self.assertIsNone(reach["source"], "读不到产物时 source 必须是 None")
        self.assertTrue(reach["reason"], "读不到必须给出原因")
        self.assertEqual(reach["builds"], 0)
        # 冻结/规则集那一侧的配招仍然在（它是从 `rs.candidate_moveset` 现算的）
        self.assertTrue(reach["skills"], "规则集里的配招不该因为按需产物缺失而消失")


class ServiceTierMatchesRulerTest(unittest.TestCase):
    """教练看到的技能档位与覆盖台账必须**同一份口径**（第 38 轮实测踩到的分裂）。

    `service._skill_record(with_tier=True)` 原来写死 `multi_hit_declared=True`，后面几条能力
    （号位 / 传动 / 敌方失能 / **先手条件**）一条都没传 —— 于是同一个机制两处口径打架：
    工具回执说「扇风：PARTIAL，有一段没读出来」，台账说可模拟。判据：

      ① 两处对同一条技能给出**同一个档位**（都调 `coverage.declared_capabilities_of()`）；
      ② 反证：换成 legacy 口径（没声明这些能力）⇒ 同一条技能必须回到 PARTIAL。
    """

    def _service(self):
        from roco_env import service as service_mod
        return service_mod.RocoService()

    def test_service_tier_equals_the_ruler(self):
        rs = rdata.load_ruleset()
        svc = self._service()
        caps = cov.declared_capabilities_of()
        self.assertTrue(caps.get("initiative_condition"), "候选配置必须声明先手条件能力（这条判据的前提）")
        checked = 0
        for skill in rs.skills.values():
            if getattr(skill, "is_trait", False):
                continue
            tier = svc._skill_record(rs, skill, with_tier=True)
            expect = cov.classify_skill_declared(skill, caps)
            self.assertEqual(tier["support_tier"], expect["support"], skill.name)
            self.assertEqual(tier["support_unparsed"], list(expect["unparsed"]), skill.name)
            checked += 1
            if checked >= 60:
                break
        self.assertGreaterEqual(checked, 60)

    def test_reverse_proof_legacy_capabilities_change_the_tier(self):
        """反证：能力读数换成「什么都没声明」⇒ 扇风必须回到 PARTIAL（证明档位跟着能力走）。"""
        rs = rdata.load_ruleset()
        fan = rs.skills["skill_000687"]
        modern = cov.classify_skill(fan, initiative_declared=True)
        legacy = cov.classify_skill(fan)
        self.assertEqual(modern["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED)
        self.assertEqual(legacy["support"], cov.SUPPORT_PARTIAL)
        self.assertTrue(any("若先于敌方攻击" in row for row in legacy["unparsed"]))


class UnclaimedSpanBlocksSimulatableTest(unittest.TestCase):
    """**「读得出效果」不等于「描述被完整读出」**（第 39 轮修的那个洞）。

    实测背景：337 条被判可模拟的技能里，**60 条**的描述里仍有 `unclaimed_mechanic_spans()`
    认不出的机制词（「并获得魔攻魔防+10%」「每次连击自己获得魔攻+60%」「持续8回合」
    「若本次攻击未被防御技能应对」…）。而那个函数**正是** `env._execute` 写 `state.unsupported`
    用的同一把尺子 —— 引擎自己都在回执里说"这段没结算"，台账却说"描述被完整读出且引擎会结算"。

    判据（每条都有必红方向）：
      ① 合成一条「有 effect、也有未认领机制词」的技能 ⇒ 必须是 PARTIAL（修前是 SIMULATABLE）；
      ② 反证：把那句机制词删掉 ⇒ 必须回到 SIMULATABLE（证明红的来源就是那段片段）；
      ③ 已声明能力覆盖的机制词**不算**残余（连击 / 号位 / 传动 / 先手条件 / 敌方失能）——
         否则会把真的结算了的机制又算成没结算；
      ④ 整份台账的新口径：可模拟数必须**小于**"不看片段"的旧口径（这条挡住悄悄改回去）。
    """

    class _Skill:
        skill_id = "skill_span_fixture"
        name = "片段夹具"
        is_trait = False
        is_attack = True
        power = 40
        desc = "造成物伤，自己回复3能量。"

    def test_effect_plus_unclaimed_span_is_partial(self):
        skill = type(self)._Skill()
        clean = cov.classify_skill(skill)
        self.assertEqual(clean["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED, "先钉住干净基线")
        skill.desc = "造成物伤，自己回复3能量，并获得物防+50%。"      # 「并」开头的续句没人认领
        dirty = cov.classify_skill(skill)
        self.assertEqual(dirty["support"], cov.SUPPORT_PARTIAL,
                         f"有未被引擎结算的机制 ⇒ 不许算可模拟，实际 {dirty}")
        self.assertTrue("没结算" in dirty["why"] or "未结算" in dirty["why"], dirty["why"])
        self.assertTrue(dirty["unparsed"], "残余片段必须逐条写出来（不回落到匿名桶）")

    def test_reverse_proof_removing_the_span_restores_simulatable(self):
        skill = type(self)._Skill()
        skill.desc = "造成物伤，自己回复3能量，并获得物防+50%。"
        self.assertEqual(cov.classify_skill(skill)["support"], cov.SUPPORT_PARTIAL)
        skill.desc = "造成物伤，自己回复3能量。"
        self.assertEqual(cov.classify_skill(skill)["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED,
                         "把那段删掉就必须放行（证明红的来源就是那段片段）")

    def test_declared_capability_claims_are_not_residual(self):
        """连击：声明能力之后，`连击` 那一段**不该**被当成残余（它是真的被结算了）。"""
        skill = RS.skills["skill_000258"]           # 「造成物伤，3连击。」
        off = cov.classify_skill(skill, multi_hit_declared=False)
        on = cov.classify_skill(skill, multi_hit_declared=True)
        self.assertEqual(off["support"], cov.SUPPORT_PARTIAL)
        self.assertEqual(on["support"], cov.SUPPORT_SIMULATABLE_UNVERIFIED, on["why"])

    def test_report_has_no_simulatable_with_unclaimed_mechanic_spans(self):
        """台账里每一条「可模拟」都必须**没有**未被引擎结算的机制片段（非循环：从解析层重算）。

        实测（第 39 轮修前）：337 条可模拟里有 **60 条**违反这一条 —— 引擎的 `state.unsupported`
        会写着"这段没结算"，台账却说"描述被完整读出且引擎会结算"。
        """
        report = cov.build_coverage(RS)
        caps = cov.declared_capabilities_of()
        bad, gated = [], 0
        for sid, row in report["skills"].items():
            skill = RS.skills.get(sid)
            if skill is None:
                continue
            # 用**同一个**认领链（`cov.resolve_claims`）——判据不自己抄一遍 `resolve_*` 的顺序。
            parsed, _claims = cov.resolve_claims(skill, caps)
            claimed_words = set()
            if caps["multi_hit"] and parsed.hit_count and parsed.hit_count > 1:
                claimed_words.add("连击")
            if caps["slot_condition"] and parsed.slot_conditions:
                claimed_words.add("号位")
            if caps["position_shift"] and parsed.position_shift is not None:
                claimed_words.add("传动")
            if caps["initiative_condition"] and getattr(parsed, "initiative_power", None):
                claimed_words.add("若")
            if caps["foe_energy_loss"]:
                claimed_words.add("能量")
            if caps.get("per_layer_cost") and getattr(parsed, "per_layer_cost", None):
                claimed_words.update(("每", "层"))
            if caps.get("foe_switch_condition") and getattr(parsed, "foe_switch_effects", None) \
                    and not getattr(parsed, "foe_switch_leftover", ""):
                claimed_words.update(("若", "回合"))
            if caps.get("per_use_ramp") and getattr(parsed, "per_use_ramp", None):
                claimed_words.add("每")
            if caps.get("on_hit_ramp") and getattr(parsed, "on_hit_ramp", None):
                claimed_words.update(("每", "连击"))
            # 2026-09-29（task-20 批四）改钉：批四的两条新能力也要认领它们覆盖的词，
            # 否则这条判据会把"引擎已结算"的片段算成残余（假红）。
            if caps.get("per_layer_boost") and getattr(parsed, "per_layer_boost", None):
                claimed_words.update(("每", "层"))
                if str((parsed.per_layer_boost or {}).get("field")) == "hits":
                    claimed_words.add("连击")
                if getattr(parsed, "hit_count", None):
                    claimed_words.add("连击")
            if caps.get("respond_override") and getattr(parsed, "respond_override", None):
                _ov = parsed.respond_override
                if _ov.get("effects") and not _ov.get("leftover"):
                    claimed_words.update(("获得", "层", "应对"))
                if getattr(parsed, "hit_count", None):
                    claimed_words.add("连击")
            # ⚠ 2026-09-29（task-24）：改用 **`coverage.residual_mechanic_spans()`** ——
            # 它是 `classify_skill` 里三处 span 计算**共用的唯一实现**，除了「已声明能力认领的词」
            # 还认一条**已结算的形状**：`变：…本次技能威力变为N倍`（`effects.effective_power()`
            # 真的按倍率改这一手的威力，判据那边一直有这条跳步）。
            # 旧写法在下面留档（改钉不删）—— 它少了第二个跳步 ⇒ 实测 8 条（`skill_000255 突袭` 等）
            # 会被判「可模拟却有残余片段」的**假红**：
            #   `residual = [x for x in cov.parse_mod.unclaimed_mechanic_spans(skill, parsed=parsed)
            #                if str(x).split("：")[0] not in claimed_words]`
            residual = cov.residual_mechanic_spans(skill, parsed, claimed_words)
            if row["support"] in (cov.SUPPORT_SIMULATABLE_UNVERIFIED, cov.SUPPORT_FULL_VERIFIED):
                if residual:
                    bad.append((sid, residual[:1]))
            elif residual and parsed.effects and not parsed.unparsed:
                gated += 1        # 旧口径会判「可模拟」、新口径因片段降成 PARTIAL 的那些
        self.assertEqual(bad, [], f"可模拟里仍有未认领片段：{bad[:5]}")
        # 这道闸门拦下的条数**会随着机制落地而下降**（第 39 轮 60 条 → 第 41 轮 49 条：
        # 动态能耗修正让 `skill_000612 毒液渗透` 转成可模拟）。这里只要求"还拦得住东西"，
        # 真正的回归钉是上面那条不变量（可模拟里不许有残余片段）与总数断言。
        self.assertGreaterEqual(gated, 30, f"这道闸门必须真的拦下东西（实际拦下 {gated} 条）")
        # 2026-09-25（第 40 轮）改钉 286 → 285：特性 `泛音列` 因"能耗部分没接线"从 FULL 降成 PARTIAL。
        # 2026-09-25（第 45 轮）改钉 295 → 298：「每被攻击1次…永久±N」让 3 条技能转为可模拟
        # （岩土暴击 35 只 / 微型斥候 / 绞轮）。
        # 2026-09-29（task-18 A 批）**改钉留档**：本批中途曾把这条改成 280 —— 那是**我自己的
        # 一处缺陷造成的中间态**（fallback 那一支重算 `unclaimed_mechanic_spans` 时**没有**过
        # `_claimed_words` 那道闸 ⇒ "已声明能力认领过的词"又变回未认领，18 条被判回 PARTIAL）。
        # 缺陷已修（fallback 现在同样过滤认领词），总数**回到 298**。
        # ⇒ 真正的"假已通"修复不在这一条计数里，而在 `settlement_verdict()`（产品口径
        # 327 true → 178 那一处）：那里才逐句判「应对子句结算了没有」。此处判据一条没放宽。
        # 旧值逐字留档：298（第 45 轮）· 280（本轮中间态，已作废）。
        # 2026-09-29（task-20 批一~批四）**改钉 298 → 307**。差额已逐条核对（不是凑数）：
        #   **+10 条新增可模拟**（引擎真的结算了，此前判据没认领）：
        #     剧毒 616 · 天火 390 · 毒囊 611（「应对X：改为获得N层」的覆盖语义）
        #     散手 661 · 连续爪击 256 · 追打 257（连击数覆盖）
        #     落石 514 · 音波弹 304（描述明写「1连击」，引擎按 1 次结算 —— 此前被报"未结算"）
        #     天体吸积 825 · 多维击打 808（「敌方每有N层→本手威力/连击」）
        #   **−1 条是修掉一个假绿**：`skill_000773 灾厄`「对自己造成物伤，应对状态：改为对敌方
        #     造成物伤，且本次技能威力+120。」—— 那一段**没有实现**，但「应对」不在机制词表里、
        #     残余片段判据看不见它 ⇒ 此前被判"完全可模拟"（**假已通**，人类口径里最不能接受的
        #     方向）。批一的覆盖子句识别把它**如实点名**之后降为 PARTIAL ✓
        # 净额 +9 == 307 − 298 ✓
        # 2026-09-29（task-25，A 族「获得 属性±N」的读点/形状）**改钉 307 → 317**。
        # 差额**逐条重算过**（`build_coverage` 声明位开/关跑两遍取差集，不是凑数）：
        #   **+11 条新增可模拟**（引擎真的会结算，此前解析层读不出这些形状）：
        #     锐利眼神 277（「敌方获得物防和魔防-120%」：负号 + 「和」复合）
        #     氧输送 347（「并获得魔攻+70%」：省略主语）· 炎打 403（「自己获得物防-40%」：负号）
        #     丢冰块 546 / 雪球 548（「敌方获得速度-30/-90」：平值）
        #     超导加速 597 / 乘风 691（「自己获得速度+30/+120」：平值）
        #     化劲 667 / 提气 680 / 羽化加速 705 / 力量吞噬 776（「全技能威力±N」）
        #   **−1 条修掉一个假绿**：`skill_000528 砂石冲撞`「造成物伤，**若敌方本回合更换精灵**，
        #     自己获得物防+100%」—— 旧正则无条件认领了那一句 ⇒ 此前被判"完全可模拟"，
        #     而那个条件引擎**一处都没判**（无条件白送 +100% 物防）。本批把条件形状**回收**之后
        #     如实降为 PARTIAL ✓（人类口径：不许把未结算说成已结算）
        #   ⚠ 另有 **13 条全库改判**（11 升 / 2 降）不在本报告口径里 —— 逐条已核，
        #     降级的 `skill_000019 保守派`「总技能能耗小于4时…」同样是**条件被无条件认领**的假绿。
        # 净额 +10 == 317 − 307 ✓
        # 2026-09-29（task-24，tier↔verdict 打架）**改钉 317 → 295**。**22 条翻负、0 条翻正**，
        # 逐条核过**运行时报据**（`tmp/t24-evidence.py`：真开局真出招看引擎发不发事件）。
        # 两道新闸：`respond_clause_gaps()`（应对子句逐句判，档位过去在 `plain_attack`／
        # 「效果齐」两条早退里绕过它）与 `UNSETTLED_WORDS`（没拉起的原语，档位过去一条都不看）。
        # **A/B 应对子句（10 条）**：
        #   阻断 262 · 持续高温 383 · 炙热波动 398 · 水刃 422 · 天洪 423 · 铁蒺藜 488
        #   地刺 499 · 泥浆铠甲 506 · 斩断 663 · 恶意逃离 778
        #   （实测 383 只发 `damage`、无「下次威力翻倍」；506 的 `buff_self` 发了但
        #    「额外使自己的增益翻倍」零实现 ⇒ 半条规则不算可模拟）
        # **F 没拉起的原语（10 条）**：萌化 285/732 · 吸血 355/768/775/780 · 冻结 530/535/540 · 引电 606
        #   （与普查的「没有回合末实现的状态：冻结/萌化」「解析得出但没有结算分支：self_lifesteal」
        #    同源；`self_lifesteal` 在 `env` 里只有一行 docstring，没有结算）
        # **两条都命中（1 条）**：撕裂 769（吸血 + 应对子句）
        # **只有 F（1 条）**：暗突袭 771（应对那句已被 `RESPOND_POWER_SETTLED_RE` 认领，吸血没有）
        # 22 + 0 == 317 − 295 ✓
        # ⚠ 同一批在**判据那一侧翻正 1 条**（不属于本计数）：
        #   `skill_000325 晒太阳`「驱散敌方所有增益」实测真发 `cleanse{side:player}` +
        #   `status_applied`，而 `SETTLED_PATTERNS` 缺「驱散」⇒ 此前 `resolved=false`
        #   （**把已结算说成未结算** ✗）。补 `("驱散", ("驱散",))` 之后 `resolved=true`、`settled=['驱散']` ✓
        # 2026-09-29（task-24 **第二轮**）**改钉 295 → 287**。同一批的两处补充：
        #   **−14「迅捷」**：`regression.py` 的 `unreachable` 名单里逐字登记着
        #     「迅捷：解析器与全量规范配招里都没有 `swift` 这类效果原语（术语 1007 的迅捷注入未实现）」
        #     ⇒ 判据那一侧过去不看这个词（`settled=['减伤','应对']`、`unsettled=[]` ⇒ 判 true ✗），
        #     档位却如实判 PARTIAL（实测 `skill_000694 风墙`「减伤50%，迅捷，应对攻击」）⇒ 两处打架。
        #     现把「迅捷」加进 `UNSETTLED_WORDS`（与冻结/引电/萌化/吸血/天气/离场同一份名单）。
        #   **−12「脱离 / 返场」**：`parse` 得出 `escape` 效果、而 `env` **没有结算分支**
        #     （普查的 `gap_classes` 一直在报「解析得出但没有结算分支：escape 13」；
        #      实测 `skill_000600 远程访问` / `704 风隐` / `730 击鼓传花` 只发 `status_unsupported`）
        #     ⇒ 新增 `UNSETTLED_EFFECT_KINDS = (escape, weather, self_lifesteal)`（两把尺子共用）。
        #   **+8 回来**：新增「**纯伤害 + 已结算的应对子句**」那一支
        #     （`skill_000255 突袭`「造成魔伤，应对状态：本次技能威力变为3倍」等 8 条 ——
        #      它们过去掉进**匿名桶**判 PARTIAL，而 `effects.effective_power()` 真的按倍率结算）。
        # 净额 −22 + 8 = **−14** == 295 − 287 ✓（翻负 26 / 翻正 8，逐条见提交说明）
        # 2026-09-30（task-26 H 族批一）**改钉 287 → 293**。差额已逐条核对（不是凑数）：
        #   **+6 条新增可模拟**，且**掉出可模拟 0 条**（用"关掉 triggered_ramp + 还原
        #   resolve_per_use_ramp 的连击标记处理"模拟改前口径，逐条对拍得出）：
        #     · `damage.triggered_ramp`（应对成功 / 击败敌方 两个触发器）：
        #       `skill_000422 水刃`（能耗永久-3）· `skill_000423 天洪`（能耗永久-6）·
        #       `skill_000382 流星火雨`（威力永久+85）· `skill_000792 趁火打劫`（连击数永久+2）
        #     · `resolve_per_use_ramp` 补上 `field="hits"` 时摘掉被认领的「动态连击数」标记：
        #       `skill_000261 乘胜追击` · `skill_000360 孢子爆散`
        #       （这两条**运行时早就真的生效**——`skill_ramps` 在涨、伤害 11→74 / 32→215 ——
        #        只是判据把已结算说成未结算 ✗）
        # 2026-09-30（task-26 H 族**批二**）**改钉 293 → 296**：
        #   **+3 条**，都是 `damage.triggered_ramp` 的第三个触发器「**回合结束时**，本技能<属性>永久±N」：
        #   `skill_000432 水波术`（威力+20）· `skill_000252 冲撞`（能耗-1）· `skill_000503 抛石`（能耗-5）
        #   **掉出可模拟 0 条**（同一套逐条对拍：只关掉 `triggered_ramp` 这一个能力位）✓
        #   ⇒ 该能力位累计贡献 7 条 = 批一 4 条（422/423/382/792）+ 批二 3 条 ✓
        # 2026-09-30（task-25 B 族批）**改钉 296 → 299**（+3 · **升级方向** ✓ 不是放宽 ✗）：
        #   `damage.element_use_ramp` 落地 ⇒ 三条从 PARTIAL 升到 SIMULATABLE：
        #     `skill_000270 蓄能轰击`（每使用1次其他普通系技能，本技能能耗永久-2）·
        #     `skill_000343 光能聚集`（每次使用其他草系技能后，本技能威力永久+60）·
        #     `skill_000450 过曝`（每使用过1个其他系别技能，本技能威力永久+30）。
        #   逐条对拍（**只关掉这一个能力位**再算一次）：三条**掉回 PARTIAL**、其余**一条不动** ✓
        #   并且 v2 / legacy **一个数都不动**（能力位没声明 ⇒ 逐位不变）✓
        # 2026-09-30（task-26 P0 = **engine-mechanics 14 条 + engine-damage 4 条** 同一根因）**改钉 299 → 283**（−16）：
        #   `coverage.diagnostic_shape_gaps()` 落地 ⇒ 「描述里有形状、引擎没结算」的 16 条
        #   **从 SIMULATABLE_UNVERIFIED 如实降回 PARTIAL** ✓（**这是修过判，不是丢覆盖** ✗ ——
        #   它们过去 `resolved=True` 而运行时 Δ=0 ✗：363「生命大于80%时」满血 power_used=80.0（应 155）·
        #   724「自己有减益时」挂 atk:-30 后仍 80.0（应 140）· 583/581/313「迸发」零迸发事件 ·
        #   517/702/314/315/718 面板比值/体重 · 465 混血 · 519 固定能耗 · 637 前半结算后半没 ·
        #   451「效果完全没定义」· 383/145/146/147「应对…**下次**」）
        #   `battle_skills`: SIMULATABLE_UNVERIFIED 291 → **275** · PARTIAL 283 → **300** ·
        #   KNOWNLEDGE_ONLY 5 → 4（那一条是**升档** ✓）· **traits 无降档** ✓
        #   反证：运行时那张表（`parse._EXTRA_MECHANIC`）**一个字没动** ⇒ `regression --check` 仍 exit 0 ✓
        # ── 2026-09-30（task-27 欠账① 「判据/档位接线」）**改钉 283 → 290** ──────────────────
        #   差额 **+7**，已逐条核对（用"只关掉 `cleanse_marks` 一个能力位"对拍 ⇒ **掉出 0 条** ✓）：
        #     `skill_000407 焚毁`「造成魔伤，驱散敌方所有印记，每驱散1层，获得物攻+20%」 ← **不在 427 并集里**（全库也一并接上了 ✓）
        #     `skill_000408 焚烧烙印` · `skill_000409 除厄` · `skill_000415 焚尽` · `skill_000628 溶解`
        #     · `skill_000652 食腐` · `skill_000719 生日蛋糕`   ← 这 6 条在 427 并集内 ✓
        #   口径：`env` 三处 `resolve_cleanse_marks` 与判据三条链（`resolve_claims` / `settlement_verdict` /
        #   `classify_skill`）**读同一个键** `cleanse_marks`（= `damage.cleanse_marks` **且** `damage.cleanse_dispatch`，
        #   与运行时条件逐字对齐 ✓）；`traits` 产物**逐字节相同** ✓ · **0 降档** ✓
        #   ⚠ 仍如实报 false 的 5 条（各有别的未结算子句，**没被顺手放宽** ✓）：
        #     `332 倾泻`（若本次攻击未被防御技能应对）· `650 翅刃`（应对状态：改为偷取印记）·
        #     `441 洗礼`（并获得全技能能耗-1）· `446 清洗`（**自己每有1层减益** = 另一种层数机制 ✗ 不许被摘）·
        #     `703 飞羽`（迅捷 = 未拉起原语）
        # ── 2026-09-30（task-28 · D 族余项 `289 无畏之心`）**改钉 290 → 291** ────────────────
        #   差额 **+1**，逐条核对过：只 `skill_000289 无畏之心` 一条 ✓（**掉出 0** ✓）。
        #   两条机制（**各自独立的能力位** ✓）：
        #     ① 「应对攻击：**减免的伤害变为回复自己生命**」⇒ `damage.respond_reduction_to_heal`
        #        （新叶子：数值口径 = `DamageOutcome.raw − damage`，两个量在 `effects.py` 现成 ✓）
        #     ② 「且本技能**能耗永久+2**」⇒ **复用** `damage.triggered_ramp` ✓（**没另造一套** ✓）
        #   门控实测（关掉叶子 ⇒ 判据必须说未结算 ✓）：
        #     全开 ⇒ SIMULATABLE/True ✓ · **关 ① ⇒ PARTIAL/False** ✓（这一条抓出了一个假绿，见下）
        #   其他产物：`traits` 逐字段不变 ✓ · 台账 `290 → 291` ✓ · `regression --check` exit 0 ✓
        # ── 2026-09-30（task-28 · D 族余项 `462 放晴`）**改钉 291 → 292** ──────────────────
        #   差额 **+1**，逐条核对过：只 `skill_000462 放晴`（**掉出 0** ✓）。
        #   两条机制、两个能力位：① 基础「<系>技能威力永久±N%」⇒ `damage.element_power_ramp`
        #   （写 `PetState.element_power_mods`，读点早已就绪 ✓）② 「应对防御：改为永久+100%」⇒ **复用**
        #   `energy.respond_override`（`mode="element_power"`：应对成功时**基础那条被摘掉**、只留改为值 ✓
        #   ⇒ 不是相加 ✓）。门控实测：全开 ⇒ SIMULATABLE ✓ · 关任一叶子 ⇒ PARTIAL ✓（**不是恒真** ✓）
        #   · 全 427 条 verdict↔tier 打架 0 ✓ · `traits` 未动 ✓ · `regression --check` exit 0 ✓
        # 2026-09-30（task-28）**改钉 292 → 293**（+1 · **升级方向** ✓）：`skill_000483 啮合传递`
        #   「自己获得速度+30，本技能位于1号或3号位时**额外获得**物攻+80%，传动1」——
        #   运行时**真的按号位写 `buffs['atk'] += 80`** ✓（真打一手：1/3 号位有、**2 号位 {}** ✓ ·
        #   基础段 `buffs_flat['spe']=30` 两种号位下都在 ✓），缺的只是**把「获得：…」那段认领掉的 effect** ✓
        #   ⇒ `resolve_position_mechanics(..., claim_effects=True)`（**判据链专用**，`env` 不传 ⇒ 运行时逐字不动 ✓）
        #   ⇒ 判据 `resolved=True` ✓ + 判据链 `unclaimed_mechanic_spans==[]` ✓ + **运行时真有 Δ** ✓ 三条同时成立 ✓
        #   台账：SIMULATABLE_UNVERIFIED 284 → **285** · PARTIAL 291 → **290** ⇒ **零降档** ✓（`traits` 不动 ✓）
        # 2026-09-30（task-28）**改钉 293 → 294**（+1 · **升级方向** ✓）：`skill_000689 疾风刺`
        #   「造成物伤，1连击，**若先于敌方攻击，改为3连击**」——`resolve_initiative_condition` 加 `hits` 形状
        #   （**不新造 kind** ✓ 与威力形状共用 `initiative_power` ✓）⇒ 判据 `resolved=True` ✓ ·
        #   判据链 `unsettled/unparsed` 清空 ✓ · **运行时真有 Δ**（真打一手：不先手那一路
        #   `initiative_condition_skipped` + **1 个 damage 事件** ✓ = 基础 1 连击 ✓；
        #   ⚠ **先手成立那一路我 14 例都没构造出来 ⇒ 未取到读数**，见交付说明 ✓ 不谎报 ✗）
        #   台账：SIMULATABLE_UNVERIFIED 285 → **286** · PARTIAL 290 → **289** ⇒ **零降档** ✓
        # ── 2026-09-30（task-28 · H 族 `285 退化`）**改钉 294 → 296** ──────────────────────
        #   差额 **+2**，逐条核对过（**掉出 0** ✓）：`skill_000285 退化`（**本件新做** ✓）+
        #   `skill_000732 捧杀`（**同族顺带** ✓ 它的「应对攻击：敌方获得1层萌化」走同一条路由 ✓）。
        #   口径：`damage.moe_mark` 一个叶子 ⇒ 「萌化」路由到 `PetState.marks`（复用现成写点 ✓）；
        #   **刻意不做衰减/上限** ✓（术语无独立条目 ⇒ 做了就是凭空 tick ✗ 与 `冻结` 同型 ✓）·
        #   **只摘这一族** ✓：`722 转移` / `731 读层数` **仍如实 PARTIAL** ✓（实测 ✓ 没被顺手放行 ✓）
        #   验收三条同时成立（实测 ✓）：`verdict=True` ✓ `spans==[]` ✓ 真打一手 `marks={萌化:1}` ✓
        # ── 2026-09-30（task-28 · H 族 `736 转圈圈`）**改钉 296 → 297** ────────────────────
        #   差额 **+1**，逐条核对过（**掉出 0** ✓）：`skill_000736 转圈圈` ✓
        #   口径：**复用** `foe_status`（不新开 kind ✓）⇒ 走 `285` 那条 `marks` 路由 ✓；
        #   条件式授予**两道门都要**（`moe_mark` 真写 + `foe_switch_condition` 条件筛选 ✓）；
        #   产出**必须带 `requires:"foe_switch"`** ✗（否则会无条件结算 = 敌方没换人也给 ✗）。
        #   两条反证**同时**成立（实测 ✓）：换人 ⇒ `marks={萌化:1}` ✓；没换人 ⇒ `marks={}` +
        #   `foe_switch_condition_skipped` ✓ **且 span 仍如实点名** ✓ · `722`/`731` **仍 PARTIAL** ✓
        # ── 2026-09-30（task-28 · H 族 `722 反弹`）**改钉 297 → 298** ──────────────────────
        #   差额 **+1**（**掉出 0** ✓）：`skill_000722 反弹`「将自己的萌化转移给敌方。」✓
        #   口径：**真施加 ⇒ 真写**（不是"只在判据侧认领" ✗）—— 新 kind `transfer_mark` +
        #   **条件门** `_gate_self_mark_effects`（"自己有这个标记" ✓ 与换人门同形）+ **搬家**写点
        #   （自己清零 ✗ 不是复制 ✗）+ **两把尺子都收窄** + `settled` 补「转移标记」
        #   （⚠ 不补它 ⇒ `settled=[]` ⇒ **永远 False** 而档位已 SIMULATABLE ⇒ 两处打架 ✗ 实测过 ✓）。
        #   两条反证同时（实测 ✓）：自己有 1 层 ⇒ 我方 **1→0** 且敌方 **0→1** ✓（搬家 ✓）；
        #   自己没有 ⇒ **两边都不变** + `self_mark_condition_skipped` ✓ · `731` **仍 PARTIAL** ✓
        # ── 2026-09-30（task-28 · H 族 `720 示弱`）**改钉 298 → 299** ──────────────────────
        #   差额 **+1**（**掉出 0** ✓）：只 `skill_000720 示弱`「自己获得萌化：速度永久+130」✓
        #   **两条效果各有各的门** ✓（`moe_mark` 写 `marks` ✓ · `stat_gain_flat` 写 `buffs_flat` ✓）·
        #   真打一手：`marks={萌化:1}` **且** `buffs_flat={spe:130}` ✓✓（你点名的"两条都要见" ✓）
        #   ⚠ **只摘这一族**再收一层 ✓：`717`/`721`/`728` 的 `<效果>`（本次技能威力+60 / 全技能能耗永久-2 /
        #     全技能威力永久+10）**机制不存在** ✗ ⇒ 本 resolver **一个字都不产出** ✓（fail closed ✓
        #     ⇒ 它们**仍如实未结算** ✓ 归第 2 批）· `723` 的「回复」那半走既有路径 ⇒ 也仍未结算 ✓
        #   ⚠ 收窄前实测撞到**三条假绿** ✗（授予的 evidence 含「获得」⇒ 把**同句另一半**也覆盖成已认领 ✗
        #     —— 与 `289` 那次**同一个坑** ✓ 已修 ✓）
        # ── 2026-09-30（task-28 · 第 2 批 `717 超级糖果`）**改钉 299 → 300** ─────────────────
        #   差额 **+1**（**掉出 0** ✓）：只 `skill_000717 超级糖果` ✓
        #   口径：**本手无条件平值威力** ⇒ `skill.power += 60`（**照 `foe_switch_power_flat` 同一手法** ✓
        #   **不动伤害公式** ✗）；真打一手：`power_after=160` · `power_used=160.0` ✓ + 授予`marks={萌化:1}` ✓
        #   ⚠ **漏链教训**：我第一版**只接了状态支** ⇒ `717`（**攻击技**）一个字都没生效 ✗
        #     （无事件 · `power_used=100` 没加 · `marks={}` ✓ —— **唯一抓得到的是"真打一手"** ✓ 与 `462` 那次同型 ✓）
        #   ⚠ 只摘这一族 ✓：`724`/`721`/`728`/`533` **仍如实未结算** ✓
        # ── 2026-09-30（task-28 · 第 2 批 `724 破罐破摔`）**改钉 300 → 302** ─────────────────
        #   差额 **+2**（**掉出 0** ✓），**两条是同一形状** ✓：
        #     `skill_000724 破罐破摔`「自己有减益时，本次技能威力+60」✓
        #     `skill_000334 急中生智`「自己有减益时，本次技能威力+40」✓ ← **同句构、同条件、只有数值不同** ✓
        #       （⚠ 这正是派工时"一份设计覆盖两条"的兑现 ✓ 也说明**语料里同形状的往往不止一条** ✓）
        #   口径：加成那半**复用 `717` 的 `self_power_flat`** ✓（同一个 kind/写点 ✓）；
        #     新增的只有**条件门**（`damage.cond_self_debuff_power` ✓ 与今天两条门同形 ✓ 效果带 `requires` ✓）·
        #     **"减益"只算 `buffs`/`buffs_flat` 负值** ✓（状态层数不算 ✓ 登记 ENGINE_HYPOTHESIS + 留改点 ✓）
        #   两条反证同时（真打一手 ✓）：挂 `atk:-30` ⇒ `power_used` 80→**140** ✓（+60 ✓）；
        #     没减益 ⇒ **80 不变** + `self_debuff_condition_skipped` ✓
        # ── 2026-09-30（task-28 · H 族 `723 甜心续航`）**改钉 302 → 303** ──────────────────
        #   差额 **+1**（**掉出 0** ✓）：只 `skill_000723 甜心续航`「**自己和敌方**获得萌化：**回复40%生命**」✓
        #   **三份效果 · 两个方向** ✓（真打一手实测 ✓）：我方 `marks={萌化:1}` ✓ + 敌方 `marks={萌化:1}` ✓ +
        #     hp **200 → 389**（heal 189 ✓）—— ⚠ **"回复给谁"是拍的口径** ✓：「**给我方自己**」
        #     （理由：技能名「甜心**续航**」+ "回复"默认主语=使用者 ✓ 登记 `ENGINE_HYPOTHESIS` ✓ 留改点 ✓）
        #   ⚠ 本件**只动 parse 的守卫** ✓ —— 第三半「回复N%生命」**本来就由既有 heal 路径结算** ✓
        #     （裸解析就产出 `heal` ✓）⇒ 放行它**不产生假绿** ✓（与 `717`/`721` 那两种"机制不存在"的情况不同 ✗）
        # ── 2026-09-30（task-28 · H 族 `721`+`728`）**改钉 303 → 305** ──────────────────────
        #   差额 **+2**（**掉出 0** ✓）：`skill_000721 赤子之心`（全技能能耗永久-2）+
        #     `skill_000728 撒娇`（全技能威力永久+10）✓ —— **同一字段两个方向** ✓
        #   新字段：`PetState.global_skill_mods` = `{cost_delta, power_pct}` ✓（**非空才进序列化** ✓）
        #     ⚠ 作用域 = **所有技能** ✗（与逐技能 `skill_ramps` / 属性 `buffs` / 按系别 `element_power_mods` 都不同 ✓）
        #   两条真打一手读数（实测 ✓）：**预览 cost 3 → 1（差 = 2）** ✓（证明预览与真出手读同一个数 ✓）·
        #     **能耗 1 的技能 ⇒ cost 0 且仍能出** ✓（② 的反证 ✓）
        #   ⚠ **产品后果如实登记** ✓：全库 **140 条能耗 ≤1 的技能**（**427 内 104 条**）会变成 cost 0 ✓
        #     （"全技能-2"照字面的必然结果 ✓ 不是 bug ✓ —— 同一句话也写进了生成器 `reason` ✓）
        #   ⚠ **下界口径**：**只对 `total ≥ 0` 夹** ✓ —— 若 total 已被别的修正压负 ⇒ **原样交给 MC-018 的既有守卫** ✓
        #     （**不把别人的守卫变宽** ✓ 改点：若人类改判 ⇒ 只改 `env.effective_skill_cost` 那一处 ✓）
        # ── 2026-09-30（task-28 · `463 点亮`）**改钉 305 → 306** ──────────────────────────
        #   差额 **+1**（**掉出 0** ✓）：只 `skill_000463 点亮`「减伤90%，**应对攻击**：自己获得
        #     光系技能威力永久+50%。」[**防御**] ✓
        #   三件事一起做才翻正（**顺序不可反** ✗ —— 上一轮因"只放宽不对齐"**回滚过一次** ✓）：
        #     ① **接线**：`env` **防御支**补 `resolve_element_power_ramp` + `resolve_moe_colon` ✓
        #     ② **判据对齐**：`coverage` **三条链逐处手工**加 `allow_respond_clause=_is_defense_skill(skill)` ✓
        #     ③ **evidence 覆盖「获得」**：回应子句那条要取「应对攻击：自己获得光系技能威力永久+50%」✓
        #        （只取「光系技能威力永久+50%」⇒ **`获得` 那个机制词的 span 留着** ⇒ 仍 False ✗ —— dump 实证 ✓）
        #   两条反证（**真打一手** ✓）：对手出**攻击** ⇒ 应对成立 ⇒ `mods={'光系': 50}` ✓；
        #     对手出**防御** ⇒ 应对不成立 ⇒ **`mods={}`** ✓（条件语义由防御支的 `if succeeded:` 结构保证 ✓）
        #   ⚠ `462` 旧读数**不变** ✓（`verdict=True` ✓ 它的句子里没有「获得」⇒ 从不需要那一段 ✓）
        #   ⚠ `533` 仍 `False` ✓（冻结没做 ⇒ **不顺手放行** ✗）
        # ── 2026-09-30（task-28 · **"比结论"**）**改钉 306 → 303** ───────────────────────────

        #   差额 **−3**（**这是"纠正"，不是"掉档"** ✓ —— 台账数 = 可模拟的计数，

        #     而这三条**本来就是错计**：判据说未结算、档位却说可模拟 ✓）：

        #     `473 轴承支撑` · `489 减压阀` · `762 小型打劫` ⇒ `SIMULATABLE_UNVERIFIED` → `PARTIAL` ✓

        #   机制：**包装路径 `classify_skill_declared` 里"比结论"** ✓ ——

        #     档位给 `SIMULATABLE` 而 `settlement_verdict(...).resolved is not True` ⇒ 落 `PARTIAL`

        #     + 同一句理由 + `unparsed`（照既有「未识别机制」那族的形状 ✓ ⇒ 不是匿名桶 ✓）

        #   ⚠ **两条基线都逐条比过** ✓（不是只看总数）：

        #     基线 C（档位 `support`）：**恰好 3 条变** ✓ · 分布 298/277/4 → 295/280/4 ✓

        #     基线 A（`resolved=True`）：**仍 295** ✓（**一个都没翻** ⇒ "只补理由、不改判据" ✓）

        #   ⚠ **`anonymous_entities` 仍为 0** ✓（造的行 `why` 非空 **且** `unparsed` 非空 ✓）

        # ── 2026-09-30（RC-401 批次十八 · **E 族缺口一** `322 消毒法`）**改钉 303 → 304** ─────────
        #   🔑 **先核对、后改数**（不是"改黄金答案刷绿"）：核对读数逐字 ——
        #     · 新增的 `parse._CLEANSE_BUFFS_LAYERS`（`驱散敌方\s*(\d+)\s*层\s*(增益|减益)`）
        #       在全部 824 条里**只命中 `skill_000322` 一条**（`消毒法`「造成魔伤，驱散敌方5层增益。」）✓
        #     · `settlement_verdict(skill_000322)` 从 `resolved=False` → **`resolved=True`** ✓
        #       （`unsettled` 由 `['驱散：驱散敌方5层增益','层：驱散敌方5层增益']` → `[]` ✓）
        #     · 而 `env` 的新支真的结算它（事件 `cleared=['spa','def']` · `layers_cleared=2` ✓）
        #   ⇒ **恰好 +1** ✓ ⇒ 台账必须跟着涨（人类口径「**每条做完台账 + 判据双涨、零降档**」✓）
        #   ⚠ **旧值 `303` 逐字留档**（改钉不删）：它 = **`322` 实现之前**的口径 ✓
        # ── 2026-09-30（RC-401 批次十八 · F 族第四种形状「号位时能耗-N」）**改钉 304 → 305** ──
        #   🔑 **先核对、后改数**（不是"改黄金答案刷绿"）—— 接通前后各取一次：
        #     · `simulatable_entities` **304 → 305** ✓
        #     · `settlement_verdict(skill_000481)`：`resolved` **False → True** ∧ `unsettled` **非空 → `[]`** ✓
        #       （**两者同一次发生** ✓）· 新形状只命中「本技能位于N号位时**能耗-N**」⇒ 冻结语料实测一条（`000481`）✓
        #   ⚠ **旧值 `304` 逐字留档**（改钉不删）：= 该形状接通之前的口径 ✓
        # ── 2026-09-30（RC-401 批次十八 · F 族第五种形状「号位时额外减伤N%」）**改钉 305 → 306** ──
        #   🔑 **先核对、后改数**：接通前后各取一次 ——
        #     · `simulatable_entities` **305 → 306** ✓
        #     · `settlement_verdict(skill_000491)`：`resolved` **False → True** ∧ `unsettled` **非空 → `[]`** ✓
        #     · **回归**：`skill_000481`（0 号位能耗那条）**仍 `True`** ✓（同一次读数里验的 ✓）
        #   ⚠ **旧值 `305` 与更早的 `304` 均逐字留档**（改钉不删）✓
        self.assertEqual(report["totals"]["simulatable_entities"], 306,
          "可模拟总数变了，先核对再改这条")
