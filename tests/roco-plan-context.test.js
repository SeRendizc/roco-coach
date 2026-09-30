// 引擎本回合的规划进教练上下文的判据（2026-09-25）。
//
// 背景：六宠对局里引擎已经把这一手算好了（推荐 / 主要应对 / 预期 / 最坏 / 边际量 / 伤害预览），
// 页面把它画在**军师浮条**上；而教练聊天一点都拿不到。同一类缺口这一轮是第三件
// （前两件：战况快照 C6.97、名单/阵容 C6.98/C6.99）。
//
// 判据：
//   ① 校验（加性）：合法规划放行；畸形逐条 400「本回合规划无效」。
//   ② **跨字段对齐**：规划与战况必须属于同一版局面 —— 版本不一致必须 400（并点名两边的版本）。
//      这是"引擎的结论去讲一个已经不存在的局面"的唯一防线。
//   ③ 进包：`context.roco_plan` ⇒ `packet.rocoPlan` 原样；不带时**不出现**这个键。
//   ④ 事实守卫认得规划里的数字（与 `rocoBattle`/`roster` 同一个坑，这次一起做掉）。
//   ⑤ 结构性：页面**只送新鲜的那一份**（复用 `rocoPlanFreshness`），过期/无版本一律不送。
// 必红反证：版本不一致时若不判 ②，同一份输入必须能通过（证明 ② 量的就是那件事）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {runCoach, buildContext, checkGroundedAnswer} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {validateChat} from '../src/server/index.js';
import {createRocoClient, findHiddenKeys, ROCO_ERROR} from '../src/coach/roco-client.js';
import {
  planActionsViaPlanner, executeTool, configureRocoTools, resetRocoTools,
  readFirstSecondMargin, rocoPlanCacheKey, rocoPlanCacheSize, normalizeOpponentScenarioRows,
  validToolArgs,
} from '../src/coach/toolbox.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');

const BATTLE = {
  turn: 3, phase: 'battle', result: null, state_version: 7,
  self: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 120, max_hp: 180, energy: 4, alive: true}],
  self_active: 0,
  legal: [{label: '啃咬', kind: 'skill'}],
};
const PLAN = {
  state_version: 7,
  recommendation: '啃咬',
  main_counter: '对手可能换上潮甲龟',
  expected: 0.62,
  worst: 0.31,
  first_second_margin: 0.08,
  branches_evaluated: 24,
  recommendation_stable: true,
  damage_preview: {available: true, min: 101, max: 216, best_label: '翅刃', lethal: false,
    samples: [{label: '翅刃', min: 216, max: 216}, {label: '啃咬', min: 101, max: 101}]},
  risk: {fragile: true, downside_min: 0.11, downside_max: 0.44},
};

// `battle` 用 `null` 表示"不带战况"：**不能用 `undefined`** ——
// JS 的默认参数在显式传 `undefined` 时照样生效，会把"无战况"那一路悄悄变成"有战况"。
function bodyWith(plan, battle = BATTLE) {
  const context = {mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}};
  if (battle) context.roco_battle = battle;
  if (plan !== undefined) context.roco_plan = plan;
  return {message: '这回合该防御还是换宠？', role: 'companion', context, memory: {version: 1}};
}

test('① 加性校验：合法规划放行，畸形逐条 400', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(PLAN)), '合法规划必须放行');
  assert.doesNotThrow(() => validateChat(bodyWith(undefined)), '不带这个字段时照旧放行');
  const bad = [
    ['不是对象', 'x'],
    ['缺 state_version', {...PLAN, state_version: undefined}],
    ['state_version 不是整数', {...PLAN, state_version: 1.5}],
    ['recommendation 空串', {...PLAN, recommendation: ''}],
    ['expected 不是数', {...PLAN, expected: '高'}],
    ['recommendation_stable 不是布尔', {...PLAN, recommendation_stable: 'yes'}],
    ['damage_preview 缺 available', {...PLAN, damage_preview: {min: 1}}],
    ['样本超过 8 条', {...PLAN, damage_preview: {available: true, samples: Array.from({length: 9}, () => ({label: '啃咬'}))}}],
    ['样本缺 label', {...PLAN, damage_preview: {available: true, samples: [{min: 1}]}}],
    ['risk.fragile 不是布尔', {...PLAN, risk: {fragile: 'y'}}],
  ];
  for (const [why, payload] of bad) {
    assert.throws(() => validateChat(bodyWith(payload)), /本回合规划无效/, `${why} 必须被拒绝`);
  }
});

test('② 跨字段对齐：规划与战况不是同一版局面 ⇒ 400，并点名两边的版本', () => {
  const mismatched = {...PLAN, state_version: 6};
  assert.throws(() => validateChat(bodyWith(mismatched)), /与战况不是同一版局面/,
    '版本不一致必须拒收（否则引擎的结论会去讲一个已经不存在的局面）');
  try {
    validateChat(bodyWith(mismatched));
  } catch (error) {
    assert.match(String(error.message), /6/, '消息里要有规划的版本');
    assert.match(String(error.message), /7/, '消息里要有战况的版本');
  }
  assert.doesNotThrow(() => validateChat(bodyWith({...PLAN, state_version: 7})), '版本一致必须放行');
  // 没送战况时没有可对齐的对象 —— 只校验规划自身。
  assert.doesNotThrow(() => validateChat(bodyWith({...PLAN, state_version: 99}, null)),
    '没有战况就没有可对齐的对象 —— 只校验规划自身');
});

test('③ 进包：带 roco_plan 时原样进 packet.rocoPlan，不带时这个键不出现', async () => {
  let withPlan = null;
  await runCoach({
    message: '这回合怎么打',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}, roco_plan: PLAN},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withPlan = packet; return '按规划说。'; }},
  });
  assert.deepEqual(withPlan.rocoPlan, PLAN, '引擎的规划必须原样进包（不许改写数值）');

  let without = null;
  await runCoach({
    message: '这回合怎么打',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp'},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { without = packet; return '按规划说。'; }},
  });
  assert.equal('rocoPlan' in without, false, '没有规划时不许出现这个键');
});

test('④ 事实守卫必须认得规划里的数字（否则引用引擎结论会被判成凭空）', () => {
  const answer = {
    text: '引擎给的是「翅刃」216、备选「啃咬」101。',
    evidence: [], toolTrace: [], publicState: null, latestEvents: [], textFacts: null,
  };
  const without = checkGroundedAnswer({...answer});
  assert.equal(without.valid, false, '不带规划时这些数字必须判成凭空（守卫的原有职责）');
  const withPlan = checkGroundedAnswer({...answer, rocoPlan: PLAN});
  assert.equal(withPlan.valid, true,
    `带上规划后必须可追溯，实际理由：${JSON.stringify(withPlan.reasons)}`);
});

