// 老师（teacher）局末复盘的评测。
//
// 全部对局都用**真实事件形状**构造，不发明字段：
//   · 事件 kind 与各自的 detail 字段来自 `roco/src/roco_env/events_text.py`（它逐个 kind
//     都写了句子）与 `roco/src/roco_env/env.py` 里 `_bump(...)` 的实际调用；
//   · 信封形状 `{kind, turn, detail, evidence, text}` 来自 `roco/src/roco_env/service.py`
//     的 `_sim_envelope`：`dict(e.to_dict(), text=events_text.event_text(...))`，
//     其中 `Event.to_dict()` 就是 `{kind, turn, detail, evidence}`；
//   · 局面视图来自 `rocoGameView`（`src/coach/roco-experience.js`），合法动作的字段形状
//     与 `env.py` 的 `ui_action_public` / `ui_legal_actions` 一致。
//
// 这一组用例要钉住的不是「文案好不好听」，而是老师这个角色的两条底线：
//   ① 复盘必须由**真的发生过的事件**决定：两局不同的对局不许得到同一句话；
//   ② **没有再次出现**同一局面时不许说「有改善」——没出现什么也证明不了。

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {rocoGameView, rocoLessonEntry} from '../../src/coach/roco-experience.js';
import {freshMemory} from '../../src/coach/memory.js';
import {
  TEACHER_GOALS,
  checkLearningProgress,
  recordLearningCheck,
  recordTeacherReview,
  reviewMatch,
} from '../../src/coach/teacher-review.js';

// ── 造事件：一个真实信封一条 ────────────────────────────────────────────────
const ev = (turn, kind, detail, text, evidence = []) => ({turn, kind, detail, evidence, text});

// ── 局面视图：字段名与 `ui_public_view` 一致 ────────────────────────────────
const viewOf = (over = {}) => ({
  battle_result: null,
  phase: 'battle',
  turn: 1,
  ruleset_id: 'roco-world-s4-2026-09-10',
  state_version: 11,
  self: {active: 0, pets: []},
  opponent: {active: 0, living_count: 1, field: null, bench: []},
  legal: [],
  ...over,
});

/**
 * 对局 A：我方首发在第 4 回合被属性克制的一击打倒，背包里还有回复药、整局没用过。
 * 事件全部取自引擎真实的 kind 与字段（`damage` 带 `target_slot`/`type_multiplier`，
 * `faint` 带 `side`/`slot`，`replacement` 带 `slot`）。
 */
function matchA() {
  const view = viewOf({
    battle_result: 'loss', phase: 'ended', turn: 4, state_version: 88,
    self: {
      active: 1,
      pets: [
        {slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 2, fainted: true},
        {slot: 1, pet_id: 'pet_000190', name: '海豹船长', hp: 300, max_hp: 374, energy: 3, fainted: false},
      ],
    },
    opponent: {
      active: 0, living_count: 2,
      field: {slot: 0, pet_id: 'pet_000445', name: '画间沉铁兽', hp: 210, max_hp: 380, energy: 2, fainted: false},
      bench: [{slot: 1, pet_id: 'pet_000311', fainted: false}],
    },
    // 背包里还有回复药：公开视图里它还算合法动作（rocoGameView 的 items 就是从这里数的）。
    legal: [
      {kind: 'skill', label: '龙血', skill_id: 'skill_000750'},
      {kind: 'item', item_id: '回复药', label: '使用回复药'},
    ],
  });
  const events = [
    ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 38, type_multiplier: 1, formula_verified: false},
      '我方的龙血命中，造成约 38 点伤害（伤害公式未核验，这是引擎估值）。', ['skill_000750']),
    ev(1, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 44, type_multiplier: 1, formula_verified: false},
      '对方的潮涌命中，造成约 44 点伤害（伤害公式未核验，这是引擎估值）。', ['skill_000310']),
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 96, type_multiplier: 2, formula_verified: false},
      '对方的潮涌命中，造成约 96 点伤害（伤害公式未核验，这是引擎估值），属性克制。', ['skill_000310']),
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 41, type_multiplier: 1, formula_verified: false},
      '我方的龙血命中，造成约 41 点伤害（伤害公式未核验，这是引擎估值）。', ['skill_000750']),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 64, type_multiplier: 1, formula_verified: false},
      '对方的潮涌命中，造成约 64 点伤害（伤害公式未核验，这是引擎估值）。', ['skill_000310']),
    ev(4, 'turn_start', {turn: 4}, '第 4 回合开始。'),
    ev(4, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 2, formula_verified: false},
      '对方的裂空命中，造成约 210 点伤害（伤害公式未核验，这是引擎估值），属性克制。', ['skill_000311']),
    ev(4, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
    ev(4, 'replacement', {side: 'player', slot: 1}, '我方补上了第 2 位精灵。'),
    ev(4, 'game_end', {result: 'loss'}, '对局结束：我方落败。'),
  ];
  return {events, turns: 4, result: 'loss', game: rocoGameView(view, {matchId: 'm-A'})};
}

