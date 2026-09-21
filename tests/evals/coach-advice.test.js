// 局面化提示层（`src/coach/coach-advice.js`）的单元测试。
//
// 这一组测试**不需要 Python**：局面对象是手搭的，但每一个数字都来自真实引擎跑出来的
// 局面（下面每个 fixture 都写了出处：seed / 回合）。为什么要这样：
//   · 只用想象的数据搭 fixture，会把「我以为引擎会给的字段」写进测试，
//     于是测试全绿而真实链路对不上（这条在仓库里已经踩过好几次）；
//   · 真实数据里的数值（425/474 血、速度 60/92/130、能耗 2/3/4）能顺便证明
//     这一层的判据是在这套尺子上成立的。
//
// 每个 fixture 都通过 `rocoGameView(...)`（真实投影函数）变成 `game`，
// 所以 fixture 的形状与页面拿到的那一份**逐字段一致**，而不是照着印象写的。
//
// 运行：node --test tests/evals/coach-advice.test.js

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {coachAdvice, normaliseAdviceShape, COACH_ADVICE_KINDS} from '../../src/coach/coach-advice.js';
import {rocoGameView} from '../../src/coach/roco-experience.js';

// ── fixture 搭建器 ────────────────────────────────────────────────────────
//
// 形状严格照 `src/server/roco-service.js` 的 `publicView()`：
// `/api/roco/battle/*` 回给浏览器的就是它，`rocoGameView` 也是吃它。

const RULESET = 'roco-world-s4-2026-09-10';

/** 真实技能行（数值全部抄自 data/roco/normalized/roco-world-s4-2026-09-10/skills.json）。 */
const SKILLS = {
  音爆: {skill_id: 'skill_000251', name: '音爆', element: '普通系', category: '攻击', energy: 4, power: 130, power_status: 'static_value_present'},
  拍击: {skill_id: 'skill_000303', name: '拍击', element: '普通系', category: '攻击', energy: 1, power: 65, power_status: 'static_value_present'},
  彗星: {skill_id: 'skill_000321', name: '彗星', element: '普通系', category: '攻击', energy: 0, power: 240, power_status: 'static_value_present'},
  引燃: {skill_id: 'skill_000387', name: '引燃', element: '火系', category: '状态', energy: 2, power: null, power_status: 'not_provided_by_source'},
  龙吼: {skill_id: 'skill_000563', name: '龙吼', element: '龙系', category: '攻击', energy: 1, power: 60, power_status: 'static_value_present'},
  龙血: {skill_id: 'skill_000576', name: '龙血', element: '龙系', category: '防御', energy: 2, power: null, power_status: 'not_provided_by_source'},
  集中: {skill_id: 'skill_000591', name: '集中', element: '电系', category: '防御', energy: 2, power: null, power_status: 'not_provided_by_source'},
  毒孢子: {skill_id: 'skill_000614', name: '毒孢子', element: '毒系', category: '状态', energy: 3, power: null, power_status: 'not_provided_by_source'},
  气波: {skill_id: 'skill_000673', name: '气波', element: '武系', category: '攻击', energy: 0, power: 40, power_status: 'static_value_present'},
  冷风: {skill_id: 'skill_000542', name: '冷风', element: '冰系', category: '攻击', energy: 1, power: 60, power_status: 'static_value_present'},
  防御: {skill_id: 'skill_000286', name: '防御', element: '普通系', category: '防御', energy: 1, power: null, power_status: 'not_provided_by_source'},
  偷袭: {skill_id: 'skill_000259', name: '偷袭', element: '普通系', category: '攻击', energy: 3, power: 85, power_status: 'static_value_present'},
  穿膛: {skill_id: 'skill_000263', name: '穿膛', element: '普通系', category: '攻击', energy: 2, power: 65, power_status: 'static_value_present'},
  魔能爆: {skill_id: 'skill_000265', name: '魔能爆', element: '普通系', category: '攻击', energy: 0, power: 1, power_status: 'static_value_present'},
  坟场搏击: {skill_id: 'skill_000744', name: '坟场搏击', element: '幽系', category: '攻击', energy: 4, power: 180, power_status: 'static_value_present'},
  角击: {skill_id: 'skill_000572', name: '角击', element: '龙系', category: '攻击', energy: 2, power: 80, power_status: 'static_value_present'},
  诡刺: {skill_id: 'skill_000750', name: '诡刺', element: '幽系', category: '攻击', energy: 0, power: 40, power_status: 'static_value_present'},
  灵媒: {skill_id: 'skill_000753', name: '灵媒', element: '幽系', category: '攻击', energy: 3, power: 100, power_status: 'static_value_present'},
  念力膨胀: {skill_id: 'skill_000803', name: '念力膨胀', element: '幻系', category: '攻击', energy: 2, power: 80, power_status: 'static_value_present'},
};

