// 「玩家这么说，教练会不会去查引擎」的**说法覆盖**判据（2026-09-25）。
//
// 为什么单独立一条：这套系统里，能力**已经做出来了却问不出来**的情况反复出现，而且都是
// 「自然说法没被正则认出来」这一类（实测踩过：人类原话「我这**套**阵容有什么短板？」
// 一次工具都没调；「把第三只换成圆号鱼**会怎样**？」被当成名字的一部分）。
// 这类缺口不会报错、只会让模型拿证据包里那点东西随口答 —— 玩家看起来一切正常。
//
// 判据形状：① 一张**自然说法 → 期望引擎政策**的表（24 条，覆盖七类能力）；
// ② 参数构造不出来时必须走**诚实边界**（不是编一个）；
// ③ 反证：战斗动作问句不许被这些政策抢走。表格是「人怎么说话」的事实清单，
// 加了新说法就往表里加一行（**别删行**）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {policyFor, defaultArgsFor, matchupAsk, runCoach, localProvider, buildContext, checkGroundedAnswer,
  parametricFactAsk, localParametricFact, localFactAsk, policyAsk, trainingAsk,
  catalogAsk, catalogTarget, catalogElement,
  legalityAsk, legalityTarget, legalityPet, legalitySkills,
  playerQuestion, petIntroAsk, petIntroTarget,
  catalogTeamAsk, teamSpeciesIds, rosterWeaknessAsk, judgementAsk, teamBuildAsk,
  loadoutAsk, teamAskShape} from '../src/coach/runtime.js';
import {RULES, ITEMS, SKILLS} from '../src/game/engine.js';
import {configureRocoTools, resetRocoTools, validToolArgs} from '../src/coach/toolbox.js';
import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {STANDARD_PVP_MODE_ID} from '../src/game/battle-modes.js';
import {MAX_LEVEL, BATTLE_REWARD} from '../src/game/progression.js';

const NAMES = ['铠甲虫', '音速犬', '仪式巨像', '雪影娃娃', '皇家狮鹫', '化蝶'];
const SIX = NAMES.map((name, i) => ({id: `pet_0000${12 + i * 50}`, name}));
const THREE = SIX.slice(0, 3);
const POOL = [{id: 'pet_000417', name: '圆号鱼', types: ['水系']},
  {id: 'pet_000020', name: '喵喵', types: ['草系']}];
const CAMP = {mode: 'camp', profile: {lineup: SIX, pets: POOL}};
// 营地页**真形状**的存档上下文（`profile` 就是本仓 MVP 引擎的存档本体：`pets` 是对象、
// 逐只带 level/xp/points，另有 tokens）。训练点那一族（⑥）只在这种形状下答得出数字 ——
// 而 `CAMP` 那种 `pets: POOL`（数组：页面名单）在真机上也存在，两条都要能跑。
const SAVE = {...newProfile(), tokens: 2,
  pets: {...newProfile().pets, fox: {level: 2, xp: 10, points: {hp: 1, atk: 2, speed: 0}}}};
const CAMP_SAVE = {mode: 'camp', focus: 'fox', profile: SAVE};
const CAMP3 = {mode: 'camp', profile: {lineup: THREE, pets: POOL}};
const BATTLE = {mode: 'pve', profile: {lineup: SIX}, roco_battle: {turn: 3}};

/** [类别, 玩家怎么说, 上下文, 期望的工具, 期望参数（null = 允许诚实边界）] */
const MATRIX = [
  // 阵容评估（引擎 evaluate_team）
  ['阵容评估', '我这六只怎么样？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '我这套阵容怎么样？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '我这套阵容有什么短板？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '帮我看看这六只', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '我这队搭不搭？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '我这六只行不行？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '这阵容能不能打？', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '帮我评一下我这六只', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  ['阵容评估', '我这六个配合得怎么样', CAMP, 'evaluate_team', {team: SIX.map((p) => p.id)}],
  // 换人对比（引擎 compare_team_change）
  ['换人对比', '第三只换成圆号鱼好不好？', CAMP, 'compare_team_change', 'args'],
  ['换人对比', '把第三只换成圆号鱼会怎样？', CAMP, 'compare_team_change', 'args'],
  ['换人对比', '第四只换成喵喵呢', CAMP, 'compare_team_change', 'args'],
  ['换人对比', '第三只换掉行不行', CAMP, 'compare_team_change', null],   // 没说换进谁 ⇒ 诚实边界
  // 推荐（引擎 type_chart）
  ['推荐', '下一个该带谁？', CAMP, 'query_rules', {kind: 'type_chart'}],
  ['推荐', '还差什么？', CAMP, 'query_rules', {kind: 'type_chart'}],
  ['推荐', '推荐一只精灵', CAMP, 'query_rules', {kind: 'type_chart'}],
  ['推荐', '对面火系我该带谁', BATTLE, 'query_rules', {kind: 'type_chart'}],
  // 规则事实 / 术语 / 学习表 / 两只对比
  ['规则事实', '喵喵的种族值是多少？', CAMP, 'query_rules', {kind: 'pet', name: '喵喵'}],
  ['规则事实', '叶绿光束威力多少？', CAMP, 'query_rules', {kind: 'skill', name: '叶绿光束'}],
  ['术语', '「应对」是什么意思？', CAMP, 'query_rules', {kind: 'term', name: '「应对」'}],
  ['学习表', '喵喵学得到哪些技能？', CAMP, 'query_rules', {kind: 'learnset', name: '喵喵', compact: true}],
  ['两只对比', '喵喵和音速犬谁速度更快？', CAMP, 'query_rules', {kind: 'pet', name: '喵喵'}],
  // 对局类
  ['回合事实', '第5回合发生了什么？', BATTLE, 'read_evidence', {turn: 5}],
  ['分支模拟', '如果我这回合换宠会怎样？', BATTLE, 'simulate_branch', 'args'],
];

test('① 24 种自然说法都要接上引擎（表格是"人怎么说话"的事实清单，别删行）', () => {
  const problems = [];
  for (const [kind, question, ctx, tool, want] of MATRIX) {
    const policy = policyFor(question, ctx);
    if (policy.need !== tool) {
      problems.push(`[${kind}]「${question}」政策=${policy.need ?? '（无）'}（${policy.reason ?? '-'}），期望 ${tool}`);
      continue;
    }
    const args = defaultArgsFor(tool, ctx, question);
    if (want === null) continue;                       // 允许诚实边界（由 absentArgsFor 说清缺什么）
    if (args === null) { problems.push(`[${kind}]「${question}」参数构造不出来（期望能查）`); continue; }
    if (want !== 'args' && JSON.stringify(args) !== JSON.stringify(want)) {
      problems.push(`[${kind}]「${question}」参数=${JSON.stringify(args)}，期望 ${JSON.stringify(want)}`);
    }
  }
  assert.deepEqual(problems, [], `这些说法问不出引擎：\n${problems.join('\n')}`);
});

test('② 参数真的构造不出来时，必须走诚实边界（不许编一个队出来）', () => {
  // 「第三只换掉行不行」没说换进谁：政策要触发（说明这句话被认出来了），但参数必须是 null。
  const policy = policyFor('第三只换掉行不行', CAMP);
  assert.equal(policy.need, 'compare_team_change', '这句要被认成换人对比');
  assert.equal(defaultArgsFor('compare_team_change', CAMP, '第三只换掉行不行'), null,
    '没说换进谁就不许构造参数（由 absentArgsFor 如实说缺什么）');
  // 名字不在名单里 / 重名：同样不许猜
  assert.equal(defaultArgsFor('compare_team_change', CAMP, '第三只换成不认识的鱼好不好？'), null);
});

test('③ 反证：战斗动作问句不许被阵容/推荐这些政策抢走', () => {
  const notMine = [
    ['守一下和换潮甲龟哪个好？', 'simulate_branch'],
    ['第5回合发生了什么？', 'read_evidence'],
  ];
  for (const [question, want] of notMine) {
    const policy = policyFor(question, BATTLE);
    assert.equal(policy.need, want, `「${question}」被抢走了：${policy.need}（${policy.reason}）`);
  }
  // 「这回合该出什么？」走的是既有口径 `state-in-packet`（对局包里已经带着合法行动 ⇒ 不必再查一次）。
  // 这里钉的不是它必须是哪条政策，而是**不许被阵容/推荐这些新政策抢走**。
  const action = policyFor('这回合该出什么？', BATTLE);
  for (const stolen of ['team-ask', 'lineup-pick-ask', 'compare-ask', 'swap-compare']) {
    assert.notEqual(action.reason, stolen, `「这回合该出什么？」被抢走了：${action.reason}`);
  }
  // 三只阵容时的整队评估仍然走 evaluate_team（口径没变）
  assert.equal(policyFor('这三只怎么样？', CAMP3).need, 'evaluate_team');
});

test('④ 规则卡路径不许吞掉「比较/计算」类问句（c05 实测：被一张卡答掉、工具循环根本没进）', async () => {
  const {readFileSync} = await import('node:fs');
  const src = readFileSync(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  assert.match(src, /const CARD_COMPUTE_INTENT=/, '必须有「计算意图」排除表');
  assert.match(src, /const ruleCard=!CARD_COMPUTE_INTENT\.test\(routingText\)/,
    '规则卡必须排除计算意图（否则「帮我比较一下换宠和防御」会被一张卡答掉）');
  // 行为侧：这句话必须落到「要算」的政策上（引擎的活），而不是被卡片路径锁死
  const policy = policyFor('对方的技能能打掉我多少血？帮我比较一下换宠和防御。', BATTLE);
  assert.equal(policy.need, 'simulate_branch', `这句话要送去算：${policy.need}（${policy.reason}）`);
  // 反证：纯规则问句仍然走卡片路径（排除表不许把正常问句也赶走）
  assert.doesNotMatch('防御的消耗是多少？', /比较|对比|哪个好|哪个更|换成|换掉|该不该|还是|模拟|假设|如果|多少血|打掉|伤害|算一下|算算|先手|谁先/,
    '纯规则问句不该命中排除表');
});

test('⑤ 对局内的自然问法：该算的必须算，其余的「不查」是**有据**的（C6.143 的结论）', () => {
  // 2026-09-25 实测（第 43 轮）：对局内 10 句自然问法里 8 句走 `state-in-packet`（不调工具）。
  // 当时担心"包里没有合法行动 ⇒ 可能无据"，随后**逐条读完依据数组**发现反过来：
  // 包里除了结构化字段，还带着**引擎算好的结论文本**（例：策略证据行
  // 「回复药 → 潮甲龟：多数情况下是 20.9 分，最糟的一种是 10.8 分（**分数只用来排序，不是胜率**）」，
  // 出自 `src/coach/strategist.js:39`），模型是逐字引用。
  // ⇒ 这一段钉住两类行为：**要比较的要送去算**；其余**允许**走包内（但必须仍带 reason=state-in-packet，
  //    即"明确判断过不必查"，而不是没有政策）。哪天要把这些也改成"必须查"，
  //    就按新证据**改钉这一条**（别删）。
  const mustCompute = ['现在该防御还是出招？', '守一下和换人哪个好？'];
  for (const q of mustCompute) {
    const policy = policyFor(q, BATTLE);
    assert.equal(policy.need, 'simulate_branch', `「${q}」必须送去算：${policy.need}（${policy.reason}）`);
  }
  const fromPacket = ['我该换谁？', '这回合该不该换宠？', '对面这招能打掉我多少血？', '我先手还是后手？',
    '我这只能不能扛住这一下？', '换潮甲龟上来划算吗？', '他下一手可能出什么？', '这回合怎么打？'];
  for (const q of fromPacket) {
    const policy = policyFor(q, BATTLE);
    assert.equal(policy.need, null, `「${q}」当前走包内：${policy.need}`);
    assert.equal(policy.reason, 'state-in-packet',
      `「${q}」必须是**明确判断过不必查**（state-in-packet），而不是没有政策：${policy.reason}`);
  }
});

test('⑥ 培养/训练类的自然说法：7 句都要被明确判断过（现在判给本地事实）', () => {
  // 2026-09-25（第 47 轮）审这一族时，7 句自然说法全部是 `state-in-packet`，理由写的是
  // 「包里带着训练点与培养格，答复**有据**」（c09「我该培养哪只？现在还有多少训练点和培养格？」）。
  //
  // **同一族在 2026-09-25 稍后被真机推翻**（8765 未接模型）：
  //   · 「我还差多少训练点满级？」→「嗯，还差多少训练点满级。」（把问句回声了一遍）
  //   · 「我这点训练点该怎么加？」→「我在。」
  // `state-in-packet` 的前提是"有模型去读包里的数"，没模型时它既不是答案、也不是边界。
  // 这一族的数字**全在存档 + `progression.js` 常量里**（等级上限 / 每级经验 / 培养格公式 /
  // 每场奖励），所以改判 `training-ask`：由 `localFactAnswer` 本地成句，0 次模型调用。
  // 这一条钉的仍然是同一件事：**必须被明确判断过**（原来是 state-in-packet，现在是 training-ask），
  // 而不是变成"没有政策、模型随口答"。行一个都没删，只把期望从"走包内"改钉成"本地事实"。
  assert.ok(Number.isInteger(CAMP_SAVE.profile.tokens), '前提：这一族的存档要带训练点（真机上下文就是这个形状）');
  const training = ['我该培养哪只？', '现在还有多少训练点？', '还有几个培养格？', '加点加哪只划算？',
    '我这只该怎么加点？', '训练点怎么用？', '培养哪只先手更稳？'];
  for (const q of training) {
    const policy = policyFor(q, CAMP_SAVE);
    assert.equal(policy.reason, 'training-ask',
      `「${q}」必须被明确判成训练点那一族（本地事实）：${policy.need}（${policy.reason}）`);
    assert.equal(localFactAsk(q, policy), true, `「${q}」必须走本地单发（0 次模型调用）`);
  }
  // 反证：别的问句不许被这一族抢走；**没有存档的形状**也不许接（拿不到数就不接）
  assert.equal(trainingAsk('水系克什么？', CAMP_SAVE), false);
  assert.equal(trainingAsk('这回合怎么打？', CAMP_SAVE), false);
  assert.equal(policyFor('这回合怎么打？', BATTLE).reason !== 'training-ask', true);
  assert.equal(trainingAsk('现在还有多少训练点？', CAMP), false,
    '页面名单那种形状（pets 是数组、没有 tokens）算不出训练点 ⇒ 不许接（宁可走原路）');
});

test('⑦ 相性表问句（「水系克什么？」）必须查引擎，且不许抢走别的问句', () => {
  // 2026-09-25 第 54 轮（C6.144 第 3 条）：属性相性是**规则事实**，原来走"不查"（模型凭记忆答）。
  // 真源在引擎，一次 `type_chart` 就够（与「该带谁」共用同一支参数）。
  for (const q of ['水系克什么？', '火系怕什么？', '草系被什么克？']) {
    const policy = policyFor(q, CAMP);
    assert.equal(policy.reason, 'type-chart-ask', `「${q}」要查相性表：${policy.need}（${policy.reason}）`);
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, q), {kind: 'type_chart'},
      `「${q}」的参数应当是整张相性表`);
  }
  // 反证：别的问句不许被抢（带"谁"的推荐问句仍归 lineup-pick；属性字段问句仍归图鉴）
  assert.equal(policyFor('对面火系我该带谁', BATTLE).reason, 'lineup-pick-ask');
  assert.equal(policyFor('喵喵的属性是什么？', CAMP).reason, 'codex-fact');
  assert.equal(policyFor('我这六只怎么样？', CAMP).reason, 'team-ask');
});

test('⑧ 学习表变体说法（「喵喵有什么技能？」）必须查引擎，且名字要取对', () => {
  // 2026-09-25 第 56 轮（C6.144 第 1 条）：技能池是**图鉴检索**类，原来走"不查"（模型凭记忆答）。
  // 与 `learnsetAsk` 分开写，是为了不动它的函数体（返回行与 learnsetTarget 共用正则、宽锚点易误伤）。
  const cases = [['喵喵有什么技能？', '喵喵'], ['音速犬会什么技能', '音速犬'], ['化蝶有哪些招', '化蝶']];
  for (const [q, name] of cases) {
    const policy = policyFor(q, CAMP);
    assert.equal(policy.reason, 'learnset-ask', `「${q}」要查学习表：${policy.need}（${policy.reason}）`);
    // 见文件头/另一条判据的说明：学习表带 `compact:true`（否则第一枪回执超 10000 字符预算）。
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, q), {kind: 'learnset', name, compact: true},
      `「${q}」的名字要取对`);
  }
  // 原有说法不许被影响；相性表/推荐各归各的
  assert.equal(policyFor('喵喵学得到哪些技能？', CAMP).reason, 'learnset-ask');
  assert.equal(policyFor('水系克什么？', CAMP).reason, 'type-chart-ask');
  assert.equal(policyFor('下一个该带谁？', CAMP).reason, 'lineup-pick-ask');
  // 反证：取不出名字时不许构造参数（fail closed）
  assert.equal(defaultArgsFor('query_rules', CAMP, '有什么技能？'), null);
});

test('⑨ 反向形状「X 是哪个系的？」必须查引擎，且宠物/技能要分清', () => {
  // 2026-09-25 第 59 轮（C6.144 最后一条）：字段在「是」**后面**，与 SKILL_FIELD_ASK 方向相反。
  // 属性是规则事实 ⇒ 真源在引擎。名字在名单/候选里按宠物查，否则按技能查（查不到由引擎如实说）。
  const petQ = policyFor('喵喵是哪个系的？', CAMP);
  assert.equal(petQ.reason, 'codex-fact', `宠物版要走图鉴：${petQ.need}（${petQ.reason}）`);
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '喵喵是哪个系的？'), {kind: 'pet', name: '喵喵'},
    '名单里的名字要按**宠物**查');
  const skillQ = policyFor('叶绿光束是哪个系的？', CAMP);
  assert.equal(skillQ.reason, 'codex-fact', `技能版要走图鉴：${skillQ.need}（${skillQ.reason}）`);
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '叶绿光束是哪个系的？'), {kind: 'skill', name: '叶绿光束'},
    '不在名单里的名字按**技能**查');
  // 反证：别的问句不许被抢
  assert.equal(policyFor('喵喵的属性是什么？', CAMP).reason, 'codex-fact');
  assert.equal(policyFor('水系克什么？', CAMP).reason, 'type-chart-ask');
  assert.equal(policyFor('喵喵有什么技能？', CAMP).reason, 'learnset-ask');
});

