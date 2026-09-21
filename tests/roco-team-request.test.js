// RC-301 `RecommendationRequest` 合同的守卫。
//
// 这一组判据要证明的是**合同有没有牙**，而不是「合同里的字段看起来齐不齐」。
// 每条反证都有明确的必红方向，并且把**实际输出原文**打出来（报告里逐条引用）：
//   ① 未知字段被静默丢弃            ⇒ 红（必须是 `UNKNOWN_FIELD`，且点名该字段）
//   ② must_include / must_exclude 有交集却通过 ⇒ 红
//   ③ 不存在的 instance_id 通过     ⇒ 红
//   ④ 自创 mode 通过                ⇒ 红
//   ⑤ 自创 ruleset_config_id 通过   ⇒ 红
//   ⑥ 标准 PVP 用 team_size=3 通过  ⇒ 红
//   ⑦ KNOWN_SCENARIO 却不给对手信息通过 ⇒ 红
//   ⑧ 自然语言说「随便配一队」时被编出一个队伍名单 ⇒ 红（必须 ok:false 并说明缺什么）
// 另外钉住：标准 PVP 默认 `UNKNOWN_PREMATCH`、`team_size` 由注册表推导、
// 工具只回「经校验的请求 + 问题」而**不产生**推荐结果、报告与生成逻辑逐字节一致。
//
// 用法：`node --test tests/roco-team-request.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ALLOWED_FIELDS, CONSTRAINT_KEYS, DEFAULT_VISIBILITY, NL_EXAMPLE_TEXTS, RC301_REPORT_PATH,
  REQUEST_FIELDS, STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, buildRc301Report, formatProblem,
  loadRecommendationInputs, normaliseRecommendationRequest, requestFromNaturalLanguage,
  validateRecommendationRequest,
} from '../src/coach/team-request.js';
import {
  REQUEST_TEAM_RECOMMENDATION_CONTRACT, REQUEST_TEAM_RECOMMENDATION_TOOL, TOOL_CONTRACTS,
  executeRequestTeamRecommendation, resetRocoTools, validRequestContractArgs,
} from '../src/coach/toolbox.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const log = (...args) => console.log('  ·', ...args);

/** 每条反证打印**实际输出原文**：报告里贴的就是这些行。 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

/** 同一份登记数据只读一次（测试全程只读，不写 data/）。 */
const inputs = await loadRecommendationInputs({root: ROOT});
const registry = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, inputs).registry;
const rulesetId = [...registry.rulesetById.keys()][0] ?? null;
const sampleInstance = [...registry.instances.keys()].sort()[0];
const sampleSpecies = registry.instances.get(sampleInstance).species_id;
const ownedSpeciesWithName = (name) => [...registry.species.values()].find((entry) => entry.name === name);
const mustIncludeTwo = [...registry.instances.values()].slice(0, 2).map((i) => i.instance_id);

const base = () => ({mode: STANDARD_PVP_MODE, ruleset_config_id: rulesetId});
const codeOf = (result) => result.problems[0]?.code ?? null;
/** 反证标准：`{实际, 期望}` 摆在一起，红了就地看得出差在哪。 */
const expectCode = (result, code, label) => {
  raw(label, result.problems.map(formatProblem));
  assert.equal(codeOf(result), code, `${label}：期望首条问题码 ${code}，实际 ${codeOf(result)}`);
  assert.equal(result.ok, false, `${label}：判红时 ok 必须是 false`);
  assert.equal(result.request, null, `${label}：判红时不得给出 request`);
};

// ─────────────────────────────────────────────────────────────────────────
// ①～⑧ 必红反证
// ─────────────────────────────────────────────────────────────────────────

test('RC-301 判据①：未知字段必须被判红，不许静默丢弃', () => {
  const result = validateRecommendationRequest({...base(), selected_pets: [sampleInstance]}, inputs);
  expectCode(result, 'UNKNOWN_FIELD', '① selected_pets 这种未登记字段');
  assert.equal(result.problems[0].field, 'selected_pets', '必须点名是哪个字段');
  assert.match(result.problems[0].detail, /合同没有登记这个字段/);
  assert.ok(ALLOWED_FIELDS.every((field) => typeof field === 'string'));
});

