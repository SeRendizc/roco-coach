// 陪练能力契约测试（COMPANION CONTRACT）。
//
// 依据：docs/roco/COMPANION-GAP-AUDIT.md。这一层只钉**已经成立**的契约，
// 让以后的一次改动不能悄悄把它们弄坏。
//
// 对还没成立的条款，这里**不写会失败的用例**（那只会给套件留一颗永远红的钉子），
// 而是把**当前行为**如实断下来，并在注释里用 TODO 写明目标能力与缺口在哪。
// 缺口本身报告在审计文档里。这类用例一旦变红，说明缺口被修好了——
// 那时请把它改成正向断言，并同步更新审计文档对应的那一节。
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  companion, intentOf, decideRegister, companionFacts, companionSession,
  companionCueSlot, COMPANION_LIMITS, COMPANION_DEFER, REGISTERS,
} from '../../src/coach/companion.js';
import {coachEvent, coachContext} from '../../src/coach/session.js';
import {buildContext, runCoach} from '../../src/coach/runtime.js';
import {
  freshMemory, readMemory, rememberPreference, playerWishes,
  correctMemoryItem, deleteMemoryItem,
} from '../../src/coach/memory.js';
import {createGame, resolveTurn, chooseEnemy, legalActions} from '../../src/game/engine.js';

// 固定时钟：这些用例一个都不该依赖「跑的时候是几点」。
const NOW = Date.parse('2026-09-21T14:00:00.000Z');
// 「战报」的判据：只要出现其中一个，就说明这一段是汇报而不是陪着。
// 与 tests/companion.test.js:1481 的 MOOD_LEAK 同源（那一层守的是词表内的情绪词）。
const REPORT = /回合数|第\d+回合|\d+胜\d+负|\d+负\d+胜|倒下|伤害|打出|\d+点/;

function memoryWith(results) {
  const memory = freshMemory();
  memory.events = results.map((result, i) => ({
    id: `contract-${i}-${result}`,
    result,
    stage: '1 · 训练场',
    turns: 10 + i,
    time: new Date(NOW - (i + 1) * 600e3).toISOString(),
    source: 'local-game',
    enemy: ['溪刃獭'],
    faints: ['烬尾狐'],
    firstLossTurn: i + 2,
    firstFallen: '烬尾狐',
    survivors: 1,
    items: {potion: 1},
  }));
  return memory;
}

function dismissJournal(count) {
  return Array.from({length: count}, (_, i) => ({
    id: `dismiss-${i}`, kind: 'dismiss', time: new Date(NOW - i * 1000).toISOString(),
  }));
}

function memoryWithDismissals(count) {
  const memory = freshMemory();
  memory.journal = dismissJournal(count);
  return memory;
}

// 真打一局到结束：路由那一条用例需要有真实对局，否则 matchRequest 根本不成立。
// 引擎是确定性的（同 seed 同结果），所以这里不需要模拟页面。
function finishedGame(seed = 11) {
  let game = createGame(seed, ['fox', 'turtle', 'deer'], {difficulty: 'normal'});
  for (let i = 0; i < 500 && !game.result; i++) {
    const mine = legalActions(game, 'player').filter(a => a.kind !== 'escape');
    const theirs = game.phase === 'replace'
      ? legalActions(game, 'enemy').filter(a => a.kind !== 'escape')[0]
      : chooseEnemy(game);
    if (!mine.length || !theirs) break;
    game = resolveTurn(game, mine[0], theirs);
  }
  return game;
}

// ── 条款一：情绪意图路由 ─────────────────────────────────────────────────────

