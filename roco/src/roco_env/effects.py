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
from dataclasses import dataclass, field
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

#: **逐系别的威力增益键**（`buffs` 里 `power_<x>` → 系别）。
#:
#: 抽成一张表是因为写入方必须先问 `element_power_buff_key()` 有没有对应的读点：
#: 写一个 `compute_damage` **不读**的键 = 静默失效，没有读点就 fail closed。
ELEMENT_POWER_BUFF_KEYS: Tuple[Tuple[str, str], ...] = (
    ("power_water", "水系"), ("power_fight", "武系"),
    ("power_bug", "虫系"), ("power_ice", "冰系"),
)

_ELEMENT_POWER_BUFF_BY_ELEMENT: Dict[str, str] = {
    element: key for key, element in ELEMENT_POWER_BUFF_KEYS}


def element_power_buff_key(element: Any) -> Optional[str]:
    """某个系别对应的威力增益键；**没有读点就返回 None**（调用方必须 fail closed）。"""
    return _ELEMENT_POWER_BUFF_BY_ELEMENT.get(str(element)) if element else None


def _pct(buffs: Dict[str, Any], engine_key: str, legacy_up: str, legacy_down: str) -> float:
    """读一个属性的净百分比（小数）。引擎键优先，社区键回落。

    负数统一成负值：`{"atk": -30}` 是物攻 -30%，不是「升高 -30 份」。
    """
    if engine_key in buffs:
        return float(buffs.get(engine_key) or 0.0) / 100.0
    return float(buffs.get(legacy_up, 0.0) or 0.0) + float(buffs.get(legacy_down, 0.0) or 0.0)


