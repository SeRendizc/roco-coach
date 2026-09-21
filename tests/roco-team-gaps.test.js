// RC-302 阵容缺口诊断的守卫。
//
// 这一组判据要证明的是**诊断有没有牙**，而不是「输出里字段齐不齐」。每条反证都先把
// 正确输出**改坏**，再喂回 `auditGapDiagnosis()`，必须变红；并把**实际输出原文**打出来
// （报告里逐条引用这些行）：
//   ① 某条 gap 抹掉 machine_evidence          ⇒ 红（EVIDENCE_MISSING）
//   ② confidence 用了台账之外的等级           ⇒ 红（CONFIDENCE_NOT_IN_LEDGER）
//   ③ 只有 48 只有值的量说成「全 622 都知道」 ⇒ 红（DOMAIN_OVERCLAIM，两条子判据：域计数 + 文本断言）
//   ④ 给出伪精确胜率/强度分                   ⇒ 红（PSEUDO_PRECISION）
//   ⑤ must_include 不可满足却返回 ok:true     ⇒ 红（UNSATISFIABLE_NOT_FAILED）
//   ⑥ 用社区榜单词（T0/强势/必带）当依据      ⇒ 红（COMMUNITY_TIER_LABEL）
//   ⑦ 台账 UNKNOWN 的量被写成确定结论         ⇒ 红（UNKNOWN_ESCALATED，两条子判据：升级严重度 + 不点名）
//   ⑧ 同一输入两次运行结果不一致              ⇒ 红（本测试直接比对两次的逐字节输出）
// 另外钉住：七个维度都有判据、80 个实例上的分布可复跑、报告与生成逻辑逐字节一致、
// 以及 RC-301 与 RC-302 的边界（合同合法 ≠ 约束可满足）。
//
// 用法：`node --test tests/roco-team-gaps.test.js`
//       `RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js`（重新生成报告）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  AUDIT_RULES, CONFIDENCE_LEVELS, DIMENSIONS, FROZEN_PATHS, RC302_REPORT_PATH, SEVERITIES,
  SAMPLE_SHAPES, auditGapDiagnosis, buildGapDistribution, buildGapIndex, buildRc302Report,
  costSatisfiability, diagnoseTeamGaps, formatGapProblem, ledgerQuantities, loadTeamGapsInputs,
} from '../src/coach/team-gaps.js';
import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, formatProblem, loadRecommendationInputs,
  validateRecommendationRequest,
} from '../src/coach/team-request.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const log = (...args) => console.log('  ·', ...args);

/** 每条反证打印**实际输出原文**：报告里贴的就是这些行。 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

const inputs = await loadTeamGapsInputs({root: ROOT});
const rc301Inputs = await loadRecommendationInputs({root: ROOT});
const registry = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, rc301Inputs).registry;
const ids = [...registry.instances.keys()].sort();
const favouriteIds = [...registry.instances.values()].filter((i) => i.favourite === true)
  .map((i) => i.instance_id).sort();

const base = () => ({mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE});
const diagnose = (patch) => diagnoseTeamGaps({...base(), ...patch}, inputs);
const clone = (value) => JSON.parse(JSON.stringify(value));
/** 把审计结果里每条问题打印出来，报告里逐条引用的就是这些行。 */
const auditText = (result) => result.problems.map((p) => `[${p.code}] ${p.where}：${p.detail}`);
const expectRed = (diagnosis, code, label) => {
  const result = auditGapDiagnosis(diagnosis, {ledger: inputs.ledger});
  raw(label, {audit_ok: result.ok, problems: auditText(result)});
  assert.equal(result.ok, false, `${label}：改坏之后审计必须判红`);
  assert.ok(result.problems.some((p) => p.code === code),
    `${label}：期望出现 ${code}，实际 ${result.problems.map((p) => p.code).join('/')}`);
  return result;
};
/** 一条真实诊断（六只，全部命中验证层），作为反证的基线。 */
const baselineDiagnosis = () => diagnose({selected: ids.slice(0, 6)});
const gapIndexById = (diagnosis, id) => diagnosis.gaps.findIndex((g) => g.id === id);