test('情绪意图路由：词表内的情绪词被判成 emotion，并走心情出口而不是观察通道', () => {
  for (const message of ['好烦', '难受', '不想玩了']) {
    assert.equal(intentOf(message), 'emotion', `${message} 应当被判成情绪`);
  }
  // TODO(companion): '今天有点累' / '今天没睡好' 这类状态词目前不在
  // EMOTION_WORDS（companion.js:255）里，所以 intent='other'。它们的正文出口
  // 仍然是 moodLine（:1675），实测不含战报，所以这一条不要紧；
  // 但它说明「情绪意图」和「情绪出口」是两张表（见下一条与审计 §3.2）。
  for (const message of ['今天有点累', '今天没睡好']) {
    assert.equal(intentOf(message), 'other');
  }
  // 判成情绪的句子不许被模型那一侧还要一份战报：
  // 倾诉那一轮送给模型的约束里，那条「至少一句要来自跨局记录」必须被换成相反的要求
  // （见 companion.js:2128-2131 的 mood 分支）。
  const packet = companion({}, memoryWith(['win', 'win', 'loss']), '好烦', NOW);
  const instruction = packet.replyConstraints.instruction;
  assert.ok(/不需要/.test(instruction) && /跨局记录/.test(instruction),
    `倾诉那一轮的约束要明说不需要跨局记录：${instruction}`);
  assert.ok(!/至少一句要来自跨局记录/.test(instruction),
    `倾诉那一轮不许再要一份战报：${instruction}`);
});

// ── 条款四：共情回复里不许夹带战绩摘要（成立的那一半）────────────────────────

test('玩家只说了一句心情时，回答不许出现任何战绩读数（词表内的情绪词）', () => {
  const memory = memoryWith(['win', 'win', 'loss']);
  for (const [message, word] of [
    ['今天有点累', '累'], ['好烦', '烦'], ['难受', '难受'],
    ['不想玩了', '不想玩'], ['今天没睡好', '没睡好'], ['我睡不着', '睡不着'],
  ]) {
    const packet = companion({}, memory, message, NOW);
    assert.ok(packet.text.includes(word),
      `${message} 要把他自己用过的那个词接回来：${packet.text}`);
    assert.ok(!REPORT.test(packet.text),
      `${message} 的回答是汇报不是陪着：${packet.text}`);
    assert.ok(packet.text.length <= REGISTERS[packet.register].limit,
      `${message} 超过本档上限：${packet.text}`);
  }
});

test('空账本与有记录时，同一句心情拿到的是同一句陪伴（不由账本决定）', () => {
  const empty = companion({}, freshMemory(), '今天有点累', NOW);
  const recorded = companion({}, memoryWith(['win', 'win', 'win']), '今天有点累', NOW);
  assert.equal(empty.text, recorded.text);
  assert.ok(!REPORT.test(recorded.text), recorded.text);
});

test('已知缺口（记录当前行为，故意保持绿色）：EMOTION_WORDS 里有一半的词接不住，会掉进观察通道', () => {
  // TODO(companion): EMOTION_WORDS（src/coach/companion.js:255）与
  // MOOD_LINE / MOOD_WORD_RE（:1555、:1637）不同源。输了／好菜／气死／崩了／好难
  // 被判成 emotion，但 moodLine 拼不出词（:1675 返回 null），于是 R2 那一格落到
  // reading=pick(CLASSES)（:2018），玩家拿到一段纯战报——正是契约第 4 条要挡的
  // 「战绩摘要冒充共情」。
  // 目标行为：这五个词与 MOOD_LINE 同源，回答里一个战报读数都没有。
  // 缺口报告：docs/roco/COMPANION-GAP-AUDIT.md §4.1。
  // 这条用例变红 = 缺口被修好了 → 请改成正向断言（!REPORT.test）并更新审计。
  const memory = memoryWith(['win', 'win', 'win']);
  const leaked = [];
  for (const message of ['输了', '好菜', '气死', '崩了', '好难']) {
    assert.equal(intentOf(message), 'emotion', `${message} 现在被判成情绪`);
    const packet = companion({}, memory, message, NOW);
    if (REPORT.test(packet.text)) leaked.push(message);
  }
  assert.deepEqual(leaked, ['输了', '好菜', '气死', '崩了', '好难'],
    'TODO(companion)：这五个词的回复目前是纯战报；目标是与 MOOD_LINE 同源、不报战绩');
});

// ── 条款三：长期偏好的往返、纠正、删除 ───────────────────────────────────────

