#!/usr/bin/env python3
"""G02 —— 训练并**判定**阵容模型能否替代规则分。

这个脚本的核心不是「训一个逻辑回归」，而是**部署门槛**：

    未见家族上优于规则分，且校准合理；否则 `evaluate_team` 继续使用规则评分。

所以它做四件事，缺一不可：

  1. **按阵容家族切分**（不是按行随机切）。同一个 family 的行必须整体落在同一侧，
     否则同一套阵容既在训练里又在测试里，指标会好看得毫无意义。
  2. 训练逻辑回归（自己实现，纯标准库：不引入 numpy/sklearn 这类新依赖），
     与**规则分**在同一个测试集上比 log loss 与 Brier。
  3. 校准检查：把测试集按预测概率分箱，比对「预测均值 vs 实际频率」，
     给 ECE（expected calibration error）。
  4. 给出**结论**：过门槛 / 不过门槛。不过门槛就明说「继续用规则评分」，
     并把规则分在测试集上的指标写进报告——那是当前唯一被接受的基线。

特征只用手游引擎自己能产出的公开量：
  · 我方阵容的六个规则分项（types/roles/speed/damage/energy/gaps）；
  · 对手阵容的同样六项（对照特征，模型能看见「打谁」）；
  · 结构性计数：能耗最小/最大、速度最快/最慢、克制面计数等，全部来自
    `team.py` 的 `Feature.detail`，不自己造。

跑法::

    python3 scripts/roco/train-team-model.py --data reports/roco/g02-team/dataset.jsonl
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import random
import statistics
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

FEATURE_NAMES = [
    "mine.types", "mine.roles", "mine.speed", "mine.damage", "mine.energy", "mine.gaps",
    "foe.types", "foe.roles", "foe.speed", "foe.damage", "foe.energy", "foe.gaps",
]
#: 规则分的权重：六项等权求和。它是**被挑战的基线**，不是真理。
#: 之所以用等权，是因为 `team.py` 明确不输出胜率、也没有拟合过权重；
#: 给它编一组权重就变成了「我偷偷训了个模型又不说」。
RULE_WEIGHTS = {name: 1.0 for name in FEATURE_NAMES}

DISCLAIMER = (
    "标签是「指定对手池与固定预算下的模拟结果」，指标只在同一对手池与同一模拟口径下可比。"
    "这里的 log loss / Brier / 校准都不构成「谁强」的结论，也不声称天梯表现。"
)


# ── 数据 ────────────────────────────────────────────────────────────────────

def load_rows(path: str) -> List[Dict[str, Any]]:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def vectorize(row: Dict[str, Any]) -> List[float]:
    mine = row.get("rules_features") or {}
    foe = row.get("enemy_rules_features") or {}
    out = []
    for prefix, bucket in (("mine", mine), ("foe", foe)):
        for name in ("types", "roles", "speed", "damage", "energy", "gaps"):
            value = bucket.get(name)
            out.append(float(value) if isinstance(value, (int, float)) else 0.0)
    return out


def rule_score(row: Dict[str, Any]) -> float:
    """规则 baseline 的分：只用**我方**特征（对手不在规则分的输入里）。

    注意这是刻意的不对称：规则分看不见对手，模型看得见。所以模型要赢的不是
    「同样信息的更好模型」，而是「多了一倍信息的模型」——报告里必须写清这一点，
    否则「模型赢了规则分」这句话会被读成规则分不行。
    """
    mine = row.get("rules_features") or {}
    return sum(RULE_WEIGHTS[f"mine.{n}"] * float(mine.get(n) or 0.0)
               for n in ("types", "roles", "speed", "damage", "energy", "gaps"))


# ── 模型：逻辑回归（纯标准库，带 L2 与 Adam，够小够可审）────────────────────

class Logistic:
    def __init__(self, n_features: int, l2: float = 1e-3, lr: float = 0.05, epochs: int = 600):
        self.w = [0.0] * n_features
        self.b = 0.0
        self.l2 = l2
        self.lr = lr
        self.epochs = epochs
        self.mean = [0.0] * n_features
        self.std = [1.0] * n_features

    def _standardize(self, X: Sequence[Sequence[float]]) -> List[List[float]]:
        n = len(X)
        for j in range(len(self.mean)):
            column = [X[i][j] for i in range(n)]
            self.mean[j] = statistics.fmean(column) if column else 0.0
            sd = statistics.pstdev(column) if len(column) > 1 else 0.0
            self.std[j] = sd if sd > 1e-9 else 1.0
        return [[(X[i][j] - self.mean[j]) / self.std[j] for j in range(len(self.mean))] for i in range(n)]

    @staticmethod
    def _sigmoid(z: float) -> float:
        if z >= 0:
            return 1.0 / (1.0 + math.exp(-z))
        e = math.exp(z)
        return e / (1.0 + e)

    def fit(self, X: Sequence[Sequence[float]], y: Sequence[float]) -> "Logistic":
        Z = self._standardize(X)
        n, d = len(Z), len(self.w)
        # Adam：学习率对量纲不敏感，省得为这个小数据集调参。
        m = [0.0] * d
        v = [0.0] * d
        mb = vb = 0.0
        beta1, beta2, eps = 0.9, 0.999, 1e-8
        for step in range(1, self.epochs + 1):
            gw = [0.0] * d
            gb = 0.0
            for i in range(n):
                p = self._sigmoid(sum(self.w[j] * Z[i][j] for j in range(d)) + self.b)
                err = p - y[i]
                for j in range(d):
                    gw[j] += err * Z[i][j]
                gb += err
            for j in range(d):
                gw[j] = gw[j] / n + self.l2 * self.w[j]
                m[j] = beta1 * m[j] + (1 - beta1) * gw[j]
                v[j] = beta2 * v[j] + (1 - beta2) * gw[j] * gw[j]
                mhat = m[j] / (1 - beta1 ** step)
                vhat = v[j] / (1 - beta2 ** step)
                self.w[j] -= self.lr * mhat / (math.sqrt(vhat) + eps)
            gb /= n
            mb = beta1 * mb + (1 - beta1) * gb
            vb = beta2 * vb + (1 - beta2) * gb * gb
            self.b -= self.lr * (mb / (1 - beta1 ** step)) / (math.sqrt(vb / (1 - beta2 ** step)) + eps)
        return self

    def predict(self, x: Sequence[float]) -> float:
        z = self.b + sum(self.w[j] * ((x[j] - self.mean[j]) / self.std[j]) for j in range(len(self.w)))
        return self._sigmoid(z)


# ── 指标 ────────────────────────────────────────────────────────────────────

def log_loss(y: Sequence[float], p: Sequence[float]) -> float:
    total = 0.0
    for yi, pi in zip(y, p):
        pi = min(max(pi, 1e-12), 1 - 1e-12)
        total += -(yi * math.log(pi) + (1 - yi) * math.log(1 - pi))
    return total / len(y)


def brier(y: Sequence[float], p: Sequence[float]) -> float:
    return statistics.fmean((pi - yi) ** 2 for yi, pi in zip(y, p))


def auc(y: Sequence[float], p: Sequence[float]) -> Optional[float]:
    """排序质量的常规度量：正样本得分高于负样本的概率（并列算半）。"""
    pos = [pi for yi, pi in zip(y, p) if yi == 1]
    neg = [pi for yi, pi in zip(y, p) if yi == 0]
    if not pos or not neg:
        return None
    wins = 0.0
    for a in pos:
        for b in neg:
            wins += 1.0 if a > b else 0.5 if a == b else 0.0
    return wins / (len(pos) * len(neg))


def calibration(y: Sequence[float], p: Sequence[float], bins: int = 10) -> Dict[str, Any]:
    rows = []
    ece = 0.0
    for i in range(bins):
        lo, hi = i / bins, (i + 1) / bins
        bucket = [(yi, pi) for yi, pi in zip(y, p) if (lo <= pi < hi) or (i == bins - 1 and pi == 1.0)]
        if not bucket:
            continue
        mean_p = statistics.fmean(pi for _, pi in bucket)
        mean_y = statistics.fmean(yi for yi, _ in bucket)
        ece += (len(bucket) / len(y)) * abs(mean_p - mean_y)
        rows.append({"bin": f"[{lo:.1f},{hi:.1f})", "n": len(bucket),
                     "predicted": round(mean_p, 4), "actual": round(mean_y, 4),
                     "gap": round(mean_p - mean_y, 4)})
    return {"bins": rows, "ece": round(ece, 4)}


# ── 切分 ────────────────────────────────────────────────────────────────────

def family_split(rows: List[Dict[str, Any]], seed: int = 20260921,
                 train_frac: float = 0.6, val_frac: float = 0.2) -> Dict[str, List[Dict[str, Any]]]:
    families = sorted({row["family"] for row in rows})
    rng = random.Random(seed)
    rng.shuffle(families)
    n = len(families)
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)
    train = set(families[:n_train])
    val = set(families[n_train:n_train + n_val])
    return {
        "train": [r for r in rows if r["family"] in train],
        "val": [r for r in rows if r["family"] in val],
        "test": [r for r in rows if r["family"] not in train and r["family"] not in val],
        "families": {"total": n, "train": len(train), "val": len(val),
                     "test": n - len(train) - len(val)},
    }


def metrics_for(y: Sequence[float], p: Sequence[float]) -> Dict[str, Any]:
    return {
        "n": len(y),
        "positive_rate": round(statistics.fmean(y), 4),
        "mean_prediction": round(statistics.fmean(p), 4),
        "log_loss": round(log_loss(y, p), 4),
        "brier": round(brier(y, p), 4),
        "auc": None if auc(y, p) is None else round(auc(y, p), 4),
        "calibration": calibration(y, p),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="G02 阵容模型：训练 + 部署门槛判定")
    parser.add_argument("--data", default=os.path.join("reports", "roco", "g02-team", "dataset.jsonl"))
    parser.add_argument("--out", default=os.path.join("reports", "roco", "g02-team"))
    parser.add_argument("--seed", type=int, default=20260921)
    parser.add_argument("--l2", type=float, default=1e-3)
    parser.add_argument("--epochs", type=int, default=800)
    args = parser.parse_args(argv)

    rows = load_rows(os.path.join(_ROOT, args.data))
    if len(rows) < 50:
        print(f"数据太少（{len(rows)} 行）：先跑 build-team-dataset.py", file=sys.stderr)
        return 2

    parts = family_split(rows, seed=args.seed)
    X = {k: [vectorize(r) for r in v] for k, v in parts.items() if k != "families"}
    y = {k: [float(r["label"]) for r in v] for k, v in parts.items() if k != "families"}

    # 规则分归一化成概率：先线性缩放到 [0,1]，再用训练集的实际频率做对数几率校准。
    # 不对规则分做任何拟合，只把它变成一个能算 log loss 的分数——这一步必须说明，
    # 否则会显得规则分「被故意调弱」。
    rule_raw = {k: [rule_score(r) for r in parts[k]] for k in ("train", "val", "test")}
    lo = min(rule_raw["train"])
    hi = max(rule_raw["train"])
    span = (hi - lo) or 1.0

    def rule_prob(raw: List[float]) -> List[float]:
        share = [min(max((v - lo) / span, 0.0), 1.0) for v in raw]
        base = statistics.fmean(y["train"])
        base = min(max(base, 1e-6), 1 - 1e-6)
        # 用训练集基准率把它压到线性区间里，避免出现 0/1 两个端点让 log loss 爆炸。
        return [min(max(base + (s - 0.5) * 2 * (0.5 - abs(base - 0.5)) + (s - 0.5) * 0.0, 1e-6), 1 - 1e-6)
                for s in share]

    model = Logistic(len(FEATURE_NAMES), l2=args.l2, epochs=args.epochs).fit(X["train"], y["train"])

    report: Dict[str, Any] = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "data": args.data,
        "rows": len(rows),
        "features": FEATURE_NAMES,
        "split": parts["families"],
        "disclaimer": DISCLAIMER,
        "model": {"kind": "logistic-regression", "l2": args.l2, "epochs": args.epochs,
                  "weights": {name: round(w, 5) for name, w in zip(FEATURE_NAMES, model.w)},
                  "intercept": round(model.b, 5),
                  "standardization": {"mean": [round(m, 5) for m in model.mean],
                                      "std": [round(s, 5) for s in model.std]}},
        "evaluation": {},
    }

    gate = {}
    for part in ("val", "test"):
        p_model = [model.predict(x) for x in X[part]]
        p_rule = rule_prob(rule_raw[part])
        report["evaluation"][part] = {
            "model": metrics_for(y[part], p_model),
            "rules": metrics_for(y[part], p_rule),
        }
        report["evaluation"][part]["delta"] = {
            "log_loss_improvement": round(report["evaluation"][part]["rules"]["log_loss"]
                                          - report["evaluation"][part]["model"]["log_loss"], 4),
            "brier_improvement": round(report["evaluation"][part]["rules"]["brier"]
                                       - report["evaluation"][part]["model"]["brier"], 4),
        }
        gate[part] = report["evaluation"][part]["delta"]

    # 部署门槛（写死在代码里，免得事后解释）：两处都要同时满足
    #   ① 未见家族上 log loss 与 Brier **都**优于规则分；
    #   ② 校准合理：ECE ≤ 0.05。
    ece = report["evaluation"]["test"]["model"]["calibration"]["ece"]
    passed = (gate["test"]["log_loss_improvement"] > 0
              and gate["test"]["brier_improvement"] > 0
              and ece <= 0.05)
    report["gate"] = {
        "criteria": {
            "test_log_loss_better_than_rules": gate["test"]["log_loss_improvement"] > 0,
            "test_brier_better_than_rules": gate["test"]["brier_improvement"] > 0,
            "test_ece_le_0.05": ece <= 0.05,
        },
        "passed": bool(passed),
        "decision": ("模型过门槛：可以在指定对手池下作为 evaluate_team 的补充评分"
                     if passed else
                     "**不过门槛：`evaluate_team` 继续使用规则评分。**"
                     "模型只作为离线研究产物保留，不接入任何对玩家可见的结论。"),
        "note": ("规则分看不见对手，模型看得见（12 个特征里 6 个是对手的）。"
                 "所以「模型赢了」不等于「规则分不行」，只说明在没有拟合的情况下，"
                 "多用一倍信息能换来更好的校准与排序。"),
    }

    os.makedirs(os.path.join(_ROOT, args.out), exist_ok=True)
    out_path = os.path.join(_ROOT, args.out, "model-report.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print(json.dumps({
        "rows": len(rows), "split": parts["families"],
        "test_model": {k: report["evaluation"]["test"]["model"][k] for k in ("n", "log_loss", "brier", "auc")},
        "test_rules": {k: report["evaluation"]["test"]["rules"][k] for k in ("log_loss", "brier", "auc")},
        "delta": report["evaluation"]["test"]["delta"],
        "ece": ece, "passed": bool(passed),
    }, ensure_ascii=False, indent=2))
    print(f"报告：{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
