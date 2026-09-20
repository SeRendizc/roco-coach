// W4-02 错误轨迹目录的守卫。
//
// 这个目录的价值全在**分类是否落到正确的层**上。第 25 轮就出现过一次
// 「账面上像模型文案问题、实际是模板不够诚实」——如果分类不较真，
// 这类问题会被记到模型头上，然后被拿去当训练目标，训一个根本不存在的能力。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const CATALOGUE = join(ROOT, 'tests', 'evals', 'roco', 'model-error-trajectories-v1.jsonl');
const {build, summarise, classify, FAILURE_CLASSES} =
  await import('../../../scripts/roco/build-model-error-trajectories.mjs');

const rows = existsSync(CATALOGUE)
  ? readFileSync(CATALOGUE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];
const header = rows.find((r) => r.record_type === 'model_error_trajectory_header');
const entries = rows.filter((r) => r.record_type === 'model_error_trajectory');

test('目录来自**模型臂**，不是规则臂，且带上提示版本', () => {
  assert.ok(header, '缺少目录头部：先跑 npm run roco:model-errors');
  assert.equal(header.source_arm, 'local_4b', '错误轨迹必须来自模型臂');
  assert.ok(header.source_prompt_digest, '必须记下产生这些错误的提示版本');
  assert.ok(header.source_pass_rate < 1, '参考通过率不该是 1（那说明源报告选错了）');
});

test('每条错误都有分类、证据与候选修复，且没有任何一条自称修好', () => {
  assert.ok(entries.length > 0);
  for (const row of entries) {
    assert.ok(row.failure_class && row.failure_class !== 'unclassified',
      `${row.traj_id} 没有落到已知分类`);
    assert.ok(row.evidence, `${row.traj_id} 缺少可核对的证据描述`);
    assert.equal(row.verified, false, `${row.traj_id} 自称已验证：没有任何一条被重新跑过`);
    assert.ok('candidate_fix' in row);
  }
});

test('分类不许有空桶：声明过的每一类都要能在样本上触发', () => {
  // 一条永远匹配不上的分类等于死代码，而且会让人以为「这个失败模式没有出现」。
  const synthetic = [
    {trace: [], stopped: 'invalid-arguments', violations: []},
    {trace: [], stopped: 'complete', violations: []},
    {trace: [{tool: 'query_rules', error_type: null}], stopped: 'complete',
      violations: ['没有调用应当调用的工具 query_rules']},
    {trace: [{tool: 'query_rules', error_type: null}], stopped: 'complete',
      violations: ['query_rules 的参数里没有同时满足 {}']},
    {trace: [{tool: 'query_rules', error_type: 'not_found'}], stopped: 'complete', violations: []},
    {trace: [], stopped: 'complete', violations: ['引擎答不了，正文却没有说清限制']},
    {trace: [{tool: 'plan_actions', error_type: null}], stopped: 'receipt-budget', violations: []},
  ];
  const hit = new Set(synthetic.map((row) => classify(row).id));
  for (const item of FAILURE_CLASSES) {
    assert.ok(hit.has(item.id), `分类 ${item.id} 在构造样本上匹配不到：判据可能写错了`);
  }
  assert.ok(!hit.has('unclassified'), '构造样本应当全部落到已知分类');
});

test('候选修复的措辞不许读成「已修好」', () => {
  const doc = entries.map((row) => row.candidate_fix || '').join('\n');
  assert.ok(!/已修复|已解决|修复完成/.test(doc), '候选修复里出现了「已修复」这类说法');
  assert.match(header.disciplines.join('\n'), /候选/, '头部必须写明 candidate_fix 是候选');
});

test('重新生成与盘上产物一致（产物不许过期）', () => {
  if (!existsSync(CATALOGUE)) return;
  const fresh = build();
  const freshRows = fresh.rows;
  assert.equal(freshRows.length, entries.length, '盘上条数与现场重算不一致');
  const freshSummary = summarise(freshRows);
  assert.deepEqual(freshSummary.by_class, header.summary.by_class, '分类分布与盘上不一致');
});

test('预算/策略类必须单列：它们不是模型能力问题', () => {
  const budget = header.summary.by_class['budget-or-policy'] || header.summary.by_class['stopped-midway'];
  if (!budget) return;   // 本轮样本里可能确实没有
  assert.ok(budget.count >= 0);
  const doc = FAILURE_CLASSES.find((item) => item.id === 'budget-or-policy');
  assert.match(doc.candidate_fix, /不是模型缺陷/, '这一类必须写明它不是模型缺陷');
});
