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

import dataclasses
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
    #: RC-401 批次十二：「每次使用后，本技能<属性>永久±N」。只记结构，**不发 Effect**。
    per_use_ramp: Optional[Dict[str, Any]] = None
    #: RC-401 批次十三：「每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N」。只记结构。
    on_hit_ramp: Optional[Dict[str, Any]] = None
    #: RC-401 批次十一：「若敌方本回合更换精灵，<效果>」的那几条效果（只记结构，不发 Effect）。
    foe_switch_effects: List[Effect] = field(default_factory=list)
    #: 条件子句里**没读出来**的残余（非空 ⇒ 这条技能不许被认领）。
    foe_switch_leftover: str = ""
    #: 条件子句的**原文**（从「若敌方本回合更换精灵」到句末）——认领要盖住「若」「回合」两个机制词，
    #: 所以补出来的效果用它当 `evidence`（它必须能在描述里逐字找到）。
    foe_switch_clause: str = ""
    #: RC-401 批次九：「敌方每有 N 层中毒效果，本技能能耗 -M」。同上：只记结构。
    per_layer_cost: Optional[Dict[str, Any]] = None
    #: RC-401 批次八：「若先于敌方攻击，本次技能威力+N%」。同样**只记结构、不发 Effect**
    #: （未声明能力时那段文本仍要被 `unclaimed_mechanic_spans` 登记为未认领）。
    initiative_power: Optional[Dict[str, Any]] = None
    #: RC-401 批次七：**选择**（术语 3019）的两条分支。结构化的，**不发 Effect** ——
    #: 结算与否由配置能力 `damage.choice_variants` 决定（见 `resolve_choice_variants`）。
    choice_branches: List["ChoiceBranch"] = field(default_factory=list)
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
#: 「获得 N% 吸血」——RC-401 批四。吸血是**造成伤害后按比例回复自己生命**，
#: 不是「回复 N% 生命」（后者是按自己最大生命直接回血），所以必须与 `_HEAL` 分开认。
_LIFESTEAL = re.compile(r"获得\s*(\d+)\s*%\s*吸血")
#: 「每过量回复 N% 生命转化为 M% 物攻」——回复**溢出**部分的转化规则。
#: 单独一条：`_HEAL` 会把「回复5%生命」当成本体回血（**读错语义**），所以下面
#: `_HEAL` 分支要显式跳过被这一条认领的片段。
_OVERHEAL_CONVERT = re.compile(
    r"每过量回复\s*(\d+)\s*%\s*生命转化为\s*(\d+)\s*%\s*(双攻|双防|物攻|魔攻|物防|魔防|速度)")
_HEAL = re.compile(r"回复\s*(\d+)\s*%?\s*生命")
_SELF_ENERGY = re.compile(r"自己(?:回复|获得)\s*(\d+)\s*能量")
_DRAIN_ENERGY = re.compile(r"偷取敌方\s*(\d+)\s*能量")
# 2026-09-25（RC-401 批次六）：**敌方失去能量**（不是"偷取"——没有任何一方获得）。
# 队形级那条必须排在前面：`敌方队伍中所有精灵失去1能量` 里没有"敌方失去"这个连续子串，
# 所以两条正则不会互相抢；但读法要分开（一个是场上那只，一个是全队）。
_FOE_TEAM_ENERGY_LOSS = re.compile(r"敌方队伍中所有精灵失去\s*(\d+)\s*能量")
_FOE_ENERGY_LOSS = re.compile(r"敌方失去\s*(\d+)\s*能量")
# 「应对X：**改为** …」是**条件覆盖**，不是追加：`恶作剧`「敌方失去3能量，应对防御：改为敌方失去6能量」
# 里 3 与 6 互斥。引擎还没有覆盖语义 ⇒ 整条**不许按基础值结算**（否则应对成立时会少算），
# 只把这一段登记为未认领。
_RESPOND_OVERRIDE = re.compile(r"应对(?:状态|攻击|防御)\s*[：:]\s*改为")
_ESCAPE = re.compile(r"(脱离|返场)")
_WEATHER = re.compile(r"将天气改为([\u4e00-\u9fa5]+)")
#: 2026-09-25：天气**持续回合数**也从技能的描述里读（「持续8回合」）。
#: 它是**技能的属性**，不是引擎常量：读不到就写 `turns=None`（不猜一个默认值），
#: 由引擎按配置声明的口径决定怎么办（当前实现：读不到就不接受这一手）。
_WEATHER_TURNS = re.compile(r"持续\s*(\d+)\s*回合")

