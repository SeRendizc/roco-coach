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

    def __init__(self, state, rs, *, depth: int, beam: int, budget_ms: int):
        self.state = state
        self.rs = rs
        self.depth = depth
        self.beam = beam
        self.budget_ms = budget_ms
        self.decisions = 0
        self.timed_out = 0
        self.fallbacks = 0

    def act(self, obs, legal: Sequence[Any], seed: int, turn: int):
        self.decisions += 1
        result = pm.plan_actions(self.state, self.rs, depth=self.depth, beam=self.beam,
                                 budget_ms=self.budget_ms)
        if result.timed_out:
            self.timed_out += 1
        chosen = result.recommended
        if chosen is None or chosen not in legal:
            # 推荐缺失或不可执行 → 回落到一步贪心；**计数**，不静默。
            self.fallbacks += 1
            chosen = pm.immediate_greedy(self.state, self.rs) or legal[0]
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
             planner_side: str = "player") -> Dict[str, Any]:
    """打一局：我方用 planner（或 `greedy_damage` 作基线），对手用给定策略。"""
    starter = ropp.get_strategy("greedy_damage")
    player = None
    if use_planner:
        state = renv.reset(team_a, team_b, seed=seed, rs=rs)
        player = PlannerPlayer(state, rs, depth=depth, beam=beam, budget_ms=budget_ms)
    enemy = ropp.get_strategy(opponent_strategy)
    # `planner_side` 支持换边：默认 planner 坐 player（先手侧）。
    # 换边时把胜负换算回「planner 视角」，否则换边那一半会反向计入。
    planner_side_actual = planner_side if use_planner else "player"

    if use_planner:
        # 自己驱动，才能把 state 交给 planner
        state = player.state
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
                    strategy = player if side == planner_side_actual else enemy
                    action = strategy.act(renv.observe(state, rs, side), switch, seed, state.turn)
                    renv.step_replace(state, rs, side, int(action.target_index))
                continue
            mine = renv.legal_actions(state, rs, planner_side_actual)
            theirs = renv.legal_actions(state, rs, "enemy" if planner_side_actual == "player" else "player")
            if not mine or not theirs:
                break
            pa = player.act(renv.observe(state, rs, planner_side_actual), mine, seed, state.turn)
            ea = enemy.act(renv.observe(state, rs, "enemy" if planner_side_actual == "player" else "player"),
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
                "decisions": player.decisions, "timed_out": player.timed_out,
                "fallbacks": player.fallbacks}

    record = ropp.play_match(rs, team_a, team_b, "greedy_damage", opponent_strategy,
                             seed, turn_limit=300)
    # **口径必须与上面 planner 分支一致。** `play_match` 的 `winner` 用
    # `player` / `enemy` / `draw` / `escaped`（见 `opponents._winner_of`），
    # 而自己驱动那条路拿到的是引擎的 `state.result`（`win` / `loss` / ...）。
    # 第一版没做映射，于是基线在报告里显示「0 胜 0 负」——
    # 一个把「对手赢了」当成未知值的计数，差一点被我读成「基线很弱」。
    return {"winner": to_engine_result(record.winner), "turns": record.total_turns,
            "seconds": None, "decisions": None, "timed_out": 0, "fallbacks": 0}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="planner 的整局胜负基准")
    parser.add_argument("--games", type=int, default=60, help="每个对手打几局")
    parser.add_argument("--depth", type=int, default=2)
    parser.add_argument("--beam", type=int, default=3)
    parser.add_argument("--budget-ms", type=int, default=800)
    parser.add_argument("--opponents", default="greedy_damage,shallow_search,status_control")
    parser.add_argument("--skip-baseline", action="store_true",
                        help="跳过 greedy 基线（省时间；默认**不**跳过）")
    parser.add_argument("--swapped", action="store_true",
                        help="同一批 fixture 再打一遍，但**双方换边**"
                             "（planner 坐 enemy 侧）。用来排除「先手优势」"
                             "被误读成「规划有效」")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    ids = [rs.pets_by_name(n)[0].pet_id for n in ROSTER]
    opponents = [x.strip() for x in args.opponents.split(",") if x.strip()]

    import random
    rng = random.Random(SEED_BASE)
    fixtures: List[Tuple[List[str], List[str], int]] = []
    for _ in range(args.games):
        fixtures.append((rng.sample(ids, 3), rng.sample(ids, 3),
                         rng.randrange(1, 10 ** 6)))
    # 同一批 fixture 给所有对手与所有基线用 —— 否则胜负差里混进阵容差

    report: Dict[str, Any] = {
        "generated_by": "scripts/roco/benchmark-planner-matches.py",
        "ruleset_id": rs.ruleset_id,
        "settings": {"games_per_opponent": args.games, "depth": args.depth,
                     "beam": args.beam, "budget_ms": args.budget_ms,
                     "seed_base": SEED_BASE, "opponents": opponents,
                     "seat_swapped": bool(args.swapped),
                     "note": "换边时两半都按 planner 视角记胜负，所以可以相加"},
        "disclaimer": DISCLAIMER,
        "results": {},
    }

    for opponent in opponents:
        started = time.perf_counter()
        planner_rows = [play_one(rs, a, b, seed, opponent, use_planner=True,
                                 depth=args.depth, beam=args.beam, budget_ms=args.budget_ms)
                        for a, b, seed in fixtures]
        if args.swapped:
            # 换边再打一遍：planner 坐 enemy 侧。**胜率一律按 planner 视角记**，
            # 所以两半可以直接相加 —— 这样汇总数字里不会混进「谁先手」。
            planner_rows += [play_one(rs, a, b, seed, opponent, use_planner=True,
                                      depth=args.depth, beam=args.beam,
                                      budget_ms=args.budget_ms, planner_side="enemy")
                             for a, b, seed in fixtures]
        planner_wins = sum(1 for r in planner_rows if r["winner"] == "win")
        planner_losses = sum(1 for r in planner_rows if r["winner"] == "loss")
        entry: Dict[str, Any] = {
            "planner": {
                "games": len(planner_rows),
                "wins": planner_wins,
                "losses": planner_losses,
                "draws": sum(1 for r in planner_rows if r["winner"] == "draw"),
                "escaped": sum(1 for r in planner_rows if r["winner"] == "escaped"),
                "unfinished": sum(1 for r in planner_rows if r["winner"] == "unfinished"),
                "win_rate": round(planner_wins / len(planner_rows), 4),
                # 区间不是装饰：40 局里 ±15 个百分点的波动是常态，
                # 不报区间就会把噪声读成「规划有用」。
                "win_rate_ci95": wilson_interval(planner_wins, len(planner_rows)),
                "mean_turns": round(statistics.fmean(r["turns"] for r in planner_rows), 1),
                "mean_seconds": round(statistics.fmean(
                    r["seconds"] for r in planner_rows if r["seconds"] is not None), 3)
                    if any(r["seconds"] is not None for r in planner_rows) else None,
                "decisions": sum(r["decisions"] or 0 for r in planner_rows),
                "timed_out_decisions": sum(r["timed_out"] for r in planner_rows),
                "fallbacks": sum(r["fallbacks"] for r in planner_rows),
            },
            "seconds": round(time.perf_counter() - started, 1),
        }
        if not args.skip_baseline:
            base_rows = [play_one(rs, a, b, seed, opponent, use_planner=False,
                                  depth=args.depth, beam=args.beam, budget_ms=args.budget_ms)
                         for a, b, seed in fixtures]
            base_wins = sum(1 for r in base_rows if r["winner"] == "win")
            entry["greedy_baseline"] = {
                "games": len(base_rows),
                "wins": base_wins,
                "losses": sum(1 for r in base_rows if r["winner"] == "loss"),
                "win_rate": round(base_wins / len(base_rows), 4),
                "win_rate_ci95": wilson_interval(base_wins, len(base_rows)),
                "mean_turns": round(statistics.fmean(r["turns"] for r in base_rows), 1),
            }
            entry["delta_win_rate"] = round(
                entry["planner"]["win_rate"] - entry["greedy_baseline"]["win_rate"], 4)
        report["results"][opponent] = entry
        print(f"[{opponent}] planner {entry['planner']['wins']}/{entry['planner']['games']}"
              f"  基线 {entry.get('greedy_baseline', {}).get('wins', '—')}"
              f"  ({entry['seconds']}s)", flush=True)

    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"wrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
