"""对手策略池（S01）与配对对局（play_match）。

五个策略**按行为命名，不按名次命名**。这不是修辞：本项目从未测过天梯，
也没有任何社区阵容频率数据，所以「谁强」不是一个我们能回答的问题。
策略名只描述它怎么决策，不暗示它有多强。

    策略名                 决策方式
    random_legal           在合法动作上均匀随机
    greedy_damage          即时伤害估计最高的那一手
    conservative_switch    局面差就换人，不廉价送掉场上那只
    status_control         优先施加状态/印记/减益
    shallow_search         对「对手最可能的反应」做 1 层前瞻

三条硬约束，且都由结构保证而不是靠自觉：

1. **每个策略只能读自己的 observation。** 决策函数的第一个参数是
   `observe(state, rs, side)` 的返回值，并在传入前被 `_ObservationView`
   包成**只读代理**：代理按照 observation 里真实存在的键白名单校验每一次
   取值，键不在白名单里就抛 `KeyError` 并把它记进
   `hidden_read_snapshot()`。策略代码**拿不到** state，所以「偷看对手待执行
   动作」不是被劝阻，而是没有入口。
2. **确定性。** 随机性只来自 `random.Random((seed, turn))` 派生的局部实例
   （`_rng`），不读时钟、不用全局 `random`。同一 (seed, turn) 必得同一手。
3. **只返回 legal_actions 里的动作。** 策略从不自己构造 `Action`；
   `act()` 的最后一步会校验返回值是 `legal` 里的**同一个对象**。

`play_match()` 把两个策略配到一个完整对局里，返回一个可序列化的记录，
记录里带着双方策略的**名字与版本**、规则集 id 与快照指纹、实际配招，
以及每回合的行动与「决策时看到的观察哈希」——后者让「后手一方偷看了
对手选择」这类错误可以从记录里查出来。
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import env as renv
from .data import Ruleset
from .schema import ACTION_CHARGE, ACTION_ESCAPE, ACTION_ITEM, ACTION_SKILL, ACTION_SWITCH, Action

__all__ = [
    "STRATEGY_VERSION",
    "Strategy",
    "STRATEGIES",
    "get_strategy",
    "list_strategies",
    "describe_registry",
    "note_hidden_read",
    "hidden_read_snapshot",
    "hidden_read_paths",
    "reset_hidden_reads",
    "MatchRecord",
    "play_match",
]


# ── 隐藏信息代理 ────────────────────────────────────────────────────────
#
# 代理不是为了「防止恶意代码」——本模块与策略都跑在同一个进程里，
# 没有安全边界可言。它要保证的是**意外**不可能发生：
# 策略读一个 observation 里不存在的键，会立刻抛错并留下记录，
# 而不是悄悄拿到 None 然后基于一个我们没打算给它的信号决策。

_VIEW_ALLOWED = "_allowed"
_VIEW_RAW = "_raw"
_VIEW_PATH = "_path"

# 暴露给策略的**唯一**非字段属性：本局的确定性种子（策略要用它派生随机）。
# `_blocked_count` 不在这里：策略读它会被直接拒绝——它只服务于报告与测试。
_VIEW_EXTRA = ("_seed",)

# 代理自己的内部状态里，策略不该直接读的名字
_VIEW_INTERNAL_HIDDEN = frozenset((_VIEW_RAW, _VIEW_ALLOWED))

# 允许正常绑定的方法名：映射协议（keys/values/items）与调试用的 repr。
# 其余名字一律走拒绝分支——包括 `get`：匿名取键会把「观察里没有」和「不允许读」
# 混成同一个返回值，那正是隐藏信息纪律最不该有的模糊地带。
_VIEW_METHODS = frozenset((
    "keys", "values", "items", "__getitem__", "__contains__", "__len__",
    "__iter__", "__bool__", "__repr__",
))

HIDDEN_READS: Dict[str, int] = {}

#: 被拒绝的读取路径（用于报告/测试「策略到底碰过什么」）
HIDDEN_READ_PATHS: List[str] = []


def reset_hidden_reads() -> None:
    HIDDEN_READS.clear()
    del HIDDEN_READ_PATHS[:]


def hidden_read_paths() -> List[str]:
    """被拒绝的读取路径。合格值是空列表。"""
    return list(HIDDEN_READ_PATHS)


def hidden_read_snapshot() -> Dict[str, int]:
    """到目前为止每个策略试图读取隐藏字段的次数。合格值是全 0。"""
    return dict(HIDDEN_READS)


def note_hidden_read(strategy: str, where: str = "") -> None:
    HIDDEN_READS[strategy] = HIDDEN_READS.get(strategy, 0) + 1
    if where:
        HIDDEN_READ_PATHS.append(where)


def _candidates(node: Any, path: str = "") -> Any:
    """把 observation 真实存在的取值路径展开成**嵌套**白名单。

    只递归 `dict` / `list`：`observation_for()` 返回的就是纯 JSON 结构，
    里面没有别的东西。`path` 只用于报错时指出出事的位置。
    返回的树与原结构同形，叶子是 True。
    """
    if isinstance(node, dict):
        out: Any = {}
        for key in node:
            child = f"{path}.{key}" if path else str(key)
            out[key] = _candidates(node[key], child)
        return out
    if isinstance(node, (list, tuple)):
        return [_candidates(item, f"{path}[{i}]") for i, item in enumerate(node)]
    return True


class _ObservationView:
    """observation 的只读代理：白名单外的键一律拒绝并记账。

    白名单是**逐层下传**的：每一层的允许键来自 observation 里真实存在的键，
    所以「建一个 observation 里没有的字段」不可能——它既不在 raw 里，
    也不在 allowed 里。
    """

    __slots__ = ("__dict__",)

    def __init__(self, raw: Any, allowed: Any, path: str,
                 strategy: str, seed: int) -> None:
        view = object.__getattribute__(self, "__dict__")
        view[_VIEW_RAW] = raw
        view[_VIEW_ALLOWED] = allowed
        view[_VIEW_PATH] = path
        view["_seed"] = seed
        view["_strategy"] = strategy
        view["_blocked_count"] = 0

    def __getattribute__(self, name: str) -> Any:
        view = object.__getattribute__(self, "__dict__")
        allowed = view.get(_VIEW_ALLOWED)
        path = view.get(_VIEW_PATH) or ""
        raw = view.get(_VIEW_RAW)

        # ① 观察里真实存在的键：过白名单
        if isinstance(raw, dict) and name in raw:
            if not (isinstance(allowed, dict) and name in allowed):
                type(self)._deny(view, path, name)
            child_allowed = allowed.get(name)
            return _ObservationView._wrap_any(self, raw[name], child_allowed,
                                              f"{path}.{name}" if path else name)

        # ② 代理自己的内部状态：只有显式开放的几个名字可读
        if name in _VIEW_EXTRA:
            return view.get(name)
        if name in view:
            if name in _VIEW_INTERNAL_HIDDEN:      # _raw/_allowed 之类
                type(self)._deny(view, path, name)
            return view[name]

        # ③ 映射协议需要的少量方法可以正常绑定
        if name in _VIEW_METHODS:
            return object.__getattribute__(self, name)

        # ④ 其余一律拒绝
        type(self)._deny(view, path, name)
        raise AttributeError(name)      # pragma: no cover - _deny 总是抛

    @staticmethod
    def _deny(view: Dict[str, Any], path: str, name: str) -> None:
        view["_blocked_count"] = int(view.get("_blocked_count", 0)) + 1
        where = f"{path}.{name}" if path else name
        note_hidden_read(view.get("_strategy", "?"), where)
        raise KeyError(f"隐藏字段不可读：{where}（策略 {view.get('_strategy')}）")

    # ── 包成只读代理（白名单逐层下传，不走路径字符串查表）────────────
    def _wrap_any(self, value: Any, allowed: Any, path: str) -> Any:
        view = object.__getattribute__(self, "__dict__")
        strategy = view.get("_strategy", "?")
        seed = view.get("_seed", 0)
        if isinstance(value, dict):
            return _ObservationView(value, allowed if isinstance(allowed, dict) else {},
                                    path, strategy, seed)
        if isinstance(value, (list, tuple)):
            items = allowed if isinstance(allowed, list) else [True] * len(value)
            return [_ObservationView._wrap_any(
                self, item, items[i] if i < len(items) else True, f"{path}[{i}]")
                for i, item in enumerate(value)]
        return value

    # ── 映射协议 ────────────────────────────────────────────────────
    def _visible_keys(self) -> List[Any]:
        view = object.__getattribute__(self, "__dict__")
        allowed = view[_VIEW_ALLOWED]
        if not isinstance(allowed, dict):
            return []
        return [k for k in view[_VIEW_RAW] if k in allowed]

    def __getitem__(self, key: Any) -> Any:
        view = object.__getattribute__(self, "__dict__")
        raw = view[_VIEW_RAW]
        if not (isinstance(raw, dict) and key in raw):
            type(self)._deny(view, view.get(_VIEW_PATH) or "", str(key))
        return _ObservationView.__getattribute__(self, key)

    def __contains__(self, key: Any) -> bool:
        raw = object.__getattribute__(self, "__dict__")[_VIEW_RAW]
        return isinstance(raw, dict) and key in raw

    def __len__(self) -> int:
        return len(_ObservationView._visible_keys(self))

    def __iter__(self):
        return iter(_ObservationView._visible_keys(self))

    def __bool__(self) -> bool:
        return len(_ObservationView._visible_keys(self)) > 0

    def keys(self):
        return _ObservationView._visible_keys(self)

    def values(self):
        return [_ObservationView.__getitem__(self, k)
                for k in _ObservationView._visible_keys(self)]

    def items(self):
        return [(k, _ObservationView.__getitem__(self, k))
                for k in _ObservationView._visible_keys(self)]

    def __repr__(self) -> str:       # pragma: no cover - 仅调试
        view = object.__getattribute__(self, "__dict__")
        return "<observation %s>" % (view.get(_VIEW_PATH) or "<root>")


def wrap_observation(obs: Dict[str, Any], strategy: str, seed: int) -> "_ObservationView":
    """把一份 observation 包成只读代理。测试可以直接用它。"""
    return _ObservationView(obs, _candidates(obs), "", strategy, seed)


# ── 策略定义 ────────────────────────────────────────────────────────────

#: 策略池的版本。任何策略**决策规则**的改动都必须让它 +1：
#: 记录里写的版本必须真的对应一段行为，否则复现就无从谈起。
STRATEGY_VERSION = 1


@dataclass(frozen=True)
class Strategy:
    """一个对手策略。`decide` 只拿得到 observation 代理，拿不到 state。"""

    name: str
    version: int
    decide: Callable[..., Action]
    note: str = ""

    __hash__ = None  # type: ignore[assignment]   # 含函数的 dataclass 不参与哈希

    def act(self, obs: Dict[str, Any], legal: Sequence[Action], seed: int, turn: int) -> Action:
        """决策入口。三个硬约束在这里一次性收口。"""
        if not legal:
            raise ValueError(f"策略 {self.name} 收到空的合法动作集")
        view = wrap_observation(obs, self.name, seed)
        action = self.decide(view, list(legal), _rng(seed, turn))
        if action not in legal:
            raise AssertionError(
                f"策略 {self.name} 返回了不在 legal_actions 里的动作：{action!r}"
            )
        return action


def _rng(seed: int, turn: int) -> random.Random:
    """由 (seed, turn) 派生的确定性随机源。

    与 `env._rng_for` 同一思路、**不同的常数**：策略的随机流不能和引擎的
    同速裁决串在一起，否则「换一个策略」会连带改变对局的随机序列，
    两个策略的差异就说不清是决策差异还是随机差异。
    不读时钟，不用全局 random。
    """
    return random.Random((int(seed) << 21) ^ (int(turn) * 40503) ^ 0x5EED)


def _absent(value: Any) -> bool:
    """观察里没有这个键，或者它是空的。都当「没这个信息」处理。"""
    return value is None or value is False or value == () or value == [] or value == {}


def _field(container: Any, key: str) -> Any:
    """读一个**可选**字段。

    注意这里用 `in` 而不是 `get`：代理故意**不提供** `get()`。
    匿名取键会把「观察里没有」和「不允许读」混成同一个返回值，
    那正是隐藏信息纪律最不该有的模糊地带。所以：
    没有的键 → None；不允许的键 → KeyError（会在记录里留下痕迹）。
    """
    return container[key] if key in container else None


def _as_int(value: Any, default: int = 0) -> int:
    """observation 里 public_pet 的 buffs 只在**自己**身上出现；缺省当 0。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ── 公开信息读法（策略共用的几个小工具）──────────────────────────────────