/**
 * 对局 B：对面第 5 回合倒下、第 6 回合我方补位后第一手打在属性抵抗上。
 * 与 A 是**完全不同的两局**：目标、回合、方向都不一样。
 */
function matchB() {
  const view = viewOf({
    battle_result: 'win', phase: 'ended', turn: 6, state_version: 120,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 180, max_hp: 425, energy: 3, fainted: false}]},
    opponent: {
      active: 1, living_count: 1,
      field: {slot: 1, pet_id: 'pet_000311', name: '潮甲龟', hp: 150, max_hp: 400, energy: 2, fainted: false},
      bench: [],
    },
    legal: [{kind: 'skill', label: '龙血', skill_id: 'skill_000750'}],
  });
  const events = [
    ev(5, 'turn_start', {turn: 5}, '第 5 回合开始。'),
    ev(5, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 205, type_multiplier: 2, formula_verified: false},
      '我方的龙血命中，造成约 205 点伤害，属性克制。', ['skill_000750']),
    ev(5, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。', ['3009']),
    ev(5, 'replacement', {side: 'enemy', slot: 1}, '对方补上了第 2 位精灵。'),
    ev(6, 'turn_start', {turn: 6}, '第 6 回合开始。'),
    ev(6, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 1, damage: 12, type_multiplier: 0.5, formula_verified: false},
      '我方的龙血命中，造成约 12 点伤害，属性抗性。', ['skill_000750']),
    ev(6, 'game_end', {result: 'win'}, '对局结束：我方获胜。'),
  ];
  return {events, turns: 6, result: 'win', game: rocoGameView(view, {matchId: 'm-B'})};
}

/**
 * 对局 F：没有人倒下，但累计伤害差在第 2 回合翻盘，而且有两回合连着打在抵抗上。
 * 它专门用来走「减员之外」的那条转折点规则（`damage-lead-flip`）。
 */
function matchF() {
  const events = [
    ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 120, type_multiplier: 1, formula_verified: false}, '我方的龙血命中，造成约 120 点伤害。', ['skill_000750']),
    ev(1, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 30, type_multiplier: 1, formula_verified: false}, '对方的潮涌命中，造成约 30 点伤害。', ['skill_000310']),
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 8, type_multiplier: 0.5, formula_verified: false}, '我方的龙血命中，造成约 8 点伤害，属性抗性。', ['skill_000750']),
    ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 140, type_multiplier: 1, formula_verified: false}, '对方的潮涌命中，造成约 140 点伤害。', ['skill_000310']),
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 9, type_multiplier: 0.5, formula_verified: false}, '我方的龙血命中，造成约 9 点伤害，属性抗性。', ['skill_000750']),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 20, type_multiplier: 1, formula_verified: false}, '对方的潮涌命中，造成约 20 点伤害。', ['skill_000310']),
  ];
  return {events, turns: 3, result: 'loss', game: null};
}

/**
 * 对局 P：这一局**同时**有两门课够得上，而且优先级与可教性相反。
 *
 *   · `use-item-before-danger-line`（优先级最高）：第 4 回合先吃了药、第 5 回合才倒下
 *     → 处理方式 `healed-before-faint`，也就是**做对了**（正文是「先后顺序是对的」）；
 *   · `switch-out-of-the-bad-matchup`（优先级第二）：第 3 回合吃到属性克制的一击之后
 *     一直没换人 → `stayed-in-after-bad-hit`，这是**真的做错了**。
 *
 * 第 45 轮之前的选法是「按优先级取第一门够得上的」，于是这一局会把唯一的学习点花在
 * 一句表扬上。实测（30 个固定种子）这种「讲做对了的那门」占 **13/30**。修好之后
 * 必须先讲要改的那一处——这条用例就是那件事的最小反证。
 */
