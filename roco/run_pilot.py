#!/usr/bin/env python3
"""S02 —— 1,000 场先导（pilot）。

跑法：

    python3 roco/run_pilot.py                    # 默认 base seed、1000 场
    python3 roco/run_pilot.py --games 100        # 快速自检
    python3 roco/run_pilot.py --out reports/roco/pilot-1000

产出（`reports/roco/pilot-1000/`）：

    manifest.json    规则集 id、快照指纹、种子范围、策略名+版本、代码 commit
    metrics.json     吞吐、回合分布、非法动作数、截断数、异常数、分组胜负计数
    failures.jsonl   每个异常一行的复现记录（正常时是空文件）
    README.md        人读的摘要，含免责声明

**这份报告不是强度结论。** 它是一次环境体检：报名里谁是赢家说明不了谁强，
只说明这套引擎在 1000 局里没有崩、没有产生非法动作、没有偷看隐藏信息。
分组胜负计数只是「引擎能稳定产出不同结局」的证据。详见 `DISCLAIMER`。
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import statistics
import subprocess
import sys
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

# 直接以脚本方式运行时，把 roco/src 挂上，免得调用方必须记得设 PYTHONPATH
_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.join(_HERE, "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402

#: 先导的默认参数。种子写死在 manifest 里，别人拿来就能重跑。
DEFAULT_GAMES = 1000
DEFAULT_BASE_SEED = 20260921
DEFAULT_TURN_LIMIT = 300            # 观察到的对局都在 200 回合内结束；撞上就是异常
DEFAULT_OUT = os.path.join("reports", "roco", "pilot-1000")

# A 组六只（MC-014…019）。两套三人队互相配对，保证每场都是 A 组内部的 3v3。
A_GROUP_NAMES = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]

DISCLAIMER = (
    "本报告的分组胜负计数是**环境自检，不是胜率、不是强度榜**。"
    "社区阵容出现频率不是胜率；模拟出来的胜场数也不是天梯强度。"
    "这里没有任何一个策略可以被称为「强」或「T0」——"
    "本项目的策略池按**行为**命名而不按名次命名，正是因为「谁强」需要真实天梯样本，"
    "而本项目没有。"
)


def _exposure_report(schedule) -> Dict[str, Any]:
    """检查每个策略对拿到的是不是**同一组**队伍对。

    这是「分组胜负计数」能不能被读的前提：如果各策略对的队伍组合不同，
    那些数字只是在比较队伍，不是在比较策略。

    判定口径是**策略对之间彼此一致**：每个策略对场次相同，且队伍对的
    多重集合完全相同（同一格打几场也相同）。具体每格打了几场不重要——
    重要的是五个策略对拿到的东西一模一样。总场次不是块大小整数倍时，
    每格场次会是 2/3 这样的不均匀数，但**对所有策略对同样不均匀**，
    所以比较仍然成立；`cell_counts_uniform` 单独报告这一点。
    """
    cells: Dict[str, Dict[Tuple[int, int], int]] = {}
    for name_a, name_b, _seed, _ta, _tb, ti, tj in schedule:
        key = "%s__vs__%s" % (name_a, name_b)
        cells.setdefault(key, {})
        cells[key][(ti, tj)] = cells[key].get((ti, tj), 0) + 1

    # 每个策略对的「队伍对 → 场次」指纹；全都一样才叫可比
    fingerprints = {k: tuple(sorted(v.items())) for k, v in cells.items()}
    distinct = set(fingerprints.values())
    games_per_pair = sorted(sum(v.values()) for v in cells.values())
    cell_counts = sorted({n for v in cells.values() for n in v.values()})

    team_indices = {ti for _a, _b, _s, _ta, _tb, ti, _tj in schedule}
    team_indices |= {tj for _a, _b, _s, _ta, _tb, _ti, tj in schedule}
    block_size = len(ropp.STRATEGIES) ** 2 * max(1, len(team_indices)) ** 2

    return {
        "balanced": len(distinct) == 1 and len(set(games_per_pair)) == 1,
        "balanced_definition": (
            "每个策略对场次相同，且队伍对的多重集合完全相同（逐格场次也相同）"
        ),
        "block_size": block_size,
        "games": len(schedule),
        "complete_blocks": len(schedule) // block_size,
        "games_per_strategy_pair": games_per_pair,
        "team_pairs_per_strategy_pair": sorted({len(v) for v in cells.values()}),
        "cell_counts": cell_counts,
        "cell_counts_uniform": len(cell_counts) == 1,
        "distinct_exposure_patterns": len(distinct),
        "note": (
            "balanced=true 表示每个策略对拿到完全相同的队伍组合与场次，"
            "此时分组胜负计数是可比的——但它仍然**不是胜率**。"
        ),
    }


def _git_commit() -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=_HERE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode().strip() or None


def _git_dirty() -> Optional[bool]:
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain"], cwd=_HERE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return bool(out.stdout.strip())


def _quantiles(values: List[int]) -> Dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    def pick(p: float) -> int:
        index = min(len(ordered) - 1, max(0, int(round(p * (len(ordered) - 1)))))
        return ordered[index]
    return {
        "min": ordered[0], "p10": pick(0.10), "p25": pick(0.25),
        "p50": pick(0.50), "p75": pick(0.75), "p90": pick(0.90),
        "max": ordered[-1],
    }


def _histogram(values: List[int], bucket: int = 20) -> Dict[str, int]:
    """把回合数分桶。桶是左闭右开，最后一桶含右端点。"""
    buckets: Dict[str, int] = {}
    for value in values:
        low = (value // bucket) * bucket
        buckets[f"{low}-{low + bucket - 1}"] = buckets.get(f"{low}-{low + bucket - 1}", 0) + 1
    return dict(sorted(buckets.items(), key=lambda kv: int(kv[0].split("-")[0])))


def _team_pool(rs: rdata.Ruleset) -> List[List[str]]:
    """A 组六只组成的四套三人队。顺序会与策略对一起被遍历。"""
    pets = [rs.pets_by_name(n)[0].pet_id for n in A_GROUP_NAMES]
    return [pets[:3], pets[3:], [pets[0], pets[2], pets[4]], [pets[1], pets[3], pets[5]]]


def build_schedule(rs: rdata.Ruleset, games: int, base_seed: int
                   ) -> List[Tuple[str, str, int, List[str], List[str], int, int]]:
    """把 N 场摊到「策略对 × （有序）队伍对」的笛卡尔积上。

    为什么必须摊到队伍对上：本引擎里队伍相性常常直接决定胜负
    （实测：T0 对 T2 是 63:0，与用什么策略无关）。如果只摊策略对，
    各策略对拿到的队伍组合不同，胜负计数就变成「谁抽到好队伍」，
    而不是「谁决策得好」。

    构造分两段：
      ① 完整块 —— 25 个策略对 × 16 个有序队伍对。整块重复，保证每个策略对
         拿到**完全相同**的队伍对多重集合，只是顺序不同。
      ② 余数 —— 每个策略对补同样多的场次，补的队伍对取**同一小段公共序列**，
         所以多重集合依然一致。

    返回 (strategy_a, strategy_b, seed, team_a, team_b, team_i, team_j)；
    team_i / team_j 是队伍池下标，用于核对暴露是否均等。
    """
    teams = _team_pool(rs)
    n = len(teams)
    # 有序队伍对，含 i == j（同队互打）。用嵌套顺序而不是排序后的元组，
    # 这样「队伍对」的编号与下标一一对应，不会出现重复键。
    team_pairs = [(i, j) for i in range(n) for j in range(n)]
    names = ropp.STRATEGIES.names()
    pairs = [(a, b) for a in names for b in names]

    block = [(name_a, name_b, ti, tj)
             for name_a, name_b in pairs
             for ti, tj in team_pairs]

    per_pair, remainder = divmod(games, len(pairs))
    block_reps = per_pair // len(team_pairs)
    tail = per_pair - block_reps * len(team_pairs)
    assert 0 <= tail < len(team_pairs)

    schedule = []
    for _rep in range(block_reps):
        for name_a, name_b, ti, tj in block:
            schedule.append((name_a, name_b, base_seed + len(schedule),
                             list(teams[ti]), list(teams[tj]), ti, tj))
    # 尾段：每个策略对补 tail 场，队伍对取公共序列的前 tail 个
    for t in range(tail):
        ti, tj = team_pairs[t]
        for name_a, name_b in pairs:
            schedule.append((name_a, name_b, base_seed + len(schedule),
                             list(teams[ti]), list(teams[tj]), ti, tj))
    # 余数：按策略对顺序各补一场，队伍对同样取公共序列
    for extra in range(remainder):
        name_a, name_b = pairs[extra]
        ti, tj = team_pairs[extra % len(team_pairs)]
        schedule.append((name_a, name_b, base_seed + len(schedule),
                         list(teams[ti]), list(teams[tj]), ti, tj))
    return schedule


def run_pilot(games: int, base_seed: int, out_dir: str, turn_limit: int,
              quiet: bool = False) -> Dict[str, Any]:
    """跑完整份先导并落盘。返回 {"manifest", "metrics", "out_dir"}。"""
    started = time.time()
    rs = rdata.load_ruleset()
    ropp.bind_ruleset(rs)
    ropp.reset_hidden_reads()

    schedule = build_schedule(rs, games, base_seed)
    os.makedirs(out_dir, exist_ok=True)
    failures_path = os.path.join(out_dir, "failures.jsonl")

    per_pair: Dict[str, Dict[str, int]] = {}
    per_team_pair: Dict[str, Dict[str, int]] = {}
    turn_values: List[int] = []
    verdicts = {"player": 0, "enemy": 0, "draw": 0}
    illegal_actions = 0
    truncations = 0
    exceptions = 0
    exception_causes: Dict[str, int] = {}
    unfinished = 0
    game_times: List[float] = []

    with open(failures_path, "w", encoding="utf-8") as fh:
        for game_index, (name_a, name_b, seed, team_a, team_b, ti, tj) in enumerate(schedule):
            key = f"{name_a}__vs__{name_b}"
            bucket = per_pair.setdefault(key, {
                "strategy_a": name_a, "strategy_b": name_b, "games": 0,
                "player_wins": 0, "enemy_wins": 0, "draws": 0, "truncated": 0, "exceptions": 0,
            })
            bucket["games"] += 1
            team_key = "T%d__vs__T%d" % (ti, tj)
            team_bucket = per_team_pair.setdefault(team_key, {
                "team_a": list(team_a), "team_b": list(team_b), "games": 0,
                "player_wins": 0, "enemy_wins": 0, "draws": 0,
            })
            team_bucket["games"] += 1

            t0 = time.perf_counter()
            record: Optional[ropp.MatchRecord] = None
            failure: Optional[Dict[str, Any]] = None
            try:
                record = ropp.play_match(
                    rs, team_a, team_b, name_a, name_b, seed=seed, turn_limit=turn_limit)
            except AssertionError as exc:
                # IllegalActionError：策略返回了 legal 之外的动作。这是最严重的异常。
                illegal_actions += 1
                exceptions += 1
                bucket["exceptions"] += 1
                exception_causes["illegal_action"] = exception_causes.get("illegal_action", 0) + 1
                failure = {"kind": "illegal_action", "error": str(exc)}
            except Exception as exc:                      # noqa: BLE001 - 先导就是要兜住一切
                exceptions += 1
                bucket["exceptions"] += 1
                cause = f"{type(exc).__name__}: {exc}"
                exception_causes[cause] = exception_causes.get(cause, 0) + 1
                failure = {"kind": "exception", "error": cause,
                           "traceback": traceback.format_exc()}
            game_times.append(time.perf_counter() - t0)

            if record is not None:
                turn_values.append(record.turns)
                verdicts[record.winner] = verdicts.get(record.winner, 0) + 1
                if record.winner == "player":
                    bucket["player_wins"] += 1
                    team_bucket["player_wins"] += 1
                elif record.winner == "enemy":
                    bucket["enemy_wins"] += 1
                    team_bucket["enemy_wins"] += 1
                elif record.winner == "draw":
                    bucket["draws"] += 1
                    team_bucket["draws"] += 1
                else:
                    unfinished += 1
                if record.truncated:
                    truncations += 1
                    bucket["truncated"] += 1
                    failure = {"kind": "truncated",
                               "error": "撞上回合上限 %d" % turn_limit}
                    if record.error:
                        failure["note"] = record.error
                elif record.error:
                    failure = {"kind": "engine_error", "error": record.error}

                if failure is not None:
                    failure.update({
                        "game_index": game_index,
                        "seed": seed,
                        "team_a": team_a,
                        "team_b": team_b,
                        "strategy_a": {"name": name_a,
                                       "version": ropp.get_strategy(name_a).version},
                        "strategy_b": {"name": name_b,
                                       "version": ropp.get_strategy(name_b).version},
                        "ruleset_id": rs.ruleset_id,
                        "snapshot_fingerprint": rs.snapshot_fingerprint(),
                        "winner": record.winner,
                        "turns": record.turns,
                        "battle_turns": record.battle_turns,
                        "replay_plan": record.replay_plan(),
                        "reproduce": (
                            "cd roco && PYTHONPATH=src python3 -c \""
                            "from roco_env import data as d, env as e, opponents as o;"
                            "rs=d.load_ruleset();o.bind_ruleset(rs);"
                            "r=o.play_match(rs,%r,%r,%r,%r,seed=%d,turn_limit=%d);"
                            "print(r.winner, r.turns)\"" % (
                                team_a, team_b, name_a, name_b, seed, turn_limit)
                        ),
                    })
            elif failure is not None:
                failure.update({
                    "game_index": game_index, "seed": seed,
                    "team_a": team_a, "team_b": team_b,
                    "strategy_a": {"name": name_a,
                                   "version": ropp.get_strategy(name_a).version},
                    "strategy_b": {"name": name_b,
                                   "version": ropp.get_strategy(name_b).version},
                    "ruleset_id": rs.ruleset_id,
                    "snapshot_fingerprint": rs.snapshot_fingerprint(),
                })

            if failure is not None:
                failure["reproducible"] = _verify_failure(
                    rs, failure, turn_limit)
                fh.write(json.dumps(failure, ensure_ascii=False) + "\n")
                fh.flush()

            if not quiet and (game_index + 1) % 100 == 0:
                elapsed = time.time() - started
                print("  %4d/%d  %.1fs  %.0f games/s" % (
                    game_index + 1, len(schedule), elapsed, (game_index + 1) / max(1e-9, elapsed)),
                    file=sys.stderr)

    elapsed = time.time() - started
    total_games = len(schedule)
    hidden_reads = ropp.hidden_read_snapshot()

    metrics: Dict[str, Any] = {
        "disclaimer": DISCLAIMER,
        "per_pair_win_counts_are": "environment-sanity-check-not-a-winrate",
        "games": total_games,
        "games_planned": games,
        "base_seed": base_seed,
        "seed_range": [base_seed, base_seed + total_games - 1],
        "turn_limit": turn_limit,
        "wall_seconds": round(elapsed, 3),
        "games_per_second": round(total_games / elapsed, 3) if elapsed > 0 else None,
        "seconds_per_game": round(elapsed / total_games, 5) if total_games else None,
        "illegal_actions": illegal_actions,
        "truncations": truncations,
        "exceptions": exceptions,
        "exception_causes": exception_causes,
        "unfinished_games": unfinished,
        "hidden_field_reads": hidden_reads,
        "hidden_field_read_paths": ropp.hidden_read_paths(),
        "verdicts": {
            "player_wins": verdicts.get("player", 0),
            "enemy_wins": verdicts.get("enemy", 0),
            "draws": verdicts.get("draw", 0),
            "note": (
                "player/enemy 指**对局里的座位**，不是「更强的一方」。"
                "每个有序策略对都打了同样多的场次，座位在对局内是固定的。"
            ),
        },
        "turns": {
            "definition": "turns = 对局走到的回合号（补位不消耗回合）；battle_turns = 结算过的战斗回合数",
            "mean": round(statistics.fmean(turn_values), 2) if turn_values else None,
            "stdev": round(statistics.pstdev(turn_values), 2) if len(turn_values) > 1 else None,
            "quantiles": _quantiles(turn_values),
            "histogram_bucket": 20,
            "histogram": _histogram(turn_values),
        },
        "per_strategy_pair": dict(sorted(per_pair.items())),
        "per_team_pair": dict(sorted(per_team_pair.items())),
        "exposure": _exposure_report(schedule),
        "code_commit": _git_commit(),
        "git_dirty": _git_dirty(),
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    }

    manifest: Dict[str, Any] = {
        "pilot": "S02-1000-game-pilot",
        "generated_at": metrics["generated_at"],
        "ruleset_id": rs.ruleset_id,
        "snapshot_fingerprint": rs.snapshot_fingerprint(),
        "snapshot_files": dict(sorted(rs.files.items())),
        "base_seed": base_seed,
        "seed_range": metrics["seed_range"],
        "games": total_games,
        "turn_limit": turn_limit,
        "strategies": ropp.list_strategies(),
        "strategy_version": ropp.STRATEGY_VERSION,
        "teams": {
            "pool": [rs.pets_by_name(n)[0].pet_id for n in A_GROUP_NAMES],
            "pool_names": list(A_GROUP_NAMES),
            "team_pool": [
                {"id": "T%d" % i, "pets": list(team),
                 "names": [rs.pet(p).name for p in team]}
                for i, team in enumerate(_team_pool(rs))
            ],
            "note": (
                "A 组六只组成的 4 套三人队，T<下标> 就是 `team_pool` 的下标；"
                "先手侧与后手侧都会轮到每一套，避免座位与队伍绑死。"
            ),
        },
        "loadouts": "M1 规范配招（Ruleset.candidate_moveset），由 env.reset 自动套用",
        "code_commit": metrics["code_commit"],
        "git_dirty": metrics["git_dirty"],
        "python": sys.version.split()[0],
        "host": sys.platform,
        "command": "python3 " + " ".join(["roco/run_pilot.py"] + sys.argv[1:]),
        "reproduce": (
            "cd %s && python3 roco/run_pilot.py --games %d --base-seed %d --out %s"
            % (os.path.dirname(_HERE) or ".", total_games, base_seed, out_dir)
        ),
        "disclaimer": DISCLAIMER,
        "artifacts": {
            "manifest": "manifest.json",
            "metrics": "metrics.json",
            "failures": "failures.jsonl",
            "readme": "README.md",
        },
    }

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    with open(os.path.join(out_dir, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(_render_readme(manifest, metrics, out_dir))

    return {"manifest": manifest, "metrics": metrics, "out_dir": out_dir}


def _verify_failure(rs: rdata.Ruleset, failure: Dict[str, Any], turn_limit: int) -> Dict[str, Any]:
    """就地重跑一次异常局，确认它不是偶发。

    只对异常/截断做重跑——把 1000 局全部重跑一遍会让先导慢一倍，
    而真正需要「能不能复现」的是那些异常。
    """
    plan = failure.get("replay_plan")
    if not plan:
        return {"checked": False, "reason": "没有可重放的行动序列"}
    try:
        state = renv.replay(plan, rs)
    except Exception as exc:                              # noqa: BLE001
        return {"checked": True, "reproduced": None,
                "replay_error": "%s: %s" % (type(exc).__name__, exc)}
    return {
        "checked": True,
        "reproduced_result": state.result,
        "reproduced_turn": state.turn,
        "note": "env.replay() 重放同一串动作得到的状态；与记录比对即可确认复现。",
    }


def _render_readme(manifest: Dict[str, Any], metrics: Dict[str, Any], out_dir: str) -> str:
    turns = metrics["turns"]
    lines = []
    lines.append("# 1,000 场先导（S02）\n")
    lines.append("> %s\n" % DISCLAIMER)
    lines.append("## 身份\n")
    lines.append("| 项 | 值 |")
    lines.append("|---|---|")
    lines.append("| 规则集 | `%s` |" % manifest["ruleset_id"])
    lines.append("| 快照指纹 | `%s` |" % manifest["snapshot_fingerprint"])
    lines.append("| 代码 commit | `%s`%s |" % (
        manifest.get("code_commit"), "（工作区有未提交改动）" if manifest.get("git_dirty") else ""))
    lines.append("| 种子范围 | %s … %s |" % tuple(metrics["seed_range"]))
    lines.append("| 场次 | %d |" % metrics["games"])
    lines.append("| 回合上限 | %d |" % metrics["turn_limit"])
    lines.append("| 策略版本 | v%d |" % manifest["strategy_version"])
    lines.append("")
    lines.append("## 策略\n")
    lines.append("| 策略 | 版本 | 怎么决策 |")
    lines.append("|---|---:|---|")
    for entry in manifest["strategies"]:
        lines.append("| `%s` | v%d | %s |" % (entry["name"], entry["version"], entry["note"]))
    lines.append("")
    lines.append("## 验收\n")
    lines.append("| 指标 | 值 | 口径 |")
    lines.append("|---|---:|---|")
    lines.append("| 吞吐 | %.1f 局/秒 | 端到端墙钟；%.1fs / %d 局 |" % (
        metrics["games_per_second"], metrics["wall_seconds"], metrics["games"]))
    lines.append("| 非法动作 | **%d** | 策略返回值不在 `legal_actions` 里（必须为 0） |"
                 % metrics["illegal_actions"])
    lines.append("| 截断 | %d | 撞上 %d 回合上限 |" % (metrics["truncations"], metrics["turn_limit"]))
    lines.append("| 异常 | %d | 未捕获异常 / 非法动作；原因见 `exception_causes` |" % metrics["exceptions"])
    lines.append("| 无结局对局 | %d | 既没胜负也没平局 |" % metrics["unfinished_games"])
    hidden_total = sum(metrics["hidden_field_reads"].values())
    lines.append("| 隐藏字段读取 | %d | 策略试图读 observation 之外的键的次数（必须为 0） |"
                 % hidden_total)
    lines.append("")
    lines.append("## 回合数分布\n")
    lines.append("- `turns` = 对局走到的回合号；`battle_turns` = 真正结算过的战斗回合数"
                 "（补位不消耗回合，两者会差若干个补位步）。")
    lines.append("- 均值 %.2f，标准差 %s，中位 %s，最大 %s。" % (
        turns["mean"], turns["stdev"], turns["quantiles"].get("p50"), turns["quantiles"].get("max")))
    lines.append("")
    lines.append("| 回合区间 | 局数 |")
    lines.append("|---|---:|")
    for key, count in turns["histogram"].items():
        lines.append("| %s | %d |" % (key, count))
    lines.append("")
    lines.append("## 结局\n")
    lines.append("| 座位 | 胜场 |")
    lines.append("|---|---:|")
    lines.append("| player（A 侧） | %d |" % metrics["verdicts"]["player_wins"])
    lines.append("| enemy（B 侧） | %d |" % metrics["verdicts"]["enemy_wins"])
    lines.append("| 平局 | %d |" % metrics["verdicts"]["draws"])
    lines.append("")
    lines.append("> player/enemy 是**对局里的座位**，不是「更强的一方」。"
                 "每个有序策略对场次相同。\n")
    lines.append("### 分组胜负计数（自检用）\n")
    lines.append("> 这些数字是**环境自检**：它们说明引擎能把不同策略区分开、"
                 "并且每局都能走到明确结局。**它们不是胜率，不构成强度榜，"
                 "也不支持任何「某策略强」的说法。**\n")
    lines.append("| A 侧 | B 侧 | 场次 | A 胜 | B 胜 | 平 | 截断 | 异常 |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|")
    for key, bucket in metrics["per_strategy_pair"].items():
        lines.append("| `%s` | `%s` | %d | %d | %d | %d | %d | %d |" % (
            bucket["strategy_a"], bucket["strategy_b"], bucket["games"],
            bucket["player_wins"], bucket["enemy_wins"], bucket["draws"],
            bucket["truncated"], bucket["exceptions"]))
    lines.append("")
    lines.append("## 队伍效应（为什么不能把上面的表读成强度）\n")
    exp = metrics.get("exposure", {})
    lines.append("暴露平衡：`balanced=%s`（%s），每个策略对 %s 场，"
                 "覆盖 %s 种有序队伍对，暴露模式 %s 种。" % (
                     exp.get("balanced"), exp.get("balanced_definition"),
                     sorted(set(exp.get("games_per_strategy_pair") or [])),
                     exp.get("team_pairs_per_strategy_pair"),
                     exp.get("distinct_exposure_patterns")))
    lines.append("")
    lines.append("下表按队伍对拆分。如果同一对队伍换了策略还是同样的悬殊比分，"
                 "那么差异来自**队伍与属性相性**，不是策略：\n")
    lines.append("| 队伍对 | 场次 | A 胜 | B 胜 | 平 |")
    lines.append("|---|---:|---:|---:|---:|")
    for key, bucket in metrics.get("per_team_pair", {}).items():
        lines.append("| `%s` | %d | %d | %d | %d |" % (
            key, bucket["games"], bucket["player_wins"],
            bucket["enemy_wins"], bucket["draws"]))
    lines.append("")
    team_pool = manifest["teams"].get("team_pool") or []
    lines.append("> 队伍池：" + "；".join(
        "`%s` = %s" % (entry["id"], "、".join(entry["names"]))
        for entry in team_pool) + "。"
        "队伍对之间场次不完全相同是因为块内轮换的余数，不是加权。\n")
    lines.append("## 复现\n")
    lines.append("```sh")
    lines.append(manifest["reproduce"])
    lines.append("```\n")
    lines.append("异常局的逐条复现记录在 `failures.jsonl`（每行一局，含种子、队伍、"
                 "策略版本与可重放的行动序列）。正常运行时该文件是空的。\n")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="S02：1,000 场对手策略先导")
    parser.add_argument("--games", type=int, default=DEFAULT_GAMES)
    parser.add_argument("--base-seed", type=int, default=DEFAULT_BASE_SEED)
    parser.add_argument("--turn-limit", type=int, default=DEFAULT_TURN_LIMIT)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    root = os.path.dirname(_HERE)          # 仓库根：roco/ 的上一级
    out_dir = os.path.abspath(args.out if os.path.isabs(args.out)
                              else os.path.join(root, args.out))

    print("先导：%d 场，种子 %d…，回合上限 %d" % (
        args.games, args.base_seed, args.turn_limit))
    result = run_pilot(args.games, args.base_seed, out_dir, args.turn_limit, args.quiet)
    metrics = result["metrics"]

    print("完成：%d 场 / %.1fs = %.1f 局每秒" % (
        metrics["games"], metrics["wall_seconds"], metrics["games_per_second"]))
    print("非法动作 %d，截断 %d，异常 %d，无结局 %d" % (
        metrics["illegal_actions"], metrics["truncations"],
        metrics["exceptions"], metrics["unfinished_games"]))
    print("隐藏字段读取 %d" % sum(metrics["hidden_field_reads"].values()))
    print("产出：%s" % result["out_dir"])
    print(DISCLAIMER)
    return 0 if metrics["illegal_actions"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
