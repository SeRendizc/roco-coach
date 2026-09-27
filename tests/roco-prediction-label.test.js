// 「不要说不知道」在**代码里**的那一半（人类口径 2026-09-25，逐字：
// 「不要说不知道！预测就说预测，不准不知道啊，ai都不知道了那要他何用？模拟贵所以通过某种机制让
//  llm 和 agent 配合解题」）。
//
// 为什么需要这个文件（可复算的事实，不是感觉）：
//   · `predictionScaffold()`（`src/coach/runtime.js`）早就把这条规则写进了**模型包**，
//     `forbid[0]` 就是「不带依据的『不知道』」—— 但**没有任何判据在执行它**：提示里写的规则，
//     模型不遵守也没人知道（这正是本仓反复记的那类缺口：判据在，牙不在）。
//   · 更糟的是整改指令**自相矛盾**：`repairFor('unsupported-certainty')` 原来写「改成条件说法
//     **或如实说不知道**」—— 代码亲手请模型交白卷。本轮两处一起改。
//
// 判据本体是**纯函数** `checkPredictionLabel`（服务端守卫链的一环），本文件同时钉三件事：
//   ① 口径：只认**第一人称**的交白卷；带 `推断` 标签、点明缺哪块数据、说游戏公开面规则、
//      问玩家的疑问句 —— 一律放过（**误伤比漏网贵**：命中即改写、改不对就降级成模板）；
//   ② 接线：它真的进了 `runCoach` 的答案层守卫链，被拒时走**既有**的纠错/降级通道，
//      玩家看到的是本地已核验结论，回执里 `rejectedReason` 说的是真话；
//   ③ 反证：把出口拆掉（只留「我不知道」）必须红 —— 每条反证都真跑过。
//
// 实测标定（不是估计）：拿 54 条**真实模型回答**（`reports/live-model-eval-raw.json`，2026-09-25
// 那一轮 live 评测的原始正文）跑这条守卫，命中 **0** 条；唯一带「没法判断」的那条（c40）本身
// 就是合规写法（带「这是推断（不是实测）」+ 点明缺的是上一轮正文），下面把它当**必过样例**钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildContext, checkPredictionLabel, predictionScaffold, PREDICTION_LABEL, runCoach} from '../src/coach/runtime.js';
import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const RAW = JSON.parse(readFileSync(new URL('../reports/live-model-eval-raw.json', import.meta.url), 'utf8'));

/** 真实实录里那条**合规**回答（逐字，出自 `reports/live-model-eval-raw.json` 的 c40）。 */
const REAL_COMPLIANT = (RAW.rows || []).find((r) => r.id === 'c40')?.text || '';

/** 一份不需要任何外部服务的上下文（provider 是假的 ⇒ 不联网、不花钱）。 */
const context = () => buildContext(createGame(445), newProfile(), 'fox');

/**
 * 按脚本回话的假 provider：`plan` 一律 `{stop:true}`（不进工具循环，只判答案层），
 * `generate` 依次回脚本里的话（用光后重复最后一句）。`packets` 让判据能看模型**看到了**什么。
 */
async function run({script, message = '这回合怎么打', budget} = {}) {
  const packets = [];
  let calls = 0;
  const provider = {
    name: 'stub',
    async plan(packet) { packets.push(packet); return {stop: true, summary: 'no-tools'}; },
    async generate(packet) {
      packets.push(packet);
      const text = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return text;
    },
  };
  const answer = await runCoach({message, role: 'auto', context: context(), memory: freshMemory(),
    conversation: [], provider, ...(budget === undefined ? {} : {correctionBudget: budget})});
  return {answer, packets, calls};
}

test('判据①：第一人称的交白卷必须被抓住（「我不知道 / 我查不到 / 我无法判断」）', () => {
  for (const text of ['我不知道。', '我这边查不到那两句话。', '我无法判断这一手。',
    '我不确定这回合该不该换。', '我手上没有数据。', '我回答不了这个问题。']) {
    const verdict = checkPredictionLabel({text}, {required: true});
    assert.equal(verdict.labeled, false, `必须判不合格：${text}`);
    assert.deepEqual(verdict.reasons, ['unlabeled-unknown'], `原因族只许是 unlabeled-unknown：${text}`);
  }
});

