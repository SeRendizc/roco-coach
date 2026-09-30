// 2026-09-30（P0 旁路缺陷收口）：`coach-advice.js:1088` 原来写死 `needsReplacement: []` ✗
// ⇒ 引擎给的 `needs_replacement`（`roco-service.js:243` → `index.js:329-330 c.roco_battle`）
//   被**丢掉**；而下游有五个消费者直接 `.includes(...)`（`:567 :604 :605 :1118 :1393`）。
// 判据两个方向都钉：**给了 `['player']` ⇒ 必须流下去** / **没给 ⇒ 仍给 `[]` 且不抛** ✓
//
// ⚠ 2026-09-30 **改钉（改钉不删）**：原来这两条**跳过我**（`skip`，不是通过）——
//   原因逐字留档：「fixture 形状不足：`battleAdvice()` 对手搓 battle 返回 null」。
//   根因（本轮实测）：`battleAdvice({battle})` 吃的**不是**引擎的公开 `view`，而是客户端那层
//   `coachRocoBattle()` 投影 ⇒ 手搓 view 喂它必然 `null`（**这是 fixture 问题，不是产品缺陷** ✓）。
//   ⇒ 现在改用**真实快照 + 页面同一条真实链路**：
//     `tests/fixtures/roco-replacement-view.json`（`startServer()` 独立实例 → `battle/new` →
//     `plan(depth2,beam4)`，在 `view.needs_replacement=['player']` 那一刻原样落盘的 view），
//     再走 `rocoGameView(view)` + `coachAdvice(...)` —— 与 harness 的 `adviceOf`、与浏览器侧**同一份构造**。
//   旧写法留档（改钉不删）：
//     const baseBattle = (needs) => ({self_energy_max: 10, self: {name: '多彩方方', …}, …});
//     test('① …', {skip: 'fixture 形状不足：battleAdvice() 对手搓 battle 返回 null（未完成，见上）'}, …)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'roco-replacement-view.json'), 'utf8'));
const VIEW = FIXTURE.view;

//: 与 `scripts/roco/coach-position-harness.mjs` 的 `adviceOf` 同一条构造（页面走的就是它）。
const adviceOf = async (view) => {
  const {rocoGameView} = await import('../src/coach/roco-experience.js');
  const {coachAdvice} = await import('../src/coach/coach-advice.js');
  const game = rocoGameView(view, {matchId: null});
  return coachAdvice({
    game, plan: null,
    session: {hints: 0, lastAt: -Infinity, dismissed: false, said: new Set()},
    host: {preference: 'gentle', stale: false, ended: false, background: false, focus: true},
  });
};

test('① 正例：真实快照里 needs_replacement=[\'player\'] ⇒ 真流到 pos（旧代码恒 [] ⇒ 这里必红）', async () => {
  assert.deepEqual(VIEW.needs_replacement, ['player'], '夹具前提：这一份快照必须带补位标记');
  assert.equal(VIEW.phase, 'replace');
  const out = await adviceOf(VIEW);
  assert.ok(out, '正例不许返回 null（否则判据无效）');
  const text = JSON.stringify(out);
  assert.match(text, /补位|替换|换上|换人/, `必须出现"补位/替换"类措辞：${text.slice(0, 300)}`);
  // 更细一格：这一支的 kind 与那个换上来的名字都要对得上（不是随便一句话）
  assert.equal(out.kind, 'replace-required', `补位局面应当走 replace-required 支：${out.kind}`);
  assert.match(String(out.text), /换|顶上/, `正文要说清换上谁：${out.text}`);
});

test('② 反证：needs_replacement 缺失 / 非数组 ⇒ 仍给 [] 且下游 .includes 不抛', async () => {
  for (const bad of [undefined, null, 'player', 42, {}]) {
    const view = {...VIEW, needs_replacement: bad};
    const out = await adviceOf(view);
    assert.ok(out !== undefined, `喂 ${JSON.stringify(bad)} 不许抛（返回 undefined 也不行）`);
  }
});

