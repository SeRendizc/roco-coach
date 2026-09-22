// RC-304 未知对手下队伍比较的守卫。
//
// 这一组判据要证明的是**五轴有没有牙**，而不是「输出里字段齐不齐」。每一条都先把正确产出
// **改坏**，再喂回 `auditTeamCompare()`，必须变红；并把**实际输出原文**打出来
// （报告 `reports/roco/flagship-upgrade/rc-304-team-compare.json` 里逐条引用这些行）：
//   ① 分布 unknown 时前四轴返回数值            ⇒ 红（UNKNOWN_AXIS_HAS_VALUE）
//   ② 返回 0 / null 却写 available:true        ⇒ 红（AVAILABILITY_SHAPE / UNKNOWN_AXIS_HAS_VALUE）
//   ③ 输出胜率 / 百分数 / 榜单词              ⇒ 红（PSEUDO_PRECISION；数值、量纲、渲染文本一起扫）
//   ④ 注入 measured 分布后前四轴仍 unknown     ⇒ 红（MEASURED_NOT_WIRED）——**反向证明 fail closed 不是恒 unknown**
//   ⑤ coverage_confidence 用了没有 build 数据的实体却报高置信 ⇒ 红（COVERAGE_NOT_FROM_BUILD）
//   ⑥ 在线导出段出现引擎 / 子进程调用          ⇒ 红（ONLINE_ENGINE_CALL / ONLINE_SUBPROCESS_CALL）
//   ⑦ minimalReplacement 返回多于一个方案 / 没有 why ⇒ 红（REPLACEMENT_SHAPE）
//   ⑧ 两次运行不确定（含 tie-break）           ⇒ 红（NONDETERMINISTIC）
// 另外钉住：⑤ 那一轴是真的算出来的（注入更差的 build ⇒ 覆盖置信必须更低）、分布 unknown 时
// 最小替换只给**结构理由**并明说不知道、报告与生成逻辑逐字节一致、证据只指向注入数据或仓内真实文件。
//
// 用法：`node --test tests/roco-team-compare.test.js`
//       `RC304_WRITE_REPORT=1 node --test tests/roco-team-compare.test.js`（重新生成报告）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  AXES, AXIS_IDS, BANNED_CLAIM_KEYS, BANNED_CLAIM_WORDS, BANNED_UNIT_WORDS,
  DISTRIBUTION_AXES, FAIL_CLOSED_REASONS, FORBIDDEN_ONLINE_PATTERNS, OFFLINE_ENTRYPOINTS,
  ONLINE_ENTRYPOINTS, ONLINE_SECTION_MARKER, RANKER_STATUSES, RC304_REPORT_PATH,
  RELATIVE_SCORE_RANGE, RELATIVE_UNIT, STRUCTURAL_CRITERIA,
  auditTeamCompare, buildMeasuredDistributionSample, buildRc304Report, collectClaimText,
  compareTeams, diagnoseForCompare, formatAuditProblem, loadTeamCompareInputs, minimalReplacement,
  offlineSectionOf, onlineSectionOf, renderCompareText, resolveDistribution, scanForbiddenPatterns,
} from '../src/coach/team-compare.mjs';
import {CONFIDENCE_LEVELS} from '../src/coach/team-gaps.js';
import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, loadRecommendationInputs, validateRecommendationRequest,
} from '../src/coach/team-request.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const log = (...args) => console.log('  ·', ...args);

/** 每条反证打印**实际输出原文**：报告里贴的就是这些行。 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

/**
 * 反证留痕：报告里的 `red_proofs[]` 就是这些条目（**实际输出原文**，不是复述）。
 * 每条 = {where, criterion, mutation, expect_code, actual}。
 */
const RED_PROOFS = [];
const proof = (where, mutation, criterion, expectCode, actual) => {
  const record = {
    where,
    mutation,
    criterion,
    expect_code: expectCode,
    actual: typeof actual === 'string' ? actual : JSON.stringify(actual),
  };
  RED_PROOFS.push(record);
  return record;
};
/** 从审计结果里抽出「实际输出原文」：每条问题按 `[码] 位置：说明` 落到一行。 */
const auditRaw = (audit) => audit.problems.map(formatAuditProblem);

const inputs = await loadTeamCompareInputs({root: ROOT});
const rc301Inputs = await loadRecommendationInputs({root: ROOT});
const prior = readJson('data/roco/meta-prior/v1.json');
const SOURCE = readFileSync(join(ROOT, 'src', 'coach', 'team-compare.mjs'), 'utf8');
const registry = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, rc301Inputs).registry;
const ids = [...registry.instances.keys()].sort();
const owned = [...registry.instances.values()];

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A3（2026-09-22）：样例队伍必须**同物种最多一只**。
 * 原来直接 `list.slice(0, 6)` —— 箱子前几个实例（own-0001/own-0002…）天生同种，
 * 六支样例队伍全都违反新硬约束。这里统一在 pick 里按物种去重，形状语义不变。
 */
const distinctSpecies = (list) => {
  const seen = new Set(); const out = [];
  for (const row of list) {
    if (seen.has(row.species_id)) continue;
    seen.add(row.species_id); out.push(row);
  }
  return out;
};

/** 六支真实队伍：从箱子里按确定性形状取，形状之间不重复。 */
const TEAM_SHAPES = Object.freeze([
  Object.freeze({id: 'rc304-six-a', pick: (list) => distinctSpecies(list).slice(0, 6)}),
  Object.freeze({id: 'rc304-six-b', pick: (list) => distinctSpecies(list).slice(6, 12)}),
  Object.freeze({id: 'rc304-six-c', pick: (list) => distinctSpecies(list).slice(12, 18)}),
  Object.freeze({
    id: 'rc304-six-d',
    pick: (list) => distinctSpecies(list.filter((row) => row.favourite === true)).slice(0, 6),
  }),
  Object.freeze({id: 'rc304-six-e', pick: (list) => distinctSpecies(list.filter((_, index) => index % 2 === 0)).slice(0, 6)}),
  Object.freeze({id: 'rc304-six-f', pick: (list) => distinctSpecies(list.filter((_, index) => index % 2 === 1)).slice(0, 6)}),
]);

