// 六宠战况进教练上下文的判据（2026-09-25，人类口径「agent 优先」）。
//
// 背景：打六宠对局时小芽的聊天**看不到战况** —— 上下文一直是营地那一份，
// 所以玩家问「我现在该换谁」时模型手上没有数据（`src/client/roco.js` 里那句
// 「六宠状态进模型的接线是下一件事」写的就是这件事）。本轮把它接上：
// 客户端从**引擎公开视图**裁一份 `context.roco_battle`，服务端加性校验，运行时按原样进包。
//
// 四条判据：
//   ① **透传**：运行时把 `roco_battle` 原样放进证据包（`packet.rocoBattle`）；不带时**不出现**这个键。
//   ② **加性校验**：合法形状放行；超限/缺 id/非法枚举/超长状态串一律 400，且点名「六宠战况无效」。
//   ③ **不许伪造公开面之外的东西**：对手后备只有位次与是否倒下 —— 校验层不许接受带 id 的后备条目
//      （结构上就不给那个字段），这条由 ④ 的源码断言与 ② 的"未知键"口径一起守。
//   ④ **结构性**：`/api/coach` 必须真的调用 `validateChat`；客户端必须从 `state.view` 构造并送出。
// 必红反证：把 `roco_battle` 拿掉，② 里那些畸形输入必须**不再**被这条规则拒绝
// （证明拒绝来自这一段，而不是别处的通配校验）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {runCoach, buildContext, checkGroundedAnswer} from '../src/coach/runtime.js';
import {executeTool} from '../src/coach/toolbox.js';
import {policyFor} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {validateChat} from '../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'src', 'server', 'index.js'), 'utf8');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');

/** 一份**合法**的六宠战况：形状与 `publicView` 能给出来的东西一致。 */
const SNAPSHOT = {
  turn: 3,
  phase: 'battle',
  result: null,
  self: [
    {pet_id: 'pet_000225', name: '寂灭骨龙', hp: 120, max_hp: 180, energy: 4, alive: true},
    {pet_id: 'pet_000190', name: '潮甲龟', hp: 0, max_hp: 160, energy: 0, alive: false, status: '倒下'},
  ],
  self_active: 0,
  self_energy_max: 6,
  foe: [{pet_id: 'pet_000445', name: '芽角鹿', hp: 88, max_hp: 150, energy: 2, alive: true}],
  foe_living_count: 2,
  foe_bench: [{slot: 1, fainted: false}],
  legal: [{label: '啃咬', kind: 'skill'}, {label: '换上潮甲龟', kind: 'switch'}],
};

function bodyWith(rocoBattle) {
  const context = {mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}};
  if (rocoBattle !== undefined) context.roco_battle = rocoBattle;
  return {message: '我现在该换谁？', role: 'companion', context, memory: {version: 1}};
}

test('① 透传：带 roco_battle 时原样进包，不带时这个键不出现', async () => {
  let withKey = null;
  await runCoach({
    message: '这回合怎么打',
    context: {...buildContext(createGame(), newProfile(), 'fox'), roco_battle: SNAPSHOT},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withKey = packet; return '按战况说。'; }},
  });
  assert.deepEqual(withKey.rocoBattle, SNAPSHOT, '运行时必须原样带进包，不许改写数值');

  let withoutKey = null;
  await runCoach({
    message: '这回合怎么打',
    context: buildContext(createGame(), newProfile(), 'fox'),
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withoutKey = packet; return '按战况说。'; }},
  });
  assert.equal('rocoBattle' in withoutKey, false,
    '营地/三宠那两条老路不许出现这个键（不带就不出现）');
});

