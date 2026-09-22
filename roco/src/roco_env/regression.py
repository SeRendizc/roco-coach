"""RC-404：**代表性回归集** —— 用脚本化的对局把「哪条机制真的被驱动过」变成可复核的事实。

为什么需要它
------------
到上一轮为止，引擎的能力声明散在三处：`coverage.py`（技能/特性解析覆盖）、`support.py`
（精灵支持等级）、以及各测试文件里的零散用例。它们都回答不了产品与迁移最关心的那一个问题：
**「这条机制到底有没有被真的跑起来过一次」**。

`greedy_damage` 对 `greedy_damage` 的镜像对局只能压出 14 种事件，印记、天气、应对、持续状态
这几类根本不会出现（实测）。所以这里的做法是**脚本化**：每个场景写死「这一回合必须出哪一类技能」，
并声明它**期望看到**的事件；跑完如果那条证据没出现，场景就是**空转**——必须如实报出来。

两条纪律
--------
1. **空转不许算通过**：每个场景声明 `expect_kinds`，跑完逐条核对；没出现就是问题。
2. **不可达要如实登记**：某条机制在引擎里根本驱动不了（或数据里没有能学到它的精灵），
   就进 `unreachable[]` 并写明原因——「没有出现在报告里」与「登记为不可达」是两件事。

指纹：`state_digest`（终局序列化摘要）+ `event_kinds`（计数）+ `key_events`（前若干条关键事件）。
`--check` 用它做回归比对（改了引擎却忘了看这批场景，这里会红）。
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List, Optional

from . import env as env_mod
from . import opponents as opp
from . import parse as parse_mod

#: 标准 PVP 的两条未核验覆盖（与服务端常量同一口径）。
STANDARD_OVERRIDES = [
    {"path": "energy.initial", "value": 2, "confidence": "ENGINE_HYPOTHESIS",
     "reason": "MC-E04 未录制（练习局口径）", "microcase_id": "MC-E04"},
    {"path": "turn_order.speed_tie", "value": "random_seeded", "confidence": "ENGINE_HYPOTHESIS",
     "reason": "MC-E05 未录制（已登记的工程权宜）", "microcase_id": "MC-E05"},
]

V3 = "mobile_s4_candidate_v3"
LEGACY = "legacy_sim_v1"


def _ids(rs, names: List[str]) -> List[str]:
    return [rs.pets_by_name(n)[0].pet_id for n in names]


def _find_lead(rs: Any, wanted: Any, exclude: List[str]) -> "tuple[Optional[str], Optional[str]]":
    """找一个**配招里真的带着这条机制**的精灵当首发（学得到 ≠ 带得上场）。

    `wanted` 是解析出来的效果类型（例如 `["self_mark","foe_mark"]`），**不是** desc 里的词。

    为什么要自动找：`legal_actions` 只给该精灵**规范配招**里的技能，而「学得会」和
    「这一局带没带」是两件事——按 desc 找技能而不看配招，场景就会空转（实测踩到：
    mark/weather/status 三个场景的选择器一次都没命中）。
    冻结层的精灵优先（它们的配招是已核验的），找不到再退到按需推算的那批。
    """
    wanted = set(wanted)
    candidates = []
    for tier in ("FULL_VERIFIED", "SIMULATABLE_UNVERIFIED"):
        for pet in sorted(rs.pets.values(), key=lambda p: p.pet_id):
            if rs.build_support_of(pet.pet_id) != tier or pet.pet_id in exclude:
                continue
            for sid in rs.candidate_moveset(pet.pet_id) or ():
                skill = rs.skills.get(sid)
                if skill is None:
                    continue
                # 按**解析出的效果类型**找，而不是按 desc 里的词：实测「印记」会先命中
                # 「驱散敌方所有印记」（翅刃）——那是**反着**的机制，场景会空转。
                kinds = {e.kind for e in parse_mod.parse_skill(skill).effects}
                if kinds & wanted:
                    # **能耗越低越优先**：场景要的是「这条机制真的被驱动过一次」，
                    # 一条 8 能耗的技能在 25 回合里可能一次都放不出来（实测踩到）。
                    candidates.append(((0 if tier == "FULL_VERIFIED" else 1,
                                        int(skill.energy or 0), pet.pet_id, sid), pet.pet_id, sid))
    if not candidates:
        return None, None
    _, pet_id, sid = min(candidates, key=lambda row: row[0])
    return pet_id, sid


#: 场景表。`pick` 是「这一侧这一回合优先出哪一类技能」的选择器：
#:   {"contains": "印记"} —— 描述里含这个词的技能；{"kind": "charge"} —— 聚能；
#:   {"kind": "switch"} —— 换人；None —— 第一个合法动作。
#: `expect_kinds` 是**必须真的出现**的证据；`dimension` 用来统计维度覆盖。
SCENARIOS: List[Dict[str, Any]] = [
    {"id": "damage-type-advantage", "dimension": "属性/伤害",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     "seed": 11, "config": V3, "overrides": True, "turns": 30, "expect_kinds": ["damage", "turn_start"]},
    {"id": "defense-branch", "dimension": "防御",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     "seed": 12, "config": V3, "overrides": True, "turns": 30,
     "pick_a": {"category": "防御"}, "expect_kinds": ["damage"]},
    {"id": "energy-and-charge", "dimension": "资源（能量/聚能）",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     # v3 的 `energy.regen.per_turn` 是 **0**（候选口径：回能只来自技能/特性/道具），
     # 所以这条场景期望的是聚能与「技能自带回能」，**不**期望回合末回能。
     "seed": 13, "config": V3, "overrides": True, "turns": 20,
     "pick_a": {"kind": "charge"}, "expect_kinds": ["charge"]},
    {"id": "faint-and-mana", "dimension": "力竭/魔力",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     "seed": 14, "config": V3, "overrides": True, "turns": 60,
     "expect_kinds": ["faint", "mana_loss"]},
    {"id": "replacement", "dimension": "换入离场",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     "seed": 15, "config": V3, "overrides": True, "turns": 40,
     "expect_kinds": ["replacement"]},
    {"id": "mark", "dimension": "印记",
     "team_a": ["画间沉铁兽", "寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃"],
     "team_b": ["秩序鱿墨", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫", "音速犬"],
     "seed": 16, "config": V3, "overrides": True, "turns": 25,
     "find_lead": ["self_mark", "foe_mark"], "expect_kinds": ["damage"]},
    {"id": "weather", "dimension": "天气",
     "team_a": ["雪影娃娃", "寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "音速犬"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"],
     "seed": 17, "config": V3, "overrides": True, "turns": 25,
     "find_lead": ["weather"], "expect_kinds": ["damage"]},
    {"id": "status", "dimension": "持续状态",
     "team_a": ["卡卡虫", "寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃"],
     "team_b": ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "音速犬"],
     "seed": 18, "config": V3, "overrides": True, "turns": 25,
     "find_lead": ["foe_status"], "expect_kinds": ["damage"]},
    {"id": "legacy-practice-3v3", "dimension": "迁移夹具（legacy 逐位不变）",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师"], "team_b": ["圆号鱼", "雪影娃娃", "音速犬"],
     "seed": 19, "config": LEGACY, "overrides": False, "turns": 20,
     "expect_kinds": ["damage", "turn_start"]},
]


def _select_action(state, rs, side: str, pick: Optional[Dict[str, Any]]):
    """按选择器挑一个**合法**动作；挑不到就用第一个合法动作（并由调用方统计命中率）。"""
    legal = env_mod.legal_actions(state, rs, side)
    if not legal:
        return None, False
    if not pick:
        return legal[0], True
    kind = pick.get("kind")
    contains = pick.get("contains")
    skill_id = pick.get("skill_id")
    category = pick.get("category")
    for action in legal:
        if kind and action.kind == kind:
            return action, True
        if skill_id and action.kind == "skill" and action.skill_id == skill_id:
            return action, True
        if category and action.kind == "skill":
            skill = rs.skills.get(action.skill_id or "")
            if skill is not None and skill.category == category:
                return action, True
        if contains and action.kind == "skill":
            skill = rs.skills.get(action.skill_id or "")
            if skill is not None and contains in (skill.desc or ""):
                return action, True
    return legal[0], False


def run_scenario(rs: Any, scenario: Dict[str, Any]) -> Dict[str, Any]:
    """跑一个场景，返回它的证据与指纹。**空转（期望证据没出现）会被如实记进 problems**。"""
    cfg = scenario.get("config", V3)
    overrides = STANDARD_OVERRIDES if scenario.get("overrides") else None
    team_a = _ids(rs, scenario["team_a"])
    team_b = _ids(rs, scenario["team_b"])
    lead_pet = lead_skill = None
    unresolved: List[str] = []
    # 「找一个带这条机制的精灵当首发」：学得到不算，要**带得上场**（在规范配招里）。
    if scenario.get("find_lead"):
        wanted = scenario["find_lead"]
        lead_pet, lead_skill = _find_lead(rs, wanted if isinstance(wanted, list) else [wanted], list(team_b))
        if lead_pet is None:
            unresolved.append(f"数据里没有任何精灵的**规范配招**带 {wanted} 这类效果——这一条不可达")
        else:
            team_a = [lead_pet] + [pid for pid in team_a if pid != lead_pet][:5]
    state = env_mod.reset(team_a, team_b, seed=int(scenario["seed"]), rs=rs,
                          config=cfg, unverified_overrides=overrides)
    kinds: Dict[str, int] = {}
    used_skills: List[str] = []
    key_events: List[Dict[str, Any]] = []
    picks_hit = 0
    picks_total = 0
    steps = 0
    while steps < int(scenario.get("turns", 30)) and not state.result:
        if state.phase == "replace":
            side = state.replace_queue[0]
            bench = getattr(state, side).bench_indices()
            env_mod.step_replace(state, rs, side, bench[0])
            steps += 1
            continue
        # 自动选到的首发：这一手就出那条技能（否则场景没驱动到它想驱动的机制）
        pick_a = scenario.get("pick_a")
        # 首发在场就**一直**优先出那条技能（第一回合可能能量不够，挑不到就按常规走，
        # 但后面总会有一次出得来 —— 「用出来过一次」才是这条场景的证据）。
        if lead_skill and state.player.field_pet.pet_id == lead_pet:
            pick_a = {"skill_id": lead_skill}
        a, hit_a = _select_action(state, rs, "player", pick_a)
        b, hit_b = _select_action(state, rs, "enemy", scenario.get("pick_b"))
        if a is None or b is None:
            break
        picks_total += 1
        picks_hit += 1 if (hit_a and hit_b) else 0
        if a.kind == "skill" and a.skill_id:
            used_skills.append(a.skill_id)
        state = env_mod.step_joint(state, rs, a, b)
        steps += 1
    for event in state.events:
        kind = getattr(event, "kind", None)
        kinds[kind] = kinds.get(kind, 0) + 1
        if len(key_events) < 12 and kind in set(scenario.get("expect_kinds", [])):
            key_events.append({"kind": kind, "turn": getattr(event, "turn", None),
                               "side": getattr(event, "side", None)})
    problems = [] if unresolved and len(unresolved) == 1 and unresolved[0].startswith("数据里没有任何精灵") \
        else list(unresolved)
    for want in scenario.get("expect_kinds", []):
        if kinds.get(want, 0) == 0:
            problems.append(f"期望证据没有出现：{want}（这一条场景是空转的）")
    # 「真的用出了那条技能」是最直接的证据：用出来才算驱动到了机制。
    wanted_skill_desc = scenario.get("find_lead")
    if wanted_skill_desc and lead_skill:
        if lead_skill not in used_skills:
            problems.append(f"首发那条技能（{lead_skill}）一次都没用出来：场景没驱动到「{wanted_skill_desc}」")
    if scenario.get("pick_a") and picks_hit == 0:
        problems.append("选择器一次都没命中：这条场景没有真的驱动到它想驱动的机制")
    return {
        "id": scenario["id"], "dimension": scenario["dimension"], "config": cfg,
        "seed": scenario["seed"], "steps": steps, "result": state.result,
        "lead_pet": lead_pet, "lead_skill": lead_skill, "used_skills": sorted(set(used_skills)),
        "event_kinds": dict(sorted(kinds.items())),
        "state_digest": hashlib.sha256(
            json.dumps(env_mod.serialize(state), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest(),
        "key_events": key_events,
        "pick_hit_rate": round(picks_hit / picks_total, 4) if picks_total else None,
        "problems": problems,
        "unreachable": unresolved,
        "unreachable": unresolved,
        "status": "unreachable" if unresolved else "reachable",
    }


def build_regression_set(rs: Any, scenarios: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """跑整套场景，产出可复核的回归集（确定性：同样的输入 ⇒ 同样的指纹）。"""
    scenarios = scenarios if scenarios is not None else SCENARIOS
    results = [run_scenario(rs, scenario) for scenario in scenarios]
    dimensions = sorted({row["dimension"] for row in results})
    problems = [f"{row['id']}：{p}" for row in results for p in row["problems"]]
    unreachable = [f"{row['id']}：{row['unreachable'][0]}" for row in results if row.get("unreachable")]
    unreachable = [f"{row['id']}：{row['unreachable'][0]}" for row in results if row.get("unreachable")]
    return {
        "schema": "roco-regression-set/v1",
        "rc": "RC-404",
        "generated_by": "roco/src/roco_env/regression.py",
        "ruleset_id": rs.ruleset_id,
        "why": "镜像对局只能压出 14 种事件，印记/天气/应对/持续状态根本不会出现。"
               "本集用**脚本化**对局逐条驱动机制，并声明每条的期望证据 —— 没出现就算空转，如实报出来。",
        "totals": {"scenarios": len(results), "dimensions": len(dimensions),
                   "scenarios_with_problems": sum(1 for row in results if row["problems"])},
        "dimensions": dimensions,
        "problems": problems,
        "unreachable": unreachable,
        "known_limits": [
            "场景只覆盖**能驱动得了**的机制；驱动不了的要登记进 unreachable，而不是当作通过",
            "指纹绑定当前引擎与规则配置：引擎一改，这里应当红 —— 那是它的用途，不是障碍",
            "对局用引擎自己的策略或固定选择器，**不**代表最优打法",
        ],
        "scenarios": results,
    }


def check_against(regression: Dict[str, Any], fresh: Dict[str, Any]) -> List[str]:
    """把磁盘上的回归集与「现在重跑」的结果比：任何指纹或证据变化都要如实报出来。"""
    problems = []
    old = {row["id"]: row for row in regression.get("scenarios", [])}
    new = {row["id"]: row for row in fresh.get("scenarios", [])}
    for missing in sorted(set(old) - set(new)):
        problems.append(f"场景 {missing} 消失了（指纹表里还有它）")
    for added in sorted(set(new) - set(old)):
        problems.append(f"场景 {added} 是新的：请重新生成指纹表")
    for sid in sorted(set(old) & set(new)):
        if old[sid]["state_digest"] != new[sid]["state_digest"]:
            problems.append(f"场景 {sid} 的终局指纹变了：{old[sid]['state_digest'][:12]} → {new[sid]['state_digest'][:12]}")
        if old[sid]["event_kinds"] != new[sid]["event_kinds"]:
            problems.append(f"场景 {sid} 的事件分布变了：{old[sid]['event_kinds']} → {new[sid]['event_kinds']}")
    return problems


def write_report(rs: Any, path: str) -> Dict[str, Any]:
    report = build_regression_set(rs)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    return report


def _main() -> int:  # pragma: no cover - CLI 入口
    import argparse

    from . import data as data_mod

    parser = argparse.ArgumentParser(description="RC-404 代表性回归集")
    parser.add_argument("--out", default=os.path.join("reports", "roco", "rc404", "regression-set.json"))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rs = data_mod.load_ruleset()
    fresh = build_regression_set(rs)
    if args.check:
        if not os.path.exists(args.out):
            print(f"指纹表不存在：{args.out}（先跑一次不带 --check 的生成）")
            return 1
        with open(args.out, "r", encoding="utf-8") as fh:
            committed = json.load(fh)
        problems = check_against(committed, fresh)
        for row in problems:
            print(f"✖ {row}")
        print("✔ 回归集与磁盘上的指纹一致" if not problems else f"问题 {len(problems)} 条")
        return 1 if problems else 0
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(fresh, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    if args.json:
        print(json.dumps({"totals": fresh["totals"], "problems": fresh["problems"]}, ensure_ascii=False, indent=1))
    else:
        print(f"场景 {fresh['totals']['scenarios']} 条，维度 {fresh['totals']['dimensions']} 个；"
              f"有问题的场景 {fresh['totals']['scenarios_with_problems']} 条")
        for row in fresh["scenarios"]:
            flag = "✖" if row["problems"] else "✔"
            print(f"  {flag} {row['id']}（{row['dimension']}）：{row['event_kinds']}")
        for row in fresh["problems"]:
            print(f"    ✖ {row}")
        print(f"指纹表 → {args.out}")
    return 1 if fresh["problems"] else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
