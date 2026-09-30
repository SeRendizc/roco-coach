# 半成品排查 · `box-team-ui`（数据 / 训练线）

**审的是哪一版**（读前 hash，2026-09-30 02:35 记录，`shasum -a 256 … | cut -c1-10`）：

| 对象 | hash |
|---|---|
| `router-v9/train.jsonl` | `10f47d4340` |
| `router-v9/valid.jsonl` | `8bc43c5fb1` |
| `router-v9/test.jsonl` | `eebe9aa7ae` |
| `router-v9/cases-for-gate.jsonl` | `b1cf53886d` |
| `evidence/gen-router-v9-v2.mjs` | `9b5a36e2da` |
| `evidence/check-expect-of.mjs` | `7e27bf960c` |
| `scripts/roco/eval-tool-execution.mjs` | `ed871ed1d8` |

**全程只读** ✓（除本文件）；数据 85 行（train 30 / valid 27 / test 28）· 家族 31 · `expect` 覆盖 85/85。

| # | 模块/文件 | 现象（一句话） | 证据（逐字/读数） | 判定 | 修复成本 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `router-v9/*.jsonl` + `cases-for-gate.jsonl` | `expect` 覆盖**没有缺口** | 数据集 85 行 `_expect` 缺失 **0** · gate-cases 85 行 `expect` 缺失 **0**；形状：`tool` 53 · `tool+query_contains` 20 · `tool+turn` 12 | **已完成（五条齐）** ✓ | — | — |
| 2 | `evidence/gen-router-v9-v2.mjs:150-170`（triple 生成） | **同一个"战斗组合"跨三个集合**——`context_spec.triple` **14/14 全部跨集** ✗（种子唯一 ✓ 但模型在回执里看到的就是这三只） | 逐族统计：`triple 跨集 14 / 14`；`seed 跨集 0 / 31`；`family 跨集 0 / 31` | **半成品 ⓓ（同源泄漏只挡住 family/seed，没挡 triple）** | 小（triple 改成按族序**不重复**的抽样，加一条跨集判据） | **P0**（数据一旦拿去训练就是泄漏） |
| 3 | `router-v9/*.jsonl`（问句文本） | **2 句问句文本同时出现在三个集合**（「现在局面怎么样？」「场上都有谁？」）✗ —— 输入**摘要**唯一（receipts 不同）⇒ 不是逐字重复输入，但问句本身重复 | `同一句问句出现在多个集合: 2 例`；生成器自查的 `digest` 唯一性 **通过**（85/85 唯一） | **半成品（弱）ⓓ** | 小（同族改写的问句池按集合错开） | P2 |
| 4 | `训练前准备包/READY.json` | **缺手册要求的两个结构键**：`data_hashes` / `source_hashes` ✗（现在写的是 `data.sha256_16` + repo 路径） | `现有 READY 顶层键: ['schema','at','data_dir','note','data','checks','evidence','blocking','evaluator_entry','data_note']`；`data_dir` ✓ · `data_hashes` **✗** · `source_hashes` **✗** | **半成品（结构不符手册）** | 中（按 `一页说明` 附录三用 `readiness.mjs snapshot` 生成，再把我们四块并进去，**结构键不许动**） | **P0**（`check` 过不了 ⇒ 门禁挂） |
| 5 | `scripts/roco/eval-tool-execution.mjs:55` | **注释与代码相反**：注释仍写「服务不可用时**如实标 skipped**」✗，而代码已经改成**判失败**（`G4service`） | 代码：`gate('G4service', false, '必需服务不可用 ⇒ 判失败（不是 skip）')`；注释第 55 行逐字：`服务不可用时**如实标 skipped**` | **半成品 ⓒ（同名两份：文档一份、代码一份，读的人会照旧的办）** | 极小（改一行注释） | P1 |
| 6 | `scripts/roco/eval-tool-execution.mjs:90-101` | G5 的失败理由**截断到 60/80 字**，且**没有全文字段**兜底（同一条纪律在 ② 已经执行：stderr 留 1985 字） | `String(receipt.reason ?? '').slice(0, 60)` · `JSON.stringify(receipt).slice(0, 80)`；对照：`detail/stderr` 只在那两条分支里写 | **半成品（轻）** | 小（G5 也写 `detail`，理由不截断） | P2 |
| 7 | `evidence/gen-router-v9-v2.mjs:88-131`（`expectOf` 问句解析） | **8 句话解析不出意图/意图冲突 ⇒ 8 个家族只拿到 2 行**（93 → 85）✗ —— 其中 6 句是"解析不出"、2 句是"闸的顺序" | 当前 trace：整族跳过 **0**、单句跳过 **8**；逐字例：`换人怎么算？→ 解析不出` · `守住这一轮结果如何？→ 解析不出` · `刚才那局打得怎么样？→ 意图是 read_last_turn（家族声明 read_match）` · `换成谁能补上短板？→ 意图是 evaluate_team（家族声明 compare_team_change）` | **半成品（覆盖掉 8 行 + 2 处闸序）** | 小（补 6 个同义句式 + `read_match`/`compare_team_change` 闸前移） | **P1**（覆盖） |
| 8 | 数据闸纪律 | `_expect` 与 `expect` 目前**一致（0/85 漂移）**，但**没有判据钉住**它——两处是"生成器投影一次"，改生成器忘了改 gate-cases 就会漂 | `按 id 对上的 case 数: 85 · 不一致: 0`；`check-expect-of.mjs` 只钉 `expectOf`（8 条），**不比对两个文件** | **半成品（缺判据）** | 小（`check-expect-of.mjs` 里加一段：逐行 `_expect` ≡ `expect`） | P1 |

## 一句话总结

**我这块有 8 个半成品，最严重的是 #2（同一"战斗组合"14/14 跨三个集合 —— 数据一旦拿去训练就是同源泄漏）与 #4（READY 缺 `data_hashes`/`source_hashes`，门禁 `check` 过不了）**；其次是 #7（8 句解析不出 ⇒ 8 个家族各少 1 行，覆盖 93→85）、#5（注释与代码相反）、#8（`_expect`/`expect` 无判据）、#6（G5 理由截断）、#3（2 句问句文本跨集，弱）。

**已完成的**（五条齐 ✓）：`expect` 覆盖 85/85（#1）；问句→标签+期望的**单一来源** `expectOf` + 8 条回归钉；评测器 `G0`/候选前缀闸/`G4service` 判失败 + 15 条必败反例；家族与种子跨集 0。
