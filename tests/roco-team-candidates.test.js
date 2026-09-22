// RC-303 候选生成的守卫。
//
// 这一组判据要证明的是**候选生成有没有牙**，而不是「输出里字段齐不齐」。每条反证都先把
// 正确产出**改坏**，再喂回 `auditTeamCandidates()`，必须变红；并把**实际输出原文**打出来
// （报告里逐条引用这些行）：
//   ① 召回数 <20 或 >50 却不解释                       ⇒ 红（RECALL_COUNT_UNEXPLAINED）
//   ② 在线导出段里出现引擎 / 子进程 / 引擎客户端调用    ⇒ 红（ONLINE_ENGINE_CALL / ONLINE_SUBPROCESS_CALL）
//   ③ 没有排序器却报 ranker_status:'ready' 或输出胜率   ⇒ 红（RANKER_OVERCLAIM / PSEUDO_PRECISION）
//   ④ 输出变成固定白名单（候选数不跟注入宇宙走）        ⇒ 红（WHITELIST_FIXED_POOL）
//   ⑤ 违反 must_include / must_exclude / locked 的队伍  ⇒ 红（CONSTRAINT_VIOLATED）
//   ⑥ 非确定性（两次运行不同）                          ⇒ 红（NONDETERMINISTIC）
//   ⑦ 超延迟预算却报通过                                ⇒ 红（LATENCY_BUDGET_FALSE_PASS）
//   ⑧ progressiveNext 不是恰好 3 个 / 没有取舍标签      ⇒ 红（PROGRESSIVE_NOT_THREE）
// 另外钉住：600+ 候选宇宙真的可达（图鉴物种能进 Top-K 队伍）、离线入口与在线入口分开导出、
// 报告与生成逻辑逐字节一致、延迟报告与 13 号文档 §5.2 预算逐项对照且不造假。
//
// 用法：`node --test tests/roco-team-candidates.test.js`
//       `RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js`（重新生成报告）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

import * as teamCandidates from '../src/coach/team-candidates.mjs';
import {
  BANNED_CLAIM_KEYS, CANDIDATE_KINDS, DEFAULT_BEAM_BUDGETS, FORBIDDEN_ONLINE_PATTERNS,
  LATENCY_BUDGET_MS, OFFLINE_ENTRYPOINTS, ONLINE_ENTRYPOINTS, ONLINE_SECTION_MARKER,
  PROGRESSIVE_STRATEGIES, RANKER_STATUSES, RC303_REPORT_PATH, RECALL_MAX, RECALL_MIN,
  RULE_SCORE_WEIGHTS, STRUCTURAL_CRITERIA, auditTeamCandidates, beamComplete,
  buildCandidateIndex, buildRc303Report, buildTeamCandidatePlan, loadTeamCandidatesInputs,
  offlineSectionOf, onlineSectionOf, progressiveNext, recallCandidates, resolveRanker,
  scanForbiddenPatterns, scoreTeams,
} from '../src/coach/team-candidates.mjs';
import {
  CONFIDENCE_LEVELS,
} from '../src/coach/team-gaps.js';
import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, loadRecommendationInputs,
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

const inputs = await loadTeamCandidatesInputs({root: ROOT});
const rc301Inputs = await loadRecommendationInputs({root: ROOT});
const index = buildCandidateIndex(inputs);
const SOURCE = readFileSync(join(ROOT, 'src', 'coach', 'team-candidates.mjs'), 'utf8');
const ids = [...inputs.owned.instances].map((i) => i.instance_id).sort();
const favouriteIds = [...inputs.owned.instances].filter((i) => i.favourite === true)
  .map((i) => i.instance_id).sort();
const ownedInstanceIds = [...inputs.owned.instances].map((i) => i.instance_id);
const catalogSpeciesIds = index.packPetEntities.map((row) => row.entity.id).sort();

/** 一份**经 RC-301 校验过**的真实请求（候选生成只吃校验过的请求）。 */
const request = (patch = {}) => {
  const result = validateRecommendationRequest(
    {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, ...patch}, rc301Inputs);
  assert.equal(result.ok, true, `样例请求必须通过 RC-301：${result.problems.map((p) => p.code).join('/')}`);
  return result.request;
};
const plan = (patch = {}, options = {}) => {
  const req = request(patch);
  return {req, plan: buildTeamCandidatePlan(req, {...inputs, __index: index, ...options})};
};
const clone = (value) => JSON.parse(JSON.stringify(value));
/** 把审计结果里每条问题打印出来，报告里逐条引用的就是这些行。 */
const auditText = (result) => result.problems.map((p) => `[${p.code}] ${p.where}：${p.detail}`);
const audit = (planValue, options = {}) => auditTeamCandidates(planValue, {
  source: SOURCE,
  request: options.request ?? null,
  expect: {universe_size: index.facts.catalog_pet_entities, owned_instances: index.facts.owned_instances},
  ...options,
});
const expectRed = (planValue, code, label, options = {}) => {
  const result = audit(planValue, options);
  raw(label, {audit_ok: result.ok, problems: auditText(result)});
  assert.equal(result.ok, false, `${label}：改坏之后审计必须判红`);
  assert.ok(result.problems.some((p) => p.code === code),
    `${label}：期望出现 ${code}，实际 ${result.problems.map((p) => p.code).join('/')}`);
  return result;
};

/** 基线：已选 2 只（渐进推荐生效）+ 锁定一只 + must_include 一个图鉴物种 + 排除两只。 */
const BASELINE_PATCH = () => ({
  selected: ids.slice(0, 2),
  locked: [ids[0]],
  must_include: [catalogSpeciesIds[0]],
  must_exclude: [ids[8], ids[9]],
});
const baseline = () => plan(BASELINE_PATCH());

