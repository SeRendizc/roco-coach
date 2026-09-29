// U10 复盘口径的五条判据（2026-09-29 产品口径，用户 12 张截图那一轮）。
//
// ── 这一份判据要钉住的不是「文案好不好听」──────────────────────────────────
//
// 产品口径原文（U10）：复盘要讲「**具体回合 + 当时事实 + 合法替代 + 理由**」；
// **不得复读同一句**；**不得拿单次伤害写绝对结论**；**胜/负/逃跑/异常结束分开处理**；
// **正常开下一局要清掉旧局建议**。五条各对应下面的一组用例，每条都带**必红反证**
// （撤掉输入 → 结论必须跟着消失），否则判据只是「文案里恰好有那几个字」。
//
// ── 为什么这一份单独一个文件 ────────────────────────────────────────────────
//
// `tests/evals/teacher-review.test.js` 钉的是老师这一角的**判定逻辑**（挑哪一课、挂哪个回合），
// `tests/roco-match-review-depth.test.js` 钉的是加厚那一层。U10 这五条改的是**同一条主路径上的
// 另一组契约**（合法替代的诚实边界、复读防线、结果四类、单次伤害免责、跨局清理），
// 放在一起才看得出它们互相约束：例如「复读防线」不许把复盘变成空白，
// 而「合法替代」拿不到表时必须闭嘴——两条合起来才是「宁可少说，不许编」。
//
// 事件形状与字段逐个对过引擎源码，不发明字段：
//   · `damage` → `{side, skill_id, target_slot, damage, type_multiplier}`（`env.py` 的 `_bump`）；
//   · `faint` → `{side, slot}`；`replacement` → `{side, slot}`；`status_tick` → `{side, status, damage}`；
//   · `escape` → `{side}`（`env.py:988`）；`surrender` → `{side, result}`（`env.py:1711`）；
//   · `battle_result` 的取值域只有 `win` / `loss` / `draw` / `escaped`（`env.py:1638-1642`、`:986`、
//     `:2544-2548`），客户端 `src/client/roco.js:355` 的 `RESULT_CN` 也是这四个 + `ongoing`；
//   · 合法动作的字段与 `ui_legal_actions` / `schema.Action.label` 一致
//     （`{kind, skill_id?, target_index?, item_id?}` + `label` / `skill_name`）。
//
// 纯函数、纯数据、不联网、不起服务：只用 `teacher-review.js` 与 `memory.js` 的**稳定**导出。
//
// ⚠ 注册状态：本文件与 `tests/roco-match-review-depth.test.js` 一样，必须被某个 npm script
//   或 `scripts/roco/guard-selftest.mjs` 的登记表引用，否则 `tests/evals/structure-contract.test.js`
//   的孤儿守卫会红。两处都在本次施工的写域之外，登记由主线程补一行即可：
//     `node --test tests/roco-review-u10.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {rocoGameView} from '../src/coach/roco-experience.js';
import {freshMemory} from '../src/coach/memory.js';
import {
  BATTLE_RESULTS,
  matchReviewLedgerOf,
  recordTeacherReview,
  resetMatchReview,
  reviewMatch,
} from '../src/coach/teacher-review.js';

// ── 造事件 / 造公开视图（一条真实信封一条）──────────────────────────────────
const ev = (turn, kind, detail) => ({turn, kind, detail, evidence: [], text: ''});

function publicView({result = 'loss', turn = 4, pets, legal = []}) {
  return {
    battle_result: result,
    phase: 'ended',
    turn,
    ruleset_id: 'roco-world-s4-2026-09-10',
    state_version: 900,
    self: {active: 0, energy_max: 6, skills: [{skill_id: 'skill_000750', name: '龙血'}], pets},
    opponent: {
      active: 0, living_count: 1,
      field: {slot: 0, pet_id: 'pet_000445', name: '画间沉铁兽', hp: 210, max_hp: 380, energy: 2, fainted: false},
      bench: [],
    },
    legal,
  };
}

/** 我方三只：首发已经倒下（`fainted: true`），后备两只能换。 */
const PETS = [
  {slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 0, max_hp: 425, energy: 2, fainted: true},
  {slot: 1, pet_id: 'pet_000190', name: '海豹船长', hp: 300, max_hp: 374, energy: 1, fainted: false},
  {slot: 2, pet_id: 'pet_000191', name: '黑猫巫师', hp: 108, max_hp: 474, energy: 2, fainted: false},
];