test('② 加性校验：合法形状放行，畸形一律 400 并点名', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(SNAPSHOT)), '合法形状必须放行');
  assert.doesNotThrow(() => validateChat(bodyWith(undefined)), '不带这个字段时照旧放行');
  const bad = [
    ['不是对象', 'x'],
    ['turn 越界', {...SNAPSHOT, turn: 0}],
    ['phase 不认', {...SNAPSHOT, phase: 'idle'}],
    ['self 为空', {...SNAPSHOT, self: []}],
    ['self 超过 6 只', {...SNAPSHOT, self: Array.from({length: 7}, (_, i) => ({pet_id: `pet_00000${i}`, hp: 1}))}],
    ['self 缺 pet_id', {...SNAPSHOT, self: [{name: '无名', hp: 1}]}],
    ['血量不是数', {...SNAPSHOT, self: [{pet_id: 'pet_000225', hp: '很多'}]}],
    ['状态串超长', {...SNAPSHOT, self: [{pet_id: 'pet_000225', status: '异'.repeat(25)}]}],
    ['legal 超过 12 条', {...SNAPSHOT, legal: Array.from({length: 13}, () => ({label: '啃咬'}))}],
    ['legal 缺 label', {...SNAPSHOT, legal: [{kind: 'skill'}]}],
    ['对手后备超过 5 条', {...SNAPSHOT, foe_bench: Array.from({length: 6}, () => ({slot: 1}))}],
    ['self_active 越界', {...SNAPSHOT, self_active: 9}],
  ];
  for (const [why, payload] of bad) {
    assert.throws(() => validateChat(bodyWith(payload)), /六宠战况无效/,
      `${why} 必须被拒绝，且理由要点名「六宠战况无效」`);
  }
});

test('③ 老的三宠合同一个字没松（加性改动的底线）', () => {
  const base = bodyWith(undefined);
  // 三宠 battle：4 只 ⇒ 必须仍然 400（这条从 2026-09 就在，不能被我的改动带松）
  const bad = {...base, context: {...base.context}, };
  bad.context.battle = {
    player: {active: 0, pets: Array.from({length: 4}, () => ({skills: [], hp: 1, maxHp: 1, atk: 1, def: 1, speed: 1, energy: 1}))},
    enemy: {active: 0, pets: Array.from({length: 3}, () => ({skills: [], hp: 1, maxHp: 1, atk: 1, def: 1, speed: 1, energy: 1}))},
  };
  assert.throws(() => validateChat(bad), /战况无效/, '老合同必须照旧拒绝 4 只');
});

test('④ 结构性：/api/coach 真的调用校验；客户端从公开视图构造并送出', () => {
  assert.match(SERVER_SRC, /path==='\/api\/coach'\)\{\s*\n?\s*validateChat\(b\)/,
    '/api/coach 必须先调用 validateChat（否则这一段校验是死代码）');
  assert.match(CLIENT_SRC, /function coachRocoBattle\(\)/,
    '客户端必须有一个从公开视图裁战况的函数');
  assert.match(CLIENT_SRC, /const view = state\.view;/, '战况只能来自引擎公开视图 state.view');
  // 2026-09-25 追改：payload 从内联对象改成先建 context 再按需挂字段
  // （这一轮同一处要挂 `roco_plan`）。判据的**意图**不变：战况必须进 context。
  assert.match(CLIENT_SRC, /if \(rocoBattle\) context\.roco_battle = rocoBattle;/,
    '客户端必须把它送进 /api/coach 的 context');
  // 对手后备**只给位次与是否倒下**：身份字段不许凭空补出来。
  // ── 2026-09-30（分计划 02 · D-11 **改钉**）─────────────────────────────────────
  // 原断言（逐字留档在 `reports/roco/product-execution/02/test-relaxation.md`，别再写回来）：
  //     assert.ok(!/bench[\s\S]{0,120}pet_id/.test(CLIENT_SRC),
  //       '对手后备不许补 pet_id（那是公开面之外的信息）');
  // 红因（实测，不是推测）：它是**正则窗口**判据 —— 02.2 在客户端加了「对手**已亮明**的成员」
  //   那一层（数据源 `view.seen_roster`，公开事实）之后，只要 `bench` 之后 120 字符内出现
  //   任何 `pet_id`（连**注释**里那句「不从 opponent.bench 猜身份……按 pet_id 查名单」也算）
  //   就判红。它要防的是「从 `view.opponent.bench` 直取身份」，注释与已亮明那条路都不该被它误伤。
  // 新判据（**结构**，意图一条不少）：① 后备行只由 slot/fainted 构造；② 身份只许来自 seen_roster。
  const benchBuild = /const bench = \(view\.opponent\?\.bench \?\? \[\]\)\.map\(\(b\) => \(\{[\s\S]{0,220}?\}\)\);/.exec(CLIENT_SRC);
  assert.ok(benchBuild, '找不到把 opponent.bench 收成 {slot,fainted} 的那一段（后备口径要靠它钉住）');
  assert.doesNotMatch(benchBuild[0], /pet_id|name/,
    '对手后备**只给位次与是否倒下**：构造里不许出现 pet_id / name');
  assert.match(CLIENT_SRC, /openingPreviewRows|seen_roster/,
    '已亮明的身份只能来自 view.seen_roster（引擎折出来的公开事实），不许从 opponent.bench 直取');
});

