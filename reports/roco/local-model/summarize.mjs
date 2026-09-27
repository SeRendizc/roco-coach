// 把若干份 `ab-arms.mjs` 产物（轨迹 JSONL + ask 回执 JSONL）算成一张可复算的表。
//
// 一条纪律：**每个数字都从产物里的行算出来**，没有一处是手写的。
// 「合法率」的判据也写在这里（程序判定）：一次 ask 的原文能被 `extractFirstJson`
// 解析成对象，且（`stop:true` 或 工具名在 `TOOL_CONTRACTS` 里）。
// 「工具选择正确率」= 调用了任务期望的那个工具（`expect.tool`）；
// 「判据通过率」= 产品自己的 `checkTask` 那一套（含参数、上限、措辞）。
//
// 用法：
//   node reports/roco/local-model/summarize.mjs \
//     --arm sft-v4=/tmp/roco-4b/traj-sft-v4.jsonl \
//     --arm base=/tmp/roco-4b/traj-base.jsonl \
//     --arm cloud=/tmp/roco-4b/traj-cloud.jsonl \
//     --out /tmp/roco-4b/summary.json

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {TOOL_CONTRACTS} from '../../../src/coach/toolbox.js';
import {extractFirstJson} from '../../../scripts/roco/agent-trajectories.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const TASKS = join(ROOT, 'tests', 'evals', 'agent-tasks-v1.jsonl');

export const percentile = (values, p) => {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
export const mean = (values) => {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? Number((clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(2)) : null;
};

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line));

