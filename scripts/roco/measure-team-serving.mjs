#!/usr/bin/env node
// RC-306 的**分段 serving 证据**：把真实的召回 / Beam+排序 / 证据与反事实四段装进
// `serveStages()` 契约里跑，回答三个交付问题：
//
//   ① **300ms 初判**：`state_and_version` + `recall` 两段（标了 `required_for_first`）的 P95 是否 ≤ 300ms；
//   ② **3s 完整解释**：四段全跑完的 P95 是否 ≤ 3000ms，且 `full !== null`（没有段被跳过/超时）；
//   ③ **超时保短结论**：人为放慢一段之后，`full === null` + `degraded === true` + 逐段点名，
//      并且短结论**只由在预算内成功的段**拼出来（不是编一句）。
//
// ③ 是**负向控制**：全快的路径本来就不会出问题，只有把超时分支真的跑一遍，
// 「超时保短结论」这句话才算被证明过。这里用真实时钟 + 真实代码做两次注入：
//   · `over_first`：必需段忙等 350ms（>300ms）⇒ 初判必须为 null；
//   · `over_full` ：某段忙等 3200ms（>3000ms）⇒ 完整解释必须为 null 且后续段不再开始。
//
// 用法：
//   node scripts/roco/measure-team-serving.mjs [--runs=20] [--json]
// 产物：reports/roco/team-serving/serving.json

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {arch, cpus, platform, release} from 'node:os';

import {
  SERVING_BUDGETS, modeActionProblems, serveStages,
} from '../../src/coach/team-serving.mjs';
import {
  beamComplete, buildCandidateIndex, loadTeamCandidatesInputs, recallCandidates, resolvePolicy, scoreTeams,
} from '../../src/coach/team-candidates.mjs';
import {diagnoseTeamGaps, loadTeamGapsInputs} from '../../src/coach/team-gaps.js';
import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, loadRecommendationInputs, validateRecommendationRequest,
} from '../../src/coach/team-request.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'team-serving');
const OUT = join(OUT_DIR, 'serving.json');
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(3, Number(runsArg.split('=')[1]) || 20) : 20;

const realClock = {now: () => Number(process.hrtime.bigint()) / 1e6};
const fakeClock = () => { let now = 0; return {now: () => now, advance: (ms) => { now += ms; }}; };
const busyWait = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* 真实占用 CPU：这不是 sleep，是「一段真的算慢了」 */ } };
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const round3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min_ms: round3(sorted[0] ?? null),
    p50_ms: round3(pct(sorted, 0.5)),
    p95_ms: round3(pct(sorted, 0.95)),
    max_ms: round3(sorted.at(-1) ?? null),
    mean_ms: sorted.length ? round3(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
  };
};

// ── 真实数据 ────────────────────────────────────────────────────────────────

const inputs = await loadTeamCandidatesInputs({root: ROOT});
const gapsInputs = await loadTeamGapsInputs({root: ROOT});
const rc301Inputs = await loadRecommendationInputs({root: ROOT});
const ids = [...inputs.owned.instances].map((i) => i.instance_id).sort();
const request = {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, selected: ids.slice(0, 2), max_replacements: 2};
const validation = validateRecommendationRequest(request, rc301Inputs);
if (!validation.ok) {
  console.error('[team-serving] 请求没通过 RC-301 合同：', validation.problems.map((p) => `${p.code}:${p.field}`).join(' '));
  process.exit(2);
}
const policy = resolvePolicy(inputs.policy ?? {});

/** 四段真实服务：状态与版本 / 召回 / Beam+排序 / 证据与反事实。 */
function realStages() {
  const box = {index: null, recall: null, beam: null, ranking: null, gaps: null};
  return {
    box,
    stages: [
      {id: 'state_and_version', required_for_first: true, short: (index) => `索引就绪（候选 ${index?.candidates?.size ?? '?'} 只）。`,
        run: () => { box.index = buildCandidateIndex(inputs); return {candidates: box.index.candidates?.size ?? null}; }},
      {id: 'recall', required_for_first: true, short: (recall) => `本轮召回 ${recall?.candidates?.length ?? 0} 个候选。`,
        run: () => { box.recall = recallCandidates(validation.request, {...inputs, __index: box.index, policy}); return {candidates: box.recall?.candidates?.length ?? 0}; }},
      {id: 'beam_and_ranker', short: (row) => `补全并排序得到 ${row?.teams ?? 0} 支六宠队伍（规则启发式，不是胜率）。`,
        run: () => {
          box.beam = beamComplete(validation.request, box.recall.candidates, {...(inputs.budgets ?? {}), inputs: {...inputs, __index: box.index}, policy, __index: box.index});
          box.ranking = scoreTeams(box.beam.teams, {ranker: inputs.ranker ?? null, k: inputs.k ?? 10, inputs: {...inputs, __index: box.index}});
          return {teams: box.beam.teams?.length ?? 0, ranker_status: box.ranking?.ranker_status ?? null};
        }},
      {id: 'evidence_and_counterfactual', short: () => '证据与反事实替换已装配（缺的输入逐条点名）。',
        run: () => {
          box.gaps = diagnoseTeamGaps(validation.request, gapsInputs);
          return {gaps_ok: box.gaps.ok === true, problems: box.gaps.problems?.length ?? 0};
        }},
    ],
  };
}