/** 真实六维（种族值；与 pets.json 逐字段一致）。速度用来比出手顺序。 */
const SPECIES = {
  寂灭骨龙: {pet_id: 'pet_000225', types: ['龙系', '幽系'], stats: {hp: 120, atk: 137, def: 104, spa: 50, spd: 81, spe: 60}},
  海豹船长: {pet_id: 'pet_000190', types: ['武系', '水系'], stats: {hp: 90, atk: 113, def: 111, spa: 109, spd: 77, spe: 100}},
  黑猫巫师: {pet_id: 'pet_000445', types: ['普通系'], stats: {hp: 149, atk: 53, def: 90, spa: 124, spd: 129, spe: 70}},
  圆号鱼: {pet_id: 'pet_000417', types: ['水系'], stats: {hp: 113, atk: 31, def: 105, spa: 100, spd: 90, spe: 105}},
  化蝶: {pet_id: 'pet_000124', types: ['虫系', '萌系'], stats: {hp: 53, atk: 46, def: 90, spa: 90, spd: 90, spe: 100}},
  画间沉铁兽: {pet_id: 'pet_000474', types: ['普通系', '武系'], stats: {hp: 126, atk: 147, def: 100, spa: 63, spd: 76, spe: 92}},
  银月狼王: {pet_id: 'pet_000608', types: ['幽系', '幻系'], stats: {hp: 115, atk: 128, def: 95, spa: 90, spd: 90, spe: 130}},
};

/** 一只伙伴：字段名与 `/api/roco/battle/*` 回给浏览器的一致（`max_hp` 而不是 `maxHp`）。 */
function pet({name, slot, hp, energy, fainted = false, statuses = {}}) {
  const species = SPECIES[name];
  if (!species) throw new Error(`fixture 用了未登记的精灵：${name}`);
  return {
    slot, pet_id: species.pet_id, name, hp, max_hp: null, energy, fainted,
    statuses, marks: {}, types: species.types, stats: species.stats,
    class: null, stage: null,
  };
}

/** 血量按真实面板填（`max_hp` 直接用调用方给的值，不换算——换算公式在引擎里）。 */
function withMax(petRow, maxHp) {
  return {...petRow, max_hp: maxHp};
}

function skillAction(name) {
  const skill = SKILLS[name];
  if (!skill) throw new Error(`fixture 用了未登记的技能：${name}`);
  return {kind: 'skill', label: name, skill_id: skill.skill_id, skill_name: name, skill, target_index: null, item_id: null};
}

function switchAction(targetIndex) {
  return {kind: 'switch', label: `换上第${targetIndex + 1}位`, skill_id: null, skill_name: null, skill: null, target_index: targetIndex, item_id: null};
}

function itemAction(itemId) {
  return {kind: 'item', label: `使用${itemId}`, skill_id: null, skill_name: null, skill: null, target_index: 0, item_id: itemId};
}

function escapeAction() {
  return {kind: 'escape', label: '撤退', skill_id: null, skill_name: null, skill: null, target_index: null, item_id: null};
}

/** 一份公开视图（`publicView()` 的形状）。 */
function view({stateVersion, turn, phase = 'battle', result = null, pets, skills = [], foeField, foeBench, foeActive = 0, legal, events = [], needsReplacement = []}) {
  return {
    schema_version: 1,
    ruleset_id: RULESET,
    state_version: stateVersion,
    turn,
    phase,
    battle_result: result,
    self: {active: 0, pets, skills},
    opponent: {
      active: foeActive,
      living_count: 3,
      field: foeField,
      bench: foeBench,
    },
    legal,
    cpu_legal_count: 0,
    needs_replacement: needsReplacement,
    events,
    strategy: {name: 'greedy_damage', version: 1},
    assumptions: null,
    unsupported_count: 0,
  };
}

/** 走真实投影：fixture → 页面拿到的那份 `game`。 */
function position(rawView) {
  return rocoGameView(rawView);
}

// ── fixtures：每一份都标了出处 ────────────────────────────────────────────

/**
 * 强制补位。
 * 出处：真引擎 seed 1、第 5 回合、phase=replace（对手「画间沉铁兽」169/435）。
 */
const FIX_REPLACE = position(view({
  stateVersion: 25, turn: 5, phase: 'replace',
  pets: [withMax(pet({name: '寂灭骨龙', slot: 0, hp: 0, energy: 2, fainted: true}), 425),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '黑猫巫师', slot: 2, hp: 474, energy: 0}), 474)],
  foeField: withMax(pet({name: '画间沉铁兽', slot: 0, hp: 169, energy: 1}), 435),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [switchAction(1), switchAction(2)],
  needsReplacement: ['player'],
}));

/**
 * 收线（稳）：真引擎 seed 20260921 第 1 回合的镜像对位 + 真规划回执。
 * 唯一改动：把能量从 2 提到 4——否则「坟场搏击」（能耗 4）放不出来，
 * 而这条分支要测的正是「放得出来的那一手能不能收」。能量 4 在真实对局里可达
 * （开局 2 + 每回合 1，或吃一次「能量果」+4）。
 */
