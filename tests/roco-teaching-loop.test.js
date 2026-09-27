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
 assert.match(fresh.question, /对手速度 125/, `v5 的对手速度应当是 120+5：${fresh.question}`);
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
 assert.match(String(wrong.text), /120\+3=123/, '讲解里的算式要写出来');
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

test('④ 记忆里的偏好**真的被用上**：培养建议改项、对局内综合分改权重（但事实不变）', () => {
 const profile = newProfile();
 const fast = teacher({profile, focus: 'fox', goal: '速攻', stageId: 'meadow'});
 const steady = teacher({profile, focus: 'fox', goal: '稳健', stageId: 'meadow'});
 assert.notEqual(fast.headline, steady.headline, `两种偏好要给不同的建议：${fast.headline} / ${steady.headline}`);
 assert.match(fast.headline, /力量/, `速攻 ⇒ 先加力量：${fast.headline}`);
 assert.match(steady.headline, /耐久/, `稳健 ⇒ 先加耐久：${steady.headline}`);
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

