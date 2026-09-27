// 局末复盘的「更深一层」判据（关键片段 / 资源账 / 一条有条件的下一步）。
//
// ── 这一份判据要回答的问题 ──────────────────────────────────────────────────
//
// 人类（产品负责人）看过一局的复盘之后说：「我感觉这个复盘有点太简单了」。当时的
// 「完整复盘与依据」区只有「几个回合 + 第一次减员」+「一条学习点」+ 2~4 条依据。
// 把复盘加厚的风险**不是**文案不好听，而是**凭空多出几个看起来很像事实的数字**——
// 那正是这个仓库的红线（伤害与胜负只由引擎算，教练层只解释）。所以这一份判据量的
// 不是「话说得够不够多」，而是加厚的每一条**能不能被同一份事件重算出来**：
//
//   ① 每条事实都带 `anchors`（事件下标），且拿 `events` 重算一遍数字必须一模一样；
//   ② 没有事件支撑的那一条**不出现**（fail closed）；
//   ③ 必红反证：把事件里的关键行删掉，对应那条必须消失或降级（判据本身有牙）；
//   ④ 一个百分数、一句胜率/概率都不许出现（新加的这一层里没有「预估」这回事）。
//
// ── 事件形状的出处（不许发明字段）────────────────────────────────────────────
//
// 夹具里的事件全部是**引擎真的会发出来的形状**，字段逐个对过源码：
//   · `env.py:_bump(...)` 的各调用点（`damage` 带 `side/skill_id/target_slot/damage/
//     type_multiplier`；`energy_regen` 带 `side/energy`；`defense` 带 `side/skill_id/reduction`；
//     `item` 带 `side/item/healed`；`switch` 带 `side/to_slot`；`replacement` 带 `side/slot`；
//     `faint` 带 `side/slot`）；
//   · 信封形状 `{kind, turn, detail, evidence, text}` 来自 `service.py` 的 `_sim_envelope`。
// 最后一个用例是**真服务 + 真引擎**跑完整局，用真事件再核一遍同样这几条。
//
// ⚠ 注册状态（`tests/evals/structure-contract.test.js` 有一条「孤儿守卫不是守卫」的判据：
//   每个 `*.test.js` 都必须被某个 npm script 或 `scripts/roco/guard-selftest.mjs` 的登记表引用）：
//   · 本文件登记在 `scripts/roco/guard-selftest.mjs` 里，条目 id
//     `match-review-depth-fabricated-number`（注入「最重的一击 +1」，本文件必须红）；
//     于是它**会**在 `npm run test:unit` 的 `tests/evals/guard-selftest.test.js` 那一跑里被执行。
//   · 它**还不在** `package.json` 的 `test:unit` 清单里（那份清单由主线程维护，本次施工不擅自改）。
//     要单独跑：
//       `node --test tests/roco-match-review-depth.test.js`
//     要进 CI 的常规清单，由主线程往 `test:unit` 里加一行这个相对路径即可。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

import {createCoachServer} from '../src/server/index.js';
import {rocoGameView, rocoMatchDepth, rocoMatchReview} from '../src/coach/roco-experience.js';
import {reviewMatch} from '../src/coach/teacher-review.js';
import {freshMemory} from '../src/coach/memory.js';

// ── 造事件：一条真实信封一条 ────────────────────────────────────────────────
const ev = (turn, kind, detail, text = '') => ({turn, kind, detail, evidence: [], text});

/** 公开视图：字段名与 `ui_public_view` 一致（含己方配招全表与能量上限）。 */
function viewOf({result = 'loss', turn = 9, pets, skills, energyMax = 6} = {}) {
  return {
    battle_result: result,
    phase: 'ended',
    turn,
    ruleset_id: 'roco-world-s4-2026-09-10',
    state_version: 900,
    self: {active: 0, energy_max: energyMax, skills, pets},
    opponent: {
      active: 0, living_count: 1,
      field: {slot: 0, pet_id: 'pet_000445', name: '画间沉铁兽', hp: 210, max_hp: 380, energy: 2, fainted: false},
      bench: [{slot: 1, fainted: false}, {slot: 2, fainted: true}],
    },
    legal: [{kind: 'skill', label: '气波', skill_id: 'skill_000673', skill_name: '气波'}],
  };
}