const KO_PLAN = {
  ok: true,
  state_version: 0,
  recommendation: '使用能量果',
  recommendation_stable: true,
  main_counter: '诡刺',
  expected: {min: 0.5803, max: 0.5803, mean: 0.5803},
  worst: {min: 0.1245, max: 0.1245},
  first_second_margin: {min: 0.0449, max: 0.0449, mean: 0.0449, scale: 'one-ply-value'},
  damage_preview: {
    available: true, min: 130, max: 469, best_label: '坟场搏击', lethal: true, lethal_stable: true,
    foe_hp: 425, formula_verified: false, damage_model: 'community-hypothesis-v1', candidates: 2,
    samples: [{label: '坟场搏击', min: 469, max: 469}, {label: '诡刺', min: 130, max: 130}],
  },
  risk: {downside_min: 1.6606, downside_max: 1.6606, fragile: true, threshold: 1.2, top_risks: [{opponent_action: '诡刺'}]},
  coverage: 1, timed_out: false,
};

/**
 * 开场镜像对位的公开视图（真引擎 seed 20260921 第 1 回合）。
 *
 * `energy` 决定「坟场搏击」（真数据：能耗 4）**在不在合法动作里**——合法动作是引擎
 * 按能量过滤过的，手搭 fixture 时如果让一只只有 2 点能量的伙伴「可以点」4 能耗的招，
 * 测出来的就不是引擎的行为。所以这里按能量算出合法技能表。
 */
function mirrorTurnOne({energy}) {
  const castable = [SKILLS.龙血, SKILLS.集中, SKILLS.诡刺, ...(energy >= 4 ? [SKILLS.坟场搏击] : [])];
  return position(view({
    stateVersion: 0, turn: 1,
    pets: [withMax(pet({name: '寂灭骨龙', slot: 0, hp: 425, energy}), 425),
      withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
      withMax(pet({name: '黑猫巫师', slot: 2, hp: 474, energy: 0}), 474)],
    skills: [SKILLS.坟场搏击, SKILLS.诡刺, SKILLS.龙血, SKILLS.集中, SKILLS.音爆, SKILLS.彗星],
    foeField: withMax(pet({name: '寂灭骨龙', slot: 0, hp: 425, energy: 2}), 425),
    foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
    legal: [...castable.map((skill) => skillAction(skill.name)),
      switchAction(1), switchAction(2), itemAction('净化药'), itemAction('回复药'), itemAction('能量果'), escapeAction()],
  }));
}

const FIX_KO_NOW = mirrorTurnOne({energy: 4});

/**
 * 收线（不稳）：同一份真实预估的**包络**形状——同一招在不同分析口径下
 * 落到 380~469，跨过了对面 425 的血线。引擎合并多个分析口径时就是这个形状。
 */
const KO_MAYBE_PLAN = {
  ...KO_PLAN,
  damage_preview: {
    ...KO_PLAN.damage_preview,
    min: 380, max: 469, lethal: false, lethal_stable: false,
    samples: [{label: '坟场搏击', min: 380, max: 469}, {label: '诡刺', min: 128, max: 131}],
  },
};

/**
 * 血量见底 + 有厚后备。
 * 出处：真引擎 seed 11、第 10 回合（「黑猫巫师」56/474，对面「画间沉铁兽」376/435 且挂着 5 层中毒）。
 */
const FIX_SWITCH_LOW = position(view({
  stateVersion: 50, turn: 10,
  pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 56, energy: 1}), 474),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
  foeField: withMax(pet({name: '画间沉铁兽', slot: 0, hp: 376, energy: 3, statuses: {中毒: {layers: 5}}}), 435),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('魔能爆'), skillAction('彗星'), switchAction(1), switchAction(2),
    itemAction('净化药'), itemAction('回复药'), escapeAction()],
  events: [
    {turn: 9, kind: 'turn_start', side: null, detail: {turn: 9}, text: '第 9 回合开始。'},
    {turn: 9, kind: 'damage', side: null,
      detail: {side: 'enemy', skill_id: 'skill_000498', damage: 110, type_multiplier: 1.0, formula_verified: false},
      text: '对方的跺地命中，造成约 110 点伤害（伤害公式未核验，这是引擎估值）。'},
    {turn: 9, kind: 'status_tick', side: null, detail: {side: 'enemy', status: '中毒', damage: 13, layers_after: 5},
      text: '对方因中毒损失约 13 点生命。'},
  ],
}));

/**
 * 对面在持续掉血（而我方血量还够）。
 * 出处：真引擎 seed 2、第 7 回合（「黑猫巫师」281/474，对面「银月狼王」384/416 挂着 1 层灼烧）。
 */