const teamRows = [];
for (const shape of TEAM_SHAPES) {
  const picked = shape.pick(owned);
  if (picked.length < 6) continue;
  const request = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE,
    selected: picked.map((row) => row.instance_id),
  }, rc301Inputs);
  assert.equal(request.ok, true, `样例队伍 ${shape.id} 必须通过 RC-301`);
  teamRows.push({
    team_id: shape.id,
    request: request.request,
    // key 用 RC-301/RC-302 的登记键（`instance:<instance_id>`）：两套键混用会让覆盖置信读不到 build 数据。
    team: {team_id: shape.id, members: picked.map((row) => ({key: `instance:${row.instance_id}`, species_id: row.species_id}))},
  });
}
assert.ok(teamRows.length >= 6, `至少要有 6 支真实队伍，实际 ${teamRows.length}`);

/** 真实队伍的 RC-302 诊断：覆盖置信与最小替换的结构输入。 */
const gapsByTeam = {};
for (const row of teamRows) Object.assign(gapsByTeam, diagnoseForCompare(row.team_id, row.request, inputs));

const teamRef = (teamId) => teamRows.find((row) => row.team_id === teamId).team;
const PAIRS = Object.freeze([
  ['rc304-six-a', 'rc304-six-b'],
  ['rc304-six-a', 'rc304-six-c'],
  ['rc304-six-b', 'rc304-six-c'],
  ['rc304-six-d', 'rc304-six-e'],
  ['rc304-six-a', 'rc304-six-e'],
  ['rc304-six-c', 'rc304-six-f'],
  ['rc304-six-e', 'rc304-six-f'],
]);

const compare = (teamIdA, teamIdB, metaPrior = prior) => compareTeams({
  teamA: teamRef(teamIdA), teamB: teamRef(teamIdB), metaPrior, gapsByTeam,
});
const replacement = (teamId, metaPrior = prior, candidates = []) => minimalReplacement({
  team: teamRef(teamId), metaPrior, candidates, gapsByTeam,
});
const auditText = (result) => result.problems.map(formatAuditProblem);

/** 一份**构造**的 measured 分布（对照样例）：证明接口不是恒 unknown。 */
const MEASURED = buildMeasuredDistributionSample({archetypes: [
  {archetype_id: 'poison_stack', label: '毒系消耗', value: 0.35, relative_score: 0.30, tolerance: 0.80},
  {archetype_id: 'ice_control', label: '冰系控场', value: 0.25, relative_score: 0.72, tolerance: 0.90},
  {archetype_id: 'fighting_press', label: '武系压制', value: 0.40, relative_score: 0.55, tolerance: 0.60},
]});
/** 加权均值（判据自己重算一遍，与实现独立）：Σ(score×weight)/Σweight。 */
const weightedMean = (rows, field) => {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return Number((rows.reduce((sum, row) => sum + row[field] * row.value, 0) / total).toFixed(6));
};

/** 一组注入候选：有、无 `covers_types`、有、无 build 数据，专门用来试 tie-break 与拒绝编造。 */
const candidatesFor = (teamId) => {
  const uncovered = new Set();
  for (const gap of gapsByTeam[teamId].gaps) {
    if (gap.dimension === 'coverage' && typeof gap.value?.attack_type === 'string') uncovered.add(gap.value.attack_type);
  }
  const list = [...uncovered].sort();
  return [
    {candidate_key: 'cand:zzz', covers_types: list.slice(0, 1), has_build: false},
    {candidate_key: 'cand:aaa', covers_types: list.slice(0, 2), has_build: true},
    {candidate_key: 'cand:mmm', covers_types: list.slice(0, 2), has_build: false},
    {candidate_key: 'cand:none', covers_types: [], has_build: true},
  ];
};
/**
 * tie-break 用例：两个候选的可对接系别数与 build 完全一样，只能靠字典序决定。
 * 系别取该队**真实**的无人承接弱点（否则这就是一个「补不上任何缺口」的假用例）。
 */
const TIE_TYPES = Object.freeze(gapsByTeam['rc304-six-a'].gaps
  .filter((gap) => gap.dimension === 'coverage' && typeof gap.value?.attack_type === 'string')
  .map((gap) => gap.value.attack_type).sort().slice(0, 1));
assert.equal(TIE_TYPES.length, 1, '样例队伍至少要有一个无人承接的攻击系别');
const TIE_CANDIDATES = Object.freeze([
  Object.freeze({candidate_key: 'cand:bbb', covers_types: [...TIE_TYPES], has_build: true}),
  Object.freeze({candidate_key: 'cand:aaa', covers_types: [...TIE_TYPES], has_build: true}),
]);

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ①～⑧
// ─────────────────────────────────────────────────────────────────────────

test('RC-304 判据①：分布 unknown 时前四轴必须 fail closed（返回数值即判红）', () => {
  const result = compare('rc304-six-a', 'rc304-six-b');
  const distribution = resolveDistribution(prior);
  raw('① 注入先验的分布判定', {
    kind: distribution.kind, declared_source: distribution.declared_source,
    entries: distribution.entries.map((row) => ({archetype_id: row.archetype_id, source: row.source, value: row.value})),
    missing: distribution.missing,
  });
  assert.equal(distribution.kind, 'unknown');
  for (const axisId of DISTRIBUTION_AXES) {
    const axis = result.axes[axisId];
    assert.equal(axis.available, false, `① ${axisId} 在分布 unknown 时必须 available:false`);
    assert.equal(axis.value, null, `① ${axisId} 不许给值（含 0）`);
    assert.ok(typeof axis.unknown_reason === 'string' && axis.unknown_reason.length > 0,
      `① ${axisId} 必须点名缺什么`);
  }
  raw('① 四轴的 available / value / unknown_reason', DISTRIBUTION_AXES.map((axisId) => ({
    axis: axisId, available: result.axes[axisId].available, value: result.axes[axisId].value,
    unknown_reason: result.axes[axisId].unknown_reason,
  })));
  // 必红：把 unknown 的轴改成一个数（0 也算）
  for (const broken of [0, 1, 0.5]) {
    const mutated = clone(result);
    mutated.axes.environment_value.value = broken;
    const audit = auditTeamCompare({compare: mutated, replacement: replacement('rc304-six-a')}, {
      text: renderCompareText({...mutated, replacement: replacement('rc304-six-a')}),
    });
    raw(`① 把 environment_value 改成 ${broken} 之后的审计`, {ok: audit.ok, problems: auditText(audit)});
    proof('compare.axes.environment_value.value', `分布 unknown 时把 value 改成 ${broken}`,
      STRUCTURAL_CRITERIA.distribution_fail_closed, 'UNKNOWN_AXIS_HAS_VALUE', auditRaw(audit));
    assert.equal(audit.ok, false, `① 分布 unknown 时写 value=${broken} 必须判红`);
    assert.ok(audit.problems.some((p) => p.code === 'UNKNOWN_AXIS_HAS_VALUE'));
  }
  assert.equal(auditTeamCompare({compare: result, replacement: replacement('rc304-six-a')},
    {text: renderCompareText({...result, replacement: replacement('rc304-six-a')})}).ok, true);
});

