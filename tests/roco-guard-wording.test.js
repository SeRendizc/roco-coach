// 「防御」这一族的两处真错：判据 + 必红反证（2026-09-28）。
//
// ── A. 模板调用入口（先 grep 出来的事实，不是猜的）─────────────────────────────
//   · `localParametricFact(message, context)` —— **已导出**，`src/coach/runtime.js:366`。
//     这就是「拿一句『防御能减伤多少？』换模板正文」的那个入口；返回
//     `{text, evidence:[…], knowledge:[tactic:guard]}` —— 正文是 `answer.text`，
//     证据数组是 `answer.evidence`（`knowledge` 是随正文一起交付的卡本体）。
//   · 防御模板在它**体内**：判定在 `src/coach/runtime.js:405`
//     （`if(/防御.{0,6}(减伤|减免|减少|少受)|减伤多少/.test(text)){`），
//     说反能量方向的那一行在 `src/coach/runtime.js:412`
//     （`` +`，消耗 ${RULES.guard.energy} 能量。` ``）。
//   · 放行它的门：`parametricFactAsk` `src/coach/runtime.js:179`，正则
//     `PARAMETRIC_FACT_ASK` `src/coach/runtime.js:126`。
//   · 生产调用点：`localFactAnswer`（**未导出**）`src/coach/runtime.js:519`，体内
//     `src/coach/runtime.js:530` 是 `const constant=localParametricFact(message,context);`
//     —— 0 次工具、0 次模型，正文直接发给玩家。
//   · **走行为级还是源码级**：模板函数**已导出**，所以下面全部走**行为级**（真调那一层，
//     看它真的要发出去的 `text`/`evidence`）。理由：源码级只证明"字面量长什么样"，
//     证明不了"拼接之后发给玩家的那句话是什么"（跨行模板、常量插值都会让它失真；
//     见 `tests/README.md` 纪律 3「静态判据会假绿」）。只有一处例外：③ 的**依据**
//     要读 `src/game/engine.js` 那行结算式（那不是被验对象，是判据的出处）。
//
// ── 引擎事实（本文件所有正向说法的出处）──────────────────────────────────────
//   · `src/game/engine.js:13`  `guard:{reduction:.65,energy:2}`
//   · `src/game/engine.js:290` `p.energy=Math.min(RULES.energy.max,p.energy+RULES.guard.energy)`
//     ⇒ 防御**不花能量、还额外加 2 点**（技能 cost 是 0，见 `src/game/engine.js:57`）。
//   · `src/game/engine.js:57`  技能说明原文：「本回合减伤 65%，阻挡新异常，额外恢复 2 能量；不可连续使用」
//   · `src/game/content.js:27` 规则卡 `tactic:guard` 的 principle：「防御减伤65%、阻挡新异常并额外恢复2能量，不可连续使用」
//
// ── 两处真错（实测复现，本文件把它们变成判据）────────────────────────────────
//   错误 1：`src/coach/runtime.js:412` 把「额外恢复 2 能量」写成了「**消耗** 2 能量」——方向反了。
//           实测正文：`防御这一回合减伤 65%，消耗 2 能量。（游戏里的固定规则：防御减伤，不是估的）`
//           ⇒ 判据 ① ② ③。
//   错误 2：`FAMILY_SIGNALS.rules`（`src/coach/runtime.js:2711`，`.rules` 在 2715）的
//           正则里**没有「减伤」「回血」**⇒ `evidenceNeeds('防御能减伤多少？',{mode:'battle'})`
//           返回 `{families:[], reason:'state-in-packet'}` ——**0 个来源**。
//           而这两个词就写在卡自己的 keywords 里（`tactic:guard`：「防御 破甲 重击 狮子 减伤」；
//           `tactic:healing`：「回血 回复药 苔息 治疗 来得及」）⇒ 补词是**从卡数据取词**。
//           ⇒ 判据 ④（**当前应为红**）、反证 ⑤ ⑥、取证 ⑧。
//
// 必红反证：每条判据都在同一个文件里喂一个**违规样本**，看同一条纯函数会不会翻红
//（`tests/README.md` 纪律 2：判据与反证共用一份纯函数，不许写两遍）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {localParametricFact, parametricFactAsk, evidenceNeeds, checkGroundedAnswer}
  from '../src/coach/runtime.js';
import {RULES} from '../src/game/engine.js';
import {cards} from '../src/coach/strategist.js';

const GUARD_ASK = '防御能减伤多少？';

/** 真调那一层：正文与证据都从**返回值**取（不是从源码字面量拼）。 */
const guardAnswer = () => localParametricFact(GUARD_ASK, {mode: 'battle'});

