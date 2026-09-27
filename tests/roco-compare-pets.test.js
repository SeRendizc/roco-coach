// 「A 和 B 谁更…」两只对比的判据（2026-09-25）。
//
// **由来（产品路径实测，`reports/roco/compare-pets-2026-09-25/`）**：
//   「喵喵和音速犬哪个速度更快？」→ **0 次调用**、答「我这儿只有音速犬速度120，没有喵喵的数据，比不了」；
//   「水蓝蓝和火花谁更肉？」      → **0 次调用**、答「**水蓝蓝吧，它偏肉一些**」
//     —— **两只都不在包里，凭印象下了结论**（红线最在意的那类）；
//   「喵喵和铠甲虫哪个物攻高？」  → 0 次调用、诚实拒绝。
// 修完（政策 + 提示规则）三条都变成**两次按名字的查询**，且回答里的数字经引擎核对全对。
//
// 判据钉：① 该触发且参数是"包里没有的那只"；② **两只都在包里就不查**（省一次没必要的调用）；
// ③ fail closed（代词/同名/没名字）；④ 不误伤其它问法；⑤ 开关两态；⑥ 与图鉴政策的前后顺序；
// ⑦ 提示里那条"缺一只就不许比"必须在（否则模型会回到凭印象下结论）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareAsk, compareTarget, defaultArgsFor, policyFor} from '../src/coach/runtime.js';
import {productionPlannerSystem} from '../src/coach/planner-prompt.js';

const SPE = {hp: 85, atk: 116, def: 101, spa: 38, spd: 82, spe: 120};
// 包里只有这两只（都带六维）——「都在包里就不查」那条靠它
const CAMP = {mode: 'camp', profile: {lineup: [
  {id: 'pet_000062', name: '音速犬', stats: SPE},
  {id: 'pet_000118', name: '皇家狮鹫', stats: {...SPE, hp: 107}},
], pets: []}};

test('① 该触发：参数是"包里没有的那只"', () => {
  const cases = [
    ['喵喵和音速犬哪个速度更快？', '喵喵'],       // 音速犬在包里 ⇒ 查喵喵
    ['水蓝蓝和火花谁更肉？', '水蓝蓝'],           // 两只都不在 ⇒ 查第一只
    ['喵喵和铠甲虫哪个物攻高？', '喵喵'],
    ['火花跟水蓝蓝谁的速度快？', '火花'],         // 「跟」也认
  ];
  for (const [question, want] of cases) {
    assert.equal(compareAsk(question), true, `该触发却没触发：${question}`);
    const policy = policyFor(question, CAMP);
    assert.equal(policy.need, 'query_rules', `政策应给出 query_rules：${question}`);
    assert.equal(policy.reason, 'compare-ask');
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, question), {kind: 'pet', name: want},
      `该查包里没有的那只：${question}`);
  }
});

test('② 两只都在包里就不查（手里有事实，直接比）', () => {
  const question = '音速犬和皇家狮鹫谁快？';
  assert.equal(compareAsk(question), true, '这句话本身是比较问句');
  assert.equal(compareTarget(question, CAMP), null, '两只都在包里 ⇒ 不构造参数');
  assert.notEqual(policyFor(question, CAMP).reason, 'compare-ask', '不该为了比较再发一次没必要的调用');
  // 反证：把其中一只从包里拿掉，同一个问题必须变成"要查"
  const half = {mode: 'camp', profile: {lineup: [CAMP.profile.lineup[0]], pets: []}};
  assert.deepEqual(compareTarget(question, half), {kind: 'pet', name: '皇家狮鹫'});
});

test('③ fail closed：代词 / 同名 / 没名字都不构造参数', () => {
  for (const question of ['我和它谁快？', '这个和那个哪个好？', '喵喵和喵喵谁快？', '谁更快？']) {
    assert.equal(compareTarget(question, CAMP), null, `不许猜：${question}`);
  }
  // 反证：正常的比较句必须能构造（判据不是恒假）
  assert.ok(compareTarget('水蓝蓝和火花谁更肉？', CAMP));
});

test('④ 不误伤：图鉴 / 术语 / 学习表 / 固定规则 / 阵容问题都不归它', () => {
  const others = [
    ['喵喵的种族值是多少？', 'codex-fact'],
    ['喵喵学得到哪些技能？', 'learnset-ask'],
    ['「应对」这条术语是怎么定义的？', 'term-ask'],
    ['能量上限是几个豆？', 'state-in-packet'],
    // 2026-09-25 改钉（**行没删**）：这一问在 2 只名单的上下文里本来落到 `state-in-packet`
    // ⇒ 没模型时由陪练回一句「我在。」。现在整队问句有了自己的本地政策（`team-ask-incomplete`：
    // 说清"整队结论要 3/6 只、你这套只有 2 只"并给出补法）。**这一条要钉的仍然是
    // 「比较政策不许抢走它」** —— 期望值随实现改，判据的意图不变。
    ['这个阵容打 PVP 有什么短板？', 'team-ask-incomplete'],
    ['第三只换成圆号鱼好不好？', 'swap-compare'],
  ];
  for (const [question, want] of others) {
    assert.equal(policyFor(question, CAMP).reason, want, `不该被比较政策抢走：${question}`);
  }
});

test('⑤ 开关：显式 ROCO_COMPARE_LOOKUP=0 才关（默认开）', () => {
  const question = '水蓝蓝和火花谁更肉？';
  const previous = process.env.ROCO_COMPARE_LOOKUP;
  try {
    delete process.env.ROCO_COMPARE_LOOKUP;
    assert.equal(policyFor(question, CAMP).reason, 'compare-ask', '不设变量 = 开');
    process.env.ROCO_COMPARE_LOOKUP = '0';
    assert.notEqual(policyFor(question, CAMP).reason, 'compare-ask', '显式 0 必须真的关掉');
    assert.equal(defaultArgsFor('query_rules', CAMP, question), null, '关掉后不许再构造参数');
  } finally {
    if (previous === undefined) delete process.env.ROCO_COMPARE_LOOKUP;
    else process.env.ROCO_COMPARE_LOOKUP = previous;
  }
});

test('⑥ 顺序：带「的<字段>」的图鉴问句仍归 codex-fact', () => {
  const question = '喵喵的种族值和音速犬的种族值谁高？';
  assert.equal(policyFor(question, CAMP).reason, 'codex-fact');
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, question), {kind: 'pet', name: '喵喵'});
});

test('⑦ 提示里必须有"缺一只就不许比"（否则模型会回到凭印象下结论）', () => {
  const prompt = productionPlannerSystem({sufficiency: ''});
  assert.ok(prompt.includes('两只都要有 receipts 里的数值才能比'), '缺"两只都要有数值"');
  assert.ok(prompt.includes('凭印象说谁更肉'), '缺"不许凭印象"这条禁令');
  // 反证：把探测器对准不含这句的提示必须为假
  const probe = (text) => text.includes('两只都要有 receipts 里的数值才能比');
  assert.equal(probe('能量上限是几个豆。'), false, '探测器本身必须能红');
  assert.equal(probe(prompt), true);
  // 判据也要防"提示被整段换掉"：这段话必须在**默认档**里（不是只在某个人工档）
  const src = readFileSync(new URL('../src/coach/planner-prompt.js', import.meta.url), 'utf8');
  assert.ok(src.includes('**规则事实必须查证**：玩家问的是图鉴里的具体事实'), '默认档正文还在');
});
