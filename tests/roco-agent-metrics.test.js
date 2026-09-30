// 两栏计量 + 延迟分段的守卫（人类点名：「评测按「问模型几次 / 问引擎几次 / 检索什么」标注」）。
//
// 为什么这一组必须存在
// --------------------
// 这一层最容易变成"看起来很专业的数字墙"，四种坏法都不会红：
//   ① 拿不到就填 0（"分段延迟"其实产物里根本没有）—— 于是 0 被读成"很快"；
//   ② 同输入两次跑出不同结果（产物里混进挂钟）—— 数字不可复算，等于没有；
//   ③ 只报对自己有利的那一栏（只报模型调用、不报引擎调用）；
//   ④ **反证臂其实不红**：`stop_now` / `no_rules` 这些臂如果也全过，说明判据是装饰品 ——
//      那样"通过率上升"就永远只能说明代码变了，不能说明能力变了。
// 下面五组判据（含三条反证）就是钉这四件事。
//
// 用法：`node --test tests/roco-agent-metrics.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {OUT_PATH, latencySummary, percentile, caseRow, collect} from '../scripts/roco/agent-metrics.mjs';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-24）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, 'utf8'));
const strip = (report) => JSON.stringify({...report, generated_at: null});

const report = collect();

test('五组结构都在，且两栏与延迟都来自产物', () => {
  assert.equal(report.schema, 'roco-agent-metrics/v1');
  for (const key of ['two_column', 'latency', 'model_arm', 'sources', 'limitations']) {
    assert.ok(key in report, `报告必须有 ${key}`);
  }
  assert.ok(report.two_column.cases.length > 0, '两栏明细不能是空的');
  for (const row of report.two_column.cases) {
    for (const field of ['id', 'model_calls', 'engine_calls', 'retrieved_ids', 'latency_ms']) {
      assert.ok(field in row, `每例必须有 ${field}`);
    }
    assert.ok(Array.isArray(row.retrieved_ids), '检索那一栏必须是数组（可以是空数组）');
  }
});

test('① 拿不到的**写 null 不写 0**：分段延迟与"金标声明的模型次数"都是 null + 原因', () => {
  assert.equal(report.latency.segments, null, '分段延迟在产品里拿不到，必须是 null');
  assert.match(String(report.latency.segments_reason), /per-phase latency is not separable|没有云端报告/,
    'null 必须带得出原因，否则读者会以为"分段延迟是 0"');
  for (const row of report.two_column.cases) {
    assert.equal(row.declared_model_calls, null, '金标还没补"问模型几次"这一栏 ⇒ 必须是 null，不许编');
  }
  // 反证：空数组的延迟摘要**全 null**，不是全 0
  assert.deepEqual(latencySummary([]), {n: 0, p50: null, p90: null, p95: null, max: null, mean: null});
  assert.equal(percentile([], 0.5), null);
});

test('② 可复算：同输入两次逐字节相同；正文除 generated_at 外没有挂钟', () => {
  assert.equal(strip(report), strip(collect()), '两次 collect 必须逐字节相同（除 generated_at）');
  const body = strip(report);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body), '除 generated_at 外不许有挂钟时间戳');
  assert.equal(report.determinism.only_nondeterministic_field, 'generated_at');
});

test('③ 产物与「现在重算」一致（先跑脚本再断言）', () => {
  const abs = `${ROOT}${OUT_PATH}`;
  assert.ok(existsSync(abs), `产物必须存在：${OUT_PATH}`);
  assert.equal(strip(JSON.parse(readFileSync(abs, 'utf8'))), strip(report),
    `磁盘产物与重算不一致：先跑 node scripts/roco/agent-metrics.mjs`);
});

