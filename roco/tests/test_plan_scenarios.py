"""04.2 规划定向判据：注入的对手情景（**加性可选**路径）+ 缺省路径金标。

跑法（仓库根）：`wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.2.sh`
或在 `roco/` 下：`PYTHONPATH=src python3 -m unittest tests.test_plan_scenarios -v`

这一组钉三件事，每件都两向（改坏必红 / 不改坏不红）：
  ① **缺省路径逐字段不变**（`DefaultGoldenTest`：值与键集的金标。只钉键集是不够的，
     把 `opponent_distribution` 的排序改反，键集断言照样全绿 —— 变异 B 就是这么抓出来的）；
  ② **注入真的生效**（`ServiceInjectionTest`：对手分支集必须落在情景枚举集合里且与缺省不同）；
  ③ **两类依据分开写 + 缺什么如实报**（P3：scenario-driven vs assumption-driven、unavailable）。
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
from roco_env import service as svc_mod     # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
#: service 级缺省请求（金标就是按这组参数冻的；改这里会让金标比对失去意义）。
PLAN_DEPTH = 2
PLAN_BEAM = 2
PLAN_BUDGET_MS = 5000
PLAN_SEEDS = [11, 29]
#: 默认路径的**键集金标**（04.2 之前的 `PlanResult.to_dict()`；新键只许在注入时出现）。
DEFAULT_KEYS = {
    "recommended", "recommended_label", "expected", "worst", "best", "main_counter", "counter_note",
    "branches_evaluated", "no_counter_branches", "first_second_margin", "dropped_branches", "risk",
    "depth_searched", "beam", "coverage", "timed_out", "latency_ms", "opponent_model",
    "unsupported_seen", "note",
}

# @@GOLDEN:BEGIN（由 scratch 生成器注入；**不要手改**，改坏就是改证据）
PLANNER_DEFAULT_GOLDEN_TEXT = r"""
{
 "beam": 2,
 "best": -0.2394,
 "branches_evaluated": 12,
 "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.24）",
 "coverage": 1.0,
 "depth_searched": 2,
 "dropped_branches": {},
 "expected": -0.2394,
 "first_second_margin": 0.0732,
 "latency_ms": 0.0,
 "main_counter": "换上第2位",
 "no_counter_branches": 0,
 "note": "搜了 3/3 个我方候选 × 对手 2 个候选；深度 2；对手按分布建模，未读取其待执行动作",
 "opponent_model": "heuristic-distribution",
 "recommended": {
  "kind": "skill",
  "skill_id": "skill_000246"
 },
 "recommended_label": "抓挠",
 "risk": {
  "branch_count": 2,
  "downside": 0.0,
  "fragile": false,
  "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
  "spread": 0.0,
  "threshold": 1.2,
  "top_risks": [
   {
    "loss_vs_expected": 0.0,
    "opponent_action": "换上第2位",
    "score": -0.2394
   },
   {
    "loss_vs_expected": 0.0,
    "opponent_action": "换上第3位",
    "score": -0.2394
   }
  ]
 },
 "timed_out": false,
 "unsupported_seen": 0,
 "worst": -0.2394
}
"""
SERVICE_DEFAULT_GOLDEN_TEXT = r"""
{
 "analysis_seeds": [
  11,
  29
 ],
 "beam": 2,
 "best": {
  "max": -0.2394,
  "min": -0.2394
 },
 "branches_evaluated": 24,
 "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.24）",
 "coverage": 1.0,
 "damage_preview": null,
 "decision_id": "m-b3453cbad856d5c6:v0",
 "depth_searched": 2,
 "expected": {
  "max": -0.2394,
  "mean": -0.2394,
  "min": -0.2394
 },
 "first_second_margin": {
  "max": 0.0732,
  "mean": 0.0732,
  "min": 0.0732,
  "note": "枚举第一与第二名的估值差（一手推演尺度）。只用于判断「这一手是不是真的两难」，**不是胜率、不是游戏机制的分差**。量纲按本引擎标定，不要与旧演示引擎的分数直接比较。",
  "scale": "one-ply-value"
 },
 "main_counter": "换上第2位",
 "match_id": "m-b3453cbad856d5c6",
 "opponent_model": "heuristic-distribution",
 "per_seed": [
  {
   "beam": 2,
   "best": -0.2394,
   "branches_evaluated": 12,
   "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.24）",
   "coverage": 1.0,
   "depth_searched": 2,
   "dropped_branches": {},
   "expected": -0.2394,
   "first_second_margin": 0.0732,
   "main_counter": "换上第2位",
   "no_counter_branches": 0,
   "note": "搜了 3/3 个我方候选 × 对手 2 个候选；深度 2；对手按分布建模，未读取其待执行动作",
   "opponent_model": "heuristic-distribution",
   "recommended": {
    "kind": "skill",
    "skill_id": "skill_000246"
   },
   "recommended_label": "抓挠",
   "risk": {
    "branch_count": 2,
    "downside": 0.0,
    "fragile": false,
    "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
    "spread": 0.0,
    "threshold": 1.2,
    "top_risks": [
     {
      "loss_vs_expected": 0.0,
      "opponent_action": "换上第2位",
      "score": -0.2394
     },
     {
      "loss_vs_expected": 0.0,
      "opponent_action": "换上第3位",
      "score": -0.2394
     }
    ]
   },
   "timed_out": false,
   "unsupported_seen": 0,
   "worst": -0.2394
  },
  {
   "beam": 2,
   "best": -0.2394,
   "branches_evaluated": 12,
   "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.24）",
   "coverage": 1.0,
   "depth_searched": 2,
   "dropped_branches": {},
   "expected": -0.2394,
   "first_second_margin": 0.0732,
   "main_counter": "换上第2位",
   "no_counter_branches": 0,
   "note": "搜了 3/3 个我方候选 × 对手 2 个候选；深度 2；对手按分布建模，未读取其待执行动作",
   "opponent_model": "heuristic-distribution",
   "recommended": {
    "kind": "skill",
    "skill_id": "skill_000246"
   },
   "recommended_label": "抓挠",
   "risk": {
    "branch_count": 2,
    "downside": 0.0,
    "fragile": false,
    "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
    "spread": 0.0,
    "threshold": 1.2,
    "top_risks": [
     {
      "loss_vs_expected": 0.0,
      "opponent_action": "换上第2位",
      "score": -0.2394
     },
     {
      "loss_vs_expected": 0.0,
      "opponent_action": "换上第3位",
      "score": -0.2394
     }
    ]
   },
   "timed_out": false,
   "unsupported_seen": 0,
   "worst": -0.2394
  }
 ],
 "recommendation_stable": true,
 "recommended_by_seed": {
  "11": "抓挠",
  "29": "抓挠"
 },
 "recommended_label": "抓挠",
 "risk": {
  "downside_max": 0.0,
  "downside_min": 0.0,
  "fragile": false,
  "note": "risk 只描述推荐那一手的落差：`downside` 是期望到最坏的举例，`fragile` 表示落差超过产品阈值（用于措辞分级，不是游戏机制）。对手仍是启发式分布建模，不是真人行为。",
  "threshold": 1.2,
  "worst_seed_risks": [
   {
    "loss_vs_expected": 0.0,
    "opponent_action": "换上第2位",
    "score": -0.2394
   },
   {
    "loss_vs_expected": 0.0,
    "opponent_action": "换上第3位",
    "score": -0.2394
   }
  ]
 },
 "rules_version": "roco-world-s4-2026-09-10/legacy_sim_v1",
 "schema_version": 1,
 "state_version": 0,
 "timed_out": false,
 "turn": 1,
 "unsupported_seen": 0,
 "worst": {
  "max": -0.2394,
  "min": -0.2394
 }
}
"""
#: beam=8（对手全部合法动作都进分布）的缺省金标：覆盖**攻击技能权重**那条路径。
#: 为什么需要它：beam=2 的夹具里对手 top-2 全是换人动作，`1.0 + power/60.0`
#: 改成 `/61.0` 时那份金标**一个字节都不变**（实测 B2 变异不红）⇒ 只钉一个分位数不够。
PLANNER_DEFAULT_BEAM8_GOLDEN_TEXT = r"""
{
 "beam": 8,
 "best": 1.2574,
 "branches_evaluated": 128,
 "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.28）",
 "coverage": 1.0,
 "depth_searched": 2,
 "dropped_branches": {},
 "expected": 0.207,
 "first_second_margin": 0.0732,
 "latency_ms": 0.0,
 "main_counter": "换上第2位",
 "no_counter_branches": 0,
 "note": "搜了 8/8 个我方候选 × 对手 8 个候选；深度 2；对手按分布建模，未读取其待执行动作",
 "opponent_model": "heuristic-distribution",
 "recommended": {
  "item_id": "能量果",
  "kind": "item",
  "target_index": 0
 },
 "recommended_label": "使用能量果",
 "risk": {
  "branch_count": 8,
  "downside": 0.4837,
  "fragile": false,
  "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
  "spread": 1.5341,
  "threshold": 1.2,
  "top_risks": [
   {
    "loss_vs_expected": 0.4837,
    "opponent_action": "换上第2位",
    "score": -0.2767
   },
   {
    "loss_vs_expected": 0.4837,
    "opponent_action": "换上第3位",
    "score": -0.2767
   },
   {
    "loss_vs_expected": 0.2395,
    "opponent_action": "啮合传递",
    "score": -0.0326
   }
  ]
 },
 "timed_out": false,
 "unsupported_seen": 0,
 "worst": -0.2767
}
"""
SERVICE_DEFAULT_BEAM8_GOLDEN_TEXT = r"""
{
 "analysis_seeds": [
  11,
  29
 ],
 "beam": 8,
 "best": {
  "max": 1.2574,
  "min": 1.2574
 },
 "branches_evaluated": 256,
 "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.28）",
 "coverage": 1.0,
 "damage_preview": null,
 "decision_id": "m-b3453cbad856d5c6:v0",
 "depth_searched": 2,
 "expected": {
  "max": 0.207,
  "mean": 0.207,
  "min": 0.207
 },
 "first_second_margin": {
  "max": 0.0732,
  "mean": 0.0732,
  "min": 0.0732,
  "note": "枚举第一与第二名的估值差（一手推演尺度）。只用于判断「这一手是不是真的两难」，**不是胜率、不是游戏机制的分差**。量纲按本引擎标定，不要与旧演示引擎的分数直接比较。",
  "scale": "one-ply-value"
 },
 "main_counter": "换上第2位",
 "match_id": "m-b3453cbad856d5c6",
 "opponent_model": "heuristic-distribution",
 "per_seed": [
  {
   "beam": 8,
   "best": 1.2574,
   "branches_evaluated": 128,
   "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.28）",
   "coverage": 1.0,
   "depth_searched": 2,
   "dropped_branches": {},
   "expected": 0.207,
   "first_second_margin": 0.0732,
   "main_counter": "换上第2位",
   "no_counter_branches": 0,
   "note": "搜了 8/8 个我方候选 × 对手 8 个候选；深度 2；对手按分布建模，未读取其待执行动作",
   "opponent_model": "heuristic-distribution",
   "recommended": {
    "item_id": "能量果",
    "kind": "item",
    "target_index": 0
   },
   "recommended_label": "使用能量果",
   "risk": {
    "branch_count": 8,
    "downside": 0.4837,
    "fragile": false,
    "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
    "spread": 1.5341,
    "threshold": 1.2,
    "top_risks": [
     {
      "loss_vs_expected": 0.4837,
      "opponent_action": "换上第2位",
      "score": -0.2767
     },
     {
      "loss_vs_expected": 0.4837,
      "opponent_action": "换上第3位",
      "score": -0.2767
     },
     {
      "loss_vs_expected": 0.2395,
      "opponent_action": "啮合传递",
      "score": -0.0326
     }
    ]
   },
   "timed_out": false,
   "unsupported_seen": 0,
   "worst": -0.2767
  },
  {
   "beam": 8,
   "best": 1.2574,
   "branches_evaluated": 128,
   "counter_note": "最不利的对手选择是「换上第2位」（估值 -0.28）",
   "coverage": 1.0,
   "depth_searched": 2,
   "dropped_branches": {},
   "expected": 0.207,
   "first_second_margin": 0.0732,
   "main_counter": "换上第2位",
   "no_counter_branches": 0,
   "note": "搜了 8/8 个我方候选 × 对手 8 个候选；深度 2；对手按分布建模，未读取其待执行动作",
   "opponent_model": "heuristic-distribution",
   "recommended": {
    "item_id": "能量果",
    "kind": "item",
    "target_index": 0
   },
   "recommended_label": "使用能量果",
   "risk": {
    "branch_count": 8,
    "downside": 0.4837,
    "fragile": false,
    "note": "risk 只描述**推荐的那一手**在对手各种选择下的落差；`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。",
    "spread": 1.5341,
    "threshold": 1.2,
    "top_risks": [
     {
      "loss_vs_expected": 0.4837,
      "opponent_action": "换上第2位",
      "score": -0.2767
     },
     {
      "loss_vs_expected": 0.4837,
      "opponent_action": "换上第3位",
      "score": -0.2767
     },
     {
      "loss_vs_expected": 0.2395,
      "opponent_action": "啮合传递",
      "score": -0.0326
     }
    ]
   },
   "timed_out": false,
   "unsupported_seen": 0,
   "worst": -0.2767
  }
 ],
 "recommendation_stable": true,
 "recommended_by_seed": {
  "11": "使用能量果",
  "29": "使用能量果"
 },
 "recommended_label": "使用能量果",
 "risk": {
  "downside_max": 0.4837,
  "downside_min": 0.4837,
  "fragile": false,
  "note": "risk 只描述推荐那一手的落差：`downside` 是期望到最坏的举例，`fragile` 表示落差超过产品阈值（用于措辞分级，不是游戏机制）。对手仍是启发式分布建模，不是真人行为。",
  "threshold": 1.2,
  "worst_seed_risks": [
   {
    "loss_vs_expected": 0.4837,
    "opponent_action": "换上第2位",
    "score": -0.2767
   },
   {
    "loss_vs_expected": 0.4837,
    "opponent_action": "换上第3位",
    "score": -0.2767
   },
   {
    "loss_vs_expected": 0.2395,
    "opponent_action": "啮合传递",
    "score": -0.0326
   }
  ]
 },
 "rules_version": "roco-world-s4-2026-09-10/legacy_sim_v1",
 "schema_version": 1,
 "state_version": 0,
 "timed_out": false,
 "turn": 1,
 "unsupported_seen": 0,
 "worst": {
  "max": -0.2767,
  "min": -0.2767
 }
}
"""
# @@GOLDEN:END

#: 缺省回执的 canonical 金标（去掉 `latency_ms` 这类挂钟读数后逐字段比较）。
PLANNER_DEFAULT_CANON = json.dumps(json.loads(PLANNER_DEFAULT_GOLDEN_TEXT),
                                   ensure_ascii=False, sort_keys=True)
SERVICE_DEFAULT_CANON = json.dumps(json.loads(SERVICE_DEFAULT_GOLDEN_TEXT),
                                   ensure_ascii=False, sort_keys=True)
SERVICE_DEFAULT_KEYS = frozenset(json.loads(SERVICE_DEFAULT_GOLDEN_TEXT))
PLANNER_DEFAULT_BEAM8_CANON = json.dumps(json.loads(PLANNER_DEFAULT_BEAM8_GOLDEN_TEXT),
                                         ensure_ascii=False, sort_keys=True)
SERVICE_DEFAULT_BEAM8_CANON = json.dumps(json.loads(SERVICE_DEFAULT_BEAM8_GOLDEN_TEXT),
                                         ensure_ascii=False, sort_keys=True)


def public_state():
    """planner 级夹具：公开面 + 由它重建的分析状态。"""
    svc = RocoService()
    status, envelope = svc.battle_new({"team": A_TEAM, "enemy_team": B_TEAM,
                                       "seed": 5, "state_version": 0})
    assert status == 200, envelope
    public = envelope["result"]["public"]
    return renv.state_from_public_planner(public, RS, analysis_seed=11), public


def service_public():
    """service 级夹具：`/battle/plan` 要的就是这份公开面。"""
    svc = RocoService()
    status, envelope = svc.battle_new({"team": A_TEAM, "enemy_team": B_TEAM,
                                       "seed": 5, "state_version": 0})
    assert status == 200, envelope
    return svc, envelope["result"]["public"]


def plan_body(public, **overrides):
    """缺省 `/battle/plan` 请求体（与金标同参数）。"""
    body = {"state_version": public.get("state_version"), "public": public,
            "depth": PLAN_DEPTH, "beam": PLAN_BEAM, "budget_ms": PLAN_BUDGET_MS,
            "analysis_seeds": list(PLAN_SEEDS)}
    body.update(overrides)
    return body


def enemy_skill_ids(public, *, defenses=None):
    """重建状态里对手**可枚举**的技能 id（可按是否防御类筛）。"""
    state = renv.state_from_public_planner(public, RS, analysis_seed=11)
    ids = sorted({a.skill_id for a in renv.legal_actions(state, RS, "enemy")
                  if a.kind == "skill" and a.skill_id})
    if defenses is None:
        return ids
    return [sid for sid in ids
            if bool(getattr(RS.skills.get(sid), "is_defense", False)) == defenses]


def opponent_branch_union(payload):
    """一份规划回执里**所有分析种子**下出现过的对手动作标签。"""
    out = set()
    for row in payload.get("per_seed", []):
        for risk in (row.get("risk", {}).get("top_risks", []) or []):
            out.add(str(risk.get("opponent_action")))
    return out


def scrub_latency(value):
    """去掉挂钟读数（`latency_ms` 出现在信封、per_seed 两层）。"""
    if isinstance(value, dict):
        return {k: scrub_latency(v) for k, v in value.items() if k != "latency_ms"}
    if isinstance(value, list):
        return [scrub_latency(v) for v in value]
    return value


def canon(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def first_diff(expected, actual, path="$"):
    """金标与实际的**第一处**差异（失败信息要能直接指出哪一条）。"""
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in expected:
                return f"{path}.{key} 多出来：{actual[key]!r}"
            if key not in actual:
                return f"{path}.{key} 丢了（金标 {expected[key]!r}）"
            diff = first_diff(expected[key], actual[key], f"{path}.{key}")
            if diff:
                return diff
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{path} 长度 {len(expected)} → {len(actual)}"
        for i, (e, a) in enumerate(zip(expected, actual)):
            diff = first_diff(e, a, f"{path}[{i}]")
            if diff:
                return diff
        return None
    if expected != actual:
        return f"{path}: 金标 {expected!r} → 实际 {actual!r}"
    return None


def assert_canon(test, actual, expected_canon, label):
    actual_canon = canon(actual)
    if actual_canon == expected_canon:
        return
    diff = first_diff(json.loads(expected_canon), json.loads(actual_canon))
    test.fail(f"{label}与金标不一致：{diff}")


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
            ("带 share", [{"scenario_id": "a", "kind": "stay_attack", "share": 0.3}]),
            ("带 p", [{"scenario_id": "a", "kind": "stay_attack", "p": 0.3}]),
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


class DefaultGoldenTest(unittest.TestCase):
    """② 缺省路径**逐字段金标**：注入是加性的，缺省行为一个字节都不许动。

    为什么要值级金标：`test_default_keys_unchanged` 只钉键集，
    `test_empty_injection_equals_default` 比的是同一份代码的两次调用 ——
    把缺省路径本身改坏（变异 B：`opponent_distribution` 排序改反），两条都照样绿。
    """

    def test_planner_default_matches_golden(self):
        state, _public = public_state()
        got = pm.plan_actions(state, RS, depth=PLAN_DEPTH, beam=PLAN_BEAM,
                              budget_ms=800, clock=lambda: 0.0).to_dict()
        assert_canon(self, got, PLANNER_DEFAULT_CANON, "planner 缺省回执")
        self.assertEqual(set(got.keys()), DEFAULT_KEYS)

    def test_planner_default_beam8_matches_golden(self):
        """beam=8：对手**全部**合法动作都进分布 ⇒ 攻击技能权重那条路径也被钉住。"""
        state, _public = public_state()
        got = pm.plan_actions(state, RS, depth=PLAN_DEPTH, beam=8,
                              budget_ms=800, clock=lambda: 0.0).to_dict()
        assert_canon(self, got, PLANNER_DEFAULT_BEAM8_CANON, "planner 缺省回执（beam=8）")

    def test_planner_default_keys_unchanged(self):
        state, _public = public_state()
        result = pm.plan_actions(state, RS, depth=PLAN_DEPTH, beam=PLAN_BEAM,
                                 budget_ms=800, clock=lambda: 0.0)
        self.assertEqual(set(result.to_dict().keys()), DEFAULT_KEYS,
                         "缺省路径的键集必须与 04.2 之前逐字段相同")
        self.assertNotIn("opponent_model_detail", result.to_dict())

    def test_empty_injection_equals_default(self):
        state_a, _ = public_state()
        state_b, _ = public_state()
        default = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800,
                                  clock=lambda: 0.0).to_dict()
        empty = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800,
                                clock=lambda: 0.0, opponent_scenarios=[]).to_dict()
        self.assertEqual(canon(default), canon(empty),
                         "注入空数组必须与不注入逐字段相同")

    def test_default_distribution_untouched(self):
        state, _ = public_state()
        dist = pm.opponent_distribution(state, RS, beam=4)
        self.assertTrue(dist)
        self.assertAlmostEqual(sum(w for _a, w in dist), 1.0, places=9)
        self.assertIsInstance(pm.opponent_distribution(state, RS, beam=4, scenarios=None), list)

    def test_service_default_matches_golden(self):
        """缺省 `/battle/plan` 回执（去掉 latency_ms）逐字段等于金标，且**没有**依据栏。"""
        svc, public = service_public()
        status, env = svc.battle_plan(plan_body(public))
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        assert_canon(self, scrub_latency(payload), SERVICE_DEFAULT_CANON, "service 缺省回执")
        self.assertEqual(set(payload.keys()), set(SERVICE_DEFAULT_KEYS))
        self.assertNotIn("opponent_basis", payload,
                         "没给 opponent_scenarios 就不许出现「本次对手依据」栏")
        self.assertNotIn("opponent_model_detail", payload["per_seed"][0])
        limitations = env.get("limitations") or []
        self.assertNotIn(True, ["opponent_basis" in line for line in limitations],
                         "缺省信封的 limitations 不许提注入（缺省逐字段不变）")

    def test_service_default_beam8_matches_golden(self):
        """service 级 beam=8 缺省回执金标（覆盖攻击权重路径，且没有依据栏）。"""
        svc, public = service_public()
        status, env = svc.battle_plan(plan_body(public, beam=8))
        self.assertEqual(status, 200, env.get("error"))
        assert_canon(self, scrub_latency(env["result"]), SERVICE_DEFAULT_BEAM8_CANON,
                     "service 缺省回执（beam=8）")
        self.assertNotIn("opponent_basis", env["result"])


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
        # 情景点名并枚举出来的**具体动作**必须留痕（scenario-driven 的可见面）
        self.assertEqual(len(detail["enumerated_actions"]), detail["enumerated"])
        self.assertEqual(sum(detail["enumerated_by_scenario"].values()), detail["enumerated"])
        for row in detail["enumerated_actions"]:
            self.assertEqual(row["kind"], "scenario")
            self.assertIn(row["scenario_id"], detail["scenario_ids"])
        # 不可枚举的技能/位次要如实登记，不许假装能算
        self.assertIn("unavailable", detail)
        self.assertTrue(all(isinstance(row.get("why"), str) for row in detail["unavailable"]))

    def test_reports_unavailable_skill(self):
        state, _ = public_state()
        scenarios = pm.parse_opponent_scenarios([
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": ["skill_999999"]},
        ])
        _dist, detail = pm.opponent_scenario_distribution(state, RS, beam=4, scenarios=scenarios)
        self.assertTrue(detail["unavailable"], "枚举不出来的技能必须记进 unavailable")
        named = [row for row in detail["unavailable"] if row.get("skill_id") == "skill_999999"]
        self.assertEqual(len(named), 1, "点名技能必须逐条出现")
        self.assertTrue(any("一个动作都枚举不出来" in row.get("why", "")
                            for row in detail["unavailable"]),
                        "整条情景枚举不出动作也要留痕（只报总数会看不出来）")

    def test_plan_result_carries_detail_only_when_injected(self):
        state_a, _ = public_state()
        state_b, _ = public_state()
        scenario = [{"scenario_id": "s1", "kind": "stay_defense"}]
        injected = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800,
                                   clock=lambda: 0.0, opponent_scenarios=scenario).to_dict()
        default = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800,
                                  clock=lambda: 0.0).to_dict()
        self.assertIn("opponent_model_detail", injected)
        self.assertNotIn("opponent_model_detail", default)
        detail = injected["opponent_model_detail"]
        self.assertEqual(detail["is_probability"], False)
        self.assertEqual(detail["scenario_ids"], ["s1"])

    def test_pending_enemy_is_never_read(self):
        """硬红线：把「对手已提交动作」种进重建状态，输出必须一个字都不变。"""
        state_a, _ = public_state()
        state_b, _ = public_state()
        scenario = [{"scenario_id": "s1", "kind": "stay_defense"}]
        baseline = pm.plan_actions(state_a, RS, depth=2, beam=2, budget_ms=800,
                                   clock=lambda: 0.0, opponent_scenarios=scenario).to_dict()
        setattr(state_b, "_pending_enemy", "PLANTED-HIDDEN-ACTION")
        planted = pm.plan_actions(state_b, RS, depth=2, beam=2, budget_ms=800,
                                  clock=lambda: 0.0, opponent_scenarios=scenario).to_dict()
        self.assertEqual(canon(baseline), canon(planted),
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

        default = pm.plan_actions(state_a, RS, depth=2, beam=3, budget_ms=800,
                                  clock=lambda: 0.0).to_dict()
        injected = pm.plan_actions(state_b, RS, depth=2, beam=3, budget_ms=800,
                                   clock=lambda: 0.0,
                                   opponent_scenarios=[{"scenario_id": "s1", "kind": "stay_attack",
                                                        "skill_ids": enemy_skills[:1]}]).to_dict()
        default_set = opponent_branch_set(default)
        injected_set = opponent_branch_set(injected)
        self.assertTrue(injected_set, "注入路径必须给出对手分支（risk.top_risks 不为空）")
        self.assertTrue(injected_set <= allowed,
                        f"注入后的对手分支必须落在情景枚举集合 {allowed} 里，实际 {injected_set}")
        self.assertNotEqual(default_set, injected_set,
                            f"注入必须真的改变对手分支集：缺省 {default_set} vs 注入 {injected_set}")


class ServiceInjectionTest(unittest.TestCase):
    """④ `/battle/plan` 的注入契约：可选、fail closed、依据回显、两类依据分开写。"""

    def setUp(self):
        self.svc, self.public = service_public()

    # ── 缺省 vs 注入 ────────────────────────────────────────────────

    def test_default_request_has_no_basis_block(self):
        status, env = self.svc.battle_plan(plan_body(self.public))
        self.assertEqual(status, 200, env.get("error"))
        self.assertNotIn("opponent_basis", env["result"])
        assert_canon(self, scrub_latency(env["result"]), SERVICE_DEFAULT_CANON,
                     "不带 opponent_scenarios 的回执")

    def test_empty_injection_keeps_plan_and_labels_default(self):
        """显式给空集合：计划逐字段不变，只多一栏「依据 = 规范配招假设(缺省)」。"""
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[]))
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        basis = payload["opponent_basis"]
        self.assertEqual(basis["source"], "default_candidate_moveset")
        self.assertEqual(basis["label"], "本次对手依据 = 规范配招假设(缺省)")
        self.assertIs(basis["is_probability"], False)
        self.assertIsNone(basis["scenario_driven"])
        without = {k: v for k, v in payload.items() if k != "opponent_basis"}
        assert_canon(self, scrub_latency(without), SERVICE_DEFAULT_CANON,
                     "空注入时除 opponent_basis 外的回执")

    def test_injected_basis_and_scenario_actions(self):
        attack = enemy_skill_ids(self.public, defenses=False)
        self.assertTrue(attack, "夹具里对手应当有攻击技能")
        expected_label = RS.skills[attack[0]].name
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": [attack[0]],
             "evidence_ids": ["view.opponent.revealed_skills"]},
            {"scenario_id": "s2", "kind": "stay_defense"},
        ]))
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        basis = payload["opponent_basis"]
        self.assertEqual(basis["source"], "injected_scenarios")
        self.assertEqual(basis["label"], "本次对手依据 = 注入情景")
        self.assertIs(basis["is_probability"], False)
        driven = basis["scenario_driven"]
        self.assertEqual(driven["scenario_ids"], ["s1", "s2"], "情景必须按 scenario_id 定序")
        self.assertEqual(driven["kinds"], ["stay_attack", "stay_defense"])
        self.assertEqual(driven["weights"], "uniform_baseline")
        self.assertIs(driven["is_probability"], False)
        self.assertIn("不是概率", driven["basis"])
        self.assertEqual(sorted(driven["evidence_ids"]), ["view.opponent.revealed_skills"])
        for key, rows in driven["actions_by_seed"].items():
            self.assertIn(key, [str(s) for s in PLAN_SEEDS], "逐种子留痕必须按分析种子分组")
            self.assertTrue(rows, f"种子 {key} 至少要枚举出一个情景动作")
            for row in rows:
                self.assertEqual(row["kind"], "scenario")
                self.assertIn(row["scenario_id"], ("s1", "s2"))
            self.assertIn(expected_label, [row["action"] for row in rows],
                          "情景点名的技能必须出现在 enumerated_actions 里")
        self.assertEqual(driven["enumerated_by_seed"], {str(s): driven["enumerated_by_seed"][str(s)]
                                                        for s in PLAN_SEEDS})
        # 逐种子细节与 planner 的 detail 是同一份（不是重新编一遍）
        self.assertEqual(payload["per_seed"][0]["opponent_model_detail"]["scenario_ids"],
                         driven["scenario_ids"])
        # 注入时信封的 limitations 要点名依据栏（缺省时不许有这一条）
        limitations = env.get("limitations") or []
        self.assertTrue(any("opponent_basis" in line for line in limitations),
                        "注入时 limitations 必须指向依据栏")

    def test_injection_moves_opponent_branches(self):
        """dispatch 级有牙判据：注入改变**对手分支集**，且落在情景枚举集合内。"""
        state = renv.state_from_public_planner(self.public, RS, analysis_seed=11)
        attack = enemy_skill_ids(self.public, defenses=False)
        self.assertTrue(attack)
        parsed = pm.parse_opponent_scenarios([
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": [attack[0]]}])
        dist, detail = pm.opponent_scenario_distribution(state, RS, beam=PLAN_BEAM, scenarios=parsed)
        allowed = {pm._label(RS, a) for a, _w in dist}
        self.assertTrue(allowed)

        status_d, env_d = self.svc.battle_plan(plan_body(self.public))
        status_i, env_i = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": [attack[0]]}]))
        self.assertEqual((status_d, status_i), (200, 200))
        default_set = opponent_branch_union(env_d["result"])
        injected_set = opponent_branch_union(env_i["result"])
        self.assertEqual(injected_set, allowed,
                         f"注入后的对手分支集必须**就是**情景枚举集合 {allowed}，实际 {injected_set}")
        self.assertNotEqual(default_set, injected_set,
                            f"注入必须真的改变对手分支集：缺省 {default_set} vs 注入 {injected_set}")
        # 注入时 per_seed 里必须带 planner 的 detail（dispatch 真的把场景传下去了）
        self.assertTrue(env_i["result"]["per_seed"][0].get("opponent_model_detail"))
        self.assertNotIn("opponent_model_detail", env_d["result"]["per_seed"][0])

    # ── 形状 fail closed ───────────────────────────────────────────

    def test_bad_shapes_are_400_and_name_the_row(self):
        cases = [
            ({"scenario_id": "a"}, "opponent_scenarios 必须是数组"),
            (["a"], "opponent_scenarios[0] 必须是对象"),
            ([{"kind": "stay_attack"}], "opponent_scenarios[0].scenario_id"),
            ([{"scenario_id": "a", "kind": "whatever"}], "opponent_scenarios[0].kind"),
            ([{"scenario_id": "a", "kind": "stay_attack"},
              {"scenario_id": "b", "kind": "stay_defense", "weight": 3}],
             "opponent_scenarios[1] 不许带 weight"),
            ([{"scenario_id": "a", "kind": "stay_attack", "probability": 0.5}],
             "opponent_scenarios[0] 不许带 probability"),
            ([{"scenario_id": "a", "kind": "stay_attack", "share": 0.5}],
             "opponent_scenarios[0] 不许带 share"),
            ([{"scenario_id": "a", "kind": "stay_attack", "p": 0.5}],
             "opponent_scenarios[0] 不许带 p"),
            ([{"scenario_id": "a", "kind": "stay_attack"},
              {"scenario_id": "a", "kind": "stay_defense"}], "scenario_id 重复"),
        ]
        for raw, needle in cases:
            status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=raw))
            self.assertEqual(status, 400, f"{needle} 必须 400 fail closed：{env.get('error')}")
            self.assertEqual(env["error_type"], "bad_request")
            self.assertIn(needle, env["error"] or "",
                          "错误必须点名坏在哪一条（不许只说「形状不对」）")

    def test_scenario_rows_cannot_smuggle_hidden_truth(self):
        """情景行不许当隐藏真值的后门：带隐藏键一律 400。"""
        for key in ("pending_enemy", "true_seed", "opponent_pending_action"):
            status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
                {"scenario_id": "s1", "kind": "stay_attack", key: 1}]))
            self.assertEqual(status, 400, f"{key} 必须被拒：{env.get('error')}")
            self.assertEqual(env["error_type"], "hidden_information")

    # ── P3：缺什么如实报 + 两类依据分开写 ─────────────────────────────

    def test_unavailable_skill_is_reported_and_promoted_to_unsupported(self):
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": ["skill_999999"]}]))
        self.assertEqual(status, 200, env.get("error"))
        driven = env["result"]["opponent_basis"]["scenario_driven"]
        rows = [r for r in driven["unavailable"] if r.get("skill_id") == "skill_999999"]
        self.assertEqual(len(rows), 1, "情景点名但枚举不出的技能必须逐条点名")
        self.assertEqual(driven["enumerated_by_seed"]["11"], 0)
        reasons = [u.get("reason", "") for u in env.get("unsupported", [])]
        self.assertTrue(any("枚举不出来" in r for r in reasons),
                        f"候选不全必须进 unsupported（不许悄悄降级）：{reasons}")

    def test_kind_mismatch_and_unknown_species_are_registered(self):
        defense = enemy_skill_ids(self.public, defenses=True)
        self.assertTrue(defense, "夹具里对手应当有防御技能")
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": [defense[0]]}]))
        self.assertEqual(status, 200, env.get("error"))
        rows = env["result"]["opponent_basis"]["scenario_driven"]["unavailable"]
        self.assertTrue(any(r.get("skill_id") == defense[0] and "不符" in r.get("why", "")
                            for r in rows), f"类别不符必须登记：{rows}")

        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "switch_in_seen", "slots": [1],
             "species_ids": [B_TEAM[1]]}]))
        self.assertEqual(status, 200, env.get("error"))
        driven = env["result"]["opponent_basis"]["scenario_driven"]
        self.assertTrue(any(r.get("species_id") == B_TEAM[1] for r in driven["unavailable"]),
                        f"情景点名的物种不在重建队列里必须登记：{driven['unavailable']}")
        self.assertIn("换上第2位", driven["actions_by_seed"]["11"][0]["action"],
                      "换人动作本身可枚举，不许因为物种对不上就整条丢掉")

    def test_p3_separates_scenario_and_assumption(self):
        attack = enemy_skill_ids(self.public, defenses=False)
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[
            {"scenario_id": "s1", "kind": "stay_attack", "skill_ids": [attack[0]]}]))
        self.assertEqual(status, 200, env.get("error"))
        basis = env["result"]["opponent_basis"]
        driven = basis["scenario_driven"]
        assumed = basis["assumption_driven"]
        # 两类依据是**两栏**，键集不许互相混
        self.assertIsInstance(driven, dict)
        self.assertIsInstance(assumed, dict)
        self.assertEqual(set(driven) & set(assumed), set(), "两类依据不许共用键名（混写）")
        # scenario-driven：情感点名的技能
        self.assertEqual([row["action"] for row in driven["actions_by_seed"]["11"]],
                         [RS.skills[attack[0]].name])
        # assumption-driven：满血 + 规范配招假设**仍然生效**
        self.assertIs(assumed["still_in_effect"], True)
        self.assertEqual(assumed["opponent_bench"], renv.OPPONENT_BENCH_ASSUMPTION)
        self.assertIn("candidate_moveset", assumed["opponent_moveset"])
        self.assertIn("规范配招", assumed["opponent_moveset"])
        self.assertEqual(assumed["public_assumptions"], self.public.get("assumptions"))
        # P3 残留：显式登记「换成可学池」没做 + 自带两条判据
        p3 = [r for r in basis["residuals"] if r.get("id") == "P3"]
        self.assertEqual(len(p3), 1, "P3 残留必须显式登记")
        self.assertEqual(p3[0]["status"], "not_done")
        self.assertIn("candidate_moveset", p3[0]["replaces"])
        self.assertEqual(len(p3[0]["criteria"]), 2, "残留必须自带「隐藏真值不变 + 只吃公开面」两条判据")
        joined = " ".join(p3[0]["criteria"])
        self.assertIn("隐藏真值不变", joined)
        self.assertIn("只吃公开面", joined)
        # 缺省请求也带残留登记（假设在缺省路径同样生效）
        status, env = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=[]))
        self.assertEqual(status, 200, env.get("error"))
        self.assertEqual([r["id"] for r in env["result"]["opponent_basis"]["residuals"]], ["P3"])
        self.assertIs(env["result"]["opponent_basis"]["assumption_driven"]["still_in_effect"], True)

    # ── 隐藏真值 ────────────────────────────────────────────────────

    def test_planted_hidden_values_in_public_do_not_change_receipt(self):
        """同形判据：把隐藏真值（后备血量/配招、未知键）混进公开面 ⇒ 回执逐字段不变。

        与 planner 级的 `test_pending_enemy_is_never_read` 是一对：
        那里种的是**重建后的状态**，这里种的是**请求里的公开面**。
        """
        scenario = [{"scenario_id": "s1", "kind": "stay_defense"}]
        status_a, env_a = self.svc.battle_plan(plan_body(self.public, opponent_scenarios=scenario))
        self.assertEqual(status_a, 200, env_a.get("error"))

        planted = json.loads(json.dumps(self.public))
        planted["opponent"]["bench"] = [
            dict(row, hp=999, max_hp=999, loadouts=["skill_999999"], energy=99)
            for row in planted["opponent"].get("bench", [])
        ]
        planted["opponent"]["field"]["hidden_hp"] = 1
        planted["self"]["pets"] = [dict(row, hidden_atk=999, true_stats={"atk": 999})
                                   for row in planted["self"]["pets"]]
        planted["hidden_note"] = "PLANTED"
        status_b, env_b = self.svc.battle_plan(plan_body(
            planted, opponent_scenarios=scenario))
        self.assertEqual(status_b, 200, env_b.get("error"))
        assert_canon(self, scrub_latency(env_b["result"]),
                     canon(scrub_latency(env_a["result"])),
                     "公开面里混入隐藏真值后的回执")

    def test_named_hidden_keys_in_request_are_rejected(self):
        for key in ("seed", "_pending_enemy", "pending_enemy", "opponent_pending_action"):
            body = plan_body(self.public)
            body["public"] = dict(self.public, **{key: 12345})
            status, env = self.svc.battle_plan(body)
            self.assertEqual(status, 400, f"{key} 必须被拒：{env.get('error')}")
            self.assertEqual(env["error_type"], "hidden_information")


def opponent_branch_set(plan_dict):
    """一手规划里**对手动作**的标签集合（来自 `risk.top_risks`）。"""
    return {str(row.get("opponent_action")) for row in plan_dict.get("risk", {}).get("top_risks", [])}


if __name__ == "__main__":
    unittest.main(verbosity=2)
