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

#: 标准 PVP 需要的未核验覆盖（与服务端常量同一口径）。
#: 2026-09-22：`energy.initial` 已按用户实机核对登记为 10 星（RECORDED_IN_GAME），从表里拿掉。
STANDARD_OVERRIDES = [
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
    {"id": "speed-order", "dimension": "速度层次",
     # 冻结层里最快（130）与最慢（40）对位：更快的那一方应当在多数回合先造成伤害。
     "team_a": ["秩序鱿墨", "寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃"],
     "team_b": ["女王蜂", "花魁蜂后", "音速犬", "卡卡虫", "权杖-V", "迷迷箱怪"],
     "seed": 20, "config": V3, "overrides": True, "turns": 25,
     "expect_kinds": ["damage"], "expect_first_damage": "player"},
    {"id": "speed-tie", "dimension": "同速平手（候选口径）",
     # 双方首发同一只 → 同速；(应对/先手度/速度) 全同 ⇒ 必须有裁决依据。
     # v3 里那条依据是**显式覆盖**的 `random_seeded`（MC-E05 未录制）；这里只要它**不抛错**、
     # 且顺序可复现（指纹比对就是判据）。
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "team_b": ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"],
     "seed": 22, "config": V3, "overrides": True, "turns": 20,
     "expect_kinds": ["damage"]},
    {"id": "legacy-practice-3v3", "dimension": "迁移夹具（legacy 逐位不变）",
     "team_a": ["寂灭骨龙", "海豹船长", "黑猫巫师"], "team_b": ["圆号鱼", "雪影娃娃", "音速犬"],
     "seed": 19, "config": LEGACY, "overrides": False, "turns": 20,
     "expect_kinds": ["damage", "turn_start"]},
]