test('④ 两栏的算法是钉死的：模型那一栏含 1 次生成，本地锁定路径记 0', () => {
  const cloud = caseRow({id: 'x', provider: 'deepseek', plannerCalls: 2, calls: 1, toolTrace: [{tool: 'query_rules'}]});
  assert.equal(cloud.model_calls, 3, '云端：1 次生成 + 2 次规划 = 3');
  assert.equal(cloud.engine_calls, 1);
  const local = caseRow({id: 'y', provider: 'local', plannerCalls: null, calls: 0, toolTrace: []});
  assert.equal(local.model_calls, 0, '本地锁定路径不进模型 ⇒ 0（不是 null、也不是 1）');
  const unknown = caseRow({id: 'z', provider: 'deepseek', plannerCalls: undefined, calls: 0, toolTrace: []});
  assert.equal(unknown.model_calls, null, '规划器次数未知时写 null（fail closed），不许当成 0');
  // 检索那一栏把 knowledgeIds 与回执里的 id 合起来去重
  const withKnowledge = caseRow({id: 'k', provider: 'local', calls: 1, knowledgeIds: ['tactic:x'],
    toolTrace: [{tool: 'query_rules', result: {id: 'pet::pet_000001'}}]});
  assert.deepEqual(withKnowledge.retrieved_ids, ['pet::pet_000001', 'tactic:x'], '检索栏必须合并去重并排序');
});

test('⑤ 反证臂必须**真的红**，而且**红在它该红的那一类**（数据驱动，不抄通过率）', () => {
  const manifest = readJson('tests/evals/agent-trajectories-v1.manifest.json');
  const arms = manifest.header.arms_summary;
  assert.equal(arms.replay.pass_rate, 1, 'replay 臂是基线，必须全过（它要是掉了就是真回归）');
  for (const arm of ['stop_now', 'stubborn', 'no_rules']) {
    assert.ok(arms[arm].pass_rate < 1,
      `${arm} 臂必须**不是**全过（它存在就是为了证明判据会红），实际 ${arms[arm].pass_rate}`);
  }
  // 原来这里写的是 `assert.equal(arms.no_rules.pass_rate, 0.75)` —— 把产物里的数字抄进判据：
  // fixture 合法地加几条用例，这个数就变，最省事的"修法"就是再抄一次新数字，判据的牙全掉。
  // 现在改成**数据驱动**：每个反证臂「坏在哪一类」才是它的定义，逐类目对比。
  // 该红的类目全过（=判据被短路，比如 must_not_fabricate 被跳过）或不该红的类目也挂
  // （=判据在乱杀）都必须翻红。
  const signature = {
    no_rules: ['rules_lookup'],
    stop_now: ['rules_lookup', 'roster_constraint'],
    stubborn: ['stale_state', 'tool_failure'],
  };
  for (const [arm, expected] of Object.entries(signature)) {
    const summary = arms[arm];
    const failing = Object.entries(summary.per_category).filter(([, v]) => v.passed < v.total)
      .map(([name]) => name).sort();
    assert.deepEqual(failing, [...expected].sort(),
      `${arm} 臂的失败类目必须正好是「${expected.join('、')}」，实际「${failing.join('、')}」`);
    // 通过率不许与类目明细脱节（header 里的数字必须能从明细复算出来）
    const total = Object.values(summary.per_category).reduce((n, v) => n + v.total, 0);
    const passed = Object.values(summary.per_category).reduce((n, v) => n + v.passed, 0);
    assert.equal(summary.total, total, `${arm}: total 与类目明细不一致`);
    assert.equal(summary.passed, passed, `${arm}: passed 与类目明细不一致`);
    assert.equal(summary.pass_rate, Math.round(passed / total * 1e4) / 1e4,
      `${arm}: pass_rate 必须能从 passed/total 复算`);
    assert.ok(summary.pass_rate > 0 && summary.pass_rate < 1,
      `${arm} 既不能全过（判据没牙）也不能全红（判据在乱杀），实际 ${summary.pass_rate}`);
  }
});

test('⑥ 源产物读不到时**如实说读不到**，不静默变空报告', () => {
  const empty = mkdtempSync(join(tmpdir(), 'roco-metrics-'));
  const missing = collect({root: empty});
  assert.equal(missing.two_column.cases.length, 0);
  assert.equal(missing.two_column.totals.model_calls_sum, null, '没有源数据 ⇒ 合计是 null，不是 0');
  assert.equal(missing.latency.end_to_end_ms.n, 0);
  assert.ok(missing.limitations.some((line) => line.includes('读不到')),
    `必须在 limitations 里如实写明读不到：${JSON.stringify(missing.limitations)}`);
});
