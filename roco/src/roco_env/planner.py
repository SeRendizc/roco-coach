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

from . import effects as fx
from . import env as renv
from .data import Ruleset, RulesetError
from .schema import ACTION_ITEM, ACTION_SKILL, ACTION_SWITCH, Action, GameState

# 束宽与深度：默认值与上限。调大就慢，调小就浅——两者都要在回执里报出来。
DEFAULT_BEAM = 4
MAX_BEAM = 8
DEFAULT_DEPTH = 2
MAX_DEPTH = 3
DEFAULT_BUDGET_MS = 2000
#: 搜索**内部**推演时使用的固定随机种子。
#:
#: 为什么需要一个固定的：引擎把「同速裁决」建模成 seed 驱动的随机
#: （`env._rng_for` 由 `(state.seed, turn)` 派生）。规划时状态是从公开面
#: 重建出来的、带着**分析种子**，于是搜索里那些推演出来的后续回合
#: 会用分析种子去裁决同速 —— 结果是**换个分析种子，推荐就变**，
#: 而变的不是「我们对局面知道多少」，只是搜索内部几次掷骰子。
#: 实测症状：三个分析种子（11/29/47）给出「穿膛 / 使用能量果 / 穿膛」，
#: 聚合判定 `recommendation_stable=false`，最终**不给推荐**。
#:
#: 现在搜索内部用这个固定种子，于是：
#:   · 分析种子之间仍然会不同 —— 但只来自**公开面重建时的假设**
#:     （对手后备按满血建模等），那是真的不确定；
#:   · 搜索自身的推演可复现，不会因为掷骰子换答案。
#: 这是把「局面不确定性」与「搜索内部的随机实现细节」分开，不是把随机去掉。
SEARCH_SEED = 20260921
#: 期望到最坏的落差超过这个值，就认为这一手「脆」（`risk.fragile`）。
#: 这是**产品阈值**，不是游戏机制；改它只影响措辞分级，不影响任何估值。
FRAGILE_DOWNSIDE = 1.2
#: 04.3（R5）：根节点候选的裁剪规则，**逐字写进回执**（让「裁掉了谁、按什么规则」可追问）。
CANDIDATE_RULE = (
    "类别保底（skill / switch / item 各至少 1 条，保底可能超过 beam）"
    "+ 按**一手推演值**降序补到 beam（不按静态威力排序）"
)
#: 04.4：判定「**有证据的**重大损失」的阈值（`evaluate` 的分数尺度）。
#:
#: 与 `FRAGILE_DOWNSIDE` **语义不同、故意分开**：那个是「期望到最坏的落差」（措辞分级），
#: 这个是「最坏分支本身已经很差」（**排序规则**）。改一个不会动另一个。
#: 这是**产品阈值**，不是游戏机制；它只决定排序里的第一优先级，不改变任何估值。
MATERIAL_LOSS = 1.2
#: 04.4：「相近动作可并列」的容差（一手推演尺度）。两条动作的期望与最坏都落在容差内
#: ⇒ 回执里**并列**列出，不假装一条严格更优（阈值同样是产品参数）。
TIE_EPSILON = 0.02


def robust_sort_key(row: Dict[str, Any]) -> Tuple[int, float, float]:
    """04.4 的稳健排序键：① 无「有证据的重大损失」优先 ② 期望降序 ③ 最坏降序。

    为什么要有①：旧的 `(expected, worst)` 字典序里**期望压倒一切** ——
    「期望略高、但某个确定分支会崩」的动作会排在「稳一点、没有崩盘分支」的前面。
    这正是必做反例②要拦的东西（纯伤害分高 ≠ 该推荐）。

    「**有证据的**」是关键：分支 rollout 因非法/机制未核验被 fail closed 丢掉时返回的是
    哨兵 `alpha`，那是「没算出来」而不是「重大损失」⇒ 不计入①（见 `is_material_loss`）。
    """
    return (0 if row.get("material_loss") else 1, float(row.get("expected", 0.0)),
            float(row.get("worst", 0.0)))


def is_material_loss(*, row_worst: float, worst_computed: bool,
                     has_opponent_distribution: bool) -> bool:
    """04.4：**有证据的**重大损失 —— 三个条件缺一不可。

    ① `has_opponent_distribution`：没有对手分布时那一行只是「无对手的静态估值」，
       不是分支损失证据；
    ② `worst_computed`：最坏那一支必须是**算出来的**。fail closed 丢分支时返回哨兵
       `alpha=-10.0`，它不是「这手会崩」的证据（是「没算出来」）；
    ③ `row_worst <= -MATERIAL_LOSS`：确实够差。
    """
    return bool(has_opponent_distribution and worst_computed
                and row_worst <= -MATERIAL_LOSS)


def close_calls(results: Sequence[Dict[str, Any]], top: Dict[str, Any], *,
                epsilon: float = TIE_EPSILON) -> List[Dict[str, Any]]:
    """04.4：与首选**相近**的候选（容差内，且重大损失等级相同）。

    「相近动作可并列」的落地：两条动作的期望与最坏都落在 `epsilon` 内 ⇒ 不假装一条严格
    更优。重大损失等级不同的两条**不算并列**（一条有崩盘分支、一条没有，那是实质差别，
    不是噪声）。
    """
    return [row for row in results
            if row is not top
            and bool(row.get("material_loss")) == bool(top.get("material_loss"))
            and abs(float(row["expected"]) - float(top["expected"])) <= epsilon
            and abs(float(row["worst"]) - float(top["worst"])) <= epsilon]


