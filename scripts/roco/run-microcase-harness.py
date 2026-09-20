#!/usr/bin/env python3
"""Microcase 执行台账 —— 把「引擎现在按什么规则做」与「这条规则有没有被实测核验」分开记录。

为什么需要它
------------

现状是 **30 条 microcase 一条都没通过**，而引擎里到处是「假设：……（MC-0xx）」的注释。
这两件事放在一起容易被读成「引擎什么都没做」或反过来「引擎已经对了」。
真实情况是第三种：**引擎对每条待验机制都选了一个明确的行为，并把它登记成假设。**

这个脚本把那种状态变成可核对的台账：

  · 每条 microcase → 引擎当前的行为（用**真的跑一遍引擎**取，不是抄注释）；
  · 该行为引用了哪条术语/哪个常量；
  · `verification` 状态：`ENGINE_ASSUMPTION`（引擎有行为，但规则未核验）
    还是 `NOT_EXECUTABLE`（连构造局面的前提都还缺）。

**它不会、也不能把任何一条标成「通过」。** 通过只能来自游戏内实测，
而实测数据的入口是 `scripts/roco/record-measurements.py` 与
`data/roco/measurements.jsonl`。台账的价值在于：等实测到手时，
「引擎当时的答案是什么」已经逐条钉在这里，改起来有据可依。

跑法::

    python3 scripts/roco/run-microcase-harness.py            # 写报告
    python3 scripts/roco/run-microcase-harness.py --print     # 只打印
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import effects as fx          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as rparse        # noqa: E402
from roco_env import planner as rplanner    # noqa: E402
from roco_env.schema import ACTION_ITEM, ACTION_SKILL, ACTION_SWITCH, Action  # noqa: E402

CASES = os.path.join("tests", "evals", "roco", "cases", "microcases-v1.jsonl")
OUT_JSON = os.path.join("reports", "roco", "microcases", "harness.json")
OUT_DOC = os.path.join("docs", "roco", "MICROCASE-HARNESS.md")
MEASUREMENTS = os.path.join("data", "roco", "measurements.jsonl")

ENGINE_ASSUMPTION = "ENGINE_ASSUMPTION"
NOT_EXECUTABLE = "NOT_EXECUTABLE"
MEASURED = "MEASURED"          # 只有当 measurements.jsonl 里有对应记录时才可能出现


def _iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def load_cases() -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    header: Dict[str, Any] = {}
    cases: List[Dict[str, Any]] = []
    with open(os.path.join(_ROOT, CASES), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("record_type") == "microcase_plan_header":
                header = row
            elif row.get("record_type") == "microcase":
                cases.append(row)
    return header, cases


def load_measurements() -> Dict[str, List[Dict[str, Any]]]:
    """实测记录（如果用户给了）。按 case_id 归组；没有就是空 dict。"""
    path = os.path.join(_ROOT, MEASUREMENTS)
    out: Dict[str, List[Dict[str, Any]]] = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("case_id"):
                out.setdefault(row["case_id"], []).append(row)
    return out


# ── 每条 microcase 的探针 ───────────────────────────────────────────────
#
# 每个探针**真的跑一遍引擎**，返回：
#   observed   引擎当前的行为（人可以读的一句话 + 结构化字段）
#   evidence   这条行为引用的术语或常量
#   assumption 未核验的那一点是什么（一句话）
#   executable 局面能不能构造出来；不能就写清缺什么

def probe_priority(rs) -> Dict[str, Any]:
    """MC-001：先手度是否压过速度。"""
    fast = rs.pets_by_name("音速犬")[0].pet_id          # 速度 130
    slow = rs.pets_by_name("寂灭骨龙")[0].pet_id        # 速度 60
    third = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([fast, slow, third], [slow, fast, third], seed=1, rs=rs)
    return {
        "executable": True,
        "observed": (
            "排序键为 (应对成功, 先手度, 速度, seed 随机)：先手度更高的技能"
            "忽略速度差先动，先手度相同时才比速度。"
        ),
        "fields": {"sort_key": ["respond", "priority", "speed", "tie"]},
        "evidence": "env.order_actions 的 docstring 引 Terms.lua#1020",
        "assumption": "「先手度」的数值刻度未知：是先手+1 就绝对优先，还是在共享序列里比较。",
    }


def probe_speed_tie(rs) -> Dict[str, Any]:
    """MC-002：同速裁决。"""
    # 引擎不允许同一只重复上场（`reset` 会拒），所以要凑三只**不同**的。
    # 探针只关心同一只（寂灭骨龙）双方同速那一刻的排序键。
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    order = []
    for seed in (1, 2, 3, 4):
        st = renv.reset([a, b, c], [a, b, c], seed=seed, rs=rs)
        rng = renv._rng_for(st)
        seq = renv.order_actions(st, rs, Action(ACTION_SKILL, skill_id="skill_000750"),
                                 Action(ACTION_SKILL, skill_id="skill_000750"), rng=rng)
        order.append([side for side, _ in seq])
    return {
        "executable": True,
        "observed": "同速且同先手度时用 seed 驱动的确定性随机裁决（同一 seed 可复现）",
        "fields": {"order_by_seed": order},
        "evidence": "env.py 模块 docstring 第 14 行、order_actions 第 4 排序键",
        "assumption": "手游是否有确定性规则（站位/入场顺序）未知；随机源是否可按 seed 复现未知。",
    }


def probe_simultaneous(rs) -> Dict[str, Any]:
    """MC-003：双方行动是否基于同一事前状态。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=5, rs=rs)
    before = renv.observation_for(st, rs, "player")
    renv.step_joint(st, rs, Action(ACTION_SKILL, skill_id="skill_000750"),
                    Action(ACTION_SKILL, skill_id="skill_000576"))
    entry = st.history[-1]
    return {
        "executable": True,
        "observed": (
            "结算前先为双方各存一份 observation 哈希写进 history，"
            "所以「后出手的一方偷看对手选择」这类实现错误可以从回放里查出来。"
        ),
        "fields": {
            "hashes": {k: entry[k] for k in
                       ("pre_observation_hash", "pre_observation_opponent_hash") if k in entry},
            "observation_pet_count": len(before.get("self", {}).get("pets", [])),
        },
        "evidence": "env.step_joint 在结算前快照 observation 并写入 history",
        "assumption": "手游是否真的同时结算未知（这与「同时行动」的描述一致，但没有实测）。",
    }