// ─────────────────────────────────────────────────────────────────────────
// ⓪ 基线与反向控制：正确产出必须过审计
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 基线：正确产出自检通过，且候选宇宙真的来自注入数据（不是 48 只白名单）', () => {
  const {req, plan: value} = baseline();
  const result = audit(value, {request: req});
  raw('⓪-1 基线审计', {ok: result.ok, problems: auditText(result)});
  assert.equal(result.ok, true);

  const facts = value.recall.facts;
  raw('⓪-2 候选宇宙实测', {
    owned_instances: facts.owned_instances,
    catalog_pet_entities: facts.catalog_pet_entities,
    validated_species: facts.validated_species,
    recall_count: value.recall_count,
    pool: value.recall.pool,
  });
  // 候选宇宙 = owned 实例 ∪ pack 的 600+ pet 实体；验证层（48 只）只是其中一小块。
  assert.equal(facts.owned_instances, inputs.owned.instances.length);
  assert.equal(facts.catalog_pet_entities, index.packPetEntities.length);
  assert.ok(facts.catalog_pet_entities > 600, 'pack 的候选宇宙必须是 600+');
  assert.ok(facts.validated_species < facts.catalog_pet_entities,
    '验证层必须小于候选宇宙：否则「600+ 都可用于召回」这句话就退回成 48 只白名单');
  const namespaces = new Set(value.recall.candidates.map((c) => c.namespace));
  raw('⓪-3 候选的 namespace 分布', [...namespaces]);
  assert.ok([...namespaces].every((n) => n === 'owned_instance' || n === 'catalog_species'));

  // 每个候选都带证据 + 置信等级 + unverified
  const thin = value.recall.candidates.filter((c) => !Array.isArray(c.machine_evidence)
    || c.machine_evidence.length === 0 || !Array.isArray(c.unverified)
    || !CONFIDENCE_LEVELS.includes(c.confidence));
  raw('⓪-4 缺证据/缺 unverified/置信不在台账六级的候选数', thin.length);
  assert.equal(thin.length, 0);

  // Top-K ≤ 10，每支队伍带证据
  raw('⓪-5 Top-K', {top_k: value.top_k, ranks: value.ranking.teams.map((t) => t.rank)});
  assert.ok(value.top_k <= 10);
  assert.ok(value.ranking.teams.every((t) => t.machine_evidence.length > 0 && Array.isArray(t.unverified)));

  // 600+ 里的实体真的能被用上（图鉴物种进 Top-K 队伍）
  const catalogMembers = value.beam.teams.flatMap((t) => t.members).filter((m) => m.namespace === 'catalog_species');
  raw('⓪-6 Top-K 队伍里的图鉴物种成员', catalogMembers.map((m) => m.species_id));
  assert.ok(value.recall.candidates.some((c) => c.namespace === 'catalog_species'),
    '召回里必须能出现图鉴物种（否则就只是 80 个 owned 实例在自转）');
});

test('RC-303 基线的三段预算都是显式参数，且报告里给实际值', () => {
  const {plan: value} = plan({selected: ids.slice(0, 2)}, {budgets: {beamWidth: 3, nodeBudget: 120, timeBudgetMs: 40, maxTeams: 6}});
  raw('⓪-7 beam 预算与实际值', value.beam.budgets);
  assert.equal(value.beam.budgets.beamWidth, 3);
  assert.equal(value.beam.budgets.nodeBudget, 120);
  assert.equal(value.beam.budgets.timeBudgetMs, 40);
  assert.equal(value.beam.budgets.maxTeams, 6);
  assert.ok(Number.isInteger(value.beam.budgets.actual_nodes));
  assert.ok(value.beam.budgets.actual_nodes <= 120, '实际节点数不许超过节点上限');
  // 默认预算也必须出现在产出里（不许只有隐式常量）
  const {plan: def} = plan({selected: ids.slice(0, 2)});
  raw('⓪-8 默认 beam 预算', def.beam.budgets);
  assert.equal(def.beam.budgets.beamWidth, DEFAULT_BEAM_BUDGETS.beamWidth);
  assert.ok(STRUCTURAL_CRITERIA.deterministic.includes('tie-break'));
});

