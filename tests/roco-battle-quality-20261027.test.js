import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {battleAdvice, adviceForView, coachAdvice} from '../src/coach/coach-advice.js';
import {rocoGameView} from '../src/coach/roco-experience.js';

// 决策反例：只改变当前血线/合法能耗，建议应改变；这些是受控例，不是真人数据。
function situation(hp = 40) {
  return {battle_id: 'public-quality-case', turn: 5, state_version: 11, phase: 'battle', result: null,
    self_active: 0, self_energy_max: 10, needs_replacement: [],
    self: [{pet_id: 'ours', name: '我方伙伴', hp: 200, max_hp: 200, energy: 8}],
    foe: [{pet_id: 'foe', name: '对手伙伴', hp, max_hp: 250, energy: 2}],
    legal: [{kind: 'skill', label: '重招', skill: {name: '重招', energy: 5}},
      {kind: 'skill', label: '轻招', skill: {name: '轻招', energy: 1}},
      {kind: 'switch', label: '换上第2位'}]};
}
function plan(hp = 40) {
  return {state_version: 11, recommendation: '重招', recommendation_stable: true,
    damage_preview: {available: true, foe_hp: hp,
      samples: [{label: '重招', min: 150, max: 160}, {label: '轻招', min: 50, max: 60}]}};
}

test('两招都按估算够收：选择省能量的一招，并讲清真实取舍', () => {
  const advice = battleAdvice({battle: situation(), plan: plan()});
  assert.equal(advice.actionLabel, '轻招');
  assert.match(advice.comparison, /分别耗 1、5 能量/);
  assert.match(advice.comparison, /两招按估算都够收，先留住能量/);
  assert.equal(advice.evidence.comparison.foeHp, 40);
  assert.match(advice.text, /未核验公式/);
  assert.match(advice.playerSummary, /先出「轻招」.*对手伙伴.*40 血/);
  assert.ok(advice.playerSummary.length < 280);
  assert.doesNotMatch(advice.playerSummary, /首选行动：|引擎给的合法动作|我不会自动替你出招/);
});

test('同一合法表改成高血线：轻招不够时才用重招，解释对照差别', () => {
  const advice = battleAdvice({battle: situation(140), plan: plan(140)});
  assert.equal(advice.actionLabel, '重招');
  assert.match(advice.comparison, /对面剩 140 血，前者按估算够收，后者不够/);
});

test('节省能量不能覆盖规划器已经发现的重大损失分支', () => {
  const current = plan();
  current.robustness = {material_loss_actions: [{action: '轻招', worst: -2}]};
  const advice = battleAdvice({battle: situation(), plan: current});
  assert.equal(advice.actionLabel, '重招');
  assert.doesNotMatch(advice.comparison, /先留住能量/);
});

test('同一局面重排合法表：首选身份与省能量结论保持稳定', () => {
  const battle = situation();
  const before = battleAdvice({battle, plan: plan()});
  battle.legal.reverse();
  const after = battleAdvice({battle, plan: plan()});
  assert.equal(before.legalActionId, after.legalActionId);
  assert.equal(before.comparison, after.comparison);
});

test('只给了一招能耗：未知不能当零能耗，也不能声称已经比过资源', () => {
  const battle = situation();
  delete battle.legal[0].skill;
  const advice = battleAdvice({battle, plan: plan()});
  assert.equal(advice.actionLabel, '重招');
  assert.doesNotMatch(advice.comparison, /分别耗|先留住能量/);
});

test('实际备选要有可比较的依据，不能被合法表开头的无估算招挤掉', () => {
  const battle = situation();
  battle.legal.unshift({kind: 'skill', label: '未知招'});
  const advice = battleAdvice({battle, plan: plan()});
  assert.equal(advice.alternates[0].label, '重招');
  assert.match(advice.alternates[0].note, /150~160.*5 能量/);
});

test('只有当前推荐的已算风险分支才能作为具体风险，不猜对手下一招', () => {
  const current = plan(250);
  // Python service 的聚合回执实际字段；直接planner则是top_risks。
  current.risk = {worst_seed_risks: [{opponent_action: '对手防御', score: -0.2}]};
  const advice = battleAdvice({battle: situation(250), plan: current});
  assert.match(advice.risk, /对手防御.*可能分支/);
  current.recommendation = '不存在的招';
  const other = battleAdvice({battle: situation(250), plan: current});
  assert.doesNotMatch(other.risk, /对手防御/);
});