const SKILL = {kind: 'skill', label: '龙血', skill_id: 'skill_000750'};
const SWITCH = {kind: 'switch', target_index: 1, label: '换上第2位'};
const HEAL = {kind: 'item', item_id: '回复药', label: '使用回复药'};

/**
 * 夹具 A：第 4 回合我方首发倒下，之前第 2 回合吃过一次属性克制的一击。
 * 合法表里**只有技能与换人**（没有药）⇒ 这一局只够得上「吃到克制伤害不换人」这一课。
 */
function matchSwitch({matchId = 'u10-A'} = {}) {
  const events = [
    ev(1, 'turn_start', {turn: 1}),
    ev(1, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 38, type_multiplier: 1}),
    ev(2, 'turn_start', {turn: 2}),
    ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 96, type_multiplier: 2}),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 41, type_multiplier: 1}),
    ev(3, 'turn_start', {turn: 3}),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 64, type_multiplier: 1}),
    ev(4, 'turn_start', {turn: 4}),
    ev(4, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 50, type_multiplier: 1}),
    ev(4, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 2}),
    ev(4, 'faint', {side: 'player', slot: 0}),
    ev(4, 'replacement', {side: 'player', slot: 1}),
  ];
  const legal = [SKILL, SWITCH];
  const view = publicView({pets: PETS, legal});
  return {events, turns: 4, view, legal, game: rocoGameView(view, {matchId})};
}

/**
 * 夹具 B：第 4 回合倒下，全程**没有**属性克制的伤害（倍率都是 1）
 * ⇒ 只够得上「倒下之前还有回复药但没有用」这一课（候选只有一门，
 * 用来验「换不了课的时候必须换一种说法，而不是沉默」）。
 */
function matchItem({matchId = 'u10-B'} = {}) {
  const events = [
    ev(1, 'turn_start', {turn: 1}),
    ev(1, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 44, type_multiplier: 1}),
    ev(2, 'turn_start', {turn: 2}),
    ev(2, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 96, type_multiplier: 1}),
    ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 90, type_multiplier: 1}),
    ev(3, 'turn_start', {turn: 3}),
    ev(3, 'damage', {side: 'player', skill_id: 'skill_000750', target_slot: 0, damage: 80, type_multiplier: 1}),
    ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 64, type_multiplier: 1}),
    ev(4, 'turn_start', {turn: 4}),
    ev(4, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 1}),
    ev(4, 'faint', {side: 'player', slot: 0}),
    ev(4, 'replacement', {side: 'player', slot: 1}),
  ];
  const legal = [SKILL, HEAL];
  const view = publicView({pets: PETS, legal});
  return {events, turns: 4, view, legal, game: rocoGameView(view, {matchId})};
}

/** 一份「这一课」的账本行所需要的全部输入都齐了的一局（用来反复记账）。 */
function record(memory, matchId, review) {
  return recordTeacherReview(memory, {matchId, review});
}

// ── 通用核对：绝对词 / 数字可重算 ───────────────────────────────────────────

/** U10 点名的绝对词：一次伤害都不许被写成整局的因果必然。 */
const ABSOLUTE_WORDS = /一定|必然|就是因为|罪魁祸首|导致败北/;

function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/** 这一局产出的每一句（正文 + 学习点 + 依据 + 合法替代的那两句）。 */
function outputStrings(review) {
  return [
    review.text,
    review.learning,
    ...(review.evidence ?? []),
    review.alternative?.sentence,
    review.turning_point?.what,
    ...(review.turning_point?.evidence ?? []),
  ].filter((line) => typeof line === 'string' && line);
}

/**
 * 同一份输入能重算出来的数字集合。
 *
 * 来源三类，全部来自**这一局真的有的东西**：事件里的字段值、逐回合/逐类的**计数**、
 * 以及公开视图里的血量与位次（位次是 `slot + 1`，动作是 `target_index + 1`）。
 * 「约 N 点」这类伤害数字另有更严的一条（见 `assertDamageNumbers`）。
 */
