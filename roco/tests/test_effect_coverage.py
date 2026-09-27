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
            tier = cov.classify_skill(skill, multi_hit_declared=caps["multi_hit"],
                                      slot_condition_declared=caps["slot_condition"],
                                      position_shift_declared=caps["position_shift"],
                                      foe_energy_loss_declared=caps["foe_energy_loss"],
                                      initiative_declared=caps["initiative_condition"],
                                      per_layer_cost_declared=caps["per_layer_cost"],
                                      foe_switch_condition_declared=caps["foe_switch_condition"],
                                      per_use_ramp_declared=caps["per_use_ramp"],
                                      on_hit_ramp_declared=caps["on_hit_ramp"])
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
        target = None
        for skill in self.rs.skills.values():
            if getattr(skill, "is_trait", False):
                continue
            row = cov.classify_skill(skill, multi_hit_declared=False)
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
            expect = cov.classify_skill(skill, multi_hit_declared=caps["multi_hit"],
                                        slot_condition_declared=caps["slot_condition"],
                                        position_shift_declared=caps["position_shift"],
                                        foe_energy_loss_declared=caps["foe_energy_loss"],
                                        initiative_declared=caps["initiative_condition"],
                                        per_layer_cost_declared=caps["per_layer_cost"],
                                        foe_switch_condition_declared=caps["foe_switch_condition"],
                                        per_use_ramp_declared=caps["per_use_ramp"],
                                        on_hit_ramp_declared=caps["on_hit_ramp"])
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
            residual = [x for x in cov.parse_mod.unclaimed_mechanic_spans(skill, parsed=parsed)
                        if str(x).split("：")[0] not in claimed_words]
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
        self.assertEqual(report["totals"]["simulatable_entities"], 298,
                         "可模拟总数变了，先核对再改这条")
