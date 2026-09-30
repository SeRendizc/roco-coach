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
    ⚠ 2026-09-29（task-20 批一）**改钉不删留档**：原文就是这一行，**不改**。
    实情已变——`resolve_respond_override()` 已经把「改为**获得N层**」这一种形状
    （剧毒/天火/毒囊）做成可结算的**覆盖语义**；**其余写法仍然未实现**
    （「改为威力+60」/「改为速度+160」/「改为敌方失去6能量」…）⇒ 这一行继续有效，
    只是范围从"全部"收窄到"除改为获得N层之外的全部"（依据：21 条含「改为」的描述逐条实读，
    见 `resolve_respond_override` 的 `leftover` 分支与 `roco/tests/test_respond_override.py`）。
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
#: **`PetState.buffs_flat` 的键白名单** —— 只有这些键**有读点**（唯一一份，两处调用方共用）。
#:
#: 2026-09-29（`engine-mechanics` 盘点 + Lead 批准）：写入方 `env._apply_effect_batch` 原来
#: **不筛键**（`holder.buffs_flat[str(v["stat"])] = …`），而读取方**全仓只有两处、都只认 `spe`**
#: （`env.order_speed` 的 `_speed_with_buffs` / `order_speed_provenance`）。
#: ⇒ 将来任何「获得物攻+80」（**不带 `%`**）都会：事件照发 `buff_self_flat`、状态照写，
#:   然后**被静默忽略** ✗ —— **"写了没人读"，与 task-25 修的那 11 条是同一族** ✗。
#: 当前命中面：全库平值（不带 `%`）的技能描述 **10 处，全部是「速度」** ⇒ 非 `spe` 平值 **0 处**
#: （⇒ 眼下踩不到，但缺口位置确定 ⇒ 下一条非 spe 平值技能一进语料就静默失效）。
#: ⚠ **不许**把 `spe` 之外的键**静默丢弃**（那是另一种假绿：事件发了、状态没了）——
#: 要么补读点（**要先确认量纲，属新活**），要么**如实报不支持**（fail closed）。
BUFFS_FLAT_READ_KEYS = ("spe",)

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
    #: RC-401 批次十七（2026-09-30 task-26 H 族批一）：「**每应对成功1次 / 应对X：…本技能<属性>永久±N**」
    #: 与「**每次击败敌方，本技能<属性>永久±N**」。只记结构，**不发 Effect** —— 落地与否由配置能力
    #: `damage.triggered_ramp` 决定（与 `per_use_ramp` / `on_hit_ramp` 同一条纪律）。
    #: 结构：`{"trigger": "respond_success"|"defeat_foe", "field": "power"|"cost"|"hits",
    #:        "delta": int, "evidence": "…原文…"}`
    triggered_ramp: Optional[Dict[str, Any]] = None
    #: task-25 B 族（2026-09-30）：「**每使用1次其他<本系>技能** / **每使用过1个其他系别技能**，
    #: 本技能<属性>永久±N」。只记结构，**不发 Effect** —— 落地与否由配置能力
    #: `damage.element_use_ramp` 决定（与 `per_use_ramp`/`on_hit_ramp`/`triggered_ramp` 同一条纪律）。
    #: 结构：`{"scope": "same_element"|"other_element", "element": "普通系"|None,
    #:        "field": "power"|"cost"|"hits", "delta": int, "evidence": "…原文…"}`
    #:   · `same_element` ⇒ 数**同系**的**其它**技能（本技能自己**不算** ✗）；
    #:   · `other_element` ⇒ 数**异系**技能（本技能自己**也不算** ✗）。
    #: 口径取「**次数**」（不是"不同系别个数"）：人类授权「缺参数就在**本地规则**里显式定义」⇒
    #: 由生成器 `damage.element_use_ramp` 的 `reason` 登记为 `ENGINE_HYPOTHESIS`，**改点只有那一处**。
    element_ramp: Optional[Dict[str, Any]] = None
    #: RC-401 批次十一：「若敌方本回合更换精灵，<效果>」的那几条效果（只记结构，不发 Effect）。
    foe_switch_effects: List[Effect] = field(default_factory=list)
    #: 条件子句里**没读出来**的残余（非空 ⇒ 这条技能不许被认领）。
    foe_switch_leftover: str = ""
    #: 条件子句的**原文**（从「若敌方本回合更换精灵」到句末）——认领要盖住「若」「回合」两个机制词，
    #: 所以补出来的效果用它当 `evidence`（它必须能在描述里逐字找到）。
    foe_switch_clause: str = ""
    #: RC-401 批次九：「敌方每有 N 层中毒效果，本技能能耗 -M」。同上：只记结构。
    per_layer_cost: Optional[Dict[str, Any]] = None
    #: RC-401 批次十八（2026-09-30 **E 族缺口二** `446 清洗`）：「**自己**每有 N 层减益，本技能能耗 -M」
    #: —— 与批次九的 `per_layer_cost`（数**对手的中毒**）**同形但数自己** ⇒ 量纲/主体都不同，单独一个字段 ✓。
    #: 与它同一纪律：**只记结构、不发 Effect**（未声明能力时那段照旧是未认领机制 ✓）。
    cost_per_own_debuff_layer: Optional[Dict[str, Any]] = None
    #: RC-401 批次十六（2026-09-29 task-20 批四）：「敌方每有 N 层<中毒效果|印记|星陨印记>，
    #: 本次技能**威力/连击数** +M」。只记结构，**不发 Effect** —— 结算与否由配置能力
    #: `damage.per_layer_boost` 决定（与批次九的 `per_layer_cost` 同一条纪律）。
    #: 结构：`{"field": "power"|"hits", "side": "foe", "source": "中毒"|"印记"|"星陨印记",
    #:        "layer_step": 1, "delta": 10, "evidence": "敌方每有1层中毒效果，本次技能威力+10"}`
    per_layer_boost: Optional[Dict[str, Any]] = None
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
    #: RC-401 批次十四（2026-09-29 task-20）：**「应对X：改为…」的覆盖语义**。
    #: `None` = 描述里没有这条，**或**当前配置没声明 `energy.respond_override`
    #: （未声明时连结构都不产出 ⇒ legacy / v2 的 `unsupported` 与判据逐位不变）。
    #: 结构：`{"respond_to": "防御", "body": "获得8层", "evidence": "应对防御：改为获得8层",
    #:        "mode": "layers", "layers": 8, "effects": [Effect…],
    #:        "replaces_index": 0, "replaces_evidence": "敌方获得3层中毒", "leftover": ""}`
    #: `effects` 是**替换后**要结算的那几条；`replaces_*` 指向被覆盖掉的那条基础效果。
    respond_override: Optional[Dict[str, object]] = None
    def kinds(self) -> List[str]:
        return [e.kind for e in self.effects]


_SELF_STAT = re.compile(r"自己获得(双攻|双防|物攻|魔攻|物防|魔防|速度|全技能威力)\s*([+＋])\s*(\d+)%")
_SELF_STAT_MULTI = re.compile(r"自己获得((?:双攻|双防|物攻|魔攻|物防|魔防|速度)(?:和(?:双攻|双防|物攻|魔攻|物防|魔防|速度))?)\s*([+＋])\s*(\d+)%")
_SELF_MARK = re.compile(r"自己获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)")
_FOE_MARK = re.compile(r"敌方获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)")
_FOE_STATUS = re.compile(r"敌方获得\s*(\d+)\s*层\s*(冻结|中毒|灼烧|寄生|引电|萌化)")
_FOE_STAT = re.compile(r"敌方获得(双攻|双防|物攻|魔攻|物防|魔防|速度)\s*([-－])\s*(\d+)%")
_CLEANSE = re.compile(r"驱散敌方所有(增益|减益)|驱散双方所有印记")
#: 「**印记**的驱散」——与 `_CLEANSE`（增益/减益）**完全分开**（task-27，2026-09-30）。
#: 为什么不并进 `_CLEANSE`：那一条的语义是「清 `buffs` 键名」，**没有层数维度**；
#: 而「层」只存在于 `marks`（`{"星陨印记":3}`）⇒ 两个量纲混在一个 kind 里必然出错
#: （上一手实测：`cleanse{cleared:["spa"]}` 而双方 `marks` 一层没动 ✗）。
#: ⚠ `_CLEANSE` 与 `_EXTRA_MECHANIC` **一个字都不动** —— 它们钉着 legacy golden 指纹。
_CLEANSE_MARKS = re.compile(
    r"驱散\s*(双方|敌方|自己)\s*(所有)?\s*印记")
#: 「每驱散 1 层，<效果>」/「每层印记<效果>」——**消费者**，与 `_CLEANSE_MARKS` 同批实现
#: （分开做会造出"写了没人读"：事件发了 `cleared` 层数却没人用 ✗）。
_PER_CLEANSED_LAYER = re.compile(r"每(?:驱散)?\s*1?\s*层(?:印记)?[，,]?\s*(.+)")
#: 「驱散**自己的减益**」（`洗礼` / `生日蛋糕` / `清洗` / `除厄`）—— C 形状。
#: `_CLEANSE` 只认「驱散**敌方**所有(增益|减益)」⇒ 这四条过去**一条都没被解析**（C 堆）。
#: 与印记分开：这里清的是 `buffs` 里**值为负**的键（减益），量纲是"键名"，不是层数。
_CLEANSE_SELF_DEBUFF = re.compile(r"驱散自己的\s*减益")
#: 「驱散敌方 **1 种** 增益」（`703 飞羽` / `628 溶解`）—— D 形状。
#: ⚠ 与 `_CLEANSE`（「所有」）**分开**：`_CLEANSE` 要求「所有」两个字，这两条**没有** ⇒
#: 过去一条都没被解析（D 堆）。选法 = **清绝对增幅最大的那一个**（本地规则，ENGINE_HYPOTHESIS）：
#: 原始资料只写「驱散 1 种增益」，没有写选哪一种 ⇒ 那是**引擎假设**，事件必须带 `picked`+`basis`
#: （**不许悄悄选** ✗）。**若日后定为别的选法 ⇒ 只改这一处** ✓
_CLEANSE_BUFFS_ONE = re.compile(r"驱散敌方\s*(\d+)?\s*种\s*(增益|减益)")
#: RC-401 批次十八（2026-09-30 **E 族缺口一**）：「驱散敌方 **N 层** 增益/减益」——量纲是**层数** ✗。
#: 与 `_CLEANSE_BUFFS_ONE`（量纲是**键名**，「N 种」）**分开**。
#: 实测 `skill_000322 消毒法`「造成魔伤，驱散敌方5层增益。」在加这一条之前**连一条 effect 都不产出**
#: （`unclaimed=['驱散：驱散敌方5层增益','层：驱散敌方5层增益']` ⇒ 判据 `resolved=False`）。
#: ⚠ 原始资料**没有定义「一层」是多少**（`buffs` 是 `{键名: 百分比}` 的字典，没有层数字段）⇒
#: 选法写成本地规则（`env` 那一支的 `basis` 会如实标注），**与原始资料区分** ✓。
_CLEANSE_BUFFS_LAYERS = re.compile(r"驱散敌方\s*(\d+)\s*层\s*(增益|减益)")
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
#: RC-401 批次十四（2026-09-29 task-20）：覆盖子句的**原文捕获**（`_RESPOND_OVERRIDE`
#: 只回答"有没有"，这里要把「改为」后面那一段读出来）。
_RESPOND_OVERRIDE_BODY = re.compile(
    r"(应对(?P<respond_to>状态|攻击|防御))\s*[：:]\s*改为(?P<body>[^。]*)")
#: 「改为**获得N层**」——主语与状态名全省略，指代**紧邻的那条基础效果**的层数。
#: ⚠ 只认「获得N层」这一种写法：它是描述里唯一能让"层数"独立成参数的形式
#: （`skill_000616 剧毒`「敌方获得3层中毒，应对防御：改为获得8层」）。
#: 别的省略写法（「改为威力+60」「改为速度+160」「改为能耗+3」）**留给后面的批次**，
#: 本批一律当读不出来 ⇒ fail closed 登记，**绝不猜一个数**。
_RESPOND_LAYERS = re.compile(r"获得\s*(\d+)\s*层\s*$")
#: 「应对X：**本技能改为N连击**」/「**变为N连击**」/「**变成N连击**」—— **绝对值**覆盖。
#: 实测三条（都在前 100 只的技能并集里、且都是攻击招）：
#:   `skill_000661 散手`「造成物伤，2连击，应对状态：**本技能改为6连击**。」
#:   `skill_000257 追打`「造成魔伤，1连击，应对状态：**本技能变为3连击**。」
#: ⚠ 与 `_DYNAMIC_MULTI_HIT` 的分工：那一条是"**无条件**的动态连击 ⇒ 不结算"（`疾风刺` 的
#: 「若先于敌方攻击，改为3连击」就是它挡住的）；这里认的是**带「应对X」条件**的那一种 ——
#: 条件在运行时是**已知事实**（`_respond_success` 已经判过），所以可以结算。
_RESPOND_HITS_ABS = re.compile(r"^(?:本技能|本次技能)?\s*(?:改为|变为|变成)\s*(\d+)\s*连击\s*$")
#: 「应对X：**本次技能连击数翻倍**」—— **倍数**覆盖（实测 `skill_000256 连续爪击`）。
_RESPOND_HITS_MULT = re.compile(r"^(?:本技能|本次技能)?\s*连击数翻倍\s*$")
#: 连击覆盖的**入口 ②**：`应对X：` 后面直接就是「本技能改为N连击 / 变为N连击 / 连击数翻倍」，
#: 中间**没有**「改为」紧跟冒号 ⇒ `_RESPOND_OVERRIDE_BODY` 认不到，必须单独一条。
_RESPOND_HITS_CLAUSE = re.compile(
    r"(应对(?P<respond_to>状态|攻击|防御))\s*[：:]\s*"
    r"(?P<body>(?:本技能|本次技能)?\s*(?:(?:改为|变为|变成)\s*\d+\s*连击|连击数翻倍))")
