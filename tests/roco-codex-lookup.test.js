// 图鉴查询支线（`ROCO_CODEX_LOOKUP`）的判据 + 必红反证。
//
// 为什么需要它：图鉴 622 只里，**不在场上的那 618 只**今天在小芽这里够不着 ——
// 真机实测（`node scripts/eval-live-s04.js --slice wrong-pet`）：
//   ·「喵喵的种族值是多少？」→ 0 次工具调用、路由到陪练，回答「我这边没有数据」；
//   ·「火花的种族值」→ 被当成**技能**火花；「寂灭骨龙的防御」→ 被当成**技能**防御。
//
// 这份判据钉四件事：
//   ① 抽取：`<名字>的<图鉴字段>` → `{kind:'pet'|'skill', name}`，且「火花这只」要剥掉「这只」；
//   ② **零误判**：现有 49 例里那些「不该变成图鉴查询」的问法一条都不许命中（这是防回归的关键）；
//   ③ 开关：off 时 `policyFor` 与改动前**完全一致**；on 时才多出 `query_rules`；
//   ④ 参数：`defaultArgsFor('query_rules')` 给的是**名字**（按名字查，不编 id），取不出来返回 null。
// 必红反证：把开关关掉，③ 的「多出 query_rules」必须不成立；把字段表换成空，① 必须红。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codexFactAsk, codexTarget, codexLookupEnabled, policyFor, defaultArgsFor, withRuntimeStateVersion,
} from '../src/coach/runtime.js';
import {validToolArgs, TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {newProfile} from '../src/game/progression.js';

/** 现有 49 例里**不许**被当成图鉴查询的问法（逐条摘自 `scripts/eval-live-s04.js`）。 */
const MUST_NOT_MATCH = [
  '我现在场上这只还剩多少血？能量够放技能吗？',
  '对方还剩多少药？我要不要换宠？',
  '第5回合到底发生了什么？我想知道当时的能量变化。',
  '能量上限是几个豆？',
  '防御能减伤多少？',
  '回复药能回多少血？比防御更划算吗？',
  '技能和道具一共有几种？分别是什么？',
  '火属性克制什么属性？',
  '宠物倒下后可以免费换宠补位吗？算整局失败吗？',
  '速度快的宠物一定先出手吗？',
  '有属性本系加成吗？倍率是多少？',
  '5豆算满豆吗？',
  '小测一下防御的用法。',
  '这回合我想稳一点，你先看看局面再告诉我。',
  '守一下和换潮甲龟哪个好',
  '总结整局：这局我输在哪？',
];

test('技能字段问句：「<宠物>的<技能>威力/能耗多少」要查技能（2026-09-25 实测缺口）', () => {
  // 改前：「喵喵的叶绿光束威力多少？能耗多少？」**一次都不调** —— `CODEX_ASK` 只认
  // 「<名字>的<字段>」，而这里字段跟在**技能名**后面 ⇒ 回答是「我这边没有可靠数据，不能瞎报」。
  const cases = [
    ['喵喵的叶绿光束威力多少？能耗多少？', '叶绿光束'],
    ['音速犬的翅刃威力是多少', '翅刃'],
    ['喵喵的藤绞能耗几', '藤绞'],
  ];
  for (const [question, skill] of cases) {
    assert.equal(codexFactAsk(question), true, `该触发却没触发：${question}`);
    assert.deepEqual(codexTarget(question), {kind: 'skill', name: skill}, `该查技能：${question}`);
  }
  // 反证：**问"哪个技能威力最高"不是查某一只技能**（那是学习表题，交给学习表政策）
  assert.equal(codexTarget('威力最高的技能是哪个？'), null);
  assert.equal(codexTarget('喵喵学得到的技能里，哪个威力最高？'), null);
  // 反证：宠物字段问句照旧归 pet（顺序没被抢）
  assert.deepEqual(codexTarget('喵喵的种族值是多少？'), {kind: 'pet', name: '喵喵'});
});

test('① 抽取：名字与字段都要取对，「火花这只」要剥掉「这只」', () => {
  assert.deepEqual(codexTarget('喵喵的种族值是多少？'), {kind: 'pet', name: '喵喵'});
  assert.deepEqual(codexTarget('水蓝蓝的速度是多少？'), {kind: 'pet', name: '水蓝蓝'});
  assert.deepEqual(codexTarget('火花这只的种族值大概多少？'), {kind: 'pet', name: '火花'});
  assert.deepEqual(codexTarget('寂灭骨龙的防御是多少？'), {kind: 'pet', name: '寂灭骨龙'});
  assert.deepEqual(codexTarget('请问鸭吉吉的种族值是多少？'), {kind: 'pet', name: '鸭吉吉'});
  assert.equal(codexFactAsk('喵喵的种族值是多少？'), true);
});

test('② 零误判：现有 49 例里不该变成图鉴查询的问法一条都不许命中', () => {
  const hit = MUST_NOT_MATCH.filter((text) => codexFactAsk(text));
  assert.deepEqual(hit, [], `这些问法被误判成图鉴查询：${JSON.stringify(hit)}`);
});

test('③ 开关：off 时政策与改动前一致，on 时才多出 query_rules', () => {
  const text = '喵喵的种族值是多少？';
  assert.equal(codexLookupEnabled({}), true, '2026-09-25 起默认**开**（不设变量 = 开）');
  assert.equal(codexLookupEnabled({ROCO_CODEX_LOOKUP: '0'}), false, '显式 "0" 才算关');
  const before = process.env.ROCO_CODEX_LOOKUP;
  try {
    process.env.ROCO_CODEX_LOOKUP = '0';
    assert.equal(policyFor(text, {mode: 'camp'}).need, null,
      '关档时图鉴问句的政策必须与改动前一样（state-in-packet，不调工具）');
    process.env.ROCO_CODEX_LOOKUP = '1';
    assert.equal(policyFor(text, {mode: 'camp'}).need, 'query_rules',
      '开档时图鉴问句必须要求查规则服务');
    // 对照组：同一档位下，陪练/寒暄仍然不调工具。
    assert.equal(policyFor('你好小芽，随便聊聊', {mode: 'camp'}).need, null, '寒暄照旧不调工具');
  } finally {
    if (before === undefined) delete process.env.ROCO_CODEX_LOOKUP;
    else process.env.ROCO_CODEX_LOOKUP = before;
  }
});

test('④ 参数：按名字查（不编 id），取不出来就不给参数', () => {
  assert.deepEqual(defaultArgsFor('query_rules', {}, '喵喵的种族值是多少？'),
    {kind: 'pet', name: '喵喵'});
  assert.equal(defaultArgsFor('query_rules', {}, '第5回合发生了什么？'), null,
    '不是图鉴问句时必须返回 null —— 让上层 fail closed，而不是塞一个猜的参数');
});

test('④b 营地页的**真形状**存档（pets 是对象）不许把这一层打崩', () => {
  // 2026-09-25 实测（结构契约的反证喂了真形状才暴露）：营地页送来的 `profile` 是存档本体
  // ——`pets` 是 `{fox:{level,xp,points},…}` 这种**对象**；而页面名单那条路送的是数组。
  // 原来 `nameIsElementAsk` 那一支写的是 `[...(context.profile?.pets??[])]`，对象一进来就
  // `TypeError: … is not iterable` ⇒ `defaultArgsFor` 直接抛 ⇒ `/api/coach` 500
  // （只有开了图鉴查询那一档才走到，所以一直是隐性的）。名字要能按 id 去 `SPECIES` 查出来。
  const save = newProfile();
  const context = {mode: 'camp', focus: 'fox', profile: save};
  assert.doesNotThrow(() => defaultArgsFor('query_rules', context, '潮甲龟是哪个系的？'),
    '真形状（pets 是对象）不许抛');
  assert.deepEqual(defaultArgsFor('query_rules', context, '潮甲龟是哪个系的？'),
    {kind: 'pet', name: '潮甲龟'}, '存档里的伙伴要按 id 查得到名字，才能判成宠物而不是技能');
  assert.deepEqual(defaultArgsFor('query_rules', context, '火花是哪个系的？'),
    {kind: 'skill', name: '火花'}, '不在存档里的名字仍按技能查（口径不变）');
  // 名单数组的形状照旧
  assert.deepEqual(defaultArgsFor('query_rules', {profile: {pets: [{id: 'x', name: '喵喵'}]}}, '喵喵是哪个系的？'),
    {kind: 'pet', name: '喵喵'});
});

test('必红反证：关掉开关，「多出 query_rules」必须不成立（证明开关真的在管这件事）', () => {
  const text = '喵喵的种族值是多少？';
  const before = process.env.ROCO_CODEX_LOOKUP;
  try {
    process.env.ROCO_CODEX_LOOKUP = '1';
    assert.equal(policyFor(text, {mode: 'camp'}).need, 'query_rules');
    process.env.ROCO_CODEX_LOOKUP = '0';
    assert.equal(policyFor(text, {mode: 'camp'}).need, null, '关档后必须回到 null');
    assert.equal(codexFactAsk(''), false, '空串不许命中');
  } finally {
    if (before === undefined) delete process.env.ROCO_CODEX_LOOKUP;
    else process.env.ROCO_CODEX_LOOKUP = before;
  }
});

test('⑤ 运行时补 state_version：不补的话 query_rules 连合同校验都过不了', () => {
  const ctx = {mode: 'camp'};
  const args = defaultArgsFor('query_rules', ctx, '喵喵的种族值是多少？');
  assert.deepEqual(args, {kind: 'pet', name: '喵喵'});
  // 反证（这就是产品链路上「图鉴查询发不出去」的机理）：
  assert.equal(validToolArgs('query_rules', args), false,
    '不带 state_version 时合同校验必须判false —— 这正是修前的实际行为');
  assert.equal(validToolArgs('query_rules', withRuntimeStateVersion('query_rules', args, ctx)), true,
    '运行时补上 state_version 之后必须能过校验');
  // 不该动的工具一个都不许动（加字段会让既有回执形状漂）。
  assert.deepEqual(withRuntimeStateVersion('search_rules', {query: 'x'}, ctx), {query: 'x'});
  // 已经给了版本号就不覆盖（调用方声明优先，运行时只补缺）。
  assert.deepEqual(withRuntimeStateVersion('query_rules', {...args, state_version: 7}, ctx),
    {...args, state_version: 7});
  assert.equal(TOOL_CONTRACTS.query_rules.arguments.state_version !== undefined, true,
    '前提：query_rules 的合同里 state_version 是必填项');
});
