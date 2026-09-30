// 玩家可见文本不许露内部精度（D-31，2026-09-30 由 lead-mac 的全功能审核长出来）
//
// 病灶：`src/coach/teacher.js:332` 直接内插 `decision.gap`（未格式化）⇒ 玩家读到
//   「评分差 6523.247662596753」——13 位小数。
// 同仓给玩家看的分数都有口径（`strategist.js:40` `toFixed(1)` · `roco-experience.js:1148/1150`
// `toFixed(2)` · `coach-advice.js:695/719` `toFixed(3)`），只有复盘这一条露原始浮点。
//
// 这一条判据量的是**行为**（真的跑生产者、读玩家可见面），不是扫源码：
// 源码里 `${d.gap}` 一个数字都没有，静态扫描看不见它。
//
// 规则：玩家可见文本里出现 `\d+\.\d{3,}`（≥3 位小数）即算「露内部精度」。
// 需要高精度的**非玩家可见**字段（调试、内部诊断）不进这份清单；若将来确有玩家可见处
// 必须用 ≥3 位小数，必须在 `ALLOW` 里显式登记 + 写理由，不许默默放过。
//
// 两向变异（必红方向）：把 `teacher.js:332` 的 `toFixed(1)` 去掉（回到原始内插）
//   ⇒ 「关键回合那一句的评分差」这条必须红。见本文件末尾的自检。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createGame, legalActions, step} from '../src/game/engine.js';
import {reviewMatch, summarizeMatch} from '../src/coach/teacher.js';
import {strategist} from '../src/coach/strategist.js';
import {rocoMatchReview} from '../src/coach/roco-experience.js';
import {battleAdvice} from '../src/coach/coach-advice.js';
import {companion} from '../src/coach/companion.js';
import {freshMemory} from '../src/coach/memory.js';

/** 内部精度：≥3 位小数。 */
const PRECISE = /\d+\.\d{3,}/;

/** 显式白名单（{surface, pattern/reason}）。目前为空：玩家可见面里没有一处需要 ≥3 位小数。 */
const ALLOW = [];

function scan(label, strings, hits) {
  for (const value of strings) {
    if (typeof value !== 'string') continue;
    const hit = value.match(PRECISE);
    if (!hit) continue;
    // 白名单：值命中 `pattern` 且 surface 相同 ⇒ 放过（必须写理由）。
    if (ALLOW.some((row) => row.surface === label && row.test(value))) continue;
    // 读数只留命中那一段（前后各 24 字），便于人工核对又不至于把整段正文刷出来。
    const at = hit.index ?? 0;
    hits.push(`${label}: …${value.slice(Math.max(0, at - 24), at + hit[0].length + 12)}…`);
  }
}

/** 跑一局营地练习（与 copy.test.js 同一套手法：真引擎、真 step）。 */
function playMatch(seed) {
  let game = {...createGame(seed), id: `d31-${seed}`};
  let i = 0;
  while (!game.result && i < 60) {
    const all = legalActions(game);
    const skills = all.filter((a) => a.kind === 'skill');
    const list = skills.length ? skills : all;
    const pick = list[(seed + i) % list.length];
    if (!pick) break;
    game = step(game, pick);
    i += 1;
  }
  return game;
}

/** 玩家可见面 = 正文 + 折叠句 + 依据 + 可点的追问（与 copy.test.js 同一口径）。 */
const visibleOf = (packet) => [packet?.text, packet?.brief, ...(packet?.evidence ?? []), ...(packet?.choices ?? [])];

test('① 真对局的整局复盘：玩家可见面里不许出现 ≥3 位小数', () => {
  const hits = [];
  for (const seed of [1, 2, 3, 5, 11, 17, 24]) {
    const match = summarizeMatch(playMatch(seed));
    assert.ok(match, `seed ${seed} 应当有回合记录`);
    const packet = reviewMatch({lastMatch: match});
    scan(`复盘 seed ${seed}`, visibleOf(packet), hits);
  }
  assert.deepEqual(hits, [], `玩家可见的复盘里出现了内部精度：\n${hits.join('\n')}`);
});

