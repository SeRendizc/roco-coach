#!/usr/bin/env python3
"""W3-03 —— 生成 1 万场以上轨迹，供后续（W4/W5）离线使用。

与 `run_pilot.py`（1,000 场环境自检）和 G02 数据集（带标签的训练样本）不同，
这里的目标是**轨迹规模**：固定 train/val/test 家族切分之后，按需要生成。

三条纪律
--------

1. **先切分，再生成。** 家族在生成之前就按 `family_split` 定好落在哪一侧，
   生成时按侧写入，避免「先跑完再切」时把同一家族的两半算进不同集合。
2. **吞吐决定上限。** 按实测吞吐与墙钟预算决定生成多少，如实记录；
   不为了凑数字而把 `turn_limit` 调小（那会改变标签分布）。
3. **轨迹是过渡样本，不是结论。** 每条 transition 是
   `(公开观察哈希, 双方动作, 结果, 策略名+版本, seed, 家族, 侧)`；
   它**不**包含私有状态（对手后备血量、真实 seed 之外的内部字段），
   因为后续要用它训练的东西不该看到隐藏信息。

跑法::

    python3 scripts/roco/build-trajectories.py --games 10000 --budget-s 900
    python3 scripts/roco/build-trajectories.py --games 200 --budget-s 60   # 自检
"""

from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import json
import os
import random
import statistics
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402

ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]

STRATEGIES = ["random_legal", "greedy_damage", "conservative_switch",
              "status_control", "shallow_search"]

#: 家族切分比例（训练/验证/测试）。固定值，写进 manifest。
SPLIT = {"train": 0.6, "val": 0.2, "test": 0.2}
SPLIT_SEED = 20260921
DEFAULT_OUT = os.path.join("reports", "roco", "trajectories")


def family_of(team_a: List[str], team_b: List[str], strat_a: str, strat_b: str) -> str:
    """家族的键：双方阵容 + 双方策略。切分单位就是它。"""
    raw = "|".join(sorted(team_a)) + "||" + "|".join(sorted(team_b)) + "||" + strat_a + "|" + strat_b
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def side_of(family: str, seed: int, fractions: Dict[str, float]) -> str:
    """家族 → 落在哪一侧。用 family 的哈希 + 固定种子，**先定后生成**。"""
    digest = hashlib.sha256(f"{seed}:{family}".encode("utf-8")).hexdigest()
    share = int(digest[:8], 16) / 0xFFFFFFFF
    if share < fractions["train"]:
        return "train"
    if share < fractions["train"] + fractions["val"]:
        return "val"
    return "test"


def observe_public(state, rs) -> Dict[str, Any]:
    """公开观察：用引擎自己的裁剪函数，不另写一份（另写一份就会漂）。"""
    return renv.public_planner_state(state, rs, "player")