/** 把答案摊平成「正文 + 证据」一段文本（引用卡正文也算证据的一部分）。 */
const evidenceTextOf = (answer) => [
  ...(answer?.evidence ?? []),
  ...((answer?.knowledge ?? []).map((card) => [card.principle, card.counterexample].filter(Boolean).join(' '))),
].join(' ');

// ── 三条共用的纯判定（判据与必红反证走同一份）─────────────────────────────────

/** ① 说了减伤多少：正文必须出现 65% 这一档。 */
const statesReduction65 = (text) => /减伤\s*65\s*[%％]/.test(String(text));

/** ② 把恢复说成消耗：正文**不许**出现这种方向反了的说法（空格形态都算）。 */
const saysGuardCostsEnergy = (text) => /消耗\s*2\s*(?:点)?\s*能量/.test(String(text));

/** ③ 正向说法：防御给能量 / 不花能量（措辞按 `src/game/engine.js:290` 那一行定）。 */
const saysGuardGivesEnergy = (text) =>
  /(?:额外)?恢复\s*2\s*(?:点)?\s*能量|回\s*2\s*(?:点)?\s*能量|回2|不花|不消耗/.test(String(text));

/** ④ 来源族：一句话要不要「战术规则/反例」这一族的证据。 */
const asksForRulesFamily = (message, context = {mode: 'battle'}) =>
  (evidenceNeeds(String(message), context).families ?? []).includes('rules');

test('防御模板两处真错：入口 + 取正文/证据的调用形状（判据 0，接线不许断）', () => {
  // 为什么要有这一条：下面 ①②③ 全依赖「这句话真能走到那个模板」。判定（`parametricFactAsk`）
  // 与实现（`localParametricFact`）分开写死过一次（见 `runtime.js:182-190` 的事故记录），
  // 所以接线本身要有一条判据：门必须开、模板必须给东西、给的东西必须带证据数组。
  assert.equal(parametricFactAsk(GUARD_ASK), true,
    `「${GUARD_ASK}」必须被参数化事实这一族放行（src/coach/runtime.js:179）`);
  const answer = guardAnswer();
  assert.ok(answer && typeof answer.text === 'string', `本地必须直接成句，实际拿到 ${JSON.stringify(answer)}`);
  assert.ok(Array.isArray(answer.evidence) && answer.evidence.length > 0,
    `正文必须带证据数组（守卫靠它对数字），实际 ${JSON.stringify(answer.evidence)}`);
  assert.deepEqual((answer.knowledge ?? []).map((card) => card.id), ['tactic:guard'],
    '这一支必须把 `tactic:guard` 卡本体一起交付（正文写「来源：知识卡 X」时 X 必须真发出去）');
  // 分档不改变防御这一支（能量上限那一支才分档）：两种上下文形状必须给同一句话
  assert.equal(localParametricFact(GUARD_ASK, null).text, answer.text,
    '防御这一支是常量事实，不该随上下文档位变');
  // 必红反证：这句不是这一族 ⇒ 同一个入口必须**不给答案**（证明"门是门，不是恒真）
  assert.equal(localParametricFact('今天天气不错', {mode: 'battle'}), null,
    '与规则无关的寒暄不许被这条模板接走');
});

test('判据①：防御正文必须出现「减伤 65%」（必红反证：30% / 没有数都翻红）', () => {
  const text = guardAnswer().text;
  assert.ok(statesReduction65(text), `正文没写减伤 65%：${text}`);
  // 必红反证：同一个纯函数喂违规样本必须翻红
  assert.equal(statesReduction65('防御这一回合减伤 30%。'), false, '错的百分数必须被这条判据抓住');
  assert.equal(statesReduction65('防御能挡住新异常。'), false, '只说机制不给数也必须被抓住');
  // 反证的正面：真的那句确实能被这条判据认出来（否则上面两条断言可能只是"恒 false"）
  assert.equal(statesReduction65('防御这一回合减伤 65%，消耗 2 能量。'), true,
    '出错那一版正文里的 65% 必须被这条判据认出来');
});

