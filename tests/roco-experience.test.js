// 手游公开视图 → coach 经验层的投影测试（`npm test` 的一部分）。
//
// 这一层存在的理由是「判据只有一处」：经验层的门控与评分只认一种形状，
// 手游那边的字段名不一样，所以在**一个**纯函数里投影一次，而不是让
// experience.js 同时认两种形状。纯函数能在这里被测，不用开浏览器。
//
// 三条必须钉住的：
//   ① 投影只搬运公开字段（后备血量不进投影，也就不会进提示文案）；
//   ② 门控结论来自真实 experience.js（不是这一层自己判的）；
//   ③ 陈旧判定只有一个入口，换一个 state_version 就必须作废。

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  rocoGameView,
  rocoPlanFeatures,
  rocoHintStale,
  rocoHintText,
  rocoLessonEntry,
  rocoIntervention,
  rocoInterventionText,
  rocoDamagePreviewText,
  ROCO_MODE,
} from '../src/coach/roco-experience.js';
import {interventionDetail,interventionFeaturesOfGame} from '../src/coach/experience.js';

const view = (over = {}) => ({
  battle_result: null,
  phase: 'battle',
  turn: 4,
  ruleset_id: 'roco-world-s4-2026-09-10',
  state_version: 11,
  self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 166, max_hp: 425, energy: 2, fainted: false}]},
  opponent: {
    active: 0, living_count: 2,
    field: {slot: 0, pet_id: 'pet_000190', name: '海豹船长', hp: 300, max_hp: 374, energy: 3, fainted: false},
    bench: [{slot: 1, pet_id: 'pet_000445', fainted: false}],
  },
  legal: [{kind: 'skill', label: '龙血', skill_id: 'skill_000750'}, {kind: 'item', item_id: '回复药', label: '使用回复药'}],
  ...over,
});

const session = (over = {}) => ({hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false, ...over});

test('投影：公开字段原样搬运，私有字段一个都不进来', () => {
  const game = rocoGameView(view(), {matchId: 'm1'});
  assert.equal(game.mode, ROCO_MODE);
  assert.equal(game.result, null);
  assert.equal(game.turn, 4);
  assert.equal(game.player.pets[0].maxHp, 425, 'max_hp 要投影成经验层认得的 maxHp');
  assert.equal(game.player.pets[0].hp, 166);
  assert.equal(game.player.items['回复药'], 1, '背包里有什么道具从合法动作里读出来');
  assert.equal(game.enemy.pets[0].hp, 300, '对手场上那一只是公开的');
  // 对手后备在公开视图里只有位次与是否倒下——投影**不得**给它补血量
  assert.equal(game.enemy.pets[1].hp, null, '对手后备血量是隐藏信息，不许补');
  assert.equal(game.roco.state_version, 11);
  // 真实 seed 从来不在这份视图里；投影也不会凭空造一个
  assert.ok(!JSON.stringify(game).includes('seed'));
});

test('投影：局面结束后不可玩（经验层据此闭嘴）', () => {
  assert.equal(rocoGameView(view(), {}).result, null);
  assert.equal(rocoGameView(view({battle_result: 'loss'}), {}).result, 'loss');
});

test('规划特征：gap 用期望区间宽度，不用 worst 的绝对值', () => {
  const f = rocoPlanFeatures({ok: true, expected: {min: -1, max: -0.4, mean: -0.7}, worst: {min: -1.3, max: -1.1}});
  assert.equal(Number(f.gap.toFixed(6)), 0.6, 'gap = expected.max - expected.min');
  // 推荐随分析种子变化 = 没有稳健结论：技能证据记 0（不压低门槛）
  assert.equal(rocoPlanFeatures({ok: true, expected: {min: 0, max: 0}, recommendation_stable: false}).skill, 0);
  assert.deepEqual(rocoPlanFeatures(null), {gap: null, skill: null, timedOut: null, margin: null});
  assert.equal(rocoPlanFeatures({ok: false}).gap, null, '规划失败时不许编一个 gap');
  // 枚举第一与第二名的估值差：**两种命名都要认**。
  // 同一个量在两个边界上名字不同——工具回执用 camelCase，页面拿到的 plan 直接来自
  // `/api/roco/plan`（Python 回执原样透传）用 snake_case。只认一种的后果不是报错，
  // 而是安静地拿到 null：判定层退回 sigmoid 口径、运行时永远放行。
  // 第 21 与第 30 轮各踩过一次，两次都是同一条量在搬运中换了名字。
  assert.equal(rocoPlanFeatures({ok: true, firstSecondMargin: 0.045}).margin, 0.045);
  assert.equal(rocoPlanFeatures({ok: true, first_second_margin: 0.045}).margin, 0.045,
    '页面这一侧的 snake_case 也必须认');
  assert.equal(rocoPlanFeatures({ok: true}).margin, null, '没有边际量时必须如实为 null');
});

