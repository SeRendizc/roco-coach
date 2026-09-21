#!/usr/bin/env node
// RC-303 的**延迟证据**：在真实 owned 数据上量三段（召回 / Beam / 排序）的 P50/P95，
// 与 13 号设计文档 §5.2 的预算逐项对照。**超预算就如实报**，不许调参迎合。
//
// 量什么（每段都指向命令与产物，不写估计值）：
//   ① `recall`  —— `recallCandidates()`；
//   ② `beam`    —— `beamComplete()`；
//   ③ `score`   —— `scoreTeams()`（ranker 不存在时就是规则打分，这一点也记下来）；
//   ④ `first_screen` —— 召回 + Beam + 排序 + 渐进推荐四段的和（「首屏短结论」的工程近似）；
//   ⑤ `progressive` —— `progressiveNext()`（§6 的下一只推荐，单列，不计入首屏三段）。
//
// 预算（13 号文档 §5.2 的表）：
//   状态与版本读取 50ms / 600+ 候选过滤召回 150ms / Beam + Ranker 300ms /
//   证据与反事实替换 300ms / 首屏短结论 800ms 内 / LLM 自然语言总计 3s 内
//
// 输入与输出
// ----------
//   node scripts/roco/measure-team-candidates.mjs            # 生成报告
//   node scripts/roco/measure-team-candidates.mjs --json     # 只打印 JSON
//   node scripts/roco/measure-team-candidates.mjs --runs=50  # 改每个样例的重复次数
// 产物：
//   reports/roco/team-candidates/latency.json
//   reports/roco/flagship-upgrade/rc-303-team-candidates.json（把实测合并进去，可复跑）
//
// 纪律：
//   · 计时用 `process.hrtime.bigint()`（单调时钟），不用 `Date.now()`；
//   · 索引构建（`buildCandidateIndex`）**不计入**任何一段：它是「状态与版本读取」那一格的事，
//     这里单列为 `index_build_ms`，免得把一次性成本藏进召回；
//   · 报告里的 `generated_at` 来自系统时钟，只用于人工核对「这份报告是什么时候跑的」，
//     不参与任何预算判定。

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus, platform, release, arch} from 'node:os';

import {
  DEFAULT_BEAM_BUDGETS, LATENCY_BUDGET_MS, RC303_REPORT_PATH, RECALL_MAX, RECALL_MIN, REPORT_BEAM_WIDTH,
  beamComplete, buildCandidateIndex, buildRc303Report, buildTeamCandidatePlan, onlineSectionOf,
  progressiveNext, recallCandidates, scanForbiddenPatterns, scoreTeams,
} from '../../src/coach/team-candidates.mjs';
import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, loadRecommendationInputs, validateRecommendationRequest,
} from '../../src/coach/team-request.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'team-candidates');
const OUT = join(OUT_DIR, 'latency.json');
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(3, Number(runsArg.split('=')[1]) || 20) : 20;

const nowIso = () => new Date().toISOString();
const ms = (startNs) => Number(process.hrtime.bigint() - startNs) / 1e6;
/** 最近秩百分位（与 reports/roco/adapter-load 的口径一致：floor(q * n) 取上界）。 */
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const round3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min_ms: round3(sorted[0] ?? null),
    p50_ms: round3(pct(sorted, 0.5)),
    p95_ms: round3(pct(sorted, 0.95)),
    max_ms: round3(sorted.at(-1) ?? null),
    mean_ms: sorted.length ? round3(sum / sorted.length) : null,
  };
};

// ── 真实数据 ────────────────────────────────────────────────────────────────

const inputs = await import('../../src/coach/team-candidates.mjs').then((m) => m.loadTeamCandidatesInputs({root: ROOT}));
const rc301Inputs = await loadRecommendationInputs({root: ROOT});
const ids = [...inputs.owned.instances].map((i) => i.instance_id).sort();
const favouriteIds = [...inputs.owned.instances].filter((i) => i.favourite === true)
  .map((i) => i.instance_id).sort();
const catalogSpeciesIds = [...new Set(inputs.pack?.sections
  ? Object.values(inputs.pack.sections).flatMap((s) => (s.entities ?? []))
    .filter((e) => String(e.record_kind ?? '').startsWith('pet')).map((e) => e.id)
  : [])].sort();