test('⑩ 概念对比「A 和 B 有什么区别」走知识卡检索，且不许抢走邻近政策', () => {
  // 2026-09-25 第 61 轮（C6.144 第 4 条的正解）：实测引擎术语表 54 条里**没有**「特攻/物攻」
  // （`terms_by_name` 返回空）⇒ 走**知识卡检索** `search_rules`（引擎侧 tactic/rule 卡）；
  // 返回空时由模型如实说"引擎没这条"，不许凭记忆讲定义（红线）。
  for (const q of ['特攻和物攻有什么区别？', '速度和先手有什么区别', '物攻跟特攻有啥区别']) {
    const policy = policyFor(q, CAMP);
    assert.equal(policy.need, 'search_rules', `「${q}」要查知识卡：${policy.need}（${policy.reason}）`);
    assert.equal(policy.reason, 'concept-diff');
    assert.deepEqual(defaultArgsFor('search_rules', CAMP, q), {query: q.slice(0, 180)},
      '参数走既有的 search_rules 分支（整句检索）');
  }
  // 反证：邻近政策一个都不许被抢
  assert.equal(policyFor('喵喵和音速犬谁速度更快？', CAMP).reason, 'compare-ask');
  assert.equal(policyFor('喵喵有什么技能？', CAMP).reason, 'learnset-ask');
  assert.equal(policyFor('水系克什么？', CAMP).reason, 'type-chart-ask');
  assert.equal(policyFor('喵喵是哪个系的？', CAMP).reason, 'codex-fact');
  assert.equal(policyFor('「应对」是什么意思？', CAMP).reason, 'term-ask');
});

// ── ⑪「两只打起来谁更占优」+ **没有模型时也要答**（人类 2026-09-25）────────────────
//
// 人类原话：「不要说不知道！预测就说预测，不准不知道啊，ai都不知道了那要他何用？
// 模拟贵所以通过某种机制让 llm 和 agent 配合解题」。
//
// 修前实测（真机、营地页、没接模型）：问「火系克制什么属性？」拿到的是军师那句
// 「进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。」——**非答案**；
// 问「寂灭骨龙和雪影娃娃打起来谁更占优？」同样。根因两条：
//   ① `policyFor` 里没有"对位问句"这一类 ⇒ 一次工具都不调；
//   ② 路由兜底按关键词把它当军师问题 ⇒ 军师在没有对局的营地上下文里只回模板。
// 现在：这两类都进 `query_rules`，并且**没有模型时由 agent 直接把回执翻成人话**
// （数字全部来自引擎；推断必须标注；不给胜率）。
test('⑪ 对位问句进引擎 + 没有模型时也要给出「标注过的推断」', async () => {
  // ① 说法覆盖：对位问句必须被认出来（这几句都是人类/玩家真会说的）
  for (const q of ['寂灭骨龙和雪影娃娃打起来谁更占优？', '寂灭骨龙跟雪影娃娃对上谁更强？',
    '雪影娃娃和寂灭骨龙谁赢', '音速犬 vs 铠甲虫，谁占优？',
    // 名字切分的坑（真踩过）：`谁更|更强` 分开写时「谁更强」只被吃掉「谁更」，
    // 剩下一个「强」粘在名字上 ⇒ 引擎查不到「雪影娃娃强」⇒ 整条路静默返回 null。
    '寂灭骨龙和雪影娃娃谁更强？', '寂灭骨龙和雪影娃娃谁更厉害？']) {
    assert.equal(policyFor(q, CAMP).reason, 'matchup-ask', `「${q}」要被认成对位问句`);
    assert.equal(policyFor(q, CAMP).need, 'query_rules');
    assert.equal(matchupAsk(q), true);
  }
  // 反证：别的问句不许被对位抢走（对局中的"换"、相性、图鉴、阵容各归各的）
  assert.equal(matchupAsk('火系克制什么属性？'), false);
  assert.equal(policyFor('火系克制什么属性？', CAMP).reason, 'type-chart-ask');
  assert.equal(policyFor('喵喵有什么技能？', CAMP).reason, 'learnset-ask');
  assert.equal(matchupAsk('我要不要换宠？'), false);

  // ② 没有模型时的确定性答案：用假桥喂引擎事实，正文必须**逐值来自回执**并标注推断
  const facts = {
    pet: {寂灭骨龙: {pet_id: 'pet_000225', name: '寂灭骨龙', types: ['龙系', '幽系'], stats: {spe: 60}},
      雪影娃娃: {pet_id: 'pet_000112', name: '雪影娃娃', types: ['冰系', '萌系'], stats: {spe: 90}}},
    mult: {冰系: 2, 龙系: 1},
  };
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      if (fact.kind === 'pet') {
        const row = facts.pet[fact.name];
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: [`ev:types#${fact.name}`], error_type: null, failure_class: null, result: row ? {record: 'pet', ...row} : null};
      }
      if (fact.kind === 'type_multiplier') {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1, evidence_ids: [],
          error_type: null, failure_class: null,
          result: {record: 'type_multiplier', attack_element: fact.attack_element, defender_types: fact.defender_types,
            multiplier: facts.mult[fact.attack_element] ?? 1, assumption_free: true}};
      }
      return {ok: false, error_type: 'not_found', message: '假桥没有这一档', result: null};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    const context = buildContext(createGame(445), newProfile(), 'fox');
    const answer = await runCoach({message: '寂灭骨龙和雪影娃娃打起来谁更占优？', role: 'auto',
      context, memory: freshMemory(), provider: localProvider});
    const text = String(answer.text);
    assert.match(text, /雪影娃娃/, `正文必须点名引擎给的那只：${text}`);
    assert.match(text, /×2/, `倍率必须逐值来自回执：${text}`);
    assert.match(text, /90/, '速度值必须来自面板回执');
    assert.match(text, /推断/, '必须**明说是推断**（不是实测）');
    assert.match(text, /不给胜率|不给.*胜率/, '必须写清不给胜率');
    assert.doesNotMatch(text, /\d+%/, '不许出现百分数（那是伪精确）');
    // 2026-09-25 第二版：对位问句并进了**纯事实单发**那条路（0 次规划器 + 0 次正文生成），
    // 所以 `stopped` 从 `policy-no-model` 变成 `policy-fact-local`；旧值后来被
    // `tests/roco-agent-stops.test.js` 判成**死值**（登记了却没人产出）⇒ 已从 AGENT_STOPS 删掉。
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.equal((answer.toolTrace ?? []).length >= 3, true, '至少查了两只 + 两向倍率');
  } finally {
    resetRocoTools();
  }
});

