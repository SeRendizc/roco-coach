// PVP **公平与博弈**的判据（B1/B2/B3）。规则正文见 `docs/roco/PVP-FAIRNESS-RULES.md`。
//
// 为什么这一组必须存在
// --------------------
// 人类原话：「这是洛克王国手游的规则，这是 pvp 大哥，**公平、博弈**知道吗？」；
// 「我方确定出招前**都不能知道对方动作**（这很重要！！）」。
// 这件事在代码里**已经有护栏**（引擎的隐藏键检测 + 教练侧的 `ROCO_HIDDEN_KEYS` + 正文的置信守卫），
// 但它们散在三个文件里、**没有一条判据是从"规则"这一层写的**。于是在这一组之前：
//   ① 把 `plan_actions` 契约里那句"不得含真实随机种子或对手待执行动作"删掉 —— 不会有东西红；
//   ② 把 `ROCO_HIDDEN_KEYS` 里的 `seed` 去掉 —— 只有"镜像一致性"那条会红，而它只比对两份常量是否相同；
//   ③ 模型说「**对面这回合一定会换宠**」—— 旧的 `unsupported-certainty` 只认"必胜/稳赢/100%"，**抓不到**。
// 下面六组判据就是补这三个洞，每条都配**反证**（构造一个违规输入，看它们会不会翻红）。
//
// 用法：`node --test tests/roco-pvp-fairness.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';

import {TOOL_CONTRACTS, validToolArgs} from '../src/coach/toolbox.js';
import {checkGroundedAnswer} from '../src/coach/runtime.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');
const RULES_DOC = 'docs/roco/PVP-FAIRNESS-RULES.md';

/** 一份**合法**的公开 planner state（只含公开字段；见 env.public_planner_state）。 */
const publicState = () => ({
  turn: 5,
  phase: 'battle',
  ruleset_id: 'mobile_s4_candidate_v3',
  state_version: 12,
  self: {active: 0, field: [{slot: 0, pet_id: 'pet_000001', hp: 88, max_hp: 120, energy: 6}]},
  foe: {active: 1, field: [{slot: 1, pet_id: 'pet_000002', hp: 91, max_hp: 130, energy: 4}],
    bench: [{slot: 0, pet_id: 'pet_000003', fainted: false}]},
});

test('① 契约文本钉死：交给教练的局面必须写明「公开 / 不含对手待执行动作与真实随机种子」', () => {
  const readState = TOOL_CONTRACTS.read_state.arguments.state?.description ?? TOOL_CONTRACTS.read_state.description;
  assert.match(String(readState), /不含电脑待执行动作或真实随机种子/,
    'read_state 的说明必须逐字保留"不含电脑待执行动作或真实随机种子"');
  const planState = TOOL_CONTRACTS.plan_actions.arguments.state;
  assert.match(String(planState), /公开/, 'plan_actions 的 state 必须写明是**公开** planner state');
  assert.match(String(planState), /不得含真实随机种子或对手待执行动作/,
    'plan_actions 的 state 必须逐字保留"不得含真实随机种子或对手待执行动作"');
});

test('② 隐藏键在各种写法与**任意深度**下都被拒（递归检查真的在跑）', () => {
  const hiddenSamples = ['seed', 'trueSeed', 'rngSeed', 'random_seed', 'opponentAction', 'opponent_pending_action',
    'pendingAction', 'hiddenState', 'privateState', 'opponentPrivateState', 'pendingEnemyAction', 'replaceQueue'];
  for (const key of hiddenSamples) {
    // 顶层
    assert.equal(validToolArgs('plan_actions', {state: {...publicState(), [key]: 12345}, state_version: 12}), false,
      `顶层出现 ${key} 必须被拒`);
    // 第二层（嵌在 foe 里）
    assert.equal(validToolArgs('plan_actions',
      {state: {...publicState(), foe: {...publicState().foe, [key]: 12345}}, state_version: 12}), false,
      `foe.${key} 必须被拒（递归检查）`);
    // 第三层（嵌在数组元素里）
    const deep = publicState();
    deep.foe.field[0] = {...deep.foe.field[0], [key]: 12345};
    assert.equal(validToolArgs('plan_actions', {state: deep, state_version: 12}), false,
      `foe.field[0].${key} 必须被拒（数组里的深层键也要查）`);
  }
});

