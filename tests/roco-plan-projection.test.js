// D-27（2026-09-30）· `expected` / `worst` / `best` / `first_second_margin` 的**三层契约对齐**判据。
//
// 缺陷现场（harness-verifier 在 `bbde1b8` 上独立确认，Lead 采纳）：
//   引擎 `/battle/plan` 的真回执：`expected{min,max,mean}` · `worst{min,max}` ·
//     `first_second_margin{min,max,mean,scale,note}` ⇒ **全是对象**；
//   客户端 `src/client/roco.js` 的 `coachRocoPlan()`：`Number.isFinite` 过滤 ⇒ 三个对象**全丢**；
//   服务端 `src/server/index.js` 的 `validateChat`：标量通过、**对象被 400**；
//   教练层 `src/coach/toolbox.js`：按 `first_second_margin?.mean` 读 ⇒ 等的是对象。
//   ⇒ 同一批字段，三层三种说法。
//
// 裁决口径：**保留区间对象**（与 03/04 的「范围 + 尾部」一致）；页面侧本来就按对象读
// （`src/coach/roco-experience.js:131-158` 逐字写着这是「第 21、30 轮之后同一形状问题的第三次复现」）。
//
// 本判据量的四件事（每条都从**真实现**跑，不另写一份投影）：
//   ① 投影键集**逐字等于**白名单（含全部字段的那一份）；
//   ② 缺字段要能看出「缺」：`plan_capabilities` 逐字段 `present`/`absent`/`invalid`；
//      尤其 04.4 的 `is_probability` 拿不到时只能是 `absent` —— **绝不许伪造 false**；
//   ③ 非法形状**不搬、不猜**（字符串/数组/缺 min 或 max 的对象 ⇒ `invalid` 且键不出现）；
//   ④ 对象形过得了 `validateChat`；字符串/数组/布尔/半截对象**仍然被拒**。
//
// 抽法沿用本仓既有约定（`tests/roco-page-ux.test.js` 的 `topLevelFunctionCode`、
// `tests/roco-standard-pvp-battle.test.js` 的 `extractSampleDamageOf`）：从 `roco.js` 源码里
// 把**自包含**的纯函数整段抠出来跑 —— `roco.js` 顶层要 `document`，不能 import。
//
// 跑法：node --test tests/roco-plan-projection.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {validateChat} from '../src/server/index.js';

const ROOT = new URL('../', import.meta.url);
const PAGE = readFileSync(new URL('src/client/roco.js', ROOT), 'utf8');
const SERVER_SRC = readFileSync(new URL('src/server/index.js', ROOT), 'utf8');