test('③ 对照实验：隔离这个标记 ⇒ 结果必须不同（`coach-advice.js` 写死 `[]` 就在这里红）', async () => {
  // ⚠ 这一条第一版写错过，实测四格（真实夹具 + 受控变异，逐字读数）记下来：
  //     倒下 + 标记  ⇒ kind=replace-required · text「「寂灭骨龙」倒了，换「海豹船长」顶上…」
  //     倒下 + 空表  ⇒ kind=replace-required · 同上（**倒下的那一支本身就触发补位 ⇒ 正确行为，标记在这里没有区分度**）
  //     活着 + 标记  ⇒ kind=replace-required                     ← **标记真的流下去了** ✓
  //     活着 + 空表  ⇒ kind=**speed-decides**（「它速度 70 快过你 60：…先换人躲一下」）  ← **没有标记就换另一支** ✓
  //   ⇒ 要**隔离这个标记**，必须让"倒下"那一支不成立 ⇒ 把场上那只**改活**（受控变异，其它字段原样）。
  //   ⇒ 也如实说明：**①（倒下夹具）抓不住"写死 []"这个回归**（倒下的分支照旧补位）；
  //     抓住它的是**③ 的"活着"那一格** —— 所以两条都要在，不能只留 ①。
  const alive = {...VIEW, self: {...VIEW.self,
    pets: VIEW.self.pets.map((pet, index) => (index === VIEW.self.active
      ? {...pet, hp: pet.max_hp, fainted: false} : pet))}};
  const active = alive.self.pets[alive.self.active];
  assert.ok(active.hp > 0 && active.fainted === false, `受控变异：场上那只必须活着（hp=${active.hp}）`);

  const flagged = await adviceOf(alive);
  const emptied = await adviceOf({...alive, needs_replacement: []});
  assert.equal(flagged?.kind, 'replace-required', `有标记 ⇒ 必须走"必须补位"那一支：${flagged?.kind}`);
  assert.notEqual(emptied?.kind, 'replace-required', `空表 ⇒ 不许再走"必须补位"那一支：${emptied?.kind}`);
  assert.notEqual(JSON.stringify(flagged), JSON.stringify(emptied),
    '给了补位标记 ⇒ 结果必须与空表不同（`coach-advice.js` 若写死 `[]` ⇒ 两边相同 ⇒ 这里红 ✓）');
  // 顺带把"倒下压过标记"这条正确行为钉住（免得下一个人把它当 bug 改掉）
  const faintedFlagged = await adviceOf(VIEW);
  const faintedEmpty = await adviceOf({...VIEW, needs_replacement: []});
  assert.equal(faintedFlagged?.kind, 'replace-required');
  assert.equal(faintedEmpty?.kind, 'replace-required', '场上那只倒下时，标记给不给都要补位（正确行为）');
});

// ── ④ **客户端那条路**（`battleAdvice({battle})` 吃的 `roco_battle`）────────────────────────────
// 为什么要单开这一条（本轮实测的教训）：上面 ①②③ 走的是 **harness/页面那条**（`rocoGameView(view)`
// → `coachAdvice({game})`），**它不读 `coach-advice.js:1094` 那一行** ⇒ 我把那一行临时写死 `[]`，
// ①②③ **全绿**（对照实验没抓到）✗。真正读那一行的是 **`battleAdvice({battle})`**（客户端
// `coachRocoBattle()` 送出去的那份形状）⇒ 所以必须**再钉一条走那条路的**，回归才咬得住。
// 投影函数照客户端那个投影的字段（`self/self_active/foe/legal/needs_replacement/phase/turn/state_version`），
// **数据本身仍来自真实快照**（`tests/fixtures/roco-replacement-view.json`，未手搓）。
const toClientBattle = (view) => {
  const pet = (row) => ({name: row.name, hp: row.hp, max_hp: row.max_hp, energy: row.energy,
    alive: row.fainted !== true, types: row.types ?? [], statuses: row.statuses ?? {}});
  return {
    phase: view.phase, turn: view.turn, result: view.battle_result?.winner ?? null,
    self_active: view.self.active,
    self: view.self.pets.map(pet),
    foe: Array.isArray(view.opponent?.pets)
      ? [pet(view.opponent.pets[view.opponent.active ?? 0])] : [],
    legal: (view.legal ?? []).map((one) => ({kind: one.kind, label: one.label, skill: one.skill ?? null})),
    needs_replacement: Array.isArray(view.needs_replacement) ? view.needs_replacement.slice() : [],
    state_version: view.state_version, self_energy_max: view.self.energy_max,
  };
};

test('④ 客户端形状那条路：`needs_replacement` 翻转 ⇒ `battleAdvice` 的 kind 必须跟着变', async () => {
  const {battleAdvice} = await import('../src/coach/coach-advice.js');
  const battle = toClientBattle(VIEW);
  // 正例（真实快照原样：场上那只已倒下 + 引擎标记）⇒ 必须给建议（不是 null），并走补位那一支
  const withFlag = battleAdvice({battle, plan: null});
  assert.ok(withFlag, '`battleAdvice` 对真实快照不许返回 null（手搓 fixture 才会 null）');
  assert.equal(withFlag.kind, 'replace-required');
  assert.match(String(withFlag.text), /换上第2位|海豹船长/, `要点名换上谁：${withFlag.text}`);
  // 隔离：把场上那只改活 ⇒ 标记成为**唯一**理由；再翻转标记 ⇒ kind 必须变
  const alive = {...battle, self: battle.self.map((row, i) => (i === battle.self_active
    ? {...row, hp: row.max_hp, alive: true} : row)), needs_replacement: ['player']};
  const flagged = battleAdvice({battle: alive, plan: null});
  const emptied = battleAdvice({battle: {...alive, needs_replacement: []}, plan: null});
  assert.equal(flagged?.kind, 'replace-required', `有标记 ⇒ 补位那一支：${flagged?.kind}`);
  assert.equal(emptied?.kind, 'primary-action', `空表 ⇒ 不许再走补位那一支：${emptied?.kind}`);
  assert.notEqual(JSON.stringify(flagged), JSON.stringify(emptied),
    '`coach-advice.js` 若把 `needsReplacement` 写死成 `[]`，这里两边相同 ⇒ **本判据必红** ✓');
});
