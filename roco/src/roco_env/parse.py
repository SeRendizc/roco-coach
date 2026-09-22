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
                                 # cleanse / heal / self_energy / drain_energy / escape / weather
    target: str                  # self / foe
    value: Dict[str, object] = field(default_factory=dict)
    evidence: str = ""           # 原文片段
    term: Optional[str] = None   # 术语 id（若该机制在术语表里有定义）；MC-xxx = 待验项


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
    #: 「N 连击」里静态读到的 N（RC-401）。`None` = 描述里没有静态写法；
    #: 结算时按 1 次处理**只是因为伤害公式的默认值是 1**，绝不当成「已解析出 1 连击」。
    hit_count: Optional[int] = None
    #: 读到 hit_count 的原文片段（出处；没有就是空串）。
    hit_count_evidence: str = ""
    #: C1（第 139 轮）：**号位条件** —— 描述里「本技能位于N号位时 威力+X / 连击+X」。
    #: 结构：`[{"slots": [1], "power_delta": 60, "combo_bonus": 0, "evidence": "…"}]`。
    #: 位置在**构建时已知**（配招有序），所以这是确定性条件，不是猜。
    slot_conditions: List[Dict[str, Any]] = field(default_factory=list)
    #: C1：**传动 N** —— 用后把这个技能在配招里往后/往前移动 N 位（位置机制）。
    #: `None` = 描述里没有这条。
    position_shift: Optional[int] = None
    #: 读到上面两条的原文片段（出处）。
    position_evidence: str = ""

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
_SELF_ENERGY = re.compile(r"自己(?:回复|获得)\s*(\d+)\s*能量")
_DRAIN_ENERGY = re.compile(r"偷取敌方\s*(\d+)\s*能量")
_ESCAPE = re.compile(r"(脱离|返场)")
_WEATHER = re.compile(r"将天气改为([\u4e00-\u9fa5]+)")
_RESPOND = re.compile(r"(应对(?:攻击|状态|防御))[：:](.+?)(?=。|$)")
#: 「N 连击」——**静态**连击数（RC-401 第一条按覆盖收益迁移的原语：67 条技能）。
#: 只认紧挨着的「数字 + 连击」；「连击数+1」「变为3连击」「翻倍」「永久+1」这类**动态**说法
#: 一律进 `unparsed`（见 `parse_skill`），因为它们的取值依赖局面，引擎不能靠猜。
_MULTI_HIT = re.compile(r"(\d+)\s*连击")
#: 动态连击的说法（出现即登记为未实现，绝不当成 1）。
#: 动态连击的说法（出现即登记为未实现，绝不当成静态次数）：
#: 「连击数+1」「连击数永久+1」「连击数翻倍」「变为3连击」。
_DYNAMIC_MULTI_HIT = re.compile(r"连击数[^。，,]{0,6}(?:[+＋]|翻倍|变为)|变为\s*\d+\s*连击")
#: C1：号位条件（只认数据里真实出现的两种效果：威力+X / 连击+X）。
_SLOT_CONDITION = re.compile(
    r"本技能位于\s*(\d)\s*号位?\s*(?:或\s*(\d)\s*号位?)?\s*时[，,]?\s*"
    r"(威力\s*[+＋]\s*(\d+)|连击\s*[+＋]\s*(\d+))")
#: C1：传动 N（用后位移）。
_POSITION_SHIFT = re.compile(r"传动\s*(\d+)")


#: 纯伤害技能描述里**不该**出现的机制词。出现任何一个，它就不是「纯伤害」，
#: 必须走解析路径或如实标未覆盖。
_EXTRA_MECHANIC = (
    "回复", "获得", "消耗", "连击", "印记", "蓄力", "驱散", "免疫", "附带",
    "每", "若", "回合", "层", "影响", "奉献", "随机", "变",
)


def _has_extra_mechanic(desc: str) -> bool:
    return any(word in desc for word in _EXTRA_MECHANIC)


