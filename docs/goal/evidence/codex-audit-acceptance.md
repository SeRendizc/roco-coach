# Codex 审计（2026-10-17）验收与整合记录

Codex 交付：`rule-audit.md`（A1–A5，0 付费调用）+ 3 份补丁 + 变异日志。原文归档在同目录。
本文件记录 **DS/Lead 的验收动作**（逐条：接受/修正/仍开放）。

## 逐条处置

| 编号 | Codex 发现 | 处置 | 证据 |
|---|---|---|---|
| A1 | 活动台账 `EV-TYPE-MULTIPLIER` claim 仍写「双属性按两系相乘 / 双克制 ×4」，与 L3 的 ×3 同时入索引；两条自然问句 top-1 命中旧 claim | **已修**：claim/notes/sources 改为 2026-10-17 复核口径；旧 claim/notes/sources 全文移入 `retired_*`（改钉不删、不渲染进 RAG 正文）；`user-in-game-reports.json` 增 2026-10-17 复核留档；heldout M07 anchors 改 ×3/×0.25；meta-prior 生成器同步并重建 `v1.json` | `tests/roco-active-rule-claim.test.js`（2 条新增 + RAG 11 条）全绿；Codex gate 两条自然问句 PASS；`verify-meta-prior` 判据逐条通过 |
| A2 | 服务回执文字仍解释成相乘（`weakness_summary.multiplier_rule` / `type_row.note`） | **已修**：两处返回文案改为快照口径（×3），旧文案留在源码注释；吸收 Codex 的 `test_rule_source_contract.py`（4 条） | `roco/tests/test_rule_source_contract.py` + bad-case：12/12 OK |
| A3 | `tests/evals/roco/bridge.test.js` 仍钉 4 / `snapshot_agrees=false` / `multiply`，单跑必红 | **已修**：改钉为 3 / `snapshot_agrees=true` / `snapshot_row`，旧断言注释留痕 | 单跑：11 条中 10 绿；剩 1 条「静态事实 mechanics.resolved」在**未改代码的 HEAD** 上同样红（基线对比确认，非本次引入） |
| A4 | 等级词守卫只收集全包 ×N、**无对象绑定**；无关 ×2 可让「2 倍」错句通过 | **已修**：新增对象绑定（攻击属性 + 防守属性/对象名；同对象冲突倍率 fail closed；无关属性不抵账），并加 3 条正反控制 | `tests/roco-scarlett-tier-grounding.test.js` 10/10；Codex 探针 `probe-mixed-evidence.mjs` 现在返回 `conflicting-type-tier:3/2` |
| A5 | meta-prior 生成器/派生件、heldout M07、data.py/opponents 注释仍写旧口径 | **部分修**：生成器 + `v1.json` 重建、M07 改钉、服务文案已修；`data.py`/`opponents.py` 中的旧裁决原文属「改钉不删」历史注释，保留并在注释中标注 2026-10-17 复核（不做无意义删改） | `node scripts/roco/build-meta-prior.mjs` + `verify-meta-prior` |
| — | Codex 明确未验证：`test:unit` 全量、`test:env` 全量、真实模型是否消费旧语料、浏览器行为 | DS 已复跑全量：`test:unit` 2096/2081/14（失败集合与基线逐条相同）；`test:env` 仅 1 条 pre-existing；真实模型未再采样（0 付费） | `/tmp` 日志 + 本轮报告 |

## 与 Codex 审计的差异/保留意见

1. **`test:unit` 之前没有包含 `tests/evals/roco/bridge.test.js`**（Codex 指出后确认）：本轮**没有**把整个 bridge 加进 `test:unit`，因为其中「静态事实 mechanics.resolved」在未改代码的 HEAD 上就红（基线复现）。已用独立命令 + 新增 active-rule/tier 判据覆盖关键契约；bridge 全量待该 pre-existing 红修复后再并入。
2. Codex 的 A1 建议「活动/历史 schema 分离」：本轮用 `retired_*` 字段实现（不渲染），未新增独立历史索引；是否进一步把 retired 历史做成可检索但标记 RETIRED 的独立集合，留待下一轮。
3. Codex 补丁 002 的文案与我们手工修改一致（已逐字核对）；补丁 001 测试已吸收；补丁 003 已按提案改钉。

## 验证读数（整合后）

- `test:unit` 2096/2081/14/1（14 条失败与基线逐条相同；新增 5 条判据全绿）。
- `test:env` 仅 1 条 pre-existing 红（tier 反证）。
- `test:roco-quality`、RAG 11/11、active-rule 2/2、tier 10/10、agent-policy 14/14。
- `node --test tests/evals/roco/bridge.test.js`：10/11（1 条 pre-existing，基线已红）。
- 0 次付费模型调用。

## 派生链重建（Ledger 改动的连锁要求）

改 `rule-evidence-ledger.json` 会连锁让下游产物失配（这是 Codex 审计之外的**实施细节**，已踩到并修复）：
- `data/roco/rulesets/*.json` 带 `derived_from_ledger_sha256` ⇒ Python 服务拒绝启动；
- `data/roco/game-data-pack/v2/{pack,schema}.json` + `reports/roco/reconciliation/game-data-pack-readiness.json`；
- `data/roco/owned-pets/*`（provenance 指向 pack.json）；
- RAG 语料核验/评测（`reports/roco/rag/*`，含 source_markers 计数）；
- `data/roco/meta-prior/v1.json` 与 RC-304 机器可读报告。
一条命令收口：`node scripts/roco/rebuild-derived-chain.mjs`（顺序写死）+ `build-meta-prior.mjs`。
验收：`rebuild-derived-chain.mjs --check` 5 环全过；`verify-rules-corpus` 8/8；derived 三套件 46/46。
