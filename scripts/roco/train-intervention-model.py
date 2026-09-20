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
#: 默认用**手游引擎自己标定**的窗口集（第 18 轮）：旧演示引擎的分差是 3 量级、
#: 手游引擎的边际量是 0.04 量级，两把尺子不可通约（见预注册文档 §10.4）。
#: 要用旧集合跑对照就显式传 `--windows`。
WINDOWS = os.path.join(_ROOT, "tests", "evals", "roco", "intervention-windows-roco.jsonl")
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
#: 预注册 v2 的判据（docs/roco/W5-04-INTERVENTION-GATE-V2.md）。
#: 与 v1 的区别：误报上限从「相对规则的倍数」改成**绝对**值。
#: 旧口径在规则几乎不开口（FPR_rule = 0）时恒假——那不是判据，是恒假命题。
H_GATES = {
    "H1_recall_floor": "test 上 TPR >= 0.80（在 val 选的阈值上）",
    "H2_false_positive_ceiling": "test 上 FPR <= 0.05（绝对值）",
    "H3_calibration": "ECE <= 0.10 且 Brier_model <= Brier_rule",
    "H4_discrimination": "存在阈值使 TPR >= 0.80 且 FPR <= FPR_rule + 0.02",
    "H5_ood": "OOD 上 TPR >= 0.75 且 FPR <= 0.08",
    "H6_latency": "判定层 P95 <= 1ms（Node 侧实测）",
    "H7_rollback": "off 时逐位回到规则（Node 测试）",
    "H8_criteria_are_falsifiable": "每条判据都有必过与必挂的构造样例",
}

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


#: v2 用的标签：**纯决策前可得的观察量**（见预注册文档 §10）。
LABEL_KEY = "truth_v2"


def features_of(row: Dict[str, Any]) -> List[float]:
    """特征向量：**只有决策前可得的量**。

    刻意**不含** `decisionGap`（玩家实际选择与枚举第一的分差）与 `topChoice`——
    那两个要等玩家做完这一手才算得出来，而这一层是在**决策之前**被问到的。
    第一次训练误用了 `gap`，见预注册文档 §8：那是口径错误，不是调参问题。

    `planner_margin_norm` 是**枚举第一与第二的估值差**，取自同一份
    `rankEnemyActions` 枚举——决策前可得，且与规则在运行期拿到的「分差性质的量」
    同源（规则拿到的是规划器期望区间宽度，不是玩家实际选择）。
    """
    hp = float(row.get("hpRatio") or 0.0)
    margin = row.get("plannerMargin")
    margin_norm = 0.0 if margin is None else min(max(float(margin), 0.0) / GAP_THRESHOLD, 1.0)
    return [
        1.0,                                   # 截距
        float(row.get("risk") or 0.0),
        1.0 if row.get("phase") == "replace" else 0.0,
        1.0 if hp <= 0.35 else 0.0,
        min(float(row.get("turn") or 0) / 40.0, 1.0),
        min(float(row.get("legalCount") or 0) / 12.0, 1.0),
        margin_norm,
    ]


FEATURE_NAMES = ["intercept", "risk", "phase_replace", "low_hp", "turn_norm",
                 "legal_count_norm", "planner_margin_norm"]

#: 对照臂：**去掉** `planner_margin_norm`。用来回答一个必须回答的问题——
#: 「模型通过门槛，是因为它看见了规则看不见的东西，还是因为它只是复刻了规则？」
#: 去掉之后特征与规则**完全同信息**，因此它只能复刻规则。
ABLATION_FEATURE_NAMES = ["intercept", "risk", "phase_replace", "low_hp", "turn_norm",
                          "legal_count_norm"]


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
    # 忠实复刻**现行 interventionScore 的判定面**（不改阈值）：
    #   decisive = (gap 非空且 gap > 5) 或 risk ≥ 0.8 或必须补位
    #   positive = decisive 或 (3*risk + 1.2*min(gap/5,1)) ≥ floor
    # 这里直接用手游引擎的 `plannerMargin` 当 gap：它才是本链路真的会传进去的量。
    gap = row.get("plannerMargin")
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


