// 学习表问句（按名字）判据（2026-09-25）。
//
// **由来（产品路径实测）**：问「喵喵学得到哪些技能？」，`agentStop=policy-route-without-tools`
// —— 连工具循环都进不去，回答是「我这边没有喵喵的技能表」，**而引擎里就有**（16 个可学技能）。
// 两个原因叠在一起：① `codexFactAsk` 只认「<名字>的<字段>」这种句式，动词式的「学得到哪些技能」匹配不到；
// ② 学习表在引擎侧**只认 `pet_id`**（玩家说不出内部 id）—— 同 `kind=term` 那条，已补名字路径。
//
// 这一组钉：
//   ① 动词式问句触发、参数是 `{kind:'learnset',name}`；
//   ② **「X的学习表/技能表/技能池」也要走 learnset**（`codexTarget` 原来一律给 `kind:'pet'`）；
//   ③ **回归钉**：`CODEX_FIELD` 必须是**捕获组** —— 它以前写成 `(?:…)`，于是
//      `m[2]===undefined`，「威力/能耗 → kind=skill」那段分支**从来没生效过**（恒为假）；
//   ④ fail closed：取不出名字 / 名字明显不是宠物（「战斗中」）⇒ 不构造参数；
//   ⑤ 不误伤 49 例里那些非学习表问句；⑥ 开关两态。
// 每条配必红反证。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {codexFactAsk, codexTarget, defaultArgsFor, learnsetAsk, learnsetTarget, policyFor}
  from '../src/coach/runtime.js';

const CAMP = {mode: 'camp', profile: {lineup: [], pets: []}};

test('① 动词式问句要触发，参数是 {kind:learnset,name}', () => {
  const cases = [
    ['喵喵学得到哪些技能？', '喵喵'],
    ['音速犬能学什么技能', '音速犬'],
    ['喵喵可以学哪些招式', '喵喵'],
    ['我在练习场，想问下：喵喵学得到哪些技能？', '喵喵'],
  ];
  for (const [question, name] of cases) {
    assert.equal(learnsetAsk(question), true, `该触发却没触发：${question}`);
    assert.deepEqual(learnsetTarget(question), {kind: 'learnset', name, compact: true}, `名字取错：${question}`);
    const policy = policyFor(question, CAMP);
    assert.equal(policy.need, 'query_rules', `政策应给出 query_rules：${question}`);
    assert.equal(policy.reason, 'learnset-ask');
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, question), {kind: 'learnset', name, compact: true});
  }
});

test('①b 「学得到**的**技能里，哪个威力最高？」也要触发（少了这个"的"整句匹配不上）', () => {
  // 学习表回执里**每条技能都带 `power`**，所以模型能自己在回执里挑最大 —— 实测：
  // 「喵喵学得到的技能里，哪个威力最高？」→ 1 次 learnset 调用 →「仙人掌刺击，基础威力150」（与引擎真值一致）。
  const question = '喵喵学得到的技能里，哪个威力最高？';
  assert.equal(learnsetAsk(question), true, '这句话要认出来');
  assert.deepEqual(learnsetTarget(question), {kind: 'learnset', name: '喵喵', compact: true});
  assert.equal(policyFor(question, CAMP).reason, 'learnset-ask', '政策要给出学习表');
  // 反证：把"的"去掉照旧要认（别为了这一族把原来那条弄坏）
  assert.deepEqual(learnsetTarget('喵喵学得到哪些技能？'), {kind: 'learnset', name: '喵喵', compact: true});
});

test('② 「X的学习表 / 技能表 / 技能池」也要走 learnset（不是 kind:pet）', () => {
  for (const field of ['学习表', '技能表', '技能池']) {
    const question = `喵喵的${field}`;
    assert.equal(codexFactAsk(question), true, `图鉴政策要认这句：${question}`);
    assert.equal(policyFor(question, CAMP).reason, 'codex-fact');
    assert.deepEqual(codexTarget(question), {kind: 'learnset', name: '喵喵', compact: true},
      `${field} 应查学习表（原来一律给 kind:pet，引擎只会回精灵记录）`);
  }
  // 对照：别的字段照旧
  assert.deepEqual(codexTarget('喵喵的种族值是多少？'), {kind: 'pet', name: '喵喵'});
});