const indexBuildSamples = [];
let index = null;
for (let i = 0; i < 3; i += 1) {
  const started = process.hrtime.bigint();
  index = buildCandidateIndex(inputs);
  indexBuildSamples.push(ms(started));
}

const validate = (patch) => {
  const raw = {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, ...patch};
  const result = validateRecommendationRequest(raw, rc301Inputs);
  if (!result.ok) {
    throw new Error(`样例请求没有通过 RC-301 校验：${result.problems.map((p) => `${p.code}:${p.detail}`).join(' | ')}`);
  }
  return result.request;
};

/** 覆盖 0～6 只、硬约束、收藏池、图鉴物种这几类真实形状。 */
const SHAPES = [
  {id: 'empty-team', note: '一只都没选（0 只，按体系入口口径）', patch: () => ({})},
  {id: 'one-selected', note: '已选 1 只', patch: () => ({selected: ids.slice(0, 1)})},
  {id: 'two-selected', note: '已选 2 只：渐进推荐生效', patch: () => ({selected: ids.slice(0, 2)})},
  {id: 'three-selected', note: '已选 3 只：渐进推荐生效', patch: () => ({selected: ids.slice(0, 3)})},
  {id: 'five-selected', note: '已选 5 只：只差第六只', patch: () => ({selected: ids.slice(0, 5)})},
  {id: 'six-selected', note: '六只完整队伍：没有空槽，Beam 不做事', patch: () => ({selected: ids.slice(0, 6)})},
  {
    id: 'must-include-catalog-species', note: '锁一只 + must_include 一个图鉴物种（600+ 里的实体）',
    patch: () => ({selected: ids.slice(0, 2), must_include: catalogSpeciesIds.slice(0, 1)}),
  },
  {
    id: 'must-exclude-two', note: '已选 3 只并排除两只',
    patch: () => ({selected: ids.slice(0, 3), must_exclude: ids.slice(8, 10)}),
  },
  {
    id: 'favourites-only-three', note: '已选 3 只收藏 + favourites_only',
    patch: () => ({selected: favouriteIds.slice(0, 3), favourites_only: true}),
  },
];

const perShape = [];
const allSamples = {recall: [], beam: [], score: [], progressive: [], first_screen: []};
// 支撑证据（不是 RC-303 的验收指标）：一次完整在线产出 ≈ 需要多少堆内存与产出多大 JSON。
// RC-303 要钉的是「延迟」，这里只把「产出规模」也记下来，免得日后有人拿「它很轻」当口头结论。
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
// 堆增量只能当**粗粒度采样**：V8 的 GC 时机会让同一个纯函数调用的 heapUsed 差出正负几十 MB，
// 所以报告里只留一个明确的采样点，其余用「产出 JSON 的字节数」这种确定量。
const heapSample = {method: 'process.memoryUsage().heapUsed 前后差（粗粒度，含 GC 噪声）', notes: []};