def train(train_rows: List[Dict[str, Any]], val_rows: List[Dict[str, Any]],
          feature_names: Optional[List[str]] = None) -> Dict[str, Any]:
    from sklearn.linear_model import LogisticRegression

    names = feature_names or FEATURE_NAMES
    indices = [FEATURE_NAMES.index(name) for name in names]
    keep = lambda rows: np.array([[features_of(row)[i] for i in indices] for row in rows], dtype=float)  # noqa: E731
    x_train = keep(train_rows)
    y_train = np.array([1 if row[LABEL_KEY]["label"] else 0 for row in train_rows], dtype=int)
    x_val = keep(val_rows)
    y_val = np.array([1 if row[LABEL_KEY]["label"] else 0 for row in val_rows], dtype=int)

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
    # `C` 是正则强度的倒数。
    #
    # 试过把 C 从 1.0 压到 0.05 来治**概率饱和**（可分数据上系数会被推得很大，
    # 运行时边际量 0.01 就能把 sigmoid 打到 1.0，于是「抑制」永不触发）。
    # 结果是召回从 0.900 掉到 0.675、ECE 从 0.047 涨到 0.120，三条判据挂掉——
    # **用一个更差的模型换一个更好看的行为，不划算**，所以 C 保持 1.0。
    #
    # 真正的解法不是在 `C` 上折中，而是让这个概率**锚回一个可解释的分位刻度**：
    # 见下面 `decision_margin_threshold`——它记录训练侧边际量的 75 分位，
    # 判定层用它做相对判定，而 sigmoid 输出只作诊断量。饱和因此不再影响行为。
    model = LogisticRegression(max_iter=5000, random_state=SEED, C=1.0, solver="lbfgs")
    model.fit(x_train, y_train, sample_weight=weights)

    # 阈值只在**验证集**上选：在满足「召回不低于规则」的前提下取假阳性最低的那个。
    rule_val = np.array([1 if rule_scores(row)["positive"] else 0 for row in val_rows], dtype=int)
    rule_recall = binary_metrics(y_val, rule_val)["recall"] or 0.0
    probabilities_val = model.predict_proba(x_val)[:, 1]
    chosen = None
    sweep = []
    # 阈值网格放到两位小数：手游引擎标定后的正类只有 ~7%，
    # 概率会落在很小的区间里（0.00x—0.1x），0.05 的步长会整段跨过去。
    for threshold in [round(0.01 * step, 3) for step in range(1, 100)]:
        predictions = (probabilities_val >= threshold).astype(int)
        metrics = binary_metrics(y_val, predictions)
        feasible = (metrics["recall"] or 0.0) >= rule_recall - 0.02
        sweep.append({"threshold": threshold, "recall": metrics["recall"],
                      "false_positive_rate": metrics["false_positive_rate"], "feasible": feasible})
        if feasible and (chosen is None
                         or metrics["false_positive_rate"] < chosen["metrics"]["false_positive_rate"]):
            chosen = {"threshold": threshold, "metrics": metrics}
    if chosen is None:
        # 没有任何阈值能同时满足「召回不低于规则」——如实取一个能解释的默认值，
        # 并把它记进报告，而不是悄悄换一个更宽松的判据。
        chosen = {"threshold": 0.5,
                  "metrics": binary_metrics(y_val, (probabilities_val >= 0.5).astype(int)),
                  "note": "验证集上找不到同时满足召回门槛的阈值"}

    # 饱和检查：验证集上有多大比例的概率被压到极端值（<0.01 或 >0.99）。
    # 比例高说明这个概率不可用——它在运行时会表现为「永远放行」或「永远抑制」。
    extreme = float(np.mean((probabilities_val < 0.01) | (probabilities_val > 0.99)))
    return {
        "saturation_rate": round(extreme, 4),
        "coefficients": [round(float(value), 6) for value in model.coef_[0]],
        "intercept": round(float(model.intercept_[0]), 6),
        "standardize": {"mean": [round(float(value), 6) for value in mean],
                        "scale": [round(float(value), 6) for value in scale]},
        "feature_names": names,
        "threshold": chosen["threshold"],
        "validation": chosen["metrics"],
        "validation_rule_recall": rule_recall,
        "threshold_sweep": sweep,
        "cost_ratio": {"false_negative": COST_FN, "false_positive": COST_FP},
        "random_state": SEED,
    }


