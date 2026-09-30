"""04.6 定向判据：否定性输入的**保守回退** + **非有限数不得进 JSON**。

跑法：`wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.6.sh`

三条：
  ① **非有限数不得进 JSON**：出口把 `inf/-inf/nan` 换成 `null` 并逐路径登记
     （`json.dumps(..., allow_nan=False)` 是硬判据 —— 它**会**在非有限数上抛）；
  ② **超时是保守的**：注入时钟强制超时 ⇒ `timed_out` 如实置位、覆盖率的分子 < 分母、
     note 点名「超时」、且回执里**一个非有限数都没有**；
  ③ **候选不全仍合法**：真实夹具上 `dropped_branches` 如实登记，推荐（若有）必须是**合法动作**。
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
COUNTER_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


def fixture(*, team=None, enemy=None, hp=None, energy=None, preview=False):
    from roco_env.service import RocoService
    svc = RocoService()
    body = {"team": team or A_TEAM, "enemy_team": enemy or B_TEAM, "seed": 5, "state_version": 0}
    if preview:
        body["opening_preview"] = True
    status, envelope = svc.battle_new(body)
    assert status == 200, (status, envelope)
    public = json.loads(json.dumps(envelope["result"]["public"]))
    active = int(public["self"]["active"])
    if hp is not None:
        public["self"]["pets"][active]["hp"] = hp
    if energy is not None:
        public["self"]["pets"][active]["energy"] = energy
    return renv.state_from_public_planner(public, RS, analysis_seed=11)


FIXTURES = {
    "standard": lambda: fixture(),
    "low-energy": lambda: fixture(energy=0),
    "near-death": lambda: fixture(team=COUNTER_TEAM, enemy=COUNTER_TEAM, hp=1),
    "preview": lambda: fixture(preview=True),
}


class NonFiniteJsonTest(unittest.TestCase):
    """① 非有限数不得进 JSON（`Infinity`/`NaN` 是非法 JSON，JS `JSON.parse` 会抛）。"""

    def test_sanitizer_replaces_non_finite_and_records_paths(self):
        paths = []
        cleaned = pm._json_safe({"a": float("inf"), "b": [float("nan"), 1.5],
                                 "c": {"d": float("-inf")}, "e": 2}, paths)
        self.assertIsNone(cleaned["a"])
        self.assertIsNone(cleaned["b"][0])
        self.assertEqual(cleaned["b"][1], 1.5)
        self.assertIsNone(cleaned["c"]["d"])
        self.assertEqual(cleaned["e"], 2)
        self.assertEqual(paths, ["$.a", "$.b[0]", "$.c.d"], "非有限数必须逐路径登记")
        json.dumps(cleaned, allow_nan=False)   # 还有非有限数这里就会抛

    def test_to_dict_sanitizes_even_a_plan_result_with_non_finite(self):
        """**产品出口**判据：直接构造一个带 `inf/-inf/nan` 的 `PlanResult` ⇒ `to_dict()` 必须清干净。

        为什么不用「找一个真实极端局面」：那要靠运气；而 `to_dict()` 是**所有**回执的唯一出口，
        直接喂它非有限数就能把这条守卫钉死（绕过 `_json_safe` 的变异会当场红）。
        """
        result = pm.PlanResult(
            recommended=None, recommended_label="（构造）", expected=float("inf"),
            worst=float("-inf"), best=float("nan"), main_counter=None, counter_note="",
            branches_evaluated=0, depth_searched=0, beam=1, coverage=0.0, timed_out=False,
            latency_ms=0.0, opponent_model="heuristic-distribution", unsupported_seen=0,
            note="构造用于判据", first_second_margin=float("nan"))
        plan = result.to_dict()
        self.assertIsNone(plan["expected"])
        self.assertIsNone(plan["worst"])
        self.assertIsNone(plan["best"])
        self.assertIsNone(plan["first_second_margin"])
        self.assertEqual(plan["non_finite_sanitized"],
                         ["$.expected", "$.worst", "$.best", "$.first_second_margin"],
                         "每个被清掉的值都要逐路径登记（原因：非有限数不进 JSON）")
        json.dumps(plan, ensure_ascii=False, allow_nan=False)

    def test_real_receipts_are_strict_json(self):
        for name, build in FIXTURES.items():
            with self.subTest(fixture=name):
                plan = pm.plan_actions(build(), RS, depth=2, beam=4, budget_ms=800,
                                       clock=lambda: 0.0).to_dict()
                text = json.dumps(plan, ensure_ascii=False, allow_nan=False)
                self.assertEqual(json.loads(text), json.loads(json.dumps(plan, ensure_ascii=False)))
                self.assertNotIn("Infinity", text)
                self.assertNotIn("NaN", text)
                # 只在真的发生时才出现这个键（缺省金标逐字段不变）
                self.assertNotIn("non_finite_sanitized", plan)


class TimeoutConservatismTest(unittest.TestCase):
    """② 超时 ⇒ 保守且有界：如实置位 + 覆盖率分子 < 分母 + note 点名 + 无非有限数。"""

    def test_forced_timeout_is_conservative(self):
        state = fixture()
        ticks = iter([0.0] + [1.0] * 128)
        plan = pm.plan_actions(state, RS, depth=2, beam=4, budget_ms=50,
                               clock=lambda: next(ticks)).to_dict()
        self.assertIs(plan["timed_out"], True)
        self.assertIs(plan["budget"]["timed_out"], True)
        self.assertIn("超时", plan["note"])
        detail = plan["coverage_detail"]
        self.assertLess(detail["numerator"], detail["denominator"],
                        "超时后覆盖率分子必须小于分母（不许报「全覆盖」）")
        self.assertEqual(plan["coverage"], 0.0)
        self.assertIs(plan["timed_out"], plan["budget"]["timed_out"])
        json.dumps(plan, ensure_ascii=False, allow_nan=False)


class IncompleteCandidatesTest(unittest.TestCase):
    """③ 候选不全仍合法：`dropped_branches` 如实登记；推荐（若有）必须是**合法动作**。"""

    def test_recommendation_is_always_a_legal_action(self):
        for name, build in FIXTURES.items():
            with self.subTest(fixture=name):
                state = build()
                plan = pm.plan_actions(state, RS, depth=2, beam=4, budget_ms=800,
                                       clock=lambda: 0.0).to_dict()
                self.assertIsInstance(plan["dropped_branches"], dict)
                self.assertIsInstance(plan["truncation"]["dropped"], list)
                if plan["recommended"] is not None:
                    legal = [a.to_dict() for a in renv.legal_actions(state, RS, "player")]
                    self.assertIn(plan["recommended"], legal,
                                  f"{name}: 推荐的动作必须真的在合法动作里（不许补造分支）")
                # 「候选不全」的可见面：裁掉的候选 + 丢弃的分支都必须能查
                self.assertIn("rule", plan["truncation"])
                self.assertIn("uncomputable", plan["truncation"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