/** 一次 ask 的原文 → 它算不算「合法输出」。判据在跑之前钉死。 */
export function classifyAsk(row) {
  const out = {transport_ok: row.ok === true, json_object: false, legal: false,
    kind: null, tool: null, tool_registered: null};
  if (!out.transport_ok) { out.kind = 'transport-error'; return out; }
  const parsed = extractFirstJson(row.text ?? '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { out.kind = 'unparsed'; return out; }
  out.json_object = true;
  if (parsed.stop === true) { out.kind = 'stop'; out.legal = true; return out; }
  if (typeof parsed.tool !== 'string') { out.kind = 'no-tool-key'; return out; }
  out.tool = parsed.tool;
  out.tool_registered = Object.hasOwn(TOOL_CONTRACTS, parsed.tool);
  if (!out.tool_registered) { out.kind = 'unknown-tool'; return out; }
  out.kind = 'call';
  out.legal = true;
  return out;
}

export function armStats(rows, receipts) {
  const byArm = {};
  for (const row of rows) {
    const b = byArm[row.arm] || (byArm[row.arm] = {trajectories: 0, passed: 0, per_category: {},
      stopped: {}, engine_refused: 0, windows: new Set(), cases: new Set()});
    b.trajectories += 1;
    b.windows.add(`${row.case_id}@${row.input.world.id}`);
    b.cases.add(row.case_id);
    if (row.checks.passed) b.passed += 1;
    const cat = b.per_category[row.category] || (b.per_category[row.category] = {total: 0, passed: 0});
    cat.total += 1;
    if (row.checks.passed) cat.passed += 1;
    b.stopped[row.stopped] = (b.stopped[row.stopped] || 0) + 1;
    if (row.engine_refused) b.engine_refused += 1;
  }
  for (const b of Object.values(byArm)) {
    b.pass_rate = b.trajectories ? Number((b.passed / b.trajectories).toFixed(4)) : null;
    for (const cat of Object.values(b.per_category)) cat.pass_rate = cat.total ? Number((cat.passed / cat.total).toFixed(4)) : null;
    b.window_count = b.windows.size;
    b.case_count = b.cases.size;
    delete b.windows;
    delete b.cases;
  }
  const byAskArm = {};
  for (const row of receipts) {
    const b = byAskArm[row.arm] || (byAskArm[row.arm] = {asked: 0, legal: 0, transport_ok: 0, kinds: {},
      wall_ms: [], engine_total_ms: [], engine_first_token_ms: [], tokens_per_second: [],
      prompt_tokens: 0, completion_tokens: 0, usage_rows: 0, errors: {}});
    b.asked += 1;
    const verdict = classifyAsk(row);
    if (verdict.transport_ok) b.transport_ok += 1;
    if (verdict.legal) b.legal += 1;
    b.kinds[verdict.kind] = (b.kinds[verdict.kind] || 0) + 1;
    b.wall_ms.push(row.wall_ms);
    if (row.x_roco) {
      b.engine_total_ms.push(row.x_roco.total_ms);
      b.engine_first_token_ms.push(row.x_roco.first_token_ms);
      b.tokens_per_second.push(row.x_roco.tokens_per_second);
    }
    if (row.usage) {
      b.usage_rows += 1;
      b.prompt_tokens += row.usage.prompt_tokens || 0;
      b.completion_tokens += row.usage.completion_tokens || 0;
    }
    if (!row.ok) b.errors[row.error_code] = (b.errors[row.error_code] || 0) + 1;
  }
  for (const b of Object.values(byAskArm)) {
    b.legal_rate = b.asked ? Number((b.legal / b.asked).toFixed(4)) : null;
    b.transport_ok_rate = b.asked ? Number((b.transport_ok / b.asked).toFixed(4)) : null;
    b.latency = {
      wall_ms_mean: mean(b.wall_ms), wall_ms_p50: percentile(b.wall_ms, 50), wall_ms_p95: percentile(b.wall_ms, 95),
      wall_ms_max: Math.max(...b.wall_ms, 0),
      engine_total_ms_p50: percentile(b.engine_total_ms, 50), engine_total_ms_p95: percentile(b.engine_total_ms, 95),
      engine_first_token_ms_p50: percentile(b.engine_first_token_ms, 50),
      engine_first_token_ms_p95: percentile(b.engine_first_token_ms, 95),
      tokens_per_second_p50: percentile(b.tokens_per_second, 50),
    };
    b.cloud_usage = b.usage_rows ? {rows: b.usage_rows, prompt_tokens: b.prompt_tokens,
      completion_tokens: b.completion_tokens, total_tokens: b.prompt_tokens + b.completion_tokens} : null;
    b.wall_ms = undefined;
    b.engine_total_ms = undefined;
    b.engine_first_token_ms = undefined;
    b.tokens_per_second = undefined;
    b.prompt_tokens = undefined;
    b.completion_tokens = undefined;
    b.usage_rows = undefined;
  }
  return {byArm, byAskArm};
}

/** 任务集里写死的期望：用来算「工具选择正确率」（比 checkTask 窄，只问选没选对工具）。 */
export function expectationIndex() {
  const index = new Map();
  for (const line of readFileSync(TASKS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const task = JSON.parse(line);
    if (task.record_type !== 'agent_task') continue;
    index.set(task.case_id, task.expect || {});
  }
  return index;
}

export function toolChoice(rows, expectIndex) {
  const out = {};
  for (const row of rows) {
    const expect = expectIndex.get(row.case_id) || {};
    const called = row.trace.map((t) => t.tool);
    const b = out[row.arm] || (out[row.arm] = {windows: 0, expect_null: 0, correct: 0, wrong: 0,
      over_called: 0, under_called: 0, no_such_expectation: 0});
    b.windows += 1;
    if (!expect.tool) {
      // 期望是「不查」（tool: null）：正确 = 一次都没查。
      b.expect_null += 1;
      if (called.length === 0) b.correct += 1; else b.over_called += 1;
      continue;
    }
    if (called.includes(expect.tool)) b.correct += 1; else b.under_called += 1;
  }
  for (const b of Object.values(out)) {
    b.accuracy = b.windows ? Number((b.correct / b.windows).toFixed(4)) : null;
  }
  return out;
}

/** 两条臂逐窗口配对：谁对谁错。key = `case_id@world_id`。 */
export function pairArms(rowsA, rowsB, nameA, nameB) {
  const index = (rows) => {
    const map = new Map();
    for (const row of rows) map.set(`${row.case_id}@${row.input.world.id}`, row);
    return map;
  };
  const a = index(rowsA.filter((row) => row.arm === nameA));
  const b = index(rowsB.filter((row) => row.arm === nameB));
  const shared = [...a.keys()].filter((key) => b.has(key));
  const out = {compared_windows: shared.length, a: nameA, b: nameB,
    both_pass: 0, a_pass_b_fail: 0, a_fail_b_pass: 0, both_fail: 0,
    by_category: {}};
  for (const key of shared) {
    const ra = a.get(key); const rb = b.get(key);
    const pa = ra.checks.passed; const pb = rb.checks.passed;
    const bucket = out.by_category[ra.category] || (out.by_category[ra.category] =
      {windows: 0, both_pass: 0, a_pass_b_fail: 0, a_fail_b_pass: 0, both_fail: 0});
    bucket.windows += 1;
    if (pa && pb) { out.both_pass += 1; bucket.both_pass += 1; }
    else if (pa && !pb) { out.a_pass_b_fail += 1; bucket.a_pass_b_fail += 1; }
    else if (!pa && pb) { out.a_fail_b_pass += 1; bucket.a_fail_b_pass += 1; }
    else { out.both_fail += 1; bucket.both_fail += 1; }
  }
  return out;
}

function parseArgs(argv) {
  const arms = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arm') arms.push(String(argv[++i]));
    else if (argv[i] === '--out') out = String(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return {arms, out};
}

async function main() {
  const {arms, out} = parseArgs(process.argv.slice(2));
  const loaded = arms.map((spec) => {
    const [label, path] = spec.split('=');
    // 头部行（agent_trajectory_header）不是轨迹：它没有 input，混进来会让统计崩。
    const rows = readJsonl(path).filter((row) => row.record_type === 'agent_trajectory');
    const receiptPath = path.replace(/\.jsonl$/, '.receipts.jsonl');
    let receipts = [];
    try { receipts = readJsonl(receiptPath).filter((row) => row.record_type === 'ask_receipt'); } catch { receipts = []; }
    return {label, path, rows, receipts};
  });
  const expectIndex = expectationIndex();
  const report = {inputs: loaded.map((l) => ({label: l.label, path: l.path,
    trajectories: l.rows.length, receipts: l.receipts.length})), arms: {}, pairings: {}, tool_choice: {}};
  for (const item of loaded) {
    report.arms[item.label] = armStats(item.rows, item.receipts);
    report.tool_choice[item.label] = toolChoice(item.rows, expectIndex);
  }
  // 配对：同一 label 内部（rule vs model）与跨 label（model vs model）都做。
  const all = loaded;
  for (const a of all) {
    for (const b of all) {
      if (a.label === b.label) continue;
      const labelsA = [...new Set(a.rows.map((r) => r.arm))];
      const labelsB = [...new Set(b.rows.map((r) => r.arm))];
      for (const nameA of labelsA) for (const nameB of labelsB) {
        const paired = pairArms(a.rows, b.rows, nameA, nameB);
        if (paired.compared_windows) report.pairings[`${a.label}:${nameA} vs ${b.label}:${nameB}`] = paired;
      }
    }
    // 同 label 内：规则 baseline vs 模型臂
    const labels = [...new Set(a.rows.map((r) => r.arm))];
    for (const nameA of labels) for (const nameB of labels) {
      if (nameA === nameB) continue;
      const paired = pairArms(a.rows, a.rows, nameA, nameB);
      if (paired.compared_windows) report.pairings[`${a.label}:${nameA} vs ${a.label}:${nameB}`] = paired;
    }
  }
  const target = out || join('/tmp', 'roco-4b', 'summary.json');
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({written_to: target,
    arms: Object.fromEntries(Object.entries(report.arms).map(([k, v]) => [k, {
      trajectory_pass_rate: Object.fromEntries(Object.entries(v.byArm).map(([a, s]) => [a, s.pass_rate])),
      ask_legal_rate: Object.fromEntries(Object.entries(v.byAskArm).map(([a, s]) => [a, s.legal_rate])),
      ask_counts: Object.fromEntries(Object.entries(v.byAskArm).map(([a, s]) => [a, s.asked])),
    }]))}, null, 1)}\n`);
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  main().catch((error) => { process.stderr.write(`[summarize] 失败：${error?.stack || error}\n`); process.exit(1); });
}
