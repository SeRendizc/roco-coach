#!/usr/bin/env node
// **两栏计量 + 延迟分段**（人类点名）：
//   「评测按「**问模型几次 / 问引擎几次 / 检索什么**」标注」（HUMAN-RULINGS-2026-09-25 §4 第 5 条）
//
// 为什么需要它：在它之前，「3 秒」**没有任何端到端数字**（`docs/roadmap/MODEL-ROUTING-PLAN.md:172`
// 自己写着 3.1 的实测"完全不含 LLM"），而"该不该问模型/该不该问引擎"的争论一直缺一个可复算的计数面。
//
// 它**只读**两个既有产物，不调模型、不联网、不写别的文件：
//   · `reports/live-model-eval.json`  —— 49 例真机（云端）跑出来的逐例回执（两栏 + 延迟 + 检索面）
//   · `tests/evals/agent-trajectories-model-v1.jsonl` —— 本地 4B 模型臂的确定性回放（逐例工具轨迹）
//
// 跑法::
//
//     node scripts/roco/agent-metrics.mjs            # 算并写 reports/roco/agent-metrics.json
//     node scripts/roco/agent-metrics.mjs --check    # 只算不写；与磁盘不一致退出码 1
//     node scripts/roco/agent-metrics.mjs --json
//
// **纪律**：数字只来自产物；**拿不到的写 `null` + 原因**（fail closed，不编）。
// 典型拿不到的：**分段延迟** —— 云端那次的报告自己写明"per-phase latency is not separable from outside the server"，
// 所以这里 `latency.segments` 一律 `null` + reason，而不是编一个"planner 占 30%"。

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
export const OUT_PATH = 'reports/roco/agent-metrics.json';
export const LIVE_PATH = 'reports/live-model-eval.json';
export const MODEL_TRAJ_PATH = 'tests/evals/agent-trajectories-model-v1.jsonl';

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const readJsonl = (rel) => readFileSync(join(ROOT, rel), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** 分位数（线性插值，与 `eval-live-s04.js` 的口径一致：索引四舍五入）。 */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/** 一列数字的延迟摘要。**空数组 ⇒ 全 null**（不是 0）。 */
export function latencySummary(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return {n: 0, p50: null, p90: null, p95: null, max: null, mean: null};
  return {
    n: nums.length,
    p50: percentile(nums, 0.5), p90: percentile(nums, 0.9), p95: percentile(nums, 0.95),
    max: nums[nums.length - 1],
    mean: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length),
  };
}

/** 一例的**两栏**：问模型几次 / 问引擎几次 / 检索到什么。 */
export function caseRow(row) {
  // 问模型几次 = 1 次生成 + 规划器调用次数；**本地锁定路径（provider=local）0 次**（不进模型）。
  // ⚠️ 2026-09-25 对抗复核修（D2）：`plannerCalls` 是评测脚本**重建**出来的（`plannerCallCount = trace.length+1`），
  // 它假设"每次都至少问规划器一次"；但 `policy-no-tool` / `policy-route-without-tools` 这两类
  // **根本没调 `provider.plan`**（`runtime.js` 的政策硬门控），29/49 行属于这两类 —— 旧口径把 model_calls 记成 2。
  const POLICY_WITHOUT_PLANNER = new Set(['policy-no-tool', 'policy-route-without-tools']);
  const plannerCalls = POLICY_WITHOUT_PLANNER.has(row.agentStop)
    ? 0
    : (Number.isFinite(row.plannerCalls) ? row.plannerCalls : null);
  const modelCalls = row.provider === 'local'
    ? 0                                                   // 本地模板路径**不进模型**（与改前口径一致）
    : (plannerCalls === null ? null : plannerCalls + 1);
  const trace = Array.isArray(row.toolTrace) ? row.toolTrace : [];
  const retrieved = [...new Set([
    ...(Array.isArray(row.knowledgeIds) ? row.knowledgeIds : []),
    ...trace.map((t) => t?.result?.id).filter(Boolean),
  ])].sort();
  return {
    id: row.id,
    category: row.cat ?? null,
    question: row.question ?? null,
    // ── 两栏（实际）──
    model_calls: modelCalls,
    engine_calls: Number.isFinite(row.calls) ? row.calls : trace.length,
    engine_tools: trace.map((t) => t?.tool).filter(Boolean),
    retrieved_ids: retrieved,
    // ── 期望（金标）：**引擎那一栏有**，模型那一栏还没有（等人类重做金标时补三标签）──
    declared_engine_calls_min: Array.isArray(row.expect?.calls) ? row.expect.calls[0] : null,
    declared_model_calls: null,
    // ── 质量/延迟 ──
    latency_ms: Number.isFinite(row.latencyMs) ? row.latencyMs : null,
    grounded: row.validation ? row.validation.valid === true : null,
    stopped: row.agentStop ?? null,
    gold_revision: row.goldRevision ?? null,
    unreviewed: row.goldUnreviewed !== false,
  };
}