test('⑤ 结构性：页面只送新鲜的那一份，且必须带 state_version', () => {
  assert.match(CLIENT_SRC, /function coachRocoPlan\(\)/, '客户端必须有一个独立的规划快照函数');
  assert.match(CLIENT_SRC, /rocoPlanFreshness\(\{plan, view\}\)\.usable/,
    '必须复用页面自己的新鲜度判定（过期的一份都不许送）');
  assert.match(CLIENT_SRC, /if \(!plan \|\| !view\) return null;/, '没有规划或没有局面时返回 null');
  assert.match(CLIENT_SRC, /if \(rocoPlan\) context\.roco_plan = rocoPlan;/,
    '拿不到就不加这个字段（营地/三宠那两条老路一字不变）');
  // 战况快照必须带 state_version，否则服务端无法做跨字段对齐。
  assert.match(CLIENT_SRC, /state_version: view\.state_version/, '战况快照要带上局面版本');
});

test('必红反证：把规划的版本改成与战况一致，② 必须不再报错', () => {
  assert.throws(() => validateChat(bodyWith({...PLAN, state_version: 5})), /与战况不是同一版局面/);
  assert.doesNotThrow(() => validateChat(bodyWith({...PLAN, state_version: 7})),
    '只有版本真的不一致时才拒 —— 一致时必须放行');
});

test('⑥ 规划进包时附一条**来源说明**（只在有规划时出现，且不含结论）', async () => {
  // 实测依据：同一句话连跑 6 次，改前 4 次引用引擎、2 次说「我不冒充引擎 / 我没有数据」——
  // 它手里其实有。加一条只讲「这份数据是什么、可以引用」的说明之后 **6/6 引用**。
  let withPlan = null;
  await runCoach({
    message: '这回合怎么打',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}, roco_plan: PLAN},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withPlan = packet; return '按规划说。'; }},
  });
  const notes = (withPlan.evidence || []).filter((line) => /rocoPlan/.test(String(line)));
  assert.equal(notes.length, 1, `带规划时必须有且只有一条来源说明，实际：${JSON.stringify(withPlan.evidence)}`);
  assert.match(String(notes[0]), /引擎/, '说明里要点明这份数据来自引擎');
  // **不许含任何结论或数字**：结论只能来自 `rocoPlan` 本体，说明里出现数值就等于另造一份事实。
  assert.ok(!/\d/.test(String(notes[0])), `来源说明里不许出现数字，实际：${notes[0]}`);

  let without = null;
  await runCoach({
    message: '这回合怎么打',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp'},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { without = packet; return '按规划说。'; }},
  });
  assert.equal((without.evidence || []).some((line) => /rocoPlan/.test(String(line))), false,
    '没有规划时不许出现这条说明（营地/三宠那两条老路一字不变）');
});

// ── ⑦ 教练域请求体白名单（2026-09-30 · 04.2 补；守的是 MC-013 的**桥侧**那一半）─────
//
// 这条断言守的红线：`planActions` 属于教练域 ⇒ 请求体里**不许**出现真实 seed 与对手
// 待执行动作（`seed` / `_pending_enemy` / `replace_queue` …）。
//
// 为什么必须单独钉住：这条红线此前**没有任何断言**（04.1 勘察复核时发现）。当前安全
// 属性成立靠三件事：
//   ① `planActions`（roco-client.js:899-921）的 body 是**逐键白名单**拼的：只读
//      depth / beam / budgetMs / analysisSeeds / damagePreview —— `options.seed` 根本
//      不读，所以 seed 进不了请求体（实测 body 键集见下）；
//   ② 桥的传输层 `_request`（574-585）对 payload 做 `findHiddenKeys` 扫描：命中隐藏键
//      就**本地拒绝、连发都不发**；
//   ③ 引擎侧 `/battle/plan` 命中隐藏键 ⇒ 400 hidden_information（service.py）。
// 将来有人给 `planActions` 加一句「透传 options」，① 会**静默**失守；②③ 只在真的有键
// 时才拦得住，那时已经晚了一层。⇒ 这里要的是「**发出去的 body 恰好只有白名单键**」。
//
// 两向变异（实测必红，见 reports/roco/product-execution/04/04.2-scenarios.md §5）：
//   · `const body = {public: publicState, ...options}` ⇒ ⑦ 红（body 多出 seed 等键）；
//   · `const body = {public: {...publicState, seed: 424242}}` ⇒ ⑦ 红（隐藏键深度扫描）。

//: `planActions` / `planActionsViaPlanner` 允许出现在请求体里的**全部**键。
//: ⚠ 白名单变更必须显式改这一行 —— 新字段是新契约，不许静默透传。
//: 04.3 加了 `opponent_scenarios`（可选：只有显式给了情景才出现）。
const PLAN_BODY_KEYS = ['analysis_seeds', 'beam', 'budget_ms', 'damage_preview', 'depth',
  'opponent_scenarios', 'public', 'ruleset_id', 'state_version'];
//: 不带情景注入时的**恰好**键集（键集断言用；多一个少一个都要红）。
const PLAN_BODY_KEYS_WITHOUT_SCENARIOS = PLAN_BODY_KEYS.filter((k) => k !== 'opponent_scenarios');

//: 一份**公开** planner state 夹具（形状取自 `env.public_planner_state()`：
//: 不含真实 seed、不含对手待执行动作、对手后备只有 slot/fainted）。
const PUBLIC_PLANNER_STATE = {
  schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', ruleset_config_id: 'cfg-default',
  side: 'player', turn: 3, state_version: 7, match_id: 'm-fixture', decision_id: 'm-fixture:v7',
  self: {
    active: 0, items: {},
    pets: [{pet_id: 'pet_000225', slot: 0, hp: 120, max_hp: 180, energy: 4,
      statuses: {}, marks: {}, buffs: {}}],
    loadouts: {pet_000225: ['skill_000246']},
  },
  opponent: {
    active: 0,
    field: {pet_id: 'pet_000417', slot: 0, hp: 100, max_hp: 160, energy: 3, statuses: {}, marks: {}, buffs: {}},
    bench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  },
  assumptions: {opponent_bench: 'full_hp_nominal_loadout'},
};

