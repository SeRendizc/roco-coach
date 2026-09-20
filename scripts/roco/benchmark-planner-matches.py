#!/usr/bin/env python3
"""用**整局结果**量 planner：让它真的上场比赛，看胜负。

为什么需要它（以及它与 `benchmark-planner.py` 的分工）
------------------------------------------------------

`benchmark-planner.py` 的「正确答案」是**一步推演值**，所以它天然偏向单步；
depth=2 的搜索去权衡两回合后的位置，在那个尺子上看起来反而更差。
上一轮在脚本里写了这条边界，但**没有**给出一个能补上它的工具 —— 这一份就是。

这里的口径完全不同：**让 planner 自己上场比赛**，对面是真实的对手策略，
数胜负。它没有「正确答案」可对照，但它是唯一不偏向任何搜索深度的口径。

三条纪律
--------

1. **不是天梯强度。** 对手是 5 条启发式策略，不是真人；胜负只在
   「这套引擎 + 这些对手」的范围内有意义。报告里每次都带这句话。
2. **同一批种子。** 每个对手用同一串 seed，且 baseline 与 planner 用**同样的种子**，
   否则胜负差里会混进随机波动。
3. **基线必须有。** 只报「planner 赢了多少」没有信息量；
   必须同时报 `greedy_damage` 与 `random_legal` 在同一批种子下的结果，
   才能说「规划有没有用」。

跑法::

    python3 scripts/roco/benchmark-planner-matches.py --games 20            # 自检
    python3 scripts/roco/benchmark-planner-matches.py --games 60 --budget-ms 800
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import statistics
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import planner as pm          # noqa: E402

ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]

OUT_JSON = os.path.join("reports", "roco", "planner-matches.json")
SEED_BASE = 700000            # 固定种子基数：换一批种子得出的数字不可比

def wilson_interval(wins: int, total: int, z: float = 1.96) -> Tuple[float, float]:
    """Wilson 胜率区间（95%）。**必须报**，否则小样本的胜负差会被当成结论。

    20 局里赢 12 局 vs 赢 8 局看着差 20 个百分点，但区间宽到互相覆盖 ——
    没有区间的胜率表是会骗人的。
    """
    if total == 0:
        return (0.0, 0.0)
    p = wins / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    half = (z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom
    return (round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4))


def _binom_two_sided(k: int, n: int) -> float:
    """精确二项检验（双侧），p0 = 0.5。McNemar 的精确版。

    为什么不直接上卡方：不一致对数常常只有个位数，卡方近似在这个规模上不可信。
    k=0 或 k=n 时按 1.0 处理（观测到的事件是「全部落一侧」，没有更极端的情形）。
    """
    if n <= 0:
        return 1.0
    # P(X = i)，X ~ B(n, 0.5)
    probs = [math.comb(n, i) * (0.5 ** n) for i in range(n + 1)]
    observed = probs[k]
    # 双侧 p：所有概率不超过观测值的结局之和（加 1e-12 容忍浮点误差）
    return round(min(1.0, sum(pr for pr in probs if pr <= observed + 1e-12)), 6)


def _paired_bootstrap(diffs: Sequence[float], *, resamples: int = 4000,
                      seed: int = 20260921) -> Tuple[float, float]:
    """配对 bootstrap 的 95% 区间：按 **fixture** 重采样，两个策略一起重采。

    配对的意义就在这里：重采样的是「同一局面下两者的差」，不是两个独立样本。
    独立区间重叠与否**不能**用来判断差异是否显著——那正是这份基准之前犯的错。
    """
    n = len(diffs)
    if n == 0:
        return (0.0, 0.0)
    import random as _random
    rng = _random.Random(seed)
    means: List[float] = []
    for _ in range(resamples):
        total = 0.0
        for _ in range(n):
            total += diffs[rng.randrange(n)]
        means.append(total / n)
    means.sort()
    lo = means[max(0, int(0.025 * resamples) - 1)]
    hi = means[min(resamples - 1, int(0.975 * resamples))]
    return (round(lo, 4), round(hi, 4))


def paired_test(planner_wins: Sequence[bool], baseline_wins: Sequence[bool]) -> Dict[str, Any]:
    """同一批 fixture 上的配对比较。

    `b` = planner 赢而基线输的对数，`c` = 基线赢而 planner 输的对数。
    McNemar 只看这两个不一致格：两边都赢/都输的局面不携带「谁更好」的信息。
    """
    if len(planner_wins) != len(baseline_wins):
        raise ValueError(
            f"配对样本长度不一致：planner={len(planner_wins)} baseline={len(baseline_wins)}"
            "（换边时基线也必须打两个座位）")
    n = len(planner_wins)
    b = sum(1 for p, q in zip(planner_wins, baseline_wins) if p and not q)
    c = sum(1 for p, q in zip(planner_wins, baseline_wins) if q and not p)
    both = sum(1 for p, q in zip(planner_wins, baseline_wins) if p and q)
    neither = n - b - c - both
    diffs = [float(p) - float(q) for p, q in zip(planner_wins, baseline_wins)]
    return {
        "pairs": n,
        "planner_only_wins": b,
        "baseline_only_wins": c,
        "both_win": both,
        "both_lose": neither,
        "discordant": b + c,
        "mean_paired_diff": round(statistics.fmean(diffs), 4) if diffs else 0.0,
        "paired_diff_ci95": _paired_bootstrap(diffs),
        "mcnemar_exact_p": _binom_two_sided(b, b + c),
        "significant_at_95": _binom_two_sided(b, b + c) < 0.05,
        "note": "配对检验只用了同一 fixture+座位上的差异；"
                "独立 Wilson 区间重叠与否不能替代它",
    }


DISCLAIMER = (
    "这不是天梯强度。对手是 5 条启发式策略，不是真人；"
    "胜负只在「这套引擎 + 这些对手 + 这串种子」的范围内有意义。"
    "它回答的问题是「多回合规划比一步贪心有没有用」，不是「小芽有多强」。"
)


class PlannerPlayer:
    """把 planner 包成一个可以进 `play_match` 的「策略」。

    `play_match` 只给策略 `(obs, legal, seed, turn)`，而 planner 需要**状态**。
    所以这里持有一局的 state 与 rs，每次决策时用它们跑搜索 ——
    它**不是** `opponents.Strategy`（那个接口只拿 observation 代理，
    是给对手用的，为的是证明对手看不到隐藏信息）。
    planner 是**我方**，看得到自己的完整局面，这是设计上允许的。
    """

    def __init__(self, state, rs, *, depth: int, beam: int, budget_ms: int,
                 side: str = "player"):
        self.state = state
        self.rs = rs
        self.depth = depth
        self.beam = beam
        self.budget_ms = budget_ms
        # **侧别必须传下去。** `plan_actions` 的 `side` 默认是 "player"，
        # 换边那一半如果不告诉它，它会去规划**对手**的动作，
        # 返回的推荐几乎必然不在我方的合法动作集里 → 每次都回落到贪心。
        # 实测症状：换边那一半 182 次决策里有 162 次回落，
        # 于是「换边后的胜负」实际量的是 greedy 基线，不是 planner。
        # 这个 bug 会把整份报告变成假数据，所以下面还加了回落率守卫。
        self.side = side
        self.decisions = 0
        self.timed_out = 0
        self.fallbacks = 0

    def act(self, obs, legal: Sequence[Any], seed: int, turn: int):
        self.decisions += 1
        result = pm.plan_actions(self.state, self.rs, side=self.side,
                                 depth=self.depth, beam=self.beam,
                                 budget_ms=self.budget_ms)
        if result.timed_out:
            self.timed_out += 1
        chosen = result.recommended
        if chosen is None or chosen not in legal:
            # 推荐缺失或不可执行 → 回落到一步贪心；**计数**，不静默。
            self.fallbacks += 1
            chosen = pm.immediate_greedy(self.state, self.rs, side=self.side) or legal[0]
            if chosen not in legal:
                chosen = legal[0]
        return chosen


def to_engine_result(winner: str) -> str:
    """`play_match` 的胜负口径 → 引擎 `state.result` 的口径。

    两条路（自己驱动 / `play_match`）必须产出**同一个口径**，否则汇总处
    会把一半的结果当成「未知」。这是踩过一次的地方，所以单独一个函数，
    并在两边都注明调用它。
    """
    return {"player": "win", "enemy": "loss", "draw": "draw",
            "escaped": "escaped"}.get(winner, "unfinished")


def play_one(rs, team_a: List[str], team_b: List[str], seed: int,
             opponent_strategy: str, *, use_planner: bool,
             depth: int, beam: int, budget_ms: int,
             planner_side: str = "player", fixture_id: Optional[int] = None) -> Dict[str, Any]:
    """打一局：**被测方**用 planner（或 `greedy_damage` 作基线），对手用给定策略。

    `planner_side` 对**两条路都生效**。这是一个基准正确性问题，不是便利参数：
    换边那一半如果只让 planner 换边、基线还坐在 player 侧，那么
    「44/80 vs 18/40」比的就不是同一批座位暴露 —— 一半的样本多暴露了一次先手，
    差值里混进了座位效应，而报告当时把它读成了「规划有用」。

    返回的 `winner` 一律是**被测方视角**（`win` / `loss` / `draw` / `escaped` /
    `unfinished`），所以两个座位、两条路的行可以直接配对。
    """
    side = planner_side if planner_side in ("player", "enemy") else "player"
    other = "enemy" if side == "player" else "player"
    tested = None
    if use_planner:
        state = renv.reset(team_a, team_b, seed=seed, rs=rs)
        tested = PlannerPlayer(state, rs, depth=depth, beam=beam, budget_ms=budget_ms,
                               side=side)
    opponent = ropp.get_strategy(opponent_strategy)
    planner_side_actual = side

    if use_planner:
        # 自己驱动，才能把 state 交给 planner
        state = tested.state
        ropp.bind_ruleset(rs)
        started = time.perf_counter()
        guard = 0
        while not state.result and guard < 2000:
            guard += 1
            if state.phase == "replace":
                queue = renv.needs_replacement(state)
                if not queue:
                    break
                for side in list(queue):
                    legal = renv.legal_actions(state, rs, side)
                    switch = [a for a in legal if a.kind == "switch"]
                    if not switch:
                        continue
                    strategy = tested if side == planner_side_actual else opponent
                    action = strategy.act(renv.observe(state, rs, side), switch, seed, state.turn)
                    renv.step_replace(state, rs, side, int(action.target_index))
                continue
            mine = renv.legal_actions(state, rs, planner_side_actual)
            theirs = renv.legal_actions(state, rs, "enemy" if planner_side_actual == "player" else "player")
            if not mine or not theirs:
                break
            pa = tested.act(renv.observe(state, rs, planner_side_actual), mine, seed, state.turn)
            ea = opponent.act(renv.observe(state, rs, "enemy" if planner_side_actual == "player" else "player"),
                              theirs, seed, state.turn)
            if planner_side_actual == "player":
                renv.step_joint(state, rs, pa, ea)
            else:
                renv.step_joint(state, rs, ea, pa)
        elapsed = time.perf_counter() - started
        winner = state.result or "unfinished"
        if planner_side_actual == "enemy":
            winner = {"win": "loss", "loss": "win"}.get(winner, winner)
        return {"winner": winner, "turns": state.turn, "seconds": round(elapsed, 3),
                "decisions": tested.decisions, "timed_out": tested.timed_out,
                "fallbacks": tested.fallbacks, "seat": planner_side_actual,
                "fixture_id": fixture_id, "seed": seed, "teams": [list(team_a), list(team_b)]}

    # 基线走 `play_match`：strat_a 坐 player 侧、strat_b 坐 enemy 侧。
    # 换到 enemy 侧时**两支策略一起换**，这样基线面对的局面与 planner 完全相同。
    if side == "player":
        strat_a, strat_b = "greedy_damage", opponent_strategy
    else:
        strat_a, strat_b = opponent_strategy, "greedy_damage"
    record = ropp.play_match(rs, team_a, team_b, strat_a, strat_b, seed, turn_limit=300)
    # **口径必须与上面 planner 分支一致。** `play_match` 的 `winner` 用
    # `player` / `enemy` / `draw` / `escaped`（见 `opponents._winner_of`），
    # 而自己驱动那条路拿到的是引擎的 `state.result`（`win` / `loss` / ...）。
    # 第一版没做映射，于是基线在报告里显示「0 胜 0 负」——
    # 一个把「对手赢了」当成未知值的计数，差一点被我读成「基线很弱」。
    winner = to_engine_result(record.winner)
    if side == "enemy":
        # 基线坐 enemy 侧：把胜负换算回**被测方视角**，与 planner 分支同一口径。
        winner = {"win": "loss", "loss": "win"}.get(winner, winner)
    return {"winner": winner, "turns": record.total_turns,
            "seconds": None, "decisions": None, "timed_out": 0, "fallbacks": 0,
            "seat": side, "fixture_id": fixture_id, "seed": seed,
            "teams": [list(team_a), list(team_b)]}


def _summarise_rows(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """一组的胜负汇总。**样本数、阵容、seed、座位必须与配对组一致**，由调用方保证。"""
    games = len(rows)
    wins = sum(1 for r in rows if r["winner"] == "win")
    decisions = sum(r["decisions"] or 0 for r in rows)
    fallbacks = sum(r["fallbacks"] for r in rows)
    seconds = [r["seconds"] for r in rows if r["seconds"] is not None]
    return {
        "games": games,
        "wins": wins,
        "losses": sum(1 for r in rows if r["winner"] == "loss"),
        "draws": sum(1 for r in rows if r["winner"] == "draw"),
        "escaped": sum(1 for r in rows if r["winner"] == "escaped"),
        "unfinished": sum(1 for r in rows if r["winner"] == "unfinished"),
        "win_rate": round(wins / games, 4) if games else None,
        # Wilson 只**描述单方胜率**，不参与任何比较。判差异要用 paired_test。
        "win_rate_ci95": wilson_interval(wins, games) if games else None,
        "mean_turns": round(statistics.fmean(r["turns"] for r in rows), 1) if rows else None,
        "mean_seconds": round(statistics.fmean(seconds), 3) if seconds else None,
        "decisions": decisions,
        "timed_out_decisions": sum(r["timed_out"] for r in rows),
        "fallbacks": fallbacks,
        "fallback_rate": round(fallbacks / decisions, 4) if decisions else 0.0,
        "seats": sorted({r["seat"] for r in rows}),
    }


def run_benchmark(*, games: int, opponents: Sequence[str], depth: int = 2, beam: int = 3,
                  budget_ms: int = 800, swapped: bool = False,
                  skip_baseline: bool = False, seed_base: int = SEED_BASE,
                  progress=None) -> Dict[str, Any]:
    """跑完整基准并返回报告对象。**不写文件**——写盘由 `main` 负责。

    抽出来的理由是测试：测试要能用几局、一个对手在几十秒内跑完整条链路，
    并断言「planner 与基线的 (fixture, 座位) 完全对齐」。如果只能通过 CLI 跑，
    测的就只是「命令有没有报错」。
    """
    rs = rdata.load_ruleset()
    ids = [rs.pets_by_name(n)[0].pet_id for n in ROSTER]
    opponents = [x.strip() for x in opponents if x and x.strip()]

    import random
    rng = random.Random(seed_base)
    fixtures: List[Tuple[List[str], List[str], int]] = []
    for _ in range(games):
        fixtures.append((rng.sample(ids, 3), rng.sample(ids, 3),
                         rng.randrange(1, 10 ** 6)))

    seats = ["player", "enemy"] if swapped else ["player"]
    report: Dict[str, Any] = {
        "generated_by": "scripts/roco/benchmark-planner-matches.py",
        "ruleset_id": rs.ruleset_id,
        "settings": {"games_per_opponent": games, "depth": depth,
                     "beam": beam, "budget_ms": budget_ms,
                     "seed_base": seed_base, "opponents": opponents,
                     "seat_swapped": bool(swapped),
                     "fixtures": len(fixtures),
                     "seats": seats,
                     "note": "换边时 planner 与基线都打两个座位，胜负一律按被测方视角记；"
                             "主比较用同一 (fixture, 座位) 上的配对差，不用 80 对 40 的汇总"},
        "comparison_protocol": [
            "pairing_key = (fixture_id, seat)：两策略的样本数、阵容、seed、座位逐一对齐",
            "主比较 = paired_test：planner_only / baseline_only 的不一致格 + 精确二项（McNemar）",
            "Wilson 区间只描述单方胜率；**区间重叠与否不能替代差异检验**",
            "分层 (opponent × seat) 各自给 games/wins/fallback/timeout，再给总计",
        ],
        "disclaimer": DISCLAIMER,
        "results": {},
    }

    for opponent in opponents:
        started = time.perf_counter()

        def run(use_planner: bool) -> List[Dict[str, Any]]:
            """按 (fixture, 座位) 跑一遍，并给每行打上 fixture_id 与座位。

            fixture 是**配对键**：同一 (fixture_id, seat) 上 planner 与基线的
            两行必须一一对应，配对检验就建立在这个键上。
            """
            rows: List[Dict[str, Any]] = []
            for fixture_id, (a, b, seed) in enumerate(fixtures):
                for seat in seats:
                    row = play_one(rs, a, b, seed, opponent, use_planner=use_planner,
                                   depth=depth, beam=beam,
                                   budget_ms=budget_ms, planner_side=seat,
                                   fixture_id=fixture_id)
                    row["opponent"] = opponent
                    rows.append(row)
            return rows

        planner_rows = run(True)
        entry: Dict[str, Any] = {
            "planner": _summarise_rows(planner_rows),
            "by_seat": {seat: _summarise_rows([r for r in planner_rows if r["seat"] == seat])
                        for seat in seats},
            "seconds": None,
        }
        if not skip_baseline:
            base_rows = run(False)
            planner_keys = {(r["fixture_id"], r["seat"]) for r in planner_rows}
            base_keys = {(r["fixture_id"], r["seat"]) for r in base_rows}
            if planner_keys != base_keys:
                missing = sorted(planner_keys - base_keys)[:3]
                extra = sorted(base_keys - planner_keys)[:3]
                raise RuntimeError(
                    "配对样本不对齐：planner 与基线必须打完全相同的 (fixture, 座位)。"
                    f"planner={len(planner_rows)} 行 / 基线={len(base_rows)} 行；"
                    f"基线缺少 {missing}，多出 {extra}")
            entry["greedy_baseline"] = _summarise_rows(base_rows)
            entry["greedy_baseline_by_seat"] = {
                seat: _summarise_rows([r for r in base_rows if r["seat"] == seat]) for seat in seats}
            entry["paired"] = paired_test(
                [r["winner"] == "win" for r in planner_rows],
                [r["winner"] == "win" for r in base_rows])
            entry["paired_by_seat"] = {
                seat: paired_test(
                    [r["winner"] == "win" for r in planner_rows if r["seat"] == seat],
                    [r["winner"] == "win" for r in base_rows if r["seat"] == seat])
                for seat in seats}
            entry["delta_win_rate"] = entry["paired"]["mean_paired_diff"]
            entry["delta_win_rate_basis"] = "paired:同一 (fixture, 座位) 上的平均胜率差"
        entry["seconds"] = round(time.perf_counter() - started, 1)
        planner = entry["planner"]
        rate = planner["fallback_rate"]
        if rate > 0.25:
            planner["warning"] = (
                f"回落率 {rate:.1%} 过高；这些胜负主要来自回落的贪心基线，不是 planner。"
            )
            if progress:
                progress(f"[{opponent}] **警告**：回落率 {rate:.1%}"
                         f"（{planner['fallbacks']}/{planner['decisions']}）—— "
                         f"planner 基本没有在决策，这份数据不能当作「planner 的胜负」。")
        report["results"][opponent] = entry
        if progress:
            base = entry.get("greedy_baseline")
            paired = entry.get("paired")
            progress(f"[{opponent}] planner {planner['wins']}/{planner['games']}"
                     + (f"  基线 {base['wins']}/{base['games']}" if base else "")
                     + (f"  配对差 {paired['mean_paired_diff']:+.3f}"
                        f" (b={paired['planner_only_wins']}, c={paired['baseline_only_wins']},"
                        f" p={paired['mcnemar_exact_p']})" if paired else "")
                     + f"  ({entry['seconds']}s)")
    return report


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="planner 的整局胜负基准")
    parser.add_argument("--games", type=int, default=60, help="每个对手打几局")
    parser.add_argument("--depth", type=int, default=2)
    parser.add_argument("--beam", type=int, default=3)
    parser.add_argument("--budget-ms", type=int, default=800)
    parser.add_argument("--opponents", default="greedy_damage,shallow_search,status_control")
    parser.add_argument("--skip-baseline", action="store_true",
                        help="跳过 greedy 基线（省时间；默认**不**跳过）。"
                             "注意：跳过之后**没有**可解释的比较，"
                             "报告里会写明这一点")
    parser.add_argument("--swapped", action="store_true",
                        help="planner **与基线**都再坐 enemy 侧打一遍，"
                             "用来排除「先手优势」被误读成「规划有效」")
    args = parser.parse_args(argv)

    report = run_benchmark(games=args.games,
                           opponents=[x.strip() for x in args.opponents.split(",")],
                           depth=args.depth, beam=args.beam, budget_ms=args.budget_ms,
                           swapped=args.swapped, skip_baseline=args.skip_baseline,
                           progress=lambda msg: print(msg, flush=True))
    # `--skip-baseline` 时报告仍要能被解释：明确标出「这次没有基线」。
    if args.skip_baseline:
        report["settings"]["comparable"] = False
        report["settings"]["why_not_comparable"] = (
            "跳过了 greedy 基线：只有被测方一侧的数据，任何「规划有没有用」的说法都不成立")

    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"wrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
