/**
 * 判据：给"从没被考过"的工具造的**训练数据**，本身可信吗（人类 ⑤：「不许诈骗式」）。
 *
 * 三条硬线：① 每条参数都过 `validToolArgs`（正确性由构造保证）；② 切分按**模板**不重叠；
 * ③ 与留出切片**零重叠**（问句逐字不同）—— 否则就是拿考题当教材。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {validToolArgs, TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {TOOL_TEMPLATES, EXCLUDED, buildSamples} from '../scripts/roco/build-tool-coverage-sft.mjs';
import {LOCAL_TOOL_SYSTEM, PROMPT_DIGEST_PIN} from '../src/coach/shadow-tools.js';
import {createHash} from 'node:crypto';

const ROOT = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const rows = (split) => read(`reports/roco/sft-coverage/${split}.jsonl`).split('\n')
  .filter((line) => line.trim()).map((line) => JSON.parse(line));
const heldOut = read('tests/evals/agent-tasks-v2-tool-coverage.jsonl').split('\n')
  .filter((line) => line.trim()).map((line) => JSON.parse(line))
  .filter((row) => row.record_type === 'agent_tool_coverage_case');

test('① 每条正例的参数都必须过 validToolArgs（正确性由构造保证，不靠事后筛）', () => {
  let positives = 0;
  for (const split of ['train', 'valid', 'test']) {
    for (const row of rows(split)) {
      const target = JSON.parse(row.messages.at(-1).content);
      if (target.stop === true) continue;
      positives += 1;
      assert.ok(TOOL_CONTRACTS[target.tool], `${row.sample_id} 的工具不在契约里`);
      assert.equal(validToolArgs(target.tool, target.args ?? {}), true,
        `${row.sample_id} 的参数没过 validToolArgs：${JSON.stringify(target.args)}`);
    }
  }
  assert.ok(positives >= 24, `正样本太少（实际 ${positives}）`);
});

test('② 8 个工具在 train 里都有正例；负例的 target 必须是 {"stop":true}', () => {
  const train = rows('train');
  const covered = new Set(train.filter((row) => JSON.parse(row.messages.at(-1).content).tool)
    .map((row) => JSON.parse(row.messages.at(-1).content).tool));
  for (const tool of Object.keys(TOOL_TEMPLATES)) {
    assert.ok(covered.has(tool), `train 里没有「${tool}」的正例 ⇒ 它还是没被教过`);
  }
  const negatives = train.filter((row) => JSON.parse(row.messages.at(-1).content).stop === true);
  assert.ok(negatives.length >= 8, `负例太少（实际 ${negatives.length}）`);
  for (const row of negatives) {
    assert.deepEqual(JSON.parse(row.messages.at(-1).content), {stop: true}, `${row.sample_id} 的负例 target 不对`);
  }
});

test('③ 切分按**模板**：同一个模板不许出现在两个 split 里', () => {
  const where = new Map();
  for (const split of ['train', 'valid', 'test']) {
    for (const row of rows(split)) {
      const seen = where.get(row.template);
      assert.ok(!seen || seen === split, `模板 ${row.template} 同时出现在 ${seen} 与 ${split}`);
      where.set(row.template, split);
    }
  }
  assert.ok(where.size >= 24, `模板数太少（实际 ${where.size}）`);
  // 三个 split 都要非空
  for (const split of ['train', 'valid', 'test']) assert.ok(rows(split).length > 0, `${split} 是空的`);
});

test('④ 与留出切片零重叠：问句逐字不同、case_id 也不出现（否则是拿考题当教材）', () => {
  const heldMessages = new Set(heldOut.map((row) => row.message));
  const heldIds = new Set(heldOut.map((row) => row.case_id));
  for (const split of ['train', 'valid', 'test']) {
    for (const row of rows(split)) {
      const prompt = JSON.parse(row.messages[1].content);
      assert.ok(!heldMessages.has(prompt.message), `${row.sample_id} 的问句与留出用例逐字相同：${prompt.message}`);
      assert.ok(!heldIds.has(row.sample_id), `${row.sample_id} 撞了留出用例的 id`);
    }
  }
  // 反证：留出切片里的问句**确实**是另一批（否则上面的"零重叠"是空的）
  // 2026-09-27 改钉（人类：「附 1. 删」）：`inspect_training` 随加点一起退役 ⇒
  // 留出切片从 20 条变 **18** 条（9 个工具 × 正负各一）。判据的意思没变：留出集必须够大、
  // 而且与训练样本零重叠；数字跟着切片走。
  assert.ok(heldOut.length >= 18 && heldMessages.size >= 18,
    `留出切片太小（实际 ${heldOut.length} 条）`);
});

test('⑤ user 那一段必须是生产形状（toolPromptFor：message/screen/tools/hints/receipts）', () => {
  for (const split of ['train', 'valid', 'test']) {
    for (const row of rows(split)) {
      const prompt = JSON.parse(row.messages[1].content);
      for (const key of ['message', 'screen', 'tools', 'hints', 'receipts']) {
        assert.ok(key in prompt, `${row.sample_id} 的 user 缺少 ${key}`);
      }
      assert.equal(row.messages[0].role, 'system');
      assert.equal(row.messages.length, 3, '必须是 system/user/assistant 三条');
    }
  }
});

test('⑥ 生成器可重跑：两次产出的样本逐字段一致（数据是确定的，不是随机的）', () => {
  const first = JSON.stringify(buildSamples());
  const second = JSON.stringify(buildSamples());
  assert.equal(first, second, '两次生成不一致 ⇒ 训练数据不可复现');
  assert.ok(existsSync(new URL('reports/roco/sft-coverage/report.json', ROOT)), '报告要落盘');
  const report = JSON.parse(read('reports/roco/sft-coverage/report.json'));
  assert.equal(report.held_out_overlap, 0);
  // 故意排除的两个工具必须在报告里写清原因（不许悄悄少做）
  // 改钉（2026-09-26 §C6.285）：`search_rules` 因为与 `query_rules` 语义重叠、实测会把老门禁
  // 72 条整批改路由，因此也**不进训练数据**（只在留出切片里考）。
  assert.deepEqual(Object.keys(report.excluded).sort(), ['plan_actions', 'search_rules', 'summarize_battle']);
  for (const [tool, why] of Object.entries(EXCLUDED)) {
    assert.ok(why.length > 10, `${tool} 的排除原因要写清`);
    assert.ok(!(tool in TOOL_TEMPLATES), `${tool} 说好不造数据，却出现在模板里`);
  }
});

// ── ⑦ 训练数据的 system 必须是**生产那一份**（v5/v6 两次白跑就是栽在这里）─────────────
//
// 事实经过（§C6.282）：生成器第一版自己手写了一句短 system，而推理时发的是 `LOCAL_TOOL_SYSTEM`。
// 两边不一致 ⇒ 模型等于没学过：拿 v6 问它**自己的训练样本**，8/8 都答 `{"stop":true}`。
// 仓库本来就有 `PROMPT_DIGEST_PIN` 钉着那一份提示 —— 这一条把"训练数据必须用同一份"变成判据，
// 免得下次又靠两次 30 分钟的训练去发现。
test('⑦ 训练样本里的 system 必须与生产提示逐字相同（含 digest 钉）', () => {
  const samples = buildSamples();
  const digests = new Set(samples.map((row) => row.messages[0].content));
  assert.equal(digests.size, 1, '所有样本只许用同一份 system');
  assert.equal([...digests][0], LOCAL_TOOL_SYSTEM, 'system 必须是生产那一份 LOCAL_TOOL_SYSTEM');
  const digest = createHash('sha256').update(LOCAL_TOOL_SYSTEM, 'utf8').digest('hex');
  assert.equal(digest, PROMPT_DIGEST_PIN, 'system 的 sha256 必须等于钉住的那一个');
  const report = JSON.parse(read('reports/roco/sft-coverage/report.json'));
  assert.equal(report.system_prompt_digest_pin, PROMPT_DIGEST_PIN, '报告里要记下用的是哪一份提示');
});
