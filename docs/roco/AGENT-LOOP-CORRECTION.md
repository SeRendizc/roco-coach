# A4：agent 循环的「一次纠错」（2026-09-25）

> 人类口径：「做点 agentic 的东西」「不能偷工减料」。
> 这份文档只讲一件事：`src/coach/runtime.js::gatherAgentEvidence` 从「一次错就终止」
> 改成「**全局允许一次纠错**」，以及**哪些硬约束一个字都没松**。

## 为什么改

改之前它是**单发脚本**：模型只要一次工具名写错 / 参数不合法 / 重复调用 / 工具执行抛错，
整轮立刻 `return`，玩家只看到「模型失败」。这不是 agent —— agent 的定义里包含
「拿到错误回执之后重新决定」。

## 语义（实现即合同）

失败时发一张**纠错券**：把失败写成一条错误回执塞进 `trace`，让规划器**看着它**重新决定。

```js
{id:'tool:err:<n>', tool:<name>, args:<原样保留模型给的参数>,
 result:{error:'invalid-tool'|'invalid-arguments'|'repeated-tool'|'tool-failed',
         hint:'给模型的下一步提示', contract:{description, arguments}},
 chosenBy:'correction', corrected:true}
```

纠错之后产生的正常回执带 `corrected:true`；干净路径（没发生纠错）**一个字段都不多**。

## 一条都没松的硬约束（逐条对照）

| 约束 | 修前 | 修后 |
|---|---|---|
| 步数上限 | 循环迭代 `< Math.min(4,limit)` | **不动**（纠错也占一次迭代） |
| 纠错次数 | 0（直接终止） | **全局 1 张券**（不是每类一张） |
| `seen` 去重 | 重复 `(tool,args)` 终止 | **不动**（纠错不许让它复活） |
| 第二次同类失败 | — | **照旧终止，`stopped` 取值与修前相同** |
| `stop:true` | 收口 | **不动** |
| `mustCall` 首枪 | 政策决定、直接执行 | **不动**（政策不是模型，**不给**纠错） |
| `policy` 硬门控（线上竞技） | 咨询模型前拦住 | **不动**（不给纠错 —— 那等于放松门控） |
| `receipt-budget` / 规划器自身失败 | 终止 | **不动**（不是「模型把工具用错了」） |

## 判据（`tests/evals/roco/agent-loop-correction.test.js`，8 条，已进 `test:unit`）

① 参数不合法 → 纠错 → 改正后成功（并断言**规划器第 2 次咨询时真的看到了那条错误回执**：
`plan.calls.receipts = [[], ['tool:err:1'], ['tool:err:1','tool:2']]`）；
② 工具名不存在 → 同理恢复；
③ 纠正后**再**失败 → `stopped` 与修前同值、**全局只有 1 条错误回执**；
③b 工具**执行**抛错 → 也给一次券，回执写清 `tool-failed`（不是参数错）；
④ 纠错不许让同一个 `(tool,args)` 复活 → 仍 `repeated-tool`；
⑤ 干净路径与修前**逐字节相同**（钉了原文与 sha256 `7e15709a…`，取自修前那一版
`/tmp/roco-a4/runtime.js.bak`，sha256 `90b0b935…`）；
⑤b 线上竞技一条回执都不给、**咨询模型次数 = 0**；
⑤c `mustCall` 首枪不吃纠错券。

## 必红反证（两条，真跑过）

| 反证 | 注入 | 结果（原文摘要） |
|---|---|---|
| (a) 纠错预算短路成 0（≡ 回退到修前） | `if(corrections>=0)return false;` | **① ② ③ ③b ④ 全红**（`pass 3 / fail 5`），⑤/⑤b/⑤c 仍绿 |
| (b) 纠错预算改成无限 | `if(false)return false;` | **③ ④ 红**（`pass 6 / fail 2`） |

两次注入后都**按 sha256 还原并复验**（`shasum -a 256 -c` → OK），测试复跑 8/8 绿。

## 实测数字

- `node --test tests/evals/roco/agent-loop-correction.test.js` → **8/8 绿**。
- `npm run roco:verify-agent-trajectories` → **`verdict: true`**（5988/5988）。
- `npm run roco:verify-agent-trajectories-model` → **`verdict: true`**、`first_failures: []`
  ⇒ **录制轨迹与「一次错就终止」的旧行为不耦合**（这是本次改动前最需要确认的一点）。

## 已知的、**不在本文件范围内**的一条待办

`tests/coach.test.js:62` 断的是修前语义：

```js
const invalid=await gatherAgentEvidence({message:'x',context,plan:async()=>({tool:'execute_code'})});
assert.equal(invalid.stopped,'invalid-tool');   // ✅ 仍然成立（取值没变）
assert.equal(invalid.trace.length,0);           // ❌ 现在是 1（那条错误回执）
```

`stopped` 没变、`trace` 多了**按规定必须有的**错误回执 ⇒ 需要把这一行改成
「`trace.length===1` 且那一条是 `chosenBy:'correction'` 的 `tool:err:1`」。
本文件作者**没有权限改 `tests/coach.test.js`**（任务书限定可改文件），故如实登记，未改。