// ── ⑫ 纯事实题 **0 次模型调用**（人类 A1 / 金标 c13–c24）─────────────────────────
//
// 人类 A1 的原话口径：「纯事实题问模型 0 次」。修前这些问句都走模型（`model_calls:1`），
// 而它们的答案本来只有一份事实源 —— 引擎常量或知识卡。现在：本地直接念常量，
// **规划器 0 次、正文生成 0 次**；命不中就不走这条路（返回 null，不假装知道）。
// 判据里的期望值一律**从常量现读**（`RULES`/`ITEMS`），不抄数字：常量一改，判据跟着走。
test('⑫ 纯事实题本地作答：0 次规划器 + 0 次正文生成，且数字逐值来自引擎常量', async () => {
  const cases = [
    // ⚠ 2026-09-26：这两条**不传 context** ⇒ 测的是「营地那一档」的调用形状（常量怎么念）。
    // 分档行为（手游那一档不许念这两个常量）由 ㉞ 钉，别把这一组当成"手游也这么说"。
    ['能量上限是几个豆？', String(RULES.energy.max)],
    ['5豆算满豆吗？', String(RULES.energy.max)],
    // 2026-09-25 改钉（不删）：减伤口径改用**常量/规则卡的原话**「减伤 65%（受到的伤害乘以 0.65）」。
    // 原来这里期望的是**派生**出来的 35（= (1−0.65)×100），而金标 c14 实测把那个 35 判成
    // `unsupported-number:35`：正文里的数字必须能在证据包/回执/规则常量里逐条查到，派生值查不到。
    // 口径没松（照样"逐值来自常量、现读不抄"），只是换成常量自己那个方向。
    ['防御能减伤多少？', String(Math.round(RULES.guard.reduction * 100))],
    ['回复药能回多少血？', String(ITEMS.potion.heal)],
    ['技能有冷却时间吗？', '没有技能冷却'],
    ['宠物倒下后可以免费换宠补位吗？', '不占回合'],
    // 金标 c16 / c17：换宠占不占回合、技能与道具一共几种（数量从 SKILLS/ITEMS 现数）
    ['换宠之后这回合还能出招吗？', '占用这一回合'],
    ['技能和道具一共有几种？分别是什么？', String(Object.keys(SKILLS).length)],
    // 卡背书的两条 + **如实缺源**的一条（金标 c20 / c22 / c23）
    ['中毒算属性异常吗？每回合掉多少血？', '中毒'],
    ['速度快的宠物一定先出手吗？', '不一定'],
    ['有属性本系加成吗？倍率是多少？', '没有可引用的来源'],
    // 2026-09-27 改钉（人类：「加点不要了」）：这一问现在答的是**否定句**（这一版没有加点），
    // 所以不再钉"包含常量值"，改钉"包含这句话 + 指向改性格/改天分"。上面的通用断言
    //（要有本地答案 / 要交代出处）仍然逐条过 —— 判据的意图没变。
    ['培养哪个属性最能改变先手？', '没有加点'],
  ];
  for (const [question, expected] of cases) {
    assert.equal(parametricFactAsk(question), true, `「${question}」要被认成参数化事实`);
    const local = localParametricFact(question);
    assert.ok(local && typeof local.text === 'string' && local.text.length > 10, `「${question}」要有本地答案`);
    assert.ok(local.text.includes(expected), `「${question}」的答案必须包含常量值 ${expected}：${local.text}`);
    // 改钉（2026-09-26）：玩家正文里不许再出现仓库路径（人类：「自娱自乐」）。
    // 出处改成玩家话「（游戏里的固定规则：…，不是估的）」，仓库路径仍留在 `evidence` 里。
    // 判据的意图没变：**必须交代出处状态**，不许默默抛一个数。
    // 2026-09-27：加了一条 —— 「这一版没有 X」本身也是如实说明（机制不存在时没有出处可交代）。
    assert.match(local.text, /游戏里的固定规则|来源：|缺源|没有可引用的来源|没有加点/,
      '本地事实必须交代出处状态（人话版：游戏里的固定规则；没有来源就明说）');
  }
  // 反证：别的问句不许被这条抢走（寒暄 / 决策 / 对位 / 相性各归各的）
  for (const other of ['你好', '这回合怎么打？', '寂灭骨龙和雪影娃娃谁更强？', '火系克制什么属性？']) {
    assert.equal(parametricFactAsk(other), false, `「${other}」不是参数化事实`);
    assert.equal(localParametricFact(other), null, `「${other}」不该被本地参数化这条答掉`);
  }
  // 反证（真踩到过的那一格）：`client.js` 会往正文后面追加 `RESPONSE_INSTRUCTIONS`，
  // 里面写着「道具名称只能使用回复药、净化药、能量果」—— 不许因为尾巴里有「回复药」
  // 就把「回顾上一局」判成"问回复药"（tests/coach.test.js 实测拿到过回复药那条事实）。
  const reviewWithTail = '回顾上一局' + '\n回答要求：道具名称只能使用回复药、净化药、能量果，不要把它们叫作解药或以太。';
  assert.equal(parametricFactAsk(reviewWithTail), false, '追加的指令尾巴不许把复盘判成参数化事实');
  assert.equal(localParametricFact(reviewWithTail), null);
  // 陈述句里提到「防御」也不算提问
  assert.equal(parametricFactAsk('我这回合用了防御'), false);
  // 端到端：模型可用时，纯事实题仍然**一次模型都不问**（规划器与正文都不问）
  let plan = 0;
  let generate = 0;
  const provider = {
    name: 'stub-model',
    async plan() { plan += 1; return {stop: true}; },
    async generate(packet) { generate += 1; return String(packet?.text ?? ''); },
  };
  const context = buildContext(createGame(445), newProfile(), 'fox');
  for (const question of ['能量上限是几个豆？', '回复药能回多少血？']) {
    const answer = await runCoach({message: question, role: 'auto', context, memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local', `「${question}」应当走本地单发路径`);
    assert.match(String(answer.text), /游戏里的固定规则|来源：/);
  }
  assert.equal(plan, 0, '纯事实题不许问规划器');
  assert.equal(generate, 0, '纯事实题的正文不许走模型生成');
});

// ⑫ 的补充：金标 c13–c24 **整族**都必须 0 次模型调用（12/12）。
// 这条不重跑 12 次模型（那是探针的活），只钉住"这一族每一句都被本地路径接住"：
// 逐句断言 `localFactAsk`（判定）与 `localParametricFact`（实现）一致，
// 少了任何一句这条就红 —— 判定与实现分开写死过一次，代价是整族永远进不去。
test('⑫b 金标 c13–c24 整族都被本地事实路径接住（判定与实现同源）', () => {
  const family = ['能量上限是几个豆？', '防御能减伤多少？', '回复药能回多少血？比防御更划算吗？',
    '换宠之后这回合还能出招吗？', '技能和道具一共有几种？分别是什么？', '火属性克制什么属性？',
    '技能有冷却时间吗？', '中毒算属性异常吗？每回合掉多少血？', '宠物倒下后可以免费换宠补位吗？算整局失败吗？',
    '速度快的宠物一定先出手吗？', '有属性本系加成吗？倍率是多少？', '5豆算满豆吗？'];
  const missed = family.filter((q) => !localFactAsk(q, policyFor(q, CAMP)));
  assert.deepEqual(missed, [], `这一族必须都被接住（金标 c13–c24 的 calls 期望是 0）：${missed.join('、')}`);
  // 相性那条由政策走 `query_rules`（不是参数化表），两族都要算"接住"
  assert.equal(localFactAsk('火属性克制什么属性？', policyFor('火属性克制什么属性？', CAMP)), true);
  // 反证：把判定换成"只看参数化表"，相性那条必须掉出去（证明这一族不是恒真）
  const onlyTable = family.filter((q) => parametricFactAsk(q));
  assert.ok(onlyTable.length < family.length, '相性那条不在参数化表里 —— 判定必须把政策那一半也算上');
});

// ── ⑬ 天气策略问句：查**配置**（`policies.weather_policy`）而不是让模型随口说 ────────────
//
// 人类点名过「雨天水系伤害加多少」这类问法（他自己裁决的天气层）。修前引擎的
// `query_rules{kind:'ruleset'}` 只回 counts/files/capabilities，**不含 weather_policy**
// ⇒ 教练拿不到那个 ×1.75，只能落到 `state-in-packet` 让模型自由发挥。
// 现在：引擎新增 `kind:'policy'`（逐字回配置），教练这一侧分类 + 成句，0 次模型调用。
test('⑬ 天气策略：问句进引擎的 policy 读口，正文逐值来自配置并写出处', async () => {
  const BATTLE = {mode: 'pvp-live', profile: {lineup: []}, roco_battle: {ruleset_config_id: 'mobile_s4_candidate_v3'}};
  for (const q of ['雨天水系伤害加多少？', '沙暴有什么效果？', '天气有几种？', '天气对伤害有什么影响？']) {
    assert.equal(policyAsk(q), true, `「${q}」要认成策略问句`);
    const policy = policyFor(q, BATTLE);
    assert.equal(policy.need, 'query_rules');
    assert.equal(policy.reason, 'policy-ask');
    assert.deepEqual(defaultArgsFor('query_rules', BATTLE, q),
      {kind: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v3'},
      '参数里必须带上**这一局用的配置 id**（引擎按配置回答）');
  }
  // 反证：数值问句不许被参数化事实或相性抢走
  assert.equal(policyAsk('能量上限是几个豆？'), false);
  assert.equal(policyAsk('火系克制什么属性？'), false);
  assert.equal(policyFor('天气有几种？', BATTLE).reason, 'policy-ask', '「有几种」也是天气问句，不许落到技能/道具那条');
  // 假桥喂**引擎真形状**（config 里逐字那一份）⇒ 正文必须逐值来自回执
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      assert.equal(fact.kind, 'policy');
      assert.equal(fact.name, 'weather');
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:rulesets#weather'], error_type: null, failure_class: null,
        result: {record: 'policy', name: 'weather', ruleset_config_id: fact.ruleset_config_id ?? 'legacy_sim_v1',
          enabled: true, confidence: 'OFFICIAL_CURRENT', evidence_id: 'EV-WEATHER-STANDARD-PVP',
          max_concurrent: 1, duration_turns: 8,
          effects: {雨天: {kind: 'skill_power_multiplier', element: '水系', value: 1.75, term_id: '3008',
            text: '天气为雨天时，双方的水系技能威力+75%。'}}}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const context = buildContext(createGame(445), newProfile(), 'fox');
    context.roco_battle = {ruleset_config_id: 'mobile_s4_candidate_v3'};
    const answer = await runCoach({message: '雨天水系伤害加多少？', role: 'auto', context, memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.equal(plan + generate, 0, '策略事实同样不该问模型');
    assert.match(String(answer.text), /\+75%/, `正文要带配置里的原话：${answer.text}`);
    // 2026-09-27（审计 ②，**改钉不删**）：这两条原来要求**正文**里出现 `EV-WEATHER-STANDARD-PVP`
    // 与 `weather_policy` —— 那是"要写出处"的意思，但把内部编号与字段名印到了玩家眼前
    //（还有英文枚举 `OFFICIAL_CURRENT`）。现在出处改到 `evidence`（玩家展开「依据」也看得到，
    // 追查链条不断），**正文**改成玩家的话：哪份配置 + 中文的依据等级。
    // 判据的意思没变：① 出处必须能追到那条台账；② 必须说清是配置里的哪一块。
    const evidence = (answer.evidence ?? []).join('\n');
    assert.match(evidence, /EV-WEATHER-STANDARD-PVP/, `依据区要写出台账编号：${evidence}`);
    assert.match(evidence, /weather_policy/, `依据区要写清是配置里的哪一块：${evidence}`);
    assert.doesNotMatch(String(answer.text), /EV-WEATHER|weather_policy|OFFICIAL_CURRENT|policies\./,
      `正文里不该出现内部编号/字段名/英文枚举：${answer.text}`);
    assert.match(String(answer.text), /依据等级 官方当前材料/,
      `正文要用中文说清依据等级：${answer.text}`);
    assert.match(String(answer.text), /规则配置 mobile_s4_candidate_v3 里的天气声明/,
      `正文要指明是哪份配置的天气声明：${answer.text}`);
  } finally {
    resetRocoTools();
  }
});

// ── ⑬b 天气口径按**模式**解析：营地里问游戏规则，不许回「没声明」 ────────────────────
//
// 实测缺口（2026-09-25，修 ⑬ 之后才发现）：营地/三宠练习局的上下文里**没有**
// `ruleset_config_id`，于是 ⑬ 的参数构造不带配置 ⇒ 引擎用它进程当前生效的 legacy 配置回答
// ⇒ `enabled:false`「这份配置没有声明天气层」。可玩家问的是**游戏规则**（雨天水系加成），
// 那份口径就登记在标准 PVP 模式绑定的配置里 —— 让玩家听"没声明"等于说"不知道"。
// 现在：① 没配置 id 就报**模式 id**，配置由引擎读登记表解析（教练不抄映射）；
// ② 这一局绑定的配置真没声明时，换标准 PVP 模式再问一次，并把"换了哪份"写进正文。
test('⑬b 天气策略按模式解析：没配置 id 时报模式，营地问句也拿得到数值', async () => {
  const camp = buildContext(createGame(445), newProfile(), 'fox');
  assert.deepEqual(defaultArgsFor('query_rules', camp, '雨天水系伤害加多少？'),
    {kind: 'policy', name: 'weather', mode_id: STANDARD_PVP_MODE_ID},
    '没有配置 id 时必须**指名模式**（配置由引擎解析，教练不抄「模式 → 配置」）');
  // 有配置 id 时仍然优先按配置问（口径不变）
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '天气有什么影响？'),
    {kind: 'policy', name: 'weather', mode_id: STANDARD_PVP_MODE_ID});
  const battle = buildContext(createGame(445), newProfile(), 'fox');
  battle.roco_battle = {ruleset_config_id: 'mobile_s4_candidate_v3'};
  assert.deepEqual(defaultArgsFor('query_rules', battle, '雨天水系伤害加多少？'),
    {kind: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v3'});
  // 假桥：按配置问 → 没声明；按模式问 → 逐字那一份。两次调用都要发生，且正文要写明换了口径。
  const calls = [];
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      calls.push(fact);
      assert.equal(fact.kind, 'policy');
      assert.equal(fact.name, 'weather');
      if (!fact.mode_id) {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: ['ev:rulesets#legacy'], error_type: null, failure_class: null,
          result: {record: 'policy', name: 'weather', ruleset_config_id: fact.ruleset_config_id,
            enabled: false, note: '这份配置没有声明天气层'}};
      }
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:rulesets#weather'], error_type: null, failure_class: null,
        result: {record: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v3',
          mode_id: fact.mode_id, ruleset_binding: 'mobile_s4_candidate_v3',
          enabled: true, confidence: 'OFFICIAL_CURRENT', evidence_id: 'EV-WEATHER-STANDARD-PVP',
          max_concurrent: 1, duration_turns: 8,
          effects: {雨天: {kind: 'skill_power_multiplier', element: '水系', value: 1.75, term_id: '3008',
            text: '天气为雨天时，双方的水系技能威力+75%。'}}}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const context = buildContext(createGame(445), newProfile(), 'fox');
    context.ruleset_config_id = 'legacy_sim_v1';   // 这一局绑的是没声明天气层的那份
    const answer = await runCoach({message: '雨天水系伤害加多少？', role: 'auto', context, memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.equal(plan + generate, 0, '两次读口都不该问模型');
    assert.equal(calls.filter((c) => c.mode_id).length, 1, '要换模式再问一次');
    assert.match(String(answer.text), /\+75%/, `换模式后要给出配置里的原话：${answer.text}`);
    assert.match(String(answer.text), /没有声明天气层/, '要如实说明这一局那份没声明');
    assert.match(String(answer.text), /标准 PVP 模式/, '要写明换了哪个模式的口径');
    assert.match(String(answer.text), new RegExp(STANDARD_PVP_MODE_ID), '要写出模式 id 才追得回去');
  } finally {
    resetRocoTools();
  }
});

// ── ⑰ 训练点问句但**存档不在这儿**（六宠页只送名单）：也要本地答，而不是「我在。」──
//
// 2026-09-27 **改钉**（人类：「加点不要了，按照洛手的机制来，根本没有这些」）：
// 这一支原来是"养成存档在营地那一页，去那边问"。加点退役之后，两个分支答的是**同一句话**：
// 这一版没有加点、培养＝在盒子里刷新性格/天分。判定与"0 次模型调用"这两条不变。
test('⑰ 六宠页问训练点：本地直说"这一版没有加点"，一个进度数都不编', async () => {
  const mobile = {...buildContext(createGame(445), newProfile(), 'fox'),
    profile: {pets: POOL}};   // 六宠页的真形状：只有名单，没有 tokens
  assert.equal(policyFor('我还差多少训练点满级？', mobile).reason, 'training-ask-elsewhere');
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  const answer = await runCoach({message: '我还差多少训练点满级？', role: 'auto', context: mobile,
    memory: freshMemory(), provider});
  assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
  assert.equal(plan + generate, 0, '不许问模型');
  const text = String(answer.text);
  assert.match(text, /没有加点/, `要直说这一版没有加点：${text}`);
  assert.match(text, /性格|天分/, '要指出培养是什么（改性格 / 改天分）');
  assert.match(text, /我的盒子/, '要指出在哪做（我的盒子）');
  assert.doesNotMatch(text, /训练点 \d|还差 \d+ (点|个)|培养格/, `不许报进度数、也不许提培养格：${text}`);
  // 反证：存档在手时仍走 training-ask（⑮ 钉着），不会被这一族截走
  const save = {...newProfile(), tokens: 2};
  assert.equal(policyFor('我还差多少训练点满级？', {...mobile, profile: {...save, lineup: []}}).reason, 'training-ask');
});

// ── ⑱ 按属性找精灵（P0-a）：600 只规模的第一个"该找谁"读口 ─────────────────────────
//
// 真机实测（2026-09-25，8765 接了 key）：「我想练一只抗龙系的伙伴，配哪四招？」
// → agent **一次工具都没调**（`policy-route-without-tools`）就答了，含糊、无依据。
// 原因是 622 只里"谁抗龙系"没有读口：`pet` 只按 id/名字查一只，`type_row` 只回属性层面。
// 这一条钉住修好之后的行为：判定 → 参数（**方向**不许搞反）→ 本地成句（值逐字来自回执）。
test('⑱ 按属性找精灵：判定、方向、参数与成句（0 次模型调用）', () => {
  const cases = [
    ['我想练一只抗龙系的伙伴，配哪四招？', {kind: 'catalog', resist: '龙系'}],
    ['谁抗龙系？', {kind: 'catalog', resist: '龙系'}],
    ['有没有怕冰系的精灵？', {kind: 'catalog', weak: '冰系'}],
    ['哪些精灵克制水系？', {kind: 'catalog', beats: '水系'}],
    ['龙系的精灵有哪些？', {kind: 'catalog', element: '龙系'}],
    ['有哪些精灵被龙系克？', {kind: 'catalog', weak: '龙系'}],
  ];
  for (const [q, want] of cases) {
    assert.equal(catalogAsk(q, CAMP), true, `「${q}」要认成按属性找精灵`);
    assert.equal(policyFor(q, CAMP).reason, 'catalog-ask', `「${q}」的政策`);
    assert.deepEqual(defaultArgsFor('query_rules', CAMP, q), want, `「${q}」的参数（方向不许反）`);
    assert.equal(localFactAsk(q, policyFor(q, CAMP)), true, `「${q}」要走本地单发`);
  }
  // 反证 ①：属性层面的相性问句（type_chart）与队内/推荐问句不许被抢走
  for (const q of ['火系克制什么属性？', '水系克什么？', '对面火系我该带谁', '我这六只里谁抗龙系？']) {
    assert.equal(catalogAsk(q, CAMP), false, `「${q}」不该归 catalog`);
    assert.notEqual(policyFor(q, CAMP).reason, 'catalog-ask', `「${q}」不许被 catalog 抢走`);
  }
  // 反证 ②：「怕 X」与「克制 X」是两个方向（实测 14 只 vs 111 只，不许互换）
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '谁怕龙系？'), {kind: 'catalog', weak: '龙系'});
  assert.deepEqual(defaultArgsFor('query_rules', CAMP, '谁克制龙系？'), {kind: 'catalog', beats: '龙系'});
});

test('⑱b 按属性找精灵：本地正文逐值来自回执，且写明"检索结果不是推荐"', async () => {
  const rows = [
    {pet_id: 'pet_000001', name: '机械方方', types: ['机械系'], stats: {hp: 60}, role: null},
    {pet_id: 'pet_000002', name: '立方人', types: ['机械系', '火系'], stats: {hp: 70}, role: '承伤'},
  ];
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      assert.equal(fact.kind, 'catalog');
      assert.equal(fact.resist, '龙系', '方向必须是"抗"');
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:types.json#龙系', 'ev:pets.json#catalog'], error_type: null, failure_class: null,
        result: {record: 'catalog', filters: {resist: '龙系'}, matched_types: ['机械系'],
          total_matched: 38, offset: 0, limit: 12, returned: 2, truncated: true, pets: rows}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const answer = await runCoach({message: '我想练一只抗龙系的伙伴，配哪四招？', role: 'auto',
      context: buildContext(createGame(445), newProfile(), 'fox'), memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
    assert.equal(plan + generate, 0, '这一族不许问模型（回执就是结论）');
    const text = String(answer.text);
    assert.match(text, /一共 38 只/, `总数要来自回执：${text}`);
    assert.match(text, /机械方方/, '要摆出引擎给的名单');
    assert.match(text, /承伤/, '回执里有的标注照带');
    // 2026-09-27（审计 ②，**改钉不删**）：原来要求正文里出现 `types.json`（数据文件名）。
    // 出的错在于落点 —— 玩家不需要读文件名，需要知道「这是从游戏图鉴的相性表逐字抄的」。
    // 判据的意思没变：**必须写出处**；现在查的是这句人话（文件名留在 evidence 里）。
    assert.match(text, /逐字来自游戏图鉴的相性表/, `要写出处（人话）：${text}`);
    assert.doesNotMatch(text, /types\.json|\.js\b/, `正文里不许出现数据文件名：${text}`);
    assert.match(text, /不是推荐/, '必须说明这是检索结果，不是推荐');
  // 玩家可见正文里**不许出现对象的字符串化**（2026-09-26 实测踩到：队形那句把 `knownPets()` 的
  // `{id,name}` 对象直接 join，印出「[object Object]、[object Object]」——人类点名的可读性问题同一类）。
  assert.doesNotMatch(text, /\[object Object\]/, `正文里不许出现 [object Object]：${text}`);
    assert.doesNotMatch(text, /胜率|最强|更好/, `不许出现推荐/胜率式结论：${text}`);
  } finally {
    resetRocoTools();
  }
});

// ── ⑲ 这几招它学得到吗（P0-a 的最后一块）：逐招对照学习表，三态照实说 ────────────────
//
// 「配哪四招」缺的最后一步：候选找出来了（`catalog`），但"这套配招合法吗"过去没有只读读口
// —— `team/evaluate` 要凑满模式声明的队伍规模，凑不齐进不去；让模型自己比学习表就是猜。
// 这一条钉：① 枚举式问句判给它、非枚举问句（「喵喵学得到哪些技能？」）仍然归学习表；
// ② 参数（精灵名 + 枚举出的技能）取对；③ 正文三态照实说，且**不评价配招强弱**。
test('⑲ 配招可学性：判定、参数，且不许抢走学习表问句', () => {
  const ctx = {...CAMP_SAVE, profile: {...CAMP_SAVE.profile,
    lineup: [{id: 'fox', name: '烬尾狐', types: ['火系']}]}};
  const cases = [
    ['烬尾狐带火花、追猎、防御、休息回复合法吗？', ['火花', '追猎', '防御', '休息回复']],
    ['烬尾狐学得到火花和追猎吗？', ['火花', '追猎']],
  ];
  for (const [q, skills] of cases) {
    assert.equal(legalityAsk(q, ctx), true, `「${q}」要认成配招可学性问句`);
    assert.equal(policyFor(q, ctx).reason, 'legality-ask', `「${q}」的政策`);
    const args = defaultArgsFor('query_rules', ctx, q);
    assert.equal(args.kind, 'legality');
    assert.equal(args.name, '烬尾狐', `精灵名要取对：${JSON.stringify(args)}`);
    assert.deepEqual(args.skills, skills, `枚举的技能要切对：${JSON.stringify(args)}`);
    assert.equal(validToolArgs('query_rules', {...args, state_version: 0}), true);
  }
  // 名单里没有的名字也允许（问一只自己没有的）：照 learnsetTarget 的先例交给引擎 404
  assert.deepEqual(defaultArgsFor('query_rules', ctx, '遁鼠带抓挠、震击合法吗？'),
    {kind: 'legality', name: '遁鼠', skills: ['抓挠', '震击']});
  // 反证 ①：非枚举问句仍归学习表（判据 ⑧ 钉着的那条不许被抢）
  for (const q of ['喵喵学得到哪些技能？', '喵喵有什么技能？']) {
    assert.equal(legalityAsk(q, ctx), false, `「${q}」不该归可学性`);
    assert.notEqual(policyFor(q, ctx).reason, 'legality-ask');
  }
  // 反证 ②：只报一个技能的问句也不接（枚举 ≥2 才算"配招"）
  assert.equal(legalityAsk('烬尾狐带火花吗？', ctx), false);
  // 反证 ③：不带精灵名的枚举问句不接（免得把「火花、追猎哪个好」当可学性）
  assert.equal(legalityAsk('火花、追猎哪个好？', ctx), false);
  assert.equal(legalityAsk('这回合怎么打？', ctx), false);
});

test('⑲b 配招可学性：三态照实说（学得到 / 学不到 / 认不出来），0 次模型调用', async () => {
  const rows = [
    {ref: '抓挠', skill_id: 'skill_000246', name: '抓挠', learnable: true, via: ['native']},
    {ref: '偏振', skill_id: 'skill_000999', name: '偏振', learnable: false, via: []},
  ];
  const makeBridge = (result) => ({
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      assert.equal(fact.kind, 'legality');
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:learnsets.json#pet_000186'], error_type: null, failure_class: null, result};
    },
  });
  const run = async (result) => {
    configureRocoTools({client: makeBridge(result), stateVersion: 0});
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    try {
      const answer = await runCoach({message: '小翼龙带抓挠、偏振合法吗？', role: 'auto',
        context: buildContext(createGame(445), newProfile(), 'fox'), memory: freshMemory(), provider});
      assert.equal(plan + generate, 0, '这一族不许问模型');
      return answer;
    } finally { resetRocoTools(); }
  };
  // ① 有学不到的 ⇒ legal:false，正文点名哪一招、为什么不合法
  const mixed = await run({record: 'legality', pet_id: 'pet_000186', pet_name: '小翼龙', requested: 2,
    learnable: 1, all_learnable: false, unknown_skills: [], legal: false, skills: rows});
  assert.equal(mixed.agentStop, 'policy-fact-local');
  assert.match(String(mixed.text), /抓挠（本系）学得到/, String(mixed.text));
  assert.match(String(mixed.text), /偏振\*\*学不到\*\*/, String(mixed.text));
  assert.match(String(mixed.text), /不合法/, '要给出结论');
  assert.match(String(mixed.text), /不评价配招强弱|可学性/, '要说明这只是可学性');
  assert.doesNotMatch(String(mixed.text), /胜率|更强|更优/, '不许评价强弱');
  // ② 全学得到 ⇒ legal:true
  const good = await run({record: 'legality', pet_id: 'pet_000186', pet_name: '小翼龙', requested: 1,
    learnable: 1, all_learnable: true, unknown_skills: [], legal: true,
    skills: [rows[0]]});
  assert.match(String(good.text), /合法/, String(good.text));
  // ③ 有认不出来的技能 ⇒ legal:null，且**不许**说成"不合法"
  const unknown = await run({record: 'legality', pet_id: 'pet_000186', pet_name: '小翼龙', requested: 2,
    learnable: 1, all_learnable: false, unknown_skills: ['偏振'], legal: null,
    skills: [rows[0], {...rows[1], skill_id: undefined, learnable: false, unknown_skill: true}]});
  assert.match(String(unknown.text), /查不到这个名字/, String(unknown.text));
  assert.match(String(unknown.text), /不等于学不到/, '认不出来必须与"学不到"分开说');
  assert.doesNotMatch(String(unknown.text), /不合法/, `认不出来时不许下"不合法"的结论：${unknown.text}`);
});

test('⑲c 引擎认不出这只时：说清是哪一层的数据，不许退化成模板', async () => {
  // 真机实测（8765）：「烬尾狐带火花、追猎合法吗？」—— 烬尾狐是**本仓练习引擎**的伙伴，
  // 不在手游图鉴（622 只）里 ⇒ 引擎 404「未知精灵名」。修前这一路静默 return null，
  // 玩家拿到的是模板；现在要把引擎原话 + 两层数据的边界说出来。
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {tool: 'query_rules', ok: false, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0,
        coverage: 0, evidence_ids: [], error_type: 'not_found', failure_class: 'request',
        message: '未知精灵名：烬尾狐', result: null};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    const context = {...buildContext(createGame(445), newProfile(), 'fox'),
      profile: {...newProfile(), lineup: [{id: 'fox', name: '烬尾狐', types: ['火系']}]}};
    const answer = await runCoach({message: '烬尾狐带火花、追猎合法吗？', role: 'auto', context,
      memory: freshMemory(), provider: localProvider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    const text = String(answer.text);
    assert.match(text, /未知精灵名：烬尾狐/, `要说引擎的原话：${text}`);
    assert.match(text, /不在手游图鉴/, '要解释这是两层数据');
    assert.match(text, /编|不凭印象/, '要说明为什么不猜');
  } finally { resetRocoTools(); }
});

test('⑲d 重名形态：本地列候选让玩家挑，不许替另一只形态作答', async () => {
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:pets.json#pet_000020', 'ev:pets.json#pet_000356'], error_type: null, failure_class: null,
        result: {record: 'pet', ambiguous: true, queried_name: '遁鼠',
          matches: [{pet_id: 'pet_000020', name: '遁鼠'}, {pet_id: 'pet_000356', name: '遁鼠'}]}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    const answer = await runCoach({message: '遁鼠带抓挠、震击合法吗？', role: 'auto',
      context: buildContext(createGame(445), newProfile(), 'fox'), memory: freshMemory(), provider: localProvider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    const text = String(answer.text);
    assert.match(text, /对应 2 只不同形态/, text);
    assert.match(text, /pet_000020/, '要列出候选的稳定 id');
    assert.match(text, /pet_000356/, '两只都要列出');
    assert.doesNotMatch(text, /这套配招(不)?合法|这三招都学得到|学不到（学习表/, `没挑形态之前不许下结论：${text}`);
    assert.match(text, /先不能判合法/, '要明说"判不了"，而不是给一个结论');
  } finally { resetRocoTools(); }
});

// ── ⑳ 名单计数与「被拒之后不许用『我在。』敷衍一个问题」──────────────────────────
//
// 真机实测（手游那一档，2026-09-25）：「我一共有多少只精灵？」被判成 `state-in-packet`，
// 模型答完之后**没过事实检查**，玩家拿到的是陪练模板「我在。」
// —— 一个"名单里有几只"的事实，既不该问模型，也不该用状态回报来答。
test('⑳ 名单计数：本地作答（持有一页要分开说），0 次模型调用', async () => {
  // 2026-09-28 改钉（**旧值不删**：这里原来是 `length: 48` / `total: 48`）。
  // 人类 2026-09-28 逐字拍板「所有精灵实装，这样就不需要我的精灵了，直接全筛选」
  // （`docs/roadmap/FEASIBILITY-547-ALL.md` §⑩）⇒ 名单规模从 48 变成 542（冻结层）；
  // 夹具跟着换规模，好让「持有一页要分开说」这条判据在**新的规模**上继续被跑到。
  // 判据本身没放宽：仍然是「本地作答、0 次模型调用、总数不许被说成一页的条数」。
  const held = {pets: Array.from({length: 542}, (_, i) => ({id: `own-${i}`, name: `宠${i}`, types: ['虫系']})),
    pool_summary: {total: 542, source: 'owned'}};
  const page = {pets: Array.from({length: 12}, (_, i) => ({id: `pet_${i}`, name: `图${i}`, types: ['虫系']})),
    pool_summary: {total: 622, page: 1, pages: 52, source: 'catalog'}};
  for (const q of ['我一共有多少只精灵？', '我有多少只伙伴？']) {
    assert.equal(policyFor(q, {profile: held}).reason, 'roster-count-ask', `「${q}」要判给名单计数`);
  }
  const answer = async (context, message = '我一共有多少只精灵？') => {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const a = await runCoach({message, role: 'auto',
      context: {...buildContext(createGame(445), newProfile(), 'fox'), profile: context},
      memory: freshMemory(), provider});
    assert.equal(plan + generate, 0, '这一族不许问模型');
    return a;
  };
  const owned = await answer(held);
  assert.equal(owned.agentStop, 'policy-fact-local');
  assert.match(String(owned.text), /542 只/, `持有总数要报出来：${owned.text}`);
  assert.doesNotMatch(String(owned.text), /我在。/, '不许用状态回报答事实问句');
  // 「是一页」时：这一页 12 只 + 总数 622 只都要说，且不许把 12 说成总数
  const paged = await answer(page);
  assert.match(String(paged.text), /这一页给了 12 只/, `要说清这是一页：${paged.text}`);
  assert.match(String(paged.text), /622/, '总数要报出来');
  // 反证：不是计数的问句不许被这一族抢走
  assert.equal(policyFor('这只怎么培养？', {profile: held}).reason !== 'roster-count-ask', true);
  assert.equal(policyFor('雨天水系伤害加多少？', {profile: held}).reason !== 'roster-count-ask', true);
  // ㉒ 名单**列举**（「我有哪些伙伴？」）：同一族、本地作答、只列名单里真的有的
  assert.equal(policyFor('我有哪些伙伴？', {profile: held}).reason, 'roster-list-ask');
  assert.equal(policyFor('我的精灵都有谁？', {profile: held}).reason, 'roster-list-ask');
  const listed = await answer(held, '我有哪些伙伴？');
  assert.equal(listed.agentStop, 'policy-fact-local');
  assert.match(String(listed.text), /542 只/, `要报总数：${listed.text}`);
  assert.match(String(listed.text), /宠0/, '要列出名单里的名字');
  // 542 − 12（一页枚举上限）= 530（改钉前的旧值是 48 − 12 = 36）。
  assert.match(String(listed.text), /还有 530 只没列出来/, '列不全时要说清还有多少没列');
  assert.doesNotMatch(String(listed.text), /我在。/, '不许用状态回报答名单问句');
  // 反证：名单是**一页**时同样要分开说（这一页 12 只 / 总数 622 只）
  const listedPage = await answer(page, '我有哪些伙伴？');
  assert.match(String(listedPage.text), /总数是 622 只（这一页给了 12 只）/, String(listedPage.text));
  // 反证：不是名单问句的句子不许被这一族抢走
  assert.equal(policyFor('铠甲虫是哪个系的？', {profile: held}).reason !== 'roster-list-ask', true);
});

test('⑳b 模型回答被事实检查拒掉时，问句不许回「我在。」', async () => {
  // 陪练路由 + 玩家问的是**问题** ⇒ 被拒之后要如实说"这次没给结论、怎么再问"。
  // 一份**必然过不了守卫**的模型回答：编了一个回执里没有的数字 + 胜率式断言。
  const stub = {name: 'stub-model', async generate() { return '它一定是龙系，胜率 87%。'; }};
  const context = {...buildContext(createGame(445), newProfile(), 'fox'), profile: {pets: [], pool_summary: {}}};
  // 2026-09-25 改钉：原来用「烬尾狐是谁？」——那一问现在由 `pet-intro-ask` **本地**作答
  // （引擎 404 也算结论），模型不会被调用、也就没有"被拒"这回事。换成一句仍走模型的问题
  // 来验同一条纪律：陪练路由 + 问句 + 模型回答被拒 ⇒ 不许回「我在。」。
  const answer = await runCoach({message: '接下来我该先做什么？', role: 'companion', context,
    memory: freshMemory(), provider: stub});
  const text = String(answer.text);
  assert.doesNotMatch(text, /胜率 87/, `被拒的模型正文绝不能发出去：${text}`);
  assert.doesNotMatch(text, /^我在。$/, `问句被拒之后不许只回「我在。」：${text}`);
  assert.match(text, /没给结论|没通过事实检查/, `要说清这次为什么没给结论：${text}`);
  assert.equal(answer.validation?.rejected, true, '回执要如实记下"模型的回答被拒了"');
  assert.equal(answer.validation?.deliveredText, 'local-template');
});

// ── ㉑ 追加的「回答要求」不许污染判定（真机实测：问「烬尾狐是谁？」答成「没有技能冷却」）──
//
// `client.js` 会往正文后面追加 `RESPONSE_INSTRUCTIONS`（里面有「不要编造**技能冷却**」）。
// `parametricFactAsk` 的守卫只看**前 60 字** —— 那段要求短得能塞进前 60 字，于是**任何**
// 问题都可能命中「技能」+「冷却」这条参数化事实。真机实测（/xiaoya.html）：问「烬尾狐是谁？」
// 得到「本游戏**没有技能冷却**」。判定必须只看玩家问的那句；模型那边照旧拿到全文。
test('㉑ 追加的回答要求不许污染判定：只按玩家那句判', async () => {
  const {RESPONSE_INSTRUCTIONS} = await import('../src/coach/client.js');
  const withInstr = (q) => q + RESPONSE_INSTRUCTIONS;
  assert.equal(playerQuestion(withInstr('我有哪些伙伴？')), '我有哪些伙伴？', '要切得干净');
  assert.equal(parametricFactAsk(withInstr('烬尾狐是谁？')), false,
    '「烬尾狐是谁？」不许命中任何参数化事实（修前命中的是「技能冷却」）');
  // 2026-09-25 改钉：这一问现在有**引擎**那条路（`pet-intro-ask`，查得到摆记录、查不到说"图鉴里没有"），
  // 不再落 `state-in-packet`；但这一条要钉的仍然是**不许被参数化常量吃掉**。
  assert.equal(policyFor(withInstr('烬尾狐是谁？'), {}).reason, 'pet-intro-ask',
    '这条问句该走图鉴那条路，而不是本地常量');
  // 正例：真的问冷却 / 天气 / 训练点，仍然要命中（截断不能把真问题也切掉）
  assert.equal(parametricFactAsk(withInstr('技能冷却多久？')), true);
  assert.match(String(localParametricFact(withInstr('技能冷却多久？'))?.text), /\*\*没有技能冷却\*\*/, '真问题仍要答得出来');
  assert.equal(policyFor(withInstr('雨天水系伤害加多少？'), {}).reason, 'policy-ask');
  assert.equal(policyFor(withInstr('我还差多少训练点满级？'), CAMP_SAVE).reason, 'training-ask');
  // 反证（机制级）：**不做切分**时，那段要求确实把「技能冷却」带进了前 60 字 ——
  // 这就是修前那条假命中的来源；切分之后同一个 head 里不再有它。
  const raw = withInstr('烬尾狐是谁？');
  assert.match(raw.slice(0, 60), /技能冷却/,
    '前提：追加的回答要求会把「技能冷却」带进前 60 字（修前的命中来源）');
  assert.doesNotMatch(playerQuestion(raw).slice(0, 60), /技能冷却/,
    '切分之后同一个 head 里不许再有它');
});

// ── ㉒ 「X 是谁」：查得到摆图鉴记录，查不到就把"图鉴里没有"说成结论 ──────────────────
//
// 真机实测（/xiaoya.html）：这一族判成 `state-in-packet` ⇒ 只能让模型凭记忆答，
// 而且模型的回答常常过不了事实检查 ⇒ 玩家拿到"这次没给结论"。现在两半都本地：
//   ① 引擎查得到 ⇒ 摆记录（属性/种族值/特性技能/学习表条数 + 你自己那只的等级与定位）；
//   ② 引擎 404 ⇒ 「图鉴（622 只）里没有这个名字 + 你名单里也没有」—— 这才是可核验的结论。
test('㉒ 「X 是谁」走引擎图鉴，查不到也是结论（0 次模型调用）', async () => {
  const ctx = {profile: {pets: [{id: 'own-0001', name: '铠甲虫', types: ['虫系'], level: 95, role: '坦克'}]}};
  for (const [q, name] of [['铠甲虫是谁？', '铠甲虫'], ['介绍一下喵喵', '喵喵'], ['说说雪影娃娃', '雪影娃娃']]) {
    assert.equal(petIntroAsk(q), true, `「${q}」要认成图鉴介绍`);
    assert.equal(policyFor(q, ctx).reason, 'pet-intro-ask', `「${q}」的政策`);
    assert.deepEqual(defaultArgsFor('query_rules', ctx, q), {kind: 'pet', name}, `「${q}」的参数`);
  }
  // 反证：代词/局面问句不许被抢走
  for (const q of ['这只精灵是谁的？', '谁是队长？', '我这六只谁速度最快？', '这回合怎么打？']) {
    assert.equal(petIntroAsk(q), false, `「${q}」不该认成图鉴介绍`);
    assert.notEqual(policyFor(q, ctx).reason, 'pet-intro-ask');
  }
  // ① 查得到：记录逐值来自回执
  const known = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      if (fact.kind === 'pet') {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: ['ev:pets.json#pet_000012'], error_type: null, failure_class: null,
          result: {record: 'pet', pet_id: 'pet_000012', name: '铠甲虫', title: '铠甲虫',
            types: ['虫系'], stats: {hp: 132, atk: 95, def: 128, spa: 43, spd: 82, spe: 75},
            // 2026-09-28 改钉（**旧值不删**：这里原来是 `stones: 17, total: 48`）。
            // 铠甲虫的可玩层学习表现在是抓包三桶：native 13 + blood 18 + machine(技能石) 16 = 47
            // （`layer-playable-48/support-matrix.json#pets[pet_id=pet_000012].learnset`）。
            // 这是**合成回执**，但这个数字现在与磁盘上的真实产物一致。
            stat_total: 555, feature_skill_id: 'skill_000057', learnset_summary: {native: 13, blood: 18, stones: 16, total: 47}}};
      }
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:skills.json#skill_000057'], error_type: null, failure_class: null,
        result: {record: 'skill', skill_id: 'skill_000057', name: '坚韧铠甲'}};
    },
  };
  configureRocoTools({client: known, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const answer = await runCoach({message: '铠甲虫是谁？', role: 'auto',
      context: {...buildContext(createGame(445), newProfile(), 'fox'), profile: ctx.profile},
      memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
    assert.equal(plan + generate, 0, '这一族不许问模型');
    const text = String(answer.text);
    assert.match(text, /虫系/, `属性要摆出来：${text}`);
    assert.match(text, /555/, '种族值合计');
    assert.match(text, /坚韧铠甲/, '特性技能按 id 查到的名字');
    assert.match(text, /学习表 47 条/, '学习表条数（2026-09-28 前是 48：旧层用的是 wiki 技能石桶）');
    assert.match(text, /own-0001，95 级，定位 坦克/, '你自己那只的等级与定位也要带上');
    assert.doesNotMatch(text, /铠甲虫（铠甲虫）/, 'title 与名字相同时不许重复写');
    assert.doesNotMatch(text, /特性「特性/, '页面给的机制行原文照搬，不许再包一层');
  } finally { resetRocoTools(); }
  // ② 查不到：把"图鉴里没有 + 名单里没有"说成结论
  const missing = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {tool: 'query_rules', ok: false, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0,
        coverage: 0, evidence_ids: [], error_type: 'not_found', failure_class: 'request',
        message: '未知精灵名：烬尾狐', result: null};
    },
  };
  configureRocoTools({client: missing, stateVersion: 0});
  try {
    const answer = await runCoach({message: '烬尾狐是谁？', role: 'auto',
      context: {...buildContext(createGame(445), newProfile(), 'fox'), profile: ctx.profile},
      memory: freshMemory(), provider: localProvider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    const text = String(answer.text);
    assert.match(text, /未知精灵名：烬尾狐/, '要说引擎的原话');
    assert.match(text, /手游图鉴（622 只）里没有这个名字/, '要把"图鉴里没有"说成结论');
    assert.match(text, /你的名单里也没有/, '名单里有没有也要说');
    assert.doesNotMatch(text, /也许是|可能是别的/, `不许猜它是哪只：${text}`);
  } finally { resetRocoTools(); }
});

// ── ㉓ 多形态名（重名）：「X 是谁」不许印成「属性未登记」──────────────────────────
//
// 真机实测（600 只规模抽样，P2 第一刀）：622 只里有 **62 个名字是重名的**（涉及 180 只，
// 一个名字最多 6 只形态）。引擎按名字查会回 `ambiguous`，而那一份回执**没有** types/stats ——
// 修前模板直接印「属性未登记」（抽样 30 只里 8 只中招），看起来像"引擎没数据"，其实是没读重名分支。
test('㉓ 多形态名：列候选 + 逐只面板，或列候选并请玩家挑（0 次模型调用）', async () => {
  const makeBridge = (matches) => ({
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      if (fact.kind === 'pet' && fact.name) {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: matches.map((row) => `ev:pets.json#${row.pet_id}`), error_type: null, failure_class: null,
          result: {record: 'pet', ambiguous: true, queried_name: fact.name, matches}};
      }
      const row = matches.find((item) => item.pet_id === fact.pet_id);
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: [`ev:pets.json#${fact.pet_id}`], error_type: null, failure_class: null,
        result: {record: 'pet', pet_id: row.pet_id, name: row.name, types: row.types, stats: row.stats,
          stat_total: Object.values(row.stats).reduce((a, b) => a + b, 0), learnset_summary: {native: 1, blood: 0, stones: 0, total: 1}}};
    },
  });
  const run = async (matches, message) => {
    configureRocoTools({client: makeBridge(matches), stateVersion: 0});
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    try {
      const answer = await runCoach({message, role: 'auto',
        context: buildContext(createGame(445), newProfile(), 'fox'), memory: freshMemory(), provider});
      assert.equal(plan + generate, 0, '这一族不许问模型');
      return answer;
    } finally { resetRocoTools(); }
  };
  // ① 2 只形态：逐只给面板（属性 + 种族值合计），并请玩家挑一只
  const two = await run([
    {pet_id: 'pet_000270', name: '刺盔虫', types: ['水系', '毒系'], stats: {hp: 94, atk: 33, def: 61, spa: 79, spd: 88, spe: 80}},
    {pet_id: 'pet_000377', name: '刺盔虫', types: ['水系', '毒系'], stats: {hp: 94, atk: 33, def: 61, spa: 79, spd: 88, spe: 80}},
  ], '刺盔虫是谁？');
  assert.equal(two.agentStop, 'policy-fact-local');
  const twoText = String(two.text);
  assert.match(twoText, /对应 2 只不同形态/, twoText);
  assert.match(twoText, /pet_000270/, '候选要带稳定 id');
  assert.match(twoText, /水系\|毒系/, '要给出属性（修前这里印的是「属性未登记」）');
  assert.match(twoText, /种族值合计 435/, '逐只面板');
  assert.doesNotMatch(twoText, /属性未登记/, '不许再印「属性未登记」');
  assert.match(twoText, /说一个 pet_id/, '要请玩家挑一只（不替另一只形态作答）');
  // ② 6 只形态：仍然列候选（不硬挑一只）
  const many = await run([
    {pet_id: 'pet_000534', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    {pet_id: 'pet_000580', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    {pet_id: 'pet_000581', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    {pet_id: 'pet_000582', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    {pet_id: 'pet_000583', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    {pet_id: 'pet_000584', name: '钻石蜗', types: ['光系', '地系'], stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
  ], '钻石蜗是谁？');
  const manyText = String(many.text);
  assert.match(manyText, /对应 6 只不同形态/, manyText);
  // 修后：列出来的那 ≤4 只都会带上逐只面板，剩下的写「等 N 只」
  assert.match(manyText, /（pet_000534）：光系\|地系，种族值合计 6/, '列出来的形态要给面板');
  assert.match(manyText, /等 6 只|对应 6 只不同形态/, '要写清总数');
  assert.doesNotMatch(manyText, /属性未登记/);
});

// ── ㉔ 事实类回答的**下界**：模型编的数字一个都不许发出去（新能力那一族也要钉）────────
//
// 这一条补的是"事实必须由引擎支撑"的**反面**：让模型返回一个编造的数字（回执里没有），
// 整条链路必须把它拦下来，并且回退到**引擎本来那份结论**（而不是把编的发给玩家）。
// 与 `tests/roco-server-side-guard.test.js` 同一条守卫，但覆盖的是这两轮新加的能力路由。
test('㉔ 模型编造的数字不许发出去：catalog / legality / policy 三条路由逐一验证', async () => {
  const cases = [
    {
      message: '我想练一只抗龙系的伙伴，配哪四招？',
      result: {record: 'catalog', filters: {resist: '龙系'}, matched_types: ['机械系'],
        total_matched: 38, offset: 0, limit: 12, returned: 1, truncated: true,
        pets: [{pet_id: 'pet_000001', name: '机械方方', types: ['机械系'], stats: {hp: 60}, role: null}]},
      fabricated: ['999', '87%'],
      mustKeep: ['38 只', '机械方方'],
    },
    {
      message: '小翼龙带抓挠、震击合法吗？',
      result: {record: 'legality', pet_id: 'pet_000186', pet_name: '小翼龙', requested: 2, learnable: 1,
        all_learnable: false, unknown_skills: [], legal: false,
        skills: [{ref: '抓挠', skill_id: 'skill_000246', name: '抓挠', learnable: true, via: ['native']},
          {ref: '震击', skill_id: 'skill_000999', name: '震击', learnable: false, via: []}]},
      fabricated: ['9999'],
      mustKeep: ['学不到'],
    },
    {
      message: '雨天水系伤害加多少？',
      result: {record: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v3',
        mode_id: 'pvp-standard-six-pet', enabled: true, confidence: 'OFFICIAL_CURRENT',
        evidence_id: 'EV-WEATHER-STANDARD-PVP', duration_turns: 8,
        effects: {雨天: {kind: 'skill_power_multiplier', element: '水系', value: 1.75,
          text: '天气为雨天时，双方的水系技能威力+75%。'}}},
      fabricated: ['300%'],
      mustKeep: ['+75%'],
    },
  ];
  for (const item of cases) {
    const bridge = {
      baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
      async query() {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: ['ev:test'], error_type: null, failure_class: null, result: item.result};
      },
    };
    configureRocoTools({client: bridge, stateVersion: 0});
    try {
      let calls = 0;
      const provider = {name: 'fabricating-model',
        async generate() {
          calls += 1;
          return `按引擎说：${item.fabricated.join('、')}——这一条是编的。`;
        }};
      const answer = await runCoach({message: item.message, role: 'auto',
        context: buildContext(createGame(445), newProfile(), 'fox'), memory: freshMemory(), provider});
      assert.ok(calls >= 0, 'provider 可能被调用（模型在场）');
      const text = String(answer.text);
      for (const bad of item.fabricated) {
        assert.doesNotMatch(text, new RegExp(bad.replace('%', '%')),
          `「${item.message}」的正文里出现了回执里没有的数字 ${bad}：${text}`);
      }
      for (const good of item.mustKeep) {
        assert.ok(text.includes(good), `回退后必须给出引擎的结论（缺 ${good}）：${text}`);
      }
      // 只要有模型参与，就必须留下"被拦过"的痕迹（validation 的如实回执）
      if (calls > 0) assert.equal(answer.validation?.valid, false, '模型被拦时 validation.valid 必须是 false');
    } finally { resetRocoTools(); }
  }
});

// ── ㉕ 「我这几只里谁抗龙系」：引擎查 + 本层求交集（一次问清，不靠分页）─────────────
//
// 计划文档 §3 的目标流程里，玩家最自然的问法就是**队内**那句。它和普通检索的区别在于：
// 交集必须**完整** —— 引擎默认分页只取前 N 只，用分页凑交集会给出假的"你队里 0 只"
// （真机实测：怕冰系的问句在分页下就是 0，而全库有 256 只）。所以参数带 `pet_ids`，
// 引擎只在这些 id 里找；本层只做集合运算，不产生任何新事实。
test('㉕ 队内属性检索：只比名单里的物种 id，交集完整（0 次模型调用）', async () => {
  const ctx = {profile: {
    lineup: [{id: 'pet_000186', name: '小翼龙', types: ['龙系', '翼系']},
      {id: 'own-0001', species_id: 'pet_000012', name: '铠甲虫', types: ['虫系']}],
    pets: [{id: 'own-0002', species_id: 'pet_000020', name: '遁鼠', types: ['普通系']}]}};
  assert.deepEqual(teamSpeciesIds(ctx), ['pet_000186', 'pet_000012', 'pet_000020'],
    '物种 id 要从 lineup + pets 两边收，own-XXXX 用 species_id 换');
  for (const q of ['我这几只里谁抗龙系？', '我这三只谁克制龙系？', '我这几只里有没有怕冰系的？']) {
    assert.equal(catalogTeamAsk(q, ctx), true, `「${q}」要认成队内检索`);
    assert.equal(policyFor(q, ctx).reason, 'catalog-team-ask');
    const args = defaultArgsFor('query_rules', ctx, q);
    assert.deepEqual(args.pet_ids, ['pet_000186', 'pet_000012', 'pet_000020'], `「${q}」要带上名单里的物种 id`);
    assert.equal(validToolArgs('query_rules', {...args, state_version: 0}), true);
  }
  // 反证 ①：不在队内的问句仍走全库检索（不许被这一族吃掉）
  assert.equal(catalogTeamAsk('谁抗龙系？', ctx), false);
  assert.equal(policyFor('谁抗龙系？', ctx).reason, 'catalog-ask');
  assert.equal(defaultArgsFor('query_rules', ctx, '谁抗龙系？').pet_ids, undefined, '全库检索不带 pet_ids');
  // 反证 ②：名单里**没有**物种 id（只有名字/实例 id 也换不出物种）⇒ 不接这一族
  const nameless = {profile: {pets: [{id: 'own-0009', name: '某只'}]}};
  assert.equal(catalogTeamAsk('我这几只里谁抗龙系？', nameless), false);
  assert.equal(policyFor('我这几只里谁抗龙系？', nameless).reason !== 'catalog-team-ask', true);
  // ③ 本地成句：命中逐只摆出来 + 全库数 + 不替玩家挑替补
  const seen = [];
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      seen.push(fact.pet_ids ?? null);
      // 第一次：限定玩家名单（交集）；第二次：不限定，只为拿**全库**命中数。
      const limited = Array.isArray(fact.pet_ids);
      if (limited) assert.deepEqual(fact.pet_ids, ['pet_000186', 'pet_000012', 'pet_000020'], '参数里必须带名单 id');
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:types.json#龙系'], error_type: null, failure_class: null,
        result: {record: 'catalog', filters: {resist: '龙系'},
          matched_types: ['机械系'], total_matched: limited ? 1 : 38, unknown_pet_ids: [],
          offset: 0, limit: fact.limit ?? 50, returned: limited ? 1 : 0, truncated: !limited,
          pets: limited
            ? [{pet_id: 'pet_000012', name: '铠甲虫', types: ['虫系'], stats: {hp: 60}, role: null}]
            : []}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const answer = await runCoach({message: '我这几只里谁抗龙系？', role: 'auto',
      context: {...buildContext(createGame(445), newProfile(), 'fox'), profile: ctx.profile},
      memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.equal(plan + generate, 0, '这一族不许问模型');
    const text = String(answer.text);
    assert.match(text, /你这 3 只里/, text);
    assert.match(text, /抗龙系的是 1 只/, '命中数要来自回执（限名单那一次）');
    assert.match(text, /铠甲虫（虫系）/, '命中要逐只摆出来');
    // 两个口径必须分开：限名单的命中 1 只 vs 全库 38 只（只有第二次调用知道全库数）
    assert.match(text, /全库抗龙系的一共 38 只/, `全库口径要单独报（第二次调用）：${text}`);
    assert.match(text, /其余不在你的名单里/, '要说明其余不在名单里（不说"全库没有"）');
    assert.doesNotMatch(text, /分页|前 50 只/, '带了 pet_ids 之后不许再留分页歧义的话');
    assert.deepEqual(seen, [['pet_000186', 'pet_000012', 'pet_000020'], null],
      '两次调用：先限名单、再全库（顺序与参数都要钉）');
  } finally { resetRocoTools(); }
});

// ── ㉖ 弃答族（P1-b）：查不到就**本地**说清"查不到"，一个数都不许编 ─────────────────
//
// 计划文档 §4 P1-b：「证据不足时明确说不知道（不许给像结论的句子）」+「构造『库里没有』的问题 ⇒ 必须弃答」。
// 这一族过去只有一个入口是本地 fail-closed（配招可学性），另外两个（按属性找精灵、图鉴介绍）
// 会把"引擎 404"悄悄退给模型 —— 真机实测模型**恰好**也说了"查不到"，但那是模型自觉，不是判据。
test('㉖ 弃答族：未知属性/未知技能/未知精灵都在本地 fail closed（0 次模型调用）', async () => {
  const failBridge = (message) => ({
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {tool: 'query_rules', ok: false, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0,
        coverage: 0, evidence_ids: [], error_type: 'not_found', failure_class: 'request',
        message, result: null};
    },
  });
  const teamCtx = {profile: {
    lineup: [{id: 'pet_000186', name: '小翼龙', types: ['龙系', '翼系']}],
    pets: [{id: 'own-0002', species_id: 'pet_000020', name: '遁鼠', types: ['普通系']}]}};
  const run = async (message, client, profile = null) => {
    configureRocoTools({client, stateVersion: 0});
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    try {
      const context = buildContext(createGame(445), newProfile(), 'fox');
      if (profile) context.profile = profile;
      const answer = await runCoach({message, role: 'auto', context, memory: freshMemory(), provider});
      assert.equal(plan + generate, 0, `「${message}」不许问模型（弃答也由本地负责）`);
      return answer;
    } finally { resetRocoTools(); }
  };
  // ① 未知属性（全库检索）：本地说清 + 一个名字都不列
  const unknownElement = await run('谁抗雷人系？', failBridge('未知属性：雷人系（resist）'));
  assert.equal(unknownElement.agentStop, 'policy-fact-local');
  assert.match(String(unknownElement.text), /未知属性：雷人系/, String(unknownElement.text));
  assert.match(String(unknownElement.text), /一个都不列|认不出来/, '要说清为什么不给名单');
  // ② 未知属性（队内检索）：同样本地
  const unknownTeam = await run('我这几只里谁抗雷人系？', failBridge('未知属性：雷人系（resist）'), teamCtx.profile);
  assert.equal(unknownTeam.agentStop, 'policy-fact-local');
  assert.match(String(unknownTeam.text), /未知属性：雷人系/, String(unknownTeam.text));
  assert.match(String(unknownTeam.text), /不下结论/, '队内也不许给假结论');
  // ③ 未知技能（配招可学性）：三态里的 null，不许写成"不合法"
  const unknownSkill = await run('小翼龙带抓挠、雷人招合法吗？', failBridge('未知精灵名：小翼龙'));
  assert.match(String(unknownSkill.text), /未知精灵名：小翼龙/, String(unknownSkill.text));
  // 反证：同一套桥喂**有效**结果 ⇒ 不许出现任何"查不到"字样（判据不是恒真）
  const okBridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:types.json#龙系'], error_type: null, failure_class: null,
        result: {record: 'catalog', filters: {resist: '龙系'}, matched_types: ['机械系'],
          total_matched: 38, unknown_pet_ids: [], offset: 0, limit: 12, returned: 1, truncated: true,
          pets: [{pet_id: 'pet_000001', name: '机械方方', types: ['机械系'], stats: {hp: 60}, role: null}]}};
    },
  };
  const known = await run('谁抗龙系？', okBridge);
  assert.match(String(known.text), /机械方方/, String(known.text));
  assert.doesNotMatch(String(known.text), /没查成|未知属性|查不到/, `有效结果不许出现弃答话术：${known.text}`);
});

// ── ㉗ 名单级相性汇总：「我这份名单最怕什么属性」（0 次模型调用）──────────────────────
//
// 真机实测（P2 模型在环那一批 / 手游那一档）：「我这 48 只里整体最怕什么属性？」落到
// `policy-no-tool`，玩家拿到「进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。」——
// 等于没答。而这个汇总是**纯读**：名单属性 × 相性表逐属性数一遍（引擎 `weakness_summary`），
// 与 `type_multiplier` 用**同一套**乘法（双属性相乘）。
test('㉗ 名单级相性汇总：引擎逐属性数，本地成句（0 次模型调用）', async () => {
  const ctx = {profile: {
    lineup: [{id: 'pet_000001', name: '喵喵', types: ['草系']}],
    pets: [{id: 'own-0002', species_id: 'pet_000186', name: '小翼龙', types: ['龙系', '翼系']}]}};
  for (const q of ['我这份名单最怕什么属性？', '我这 48 只里整体最怕什么属性？', '我这几只的弱点是什么？']) {
    assert.equal(rosterWeaknessAsk(q, ctx), true, `「${q}」要认成名单级汇总`);
    assert.equal(policyFor(q, ctx).reason, 'roster-weakness-ask', `「${q}」的政策`);
    const args = defaultArgsFor('query_rules', ctx, q);
    assert.deepEqual(args, {kind: 'weakness_summary', pet_ids: ['pet_000001', 'pet_000186']}, `「${q}」的参数`);
    assert.equal(validToolArgs('query_rules', {...args, state_version: 0}), true);
  }
  // 反证：普通相性问句 / 单只问句不许被这一族抢走
  for (const q of ['火系克制什么属性？', '谁抗龙系？', '喵喵是谁？']) {
    assert.equal(rosterWeaknessAsk(q, ctx), false, `「${q}」不该归名单级汇总`);
    assert.notEqual(policyFor(q, ctx).reason, 'roster-weakness-ask');
  }
  // 名单里换不出物种 id ⇒ 不接（context 要求：species id）
  assert.equal(rosterWeaknessAsk('我这份名单最怕什么属性？', {profile: {pets: [{id: 'own-9', name: '某只'}]}}), false);

  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      assert.equal(fact.kind, 'weakness_summary');
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:types.json#weakness_summary'], error_type: null, failure_class: null,
        result: {record: 'weakness_summary', pet_ids: fact.pet_ids, counted: 2,
          unknown_pet_ids: [], unknown_combination_pet_ids: ['pet_000199'],
          by_element: [{element: '火系', count: 2, pet_ids: ['pet_000001', 'pet_000186']},
            {element: '冰系', count: 1, pet_ids: ['pet_000186']}],
          top: [{element: '火系', count: 2, pet_ids: ['pet_000001', 'pet_000186']},
            {element: '冰系', count: 1, pet_ids: ['pet_000186']}],
          list_cap_per_element: 12,
          multiplier_rule: '怕 = 该属性打这只的倍率 > 1.0；双属性按两系相乘（台账 EV-TYPE-MULTIPLIER）',
          note: '这是名单级的相性计数，不是胜率、不是强度排序'}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    let plan = 0; let generate = 0;
    const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
      async generate(p) { generate += 1; return String(p?.text ?? ''); }};
    const answer = await runCoach({message: '我这份名单最怕什么属性？', role: 'auto',
      context: {...buildContext(createGame(445), newProfile(), 'fox'), profile: ctx.profile},
      memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.equal(plan + generate, 0, '这一族不许问模型');
    const text = String(answer.text);
    assert.match(text, /能算的 2 只/, text);
    assert.match(text, /火系（2 只）/, 'top 要按计数摆出来');
    assert.match(text, /喵喵（pet_000001）/, '第一栏的宠物要按名字摆出来');
    assert.match(text, /EV-TYPE-MULTIPLIER|相乘/, '要写出乘法的口径来源');
    assert.match(text, /pet_000199/, '缺相性行的双属性要如实列出来');
    assert.match(text, /不是胜率/, '要说明这不是胜率');
  } finally { resetRocoTools(); }
});

// ── ㉘ 事实 + 取舍：事实由引擎查全，**取舍那半句交给模型**（没接模型时一个字不变）────────
//
// P2 模型在环实测：纯事实问句走本地单发是对的，但**带取舍**的问句被同一条路短路了 ——
// 「队里那三只机械系选哪只更合适？」只回了名单、没有任何比较。现在两条分支：
//   · 纯事实（问"有多少/是谁/加多少"）⇒ `policy-fact-local`，0 次模型调用；
//   · 事实 + 取舍（"更合适/为什么/怎么选"）⇒ `policy-fact-then-model`，模型在**引擎回执上**作答。
test('㉘ 事实 + 取舍：模型只被"判断类"叫来，纯事实仍然 0 次调用', async () => {
  assert.equal(judgementAsk('队里那三只机械系选哪只更合适？'), true);
  assert.equal(judgementAsk('谁抗龙系？'), false, '纯事实不许被算成判断类');
  assert.equal(judgementAsk('雨天水系伤害加多少？'), false);
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:types.json#龙系'], error_type: null, failure_class: null,
        result: {record: 'catalog', filters: {resist: '龙系'}, matched_types: ['机械系'],
          total_matched: 3, unknown_pet_ids: [], offset: 0, limit: 12, returned: 2, truncated: false,
          pets: [{pet_id: 'pet_000012', name: '铠甲虫', types: ['虫系'], stats: {hp: 132}, role: null},
            {pet_id: 'pet_000328', name: '声波缇塔', types: ['机械系'], stats: {hp: 120}, role: null}]}};
    },
  };
  const run = async (message, providerName) => {
    configureRocoTools({client: bridge, stateVersion: 0});
    let calls = 0;
    const provider = providerName === 'local' ? localProvider
      : {name: 'stub-model', async generate() { calls += 1; return '按回执：铠甲虫 132 生命更能扛，声波缇塔 120。'; }};
    try {
      const answer = await runCoach({message, role: 'auto',
        context: {...buildContext(createGame(445), newProfile(), 'fox'),
          profile: {pets: [{id: 'own-1', species_id: 'pet_000012', name: '铠甲虫'}]}},
        memory: freshMemory(), provider});
      return {answer, calls};
    } finally { resetRocoTools(); }
  };
  // ① 判断类 + 真模型 ⇒ 模型被叫来，且它引用的数字来自回执（守卫放行）
  // 消息必须**既**命中事实路由（队内属性检索）**又**带取舍词 —— 只有这样才走"事实 + 模型"那一支。
  const JUDGED_Q = '我这几只里谁抗龙系？这三个里哪个更合适？';
  assert.equal(judgementAsk(JUDGED_Q), true, '前提：这句带取舍词');
  const judged = await run(JUDGED_Q, 'stub-model');
  // 模型**至少**被叫一次（答案层还留着一张一次纠错券：第一遍没过核对时会再问一遍 —— 2 次也是对的）
  assert.ok(judged.calls >= 1, `判断类必须让模型答（实际 ${judged.calls} 次）`);
  assert.equal(judged.answer.agentStop, 'policy-fact-then-model', `停止原因：${judged.answer.agentStop}`);
  assert.match(String(judged.answer.text), /铠甲虫/, '正文里要有引擎查到的名字（模型写的或回退后的本地正文）');
  // 守卫的两种合法结局：① 模型正文过检 ⇒ 交付它；② 没过检 ⇒ 交付**本地已核验正文**。
  // 不允许出现第三种（没过检还把模型正文发出去）—— 这就是服务端守卫要保的那条线。
  const validation = judged.answer.validation ?? {};
  const legitimate = validation.valid === true
    || (validation.rejected === true && validation.deliveredText === 'local-template');
  assert.ok(legitimate, `守卫回执必须是上述两种之一：${JSON.stringify(validation).slice(0, 160)}`);
  // ② 纯事实 + 真模型 ⇒ 仍然 0 次模型调用（本地单发）
  const fact = await run('谁抗龙系？', 'stub-model');
  assert.equal(fact.calls, 0, '纯事实不许问模型（人类 A1）');
  assert.equal(fact.answer.agentStop, 'policy-fact-local');
  // ③ 判断类 + **没接模型** ⇒ 退回本地事实正文，0 次调用
  const noModel = await run(JUDGED_Q, 'local');
  assert.equal(noModel.answer.agentStop, 'policy-fact-local', '没接模型时这一支一个字都不变');
  assert.match(String(noModel.answer.text), /抗龙系|铠甲虫/, String(noModel.answer.text));
});