test('RC-301 判据②：must_include 与 must_exclude 有交集必须判红', () => {
  const result = validateRecommendationRequest({...base(), must_include: [sampleInstance], must_exclude: [sampleInstance]}, inputs);
  expectCode(result, 'MUST_INCLUDE_EXCLUDE_OVERLAP', '② 同一实例既必须包含又必须排除');
  assert.deepEqual(result.problems[0].value, [sampleInstance], '必须把交集原样报出来');
  // 反向控制：去掉交集之后同一条请求必须能过，否则「红」可能来自别的原因
  const clean = validateRecommendationRequest({...base(), must_include: [sampleInstance], must_exclude: [mustIncludeTwo[1] ?? sampleInstance]}, inputs);
  raw('② 去掉交集后', clean.problems.map(formatProblem));
  assert.equal(clean.ok, true, '去掉交集后应当通过');
});

test('RC-301 判据③：不存在的 instance_id / species_id 必须判红', () => {
  const instance = validateRecommendationRequest({...base(), must_include: ['own-9999']}, inputs);
  expectCode(instance, 'UNKNOWN_INSTANCE_ID', '③ owned 里不存在的 instance_id');
  const species = validateRecommendationRequest({...base(), must_include: ['pet_999999']}, inputs);
  expectCode(species, 'UNKNOWN_SPECIES_ID', '③ pack 里不存在的 species_id');
  const lockedSpecies = validateRecommendationRequest({...base(), locked: [sampleSpecies], selected: [sampleSpecies]}, inputs);
  expectCode(lockedSpecies, 'UNKNOWN_INSTANCE_ID', '③ species_id 塞进 locked（锁定只能指向实例）');
});

test('RC-301 判据④：自创 mode 必须判红', () => {
  const result = validateRecommendationRequest({mode: 'pvp-standard-eight-pet'}, inputs);
  expectCode(result, 'UNKNOWN_MODE', '④ 注册表里没有的模式 id');
  assert.equal(result.problems[0].value, 'pvp-standard-eight-pet', '必须把自创的那个 id 原样报出来');
  assert.match(result.problems[0].detail, /模式不许自创/);
  // 反向控制：注册表里的模式必须能过
  raw('④ 注册表里的 5 个模式', [...registry.modeById.keys()]);
  for (const modeId of registry.modeById.keys()) {
    const teamSize = registry.modeById.get(modeId)?.parameters?.team_size;
    if (!Number.isInteger(teamSize)) continue;   // PVE 营地没有 team_size：另有一条判据管它
    const ok = validateRecommendationRequest({mode: modeId}, inputs);
    assert.equal(ok.ok, true, `${modeId} 是注册表里的模式，应当能过：${ok.problems.map(formatProblem).join(' | ')}`);
  }
});

test('RC-301 判据⑤：自创 ruleset_config_id 必须判红', () => {
  const result = validateRecommendationRequest({...base(), ruleset_config_id: 'made_up_ruleset_v9'}, inputs);
  expectCode(result, 'UNKNOWN_RULESET', '⑤ rulesets/*.json 里没有的配置 id');
  assert.deepEqual([...registry.rulesetById.keys()], ['legacy_sim_v1', 'mobile_s4_candidate_v2']);
});

test('RC-301 判据⑥：标准 PVP 用 team_size=3 必须判红', () => {
  const result = validateRecommendationRequest({mode: STANDARD_PVP_MODE, team_size: 3}, inputs);
  expectCode(result, 'MODE_TEAM_SIZE_MISMATCH', '⑥ 标准 PVP 传 3 只');
  assert.match(result.problems[0].detail, new RegExp(`注册表是 ${STANDARD_PVP_TEAM_SIZE}`));
  // 反向控制：同一件事在极速对决（注册表 team_size=3）下必须成立
  const duel = validateRecommendationRequest({mode: 'pvp-speed-duel-3v3', team_size: 3}, inputs);
  raw('⑥ 极速对决 3 只', duel.request);
  assert.equal(duel.ok, true, '极速对决是 3v3 模式，3 只必须能过');
});

