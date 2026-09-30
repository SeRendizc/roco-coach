// P0 第二批（2026-09-30）· 局中建议的**同一快照 + 对照收益**判据。
//
// 报告逐字（`评估-2026-09-30-0035/游戏系统综合测试报告-2026-09-30.md` L20）：
//   「小芽首选"换缇塔"，列了风险与备选…答复说缇塔 508 满血、**能量 10**，展开理由却说
//     **"它能量已经攒到 9"**；场上多彩方方 566 满血且有 **9 能量**，回答未给出换人的对照收益。」
// L36（P0 要求）：状态/候选/两手收益必须**绑定同一快照**；理由**不得引用另一个对象的能量**；
//   没有决策优势时**应诚实说无法区分**，而不是给似是而非的首选。
//
// 跑法：node --test tests/roco-advice-snapshot-consistency.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNumberSourceProblems, gateAdviceDelivery, adviceComparisonReport,
  adviceSnapshotOf, adviceLegalityReport,
} from '../src/coach/runtime.js';

// 报告那一局的形状：多彩方方 566/566、9 能量（场上）；缇塔 508/508、10 能量（后备）；对手迪莫 425/425。
const BATTLE = {
  phase: 'battle', turn: 2, result: null, self_active: 0,
  self: [{name: '多彩方方', hp: 566, max_hp: 566, energy: 9, alive: true, types: ['机械系']},
    {name: '缇塔', hp: 508, max_hp: 508, energy: 10, alive: true, types: ['机械系']}],
  foe: [{name: '迪莫', hp: 425, max_hp: 425, energy: 9, alive: true, types: ['光系']}],
  foe_bench: [],
  legal: [{kind: 'skill', label: '齿轮扭矩', skill: {name: '齿轮扭矩', energy: 3, power: 80, element: '机械系'}},
    {kind: 'skill', label: '防御', skill: {name: '防御', energy: 0, power: 0, element: '普通系'}},
    {kind: 'switch', label: '换上第2位'}],
};

test('① 数字同源：跨对象串号（拿场上那只的能量说后备那只）被点名，且只摘那一小段', () => {
  // 报告里那一处：同一个「它」指了缇塔，数字却是场上多彩方方的 9
  const bad = '首选行动：换缇塔上场。为什么是它：缇塔 508 血满着，缇塔它能量已经攒到 9（上限 10），这一轮随时放得出重招。主要风险：换上来照样要吃一下。';
  const found = findNumberSourceProblems({text: bad, battle: BATTLE});
  assert.equal(found.ok, false, '串号必须被判出来');
  assert.deepEqual(found.problems.map((one) => [one.name, one.kind, one.claimed, one.actual, one.borrowedFrom]),
    [['缇塔', 'energy', 9, 10, '多彩方方']],
    `要指名道姓：缇塔的能量被写成了 9（它的真值是 10），而 9 是场上多彩方方的：${JSON.stringify(found.problems)}`);
  // 同一份快照摊平后就是这三个读数（判据与实现同源）
  assert.deepEqual(adviceSnapshotOf(BATTLE).pets,
    [{name: '多彩方方', hp: 566, maxHp: 566, energy: 9, onField: true},
      {name: '缇塔', hp: 508, maxHp: 508, energy: 10, onField: false},
      {name: '迪莫', hp: 425, maxHp: 425, energy: 9, onField: true}]);
  // 交付闸：错数字那一小段被摘掉，**理由的其余部分留下**（不是整句删掉）
  const gated = gateAdviceDelivery({advice: {headline: '换缇塔上场', kind: 'switch-low-hp', alternates: []}, text: bad, battle: BATTLE});
  assert(!/缇塔[^。]*能量[^。]*9/.test(gated.text), `修后正文里不许再有那个错数字：${gated.text}`);
  assert.match(gated.text, /缇塔 508 血满着/, '对的那一半（血量）要留下');
  assert.match(gated.text, /换缇塔上场/, '首选行动那一句要留下');
  assert(gated.dropped.length === 1 && /能量已经攒到 9/.test(gated.dropped[0]), `摘掉的那一段要如实记账：${JSON.stringify(gated.dropped)}`);
  // 反证：数字本来就对 ⇒ 一个字都不许改
  const good = '首选行动：换缇塔上场。为什么是它：缇塔 508 血、10 能量，随时放得出重招。主要风险：换上来照样要吃一下。';
  assert.equal(findNumberSourceProblems({text: good, battle: BATTLE}).ok, true);
  assert.equal(gateAdviceDelivery({advice: {headline: '换缇塔上场', alternates: []}, text: good, battle: BATTLE}).text, good,
    '没串号就不许动玩家的正文');
  // 没有快照（营地/图鉴/纯事实链路）⇒ 闸门整条不参与
  assert.equal(gateAdviceDelivery({advice: {headline: 'x'}, text: bad, battle: null}).text, bad);
});