def _self_pet(obs: Any) -> Any:
    return obs.self.pets[int(obs.self.active)]


def _foe_pet(obs: Any) -> Any:
    for p in obs.opponent.pets:
        if p.active:
            return p
    return None


def _pet_at(obs: Any, index: Optional[int]) -> Any:
    """按槽位取我方精灵；槽位越界或已倒下一律返回 None（不抛）。"""
    if index is None:
        return None
    pets = obs.self.pets
    if not (0 <= index < len(pets)):
        return None
    pet = pets[index]
    return None if pet.fainted else pet


def _type_mult(rs: Ruleset, defender_pet_id: str, element: str) -> float:
    """相性倍率。只读数据，不猜。快照没有这一行时退回单属性相乘并保留原值。"""
    if not element:
        return 1.0
    pet = rs.pets.get(defender_pet_id)
    if pet is None:
        return 1.0
    if rs.type_chart.has_row(pet.types):
        return float(rs.type_chart.multiplier(pet.types, element))
    return float(rs.type_chart.fallback_multiplier(pet.types, element))


def _matchup(rs: Ruleset, atk_pet_id: str, def_pet_id: str) -> float:
    """只从公开技能表算的对位分：我打他 / 他打我。

    这是**启发式**，不是伤害公式：真实伤害需要双方面板与性格，而那些是
    hidden state；这里只用图鉴里公开的技能与相性算一个相对量级。
    """
    atk_pet = rs.pets.get(atk_pet_id)
    def_pet = rs.pets.get(def_pet_id)
    if atk_pet is None or def_pet is None:
        return 1.0
    mine = _best_offense(rs, atk_pet_id, def_pet_id)
    theirs = _best_offense(rs, def_pet_id, atk_pet_id)
    return mine / max(1.0, theirs)