const FIX_FOE_STATUS = position(view({
  stateVersion: 37, turn: 7,
  pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 281, energy: 1}), 474),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
  foeField: withMax(pet({name: '银月狼王', slot: 0, hp: 384, energy: 1, statuses: {灼烧: {layers: 1}}}), 416),
  foeBench: [{slot: 0, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('彗星'), skillAction('拍击'), skillAction('念力膨胀'), switchAction(1), switchAction(2),
    itemAction('净化药'), itemAction('回复药'), escapeAction()],
  events: [
    {turn: 6, kind: 'status_applied', side: null, detail: {side: 'player', skill_id: 'skill_000758'},
      text: '我方用魔镜施加了效果。'},
    {turn: 6, kind: 'status_tick', side: null, detail: {side: 'enemy', status: '灼烧', damage: 8, layers_after: 1},
      text: '对方因灼烧损失约 8 点生命。'},
  ],
}));

/**
 * 属性克制（上一手真打出来的倍率）。
 * 出处：真引擎 seed 4、第 4 回合（「海豹船长」176/374 用「气波」打「画间沉铁兽」234，倍率 2.0）。
 */
const FIX_TYPE_FAVOURED = position(view({
  stateVersion: 18, turn: 4,
  pets: [withMax(pet({name: '海豹船长', slot: 0, hp: 176, energy: 2}), 374),
    withMax(pet({name: '黑猫巫师', slot: 1, hp: 474, energy: 0}), 474),
    withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
  foeField: withMax(pet({name: '画间沉铁兽', slot: 0, hp: 201, energy: 1}), 435),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('气波'), skillAction('偷袭'), skillAction('穿膛'), skillAction('防御'),
    switchAction(1), switchAction(2), itemAction('回复药'), escapeAction()],
  events: [
    {turn: 3, kind: 'turn_start', side: null, detail: {turn: 3}, text: '第 3 回合开始。'},
    {turn: 3, kind: 'damage', side: null,
      detail: {side: 'player', skill_id: 'skill_000673', damage: 234, type_multiplier: 2.0, formula_verified: false},
      text: '我方的气波命中，造成约 234 点伤害（伤害公式未核验，这是引擎估值），属性克制。'},
  ],
}));

/**
 * 属性抵抗。
 * 出处：真引擎 seed 11、第 6 回合（「黑猫巫师」278/474 用「灵媒」打「画间沉铁兽」只有 31，倍率 0.5）。
 */
const FIX_TYPE_RESISTED = position(view({
  stateVersion: 25, turn: 6,
  pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 278, energy: 4}), 474),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
  foeField: withMax(pet({name: '画间沉铁兽', slot: 0, hp: 343, energy: 3}), 435),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('灵媒'), skillAction('彗星'), skillAction('拍击'), skillAction('音爆'), skillAction('念力膨胀'),
    switchAction(1), switchAction(2), itemAction('回复药'), escapeAction()],
  events: [
    {turn: 5, kind: 'turn_start', side: null, detail: {turn: 5}, text: '第 5 回合开始。'},
    {turn: 5, kind: 'damage', side: null,
      detail: {side: 'enemy', skill_id: 'skill_000727', damage: 75, type_multiplier: 1.0, formula_verified: false},
      text: '对方的碰爪命中，造成约 75 点伤害（伤害公式未核验，这是引擎估值）。'},
    {turn: 5, kind: 'damage', side: null,
      detail: {side: 'player', skill_id: 'skill_000753', damage: 31, type_multiplier: 0.5, formula_verified: false},
      text: '我方的灵媒命中，造成约 31 点伤害（伤害公式未核验，这是引擎估值），属性抗性。'},
  ],
}));

/**
 * 速度差。
 * 出处：真引擎 seed 20260921、第 2 回合（「寂灭骨龙」289/425、速度 60；对面「化蝶」311/311、速度 100）。
 */
const FIX_SPEED = position(view({
  stateVersion: 5, turn: 2,
  pets: [withMax(pet({name: '寂灭骨龙', slot: 0, hp: 289, energy: 6}), 425),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '黑猫巫师', slot: 2, hp: 474, energy: 0}), 474)],
  foeField: withMax(pet({name: '化蝶', slot: 0, hp: 311, energy: 1}), 311),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('偷袭'), skillAction('穿膛'), skillAction('龙吼'), skillAction('诡刺'), skillAction('防御'),
    switchAction(1), switchAction(2), itemAction('回复药'), itemAction('能量果'), escapeAction()],
  events: [
    {turn: 1, kind: 'turn_start', side: null, detail: {turn: 1}, text: '第 1 回合开始。'},
    {turn: 1, kind: 'item', side: null, detail: {side: 'player', item: '能量果', energy_gained: 4},
      text: '我方使用了道具，获得 4 点能量。'},
    {turn: 1, kind: 'damage', side: null,
      detail: {side: 'enemy', skill_id: 'skill_000000', damage: 136, type_multiplier: 2.0, formula_verified: false},
      text: '对方的飞吻命中，造成约 136 点伤害（伤害公式未核验，这是引擎估值），属性克制。'},
  ],
}));