function recomputableNumbers({events, view, legalByTurn = null, turns = null}) {
  const allowed = new Set();
  const add = (value) => {
    if (Number.isFinite(value)) allowed.add(Number(value));
  };
  for (const event of events) {
    add(event.turn);
    for (const value of Object.values(event.detail ?? {})) {
      if (Number.isFinite(value)) add(value);
      if (Number.isInteger(value)) add(value + 1);   // `slot` / `target_slot` / `target_index` 的位次说法
    }
  }
  for (const pet of view?.self?.pets ?? []) {
    add(pet.hp); add(pet.max_hp); add(pet.energy); add(pet.slot); add(pet.slot + 1);
  }
  const field = view?.opponent?.field;
  if (field) { add(field.hp); add(field.max_hp); add(field.energy); add(field.slot + 1); }
  for (const action of [...(view?.legal ?? []), ...Object.values(legalByTurn ?? {}).flat()]) {
    add(action.target_index); add(action.target_index + 1);
  }
  // 合法表的**条数**（「共 N 项」这类数字也要能重算）
  for (const table of Object.values(legalByTurn ?? {})) if (Array.isArray(table)) add(table.length);
  if (Array.isArray(view?.legal)) add(view.legal.length);
  add(turns); add(view?.turn); add(view?.self?.energy_max);
  // 逐类计数（「扣了 N 次血」「一共 N 次抵抗」「连着第 N 局」这类数字必须能重算）
  const count = (kind, side = null) => events.filter((event) => event.kind === kind
    && (side === null || event.detail?.side === side)).length;
  add(count('damage')); add(count('faint')); add(count('status_tick')); add(count('item'));
  add(count('switch')); add(count('replacement')); add(count('damage', 'player'));
  add(count('damage', 'enemy')); add(count('faint', 'player')); add(count('faint', 'enemy'));
  add(events.filter((event) => event.kind === 'damage' && event.detail?.type_multiplier < 1).length);
  add(events.filter((event) => event.kind === 'status_tick' && event.detail?.side === 'player').length);
  add(new Set(events.map((event) => event.turn).filter(Number.isInteger)).size);
  return allowed;
}

function assertNoAbsoluteWords(review, where) {
  for (const line of outputStrings(review)) {
    assert.ok(!ABSOLUTE_WORDS.test(line), `${where} 出现了把单次事件说成必然的绝对词：${line}`);
  }
}

function assertNumbersRecomputable(review, input, where) {
  const allowed = recomputableNumbers(input);
  for (const line of outputStrings(review)) {
    for (const hit of line.matchAll(/\d+(?:\.\d+)?/g)) {
      assert.ok(allowed.has(Number(hit[0])),
        `${where} 里的数字 ${hit[0]} 不在同一份输入能重算出来的集合里：${line}`);
    }
  }
}

/** 「约 N 点」只允许是这一局真的记下来的伤害/回血值。 */
function assertDamageNumbers(review, events, where) {
  const real = new Set();
  for (const event of events) {
    for (const key of ['damage', 'healed']) {
      const value = event.detail?.[key];
      if (Number.isFinite(value)) real.add(Number(value));
    }
  }
  const lines = outputStrings(review);
  let checked = 0;
  for (const line of lines) {
    for (const hit of line.matchAll(/约\s*(\d+(?:\.\d+)?)\s*点/g)) {
      checked += 1;
      assert.ok(real.has(Number(hit[1])),
        `${where} 里的「约 ${hit[1]} 点」不是这一局任何一条 damage/healed 记录：${line}`);
    }
  }
  assert.ok(checked > 0, `${where} 里一条「约 N 点」都没有，这条判据是空的`);
}

// ── ① 合法替代 + 理由 ───────────────────────────────────────────────────────