// ── ㉙ 组队/搭配建议：接战术卡检索（原来 0 次工具、模型凭空答）──────────────────────
//
// 真机实测（`scripts/roco/eval-mobile-coach.mjs` 20 条预注册）：「雨天队该怎么搭？」
// 「我要打龙系道馆，这 48 只里该带哪几只？」两条都是 0 次工具（`policy-route-without-tools`）——
// 模型直接凭自己的知识答。这一族有可查的东西：本仓的战术卡（组队职责/打点覆盖…，卡里带出处）。
test('㉙ 组队建议接战术卡：路由 + 本地有据可依 + 有模型时交给模型', async () => {
  const ctx = {mode: 'camp', profile: {pets: [{id: 'own-1', species_id: 'pet_000012', name: '铠甲虫'}], lineup: []}};
  for (const q of ['雨天队该怎么搭？', '我要打龙系道馆，这 48 只里该带哪几只？', '帮我配一队', '阵容怎么配比较好？']) {
    assert.equal(teamBuildAsk(q, ctx), true, `「${q}」要认成组队建议`);
    assert.equal(policyFor(q, ctx).reason, 'team-build-ask', `「${q}」的政策`);
    assert.equal(policyFor(q, ctx).need, 'search_rules', '必须接检索，不许 0 次工具');
  }
  // 反证：评估现队 / 对局内行动 / 相性问句都不许被这一族抢走
  for (const q of ['我这套阵容有什么短板？', '这些精灵搭不搭？', '火系克制什么属性？']) {
    assert.equal(teamBuildAsk(q, ctx), false, `「${q}」不该归组队建议`);
    assert.notEqual(policyFor(q, ctx).reason, 'team-build-ask');
  }
  assert.equal(teamBuildAsk('这回合该带谁？', {mode: 'pvp-live', battle: {}}), false, '对局内的行动问题归战斗工具');
  // ① 没有模型：本地把战术卡的原则逐条摆出来（有出处、不给"带哪几只"的结论）
  const local = await runCoach({message: '雨天队该怎么搭？', role: 'auto', context: ctx,
    memory: freshMemory(), provider: localProvider});
  assert.equal(local.agentStop, 'policy-fact-local');
  const localText = String(local.text);
  assert.match(localText, /战术卡/, `要引用战术卡：${localText}`);
  assert.match(localText, /组队职责|打点覆盖|阵容/, '要摆出卡里的原则');
  assert.match(localText, /不是胜率/, '要说明这是结构建议');
  assert.doesNotMatch(localText, /\d+%/, '不许出现百分比');
  // ② 有模型：这一族算"带取舍"⇒ 查完卡再让模型答（引擎/卡在前、判断在后）
  let calls = 0;
  const provider = {name: 'stub-model', async generate() { calls += 1; return '按战术卡，先定职责再挑人。'; }};
  const judged = await runCoach({message: '雨天队该怎么搭？', role: 'auto', context: ctx,
    memory: freshMemory(), provider});
  assert.ok(calls >= 1, '带取舍的组队问句要让模型答一次');
  assert.equal(judged.agentStop, 'policy-fact-then-model', `停止原因：${judged.agentStop}`);
  // ③ 只引**战术卡**，且**不许**替玩家定"带哪几只"（取舍留给模型/玩家）
  // 2026-09-27（审计 ②，**改钉不删**）：原来要求正文里出现卡 id（`tactic:*`）便于追溯。
  // 卡 id 是机器标识（规范第 3 条：主文案不出现机器标识），这一轮从正文挪到 `evidence`。
  // 判据的意思没变：**要能追溯到是哪几张卡**；现在查的是依据区里的卡 id + 正文里那句人话。
  assert.match((local.evidence ?? []).join('\n'), /命中 \d+ 张卡/,
    `依据区要写清命中了几张卡：${JSON.stringify(local.evidence)}`);
  assert.match(localText, /来源：战术卡，卡里带出处/, `正文要说出处是战术卡：${localText}`);
  assert.doesNotMatch(localText, /tactic:/, `正文里不许出现卡 id（机器标识）：${localText}`);
  assert.doesNotMatch(localText, /建议带|应该带|必带|就带这/, `本地兜底不许给配队结论：${localText}`);
  // ④ 检索两边的回执形状都要认：本地卡片工具是**裸对象**（`{cards:…}`）、引擎工具是 `{ok,result}`
  //    —— 只认后者会让这一族永远"检索没命中"（真机踩到，见本文件注释）。
  const bare = await runCoach({message: '雨天队该怎么搭？', role: 'auto', context: ctx,
    memory: freshMemory(), provider: localProvider});
  assert.match(String(bare.text), /战术卡/, '裸回执也要能读出卡片');
});

