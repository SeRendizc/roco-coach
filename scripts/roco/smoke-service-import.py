#!/usr/bin/env python3
"""最小启动烟测：**Python 战斗服务入口必须能 import**（本次 P0 的回归闸）。

背景（可复跑）：一次 WIP 快照把 `service.py` 的新写法提交了，却漏了 `coverage.py`
里同一批新写法 ⇒ `from .coverage import classify_skill_declared` 在**服务就绪前**就炸，
而 Node 外壳仍然 200（`/api/roco/status` 报 `available:false`）。这条烟测拦的就是它：
入口 import + 那一批导出必须在位，缺一个就以非 0 退出。

用法：
    python3 scripts/roco/smoke-service-import.py            # 正常仓库（应通过）
    ROCO_SMOKE_SRC=/tmp/某个副本/src python3 scripts/...py   # 故障注入副本（应失败）
"""
import os
import sys

REQUIRED_EXPORTS = (
    "settlement_verdict", "classify_skill_declared", "_CAPABILITY_TO_FLAG",
    "residual_mechanic_spans", "RESPOND_POWER_SETTLED_RE", "compound_clause_gaps",
    "respond_clause_gaps", "UNSETTLED_WORDS", "claimed_mechanic_words",
)

def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    src = os.environ.get("ROCO_SMOKE_SRC") or os.path.join(repo, "roco", "src")
    if not os.path.isdir(src):
        print(f"[smoke] FAIL 找不到引擎源码目录：{src}")
        return 2
    sys.path.insert(0, src)
    try:
        from roco_env import coverage, service  # noqa: F401
    except Exception as exc:                      # 入口 import 失败 = 服务必挂
        print(f"[smoke] FAIL 引擎入口 import 失败：{type(exc).__name__}: {exc}")
        return 1
    missing = [n for n in REQUIRED_EXPORTS if not hasattr(coverage, n)]
    if missing:
        print(f"[smoke] FAIL 缺少导出（服务会在就绪前退出）：{missing}")
        return 1
    # 行为级最小检查：分类器真的能跑（不是只有名字）
    from roco_env import data as data_mod
    rs = data_mod.load_ruleset()
    caps = coverage.declared_capabilities_of()
    skill = next(iter(rs.skills.values()))
    tier = coverage.classify_skill_declared(skill, caps)
    if "support" not in tier:
        print(f"[smoke] FAIL classify_skill_declared 回执缺 support：{tier}")
        return 1
    print(f"[smoke] OK src={src} exports={len(REQUIRED_EXPORTS)} tier({skill.skill_id})={tier['support']}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