/** 本地模型臂（确定性回放）：逐例的引擎调用与停止原因。 */
export function modelArmRows(rows) {
  return rows.filter((r) => r.record_type === 'agent_trajectory').map((r) => ({
    case_id: r.case_id,
    arm: r.arm,
    engine_calls: Array.isArray(r.trace) ? r.trace.length : 0,
    engine_tools: (r.trace ?? []).map((t) => t.tool),
    stopped: r.stopped ?? null,
    checks_passed: r.checks?.passed === true,
  }));
}

export function collect({root = ROOT} = {}) {
  const livePath = join(root, LIVE_PATH);
  const trajPath = join(root, MODEL_TRAJ_PATH);
  const notes = [];
  const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : null;
  if (!live) notes.push(`读不到 ${LIVE_PATH}：两栏计量里的"云端 49 例"这一块会是空的（**没跑过就如实说没跑**）`);
  const liveRows = (live?.rows ?? []).map(caseRow);
  const traj = existsSync(trajPath) ? readJsonl(MODEL_TRAJ_PATH) : [];
  if (!traj.length) notes.push(`读不到 ${MODEL_TRAJ_PATH}：本地模型臂这一块会是空的`);

  const armRows = modelArmRows(traj);
  const reviewed = liveRows.filter((r) => !r.unreviewed);
  const latency = {
    end_to_end_ms: latencySummary(liveRows.map((r) => r.latency_ms)),
    // 分段延迟：**产物里没有**，所以写 null + 原因（不编）。
    segments: null,
    segments_reason: live
      ? '云端那次的报告自己写明：Latency is end-to-end per case (planner + generation + local work); '
        + 'per-phase latency is not separable from outside the server.'
      : '没有云端报告，连端到端数字都没有。',
    reviewed_only_ms: reviewed.length ? latencySummary(reviewed.map((r) => r.latency_ms)) : null,
  };
  const modelCalls = liveRows.map((r) => r.model_calls).filter((v) => Number.isFinite(v));
  const engineCalls = liveRows.map((r) => r.engine_calls).filter((v) => Number.isFinite(v));
  const report = {
    schema: 'roco-agent-metrics/v1',
    generated_by: 'scripts/roco/agent-metrics.mjs',
    generated_at: new Date().toISOString(),
    scope: '两栏计量（问模型几次 / 问引擎几次 / 检索什么）+ 延迟分段。只读既有产物，不调模型、不联网。',
    sources: {
      live_model_eval: existsSync(livePath) ? {
        path: LIVE_PATH,
        sha256: createHash('sha256').update(readFileSync(livePath)).digest('hex'),
        cases: liveRows.length,
        model: live?.model ?? null,
        capability_conclusive: live?.capabilityConclusive ?? null,
        // 2026-09-25：这一份源产物是**恢复**来的（被一次误跑覆盖），照实带出来 —— 数字要带着出处走。
        restored: live?.restored ? {rows_from: live.restored.rows_from,
          metrics_authoritative: live.restored.metrics_authoritative, why: live.restored.why} : null,
        gold_review: live?.goldReview ? {approved: live.goldReview.approved, total: live.goldReview.total} : null,
      } : null,
      model_arm_trajectories: existsSync(trajPath) ? {
        path: MODEL_TRAJ_PATH,
        sha256: createHash('sha256').update(readFileSync(trajPath)).digest('hex'),
        rows: armRows.length,
      } : null,
    },
    two_column: {
      note: '`model_calls` = 1 次生成 + 规划器调用次数；本地锁定路径（provider=local）记 0。'
        + '⚠️ **规划器次数是"重建出来的估计值"**：`reports/live-model-eval.json` 的 `plannerCalls` 由评测脚本按 trace '
        + '反推（它自己写着 "planner-call tokens are reconstructed from the known planner prompt"），'
        + '**不是**服务端逐次上报的计数 ⇒ 这一栏是"上界式的估计"，要精确计数得让服务端把每次 planner 调用记进回执。'
        + '⚠️ 已按对抗复核（2026-09-25）扣掉两类**根本没调规划器**的路径：`policy-no-tool` / `policy-route-without-tools`（政策硬门控）。'
        + '`declared_model_calls` 现在一律 null —— 人类口径要求每题按"问模型几次/问引擎几次/检索什么"补三个标签，'
        + '那是**金标重做**的一部分（未审阅前不许当结论）。',
      totals: {
        cases: liveRows.length,
        model_calls_sum: modelCalls.length ? modelCalls.reduce((a, b) => a + b, 0) : null,
        engine_calls_sum: engineCalls.length ? engineCalls.reduce((a, b) => a + b, 0) : null,
        cases_with_retrieval: liveRows.filter((r) => r.retrieved_ids.length).length,
      },
      cases: liveRows,
    },
    latency,
    model_arm: {
      note: '本地 4B 模型臂的**确定性回放**（`--arms local_4b` 录的那一份）。它不含延迟（回放不是真跑），只给调用面。',
      cases: armRows.length,
      engine_calls: latencySummary(armRows.map((r) => r.engine_calls)),
      stopped_distribution: armRows.reduce((acc, r) => ({...acc, [r.stopped ?? 'none']: (acc[r.stopped ?? 'none'] ?? 0) + 1}), {}),
      checks_passed: armRows.filter((r) => r.checks_passed).length,
      rows: armRows,
    },
    // 反证臂必须**真的红**：把判据短路，这几族的通过率会升上去。
    arms: live ? null : null,
    determinism: {
      note: '同输入两次跑，除 generated_at 外逐字节相同；正文里除 generated_at 不许有挂钟时间戳。',
      only_nondeterministic_field: 'generated_at',
    },
    limitations: [
      '**分段延迟拿不到**：产物里只有端到端每例延迟（见 latency.segments_reason）。要分段就得让服务端把 planner/生成/引擎三段分开记。',
      '`declared_model_calls` 全为 null：金标还没按人类口径补"问模型几次"这一栏（那是人类重做金标的一部分）。',
      '**模型调用次数是重建估计**，不是服务端上报（见 two_column.note 的 ⚠️）；引擎调用与检索面是回执里的真实记录。',
      '本地模型臂的 `engine_calls` 来自回放轨迹，不是真跑；它证明的是"录下来的那一次调了几次"。',
      ...(live?.restored ? ['⚠️ 源产物 `reports/live-model-eval.json` 是**恢复**来的：'
        + String(live.restored.why) + ' rows 取自 ' + String(live.restored.rows_from)
        + '（' + String(live.restored.differences_known) + '）'] : []),
      ...notes,
    ],
  };
  return report;
}

