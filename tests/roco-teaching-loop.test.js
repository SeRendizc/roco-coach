/**
 * 判据：老师这一环要**闭环** —— 出题 → 答错讲解 → 记录 → **记录用在出题与回答上**。
 *
 * 起因（第 41 轮实测）：`memory.quizLog` 一直在记（答对/答错/独立/变式），`memory.js:426` 的
 * `quizMastery()` 也算得出「独立答对几次、几个变式、是否掌握」—— 但**生产代码里没有一处调用它**
 * （全仓只有 `tests/coach.test.js` 用过）。也就是说：进度记下来了，**从来没用过**。
 * 这一轮把它接上两处：① 出题**避开做过的变式**；② 玩家问「我学得怎么样」时照实报进度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCoach, policyFor} from '../src/coach/runtime.js';
import {freshMemory, quizMastery, QUIZ_MASTERY} from '../src/coach/memory.js';
import {makeQuiz, QUIZ_OFFSETS, teacher} from '../src/coach/teacher.js';
import {newProfile} from '../src/game/progression.js';
import {createGame, rankEnemyActions} from '../src/game/engine.js';

const camp = () => ({mode: 'camp', battle: null, profile: {pets: [
 {id: 'pet_000118', name: '皇家狮鹫', types: ['风系'], stats: {hp: 107, atk: 116, def: 127, spa: 69, spd: 65, spe: 120}}]}});
const quiet = () => ({name: 'stub-model', async plan() { return {stop: true}; }, async generate(p) { return String(p?.text ?? ''); }});
/** 一条**形状合法**的作答记录（`readQuizLog` 要求 `time` 是字符串，否则整条被丢掉）。 */
const attempt = (variant, {correct = true, independent = true, hinted = false, speed = 120} = {}) => ({
 id: `practice:quiz:speed:pet_000118:${speed}:${speed + QUIZ_OFFSETS[variant]}:v${variant}:1`,
 quizId: `speed:pet_000118:${speed}:${speed + QUIZ_OFFSETS[variant]}:v${variant}`,
 variantOf: `speed:pet_000118:${speed}:${speed + QUIZ_OFFSETS[variant]}:v${variant}`,
 skillKey: '速度比较', answer: '先', correct, hinted, independent, time: '2026-09-26T00:00:00.000Z'});

test('① 出题避开**做过**的变式：进度真的影响题目（反证：空记录时从第一档开始）', async () => {
 const answered = new Set([0, 1, 2, 3, 4]);
 // 面板由运行时解析好后传进来（`quizPanelOf`）；这里直接给面板，专测"挑哪一档"。
 const panel = {id: 'pet_000118', name: '皇家狮鹫', speed: 120, source: '判据夹具'};
 const fresh = makeQuiz(camp(), {avoid: answered, panel});
 assert.equal(fresh.variant, 5, `做过的变式不许再出：variant=${fresh.variant}`);
 // ⚠ 2026-09-29 改钉（改钉不删）。**旧断言原文留档**：
 //   assert.match(fresh.question, /对手速度 125/, `v5 的对手速度应当是 120+5：${fresh.question}`);
 // 为什么改：变式表 [2,4,3,6,1,5] → [-3,2,0,4,-1,3]，v5 现在是 +3 ⇒ 120+3=**123**。
 //   **意图不变**：还是"挑中的那一档，题干里的对手速度等于 面板速度 + 该档偏移"。
 assert.match(fresh.question, /对手速度 123/, `v5 的对手速度应当是 120+3：${fresh.question}`);
 const fromScratch = makeQuiz(camp(), {avoid: new Set(), panel});
 assert.equal(fromScratch.variant, 0, '一道都没做过时从第一档开始');
 // 全做完了也**照旧出题**（玩家主动要，不许空手）
 const all = makeQuiz(camp(), {avoid: new Set([0, 1, 2, 3, 4, 5]), panel});
 assert.ok(Number.isInteger(all.variant), '六档都做过时仍要能给出一道题');
});