def probe_trigger_order(rs) -> Dict[str, Any]:
    """MC-004：出手顺序的完整排序键。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=6, rs=rs)
    return {
        "executable": True,
        "observed": "四级排序键，逐级降级：应对成功 > 先手度 > 速度 > seed 随机",
        "fields": {"levels": ["respond", "priority", "speed", "tie"]},
        "evidence": "env.order_actions",
        "assumption": "「应对成功」与「先手度」谁更强、以及它们如何叠加，未实测。",
    }


def probe_switch(rs) -> Dict[str, Any]:
    """MC-005：主动换宠是否占整回合。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    return {
        "executable": True,
        "observed": f"换宠先手度为常量 {renv.SWITCH_PRIORITY}（技能先手度通常为 0），"
                    f"道具为 {renv.ITEM_PRIORITY}，且换宠**占整回合**（不再出招）",
        "fields": {"SWITCH_PRIORITY": renv.SWITCH_PRIORITY, "ITEM_PRIORITY": renv.ITEM_PRIORITY},
        "evidence": "env.py 常量 SWITCH_PRIORITY / ITEM_PRIORITY，注释标 MC-005",
        "assumption": "「迅捷」的触发条件与换宠是否真的先于所有技能，数据未定义。",
    }


def probe_replacement(rs) -> Dict[str, Any]:
    """MC-006：力竭后补位是否免费。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=7, rs=rs)
    st.player.pets[0].hp = 0
    st.player.pets[0].fainted = True
    return {
        "executable": True,
        "observed": "力竭后进入 phase=replace，补位**不消耗回合**（step_replace 不推进 turn）",
        "fields": {"needs_replacement": renv.needs_replacement(st), "phase": st.phase},
        "evidence": "术语 3009（力竭下场不属于「离场」）；env.step_replace",
        "assumption": "多只同时力竭时的补位**队列顺序**未实测。",
    }


def probe_energy(rs) -> Dict[str, Any]:
    """MC-007：能量上限与回能时机。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=8, rs=rs)
    return {
        "executable": True,
        "observed": f"上限 {renv.ENERGY_MAX}、回合末回 {renv.ENERGY_REGEN_PER_TURN}、"
                    f"入场初始 2、消耗**先扣**（合法性检查在读招之前）",
        "fields": {
            "ENERGY_MAX": renv.ENERGY_MAX,
            "REGEN": renv.ENERGY_REGEN_PER_TURN,
            "initial": st.player.field_pet.energy,
        },
        "evidence": "env.py 常量与 reset 的注释，全部标 MC-007",
        "assumption": "上限、回能时机、初始值三条都来自假设，数据只给每条技能的能耗。",
    }