test('长期偏好往返：记住 → 序列化 → 读回，值、来源与旧字段同步', () => {
  let memory = freshMemory();
  memory = rememberPreference(memory, '以后叫我老王');
  memory = rememberPreference(memory, '本命是潮甲龟');
  memory = rememberPreference(memory, '记住，以后说短一点');
  memory = rememberPreference(memory, '输了别复盘，我不想听');

  const back = readMemory(JSON.stringify(memory));
  assert.equal(back.preference, 'brief', '旧字段 preference 要跟着同一条记录走');
  assert.equal(back.favorite, 'turtle');
  const wish = playerWishes(back);
  assert.equal(wish.address, '老王');
  assert.equal(wish.chatStyle, 'brief');
  assert.equal(wish.reviewAfterLoss, false);

  const style = back.stated.find(i => i.kind === 'chat-style');
  assert.ok(style, '聊天风格要作为一条单独的显式记忆存在');
  assert.equal(style.source, 'player-stated');
  assert.ok(Date.parse(style.time) > 0, '每条显式记忆都要有可核对的时间');
});

test('长期偏好可纠正、可逐条删除，删掉之后决定不再引用旧值', () => {
  let memory = freshMemory();
  memory = rememberPreference(memory, '记住，以后说短一点');

  const fixed = correctMemoryItem(memory, {id: 'stated:chat-style', value: 'detailed', now: NOW});
  assert.equal(fixed.corrected, true);
  assert.equal(fixed.memory.preference, 'detailed');
  const row = fixed.memory.stated.find(i => i.kind === 'chat-style');
  assert.equal(row.value, 'detailed');
  assert.ok(row.correctedAt, '纠正要留下 correctedAt');
  assert.equal(row.previous, 'brief', '纠正要留下旧值，便于时间线');

  const gone = deleteMemoryItem(memory, {id: 'stated:chat-style', now: NOW});
  assert.equal(gone.deleted, true);
  assert.equal(gone.memory.preference, null, '删掉这条偏好之后旧字段也不许还留着它');
  assert.equal(gone.memory.stated.length, 0);

  const again = deleteMemoryItem(gone.memory, {id: 'stated:chat-style', now: NOW});
  assert.equal(again.deleted, false, '删不存在的条目要如实说没删到');
});

test('未知或畸形的偏好值在决定层安全降级：不猜、不默认、不崩', () => {
  // 整体不是 JSON / 版本号不符 / 值不在白名单：一律退回 null。
  assert.deepEqual(readMemory('not json'), freshMemory());
  assert.equal(readMemory(JSON.stringify({version: 2, preference: 'brief'})).preference, null);
  assert.equal(readMemory(JSON.stringify({version: 1, preference: 'verbose'})).preference, null);
  assert.equal(readMemory(JSON.stringify({version: 1, preference: 'brief'})).preference, 'brief');

  // stated 层里的未知值：
  // TODO(memory): playerWishes.chatStyle 目前把未校验的值原样带出（'verbose'，见
  // memory.js:342——它只做取值，不做白名单）。它今天不进任何决定，因为决定层读的是
  // 重新校验过的 facts.preference。目标是在 stated 的读取处就归一到 brief/detailed/null。
  const raw = {
    version: 1, preference: null,
    stated: [{id: 'stated:chat-style', kind: 'chat-style', value: 'verbose',
      label: 'x', time: '2026-01-01T00:00:00.000Z'}],
  };
  const memory = readMemory(JSON.stringify(raw));
  assert.equal(playerWishes(memory).chatStyle, 'verbose');
  const facts = companionFacts(memory, {}, NOW);
  assert.equal(facts.chatStyle, 'verbose');
  assert.equal(facts.preference, null, '决定层只认白名单里的值');
  // 决定层的降级是可观察的：一个未知值不会让 brief 的逻辑误触发，
  // 拿到的东西与「未设置」逐字相同。
  const withEvents = memoryWith(['win', 'win', 'win']);
  const question = '最近打得怎么样';
  const unknown = companion({}, {...withEvents, preference: 'verbose'}, question, NOW);
  const unset = companion({}, withEvents, question, NOW);
  assert.equal(unknown.register, 'R2');
  assert.equal(unknown.text, unset.text);
});

