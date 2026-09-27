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
