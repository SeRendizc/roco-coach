// 「玩家当前选的那六只」进教练上下文的判据（2026-09-25）。
//
// 背景：`coachCampContext()` 送的 `profile.pets` 是**候选池前 12 只**，不是"你选的这六只"。
// 所以「我这队都有谁」「我这队属性怎么样」这类问题，模型看到的是一堆不相干的候选。
// 这一轮把工作台**公开层**的六槽（名字/系别）作为 `profile.lineup` 送上去。
//
// 判据：
//   ① 校验（加性）：合法形状放行；空数组/超过 6 条/既无 id 又无 name/types 畸形 ⇒ 400。
//   ② 进包：`context.profile.lineup` ⇒ `packet.lineup` 原样；不带时**不出现**这个键。
//   ③ 结构性：页面只从**工作台回执的公开层** `player.slots` 取、只取 `filled` 槽位、
//      公开层没有 id 就不写 id（判据钉住这三条，防止有人"顺手"去 dev 段拿 id）。
// 必红反证：不带 lineup 时 ② 的键必须不存在，且 ① 的畸形输入不再被这条规则拒绝。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {checkGroundedAnswer, runCoach, buildContext} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {validateChat} from '../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');

const LINEUP = [
  {name: '铠甲虫', types: ['虫系']},
  {name: '雷震娃娃', types: ['冰系', '幽系']},
  {name: '皇家狮鹫', types: ['翼系']},
];
const PROFILE = {pets: [{id: 'pet_000001', name: '喵喵', types: ['草系']}]};

function bodyWith(lineup) {
  const profile = {...PROFILE};
  if (lineup !== undefined) profile.lineup = lineup;
  return {message: '我这六只都有谁？', role: 'companion',
    context: {mode: 'camp', profile}, memory: {version: 1}};
}

test('① 加性校验：合法形状放行，畸形一律 400 并点名', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(LINEUP)), '只有名字也要放行（公开层不给 id）');
  assert.doesNotThrow(() => validateChat(bodyWith([{id: 'pet_000001', name: '喵喵', types: ['草系']}])));
  assert.doesNotThrow(() => validateChat(bodyWith(undefined)), '不带这个字段时照旧放行');
  const bad = [
    ['不是数组', {name: '喵喵'}],
    ['空数组', []],
    ['超过 6 条', Array.from({length: 7}, (_, i) => ({name: `宠${i}`}))],
    ['既无 id 又无 name', [{types: ['草系']}]],
    ['name 不是字符串', [{name: 123}]],
    ['name 超长', [{name: '很'.repeat(25)}]],
    ['types 超过 2 个', [{name: '喵喵', types: ['草系', '水系', '火系']}]],
    ['types 里有空串', [{name: '喵喵', types: ['']}]],
    ['id 不是字符串', [{id: 7, name: '喵喵'}]],
  ];
  for (const [why, payload] of bad) {
    assert.throws(() => validateChat(bodyWith(payload)), /阵容名单无效/, `${why} 必须被拒绝`);
  }
});

test('② 进包：带 lineup 时原样进 packet.lineup，不带时这个键不出现', async () => {
  let withLineup = null;
  await runCoach({
    message: '随便聊聊',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp', profile: {...PROFILE, lineup: LINEUP}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withLineup = packet; return '嗯。'; }},
  });
  assert.deepEqual(withLineup.lineup, LINEUP, '工作台公开层的六槽必须原样进包');

  let without = null;
  await runCoach({
    message: '随便聊聊',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp', profile: PROFILE},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { without = packet; return '嗯。'; }},
  });
  assert.equal('lineup' in without, false, '没选过队伍时不许出现这个键');
});

test('③ 结构性：页面只从工作台公开层取、只取 filled、不越层拿 id', () => {
  assert.match(CLIENT_SRC, /function coachLineup\(\)/, '客户端必须有一个独立的六槽构造函数');
  assert.match(CLIENT_SRC, /state\.teamWorkshop\?\.payload\?\.player\?\.slots/,
    '六槽只能来自工作台回执的公开层 player.slots');
  assert.match(CLIENT_SRC, /slot\?\.state === 'filled'/, '只取 filled 槽位（空槽不是"你选的"）');
  assert.match(CLIENT_SRC, /\.\.\.\(lineup \? \{lineup\} : \{\}\)/, '没选过队伍时不加这个键');
  // 公开层没有 id：源码里不许出现从 dev 段取 id 的写法。
  assert.ok(!/coachLineup[\s\S]{0,400}dev/.test(CLIENT_SRC),
    '六槽构造函数不许去 dev 段拿 id（那是越层）');
});

