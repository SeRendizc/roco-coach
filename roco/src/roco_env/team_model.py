#!/usr/bin/env python3
"""G02 模型的服务端加载与评分（W3-04）。

三条硬约束，写死在代码里而不是写在文档里：

1. **只在过门槛时才加载。** `load_team_model()` 会检查模型文件里的
   `gate.passed`；不过门槛（或没有模型文件）就返回 `None`，
   调用方必须处理这个 `None` —— 不许有一个「能直接用的模型」绕开判定。
2. **必须显式声明对手池。** 模型的特征里有 6 维是对手的；没有对手池就没有输入。
   `score_team()` 的 `opponent_pool` 是**必填**位置参数。
3. **回执里必须能看出这不是胜率。** 返回值带 `not_a_winrate`、`calibration`、
   `limitations` 与来源报告路径。

模型文件的格式与生成方式见 `scripts/roco/train-team-model.py`；
模型本身是逻辑回归（12 维 + 标准化 + 温度缩放），所以加载与推理只用标准库。
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: 模型文件的默认位置（仓库相对）。
DEFAULT_MODEL_PATH = os.path.join("reports", "roco", "g02-team", "model.json")

#: 特征顺序必须与训练脚本的 `FEATURE_NAMES` 一致；不一致就直接拒绝加载。
FEATURE_ORDER = (
    "mine.types", "mine.roles", "mine.speed", "mine.damage", "mine.energy", "mine.gaps",
    "foe.types", "foe.roles", "foe.speed", "foe.damage", "foe.energy", "foe.gaps",
)

#: 规则分项的名字（与 `team.py` 的 Feature.name 一致）。
RULE_FEATURES = ("types", "roles", "speed", "damage", "energy", "gaps")


def repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


@dataclass(frozen=True)
class TeamModel:
    """一个**已过门槛**的阵容评分模型。没有过门槛时不会有这个对象。"""

    weights: Tuple[float, ...]
    intercept: float
    mean: Tuple[float, ...]
    std: Tuple[float, ...]
    temperature: float
    features: Tuple[str, ...]
    rows: int
    gate: Dict[str, Any]
    limitations: Tuple[str, ...]
    source_report: Optional[str]

    def score(self, x: Sequence[float]) -> float:
        z = self.intercept + sum(
            self.weights[j] * ((x[j] - self.mean[j]) / (self.std[j] or 1.0))
            for j in range(len(self.weights))
        )
        z = max(-30.0, min(30.0, z / (self.temperature or 1.0)))
        return 1.0 / (1.0 + math.exp(-z))


def load_team_model(path: Optional[str] = None) -> Optional[TeamModel]:
    """加载模型；**未过门槛或文件不存在都返回 None**。

    返回 None 不是错误：它表示「规则分是唯一的评分」。调用方据此降级，
    而不是回一个 0.5 之类的默认概率。
    """
    full = path or os.path.join(repo_root(), DEFAULT_MODEL_PATH)
    if not os.path.isabs(full):
        full = os.path.join(repo_root(), full)
    if not os.path.exists(full):
        return None
    try:
        with open(full, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if data.get("kind") != "logistic-team-score":
        return None
    if not (data.get("gate") or {}).get("passed"):
        # 未过门槛的模型一律不加载：这是门槛的硬约束。
        return None
    features = tuple(data.get("features") or ())
    if features != FEATURE_ORDER:
        # 特征顺序变了就必须重训；宁可不用，也不能错配权重。
        return None
    weights = tuple(float(v) for v in data.get("weights") or ())
    mean = tuple(float(v) for v in (data.get("standardization") or {}).get("mean") or ())
    std = tuple(float(v) for v in (data.get("standardization") or {}).get("std") or ())
    if not (len(weights) == len(mean) == len(std) == len(FEATURE_ORDER)):
        return None
    return TeamModel(
        weights=weights,
        intercept=float(data.get("intercept") or 0.0),
        mean=mean,
        std=std,
        temperature=float(data.get("temperature") or 1.0),
        features=features,
        rows=int(data.get("rows") or 0),
        gate=dict(data.get("gate") or {}),
        limitations=tuple(data.get("limitations") or ()),
        source_report=data.get("source_report"),
    )


def feature_vector(mine: Dict[str, float], foe: Dict[str, float]) -> List[float]:
    """按训练时的顺序拼 12 维特征。缺项按 0 处理（与训练脚本的 vectorize 一致）。"""
    out: List[float] = []
    for bucket in (mine, foe):
        for name in RULE_FEATURES:
            value = bucket.get(name)
            out.append(float(value) if isinstance(value, (int, float)) else 0.0)
    return out


def score_team(model: TeamModel,
               mine: Dict[str, float],
               foe: Dict[str, float],
               *,
               opponent_pool: Sequence[str]) -> Dict[str, Any]:
    """在**显式声明的对手池**下给出模型评分。

    `opponent_pool` 是必填的：它不是装饰，而是这条结论的适用范围。
    回执里把它原样带出去，读的人才知道「这个数是对着谁算的」。
    """
    if not opponent_pool:
        raise ValueError("必须先声明对手池：模型的特征里有 6 维是对手的，没有对手池就没有输入")
    probability = model.score(feature_vector(mine, foe))
    return {
        "probability": round(probability, 4),
        "opponent_pool": list(opponent_pool),
        "model": {
            "kind": "logistic-team-score",
            "rows": model.rows,
            "feature_order": list(FEATURE_ORDER),
            "gate_passed": True,
            "source_report": model.source_report,
        },
        "calibration": "simulated-vs-declared-opponent-pool",
        "not_a_winrate": True,
        "limitations": list(model.limitations),
        "note": (
            "这是在**指定对手池**下的模拟期望，不是一个胜率，也不是天梯强度。"
            "对手是启发式策略而不是真人；换一批对手是否成立**未经验证**。"
            "不得据此向玩家做强度排序或推荐「最强阵容」。"
        ),
    }
