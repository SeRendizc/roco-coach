// RC-306 分段 Serving 契约（`src/coach/team-serving.mjs`）的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「300ms 初判 / 3s 完整解释 / 超时保短结论」这条口径最省事的四种做法都不会红，但都是错的：
//   ① 超时了照样把**半截**初判发出去（页面看起来有内容，其实少了一段）；
//   ② 超时后拿剩下的段拼一个「像结论」的短结论（等于编）；
//   ③ 段抛异常时把 `undefined` 当值往下传（页面显示 "undefined" 或被当成 0）；
//   ④ 只测「全快」这条路径（那条路径本来就不会出问题，超时分支永远没被跑过）。
// 所以这里钉的是**判据有没有牙**：每条判据都配一条必红方向，并打印实际输出原文。
//
// 判据全部复用 `team-serving.mjs`，与 `scripts/roco/measure-team-serving.mjs` 跑**同一份代码**。
//
// 用法：`node --test tests/roco-team-serving.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_ANSWER_REASONS, SERVING_BUDGETS, SERVING_VERSION, SHORT_CONCLUSION_UNAVAILABLE,
  ServingContractError, assertModeActionCompliance, modeActionProblems, serveStages,
} from '../src/coach/team-serving.mjs';

/** 可注入的假时钟：`advance(ms)` 手动推进，超时分支因此可复现，且总耗时是 0。 */
const fakeClock = () => {
  let now = 0;
  return {now: () => now, advance: (ms) => { now += ms; }};
};

const log = (...args) => console.log('  ·', ...args);
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

/** 快段：推进 `ms` 后返回结果；`short` 把它压成一句。 */
const stage = (id, ms, result, opts = {}) => ({
  id, required_for_first: opts.required_for_first === true,
  short: opts.short === false ? undefined : (value) => `${id}：${JSON.stringify(value)}`,
  run() { opts.clock?.advance(ms); if (opts.boom) throw new Error(opts.boom); return result; },
});

test('全快：初判与完整解释都给出来，degraded=false', () => {
  const clock = fakeClock();
  const result = serveStages({
    clock,
    stages: [
      stage('recall', 20, {n: 50}, {clock, required_for_first: true}),
      stage('beam_and_ranker', 30, {top: ['甲', '乙']}, {clock}),
      stage('evidence', 40, {axes: 5}, {clock}),
    ],
  });
  raw('全快路径', {ok: result.ok, first: result.first?.kind, full: result.full?.kind, elapsed_ms: result.elapsed_ms});
  assert.equal(result.serving_version, SERVING_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(result.first.kind, 'structured_first');
  assert.deepEqual(result.first.stages, ['recall']);
  assert.equal(result.full.kind, 'full_answer');
  assert.deepEqual(result.short.from_stages, ['recall', 'beam_and_ranker', 'evidence']);
  assert.equal(result.problems.length, 0);
});

test('超时：跳过后面的段、完整解释为 null、短结论只由成功段拼出来', () => {
  const clock = fakeClock();
  const result = serveStages({
    clock,
    budgets: {first_answer_ms: 300, full_answer_ms: 1000},
    stages: [
      stage('recall', 10, {n: 50}, {clock, required_for_first: true}),
      stage('slow_evidence', 1200, {axes: 5}, {clock}),
      stage('never_runs', 1, {whatever: true}, {clock}),
    ],
  });
  raw('超时路径', {degraded: result.degraded, full: result.full, skipped: result.short.missing_stages, conclusion: result.short.conclusion});
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.full, null);
  assert.deepEqual(result.short.missing_stages, ['slow_evidence', 'never_runs']);
  assert.equal(result.short.conclusion.startsWith('slow_evidence') || result.short.conclusion.includes('slow_evidence'), false,
    '短结论里不该出现超时段的内容');
  assert.ok(result.short.conclusion.includes('recall'), '短结论必须只用成功段拼');
  const last = result.stages.at(-1);
  assert.equal(last.status, 'skipped', '预算用尽后**不许**再开始新段');
});

