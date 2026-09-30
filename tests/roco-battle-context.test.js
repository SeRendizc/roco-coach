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
import {incomingAffinity} from '../src/client/type-affinity.js';
import {rocoAdviceAsk, battleAdvice, battleAdviceText} from '../src/coach/coach-advice.js';

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
  // ⚠ 2026-10-01 改钉（Lead 授权；**原断言逐字留档**，别再改回来）：
  //     assert.match(server, /const coachedContext=\{\.\.\.(?:attachIndividualsToContext\(b\.context\)|b\.context),rocoPreview\}/,
  //       '注入要真的合成这次上下文（可以套补字段，但基底必须是 b.context）');
  // 为什么改：`1af54e2`（04.3b 收尾）把 `rocoActionView` 也加进了这个对象字面量 ⇒ 它从
  //   **单行**变成**跨行 + 多一个键**（`...(rocoActionView?{rocoActionView}:{})`），旧正则只认单行形状 ⇒ 红。
  // **意图一个字没改**：基底必须仍是 `b.context`（可套补字段），且必须注入 `rocoPreview`；
  //   后面**允许**再有加性键（新注入只能加，不许把基底换掉）。
  // 反证见下：删掉 `rocoPreview` / 把基底换掉 ⇒ 必红（`p44-mut` 的 M18/M19 实测过）。
  assert.match(server, /const coachedContext=\{\.\.\.(?:attachIndividualsToContext\(b\.context\)|b\.context),\s*rocoPreview[\s\S]{0,240}?\};/,
    '注入要真的合成这次上下文（可以套补字段，但基底必须是 b.context；加性键允许跟在 rocoPreview 之后）');
  // 探测器反向自证：缺 `rocoPreview`、或基底不是 `b.context` ⇒ 同一条正则必须**不**匹配。
  const coachedContextLiteral = (text) => new RegExp(
    /const coachedContext=\{\.\.\.(?:attachIndividualsToContext\(b\.context\)|b\.context),\s*rocoPreview[\s\S]{0,240}?\};/
      .source).test(text);
  assert.equal(coachedContextLiteral('const coachedContext={...b.context,rocoActionView};'), false,
    '缺 rocoPreview 必须判为不匹配（否则这条判据只是"有没有这个字面量"）');
  assert.equal(coachedContextLiteral('const coachedContext={...otherThing,rocoPreview};'), false,
    '基底不是 b.context 必须判为不匹配');
  assert.equal(coachedContextLiteral('const coachedContext={...b.context,rocoPreview, ...extra};'), true,
    '加性键跟在后面是允许的（04.3b 的 rocoActionView 就是这一类）');
  assert.match(server, /attachIndividualsToContext\(b\.context\)/, '个体层要接在这一条链上');
  assert.match(server, /context:coachedContext/, 'runCoach 要拿到注入了读口的那一份');
  const toolbox = readFileSync(join(ROOT, 'src/coach/toolbox.js'), 'utf8');
  assert.match(toolbox, /context\.rocoPreview\(battleId\)/, '工具要真的调用它');
});