// ─────────────────────────────────────────────────────────────────────────
// ①～⑧ 必红反证
// ─────────────────────────────────────────────────────────────────────────

test('RC-302 判据①：gap 抹掉 machine_evidence 必须判红（没有证据的结论不许出现）', () => {
  const diagnosis = baselineDiagnosis();
  assert.ok(diagnosis.gaps.length > 0);
  const broken = clone(diagnosis);
  broken.gaps[0].machine_evidence = [];
  raw('① 被抹掉证据的那条 gap', {id: broken.gaps[0].id, machine_evidence: broken.gaps[0].machine_evidence});
  expectRed(broken, 'EVIDENCE_MISSING', '① 抹掉 machine_evidence');

  // 反向控制：原始输出里**每条** gap 都有可指向文件+指针+字段的证据
  const evidence = diagnosis.gaps.map((g) => ({
    id: g.id, count: g.machine_evidence.length,
    sample: `${g.machine_evidence[0].source_file}#${g.machine_evidence[0].pointer}.${g.machine_evidence[0].field}`,
  }));
  raw('① 原始输出的证据条数（逐条）', evidence);
  assert.ok(evidence.every((row) => row.count > 0 && row.sample.includes('#')));
  // 证据项缺字段也要红
  const thin = clone(diagnosis);
  delete thin.gaps[1].machine_evidence[0].pointer;
  expectRed(thin, 'EVIDENCE_MISSING', '① 证据项缺 pointer');
});

test('RC-302 判据②：confidence 用了台账之外的等级必须判红', () => {
  const diagnosis = baselineDiagnosis();
  raw('② 原始输出的置信等级分布', diagnosis.gaps.reduce((acc, g) => {
    acc[g.confidence] = (acc[g.confidence] ?? 0) + 1;
    return acc;
  }, {}));
  assert.ok(diagnosis.gaps.every((g) => CONFIDENCE_LEVELS.includes(g.confidence)));
  const ledgerLevels = ledgerQuantities(inputs.ledger);
  assert.equal(ledgerLevels.problems.length, 0);
  for (const level of ['VERY_SURE', 'S_TIER', 'CONFIRMED', 'COMMUNITY_HOT']) {
    const broken = clone(diagnosis);
    broken.gaps[0].confidence = level;
    expectRed(broken, 'CONFIDENCE_NOT_IN_LEDGER', `② confidence=${level}`);
  }
  const brokenTotal = clone(diagnosis);
  brokenTotal.confidence = 'TOTALLY_FINE';
  expectRed(brokenTotal, 'CONFIDENCE_NOT_IN_LEDGER', '② 总置信用了台账外的等级');
});

test('RC-302 判据③：只有 48 只有值的量不许说成「全 622 都知道」', () => {
  const diagnosis = baselineDiagnosis();
  const speedIdx = gapIndexById(diagnosis, 'speed.validated_domain');
  assert.ok(speedIdx >= 0, '必须有一条 speed.validated_domain 来说明域上限');
  const real = diagnosis.gaps[speedIdx];
  raw('③ 原始速度域的实测值', {domain: real.domain, value: real.value, unverified: real.unverified});
  assert.deepEqual(real.domain, {basis: 'validated_layer', metric: 'speed_tier / stats.spe', known: 48, unknown: 574, total: 622});
  assert.equal(diagnosis.facts.pack_pet_entities, 622);
  assert.equal(diagnosis.facts.validated_species, 48);

  // ③a 域计数：把验证层说成全量
  const overclaim = clone(diagnosis);
  overclaim.gaps[speedIdx].domain = {basis: 'validated_layer', metric: 'speed_tier / stats.spe', known: 622, unknown: 0, total: 622};
  expectRed(overclaim, 'DOMAIN_OVERCLAIM', '③a 声称验证层已知 622 只');

  // ③b 文本断言：正文里写「全 622 只都登记了」
  const textClaim = clone(diagnosis);
  textClaim.gaps[speedIdx].why = '全 622 只的速度层次都已登记，可以据此排先后';
  expectRed(textClaim, 'DOMAIN_OVERCLAIM', '③b 正文声称全 622 都知道');

  // ③c 域计数不闭合
  const unclosed = clone(diagnosis);
  unclosed.gaps[speedIdx].domain = {basis: 'validated_layer', metric: 'speed_tier / stats.spe', known: 48, unknown: 622, total: 622};
  expectRed(unclosed, 'DOMAIN_OVERCLAIM', '③c known + unknown ≠ total');
});

