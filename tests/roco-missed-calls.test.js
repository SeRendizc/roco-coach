// `analyze-missed-calls.mjs` 的判据（2026-09-25）。
//
// 这支脚本的作用是把 `missedCallRate` 拆成「金标过期」与「真缺口」——
// 它一旦把「政策判不必查 + 答复**没**通过校验」也算成金标过期，就会把真实的失败
// **洗成**指标问题（那正是最危险的方向）。所以反证是这条判据的核心。
import test from 'node:test';
import assert from 'node:assert/strict';

import {analyze, classify, grounded} from '../scripts/roco/analyze-missed-calls.mjs';

const row = (over = {}) => ({
  id: 'cX', cat: 'cat1-needs-lookup', question: '示例问题', expect: {calls: [1, 1], tools: ['read_state']},
  calls: 0, agentStop: 'policy-no-tool', evidenceCount: 8, validation: {valid: true}, ...over,
});

test('① 政策判不必查 + 答复有据 ⇒ 金标过期（不是能力缺口）', () => {
  assert.equal(classify(row()), 'policy-silent-grounded');
  // 依据条数就能证明"答复里的数有出处"（老产物可能没有 validation 字段）
  assert.equal(classify(row({validation: undefined, evidenceCount: 3})), 'policy-silent-grounded');
});

test('② 反证：政策判不必查但答复**没**依据 ⇒ 必须算真缺口（不许洗成金标过期）', () => {
  const bad = row({validation: {valid: false}, evidenceCount: 0});
  assert.equal(grounded(bad), false, '没通过校验就是没依据');
  assert.equal(classify(bad), 'policy-silent-ungrounded',
    '这一桶一旦被并进"金标过期"，真实的失败就被洗掉了');
});

test('③ 模型自己没调 / 记账缺失 / 没欠调用，各归各的桶', () => {
  assert.equal(classify(row({agentStop: 'complete', calls: 0})), 'model-silent');
  assert.equal(classify(row({agentStop: null, calls: 0})), 'no-stop');
  assert.equal(classify(row({calls: 2})), null, '没欠调用就不该出现在任何桶里');
  const result = analyze({rows: [
    row(),
    row({id: 'cY', validation: {valid: false}, evidenceCount: 0}),
    row({id: 'cZ', agentStop: 'complete'}),
    row({id: 'cW', calls: 2}),
  ]});
  assert.deepEqual([result.total, result.missedTotal], [4, 3]);
  assert.deepEqual([result['policy-silent-grounded'].length, result['policy-silent-ungrounded'].length,
    result['model-silent'].length, result['no-stop'].length], [1, 1, 1, 0]);
});