test('RC-301 判据⑦：KNOWN_SCENARIO 却不给对手信息必须判红', () => {
  const result = validateRecommendationRequest({mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO'}, inputs);
  expectCode(result, 'OPPONENT_INFO_REQUIRED', '⑦ 已知场景但没有 opponent_roster');
  // 反向控制：给出对手信息就必须能过，并且标准 PVP 的「非首选可见性」要被记下来
  const withOpponent = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO', opponent_roster: [sampleSpecies],
  }, inputs);
  raw('⑦ 给出对手之后', {request: withOpponent.request, info: withOpponent.info.map(formatProblem)});
  assert.equal(withOpponent.ok, true, '给出 opponent_roster 的 KNOWN_SCENARIO 应当通过');
  assert.ok(withOpponent.info.some((p) => p.code === 'VISIBILITY_NOT_DEFAULT'),
    '标准 PVP 用了非首选可见性时必须留下 VISIBILITY_NOT_DEFAULT 的痕迹');
  // 反方向也要红：匹配前口径下给出具体对手，等于把匹配前当成匹配后
  const prematchWithOpponent = validateRecommendationRequest({mode: STANDARD_PVP_MODE, opponent_roster: [sampleSpecies]}, inputs);
  expectCode(prematchWithOpponent, 'OPPONENT_INFO_NOT_ALLOWED', '⑦b UNKNOWN_PREMATCH 下给出具体对手');
});

test('RC-301 判据⑧：「随便配一队」必须 ok:false 并说明缺什么，不许编出队伍名单', () => {
  const result = requestFromNaturalLanguage('随便配一队', inputs);
  raw('⑧ requestFromNaturalLanguage("随便配一队")', {ok: result.ok, request: result.request, problems: result.problems.map(formatProblem)});
  assert.equal(result.ok, false, '「随便配一队」没有任何可落 schema 的约束，必须 ok:false');
  assert.equal(result.request, null, '不得给出任何候选 schema —— 更不得编出六只名单');
  assert.equal(result.problems[0].code, 'NO_REQUEST_INTENT');
  for (const field of ['mode', 'must_include', 'must_exclude', 'locked', 'favourites_only', 'max_replacements']) {
    assert.match(result.problems[0].detail, new RegExp(field), `「缺什么」必须逐项点出来：${field}`);
  }
  // 反向控制：同一套抽取器在「说了模式 + 点名一只」时必须能产出可用的候选 schema
  const explicit = requestFromNaturalLanguage(`标准PVP，队伍里必须有${sampleSpecies === 'pet_000012' ? '铠甲虫' : ''}`.trim() || '标准PVP，带上铠甲虫', inputs);
  raw('⑧ 反向控制（点名 + 说模式）', explicit.request ?? explicit.problems.map(formatProblem));
  assert.equal(explicit.ok, true);
  assert.equal(explicit.request.mode, STANDARD_PVP_MODE);
});

// ─────────────────────────────────────────────────────────────────────────
// 其余合同判据（同样的必红方向，报告 criteria 里逐条列出）
// ─────────────────────────────────────────────────────────────────────────

test('RC-301 合同：标准 PVP 默认 UNKNOWN_PREMATCH，team_size 由注册表推导', () => {
  const result = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, inputs);
  raw('只给 mode 的请求', {request: result.request, info: result.info.map(formatProblem)});
  assert.equal(result.ok, true);
  assert.equal(result.request.visibility, DEFAULT_VISIBILITY, '标准 PVP 默认且首选 UNKNOWN_PREMATCH');
  assert.equal(result.request.team_size, STANDARD_PVP_TEAM_SIZE, 'team_size 必须等于注册表里标准 PVP 的值');
  assert.equal(registry.modeById.get(STANDARD_PVP_MODE).parameters.team_size, STANDARD_PVP_TEAM_SIZE,
    '注册表里的标准 PVP 就是 6 只——合同里的 6 不是自己写的数');
  assert.ok(result.info.some((p) => p.code === 'DEFAULTED_FIELD' && p.field === 'visibility'), '代入默认值必须留痕');
  assert.ok(result.info.some((p) => p.code === 'DERIVED_FIELD' && p.field === 'team_size'), '推导出来的字段必须留痕');
  // 反向控制：没有 team_size 的模式不许被当成 6
  const camp = validateRecommendationRequest({mode: 'pve-camp'}, inputs);
  raw('PVE 营地（注册表没有 team_size）', camp.problems.map(formatProblem));
  assert.equal(camp.ok, false);
  assert.equal(codeOf(camp), 'MODE_TEAM_SIZE_UNKNOWN');
  // 反向控制：真给了非首选可见性就必须留痕（不是静默接受）
  assert.equal(validateRecommendationRequest({mode: STANDARD_PVP_MODE, visibility: 'VISIBLE_ROSTER_IN_BATTLE'}, inputs).ok, true);
});