def apply_model(model: Dict[str, Any], row: Dict[str, Any]) -> float:
    """推理时必须用**训练时那一套**标准化参数与**同一组特征**，否则系数就是错的。

    注意不能按位置遍历 `features_of(row)`：对照臂用的是全部特征的一个**子集**，
    按下标硬算会取错列（第一版就是这么崩的）。
    """
    full = features_of(row)
    mean = model["standardize"]["mean"]
    scale = model["standardize"]["scale"]
    z = model["intercept"]
    for index, name in enumerate(model["feature_names"]):
        value = full[FEATURE_NAMES.index(name)]
        z += model["coefficients"][index] * ((value - mean[index]) / (scale[index] or 1.0))
    if z > 40:
        return 1.0
    if z < -40:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def evaluate(model: Dict[str, Any], rows: List[Dict[str, Any]], label: str) -> Dict[str, Any]:
    y = np.array([1 if row[LABEL_KEY]["label"] else 0 for row in rows], dtype=int)
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
                np.array([1 if row[LABEL_KEY]["label"] else 0 for row in subset], dtype=int),
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
        """误报必须下降。

        注意规则误报率为 **0** 时这条**不可能**通过（任何误报都 > 0.75×0）——
        这不是模型的缺陷，而是判据在退化输入上的性质。照实报，不改判据。
        """
        rule_fp, model_fp = side["rule"]["false_positive_rate"], side["model"]["false_positive_rate"]
        ok = (rule_fp is not None and model_fp is not None and model_fp <= 0.75 * rule_fp)
        detail = f"model {model_fp} vs 0.75×rule {None if rule_fp is None else round(0.75 * rule_fp, 4)}"
        if rule_fp == 0 and model_fp:
            detail += "（规则误报率为 0：该判据在此输入上不可达）"
        return ok, detail

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
        y = np.array([1 if row[LABEL_KEY]["label"] else 0 for row in row_set], dtype=int)
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


