# 实测 vs 引擎：标定报告

> 脚本：`scripts/roco/calibrate-from-measurements.py`　（生成时间是易变字段，留在 `reports/roco/microcases/calibration.json`）
> 规则集：`roco-world-s4-2026-09-10`

- **容差由人给。** 脚本不替人拍一个「算通过」的阈值；不给容差就只报告差异。
- 标定只反解系数并报出与当前假设的偏离，**不自动改公式**；改公式要连带改 COMMUNITY_HYPOTHESIS_V1 的版本与理由。
- 实测记录只有一次时，任何「一致」都只是**一次**观察一致，不构成「机制已核验」。

## 汇总

- 实测条数：**0**
- 判定容差：**未给出（只报告差异）**
- 各状态计数：`{}`

## 还没有实测

入口：

```bash
python3 scripts/roco/record-measurements.py --interactive
python3 scripts/roco/calibrate-from-measurements.py --tolerance-pct 5
```

值得先测的三条（按「一条能解锁多少条」排序）见
`docs/roco/MICROCASE-HARNESS.md` §4。