#: **「<系>技能威力永久±N%」**（task-28 · 实测 `skill_000462 放晴`
#: 「**光系技能威力永久+50%**，应对防御：改为永久+100%。」）。
#: 语义：给**该系别**的技能加一份**持久**威力修正 —— 写进 `PetState.element_power_mods` ✓
#: （读点已在 `effects.compute_damage` 里按 `skill.element` 取 ✓，本批只补**写入方**）。
#: ⚠ 系别名**从描述里读全名**（「光系」那种）⇒ 与 `effects.py` 的 key 口径一致 ✓（不自己拼简写 ✗）
#: ⚠ 2026-09-30（本件实测到的 bug ✗）：原来那句 `(?P<element>…{1,2}系)` **会吃掉「获得」的「得」** ✗ ——
#:   `463`「自己获**得光系**技能威力永久+50%」被读成系别 **「得光系」** ✗（真打一手才看到：`element_power_mods={'得光系': 50}` ✗）
#:   ⇒ ⇒ 加 `(?<!得)` 负向后顾 ✓（系别名必须**自成词** ✓ 不从前一个字的尾巴开始 ✗）
#:   ⚠ 影响：`462` 的句子是「光系技能威力永久+50%」（前面是逗号 ✓）⇒ **两种写法都仍命中** ✓（回归可证 ✓）
#: 全库出现过的**系别名**（`skill.element` 的实测取值集合 ✓ **已含「系」** ✗ 正则里别再拼一个 ✓）
_ELEMENT_NAMES = ("光系", "冰系", "地系", "幻系", "幽系", "恶系", "普通系", "机械系", "武系", "毒系",
                  "水系", "火系", "电系", "翼系", "草系", "萌系", "虫系", "龙系")
_ELEMENT_POWER_RAMP = re.compile(
    # ⚠ 2026-09-30（本件实测的两个 bug，都是**真打一手**才看到的 ✗）：
    #   ① 原来写 `(?P<element>[\u4e00-\u9fa5]{1,2}系)` ⇒ `463`「自己获**得光系**技能威力+50%」被读成
    #      系别 **「得光系」** ✗（`element_power_mods={'得光系': 50}` ✗）
    #   ② 我第一版修法用 `(?<![\u4e00-\u9fa5])`（要求系别名**自成词**）⇒ **过度修正** ✗：
    #      「光」前面正是「得」⇒ 连**正确**的「光系」也被挡掉 ⇒ `463` 一个都不命中 ✗
    #      （根因：正则取**最早**匹配位置，「得光系」比「光系」早一个字符 ✓）
    #   ⇒ ⇒ **正确修法 = 显式系别名表** ✓（系别名是**有限集合** ✓ 用 `re.escape` 拼 ✓ 不靠上下文猜 ✗）
    r"(?P<element>" + "|".join(map(re.escape, _ELEMENT_NAMES)) + r")技能威力永久\s*"
    r"(?P<sign>[+＋\-－])\s*(?P<delta>\d+)\s*%")
#: 覆盖体「**改为永久+N%**」—— `_RESPOND_OVERRIDE_BODY` 已经把 `body` 捕出来了，
#: 这一条**只判 body 的形状**（`match` 不是 `search` ✓ 与 `_RESPOND_LAYERS` 同一写法 ✓）。
#: ⚠ 它**不含系别名**：系别**继承**被覆盖的那条基础效果 ⇒ 不在覆盖体里另猜一个 ✗
_RESPOND_ELEMENT_POWER_RAMP = re.compile(r"^永久\s*([+＋\-－])\s*(\d+)\s*%$")
#: **「将自己的<标记>转移给敌方」**（task-28 · 全库只此一条：`skill_000722 反弹`
#: 「将自己的萌化转移给敌方。」）。语义 = **搬家**（`self → foe`，**自己那份清零** ✗ **不是复制** ✗）。
#: ⚠ 描述里**没有层数** ⇒ 搬的就是"自己现有的层数" ⇒ **0 层 = 无事发生** ✓
#: ⇒ 所以它带 `requires:"self_has_mark"`（**条件 = 自己有这个标记** ✓ 与 `736` 的 `foe_switch` 同族 ✓）
_MARK_TRANSFER = re.compile(r"将自己的\s*([\u4e00-\u9fa5]{2,4})\s*转移给敌方")
#: **「<谁>获得萌化：<效果>」**（task-28 · H 族 6 条冒号句构）。
#: 口径 = **顺带（并列）** ✓（Lead 2026-09-30 裁决 ✓ 文档 §2 已登记 ✓）：
#:   「获得萌化」与「<效果>」**两件都做** ✓ · `<效果>` **无条件执行** ✓（不依赖萌化是否生效 ✓）
#: ⚠ **只认"有把握"的 `<效果>`** ✗ —— 实测六条里 `<效果>` **各是不同机制** ✓：
#:   `720 示弱`「速度**永久**+130」⇒ **平值** ✓（`self_stat_flat` ✓ 本批做）
#:   `717`「本次技能威力+60」· `721`「全技能能耗永久-2」· `728`「全技能威力永久+10」⇒ **机制不存在** ✗
#:     ⇒ **一律不产出** ✓（fail closed ✓ 由判据如实点名 ✓ 它们归第 2 批"要新机制"✓）
#:   `723 甜心续航`「回复40%生命」⇒ 走**既有** heal 形状 ✓（本 resolver 只负责"萌化"那半 ✓）
#: 全库出现过的**系别名**（`data` 里 `skill.element` 的取值集合 ✓ 实测导出 ✓ 不手写猜测 ✗）
_MOE_COLON = re.compile(r"(?P<who>自己和敌方|自己|敌方)获得萌化\s*[：:]\s*(?P<body>[^。]*)")
#: 冒号体「速度**永久**+N」= **平值**（不带 `%` ✓ ⇒ `buffs_flat` 量纲 ✓ 与 `:1884` 写点一致 ✓）
_MOE_COLON_FLAT_STAT = re.compile(r"(速度|物攻|魔攻|物防|魔防)永久\s*([+＋\-－])\s*(\d+)\s*$")
#: 冒号体「**本次技能威力+N**」= **本手平值威力加成**（task-28 · `717 超级糖果`）。
#: ⚠ 与 `721`「**全技能**威力永久+10」/`728` **作用域不同** ✗ —— 本条是"**本次**"（本手 ✓）
#:   ⇒ 语义 = `skill.power += N`（`env` 里 `foe_switch_power_flat` 那两个先例**正是这么做的** ✓）。
_MOE_COLON_THIS_POWER = re.compile(r"本次技能威力\s*([+＋\-－])\s*(\d+)\s*$")
#: 冒号体「**回复N%生命**」—— 这一半**由既有 heal 路径结算** ✓（`723 甜心续航` 裸解析就已产出 `heal{percent:40}` ✓）
#: ⇒ 本条**不需要**新机制 ✓ ⇒ 只要它被认出来，就可以放行"授予"那半 ✓（两半都真的会结算 ⇒ 不算假绿 ✓）
_MOE_COLON_HEAL = re.compile(r"回复\s*(\d+)\s*%\s*生命\s*$")
#: 冒号体「**全技能能耗永久-N**」（`721 赤子之心`）/「**全技能威力永久+N**」（`728 撒娇`）。
#: ⚠ **作用域 = 所有技能** ✗ ⇒ 写 `PetState.global_skill_mods` ✓（**不是** `skill_ramps` ✗ 那是逐技能 ✓）。
#: ⚠ `721` 的下界口径（Lead 2026-09-30 裁决 ✓）：**能减多少减多少、但不为负**（`max(0, base+delta)` ✓）
#:   ⇒ **不改 MC-018 的既有守卫** ✓（那条守卫是别人立的、当时明确写了"不猜一个 0" ✗）
#:   ⇒ ⚠ **改点**：若人类改判为"夹到 0"或"抛错" ⇒ **只改 `env.effective_skill_cost` 那一处** ✓
_MOE_COLON_GLOBAL = re.compile(r"全技能(威力|能耗)永久\s*([+＋\-－])\s*(\d+)\s*%?\s*$")
#: **「（自己）有减益时，本次技能威力+N」**（task-28 · 第 2 批 `724 破罐破摔`）。
#: ⚠ **与 `717` 的关系**：**加成那半完全一样**（都是本手平值威力 ✓ 复用 `self_power_flat` ✓）；
#:   **只有"条件"那一半不同** ✗ —— 本条是**条件式** ⇒ 效果必须带 `requires:"self_has_debuff"` ✗
#:   （否则条件门认不出 ⇒ **无条件结算** ✗ —— `736` 的教训 ✓）
_SELF_DEBUFF_POWER = re.compile(r"(?:自己)?有减益时\s*[，,]?\s*本次技能威力\s*([+＋\-－])\s*(\d+)")


_ESCAPE = re.compile(r"(脱离|返场)")
_WEATHER = re.compile(r"将天气改为([\u4e00-\u9fa5]+)")
#: 2026-09-25：天气**持续回合数**也从技能的描述里读（「持续8回合」）。
#: 它是**技能的属性**，不是引擎常量：读不到就写 `turns=None`（不猜一个默认值），
#: 由引擎按配置声明的口径决定怎么办（当前实现：读不到就不接受这一手）。
_WEATHER_TURNS = re.compile(r"持续\s*(\d+)\s*回合")

_RESPOND = re.compile(r"(应对(?:攻击|状态|防御))[：:](.+?)(?=。|$)")
#: 「应对状态：**本次技能**威力变为3倍」/「…**本次技能**威力翻倍」。两条纪律：
#:   · **必须**是「本次技能威力」——「应对攻击：**下次**攻击技能威力翻倍」（淬火）是给**下一手**
#:     的增益，运行时**没有**这一支（`compute_damage` 的应对分支改的是**这一手**的 power）
#:      ⇒ 认领它就是谎报"已结算"（`test_effect_coverage` 的反证①当场抓到过这一条）；
#:   · 「应对状态：改为3连击」那种是改**效果**（`_RESPOND_OVERRIDE` 管），两者别混。
_RESPOND_POWER = re.compile(
    r"应对(?:状态|攻击|防御)\s*[：:][^。；，]*?本次技能威力(?:变为\s*(\d+(?:\.\d+)?)\s*倍|翻倍)")
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
    r"(威力\s*[+＋]\s*(\d+)|连击\s*[+＋]\s*(\d+)"
    # task-28（2026-09-30）：**第三种形状** —— 「**额外获得<属性>+N%**」（`skill_000483 啮合传递`）
    # ⚠ 前两种的组号（4=威力 / 5=连击）**一个都没动** ✓；新增的 stat/百分比落在 **6 / 7** ✓
    r"|额外获得\s*(物攻|魔攻|物防|魔防|速度)\s*[+＋]\s*(\d+)\s*%?"
    # RC-401 批次十八（2026-09-30 F 族）：**第四种形状**「号位时**能耗-N**」（`skill_000481 齿轮切开`）
    # ⚠ 前三组的组号（4/5/6/7）**一个都没动** ✓；能耗落在 **组 8** ✓。
    # RC-401 批次十八（2026-09-30 F 族）：**第五种形状**「号位时**额外减伤N%**」（`skill_000491 相位移动`）
    # ⚠ 前缀必须是**「额外减伤」**（不是「减伤」）—— 子句外还有「减伤50%」，`re.search` 只取第一个匹配 ✗。
    # ⚠ **#42**：本分支**以 `|` 开头、不以 `)` 结尾** ⇒ 闭合括号**天然仍在最后一条行尾** ✓。
    r"|额外减伤\s*(\d+)\s*%"
    r"|能耗\s*[-－]\s*(\d+))")
#: task-28：号位条件里「额外获得<属性>+N%」的属性名 → `PetState.buffs` 键。**只有这一份** ✓
#: （与 `stat_gain` 那条链的键名一致：atk/spa/def/spd/spe ✓ ⇒ 读点也就是现成的那些 ✓）
_SLOT_STAT_BY_NAME = {"物攻": "atk", "魔攻": "spa", "物防": "def", "魔防": "spd", "速度": "spe"}

#: C1：传动 N（用后位移）。
_POSITION_SHIFT = re.compile(r"传动\s*(\d+)")