// ─────────────────────────────────────────────────────────────────────────
// ① 候选数 <20 或 >50 却不解释 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据①：召回数越界却不解释必须判红', () => {
  const {req, plan: value} = baseline();
  raw('①-1 原始召回的实测数', {count: value.recall_count, limits: value.recall.limits, pool: value.recall.pool.pool_size});
  assert.ok(value.recall_count >= RECALL_MIN && value.recall_count <= RECALL_MAX);
  assert.equal(value.recall.shortfall_reason, null);

  // ①-a：候选池真的不够时，必须给出 shortfall_reason（而不是沉默或凑数）
  const small = plan({selected: ids.slice(0, 2)}, {limits: {min: 20, max: 50}, policy: {candidate_universe: 'owned', include_catalog_species: false}});
  raw('①-2 candidate_universe=owned 的召回数', {count: small.plan.recall_count, pool: small.plan.recall.pool.pool_size});
  // 真正的短欠场景：只从收藏池（24 只）召回、已选 3 只、再排除 16 只 ⇒ 池子只剩 5 个。
  const narrow = request({
    selected: favouriteIds.slice(0, 3), favourites_only: true,
    must_exclude: favouriteIds.slice(3, 19),
  });
  const narrowPlan = buildTeamCandidatePlan(narrow, {...inputs, __index: index,
    policy: {candidate_universe: 'owned', include_catalog_species: false}});
  raw('①-3 收窄到收藏池再排除 16 只', {count: narrowPlan.recall_count, effective_min: narrowPlan.recall.limits.effective_min,
    pool_size: narrowPlan.recall.pool.pool_size, eligible: narrowPlan.recall.pool.eligible_after_policy,
    shortfall_reason: narrowPlan.recall.shortfall_reason});
  assert.ok(narrowPlan.recall_count < RECALL_MIN, '这个样例必须真的凑不满下界');
  // 有效下界 = min(名义下界 20, policy 收窄后可用条目数)：池子只有 5 个时，下界就是 5。
  // 下界是**名义契约**（默认 20）：凑不满必须解释，不许用「policy 收窄」把门槛悄悄降下来。
  assert.equal(narrowPlan.recall.limits.eligible_after_policy, narrowPlan.recall_count);
  assert.equal(narrowPlan.recall.ok, false, '召回 5 个 < 下界 20，必须判 false');
  assert.ok(narrowPlan.recall.shortfall_reason, '凑不满下界时必须写 shortfall_reason（这里点名 policy 收窄）');
  // 审计也要红：把 shortfall_reason 抹掉、同时 count 降到下界以下 ⇒ RECALL_COUNT_UNEXPLAINED
  const silenced = clone(narrowPlan);
  silenced.recall.shortfall_reason = null;
  silenced.recall.count = 5;
  silenced.recall.candidates = silenced.recall.candidates.slice(0, 5);
  expectRed(silenced, 'RECALL_COUNT_UNEXPLAINED', '①-3b 召回 5 个（<20）却把 shortfall_reason 抹掉');

  // ①-b：把 shortfall_reason 抹掉 ⇒ 红
  const broken = clone(value);
  broken.recall.count = 7;
  broken.recall.candidates = broken.recall.candidates.slice(0, 7);
  broken.recall.shortfall_reason = null;
  expectRed(broken, 'RECALL_COUNT_UNEXPLAINED', '①-4 召回 7 个（<20）但 shortfall_reason 为空');

  // ①-c：超过上界却不解释 ⇒ 红
  const over = clone(value);
  over.recall.limits = {...over.recall.limits, max: 5};
  over.recall.count = over.recall.candidates.length;
  over.recall.overflow_reason = null;
  expectRed(over, 'RECALL_COUNT_UNEXPLAINED', '①-5 召回 50 个但上界写 5、overflow_reason 为空');

  // ①-d：count 与 candidates.length 不一致 ⇒ 红
  const mismatch = clone(value);
  mismatch.recall.count = value.recall_count + 3;
  expectRed(mismatch, 'RECALL_SHAPE', '①-6 count 与 candidates.length 不一致');

  // ①-e：真·空池（owned 全被排除）必须 fail closed 并解释
  const emptyPool = request({selected: ids.slice(0, 3), must_exclude: ids.slice(3, 80)});
  const emptyPlan = buildTeamCandidatePlan(emptyPool, {...inputs, __index: index, policy: {candidate_universe: 'owned', include_catalog_species: false}});
  raw('①-7 owned 全被排除后的召回', {count: emptyPlan.recall_count, shortfall_reason: emptyPlan.recall.shortfall_reason,
    problems: emptyPlan.problems.map((p) => `[${p.code}] ${p.detail}`)});
  assert.equal(emptyPlan.recall_count, 0);
  assert.ok(emptyPlan.recall.shortfall_reason);
  assert.equal(emptyPlan.recall.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────
// ② 在线导出里出现引擎 / 子进程调用 ⇒ 红（**结构判据**，不是注释声明）
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据②：在线导出段里出现引擎/子进程调用必须判红', () => {
  const section = onlineSectionOf(SOURCE);
  const hits = scanForbiddenPatterns(section);
  raw('②-1 真实源码在线段的禁止模式命中', {online_section_lines: section.split('\n').length, hits});
  assert.equal(hits.length, 0, '在线段不许出现任何禁止模式');
  for (const spec of FORBIDDEN_ONLINE_PATTERNS) {
    assert.ok(section.includes(spec.pattern) === false, `在线段不该包含 ${spec.pattern}`);
  }

  // 反证：把**同一份判据**喂给一个含引擎调用的在线段，必须命中
  const injected = [
    "export function recallCandidates(request) {",
    "  const client = new RocoClient('python3');",
    "  const plan = client.plan_actions({});",
    "  const out = step_joint(plan, {});",
    "  return out;",
    "}",
  ].join('\n');
  const injectedHits = scanForbiddenPatterns(injected);
  raw('②-2 注入引擎调用后的命中', injectedHits.map((h) => `[${h.code}] 第${h.line}行 ${h.pattern} ⇒ ${h.text}`));
  assert.ok(injectedHits.some((h) => h.code === 'ONLINE_ENGINE_CALL'));
  assert.ok(injectedHits.some((h) => h.code === 'ONLINE_SUBPROCESS_CALL'));

  // 反证②b：把真实源码的在线段整体换成含引擎调用的版本，`auditTeamCandidates` 必须红
  const marker = ONLINE_SECTION_MARKER;
  assert.ok(SOURCE.includes(marker), '源码里必须有在线段的结束标记');
  const uuid = randomUUID();
  const brokenSource = `// ${uuid}\n${injected}\n// ${uuid}\n${SOURCE}`;
  const brokenSection = onlineSectionOf(brokenSource);
  const brokenHits = scanForbiddenPatterns(brokenSection);
  raw('②-3 被替换后的在线段命中', brokenHits.map((h) => `[${h.code}] 第${h.line}行 ${h.pattern}`));
  assert.ok(brokenHits.length > 0);
  const {req, plan: value} = baseline();
  const result = auditTeamCandidates(value, {source: brokenSource, request: req, expect: {}});
  raw('②-4 用被替换的源码走审计', {ok: result.ok, problems: auditText(result)});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === 'ONLINE_ENGINE_CALL' || p.code === 'ONLINE_SUBPROCESS_CALL'));

  // 边界：离线入口必须**不在**在线段里，且必须出现在离线段（两个入口分开导出）
  for (const entry of OFFLINE_ENTRYPOINTS) {
    raw(`②-5 离线入口 ${entry.id} 的位置`, {
      in_online_section: section.includes(entry.id),
      in_offline_section: offlineSectionOf(SOURCE).includes(entry.id),
      caller: entry.caller,
    });
    assert.equal(section.includes(entry.id), false, '离线入口不许出现在在线段');
    assert.ok(offlineSectionOf(SOURCE).includes(entry.id), '离线入口必须在离线段里导出');
  }
  const offlinePlan = teamCandidates.buildOfflineLabelPlan();
  raw('②-6 离线工作单（它自己不跑模拟）', {runs_simulations: offlinePlan.runs_simulations, steps: offlinePlan.steps.length,
    outputs: offlinePlan.outputs.map((o) => `${o.path} exists=${o.exists}`)});
  assert.equal(offlinePlan.runs_simulations, false);
  // 在线导出清单里不能混进离线入口
  for (const name of ONLINE_ENTRYPOINTS) assert.equal(typeof teamCandidates[name], 'function', `在线入口 ${name} 必须导出`);
  assert.ok(!ONLINE_ENTRYPOINTS.includes('buildOfflineLabelPlan'));
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 没有 ranker 却报 ready / 输出胜率 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据③：没有排序器却报 ready 或输出胜率必须判红', () => {
  const {req, plan: value} = baseline();
  raw('③-1 排序器状态', {ranker_status: value.ranker_status, reason: value.ranking.ranker_reason,
    confidence: value.ranking.confidence, score_source: value.ranking.score_source});
  assert.equal(value.ranker_status, 'missing');
  assert.equal(value.ranking.confidence, 'ENGINE_HYPOTHESIS');
  assert.equal(value.ranking.score_source, 'rule_score');
  assert.ok(RANKER_STATUSES.includes(value.ranker_status));
  assert.ok(value.ranking.teams.every((t) => t.score_source === 'rule_score'));
  assert.equal(value.ranking.no_win_rate, true);
  // 产出里不许有胜率键
  const bannedKeys = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (BANNED_CLAIM_KEYS.includes(key)) bannedKeys.push(`${path}.${key}`);
      walk(item, `${path}.${key}`);
    }
  };
  walk(value.ranking, 'ranking');
  raw('③-2 产出里的伪精确键', bannedKeys);
  assert.equal(bannedKeys.length, 0);

  const resolved = resolveRanker(null);
  raw('③-3 resolveRanker(null)', resolved);
  assert.equal(resolved.status, 'missing');
  assert.equal(resolveRanker({ranker_id: 'team-ranker/v1', score: () => 1}).status, 'invalid');
  assert.equal(resolveRanker({ranker_id: 'team-ranker/v1', version: 'v1', calibrated: true, score: () => ({score: 0.5})}).status, 'ready');

  // 反证③a：没有排序器却报 ready ⇒ 红
  const ready = clone(value);
  ready.ranking.ranker_status = 'ready';
  ready.ranking.ranker_id = 'team-ranker/v1';
  ready.ranking.ranker_version = 'v1';
  ready.ranker_status = 'ready';
  expectRed(ready, 'RANKER_OVERCLAIM', "③-4 ranker_status 改成 'ready'（但没有注入排序器）");

  // 反证③b：ranker_status 保持 missing，但 confidence 冒充非工程假设 ⇒ 红
  const confident = clone(value);
  confident.ranking.confidence = 'OFFICIAL_CURRENT';
  expectRed(confident, 'RANKER_OVERCLAIM', '③-5 ranker 缺失却把排序置信写成 OFFICIAL_CURRENT');

  // 反证③c：给队伍塞一个伪精确胜率 ⇒ 红
  const winrate = clone(value);
  winrate.ranking.teams[0].win_rate = 0.62;
  expectRed(winrate, 'PSEUDO_PRECISION', '③-6 给 Top-K 队伍塞 win_rate');

  // 反证③d：队伍说明里写「胜率 62%」⇒ 红（否定句豁免只针对「不是胜率」这类声明）
  const claim = clone(value);
  claim.ranking.teams[0].unverified = ['这只队伍的胜率是 62%，可以直接用'];
  expectRed(claim, 'PSEUDO_PRECISION', '③-7 队伍说明里直接写胜率 62%');

  // 反向控制：真实的否定句（“不是胜率”）不许被误判成伪精确
  const honest = clone(value);
  honest.ranking.teams[0].unverified = ['未核实：排序器不存在 —— Top-K 只是启发式排序，不是胜率、不是强度分'];
  const honestResult = audit(honest, {request: req});
  raw('③-8 否定句（不是胜率）的审计结果', {ok: honestResult.ok, problems: auditText(honestResult)});
  assert.equal(honestResult.ok, true, '「不是胜率」这类边界声明不许被判成伪精确');

  // 反证③e：注入一个**完整**的版本化排序器 ⇒ 必须用 ranker 而不是规则分（证明 ready 这条路是通的）
  const injected = {
    ranker_id: 'team-ranker/v1', version: 'v1', calibrated: false,
    score: (features) => ({score: features?.coverage ?? 0, parts: {coverage: features?.coverage ?? 0}}),
  };
  const {plan: withRanker} = plan(BASELINE_PATCH(), {ranker: injected});
  raw('③-9 注入排序器后的排序状态', {ranker_status: withRanker.ranker_status, ranker_id: withRanker.ranking.ranker_id,
    score_source: withRanker.ranking.score_source, confidence: withRanker.ranking.confidence});
  assert.equal(withRanker.ranker_status, 'ready');
  assert.equal(withRanker.ranking.score_source, 'ranker');
  assert.ok(withRanker.ranking.teams.every((t) => t.score_source === 'ranker'));
  // 未校准的排序器仍然不许升级置信等级
  assert.equal(withRanker.ranking.confidence, 'ENGINE_HYPOTHESIS');
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 输出固定 48 只 / 80 个白名单 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据④：候选必须跟注入宇宙走，不许固定白名单', () => {
  const {plan: full} = baseline();
  raw('④-1 注入宇宙与产出', {
    injected_catalog_pet_entities: index.facts.catalog_pet_entities,
    injected_owned_instances: inputs.owned.instances.length,
    reported_catalog_pet_entities: full.recall.facts.catalog_pet_entities,
    reported_owned_instances: full.recall.facts.owned_instances,
    pool_size: full.recall.pool.pool_size,
  });
  assert.equal(full.recall.facts.catalog_pet_entities, index.facts.catalog_pet_entities);
  assert.equal(full.recall.facts.owned_instances, inputs.owned.instances.length);

  // 4-a：换一份**更小的**注入宇宙（只给前 30 只 pet + 前 10 个实例），输出必须跟着变
  const smallOwned = {instances: inputs.owned.instances.slice(0, 10)};
  const petSection = Object.fromEntries(Object.entries(inputs.pack.sections ?? {}).map(([name, section]) => [name, {
    ...section,
    entities: (section.entities ?? []).slice(0, 15),
  }]));
  const smallPack = {...inputs.pack, sections: petSection};
  const smallIndex = buildCandidateIndex({...inputs, owned: smallOwned, pack: smallPack});
  raw('④-2 注入更小宇宙后的索引', smallIndex.facts);
  assert.ok(smallIndex.facts.catalog_pet_entities < index.facts.catalog_pet_entities);
  const smallPlan = buildTeamCandidatePlan(request({selected: ids.slice(0, 2)}), {...inputs, owned: smallOwned, pack: smallPack});
  raw('④-3 更小宇宙下的召回', {count: smallPlan.recall_count, shortfall_reason: smallPlan.recall.shortfall_reason,
    facts: smallPlan.recall.facts});
  assert.equal(smallPlan.recall.facts.catalog_pet_entities, smallIndex.facts.catalog_pet_entities);

  // 4-b：产出里写死的宇宙规模与注入对不上 ⇒ 红
  const fixed = clone(full);
  fixed.recall.facts.catalog_pet_entities = 48;
  fixed.recall.facts.owned_instances = 48;
  expectRed(fixed, 'WHITELIST_FIXED_POOL', '④-4 产出把宇宙写成 48 只（注入的是 622 + 80）');

  // 4-c：候选池比注入数据还大 ⇒ 红（候选不可能凭空出现）
  const bigger = clone(full);
  bigger.recall.pool.pool_size = index.facts.owned_instances + index.facts.catalog_pet_entities + 1;
  expectRed(bigger, 'WHITELIST_FIXED_POOL', '④-5 候选池比注入宇宙还大',
    {expect: {universe_size: index.facts.catalog_pet_entities, owned_instances: inputs.owned.instances.length,
      pool_size: index.facts.owned_instances + index.facts.catalog_pet_entities}});
  // 4-c2：默认审计（不给 expect）下，产出自己声称的宇宙与实际注入不符也要红
  const lyingUniverse = clone(full);
  lyingUniverse.recall.facts.catalog_pet_entities = 60;
  expectRed(lyingUniverse, 'WHITELIST_FIXED_POOL', '④-5b 产出把候选宇宙写成 60 只（真实 pack 是 622）');

  // 4-d：600+ 里的实体必须真的能进候选（不只是计数好看）
  const catalogHits = full.recall.candidates.filter((c) => c.namespace === 'catalog_species');
  raw('④-6 召回里的图鉴物种（前 5 个）', catalogHits.slice(0, 5).map((c) => `${c.species_id}(${c.species_name})`));
  assert.ok(catalogHits.length > 0);
  assert.ok(catalogHits.every((c) => catalogSpeciesIds.includes(c.species_id)));
  assert.ok(CANDIDATE_KINDS.includes('catalog'));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 违反 must_include / must_exclude / locked ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据⑤：违反硬约束的队伍必须判红', () => {
  const {req, plan: value} = baseline();
  const memberSpecies = value.beam.teams.flatMap((t) => t.members.map((m) => m.species_id));
  raw('⑤-1 基线的硬约束实际落位', {
    must_include: req.must_include, must_exclude: req.must_exclude, locked: req.locked,
    teams_member_species: value.beam.teams.map((t) => t.members.map((m) => m.species_id)),
  });
  assert.ok(memberSpecies.includes(req.must_include[0]), 'must_include 的图鉴物种必须真的进队');
  for (const excluded of req.must_exclude) assert.ok(!memberSpecies.includes(excluded), 'must_exclude 不许出现在队里');
  assert.ok(value.beam.teams.every((t) => t.members.some((m) => m.instance_id === req.locked[0])), 'locked 实例必须在每支队伍里');

  // 反证⑤a：把 must_include 的成员从所有队伍里删掉 ⇒ 红
  const dropped = clone(value);
  for (const team of dropped.beam.teams) {
    team.members = team.members.filter((m) => m.species_id !== req.must_include[0]);
    team.member_keys = team.members.map((m) => m.key);
  }
  expectRed(dropped, 'CONSTRAINT_VIOLATED', '⑤-2 把 must_include 的成员删掉', {request: req});

  // 反证⑤b：把 must_exclude 的成员塞进队伍 ⇒ 红
  const smuggled = clone(value);
  smuggled.beam.teams[0].members[0] = {...smuggled.beam.teams[0].members[0], instance_id: req.must_exclude[0],
    species_id: req.must_exclude[0], key: `owned:${req.must_exclude[0]}`};
  expectRed(smuggled, 'CONSTRAINT_VIOLATED', '⑤-3 把 must_exclude 的成员塞进队伍', {request: req});

  // 反证⑤c：把 locked 的实例从所有队伍里换掉 ⇒ 红
  const unLocked = clone(value);
  for (const team of unLocked.beam.teams) {
    team.members = team.members.map((m) => (m.instance_id === req.locked[0] ? {...m, instance_id: null, key: 'catalog:x'} : m));
  }
  expectRed(unLocked, 'CONSTRAINT_VIOLATED', '⑤-4 把 locked 的实例换掉', {request: req});

  // 反向控制：硬要求**够不着**时（召回里根本没有它）必须 fail closed。
  // 这里直接把召回结果里的 required 候选剔掉，模拟「召回没带上硬要求」这件事本身。
  const impossible = request({selected: ids.slice(0, 2), must_include: [catalogSpeciesIds[0]]});
  const impossibleRecall = recallCandidates(impossible, {...inputs, __index: index});
  const withoutRequired = impossibleRecall.candidates.filter((c) => c.species_id !== catalogSpeciesIds[0]);
  const blockedBeam = beamComplete(impossible, withoutRequired, {inputs: {...inputs, __index: index}, __index: index});
  raw('⑤-5 召回里剔掉硬要求后的补全', {
    teams: blockedBeam.team_count, ok: blockedBeam.ok,
    problems: blockedBeam.problems.map((p) => `[${p.code}] ${p.detail}`),
  });
  assert.equal(blockedBeam.ok, false);
  assert.ok(blockedBeam.problems.some((p) => p.code === 'CONSTRAINT_VIOLATED'));
  // 而且审计也必须红（真实的产出确实没满足 must_include）
  const blockedPlan = {recall: impossibleRecall, beam: blockedBeam,
    ranking: scoreTeams(blockedBeam.teams, {inputs: {...inputs, __index: index}}),
    progressive: progressiveNext(impossible, {...inputs, __index: index, recall: impossibleRecall}),
    recall_count: impossibleRecall.count, team_count: blockedBeam.team_count, top_k: 0,
    ranker_status: 'missing', problems: blockedBeam.problems, unverified: []};
  expectRed(blockedPlan, 'CONSTRAINT_VIOLATED', '⑤-6 产出里 must_include 没落位', {request: impossible});
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 非确定性 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据⑥：同一输入两次运行不同必须判红', () => {
  const req = request(BASELINE_PATCH());
  const first = buildTeamCandidatePlan(req, {...inputs, __index: index});
  const second = buildTeamCandidatePlan(req, {...inputs, __index: index});
  raw('⑥-1 两次运行的逐段摘要', {
    recall: [first.recall_count, second.recall_count],
    teams: [first.team_count, second.team_count],
    top_k: [first.top_k, second.top_k],
    picks: [first.progressive.pick_count, second.progressive.pick_count],
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同一输入两次运行必须逐字节相同');

  // 反向控制：审计用 snapshot 比对，正确的两份必须过
  const okAudit = audit(first, {request: req, snapshot: second});
  raw('⑥-2 用第二份做 snapshot 的审计', {ok: okAudit.ok, problems: auditText(okAudit)});
  assert.equal(okAudit.ok, true);

  // 反证⑥：把第二次运行结果改一个字节 ⇒ 红
  const drifted = clone(second);
  drifted.recall.candidates[0].recall_score = drifted.recall.candidates[0].recall_score + 0.0001;
  expectRed(first, 'NONDETERMINISTIC', '⑥-3 两次运行的候选分数差 0.0001', {request: req, snapshot: drifted});

  // tie-break 也要固定：同一个分数集合下，候选顺序必须按 (kind, species_id, instance_id) 稳定
  const keys = first.recall.candidates.map((c) => c.candidate_key);
  const inTeam = new Set([...req.locked, ...req.selected]);
  raw('⑥-4 候选键的前 8 个与是否含已选实例', {keys: keys.slice(0, 8), in_team_leaked: keys.filter((k) => inTeam.has(k.split(':')[1])).length});
  assert.equal(inTeam.has(keys[0].split(':')[1]), false, '已在队里的实例不许出现在候选里');
  // 相邻同分候选必须按键序排
  const sameScoreGroups = [];
  for (let i = 1; i < first.recall.candidates.length; i += 1) {
    const a = first.recall.candidates[i - 1];
    const b = first.recall.candidates[i];
    if (a.recall_score === b.recall_score && !a.required && !b.required) sameScoreGroups.push([a.candidate_key, b.candidate_key]);
  }
  raw('⑥-5 同分相邻对的 tie-break 检查', {pairs: sameScoreGroups.length,
    violations: sameScoreGroups.filter(([a, b]) => a >= b).slice(0, 5)});
  assert.ok(sameScoreGroups.every(([a, b]) => a < b), '同分时按键的字典序 break tie');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑦ 超延迟预算却报通过 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据⑦：超预算却报通过必须判红，且真实报告与实测自洽', () => {
  const latencyPath = 'reports/roco/team-candidates/latency.json';
  assert.ok(existsSync(join(ROOT, latencyPath)), `先跑 node scripts/roco/measure-team-candidates.mjs 生成 ${latencyPath}`);
  const latency = readJson(latencyPath);
  const comparison = latency.budget_comparison;
  raw('⑦-1 预算逐项对照', Object.entries(comparison).map(([key, row]) =>
    `${key}: P95 ${row.p95_ms}ms / 预算 ${row.budget_ms}ms ⇒ within_budget=${row.within_budget}`));
  // 判定不许与实测矛盾
  const contradictions = Object.entries(comparison).filter(([, row]) => typeof row.p95_ms === 'number'
    && ((row.p95_ms <= row.budget_ms) !== row.within_budget));
  raw('⑦-2 判定与实测矛盾的项', contradictions.map(([k]) => k));
  assert.equal(contradictions.length, 0);
  // 超预算项必须如实登记
  const shouldBeOver = Object.entries(comparison).filter(([, row]) => typeof row.p95_ms === 'number' && row.p95_ms > row.budget_ms)
    .map(([k]) => k).sort();
  raw('⑦-3 实测超预算的项', {should_be_over: shouldBeOver, reported_over: latency.over_budget,
    all_within_budget: latency.all_within_budget});
  assert.deepEqual(shouldBeOver, [...latency.over_budget].map((line) => line.split(':')[0]).sort());
  assert.equal(latency.all_within_budget, shouldBeOver.length === 0);
  assert.equal(comparison.recall.budget_ms, LATENCY_BUDGET_MS.recall);
  assert.equal(comparison.beam_and_ranker.budget_ms, LATENCY_BUDGET_MS.beam_and_ranker);
  assert.equal(comparison.first_screen.budget_ms, LATENCY_BUDGET_MS.first_screen);
  // 三段都要有 P50/P95，且不许只有 P95 没有 P50
  for (const key of ['recall', 'beam_and_ranker', 'first_screen']) {
    assert.ok(typeof comparison[key].p50_ms === 'number' && typeof comparison[key].p95_ms === 'number', `${key} 必须有 P50 与 P95`);
  }
  raw('⑦-4 排名器状态对延迟的影响', latency.ranker);
  assert.equal(latency.ranker.status, 'missing');

  // 反证⑦：把「超预算」改写成「在预算内」⇒ 红
  const {plan: value} = baseline();
  const forced = clone(latency);
  forced.budget_comparison.recall = {...forced.budget_comparison.recall, p95_ms: 999, within_budget: true};
  const result = audit(value, {source: SOURCE, latency: forced, request: request(BASELINE_PATCH())});
  raw('⑦-5 把 P95=999ms 写成 within_budget=true 的审计', {ok: result.ok, problems: auditText(result)});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === 'LATENCY_BUDGET_FALSE_PASS'));

  // 反向控制：真实的（可能超预算）报告走审计不许因为预算判红
  const real = audit(value, {source: SOURCE, latency, request: request(BASELINE_PATCH())});
  raw('⑦-6 真实延迟报告走审计', {ok: real.ok, problems: auditText(real)});
  assert.equal(real.ok, true, '只要判定与实测一致，超预算本身不该判红（只该如实报告）');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑧ progressiveNext 不是恰好 3 个 / 没有取舍标签 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 判据⑧：渐进推荐必须恰好三个且带取舍标签', () => {
  const {req, plan: value} = plan({selected: ids.slice(0, 3)});
  raw('⑧-1 已选 3 只时的三个候选', value.progressive.picks.map((p) =>
    `${p.tradeoff_label}(${p.tradeoff_id}) → ${p.candidate_key} 边际增益 ${p.expected_marginal_gain} 未承接弱点 ${p.unanswered_weaknesses_after}`));
  assert.equal(value.progressive.applies, true);
  assert.equal(value.progressive.pick_count, PROGRESSIVE_STRATEGIES.length);
  assert.deepEqual(value.progressive.picks.map((p) => p.tradeoff_id).sort(),
    PROGRESSIVE_STRATEGIES.map((s) => s.id).sort());
  assert.deepEqual(value.progressive.picks.map((p) => p.tradeoff_label).sort(), ['偏好保留', '强度', '稳定']);
  assert.ok(value.progressive.picks.every((p) => typeof p.tradeoff_note === 'string' && p.tradeoff_note.length > 0));
  assert.ok(value.progressive.picks.every((p) => p.confidence === 'ENGINE_HYPOTHESIS'));
  // 标签是决策口径，不是胜率
  assert.ok(value.progressive.picks.every((p) => p.score_scale.includes('不是胜率')));

  // 2 只与 5 只也必须是三个
  for (const count of [2, 5]) {
    const {plan: row} = plan({selected: ids.slice(0, count)});
    raw(`⑧-2 已选 ${count} 只的 pick 数`, {applies: row.progressive.applies, picks: row.progressive.pick_count});
    assert.equal(row.progressive.pick_count, 3);
  }
  // 0/1/6 只不适用：不许硬凑三个
  for (const count of [0, 1, 6]) {
    const {plan: row} = plan(count === 0 ? {} : {selected: ids.slice(0, count)});
    raw(`⑧-3 已选 ${count} 只`, {applies: row.progressive.applies, picks: row.progressive.pick_count,
      reason: row.progressive.not_applicable_reason});
    assert.equal(row.progressive.applies, false);
    assert.equal(row.progressive.pick_count, 0);
    assert.ok(row.progressive.not_applicable_reason);
  }

  // 反证⑧a：只剩两个候选 ⇒ 红
  const two = clone(value);
  two.progressive.picks = two.progressive.picks.slice(0, 2);
  two.progressive.pick_count = 2;
  expectRed(two, 'PROGRESSIVE_NOT_THREE', '⑧-4 只返回 2 个 next 候选');

  // 反证⑧b：删掉取舍标签 ⇒ 红
  const unlabeled = clone(value);
  delete unlabeled.progressive.picks[0].tradeoff_label;
  expectRed(unlabeled, 'PROGRESSIVE_NOT_THREE', '⑧-5 第一个候选没有 tradeoff_label');

  // 反证⑧c：三个候选挤在同一个口径上 ⇒ 红
  const sameChannel = clone(value);
  sameChannel.progressive.picks = sameChannel.progressive.picks.map((p) => ({...p, tradeoff_id: 'strength', tradeoff_label: '强度'}));
  expectRed(sameChannel, 'PROGRESSIVE_NOT_THREE', '⑧-6 三个候选都用「强度」口径');

  // 反证⑧d：2～5 只却报 applies:false ⇒ 红
  const skipped = clone(value);
  skipped.progressive.applies = false;
  skipped.progressive.picks = [];
  skipped.progressive.pick_count = 0;
  expectRed(skipped, 'PROGRESSIVE_NOT_THREE', '⑧-7 已选 3 只却报 applies:false');

  // 直接调用也要给恰好三个（不经过一条龙）
  const direct = progressiveNext(request({selected: ids.slice(0, 4)}), {...inputs, __index: index});
  raw('⑧-8 直接调 progressiveNext（已选 4 只）', {applies: direct.applies, pick_count: direct.pick_count,
    labels: direct.picks.map((p) => p.tradeoff_label)});
  assert.equal(direct.pick_count, 3);
});