test('陈旧判定：版本对不上就作废，只有一个入口', () => {
  assert.equal(rocoHintStale({stateVersion: 11}, 11), false);
  assert.equal(rocoHintStale({stateVersion: 11}, 12), true);
  assert.equal(rocoHintStale(null, 11), true);
  assert.equal(rocoHintStale({}, 11), true, '没有版本信息的提示一律当过期');
});

test('门控来自真实 experience.js：失焦是硬门控，不是「这次没什么可说」', () => {
  const base = {view: view(), session: session(), now: 1_000, host: {focus: true}};
  const focused = rocoIntervention(base);
  // 与「同一个 game 对象 + 经验层自己的装配函数」的结果必须逐个字段一致：
  // 这一层只做投影，判定完全交给经验层，不自己判一遍。
  // 注意这里用的是 interventionFeaturesOfGame 而不是 interventionFeatures——
  // 后者会再投影一次（它认的是 roco 视图，不是投影结果），那是另一条路径。
  const game = rocoGameView(view(), {});
  const direct = interventionDetail(interventionFeaturesOfGame({
    game, attention: null, session: session(), mode: 'gentle', now: 1_000,
    host: {focus: true}, risk: null, gap: null, skill: null, timeLeft: Infinity,
  }));
  assert.deepEqual(focused, direct, '包装层的结果必须与经验层逐个字段一致');

  const blurred = rocoIntervention({...base, host: {focus: false}});
  assert.equal(blurred.action, 'silent');
  assert.equal(blurred.gate, 'window-unfocused');
});

test('危险局面给的是短提示；健康局面沉默（阈值来自经验层，不是这里拍的）', () => {
  const hurt = rocoIntervention({view: view(), session: session(), now: 1_000, host: {focus: true}});
  assert.equal(hurt.gate, null);
  assert.ok(['micro_hint', 'action_hint'].includes(hurt.action), `危险局面应当提示，实际 ${hurt.action}`);

  const healthy = view({self: {active: 0, pets: [{slot: 0, pet_id: 'a', hp: 420, max_hp: 425, energy: 2, fainted: false}]}});
  const calm = rocoIntervention({view: healthy, session: session(), now: 1_000, host: {focus: true}});
  assert.equal(calm.action, 'silent');
  assert.equal(calm.reason, 'below-threshold');
});

test('频率预算：说过一次就在冷却里，同一手也不重复', () => {
  const used = session({hints: 1, lastAt: 1_000});
  const detail = rocoIntervention({view: view(), session: used, now: 2_000, host: {focus: true}});
  assert.equal(detail.action, 'defer_to_review', '冷却里不打断，但这一手值得局后看');
  assert.equal(detail.budget, 'cooldown');
  const exhausted = session({hints: 2, lastAt: -Infinity});
  assert.equal(rocoIntervention({view: view(), session: exhausted, now: 2_000, host: {focus: true}}).budget, 'hint-budget');
  // 玩家点掉之后本局不再开口
  const dismissed = session({dismissed: true});
  assert.equal(rocoIntervention({view: view(), session: dismissed, now: 2_000, host: {focus: true}}).gate, 'hint-dismissed');
});

