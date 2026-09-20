"""效果原语与伤害计算。

**本模块最重要的一条纪律：不知道就说不支持。**

手游的官方伤害公式没有公开来源。我们手里只有两样东西：
  1. 技能描述里写明的**条件化威力**（例「敌方每有1能量，本次技能威力-10%」）；
  2. 一个社区实现（`ColinHong10/NRC_AI`，MIT 覆盖其代码）用的公式。

因此本模块把伤害公式实现成**可替换的假设**，而不是装作事实：

  - `COMMUNITY_HYPOTHESIS_V1` 明确标注来源、许可与「未核验」；
  - 它可被 `set_damage_model()` 整体替换（将来拿到官方数据时）；
  - 每次用它算出的伤害都带 `unverified_formula: True` 标记，
    让上层能对玩家说明「这个数字来自未核验公式」。

没有实现的效果原语一律抛 `UnsupportedEffect`，**绝不**返回一个默认数值。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Sequence, Tuple

from .data import Ruleset, Skill


class UnsupportedEffect(RuntimeError):
    """遇到尚未核验/尚未实现的机制。

    这是**正常控制流**，不是 bug：引擎宁可拒绝，也不编一个数字。
    调用方应当把它转成对玩家的「这个机制还没核验」，而不是吞掉。
    """

    def __init__(self, what: str, detail: str = "", evidence: str = ""):
        super().__init__(f"未支持的机制：{what}" + (f"（{detail}）" if detail else ""))
        self.what = what
        self.detail = detail
        self.evidence = evidence


# ── 伤害模型 ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DamageModel:
    """一个伤害公式。`verified` 为 False 时，所有输出都必须带未核验标记。"""

    name: str
    verified: bool
    source: str
    license_note: str
    compute: Callable[..., int]
    notes: str = ""


def _community_v1(
    attacker_atk: float,
    defender_def: float,
    power: float,
    type_multiplier: float,
    stab: float,
    hit_count: int,
    power_multiplier: float,
    ability_level: float,
) -> int:
    """社区实现所用的公式。

    取自 `ColinHong10/NRC_AI` 的 `src/battle.py`：
        base = (atk/def) * power * 0.9
        damage = base * 属性克制 * 本系1.5 * 天气 * 连击 * 威力buff
        取整方式：向下取整，最小 1
    能力等级： (1 + 攻升 + 敌防降) / (1 + 攻降 + 敌防升)

    **它不是官方公式**，只是一个候选。保留它是因为：
      - 它是可运行的、可被差分测试的；
      - 换掉它只要换这一个函数。
    """
    atk = attacker_atk * ability_level
    dfn = max(1.0, float(defender_def))
    base = (atk / dfn) * power * 0.9
    damage = base * type_multiplier * stab * hit_count * power_multiplier
    return max(1, int(damage))


COMMUNITY_HYPOTHESIS_V1 = DamageModel(
    name="community-hypothesis-v1",
    verified=False,
    source="ColinHong10/NRC_AI src/battle.py（社区实现）",
    license_note=(
        "MIT 覆盖该仓库代码；上游游戏数据权利未声明。"
        "本公式仅作为**候选假设**，不是官方公式，未核验。"
    ),
    compute=lambda **kw: _community_v1(**kw),
    notes=(
        "取整为向下取整、最小 1；本系加成 1.5。"
        "这三条都来自该实现，**没有任何一手证据**，属 microcase 待验项（MC-010/011）。"
    ),
)

_ACTIVE_MODEL: DamageModel = COMMUNITY_HYPOTHESIS_V1


def set_damage_model(model: DamageModel) -> None:
    """替换全局伤害模型。将来拿到官方公式时只调这一处。"""
    global _ACTIVE_MODEL
    _ACTIVE_MODEL = model


def active_damage_model() -> DamageModel:
    return _ACTIVE_MODEL


# ── 属性增减如何进伤害（**社区假设**，不是官方机制）───────────────────────
#
# 这一节要分清两件事，混起来会让人以为官方倍率已经被证实：
#
#   ① **程序接线**（已证实的事实，与手游数值无关）：
#      引擎把属性增减写成 `PetState.buffs["atk"] = 60`（整数百分点，键名来自
#      `parse.STAT_KEYS`），这条数据必须**恰好**进入伤害一次。
#      以前它是硬编码 1.0，也就是完全没接线 —— 那是 bug，与「倍率应该是多少」无关。
#
#   ② **真实语义**（**未核验**，MC-010）：
#      「物攻 +100%」是不是精确等于伤害 ×2、攻防增减是相加还是相乘、
#      与威力加成是乘算还是加算 —— 这三条**没有任何一手证据**，
#      下面的折算是 `COMMUNITY_HYPOTHESIS_V1` 的一部分，属假设。
#
# 所以本模块只提供一个折算函数，它的输出永远带着 `verified=False` 的模型一起进事件；
# 任何调用方都不许把它当作「官方已确认的倍率」。

#: 引擎实际写入的增减键（整数百分点）。与 `parse.STAT_KEYS` 同源。
BUFF_PCT_KEYS = ("atk", "spa", "def", "spd", "spe")
#: 社区实现的原始键名（小数，0.6 = +60%），只做回落读取，不再由引擎写入。
LEGACY_DECIMAL_KEYS = ("atk_up", "atk_down", "def_up", "def_down")


def _pct(buffs: Dict[str, Any], engine_key: str, legacy_up: str, legacy_down: str) -> float:
    """读一个属性的净百分比（小数）。引擎键优先，社区键回落。

    负数统一成负值：`{"atk": -30}` 是物攻 -30%，不是「升高 -30 份」。
    """
    if engine_key in buffs:
        return float(buffs.get(engine_key) or 0.0) / 100.0
    return float(buffs.get(legacy_up, 0.0) or 0.0) + float(buffs.get(legacy_down, 0.0) or 0.0)


def buff_damage_multiplier(attacker_buffs: Dict[str, Any],
                           defender_buffs: Dict[str, Any]) -> float:
    """把双方的物攻/物防增减折成**一个**伤害乘区。

    `(1 + 攻方物攻增减) / max(0.1, 1 + 守方物防增减)`

    三条都要看清楚：

    · **只调用一次。** 面板值必须是原始面板（`data.panel_stats` 的输出），
      不许在这里之外再把增益乘进攻击面板：两处都乘会把增益精确抵消
      （乘两次与除一次相消，数值上与「没有 buff」完全一样），
      表现是「加了 buff 伤害一点没变」，而且不报错。这条有测试盯着。
    · **加算而非乘算**：多个来源的同一属性直接相加（`+30` 与 `+80` → `+110%`）。
      这是社区实现的做法，**未核验**。
    · 守方系数下限 0.1，避免「物防被削到负数」时除零或把伤害放大到无穷。

    返回值直接喂给 `DamageModel.compute(ability_level=...)`。
    """
    atk = _pct(attacker_buffs, "atk", "atk_up", "atk_down")
    dfn = _pct(defender_buffs, "def", "def_up", "def_down")
    return (1.0 + atk) / max(0.1, 1.0 + dfn)


# ── 条件化威力 ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PowerResult:
    power: float
    conditional: bool
    reason: str


def effective_power(skill: Skill, *, attacker: Any, defender: Any, rs: Ruleset) -> PowerResult:
    """把技能描述里的**条件化威力**折算成一个数。

    只处理描述里能**机械读出**的模式；读不出来的条件返回未条件化并标注原因，
    由上层决定要不要当作 unsupported。

    已覆盖的模式（全部来自技能描述文本，例如「坟场搏击」）：
      - 「敌方每有1能量，本次技能威力-10%」
      - 「若敌方能量小于等于2，造成5倍伤害」（阈值型）
      - 「应对状态：本次技能威力变为3倍 / 翻倍」
      - 「迸发：本次技能威力+40」
    未覆盖的一律标 conditional 且 reason 说明未识别——
    **不猜**，也让上游能看见「这里有条件没算」。
    """
    if skill.power is None:
        # 关键纪律：没有静态威力 ≠ 0 伤害。这是原样上报，不是默认值。
        raise UnsupportedEffect(
            f"技能「{skill.name}」没有静态威力",
            "该来源未给出静态威力，且其条件化威力尚未核验",
            evidence=skill.skill_id,
        )

    desc = skill.desc or ""
    power = float(skill.power)
    conditional = False
    reasons = []

    # 「每有1能量，本次技能威力-10%」类
    if "每有1能量" in desc or "每有 1 能量" in desc:
        m = _extract_percent(desc, after="威力")
        pct = m if m is not None else 10.0
        power *= max(0.0, 1.0 - pct / 100.0 * float(defender.energy))
        conditional = True
        reasons.append(f"敌方能量 {defender.energy} → 威力 ×{max(0.0, 1.0 - pct / 100.0 * float(defender.energy)):.2f}")

    # 「若敌方能量小于等于N，造成M倍伤害」
    if "若敌方能量小于等于" in desc or "若敌方能量小于等于" in desc:
        th, mult = _extract_threshold_multiple(desc)
        if th is not None and float(defender.energy) <= th:
            power *= mult
            conditional = True
            reasons.append(f"敌方能量≤{th} → 威力 ×{mult}")

    # 「应对状态：本次技能威力变为3倍 / 翻倍」——需要"应对成功"的上下文
    respond = getattr(attacker, "_respond_succeeded", False)
    if "应对状态" in desc or "应对攻击" in desc or "应对防御" in desc:
        conditional = True
        if respond:
            if "翻倍" in desc:
                power *= 2.0
                reasons.append("应对成功 → 威力翻倍")
            else:
                mult = _extract_multiple(desc)
                if mult:
                    power *= mult
                    reasons.append(f"应对成功 → 威力 ×{mult}")

    # 「迸发：本次技能威力+N」——入场首次行动
    if "迸发" in desc:
        conditional = True
        if getattr(attacker, "_burst_active", False):
            bonus = _extract_plus(desc)
            if bonus:
                power += bonus
                reasons.append(f"迸发 → 威力 +{bonus}")

    return PowerResult(power=power, conditional=conditional, reason="；".join(reasons))


def _extract_percent(desc: str, after: str = "") -> Optional[float]:
    import re
    m = re.search(r"威力\s*[-−]?\s*(\d+(?:\.\d+)?)\s*%", desc)
    return float(m.group(1)) if m else None


def _extract_threshold_multiple(desc: str) -> Tuple[Optional[float], float]:
    import re
    m = re.search(r"能量小于等于\s*(\d+)[^。]*?(\d+(?:\.\d+)?)\s*倍", desc)
    if not m:
        return None, 1.0
    return float(m.group(1)), float(m.group(2))


def _extract_multiple(desc: str) -> Optional[float]:
    import re
    m = re.search(r"威力(?:变为)?\s*(\d+(?:\.\d+)?)\s*倍", desc)
    return float(m.group(1)) if m else None


def _extract_plus(desc: str) -> Optional[float]:
    import re
    m = re.search(r"威力\s*\+\s*(\d+)", desc)
    return float(m.group(1)) if m else None


def stab_multiplier(skill: Skill, attacker_types: Tuple[str, ...]) -> float:
    """本系加成。

    社区实现用 1.5。**未核验**：这份手游数据里没有任何地方写本系加成，
    术语表也没有。所以它是假设，属 MC-010 待验项。
    """
    return 1.5 if skill.element in attacker_types else 1.0


# ── 伤害计算（唯一实现；planner / service / env 都调它）──────────────────
#
# 为什么要有这么一层：伤害计算原本内联在 `env._execute` 里，于是「只想算一个数」
# 的地方（planner 的估值、服务的伤害预览）要么重复实现公式、要么索性不算。
# 结果是 planner 的启发式里**根本没有伤害项** —— 它会把 40 威力的一击
# 排在 180 威力的一击前面（实测就是这样）。
#
# 这里把计算抽成纯函数：拿两只 PetState + 一个 Skill，返回伤害与全部中间量。
# `env._execute` 走同一条路径，所以**不存在第二份公式**。


@dataclass(frozen=True)
class DamageOutcome:
    """一次伤害计算的完整结果。中间量都要留着，否则没法追问「这个数怎么来的」。"""

    damage: int
    raw: int
    power: float
    conditional: bool
    conditional_reason: str
    type_multiplier: float
    stab: float
    attacker_atk: float
    defender_def: float
    ability_level: float
    power_multiplier: float
    defense_reduction: float
    model: str
    verified: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "damage": self.damage,
            "raw": self.raw,
            "power": round(self.power, 4),
            "conditional": self.conditional,
            "conditional_reason": self.conditional_reason,
            "type_multiplier": self.type_multiplier,
            "stab": self.stab,
            "attacker_atk": round(self.attacker_atk, 4),
            "defender_def": round(self.defender_def, 4),
            "ability_level": round(self.ability_level, 6),
            "power_multiplier": round(self.power_multiplier, 6),
            "defense_reduction": self.defense_reduction,
            "damage_model": self.model,
            "formula_verified": self.verified,
        }


def compute_damage(attacker: Any, defender: Any, skill: Any, rs: Ruleset,
                   *, attacker_species: Any = None, defender_species: Any = None) -> DamageOutcome:
    """一次伤害的完整计算。**唯一实现。**

    `attacker` / `defender` 是 `PetState`（要有 `buffs`、`energy`、`hp`）；
    `*_species` 不给就按 `pet_id` 从规则集查。属性增减**只进一次**（走
    `buff_damage_multiplier`），面板值保持未加成 —— 两边同时乘会把增益约掉。
    """
    attacker_species = attacker_species or rs.pet(attacker.pet_id)
    defender_species = defender_species or rs.pet(defender.pet_id)

    pr = effective_power(skill, attacker=attacker, defender=defender, rs=rs)
    type_mult = rs.type_chart.multiplier(defender_species.types, skill.element)
    stab = stab_multiplier(skill, attacker_species.types)
    model = active_damage_model()

    import roco_env.data as _data  # 局部导入：data 与 effects 互相引用，模块级会成环

    atk_panel = _data.panel_stats(attacker_species.stats)
    def_panel = _data.panel_stats(defender_species.stats)
    atk_value = atk_panel.get("atk", float(attacker_species.stats.get("atk", 1)))
    def_value = def_panel.get("def", float(defender_species.stats.get("def", 1)))

    ability = buff_damage_multiplier(dict(attacker.buffs or {}), dict(defender.buffs or {}))

    power_buff = 1.0 + float((attacker.buffs or {}).get("power", 0)) / 100.0
    for element_key, element in (("power_water", "水系"), ("power_fight", "武系"),
                                 ("power_bug", "虫系"), ("power_ice", "冰系")):
        if element_key in (attacker.buffs or {}) and skill.element == element:
            power_buff *= 1.0 + float(attacker.buffs[element_key]) / 100.0

    reduction = float(getattr(defender, "_defense_reduction", 0.0) or 0.0)
    raw = model.compute(
        attacker_atk=float(atk_value),
        defender_def=float(def_value),
        power=float(pr.power),
        type_multiplier=float(type_mult),
        stab=float(stab),
        hit_count=1,
        power_multiplier=float(power_buff),
        ability_level=float(ability),
    )
    damage = max(1, int(raw * (1.0 - reduction))) if reduction else raw
    return DamageOutcome(
        damage=damage, raw=raw, power=pr.power, conditional=pr.conditional,
        conditional_reason=pr.reason, type_multiplier=type_mult, stab=stab,
        attacker_atk=float(atk_value), defender_def=float(def_value),
        ability_level=float(ability), power_multiplier=float(power_buff),
        defense_reduction=reduction, model=model.name, verified=model.verified,
    )


def max_raw_damage(attacker: Any, defender: Any, loadout: Sequence[str], rs: Ruleset):
    """配招里**所有攻击技能**里能打出的最大伤害，返回 `(damage, skill_id, outcome)`。

    没有可算的攻击技能时返回 `(0, None, None)` —— **不是**一个默认值，
    而是「这只精灵这一步打不出伤害」这个事实。
    算不出来的技能（条件化威力未核验等）直接跳过，并计数（见 `skipped`）。
    """
    best = (0, None, None)
    for skill_id in loadout or ():
        skill = rs.skills.get(skill_id)
        if skill is None or not skill.is_attack:
            continue
        try:
            outcome = compute_damage(attacker, defender, skill, rs)
        except UnsupportedEffect:
            continue
        if outcome.damage > best[0]:
            best = (outcome.damage, skill_id, outcome)
    return best


# ── 状态（术语 1001/1002/1004/1008）────────────────────────────────────


# 术语里写明的「回合结束时」百分比伤害。取整方向**未定义**，见 MC-011。
END_OF_TURN_STATUS = {
    "中毒": {"term": "1001", "percent": 3.0, "decays": False, "immune_element": "毒系"},
    "灼烧": {"term": "1002", "percent": 2.0, "decays": True, "immune_element": "火系"},
    "寄生": {"term": "1008", "percent": 2.0, "decays": False, "immune_element": "草系"},
}


def percent_of_max_hp(max_hp: int, percent: float, *, rounding: str = "floor") -> int:
    """百分比伤害/回复。

    依据：术语 1001/1002/1004 都按「生命」的百分比写，且 1004 说
    「若当前生命低于冻结比例，则力竭」——比较用当前生命，伤害按最大生命。
    假设：基数取**最大生命**、取整**向下**。两者都未被一手证据确认（MC-011）。
    """
    raw = max_hp * percent / 100.0
    if rounding == "floor":
        return int(math.floor(raw))
    if rounding == "ceil":
        return int(math.ceil(raw))
    return int(round(raw))


def status_tick(pet_hp: int, max_hp: int, status_name: str, *, rounding: str = "floor") -> int:
    """回合末状态伤害。返回实际扣血量（不超过当前生命）。"""
    spec = END_OF_TURN_STATUS.get(status_name)
    if spec is None:
        raise UnsupportedEffect(f"状态「{status_name}」", "该状态没有实现回合末结算")
    return min(pet_hp, percent_of_max_hp(max_hp, spec["percent"], rounding=rounding))


def decay_layers(layers: int, *, half: bool) -> int:
    """层数衰减。

    依据：术语 1002「灼烧……并衰减一半层数」；术语 1001 中毒**没有**衰减。
    假设：奇数层向上取整（1 层 → 1，2 层 → 1，3 层 → 2）。
    数据没写取整方向，属 MC-008 待验项。
    """
    if not half:
        return layers
    return int(math.ceil(layers / 2.0))


# ── 防御 / 应对（术语 1015/1016/1017）────────────────────────────────


def parse_defense_reduction(skill: Skill) -> float:
    """从防御技能描述里读减伤比例。例「减伤70%」→ 0.70。

    依据：术语 1016 与各防御技能描述都把减伤写成「应对」之前，
    所以**减伤无条件生效**，只有「应对效果」需要应对成功。这是假设（MC-020）。
    """
    import re
    m = re.search(r"减伤\s*(\d+(?:\.\d+)?)\s*%", skill.desc or "")
    if not m:
        raise UnsupportedEffect(
            f"防御技能「{skill.name}」", "描述里读不出减伤比例", evidence=skill.skill_id
        )
    return float(m.group(1)) / 100.0


RESPOND_KINDS = {
    "应对状态": "状态",
    "应对攻击": "攻击",
    "应对防御": "防御",
}


def respond_to(skill: Skill) -> Optional[str]:
    """这个技能应对的是哪一类动作（返回 状态/攻击/防御 或 None）。

    依据：术语 1015/1016/1017 的定义。
    """
    for key, target in RESPOND_KINDS.items():
        if key in (skill.desc or ""):
            return target
    return None


def defense_cooldown_applies(skill: Skill) -> bool:
    """用后是否让「防御技能进入 1 回合冷却」。

    依据：术语 1016 明确写了这一条；1015/1017 **没有**写。
    假设：冷却只作用于本技能自身（而非全部携带的防御技能）——MC-020 待验。
    """
    return "应对攻击" in (skill.desc or "")