def _best_offense(rs: Ruleset, atk_pet_id: str, def_pet_id: str) -> float:
    """该精灵**图鉴里**最好的攻击手段对目标的加权威力。

    用学习表而不是配招：对手带哪四个技能是公开观察里没有的，
    所以「他打我最疼能有多疼」只能按学习表的上界估。
    """
    ls = rs.learnsets.get(atk_pet_id)
    if ls is None:
        return 1.0
    best = 1.0
    for sid in ls.all_skill_ids:
        skill = rs.skills.get(sid)
        if skill is None or not skill.is_attack:
            continue
        raw = float(skill.power or (150 if "固定" in (skill.desc or "") else 0) or 0)
        if raw <= 0:
            continue
        score = raw * (1.5 if skill.element in (rs.pets[atk_pet_id].types or ()) else 1.0)
        score *= _type_mult(rs, def_pet_id, skill.element)
        best = max(best, score)
    return best


def _switch_target(action: Action) -> Optional[int]:
    return action.target_index if action.kind == ACTION_SWITCH else None


# ── 1. random_legal ─────────────────────────────────────────────────────


def _decide_random_legal(obs, legal, rng) -> Action:
    """在合法动作上均匀随机。只用来当『没有策略』的对照。"""
    return legal[rng.randrange(len(legal))]


# ── 2. greedy_damage ────────────────────────────────────────────────────


def _damage_estimate(rs: Ruleset, obs, action: Action) -> Dict[str, Any]:
    """一手攻击的**即时估计**。

    只用公开信息：技能表（public）、我方能量/buff（我方 own public）、
    对面场上精灵 id 与相性（public）。没有面板值，所以这不是伤害数字，
    是一个可排序的相对量。
    """
    skill = rs.skills.get(action.skill_id or "")
    if skill is None:
        return {"score": -1.0, "reason": "未知技能"}
    me = _self_pet(obs)
    foe = _foe_pet(obs)
    if foe is None:
        return {"score": -1.0, "reason": "对面场上精灵不可见"}

    mult = _type_mult(rs, foe.pet_id, skill.element)
    stab = 1.5 if skill.element in (rs.pet(me.pet_id).types or ()) else 1.0
    power = float(skill.power or 0)
    # 自己身上的 buffs 是 public（observation_for 给自己的），所以可以读
    buffs = _field(me, "buffs") or {}
    atk_buff = 1.0 + max(0, _as_int(_field(buffs, "atk"))) / 100.0
    score = power * mult * stab * atk_buff
    reason = f"威力 {power:g} × 相性 {mult:g} × 本系 {stab:g}"
    if atk_buff != 1.0:
        reason += f" × 物攻 {atk_buff:.2f}"
    if skill.energy > 0:
        score = score / (1.0 + 0.15 * skill.energy)     # 能耗折价，避免无脑选最贵的
        reason += f"（能耗 {skill.energy} 折价）"
    return {"score": score, "reason": reason}