test('判据②：防御正文绝不能把「恢复 2 能量」说成「消耗 2 能量」（必红反证：改前那句必须被抓住）', () => {
  const text = guardAnswer().text;
  assert.equal(saysGuardCostsEnergy(text), false,
    `防御是**加** 2 能量（src/game/engine.js:290），正文却说成了消耗：${text}`);
  assert.ok(!text.includes('消耗 2 能量') && !text.includes('消耗2能量'),
    `两种空格形态都不许出现：${text}`);
  // 必红反证：改前那句（实测抓到的原话）喂给同一个判定必须报错
  assert.equal(saysGuardCostsEnergy('防御这一回合减伤 65%，消耗 2 能量。'), true,
    '改前那句必须被这条判据抓住，否则这条判据是空的');
  assert.equal(saysGuardCostsEnergy('防御这一回合减伤 65%，消耗2能量。'), true, '无空格形态也要抓住');
  assert.equal(saysGuardCostsEnergy('防御这一回合减伤 65%，消耗 2 点能量。'), true, '「2 点能量」形态也要抓住');
});

test('判据③：防御正文必须说清它给能量 / 不花能量（依据 `src/game/engine.js:290`）', () => {
  // 依据就是这一行（不是口味）：
  //   `src/game/engine.js:290`
  //   `if(a.id==='guard'){…p.energy=Math.min(RULES.energy.max,p.energy+RULES.guard.energy);…}`
  // 且技能自己的 cost 是 0（`src/game/engine.js:57` 的 `guard:{name:'防御',cost:0,…}`）——
  // 所以「消耗 2 能量」不只是措辞问题，它与结算式**符号相反**。
  const text = guardAnswer().text;
  assert.ok(saysGuardGivesEnergy(text), `正文没说清防御给能量 / 不花能量：${text}`);
  // 必红反证：改前那句（只有"消耗"、没有任何正向说法）喂给同一个判定必须翻红
  assert.equal(saysGuardGivesEnergy('防御这一回合减伤 65%，消耗 2 能量。'), false,
    '改前那句必须被判成"没给能量"，否则这条判据是空的');
  // 三种可接受措辞都要能过（免得判据只认一种写法，逼出"为过判据而造句"）
  for (const good of ['防御额外恢复 2 能量。', '防御回 2 点能量。', '防御不花能量，反而回2。']) {
    assert.equal(saysGuardGivesEnergy(good), true, `这种正向说法该放行：${good}`);
  }
  // 引擎方向本身也要钉住：`RULES.guard` 就是 65% / +2，且结算式是「加」不是「减」
  assert.deepEqual({reduction: RULES.guard.reduction, energy: RULES.guard.energy},
    {reduction: 0.65, energy: 2}, '`src/game/engine.js:13` 的 `guard:{reduction:.65,energy:2}` 变了，本判据要跟着改');
  const engine = readFileSync(new URL('../src/game/engine.js', import.meta.url), 'utf8');
  const gainLine = /p\.energy\s*=\s*Math\.min\(\s*RULES\.energy\.max\s*,\s*p\.energy\s*\+\s*RULES\.guard\.energy\s*\)/;
  assert.ok(gainLine.test(engine),
    '`src/game/engine.js:290` 的防御结算式必须仍是「加 `RULES.guard.energy`」');
  // 必红反证：把方向反过来的写法喂给同一个正则必须不认
  assert.equal(gainLine.test('if(a.id===\'guard\'){p.energy-=RULES.guard.energy;}'), false,
    '"扣能量"的结算式不许被这条判据认成加能量');
});

test('判据④：`evidenceNeeds(\'防御能减伤多少？\')` 必须包含 `rules` 族（★ 当前应为红：等 src 补词）', () => {
  // 错误 2：`FAMILY_SIGNALS.rules`（`src/coach/runtime.js:2715`）里没有「减伤」⇒ 这句被判成
  // **不需要任何证据来源**（实测 `{families:[], reason:'state-in-packet'}`）。而它问的是
  // 规则卡 `tactic:guard` 写着的机制 ⇒ 交付前必须去查规则族。
  // ⚠ 这条判据**在 src 修好之前就是红的**，这是预期结果（不许为了让测试变绿去改测试的意图）。
  const needs = evidenceNeeds(GUARD_ASK, {mode: 'battle'});
  assert.ok(needs.families.includes('rules'),
    `这句问的是规则卡事实，必须要求查规则族；实际 ${JSON.stringify(needs)}`);
  // 必红反证（证明这条判据有牙，不是"怎么问都 true"）：换成不含规则措辞的寒暄必须不认这一族
  assert.equal(asksForRulesFamily('你好呀'), false, '寒暄不该被判成要查规则族');
  // 正向对照：**已经**带规则措辞的问法今天就能命中这一族（说明这一族的判定不是恒 false）
  assert.equal(asksForRulesFamily('防御的规则代价是什么？'), true,
    '「规则/代价」这类措辞今天就该命中 rules 族（判定函数的正向对照）');
});