/** 从页面源码里抠出一个**顶层函数声明**（配平从函数体那个 `{` 算起，先跳过参数表）。 */
function extractFunction(name) {
  const start = PAGE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `roco.js 里找不到 function ${name}(...)：它被改名或删了，这条判据已经失效`);
  const parenStart = PAGE.indexOf('(', start);
  let parens = 0;
  let bodyStart = -1;
  for (let i = parenStart; i < PAGE.length; i += 1) {
    if (PAGE[i] === '(') parens += 1;
    else if (PAGE[i] === ')') {
      parens -= 1;
      if (parens === 0) { bodyStart = PAGE.indexOf('{', i); break; }
    }
  }
  assert.ok(bodyStart > 0, `function ${name} 没有函数体`);
  let depth = 0;
  for (let i = bodyStart; i < PAGE.length; i += 1) {
    if (PAGE[i] === '{') depth += 1;
    else if (PAGE[i] === '}') {
      depth -= 1;
      if (depth === 0) return PAGE.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 的大括号没有配平（抽取失败）`);
}

const projectRocoPlan = new Function(`return (${extractFunction('projectRocoPlan')})`)();
const coachRocoPlanCode = extractFunction('coachRocoPlan');

/** 投影输出的**逐字白名单**（改了投影必须显式改这一行 —— 新字段是新契约）。 */
const PROJECTION_KEYS = ['analysis_seeds', 'basis', 'best', 'branches_evaluated', 'coverage',
  'damage_preview', 'depth_searched', 'expected', 'first_second_margin', 'is_probability',
  'limitations', 'main_counter', 'plan_capabilities', 'recommendation', 'recommendation_stable',
  'recommended_by_seed', 'risk', 'state_version', 'timed_out', 'truncation', 'unsupported', 'worst'];

/** 一份**含全部契约字段**的引擎回执（形状逐条对照 `service.py:2383-2440` 的聚合块）。 */
const FULL_PLAN = {
  state_version: 41,
  recommendation: '龙血',
  main_counter: '换上第2位',
  expected: {min: 0.1, max: 0.9, mean: 0.5},
  worst: {min: -0.3, max: 0.1},
  best: {min: 1.0, max: 1.2},
  first_second_margin: {min: 0.05, max: 0.09, mean: 0.07, scale: 'one-ply-value',
    note: '枚举第一与第二名的估值差（一手推演尺度），不是胜率'},
  branches_evaluated: 24,
  depth_searched: 2,
  recommendation_stable: true,
  timed_out: false,
  // `damage_preview` 的键集照**真回执**（探针读数，"damage_preview":{available,min,max,best_label,
  // lethal,lethal_stable,foe_hp,formula_verified,damage_model,samples,…}；成功路径**没有** reason）。
  damage_preview: {available: true, min: 101, max: 216, best_label: '翅刃',
    lethal: false, formula_verified: false,
    samples: [{label: '翅刃', min: 216, max: 216}, {label: '啃咬', min: 101, max: 101}]},
  risk: {fragile: true, downside_min: 0.11, downside_max: 0.44, threshold: 1.2,
    top_risks: [{opponent_action: '诡刺'}]},
  coverage: 1,
  limitations: ['估值是启发式局面分，不是胜率'],
  unsupported: [{reason: '至少一个 analysis seed 未在预算内搜完'}],
  recommended_by_seed: {11: '龙血', 29: '龙血'},
  analysis_seeds: [11, 29],
  // 04.4 / 04.3 的机器判据：现在引擎**还没有**这两项，这里故意给全，用来钉「有就搬」。
  is_probability: false,
  truncation: {dropped_by_kind: {}, rule: 'beam'},
  basis: ['heuristic-distribution'],
};

test('① 含全部字段的 plan ⇒ 投影键集**逐字等于**白名单，且每个字段都标 present', () => {
  const projected = projectRocoPlan(FULL_PLAN);
  assert.deepEqual(Object.keys(projected).sort(), PROJECTION_KEYS,
    `投影键集与白名单不一致（多/少字段都要显式改白名单）：${JSON.stringify(Object.keys(projected).sort())}`);
  const caps = projected.plan_capabilities;
  assert.deepEqual(Object.keys(caps).sort(), PROJECTION_KEYS.filter((k) => k !== 'plan_capabilities').sort(),
    'plan_capabilities 必须覆盖白名单里除自己以外的**每一个**字段');
  const notPresent = Object.entries(caps).filter(([, v]) => v !== 'present');
  assert.deepEqual(notPresent, [], `全字段 plan 下不该有非 present 的标注：${JSON.stringify(notPresent)}`);
});

test('② 区间对象**按形状原样搬**（不再是 Number.isFinite 过滤掉）', () => {
  const projected = projectRocoPlan(FULL_PLAN);
  assert.deepEqual(projected.expected, {min: 0.1, max: 0.9, mean: 0.5}, 'expected 的区间对象必须原样进投影');
  assert.deepEqual(projected.worst, {min: -0.3, max: 0.1});
  assert.deepEqual(projected.best, {min: 1.0, max: 1.2});
  assert.deepEqual(projected.first_second_margin, FULL_PLAN.first_second_margin,
    'first_second_margin 的 scale/note 也要跟着走（判定层与页面都要读 mean）');
  // 反证：探针本身要对「标量」有区分度 —— 老行为（只收有限数）在这份输入上必然丢掉这三项。
  const scalarOnly = (plan) => {
    const out = {state_version: plan.state_version};
    for (const key of ['expected', 'worst', 'best', 'first_second_margin']) {
      if (Number.isFinite(plan[key])) out[key] = plan[key];
    }
    return out;
  };
  assert.equal('expected' in scalarOnly(FULL_PLAN), false,
    '老写法（Number.isFinite）在这份输入上必须丢掉 expected —— 否则这条判据量不到东西');
});

test('③ 追加进白名单的字段真的到了教练层（含 formula_verified / threshold / top_risks）', () => {
  const projected = projectRocoPlan(FULL_PLAN);
  assert.equal(projected.coverage, 1);
  assert.deepEqual(projected.limitations, FULL_PLAN.limitations);
  assert.deepEqual(projected.unsupported, FULL_PLAN.unsupported);
  assert.deepEqual(projected.recommended_by_seed, {11: '龙血', 29: '龙血'});
  assert.deepEqual(projected.analysis_seeds, [11, 29]);
  assert.equal(projected.damage_preview.formula_verified, false,
    '「公式核验过没有」必须跟着预览一起到教练层（否则建议层分不清估算与已核验）');
  assert.equal(projected.risk.threshold, 1.2, 'fragile 的产品阈值要一起给（它不是游戏机制）');
  assert.deepEqual(projected.risk.top_risks, [{opponent_action: '诡刺'}]);
});

test('④ 缺 is_probability ⇒ **absent** 标注、键不出现、绝不伪造 false', () => {
  const {is_probability, truncation, basis, ...without} = FULL_PLAN;
  const projected = projectRocoPlan(without);
  assert.equal(Object.hasOwn(projected, 'is_probability'), false, '源里没有这一项就不许凭空造一个键');
  assert.equal(projected.is_probability, undefined, 'absent ≠ false');
  assert.equal(projected.plan_capabilities.is_probability, 'absent',
    '拿不到必须是「缺」这个事实本身，而不是一个看起来像结论的 false');
  assert.equal(projected.plan_capabilities.truncation, 'absent');
  assert.equal(projected.plan_capabilities.basis, 'absent');
  // 对照（另一向）：源里**真的写了** false ⇒ 如实搬过来并标 present。
  const withFalse = projectRocoPlan(FULL_PLAN);
  assert.equal(withFalse.is_probability, false);
  assert.equal(withFalse.plan_capabilities.is_probability, 'present',
    '「明确声明了 false」与「压根没有这一项」必须是两种可区分的状态');
});

test('⑤ 非法形状不搬、不猜：标成 invalid 且键不出现', () => {
  const cases = [
    ['expected 是字符串', {expected: '高'}, 'expected'],
    ['expected 是数组', {expected: [0.1, 0.9]}, 'expected'],
    ['expected 缺 max', {expected: {min: 0.1}}, 'expected'],
    ['expected 是布尔', {expected: true}, 'expected'],
    ['first_second_margin 只有 note', {first_second_margin: {note: 'x'}}, 'first_second_margin'],
    ['limitations 是字符串', {limitations: '不是胜率'}, 'limitations'],
    ['analysis_seeds 是字符串', {analysis_seeds: '11,29'}, 'analysis_seeds'],
    ['recommended_by_seed 是数组', {recommended_by_seed: ['龙血']}, 'recommended_by_seed'],
    ['damage_preview.available 不是布尔', {damage_preview: {available: 'yes'}}, 'damage_preview'],
    ['risk 是数组', {risk: [{fragile: true}]}, 'risk'],
    ['is_probability 是字符串', {is_probability: 'no'}, 'is_probability'],
  ];
  for (const [why, patch, key] of cases) {
    const projected = projectRocoPlan({...FULL_PLAN, ...patch});
    assert.equal(projected.plan_capabilities[key], 'invalid', `${why} ⇒ 必须标 invalid`);
    assert.equal(Object.hasOwn(projected, key), false, `${why} ⇒ 不许把这个键搬进投影`);
  }
  // 半截区间不许被「补齐」成合法区间（补 0 / 补 max 都是编数据）。
  const half = projectRocoPlan({expected: {min: 0.1}});
  assert.equal(half.expected, undefined);
  assert.notDeepEqual(half.expected, {min: 0.1, max: 0});
});

test('⑥ 边界不变：样本 ≤8、top_risks ≤3、名字裁长、空 risk 不硬塞一个键', () => {
  const many = projectRocoPlan({...FULL_PLAN,
    damage_preview: {available: true, samples: Array.from({length: 9}, (_, i) => ({label: `s${i}`, min: i}))},
    risk: {top_risks: Array.from({length: 4}, (_, i) => ({opponent_action: `a${i}`}))}});
  assert.equal(many.damage_preview.samples.length, 8, '样本上限 8 条（与 validateChat 同一条口径）');
  assert.equal(many.risk.top_risks.length, 3, 'top_risks 上限 3 条（与 /api/roco/plan 同一条口径）');
  const emptyRisk = projectRocoPlan({...FULL_PLAN, risk: {}});
  assert.equal(Object.hasOwn(emptyRisk, 'risk'), false, 'risk 里一个契约字段都没有 ⇒ 不搬空对象');
  assert.equal(emptyRisk.plan_capabilities.risk, 'invalid', '搬不动也要如实说是哪一项没搬');
  assert.equal(projectRocoPlan(null).plan_capabilities.expected, 'absent', 'null / 非对象 ⇒ 全 absent，不抛');
});

/** 一份 `/api/coach` 请求体（`validateChat` 的输入形状）。 */
function chatBody(plan) {
  return {message: '这回合该防御还是换宠？', role: 'companion',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]},
      roco_battle: {turn: 3, phase: 'battle', result: null, state_version: 41,
        self: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 120, max_hp: 180, energy: 4, alive: true}],
        self_active: 0, legal: [{label: '龙血', kind: 'skill'}]},
      roco_plan: plan},
    memory: {version: 1}};
}

/** `/api/roco/plan` **页面回执**的真实形状：可选字段恒写 `?? null`（`roco-service.js:2974-2992`）。 */
const PAGE_RECEIPT = {...FULL_PLAN,
  damage_preview: {available: true, reason: null, min: 101, max: 216, best_label: '翅刃',
    lethal: false, lethal_stable: true, foe_hp: 413, formula_verified: false,
    damage_model: 'community-hypothesis-v1', note: '原始伤害范围…',
    samples: [{label: '翅刃', min: 216, max: 216}], skipped_skills: [], candidates: 2}};

/** 引擎这一手**算不出**预览时页面回执的样子：除 `available:false` 外全是 null。 */
const PAGE_RECEIPT_UNAVAILABLE = {...FULL_PLAN,
  damage_preview: {available: false, reason: null, min: null, max: null, best_label: null,
    lethal: false, lethal_stable: false, foe_hp: null, formula_verified: false,
    damage_model: null, note: null, samples: [], skipped_skills: [], candidates: null}};

test('⑦ 对象形过 validateChat；字符串/数组/布尔/半截对象**仍然被拒**', () => {
  const bodyWith = chatBody;
  // 真回执形状（引擎现在真的发这个）⇒ 必须放行；否则玩家一开规划，整条 /api/coach 就 400。
  assert.doesNotThrow(() => validateChat(bodyWith(FULL_PLAN)), '引擎真实的对象形区间必须放行');
  // 投影之后再送来（页面走的正是这一条）⇒ 也必须放行。
  assert.doesNotThrow(() => validateChat(bodyWith(projectRocoPlan(FULL_PLAN))), '投影后的形状必须放行');
  // 旧标量写法是兼容阶梯，不是被删掉的旧行为。
  assert.doesNotThrow(() => validateChat(bodyWith({...FULL_PLAN,
    expected: 0.62, worst: 0.31, first_second_margin: 0.08})), '旧标量写法仍要放行（兼容）');
  const bad = [
    ['expected 是字符串', {expected: '高'}],
    ['expected 是数组', {expected: [0.1, 0.9]}],
    ['expected 缺 max', {expected: {min: 0.1}}],
    ['expected 是布尔', {expected: true}],
    ['worst 是字符串', {worst: '低'}],
    ['first_second_margin 缺 min', {first_second_margin: {max: 0.09}}],
  ];
  for (const [why, patch] of bad) {
    assert.throws(() => validateChat(bodyWith({...FULL_PLAN, ...patch})), /本回合规划无效/,
      `${why} 必须被拒（接受对象形 ≠ 放宽成不校验）`);
  }
  // 结构判据：对象形的接受写在 validateChat 里，而不是靠「碰巧过」。
  assert.match(SERVER_SRC, /const rangeShape=\(v\)=>/,
    '服务端要有一处显式的区间形状判定（改回只收标量 ⇒ 这里红）');
});

test('⑧ 反漂移：投影是**唯一**入口，coachRocoPlan 不许再自己搬一遍字段', () => {
  assert.match(coachRocoPlanCode, /projectRocoPlan\(plan\)/,
    'coachRocoPlan 必须走 projectRocoPlan（否则两层会再次各说一套形状）');
  assert.match(coachRocoPlanCode, /rocoPlanFreshness\(\{plan, view\}\)\.usable/,
    '新鲜度判定必须还在（过期的一份都不许送）');
  assert.match(coachRocoPlanCode, /if \(!plan \|\| !view\) return null;/);
  assert.doesNotMatch(coachRocoPlanCode, /Number\.isFinite\(plan\[/,
    'coachRocoPlan 里不许再出现「按有限数过滤」的老写法（那正是丢掉三个区间对象的根因）');
});

test('⑨ `null` = 「引擎没给这一项」⇒ 放行；对象/数组/数字/布尔**仍然被拒**（D-27 裁决③）', () => {
  // 为什么单列一条：页面那一侧的回执对 damage_preview 的可选字段**恒写 `?? null`**
  // （`src/server/roco-service.js:2979` reason · `:2980-2981` min/max · `:2982` best_label ·
  //  `:2985` foe_hp）。今天从页面送出来的都是投影（投影不留 null），但「照着 /api/roco/plan 的
  //  回执原样送」是一条自然路径 —— 那条路以前会吃 400「本回合规划无效」，而理由看着像 bug。
  assert.doesNotThrow(() => validateChat(chatBody(PAGE_RECEIPT)),
    '页面回执原样送（reason/min/max/best_label/foe_hp 都是真值或 null）必须放行');
  assert.doesNotThrow(() => validateChat(chatBody(PAGE_RECEIPT_UNAVAILABLE)),
    '引擎算不出预览那一档（除 available 外全是 null）也必须放行');
  // 投影侧同样要能处理这份回执：null 不进投影（不搬、也不伪造 0）。
  const projectedUnavailable = projectRocoPlan(PAGE_RECEIPT_UNAVAILABLE);
  assert.equal(projectedUnavailable.damage_preview.available, false);
  for (const key of ['reason', 'min', 'max', 'best_label', 'foe_hp']) {
    assert.equal(Object.hasOwn(projectedUnavailable.damage_preview, key), false,
      `null 不许被搬进投影（${key}）—— 「没给」不是「给了个 null」`);
  }
  assert.equal(projectedUnavailable.plan_capabilities.damage_preview, 'present',
    'damage_preview 这一项本身是「有」（available 是合法布尔），缺的是里面那几个可选字段');
  // 另一向：**非法形状**不许借 null 这条口子溜进去。
  const bad = [
    ['reason 是对象', {reason: {}}],
    ['reason 是数字', {reason: 3}],
    ['best_label 是数字', {best_label: 7}],
    ['best_label 是数组', {best_label: ['翅刃']}],
    ['min 是字符串', {min: '101'}],
    ['min 是布尔', {min: true}],
    ['foe_hp 是数组', {foe_hp: []}],
  ];
  for (const [why, patch] of bad) {
    assert.throws(() => validateChat(chatBody({...PAGE_RECEIPT,
      damage_preview: {...PAGE_RECEIPT.damage_preview, ...patch}})), /本回合规划无效/,
      `${why} 必须被拒（null 放行 ≠ 什么形状都放行）`);
  }
  // 现状边界（**不是**本次裁决要改的东西，如实钉住免得被误读成"空串也该拒"）：
  // 空串是合法字符串 ⇒ 照旧放行。本切片只改 `null`，不动「字符串长度」这条口径。
  assert.doesNotThrow(() => validateChat(chatBody({...PAGE_RECEIPT,
    damage_preview: {...PAGE_RECEIPT.damage_preview, reason: ''}})),
    '空串按字符串放行（既有口径，本切片不动）');
});