def _heal_value(obs, item_id: str) -> float:
    """道具的即时价值估计。只按公开的当前/最大生命算。"""
    me = _self_pet(obs)
    missing = max(0, int(me.max_hp) - int(me.hp))
    if item_id == "回复药":
        return float(min(45, missing))
    if item_id == "能量果":
        return max(0.0, 6.0 - float(me.energy)) * 6.0     # 1 点能量约当 6 分
    if item_id == "净化药":
        return 25.0 if not _absent(_field(me, "statuses")) else 0.0
    return 0.0


class RulesetNotBound(RuntimeError):
    """策略需要一个规则集，但本线程没有绑定。加载即失败，别等它算出个空结果。"""


def _rs() -> Ruleset:
    rs = getattr(_RULESET, "value", None)
    if rs is None:
        raise RulesetNotBound(
            "调用策略前请先 opponents.bind_ruleset(rs)"
            "（play_match 会自动绑定）"
        )
    return rs


def _decide_greedy_damage(obs, legal, rng) -> Action:
    """即时收益最高的一手：伤害为主，血量低时才考虑吃药。"""
    rs = _rs()
    me = _self_pet(obs)
    hp_ratio = float(me.hp) / max(1.0, float(me.max_hp))

    charge_available = any(a.kind == ACTION_CHARGE for a in legal)
    scored: List[Tuple[float, int, Action]] = []
    for index, action in enumerate(legal):
        if action.kind == ACTION_SKILL:
            est = _damage_estimate(rs, obs, action)
            score = max(0.0, float(est["score"]))
            # 防御技能：没有直接收益，按「本回合少挨的打」折算
            skill = rs.skills.get(action.skill_id or "")
            if skill is not None and skill.is_defense:
                score = _best_offense(rs, _foe_pet(obs).pet_id, me.pet_id) * 0.6
        elif action.kind == ACTION_ITEM:
            score = _heal_value(obs, action.item_id or "")
            score = score if hp_ratio < 0.5 else score * 0.2
        elif action.kind == ACTION_CHARGE:
            # 聚能（RC-105 新增的动作类）**必须**有自己的分支。
            # 实测踩到的坑：它落到下面的 `else`（当作换人处理）→ `_switch_target()` 返回 None
            # → 得分 0 → 一旦当前能量付不起任何技能，双方就无限换人：200 回合、无人力竭、
            # 魔力一直 4/4（六宠标准 PVP 打不完）。
            #
            # 分值取 **11**：中性换人（`_matchup`≈1 → 10 分）压得住，所以「打不出技能就聚能、
            # 而不是无限换人」；但任何一个真实攻击的估计值都会高过它（攻击分支在上面），
            # 所以**不会**出现「有招不打一直聚能」的反向停滞。两条边界都有实测：
            # 全量图鉴队伍 26 回合打到魔力归零；原来那两支队仍按原样跑完。
            score = 11.0
        else:
            # 换人本身不造成伤害；用对位差当收益，但**严格低于**最好的攻击，
            # 免得「贪心伤害」变成「贪心换人」——那会让两个策略名不副实。
            bench = _pet_at(obs, _switch_target(action))
            score = 0.0
            if bench is not None:
                # 有聚能可选时（v3 这类声明了它的配置），换人的上限必须**低于**聚能：
                # 换人不推进局面，而聚能至少在下回合换来一次输出。实测踩到的坑是
                # 「双方都有看起来不错的对位 → 换过来换过去 → 200 回合无人力竭、魔力一直 4/4」。
                # 没有聚能的配置（legacy / v2）保持原来的上限，逐位不变。
                cap = 9.0 if charge_available else 20.0
                weight = 9.0 if charge_available else 10.0
                score = min(cap, weight * _matchup(rs, bench.pet_id, _foe_pet(obs).pet_id))
        scored.append((score, -index, action))
    scored.sort(key=lambda t: (t[0], t[1]))
    return scored[-1][2]


# ── 3. conservative_switch ──────────────────────────────────────────────


def _survival_ratio(rs: Ruleset, obs, pet) -> float:
    """场上这只还能挨几下『对方最好的手段』。越大越安全。"""
    threat = _best_offense(rs, _foe_pet(obs).pet_id, pet.pet_id)
    return float(pet.hp) / max(1.0, threat)


def _decide_conservative_switch(obs, legal, rng) -> Action:
    """对位明显吃亏就换，但换人**占整回合**，所以有阈值：

    只有「现在这只撑不住、而后备能撑住」时才换；否则留着打，
    并在血量低时吃药、对上物理威胁时用防御技能。
    """
    rs = _rs()
    me = _self_pet(obs)
    foe = _foe_pet(obs)
    if foe is None:
        return legal[0]

    here = _survival_ratio(rs, obs, me)

    best_bench: Optional[Tuple[float, Action]] = None
    for action in legal:
        bench = _pet_at(obs, _switch_target(action))
        if bench is None:
            continue
        ratio = _survival_ratio(rs, obs, bench)
        # 换上去要能真的改善：存活比至少好 1.5 倍
        if ratio >= max(1.5, here * 1.5):
            if best_bench is None or ratio > best_bench[0]:
                best_bench = (ratio, action)

    if here < 1.0 and best_bench is not None:
        return best_bench[1]

    # 不换：血量偏低先吃药，其次用防御技能，最后才拼输出
    hp_ratio = float(me.hp) / max(1.0, float(me.max_hp))
    if hp_ratio < 0.45:
        heals = [a for a in legal if a.kind == ACTION_ITEM and a.item_id == "回复药"]
        if heals:
            return heals[0]
    if not _absent(_field(me, "statuses")):
        cures = [a for a in legal if a.kind == ACTION_ITEM and a.item_id == "净化药"]
        if cures:
            return cures[0]
    defenses = [a for a in legal
                if a.kind == ACTION_SKILL and rs.skills[a.skill_id].is_defense]
    if defenses and here < 1.5:
        return defenses[0]

    # 否则留在场上，打最省的那一手（保守：少花能量、不空过）
    attacks = [a for a in legal if a.kind == ACTION_SKILL
               and rs.skills[a.skill_id].is_attack]
    pool = attacks or [a for a in legal if a.kind == ACTION_SKILL]
    if not pool:
        return legal[0]
    return min(pool, key=lambda a: (rs.skills[a.skill_id].energy,
                                    rs.skills[a.skill_id].skill_id))