test('必红反证：拿掉 roco_battle，② 里那些畸形输入不再被这条规则拒绝', () => {
  // 同一个畸形体（turn=0）在**没有** roco_battle 时不会被这段规则拒绝 ——
  // 证明 ② 的拒绝确实来自六宠战况这一段，而不是别处的通配校验。
  const payload = bodyWith(undefined);
  payload.context.roco_battle = undefined;
  assert.doesNotThrow(() => validateChat(payload));
  const mutated = {...SNAPSHOT, turn: 0};
  assert.throws(() => validateChat(bodyWith(mutated)), /六宠战况无效/,
    '带上畸形战况时必须红 —— 这正是 ② 量到的东西');
});

test('⑥ 事实守卫必须认得战况里的数字（否则引用真数据会被判成凭空）', () => {
  // 实测踩到的坑（2026-09-25）：接上战况后问「我场上还剩多少血」，
  // 模型引用的**真实战况数字**被判 `unsupported-number:120/180/4/6` ⇒ 硬回退成模板「我在。」，
  // 比不带战况还差。根因：`checkGroundedAnswer` 的可追溯数字集合里没有这个新字段。
  const answer = {
    text: '寂灭骨龙 120/180 血、4 能量；潮甲龟已倒；芽角鹿 88 血。',
    evidence: [], toolTrace: [], publicState: null, latestEvents: [], textFacts: null,
  };
  const without = checkGroundedAnswer({...answer});
  assert.equal(without.valid, false, '不带战况时这些数字必须判成凭空（这是守卫的原有职责）');
  assert.ok(without.reasons.some((r) => r.startsWith('unsupported-number:120')),
    `理由要点名数字，实际：${JSON.stringify(without.reasons)}`);
  const withBattle = checkGroundedAnswer({...answer, rocoBattle: SNAPSHOT});
  assert.equal(withBattle.valid, true,
    `带上战况后，战况里的数字必须可追溯，实际理由：${JSON.stringify(withBattle.reasons)}`);
});

// ── 六宠链要"分支模拟"时，回执必须说**具体**的实话（第 42 轮实测）──────────────────────
// 实测现场：玩家**正在打**六宠对局，问「现在该防御还是出招？」⇒ 工具调了 `simulate_branch`，
// 回执却是「**当前没有进行中的对局**，无法模拟」—— 那一刻这句话是**假话**。真因是：分支模拟
// 要的是服务端进程里那一局（`context.battle`），而六宠链只有公开快照。接会话读口是下一件事，
// 在那之前回执要把"能算什么、不能算什么"讲清楚，模型才不会拿快照假装模拟过。
test('③ 六宠快照下的分支模拟：回执要说清"要服务端会话"，不许说"没有进行中的对局"', async () => {
  const snapshot = {turn: 3, phase: 'battle', state_version: 1, self_active: 0,
    self: [{pet_id: 'pet_000118', name: '皇家狮鹫', hp: 88, max_hp: 107, energy: 6, alive: true}],
    foe: [{pet_id: 'pet_000445', name: '芽角鹿', hp: 120, max_hp: 150, energy: 3, alive: true}],
    legal: [{kind: 'skill', label: '风刃', skill_id: 'skill_000001'}]};
  const receipt = await executeTool('simulate_branch', {candidates: ['skill_000001'], unresolved: []},
    {mode: 'pvp-local', battle: null, roco_battle: snapshot});
  assert.equal(receipt.missing, true, '这一条现在确实算不了，要如实标 missing');
  assert.match(String(receipt.reason), /服务端.*会话/, `要指出缺的是服务端会话：${receipt.reason}`);
  assert.doesNotMatch(String(receipt.reason), /当前没有进行中的对局/,
    '玩家正在打的时候不许说"没有进行中的对局"（那是假话）');
  assert.ok(Array.isArray(receipt.available) && receipt.available.length, '要写清**能**算什么（快照里的引擎事实）');
  assert.ok(Array.isArray(receipt.unavailable) && receipt.unavailable.length, '要写清**不能**算什么');
  // 反证：真的没有对局（营地页）时，老句子一个字不变
  const none = await executeTool('simulate_branch', {candidates: [], unresolved: ['未识别的动作']},
    {mode: 'camp', battle: null});
  assert.match(String(none.reason), /当前没有进行中的对局/, '营地那条老路不许被这次改动波及');
});