test('① 合法替代：正文写出「哪一回合 + 当时还有哪一项 + 为什么值得看它」', () => {
  const {events, turns, game, legal, view} = matchSwitch();
  const review = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  assert.ok(review, '这一局有减员、也有可改的一处，不该沉默');
  assert.equal(review.goal, 'switch-out-of-the-bad-matchup');

  // 机器可读的那一份：声称了、来自哪条来源、讲的是哪一回合、哪一项
  assert.equal(review.alternative.claimed, true);
  assert.equal(review.alternative.source, 'legal-by-turn');
  assert.equal(review.alternative.anchor_turn, 4);
  assert.equal(review.alternative.view_turn, 4);
  assert.equal(review.alternative.label, '换上第2位');

  // 玩家看到的那一份：具体回合 + 那一项 + 理由 + 当时做的那一手
  assert.match(review.text, /第 4 回合当时的合法动作里还有「换上第2位」这一项/);
  assert.match(review.text, /当时你做的是「龙血」/);
  assert.match(review.text, /之所以值得看它：第 2 回合已经吃过一次属性克制的伤害（约 96 点，倍率 2），到第 4 回合倒下之间没有换过人/);
  // 理由里的每个数字都来自这一局的事件
  assert.ok(events.some((event) => event.detail?.damage === 96 && event.detail?.type_multiplier === 2));
  // 不许把「换了就会不一样」说成保证
  assert.ok(review.text.includes('不代表换了它整局就会不一样'), review.text);
  // 依据里也要有可核对的那一条
  assert.ok(review.evidence.some((line) => line.includes('合法动作表里有「换上第2位」')),
    JSON.stringify(review.evidence));

  assertNoAbsoluteWords(review, '①合法替代');
  assertDamageNumbers(review, events, '①合法替代');
  assertNumbersRecomputable(review, {events, view, legalByTurn: {4: legal}, turns}, '①合法替代');
});

test('① 必红反证：撤掉 legalByTurn ⇒ 一个字都不许再声称「当时合法集合里有 X」', () => {
  const {events, turns, game, legal} = matchSwitch();
  const on = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  const off = reviewMatch({events, turns, result: 'loss', game});
  // 正向：给了表就有那一句
  assert.ok(on.text.includes('当时的合法动作里还有'), on.text);
  // 反证：不给表，这一层**整层关闭**（默认行为与改动前逐字节相同）
  assert.equal(off.alternative, null, '不传 legalByTurn 时「合法替代」这一层不许开工');
  assert.ok(!off.text.includes('合法动作'), `撤掉参数后仍声称了合法集合：${off.text}`);
  assert.ok(!off.evidence.some((line) => line.includes('合法动作表')), JSON.stringify(off.evidence));
  // 逐字对照：这一句只能是**加**上去的，原来那几句一个字都没改
  assert.ok(on.text.startsWith(off.text), `\n加了参数：${on.text}\n没加参数：${off.text}`);
});

test('① 诚实边界：最后一个可行动局面的菜单不许借给别的回合（拿不到就写明未知项）', () => {
  const {events, turns, view} = matchSwitch();
  const matchId = 'u10-A';
  // 手里那份局面属于第 9 回合，而要讲的那一回合是第 4 回合——**不是同一回合**
  const late = rocoGameView({...view, turn: 9}, {matchId});
  const review = reviewMatch({events, turns, result: 'loss', game: late, legalByTurn: {}});
  assert.ok(review);
  assert.equal(review.alternative.claimed, false, '表不属于那一回合时不许声称');
  assert.equal(review.alternative.source, null);
  assert.equal(review.alternative.view_turn, 9);
  assert.equal(review.alternative.anchor_turn, 4);
  assert.match(review.alternative.unknown, /合法行动表没有随复盘送来/);
  assert.ok(!review.text.includes('合法动作里还有'), review.text);
  assert.match(review.text, /这是查不到，不是没有/);
  assert.match(review.text, /能照做的还是学习点里那一句/);
  assert.match(review.evidence.join(' '), /手里那份局面属于第 9 回合/);

  // 反向对照：同一个局面，只要它**就是**那一回合（view.turn === anchor），就允许它作证——
  // 否则上面那条只是「永远不声称」的假绿。
  const vouching = rocoGameView({...view, turn: 4}, {matchId});
  const ok = reviewMatch({events, turns, result: 'loss', game: vouching, legalByTurn: {}});
  assert.equal(ok.alternative.claimed, true);
  assert.equal(ok.alternative.source, 'live-view');
  assert.equal(ok.alternative.label, '换上第2位');
});

test('① 表在手上但不含能对上这一课的那一项 ⇒ 只列菜单，不点「该换成什么」', () => {
  const {events, turns, game} = matchSwitch();
  const skillsOnly = [SKILL, {kind: 'skill', label: '气波', skill_id: 'skill_000673'}];
  const review = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: skillsOnly}});
  assert.equal(review.alternative.claimed, false);
  assert.equal(review.alternative.source, 'legal-by-turn');
  assert.equal(review.alternative.skipped, 'table-has-no-matching-alternative');
  assert.deepEqual(review.alternative.menu, ['龙血', '气波']);
  assert.match(review.text, /里面没有能对上这一课的那一项/);
  assert.ok(!review.text.includes('当时的合法动作里还有'), review.text);
});