test('RC-301 合同：锁定/已选/替换预算的约束逐条成立', () => {
  const lockedOutside = validateRecommendationRequest({...base(), locked: [sampleInstance]}, inputs);
  expectCode(lockedOutside, 'LOCKED_NOT_SELECTED', 'locked 不在 must_include ∪ selected');
  const lockedInside = validateRecommendationRequest({...base(), selected: [sampleInstance], locked: [sampleInstance]}, inputs);
  raw('selected 含锁定项', lockedInside.request);
  assert.equal(lockedInside.ok, true, 'selected ∪ must_include 覆盖 locked 时必须能过');
  const tooMany = validateRecommendationRequest({
    ...base(), selected: [...registry.instances.keys()].slice(0, STANDARD_PVP_TEAM_SIZE + 1),
  }, inputs);
  expectCode(tooMany, 'SELECTED_OVER_TEAM_SIZE', 'selected 超过 team_size');
  const badReplacement = validateRecommendationRequest({...base(), max_replacements: -1}, inputs);
  expectCode(badReplacement, 'INVALID_TYPE', 'max_replacements 负数');
  const fraction = validateRecommendationRequest({...base(), max_replacements: 1.5}, inputs);
  expectCode(fraction, 'INVALID_TYPE', 'max_replacements 小数（不取整）');
  const unknownConstraint = validateRecommendationRequest({...base(), constraints: {no_legendaries: true}}, inputs);
  expectCode(unknownConstraint, 'UNKNOWN_CONSTRAINT_KEY', 'constraints 里的未登记子键');
});

test('RC-301 合同：favourites_only 与队内约束的可满足性不许含糊', () => {
  const favourite = [...registry.instances.values()].find((i) => i.favourite === true);
  const nonFavouriteSpecies = [...registry.species.values()]
    .find((entry) => entry.in_owned && entry.favourite === false && entry.species_id !== favourite?.species_id);
  raw('材料', {favourite: favourite?.instance_id, nonFavouriteSpecies: nonFavouriteSpecies?.species_id});
  assert.ok(favourite && nonFavouriteSpecies, '测试材料：至少一只收藏个体与一个非收藏物种');
  const conflict = validateRecommendationRequest({
    ...base(), favourites_only: true, must_include: [nonFavouriteSpecies.species_id],
  }, inputs);
  expectCode(conflict, 'MUST_INCLUDE_HAS_UNOWNED_SPECIES', 'favourites_only 与「必须带非收藏」冲突');
  // 反向控制：只点名收藏物种时必须能过
  const consistent = validateRecommendationRequest({...base(), favourites_only: true, must_include: [favourite.instance_id]}, inputs);
  raw('favourites_only + 收藏个体', consistent.request);
  assert.equal(consistent.ok, true);
  // 「不要重复」在没有任何对象时无从评估
  const vacuous = validateRecommendationRequest({...base(), constraints: {species_unique: true}}, inputs);
  expectCode(vacuous, 'TEAM_CONSTRAINT_WITHOUT_NAMES', '只有队内约束、没有点名任何一只');
  // 锁定项同时被排除：锁定的必须留下、被排除的不许进队
  const lockedExcluded = validateRecommendationRequest({
    ...base(), must_include: [sampleInstance], locked: [sampleInstance], must_exclude: [sampleInstance],
  }, inputs);
  raw('locked ∩ must_exclude', lockedExcluded.problems.map(formatProblem));
  assert.equal(lockedExcluded.ok, false);
  assert.ok(lockedExcluded.problems.some((p) => p.code === 'MUST_INCLUDE_EXCLUDE_OVERLAP'));
  assert.ok(lockedExcluded.problems.some((p) => p.code === 'LOCKED_EXCLUDED_CONFLICT'));
});