/**
 * 对面能量快满。
 * 出处：真引擎 seed 20260921 镜像局、第 10 回合（我方「黑猫巫师」474/474、能量 0；
 * 对面「黑猫巫师」117/474、能量 6——引擎上限就是 6）。
 */
const FIX_FOE_ENERGY = position(view({
  stateVersion: 53, turn: 10,
  pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 474, energy: 0}), 474),
    withMax(pet({name: '寂灭骨龙', slot: 1, hp: 0, energy: 0, fainted: true}), 425),
    withMax(pet({name: '海豹船长', slot: 2, hp: 0, energy: 0, fainted: true}), 374)],
  foeField: withMax(pet({name: '黑猫巫师', slot: 0, hp: 117, energy: 6}), 474),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('彗星'), skillAction('魔能爆'), itemAction('回复药'), escapeAction()],
}));

/**
 * 对面残血（补刀立场）。
 * 出处：真引擎 seed 5、第 8 回合（我「海豹船长」213/374、速度 100；对面「寂灭骨龙」9/425、
 * 速度 60）。这一份刻意**不带**规划回执：收线估算在真实链路里只有开局那回合可得
 * （见设计文档 §10），但「对面只剩 9 血」这个公开事实应当能单独说话。
 */
const FIX_FOE_LOW = position(view({
  stateVersion: 60, turn: 8,
  pets: [withMax(pet({name: '海豹船长', slot: 0, hp: 213, energy: 1}), 374),
    withMax(pet({name: '寂灭骨龙', slot: 1, hp: 0, energy: 0, fainted: true}), 425),
    withMax(pet({name: '黑猫巫师', slot: 2, hp: 474, energy: 0}), 474)],
  foeField: withMax(pet({name: '寂灭骨龙', slot: 0, hp: 9, energy: 1}), 425),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('气波'), skillAction('冷风'), skillAction('防御'), switchAction(1), switchAction(2),
    itemAction('回复药'), escapeAction()],
  events: [
    {turn: 7, kind: 'damage', side: null,
      detail: {side: 'player', skill_id: 'skill_000673', damage: 193, type_multiplier: 2.0, formula_verified: false},
      text: '我方的气波命中，造成约 193 点伤害（伤害公式未核验，这是引擎估值），属性克制。'},
  ],
}));

/**
 * 均势：双方满血、速度相同、都没有异常、我方能量够、对面能量不高、规划也没给出收线。
 * 这一份**故意**带着 `risk.fragile = true` 与「引擎推荐了彗星」——两个都不该让它开口。
 */
const EVEN_PLAN = {
  ok: true,
  state_version: 12,
  recommendation: '彗星',
  recommendation_stable: true,
  main_counter: '彗星',
  expected: {min: 0.4, max: 0.4, mean: 0.4},
  worst: {min: -0.2, max: -0.2},
  first_second_margin: {min: 0.02, max: 0.02, mean: 0.02, scale: 'one-ply-value'},
  damage_preview: {
    available: true, min: 80, max: 250, best_label: '彗星', lethal: false, lethal_stable: true,
    foe_hp: 474, formula_verified: false, damage_model: 'community-hypothesis-v1',
    samples: [{label: '彗星', min: 250, max: 250}, {label: '拍击', min: 80, max: 80}],
  },
  risk: {downside_min: 1.5, downside_max: 1.5, fragile: true, threshold: 1.2, top_risks: []},
};

const FIX_EVEN = position(view({
  stateVersion: 12, turn: 3,
  pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 474, energy: 3}), 474),
    withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
    withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
  skills: [SKILLS.彗星, SKILLS.拍击, SKILLS.龙血, SKILLS.集中],
  foeField: withMax(pet({name: '黑猫巫师', slot: 0, hp: 474, energy: 3}), 474),
  foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
  legal: [skillAction('彗星'), skillAction('拍击'), skillAction('龙血'), skillAction('集中'),
    switchAction(1), switchAction(2), itemAction('回复药'), escapeAction()],
}));

