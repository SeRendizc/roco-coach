#!/usr/bin/env python3
"""把候选里带 `team` 的目标过**真引擎**（不是 JS 侧 `validToolArgs`）—— 跨模块整合的最硬一档。

## 为什么要有它

候选审核目前只过了**产品自己的 JS 校验器**（`validToolArgs`）与"指纹/规则集没漂"的推理。
**推理不等于测量**：这一程已经因为"看着应该对"栽过多次。
引擎侧真正管 `team` 的是 `roco/src/roco_env/env.py:445 validate_team(rs, team, loadouts=…, team_size=…)`。

## ⚠ 规则集**走生产那条路**（`data.load_ruleset()`）

第一版想复用 `scripts/roco/audit-roster-48.py` 的 `build_ruleset()`，结果撞上
**那个脚本已经腐烂**：`Ruleset.__init__() missing 1 required positional argument: 'build_support'`
⇒ **它今天跑不起来**（对不上当前引擎的 `Ruleset` 签名）。**已如实记在交付里**，没去"顺手修"它
（不在本任务范围，且它是别人的脚本）。

⇒ 改用**生产真正用的**入口：`roco_env.data.load_ruleset()`（`env.py:187` 与 `:2606` 都走它）。

用法：`.venv-mlx/bin/python scripts/roco/verify-candidate-teams.py`
退出码：0 = 全部被引擎接受；2 = 有候选被引擎拒（**那些标签不可用**）。
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAND = ROOT / "reports" / "roco" / "sft-v9-candidates"


def main() -> int:
    sys.path.insert(0, str(ROOT / "roco" / "src"))
    import roco_env.env as renv  # noqa: E402

    rows = []
    for sp in ("train", "valid", "test"):
        p = CAND / f"{sp}.jsonl"
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf8").split("\n"):
            if line.strip():
                r = json.loads(line)
                rows.append((sp, r["meta"].get("group_id"), json.loads(r["messages"][1]["content"])))

    targets = [(sp, gid, t) for sp, gid, t in rows
               if not t.get("stop") and (t.get("args", {}).get("team") or t.get("args", {}).get("team_after"))]
    print(f"[引擎验] 候选 {len(rows)} 条｜带 team 的 {len(targets)} 条")

    # 规则集：**生产那条路**（候选声明的 ruleset_id 就是它）
    import roco_env.data as rdata  # noqa: E402
    rs = rdata.load_ruleset("roco-world-s4-2026-09-10")

    bad = []
    for sp, gid, t in targets:
        team = t["args"].get("team") or t["args"].get("team_after")
        try:
            problems = renv.validate_team(rs, list(team), team_size=len(team))
        except TypeError:
            problems = renv.validate_team(rs, list(team))
        if problems:
            bad.append({"split": sp, "group": gid, "team": team, "problems": problems})

    print(f"[引擎验] 被引擎接受的: {len(targets) - len(bad)} / {len(targets)}")
    for b in bad[:5]:
        print(f"  ✖ {b['split']}｜{b['group']}｜{b['team']}｜{b['problems']}")
    if bad:
        print("[引擎验] ⇒ 这些候选的 team **引擎不认** ⇒ 标签不可用（要么改标签、要么改样本）")
        return 2
    print("[引擎验] ⇒ 全部被真引擎接受（不是「看着应该对」，是量过）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