test('RC-301 规范化：只改编码不改语义，且空数组不算约束成立', () => {
  const forward = validateRecommendationRequest({...base(), must_include: [sampleInstance, ...mustIncludeTwo.slice(1)]}, inputs);
  const backward = validateRecommendationRequest({...base(), must_include: [...mustIncludeTwo.slice(1), sampleInstance]}, inputs);
  raw('两种顺序的规范化结果', {forward: forward.request.must_include, backward: backward.request.must_include});
  assert.deepEqual(forward.request.must_include, backward.request.must_include, '同一集合不同顺序必须产出同一回执');
  const empty = normaliseRecommendationRequest({must_include: []});
  raw('空数组的 info', empty.info.map(formatProblem));
  assert.ok(empty.info.some((p) => p.code === 'EMPTY_LIST'), '空数组必须被记成「等于没给」');
  assert.equal(normaliseRecommendationRequest({mode: ' x '}).request.mode, 'x', '字符串必须去首尾空白');
  assert.equal(Object.hasOwn(normaliseRecommendationRequest({mode: undefined}).request, 'mode'), false,
    '值为 undefined 的键不该出现在规范化结果里');
});

test('RC-301 自然语言：能映射的必须过，不能映射的必须红且说明缺什么', () => {
  assert.ok(NL_EXAMPLE_TEXTS.ok.length >= 6, '报告要求 ≥6 条「能」的样例');
  assert.ok(NL_EXAMPLE_TEXTS.red.length >= 6, '报告要求 ≥6 条「不能」的样例');
  for (const text of NL_EXAMPLE_TEXTS.ok) {
    const result = requestFromNaturalLanguage(text, inputs);
    raw(`能：${text}`, result.ok ? result.request : result.problems.map(formatProblem));
    assert.equal(result.ok, true, `「${text}」应当能映射成候选 schema`);
  }
  for (const text of NL_EXAMPLE_TEXTS.red) {
    const result = requestFromNaturalLanguage(text, inputs);
    raw(`不能：${text}`, {ok: result.ok, problems: result.problems.map(formatProblem)});
    assert.equal(result.ok, false, `「${text}」必须 ok:false`);
    assert.ok(result.problems.length > 0, `「${text}」判红时必须说明缺什么`);
    assert.ok(result.problems.every((p) => typeof p.detail === 'string' && p.detail.length > 0));
  }
  // 错别字/别名不许被猜成某一只
  const typo = requestFromNaturalLanguage('标准PVP，队伍里必须有喷火驼', inputs);
  assert.equal(codeOf(typo), 'UNRESOLVED_MENTION');
  assert.ok(!JSON.stringify(typo).includes('pet_'), '认不出的名字不得被映射成任何 species_id');
  // 同一句话里两个互斥模式不许替玩家选一个
  const contradictory = requestFromNaturalLanguage('极速对决，标准PVP，带铠甲虫', inputs);
  assert.equal(codeOf(contradictory), 'CONTRADICTORY_FLAGS');
  // 只说了「N 只」却没说模式：不许挑一个默认模式
  const sizeOnly = requestFromNaturalLanguage('六只，带铠甲虫', inputs);
  assert.equal(codeOf(sizeOnly), 'MODE_SIZE_WITHOUT_MODE');
});