function matchPraise() {
  const view = viewOf({
    battle_result: 'loss', phase: 'ended', turn: 5, state_version: 99,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 1, fainted: true}]},
    opponent: {active: 0, living_count: 1, field: {slot: 0, pet_id: 'pet_000445', name: '画间沉铁兽', hp: 260, max_hp: 380, energy: 2, fainted: false}, bench: []},
    legal: [{kind: 'item', item_id: '回复药', label: '使用回复药'}],
  });
  const events = [
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 180, type_multiplier: 2, formula_verified: false},
      '对方的裂空命中，造成约 180 点伤害，属性克制。', ['skill_000311']),
    ev(4, 'turn_start', {turn: 4}, '第 4 回合开始。'),
    ev(4, 'item', {side: 'player', item: '回复药', healed: 45}, '我方使用了道具，回复 45 点生命。'),
    ev(5, 'turn_start', {turn: 5}, '第 5 回合开始。'),
    ev(5, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 1, formula_verified: false},
      '对方的裂空命中，造成约 210 点伤害。', ['skill_000311']),
    ev(5, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
  ];
  return {events, turns: 5, result: 'loss', game: rocoGameView(view, {matchId: 'm-P'})};
}

/**
 * 对局 Q：一门失误都没有的一局（用来验 `teaching_a_mistake === false` 不是嘴上说说）。
 *
 * 对面倒下、补位之后我方**下一手没有被抵抗**（`next-hit-not-resisted`，属于做对了），
 * 我方没有倒人、没有被抵抗的出手、没有异常扣血——于是「要改的那一处」根本不存在，
 * 老师讲的只能是这一局做得对的地方。
 */
function matchClean() {
  const view = viewOf({
    battle_result: 'win', phase: 'ended', turn: 6, state_version: 121,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 300, max_hp: 425, energy: 3, fainted: false}]},
    opponent: {active: 1, living_count: 1, field: {slot: 1, pet_id: 'pet_000311', name: '潮甲龟', hp: 90, max_hp: 400, energy: 2, fainted: false}, bench: []},
    legal: [{kind: 'skill', label: '龙血', skill_id: 'skill_000750'}],
  });
  const events = [
    ev(5, 'turn_start', {turn: 5}, '第 5 回合开始。'),
    ev(5, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 205, type_multiplier: 2, formula_verified: false},
      '我方的龙血命中，造成约 205 点伤害，属性克制。', ['skill_000750']),
    ev(5, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。', ['3009']),
    ev(5, 'replacement', {side: 'enemy', slot: 1}, '对方补上了第 2 位精灵。'),
    ev(6, 'turn_start', {turn: 6}, '第 6 回合开始。'),
    ev(6, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 1, damage: 190, type_multiplier: 2, formula_verified: false},
      '我方的龙血命中，造成约 190 点伤害，属性克制。', ['skill_000750']),
  ];
  return {events, turns: 6, result: 'win', game: rocoGameView(view, {matchId: 'm-Q'})};
}

/**
 * 对局 S：**转折点与这门课的局面不是同一回合**（第 45 轮浏览器实测抓到的那一处）。
 *
 * 对面第 3 回合先倒一只（于是 `first-faint` 挑的是第 3 回合），我方第 7 回合才倒下，
 * 而这门课（用药时机）讲的是**我方**第 7 回合那一幕。
 * 挂账时如果存转折点回合，下一局的核对就会写成「对比第 3 回合（上一次…）与第 9 回合
 * （这一次…）」——两个数字量的不是同一件事，读起来却像同一次对比。
 */
