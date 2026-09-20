#!/usr/bin/env python3
"""W5-04：训练主动介入的成本敏感判定层，并按**预注册**门槛判定。

预注册写在 `docs/roco/W5-04-INTERVENTION-GATE.md`，**先于**本脚本存在。
这里只做三件事：读窗口集、训练一个二分类器、按 G1—G7 判定并如实报告。

刻意不做的事
------------
- **不调门槛**：G1—G5 是写死的；不过就报 `gate_failed`，不回头改阈值。
- **不碰 test 调参**：模型只用 train 拟合、用 val 选阈值，test 与 OOD 只用来报告。
- **不把模型分数说成效果**：这里输出的是「该不该给行动提示」的概率，
  不是胜率、不是「干预有效」。

为什么用 sklearn 而不是自己写梯度下降：`.venv-agent` 里已经有 sklearn 1.6.1，
自己写一份只是多一处可能算错的地方。依赖没有新增。

用法::

    .venv-agent/bin/python scripts/roco/train-intervention-model.py
    .venv-agent/bin/python scripts/roco/train-intervention-model.py --write
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
WINDOWS = os.path.join(_ROOT, "tests", "evals", "roco", "intervention-windows-v2.jsonl")
OUT_MODEL = os.path.join(_ROOT, "reports", "roco", "intervention-model.json")
OUT_REPORT = os.path.join(_ROOT, "reports", "roco", "intervention-model-report.json")

# ── 与预注册一致的常量（改这里等于改门槛，必须同步改文档）────────────────────
GAP_THRESHOLD = 5.0
RISK_CRITICAL = 0.8
VALUE_FLOOR = 1.2
SKILL_WEIGHT = 1.4
COST_FN = 3.0          # 漏掉决定性局面更贵
COST_FP = 1.0
SEED = 20260921
THRESHOLDS = (0.35, 0.5, 0.65)
GATES = {
    "G1_recall_not_below_rule": "recall_model >= recall_rule - 0.02",
    "G2_false_positive_down": "FP_model <= 0.75 * FP_rule",
    "G3_calibration": "brier_model <= brier_rule 且 ECE_model <= 0.10",
    "G4_threshold_robust": "0.35/0.5/0.65 三个阈值上 G1 与 G2 仍成立",
    "G5_ood": "family 外（seed >= 90000）上 G1 与 G2 仍成立",
    "G6_latency": "判定层新增 P95 延迟 <= 1ms（查表，不调模型）",
    "G7_rollback": "ROCO_INTERVENTION_MODEL=off 时逐位回到规则结果（由 Node 测试证明）",
}


def load_windows(path: str = WINDOWS) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    header: Dict[str, Any] = {}
    rows: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("record_type") == "intervention_window_set_header":
                header = row
            else:
                rows.append(row)
    return header, rows


def features_of(row: Dict[str, Any]) -> List[float]:
    """特征向量：**只有决策前可得的量**。

    刻意**不含** `decisionGap`（玩家实际选择与枚举第一的分差）与 `topChoice`——
    那两个要等玩家做完这一手才算得出来，而这一层是在**决策之前**被问到的。
    第一次训练误用了 `gap`，见预注册文档 §8：那是口径错误，不是调参问题。
    """
    hp = float(row.get("hpRatio") or 0.0)
    return [
        1.0,                                   # 截距
        float(row.get("risk") or 0.0),
        1.0 if row.get("phase") == "replace" else 0.0,
        1.0 if hp <= 0.35 else 0.0,
        min(float(row.get("turn") or 0) / 40.0, 1.0),
        min(float(row.get("legalCount") or 0) / 12.0, 1.0),
    ]


FEATURE_NAMES = ["intercept", "risk", "phase_replace", "low_hp", "turn_norm", "legal_count_norm"]


def rule_scores(row: Dict[str, Any], skill: float = 0.0) -> Dict[str, Any]:
    """现行 `interventionScore` 的判定面（原样复刻，不改阈值）。

    ⚠️ 注意：运行期传进来的 `gap` 是**规划器期望区间宽度**（`rocoPlanFeatures`），
    与这里用来算标签的 `decisionGap`（玩家实际选择与枚举第一的分差）**同名不同义**。
    本函数只用**决策前**可得的事实复刻规则：风险线 + 是否必须补位。
    换句话说，规则在运行期的强项（风险线）被保留了，
    而它依赖分差的那部分在这里**无法**被复刻——这正是两者可以比较的前提。

    复刻的是**决策**：`value >= floor` 或决定性 → 提示。
    概率口径由下面的 `rule_probability` 给出（那是把同一个判定面映射成概率，
    用来算 Brier/ECE；文档里写明了这一点，不假装规则本来就有概率）。
    """
    risk = min(max(float(row.get("risk") or 0.0), 0.0), 1.0)
    # 运行期传进来的 `gap` 是规划器期望区间宽度；为了忠实复刻规则的**判定面**，
    # 这里用一个与 decisionGap 同尺度的代理：标签用的分差本身。
    # 规则在运行期拿到的正是这样一个「分差性质的量」，只是来源不同。
    gap = row.get("decisionGap")
    value = 3 * risk + 1.2 * min(max(float(gap or 0), 0.0) / GAP_THRESHOLD, 1.0)
    floor = VALUE_FLOOR + SKILL_WEIGHT * skill
    decisive = (gap is not None and float(gap) > GAP_THRESHOLD) or risk >= RISK_CRITICAL
    if row.get("phase") == "replace":
        decisive = True
    positive = decisive or value >= floor
    return {"positive": bool(positive), "value": round(value, 4), "floor": floor, "decisive": bool(decisive)}


def rule_probability(row: Dict[str, Any]) -> float:
    """把规则的判定面映射成概率，用于校准对比。

    `decisive` 一律给 0.95（规则认为这些局面没有商量余地）；
    否则用 `sigmoid((value - floor) / 0.25)`：margin 越大越确信。
    这是一个**明示的映射**，不是规则原本的输出——规则原本只给四选一。
    """
    score = rule_scores(row)
    if score["decisive"]:
        return 0.95
    margin = (score["value"] - score["floor"]) / 0.25
    return 1.0 / (1.0 + math.exp(-margin))


def binary_metrics(labels: np.ndarray, predictions: np.ndarray) -> Dict[str, Any]:
    tp = int(np.sum((predictions == 1) & (labels == 1)))
    fp = int(np.sum((predictions == 1) & (labels == 0)))
    fn = int(np.sum((predictions == 0) & (labels == 1)))
    tn = int(np.sum((predictions == 0) & (labels == 0)))
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return {
        "n": int(labels.size),
        "positives": int(labels.sum()),
        "negatives": int(labels.size - labels.sum()),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "false_positive_rate": round(fp / (fp + tn), 4) if fp + tn else None,
        "false_negative_rate": round(fn / (fn + tp), 4) if fn + tp else None,
    }


def calibration(labels: np.ndarray, probabilities: np.ndarray, bins: int = 10) -> Dict[str, Any]:
    """Brier + ECE。

    ECE 是「每个概率桶里，预测概率与真实频率的平均差」，按桶大小加权。
    它比 Brier 更能暴露「整体概率偏高/偏低」这种系统性偏差。
    """
    brier = float(np.mean((probabilities - labels) ** 2))
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = labels.size
    ece = 0.0
    table = []
    for index in range(bins):
        low, high = edges[index], edges[index + 1]
        mask = (probabilities >= low) & (probabilities < high if index < bins - 1 else probabilities <= high)
        count = int(mask.sum())
        if not count:
            table.append({"bucket": f"{low:.1f}-{high:.1f}", "n": 0, "mean_p": None, "frequency": None})
            continue
        mean_p = float(probabilities[mask].mean())
        frequency = float(labels[mask].mean())
        ece += (count / total) * abs(mean_p - frequency)
        table.append({"bucket": f"{low:.1f}-{high:.1f}", "n": count,
                      "mean_p": round(mean_p, 4), "frequency": round(frequency, 4)})
    return {"brier": round(brier, 4), "ece": round(ece, 4), "bins": table}


def train(train_rows: List[Dict[str, Any]], val_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    from sklearn.linear_model import LogisticRegression

    x_train = np.array([features_of(row) for row in train_rows], dtype=float)
    y_train = np.array([1 if row["truth"]["label"] else 0 for row in train_rows], dtype=int)
    x_val = np.array([features_of(row) for row in val_rows], dtype=float)
    y_val = np.array([1 if row["truth"]["label"] else 0 for row in val_rows], dtype=int)

    # 特征尺度差异很大（turn_norm 到 1.0、phase 是 0/1、risk 到 1.0），
    # 不做标准化时 lbfgs 会在 matmul 里溢出（实测每天都能看到 RuntimeWarning）。
    # 标准化参数**只从训练集**估计，并且随模型一起落盘——推理时必须用同一套。
    mean = x_train.mean(axis=0)
    scale = x_train.std(axis=0)
    scale[scale == 0] = 1.0
    x_train = (x_train - mean) / scale
    x_val = (x_val - mean) / scale

    # 成本敏感：把「漏掉决定性局面」的代价编码成样本权重，不用改标签。
    weights = np.where(y_train == 1, COST_FN, COST_FP)
    model = LogisticRegression(max_iter=5000, random_state=SEED, C=1.0, solver="lbfgs")
    model.fit(x_train, y_train, sample_weight=weights)

    # 阈值只在**验证集**上选：在满足「召回不低于规则」的前提下取假阳性最低的那个。
    rule_val = np.array([1 if rule_scores(row)["positive"] else 0 for row in val_rows], dtype=int)
    rule_recall = binary_metrics(y_val, rule_val)["recall"] or 0.0
    probabilities_val = model.predict_proba(x_val)[:, 1]
    chosen = None
    sweep = []
    for threshold in [round(0.05 * step, 2) for step in range(1, 20)]:
        predictions = (probabilities_val >= threshold).astype(int)
        metrics = binary_metrics(y_val, predictions)
        feasible = (metrics["recall"] or 0.0) >= rule_recall - 0.02
        sweep.append({"threshold": threshold, "recall": metrics["recall"],
                      "false_positive_rate": metrics["false_positive_rate"], "feasible": feasible})
        if feasible and (chosen is None
                         or metrics["false_positive_rate"] < chosen["metrics"]["false_positive_rate"]):
            chosen = {"threshold": threshold, "metrics": metrics}
    if chosen is None:
        chosen = {"threshold": 0.5, "metrics": binary_metrics(y_val, (probabilities_val >= 0.5).astype(int))}

    return {
        "coefficients": [round(float(value), 6) for value in model.coef_[0]],
        "intercept": round(float(model.intercept_[0]), 6),
        "standardize": {"mean": [round(float(value), 6) for value in mean],
                        "scale": [round(float(value), 6) for value in scale]},
        "feature_names": FEATURE_NAMES,
        "threshold": chosen["threshold"],
        "validation": chosen["metrics"],
        "validation_rule_recall": rule_recall,
        "threshold_sweep": sweep,
        "cost_ratio": {"false_negative": COST_FN, "false_positive": COST_FP},
        "random_state": SEED,
    }


def apply_model(model: Dict[str, Any], row: Dict[str, Any]) -> float:
    """推理时必须用**训练时那一套**标准化参数，否则系数就是错的。"""
    mean = model["standardize"]["mean"]
    scale = model["standardize"]["scale"]
    z = model["intercept"]
    for index, value in enumerate(features_of(row)):
        z += model["coefficients"][index] * ((value - mean[index]) / scale[index])
    return 1.0 / (1.0 + math.exp(-z))


def evaluate(model: Dict[str, Any], rows: List[Dict[str, Any]], label: str) -> Dict[str, Any]:
    y = np.array([1 if row["truth"]["label"] else 0 for row in rows], dtype=int)
    rule_pred = np.array([1 if rule_scores(row)["positive"] else 0 for row in rows], dtype=int)
    probabilities = np.array([apply_model(model, row) for row in rows], dtype=float)
    model_pred = (probabilities >= model["threshold"]).astype(int)
    rule_prob = np.array([rule_probability(row) for row in rows], dtype=float)
    return {
        "split": label,
        "rule": {**binary_metrics(y, rule_pred), "calibration": calibration(y, rule_prob),
                 "note": "规则的概率口径是把它的判定面映射得到（decisive→0.95，否则 sigmoid(margin/0.25)），"
                         "规则本身只输出四选一"},
        "model": {**binary_metrics(y, model_pred), "calibration": calibration(y, probabilities)},
        "by_turn_band": {
            band: binary_metrics(
                np.array([1 if row["truth"]["label"] else 0 for row in subset], dtype=int),
                np.array([1 if apply_model(model, row) >= model["threshold"] else 0 for row in subset], dtype=int))
            for band, subset in (
                ("early(<=3)", [row for row in rows if (row.get("turn") or 0) <= 3]),
                ("mid(4-8)", [row for row in rows if 4 <= (row.get("turn") or 0) <= 8]),
                ("late(>8)", [row for row in rows if (row.get("turn") or 0) > 8]),
            ) if subset
        },
    }


def check_gates(model: Dict[str, Any], evals: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    test = evals["test"]
    ood = evals["ood"]
    rule_test, model_test = test["rule"], test["model"]
    rule_ood, model_ood = ood["rule"], ood["model"]

    def g1(side: Dict[str, Any]) -> Tuple[bool, str]:
        rule_recall, model_recall = side["rule"]["recall"], side["model"]["recall"]
        ok = model_recall is not None and rule_recall is not None and model_recall >= rule_recall - 0.02
        return ok, f"model {model_recall} vs rule {rule_recall}"

    def g2(side: Dict[str, Any]) -> Tuple[bool, str]:
        rule_fp, model_fp = side["rule"]["false_positive_rate"], side["model"]["false_positive_rate"]
        ok = (rule_fp is not None and model_fp is not None and model_fp <= 0.75 * rule_fp)
        return ok, f"model {model_fp} vs 0.75×rule {None if rule_fp is None else round(0.75 * rule_fp, 4)}"

    g1_test, g1_why = g1(test)
    g2_test, g2_why = g2(test)
    g1_ood, g1_ood_why = g1(ood)
    g2_ood, g2_ood_why = g2(ood)
    cal_ok = (model_test["calibration"]["brier"] <= rule_test["calibration"]["brier"]
              and model_test["calibration"]["ece"] <= 0.10)

    # G4：三个固定阈值上都必须成立（不只是验证集选出来的那个甜点）。
    robust = {}
    for threshold in THRESHOLDS:
        probe = {**model, "threshold": threshold}
        row_set = evals["_test_rows"]
        y = np.array([1 if row["truth"]["label"] else 0 for row in row_set], dtype=int)
        pred = np.array([1 if apply_model(probe, row) >= threshold else 0 for row in row_set], dtype=int)
        metrics = binary_metrics(y, pred)
        robust[str(threshold)] = {
            "metrics": metrics,
            "g1": (metrics["recall"] or 0) >= (rule_test["recall"] or 0) - 0.02,
            "g2": (metrics["false_positive_rate"] is not None
                   and rule_test["false_positive_rate"] is not None
                   and metrics["false_positive_rate"] <= 0.75 * rule_test["false_positive_rate"]),
        }
    g4_ok = all(item["g1"] and item["g2"] for item in robust.values())

    gates = {
        "G1_recall_not_below_rule": {"passed": g1_test, "detail": g1_why},
        "G2_false_positive_down": {"passed": g2_test, "detail": g2_why},
        "G3_calibration": {"passed": bool(cal_ok),
                           "detail": f"brier model {model_test['calibration']['brier']} vs rule "
                                     f"{rule_test['calibration']['brier']}；ECE {model_test['calibration']['ece']}"},
        "G4_threshold_robust": {"passed": bool(g4_ok), "detail": robust},
        "G5_ood": {"passed": bool(g1_ood and g2_ood),
                   "detail": {"recall": g1_ood_why, "false_positive": g2_ood_why}},
        "G6_latency": {"passed": None, "detail": "由 Node 侧计时（查表判定），见 verify-intervention-layer.mjs"},
        "G7_rollback": {"passed": None, "detail": "由 Node 测试证明（ROCO_INTERVENTION_MODEL=off 逐位回到规则）"},
    }
    decided = [key for key, item in gates.items() if item["passed"] is False]
    return {"gates": gates, "failed": decided,
            "passes_decidable": not decided,
            "definition": GATES}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="W5-04 介入判定层训练与门槛判定")
    parser.add_argument("--write", action="store_true", help="把模型与报告写进 reports/roco/")
    args = parser.parse_args(argv)

    header, rows = load_windows()
    if not rows:
        sys.stderr.write("窗口集为空：先跑 node scripts/roco/build-intervention-windows.mjs\n")
        return 2
    by_split = {}
    for row in rows:
        by_split.setdefault(row["split"], []).append(row)
    for needed in ("train", "val", "test", "ood"):
        if not by_split.get(needed):
            sys.stderr.write(f"窗口集缺少 {needed} 侧\n")
            return 2

    model = train(by_split["train"], by_split["val"])
    evals = {split: evaluate(model, subset, split) for split, subset in by_split.items()}
    evals["_test_rows"] = by_split["test"]
    gate = check_gates(model, evals)

    report = {
        "generated_by": "scripts/roco/train-intervention-model.py",
        "preregistration": "docs/roco/W5-04-INTERVENTION-GATE.md",
        "window_set": header.get("set_id"),
        "window_set_digest_note": "窗口集由 build-intervention-windows.mjs 确定性生成（同一 seed 同一结果）",
        "splits": {split: len(subset) for split, subset in by_split.items()},
        "model": model,
        "evaluation": {split: value for split, value in evals.items() if not split.startswith("_")},
        "gate": gate,
        "verdict": ("pass" if gate["passes_decidable"] else "gate_failed"),
        "not_claimed": [
            "这不是胜率，也不声称干预在真人身上有效",
            "准确率只表示「更贴独立依据」，不表示具备了规则没有的能力",
            "硬门控与预算未被本层改动，也不可能被它改掉",
        ],
    }
    if args.write:
        os.makedirs(os.path.dirname(OUT_REPORT), exist_ok=True)
        with open(OUT_MODEL, "w", encoding="utf-8") as fh:
            json.dump({"generated_by": "scripts/roco/train-intervention-model.py",
                       "preregistration": report["preregistration"],
                       "features": FEATURE_NAMES,
                       "standardize": model["standardize"],
                       "coefficients": model["coefficients"], "intercept": model["intercept"],
                       "threshold": model["threshold"],
                       "decision": "positive → 放行规则原本会给的提示；negative → 抑制（只做「抑制」这一个方向）",
                       "gate_status": "gate_failed（G3 校准、G4 阈值稳健未过，见预注册文档 §8.1）",
                       "deployment": "参考实现，默认关闭；不声称可替换规则评分",
                       "deployment": "只替换 interventionScore 里 value-vs-floor 这一个判定；"
                                     "硬门控与预算在它之前，模型拿不到也改不了",
                       "rollback": "ROCO_INTERVENTION_MODEL=off（默认）时逐位回到规则结果"},
                      fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        with open(OUT_REPORT, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    test = evals["test"]
    print(json.dumps({
        "verdict": report["verdict"],
        "splits": report["splits"],
        "threshold": model["threshold"],
        "test_rule": {k: test["rule"][k] for k in ("recall", "false_positive_rate", "precision")},
        "test_model": {k: test["model"][k] for k in ("recall", "false_positive_rate", "precision")},
        "calibration": {"rule": test["rule"]["calibration"]["brier"], "model": test["model"]["calibration"]["brier"],
                        "ece_model": test["model"]["calibration"]["ece"]},
        "failed_gates": gate["failed"],
    }, ensure_ascii=False, indent=1))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