/** 下划线开头 / `state.` 私有容器开头的键（`state_version` 是契约字段，显式放行）。 */
function suspiciousKeyPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => suspiciousKeyPaths(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (key.startsWith('_') || /^state\./.test(key)) out.push(path);
      suspiciousKeyPaths(child, path, out);
    }
  }
  return out;
}

/** 抓请求体的假桥：只替换 `_http`（最后一跳），其余逻辑全走真代码。 */
function capturingClient(calls) {
  const client = createRocoClient({baseUrl: 'http://127.0.0.1:9',
    rulesetId: 'roco-world-s4-2026-09-10'});
  const envelope = {
    ok: true, protocol_version: 1, service: 'roco-engine', service_version: 'fixture',
    ruleset_id: 'roco-world-s4-2026-09-10', state_version: 7, snapshot_fingerprint: null,
    coverage: 1, evidence_ids: [], unsupported: [], latency_ms: 1, error_type: null, error: null,
    result: {recommended_label: '啃咬'},
  };
  client._http = async (method, path, body) => {
    calls.push({method, path, body: body ? JSON.parse(body.toString('utf8')) : null});
    return {status: 200, text: JSON.stringify(envelope)};
  };
  return client;
}

test('⑦ 请求体白名单：planActions 只发公开面，seed/隐藏字段一个都进不去', async () => {
  const calls = [];
  const res = await capturingClient(calls).planActions(PUBLIC_PLANNER_STATE, {
    stateVersion: 7, depth: 2, beam: 4, budgetMs: 800, analysisSeeds: [11, 29], damagePreview: true,
    // 故意把**不该进请求体**的东西塞进 options：将来真有人加透传，这里必须红。
    seed: 424242, pendingEnemy: 'PLANTED', replaceQueue: 'PLANTED', privateState: {seed: 1},
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls.length, 1, '只发一次请求');
  const {method, path, body} = calls[0];
  assert.equal(method, 'POST');
  assert.equal(path, '/battle/plan');
  assert.deepEqual(Object.keys(body).sort(), PLAN_BODY_KEYS_WITHOUT_SCENARIOS,
    '请求体键集必须**恰好**是白名单：多一个键就说明有字段被静默透传（白名单变更要显式改这条断言）');
  for (const key of Object.keys(body)) {
    assert.ok(PLAN_BODY_KEYS.includes(key), `${key} 不在白名单里`);
  }
  assert.deepEqual(body.public, PUBLIC_PLANNER_STATE, 'public 必须原样发（不改写、不合并）');
  assert.deepEqual(findHiddenKeys(body), [], '请求体任何深度都不许出现隐藏键');
  assert.deepEqual(suspiciousKeyPaths(body), [], '不许有下划线开头 / `state.` 私有容器键');
  assert.equal(JSON.stringify(body).includes('424242'), false, '真实 seed 的值不许出现在请求体里');
  for (const key of ['seed', '_pending_enemy', 'pending_enemy', 'replace_queue']) {
    assert.equal(key in body, false, `${key} 不许出现在请求体顶层`);
  }
  // 白名单里的键确实被发出来了（不是「什么都没发」把断言骗过去的）
  assert.equal(body.state_version, 7);
  assert.equal(body.depth, 2);
  assert.equal(body.beam, 4);
  assert.equal(body.budget_ms, 800);
  assert.deepEqual(body.analysis_seeds, [11, 29]);
  assert.equal(body.damage_preview, true);
});

test('⑦b 工具层同样只发公开面（planActionsViaPlanner 不给请求体加料）', async () => {
  const calls = [];
  const res = await planActionsViaPlanner({client: capturingClient(calls), state: PUBLIC_PLANNER_STATE,
    state_version: 7, timeoutMs: 200});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['public', 'ruleset_id', 'state_version'],
    '工具层只该把公开 state 放进 public，不额外加字段');
  assert.deepEqual(calls[0].body.public, PUBLIC_PLANNER_STATE);
  assert.deepEqual(findHiddenKeys(calls[0].body), []);
  assert.deepEqual(suspiciousKeyPaths(calls[0].body), []);
});

test('⑦c 反证：隐藏字段混进 public ⇒ 桥本地拒绝且**连发都不发**', async () => {
  const calls = [];
  const res = await capturingClient(calls).planActions({...PUBLIC_PLANNER_STATE, seed: 424242},
    {stateVersion: 7});
  assert.equal(res.ok, false);
  assert.equal(res.code, ROCO_ERROR.HIDDEN_INFORMATION);
  assert.deepEqual(res.details?.hidden_paths, ['public.seed'], '要指名道姓说是哪个路径');
  assert.equal(calls.length, 0, '命中隐藏键时一次网络都不发（这是「连发都不发」的判据）');
  // 正控：扫描器本身不是空的 —— 同一份扫描必须在**种了键**时报出来，
  // 否则上面两条 `deepEqual(..., [])` 只是「什么都没查」。
  assert.deepEqual(findHiddenKeys({public: PUBLIC_PLANNER_STATE}), []);
  assert.deepEqual(findHiddenKeys({...PUBLIC_PLANNER_STATE, replace_queue: []}), ['replace_queue']);
  assert.deepEqual(findHiddenKeys({public: {...PUBLIC_PLANNER_STATE, seed: 1}}), ['public.seed']);
  assert.deepEqual(suspiciousKeyPaths({public: {_pending_enemy: 'x', 'state.seed': 1}}),
    ['public._pending_enemy', 'public.state.seed']);
});

// ── ⑦d 04.3：`opponent_scenarios` 透传（白名单 +1，但**只有给了才出现**）────────────
test('⑦d 注入情景只有显式给出才进请求体（白名单第 9 个键，形状照原样）', async () => {
  const scenarios = [{scenario_id: 's1', kind: 'stay_attack', skill_ids: ['skill_000246'],
    slots: [], species_ids: [], evidence_ids: ['view.opponent.revealed_skills']}];

  const without = [];
  await capturingClient(without).planActions(PUBLIC_PLANNER_STATE, {stateVersion: 7});
  assert.equal('opponent_scenarios' in without[0].body, false,
    '不给情景时请求体里**不许**出现这个键（缺省路径逐字段不变）');

  const withScenarios = [];
  const res = await capturingClient(withScenarios).planActions(PUBLIC_PLANNER_STATE,
    {stateVersion: 7, opponentScenarios: scenarios});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(Object.keys(withScenarios[0].body).sort(),
    ['opponent_scenarios', 'public', 'ruleset_id', 'state_version']);
  assert.deepEqual(withScenarios[0].body.opponent_scenarios, scenarios, '情景行原样发，不裁剪不排序');
  assert.deepEqual(findHiddenKeys(withScenarios[0].body), []);
  assert.deepEqual(suspiciousKeyPaths(withScenarios[0].body), []);

  // 工具层：`planActionsViaPlanner` 也要透传（否则「接上了但不生效」）
  const toolCalls = [];
  const toolRes = await planActionsViaPlanner({client: capturingClient(toolCalls),
    state: PUBLIC_PLANNER_STATE, state_version: 7, timeoutMs: 200, opponentScenarios: scenarios});
  assert.equal(toolRes.ok, true, JSON.stringify(toolRes));
  assert.deepEqual(toolCalls[0].body.opponent_scenarios, scenarios);
});