// ─────────────────────────────────────────────────────────────────────────
// 契约：报告可复跑、口径声明齐全
// ─────────────────────────────────────────────────────────────────────────

test('RC-303 报告：可复跑 + 离线/在线边界声明齐全 + 排序器不存在的后果写清楚', () => {
  const latency = existsSync(join(ROOT, 'reports/roco/team-candidates/latency.json'))
    ? readJson('reports/roco/team-candidates/latency.json') : {available: false};
  const report = buildRc303Report(inputs, {
    source: SOURCE,
    budgets: {beamWidth: 8},
    latency: latency.available === false ? latency : {
      available: true, report_path: 'reports/roco/team-candidates/latency.json',
      segment_stats: latency.segment_stats, budget_comparison: latency.budget_comparison,
      over_budget: latency.over_budget, all_within_budget: latency.all_within_budget,
      ranker_note: latency.ranker?.note ?? null,
    },
  });
  const again = buildRc303Report(inputs, {
    source: SOURCE,
    budgets: {beamWidth: 8},
    latency: latency.available === false ? latency : {
      available: true, report_path: 'reports/roco/team-candidates/latency.json',
      segment_stats: latency.segment_stats, budget_comparison: latency.budget_comparison,
      over_budget: latency.over_budget, all_within_budget: latency.all_within_budget,
      ranker_note: latency.ranker?.note ?? null,
    },
  });
  raw('⑨-1 报告两次生成是否逐字节相同', JSON.stringify(report) === JSON.stringify(again));
  assert.equal(JSON.stringify(report), JSON.stringify(again));

  raw('⑨-2 报告的判据结论', report.criteria.map((c) => `${c.label} ⇒ ok=${c.ok}`));
  assert.ok(report.criteria.every((c) => c.ok), `报告判据必须全绿：${report.criteria.filter((c) => !c.ok).map((c) => c.label).join('/')}`);
  raw('⑨-3 离线/在线边界', {
    online_entrypoints: report.offline_online_boundary.online_entrypoints,
    offline_entrypoints: report.offline_online_boundary.offline_entrypoints.map((e) => e.id),
    scan_result: report.offline_online_boundary.scan_result,
  });
  assert.equal(report.offline_online_boundary.scan_result.forbidden_hits.length, 0);
  assert.ok(report.offline_online_boundary.why_no_online_simulation.length >= 3);
  raw('⑨-4 排序器口径', {status: report.ranker.status, degrade_to: report.ranker.degrade_to,
    no_win_rate: report.ranker.no_win_rate, weights: report.ranker.rule_score_weights});
  assert.equal(report.ranker.status, 'missing');
  assert.equal(report.ranker.degrade_to, 'rule_score');
  assert.equal(report.ranker.no_win_rate, true);
  assert.ok(Object.values(RULE_SCORE_WEIGHTS).every((w) => w > 0));

  const realTeamCount = report.real_sample.top_teams.length;
  raw('⑨-5 真实样例', {id: report.real_sample.id, recall_count: report.real_sample.recall_count,
    teams: realTeamCount, progressive: report.real_sample.progressive.pick_count});
  assert.ok(realTeamCount >= 6, '真实样例必须给 ≥6 支 Top-K 队伍（逐条带证据）');
  assert.ok(report.real_sample.top_teams.every((t) => Array.isArray(t.machine_evidence) && t.machine_evidence.length > 0));

  // 落盘比对：磁盘上的报告必须与当前生成逻辑逐字节一致
  const diskPath = join(ROOT, RC303_REPORT_PATH);
  if (process.env.RC303_WRITE_REPORT === '1' || !existsSync(diskPath)) {
    writeFileSync(diskPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`已写出 ${RC303_REPORT_PATH}`);
  } else {
    const onDisk = readFileSync(diskPath, 'utf8');
    const freshlyMerged = buildRc303Report(inputs, {source: SOURCE, budgets: {beamWidth: 8},
      latency: readJson(RC303_REPORT_PATH).latency});
    raw('⑨-6 磁盘报告与重算报告是否一致', {
      disk_bytes: Buffer.byteLength(onDisk, 'utf8'),
      recomputed_matches_disk: onDisk === `${JSON.stringify(freshlyMerged, null, 2)}\n`,
      hint: '不一致时跑 RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js 重写',
    });
    assert.equal(onDisk, `${JSON.stringify(freshlyMerged, null, 2)}\n`,
      `磁盘上的 ${RC303_REPORT_PATH} 与生成逻辑不一致：跑 RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js 重写`);
  }
});

