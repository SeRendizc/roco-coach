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
import {planActionsViaPlanner} from '../src/coach/toolbox.js';

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
const PLAN_BODY_KEYS = ['analysis_seeds', 'beam', 'budget_ms', 'damage_preview', 'depth',
  'public', 'ruleset_id', 'state_version'];

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
  assert.deepEqual(Object.keys(body).sort(), PLAN_BODY_KEYS,
    '请求体键集必须**恰好**是白名单：多一个键就说明有字段被静默透传（白名单变更要显式改这条断言）');
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
