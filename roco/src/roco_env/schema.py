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

VALID_KINDS = (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM, ACTION_ESCAPE, ACTION_STRUGGLE)


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
        return {"escape": "撤退", "struggle": "挣扎"}.get(self.kind, self.kind)


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
            "pets": [p.to_dict() for p in self.pets],
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "SideState":
        return SideState(
            name=d["name"],
            active=d["active"],
            items=dict(d.get("items") or {}),
            pets=[PetState.from_dict(p) for p in d["pets"]],
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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ruleset_id": self.ruleset_id,
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

    def public_pet(p: PetState, mine: bool) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "name": rs.pet(p.pet_id).name,
            "hp": p.hp,
            "max_hp": p.max_hp,
            "energy": p.energy,
            "statuses": sorted(p.statuses.keys()),
            "marks": sorted(p.marks.keys()),
            "fainted": p.fainted,
        }
        if mine:
            # 己方看得到自己的技能、buff、携带物与冷却
            d["buffs"] = dict(p.buffs)
            d["defense_cooldown"] = p.defense_cooldown
            d["charge"] = bool(p.charge)
        return d

    return {
        "side": side,
        "turn": state.turn,
        "phase": state.phase,
        "result": state.result,
        "state_version": state.state_version,
        "ruleset_id": state.ruleset_id,
        "self": {
            "active": me.active,
            "items": dict(me.items),
            "pets": [public_pet(p, True) for p in me.pets],
        },
        "opponent": {
            "active": foe.active,
            # 对手后备只暴露「还活着几只」与位次，不暴露血量与配招
            "living_count": len(foe.living()),
            "pets": [
                {
                    "slot": p.slot,
                    "pet_id": p.pet_id,
                    "name": rs.pet(p.pet_id).name,
                    "active": (i == foe.active),
                    "fainted": p.fainted,
                }
                for i, p in enumerate(foe.pets)
            ],
        },
    }