for (const shape of SHAPES) {
  const request = validate(shape.patch());
  const recall = recallCandidates(request, {...inputs, __index: index});
  const beam = beamComplete(request, recall.candidates, {inputs: {...inputs, __index: index}, __index: index});
  const bucket = {recall: [], beam: [], score: [], progressive: [], first_screen: []};
  for (let run = 0; run < RUNS; run += 1) {
    const t0 = process.hrtime.bigint();
    const localRecall = recallCandidates(request, {...inputs, __index: index});
    const t1 = process.hrtime.bigint();
    const localBeam = beamComplete(request, localRecall.candidates, {inputs: {...inputs, __index: index}, __index: index});
    const t2 = process.hrtime.bigint();
    scoreTeams(localBeam.teams, {inputs: {...inputs, __index: index}});
    const t3 = process.hrtime.bigint();
    progressiveNext(request, {...inputs, __index: index});
    const t4 = process.hrtime.bigint();
    bucket.recall.push(ms(t0));
    bucket.beam.push(ms(t1));
    bucket.score.push(ms(t2));
    bucket.progressive.push(ms(t3));
    // 首屏 = 从 recall 开始到 progressive 结束（四段全含）。各 bucket 只记**增量**，
    // 不记累计值，所以这里必须分别取三段差再相加，不能直接用 ms(t0)。
    bucket.first_screen.push(ms(t1) + ms(t2) + ms(t3));
  }
  const heapBefore = process.memoryUsage().heapUsed;
  const planForSize = buildTeamCandidatePlan(request, {...inputs, __index: index});
  const heapAfter = process.memoryUsage().heapUsed;
  const payloadBytes = Buffer.byteLength(JSON.stringify(planForSize), 'utf8');
  heapSample.notes.push(`${shape.id}: heapUsed ${Math.round((heapAfter - heapBefore) / 1024 / 1024 * 10) / 10}MB`);
  for (const key of Object.keys(bucket)) allSamples[key].push(...bucket[key]);
  perShape.push({
    plan_payload_bytes: payloadBytes,
    plan_payload_kb: kb(payloadBytes),
    id: shape.id,
    note: shape.note,
    request,
    recall_count: recall.count,
    recall_pool_size: recall.pool.pool_size,
    remaining_slots: recall.remaining_slots,
    team_count: beam.team_count,
    beam_budget_actual: beam.budgets,
    segments: {
      recall: stats(bucket.recall),
      beam: stats(bucket.beam),
      score: stats(bucket.score),
      progressive: stats(bucket.progressive),
      first_screen: stats(bucket.first_screen),
    },
  });
}

// ── 与 13 号文档 §5.2 的预算逐项对照 ────────────────────────────────────────

const segmentStats = {
  recall: stats(allSamples.recall),
  beam: stats(allSamples.beam),
  score: stats(allSamples.score),
  progressive: stats(allSamples.progressive),
  first_screen: stats(allSamples.first_screen),
};

const budgetComparison = {
  recall: {
    segment: '600+ 候选过滤/召回',
    p50_ms: segmentStats.recall.p50_ms,
    p95_ms: segmentStats.recall.p95_ms,
    max_ms: segmentStats.recall.max_ms,
    budget_ms: LATENCY_BUDGET_MS.recall,
    within_budget: segmentStats.recall.p95_ms <= LATENCY_BUDGET_MS.recall,
    criteria: '13 号文档 §5.2：600+ 候选过滤/召回 P95 预算 150ms',
  },
  beam_and_ranker: {
    segment: 'Beam + Ranker',
    p50_ms: Math.round((segmentStats.beam.p50_ms + segmentStats.score.p50_ms) * 1000) / 1000,
    p95_ms: Math.round((segmentStats.beam.p95_ms + segmentStats.score.p95_ms) * 1000) / 1000,
    max_ms: Math.round((segmentStats.beam.max_ms + segmentStats.score.max_ms) * 1000) / 1000,
    budget_ms: LATENCY_BUDGET_MS.beam_and_ranker,
    within_budget: (segmentStats.beam.p95_ms + segmentStats.score.p95_ms) <= LATENCY_BUDGET_MS.beam_and_ranker,
    criteria: '13 号文档 §5.2：Beam + Ranker P95 预算 300ms（本报告把 beam 与 score 两段相加对照）',
    note: '排序器（Team Ranker）不存在，score 段实际跑的是规则打分（rule_score），不是训练出来的模型；'
      + '所以这一格是**下界**：真接上 GBDT/Set 模型后要重测',
  },
  first_screen: {
    segment: '首屏短结论（召回 + Beam + 排序 + 渐进推荐）',
    p50_ms: segmentStats.first_screen.p50_ms,
    p95_ms: segmentStats.first_screen.p95_ms,
    max_ms: segmentStats.first_screen.max_ms,
    budget_ms: LATENCY_BUDGET_MS.first_screen,
    within_budget: segmentStats.first_screen.p95_ms <= LATENCY_BUDGET_MS.first_screen,
    criteria: '13 号文档 §5.2：首屏短结论 800ms 内。本报告的四段和**不含**证据装配（§5.2 单列 300ms）'
      + '与 LLM 自然语言（总计 3s 内），是首屏的**下界**',
  },
  state_and_version: {
    segment: '状态与版本读取（索引构建，只跑一次）',
    p50_ms: stats(indexBuildSamples).p50_ms,
    p95_ms: null,
    max_ms: stats(indexBuildSamples).max_ms,
    budget_ms: LATENCY_BUDGET_MS.state_and_version,
    within_budget: stats(indexBuildSamples).max_ms <= LATENCY_BUDGET_MS.state_and_version,
    criteria: '13 号文档 §5.2：状态与版本读取 50ms。索引构建只测 3 次（进程内缓存，不重复跑）',
  },
};