// ── ⑯ 队形问句但拿不到队伍：本地说清缺什么，不许回「我在。」─────────────────────────
//
// 真机实测（8765 未接模型、上下文按**页面真形状**）：`matchContext()` 只在选满三只时才挂
// `profile.lineup`；没选够时「我这套阵容有什么短板？」落到陪练通道 →「我在。」
// 现在：判成 `team-ask-incomplete`，本地回答"我拿到几只、缺什么、两条怎么补"，
// 一个结论都不编（队伍没定下来之前的"短板"只能是编的）。
test('⑯ 队形问句但队伍不全：本地回答要给出可执行的下一步，0 次模型调用', async () => {
  // 只有名单（pets 是数组）没有 lineup 的上下文 —— 页面在"没选够三只"时就是这个形状
  const context = {...buildContext(createGame(445), newProfile(), 'fox'), profile: {pets: POOL}};
  assert.equal(policyFor('我这套阵容有什么短板？', context).reason, 'team-ask-incomplete',
    '队形问句 + 拿不到队伍 ⇒ 这一族要接住');
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  const answer = await runCoach({message: '我这套阵容有什么短板？', role: 'auto', context,
    memory: freshMemory(), provider});
  assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
  assert.equal(plan + generate, 0, '不许问模型');
  const text = String(answer.text);
  assert.match(text, /还没拿到你的出场阵容|现在只有/, `要说清"没拿到阵容"这件事：${text}`);
  assert.match(text, /点满/, '要给出"去营地选满"这条可执行路径');
  assert.match(text, /直接说队里是哪几只/, '要给出"直接报队伍"这条路径');
  assert.doesNotMatch(text, /短板是|弱点是|怕/, `队伍没定之前不许给任何结论：${text}`);
  // 反证：队伍齐了就必须走引擎（回到 team-ask），不许被这一族截住
  const full = {...buildContext(createGame(445), newProfile(), 'fox'),
    profile: {lineup: THREE.map((p, i) => ({...p, types: [['火系', '水系', '草系'][i]]})), pets: POOL}};
  assert.equal(policyFor('我这套阵容有什么短板？', full).reason, 'team-ask',
    '队形齐了要回到引擎那条路');
  // 而且不许抢走别的队形邻近问句：换人对比、属性问句照旧
  assert.equal(policyFor('第三只换掉行不行', CAMP3).reason !== 'team-ask-incomplete', true);
});

