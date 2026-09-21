#!/usr/bin/env python3
"""planner 自报的 `expected` 与真实胜负有没有关系？

为什么要问这个：`expected` / `worst` 是规划回执里最像「信心」的两个数，
很容易被上层（页面、工具、模型）当成「这一手好不好」的代理。
如果它其实与胜负无关，那就不该被那样用 —— 而且必须有人量过才知道。

口径：开局时 `plan_actions` 报的 `expected`，与那一局最终的胜负。
分两组比均值。**样本小的时候差值就是噪声**，所以默认跑 80 局并在报告里给区间。

跑法::

    python3 scripts/roco/check-planner-calibration.py --games 80
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import planner as pm          # noqa: E402

ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]


def play(rs, state, seed, opponent: str, depth: int, beam: int, budget_ms: int) -> str:
    player = _Player(state, rs, depth=depth, beam=beam, budget_ms=budget_ms)
    enemy = ropp.get_strategy(opponent)
    ropp.bind_ruleset(rs)
    guard = 0
    while not state.result and guard < 1000:
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
                strategy = player if side == "player" else enemy
                action = strategy.act(renv.observe(state, rs, side), switch, seed, state.turn)
                renv.step_replace(state, rs, side, int(action.target_index))
            continue
        mine = renv.legal_actions(state, rs, "player")
        theirs = renv.legal_actions(state, rs, "enemy")
        if not mine or not theirs:
            break
        pa = player.act(renv.observe(state, rs, "player"), mine, seed, state.turn)
        ea = enemy.act(renv.observe(state, rs, "enemy"), theirs, seed, state.turn)
        renv.step_joint(state, rs, pa, ea)
    return state.result or "unfinished"


class _Player:
    def __init__(self, state, rs, *, depth, beam, budget_ms):
        self.state, self.rs = state, rs
        self.depth, self.beam, self.budget_ms = depth, beam, budget_ms

    def act(self, obs, legal, seed, turn):
        result = pm.plan_actions(self.state, self.rs, side="player",
                                 depth=self.depth, beam=self.beam, budget_ms=self.budget_ms)
        chosen = result.recommended
        if chosen is None or chosen not in legal:
            chosen = pm.immediate_greedy(self.state, self.rs, side="player") or legal[0]
        return chosen


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="expected 与胜负的关系")
    parser.add_argument("--games", type=int, default=80)
    parser.add_argument("--opponent", default="status_control")
    parser.add_argument("--depth", type=int, default=2)
    parser.add_argument("--beam", type=int, default=3)
    parser.add_argument("--budget-ms", type=int, default=800)
    parser.add_argument("--out", default=None,
                        help="输出路径；默认写入库的 reports/roco/…。测试用临时路径，避免把入库的完整报告覆盖成小样本")
    parser.add_argument("--seed-base", type=int, default=700000)
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    ids = [rs.pets_by_name(n)[0].pet_id for n in ROSTER]
    rng = random.Random(args.seed_base)
    rows: List[Dict[str, Any]] = []
    for _ in range(args.games):
        a, b = rng.sample(ids, 3), rng.sample(ids, 3)
        seed = rng.randrange(1, 10 ** 6)
        state = renv.reset(a, b, seed=seed, rs=rs)
        opening = pm.plan_actions(state, rs, depth=args.depth, beam=args.beam,
                                  budget_ms=args.budget_ms)
        outcome = play(rs, state, seed, args.opponent, args.depth, args.beam, args.budget_ms)
        rows.append({"expected": opening.expected, "worst": opening.worst,
                     "label": opening.recommended_label, "result": outcome})

    wins = [r for r in rows if r["result"] == "win"]
    others = [r for r in rows if r["result"] != "win"]

    def mean(xs, key):
        vals = [x[key] for x in xs]
        return statistics.fmean(vals) if vals else None

    def ci95(vals):
        if len(vals) < 2:
            return None
        sd = statistics.stdev(vals)
        half = 1.96 * sd / math.sqrt(len(vals))
        return [round(statistics.fmean(vals) - half, 4), round(statistics.fmean(vals) + half, 4)]

    summary = {
        "games": len(rows),
        "wins": len(wins),
        "non_wins": len(others),
        "expected_when_win": round(mean(wins, "expected"), 4) if wins else None,
        "expected_when_not_win": round(mean(others, "expected"), 4) if others else None,
        "expected_ci95_win": ci95([r["expected"] for r in wins]),
        "expected_ci95_not_win": ci95([r["expected"] for r in others]),
        "worst_when_win": round(mean(wins, "worst"), 4) if wins else None,
        "worst_when_not_win": round(mean(others, "worst"), 4) if others else None,
    }
    # 差值必须**带上显著性**。只看均值差会把噪声读成结论：
    # 第一版（30 局）差值是 -0.130（即「赢的那些局 expected 反而更低」），
    # 80 局时又变成 +0.110 —— 两次都远未达到显著水平。
    win_vals = [r["expected"] for r in wins]
    other_vals = [r["expected"] for r in others]
    if len(win_vals) > 1 and len(other_vals) > 1:
        diff = statistics.fmean(win_vals) - statistics.fmean(other_vals)
        se = math.sqrt(statistics.variance(win_vals) / len(win_vals)
                       + statistics.variance(other_vals) / len(other_vals))
        t = diff / se if se > 0 else 0.0
        summary["difference"] = round(diff, 4)
        summary["welch_t"] = round(t, 3)
        summary["significant_at_95"] = abs(t) >= 1.96
        summary["verdict"] = (
            "胜局的 expected 显著更高 —— 可能可以当信心代理，但需要更多样本确认"
            if abs(t) >= 1.96 else
            "**不显著**：|t| < 1.96，差异与「没有差异」无法区分。"
            "在这一口径下 expected **不能**当作「这一手好不好」的信心代理。"
        )

    payload = {
        "generated_by": "scripts/roco/check-planner-calibration.py",
        "ruleset_id": rs.ruleset_id,
        "settings": {"games": args.games, "opponent": args.opponent, "depth": args.depth,
                     "beam": args.beam, "budget_ms": args.budget_ms},
        "question": ("plan_actions 自报的 expected 能不能当作「这一手好不好」的代理？"
                     "判据：胜局的 expected 是否显著高于非胜局。"),
        "summary": summary,
        "rows": rows,
        "caveats": [
            "开局一次 expected 对整局胜负，是**很粗**的口径：一局要打十几个回合。",
            "样本小的时候差值就是噪声，所以同时给 95% 区间。",
            "结论只在「这套引擎 + 这个对手 + 这串种子」范围内成立。",
        ],
    }
    # 同 `benchmark-planner.py`：`--out` 给测试用，入库那份是完整样本。
    out = args.out or os.path.join(_ROOT, "reports", "roco", "planner-calibration.json")
    if not os.path.isabs(out):
        out = os.path.join(_ROOT, out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {os.path.relpath(out, _ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