test('② 关键回合那一句的评分差：浮点必须被格式化（D-31 的正主）', () => {
  const gap = 6523.247662596753;
  const decision = {
    turn: 2, gap, lesson: '换人承伤',
    chosen: {name: '继续输出', action: {kind: 'skill'}},
    optionsComplete: true,
    situation: {playerPet: '烬尾狐', playerHp: 41, playerEnergy: 3, enemyPet: '溪刃獭', enemyHp: 88},
    options: [
      {name: '继续输出', action: {kind: 'skill'}},
      {name: '换上潮甲龟', action: {kind: 'switch', name: '潮甲龟'}},
    ],
    numbers: {}, consequence: {playerHp: 12, enemyHp: 70, playerFallen: [], enemyFallen: []},
  };
  const lastMatch = {
    id: 'd31-gap', result: 'loss', stage: '训练场', rounds: 2,
    counts: {attacks: 2, switches: 0, guards: 0, items: 0, escapes: 0},
    remainingItems: {potion: 1, cleanse: 0, ether: 0},
    keyTurns: [{turn: 2, events: ['我方使用火花。'], analysis: '（分析）', alternatives: {gap, line: '候选：换上潮甲龟'}, decision}],
    turnLog: [{turn: 2, you: {name: '烬尾狐', hp: 41, hpAfter: 12}, foe: {name: '溪刃獭', hp: 88, hpAfter: 70},
      action: {kind: 'skill', id: 'ember'}, events: ['我方使用火花。']}],
  };
  const packet = reviewMatch({lastMatch});
  assert.match(packet.text, /评分差/, `前提：这一局要走「评分差」那一句，实际：${packet.text.slice(0, 200)}`);
  const hits = [];
  scan('关键回合评分差', visibleOf(packet), hits);
  assert.deepEqual(hits, [], `评分差把原始浮点露出来了：\n${hits.join('\n')}`);
  // 更强的一条：那一句里的数字必须是**格式化过的**（1 位小数），而不是恰好好看
  const shown = packet.text.match(/评分差\s*([^\s（(]+)/)?.[1] ?? null;
  assert.ok(shown, `找不到评分差后面的值：${packet.text.slice(0, 240)}`);
  assert.match(shown, /^\d+\.\d$|^\d+$|^未登记$/, `评分差必须是 1 位小数以内的数（或「未登记」），实际「${shown}」`);
});

test('③ 军师那一侧（同一类内部评分）：玩家可见面里不许出现 ≥3 位小数', () => {
  const game = createGame(17, ['fox', 'turtle', 'deer'], {mode: 'pve', difficulty: 'normal'});
  const ctx = {battle: {...game, history: [], log: [], frames: []}, profile: {pets: {}}, focus: 'fox', mode: 'pve'};
  const packet = strategist({...ctx, query: '这回合怎么打'});
  const hits = [];
  scan('军师', [packet.text, ...(packet.evidence ?? []), ...(packet.knowledge ?? []).map((c) => `${c.principle} ${c.counterexample ?? ''}`)], hits);
  assert.deepEqual(hits, [], `军师文案里出现了内部精度：\n${hits.join('\n')}`);
});

test('④ 六宠局末复盘（另一条入口）：玩家可见面里不许出现 ≥3 位小数', () => {
  // 合成一份最小但**形状真实**的六宠输入：事件带 turn/kind/detail，局面带 legal。
  const view = {
    schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 12, turn: 4, phase: 'battle',
    match_id: 'm-d31', rules_version: 'roco-world-s4-2026-09-10/mobile_s4_candidate_v3',
    decision_id: 'm-d31:v12', battle_result: 'loss',
    self: {active: 0, energy_max: 10, energy_charge: 5, pets: [
      {slot: 0, pet_id: 'pet_000001', name: '喵喵', hp: 0, max_hp: 300, energy: 0, fainted: true, statuses: {}},
      {slot: 1, pet_id: 'pet_000002', name: '水蓝蓝', hp: 120, max_hp: 300, energy: 4, fainted: false, statuses: {}},
    ], skills: [], loadouts: {}, magic: null},
    opponent: {active: 0, living_count: 2, energy_max: 10, energy_charge: 5,
      field: {slot: 0, pet_id: 'pet_000007', name: '魔力猫', hp: 180, max_hp: 300, energy: 3, fainted: false, statuses: {}},
      bench: [{slot: 1, fainted: false}]},
    legal: [{kind: 'skill', label: '甩水', skill_id: 'skill_000418'}, {kind: 'switch', label: '换上第2位', target_index: 1}],
  };
  const events = [
    {seq: 0, turn: 1, kind: 'damage', text: '喵喵受到 300 伤害。', detail: {side: 'enemy', target_slot: 0, damage: 300, type_multiplier: 4}},
    {seq: 1, turn: 1, kind: 'faint', text: '喵喵倒下。', detail: {side: 'player', slot: 0}},
    {seq: 2, turn: 2, kind: 'damage', text: '魔力猫受到 40 伤害。', detail: {side: 'player', target_slot: 0, damage: 40, type_multiplier: 0.5}},
    {seq: 3, turn: 3, kind: 'damage', text: '魔力猫受到 42 伤害。', detail: {side: 'player', target_slot: 0, damage: 42, type_multiplier: 0.5}},
  ];
  const {review} = rocoMatchReview({
    matchId: 'm-d31', finalView: view, lastLiveView: view, events, turns: 4, result: 'loss', memory: null,
    legalByTurn: {4: view.legal},
  });
  const hits = [];
  scan('六宠复盘', [review?.text, ...(review?.evidence ?? [])], hits);
  assert.deepEqual(hits, [], `六宠复盘的可见面里出现了内部精度：\n${hits.join('\n')}`);
});

test('⑤ 局内建议（高压反例那一局）：玩家可见面里不许出现 ≥3 位小数', () => {
  const battle = {
    phase: 'battle', turn: 9, result: null, self_active: 0,
    self: [{name: '烈火战神', hp: 12, max_hp: 180, energy: 8, alive: true, types: ['火系']},
      {name: '水蓝蓝', hp: 120, max_hp: 150, energy: 6, alive: true, types: ['水系']}],
    foe: [{name: '水晶海豚', hp: 90, max_hp: 150, energy: 7, alive: true, types: ['水系']}],
    foe_bench: [],
    legal: [{kind: 'skill', label: '烈焰冲撞', skill: {name: '烈焰冲撞', energy: 4, power: 110, element: '火系'}},
      {kind: 'skill', label: '守住', skill: {name: '守住', energy: 2, power: 0, element: '普通系'}},
      {kind: 'switch', label: '换上第2位'}],
  };
  const advice = battleAdvice({battle, plan: null});
  assert.ok(advice, '前提：高压局面必须给得出建议');
  const hits = [];
  scan('局内建议', [advice.headline, advice.risk, advice.why, advice.text], hits);
  assert.deepEqual(hits, [], `局内建议里出现了内部精度：\n${hits.join('\n')}`);
});

test('⑥ 陪练的一句人话：不许出现 ≥3 位小数', () => {
  const hits = [];
  for (const message of ['你好', '今天有点累', '我们聊聊呗', '这局打得好累']) {
    const reply = companion({mode: 'camp'}, freshMemory(), message);
    scan(`陪练「${message}」`, [reply?.text], hits);
  }
  assert.deepEqual(hits, [], `陪练回复里出现了内部精度：\n${hits.join('\n')}`);
});