/** 全部场景表（顺序即文档里的编号）。 */
const SCENARIOS = [
  {name: '强制补位', game: FIX_REPLACE, plan: null, expect: 'replace-required'},
  {name: '收线（稳）', game: FIX_KO_NOW, plan: KO_PLAN, expect: 'ko-now'},
  {name: '收线（不稳）', game: FIX_KO_NOW, plan: KO_MAYBE_PLAN, expect: 'ko-maybe'},
  {name: '对面残血补刀', game: FIX_FOE_LOW, plan: null, expect: 'foe-low-hp'},
  {name: '血量见底换人', game: FIX_SWITCH_LOW, plan: null, expect: 'switch-low-hp'},
  {name: '能量不够', game: mirrorTurnOne({energy: 2}), plan: KO_PLAN, expect: 'energy-short'},
  {name: '对面持续掉血', game: FIX_FOE_STATUS, plan: null, expect: 'foe-status-ticking'},
  {name: '属性克制', game: FIX_TYPE_FAVOURED, plan: null, expect: 'type-favoured'},
  {name: '属性抵抗', game: FIX_TYPE_RESISTED, plan: null, expect: 'type-resisted'},
  {name: '速度差', game: FIX_SPEED, plan: null, expect: 'speed-decides'},
  {name: '对面能量快满', game: FIX_FOE_ENERGY, plan: null, expect: 'foe-energy-high'},
];

/** 跑一遍所有场景，返回 `{scenario, advice}`（advice 为 null 表示沉默）。 */
function runAll() {
  return SCENARIOS.map((scenario) => ({
    ...scenario,
    advice: coachAdvice({game: scenario.game, plan: scenario.plan}),
  }));
}

const PRODUCED = runAll().filter((row) => row.advice);

/** fixture 里出现过的所有伙伴名与技能名：用来判断句子有没有点名。 */
const KNOWN_NAMES = Object.freeze([
  ...Object.keys(SPECIES),
  ...Object.keys(SKILLS),
  '能量果', '回复药', '净化药',
]);

/**
 * 「明确立场」的有限词表：句子没有点名时，至少要给出一个能照着做的态度。
 * 这个表故意宽松——它要挡的是「说了一堆但没有动作」的句子，不是措辞审查。
 */
const STANCE_WORDS = Object.freeze([
  '换人', '换来', '顶上', '补位', '继续', '别硬', '别拿', '拖住', '稳住', '先手', '先换', '改招', '压上', '躲',
]);

// ── 测试 ──────────────────────────────────────────────────────────────────

test('每个检测器在自己那份局面上开口，并报出自己的 kind', () => {
  for (const scenario of SCENARIOS) {
    const advice = coachAdvice({game: scenario.game, plan: scenario.plan});
    assert.ok(advice, `${scenario.name}：这个局面应当开口，实际沉默了`);
    assert.equal(advice.kind, scenario.expect, `${scenario.name}：kind 不对`);
    assert.ok(COACH_ADVICE_KINDS.includes(advice.kind), `${scenario.name}：kind 不在公开标签里`);
  }
});

test('可达的 kind 至少有 6 个（不同局面结构上不同）', () => {
  const kinds = new Set(PRODUCED.map((row) => row.advice.kind));
  assert.ok(kinds.size >= 6, `只观察到 ${kinds.size} 种 kind：${[...kinds].join('/')}`);
  assert.equal(kinds.size, SCENARIOS.length, '每个场景应当各自对应一种 kind');
});

test('均势局面返回 null（沉默），而不是硬凑一句话', () => {
  assert.equal(coachAdvice({game: FIX_EVEN, plan: EVEN_PLAN}), null);
  // 规划说不稳（recommendation_stable=false）时也不该因此开口。
  assert.equal(coachAdvice({game: FIX_EVEN, plan: {...EVEN_PLAN, recommendation_stable: false, recommendation: null}}), null);
  // 「这一手不稳」（fragile）本身不是开口的理由——旧路径正是在这里说同一句话。
  assert.equal(coachAdvice({game: FIX_EVEN, plan: {...EVEN_PLAN, risk: {...EVEN_PLAN.risk, fragile: true}}}), null);
  // 没有视图 / 局面已结束：都不说。
  assert.equal(coachAdvice({}), null);
  assert.equal(coachAdvice({game: position(view({
    stateVersion: 60, turn: 20, phase: 'finished', result: 'win',
    pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 474, energy: 3}), 474)],
    foeField: withMax(pet({name: '寂灭骨龙', slot: 0, hp: 0, energy: 0, fainted: true}), 425),
    foeBench: [{slot: 1, fainted: true}],
    legal: [],
  }))}), null);
});

test('提示文案里没有任何工程词', () => {
  const forbidden = ['区间', '尾部', 'margin', 'score', '种子', 'coverage', 'state_version', 'worst', '{', '}'];
  for (const row of PRODUCED) {
    for (const word of forbidden) {
      assert.ok(!row.advice.text.includes(word), `${row.name} 的句子里出现了「${word}」：${row.advice.text}`);
    }
  }
});

test('每句话都指向一个具体动作/伙伴/技能或明确立场，且 why 与 risk 都不为空', () => {
  for (const row of PRODUCED) {
    const {text, why, risk} = row.advice;
    assert.ok(text.length > 0, `${row.name}：句子为空`);
    assert.ok(text.length <= 60, `${row.name}：句子太长（${text.length} 字）：${text}`);
    assert.ok(why && why.length > 0, `${row.name}：why 为空`);
    assert.ok(risk && risk.length > 0, `${row.name}：risk 为空`);
    const named = KNOWN_NAMES.some((name) => text.includes(name));
    const stance = STANCE_WORDS.some((word) => text.includes(word));
    assert.ok(named || stance, `${row.name}：句子既没点名也没给立场：${text}`);
  }
});