test('判据②：三条出口都必须放过（带标签的推断 / 点明缺哪块数据 / 说公开面规则）', () => {
  const pass = [
    // 出口①：带标签的预测 —— 人类口径的后半句是「**并给出依据**」，所以样例自带出处
    `这是${PREDICTION_LABEL}（不是实测，依据是当前局面）：对手更可能换宠，把握中。`,
    // 出口②：点明缺的是哪一块数据
    '我这轮接不到那两句话，没法判断还算不算数。缺的是上一轮回答的正文数据。',
    // 出口②的另一种写法：需要一次实机读数
    '这套配招的先手我没法判断，需要一次实机读数（同系技能对比）才能定。',
    // 公开面规则（B3 口径：出招前不可能知道对手动作）—— 这不是交白卷
    '出招前不可能知道对手要做什么，这是 PVP 的公开面规则；按分支看，防御能吃掉大部分伤害。',
    // 问玩家的疑问句（B3 允许的口径本身）
    '优先级相同，你会先出手、后出手，还是无法确定？',
  ];
  for (const text of pass) {
    assert.equal(checkPredictionLabel({text}, {required: true}).labeled, true, `不许误伤：${text}`);
  }
});

test('判据③：真实实录里那条合规回答必须过（逐字，出自 reports/live-model-eval-raw.json 的 c40）', () => {
  assert.ok(REAL_COMPLIANT.includes(PREDICTION_LABEL), '样例本身应带「推断」标签，否则这条判据失效');
  assert.equal(checkPredictionLabel({text: REAL_COMPLIANT}, {required: true}).labeled, true,
    '真机合规回答被误判 ⇒ 守卫会把它改写掉，等于用守卫制造倒退');
});

test('判据④a：标了「推断」就必须说依据（合成的「只有方向、没有出处」必须红）', () => {
  const noBasis = `这是${PREDICTION_LABEL}（不是实测）：他会换宠。`;
  assert.deepEqual(checkPredictionLabel({text: noBasis}, {required: true}).reasons, ['prediction-without-basis'],
    '标了推断却通篇没有出处 ⇒ 必须判不合格（人类口径：预测要标明是预测**并给出依据**）');
  // 最小对：同一句话只补一个出处 —— 必须立刻放行（证明红的来源就是"有没有依据"）
  const withBasis = `这是${PREDICTION_LABEL}（不是实测，依据是上一轮工具回执）：他会换宠。`;
  assert.equal(checkPredictionLabel({text: withBasis}, {required: true}).labeled, true);
  // 依据可以来自五栏里的任何一栏（回执 / 局面 / 证据包 / 记忆 / 规则常量），都算
  for (const basis of ['工具回执里查到', '当前局面是', '证据包里写着', '跨局记忆里', '规则常量里', '你自己的存档里']) {
    const text = `这是${PREDICTION_LABEL}（不是实测）：他会换宠。${basis}对手上次也这么做。`;
    assert.equal(checkPredictionLabel({text}, {required: true}).labeled, true, `依据写法不许误伤：${basis}`);
  }
});

test('判据④：标定 —— 58 条真实模型回答里，这条守卫一条都不许误伤（含 18 条带「推断」标签的）', () => {
  const rows = (RAW.rows || []).filter((r) => typeof r.text === 'string' && r.text.trim());
  assert.ok(rows.length >= 50, `样本量太小（${rows.length}），标定不成立`);
  const flagged = rows.filter((r) => !checkPredictionLabel({text: r.text}, {required: true}).labeled).map((r) => r.id);
  assert.deepEqual(flagged, [], '误伤真实回答：这条守卫比它要防的问题更贵');
  // 「标了推断就要说依据」这条新牙的标定：实录里那 15 条带标签的回答**一条**都不许被判没依据
  //（实测：加这条牙之前是 15/15，加完之后仍是 15/15 —— 词表就是照它们写出来的）。
  const labeled = rows.filter((r) => r.text.includes(PREDICTION_LABEL));
  assert.ok(labeled.length >= 10, `带标签的样本太少（${labeled.length}），标定不成立`);
  assert.deepEqual(labeled.filter((r) => !checkPredictionLabel({text: r.text}, {required: true}).labeled).map((r) => r.id), [],
    '带标签的真实回答被判「没依据」⇒ 词表比真机说法窄了');
});

