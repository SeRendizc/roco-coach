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
from typing import Any, Callable, Dict, Optional, Tuple

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


# ── 能力等级（buff 折算）──────────────────────────────────────────────


def ability_level(buffs: Dict[str, int]) -> float:
    """把攻防增减折成一个系数。

    约定 buffs 的键：atk_up / atk_down / def_up / def_down，值为小数（0.4 = +40%）。
    与社区实现一致： (1 + 攻升 + 敌防降) / (1 + 攻降 + 敌防升)。
    **未核验**：增减之间是相加还是相乘，没有一手证据。
    """
    up = float(buffs.get("atk_up", 0.0)) + float(buffs.get("def_down", 0.0))
    down = float(buffs.get("atk_down", 0.0)) + float(buffs.get("def_up", 0.0))
    return (1.0 + up) / max(0.1, 1.0 + down)


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
