// 把本轮实测的**全部头条数字**从产物里算出来，落成 `verdict.json`。
//
// 为什么不让数字手写在文档里：手写的数字没有来源，改一次代码就悄悄过期。
// 这份脚本只读 `/tmp/roco-4b/**` 的原始产物 + `reports/roco/sft/dataset-report.json`，
// 每个数都从行算出来；`REPORT.md` 与 `docs/roco/*` 里的表格引用它。
//
// 用法（先跑完 ab-arms / ab-short-explain / ab-fail-closed）：
//   node reports/roco/local-model/build-verdict.mjs

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {armStats, pairArms, toolChoice} from './summarize.mjs';
import {worldSubsetCheck} from './leakage.mjs';
import {loadTasks} from '../../../scripts/roco/build-agent-trajectories.mjs';
import {sftSideOf} from '../../../scripts/roco/build-agent-sft-data.mjs';
import {TOOL_CONTRACTS} from '../../../src/coach/toolbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const TMP = process.env.ROCO_4B_OUT || '/tmp/roco-4b';

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const trajectories = (path) => readJsonl(path).filter((row) => row.record_type === 'agent_trajectory');
const receipts = (path) => {
  const target = path.replace(/\.jsonl$/, '.receipts.jsonl');
  if (!existsSync(target)) return [];
  return readJsonl(target).filter((row) => row.record_type === 'ask_receipt');
};

const FILES = {
  'sft-v4': join(TMP, 'traj-sft-v4.jsonl'),
  base: join(TMP, 'traj-base.jsonl'),
  cloud: join(TMP, 'traj-cloud.jsonl'),
  'clean-latency': join(TMP, 'traj-clean-latency.jsonl'),
};