test('RC-303 与 RC-302 的边界：候选生成不做缺口诊断，缺口诊断不做候选生成', () => {
  const gapsSource = readFileSync(join(ROOT, 'src', 'coach', 'team-gaps.js'), 'utf8');
  raw('⑩-1 RC-302 是否出现候选生成的导出', {
    mentions_recall_candidates: gapsSource.includes('recallCandidates'),
    mentions_beam_complete: gapsSource.includes('beamComplete'),
  });
  assert.equal(gapsSource.includes('recallCandidates'), false, 'RC-302 不许做候选召回');
  assert.equal(gapsSource.includes('beamComplete'), false, 'RC-302 不许做束搜索补全');
  // 候选生成复用 RC-302 的判据，而不是复制一套：属性倍率与技能词条都走 team-gaps 的导出
  // 注意：下面故意**不**在本文件里写出完整的相对 import 字面量。
  // 结构契约守卫（tests/evals/structure-contract.test.js）会扫描**字符串里的**相对 import 并核对磁盘路径，
  // 而这里位于 tests/ 目录，写全就会指向一个不存在的 tests/team-gaps.js 而被判成坏 import。
  // 所以用正则匹配「从同目录模块导入」这件事本身，而不是贴字面量。
  const importsSibling = /from\s+'\.\/team-gaps\.js'/;
  raw('⑩-2 RC-303 是否 import RC-302 的判据', {
    imports_team_gaps: importsSibling.test(SOURCE),
    uses_build_gap_index: SOURCE.includes('buildGapIndex'),
    redefines_respond_keywords: /RESPOND_VARIANTS\s*=\s*Object\.freeze/.test(SOURCE),
    redefines_pivot_keywords: /desc\.includes\('迅捷'\)/.test(SOURCE),
  });
  assert.ok(importsSibling.test(SOURCE), 'RC-303 必须 import RC-302 的判据模块');
  assert.ok(SOURCE.includes('buildGapIndex'));
  assert.equal(/RESPOND_VARIANTS\s*=\s*Object\.freeze/.test(SOURCE), false, '应对词条不许在 RC-303 里重写一份');
  assert.equal(/desc\.includes\('迅捷'\)/.test(SOURCE), false, '换入/离场词条不许在 RC-303 里重写一份');
});

