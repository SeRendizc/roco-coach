#!/usr/bin/env python3
"""Planner 的**客观**评分：拿一局真实推演当基准，量「推荐得准不准」。

为什么需要它
------------

改 planner 时最尴尬的状态是「我觉得这样更好」—— 因为**没有可比的数字**。
第 5 轮踩过一次：加「即时伤害项」看起来显然该加，量出来 59% vs 57%，
样本 100，纯噪声；而中途还因为一个错误的测量（按配招表算伤害、没查能量）
得出过「必杀一次都没选中」的强结论。有基准就不会这样。

基准怎么定（关键是它**不依赖人的判断**）
----------------------------------------

对每个局面：

  1. 枚举我方**合法**动作（`legal_actions`，不是配招表）；
  2. 对每个动作，按对手分布跑一次真实推演（`step_joint`），拿到推演后的局面；
  3. 用同一个 `evaluate()` 给推演后的局面打分，按对手分布取期望 ——
     这就是这个动作的**基准值**；
  4. 基准值最高的动作就是这一局的**基准最优**。

**这个基准偏向单步贪心，必须说清楚。** 它只推一步，所以「基准最优」=
「一步之后最合估值函数口味的那一手」。多回合搜索**允许**与它不同
（例如放弃眼前一点收益换两回合后的位置），那种差异不一定是错。
反过来，如果单步搜索在同一个基准上明显好过多回合搜索，
那说明多回合搜索**找到了别的偏好**，值得查 —— 这正是第一次跑出来的结果。

于是「推荐得准不准」变成一个可算的数字，而且随 `evaluate()` 变动而变动的
只有 planner 的**选择**，不是基准（基准用的是同一个估值函数，
所以测的是「搜索有没有找到估值函数的偏好」，这一点必须说清楚）。

    · `top1`      —— 推荐就是基准最优的比例
    · `regret`    —— 基准最优值 − 推荐动作的基准值（越低越好）
    · `mean_rank` —— 推荐在基准排序里的名次

**三条使用边界**（都是踩过或量出来才写下的，请照着用）：

1. 它测「planner 的搜索有没有找到**估值函数**最喜欢的那一手」，
   **不**测「估值函数本身对不对」—— 那需要真人或天梯数据，本项目没有。
2. **它不能用来比较不同搜索深度。** 基准是单步推演，
   depth=2 的搜索是在权衡「两回合后的位置」，与单步基准不同是**预期行为**，
   不是缺陷。实测量过：depth=2 的 top1（0.59）低于 depth=1 的朴素贪心（0.88），
   而把预算从 200ms 提到 8000ms 数字**完全不变**（0.6842），
   说明差距不是超时截断，而是两种目标本身不同。
   要比较深度，需要一个「整局结果」口径的基准（多打几手、看最终评分差），
   那是另一件工具的事。
3. **不要为了刷这个数字去改 `evaluate()`。** 基准与 planner 用的是同一个
   `evaluate()`，所以改估值函数会同时移动基准与推荐 ——
   数字变好不代表推荐变好，只代表两者更一致了。
   真要让规划变好，需要的是**外部**口径（真人样本或整局结果）。

跑法::

    python3 scripts/roco/benchmark-planner.py                  # 默认 200 局面
    python3 scripts/roco/benchmark-planner.py --positions 500 --beam 4
    python3 scripts/roco/benchmark-planner.py --compare        # 与 immediate_greedy 对照
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import random
import statistics
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402
from roco_env.schema import Action          # noqa: E402

ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]

OUT_JSON = os.path.join("reports", "roco", "planner-benchmark.json")

#: 局面集合的固定种子。**写死**：换一批局面得出的数字不可比。
POSITION_SEED = 20260921


def positions(rs, count: int) -> List[Dict[str, Any]]:
    """生成一批**固定**的局面快照（同 seed 同参数 → 每次都一样）。"""
    ids = [rs.pets_by_name(n)[0].pet_id for n in ROSTER]
    rng = random.Random(POSITION_SEED)
    out = []
    for _ in range(count):
        team_a = rng.sample(ids, 3)
        team_b = rng.sample(ids, 3)
        seed = rng.randrange(1, 10 ** 5)
        state = renv.reset(team_a, team_b, seed=seed, rs=rs)
        # 推进几回合，让局面不是千篇一律的开场
        for _ in range(rng.randrange(0, 4)):
            if state.result or state.phase == "replace":
                break
            mine = [a for a in renv.legal_actions(state, rs, "player") if a.kind == "skill"]
            theirs = [a for a in renv.legal_actions(state, rs, "enemy") if a.kind == "skill"]
            if not mine or not theirs:
                break
            try:
                renv.step_joint(state, rs, mine[0], theirs[0])
            except ValueError:
                break
        if state.result or state.phase == "replace":
            continue
        if len(renv.legal_actions(state, rs, "player")) < 2:
            continue
        out.append({"snapshot": renv.serialize(state),
                    "hash": hashlib.sha256(
                        json.dumps(renv.serialize(state), sort_keys=True,
                                   ensure_ascii=False).encode("utf-8")).hexdigest()[:16]})
    return out


def baseline_values(rs, state, beam: int = 4) -> Dict[str, float]:
    """每个**能真的推演出来**的合法动作的基准值。

    基准用的是与 planner **同一个** `evaluate()`（这一点必须说清楚：
    它测的是「搜索有没有找到估值函数喜欢的那一手」，不是「估值函数对不对」）。

    **推演失败的动作必须排除，不能给它打分。** `_safe_step` 在步骤非法或机制
    未核验时**原样返回输入状态**，于是 `evaluate(原状态)` 会给出一个「什么都没做」
    的分数。第一版没排除，结果一批算不出来的动作全部拿到同一个值
    （实测 40+ 个动作共享 `-1.2121`），而那个值可能**恰好**高于真正的最优 ——
    于是「基准最优」变成了一个根本执行不了的动作，planner 自然「选错」。
    一个把失败当成选项的基准，会系统性地高估基准、低估 planner。
    """
    dist = pm.opponent_distribution(state, rs, beam=beam)
    out: Dict[str, float] = {}
    for action in renv.legal_actions(state, rs, "player"):
        if action.kind == "escape":
            continue
        if not dist:
            trial = renv.deserialize(renv.serialize(state), rs)
            nxt = pm._safe_step(trial, rs, action, None, "player")
            if nxt is trial:
                continue          # 推演没发生 → 不打分
            out[action.label(rs)] = pm.evaluate(nxt, rs, "player")
            continue
        total = 0.0
        scored = 0
        for opp_action, weight in dist:
            trial = renv.deserialize(renv.serialize(state), rs)
            nxt = pm._safe_step(trial, rs, action, opp_action, "player")
            if nxt is trial:
                continue          # 这一条对手分支推不动 → 不计入
            total += pm.evaluate(nxt, rs, "player") * weight
            scored += weight
        if scored <= 0:
            continue              # 所有对手分支都推不动 → 这个动作不进基准
        out[action.label(rs)] = total / scored
    return out


def score_position(rs, record: Dict[str, Any], depth: int, beam: int, budget_ms: int,
                   greedy: bool = False) -> Optional[Dict[str, Any]]:
    state = renv.deserialize(record["snapshot"], rs)
    values = baseline_values(rs, state, beam=beam)
    if len(values) < 2:
        return None
    best_label = max(values, key=lambda k: values[k])
    best_value = values[best_label]

    if greedy:
        plan = pm.immediate_greedy(state, rs)
        label = plan.label(rs) if isinstance(plan, Action) else None
    else:
        result = pm.plan_actions(state, rs, depth=depth, beam=beam, budget_ms=budget_ms)
        label = result.recommended_label
    if label is None or label not in values:
        return None

    ordered = sorted(values.items(), key=lambda kv: -kv[1])
    rank = [k for k, _ in ordered].index(label) + 1
    return {
        "hash": record["hash"],
        "recommended": label,
        "baseline_best": best_label,
        "top1": label == best_label,
        "rank": rank,
        "regret": round(best_value - values[label], 4),
        "values": {k: round(v, 4) for k, v in values.items()},
    }


def summarise(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not rows:
        return {"positions": 0}
    ranks = [r["rank"] for r in rows]
    regrets = [r["regret"] for r in rows]
    return {
        "positions": len(rows),
        "top1": round(sum(1 for r in rows if r["top1"]) / len(rows), 4),
        "mean_rank": round(statistics.fmean(ranks), 3),
        "median_rank": statistics.median(ranks),
        "mean_regret": round(statistics.fmean(regrets), 4),
        "max_regret": round(max(regrets), 4),
        "regret_zero": round(sum(1 for r in rows if r["regret"] <= 1e-9) / len(rows), 4),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="planner 客观评分")
    parser.add_argument("--positions", type=int, default=200)
    parser.add_argument("--depth", type=int, default=2)
    parser.add_argument("--beam", type=int, default=4)
    parser.add_argument("--budget-ms", type=int, default=1500)
    parser.add_argument("--compare", action="store_true",
                        help="同时量 immediate_greedy（朴素基线）作为对照")
    parser.add_argument("--limit", type=int, default=0, help="只跑前 N 个局面（自检）")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    positions_list = positions(rs, args.positions)
    if args.limit:
        positions_list = positions_list[: args.limit]
    if not positions_list:
        print("没有生成出可用局面（调大 --positions）", file=sys.stderr)
        return 2

    planner_rows = [r for r in (score_position(rs, rec, args.depth, args.beam, args.budget_ms)
                                for rec in positions_list) if r]
    payload: Dict[str, Any] = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "generated_by": "scripts/roco/benchmark-planner.py",
        "ruleset_id": rs.ruleset_id,
        "position_seed": POSITION_SEED,
        "settings": {"depth": args.depth, "beam": args.beam, "budget_ms": args.budget_ms,
                     "positions_requested": args.positions},
        "what_this_measures": (
            "「planner 的搜索有没有找到**估值函数**最偏好的那一手」。"
            "基准是最优动作的真实推演值，用的是同一个 evaluate()，"
            "所以它**不**测「估值函数本身对不对」——那需要真人或天梯数据，本项目没有。"
        ),
        "planner": summarise(planner_rows),
        "positions": planner_rows,
    }
    if args.compare:
        greedy_rows = [r for r in (score_position(rs, rec, args.depth, args.beam, args.budget_ms,
                                                  greedy=True) for rec in positions_list) if r]
        payload["greedy_baseline"] = summarise(greedy_rows)

    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(json.dumps({k: payload[k] for k in ("planner",) if k in payload}, ensure_ascii=False, indent=2))
    if args.compare:
        print(json.dumps({"greedy_baseline": payload["greedy_baseline"]}, ensure_ascii=False, indent=2))
    print(f"wrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