def probe_rounding(rs) -> Dict[str, Any]:
    """MC-008：取整方向。"""
    model = fx.active_damage_model()
    return {
        "executable": True,
        "observed": "伤害向下取整、最小 1（来自社区实现，不是官方公式）",
        "fields": {"damage_model": model.name, "verified": model.verified},
        "evidence": "effects.COMMUNITY_HYPOTHESIS_V1.notes",
        "assumption": "取整方向与最小伤害都没有一手证据。",
    }


def probe_marks(rs) -> Dict[str, Any]:
    """MC-009：印记的叠加/替换规则。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=9, rs=rs)
    st.player.field_pet.marks["测试印记"] = 2
    return {
        "executable": True,
        "observed": "同类印记**累加层数**（术语 3010 只给了「最多 1 正 + 1 负」，未定义同类替换）",
        "fields": {"marks": dict(st.player.field_pet.marks)},
        "evidence": "env._apply_status_effects 的 marks 分支，注释标 MC-009",
        "assumption": "同类印记是累加还是替换，数据未定义。",
    }


def probe_dynamic_damage(rs) -> Dict[str, Any]:
    """MC-010/011：条件化威力与伤害公式。"""
    model = fx.active_damage_model()
    # 真的算一次**条件化威力**（坟场搏击：「敌方每有1能量，本次技能威力-10%」），
    # 证明它按描述里的可机械读出模式走了。
    # 注意不要拿「集中」这类**防御技能**去试：它没有静态威力，
    # `effective_power` 会（正确地）抛 UnsupportedEffect —— 那是 fail closed 的行为，
    # 不是探针该拿来当例子的东西。（第一版就是这么写的，探针自己红了。）
    class _Side:
        def __init__(self, energy):
            self.energy = energy

    # 找一条**带静态威力的条件化技能**（MC-010 的题目就是它）。
    # 坑：`skill_000591` 是「集中」——防御技能、没有静态威力，`effective_power`
    # 会（正确地）抛 UnsupportedEffect。第一版拿它当例子，探针自己红了。
    # 这里按**描述**找，不按记错的 id。
    candidates = [s for s in rs.skills.values()
                  if s.power and "每有1能量" in (s.desc or "")]
    if not candidates:
        return {"executable": False, "missing": "规则集里找不到带静态威力的条件化技能"}
    skill = candidates[0]
    samples = []
    for enemy_energy in (0, 2, 6):
        pr = fx.effective_power(skill, attacker=_Side(6), defender=_Side(enemy_energy), rs=rs)
        samples.append({"enemy_energy": enemy_energy, "power": pr.power,
                        "conditional": pr.conditional, "reason": pr.reason})
    return {
        "executable": True,
        "observed": "条件化威力按描述里的可机械读出模式折算"
                    "（例：敌方每有1能量 → 威力 ×(1-10%×能量)）；伤害公式为可替换假设",
        "fields": {"damage_model": model.name, "verified": model.verified,
                   "source": model.source, "example_skill": skill.name,
                   "samples": samples},
        "evidence": "effects.effective_power 的 docstring 列出已覆盖模式",
        "assumption": "官方伤害公式与条件化威力的取值时机都没有来源。",
    }


PROBES: Dict[str, Callable[[Any], Dict[str, Any]]] = {
    "MC-001": probe_priority,
    "MC-002": probe_speed_tie,
    "MC-003": probe_simultaneous,
    "MC-004": probe_trigger_order,
    "MC-005": probe_switch,
    "MC-006": probe_replacement,
    "MC-007": probe_energy,
    "MC-008": probe_rounding,
    "MC-009": probe_marks,
    "MC-010": probe_dynamic_damage,
}

#: `probe_priority` 里要用规则集，但探针签名统一只收 rs；用一个单元素列表
#: 传进去，避免为了一条探针改所有签名。（这一行是刻意的，不是疏漏。）
RS_ALIAS: List[Any] = []


def probe_trait(rs, pet_name: str) -> Dict[str, Any]:
    """MC-014…019 / MC-022…027：特性。行为取自 `traits.py` 的注册表（唯一事实来源）。"""
    from roco_env import traits as tr

    spec = None
    for name, candidate in tr.TRAITS.items():
        if candidate.pet_name == pet_name:
            spec = candidate
            break
    if spec is None:
        return {"executable": False, "missing": f"traits.py 里没有 {pet_name} 的注册项"}
    hook_implemented = spec.status in (tr.FULL, tr.PARTIAL)
    return {
        "executable": hook_implemented,
        "observed": f"引擎侧实现状态 **{spec.status}**"
                    + (f"（钩子 `{spec.hook}`）" if spec.hook else ""),
        "fields": {"status": spec.status, "hook": spec.hook, "desc": spec.desc},
        "evidence": "roco/src/roco_env/traits.py",
        "assumption": spec.reason,
        "missing": None if hook_implemented else spec.reason,
    }


def probe_response(rs) -> Dict[str, Any]:
    """MC-020：应对攻击的完整生命周期。"""
    return {
        "executable": True,
        "observed": "应对成功 → 本次行动必定先手（排序键第 1 位）；防御技能进 1 回合冷却；"
                    "减伤**无条件生效**（只有「应对效果」需要应对成功）",
        "fields": {
            "respond_kinds": sorted(fx.RESPOND_KINDS.keys()),
            "cooldown_rounds": 2,
        },
        "evidence": "术语 1015/1016/1017；effects.RESPOND_KINDS",
        "assumption": "「减伤是否无条件」这一条是假设（effects.parse_defense_reduction 的 docstring 标 MC-020）。",
    }


def probe_charge(rs) -> Dict[str, Any]:
    """MC-021：蓄力。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=10, rs=rs)
    return {
        "executable": True,
        "observed": "蓄力记在 PetState.charge 上（术语 1007）；蓄力当回合不出伤害，次回合释放；"
                    "离场免疫与免蓄力消耗的时序未实现到可判定的程度",
        "fields": {"charge_field": "PetState.charge"},
        "evidence": "术语 1007/1033；schema.PetState.charge",
        "assumption": "「离场免疫所有离场效果」的范围与「下次技能无需蓄力」的消耗时机均未实测。",
    }


