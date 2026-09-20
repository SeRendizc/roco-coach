"""技能描述的**结构化解析**。

为什么需要它：手游技能的效果写在中文描述里，而不是结构化的效果字段。
`Skills.lua` 只给了 `desc` 文本，所以「这个技能做什么」只能从文本读。

纪律（和 effects.py 一致）：

  - 只解析描述里**能机械读出**的模式。读不出来就返回 `unparsed`，
    让上层 fail closed，而不是猜一个最接近的效果。
  - 每个解析结果都带 `evidence`：原文片段 + （若有）术语 id。这样
    「引擎为什么这么做」是可追溯的。
  - 解析是**纯函数**，不碰状态。应用效果在 effects.py / env.py 里。

已知未覆盖、必须继续 fail closed 的形态（数量会随数据变化，跑
`python3 -m roco_env.parse` 可以现场复算）：

  - 随机类（「每回合随机变成…」）
  - 选择类（术语 3019「可以从 2 个效果中选择 1 个」的「明/暗」）
  - 传动（术语 1033）与技能位（「位于 1 号或 3 号位时…」）
  - 连击数（术语 3005）
  - 天气（「将天气改为…」）——术语有记载，但本引擎还没有天气层
  - 「应对防御：改为…」的替代效果
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# 属性名 → 内部 buff 键。物攻/魔攻这类是**面板增减**，与 damage 的 atk_up 对应。
STAT_KEYS = {
    "物攻": "atk",
    "魔攻": "spa",
    "物防": "def",
    "魔防": "spd",
    "速度": "spe",
    "全技能威力": "power",
}
COMBO_STAT_KEYS = {
    "双攻": ("atk", "spa"),
    "双防": ("def", "spd"),
}

# 描述里出现这些词，说明该技能带有本解析器**没有**覆盖的机制。
UNPARSED_MARKERS = (
    "随机", "选择", "明", "暗", "传动", "号位", "连击", "天气",
    "眩晕", "沉默", "封印",
)


@dataclass
class Effect:
    """一条被解析出来的效果。"""

    kind: str                    # self_stat / self_mark / foe_stat / foe_status / foe_mark /
                                 # cleanse / heal / drain_energy / escape / weather
    target: str                  # self / foe
    value: Dict[str, object] = field(default_factory=dict)
    evidence: str = ""           # 原文片段
    term: Optional[str] = None   # 术语 id（若该机制在术语表里有定义）


@dataclass
class Parsed:
    """一个技能的解析结果。"""

    skill_id: str
    skill_name: str
    effects: List[Effect] = field(default_factory=list)
    respond_clause: Optional[str] = None      # 「应对攻击：」后面的原文
    unparsed: List[str] = field(default_factory=list)   # 没读懂的原文片段
    fully_supported: bool = False
    #: 描述里没有任何机制、且是带静态威力的攻击技能 —— 走 damage 路径即可，
    #: 属于「完全支持」但不产生 effects。单独标出来是为了让报告能区分
    #: 「靠解析器支持」与「靠伤害路径支持」。
    plain_attack: bool = False

    def kinds(self) -> List[str]:
        return [e.kind for e in self.effects]


_SELF_STAT = re.compile(r"自己获得(双攻|双防|物攻|魔攻|物防|魔防|速度|全技能威力)\s*([+＋])\s*(\d+)%")
_SELF_STAT_MULTI = re.compile(r"自己获得((?:双攻|双防|物攻|魔攻|物防|魔防|速度)(?:和(?:双攻|双防|物攻|魔攻|物防|魔防|速度))?)\s*([+＋])\s*(\d+)%")
_SELF_MARK = re.compile(r"自己获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)")
_FOE_MARK = re.compile(r"敌方获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)")
_FOE_STATUS = re.compile(r"敌方获得\s*(\d+)\s*层\s*(冻结|中毒|灼烧|寄生|引电|萌化)")
_FOE_STAT = re.compile(r"敌方获得(双攻|双防|物攻|魔攻|物防|魔防|速度)\s*([-－])\s*(\d+)%")
_CLEANSE = re.compile(r"驱散敌方所有(增益|减益)|驱散双方所有印记")
_HEAL = re.compile(r"回复\s*(\d+)\s*%?\s*生命")
_DRAIN_ENERGY = re.compile(r"偷取敌方\s*(\d+)\s*能量")
_ESCAPE = re.compile(r"(脱离|返场)")
_WEATHER = re.compile(r"将天气改为([\u4e00-\u9fa5]+)")
_RESPOND = re.compile(r"(应对(?:攻击|状态|防御))[：:](.+?)(?=。|$)")


#: 纯伤害技能描述里**不该**出现的机制词。出现任何一个，它就不是「纯伤害」，
#: 必须走解析路径或如实标未覆盖。
_EXTRA_MECHANIC = (
    "回复", "获得", "消耗", "连击", "印记", "蓄力", "驱散", "免疫", "附带",
    "每", "若", "回合", "层", "影响", "奉献", "随机", "变",
)


def _has_extra_mechanic(desc: str) -> bool:
    return any(word in desc for word in _EXTRA_MECHANIC)


def parse_skill(skill) -> Parsed:
    """解析一条技能。`skill` 需要有 skill_id / name / desc。"""
    desc = skill.desc or ""
    out = Parsed(skill_id=skill.skill_id, skill_name=skill.name)

    for m in _SELF_STAT_MULTI.finditer(desc):
        names = re.split(r"和", m.group(1))
        for name in names:
            keys = COMBO_STAT_KEYS.get(name) or ((STAT_KEYS[name],) if name in STAT_KEYS else ())
            for k in keys:
                out.effects.append(Effect(
                    kind="self_stat", target="self",
                    value={"stat": k, "delta_pct": int(m.group(3))},
                    evidence=m.group(0), term="3014",
                ))

    for m in _SELF_MARK.finditer(desc):
        out.effects.append(Effect(kind="self_mark", target="self",
                                  value={"mark": m.group(2), "layers": int(m.group(1))},
                                  evidence=m.group(0), term="3010"))

    for m in _FOE_MARK.finditer(desc):
        out.effects.append(Effect(kind="foe_mark", target="foe",
                                  value={"mark": m.group(2), "layers": int(m.group(1))},
                                  evidence=m.group(0), term="3010"))

    for m in _FOE_STATUS.finditer(desc):
        status = m.group(2)
        out.effects.append(Effect(kind="foe_status", target="foe",
                                  value={"status": status, "layers": int(m.group(1))},
                                  evidence=m.group(0),
                                  term={"冻结": "1004", "中毒": "1001", "灼烧": "1002",
                                        "寄生": "1008"}.get(status, "3013")))

    for m in _FOE_STAT.finditer(desc):
        keys = COMBO_STAT_KEYS.get(m.group(1)) or ((STAT_KEYS[m.group(1)],) if m.group(1) in STAT_KEYS else ())
        for k in keys:
            out.effects.append(Effect(kind="foe_stat", target="foe",
                                      value={"stat": k, "delta_pct": -int(m.group(3))},
                                      evidence=m.group(0), term="3018"))

    m = _CLEANSE.search(desc)
    if m:
        out.effects.append(Effect(kind="cleanse", target="foe",
                                  value={"what": m.group(1)}, evidence=m.group(0)))

    m = _HEAL.search(desc)
    if m:
        out.effects.append(Effect(kind="heal", target="self",
                                  value={"percent": int(m.group(1))}, evidence=m.group(0)))

    m = _DRAIN_ENERGY.search(desc)
    if m:
        out.effects.append(Effect(kind="drain_energy", target="foe",
                                  value={"amount": int(m.group(1))}, evidence=m.group(0)))

    m = _ESCAPE.search(desc)
    if m:
        out.effects.append(Effect(kind="escape", target="self",
                                  value={"how": m.group(1)}, evidence=m.group(0), term="3009"))

    m = _WEATHER.search(desc)
    if m:
        out.effects.append(Effect(kind="weather", target="foe",   # 天气是场地级
                                  value={"weather": m.group(1)}, evidence=m.group(0)))

    m = _RESPOND.search(desc)
    if m:
        out.respond_clause = m.group(2)

    # 找出没覆盖的机制标记
    for marker in UNPARSED_MARKERS:
        if marker in desc and not any(marker in e.evidence for e in out.effects):
            out.unparsed.append(f"{marker}（出现在：{desc[:40]}）")

    # 「完全支持」有两种来源，以前只认第一种，把第二种整类算成「未覆盖」：
    #   ① 描述里有机制、且全部被解析出来（`out.effects` 非空、`out.unparsed` 为空）；
    #   ② **纯伤害技能**：描述只说「对敌方精灵造成物理/魔法伤害」，
    #      没有任何机制要解析 —— 它走的是 damage 路径（静态威力 + 属性相性 + 本系加成），
    #      引擎实际算得出来。把它算成 unsupported 会让覆盖率严重低估，
    #      也会让工具的 coverage 字段对玩家说假话。
    #   注意「造成物伤，自己回复1能量」**不**属于第二种：描述里有机制（回能），
    #   而回能没有被解析（`_DRAIN_ENERGY` 只认「吸取对方能量」），所以它仍然是
    #   部分/未覆盖 —— 这一条区别是有测试钉住的。
    plain_attack = (
        not out.effects
        and not out.unparsed
        and getattr(skill, "is_attack", False)
        and getattr(skill, "power", None) is not None
        and not _has_extra_mechanic(desc)
    )
    out.fully_supported = (bool(out.effects) and not out.unparsed) or plain_attack
    out.plain_attack = plain_attack
    return out


def coverage_report(skill_ids, rs) -> Dict[str, object]:
    """给定技能集合，报告解析覆盖率。用于回答「引擎现在能处理多少」。"""
    supported, partial, unsupported = [], [], []
    for sid in skill_ids:
        skill = rs.skills.get(sid)
        if skill is None:
            continue
        p = parse_skill(skill)
        if p.fully_supported:
            supported.append(sid)
        elif p.effects:
            partial.append(sid)
        else:
            unsupported.append(sid)
    total = len(supported) + len(partial) + len(unsupported)
    return {
        "total": total,
        "fully_supported": len(supported),
        "partial": len(partial),
        "unsupported": len(unsupported),
        "supported_ids": sorted(supported),
        "partial_ids": sorted(partial),
        "unsupported_ids": sorted(unsupported),
    }


if __name__ == "__main__":   # 现场复算覆盖率
    import os
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from roco_env.data import load_ruleset

    rs = load_ruleset()
    targets = ["pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000112", "pet_000062"]
    pool = set()
    for pid in targets:
        pool |= rs.learnsets[pid].all_skill_ids
    rep = coverage_report(pool, rs)
    print(f"A 组六只技能池并集：{rep['total']} 个技能")
    print(f"  完全可解析: {rep['fully_supported']}")
    print(f"  部分可解析: {rep['partial']}")
    print(f"  完全未覆盖: {rep['unsupported']}")