// ── P1-A 附带项（**潜在健壮性**，不是 P1-A 的成因）：**战况更新只许一种写法** ────────────
// 现场：同一个语义「用响应里的 view 更新 state.view」在客户端有两份实现 ——
//   `:3591` 有条件（响应不带 view ⇒ 保留旧局面）；`applyResult` 里原来**无条件**。
// 两份写法不一致就是隐患：一旦守卫被挪走，`view:null` 的响应会把**活着的局面**清掉。
// ⚠⚠ **它已经被真机证据排除为 P1-A 的成因**（Codex 在隔离实例 8877 的只读探针：`battle/new` 回
//   `viewType=object`、turn=1，局内画面正常，两个真实 UI 请求里 `battle=null` 而 `roco_battle` 有值
//   ⇒ 不是 state.view 丢失；O-59）。所以这条判据守的是**口径统一**（潜在健壮性），**不是** P1-A 的守卫。
// 现状复核（写进注释，免得后人误读）：今天那一行**到不了 null** —— `b3RejectGuard()` 先 return 并保留旧局面。
test('⑨ 结构性：`state.view` 只许被条件式覆盖（响应不带 view ⇒ 保留当前局面）', () => {
  // ⚠ 先剥注释再扫：这条判据的说明里逐字提到了旧写法，不剥就会先匹配到注释（把留档当成代码；
  //   `plan02-front` 在 2026-10-01 05:1x 正是这样看到一次假阳性 —— 那次是修之前的版本）。
  const client = readFileSync(join(ROOT, 'src/client/roco.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const scanner = (text) => text.split('\n').map((line, index) => ({line: line.trim(), no: index + 1}))
    .filter((row) => /state\.view\s*=\s*data\??\.view\s*;/.test(row.line))
    .filter((row) => !/^if\s*\(/.test(row.line) && !/data\?\.view\)\s*state\.view/.test(row.line));
  const assignments = client.split('\n').map((line, index) => ({line: line.trim(), no: index + 1}))
    .filter((row) => /state\.view\s*=\s*data\??\.view\s*;/.test(row.line));
  assert.ok(assignments.length >= 2, `要能找到那两处赋值（实际 ${assignments.length} 处）：${JSON.stringify(assignments)}`);
  assert.deepEqual(scanner(client), [],
    `state.view 的覆盖必须带条件（否则 view:null 会把活着的局面清掉）：${JSON.stringify(scanner(client))}`);
  assert.match(client, /if \(data\?\.view\) state\.view = data\.view;/,
    '两处写法必须统一成同一句（改回无条件 ⇒ 这条红）');
  // 反证：探测器对"无条件"那种写法必须为真（否则上面那条是恒真的）
  assert.deepEqual(scanner('  state.view = data.view;'), [{line: 'state.view = data.view;', no: 1}],
    '探测器本身必须能红');
  assert.deepEqual(scanner('  if (data?.view) state.view = data.view;'), []);
});

// ── B3（2026-10-01）：承伤相性的**上传读数** ────────────────────────────────────
// 现场：玩家六宠局里问「喵喵光系承伤 0.5 与缇塔 1 怎么比」，模型照实引用 `0.5`，而 `0.5` 不在证据包里
// ⇒ 守卫判 `ungrounded` ⇒ 回退正文 ⇒ **玩家问的那个数永远答不上**（机制实测见下 ⑤）。
// 修法：页面把**已经算好并渲染**的承伤相性作为**带来源的公开读数**上传；服务端**只校验形状不重算**。
const AFF_VIEW = {
  self: {active: 0, pets: [
    {pet_id: 'pet_000001', name: '喵喵', types: ['草系']},
    {pet_id: 'pet_000417', name: '缇塔', types: ['光系']},
    {pet_id: 'pet_000190', name: '潮甲龟', types: []}]},          // 无属性 ⇒ 必须进 unavailable
  // 对手**两个属性**（各当一次攻击系）⇒ `worst` 与 `best` 是两格不同的值：
  // 这样「取 worst」才可判 —— 单属性时 worst===best，改坏了也看不出来（变异 M23 就是靠这条抓的）。
  opponent: {field: {types: ['火系', '水系']}},
};
/** 从 `roco.js` 源码里把那个自包含纯函数抠出来（与 `roco-page-ux` 的抽法同一条）。 */
function extractAffinityReader() {
  const src = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');
  const start = src.indexOf('function affinityReadingsOf(');
  assert.ok(start >= 0, 'roco.js 里找不到 `affinityReadingsOf`（改名/删除 ⇒ 这条判据已失效）');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return new Function(`return (${src.slice(start, i + 1)})`)(); }
  }
  throw new Error('affinityReadingsOf 的大括号没有配平');
}

test('⑩ B3①：页面读数 = 在场 + 候选，且倍率与渲染**同源**（同一个 incomingAffinity、同一组输入）', () => {
  const read = extractAffinityReader();
  const out = read(AFF_VIEW, incomingAffinity, 'roco-world-s4-2026-09-10');
  assert.ok(out, '有战况就必须产出读数');
  assert.equal(out.source, 'src/client/type-affinity.data.js@roco-world-s4-2026-09-10', '要带来源');
  assert.deepEqual(out.vs_types, ['火系', '水系'], '对手场上属性（公开）');
  assert.deepEqual(out.rows.map((r) => r.pet_id), ['pet_000001', 'pet_000417'], '在场那只在前，候选在后');
  // 同源：每一行的倍率必须等于**直接调那一个函数**的结果（页面不复算、判据也不另算一份口径）
  for (const row of out.rows) {
    const pet = AFF_VIEW.self.pets.find((p) => p.pet_id === row.pet_id);
    const want = incomingAffinity(pet.types, AFF_VIEW.opponent.field.types);
    assert.equal(row.known, true);
    assert.equal(row.multiplier, want.worst.multiplier, `${row.pet_id} 的倍率必须来自 incomingAffinity`);
    assert.equal(row.vs_type, want.worst.attackType);
  }
});

