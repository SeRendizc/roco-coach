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


def fit_temperature(logits: Sequence[float], y: Sequence[float]) -> float:
    """温度缩放：logit/T 后再取 sigmoid，用**验证集**最小化 log loss。

    这是标准做法，不是为了让指标好看：一个判别力弱（AUC 0.59）的模型天然会给
    过于极端的概率，温度只把「说得多肯定」压回实际频率。T 在验证集上选，
    测试集只用结果 —— 这一点写进报告。
    """
    def ll_at(t: float) -> float:
        p = [1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z / t)))) for z in logits]
        return log_loss(y, p)
    lo, hi = 0.05, 20.0
    for _ in range(60):                      # 三分搜索，够用且无依赖
        m1 = lo + (hi - lo) / 3
        m2 = hi - (hi - lo) / 3
        if ll_at(m1) < ll_at(m2):
            hi = m2
        else:
            lo = m1
    return (lo + hi) / 2


def apply_temperature(logits: Sequence[float], t: float) -> List[float]:
    return [1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z / t)))) for z in logits]


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

    # 规则分要变成概率才能算 log loss。**必须给它一个公平的映射**，
    # 否则「模型赢了规则分」只是因为规则分被故意压扁了。
    #
    # 这里给两种口径，两种都报：
    #   · raw      —— 线性缩放到 [0,1]（不拟合任何东西，最弱的口径）
    #   · platt    —— 在训练集上对这一维做 Platt 缩放（单变量逻辑回归，交叉熵最优）
    #                 这是**规则分能得到的最好校准**，所以门槛判定用这一条比。
    # 只用 raw 比是不公平的：那不是「规则分」，那是「规则分没校准」。
    rule_raw = {k: [rule_score(r) for r in parts[k]] for k in ("train", "val", "test")}

    def linear_prob(raw: List[float]) -> List[float]:
        lo, hi = min(rule_raw["train"]), max(rule_raw["train"])
        span = (hi - lo) or 1.0
        return [min(max((v - lo) / span, 1e-6), 1 - 1e-6) for v in raw]

    platt = Logistic(1, l2=1e-4, epochs=args.epochs).fit([[v] for v in rule_raw["train"]], y["train"])

    def platt_prob(raw: List[float]) -> List[float]:
        return [platt.predict([v]) for v in raw]

    # 在**验证集**上挑 L2（不是测试集）。给模型一个公平的调参机会，
    # 否则「模型没赢」可能只是正则强度没选对。
    candidates = []
    for l2 in (1e-4, 1e-3, 1e-2, 1e-1):
        fitted = Logistic(len(FEATURE_NAMES), l2=l2, epochs=args.epochs).fit(X["train"], y["train"])
        val_ll = log_loss(y["val"], [fitted.predict(x) for x in X["val"]])
        candidates.append((val_ll, l2, fitted))
    candidates.sort(key=lambda t: t[0])
    chosen_val_ll, chosen_l2, model = candidates[0]

    # 温度缩放在验证集上拟合，测试集只用结果。
    val_logits = [model.b + sum(model.w[j] * ((x[j] - model.mean[j]) / model.std[j])
                                for j in range(len(model.w))) for x in X["val"]]
    temperature = fit_temperature(val_logits, y["val"])

    report: Dict[str, Any] = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "data": args.data,
        "rows": len(rows),
        "features": FEATURE_NAMES,
        "split": parts["families"],
        "disclaimer": DISCLAIMER,
        "model": {"kind": "logistic-regression", "l2": chosen_l2, "epochs": args.epochs,
                  "temperature": round(temperature, 4), "temperature_fit_on": "val",
                  "l2_selected_on": "val", "val_log_loss_at_selection": round(chosen_val_ll, 4),
                  "l2_grid": [{"l2": l2, "val_log_loss": round(ll, 4)} for ll, l2, _ in sorted(candidates, key=lambda t: t[1])],
                  "weights": {name: round(w, 5) for name, w in zip(FEATURE_NAMES, model.w)},
                  "intercept": round(model.b, 5),
                  "standardization": {"mean": [round(m, 5) for m in model.mean],
                                      "std": [round(s, 5) for s in model.std]}},
        "evaluation": {},
    }

    def model_prob(xs: Sequence[Sequence[float]]) -> List[float]:
        out = []
        for x in xs:
            z = model.b + sum(model.w[j] * ((x[j] - model.mean[j]) / model.std[j])
                              for j in range(len(model.w)))
            out.append(1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z / temperature)))))
        return out

    gate = {}
    for part in ("val", "test"):
        p_model = model_prob(X[part])
        report["evaluation"][part] = {
            "model": metrics_for(y[part], p_model),
            # 规则分的两个口径都留着：判门槛用 platt（对规则分最有利的那个），
            # raw 留作「未校准的规则分长什么样」的对照。
            "rules": metrics_for(y[part], platt_prob(rule_raw[part])),
            "rules_uncalibrated": metrics_for(y[part], linear_prob(rule_raw[part])),
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
        "baseline_note": (
            "规则分那一栏用的是**在训练集上做过 Platt 缩放**的规则分（单变量逻辑回归，"
            "交叉熵最优）——也就是规则分能拿到的最好校准。用它比才算「模型 vs 规则分」，"
            "拿未校准的线性映射去比，赢的只是「没校准」这件事"
        ),
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

    # ── 只有**过门槛**才导出可加载的模型 ────────────────────────────────
    #
    # 这是门槛的硬约束，不是礼貌：不过门槛就不该有「能直接用的模型文件」，
    # 否则它迟早会被某个调用方 import 进去、绕开判定。
    # 导出文件自带来源与限制，服务端加载后会把它们原样带进回执。
    if passed:
        model_path = os.path.join(_ROOT, args.out, "model.json")
        with open(model_path, "w", encoding="utf-8") as fh:
            json.dump({
                "kind": "logistic-team-score",
                "schema_version": 1,
                "trained_at": report["generated_at"],
                "data": args.data,
                "rows": len(rows),
                "split": parts["families"],
                "features": FEATURE_NAMES,
                "weights": [model.w[j] for j in range(len(FEATURE_NAMES))],
                "intercept": model.b,
                "standardization": {"mean": list(model.mean), "std": list(model.std)},
                "temperature": temperature,
                "gate": {
                    "passed": True,
                    "criteria": report["gate"]["criteria"],
                    "test": {
                        "model": {k: report["evaluation"]["test"]["model"][k]
                                  for k in ("log_loss", "brier", "auc", "n")},
                        "rules": {k: report["evaluation"]["test"]["rules"][k]
                                  for k in ("log_loss", "brier", "auc")},
                    },
                },
                "limitations": [
                    "标签是**指定对手池**下的模拟结果，不是胜率，不是天梯强度。",
                    "对手是 5 条启发式策略，不是真人；换一批对手是否成立**未经验证**。",
                    "特征是与胜负相关的关系，不是游戏机制；权重不可解释为「速度更强」。",
                    "只在**显式声明对手池**时可用；没有对手池就没有模型的输入。",
                    "不得用于向玩家做强度排序或推荐「最强阵容」。",
                ],
                "how_to_use": (
                    "构造 12 维特征：我方与对手各自的规则分项 "
                    "(types/roles/speed/damage/energy/gaps)，"
                    "先按 standardization 标准化，再乘 weights 加 intercept，"
                    "最后除以 temperature 取 sigmoid。"
                ),
                "source_report": os.path.relpath(out_path, _ROOT),
            }, fh, ensure_ascii=False, indent=2)
        print(f"模型已导出（过门槛）：{os.path.relpath(model_path, _ROOT)}")
    else:
        # 不过门槛时**删掉**旧的导出文件，避免上次过门槛的模型被继续用
        stale = os.path.join(_ROOT, args.out, "model.json")
        if os.path.exists(stale):
            os.remove(stale)
            print("未过门槛：已删除旧的 model.json（不许留一个能直接用的模型）")

    print(json.dumps({
        "rows": len(rows), "split": parts["families"],
        "test_model": {k: report["evaluation"]["test"]["model"][k] for k in ("n", "log_loss", "brier", "auc")},
        "test_rules": {k: report["evaluation"]["test"]["rules"][k] for k in ("log_loss", "brier", "auc")},
        "test_rules_uncalibrated": {k: report["evaluation"]["test"]["rules_uncalibrated"][k] for k in ("log_loss", "brier", "auc")},
        "delta": report["evaluation"]["test"]["delta"],
        "ece": ece, "passed": bool(passed),
    }, ensure_ascii=False, indent=2))
    print(f"报告：{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