def estimate_declarations() -> Dict[str, Any]:
    """04.4（R1/R2）：把「这些数字不是胜率/不是概率/不是把握度」写成**机器可检字段**。

    04.2 已有注入路径的 `is_probability:false`，人读声明也在 `limitations` 里；这里补的是
    **每个数字自己的口径**：期望 / 最坏 / 最好 / 边际量 / 覆盖率 / 风险阈值 / 对手权重。
    上层可以不读中文也把「这是估值不是概率」判死。
    """
    return {
        "is_probability": False,
        "is_winrate": False,
        "scale": "heuristic-position-score",
        "value_range": "启发式局面分落在 [-3, 3]；终局 ±10（见 evaluate() 的 docstring）",
        "expected": {"is_probability": False, "unit": "score",
                     "basis": "启发式局面分对**启发式**对手分布取期望；权重没有实测频率数据"},
        "worst": {"is_probability": False, "unit": "score",
                  "basis": "对手分布下最差那一支的分数"},
        "best": {"is_probability": False, "unit": "score",
                 "basis": "对手分布下最好那一支的分数"},
        "first_second_margin": {"is_probability": False, "unit": "one-ply-value",
                                "basis": "一手推演值的前两名之差；量纲按本引擎标定"},
        "coverage": {"is_probability": False, "is_confidence": False, "unit": "count_ratio",
                     "basis": "计数比（对手反制被枚举过的候选 / 参与搜索的候选）"},
        "risk": {"is_probability": False, "unit": "score_gap",
                 "basis": f"期望到最坏的落差；fragile 阈值 {FRAGILE_DOWNSIDE} 是产品参数"},
        "opponent_weights": {"is_probability": False, "unit": "heuristic_weight",
                             "basis": "启发式权重（可解释规则），不是频率、不是概率"},
        "note": "以上是启发式估值与计数比：**不是胜率、不是概率、不是把握度**",
    }


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
    coverage: float          # 对手反制被枚举过的比例（1.0 = 全部候选都对着对手分布搜过）
    timed_out: bool
    latency_ms: float
    opponent_model: str
    unsupported_seen: int
    note: str
    #: 对手分布为空、只做了静态估值的候选数（不计入 branches_evaluated 与 coverage）。
    no_counter_branches: int = 0
    #: **枚举第一与第二名的估值差**（top1 − top2，只在一手推演值上算）。
    #:
    #: 为什么要有它：产品侧要判断「这一手是不是真的两难」——
    #: 第一和第二咬得很紧时才值得提示，差得远时玩家照着最优走就行。
    #: 以前回执里只有 `expected/worst/best`，**没有第二名**，所以那个判断在运行期
    #: 根本算不出来（W5-04 的判定层就卡在这里，见 docs/roco/W5-04-INTERVENTION-GATE.md §10.3）。
    #:
    #: 口径：与 `one_ply_value` 同一把尺子（`evaluate` 的分数差），
    #: 只统计**真的推演出来**的候选；只有一个可行动作或全部推不动时为 None。
    #: 它**不是**胜率，也不是「分差」的游戏机制含义，只是估值差。
    first_second_margin: Optional[float] = None
    #: 被丢弃的分支数与原因（{异常类名: 次数}）。fail closed 的可见面。
    dropped_branches: Dict[str, int] = field(default_factory=dict)
    #: **风险分支**（W3-04）：推荐动作在对手各种合法选择下的分布。
    #:
    #: `expected`/`worst` 只给两个点（均值与最小值），看不出「这个推荐有多脆」。
    #: 例如两手的期望都是 1.0，但 A 在所有对手选择下都是 1.0、B 在一半情况下是 -2，
    #: 那是两个完全不同的建议。这里把**最差前三个对手动作**与风险差列出来：
    #:   `downside`       = expected - worst（期望到最坏的落差）
    #:   `top_risks`      = 按估值升序的前三个对手动作及该分支的得分
    #:   `spread`         = best - worst（同一手在不同对手选择下的最大落差）
    #: `fragile` = 落差超过 `FRAGILE_DOWNSIDE` 时置位：上层可以把措辞从
    #: 「可以优先考虑」降级成「这一手不稳，看区间」。
    risk: Dict[str, Any] = field(default_factory=dict)
    #: 04.3（R5）：**候选**这一层被裁掉谁、按什么规则裁的，逐类留痕。
    #:
    #: 为什么要有它：`coverage` 与 `branches_evaluated` 只说「算了多少」，
    #: 「合法动作里哪些没进搜索、为什么」在回执里看不见。束宽与类别保底都是
    #: **产品规则**，被裁掉的候选可能正是玩家想问的那一手（03.5 的同类教训）。
    truncation: Dict[str, Any] = field(default_factory=dict)
    #: 04.3（R3）：`coverage` 的**计数比**口径（分子/分母/单位/不是把握度）。
    #: 分母是 **beam 裁剪之后**的候选数 —— 单看 `coverage` 会把它读成「把握度」。
    coverage_detail: Dict[str, Any] = field(default_factory=dict)
    #: 04.3（R8）：深度/束宽/预算被截断的**语义**（请求截断 vs 到达引擎上限）。
    budget: Dict[str, Any] = field(default_factory=dict)
    #: 04.4：稳健排序的**可核对留痕**（排序规则、阈值、被①压下去的动作、并列动作、逐候选排序）。
    robustness: Dict[str, Any] = field(default_factory=dict)
    #: 04.4（R1/R2）：每个数字的口径声明（`is_probability:false` 等），机器可检。
    declarations: Dict[str, Any] = field(default_factory=dict)
    #: 04.2：**只在注入对手情景时**出现（缺省为空 ⇒ `to_dict()` 的键集与 04.2 之前逐字段相同）。
    opponent_model_detail: Dict[str, Any] = field(default_factory=dict)

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
            "no_counter_branches": self.no_counter_branches,
            "first_second_margin": (round(self.first_second_margin, 4)
                                    if self.first_second_margin is not None else None),
            "dropped_branches": dict(self.dropped_branches),
            # 04.3（R5）：候选层的裁剪留痕（谁被裁、按什么规则）
            "truncation": dict(self.truncation),
            "risk": dict(self.risk),
            "depth_searched": self.depth_searched,
            "beam": self.beam,
            # 04.3（R8）：深度/束宽/预算的截断语义
            "budget": dict(self.budget),
            "coverage": round(self.coverage, 4),
            # 04.3（R3）：coverage 的计数比口径（不是把握度、不是概率）
            "coverage_detail": dict(self.coverage_detail),
            # 04.4：稳健排序的留痕 + 每个数字的口径声明
            "robustness": dict(self.robustness),
            "declarations": dict(self.declarations),
            "timed_out": self.timed_out,
            "latency_ms": round(self.latency_ms, 1),
            "opponent_model": self.opponent_model,
            "unsupported_seen": self.unsupported_seen,
            "note": self.note,
            # 04.2：只在注入情景时出现（缺省不出现 ⇒ 逐字段不变）
            **({"opponent_model_detail": dict(self.opponent_model_detail)}
               if self.opponent_model_detail else {}),
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

    关于「要不要加即时伤害项」——**试过，撤了**。看起来是个明显的缺口
    （估值里没有「谁打得更疼」），但 A/B 不支持它：同一批 100 个局面上，
    加与不加的「选中最高伤害动作」比例是 59% 与 57%，中位数都是 1。
    差 2 个百分点、样本 100，这是噪声，不是改善。
    证据不足就不加复杂度；完整负结论见 `docs/roadmap/DSH-EXECUTION-STATE.md`。
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
    state: GameState, rs: Ruleset, *, beam: int = DEFAULT_BEAM,
    scenarios: Optional[Sequence["OpponentScenario"]] = None,
) -> List[Tuple[Action, float]]:
    """对手动作的**分布**，不是「它一定会做什么」。

    权重来自可解释的启发式（与 `opponents.py` 的 greedy/status/conservative
    同源思路），并做归一化。它**只**读对手自己的合法动作与公开局面。

    重要：这里没有任何地方读取 `state._pending_*`（那是对手本回合已提交的动作），
    也没有读取对手后备的血量。教练不应该知道对手下一手。

    04.2（**加性可选**）：给了 `scenarios`（注入的对手情景，来自 03 的
    `buildScenarioOutlook`）就改走 `opponent_scenario_distribution()` —— 只当**无序集合**：
    等权基线、按 `scenario_id` 定序、不把任何权重当概率。`scenarios` 为 None/空 ⇒ 本函数
    与 04.2 之前**逐字段相同**。
    """
    if scenarios:
        dist, _detail = opponent_scenario_distribution(state, rs, beam=beam, scenarios=scenarios)
        return dist
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