test('RC-304 判据②：返回 0 / null 却写 available:true 必须判红', () => {
  const result = compare('rc304-six-a', 'rc304-six-b');
  const good = auditTeamCompare({compare: result, replacement: replacement('rc304-six-a')},
    {text: renderCompareText({...result, replacement: replacement('rc304-six-a')})});
  raw('② 原始产出的审计', {ok: good.ok, problems: auditText(good)});
  assert.equal(good.ok, true);

  // ②-1 available:true + value:null（用一个算不出来的轴冒充「已知」）
  const nullClaim = clone(result);
  nullClaim.axes.coverage_confidence.available = true;
  nullClaim.axes.coverage_confidence.value = null;
  let audit = auditTeamCompare({compare: nullClaim, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('② available:true + value:null', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.coverage_confidence.value', 'available:true 却把 value 设成 null',
    STRUCTURAL_CRITERIA.availability_shape, 'AVAILABILITY_SHAPE', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'AVAILABILITY_SHAPE'));

  // ②-2 available:true + value:0（0 是「不知道」的伪装）
  const zeroClaim = clone(result);
  zeroClaim.axes.environment_value.available = true;
  zeroClaim.axes.environment_value.value = 0;
  audit = auditTeamCompare({compare: zeroClaim, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('② available:true + value:0', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.environment_value.value', '分布 unknown 却把 available 改成 true、value 设成 0',
    STRUCTURAL_CRITERIA.availability_shape, 'AVAILABILITY_SHAPE 或 UNKNOWN_AXIS_HAS_VALUE', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'AVAILABILITY_SHAPE'
    || p.code === 'UNKNOWN_AXIS_HAS_VALUE'));

  // ②-3 unknown 的轴却声明了量纲
  const unitClaim = clone(result);
  unitClaim.axes.coverage_confidence.available = false;
  unitClaim.axes.coverage_confidence.value = null;
  unitClaim.axes.execution_tolerance.value_numbers = [{name: 'value', unit: RELATIVE_UNIT}];
  audit = auditTeamCompare({compare: unitClaim, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('② unknown 的轴声明量纲', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'UNKNOWN_AXIS_HAS_VALUE'));

  // ②-4 unknown 的轴却报一个台账等级（不是 UNKNOWN）
  const confClaim = clone(result);
  confClaim.axes.matchup_spread.confidence = 'COMMUNITY_CURRENT';
  audit = auditTeamCompare({compare: confClaim, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('② unknown 的轴报非 UNKNOWN 置信', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'CONFIDENCE_NOT_IN_LEDGER'));
});

test('RC-304 判据③：输出胜率 / 百分数 / 榜单词必须判红（数值、量纲、渲染文本一起扫）', () => {
  const result = compare('rc304-six-a', 'rc304-six-b');
  const replacementRow = replacement('rc304-six-a');
  const text = renderCompareText({...result, replacement: replacementRow});
  raw('③ 渲染文本原文', text);
  assert.ok(!text.includes('%'), '③ 渲染文本里不许出现百分号');
  const clean = auditTeamCompare({compare: result, replacement: replacementRow}, {text});
  raw('③ 干净产出的审计', {ok: clean.ok, problems: auditText(clean)});
  assert.equal(clean.ok, true);

  // ③-1 直接写一个「胜率」字段
  const winRate = clone(result);
  winRate.axes.environment_value.win_rate = 0.62;
  let audit = auditTeamCompare({compare: winRate, replacement: replacementRow}, {text});
  raw('③ 产出里出现 win_rate 键', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.environment_value.win_rate', '产出里加一个 win_rate: 0.62 的键',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // ③-2 把量纲写成百分数（这就是「伪精确」的藏身处）
  const unitPct = clone(result);
  unitPct.axes.coverage_confidence.available = true;
  unitPct.axes.coverage_confidence.value = 0.5;
  unitPct.axes.coverage_confidence.value_numbers = [{name: 'value', unit: '胜率百分比（%）'}];
  audit = auditTeamCompare({compare: unitPct, replacement: replacementRow}, {text});
  raw('③ 量纲写成百分数', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.coverage_confidence.value_numbers[0].unit', '把量纲写成「胜率百分比（%）」',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // ③-3 渲染文本里写一句「胜率 62%」
  audit = auditTeamCompare({compare: result, replacement: replacementRow}, {text: `${text}\n结论：这套阵容的胜率 62%`});
  raw('③ 渲染文本里写胜率 62%', {ok: audit.ok, problems: auditText(audit)});
  proof('text', '渲染文本追加一句「这套阵容的胜率 62%」',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // ③-4 用社区榜单词（强势 / 必带）当依据
  const tierClaim = clone(result);
  tierClaim.axes.coverage_confidence.available = true;
  tierClaim.axes.coverage_confidence.value = 0.5;
  tierClaim.axes.coverage_confidence.unverified = ['这套配置属于强势梯队，必带'];
  audit = auditTeamCompare({compare: tierClaim, replacement: replacementRow}, {text});
  raw('③ 用榜单词当依据', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // 反向控制：声明边界的句子（「不许输出胜率」）**不能**被判红，否则实现方会把这句话删掉
  const boundary = clone(result);
  boundary.axes.coverage_confidence.unverified = ['未核实：本模块不是胜率榜，也不给强度分'];
  audit = auditTeamCompare({compare: boundary, replacement: replacementRow}, {text});
  raw('③ 反向控制：声明边界的句子', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, true, '③ 声明边界的句子必须放行（否则判据在逼人删掉最该留的一句）');
});

test('RC-304 判据④（反向控制）：注入 measured 分布后前四轴必须真的亮起来', () => {
  const result = compare('rc304-six-a', 'rc304-six-b', MEASURED);
  const replacementRow = replacement('rc304-six-a', MEASURED);
  const text = renderCompareText({...result, replacement: replacementRow});
  raw('④ 注入 measured 分布后的五轴可用性', result.availability);
  for (const axisId of DISTRIBUTION_AXES) {
    assert.equal(result.axes[axisId].available, true,
      `④ 注入 measured 分布后 ${axisId} 必须 available:true（恒 unknown 也是骗人）`);
    assert.notEqual(result.axes[axisId].value, null);
    assert.equal(result.axes[axisId].unknown_reason, null);
  }
  assert.equal(result.axes.coverage_confidence.available, true);

  // 值真的来自注入分布：逐队与判据独立重算的加权均值对账
  const rows = resolveDistribution(MEASURED).entries.map((row, index) => ({
    ...row, weight: resolveDistribution(MEASURED).weights[index],
  }));
  const envMean = weightedMean(rows.map((row) => ({value: row.weight, relative_score: row.relative_score})), 'relative_score');
  const tolMean = weightedMean(rows.map((row) => ({value: row.weight, tolerance: row.tolerance})), 'tolerance');
  const spread = Number((Math.max(...rows.map((row) => row.relative_score))
    - Math.min(...rows.map((row) => row.relative_score))).toFixed(6));
  const worst = [...rows].sort((a, b) => (a.relative_score - b.relative_score))[0];
  proof('（反向控制的正向）compare.axes[*].available',
    '注入带来源的 measured 对照样例（**不改坏**）', STRUCTURAL_CRITERIA.measured_lights_up,
    '五轴全部 available:true（不含 coverage_confidence 的注入依赖）',
    JSON.stringify({availability: result.availability, environment_value: result.axes.environment_value.value,
      matchup_spread: result.axes.matchup_spread.value, execution_tolerance: result.axes.execution_tolerance.value,
      worst_archetype: result.axes.worst_archetype.value?.archetype_id, environment_value_expected: envMean}));
  raw('④ 注入分布下的实测值（判据独立重算）', {
    environment_value_expected: envMean, execution_tolerance_expected: tolMean,
    matchup_spread_expected: spread, worst_archetype_expected: worst.archetype_id,
    axis_value: result.axes.environment_value.value,
  });
  assert.equal(result.axes.environment_value.value, envMean);
  assert.equal(result.axes.execution_tolerance.value, tolMean);
  assert.equal(result.axes.matchup_spread.value, spread);
  assert.equal(result.axes.worst_archetype.comparison.value.delta !== null, true);
  for (const teamId of ['rc304-six-a', 'rc304-six-b']) {
    assert.equal(result.axes.environment_value.teams[teamId].value, envMean, '④ 每队在这一轴上的值就是加权均值');
    assert.equal(result.axes.worst_archetype.teams[teamId].value.archetype_id, worst.archetype_id);
  }
  // 必红：把某一轴整体退回 unknown（值、量纲、unknown_reason、confidence 一起改），
  // 却仍报 measured —— 一个「改了一半」的产出必须被拦下。
  const mutated = clone(result);
  mutated.distribution.kind = 'measured';
  mutated.axes.environment_value.available = false;
  mutated.axes.environment_value.value = null;
  mutated.axes.environment_value.value_numbers = [];
  mutated.axes.environment_value.unknown_reason = '（变异体：假装不知道）';
  mutated.axes.environment_value.confidence = 'UNKNOWN';
  const audit = auditTeamCompare({compare: mutated, replacement: replacementRow}, {text});
  raw('④ measured 分布下某轴仍 unknown 的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.environment_value', '注入 measured 分布，却把这一轴整体退回 unknown',
    STRUCTURAL_CRITERIA.measured_lights_up, 'MEASURED_NOT_WIRED', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'MEASURED_NOT_WIRED'));

  // 另一条必红方向：整份分布标 measured，却一条 value / relative_score 都没有
  const emptyMeasured = clone(result);
  emptyMeasured.distribution.archetypes = emptyMeasured.distribution.archetypes.map((row) => ({
    ...row, value: null, relative_score: null,
  }));
  const auditEmpty = auditTeamCompare({compare: emptyMeasured, replacement: replacementRow}, {text});
  raw('④ 空的 measured 分布', {ok: auditEmpty.ok, problems: auditText(auditEmpty)});
  proof('compare.distribution.archetypes', '整份分布标 measured，却把每条 value / relative_score 清成 null',
    STRUCTURAL_CRITERIA.measured_lights_up, 'MEASURED_NOT_WIRED', auditRaw(auditEmpty));
  assert.equal(auditEmpty.ok, false);
  assert.ok(auditEmpty.problems.some((p) => p.code === 'MEASURED_NOT_WIRED'));

  const clean = auditTeamCompare({compare: result, replacement: replacementRow}, {text});
  assert.equal(clean.ok, true, `④ 原始 measured 产出必须干净：${auditText(clean).join(' | ')}`);
});

test('RC-304 判据⑤：coverage_confidence 必须真算（无 build 数据的实体不许报高置信）', () => {
  const result = compare('rc304-six-a', 'rc304-six-c');
  const coverage = result.axes.coverage_confidence;
  raw('⑤ 覆盖置信（两队的实测值）', {
    value: coverage.value, confidence: coverage.confidence,
    parts: coverage.value_parts, weakest_part: coverage.weakest_part,
    unverified: coverage.unverified,
  });
  assert.equal(coverage.available, true, '⑤ 覆盖置信是唯一现在能算的一轴');
  assert.ok(Number.isFinite(coverage.value) && coverage.value > 0 && coverage.value <= 1);
  assert.ok(CONFIDENCE_LEVELS.includes(coverage.confidence));
  assert.ok(Object.keys(coverage.value_parts).length > 0);

  // 反向：把成员的 build 数据全部抽掉 ⇒ 覆盖置信必须**更低**（说明它真的来自 build 数据）
  const degraded = clone(gapsByTeam);
  for (const teamId of Object.keys(degraded)) {
    degraded[teamId] = {
      ...degraded[teamId],
      gaps: degraded[teamId].gaps.map((gap) => {
        if (gap.id === 'cost.build_support') {
          return {...gap, value: {...gap.value, validated_members: 0, unvalidated_members: []}};
        }
        if (gap.id === 'energy.build_curve') return {...gap, value: {...gap.value, members: []}};
        return gap;
      }),
    };
  }
  const degradedResult = compareTeams({
    teamA: teamRef('rc304-six-a'), teamB: teamRef('rc304-six-c'), metaPrior: prior, gapsByTeam: degraded,
  });
  proof('compare.axes.coverage_confidence.value', '把成员的 build 数据整体抽掉（cost.build_support 与 energy.build_curve 一起清空）',
    STRUCTURAL_CRITERIA.coverage_from_build, '覆盖置信必须变低（否则它没读 build 数据）',
    JSON.stringify({before: coverage.value, after: degradedResult.axes.coverage_confidence.value}));
  raw('⑤ 抽掉 build 数据后的覆盖置信', {
    before: coverage.value, after: degradedResult.axes.coverage_confidence.value,
    after_parts: degradedResult.axes.coverage_confidence.value_parts,
  });
  assert.ok(degradedResult.axes.coverage_confidence.value < coverage.value,
    '⑤ 注入更差的 build ⇒ 覆盖置信必须更低（否则它根本没读 build 数据）');

  // 必红：可用却缺分项 / 最弱因子（那就不是「自我描述」了）
  const noParts = clone(result);
  delete noParts.axes.coverage_confidence.value_parts;
  let audit = auditTeamCompare({compare: noParts, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('⑤ 覆盖置信缺 value_parts', {ok: audit.ok, problems: auditText(audit)});
  proof('compare.axes.coverage_confidence.value_parts', '可用轴删掉 value_parts',
    STRUCTURAL_CRITERIA.coverage_from_build, 'COVERAGE_NOT_FROM_BUILD', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'COVERAGE_NOT_FROM_BUILD'));

  const noWeakest = clone(result);
  delete noWeakest.axes.coverage_confidence.weakest_part;
  audit = auditTeamCompare({compare: noWeakest, replacement: replacement('rc304-six-a')}, {text: 'skip'});
  raw('⑤ 覆盖置信缺 weakest_part', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'COVERAGE_NOT_FROM_BUILD'));

  // 没有注入缺口诊断时 fail closed（不报 0 覆盖）
  const bare = compareTeams({teamA: teamRef('rc304-six-a'), teamB: teamRef('rc304-six-c'), metaPrior: prior});
  raw('⑤ 没有注入 gapsByTeam 时的覆盖置信', {
    available: bare.axes.coverage_confidence.available,
    value: bare.axes.coverage_confidence.value,
    unknown_reason: bare.axes.coverage_confidence.unknown_reason,
  });
  assert.equal(bare.axes.coverage_confidence.available, false);
  assert.equal(bare.axes.coverage_confidence.value, null);
  assert.equal(bare.axes.coverage_confidence.unknown_reason, FAIL_CLOSED_REASONS.NO_GAP_DIAGNOSIS);
});

test('RC-304 判据⑥：在线导出段出现引擎 / 子进程调用必须判红', () => {
  const section = onlineSectionOf(SOURCE);
  const hits = scanForbiddenPatterns(section);
  raw('⑥ 在线段的禁止模式命中', {scanned_lines: section.split('\n').length, hits});
  assert.equal(hits.length, 0, `⑥ 在线段不许出现 ${FORBIDDEN_ONLINE_PATTERNS.map((p) => p.pattern).join('/')}`);
  assert.equal(auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b')}, {source: SOURCE}).ok, true);

  // 必红①：在线段里插一行引擎调用
  const engineBroken = `${SOURCE.replace(ONLINE_SECTION_MARKER,
    `const leak = () => engine.step_joint();\n${ONLINE_SECTION_MARKER}`)}`;
  let audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b')}, {source: engineBroken});
  raw('⑥ 在线段里插 step_joint 之后的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('src/coach/team-compare.mjs（在线段）', '在线段插入 engine.step_joint()',
    STRUCTURAL_CRITERIA.online_no_engine, 'ONLINE_ENGINE_CALL', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'ONLINE_ENGINE_CALL'));

  // 必红②：在线段里插一行子进程调用
  const spawnBroken = `${SOURCE.replace(ONLINE_SECTION_MARKER,
    `const run = () => import('node:child_process');\n${ONLINE_SECTION_MARKER}`)}`;
  audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b')}, {source: spawnBroken});
  raw('⑥ 在线段里插 child_process 之后的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('src/coach/team-compare.mjs（在线段）', "在线段插入 import('node:child_process')",
    STRUCTURAL_CRITERIA.online_no_engine, 'ONLINE_SUBPROCESS_CALL', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'ONLINE_SUBPROCESS_CALL'));

  // 必红③：离线入口出现在在线段里
  const offlineBroken = `${SOURCE.replace(ONLINE_SECTION_MARKER,
    `const boot = () => loadTeamCompareInputs();\n${ONLINE_SECTION_MARKER}`)}`;
  audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b')}, {source: offlineBroken});
  raw('⑥ 离线入口出现在在线段', {ok: audit.ok, problems: auditText(audit)});
  proof('src/coach/team-compare.mjs（在线段）', '在线段调用离线入口 loadTeamCompareInputs',
    STRUCTURAL_CRITERIA.online_no_engine, 'OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION'));

  // 在线导出清单与离线段都不含对方的名字
  raw('⑥ 在线 / 离线入口清单', {online: ONLINE_ENTRYPOINTS, offline: OFFLINE_ENTRYPOINTS.map((row) => row.id)});
  for (const entry of OFFLINE_ENTRYPOINTS) {
    assert.ok(!ONLINE_ENTRYPOINTS.includes(entry.id), `⑥ ${entry.id} 同时出现在在线与离线清单里`);
    assert.ok(offlineSectionOf(SOURCE).includes(entry.id), `⑥ 离线入口 ${entry.id} 必须在离线段之后`);
  }
  assert.ok(!section.includes('loadTeamCompareInputs'));
});

test('RC-304 判据⑦：minimalReplacement 必须恰好一个方案且带 why', () => {
  const candidates = candidatesFor('rc304-six-a');
  const row = replacement('rc304-six-a', prior, candidates);
  raw('⑦ 分布 unknown 时的最小替换原文', row);
  assert.ok(row.replacement === null || !Array.isArray(row.replacement), '⑦ 不许返回数组式多方案');
  assert.equal(typeof row.why, 'string');
  assert.ok(row.why.length > 0, '⑦ 必须带 why');
  assert.equal(row.confirmed_by_distribution, false, '⑦ 分布 unknown 时不许说结论已确认');
  assert.ok(/不知道/u.test(row.why), '⑦ 分布 unknown 时必须明说不知道换谁更强');
  assert.ok(row.evidence.length > 0);
  assert.equal(row.replacement.out.key.length > 0, true);
  assert.equal(row.replacement.in.key.length > 0, true);

  // 必红①：返回多方案的数组
  const multi = clone(row);
  multi.replacement = [clone(row.replacement), clone(row.replacement)];
  let audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b'), replacement: multi}, {text: 'skip'});
  raw('⑦ 返回多方案之后的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('replacement.replacement', '把最小替换改成两个方案的数组',
    STRUCTURAL_CRITERIA.one_replacement, 'REPLACEMENT_SHAPE', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'REPLACEMENT_SHAPE'));

  // 必红②：没有 why
  const noWhy = clone(row);
  noWhy.why = '';
  audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b'), replacement: noWhy}, {text: 'skip'});
  raw('⑦ 没有 why 之后的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('replacement.why', '把 why 清成空字符串',
    STRUCTURAL_CRITERIA.one_replacement, 'REPLACEMENT_SHAPE', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'REPLACEMENT_SHAPE'));

  // 必红③：一次换两只
  const twoOut = clone(row);
  twoOut.replacement.out = [row.replacement.out, {key: 'instance:own-9999'}];
  audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b'), replacement: twoOut}, {text: 'skip'});
  raw('⑦ 一次换两只之后的审计', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'REPLACEMENT_SHAPE'));

  // 必红④：分布 unknown 却宣称「已确认更优」
  const overclaim = clone(row);
  overclaim.confirmed_by_distribution = true;
  overclaim.why = '换上它更好，收益最大';
  audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-b'), replacement: overclaim}, {text: 'skip'});
  raw('⑦ 分布 unknown 却宣称更优的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('replacement.confirmed_by_distribution', '分布 unknown 却写 confirmed_by_distribution: true + why「换上它更好」',
    STRUCTURAL_CRITERIA.replacement_honesty, 'REPLACEMENT_OVERCLAIM', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'REPLACEMENT_OVERCLAIM'));

  // 没有候选时也必须给 why（明确说不知道），不许编一个方案
  const noCandidates = replacement('rc304-six-a', prior, []);
  raw('⑦ 没有注入候选时的最小替换', noCandidates);
  assert.equal(noCandidates.replacement, null);
  assert.ok(/不知道|给不出/u.test(noCandidates.why));

  const clean = auditTeamCompare({
    compare: compare('rc304-six-a', 'rc304-six-b'), replacement: row,
  }, {text: renderCompareText({...compare('rc304-six-a', 'rc304-six-b'), replacement: row})});
  assert.equal(clean.ok, true, `⑦ 原始最小替换审计必须干净：${auditText(clean).join(' | ')}`);
});

test('RC-304 判据⑧：两次运行必须逐字节相同（含 tie-break）', () => {
  const candidates = candidatesFor('rc304-six-a');
  const runs = [0, 1].map(() => {
    const compareRow = compare('rc304-six-a', 'rc304-six-d');
    const measuredRow = compare('rc304-six-a', 'rc304-six-d', MEASURED);
    const replacementRow = replacement('rc304-six-a', prior, candidates);
    const tieRow = replacement('rc304-six-a', prior, TIE_CANDIDATES);
    return {
      compare: JSON.stringify(compareRow),
      measured: JSON.stringify(measuredRow),
      replacement: JSON.stringify(replacementRow),
      tie: JSON.stringify(tieRow),
      text: renderCompareText({...compareRow, replacement: replacementRow}),
    };
  });
  raw('⑧ 第一次运行（截断）', {compare: runs[0].compare.slice(0, 160), tie: runs[0].tie.slice(0, 160)});
  assert.equal(runs[0].compare, runs[1].compare, '⑧ compareTeams 两次运行必须逐字节相同');
  assert.equal(runs[0].measured, runs[1].measured);
  assert.equal(runs[0].replacement, runs[1].replacement, '⑧ minimalReplacement 两次运行必须逐字节相同');
  assert.equal(runs[0].tie, runs[1].tie, '⑧ tie-break 两次运行必须相同');
  assert.equal(runs[0].text, runs[1].text);
  const tie = JSON.parse(runs[0].tie);
  raw('⑧ tie-break 的实际选择', tie.replacement);
  assert.equal(tie.replacement.in.key, 'cand:aaa', '⑧ 同分时必须按 key 字典序固定选一个');

  // 必红：把第二次运行改成不一致
  const mutated = clone(compare('rc304-six-a', 'rc304-six-d'));
  mutated.axes.environment_value.value = 0.99;
  const audit = auditTeamCompare({compare: compare('rc304-six-a', 'rc304-six-d'), replacement: replacement('rc304-six-a', prior, candidates)},
    {snapshot: {compare: mutated, replacement: null, text: null}, text: 'x'});
  raw('⑧ 两次运行不一致的审计', {ok: audit.ok, problems: auditText(audit)});
  proof('compareTeams 的两次运行', '把第二次运行的结果改掉一个值',
    STRUCTURAL_CRITERIA.deterministic, 'NONDETERMINISTIC', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'NONDETERMINISTIC'));
});

