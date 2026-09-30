// task-28（2026-09-30）· 军师通道那两处加固的判据：
//   ① `enforceBattleAdvice` 加**状态转移校验**（建议的行动必须在该状态合法 + 必须给理由与风险）
//   ② 360 字超长 ⇒ **结构化压缩**（保留四段结构），不是整段回退
//   ③ 反例场景：烈火战神**高压**（高能量 / 残血 / 对手克制）⇒ 必须给**保守分支**，不许自杀式建议
//
// 跑法：node --test tests/roco-battle-advice-legality.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceBattleAdvice, adviceLegalityReport, compressStructuredAnswer} from '../src/coach/runtime.js';
import {battleAdvice} from '../src/coach/coach-advice.js';

const ADVICE = {
  headline: '出「龙血」', reason: '对方残血，这一手能收尾', risk: '对面若防御则收不掉',
  actionLabel: '龙血', legalLabel: '龙血', actionKind: 'skill',
  action: {kind: 'skill', label: '龙血', energy: 3},
  evidence: {my: {name: '烈火战神', hp: 120, maxHp: 180, energy: 8},
    legal: [{legalActionId: 'a0', kind: 'skill', label: '龙血', energy: 3}]},
};

test('① 状态转移：每个建议行动都能在该状态复算出「合法/非法」，非法时理由点名到数量', () => {
  // 合法：不报任何理由
  assert.deepEqual(adviceLegalityReport(ADVICE), {
    ok: true, reasons: [], action: {legalActionId: 'a0', kind: 'skill', label: '龙血', energy: 3},
    state: {hp: 120, energy: 8, alive: true},
  });
  // 能量不足：2 < 5 ⇒ 非法，理由写清"要几点、现在几点"
  const lowEnergy = {...ADVICE, action: {kind: 'skill', label: '龙血', energy: 5},
    evidence: {my: {...ADVICE.evidence.my, energy: 2}, legal: [{legalActionId: 'a0', kind: 'skill', label: '龙血', energy: 5}]}};
  const energyReport = adviceLegalityReport(lowEnergy);
  assert.equal(energyReport.ok, false);
  assert.match(energyReport.reasons.join(' '), /能量不够：这一手要 5 点，现在只有 2 点/);
  // 已经倒下 ⇒ 该走补位，不是出招
  const dead = {...ADVICE, evidence: {my: {...ADVICE.evidence.my, hp: 0}, legal: ADVICE.evidence.legal}};
  assert.equal(adviceLegalityReport(dead).ok, false);
  assert.match(adviceLegalityReport(dead).reasons.join(' '), /已经倒下/);
  // 行动不在这一回合的合法动作表里 ⇒ 非法（按 id 与标签两种回指都找不到）
  const absent = {...ADVICE, evidence: {my: ADVICE.evidence.my, legal: [{legalActionId: 'a9', kind: 'guard', label: '防御'}]}};
  assert.equal(adviceLegalityReport(absent).ok, false);
  assert.match(adviceLegalityReport(absent).reasons.join(' '), /不在这一回合的合法动作表里/);
  // 建议本身没给理由/风险 ⇒ 也算不合格（不能只贴一个行动标签）
  assert.equal(adviceLegalityReport({...ADVICE, reason: '', risk: ''}).ok, false);
  assert.equal(adviceLegalityReport(null).ok, false);
});

test('①-b 只贴标签 / 非法建议会被换成确定性正文；点了名且给了理由与风险才放行', () => {
  // 只贴标签（正文有名字，但建议本身说不出理由与风险）⇒ 必须介入
  const silent = enforceBattleAdvice({...ADVICE, reason: '', risk: ''}, '出「龙血」。');
  assert.equal(silent.enforced, true);
  assert.match(String(silent.reason), /advice-state-transition/);
  // 非法（能量不够）⇒ 介入，理由里带那句话
  const illegal = enforceBattleAdvice({...ADVICE, action: {kind: 'skill', label: '龙血', energy: 9}}, '出「龙血」。');
  assert.equal(illegal.enforced, true);
  assert.match(String(illegal.reason), /能量不够/);
  // 合法 + 正文覆盖了理由与风险 ⇒ 放行（模型换说法没关系）
  const good = enforceBattleAdvice(ADVICE, '出「龙血」：因为对方残血；风险是对面防御就收不掉。');
  assert.equal(good.enforced, false);
  assert.equal(good.text, '出「龙血」：因为对方残血；风险是对面防御就收不掉。');
  // 反证：没有建议对象时永远放行（营地/图鉴那些链路不受影响）
  assert.equal(enforceBattleAdvice(null, '随便一句').enforced, false);
});

