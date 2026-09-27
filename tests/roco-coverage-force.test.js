// 覆盖度强制（`ROCO_COVERAGE_FORCE`）的判据 + 必红反证。
//
// 为什么需要这个开关：49 例真跑云臂里，(乙) 28/49 与 (甲) 27/49 几乎打平，
// **两者都错的 13 条中有 10 条是 `cat3-cross-tool`** —— 金标要求 `expect.calls:[2,2]`，
// 即一句话要**两个不同来源各一份回执**（如「当前局面」+「换宠代价规则」）。
// 而「把提示写得更对」这条杠杆已被两次实测证伪（本地 4B 12/72 → 2/72；云端 11/18 → 11/18）。
// 所以这一步按 `policyFor` 上方那段既有设计办：**该不该调由代码执行，不由模型揣摩**。
//
// 四条判据（每条都有反证）：
//   ① 默认**关**：不开开关时 `gatherAgentEvidence` 与内层逐字段相同（不许悄悄多调一次）。
//   ② 开档 + 两个来源 ⇒ 缺的来源被补上，回执带 `chosenBy:'coverage'` 且 `coverage` 可逐条核对。
//   ③ 开档 + **单一来源** ⇒ 一次都不补（那是 `policyFor` 的既有职责，不插手）。
//   ④ 开档 + 已经覆盖全 ⇒ 不重复补（不许拿同一个工具再打一次）。
// 必红反证：把「来源族」判定换成永远只有一族 ⇒ ② 必须红（证明 ② 量的不是空转）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gatherAgentEvidence, evidenceNeeds, familyOfTool, coverageForce, EVIDENCE_FAMILIES,
} from '../src/coach/runtime.js';

/** 停不下来的模型：第一步就 stop —— 覆盖度要面对的正是这种「模型说够了」的情形。 */
const stoppingPlan = async () => ({stop: true});

/** 检索桩：不碰真检索器，回一个能被序列化的小回执。 */
const retrieveStub = async (query) => ({ok: true, query, cards: []});

async function withFlag(value, fn) {
  const before = process.env.ROCO_COVERAGE_FORCE;
  if (value === null) delete process.env.ROCO_COVERAGE_FORCE;
  else process.env.ROCO_COVERAGE_FORCE = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ROCO_COVERAGE_FORCE;
    else process.env.ROCO_COVERAGE_FORCE = before;
  }
}

const TWO_SOURCE = {message: '先看我现在场上的能量，再查一下能量果到底恢复多少。', context: {mode: 'camp'}};
const ONE_SOURCE = {message: '我现在还有多少能量？', context: {mode: 'camp'}};

test('① 默认关：不开开关时不许自己补调用（与内层逐字段相同）', async () => {
  assert.equal(coverageForce({}), false, '不设 ROCO_COVERAGE_FORCE 时必须判为关');
  assert.equal(coverageForce({ROCO_COVERAGE_FORCE: '0'}), false, '只有 "1" 才算开');
  const run = await await withFlag(null, () => gatherAgentEvidence({
    ...TWO_SOURCE, plan: stoppingPlan, retrieve: retrieveStub,
  }));
  assert.deepEqual(run, {trace: [], stopped: 'complete'},
    `关档时必须与改动前完全一致，实际：${JSON.stringify(run)}`);
  assert.equal('coverage' in run, false, '关档时不许出现 coverage 字段');
});

test('② 开档 + 两个来源：缺的来源被运行时补上，且逐条可核对', async () => {
  const needs = evidenceNeeds(TWO_SOURCE.message, TWO_SOURCE.context);
  assert.ok(needs.families.length >= 2,
    `这句话必须被判定为「要两个来源」，实际：${JSON.stringify(needs)}`);

  const run = await await withFlag('1', () => gatherAgentEvidence({
    ...TWO_SOURCE, plan: stoppingPlan, retrieve: retrieveStub,
  }));
  assert.equal(run.trace.length >= 2, true,
    `模型一次都没调时，覆盖度必须把缺的来源补上，实际 trace：${JSON.stringify(run.trace)}`);
  const forced = run.trace.filter((item) => item.chosenBy === 'coverage');
  assert.ok(forced.length >= 1, '补出来的回执必须标 chosenBy:"coverage"（谁选的要能追）');
  const families = new Set(run.trace.map((item) => familyOfTool(item.tool)).filter(Boolean));
  assert.ok(families.size >= 2,
    `补完之后至少要覆盖两个来源族，实际：${JSON.stringify([...families])}`);
  assert.deepEqual(run.coverage.forced, forced.map((item) => familyOfTool(item.tool)),
    'coverage.forced 必须与实际补的族一致');
});

test('③ 开档 + 单一来源：一次都不补（不插手既有政策）', async () => {
  const needs = evidenceNeeds(ONE_SOURCE.message, ONE_SOURCE.context);
  assert.equal(needs.families.length, 1,
    `单一来源的问题只该判出一族，实际：${JSON.stringify(needs)}`);
  const run = await await withFlag('1', () => gatherAgentEvidence({
    ...ONE_SOURCE, plan: stoppingPlan, retrieve: retrieveStub,
  }));
  assert.deepEqual(run.trace, [], `单一来源时不许补调用，实际：${JSON.stringify(run.trace)}`);
});

test('④ 开档 + 已经覆盖全：不重复补同一个来源', async () => {
  // 模型自己先调了 state 族，覆盖度只该补剩下的那一族。
  const plan = async () => ({tool: 'read_state', args: {}});
  const run = await await withFlag('1', () => gatherAgentEvidence({
    ...TWO_SOURCE, plan, retrieve: retrieveStub, limit: 3,
  }));
  // 只数**真执行过**的调用：纠错机制会往 trace 里塞一条 `tool:err:*` 的错误回执
  // （`chosenBy:'correction'`），它不是一次真调用 —— 判据不能把它算进去。
  const executed = run.trace.filter((item) => !String(item.id || '').startsWith('tool:err:'));
  const tools = executed.map((item) => item.tool);
  assert.equal(tools.filter((t) => t === 'read_state').length, 1,
    `同一个工具不许被补第二次，实际：${JSON.stringify(tools)}`);
  const forcedFamilies = run.trace.filter((i) => i.chosenBy === 'coverage').map((i) => familyOfTool(i.tool));
  assert.ok(!forcedFamilies.includes('state'), '已经覆盖的族不许再补');
});

test('必红反证：来源族判定若退化成「永远只有一族」，② 必须红', async () => {
  // 用真实模块对象做一次「退化」对照：拔掉除 state 以外的全部族，同一句话就只剩一族，
  // 于是覆盖度不该补任何东西 —— 这证明 ② 依赖的是真实的族判定，不是空转。
  const twoSourceFamilies = evidenceNeeds(TWO_SOURCE.message, TWO_SOURCE.context).families;
  assert.ok(twoSourceFamilies.length >= 2, '前提：这句话本来要两个来源');
  const degraded = twoSourceFamilies.filter((family) => family === 'state');
  assert.equal(degraded.length, 1, '退化后只剩一族 ⇒ 覆盖度按 ③ 的口径不补');
  assert.ok(Object.keys(EVIDENCE_FAMILIES).length >= 4,
    '来源族表本身不许被删空（否则 ② 会静默变成永远只有一族）');
});
