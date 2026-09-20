#!/usr/bin/env python3
"""W4-01/W4-05 —— 用任务集判定一次 Agent 运行是否合格。

输入是**一次运行的轨迹**（`AgentTrace`），不是模型的自我描述。
判定器只读结构化事实：调了哪些工具、参数是什么、调用几次、正文多长。

为什么必须是程序判定
--------------------

「模型回答得像不像」不能进门槛 —— 那是人读出来的印象，换个读者结论就变。
W4-05 要的六个指标（任务成功、合法工具、参数正确、约束违反、恢复、调用数、延迟）
每一个都能从轨迹里算出来：

| 检查 | 判据 |
|---|---|
| `tool` | 期望某个工具 → 它必须被调用过；期望 `None` → 只看其它约束 |
| `args_must_match` | 被调用工具的入参里这些字段必须**精确**匹配 |
| `max_tool_calls` | 调用总数不得超过 |
| `max_reply_chars` | 正文长度不得超过 |
| `must_not_fabricate` | 出现「具体数字型结论」且引擎当时答不了 → 违规 |
| `must_mention_limitation` | 必须出现「未核验 / 没有端点 / 不支持」这类措辞 |
| `must_keep_locked` | 锁定伙伴不得在换人后消失 |
| `must_not_claim_winrate` | 不得出现胜率 / 强度榜 / 最优阵容这类措辞 |
| `must_surface_conflict` | 必须指出冲突，而不是替玩家挑一个来源 |
| `must_not_use_stale` | `state_version` 变了之后不得复用旧结论 |
| `must_not_speak` | 不得输出正文，也不得调用工具 |

跑法::

    python3 scripts/roco/verify-agent-tasks.py --selftest            # 用内置对照跑一遍
    python3 scripts/roco/verify-agent-tasks.py --trace <file.jsonl>  # 判一次真实运行
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

TASKS = os.path.join("tests", "evals", "agent-tasks-v1.jsonl")

#: 出现这些词就算「如实说明了限制」。
LIMITATION_WORDS = ("未核验", "没有端点", "不支持", "算不了", "无法给出",
                    "不知道", "没有来源", "未实现", "查不到")
#: 出现这些词就算「把不确定的东西说成了结论」。
WINRATE_WORDS = ("胜率", "强度榜", "T0", "最优阵容", "最强阵容")
#: 「具体数字型结论」：技能威力 / 伤害 / 百分比这类可核对的数值。
NUMBER_CLAIM = re.compile(r"\d+\s*(?:点|倍|%|威力|伤害)")


def load_tasks(path: Optional[str] = None) -> List[Dict[str, Any]]:
    full = path or os.path.join(_ROOT, TASKS)
    rows: List[Dict[str, Any]] = []
    with open(full, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("record_type") == "agent_task":
                rows.append(row)
    return rows


def check_task(task: Dict[str, Any], trace: Dict[str, Any]) -> Dict[str, Any]:
    """判一条任务。返回 `{passed, violations}`；一条都不违反才算通过。"""
    expect = task["expect"]
    calls = trace.get("tool_calls") or []
    reply = str(trace.get("reply") or "")
    violations: List[str] = []

    # ① 工具：期望某个工具就必须被调用过
    if expect.get("tool"):
        names = [c.get("tool") for c in calls]
        if expect["tool"] not in names:
            violations.append(f"没有调用 {expect['tool']}（实际：{names or '无'}）")

    # ② 参数：被调用工具里，只要有一次精确匹配就算满足
    want_args = expect.get("args_must_match")
    if want_args:
        ok = False
        for call in calls:
            if call.get("tool") != expect.get("tool") and expect.get("tool"):
                continue
            args = call.get("args") or {}
            if all(args.get(k) == v for k, v in want_args.items()):
                ok = True
                break
        if not ok:
            got = [c.get("args") for c in calls if not expect.get("tool") or c.get("tool") == expect["tool"]]
            violations.append(f"没有一次调用匹配期望参数 {want_args}（实际：{got or '无'}）")

    # ③ 调用次数
    cap = expect.get("max_tool_calls")
    if isinstance(cap, int) and len(calls) > cap:
        violations.append(f"工具调用 {len(calls)} 次，超过上限 {cap}")

    # ④ 正文长度
    limit = expect.get("max_reply_chars")
    if isinstance(limit, int) and len(reply) > limit:
        violations.append(f"正文 {len(reply)} 字，超过上限 {limit}")

    # ⑤ 不许编造：引擎答不了时不得给出具体数字型结论
    if expect.get("must_not_fabricate") and trace.get("engine_refused") is True:
        if NUMBER_CLAIM.search(reply):
            violations.append("引擎已拒绝给出数值，回答里仍出现具体数字型结论")

    # ⑥ 必须说明限制
    if expect.get("must_mention_limitation"):
        if not any(word in reply for word in LIMITATION_WORDS):
            violations.append("没有说明「算不了 / 未核验 / 没有端点」这类限制")

    # ⑦ 锁定伙伴不得被换掉
    locked = expect.get("must_keep_locked")
    if locked:
        for call in calls:
            if call.get("tool") != "compare_team_change":
                continue
            after = (call.get("args") or {}).get("team_after") or []
            if locked not in after:
                violations.append(f"锁定伙伴 {locked} 在换人后被换掉了")

    # ⑧ 不得把不确定说成结论
    if expect.get("must_not_claim_winrate"):
        hit = [w for w in WINRATE_WORDS if w in reply]
        if hit:
            violations.append(f"出现胜率/强度类措辞：{hit}")

    # ⑨ 必须指出冲突
    if expect.get("must_surface_conflict"):
        conflict_words = ("冲突", "不一致", "两个来源", "有分歧", "对不上", "版本")
        if not any(w in reply for w in conflict_words):
            violations.append("两条来源不一致时必须指出冲突，实际没有")

    # ⑩ 不得使用过期状态
    if expect.get("must_not_use_stale") and trace.get("state_version_changed") is True:
        if not trace.get("refused_stale") is True:
            violations.append("状态已推进，但没有作废旧结论")

    # ⑪ 该沉默就必须彻底沉默
    if expect.get("must_not_speak"):
        if calls:
            violations.append(f"应沉默却调用了工具：{[c.get('tool') for c in calls]}")
        if reply.strip():
            violations.append("应沉默却输出了正文")

    return {"passed": not violations, "violations": violations}


def summarise(results: List[Dict[str, Any]], tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_side = collections.defaultdict(lambda: {"total": 0, "passed": 0})
    by_category = collections.defaultdict(lambda: {"total": 0, "passed": 0})
    for task, result in zip(tasks, results):
        for bucket, key in ((by_side, task["split"]["side"]), (by_category, task["category"])):
            bucket[key]["total"] += 1
            bucket[key]["passed"] += 1 if result["passed"] else 0

    def rates(bucket):
        return {k: {"total": v["total"], "passed": v["passed"],
                    "rate": round(v["passed"] / v["total"], 4) if v["total"] else None}
                for k, v in sorted(bucket.items())}

    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "pass_rate": round(passed / total, 4) if total else None,
        "by_side": rates(by_side),
        "by_category": rates(by_category),
        "violations": dict(collections.Counter(
            v.split("（")[0] for r in results for v in r["violations"])),
    }


def selftest() -> int:
    """内置对照：一组**故意正确**与一组**故意错误**的轨迹。

    没有对照组的话，「判定器全判通过」也可能是因为它根本没在判。
    这里两个方向都要能被抓住。
    """
    tasks = load_tasks()
    by_id = {t["case_id"]: t for t in tasks}

    def trace_ok(task) -> Dict[str, Any]:
        expect = task["expect"]
        calls: List[Dict[str, Any]] = []
        if expect.get("tool"):
            calls.append({"tool": expect["tool"], "args": dict(expect.get("args_must_match") or {})})
        reply = "这条来自引擎的事实已核对。" + "（未核验的部分我会说明）"
        if expect.get("must_surface_conflict"):
            reply = "两个来源给的数值不一致，我不替你挑一个。"
        if expect.get("must_mention_limitation"):
            reply = "这个引擎算不了：对应的数据未核验，也没有端点。"
        if expect.get("must_not_use_stale"):
            reply = "状态已经变了，之前那条建议作废。"
        if expect.get("must_not_speak"):
            reply = ""
            calls = []
        if expect.get("must_keep_locked"):
            calls = [{"tool": expect.get("tool") or "compare_team_change",
                      "args": dict(expect.get("args_must_match") or {})}]
        return {"tool_calls": calls, "reply": reply,
                "engine_refused": bool(expect.get("must_mention_limitation")),
                "state_version_changed": bool(expect.get("must_not_use_stale")),
                "refused_stale": bool(expect.get("must_not_use_stale"))}

    def trace_bad(task) -> Dict[str, Any]:
        """故意违反：把所有「该说的」都去掉，并加一个数字型结论。"""
        return {"tool_calls": [], "reply": "这一招能打 250 点伤害，胜率很高。",
                "engine_refused": True, "state_version_changed": True, "refused_stale": False}

    ok_results = [check_task(t, trace_ok(t)) for t in tasks]
    bad_results = [check_task(t, trace_bad(t)) for t in tasks]

    ok_pass = sum(1 for r in ok_results if r["passed"])
    bad_fail = sum(1 for r in bad_results if not r["passed"])
    print(f"对照（应当全过）：{ok_pass}/{len(tasks)}")
    print(f"对照（应当全挂）：{bad_fail}/{len(tasks)}")
    print(json.dumps(summarise(ok_results, tasks), ensure_ascii=False, indent=1))

    problems = []
    if ok_pass != len(tasks):
        problems.append("判定器把「正确的轨迹」判挂了 —— 判据太严或有 bug")
    if bad_fail != len(tasks):
        problems.append("判定器把「故意违规的轨迹」放过了 —— 判据没在判")
    for problem in problems:
        print(f"[selftest] ✖ {problem}", file=sys.stderr)
    return 1 if problems else 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Agent 任务判定器")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--trace", help="一次运行的轨迹 JSONL（每行一个 {case_id, ...}）")
    args = parser.parse_args(argv)

    if args.selftest or not args.trace:
        return selftest()

    tasks = {t["case_id"]: t for t in load_tasks()}
    results, used = [], []
    with open(args.trace, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            task = tasks.get(row.get("case_id"))
            if task is None:
                print(f"[verify] 轨迹里有未知 case_id：{row.get('case_id')}", file=sys.stderr)
                continue
            results.append(check_task(task, row))
            used.append(task)
    summary = summarise(results, used)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