test('② 答错 ⇒ 讲解 + 记一条作答（quizLog 增长、标成不正确）', async () => {
 let memory = freshMemory();
 const quiz = await runCoach({message: '出一道练习题', role: 'auto', context: camp(), memory, provider: quiet()});
 memory = quiz.memory ?? memory;
 assert.equal(memory.quizLog.length, 0, '刚出题还没作答，不该有记录');
 assert.ok(memory.pendingQuiz, '出完题要挂起一道待答');
 // 题目的正确答案是"先"（120+3 > 120+2），所以答"不确定"必错
 const wrong = await runCoach({message: '不确定', role: 'auto', context: camp(), memory, provider: quiet()});
 memory = wrong.memory ?? memory;
 assert.match(String(wrong.text), /应选「?先出手」?|应选“先出手”/, `要给出讲解：${wrong.text}`);
 // 2026-09-27 改钉（加点退役）：讲解不再写「培养 +3」那道算式，改成双方速度对读
 assert.match(String(wrong.text), /我方速度 120，对手 \d+/, '讲解里要写出双方速度');
 assert.equal(memory.quizLog.length, 1, '答一次记一条');
 assert.equal(memory.quizLog[0].correct, false, '答错要如实记成不正确');
 assert.equal(memory.pendingQuiz, null, '答完清掉待答');
});

test('③ 进度问句从练习记录里答（0 次模型调用）：空记录 / 未掌握 / 已掌握三种都说准', async () => {
 for (const q of ['我学得怎么样？', '我的学习进度', '我掌握了吗？']) {
  assert.equal(policyFor(q, camp()).reason, 'quiz-progress-ask', `「${q}」要走进度这一族`);
 }
 const calls = {plan: 0, generate: 0};
 const provider = {name: 'stub-model', async plan() { calls.plan += 1; return {stop: true}; },
  async generate(p) { calls.generate += 1; return '（模型编的）'; }};
 const ask = (memory) => runCoach({message: '我学得怎么样？', role: 'auto', context: camp(), memory, provider});

 const blank = await ask(freshMemory());
 assert.match(String(blank.text), /还是空的/, `没练过要直说：${blank.text}`);
 assert.equal(calls.plan + calls.generate, 0, '进度问句不许问模型');

 const one = await ask({...freshMemory(), quizLog: [attempt(0)]});
 assert.match(String(one.text), /独立答对 1 次/, `要报独立答对的次数：${one.text}`);
 assert.match(String(one.text), /还没到掌握的门槛/, '一次答对不算掌握');

 const mastered = await ask({...freshMemory(), quizLog: [attempt(0), attempt(1), attempt(2)]});
 assert.match(String(mastered.text), /已经达到掌握的门槛/, `三次独立答对、两个变式 ⇒ 达到门槛：${mastered.text}`);
 assert.equal(calls.plan + calls.generate, 0, '三问都不许问模型');

 // 反证：**有提示的答对不算独立**（口径来自 quizMastery，判据不许另写一份门槛）
 const hinted = await ask({...freshMemory(), quizLog: [attempt(0, {hinted: true, independent: false}),
  attempt(1, {hinted: true, independent: false}), attempt(2, {hinted: true, independent: false})]});
 assert.match(String(hinted.text), /还没到掌握的门槛/, `有提示的答对不许算掌握：${hinted.text}`);
 assert.equal(quizMastery({quizLog: [attempt(0, {hinted: true, independent: false})]}, {skillKey: '速度比较'}).mastered, false,
  '与 quizMastery 同源');
 assert.equal(QUIZ_MASTERY.minIndependent, 3, '门槛常量改了要显式改这条判据（判据里不许另抄一个数）');
});