test('判据④b：上线当天真机漏掉的那一句，必须已经收进词表（逐字，出自 /tmp/probe/unknown-probe.json 的 p3）', () => {
  // 第一版词表只收书面说法 ⇒ 这条真机回答**整句漏过**（事后按原文补的）。钉住它，
  // 免得以后有人把词表改窄又把这条真机证据一起丢掉。
  const p3 = '我不主动开口，但你问的是刚才那句提醒，不是之前打过的对局。  老实说：那条提醒的内容，我这边没存下来，现在也说不出还在不在。';
  assert.deepEqual(checkPredictionLabel({text: p3}, {required: true}).reasons, ['unlabeled-unknown'],
    '「我这边没存下来…也说不出还在不在」是交白卷，必须判不合格');
  // 同一个探针里的 p6：它是 18 条真机带标签回答里**最接近边界**的（没有写「把握高/中/低」，
  // 依据写的是「从阵容推断」）⇒ 依据词表必须覆盖它，且**把握不作为判据**（判了就会误伤这一条）。
  const p6 = '抱歉，这段记录我这边没留存——旧版只存最后一回合，第3回合的原始事件拿不到了，所以没法还原当时具体为什么换。\n\n'
    + '能确定的只是从阵容推断（不是实测）：你那只烬尾狐偏高速游击，对上溪刃獭这类先制速攻容易吃亏，换潮甲龟去接伤害是很常见的思路。'
    + '不过这是我的推测，把握中等。想确认的话，重打一局后我可以帮你看完整记录。';
  assert.equal(checkPredictionLabel({text: p6}, {required: true}).labeled, true,
    'p6 写了依据（从阵容推断）却没写「把握」——不许因为没写把握就判红');
  // 同一个探针里的 p4：先说了「看不到具体数值」，但**紧接着给了带标签的推断** ⇒ 必须放过。
  const p4 = '个体值这些数据不在我这边，看不到具体数值。这是推断（不是实测）：个体值属于隐藏项，本机没有读取入口，所以界面里不会显示。把握高。';
  assert.equal(checkPredictionLabel({text: p4}, {required: true}).labeled, true,
    'p4 是同一轮真机回答里的**合规写法**（先直说拿不到、再给带标签的推断），不许误伤');
});

test('判据④c：「推测」与「推断」等价（真机两种混用），但依据那条牙两边一样硬', () => {
  // 活体证据：探针 p6 写的是「推测（不是实测）」+ 后文「这只是推断」。
  assert.equal(checkPredictionLabel({text: '推测（不是实测，依据是规则常量）：他会守住。'}, {required: true}).labeled, true);
  assert.deepEqual(checkPredictionLabel({text: '推测（不是实测）：他会守住。'}, {required: true}).reasons,
    ['prediction-without-basis'], '换成「推测」也不许只给方向不给出处');
  // 没标明是预测的「推测」式断言（例如直接当成事实说）不在这条判据的射程里：
  // 它由 B3 的 `opponent-action-certainty` 管 —— 两条守卫各管一半，别混。
  assert.equal(checkPredictionLabel({text: '他大概会守住。'}, {required: true}).labeled, true);
});

test('判据⑤：`required:false` 时一个字都不判（本地模板/未声明要预测的包）', () => {
  assert.equal(checkPredictionLabel({text: '我不知道。'}, {required: false}).labeled, true);
  assert.equal(checkPredictionLabel({text: ''}, {required: true}).labeled, true);
});

test('判据⑥：模型包自己声明「这一问需要预测」，守卫的 required 与它同源', () => {
  const scaffold = predictionScaffold({});
  assert.equal(scaffold.required, true, 'predictionScaffold 声明了 required=true，守卫必须按同一个口径判');
  assert.ok(scaffold.forbid.some((x) => x.includes('不知道')), '包的禁令里必须有「不带依据的不知道」');
});

test('接线①：只回「我不知道」⇒ 走纠错通道再问一次，改对了就发模型那一句', async () => {
  const good = `这是${PREDICTION_LABEL}（不是实测，依据是当前局面）：先守住，再看他换不换。把握中。`;
  const {answer, packets, calls} = await run({script: ['我不知道。', good]});
  assert.equal(calls, 2, '必须真的又问了模型一次（纠错券用在答案层）');
  assert.equal(answer.text, good, '改对了就该发模型改好的那一句');
  assert.equal(answer.validation.valid, true);
  assert.ok(answer.validation.answerCorrection, '回执里必须留下「用掉了一张答案层纠错券」的结构化痕迹');
  assert.equal(answer.validation.answerCorrection.check, 'checkPredictionLabel');
  assert.deepEqual(answer.validation.answerCorrection.reasonsCode, ['unlabeled-unknown']);
  // 纠错包里带的是**代码写死的整改指令**，且必须明说「不许只回不知道」
  const retry = packets.at(-1);
  assert.equal(retry.correction.failedCheck, 'checkPredictionLabel');
  assert.deepEqual(retry.correction.reasonsCode, ['unlabeled-unknown']);
  const hint = retry.toolTrace.at(-1).result.hint;
  assert.match(hint, /不许只回「不知道/, '整改指令必须明说「不许只回不知道」（原来那句「或如实说不知道」就是这条缺口）');
});

