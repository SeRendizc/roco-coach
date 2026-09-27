// A4：agent 循环的**一次纠错**语义（人类 2026-09-25：「做点 agentic 的东西」「不能偷工减料」）。
//
// 修前的 `gatherAgentEvidence` 是**单发脚本**：模型只要一次工具名写错 / 参数不合法 /
// 重复调用 / 工具执行抛错，整轮立刻 `return`，玩家只看到「模型失败」——
// 那不是 agent。本文件钉住修后的语义，并把**修前就有的硬约束**逐条钉回去：
//
//   ① 参数不合法 → 拿到错误回执 → 重写成合法参数 → **成功**；
//   ② 工具名不存在 → 同理恢复；
//   ③ 纠正之后**再失败** → 照旧终止（`stopped` 与修前同一个取值），且**全局只有一张纠错券**；
//   ④ 纠正**不许**让同一个 `(tool,args)` 复活（`seen` 去重照旧）；
//   ⑤ 干净路径（一次就对）与修前**逐字节相同**（下面钉了 sha256）。
//
// 反证（两条，真跑过、红/绿原文在提交说明里）：
//   · 把纠错预算短路成 0（≡ 回退到修前）→ ① 必须红；
//   · 把预算改成无限 → ③ 必须红。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gatherAgentEvidence} from '../../../src/coach/runtime.js';

/** 一份**不需要任何外部服务**的最小上下文：`training` 模式（不是线上竞技 ⇒ 不被 policy 门控挡掉）。 */
const CTX = {mode: 'training', battle: {turn: 1, result: null, phase: 'battle'}};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** 按脚本依次回话的规划器；脚本用光之后一律 `stop:true`（模型「用已有证据作答」）。 */
const plannerFrom = (script) => {
  let i = 0;
  const calls = [];
  const plan = async (task) => {
    calls.push({index: i, receipts: (task?.receipts ?? []).map((r) => r.id), remaining: task?.remaining ?? null});
    const next = script[i++];
    return next ?? {stop: true};
  };
  plan.calls = calls;
  return plan;
};
const run = (script, extra = {}) => {
  const plan = plannerFrom(script);
  return gatherAgentEvidence({message: '看看现在什么局面', context: CTX, plan, limit: 3, ...extra})
    .then((result) => ({...result, plan}));
};

test('① 参数不合法 → 一次纠错 → 模型改正后整轮成功（并且错误回执真的进了 receipts）', async () => {
  // 第一枪：`read_match` 的 limit 只能是 1..3，给 9 = 参数不合法。
  // 第二枪：改成合法参数。第三枪：模型自己收口。
  const {trace, stopped, plan} = await run([
    {tool: 'read_match', args: {offset: 0, limit: 9}},
    {tool: 'read_match', args: {offset: 0, limit: 1}},
    {stop: true},
  ]);
  assert.equal(stopped, 'complete', '纠正之后应当能正常收口');
  assert.equal(trace.length, 2, 'trace = 1 条错误回执 + 1 条成功回执');
  const [err, ok] = trace;
  assert.equal(err.id, 'tool:err:1');
  assert.equal(err.tool, 'read_match');
  assert.deepEqual(err.args, {offset: 0, limit: 9}, '错误回执要**原样**留下模型当时给的参数（外部才能复算）');
  assert.equal(err.result.error, 'invalid-arguments');
  assert.equal(err.chosenBy, 'correction', '错误回执必须能被认出来是「纠错券」换来的');
  assert.equal(err.corrected, true);
  assert.ok(Array.isArray(err.result.contract.arguments), '错误回执要带参数合同摘要（模型据此改正）');
  assert.match(String(err.result.hint), /参数/, '提示要说清是参数问题');
  assert.equal(ok.tool, 'read_match');
  assert.deepEqual(ok.args, {offset: 0, limit: 1});
  assert.equal(ok.corrected, true, '纠错之后产生的回执要带 corrected:true');
  // 规划器**真的看见了**那条错误回执（不是我们事后补进 trace 的装饰）：
  // 第 1 次咨询 receipts=[]；第 2 次就看到 ['tool:err:1']；第 3 次带着成功回执收口。
  assert.deepEqual(plan.calls.map((c) => c.receipts), [[], ['tool:err:1'], ['tool:err:1', 'tool:2']]);
});

test('② 工具名不存在 → 一次纠错 → 恢复', async () => {
  const {trace, stopped} = await run([
    {tool: 'read_the_whole_match', args: {}},
    {tool: 'read_match', args: {offset: 0, limit: 1}},
    {stop: true},
  ]);
  assert.equal(stopped, 'complete');
  assert.equal(trace[0].result.error, 'invalid-tool');
  assert.equal(trace[0].tool, 'read_the_whole_match', '不存在的工具名也要原样留在回执里');
  assert.match(String(trace[0].result.contract.description + trace[0].result.hint), /tools|合同表/);
  assert.equal(trace[1].tool, 'read_match');
  assert.equal(trace[1].corrected, true);
});

