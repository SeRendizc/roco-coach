# Task A：相性倍率「四层/五层口径」对抗审计（2026-10-17 晚，DS 自查）

> 锚点：Agent 学习里的「同一事实只能有一个源」；面试可直接讲「我发现并收口了五处独立算术」。
> 方法：全仓 grep + 逐处读码 + 复跑判据；0 付费调用。

## 审计结论：找到一个**第五处**独立算术，已修

| # | 位置 | 现状（修后） | 是否与 `TypeChart.multiplier` 同源 |
|---|---|---|---|
| 1 | `roco/src/roco_env/data.py::TypeChart.multiplier` | 双属性读快照那一行（3×） | **唯一真源** |
| 2 | `roco/src/roco_env/service.py::_answer_type_multiplier` | 已改走 `rs.type_chart.multiplier`（此前是「第四份」：两条单属性相乘 → 4×） | ✅ |
| 3 | `roco/src/roco_env/service.py::_answer_weakness_summary` | **本轮新发现（第五份）**：此前逐属性 `value *= _single_multiplier(...)`（双弱 4×）；现改走 `rs.type_chart.multiplier` | ✅ |
| 4 | `roco/src/roco_env/service.py::_answer_type_chart`（自检） | 此前把「两系相乘 vs 快照」的 41 格当成现行对账；现改为「引擎值 vs 快照」应 0 格 + 41 格仅作历史留痕 | ✅ 报告口径 |
| 5 | `src/coach/rag-index.js::typeChartBody` | 已逐字照抄快照（旧 ×4 判据改钉）；顺带删掉相乘死代码/`singleTypeRows` | ✅ |
| 6 | `src/client/type-affinity.js` | 一直逐字读 `types.json`（正确） | ✅ |
| 7 | `roco/src/roco_env/effects.py` 注释 | 旧「2026-09-25 两系相乘」注释已改钉为 2026-10-17 复核说明（代码本就调 `type_chart.multiplier`） | ✅ |

## 反证映射（改回相乘时哪条会红）

- 引擎：`roco/tests/test_type_multiplier_ruling.py::test_reverting_to_multiply_makes_the_snapshot_check_red`（必红）。
- RAG 语料：`tests/roco-rag-typechart.test.js` 判据④（语料=快照 0 格 + 旧口径 41 格）。
- 服务读口：`roco/tests/test_scarlett_bad_cases.py::ServiceTypeMultiplierReadTest`（3× / `combination_rule=snapshot_row` / 缺行 fail closed）。
- 政策路由：`tests/roco-type-multiplier-ask.test.js`（官方 Bad Case 问句必须查 `type_multiplier`）。
- `_answer_weakness_summary`：**计数对 3 与 4 不敏感**（都 >1），所以没有行为级红；这次是「同源」性质的收口，已在代码注释写明。

## 验证读数

- `test:env`：仅 1 条 pre-existing 红（tier 反证，基线同样红）。
- `test:unit`：见 `/tmp/unit-audit.log`（本轮复跑结果；失败集合应与基线逐条相同）。
- `test:roco-quality`：77/77（此前复跑）。
- 新增离线政策评测：`npm run eval:agent-policy` → 14/14 通过（2 条 known-gap 如实报告）。