test('判据⑤反证：与规则无关的话不得被判成需要 `rules` 族', () => {
  assert.equal(asksForRulesFamily('你好呀'), false, '「你好呀」不是规则问题');
  assert.equal(asksForRulesFamily('我在。'), false, '「我在。」不是规则问题');
  assert.deepEqual(evidenceNeeds('你好呀', {mode: 'battle'}).families, [],
    '寒暄本来就该是 0 个来源');
});

test('判据⑥反证：`第 3 回合如果我先防御会怎样？` 不得被补词带成 `rules` 族', () => {
  // 现状实测：`['turn','branch']`（`reason:'named-turn'`）——它问的是**那一回合的分支**，
  // 不是规则卡事实。补「减伤 / 回血」不许把它带偏成三族。
  const needs = evidenceNeeds('第 3 回合如果我先防御会怎样？', {mode: 'battle'});
  assert.ok(!needs.families.includes('rules'),
    `这句是回合+分支，不该被补词带成 rules 族；实际 ${JSON.stringify(needs)}`);
  assert.deepEqual(needs.families, ['turn', 'branch'],
    `这一句的来源族不许变（实测基线 ['turn','branch']）；实际 ${JSON.stringify(needs)}`);
});

test('判据⑦改法预演：建议的正文同时过 ①②③ 与数字守卫（必红反证：多算一个 35 必须被守卫拒）', () => {
  // 这一条不验 src（src 还没改），验的是**建议的改法本身**可用：
  // 只用 65 与 2 两个数（否则 `checkGroundedAnswer` 会判 `unsupported-number`，
  // 见 `runtime.js:406-407` 记的金标 c14 事故：由 0.65 反算出来的 35 在证据包里查不到）。
  const fixed = '防御这一回合减伤 65%，阻挡新异常，额外恢复 2 能量；不可连续使用。'
    + '（游戏里的固定规则：防御减伤，不是估的）';
  assert.ok(statesReduction65(fixed), '改法预演必须过判据①');
  assert.equal(saysGuardCostsEnergy(fixed), false, '改法预演必须过判据②');
  assert.ok(saysGuardGivesEnergy(fixed), '改法预演必须过判据③');
  const evidence = guardAnswer().evidence;
  const good = checkGroundedAnswer({text: fixed, evidence});
  assert.equal(good.valid, true, `建议的正文必须过数字守卫，实际 ${JSON.stringify(good.reasons)}`);
  // 必红反证：同一份证据下，多写一个由 0.65 反算的 35 必须被守卫判死
  const bad = checkGroundedAnswer({text: '防御这一回合减伤 65%，只剩 35% 伤害，额外恢复 2 能量。', evidence});
  assert.equal(bad.valid, false, '多出来的数字必须被守卫抓住（否则这条预演没有意义）');
  assert.ok(bad.reasons.includes('unsupported-number:35'),
    `守卫要给的是 unsupported-number:35，实际 ${JSON.stringify(bad.reasons)}`);
  // 现有证据数组本身也要能兜住 65 与 2（补词/改句时证据不能跟着丢掉）
  const bag = evidenceTextOf(guardAnswer());
  for (const n of ['65', '2']) {
    assert.ok(new RegExp(`(^|\\D)${n}(\\D|$)`).test(bag), `证据里必须有 ${n} 可查：${bag}`);
  }
});

test('判据⑧取证：要补的词必须**从卡数据里取**，不是凭口味挑的', () => {
  // ④ 补词的两处出处（`cards` = `src/game/content.js:27` 的 `TACTIC_CARDS`，经
  // `src/coach/strategist.js:5` 汇成一份 —— 与运行时读的是**同一份**卡数据）：
  const keywordsOf = (id) => (cards.find((card) => card.id === id)?.keywords ?? '').split(/\s+/).filter(Boolean);
  const guard = keywordsOf('tactic:guard');
  const healing = keywordsOf('tactic:healing');
  assert.ok(guard.includes('减伤'), `「减伤」必须出自 tactic:guard 的 keywords，实际 ${JSON.stringify(guard)}`);
  assert.ok(healing.includes('回血'), `「回血」必须出自 tactic:healing 的 keywords，实际 ${JSON.stringify(healing)}`);
  // 必红反证：编出来的词不在卡里 —— 说明"卡里有这个词"这件事是真的在比对，不是空断言
  assert.equal(guard.includes('穿透减伤'), false, '卡里没有的词不许被当成取词出处');
  assert.equal(healing.includes('治疗量'), false, '卡里没有的词不许被当成取词出处');
});
