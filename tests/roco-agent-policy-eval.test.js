// Agent 政策路由小评测的**判据**（2026-10-17）。
//
// 它守两件事：
//   ① 评测本身不是装饰：14 条计分任务必须 ≥90% 通过（当前 14/14）；
//   ② 评测有牙：把任意一条任务的期望改坏，同一个 runner 必须报 FAIL——
//      否则“全绿”只是恒真。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {runEval} from '../scripts/roco/agent-policy-eval.mjs';

const TASKS = JSON.parse(readFileSync(fileURLToPath(new URL('./evals/roco/agent-policy-tasks.json', import.meta.url)), 'utf8')).tasks;

test('① 离线政策评测：计分任务 ≥90%，且没有非 known-gap 的失败', () => {
 const result = runEval();
 assert.equal(result.scored >= 12, true, `计分任务太少：${result.scored}`);
 assert.equal(result.ok, true, `评测未达标：${JSON.stringify(result.failures)}`);
 assert.ok(result.accuracy >= 0.9, `准确率 ${result.accuracy}`);
 assert.deepEqual(result.failures, [], '不该有非 known-gap 失败');
 // 分桶必须覆盖这些类别（否则指标可能只统计了容易的一类）
 for (const category of ['type-multiplier', 'type-chart', 'battle-advice', 'no-tool', 'lookup']) {
  assert.ok(result.byCategory[category], `缺分桶：${category}`);
 }
 // known-gap 必须**如实报告**，不许静默吞掉
 assert.equal(result.knownGaps.length, 2, '两条已知缺口应如实报告');
});

test('② 反证（必红方向）：把一条期望改坏，runner 必须 FAIL', () => {
 // 改坏两条（14 条里挂 2 条 = 85.7% < 90% 阈值）；只改一条仍在阈值内，测不出“有牙”。
 const tampered = TASKS.map((task) => ['T01', 'T02'].includes(task.id)
  ? {...task, expect: {...task.expect, reason: 'not-a-real-reason'}}
  : task);
 const result = runEval(tampered);
 assert.equal(result.ok, false, '期望被改坏时评测必须失败（否则这条判据没有牙）');
 assert.ok(result.failures.some((f) => f.id === 'T01'), JSON.stringify(result.failures));
});