# ── 04.2：注入的对手情景（**加性可选**；缺省路径逐字段不变）──────────────────
#
# 为什么是「注入」而不是引擎自建：对手候选/情景口径的**唯一实现**在 Node 侧
# （`src/coach/opponent-belief.mjs` 的 `buildScenarioOutlook`，协议 rc604-opponent-outlook/v1）。
# 引擎在这里只当它是一个**无序情景集合**：按 `scenario_id` 定序、**不排序**、
# **不把任何权重当概率**（情景集合没有频率数据，见 03.4 的声明）。
#: 情景类别（与 04-PLAN 的「留场攻击 / 防御 / 换入已见威胁」一一对应）。
SCENARIO_KINDS: Tuple[str, ...] = ("stay_attack", "stay_defense", "switch_in_seen")
#: 注入情景时对手动作的权重口径：**均匀基线**（不是概率、不是频率）。
SCENARIO_WEIGHT_BASIS = (
    "均匀基线：注入的情景集合没有真实频率数据，集合内每个可枚举动作等权；"
    "**不是概率**、不是「对手会这么做」的把握度（对齐 03.4 的 is_probability:false）"
)


class ScenarioShapeError(ValueError):
    """注入的 `opponent_scenarios` 形状不合法。**fail closed**：拒绝，不猜。"""


@dataclass(frozen=True)
class OpponentScenario:
    """一条注入的对手情景（只描述「可能」，不描述「已经提交」）。"""

    scenario_id: str
    kind: str
    slots: Tuple[int, ...] = ()
    species_ids: Tuple[str, ...] = ()
    skill_ids: Tuple[str, ...] = ()
    evidence_ids: Tuple[str, ...] = ()
    source: str = "injected:outlook"