test('RC-302 判据④：出现伪精确胜率/强度分必须判红', () => {
  const diagnosis = baselineDiagnosis();
  const json = JSON.stringify(diagnosis);
  raw('④ 原始输出里有没有胜率/强度分这类字段', {
    has_win_rate: /"win_rate"|"winrate"|"strength_score"|"tier"|"rating"/.test(json),
    confidence_levels_used: [...new Set(diagnosis.gaps.map((g) => g.confidence))],
  });
  assert.equal(/"win_rate"|"winrate"|"strength_score"|"tier"|"rating"/.test(json), false);

  const withField = clone(diagnosis);
  withField.gaps[0].value = {...withField.gaps[0].value, win_rate: 0.53};
  expectRed(withField, 'PSEUDO_PRECISION', '④ 塞进 win_rate 字段');

  const withPercent = clone(diagnosis);
  withPercent.gaps[0].why = '这套阵容的胜率是 62%，所以缺口不重要';
  expectRed(withPercent, 'PSEUDO_PRECISION', '④ 正文写胜率百分数');

  const withScore = clone(diagnosis);
  withScore.gaps[1].value = {...withScore.gaps[1].value, strength_score: 91};
  expectRed(withScore, 'PSEUDO_PRECISION', '④ 塞进 strength_score 字段');
});

test('RC-302 判据⑤：must_include 不可满足却返回 ok:true 必须判红', () => {
  const seven = diagnose({must_include: ids.slice(0, 7)});
  raw('⑤ 七只硬要求（六个槽位）的实际输出', {
    ok: seven.ok,
    problems: seven.problems.map(formatGapProblem),
    blocking: seven.gaps.filter((g) => g.severity === 'blocking').map((g) => ({id: g.id, why: g.why})),
  });
  assert.equal(seven.ok, false, '不可满足必须 fail closed');
  assert.ok(seven.problems.some((p) => p.code === 'UNSATISFIABLE_CONSTRAINTS'));
  assert.ok(seven.gaps.some((g) => g.severity === 'blocking'));

  const broken = clone(seven);
  broken.ok = true;
  broken.problems = [];
  expectRed(broken, 'UNSATISFIABLE_NOT_FAILED', '⑤ 把不可满足的结果改成 ok:true');

  // 反向：ok:false 却没有 blocking 依据也要红
  const fakeFail = clone(baselineDiagnosis());
  fakeFail.ok = false;
  fakeFail.problems = [{code: 'SOMETHING_ELSE', field: 'x', detail: '假的失败：没有任何 blocking 依据'}];
  raw('⑤ 假的失败（ok:false 但没有 blocking）', fakeFail.problems.map(formatGapProblem));
  expectRed(fakeFail, 'UNSATISFIABLE_NOT_FAILED', '⑤ ok:false 但没有 blocking 依据');
});

test('RC-302 判据⑥：用社区榜单词（T0/强势/必带）当依据必须判红', () => {
  const diagnosis = baselineDiagnosis();
  for (const phrase of ['T0 强势体系，必带', '这就是梯队第一', '版本之子，上分首选']) {
    const broken = clone(diagnosis);
    broken.gaps[0].why = `依据社区榜单：${phrase}`;
    expectRed(broken, 'COMMUNITY_TIER_LABEL', `⑥ 正文引用「${phrase}」`);
  }
  const asValue = clone(diagnosis);
  asValue.gaps[2].value = {...asValue.gaps[2].value, tier: 'T0'};
  expectRed(asValue, 'PSEUDO_PRECISION', '⑥ 在 value 里挂 tier: T0');
});