test('① 这一课这一局做对了 ⇒ 不点替代（表扬那一局不配「你当时其实可以…」）', () => {
  // 局面与 B 相同，但第 4 回合之前**先吃过药**：处理方式是 healed-before-faint，属于做对了。
  const events = [
    ev(3, 'turn_start', {turn: 3}),
    ev(3, 'item', {side: 'player', item: '回复药', healed: 45}),
    ev(4, 'turn_start', {turn: 4}),
    ev(4, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 1}),
    ev(4, 'faint', {side: 'player', slot: 0}),
  ];
  const view = publicView({pets: PETS, legal: [HEAL]});
  const game = rocoGameView(view, {matchId: 'u10-P'});
  const review = reviewMatch({events, turns: 4, result: 'loss', game, legalByTurn: {4: [HEAL]}});
  assert.ok(review);
  assert.equal(review.goal, 'use-item-before-danger-line');
  assert.equal(review.check.handling, 'healed-before-faint');
  assert.equal(review.teaching_a_mistake, false, '这一局这一课是做对了的地方');
  assert.equal(review.alternative.claimed, false);
  assert.equal(review.alternative.skipped, 'lesson-was-handled-well');
  assert.ok(!review.text.includes('当时的合法动作里还有'), review.text);
});

// ── ② 不复读同一句 ─────────────────────────────────────────────────────────

test('② 换不了课就换一种说法：复读防线不许把复盘变成空白', () => {
  const first = matchItem({matchId: 'u10-B1'});
  const one = reviewMatch({events: first.events, turns: first.turns, result: 'loss', game: first.game, legalByTurn: {4: first.legal}});
  assert.ok(one);
  assert.deepEqual(one.candidates, ['use-item-before-danger-line'], '这一局只够得上一门课（换不了课）');
  const memory = record(freshMemory(), 'u10-B1', one);

  const second = matchItem({matchId: 'u10-B2'});
  const two = reviewMatch({events: second.events, turns: second.turns, result: 'loss', game: second.game, legalByTurn: {4: second.legal}, memory});
  assert.ok(two, '因为「讲过」就整条返回 null，等于把复盘变成空白——不许');
  assert.equal(two.repeat_avoided.detected, true);
  assert.equal(two.repeat_avoided.reason, 'same-lesson-as-previous-match');
  assert.equal(two.repeat_avoided.action, 'rephrased');
  assert.equal(two.repeat_avoided.via, 'repeat-defense');
  assert.equal(two.repeat_avoided.previous.matchId, 'u10-B1');
  assert.equal(two.repeat_avoided.previous.turn, 4);
  assert.equal(two.repeat_avoided.streak, 2);
  // 上一局那一句**一个字都不许**再出现（正文与学习点原句都算）
  assert.ok(!two.text.includes(one.text), `第二局把上一局正文又念了一遍：${two.text}`);
  assert.ok(!two.text.includes(one.learning), `第二局把上一局学习点原句又念了一遍：${two.text}`);
  assert.match(two.text, /不逐字重复上一局那一句/);
  assert.match(two.text, /换个说法：下一局血线掉到一半就先吃药/);
  // 仍然是这一课：学习点（机器可读的那一栏）不许也跟着变空
  assert.equal(two.goal, 'use-item-before-danger-line');
  assert.equal(two.learning, one.learning);

  // 第三局：同一份事实再连着来一次，改写那一句也必须与上一局不同（否则改写自己成了复读）
  const third = matchItem({matchId: 'u10-B3'});
  const memory2 = record(memory, 'u10-B2', two);
  const three = reviewMatch({events: third.events, turns: third.turns, result: 'loss', game: third.game, legalByTurn: {4: third.legal}, memory: memory2});
  assert.equal(three.repeat_avoided.action, 'rephrased');
  assert.equal(three.repeat_avoided.streak, 3);
  assert.ok(!three.text.includes(two.text), `第三局把第二局正文又念了一遍：${three.text}`);
  assert.match(three.text, /连着第 3 局了/);
});