_RESPOND = re.compile(r"(应对(?:攻击|状态|防御))[：:](.+?)(?=。|$)")
#: 「N 连击」——**静态**连击数（RC-401 第一条按覆盖收益迁移的原语：67 条技能）。
#: 只认紧挨着的「数字 + 连击」；「连击数+1」「变为3连击」「翻倍」「永久+1」这类**动态**说法
#: 一律进 `unparsed`（见 `parse_skill`），因为它们的取值依赖局面，引擎不能靠猜。
_MULTI_HIT = re.compile(r"(\d+)\s*连击")
#: 动态连击的说法（出现即登记为未实现，绝不当成 1）。
#: 动态连击的说法（出现即登记为未实现，绝不当成静态次数）：
#: 「连击数+1」「连击数永久+1」「连击数翻倍」「变为3连击」。
# ⚠ 2026-09-25（第 38 轮实测）：「**改为**N连击」原来不在这一列里 ——
# `疾风刺`（`skill_000689`，描述「造成物伤，1连击，若先于敌方攻击，**改为3连击**。」）
# 于是被读成**恒定 3 连击**：只要用它就白拿三倍伤害，而条件根本没实现。
# 现在「改为/变为/变成 N 连击」一律算动态（不结算，如实登记）。
_DYNAMIC_MULTI_HIT = re.compile(r"连击数[^。，,]{0,6}(?:[+＋]|翻倍|变为)|(?:改为|变为|变成)\s*\d+\s*连击")
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


@dataclass
class ChoiceBranch:
    """「选择：」的一条分支（术语 3019 的「明」或「暗」）。

    `label` 的取法：术语 3019 的原话是「2 个效果视为相同技能，**分别记为「明」和「暗」**」
    —— 按描述里出现的先后，第一条 = 明、第二条 = 暗。社区实机（游戏鸟 2026-08-19 的
    「动态技能抉择」一文，以 `补觉` 为例：选「暗」回 8 能量、选「明」回 25% 生命，
    与 `skill_000373` 的描述「自己回复25%生命或回复8能量」顺序一致）与这条读法对得上。
    ⚠ 这是**推断**（`ENGINE_HYPOTHESIS`），不是一手规则：只有这一条独立样本，
    所以它只写在注释与配置的 `reason` 里，不写进台账当事实。
    """

    label: str                 # 明 / 暗
    text: str                  # 原文片段（去掉「选择：」前缀）
    effects: List[Effect] = field(default_factory=list)
    leftover: str = ""         # 读不出来的残余（空 = 整条读出来了）
    target_from: str = ""      # 目标是从哪来的：explicit / parallel-branch / prior-clause


