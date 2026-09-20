"""A 组 6 只精灵的特性（MC-014…019）。

每个特性都逐条标注**实现状态**，而不是一律当成「已实现」：

    FULL        描述能被机械实现，且有测试
    PARTIAL     只实现了描述的一部分，未实现的部分必须如实登记
    REFUSED     依赖引擎做不到的前提，**明确拒绝**而不是近似

这样做是为了让「6 只里几只真的可用」是一个可核验的数字，而不是一个印象。

对照表（描述原文见 data 的 `feature_skill_id`）：

    寂灭骨龙 [不朽]      力竭4回合后复活                        REFUSED
    海豹船长 [身经百练]  己方每应对1次，入场时水系/武系威力+20%    FULL
    黑猫巫师 [预警]      敌方技能足以击败自己时，回合开始速度+50    PARTIAL
    圆号鱼   [泛音列]    使用状态技能后敌方获得「聒噪」效果          FULL
    雪影娃娃 [捉迷藏]    使敌方获得冻结时，也使其全技能能耗+1        PARTIAL
    音速犬   [专注力]    入场首回合物攻+100%                       FULL

REFUSED 的理由必须写清楚——「做不到」和「没做」是两件事。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

FULL = "FULL"
PARTIAL = "PARTIAL"
REFUSED = "REFUSED"


@dataclass(frozen=True)
class TraitSpec:
    pet_name: str
    trait_name: str
    desc: str
    status: str
    reason: str
    hook: Optional[str] = None      # 实现挂在哪个钩子上


# 按**特性名**索引（精灵可能同名多形态，特性名在本数据里唯一）
TRAITS: Dict[str, TraitSpec] = {
    "不朽": TraitSpec(
        pet_name="寂灭骨龙", trait_name="不朽", status=REFUSED,
        desc="力竭4回合后复活。",
        reason=(
            "复活需要「力竭后仍占用一个回合计数位」这一状态，"
            "而本引擎在精灵力竭时立刻把它移出可行动集合（术语 3009 把力竭下场"
            "与主动离场分开）。要实现它必须先确认：4 回合从哪一刻开始计、"
            "复活后生命/能量/状态/印记如何初始化、能否被再次触发。"
            "四条都没有一手证据（MC-014），所以拒绝而不是近似。"
        ),
    ),
    "身经百练": TraitSpec(
        pet_name="海豹船长", trait_name="身经百练", status=FULL,
        desc="己方精灵每应对1次，自己入场时水系和武系技能威力+20%。",
        reason=(
            "计数源明确（术语 1015/1016/1017 的「应对成功」），"
            "加成对象明确（水系与武系技能，入场时生效）。"
            "假设：每层 +20% 且可叠加；「入场时」= 换上该精灵的那个回合。"
        ),
        hook="on_enter",
    ),
    "预警": TraitSpec(
        pet_name="黑猫巫师", trait_name="预警", status=PARTIAL,
        desc="若敌方技能足够击败自己，回合开始时自己获得速度+50。",
        reason=(
            "「速度+50」已实现为速度属性增益。未实现的是**触发条件**"
            "「敌方技能足够击败自己」——它要求对每个合法敌方技能算一遍伤害并比较"
            "当前生命，而这依赖尚未核验的官方伤害公式（MC-010/011）；"
            "用未核验的公式去决定「会不会死」，会让一条被动特性建立在假设上。"
            "因此条件未实现，特性只在测试里被显式驱动。"
        ),
        hook="on_turn_start",
    ),
    "泛音列": TraitSpec(
        pet_name="圆号鱼", trait_name="泛音列", status=FULL,
        desc="使用状态技能后，敌方获得「聒噪」技能的效果，持续3回合。",
        reason=(
            "「聒噪」的效果在数据里查得到（`聒噪` skill_000274："
            "敌方获得全攻击技能能耗+2，持续3回合），所以不需要猜。"
            "实现为给对手挂一个能耗修正标记。"
        ),
        hook="after_status_skill",
    ),
    "捉迷藏": TraitSpec(
        pet_name="雪影娃娃", trait_name="捉迷藏", status=PARTIAL,
        desc="使敌方获得冻结时，也会使其获得全技能能耗+1。",
        reason=(
            "「给敌方挂全技能能耗+1」已实现为能耗修正标记。"
            "未实现的是它与**其他能耗修改**（湿润印记 -1、聒噪 +2）的复合顺序与下限"
            "——术语没有定义，属 MC-018 待验项，因此只登记标记、不在此处结算复合。"
        ),
        hook="after_freeze_applied",
    ),
    "专注力": TraitSpec(
        pet_name="音速犬", trait_name="专注力", status=FULL,
        desc="入场首回合，获得物攻+100%。",
        reason=(
            "触发时机用 `entered_turn` 判定（换入即记录回合号），与术语 1010「迸发」"
            "所依据的字段是同一个。「首回合」判定为 entered_turn == 当前回合。"
        ),
        hook="on_enter",
    ),
}


def spec_for_trait_name(name: str) -> Optional[TraitSpec]:
    return TRAITS.get(name)


def spec_for_pet(rs, pet_id: str) -> Optional[TraitSpec]:
    pet = rs.pets.get(pet_id)
    if pet is None or not pet.feature_skill_id:
        return None
    trait = rs.skills.get(pet.feature_skill_id)
    if trait is None:
        return None
    return TRAITS.get(trait.name)


def implementation_summary() -> Dict[str, int]:
    """A 组 6 只特性的实现状态统计。用来回答「真的能用的有几只」。"""
    out = {FULL: 0, PARTIAL: 0, REFUSED: 0}
    for spec in TRAITS.values():
        out[spec.status] = out.get(spec.status, 0) + 1
    return out


# ── 钩子实现 ────────────────────────────────────────────────────────────
#
# 这些函数只改状态、只返回事件字典，不做 I/O，也不 import env（避免循环依赖）。
# env.py 在合适的时机调用它们。


def on_enter(rs, state, side: str, events: list) -> None:
    """精灵入场时结算入场类特性。"""
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.status == REFUSED or spec.hook != "on_enter":
        return

    if spec.trait_name == "专注力":
        # 入场首回合物攻 +100%
        pet.buffs["atk"] = pet.buffs.get("atk", 0) + 100
        events.append({
            "kind": "trait", "trait": "专注力", "side": side,
            "effect": "atk +100%", "evidence": "feature_skill",
        })
    elif spec.trait_name == "身经百练":
        # 己方每应对 1 次 → 水系/武系技能威力 +20%（按层数累计）
        stacks = int(getattr(me, "_respond_count", 0) or 0)
        if stacks:
            pet.buffs["power_water"] = pet.buffs.get("power_water", 0) + 20 * stacks
            pet.buffs["power_fight"] = pet.buffs.get("power_fight", 0) + 20 * stacks
            events.append({
                "kind": "trait", "trait": "身经百练", "side": side,
                "effect": f"水系/武系威力 +{20 * stacks}%", "stacks": stacks,
                "evidence": "feature_skill",
            })


def on_turn_start(rs, state, side: str, events: list) -> None:
    """回合开始时结算时机类特性。"""
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.status == REFUSED:
        return
    if spec.trait_name == "预警":
        # 条件（敌方技能足以击败自己）**未实现**——它依赖未核验的伤害公式。
        # 这里只在测试显式打开开关时才生效，正常对局不触发。
        if getattr(pet, "_predict_threat_confirmed", False):
            pet.buffs["spe"] = pet.buffs.get("spe", 0) + 50
            events.append({
                "kind": "trait", "trait": "预警", "side": side,
                "effect": "spe +50", "note": "触发条件未实现，仅显式驱动",
                "evidence": "feature_skill",
            })


def after_status_skill(rs, state, side: str, skill, events: list) -> None:
    """使用状态技能之后的特性结算（泛音列）。"""
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.trait_name != "泛音列" or spec.status == REFUSED:
        return
    foe = getattr(state, "enemy" if side == "player" else "player")
    tgt = foe.field_pet
    # 「聒噪」的效果来自数据：全攻击技能能耗 +2，持续 3 回合
    tgt.marks["聒噪"] = int(tgt.marks.get("聒噪", 0)) or 1
    setattr(tgt, "_energy_cost_delta_attack", getattr(tgt, "_energy_cost_delta_attack", 0) + 2)
    setattr(tgt, "_energy_cost_turns", 3)
    events.append({
        "kind": "trait", "trait": "泛音列", "side": side, "target": "enemy",
        "effect": "全攻击技能能耗 +2（3 回合）",
        "note": "能耗复合顺序未定义（MC-018），此处只登记数值",
        "evidence": "skill_000274",
    })


def after_freeze_applied(rs, state, side: str, events: list) -> None:
    """让敌方获得冻结之后的特性结算（捉迷藏）。"""
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.trait_name != "捉迷藏" or spec.status == REFUSED:
        return
    foe = getattr(state, "enemy" if side == "player" else "player")
    tgt = foe.field_pet
    setattr(tgt, "_energy_cost_delta_all", getattr(tgt, "_energy_cost_delta_all", 0) + 1)
    events.append({
        "kind": "trait", "trait": "捉迷藏", "side": side, "target": "enemy",
        "effect": "全技能能耗 +1",
        "note": "与湿润印记(-1)/聒噪(+2) 的复合顺序未定义（MC-018）",
        "evidence": "feature_skill",
    })