test('② 必须有对照收益：说不出来就得说"分不出"，不许硬给首选', () => {
  // 有估值/比较句 ⇒ 算给出了对照
  const withComparison = {
    headline: '出「齿轮扭矩」', kind: 'primary-action', actionLabel: '齿轮扭矩',
    reason: '这一手比防御多打 80', risk: '对面换人可以先躲掉（换人比技能先动）',
    alternates: [{label: '防御', note: '没有估算数据'}],
    evidence: {my: {name: '多彩方方', hp: 566, energy: 9}, estimate: {min: 70, max: 90}},
    text: '首选行动：出「齿轮扭矩」。收益：估 70~90，比防御划算。主要风险：对面换人躲掉。',
  };
  const okReport = adviceComparisonReport(withComparison, {text: withComparison.text, battle: BATTLE});
  assert.equal(okReport.hasComparison, true, '有估值/比较句就必须判"有对照"');
  assert.equal(okReport.indistinguishable, false);

  // 没有估值、也没有比较句、场上满血 ⇒ 这一手**确实分不出**
  const bare = {
    headline: '出「齿轮扭矩」', kind: 'primary-action', actionLabel: '齿轮扭矩',
    reason: '现在就能出手', risk: '打多少要打完才知道',
    alternates: [{label: '防御', note: '没有估算数据'}],
    evidence: {my: {name: '多彩方方', hp: 566, energy: 9}, estimate: null},
    text: '首选行动：出「齿轮扭矩」。为什么是它：现在就能出手。主要风险：打多少要打完才知道。',
  };
  const bareReport = adviceComparisonReport(bare, {text: bare.text, battle: BATTLE});
  assert.equal(bareReport.hasComparison, false, '只把选项念一遍不算对照');
  assert.equal(bareReport.indistinguishable, true, '满血 + 无估值 ⇒ 必须判"没有可区分的优势"');
  assert.match(bareReport.detail, /没有可区分的优势/);
});

test('③ 无法区分 ⇒ 交付的那一句不挑首选，而且报的是**同一份快照**的读数', () => {
  const bare = {
    headline: '出「齿轮扭矩」', kind: 'primary-action', actionLabel: '齿轮扭矩',
    reason: '现在就能出手', risk: '打多少要打完才知道',
    alternates: [{label: '防御', note: '没有估算数据'}],
    evidence: {my: {name: '多彩方方', hp: 566, energy: 9}, estimate: null},
    text: '首选行动：出「齿轮扭矩」。为什么是它：现在就能出手。',
  };
  const gated = gateAdviceDelivery({advice: bare, text: bare.text, battle: BATTLE});
  assert.equal(gated.indistinguishable, true);
  assert.doesNotMatch(gated.text, /首选行动/, `分不出的时候不许再给首选：${gated.text}`);
  assert.match(gated.text, /分不出|无法区分/, '要诚实说分不出');
  assert.match(gated.text, /566\/566 血/, '报的读数必须来自同一份快照');
  assert.match(gated.text, /9 能量/);
  assert.match(gated.text, /出招 \/ 防御 \/ 换人/, '要把三条候选摆出来，说清是它们之间分不出');
  // 反证：有对照时**不许**换成那句（否则就是把有信息量的判断说成"分不出"）
  const withComparison = {...bare, evidence: {my: bare.evidence.my, estimate: {min: 70, max: 90}},
    text: '首选行动：出「齿轮扭矩」。收益：估 70~90，比防御划算。'};
  const kept = gateAdviceDelivery({advice: withComparison, text: withComparison.text, battle: BATTLE});
  assert.equal(kept.indistinguishable, false);
  assert.equal(kept.text, withComparison.text);
});

test('④ 两条闸一起过：状态转移 + 同一快照，谁也不许把好的正文改坏', () => {
  const advice = {
    headline: '换缇塔上场', actionLabel: '缇塔', legalLabel: '换上第2位', actionKind: 'switch',
    kind: 'switch-low-hp', reason: '场上这只血量已经到底，后备里有更厚的伙伴',
    risk: '换人这一手虽然先动，但上来的那只照样要吃对面这一下',
    action: {kind: 'switch', label: '换上第2位'},
    alternates: [{label: '齿轮扭矩', note: '没有估算数据'}],
    evidence: {my: {name: '多彩方方', hp: 100, maxHp: 566, energy: 9},
      legal: [{legalActionId: 'switch#1', kind: 'switch', label: '换上第2位', energy: null}]},
    text: '首选行动：换缇塔上场。为什么是它：缇塔 508 血、10 能量，场上这只 100/566 血。主要风险：上来那只也要吃一下。',
  };
  const legality = adviceLegalityReport(advice);
  assert.equal(legality.ok, true, `状态转移要过：${legality.reasons.join('；')}`);
  const gated = gateAdviceDelivery({advice, text: advice.text, battle: BATTLE});
  assert.equal(gated.numberCheck.ok, true, `数字同源要过：${JSON.stringify(gated.numberCheck.problems)}`);
  assert.equal(gated.text, advice.text, '两条闸都过 ⇒ 正文一个字都不许改');
});