#: 纯伤害技能描述里**不该**出现的机制词。出现任何一个，它就不是「纯伤害」，
#: 必须走解析路径或如实标未覆盖。
_EXTRA_MECHANIC = (
    "回复", "获得", "消耗", "连击", "印记", "蓄力", "驱散", "免疫", "附带",
    "每", "若", "回合", "层", "影响", "奉献", "随机", "变",
    # ⚠ 2026-09-29（task-18 A 批）**回退留档**：这一轮曾在这里加过 "应对" / "迅捷" 两个词，
    # 想让「应对…：<没结算的子句>」能被点出来（`skill_000383 持续高温` 那种假已通）。
    # 但 `_EXTRA_MECHANIC` 是**运行时** `unclaimed_mechanic_spans()` 用的同一张表 ⇒
    # 加词就改了 legacy 的 `state.unsupported`，两条 golden 指纹（`test_turn_order_fail_closed`）
    # 立刻变红 —— 违反"legacy 逐位不变"。**回退**，改用**不碰这张表**的办法：
    # 见 `coverage.settlement_verdict()`（诊断口径）与 `parse.respond_claim_*`（只认已结算的子句）。
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
#: task-28（2026-09-30）：**「若先于敌方攻击，改为N连击」**（`skill_000689 疾风刺`）——
#: 与上面那条**同族、同一个落点**（`parsed.initiative_power` / 同一个 `initiative_power` effect kind ✓）。
#: ⚠ **不新造 kind** ✗：新 kind 只会在 `_apply_effect_batch` 里变成没人读的东西（ⓐ）✓
_INITIATIVE_HITS = re.compile(r"若先于敌方攻击[，,]?\s*改为\s*(\d+)\s*连击")
#: RC-401 批次九：「**敌方每有 N 层中毒效果，本技能能耗 -M**」（动态能耗修正）。
#: 冻结语料实测只有这一种写法（`skill_000612 毒液渗透`），而它**51 只精灵的配招里都带**——
#: 是可达性工作单上最大的一条。别的「每有N层X效果」写法一律**不认**（没有证据）。
_PER_LAYER_COST = re.compile(r"敌方每有\s*(\d+)\s*层中毒效果[，,]?\s*本技能能耗\s*[-－]\s*(\d+)")
#: RC-401 批次十六（2026-09-29 task-20 批四）：「**敌方每有 N 层<来源>，本次<技能|攻击>威力/连击数 +M**」。
#: 与批次九那条**同一族**（都是"读一个已知的层数 → 改这一手的数值"），但改的是**本手**的
#: 威力/连击（在 `compute_damage` 的入参上），不是能耗。冻结语料实测三条：
#:   `skill_000623 鸩毒`     「…**敌方每有1层中毒效果**，本次技能威力+10，应对状态：改为本次威力+40。」
#:   `skill_000825 天体吸积` 「…**敌方每有1层印记**，本次攻击威力+20。」
#:   `skill_000808 多维击打` 「…**敌方每有1层星陨印记**，本次技能连击数+1。」
#: ⚠ 来源三种要分开读（`星陨印记` 必须排在 `印记` 前面，否则会被前缀吃掉）；
#: `双方携带的所有精灵每有1层萌化`（`skill_000731 月光合奏`）**不认** —— 萌化本身还没实现（C 堆）。
_PER_LAYER_POWER = re.compile(
    r"敌方每有\s*(\d+)\s*层(星陨印记|中毒效果|印记)[，,]?\s*"
    r"本次(?:技能|攻击)威力\s*[+＋]\s*(\d+)")
_PER_LAYER_HITS = re.compile(
    r"敌方每有\s*(\d+)\s*层(星陨印记|中毒效果|印记)[，,]?\s*"
    r"本次技能连击数\s*[+＋]\s*(\d+)")
#: RC-401 批次十一：「**若敌方本回合更换精灵**，<效果>」（冻结语料实测 12 条技能 / 46 只精灵带得上）。
#: 只读条件**后面**那一段，并按几种**有把握**的写法逐条读；读不出的片段原样留成 leftover。
_FOE_SWITCH_CLAUSE = re.compile(r"若敌方本回合更换精灵[，,]?\s*(?P<body>[^。]*)")
#: RC-401 批次十二：「**每次使用后，本技能<威力|能耗|连击数>永久±N**」（冻结语料 7 条技能，
#: 其中 `skill_000421 水炮` **25 只精灵的配招里都带**）。
_PER_USE_RAMP = re.compile(r"每次使用后[，,]?\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: task-25 B 族（2026-09-30）：**「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，
#: 本技能<威力|能耗|连击数>永久±N」**。冻结语料实测**只有三条**，正是本批的三条：
#:   `skill_000270 蓄能轰击`「每使用1次**其他普通系**技能，本技能能耗永久-2」
#:   `skill_000343 光能聚集`「每次使用**其他草系**技能后，本技能威力永久+60」
#:   `skill_000450 过曝`    「每使用过1个**其他系别**技能，本技能威力永久+30」
#: ⚠ 三条的**共同语义核心是「其他」**（不能数本技能自己 ✗）—— 落地在 `env` 的两个累加点里。
#: `系别` 放在第一个分支：`[一-龥]{1,3}系` 也会匹配它 ⇒ 靠**有序择一**让 `系别` 胜出 ✓。
_ELEMENT_USE_RAMP = re.compile(
    r"每[^，。；]{0,10}?其他\s*(?P<elem>系别|[一-龥]{1,3}系)\s*技能[^，。；]{0,4}?[，,]?\s*"
    r"本技能\s*(?P<stat>威力|能耗|连击数)\s*永久\s*(?P<sign>[+＋\-－])\s*(?P<num>\d+)")
#: B 族的**条件句闸**（与 `_STAT_GAIN_GUARDS` 同一套）：命中之前同句里出现这些词 ⇒ 不认领
#: （那一类要的是新的结算支，不是放宽正则 ✗）。
_ELEMENT_RAMP_GUARDS = ("若", "选择", "应对", "期间", "或")
#: RC-401 批次十三：「**每（被攻击1次 / 受到1次抵抗的技能攻击）…本技能<属性>永久±N**」。
#: 实测 3 条：`skill_000500 岩土暴击`（**35 只配招带**）、`skill_000492 微型斥候`、`skill_000494 绞轮`。
_ON_HIT_RAMP = re.compile(
    r"每(?:被攻击1次|受到1次)(?P<qual>抵抗的技能攻击|抵抗伤害)?(?:（不含连击）)?[，,。]?\s*"
    r"本技能(?P<field>威力|能耗|连击数)永久\s*(?P<sign>[+＋\-－])\s*(?P<num>\d+)")
#: RC-401 批次十七（2026-09-30 task-26 H 族批一）：**「每应对成功1次，本技能<属性>永久±N」**
#: （实测 `skill_000267 能量刃`「每应对成功1次，本技能威力永久+90」·
#:   `skill_000679 叠势`「每成功应对1次，本技能连击数永久+2」—— 两种语序都认）。
_TRIGGERED_RESPOND_RAMP = re.compile(
    r"每(?:应对成功|成功应对)\s*\d*\s*次[，,]?\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: 同上，但写成**应对子句**（没有「每次」前缀）：「应对状态：本技能能耗永久-3」
#: （实测 `skill_000422 水刃` / `skill_000423 天洪`）。
_RESPOND_CLAUSE_RAMP = re.compile(
    r"应对(?:状态|攻击|防御)\s*[：:]\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: **复合应对子句的尾巴**：「应对X：<别的效果>，且本技能<属性>永久±N」
#: （task-28 · 实测 `skill_000289 无畏之心`「减伤100%，**应对攻击：减免的伤害变为回复自己生命，且本技能能耗永久+2**。」）
#: ⚠ 上面那条 `_RESPOND_CLAUSE_RAMP` 要求"永久±N"**紧跟冒号** ✗ ⇒ 复合句里的尾巴匹配不到 ✗
#: ⇒ 这一条**只放宽"中间还有别的效果 + 且"**，不放宽触发条件（仍要求描述里写明应对类别 ✓
#:    —— `_RESPOND_KIND_IN_DESC` 那道可判定性闸照旧在先 ✓）
_RESPOND_CLAUSE_RAMP_TAIL = re.compile(
    r"应对(?:状态|攻击|防御)\s*[：:][^。]*?[，,]\s*(且\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+))")
#: **「每次击败敌方，本技能<属性>永久±N」/「若击败敌方，本技能<属性>永久±N」**
#: （实测 `skill_000382 流星火雨` / `skill_000792 趁火打劫`）。
_TRIGGERED_DEFEAT_RAMP = re.compile(
    r"(?:每次击败敌方|若击败敌方)[，,]?\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: **「回合结束时，本技能<属性>永久±N」**（task-26 H 族批二 · 3 条：`skill_000432 水波术` 威力+20 ·
#: `skill_000252 冲撞` 能耗-1 · `skill_000503 抛石` 能耗-5）。触发条件**确定可判**（回合末一定会到）✓
_TRIGGERED_END_TURN_RAMP = re.compile(
    r"回合结束时[，,]?\s*本技能(威力|能耗|连击数)永久\s*([+＋\-－])\s*(\d+)")
#: 「应对成功」这一类触发器的**可判定性前提**：描述里必须写了应对类别
#: （`effects.RESPOND_KINDS` 认的就是这三个词）。没写 ⇒ `respond_to()` 返 None ⇒ 永远判不出成功 ⇒
#: 不许认领（见 `parse_skill` 里那段注释与 `skill_000267/000679` 的实测）。
_RESPOND_KIND_IN_DESC = re.compile(r"应对(?:状态|攻击|防御)")
#: 条件后面的效果写法（顺序有意义：先长后短，避免「本次技能威力翻倍」被「威力+N」抢先）。
_FS_FLAT_POWER = re.compile(r"(?:本次(?:技能)?威力|额外获得威力)\s*[+＋]\s*(\d+)")
_FS_MULT_POWER = re.compile(r"本次(?:技能)?威力\s*翻倍")
_FS_ENERGY_GAIN = re.compile(r"自己回复\s*(\d+)\s*点?\s*能量")
_FS_ENERGY_LOSS = re.compile(r"敌方失去\s*(\d+)\s*能量")
#: **「（本次攻击）使敌方获得<状态>」**（task-28 · `skill_000736 转圈圈`
#: 「造成魔伤，若敌方本回合更换精灵，**本次攻击使敌方获得萌化**。」）。
#: ⚠ 与 `285` 的「获得**1层**萌化」**不是同一措辞**（这条**不带层数** ✓ 也不带"敌方"以外的方向词 ✓）。
#: ⚠ **层数默认 1** —— 这是**本地规则**（描述没写层数 ⇒ 按人类授权显式定义并与原始资料区分 ✓）；
#:   与 `285`/`732` 明写的「1层」一致 ✓ ⇒ 生成器 `reason` 里登记 ✓ 并留改点 ✓。
_FS_GRANT_STATUS = re.compile(r"(?:本次攻击)?\s*使敌方获得\s*([\u4e00-\u9fa5]{2,4})")
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
    # RC-401 批次十四（2026-09-29 task-20）：「应对X：改为…」被解析成**覆盖效果**之后，
    # 那一段里的机制词（实测「改为获得8层」里的「获得」）就不再是"没人认领"的了。
    # ⚠ 只有 `respond_override` 非空（= 配置声明了能力、且这一段真的读出来了）时才补 ——
    # 未声明 / 读不出来时列表为空，legacy 的 `unsupported` 逐位不变 ✓
    for _ov_eff in ((getattr(parsed, "respond_override", None) or {}).get("effects") or []):
        if getattr(_ov_eff, "evidence", ""):
            covered.append((desc.find(_ov_eff.evidence), _ov_eff.evidence))
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


_GLOBAL_SKILL_MOD = re.compile(r"(?:并)?获得\s*全技能(威力|能耗)\s*([+＋\-－])\s*(\d+)\s*%?")


def resolve_global_skill_mod(skill, *, declared: bool, parsed: Optional[Parsed] = None) -> Parsed:
    """「（并）获得全技能{威力|能耗}±N」——**非冒号体**的全技能级修正（RC-401 批次十九 · 2026-09-30）。

    与 `resolve_cleanse_marks` **同一套纪律**：`declared=False` 时**什么都不产出** ⇒
    `state.unsupported` 与 golden 指纹逐位不变。
    与 `_MOE_COLON_GLOBAL`（冒号体 ✓）**互斥**：实测同一 `_body` 上两条都命中 = **0**（分母 860 ✓）。
    产出 kind 与 `:861` 那条链**完全一致**（`global_cost_delta` / `global_power_pct`）⇒
    结算侧（`env.py:2008`/`:2745`/`:2893`）**一个字不用改** ✓。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    desc = skill.desc or ""
    m = _GLOBAL_SKILL_MOD.search(desc)
    if m:
        _kind = "global_cost_delta" if m.group(1) == "能耗" else "global_power_pct"
        if not any(getattr(e, "kind", "") == _kind for e in parsed.effects):
            parsed.effects.append(Effect(kind=_kind, target="self",
                                         value={"delta": int(m.group(3)) * (-1 if m.group(2) in "-－" else 1)},
                                         evidence=m.group(0)))
    return parsed


def resolve_cleanse_marks(skill, *, declared: bool, parsed: Optional[Parsed] = None) -> Parsed:
    """按**配置声明的能力**决定「驱散印记」这条读法要不要落地（task-27）。

    与 `resolve_foe_energy_loss` 同一套纪律：`declared=False`（legacy / v2 没声明
    `damage.cleanse_marks`）时**什么都不产出** —— 连一条 effect 都不加 ⇒
    `state.unsupported` 与 golden 指纹逐位不变。
    `declared=True` 时才产出 `cleanse_marks{side, scope}`；紧跟其后的「每驱散 1 层，<效果>」
    产出一条 `per_cleansed_layer{effect:{…}}`（**消费者**，由 env 按层数逐层结算）。

    支持的范围（认不出的一律不产出，由上层如实登记）：
      · `双方所有印记` → side=both, scope=all
      · `敌方所有印记` → side=foe,  scope=all ；`敌方印记` → side=foe, scope=one
      · `自己所有印记` → side=self, scope=all
      · 跟随效果只认三种：`敌方获得 N 层 <状态>`（→ foe_status）、`获得物攻/魔攻/物防/魔防±N%`（→ self_stat）、
        `回复自己 N% 生命`（→ heal）。别的写法**不猜**。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    desc = skill.desc or ""
    _one = _CLEANSE_BUFFS_ONE.search(desc)
    if _one:
        parsed.effects.append(Effect(
            kind="cleanse_buffs_one", target="foe",
            value={"side": "foe", "polarity": _one.group(2), "count": 1,
                   "pick": "largest_abs_delta"},
            evidence=_one.group(0)))
    _layers = _CLEANSE_BUFFS_LAYERS.search(desc)
    if _layers:
        # E 族缺口一（2026-09-30）：**量纲是层数**（与上面 `cleanse_buffs_one` 的「N 种」分开 ✗）。
        # 「一层」在原始资料里**没有定义**（`buffs` 只有 `{键名: 百分比}`）⇒ 选法写成**本地规则**，
        # 由 `env` 那一支在事件里带 `basis` **如实标注、与原始资料区分** ✓。
        parsed.effects.append(Effect(
            kind="cleanse_buffs_layers", target="foe",
            value={"side": "foe", "polarity": _layers.group(2),
                   "layers": int(_layers.group(1)), "pick": "largest_abs_delta_desc"},
            evidence=_layers.group(0)))
    m = _CLEANSE_MARKS.search(desc)
    if not m:
        # 没有印记驱散时**仍可能**是 C 形状（「驱散自己的减益」）⇒ 处理完再返回
        if _CLEANSE_SELF_DEBUFF.search(desc):
            parsed.effects.append(Effect(kind="cleanse_self_debuffs", target="self",
                                         value={"polarity": "减益"},
                                         evidence=_CLEANSE_SELF_DEBUFF.search(desc).group(0)))
        return parsed
    where, all_word = m.group(1), bool(m.group(2))
    side = {"双方": "both", "敌方": "foe", "自己": "self"}[where]
    # 同一句文本被老 `_CLEANSE` 也认了（它产出 `cleanse{what:None}`）⇒ **摘掉那一条**：
    # 否则运行时老分支会走 fail-closed 支并给玩家一句「这一手没有执行，双方状态保持不变」——
    # 而印记**真的被清掉了**（实测：408 会同时出现 `marks_cleansed` 与 `cleanse_unsupported` ✗，
    # 玩家看到的是一句假免责）。**只在声明了能力位时摘**（legacy 的 effects 逐字不变）。
    parsed.effects = [e for e in parsed.effects
                      if not (e.kind == "cleanse" and e.value.get("what") is None)]
    parsed.effects.append(Effect(kind="cleanse_marks", target=side,
                                 value={"side": side, "scope": "all" if all_word else "one"},
                                 evidence=m.group(0)))
    if _CLEANSE_SELF_DEBUFF.search(desc):
        parsed.effects.append(Effect(kind="cleanse_self_debuffs", target="self",
                                     value={"polarity": "减益"},
                                     evidence=_CLEANSE_SELF_DEBUFF.search(desc).group(0)))
    follow = _PER_CLEANSED_LAYER.search(desc)
    if follow:
        body = follow.group(1)
        inner = None
        m2 = re.search(r"敌方获得\s*(\d+)\s*层\s*(中毒|灼烧|寄生)", body)
        if m2:
            inner = {"kind": "foe_status", "status": m2.group(2), "layers": int(m2.group(1))}
        else:
            m3 = re.search(r"获得(双攻|双防|物攻|魔攻|物防|魔防|速度)\s*\+\s*(\d+)%", body)
            if m3:
                keys = COMBO_STAT_KEYS.get(m3.group(1)) or ((STAT_KEYS[m3.group(1)],)
                                                            if m3.group(1) in STAT_KEYS else ())
                if keys:
                    inner = {"kind": "self_stat", "stats": list(keys), "delta_pct": int(m3.group(2))}
            else:
                m4 = re.search(r"回复自己\s*(\d+)\s*%\s*生命", body)
                if m4:
                    inner = {"kind": "heal", "percent": int(m4.group(1))}
        if inner is not None:
            parsed.effects.append(Effect(kind="per_cleansed_layer", target=side,
                                         value={"effect": inner}, evidence=follow.group(0)))
        else:
            # 认不出的跟随效果 ⇒ **不产出**（上层会把它登记成未认领片段，fail closed）
            pass
    return parsed


#: **「应对X：减免的伤害变为回复自己生命」**（task-28 · 实测 `skill_000289 无畏之心`
#: 「减伤100%，应对攻击：**减免的伤害变为回复自己生命**，且本技能能耗永久+2。」）。
_RESPOND_REDUCTION_TO_HEAL = re.compile(
    r"应对(?:状态|攻击|防御)\s*[：:]\s*减免的伤害变为回复自己生命")


def resolve_respond_reduction_to_heal(skill, *, declared: bool,
                                      parsed: Optional[Parsed] = None) -> Parsed:
    """「应对X：**减免的伤害变为回复自己生命**」—— 把被减伤挡下来的那部分转成回复（task-28）。

    与 `resolve_cleanse_marks` / `resolve_foe_energy_loss` **同一套纪律**：
    `declared=False`（legacy / v2 没声明 `damage.respond_reduction_to_heal`）时
    **什么都不产出** —— 连一条 effect 都不加 ⇒ `state.unsupported` 与 golden 指纹逐位不变 ✓。

    为什么是「减免的**那部分**」而不是"整下伤害都不吃" ✗：
    描述逐字是「**减免的伤害**变为回复」⇒ 被减伤挡掉的部分转成回复 ✓，
    而**穿过去的那点残余伤害照旧结算** ✓（实测 289 减伤 100% 时仍有 **1** 的下限伤害 ✓）。
    数值口径：`减免量 = DamageOutcome.raw − DamageOutcome.damage` ✓ ——
    两个量在 `effects.py` 里**现成**（`:550` `damage = max(1, int(raw * (1 - reduction)))`），
    **不新增伤害管线** ✓，也不在这里猜一个比例 ✓。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    m = _RESPOND_REDUCTION_TO_HEAL.search(skill.desc or "")
    if m:
        parsed.effects.append(Effect(
            kind="respond_reduction_to_heal", target="self",
            value={"scope": "mitigated"}, evidence=m.group(0)))
    return parsed


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


def resolve_moe_colon(skill, *, declared: bool, parsed: Optional[Parsed] = None,
                      flat_declared: bool = False, power_declared: bool = False,
                      global_declared: bool = False) -> Parsed:
    """「<谁>获得萌化：<效果>」⇒ **两条效果**（task-28 · `720 示弱` 起）。

    口径（Lead 裁决 ✓）：**冒号 = 顺带（并列）** ✓ ⇒ 两件都做 ✓；`<效果>` **无条件** ✓
    （⚠ 若人类日后改判为"触发" ⇒ **只改这一处** ✓ 见本函数末尾的改点说明 ✓）。

    ⚠ **两条效果各有各的门** ✓（Lead 2026-09-30 ④ ✓「按效果判」✓）：
      · **萌化授予** ⇒ `damage.moe_mark` ✓（写 `marks` ✓ 走 `env` **现成**的 `self_mark`/`foe_mark` 支 ✓）
      · **平值属性** ⇒ `damage.stat_gain_flat` ✓（写 `buffs_flat` ✓ 走 `env:1884` **现成**写点 ✓）
      ⇒ ⇒ **关一个不影响另一个** ✓（反证要两条 ✓ 也正好证明"没把两个键合掉"是对的 ✓）
    ⚠ `<效果>` 认不出的（`717`/`721`/`728` 那三种）⇒ **一律不产出** ✗（fail closed ✓ 判据如实点名 ✓）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    m = _MOE_COLON.search(skill.desc or "")
    if not m:
        return parsed
    # ⚠⚠ **只在整个子句"两半都能结算"时才产出** ✗✗（**只摘这一族**的再收一层 ✓）
    #   实测教训（我踩到 ✓）：`717`/`721`/`728` 的 `<效果>`（本次技能威力+60 / 全技能能耗永久-2 /
    #   全技能威力永久+10）**机制根本不存在** ✗ —— 但只要我产出"授予萌化"，它的 evidence 就含「获得」二字
    #   ⇒ ⇒ 判据把**整句**（含那半没实现的）都当成已认领 ⇒ **三条假绿** ✗✗
    #   ⇒ ⇒ 所以：**`<效果>` 认不出 ⇒ 这一条我一个字都不产出** ✓（fail closed ✓
    #      ⇒ 那三条继续如实未结算 ✓ 归第 2 批"要新机制" ✓）
    _body = str(m.group("body") or "").strip()
    _stat_ok = bool(_MOE_COLON_FLAT_STAT.match(_body)) and flat_declared
    # ⚠ 本手威力那条**另有自己的门**（`damage.self_power_flat` ✓ 按效果判 ✓ 不合键 ✗）
    _power_ok = bool(_MOE_COLON_THIS_POWER.match(_body)) and power_declared
    # ⚠ 第三半：**「回复N%生命」**（`723`）—— 它**本来就由既有路径结算** ✓（裸解析就产出 `heal` ✓）
    #   ⇒ 只要认得出它 ⇒ 放行 ✓（⚠ 与 `717`/`721` 那两种"机制不存在"的情况**不同** ✗：
    #     那两种若放行 ⇒ **同句另一半没实现** ⇒ 假绿 ✗ —— 所以这里**必须**先确认这半真会结算 ✓）
    _heal_ok = bool(_MOE_COLON_HEAL.match(_body))
    _global_ok = bool(_MOE_COLON_GLOBAL.match(_body)) and global_declared
    if not (_stat_ok or _power_ok or _heal_ok or _global_ok):
        return parsed
    who = m.group("who")
    # ⚠⚠ **evidence 只取"<谁>获得萌化"那一小段** ✗ —— **不许取整句** ✗✗
    #   理由（实测踩到 ✓ 与 `289` 那次**同一个坑** ✓）：整句含「：<效果>」⇒ 授予的 evidence
    #   会把**同句里另一条机制**（`717` 的「本次技能威力+60」等）也一起"覆盖"成已认领 ✗
    #   ⇒ ⇒ 实测后果：`717`/`721`/`728`（它们的 `<效果>` **机制根本不存在**）被判 `verdict=True` ✗✗
    #   ⇒ ⇒ **一个子句两条机制 ⇒ 两条都要各自被认领** ✓（`compound_clause_gaps` 那条纪律 ✓）
    evidence = f"{who}获得萌化"
    # ① 萌化授予（自己的门 = `moe_mark` ✓）
    if declared:
        sides = {"自己": ("self_mark",), "敌方": ("foe_mark",),
                 "自己和敌方": ("self_mark", "foe_mark")}[who]
        for kind in sides:
            if not any(getattr(e, "kind", "") == kind and (e.value or {}).get("mark") == "萌化"
                       for e in parsed.effects):
                parsed.effects.append(Effect(kind=kind, target="self" if kind == "self_mark" else "foe",
                                             value={"mark": "萌化", "layers": 1}, evidence=evidence))
    # ② 平值属性（自己的门 = `stat_gain_flat` ✓）—— 只认「<属性>永久±N」这一种 ✓
    fm = _MOE_COLON_FLAT_STAT.search(str(m.group("body") or "").strip())
    if fm and flat_declared:
        key = {"速度": "spe", "物攻": "atk", "魔攻": "spa",
               "物防": "def", "魔防": "spd"}[fm.group(1)]
        delta = int(fm.group(3)) * (-1 if fm.group(2) in "-－" else 1)
        if not any(getattr(e, "kind", "") == "self_stat_flat" and (e.value or {}).get("stat") == key
                   for e in parsed.effects):
            parsed.effects.append(Effect(kind="self_stat_flat", target="self",
                                         value={"stat": key, "delta_flat": delta},
                                         evidence=fm.group(0)))
    # ④ **全技能级**持久修正（自己的门 = `global_skill_mods` ✓）——
    #    ⚠ **作用域 = 所有技能** ✗（写 `PetState.global_skill_mods` ✓ 与 `skill_ramps` 分清 ✓）
    gm = _MOE_COLON_GLOBAL.match(_body)
    if gm and global_declared:
        _val = int(gm.group(3)) * (-1 if gm.group(2) in "-－" else 1)
        _kind = "global_cost_delta" if gm.group(1) == "能耗" else "global_power_pct"
        if not any(getattr(e, "kind", "") == _kind for e in parsed.effects):
            parsed.effects.append(Effect(kind=_kind, target="self",
                                         value={"delta": _val}, evidence=gm.group(0)))
    # ③ **本手平值威力**（自己的门 = `self_power_flat` ✓）—— 只认「**本次**技能威力±N」这一种 ✓
    pm = _MOE_COLON_THIS_POWER.match(_body)
    if pm and power_declared:
        amount = int(pm.group(2)) * (-1 if pm.group(1) in "-－" else 1)
        if not any(getattr(e, "kind", "") == "self_power_flat" for e in parsed.effects):
            parsed.effects.append(Effect(kind="self_power_flat", target="self",
                                         value={"amount": amount}, evidence=pm.group(0)))
    # ⚠ **改点**：上面把"冒号"读成**并列（顺带）** ✓ —— 这是**本地规则**（术语无独立条目 ✓）。
    #   若人类日后改判为"**触发**"（`<效果>` 只在萌化生效时才发生）⇒ **只改这一处** ✓
    #   + 同批补判据与反证（`723` 的"回复给谁"、`732` 的"应对失败还给不给"会跟着变 ✓）。
    return parsed


def resolve_self_debuff_power(skill, *, declared: bool,
                             parsed: Optional[Parsed] = None) -> Parsed:
    """「（自己）有减益时，本次技能威力+N」⇒ **条件式**本手平值威力（task-28 · `724 破罐破摔`）。

    **与 `717` 共用"加成"那一半** ✓（同一个 kind `self_power_flat` ✓ 同一个写点 ✓）；
    **只有"条件"是新的** ✗ ⇒ 效果带 `requires:"self_has_debuff"` ✓（由 `env._gate_self_debuff_effects` 筛 ✓）。

    ⚠ **"减益"的口径**（Lead 2026-09-30 裁决 ✓）：**只算 `buffs` / `buffs_flat` 的负值** ✓；
      **中毒/灼烧那些"状态层数"不算** ✓（术语里没有"减益包含状态层数"的依据 ⇒ 算进来 = **发明语义** ✗）。
      ⇒ ⚠ **改点**：若人类日后改判为"含状态层数" ⇒ **只改 `env._gate_self_debuff_effects` 那一处** ✓
        + 同批补判据与反证 ✓。

    `declared=False`（legacy / v2 没声明 `damage.cond_self_debuff_power`）⇒ **什么都不产出** ✓ 逐位不变 ✓。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    m = _SELF_DEBUFF_POWER.search(skill.desc or "")
    if m and not any(getattr(e, "kind", "") == "self_power_flat"
                     and (e.value or {}).get("requires") == "self_has_debuff" for e in parsed.effects):
        amount = int(m.group(2)) * (-1 if m.group(1) in "-－" else 1)
        parsed.effects.append(Effect(kind="self_power_flat", target="self",
                                     value={"amount": amount, "requires": "self_has_debuff"},
                                     evidence=m.group(0)))
    return parsed


def resolve_mark_transfer(skill, *, declared: bool,
                         parsed: Optional[Parsed] = None) -> Parsed:
    """「将自己的<标记>转移给敌方」⇒ 一条 `transfer_mark` 效果（task-28 · `722 反弹`）。

    与其它 resolver **同一套纪律**：`declared=False`（legacy / v2 没声明 `damage.moe_mark`）
    ⇒ **什么都不产出** ⇒ `unsupported` 与 golden 指纹逐位不变 ✓。
    ⚠ **必须带 `requires:"self_has_mark"`** ✗ —— 否则 `env._gate_self_mark_effects` 认不出它是条件效果
      ⇒ **会无条件搬**（0 层也搬 ⇒ 语义错、且反证会红 ✗）。
    ⚠ 它**不是**"只在判据侧认领"的 kind ✓ —— **真施加必须真写**（Lead 2026-09-30 裁决 ✓）：
      写点 = `env._apply_effect_batch` 的 `transfer_mark` 支（**搬家** ✓）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    m = _MARK_TRANSFER.search(skill.desc or "")
    if m and not any(getattr(e, "kind", "") == "transfer_mark" for e in parsed.effects):
        parsed.effects.append(Effect(kind="transfer_mark", target="foe",
                                     value={"mark": m.group(1), "requires": "self_has_mark"},
                                     evidence=m.group(0)))
    return parsed


def resolve_element_power_ramp(skill, *, declared: bool,
                               parsed: Optional[Parsed] = None,
                               allow_respond_clause: bool = False) -> Parsed:
    """**「<系>技能威力永久±N%」** ⇒ 一条 `element_power_ramp` 效果（task-28 · `skill_000462 放晴`）。

    为什么单独一个 resolver（而不是并进 `resolve_respond_override`）：
    这句话是**基础子句**（在「应对」之前），而「应对防御：改为永久+100%」是它的**覆盖体** ✓
    ⇒ **基础必须先成为一条 effect**，覆盖才有"被覆盖的对象"可摘 ✗
      （既有纪律逐字：「③ 覆盖目标找不到 ⇒ **一条都不动**，绝不'既留基础又加改为'」✓
        —— 若基础不是 effect，`resolve_respond_override` 只会留残余 ⇒ 462 永远结算不了 ✗）

    与其它 resolver **同一套纪律**：`declared=False`（legacy / v2 没声明
    `damage.element_power_ramp`）⇒ **什么都不产出** ⇒ `unsupported` 与 golden 指纹逐位不变 ✓。
    写入由 `env` 负责（`pet.element_power_mods[系别] += N`），
    读取已在 `effects.compute_damage`（按 `skill.element` 取 ✓）—— 本函数**只产出结构** ✓。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        return parsed
    desc = skill.desc or ""
    m = _ELEMENT_POWER_RAMP.search(desc)
    if not m:
        return parsed
    # ⚠⚠ **位置闸（task-28 实测到的假绿风险）**：这条正则全库命中 **2 条** ——
    #   `462 放晴`「**光系技能威力永久+50%**，应对防御：改为永久+100%。」← 基础子句在**应对之前** ✓
    #   `463 点亮`「减伤90%，**应对攻击**：自己获得光系技能威力永久+50%。」← 它在**应对子句里面** ✗
    # ⇒ 463 那一条是**条件式**的（只在应对成功时生效）⇒ 归 respond 那条链处理 ✓；
    #   在这里**无条件产出**就是"没应对也加威力"⇒ **假绿** ✗
    # ⇒ 所以只认**出现在第一个应对标记之前**的那种 ✓（463 留原样、如实报不支持 ✓ —— 它是后续批次的事）
    # ⚠ **闸本身不许删** ✗ —— 删了 ⇒ 任何位置都产出 ⇒ 假绿 ✗（这段注释就是证据 ✓）
    # ⇒ 放宽的方式是**调用点显式声明**：`allow_respond_clause=True` ✓
    #   只在**防御支**那一处传 ✓ —— 因为**只有那一支**具备"应对成功才 `_apply_effect_batch`"的结构 ✓
    #   （段内注释逐字：「应对成功 → 真的应用／应对失败 → **登记**为 unsupported，绝不能当成已生效」✓）
    #   ⇒ ⇒ 于是 `463` 的"只在应对成功时加"**由结构保证** ✓ 不新造 `requires` ✓
    _resp = _RESPOND_KIND_IN_DESC.search(desc)
    if _resp is not None and _resp.start() < m.end() and not allow_respond_clause:
        return parsed
    if not any(getattr(e, "kind", "") == "element_power_ramp" for e in parsed.effects):
        delta = int(m.group("delta")) * (-1 if m.group("sign") in "-－" else 1)
        # ⚠ task-28（`463 点亮`）：**回应子句里那一条** ⇒ evidence 必须**含「获得」那一段** ✗
        #   实证：只取「光系技能威力永久+50%」⇒ `获得` 那个机制词的 span 留着 ⇒ `verdict` 仍 False ✓
        #   ⚠ 与「不许吞同句兄弟机制」并存：本句**逐字核过只有这一条机制** ✓
        #     ⇒ 取「应对攻击：自己获得光系技能威力永久+50%」整段**安全** ✓（无第二机制可吞 ✓）
        _ev = m.group(0)
        if _resp is not None and _resp.start() < m.end():
            _ev = desc[_resp.start():m.end()]
        parsed.effects.append(Effect(
            kind="element_power_ramp", target="self",
            value={"element": m.group("element"), "delta": delta},
            evidence=_ev))
    return parsed


def resolve_respond_override(skill, *, declared: bool,
                             parsed: Optional[Parsed] = None) -> Parsed:
    """「应对X：**改为** <值>」的**覆盖语义**（RC-401 批次十四，2026-09-29 task-20）。

    为什么需要它（第 51 轮实测）：这一段以前**在任何分支都不产出效果** ——
    `_RESPOND_OVERRIDE` 只在"基础效果恰是敌方失去能量"时用来**压掉**基础值，
    别的基础效果（实测 `skill_000616 剧毒`「敌方获得3层中毒，应对防御：改为获得8层」）
    则把「改为」的值**静默丢弃**：应对成功那一手照样读 `status_added{layers:3}`，
    而屏幕上没有任何"这一段没生效"。**静默错值**比"没实现"更糟 ⇒ 本函数把它变成可结算的覆盖。

    纪律（与 `resolve_hit_count` / `resolve_foe_energy_loss` 同一套）：
      · `declared=False`（legacy / v2 没声明 `energy.respond_override`）⇒ **什么都不产出**，
        `respond_override` 保持 `None` ⇒ `unsupported` 与判据逐位不变；
      · 声明了才解析，且**只认能机械读出的形状**：本批只认「改为**获得N层**」（主语/状态名
        全省略，指代紧邻的那条基础效果）—— 因为它是描述里唯一能让"层数"独立成参数的形式；
      · 读不出来 ⇒ `leftover` 留原文、`effects` 为空，由调用方 fail closed 登记
        （**绝不猜一个数**）。「改为威力+60」「改为速度+160」那几类留给后面的批次。

    覆盖语义**不是追加**：「应对防御：改为获得8层」里 3 与 8 互斥（`skill_000745 恶作剧`
    的「敌方失去3能量，应对防御：改为敌方失去6能量」同理）。所以这里把被覆盖的那条基础效果
    的**下标与原文**记在 `replaces_index` / `replaces_evidence` 上，由 `env` 在应对成功时
    **替换**它（而不是把两条都结算）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared:
        # 未声明：连结构都不产出。legacy / v2 的 `unsupported`、`unclaimed` 与判据逐位不变。
        return parsed
    if getattr(parsed, "respond_override", None) is not None:
        return parsed                      # 已经解析过（幂等），别把下标算歪
    desc = skill.desc or ""
    # 两条入口：① 「应对X：**改为** …」（层数覆盖那一种，`改为`紧跟在冒号后）；
    # ② 「应对X：**本技能改为N连击 / 变为N连击 / 连击数翻倍**」——**冒号后面不是「改为」**，
    #    所以第①条正则**认不到**（实测：只挂第①条时这三条的 `respond_override` 全是 `None`）。
    m = _RESPOND_OVERRIDE_BODY.search(desc)
    mh = None if m else _RESPOND_HITS_CLAUSE.search(desc)
    if not m and not mh:
        return parsed
    if mh:
        m = mh
    body = (m.group("body") or "").strip()
    ov: Dict[str, object] = {
        "respond_to": m.group("respond_to"),
        "body": body,
        "evidence": m.group(0),
        "mode": None,
        "effects": [],
        # 被覆盖的基础效果 = 出现在「应对」之前、**最后一条**带层数的效果。
        "replaces_index": None,
        "replaces_evidence": "",
        "leftover": "",
    }
    lm = _RESPOND_LAYERS.match(body)
    if lm:
        layers = int(lm.group(1))
        # 基础效果只从**应对子句之前**的那一段找：后面的文本不可能被"改为"覆盖。
        head = desc[:m.start()]
        base_idx = None
        for i in range(len(parsed.effects) - 1, -1, -1):
            eff = parsed.effects[i]
            if "layers" not in eff.value:
                continue
            if eff.evidence and eff.evidence not in head:
                continue
            base_idx = i
            break
        if base_idx is None:
            # 找得到「改为获得N层」、却找不到它改的是哪一条 ⇒ 不猜，如实留残余。
            ov["leftover"] = (f"「{m.group(0)}」认不出被覆盖的基础效果"
                              "（应对子句之前没有任何带层数的效果）")
            parsed.respond_override = ov
            return parsed
        base = parsed.effects[base_idx]
        ov["mode"] = "layers"
        ov["layers"] = layers
        ov["replaces_index"] = base_idx
        ov["replaces_evidence"] = base.evidence
        # 派生效果 = 基础效果的**副本**，只把层数换成「改为」的值（主语/状态名继承基础效果）。
        # `evidence` 用「应对…：改为…」的原文：它必须能在描述里逐字找到（判据与 unclaimed 都靠它）。
        # `cap_override` 标记（RC-401 批次十七）：人类 2026-09-29「为什么不行，针对**这一个技能**
        # 改一下不行吗？」⇒ 这一条是**技能明写的数值**，允许突破本地规则的**全局**层数上限；
        # `env._apply_effect_batch` 认这个键，普通路径没有它、照旧被夹住 ✓
        ov["effects"] = [dataclasses.replace(
            base, value={**base.value, "layers": layers,
                         "cap_override": f"respond_override({m.group(0)})"},
            evidence=m.group(0))]
    else:
        hm = _RESPOND_HITS_ABS.match(body)
        hmult = _RESPOND_HITS_MULT.match(body)
        if hm or hmult:
            # ── RC-401 批次十五（2026-09-29 task-20 批二）：**连击数覆盖** ──────────
            # 基础次数取 `parsed.hit_count`（描述里静态写着的那个；`None` 按 1 次，
            # 因为伤害公式的默认值就是 1 —— 这里**不额外断言**"已解析出 1 连击"）。
            base_hits = int(parsed.hit_count or 1)
            if hm:
                hits = int(hm.group(1))
                mode_mult = None
            else:
                mode_mult = 2                     # 「连击数翻倍」= ×2
                hits = base_hits * mode_mult
            ov["mode"] = "hits"
            ov["base_hits"] = base_hits
            ov["hits"] = hits
            ov["hit_multiplier"] = mode_mult
            # `evidence` 用整条覆盖子句的原文 ⇒ `unclaimed` 认领与判据 `_inside` 都靠它。
            ov["effects"] = [Effect(kind="hit_count", target="self", value={"hits": hits},
                                   evidence=m.group(0), term="3005")]
            # 「动态连击数」那一条标记是**无条件动态连击**用的；这里它已经被条件化实现了
            # （条件 = 应对成功，运行时判过），所以摘掉 —— 不摘就会既结算又报未实现（重复计数）。
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
        else:
            # task-28（D 族 `462 放晴`）：**第四种覆盖体形状** —— 「改为永久±N%」
            # （「光系技能威力永久+50%，应对防御：改为**永久+100%**。」✓）
            # 与 `mode="layers"` **同一套覆盖纪律**：找得到被覆盖的基础效果才替换 ✓；
            # 找不到 ⇒ **留残余、一条都不动**（绝不"既留基础又加改为" ✗）。
            epm = _RESPOND_ELEMENT_POWER_RAMP.match(body)
            if epm:
                # 被覆盖的基础效果 = 应对子句**之前**那条 `element_power_ramp`
                #（基础子句先由 `resolve_element_power_ramp` 产出 ✓ —— 调用顺序在 env / coverage 两侧都保证 ✓）
                head = desc[:m.start()]
                base_idx = None
                for i in range(len(parsed.effects) - 1, -1, -1):
                    eff = parsed.effects[i]
                    if getattr(eff, "kind", "") != "element_power_ramp":
                        continue
                    if eff.evidence and eff.evidence not in head:
                        continue
                    base_idx = i
                    break
                if base_idx is None:
                    ov["leftover"] = (f"「{m.group(0)}」认不出被覆盖的基础效果"
                                      "（应对子句之前没有「<系>技能威力永久±N%」那一条）")
                    parsed.respond_override = ov
                    return parsed
                base = parsed.effects[base_idx]
                element = str(base.value.get("element") or "")
                delta = int(epm.group(2)) * (-1 if epm.group(1) in "-－" else 1)
                ov["mode"] = "element_power"
                # 系别**继承**基础效果 ✓ —— 覆盖体里没有系别名，这里绝不自己猜一个 ✗
                ov["element"] = element
                ov["delta"] = delta
                ov["replaces_index"] = base_idx
                ov["replaces_evidence"] = base.evidence
                ov["effects"] = [Effect(
                    kind="element_power_ramp", target="self",
                    value={"element": element, "delta": delta,
                           "cap_override": f"respond_override({m.group(0)})"},
                    evidence=m.group(0))]
            else:
                ov["leftover"] = f"「{m.group(0)}」这一种覆盖写法本引擎还没有实现"
    parsed.respond_override = ov
    return parsed


#: 任务 25（2026-09-29）：**「获得 属性±N」的扩展形状**。
#:
#: 为什么需要它（实测，不是推演）：`_SELF_STAT_MULTI` 只认「`自己`获得`单/双属性``+`N`%`」、
#: `_FOE_STAT` 只认「`敌方`获得`单属性``-`N`%`」⇒ 数据里真实存在的另外几种写法**读不出来**，
#: A/B 两族 93 条技能里共 **40 处**片段落在缺口里（task-25 探针逐形状量过）：
#:   `自己获得X+N（无%）`11 · `无主语获得X+N%`8 · `自己获得X-N%`4 · `敌方获得X-N%（含"和"复合）`2 ·
#:   `敌方获得X-N（无%）`2 · `额外获得X+N%`1 · `自己获得速度-N`1。
#: 这个正则**是那两个旧正则的超集**，所以逐条比对 span，已被旧正则认领的**绝不重复产出**
#: （同一段文本两条效果 = 加成算两遍，那是静默错算）。
_STAT_GAIN_NAME = r"(?:双攻|双防|物攻|魔攻|物防|魔防|速度|全技能威力)"
_STAT_GAIN_EXT = re.compile(
    r"(?P<side>自己|敌方)?\s*(?P<extra>额外)?(?P<also>并)?获得\s*"
    r"(?P<stats>" + _STAT_GAIN_NAME + r"(?:和" + _STAT_GAIN_NAME + r")*)\s*"
    r"(?P<sign>[+＋\-－])\s*(?P<num>\d+)\s*(?P<pct>%?)")

#: 任务 25：**条件子句的边界** —— 落在这些里面的「获得 属性±N」**不许**当无条件效果产出。
#:
#: 为什么必须有这道闸（这一批最容易犯的错）：扩展正则**只认形状、不懂条件**。
#: 实测三条真实描述：
#:   · `skill_000790`「自己获得双攻和双防-50%，**应对防御：改为**敌方获得双攻和双防-120%」
#:     ⇒ 不加闸的话那 -120% 会变成**无条件**减益（应对失败也扣）——**静默错算**，
#:       比"没结算"坏得多（人类口径：宁可不做，也不许把没做的说成做了）；
#:   · `skill_000683`「…**选择：**若自己生命低于20%，回复60%生命**或**若自己生命高于80%，
#:     获得物攻+150%」⇒ 无条件 +150% 是白送；
#:   · `skill_000805`「造成魔伤，**若击败敌方**，自己获得魔攻+70%」⇒ 同上。
#: 判法：取命中所在的**整句**（`。；` 之间），句子开头到命中处出现下列任一标记就跳过。
#: 这样这批只补"**无条件**的、过去被静默丢掉的"形状 —— 条件式留给后面的批次
#: （它们需要新的结算支，不是放宽正则就能对的）。
#: ⚠ 2026-09-30（收尾复核）**改钉**：初版只列了「若/选择/应对/期间/每/或」，
#: 实测**漏掉另一批条件标记** ⇒ 4 条**带别的条件**的技能被误判成 SIMULATABLE（静默错算）：
#:   `skill_000021 鼓气`「**使用能耗为3的技能时**，获得双攻和双防+20%」
#:   `skill_000064 助燃`「**使用火系技能后**，获得双攻+20%」
#:   `skill_000154 恶魔的晚宴`「**主动击败敌方精灵时**，自己永久获得双攻+50%」
#:   `skill_000159 张弛有度`「**周末时**自己获得双攻+40%，**其他时间**获得双防+40%」
#: ⇒ 补上「时 / 后 / 前 / 当」。宁可少认领（如实报未结算），也不许当无条件效果白送。
_STAT_GAIN_GUARDS = ("若", "选择", "应对", "期间", "每", "或", "时", "后", "前", "当")

#: 任务 25：**回收旧正则误认领**时用的条件词 —— **去掉「应对」**。
#:
#: 为什么两个表不一样（这一条是实测踩出来的）：`应对` 是**引擎真的会判**的那一个条件 ——
#: 防御支在 `if succeeded:` 里才应用效果（`env._execute`），所以「应对攻击：自己获得魔攻+70%」
#: 在**应对成功那一手真的该生效**。第一版把「应对」也放进回收表 ⇒ `skill_000429 / 000757 / 000287`
#: 的效果被整条摘掉 ⇒ 应对成功也不再加成 = **把能用的机制弄坏了**
#: （实测 `defense-branch` 场景 `buff_self` 3 → 0）。
#: 而 `若 / 选择 / 每 / 或 / 期间` 这几个条件**引擎一处都没判** ⇒ 无条件应用就是静默错算，
#: 必须回收（实测 `skill_000624`「敌方每有1层中毒效果，敌方获得双攻-30%」过去被无条件扣，
#: `type-sweep-毒系` 的 `debuff_foe` 16 次就是这么来的）。
#: ⚠ **攻打支的「应对」子句仍是无条件应用的**（`env` 的攻击支没有 `if succeeded` 门）——
#: 那是**接手前就有**的行为，本轮**不动它**（不扩大改动面）；它的证据留在 `unsupported` 里。
_STAT_GAIN_RECLAIM_GUARDS = ("若", "选择", "期间", "每", "或", "时", "后", "前", "当")


def resolve_stat_gain_extended(skill, *, declared: bool, flat_declared: bool = False,
                               parsed: Optional[Parsed] = None) -> Parsed:
    """按**配置声明的能力**决定「获得 属性±N」的扩展形状要不要落地（task-25）。

    与 `resolve_foe_energy_loss` / `resolve_respond_override` **同一套纪律**：
      · 未声明时这个函数**什么都不做** —— 效果不产出、也不补未认领标记
        ⇒ legacy / v2 的 `unsupported`、结算与判据逐位不变（那两个旧正则是无条件的，
        所以「自己获得物攻+100%」这类**老形状在 legacy 里照旧**由 `parse_skill` 产出，
        本函数不去动它们）；
      · 声明了才把**旧正则读不出来的那些形状**补成效果。

    两个门是分开的，因为量纲不同（见 `PetState.buffs_flat`）：
      · `declared`      —— **百分点**形状（`delta_pct`），含 `全技能威力`
        （数据里它一律不带 `%`，但读点 `effects.compute_damage` 按 `+N` = `+N%` 解 ⇒ 归这一类，
        口径写进 `stat_gain.extended_shapes` 的 reason，标 LOCAL_RULE）；
      · `flat_declared` —— **平值**形状（`delta_flat`，面板量纲）。全库实测平值只出现在**速度**上。

    ⚠ **幂等**：`parsed=` 传进来时可能已经带着本函数产出过的效果（`resolve_claims` /
    `settlement_verdict` / `env` 三处会串在一条链上），所以按 `(kind, stat, 取值, evidence)`
    去重，重复调用不会叠两条。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared and not flat_declared:
        return parsed
    desc = str(getattr(skill, "desc", "") or "")

    def _sentence_start(pos: int) -> int:
        """命中位置所在**那一句**的开头（。；切句）。条件词只在同句里才算数。"""
        return max(desc.rfind(c, 0, pos) for c in "。；") + 1

    def _in_condition(evidence: str, guards) -> bool:
        i = desc.find(evidence)
        return i >= 0 and any(g in desc[_sentence_start(i):i] for g in guards)

    # ⓪ **回收**旧正则误认领的**条件形状**（2026-09-29 task-25，反证 B 的落点）。
    #
    # `_SELF_STAT` / `_SELF_STAT_MULTI` 是**无条件的**旧正则：`skill_000805`「造成魔伤，
    # **若击败敌方**，自己获得魔攻+70%」会被它当成**无条件** +70% 产出 —— 应对失败/没击败也加 ✗。
    # 那是「把没结算的当成已结算」（人类红线），而且比"不结算"更糟（静默错算）。
    # 声明了能力位（v3）才回收 ⇒ legacy / v2 的解析结果、`unsupported`、结算**逐位不变**
    #（旧行为留档：那两份配置里这形状仍是"无条件"的旧读法，属冻结基线，不在本批改动范围）。
    if declared or flat_declared:
        keep = []
        for e in parsed.effects:
            if e.kind in ("self_stat", "foe_stat", "self_stat_flat", "foe_stat_flat"):
                ev = str(getattr(e, "evidence", "") or "")
                if ev and _in_condition(ev, _STAT_GAIN_RECLAIM_GUARDS):
                    continue
            keep.append(e)
        parsed.effects = keep

    # ① 已经被别的效果认领的区间（旧正则 / 别的解析器）⇒ 整段跳过，绝不重复产出。
    taken = []
    for e in parsed.effects:
        ev = str(getattr(e, "evidence", "") or "")
        if not ev:
            continue
        i = desc.find(ev)
        if i >= 0:
            taken.append((i, i + len(ev)))
    # ⚠ 去重键必须**可哈希**：`Effect.value` 里有 list（例如 `overheal_to_stat` 的 `stats`）⇒
    # 直接 `tuple(sorted(items))` 会抛 `TypeError: unhashable type: 'list'`
    # （实测在 `classify_skill` 遍历全库时炸；`str(sorted(...))` 是稳定的字符串键）。
    seen = {(e.kind, str(sorted(e.value.items())), str(e.evidence)) for e in parsed.effects}
    for m in _STAT_GAIN_EXT.finditer(desc):
        lo, hi = m.span()
        if any(a <= lo < b or a < hi <= b for a, b in taken):
            continue
        # ② 条件句闸（见 `_STAT_GAIN_GUARDS` 的注释）：命中所在的整句里，命中**之前**
        #    出现「若/选择/应对/期间/每/或」就跳过 —— 那一类要的是新的结算支，不是放宽正则。
        if any(g in desc[_sentence_start(lo):lo] for g in _STAT_GAIN_GUARDS):
            continue
        stats = m.group("stats")
        # `全技能威力` 的读点是**百分比**（`+N` = `+N%`），所以它不算平值 —— 即使原文没写 `%`。
        is_flat = (not m.group("pct")) and ("全技能威力" not in stats)
        if (not flat_declared) if is_flat else (not declared):
            continue
        num = int(m.group("num"))
        if m.group("sign") in ("-", "－"):
            num = -num
        side = "foe" if m.group("side") == "敌方" else "self"
        for name in re.split(r"和", stats):
            keys = COMBO_STAT_KEYS.get(name) or ((STAT_KEYS[name],) if name in STAT_KEYS else ())
            for k in keys:
                if is_flat:
                    kind = "self_stat_flat" if side == "self" else "foe_stat_flat"
                    value = {"stat": k, "delta_flat": num}
                else:
                    kind = "self_stat" if side == "self" else "foe_stat"
                    value = {"stat": k, "delta_pct": num}
                key = (kind, str(sorted(value.items())), m.group(0))
                if key in seen:
                    continue
                seen.add(key)
                parsed.effects.append(Effect(
                    kind=kind, target=side, value=value, evidence=m.group(0),
                    term="3014" if side == "self" else "3018"))
    return parsed


def resolve_position_mechanics(skill, *, slot_declared: bool, shift_declared: bool,
                             claim_effects: bool = False,
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
    # task-28（2026-09-30）：**号位 + 属性增益（第三种形状）的"认领 effect"** ——
    # `skill_000483 啮合传递`「本技能位于1号或3号位时**额外获得**物攻+80%」里那个「**获得**」
    # 会被标记循环记成一条 `获得：…` 未认领 span ✗；而**运行时确实会按号位写 `buffs['atk'] += 80`** ✓
    # （攻击支 `env.py:1453` 起 + 状态支 `env.py:1738` 起都由 `slot_conditions` 消费 ✓）
    # ⇒ 所以缺的只是**把这段认领掉的那条 effect**（`evidence` = 子句原文，含「获得」✓）。
    # ⚠ **只在 `claim_effects=True` 时产出**（判据链专用 ✓）：env 传默认 `False` ⇒
    #   **运行时逐字不动** ✓（也不会让 `_apply_effect_batch` 见到这个新 kind ✗）。
    if claim_effects and slot_declared:
        for _cond in parsed.slot_conditions or ():
            if _cond.get("stat") and _cond.get("delta_pct") and _cond.get("evidence"):
                parsed.effects.append(Effect(
                    kind="slot_stat", target="self",
                    value={"stat": str(_cond["stat"]), "delta_pct": int(_cond["delta_pct"])},
                    evidence=str(_cond["evidence"])))
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
    # task-28（H 族 `736`）：「（本次攻击）**使**敌方获得<状态>」⇒ 复用 `foe_status`（**不新开 kind** ✗）
    # ⚠ **必须带 `requires:"foe_switch"`** ✗ —— 否则 `env._gate_foe_switch_effects` 的第二道检查
    #   认不出它是条件效果 ⇒ **会无条件结算** ✗✗（= 敌方没换人也给萌化 ⇒ 正是本件的反证 ✗）
    m = _FS_GRANT_STATUS.search(rest)
    if m:
        effects.append(Effect(kind="foe_status", target="foe",
                              value={"status": m.group(1), "layers": 1,
                                     "requires": "foe_switch"},
                              evidence=m.group(0)))
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
        # 2026-09-30（task-26 H 族批一）**改钉**：`field == "hits"` 时，`_DYNAMIC_MULTI_HIT` 会把
        # 「本技能**连击数永久+1**」也记成一条「动态连击数」（因为它匹配 `连击数…+1`）⇒
        # **既结算又报未实现** ✗。实测代价：`skill_000261 乘胜追击` / `skill_000360 孢子爆散`
        # 运行时 `skill_ramps` 真的在涨、伤害也真的变了（11→74 / 32→215 ✓），
        # 而 `settlement_verdict` 判 False、档位 PARTIAL ⇒ **把已结算说成未结算** ✗。
        # 处理与 `resolve_on_hit_ramp` 对「（不含连击）」那一条**同一套**：只摘**被这条效果的
        # `evidence` 盖住的**那两条标记，不碰别的。
        # ⚠ **仅限 `field="hits"`**：`field="power"/"cost"` 的技能里若另有动态连击说法，
        # 那一条与本次认领无关，必须继续留在 `unparsed` 里（不许顺手放宽）。
        if str(info["field"]) == "hits":
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
    return parsed


def resolve_element_use_ramp(skill, *, declared: bool,
                             parsed: Optional[Parsed] = None) -> Parsed:
    """task-25 B 族（2026-09-30）：按**配置声明的能力**决定「每使用1次其他<本系>技能 /
    每使用过1个其他系别技能，本技能<属性>永久±N」要不要结算。

    与 `resolve_per_use_ramp` / `resolve_on_hit_ramp` / `resolve_triggered_ramp` **同一套口径**：
      · `declared=False`（legacy / v2 没声明 `damage.element_use_ramp`）⇒ 什么都不补，
        那段文本照旧是「未认领机制」、由 `env` 写进 `state.unsupported`；
      · 声明了才补一条 `element_ramp` 效果（`evidence` 就是原文那段 ⇒ 「每」那个机制词被同一把尺子判为已认领）。

    累加发生在 `env`（`_accumulate_element_use_ramp`）：**真的用出别的技能之后**才加，
    而且**只有 `happened=True`**（这一手没被 `action_cancelled` 取消）才算 ✓。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "element_ramp", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "element_ramp" for e in parsed.effects):
        parsed.effects.append(Effect(kind="element_ramp", target="self",
                                     value={"scope": str(info["scope"]),
                                            "element": info.get("element"),
                                            "field": str(info["field"]),
                                            "delta": int(info["delta"])},
                                     evidence=str(info["evidence"])))
        # 与 `resolve_per_use_ramp` 同一条处理：`field="hits"` 时把「本技能连击数永久±N」被
        # `_DYNAMIC_MULTI_HIT` 记成的那条「动态连击数」标记摘掉（本条已认领它）——
        # **仅限 hits**：power/cost 的技能里若另有动态连击说法，与本次认领无关，必须继续留在 `unparsed` ✓。
        if str(info["field"]) == "hits":
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
    return parsed


def resolve_triggered_ramp(skill, *, declared: bool,
                           parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十七（2026-09-30 task-26 H 族批一）：按**配置声明的能力**决定
    「每应对成功1次 / 应对X：…本技能<属性>永久±N」与「每次击败敌方，本技能<属性>永久±N」要不要结算。

    与 `resolve_per_use_ramp` / `resolve_on_hit_ramp` **同一套口径**：
      · `declared=False`（legacy / v2 没声明 `damage.triggered_ramp`）⇒ 什么都不补，
        那几段文本照旧是「未认领机制」、由 `env` 写进 `state.unsupported`；
      · 声明了才补一条 `triggered_ramp` 效果（`evidence` 就是原文那段 ⇒ 「每」等机制词被同一把尺子判为已认领）。
    累加发生在 `env`：**真的应对成功** / **真的把对手打倒下**时（两个落点都在 `_execute` 里）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "triggered_ramp", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "triggered_ramp" for e in parsed.effects):
        parsed.effects.append(Effect(kind="triggered_ramp", target="self",
                                     value={"trigger": str(info["trigger"]),
                                            "field": str(info["field"]),
                                            "delta": int(info["delta"])},
                                     evidence=str(info["evidence"])))
        # 与 `resolve_per_use_ramp` 同一条处理：`field="hits"` 时把**连击数永久±N**被
        # `_DYNAMIC_MULTI_HIT` 记成的那条「动态连击数」标记摘掉（它已经被本条认领了）。
        if str(info["field"]) == "hits":
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
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


def resolve_cost_per_own_debuff_layer(skill, *, declared: bool,
                                       parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十八（2026-09-30 **E 族缺口二** `446 清洗`）：按**配置声明的能力**决定
    「**自己**每有 N 层减益，本技能能耗 -M」要不要结算。

    与批次九的 `resolve_per_layer_cost` **同一条纪律**（只是数自己而不是对手）：
      · `declared=False`（legacy / v2 没声明能力位）⇒ 什么都不补，那段文本照旧被
        `unclaimed_mechanic_spans` 认作未认领机制（「每」「层」两条）、写进 `state.unsupported`；
      · 声明了才补一条 `cost_per_own_debuff_layer` 效果 —— 它的 `evidence` 覆盖**整条子句**，
        于是"已认领"仍由**同一把尺子**算出来，不是另抄白名单。
    结算在 `env.effective_skill_cost`（`resolved_skill_cost` 的**唯一实现**）里。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "cost_per_own_debuff_layer", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "cost_per_own_debuff_layer" for e in parsed.effects):
        parsed.effects.append(Effect(kind="cost_per_own_debuff_layer", target="self",
                                     value={"layer_step": int(info["layer_step"]),
                                            "delta": int(info["delta"])},
                                     evidence=str(info["evidence"])))
    return parsed


def resolve_per_layer_boost(skill, *, declared: bool,
                            parsed: Optional[Parsed] = None) -> Parsed:
    """RC-401 批次十六（2026-09-29 task-20 批四）：按**配置声明的能力**决定
    「敌方每有 N 层<中毒效果|印记|星陨印记>，本次技能威力/连击数 +M」要不要结算。

    与批次九的 `resolve_per_layer_cost` **同一条纪律**（读层数改数值的另一个出口）：
      · `declared=False`（legacy / v2 没声明 `damage.per_layer_boost`）⇒ 什么都不补，
        那段文本照旧被 `unclaimed_mechanic_spans` 认作未认领机制、写进 `state.unsupported`；
      · 声明了才补一条 `per_layer_boost` 效果 —— 它的 `evidence` 覆盖**整条子句**，
        于是"已认领"仍由**同一把尺子**算出来，不是另抄白名单。
    结算在 `env` 的伤害路径里（改的是**这一手**的威力/连击入参）。
    """
    parsed = parsed if parsed is not None else parse_skill(skill)
    info = getattr(parsed, "per_layer_boost", None)
    if not (declared and info):
        return parsed
    if not any(getattr(e, "kind", "") == "per_layer_boost" for e in parsed.effects):
        parsed.effects.append(Effect(
            kind="per_layer_boost", target="self",
            value={"field": str(info["field"]), "side": str(info["side"]),
                   "source": str(info["source"]), "layer_step": int(info["layer_step"]),
                   "delta": int(info["delta"])},
            evidence=str(info["evidence"])))
        if str(info["field"]) == "hits":
            # 「本次技能连击数 +M」这一条现在**有条件地真的结算了**（按层数；层数为 0 时不加，
            # 由 `env` 记 `per_layer_boost_skipped{reason:"no_layers"}`）。
            # ⚠ 不摘掉「动态连击数」那条标记，就会**既结算又报未实现**（实测 `skill_000808 多维击打`：
            # 判据永远 false、档位还说 PARTIAL）。无条件动态连击（`_DYNAMIC_MULTI_HIT` 的另一半）
            # 不在这里 —— 它们没有「每有N层」前缀，压根不会带上 `per_layer_boost`。
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
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
        # task-28：两种形状共用**同一个 effect kind** ✓（`power_pct` / `hits`）——
        # `env` 那一支只需要多读一个键 ✓ ⇒ **不需要新 kind**（也就不会有 ⓐ ✗）。
        _value = ({"power_pct": int(info["pct"])} if "pct" in info
                  else {"hits": int(info["hits"])})
        parsed.effects.append(Effect(kind="initiative_power", target="self",
                                     value=_value, evidence=str(info["evidence"])))
        # ⚠ `hits` 形状：把 `_DYNAMIC_MULTI_HIT` 记的那条「动态连击数」标记摘掉
        #   （**照 `resolve_per_use_ramp` 对 `field == "hits"` 的手法** ✓ 只在声明了能力时 ✓）
        if "hits" in info:
            parsed.unparsed = [row for row in parsed.unparsed
                               if not (("动态" in str(row) and "连击" in str(row))
                                       or str(row).startswith("连击（"))]
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
    # ⚠ 2026-09-29（task-25）：声明了 `stat_gain.flat` 时，平值已经被解析成
    # `self_stat_flat` / `foe_stat_flat`（带原文 `evidence`）⇒ **不再**算缺口。
    # 不加这一条的话，v3 里一条**真的结算了**的平值修正会被这里又登记成"未认领机制"
    # （判据判 false、档位判 PARTIAL）—— 那就是**假免责**，与 `skill_000612` 那一次同型。
    if flat:
        _ev = {str(getattr(e, "evidence", "") or "") for e in parsed.effects
               if e.kind in ("self_stat_flat", "foe_stat_flat")}
        flat = [x for x in flat if x.strip() not in {v.strip() for v in _ev}]
    if flat:
        parsed.unparsed.append(f"平值属性修正（出现在：{'、'.join(flat[:2])}）")
        return parsed
    parsed.unparsed = [row for row in parsed.unparsed
                       if not any(str(row).startswith(f"{marker}（")
                                  for marker in ("选择", "明", "暗"))]
    return parsed


def resolve_hit_count(skill, *, declared: bool,
                      parsed: Optional[Parsed] = None) -> "tuple[int, Parsed]":
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
    # 2026-09-29（task-20 批三）**改钉**：加 `parsed=` 形参（与 `resolve_position_mechanics` /
    # `resolve_foe_energy_loss` / `resolve_per_layer_cost` 等**同一条**约定）。
    # 不加的话这里内部 `parse_skill(skill)` 会**重新解析并整体覆盖**调用方手上的 `parsed` ——
    # 于是**前几个解析器刚补上的认领效果被悄悄丢掉**。实测（`coverage.settlement_verdict` 的顺序）：
    # `skill_000612 毒液渗透` 先被 `resolve_per_layer_cost` 补上带原文的 `per_layer_cost` 效果，
    # 紧接着这一行把它覆盖掉 ⇒ 判据又把「每有1层中毒效果」报成未认领、产品口径判未结算，
    # 而引擎**从批次九起就一直在按层数减能耗** ⇒ 假免责。
    # ⚠ 传进来的 `parsed` 可能已经带认领标记（`hit_count`）⇒ 下面两处都做成**幂等**。
    parsed = parsed if parsed is not None else parse_skill(skill)
    if not declared or not parsed.hit_count:
        return 1, parsed
    # 2026-09-29（task-20 批二）**改钉**：原来这一支是 `hit_count <= 1` 一律早退 ⇒
    # 描述里**静态写着「1连击」**的技能，那一段文本**没有任何东西认领它** ⇒
    # 被 `unclaimed_mechanic_spans` 报成「连击：1连击」⇒ 判据判未结算。
    # 实测代价：`skill_000257 追打`「造成魔伤，1连击，应对状态：本技能变为3连击。」
    # —— 它的应对覆盖（1→3 连击）在批二里**真的实现了**（`env` 发 `hits:3`），
    # 却因为基础那半句"1连击"没人认领而继续被判未实现（**假免责**，与人来口径相反）。
    # 所以：`declared=True` 且描述里**明写**了静态次数（`hit_count_evidence` 非空）时，
    # 连 N=1 也认领 —— 1 次就是伤害公式的默认值，属于**已结算**，不是"没做"。
    # 波及面实测（2026-09-29 更正）：全库含「1连击」10 条，判据翻正的**恰好 3 条**
    # （`追打` 有应对覆盖；`落石` / `音波弹` 是「造成X伤，1连击。」的纯单体一击）。
    # ⚠ 同一处注释早前写过"恰好 1 条" —— 那是**错的**（我的过滤漏掉了
    # `连击（出现在：…）` 这种标记，只数了 `连击：…`）⇒ 改钉留档，按实测的 3 条为准。
    # 未声明（legacy / v2）时这一步根本不执行 ⇒ 逐位不变（`declared=False` 上面就早退了）。
    if parsed.hit_count <= 1:
        if not parsed.hit_count_evidence:
            return 1, parsed
        if not any(getattr(e, "kind", "") == "hit_count" for e in parsed.effects):
            parsed.effects.append(Effect(
                kind="hit_count", target="self", value={"hits": int(parsed.hit_count)},
                evidence=parsed.hit_count_evidence, term=""))
        parsed.unparsed = [row for row in parsed.unparsed
                           if "动态" in str(row) or "连击" not in str(row)]
        return int(parsed.hit_count), parsed
    # 2026-09-29（task-18 A 批）：**认领标记**。静态「N连击」是真的结算了（伤害按 N 次算，
    # 见 `env._execute` 的 `hit_count` 与 `damage` 事件的 `hits`），但解析层过去不产出任何
    # 带 `evidence` 的效果 ⇒ `unclaimed_mechanic_spans()` 会把它报成"未认领"、
    # 服务端也会在 reason 里写"这一段没有实现"。427 条普查里这一类有 41 处（最大的一堆）。
    # 标记的取值由 `env` 的 `handled_kinds` 承认（它确实在伤害路径里被用掉）。
    # ⚠ 幂等：`parsed=` 传进来时可能已经带过一条（重复调用不许叠两条）。
    if not any(getattr(e, "kind", "") == "hit_count" for e in parsed.effects):
        parsed.effects.append(Effect(
            kind="hit_count", target="self", value={"hits": int(parsed.hit_count)},
            evidence=(parsed.hit_count_evidence or f"{int(parsed.hit_count)}连击"), term=""))
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
        # task-28：第三种形状「额外获得<属性>+N%」⇒ 记 **属性 + 百分比**（组 6/7 ✓ 不动 4/5 ✓）。
        # 属性名映射**只有这一份**（`_SLOT_STAT_BY_NAME`）；读点走**现成的 `buffs`**（伤害/先手各自读）✓。
        stat_key = _SLOT_STAT_BY_NAME.get(m.group(6)) if m.group(6) else None
        delta_pct = int(m.group(7)) if m.group(7) else 0
        # RC-401 批次十八：第四种形状「号位时能耗-N」⇒ 记**负的能耗修正**（`delta` 存负数 ✓）。
        # ⚠ **#47**：**组号按 alternation 顺序排** ⇒ 往 alternation 里插分支会**顶偏后面所有组号**
        #   ⇒ 插完**必须 dump `m.groups()` 复核**（本批实测：`额外减伤` 顶掉了组 8，`能耗` 顺移成组 9 ✗）。
        #   ⇒ 所以**引用按现测的组号写**：**能耗=组 9** · **额外减伤=组 8** ✓（**不许改分支顺序** ✗ —— 换了会再顶偏别的组）。
        cost_delta = -int(m.group(9)) if m.group(9) else 0
        # RC-401 批次十八：第五种形状「号位时额外减伤N%」⇒ 记**额外减伤百分点**（int ✓）。
        reduction_pct = int(m.group(8)) if m.group(8) else 0
        out.slot_conditions.append({
            "slots": slots,
            "cost_delta": cost_delta,
            "reduction_pct": reduction_pct,
            "power_delta": power_delta,
            "combo_bonus": combo_bonus,
            "stat": stat_key,
            "delta_pct": delta_pct,
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

    # task-25 B 族（2026-09-30）：「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，
    # 本技能<属性>永久±N」。**只记结构、不发 Effect**（落地与否由 `damage.element_use_ramp` 决定）。
    _erm = _ELEMENT_USE_RAMP.search(desc)
    if _erm:
        # 条件句闸：命中所在的整句里、命中**之前**出现「若/选择/应对/期间/或」⇒ 不认领
        # （与 `resolve_stat_gain_extended` 同一把尺子：那类要的是新的结算支）
        _s = max(desc.rfind(c, 0, _erm.start()) for c in "。；") + 1
        if not any(g in desc[_s:_erm.start()] for g in _ELEMENT_RAMP_GUARDS):
            _elem = _erm.group("elem")
            out.element_ramp = {
                # 「其他<本系>技能」⇒ 同系（本技能自己不算）；「其他系别技能」⇒ 异系
                "scope": "same_element" if _elem != "系别" else "other_element",
                "element": None if _elem == "系别" else _elem,
                "field": {"威力": "power", "能耗": "cost", "连击数": "hits"}[_erm.group("stat")],
                "delta": int(_erm.group("num")) * (-1 if _erm.group("sign") in "-－" else 1),
                "evidence": _erm.group(0)}

    # RC-401 批次十七（2026-09-30 task-26 H 族批一）：「每应对成功1次 / 应对X：…本技能永久±N」与
    # 「每次击败敌方，本技能永久±N」。**只记结构、不发 Effect**（落地与否由 `damage.triggered_ramp` 决定）。
    # ⚠ **「应对成功」这一类必须先证明它判得出来**：`env._respond_success` 读的是
    # `effects.respond_to(skill)`，而它**只在描述里写了 `应对状态/攻击/防御` 时才有值**。
    # 实测 `skill_000267 能量刃`「造成物伤，**每应对成功1次**，本技能威力永久+90。」与
    # `skill_000679 叠势`「…**每成功应对1次**…」的 `desc_notes` 是 `null`、描述里**没有应对类别** ⇒
    # `respond_to()` 返回 `None` ⇒ 那一手**永远判不出「应对成功」** ⇒ 触发器**永不成立**。
    # ⇒ 这两条**不许认领**（认了就是"既没生效又报已结算"的假绿 ✗）：留在未认领里、由判据点名，
    #   把「类别缺失 ⇒ 判不出成功与否」如实报出来。**不猜一个类别** ✗。
    _respond_category_stated = bool(_RESPOND_KIND_IN_DESC.search(desc))
    for _trig, _pat, _groups in (
            ("respond_success", _TRIGGERED_RESPOND_RAMP, (1, 2, 3)),
            ("respond_success", _RESPOND_CLAUSE_RAMP, (1, 2, 3)),
            # task-28：复合应对子句里的尾巴（`289 无畏之心`）—— ⚠ **evidence 只取"且…永久±N"那一小段** ✗：
            # 若取整句，它会把同句里**别的**子句（「减免的伤害变为回复自己生命」）也一起"覆盖"掉
            # ⇒ 那条子句的能力位明明没声明，判据却说已结算 ⇒ **假绿** ✗
            # （实测：只加这条正则、evidence 取整句 ⇒ 关掉 `respond_reduction_to_heal` 后 289 仍判可模拟 ✗）
            ("respond_success", _RESPOND_CLAUSE_RAMP_TAIL, (2, 3, 4)),
            ("defeat_foe", _TRIGGERED_DEFEAT_RAMP, (1, 2, 3)),
            ("end_of_turn", _TRIGGERED_END_TURN_RAMP, (1, 2, 3))):
        if _trig == "respond_success" and not _respond_category_stated:
            continue
        _tm = _pat.search(desc)
        if not _tm:
            continue
        out.triggered_ramp = {
            "trigger": _trig,
            "field": {"威力": "power", "能耗": "cost", "连击数": "hits"}[_tm.group(_groups[0])],
            "delta": int(_tm.group(_groups[2])) * (-1 if _tm.group(_groups[1]) in "-－" else 1),
            # task-28：默认 evidence = 整段命中（老行为逐字不变 ✓）；
            # 只有 `_RESPOND_CLAUSE_RAMP_TAIL` 那种"复合句里的尾巴"才**只取尾巴那一小段** ✗
            # —— 取整句会把同句里别的、能力位没声明的子句也"覆盖"掉 ⇒ 假绿 ✗
            "evidence": (_tm.group(1) if _pat is _RESPOND_CLAUSE_RAMP_TAIL else _tm.group(0)),
        }
        break

    # RC-401 批次十一：「若敌方本回合更换精灵，<效果>」——条件在结算时是**已知事实**
    # （对手这一手提交的就是换人），所以只需要把条件后面的效果读出来。**只记结构、不发 Effect**。
    _fs = _FOE_SWITCH_CLAUSE.search(desc)
    if _fs:
        out.foe_switch_effects, out.foe_switch_leftover = _parse_foe_switch_body(_fs.group("body"))
        out.foe_switch_clause = _fs.group(0)

    # RC-401 批次九：动态能耗修正（「敌方每有N层中毒效果，本技能能耗-M」）。只记结构。
    # 逐字对上「自己每有1层减益，本技能能耗-1」（`446 清洗`）⇒ 记 `layer_step` 与负 `delta` ✓
    _COST_PER_OWN_DEBUFF_LAYER = re.compile(
        r"自己每有\s*(\d+)\s*层\s*减益[^。；]{0,8}本技能能耗\s*-\s*(\d+)")

    _plc = _PER_LAYER_COST.search(desc)
    if _plc:
        out.per_layer_cost = {"status": "中毒", "layer_step": int(_plc.group(1)),
                              "delta": -int(_plc.group(2)), "evidence": _plc.group(0)}

    # RC-401 批次十八（2026-09-30 E 族缺口二）：**自己**每有 N 层减益 ⇒ 本技能能耗 -M。
    # 与批次九同形（数层数改费用），但**数的是自己身上的减益键**（状态量 ✓ 算费那刻读得到 ✓）。
    # 同样**只记结构、不发 Effect**（未声明能力位时那段照旧是未认领机制 ✓）。
    _cpo = _COST_PER_OWN_DEBUFF_LAYER.search(desc)
    if _cpo:
        out.cost_per_own_debuff_layer = {"layer_step": int(_cpo.group(1)),
                                         "delta": -int(_cpo.group(2)),
                                         "evidence": _cpo.group(0)}

    # RC-401 批次十六（2026-09-29 task-20 批四）：「敌方每有N层<来源>，本次技能威力/连击数+M」。
    # 与批次九同一纪律：**只记结构、不发 Effect、不摘标记**（未声明能力时那一段照旧是未认领机制）。
    # 来源名从描述原文归一：`中毒效果` → `中毒`；`星陨印记`/`印记` 原样（印记是**通用**读法）。
    _plb_power = _PER_LAYER_POWER.search(desc)
    _plb_hits = _PER_LAYER_HITS.search(desc)
    if _plb_power or _plb_hits:
        _plb = _plb_power or _plb_hits
        _src = _plb.group(2)
        out.per_layer_boost = {
            "field": "power" if _plb_power else "hits",
            "side": "foe",
            "source": "中毒" if _src == "中毒效果" else _src,
            "layer_step": int(_plb.group(1)),
            "delta": int(_plb.group(3)),
            "evidence": _plb.group(0),
        }

    # RC-401 批次八：先手条件（「若先于敌方攻击，本次技能威力+N%」）。同上：只记结构。
    _init = _INITIATIVE_POWER.search(desc)
    if _init:
        out.initiative_power = {"pct": int(_init.group(1)), "evidence": _init.group(0)}
    _inith = _INITIATIVE_HITS.search(desc)
    if _inith and not out.initiative_power:
        # 两种形状在本语料里互斥（威力% / 连击数）⇒ 加 `not out.initiative_power` 兜住"万一都有"的情形 ✓
        out.initiative_power = {"hits": int(_inith.group(1)), "evidence": _inith.group(0)}

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