def buff_damage_multiplier(attacker_buffs: Dict[str, Any],
                           defender_buffs: Dict[str, Any], *,
                           atk_key: str = "atk", def_key: str = "def") -> float:
    """把双方**这一对**攻/防的增减折成**一个**伤害乘区。

    `(1 + 攻方<atk_key>增减) / max(0.1, 1 + 守方<def_key>增减)`

    ⚠ 2026-09-29（task-25，A 族读点）**改钉**：这两个键过去**写死** `atk` / `def`，
    而 `compute_damage` 从 RC-401 起就按**技能的伤害类别**取面板（`spa/spd` vs `atk/def`，
    `damage.attack_stat_by_class`）⇒ **魔攻技能读的是物攻 buff、守方读的是物防 buff**。
    实测（改前，`tmp/ab-fakegreen.py`）：
        攻方 `spa=+100%` 打魔攻技能 ⇒ damage **101 → 101**（乘区恒 1.0，增益被静默丢掉）
        守方 `spd=+100%` 打魔攻技能 ⇒ damage **101 → 101**
        而 `atk` / `def` 两条照常生效（101 → 202 / 101 → 50）
    ⇒ 11 条技能判据写着 `resolved=True`（`buff_self` 事件也真的发了），
      但**没有任何东西读它** = 假绿。这就是「接上了但不生效」那一族第三次出现。

    默认值仍是 `atk`/`def`：legacy / v2 没声明 `damage.attack_stat_by_class` ⇒ 面板也还取
    `atk`/`def` ⇒ **两边同一对键，逐位不变**（`test_turn_order_fail_closed` 的 golden 指纹守着）。
    这一处**不需要新能力位**：它是那条已声明能力「伤害按技能的伤害类别取」的**漏点补齐** ——
    能力位说的是"结算按类别"，而乘区本来就是这个结算的一部分，只补一半才是缺陷。

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
    atk = _pct(attacker_buffs, atk_key, f"{atk_key}_up", f"{atk_key}_down")
    dfn = _pct(defender_buffs, def_key, f"{def_key}_up", f"{def_key}_down")
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


# ── 攻/防面板的来源：**同一个体投影优先**（Q8 收口，2026-09-30）──────────
#
# 人类逐字：「**肯定要按照最终结算出来应该怎么样就怎么样啊，不能偷懒**」。
#
# 背景：产品那一跳（`src/server/roco-service.js`）把「选中的实例 + 培养快照」发下来
# （`/battle/new` 的 `individuals`），`env._make_pet` 据此用
# `individuals.panel_from_snapshot()` 算出六维存进 `PetState.panel` —— 那就是列表/详情
# （前端 `panelOfIndividual()`）读的**同一份投影**（带版本号 `panel-pvp-60-5star/v1`）。
# 在那之前，战斗回执的六维已经改用这份投影，但**伤害公式仍在读物种的种族值**
# （`data.panel_stats(species.stats)`）⇒ 「面板上写着物攻 125，打出来的却是按 132.6 算的」。
# 这里把那一处接上，让「最终结算」读的是同一个体的同一份面板。
#
# 两条路径**必须能分辨**（回执里带 `stats_source`，与 UI 视图同一套词）：
#   · `pet.panel` 非空 ⇒ 个体快照投影；
#   · 空（legacy / v2 / 不传 `individuals` 的调用方）⇒ **逐字**走老路径，一个字节都不变。

#: 面板来源：个体快照（与列表/详情同一投影）。
PANEL_SOURCE_INDIVIDUAL = "individual-snapshot"
#: 面板来源：种族值路径（`data.panel_stats`，老路径）。
PANEL_SOURCE_SPECIES = "species-race"


def damage_panel_for(pet: Any, species: Any) -> Tuple[Dict[str, Any], str]:
    """这一手结算要用的六维面板 + 它的来源（**同一个体投影优先**）。

    返回 `(面板, 来源)`；来源是 `PANEL_SOURCE_INDIVIDUAL` 或 `PANEL_SOURCE_SPECIES`。
    只有在 `pet.panel` 非空时才用快照那一份 —— 没有快照的老路径（legacy / v2）
    **逐字**仍是 `data.panel_stats(species.stats)`（golden 指纹一个字节不动）。

    ⚠ 快照那一路**原样带着面板里的数值**（不强转 float）：回执要能拿它和列表/详情
    **逐字**对照（人类验收①），`495` 与 `495.0` 在 JSON 里是两个形状。
    """
    panel = getattr(pet, "panel", None)
    if isinstance(panel, dict) and panel:
        out: Dict[str, Any] = {}
        for key, value in panel.items():
            # 布尔是 int 的子类 —— 面板里出现 true/false 是形状错误，不许当 1/0 用。
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            out[str(key)] = value
        if out:
            return out, PANEL_SOURCE_INDIVIDUAL
    import roco_env.data as _data  # 局部导入：data 与 effects 互相引用，模块级会成环
    return _data.panel_stats(species.stats), PANEL_SOURCE_SPECIES


def panel_provenance_of(pet: Any, panel: Dict[str, Any], source: str) -> Dict[str, Any]:
    """一份「这套面板从哪来」的登记（进 `DamageOutcome.panel_provenance`）。

    带**整份六维**（不只是这一手用到的那两项）：回执要能让人拿它和列表/详情**逐值**对照
    （人类验收①：同一个体的两边必须逐值相同）。没有快照的一侧 `individual_id` /
    `projection` 是 `None`，`stats_source` 明确写 `species-race`。
    """
    is_individual = source == PANEL_SOURCE_INDIVIDUAL
    return {
        "stats_source": source,
        "individual_id": getattr(pet, "individual_id", None) if is_individual else None,
        "projection": getattr(pet, "panel_projection", None) if is_individual else None,
        "panel": {str(key): value for key, value in panel.items()},
    }


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
    #: 2026-09-25：天气给的**本手威力系数**（雨天水系 +75% ⇒ 1.75；没有天气 / 没声明 ⇒ 1.0）。
    #: 它已经乘进 `power_multiplier`，这里单独留一份是为了让「这一下的加成从哪来」可追问。
    weather_multiplier: float = 1.0
    weather_note: str = ""
    #: 2026-09-30（Q8 收口）：这一手的攻/防面板**分别**来自哪一套六维，以及用的就是那份面板。
    #: 形状：`{"attacker": {"stats_source": "individual-snapshot"|"species-race",
    #:          "individual_id": str|None, "projection": str|None, "panel": {六维}},
    #:         "defender": {...}}`。
    #: **只在有快照时进回执**（`individual_panel_used()`）—— 没有快照的老路径形状不变。
    panel_provenance: Dict[str, Any] = field(default_factory=dict)

    def individual_panel_used(self) -> bool:
        """这一手有没有用到个体快照投影（任一侧用了就算）。"""
        for side in ("attacker", "defender"):
            if (self.panel_provenance.get(side) or {}).get("stats_source") == PANEL_SOURCE_INDIVIDUAL:
                return True
        return False

    def to_dict(self) -> Dict[str, Any]:
        out = {
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
            "weather_multiplier": round(self.weather_multiplier, 6),
            "weather_note": self.weather_note,
        }
        # 只在真的用了快照时多给一个键：没有快照的老路径，这个字典逐位不变。
        if self.individual_panel_used():
            out["panel_provenance"] = {
                side: dict(self.panel_provenance.get(side) or {}) for side in ("attacker", "defender")}
        return out


def compute_damage(attacker: Any, defender: Any, skill: Any, rs: Ruleset,
                   *, attacker_species: Any = None, defender_species: Any = None,
                   hit_count: int = 1, cfg: Any = None,
                   weather: Any = None) -> DamageOutcome:
    """一次伤害的完整计算。**唯一实现。**

    `attacker` / `defender` 是 `PetState`（要有 `buffs`、`energy`、`hp`）；
    `weather` 是这一局的**场地天气**（`GameState.weather`，`None` = 没有天气）：
    它只按**配置声明的**效果加成（目前是雨天水系技能威力），没声明就什么都不加。
    `*_species` 不给就按 `pet_id` 从规则集查。属性增减**只进一次**（走
    `buff_damage_multiplier`），面板值保持未加成 —— 两边同时乘会把增益约掉。
    """
    attacker_species = attacker_species or rs.pet(attacker.pet_id)
    defender_species = defender_species or rs.pet(defender.pet_id)

    pr = effective_power(skill, attacker=attacker, defender=defender, rs=rs)
    import roco_env.data as _data  # 局部导入：data 与 effects 互相引用，模块级会成环

    try:
        type_mult = rs.type_chart.multiplier(defender_species.types, skill.element)
    except _data.TypeCombinationUnknown as exc:
        # 2026-09-25：双属性按两系**相乘**（人类裁决），但只有快照给出显式行的
        # 86 个组合可查；另外 67 个组合没有数据 ⇒ **不猜**（既不中性、也不用别的组合顶），
        # 如实转成「这个机制没核验」的既有通道。
        raise UnsupportedEffect(
            f"属性相性（{'|'.join(defender_species.types)}）", str(exc),
            "data/roco/normalized/*/types.json（可查组合 = 快照显式行）") from exc
    stab = stab_multiplier(skill, attacker_species.types)
    model = active_damage_model()


    atk_panel, atk_panel_source = damage_panel_for(attacker, attacker_species)
    def_panel, def_panel_source = damage_panel_for(defender, defender_species)
    # 2026-09-23（接手复核）：**攻防要按技能的伤害类别取**，不能永远用物攻/物防。
    # 原来这里写死了 `atk` / `def`，于是**魔攻技能也在用物攻算** —— 实测后果：
    # 物攻高、魔攻低的精灵放魔攻技能伤害虚高（对手一招秒杀就是这么来的），
    # 反过来高魔防的精灵也挡不住魔攻。冻结数据里 `damage_class` 只有两个取值
    # （物攻 / 魔攻），正好对应 (atk, def) 与 (spa, spd)。
    # 拿不到对应面板值就**抛**（fail closed）：宁可拒绝结算，也不拿另一个攻去顶。
    # 这一条**由配置声明**（`damage.attack_stat_by_class`）：legacy / v2 没声明 → 逐位不变
    # （继续用 atk/def），只有显式声明的候选配置才按类别取。这是项目里既有能力声明的同一套做法
    # （见 `damage.multi_hit` / `damage.slot_condition`），也是 `test_turn_order_fail_closed`
    # 那条 golden 指纹要求的：默认路径一个字节都不许动。
    from . import rule_config as _rule_config   # 局部导入：与 data 同理由，避免模块级成环
    # ⚠ 必须读**这一局**的配置：调用方（`env._execute` / 伤害预览）把它传进来；
    # 不传时才退回当前默认配置。第一版只读默认配置，于是候选局里这条修正根本没生效
    # （实测：候选配置声明了 true，魔攻技能仍按物攻算 115）。
    _cfg = cfg if cfg is not None else _rule_config.get_rule_config()
    want_magic = (bool(getattr(_cfg, "damage_attack_stat_by_class", False))
                  and str(getattr(skill, "damage_class", "") or "") == "魔攻")
    atk_key, def_key = ("spa", "spd") if want_magic else ("atk", "def")
    if atk_key not in atk_panel or def_key not in def_panel:
        raise UnsupportedEffect(
            f"伤害结算({atk_key}/{def_key})",
            f"{attacker_species.name} 或 {defender_species.name} 的面板里没有 {atk_key}/{def_key} ——"
            "伤害类别决定用哪一对攻防，缺一个就不许拿另一个顶",
        )
    atk_value = atk_panel[atk_key]
    def_value = def_panel[def_key]
    # 「这一手的面板是从哪来的」—— 攻/防**分别**登记（对手那一侧通常是种族值路径）。
    panel_provenance = {
        "attacker": panel_provenance_of(attacker, atk_panel, atk_panel_source),
        "defender": panel_provenance_of(defender, def_panel, def_panel_source),
    }

    # ⚠ 2026-09-29（task-25）：乘区要读**与面板同一对**键。`atk_key`/`def_key` 由上面
    # 「按伤害类别取面板」那一段算出（魔攻 ⇒ `spa`/`spd`，其余 ⇒ `atk`/`def`）；
    # 不传的话默认正好是 `atk`/`def` ⇒ legacy / v2 逐位不变。历史缺陷见函数 docstring。
    ability = buff_damage_multiplier(dict(attacker.buffs or {}), dict(defender.buffs or {}),
                                     atk_key=atk_key, def_key=def_key)

    power_buff = 1.0 + float((attacker.buffs or {}).get("power", 0)) / 100.0
    # 逐系别的威力增益：键名与系别的对应关系只有 `ELEMENT_POWER_BUFF_KEYS` 一处。
    for element_key, element in ELEMENT_POWER_BUFF_KEYS:
        if element_key in (attacker.buffs or {}) and skill.element == element:
            power_buff *= 1.0 + float(attacker.buffs[element_key]) / 100.0
    # task-28（2026-09-30）：**按系别的持久威力修正**（`PetState.element_power_mods`，系别 → 百分比）。
    # 与上面那条旧路**并行、互不重叠**：旧路认 4 个 `power_*` 键（水/武/虫/冰），新路对**全部系别**通用
    # （`skill_000462 放晴` 的「光系技能威力**永久**+50%」就是它）。**没这个字段 = 不加** ⇒ legacy 逐位不变 ✓
    _epm = float(int((getattr(attacker, "element_power_mods", None) or {}).get(skill.element, 0) or 0))
    if _epm:
        power_buff *= 1.0 + _epm / 100.0

    reduction = float(getattr(defender, "_defense_reduction", 0.0) or 0.0)
    # ── 天气：技能威力加成（2026-09-25 人类裁决「那你就做！」）────────────────
    #
    # 官方 4/14 逐字：「天气是常驻在全场的效果，让对战双方都能获得相应的加成」
    # ⇒ 这是**场地级**的，攻方是谁都一样（雨天给双方的水系技能都 +75%）。
    # 数值**只从配置读**（`policies.weather_policy.effects.<天气>.value`，生成器从
    # battle-modes.json 照抄）：配置没声明天气层 / 没声明这一种天气 ⇒ **什么也不加**，
    # 由调用方（`env`）在别处如实登记「这个机制没声明」，绝不在这里编一个倍率。
    weather_mult, weather_note = weather_power_multiplier(cfg, weather, skill)
    if weather_mult != 1.0:
        power_buff *= weather_mult
    raw = model.compute(
        attacker_atk=float(atk_value),
        defender_def=float(def_value),
        power=float(pr.power),
        type_multiplier=float(type_mult),
        stab=float(stab),
        hit_count=max(1, int(hit_count)),
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
        weather_multiplier=float(weather_mult), weather_note=weather_note,
        panel_provenance=panel_provenance,
    )


def weather_power_multiplier(cfg: Any, weather: Any, skill: Any) -> Tuple[float, str]:
    """天气给的**本手威力系数**（目前只有雨天：水系技能 +75%）。

    返回 `(系数, 说明)`；没有天气 / 配置没声明 / 不是这一系 ⇒ `(1.0, "")`。
    **不抛错**：这是「加成有没有」的读取点，不是「这个机制该不该存在」的判定点 ——
    后者由 `env` 在应用技能效果与回合末结算时按配置判（fail closed 在那边登记）。
    """
    if not isinstance(weather, dict) or cfg is None:
        return 1.0, ""
    name = str(weather.get("name") or "")
    effect = getattr(cfg, "weather_effect", None)
    spec = effect(name) if callable(effect) else None
    if not isinstance(spec, dict) or spec.get("kind") != "skill_power_multiplier":
        return 1.0, ""
    if str(spec.get("element") or "") != str(getattr(skill, "element", "") or ""):
        return 1.0, ""
    value = float(spec.get("value") or 1.0)
    return value, (f"{name}：{spec.get('element')}系技能威力 ×{value}"
                   f"（术语 {spec.get('term_id')}）")


def max_raw_damage(attacker: Any, defender: Any, loadout: Sequence[str], rs: Ruleset,
                   cfg: Any = None):
    """配招里**所有攻击技能**里能打出的最大伤害，返回 `(damage, skill_id, outcome)`。

    没有可算的攻击技能时返回 `(0, None, None)` —— **不是**一个默认值，
    而是「这只精灵这一步打不出伤害」这个事实。
    算不出来的技能（条件化威力未核验等）直接跳过，并计数（见 `skipped`）。
    """
    # `cfg` 一路传下去：伤害类别要不要按 `spa/spd` 取，是**这一局**的配置说了算的。
    from . import rule_config as _rule_config
    cfg = cfg if cfg is not None else _rule_config.get_rule_config()
    best = (0, None, None)
    for skill_id in loadout or ():
        skill = rs.skills.get(skill_id)
        if skill is None or not skill.is_attack:
            continue
        try:
            outcome = compute_damage(attacker, defender, skill, rs, cfg=cfg)
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

    ⚠ 2026-09-29：这条老函数**保持原样**（legacy / v2 逐位不变的守卫，
    `tests/test_microcases.py` 逐值钉着 1→1 / 2→1 / 3→2）。声明了本地状态规则的配置
    走下面的 `layer_decay_by_rule()` —— 两者不要互相改写。
    """
    if not half:
        return layers
    return int(math.ceil(layers / 2.0))


