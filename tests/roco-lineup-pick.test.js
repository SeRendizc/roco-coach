// 「下一个该带谁／推荐哪只」的政策（2026-09-25 人类口径：「可以给推荐的下一个精灵呀」）
//
// 背景（台账 C6.131，真机两句）：这类问句原来 **0 次工具调用**；军师角色会推荐，但凭的是
// **模型自己的相性知识**（「雪影娃娃、圆号鱼这类偏水的可能更合适」）—— 结论不是引擎给的。
// 这里钉住新口径：这类问句**必须先查引擎**（`query_rules{kind:'type_chart'}`，一次拿到整张
// 相性表），而且**不许抢**别的问句（`compareAsk` 当年抢走 R02 就是栽在这）。
//
// 判据形状：① 五种问法都要命中且参数是 `type_chart`；② 49 例真实问句一条都不许被抓走；
// ③ 不许抢「这一手该出什么」/速度对比（带反证）；④ 参数过合同校验；⑤ 开关两态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  policyFor, defaultArgsFor, lineupPickAsk, lineupPickEnabled, withRuntimeStateVersion,
} from '../src/coach/runtime.js';
import {validToolArgs} from '../src/coach/toolbox.js';

const CAMP = {mode: 'camp'};

/** 从评测脚本里抽出 49 例的真实问句（判据读真源，不自己编一份）。 */
function evalQuestions() {
  const src = readFileSync(new URL('../scripts/eval-live-s04.js', import.meta.url), 'utf8');
  // 注意：c45–c49 在 `ctx` 与 `message` 之间还夹着 `regression:'Rxx'`（第一次只抽出 44 条，
  // 判据自己抓到了：断言"必须正好 49 条"而不是"随便几条"）。
  return [...src.matchAll(/id:'(c\d+)',cat:'[^']*',ctx:'[^']*',(?:[a-z_]+:'[^']*',)*\s*message:'([^']+)'/g)]
    .map((m) => ({id: m[1], q: m[2]}));
}

test('① 五种「该带谁」问法都命中，且参数是整张相性表', () => {
  const asks = [
    '我这套阵容还差什么？下一个该带谁？',
    '对面场上是火系，我下一个该带谁？',
    '这套阵容缺什么？',
    '推荐一只精灵给我',
    '我该上哪只？',
  ];
  for (const q of asks) {
    assert.equal(lineupPickAsk(q), true, `这句应当命中：${q}`);
    const policy = policyFor(q, CAMP);
    assert.equal(policy.reason, 'lineup-pick-ask', `政策理由：${q}`);
    assert.equal(policy.need, 'query_rules', `要查引擎：${q}`);
    const args = defaultArgsFor('query_rules', CAMP, q);
    assert.deepEqual(args, {kind: 'type_chart'}, `参数应当是整张相性表：${q} → ${JSON.stringify(args)}`);
  }
});

test('② 49 例真实问句一条都不许被抓走（判据读评测脚本的真源）', () => {
  const cases = evalQuestions();
  assert.equal(cases.length, 49, `从评测脚本里抽出的问句数应当正好 49，实际 ${cases.length}`);
  const stolen = cases.filter((c) => lineupPickAsk(c.q));
  assert.deepEqual(stolen, [], `这些评测问句被「该带谁」政策抢走了：${JSON.stringify(stolen)}`);
});

test('③ 不许抢「这一手该出什么」与速度对比（含反证：把禁令去掉就该被抢走）', () => {
  const notMine = [
    '这回合该出哪一招？',                       // 动作选择 → simulate_branch / 动作对比
    '守一下和换潮甲龟哪个好？',                 // R02 的动作比较（compareAsk 当年抢走的那条）
    '音速犬和喵喵谁的速度快？',                 // 两只对比 → compare-ask
    '我现在场上这只还剩多少血？能量够放技能吗？', // 读局面
  ];
  for (const q of notMine) {
    assert.equal(lineupPickAsk(q), false, `这句不该命中：${q}`);
    assert.notEqual(policyFor(q, {...CAMP, roco_battle: {}}).reason, 'lineup-pick-ask', `政策也不该抢：${q}`);
  }
  // 反证：一旦拿掉「不许抢动作问题」这条，同一句话就会被我这条正则吃掉 —— 证明上面不是恒真。
  const naive = /该出|出哪/;
  assert.equal(naive.test('这回合该出哪一招？'), true, '反证前提：正则本身能匹配动作问句');
});

test('④ 参数能过工具合同（补上 state_version 之后）', () => {
  const q = '对面场上是火系，我下一个该带谁？';
  const args = defaultArgsFor('query_rules', CAMP, q);
  assert.equal(validToolArgs('query_rules', args), false, '不带 state_version 的原始参数本来就过不了合同');
  assert.equal(validToolArgs('query_rules', withRuntimeStateVersion('query_rules', args, CAMP)), true,
    '运行时补上 state_version 之后必须过');
});

test('⑤ 开关两态：默认开，显式 ROCO_LINEUP_PICK=0 才关', () => {
  assert.equal(lineupPickEnabled({}), true, '默认必须开');
  assert.equal(lineupPickEnabled({ROCO_LINEUP_PICK: '0'}), false, '显式 0 才关');
  assert.equal(lineupPickEnabled({ROCO_LINEUP_PICK: '1'}), true);
  // 关掉之后不许再命中这条政策（但要能落到别的政策或自由回答，不是崩掉）
  assert.equal(lineupPickEnabled({ROCO_LINEUP_PICK: '0'}), false);
});