function matchSplit({playerFaintTurn = 7, enemyFaintTurn = 3} = {}) {
  const view = viewOf({
    battle_result: 'loss', phase: 'ended', turn: playerFaintTurn, state_version: 70,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 1, fainted: true}]},
    opponent: {active: 1, living_count: 1, field: {slot: 1, pet_id: 'pet_000311', name: '潮甲龟', hp: 150, max_hp: 400, energy: 2, fainted: false}, bench: []},
    legal: [{kind: 'item', item_id: '回复药', label: '使用回复药'}],
  });
  const events = [
    ev(enemyFaintTurn, 'turn_start', {turn: enemyFaintTurn}, `第 ${enemyFaintTurn} 回合开始。`),
    ev(enemyFaintTurn, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 400, type_multiplier: 2, formula_verified: false},
      '我方的龙血命中，造成约 400 点伤害，属性克制。', ['skill_000750']),
    ev(enemyFaintTurn, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。', ['3009']),
    ev(enemyFaintTurn, 'replacement', {side: 'enemy', slot: 1}, '对方补上了第 2 位精灵。'),
    ev(playerFaintTurn, 'turn_start', {turn: playerFaintTurn}, `第 ${playerFaintTurn} 回合开始。`),
    ev(playerFaintTurn, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 1, formula_verified: false},
      '对方的裂空命中，造成约 210 点伤害。', ['skill_000311']),
    ev(playerFaintTurn, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
  ];
  return {events, turns: playerFaintTurn, result: 'loss', game: rocoGameView(view, {matchId: 'm-S'})};
}

/** 只有一条伤害、没有减员也没有翻盘的一局：老师说不出话，应当沉默。 */
function matchQuiet() {
  return {
    events: [
      ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。'),
      ev(1, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 20, type_multiplier: 1, formula_verified: false}, '我方的龙血命中，造成约 20 点伤害。'),
    ],
    turns: 1, result: 'loss', game: null,
  };
}

/** 后面对局 C：第 6 回合先吃了回复药，第 7 回合才倒下——同一类局面，处理方式变了。 */
function matchC() {
  const view = viewOf({
    battle_result: 'loss', phase: 'ended', turn: 7, state_version: 150,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 2, fainted: true}]},
    opponent: {active: 0, living_count: 1, field: {slot: 0, pet_id: 'pet_000445', name: '画间沉铁兽', hp: 120, max_hp: 380, energy: 2, fainted: false}, bench: []},
  });
  const events = [
    ev(6, 'turn_start', {turn: 6}, '第 6 回合开始。'),
    ev(6, 'item', {side: 'player', item: '回复药', healed: 45}, '我方使用了道具，回复 45 点生命。'),
    ev(7, 'turn_start', {turn: 7}, '第 7 回合开始。'),
    ev(7, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 120, type_multiplier: 1, formula_verified: false}, '对方的裂空命中，造成约 120 点伤害。', ['skill_000311']),
    ev(7, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
  ];
  return {events, game: rocoGameView(view, {matchId: 'm-C'}), bag: {'回复药': 1}};
}