// ── ⑮ 训练点/培养格：真机那两句必须有确定答案（数字来自存档 + 常量）──────────────────
//
// 真机实测（8765 未接模型）： 「我还差多少训练点满级？」→「嗯，还差多少训练点满级。」、
// 「我这点训练点该怎么加？」→「我在。」。这一条钉住修好之后的行为：
//   · 本地作答（0 次规划器 + 0 次正文生成）；
//   · 每一个数都对得上**存档 + `progression.js` 常量**（不是模板里写死的字面量）；
//   · 没有存档时不许接（拿不到数就不答）。
test('⑮ 加点问句本地作答：直说"这一版没有加点"，0 次模型调用、一个数都不报', async () => {
  // 2026-09-27 **改钉**（人类：「加点不要了，按照洛手的机制来，根本没有这些」）：
  // 这一条原来钉「训练点余额 / 培养格 x/y / 满级差多少格 / 每点收益」。加点退役之后，
  // 同一族问句仍然**本地作答、0 次模型调用**，但答的是否定句 + 指路（改性格/改天分 → 我的盒子）。
  const save = {...newProfile(), tokens: 2,
    pets: {...newProfile().pets, fox: {level: 2, xp: 10, points: {hp: 1, atk: 2, speed: 0}}}};
  const context = {...buildContext(createGame(445), newProfile(), 'fox'), focus: 'fox',
    profile: {...save, lineup: []}};
  for (const q of ['我还差多少训练点满级？', '我这点训练点该怎么加？', '还有几个培养格？']) {
    assert.equal(policyFor(q, context).reason, 'training-ask', `「${q}」仍然判给这一族（本地作答）`);
  }
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  for (const q of ['我还差多少训练点满级？', '我这点训练点该怎么加？']) {
    const answer = await runCoach({message: q, role: 'auto', context, memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
    const text = String(answer.text);
    assert.match(text, /没有加点/, `要直说没有加点：${text}`);
    assert.match(text, /性格|天分/, `要说清培养是什么：${text}`);
    assert.match(text, /我的盒子/, `要说清在哪做：${text}`);
    // 一个旧口径的数都不许出现（余额 / 格数 / 每点收益 / 满级差）
    assert.doesNotMatch(text, /训练点 ?\d|培养格|每 1 点|满级还差|还差 \d+ ?格/, `不许报旧口径的数：${text}`);
  }
  assert.equal(plan + generate, 0, '这一族不许问模型');
  // 等级/经验是**原版就有的**，所以顺手报出来是可以的（存档里有就报）
  const withLevel = await runCoach({message: '我还差多少训练点满级？', role: 'auto', context,
    memory: freshMemory(), provider});
  assert.match(String(withLevel.text), /Lv\.2|等级/, `等级照旧可以报：${withLevel.text}`);
  // 反证：换成没有存档的名单形状 ⇒ 仍然本地答（`training-ask-elsewhere`），不会落到模型
  assert.equal(policyFor('我还差多少训练点满级？', CAMP).reason, 'training-ask-elsewhere');
});

// ── ⑬c 别的模式绑的配置没声明天气层：也要换标准 PVP 再答（否则文案会说谎）──────────
//
// 极速对决 / 领地试炼绑的是 v2，而 v2 也没声明天气层。修前那条路只在**没带 mode_id** 时才换模式
// ⇒ 按模式问的那一支会走到"没声明"的分支，文案还写着「登记表里声明了天气层的那份配置也取不到」
// —— 而它**根本没去取**（实测口径：说"取不到"必须真的取过）。
test('⑬c 非标准模式绑的配置没声明天气层时，也要换标准 PVP 再答一次', async () => {
  const calls = [];
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      calls.push(fact.mode_id ?? fact.ruleset_config_id ?? null);
      if (fact.mode_id !== STANDARD_PVP_MODE_ID) {
        return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
          evidence_ids: ['ev:rulesets#v2'], error_type: null, failure_class: null,
          result: {record: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v2',
            mode_id: fact.mode_id ?? null, enabled: false, note: '这份配置没有声明天气层'}};
      }
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:rulesets#weather'], error_type: null, failure_class: null,
        result: {record: 'policy', name: 'weather', ruleset_config_id: 'mobile_s4_candidate_v3',
          mode_id: fact.mode_id, enabled: true, confidence: 'OFFICIAL_CURRENT', evidence_id: 'EV-WEATHER-STANDARD-PVP',
          duration_turns: 8, effects: {雨天: {kind: 'skill_power_multiplier', element: '水系', value: 1.75,
            text: '天气为雨天时，双方的水系技能威力+75%。'}}}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    const context = buildContext(createGame(445), newProfile(), 'fox');
    context.roco_battle = {turn: 3, mode: 'pvp-speed-duel-3v3'};   // 登记表里绑 v2 的那个模式
    const answer = await runCoach({message: '雨天水系伤害加多少？', role: 'auto', context,
      memory: freshMemory(), provider: localProvider});
    assert.deepEqual(calls, ['pvp-speed-duel-3v3', STANDARD_PVP_MODE_ID], '要按模式问两次：先这个模式，再标准 PVP');
    assert.match(String(answer.text), /\+75%/, `换模式后要给数值：${answer.text}`);
    assert.match(String(answer.text), /pvp-speed-duel-3v3/, '要说清是哪个模式的配置没声明');
    assert.match(String(answer.text), /没有声明天气层/, '要如实说明原因');
    assert.doesNotMatch(String(answer.text), /取不到/, '去取过了就不许说"取不到"');
  } finally {
    resetRocoTools();
  }
});