test('② 的反证：合法公开 state 必须**被放行**（否则上面那条只是"一律拒绝"）', () => {
  assert.equal(validToolArgs('plan_actions', {state: publicState(), state_version: 12}), true,
    '纯公开字段的 state 必须通过 —— 否则隐藏键那条判据测不出东西');
  // 反证：往合法 state 里塞一个 seed ⇒ 从 true 变 false
  assert.equal(validToolArgs('plan_actions', {state: {...publicState(), seed: 7}, state_version: 12}), false,
    '同一份 state 加一个 seed 就必须从"放行"变"拒绝"');
});

test('③ B1：把出招顺序说反（"先看对手出招再…"）必须判不合格', () => {
  const bad = checkGroundedAnswer({text: '你可以先看对手出招，再决定自己用什么技能。'});
  assert.equal(bad.valid, false);
  assert.ok(bad.reasons.includes('simultaneous-action-order'), `实际 reasons=${JSON.stringify(bad.reasons)}`);
  // 反证：同一句话换成正确的顺序（同时决定）⇒ 必须合格
  const good = checkGroundedAnswer({text: '双方同时决定这一手；我先给你两个分支。'});
  assert.equal(good.valid, true, `不该误伤：${JSON.stringify(good.reasons)}`);
});

test('④ B3：四类「确定性预测对手动作」必须红', () => {
  const cases = [
    '对面这回合一定会换宠。',
    '对手肯定要守住，所以我建议你先聚能。',
    '对手必定会出招，你只能挨打。',
    '对面肯定会换宠，你先聚能。',
  ];
  for (const text of cases) {
    const out = checkGroundedAnswer({text});
    assert.equal(out.valid, false, `必须判不合格：${text}`);
    assert.ok(out.reasons.includes('opponent-action-certainty'),
      `${text} 必须报 opponent-action-certainty，实际 ${JSON.stringify(out.reasons)}`);
  }
});

test('⑤ B3 的反证：可能性 / 否定 / 条件句 / 过去事实 **一个都不许误伤**', () => {
  const allowed = [
    '对手可能会换宠，也可能继续攻击。',
    '对手不一定会换宠。',
    '我看不到对手这回合要做什么，只能给你两个分支。',
    '对面如果换宠，你这一手就打空了。',
    '对手刚才用了聚能。',
    // 2026-09-25：`先手` 已从"动作词"里去掉 —— 它是**公开的速度结果**，不是"猜对手动作"。
    '如果对手速度更快，对手一定先手。',
    '对手应该会换宠吧。',
    '对手要换宠了吗？',
    // 2026-09-25 金标 c23 实测的两处**误伤**（这一条守卫命中即把答案降级成模板，必须双向钉住）：
    //   ① 「需**要**一次实机对比」里的「要」不是"即将"；② 「把**它**变成可答的」里的「它」指的是话题、
    //   不是对手 —— 两者凑出了「它…要…技能」这条假预测。收窄后两处都不许再命中。
    '「本系加成」这一条本仓没有可引用的来源，所以我不给倍率。要把它变成可答的，需要一次实机对比（同系技能 vs 非本系技能的伤害读数）。',
  ];
  for (const text of allowed) {
    const out = checkGroundedAnswer({text});
    assert.ok(!out.reasons.includes('opponent-action-certainty'),
      `不许误伤（B3 允许说可能性/如实说不知道）：${text} ⇒ ${JSON.stringify(out.reasons)}`);
  }
});

test('⑥ 规则文档必须在，且写着三条规则与人类原话（删掉就红）', () => {
  assert.ok(existsSync(`${ROOT}${RULES_DOC}`), `规则文档必须存在：${RULES_DOC}`);
  const doc = read(RULES_DOC);
  for (const needle of ['B1', 'B2', 'B3', '公平、博弈知道吗', '我方确定出招前都不能知道对方动作',
    '不能读取对面任何非公开数据', '只许说可能性/分支']) {
    assert.ok(doc.includes(needle), `规则文档必须包含：${needle}`);
  }
  // 判据指向必须真实存在（文档里写的护栏位置不能是编的）
  for (const rel of ['roco/src/roco_env/env.py', 'src/coach/toolbox.js', 'src/coach/runtime.js']) {
    assert.ok(existsSync(`${ROOT}${rel}`), `文档引用的落点必须存在：${rel}`);
  }
});
