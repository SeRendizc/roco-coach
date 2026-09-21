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
  // 状态词（累了／没睡好）**故意不算情绪**：它们在心情出口里（MOOD_LINE），
  // 但不是情绪本身。判成 emotion 会把档位从 R1 抬到 R2、让第一轮就开始讲对局
  // （实测：`今天有点累` → R2 + 连败句），所以这条不对称是有意的。
  // 第 45 轮修的是另一头：**判得成情绪的词必须接得住**（见下一条与 companion.js 的
  // EMOTION_WORDS_LIST 自检）——原来的缺陷是「判成情绪却拼不出句子」，方向相反。
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

test('情绪词一律走心情出口：五个曾经接不住的词，回答里一个战报读数都没有（第 45 轮已修）', () => {
  // 修复前的病灶：EMOTION_WORDS 与 MOOD_LINE / MOOD_WORD_RE 各写一张表，
  // 输了／好菜／气死／崩了／好难被判成 emotion，却拼不出心情那一句，
  // 于是 R2 落到 reading=pick(CLASSES)，玩家拿到一段纯战报——
  // 正是契约第 4 条要挡的「战绩摘要冒充共情」。
  // 现在这几张表由同一批字面量派生（companion.js 的 EMOTION_EXTRA_WORDS），
  // 模块加载时另有一条自检：取不到词或拼不出整句就直接抛错。
  const memory = memoryWith(['win', 'win', 'win']);
  for (const message of ['输了', '好菜', '气死', '崩了', '好难']) {
    assert.equal(intentOf(message), 'emotion', `${message} 应当被判成情绪`);
    const packet = companion({}, memory, message, NOW);
    assert.ok(packet.text.includes(message),
      `${message} 要把他自己用过的那个词接回来（mimic）：${packet.text}`);
    assert.ok(!REPORT.test(packet.text),
      `${message} 的回答是汇报不是陪着：${packet.text}`);
  }
  // 反向对照：带「输在哪」的分析问法**不该**掉进陪伴句——
  // 同源的目的是让情绪被接住，不是把所有含「输」的话都变成安慰。
  const asked = companion({}, memory, '输在哪', NOW);
  assert.ok(!/^输了啊/.test(asked.text), `分析问法不该拿到心情句：${asked.text}`);
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

test('说话长短：brief 真的更短，而且玩家自己说过的那一份（chatStyle）真的被读到（第 45 轮已修）', () => {
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

  // **这一条才是第 45 轮修的东西**：玩家自己说过的那一份在 `f.chatStyle`
  // （来自 `memory.stated`），而在这一轮之前**全库没有一处读它**——决定层读的是旧的
  // `f.preference`。所以这里把两者拆开：只留 `stated`、把旧字段清空，效果必须照旧。
  const statedOnly = freshMemory();
  statedOnly.events = plain.events;
  statedOnly.stated = rememberPreference(freshMemory(), '以后说短一点').stated;
  statedOnly.preference = null;
  assert.equal(playerWishes(statedOnly).chatStyle, 'brief', '这是玩家自己明说的偏好');
  assert.equal(statedOnly.preference, null, '旧字段确实为空（否则这条用例证明不了什么）');
  assert.equal(companion({}, statedOnly, question, NOW).text, briefAnswer.text,
    'chatStyle 自己必须能决定长短——「旧字段刚好也被同步了」不算修好');

  // `detailed` 与未设置**在素材够多时**不同、素材不够时相同，两种情况都不是「永远等价」：
  // 它多讲的是一条真实记录，不能凭空造内容。R2 的默认已经是三句、带宽 120 字，
  // 所以在这一档上 `detailed` 常常加不出东西——**如实记着**，别在文档里说它「会展开」。
  const detailed = {...plain, preference: 'detailed'};
  const detailedAnswer = companion({}, detailed, question, NOW);
  assert.ok(detailedAnswer.text.length >= plainAnswer.text.length,
    `detailed 永远不该比未设置更短：${detailedAnswer.text}`);

  // R1/R3 **不按这个偏好收放**，理由不是漏写：观察通道有一道「至少两句」的信息闸，
  // 再往下砍会整条作废、降成 R0「我在。」（实测：把 R1 砍成一句，brief 掉到 R0）。
  // 这条断言守的是「不许为了『更短』把陪伴砍成三个字的应答」。
  for (const message of ['你好', '嗯', '随便聊聊']) {
    assert.equal(companion({}, brief, message, NOW).text, companion({}, plain, message, NOW).text,
      `${message}：这一档不该被 brief 砍短`);
  }
  const r1 = '我在干嘛';
  assert.equal(companion({}, brief, r1, NOW).register, 'R1');
  assert.equal(companion({}, brief, r1, NOW).text, companion({}, plain, r1, NOW).text,
    'R1 的正文受「至少两句」约束，brief 在这里没有可砍的空间——不许砍成 R0');
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

test('静默偏好同时管住局内气泡与聊天回话（第 45 轮已修，正向断言）', async () => {
  // 闸门本身是好的：把 preference 递进去就生效——主动侧正是这样做的（session.js:63）。
  assert.equal(decideRegister({context: {preference: 'quiet'}, intent: 'chat', playerInitiated: true}).register,
    'R0');
  assert.equal(companion({preference: 'quiet'}, freshMemory(), '你好', NOW).register, 'R0');
  assert.equal(companion({}, freshMemory(), '你好', NOW).register, 'R1');

  // ✅ 已修（第 45 轮）：`runCoach` 现在把 `profile.coach.mode` 作为 `preference`
  // 透传给决定层，所以「安静」档在聊天侧也生效了。
  //
  // 这条原来是一个 TODO（断言 `context.preference===undefined` 且判定**不是** R0）。
  // 修好之后按它自己的说明翻成正向断言——TODO 里写的就是「这条变红 = 缺口被修好了」。
  const profile = {coach: {mode: 'quiet'}, pets: [], lossStreak: 0};
  const context = buildContext(null, profile, 'fox');
  // `buildContext` 本身仍然不带 preference（它只负责把 profile 原样带上），
  // 透传点在 `runCoach`——那里才是决定层之前的最后一道。
  assert.equal(context.profile.coach.mode, 'quiet', '档位确实在 profile 里');
  const quietRun = await runCoach({
    message: '你好', role: 'auto', context: structuredClone(context), memory: freshMemory(), conversation: [],
  });
  assert.equal(quietRun.meta?.register ?? quietRun.register, 'R0',
    '「安静」档必须同时管住局内气泡与聊天回话');
  // 反向对照：档位是 gentle 时，同一句话不该被静音
  const gentle = buildContext(null, {coach: {mode: 'gentle'}, pets: [], lossStreak: 0}, 'fox');
  const gentleRun = await runCoach({
    message: '你好', role: 'auto', context: structuredClone(gentle), memory: freshMemory(), conversation: [],
  });
  assert.notEqual(gentleRun.meta?.register ?? gentleRun.register, 'R0',
    'gentle 档不该被这道闸门拦住');
});

test('情绪与拒绝优先于复盘路由：输了 / 别复盘了 归陪练，分析问法仍归老师（第 45 轮已修）', async () => {
  const game = finishedGame(11);
  assert.ok(game.result, '这一局要真的打完，matchRequest 才会成立');
  const context = buildContext(game, {coach: {mode: 'gentle'}, pets: [], lossStreak: 0}, 'fox');
  const run = (message, memory = freshMemory()) => runCoach({
    message, role: 'auto', context: structuredClone(context),
    memory: rememberPreference(memory, message), conversation: [],
  });
  const routes = {};
  for (const message of ['输了', '别复盘了']) routes[message] = (await run(message)).route;
  // 修好之前：两句都 route='teacher'——「输了」是 EMOTION_WORDS 里的词，
  // 却被 runtime 的 matchRequest 提前截走；「别复盘了」明明写进了 memory.stated
  // 的 refusal:review，teacher 一个字段都没读，照样返回一整段复盘。
  assert.deepEqual(routes, {'输了': 'companion', '别复盘了': 'companion'});

  // 情绪那句话拿到的必须是陪伴句，不是换了壳的战报（同一条契约的前半）。
  const upset = await run('输了');
  const upsetText = upset.text ?? '';
  assert.ok(!/回合|倒下|伤害|\d+胜|\d+负/.test(upsetText),
    `「输了」不许换来一段战报：${upsetText}`);
  // 拒绝那句话要被执行，而不只是被记录。
  const refused = await run('别复盘了');
  assert.ok(/不复盘/.test(refused.text ?? ''), `拒绝要被回答：${refused.text}`);

  // 反向对照：真正的分析问法照旧走老师——把词表同源做成了「含输就安慰」就是做过头了。
  for (const message of ['输在哪', '整局复盘一下', '为什么输了']) {
    const r = await run(message);
    assert.equal(r.route, 'teacher', `「${message}」是分析请求，不能掉进陪伴句：${r.text}`);
  }
  // 反向对照之二：已经说过「先别复盘」时，光是一句追问不再触发复盘；
  // 但玩家**再明确要**复盘仍旧走老师（显式请求优先于旧拒绝）。
  const memory = rememberPreference(freshMemory(), '输了别复盘，我不想听');
  assert.equal(playerWishes(memory).refusedReview, true, '拒绝已经记进 memory.stated');
  assert.equal((await run('然后呢', memory)).route, 'companion', '旧拒绝生效期间不再推复盘');
  assert.equal((await run('复盘一下吧', memory)).route, 'teacher', '玩家改主意了要照办');
});