test('句子不说胜率、不说「最优」、不承诺赢', () => {
  const taboo = ['胜率', '最优', '一定能赢', '必赢', '稳赢'];
  for (const row of PRODUCED) {
    for (const word of taboo) {
      assert.ok(!row.advice.text.includes(word), `${row.name}：出现了「${word}」`);
    }
  }
});

test('每个 kind 的句子形状互不相同，且不靠换数字重复', () => {
  const shapes = PRODUCED.map((row) => normaliseAdviceShape(row.advice.text));
  const counts = new Map();
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  for (const [shape, count] of counts) {
    assert.ok(count / shapes.length <= 0.6, `同一种句子形状占了 ${count}/${shapes.length}：${shape}`);
  }
  // 归一化本身要真的抹掉数字（否则上面那条等于没测）。
  assert.equal(normaliseAdviceShape('你只剩 12% 血，对面 425'), '你只剩 #% 血，对面 #');
});

test('同一句已经说过就不再重复（重复提示本身就是噪声）', () => {
  const advice = coachAdvice({game: FIX_FOE_STATUS, plan: null});
  assert.ok(advice);
  const said = new Set([normaliseAdviceShape(advice.text)]);
  assert.equal(coachAdvice({game: FIX_FOE_STATUS, plan: null, session: {said}}), null);
  // 玩家自己点掉之后本局不再主动开口（页面也有一道，这里是兜底）。
  assert.equal(coachAdvice({game: FIX_FOE_STATUS, plan: null, session: {dismissed: true}}), null);
  // 局已结束 / 局面已过期：门控层过了也不说。
  assert.equal(coachAdvice({game: FIX_FOE_STATUS, plan: null, host: {ended: true}}), null);
  assert.equal(coachAdvice({game: FIX_FOE_STATUS, plan: null, host: {stale: true}}), null);
});

test('缺少规划回执时，依赖它的检测器不猜（其余照常开口）', () => {
  // 收线/能量那两条没有 plan 就不能算——但补位、换人、异常这些不依赖 plan。
  assert.equal(coachAdvice({game: FIX_KO_NOW, plan: null}), null);
  assert.equal(coachAdvice({game: mirrorTurnOne({energy: 2}), plan: null}), null);
  assert.ok(coachAdvice({game: FIX_REPLACE, plan: null}));
  assert.ok(coachAdvice({game: FIX_SWITCH_LOW, plan: null}));
  assert.ok(coachAdvice({game: FIX_FOE_STATUS, plan: null}));
});

test('直接递原始公开视图（没有经过 rocoGameView 投影）也能读出同一个局面', () => {
  // 接入时两种形状都可能被传进来；只认一种的后果是**安静地沉默**，那种失败最难查。
  const raw = view({
    stateVersion: 37, turn: 7,
    pets: [withMax(pet({name: '黑猫巫师', slot: 0, hp: 281, energy: 1}), 474),
      withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
      withMax(pet({name: '寂灭骨龙', slot: 2, hp: 425, energy: 0}), 425)],
    foeField: withMax(pet({name: '银月狼王', slot: 0, hp: 384, energy: 1, statuses: {灼烧: {layers: 1}}}), 416),
    foeBench: [{slot: 0, fainted: false}, {slot: 2, fainted: false}],
    legal: [skillAction('彗星'), switchAction(1), switchAction(2), itemAction('回复药')],
    events: [{turn: 6, kind: 'status_tick', side: null, detail: {side: 'enemy', status: '灼烧', damage: 8, layers_after: 1},
      text: '对方因灼烧损失约 8 点生命。'}],
  });
  const advice = coachAdvice({game: raw, plan: null});
  assert.equal(advice?.kind, 'foe-status-ticking');
  assert.ok(advice.text.includes('灼烧'));
});

