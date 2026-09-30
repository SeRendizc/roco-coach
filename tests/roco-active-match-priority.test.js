/**
 * P1-B 判据：**当前局优先于上一局 `lastMatch`**（task-46 第 1 步 · `src/coach/runtime.js`）。
 *
 * 背景（lead-mac 的静态审计 + 本仓进程内复现，见
 * `reports/roco/product-execution/crosscut/p1b-lastmatch-triage.md`）：
 * `buildContext` 的旧兜底是 `… : game?.result ? game : previous || current` ⇒ 只要调用方没把 `game`
 * 递进来（小芽面板 / 营地页），而 archive 里既有进行中的 `current` 又有上一局的 `completed`，
 * `lastMatch` 就会取到**上一局** ⇒ 玩家在新局里问「现在该出什么招」，答的是上一局的复盘。
 *
 * 三条规则（`activeMatchOf` 的判据）：
 *   ① 当前局存在 ⇒ `current`（无论问句提不提"上一局"，除非显式问上一局）；
 *   ② 只有"显式问上一局"或"没有当前局"才 `previous`（下游必须显式标注「这是上一局」）；
 *   ③ 都没有 ⇒ `null`（不猜）。
 *
 * 跑法：`node --test tests/roco-active-match-priority.test.js`
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { activeMatchIdOf, activeMatchOf, assembleContext, buildContext, effectiveMatchScope, readsAsPreviousMatch, runCoach } from '../src/coach/runtime.js';
import { createGame, legalActions, step } from '../src/game/engine.js';
import { archiveRound } from '../src/coach/experience.js';
import { freshMemory, rememberBattle } from '../src/coach/memory.js';
import { newProfile } from '../src/game/progression.js';

const NEW_TAG = 'NEW[stage]';
const PREV_TAG = 'PREV[stage]';

/** 真跑一局到结束（允许补位，所以用全部合法动作）。 */
function play(game, limit = 400) {
  let cur = game;
  for (let i = 0; i < limit && !cur.result; i += 1) {
    const all = legalActions(cur);
    const skills = all.filter((x) => x.kind === 'skill');
    const pool = skills.length ? skills : all;
    const pick = pool[i % pool.length];
    if (!pick) break;
    cur = step(cur, pick);
  }
  return cur;
}

/** 夹具：archive.current = 进行中的新局；archive.completed = [上一局]；memory 里最后一条 = 上一局。 */
function fixture() {
  let old = createGame(11, ['fox', 'turtle', 'deer'], { stageName: PREV_TAG, stageId: 'g_prev' });
  old.id = 'PREV-MATCH-ID';
  old = play(old);
  let fresh = createGame(23, ['fox', 'turtle', 'deer'], { stageName: NEW_TAG, stageId: 'g_new' });
  fresh.id = 'NEW-MATCH-ID';
  fresh = play(fresh, 3);
  const archive = archiveRound(fresh, archiveRound(old, null));
  const memory = rememberBattle(freshMemory(), old);
  return { archive, memory, fresh, old };
}
const markers = (blob) => [...new Set([...blob.matchAll(/(NEW|PREV)\[([^\]]+)\]/g)].map((m) => m[0]))];

test('① 新局 + 上一局都在（面板路径：宿主没给 game）⇒ 只依据当前局，回答不出现上一局内容', async () => {
  const { archive, memory, fresh } = fixture();
  const profile = newProfile();
  for (const message of ['这一手该怎么打', '现在该出什么招', '帮我复盘']) {
    // `game` 传 null = 面板/营地页那条路（旧兜底正是在这条路上取到了上一局）
    const context = buildContext(null, profile, 'fox', archive, 'g_new', message);
    assert.equal(context.matchScope, 'current', `「${message}」应当判成当前局，实际 ${context.matchScope}`);
    assert.equal(context.lastMatch?.id, fresh.id, `「${message}」依据的对局必须是当前局`);
    assert.equal(activeMatchIdOf(context), fresh.id);
    const answer = await runCoach({ message, role: 'auto', context: JSON.parse(JSON.stringify(context)), memory, conversation: [] });
    const seen = markers(JSON.stringify({ text: answer?.text, evidence: answer?.evidence }));
    assert.ok(!seen.some((m) => m.startsWith('PREV[')), `「${message}」的回答里不许出现上一局内容：${seen.join('、')}`);
  }
});