# ── 4. status_control ───────────────────────────────────────────────────


_STATUS_PRIORITY = ("foe_status", "foe_stat", "self_mark", "foe_mark", "self_stat")


def _unresolved_mechanics(rs: Ruleset, skill) -> bool:
    """引擎**明确说没解析出来**的效果。

    这不是「这个技能弱」，而是「本引擎还没法结算它」。策略依赖一个未核验的
    效果会造出无意义的对局：实测两个 `status_control` 都在用「取念」
    （随机变成敌方技能，解析器标注未覆盖），结果是 300 回合空转的僵局。
    把它降权，正是让「引擎不知道」这件事在策略层也可见。
    """
    from . import parse as _parse
    spec = skill if skill is not None else None
    if spec is None:
        return True
    desc = spec.desc or ""
    return (not spec.is_attack) and any(marker in desc for marker in _parse.UNPARSED_MARKERS)


def _control_score(rs: Ruleset, obs, action: Action) -> Tuple[float, str]:
    """这一手施加了多少『控制』。读技能描述与机械解析结果，不做数值猜测。"""
    from . import parse as _parse

    skill = rs.skills.get(action.skill_id or "")
    if skill is None:
        return (0.0, "")
    parsed = _parse.parse_skill(skill)
    score = 0.0
    hits: List[str] = []
    for eff in parsed.effects:
        if eff.kind in _STATUS_PRIORITY:
            weight = 3.0 if eff.kind == "foe_status" else 2.0
            score += weight
            hits.append(eff.kind)
    if not parsed.effects and skill.is_status:
        # 描述里有控制词但解析器还没覆盖：给一个低分让它仍然优先于纯攻击
        if _parse._FOE_STATUS.search(skill.desc or "") or _parse._FOE_MARK.search(skill.desc or "") \
                or _parse._FOE_STAT.search(skill.desc or ""):
            score += 1.0
            hits.append("unparsed_control")
    if score and parsed.unparsed:
        score *= 0.5        # 半套效果风险折扣（parse 说还有没解析的部分）
    return (score, "+".join(hits) or "none")


def _pick_attack(rs: Ruleset, legal: Sequence[Action]) -> Optional[Action]:
    """退而求其次的攻击选择：威力高、能耗低、id 稳定。

    与 `greedy_damage` 刻意不同——这里混合了能耗，所以两个策略即使都只能
    攻击也**不会逐手相同**，「五个策略真的不一样」才是可核验的。
    """
    best: Optional[Tuple[float, int, Action]] = None
    for index, action in enumerate(legal):
        if action.kind != ACTION_SKILL:
            continue
        skill = rs.skills.get(action.skill_id or "")
        if skill is None or not skill.is_attack:
            continue
        score = float(skill.power or 0) / (1.0 + 0.25 * skill.energy)
        if best is None or (score, -index) > (best[0], best[1]):
            best = (score, -index, action)
    return best[2] if best else None


def _decide_status_control(obs, legal, rng) -> Action:
    """优先挂状态/印记/减益；控制没了就转输出，而不是空转。

    「控制已经挂上」的判断只读对手场上面板（公开的 statuses/marks）。
    """
    rs = _rs()
    foe = _foe_pet(obs)

    if foe is not None and not _absent(_field(foe, "statuses")):
        action = _pick_attack(rs, legal)
        if action is not None:
            return action
    if foe is not None and not _absent(_field(foe, "marks")):
        action = _pick_attack(rs, legal)
        if action is not None:
            return action

    resolved: List[Tuple[float, int, Action]] = []
    unresolved: List[Tuple[float, int, Action]] = []
    for index, action in enumerate(legal):
        if action.kind != ACTION_SKILL:
            continue
        skill = rs.skills[action.skill_id]
        score, _why = _control_score(rs, obs, action)
        if score <= 0:
            continue
        entry = (score - 0.1 * skill.energy, -index, action)
        if _unresolved_mechanics(rs, skill):
            unresolved.append(entry)
        else:
            resolved.append(entry)

    for bucket in (resolved, unresolved):
        if bucket:
            bucket.sort(key=lambda t: (t[0], t[1]))
            return bucket[-1][2]

    action = _pick_attack(rs, legal)
    if action is not None:
        return action
    return legal[0]


# ── 5. shallow_search ───────────────────────────────────────────────────


def _opponent_best_threat(rs: Ruleset, obs, action: Action) -> float:
    """预测对手会对这一手打回来的最疼一下。

    **它是模型，不是引擎模拟。** 真引擎需要 state，而策略拿不到 state——
    这正是不偷看的代价。所以这里用「对手图鉴里对『我这一手之后的场上精灵』
    的最好手段」当代理，并在文档里说清楚这是个模型。
    """
    subject = _pet_at(obs, _switch_target(action)) or _self_pet(obs)
    return _best_offense(rs, _foe_pet(obs).pet_id, subject.pet_id)