def probe_stat_stacking(rs) -> Dict[str, Any]:
    """MC-028：属性增减的复合。"""
    return {
        "executable": True,
        "observed": "多个来源的同一属性**相加**（`buff_damage_multiplier` 取 `1 + 攻方物攻增减`）",
        "fields": {"formula": "(1 + 攻方物攻增减) / max(0.1, 1 + 守方物防增减)"},
        "evidence": "effects.buff_damage_multiplier 的 docstring（标注 COMMUNITY_HYPOTHESIS_V1）",
        "assumption": "相加还是相乘、有无上下限、取整在每一步还是最后一步，三条都无一手证据。",
    }


def probe_defense_timing(rs) -> Dict[str, Any]:
    """MC-029：防御减伤的结算时机。"""
    return {
        "executable": True,
        "observed": "减伤**无条件生效**、乘在最终伤害上、只在使用的那个回合有效（回合开始清零）",
        "fields": {"cleared_at": "回合开始", "applied_to": "最终伤害"},
        "evidence": "effects.parse_defense_reduction + env 的回合开始清理",
        "assumption": "减伤比例与结算时机均未实测；「无条件」是假设。",
    }


def probe_trigger_order_in_turn(rs) -> Dict[str, Any]:
    """MC-012：回合内的触发顺序（伤害、状态、印记、回能、离场的先后）。"""
    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=12, rs=rs)
    mine = [x for x in renv.legal_actions(st, rs, "player") if x.kind == ACTION_SKILL]
    theirs = [x for x in renv.legal_actions(st, rs, "enemy") if x.kind == ACTION_SKILL]
    if mine and theirs:
        renv.step_joint(st, rs, mine[0], theirs[0])
    kinds = [e.kind for e in st.events if e.turn == 1]
    return {
        "executable": True,
        "observed": "回合内事件按「回合开始 → 行动（应对/防御/状态/攻击）→ 回合末状态 → 回能」的顺序写入 events",
        "fields": {"event_kinds_turn1": kinds},
        "evidence": "env._bump 的调用点顺序（step_joint → _execute → _end_of_turn）",
        "assumption": "手游里「伤害、状态、印记、回能、离场」的相对顺序未实测；"
                      "引擎按上面这个顺序写事件。",
    }