// ── 六宠链的"两种走法结果"：服务端会话读口（2026-09-26 接上）──────────────────────────
// 真机实测（第 42 轮）：玩家正在打六宠对局时，`simulate_branch` 回的是「当前没有进行中的对局」
// —— 假话。真因是模拟要服务端那一局，而快照只有公开面。接法：客户端快照带**对局编号**，
// 服务端把「按编号取引擎估值」注入上下文，工具在六宠上下文里改走它。
test('⑤ 六宠快照带对局编号 ⇒ 工具回执是**引擎**算的走法结果（含反证：没编号时说清算不了）', async () => {
  const asked = [];
  const context = {mode: 'pvp-local', battle: null, turn: 3,
    roco_battle: {turn: 3, phase: 'battle', battle_id: 's1-abc',
      self: [{pet_id: 'pet_000118', name: '皇家狮鹫', hp: 88, max_hp: 107, energy: 6, alive: true}],
      foe: [{pet_id: 'pet_000445', name: '芽角鹿', hp: 120, max_hp: 150, energy: 3, alive: true}],
      legal: [{kind: 'skill', label: '风刃', skill_id: 'skill_000001'}]},
    rocoPreview: async (battleId) => {
      asked.push(battleId);
      return {ok: true, battle_id: battleId, state_version: 7, recommendation: '风刃', recommendation_stable: true,
        expected: {min: 0.6, max: 0.6, mean: 0.6}, worst: {min: 0.4, max: 0.4}, main_counter: '换上第3位',
        first_second_margin: 0.0449,
        damage_preview: {available: true, min: 130, max: 469, lethal: false, formula_verified: false},
        risk: {downside_min: 0, downside_max: 0.21, fragile: false},
        note: '推荐来自公开信息 + 固定分析种子集合的跨种子聚合；真实对局 seed 没有参与。'};
    }};
  const receipt = await executeTool('simulate_branch', {candidates: ['skill_000001'], unresolved: []}, context);
  assert.deepEqual(asked, ['s1-abc'], '要按**快照里的对局编号**去查服务端会话');
  assert.equal(receipt.engine, 'six-pet-rules');
  assert.equal(receipt.recommendation, '风刃');
  assert.deepEqual(receipt.damage_preview, {available: true, min: 130, max: 469, lethal: false, formula_verified: false});
  assert.equal(receipt.first_second_margin, 0.0449, '第一二名差距要透传（判定层要用它）');
  assert.match(String(receipt.assumption), /不是胜率|估值/, '必须写明这是估值、不是胜率');
  // 反证：没有编号时**不许**假装算过，要说清"要服务端会话"
  const without = await executeTool('simulate_branch', {candidates: ['skill_000001'], unresolved: []},
    {...context, roco_battle: {...context.roco_battle, battle_id: undefined}, rocoPreview: undefined});
  assert.equal(without.missing, true);
  assert.match(String(without.reason), /服务端.*会话/);
  assert.doesNotMatch(String(without.reason), /当前没有进行中的对局/, '玩家正在打时那句是假话');
});