test('RC-302 判据⑦：台账 UNKNOWN 的量被写成确定结论必须判红', () => {
  const diagnosis = baselineDiagnosis();
  const speedIdx = gapIndexById(diagnosis, 'speed.turn_order_inference');
  assert.ok(speedIdx >= 0);
  const real = diagnosis.gaps[speedIdx];
  raw('⑦ 依赖 UNKNOWN 量的那条 gap（原始）', {
    id: real.id, severity: real.severity, confidence: real.confidence, depends_on: real.depends_on, unverified: real.unverified,
  });
  assert.equal(real.confidence, 'ENGINE_HYPOTHESIS');
  assert.ok(real.unverified.some((text) => text.includes('速度平手')));

  const escalated = clone(diagnosis);
  escalated.gaps[speedIdx].severity = 'high';
  expectRed(escalated, 'UNKNOWN_ESCALATED', '⑦a 把 UNKNOWN 的相关结论升级成 high');

  const letBlocking = clone(diagnosis);
  letBlocking.gaps[speedIdx].severity = 'blocking';
  expectRed(letBlocking, 'UNKNOWN_ESCALATED', '⑦b 把 UNKNOWN 的相关结论升级成 blocking');

  const silent = clone(diagnosis);
  silent.gaps[speedIdx].unverified = silent.gaps[speedIdx].unverified.filter((t) => !t.includes('速度平手'));
  expectRed(silent, 'UNKNOWN_ESCALATED', '⑦c 不点名那条 UNKNOWN 量');

  // 反向控制：真实输出里「速度平手 = UNKNOWN」被点名，且升级被 finalise 压住了
  raw('⑦ 原始输出里所有点到「速度平手」的 gap', diagnosis.gaps
    .filter((g) => g.unverified.some((t) => t.includes('速度平手'))).map((g) => ({id: g.id, severity: g.severity})));
  assert.ok(diagnosis.gaps.filter((g) => g.depends_on.includes('turn_order.priority'))
    .every((g) => g.unverified.some((t) => t.includes('速度平手'))));
});