/** 后面对局 D：同一类局面重复，处理方式**一模一样**（背包里还有药，还是没用）。 */
function matchD() {
  return {
    events: [
      ev(5, 'turn_start', {turn: 5}, '第 5 回合开始。'),
      ev(5, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
    ],
    game: null,
    bag: {'回复药': 1},
  };
}

/** 后面对局 E：这一局没有任何我方伙伴倒下——不是「做到了」，是什么都没发生。 */
function matchE() {
  return {
    events: [
      ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
      ev(3, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。', ['3009']),
    ],
    game: null,
  };
}

// ── 反模板判据：先把数字与名字抹平，再看两句话是不是同一句 ────────────────────
//
// 「同一句话换了个名字」必须被判成同一句，否则「两局不同 → 文案不同」这条用例
// 只要名字不同就永远绿，等于没测。名字在正文里是**不带引号**出现的，
// 所以除了抹掉数字与「」里的内容，还要把已知的精灵/技能名换成占位符。
const KNOWN_NAMES = ['寂灭骨龙', '海豹船长', '画间沉铁兽', '潮甲龟', '龙血', '裂空', '潮涌', '回复药'];

function shapeOf(text) {
  let out = String(text ?? '').replace(/[0-9]+(\.[0-9]+)?/g, 'N').replace(/「[^」]*」/g, '「X」');
  for (const name of KNOWN_NAMES) out = out.split(name).join('P');
  return out;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

const FORBIDDEN = /\{|\}|胜率|最优|一定能赢|概率|state_version|margin|score|coverage/;

// ── 用例 ────────────────────────────────────────────────────────────────────

test('复盘由事件决定：我方倒下时要点名那一回合与那一只', () => {
  const review = reviewMatch(matchA());
  assert.ok(review, '这一局有第一次减员，不该沉默');
  assert.equal(review.turning_point.turn, 4, '转折点必须是倒下发生的第 4 回合');
  assert.equal(review.turning_point.rule, 'first-faint', '要说清是哪条规则挑的这一回合');
  // 名字来自公开视图（事件里只有 slot），必须在正文与依据里都出现
  assert.match(review.text, /第 4 回合/);
  assert.match(review.text, /寂灭骨龙/);
  assert.ok(review.evidence.some((line) => line.includes('寂灭骨龙') && line.includes('第 4 回合')),
    `依据里要有点名的事实，实际：${JSON.stringify(review.evidence)}`);
  // 学习点必须能照做，并且带机器可读的标签
  assert.ok(TEACHER_GOALS.includes(review.goal));
  assert.equal(review.goal, 'use-item-before-danger-line');
  assert.match(review.learning, /回复药/);
  assert.equal(review.check.situation, 'our-pet-fainted');
  assert.equal(review.check.handling, 'no-heal-before-faint');
  // 「是什么把它打下去的」也要有依据，而且**只**说公开数据里真的有的东西：
  // 这一击来自对方的 skill_000311，而对手的技能名在公开视图里没有，所以这里不许写技能名。
  const fatal = review.evidence.find((line) => line.includes('约 210 点伤害'));
  assert.ok(fatal, `倒下那一击应当有依据：${JSON.stringify(review.evidence)}`);
  assert.match(fatal, /第 4 回合 我方 寂灭骨龙 是在一次约 210 点伤害之后倒下的。/);
  assert.ok(!review.evidence.some((line) => line.includes('裂空')), '对手的技能名公开视图里没有，不许编');
});

test('没有值得一提的事件就沉默：返回 null，不编号一个「关键回合」', () => {
  assert.equal(reviewMatch({events: [], turns: 5, result: 'loss', game: null}), null, '空事件流必须沉默');
  assert.equal(reviewMatch(matchQuiet()), null, '只有一条伤害、没有减员也没有翻盘时必须沉默');
  assert.equal(reviewMatch({events: [ev(1, 'turn_start', {turn: 1}, '第 1 回合开始。')], turns: 1, result: 'draw', game: null}), null);
});

test('转折点可以不是减员：没有减员时按累计伤害差翻盘挑', () => {
  const review = reviewMatch(matchF());
  assert.ok(review, '有翻盘也有连着打在抵抗上，不该沉默');
  assert.equal(review.turning_point.rule, 'damage-lead-flip');
  assert.equal(review.turning_point.turn, 2, '第 1 回合领先、第 2 回合翻到对面一侧');
  assert.deepEqual(review.turning_point.candidates, ['damage-lead-flip']);
  assert.equal(review.goal, 'stop-attacking-into-resistance');
  assert.equal(review.check.handling, 'repeated-resist');
});

test('同一局里有「做对的课」也有「做错的课」时，先讲要改的那一处（第 45 轮反模板）', () => {
  const review = reviewMatch(matchPraise());
  assert.ok(review);
  // 两门课都够得上：可核对的两个记号都要如实写出来
  assert.deepEqual(review.candidates, ['use-item-before-danger-line', 'switch-out-of-the-bad-matchup']);
  assert.equal(review.mistake_available, true, '这一局确实有做错的地方');
  assert.equal(review.teaching_a_mistake, true, '讲的那门必须是「要改的」');
  // 优先级更高的那门（用药时机）这一局其实做对了；做错的是「吃到克制伤害不换人」
  assert.equal(review.goal, 'switch-out-of-the-bad-matchup',
    '按优先级取第一门会把学习点花在表扬上——那正是修掉的行为');
  assert.equal(review.check.handling, 'stayed-in-after-bad-hit');
  assert.match(review.learning, /换掉这一只/);
  // 反向对照：只有「做对了」那一门够得上时，仍然讲它（不能因为没有失误就不讲）
  const onlyGood = reviewMatch(matchA());
  assert.equal(onlyGood.mistake_available, true, 'A 那一局是「有药没用」，属于失误');
  assert.equal(onlyGood.goal, 'use-item-before-danger-line');
  // B 那一局：补位之后第一手打在抵抗上 → 也是失误（不是「因为是对面倒人就讲它」）
  const b = reviewMatch(matchB());
  assert.equal(b.goal, 'read-the-replacement-first');
  assert.equal(b.mistake_available, true);
  assert.equal(b.teaching_a_mistake, true);
  assert.equal(b.check.handling, 'next-hit-into-resist');
  // 一局里一门失误都没有时：`mistake_available` / `teaching_a_mistake` 都必须是 false，
  // 不是「讲了失误」也不是「假装有失误」——这一局讲的是做对了的地方。
  const clean = reviewMatch(matchClean());
  assert.ok(clean);
  assert.equal(clean.goal, 'read-the-replacement-first');
  assert.equal(clean.check.handling, 'next-hit-not-resisted');
  assert.equal(clean.mistake_available, false, '这一局没有任何做错的地方');
  assert.equal(clean.teaching_a_mistake, false);
});

test('两局不同的对局 → 不同的复盘与不同的学习点（反模板）', () => {
  const a = reviewMatch(matchA());
  const b = reviewMatch(matchB());
  assert.ok(a && b);
  assert.notEqual(a.goal, b.goal, '两局的课不该是同一门');
  assert.notEqual(a.learning, b.learning, '学习点必须不同');
  assert.notEqual(shapeOf(a.text), shapeOf(b.text), '抹平数字与名字之后，两句话仍必须是两句不同的话');
  // 己方技能名公开视图里是有的（`ui_public_view` 的 `self.skills` / 合法动作的 label），
  // 所以 B 那一句要说得出「龙血」，不是只留一个 skill_000750。
  assert.ok(b.evidence.some((line) => line.includes('龙血')), `己方技能名应当用上：${JSON.stringify(b.evidence)}`);
});

test('在后续局验证：没有讲过的课就什么都不说', () => {
  const result = checkLearningProgress({memory: freshMemory(), match: matchC()});
  assert.equal(result.checked, false);
  assert.equal(result.goal, null);
  assert.equal(result.recurred, false);
  assert.equal(result.improved, null);
  assert.match(result.note, /还没有记录过学习点/);
});

test('在后续局验证：局面没再出现 → improved 为 null，并明说没出现证明不了什么', () => {
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: reviewMatch(matchA())});
  const result = checkLearningProgress({memory, match: matchE()});
  assert.equal(result.checked, true);
  assert.equal(result.goal, 'use-item-before-danger-line');
  assert.equal(result.recurred, false);
  assert.equal(result.improved, null, '没出现既不是做到了也不是没做到，不许给结论');
  assert.match(result.note, /证明不了/, `note 必须明说没出现证明不了什么：${result.note}`);
  assert.match(result.note, /没有再出现/);
  assert.ok(!result.evidence.some((line) => line.includes('这一次是往好的方向变')));
});

test('挂账的回合必须是「这门课的局面」那一回合，不是转折点那一回合（第 45 轮实测抓到）', () => {
  const review = reviewMatch(matchSplit({playerFaintTurn: 7, enemyFaintTurn: 3}));
  assert.ok(review);
  assert.equal(review.turning_point.turn, 3, '转折点是对方第一次减员');
  assert.equal(review.check.turn, 7, '这门课的局面是我方第 7 回合倒下');
  assert.notEqual(review.turning_point.turn, review.check.turn, '这个夹具的意义就在于两个回合不同');

  const row = recordTeacherReview(freshMemory(), {matchId: 'm-S1', review})
    .journal.filter((e) => e.kind === 'teach').at(-1);
  assert.equal(row.turn, 7, '挂账要比对的是局面的回合');
  assert.equal(row.pointTurn, 3, '转折点回合另存，别丢');
  assert.equal(row.situation, 'our-pet-fainted');
  assert.equal(row.handling, 'no-heal-before-faint');

  // 下一局同一局面又出现（这次在第 9 回合）：核对句里的两个数字必须都是**局面**回合。
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-S1', review});
  const progress = checkLearningProgress({memory, match: matchSplit({playerFaintTurn: 9, enemyFaintTurn: 4})});
  assert.equal(progress.checked, true);
  assert.equal(progress.recurred, true);
  assert.equal(progress.improved, false, `两次处理方式一样：${progress.note}`);
  assert.match(progress.note, /第 7 回合（上一次/, `上一次要说局面那一回合：${progress.note}`);
  assert.match(progress.note, /第 9 回合（这一次/, `这一次要说局面那一回合：${progress.note}`);
  assert.ok(!/第 3 回合（上一次/.test(progress.note),
    `不许拿转折点回合当「上一次」：${progress.note}`);
});

test('在后续局验证：局面重复、处理方式一样 → improved 为 false', () => {
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: reviewMatch(matchA())});
  const result = checkLearningProgress({memory, match: matchD()});
  assert.equal(result.recurred, true);
  assert.equal(result.improved, false, '同一类局面、同一种处理，只能说看不到变化');
  assert.match(result.note, /这一局看不到变化/);
});