function main(argv) {
  const report = collect();
  const body = `${JSON.stringify(report, null, 1)}\n`;
  const abs = join(ROOT, OUT_PATH);
  if (argv.includes('--check')) {
    if (!existsSync(abs)) {
      process.stdout.write(`✖ 产物不存在：${OUT_PATH}（先跑 node scripts/roco/agent-metrics.mjs）\n`);
      return 1;
    }
    const onDisk = JSON.parse(readFileSync(abs, 'utf8'));
    const strip = (r) => JSON.stringify({...r, generated_at: null});
    if (strip(onDisk) !== strip(report)) {
      process.stdout.write(`✖ ${OUT_PATH} 与现在重算不一致：先跑 node scripts/roco/agent-metrics.mjs\n`);
      return 1;
    }
    process.stdout.write(`✔ ${OUT_PATH} 与现在重算一致\n`);
    return 0;
  }
  if (argv.includes('--json')) process.stdout.write(body);
  else {
    const l = report.latency.end_to_end_ms;
    process.stdout.write(`49 例：模型调用合计 ${report.two_column.totals.model_calls_sum}、引擎调用合计 `
      + `${report.two_column.totals.engine_calls_sum}、有检索的 ${report.two_column.totals.cases_with_retrieval} 例\n`);
    process.stdout.write(`端到端延迟 n=${l.n} p50=${l.p50} p90=${l.p90} p95=${l.p95} max=${l.max}`
      + `（**p95 ≤ 3000 是训练/上线门槛**）\n`);
    process.stdout.write(`分段延迟：${report.latency.segments === null ? 'null（产物里没有，未编）' : '有'}\n`);
  }
  mkdirSync(join(ROOT, dirname(OUT_PATH)), {recursive: true});
  writeFileSync(abs, body);
  if (!argv.includes('--json')) process.stdout.write(`产物写入 ${OUT_PATH}\n`);
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
void readJson;