test('② 高压反例：烈火战神 12/180 血、8 能量、对面水系克制 ⇒ 必须给保守分支', () => {
  const battle = {
    phase: 'battle', turn: 9, result: null, self_active: 0,
    self: [{name: '烈火战神', hp: 12, max_hp: 180, energy: 8, alive: true, types: ['火系']},
      {name: '水蓝蓝', hp: 120, max_hp: 150, energy: 6, alive: true, types: ['水系']}],
    foe: [{name: '水晶海豚', hp: 90, max_hp: 150, energy: 7, alive: true, types: ['水系']}],
    foe_bench: [],
    legal: [{kind: 'skill', label: '烈焰冲撞', skill: {name: '烈焰冲撞', energy: 4, power: 110, element: '火系'}},
      {kind: 'skill', label: '守住', skill: {name: '守住', energy: 2, power: 0, element: '普通系'}},
      {kind: 'switch', label: '换上第2位'}],
  };
  const advice = battleAdvice({battle, plan: null});
  assert(advice, '高压局面必须给得出建议（不许静默）');
  // 保守：不是"继续用火系硬打"，而是换人/守住这一类的保命分支
  assert.notEqual(advice.actionKind, 'skill', `高压下不该建议出招：${advice.headline}`);
  assert.match(String(advice.headline), /换|守/, `保守分支要点名换人或守住：${advice.headline}`);
  assert(!/烈焰冲撞/.test(String(advice.headline)), '不许把会被克制的火系招当首选');
  // 风险必须说清代价（换上来那只也要吃这一下）
  assert.match(String(advice.risk), /吃|风险|回合/, `风险要写清：${advice.risk}`);
  // 状态转移到这一份真实建议上必须过（不许误判真建议为非法）
  const report = adviceLegalityReport(advice);
  assert.equal(report.ok, true, `真建议不该被判非法：${report.reasons.join('；')}`);
});

test('③ 超长 ⇒ 结构化压缩：四段段头一个不丢，且不是整段回退', () => {
  const section = (label, body) => `${label}${body}`;
  const long = section('关键回合：', '第10回合水蓝蓝143血被打到0血，对面烈火战神还剩160血，你出了一招却没有收益。'.repeat(3))
    + section('当时合法替代：', '当时还能选换上烈火战神或防御，两者的事前评分差9分，不是结果反推。'.repeat(3))
    + section('下一局试哪一手：', '遇到同一个回合，先把换上烈火战神和继续输出各按事前条件比一遍再决定。'.repeat(3))
    + section('风险：', '事前一回合的信息不代表换一手就更好，结果已经发生，用它反推结论是错的。'.repeat(3));
  assert(long.length > 360, `夹具本身要超长（现在 ${long.length}）`);
  const shrunk = compressStructuredAnswer(long, {limit: 360});
  assert.equal(shrunk.ok, true);
  assert.equal(shrunk.compressed, true, '超长时必须真的压缩，而不是原样返回');
  assert(shrunk.text.length <= 360, `压缩后必须 <=360：${shrunk.text.length}`);
  for (const label of ['关键回合：', '当时合法替代：', '下一局试哪一手：', '风险：']) {
    assert(shrunk.text.includes(label), `压缩丢了段头「${label}」：${shrunk.text}`);
  }
  assert(shrunk.kept.length >= 4, `段头要全留：${JSON.stringify(shrunk.kept)}`);
  assert(shrunk.dropped.length > 0, '压缩必须记账（哪一段砍了多少字）');
  // 不超长时**不做任何事**（原样返回，不算压缩）
  const short = compressStructuredAnswer('关键回合：第10回合。', {limit: 360});
  assert.equal(short.compressed, false);
  assert.equal(short.text, '关键回合：第10回合。');
  // 认不出段头 ⇒ 不猜结构，交回调用方降级
  const noHeader = compressStructuredAnswer('啊'.repeat(400), {limit: 360});
  assert.equal(noHeader.ok, false);
});

test('⑤ 真机形状：引擎说"必须补位"那一支交付自己的正文 ⇒ 不许记假回执（2026-09-30 实测）', () => {
  // 逐字来自真实链路（`tmp/u04-repl-probe.mjs`，turn8 / phase=replace / needsReplacement=['player']）：
  //   `advice.kind='replace-required'` · `legalActionId=null` 而 `advice.action.legalActionId='switch#1'` ·
  //   `evidence.my=null` · **没有 `risk` 字段**（所以状态转移那道闸会判它"缺主要风险"）
  const real = {
    kind: 'replace-required', headline: null, actionLabel: null,
    legalLabel: '换上第2位', legalActionId: null,
    action: {legalActionId: 'switch#1', legalIndex: 0, kind: 'switch', label: '换上第2位', display: '海豹船长'},
    reason: '场上的伙伴已经倒下，这一手只能补位，没有别的选择',
    text: '「寂灭骨龙」倒了，换「海豹船长」顶上：对面「黑猫巫师」还在场，补位别一上来就挨打',
    evidence: {my: null, legal: [{legalActionId: 'switch#1', kind: 'switch', label: '换上第2位'}]},
  };
  // 这道闸**单独判**会说不合格（缺 risk）—— 这是事实，不是 bug：
  assert.equal(adviceLegalityReport(real).ok, false);
  assert.match(adviceLegalityReport(real).reasons.join('；'), /主要风险/);
  // 但**交付的就是这份引擎正文** ⇒ 不许 enforced（否则回执会写「模型没点出那一手」= 假话）
  const same = enforceBattleAdvice(real, real.text);
  assert.equal(same.enforced, false, '交付引擎自己那份正文时不许记 enforced');
  assert.equal(same.reason, null);
  // 反证：模型**换了自己的话**去讲同一手 ⇒ 照样要过那两道闸（该判还得判）
  const model = enforceBattleAdvice(real, '你先换上一个人吧。');
  assert.equal(model.enforced, true, '模型没点出合法行动时仍然要保障');
});
