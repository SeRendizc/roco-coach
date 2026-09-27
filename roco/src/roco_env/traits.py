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
from typing import Dict, Optional, Tuple

from . import parse as parse_mod

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
    hook: Optional[str] = None      # 实现挂在哪個主钩子上（工作单按它分档）
    #: **还没实现的那一块**（机器可读，不再是"理由里的一句话"）。
    #: 为什么要有它（2026-09-25 第 40 轮实测）：`泛音列` 的 status 是 `FULL`，而它的理由里
    #: 自己写着「当前只挂印记、**不结算能耗**」—— 按本文件开头那行定义（FULL = 描述能被机械实现）
    #: 它只能算 PARTIAL，可**没有任何判据**能发现这种"自述里有缺口却标 FULL"。
    #: 现在缺口写成字段，`test_trait_status_export` 里有一条判据钉住 `status==FULL ⇒ gaps 为空`。
    gaps: Tuple[str, ...] = ()
    #: 一条特性可能挂在**多个**钩子上。`抓到你了` 就是：入场时施加冻结（`on_enter`），
    #: 而它的能耗骑手要在「使敌方获得冻结时」结算（`after_freeze_applied`）。
    #: 只留一个 `hook` 字段会让这种特性丢掉一半行为 —— 而且丢得**没有报错**。
    extra_hooks: Tuple[str, ...] = ()


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
    "图书守卫者": TraitSpec(
        pet_name="书魔虫", trait_name="图书守卫者", status=FULL,
        desc="入场时，若自己魔力值为1，自己获得双攻+100%。",
        reason=(
            "触发时点明确（入场时），效果明确（双攻 +100%），条件也**可判**："
            "「自己的魔力值是否为 1」。RC-401 批次二：只有声明了魔力的配置才判得了这个条件，"
            "legacy 没有「魔力」这条概念 ⇒ 条件不可判 ⇒ 不结算（行为逐位不变）。"
            "假设：双攻 = 物攻与魔攻各 +100%（与「专注力」同一种 buff 落法）。"
        ),
        hook="on_enter",
    ),
    "构装契约者": TraitSpec(
        pet_name="古卷匣魔像", trait_name="构装契约者", status=FULL,
        desc="入场时，若敌方魔力值为1，自己获得双防+100%。",
        reason=(
            "同「图书守卫者」，只是条件看**敌方**魔力值、效果换双防。"
            "同样只在声明了魔力的配置下可判；假设：双防 = 物防与魔防各 +100%。"
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
        pet_name="圆号鱼", trait_name="泛音列", status=PARTIAL,
        desc="使用状态技能后，敌方获得「聒噪」技能的效果，持续3回合。",
        reason=(
            "「聒噪」的效果在数据里查得到（`聒噪` skill_000274："
            "敌方获得全攻击技能能耗+2，持续3回合），所以不需要猜。"
            "**当前只挂印记、不结算能耗**：能耗修正机制已在 RC-401 批三落地，"
            "但这条的触发（使用状态技能）在冻结 48 名单里够得着，接线会改变既有 V3 对局结果，"
            "属于要连带重建回归指纹的独立一批；且「持续 3 回合」与回合边界的对齐仍需口径。"
            "⚠️ **2026-09-25（第 40 轮）如实降档 FULL → PARTIAL**：本文件开头那一行定义写着"
            "「FULL = 描述能被机械实现，且有测试」，而这条自己的理由里就写着「只挂印记、不结算能耗」"
            "——按同一条尺子它只能算 PARTIAL（只实现了描述的一部分）。原文一字未删，只把档位改对。"
        ),
        gaps=("敌方全攻击技能能耗 +2 未接线（`after_status_skill` 只挂 `聒噪` 印记）",
              "「持续 3 回合」与回合边界的对齐未定（MC-018 同族）"),
        hook="after_status_skill",
    ),
    "捉迷藏": TraitSpec(
        pet_name="雪影娃娃", trait_name="捉迷藏", status=PARTIAL,
        desc="使敌方获得冻结时，也会使其获得全技能能耗+1。",
        reason=(
            "「给敌方挂全技能能耗+1」**已经是真机制**（RC-401 批三）：修正写进 "
            "`PetState.energy_cost_mods`，由 `env.effective_skill_cost` 在可付性判定与扣费两处读，"
            "只在配置声明 `energy.cost_modifier` 时生效。"
            "仍未实现的是它与**其他能耗修改**（湿润印记 -1、聒噪 +2）的复合顺序与下限"
            "——术语没有定义，属 MC-018 待验项；本引擎按加法累计、不设下限（负值 fail closed）。"
        ),
        hook="after_freeze_applied",
    ),
    "渴求": TraitSpec(
        pet_name="恶魔叮", trait_name="渴求", status=FULL,
        desc="入场时获得50%吸血。",
        reason=(
            "只有一条原语：吸血。数值来自解析器（`self_lifesteal` 50%），"
            "结算在 `env._settle_sustain`（造成伤害后按**实际伤害**的百分比回复自己生命，"
            "上限是最大生命；溢出部分本特性不转化，只记账）。"
            "取整口径为向下取整（同 MC-011 的百分比取整假设）。"
            "与 `贪得无厌` 共用同一段实现（按**解析结果**分派，不按特性名）。"
        ),
        hook="on_enter",
    ),
    "贪得无厌": TraitSpec(
        pet_name="恶魔男爵", trait_name="贪得无厌", status=PARTIAL,
        desc="入场时获得50%吸血，每过量回复5%生命转化为10%物攻。",
        reason=(
            "数值全部来自解析器（`self_lifesteal` 50% / `overheal_to_stat` 5%→10% atk），"
            "引擎侧有对应原语 `env._settle_sustain`（造成伤害后结算）。"
            "**仍未核验、因此只到 PARTIAL 的两条**（数据里没写，已登记为 ENGINE_HYPOTHESIS）："
            "① 溢出的累计口径 —— 按「多次回复的溢出累加、满 5% 才转化」实现，"
            "而不是「每次回复各自向下取整」（多次小额回复下两者结果不同）；"
            "② 转化出来的属性增益持续多久 —— 按「持续到本局结束」实现。"
            "两条都会在结算时写进 `state.unsupported`，玩家侧事件也如实标出。"
        ),
        hook="on_enter",
    ),
    "抓到你了": TraitSpec(
        pet_name="雪影冰灵", trait_name="抓到你了", status=PARTIAL,
        desc="自己入场时敌方获得2层冻结，使敌方获得冻结时，也会使其获得全技能能耗+1。",
        reason=(
            "两句分开算：①「入场时敌方获得2层冻结」——层数按数据如实记账（公开视图可见），"
            "但**冻结的回合末结算仍未实现**（术语 1004 只写了「冻结5%生命…」，没有时序），"
            "所以这条只到 PARTIAL；②「使敌方获得冻结时，也会使其获得全技能能耗+1」——"
            "能耗修正机制本轮落地（`energy.cost_modifier` + `PetState.energy_cost_mods`），"
            "触发点是 `after_freeze_applied`，本特性自己施加的那 2 层也算。"
            "与其它能耗修改的复合顺序/下限仍属 MC-018 未验项（按加法累计、负值 fail closed）。"
        ),
        hook="on_enter",
        # 两个钩子：入场施加冻结（on_enter）+ 「使敌方获得冻结时」的能耗骑手（after_freeze_applied）。
        extra_hooks=("after_freeze_applied",),
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
    "变形活画": TraitSpec(
        pet_name="画间沉铁兽", trait_name="变形活画", status=FULL,
        desc="行动时，敌方每有1层增益，本次行动技能威力+10%，速度+5。",
        reason=(
            "「敌方的增益层数」在引擎里是可数的：对手场上精灵的 `buffs` 有多少个键"
            "就有多少层（`_apply_status_effects` 每加一项写一个键）。"
            "假设（MC-020）：把 `buffs` 的**键个数**当作「层数」，"
            "同一属性的两层合并成一个键时会被算成一层——数据没有定义层数的计数方式。"
            "速度部分在 `order_actions` 之前生效，实现为 `spe` 增益。"
        ),
        hook="on_action",
    ),
    "绝对秩序": TraitSpec(
        pet_name="秩序鱿墨", trait_name="绝对秩序", status=REFUSED,
        desc="受到非敌方系别的技能攻击时伤害-50%。",
        reason=(
            "字面读法有两个都可疑：① 「技能系别不在敌方精灵的系别里」——"
            "那要先确认 `types.json` 的系别名与技能 `element` 是同一套词表（是同一套），"
            "但「非敌方系别」是否指「不属于对手任一属性」没有一手证据；"
            "② 若读成「与我方系别不同的技能」，那所有非本系技能都减半，"
            "量级完全不同。两种读法的结论差一倍，术语表里没有这一条，"
            "所以拒绝而不是任选一种。"
        ),
    ),
    "化茧": TraitSpec(
        pet_name="化蝶", trait_name="化茧", status=REFUSED,
        desc="受到致命伤害时，获得1层萌化，并免疫此次伤害。（最多触发2次）",
        reason=(
            "需要三件引擎目前没有确认的东西：①「萌化」这个状态在数据里出现在"
            "状态技能描述里，但它的**效果**没有定义；②「免疫此次伤害」发生在"
            "伤害结算的哪一步（扣血前还是扣血后、是否触发倒下判定）；"
            "③ 触发次数的计数是每局还是每次入场。三条都没证据（MC-021）。"
        ),
    ),
    "铭记于月亮": TraitSpec(
        pet_name="银月狼王", trait_name="铭记于月亮", status=REFUSED,
        desc="获得自己击败的精灵的特性，每次攻击后自己失去5%生命。",
        reason=(
            "「获得对手的特性」要求引擎在**运行时**把另一只精灵的特性实现挂到自己身上。"
            "本引擎的特性是「按精灵 id 查表 + 固定钩子」，没有动态换表的机制；"
            "而其余 11 只里已经有 4 只是 REFUSED（拿到它们也没有意义）。"
            "要做它得先有一套「特性作为可组合对象」的重构，属于独立工作。"
        ),
    ),
    "热成像": TraitSpec(
        pet_name="圣凯布米龙", trait_name="热成像", status=FULL,
        desc="若上回合双方有精灵使用火系技能，本回合自己携带的虫系技能威力+100%。",
        reason=(
            "「上回合」用 `state.history` 的上一回合记录判定（引擎每回合都写"
            "player_action / enemy_action，能查出技能 id 与系别），"
            "不需要猜时序。加成对象明确（自己携带的虫系技能），实现为"
            "`buffs['power_bug']`，只有该系技能吃到。"
        ),
        hook="on_turn_start",
    ),
    "冷光源": TraitSpec(
        pet_name="月使鹭纳", trait_name="冷光源", status=FULL,
        desc="若上回合双方有精灵使用翼系技能，本回合自己携带的冰系技能威力+100%。",
        reason=(
            "与「热成像」同一机制，只是系别换成翼系触发 / 冰系受益。"
            "两条都用同一个读取上回合记录的辅助函数，避免各写一份。"
        ),
        hook="on_turn_start",
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


def implements_hook(spec: "TraitSpec", hook_name: str) -> bool:
    """这条特性是否在 `hook_name` 这个钩子上有实现（主钩子或附加钩子）。

    所有钩子分派都必须走这里 —— 「按特性分派」以前是各处自己写 `spec.hook != "捉迷藏"`
    这类判断，于是同一件事在三个地方各记一遍，漏一处就是一条特性永远不触发。
    """
    if spec is None:
        return False
    return spec.hook == hook_name or hook_name in (spec.extra_hooks or ())


#: 由「吸血 / 过量回复转化」这两条原语组成的特性（`贪得无厌` / `渴求` …）。
#: 按**解析结果**认，不按名字认 —— 名字认法的毛病是每来一条同类特性都要改一次实现，
#: 而数据里同样一句话会被写成不同的名字。
SUSTAIN_EFFECT_KINDS = ("self_lifesteal", "overheal_to_stat")


def is_sustain_only(parsed) -> bool:
    """这条特性的解析结果是不是**只有**吸血 / 过量转化（且没有没认领的片段）。"""
    if parsed is None or parsed.unparsed or not parsed.effects:
        return False
    return all(e.kind in SUSTAIN_EFFECT_KINDS for e in parsed.effects)


def trait_skill(rs, pet_id: str):
    """这只精灵的**特性条目**（`feature_skill_id` 指向的那条技能）。查不到就 None。"""
    pet = rs.pets.get(pet_id)
    if pet is None or not getattr(pet, "feature_skill_id", None):
        return None
    return rs.skills.get(pet.feature_skill_id)


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


# ── RC-401 批三：能耗修正 + 冻结施加（两个共用助手）────────────────────────
#
# 「技能能耗修正」以前只有一个没人读的 `_energy_cost_delta_all` 标记 —— 机制本身不存在。
# 现在修正写在 `PetState.energy_cost_mods` 上（见 schema.py），由 `env.effective_skill_cost`
# 在**可付性判定与扣费**两处读，并且**只在配置声明 `energy.cost_modifier` 时生效**。
# 这里只负责记账，不负责定价：定价只有一个读点。


def grant_energy_cost_mod(pet, *, scope: str, delta: int, source: str,
                          until_turn: Optional[int] = None) -> Dict[str, Any]:
    """给一只精灵挂一条能耗修正。返回写进去的那条记录（便于测试逐字段核对）。

    `scope` 必须是 `env.ENERGY_COST_SCOPES` 里的字面量（all / attack / defense / status）——
    写错就是「这条修正对谁都生效/对谁都不生效」这类静默错误，所以这里当场抛。
    """
    if scope not in ("all", "attack", "defense", "status"):
        raise ValueError(f"未知的能耗修正作用域：{scope!r}")
    mod = {"scope": str(scope), "delta": int(delta), "source": str(source),
           "until_turn": (int(until_turn) if until_turn is not None else None)}
    pet.energy_cost_mods.append(mod)
    return mod


def apply_status_layers(state, target_pet, name: str, layers: int) -> int:
    """给一只精灵叠加状态层数，返回叠加后的层数。

    ⚠ 与 `env._apply_effect_batch` 的 `foe_status` 分支**必须同口径**（层数累加、不改别的字段）。
    为什么两处：`traits.py` 不 import `env.py`（env 反过来 import traits，会成环），
    所以这里是一份**刻意保留的孪生实现**；`tests/test_energy_cost_modifier.py` 里有一条判据
    把两处的层数语义钉在一起（同一份输入 → 同样的层数），漂了就会红。
    """
    row = target_pet.statuses.get(name) or {}
    total = int(row.get("layers", 0)) + int(layers)
    target_pet.statuses[name] = {"layers": total}
    return total


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
    elif spec.trait_name in ("图书守卫者", "构装契约者"):
        # RC-401 批次二：条件是「魔力值是否为 1」。**只有声明了魔力的配置才判得了**——
        # legacy 里 `mana` 是 None（没有这条概念），条件不可判 ⇒ 不结算，行为逐位不变。
        own_mana = getattr(state.player, "mana", None)
        foe_mana = getattr(state.enemy, "mana", None)
        if spec.trait_name == "图书守卫者":
            triggered, keys, label = own_mana == 1, ("atk", "spa"), "双攻 +100%"
        else:
            triggered, keys, label = foe_mana == 1, ("def", "spd"), "双防 +100%"
        if triggered:
            for key in keys:
                pet.buffs[key] = pet.buffs.get(key, 0) + 100
            events.append({
                "kind": "trait", "trait": spec.trait_name, "side": side,
                "effect": label, "condition": "mana==1",
                "evidence": "feature_skill",
            })
    elif is_sustain_only(parse_mod.parse_skill(trait_skill(rs, pet.pet_id))
                         if trait_skill(rs, pet.pet_id) is not None else None):
        # RC-401 批四：**吸血 / 过量回复转化**。数值全部来自解析器
        # （`parse.parse_skill(这条特性)` 的 `self_lifesteal` / `overheal_to_stat`），
        # 实现里一个数字都不写死；同类特性（`贪得无厌` / `渴求`…）共用这一段。
        trait_row = trait_skill(rs, pet.pet_id)
        parsed = parse_mod.parse_skill(trait_row) if trait_row is not None else None
        lifesteal = next((e for e in parsed.effects if e.kind == "self_lifesteal"), None)
        convert = next((e for e in parsed.effects if e.kind == "overheal_to_stat"), None)
        if parsed is None or parsed.unparsed or (lifesteal is None and convert is None):
            # 解析不出来就**不结算**（宁可这条特性不生效，也不猜一个比例）
            events.append({
                "kind": "trait", "trait": spec.trait_name, "side": side,
                "effect": "未结算（描述里的数值没能机械读出）",
                "unparsed": list(parsed.unparsed) if parsed is not None else ["特性条目查不到"],
                "evidence": "feature_skill",
            })
        else:
            sus = dict(pet.sustain or {})
            if lifesteal is not None:
                sus["lifesteal_pct"] = int(lifesteal.value["percent"])
            if convert is not None:
                sus["overheal"] = {"chunk_pct": int(convert.value["chunk_pct"]),
                                   "gain_pct": int(convert.value["gain_pct"]),
                                   "stats": list(convert.value["stats"]),
                                   "carry_pct": 0.0}
            pet.sustain = sus
            events.append({
                "kind": "trait", "trait": spec.trait_name, "side": side,
                "effect": ((f"吸血 {sus['lifesteal_pct']}%" if lifesteal is not None else "")
                           + ("，" if lifesteal is not None and convert is not None else "")
                           + (f"过量回复每 {sus['overheal']['chunk_pct']}% 转 "
                              f"{sus['overheal']['gain_pct']}% {'/'.join(sus['overheal']['stats'])}"
                              if convert is not None else "")),
                "evidence": "feature_skill",
            })
    elif spec.trait_name == "抓到你了":
        # RC-401 批三（人类计划 §3.4）：`抓到你了` 的第二句「使敌方获得冻结时，也会使其获得
        # 全技能能耗+1」需要两个东西：① 能耗修正机制（本轮落地）；② 冻结施加（这里做）。
        # 口径边界（如实登记，别读成「冻结全实现了」）：
        #   · 术语 1004 只写了「冻结5%生命，若当前生命低于冻结比例，则力竭」，**没写时序**，
        #     所以冻结的**回合末结算仍未实现**（`effects.END_OF_TURN_STATUS` 里没有它）；
        #   · 这里只把**层数**按数据记进 `statuses`（公开视图里看得见），并把这个缺口登记成
        #     unsupported —— 不是假装冻结会掉血。
        foe = getattr(state, "enemy" if side == "player" else "player")
        tgt = foe.field_pet
        if tgt.alive:
            layers = apply_status_layers(state, tgt, "冻结", 2)
            events.append({
                "kind": "status_added", "side": "enemy", "status": "冻结", "layers": 2,
                "total_layers": layers, "source": "抓到你了",
                "note": "冻结的回合末结算未实现（术语 1004 没写时序）",
                "evidence": "skill_000219",
            })
            # 「使敌方获得冻结时」——本特性自己这次施加也算，所以紧接着走冻结钩子链。
            after_freeze_applied(rs, state, side, events)
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
    # 「聒噪」的效果来自数据：全攻击技能能耗 +2，持续 3 回合。
    # 2026-09-23（RC-401 批三）：能耗修正机制**已经有了**（`PetState.energy_cost_mods` +
    # `env.effective_skill_cost`），但这条**故意不接线** —— 它的触发（使用状态技能）在冻结 48
    # 名单里够得着，接上去会改变既有 V3 对局结果，属于要连带重建回归指纹的独立一批；
    # 而且「持续 3 回合」与回合边界怎么对齐仍需口径（MC-018 的同族问题）。
    # 这里只留印记（公开视图可见，且印记本身是数据里的事实），并把旧的死标记删掉 ——
    # 留着 `_energy_cost_delta_attack` 会让人以为它生效了。
    tgt.marks["聒噪"] = int(tgt.marks.get("聒噪", 0)) or 1
    events.append({
        "kind": "trait", "trait": "泛音列", "side": side, "target": "enemy",
        "effect": "全攻击技能能耗 +2（3 回合）",
        "note": "能耗复合顺序未定义（MC-018），此处只登记数值",
        "evidence": "skill_000274",
    })


def after_freeze_applied(rs, state, side: str, events: list) -> None:
    """**使敌方获得冻结之后**的特性结算。

    2026-09-23（RC-401 批三）：这里原来写死了 `spec.trait_name != "捉迷藏"` → 只有雪影娃娃
    那条特性会结算，而 `抓到你了`（雪影冰灵）写的是一模一样的一句话却永远不触发。
    现在改成**按特性登记的钩子分派**：谁把 `hook="after_freeze_applied"` 写进 `TRAITS` 谁结算。
    """
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.status == REFUSED or not implements_hook(spec, "after_freeze_applied"):
        return
    foe = getattr(state, "enemy" if side == "player" else "player")
    tgt = foe.field_pet
    if not tgt.alive:
        return
    # 两条特性在这一步的效果逐字相同：全技能能耗 +1。差异只在**触发条件**（谁施的冻结），
    # 所以数值写在一处，避免两条各写一遍再漂。
    grant_energy_cost_mod(tgt, scope="all", delta=1, source=spec.trait_name, until_turn=None)
    events.append({
        "kind": "trait", "trait": spec.trait_name, "side": side, "target": "enemy",
        "effect": "全技能能耗 +1", "scope": "all", "delta": 1,
        "note": "与湿润印记(-1)/聒噪(+2) 的复合顺序与下限未定义（MC-018）："
                "本引擎按加法累计、不设下限（负值 fail closed）",
        "evidence": "feature_skill",
    })


# ── 上回合元素技能记录（热成像 / 冷光源共用）────────────────────────────────
#
# 两条特性形状完全一样，只差「触发系别 → 受益系别」这一对参数，
# 所以读记录的辅助函数只写一份。各写一份迟早会漂。

#: 当前规则集由 env 在每次结算前绑定（与 opponents.bind_ruleset 同一手法）。
_SKILL_ELEMENT = {}


def bind_skill_elements(rs) -> None:
    """把「技能 id → 系别」缓存一次。env 在每个回合开始前调用。"""
    _SKILL_ELEMENT.clear()
    for skill_id, skill in rs.skills.items():
        _SKILL_ELEMENT[skill_id] = skill.element


def _skill_element(skill_id: str):
    return _SKILL_ELEMENT.get(skill_id)


def element_trait(rs, state, side: str, events: list) -> None:
    """回合开始时结算「上回合有人用了 X 系 → 本回合自己 Y 系威力+100%」。

    覆盖：热成像（火 → 虫）、冷光源（翼 → 冰）。
    """
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.status == REFUSED or spec.hook != "on_turn_start":
        return
    pairs = {"热成像": ("火系", "虫系", "power_bug"), "冷光源": ("翼系", "冰系", "power_ice")}
    if spec.trait_name not in pairs:
        return
    trigger, benefit, buff_key = pairs[spec.trait_name]

    # history 里存的是**已完成**的回合，所以「上一回合」就是最后一条。
    # （这里原本写成 `history[-2]` 并要求 len>=2，等于跳过最近一回合去读上上回合，
    #  结果是特性永远差一回合、测试里表现为「上回合明明用了火系却没加成」。）
    history = getattr(state, "history", None) or []
    if not history:
        return
    previous = history[-1]
    used = []
    for key in ("player_action", "enemy_action"):
        action = previous.get(key) or {}
        skill_id = action.get("skill_id")
        if skill_id:
            used.append(skill_id)
    if not any(_skill_element(sid) == trigger for sid in used):
        return
    pet.buffs[buff_key] = pet.buffs.get(buff_key, 0) + 100
    events.append({
        "kind": "trait", "trait": spec.trait_name, "side": side,
        "effect": f"{benefit}技能威力 +100%",
        "note": f"依据上回合记录里有人使用{trigger}技能（事实，不是推断）",
        "evidence": "feature_skill",
    })


def on_action(rs, state, side: str, events: list) -> None:
    """出手前的特性（变形活画）。

    「敌方每有1层增益」按对手场上精灵 `buffs` 的**键个数**计数。
    假设（MC-020）：同一属性的多层合并成一个键时会被算成一层 ——
    数据没有定义「层数」的计数方式，这个假设登记在特性理由里。
    """
    me = getattr(state, side)
    pet = me.field_pet
    spec = spec_for_pet(rs, pet.pet_id)
    if spec is None or spec.status == REFUSED or spec.hook != "on_action":
        return
    if spec.trait_name != "变形活画":
        return
    foe = getattr(state, "enemy" if side == "player" else "player")
    layers = len(foe.field_pet.buffs or {})
    if layers <= 0:
        return
    pet.buffs["power"] = pet.buffs.get("power", 0) + 10 * layers
    pet.buffs["spe"] = pet.buffs.get("spe", 0) + 5 * layers
    events.append({
        "kind": "trait", "trait": "变形活画", "side": side,
        "effect": f"威力 +{10 * layers}%、速度 +{5 * layers}",
        "note": "「层数」按对手增益的键个数计（MC-020 假设）",
        "evidence": "feature_skill",
    })