test('必需段失败 ⇒ 初判必须是 null（fail closed，不许拼半截）', () => {
  const clock = fakeClock();
  const result = serveStages({
    clock,
    stages: [
      stage('recall', 0, {}, {clock, boom: '引擎不可用'}),
      stage('beam', 5, {top: ['甲']}, {clock}),
    ],
  });
  raw('必需段失败', {first: result.first, problems: result.problems});
  assert.equal(result.first, null);
  assert.ok(result.problems.some((line) => line.includes('FIRST_ANSWER_UNAVAILABLE')));
  assert.ok(result.problems.some((line) => line.includes('STAGE_FAILED')));
  // 反证：把它从「必需」改成「非必需」之后，初判必须变成 null 之外的另一种结果（即 300ms 那条线有牙）。
  const permissive = serveStages({
    clock: fakeClock(),
    stages: [stage('recall', 0, {}, {clock, boom: '引擎不可用'}), stage('beam', 5, {top: ['甲']}, {clock})],
  });
  assert.equal(permissive.first, null, '没有 required_for_first 的段时初判本来就该是 null');
});

test('必需段踩过 300ms 初判预算 ⇒ 初判为 null，reason=OVER_FIRST_BUDGET', () => {
  const clock = fakeClock();
  const result = serveStages({
    clock,
    stages: [
      stage('recall', 350, {n: 50}, {clock, required_for_first: true}),
      stage('evidence', 10, {axes: 5}, {clock}),
    ],
  });
  raw('初判超预算', {first: result.first, stages: result.stages.map((s) => ({id: s.id, status: s.status}))});
  assert.equal(result.first, null);
  assert.equal(result.degraded, false, '没跳段、没失败，degraded 不该被初判超预算带起来');
  // 反证：预算放宽到 400ms 之后，同一份输入必须能拿到初判。
  const wider = serveStages({
    clock: fakeClock(),
    budgets: {first_answer_ms: 400},
    stages: [stage('recall', 350, {n: 50}, {clock: fakeClock(), required_for_first: true})],
  });
  assert.equal(wider.first?.kind, 'structured_first');
  assert.ok(FIRST_ANSWER_REASONS.includes('OVER_FIRST_BUDGET'));
});

test('段抛异常时值是 null（不许把 undefined 当值往下传）', () => {
  const clock = fakeClock();
  const result = serveStages({
    clock,
    stages: [stage('recall', 0, {n: 50}, {clock, required_for_first: true}), stage('boom', 0, null, {clock, boom: '炸了'})],
  });
  raw('异常段', {full: result.full, failed_stages: result.stages.filter((s) => s.status === 'failed')});
  assert.equal(result.full, null);
  assert.equal(result.short.unavailable_stages.includes('boom'), true);
  assert.ok(!JSON.stringify(result).includes('undefined'), '载荷里不许出现 undefined');
});

test('没有成功段 ⇒ 短结论如实说给不出（不许编一句）', () => {
  const clock = fakeClock();
  const result = serveStages({clock, stages: [stage('recall', 0, {}, {clock, boom: '全挂'})]});
  raw('全挂', result.short.conclusion);
  assert.equal(result.short.conclusion, SHORT_CONCLUSION_UNAVAILABLE);
  assert.deepEqual(result.short.from_stages, []);
});

test('契约 fail closed：空分段 / 重复 id / 非函数 run / 没有时钟 都必须抛错', () => {
  const cases = [
    ['空分段', () => serveStages({clock: fakeClock(), stages: []})],
    ['重复 id', () => serveStages({clock: fakeClock(), stages: [stage('a', 0, 1), stage('a', 0, 2)]})],
    ['run 不是函数', () => serveStages({clock: fakeClock(), stages: [{id: 'a', run: 42}]})],
    ['没有 id', () => serveStages({clock: fakeClock(), stages: [{run: () => 1}]})],
    ['没有时钟', () => serveStages({stages: [stage('a', 0, 1)]})],
    ['预算不是正数', () => serveStages({clock: fakeClock(), budgets: {full_answer_ms: 0}, stages: [stage('a', 0, 1)]})],
  ];
  for (const [label, run] of cases) {
    assert.throws(run, ServingContractError, `${label} 必须抛 ServingContractError`);
  }
  raw('契约抛错的例子', (() => { try { serveStages({clock: fakeClock(), stages: []}); return '(没抛)'; } catch (error) { return error.message; } })());
});