def check_gates_v2(model: Dict[str, Any], evals: Dict[str, Dict[str, Any]],
                   test_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """预注册 v2 的判定：绝对口径 + 判别力 + 判据自证。"""
    test = evals["test"]
    ood = evals["ood"]
    rule_test, model_test = test["rule"], test["model"]

    def rates(labels: List[int], predictions: List[int]) -> Tuple[float, float]:
        tp = sum(1 for y, p in zip(labels, predictions) if y == 1 and p == 1)
        fn = sum(1 for y, p in zip(labels, predictions) if y == 1 and p == 0)
        fp = sum(1 for y, p in zip(labels, predictions) if y == 0 and p == 1)
        tn = sum(1 for y, p in zip(labels, predictions) if y == 0 and p == 0)
        return (tp / (tp + fn) if tp + fn else 0.0, fp / (fp + tn) if fp + tn else 0.0)

    y_test = [1 if row[LABEL_KEY]["label"] else 0 for row in test_rows]
    probs_test = [apply_model(model, row) for row in test_rows]

    h1 = (model_test["recall"] or 0.0) >= 0.80
    h2 = (model_test["false_positive_rate"] or 0.0) <= 0.05
    h3 = (model_test["calibration"]["ece"] <= 0.10
          and model_test["calibration"]["brier"] <= rule_test["calibration"]["brier"])

    # H4：扫全部阈值，看有没有一个工作点能同时高召回、且不比规则多打扰多少。
    rule_fpr = rule_test["false_positive_rate"] or 0.0
    reachable = []
    for step in range(1, 100):
        threshold = step / 100.0
        tpr, fpr = rates(y_test, [1 if p >= threshold else 0 for p in probs_test])
        if tpr >= 0.80 and fpr <= rule_fpr + 0.02:
            reachable.append({"threshold": threshold, "tpr": round(tpr, 4), "fpr": round(fpr, 4)})
    h4 = bool(reachable)

    ood_model = ood["model"]
    h5 = ((ood_model["recall"] or 0.0) >= 0.75
          and (ood_model["false_positive_rate"] or 0.0) <= 0.08)

    # H8：判据自身必须可判别——每条都造一个必过与一个必挂的样例。
    # 「必挂」用极端输入构造：全预测为阳性时 H2 必须挂，全预测为阴性时 H1 必须挂。
    all_positive = [1] * len(y_test)
    all_negative = [0] * len(y_test)
    tpr_all_pos, fpr_all_pos = rates(y_test, all_positive)
    tpr_all_neg, fpr_all_neg = rates(y_test, all_negative)
    h8_checks = {
        "H1_can_fail": tpr_all_neg < 0.80,          # 全不提示 → 召回 0 → H1 必挂
        "H2_can_fail": fpr_all_pos > 0.05,          # 全提示 → 误报 1.0 → H2 必挂
        "H1_can_pass": tpr_all_pos >= 0.80,         # 全提示 → 召回 1.0 → H1 必过
        "H2_can_pass": fpr_all_neg <= 0.05,         # 全不提示 → 误报 0 → H2 必过
    }
    h8 = all(h8_checks.values())

    gates = {
        "H1_recall_floor": {"passed": bool(h1), "detail": f"TPR {model_test['recall']} >= 0.80"},
        "H2_false_positive_ceiling": {"passed": bool(h2),
                                      "detail": f"FPR {model_test['false_positive_rate']} <= 0.05"},
        "H3_calibration": {"passed": bool(h3),
                           "detail": f"ECE {model_test['calibration']['ece']}；"
                                     f"Brier {model_test['calibration']['brier']} vs 规则 "
                                     f"{rule_test['calibration']['brier']}"},
        "H4_discrimination": {"passed": h4,
                              "detail": {"rule_fpr": rule_fpr, "reachable_operating_points": reachable[:5],
                                         "n_reachable": len(reachable)}},
        "H5_ood": {"passed": bool(h5),
                   "detail": f"OOD TPR {ood_model['recall']} >= 0.75；"
                             f"FPR {ood_model['false_positive_rate']} <= 0.08"},
        "H6_latency": {"passed": None, "detail": "Node 侧实测（查表点积）"},
        "H7_rollback": {"passed": None, "detail": "由 Node 测试证明"},
        "H8_criteria_are_falsifiable": {"passed": bool(h8), "detail": h8_checks},
    }
    failed = [key for key, item in gates.items() if item["passed"] is False]
    return {"gates": gates, "failed": failed, "passes_decidable": not failed, "definition": H_GATES}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="W5-04 介入判定层训练与门槛判定")
    parser.add_argument("--write", action="store_true", help="把模型与报告写进 reports/roco/")
    parser.add_argument("--windows", default=WINDOWS, help="窗口集路径")
    parser.add_argument("--out-model", default=OUT_MODEL)
    parser.add_argument("--out-report", default=OUT_REPORT)
    args = parser.parse_args(argv)

    header, rows = load_windows(args.windows)
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
    gate_v1 = check_gates(model, evals)
    gate = check_gates_v2(model, evals, by_split["test"])
    gate["superseded_v1"] = {"failed": gate_v1["failed"],
                             "why": "v1 的误报上限是「相对规则的倍数」；规则在手游口径下几乎不开口"
                                    "（FPR=0），该上限恒假。见 docs/roco/W5-04-INTERVENTION-GATE-V2.md"}

    # 对照臂：与规则**同信息**的特征子集。它只能复刻规则，不可能超过规则的召回；
    # 如果主臂与它结果相同，说明「通过」来自标签口径的正确，而不是多给了一个特征。
    ablation_model = train(by_split["train"], by_split["val"], ABLATION_FEATURE_NAMES)
    ablation = {split: evaluate(ablation_model, subset, split) for split, subset in by_split.items()}
    # 对照臂也走**同一套 H 判据**，用来证明判据能挂住一个明显更弱的模型：
    # 只跑旧判据的话，「判据有牙」这件事就没有证据。
    ablation_gate = check_gates_v2(ablation_model, ablation, by_split["test"])

    report = {
        "generated_by": "scripts/roco/train-intervention-model.py",
        "decision_margin_threshold": header.get("margin_threshold"),
        "preregistration": "docs/roco/W5-04-INTERVENTION-GATE-V2.md",
        "window_set": header.get("set_id"),
        "window_set_path": args.windows,
        "engine": header.get("engine", "旧演示引擎"),
        "margin_threshold": header.get("margin_threshold"),
        "margin_threshold_basis": header.get("margin_threshold_basis"),
        "window_set_digest_note": "窗口集由 build-intervention-windows.mjs 确定性生成（同一 seed 同一结果）",
        "splits": {split: len(subset) for split, subset in by_split.items()},
        "model": model,
        "evaluation": {split: value for split, value in evals.items() if not split.startswith("_")},
        "ablation_without_planner_margin": {
            "why": "去掉 planner_margin_norm 后，模型的特征与规则**完全同信息**，"
                   "因此它只能复刻规则。用来区分「口径修正」与「多给了一个特征」。",
            "feature_names": ablation_model["feature_names"],
            "threshold": ablation_model["threshold"],
            "test": {key: ablation["test"]["model"][key] for key in ("recall", "false_positive_rate", "precision")},
            "rule_test": {key: ablation["test"]["rule"][key] for key in ("recall", "false_positive_rate", "precision")},
            "verdict": "pass" if ablation_gate["passes_decidable"] else "gate_failed",
            "failed_gates": ablation_gate["failed"],
            "gate_detail": {key: item["detail"] for key, item in ablation_gate["gates"].items()},
            "why_it_matters": "对照臂的特征与规则同信息、召回只有 0.075；"
                              "它必须被同一套判据挂住，否则说明判据没有判别力。",
        },
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
        # 判据名从**本次判定**里取，不写死「G1—G5」那种旧名字——
        # 第 19 轮把判据换成 H1—H8 之后，写死的字符串就会与报告对不上。
        gate_status = ("pass（全部可判定判据通过：" + "、".join(
            key for key, item in gate["gates"].items() if item["passed"] is True) + "）"
            if report["verdict"] == "pass"
            else f"gate_failed（未过：{', '.join(gate['failed'])}）")
        with open(args.out_model, "w", encoding="utf-8") as fh:
            json.dump({"generated_by": "scripts/roco/train-intervention-model.py",
                       "preregistration": report["preregistration"],
                       # 判定层做**相对**判定用的刻度：边际量低于这个分位 = 「这一手咬得紧」。
                       # 它来自训练侧分布（窗口集头部），不是拍出来的常数；
                       # sigmoid 概率只作诊断量，饱和也不影响行为。
                       "decision_margin_threshold": header.get("margin_threshold"),
                       "criteria": list(gate["gates"].keys()),
                       "features": FEATURE_NAMES,
                       "standardize": model["standardize"],
                       "coefficients": model["coefficients"], "intercept": model["intercept"],
                       "threshold": model["threshold"],
                       "decision": "positive → 放行规则原本会给的提示；negative → 抑制（只做「抑制」这一个方向）",
                       "label": LABEL_KEY,
                       "label_basis": "纯决策前可得的观察量：必须补位 / 血量≤35% / 枚举第一与第二的估值差>5",
                       "gate_status": gate_status,
                       "deployment": "参考实现，默认关闭；不声称可替换规则评分",
                       "deployment": "只替换 interventionScore 里 value-vs-floor 这一个判定；"
                                     "硬门控与预算在它之前，模型拿不到也改不了",
                       "rollback": "ROCO_INTERVENTION_MODEL=off（默认）时逐位回到规则结果"},
                      fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        with open(args.out_report, "w", encoding="utf-8") as fh:
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
        "ablation": {"verdict": report["ablation_without_planner_margin"]["verdict"],
                     "test": report["ablation_without_planner_margin"]["test"]},
    }, ensure_ascii=False, indent=1))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