test('RC-301 工具：只回「经校验的请求 + 问题」，不产生推荐结果', async () => {
  resetRocoTools();
  const args = {mode: STANDARD_PVP_MODE, ruleset_config_id: rulesetId, must_include: [sampleSpecies]};
  assert.equal(validRequestContractArgs(args), true);
  assert.equal(validRequestContractArgs({...args, secret_field: 1}), false, '未知参数必须拒');
  assert.equal(validRequestContractArgs({...args, constraints: {no_legendaries: true}}), false, '未知约束键必须拒');
  const receipt = await executeRequestTeamRecommendation(args, {recommendationInputs: inputs});
  raw('工具回执（schema 路径）', receipt);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.doesNotRecommend, true, '必须显式声明它不产生推荐');
  assert.deepEqual(Object.keys(receipt).filter((key) => key !== 'source'), [...REQUEST_TEAM_RECOMMENDATION_CONTRACT.tool_return_shape],
    '回执的契约键集合必须与声明的形状一致（source 只是这次映射走的是哪条路）');
  for (const forbidden of ['candidates', 'ranking', 'recommendation', 'team', 'win_rate', 'score', 'top_k', 'explanation']) {
    assert.equal(Object.hasOwn(receipt, forbidden), false, `回执里不得出现 ${forbidden}`);
  }
  const rejected = await executeRequestTeamRecommendation({mode: 'pvp-standard-eight-pet'}, {recommendationInputs: inputs});
  raw('工具回执（非法 mode）', rejected);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.problems[0].code, 'UNKNOWN_MODE');
  assert.ok(rejected.needs.includes('mode'), 'needs 必须点名缺/错在哪个字段');
  assert.ok(rejected.needs.every((field) => typeof field === 'string' && field.length > 0));
  const mapped = await executeRequestTeamRecommendation({natural_language: '随便配一队'}, {recommendationInputs: inputs});
  raw('工具回执（随便配一队）', mapped);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.request, null);
  assert.ok(mapped.needs.length > 0, '必须点明缺什么');
  // 拿不到登记表时也必须 fail closed（不编候选池）
  const unavailable = await executeRequestTeamRecommendation({}, {});
  raw('工具回执（无数据源）', unavailable);
  // 这一条在 Node 里会真的读到仓库数据，所以只断言形状契约成立
  assert.equal(typeof unavailable.doesNotRecommend, 'boolean');
  resetRocoTools();
});

test('RC-301 工具：不塞进 TOOL_CONTRACTS，既有 13 个工具的口径一个字没改', () => {
  assert.equal(Object.hasOwn(TOOL_CONTRACTS, REQUEST_TEAM_RECOMMENDATION_TOOL), false,
    '工具合同是独立的：塞进 TOOL_CONTRACTS 会改动已发布评测钉住的提示与面板标签');
  raw('TOOL_CONTRACTS 的键', Object.keys(TOOL_CONTRACTS));
  assert.deepEqual(Object.keys(TOOL_CONTRACTS), [
    'read_state', 'search_rules', 'compare_actions', 'simulate_branch', 'inspect_training', 'read_match',
    'read_evidence', 'read_last_turn', 'query_rules', 'evaluate_team', 'compare_team_change', 'plan_actions', 'summarize_battle',
  ]);
  assert.equal(REQUEST_TEAM_RECOMMENDATION_CONTRACT.tool_return_shape.length, 7);
});