const PETS = [
  {slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 2, fainted: true},
  {slot: 1, pet_id: 'pet_000190', name: '海豹船长', hp: 0, max_hp: 374, energy: 1, fainted: true},
  {slot: 2, pet_id: 'pet_000191', name: '黑猫巫师', hp: 108, max_hp: 474, energy: 2, fainted: false},
];
// 己方配招全表（`ui_public_view` 的 `self.skills`）：这是技能显示名的**公开**来源。
const SKILLS = [
  {skill_id: 'skill_000750', name: '龙血'},
  {skill_id: 'skill_000673', name: '气波'},
  {skill_id: 'skill_000576', name: '防御'},
];

/**
 * 对局 A：9 个回合的整局事件流，五个「资源账」条目**每一条都有支撑**。
 *
 * 刻意安排的几个点：
 *   · 全场最重的一击是**我方**的「气波」（第 6 回合 230 点）→ 名字应当说得出来；
 *   · 吃掉属性克制最贵的一击在第 2 回合（96 点，落在首发身上）→ 「下一步」的条件；
 *   · 主动换人只发生一次（第 4 回合）→ 最长断档是第 5–9 回合（5 个回合）；
 *   · 能量记录最低 1 点，出现在第 1、3、8 回合（回能事件只在能量变了时才发）。
 */
function matchA() {
  const events = [
    ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 88, type_multiplier: 2, formula_verified: false}, '我方的「龙血」命中，造成约 88 点伤害，属性克制。'),
    ev(1, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 44, type_multiplier: 1, formula_verified: false}, '对方的「潮涌」命中，造成约 44 点伤害。'),
    ev(1, 'energy_regen', {side: 'player', energy: 1}, '我方的能量回到 1。'),
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 96, type_multiplier: 2, formula_verified: false}, '对方的「潮涌」命中，造成约 96 点伤害，属性克制。'),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 40, type_multiplier: 1, formula_verified: false}, '我方的「龙血」命中，造成约 40 点伤害。'),
    ev(2, 'energy_regen', {side: 'player', energy: 2}, '我方的能量回到 2。'),
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'item', {side: 'player', item: '回复药', healed: 45}, '我方使用了道具，回复 45 点生命。'),
    ev(3, 'energy_regen', {side: 'player', energy: 1}, '我方的能量回到 1。'),
    ev(4, 'turn_start', {turn: 4}, '第 4 回合开始。'),
    ev(4, 'switch', {side: 'player', to_slot: 1}, '我方换上了海豹船长。'),
    ev(4, 'switch', {side: 'enemy', to_slot: 1}, '对方换上了第 2 位精灵。'),
    ev(4, 'energy_regen', {side: 'player', energy: 3}, '我方的能量回到 3。'),
    ev(5, 'turn_start', {turn: 5}, '第 5 回合开始。'),
    ev(5, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 0, damage: 125, type_multiplier: 2, formula_verified: false}, '我方的「气波」命中，造成约 125 点伤害，属性克制。'),
    ev(5, 'damage', {side: 'enemy', skill_id: 'skill_000321', target_slot: 1, damage: 210, type_multiplier: 1, formula_verified: false}, '对方的「彗星」命中，造成约 210 点伤害。'),
    ev(5, 'faint', {side: 'player', slot: 1}, '我方的精灵倒下了。'),
    ev(5, 'replacement', {side: 'player', slot: 2}, '我方补上了第 3 位精灵。'),
    ev(5, 'energy_regen', {side: 'player', energy: 2}, '我方的能量回到 2。'),
    ev(6, 'turn_start', {turn: 6}, '第 6 回合开始。'),
    ev(6, 'defense', {side: 'player', skill_id: 'skill_000576', reduction: 0.7, respond: false}, '我方使用龙血，本回合减伤约 70%。'),
    ev(6, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 2, damage: 230, type_multiplier: 2, formula_verified: false}, '我方的「气波」命中，造成约 230 点伤害，属性克制。'),
    ev(6, 'faint', {side: 'enemy', slot: 2}, '对方的精灵倒下了。'),
    ev(6, 'replacement', {side: 'enemy', slot: 1}, '对方补上了第 2 位精灵。'),
    ev(6, 'energy_regen', {side: 'player', energy: 4}, '我方的能量回到 4。'),
    ev(7, 'turn_start', {turn: 7}, '第 7 回合开始。'),
    ev(7, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 1, damage: 12, type_multiplier: 0.5, formula_verified: false}, '我方的「气波」命中，造成约 12 点伤害，属性抗性。'),
    ev(7, 'damage', {side: 'enemy', skill_id: 'skill_000321', target_slot: 2, damage: 60, type_multiplier: 1, formula_verified: false}, '对方的「彗星」命中，造成约 60 点伤害。'),
    ev(7, 'energy_regen', {side: 'player', energy: 3}, '我方的能量回到 3。'),
    ev(8, 'turn_start', {turn: 8}, '第 8 回合开始。'),
    ev(8, 'damage', {side: 'enemy', skill_id: 'skill_000321', target_slot: 2, damage: 180, type_multiplier: 1, formula_verified: false}, '对方的「彗星」命中，造成约 180 点伤害。'),
    ev(8, 'faint', {side: 'player', slot: 2}, '我方的精灵倒下了。'),
    ev(8, 'replacement', {side: 'player', slot: 0}, '我方补上了第 1 位精灵。'),
    ev(8, 'energy_regen', {side: 'player', energy: 1}, '我方的能量回到 1。'),
    ev(9, 'turn_start', {turn: 9}, '第 9 回合开始。'),
    ev(9, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 150, type_multiplier: 1, formula_verified: false}, '对方的「潮涌」命中，造成约 150 点伤害。'),
    ev(9, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。'),
    ev(9, 'game_end', {result: 'loss'}, '对局结束：我方落败。'),
  ];
  const view = viewOf({pets: PETS, skills: SKILLS});
  return {events, turns: 9, view, game: rocoGameView(view, {matchId: 'm-depth-A'})};
}