// ─────────────────────────────────────────────────────────────────────────
// A2 尾部（2026-09-22 人类 P0）：**锁定是硬要求** —— 自动补队不许把被锁的成员挤掉。
//
// 为什么单独钉：`locked` 在 RC-301 那一层只被校验「必须在 selected/must_include 里」，
// 而**补全算法**是不是真的不拿它换人，之前没有任何判据（只有代码注释说「永远不因为占比被挤掉」）。
// 注释不是证据。
// ─────────────────────────────────────────────────────────────────────────
test('A2 锁定：补全计划必须包含被锁成员，且不许把它当替换候选换掉', () => {
  const ownedDoc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
  const ownedIds = (ownedDoc.instances ?? []).map((i) => i.instance_id).sort();
  const keep = ownedIds[0];
  const other = ownedIds[1];
  const withLock = validateRecommendationRequest(
    {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, selected: [keep, other], locked: [keep]},
    rc301Inputs);
  assert.equal(withLock.ok, true, `样例请求必须通过 RC-301：${withLock.problems.map((p) => p.code).join('/')}`);
  const plan = buildTeamCandidatePlan(withLock.request, inputs);
  const required = (plan?.beam?.teams ?? plan?.teams ?? [])
    .flatMap((t) => (t.members ?? t.team ?? []))
    .map((m) => (typeof m === 'string' ? m : (m.instance_id ?? m.id ?? m.raw)));
  const lockedInEveryTeam = (plan?.beam?.teams ?? []).every((t) => {
    const ids = (t.members ?? t.team ?? []).map((m) => (typeof m === 'string' ? m : (m.instance_id ?? m.id ?? m.raw)));
    return ids.includes(keep);
  });
  assert.ok(required.includes(keep),
    `补全结果里必须始终带着被锁的 ${keep}（实际成员：${JSON.stringify([...new Set(required)].slice(0, 12))}）`);
  assert.ok(lockedInEveryTeam,
    '每一个候选完整队伍都必须包含被锁成员（不许有队伍把它换掉）');
  // 反证：把 locked 拿掉、只留 selected 时，这条「必须包含」不再是引擎的承诺 ——
  // 判据要量的正是「locked 与 selected 是两件事」，混为一谈就会让这条判据失去牙齿。
  const noLock = validateRecommendationRequest(
    {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, selected: [keep, other]},
    rc301Inputs);
  assert.equal(noLock.ok, true, '不带 locked 的同形请求也必须合法（否则上面的对比不成立）');
  assert.deepEqual(noLock.request.locked ?? [], [],
    '不带 locked 时请求里不该冒出锁定 —— 否则「locked 是不是生效」这条判据就说不清');
});