test('② 必红反证：账本那一行没有 matchId（或本局拿不到编号）⇒ 不许把它当「上一局」', () => {
  const first = matchItem({matchId: 'u10-B1'});
  const one = reviewMatch({events: first.events, turns: first.turns, result: 'loss', game: first.game});
  const memory = record(freshMemory(), 'u10-B1', one);
  const second = matchItem({matchId: 'u10-B2'});
  const withId = reviewMatch({events: second.events, turns: second.turns, result: 'loss', game: second.game, memory});
  assert.equal(withId.repeat_avoided.detected, true, '正向前提：带 matchId 时应当命中');

  // 反证一：账本行被抹掉 matchId（老存档 / 手工构造）⇒ 不许引用它
  const anonymous = {...memory, journal: memory.journal.map((row) => ({...row, matchId: undefined}))};
  const noRowId = reviewMatch({events: second.events, turns: second.turns, result: 'loss', game: second.game, memory: anonymous});
  assert.equal(noRowId.repeat_avoided.detected, false, '账本行没有编号时不许当作「上一局」');
  assert.equal(noRowId.repeat_avoided.previous, null);

  // 反证二：本局拿不到编号（没传 matchId，局面视图的 id 也拿掉）⇒ 同样不许引用
  const noMatchId = reviewMatch({
    events: second.events, turns: second.turns, result: 'loss',
    game: rocoGameView(second.view, {matchId: null}), memory,
  });
  assert.equal(noMatchId.repeat_avoided.detected, false, '拿不到本局编号时不许引用旧局');
  assert.ok(!noMatchId.text.includes('上一局'), noMatchId.text);
});

test('② 换得了课就换课：换课理由进结构化字段，正文里说清换的原因', () => {
  // 这一局同时够得上两门课（用药 / 换人）；先按原口径记一次「用药」那一课
  const both = () => {
    const events = [
      ev(1, 'turn_start', {turn: 1}),
      ev(2, 'turn_start', {turn: 2}),
      ev(2, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 96, type_multiplier: 2}),
      ev(3, 'turn_start', {turn: 3}),
      ev(3, 'damage', {side: 'enemy', skill_id: 'skill_000310', target_slot: 0, damage: 64, type_multiplier: 1}),
      ev(4, 'turn_start', {turn: 4}),
      ev(4, 'damage', {side: 'enemy', skill_id: 'skill_000311', target_slot: 0, damage: 210, type_multiplier: 2}),
      ev(4, 'faint', {side: 'player', slot: 0}),
      ev(4, 'replacement', {side: 'player', slot: 1}),
    ];
    const legal = [SKILL, SWITCH, HEAL];
    const view = publicView({pets: PETS, legal});
    return {events, turns: 4, view, legal};
  };
  const A = both();
  const one = reviewMatch({events: A.events, turns: A.turns, result: 'loss', game: rocoGameView(A.view, {matchId: 'u10-C1'}), legalByTurn: {4: A.legal}});
  assert.deepEqual(one.candidates, ['use-item-before-danger-line', 'switch-out-of-the-bad-matchup']);
  assert.equal(one.goal, 'use-item-before-danger-line');
  const memory = record(freshMemory(), 'u10-C1', one);

  const B = both();
  const two = reviewMatch({events: B.events, turns: B.turns, result: 'loss', game: rocoGameView(B.view, {matchId: 'u10-C2'}), legalByTurn: {4: B.legal}, memory});
  assert.equal(two.repeat_avoided.detected, true);
  assert.equal(two.repeat_avoided.action, 'switched-lesson');
  assert.equal(two.repeat_avoided.previous.matchId, 'u10-C1');
  assert.equal(two.goal, 'switch-out-of-the-bad-matchup', '上一局讲过的那一门不再讲第二遍');
  assert.ok(!two.text.includes(one.text), two.text);
  assert.match(two.text, /上一局的复盘讲的是「倒下之前还有回复药但没有用」这一类局面，这一局不再重复那一句/);
});

test('② 同一局重复复盘：不许把本局记录说成「上一局讲过」', () => {
  const {events, turns, game, legal} = matchItem({matchId: 'u10-D'});
  const first = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  const memory = record(freshMemory(), 'u10-D', first);   // 同一个 matchId
  const again = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}, memory});
  assert.equal(again.repeat_detail.memory_taught, true);
  assert.equal(again.repeat_detail.same_match, true);
  assert.equal(again.repeat_detail.previous_match, false);
  assert.equal(again.repeat_avoided.detected, false, '同一局不是「上一局」');
  assert.ok(!again.text.includes('这一课之前讲过，这次又是同一类局面'), again.text);
  assert.match(again.text, /同一局重复复盘/);
  // 同一局的结论本身不许变（只有那句「已经记过账」是新的）
  assert.equal(again.goal, first.goal);
  assert.equal(again.learning, first.learning);
  assert.deepEqual(again.check, first.check);
});