test('⑩ B3②：`known:false` 不许给数字，必须逐条进 `unavailable` 并写明理由', () => {
  const read = extractAffinityReader();
  const out = read(AFF_VIEW, incomingAffinity, 'x');
  const ids = out.rows.map((r) => r.pet_id);
  assert.ok(!ids.includes('pet_000190'), '没有属性数据的那一只不许出现在 rows 里');
  const row = out.unavailable.find((r) => r.pet_id === 'pet_000190');
  assert.ok(row, '必须进 unavailable（不许静默省略）');
  assert.ok(row.reason.length > 0 && row.reason.length <= 60, `理由要写清且不超长：${row.reason}`);
  assert.equal(Object.hasOwn(row, 'multiplier'), false, 'unavailable 里不许带数字');
  // 反证：把「没有属性」换成「有属性」⇒ 它必须回到 rows（证明上面不是恒真）
  const fixed = {...AFF_VIEW, self: {...AFF_VIEW.self,
    pets: AFF_VIEW.self.pets.map((p) => (p.pet_id === 'pet_000190' ? {...p, types: ['水系']} : p))}};
  const outs = read(fixed, incomingAffinity, 'x');
  assert.ok(outs.rows.some((r) => r.pet_id === 'pet_000190'), '有属性之后必须回到 rows');
  assert.deepEqual(outs.unavailable, [], '没有读不到的就该空');
});

test('⑩ B3③：服务端**只校验形状**且 fail closed（known:false 带数字 / 缺 unavailable / 越界 一律 400）', () => {
  const ok = {...SNAPSHOT, affinity: {source: 'src/client/type-affinity.data.js@x', vs_types: ['火系'],
    rows: [{pet_id: 'pet_000225', multiplier: 0.5, known: true, vs_type: '火系'}], unavailable: []}};
  assert.doesNotThrow(() => validateChat(bodyWith(ok)), '合法读数必须放行');
  // `known:false` 那一只走 unavailable（合法的第二种形态）
  assert.doesNotThrow(() => validateChat(bodyWith({...SNAPSHOT, affinity: {
    source: 's', rows: [], unavailable: [{pet_id: 'pet_000225', reason: '组合没登记'}]}})));
  const bad = [
    ['不是对象', 'x'],
    ['source 空', {source: '', rows: []}],
    ['rows 超 6', {source: 's', rows: Array.from({length: 7}, (_, i) => ({pet_id: `p${i}`, multiplier: 1, known: true}))}],
    ['known 不是布尔', {source: 's', rows: [{pet_id: 'p', multiplier: 1, known: 'yes'}]}],
    ['known=true 却没有 multiplier', {source: 's', rows: [{pet_id: 'p', known: true}]}],
    ['multiplier 越界', {source: 's', rows: [{pet_id: 'p', multiplier: 9, known: true}]}],
    ['known=false 却带 multiplier', {source: 's', rows: [{pet_id: 'p', multiplier: 0, known: false}],
      unavailable: [{pet_id: 'p', reason: '读不到'}]}],
    ['known=false 没进 unavailable', {source: 's', rows: [{pet_id: 'p', known: false}], unavailable: []}],
    ['unavailable 缺 reason', {source: 's', rows: [], unavailable: [{pet_id: 'p'}]}],
  ];
  for (const [why, affinity] of bad) {
    assert.throws(() => validateChat(bodyWith({...SNAPSHOT, affinity})), /六宠战况无效/,
      `${why} 必须被拒（形状校验 fail closed）`);
  }
});

test('⑩ B3④：加性红线 —— 不带 `affinity` 时与改动前完全一样', () => {
  assert.doesNotThrow(() => validateChat(bodyWith(SNAPSHOT)), '老形状照旧放行');
  assert.doesNotThrow(() => validateChat(bodyWith(undefined)), '不带 roco_battle 照旧放行');
  const read = extractAffinityReader();
  assert.equal(read({self: {pets: []}}, incomingAffinity, 'x'), null, '没有我方阵容 ⇒ 不加这个键');
  assert.equal(read({}, null, 'x'), null, '拿不到相性函数 ⇒ 不加这个键');
});