# ── RC-401 批次七：选择（术语 3019）─────────────────────────────────────────────
#
# 与连击 / 号位 / 传动同一条纪律：**解析层只产出结构，结算由配置能力决定**。
# 描述形如「…，选择：A或B。」，两条分支各自是**片段**（常常省略主语：「物攻+90%」），
# 所以这里用一套**只服务于选择分支**的宽容模式，目标按三条规则定：
#   ① 显式（片段自带 自己/己方 → self；敌方/对手 → foe）；
#   ② 并列省略：同一次选择里**前一条分支**的显式目标（「自己获得速度+60 或 物攻+90%」）；
#   ③ 前文省略：片段以 且/并/额外 开头时，继承「选择：」之前最后一个显式目标
#      （「自己获得速度-20，选择：且额外获得物防+90% 或 魔防+90%」）。
# 三条都不成立 ⇒ 那条分支算**没读出来**（记进 `leftover`，不猜）。
_CHOICE_CLAUSE = re.compile(r"选择：(?P<body>[^。]*)")
#: RC-401 批次八：「若先于敌方攻击，本次技能威力+N%」（冻结语料里实测 1 条战斗技能 + 2 条特性）。
_INITIATIVE_POWER = re.compile(r"若先于敌方攻击[，,]?\s*本次技能威力\s*[+＋]\s*(\d+)\s*%")
#: RC-401 批次九：「**敌方每有 N 层中毒效果，本技能能耗 -M**」（动态能耗修正）。
#: 冻结语料实测只有这一种写法（`skill_000612 毒液渗透`），而它**51 只精灵的配招里都带**——
#: 是可达性工作单上最大的一条。别的「每有N层X效果」写法一律**不认**（没有证据）。
_PER_LAYER_COST = re.compile(r"敌方每有\s*(\d+)\s*层中毒效果[，,]?\s*本技能能耗\s*[-－]\s*(\d+)")
#: RC-401 批次十一：「**若敌方本回合更换精灵**，<效果>」（冻结语料实测 12 条技能 / 46 只精灵带得上）。
#: 只读条件**后面**那一段，并按几种**有把握**的写法逐条读；读不出的片段原样留成 leftover。
_FOE_SWITCH_CLAUSE = re.compile(r"若敌方本回合更换精灵[，,]?\s*(?P<body>[^。]*)")
#: RC-401 批次十二：「**每次使用后，本技能<威力|能耗|连击数>永久±N**」（冻结语料 7 条技能，
#: 其中 `skill_000421 水炮` **25 只精灵的配招里都带**）。
_PER_USE_RAMP = re.compile(r"每次使用后[，,]?\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: RC-401 批次十三：「**每（被攻击1次 / 受到1次抵抗的技能攻击）…本技能<属性>永久±N**」。
#: 实测 3 条：`skill_000500 岩土暴击`（**35 只配招带**）、`skill_000492 微型斥候`、`skill_000494 绞轮`。
_ON_HIT_RAMP = re.compile(
    r"每(?:被攻击1次|受到1次)(?P<qual>抵抗的技能攻击|抵抗伤害)?(?:（不含连击）)?[，,。]?\s*"
    r"本技能(?P<field>威力|能耗|连击数)永久\s*(?P<sign>[+＋\-－])\s*(?P<num>\d+)")
#: 条件后面的效果写法（顺序有意义：先长后短，避免「本次技能威力翻倍」被「威力+N」抢先）。
_FS_FLAT_POWER = re.compile(r"(?:本次(?:技能)?威力|额外获得威力)\s*[+＋]\s*(\d+)")
_FS_MULT_POWER = re.compile(r"本次(?:技能)?威力\s*翻倍")
_FS_ENERGY_GAIN = re.compile(r"自己回复\s*(\d+)\s*点?\s*能量")
_FS_ENERGY_LOSS = re.compile(r"敌方失去\s*(\d+)\s*能量")
_FS_BOTH_STAT = re.compile(r"(?:(自己|己方|敌方|对手)(?:获得)?)?\s*"
                           r"(双攻|双防|物攻|魔攻|物防|魔防|速度)\s*([+＋\-－])\s*(\d+)\s*%")
_CHOICE_CONNECTORS = ("且", "并", "额外", "再", "同时", "或")
_CHOICE_STAT = re.compile(
    r"(?:(?P<side>自己|己方|敌方|对手)(?:获得)?)?\s*"
    r"(?P<stat>双攻|双防|物攻|魔攻|物防|魔防|速度)\s*(?P<sign>[+＋\-－])\s*(?P<num>\d+)\s*%")
_CHOICE_STATUS = re.compile(
    r"(?:(?P<side>自己|己方|敌方|对手)(?:获得)?)?\s*(?P<layers>\d+)\s*层\s*"
    r"(?P<status>冻结|中毒|灼烧|寄生|引电)")
_CHOICE_HEAL = re.compile(r"(?:自己|己方)?\s*回复\s*(?P<num>\d+)\s*%?\s*生命")
_CHOICE_ENERGY = re.compile(r"(?:自己|己方)?\s*(?:回复|获得)\s*(?P<num>\d+)\s*能量")
_SIDE_OF = {"自己": "self", "己方": "self", "敌方": "foe", "对手": "foe"}


def _last_explicit_side(text: str) -> Optional[str]:
    """一段文字里**最后出现**的显式目标（自己一侧 / 敌方一侧）。没有就返回 None。"""
    last, at = None, -1
    for word, side in _SIDE_OF.items():
        pos = text.rfind(word)
        if pos > at:
            last, at = side, pos
    return last


def _parse_choice_branch(text: str, *, inherit: Optional[str],
                         prior: Optional[str]) -> ChoiceBranch:
    """读一条分支片段。`inherit` = 上一条分支的显式目标；`prior` = 「选择：」之前的显式目标。"""
    raw = text.strip()
    leftover = raw
    effects: List[Effect] = []
    target: Optional[str] = None
    source = ""
    # 片段自带主语时，后面的并列子句也继承它（「自己获得速度+60」→ 同一分支内）
    def note_side(side: Optional[str]) -> None:
        nonlocal target, source
        if side:
            target, source = side, "explicit"

    # 三条模式依次在同一段残余上跑；每命中一次就把那段从残余里挖掉
    for _ in range(8):
        changed = False
        m = _CHOICE_STAT.search(leftover)
        if m:
            key = COMBO_STAT_KEYS.get(m.group("stat"))
            keys = key or ((STAT_KEYS.get(m.group("stat")),) if m.group("stat") in STAT_KEYS else ())
            side = _SIDE_OF.get(m.group("side") or "") or target or inherit or (
                prior if raw.startswith(_CHOICE_CONNECTORS) else None)
            # ⚠ 目标判不出来就**不发这条效果**（片段原样留在 leftover 里）——默认成敌方
            # 会把「物攻+90%」变成给对手加攻击，那比不结算更糟。
            if keys and keys != (None,) and side in ("self", "foe"):
                note_side(_SIDE_OF.get(m.group("side") or ""))
                delta = int(m.group("num")) * (-1 if m.group("sign") in "-－" else 1)
                for k in keys:
                    effects.append(Effect(
                        kind="self_stat" if side == "self" else "foe_stat",
                        target="self" if side == "self" else "foe",
                        value={"stat": k, "delta_pct": delta},
                        evidence=m.group(0), term="3014" if side == "self" else "3018"))
                leftover = leftover[:m.start()] + leftover[m.end():]
                changed = True
        m = _CHOICE_STATUS.search(leftover)
        if m:
            side = _SIDE_OF.get(m.group("side") or "") or target or inherit or (
                prior if raw.startswith(_CHOICE_CONNECTORS) else None)
            note_side(_SIDE_OF.get(m.group("side") or ""))
            if side == "foe":
                effects.append(Effect(kind="foe_status", target="foe",
                                      value={"status": m.group("status"), "layers": int(m.group("layers"))},
                                      evidence=m.group(0),
                                      term={"冻结": "1004", "中毒": "1001", "灼烧": "1002",
                                            "寄生": "1008"}.get(m.group("status"), "3013")))
                leftover = leftover[:m.start()] + leftover[m.end():]
                changed = True
        m = _CHOICE_HEAL.search(leftover)
        if m:
            # 「回复 N% 生命」只可能是自己（引擎的 heal 就是自愈）；目标由说法本身决定。
            if target in (None, "self"):
                target, source = "self", source or "form"
                effects.append(Effect(kind="heal", target="self",
                                      value={"percent": int(m.group("num"))},
                                      evidence=m.group(0), term="3001"))
                leftover = leftover[:m.start()] + leftover[m.end():]
                changed = True
        m = _CHOICE_ENERGY.search(leftover)
        if m:
            if target in (None, "self"):
                target, source = "self", source or "form"
                effects.append(Effect(kind="self_energy", target="self",
                                      value={"amount": int(m.group("num"))},
                                      evidence=m.group(0), term="3002"))
                leftover = leftover[:m.start()] + leftover[m.end():]
                changed = True
        if not changed:
            break
    rest = leftover
    for word in _CHOICE_CONNECTORS + ("获得", "，", ",", "。", "：", ":", " "):
        rest = rest.replace(word, "")
    if target is None and not effects:
        rest = raw
    return ChoiceBranch(label="", text=raw, effects=effects,
                        leftover=(rest if rest else ""),
                        target_from=(source if source != "explicit" else "explicit"))


def parse_choice_clause(desc: str) -> List[ChoiceBranch]:
    """把描述里的「选择：A 或 B」拆成两条分支（没有这一段就返回空表）。"""
    m = _CHOICE_CLAUSE.search(desc or "")
    if not m:
        return []
    body = m.group("body").strip().rstrip("。")
    parts = body.split("或")
    if len(parts) != 2:
        return []
    prior = _last_explicit_side((desc or "")[:m.start()])
    first = _parse_choice_branch(parts[0], inherit=None, prior=prior)
    first.label = "明"
    second = _parse_choice_branch(parts[1], inherit=(first.effects and first.effects[0].target) or None,
                                  prior=prior)
    second.label = "暗"
    return [first, second]


def unclaimed_mechanic_spans(skill, parsed: Optional[Parsed] = None) -> List[str]:
    """描述里出现、但**没有被任何解析结果覆盖**的机制词片段。

    为什么需要它：`plain_attack` 与 `unparsed` 都只能回答「这条技能是不是纯伤害」，
    回答不了「哪一段没被处理」。第 46 轮审计发现攻击分支把「造成魔伤，自己回复1能量」
    整条附带效果静默丢掉，就是因为没有任何函数能指出「这段文本没人认领」。
    调用方（`env._execute` 的攻击 / 防御区段）拿它去写 `state.unsupported`。

    判定方式：对每个机制词，找出描述里它的出现位置；如果某个位置落在**任意一条
    已解析效果的 `evidence` 覆盖范围**内，就算已被认领，否则算未认领。
    """
    desc = skill.desc or ""
    # `parsed=` 让调用方能带上**已被声明能力认领**的效果（例如 `initiative_power`），
    # 否则这里重新 `parse_skill` 会把认领结果丢掉、把已结算的机制又登记成未认领。
    parsed = parsed if parsed is not None else parse_skill(skill)
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


def resolve_foe_energy_loss(skill, *, declared: bool, parsed: Optional[Parsed] = None) -> Parsed:
    """按**配置声明的能力**决定「敌方失去 N 能量」这条读法要不要落地（RC-401 批次六）。

    与 `resolve_hit_count` / `resolve_position_mechanics` 同一套纪律：`declared=False`
    （legacy / v2 没声明 `energy.foe_energy_loss`）时，这一段**回到"解析器不认识它"的状态** ——
    既没有效果、也**不补一条未认领标记**。为什么不补标记：这一批之前解析器对这一段什么都不产出，
    legacy 的 `unsupported` 因此与那时候逐位相同（补标记会多出一行，`serialize()` 里就变了）。

    声明了（候选配置）才把效果留给调用方结算。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if declared:
        return parsed
    parsed.effects = [e for e in parsed.effects
                      if e.kind not in ("foe_energy_loss", "foe_team_energy_loss")]
    return parsed


def resolve_position_mechanics(skill, *, slot_declared: bool, shift_declared: bool,
                               parsed: Optional[Parsed] = None):
    """C1：按**配置声明的能力**决定号位条件 / 传动是否结算，并返回解析结果。

    与 `resolve_hit_count` 同一套口径：`declared=False`（legacy / v2 没声明）时，
    这两条**照旧留在 `unparsed` 里**被登记为未实现 —— legacy 逐位不变就来自这里。
    声明了才把对应那条标记摘掉（它们已经真的会被结算）。

    `parsed`：已在手上的解析结果。**必须能传进来**：本函数内部会 `parse_skill(skill)`
    重新解析，而多个能力要一起摘标记时（`coverage.classify_skill` 就是这种调用方），
    后一个解析器会把前一个摘掉的标记又装回去。调用方传 `parsed` 就能把几次认领串成一条链。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
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


def _parse_foe_switch_body(body: str):
    """读「若敌方本回合更换精灵，」之后那一段（返回 `(effects, leftover)`）。

    只认几种**有把握**的写法（每一种在冻结语料里都能指名道姓），并**按描述原文取数**：
      · 「本次技能威力+N」/「额外获得威力+N」 → `foe_switch_power_flat`；
      · 「本次技能威力翻倍」                    → `foe_switch_power_mult`（×2）；
      · 「自己回复N点能量」                     → `self_energy`（顺带修掉「点」字挡住的旧写法）；
      · 「敌方失去N能量」                       → `foe_energy_loss`；
      · 「自己/敌方获得<属性>±N%」              → `self_stat` / `foe_stat`。
    读不出来的残余**原样留下**（调用方据此判定"这条技能没读全"，不许认领）。
    """
    text = str(body or "").strip()
    rest = text
    effects: List[Effect] = []
    m = _FS_MULT_POWER.search(rest)
    if m:
        effects.append(Effect(kind="foe_switch_power_mult", target="self",
                              value={"multiplier": 2}, evidence=m.group(0)))
        rest = rest[:m.start()] + rest[m.end():]
    m = _FS_FLAT_POWER.search(rest)
    if m:
        effects.append(Effect(kind="foe_switch_power_flat", target="self",
                              value={"amount": int(m.group(1))}, evidence=m.group(0)))
        rest = rest[:m.start()] + rest[m.end():]
    m = _FS_ENERGY_GAIN.search(rest)
    if m:
        effects.append(Effect(kind="self_energy", target="self",
                              value={"amount": int(m.group(1))}, evidence=m.group(0), term="3002"))
        rest = rest[:m.start()] + rest[m.end():]
    m = _FS_ENERGY_LOSS.search(rest)
    if m:
        effects.append(Effect(kind="foe_energy_loss", target="foe",
                              value={"amount": int(m.group(1))}, evidence=m.group(0)))
        rest = rest[:m.start()] + rest[m.end():]
    m = _FS_BOTH_STAT.search(rest)
    if m:
        keys = COMBO_STAT_KEYS.get(m.group(2)) or ((STAT_KEYS.get(m.group(2)),)
                                                   if m.group(2) in STAT_KEYS else ())
        side = _SIDE_OF.get(m.group(1) or "") or "self"
        if keys and keys != (None,):
            delta = int(m.group(4)) * (-1 if m.group(3) in "-－" else 1)
            for key in keys:
                effects.append(Effect(kind="self_stat" if side == "self" else "foe_stat",
                                      target="self" if side == "self" else "foe",
                                      value={"stat": key, "delta_pct": delta},
                                      evidence=m.group(0), term="3014" if side == "self" else "3018"))
            rest = rest[:m.start()] + rest[m.end():]
    for word in ("，", ",", "。", "；", ";", "且", "并", " "):
        rest = rest.replace(word, "")
    return effects, rest


def resolve_on_hit_ramp(skill, *, declared: bool,
                        parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十三：按**配置声明的能力**决定「每被攻击1次…永久±N」要不要结算。

    与前面几条同一套口径：`declared=False`（legacy / v2）时那段文本照旧是「未认领机制」；
    声明了才补一条 `on_hit_ramp` 效果（`evidence` 就是原文那段 ⇒ 「每」「连击」那些机制词被同一把尺子判为已认领）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "on_hit_ramp", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "on_hit_ramp" for e in parsed.effects):
        parsed.effects.append(Effect(kind="on_hit_ramp", target="self",
                                     value={"field": str(info["field"]), "delta": int(info["delta"]),
                                            "requires_resisted": bool(info["requires_resisted"])},
                                     evidence=str(info["evidence"])))
        # `微型斥候`/`绞轮` 的「（**不含连击**）」会被标记循环记成一条「连击」未认领 ——
        # 而它已经被这条效果的 evidence 盖住了（那段话就在 `evidence` 里）。
        # 只在**没有别的静态连击要结算**时摘（`hit_count` 为空或 ≤1），避免把真正要结算的连击一起摘掉。
        if "不含连击" in str(info["evidence"]) and not (parsed.hit_count or 1) > 1:
            parsed.unparsed = [row for row in parsed.unparsed
                               if not str(row).startswith("连击（")]
    return parsed


def resolve_per_use_ramp(skill, *, declared: bool,
                         parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十二：按**配置声明的能力**决定「每次使用后，本技能<属性>永久±N」要不要结算。

    与前面几条同一套口径：`declared=False`（legacy / v2）时那段文本照旧是「未认领机制」；
    声明了才补一条 `per_use_ramp` 效果（`evidence` 就是原文那段 ⇒ 「每」那个机制词被同一把尺子判为已认领）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "per_use_ramp", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "per_use_ramp" for e in parsed.effects):
        parsed.effects.append(Effect(kind="per_use_ramp", target="self",
                                     value={"field": str(info["field"]), "delta": int(info["delta"])},
                                     evidence=str(info["evidence"])))
    return parsed


def resolve_foe_switch_condition(skill, *, declared: bool,
                                 parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十一：按**配置声明的能力**决定「若敌方本回合更换精灵」那几条要不要结算。

    与连击 / 号位 / 选择 / 先手条件 / 动态能耗同一套口径：`declared=False`（legacy / v2）时那段文本
    照旧是「未认领机制」；声明了**且条件后面的效果全读出来了**才补 Effect（`evidence` 覆盖整条子句）。
    条件本身在结算时由 `env` 判（对手这一手提交的是不是换人）—— 这里只负责"读得出、认得领"。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared or not getattr(parsed, "foe_switch_effects", None):
        return parsed
    if getattr(parsed, "foe_switch_leftover", ""):
        # 有没读出来的部分 ⇒ **不认领**（宁可这一条不结算，也不按半条规则走）。
        return parsed
    # 打上 `requires` 戳：结算层据此知道**这几条是条件效果**（条件不成立要摘掉、并如实记 skipped）。
    # 已有同种效果（例如描述里本来就写了「敌方失去4能量」）就不重复加。
    clause = str(getattr(parsed, "foe_switch_clause", "") or "")
    for eff in parsed.foe_switch_effects:
        mark = dataclasses.replace(eff, value={**dict(eff.value), "requires": "foe_switch"},
                                   evidence=(clause or eff.evidence))
        if eff.kind in ("foe_switch_power_flat", "foe_switch_power_mult"):
            if not any(e.kind in ("foe_switch_power_flat", "foe_switch_power_mult")
                       for e in parsed.effects):
                parsed.effects.append(mark)
        elif not any(e.kind == eff.kind and e.evidence == eff.evidence for e in parsed.effects):
            parsed.effects.append(mark)
    return parsed


def resolve_per_layer_cost(skill, *, declared: bool,
                           parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次九：按**配置声明的能力**决定「敌方每有 N 层中毒效果，本技能能耗 -M」要不要结算。

    与连击 / 号位 / 选择 / 先手条件同一套口径：`declared=False`（legacy / v2）时这段文本照旧是
    「未认领机制」（`unclaimed_mechanic_spans` 会报「每」「层」两条），引擎写进 `state.unsupported`；
    声明了才补一条 `per_layer_cost` 效果 —— 它的 `evidence` 覆盖**整条子句**（含条件部分），
    于是"已认领"仍由同一把尺子算出来。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "per_layer_cost", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "per_layer_cost" for e in parsed.effects):
        parsed.effects.append(Effect(kind="per_layer_cost", target="self",
                                     value={"status": str(info["status"]),
                                            "layer_step": int(info["layer_step"]),
                                            "delta": int(info["delta"])},
                                     evidence=str(info["evidence"])))
    return parsed


def resolve_initiative_condition(skill, *, declared: bool,
                                 parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次八：按**配置声明的能力**决定「若先于敌方攻击」要不要结算。

    与连击 / 号位 / 传动 / 选择同一套口径：`declared=False`（legacy / v2 没声明）时
    **一个字节都不变** —— 那段文本照旧被 `unclaimed_mechanic_spans` 认作未认领机制，
    由 `env._execute` 如实写进 `state.unsupported`。
    声明了才补一条 `initiative_power` 效果：它的 `evidence` 正好盖住那段原文，
    于是「已认领」这件事**是同一把尺子算出来的**，不是另抄一份白名单。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "initiative_power", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "initiative_power" for e in parsed.effects):
        parsed.effects.append(Effect(kind="initiative_power", target="self",
                                     value={"power_pct": int(info["pct"])},
                                     evidence=str(info["evidence"])))
    return parsed


def resolve_choice_variants(skill, *, declared: bool, parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次七：按**配置是否声明了选择能力**决定「选择」这一条要不要结算。

    与 `resolve_position_mechanics` / `resolve_hit_count` 同一套口径：
      · `declared=False`（legacy / v2 没声明）⇒ 效果**原样收回**，`选择`/`明`/`暗` 三条
        未认领标记**照旧留着**被登记为未实现 —— legacy 的逐位不变就来自这里；
      · `declared=True` 且这一手的分支**两条都读全了**（`leftover` 为空）⇒ 摘掉那三条标记
        （它们真的会被结算）；
      · 声明了但**有分支读不全** ⇒ 标记照旧留着（宁可这一条不结算，也不按半条规则走）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    branches = list(getattr(parsed, "choice_branches", ()) or ())
    if not (declared and branches):
        return parsed
    if any(b.leftover for b in branches):
        # 有分支读不全 ⇒ 保持"未认领"（宁可这一条不结算，也不按半条规则走）。
        return parsed
    # ⚠ **摘标记之前先看整条描述**：选择子句之外还有没有"读出来但记不下"的东西。
    # 实测：`沙石阵` 的主句是「自己获得速度-20」——**平值**修正（不带 %），
    # 解析器与未认领标记表**都不认它**（`_SELF_STAT` 要求百分号，`速度` 也不在
    # `UNPARSED_MARKERS` 里）⇒ 只看选择子句的话会把它算成"整条可结算"，
    # 而引擎其实会静默丢掉那 -20 速度。那是**假可模拟**，比不结算更糟。
    flat = re.findall(r"(?:自己|己方|敌方|对手)?(?:获得)?\s*"
                      r"(?:双攻|双防|物攻|魔攻|物防|魔防|速度)\s*[+＋\-－]\s*\d+(?!\d)(?!\s*%)",
                      str(getattr(skill, "desc", "") or ""))
    flat = [x for x in flat if "获得" in x]
    if flat:
        parsed.unparsed.append(f"平值属性修正（出现在：{'、'.join(flat[:2])}）")
        return parsed
    parsed.unparsed = [row for row in parsed.unparsed
                       if not any(str(row).startswith(f"{marker}（")
                                  for marker in ("选择", "明", "暗"))]
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

    m = _LIFESTEAL.search(desc)
    if m:
        out.effects.append(Effect(kind="self_lifesteal", target="self",
                                  value={"percent": int(m.group(1))}, evidence=m.group(0)))

    m = _OVERHEAL_CONVERT.search(desc)
    if m:
        stat_name = m.group(3)
        keys = COMBO_STAT_KEYS.get(stat_name) or ((STAT_KEYS[stat_name],) if stat_name in STAT_KEYS else ())
        if keys:
            out.effects.append(Effect(kind="overheal_to_stat", target="self",
                                      value={"chunk_pct": int(m.group(1)),
                                             "gain_pct": int(m.group(2)),
                                             "stats": list(keys)},
                                      evidence=m.group(0)))

    # `_HEAL` 只认**本体回血**：把被「每过量回复 N% 生命转化为…」认领的片段排除掉，
    # 否则那条转化规则会被同时读成一次 5% 回血（我第一次跑就踩到了：
    # `贪得无厌` 的 effects 里只有一条 `heal 5%`，而它根本不是回血）。
    heal_text = _OVERHEAL_CONVERT.sub(" ", desc)
    m = _HEAL.search(heal_text)
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

    # 敌方失去能量：分场上一只 / 全队两种读法（见上面两条正则的注释）。
    override = _RESPOND_OVERRIDE.search(desc)
    m_team = _FOE_TEAM_ENERGY_LOSS.search(desc)
    m_foe = _FOE_ENERGY_LOSS.search(desc)
    if m_foe or m_team:
        if override:
            # 条件覆盖存在 ⇒ 基础值不结算（恶作剧那一条），只登记
            out.unparsed.append(
                f"应对覆盖（出现在：{desc[max(0, override.start() - 8):override.end() + 8].strip()}）")
        elif m_team:
            out.effects.append(Effect(kind="foe_team_energy_loss", target="foe",
                                      value={"amount": int(m_team.group(1))}, evidence=m_team.group(0)))
        else:
            out.effects.append(Effect(kind="foe_energy_loss", target="foe",
                                      value={"amount": int(m_foe.group(1))}, evidence=m_foe.group(0)))

    m = _ESCAPE.search(desc)
    if m:
        out.effects.append(Effect(kind="escape", target="self",
                                  value={"how": m.group(1)}, evidence=m.group(0), term="3009"))

    m = _WEATHER.search(desc)
    if m:
        # 天气是场地级（`target="foe"` 是既有形状，语义上「不是自己身上的东西」）。
        # 2026-09-25：把持续回合数一并读出来；读不到就是 None（引擎不许自己补一个 8）。
        turns_match = _WEATHER_TURNS.search(desc)
        out.effects.append(Effect(kind="weather", target="foe",
                                  value={"weather": m.group(1),
                                         "turns": int(turns_match.group(1)) if turns_match else None},
                                  evidence=m.group(0)))

    # ── 连击（RC-401 第一条按覆盖收益迁移的原语）─────────────────────────────
    # 静态写法（「2连击」）直接读出来；动态写法（「连击数+1」「变为3连击」「翻倍」）**不猜**，
    # 登记成未实现——它们的取值依赖印记层数/应对结果/使用次数，用默认值近似就是静默错算。
    # 只数**非动态**的那几处：`改为3连击` / `变为3连击` 属于条件化改写，
    # 拿它当静态值就是"白送"（见 `_DYNAMIC_MULTI_HIT` 上方的实测记录）。
    static_hits = [m.group(1) for m in _MULTI_HIT.finditer(desc)
                   if desc[max(0, m.start() - 2):m.start()] not in ("改为", "变为", "变成")]
    if static_hits:
        out.hit_count = max(int(v) for v in static_hits)
        first = _MULTI_HIT.search(desc)
        out.hit_count_evidence = first.group(0)
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

    # RC-401 批次七：选择（术语 3019）。**只记结构、不发 Effect、不摘标记** ——
    # 与号位/传动同一纪律：能不能结算取决于配置有没有声明 `damage.choice_variants`。
    out.choice_branches = parse_choice_clause(desc)

    # RC-401 批次十三：「每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N」。只记结构。
    _ohr = _ON_HIT_RAMP.search(desc)
    if _ohr:
        out.on_hit_ramp = {"field": {"威力": "power", "能耗": "cost", "连击数": "hits"}[_ohr.group("field")],
                           "delta": int(_ohr.group("num")) * (-1 if _ohr.group("sign") in "-－" else 1),
                           "requires_resisted": bool(_ohr.group("qual")),
                           "evidence": _ohr.group(0)}

    # RC-401 批次十二：「每次使用后，本技能<属性>永久±N」。只记结构（结算时按 pet 上的累计量加）。
    _ramp = _PER_USE_RAMP.search(desc)
    if _ramp:
        out.per_use_ramp = {"field": {"威力": "power", "能耗": "cost", "连击数": "hits"}[_ramp.group(1)],
                            "delta": int(_ramp.group(3)) * (-1 if _ramp.group(2) in "-－" else 1),
                            "evidence": _ramp.group(0)}

    # RC-401 批次十一：「若敌方本回合更换精灵，<效果>」——条件在结算时是**已知事实**
    # （对手这一手提交的就是换人），所以只需要把条件后面的效果读出来。**只记结构、不发 Effect**。
    _fs = _FOE_SWITCH_CLAUSE.search(desc)
    if _fs:
        out.foe_switch_effects, out.foe_switch_leftover = _parse_foe_switch_body(_fs.group("body"))
        out.foe_switch_clause = _fs.group(0)

    # RC-401 批次九：动态能耗修正（「敌方每有N层中毒效果，本技能能耗-M」）。只记结构。
    _plc = _PER_LAYER_COST.search(desc)
    if _plc:
        out.per_layer_cost = {"status": "中毒", "layer_step": int(_plc.group(1)),
                              "delta": -int(_plc.group(2)), "evidence": _plc.group(0)}

    # RC-401 批次八：先手条件（「若先于敌方攻击，本次技能威力+N%」）。同上：只记结构。
    _init = _INITIATIVE_POWER.search(desc)
    if _init:
        out.initiative_power = {"pct": int(_init.group(1)), "evidence": _init.group(0)}

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