test('对手的 active 是它在自己队伍里的位次，不能拿它索引「场上那只」', () => {
  // 出处：真引擎 seed 5、第 8 回合的真实窗口——`opponent.active` 是 1，而
  // `opponent.field` 是另一只（海豹船长），后备里 slot 0 已倒下。
  // 拿 `active` 当下标会读到一条后备记录（血/速度/名字全 null），检测器就**安静地不说话**。
  const raw = view({
    stateVersion: 42, turn: 8, foeActive: 1,
    pets: [withMax(pet({name: '寂灭骨龙', slot: 0, hp: 0, energy: 0, fainted: true}), 425),
      withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
      withMax(pet({name: '黑猫巫师', slot: 2, hp: 242, energy: 4}), 474)],
    foeField: withMax(pet({name: '海豹船长', slot: 0, hp: 164, energy: 1}), 374),
    foeBench: [{slot: 0, fainted: true}, {slot: 2, fainted: false}],
    legal: [skillAction('彗星'), switchAction(1), itemAction('回复药')],
    events: [
      {turn: 7, kind: 'damage', side: null,
        detail: {side: 'player', skill_id: 'skill_000321', damage: 90, type_multiplier: 1.0, formula_verified: false},
        text: '我方的彗星命中，造成约 90 点伤害（伤害公式未核验，这是引擎估值）。'},
    ],
  });
  // 我方 active 也该按索引读：这一份里场上是第 3 只（黑猫巫师，速度 70 比对面 100 慢）。
  assert.equal(coachAdvice({game: raw, plan: null})?.kind, 'speed-decides');
  assert.equal(coachAdvice({game: position(raw), plan: null})?.kind, 'speed-decides');
});

test('上一手那一招这一轮放不出来时，不猜「换个同系别的招」', () => {
  // 出处：真引擎 seed 20260921 第 3 回合（我方「寂灭骨龙」165/425、能量 1）。
  // 上一手「角击」（龙系，能耗 2）打出克制，但这一轮能量只够 1 费招，角击不在合法动作里；
  // 而它的系别只能从合法动作/`self.skills` 读（后者第一次推进后就是空的），
  // 所以「角击是龙系，可以换龙吼」这一步**没有公开依据**——宁可沉默，也不猜一个系别。
  const raw = view({
    stateVersion: 10, turn: 3,
    pets: [withMax(pet({name: '寂灭骨龙', slot: 0, hp: 165, energy: 1}), 425),
      withMax(pet({name: '海豹船长', slot: 1, hp: 374, energy: 0}), 374),
      withMax(pet({name: '黑猫巫师', slot: 2, hp: 474, energy: 0}), 474)],
    foeField: withMax(pet({name: '寂灭骨龙', slot: 0, hp: 165, energy: 1}), 425),
    foeBench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}],
    legal: [skillAction('龙吼'), skillAction('诡刺'), switchAction(1), switchAction(2), itemAction('回复药')],
    events: [
      {turn: 2, kind: 'damage', side: null,
        detail: {side: 'player', skill_id: 'skill_000572', damage: 260, type_multiplier: 2.0, formula_verified: false},
        text: '我方的角击命中，造成约 260 点伤害（伤害公式未核验，这是引擎估值），属性克制。'},
    ],
  });
  assert.equal(coachAdvice({game: raw, plan: null}), null);
  // 对照：同一局面把上一手换成**这一轮仍合法**的招（龙吼），属性那一条就会开口。
  const withLegalMove = {...raw, events: [{
    turn: 2, kind: 'damage', side: null,
    detail: {side: 'player', skill_id: 'skill_000563', damage: 260, type_multiplier: 2.0, formula_verified: false},
    text: '我方的龙吼命中，造成约 260 点伤害（伤害公式未核验，这是引擎估值），属性克制。',
  }]};
  assert.equal(coachAdvice({game: withLegalMove, plan: null})?.kind, 'type-favoured');
});

test('「更狠一点但决定不了这一轮」的贵招放不出来时不开口', () => {
  // 引擎修好配招序列化之后，「最狠那招放不出」几乎是开局常态（能量 2、贵招要 4）。
  // 只是「更狠一点」不值得打断玩家——那正是「反复只说同一句」的翻版。
  const plan = {
    ...KO_PLAN,
    damage_preview: {
      ...KO_PLAN.damage_preview,
      min: 90, max: 200, lethal: false, lethal_stable: true,
      samples: [{label: '坟场搏击', min: 90, max: 200}, {label: '诡刺', min: 60, max: 130}],
    },
  };
  assert.equal(coachAdvice({game: mirrorTurnOne({energy: 2}), plan}), null);
  // 对照：同一局面下这一招的估算**盖得过对面血线**（能决定这一轮）→ 开口。
  const lethal = coachAdvice({game: mirrorTurnOne({energy: 2}), plan: KO_PLAN});
  assert.equal(lethal?.kind, 'energy-short');
  assert.ok(lethal.text.includes('收掉'), lethal.text);
});

test('本模块在浏览器模块图里安全：没有 node:* / require / import', () => {
  const source = readFileSync(new URL('../../src/coach/coach-advice.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(source), '模块静态导入了 node:*（浏览器起不来）');
  assert.ok(!/\brequire\s*\(/.test(source), '模块用了 require');
  assert.ok(!/^\s*import\s/m.test(source), '模块有静态 import（这一层应当是零依赖纯函数）');
  assert.ok(!/(?:from|import)\s*\(?\s*['"][^'"]*src\/client/.test(source),
    '模块依赖了 src/client/*（那一层是页面，不该被教练层反向依赖）');
});