test('在后续局验证：局面重复、处理方式变了 → improved 为 true，且依据点名两个回合', () => {
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: reviewMatch(matchA())});
  const result = checkLearningProgress({memory, match: matchC()});
  assert.equal(result.recurred, true);
  assert.equal(result.improved, true);
  assert.deepEqual(result.turns, [4, 7], '两次比较的回合必须能被核对');
  assert.ok(result.evidence.some((line) => line.includes('第 4 回合') && line.includes('第 7 回合')),
    `依据里必须同时出现两次的回合：${JSON.stringify(result.evidence)}`);
  assert.match(result.note, /第 4 回合/);
  assert.match(result.note, /第 7 回合/);
  // 一次变化不是结论：这句话必须在 note 里说出来，不许让玩家以为以后都这样
  assert.match(result.note, /不代表以后都会/);
});

test('在后续局验证：局面重复但这一课的前提不在 → 也不给改善结论', () => {
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: reviewMatch(matchA())});
  // 这一次背包里没有药、也没有用过药：局面重复了，但没法比较「有没有先吃药」。
  const result = checkLearningProgress({memory, match: {events: matchD().events, game: null}});
  assert.equal(result.recurred, true);
  assert.equal(result.improved, null);
  assert.match(result.note, /前提不在/);
});