test('简短偏好只在 R2（玩家提问）被咨询，R1/R3 不受影响（记录当前行为）', () => {
  const brief = memoryWith(['loss', 'loss', 'loss']);
  brief.preference = 'brief';
  const plain = memoryWith(['loss', 'loss', 'loss']);

  const question = '最近打得怎么样';
  assert.equal(intentOf(question), 'ask');
  const briefAnswer = companion({}, brief, question, NOW);
  const plainAnswer = companion({}, plain, question, NOW);
  assert.equal(briefAnswer.register, 'R2');
  assert.equal(plainAnswer.register, 'R2');
  assert.ok(briefAnswer.text.length < plainAnswer.text.length,
    `brief 在 R2 上应当更短：${briefAnswer.text} / ${plainAnswer.text}`);

  // TODO(companion): preference==='brief' 目前只在两处被咨询——
  // companion.js:2019（R2 那一格取一条观察而不是两条）与 runtime.js:72（超 160 字截断）。
  // R1（闲聊／情绪）、R3（连败倾诉）与在场通道完全不受影响，'detailed' 与未设置等价。
  // 目标：所有档位都按玩家的 chatStyle 收放，并让 'detailed' 真的展开。
  // 另外：决定层读的是旧的 f.preference（:2019），而玩家自己说过的那一份是
  // f.chatStyle（:475，来自 memory.stated）——全库没有一处读 f.chatStyle。
  for (const message of ['你好', '嗯', '随便聊聊']) {
    assert.equal(companion({}, brief, message, NOW).text, companion({}, plain, message, NOW).text,
      `${message}：当前 brief 不影响这一档（记录在案的缺口）`);
  }
  const detailed = {...plain, preference: 'detailed'};
  assert.equal(companion({}, detailed, question, NOW).text, plainAnswer.text,
    'detailed 与未设置目前完全等价（记录在案的缺口）');
});

// ── 条款五：不打扰（主动侧，可脱开浏览器判定）────────────────────────────────

test('不打扰（主动侧）：硬边界、额度、冷却、去重都能在没有浏览器的情况下钉住', () => {
  const game = createGame(7, ['fox', 'turtle', 'deer'], {difficulty: 'normal'});
  const base = coachContext(game, {coach: {mode: 'gentle'}, pets: [], lossStreak: 0},
    freshMemory(), NOW);
  assert.equal(base.preference, 'gentle', '主动侧确实把教练档位作为 preference 传下去');

  // 硬边界一：显式安静档
  assert.equal(coachEvent('result', {...base, preference: 'quiet'},
    companionSession(freshMemory(), {now: NOW})), null);
  // 硬边界二：线上竞技进行中
  assert.equal(coachEvent('result', {...base, mode: 'pvp-live'},
    companionSession(freshMemory(), {now: NOW})), null);
  // 硬边界三：本局刚被点掉
  const dismissed = companionSession(freshMemory(), {now: NOW});
  dismissed.dismissed = true;
  assert.equal(coachEvent('result', base, dismissed), null);

  // 每局额度：用满之后非结算事件不再开口
  const full = companionSession(freshMemory(), {now: NOW});
  full.count = full.limit;
  assert.equal(coachEvent('rematch', base, full), null);
  // 冷却：两次开口至少隔 cooldownTurns 个回合
  const cold = companionSession(freshMemory(), {now: NOW});
  cold.lastTurn = base.turn - 1;
  assert.equal(coachEvent('rematch', base, cold), null);
  // 同一事件一局只说一次
  const said = companionSession(freshMemory(), {now: NOW});
  said.said.add('rematch');
  assert.equal(coachEvent('rematch', base, said), null);
});

test('每局额度随近 7 天的主动关闭次数收紧（0 / 1 / 3 → 4 / 1 / 0）', () => {
  assert.equal(companionSession(memoryWithDismissals(0), {now: NOW}).limit,
    COMPANION_LIMITS.maxPerMatch);
  assert.equal(companionSession(memoryWithDismissals(2), {now: NOW}).limit, 1);
  assert.equal(companionSession(memoryWithDismissals(4), {now: NOW}).limit, 0);
  // 7 天窗口之外的关闭不算数：判定必须读时间戳，不能只数条数。
  const stale = freshMemory();
  stale.journal = [{id: 'old', kind: 'dismiss', time: new Date(NOW - 8 * 86400000).toISOString()}];
  assert.equal(companionSession(stale, {now: NOW}).limit, COMPANION_LIMITS.maxPerMatch);
});