test('⑥ 六宠对局里的建议问句**强制**先取引擎估值；没有编号或线上竞技时不许强制', () => {
  const snapshot = (extra) => ({mode: 'pvp-local', battle: null,
    roco_battle: {turn: 3, phase: 'battle', battle_id: 's1-abc',
      self: [{pet_id: 'pet_000118', name: '皇家狮鹫', hp: 88, max_hp: 107, energy: 6, alive: true}],
      foe: [{pet_id: 'pet_000445', name: '芽角鹿', hp: 120, max_hp: 150, energy: 3, alive: true}], ...extra}});
  for (const q of ['这回合该怎么打？', '现在该防御还是出招？', '这回合该不该换宠？']) {
    assert.equal(policyFor(q, snapshot()).need, 'simulate_branch', `「${q}」要强制取引擎估值`);
  }
  // 反证 ①：快照**没有对局编号** ⇒ 不许强制（没有会话可取，硬发一枪只会拿到"算不了"）
  const noId = policyFor('这回合该怎么打？', snapshot({battle_id: undefined}));
  assert.notEqual(noId.need, 'simulate_branch', '没有编号时不许强制查会话');
  // 反证 ②：**线上竞技**不许走这条路（公平性：赛中的婉拒在 runtime.js:1151，这里再挡一道）
  const live = policyFor('这回合该怎么打？', {...snapshot(), mode: 'pvp-live'});
  assert.notEqual(live.reason, 'roco-battle-advice', '线上竞技不许被这条政策接管');
  // 反证 ③：跟建议无关的问句不许被抢走
  assert.notEqual(policyFor('应对是什么意思？', snapshot()).reason, 'roco-battle-advice');
});

test('⑦ 对局编号的边界：合法字符串放行，畸形一律 400', () => {
  const withId = (battle_id) => ({message: '这回合该怎么打？', role: 'companion',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]},
      roco_battle: {...SNAPSHOT, battle_id}}, memory: {version: 1}});
  assert.doesNotThrow(() => validateChat(withId('s1-abc')), '合法编号必须放行');
  assert.doesNotThrow(() => validateChat(withId(undefined)), '不带编号照旧放行');
  for (const bad of [42, '', 'x'.repeat(65), null, {}]) {
    assert.throws(() => validateChat(withId(bad)), /battle_id/, `${JSON.stringify(bad)} 必须在边界被 400`);
  }
});

test('⑧ 结构性：客户端快照真的带编号、服务端真的注入读口、工具真的用它', () => {
  const client = readFileSync(join(ROOT, 'src/client/roco.js'), 'utf8');
  assert.match(client, /state\.battleId/, '客户端要有对局编号');
  assert.match(client, /battle_id: state\.battleId/, '快照要把编号带给教练');
  const server = readFileSync(join(ROOT, 'src/server/index.js'), 'utf8');
  assert.match(server, /const rocoPreview=async\(battleId\)/, '服务端要注入按编号取估值的读口');
  // ⚠ 2026-09-27 改钉：这一行现在还顺带把**个体层**（每只的天分/性格）补进上下文
  //（`attachIndividualsToContext`，只补字段不改判断），所以形状从 `{...b.context,rocoPreview}`
  // 变成 `{...attachIndividualsToContext(b.context),rocoPreview}`。
  // **判据的意图一个字没变**：注入必须真的合成"这一次请求的上下文"，而不是挂在别的对象上 ——
  // 所以这里改成允许前面套一层补字段的调用，但**要求 `b.context` 仍然是基底**。
  assert.match(server, /const coachedContext=\{\.\.\.(?:attachIndividualsToContext\(b\.context\)|b\.context),rocoPreview\}/,
    '注入要真的合成这次上下文（可以套补字段，但基底必须是 b.context）');
  assert.match(server, /attachIndividualsToContext\(b\.context\)/, '个体层要接在这一条链上');
  assert.match(server, /context:coachedContext/, 'runCoach 要拿到注入了读口的那一份');
  const toolbox = readFileSync(join(ROOT, 'src/coach/toolbox.js'), 'utf8');
  assert.match(toolbox, /context\.rocoPreview\(battleId\)/, '工具要真的调用它');
});
