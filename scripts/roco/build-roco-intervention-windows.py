#!/usr/bin/env python3
"""W5-04 v3：用**手游引擎自己**的边际量重建窗口集。

为什么必须重建（第 18 轮量出来的）：旧演示引擎的一手推演分差中位数是 **3.06**、
37% 超过 5；手游引擎的 `first_second_margin` 落在 **0.024—0.082**，差约 100 倍。
两把尺子不可通约，所以 v2 的标签阈值（>5）与模型系数都搬不过来。

这一轮把标签与阈值都改成**手游引擎自己的口径**：

标签（全部决策前可得）
    正类：`phase == 'replace'`（必须补位）**或** 场上血量 ≤ 35% **或**
          边际量 ≥ 该引擎观测分布的 **75 分位**（咬得很紧 = 真的两难）
    负类：其余

切分：与 v2 相同的 `seed % 5` 三分 + 一个完全留出的种子区间做 family 外。

明确不做
    - 不用旧引擎的任何分数（那是另一把尺子）；
    - 不用胜负、不用模拟回报、不用模型分数当标签；
    - 不改判据阈值去凑通过。

用法::

    .venv-agent/bin/python scripts/roco/build-roco-intervention-windows.py
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402

OUT = os.path.join(_ROOT, "tests", "evals", "roco", "intervention-windows-roco.jsonl")
ROSTER = ("寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬")
LOW_HP = 0.35                 # 与 experience.situationRisk 的 0.35 危险血线一致
#: 种子数按「每局最多 6 个窗口」估：400 个种子 ≈ 1,600 个窗口，够 train/val/test 三分。
TRAIN_SEEDS = [s for s in range(1, 401) if s % 5 in (0, 1, 2)]
VAL_SEEDS = [s for s in range(1, 401) if s % 5 == 3]
TEST_SEEDS = [s for s in range(1, 401) if s % 5 == 4]
OOD_SEEDS = list(range(90000, 90120))
MARGIN_QUANTILE = 0.75        # 只在**训练侧**估；val/test/ood 用同一个数，避免泄漏


def split_of(seed: int) -> str:
    if seed >= 90000:
        return "ood"
    bucket = seed % 5
    if bucket == 3:
        return "val"
    if bucket == 4:
        return "test"
    return "train"


def hp_ratio(state, rs, side: str = "player") -> float:
    s = getattr(state, side)
    pet = s.pets[s.active] if s.pets else None
    if pet is None or pet.max_hp <= 0:
        return 0.0
    return max(0.0, pet.hp) / pet.max_hp


def collect(seeds: List[int], teams: List[str]) -> List[Dict[str, Any]]:
    """在一个对称 fixture 上逐回合取窗口。**确定性**：同一 seed 同一结果。"""
    rs = rdata.load_ruleset()
    rows: List[Dict[str, Any]] = []
    for seed in seeds:
        state = renv.reset(teams, teams, seed=seed, rs=rs)
        for step in range(6):
            if state.result:
                break
            if state.phase == "replace":
                rows.append({"seed": seed, "turn": state.turn, "phase": "replace",
                             "hp_ratio": round(hp_ratio(state, rs), 4),
                             "margin": None, "legal_count": len(renv.legal_actions(state, rs, "player"))})
            else:
                plan = pm.plan_actions(state, rs, budget_ms=400)
                legal = renv.legal_actions(state, rs, "player")
                if not legal:
                    break
                rows.append({"seed": seed, "turn": state.turn, "phase": state.phase,
                             "hp_ratio": round(hp_ratio(state, rs), 4),
                             "margin": plan.first_second_margin,
                             "legal_count": len(legal)})
            if state.phase == "replace":
                # 补位必须走 step_replace；step_joint 会明确拒绝（它的错误信息就是这么写的）。
                for side in list(renv.needs_replacement(state)):
                    legal = [a for a in renv.legal_actions(state, rs, side) if a.kind == "switch"]
                    if not legal or state.phase != "replace":
                        continue
                    renv.step_replace(state, rs, side, int(legal[(seed + step) % len(legal)].target_index))
                continue
            acts = renv.legal_actions(state, rs, "player")
            enemy = renv.legal_actions(state, rs, "enemy")
            if not acts or not enemy:
                break
            # 确定性推进：按 (seed + 步数) 轮换，与窗口生成保持同一种可复现口径。
            # `step_joint` 返回**新状态**（旧版本是原地改），必须接住返回值，
            # 否则循环会一直在同一个局面上打转（第一版就是这样）。
            state = renv.step_joint(state, rs, acts[(seed + step) % len(acts)],
                                    enemy[(seed + step) % len(enemy)])
            if state is None:
                break
    return rows


def label_row(row: Dict[str, Any], margin_threshold: float) -> Dict[str, Any]:
    if row["phase"] == "replace":
        return {"label": True, "reason": "must-replace"}
    if row["hp_ratio"] <= LOW_HP:
        return {"label": True, "reason": "critical-risk"}
    if row["margin"] is not None and row["margin"] >= margin_threshold:
        return {"label": True, "reason": "tight-margin"}
    return {"label": False, "reason": "steady-position"}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="用手游引擎的边际量重建介入窗口集")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    teams = [rs.pets_by_name(name)[0].pet_id for name in ROSTER[:3]]

    train_rows = collect(TRAIN_SEEDS, teams)
    margins = [row["margin"] for row in train_rows if row["margin"] is not None]
    if len(margins) < 10:
        sys.stderr.write("训练侧边际量样本太少，无法标定阈值\n")
        return 2
    margins.sort()
    threshold = margins[min(len(margins) - 1, int(MARGIN_QUANTILE * len(margins)))]
    threshold = round(threshold, 6)

    all_rows: List[Dict[str, Any]] = []
    for seeds in (TRAIN_SEEDS, VAL_SEEDS, TEST_SEEDS, OOD_SEEDS):
        for row in collect(seeds, teams):
            truth = label_row(row, threshold)
            all_rows.append({**row,
                             "split": split_of(row["seed"]),
                             # 与 v2 的窗口集保持同一套字段名，训练脚本可以复用
                             "truth_v2": truth,
                             "truth": truth,
                             "risk": 1.0 if row["phase"] == "replace"
                                     else (0.8 if row["hp_ratio"] <= LOW_HP else 0.2),
                             "legalCount": row["legal_count"],
                             "plannerMargin": row["margin"],
                             "hpRatio": row["hp_ratio"]})

    by_split = {}
    for row in all_rows:
        bucket = by_split.setdefault(row["split"], {"windows": 0, "positive": 0})
        bucket["windows"] += 1
        if row["truth_v2"]["label"]:
            bucket["positive"] += 1

    header = {
        "record_type": "intervention_window_set_header",
        "set_id": "intervention-windows-roco-v1",
        "built_by": "scripts/roco/build-roco-intervention-windows.py",
        "engine": "手游规则引擎（roco_env.planner）",
        "preregistration": "docs/roco/W5-04-INTERVENTION-GATE.md",
        "margin_threshold": threshold,
        "margin_quantile": MARGIN_QUANTILE,
        "margin_threshold_basis": (
            "训练侧观测边际量的 75 分位。**必须按本引擎标定**：旧演示引擎的分差中位数是 3.06，"
            "本引擎是 0.04 量级，两把尺子差约 100 倍（见预注册文档 §10.4）。"),
        "label_basis": "决策前可得的观察量：必须补位 / 血量≤35% / 边际量≥本引擎 75 分位",
        "split_rule": "seed % 5：0-2 train / 3 val / 4 test；seed ≥ 90000 为 family 外",
        "low_hp_line": LOW_HP,
        "summary": {"total": len(all_rows), "by_split": by_split,
                    "margin": {"n": len(margins), "min": round(margins[0], 6),
                               "median": round(margins[len(margins) // 2], 6),
                               "p75": threshold, "max": round(margins[-1], 6)}},
        "disciplines": [
            "标签只用决策前可得的观察量；不用胜负、不用模拟回报、不用模型分数",
            "阈值只在**训练侧**估，val/test/family 外共用同一个数，不存在跨侧泄漏",
            "同一 seed 的所有回合只出现在一侧",
            "产物确定性：没有时间戳、没有随机、没有 HEAD",
        ],
    }
    if args.write:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(header, ensure_ascii=False) + "\n")
            for row in all_rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"written": args.write, "out": OUT if args.write else None,
                      "threshold": threshold, "summary": header["summary"]},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