def build(rs, games: int, budget_s: float, base_seed: int, turn_limit: int,
          out_dir: str) -> Dict[str, Any]:
    rng = random.Random(base_seed)
    roster_ids = [rs.pets_by_name(n)[0].pet_id for n in ROSTER]
    started = time.perf_counter()

    paths = {name: os.path.join(out_dir, f"transitions-{name}.jsonl") for name in SPLIT}
    handles = {name: open(path, "w", encoding="utf-8") for name, path in paths.items()}
    counts = collections.Counter()
    families = {name: set() for name in SPLIT}
    played = 0
    truncated = 0
    errors = 0
    turn_samples: List[int] = []
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

    try:
        while played < games:
            if time.perf_counter() - started > budget_s:
                break
            team_a = rng.sample(roster_ids, 3)
            team_b = rng.sample(roster_ids, 3)
            strat_a = rng.choice(STRATEGIES)
            strat_b = rng.choice(STRATEGIES)
            family = family_of(team_a, team_b, strat_a, strat_b)
            split = side_of(family, base_seed, SPLIT)
            seed = rng.randrange(1, 2 ** 31 - 1)

            # 自己驱动一局，逐步写 transition：这样每一步都能落盘，
            # 且只写公开观察（不写 state.events 里的内部细节）。
            transport = handles[split]
            try:
                state = renv.reset(team_a, team_b, seed=seed, rs=rs)
                ropp.bind_ruleset(rs)
                a = ropp.get_strategy(strat_a)
                b = ropp.get_strategy(strat_b)
                steps = 0
                while not state.result and state.turn <= turn_limit:
                    steps += 1
                    if steps > turn_limit * 4 + 50:
                        break
                    if state.phase == "replace":
                        for side_name, strategy in (("player", a), ("enemy", b)):
                            queue = renv.needs_replacement(state)
                            if side_name not in queue:
                                continue
                            legal = renv.legal_actions(state, rs, side_name)
                            switch = [x for x in legal if x.kind == "switch"]
                            if not switch:
                                continue
                            action = strategy.act(renv.observe(state, rs, side_name), switch, seed, state.turn)
                            transport.write(json.dumps({
                                "kind": "replace", "split": split, "family": family,
                                "seed": seed, "turn": state.turn, "side": side_name,
                                "action": action.to_dict(),
                                "public_hash": hashlib.sha256(
                                    json.dumps(observe_public(state, rs), sort_keys=True,
                                               ensure_ascii=False).encode("utf-8")).hexdigest()[:16],
                                "strategy": {"player": strat_a, "enemy": strat_b},
                            }, ensure_ascii=False) + "\n")
                            counts[split] += 1
                            renv.step_replace(state, rs, side_name, int(action.target_index))
                        continue

                    obs_public = observe_public(state, rs)
                    public_hash = hashlib.sha256(
                        json.dumps(obs_public, sort_keys=True, ensure_ascii=False).encode("utf-8")
                    ).hexdigest()[:16]
                    legal_p = renv.legal_actions(state, rs, "player")
                    legal_e = renv.legal_actions(state, rs, "enemy")
                    if not legal_p or not legal_e:
                        break
                    act_p = a.act(renv.observe(state, rs, "player"), legal_p, seed, state.turn)
                    act_e = b.act(renv.observe(state, rs, "enemy"), legal_e, seed, state.turn)
                    transport.write(json.dumps({
                        "kind": "joint", "split": split, "family": family,
                        "seed": seed, "turn": state.turn,
                        "public_hash": public_hash,
                        "actions": {"player": act_p.to_dict(), "enemy": act_e.to_dict()},
                        "legal_counts": {"player": len(legal_p), "enemy": len(legal_e)},
                        "strategy": {"player": strat_a, "enemy": strat_b},
                        "opponent_model": "heuristic-strategy",
                    }, ensure_ascii=False) + "\n")
                    counts[split] += 1
                    renv.step_joint(state, rs, act_p, act_e)

                played += 1
                families[split].add(family)
                turn_samples.append(int(state.result and state.turn or state.turn))
                if state.turn > turn_limit:
                    truncated += 1
                # 结局单独记一条：它是候选模型要预测的标签
                transport.write(json.dumps({
                    "kind": "outcome", "split": split, "family": family,
                    "seed": seed, "result": state.result, "turns": state.turn,
                    "teams": {"player": team_a, "enemy": team_b},
                    "strategy": {"player": strat_a, "enemy": strat_b},
                    "note": "标签是**指定策略对局**的模拟结果，不是胜率、不是天梯强度。",
                }, ensure_ascii=False) + "\n")
                counts[split] += 1
            except Exception as exc:  # noqa: BLE001 —— 单局失败不该中断整批，但要计数
                errors += 1
                transport.write(json.dumps({
                    "kind": "error", "split": split, "family": family, "seed": seed,
                    "error": f"{type(exc).__name__}: {exc}",
                }, ensure_ascii=False) + "\n")
    finally:
        for handle in handles.values():
            handle.close()

    elapsed = time.perf_counter() - started
    manifest = {
        "generated_at": started_at,
        "generated_by": "scripts/roco/build-trajectories.py",
        "ruleset_id": rs.ruleset_id,
        "snapshot_fingerprint": rs.snapshot_fingerprint(),
        "roster": ROSTER,
        "strategies": STRATEGIES,
        "strategy_version": ropp.STRATEGY_VERSION,
        "split": SPLIT,
        "split_seed": SPLIT_SEED,
        "base_seed": base_seed,
        "turn_limit": turn_limit,
        "games_requested": games,
        "games_played": played,
        "transitions": dict(counts),
        "total_transitions": sum(counts.values()),
        "families": {name: len(fams) for name, fams in families.items()},
        "truncated": truncated,
        "errors": errors,
        "elapsed_s": round(elapsed, 2),
        "games_per_second": round(played / elapsed, 2) if elapsed > 0 else None,
        "turns": {
            "mean": round(statistics.fmean(turn_samples), 1) if turn_samples else None,
            "p50": statistics.median(turn_samples) if turn_samples else None,
            "max": max(turn_samples) if turn_samples else None,
        },
        "files": {name: os.path.relpath(path, _ROOT) for name, path in paths.items()},
        # 轨迹文件本身**不入库**（12,000 局约 91MB）。可复现性靠下面这几项：
        # 同一个 base_seed + split_seed + turn_limit + 策略版本，
        # 重跑 `build-trajectories.py` 就能得到逐字节相同的文件。
        # 入库的只有这份 manifest。
        "reproduce": ("python3 scripts/roco/build-trajectories.py "
                      f"--games {games} --budget-s 900 --base-seed {base_seed} "
                      f"--turn-limit {turn_limit}"),
        "not_committed_reason": (
            "12,000 局约 91MB；入库会让仓库无法维护。manifest 记录了种子与口径，"
            "重跑即得到相同文件。"
        ),
        "disciplines": [
            "家族在生成**之前**就按固定种子切好，同一家族不会跨侧。",
            "只写公开观察哈希，不写私有状态（对手后备血量、内部字段）。",
            "标签是模拟结果，不是胜率；轨迹是过渡样本，不是结论。",
        ],
    }
    return manifest


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="W3-03 轨迹生成（固定家族切分）")
    parser.add_argument("--games", type=int, default=10000)
    parser.add_argument("--budget-s", type=float, default=900.0)
    parser.add_argument("--base-seed", type=int, default=20260921)
    parser.add_argument("--turn-limit", type=int, default=300)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    out_dir = os.path.join(_ROOT, args.out)
    os.makedirs(out_dir, exist_ok=True)
    manifest = build(rs, args.games, args.budget_s, args.base_seed, args.turn_limit, out_dir)
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(json.dumps({k: manifest[k] for k in
                      ("games_played", "total_transitions", "transitions", "families",
                       "elapsed_s", "games_per_second", "truncated", "errors", "turns")},
                     ensure_ascii=False, indent=2))
    print(f"wrote {args.out}/manifest.json 与 transitions-*.jsonl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