test('③ 回归钉：`CODEX_FIELD` 必须是捕获组（那段 skill 分支曾经恒不生效）', () => {
  // 行为钉：威力/能耗 → kind:skill
  assert.deepEqual(codexTarget('喵喵的威力是多少？'), {kind: 'skill', name: '喵喵'});
  assert.deepEqual(codexTarget('音速犬的能耗是几？'), {kind: 'skill', name: '音速犬'});
  // 结构钉：读源码，字段表必须是 `(…)` 而不是 `(?:…)`
  const src = readFileSync(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((row) => row.includes('const CODEX_FIELD=')) || '';
  assert.ok(line.includes('CODEX_FIELD=/(种族值'), `CODEX_FIELD 必须是捕获组：${line.slice(0, 80)}`);
  // 反证：把探测器对准非捕获组那份写法，必须报出来
  const isCapturing = (code) => /CODEX_FIELD=\/\([^?]/.test(code);
  assert.equal(isCapturing('const CODEX_FIELD=/(?:种族值|速度)/;'), false, '探测器本身必须能红');
  assert.equal(isCapturing(line), true, '探测器对真源码必须为真');
});

test('④ fail closed：取不出名字（含"名字明显不是宠物"）就不构造参数', () => {
  const vague = '这只能学哪些技能？';
  assert.equal(learnsetAsk(vague), true, '仍要认得出这是学习表问句');
  assert.equal(learnsetTarget(vague), null, '指代不是名字');
  assert.equal(defaultArgsFor('query_rules', CAMP, vague), null);
  // 实测误判：「战斗中学得到技能吗？」会被解析成一只叫「战斗中」的精灵
  assert.equal(learnsetTarget('战斗中学得到技能吗？'), null, '开头不是宠物名的词要挡住');
  assert.equal(learnsetTarget('能学哪些技能？'), null, '压根没名字');
  // 反证：正常那句必须能构造出来（判据不是恒假）
  assert.ok(learnsetTarget('喵喵学得到哪些技能？'));
});

test('⑤ 不误伤：49 例里的非学习表问句一条都不许被抓走', () => {
  const notLearnset = [
    '技能有冷却时间吗？', '技能和道具一共有几种？分别是什么？', '火属性克制什么属性？',
    '能量上限是几个豆？', '防御能减伤多少？', '我这六只谁速度最快？',
    '喵喵的种族值是多少？', '「应对」这条术语是怎么定义的？',
  ];
  for (const question of notLearnset) {
    assert.notEqual(policyFor(question, CAMP).reason, 'learnset-ask', `误伤了：${question}`);
  }
  // 反证：真的学习表问句必须被抓到（否则⑤是恒真判据）
  assert.equal(policyFor('喵喵学得到哪些技能？', CAMP).reason, 'learnset-ask');
});

test('⑥ 开关：显式 ROCO_LEARNSET_LOOKUP=0 才关（默认开）', () => {
  const question = '喵喵学得到哪些技能？';
  const previous = process.env.ROCO_LEARNSET_LOOKUP;
  try {
    delete process.env.ROCO_LEARNSET_LOOKUP;
    assert.equal(policyFor(question, CAMP).reason, 'learnset-ask', '不设变量 = 开');
    assert.ok(defaultArgsFor('query_rules', CAMP, question));
    process.env.ROCO_LEARNSET_LOOKUP = '0';
    assert.notEqual(policyFor(question, CAMP).reason, 'learnset-ask', '显式 0 必须真的关掉');
    assert.equal(defaultArgsFor('query_rules', CAMP, question), null, '关掉后不许再构造参数');
  } finally {
    if (previous === undefined) delete process.env.ROCO_LEARNSET_LOOKUP;
    else process.env.ROCO_LEARNSET_LOOKUP = previous;
  }
});