/** 对局 B：没有属性克制挨打，但有**连着两回合**打在抵抗上 → 「下一步」走第二条规则。 */
function matchB() {
  const events = [
    ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 0, damage: 30, type_multiplier: 1, formula_verified: false}, '我方的「气波」命中，造成约 30 点伤害。'),
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 0, damage: 12, type_multiplier: 0.5, formula_verified: false}, '我方的「气波」命中，造成约 12 点伤害，属性抗性。'),
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 0, damage: 9, type_multiplier: 0.5, formula_verified: false}, '我方的「气波」命中，造成约 9 点伤害，属性抗性。'),
  ];
  const view = viewOf({result: 'draw', turn: 3, pets: PETS, skills: SKILLS});
  return {events, turns: 3, view, game: rocoGameView(view, {matchId: 'm-depth-B'})};
}

/** 对局 C：既没有属性克制挨打、也没有连着打抵抗，只有一次对面补位 → 第三条规则。 */
function matchC() {
  const events = [
    ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000673', target_slot: 0, damage: 30, type_multiplier: 2, formula_verified: false}, '我方的「气波」命中，造成约 30 点伤害，属性克制。'),
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。'),
    ev(2, 'replacement', {side: 'enemy', slot: 1}, '对方补上了第 2 位精灵。'),
  ];
  const view = viewOf({result: 'win', turn: 2, pets: PETS, skills: SKILLS});
  return {events, turns: 2, view, game: rocoGameView(view, {matchId: 'm-depth-C'})};
}