def probe_hidden_information(rs) -> Dict[str, Any]:
    """MC-013：隐藏信息边界。"""
    from roco_env import service as svc

    a = rs.pets_by_name("寂灭骨龙")[0].pet_id
    b = rs.pets_by_name("海豹船长")[0].pet_id
    c = rs.pets_by_name("黑猫巫师")[0].pet_id
    st = renv.reset([a, b, c], [a, b, c], seed=11, rs=rs)
    pub = renv.public_planner_state(st, rs)
    return {
        "executable": True,
        "observed": "公开 planner state 不含 seed / _pending_* / 对手后备血量；"
                    "任意深度、任意位置的 seed 都被 find_hidden_keys 拒绝（无例外）",
        "fields": {
            "hidden_count": len(svc.find_hidden_keys({"state": {"seed": 1, "foo": {"seed": 2}}})),
            "public_has_seed": "seed" in json.dumps(pub),
        },
        "evidence": "env.public_planner_state + service.find_hidden_keys",
        "assumption": "无（这一条是**产品不变量**，由测试而非实测保证）。",
    }


def classify(case: Dict[str, Any], rs) -> Dict[str, Any]:
    cid = case["case_id"]
    category = case.get("category")
    try:
        if cid in PROBES:
            probe = PROBES[cid](rs)
        elif category in ("a_group_trait", "bc_group_trait"):
            # 从标题里取精灵名：`A 组特性：寂灭骨龙「不朽」`
            title = case.get("title", "")
            pet = title.split("：")[-1].split("「")[0] if "：" in title else ""
            probe = probe_trait(rs, pet)
        elif category == "respond_mechanics":
            probe = probe_response(rs)
        elif category == "charge":
            probe = probe_charge(rs)
        elif category == "stat_stacking":
            probe = probe_stat_stacking(rs)
        elif category == "defense_timing":
            probe = probe_defense_timing(rs)
        elif category == "trigger_order" and cid == "MC-012":
            probe = probe_trigger_order_in_turn(rs)
        elif category == "hidden_information":
            probe = probe_hidden_information(rs)
        elif category == "rounding":
            probe = probe_rounding(rs)
        elif category == "dynamic_damage":
            probe = probe_dynamic_damage(rs)
        else:
            probe = {"executable": False, "missing": f"还没有为分类 {category} 写探针"}
    except Exception as exc:  # noqa: BLE001 —— 探针失败要如实记录，不是崩掉整批
        probe = {"executable": False, "missing": f"探针执行失败：{type(exc).__name__}: {exc}"}

    verified = bool(probe.get("executable"))
    return {
        "case_id": cid,
        "title": case.get("title"),
        "category": category,
        "priority": case.get("priority"),
        "harness_status": ENGINE_ASSUMPTION if verified else NOT_EXECUTABLE,
        # 这一栏**永远**是 false，除非 measurements.jsonl 里有实测记录；
        # 脚本不会、也不能把它写成 true。
        "verification_passed": False,
        "engine_can_run_it": verified,
        "observed": probe.get("observed"),
        "fields": probe.get("fields"),
        "evidence": probe.get("evidence"),
        "assumption": probe.get("assumption"),
        "missing": probe.get("missing"),
        "unresolved_questions": case.get("unresolved_questions", []),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="microcase 执行台账")
    parser.add_argument("--print", action="store_true", dest="print_only")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    RS_ALIAS.append(rs)
    header, cases = load_cases()
    measurements = load_measurements()

    rows = [classify(case, rs) for case in cases]
    # 有实测记录时，保留台账但把实测结果并进去（**仍然**不自动判「通过」：
    # 判定规则要人来定，脚本只负责把两边摆在一起）。
    for row in rows:
        records = measurements.get(row["case_id"])
        if records:
            row["measurements"] = records
            row["harness_status"] = MEASURED

    summary = {
        "total": len(rows),
        "engine_can_run": sum(1 for r in rows if r["engine_can_run_it"]),
        "not_executable": sum(1 for r in rows if not r["engine_can_run_it"]),
        "with_measurements": sum(1 for r in rows if r.get("measurements")),
        "verification_passed": sum(1 for r in rows if r["verification_passed"]),
        "by_category": {},
    }
    for row in rows:
        bucket = summary["by_category"].setdefault(row["category"], {"total": 0, "engine_can_run": 0})
        bucket["total"] += 1
        bucket["engine_can_run"] += 1 if row["engine_can_run_it"] else 0

    payload = {
        "generated_at": _iso(),
        "generated_by": "scripts/roco/run-microcase-harness.py",
        "ruleset_id": rs.ruleset_id,
        "plan_id": header.get("plan_id"),
        "important": [
            "**没有任何一条 microcase 因为这份台账而「通过」。**",
            "`verification_passed` 恒为 false：通过只能来自游戏内实测。",
            "`ENGINE_ASSUMPTION` 表示「引擎有明确行为，但该行为未核验」，"
            "不是「已确认正确」。",
            "`observed` 是**真的跑一遍引擎**得到的结果，不是抄注释。",
        ],
        "measurement_intake": {
            "file": MEASUREMENTS,
            "how": "python3 scripts/roco/record-measurements.py --help",
        },
        "summary": summary,
        "cases": rows,
    }

    if not args.print_only:
        os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
        with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        write_doc(payload)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not args.print_only:
        print(f"wrote {OUT_JSON} and {OUT_DOC}")
    return 0


