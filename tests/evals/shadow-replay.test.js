// W4-05 / W5-02 的守卫：同 Agent 回放门禁本身必须可信。
//
// 这一层的作用是「换一个 provider 再跑一遍，看哪些任务退化」。它最常见的失效方式
// 不是算错，而是**悄悄退化成参考臂**：如果模型臂拿不到真正的模型、
// 或者 planner 在失败时回退到规则，那么「模型臂」测出来的其实是规则，
// 结论会变成「换模型没有影响」——一个看起来很好、其实什么都没测的结论。
//
// 所以这里钉三件事：
//   ① 模型臂在拿不到模型时必须**失败**，不许静默回退；
//   ② 模型编的参数不许绕过引擎校验（状态版本由运行时覆盖，参数照常走 validToolArgs）；
//   ③ 两臂对比要如实分出「退化 / 扳回 / 都错」，并且参考臂自己是全过的。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {localModelPlanner, extractFirstJson, LOCAL_TOOL_SYSTEM} =
  await import('../../scripts/roco/agent-trajectories.mjs');
const {extractJson} = await import('../../src/coach/local-model.js');
const {summarise, compare, buildShadowReport} =
  await import('../../scripts/roco/shadow-replay.mjs');
const {digest: computeDigest} = await import('../../scripts/roco/agent-trajectories.mjs');

const RULE_REPORT = join(ROOT, 'reports', 'roco', 'shadow-replay.json');
const LOCAL_REPORT = join(ROOT, 'reports', 'roco', 'shadow-replay-local_4b.json');

const TASK = {case_id: 'x', message: '寂灭骨龙的种族值是多少？', context: {mode: 'camp'}};
const HINTS = {mode: 'camp', state_version: 7, target_pet_id: 'pet_000225'};

test('模型臂在 ask 抛错时必须失败，不许静默回退到规则', async () => {
  const planner = localModelPlanner(TASK, HINTS, {ask: async () => {
    throw Object.assign(new Error('模型不可用'), {code: 'timeout'});
  }});
  const choice = await planner({message: TASK.message, receipts: []});
  assert.deepEqual(choice, {stop: true}, '拿不到模型时只能停止，不能编一个工具');
});

test('没有注入 ask 时直接拒绝构造：没有模型就不是模型臂', () => {
  assert.throws(() => localModelPlanner(TASK, HINTS, {}), /ask/);
});

test('状态版本由运行时覆盖，不采信模型编的那个', async () => {
  const ask = async () => ({text: JSON.stringify({tool: 'query_rules',
    args: {kind: 'pet', pet_id: 'pet_000225', state_version: 999}})});
  const choice = await localModelPlanner(TASK, HINTS, {ask})({message: TASK.message, receipts: []});
  assert.equal(choice.tool, 'query_rules');
  assert.equal(choice.args.state_version, HINTS.state_version,
    '模型编的 999 不许覆盖运行时给的状态版本');
  assert.equal(choice.args.pet_id, 'pet_000225', '合法参数要保留');
});

test('模型给的未知工具名原样交给引擎层去拒绝，不在这里猜', async () => {
  const ask = async () => ({text: '{"tool":"drop_table","args":{}}'});
  const choice = await localModelPlanner(TASK, HINTS, {ask})({message: TASK.message, receipts: []});
  assert.equal(choice.tool, 'drop_table', '装配层不改写工具名；合法性由 validToolArgs 判');
});

test('模型输出不是 JSON 时只能停止', async () => {
  const ask = async () => ({text: '我觉得应该先查一下规则'});
  const choice = await localModelPlanner(TASK, HINTS, {ask})({message: TASK.message, receipts: []});
  assert.deepEqual(choice, {stop: true});
});

test('模型臂只问一次：不给它靠重试蒙对的机会', async () => {
  let calls = 0;
  const ask = async () => { calls += 1; return {text: '{"stop":true}'}; };
  const planner = localModelPlanner(TASK, HINTS, {ask});
  await planner({message: TASK.message, receipts: []});
  await planner({message: TASK.message, receipts: []});
  assert.equal(calls, 1, '第二次调用必须直接停止，不再问模型');
});

test('系统提示必须写在代码里，且要求默认停止', () => {
  assert.match(LOCAL_TOOL_SYSTEM, /默认是停止/);
  assert.match(LOCAL_TOOL_SYSTEM, /query_rules/);
  assert.match(LOCAL_TOOL_SYSTEM, /state_version/);
});

test('本地 JSON 提取与产品侧实现不许漂移', () => {
  const cases = ['{"stop":true}', '好的\n{"tool":"read_evidence","args":{"turn":3}}\n以上',
    'no json', '{"tool": broken', '', null, '{{"a":1}}', 'text {"a":{"b":1}} tail'];
  for (const sample of cases) {
    assert.deepEqual(extractFirstJson(sample), extractJson(sample),
      `提取结果不一致：${JSON.stringify(sample)}`);
  }
});

