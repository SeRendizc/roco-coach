// 判定口径的**影子档**判据（2026-09-25，人类要求：把"该不该调工具"的口径之争变成一个数字）。
//
// 背景（逐行核实过，不是转述）：
//   (乙) 代码化 = `src/coach/runtime.js::policyFor()`（默认 `{need:null, reason:'state-in-packet'}`：
//        实时状态从 receipts 答，只有包里结构上没有的四类才要工具）；planner 提示词
//        （`src/server/index.js:442-447`「默认是停止」「receipts 里已经有的事实不要再调」）与它一致。
//   (甲) = 评测金标（`scripts/eval-live-s04.js` 的 `CASES`：`cat1-needs-lookup` 的 `expect.calls:[1,1]`）：
//        问当前局面事实（血量/能量/道具/合法行动/后备/速度先手/压制关系）**必须查证**。
// ⇒ **是两方冲突（代码+提示词 vs 金标），不是三方**。
//
// 本文件钉三件事：① `off` 档只多字段、**行为与回执逐字节一致**；② `shadow/on` 档每条都带替代判定；
// ③ **反证**：把 (甲) 口径写成结论（真去改行为）时必须红 —— 行为只能由 `policyFor` 决定。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {buildContext, judgeMode, judgeToolNeed, runCoach} from '../src/coach/runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_SRC = 'src/coach/runtime.js';

/** 纯函数判据：一份事实 → 问题列表（空 = 通过）。真跑与反证共用同一条。 */
function shadowProblems({off, on, behaviorSource}) {
  const bad = [];
  if (!off) bad.push('off 档回执没拿到（采样失败 ⇒ 读不到就不算验过）');
  else if (Object.hasOwn(off, 'judgment')) {
    bad.push('off 档回执里出现了 judgment 字段 —— 开关关着时回执必须与 baseline 逐字节一致');
  }
  if (!on) bad.push('shadow 档回执没拿到');
  else if (!on.judgment || typeof on.judgment !== 'object') {
    bad.push('shadow 档回执缺 judgment 字段（每条都该带替代判定）');
  } else {
    for (const key of ['mode', 'policy', 'alternative', 'agree', 'basis']) {
      if (!Object.hasOwn(on.judgment, key)) bad.push(`judgment 缺 ${key}`);
    }
    if (on.judgment.policy && !Object.hasOwn(on.judgment.policy, 'need')) bad.push('judgment.policy 缺 need');
    if (on.judgment.alternative && !Object.hasOwn(on.judgment.alternative, 'need')) {
      bad.push('judgment.alternative 缺 need（替代口径必须给"要不要调"）');
    }
  }
  // 行为只许由政策决定：出现替代口径参与行为 ⇒ 红
  if (typeof behaviorSource === 'string' && /judgment|alternative/.test(behaviorSource)) {
    bad.push('行为的 mustCall 取自替代口径 —— (甲) 被写成了结论（移动了玩家可见行为），必须红');
  }
  return bad;
}

/** 只比较"去掉 judgment 之后"的回执：用来证明开关只多字段、不改行为。 */
const withoutJudgment = (receipt) => {
  const {judgment: _j, ...rest} = receipt ?? {};
  return rest;
};

const askLiveState = (message) => runCoach({
  message, context: buildContext(createGame(), newProfile(), 'fox'), memory: freshMemory(),
});

test('① off 档：回执里没有 judgment；shadow 档：只多这一个字段，其余逐字节相同', async () => {
  const previous = process.env.ROCO_JUDGE;
  try {
    delete process.env.ROCO_JUDGE;
    const off = await askLiveState('我现在场上这只还剩多少血？能量够放技能吗？');
    process.env.ROCO_JUDGE = 'shadow';
    const on = await askLiveState('我现在场上这只还剩多少血？能量够放技能吗？');
    const problems = shadowProblems({off, on, behaviorSource: 'mustCall: policy.need'});
    assert.deepEqual(problems, [], problems.join(' | '));
    assert.equal(JSON.stringify(withoutJudgment(on)), JSON.stringify(off),
      'shadow 档除了多一个 judgment 字段之外，回执其余部分必须与 off 档逐字节相同（不许改行为）');
    assert.equal(on.judgment.mode, 'shadow');
    assert.equal(on.judgment.policy.reason, 'state-in-packet');
    assert.equal(on.judgment.alternative.reason, 'must-verify-live-state');
    assert.equal(on.judgment.agree, false, '这一句正是两方口径的分歧点');
  } finally {
    if (previous === undefined) delete process.env.ROCO_JUDGE; else process.env.ROCO_JUDGE = previous;
  }
});

