"""04.2 规划定向判据：注入的对手情景（加性可选路径）。

跑法（仓库根）：`wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.2.sh`
或在 `roco/` 下：`PYTHONPATH=src python3 -m unittest tests.test_plan_scenarios -v`
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
#: 默认路径的**键集金标**（04.2 之前的 `PlanResult.to_dict()`；新键只许在注入时出现）。
DEFAULT_KEYS = {
    "recommended", "recommended_label", "expected", "worst", "best", "main_counter", "counter_note",
    "branches_evaluated", "no_counter_branches", "first_second_margin", "dropped_branches", "risk",
    "depth_searched", "beam", "coverage", "timed_out", "latency_ms", "opponent_model",
    "unsupported_seen", "note",
}


def public_state():
    svc = RocoService()
    status, envelope = svc.battle_new({"team": A_TEAM, "enemy_team": B_TEAM,
                                       "seed": 5, "state_version": 0})
    assert status == 200, envelope
    public = envelope["result"]["public"]
    return renv.state_from_public_planner(public, RS, analysis_seed=11), public


class ScenarioShapeTest(unittest.TestCase):
    """① 形状校验 fail closed（不许猜一个）。"""

    def test_rejects_bad_shapes(self):
        bad = [
            ("不是数组", {"scenario_id": "a"}),
            ("行不是对象", ["a"]),
            ("缺 scenario_id", [{"kind": "stay_attack"}]),
            ("kind 不认识", [{"scenario_id": "a", "kind": "whatever"}]),
            ("slots 不是整数数组", [{"scenario_id": "a", "kind": "switch_in_seen", "slots": ["1"]}]),
            ("带 probability", [{"scenario_id": "a", "kind": "stay_attack", "probability": 0.5}]),
            ("带 weight", [{"scenario_id": "a", "kind": "stay_attack", "weight": 2}]),
            ("id 重复", [{"scenario_id": "a", "kind": "stay_attack"},
                         {"scenario_id": "a", "kind": "stay_defense"}]),
        ]
        for label, raw in bad:
            with self.assertRaises(pm.ScenarioShapeError, msg=f"{label} 必须被拒绝"):
                pm.parse_opponent_scenarios(raw)

    def test_sorts_by_scenario_id_not_weight(self):
        parsed = pm.parse_opponent_scenarios([
            {"scenario_id": "band:fast", "kind": "stay_attack", "skill_ids": ["skill_000246"]},
            {"scenario_id": "band:mid", "kind": "stay_defense"},
            {"scenario_id": "band:slow", "kind": "switch_in_seen", "slots": [1]},
        ])
        self.assertEqual([s.scenario_id for s in parsed], ["band:fast", "band:mid", "band:slow"])


class DefaultPathTest(unittest.TestCase):
    """② 缺省路径逐字段不变（注入是加性的）。"""

    def test_default_keys_unchanged(self):
        state, _public = public_state()
        result = pm.plan_actions(state, RS, depth=2, beam=2, budget_ms=800)
        self.assertEqual(set(result.to_dict().keys()), DEFAULT_KEYS,
                         "缺省路径的键集必须与 04.2 之前逐字段相同")
        self.assertNotIn("opponent_model_detail", result.to_dict())

    def test_empty_injection_equals_default(self):
        state_a, _ = public_state()
        state_b, _ = public_state()
        default = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800).to_dict()
        empty = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800,
                                opponent_scenarios=[]).to_dict()
        self.assertEqual(json_key(default), json_key(empty),
                         "注入空数组必须与不注入逐字段相同")

    def test_default_distribution_untouched(self):
        state, _ = public_state()
        dist = pm.opponent_distribution(state, RS, beam=4)
        self.assertTrue(dist)
        self.assertAlmostEqual(sum(w for _a, w in dist), 1.0, places=9)
        self.assertIsInstance(pm.opponent_distribution(state, RS, beam=4, scenarios=None), list)


class InjectedScenarioTest(unittest.TestCase):
    """③ 注入情景：只当无序集合用（等权、定序、不装概率、缺什么如实报）。"""

    def test_enumerates_and_declares(self):
        state, _ = public_state()
        skills = sorted({a.skill_id for a in renv.legal_actions(state, RS, "enemy")
                         if a.kind == "skill" and a.skill_id})
        self.assertTrue(skills, "夹具里对手应当有可用技能")
        scenarios = pm.parse_opponent_scenarios([
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": skills[:2],
             "evidence_ids": ["view.opponent.revealed_skills"]},
            {"scenario_id": "s2", "kind": "switch_in_seen", "slots": [1],
             "species_ids": ["pet_000008"], "evidence_ids": ["view.seen_roster"]},
            {"scenario_id": "s3", "kind": "stay_defense"},
        ])
        dist, detail = pm.opponent_scenario_distribution(state, RS, beam=6, scenarios=scenarios)
        self.assertTrue(dist)
        self.assertEqual(detail["is_probability"], False)
        self.assertEqual(detail["weights"], "uniform_baseline")
        self.assertEqual(detail["scenario_ids"], ["s1", "s2", "s3"])
        self.assertAlmostEqual(sum(w for _a, w in dist), 1.0, places=9)
        self.assertEqual(len({w for _a, w in dist}), 1, "集合内必须等权")
        # 不可枚举的技能/位次要如实登记，不许假装能算
        self.assertIn("unavailable", detail)
        self.assertTrue(all(isinstance(row.get("why"), str) for row in detail["unavailable"]))
        self.assertIn("不许" not in detail["note"], (True,))  # note 存在即可（人读）

    def test_reports_unavailable_skill(self):
        state, _ = public_state()
        scenarios = pm.parse_opponent_scenarios([
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": ["skill_999999"]},
        ])
        _dist, detail = pm.opponent_scenario_distribution(state, RS, beam=4, scenarios=scenarios)
        self.assertTrue(detail["unavailable"], "枚举不出来的技能必须记进 unavailable")
        self.assertEqual(detail["unavailable"][0]["skill_id"], "skill_999999")

    def test_plan_result_carries_detail_only_when_injected(self):
        state_a, _ = public_state()
        state_b, _ = public_state()
        scenario = [{"scenario_id": "s1", "kind": "stay_defense"}]
        injected = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800,
                                   opponent_scenarios=scenario).to_dict()
        default = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800).to_dict()
        self.assertIn("opponent_model_detail", injected)
        self.assertNotIn("opponent_model_detail", default)
        detail = injected["opponent_model_detail"]
        self.assertEqual(detail["is_probability"], False)
        self.assertEqual(detail["scenario_ids"], ["s1"])

    def test_pending_enemy_is_never_read(self):
        """硬红线：把「对手已提交动作」种进状态，输出必须一个字都不变。"""
        state_a, _ = public_state()
        state_b, _ = public_state()
        scenario = [{"scenario_id": "s1", "kind": "stay_defense"}]
        baseline = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800,
                                   opponent_scenarios=scenario).to_dict()
        setattr(state_b, "_pending_enemy", "PLANTED-HIDDEN-ACTION")
        planted = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800,
                                  opponent_scenarios=scenario).to_dict()
        self.assertEqual(json_key(baseline), json_key(planted),
                         "规划器不许读对手已提交动作（含注入情景的路径）")


    def test_injection_changes_opponent_branch_set(self):
        """注入必须**真的生效**（给 dispatch 用的那条判据）。

        为什么需要它：直接测 `opponent_scenario_distribution()` 的那几条不走 dispatch，
        而 `opponent_model_detail` 是在 `plan_actions` 里独立算的 —— 于是把
        `if scenarios:` 改成 `if False and scenarios:`（注入被静默忽略）时旧断言全绿。
        这里两向都钉：① 注入与缺省的对手分支集**不同**；② 注入后的分支集**落在注入情景枚举出的集合里**
        （方向正确：被忽略时缺省启发式会给出情景之外的对手动作 ⇒ 必红）。
        """
        state_a, _ = public_state()
        state_b, _ = public_state()
        enemy_skills = sorted({a.skill_id for a in renv.legal_actions(state_b, RS, "enemy")
                               if a.kind == "skill" and a.skill_id
                               and not getattr(RS.skills.get(a.skill_id), "is_defense", False)})
        self.assertTrue(enemy_skills, "夹具里对手应当有可用**攻击/状态**技能（防御类另有 stay_defense 情景）")
        parsed = pm.parse_opponent_scenarios([
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": enemy_skills[:1]},
        ])
        dist, _detail = pm.opponent_scenario_distribution(state_b, RS, beam=3, scenarios=parsed)
        allowed = {pm._label(RS, action) for action, _w in dist}
        self.assertTrue(allowed, "注入情景必须至少枚举出一个动作")

        default = pm.plan_actions(state_a, RS, depth=2, beam=3, budget_ms=800).to_dict()
        injected = pm.plan_actions(state_b, RS, depth=2, beam=3, budget_ms=800,
                                   opponent_scenarios=[{"scenario_id": "s1", "kind": "stay_attack",
                                                        "skill_ids": enemy_skills[:1]}]).to_dict()
        default_set = opponent_branch_set(default)
        injected_set = opponent_branch_set(injected)
        self.assertTrue(injected_set, "注入路径必须给出对手分支（risk.top_risks 不为空）")
        self.assertTrue(injected_set <= allowed,
                        f"注入后的对手分支必须落在情景枚举集合 {allowed} 里，实际 {injected_set}")
        self.assertNotEqual(default_set, injected_set,
                            f"注入必须真的改变对手分支集：缺省 {default_set} vs 注入 {injected_set}")


def opponent_branch_set(plan_dict):
    """一手规划里**对手动作**的标签集合（来自 `risk.top_risks`）。"""
    return {str(row.get("opponent_action")) for row in plan_dict.get("risk", {}).get("top_risks", [])}


def json_key(value):
    """比较规划**内容**：去掉 `latency_ms`（挂钟读数，不是结论的一部分）。"""
    import json
    body = {k: v for k, v in value.items() if k != "latency_ms"}
    return json.dumps(body, ensure_ascii=False, sort_keys=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
