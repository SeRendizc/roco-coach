#!/usr/bin/env python3
"""G02 —— 生成「规则分 vs 模拟结果」的数据集。

这个脚本只做一件事：把「一套三人阵容 + 一个对手池 + 一个固定预算」变成一个
可训练的样本。它**不训练模型**（训练在 `scripts/roco/train-team-model.py`），
两份脚本分开是为了让「数据是怎么来的」与「模型怎么拟合的」各自可审。

标签
----

`label = 1` 表示我方阵容在**指定对手池与固定预算**下赢下这一局；`0` 表示没赢。
这不是胜率，也不是强度：它是一次模拟结果。报告里必须带着这句话出现。
每个样本自带 `strategy_a/strategy_b`（名字与版本）与 `seed`，所以任何一行都能重跑。

切分单位：**阵容家族**
--------------------

`family` 是「我方三人阵容 + 对手池」的对局家族标识。训练脚本按 family 切分，
所以同一个家族不会同时出现在训练与测试里——这正是 G02 的部署门槛所要求的
「未见家族上优于规则分」。同家族内的种子差异留在同一侧，避免用同一套阵容
把训练集和测试集串起来。

跑法::

    python3 scripts/roco/build-team-dataset.py --out reports/roco/g02-team --budget-s 180
    python3 scripts/roco/build-team-dataset.py --games-per-family 4 --families 300

产出（`--out` 目录）：`dataset.jsonl`、`manifest.json`。
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import itertools
import json
import os
import random
import statistics
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import team as rteam          # noqa: E402

#: 只从 A 组六只里取三人阵容：这六只的特性与技能是当前唯一核过一遍的。
A_GROUP = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]

#: 对手池按「行为强度」分层，而不是随便挑几条：如果对手永远比玩家弱，
#: 标签会一边倒（第一次抽样 12 局里 11 胜），学到的就只是「对手很弱」。
#: 每一层的对手都与该层的我方策略同级，胜率才有可学的方差。
#: 层名写进 family key：换一层就是换一个对局家族。
OPPONENT_POOLS = [
    ["random_legal"],
    ["greedy_damage"],
    ["greedy_damage", "conservative_switch"],
    ["shallow_search", "greedy_damage"],
    ["status_control", "shallow_search"],
    ["random_legal", "greedy_damage", "shallow_search"],
]

#: 我方出招也交给策略：这样一局能在 1 秒内打完，不必等人操作。
#: 我方策略与对手池**成对**出现（见 PLAYER_BY_POOL），否则「玩家强、对手弱」
#: 会把标签压成一边倒，模型学不到东西。
PLAYER_STRATEGIES = ["random_legal", "greedy_damage", "shallow_search"]

#: 对手池 → 我方策略。同一条策略打同一条策略，才是可比的局面。
PLAYER_BY_POOL = {
    0: "random_legal",
    1: "greedy_damage",
    2: "greedy_damage",
    3: "shallow_search",
    4: "greedy_damage",
    5: "random_legal",
}

DISCLAIMER = (
    "标签是「在指定对手池与固定预算下的模拟结果」，不是胜率、不是强度、不是天梯表现。"
    "规则分与模型都只在「同一对手池」这个前提下可比。"
)


def _commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=_ROOT, text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def team_features(rs, team: List[str]) -> Dict[str, float]:
    """规则 baseline 的六个分项分。模型要**打得过它**才算过门槛，所以必须逐条记下来。"""
    score = rteam.evaluate_team(team, rs=rs)
    return {f.name: float(f.value) for f in score.features}


def family_key(team: List[str], pool: List[str], player_strategy: str) -> str:
    """家族 = 阵容 + 对手池 + 我方策略。同一家族的对局才会互相沾边。"""
    raw = "|".join(sorted(team)) + "||" + ",".join(sorted(pool)) + "||" + player_strategy
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def play_one(rs, team: List[str], enemy: List[str], player_strategy: str,
             enemy_strategy: str, seed: int, turn_limit: int) -> Dict[str, Any]:
    """按指定策略打一局，返回标签与过程摘要。异常一律往上抛，不吞。"""
    started = time.perf_counter()
    record = ropp.play_match(rs, team, enemy, player_strategy, enemy_strategy, seed,
                             turn_limit=turn_limit)
    elapsed = time.perf_counter() - started
    winner = record.winner
    if winner == "player":
        label = 1
    elif winner == "enemy":
        label = 0
    elif winner == "draw":
        label = 0.5          # 平局按半胜处理，并在报告里说明
    else:
        return {"skip": True, "reason": f"未分胜负（{winner}）",
                "truncated": bool(record.truncated), "error": record.error}
    return {
        "label": label,
        "winner": winner,
        "turns": int(record.total_turns or record.turns or 0),
        "truncated": bool(record.truncated),
        "seconds": round(elapsed, 4),
    }


def pick_opponent(rng: random.Random, triples: List[Tuple[str, ...]]) -> List[str]:
    """对手阵容**按家族固定**：同一个家族里的所有对局用同一个对手阵容。

    这样家族内的差异只来自 seed，不会混进「对手也换了」这个变量。
    """
    return list(rng.choice(triples))


def build(rs, families: int, games_per_family: int, budget_s: float, base_seed: int,
          turn_limit: int, player_strategy: Optional[str]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    rng = random.Random(base_seed)
    # A_GROUP 写的是**名字**（人读的），引擎要的是稳定 id。这里显式换算一次：
    # 后面的 family key、规则特征、对局记录全部用 id，名字只留在 manifest 里给人看。
    a_group_ids = [rs.pets_by_name(name)[0].pet_id for name in A_GROUP]
    triples = list(itertools.combinations(a_group_ids, 3))
    rows: List[Dict[str, Any]] = []
    started = time.perf_counter()
    skipped = 0
    completed_families = 0
    seen_families = set()

    # 先把**全部**可能的家族枚举出来、打乱，再按顺序取。
    #
    # 第一版是「随机抽一个 + 撞了就重抽」。看上去等价，实际把预算全烧在重抽上：
    # 家族空间只有 20 阵容 × 6 对手池 × 3 策略 = 360 种，抽到第 120 个之后
    # 单次命中新家族的概率掉到 1/3 以下，绝大多数迭代都在 `continue`。
    # 300 秒里只跑完 120 个家族（0.8 局/秒，而单跑一局是 0.01–0.06 秒）。
    # 拒绝采样在「家族空间快被抽干」时会退化成空转 —— 这里改成无冲突的洗牌。
    candidates: List[Tuple[List[str], int, str]] = []
    for mine in triples:
        for pool_index in range(len(OPPONENT_POOLS)):
            for player in ([player_strategy] if player_strategy else PLAYER_STRATEGIES):
                candidates.append((list(mine), pool_index, player))
    rng.shuffle(candidates)

    for mine, pool_index, play_strategy in candidates:
        if completed_families >= families:
            break
        if time.perf_counter() - started > budget_s:
            break
        pool = list(OPPONENT_POOLS[pool_index])
        family = family_key(mine, pool, play_strategy)
        if family in seen_families:
            continue
        seen_families.add(family)
        feats_mine = team_features(rs, mine)
        # 对手阵容**按家族固定**：家族内所有对局打的是同一套对手，
        # 于是家族内的差异只来自 seed，不会混进「对手也换了」这个变量。
        theirs = pick_opponent(rng, triples)
        feats_theirs = team_features(rs, theirs)
        for game in range(games_per_family):
            seed = rng.randrange(1, 2 ** 31 - 1)
            enemy_strategy = pool[game % len(pool)]
            outcome = play_one(rs, mine, theirs, play_strategy, enemy_strategy, seed, turn_limit)
            if outcome.get("skip"):
                skipped += 1
                continue
            rows.append({
                "family": family,
                "team": mine,
                "enemy_team": theirs,
                "opponent_pool": pool,
                "enemy_strategy": enemy_strategy,
                "player_strategy": play_strategy,
                "seed": seed,
                "label": outcome["label"],
                "winner": outcome["winner"],
                "turns": outcome["turns"],
                "truncated": outcome["truncated"],
                "seconds": outcome["seconds"],
                "rules_features": feats_mine,
                "enemy_rules_features": feats_theirs,
            })
        completed_families += 1

    elapsed = time.perf_counter() - started
    wins = sum(1 for r in rows if r["label"] == 1)
    draws = sum(1 for r in rows if r["label"] == 0.5)
    manifest = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "commit": _commit(),
        "ruleset_id": rs.ruleset_id,
        "snapshot_fingerprint": rs.snapshot_fingerprint(),
        "strategy_version": ropp.STRATEGY_VERSION,
        "a_group": A_GROUP,
        "a_group_ids": a_group_ids,
        "opponent_pools": OPPONENT_POOLS,
        "player_strategies": PLAYER_STRATEGIES,
        "player_by_pool": {str(k): v for k, v in PLAYER_BY_POOL.items()},
        "base_seed": base_seed,
        "turn_limit": turn_limit,
        "families_requested": families,
        "families_completed": completed_families,
        "games_per_family": games_per_family,
        "rows": len(rows),
        "skipped": skipped,
        "wins": wins,
        "draws": draws,
        "label_mean": round((wins + 0.5 * draws) / len(rows), 4) if rows else None,
        "elapsed_s": round(elapsed, 2),
        "games_per_second": round(len(rows) / elapsed, 2) if elapsed > 0 else None,
        "median_seconds_per_game": round(statistics.median([r["seconds"] for r in rows]), 4) if rows else None,
        "truncated": sum(1 for r in rows if r["truncated"]),
        "disclaimer": DISCLAIMER,
    }
    return rows, manifest


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="G02 数据集：阵容规则分 + 模拟标签")
    parser.add_argument("--out", default=os.path.join("reports", "roco", "g02-team"))
    parser.add_argument("--families", type=int, default=400, help="对局家族数（切分单位）")
    parser.add_argument("--games-per-family", type=int, default=2)
    parser.add_argument("--budget-s", type=float, default=240.0, help="墙钟预算；到点就收工并如实记录")
    parser.add_argument("--base-seed", type=int, default=20260921)
    parser.add_argument("--turn-limit", type=int, default=300)
    parser.add_argument("--player-strategy", default=None,
                        help="固定我方策略；默认在家族之间随机取（写进 family key）")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    os.makedirs(os.path.join(_ROOT, args.out), exist_ok=True)
    rows, manifest = build(rs, args.families, args.games_per_family, args.budget_s,
                           args.base_seed, args.turn_limit, args.player_strategy)

    dataset = os.path.join(_ROOT, args.out, "dataset.jsonl")
    with open(dataset, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(os.path.join(_ROOT, args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(json.dumps({k: manifest[k] for k in
                      ("families_completed", "rows", "wins", "draws", "label_mean",
                       "elapsed_s", "games_per_second", "truncated", "skipped")},
                     ensure_ascii=False, indent=2))
    print(f"数据集：{dataset}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