// ── 主循环（真实时钟）─────────────────────────────────────────────────────

const runs = [];
for (let i = 0; i < RUNS; i += 1) {
  const {stages} = realStages();
  const result = serveStages({stages, clock: realClock});
  runs.push({
    elapsed_ms: result.elapsed_ms,
    first_ms: result.first?.elapsed_ms ?? null,
    ok: result.ok,
    degraded: result.degraded,
    stages: Object.fromEntries(result.stages.map((row) => [row.id, row.took_ms])),
    missing: result.short.missing_stages,
  });
}

const firstSamples = runs.map((row) => row.first_ms).filter((v) => typeof v === 'number');
const totalSamples = runs.map((row) => row.elapsed_ms);
const stageStats = Object.fromEntries(['state_and_version', 'recall', 'beam_and_ranker', 'evidence_and_counterfactual']
  .map((id) => [id, stats(runs.map((row) => row.stages[id]).filter((v) => typeof v === 'number'))]));

const firstP95 = stats(firstSamples).p95_ms;
const totalP95 = stats(totalSamples).p95_ms;
const allComplete = runs.every((row) => row.ok && row.degraded === false);

// ── 负向控制：把超时分支真的跑一遍（真实时钟 + 真实契约）──────────────────

const overFirst = serveStages({
  clock: realClock,
  stages: [
    {id: 'slow_recall', required_for_first: true, run: () => { busyWait(350); return {n: 1}; }},
    {id: 'rest', run: () => ({n: 2})},
  ],
});
const overFull = serveStages({
  clock: realClock,
  budgets: {full_answer_ms: 400},
  stages: [
    {id: 'first', required_for_first: true, short: () => '第一段成功。', run: () => ({n: 1})},
    {id: 'slow_evidence', run: () => { busyWait(600); return {n: 2}; }},
    {id: 'never_runs', run: () => ({n: 3})},
  ],
});

// ── 只发模式合法动作：用**真配置**的 actions 块当声明 ──────────────────────

const v3 = JSON.parse(readFileSync(join(ROOT, 'data/roco/rulesets/mobile-s4-candidate-v3.json'), 'utf8'));
// 配置里的每个字段都带 `value/confidence/evidence_id`，闸要的是**裸值**——
// 所以这里显式解包（顺带证明「声明来自真配置，不是手写样例」）。
const declaration = {
  allowed_kinds: v3.actions.allowed_kinds.value,
  forbidden_kinds: v3.actions.forbidden_kinds.value,
  unknown_kinds_allowed: v3.actions.unknown_kinds_allowed.value,
};
const legalSample = [{kind: 'skill'}, {kind: 'charge'}, {kind: 'switch'}, {kind: 'surrender'}];
const leakSample = [{kind: 'skill'}, {kind: 'item', label: '使用回复药'}, {kind: 'escape', label: '逃跑'}];
const guardClean = modeActionProblems(legalSample, declaration);
const guardLeak = modeActionProblems(leakSample, declaration);

// ── 判定 ────────────────────────────────────────────────────────────────────