def unclaimed_mechanic_spans(skill) -> List[str]:
    """描述里出现、但**没有被任何解析结果覆盖**的机制词片段。

    为什么需要它：`plain_attack` 与 `unparsed` 都只能回答「这条技能是不是纯伤害」，
    回答不了「哪一段没被处理」。第 46 轮审计发现攻击分支把「造成魔伤，自己回复1能量」
    整条附带效果静默丢掉，就是因为没有任何函数能指出「这段文本没人认领」。
    调用方（`env._execute` 的攻击 / 防御区段）拿它去写 `state.unsupported`。

    判定方式：对每个机制词，找出描述里它的出现位置；如果某个位置落在**任意一条
    已解析效果的 `evidence` 覆盖范围**内，就算已被认领，否则算未认领。
    """
    desc = skill.desc or ""
    parsed = parse_skill(skill)
    covered = [(desc.find(e.evidence), e.evidence) for e in parsed.effects if e.evidence]
    covered = [(i, i + len(t)) for i, t in covered if i >= 0]
    spans: List[str] = []
    for word in _EXTRA_MECHANIC:
        start = 0
        while True:
            idx = desc.find(word, start)
            if idx < 0:
                break
            if not any(lo <= idx < hi for lo, hi in covered):
                # 取该词所在的整条分句，作为给人看的原因
                lo = max(desc.rfind(c, 0, idx) for c in "，。；") + 1
                hi = min([p for p in (desc.find(c, idx) for c in "，。；") if p >= 0] or [len(desc)])
                spans.append(f"{word}：{desc[lo:hi].strip()}")
            start = idx + 1
    return spans


def resolve_position_mechanics(skill, *, slot_declared: bool, shift_declared: bool):
    """C1：按**配置声明的能力**决定号位条件 / 传动是否结算，并返回解析结果。

    与 `resolve_hit_count` 同一套口径：`declared=False`（legacy / v2 没声明）时，
    这两条**照旧留在 `unparsed` 里**被登记为未实现 —— legacy 逐位不变就来自这里。
    声明了才把对应那条标记摘掉（它们已经真的会被结算）。
    """
    parsed = parse_skill(skill)
    drop = []
    if slot_declared and parsed.slot_conditions:
        drop.append("号位")
    if shift_declared and parsed.position_shift is not None:
        drop.append("传动")
    if drop:
        # 按**标记开头**匹配，不要用子串：未认领行的格式是 `{标记}（出现在：…原文…）`，
        # 而原文里常常同时出现别的机制词（例如「…连击+1，传动1。」）—— 用子串会把
        # 「连击」那条一起误摘掉。
        parsed.unparsed = [row for row in parsed.unparsed
                           if not any(str(row).startswith(f"{marker}（") for marker in drop)]
    return parsed