test('⑦e 情景行的 fail-closed 校验：带概率/未知 kind/重复 id ⇒ 丢掉并登记（不裁剪不归一化）', () => {
  const normalized = normalizeOpponentScenarioRows([
    {scenario_id: 's2', kind: 'stay_defense'},
    {scenario_id: 's1', kind: 'stay_attack', skill_ids: ['skill_000246'], probability: 0.5},
    {scenario_id: 's3', kind: 'whatever'},
    {scenario_id: 's2', kind: 'stay_defense'},
    {kind: 'stay_attack'},
    'not-an-object',
  ]);
  assert.deepEqual(normalized.rows.map((row) => row.scenario_id), ['s2'],
    '合法行只剩 s2，并且按 scenario_id 定序');
  assert.equal(normalized.unavailable.length, 5, `每条坏行都要登记：${JSON.stringify(normalized.unavailable)}`);
  const why = normalized.unavailable.map((row) => row.why).join('\n');
  assert.match(why, /带了 probability/);
  assert.match(why, /kind 必须是/);
  assert.match(why, /scenario_id 重复/);
  assert.match(why, /不是对象/);
  // 正控：全合法时一行都不许丢（否则上面「丢 5 条」可能只是校验器把什么都丢了）
  const clean = normalizeOpponentScenarioRows([{scenario_id: 'a', kind: 'switch_in_seen', slots: [1]}]);
  assert.equal(clean.unavailable.length, 0);
  assert.deepEqual(clean.rows, [{scenario_id: 'a', kind: 'switch_in_seen', slots: [1],
    species_ids: [], skill_ids: [], evidence_ids: []}]);
});

// ── ⑦f 04.3：outlook provider → 工具层注入（合法行发出去，坏行丢掉并点名）────────
test('⑦f 配置了 outlook provider 时情景进请求体；坏行丢弃并在 limitations 点名', async () => {
  const harness = planToolHarness({scenarioProvider: () => [
    {scenario_id: 's1', kind: 'stay_attack', skill_ids: ['skill_000246']},
    {scenario_id: 's2', kind: 'bogus'},
    {scenario_id: 's3', kind: 'stay_defense', weight: 2},
  ]});
  try {
    const receipt = await harness.run();
    assert.equal(harness.plannerCalls.length, 1);
    assert.deepEqual(harness.plannerCalls[0].opponentScenarios, [
      {scenario_id: 's1', kind: 'stay_attack', slots: [], species_ids: [],
        skill_ids: ['skill_000246'], evidence_ids: []},
    ], '只有合法行进请求，且按 scenario_id 定序');
    assert.equal(receipt.opponentScenarios.injected, 1);
    assert.equal(receipt.opponentScenarios.source, 'configured-provider');
    assert.equal(receipt.opponentScenarios.unavailable.length, 2, '两条坏行都要登记');
    assert.ok(receipt.limitations.some((line) => /形状不合法被丢弃/.test(String(line))),
      `坏行必须在 limitations 里点名：${JSON.stringify(receipt.limitations)}`);
    assert.ok(receipt.opponentBasis, '引擎注入时给的依据栏要带回来');
  } finally {
    harness.done();
  }

  // 默认（没配 provider、context 里也没有公开视图）⇒ 一个情景都不注入，但**必须说明为什么**
  // （04.3b：`source:'missing-view'` + 一条带原因的 `unavailable`，不许「什么都没有也不说话」）
  const plain = planToolHarness({});
  try {
    const receipt = await plain.run();
    assert.equal(plain.plannerCalls[0].opponentScenarios, undefined);
    assert.equal(receipt.opponentScenarios.injected, 0);
    assert.deepEqual(receipt.opponentScenarios.scenario_ids, []);
    assert.equal(receipt.opponentScenarios.source, 'missing-view');
    assert.equal(receipt.opponentScenarios.available, null);
    assert.equal(receipt.opponentScenarios.unavailable.length, 1);
    assert.match(receipt.opponentScenarios.unavailable[0].why, /没有公开视图/);
  } finally {
    plain.done();
  }
});

test('⑧d 04.4：引擎的 robustness/declarations 带出来；缺 declarations 时回退工具层那份', async () => {
  const harness = planToolHarness({});
  try {
    const receipt = await harness.run();
    assert.equal(receipt.declarations.source, 'engine', '引擎自带声明时优先用它');
    assert.equal(receipt.declarations.expected.unit, 'score');
    // 稳健排序的留痕要原样到工具回执（被压下去的动作**不许**被藏起来）
    assert.equal(receipt.robustness.primary_rule_applied, true);
    assert.equal(receipt.robustness.material_loss_threshold, 1.2);
    assert.equal(receipt.robustness.top.material_loss, false);
    assert.equal(receipt.robustness.material_loss_actions[0].action, '使用能量果');
    assert.equal(receipt.robustness.material_loss_actions[0].expected, 0.4417,
      '被压下去的动作期望更高 —— 这正是反例②的要点，必须留着可核对');
    assert.equal(receipt.robustness.is_probability, false);
    assert.deepEqual(receipt.robustness.tied_with_top, []);
  } finally {
    harness.done();
  }

  // 引擎没给（老引擎 / 规划器自报形状）⇒ 回退工具层那份声明，robustness 记 null（不造）
  const bare = planToolHarness({plan: {declarations: undefined, robustness: undefined}});
  try {
    const receipt = await bare.run();
    assert.equal(receipt.declarations.source, 'toolbox');
    assert.equal(receipt.declarations.is_probability, false);
    assert.equal(receipt.declarations.coverage.unit, 'count_ratio');
    assert.equal(receipt.robustness, null, '缺字段 ⇒ null，不许自己造一份');
  } finally {
    bare.done();
  }
});