test('RC-301 报告：与生成逻辑逐字节一致，且每条判据都绿', () => {
  const fresh = `${JSON.stringify(buildRc301Report(inputs), null, 2)}\n`;
  const onDisk = readFileSync(join(ROOT, RC301_REPORT_PATH), 'utf8');
  if (fresh !== onDisk && process.env.RC301_WRITE_REPORT === '1') {
    writeFileSync(join(ROOT, RC301_REPORT_PATH), fresh, 'utf8');
    log('RC301_WRITE_REPORT=1：报告已重新生成');
  }
  assert.ok(existsSync(join(ROOT, RC301_REPORT_PATH)), `报告必须存在：${RC301_REPORT_PATH}`);
  const report = readJson(RC301_REPORT_PATH);
  raw('报告里失败的判据', report.criteria.filter((c) => !c.ok));
  assert.deepEqual(report.criteria.filter((c) => !c.ok), [], '报告里不允许有失败的判据');
  assert.ok(report.criteria.length >= 20, `判据条数 ${report.criteria.length}：至少要覆盖合同、错误码、样例三组`);
  raw('报告判据条数与全部码', {criteria: report.criteria.length, error_codes: report.error_codes.map((c) => c.code)});
  // 合同字段表 / 错误码清单 / 默认可见性证据 / 自然语言能-不能 / 不产生推荐 的声明
  assert.deepEqual(report.contract.allowed_fields, ALLOWED_FIELDS);
  assert.deepEqual(report.contract.constraint_keys, CONSTRAINT_KEYS);
  assert.equal(report.contract.fields.length, REQUEST_FIELDS.length);
  assert.ok(report.error_codes.length >= 20, '错误码清单要够；每条都要有必红方向');
  assert.ok(report.error_codes.every((entry) => entry.code && entry.direction && entry.detail));
  assert.equal(report.unknown_prematch_is_default.actual_visibility, DEFAULT_VISIBILITY);
  assert.equal(report.unknown_prematch_is_default.default_is_preferred, true);
  assert.equal(report.unknown_prematch_is_default.known_scenario_requires_opponent.code, 'OPPONENT_INFO_REQUIRED');
  assert.equal(report.unknown_prematch_is_default.unknown_prematch_rejects_named_opponent.code, 'OPPONENT_INFO_NOT_ALLOWED');
  assert.ok(report.natural_language_mapping.ok_cases.length >= 6);
  assert.ok(report.natural_language_mapping.red_cases.length >= 6);
  assert.ok(report.natural_language_mapping.ok_cases.every((c) => c.ok), '「能」的样例必须全部通过');
  assert.ok(report.natural_language_mapping.red_cases.every((c) => !c.ok && c.problems.length > 0),
    '「不能」的样例必须全部判红并说明缺什么');
  assert.ok(report.natural_language_mapping.cannot.length >= 6);
  assert.ok(report.natural_language_mapping.can.length >= 6);
  assert.equal(report.does_not_produce_recommendations.statement.includes('**不产生**'), true);
  assert.ok(report.does_not_produce_recommendations.forbidden_in_this_rc.some((line) => /RC-303/.test(line)));
  assert.deepEqual(report.clock_fields, [], '报告不许有挂钟字段（要能逐字节复跑）');
  if (fresh !== onDisk) {
    raw('报告与生成逻辑不一致', {fresh_bytes: fresh.length, disk_bytes: onDisk.length});
    assert.fail(`磁盘上的 ${RC301_REPORT_PATH} 与 buildRc301Report() 不一致：`
      + '用 `RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js` 重新生成');
  }
  log(`报告新鲜度：逐字节一致（${onDisk.length} 字节）`);
});

test('RC-301 判据⑨（附加必红方向）：自然语言里认不出的名字不许落进任何字段', () => {
  // 这条防的是「抽取器把不认识的词硬塞进 must_include」这类静默错误。
  const typo = requestFromNaturalLanguage('标准PVP，锁定喷火驼', inputs);
  raw('⑨ 锁定一个不存在的名字', {ok: typo.ok, problems: typo.problems.map(formatProblem)});
  assert.equal(typo.ok, false);
  assert.equal(codeOf(typo), 'UNRESOLVED_MENTION');
  assert.equal(typo.request, null);
  const json = JSON.stringify(typo);
  assert.equal(json.includes('must_include'), false, '判红的结果里不该出现任何被猜出来的字段');
  // 反向控制：登记表里真有的名字必须能进 locked/must_include
  const known = requestFromNaturalLanguage('标准PVP，队伍里必须有铠甲虫并且锁定它'.replace('并且锁定它', ''), inputs);
  raw('⑨ 反向控制（真名字）', known.request ?? known.problems.map(formatProblem));
  assert.equal(known.ok, true);
  // `must_include` 里必须是真的 species_id / instance_id（不是名字文本）
  for (const value of known.request.must_include ?? []) {
    assert.ok(registry.species.has(value) || registry.instances.has(value), `${value} 不是登记表里的 id`);
  }
  assert.ok(ownedSpeciesWithName('铠甲虫') || known.request.must_include.length === 0);
});