// ─────────────────────────────────────────────────────────────────────────
// 钉住「哪些是真的」：覆盖置信的比例口径、证据只指向注入或真实文件、报告可复跑
// ─────────────────────────────────────────────────────────────────────────

test('RC-304 结构：证据只指向注入数据或仓内真实文件；五轴的判据文本齐全', () => {
  const results = PAIRS.map(([a, b]) => compare(a, b));
  const sources = [...new Set(results.flatMap((row) => AXIS_IDS
    .flatMap((axisId) => row.axes[axisId].evidence.map((item) => item.source_file))))];
  raw('结构：产出里引用到的证据来源', sources);
  for (const source of sources) {
    if (source.startsWith('injected:')) continue;
    assert.ok(existsSync(join(ROOT, source)), `结构：证据来源 ${source} 既不是 injected: 也不是仓内真实文件`);
  }
  for (const axisId of AXIS_IDS) {
    const axis = results[0].axes[axisId];
    assert.ok(typeof axis.criteria === 'string' && axis.criteria.length > 0, `结构：${axisId} 缺判据文本`);
    assert.ok(typeof axis.definition === 'string' && axis.definition.length > 0);
    assert.ok(axis.evidence.length > 0);
    assert.ok(Array.isArray(axis.unverified) && axis.unverified.length > 0);
  }
  // 恒等约束：相对分必须落在声明的量程里；排序器状态必须命中枚举（不是自由字符串）
  const relativeAxes = ['environment_value', 'matchup_spread', 'execution_tolerance'];
  const relativeValues = PAIRS.map(([a, b], index) => ({pair: `${a}/${b}`,
    values: Object.fromEntries(relativeAxes.map((axisId) => [axisId,
      results[index].axes[axisId].teams[a]?.value ?? null]))}));
  raw('结构：相对分实测值（与声明的量程对账）', relativeValues);
  for (const row of relativeValues) {
    for (const [axisId, value] of Object.entries(row.values)) {
      if (typeof value !== 'number') continue;
      assert.ok(value >= RELATIVE_SCORE_RANGE.min && value <= RELATIVE_SCORE_RANGE.max,
        `结构：${row.pair} 的 ${axisId} = ${value} 越出 [${RELATIVE_SCORE_RANGE.min}, ${RELATIVE_SCORE_RANGE.max}]`);
    }
  }
  for (const [index, row] of results.entries()) {
    assert.ok(RANKER_STATUSES.includes(row.ranker.status),
      `结构：第 ${index} 组的 ranker.status ${row.ranker.status} 不在 ${RANKER_STATUSES.join('/')}`);
  }
  // 五轴 ID 与 13 号文档 §4 的对应关系必须写清楚（不改名、不合并）
  raw('结构：五轴映射', AXES.map((axis) => ({axis: axis.id, prior_field: axis.prior_field, label: axis.label})));
  assert.deepEqual(AXIS_IDS, ['environment_value', 'worst_archetype', 'matchup_spread',
    'execution_tolerance', 'coverage_confidence']);
  assert.equal(AXES.find((axis) => axis.id === 'environment_value').prior_field, 'expected_meta_value');
});