// ── ⑧ 04.3：D-27 边际量读侧 / R3+R5+R8 声明 / P6 缓存 ───────────────────────────
const PLAN_TOOL_STATE = {
  schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', rules_version: 'rv-1',
  match_id: 'm-plan-1', decision_id: 'm-plan-1:v7', state_version: 7, turn: 3,
  self: {active: 0, items: {}, pets: [{pet_id: 'pet_000225', slot: 0, hp: 120, max_hp: 180, energy: 4}]},
  opponent: {active: 0, field: {pet_id: 'pet_000417', slot: 0, hp: 100, max_hp: 160, energy: 3}},
};
const PLAN_STATE_VERSION = 7;

/** 引擎形状的成功回执（`/battle/plan` 的真实字段名）。 */
function fakePlanEngine(overrides = {}) {
  return {
    ok: true, code: null, failure_class: null, message: null,
    ruleset_id: 'roco-world-s4-2026-09-10', state_version: PLAN_STATE_VERSION,
    coverage: 1, evidence_ids: [], unsupported: [], latency_ms: 1.5, error_type: null,
    limitations: ['引擎自报的限制'],
    result: {
      recommended_label: '抓挠', recommendation_stable: true,
      expected: {min: -0.3, max: -0.2, mean: -0.24}, worst: {min: -0.3, max: -0.2},
      main_counter: '换上第2位', counter_note: '对手最可能换人',
      branches_evaluated: 12, depth_searched: 2, coverage: 1, timed_out: false,
      first_second_margin: {min: 0.01, max: 0.09, mean: 0.0732, scale: 'one-ply-value',
        note: '对象形'},
      truncation: {rule: '类别保底 + 束宽', candidates_total: 8, candidates_kept: 3,
        candidates_dropped: 5, dropped_by_kind: {skill: 2, item: 2, switch: 1},
        dropped: [{action: '防御', kind: 'skill', value: 0.2162, why: '束宽 beam=2 之外'}]},
      coverage_detail: {numerator: 3, denominator: 3, unit: 'count_ratio',
        is_confidence: false, is_probability: false},
      budget: {depth_requested: 2, depth_effective: 3, depth_searched: 3, depth_max: 3,
        depth_truncated: true, depth_capped_by_max: true, beam_truncated: true,
        budget_ms: 2000, timed_out: false, nodes: 12},
      robustness: {ordering: ['① 无「有证据的重大损失」优先', '② 期望降序（资源与后手都在期望里）',
        '③ 最坏降序'], material_loss_threshold: 1.2, primary_rule_applied: true,
        material_loss_actions: [{action: '使用能量果', expected: 0.4417, worst: -1.5177,
          worst_branch: '换上第2位', why: '有证据的最坏分支 -1.5177 ≤ -1.2'}],
        tie_epsilon: 0.02, tied_with_top: [],
        top: {action: '换上第3位', expected: -0.8878, worst: -1.0051, material_loss: false,
          worst_computed: true},
        is_probability: false, note: '稳健优先：先看有没有「有证据的重大损失」…'},
      declarations: {is_probability: false, is_winrate: false,
        scale: 'heuristic-position-score',
        note: '以上是启发式估值与计数比：**不是胜率、不是概率、不是把握度**',
        expected: {is_probability: false, unit: 'score',
          basis: '启发式局面分对**启发式**对手分布取期望；权重没有实测频率数据'},
        coverage: {is_probability: false, is_confidence: false, unit: 'count_ratio',
          basis: '计数比（对手反制被枚举过的候选 / 参与搜索的候选）'}},
      opponent_basis: {source: 'injected_scenarios', label: '本次对手依据 = 注入情景'},
      ...overrides,
    },
  };
}

/** 假桥 + 假规划器 + `executeTool('plan_actions')` 的夹具（不起 Python）。 */
function planToolHarness({plan = {}, engine = null, scenarioProvider = null} = {}) {
  resetRocoTools();
  const plannerCalls = [];
  const bridgeCalls = [];
  // 版本用**函数** provider：`rocoStateVersionOf` 优先取 provider（不看 context），
  // 所以「换版本 ⇒ 换缓存键」这条必须靠它来模拟（否则工具会在 freshness 那一步就拒绝）。
  let version = PLAN_STATE_VERSION;
  configureRocoTools({client: capturingClient(bridgeCalls), stateVersion: () => version});
  configureRocoTools({planner: async (request) => {
    plannerCalls.push(request);
    const produced = engine ?? fakePlanEngine(plan);
    // 与真桥一致：state_version 原样回传（调用方用它判断事实是否过期）。
    return produced ? {...produced, state_version: request.state_version} : produced;
  }});
  if (scenarioProvider) configureRocoTools({opponentOutlook: scenarioProvider});
  const context = {matchId: 'm-plan-1'};
  return {
    plannerCalls,
    bridgeCalls,
    setVersion: (next) => { version = next; },
    run: (args = {}, extraContext = {}) => executeTool('plan_actions',
      {state: PLAN_TOOL_STATE, state_version: version, ...args},
      {...context, ...extraContext}),
    done: () => resetRocoTools(),
  };
}

test('⑧ D-27：边际量按对象形读；缺字段/形状不对 ⇒ unknown，**不许当 0**', async () => {
  // 纯函数层：四种形状逐个钉
  const known = readFirstSecondMargin({first_second_margin: {min: 0.01, max: 0.09, mean: 0.0732,
    scale: 'one-ply-value', note: 'x'}}, {available: true});
  assert.equal(known.status, 'known');
  assert.equal(known.value, 0.0732);
  assert.deepEqual([known.min, known.max], [0.01, 0.09]);

  for (const [label, field] of [
    ['缺字段', undefined],
    ['旧标量形', 0.0732],
    ['缺 mean', {min: 0.01, max: 0.09}],
    ['mean 是 null', {min: 0.01, max: 0.09, mean: null}],
    ['数组', [0.01, 0.09]],
  ]) {
    const view = readFirstSecondMargin({first_second_margin: field}, {available: true});
    assert.equal(view.status, 'unknown', `${label} 必须判 unknown`);
    assert.equal(view.value, null, `${label} 不许给出数字（尤其不许当 0）`);
    assert.match(view.reason, /不产出数字|不当 0/);
  }
  assert.equal(readFirstSecondMargin(null, {available: false}).status, 'not_applicable');
  assert.equal(readFirstSecondMargin({}, {available: false}).value, null);

  // 工具回执层：缺字段 ⇒ null + limitations 点名；对象形 ⇒ 出 mean
  const missing = planToolHarness({plan: {first_second_margin: undefined}});
  try {
    const receipt = await missing.run();
    assert.equal(receipt.firstSecondMargin, null);
    assert.equal(receipt.firstSecondMarginDetail.status, 'unknown');
    assert.ok(receipt.limitations.some((line) => /边际量不可用/.test(String(line))),
      `缺字段必须在 limitations 里点名：${JSON.stringify(receipt.limitations)}`);
  } finally {
    missing.done();
  }
  const ok = planToolHarness({});
  try {
    const receipt = await ok.run();
    assert.equal(receipt.firstSecondMargin, 0.0732);
    assert.equal(receipt.firstSecondMarginDetail.status, 'known');
    assert.ok(receipt.limitations.includes('引擎自报的限制'), '引擎的 limitations 必须原样保留');
  } finally {
    ok.done();
  }
});