test('禁止词汇：复盘与核对产出的每一句都不许出现承诺或工程术语', () => {
  const a = reviewMatch(matchA());
  const b = reviewMatch(matchB());
  const f = reviewMatch(matchF());
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: a});
  const checks = [
    checkLearningProgress({memory: freshMemory(), match: matchC()}),
    checkLearningProgress({memory, match: matchE()}),
    checkLearningProgress({memory, match: matchD()}),
    checkLearningProgress({memory, match: matchC()}),
  ];
  const strings = collectStrings([a, b, f, checks]);
  assert.ok(strings.length > 20, '扫描的样本太少，这条用例没有意义');
  for (const line of strings) {
    assert.ok(!FORBIDDEN.test(line), `出现了禁用词汇：${line}`);
  }
  assert.equal(TEACHER_GOALS.length, Object.freeze(TEACHER_GOALS).length);
});

test('反向对照 ①：固定问句换汤不换药，反模板判据抓得住', () => {
  // 旧入口 rocoLessonEntry 返回的是**固定问句**，与这一局发生过什么无关。
  // 这正是要修掉的东西：两局完全不同的对局，它给出同一句话。
  const entryA = rocoLessonEntry({events: matchA().events, turns: 4});
  const entryB = rocoLessonEntry({events: matchB().events, turns: 6});
  assert.ok(entryA && entryB);
  assert.equal(shapeOf(entryA.question), shapeOf(entryB.question),
    '固定问句在两局里是同一句——反模板判据必须能抓出来（这就是它有牙的证明）');
  // 我们的复盘在同一组判据下必须**不相等**，否则上面那条「两局不同」的用例是假的。
  assert.notEqual(shapeOf(reviewMatch(matchA()).text), shapeOf(reviewMatch(matchB()).text));
});

test('反向对照 ②：没有重复出现就宣称「有改善」是抓得住的假结论', () => {
  const memory = recordTeacherReview(freshMemory(), {matchId: 'm-A', review: reviewMatch(matchA())});
  const result = checkLearningProgress({memory, match: matchE()});
  // 天真实现：账本里讲过这一课，就说「学会了」。
  const naiveImproved = (m) => (m.journal ?? []).some((row) => row.kind === 'teach');
  assert.equal(naiveImproved(memory), true, '天真实现在这里必然会宣称改善');
  assert.equal(result.improved, null, '真实实现必须拒绝这个没有证据的结论');
  assert.notEqual(naiveImproved(memory), result.improved === true);
  // 并且这一条「没法判断」不许被记成一次不合理行动（否则会把「什么都没发生」算成失误）
  const after = recordLearningCheck(memory, {matchId: 'm-E', check: result});
  assert.equal(after, memory, 'improved 为 null 时不该写账');
});