test('④ 六维进包（2026-09-25）：页面把引擎的 stats 带给教练，玩家问"谁最快"才答得出来', () => {
  // 由来：真机实测「我这六只谁速度最快？」→「我手头没有这六只的速度数值」，
  // 而引擎**早就把六维发给页面了**（`/api/roco/pool` 每行带 stats）。六个数字共 273 字节。
  const WITH_STATS = [
    {id: 'pet_000062', name: '音速犬', types: ['翼系'], stats: {hp: 85, atk: 116, def: 70, spa: 60, spd: 70, spe: 120}},
    {id: 'pet_000118', name: '皇家狮鹫', types: ['翼系'], stats: {hp: 107, atk: 116, def: 80, spa: 60, spd: 70, spe: 120}},
    {id: 'pet_000012', name: '铠甲虫', types: ['虫系'], stats: {hp: 132, atk: 95, def: 128, spa: 43, spd: 82, spe: 75}},
  ];
  assert.doesNotThrow(() => validateChat(bodyWith(WITH_STATS)), '带六维要放行');
  assert.doesNotThrow(() => validateChat(bodyWith([{name: '音速犬'}])), '不带六维照旧放行（加性）');
  const bad = [
    ['多一个键', [{name: '音速犬', stats: {hp: 85, atk: 1, def: 1, spa: 1, spd: 1, spe: 1, extra: 1}}]],
    ['值不是有限数', [{name: '音速犬', stats: {hp: '85'}}]],
    ['负数', [{name: '音速犬', stats: {hp: -1}}]],
    ['不是对象', [{name: '音速犬', stats: []}]],
  ];
  for (const [why, payload] of bad) {
    assert.throws(() => validateChat(bodyWith(payload)), /阵容名单无效/, `${why} 必须被拒绝`);
  }
  // 进包 + **守卫认得这些数字**（否则引用了真数据反而被判成凭空）
  let packet = null;
  return runCoach({
    message: '我这六只谁速度最快？',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp',
      profile: {...PROFILE, lineup: WITH_STATS}},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(p) { packet = p; return '音速犬和皇家狮鹫并列最快，都是 120。'; }},
  }).then(() => {
    assert.deepEqual(packet.lineup, WITH_STATS, '六维必须原样进包');
    const result = checkGroundedAnswer({...packet, text: '音速犬和皇家狮鹫并列最快，都是 120。'});
    assert.equal(result.valid, true, `包里的六维必须可追溯：${result.reasons.join(',')}`);
    // 反证：包里没有的数字仍然判凭空（别把这条放松成"什么都行"）
    const bogus = checkGroundedAnswer({...packet, text: '音速犬速度是 999。'});
    assert.equal(bogus.valid, false, '包里没有的数值必须照旧判凭空');
  });
});

test('⑤ 结构性：客户端只从页面留着的名单行取六维，且六个键齐全才带', () => {
  assert.match(CLIENT_SRC, /const LINEUP_STAT_KEYS = \['hp', 'atk', 'def', 'spa', 'spd', 'spe'\]/,
    '六维键必须是白名单（引擎 roster 回执就这六个）');
  assert.match(CLIENT_SRC, /function rosterRowByName\(name\)/, '必须有一个"按名字找唯一那一行"的函数');
  assert.match(CLIENT_SRC, /ids\.size === 1 \? rows\[0\] : null/, '重名必须返回 null（不猜）');
  assert.match(CLIENT_SRC, /Object\.keys\(out\)\.length === LINEUP_STAT_KEYS\.length \? out : null/,
    '六个键必须齐全才带（缺一个就不带，不许半真半假）');
  assert.match(CLIENT_SRC, /\.\.\.\(stats \? \{stats\} : \{\}\)/, '六维要进 lineup 的每一条');
  // 反证：把探测器对准"没有这段"的源码必须为假
  const probe = (src) => /function rosterRowByName\(name\)/.test(src);
  assert.equal(probe('const x = 1;'), false, '探测器本身必须能红');
  assert.equal(probe(CLIENT_SRC), true);
});

test('必红反证：不带 lineup 时畸形的 lineup 不再被这条规则拒绝', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(undefined)), '不带就没有这条规则');
  assert.throws(() => validateChat(bodyWith([])), /阵容名单无效/, '带上空数组时必须红');
});