test('跨版本估算、不同目标血线的旧伤害都不能混进当前比较', () => {
  const stale = {...plan(), state_version: 10};
  const advice = battleAdvice({battle: situation(), plan: stale});
  assert.equal(advice.evidence.estimate, null);
  assert.equal(advice.comparison, null);
  assert.doesNotMatch(advice.text, /150~160|50~60/);
  const differentTarget = battleAdvice({battle: situation(100), plan: plan(40)});
  assert.equal(differentTarget.evidence.estimate, null);
  assert.equal(differentTarget.comparison, null);
});

test('没有估算时保留明确未知；不以面板威力或随机换句伪装结论', () => {
  const battle = situation();
  battle.legal[0].skill.power = 1;
  battle.legal[1].skill.power = 9999;
  const a = battleAdvice({battle});
  const b = battleAdvice({battle});
  assert.equal(a.text, b.text);
  assert.equal(a.comparison, null);
  assert.match(a.reason, /没有可比较的伤害估算/);
  assert.equal(a.evidence.estimate, null);
});

test('真实原生回执：速度检波器不再覆盖同局同版的完整规划，两个入口一致', () => {
  const row = JSON.parse(readFileSync(new URL('./fixtures/roco-battle-quality-native-20261027.json', import.meta.url)));
  const view = {...row.view, battle_id: row.plan.battle_id};
  const explicit = adviceForView(view, row.plan);
  const proactive = coachAdvice({game: rocoGameView(view), plan: row.plan});
  assert.equal(explicit.action.label, row.plan.recommendation);
  assert.equal(proactive.action.label, row.plan.recommendation);
  assert.notEqual(explicit.action.label, '防御');
  assert.equal(explicit.evidence.source, 'public-planner');
});

test('篡改、缺少版本、非法、超时或零分支不能冒充完整规划压过局面事实', () => {
  const row = JSON.parse(readFileSync(new URL('./fixtures/roco-battle-quality-native-20261027.json', import.meta.url)));
  const view = {...row.view, battle_id: row.plan.battle_id};
  const variants = [
    {...row.plan, battle_id: 'another-match'},
    {...row.plan, battle_id: undefined},
    {...row.plan, state_version: 999},
    {...row.plan, state_version: undefined},
    {...row.plan, recommendation: '非法动作'},
    {...row.plan, timed_out: true},
    {...row.plan, branches_evaluated: 0},
  ];
  for (const plan of variants) {
    const advice = adviceForView(view, plan);
    assert.notEqual(advice.evidence.source, 'public-planner');
    assert.ok(view.legal.some(one => one.kind === advice.action.kind && one.label === advice.action.label));
  }
  const foreign = adviceForView({...view, battle_id: undefined}, row.plan);
  assert.notEqual(foreign.evidence.source, 'public-planner');
  assert.equal(foreign.evidence.plan_recommendation, null);
  const unbound = adviceForView(view, {...row.plan, battle_id: undefined});
  assert.equal(unbound.evidence.plan_recommendation, null);
  assert.equal(unbound.evidence.estimate, null);
  assert.doesNotMatch(unbound.reason, /推荐在多个分析种子里是稳的/);
});

test('双方无身份的旧估算必须显式降级，不继承成功、稳定推荐或分支的信用', () => {
  const row = JSON.parse(readFileSync(new URL('./fixtures/roco-battle-quality-native-20261027.json', import.meta.url)));
  const noIdentity = {...row.plan, battle_id: undefined, branches_evaluated: undefined};
  const estimate = adviceForView({...row.view, battle_id: undefined}, noIdentity);
  assert.equal(estimate.evidence.source, 'legacy-estimate');
  assert.equal(estimate.evidence.plan_recommendation, null);
  assert.equal(estimate.evidence.plan_branches, null);
  assert.doesNotMatch(estimate.reason, /推荐在多个分析种子里是稳的/);
  const pretendingComplete = adviceForView({...row.view, battle_id: undefined}, {...noIdentity, branches_evaluated: 96});
  assert.notEqual(pretendingComplete.evidence.source, 'public-planner');
  assert.equal(pretendingComplete.evidence.estimate, null);
  const oneIdentityOnly = adviceForView({...row.view, battle_id: 'current-match'}, noIdentity);
  assert.equal(oneIdentityOnly.evidence.estimate, null);
  assert.equal(oneIdentityOnly.evidence.plan_recommendation, null);
});