test('② shadow/on：逐例都带替代判定，且四类问题的判定符合口径定义', () => {
  const context = buildContext(createGame(), newProfile(), 'fox');
  const cases = [
    ['我现在场上这只还剩多少血？', 'state-in-packet', 'must-verify-live-state', false],
    ['第5回合到底发生了什么？', 'named-turn', 'same-as-policy', true],
    ['你好', 'chitchat-or-parametric', 'not-a-factual-ask', true],
    ['这个套路有什么反例？', 'tactics-knowledge', 'same-as-policy', true],
  ];
  for (const [message, policyReason, altReason, agree] of cases) {
    const j = judgeToolNeed(message, context);
    assert.equal(j.policy.reason, policyReason, `「${message}」的政策判定`);
    assert.equal(j.alternative.reason, altReason, `「${message}」的替代判定`);
    assert.equal(j.agree, agree, `「${message}」两方是否一致`);
    assert.ok(['shadow', 'on'].includes(j.mode) || j.mode === 'off');
  }
  assert.equal(judgeMode({}), 'off', '默认必须是 off');
  assert.equal(judgeMode({ROCO_JUDGE: 'shadow'}), 'shadow');
  assert.equal(judgeMode({ROCO_JUDGE: '是的'}), 'off', '不认识的值一律当 off（fail closed）');
});

test('③ 结构钉：行为只能由政策决定（mustCall 不许取替代口径）', () => {
  const source = readFileSync(join(ROOT, RUNTIME_SRC), 'utf8');
  const wiring = source.split('\n').filter((line) => /mustCall\s*:/.test(line) && !/^\s*\/\//.test(line));
  assert.ok(wiring.length > 0, '找不到 mustCall 的接线点：判据不许变空');
  const problems = shadowProblems({off: {}, on: {judgment: {mode: 'shadow', policy: {need: null},
    alternative: {need: 'read_state'}, agree: false, basis: 'live-state-split'}},
  behaviorSource: wiring.join('\n')});
  assert.deepEqual(problems, [], problems.join(' | '));
  assert.ok(wiring.some((line) => /policy\.need|requiredTool\(/.test(line)),
    `必须有一条 mustCall 取自政策：实际 ${JSON.stringify(wiring)}`);
});

test('④ 必红反证：把 (甲) 写成结论 / off 档多出字段 / 采样失败 —— 同一条判据都必须报', () => {
  const healthyJudgment = {mode: 'shadow', policy: {need: null}, alternative: {need: 'read_state'}, agree: false, basis: 'live-state-split'};
  // (a) 把 (甲) 真的写进行为
  const wired = shadowProblems({off: {}, on: {judgment: healthyJudgment}, behaviorSource: 'mustCall: judgment.alternative.need'});
  assert.ok(wired.some((x) => x.includes('替代口径')), `(甲) 写成结论必须报，实际 ${JSON.stringify(wired)}`);
  // (b) off 档多出字段
  const leaked = shadowProblems({off: {judgment: healthyJudgment}, on: {judgment: healthyJudgment}, behaviorSource: 'mustCall: policy.need'});
  assert.ok(leaked.some((x) => x.includes('off 档')), `off 档多字段必须报，实际 ${JSON.stringify(leaked)}`);
  // (c) 采样失败（拿不到回执）不许当通过
  const missing = shadowProblems({off: null, on: null, behaviorSource: null});
  assert.ok(missing.length >= 2, `采样失败必须报（读不到就不算验过），实际 ${JSON.stringify(missing)}`);
  // (d) 反证之反证：健康输入必须判空（判据不是恒假）
  assert.deepEqual(shadowProblems({off: {}, on: {judgment: healthyJudgment}, behaviorSource: 'mustCall: policy.need'}), []);
});