def _position_value(rs: Ruleset, obs, action: Action) -> Tuple[float, str]:
    """打完这一手之后，局面的粗略好坏（我方可以看得见的那部分）。"""
    me = _self_pet(obs)
    foe = _foe_pet(obs)
    if foe is None:
        return (0.0, "对手不可见")

    incoming = _opponent_best_threat(rs, obs, action)
    hp_ratio = float(me.hp) / max(1.0, float(me.max_hp))
    safety = hp_ratio / (1.0 + incoming / max(1.0, float(me.max_hp)))

    if action.kind == ACTION_SKILL:
        skill = rs.skills[action.skill_id]
        if skill.is_defense:
            from . import effects as _fx
            try:
                reduction = _fx.parse_defense_reduction(skill)
            except _fx.UnsupportedEffect:
                reduction = 0.0
            immediate = 8.0 * reduction
            return (immediate + 6.0 * safety, "防御减伤")
        if skill.is_attack:
            est = _damage_estimate(rs, obs, action)
            dealt = float(est["score"]) * 0.30       # 折算成「生命占比」量级
            return (dealt + 6.0 * safety, est["reason"])
        score, why = _control_score(rs, obs, action)
        return (7.0 * score + 4.0 * safety, "控制 " + why)

    if action.kind == ACTION_ITEM:
        return (_heal_value(obs, action.item_id or "") * 0.35, "道具")

    bench = _pet_at(obs, _switch_target(action))
    if bench is not None:
        gain = _matchup(rs, bench.pet_id, foe.pet_id) - _matchup(rs, me.pet_id, foe.pet_id)
        return (12.0 * gain - 4.0, "换人对位差")   # 换人占整回合，固定扣分
    return (-1.0, "非动作")


def _decide_shallow_search(obs, legal, rng) -> Action:
    """1 层前瞻：对每一手算「我打出去 + 对手最可能的还手 + 剩余安全度」。"""
    rs = _rs()
    best: Optional[Tuple[float, int, Action]] = None
    for index, action in enumerate(legal):
        value, _why = _position_value(rs, obs, action)
        # 平局用 index 定序（确定性），不用随机——前瞻的随机性只会掩盖 bug
        if best is None or (value, -index) > (best[0], best[1]):
            best = (value, -index, action)
    if best is None:
        return legal[0]
    return best[2]


# ── 注册表 ──────────────────────────────────────────────────────────────

# 规则集**不入参**：策略模块只依赖 observation + 规则数据，避免把 state 递进来。
# 用 thread-local 而不是全局变量：并行跑对局时不会串。
import threading
_RULESET = threading.local()


def bind_ruleset(rs: Ruleset) -> None:
    """把当前使用的规则集绑定到本线程。策略只从这里取规则数据。"""
    _RULESET.value = rs


@dataclass(frozen=True)
class _Registry:
    _items: Tuple[Strategy, ...]

    def names(self) -> List[str]:
        return [s.name for s in self._items]

    def get(self, name: str) -> Strategy:
        for s in self._items:
            if s.name == name:
                return s
        raise KeyError(f"未知策略：{name}（可用：{', '.join(self.names())}）")

    def __iter__(self):
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __getitem__(self, name: str) -> Strategy:
        return self.get(name)


def _build_registry() -> _Registry:
    entries = (
        Strategy("random_legal", STRATEGY_VERSION, _decide_random_legal,
                 "在 legal_actions 上均匀随机；对照组。"),
        Strategy("greedy_damage", STRATEGY_VERSION, _decide_greedy_damage,
                 "取即时伤害估计最高的一手（能耗折价；残血时才吃药）。"),
        Strategy("conservative_switch", STRATEGY_VERSION, _decide_conservative_switch,
                 "对位吃亏且后备明显更能扛时换人，否则吃药/防御/省能量出手。"),
        Strategy("status_control", STRATEGY_VERSION, _decide_status_control,
                 "优先施加状态/减益/印记（解析器说没覆盖的算半套，打对折）。"),
        Strategy("shallow_search", STRATEGY_VERSION, _decide_shallow_search,
                 "对每一手做 1 层前瞻：收益 − 对手最疼还手 − 换人整回合成本。"),
    )
    return _Registry(entries)


STRATEGIES = _build_registry()


def get_strategy(name: str) -> Strategy:
    return STRATEGIES.get(name)


def list_strategies() -> List[Dict[str, Any]]:
    """给调用方看的策略清单：名字 + 版本 + 一行行为说明。"""
    return [{"name": s.name, "version": s.version, "note": s.note} for s in STRATEGIES]


def describe_registry() -> Dict[str, Any]:
    return {
        "strategy_version": STRATEGY_VERSION,
        "count": len(STRATEGIES),
        "strategies": list_strategies(),
        "note": (
            "策略按**行为**命名，不按强弱排序。这里没有天梯数据，"
            "任何『哪个策略强』的说法都超出本池能支持的范围。"
        ),
    }


# ── 配对对局 ────────────────────────────────────────────────────────────