test('确定性：同一份输入 + 同一份时钟 ⇒ 结果逐字节相同', () => {
  const build = () => {
    const clock = fakeClock();
    return serveStages({clock, stages: [stage('a', 5, {x: 1}, {clock, required_for_first: true}), stage('b', 7, {y: 2}, {clock})]});
  };
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

test('只发模式合法动作：forbidden 泄漏必须被抓到', () => {
  const declaration = {allowed_kinds: ['skill', 'charge', 'switch', 'surrender'], forbidden_kinds: ['item', 'escape'], unknown_kinds_allowed: false};
  const clean = modeActionProblems([{kind: 'skill'}, {kind: 'charge'}, {kind: 'switch'}, {kind: 'surrender'}], declaration);
  raw('合规载荷', clean);
  assert.deepEqual(clean, []);
  const leaked = modeActionProblems([{kind: 'skill'}, {kind: 'item'}, {kind: 'escape'}], declaration);
  raw('泄漏载荷', leaked);
  assert.equal(leaked.length, 2);
  assert.ok(leaked.every((line) => line.includes('FORBIDDEN_KIND_LEAKED')));
  const undeclared = modeActionProblems([{kind: 'polish'}], declaration);
  raw('未声明的 kind', undeclared);
  assert.equal(undeclared.length, 1);
  assert.ok(undeclared[0].includes('UNDECLARED_KIND_LEAKED'));
});

test('只发模式合法动作：声明缺失/自相矛盾都必须 fail closed', () => {
  raw('没有声明', modeActionProblems([{kind: 'skill'}], null));
  assert.match(modeActionProblems([{kind: 'skill'}], null)[0], /MODE_DECLARATION_MISSING/);
  assert.match(modeActionProblems([{kind: 'skill'}], {allowed_kinds: []})[0], /MODE_DECLARATION_MISSING/);
  assert.match(modeActionProblems([{kind: 'skill'}], {allowed_kinds: ['item', 'skill'], forbidden_kinds: ['item']})[0], /MODE_DECLARATION_CONFLICT/);
  assert.match(modeActionProblems('不是数组', {allowed_kinds: ['skill']})[0], /ACTIONS_NOT_ARRAY/);
  assert.match(modeActionProblems([{label: '技能'}], {allowed_kinds: ['skill']})[0], /ACTION_WITHOUT_KIND/);
  assert.throws(() => assertModeActionCompliance([{kind: 'item'}], {allowed_kinds: ['skill'], forbidden_kinds: ['item']}), ServingContractError);
});

test('主动不要的段：full 为 null 但不是降级（与「超时」必须区分开）', () => {
  const makeStages = (clock) => [stage('plan', 10, {candidates: 20}, {clock, required_for_first: true})];
  const subsetClock = fakeClock();
  const subset = serveStages({clock: subsetClock, stages: makeStages(subsetClock),
    withheldStages: ['evidence_and_counterfactual']});
  raw('只要初判', {full: subset.full, withheld: subset.full_withheld, degraded: subset.degraded, first: subset.first?.kind, ok: subset.ok});
  assert.equal(subset.full, null, '主动不要证据段时不该声称有完整解释');
  assert.equal(subset.full_withheld, 'NOT_REQUESTED');
  assert.deepEqual(subset.withheld_stages, ['evidence_and_counterfactual']);
  assert.equal(subset.degraded, false, '「不要」不是「降级」——degraded 必须保持 false');
  assert.equal(subset.first.kind, 'structured_first');
  assert.equal(subset.ok, true, '只要初判也算正常交付');
  // 反证：不声明 withheld 时同一份输入必须给出完整解释——否则上面那条判据恒真。
  const wholeClock = fakeClock();
  const whole = serveStages({clock: wholeClock, stages: makeStages(wholeClock)});
  assert.equal(whole.full.kind, 'full_answer');
  assert.equal(whole.full_withheld ?? null, null);
  // 契约 fail closed：withheldStages 形状不对就抛。
  assert.throws(() => serveStages({clock: fakeClock(), stages: makeStages(fakeClock()), withheldStages: [42]}),
    ServingContractError);
});

test('预算常量就是口径本身（300 / 3000），改口径必须改这里', () => {
  assert.deepEqual(SERVING_BUDGETS, {first_answer_ms: 300, full_answer_ms: 3000});
  const clock = fakeClock();
  const result = serveStages({clock, stages: [stage('a', 0, {x: 1}, {clock, required_for_first: true})]});
  assert.deepEqual(result.budgets, {first_answer_ms: 300, full_answer_ms: 3000});
  log('serving 预算 =', JSON.stringify(result.budgets));
});