test('提示文案：给建议与依据，不给胜率也不承诺必胜', () => {
  const plan = {ok: true, recommendation: '龙血', recommendation_stable: true, main_counter: '换上潮甲龟',
    worst: {min: -1.3636, max: -1.105}, expected: {min: -1, max: -0.4, mean: -0.7}, analysis_seeds: [11, 29, 47]};
  const text = rocoHintText(plan);
  assert.match(text, /龙血/);
  assert.match(text, /最坏尾部/);
  assert.ok(!/胜率|最优|一定能赢|概率/.test(text), `文案里不得出现承诺或概率：${text}`);
  // 推荐随种子变化时不给单一推荐
  const unstable = rocoHintText({ok: true, recommendation_stable: false, recommendation: '龙血'});
  assert.ok(!/龙血/.test(unstable), '结论不稳健时不该把某一手当推荐说出来');

  const detail = rocoIntervention({view: view(), session: session(), now: 1_000, host: {focus: true}});
  const withText = rocoInterventionText(detail, plan);
  assert.ok(withText.text.length > 0);
  assert.ok(withText.why.length > 0, '必须能说清依据');
  assert.equal(rocoInterventionText({action: 'silent'}, plan), null, '沉默时不该产出任何文案');
});

test('局末教学入口：没有值得拎出来的决策点就说没有', () => {
  assert.equal(rocoLessonEntry({events: [], turns: 5}), null);
  const entry = rocoLessonEntry({events: [{turn: 3, kind: 'damage', detail: {fainted: true}}, {turn: 7, kind: 'replace'}], turns: 9});
  assert.equal(entry.turn, 3, '优先挑倒下那一个决策点');
  assert.match(entry.note, /9 个回合/);
  const onlySwitch = rocoLessonEntry({events: [{turn: 2, kind: 'replace'}], turns: 4});
  assert.equal(onlySwitch.turn, 2);
  assert.match(onlySwitch.question, /换人/);
});

test('风险分支：这一手脆的时候把措辞降级，不说「可以优先考虑」', () => {
  // `fragile` 来自规划器按**产品阈值**判定的 downside（期望到最坏的距离），
  // 不是游戏机制。这里只钉住「措辞随 fragile 变化」这一件事，
  // 以及「脆弱时必须给出落差量级」——不把阈值本身当成事实断言。
  const plan = {
    ok: true, recommendation: '坟场搏击', recommendation_stable: true,
    main_counter: '换上第3位', worst: {min: -1.36, max: -1.10},
    risk: {fragile: true, downside_max: 1.56, threshold: 1.2,
      top_risks: [{opponent_action: '诡刺', score: -1.36, loss_vs_expected: 1.56}]},
  };
  const text = rocoHintText(plan);
  assert.ok(!/可以优先考虑/.test(text), '脆弱的一手不该说「可以优先考虑」');
  assert.match(text, /不稳/);
  assert.match(text, /1\.56/, '必须给出落差量级，光说「不稳」等于没说');
  assert.match(text, /-1\.36/, '仍然要给最坏尾部区间');

  const solid = rocoHintText({...plan, risk: {fragile: false, downside_max: 0.2}});
  assert.match(solid, /可以优先考虑/, '不脆的一手用原来的措辞');
});

test('风险分支：没有 risk 字段时按「不脆」处理（旧回执兼容）', () => {
  const text = rocoHintText({ok: true, recommendation: '龙血', worst: {min: 0.1, max: 0.2}});
  assert.match(text, /可以优先考虑/);
  assert.ok(!/不稳/.test(text));
});

test('伤害预览：说清「估」与「够不够收」，且结论不稳时不许打包票', () => {
  const base = {
    available: true, min: 130, max: 425, best_label: '坟场搏击',
    lethal: true, lethal_stable: true, foe_hp: 425, formula_verified: false,
  };
  const lethal = rocoDamagePreviewText({damage_preview: base});
  assert.match(lethal, /130~425/, '要给范围，不能只给一个数');
  assert.match(lethal, /坟场搏击/);
  assert.match(lethal, /够收掉/);
  assert.match(lethal, /未核验/, '这是未核验公式的输出，必须标出来');

  const unstable = rocoDamagePreviewText({damage_preview: {...base, lethal_stable: false}});
  assert.ok(!/够收掉/.test(unstable), '结论随分析种子变化时不许说「够收掉」');
  assert.match(unstable, /别当保证/);

  const notLethal = rocoDamagePreviewText({damage_preview: {...base, lethal: false}});
  assert.match(notLethal, /收不掉/);

  // 同一数字时不写区间
  const single = rocoDamagePreviewText({damage_preview: {...base, min: 300, max: 300}});
  assert.match(single, /300 点/);

  assert.equal(rocoDamagePreviewText({}), null);
  assert.equal(rocoDamagePreviewText({damage_preview: {available: false}}), null);
});