// ── ③ 不拿单次伤害写绝对结论 ────────────────────────────────────────────────

test('③ 单次伤害：只说「这一次挨了约 N 点」，并明说不能据此断定整局走向', () => {
  const {events, turns, game, legal, view} = matchSwitch();
  const review = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  const fatal = review.evidence.find((line) => line.includes('约 210 点伤害'));
  assert.ok(fatal, JSON.stringify(review.evidence));
  assert.match(fatal, /这是单次伤害记录，不能据此断定整局走向/);
  assertNoAbsoluteWords(review, '③单次伤害');
  assertDamageNumbers(review, events, '③单次伤害');
  assertNumbersRecomputable(review, {events, view, legalByTurn: {4: legal}, turns}, '③单次伤害');
});

test('③ 必红反证：撤掉那一击 ⇒ 那条单次伤害结论与免责句必须一起消失', () => {
  const {events, turns, game, legal} = matchSwitch();
  const withBlow = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  assert.ok(withBlow.evidence.some((line) => line.includes('约 210 点伤害')));
  assert.ok(withBlow.evidence.some((line) => line.includes('单次伤害记录')));

  // 只撤掉第 4 回合那一击（`damage === 210`），别的都不动
  const without = events.filter((event) => !(event.kind === 'damage' && event.detail?.damage === 210));
  const after = reviewMatch({events: without, turns, result: 'loss', game, legalByTurn: {4: legal}});
  assert.ok(after, '撤掉那一击之后这一局仍然有可讲的东西');
  const joined = [after.text, ...after.evidence].join(' ');
  assert.ok(!joined.includes('约 210 点'), `撤掉那一击之后还在说那 210 点：${joined}`);
  assert.ok(!joined.includes('单次伤害记录'), `撤掉那一击之后免责句还挂着：${joined}`);
});

// ── ④ 胜/负/逃跑/异常结束分开 ───────────────────────────────────────────────

test('④ 四类结果分开：撤退不许写成输了，异常结束说「引擎没给全」', () => {
  const {events, turns, game} = matchSwitch();
  // 取值域逐个核过引擎源码（见文件头），这四个是**真的会**出现的
  assert.deepEqual([...BATTLE_RESULTS], ['win', 'loss', 'draw', 'escaped']);

  const win = reviewMatch({events, turns, result: 'win', game});
  assert.equal(win.outcome.category, 'win');
  assert.match(win.text, /最后赢了下来/);

  const loss = reviewMatch({events, turns, result: 'loss', game});
  assert.equal(loss.outcome.category, 'loss');
  assert.match(loss.text, /最后输掉了/);

  const draw = reviewMatch({events, turns, result: 'draw', game});
  assert.equal(draw.outcome.category, 'draw');
  assert.match(draw.text, /双方打平/);

  const escaped = reviewMatch({events, turns, result: 'escaped', game});
  assert.equal(escaped.outcome.category, 'escaped');
  assert.match(escaped.text, /最后是我方主动撤退结束的，不是被打输的/);
  assert.ok(!escaped.text.includes('最后输掉了'), `撤退被写成了输了：${escaped.text}`);
  assert.ok(!escaped.text.includes('落败'), escaped.text);

  // 未知取值：说「引擎没给全」，并把它**如实**带出来（客户端本来就会原样显示这个值）
  const unknown = reviewMatch({events, turns, result: 'interrupted', game: null});
  assert.equal(unknown.outcome.category, 'unknown');
  assert.match(unknown.text, /这一局的结论引擎没给全/);
  assert.match(unknown.text, /引擎写的结束方式是「interrupted」/);
  assert.ok(!unknown.text.includes('最后输掉了'), `未知取值被写成了输了：${unknown.text}`);

  // 连值都没有：仍然是「没给全」，而不是「结果没有记下来」那种听起来像结论的说法
  const missing = reviewMatch({events, turns, result: null, game: null});
  assert.equal(missing.outcome.category, 'missing');
  assert.match(missing.text, /这一局的结论引擎没给全（结束方式那一项是空的）/);
  assert.ok(!missing.text.includes('结果没有记下来'), missing.text);
});