const checks = [
  {id: 'first_answer_within_budget', what: `初判 P95 ≤ ${SERVING_BUDGETS.first_answer_ms}ms`, result: firstP95 !== null && firstP95 <= SERVING_BUDGETS.first_answer_ms, actual: {p95_ms: firstP95, budget_ms: SERVING_BUDGETS.first_answer_ms}},
  {id: 'full_answer_within_budget', what: `完整解释 P95 ≤ ${SERVING_BUDGETS.full_answer_ms}ms`, result: totalP95 !== null && totalP95 <= SERVING_BUDGETS.full_answer_ms, actual: {p95_ms: totalP95, budget_ms: SERVING_BUDGETS.full_answer_ms}},
  {id: 'normal_run_not_degraded', what: '正常路径每次都给出初判与完整解释（四个真实段都没超预算）', result: allComplete, actual: {runs: RUNS, degraded_runs: runs.filter((row) => row.degraded).length}},
  {id: 'over_first_budget_yields_no_first', what: '必需段忙等 350ms ⇒ 初判必须为 null（不许发半截初判）', result: overFirst.first === null, actual: {first: overFirst.first, problems: overFirst.problems}},
  {id: 'over_full_budget_yields_no_full', what: '某段忙等 600ms（预算 400ms）⇒ 完整解释为 null + 后续段不再开始 + 短结论只由成功段拼', result: overFull.full === null && overFull.degraded === true && overFull.stages.at(-1).status === 'skipped' && overFull.short.conclusion.includes('第一段成功'), actual: {full: overFull.full, degraded: overFull.degraded, last_stage: overFull.stages.at(-1).status, conclusion: overFull.short.conclusion, missing: overFull.short.missing_stages}},
  {id: 'mode_guard_passes_legal', what: '标准 PVP 的合法动作（skill/charge/switch/surrender）过模式闸', result: guardClean.length === 0, actual: guardClean},
  {id: 'mode_guard_catches_leak', what: '载荷里混进 item/escape 必须被抓到（反证：闸不是空的）', result: guardLeak.length === 2 && guardLeak.every((line) => line.includes('FORBIDDEN_KIND_LEAKED')), actual: guardLeak},
];

const failed = checks.filter((row) => row.result !== true);
const report = {
  report_version: 'roco-rc306-serving/v1',
  rc: 'RC-306',
  generated_at: new Date().toISOString(),
  command: `node scripts/roco/measure-team-serving.mjs --runs=${RUNS}`,
  environment: {node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()?.[0]?.model ?? null, cpu_count: cpus()?.length ?? null},
  methodology: {
    clock: 'process.hrtime.bigint()（单调时钟）',
    percentile: '最近秩：sorted[floor(q * n)]（与 reports/roco/team-candidates/latency.json 同口径）',
    stages: '四段真实计算：state_and_version（索引）/ recall / beam_and_ranker / evidence_and_counterfactual（RC-302 诊断）',
    negative_control: '真实时钟 + 真实契约，注入 350ms（初判预算）与 600ms（总预算 400ms）两段忙等，证明超时分支可达',
    mode_guard: '声明取自 data/roco/rulesets/mobile-s4-candidate-v3.json 的 actions 块（不是手写的样例）',
  },
  budgets: SERVING_BUDGETS,
  runs_per_shape: RUNS,
  checks,
  stage_stats: stageStats,
  first_answer: stats(firstSamples),
  total: stats(totalSamples),
  negative_controls: {
    over_first_budget: {budgets: overFirst.budgets, first: overFirst.first, problems: overFirst.problems, elapsed_ms: overFirst.elapsed_ms},
    over_full_budget: {budgets: overFull.budgets, full: overFull.full, degraded: overFull.degraded, stages: overFull.stages, conclusion: overFull.short.conclusion, missing_stages: overFull.short.missing_stages},
  },
  mode_action_guard: {declaration, legal: guardClean, leak: guardLeak},
  ok: failed.length === 0,
  failed_checks: failed.map((row) => row.id),
};

mkdirSync(OUT_DIR, {recursive: true});
writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
if (jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
else {
  console.log(`[team-serving] 初判 P95 = ${firstP95}ms（预算 ${SERVING_BUDGETS.first_answer_ms}）／完整解释 P95 = ${totalP95}ms（预算 ${SERVING_BUDGETS.full_answer_ms}）`);
  console.log(`[team-serving] 正常路径 ${RUNS} 次全部 degraded=false = ${allComplete}`);
  console.log(`[team-serving] 负向控制：超初判预算 ⇒ first=${overFirst.first === null ? 'null ✔' : '有值 ✘'}；超总预算 ⇒ full=${overFull.full === null ? 'null ✔' : '有值 ✘'}，skipped=${overFull.stages.at(-1).status}`);
  console.log(`[team-serving] 模式闸：合法样本 ${guardClean.length} 条问题；泄漏样本 ${guardLeak.length} 条问题`);
  for (const check of checks) console.log(`[team-serving] ${check.result ? '✔' : '✘'} ${check.id} ${check.what}`);
  console.log(`[team-serving] 报告：${OUT.replace(`${ROOT}/`, '')}`);
}
process.exit(report.ok ? 0 : 1);