test('气泡时序：先判 hold 再判排队过期，超时优先丢弃', () => {
  assert.equal(companionCueSlot({queuedAt: 0, now: 1000, holdUntil: 4000}).action, 'hold',
    '上一条还在最短可见窗口内时必须 hold');
  assert.equal(companionCueSlot({queuedAt: 1000, now: 1000 + COMPANION_DEFER.maxWaitMs + 1}).action,
    'drop', '排队超过上限必须丢掉');
  assert.equal(companionCueSlot({queuedAt: 900, now: 1000}).action, 'show');
  assert.equal(companionCueSlot({}).action, 'idle');
  assert.equal(companionCueSlot({
    queuedAt: 1000, now: 1000 + COMPANION_DEFER.maxWaitMs + 1,
    holdUntil: 1000 + COMPANION_DEFER.maxWaitMs + 5000,
  }).action, 'drop', '既不新鲜又刚显示过时，丢掉比压着更合适');
});

test('已知缺口（记录当前行为）：静默偏好只有主动侧收到，聊天链路的 context 里没有 preference', () => {
  // 闸门本身是好的：把 preference 递进去就生效——主动侧正是这样做的（session.js:63）。
  assert.equal(decideRegister({context: {preference: 'quiet'}, intent: 'chat', playerInitiated: true}).register,
    'R0');
  assert.equal(companion({preference: 'quiet'}, freshMemory(), '你好', NOW).register, 'R0');
  assert.equal(companion({}, freshMemory(), '你好', NOW).register, 'R1');

  // TODO(runtime): 聊天链路 buildContext（runtime.js:10-27）不带 preference，
  // runCoach 也只补 goal / favorite（runtime.js:32），于是 decideRegister 的
  // `context.preference==='quiet'`（companion.js:531）在聊天侧永远不命中：
  // 同一个「安静」设置只对局内主动气泡生效，管不住聊天里的回话。
  // 目标：buildContext / runCoach 把 profile.coach.mode 作为 preference 传下去。
  const profile = {coach: {mode: 'quiet'}, pets: [], lossStreak: 0};
  const context = buildContext(null, profile, 'fox');
  assert.equal(context.preference, undefined);
  assert.equal(context.profile.coach.mode, 'quiet', '档位确实在 profile 里，只是没被送到决定层');
  assert.notEqual(decideRegister({context, intent: 'chat', playerInitiated: true}).register, 'R0');
});

test('已知缺口（记录当前行为）：玩家说「输了」或「别复盘了」时，真实路由把话交给了老师', async () => {
  const game = finishedGame(11);
  assert.ok(game.result, '这一局要真的打完，matchRequest 才会成立');
  const context = buildContext(game, {coach: {mode: 'gentle'}, pets: [], lossStreak: 0}, 'fox');
  const routes = {};
  for (const message of ['输了', '别复盘了']) {
    const memory = rememberPreference(freshMemory(), message);
    const result = await runCoach({
      message, role: 'auto', context: structuredClone(context), memory, conversation: [],
    });
    routes[message] = result.route;
  }
  // TODO(runtime / teacher): '输了' 是 EMOTION_WORDS 里的词（companion.js:255），
  // 但 runtime.js:38 的 matchRequest 在路由之前就命中，route 变成 teacher，
  // 陪练根本拿不到这句话；'别复盘了' 更重——拒绝已经在路由前写进 memory.stated
  // （runtime.js:33 → memory.js:283-284），而 teacher.js 一处都没读 playerWishes，
  // 仍然返回一段完整复盘：拒绝被记录了，却没有被执行。
  // 目标：情绪与拒绝优先于 matchRequest；复盘入口先读 playerWishes(...).refusedReview。
  // 缺口报告：docs/roco/COMPANION-GAP-AUDIT.md §2.2。
  assert.deepEqual(routes, {'输了': 'teacher', '别复盘了': 'teacher'});
});
