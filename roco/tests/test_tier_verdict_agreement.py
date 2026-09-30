"""`tier ↔ verdict` **两把尺子必须是一把**（2026-09-29 task-24）。

**这个文件存在的理由**（实测，不是推演）：同一条技能在**两处读数**上说法不一样 ——
`coverage.classify_skill`（档位，产品回执的 `support_tier`）说 **SIMULATABLE**，
而 `coverage.settlement_verdict`（判据，产品的 `mechanics.resolved`）说 **false**。
427 条并集里起初有 **18** 条，task-25 顺手降到 8，本批从 **8 → 0**。

根因：**两个函数各有一把尺子** —— 只有 `settlement_verdict` 会
①「逐句判**应对子句**结算了没有」、② 看「**没拉起的原语**」（`UNSETTLED_WORDS`：冻结/引电/萌化/吸血/天气/离场）。
`classify_skill` 的两条早退分支（`plain_attack` / 「效果齐 + 无 unparsed」）**两样都不看**。
修法是把这两段抽成**共用的唯一实现**（`respond_clause_gaps()` / `claimed_mechanic_words()`），
而不是在两边各写一份 —— 这一程「手抄一份清单」已经漏过五次。

**五堆 + 哪边对**（每堆都有 `tmp/t24-evidence.py` 的**运行时报据**：真开局、真出招、看引擎发不发事件）：

| 堆 | 技能 | 谁对 | 运行时报据 |
| --- | --- | --- | --- |
| A `plain_attack` 早退不看应对子句 | 383 · 422 · 423 · 771 | 判据 | 383 只发 `damage`；771 的 `self_lifesteal` 零结算分支 |
| B 「效果齐」分支不看应对子句 | 506 | 判据 | `buff_self` 发了，「额外使自己的增益翻倍」零实现 |
| C 判据没认领已声明能力覆盖的词 | 478 | 档位 | `slot_condition_applied{combo_bonus:1}` + `damage{hits:3}` 真发 |
| D `SETTLED_PATTERNS` 缺「驱散」 | 325 | 档位 | 真发 `cleanse{side:player}`（**把已结算说成未结算** ✗） |
| E 文本「伤害」二字误命中 status 技能 | 389 | 档位 | 只发 `status_unsupported`，`power=None`（**假绿** ✗） |

⇒ 两个方向都要修：人类口径是「**不许把未结算说成已结算**」**且**「**也不许把已结算说成未结算**」。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_tier_verdict_agreement -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as C          # noqa: E402
from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import service as S           # noqa: E402

RS = rdata.load_ruleset()
CENSUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data",
                      "pets100-skills-census.json")
SIM = (C.SUPPORT_SIMULATABLE_UNVERIFIED, C.SUPPORT_FULL_VERIFIED)


def _union_ids():
    """427 条并集（「我的盒子前 100 只」的技能并集）—— 台账产物，不在就跳过。"""
    if not os.path.exists(CENSUS):
        return None
    with open(CENSUS, "r", encoding="utf-8") as fh:
        return sorted({row["skill_id"] for row in json.load(fh)["rows"]})


def _mismatches():
    svc = S.RocoService()
    bad = []
    for sid in _union_ids() or ():
        sk = RS.skills.get(sid)
        if sk is None:
            continue
        tier = svc._skill_record(RS, sk, with_tier=True)["support_tier"]
        resolved = C.settlement_verdict(sk)["resolved"]
        if resolved and tier not in SIM:
            bad.append((sid, "判据 true / 档位 " + str(tier)))
        if (not resolved) and tier in SIM:
            bad.append((sid, "判据 false / 档位 " + str(tier)))
    return bad


class TierAndVerdictAgreeTest(unittest.TestCase):
    """① 427 条并集：两处读数**零打架**（改前 8、task-25 前 18）。"""

    def test_no_mismatch_on_the_union(self):
        ids = _union_ids()
        if ids is None:
            self.skipTest("台账产物 roco/tests/data/pets100-skills-census.json 不在")
        bad = _mismatches()
        self.assertEqual(bad, [], f"档位与判据打架（同一招两处两个说法）：{bad[:6]}")

    def test_counter_proof_disabling_the_shared_gates_brings_them_back(self):
        """**反证（必红方向）**：把本批抽出来的两个共用闸关掉 ⇒ 打架必须**重新出现**。

        关掉的是 `respond_clause_gaps()`（应对子句逐句判）与 `UNSETTLED_WORDS`（没拉起的原语）
        —— 它们正是修 A/B/F 三堆的那两把尺子。若关掉之后仍然 0 打架，说明这条判据
        **根本没在测那两把尺子**（假绿判据）。
        """
        if _union_ids() is None:
            self.skipTest("台账产物不在")
        real_gaps, real_words = C.respond_clause_gaps, C.UNSETTLED_WORDS
        try:
            C.respond_clause_gaps = lambda skill, parsed: []
            C.UNSETTLED_WORDS = ()
            bad = _mismatches()
        finally:
            C.respond_clause_gaps, C.UNSETTLED_WORDS = real_gaps, real_words
        self.assertGreaterEqual(len(bad), 8,
                                "关掉两道共用闸之后必须重新出现打架（否则这条判据是空的）")
        self.assertEqual(_mismatches(), [], "恢复之后必须回到 0")


class EachBucketIsFixedTest(unittest.TestCase):
    """② 五堆逐条：改完之后**两边同值**，且方向与该堆"谁对"一致。"""

    def _both(self, sid):
        sk = RS.skills[sid]
        tier = S.RocoService()._skill_record(RS, sk, with_tier=True)["support_tier"]
        v = C.settlement_verdict(sk)
        return tier, v

    def test_d_cleanse_is_settled_because_env_really_emits_it(self):
        """D：`skill_000325 晒太阳`「驱散敌方所有增益」—— 运行时**真发** `cleanse` ⇒ 判据必须 true。"""
        tier, v = self._both("skill_000325")
        self.assertTrue(v["resolved"], "引擎真的在驱散（cleanse 事件），判据不许说未结算")
        self.assertIn("驱散", v["settled"])
        self.assertIn(tier, SIM)
        # 运行时报据：真开局、真出招
        pid = next((p for p in sorted(RS.pets) if RS.is_learnable(p, "skill_000325")), None)
        self.assertIsNotNone(pid, "语料里必须有一只学得到它")
        # ⚠ 每方必须**恰好 6 只**且不与首发重复（第一版池子只有 5 只备用 ⇒ 首发在池里时只剩 5 只
        # ⇒ `reset` 抛「每方需要恰好 6 只精灵，实际 5 只」，用例**没跑到断言就炸**）。
        team = [pid] + [p for p in ("pet_000001", "pet_000002", "pet_000040", "pet_000083",
                                    "pet_000086", "pet_000127", "pet_000013") if p != pid][:5]
        st = renv.reset(team, ["pet_000550", "pet_000225", "pet_000190", "pet_000445",
                               "pet_000417", "pet_000124"], seed=7, rs=RS,
                        config="mobile_s4_candidate_v3",
                        # ⚠ 配招必须**含被测技能**（否则 `step_joint` 抛「行动不合法」——
                        # 第一版把学得到的招排序取前 4 个，`skill_000325` 不一定在里面）。
                        loadouts={pid: tuple(
                            (["skill_000325"] + [x for x in sorted(RS.learnsets[pid].all_skill_ids)
                                                 if x in RS.skills and x != "skill_000325"])[:4])},
                        unverified_overrides=[{"path": "turn_order.speed_tie", "value": "random_seeded",
                                               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用",
                                               "microcase_id": "MC-E05"}])
        from roco_env.schema import ACTION_SKILL, ACTION_CHARGE, Action
        legal = renv.legal_actions(st, RS, "enemy")
        st = renv.step_joint(st, RS, Action(ACTION_SKILL, skill_id="skill_000325"),
                             next((x for x in legal if x.kind == ACTION_CHARGE), legal[0]))
        kinds = [e.kind for e in st.events]
        self.assertIn("cleanse", kinds, "这条判据的前提就是运行时真的发 cleanse")

    def test_ab_respond_clause_gaps_block_simulatable(self):
        """A/B：应对子句**没结算**时，档位不许说可模拟（实测这几条运行时不发对应事件）。

        ⚠ 2026-09-30（task-26 H 族批一）**改钉**：原来的名单是 5 条
        `383 / 422 / 423 / 506 / 771`。其中 **`422 水刃` 与 `423 天洪` 现在真的结算了** ——
        它们写的是「**应对状态：本技能能耗永久-3 / -6**」，批一给这一类加了
        `damage.triggered_ramp`（应对成功后把永久能耗修正累加到 `skill_ramps`）⇒
        **运行时有据**：对手出状态招（`_respond_succeeded=True`）⇒ `triggered_ramp` 事件 +
        `skill_ramps={...: {'cost': -3}}` ⇒ 下一次的**能耗真的从 4 变 1**（423 是 7 变 1）；
        对手出攻击招（应对失败）⇒ 无事件、无 ramps、能耗不变 ✓
        ⇒ 所以这两条从"必须保持未结算"里**移出**，并在下面**正向钉住**（不是删掉不管 ✗）。
        其余三条（383 / 506 / 771）**照旧**必须两边都说未结算 ✓ —— 判据的意图一个字没松。
        """
        for sid in ("skill_000383", "skill_000506", "skill_000771"):
            tier, v = self._both(sid)
            self.assertNotIn(tier, SIM, f"{sid}: 应对子句没结算，档位不许说可模拟")
            self.assertFalse(v["resolved"], f"{sid}: 判据也必须说未结算（两边同值）")

    def test_h_triggered_ramp_is_settled_after_the_batch(self):
        """H 族批一/批二：三个触发器（应对成功 / 击败敌方 / **回合结束时**）**真的结算**了
        ⇒ 两边都转正（改钉的反向钉子）。

        批二补的 3 条读数（全部实打）：`432 水波术` 回合末 `skill_ramps={power:20}` 且第二手
        再涨到 40 · `252 冲撞` 能耗 7→6 · `503 抛石` 能耗 30→25（⚠ 抛石能耗 30 > v3 上限 10
        ⇒ **正常局里打不出来**，我用探针把能量补到 30 才验到 —— 这条**如实登记**）。
        """
        for sid in ("skill_000422", "skill_000423", "skill_000382", "skill_000792",
                    "skill_000432", "skill_000252", "skill_000503"):
            tier, v = self._both(sid)
            self.assertIn(tier, SIM, f"{sid}: 触发器已实现，档位该说可模拟")
            self.assertTrue(v["resolved"], f"{sid}: 判据也该说已结算（两边同值）")

    def test_f_unsupported_words_block_simulatable(self):
        """F：描述里有**没拉起的原语**（冻结/引电/萌化/吸血）⇒ 两边都说未结算。"""
        # ⚠ 2026-09-30（task-28 · H 族 `285 退化`）**改钉**：`skill_000285` **从本清单移出** ✗ ——
        #   不是因为它"不算未拉起"了，而是**它真的被拉起了** ✓：
        #   「敌方获得1层萌化」现在由 `damage.moe_mark` 路由到 `PetState.marks` ✓
        #   （复用现成写点 ✓ **不进** `END_OF_TURN_STATUS` ✗ —— 进了就是"凭空 tick" ⇒ 假绿 ✗）
        #   验收三条同时成立（实测 ✓）：`verdict=True` **且** `unclaimed_mechanic_spans==[]` **且** 真打一手
        #   ⇒ `marks={'萌化':1}` + `mark_added` ✓；关能力位 ⇒ 两把尺子都说未结算 ✓（反证 ✓）
        #   ⇒ 它的正向钉子已迁到 `roco/tests/test_moe_mark.py` ✓（**只移不删** ✓）
        for sid in ("skill_000355", "skill_000530", "skill_000535",
                    "skill_000606", "skill_000775"):
            tier, v = self._both(sid)
            self.assertNotIn(tier, SIM, f"{sid}: 有没拉起的原语，档位不许说可模拟")
            self.assertFalse(v["resolved"], f"{sid}: 判据也必须说未结算")

    def test_e_damage_word_alone_does_not_settle_a_status_skill(self):
        """E：`skill_000389 充分燃烧` 描述里有「灼烧伤害」四个字，但 status、`power=None`、
        零解析效果、运行时只发 `status_unsupported` ⇒ **不许**因为文本里有「伤害」就判已通。"""
        sk = RS.skills["skill_000389"]
        self.assertFalse(sk.has_static_power)
        tier, v = self._both("skill_000389")
        self.assertFalse(v["resolved"], "文本里有「伤害」二字 ≠ 引擎会结算伤害")
        self.assertNotIn(tier, SIM)

    def test_c_declared_capability_words_are_claimed_by_the_verdict_too(self):
        """C：`skill_000478 传感器` —— 运行时真发 `slot_condition_applied{combo_bonus:1}`
        且 `damage{hits:3}` ⇒ 判据不许把「号位连击+1」报成未认领。"""
        v = C.settlement_verdict(RS.skills["skill_000478"])
        self.assertFalse(any("连击" in str(u) for u in v["unsettled"]),
                         f"号位连击真的结算了，判据却报未认领：{v['unsettled']}")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
