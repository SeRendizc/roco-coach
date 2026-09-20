"""2—3 回合联合动作搜索（G04/planner）。

设计纪律（来自 FINAL-DECISION 与 MODEL-GROUP-AND-TASK-MATRIX 的 G5 行）：

1. **不假装知道对手下一手。** 对手按一个**策略分布**建模，而不是读取它的选择。
   分布来自对手策略池 + 可解释的启发式权重；我们永远不调用对手的
   `legal_actions` 之外的东西，也永远不看 `state._pending_enemy`。
2. **输出必须包含最差尾部。** 只看期望值会推荐「赌一把」的动作；牌手要看到
   最坏分支是什么。
3. **超时必须如实上报。** 时间到了就返回已完成的部分 + `coverage` + `timed_out=True`，
   绝不让上层以为深搜跑完了。
4. **不做未核验机制的推断。** 走子用 `env.step_joint`，它内部对未支持机制会
   登记 unsupported；planner 不自己算伤害。

搜索方式：**期望值搜索 + 束剪枝**。
朴素枚举 3 层是 53 万叶子（9×9 联合分支），所以每层按启发式保留前 K 个候选，
再对对手的 K 个候选按权重求期望。K 与深度都由预算决定。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import env as renv
from .data import Ruleset
from .schema import ACTION_ITEM, ACTION_SKILL, ACTION_SWITCH, Action, GameState

# 束宽与深度：默认值与上限。调大就慢，调小就浅——两者都要在回执里报出来。
DEFAULT_BEAM = 4
MAX_BEAM = 8
DEFAULT_DEPTH = 2
MAX_DEPTH = 3
DEFAULT_BUDGET_MS = 2000


@dataclass
class PlanResult:
    """规划回执。每个数字都要能被上层追问「这个数怎么来的」。"""

    recommended: Optional[Action]
    recommended_label: str
    expected: float
    worst: float
    best: float
    main_counter: Optional[str]
    counter_note: str
    branches_evaluated: int
    depth_searched: int
    beam: int
    coverage: float          # 实际搜完的比例（1.0 = 完整搜完）
    timed_out: bool
    latency_ms: float
    opponent_model: str
    unsupported_seen: int
    note: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "recommended": self.recommended.to_dict() if self.recommended else None,
            "recommended_label": self.recommended_label,
            "expected": round(self.expected, 4),
            "worst": round(self.worst, 4),
            "best": round(self.best, 4),
            "main_counter": self.main_counter,
            "counter_note": self.counter_note,
            "branches_evaluated": self.branches_evaluated,
            "depth_searched": self.depth_searched,
            "beam": self.beam,
            "coverage": round(self.coverage, 4),
            "timed_out": self.timed_out,
            "latency_ms": round(self.latency_ms, 1),
            "opponent_model": self.opponent_model,
            "unsupported_seen": self.unsupported_seen,
            "note": self.note,
        }


# ── 局面评估 ────────────────────────────────────────────────────────────


def _hp_fraction(state: GameState, rs: Ruleset, side: str) -> float:
    s = getattr(state, side)
    total = sum(p.max_hp for p in s.pets) or 1
    return sum(max(0, p.hp) for p in s.pets) / total


def _living_frac(state: GameState, side: str) -> float:
    s = getattr(state, side)
    if not s.pets:
        return 0.0
    return len(s.living()) / len(s.pets)


def evaluate(state: GameState, rs: Ruleset, side: str) -> float:
    """从 `side` 视角给局面打分。**这是启发式，不是胜率。**

    组成（每一项都可解释）：
      - 存活比例差（倒下是最重的损失）
      - 生命比例差
      - 能量差（资源）
      - 场上对位相性差（谁克谁）
    返回大致落在 [-3, 3] 的实数，越大越好。
    """
    if state.result == "win":
        return 10.0
    if state.result == "loss":
        return -10.0
    if state.result == "draw":
        return 0.0

    other = "enemy" if side == "player" else "player"
    score = 0.0
    score += 3.0 * (_living_frac(state, side) - _living_frac(state, other))
    score += 2.0 * (_hp_fraction(state, rs, side) - _hp_fraction(state, rs, other))

    me, foe = getattr(state, side), getattr(state, other)
    score += 0.05 * (me.field_pet.energy - foe.field_pet.energy)

    # 场上对位：我打它 vs 它打我
    my_types = rs.pet(me.field_pet.pet_id).types
    foe_types = rs.pet(foe.field_pet.pet_id).types
    # 相性表是**防御侧**的，所以「我受它多少」直接查，「它受我多少」要把双方换过来
    incoming = max(
        rs.type_chart.multiplier(my_types, el) for el in foe_types
    ) if foe_types else 1.0
    outgoing = max(
        rs.type_chart.multiplier(foe_types, el) for el in my_types
    ) if my_types else 1.0
    score += 0.6 * (outgoing - incoming)
    return score


# ── 对手建模（只看公开信息）──────────────────────────────────────────────


def opponent_distribution(
    state: GameState, rs: Ruleset, *, beam: int = DEFAULT_BEAM
) -> List[Tuple[Action, float]]:
    """对手动作的**分布**，不是「它一定会做什么」。

    权重来自可解释的启发式（与 `opponents.py` 的 greedy/status/conservative
    同源思路），并做归一化。它**只**读对手自己的合法动作与公开局面。

    重要：这里没有任何地方读取 `state._pending_*`（那是对手本回合已提交的动作），
    也没有读取对手后备的血量。教练不应该知道对手下一手。
    """
    actions = [a for a in renv.legal_actions(state, rs, "enemy") if a.kind != "escape"]
    if not actions:
        return []

    scored: List[Tuple[Action, float]] = []
    foe = state.enemy
    me = state.player
    for a in actions:
        w = 1.0
        if a.kind == ACTION_SKILL and a.skill_id:
            sk = rs.skills[a.skill_id]
            if sk.is_attack and sk.power:
                w = 1.0 + sk.power / 60.0            # 高威力更可能
            elif sk.is_status:
                w = 1.6                                # 状态技能在轮转里有价值
            elif sk.is_defense:
                # 残血时更可能防御
                hp_frac = foe.field_pet.hp / max(1, foe.field_pet.max_hp)
                w = 1.0 + (1.0 - hp_frac) * 2.0
        elif a.kind == ACTION_SWITCH:
            # 对位差时更可能换宠
            bad = rs.type_chart.multiplier(
                rs.pet(foe.field_pet.pet_id).types, rs.pet(me.field_pet.pet_id).types[0]
            ) if rs.pet(me.field_pet.pet_id).types else 1.0
            w = 0.6 + (bad - 1.0) * 1.5
        elif a.kind == ACTION_ITEM:
            hp_frac = foe.field_pet.hp / max(1, foe.field_pet.max_hp)
            w = 0.4 + (1.0 - hp_frac) * 2.0
        scored.append((a, max(0.05, w)))

    scored.sort(key=lambda x: -x[1])
    top = scored[:beam]
    total = sum(w for _, w in top) or 1.0
    return [(a, w / total) for a, w in top]


def _my_candidates(state: GameState, rs: Ruleset, *, beam: int) -> List[Action]:
    """我方候选：丢掉明显劣的动作，但**保留不同类别**。

    为什么要按类别保底：如果只按启发式取前 K，很可能全是攻击技能，
    于是 planner 永远看不到「换宠承伤」或「防御等一轮」这两类分支，
    而那正是多回合规划存在的理由。
    """
    actions = [a for a in renv.legal_actions(state, rs, "player") if a.kind != "escape"]
    if not actions:
        return []

    def quick(a: Action) -> float:
        if a.kind == ACTION_SKILL and a.skill_id:
            sk = rs.skills[a.skill_id]
            if sk.is_attack and sk.power:
                return 1.0 + sk.power / 60.0
            if sk.is_defense:
                return 1.2
            return 1.1
        if a.kind == ACTION_SWITCH:
            return 1.15
        return 0.9

    by_kind: Dict[str, List[Action]] = {}
    for a in actions:
        by_kind.setdefault(a.kind, []).append(a)
    picked: List[Action] = []
    for kind in (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM):
        group = sorted(by_kind.get(kind, []), key=quick, reverse=True)
        picked.extend(group[: max(1, beam // 2 if kind != ACTION_SKILL else beam)])
    # 去重、按启发式排序、截到 beam
    uniq: List[Action] = []
    for a in sorted(picked, key=quick, reverse=True):
        if a not in uniq:
            uniq.append(a)
    return uniq[:beam]


# ── 搜索 ────────────────────────────────────────────────────────────────


def plan_actions(
    state: GameState,
    rs: Ruleset,
    *,
    side: str = "player",
    depth: int = DEFAULT_DEPTH,
    beam: int = DEFAULT_BEAM,
    budget_ms: int = DEFAULT_BUDGET_MS,
    clock: Callable[[], float] = time.perf_counter,
) -> PlanResult:
    """搜索 2—3 回合，返回推荐动作与它的风险画像。

    `clock` 可注入，方便测试用一个确定性时钟验证「超时后如实上报」。
    """
    start = clock()
    depth = max(1, min(MAX_DEPTH, depth))
    beam = max(1, min(MAX_BEAM, beam))
    budget_s = max(0.05, budget_ms / 1000.0)

    opponent = "enemy" if side == "player" else "player"
    my_candidates = _my_candidates(state, rs, beam=beam)
    branches = 0
    timed_out = False
    reached_depth = 0

    if not my_candidates:
        return PlanResult(
            recommended=None, recommended_label="（无合法动作）",
            expected=0.0, worst=0.0, best=0.0, main_counter=None,
            counter_note="没有可用动作", branches_evaluated=0, depth_searched=0,
            beam=beam, coverage=0.0, timed_out=False,
            latency_ms=(clock() - start) * 1000.0, opponent_model="heuristic-distribution",
            unsupported_seen=len(state.unsupported),
            note="当前局面没有可规划的动作（可能已结束或只能撤退）",
        )

    # 每个候选动作：对手按其分布推进，得到 (期望, 最坏, 最好)
    results: List[Dict[str, Any]] = []
    counters: Dict[Action, Tuple[str, float]] = {}

    def rollout(root: GameState, first: Action, opp_action: Action, remaining: int,
                alpha: float) -> float:
        """从 root 出发走一手，然后按「双方都取启发式最优」继续 remaining 层。

        返回从 `side` 视角的估值。超时由外层循环检查。
        """
        nonlocal branches
        try:
            nxt = renv.step_joint(
                _clone(root), rs, first if side == "player" else opp_action,
                opp_action if side == "player" else first,
            )
        except (ValueError, Exception):     # noqa: BLE001 —— 非法/未支持组合直接丢弃
            return alpha
        branches += 1
        cur = nxt
        for _ in range(remaining):
            if cur.result or cur.phase == "replace":
                break
            mine = _my_candidates(cur, rs, beam=2)
            theirs = opponent_distribution(cur, rs, beam=2)
            if not mine or not theirs:
                break
            best_a = max(
                mine,
                key=lambda a: evaluate(
                    _safe_step(cur, rs, a, theirs[0][0], side), rs, side) if side == "player"
                    else evaluate(_safe_step(cur, rs, theirs[0][0], a, side), rs, side),
            )
            pa = best_a if side == "player" else theirs[0][0]
            ea = theirs[0][0] if side == "player" else best_a
            stepped = _safe_step(cur, rs, pa, ea, side)
            if stepped is cur:
                break
            cur = stepped
            branches += 1
        return evaluate(cur, rs, side)

    for action in my_candidates:
        if (clock() - start) > budget_s:
            timed_out = True
            break
        dist = opponent_distribution(state, rs, beam=beam)
        if not dist:
            score = evaluate(_safe_step(state, rs, action, None, side), rs, side)
            results.append({"action": action, "expected": score, "worst": score,
                            "best": score, "branch_scores": {}})
            reached_depth = 1
            continue
        per_opp: Dict[str, float] = {}
        expected = 0.0
        worst = None
        best = None
        for opp_action, weight in dist:
            sc = rollout(state, action, opp_action, depth - 1, alpha=-10.0)
            per_opp[_label(rs, opp_action)] = sc
            expected += sc * weight
            worst = sc if worst is None else min(worst, sc)
            best = sc if best is None else max(best, sc)
        reached_depth = max(reached_depth, depth)
        # 主要反制 = 让我方收益最低的那个对手动作
        if per_opp:
            counter_label = min(per_opp.items(), key=lambda kv: kv[1])
            counters[action] = counter_label
        results.append({
            "action": action, "expected": expected,
            "worst": worst if worst is not None else expected,
            "best": best if best is not None else expected,
            "branch_scores": per_opp,
        })

    if not results:
        return PlanResult(
            recommended=None, recommended_label="（预算内没有搜到分支）",
            expected=0.0, worst=0.0, best=0.0, main_counter=None,
            counter_note="时间预算在第一个分支前就用完了",
            branches_evaluated=branches, depth_searched=0, beam=beam,
            coverage=0.0, timed_out=True,
            latency_ms=(clock() - start) * 1000.0, opponent_model="heuristic-distribution",
            unsupported_seen=len(state.unsupported),
            note="超时：未完成任何分支。上层应当把 coverage 当作 0 并降级。",
        )

    # 排序：先看期望，再看最坏（稳健），避免推荐「赌一把」
    results.sort(key=lambda r: (r["expected"], r["worst"]), reverse=True)
    top = results[0]
    counter_label, counter_score = counters.get(top["action"], (None, None))

    total_possible = len(my_candidates)
    coverage = len(results) / total_possible if total_possible else 0.0

    note_parts = [
        f"搜了 {len(results)}/{total_possible} 个我方候选 × 对手 {beam} 个候选",
        f"深度 {reached_depth}",
    ]
    if timed_out:
        note_parts.append(
            "**超时**：这是已完成的部分，不是完整搜索结果；上层不得当成深搜结论"
        )
    note_parts.append("对手按分布建模，未读取其待执行动作")

    return PlanResult(
        recommended=top["action"],
        recommended_label=_label(rs, top["action"]),
        expected=top["expected"],
        worst=top["worst"],
        best=top["best"],
        main_counter=counter_label,
        counter_note=(
            f"最不利的对手选择是「{counter_label}」（估值 {counter_score:.2f}）"
            if counter_label else "对手分布为空，未识别反制"
        ),
        branches_evaluated=branches,
        depth_searched=reached_depth,
        beam=beam,
        coverage=coverage,
        timed_out=timed_out,
        latency_ms=(clock() - start) * 1000.0,
        opponent_model="heuristic-distribution",
        unsupported_seen=len(state.unsupported),
        note="；".join(note_parts),
    )


def _clone(state: GameState) -> GameState:
    return GameState.from_dict(state.to_dict())


def _safe_step(state: GameState, rs: Ruleset, pa: Optional[Action],
               ea: Optional[Action], side: str) -> GameState:
    """走一手；非法或未支持就原样返回（调用方据此终止分支）。"""
    if pa is None and ea is None:
        return state
    try:
        if state.phase == "replace":
            return state
        a = pa if pa is not None else Action(kind=ACTION_SWITCH, target_index=0)
        b = ea if ea is not None else Action(kind=ACTION_SWITCH, target_index=0)
        return renv.step_joint(_clone(state), rs, a, b)
    except Exception:                       # noqa: BLE001
        return state


def _label(rs: Ruleset, action: Optional[Action]) -> str:
    if action is None:
        return "（无）"
    try:
        return action.label(rs)
    except Exception:                       # noqa: BLE001
        return action.kind


def immediate_greedy(state: GameState, rs: Ruleset, *, side: str = "player") -> Optional[Action]:
    """即时贪心基线：只看这一手的即时收益，用于与 planner 对照。

    它**不算**后续回合——这正是 planner 要证明自己有价值的地方。
    """
    other = "enemy" if side == "player" else "player"
    actions = [a for a in renv.legal_actions(state, rs, side) if a.kind != "escape"]
    if not actions:
        return None
    best, best_score = None, None
    for a in actions:
        opp = opponent_distribution(state, rs, beam=1)
        ea = opp[0][0] if opp else None
        nxt = _safe_step(state, rs, a if side == "player" else ea,
                         ea if side == "player" else a, side)
        sc = evaluate(nxt, rs, side)
        if best_score is None or sc > best_score:
            best, best_score = a, sc
    return best
