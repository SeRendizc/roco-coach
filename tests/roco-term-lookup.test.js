// 术语问句的判据（2026-09-25）。
//
// 这一条政策的由来是**产品路径上的实测**：玩家问「『应对』这条术语是怎么定义的？」时
// `agentStop=policy-route-without-tools` —— 工具循环根本没进（路由把这类问题判成闲聊），
// 模型只能答「具体定义要看本作说明，我这没有它的准确定义」。而引擎那时明明有这条术语
// （1015 应对状态 / 1016 应对攻击 / 1017 应对防御，见 `roco/tests/test_term_lookup.py`）。
//
// 判据钉四件事：
//   ① 该触发：玩家真会说的那几种问法都要触发，并且参数是 `{kind:'term',name}`；
//   ② **零误伤**：49 例里那些非术语问句（局面 / 固定常识 / 闲聊）一条都不许被它抓走；
//   ③ **取不出名字就 fail closed**：`defaultArgsFor` 返回 `null`（运行时据此写"没有记录"的回执，
//      而不是拿一个编出来的名字去查）；
//   ④ 开关两态 + 顺序（图鉴问句仍归 `codex-fact`，不许被术语政策抢走）。
//
// 每条判据配必红反证。

import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultArgsFor, policyFor, termAsk, termTarget} from '../src/coach/runtime.js';

const CAMP = {mode: 'camp', profile: {pets: []}};

test('① 该触发：玩家真会说的问法都要触发，参数是 {kind:term,name}', () => {
  const cases = [
    ['「应对」这条术语是怎么定义的？', '应对'],
    ['『应对』这条术语是怎么定义的？', '应对'],
    ['应对是什么意思？', '应对'],
    ['什么叫应对状态？', '应对状态'],
    ['应对状态的定义是什么？', '应对状态'],
    ['我在练习场，想问下：「应对」这条术语是怎么定义的？', '应对'],
    ['我锁定寂灭骨龙，再确认一下，「应对」这条术语是怎么定义的？', '应对'],
  ];
  for (const [question, want] of cases) {
    assert.equal(termAsk(question), true, `该触发却没触发：${question}`);
    assert.deepEqual(termTarget(question), {kind: 'term', name: want}, `名字取错：${question}`);
    const policy = policyFor(question, CAMP);
    assert.equal(policy.need, 'query_rules', `政策应给出 query_rules：${question}`);
    assert.equal(policy.reason, 'term-ask');
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, question), {kind: 'term', name: want});
  }
});

test('② 零误伤：49 例里的非术语问句一条都不许被抓走', () => {
  // 这些句子全部来自 `scripts/eval-live-s04.js` 的 CASES（局面 / 固定常识 / 闲聊 / 该停）。
  const notTerm = [
    '我现在场上这只还剩多少血？能量够放技能吗？', '对方还剩多少药？我要不要换宠？',
    '第5回合到底发生了什么？我想知道当时的能量变化。', '上一回合发生了什么？我需要判断这回合怎么打。',
    '能量上限是几个豆？', '防御能减伤多少？', '回复药能回多少血？比防御更划算吗？',
    '换宠之后这回合还能出招吗？', '火属性克制什么属性？', '技能有冷却时间吗？',
    '中毒算属性异常吗？', '宠物倒下后可以免费换宠补位吗？算整局失败吗？', '5豆算满豆吗？',
    '你好小芽，随便聊聊，今天打得怎么样？', '谢谢，先不问了。', '明白了，辛苦了。',
    '小测一下防御的用法。', '这回合我想稳一点，你先看看局面再告诉我。',
  ];
  for (const question of notTerm) {
    assert.equal(termAsk(question), false, `误伤了：${question}`);
    assert.notEqual(policyFor(question, CAMP).reason, 'term-ask', `政策被误触发：${question}`);
  }
  // 反证：同一个探测器对上面那些"真术语句"必须为真（不是恒假）
  assert.equal(termAsk('「应对」这条术语是怎么定义的？'), true);
  assert.equal(termAsk('这条术语是怎么定义的？'), true, '没有名字时也要认得出这是术语问句');
});

test('③ 取不出名字就 fail closed：不许拿编出来的名字去查', () => {
  // 「这条术语」是**指代**，不是名字 ⇒ 政策仍说"要查"，但参数构造不出来 ⇒ 返回 null，
  // 运行时据此写一条"没有记录"的回执（`absentArgsFor`），而不是编一个名字发出去。
  const vague = '这条术语是怎么定义的？';
  assert.equal(termAsk(vague), true);
  assert.equal(termTarget(vague), null, '指代不许被当成名字');
  assert.equal(defaultArgsFor('query_rules', CAMP, vague), null);
  assert.equal(policyFor(vague, CAMP).need, 'query_rules', '政策仍应说明"这类问题要查"');
  // 反证：把指代替换成真名字，同一个构造器必须给出参数（否则③是恒真判据）
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '「应对」这条术语是怎么定义的？'),
    {kind: 'term', name: '应对'});
});

test('④ 开关两态：显式 ROCO_TERM_LOOKUP=0 才关（默认开）', () => {
  const question = '「应对」这条术语是怎么定义的？';
  const previous = process.env.ROCO_TERM_LOOKUP;
  try {
    delete process.env.ROCO_TERM_LOOKUP;
    assert.equal(policyFor(question, CAMP).need, 'query_rules', '不设变量 = 开');
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, question), {kind: 'term', name: '应对'});
    process.env.ROCO_TERM_LOOKUP = '0';
    assert.notEqual(policyFor(question, CAMP).reason, 'term-ask', '显式 0 必须真的关掉');
    assert.equal(defaultArgsFor('query_rules', CAMP, question), null, '关掉后不许再按术语构造参数');
  } finally {
    if (previous === undefined) delete process.env.ROCO_TERM_LOOKUP; else process.env.ROCO_TERM_LOOKUP = previous;
  }
});

test('⑤ 顺序：图鉴问句仍归 codex-fact，不被术语政策抢走', () => {
  const codex = '喵喵的种族值是多少？';
  assert.equal(policyFor(codex, CAMP).reason, 'codex-fact');
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, codex), {kind: 'pet', name: '喵喵'});
  // 反证：同一个问题在术语政策下也"像"术语吗？不像 —— 它得含"术语/定义/什么意思"这类词。
  assert.equal(termAsk(codex), false);
});