def parse_opponent_scenarios(raw: Any) -> List[OpponentScenario]:
    """结构校验 + 定序。**形状不对就抛**（上层转成 400），不「猜一个」。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ScenarioShapeError("opponent_scenarios 必须是数组")
    if len(raw) > 64:
        raise ScenarioShapeError("opponent_scenarios 最多 64 条")
    out: List[OpponentScenario] = []
    seen = set()
    for i, row in enumerate(raw):
        if not isinstance(row, dict):
            raise ScenarioShapeError(f"opponent_scenarios[{i}] 必须是对象")
        sid = row.get("scenario_id")
        kind = row.get("kind")
        if not isinstance(sid, str) or not sid.strip():
            raise ScenarioShapeError(f"opponent_scenarios[{i}].scenario_id 必须是非空字符串")
        if sid in seen:
            raise ScenarioShapeError(f"opponent_scenarios 里 scenario_id 重复：{sid}")
        seen.add(sid)
        if kind not in SCENARIO_KINDS:
            raise ScenarioShapeError(
                f"opponent_scenarios[{i}].kind 必须是 {' / '.join(SCENARIO_KINDS)}，实际 {kind!r}")
        # 概率性字段一律拒绝：情景集合不是分布
        for banned in ("probability", "weight", "share", "p", "is_probability_true"):
            if banned in row:
                raise ScenarioShapeError(
                    f"opponent_scenarios[{i}] 不许带 {banned}：情景集合不是概率分布")
        def _ints(key: str) -> Tuple[int, ...]:
            value = row.get(key, [])
            if not isinstance(value, list) or any(not isinstance(x, int) or isinstance(x, bool) for x in value):
                raise ScenarioShapeError(f"opponent_scenarios[{i}].{key} 必须是整数数组")
            return tuple(value)

        def _strs(key: str) -> Tuple[str, ...]:
            value = row.get(key, [])
            if not isinstance(value, list) or any(not isinstance(x, str) or not x for x in value):
                raise ScenarioShapeError(f"opponent_scenarios[{i}].{key} 必须是非空字符串数组")
            return tuple(value)

        out.append(OpponentScenario(
            scenario_id=sid, kind=kind,
            slots=_ints("slots"), species_ids=_strs("species_ids"),
            skill_ids=_strs("skill_ids"), evidence_ids=_strs("evidence_ids"),
            source=str(row.get("source") or "injected:outlook"),
        ))
    # **按 scenario_id 定序**（不是按任何权重/range —— 情景之间不排序）
    return sorted(out, key=lambda s: s.scenario_id)


def opponent_scenario_distribution(state: GameState, rs: Ruleset, *, beam: int,
                                   scenarios: Sequence[OpponentScenario]
                                   ) -> Tuple[List[Tuple[Action, float]], Dict[str, Any]]:
    """把注入情景映射成对手的**可枚举动作集合**（均匀基线），并如实登记缺什么。

    映射（逐条可核对）：
      · `stay_attack`     ⇒ 场上那只的**攻击/状态类**技能动作，技能 id 落在该情景的 `skill_ids` 里
                            （`skill_ids` 为空 = 不筛，取该只全部攻击/状态技能）；
      · `stay_defense`    ⇒ 场上那只的**防御类**技能动作；
      · `switch_in_seen`  ⇒ 换到该情景 `slots` 里的任一存活后备（已见威胁通常在 `species_ids` 里点名）。

    **情景点名、但重建状态给不出**的一律记进 `unavailable[]`（不假装能算），四类都登记：
      ① 技能不在规范配招/当前可学面里 ⇒ 枚举不出来；
      ② 技能枚举得出但**类别与情景不符**（`stay_attack` 点了防御技等）⇒ 不混用；
      ③ 换人位次换不了（倒下 / 不是合法换人）、或点名的**物种不在重建队列**里
         （未亮明 ⇒ 占位物种建模，换人动作可枚举但物种对不上）；
      ④ **整条情景一个动作都没枚举出来**（含「点名的动作全被束宽截断」——两种原因分开写）。

    权重 = `SCENARIO_WEIGHT_BASIS`（集合内等权），按 `scenario_id` 定序后取前 `beam` 条。
    逐条留痕：`enumerated_actions[]`（情景点名并枚举出来的**具体动作**）、
    `enumerated_by_scenario{}`（逐情景计数）、`dropped[]`（束宽之外，逐条点名）。
    """
    legal = [a for a in renv.legal_actions(state, rs, "enemy") if a.kind != "escape"]
    if not legal:
        return [], {"scenario_ids": [], "basis": SCENARIO_WEIGHT_BASIS, "is_probability": False,
                    "enumerated": 0, "dropped": [], "unavailable": [], "weights": "uniform_baseline"}
    by_skill = {a.skill_id: a for a in legal if a.kind == ACTION_SKILL and a.skill_id}
    by_slot = {a.target_index: a for a in legal if a.kind == ACTION_SWITCH and a.target_index is not None}
    #: 重建队列里**实际存在**的对手物种（场上 + 后备）。未亮明的后备用占位物种 ⇒
    #: 情景点名的真实物种匹配不上，必须如实登记（不假装能算）。
    present_species = {p.pet_id for p in state.enemy.pets}
    picked: List[Tuple[Action, str]] = []
    unavailable: List[Dict[str, Any]] = []
    for sc in scenarios:
        if sc.kind in ("stay_attack", "stay_defense"):
            want_defense = sc.kind == "stay_defense"
            wanted = list(sc.skill_ids) if sc.skill_ids else None
            for skill_id in (wanted if wanted is not None else sorted(by_skill)):
                action = by_skill.get(skill_id)
                if action is None:
                    unavailable.append({"scenario_id": sc.scenario_id, "skill_id": skill_id,
                                        "why": "重建状态里枚举不出这个技能（不在规范配招/当前可学面里）"})
                    continue
                sk = rs.skills.get(skill_id)
                if sk is None:
                    continue
                is_defense = bool(getattr(sk, "is_defense", False))
                if is_defense != want_defense:
                    # 情景点名了、技能也枚举得出，但**类别不符**：不许混用，如实登记。
                    if wanted is not None:
                        unavailable.append({
                            "scenario_id": sc.scenario_id, "skill_id": skill_id,
                            "why": f"技能可枚举，但它是{'防御' if is_defense else '攻击/状态'}类，"
                                   f"与情景 kind={sc.kind} 不符（类别不混用）",
                        })
                    continue
                picked.append((action, sc.scenario_id))
            continue
        for slot in sc.slots:
            action = by_slot.get(slot)
            if action is None:
                unavailable.append({"scenario_id": sc.scenario_id, "slot": slot,
                                    "why": "重建状态里这个位次换不了（倒下 / 不是合法换人）"})
                continue
            picked.append((action, sc.scenario_id))
        # 情景点名的物种在这一侧的建模里**根本不存在**（典型原因：后备尚未亮明、
        # 按占位物种建模）⇒ 换人动作本身可枚举，但物种对不上，必须如实登记。
        for species_id in sc.species_ids:
            if species_id not in present_species:
                unavailable.append({
                    "scenario_id": sc.scenario_id, "species_id": species_id,
                    "why": "重建队列里没有这个物种（尚未亮明 ⇒ 按占位物种/规范配招假设建模）："
                           "换人动作可枚举，但物种对不上",
                })
    # 去重（同一动作可能被多条情景点到），保持 scenario_id 定序 ⇒ 动作序也确定
    seen_actions: List[Tuple[Action, str]] = []
    for action, sid in picked:
        if all(existing is not action for existing, _ in seen_actions):
            seen_actions.append((action, sid))
    kept = seen_actions[:max(1, beam)]
    dropped = [{"action": _label(rs, a), "scenario_id": sid,
                "why": f"束宽 {beam} 之外（按 scenario_id 定序截断，不按权重）"}
               for a, sid in seen_actions[max(1, beam):]]
    # 逐情景统计**最终真的被枚举**的动作数（截断之后）：
    # 只报总数 `enumerated` 时，「3 条情景里 2 条什么都没算出来」在回执里看不出来。
    counts: Dict[str, int] = {sc.scenario_id: 0 for sc in scenarios}
    for _a, sid in kept:
        if sid in counts:
            counts[sid] += 1
    picked_ids = {sid for _a, sid in picked}
    for sc in scenarios:
        if counts.get(sc.scenario_id):
            continue
        unavailable.append({
            "scenario_id": sc.scenario_id, "kind": sc.kind,
            "why": ("这条情景点名到的动作都在束宽外（按 scenario_id 定序截断，不按权重）"
                    if sc.scenario_id in picked_ids else
                    "这条情景在重建状态里一个动作都枚举不出来（不假装能算）"),
        })
    total = len(kept) or 1
    dist = [(a, 1.0 / total) for a, _sid in kept]
    detail = {
        "scenario_ids": [sc.scenario_id for sc in scenarios],
        "kinds": sorted({sc.kind for sc in scenarios}),
        "basis": SCENARIO_WEIGHT_BASIS,
        "is_probability": False,
        "weights": "uniform_baseline",
        "enumerated": len(kept),
        #: 情景点名并被枚举出来的**具体动作**（scenario-driven 一侧的可见面）
        "enumerated_actions": [
            {"action": _label(rs, a), "scenario_id": sid, "kind": "scenario"}
            for a, sid in kept
        ],
        "enumerated_by_scenario": counts,
        "dropped": dropped,
        "unavailable": unavailable,
        "evidence_ids": sorted({e for sc in scenarios for e in sc.evidence_ids}),
        "note": ("注入情景只当**无序集合**用：按 scenario_id 定序、不按 range 排序、"
                 "不把任何权重当概率；情景点名但枚举不出来的技能/位次/物种如实记在 unavailable 里"),
    }
    return dist, detail


def _quick(a: Action, rs: Ruleset) -> float:
    """便宜的排序启发式：只看**静态**威力/类别。用在深层 rollout。"""
    if a.kind == ACTION_SKILL and a.skill_id:
        sk = rs.skills.get(a.skill_id)
        if sk is None:
            return 0.5
        if sk.is_attack and sk.power:
            return 1.0 + sk.power / 60.0
        if sk.is_defense:
            return 1.2
        return 1.1
    if a.kind == ACTION_SWITCH:
        return 1.15
    return 0.9


def _quick_candidates(state: GameState, rs: Ruleset, *, beam: int,
                      side: str = "player") -> List[Action]:
    """便宜版候选：按类别保底 + 静态威力排序。**用于 rollout 内部**。

    这里保留「便宜」是刻意的：rollout 每一层都要调它，
    而下面那个 `_my_candidates` 会为每个动作跑一遍一步推演 —— 放在深层会爆预算。
    """
    actions = [a for a in renv.legal_actions(state, rs, side) if a.kind != "escape"]
    if not actions:
        return []
    by_kind: Dict[str, List[Action]] = {}
    for a in actions:
        by_kind.setdefault(a.kind, []).append(a)
    picked: List[Action] = []
    for kind in (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM):
        group = sorted(by_kind.get(kind, []), key=lambda x: _quick(x, rs), reverse=True)
        picked.extend(group[: max(1, beam // 2 if kind != ACTION_SKILL else beam)])
    uniq: List[Action] = []
    for a in sorted(picked, key=lambda x: _quick(x, rs), reverse=True):
        if a not in uniq:
            uniq.append(a)
    return uniq[:beam]


def one_ply_value(state: GameState, rs: Ruleset, action: Action, *, side: str = "player",
                  beam: int = 4, scenarios: Optional[Sequence[OpponentScenario]] = None) -> float:
    """一个动作的**一步推演**值：按对手分布走一手，再估值，取期望。

    这是候选筛选用的判据，也是「基准最优」用的判据 —— **同一个函数**，
    所以「搜索有没有找到估值函数偏好」与「候选有没有把最优留住」是同一把尺子。

    **推不动的分支必须排除，不能拿「原状态」当分数。**
    `_safe_step` 在步骤非法或机制未核验时**原样返回输入状态**，于是
    `evaluate(原状态)` 会给一个「什么都没做」的分数，可能**恰好**高于真正可行
    的动作 —— 把执行不了的选项排到前面去。

    这一条是被基准量出来的：某个局面上 40 多个算不出来的动作共享同一个分数
    （实测 `-1.2121`），而基准最优动作的分数**低于**它，
    于是 planner 在那个局面上「必然选错」。修法是只对**真的推演出来**的分支取期望；
    一条都推不动时返回 `-inf`（明确表示「这个动作现在算不出来」），
    这样它不会因为「恰好排前面」而被选中。
    """
    dist = opponent_distribution(state, rs, beam=beam, scenarios=scenarios)
    if not dist:
        trial = _clone(state)
        nxt = _safe_step(trial, rs, action, None, side)
        return evaluate(nxt, rs, side) if nxt is not trial else float("-inf")
    total = 0.0
    scored = 0.0
    for opp_action, weight in dist:
        trial = _clone(state)
        nxt = _safe_step(trial, rs,
                         action if side == "player" else opp_action,
                         opp_action if side == "player" else action, side)
        if nxt is trial:
            continue                      # 这一条对手分支推不动 → 不计入
        total += evaluate(nxt, rs, side) * weight
        scored += weight
    if scored <= 0:
        return float("-inf")              # 全部推不动 = 现在算不出来，不是「没变化」
    return total / scored


def _my_candidates(state: GameState, rs: Ruleset, *, beam: int,
                   side: str = "player",
                   scenarios: Optional[Sequence[OpponentScenario]] = None) -> List[Action]:
    """根节点的我方候选：**按一步推演值**挑，而不是按静态威力挑。

    为什么改（这是本仓库里第一次用一个客观基准量出来的修正）：
    原版按**静态威力**排序，于是「条件化威力」的技能会被系统性低估 ——
    「坟场搏击」写 180 威力，实际按敌方能量可能只剩 108，但反过来别的技能
    也可能被高估。用 `scripts/roco/benchmark-planner.py` 一量就看出来了：

        60 个局面里，**全量合法动作里的基准最优有 41 个不在候选列表里**；
        而推荐在候选集合内**排名中位是 1**（搜索本身没问题）。

    也就是说损失几乎全部来自**候选裁剪**，不是搜索。改成按一步推演值挑之后，
    候选里就有最优那一手了（同一把尺子量：`top1` 从 0.27 升到 0.87 量级）。

    仍然**保留类别保底**：只按值排序很可能留下四个攻击技能，
    于是「换宠承伤」「防御等一轮」永远进不了搜索 —— 而多回合规划存在的理由
    恰恰是这两类分支。保底与按值排序**并存**，不是二选一。
    """
    picked, _scored = _candidates_and_scores(state, rs, beam=beam, side=side, scenarios=scenarios)
    return picked


def _candidates_and_scores(state: GameState, rs: Ruleset, *, beam: int,
                           side: str = "player",
                           scenarios: Optional[Sequence[OpponentScenario]] = None,
                           trace: Optional[Dict[str, Any]] = None,
                           ) -> Tuple[List[Action], List[Tuple[float, Action]]]:
    """候选与它们的分数一起返回。

    拆出来的理由：一手推演值是**每个合法动作都要算一次**的成本，
    `_my_candidates` 已经算过一遍；`first_second_margin` 要用同一个分数，
    再算一遍就是白花一遍预算（`one_ply_value` 会对每个动作枚举对手分布）。
    两处必须用**同一批**分数，否则「候选是按这个分数挑的」就不成立。

    04.3：给了 `trace` 就把**候选层的裁剪**写进去（谁被裁、按什么规则）。
    用出参而不是第三个返回值：`_my_candidates` 与 `plan_actions` 两处调用点
    只有后者要留痕，改返回值会让所有调用点都要解包（改动面大、收益为零）。
    """
    actions = [a for a in renv.legal_actions(state, rs, side) if a.kind != "escape"]
    if not actions:
        if trace is not None:
            trace.update({
                "candidates_total": 0, "candidates_kept": 0, "candidates_dropped": 0,
                "dropped_by_kind": {}, "kept_by_kind": {}, "dropped": [],
                "uncomputable": 0, "beam": beam,
                "rule": CANDIDATE_RULE, "is_probability": False,
                "note": "当前局面没有可参与搜索的合法动作",
            })
        return [], []
    scored: List[Tuple[float, Action]] = [
        (one_ply_value(state, rs, a, side=side, scenarios=scenarios), a) for a in actions]
    scored.sort(key=lambda pair: -pair[0])

    picked: List[Action] = []
    # 每个类别至少留一个（保底），再按值补齐到 beam
    for kind in (ACTION_SKILL, ACTION_SWITCH, ACTION_ITEM):
        for value, action in scored:
            if action.kind == kind:
                if action not in picked:
                    picked.append(action)
                break
    for _value, action in scored:
        if len(picked) >= beam:
            break
        if action not in picked:
            picked.append(action)
    # 类别保底可能已经超过 beam（例如 beam=1 但有三个类别）——那也留着：
    # 宁可多看两眼，也不要把「换宠/防御」这两类整类丢掉。
    if trace is not None:
        dropped_rows = []
        for value, action in scored:
            if action in picked:
                continue
            finite = value == value and value not in (float("inf"), float("-inf"))
            dropped_rows.append({
                "action": _label(rs, action), "kind": action.kind,
                # `-inf` 不能直接进 JSON（`json.dumps` 会写成 `-Infinity`，JS 的
                # `JSON.parse` 直接抛）⇒ 算不出来的记 null，并说明原因。
                "value": round(value, 4) if finite else None,
                "why": ("一手推演算不出来（-inf），无法与其它候选比较"
                        if not finite else f"束宽 beam={beam} 之外（按一手推演值降序补位时被裁）"),
            })
        trace.update({
            "candidates_total": len(actions),
            "candidates_kept": len(picked),
            "candidates_dropped": len(actions) - len(picked),
            "kept_by_kind": _count_by_kind(picked),
            "dropped_by_kind": _count_by_kind([a for _v, a in scored if a not in picked]),
            "dropped": dropped_rows,
            "uncomputable": sum(1 for v, _a in scored
                                if v != v or v in (float("inf"), float("-inf"))),
            "beam": beam,
            "rule": CANDIDATE_RULE,
            "is_probability": False,
            "note": ("truncation 只讲**候选**这一层被裁掉谁；搜索分支层面的丢弃"
                     "（非法/机制未核验）见 dropped_branches"),
        })
    return picked, scored


def _count_by_kind(actions: Sequence[Action]) -> Dict[str, int]:
    """按动作类别计数（`skill` / `switch` / `item` …），保持确定性顺序。"""
    out: Dict[str, int] = {}
    for action in actions:
        out[action.kind] = out.get(action.kind, 0) + 1
    return dict(sorted(out.items()))


def coverage_detail(*, searched: int, total: int, no_counter: int = 0) -> Dict[str, Any]:
    """04.3（R3）：`coverage` 的**计数比**口径（机器可检，防被读成把握度）。

    分子的定义：真的对着对手分布搜过的候选数；分母：**beam 裁剪之后**参与搜索的
    候选数（不是全部合法动作 —— 那部分在 `truncation` 里）。
    """
    return {
        "numerator": int(searched),
        "denominator": int(total),
        "unit": "count_ratio",
        "is_confidence": False,
        "is_probability": False,
        "meaning": "对手反制被枚举过的候选数 / 参与搜索的候选数（beam 裁剪**之后**的分母）",
        "excluded_from_denominator": "beam 之外的候选（见 truncation.dropped）",
        "excluded_from_numerator": (
            f"对手分布为空、只做静态估值的 {int(no_counter)} 个候选（见 no_counter_branches）"
        ),
        "note": "coverage 是计数比，**不是**「结论有多可靠」的把握度，也不是概率",
    }


def plan_budget_detail(*, depth_requested: int, depth_effective: int, depth_searched: int,
                       beam_requested: int, beam_effective: int, budget_ms: int,
                       timed_out: bool, nodes: int) -> Dict[str, Any]:
    """04.3（R8）：深度/束宽/预算被截断的语义，两种「到顶」分开写。"""
    return {
        "depth_requested": int(depth_requested),
        "depth_effective": int(depth_effective),
        "depth_searched": int(depth_searched),
        "depth_max": MAX_DEPTH,
        "depth_truncated": bool(int(depth_requested) > MAX_DEPTH),
        "depth_capped_by_max": bool(int(depth_searched) >= MAX_DEPTH),
        "beam_requested": int(beam_requested),
        "beam_effective": int(beam_effective),
        "beam_max": MAX_BEAM,
        "beam_truncated": bool(int(beam_requested) > MAX_BEAM),
        "budget_ms": int(budget_ms),
        "timed_out": bool(timed_out),
        "nodes": int(nodes),
        "note": (
            "depth_truncated = 调用方要的深度超过 MAX_DEPTH，被**上限**截断；"
            "depth_capped_by_max = 搜索已到引擎上限（再深没有语义，**不是**「没算完」）；"
            "depth_searched < depth_effective 且 depth_truncated=false ⇒ 只可能是 timed_out=true"
        ),
    }


def first_second_margin(scored: Sequence[Tuple[float, Action]]) -> Optional[float]:
    """枚举第一与第二名的估值差。只有一个候选、或算不出来的候选不足两个时为 None。

    算不出来的候选（`-inf`）**不参与**：拿它当第二名会得到一个虚假的「巨大分歧」。
    """
    finite = [value for value, _action in scored if value != float("-inf")]
    if len(finite) < 2:
        return None
    return float(finite[0] - finite[1])


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
    opponent_scenarios: Optional[Any] = None,
) -> PlanResult:
    """搜索 2—3 回合，返回推荐动作与它的风险画像。

    `clock` 可注入，方便测试用一个确定性时钟验证「超时后如实上报」。

    04.2：`opponent_scenarios` 是**可选**的注入情景（形状见 `parse_opponent_scenarios`）。
    不给 ⇒ 与 04.2 之前逐字段相同；给了 ⇒ 对手一侧改按**无序情景集合**枚举（等权基线），
    并把「用的是哪一种依据、枚举了什么、缺什么」写进 `opponent_model_detail`。
    """
    start = clock()
    # 04.3（R8）：把**调用方要的**深度/束宽先记下来，再 clamp —— 否则
    # 「请求被 MAX_DEPTH 截断」与「按你的要求只搜这么深」在回执里长得一样。
    depth_requested = depth
    beam_requested = beam
    budget_ms_requested = budget_ms
    depth = max(1, min(MAX_DEPTH, depth))
    beam = max(1, min(MAX_BEAM, beam))
    budget_s = max(0.05, budget_ms / 1000.0)
    parsed = parse_opponent_scenarios(opponent_scenarios) if opponent_scenarios is not None else []
    scenarios = parsed or None
    detail: Dict[str, Any] = {}
    if scenarios:
        _dist, detail = opponent_scenario_distribution(state, rs, beam=beam, scenarios=scenarios)

    opponent = "enemy" if side == "player" else "player"
    # 搜索内部统一用一个**固定**随机种子，理由见 SEARCH_SEED 的注释。
    # 只在这个函数的作用域里改，且改完恢复：调用方传进来的 state 是它的，
    # 我们不该把它的 seed 换掉（那会污染调用方后续的 replay）。
    original_seed = state.seed
    state.seed = SEARCH_SEED
    trace: Dict[str, Any] = {}
    stats: Dict[str, Any] = {}
    my_candidates, scored_candidates = _candidates_and_scores(state, rs, beam=beam, side=side,
                                                              scenarios=scenarios, trace=trace)
    # 产品侧判断「这一手是不是真的两难」要用它；与候选筛选同一批分数，不重复计算。
    margin = first_second_margin(scored_candidates)
    branches = 0
    #: 被丢弃的分支数（非法或未支持的组合）与原因计数。
    #: 只报 branches 不报丢弃数时，「搜了 3 个分支」与「13 个候选里 10 个算不出来」
    #: 在回执里长得一模一样。
    dropped: Dict[str, int] = {}
    #: 对手分布为空、只做了静态估值的候选数。它们不是「搜索分支」。
    #: 分开计的理由见下面 coverage 的判定：只统计真实枚举过的 (我方 × 对手) 组合。
    no_counter = 0
    timed_out = False
    reached_depth = 0

    try:
        result = _search(state, rs, side=side, depth=depth, beam=beam, budget_s=budget_s,
                         clock=clock, start=start, my_candidates=my_candidates,
                         opponent=opponent, original_seed=original_seed, scenarios=scenarios,
                         stats=stats)
        result.first_second_margin = margin
        result.opponent_model_detail = detail
        # 04.3：R5 候选裁剪留痕 / R8 预算与截断语义 / R3 coverage 的计数比口径。
        result.truncation = trace
        result.budget = plan_budget_detail(
            depth_requested=depth_requested, depth_effective=depth,
            depth_searched=result.depth_searched, beam_requested=beam_requested,
            beam_effective=beam, budget_ms=budget_ms_requested,
            timed_out=result.timed_out, nodes=result.branches_evaluated,
        )
        result.coverage_detail = coverage_detail(
            searched=stats.get("searched", 0), total=len(my_candidates),
            no_counter=result.no_counter_branches,
        )
        # 04.4（R1/R2）：每个数字的口径声明（机器可检的「不是概率」）
        result.declarations = estimate_declarations()
        return result
    finally:
        # 无论走哪条出口（含超时、异常）都把 seed 还回去。
        # 这一条不能靠「每个 return 前记得写一行」—— 那种约定迟早漏。
        state.seed = original_seed


def _search(state, rs, *, side, depth, beam, budget_s, clock, start, my_candidates,
            opponent, original_seed, scenarios=None, stats=None) -> PlanResult:
    branches = 0
    dropped: Dict[str, int] = {}
    no_counter = 0
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

    def _record_dropped_branch(exc: BaseException) -> None:
        key = type(exc).__name__
        dropped[key] = dropped.get(key, 0) + 1

    def rollout(root: GameState, first: Action, opp_action: Action, remaining: int,
                alpha: float) -> Tuple[float, bool]:
        """从 root 出发走一手，然后按「双方都取启发式最优」继续 remaining 层。

        返回 `(从 side 视角的估值, 这个值是不是**算出来的**)`。
        第二个返回值不是装饰：分支被 fail closed 丢掉时返回哨兵 `alpha`，
        它**不是**「这手会崩」的证据 —— 04.4 的重大损失判定必须能把两者分开。
        超时由外层循环检查。
        """
        nonlocal branches
        try:
            if root.phase == "replace":
                # 补位阶段不能调 step_joint（引擎会直接抛「请用 step_replace」）。
                # 原来这里没有分支，于是补位局面的**每一个** rollout 都走 except、
                # 被丢弃成 alpha，结果是：branches_evaluated=0、timed_out=False、
                # coverage=1.0 —— 三个字段互相矛盾，而且推荐实际上来自
                # `_safe_step` 失败后原样返回的状态（等于没算）。F02 回归抓到的就是它。
                #
                # 补位是**公开**的：双方各自换谁，屏幕上都会显示，所以这里枚举对手的
                # 每个换人候选是合法的，不违反隐藏信息边界（枚举的是「可能」，不是
                # 「已经提交的那一个」）。
                mine_first = first if side == "player" else opp_action
                theirs_first = opp_action if side == "player" else first
                cur = _clone(root)
                if mine_first is not None and mine_first.kind == "switch" and mine_first.target_index is not None:
                    renv.step_replace(cur, rs, side, int(mine_first.target_index))
                if theirs_first is not None and theirs_first.kind == "switch" and theirs_first.target_index is not None:
                    queue = renv.needs_replacement(cur)
                    if opponent in queue:
                        renv.step_replace(cur, rs, opponent, int(theirs_first.target_index))
                # 补位不消耗战斗回合，`remaining` 不递减：这里的「深度」是换人次数
                return evaluate(cur, rs, side), True
            nxt = renv.step_joint(
                _clone(root), rs, first if side == "player" else opp_action,
                opp_action if side == "player" else first,
            )
        except (ValueError, RulesetError, fx.UnsupportedEffect) as exc:
            # 非法或**机制未核验**的组合直接丢弃，并计数。
            # `UnsupportedEffect` 必须在这里接住：fail closed 是设计，
            # 但「这条分支算不出来」不该把整次规划打崩 ——
            # 实测撞到过：「硬门」是一条描述里读不出减伤比例的防御技能，
            # 估值一走到它就抛，整次 `plan_actions` 直接失败。
            _record_dropped_branch(exc)
            return alpha, False
        branches += 1
        cur = nxt
        for _ in range(remaining):
            if cur.result or cur.phase == "replace":
                break
            mine = _quick_candidates(cur, rs, beam=2, side=side)
            theirs = opponent_distribution(cur, rs, beam=2, scenarios=scenarios)
            if not mine or not theirs:
                break
            # 说明：这里**只用分布里权重最高的那条对手线**推进，而不是对分布取期望。
            # 试过改成「每个对手候选各推一步、按权重取期望」，目标是与基准一致；
            # 实测既没有改善一步推演基准（top1 0.667 → 0.684），
            # 也没有改善整局胜负（`greedy_damage` 44/80 → 41/80），
            # 却让每次规划从 142ms 涨到 186ms。**证据不足就不加复杂度**，撤回。
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
        return evaluate(cur, rs, side), True

    for action in my_candidates:
        if (clock() - start) > budget_s:
            timed_out = True
            break
        dist = opponent_distribution(state, rs, beam=beam, scenarios=scenarios)
        if not dist:
            # 对手分布为空（典型情形：补位阶段，对手侧没有可枚举的动作）。
            # 这时仍然对我方每个候选做了静态估值，但**没有建模对手的反制**：
            # 它是一次「无对手」的评估。数量单独计一栏（no_counter_branches），
            # 因为它进 branches_evaluated 会把「搜了多少分支」说过头。
            score = evaluate(_safe_step(state, rs, action, None, side), rs, side)
            results.append({"action": action, "expected": score, "worst": score,
                            "best": score, "branch_scores": {},
                            "worst_computed": True, "worst_branch": None,
                            "uncomputable_branches": 0,
                            # 没有对手分布 ⇒ 这不是「分支损失证据」，不参与稳健排序的①
                            "material_loss": False})
            no_counter += 1
            reached_depth = 1
            continue
        per_opp: Dict[str, float] = {}
        expected = 0.0
        worst = None
        best = None
        worst_computed = True
        worst_label: Optional[str] = None
        uncomputable = 0
        for opp_action, weight in dist:
            sc, computed = rollout(state, action, opp_action, depth - 1, alpha=-10.0)
            label = _label(rs, opp_action)
            per_opp[label] = sc
            if not computed:
                uncomputable += 1
            expected += sc * weight
            if worst is None or sc < worst:
                worst = sc
                worst_computed = computed
                worst_label = label
            best = sc if best is None else max(best, sc)
        reached_depth = max(reached_depth, depth)
        # 主要反制 = 让我方收益最低的那个对手动作
        if per_opp:
            counter_label = min(per_opp.items(), key=lambda kv: kv[1])
            counters[action] = counter_label
        row_worst = worst if worst is not None else expected
        results.append({
            "action": action, "expected": expected,
            "worst": row_worst,
            "best": best if best is not None else expected,
            "branch_scores": per_opp,
            # 04.4：区分「算出来的最坏」与「fail closed 哨兵」——只有前者才是损失证据
            "worst_computed": worst_computed if worst is not None else True,
            "worst_branch": worst_label,
            "uncomputable_branches": uncomputable,
            "material_loss": is_material_loss(row_worst=row_worst,
                                              worst_computed=(worst_computed
                                                              if worst is not None else True),
                                              has_opponent_distribution=True),
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

    # ── 04.4：稳健排序 ──────────────────────────────────────────────────
    # 旧口径：`(expected, worst)` 字典序 ⇒ **期望压倒一切**，「期望略高但某个确定分支会崩」
    # 的动作会排在「稳一点、没有崩盘分支」的前面（必做反例②要拦的正是这个）。
    # 新口径：① 无「**有证据的**重大损失」优先 ② 期望降序（资源与后手都在 evaluate 里）
    # ③ 最坏降序。「有证据」= 那一支是**算出来的**（不是 fail closed 哨兵 alpha）。
    material_rows = [r for r in results if r["material_loss"]]
    results.sort(key=robust_sort_key, reverse=True)
    top = results[0]
    counter_label, counter_score = counters.get(top["action"], (None, None))
    # 相近动作**并列**：不假装一条严格更优（容差内两条的期望与最坏都几乎一样）
    tied = [
        {"action": _label(rs, row["action"]),
         "expected": round(row["expected"], 4), "worst": round(row["worst"], 4),
         "gap_expected": round(top["expected"] - row["expected"], 4),
         "gap_worst": round(top["worst"] - row["worst"], 4)}
        for row in close_calls(results, top)
    ]
    robustness = {
        "ordering": ["① 无「有证据的重大损失」优先", "② 期望降序（资源与后手都在期望里）",
                     "③ 最坏降序"],
        "material_loss_threshold": MATERIAL_LOSS,
        "material_loss_actions": [
            {"action": _label(rs, row["action"]),
             "expected": round(row["expected"], 4), "worst": round(row["worst"], 4),
             "worst_branch": row["worst_branch"],
             "why": (f"有证据的最坏分支 {row['worst']:.4f} ≤ -{MATERIAL_LOSS}"
                     "（那一支是**算出来的**，不是 fail closed 哨兵）")}
            for row in material_rows
        ],
        "primary_rule_applied": bool(material_rows) and not top["material_loss"],
        "tie_epsilon": TIE_EPSILON,
        "tied_with_top": tied,
        "top": {"action": _label(rs, top["action"]),
                "expected": round(top["expected"], 4), "worst": round(top["worst"], 4),
                "material_loss": bool(top["material_loss"]),
                "worst_computed": bool(top["worst_computed"])},
        "candidates_ranked": [
            {"action": _label(rs, row["action"]),
             "expected": round(row["expected"], 4), "worst": round(row["worst"], 4),
             "best": round(row["best"], 4),
             "material_loss": bool(row["material_loss"]),
             "worst_computed": bool(row["worst_computed"]),
             "uncomputable_branches": int(row["uncomputable_branches"])}
            for row in results
        ],
        "is_probability": False,
        "note": ("稳健优先：先看有没有「有证据的重大损失」，再看期望（资源与后手都在期望里），"
                 "最后看最坏；相近动作并列列出，不假装一条严格更优。阈值是产品参数，不是游戏机制"),
    }

    # ── 风险分支（W3-04）────────────────────────────────────────────────
    # 只描述**推荐的那一手**：别的候选不该出现在「推荐的风险」里。
    branch_scores = top.get("branch_scores") or {}
    downside = top["expected"] - top["worst"]
    spread = top["best"] - top["worst"]
    top_risks = sorted(branch_scores.items(), key=lambda kv: kv[1])[:3]
    risk = {
        "downside": round(downside, 4),
        "spread": round(spread, 4),
        "branch_count": len(branch_scores),
        "top_risks": [
            {"opponent_action": label, "score": round(score, 4),
             "loss_vs_expected": round(top["expected"] - score, 4)}
            for label, score in top_risks
        ],
        "fragile": bool(downside > FRAGILE_DOWNSIDE),
        "threshold": FRAGILE_DOWNSIDE,
        "note": (
            "risk 只描述**推荐的那一手**在对手各种选择下的落差；"
            "`downside` 是期望到最坏的距离，`top_risks` 是最差的前三个对手动作。"
            "阈值是产品参数（用于措辞分级），不是游戏机制；对手仍是启发式分布建模。"
        ),
    }

    total_possible = len(my_candidates)
    # coverage 的含义是「对手反制也被枚举过的比例」。对手分布为空的局面
    # （补位阶段就是）**没有**搜索可言，只能是 0 —— 给 1.0 会让上层读成
    # 「完整搜完了」，而实际拿到的是「没有对手模型时的静态估值」。
    # 这个坑是被 F02 回归发现的：只有换人可做时 branches_evaluated=0、
    # timed_out=False、coverage=1.0，三个字段互相矛盾。
    searched = len(results) - no_counter
    coverage = (searched / total_possible) if total_possible else 0.0
    if no_counter and not searched:
        coverage = 0.0
    if stats is not None:
        stats["searched"] = searched
        stats["total_possible"] = total_possible
        stats["no_counter"] = no_counter

    note_parts = [
        f"搜了 {len(results)}/{total_possible} 个我方候选 × 对手 {beam} 个候选",
        f"深度 {reached_depth}",
    ]
    if no_counter:
        note_parts.append(
            f"其中 {no_counter} 个候选**没有**对手分布可枚举（未建模反制，只做静态估值），"
            "所以 coverage 不计入这些候选"
        )
    if dropped:
        note_parts.append(
            "丢弃的分支（非法或机制未支持，按 fail closed 不估值）："
            + "、".join(f"{k}×{v}" for k, v in sorted(dropped.items()))
        )
    if timed_out:
        note_parts.append(
            "**超时**：这是已完成的部分，不是完整搜索结果；上层不得当成深搜结论"
        )
    if robustness["primary_rule_applied"]:
        note_parts.append(
            f"稳健排序：{len(material_rows)} 个候选有**有证据的重大损失**"
            f"（最坏 ≤ -{MATERIAL_LOSS}），按「先避重大损失」规则未获推荐"
        )
    elif material_rows:
        note_parts.append(
            f"稳健排序：{len(material_rows)} 个候选有有证据的重大损失，且首选本身就在其中"
            "（所有可算分支都不好，不是没算）"
        )
    if tied:
        note_parts.append(
            f"与首选**相近**的动作有 {len(tied)} 个（容差 {TIE_EPSILON}，并列列出，不假装更优）"
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
        risk=risk,
        # 04.4：稳健排序的可核对留痕（规则、阈值、被①压下去的动作、并列动作、逐候选排序）
        robustness=robustness,
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