#: 属性扫描的对手队伍 id（生成场景时用来避让；在 `build_regression_set` 里惰性填充）。
SWEEP_IDS: "set[str]" = set()


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
    element = pick.get("element")
    for action in legal:
        if kind and action.kind == kind:
            return action, True
        if skill_id and action.kind == "skill" and action.skill_id == skill_id:
            return action, True
        if category and action.kind == "skill":
            skill = rs.skills.get(action.skill_id or "")
            if skill is not None and skill.category == category:
                return action, True
        if element and action.kind == "skill":
            skill = rs.skills.get(action.skill_id or "")
            if skill is not None and skill.element == element:
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
    type_multipliers: List[float] = []
    # 每回合**先造成伤害**的一方（速度层次的证据：更快的先动手）
    first_damage_by_turn: Dict[int, str] = {}
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
        # 属性扫描的证据：玩家这一侧每次伤害的相性倍率（1.0 = 中性；缺字段就不记）
        # 注意：`Event` 只有 kind/turn/detail/evidence —— 侧别与倍率都在 `detail` 里
        # （`_bump(state, "damage", {"side": …, "type_multiplier": …})`）。
        detail = getattr(event, "detail", None) or {}
        if kind == "damage" and isinstance(detail, dict):
            turn = getattr(event, "turn", None)
            if isinstance(turn, int) and turn not in first_damage_by_turn:
                first_damage_by_turn[turn] = str(detail.get("side") or "?")
        if kind == "damage" and isinstance(detail, dict) and detail.get("side") == "player":
            value = detail.get("type_multiplier")
            if isinstance(value, (int, float)):
                type_multipliers.append(round(float(value), 4))
        if len(key_events) < 12 and kind in set(scenario.get("expect_kinds", [])):
            key_events.append({"kind": kind, "turn": getattr(event, "turn", None),
                               "side": (detail.get("side") if isinstance(detail, dict) else None)})
    problems = [] if unresolved and len(unresolved) == 1 and unresolved[0].startswith("数据里没有任何精灵") \
        else list(unresolved)
    for want in scenario.get("expect_kinds", []):
        if kinds.get(want, 0) == 0:
            problems.append(f"期望证据没有出现：{want}（这一条场景是空转的）")
    # 「真的用出了那条技能」是最直接的证据：用出来才算驱动到了机制。
    # 速度层次：声明的「谁更快」必须在多数回合里体现为「它先造成伤害」。
    expect_first = scenario.get("expect_first_damage")
    if expect_first:
        hits = sum(1 for side in first_damage_by_turn.values() if side == expect_first)
        total = len(first_damage_by_turn)
        if total == 0 or hits < max(1, total // 2):
            problems.append(f"期望「{expect_first}」先造成伤害，实际 {hits}/{total} 回合"
                            f"（{first_damage_by_turn}）——速度层次没被驱动")
    wanted_skill_desc = scenario.get("find_lead")
    if wanted_skill_desc and lead_skill:
        if lead_skill not in used_skills:
            problems.append(f"首发那条技能（{lead_skill}）一次都没用出来：场景没驱动到「{wanted_skill_desc}」")
    # 「选择器必须命中」只对**声明了 find_lead 或显式要求**的场景成立：
    # 属性扫描的期望是「这种属性的伤害真的算过」（由 `type_multipliers` 核实），
    # 不是「每一手都命中」——一条高能耗的龙系技能可能整局都没轮上（实测）。
    if (scenario.get("find_lead") or scenario.get("require_pick_hit")) and picks_hit == 0:
        problems.append("选择器一次都没命中：这条场景没有真的驱动到它想驱动的机制")
    return {
        "id": scenario["id"], "dimension": scenario["dimension"], "config": cfg,
        "seed": scenario["seed"], "steps": steps, "result": state.result,
        "lead_pet": lead_pet, "lead_skill": lead_skill, "used_skills": sorted(set(used_skills)),
        "type_multipliers": type_multipliers,
        "first_damage_by_turn": {str(k): v for k, v in sorted(first_damage_by_turn.items())},
        "event_kinds": dict(sorted(kinds.items())),
        "state_digest": hashlib.sha256(
            json.dumps(env_mod.serialize(state), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest(),
        "key_events": key_events,
        "pick_hit_rate": round(picks_hit / picks_total, 4) if picks_total else None,
        "problems": problems,
        "unreachable": unresolved,
        "status": "unreachable" if unresolved else "reachable",
    }


#: 全量数据里登记的 18 个单属性。扫描对每一种都跑一条场景 —— 证明「这种属性的伤害真的会结算」。
TYPE_SWEEP_TYPES = ("光系", "冰系", "地系", "幻系", "幽系", "恶系", "普通系", "机械系",
                    "武系", "毒系", "水系", "火系", "电系", "翼系", "草系", "萌系", "虫系", "龙系")

#: 属性扫描的统一对手（固定队伍，避免每次换对手导致指纹无法比较）。
SWEEP_OPPONENT = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]


def _find_element_lead(rs: Any, element: str) -> "tuple[Optional[str], Optional[str]]":
    """找一个**规范配招里有该属性技能**的精灵（学得到 ≠ 带得上场，与 `_find_lead` 同一条理由）。"""
    candidates = []
    for tier_rank, tier in enumerate(("FULL_VERIFIED", "SIMULATABLE_UNVERIFIED")):
        for pet in sorted(rs.pets.values(), key=lambda p: p.pet_id):
            if rs.build_support_of(pet.pet_id) != tier or pet.pet_id in SWEEP_IDS:
                continue
            for sid in rs.candidate_moveset(pet.pet_id) or ():
                skill = rs.skills.get(sid)
                # 必须挑**攻击类**技能：普通系那里曾挑到一条状态技，整条场景一次玩家伤害都没有
                # （倍率证据为空）——扫描要的是「这种属性的伤害真的算过」。
                if skill is not None and skill.element == element and getattr(skill, "is_attack", False):
                    candidates.append(((tier_rank, int(skill.energy or 0), pet.pet_id), pet.pet_id, sid))
    if not candidates:
        return None, None
    _, pet_id, sid = min(candidates, key=lambda row: row[0])
    return pet_id, sid


def build_type_sweep_scenarios(rs: Any) -> List[Dict[str, Any]]:
    """18 个属性各一条场景。找不到可驱动的精灵时**不生成**该条（由报告登记为不可达）。"""
    out = []
    for index, element in enumerate(TYPE_SWEEP_TYPES):
        lead, _ = _find_element_lead(rs, element)
        if lead is None:
            continue
        # 六宠模式要求每方 6 只：首发是扫描目标，其余用固定顺序的替补补齐（确定性）。
        bench = []
        for pet in sorted(rs.pets.values(), key=lambda p: p.pet_id):
            if pet.pet_id in SWEEP_IDS or pet.pet_id == lead or pet.name in bench:
                continue
            if rs.build_support_of(pet.pet_id) not in ("FULL_VERIFIED", "SIMULATABLE_UNVERIFIED"):
                continue
            bench.append(pet.name)
            if len(bench) >= 5:
                break
        if len(bench) < 5:
            continue          # 凑不齐六只 ⇒ 这个属性这一轮不生成（由报告如实登记）
        out.append({
            "id": f"type-sweep-{element}", "dimension": f"属性·{element}",
            "team_a": [rs.pets[lead].name] + bench, "team_b": list(SWEEP_OPPONENT),
            "seed": 40 + index, "config": V3, "overrides": True, "turns": 12,
            "pick_a": {"element": element}, "expect_kinds": ["damage"],
        })
    return out


#: 只**登记**、不生成场景的维度：数据与解析器里都没有对应的效果原语，
#: 硬造一条只会得到「跑了但什么都没驱动到」的假绿。理由由 `probe_unreachable()` 现算。
PROBE_UNREACHABLE = {
    "迅捷": "解析器与全量规范配招里都没有 `swift` 这类效果原语（术语 1007 的迅捷注入未实现）",
    "传动": "解析器与全量规范配招里都没有 `transmission` 这类效果原语",
}


def probe_unreachable(rs: Any) -> List[Dict[str, str]]:
    """把「驱动不了」的维度连**现算的理由**一起登记（不是手写一句借口）。"""
    out = []
    for name, why in PROBE_UNREACHABLE.items():
        # 判据不是「desc 里有没有这个词」（传动/迅捷**确实**出现在描述里），
        # 而是「解析器有没有把它变成引擎能结算的效果」：只出现在 `unparsed` 里 = 驱动不了。
        mentioned = 0
        modelled = 0
        for pet in rs.pets.values():
            for sid in (rs.candidate_moveset(pet.pet_id) or ()):
                skill = rs.skills.get(sid)
                if skill is None or name not in (skill.desc or ""):
                    continue
                mentioned += 1
                parsed = parse_mod.parse_skill(skill)
                if any(name in (e.evidence or "") or name in str(e.value) for e in parsed.effects):
                    modelled += 1
        if mentioned and not modelled:
            out.append({"dimension": name, "reason": why,
                        "evidence": f"规范配招里有 {mentioned} 条 desc 提到它，但解析器一条都没建模"})
        elif not mentioned:
            out.append({"dimension": name, "reason": why, "evidence": "规范配招里根本没有提到它的技能"})
    return out


def build_regression_set(rs: Any, scenarios: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """跑整套场景，产出可复核的回归集（确定性：同样的输入 ⇒ 同样的指纹）。"""
    SWEEP_IDS.clear()
    SWEEP_IDS.update(_ids(rs, SWEEP_OPPONENT))
    if scenarios is None:
        scenarios = list(SCENARIOS) + build_type_sweep_scenarios(rs)
    results = [run_scenario(rs, scenario) for scenario in scenarios]
    dimensions = sorted({row["dimension"] for row in results})
    problems = [f"{row['id']}：{p}" for row in results for p in row["problems"]]
    unreachable = [f"{row['id']}：{row['unreachable'][0]}" for row in results if row.get("unreachable")]
    # 「跑不了」的维度也要进**同一张** unreachable 清单：只写在子结构里、
    # 顶层看不见，等于没登记（本函数早先就漏过一次）。
    probed = probe_unreachable(rs)
    unreachable += [f"{row['dimension']}：{row['reason']}｜{row['evidence']}" for row in probed]
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
    # 不可达清单也是结论：某条从「可达」变「不可达」必须红，不能悄悄留在旧表里。
    old_unreachable, new_unreachable = set(regression.get("unreachable") or []), set(fresh.get("unreachable") or [])
    for row in sorted(new_unreachable - old_unreachable):
        problems.append(f"新出现不可达：{row}（要么补场景，要么重新生成指纹表）")
    for row in sorted(old_unreachable - new_unreachable):
        problems.append(f"原本不可达的现在不再登记：{row}（是修好了还是漏登记了？）")
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
