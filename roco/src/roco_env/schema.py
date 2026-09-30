"""对局状态与动作的数据结构，以及序列化。

设计要点：

  - 状态是**纯数据**：全部可 JSON 往返。这样 replay 与差分测试才可能。
  - `state_version` 每次状态改变都 +1。教练侧的「旧建议必须作废」靠它。
  - 隐藏信息按**视角**裁剪，不靠上层自觉：`observation_for()` 只吐公开字段。
  - 未核验的机制集中放在 `unsupported` 集合里，而不是散落在各字段的
    「默认值」中——这样「我们不知道」在数据里是可见的。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .data import Ruleset

# ── 动作 ────────────────────────────────────────────────────────────────

ACTION_SKILL = "skill"
ACTION_SWITCH = "switch"
ACTION_ITEM = "item"
ACTION_ESCAPE = "escape"
ACTION_STRUGGLE = "struggle"   # 无合法技能时的保底；是否真实存在存疑，见 README
# RC-105：**聚能**是标准 PVP 的独立动作类（不是某个技能的子类，也不是「能量不足时的兜底」）。
# 依据：台账 EV-ENERGY-CHARGE（CROSS_SOURCE_SUPPORTED）：「聚能是一个主动行动，回复 5」；
# 该条 needs_microcase=true，MC-E02 未录制 —— 所以「它是独立动作类」这件事在配置里是候选假设。
ACTION_CHARGE = "charge"
# RC-105：**投降**是独立动作类（合法动作里必须出现，标准 PVP 没有道具与逃跑）。
# 台账里**没有**任何条目讲投降的语义（是否算判负、是否扣魔力）—— 见 `mana.surrender` 的 reason。
ACTION_SURRENDER = "surrender"
# 2026-09-23：**PVP 魔法**是独立动作类（愿力强化 / 共鸣魔法）。
# 为什么不能塞进 `item`：台账 EV-PVP-WISH-POWER-UP 明确它「**不是**普通道具」
# （`magic_policy.is_item = false`），而标准 PVP 的 `item` 这一类是 **forbidden** ——
# 借 item 的道会让「标准 PVP 没有普通道具」这条口径当场破掉。
# 依据：台账 EV-PVP-WISH-POWER-UP（RECORDED_IN_GAME，人类口述）；产物见
# `data/roco/derived/pvp-magic.json`（愿力强化的口径 + 36 条愿力冲击变体）。
ACTION_MAGIC = "magic"

VALID_KINDS = (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM, ACTION_ESCAPE, ACTION_STRUGGLE,
               ACTION_CHARGE, ACTION_SURRENDER, ACTION_MAGIC)

#: RC-105：每种动作类**必须**带齐的字段。缺了就在构造期抛 `ValueError`
#: （`Action.__post_init__` 真的会跑，不是一句注释）。`charge` / `surrender` /
#: `escape` / `struggle` 不带字段，所以不在这里出现。
#:
#: `item` 只要 `item_id`：目标位省略时引擎按「自己场上那只」处理
#: （`_use_item` 里 `target_index or me.active`），既有调用点就是这么传的。
ACTION_REQUIRED_FIELDS = {
    ACTION_SKILL: ("skill_id",),
    ACTION_SWITCH: ("target_index",),
    ACTION_ITEM: ("item_id",),
    # `magic` 只要 `magic_id`（哪一条 PVP 魔法）；目标由该条魔法自己的口径决定
    # （愿力强化：`target = self_active`，所以题面**不**接受目标位 —— 少一个可被滥用的入口）。
    ACTION_MAGIC: ("magic_id",),
}


@dataclass(frozen=True)
class Action:
    """一个动作。

    `skill_id` 用技能 id 而不是名字或下标：名字会变、下标会错位，
    而 id 在快照里是稳定的（这也是 M1 导入时的选择）。
    """

    kind: str
    skill_id: Optional[str] = None    # kind == skill
    target_index: Optional[int] = None  # kind == switch / item 的目标位
    item_id: Optional[str] = None     # kind == item
    magic_id: Optional[str] = None    # kind == magic（PVP 魔法：愿力强化…）

    #: RC-105：每种动作类**必须**带齐的字段。缺了就在构造期抛 `ValueError`。
    REQUIRED_FIELDS = ACTION_REQUIRED_FIELDS

    def __post_init__(self) -> None:
        if self.kind not in VALID_KINDS:
            raise ValueError(f"未知动作类型：{self.kind}")
        for name in ACTION_REQUIRED_FIELDS.get(self.kind, ()):
            if getattr(self, name) is None:
                raise ValueError(f"动作 {self.kind} 缺字段 {name}")

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"kind": self.kind}
        if self.skill_id is not None:
            d["skill_id"] = self.skill_id
        if self.target_index is not None:
            d["target_index"] = self.target_index
        if self.item_id is not None:
            d["item_id"] = self.item_id
        if self.magic_id is not None:
            d["magic_id"] = self.magic_id
        return d

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Action":
        kind = d.get("kind")
        if kind not in VALID_KINDS:
            raise ValueError(f"未知动作类型：{kind}")
        return Action(
            kind=kind,
            skill_id=d.get("skill_id"),
            target_index=d.get("target_index"),
            magic_id=d.get("magic_id"),
            item_id=d.get("item_id"),
        )

    def label(self, rs: Ruleset) -> str:
        if self.kind == ACTION_SKILL:
            return rs.skill(self.skill_id).name if self.skill_id else "技能"
        if self.kind == ACTION_SWITCH:
            return f"换上第{(self.target_index or 0) + 1}位"
        if self.kind == ACTION_ITEM:
            return f"使用{self.item_id}"
        if self.kind == ACTION_MAGIC:
            # 2026-09-23：名字来自**派生产物**（`data/roco/derived/pvp-magic.json` 的 magic.name），
            # 不是动作类的字面量。实测踩到的：页面物品屏那一格显示成「magic」——
            # 因为 `label()` 对未登记的 kind 直接回落到 kind 本身。
            # 读不到就写「PVP 魔法」（不编一个名字）。
            doc = getattr(rs, "pvp_magic", None) or {}
            magic = doc.get("magic") if isinstance(doc, dict) else None
            return str((magic or {}).get("name") or "PVP 魔法")
        return {"escape": "撤退", "struggle": "挣扎",
                # RC-105：聚能/投降是**独立动作类**，名字照实写，不借用技能的叫法
                "charge": "聚能", "surrender": "投降"}.get(self.kind, self.kind)


# ── 精灵与队伍 ──────────────────────────────────────────────────────────


@dataclass
class PetState:
    """场上一只精灵的可变状态。"""

    pet_id: str
    slot: int                     # 队伍里的位次（0 起）
    level: int = 1
    hp: int = 0
    max_hp: int = 0
    energy: int = 0
    statuses: Dict[str, Any] = field(default_factory=dict)   # 例 {"灼烧": {"layers": 3}}
    marks: Dict[str, Any] = field(default_factory=dict)      # 印记；3010 说最多 1 正 + 1 负
    buffs: Dict[str, int] = field(default_factory=dict)      # 属性增减
    charge: Optional[Dict[str, Any]] = None                  # 蓄力中（术语 1007）
    defense_cooldown: int = 0                                # 术语 1016「防御技能进入 1 回合冷却」
    entered_turn: Optional[int] = None                        # 入场回合，用于「迸发」(1010)
    used_burst: bool = False
    fainted: bool = False
    #: RC-401 批三（2026-09-23）：**技能能耗修正**。术语 1012/1013 把「降低 / 增加能耗」
    #: 明确列进增益与减益，但在此之前全仓只有 traits.py 里一个没人读的 `_energy_cost_delta_all`
    #: 标记 —— 机制本身不存在（`cost_mod` / `cost_delta` 零命中）。
    #: 每条 = `{"scope": all|attack|defense|status, "delta": int, "until_turn": int|None, "source": str}`；
    #: **只在非空时进序列化**（与 `SideState.mana` 同一条纪律）：legacy / v2 里没有这条概念，
    #: 序列化里也不出现这个键，8 条 golden 指纹逐位不变。
    energy_cost_mods: List[Dict[str, Any]] = field(default_factory=list)
    #: RC-401 批四（2026-09-23）：**吸血与「过量回复转化」**（数据里写作「获得50%吸血，
    #: 每过量回复5%生命转化为10%物攻」）。形状：
    #: `{"lifesteal_pct": int, "overheal": {"chunk_pct": int, "gain_pct": int, "stats": [...],
    #:   "carry_pct": float}}`。由特性在入场时按**解析出来的**数值写入，结算在 `env._settle_sustain`。
    #: 同样**只在非空时进序列化**（legacy / v2 里没有这条概念，golden 指纹逐位不变）。
    sustain: Dict[str, Any] = field(default_factory=dict)
    #: RC-401 批次十二（2026-09-25）：**「每次使用后，本技能<属性>永久±N」** 的累计量。
    #: 形状：`{skill_id: {"power": int, "cost": int, "hits": int}}`（缺的键就是 0）。
    #: 只在配置声明了 `damage.per_use_ramp` 时才会被写；同样**只在非空时进序列化**。
    skill_ramps: Dict[str, Any] = field(default_factory=dict)
    #: task-25 B 族（2026-09-30）：**这一只「按系别」用过的技能次数**（系别 → 次数）。
    #:
    #: 为什么记系别而不是记技能：B 族的三种写法数的都是**别的技能**——
    #:   · 「每使用1次其他<本系>技能」⇒ 数**同系**的其它技能（`skill_000270 蓄能轰击` / `skill_000343 光能聚集`）；
    #:   · 「每使用过1个其他系别技能」⇒ 数**异系**技能（`skill_000450 过曝`；口径按"**次数**"登记，
    #:     见生成器 `damage.element_use_ramp` 的 reason —— 若日后定为"不同系别**个数**"只改那一处）。
    #: 累加点与 `skill_ramps` **同一个落点**：只有这一手**真的打出去了**（`happened=True`）才计数 ⇒
    #: `action_cancelled{reason:"fainted"}` 那种**不算**。只在配置声明了 `damage.element_use_ramp`
    #: 时才会被写；同样**只在非空时进序列化**（legacy / v2 逐位不变）。
    skill_use_elems: Dict[str, int] = field(default_factory=dict)
    #: task-28（2026-09-30）：**按系别的持久威力修正**（系别 → 百分比）。
    #:
    #: 服务 `skill_000462 放晴`「**光系**技能威力**永久**+50%，应对防御：改为永久+100%」这一族：
    #:   · **持久**（不是"下一手"）· **按系别**（光系技能都吃，不是"本技能"）⇒ **不走 `skill_ramps`** ✓
    #:   · 与 `buffs["power_water"]` 那条**旧路并行、互不重叠**（旧表 `ELEMENT_POWER_BUFF_KEYS`
    #:     只映射水/武/虫/冰 4 系，且服务的是另一批技能）—— 两边都由 `effects.compute_damage` 读 ✓
    #: 只在非空时进序列化 ⇒ legacy / v2 逐位不变 ✓
    element_power_mods: Dict[str, int] = field(default_factory=dict)
    #: task-28（H 族 `721`/`728`）：**"全技能"级的持久修正** —— `{"power_pct": int, "cost_delta": int}`。
    #: ⚠ **作用域 = 所有技能** ✗ —— 与 `skill_ramps`（**逐技能** ✗）· `buffs`（**属性** ✗）·
    #:   `element_power_mods`（**按系别** ✗）**都不同** ✓（现有三个写点都不覆盖 ⇒ 才新开这一个 ✓）。
    #: **非空才进序列化** ✓（与 `element_power_mods` 同一条纪律 ✓ ⇒ legacy / v2 逐位不变 ✓）。
    global_skill_mods: Dict[str, int] = field(default_factory=dict)
    #: 2026-09-29（Q8「同一规则同一投影」）：**这一只的六维面板**。
    #:
    #: 产品那一跳把「选中的实例 + 培养快照」发下来（`/battle/new` 的 `individuals`），
    #: 引擎据此算出**与列表/详情同一份投影**的六维（`individuals.panel_from_snapshot`）。
    #: 形状：`{"hp": int, "atk": int, "spa": int, "def": int, "spd": int, "spe": int}`。
    #: **空 = 这只没有快照**（走种族值路径）⇒ 回执里两种情况必须能分辨，不许看起来一样。
    panel: Dict[str, int] = field(default_factory=dict)
    #: 2026-09-29（task-25，A 族「获得 属性±N」）：**平值**属性修正（描述里不带 `%` 的那一类）。
    #:
    #: 为什么必须与 `buffs` **分开记账**：`buffs` 的语义是**百分点**（`+30` = +30%），
    #: 而数据里有一类是**面板量纲的绝对值**——「自己获得速度+120」是速度**加 120 点**，
    #: 不是 +120%。两套量纲混在一个字典里就是静默错算，所以分成两个字段、两个读点。
    #: 形状：`{属性键: 平值}`（键与 `parse.STAT_KEYS` 同源）。
    #: **只在配置声明了 `damage.stat_gain_flat` 时才会被写**，且**只在非空时进序列化** ——
    #: legacy / v2 里没有这条概念，golden 指纹逐位不变。
    #:
    #: 实测（全库 `rs.skills` 逐条扫，见 task-25 的探针）：**平值修正只出现在速度上**
    #: （14 处 / 15 条技能：`自己获得速度+50/+30/+60/+70/+80/+120`、`自己获得速度-20`、
    #: `敌方获得速度-30/-90/-20`）⇒ 目前唯一的读点是**先手速度**（`env.order_speed`）。
    buffs_flat: Dict[str, int] = field(default_factory=dict)
    #: 这一只的个体来源：`individual-snapshot`（有快照）或空串（没有）。
    individual_source: str = ""
    #: 快照里的实例 id（如 `own-0001`）。人类逐字：「实例重复物种时不能只靠 speciesID 推断来源」。
    individual_id: Optional[str] = None
    #: 快照里的等级（默认 60）。**只在有快照时出现**。
    individual_level: Optional[int] = None
    #: 面板用的投影版本号（`individuals.PROJECTION_VERSION`）：两侧「版本号一致」的那一项。
    panel_projection: Optional[str] = None

    @property
    def alive(self) -> bool:
        return self.hp > 0 and not self.fainted

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pet_id": self.pet_id,
            "slot": self.slot,
            "level": self.level,
            "hp": self.hp,
            "max_hp": self.max_hp,
            "energy": self.energy,
            "statuses": copy.deepcopy(self.statuses),
            "marks": copy.deepcopy(self.marks),
            "buffs": dict(self.buffs),
            "charge": copy.deepcopy(self.charge),
            "defense_cooldown": self.defense_cooldown,
            "entered_turn": self.entered_turn,
            "used_burst": self.used_burst,
            "fainted": self.fainted,
            **({"energy_cost_mods": copy.deepcopy(self.energy_cost_mods)}
               if self.energy_cost_mods else {}),
            **({"sustain": copy.deepcopy(self.sustain)} if self.sustain else {}),
            **({"skill_ramps": copy.deepcopy(self.skill_ramps)} if self.skill_ramps else {}),
            # task-25 B 族：与 `skill_ramps` 同一条纪律 —— **只在非空时出现**
            # （legacy / v2 / 没声明能力位的对局，序列化逐位不变）。
            **({"skill_use_elems": dict(self.skill_use_elems)} if self.skill_use_elems else {}),
            **({"element_power_mods": dict(self.element_power_mods)}
               if self.element_power_mods else {}),
            **({"global_skill_mods": dict(self.global_skill_mods)}
               if self.global_skill_mods else {}),
            # 2026-09-29（Q8）：只在**有快照**时出现这四个键 —— 没有快照的老路径
            # （legacy / v2 / 不传 individuals 的调用方）序列化逐位不变。
            **({"panel": dict(self.panel)} if self.panel else {}),
            **({"individual_source": self.individual_source} if self.individual_source else {}),
            **({"individual_id": self.individual_id} if self.individual_id else {}),
            **({"individual_level": self.individual_level}
               if self.individual_level is not None else {}),
            **({"panel_projection": self.panel_projection} if self.panel_projection else {}),
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "PetState":
        return PetState(
            pet_id=d["pet_id"],
            slot=d["slot"],
            level=d.get("level", 1),
            hp=d["hp"],
            max_hp=d["max_hp"],
            energy=d.get("energy", 0),
            statuses=dict(d.get("statuses") or {}),
            marks=dict(d.get("marks") or {}),
            buffs=dict(d.get("buffs") or {}),
            charge=d.get("charge"),
            defense_cooldown=d.get("defense_cooldown", 0),
            entered_turn=d.get("entered_turn"),
            used_burst=d.get("used_burst", False),
            fainted=d.get("fainted", False),
            # 没有这个键 = 没有任何能耗修正（legacy / v2 的往返形状不变）。
            energy_cost_mods=list(d.get("energy_cost_mods") or []),
            sustain=dict(d.get("sustain") or {}),
            skill_ramps={k: dict(v) for k, v in (d.get("skill_ramps") or {}).items()},
            # 没有这个键 = 这一只没有任何"按系别计数"（legacy / v2 的往返形状不变）。
            skill_use_elems={str(k): int(v) for k, v in (d.get("skill_use_elems") or {}).items()},
            element_power_mods={str(k): int(v) for k, v in (d.get("element_power_mods") or {}).items()},
            global_skill_mods={str(k): int(v) for k, v in (d.get("global_skill_mods") or {}).items()},
            panel={k: int(v) for k, v in (d.get("panel") or {}).items()},
            individual_source=str(d.get("individual_source") or ""),
            individual_id=d.get("individual_id"),
            individual_level=d.get("individual_level"),
            panel_projection=d.get("panel_projection"),
        )


@dataclass
class SideState:
    """一方（player / enemy）。"""

    name: str
    pets: List[PetState] = field(default_factory=list)
    active: int = 0                       # 场上精灵在 pets 里的下标
    items: Dict[str, int] = field(default_factory=dict)
    # 每只精灵这场带的 4 个技能（pet_id -> skill_id 元组）。
    # 合法动作按它枚举：图鉴可学 ≠ 这场带得上。
    loadouts: Dict[str, Any] = field(default_factory=dict)
    #: RC-105：这一方还剩多少**魔力（心）**。
    #:
    #: `None` = **本局的规则配置没有声明魔力系统**（legacy / v2）——
    #: 那一刻引擎里**不存在**这条概念，序列化里也**不会出现** `mana` 键。
    #: 给它补一个 0 就是编规则：0 的意思是「已经判负」，而不是「没有这个概念」。
    mana: Optional[int] = None
    #: 2026-09-23：这一方的 **PVP 魔法**状态（愿力强化）。
    #:
    #: `None` = 本局的规则配置**没有声明** `magic` 这一类（legacy / v2）——
    #: 与 `mana` 同一条纪律：那一刻引擎里不存在这条概念，序列化里也**不会出现**这个键
    #: （legacy / v2 的 8 条 golden 指纹因此一个字节都不变）。
    #:
    #: 形状：`{"uses_left": int, "cooldown": int, "swapped": {pet_id: 原来的第一个技能 id}}`
    #:   · `uses_left`  —— 这一局还能用几次（人类口径：2 次；还原**不**消耗次数）；
    #:   · `cooldown`   —— 还剩几回合冷却（人类口径：3 回合，还原之后才开始算）；
    #:   · `swapped`    —— 哪几只精灵的第一个技能被换成了「愿力冲击」，以及换之前是什么。
    magic: Optional[Dict[str, Any]] = None

    @property
    def field_pet(self) -> PetState:
        return self.pets[self.active]

    def living(self) -> List[PetState]:
        return [p for p in self.pets if p.alive]

    def bench_indices(self) -> List[int]:
        return [i for i, p in enumerate(self.pets) if p.alive and i != self.active]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "active": self.active,
            "items": dict(self.items),
            # **配招必须一起序列化**。`from_dict` 一直在读它，而这里从来没写过，
            # 于是每一次 `serialize → deserialize` 往返（私有域的每个端点都要走）
            # 都会把配招丢成 `{}`。后果不是报错，而是**安静地换了输入**：
            #   · `public_planner_state` 的 `loadouts` 变成空 → 规划器重建状态时
            #     退回 `learnsets.all_skill_ids`（全部可学技能），候选池与真实
            #     合法动作不是同一套；
            #   · `_damage_preview` 找不到任何攻击技能 → 页面上的伤害预览恒为不可用。
            # 第 43 轮由「伤害预览为什么一直是空」追到这里。
            "loadouts": {k: list(v) for k, v in (self.loadouts or {}).items()},
            "pets": [p.to_dict() for p in self.pets],
            # RC-105：**只有声明了魔力系统的配置才写这个键**。legacy / v2 的序列化
            # 因此一个字节都不变（8 条 golden 指纹仍然成立）；反过来，声明了 mana 的
            # 模式也不许被补一个 0 —— `0` 是「魔力归零、已经判负」，不是「没有这个概念」。
            **({"mana": self.mana} if self.mana is not None else {}),
            # 同上：没声明 magic 的配置不写这个键（legacy/v2 序列化逐字节不变）。
            **({"magic": dict(self.magic)} if self.magic is not None else {}),
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "SideState":
        return SideState(
            name=d["name"],
            active=d["active"],
            items=dict(d.get("items") or {}),
            loadouts={k: tuple(v) for k, v in (d.get("loadouts") or {}).items()},
            pets=[PetState.from_dict(p) for p in d["pets"]],
            # 老存档没有这个键 → `None`（= 当时那份配置没有魔力系统），不是 0。
            mana=d.get("mana"),
            # 老存档没有这个键 → `None`（= 当时那份配置没有 PVP 魔法），不是空状态。
            magic=(dict(d["magic"]) if isinstance(d.get("magic"), dict) else None),
        )


# ── 事件与对局 ──────────────────────────────────────────────────────────


@dataclass
class Event:
    """回合内发生的一件事。事件流是 replay 与微案例断言的载体。"""

    kind: str
    turn: int
    detail: Dict[str, Any] = field(default_factory=dict)
    evidence: Tuple[str, ...] = ()     # 术语 id 或技能 id，说明依据

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "turn": self.turn,
            "detail": self.detail,
            "evidence": list(self.evidence),
        }


@dataclass
class GameState:
    """一整局。纯数据，可 JSON 往返。"""

    ruleset_id: str
    seed: int
    player: SideState
    enemy: SideState
    turn: int = 1
    phase: str = "battle"            # battle / replace / ended
    result: Optional[str] = None     # win / loss / draw / escaped
    state_version: int = 0
    replace_queue: List[str] = field(default_factory=list)
    events: List[Event] = field(default_factory=list)
    log: List[str] = field(default_factory=list)
    unsupported: List[Dict[str, Any]] = field(default_factory=list)
    # 存档的最小必要信息，便于 replay 从序列化状态继续
    history: List[Dict[str, Any]] = field(default_factory=list)
    #: 这一局用的**规则配置 id**（RC-101）。空串 = 由调用方在 reset 前没绑定的旧状态。
    #: 有它，存档/回放才说得清「当时按哪份规则算的」——规则 candidate 切换后这一点是刚需。
    ruleset_config_id: str = ""
    #: RC-106：这一局**显式声明过的未核验覆盖**（见 `overrides.py`）。
    #:
    #: 为什么它必须住在状态里、而不是只活在 `reset` 的参数里：覆盖改变的是这一局
    #: 实际用的规则值（例如入场初始能量）。存档、回放、公开面、UI 都必须说得清
    #: 「这一局哪些数是按假设走的」——否则页面只能假装自己知道标准 PVP 的入场能量。
    #: **空列表时序列化里不出现这个键**，legacy / 无覆盖的对局因此逐位不变。
    unverified_overrides: List[Dict[str, Any]] = field(default_factory=list)
    #: 2026-09-25（人类裁决「那你就做！」）：**当前天气与剩余回合数**。
    #:
    #: 形状：`{"name": "雨天", "turns_left": 8, "duration_turns": 8, "set_turn": 3, "source_skill_id": …}`。
    #: `None` = 场上没有天气。天气是**场地级**的公开事实（官方逐字：「天气是常驻在全场的效果，
    #: 让对战双方都能获得相应的加成，但天气只能存在一种」；「对局战报查看当前天气的剩余回合数」），
    #: 所以它不是隐藏信息，双方都看得到剩余回合数。
    #: **只有规则配置声明了天气层时才会有值**（`RuleConfig.weather_enabled`）——
    #: 没声明时引擎不发明天气行为，这一格恒为 None，序列化里也不出现这个键
    #: （legacy / v2 的 golden 指纹因此逐位不变）。
    weather: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ruleset_id": self.ruleset_id,
            "ruleset_config_id": self.ruleset_config_id,
            "seed": self.seed,
            "turn": self.turn,
            "phase": self.phase,
            "result": self.result,
            "state_version": self.state_version,
            "replace_queue": list(self.replace_queue),
            "player": self.player.to_dict(),
            "enemy": self.enemy.to_dict(),
            "events": [e.to_dict() for e in self.events],
            "log": list(self.log),
            "unsupported": copy.deepcopy(self.unsupported),
            # RC-106：**只有真的用了覆盖才写这个键**。没有覆盖的对局（含全部 legacy
            # 调用点）序列化一个字节都不变 —— 8 条 golden 指纹仍然成立。
            **({"unverified_overrides": copy.deepcopy(self.unverified_overrides)}
               if self.unverified_overrides else {}),
            # 天气同理：**场上没有天气时一个键都不多**（legacy / v2 / 没开天气的对局逐位不变）。
            **({"weather": copy.deepcopy(self.weather)} if self.weather else {}),
            "history": copy.deepcopy(self.history),
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "GameState":
        return GameState(
            ruleset_id=d["ruleset_id"],
            ruleset_config_id=d.get("ruleset_config_id", ""),
            seed=d["seed"],
            player=SideState.from_dict(d["player"]),
            enemy=SideState.from_dict(d["enemy"]),
            turn=d["turn"],
            phase=d["phase"],
            result=d.get("result"),
            state_version=d.get("state_version", 0),
            replace_queue=list(d.get("replace_queue") or []),
            events=[Event(kind=e["kind"], turn=e["turn"], detail=e.get("detail") or {},
                          evidence=tuple(e.get("evidence") or []))
                    for e in d.get("events", [])],
            log=list(d.get("log") or []),
            unsupported=copy.deepcopy(d.get("unsupported") or []),
            # 老存档没有这个键 → 空列表（= 当时没有用任何覆盖），不是「覆盖未知」。
            unverified_overrides=copy.deepcopy(list(d.get("unverified_overrides") or [])),
            # 老存档没有这个键 → None（= 当时场上没有天气），不是「天气未知」。
            # 这一条对**回放**很关键：没有天气的旧录屏重放出来必须还是没有天气。
            weather=(copy.deepcopy(d["weather"]) if isinstance(d.get("weather"), dict) else None),
            history=copy.deepcopy(d.get("history") or []),
        )


# ── 观察（隐藏信息边界）──────────────────────────────────────────────────


def observation_for(state: GameState, rs: Ruleset, side: str) -> Dict[str, Any]:
    """返回 `side` 那一方**可以看到**的状态。

    这是隐藏信息的唯一边界，规则：

    - 只看得到**双方场上面板**（生命、能量、公开状态、印记）与**后备的存活与否**。
    - 看不到对手的待执行动作、看不到对手后备的具体生命/技能/**物种身份**。
    - 看不到真实随机种子（只给 seed 派生的公开编号）。
    - 术语 3024/3025 说明游戏本身有「隐藏精灵信息」状态；那种状态下连面板都不给。

    ⚠ 2026-09-30（分计划 01 步骤 A）：上面第二行里的「**物种身份**」是**新补上**的。
    在此之前本函数虽然自称「唯一边界」，却把对手后备的 `pet_id` 与 `name` 一并返回
    （见 `foe_bench_pet` 的注释）——文档承诺与实现不符。现在三处公开面
    （本函数 / `public_planner_state` / `ui_public_view`）的后备行统一为
    `{slot, fainted}`（本函数另带 `field` / `active` 供分层判定）。

    依据：产品红线「教练只分析公开信息，不得读取电脑下一手」+
    `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53`（对手物种只在**预览实际展示**后
    才成为公开事实）+ `docs/roco/execution/01-PLAN.md:38`（预览前不得提前泄漏阵容）。
    """
    other = "enemy" if side == "player" else "player"
    me = getattr(state, side)
    foe = getattr(state, other)

    def own_pet(p: PetState) -> Dict[str, Any]:
        """己方精灵：自己的信息全给（面板、技能、buff、携带物、冷却）。"""
        return {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "name": rs.pet(p.pet_id).name,
            "hp": p.hp,
            "max_hp": p.max_hp,
            "energy": p.energy,
            "statuses": sorted(p.statuses.keys()),
            "marks": sorted(p.marks.keys()),
            "fainted": p.fainted,
            "buffs": dict(p.buffs),
            "defense_cooldown": p.defense_cooldown,
            "charge": bool(p.charge),
        }

    def foe_field_pet(p: PetState, is_active: bool = True) -> Dict[str, Any]:
        """对手**场上**那只：面板是公开的。

        之前这里漏了 hp/max_hp/energy——那是个真 bug，不是安全取舍：
        对手场上的血条、能量、异常与印记本来就画在屏幕上，教练看不到它们
        反而更糟（无法判断「这一击够不够收」）。真正的隐藏信息是**后备**的血量
        与配招、以及对手本回合已提交的动作，那些仍然不给。
        """
        return {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "name": rs.pet(p.pet_id).name,
            "hp": p.hp,
            "max_hp": p.max_hp,
            "energy": p.energy,
            "statuses": sorted(p.statuses.keys()),
            "marks": sorted(p.marks.keys()),
            "fainted": p.fainted,
            "field": True,
            "active": is_active,
        }

    def foe_bench_pet(p: PetState, is_active: bool = False) -> Dict[str, Any]:
        """对手后备：**只有位次与是否倒下**。血量、能量、配招、物种身份都不给。

        2026-09-30（分计划 01 步骤 A）：这里原先还给 `pet_id` 与 `name`。那与本函数
        所在模块的自我声明矛盾——`observation_for` 的 docstring 写着「这是隐藏信息的
        唯一边界」「只看得到…后备的存活与否」，而它同时把对手**整队物种与真名**交给了
        双方策略（`opponents.py:1064`/`:1080` 的 `obs` 就是这个返回值；`opponents.py`
        的白名单是按这个结构**自动展开**的，所以「观察里有什么，策略就能读什么」）。

        依据：`docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53`（对手物种属于「预览实际
        展示」的公开面）+ `docs/roco/execution/01-PLAN.md:38`（预览前/无预览模式不得
        提前泄漏阵容）。⇒ 尚未亮明的后备不提供物种身份。

        `field` / `active` 两个键保留：它们不是在描述**物种**，而是让消费方能区分
        「场上那只」与「后备」——去掉它们会让上层无法判断该按哪条公开性规则读。
        """
        return {
            "slot": p.slot,
            "fainted": p.fainted,
            "field": False,
            "active": is_active,
        }

    # RC-105：魔力（心）是**公开**信息（它就是胜负判据本身，画在两边的界面上）。
    # 但**只有声明了魔力系统的配置**才写这个键：legacy / v2 里这条概念不存在，
    # 补一个 0 会被读成「已经判负」——那是编规则，不是公开性取舍。
    mana_block = None
    if me.mana is not None or foe.mana is not None:
        mana_block = {"self": me.mana, "opponent": foe.mana}

    return {
        "side": side,
        "turn": state.turn,
        "phase": state.phase,
        "result": state.result,
        "state_version": state.state_version,
        "ruleset_id": state.ruleset_id,
        **({"mana": mana_block} if mana_block is not None else {}),
        # 2026-09-25：天气同样是**公开**事实（官方：「常驻在全场…双方都能获得相应的加成」、
        # 「对局战报查看当前天气的剩余回合数」）⇒ 观察里给双方一样的当前天气与剩余回合数。
        # **没有天气时这个键不出现**（没开天气的对局逐位不变，`_obs_hash` 也不受影响）。
        **({"weather": copy.deepcopy(state.weather)} if isinstance(state.weather, dict) else {}),
        "self": {
            "active": me.active,
            "items": dict(me.items),
            "pets": [own_pet(p) for p in me.pets],
        },
        "opponent": {
            "active": foe.active,
            "living_count": len(foe.living()),
            # 场上那只给面板，后备只给存在性——**换人之后也不会消失**
            "field": foe_field_pet(foe.field_pet),
            "pets": [
                (foe_field_pet(p, i == foe.active) if i == foe.active else foe_bench_pet(p, False))
                for i, p in enumerate(foe.pets)
            ],
        },
    }