@dataclass
class MatchRecord:
    """一局的完整记录。可 JSON 往返；`replay()` 能重放出同一局。"""

    seed: int
    ruleset_id: str
    snapshot_fingerprint: str
    team_a: List[str]
    team_b: List[str]
    loadouts: Dict[str, List[str]]
    strategy_a: Dict[str, Any]
    strategy_b: Dict[str, Any]
    winner: str
    turns: int              # 对局走到的回合号（补位不消耗回合，可能 > battle_turns）
    battle_turns: int       # 真正结算过的战斗回合数
    total_turns: int
    truncated: bool = False
    error: Optional[str] = None
    actions: List[Any] = field(default_factory=list)
    observation_trace: List[Dict[str, Any]] = field(default_factory=list)
    unsupported: List[Dict[str, Any]] = field(default_factory=list)
    #: RC-106：这一局绑的规则配置 id 与用过的未核验覆盖。
    #:
    #: 为什么必须进记录：六宠候选局的 `energy.initial` 是 UNKNOWN，靠一条显式覆盖
    #: 才开得了局。回放时不带上同一份配置 + 同一条覆盖，`reset()` 会 fail closed，
    #: 那份记录就永远重放不了 —— 而「可回放」正是这份记录存在的理由。
    #: 两者都有默认值（空），所以既有的 MatchRecord 构造点与旧记录逐字不变。
    ruleset_config_id: str = ""
    unverified_overrides: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "seed": self.seed,
            "ruleset_id": self.ruleset_id,
            "snapshot_fingerprint": self.snapshot_fingerprint,
            "team_a": list(self.team_a),
            "team_b": list(self.team_b),
            "loadouts": {k: list(v) for k, v in sorted(self.loadouts.items())},
            "strategies": {"player": dict(self.strategy_a), "enemy": dict(self.strategy_b)},
            "winner": self.winner,
            "turns": self.turns,
            "battle_turns": self.battle_turns,
            "total_turns": self.total_turns,
            "truncated": self.truncated,
            "error": self.error,
            "actions": copy.deepcopy(self.actions),
            "observation_trace": copy.deepcopy(self.observation_trace),
            "unsupported": copy.deepcopy(self.unsupported),
            # RC-106：**只在非默认配置时才写**（legacy 记录的 to_dict 逐字不变）。
            **({"ruleset_config_id": self.ruleset_config_id}
               if self.ruleset_config_id
               and self.ruleset_config_id != renv._rule_config.DEFAULT_RULE_CONFIG_ID else {}),
            **({"unverified_overrides": copy.deepcopy(self.unverified_overrides)}
               if self.unverified_overrides else {}),
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "MatchRecord":
        strategies = d.get("strategies") or {}
        return MatchRecord(
            seed=d["seed"],
            ruleset_id=d["ruleset_id"],
            snapshot_fingerprint=d.get("snapshot_fingerprint", ""),
            team_a=list(d.get("team_a") or []),
            team_b=list(d.get("team_b") or []),
            loadouts={k: list(v) for k, v in (d.get("loadouts") or {}).items()},
            strategy_a=dict(strategies.get("player") or {}),
            strategy_b=dict(strategies.get("enemy") or {}),
            winner=d.get("winner") or "unfinished",
            turns=int(d.get("turns") or 0),
            battle_turns=int(d.get("battle_turns") or d.get("turns") or 0),
            total_turns=int(d.get("total_turns") or d.get("turns") or 0),
            truncated=bool(d.get("truncated")),
            error=d.get("error"),
            actions=copy.deepcopy(d.get("actions") or []),
            observation_trace=copy.deepcopy(d.get("observation_trace") or []),
            unsupported=copy.deepcopy(d.get("unsupported") or []),
            ruleset_config_id=d.get("ruleset_config_id") or "",
            unverified_overrides=copy.deepcopy(list(d.get("unverified_overrides") or [])),
        )

    def replay_plan(self) -> Dict[str, Any]:
        """交给 `env.replay()` 的最小记录（补位回合在 actions 里是 [side, slot]）。

        **必须带上 `loadouts`。** 合法动作按配招枚举，缺了它回放会退回规范配招，
        非规范配招的技能就不再合法（实测抛「行动不合法」）。
        记录里已经存了 `self.loadouts`，直接用。

        RC-106：**也必须带上 `ruleset_config_id` 与 `unverified_overrides`。**
        只带 loadouts 的记录在候选配置下会退回到「当前生效配置」（默认 legacy），
        于是 6 只队伍对不上 3 只的场地、`energy.initial` 又是 UNKNOWN ——
        两处都会抛。**默认配置那一份不写这个键**（legacy 记录的 replay_plan 逐字不变）。
        """
        plan = {
            "team": list(self.team_a),
            "enemy_team": list(self.team_b),
            "seed": self.seed,
            # 这一局双方**各自队伍**的配招。`reset()` 会把这份 dict 分别对
            # team_a 与 team_b 校验（每边只认自己那几只），所以两边都要在，
            # 但不属于任何一边的 id 会让它直接判「配招提到了不在队伍里的 pet」。
            "loadouts": {k: list(v) for k, v in (self.loadouts or {}).items()
                         if k in set(self.team_a) or k in set(self.team_b)},
            "actions": copy.deepcopy(self.actions),
        }
        if self.ruleset_config_id and self.ruleset_config_id != renv._rule_config.DEFAULT_RULE_CONFIG_ID:
            plan["ruleset_config_id"] = self.ruleset_config_id
        if self.unverified_overrides:
            plan["unverified_overrides"] = copy.deepcopy(self.unverified_overrides)
        return plan


def _winner_of(state) -> str:
    if state.result == "win":
        return "player"
    if state.result == "loss":
        return "enemy"
    if state.result == "draw":
        return "draw"
    if state.result == "escaped":
        return "escaped"
    return "unfinished"


def _pool(state, rs: Ruleset, side: str) -> List[Action]:
    """这一方**真正会被考虑**的动作：合法动作去掉「撤退」。

    去掉撤退是**运行设置**，不是策略的权限：
      - 撤退是弃权，不是对弈决策；留着它会让随机策略以约 1/9 的概率弃权，
        整份先导报告的回合数会被弃权主导，什么都测不出来。
      - 策略仍然只会拿到合法动作的子集，返回值照旧被 full legal_actions 校验。
    想恢复它就把 `EXCLUDE_ESCAPE` 改成 False——这是一行、可复现的开关。
    """
    full = renv.legal_actions(state, rs, side)
    if not EXCLUDE_ESCAPE:
        return full
    return [a for a in full if a.kind != ACTION_ESCAPE] or full


