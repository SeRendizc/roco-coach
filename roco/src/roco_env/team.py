"""阵容评分的**规则 baseline**（G2）。

纪律（来自 MODEL-GROUP-AND-TASK-MATRIX 的 G2 行与实施书 §6.2）：

  - 输出**分项证据**，不是「战力 87 分所以这队强」。
  - **不输出胜率**。真实天梯胜率需要样本量、段位与版本，本项目没有；
    没有真人 Meta 权重时只能报「在指定对手池下的估计」，而这里连对手池都还没有，
    所以本模块只做**可解释特征**。
  - 每一项特征都要能指向具体数据（哪只精灵、哪个技能、什么速度值），
    让人能反驳它。

六个特征（与 MODEL-GROUP-AND-TASK-MATRIX §4.1 的 coverage 字段对应）：

    types   属性覆盖：队伍能打出多少种属性、被多少种属性克制
    roles   职责覆盖：输出/承伤/控制/回复/驱散 是否有人承担
    speed   速度线：最快/中位/最慢，以及能否抢到先手
    damage  输出类型：物攻/魔攻是否单一（单一容易被单体墙挡住）
    energy  能量循环：低能耗技能占比，能否持续行动
    gaps    明确缺口：缺什么，而不是缺多少分

评分的用途是**排序候选与解释取舍**，不是判定强弱。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import data as _data
from . import parse as _parse
from .data import Ruleset

# 职责 → 判定谓词。谓词只读数据（技能描述 / 分类 / 属性），不做数值推断。
ROLE_RULES = {
    "输出": lambda s: s.is_attack and (s.power or 0) >= 100,
    "承伤": lambda s: s.is_defense,
    "控制": lambda s: bool(_parse._FOE_STATUS.search(s.desc or ""))
                      or "眩晕" in (s.desc or "") or "沉默" in (s.desc or ""),
    "回复": lambda s: bool(_parse._HEAL.search(s.desc or "")) or "吸血" in (s.desc or ""),
    "驱散": lambda s: "驱散" in (s.desc or ""),
    "增益": lambda s: bool(_parse._SELF_STAT_MULTI.search(s.desc or "")),
}


@dataclass
class Feature:
    """一个可解释特征。`evidence` 是具体的精灵/技能 id，供人反驳。"""

    name: str
    value: float
    detail: Dict[str, Any] = field(default_factory=dict)
    evidence: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "value": round(self.value, 4),
                "detail": self.detail, "evidence": self.evidence}


@dataclass
class TeamScore:
    team: List[str]
    features: List[Feature]
    strengths: List[str]
    weaknesses: List[str]
    coverage: Dict[str, float]
    calibration: str = "rule-baseline-no-simulation"
    note: str = (
        "这是规则 baseline 的分项特征，**不是胜率**，也不是天梯强度。"
        "没有指定对手池时，任何整体分数都只是队内自洽性的度量。"
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "team": self.team,
            "features": [f.to_dict() for f in self.features],
            "strengths": self.strengths,
            "weaknesses": self.weaknesses,
            "coverage": self.coverage,
            "calibration": self.calibration,
            "note": self.note,
        }


def _team_skills(rs: Ruleset, team: Sequence[str], loadouts: Optional[Dict[str, Sequence[str]]]) -> Dict[str, List[str]]:
    """每只精灵实际参与评分的技能集合：给了配招就用配招，否则用固有技能。"""
    out: Dict[str, List[str]] = {}
    for pid in team:
        if loadouts and pid in loadouts:
            out[pid] = [s for s in loadouts[pid] if rs.is_learnable(pid, s)]
        else:
            ls = rs.learnsets.get(pid)
            out[pid] = list(ls.native) if ls else []
    return out


def feature_types(rs: Ruleset, team: Sequence[str], skills: Dict[str, List[str]]) -> Feature:
    """属性覆盖：能打出哪些属性、被哪些属性克制。"""
    offence: Dict[str, int] = {}
    for pid in team:
        for sid in skills[pid]:
            el = rs.skills[sid].element
            if el:
                offence[el] = offence.get(el, 0) + 1

    # 弱点：对**全部已知属性**算一遍相性，受 >1 倍即算弱点。
    # 注意：攻击属性集合取自 Types.lua 里出现过的键，而不是只取本规则集 12 只精灵的属性
    # ——否则「被某属性克制」会被队伍构成意外收窄。
    all_elements = set(rs.type_chart.single.keys())
    defence_weak: Dict[str, List[str]] = {}
    for pid in team:
        pet = rs.pet(pid)
        weak = [el for el in sorted(all_elements)
                if rs.type_chart.multiplier(pet.types, el) > 1.0]
        defence_weak[pid] = weak

    all_weak = sorted({w for v in defence_weak.values() for w in v})
    # 值 = 进攻属性种类数 / 被克制属性种类数（后者越少越好，取倒数）
    value = len(offence) / max(1, len(all_weak))
    return Feature(
        name="types",
        value=value,
        detail={
            "offence_elements": sorted(offence),
            "offence_count": len(offence),
            "weak_to": all_weak,
            "weak_count": len(all_weak),
            "per_pet_weak": defence_weak,
        },
        evidence=sorted({sid for pid in team for sid in skills[pid]}),
    )


def feature_roles(rs: Ruleset, team: Sequence[str], skills: Dict[str, List[str]]) -> Feature:
    """职责覆盖：六个职责各由谁承担。"""
    holders: Dict[str, List[str]] = {role: [] for role in ROLE_RULES}
    for pid in team:
        for sid in skills[pid]:
            skill = rs.skills.get(sid)
            if skill is None:
                continue
            for role, pred in ROLE_RULES.items():
                try:
                    if pred(skill):
                        holders[role].append(pid)
                        break
                except Exception:
                    continue
    filled = {r: sorted(set(v)) for r, v in holders.items()}
    covered = sum(1 for v in filled.values() if v)
    return Feature(
        name="roles",
        value=covered / len(ROLE_RULES),
        detail={"covered": filled, "missing": [r for r, v in filled.items() if not v]},
        evidence=sorted({p for v in filled.values() for p in v}),
    )


def feature_speed(rs: Ruleset, team: Sequence[str]) -> Feature:
    """速度线：最快/中位/最慢（面板值，不是种族值）。"""
    speeds = []
    for pid in team:
        panel = _data.panel_stats(rs.pet(pid).stats)
        speeds.append((rs.pet(pid).name, round(panel.get("spe", 0.0), 1)))
    speeds.sort(key=lambda x: -x[1])
    fastest = speeds[0][1] if speeds else 0.0
    slowest = speeds[-1][1] if speeds else 0.0
    median = speeds[len(speeds) // 2][1] if speeds else 0.0
    # 值 = 最快与最慢的跨度 / 最快（越大说明队伍速度分层越明显）
    value = (fastest - slowest) / fastest if fastest else 0.0
    return Feature(
        name="speed",
        value=value,
        detail={"fastest": speeds[0] if speeds else None,
                "median": median, "slowest": speeds[-1] if speeds else None,
                "spread": round(fastest - slowest, 1)},
        evidence=[pid for pid in team],
    )


def feature_damage(rs: Ruleset, team: Sequence[str], skills: Dict[str, List[str]]) -> Feature:
    """输出类型：物攻/魔攻占比。单一类型容易被单体墙挡住。"""
    counts = {"物攻": 0, "魔攻": 0}
    for pid in team:
        for sid in skills[pid]:
            s = rs.skills[sid]
            if s.is_attack and s.damage_class in counts:
                counts[s.damage_class] += 1
    total = sum(counts.values())
    if total == 0:
        return Feature(name="damage", value=0.0,
                       detail={"counts": counts, "note": "所选技能里没有攻击技能"},
                       evidence=[])
    minority = min(counts.values())
    # 值 = 少数派占比的 2 倍（两者均衡时为 1.0）
    value = 2.0 * minority / total
    return Feature(
        name="damage",
        value=value,
        detail={"counts": counts, "total_attacks": total,
                "minority_share": round(minority / total, 3)},
        evidence=sorted({sid for pid in team for sid in skills[pid]
                         if rs.skills[sid].is_attack}),
    )


def feature_energy(rs: Ruleset, team: Sequence[str], skills: Dict[str, List[str]]) -> Feature:
    """能量循环：低能耗（≤2）技能占比。没有低耗技能就转不动。"""
    cheap = 0
    total = 0
    costs: List[int] = []
    for pid in team:
        for sid in skills[pid]:
            s = rs.skills[sid]
            if s.is_trait:
                continue
            total += 1
            costs.append(s.energy)
            if s.energy <= 2:
                cheap += 1
    value = cheap / total if total else 0.0
    return Feature(
        name="energy",
        value=value,
        detail={"cheap_skills": cheap, "total_skills": total,
                "min_cost": min(costs) if costs else None,
                "max_cost": max(costs) if costs else None},
        evidence=sorted({sid for pid in team for sid in skills[pid]}),
    )


def feature_gaps(rs: Ruleset, team: Sequence[str], skills: Dict[str, List[str]],
                 roles: Feature, damage: Feature, energy: Feature) -> Feature:
    """明确缺口：用**文字**说缺什么，而不是扣分。"""
    gaps: List[str] = []
    if roles.detail["missing"]:
        gaps.append("缺职责：" + "、".join(roles.detail["missing"]))
    if damage.value < 0.4:
        dominant = max(damage.detail["counts"], key=damage.detail["counts"].get)
        gaps.append(f"输出类型单一（偏{dominant}），容易被单体墙挡住")
    if energy.value < 0.3:
        gaps.append("低能耗技能太少，能量转不动时容易整回合空过")
    if not any(rs.skills[s].element in ("光系", "恶系", "幻系")
               for pid in team for s in skills[pid]):
        gaps.append("没有光/恶/幻系技能，对幽系等目标缺少针对性")
    return Feature(name="gaps", value=float(len(gaps)), detail={"gaps": gaps}, evidence=[])


def evaluate_team(
    team: Sequence[str],
    *,
    rs: Optional[Ruleset] = None,
    loadouts: Optional[Dict[str, Sequence[str]]] = None,
) -> TeamScore:
    """评估一套阵容，返回分项特征与文字结论。**不返回胜率。**"""
    rs = rs or _data.load_ruleset()
    if len(team) != 3:
        raise ValueError("训练场评估按 3 只队伍进行；完整 6 只阵容在第 5 周扩展")

    skills = _team_skills(rs, team, loadouts)
    f_types = feature_types(rs, team, skills)
    f_roles = feature_roles(rs, team, skills)
    f_speed = feature_speed(rs, team)
    f_damage = feature_damage(rs, team, skills)
    f_energy = feature_energy(rs, team, skills)
    f_gaps = feature_gaps(rs, team, skills, f_roles, f_damage, f_energy)

    strengths: List[str] = []
    if f_types.value >= 1.0:
        strengths.append(f"进攻属性覆盖 {f_types.detail['offence_count']} 种")
    if f_roles.value >= 0.8:
        strengths.append("职责覆盖齐全：" + "、".join(
            r for r, v in f_roles.detail["covered"].items() if v))
    if f_speed.value >= 0.3:
        strengths.append(
            f"速度分层明显（{f_speed.detail['fastest'][0]} {f_speed.detail['fastest'][1]} "
            f"→ {f_speed.detail['slowest'][0]} {f_speed.detail['slowest'][1]}）")
    if f_energy.value >= 0.5:
        strengths.append(f"{f_energy.detail['cheap_skills']} 个低能耗技能，能量循环稳")

    weaknesses = list(f_gaps.detail["gaps"])
    if f_types.detail["weak_count"] >= 4:
        weaknesses.append(f"被 {f_types.detail['weak_count']} 种属性克制，对位面偏窄")

    return TeamScore(
        team=list(team),
        features=[f_types, f_roles, f_speed, f_damage, f_energy, f_gaps],
        strengths=strengths,
        weaknesses=weaknesses,
        coverage={
            "types": round(f_types.value, 3),
            "roles": round(f_roles.value, 3),
            "speed": round(f_speed.value, 3),
            "damage_balance": round(f_damage.value, 3),
            "energy": round(f_energy.value, 3),
        },
    )


def compare_team_change(
    team: Sequence[str],
    replacement: str,
    *,
    drop: Optional[str] = None,
    rs: Optional[Ruleset] = None,
    loadouts: Optional[Dict[str, Sequence[str]]] = None,
) -> Dict[str, Any]:
    """换入一只、换出一只，报告**改善什么、牺牲什么**。

    纪律：这里给的是特征差值，不是「提升 0.09 分」。措辞必须说明代价。
    """
    rs = rs or _data.load_ruleset()
    before = evaluate_team(team, rs=rs, loadouts=loadouts)
    drop = drop or team[-1]
    if replacement in team:
        raise ValueError(f"{replacement} 已经在队伍里")
    new_team = [replacement if p == drop else p for p in team]
    after = evaluate_team(new_team, rs=rs, loadouts=loadouts)

    deltas: Dict[str, float] = {}
    for key in before.coverage:
        deltas[key] = round(after.coverage[key] - before.coverage[key], 3)

    gained = [k for k, v in deltas.items() if v > 0.01]
    lost = [k for k, v in deltas.items() if v < -0.01]
    return {
        "from": rs.pet(drop).name,
        "to": rs.pet(replacement).name,
        "coverage_delta": deltas,
        "improves": gained,
        "costs": lost,
        "before": before.to_dict(),
        "after": after.to_dict(),
        "calibration": "rule-baseline-no-simulation",
        "note": (
            "这是规则特征的变化，**不等于**「换入后更强」。"
            "真正的收益需要用同一对手池的配对模拟验证（尚未实现）。"
        ),
    }