test('⑧b 回执带出 R3/R5/R8 与 `is_probability:false` 声明（机器可检，不只在文案里）', async () => {
  const harness = planToolHarness({});
  try {
    const receipt = await harness.run();
    assert.equal(receipt.declarations.is_probability, false);
    // 04.4：引擎自带 declarations ⇒ 用引擎那份（每个数字的口径都在），并标明来源
    assert.equal(receipt.declarations.source, 'engine');
    for (const [key, value] of Object.entries(receipt.declarations)) {
      if (value && typeof value === 'object') {
        assert.equal(value.is_probability, false, `${key} 要单独声明不是概率`);
      }
    }
    assert.equal(receipt.declarations.coverage.is_confidence, false);
    assert.equal(receipt.declarations.coverage.unit, 'count_ratio');
    assert.match(JSON.stringify(receipt.declarations), /不是胜率/);

    assert.equal(receipt.truncation.rule, '类别保底 + 束宽');
    assert.equal(receipt.truncation.candidates_dropped, 5);
    assert.deepEqual(receipt.truncation.dropped[0].action, '防御');
    assert.equal(receipt.coverageDetail.unit, 'count_ratio');
    assert.equal(receipt.coverageDetail.numerator, 3);
    assert.equal(receipt.budget.depth_truncated, true);
    assert.equal(receipt.search.depthTruncated, true, 'R8 的语义要出现在 search 里');
    assert.equal(receipt.search.depthCappedByMax, true);
    assert.equal(receipt.search.beamTruncated, true);
    assert.equal(receipt.search.depthMax, 3);
    assert.equal(receipt.opponentBasis.source, 'injected_scenarios');
    assert.equal(receipt.opponentScenarios.injected, 0, '默认不注入情景（见 toolbox 的说明）');
  } finally {
    harness.done();
  }

  // 引擎**没给**这三块时不许自己造：一律 null（编一份空的等于假装查过）
  const bare = planToolHarness({plan: {truncation: undefined, coverage_detail: undefined,
    budget: undefined, opponent_basis: undefined}});
  try {
    const receipt = await bare.run();
    assert.equal(receipt.truncation, null);
    assert.equal(receipt.coverageDetail, null);
    assert.equal(receipt.budget, null);
    assert.equal(receipt.opponentBasis, null);
    assert.equal(receipt.search.depthTruncated, null, '缺字段 ⇒ null，不许当 false');
  } finally {
    bare.done();
  }
});