// ── ⑭ 营地「我这套阵容」：没有模型也要给出引擎算的结构结论（修前是「我在。」）──────────
//
// 真机实测（营地页、未接模型）：「我这套阵容有什么短板？」落到陪练通道 →「我在。」。
// 两层原因：① 营地上下文没带 `profile.lineup`（已在 `app.js` 的 `matchContext()` 补上，
// 判据在 `tests/wiring.test.js`）；② 这一层没有把回执翻成人话的路径。
// 这一条钉 ②：手游六只走 `evaluate_team` 回执成句，本仓 MVP 三只走 `rosterAdvice`（相性表）。
test('⑭ 阵容问句本地成句：手游六只走 evaluate_team、营地三只走相性表，都不问模型', async () => {
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  // ① 营地三只（本仓 MVP 引擎的物种 id）：手游引擎查不到它们 ⇒ 走 rosterAdvice
  const camp = buildContext(createGame(445), newProfile(), 'fox');
  camp.profile = {...camp.profile, lineup: [
    {id: 'fox', name: '烬尾狐', types: ['fire']},
    {id: 'turtle', name: '潮甲龟', types: ['water']},
    {id: 'deer', name: '芽角鹿', types: ['leaf']}]};
  const campAnswer = await runCoach({message: '我这套阵容有什么短板？', role: 'auto',
    context: camp, memory: freshMemory(), provider});
  assert.equal(campAnswer.agentStop, 'policy-fact-local');
  assert.match(String(campAnswer.text), /速度线|共同弱点/, `要给出结构结论：${campAnswer.text}`);
  assert.match(String(campAnswer.text), /不是胜率/, '必须写明这不是胜率');
  assert.ok(!/我在。/.test(String(campAnswer.text)), '不许再是那句「我在。」');

  // ② 手游六只（pet_xxxxxx）：走 evaluate_team 回执成句（假桥喂引擎真形状）
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async evaluateTeam(team) {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:pack'], error_type: null, failure_class: null,
        result: {team, features: [{name: 'types', value: 0.45, detail: {
          offence_elements: ['幽系', '水系'], offence_count: 2,
          weak_to: ['光系', '冰系', '电系'], weak_count: 3,
          per_pet_weak: {pet_000225: ['光系', '冰系'], pet_000190: ['电系'], pet_000445: []}}}],
          strengths: ['幽系与龙系的打击面互相补'], weaknesses: ['两只都怕冰系'],
          coverage: {known: 3, unknown: 0}, calibration: {}, note: '结构特征，不是胜率'}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    // 用 `pvp-local`/camp 这一族：`pvp-live`（线上竞技）按纪律**不提供**战术建议，
    // 那是政策不是缺口（`isLiveMatch`）。
    const live = {mode: 'pvp-local', profile: {lineup: [{id: 'pet_000225', name: '寂灭骨龙'},
      {id: 'pet_000190', name: '海豹船长'}, {id: 'pet_000445', name: '黑猫巫师'}]}};
    const answer = await runCoach({message: '我这套阵容有什么短板？', role: 'auto',
      context: live, memory: freshMemory(), provider});
    assert.equal(answer.agentStop, 'policy-fact-local');
    assert.match(String(answer.text), /光系/, `要带引擎给的弱点：${answer.text}`);
    assert.match(String(answer.text), /不是胜率/);
  } finally {
    resetRocoTools();
  }
  assert.equal(plan + generate, 0, '阵容问句的本地成句同样不许问模型');
});

// ── ㉚ 「谁最适合当首发？」：手里的名单要真的用上，且速度线逐值有出处 ───────────────
//
// 真机实测（2026-09-25，`scripts/roco/probe-team-ask.mjs` 对着 8765）：**六只都带 id 与六维**的
// lineup 问「谁最适合当首发？」，答的是「整队结论要按「3 或 6 只」算，**你这套现在只有 6 只，
// 不够一个队**」—— 6 只本来就是合法规模，这句话自相矛盾；引擎（`evaluate_team`）一次都没被问过。
// 根因：`teamAsk()` 在"没点名任何一只"时只认 `OWN_TEAM_ASK`（「我这队」那类字面），
// 「首发」这种问法直接返回 null ⇒ 落到 `team-ask-incomplete`。
// 这一条钉住修好之后的行为：走引擎、给**标明口径**的速度线（逐值来自 `lineup[].stats.spe`，
// 也就是页面从引擎 roster 回执带过来的六维）、玩家层**零内部 id**、0 次模型调用。
test('㉚ 「谁最适合当首发？」用手里的名单走引擎：速度线逐值有出处、零内部 id、0 次模型调用', async () => {
  const names = ['朔夜伊芙', '丢丢', '音速犬', '仪式巨像', '雪影娃娃', '化蝶'];
  const ids = ['pet_000130', 'pet_000240', 'pet_000118', 'pet_000137', 'pet_000143', 'pet_000152'];
  const speeds = [120, 99, 132, 60, 88, 101];
  const lineup = ids.map((id, i) => ({id, name: names[i], types: ['恶系'],
    stats: {hp: 300, atk: 120, def: 110, spa: 110, spd: 110, spe: speeds[i]}}));
  const context = {mode: 'camp', profile: {lineup, pets: lineup.map((r) => ({id: r.id, name: r.name}))}};
  assert.equal(policyFor('谁最适合当首发？', context).reason, 'team-ask',
    '六只齐全 + 首发问句要回到引擎那条路（不是 team-ask-incomplete）');
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async evaluateTeam(team) {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:pack'], error_type: null, failure_class: null,
        result: {team, features: [{name: 'types', value: 0.45, detail: {
          offence_elements: ['幽系', '水系'], offence_count: 2,
          weak_to: ['光系', '冰系', '电系'], weak_count: 3,
          per_pet_weak: {pet_000130: ['光系'], pet_000118: ['冰系', '电系']}}}],
          strengths: ['打击面互相补'], weaknesses: ['两只都怕冰系'],
          coverage: {known: 3, unknown: 0}, calibration: {}, note: '结构特征，不是胜率'}};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  try {
    const answer = await runCoach({message: '谁最适合当首发？', role: 'auto', context,
      memory: freshMemory(), provider});
    const text = String(answer.text);
    assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
    assert.equal(plan + generate, 0, '这一族数字全在手里，不许问模型');
    assert.match(text, /只用|只看先手/, `要说清"首发"看的是先手这个口径：${text}`);
    assert.match(text, /音速犬（速度 132）/, `速度最快的那只要点名并写出数值：${text}`);
    assert.match(text, /音速犬 132 > 朔夜伊芙 120/, `六只的速度要按引擎给的值排序：${text}`);
    assert.match(text, /不是胜率/, '必须写明这不是胜率');
    assert.match(text, /不替你定首发/, '不许替玩家拍板首发');
    assert.doesNotMatch(text, /pet_\d{6}|own-\d{4}/, `玩家层不许出现内部 id：${text}`);
    assert.doesNotMatch(text, /够一个队/, `六只本来就是合法规模，不许说"不够一个队"：${text}`);
    assert.doesNotMatch(text, /打击面互相补两只都怕冰系/, '引擎的短结论之间要有断句');
    // 反证 ①：名单没带六维（页面在拿不到 roster 回执时就是这个形状）⇒ 速度线整句不出现，不许编数字
    const noStats = {mode: 'camp', profile: {lineup: ids.map((id, i) => ({id, name: names[i]})), pets: []}};
    const bare = await runCoach({message: '谁最适合当首发？', role: 'auto', context: noStats,
      memory: freshMemory(), provider});
    const bareText = String(bare.text);
    assert.doesNotMatch(bareText, /只看先手|速度依次/, `没有六维就不许给速度线：${bareText}`);
    assert.doesNotMatch(bareText, /\d{3}/, `没有六维就不许出现任何速度数字：${bareText}`);
  } finally {
    resetRocoTools();
  }
  // 反证 ②：`per_pet_weak` 里出现**名单外**的 id（认不出名字）时，也必须被擦掉，不许漏给玩家
  const stranger = await (async () => {
    configureRocoTools({client: {baseUrl: 'http://127.0.0.1:9', rulesetId: 'x',
      async evaluateTeam(team) {
        return {ok: true, result: {team, features: [{name: 'types', value: 0.4, detail: {
          offence_elements: ['幽系'], offence_count: 1, weak_to: ['冰系'], weak_count: 1,
          per_pet_weak: {pet_999999: ['冰系']}}}], strengths: ['pet_999999 的打击面最宽'], weaknesses: []}};
      }}, stateVersion: 0});
    try {
      const answer = await runCoach({message: '我这套阵容有什么短板？', role: 'auto', context,
        memory: freshMemory(), provider});
      return String(answer.text);
    } finally { resetRocoTools(); }
  })();
  assert.doesNotMatch(stranger, /pet_\d{6}|own-\d{4}/, `名单外的 id 也要擦掉：${stranger}`);
  assert.match(stranger, /某一员/, `认不出名字时用"某一员"，不印 id：${stranger}`);
});

// ── ㉛ 名单规模与问句对不上时：三档文案各就各位，都不许说"6 只不够一个队" ───────────
test('㉛ 队形问句与名单规模对不上：分档说清（没名单 / 规模不是 3-6 / 问的只数不一致）', async () => {
  const THREE = ['pet_000118', 'pet_000130', 'pet_000240'].map((id, i) => ({
    id, name: ['音速犬', '朔夜伊芙', '丢丢'][i], types: ['火系']}));
  const SIX = [...THREE, {id: 'pet_000137', name: '仪式巨像', types: ['地系']},
    {id: 'pet_000143', name: '雪影娃娃', types: ['冰系']}, {id: 'pet_000152', name: '化蝶', types: ['虫系']}];
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  const ask = (message, lineup) => runCoach({message, role: 'auto',
    context: {mode: 'camp', profile: {lineup, pets: []}}, memory: freshMemory(), provider});
  // ① 没名单（页面"没选够"时的形状）
  const none = String((await ask('我这套阵容有什么短板？', [])).text);
  assert.match(none, /还没拿到你的出场阵容/, `要说清没拿到阵容：${none}`);
  assert.match(none, /点满/, '要给出"去营地选满"这条路');
  // ② 规模不是 3/6（4 只）：说清引擎只收 3 或 6，而不是含糊地说"不够"
  const four = String((await ask('谁最适合当首发？', SIX.slice(0, 4))).text);
  assert.match(four, /只按登记表声明的规模收（3 或 6 只）/, `要说清引擎的规模口径：${four}`);
  // ③ 名单是 6 只、可问句点的是三只：如实说"对不上"，不替他挑
  const mixed = String((await ask('这三只搭不搭？', SIX)).text);
  assert.match(mixed, /对不上，我不替你挑/, `要说清对不上：${mixed}`);
  assert.match(mixed, /点名那 3 只/, '要给出"点名那几只"这条路');
  // 三条都不许出现那句自相矛盾的话（这是这一轮修掉的真缺陷）
  for (const [label, text] of [['没名单', none], ['4 只', four], ['对不上', mixed]]) {
    assert.doesNotMatch(text, /只有\s*6\s*只，不够一个队/, `${label}：不许说"6 只不够一个队"`);
    assert.doesNotMatch(text, /pet_\d{6}|own-\d{4}/, `${label}：玩家层不许出现内部 id`);
  }
  assert.equal(plan + generate, 0, '这一族全部本地作答');
  // 反证：名单合法（3 只）时同一句话必须走引擎那条路，不许被"对不上"那档截住
  assert.equal(policyFor('这三只搭不搭？', {mode: 'camp', profile: {lineup: THREE, pets: []}}).reason,
    'team-ask', '名单就是三只时，问句的"三只"与它一致 ⇒ 必须回引擎那条路');
});

// ── ㉜ 对局内的**局面事实**：确定性读一次（金标 c02/c07/c08/c12/c25/c29 的原话）────────
//
// 54 例金标里这一族 6 条，实测**全部**"该读没读 / 读错"（`reports/live-model-eval.json` 的
// `metrics.layered.toolSelectionCorrect.failures`）：c02 第一手是空的、c07/c12/c29 一次都没调、
// c08 调成图鉴的 `query_rules`（「现在双方的**速度**…」被"<名字>的<字段>"那条先吃了）、
// c25 调成 `simulate_branch`。这一条钉住修好之后的路由，并钉住**四类不许被抢走**的问句。
test('㉜ 对局内的局面事实问句走确定性读口（6 句金标原话）+ 四类不许被抢走', async () => {
  // 上下文用**真局面**（`createGame` + `buildContext`）：`read_state` 与 `strategist` 都要真
  // 引擎状态（合成一个 `{turn:3}` 会在 `legalActions` 里炸 —— 判据不该靠假对象过关）。
  const base = buildContext(createGame(445), newProfile(), 'fox');
  const BATTLE_CTX = {...base, profile: {...base.profile, lineup: SIX}};
  // 表格 = 金标原话 → 期望的第一手工具（全部落在金标 `expect.tools` 里）
  const TABLE = [
    ['对方还剩多少药？我要不要换宠？', 'read_state'],
    ['我想看一下目前所有合法行动，然后再决定要不要换宠。', 'read_state'],
    ['现在双方的速度和先手关系是什么样？', 'read_state'],
    ['帮我算一下这回合不同出招的结果，然后再决定用技能。', 'compare_actions'],
    ['结合我现在的血量判断这回合该防御还是换宠，另外说明换宠的完整代价。', 'search_rules'],
    ['查一下连续换宠的规则，再看下对手最近的换宠记录。', 'read_match'],
  ];
  for (const [q, need] of TABLE) {
    const policy = policyFor(q, BATTLE_CTX);
    assert.equal(policy.need, need, `「${q}」第一手应当是 ${need}（拿到 ${policy.need}/${policy.reason}）`);
  }
  // 反证①：**没有对局**的上下文（营地页）不许拿到对局内那几支路由
  const camp = {mode: 'camp', profile: {lineup: SIX}};
  for (const [q] of TABLE) {
    const need = policyFor(q, camp).need;
    assert.ok(!['read_state', 'compare_actions', 'read_match'].includes(need),
      `营地页不该走对局内的读口：「${q}」拿到 ${need}`);
  }
  // 反证②：手游对局（`roco_battle`）不受这一块影响 —— 判据 ⑤ 钉的两句照旧
  const mobileBattle = {mode: 'pve', profile: {lineup: SIX}, roco_battle: {turn: 3}};
  assert.equal(policyFor('现在该防御还是出招？', mobileBattle).need, 'simulate_branch',
    '手游对局的行动比较照旧走 simulate_branch');
  assert.equal(policyFor('这回合该不该换宠？', mobileBattle).need, null,
    '手游对局的"该不该换宠"照旧走包内');
  // 反证③：图鉴问句不许被抢走（c08 的「现在双方的速度」与「某只的速度」是两种问法）
  for (const q of ['寂灭骨龙的速度是多少？', '喵喵的种族值是多少？']) {
    assert.equal(policyFor(q, BATTLE_CTX).need, 'query_rules', `图鉴问句照旧查引擎：${q}`);
  }
  // 反证④：**推断题**照旧走包内（不许"看到血量就查"）——判据 ⑤ 的口径原样保留。
  // 「我现在场上这只还剩多少血？」是其中最要紧的一条：问的是**自己这一侧**，证据包里本来就有
  // （`coach.test.js` 钉着 `need===null`，金标 c01 也允许 0 次调用）—— 政策刻意不收这一句。
  for (const q of ['对面这招能打掉我多少血？', '我先手还是后手？', '我该换谁？',
    '我现在场上这只还剩多少血？能量够放技能吗？']) {
    const policy = policyFor(q, BATTLE_CTX);
    assert.equal(policy.need, null, `推断题仍走包内：「${q}」拿到 ${policy.need}`);
  }
  // 端到端：政策指定的第一手**真的被执行**（`chosenBy:'policy'`），不是只写在路由里
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  const answer = await runCoach({message: '我想看一下目前所有合法行动，然后再决定要不要换宠。',
    role: 'auto', context: BATTLE_CTX, memory: freshMemory(), provider});
  const first = (answer.toolTrace ?? [])[0] ?? null;
  assert.equal(first?.tool, 'read_state', `第一手要真的读局面：${JSON.stringify(first)?.slice(0, 120)}`);
  assert.equal(first?.chosenBy, 'policy', '这一手由政策决定，不咨询规划器');
  assert.ok(first?.result && typeof first.result === 'object', '要有回执（合法行动/双方局面）');
});