test('RC-304 结构：对每支队伍都能给出结论，≥6 组两两比较全部可审计', () => {
  const rows = PAIRS.map(([a, b]) => {
    const compareRow = compare(a, b);
    const replacementRow = replacement(a, prior, candidatesFor(a));
    const text = renderCompareText({...compareRow, replacement: replacementRow});
    const audit = auditTeamCompare({compare: compareRow, replacement: replacementRow}, {source: SOURCE, text});
    return {
      teams: [a, b],
      availability: compareRow.availability,
      coverage: compareRow.axes.coverage_confidence.value,
      ranker: compareRow.ranker,
      replacement: replacementRow.replacement === null ? null
        : `${replacementRow.replacement.out.key} → ${replacementRow.replacement.in.key}`,
      audit_ok: audit.ok,
      problems: auditText(audit),
    };
  });
  raw('结构：全部两两比较的实际输出', rows);
  assert.ok(rows.length >= 6, `结构：至少 6 组两两比较，实际 ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.audit_ok, true, `结构：${row.teams.join(' vs ')} 审计必须干净`);
    assert.equal(row.availability.coverage_confidence, true);
    assert.equal(row.availability.environment_value, false, '结构：真实数据下前四轴必须 unknown');
  }
  assert.ok(rows.some((row) => row.replacement !== null), '结构：至少要有一支队伍能给出结构性的最小替换');
});

test('RC-304 报告：磁盘上的 rc-304-team-compare.json 与生成逻辑逐字节一致', () => {
  const report = buildRc304Report({
    inputs, metaPrior: prior, teams: teamRows, pairings: PAIRS,
    candidates: candidatesFor('rc304-six-a'), measured: MEASURED, source: SOURCE,
    red_proofs: RED_PROOFS,
  });
  const diskPath = join(ROOT, RC304_REPORT_PATH);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RC304_WRITE_REPORT === '1' || !existsSync(diskPath)) {
    writeFileSync(diskPath, text, 'utf8');
  }
  const disk = readFileSync(diskPath, 'utf8');
  raw('报告：五轴当前可用性', report.availability_now);
  raw('报告：unknown 逐条原因', report.unknown_reasons.map((row) => `${row.axis}: ${row.unknown_reason}`));
  raw('报告：measured 对照样例', report.measured_control_sample?.values ?? '未注入对照样例');
  raw('报告：判据逐条', report.criteria.map((row) => `${row.ok ? 'PASS' : 'FAIL'} ${row.label}`));
  assert.equal(disk, text, `报告不一致：跑 RC304_WRITE_REPORT=1 node --test tests/roco-team-compare.test.js 重写`);
  assert.equal(report.availability_now.available.length, 1, '报告：现在恰好一轴可用');
  assert.deepEqual(report.availability_now.available, ['coverage_confidence']);
  assert.equal(report.availability_now.unknown.length, 4);
  for (const row of report.unknown_reasons.filter((item) => item.axis !== 'coverage_confidence')) {
    assert.ok(row.unknown_reason.length > 0);
  }
  assert.ok(report.measured_control_sample !== null, '报告必须带 measured 对照样例');
  assert.equal(report.measured_control_sample.availability.environment_value, true);
  assert.equal(report.measured_control_sample.environment_value_matches_weighted_mean, true);
  assert.ok(report.comparisons.length >= 6, '报告：至少 6 组真实两两比较');
  for (const row of report.comparisons) {
    assert.equal(row.audit_ok, true,
      `报告：${row.teams.join(' vs ')} 的审计必须干净：${row.audit_problems.join(' | ')}`);
  }
  assert.equal(report.measured_control_sample.audit_ok, true);
  assert.equal(report.criteria.every((row) => row.ok), true,
    `报告：每条判据都必须通过：${report.criteria.filter((row) => !row.ok).map((row) => row.label).join(' / ')}`);
  assert.ok(report.does_not_do.length >= 3, '报告必须写清「这份比较不能用来做什么」');
  assert.ok(report.red_proofs.length >= 8, `报告必须留痕 ≥8 条反证的实际输出原文，实际 ${report.red_proofs.length}`);
  for (const row of report.red_proofs) {
    assert.ok(typeof row.actual === 'string' && row.actual.length > 0,
      `反证 ${row.where} 缺「实际输出原文」`);
  }
  for (const row of report.criteria) {
    if (row.label.includes('measured') || row.label.includes('加权均值') || row.label.includes('前四轴')) {
      assert.equal(row.ok, true, `报告判据必须通过：${row.label}（实际 ${JSON.stringify(row.actual)}）`);
    }
  }
});

test('RC-304 边界：audit 扫描口径可切换，且保留 RC-303 的否定语境豁免', () => {
  const compareRow = compare('rc304-six-a', 'rc304-six-b');
  // offline 段里出现 child_process 不算在线违规（口径是 online）
  const offlineOnly = `${SOURCE}\nconst spawnForOffline = () => import('node:child_process');`;
  const online = auditTeamCompare({compare: compareRow}, {source: offlineOnly, scope: 'online'});
  raw('边界：只在离线段出现子进程（online 口径）', {ok: online.ok, problems: auditText(online)});
  assert.equal(online.ok, true);
  const whole = auditTeamCompare({compare: compareRow}, {source: offlineOnly, scope: 'whole'});
  raw('边界：同一份源码用 whole 口径扫', {ok: whole.ok, problems: auditText(whole)});
  assert.equal(whole.ok, false);
  // 直接写胜率仍然红（否定语境不能豁免键名与数值）
  const claims = collectClaimText({compare: compareRow});
  raw('边界：claims 投影的键', Object.keys(claims));
  assert.ok(!JSON.stringify(claims).includes('%'));
  assert.ok(STRUCTURAL_CRITERIA.no_pseudo_precision.includes('PSEUDO_PRECISION'));
});

test('RC-304 报告：buildRc304Report 是纯函数（两次调用逐字节相同）', () => {
  const args = () => ({
    inputs, metaPrior: prior, teams: teamRows, pairings: PAIRS,
    candidates: candidatesFor('rc304-six-a'), measured: MEASURED, source: SOURCE,
    red_proofs: RED_PROOFS,
  });
  const first = JSON.stringify(buildRc304Report(args()));
  const second = JSON.stringify(buildRc304Report(args()));
  raw('报告可复跑', {first_length: first.length, second_length: second.length, identical: first === second});
  assert.equal(first, second);
  // 报告里不许出现胜率 / 百分数 / 榜单词（扫的是值承载字段 + 全部 criteria 之外的正文）
  const hits = [];
  const scan = (value, path) => {
    if (typeof value === 'string') {
      for (const word of [...BANNED_CLAIM_WORDS, ...BANNED_UNIT_WORDS]) {
        const at = value.indexOf(word);
        if (at < 0) continue;
        const window = value.slice(Math.max(0, at - 18), at);
        if (['不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '不知道', '不产出', '不预测']
          .some((marker) => window.includes(marker))) continue;
        // 跳过**判据正文的引用副本**与**反证留痕里的实际输出原文**：
        //   · criteria / definition / criterion / structural / does_not_do：判据正文必须能写「这不是胜率」；
        //   · audit_problems / red_proofs[].actual / expect_code：那里贴的是判据正文与被改坏的产出原文，
        //     不是本模块给出的结论。字段名本身（键名）不受豁免（见下面的键名检查）。
        if (path.includes('criteria') || path.includes('definition') || path.includes('does_not_do')
          || path.includes('audit_problems') || path.includes('.criterion')
          || path.includes('.structural') || path.includes('value_parts')
          || path.includes('red_proofs') || path.includes('expect_code')) continue;
        hits.push({path, word});
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`));
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (BANNED_CLAIM_KEYS.includes(key)) hits.push({path: `${path}.${key}`, word: '键名'});
        scan(item, `${path}.${key}`);
      }
    }
  };
  // 反证留痕里的 `mutation` / `criterion` 是对**测试动作**的描述（那句「量纲写成胜率百分比%」就是改坏描述），
  // 不是模块给出的结论，所以扫描时只保留 `expect_code` 与 `actual`（实际输出原文）。
  const scanBody = (value) => {
    const shaped = JSON.parse(JSON.stringify(value));
    shaped.red_proofs = shaped.red_proofs.map((row) => ({
      where: row.where, expect_code: row.expect_code, actual: row.actual,
    }));
    return shaped;
  };
  scan(scanBody(buildRc304Report(args())), 'report');
  raw('报告伪精确扫描命中', hits);
  raw('报告反证留痕条数', RED_PROOFS.length);
  assert.deepEqual([...new Set(hits.map((row) => row.word))], []);
});