test('反向对照 ③：没有转折点就编一个「关键回合」是抓得住的', () => {
  const quiet = matchQuiet();
  assert.equal(reviewMatch(quiet), null);
  // 天真实现：总要说点什么，于是永远报第 1 回合。
  const naiveTurningPoint = (match) => ({turn: 1, what: `${match.turns} 个回合里第 1 回合最关键`});
  assert.ok(naiveTurningPoint(quiet), '天真实现会为这一局编出一个转折点');
  assert.equal(reviewMatch(quiet), null, '真实实现在没有转折点时返回 null');
});

test('对手倒下那一只：拿不到名字时只写位次，绝不拿场上那一只顶替（含只给投影的入参）', () => {
  // ── 这条用例的来历：一次 `git add -A` 误收 ────────────────────────────────
  //
  // 提交 `ff81037` 里那份 `teacher-review.js` 是子 agent **写到一半**的版本（819 行），
  // 它的 `petInfoAt` 对对手多了一条兜底：`slot === 0` 时退回**投影数组的第 0 位**，
  // 也就是「现在场上那一只」。用同一批事件实测（只给投影、没有原始 `roco` 视图的 game）：
  //
  //   ff81037  → 「第 2 回合 对方 潮甲龟 倒下，这是全场第一次减员」   ← 把场上那只安到倒下那只头上
  //   当前版本 → 「第 2 回合 对方第 1 位 倒下，这是全场第一次减员」   ← 名字拿不到就只写位次
  //
  // 后续提交把那一段兜底删掉了，行为变成正确的——但那正是「靠后续覆盖掩盖」的形状：
  // 误收的那一份**真的会说错话**，而且没有任何测试会红。这条用例把它钉死。
  const game = {
    id: 'projected-only', version: 'v', result: 'loss', turn: 5,
    player: {active: 0, items: {回复药: 1},
      pets: [{slot: 0, id: 'pet_000225', name: '寂灭骨龙', hp: 0, maxHp: 425, energy: 1, fainted: true}]},
    // 对手只有**投影**：场上那一只叫潮甲龟，后备没有信息
    enemy: {active: 0, pets: [{id: 'pet_000311', name: '潮甲龟', hp: 200, maxHp: 400, energy: 2, fainted: false}]},
  };
  const events = [
    ev(2, 'turn_start', {turn: 2}, '第 2 回合开始。'),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 400,
      type_multiplier: 2, formula_verified: false}, '我方的龙血命中，造成约 400 点伤害，属性克制。', ['skill_000750']),
    ev(2, 'faint', {side: 'enemy', slot: 0}, '对方的精灵倒下了。', ['3009']),
    ev(3, 'turn_start', {turn: 3}, '第 3 回合开始。'),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210,
      type_multiplier: 1, formula_verified: false}, '对方的裂空命中，造成约 210 点伤害。', ['skill_000311']),
    ev(3, 'faint', {side: 'player', slot: 0}, '我方的精灵倒下了。', ['3009']),
  ];
  const review = reviewMatch({events, turns: 5, result: 'loss', game});
  assert.ok(review);
  assert.equal(review.turning_point.what, '第 2 回合 对方第 1 位 倒下，这是全场第一次减员',
    '对手倒下的那一只拿不到名字时，只能写位次');
  assert.ok(!/潮甲龟/.test(review.text), `不许把场上那一只的名字安到倒下那一只头上：${review.text}`);
  assert.ok(!review.evidence.some((line) => /潮甲龟/.test(line)), JSON.stringify(review.evidence));
  // 反向对照：**真的**知道是谁倒下时，仍然要点名（别为了这条把名字一刀切掉）
  const named = reviewMatch({...matchSplit({playerFaintTurn: 7, enemyFaintTurn: 3}), result: 'loss'});
  assert.match(named.turning_point.what, /对方第 1 位|潮甲龟/);
});