test('RC-302 判据⑧：同一输入两次运行结果必须逐字节一致（顺序/浮点都稳）', () => {
  const req = {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, selected: ids.slice(0, 6)};
  const first = diagnoseTeamGaps(req, inputs);
  const second = diagnoseTeamGaps(req, inputs);
  raw('⑧ 两次运行的差异长度', {first: JSON.stringify(first).length, second: JSON.stringify(second).length});
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同一输入两次运行必须逐字节一致');

  // 顺序稳定性：selected 反过来给，结论必须一样（列表字段是集合，不是序列）
  const reversed = diagnoseTeamGaps({...req, selected: [...req.selected].reverse()}, inputs);
  assert.equal(JSON.stringify(reversed), JSON.stringify(first), 'selected 的顺序不许影响结论');

  // 输入不许被改写（诊断是纯函数）
  assert.deepEqual(req.selected, ids.slice(0, 6), '诊断不许修改请求对象');
  assert.equal(Object.hasOwn(req, 'gaps'), false);

  // 浮点稳定：倍率只用整数标度比较，输出里不许出现浮点残渣
  const json = JSON.stringify(first);
  raw('⑧ 输出里的浮点残渣（0.30000000000000004 这类）', json.match(/\d+\.\d{6,}/g));
  assert.equal(json.match(/\d+\.\d{6,}/g), null, '不许出现浮点残差');
  for (const g of first.gaps) {
    for (const scale of [g.value?.multiplier, ...(g.value?.weak_members ?? []).map((m) => m.multiplier)]) {
      if (typeof scale === 'number') assert.ok([0.25, 0.5, 1, 2, 3].includes(scale), `${scale} 不是 types.json 登记的四档倍率`);
    }
  }
  // 报告也必须逐字节可复跑
  const reportA = JSON.stringify(buildRc302Report(inputs));
  const reportB = JSON.stringify(buildRc302Report(inputs));
  assert.equal(reportA, reportB, '报告生成必须逐字节一致');
  assert.ok(reportA.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑨～⑭ 正向判据（钉住正确行为，防止「改坏了也绿」）
// ─────────────────────────────────────────────────────────────────────────

test('RC-302 判据⑨：七个维度都有可复算判据，真实输出全部自带证据与置信', () => {
  const diagnosis = baselineDiagnosis();
  const byDimension = DIMENSIONS.map((dimension) => ({
    dimension,
    gaps: diagnosis.gaps.filter((g) => g.dimension === dimension).length,
    severities: [...new Set(diagnosis.gaps.filter((g) => g.dimension === dimension).map((g) => g.severity))],
  }));
  raw('⑨ 七个维度的 gap 数与严重度', byDimension);
  assert.deepEqual(byDimension.map((row) => row.dimension), [...DIMENSIONS]);
  assert.ok(byDimension.every((row) => row.gaps > 0), '每个维度至少给一条 gap（哪怕只是 info/未知）');
  assert.ok(diagnosis.gaps.every((g) => SEVERITIES.includes(g.severity)));
  assert.ok(diagnosis.gaps.every((g) => typeof g.criteria === 'string' && g.criteria.length > 20));
  assert.ok(diagnosis.gaps.every((g) => CONFIDENCE_LEVELS.includes(g.confidence)));
  assert.ok(diagnosis.gaps.every((g) => Array.isArray(g.unverified)));
  assert.ok(diagnosis.evidence.length > 0, '顶层证据清单必须非空');
  const audit = auditGapDiagnosis(diagnosis, {ledger: inputs.ledger});
  raw('⑨ 真实输出的审计结果', {ok: audit.ok, problems: auditText(audit)});
  assert.equal(audit.ok, true);
  // 判据文本必须是「可复算」的：逐条打印出来，报告与文档引用同一份
  for (const dimension of DIMENSIONS) {
    const criteria = diagnosis.gaps.find((g) => g.dimension === dimension).criteria;
    assert.ok(criteria.length > 30, `${dimension} 的判据太短，不可复算`);
  }
  log(`审计规则 ${AUDIT_RULES.length} 条，每条都有必红方向`);
  assert.ok(AUDIT_RULES.every((rule) => rule.code && rule.direction));
});

test('RC-302 判据⑩：80 个实例上的分布可复跑（实测值）', () => {
  const distribution = buildGapDistribution(inputs);
  raw('⑩ 分布（每维度的关键实测值）', {
    instances: distribution.instances,
    coverage_resist_counts: distribution.coverage.attack_types.map((t) => `${t.attack_type}:${t.resist_count}/${t.weak_count}`),
    speed: {
      with_validated_spe: distribution.speed.instances_with_validated_spe,
      tiers: distribution.speed.speed_tier_histogram,
      validated_species: distribution.speed.validated_species,
      knowledge_only_species: distribution.speed.knowledge_only_species,
    },
    energy: {
      without_zero_cost: distribution.energy.instances_without_zero_cost_move,
      over_legacy_cap: distribution.energy.moves_over_legacy_cap,
      without_static_power: distribution.energy.moves_without_static_power,
      moves_total: distribution.energy.moves_total,
    },
    respond: distribution.respond,
    pivot: distribution.pivot,
    synergy: {weakness_total: distribution.synergy.weakness_total},
    cost: distribution.cost,
  });
  assert.equal(distribution.instances, 80);
  assert.equal(distribution.speed.instances_with_validated_spe, 80);
  assert.equal(distribution.speed.validated_species, 48);
  assert.equal(distribution.speed.knowledge_only_species, 622);
  assert.equal(distribution.coverage.attack_types.length, 18);
  assert.equal(distribution.respond.learnset_variant_species['应对攻击'], 48);
  assert.ok(distribution.energy.moves_without_static_power > 0);
  assert.ok(distribution.pivot.learnset_species_with_tool > 0
    && distribution.pivot.learnset_species_with_tool < distribution.pivot.learnset_species_total);
  assert.equal(distribution.cost.candidate_universe_instances, 80);
  assert.equal(distribution.cost.distinct_species, 48);
  // 分布必须可复跑
  assert.equal(JSON.stringify(buildGapDistribution(inputs)), JSON.stringify(distribution));
});

test('RC-302 判据⑪：RC-301 说「合同合法」而 RC-302 说「不可满足」——两个 RC 的边界', () => {
  const legalButUnsatisfiable = [
    {id: 'seven-required', patch: {must_include: ids.slice(0, 7)}},
    {id: 'unowned-species', patch: {must_include: ['pet_000001']}},
    {id: 'churn-limited', patch: {selected: ids.slice(0, 4), must_include: ids.slice(4, 7), max_replacements: 0}},
  ];
  for (const sample of legalButUnsatisfiable) {
    const request = {...base(), ...sample.patch};
    const validated = validateRecommendationRequest(request, rc301Inputs);
    const diagnosis = diagnoseTeamGaps(request, inputs);
    raw(`⑪ ${sample.id}`, {
      rc301: {ok: validated.ok, problems: validated.problems.map(formatProblem)},
      rc302: {ok: diagnosis.ok, problems: diagnosis.problems.map(formatGapProblem),
        blocking: diagnosis.gaps.filter((g) => g.severity === 'blocking').map((g) => g.id)},
    });
    assert.equal(validated.ok, true, `${sample.id}：这份请求在 RC-301 合同上是合法的`);
    assert.equal(diagnosis.ok, false, `${sample.id}：RC-302 必须说不可满足`);
    assert.ok(diagnosis.gaps.some((g) => g.severity === 'blocking'));
  }
  // 每个样例请求都必须是 RC-301 认可的（否则诊断的输入就不合规）
  const shapes = SAMPLE_SHAPES.map((shape) => {
    const request = {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, ...shape.pick(ids, inputs, buildGapIndex(inputs))};
    const validated = validateRecommendationRequest(request, rc301Inputs);
    return {id: shape.id, rc301_ok: validated.ok, code: validated.problems[0]?.code ?? null};
  });
  raw('⑪ 全部样例的 RC-301 校验结果', shapes);
  assert.ok(shapes.every((row) => row.rc301_ok === true), '样例必须是 RC-301 认可的请求');
});

test('RC-302 判据⑫：报告与生成逻辑逐字节一致，且 ≥6 个真实样例（含 fail closed 样例）', () => {
  const fresh = `${JSON.stringify(buildRc302Report(inputs), null, 2)}\n`;
  const reportPath = join(ROOT, RC302_REPORT_PATH);
  if ((!existsSync(reportPath) || fresh !== readFileSync(reportPath, 'utf8')) && process.env.RC302_WRITE_REPORT === '1') {
    writeFileSync(reportPath, fresh, 'utf8');
    log('RC302_WRITE_REPORT=1：报告已重新生成');
  }
  assert.ok(existsSync(reportPath), `报告必须存在：${RC302_REPORT_PATH}`);
  const onDisk = readFileSync(reportPath, 'utf8');
  const report = readJson(RC302_REPORT_PATH);
  raw('⑫ 报告里失败的判据', report.criteria.filter((c) => !c.ok).map((c) => c.id));
  assert.deepEqual(report.criteria.filter((c) => !c.ok), [], '报告里不允许有失败的判据');
  assert.ok(report.criteria.length >= 12);
  assert.ok(report.criteria.every((c) => c.id && c.criteria && c.direction && c.actual !== undefined));
  assert.deepEqual(report.clock_fields, []);
  assert.equal(report.sample_teams.length, SAMPLE_SHAPES.length);
  assert.ok(report.sample_teams.length >= 6, '至少 6 个不同队伍形态');
  assert.ok(new Set(report.sample_teams.map((s) => s.id)).size === report.sample_teams.length);
  assert.ok(report.sample_teams.filter((s) => s.ok).length >= 4, '至少有一半样例是可用诊断');
  assert.ok(report.sample_teams.filter((s) => !s.ok).length >= 2, '必须保留 fail closed 的样例');
  assert.ok(report.sample_teams.every((s) => s.gaps.every((g) => g.machine_evidence.length > 0)),
    '样例里的每条 gap 都要带机器证据');
  assert.ok(report.unverified_quantities.every((q) => q.pattern_hit === true));
  assert.deepEqual(report.ledger_pattern_problems, []);
  assert.ok(report.does_not_rank_or_recommend.statement.includes('不排序、不推荐'));
  assert.ok(report.does_not_rank_or_recommend.forbidden_in_this_rc.some((line) => /RC-303/.test(line)));
  assert.equal(report.distribution.instances, 80);
  assert.deepEqual(report.severities, [...SEVERITIES]);
  if (fresh !== onDisk) {
    raw('⑫ 报告与生成逻辑不一致', {fresh_bytes: fresh.length, disk_bytes: onDisk.length});
    assert.fail(`磁盘上的 ${RC302_REPORT_PATH} 与 buildRc302Report() 不一致：`
      + '用 `RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js` 重新生成');
  }
  log(`报告新鲜度：逐字节一致（${onDisk.length} 字节，${report.sample_teams.length} 个样例）`);
});

test('RC-302 判据⑬：总置信取「非 info 缺口里最弱的一条」，且空队只报域与未知', () => {
  const empty = diagnose({});
  raw('⑬ 空队诊断', {ok: empty.ok, confidence: empty.confidence, gaps: empty.gaps.map((g) => g.id)});
  assert.equal(empty.ok, true, '空队不是错误：它只是还没有可诊断的成员');
  assert.equal(empty.confidence, 'UNKNOWN');
  assert.ok(empty.gaps.some((g) => g.id === 'coverage.no_members'));

  const six = baselineDiagnosis();
  const ranked = six.gaps.filter((g) => g.severity !== 'info');
  const weakest = ranked.reduce((worst, g) => {
    const order = [...CONFIDENCE_LEVELS].reverse();
    return order.indexOf(g.confidence) > order.indexOf(worst) ? g.confidence : worst;
  }, ranked[0].confidence);
  raw('⑬ 总置信的实际计算', {gap_confidences: [...new Set(ranked.map((g) => g.confidence))], total: six.confidence, recomputed: weakest});
  assert.equal(six.confidence, weakest);
});

test('RC-302 判据⑭：未知量清单必须能在台账里逐字命中，且台账变了就判红', () => {
  const info = ledgerQuantities(inputs.ledger);
  raw('⑭ 未知量清单', info.quantities.map((q) => ({id: q.id, topic: q.topic, level: q.level, cap: q.cap, pattern_hit: q.pattern_hit, microcase: q.microcase_id})));
  assert.ok(info.quantities.length >= 4);
  assert.ok(info.quantities.every((q) => q.pattern_hit === true), '每条未知量都要能在台账里逐字命中');
  assert.ok(info.quantities.some((q) => q.level === 'UNKNOWN' && q.cap === 'medium'), '速度平手必须是 UNKNOWN 且上限 medium');
  assert.deepEqual(info.problems, []);
  // 台账被改坏（拿掉那句登记）时必须报出来，而不是继续自称「知道它是未知」
  // 改坏**所有**位置（claim / notes / sources[].quote）：只要还有一处逐字命中就不算台账变了
  const brokenLedger = clone(inputs.ledger);
  brokenLedger.entries = brokenLedger.entries.map((entry) => (
    entry.topic === 'turn_order.priority'
      ? JSON.parse(JSON.stringify(entry).split('speed tie = UNKNOWN').join('speed tie = TBD'))
      : entry
  ));
  const brokenInfo = ledgerQuantities(brokenLedger);
  raw('⑭ 台账被改坏后的输出', brokenInfo.problems.map(formatGapProblem));
  assert.equal(brokenInfo.problems.some((p) => p.code === 'LEDGER_PATTERN_MISSING'), true);
  const diagnosis = baselineDiagnosis();
  const audit = auditGapDiagnosis(diagnosis, {ledger: brokenLedger});
  assert.ok(audit.problems.some((p) => p.code === 'LEDGER_PATTERN_MISSING'));
});

test('RC-302 判据⑮：cost 可满足性算术逐条可复算（含 max_replacements 与收藏池收窄）', () => {
  const index = buildGapIndex(inputs);
  const policy = {team_source: 'owned', allow_unowned: false};
  const cases = [
    {id: 'plain-six', patch: {selected: ids.slice(0, 6)}, expectBlocking: []},
    {id: 'five-selected-one-slot', patch: {selected: ids.slice(0, 5)}, expectBlocking: []},
    {id: 'seven-required', patch: {must_include: ids.slice(0, 7)}, expectBlocking: ['cost.unsatisfiable.slots_exceeded']},
    {id: 'churn-zero', patch: {selected: ids.slice(0, 4), must_include: ids.slice(4, 7), max_replacements: 0},
      expectBlocking: ['cost.unsatisfiable.churn_limit']},
    {id: 'unowned-species', patch: {must_include: ['pet_000001']}, expectBlocking: ['cost.unsatisfiable.required_not_owned']},
    {id: 'unowned-allowed', patch: {must_include: ['pet_000001']}, policyOverride: {allow_unowned: true}, expectBlocking: []},
  ];
  for (const row of cases) {
    const request = {...base(), ...row.patch};
    const model = costSatisfiability(request, index, row.policyOverride ?? policy);
    raw(`⑮ ${row.id}`, {rows: model.rows, blocking: model.blocking.map((b) => ({id: b.id, why: b.why}))});
    assert.deepEqual(model.blocking.map((b) => b.id), row.expectBlocking, `${row.id} 的 blocking 集合`);
  }
  // 收藏池收窄：favourites_only + 已选够多时仍然可满足；但池子不足必须 blocking
  const favouritesOnly = costSatisfiability(
    {...base(), selected: favouriteIds.slice(0, 5), favourites_only: true}, index, policy);
  raw('⑮ 收藏池口径', favouritesOnly.rows);
  assert.deepEqual(favouritesOnly.blocking, []);
  assert.equal(favouritesOnly.rows.candidate_pool, favouriteIds.length);
});

test('RC-302 判据⑯：读盘只读不写（数据文件在测试前后逐字节一致）', () => {
  const files = [
    'data/roco/owned/owned-pets.json',
    'data/roco/game-data-pack/v2/pack.json',
    FROZEN_PATHS.roster48,
    FROZEN_PATHS.types,
    FROZEN_PATHS.ledger,
  ];
  const before = files.map((file) => readFileSync(join(ROOT, file), 'utf8'));
  buildRc302Report(inputs);
  diagnose({selected: ids.slice(0, 6)});
  buildGapDistribution(inputs);
  const after = files.map((file) => readFileSync(join(ROOT, file), 'utf8'));
  raw('⑯ 数据文件读取次数与长度', files.map((file, i) => ({file, bytes: after[i].length})));
  assert.deepEqual(after, before, '诊断不许写任何数据文件');
  for (const file of ['data/roco/owned/owned-pets.json', 'data/roco/game-data-pack/v2/pack.json',
    'data/roco/evidence/rule-evidence-ledger.json']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} 必须还在原处`);
  }
});