test('⑩ B3⑤：机制证据 —— 带读数时，引用「承伤 0.5」的正文**不再**被打回（不带时报 ungrounded）', async () => {
  const battle = {...SNAPSHOT, affinity: {source: 'src/client/type-affinity.data.js@x', vs_types: ['火系'],
    rows: [{pet_id: 'pet_000225', multiplier: 0.5, known: true}], unavailable: []}};
  const answer = '第 3 回合寂灭骨龙 120/180 血、4 能量；它对火系承伤 0.5，比潮甲龟的 1 更抗这一手。';
  const ask = (rocoBattle) => runCoach({message: '寂灭骨龙对火系承伤 0.5 是怎么算出来的？', role: 'auto',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}, roco_battle: rocoBattle},
    memory: freshMemory(), conversation: [],
    provider: {name: 'deepseek', async generate() { return answer; }}});
  const withField = await ask(battle);
  const without = await ask(SNAPSHOT);
  assert.equal(without.validation?.rejectedReason, 'ungrounded', '不带读数 ⇒ 0.5 无出处 ⇒ 必须判 ungrounded');
  assert.equal(without.provider, 'local-fallback', '不带读数 ⇒ 交付的是回退那一份');
  assert.equal(withField.validation?.rejectedReason, null, '带读数 ⇒ 0.5 有出处 ⇒ 不许再打回');
  assert.equal(withField.provider, 'deepseek', '带读数 ⇒ 交付的就是模型正文');
  assert.match(String(withField.text), /承伤 0\.5/, '玩家拿到的正文里要留着那个数（有出处）');
  // ⚠ 如实登记（**与本片无关的第二道闸**）：交付正文里 「第 3 回合寂灭骨龙 120/180 血、」 这一截被
  //   `findNumberSourceProblems` 摘掉了 —— 它把「120/180 血」里的 **180** 当成 hp 主张（实际 120）⇒ 误判。
  //   这是**既有**行为（`runtime.js`，不在本片写域）：页面/模型写标准的「当前/上限 血」形式就会中招。
  //   本判据只钉「承伤倍率那个数不再被打回」，不替那道闸背锅；已单列在报告 §「本片外发现」。
  assert.doesNotMatch(String(withField.text), /开一局之后/, '局里不许出现那句假话');
});

// ── B2（2026-10-01）：比较类问句进建议层（第 8 组**窄**词表）────────────────────
// 现场：五条比较类问句（含 lead-mac 的原句）一条都不命中旧词表 ⇒ 落到陪伴层回
// 「说清你问的是哪一块（配招/先手/队伍），我按事实答。」—— 答非所问。
// 为什么必须窄：`coach-advice.js` 文件头逐字写着「宽一个词，事实问句（火系克制什么属性）就会被吞掉，
// 玩家得到一段答非所问的战术建议 —— 这比沉默更糟」。
test('⑪ B2①：比较类命中、事实/机制题**不许**被吞（窄表的两个方向）', () => {
  const yes = ['喵喵光系承伤 0.5 与缇塔 1 如何比较', '喵喵和缇塔哪个更耐打？', '谁更抗打？',
    '这两只谁的承伤更低？', '缇塔扛得住这一下吗？'];
  for (const q of yes) assert.equal(rocoAdviceAsk(q), true, `比较类必须命中：${q}`);
  const no = ['火系克制什么属性？', '承伤是什么意思？', '能量上限是多少？', '缇塔是什么属性？',
    '这一局我换了几次宠？', '承伤', '耐打'];
  for (const q of no) assert.equal(rocoAdviceAsk(q), false, `事实/机制题不许被吞：${q}`);
});

test('⑪ B2②：页面读数里「读不到的那几只」并进建议的「不知道」，且只用玩家看得懂的名字', () => {
  const battle = {...SNAPSHOT, affinity: {source: 'src/client/type-affinity.data.js@x', vs_types: ['火系'],
    rows: [{pet_id: 'pet_000225', multiplier: 0.5, known: true}],
    unavailable: [{pet_id: 'pet_000190', reason: '属性组合不在冻结相性表里'}]}};
  const advice = battleAdvice({battle, message: '喵喵和缇塔哪个更耐打？'});
  assert.ok(advice, '比较类问句要能给出建议');
  const unknown = (advice.unknown ?? []).join(' | ');
  assert.match(unknown, /潮甲龟/, `要用公开面里的名字：${unknown}`);
  assert.match(unknown, /属性组合不在冻结相性表里/, '理由要逐字带上');
  assert.doesNotMatch(unknown, /pet_\d+/, '内部 id 不许端给玩家');
  assert.match(battleAdviceText(advice), /我这里不知道的/, '走既有的「不知道」通道');
  // 加性：没有 affinity 时，**那一只的**「不知道」不许凭空多出。
  // ⚠ 2026-10-01（第 3 步）：这句话现在是**比较类** ⇒ 走 `compareAdvice`，它自己也会写「读不到的那几层」，
  //   所以这里只钉"那一只（潮甲龟）"这一条，不再逐字比较整份 `unknown`（那是另一条分支的产物）。
  const plain = battleAdvice({battle: SNAPSHOT, message: '喵喵和缇塔哪个更耐打？'});
  assert.equal((plain.unknown ?? []).some((line) => /潮甲龟/.test(line)), false,
    '没有读数时不许凭空多出「这一只读不到」');
});