// 反证：预算判定不许与实测矛盾（审计的 `LATENCY_BUDGET_FALSE_PASS`）。
const falsePasses = Object.entries(budgetComparison)
  .filter(([, row]) => typeof row.p95_ms === 'number')
  .filter(([, row]) => (row.p95_ms <= row.budget_ms) !== row.within_budget)
  .map(([key, row]) => `${key}: 实测 P95 ${row.p95_ms}ms / 预算 ${row.budget_ms}ms / within_budget=${row.within_budget}`);

const overBudget = Object.entries(budgetComparison)
  .filter(([, row]) => row.within_budget === false)
  .map(([key, row]) => `${key}: P95 ${row.p95_ms ?? 'n/a'}ms > 预算 ${row.budget_ms}ms`);

// ── 确定性 + 在线边界（同一份报告的机器判据） ──────────────────────────────

const source = readFileSync(join(ROOT, 'src', 'coach', 'team-candidates.mjs'), 'utf8');
const forbiddenHits = scanForbiddenPatterns(onlineSectionOf(source));
const determinismShape = perShape.find((s) => s.id === 'two-selected');
const determinismRequest = validate(SHAPES.find((s) => s.id === 'two-selected').patch());
// 报告样例统一用 `REPORT_BEAM_WIDTH`（比在线默认宽，为了给出 ≥6 支不同的队伍供人看）。
const REPORT_BUDGETS = {beamWidth: REPORT_BEAM_WIDTH};
const a = buildRc303Report(inputs, {source, budgets: REPORT_BUDGETS, latency: {available: false}});
const b = buildRc303Report(inputs, {source, budgets: REPORT_BUDGETS, latency: {available: false}});
const reportDeterministic = JSON.stringify(a) === JSON.stringify(b);
const planA = (await import('../../src/coach/team-candidates.mjs')).buildTeamCandidatePlan(determinismRequest, {...inputs, __index: index});
const planB = (await import('../../src/coach/team-candidates.mjs')).buildTeamCandidatePlan(determinismRequest, {...inputs, __index: index});
const planDeterministic = JSON.stringify(planA) === JSON.stringify(planB);