test('⑧c P6 缓存：同键只算一次；身份/版本/rules 换一项就重算；超时不缓存', async () => {
  const harness = planToolHarness({});
  try {
    const first = await harness.run();
    assert.equal(harness.plannerCalls.length, 1);
    assert.equal(first.cache.hit, false);
    assert.equal(first.cache.stored, true, '完成的搜索才写缓存');
    assert.equal(first.cache.key,
      'm-plan-1|v7|rv-1|ddefault|bdefault|tdefault|sdefault',
      '键必须是七元组（缺省参数用 default 占位）');
    assert.equal(rocoPlanCacheSize(), 1);

    const second = await harness.run();
    assert.equal(harness.plannerCalls.length, 1, '同键必须**一次都不再问引擎**');
    assert.equal(second.cache.hit, true);
    assert.equal(second.recommendation, first.recommendation, '命中给的还是同一份结论');
    assert.ok(Number.isInteger(second.cache.ageMs));

    // 版本换一项 ⇒ 另一个键（缓存不许把 v7 的结论发给 v8）
    harness.setVersion(8);
    const bumped = await harness.run();
    assert.equal(harness.plannerCalls.length, 2, 'state_version 变了必须重算');
    assert.equal(bumped.cache.hit, false);
    assert.equal(bumped.cache.key, 'm-plan-1|v8|rv-1|ddefault|bdefault|tdefault|sdefault');

    // 身份/规则集换一项 ⇒ 另一个键
    assert.notEqual(rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-2'}),
      rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1'}));
    assert.notEqual(rocoPlanCacheKey({match_id: 'm-other', state_version: 8, rules_version: 'rv-1'}),
      rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1'}));
    assert.notEqual(rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1', beam: 4}),
      rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1'}));
    assert.notEqual(rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1',
      analysis_seeds: [1, 2]}),
    rocoPlanCacheKey({match_id: 'm-plan-1', state_version: 8, rules_version: 'rv-1'}));
    // 身份不全 ⇒ 不给键（宁可不缓存，也不拿半个键去撞）
    assert.equal(rocoPlanCacheKey({state_version: 8, rules_version: 'rv-1'}), null);
    assert.equal(rocoPlanCacheKey({match_id: 'm', state_version: 8}), null);
    assert.equal(rocoPlanCacheKey({match_id: 'm', rules_version: 'rv-1'}), null);
  } finally {
    harness.done();
  }

  // 超时的结果**不缓存**（缓存它等于把「没算完」永久化）
  const timedOut = planToolHarness({plan: {timed_out: true, recommended_label: '先防御'}});
  try {
    const receipt = await timedOut.run();
    assert.equal(receipt.planAvailable, false);
    assert.equal(receipt.cache.stored, false);
    assert.equal(rocoPlanCacheSize(), 0);
    const again = await timedOut.run();
    assert.equal(timedOut.plannerCalls.length, 2, '没缓存就必须重新问');
    assert.equal(again.cache.hit, false);
  } finally {
    timedOut.done();
  }
});

// ── ⑨ 04.3b：动作级情景的**消费侧**（只消费 03b 的 buildActionScenarios，不自己映射）────
//
// 守的红线（D-33 + Lead 三令）：
//   ① **留场与换人并存、绝不塌缩**：公开面有换人证据就必须有 `switch_in_seen` 行；
//      「期望」从 `view.seen_roster` **现算**（不读 03b 自己的 `sources` —— 它塌缩后会自恰变 false）；
//   ② `slots: []` = 位次不可判定 ⇒ **照传空数组**，绝不猜一个位次；
//   ③ 可学池情景必须带 `learnable_pool_hypothesis` 标记（假设 ≠ 观察）；
//   ④ `unavailable[]`（含 P3 残留：后备满血 + 规范配招假设）**照实传递**，不吞。

/** 真引擎 view（03 留档的原始回执，不是手写夹具）。 */
const REAL_ACTION_VIEW = JSON.parse(readFileSync(
  join(ROOT, 'reports', 'roco', 'product-execution', '03', 'raw-03.3-view-pvp.json'), 'utf8'));

/** 从**公开面**独立现算「有公开证据的换人位次」——不读 03b 的 sources。 */
function independentSwitchSlots(view) {
  const activeSlot = Number.isInteger(view?.opponent?.field?.slot) ? view.opponent.field.slot : null;
  const fainted = new Map((view?.opponent?.bench ?? [])
    .filter((row) => Number.isInteger(row?.slot)).map((row) => [row.slot, row.fainted === true]));
  return [...new Set((view?.seen_roster ?? [])
    .map((row) => row?.slot)
    .filter((slot) => Number.isInteger(slot) && slot !== activeSlot && fainted.get(slot) !== true))]
    .sort((a, b) => a - b);
}

test('⑨a 消费真 view：留场与换人并存（不塌缩）· slots=[] 照传 · 池情景带假设标记 · P3 照报', async () => {
  const harness = planToolHarness({});
  try {
    const receipt = await harness.run({}, {rocoActionView: REAL_ACTION_VIEW});
    const sent = harness.plannerCalls[0].opponentScenarios;
    assert.ok(Array.isArray(sent) && sent.length > 0, '真 view 必须能产出动作级情景');
    const stay = sent.filter((row) => row.kind === 'stay_attack' || row.kind === 'stay_defense');
    const sw = sent.filter((row) => row.kind === 'switch_in_seen');
    assert.ok(stay.length > 0, '必须有留场情景（observed 已出技能）');
    // ① 绝不塌缩：换人证据在公开面上存在 ⇒ 情景里必须也有换人行
    const expectedSlots = independentSwitchSlots(REAL_ACTION_VIEW);
    assert.ok(expectedSlots.length > 0, '夹具必须含换人证据（否则这条判据是空的）');
    assert.equal(sw.length, expectedSlots.length,
      `换人情景数必须等于从 seen_roster 现算的期望 ${JSON.stringify(expectedSlots)}`);
    assert.deepEqual(sw.map((row) => row.slots[0]).sort((a, b) => a - b), expectedSlots,
      '换人位次必须逐个来自公开面（seen_roster 的 slot）');
    // ② 池情景：位次不可判定 ⇒ slots 必须是空数组（照传，不是猜一个）
    const pool = sent.filter((row) => row.evidence_basis === 'learnable_pool_hypothesis');
    assert.ok(pool.length > 0, '夹具的可学池情景必须被带出来');
    for (const row of pool) {
      assert.deepEqual(row.slots, [], `池情景 ${row.scenario_id} 的位次不可判定 ⇒ 必须传空数组`);
      assert.equal(row.kind, 'stay_attack');
    }
    // ③ 假设标记逐条保留；回执里能一眼看出哪些是假设
    assert.deepEqual(receipt.opponentScenarios.hypothesis_scenarios,
      pool.map((row) => row.scenario_id));
    assert.deepEqual(receipt.opponentScenarios.slot_undetermined,
      sent.filter((row) => row.slots.length === 0).map((row) => row.scenario_id));
    // ④ 03b 的 unavailable（含 P3 残留）照实传递 + limitations 点名
    const what = receipt.opponentScenarios.unavailable.map((row) => row.what);
    assert.ok(what.includes('bench_hp_and_moveset'), `P3 残留必须传递：${JSON.stringify(what)}`);
    const p3 = receipt.opponentScenarios.unavailable.find((row) => row.what === 'bench_hp_and_moveset');
    assert.match(p3.why, /满血|规范配招/);
    assert.ok(receipt.limitations.some((line) => /P3 残留/.test(String(line))),
      `limitations 要点名 P3 残留：${JSON.stringify(receipt.limitations)}`);
    // 03b 的自报读数原样带出（协议 / counts / sources / 声明）
    assert.equal(receipt.opponentScenarios.protocol, 'rc604-opponent-action-scenarios/v1');
    assert.equal(receipt.opponentScenarios.available, true);
    assert.equal(receipt.opponentScenarios.counts.stay, stay.length);
    assert.equal(receipt.opponentScenarios.counts.switch, sw.length);
    assert.equal(receipt.opponentScenarios.declarations.is_probability, false);
    assert.equal(receipt.opponentScenarios.source, '03b-buildActionScenarios');
  } finally {
    harness.done();
  }
});

test('⑨b 视图不完整 ⇒ 不注入 + 说明原因（fail closed，不补造情景、不猜位次）', async () => {
  // ① 客户端快照形状（`foe`/`foe_bench`，**没有 `opponent.field`**）：场上那只不可确定 ⇒
  //    消费侧前置闸拦住（否则 03b 会照 `seen_roster` 产出「对手换入自己」——实测过）。
  const clientSnapshot = {
    turn: 3, state_version: 7,
    self: [{pet_id: 'pet_000007', hp: 100, max_hp: 120}], self_active: 0,
    foe: [{pet_id: 'pet_000239', hp: 90, max_hp: 110}],
    foe_bench: [{slot: 1, fainted: false}, {slot: 2, fainted: true}],
    seen_roster: (REAL_ACTION_VIEW.seen_roster ?? []).slice(0, 2),
  };
  const harness = planToolHarness({});
  try {
    const receipt = await harness.run({}, {roco_battle: clientSnapshot});
    assert.equal(harness.plannerCalls[0].opponentScenarios, undefined, '不允许带着不完整视图注入');
    assert.equal(receipt.opponentScenarios.injected, 0);
    assert.equal(receipt.opponentScenarios.source, 'view-missing-active');
    assert.equal(receipt.opponentScenarios.available, null);
    assert.match(receipt.opponentScenarios.unavailable[0].why, /opponent\.field/);
    assert.match(receipt.opponentScenarios.unavailable[0].why, /留场|换人/);
    assert.ok(receipt.limitations.some((line) => /不可判定项/.test(String(line))));
  } finally {
    harness.done();
  }

  // ② 完全没有视图 ⇒ missing-view（回执 `available:null`，不是 false 也不是 true）
  const bare = planToolHarness({});
  try {
    const receipt = await bare.run();
    assert.equal(bare.plannerCalls[0].opponentScenarios, undefined);
    assert.equal(receipt.opponentScenarios.injected, 0);
    assert.equal(receipt.opponentScenarios.source, 'missing-view');
    assert.equal(receipt.opponentScenarios.available, null);
    assert.match(receipt.opponentScenarios.unavailable[0].why, /没有公开视图/);
  } finally {
    bare.done();
  }

  // ③ 完整视图（⑨a 用的那份）在同一个夹具里**必须**能注入 —— 否则前置闸就是把功能关掉了
  const full = planToolHarness({});
  try {
    await full.run({}, {rocoActionView: REAL_ACTION_VIEW});
    assert.ok(Array.isArray(full.plannerCalls[0].opponentScenarios)
      && full.plannerCalls[0].opponentScenarios.length > 0, '完整视图必须照常注入');
  } finally {
    full.done();
  }
});

test('⑨c 超过引擎上限（64）⇒ 按 scenario_id 定序截断并逐条登记（不静默丢）', async () => {
  const many = Array.from({length: 70}, (_v, i) => ({
    scenario_id: `s${String(i).padStart(3, '0')}`,
    kind: 'stay_attack', slots: [0], species_ids: ['pet_000239'],
    skill_ids: ['skill_000340'], evidence_basis: 'observed', evidence_ids: ['x'],
  }));
  const harness = planToolHarness({});
  configureRocoTools({actionScenarioBuilder: () => ({
    protocol: 'rc604-opponent-action-scenarios/v1', available: true, unknown_reason: null,
    scenarios: many, counts: {stay: 70, switch: 0, observed: 70, hypothesis: 0},
    sources: {stay_available: true, switch_available: false, pool_candidates: 0},
    unavailable: [], declarations: {is_probability: false},
  })});
  try {
    const receipt = await harness.run();
    assert.equal(harness.plannerCalls[0].opponentScenarios.length, 64, '引擎上限是 64');
    const over = receipt.opponentScenarios.unavailable.filter((row) => /over_engine_limit/.test(row.what));
    assert.equal(over.length, 6, '被截断的 6 条必须逐条登记');
    assert.match(over[0].why, /上限 64/);
    // 定序截断：留下的是 id 最小的 64 条
    assert.equal(harness.plannerCalls[0].opponentScenarios[0].scenario_id, 's000');
    assert.equal(harness.plannerCalls[0].opponentScenarios[63].scenario_id, 's063');
  } finally {
    harness.done();
  }

  // ② **provider 路径**（verifier 04.3b① 实测这里曾不截断 ⇒ 发出 70 条 ⇒ 引擎会 400）
  const viaProvider = planToolHarness({scenarioProvider: () => many});
  try {
    const receipt = await viaProvider.run();
    assert.equal(viaProvider.plannerCalls[0].opponentScenarios.length, 64,
      'provider 路径必须与 03b 路径同一把尺子（否则引擎 400）');
    const over = receipt.opponentScenarios.unavailable.filter((row) => /over_engine_limit/.test(row.what));
    assert.equal(over.length, 6, 'provider 路径也要逐条登记被截断的行');
    assert.equal(receipt.opponentScenarios.scenario_ids.length, 64);
  } finally {
    viaProvider.done();
  }
});

// ── ⑩ C-2：契约字段的「键 + 格式」白名单（真机上 plan_actions 曾被 rules_version 的 `/` 拒）──
//
// 为什么单列：`rules_version` 合法地带 `/`（`<ruleset_id>/<config_id>`），而通用字符串规则把
// 含 `/` 的串一律当路径拒 ⇒ **模型真机上完全调不动 plan_actions**。修法是**只**给四个契约键
// 按格式放行；通用规则（穿越防护）**不放宽**，非白名单字段含 `/` 照旧拒。
test('⑩ C-2：契约键按格式放行；穿越样式与非白名单字段含 / 仍必拒', () => {
  const REAL_RULES_VERSION = 'roco-world-s4-2026-09-10/legacy_sim_v1';
  const state = (extra) => ({...PUBLIC_PLANNER_STATE, rules_version: REAL_RULES_VERSION, ...extra});
  // ① 正：真公开面（含带 `/` 的 rules_version）必须通过 —— 这是 e2e 从红转绿的那一条
  assert.equal(validToolArgs('plan_actions', {state: state({}), state_version: 7}), true,
    '真公开面的 rules_version 必须能过（否则 plan_actions 在真机上不可调用）');
  assert.ok(JSON.stringify(state({})).includes(REAL_RULES_VERSION), '夹具里必须真的是带斜杠的那个值');
  // ② 负（穿越样式）：白名单键也必须**格式对**，`..`/多斜杠/反斜杠/绝对路径一律拒
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b/c', 'a/..', '..', 'x\\y', 'a\\..\\b']) {
    assert.equal(validToolArgs('plan_actions', {state: state({rules_version: bad}), state_version: 7}),
      false, `rules_version=${JSON.stringify(bad)} 必须被拒`);
  }
  // ③ 负（非白名单字段含 `/`）⇒ 通用规则没放宽
  assert.equal(validToolArgs('plan_actions', {state: state({note: 'a/b'}), state_version: 7}), false,
    '非白名单字段含 / 必须被拒（通用穿越防护不许放宽）');
  assert.equal(validToolArgs('plan_actions', {
    state: state({self: {...PUBLIC_PLANNER_STATE.self,
      loadouts: {pet_000225: ['skill/000246']}}}), state_version: 7}), false,
  '数组里的字符串含 / 也必须被拒');
  // ④ 另三个契约键同样按格式放行 / 按格式拒
  assert.equal(validToolArgs('plan_actions', {state: state({match_id: 'm-abc123',
    decision_id: 'm-abc123:v3', ruleset_id: 'roco-world-s4-2026-09-10'}), state_version: 7}), true);
  assert.equal(validToolArgs('plan_actions', {state: state({match_id: 'm/abc'}), state_version: 7}), false);
  assert.equal(validToolArgs('plan_actions', {state: state({decision_id: 'm-abc:v3/x'}), state_version: 7}), false);
  assert.equal(validToolArgs('plan_actions', {state: state({ruleset_id: '../x'}), state_version: 7}), false);
  // ⑤ 白名单**不许**改变其它守卫：字节/深度/隐藏键照旧
  assert.equal(validToolArgs('plan_actions', {
    state: state({blob: 'x'.repeat(9000)}), state_version: 7}), false, '字节上限照旧');
  assert.equal(validToolArgs('plan_actions', {state: state({seed: 5}), state_version: 7}), false,
    '隐藏键照旧（白名单只认那四个契约键）');
});