def layered_status_tick(pet_hp: int, max_hp: int, status_name: str, layers: int,
                        spec: Dict[str, Any], *, rounding: Optional[str] = None) -> int:
    """**声明了本地规则**时的回合末状态伤害（2026-09-29，第三轮⑥）。

    规则（逐字来自 `RuleConfig.status_end_of_turn[status]`，不是引擎里猜的）：
        damage = floor(max_hp × (base_percent + per_layer_percent × (层数−1)) ÷ 100)
    再夹到当前生命（`min(pet_hp, damage)`）—— 状态伤害不会把人打成负血。

    为什么按「层数−1」而不是「层数」：`base_percent` 的语义是「1 层时的伤害」，
    `per_layer_percent` 是**每多一层**再加多少。这样 10 层灼烧 = 2% + 9×1% = 11%，
    而 1 层就是 2% —— 与规则文件里写的那个例子逐字对得上。
    """
    if layers < 1:
        return 0
    basis = str(spec.get("tick_damage_basis", "max_hp"))
    if basis != "max_hp":
        raise UnsupportedEffect(f"状态「{status_name}」的结算基数", f"本地规则只支持 max_hp，实际 {basis!r}")
    base = float(spec.get("base_percent", 0.0))
    per_layer = float(spec.get("per_layer_percent", 0.0))
    percent = base + per_layer * max(0, layers - 1)
    raw = max_hp * percent / 100.0
    mode = rounding or str(spec.get("rounding", "floor"))
    if mode == "ceil":
        amount = int(math.ceil(raw))
    elif mode == "round":
        amount = int(round(raw))
    else:
        amount = int(math.floor(raw))
    return min(pet_hp, max(0, amount))


def layer_decay_by_rule(layers: int, spec: Dict[str, Any]) -> int:
    """**声明了本地规则**时的层数衰减（`none` / `half_ceil` / `half_floor`）。

    与老的 `decay_layers(half=True)`（ceil）唯一的区别是多一个 `half_floor`，
    以及「衰减到 0 就是 0」——老函数 `ceil(1/2)=1` 会让灼烧**永不归零**
    （2026-09-29 实测到的真缺陷，本规则用「层数归零**或**回合用尽」修掉）。
    """
    mode = str(spec.get("decay", "none"))
    if mode == "none":
        return layers
    if mode == "half_floor":
        return int(math.floor(layers / 2.0))
    return int(math.ceil(layers / 2.0))


def status_turns_left_after(layers_after: int, turns_left: int) -> int:
    """这一回合末之后还剩几个回合（层数归零时一并归零）。"""
    if layers_after <= 0:
        return 0
    return max(0, int(turns_left) - 1)


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