def resolve_hit_count(skill, *, declared: bool) -> "tuple[int, Parsed]":
    """按**配置是否声明了连击能力**决定这一手结算几次，并返回解析结果（RC-401）。

    在 `parse.py` 而不是 `env.py` 里做这件事，有两个理由：
      · 判据只依赖「描述文本 + 一个布尔能力位」，属于解析层的职责；
      · `env.py` 有一道**加载器体积**守卫（防止把配置值内联进去），逻辑留在那边只会
        把守卫逼着往上抬——那是错的方向。

    语义：`declared=False`（legacy / v2 没声明）⇒ 恒定 1 次，且「连击」**照旧留在
    `unparsed` 里**被登记为未实现（legacy 逐位不变就来自这里）；`declared=True` 且描述里
    静态写了 `N连击`（N>1）⇒ 按 N 次结算，并把那一条未实现登记摘掉。动态连击
    （连击数+1 / 变为3连击 / 翻倍）无论声明与否都不结算，仍在 `unparsed` 里。
    """
    parsed = parse_skill(skill)
    if not declared or not parsed.hit_count or parsed.hit_count <= 1:
        return 1, parsed
    # 只摘掉**静态连击**那一条标记；「动态连击数」那一条是**另一件事**（取值依赖局面），
    # 必须继续留在 `unparsed` 里被登记——否则它就变成静默错算了。
    parsed.unparsed = [row for row in parsed.unparsed
                       if "动态" in str(row) or "连击" not in str(row)]
    return int(parsed.hit_count), parsed


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

    # 「自己回复1能量」：**第 47 轮批 0 补上**。以前这条既没被解析、也没被登记，
    # 而攻击分支根本不看描述，于是整条效果被静默丢弃（缺陷，见
    # `roco/tests/test_fail_closed_branches.py`）。
    # 为什么可以解析而不是继续 fail closed：文本是机械可读的，且本仓库自己的
    # 效果清单 `roco/tools/mine_effects.py:267-274` 早就把它登记为 `energy_gain`。
    # 但**时序没有手游证据**：能量上限、回合末回能、技能自带回能的先后顺序
    # 是 MC-007 未解问题（见同一条清单的 note），所以用它时必须带 `assumption`。
    # 「若上回合…自己回复7能量」「敌方每有1层冻结，自己回复1能量」这类**带条件**的
    # 回能，条件本身要么依赖未实现的机制（冻结层数语义），要么依赖回合历史。
    # 无条件地结算会变成**静默错算**，所以这一类不生成效果，转而进 `unparsed`。
    # 判据只看**同一条分句内** match 之前的文字，避免把描述别处的「若」误算进来。
    conditional_gain = False
    for m in _SELF_ENERGY.finditer(desc):
        head = desc[:m.start()]
        clause = re.split(r"[，,。]", head)[-1]
        if any(word in clause for word in ("若", "每有", "每", "当", "如果")):
            conditional_gain = True
    if conditional_gain:
        out.effects = [e for e in out.effects if e.kind != "self_energy"]
        out.unparsed.append(f"条件化回能（出现在：{desc[:40]}）")
    else:
        for m in _SELF_ENERGY.finditer(desc):
            out.effects.append(Effect(kind="self_energy", target="self",
                                      value={"amount": int(m.group(1))},
                                      evidence=m.group(0), term="MC-007"))

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

    # ── 连击（RC-401 第一条按覆盖收益迁移的原语）─────────────────────────────
    # 静态写法（「2连击」）直接读出来；动态写法（「连击数+1」「变为3连击」「翻倍」）**不猜**，
    # 登记成未实现——它们的取值依赖印记层数/应对结果/使用次数，用默认值近似就是静默错算。
    static_hits = _MULTI_HIT.findall(desc)
    if static_hits:
        out.hit_count = max(int(v) for v in static_hits)
        out.hit_count_evidence = _MULTI_HIT.search(desc).group(0)
    if _DYNAMIC_MULTI_HIT.search(desc):
        out.unparsed.append(f"动态连击数（出现在：{desc[:40]}）")

    # ── C1（第 139 轮）：号位条件 + 传动 ─────────────────────────────────────
    # 这两条是一对：实测带「本技能位于N号位」的 5 条技能**全部同时带「传动」**，
    # 所以只做一条解锁 0 条，必须一起做。位置在构建时已知（配招有序），因此是确定性的。
    m = _SLOT_CONDITION.search(desc)
    if m:
        slots = [int(x) for x in (m.group(1), m.group(2)) if x]
        power_delta = int(m.group(4)) if m.group(4) else 0
        combo_bonus = int(m.group(5)) if m.group(5) else 0
        out.slot_conditions.append({
            "slots": slots,
            "power_delta": power_delta,
            "combo_bonus": combo_bonus,
            "evidence": m.group(0),
        })
        # ⚠ **不加 Effect**：加了标记循环就会认为「已覆盖」，未声明能力时也会被当成已解析 ——
        # 那等于让配置里的能力声名形同虚设。结构化信息记在 `slot_conditions` 里，
        # 「未认领」仍由标记循环如实登记，声明了能力才由 `resolve_position_mechanics` 摘掉。
    m = _POSITION_SHIFT.search(desc)
    if m:
        out.position_shift = int(m.group(1))
        out.position_evidence = m.group(0)
        # 同上：传动也只记结构，不假装已覆盖。

    m = _RESPOND.search(desc)
    if m:
        out.respond_clause = m.group(2)

    # 找出没覆盖的机制标记
    for marker in UNPARSED_MARKERS:
        if marker in desc and not any(marker in e.evidence for e in out.effects):
            # 注意：**这里刻意不给「连击」开口子**。`hit_count` 是解析结果，但
            # 「这次的连击能不能结算」取决于**当前配置有没有声明这个能力**（RC-401 的
            # 增量迁移一律走配置声明）。所以未声明时它仍然要出现在 `unparsed` 里、
            # 由引擎如实登记为未实现——那正是 legacy 的逐位不变所依赖的行为。
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