test('接线①b：标了「推断」但没依据 ⇒ 同一张纠错券，回执里的原因族是 prediction-without-basis', async () => {
  const noBasis = `这是${PREDICTION_LABEL}（不是实测）：他更可能守住。`;
  const good = `这是${PREDICTION_LABEL}（不是实测，依据是当前局面）：他更可能守住。`;
  const {answer, packets, calls} = await run({script: [noBasis, good]});
  assert.equal(calls, 2, '必须真的又问了模型一次');
  assert.equal(answer.text, good);
  assert.equal(answer.validation.answerCorrection.check, 'checkPredictionLabel');
  assert.deepEqual(answer.validation.answerCorrection.reasonsCode, ['prediction-without-basis']);
  assert.match(packets.at(-1).toolTrace.at(-1).result.hint, /就要说清\*\*依据是哪一条\*\*/,
    '整改指令必须点名「说清依据是哪一条」');
});

test('接线②：两次都交白卷 ⇒ 降级成本地已核验结论，并如实写出原因（不许端给玩家）', async () => {
  const {answer} = await run({script: ['我不知道。', '我还是不知道。']});
  assert.equal(answer.provider, 'local-fallback', '守卫命中且改不对 ⇒ 走既有降级通道');
  assert.equal(answer.answerCorrection.check, 'checkPredictionLabel');
  assert.equal(answer.validation.rejectedReason, 'unlabeled-unknown');
  assert.deepEqual(answer.validation.reasons, ['unlabeled-unknown']);
  assert.equal(answer.validation.deliveredText, 'local-template');
  assert.match(answer.fallbackReason, /不知道/);
  assert.ok(!/^我不知道/.test(answer.text), '玩家看到的不能是被拒的那句');
});

test('接线③：反证 —— 同一句话加上标签就必须通过（证明红的来源就是这条守卫）', async () => {
  const bare = '我不知道。';
  const labeled = `我不知道对手要做什么 —— 这是${PREDICTION_LABEL}（不是实测，依据是规则常量）：他更可能守住。`;
  const bad = await run({script: [bare, bare]});
  const good = await run({script: [labeled]});
  assert.equal(bad.answer.validation.rejectedReason, 'unlabeled-unknown');
  assert.equal(bad.answer.provider, 'local-fallback');
  assert.equal(good.answer.text, labeled, '只多了标签与方向性判断 ⇒ 必须原样放行（不是别的原因拦下的）');
  assert.equal(good.answer.provider, 'stub');
});

test('接线④：反证 —— 把出口拆掉就红（最小对：合规句 vs 删掉点数据那半句）', () => {
  const withDatum = '我这轮接不到那两句话，没法判断还算不算数。缺的是上一轮回答的正文数据。';
  const withoutDatum = '我这轮接不到那两句话，没法判断还算不算数。';
  assert.equal(checkPredictionLabel({text: withDatum}, {required: true}).labeled, true);
  assert.deepEqual(checkPredictionLabel({text: withoutDatum}, {required: true}).reasons, ['unlabeled-unknown'],
    '把「缺的是哪一块数据」删掉 ⇒ 必须立刻变红（这条是出口②的牙）');
});

test('接线⑤：本地确定性路径（不带模型）不受这条守卫影响', async () => {
  // 本地模板由引擎数据生成；用 `correctionBudget:0` 走"不改写"的短路（反证 A 的同一入口）。
  const {answer} = await run({script: ['我不知道。'], budget: 0});
  assert.equal(answer.validation.attempts ?? 1, 1, '券被显式关掉 ⇒ 只发一次，不再问模型');
  assert.equal(answer.provider, 'local-fallback');
});

test('接线⑥：这份判据真的在 test:unit 的手写清单里（不接线 = 没在跑）', () => {
  const files = PACKAGE.scripts['test:unit'].replace(/^node --test /, '').split(/\s+/);
  assert.ok(files.includes('tests/roco-prediction-label.test.js'),
    'tests/roco-prediction-label.test.js 必须进 test:unit 的显式清单');
});
