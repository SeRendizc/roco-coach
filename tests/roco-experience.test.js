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
  rocoPlanFreshness,
  rocoLessonEntry,
  rocoIntervention,
  rocoInterventionText,
  rocoDamagePreviewText,
  lessonGoalRow,
  ROCO_MODE,
} from '../src/coach/roco-experience.js';
import {normaliseAdviceShape} from '../src/coach/coach-advice.js';
import {readFileSync} from 'node:fs';
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

test('规划回执的陈旧判定：规划自己说属于哪一版，才算哪一版（不许盖当前版本号）', () => {
  // 这一条抓的是第 65 轮实测到的真实竞态：`/api/roco/plan` 与 `battle/advance`
  // 是两条独立往返，规划**开始那一刻**的局面可能已经不是回来时的局面。
  // 页面原来的写法 `state.view?.state_version ?? plan.state_version` 会优先取
  // **当前视图**的版本号，于是把旧规划盖上新的版本章，之后所有「版本一致」的
  // 判断都放行它 —— 过期建议被当成当前建议展示。
  const fresh = rocoPlanFreshness({plan: {ok: true, state_version: 11}, view: {state_version: 11}});
  assert.equal(fresh.usable, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.plan_version, 11);
  assert.equal(fresh.reason, null);

  // 反证：把版本盖成当前视图那一版（旧的写法）在这组输入上会判成「可用」——
  // 也就是说下面这三条断言真的在拦这个 bug，不是空的。
  const raced = rocoPlanFreshness({plan: {ok: true, state_version: 11}, view: {state_version: 12}});
  assert.equal(raced.usable, false, '规划属于 11、当前是 12 → 必须丢弃');
  assert.equal(raced.stale, true);
  assert.equal(raced.plan_version, 11, '判据必须看**规划自己**的版本，而不是当前视图的版本');
  assert.equal(raced.view_version, 12);
  assert.match(raced.reason, /局面已推进（11 → 12）/, '丢弃原因要可核对：说清从哪一版到哪一版');
  assert.match(raced.reason, /丢弃/);

  // fail closed：拿不到规划版本时不许当成「它就是当前这一版」。
  for (const plan of [null, {}, {ok: true}, {ok: true, state_version: null}, {ok: true, state_version: '11'}]) {
    const verdict = rocoPlanFreshness({plan, view: {state_version: 12}});
    assert.equal(verdict.usable, false, `没有可用版本号的规划必须判为不可用：${JSON.stringify(plan)}`);
    assert.equal(verdict.plan_version, null);
  }
  // 视图侧缺版本同样 fail closed（拿不到当前版本就没法说「一致」）。
  assert.equal(rocoPlanFreshness({plan: {state_version: 12}, view: {}}).usable, false);
  assert.equal(rocoPlanFreshness({plan: {state_version: 12}, view: null}).usable, false);
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
  // 第 43 轮起：包装层会**额外**挂上建议（`advice`）与它的错误栏（`advice_error`）。
  // 那是刻意的——建议必须在这一层算，因为只有这里同时拿得到 view/session/plan/host。
  // 除此之外的每个字段仍然必须与经验层逐个相同：判定**不许**在这一层被改一遍。
  // ⚠ 2026-09-29 改钉（U09，task-2 advice-engine）：包装层新增一个**只读**字段 `plan_stale`
  // —— 「包里那份规划与当前战况不是同一版局面」⇒ 建议层丢掉规划、只用战况事实。
  // 它与 advice / advice_error 同类：这个事实只有包装层看得到（它同时拿得到 view 与 plan），
  // 经验层看不到 view，所以必须在这里排除，判据的**意图一个字没松**
  //（判定仍然不许在包装层被改一遍）。
  // 旧写法留档（原文，别再改回来）：
  //   const {advice, advice_error, ...fromExperience} = focused;
  // ⚠ 2026-09-29 第二次改钉（U09 兜底 + 排障回执）：包装层又多了两个**只读**字段
  // `advice_source`（这条建议是建议层给的还是确定性兜底）与 `speak_blocked_by`
  //（判决要说话却没说出来时，是谁拦的）。同样只有包装层看得到 view/plan，经验层没有。
  // 旧写法留档（原文，别再改回来）：
  //   const {advice, advice_error, plan_stale, ...fromExperience} = focused;
  // ⚠ 2026-09-29 第三次改钉（U09 幂等）：再多个 `advice_dedup_bypassed`
  //（决定性那一手不看去重账本，同一局面两次渲染必须给出同一份结论）。
  // 旧写法留档（原文，别再改回来）：
  //   const {advice, advice_error, plan_stale, advice_source, speak_blocked_by, ...fromExperience} = focused;
  const {advice, advice_error, plan_stale, advice_source, speak_blocked_by,
    advice_dedup_bypassed, ...fromExperience} = focused;
  assert.equal(plan_stale, false, '规划与战况同版时不许标成陈旧');
  assert.ok('plan_stale' in focused, '包装层必须如实给出「规划是不是这一版的」这一栏');
  assert.ok('advice_source' in focused && 'speak_blocked_by' in focused,
    '包装层必须如实给出「建议从哪来 / 谁拦的」这两栏');
  assert.deepEqual(fromExperience, direct,
    '除了 advice / advice_error / plan_stale，包装层的结果必须与经验层逐个字段一致');
  assert.ok('advice' in focused && 'advice_error' in focused,
    '包装层必须挂上 advice 与 advice_error 两栏');
  assert.equal(advice_error, null, '正常路径不该有建议错误');

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

test('提示文案：建议由**局面**决定，看不到局面就沉默（第 43 轮改）', () => {
  // 旧版本这里断言的是 `rocoHintText(plan)` 的模板措辞（含「最坏尾部」）。
  // 那正是用户实测判定为没用的那一句，函数已删。这一组改成钉**新契约**：
  //   · 有局面建议时：把建议原样交出去，并带上「为什么是现在」与一个风险；
  //   · 没有建议时：**沉默**（返回 null），不许退回模板；
  //   · 无论哪种，玩家可见文字里不许有工程术语、不许承诺胜负。
  const ENGINEER = /最坏尾部|区间|margin|score|种子|coverage|state_version|critical-risk|moderate-risk|\{\s*"/;
  const plan = {ok: true, recommendation: '龙血', recommendation_stable: true,
    main_counter: '换上潮甲龟', worst: {min: -1.3636, max: -1.105},
    expected: {min: -1, max: -0.4, mean: -0.7}, analysis_seeds: [11, 29, 47]};

  // ① 建议层给了建议 → 原样用它的句子，并把「为什么 + 风险」拼进依据
  const withAdvice = rocoInterventionText({
    action: 'action_hint', reason: 'moderate-risk',
    advice: {text: '「诡刺」打「画间沉铁兽」只有抵抗：别再硬用它',
      why: '上一手被属性抵抗', risk: '硬打等于把回合让出去', kind: 'type-resisted',
      evidence: {multiplier: 0.5}},
  }, plan);
  assert.ok(withAdvice && withAdvice.text.length > 0);
  assert.match(withAdvice.why, /上一手被属性抵抗/);
  assert.match(withAdvice.why, /风险：/);
  assert.equal(withAdvice.kind, 'type-resisted');
  assert.equal(withAdvice.shape, normaliseAdviceShape('「诡刺」打「画间沉铁兽」只有抵抗：别再硬用它'),
    '必须带归一化形状，页面靠它判「同一句不再重复」');
  assert.ok(!ENGINEER.test(withAdvice.text) && !ENGINEER.test(withAdvice.why),
    `玩家可见文字里出现工程术语：${withAdvice.text} / ${withAdvice.why}`);

  // ② 建议层没话说 → **沉默**。这是产品口径：没有稳定优势时不必硬说。
  assert.equal(rocoInterventionText({action: 'action_hint', reason: 'critical-risk', advice: null}, plan), null,
    '没有局面建议时必须沉默，不许退回旧模板');
  // ③ 建议层报错 → 同样沉默（错误进开发者面板，不进气泡）
  assert.equal(rocoInterventionText({action: 'micro_hint', advice: null, advice_error: {message: 'boom'}}, plan), null);
  // ④ 规则说沉默 → 一律 null
  assert.equal(rocoInterventionText({action: 'silent'}, plan), null, '沉默时不该产出任何文案');
  assert.equal(rocoInterventionText(null, plan), null);
  // ⑤ **改钉**（U09，user 截图 09 点名的那一句）：局末复习档不再有无信息文案。
  // 旧断言留档（原文）：这一支返回的是「这一手值得留到局后看一眼。现在先按你的判断走。」
  // + `why: detail.reason`，于是屏幕上出现「依据：hint-budget」。两个问题都在玩家眼前发生过：
  //   ① 正文没有任何信息量（没说风险、也没说能做什么）；② 内部理由漏进玩家可见文字。
  // 新契约：defer_to_review 也是「有建议就说、没建议就沉默」，并且 `why` 里不许有内部代号。
  assert.equal(rocoInterventionText({action: 'defer_to_review', reason: 'hint-budget'}, plan), null,
    '没有建议的局末复习档必须沉默（那句无信息文案已删）');
  const deferred = rocoInterventionText({action: 'defer_to_review', reason: 'hint-budget',
    advice: {text: '「诡刺」打「画间沉铁兽」只有抵抗：别再硬用它', why: '上一手被属性抵抗',
      risk: '硬打等于把回合让出去', kind: 'type-resisted', evidence: {multiplier: 0.5},
      action: {legalActionId: 'skill#1:龙血', legalIndex: 1, kind: 'skill', label: '龙血', display: '龙血'}}}, plan);
  assert.match(deferred.text, /别再硬用它/, '有建议时必须把建议说出来，而不是那句空话');
  assert.match(deferred.text, /局后/, '局末复习档要说清它留到局后看');
  assert.ok(!/hint-budget/.test(String(deferred.why)), `内部理由不许上屏：${deferred.why}`);
  assert.equal(deferred.action?.legalActionId, 'skill#1:龙血', '气泡也要带可回填的合法动作标识');
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

test('（已删）风险分支的旧措辞用例', () => {
  // 旧的两条用例断言 `rocoHintText` 在 `risk.fragile` 时把措辞降级成
  // 「…这一手不稳…最坏尾部…」。那个函数已删、那种措辞正是被否掉的，
  // 所以这里不再保留一个「测模板」的用例。
  //
  // 它原来要守的意图**没有丢**，只是换了地方：
  //   · 「不许承诺胜负 / 不许说最优」→ 本轮新契约用例 + demo 验收的工程术语判据；
  //   · 「脆弱的一手不许说『可以优先考虑』」→ 现在根本不存在「推荐某手」这种句子，
  //     建议由 `coach-advice.js` 按局面给出，逐条都有 why 与 risk；
  //   · 「必须给出落差量级」→ 变成 `evidence` 里的可核对事实，在展开区展示，
  //     并有 `tests/evals/coach-advice.test.js` 与 10 个真实局面验收钉着。
  assert.ok(true);
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

// ── 页面接线自检（第 45 轮补）────────────────────────────────────────────────
//
// 为什么静态也要查一遍：这一层已经出过四次「接上了但没生效」，而第 45 轮这一处
// 更坏——**输入错了但不报错**：
//   · 复盘的事件必须用**整局累计**的 `state.matchEvents`，不是 `state.events`
//     （后者只有这一次推进的事件，见 `service.py:1860`）；
//   · 局面必须用 `state.lastLiveView`（最后一个还能行动的局面），不是终局视图
//     （终局里 `legal` 为空 → `player.items` 为空 → 「有没有药」变成假的）。
// 这两条在纯函数那一侧已经有用例（`tests/evals/roco/teacher-match-review.test.js`
// 用真对局验过），但**页面有没有这样调用**只能在这里查：改了这行、纯函数测试照样绿。
test('页面局末复盘接的是「整局事件 + 最后一个可行动的局面」（接错了不会报错）', () => {
  const page = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  const call = page.match(/rocoMatchReview\(\{([\s\S]{0,400}?)\}\)/);
  assert.ok(call, '页面必须调用 rocoMatchReview 来装配复盘（不许自己拼）');
  const args = call[1];
  assert.match(args, /events:\s*state\.matchEvents/, `复盘要用整局事件，当前：${args.slice(0, 200)}`);
  assert.match(args, /lastLiveView:\s*state\.lastLiveView/, `复盘要用最后一个可行动的局面，当前：${args.slice(0, 200)}`);
  assert.doesNotMatch(args, /events:\s*state\.events\b/, '用这一次推进的事件做整局复盘会安静地少讲一大截');
  // 累计必须发生在换掉 `state.view` 之前，否则快照永远慢一拍（legal 已经空了）。
  //
  // 2026-09-23（接手轮）：这里原来写的是 `[\s\S]{0,1500}?)\n\}` —— 一个**长度上限**。
  // `applyResult` 后来加了「掉心提示」那一块，函数体涨到 1900+ 字符，正则再也匹配不上，
  // 于是这条守卫变成 `actual: null` 的假红/（更坏的情况）换个写法就悄悄不检查了。
  // 现在按**花括号配对**取函数体：函数长长短短都不会失效，判据本身一条没放松。
  const fnBody = (src, header) => {
    const start = src.indexOf(header);
    if (start < 0) return null;
    let i = src.indexOf('{', start), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
    }
    return null;
  };
  const applySrc = fnBody(page, 'function applyResult(data)');
  assert.ok(applySrc !== null, '页面里应当有 applyResult');
  const body = applySrc;
  const at = (needle) => body.indexOf(needle);
  assert.ok(at('state.matchEvents') >= 0, 'applyResult 要累计整局事件');
  assert.ok(at('state.lastLiveView') >= 0, 'applyResult 要在换 view 之前留一份「还能行动的局面」');
  assert.ok(at('state.lastLiveView') < at('state.view = data.view'),
    '顺序反了：先换 view 再留快照，拿到的是终局视图');
  assert.ok(at('state.matchEvents') < at('state.view = data.view'),
    '顺序反了：先换 view 再累计，会漏掉最后一次推进的事件');
  // 开局要把两份快照清干净，否则上一局的局面会被带进新的一局。
  const startSrc = fnBody(page, 'async function startBattle()');
  assert.ok(startSrc !== null, '页面里应当有 startBattle');
  assert.match(startSrc, /state\.matchEvents = \[\]/, '开新局要清空整局事件');
  assert.match(startSrc, /state\.lastLiveView = null/, '开新局要清掉上一局的快照');
});

// ── 形象体系（P1-1）：自制 emoji 与配色必须同一个键集 ──────────────────────
//
// 为什么值得单独一条：少一个系别不会报错，只是那一系的伙伴在页面上变成一个
// 没有图形的灰块——「12 只里总有几只看起来不像伙伴」。而两张表分别演进时，
// 这种缺口只会越来越多，没人会发现。
test('12 个系别的 emoji 与配色逐键对齐，且不引用任何外链素材（自制形象）', () => {
  const page = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  const keysOf = (name) => {
    const block = page.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
    assert.ok(block, `页面里应当有 ${name}`);
    return [...block[1].matchAll(/([\u4e00-\u9fff]+系)\s*:/g)].map((m) => m[1]);
  };
  const colors = keysOf('TYPE_COLOR');
  const emoji = keysOf('TYPE_EMOJI');
  assert.ok(colors.length >= 18,
    `候选池扩到 48 只之后系别变多（数据里 18 种），配色表必须全覆盖，实际 ${colors.length}`);
  // 数据里真的出现过的系别，一个都不许缺（写死 12 守不住 48 只——第 77 轮实测：
  // 扩池后页面 48 张卡里有 17 张没有形象，正是这张表没跟上）。
  const petsJson = JSON.parse(readFileSync(new URL('../data/roco/normalized/roco-world-s4-2026-09-10/pets.json', import.meta.url), 'utf8'));
  const dataTypes = [...new Set(Object.values(petsJson.pets ?? {}).flatMap((p) => p.types ?? []))];
  assert.deepEqual(dataTypes.filter((t) => !colors.includes(t)), [],
    '数据里出现的系别必须在配色表里（否则那一类伙伴在页面上没有形象）');
  assert.deepEqual(dataTypes.filter((t) => !emoji.includes(t)), [],
    '数据里出现的系别必须在 emoji 表里');
  assert.deepEqual([...emoji].sort(), [...colors].sort(),
    'emoji 表与配色表必须是同一个键集（少一个系别 = 那一系的伙伴没有形象）');
  // 每个 emoji 都必须是真字符（空串会让 `typeChips` 静默退化成一个只有文字的标签）
  const emojiBlock = page.match(/const TYPE_EMOJI = \{([\s\S]*?)\};/)[1];
  const values = [...emojiBlock.matchAll(/[\u4e00-\u9fff]+系\s*:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.equal(values.length, emoji.length, `emoji 表里的值数要与键数一致（各 ${emoji.length}），实际 ${values.length}`);
  assert.deepEqual(values.filter((v) => v.trim() === ''), [], '不许有空 emoji');
  assert.ok(!/https?:\/\/[^"' ]+\.(png|jpe?g|webp|svg)/i.test(page),
    '形象一律自制（emoji / 色块），不引用任何外链图片素材');
  // ⚠ 2026-09-29 **改钉（阶段三：查第 5 条红的实际原因）**。旧断言原文留档（别删）：
  //     assert.ok(!/<img\b/i.test(page), '页面里不该有 <img>：官方立绘的许可不明，不抓');
  //   为什么改：`page` 是 **JS 源码**，而这条断言在**整份源码**（含注释）上匹配 `<img`。
  //   当时触发它的是 `src/client/roco.js:2780/2831/2832` 的三处**注释** —— 而那三处注释写的
  //   恰恰是「**为什么不用** <img>」（`onerror` 会把 `<img>` 删掉 ⇒ 动作立绘会消失，所以撤掉）。
  //   ⇒ 判据在惩罚"解释自己为什么不这么做"的注释，是**扫描范围**错了，不是意图错了。
  //   **意图一个字没变**：页面不许画官方立绘。现在先剥注释再判 —— **只量能真的跑起来的代码**。
  //   配套**反证**（`stripJsComments` 不许把真代码一起吃掉），见本文件末尾同名判据。
  assert.ok(!/<img\b/i.test(stripJsComments(page)),
    '页面里不该有 <img>：官方立绘的许可不明，不抓（注释不算 —— 只量可执行代码）');
});

// 2026-09-25（人类：「复盘有点太简单了」）：加厚层必须落在**玩家不点开也看得见**的地方。
// 这条是**结构性**的（对抗性复核指出：加厚的事实全塞进 `#lesson-note`，而它在 `roco.html` 的
// `<details class="lesson-full">` 里、默认收起；此前没有任何判据盯这件事 —— 判据只到
// `review.evidence` 那一层，读 `textContent` 读得到、画不画得出来没人管）。
// 钉法：正文那一行与「下一局练一件事」必须真的拿到加厚内容；深细节留在折叠区（刻意），
// 但折叠块的标题必须写明它是收起的。哪天有人把加厚内容只往折叠区塞，这条会红。
test('复盘加厚层落在「不点开也看得见」的两个节点上（不是只塞进默认收起的折叠区）', () => {
  const page = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/client/roco.html', import.meta.url), 'utf8');
  const exp = readFileSync(new URL('../src/coach/roco-experience.js', import.meta.url), 'utf8');
  // ① 装配层：summary 进正文，next_step 随 depth 挂出去
  assert.match(exp, /if \(depth\.summary\) review\.text = /, '加厚的 summary 必须接进正文（否则不点开看不到）');
  assert.match(exp, /review\.depth = depth/, '装配层要把整个 depth 带出去');
  // ② 页面可见节点：正文那一行 + 「下一局练一件事」
  assert.match(page, /\$\('lesson-question'\)\.textContent = review\.text/,
    '正文那一行必须写 review.text（含加厚 summary）');
  assert.match(page, /const nextStep = review\.depth\?\.next_step\?\.text/, '页面要取加厚层的 next_step');
  const learning = page.match(/\$\('lesson-learning'\)\.textContent = \[([\s\S]{0,300}?)\]\.filter\(Boolean\)/);
  assert.ok(learning, '找不到「下一局练一件事」那一栏的写入点（口径变了就重新钉，别删这条）');
  assert.match(learning[1], /nextStep/, '「下一局练一件事」那一栏必须把 next_step 拼进去（可见的那一处）');
  // ③ 深细节仍在折叠区（刻意），但必须写明「默认收起」，不许悄悄藏
  const details = html.match(/<details class="lesson-full">[\s\S]{0,200}?<\/summary>/);
  assert.ok(details, '找不到完整复盘的折叠块（`<details class="lesson-full">`）');
  assert.match(details[0], /默认收起/, '折叠块必须在标题里写明它是收起的');
});

// 同一条线的第二半（2026-09-25 复核发现）：`review === null` 的**兜底分支**原来把
// 「下一局练一件事」无条件清成空，而加厚层的 `next_step` 这时候可能**有内容**
// （例：只有对面补位、没有减员 ⇒ 老师沉默，但 `enemy-replacement-first` 成立）——
// 等于把已经算好的一条如实结论白丢。这一条钉住「有就写出来、没有才留空」。
test('老师沉默的兜底分支也要写出加厚层的「下一件事」（不再无条件清空）', () => {
  const page = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /\$\('lesson-learning'\)\.textContent = '';/,
    '兜底分支不许再无条件清空「下一局练一件事」（口径变了就重新钉，别删这条）');
  assert.match(page, /\$\('lesson-learning'\)\.textContent = depth\?\.next_step\?\.text \?\? ''/,
    '兜底分支要把加厚层的 next_step 写出来（没有就留空）');
});

// ── P1-C（2026-10-01）：这一栏的**空/非空口径**（两条入口同一收口）──────────────
//
// 缺陷（lead-mac 玩家可见）：换宠打出 288 点后撤退 ⇒ `next_step=null` + `review=null`
// ⇒ 两条分支都写空串 ⇒ 玩家只看到静态标签「下一局练一件事」。
// 修法分两半：① 数据层（正面向规则，已落地，判据在 `roco-match-review-depth.test.js`）；
// ② 页面层「空则隐藏整行」—— 这一半的**决策逻辑**抽成纯函数 `lessonGoalRow()`，在这里先钉住；
// 页面那两处调用与「隐藏整行」的静态判据等 `src/client/roco.js` 解锁后同批落（见
// `reports/roco/product-execution/06/P1C-next-step-review.md` §8）。
test('P1-C：lessonGoalRow —— 空就 visible:false（页面据此隐藏整行，而不是写空串）', () => {
  // 路径 A：老师沉默（review=null）+ 加厚层也没有下一步 ⇒ 这一栏整行不该显示
  assert.deepEqual(lessonGoalRow({review: null, depth: null}), {text: '', visible: false});
  assert.deepEqual(lessonGoalRow({review: null, depth: {next_step: null}}), {text: '', visible: false});
  // 路径 B：老师有结论但 learning 为空 + 没有下一步 ⇒ 同样整行不显示
  assert.deepEqual(lessonGoalRow({review: {learning: ''}, depth: {next_step: null}}), {text: '', visible: false});
  assert.deepEqual(lessonGoalRow({review: {learning: '   '}, depth: null}), {text: '', visible: false});
  assert.deepEqual(lessonGoalRow(), {text: '', visible: false}, '不传参数也不许崩，且不许编一句话');

  // 路径 A 有料：加厚层的下一步必须照写（这就是 lead-mac 报的那一局）
  const nextStep = '下一次换上新的一只之后，先按对位打出一手（这一局第 1 回合换上来，就打出了约 288 点）；换人前先把「上来先打谁」想好。';
  const pathA = lessonGoalRow({review: null, depth: {next_step: {text: nextStep}}});
  assert.equal(pathA.visible, true);
  assert.equal(pathA.text, nextStep);
  assert.match(pathA.text, /约 288 点/);

  // 老师有 learning、没有下一步 ⇒ 这一栏仍有内容（不许把老师那句也藏掉）
  const learningOnly = lessonGoalRow({review: {learning: '换宠承伤'}, depth: null});
  assert.deepEqual(learningOnly, {text: '这一局学到一件事：换宠承伤', visible: true});

  // 两段都有 ⇒ 逐字与页面原来的拼法一致（空格分隔、顺序不变）
  const both = lessonGoalRow({review: {learning: '换宠承伤'}, depth: {next_step: {text: nextStep}}});
  assert.equal(both.text, `这一局学到一件事：换宠承伤 ${nextStep}`);
  assert.equal(both.visible, true);

  // 非恒真：两个不同的输入不许得到同一句话（否则这一层就是「复制一句套话」）
  assert.notEqual(pathA.text, learningOnly.text);
});


// ── 2026-09-29：给上面那条「页面里不该有 <img>」用的**注释剥离** + 必红反证 ──────────
// 为什么需要剥离：那条判据量的是 JS 源码，而注释里会**解释"为什么不用 <img>"**（实测 roco.js 三处）。
// 剥离要**保守**：块注释整段去掉；行注释只在「不是 URL 的 //」时去掉（`http://` 要留着，
// 因为上面还有一条判据专门查外链图片）。
function stripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // /* … */ 整段
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');   // 行注释；`:`, `'`, `"`, `\` 之后的 // 不当作注释（保住 http://）
}

test('反证：注释剥离不许把真代码里的 <img> 一起吃掉（否则上面那条判据就成了假绿）', () => {
  // 真代码里的 <img> 必须**仍然**被抓
  assert.match(stripJsComments('const html = "<img src=\'/art.png\'>";'), /<img\b/i,
    '字符串里的 <img> 是可执行代码，必须留下');
  assert.match(stripJsComments('el.innerHTML = `<img src="x">`;'), /<img\b/i,
    '模板串里的 <img> 必须留下');
  // 注释里的 <img> 必须被剥掉（否则又回到假阳性）
  assert.doesNotMatch(stripJsComments('// 别用 <img>，onerror 会把它删掉'), /<img\b/i,
    '行注释里的 <img> 必须被剥掉');
  assert.doesNotMatch(stripJsComments('/* 说明：这里原来画 <img> */'), /<img\b/i,
    '块注释里的 <img> 必须被剥掉');
  // 外链检查依赖的那条判据不能被剥离误伤：`http://` 必须留下
  assert.match(stripJsComments("const u = 'http://x/a.png';"), /http:\/\/x\/a\.png/,
    'http:// 是 URL 不是注释，必须留下');
});