const latencyVersion = 'roco-rc303-team-candidates-latency/v1';
const latencyReport = {
  report_version: latencyVersion,
  rc: 'RC-303',
  generated_at: nowIso(),
  command: 'node scripts/roco/measure-team-candidates.mjs',
  runs_per_shape: RUNS,
  environment: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpu: cpus()?.[0]?.model ?? null,
    cpu_count: cpus()?.length ?? null,
  },
  methodology: {
    clock: 'process.hrtime.bigint()（单调时钟）',
    percentile: '最近秩：sorted[floor(q * n)]（与 reports/roco/adapter-load 同口径）',
    excluded_from_segments: 'buildCandidateIndex() 的索引构建单列在 state_and_version 一格，不计入 recall/beam/score',
    first_screen_segment: '首屏 = recall + beam + score + progressive 四段和；不含证据装配（§5.2 单列 300ms）与 LLM',
    data: {
      owned_instances: inputs.owned.instances.length,
      owned_species: new Set(inputs.owned.instances.map((i) => i.species_id)).size,
      catalog_pet_entities: index.facts.catalog_pet_entities,
      candidate_universe_note: '召回默认按 policy.candidate_universe = catalog（全量图鉴 ∪ 玩家箱子）',
    },
    honesty: '超预算的格子写 within_budget:false；不为了让报告好看而调参或改样例',
  },
  budgets_source: {
    document: '/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §5.2',
    values_ms: LATENCY_BUDGET_MS,
  },
  recall_contract: {min: RECALL_MIN, max: RECALL_MAX},
  beam_budgets_default: DEFAULT_BEAM_BUDGETS,
  index_build: stats(indexBuildSamples),
  segment_stats: segmentStats,
  budget_comparison: budgetComparison,
  budget_false_passes: falsePasses,
  over_budget: overBudget,
  all_within_budget: overBudget.length === 0,
  determinism: {
    plan_two_runs_byte_identical: planDeterministic,
    report_two_runs_byte_identical: reportDeterministic,
    criteria: '同一输入连续两次调用，JSON.stringify 逐字节相同（含固定 tie-break）',
    checked_shape: determinismShape?.id ?? null,
  },
  online_boundary: {
    online_section_lines: onlineSectionOf(source).split('\n').length,
    forbidden_hits: forbiddenHits,
    forbidden_hits_count: forbiddenHits.length,
    passed: forbiddenHits.length === 0,
    criteria: '在线段（ONLINE_SECTION_MARKER 之前、剥注释后）不许出现引擎 / 子进程 / 引擎客户端的调用',
  },
  ranker: {
    status: 'missing',
    note: '本仓没有版本化 Team Ranker 产物：score 段实际跑的是规则打分。'
      + '这一格是**下界**——接上真实模型后必须重测，并重跑本脚本',
  },
  payload_scale: {
    note: '支撑证据，不是 RC-303 的验收指标：一次完整在线产出的 JSON 规模（确定量）',
    max_plan_payload_kb: Math.max(...perShape.map((s) => s.plan_payload_kb)),
    per_shape: perShape.map((s) => ({id: s.id, plan_payload_kb: s.plan_payload_kb})),
  },
  heap_sample: heapSample,
  per_shape: perShape,
  raw_samples_ms: Object.fromEntries(Object.entries(allSamples).map(([key, list]) => [key, list.map((v) => Math.round(v * 1000) / 1000)])),
  unverified: [
    '未核实：真机 / 浏览器里的耗时 —— 本报告是 Node 进程内的纯函数计时，不含 IPC、渲染与网络',
    '未核实：真实 GBDT/Set Ranker 的耗时 —— 现在 ranker 不存在，score 段是规则打分（下界）',
    '未核实：证据装配 300ms 那一格 —— RC-303 不产证据装配，只有候选/队伍的 machine_evidence 字段',
  ],
};

if (!jsonOnly) {
  mkdirSync(OUT_DIR, {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(latencyReport, null, 2)}\n`, 'utf8');
  console.log(`已写出 ${OUT}`);
  for (const [key, row] of Object.entries(budgetComparison)) {
    console.log(`  ${key.padEnd(20)} P95 ${String(row.p95_ms ?? 'n/a').padStart(8)}ms / 预算 ${String(row.budget_ms).padStart(5)}ms`
      + ` ⇒ ${row.within_budget ? '在预算内' : '**超预算**'}`);
  }
  if (overBudget.length) {
    console.log('超预算项：');
    for (const row of overBudget) console.log(`  · ${row}`);
  }
  if (falsePasses.length) {
    console.log('预算判定与实测矛盾（必须修）：');
    for (const row of falsePasses) console.log(`  · ${row}`);
  }
  // 把实测合并进 RC-303 报告（可复跑：报告里的 latency 段来自这个文件的内容）。
  const report = buildRc303Report(inputs, {source, budgets: REPORT_BUDGETS, latency: {
    available: true,
    report_path: 'reports/roco/team-candidates/latency.json',
    report_version: latencyVersion,
    measured_at: latencyReport.generated_at,
    runs_per_shape: RUNS,
    segment_stats: segmentStats,
    budget_comparison: budgetComparison,
    over_budget: overBudget,
    all_within_budget: overBudget.length === 0,
    ranker_note: latencyReport.ranker.note,
  }});
  const reportPath = join(ROOT, RC303_REPORT_PATH);
  mkdirSync(dirname(reportPath), {recursive: true});
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已写出 ${reportPath}`);
} else {
  console.log(JSON.stringify(latencyReport, null, 2));
}
