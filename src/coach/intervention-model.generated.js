// 由 scripts/roco/train-intervention-model.py 生成，请勿手改。
// 判定层进浏览器模块图，所以模型必须以源码常量形式随代码发布——见该脚本里的注释。
export const GENERATED_INTERVENTION_MODEL = {
  "features": [
    "intercept",
    "risk",
    "phase_replace",
    "low_hp",
    "turn_norm",
    "legal_count_norm",
    "planner_margin_norm"
  ],
  "standardize": {
    "mean": [
      1.0,
      0.218887,
      0.021079,
      0.01855,
      0.080923,
      0.722316,
      0.022712
    ],
    "scale": [
      1.0,
      0.119784,
      0.143649,
      0.134928,
      0.041654,
      0.108947,
      0.029036
    ]
  },
  "coefficients": [
    0.0,
    1.414819,
    0.889097,
    0.779011,
    0.798654,
    0.273111,
    9.802147
  ],
  "intercept": -0.826018,
  "threshold": 0.88,
  "decision_margin_threshold": 0.146532,
  "gate_status": "pass（全部可判定判据通过：H1_recall_floor、H2_false_positive_ceiling、H3_calibration、H4_discrimination、H5_ood、H8_criteria_are_falsifiable）",
  "criteria": [
    "H1_recall_floor",
    "H2_false_positive_ceiling",
    "H3_calibration",
    "H4_discrimination",
    "H5_ood",
    "H6_latency",
    "H7_rollback",
    "H8_criteria_are_falsifiable"
  ],
  "label": "truth_v2",
  "rollback": "ROCO_INTERVENTION_MODEL=off（默认）时逐位回到规则结果"
};
