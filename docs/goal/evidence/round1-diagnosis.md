# Round 1 诊断（fix 分支 vs 基线 2e62a73b）

## Python 全量（npm run test:env）在 fix 分支：6 红
| # | 测试 | 性质 | 处置 |
|---|---|---|---|
| 1 | test_type_multiplier_ruling.DoubleTypeMultipliesTest::test_dual_types_multiply_the_two_single_rows | 旧裁决判据（预期红） | 改钉：新裁决=快照 3× |
| 2 | …::test_exactly_41_cells_differ_from_the_snapshot | 旧裁决判据（预期红） | 改钉：41 格改为「旧裁决 vs 快照」的历史留痕 + 必红反证 |
| 3 | …::test_reverting_to_the_capped_snapshot_makes_the_same_check_red | 旧裁决判据（预期红） | 反向改钉：改回相乘 ⇒ 41 格差异（必红） |
| 4 | test_turn_order_fail_closed.LegacyBitExactGoldenTest::test_default_path_is_bit_identical_to_pre_rc103 | 金标指纹 | 更新 3 个种子的 gold（1000/1004/1005；1001-1003 不变），旧值保留为 PRIOR_2026_10_17 |
| 5 | test_regression_set.DiskArtifactIsFreshTest::test_disk_artifact_matches_a_fresh_build | 派生件过期 | 重建 reports/roco/rc404/regression-set.json |
| 6 | test_tier_verdict_agreement.TierAndVerdictAgreeTest::test_counter_proof_disabling_the_shared_gates_brings_them_back | **基线也红（pre-existing）** | 不在本次范围；记录为已知红 |

## 金标位移的因果证据
- 用同一脚本（/tmp/digest_probe.py）在 fix 与基线（worktree `.baseline`）各跑一次 6 个种子：
  - seed 1000/1004/1005：state/events/history 三枚指纹全部变化；
  - seed 1001/1002/1003：无变化。
- 事件序列：seed=1000 基线 37 条事件、修复后 39 条；第一处分歧发生在 damage 事件（回合 12 → 回合 10），
  说明是「双属性承伤倍率 4→3 改变了伤害 → 对局走向改变」，不是序列化/格式变化。
- 结论：金标位移只由规则修复引起，且只影响含双属性承伤的种子；按「改钉不删」更新 gold，旧值存 PRIOR。

## 已确认
- `tier` 反证红在基线 2e62a73b 上同样复现（与本次修复无关）。
- Node 侧：worktree 里 spawn ENOENT 不可信；改在**主工作树**（当前 fix 分支）跑定向与全量。