// ── ㉝ 本地事实答案在**没有模板草稿**的上下文里也必须能成句（`packet` 可能是 undefined）──────
//
// 2026-09-25 实测（金标 54 例整轮跑）：19 条本地事实用例整片 500 ——
// `TypeError: Cannot read properties of undefined (reading 'knowledge')`（`runtime.js` 的纯事实收口那一行）。
// 根因：`{...undefined}` 在 JS 里合法，于是"把卡并进包"改成 `packet.knowledge` 之后，
// **没有模板起草过的问句**（纯参数化事实）会在这里抛。判据 ⑫ 没抓到，是因为那些用例的上下文里
// 恰好有规则卡命中、`packet` 不是 undefined —— 这一条专门钉住"没有草稿"的那条路径。
test('㉝ 本地事实答案在无模板草稿的上下文里也能成句（`packet===undefined` 那条路径）', async () => {
  const bare = {mode: 'camp', profile: {pets: [], lineup: []}};
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  // ① 纯常量事实（不引卡）
  const a = await runCoach({message: '能量上限是几个豆？', role: 'auto', context: bare,
    memory: freshMemory(), provider});
  assert.equal(a.agentStop, 'policy-fact-local', '纯常量事实仍走本地');
  // 改钉（2026-09-26，人类 ②）：`bare` 是**手游形状**（`profile.pets` 是数组 ⇒ 没有营地存档），
  // 而这条原来断言的是「必须念出营地那一档的 6 豆」—— 那正是被点名的错（手游常规上限是 10，
  // 台账 EV-ENERGY-MAX 明写「引擎的 ENERGY_MAX = 6 不得表述为游戏事实」）。
  // 判据的意图没变（本地成句、不说空话），只是把**值**钉到正确的那一档上。
  assert.match(String(a.text), /上限是 \*\*10\*\*/, `手游那一档要念 10：${a.text}`);
  assert.doesNotMatch(String(a.text), new RegExp(`${RULES.energy.max} 豆才是满豆`),
    '不许把手游口径说成营地那一档的 6 豆满');
  // 反证：营地那一档（有存档）仍然念 6 —— 分档不是"把常量删掉"
  const campShape = {mode: 'camp', profile: {growth: {pets: {fox: {points: {hp: 1}}}, tokens: 3}}};
  const campAnswer = await runCoach({message: '能量上限是几个豆？', role: 'auto', context: campShape,
    memory: freshMemory(), provider});
  assert.match(String(campAnswer.text), new RegExp(`${RULES.energy.max} 豆才是满豆`),
    '营地那一档照旧念自己的常量');
  // ② 引了知识卡的事实：卡本体必须**一起发出去**（正文写了出处，就得给得出那张卡）
  const b = await runCoach({message: '中毒算属性异常吗？每回合掉多少血？', role: 'auto', context: bare,
    memory: freshMemory(), provider});
  assert.equal(b.agentStop, 'policy-fact-local');
  assert.deepEqual((b.knowledge ?? []).map((c) => c.id), ['tactic:poison'],
    `正文引了 tactic:poison，卡片本体就必须在 knowledge 里：${JSON.stringify(b.knowledge)}`);
  // 改钉（2026-09-26）：玩家正文不再写知识卡 id（人类：「说人话」——玩家不该看到 `tactic:poison`
  // 这种内部编号）。**交付要求没变**：卡片本体仍必须在 `knowledge` 里；守卫那条
  // 「正文引了它、就必须交付过」用**合成样本**继续钉（下面的反证），判据不是空的。
  assert.ok((b.knowledge ?? []).some((c) => c.id === 'tactic:poison'), '卡片本体仍要交付');
  const citing = {...b, text: '（依据：知识卡 tactic:poison）'};
  assert.equal(checkGroundedAnswer(citing).valid, true, '交付过的引用要放行');
  // ③ 反证：守卫看见的可引用集合来自 `knowledge` —— 把卡片拿掉，同一条回答必须被判红
  const stripped = {...citing, knowledge: []};
  const judged = checkGroundedAnswer(stripped);
  assert.equal(judged.valid, false, '把卡片拿掉之后，同一条回答必须被判红（判据不是空的）');
  assert.ok(judged.reasons.some((r) => /unsupported-citation:tactic:poison/.test(r)),
    `要红在"未交付的引用"上：${JSON.stringify(judged.reasons)}`);
  assert.equal(plan + generate, 0, '这一族仍然 0 次模型调用');
});

// ── ㉞ 名字抽取：句尾助词/指示词不许跟着名字进引擎（手游 j02 实测）────────────────────
//
// 真机实测（2026-09-25，手游那一档 j02「小翼龙的配招怎么选？先说它学得到哪些招。」）：
// 第一次 `query_rules{kind:'learnset',name:'小翼龙的'}` 被引擎按 404 退回来
// （`未知精灵名：小翼龙的`），模型的收尾回答于是变成「这个名字我这边查不到」——
// 而图鉴里**有** `pet_000186 小翼龙`（`full-catalog.json` 622 条里含「小翼龙」的正好 1 条）。
// 根因在 `legalityPet` 的兜底切法：按「配」切出来的头是「小翼龙的」。这一条钉住归一化，
// 并带反证（图鉴里没有任何名字以「的/之」结尾、也没有以「这/那」开头 —— 所以剥掉是安全的）。
test('㉞ 名字抽取剥掉句尾的助词/指示词，且拿不到名字时仍然 fail closed', () => {
  const ctx = {mode: 'camp', profile: {pets: [{id: 'own-0001', name: '喵喵'}]}};
  const cases = [
    ['小翼龙的配招怎么选？先说它学得到哪些招。', '小翼龙'],
    ['小翼龙的配招怎么选？', '小翼龙'],
    ['这只小翼龙的配招怎样', '小翼龙'],
    ['小翼龙这一只的配招怎么选？', '小翼龙'],
    ['寂灭骨龙的配招怎么选？', '寂灭骨龙'],
    ['喵喵的配招怎么选？', '喵喵'],          // 名单里的名字（走 known 那一条，不受影响）
  ];
  for (const [q, want] of cases) {
    assert.equal(legalityPet(q, ctx), want, `「${q}」应抽出 ${want}`);
    assert.equal(loadoutAsk(q, ctx), true, `「${q}」要接住（名字抽得出来）`);
  }
  // 参数构造：发给引擎的 `name` 必须就是归一化之后那个（不是「小翼龙的」）
  const args = defaultArgsFor('query_rules', ctx, '小翼龙的配招怎么选？先说它学得到哪些招。');
  assert.equal(args?.kind, 'learnset');
  assert.equal(args?.name, '小翼龙', `发给引擎的名字要归一化：${JSON.stringify(args)}`);
  // 反证：只剩指示词/动词的句子不许被当成名字（fail closed，宁可不发这一枪）
  for (const q of ['这只的配招怎么选？', '战斗的配招怎么选？', '怎么配招？']) {
    assert.equal(legalityPet(q, ctx), null, `抽不出名字就必须返回 null：${q}`);
  }
});

// ── 复盘问句，但这一份上下文里**没有对局**（小芽弹窗、营地首页）──────────────────────
// 真机实测（第 38 轮 40 次验收，真 8765）：小芽弹窗问「刚才那回合我错在哪？」⇒ 先花**一次模型调用**，
// 模型只能给一句没标注的"不给结论"，再被守卫按人类口径（「不要说不知道」）判 `unlabeled-unknown`
// 打回，玩家拿到的是一句通用兜底。没有对局就没有可复盘的东西 —— 本地如实说清，0 次模型调用。
test('复盘问句但没有对局：本地如实作答、0 次模型调用（含反证：有对局时不许被抢走）', async () => {
  const camp = {mode: 'camp', battle: null, profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫', types: ['风系']}]}};
  for (const q of ['刚才那回合我错在哪？', '上一回合我错在哪？', '输在哪？', '帮我看看整局的统计', '回顾上一局']) {
    assert.equal(policyFor(q, camp).reason, 'review-without-match', `「${q}」要走本地这一族`);
  }
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(packet) { generate += 1; return '（模型编的复盘）'; }};
  const answer = await runCoach({message: '刚才那回合我错在哪？', role: 'auto', context: camp,
    memory: freshMemory(), provider});
  assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
  assert.equal(plan + generate, 0, '这一族不许问模型');
  const text = String(answer.text);
  assert.match(text, /没有对局记录/, `要说清为什么没有可复盘的：${text}`);
  // 注意：正文里那句「我不编一段"你那一手错了"给你」本身含"你那一手"四个字，
  // 所以这里否定的是**断言式**的说法（"你应该…""你那一手错了"），不是字面词。
  assert.doesNotMatch(text, /那一手(应该|该|有问题)|你应该出|你的问题是/, '不许凭空指出玩家哪一手有问题');
  assert.match(text, /不会凭空/, '要明确写出"不凭空"这条口径');
  assert.match(text, /训练场|把当时的局面说给我/, '要给两条立刻能走的路');
  // 反证：真的带着对局时，这一族**不许**抢走（那条路要照旧去读引擎的记录）
  const withBattle = buildContext(createGame(445), newProfile(), 'fox');
  assert.notEqual(policyFor('上一回合我错在哪？', withBattle).reason, 'review-without-match',
    '有对局时不许落进"没有对局"那一族');
});

// ── 记忆问句（本命/目标/你记得我什么）──────────────────────────────────────────────
// 真机实测（2026-09-26）：「我的本命是谁？」被**图鉴**那条吃掉，回「未知精灵名：本命」
// —— 把"本命"当成了精灵名。答案在记忆里，不在图鉴里，所以这一族要排在图鉴之前、本地作答。
test('记忆问句从记忆里答（0 次模型调用）；没记过就直说没记录', async () => {
  const camp = {mode: 'camp', battle: null, profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫'}]}};
  for (const q of ['我的本命是谁？', '我设过什么目标？', '你记得我什么？']) {
    assert.equal(policyFor(q, camp).reason, 'memory-recall-ask', `「${q}」要走记忆这一族`);
  }
  const memory = {...freshMemory(), favorite: 'pet_000118', goal: '速攻',
    lessons: ['同优先级下速度高的先出手'],
    stated: [{kind: 'favorite', label: '本命：皇家狮鹫', value: '皇家狮鹫', time: '2026-09-26T00:00:00.000Z'}]};
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(packet) { generate += 1; return '（模型编的）'; }};
  const answer = await runCoach({message: '我的本命是谁？', role: 'auto', context: camp, memory, provider});
  assert.equal(answer.agentStop, 'policy-fact-local', `要本地答：${answer.agentStop}`);
  assert.equal(plan + generate, 0, '记忆问句不许问模型');
  const text = String(answer.text);
  assert.match(text, /皇家狮鹫/, `要说清记的是哪一只：${text}`);
  assert.match(text, /更主动/, '目标也要照实说');
  assert.doesNotMatch(text, /未知精灵名/, '不许把它当成图鉴查询');
  // 没记过的时候：直说没记录 + 告诉玩家怎么让我记住（不许编一条）
  const blank = await runCoach({message: '你记得我什么？', role: 'auto', context: camp,
    memory: freshMemory(), provider});
  const blankText = String(blank.text);
  assert.match(blankText, /没有记录/, `没记过就要直说：${blankText}`);
  assert.doesNotMatch(blankText, /皇家狮鹫/, '没记过时不许编一个本命');
});

// ── ⑮ 「讲讲我这队」这类说法也要走引擎（2026-09-26 真机复现补的）──────────────────
//
// 真机（8765、DeepSeek）：同一件事换个说法结果完全不同 ——
//   ·「用三句话讲讲这套阵容」（面板按钮的原话）→ 走引擎，答的是属性覆盖/弱点/速度分层；
//   ·「三句话讲讲我这队」→ `route=companion register=R0`，答「有速度、有肉盾、能平衡，搭得挺整」，
//     **引擎一次都没查**。根因就在 `TEAM_ASK_SHAPE` 少了「讲讲」这类动词（范围词本来就有）。
// 这一条钉两件事：① 补上动词之后这句必须进 `team-ask`；② **不许过度触发** ——
// 没有范围词的「讲讲你的看法」不能变成整队问句（否则会把闲聊吃成阵容评估）。
test('⑮ 「讲讲我这队」要和「讲讲这套阵容」走同一条路（反证：没有范围词的句子不许被吃）', async () => {
  const context = {mode: 'camp', profile: {lineup: [
    {id: 'pet_000118', name: '皇家狮鹫'}, {id: 'pet_000137', name: '多多'}, {id: 'pet_000143', name: '花魁蜂后'}]}};
  for (const q of ['三句话讲讲我这队', '说说这三只', '介绍一下我这套阵容']) {
    assert.equal(teamAskShape(q, context), true, `「${q}」要认成整队问句`);
    assert.equal(policyFor(q, context).reason, 'team-ask', `「${q}」要真的去查引擎`);
  }
  // 反证：动词有了、范围词没有 ⇒ 不许当成整队问句（这三句都不是在问"我这队"）
  for (const q of ['讲讲你的看法', '随便聊聊', '说说这个技能']) {
    assert.equal(teamAskShape(q, context), false, `「${q}」没有范围词，不许被吃成整队问句`);
    assert.notEqual(policyFor(q, context).reason, 'team-ask', `「${q}」不该去查阵容`);
  }
  // 端到端：没有模型时也要给出引擎算的结构结论，而不是那句陪练兜底
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model', async plan() { plan += 1; return {stop: true}; },
    async generate(p) { generate += 1; return String(p?.text ?? ''); }};
  const camp = buildContext(createGame(446), newProfile(), 'fox');
  camp.profile = {...camp.profile, lineup: [
    {id: 'fox', name: '烬尾狐', types: ['fire']},
    {id: 'turtle', name: '潮甲龟', types: ['water']},
    {id: 'deer', name: '芽角鹿', types: ['leaf']}]};
  const answer = await runCoach({message: '三句话讲讲我这队', role: 'auto', context: camp,
    memory: freshMemory(), provider});
  assert.equal(answer.agentStop, 'policy-fact-local', `要走引擎那条路：${answer.agentStop}`);
  assert.match(String(answer.text), /速度线|共同弱点/, `要给出结构结论：${answer.text}`);
  assert.ok(!/我在。/.test(String(answer.text)), '不许再落到那句陪练兜底');
  assert.ok(!/搭得挺整|自娱自乐/.test(String(answer.text)), '更不许是一句没依据的夸奖');
});

// ── ㉞ 两组常量要按档说：手游侧不许拿营地那一档的数字顶（2026-09-26，人类 ②）──────────
//
// 子代理全仓核实（含 `data/roco/raw/extracted/` 的两个第三方快照仓库、NRC_AI 的实机核对模板
// `*_game` 列 0/50 填）：**手游侧没有每点收益、没有加点上限**；`RULES.training` 的
// +12 生命 / +4 攻击 / +3 速度与 `RULES.energy` 的上限 6 都是**本仓营地那一档练习引擎**自己定的。
// 这一条钉两件事：① 手游形状 ⇒ 不许出现那两组数字，并且要如实说缺源；② 营地形状 ⇒ 照旧念。
test('㉞ 加点退役后：两档都说"没有加点"；能量仍然按档分开说', async () => {
  // 2026-09-27 **改钉**（人类：「加点不要了，按照洛手的机制来，根本没有这些」）：
  // 这一条原来钉「加点常量按档分开说」（手游侧不念营地常量）。加点退役之后，
  // 两档答的是**同一句否定句**，判据跟着改成：① 两档都直说没有加点、都不报任何加点数值；
  // ② 能量那条的**分档**照旧（手游 10 / 营地 6）—— 那一半没动。
  const mobile = {mode: 'camp', profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫'}], lineup: []}};
  const camp = {mode: 'camp', profile: {growth: {pets: {fox: {points: {hp: 1}}}, tokens: 3}}};

  const ask = (q, ctx) => localParametricFact(q, ctx);
  const trainMobile = ask('加点收益是多少？', mobile);
  const trainCamp = ask('加点收益是多少？', camp);
  const energyMobile = ask('能量上限是几个豆？', mobile);
  const energyCamp = ask('能量上限是几个豆？', camp);

  for (const [label, row] of [['手游侧', trainMobile], ['营地侧', trainCamp]]) {
    assert.ok(row && typeof row.text === 'string', `${label}的加点问句要有本地答案`);
    assert.match(row.text, /没有加点/, `${label}要直说这一版没有加点：${row.text}`);
    assert.match(row.text, /性格|天分/, `${label}要说清培养是什么`);
    assert.match(row.text, /我的盒子/, `${label}要说清在哪做`);
    // 旧口径的常量一个都不许念（逐值反证）
    assert.doesNotMatch(row.text, new RegExp(`\\+${RULES.training.hp} 生命`), `${label}不许念营地加点常量`);
    assert.doesNotMatch(row.text, new RegExp(`\\+${RULES.training.atk} 攻击`), `${label}不许念营地加点常量`);
    assert.doesNotMatch(row.text, /培养格|训练点 ?\d/, `${label}不许提培养格/训练点余额`);
    assert.doesNotMatch(row.text, /本仓|台账/, '正文不许出现内部说法');
  }
  // 能量那一半照旧分档（这一半**没有**被退役影响）
  assert.match(energyMobile.text, /10/, '能量：手游侧常规上限是台账里的 10');
  assert.match(energyCamp.text, new RegExp(`${RULES.energy.max} 豆才是满豆`), '能量：营地侧照旧');
  assert.match(energyMobile.text, /不是官方文本/, '要说清这不是官方文本');
  assert.doesNotMatch(energyMobile.text, /EV-ENERGY-MAX/, '正文不许出现台账条目名');
  assert.match((energyMobile.evidence || []).join(' '), /EV-ENERGY-MAX/, '依据里要给得出条目名');
});


test('㉟ 规则集版本问句：政策必须判得出来、参数必须凑得出来（2026-09-28 补的缺口）', () => {
  // 由来：`--policy-first` 对照实测（288 条任务）判挂只剩 2 条，两条都是「这份规则集是哪个版本？」——
  // 政策对这类问句**没有形状** ⇒ 静默交回模型 ⇒ 模型调了 read_state（错工具）。
  // 这一条钉两件事：① 形状认得出（含各种前缀）；② 参数凑得出来（原来 defaultArgsFor 返回 null，
  // 政策判出了 need 也白判）。
  const ctx = {mode: 'camp'};
  for (const message of ['这份规则集是哪个版本？', '这份规则集是哪个版本啊？',
    '再确认一下，这份规则集是哪个版本？', '我在练习场，想问下：这份规则集是哪个版本？',
    '我锁定寂灭骨龙，我在练习场，想问下：这份规则集是哪个版本？']) {
    const policy = policyFor(message, ctx);
    assert.equal(policy.need, 'query_rules', `政策要认得出：${message}`);
    assert.equal(policy.reason, 'ruleset-version-ask', message);
    assert.deepEqual(defaultArgsFor('query_rules', ctx, message), {kind: 'ruleset'},
      `参数要凑得出来（原来这里是 null）：${message}`);
  }
  // 反证①：只提"版本"、与规则集无关的问句**不许**被抢走（误伤比漏判更糟）
  assert.equal(policyFor('这游戏什么版本？', ctx).need, null);
  // 反证②：图鉴问句仍走原来那一路，参数形状不变
  const pet = policyFor('寂灭骨龙的种族值是多少？', ctx);
  assert.equal(pet.reason, 'codex-fact');
  assert.deepEqual(defaultArgsFor('query_rules', ctx, '寂灭骨龙的种族值是多少？'),
    {kind: 'pet', name: '寂灭骨龙'});
});
