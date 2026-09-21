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

VALID_KINDS = (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM, ACTION_ESCAPE, ACTION_STRUGGLE,
               ACTION_CHARGE, ACTION_SURRENDER)

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
            item_id=d.get("item_id"),
        )

    def label(self, rs: Ruleset) -> str:
        if self.kind == ACTION_SKILL:
            return rs.skill(self.skill_id).name if self.skill_id else "技能"
        if self.kind == ACTION_SWITCH:
            return f"换上第{(self.target_index or 0) + 1}位"
        if self.kind == ACTION_ITEM:
            return f"使用{self.item_id}"
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
            history=copy.deepcopy(d.get("history") or []),
        )


# ── 观察（隐藏信息边界）──────────────────────────────────────────────────


def observation_for(state: GameState, rs: Ruleset, side: str) -> Dict[str, Any]:
    """返回 `side` 那一方**可以看到**的状态。

    这是隐藏信息的唯一边界，规则：

    - 只看得到**双方场上面板**（生命、能量、公开状态、印记）与**后备的存活与否**。
    - 看不到对手的待执行动作、看不到对手后备的具体生命/技能。
    - 看不到真实随机种子（只给 seed 派生的公开编号）。
    - 术语 3024/3025 说明游戏本身有「隐藏精灵信息」状态；那种状态下连面板都不给。

    依据：产品红线「教练只分析公开信息，不得读取电脑下一手」。
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
        """对手后备：只有位次 / id / 是否倒下。血量、能量、配招都不给。"""
        return {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "name": rs.pet(p.pet_id).name,
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