test('③ 纠正之后**再**失败 → 照旧终止，且全局只有一张纠错券（预算没被放大）', async () => {
  const {trace, stopped} = await run([
    {tool: 'read_match', args: {limit: 9}},
    {tool: 'read_match', args: {limit: 8}},
    {tool: 'read_match', args: {limit: 1}},
    {stop: true},
  ]);
  assert.equal(stopped, 'invalid-arguments', '第二次同类失败必须与修前同一个停止原因');
  assert.equal(trace.length, 1, '只许有一张纠错券：第二次失败直接终止，不再补回执');
  assert.equal(trace[0].id, 'tool:err:1');
});

test('③b 工具执行抛错也给一次纠错，但回执要写清是「执行失败」而不是参数错', async () => {
  // `read_state` 需要 `context.battle.player` 才能算合法行动；这份最小上下文没有 ⇒ 工具抛错。
  const {trace, stopped} = await run([
    {tool: 'read_state', args: {}},
    {tool: 'read_match', args: {offset: 0, limit: 1}},
    {stop: true},
  ]);
  assert.equal(stopped, 'complete');
  assert.equal(trace[0].result.error, 'tool-failed');
  assert.match(String(trace[0].result.hint), /执行.*失败/);
  assert.equal(trace[1].tool, 'read_match');
  assert.equal(trace[1].corrected, true);
});

test('④ 纠错不许让同一个 (tool,args) 复活：重复调用照旧按 repeated-tool 终止', async () => {
  const {trace, stopped} = await run([
    {tool: 'read_match', args: {offset: 0, limit: 1}},   // 成功
    {tool: 'read_match', args: {offset: 0, limit: 1}},   // 重复 → 纠错券
    {tool: 'read_match', args: {offset: 0, limit: 1}},   // 还重复 → 终止
    {stop: true},
  ]);
  assert.equal(stopped, 'repeated-tool');
  assert.equal(trace.length, 2, '成功回执 1 条 + 错误回执 1 条');
  assert.equal(trace[0].id, 'tool:1');
  assert.equal(trace[1].id, 'tool:err:1');
  assert.equal(trace[1].result.error, 'repeated-tool');
  assert.equal(trace.filter((r) => r.tool === 'read_match' && !r.result?.error).length, 1, '成功回执只许有一次');
});

test('⑤ 干净路径（一次就对）与修前**逐字节相同**（回归钉：sha256 取自修前那一版跑出来的原文）', async () => {
  const {trace, stopped} = await run([
    {tool: 'read_match', args: {offset: 0, limit: 1}},
    {stop: true},
  ]);
  assert.equal(stopped, 'complete');
  const text = JSON.stringify({trace, stopped});
  assert.equal(text,
    '{"trace":[{"id":"tool:1","tool":"read_match","args":{"offset":0,"limit":1},"result":{"missing":true}}],"stopped":"complete"}');
  assert.equal(sha256(text), '7e15709a9804a3ab456cf4787c59df33eab67cd30e4df6642746faf8ff70b70f',
    '干净路径的逐字节回归钉：修前（/tmp/roco-a4/runtime.js.bak，sha256 90b0b93595d59118…）跑同一段脚本得到的正是这一串');
  assert.equal(Object.hasOwn(trace[0], 'corrected'), false, '没有发生纠错时不许凭空多出记账字段');
  assert.equal(Object.hasOwn(trace[0], 'chosenBy'), false, '模型选的干净回执与修前一样，不带 chosenBy');
});

test('⑤b 线上竞技（policy 硬门控）不给纠错：照旧一条回执都不给', async () => {
  const live = {mode: 'pvp-live', battle: {turn: 3, result: null, phase: 'battle'}};
  const plan = plannerFrom([{tool: 'read_match', args: {offset: 0, limit: 1}}]);
  const {trace, stopped} = await gatherAgentEvidence({message: '现在打谁', context: live, plan, limit: 3});
  assert.deepEqual({trace, stopped}, {trace: [], stopped: 'policy'});
  assert.equal(plan.calls.length, 0, '门控在咨询模型**之前**就该拦住（不许先问再拒）');
});

test('⑤c mustCall 首枪政策照旧：政策首枪失败不给纠错（它不是模型）', async () => {
  const {trace, stopped} = await run([{stop: true}], {mustCall: 'read_match'});
  assert.equal(stopped, 'complete');
  assert.equal(trace.length, 1);
  assert.equal(trace[0].chosenBy, 'policy');
  assert.equal(Object.hasOwn(trace[0], 'corrected'), false);
  assert.equal(trace.filter((r) => r.chosenBy === 'correction').length, 0, '政策那一步不吃纠错券');
});