#: 对局里是否把「撤退」从候选里去掉。默认去掉，理由见 `_pool`。
EXCLUDE_ESCAPE = True


def play_match(
    rs: Ruleset,
    team_a: Sequence[str],
    team_b: Sequence[str],
    strat_a: Any,
    strat_b: Any,
    seed: int,
    *,
    loadouts: Optional[Dict[str, Sequence[str]]] = None,
    turn_limit: int = 300,
    config: Optional[Any] = None,
    unverified_overrides: Optional[Sequence[Any]] = None,
) -> MatchRecord:
    """让两个策略打完整一局，返回结构化记录。

    - `strat_a` / `strat_b` 是策略名（str）或 `Strategy` 对象。
    - `turn_limit` 是回合上限；撞上上限记为 `truncated=True`（不是错误）。
    - 记录里带双方策略的**名字与版本**、规则集 id 与快照指纹、实际配招、
      每回合的行动，以及每个战斗回合**决策前**的观察哈希。

    RC-106：`config` / `unverified_overrides` 原样透给 `env.reset`。
    六宠标准 PVP 局必须显式给这两样（v3 的 `energy.initial` 是 UNKNOWN，不给覆盖
    就 fail closed），两项都省略时行为与改动前**逐位相同**（legacy 3v3 默认路径）。
    策略侧**一个字节都没改**：它们从来只按观察 + 合法动作决策，而合法动作在
    6 只队伍下同样是引擎枚举出来的（`env.legal_actions`），所以「6 只是否合法」
    不需要策略知道任何新模式概念。
    """
    a = get_strategy(strat_a) if isinstance(strat_a, str) else strat_a
    b = get_strategy(strat_b) if isinstance(strat_b, str) else strat_b
    bind_ruleset(rs)

    state = renv.reset(list(team_a), list(team_b), seed=seed, rs=rs, loadouts=loadouts,
                       config=config, unverified_overrides=unverified_overrides)
    fingerprint = rs.snapshot_fingerprint()
    record = MatchRecord(
        seed=seed,
        ruleset_id=rs.ruleset_id,
        snapshot_fingerprint=fingerprint,
        team_a=list(team_a),
        team_b=list(team_b),
        loadouts={pid: list(state.player.loadouts.get(pid) or state.enemy.loadouts.get(pid) or ())
                  for pid in list(team_a) + list(team_b)},
        strategy_a={"name": a.name, "version": a.version},
        strategy_b={"name": b.name, "version": b.version},
        winner="unfinished",
        turns=0,
        battle_turns=0,
        total_turns=0,
    )
    record.ruleset_config_id = getattr(state, "ruleset_config_id", "") or ""
    record.unverified_overrides = [dict(e) for e in (state.unverified_overrides or [])]

    strategies = {"player": a, "enemy": b}
    battle_turns = 0
    guard = 0
    guard_limit = turn_limit * 4 + 50
    while not state.result:
        if state.turn > turn_limit:
            record.truncated = True
            break
        guard += 1
        if guard > guard_limit:
            record.truncated = True
            record.error = "回合推进停滞：补位阶段反复没有可用后备"
            break

        if state.phase == "replace":
            queue = renv.needs_replacement(state)
            if not queue:
                record.error = "phase=replace 但没有待补位方"
                break
            progressed = False
            for side in list(queue):
                if not getattr(state, side).bench_indices():
                    continue
                # 补位只允许换人，所以合法动作本身就是候选；
                # 这里**不**给策略看任何额外信息（尤其不告诉它对手换了谁）。
                legal = renv.legal_actions(state, rs, side)
                if not legal:
                    continue
                obs = renv.observe(state, rs, side)
                action = strategies[side].act(obs, legal, seed, state.turn)
                slot = action.target_index if action.target_index is not None else legal[0].target_index
                record.actions.append([side, int(slot)])
                renv.step_replace(state, rs, side, int(slot))
                progressed = True
            if not progressed:
                record.error = "补位阶段无法推进"
                break
            continue

        pool = {side: _pool(state, rs, side) for side in ("player", "enemy")}
        if not pool["player"] or not pool["enemy"]:
            record.error = "有一方没有任何合法动作"
            break

        obs = {side: renv.observe(state, rs, side) for side in ("player", "enemy")}
        pre = list(state.history)
        pa = a.act(obs["player"], pool["player"], seed, state.turn)
        ea = b.act(obs["enemy"], pool["enemy"], seed, state.turn)
        renv.step_joint(state, rs, pa, ea)
        record.actions.append([pa.to_dict(), ea.to_dict()])
        battle_turns += 1

        # 决策时的观察哈希从 env.history 里取——那是**决策前**的快照，
        # 不是事后状态；所以它能证明「后手一方没看到对手这一手」。
        if len(state.history) > len(pre):
            entry = state.history[-1]
            record.observation_trace.append({
                "turn": state.turn,
                "player_obs_hash": entry.get("pre_observation_hash"),
                "enemy_obs_hash": entry.get("pre_observation_opponent_hash"),
            })
        # 记录**实际推进到的**回合号（补位不消耗回合，两者会不同）
        record.total_turns = state.turn

    record.winner = _winner_of(state)
    record.turns = state.turn
    record.battle_turns = battle_turns
    record.total_turns = state.turn
    record.unsupported = copy.deepcopy(state.unsupported)
    return record