test('④ 投降判负 ≠ 被打输：引擎给的结果字符串一样，事件流里有 surrender 行', () => {
  const {events, turns, game} = matchSwitch();
  const surrender = reviewMatch({
    events: [...events, ev(4, 'surrender', {side: 'player', result: 'loss'})],
    turns, result: 'loss', game,
  });
  assert.equal(surrender.outcome.category, 'loss');
  assert.equal(surrender.outcome.event, 'surrender');
  assert.match(surrender.text, /最后判负（这一局是我方投降，不是全队被打倒）/);
  // 对照：没有 surrender 行的同一局照旧说「最后输掉了」
  const plain = reviewMatch({events, turns, result: 'loss', game});
  assert.equal(plain.outcome.event, null);
  assert.match(plain.text, /最后输掉了/);
});

// ── ⑤ 开下一局清掉旧局建议（纯函数）─────────────────────────────────────────

test('⑤ resetMatchReview：新的一局是一份全新的空账，旧局结论一个都不带', () => {
  const {events, turns, game, legal} = matchSwitch();
  const review = reviewMatch({events, turns, result: 'loss', game, legalByTurn: {4: legal}});
  const ledger = review.ledger;
  assert.equal(ledger.matchId, 'u10-A');
  assert.equal(ledger.goal, 'switch-out-of-the-bad-matchup');
  assert.equal(ledger.turning_point.turn, 4);

  const fresh = resetMatchReview({matchId: 'u10-next'});
  assert.equal(fresh.matchId, 'u10-next');
  for (const key of ['text', 'learning', 'goal', 'turning_point', 'check', 'alternative', 'repeat_avoided', 'repeat_detail']) {
    assert.equal(fresh[key], null, `新账里的 ${key} 必须是空的`);
  }
  // 纯函数：同一份输入两次调用逐字相同，而且不共享引用（改一个不影响另一个）
  assert.deepEqual(resetMatchReview(), resetMatchReview());
  const a = resetMatchReview();
  a.goal = '被改过';
  assert.equal(resetMatchReview().goal, null);
  // 空账与「从一份复盘里造账」是同一个形状（页面只需要认一种）
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(matchReviewLedgerOf(review)).sort());
});

test('⑤ 旧局的句子不许当本局的结论：matchId 不同时只能作为「换一句」的理由', () => {
  const first = matchItem({matchId: 'u10-E1'});
  const one = reviewMatch({events: first.events, turns: first.turns, result: 'loss', game: first.game});
  // 手工往账本里塞一句「上一局的结论」——本局绝不许把它当成自己的结论
  const planted = '上一局说你一定会赢，照那个打就行。';
  const memory = record(freshMemory(), 'u10-E1', {...one, text: planted, learning: planted});

  const second = matchItem({matchId: 'u10-E2'});
  const two = reviewMatch({events: second.events, turns: second.turns, result: 'loss', game: second.game, memory});
  assert.ok(two);
  assert.ok(!two.text.includes(planted), `旧局的句子漂进了本局结论：${two.text}`);
  assert.ok(!(two.evidence ?? []).some((line) => line.includes(planted)), JSON.stringify(two.evidence));
  assert.equal(two.goal, 'use-item-before-danger-line', '本局的课由本局的事件决定');
  assert.equal(two.check.turn, 4, '本局的局面回合来自本局的事件');
  // 本局的正文仍然是「本局事实 + 这一课的做法」，与旧局那句无关
  assert.match(two.text, /第 4 回合/);
  assertNoAbsoluteWords(two, '⑤跨局清理');
  assertNumbersRecomputable(two, {events: second.events, view: second.view, turns: second.turns}, '⑤跨局清理');

  // 更严的一遍：塞进去的那一句**恰好就是这一课的学习点**（于是复读防线会命中）——
  // 命中之后本局只能说「换一种说法」，仍然**不许**把旧局那一句原样搬进本局结论。
  const memory2 = record(freshMemory(), 'u10-E1', {...one, text: planted, learning: one.learning});
  const three = reviewMatch({events: second.events, turns: second.turns, result: 'loss', game: second.game, memory: memory2});
  assert.equal(three.repeat_avoided.detected, true, '这一遍应当命中复读防线（前提）');
  assert.equal(three.repeat_avoided.action, 'rephrased');
  assert.ok(!three.text.includes(planted), `旧局的句子漂进了本局结论：${three.text}`);
  assert.ok(!three.text.includes(one.text), three.text);
});
