# 04.6 复验补记（本轮新增读数）

接 `verify-04.6.md`。本轮补做：**五哈希核对** · **重点 6** · **重点 4（静态）**。

## §1 冻结哈希 → **4/4 吻合**

```
c83660ee6ab66095  roco/src/roco_env/planner.py                    ✓ 与你给的 c83660ee6ab66095 一致
844ea7ffb22546e9  roco/tests/test_plan_conservative.py            ✓ 一致
75a3049657a2ebb1  tests/roco-plan-context.test.js                 ✓ 一致
24c317aec9069dd7  tests/evals/roco/plan-e2e.test.js               ✓ 一致
（第 5 个我猜的路径 `reports/.../04/04.6-conservative-fallback.md` **不存在** ⇒ 报告文件未核；
  你给的是 5 个哈希、我只见到 4 个路径 ⇒ 请把第 5 个路径点名，我下轮补。）
```

## §2 重点 6：`skip ≠ 绿` → **成立**

```
不设 ROCO_PYTHON：node --test --test-concurrency=1 tests/evals/roco/plan-e2e.test.js
  ⇒ exit=0，但读数明确写着 **`ℹ skipped 6`**（不是 pass）
⇒ skip 被单独计数，**不当通过**。风险点在"看 exit code 就以为绿"的人：exit=0 + skipped 6 必须一起读。
  （你说"整文件 skip"，我这边是 **skipped 6**（不是全部 11 条）—— 数字不同但性质一致，如实登记。）
```

## §3 重点 4：两个预算名**分开**（静态核对）

`src/coach/toolbox.js:1716-1718`：
```js
budget_ms: ROCO_PLAN_TIMEOUT_MS,                                   // 工具侧超时常量
engineBudgetMs: Number.isInteger(plan?.budget_ms) ? plan.budget_ms : null,   // 引擎自报预算（非整数 ⇒ null）
timeout: {..., budget_ms: ROCO_PLAN_TIMEOUT_MS, ...},
```
⇒ **两名分开、来源不同**：`search.budget_ms` = 工具超时（`ROCO_PLAN_TIMEOUT_MS` 常量）；
`search.engineBudgetMs` = 引擎回执里的 `plan.budget_ms`，不是整数时给 `null`（不拿工具超时顶上）✓
⚠ 这是**静态核对**（读代码），运行期读数（同一次回执里两个值不同）我**没做** —— 登记为半条。

## §4 仍然欠账（按你的顺序）

- 重点 **5**：第⑦格**逐字段溯源**（`match_id/turn/result/self_active/foe_hp` 是否真读自 `battleView()`）+ 自造 **N19** 变异 —— **未做**
- 重点 **2 补测**：造「预算刚够跑一点」的部分完成场景验证 `numerator < denominator` —— **未做**（上轮已给有效结论：硬超时时 `by_seed=null`）
- **② `d4cdef8` 文本整刀** —— 未做
- **③ 三个判据修复复核**（含 `global_skill_mods` 行为零变化）—— 未做
- **① `/api/coach`**：停在 **200 + `provider:"deepseek"`**；取证阶段仍未触发（`planActions` 0 次）。
  下一步要用的诊断键已确认在响应体里：`toolPolicy` / `toolTrace` / `agentStop`（把这三个打出来即可看出策略为何停在 0 次）。