test('④ 记忆里的偏好**真的被用上**：对局内综合分改权重（培养那一档不再给加点建议）', () => {
 // 2026-09-27 改钉（人类：「加点不要了」）：这一条原来还钉「速攻 ⇒ 先加力量 / 稳健 ⇒ 先加耐久」。
 // 加点退役 ⇒ 老师那一档不再有"改项"这回事；**偏好仍然被读进去**（挂在 packet 上），
 // 而"偏好真的影响打分"由下面那半段（对局内综合分）钉住 —— 那一半一个字没改。
 const profile = newProfile();
 const fast = teacher({profile, focus: 'fox', goal: '速攻', stageId: 'meadow'});
 const steady = teacher({profile, focus: 'fox', goal: '稳健', stageId: 'meadow'});
 assert.equal(fast.goal, '速攻'); assert.equal(steady.goal, '稳健');
 assert.match(fast.text, /没有加点/, `老师这一档要说清没有加点：${fast.text}`);
 assert.doesNotMatch(fast.headline + steady.headline, /力量|耐久|敏捷/, '不再给"先加哪一项"的建议');
 // 对局内：偏好只改「均值 / 最糟」的权重，**不改任何事实** —— 所以 expected/worst 必须逐字相同、
 // 综合分必须不同。这一条同时是"偏好不是靠编数字体现"的反证。
 const game = createGame(445, ['fox', 'turtle', 'deer'], {mode: 'pve', difficulty: 'normal', stageId: 'meadow'});
 const mirrored = {...game, player: game.enemy, enemy: game.player};
 const neutral = rankEnemyActions(mirrored, {});
 const aggressive = rankEnemyActions(mirrored, {goal: '速攻'});
 const careful = rankEnemyActions(mirrored, {goal: '稳健'});
 const key = (rows) => rows.map((row) => `${row.action.kind}:${row.action.id ?? row.action.target ?? ''}`);
 assert.deepEqual(key(neutral), key(aggressive), '偏好不许改变候选或排序以外的东西');
 for (const [index, row] of neutral.entries()) {
  assert.equal(row.expected, aggressive[index].expected, '均值是事实，不许随偏好变');
  assert.equal(row.worst, aggressive[index].worst, '最糟分支是事实，不许随偏好变');
 }
 assert.notEqual(neutral[0].score, aggressive[0].score, '综合分要随偏好变（速攻更看均值）');
 assert.notEqual(aggressive[0].score, careful[0].score, '稳健与速攻的综合分不许一样');
});

// ── 同一句里"查事实 + 出题"：不许按玩家没看过的题判分（2026-09-27，审计高 8）──────────
test('同一句里既问事实又要出题 ⇒ 不许留下没显示过的 pendingQuiz，更不许据此判分', async () => {
  const {runCoach: run, buildContext: build, localProvider: local} = await import('../src/coach/runtime.js');
  const {freshMemory: fresh} = await import('../src/coach/memory.js');
  const {createGame: game} = await import('../src/game/engine.js');
  const {newProfile: profile} = await import('../src/game/progression.js');
  const context = build(game(11), profile(), 'fox');
  const memory = fresh();
  // 审计实测的复现句（5 条自然说法里 4 条能触发）
  const first = await run({message: '先告诉我回复药回多少血，再出个小测', role: 'auto',
    context, memory, provider: local});
  assert.match(String(first.text), /回复药/, '正文应当是事实答案');
  assert.ok(!Array.isArray(first.choices) || first.choices.length === 0,
    `正文不是那道题时不许留假选项：${JSON.stringify(first.choices)}`);
  // 下一轮：**不许**出现判分话术，也**不许**往学习记录里写
  const second = await run({message: '先出手', role: 'auto', context, memory: first.memory, provider: local});
  assert.doesNotMatch(String(second.text), /答对了|答错了|回答正确|回答错误/,
    `不许按没显示过的题判分：${second.text}`);
  const lessons = second.memory?.lessons ?? [];
  assert.equal(Array.isArray(lessons) ? lessons.length : 0, 0,
    `没答过的题不许写进学习记录：${JSON.stringify(lessons)}`);
});