test('② 无当前局 + 有上一局 ⇒ 允许回落，但判定必须标成 previous（正文标注在第 2 步落地）', async () => {
  const { archive, memory } = fixture();
  const profile = newProfile();
  const noCurrent = { version: archive.version, lastTurn: archive.lastTurn, stage: archive.stage,
    current: { ...archive.current, result: 'loss' }, completed: archive.completed };
  const context = buildContext(null, profile, 'fox', noCurrent, 'g_new', '上一局打得怎么样');
  assert.equal(context.matchScope, 'previous', '没有当前局时回落上一局，且必须标成 previous');
  assert.equal(context.lastMatch?.id, 'PREV-MATCH-ID');
  assert.equal(readsAsPreviousMatch(context), true, '下游据此显式标注「这是上一局」');
  // 反向：有当前局时**不许**标成 previous
  const withCurrent = buildContext(null, profile, 'fox', archive, 'g_new', '这一手该怎么打');
  assert.equal(readsAsPreviousMatch(withCurrent), false);
});

test('④ `roco_battle` 有值 ⇒ 也算"当前局存在"（Codex 报的第二条入口）', () => {
  // 面板路径：`buildContext` 拿不到 game、archive 里也没有 current ⇒ matchScope 会是 previous；
  // 但客户端把实时局面放在 `context.roco_battle` 里加进来（turn=1）⇒ **它本身就是当前局存在的证据**。
  const context = {
    matchScope: 'previous',
    lastMatch: { id: 'PREV-MATCH-ID' },
    roco_battle: { turn: 1, state_version: 0, result: null },
  };
  assert.equal(effectiveMatchScope(context), 'current', 'roco_battle 有值 ⇒ 作用域必须是 current');
  assert.equal(readsAsPreviousMatch(context), false, '有实时局面时不许标成"上一局"');
  assert.equal(activeMatchIdOf(context), 'PREV-MATCH-ID', 'id 取不到就沿用 lastMatch 的 id（不再判成上一局）');
  // 负载层：当前局作用域 + 非复盘问句 ⇒ 上一局的整段记录不许进模型负载
  const payload = { message: '现在该出什么招', context: { ...context, evidenceIndex: [] }, memory: { journal: [] }, conversation: [] };
  const notReview = assembleContext(payload);
  assert.equal('lastMatch' in notReview.payload.context, false, '非复盘问句里不许带上一局的记录');
  // 但"复盘刚打完的当前局"要留着（这正是当前局优先的用处）
  const review = assembleContext({ ...payload, message: '帮我复盘这一局' });
  assert.ok('lastMatch' in review.payload.context, '复盘当前局时记录要留着');
});

test('③ 非恒真：判定在四种配置上各给唯一结果（不是"总能过"）', () => {
  const live = { id: 'LIVE', history: [{ type: 'turn' }], result: null };
  const ended = { id: 'ENDED', history: [{ type: 'turn' }], result: 'loss' };
  const archive = { current: ended, completed: [{ id: 'PREV', history: [{ type: 'turn' }], result: 'loss' }] };
  // ① 当前局（live）优先，即使 archive 里也有上一局
  assert.deepEqual(activeMatchOf({ game: live, archive, message: '现在该出什么招' }), { scope: 'current', match: live, id: 'LIVE' });
  // ② 宿主没给 game：archive.current 就是当前局（**这是本次修的根因**）
  assert.deepEqual(activeMatchOf({ game: null, archive, message: '现在该出什么招' }), { scope: 'current', match: ended, id: 'ENDED' });
  // ③ 显式问上一局 ⇒ 允许 previous
  assert.deepEqual(activeMatchOf({ game: live, archive, message: '上一局打得怎么样' }), { scope: 'previous', match: archive.completed[0], id: 'PREV' });
  // ④ 什么都没有 ⇒ null（不猜）
  assert.deepEqual(activeMatchOf({ game: null, archive: null, message: '现在该出什么招' }), { scope: null, match: null, id: null });
  // `activeMatchIdOf` 对老形状（只有 battle/lastMatch）也要给出当前优先的答案
  assert.equal(activeMatchIdOf({ battle: { id: 'B' }, lastMatch: { id: 'PREV' } }), 'B');
  assert.equal(activeMatchIdOf({ lastMatch: { id: 'PREV' } }), 'PREV');
  assert.equal(activeMatchIdOf({}), null);
});
