// 「这一页名单是什么、总共有多少」进教练上下文的判据（2026-09-25）。
//
// 背景（改前真机实测）：页面只送候选池**前 12 条**，于是
//   「我一共有多少只精灵？」→「**你名下有 12 只精灵。**」
//   「我都有哪些精灵？列一下。」→ 把那 12 条列成"你的精灵"
// 而那 12 条其实是**候选池的第 1 页**（图鉴 622 条分页），页面明明知道真实总数
// （`state.pool.total` / `state.rosterTotal`）。这是一句听起来很确定的错话。
//
// 判据：
//   ① 校验（加性）：合法概况放行；畸形逐条 400「名单概况无效」。
//   ② 进包：`profile.pool_summary` ⇒ `packet.poolSummary` 原样；不带时不出现。
//   ③ **一页说明**：只在「总数 > 本页条数」时出现，且**带上真实总数**（数字来自页面，不是结论），
//      但**不许含任何结论词**（建议/推荐/应该/最好）—— 说明只讲"这份名单是什么"。
//   ④ 名单就是全部时**不许**出现这条说明（否则是在无中生有地打折扣）。
// 必红反证：把 total 改成等于本页条数，③ 必须不再出现。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {runCoach, buildContext, rosterIsPage, rosterNote} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {validateChat} from '../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');

const PETS = Array.from({length: 12}, (_, i) => ({id: `pet_${String(i + 1).padStart(6, '0')}`, name: `宠${i + 1}`}));
const SUMMARY = {total: 622, page: 1, pages: 52, source: 'catalog', roster_total: 48};

function bodyWith(summary) {
  const profile = {pets: PETS};
  if (summary !== null) profile.pool_summary = summary;
  return {message: '我一共有多少只精灵？', role: 'companion',
    context: {mode: 'camp', profile}, memory: {version: 1}};
}

test('① 加性校验：合法概况放行，畸形逐条 400', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(SUMMARY)), '合法概况必须放行');
  assert.doesNotThrow(() => validateChat(bodyWith(null)), '不带这个字段时照旧放行');
  const bad = [
    ['不是对象', 'x'],
    ['total 不是整数', {...SUMMARY, total: 1.5}],
    ['total 是负的', {...SUMMARY, total: -1}],
    ['page 不是整数', {...SUMMARY, page: '1'}],
    ['roster_total 超范围', {...SUMMARY, roster_total: 99999999}],
    ['source 太长', {...SUMMARY, source: 'x'.repeat(25)}],
    ['source 是空串', {...SUMMARY, source: ''}],
    ['all_support 不是布尔', {...SUMMARY, all_support: 'yes'}],
  ];
  for (const [why, payload] of bad) {
    assert.throws(() => validateChat(bodyWith(payload)), /名单概况无效/, `${why} 必须被拒绝`);
  }
});

test('② 进包：带概况时原样进 packet.poolSummary，不带时这个键不出现', async () => {
  let withSummary = null;
  await runCoach({
    message: '随便聊聊',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {pets: PETS, pool_summary: SUMMARY}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withSummary = packet; return '嗯。'; }},
  });
  assert.deepEqual(withSummary.poolSummary, SUMMARY, '页面给的概况必须原样进包');

  let without = null;
  await runCoach({
    message: '随便聊聊',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp', profile: {pets: PETS}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { without = packet; return '嗯。'; }},
  });
  assert.equal('poolSummary' in without, false, '没有概况时不许出现这个键');
});

test('③ 一页说明：只在「总数 > 本页条数」时出现，带真实总数、不含结论', async () => {
  assert.equal(rosterIsPage({profile: {pets: PETS, pool_summary: SUMMARY}}), true);
  const note = rosterNote({profile: {pets: PETS, pool_summary: SUMMARY}});
  assert.match(note, /622/, '说明里要有候选宇宙总数（页面给的数）');
  assert.match(note, /48/, '说明里要有玩家可用名单的总数');
  assert.match(note, /12/, '说明里要点出本页条数');
  assert.match(note, /不是玩家名下的全部/, '说明必须点破"这不是全部"');
  assert.ok(!/建议|推荐|应该|最好|更强|胜率/.test(note),
    `说明里不许出现结论词（它只讲这份名单是什么），实际：${note}`);

  let packet = null;
  await runCoach({
    // 2026-09-25 改钉（**行没删，消息换了**）：「我一共有多少只精灵？」现在由本地政策
    // `roster-count-ask` 直接作答（0 次模型调用）⇒ 假的 provider 不会被调用、`packet` 永远是 null。
    // 这一条要钉的是**名单说明会随包进模型**，所以换一句仍然走模型的问题。
    message: '接下来我该先做什么？',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {pets: PETS, pool_summary: SUMMARY}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(p) { packet = p; return '按名单说。'; }},
  });
  assert.equal((packet.evidence || []).filter((line) => /名单说明/.test(String(line))).length, 1,
    '带一页名单时必须有且只有一条名单说明');
});

test('④ 名单就是全部时不许出现这条说明（不许无中生有地打折扣）', async () => {
  const complete = {...SUMMARY, total: PETS.length, pages: 1};
  assert.equal(rosterIsPage({profile: {pets: PETS, pool_summary: complete}}), false);
  let packet = null;
  await runCoach({
    message: '接下来我该先做什么？',   // 同上：换成仍走模型的问题
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {pets: PETS, pool_summary: complete}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(p) { packet = p; return '按名单说。'; }},
  });
  assert.equal((packet.evidence || []).some((line) => /名单说明/.test(String(line))), false,
    '名单就是全部时不该出现任何"这只是一部分"的说明');
  // 连概况都没有时同样不许出现（拿不到就不解释）。
  assert.equal(rosterIsPage({profile: {pets: PETS}}), false);
});

test('⑤ 结构性：页面只送**真的有**的数，拿不到就不写这个字段', () => {
  assert.match(CLIENT_SRC, /pool_summary: poolSummary/, '页面必须把概况挂进 profile');
  assert.match(CLIENT_SRC, /Number\.isFinite\(state\.pool\.total\) \? \{total: state\.pool\.total\} : \{\}/,
    '总数只能来自页面真有的状态');
  assert.match(CLIENT_SRC, /Number\.isFinite\(state\.rosterTotal\) \? \{roster_total: state\.rosterTotal\} : \{\}/,
    '可用名单总数同理');
  assert.match(CLIENT_SRC, /Object\.keys\(poolSummary\)\.length \? \{pool_summary: poolSummary\} : \{\}/,
    '一个数都拿不到时不许挂这个字段');
});
