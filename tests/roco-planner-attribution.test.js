// **ReAct 的失败归因**判据（2026-09-25）。
//
// 为什么需要它：外部证据一致指向"**小模型上多步 ReAct 是负收益**"（48,000 次实验里 3B 的位置准确率
// Straight-Shot 0.31 → ReAct 0.23 → Plan-and-Execute 0.05；本仓自己的实测也一致：44 条真实记录里
// `toolTrace` 长度分布是 `{0:36, 1:8}`，**最大值 1**）。⇒ 最该做的不是"加步数"，而是"**把已有的一步做准**"，
// 而做准的前提是**看得见失败在哪**。修前 `runtime.js` 的 `catch` 只给一个笼统的 `planner-failed`，
// 分不出"超时"/"被取消"/"别的原因"；而"**模型输出的不是 JSON**"更糟 —— 它和"模型主动停止"在返回形状上
// 一模一样（都是 `{stop:true}`），于是**一种真实的失败被记成了成功（complete）**。
//
// 这一组钉三件事：① 三种抛错分类；② `unparseable` 不再伪装成 `complete`；③ 反证（改回笼统值必须红）。
//
// 用法：`node --test tests/roco-planner-attribution.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {gatherAgentEvidence} from '../src/coach/runtime.js';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-24）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME_SRC = readFileSync(`${ROOT}src/coach/runtime.js`, 'utf8');

/** 最小上下文：让 `gatherAgentEvidenceOnce` 走到规划器循环（不进线上竞技闭麦、不需要 mustCall）。 */
const context = () => ({mode: 'camp'});

/** 一个**只**负责抛错/返回的假规划器。 */
const plannerThat = (impl) => {
  const plan = async () => impl();
  return plan;
};
const providerThat = (plan) => ({plan});

test('① 超时 / 取消 / 其它 ⇒ 三种分类（不再是一个笼统的 planner-failed）', async () => {
  const cases = [
    [{code: 'timeout'}, 'planner-timeout-no-tools'],
    [{code: 'cancelled'}, 'planner-cancelled-no-tools'],
    [{code: 'weird'}, 'planner-failed-no-tools'],
  ];
  for (const [error, want] of cases) {
    const plan = plannerThat(() => { throw Object.assign(new Error('x'), error); });
    const out = await gatherAgentEvidence({message: '换宠要花一个回合吗', context: context(), plan, planProvider: providerThat(plan)});
    assert.equal(out.stopped, want, `error.code=${error.code} 必须归到 ${want}`);
    assert.ok(out.trace.length === 0, '抛错时不该有工具回执');
  }
});

test('② 「输出不是 JSON」不许伪装成「模型主动停止」', async () => {
  // 本地网关在 unparseable 时会 return {stop:true} 并把原因写在 provider.lastDecision.reason
  const plan = plannerThat(() => ({stop: true}));
  const unparseable = providerThat(plan);
  unparseable.lastDecision = {decision: 'stop', reason: 'unparseable'};
  const bad = await gatherAgentEvidence({message: '换宠要花一个回合吗', context: context(), plan, planProvider: unparseable});
  assert.equal(bad.stopped, 'planner-json-invalid', 'unparseable 必须被单独记成一类（它以前被记成 complete）');

  const modelStop = providerThat(plan);
  modelStop.lastDecision = {decision: 'stop', reason: 'model-stop'};
  const good = await gatherAgentEvidence({message: '换宠要花一个回合吗', context: context(), plan, planProvider: modelStop});
  assert.equal(good.stopped, 'complete', '模型主动停止仍然是 complete');
});

test('② 边界：拿不到 lastDecision 时**不猜**（一律按主动停止）', async () => {
  const plan = plannerThat(() => ({stop: true}));
  const out = await gatherAgentEvidence({message: '换宠要花一个回合吗', context: context(), plan});
  assert.equal(out.stopped, 'complete', '没有 lastDecision 就说不了是 unparseable —— 不许把"不知道"写成失败');
});

test('③ 反证：把分类改回笼统值 ⇒ 必须能被发现（判据不是装饰）', () => {
  // 判据的实现面：源码里必须存在三种分类与 unparseable 分支（改了它，上面两条会红；这里再钉一层，防"顺手删掉"）
  for (const needle of ["code==='timeout'?'planner-timeout'", "code==='cancelled'?'planner-cancelled'",
    "reason==='unparseable'", "'planner-json-invalid'"]) {
    assert.ok(RUNTIME_SRC.includes(needle), `runtime.js 必须仍然包含 ${needle}`);
  }
  assert.ok(!/catch\{return \{trace,stopped:trace\.length\?'planner-failed'/.test(RUNTIME_SRC),
    '旧的笼统 catch 不许回来');
});

test('③ 循环上限没被顺手放大（ReAct **不加步数**是本轮的结论）', () => {
  const bounds = [...RUNTIME_SRC.matchAll(/Math\.min\((\d+),\s*limit\)/g)].map((m) => Number(m[1]));
  assert.ok(bounds.length > 0, '找不到有界循环的上限：这一条判据失去对象');
  for (const bound of bounds) {
    assert.ok(bound <= 4, `ReAct 循环上限必须 ≤4（当前 ${bound}）—— 外部与本仓实测都指向"小模型上多步是负收益"`);
  }
});
