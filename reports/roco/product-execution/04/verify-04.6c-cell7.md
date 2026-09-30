# 04.6 重点 5 复验：扫面表第⑦格（真视图投影）→ **合格**

## §1 第 5 个冻结件 → **吻合**

```
d3f0bf5157a17af4  reports/roco/product-execution/04/04.6-conservative-and-json-safety.md  4658 B  ✓ 与你给的一致
（我上轮只取了 4 个**代码/判据**路径 ⇒ 猜不到报告路径；你下轮把报告类冻结件也标出来即可。）
⇒ 04.6 **五个冻结件 5/5 全部吻合**。
```

## §2 第⑦格：`summarize_battle × 记录` 改成真视图投影 → **逐字段溯源成立（不是假覆盖）**

`tests/evals/roco/plan-e2e.test.js:279-290`：
```js
const realView = (await service.battleView({battle_id: begun.battle_id})).view;   // 真引擎产物
assert.ok(realView && Array.isArray(realView.self?.pets) && realView.self.pets.length >= 1,
  'record 的字段必须来自真产物（真公开视图）');
const realRecord = {match_id: realView.match_id, turn: realView.turn,
  result: realView.battle_result ?? realView.result ?? null,
  self_active: realView.self?.active ?? null,
  foe_hp: realView.opponent?.field?.hp ?? null};
assert.equal(realRecord.match_id, realView.match_id, '身份必须读自真视图（字面量必红）');
assert.ok(Number.isInteger(realRecord.turn) && realRecord.turn >= 1, 'turn 必须来自真视图');
assert.ok(JSON.stringify(realRecord).length < 4200, '记录必须在契约上限内');
```
逐字段溯源（我逐条对过）：`match_id` ← `realView.match_id` · `turn` ← `realView.turn` ·
`result` ← `realView.battle_result ?? realView.result` · `self_active` ← `realView.self.active` ·
`foe_hp` ← `realView.opponent.field.hp` —— **五个字段全部读自 `battleView()` 的真产物**，
且带 4 条断言（含 4200B 契约上限），**没有手写字面量残留** ⇒ 我上一轮标的「弱覆盖」**已修**。

## §3 N19 变异（我自己造）→ **必红**

```
变异：把投影换回旧字面量 `{match_id:'m1', turn:3}`（只改一行）
⇒ node --test --test-concurrency=1 tests/evals/roco/plan-e2e.test.js  **exit=1**
   失败用例：『工具 × 真公开面 扫面：validToolArgs 必须全绿（新增 ruleset / 公开面字段时会**先红**）』
   AssertionError：**「身份必须读自真视图（字面量必红）」**   ← 正是为 N19 写的那条
   同时 `ℹ skipped 0`（带 ROCO_PYTHON ⇒ 0 skip，反过来印证重点 6 的口径）
还原 ⇒ plan-e2e.test.js sha16 = 24c317aec9069dd7（= 冻结件）✓
```

## §4 验收条款已并入我的读数模板（你③）

以后我的每份读数都带：**`skipped` 计数** + **本机产物声明**（`tmp/skill-slice-inventory.json` 等缺失会写成 skip 的，逐个点名）
+ 入口/子集。理由照你的：**只看 exit code 会把 skip 误判成绿**（C-2/C-3 长期没暴露的机理）。

## §5 仍欠（04 passed 的另一个前置）

- **② `d4cdef8` 文本整刀**（真源→产物链：`content.js` 重跑逐字节相同 `7634e9109f82526f` → 产物 `source_sha256` 对齐 →
  `rag-tactic-cards` 5/5；alias 0/14 负结果是否「保险非召回修复」；`knowledge.test.js` 两条改钉是否只换词）—— **未做**。
- 04.6 重点 **2 补测**（部分完成场景）：按你的采纳，直接以「硬超时下 `by_seed=null`、该子判据不适用，需部分完成场景」为结论。