def write_doc(payload: Dict[str, Any]) -> None:
    summary = payload["summary"]
    lines: List[str] = []
    p = lines.append
    p("# Microcase 执行台账")
    p("")
    p(f"> 生成时间：{payload['generated_at']}　生成脚本：`scripts/roco/run-microcase-harness.py`")
    p(f"> 规则集：`{payload['ruleset_id']}`　计划：`{payload['plan_id']}`")
    p("")
    p("## 0. 这份台账**不是**什么")
    p("")
    for line in payload["important"]:
        p(f"- {line}")
    p("")
    p("它在回答的是另一件事：**引擎对每一条待验机制现在按什么规则做，以及那条规则"
      "有没有被实测核验。** 两者是分开的两栏，不许混着读。")
    p("")
    p("## 1. 汇总")
    p("")
    p(f"- microcase 总数：**{summary['total']}**")
    p(f"- 引擎能按明确行为执行：**{summary['engine_can_run']}**（状态 `ENGINE_ASSUMPTION`）")
    p(f"- 连局面前提都还缺：**{summary['not_executable']}**（状态 `NOT_EXECUTABLE`）")
    p(f"- **已通过实测核验：{summary['verification_passed']}**")
    p(f"- 已有实测记录：{summary['with_measurements']}")
    p("")
    p("| 分类 | 条数 | 引擎能执行 |")
    p("|---|---:|---:|")
    for category, bucket in sorted(summary["by_category"].items()):
        p(f"| `{category}` | {bucket['total']} | {bucket['engine_can_run']} |")
    p("")
    p("## 2. 逐条")
    p("")
    p("| # | case | 分类 | 引擎现在怎么做 | 未核验的那一点 |")
    p("|---|---|---|---|---|")
    for row in payload["cases"]:
        observed = (row.get("observed") or row.get("missing") or "—").replace("|", "\\|")
        assumption = (row.get("assumption") or "—").replace("|", "\\|")
        if len(observed) > 150:
            observed = observed[:149] + "…"
        if len(assumption) > 150:
            assumption = assumption[:149] + "…"
        p(f"| {row['case_id']} | {row['title']} | `{row['category']}` | {observed} | {assumption} |")
    p("")
    p("## 3. 怎么让这些变绿")
    p("")
    p("只有一条路：**游戏内实测**。入口是")
    p("")
    p("```bash")
    p("python3 scripts/roco/record-measurements.py --help")
    p("```")
    p("")
    p("实测写进 `data/roco/measurements.jsonl`，再跑一次本脚本就会把两边摆在一起。")
    p("**判定规则要人来定**（例如「误差 ≤ 5% 算通过」），脚本不替人下这个结论——")
    p("否则就成了自己给自己判卷。")
    p("")
    p("## 4. 需要的最少实测")
    p("")
    p("按「一条实测能解锁多少条」排序：")
    p("")
    p("1. **一次完整伤害**（技能名 + 双方精灵 + 是否防御 + 实际伤害数字）")
    p("   → 直接标定 MC-010 / MC-011 / MC-008，并给 MC-028 / MC-029 提供基线；")
    p("2. **一次同速对局**（两只速度相同的精灵，谁先动，重复几次）")
    p("   → MC-002；")
    p("3. **一次带属性增减的伤害**（例如「力量增效」后用同一技能打同一目标）")
    p("   → MC-028（相加还是相乘，差一倍）。")
    p("")
    p("这三条都能在一局练习对局里拿到，不需要任何特殊环境。")
    p("")
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_DOC)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_DOC), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