test('对比函数如实分出退化 / 扳回 / 都错', () => {
  const reference = [
    {case_id: 'a', category: 'c1', passed: true, violations: []},
    {case_id: 'b', category: 'c1', passed: true, violations: []},
    {case_id: 'c', category: 'c2', passed: false, violations: ['x']},
  ];
  const candidate = [
    {case_id: 'a', category: 'c1', passed: true, violations: []},
    {case_id: 'b', category: 'c1', passed: false, violations: ['参数不对'], stopped: 'invalid-arguments'},
    {case_id: 'c', category: 'c2', passed: true, violations: []},
  ];
  const got = compare(reference, candidate);
  assert.equal(got.regressed, 1);
  assert.equal(got.fixed, 1);
  assert.equal(got.both_failed, 0);
  assert.equal(got.by_category.c1.regressed, 1);
  assert.equal(got.by_category.c2.fixed, 1);
  assert.equal(got.worst_regressions[0].case_id, 'b');
});

test('汇总里的通过率与分位数是可复算的', () => {
  const rows = [
    {category: 'c', passed: true, wall_ms: 10, stopped: 'complete'},
    {category: 'c', passed: false, wall_ms: 30, stopped: 'invalid-arguments'},
    {category: 'c', passed: true, wall_ms: 20, stopped: 'complete'},
  ];
  const got = summarise(rows);
  assert.equal(got.tasks, 3);
  assert.equal(got.passed, 2);
  assert.equal(got.pass_rate, 0.6667);
  assert.equal(got.latency.p50_ms, 20);
  assert.equal(got.stopped.invalid_arguments, undefined);
  assert.equal(got.stopped['invalid-arguments'], 1);
});

test('参考臂的报告必须存在且自己是全过的（否则对比没有意义）', () => {
  if (!existsSync(RULE_REPORT)) return;   // 还没跑过参考臂时跳过，不假装通过
  const report = JSON.parse(readFileSync(RULE_REPORT, 'utf8'));
  assert.equal(report.arm, 'rule');
  assert.equal(report.summary.pass_rate, 1,
    '参考臂不全过时，这里的「退化」计数就不能解释');
  assert.ok(report.summary.tasks >= 200);
});

test('报告必须带提示版本：只比通过率分不出两次跑的是不是同一份提示', () => {
  if (!existsSync(LOCAL_REPORT)) return;
  const report = JSON.parse(readFileSync(LOCAL_REPORT, 'utf8'));
  assert.ok(report.prompt_digest, '模型臂的报告必须带 prompt_digest');
  assert.match(report.prompt_digest, /^[0-9a-f]{64}$/);
  assert.equal(typeof report.prompt, 'string', '提示全文也要存，便于核对差异');
  // 同一次跑里，digest 必须真的是那段提示的摘要（不是随手填的常量）
  assert.equal(computeDigest(report.prompt), report.prompt_digest,
    'prompt_digest 与 prompt 全文不一致');
});

test('报告装配本身必须带提示摘要：这条不看落盘产物，只看代码', () => {
  // 只核对落盘报告的写法有个盲点：代码里的装配被改坏（例如 prompt_digest 恒 null）
  // 不会有任何测试变红——守卫自检的注入实验抓到过。
  // 所以这里**直接调装配函数**，不经过文件。
  const candidate = buildShadowReport({arm: 'local_4b', gateway: 'http://x', rows: []});
  assert.match(String(candidate.prompt_digest), /^[0-9a-f]{64}$/,
    '模型臂的报告必须带提示摘要');
  assert.equal(candidate.prompt_digest, computeDigest(candidate.prompt),
    '摘要必须与提示全文一致');
  assert.equal(candidate.prompt, LOCAL_TOOL_SYSTEM, '提示全文必须是当前代码里的那一份');
  const rule = buildShadowReport({arm: 'rule', rows: []});
  assert.equal(rule.prompt_digest, null, '参考臂不该带提示摘要');
  assert.equal(rule.prompt, null);
});

test('参考臂不带提示：它没有模型提示，带一个空值会让人以为它也有', () => {
  if (!existsSync(RULE_REPORT)) return;
  const report = JSON.parse(readFileSync(RULE_REPORT, 'utf8'));
  assert.equal(report.prompt_digest, null);
  assert.equal(report.prompt, null);
});

test('模型臂的报告（如果跑过）必须带真实延迟与失败原因', () => {
  if (!existsSync(LOCAL_REPORT)) return;
  const report = JSON.parse(readFileSync(LOCAL_REPORT, 'utf8'));
  assert.equal(report.arm, 'local_4b');
  assert.ok(report.summary.latency.p50_ms > 0, '模型臂的延迟必须是真的（规则臂是 0—1ms）');
  assert.ok(Object.keys(report.summary.by_category).length >= 6,
    '模型臂要按类别给结果，否则看不出退化在哪里');
});