// ── 2026-09-29（第三轮 P0 Q5，人类实测 500）────────────────────────────────────
//
// 事实经过（真机 + 临时实例都能复现）：`lastMatch` **只有 `{id,result,turn}`** 时，
// `/api/coach` 问一句「复盘一下这一局」回 **500「本地服务无法完成请求」**，栈顶逐字：
//   `TypeError … at reviewMatch (src/coach/teacher.js:242:23)`
// 根因：`reviewMatch` 里那一行 `const key=m.keyTurns.slice()…` —— **假设 `keyTurns` 一定在**。
// **修前行为留档（改钉不删）**：修前这条判据是**红的**（抛 TypeError），所以它当时根本写不出来；
// 现在钉成"缺字段必须 200/可成句 + 不许拿最后一回合冒充关键回合"。
test('复盘：lastMatch 缺 keyTurns 时不许崩，且不许拿最后一回合冒充关键回合（修前是 TypeError at reviewMatch）', async () => {
  const {reviewMatch} = await import('../src/coach/teacher.js');
  // ① 最小形状：产品真会给的那种（只有结果，没有逐回合记录）
  const minimal = reviewMatch({lastMatch: {id: 'probe-match', result: 'loss', turn: 1}});
  assert.equal(typeof minimal.text, 'string', '必须成句（修前这里直接抛 TypeError）');
  assert.ok(minimal.text.length > 0, '正文不能是空串');
  assert.match(minimal.text, /没有可复盘的判断依据/, '要如实说"没有可复盘的判断依据"');
  assert.match(minimal.text, /不会拿最后一回合冒充关键回合/, '不许拿最后一回合冒充关键回合');
  assert.doesNotMatch(minimal.text, /第\s*1\s*回合值得回看/, '缺记录时不许编出"值得回看的回合"');
  // ② 反证：有 `rounds`/`counts`/`keyTurns` 时照常成句（这条判据没把正常路堵死）
  const full = reviewMatch({lastMatch: {id: 'probe-2', result: 'loss', rounds: 4,
    counts: {guards: 1, items: 0, switches: 2}, remainingItems: {potion: 1},
    keyTurns: [{turn: 3, events: ['我方使用防御。'], analysis: '（分析）'}]}});
  assert.match(full.text, /共4回合/, '有整局统计时照常给统计句');
  assert.doesNotMatch(full.text, /没有可复盘的判断依据/, '有记录时不许走"没有依据"那一支');
});

// ── 2026-09-29（人类：「memory机制还有问题啊，记不住啊」；小芽答「完整回合日志没被保留」）──
//
// 事实经过：`rememberBattle` 原来只存结果级事实（回合数/倒下/幸存/道具），**逐回合的血量、出招、
// 事件一条都没留** ⇒ 下一段会话问「复盘一下我上一局」只能如实说"没保留"。产品的做法应该是
// **把能留的留住**（`matchFacts` 现在带一份**有上限**的 `turnLog`，见 memory.js 的 TURN_LOG_LIMIT）。
// 判据（三样齐）：新行为（有 turnLog ⇒ 说得出具体回合）· 反证（没有 ⇒ 如实说、不编回合）· 旧行为留档。
test('复盘上一局：存过的逐回合摘要要说得出具体回合；没存过必须如实说（修前只能答"没保留"）', async () => {
  const {reviewMatch} = await import('../src/coach/teacher.js');
  // ① 新行为：带 turnLog ⇒ 逐回合成句（血量变化与出招都在）
  const withLog = reviewMatch({lastMatch: {id: 'm1', result: 'loss', stage: '训练场', turnLog: [
    {turn: 3, you: {name: '烬尾狐', hp: 18, hpAfter: 0}, foe: {name: '溪刃獭', hp: 75, hpAfter: 50},
      action: {kind: 'skill', id: 'dash'}, events: ['你的烬尾狐使用疾爪，对溪刃獭造成 25 伤害。']},
    {turn: 4, you: {name: '潮甲龟', hp: 132, hpAfter: 120}, foe: {name: '溪刃獭', hp: 50, hpAfter: 40},
      action: {kind: 'guard'}, events: []},
  ]}});
  assert.match(String(withLog.text), /第3回合/, '要说得出具体回合');
  assert.match(String(withLog.text), /烬尾狐/, '要说出当时在场的是谁');
  assert.match(String(withLog.text), /18 血→0 血/, '要说出血量变化（存下来的事实）');
  assert.doesNotMatch(String(withLog.text), /没被保留|没有逐回合|只有结果/, '存过就不许再说"没保留"');
  // ② 反证：没有 turnLog（旧形状）⇒ 如实说，且**不许编回合**
  const noLog = reviewMatch({lastMatch: {id: 'm2', result: 'loss'}});
  assert.match(String(noLog.text), /没有可复盘的判断依据|没有逐回合/, '没存过要如实说');
  assert.doesNotMatch(String(noLog.text), /第\d+回合/, '没存过不许编出回合');
  // ③ 旧行为留档：修前这条会是「这一局我这边只有结果，没有逐回合的关键回合记录…」（改钉不删）
});