/** 期望索引：只用来算「选没选对工具」这个窄口径。 */
function expectationIndex() {
  const index = new Map();
  for (const line of readFileSync(join(ROOT, 'tests', 'evals', 'agent-tasks-v1.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const task = JSON.parse(line);
    if (task.record_type === 'agent_task') index.set(task.case_id, task.expect || {});
  }
  return index;
}

const tasks = loadTasks();
const expectIndex = expectationIndex();
const sideOf = new Map(tasks.map((task) => [task.case_id, sftSideOf(task)]));
const verdict = {
  schema: 'roco-local-model-verdict/v1',
  generated_by: 'reports/roco/local-model/build-verdict.mjs',
  note: '每个数字都由 /tmp/roco-4b/** 的原始产物算出，没有一个是手写的；'
    + '「合法率」是程序判定（可解析成 JSON 对象 + 工具名已注册），不是质量结论。',
  inputs: {},
  arms: {},
  pairings: {},
  tool_choice: {},
  sft_leakage: {subset_check: worldSubsetCheck(tasks).subset_holds,
    tasks_with_worlds_outside_sft: worldSubsetCheck(tasks).tasks_with_worlds_outside_sft,
    side_of_tasks: Object.fromEntries(['train', 'val', 'test'].map((side) =>
      [side, [...sideOf.values()].filter((s) => s === side).length]))},
  by_sft_side: {},
};

const loaded = {};
for (const [label, path] of Object.entries(FILES)) {
  if (!existsSync(path)) continue;
  const rows = trajectories(path);
  const askRows = receipts(path);
  loaded[label] = {rows, askRows};
  verdict.inputs[label] = {path, trajectories: rows.length, ask_receipts: askRows.length,
    sha256_source: null};
  verdict.arms[label] = armStats(rows, askRows);
  verdict.tool_choice[label] = toolChoice(rows, expectIndex);
  const bySide = {};
  for (const row of rows) {
    const side = sideOf.get(row.case_id) ?? 'unknown';
    const bucket = (bySide[row.arm] ??= {})[side] ??= {windows: 0, passed: 0};
    bucket.windows += 1;
    if (row.checks.passed) bucket.passed += 1;
  }
  for (const arms of Object.values(bySide)) {
    for (const bucket of Object.values(arms)) bucket.pass_rate = Number((bucket.passed / bucket.windows).toFixed(4));
  }
  verdict.by_sft_side[label] = bySide;
}

/** 三条臂两两配对（用同一批窗口）。 */
const pair = (labelA, armA, labelB, armB) => {
  if (!loaded[labelA] || !loaded[labelB]) return null;
  return pairArms(loaded[labelA].rows, loaded[labelB].rows, armA, armB);
};
verdict.pairings = {
  'rule_vs_sft-v4@864': pair('sft-v4', 'baseline', 'sft-v4', 'local_4b'),
  'rule_vs_base@432': pair('base', 'local_base', 'cloud', 'baseline'),
  'rule_vs_cloud@432': pair('cloud', 'baseline', 'cloud', 'cloud_deepseek'),
  'sft-v4_vs_base@432': pair('sft-v4', 'local_4b', 'base', 'local_base'),
  'sft-v4_vs_cloud@432': pair('sft-v4', 'local_4b', 'cloud', 'cloud_deepseek'),
  'base_vs_cloud@432': pair('base', 'local_base', 'cloud', 'cloud_deepseek'),
};

/** 云端成本：真回执里的 usage（含缓存命中/未命中分开算）。 */
const cloudUsage = {rows: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit: 0, cache_miss: 0};
for (const {askRows} of Object.values(loaded)) {
  for (const row of askRows) {
    if (row.arm !== 'cloud_deepseek' || !row.usage) continue;
    cloudUsage.rows += 1;
    cloudUsage.prompt_tokens += row.usage.prompt_tokens || 0;
    cloudUsage.completion_tokens += row.usage.completion_tokens || 0;
    cloudUsage.cache_hit += row.usage.prompt_cache_hit_tokens || 0;
    cloudUsage.cache_miss += row.usage.prompt_cache_miss_tokens || 0;
  }
}
// 价格表来源：`scripts/eval-live-s04.js` 里已固化的公开价（USD / 1M tokens），照抄不算编。
const PRICES = {inputCacheMissOffPeak: 0.15, inputCacheMissPeak: 0.3,
  inputCacheHitOffPeak: 0.003, inputCacheHitPeak: 0.006, outputOffPeak: 0.6, outputPeak: 1.2};
const usd = (band) => Number(((cloudUsage.cache_miss / 1e6) * PRICES[`inputCacheMiss${band}`]
  + (cloudUsage.cache_hit / 1e6) * PRICES[`inputCacheHit${band}`]
  + (cloudUsage.completion_tokens / 1e6) * PRICES[`output${band}`]).toFixed(5));
verdict.cloud_cost = {
  ...cloudUsage,
  price_source: 'scripts/eval-live-s04.js（已固化的公开价，read 2026-09-17，USD/1M tokens）',
  usd_off_peak: usd('OffPeak'), usd_peak: usd('Peak'),
  note: '本地 4B 这一侧没有 API token 费用；它的成本是常驻统一内存与延迟（见 arms.*.byAskArm.*.latency）',
};

/** 短解释臂：产品自己会不会把这段正文扔掉。 */
const shortPath = join(TMP, 'short-explain-clean.jsonl');
if (existsSync(shortPath)) {
  const rows = readJsonl(shortPath);
  const byArm = {};
  for (const row of rows) {
    const b = byArm[row.arm] ??= {rows: 0, j1j4_passed: 0, production_rejected: 0,
      rejected_reasons: {}, raw_chars: [], wall_ms: []};
    b.rows += 1;
    if (row.judge.passed) b.j1j4_passed += 1;
    if (row.arm !== 'rule_template') {
      if (row.judge.production?.rejected) b.production_rejected += 1;
      const reason = row.judge.production?.rejected_reason;
      if (reason) b.rejected_reasons[reason] = (b.rejected_reasons[reason] || 0) + 1;
    }
    b.raw_chars.push(row.judge.raw_chars);
    b.wall_ms.push(row.wall_ms);
  }
  for (const b of Object.values(byArm)) {
    b.production_rejection_rate = b.rows ? Number((b.production_rejected / b.rows).toFixed(4)) : null;
    b.raw_chars_max = Math.max(...b.raw_chars, 0);
    b.raw_chars_mean = Number((b.raw_chars.reduce((a, c) => a + c, 0) / b.raw_chars.length).toFixed(1));
    b.wall_ms_mean = Number((b.wall_ms.reduce((a, c) => a + c, 0) / b.wall_ms.length).toFixed(1));
  }
  verdict.short_explain = {cases: new Set(rows.map((r) => r.case_id)).size, by_arm: byArm,
    prompt_source: 'src/coach/runtime.js 的 runCoach + localProvider：packet.text，即产品在 on 档真正喂给本地模型的提示'};
}

/** fail-closed / 局内预算。 */
const fcPath = join(TMP, 'fail-closed.json');
if (existsSync(fcPath)) verdict.fail_closed = JSON.parse(readFileSync(fcPath, 'utf8')).sections;
const toolsControl = join(TMP, 'plan-tools-control.json');
if (existsSync(toolsControl)) {
  verdict.plan_prompt_control = JSON.parse(readFileSync(toolsControl, 'utf8'));
}

verdict.tool_contract_count = Object.keys(TOOL_CONTRACTS).length;
const out = join(HERE, 'verdict.json');
writeFileSync(out, `${JSON.stringify(verdict, null, 1)}\n`);
process.stdout.write(`${JSON.stringify({written_to: out,
  arms: Object.fromEntries(Object.entries(verdict.arms).map(([label, value]) => [label,
    {pass: Object.fromEntries(Object.entries(value.byArm).map(([a, s]) => [a, `${s.passed}/${s.trajectories}`])),
      legal: Object.fromEntries(Object.entries(value.byAskArm).map(([a, s]) => [a, `${s.legal}/${s.asked}`]))}]))}, null, 1)}\n`);