/** 对局 D：干净得没有转折点也没有资源可讲（老师那一角会沉默），用来验 fail closed。 */
function matchQuiet() {
  return {events: [ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。')], turns: 1};
}

// ── 核对工具：把判据写成「拿事件重算一遍」而不是「相信文案」──────────────────

/** 每个事实的事件下标只允许落在这些 kind 上（越界或指错 kind 都是核对失败）。 */
const ANCHOR_KINDS = Object.freeze({
  'heaviest-blow': ['damage'],
  'worst-turn-taken': ['damage', 'status_tick'],
  'switch-ledger': ['turn_start', 'switch', 'replacement'],
  'item-ledger': ['turn_start', 'item'],   // 零值账的锚点是整局回合骨架（没有道具事件可指）
  'energy-low': ['energy_regen'],
  'effect-ledger': ['defense', 'heal', 'lifesteal', 'status_added', 'status_applied', 'status_tick',
    'mark_added', 'buff_self', 'debuff_foe', 'energy_gain', 'drain_energy', 'position_shift', 'slot_condition_applied'],
});

const byId = (depth, id) => depth.facts.find((fact) => fact.id === id) ?? null;

function assertAnchorsResolve(depth, events) {
  for (const fact of depth.facts) {
    assert.ok(Array.isArray(fact.anchors) && fact.anchors.length > 0,
      `${fact.id} 必须带事件下标，否则「可核对」只是说法：${JSON.stringify(fact)}`);
    const allowed = ANCHOR_KINDS[fact.id];
    assert.ok(Array.isArray(allowed), `判据里没有登记 ${fact.id} 的锚点 kind`);
    for (const index of fact.anchors) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < events.length,
        `${fact.id} 的事件下标越界：${index}（事件共 ${events.length} 条）`);
      const kind = String(events[index]?.kind ?? '');
      assert.ok(allowed.includes(kind), `${fact.id} 的下标 ${index} 指向 ${kind}，不在允许的 ${allowed.join('/')} 里`);
    }
    assert.ok(!/skill_\d|pet_\d/.test(fact.text), `${fact.id} 的文案里漏出了内部 id：${fact.text}`);
    assert.ok(!/\{\s*"|undefined|NaN/.test(fact.text), `${fact.id} 的文案里有工程痕迹：${fact.text}`);
  }
}

/** 拿同一份事件把每条事实的数字重算一遍，逐条与 `fields` 对照。 */
function assertFactsRecomputable(depth, events) {
  assertAnchorsResolve(depth, events);
  const detailOf = (event) => event?.detail ?? {};

  const heaviest = byId(depth, 'heaviest-blow');
  if (heaviest) {
    const damages = events.filter((event) => event.kind === 'damage')
      .map((event) => detailOf(event).damage).filter(Number.isFinite);
    const max = Math.max(...damages);
    assert.equal(heaviest.fields.damage, max, '全场最重的一击必须等于事件里 damage 的最大值');
    const anchor = events[heaviest.anchors[0]];
    assert.equal(detailOf(anchor).damage, max);
    assert.equal(heaviest.fields.turn, anchor.turn);
    assert.ok(heaviest.text.includes(`第 ${anchor.turn} 回合`) && heaviest.text.includes(String(max)),
      `文案里必须写着锚点事件的那个回合与那个数字：${heaviest.text}`);
  }

  const worst = byId(depth, 'worst-turn-taken');
  if (worst) {
    const taken = new Map();
    const add = (turn, amount) => {
      if (!Number.isInteger(turn) || !Number.isFinite(amount) || amount <= 0) return;
      taken.set(turn, (taken.get(turn) ?? 0) + amount);
    };
    for (const event of events) {
      const detail = detailOf(event);
      if (event.kind === 'damage' && detail.side === 'enemy') add(event.turn, detail.damage);
      if (event.kind === 'status_tick' && detail.side === 'player') add(event.turn, detail.damage);
    }
    const best = Math.max(...[...taken.values()]);
    assert.equal(worst.fields.taken, best, '「最吃亏的一回合」必须等于逐回合挨打总量的最大值');
    assert.equal(taken.get(worst.fields.turn), best, '那个回合号必须真的是挨打最多的那一回合');
  }

  const switches = byId(depth, 'switch-ledger');
  if (switches) {
    const count = (kind, side) => events.filter((event) => event.kind === kind && detailOf(event).side === side).length;
    assert.equal(switches.fields.player_switches, count('switch', 'player'));
    assert.equal(switches.fields.enemy_switches, count('switch', 'enemy'));
    assert.equal(switches.fields.player_replacements, count('replacement', 'player'));
    assert.equal(switches.fields.enemy_replacements, count('replacement', 'enemy'));
    if (switches.fields.longest_no_switch !== null) {
      // 断档长度=最长的一段「区间里没有换人事件」（换人那一回合不算在断档里）。
      const total = depth.counts.turns_total;
      assert.ok(Number.isInteger(total), '算断档必须有回合总数（counts.turns_total）');
      const marks = [...new Set(events.filter((event) => event.kind === 'switch' && detailOf(event).side === 'player')
        .map((event) => event.turn))].sort((a, b) => a - b);
      let from = 1;
      let longest = 0;
      for (const turn of marks) { longest = Math.max(longest, turn - from); from = turn + 1; }
      longest = Math.max(longest, total - from + 1);
      assert.equal(switches.fields.longest_no_switch, longest, '最长断档必须能被重算出来');
      assert.ok(switches.text.includes(`连着 ${longest} 个回合`), switches.text);
    }
  }

  const items = byId(depth, 'item-ledger');
  if (items) {
    const mine = events.filter((event) => event.kind === 'item' && detailOf(event).side === 'player');
    assert.equal(items.fields.player_items, mine.length);
    assert.deepEqual(items.fields.turns, mine.map((event) => event.turn));
  }

  const energy = byId(depth, 'energy-low');
  if (energy) {
    const values = events.filter((event) => event.kind === 'energy_regen' && detailOf(event).side === 'player')
      .map((event) => detailOf(event).energy).filter(Number.isFinite);
    assert.equal(energy.fields.min, Math.min(...values), '能量最低值必须是事件里的最小值');
    assert.equal(energy.fields.samples, values.length);
    for (const turn of energy.fields.turns) {
      assert.ok(events.some((event) => event.kind === 'energy_regen' && event.turn === turn
        && detailOf(event).energy === energy.fields.min), `第 ${turn} 回合不是最低能量的那一回合`);
    }
  }

  const effects = byId(depth, 'effect-ledger');
  if (effects) {
    const counted = events.filter((event) => Object.hasOwn(ANCHOR_KINDS, 'effect-ledger')
      && ANCHOR_KINDS['effect-ledger'].includes(event.kind)).length;
    const sum = effects.fields.groups.reduce((total, group) => total + group.count, 0);
    assert.equal(sum, counted, '效果账的次数合计必须等于事件条数');
    for (const group of effects.fields.groups) {
      const truth = events.filter((event) => event.kind === group.kind && detailOf(event).side === group.side).length;
      assert.equal(group.count, truth, `${group.kind}/${group.side} 的条数对不上`);
    }
  }
}

const FORBIDDEN = /%|％|胜率|概率|百分比|置信|一定赢|最优/;

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function assertNoForbidden(text, where) {
  assert.ok(!FORBIDDEN.test(text), `${where} 里出现了百分数/胜率/概率这类不该有的字样：${text}`);
}

// ── ① 每条事实都能被机器核对 ────────────────────────────────────────────────

test('① 加厚的每一条都带事件下标，且能拿同一份事件重算（不是自由文本）', () => {
  const {events, turns, game} = matchA();
  const depth = rocoMatchDepth({events, game, turns});
  assert.ok(depth.facts.length >= 5, `这一局应当产出至少 5 条事实，实际 ${depth.facts.length}`);
  assertFactsRecomputable(depth, events);
  // 五类事实一个不少（缺一类说明夹具或实现漏了，而不是「刚好没发生」）
  assert.deepEqual(depth.facts.map((fact) => fact.id).sort(),
    ['effect-ledger', 'energy-low', 'heaviest-blow', 'item-ledger', 'switch-ledger', 'worst-turn-taken']);
  // `evidence` 就是这些事实的原文：页面「依据」渲染的是它，不许另写一份
  assert.deepEqual(depth.evidence, depth.facts.map((fact) => fact.text));

  // 效果账的「起止」：异常状态跨了很多回合时，报区间而不是一长串回合号（`fields` 里仍有全量）
  const longTicks = [...matchA().events];
  for (let turn = 10; turn <= 20; turn += 1) {
    longTicks.push(ev(turn, 'status_tick', {side: 'player', status: '中毒', damage: 10, layers_after: 1}, '我方回合末受到异常状态伤害。'));
  }
  const longDepth = rocoMatchDepth({events: longTicks, game: matchA().game, turns: 20});
  const longEffect = byId(longDepth, 'effect-ledger');
  assert.match(longEffect.text, /第 10–20 回合之间/, longEffect.text);
  assert.match(longEffect.text, /合计约 110 点/, longEffect.text);
  assert.equal(longEffect.fields.groups.find((group) => group.kind === 'status_tick').count, 11);
});

test('① 关键片段：最重的一击说得出技能名，挨打的那一只用我方公开名字', () => {
  const {events, turns, game} = matchA();
  const depth = rocoMatchDepth({events, game, turns});
  const heaviest = byId(depth, 'heaviest-blow');
  assert.equal(heaviest.fields.damage, 230);
  assert.equal(heaviest.fields.side, 'player');
  assert.match(heaviest.text, /第 6 回合/);
  // 己方技能名来自公开的 `self.skills`（同一个 skill_id ↔ 同一个技能）
  assert.match(heaviest.text, /用的是「气波」/);
  assert.match(heaviest.text, /打在对方第 3 位身上/);
  // 对手的技能名不在公开视图里 → 只写「那一手」，绝不编一个名字出来。
  // 造法：把**对方**那一击改成全场最重（400 点），同时把己方技能表清空——
  // 于是这次「最重的一击」的主人是拿不到名字的那一方。
  const enemyOnly = {...game, roco: {...game.roco, self: {...game.roco.self, skills: []}}};
  const enemyHeavy = events.map((event, index) => (index === 17 ? {...event, detail: {...event.detail, damage: 400}} : event));
  const enemyDepth = rocoMatchDepth({events: enemyHeavy, game: enemyOnly, turns});
  const enemyFact = byId(enemyDepth, 'heaviest-blow');
  assert.equal(enemyFact.fields.damage, 400);
  assert.equal(enemyFact.fields.side, 'enemy');
  assert.match(enemyFact.text, /对方那一手/);
  assert.ok(!enemyFact.text.includes('用的是「'), `对手的技能名不在公开表里，不许编：${enemyFact.text}`);
  // 反向对照：同一份事件只要有公开的己方技能表，己方那一击就说得名字
  //（否则上面那条只是「永远不写名字」的假绿）。
  const ownHeavy = rocoMatchDepth({events, game, turns});
  assert.match(byId(ownHeavy, 'heaviest-blow').text, /用的是「气波」/);
});

test('① 下一步：三条规则各由本局真实事件触发，条件是事件里那一回合', () => {
  const a = rocoMatchDepth({...matchA(), game: matchA().game});
  assert.equal(a.next_step.rule, 'enemy-type-advantage-hit');
  assert.equal(a.next_step.fields.turn, 2);
  assert.equal(a.next_step.fields.damage, 96, '取的必须是**最贵**的那一次属性克制挨打');
  assert.ok(a.next_step.text.includes('第 2 回合'), a.next_step.text);
  assert.ok(a.next_step.anchors.every((index) => matchA().events[index].kind === 'damage'));
  assertNoForbidden(a.next_step.text + a.next_step.action, '下一步');

  const b = matchB();
  const depthB = rocoMatchDepth({events: b.events, game: b.game, turns: b.turns});
  assert.equal(depthB.next_step.rule, 'our-resist-repeat');
  assert.deepEqual(depthB.next_step.fields, {from: 2, to: 3});
  assert.ok(depthB.next_step.text.includes('第 2、3 回合'), depthB.next_step.text);

  const c = matchC();
  const depthC = rocoMatchDepth({events: c.events, game: c.game, turns: c.turns});
  assert.equal(depthC.next_step.rule, 'enemy-replacement-first');
  assert.equal(depthC.next_step.fields.turn, 2);
  assert.ok(depthC.next_step.anchors.every((index) => c.events[index].kind === 'replacement'));
});

// ── ② fail closed：没有事件支撑就不许出现 ───────────────────────────────────

test('② 一条支撑事件都没有 → 一条事实都不产生（不补默认值、不编）', () => {
  const quiet = matchQuiet();
  const depth = rocoMatchDepth({events: quiet.events, turns: quiet.turns, game: null});
  assert.deepEqual(depth.facts, [], '只有一条 turn_start 时不该产出任何事实');
  assert.deepEqual(depth.evidence, []);
  assert.equal(depth.next_step, null, '没有本局事实支撑的「下一步」就是套话');
  assert.equal(depth.summary, null);
  assert.deepEqual(rocoMatchDepth({}).facts, []);
  assert.deepEqual(rocoMatchDepth({events: null, turns: null}).facts, []);
  assert.deepEqual(rocoMatchDepth({events: [null, 42, 'x']}).facts, [], '垃圾输入不许崩，也不许编');
});

test('② 逐条删掉支撑事件 → 对应那条必须消失', () => {
  const {events, turns, game} = matchA();
  const drop = (kind) => events.filter((event) => event.kind !== kind);

  const noEnergy = rocoMatchDepth({events: drop('energy_regen'), game, turns});
  assert.equal(byId(noEnergy, 'energy-low'), null, '没有回能事件就不许报能量账');

  const noEffect = rocoMatchDepth({events: drop('defense'), game, turns});
  assert.equal(byId(noEffect, 'effect-ledger'), null, '没有效果类事件就不许报手段账');

  const noDamage = rocoMatchDepth({events: drop('damage'), game, turns});
  assert.equal(byId(noDamage, 'heaviest-blow'), null, '没有伤害事件就不许报「最重的一击」');
  assert.equal(byId(noDamage, 'worst-turn-taken'), null, '没有伤害事件就不许报「最吃亏的一回合」');

  const nothing = rocoMatchDepth({events: [], game, turns});
  assert.deepEqual(nothing.facts, []);
  assert.equal(nothing.next_step, null);
});

// ── ③ 必红反证：删掉关键行之后结论必须变 ────────────────────────────────────

test('③ 反证：把关键行删掉/改小，对应那条必须消失或降级（判据有牙）', () => {
  const {events, turns, game} = matchA();
  const base = rocoMatchDepth({events, game, turns});
  assert.equal(byId(base, 'heaviest-blow').fields.damage, 230);

  // ① 把最重的那一击改小 → 最重的一击必须换人（而不是继续写 230）
  const smaller = events.map((event, index) => (index === 23 ? {...event, detail: {...event.detail, damage: 130}} : event));
  const downgraded = rocoMatchDepth({events: smaller, game, turns});
  assert.equal(byId(downgraded, 'heaviest-blow').fields.damage, 210,
    '把 230 改小之后，最重的应当是第 5 回合那 210 点');
  assert.equal(byId(downgraded, 'heaviest-blow').fields.turn, 5);

  // ② 把「属性克制的那一击」整条删掉 → 「下一步」不许还挂在它身上（换规则或消失）
  const noBadHit = events.filter((event, index) => index !== 5);
  const afterBadHit = rocoMatchDepth({events: noBadHit, game, turns});
  assert.notEqual(afterBadHit.next_step?.rule, 'enemy-type-advantage-hit',
    '条件事件没了还报同一条建议，就是拿上一局的结论冒充这一局');
  assert.ok(!String(afterBadHit.next_step?.text ?? '').includes('第 2 回合'));

  // ③ 把我方那次换人删掉 → 换人账必须从「1 次」降级成「没有记录」，且不再有断档结论
  const noSwitch = events.filter((event) => event.kind !== 'switch' || event.detail.side !== 'player');
  const afterSwitch = rocoMatchDepth({events: noSwitch, game, turns});
  const ledger = byId(afterSwitch, 'switch-ledger');
  assert.equal(ledger.fields.player_switches, 0);
  assert.ok(!ledger.text.includes('我方主动换人 1 次'), ledger.text);
  assert.match(ledger.text, /没有主动换人的记录/);
  assert.equal(ledger.fields.longest_no_switch, null, '一次都没换过时不再单独报断档');

  // ④ 道具那一条：删光道具事件后必须降级成「事件 0 条」，不是继续写「1 次」
  const noItem = rocoMatchDepth({events: events.filter((event) => event.kind !== 'item'), game, turns});
  assert.equal(byId(noItem, 'item-ledger').fields.player_items, 0);
  assert.match(byId(noItem, 'item-ledger').text, /道具事件 0 条/);
});

test('③ 反证：只看得到一段事件流时，「没有发生」这类话必须闭嘴', () => {
  const {events, game, turns} = matchA();
  // 页面如果只把**最后一次推进**的事件交给复盘，就是这个形状：只有最后一个回合那几条。
  const chunk = events.filter((event) => event.turn === 9);
  const depth = rocoMatchDepth({events: chunk, game, turns});
  assert.equal(depth.covers_whole_match, false);
  const text = depth.evidence.join(' ');
  assert.ok(!/0 条/.test(text), `看不到整局就不许说「事件 0 条」：${text}`);
  assert.ok(!/没有主动换人的记录/.test(text), `看不到整局就不许说「没有换人」：${text}`);
  assert.ok(!/连着 \d+ 个回合没有主动换人/.test(text), `看不到整局就不许报断档长度：${text}`);
  // 反过来：整局事件下这些结论本来就该在（证明上面几条不是「永远不出现」的假绿）
  const full = rocoMatchDepth({events, game, turns});
  assert.equal(full.covers_whole_match, true);
  assert.ok(/连着 5 个回合没有主动换人/.test(full.evidence.join(' ')), full.evidence.join(' '));
});

// ── ④ 不许出现百分数/胜率/概率 ──────────────────────────────────────────────

test('④ 新加的这一层里没有百分数、胜率、概率（含反证格式）', () => {
  const rows = [matchA(), matchB(), matchC(), matchQuiet()];
  const samples = [];
  for (const row of rows) {
    const depth = rocoMatchDepth({events: row.events, game: row.game ?? null, turns: row.turns});
    samples.push(...collectStrings(depth));
    assertFactsRecomputable(depth, row.events);
  }
  // 反向对照：这一层真会碰到「百分数字段」（`defense.reduction = 0.7`），
  // 但输出的每一条都不带 `%`——引擎战报里那句「减伤约 70%」是引擎的话，这里不复述。
  assert.ok(matchA().events.some((event) => event.kind === 'defense' && event.detail.reduction === 0.7),
    '夹具里必须有减伤事件，否则这条反证是空的');
  assert.ok(samples.length > 15, `扫描的样本太少（${samples.length} 条），这条判据没有意义`);
  for (const line of samples) assertNoForbidden(line, '复盘加厚层');
});

// ── 装配层：页面看到的那一份 ────────────────────────────────────────────────

test('装配层：深一层并入「依据」与正文，老师原有的结论一个字都不改', () => {
  const {events, turns, view, game} = matchA();
  const merged = rocoMatchReview({
    matchId: 'm-depth-A', finalView: view, lastLiveView: view,
    events, turns, result: 'loss', memory: freshMemory(),
  });
  assert.ok(merged.review, '这一局有减员，老师那一角应当讲得出话');
  assert.ok(merged.depth.facts.length >= 5);

  // 老师的结论必须与**直接**调用 `reviewMatch` 得到的一样（加厚不许改口径）
  const direct = reviewMatch({events, turns, result: 'loss', game, memory: freshMemory()});
  for (const key of ['goal', 'learning', 'text', 'turning_point', 'check', 'mistake_available', 'teaching_a_mistake', 'candidates']) {
    if (key === 'text') continue;   // 正文**故意**多了一句补充，见下面单独断言
    assert.deepEqual(merged.review[key], direct[key], `加厚之后老师的 ${key} 变了`);
  }
  assert.ok(merged.review.text.startsWith(direct.text), '正文只能在原来的句子后面接，不许改写');
  assert.equal(merged.review.text, `${direct.text}${merged.depth.summary}`);
  assert.ok(merged.review.text.includes('全场最重的一次伤害'), merged.review.text);

  // 「依据」= 老师原来的依据 + 深一层的每一条（页面 `#lesson-note` 渲染的就是它）
  for (const line of merged.depth.evidence) {
    assert.ok(merged.review.evidence.includes(line), `深一层的这条没有进依据：${line}`);
  }
  for (const line of direct.evidence) {
    assert.ok(merged.review.evidence.includes(line), `老师原来的依据被挤掉了：${line}`);
  }
  assert.deepEqual(merged.review.depth, merged.depth);
  for (const line of collectStrings(merged.depth)) assertNoForbidden(line, '装配后的复盘');
});

// ── 真服务：真引擎的一局，用真事件再核一遍 ──────────────────────────────────

function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

const PYTHON = probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

async function startServer() {
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootRes = await fetch(`${base}/api/bootstrap`);
  const boot = await bootRes.json();
  const cookie = bootRes.headers.get('set-cookie') || '';
  const post = (path, data) => fetch(base + path, {
    method: 'POST',
    headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data),
  }).then((r) => r.json());
  return {post, close: () => { server.closeAllConnections?.(); server.close(); }};
}

test('真引擎：一局真对局里每条加厚事实都能被同一份事件核对', {skip: SKIP}, async () => {
  const {post, close} = await startServer();
  try {
    for (const seed of [11, 5]) {
      const started = await post('/api/roco/battle/new', {seed, strategy: 'greedy_damage'});
      let view = started.view;
      let events = Array.isArray(view?.events) ? [...view.events] : [];
      let lastLiveView = null;
      for (let i = 0; i < 200 && !view?.battle_result; i += 1) {
        if (Array.isArray(view?.legal) && view.legal.length) lastLiveView = view;
        const advanced = await post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
        if (advanced.ok !== true) break;
        view = advanced.view;
        if (Array.isArray(view?.events)) events = [...events, ...view.events];
      }
      assert.ok(view?.battle_result, `seed ${seed} 没打完`);

      const {depth, review} = rocoMatchReview({
        matchId: started.battle_id, finalView: view, lastLiveView,
        events, turns: view.turn, result: view.battle_result, memory: freshMemory(),
      });
      assert.equal(depth.covers_whole_match, true, `seed ${seed}：整局事件应当被判成「看得到整局」`);
      assert.ok(depth.facts.length >= 3, `seed ${seed}：真对局里至少该有 3 条事实，实际 ${depth.facts.length}`);
      // 判据本身跑在**真事件**上：重算不一致就在这里红
      assert.equal(depth.counts.turns_total, view.turn, '回合总数必须来自这一局');
      assertFactsRecomputable(depth, events);
      for (const line of collectStrings(depth)) assertNoForbidden(line, `seed ${seed} 的真对局复盘`);
      if (review) {
        for (const line of depth.evidence) assert.ok(review.evidence.includes(line), `seed ${seed}：依据里少了 ${line}`);
      }
      // 真对局里必须至少有一条「带回合号的资源账」，否则这一层在真链路上等于没接上
      assert.ok(depth.evidence.some((line) => /^资源：/.test(line) && /第 \d+ 回合/.test(line)),
        `seed ${seed}：资源账没落到真事件上：${depth.evidence.join(' | ')}`);
    }
  } finally {
    close();
  }
});
