// 讲人话判据（第③类：裸 JS 值字面量）—— 2026-09-30 由真机读数长出来
// 病灶：teacher.js:346 前缀模板 `${safe.stage}` 没兜底 ⇒ 玩家可见复盘的第一个词是 `undefined`
// 修法两层：`:288` 的 safe 按字段点名补 stage + `:346` 文案层 `?? '这一局'`
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewMatch} from '../src/coach/teacher.js';

const BARE_JS = /\bundefined\b|\bnull\b|\bNaN\b/;
const turnLog = [
  {turn: 3, you: {name: '喵喵', hp: 41, hpAfter: 12}, foe: {name: '寂灭骨龙', hp: 88, hpAfter: 70}, action: {kind: 'guard'}, events: []},
  {turn: 5, you: {name: '喵喵', hp: 4, hpAfter: 0}, foe: {name: '寂灭骨龙', hp: 66, hpAfter: 60}, action: {kind: 'skill'}, events: []},
];

test('正：完整输入 ⇒ 正文不得含裸 JS 值字面量（undefined/null/NaN）', () => {
  const r = reviewMatch({lastMatch: {result: 'loss', stage: '营地训练局', keyTurns: [], counts: {}, turnLog}});
  // 2026-10-01 改钉（task-46 第 2 步 · 原断言逐字留档）：
  //   原：assert.match(r.text, /^营地训练局，共2回合，失利。/, `前缀应读 stage，实际：${r.text.slice(0, 40)}`);
  //   理由：P1-B 要求"这一次复盘讲的是哪一局，正文里说清"。这份 context 没有实时局面 ⇒ 依据是**上一局**
  //        ⇒ 正文按新口径以「上一局：」开头；`stage` 仍是第一个词之后的那个词，裸 JS 值字面量那条断言不变。
  assert.match(r.text, /^上一局：营地训练局，共2回合，失利。/);
  assert.ok(!BARE_JS.test(r.text), `正文不该出现裸 JS 字面量：${r.text.slice(0, 80)}`);
});

test('反证：故意去掉 lastMatch.stage ⇒ 必须被兜底成「上一局」，不许印 undefined', () => {
  const r = reviewMatch({lastMatch: {result: 'loss', keyTurns: [], counts: {}, turnLog}});
  // 2026-10-01 改钉（task-46 第 2 步 · 原断言逐字留档）：
  //   原：assert.match(r.text, /^这一局，共2回合，失利。/, `应兜底成「这一局」，实际：${r.text.slice(0, 40)}`);
  //   理由：这一支的兜底词原本是「这一局」，但这一问依据的是**上一局**（无实时局面）⇒ 说「这一局」是假话。
  //        现在把兜底的那个词直接换成「上一局」（不叠成「上一局：这一局…」）。裸 JS 值字面量那条不变。
  assert.match(r.text, /^上一局，共2回合，失利。/);
  assert.ok(!BARE_JS.test(r.text), `兜底后仍出现裸 JS 字面量：${r.text.slice(0, 80)}`);
});

// --- analyzeTurn 换人分支的防御性守卫（2026-09-30）---
const mkTurn = (target, pets) => ({
  before: {player: {pets, active: 0}, enemy: {pets: [{name: '寂灭骨龙', hp: 88, energy: 3}], active: 0}},
  after: {player: {pets}},
  action: {kind: 'switch', target},
});
const PETS = [{name: '喵喵', hp: 41, energy: 4}, {name: '水蓝蓝', hp: 50, energy: 3}];

test('正：switch 且 target 越界 ⇒ 走兜底句，不得抛 TypeError', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  const text = analyzeTurn(mkTurn(9, PETS));
  assert.match(text, /记录不完整/, `应走兜底句，实际：${text}`);
});

test('正②：switch 且 target 合法 ⇒ 文案逐字不变（回归）', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  const text = analyzeTurn(mkTurn(1, PETS));
  // 2026-10-01 改钉（task-35 文本口径迁移 · 原断言逐字留档）：
  //   原：assert.match(text, /^换上水蓝蓝占用了整回合，生命从50到50。/, `回归：${text.slice(0, 40)}`);
  //   改：血量类单位统一到共用词表 `src/coach/player-text.js`（PLAYER_UNITS.hp='血'），
  //       「生命从…」⇒「血量从…」；语义不变（仍是「换上后血量 50→50」这条回归）。
  //   独立读数：node --test tests/roco-teacher-review-text.test.js ⇒ 见 task-35 冻结报告。
  assert.match(text, /^换上水蓝蓝占用了整回合，血量从50到50。/, `回归：${text.slice(0, 40)}`);
});

test('反证：兜底句若被删掉 ⇒ 本判据必须红（越界调用会抛 TypeError）', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  let threw = false;
  let text = '';
  try { text = analyzeTurn(mkTurn(9, PETS)); } catch { threw = true; }
  assert.ok(!threw && /记录不完整/.test(text), '守卫缺失 ⇒ 这里会抛 TypeError ⇒ 判据红');
});

// --- analyzeTurn 场上索引守卫（同族，2026-09-30）---
const mkTurnB = (active) => ({
  before: {player: {pets: [{name: '喵喵', hp: 41, energy: 4}], active}, enemy: {pets: [{name: '寂灭骨龙', hp: 88, energy: 3}], active: 0}},
  after: {player: {pets: [{name: '喵喵', hp: 41, energy: 4}]}},
  action: {kind: 'guard', id: 'guard'},
});
test('正：active 越界 ⇒ 走兜底句，不得抛 TypeError', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  assert.match(analyzeTurn(mkTurnB(7)), /没有清楚写出/, '应走兜底句');
});
test('正②：active 合法 ⇒ 防御文案逐字不变（回归）', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  // 2026-10-01 改钉（task-35 文本口径迁移 · 原断言逐字留档）：
  //   原：assert.match(analyzeTurn(mkTurnB(0)), /^这次防御用了整回合输出机会换减伤与回能；回合前4豆。/, '回归');
  //   改：能量类统一叫「能量」（PLAYER_UNITS.energy），间距口径 = 数字 + 半角空格 + 单位
  //       ⇒ 「回合前4豆。」变成「回合前4 能量。」；语义不变（仍是防御那一手的回合前能量读数）。
  assert.match(analyzeTurn(mkTurnB(0)), /^这次防御用了整回合输出机会换减伤与回能；回合前4 能量。/, '回归');
});
test('反证：守卫若被删 ⇒ 越界调用抛 TypeError ⇒ 本判据红', async () => {
  const {analyzeTurn} = await import('../src/coach/teacher.js');
  let threw = false, text = '';
  try { text = analyzeTurn(mkTurnB(7)); } catch { threw = true; }
  assert.ok(!threw && /没有清楚写出/.test(text), '守卫缺失 ⇒ 抛 TypeError ⇒ 红');
});
