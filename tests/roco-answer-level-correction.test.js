// 答案层「一次纠错」的判据（2026-09-25）。
//
// 为什么做这一条：外部实证很硬 —— 没有外部验证信号的自由文本反思会**退化**（8B 模型上加结构化
// 约束反而把准确率从 50.0% 掉到 38.0%，96/100 的首轮诊断退化成"格式不匹配"）。
// 本仓**恰好有外部验证器**（引擎真值 + `checkGroundedAnswer`），所以这里补的是工具层纠错
// （`tests/evals/roco/agent-loop-correction.test.js`）之后剩下的那一半：
//
//   修前：模型正文一旦没过守卫，**没有改正机会** —— `runtime.js` 直接换成 `packet.text`。
//   修后：把守卫判不合格的 `reasons` 做成一条**错误回执**（走工具层同一条通道形状）再问模型
//        **一次**；仍不合格才降级。硬约束一条都不松：
//         ① **同一张纠错券**：工具层用掉了，答案层就不许再改写（全局只有一张）；
//         ② **干净路径逐字节不变**（下面钉了 sha256 与键表）；
//         ③ **绝不做自由文本反思**：留痕只留 `{failedCheck,tool,argsFingerprint,reasonsCode,matchId}`；
//         ④ **"重复即放手"**：同一会话同一个 `reasonsCode` 已经试过一次还没改对 ⇒ 这一轮不再试，
//            并在玩家话里如实说"这条我试过一次没改对，这轮给你已核验的结论"（照 activity.js 的降级纪律）。
//
// 反证（四条，**都真跑过**：把实现改坏 → 跑本文件 → 恢复；红在哪一条断言上见下面逐条）：
//   A 把答案层纠错预算短路（`correctionBudget` 默认 1 → 0，≡ 回到改前）⇒ ① 红在
//     「玩家必须看到改好的那一句」（同时 ①b ② ④ ⑦ ⑧ 一起红）；
//   B 去掉"只可能 0/1"的夹取 ⇒ ⑥ 红在「无限预算必须被夹成 1」（99 !== 1）；
//     更狠的一版（改写谓词永远放行）⇒ ② 红在「券已经用掉 ⇒ 答案层不许再问一次」（2 !== 1）、
//     ⑤ 红在「短路之后没有第二次生成」、⑦ 红在「同一个原因试过一次还没改对 ⇒ 这一轮不再试」；
//   C 干净路径多一个字段（answer 顶层 / validation 里）或改一个既有值 ⇒ ③ 分别红在
//     「键表必须与改前一致」与「逐字节回归钉」；
//   D 账本里多一个自由文本字段（`modelText=模型原文`）⇒ ④ 红在「回执里不许出现模型被拒的原文」；
//     把结构化字段换成原文（`reasonsCode` 塞进 reasons 原文）⇒ ① ⑨ 一起红在「只写原因族」那两条。
//
// 边界（如实写）：这套判据用的是**合成轨迹**（假 provider + 固定回执），没有真调模型跑端到端。

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildContext, checkGroundedAnswer, checkReceiptConsistency, runCoach,
  answerCorrectionBudget, argsFingerprintOf, buildAnswerCorrection, rejectionCodes,
  sessionReasonCount, predictionScaffold, PREDICTION_LABEL} from '../src/coach/runtime.js';
import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** 一句**真的**会被数字守卫拦下的话（下面有断言证明拦截确实来自守卫，而不是别的原因）。 */
const UNGROUNDED = '这一下打了 999 伤害。';
/** 复述本地已核验结论里的一句（所有数字都能在证据包里查到）——"改对了"的合成轨迹。 */
const GROUNDED = '这一回合优先考虑「火花」。';
const MESSAGE = '这回合怎么打';

/** 一份**不需要任何外部服务**的上下文（营地/对战共用；`provider` 是假的，所以不会联网）。 */
const context = () => buildContext(createGame(445), newProfile(), 'fox');

/**
 * 按脚本依次回话的 provider：`plan` 一律 `{stop:true}`（工具循环不进第二枪，只判答案层），
 * `generate` 每次回一句脚本里的话（脚本用光后重复最后一句）。
 * 返回包里带上 `packets`（模型每次**看到**的包）与 `calls`（生成了几次）——
 * "纠错真的又问了模型一次"与"没有自由文本反思进了包"都靠这两个探针。
 */
async function run({script = [GROUNDED], budget, memory = freshMemory(), message = MESSAGE} = {}) {
  const packets = [];
  let calls = 0;
  const provider = {
    name: 'stub',
    plan: async () => ({stop: true}),
    async generate(packet) {
      packets.push(packet);
      const line = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return line;
    },
  };
  const options = {message, context: context(), memory, provider};
  if (budget !== undefined) options.correctionBudget = budget;
  const answer = await runCoach(options);
  return {answer, packets, calls};
}
/** 结构化 diff：判据 D 用它证明"纠正路径新加的东西只有这些"，而不是靠人眼扫一遍。 */
function structuredDiff(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after[key])) changes[key] = after[key];
  }
  return changes;
}
/** 工具名 → 玩家话（判据只关心"这句话在不在"，不抄 activity.js 的词表）。 */
const says = (answer, fragment) => String(answer.activityLine ?? '').includes(fragment);

test('① 正向：模型第一次漏引用（ungrounded）、第二次补上 ⇒ 玩家看到的是**改好的那句**，回执说 corrected:true', async () => {
  // 先证明这条合成轨迹的两句话**真的**分别不合格/合格（否则下面全是空判据）：
  assert.equal(checkGroundedAnswer({text: UNGROUNDED, evidence: []}).valid, false, '第一句本来就必须被守卫拦下');
  assert.equal(checkGroundedAnswer({text: GROUNDED, evidence: []}).valid, true, '第二句本来就必须放行');
  const {answer, packets, calls} = await run({script: [UNGROUNDED, GROUNDED]});
  // 玩家看到的是**第二次**那句，不是本地模板，也不是第一次那句
  assert.equal(answer.text, GROUNDED, '玩家必须看到改好的那一句');
  assert.notEqual(answer.text, UNGROUNDED, '没过守卫的那句不许发出去');
  assert.equal(answer.provider, 'stub', '改对了就不是降级：provider 照旧是模型');
  assert.equal(answer.fallbackReason, undefined, '改对了就没有降级原因');
  assert.equal(calls, 2, '纠错 = 再问模型**一次**');
  assert.equal(answer.validation.valid, true);
  assert.equal(answer.validation.attempts, 2, '回执要如实记下试了两次');
  // 错误回执真的进了 trace，而且带 `corrected:true`（既有记账约定）
  const err = answer.toolTrace.find((item) => item?.id === 'answer:err:1');
  assert.ok(err, '答案层错误回执必须进 trace');
  assert.equal(err.corrected, true);
  assert.equal(err.chosenBy, 'correction', '要能被既有翻译层认成"纠错券换来的"');
  assert.equal(err.failedCheck, 'checkGroundedAnswer', '回执要回指是哪一道核对判的');
  assert.deepEqual(err.reasonsCode, ['unsupported-number'], '回执只写**原因族**，不写模型正文');
  assert.equal(typeof err.argsFingerprint, 'string');
  assert.match(err.argsFingerprint, /^[0-9a-f]{8}$/,
    'argsFingerprint 是 8 位短号（纯 JS FNV-1a：本文件在浏览器模块图里，不许 import node:crypto）');
  assert.equal(err.argsFingerprint, argsFingerprintOf(null, null), '没有工具回执时也要给一个确定值');
  assert.ok(!JSON.stringify(err).includes('pet_'), '指纹里不许出现参数原文');
  // 玩家话：这一轮"改写过一次"，且**不是**说成工具用法
  assert.equal(answer.activity.answerCorrected, true);
  assert.ok(says(answer, '核对之后改写过一次'), `玩家话要说清改写过一次：${answer.activityLine}`);
  assert.ok(!says(answer, '中途改过一次工具用法'), '答案层纠错不许说成工具层纠错（那是另一件事）');
  // 模型第二次**真的看见了**那条错误回执与结构化更正记录（不是我们事后补的装饰）
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[1].toolTrace.map((item) => item.id), ['answer:err:1']);
  assert.deepEqual(packets[1].correction,
    {failedCheck: 'checkGroundedAnswer', tool: null, argsFingerprint: err.argsFingerprint,
      reasonsCode: ['unsupported-number'], matchId: null});
  assert.ok(!JSON.stringify(packets[1].correction).includes(UNGROUNDED), '结构化更正记录里不许回显模型原文');
  assert.equal(packets[1].toolCorrections, 1, '同一张券在答案层用掉了，要如实标出来');
});

test('①b 第二次仍不合格 ⇒ 降级为本地已核验结论，并如实说"改写一次后还是没过"（且只试一次）', async () => {
  const {answer, packets, calls} = await run({script: [UNGROUNDED]});
  assert.equal(answer.provider, 'local-fallback');
  assert.match(String(answer.fallbackReason), /未经登记/);
  assert.equal(answer.text, packets[0].text, '降级后发的是本地已核验结论');
  assert.equal(calls, 2, '第二次也错就收手，不再问第三次');
  assert.equal(answer.validation.attempts, 2);
  assert.equal(answer.validation.rejected, true);
  assert.equal(answer.receiptConsistency.checkedText, 'local-template');
  assert.ok(says(answer, '核对之后改写过一次'));
  assert.ok(says(answer, '改写一次后还是没过'), `降级说明要连着这次尝试一起说：${answer.activityLine}`);
});

test('② 共用同一张券：工具层用掉了，答案层就不再改写（`toolCorrections` 是唯一的账）', async () => {
  // 对照组：没有工具层消耗时，答案层确实会改写一次。
  const control = await run({script: [UNGROUNDED, GROUNDED]});
  assert.equal(control.calls, 2);
  assert.equal(control.answer.answerCorrection.kind, 'answer-correction');
  // 真的让工具层把券花掉：这份最小上下文里 `read_state` **执行会失败**（没有 player ⇒ 算不出合法行动）。
  // 「详看第 2 回合」让政策自己先打一枪 `read_evidence`（本局没有回合 ⇒ 缺参回执，不是纠错），
  // 之后规划器这一枪 `read_state` 抛错 ⇒ 工具层用掉唯一那张券（`tool:err:1`）。
  const planScript = [{tool: 'read_state', args: {}}, {tool: 'read_match', args: {offset: 0, limit: 1}}, {stop: true}];
  let step = 0;
  const seen = [];
  const answer = await runCoach({
    message: '详看第 2 回合', context: {mode: 'training', battle: {turn: 1, result: null, phase: 'battle'}},
    memory: freshMemory(),
    provider: {
      name: 'stub',
      plan: async () => planScript[step++] ?? {stop: true},
      async generate(packet) { seen.push(packet); return UNGROUNDED; },
    },
  });
  const toolErr = answer.toolTrace.find((item) => item?.id === 'tool:err:1');
  assert.ok(toolErr, '工具层的错误回执必须先真的产生（否则这一条测的是别的东西）');
  assert.equal(toolErr.chosenBy, 'correction');
  assert.equal(toolErr.result.error, 'tool-failed');
  assert.equal(answer.toolCorrections, 1, '工具层用掉了唯一那张券');
  assert.equal(seen.length, 1, '券已经用掉 ⇒ 答案层**不许**再问一次');
  assert.equal(answer.toolTrace.some((item) => String(item?.id).startsWith('answer:err:')), false,
    '没有券就不许产生答案层错误回执');
  assert.equal(answer.text, seen[0].text, '降级成引擎结论（这一次模型那句没过守卫）');
  assert.equal(answer.activity.corrected, true, '工具层那次纠错照旧要说给玩家听');
  assert.equal(answer.activity.answerCorrected, false);
  assert.equal(answer.validation.skippedReason, '模型回答里有未经登记的数字或引用，显示已核验的本局分析');
});

test('③ 干净路径（一次就过）与"回到改前"逐字节相同：sha256 + 键表都钉住（回归钉）', async () => {
  const {answer, calls} = await run({script: [GROUNDED]});
  assert.equal(calls, 1, '一次就过就不许再问');
  // 这条钉的是一份**真实的**"改前回执长什么样"：`correctionBudget:0`（预算短路）走的就是改前那条分支。
  const before = await run({script: [GROUNDED], budget: 0});
  assert.equal(before.answer.text, answer.text, '干净路径的正文一个字都不许变');
  for (const field of ['toolTrace', 'agentStop', 'toolPolicy', 'validation', 'receiptConsistency',
    'activityLine', 'route', 'provider', 'evidence', 'method', 'actions', 'knowledge']) {
    assert.equal(JSON.stringify(answer[field]), JSON.stringify(before.answer[field]),
      `${field} 在"回到改前"之后必须逐字节相同`);
  }
  // 唯一允许的差异是那两个显式登记的记账字段：`activity.answerCorrected` 与包里的 `correction`。
  assert.equal(JSON.stringify({...answer.activity, answerCorrected: false}),
    JSON.stringify(before.answer.activity), 'activity 里只许多出 answerCorrected 这一个登记字段');
  assert.equal(Object.hasOwn(answer, 'correction'), false, '没有改写就不许有更正记录');
  assert.equal(Object.hasOwn(before.answer, 'correction'), false);
  // 键表：纠正路径新加的字段（answerCorrection / attempts / correction / toolCorrections）一个都不许出现。
  assert.deepEqual(Object.keys(answer).sort(), [
    'actions', 'activity', 'activityLine', 'agentStop', 'conversation', 'evidence', 'fallbackReason',
    'interfaceContext', 'knowledge', 'latestEvents', 'localOnly', 'memory', 'method', 'playerMessage',
    'provider', 'publicState', 'receiptConsistency', 'route', 'taskState', 'text', 'toolPolicy',
    'toolTrace', 'validation', 'verified',
  ], '干净路径的键表必须与改前一致（多一个键就是行为变了）');
  const shape = JSON.stringify({
    text: answer.text, provider: answer.provider, route: answer.route, verified: answer.verified,
    localOnly: answer.localOnly, receiptConsistency: answer.receiptConsistency, validation: answer.validation,
    fallbackReason: answer.fallbackReason ?? null, activityLine: answer.activityLine, activity: answer.activity,
    agentStop: answer.agentStop, toolPolicy: answer.toolPolicy, toolTrace: answer.toolTrace,
    keys: Object.keys(answer).sort(),
  });
  assert.equal(shape, '{"text":"这一回合优先考虑「火花」。","provider":"stub","route":"strategist","verified":false,'
    + '"localOnly":false,"receiptConsistency":{"consistent":true,"reasons":[],"scope":"Receipt-consistency guard: '
    + 'missing evidence, un-simulated comparison, switch/replacement cost. Narrow by design, not a proof of full '
    + 'correctness","checkedText":"model-answer"},"validation":{"valid":true,"checked_by":"server",'
    + '"checkedText":"model-answer","deliveredText":"model-answer","rejected":false,"rejectedReason":null,"reasons":[],'
    + '"scope":"Narrow numeric/citation/certainty guard; not a proof of all natural language correctness"},'
    + '"fallbackReason":null,"activityLine":"依据：场上战况","activity":{"words":[],"sources":["场上战况"],'
    + '"corrected":false,"answerCorrected":false,"fallback":false,"fallbackReason":null,"steps":0,"fallbackNote":null},'
    + '"agentStop":"policy-no-tool","toolPolicy":{"need":null,"reason":"state-in-packet"},"toolTrace":[],'
    + '"keys":["actions","activity","activityLine","agentStop","conversation","evidence","fallbackReason",'
    + '"interfaceContext","knowledge","latestEvents","localOnly","memory","method","playerMessage","provider",'
    + '"publicState","receiptConsistency","route","taskState","text","toolPolicy","toolTrace","validation","verified"]}',
    '干净路径的逐字节回归钉（改前/改后同一段脚本必须得到同一串）');
  assert.equal(sha256(shape), 'ded3257c227f1db21579e8496b341bc0c491b27bcee919662c2ca486fe5562df',
    '干净路径的 sha256：与上面那串逐字节对照，任何一个字节变了都会红');
  assert.equal(Object.hasOwn(answer, 'answerCorrection'), false, '没改写就不许多出记账字段');
  assert.equal(Object.hasOwn(answer.validation, 'attempts'), false, '一次就过也不许写 attempts');
  assert.equal(Object.hasOwn(answer.memory, 'correctionLedger'), false, '没改写就不许写会话账本');
});

test('③b 反证 C 的探针本身能红：往干净路径的回执里塞一个字段，sha256 必须变', () => {
  const clean = '干净路径';
  const probe = (extra) => sha256(JSON.stringify({text: clean, ...extra}));
  assert.notEqual(probe({}), probe({answerCorrection: null}), '探测器必须对"多一个字段"敏感');
  assert.equal(probe({}), probe({}), '同一份输入必须稳定（否则上面的敏感是偶然）');
});

test('④（反证 D 的探针）纠正路径变动的字段**只有**这八个，且没有一个是自由文本反思', async () => {
  const clean = await run({script: [GROUNDED]});
  const corrected = await run({script: [UNGROUNDED, GROUNDED]});
  // 变动的键逐个点名（多一个键都会红）：正文、回执记账、玩家话、记忆（会话账本）。
  // `receiptConsistency` 不在里面 —— 一次就过与改对之后，它本身是逐字节相同的。
  const changed = Object.keys(structuredDiff(clean.answer, corrected.answer)).sort();
  assert.deepEqual(changed,
    ['activity', 'activityLine', 'answerCorrection', 'correction', 'memory', 'toolCorrections', 'toolTrace', 'validation'],
    '纠正路径不许顺手改别的字段');
  // 顶层**新增**的键只有这三个（都是显式登记的记账/通道字段，没有一个是自由文本反思）：
  assert.deepEqual(Object.keys(corrected.answer).filter((key) => !Object.hasOwn(clean.answer, key)).sort(),
    ['answerCorrection', 'correction', 'toolCorrections'],
    '纠正路径新增的顶层键必须逐个登记（多一个就是契约变了）');
  // 模型原文一个字都不许进回执/记忆的记账字段（自由文本反思的入口就是"把模型的话存下来复读"）
  const receiptText = JSON.stringify({
    answerCorrection: corrected.answer.answerCorrection, activity: corrected.answer.activity,
    validation: corrected.answer.validation, receiptConsistency: corrected.answer.receiptConsistency,
    toolTrace: corrected.answer.toolTrace, ledger: corrected.answer.memory.correctionLedger,
  });
  assert.ok(!receiptText.includes(UNGROUNDED), '回执里不许出现模型被拒的原文');
  assert.ok(!receiptText.includes('999'), '回执里连原句里的数字都不许带（只留原因族）');
  assert.ok(!receiptText.includes(GROUNDED), '回执里也不必复读改好后的原文（正文在 text 里）');
  // 记忆里的账本：**只有**结构化字段，`reflection` 一律是 null（本通道不做自由文本反思）
  assert.deepEqual(corrected.answer.memory.correctionLedger, [{
    kind: 'answer-correction', check: 'checkGroundedAnswer', reasonsCode: ['unsupported-number'],
    usage: 'answer-generated', reflection: null, turn: 1, source: 'coach-guard',
  }], '账本必须逐字段钉住 —— 多一个字（比如模型原文）都会红');
  assert.deepEqual(clean.answer.memory.correctionLedger, undefined, '干净路径连账本都不写');
  // 探针能红：把账本里任何一个字段换成模型原文 ⇒ 上面那条 deepEqual 与"不含原文"两条都会失败
  const mutated = [{...corrected.answer.memory.correctionLedger[0], reflection: UNGROUNDED}];
  assert.notDeepEqual(mutated, corrected.answer.memory.correctionLedger, '探测器必须能红（reflection 装原文就得失败）');
  assert.ok(JSON.stringify(mutated).includes(UNGROUNDED), '同一个探针确实把原文带进去了');
});

test('⑤（反证 A）预算短路（`correctionBudget:0` ≡ 回到改前）⇒ 正向那条必须红', async () => {
  const {answer, calls, packets} = await run({script: [UNGROUNDED, GROUNDED], budget: 0});
  assert.equal(calls, 1, '短路之后**没有**第二次生成 —— 这正是改前的形状');
  assert.equal(answer.text, packets[0].text, '改前：直接降级成本地结论');
  assert.notEqual(answer.text, GROUNDED, '改前拿不到"改好的那句" ⇒ 正向断言必红');
  assert.equal(answer.provider, 'local-fallback');
  assert.equal(Object.hasOwn(answer, 'answerCorrection'), false);
  assert.equal(answer.toolTrace.some((item) => String(item?.id).startsWith('answer:err:')), false);
  assert.equal(answer.validation.skippedReason, '模型回答里有未经登记的数字或引用，显示已核验的本局分析',
    '券不在时要如实说清"没有改写"，而不是默默跳过');
  assert.ok(!says(answer, '核对之后改写过一次'), '没改写就不许说改写过');
});

test('⑥（反证 B）预算改成无限也不许重试第二次：全局只有一张券', async () => {
  const {answer, calls, packets} = await run({script: [UNGROUNDED], budget: 99});
  assert.equal(calls, 2, '第二次也错 ⇒ 收手；不许出现第三次生成（无限预算必须被夹成 1）');
  assert.equal(packets.length, 2);
  assert.equal(answer.text, packets[0].text, '仍然降级成本地已核验结论');
  assert.equal(answer.validation.attempts, 2);
  // 纯函数那一层也钉住：预算怎么给都只可能是 0 或 1；工具层用过就恒为 0。
  assert.equal(answerCorrectionBudget({correctionBudget: 1}), 1);
  assert.equal(answerCorrectionBudget({correctionBudget: 0}), 0);
  assert.equal(answerCorrectionBudget({correctionBudget: 99}), 1, '无限预算必须被夹成 1');
  assert.equal(answerCorrectionBudget({correctionBudget: 99, toolCorrections: 1}), 0, '工具层用过就没有券');
  assert.equal(answerCorrectionBudget({correctionBudget: Infinity}), 1, 'Infinity 也要夹成 1');
});

test('⑦ "重复即放手"：同一会话同一个 reasonsCode 试过一次没改对 ⇒ 这一轮不再试，并如实说给玩家', async () => {
  const first = await run({script: [UNGROUNDED]});
  assert.equal(first.calls, 2, '第一轮：试一次（生成 2 次）');
  assert.equal(first.answer.memory.correctionLedger.length, 1);
  // 第二轮：**同一份记忆**（= 同一次会话），同一个原因族
  const second = await run({script: [UNGROUNDED], memory: first.answer.memory});
  assert.equal(second.calls, 1, '同一个原因试过一次还没改对 ⇒ 这一轮不再试');
  assert.equal(second.answer.toolTrace.some((item) => String(item?.id).startsWith('answer:err:')), false);
  assert.equal(second.answer.provider, 'local-fallback');
  assert.equal(second.answer.validation.answerCorrectionSuppressed.usage, 'answer-suppressed');
  assert.equal(second.answer.validation.answerCorrectionSuppressed.reasonsCode[0], 'unsupported-number');
  assert.ok(says(second.answer, '这条我试过一次没改对，这轮给你已核验的结论'),
    `必须如实说出来：${second.answer.activityLine}`);
  assert.ok(says(second.answer, '已经换成引擎自己的结论'), '降级原因照旧要说');
  // 账本只增结构化字段：第二轮多了一条 `answer-suppressed`，`reflection` 仍是 null
  assert.deepEqual(second.answer.memory.correctionLedger.map((row) => row.usage),
    ['answer-generated', 'answer-suppressed']);
  assert.ok(second.answer.memory.correctionLedger.every((row) => row.reflection === null));
  // 纯函数那一层：账本读得回来（同一条会话）
  assert.equal(sessionReasonCount(second.answer.memory, 'unsupported-number'), 2);
  assert.equal(sessionReasonCount(second.answer.memory, 'unsupported-number:12345'), 2, '族名相同就算同一个原因');
  assert.equal(sessionReasonCount(second.answer.memory, 'opponent-action-certainty'), 0, '别的族不受影响');
  assert.equal(sessionReasonCount(freshMemory(), 'unsupported-number'), 0, '没有账本时恒为 0（老调用方行为不变）');
});

test('⑧ 回执一致性那一族走同一条通道（不是只认数字守卫）', async () => {
  // 合成一条**与回执对不上**的正文：回执说这一回合没有记录，正文却把它当事实讲。
  // 这句要**不带数字**（否则会先被数字守卫抓走，测的就不是这一族了）。
  const ctx = {mode: 'training', battle: {turn: 1, result: null, phase: 'battle'}};
  const receipts = [{id: 'tool:1', tool: 'read_evidence', args: {turn: 2}, result: {missing: true, turn: 2}}];
  const bad = '第 2 回合你的烬尾狐使用火花。';
  const good = '第 2 回合的原始记录我这边没有。';
  assert.equal(checkReceiptConsistency({text: bad, toolTrace: receipts}).consistent, false, '这句本来就必须被判不一致');
  assert.equal(checkReceiptConsistency({text: good, toolTrace: receipts}).consistent, true, '改好的那句必须放行');
  assert.equal(checkGroundedAnswer({text: bad, toolTrace: receipts, evidence: []}).valid, true,
    '这一族不该由数字守卫抓（否则测的是别的东西）');
  const seen = [];
  let step = 0;
  // 政策自己先打一枪 `read_evidence`（本局没有已结算回合 ⇒ 回执写"没有记录"，且**不**吃纠错券）；
  // 规划器紧接着收口（`stop:true`），于是券还在 —— 这一条要验的正是"另一族也走同一条通道"。
  const planScript = [{stop: true}];
  const answer = await runCoach({
    message: '详看第 2 回合', context: ctx, memory: freshMemory(),
    provider: {
      name: 'stub',
      plan: async () => planScript[step++] ?? {stop: true},
      async generate(packet) {
        seen.push({text: packet.text, receipts: packet.toolTrace, correction: packet.correction});
        return seen.length === 1 ? bad : good;
      },
    },
  });
  assert.equal(seen.length, 2, '这一族也要再问一次');
  assert.equal(seen[0].correction, undefined, '第一次生成时还没有更正记录');
  assert.equal(seen[0].receipts[0].result.missing, true, '第一次生成时收到的回执里就写着"没有记录"');
  assert.equal(seen[0].receipts.length, 1, '这一轮只有那一条"没有记录"的回执（没有别的纠错券被花掉）');
  assert.ok(seen[1].correction, '第二次生成必须带着结构化更正记录');
  assert.equal(seen[1].correction.failedCheck, 'checkReceiptConsistency');
  assert.equal(seen[1].correction.tool, 'read_evidence', '要回指是哪条回执引发的（工具名 + 参数短号）');
  assert.deepEqual(seen[1].correction.reasonsCode, ['claim-on-missing-evidence']);
  assert.equal(answer.text, good, '玩家看到改好的那句');
  assert.equal(answer.validation.rejected, false);
  assert.ok(says(answer, '核对之后改写过一次'));
  // 反证（同一条通道的"必红"形态）：守卫自己先判错，整条链就没意义
  assert.notEqual(checkReceiptConsistency({text: bad, toolTrace: receipts}).consistent,
    checkReceiptConsistency({text: good, toolTrace: receipts}).consistent,
    '两句话在守卫眼里必须一个不合格、一个合格');
});

test('⑨ 纯函数形状：错误回执与更正记录只带结构化字段（没有"让模型写反思"的入口）', () => {
  const built = buildAnswerCorrection({
    check: 'checkGroundedAnswer', reasons: ['unsupported-number:999', 'opponent-action-certainty'],
    tool: 'read_state', toolArgs: {turn: 3}, matchId: 'match-a', corrections: 0,
  });
  assert.deepEqual(Object.keys(built.correction).sort(),
    ['argsFingerprint', 'failedCheck', 'matchId', 'reasonsCode', 'tool']);
  assert.deepEqual(built.correction.reasonsCode, ['unsupported-number', 'opponent-action-certainty']);
  assert.equal(built.correction.tool, 'read_state');
  assert.equal(built.receipt.id, 'answer:err:1');
  assert.equal(built.receipt.chosenBy, 'correction');
  assert.equal(built.receipt.corrected, true);
  assert.equal(built.receipt.matchId, 'match-a');
  assert.ok(JSON.stringify(built.receipt.result.hint).includes('对手的下一步只能写成可能性'), '提示按错误族写死');
  assert.ok(!JSON.stringify(built).includes('999'), '提示里不许回显原因后缀（那里可能带模型原文片段）');
  // 归一化：族名去重、去空、带上限
  assert.deepEqual(rejectionCodes(['unsupported-number:999', 'unsupported-number:120', 'x:1', '', null]),
    ['unsupported-number', 'x']);
  assert.deepEqual(rejectionCodes(Array.from({length: 9}, (_, i) => `family-${i}:1`)).length, 4, '原因族最多 4 条');
  assert.deepEqual(rejectionCodes(undefined), [], '没有原因也不许抛');
  // argsFingerprint：同参数同值、不同参数不同值（纯 JS FNV-1a，不许 node:crypto）
  assert.equal(argsFingerprintOf('read_state', {turn: 3}), argsFingerprintOf('read_state', {turn: 3}), '同参数必须同值');
  assert.notEqual(argsFingerprintOf('read_state', {turn: 3}), argsFingerprintOf('read_state', {turn: 4}), '不同参数必须不同值');
  assert.notEqual(argsFingerprintOf('read_state', {}), argsFingerprintOf('read_match', {}), '不同工具必须不同值');
  assert.equal(argsFingerprintOf(null, null), argsFingerprintOf(undefined, undefined), '没工具时也给一个确定值');
});

// ── ⑨ 预测脚手架（人类 2026-09-25：「不要说不知道！预测就说预测」）────────────────────
//
// 旧口径是系统提示里那句「未支持的信息请说明不足」——模型照办交白卷，而它手里其实有
// 属性相性 / 速度档 / 能耗算术 / 角色定位 / 版本环境先验这些**能推断的东西**。
// 现在：提示词给规则（`PREDICTION_POLICY`），包里给「这一问现在手里有什么可以拿来推断」
// （`packet.prediction`）。红线不动：数字只能引回执或规则常量。
test('⑨ 预测脚手架：模型路线拿到「不许只说不知道」的规则与可用依据；数字红线仍在禁止项里', async () => {
  const {packets} = await run({script: [GROUNDED]});
  const packet = packets.at(-1);
  assert.ok(packet.prediction, '模型路线必须挂预测脚手架');
  assert.equal(packet.prediction.required, true);
  assert.equal(packet.prediction.label, PREDICTION_LABEL);
  assert.match(packet.prediction.rule, /不许只回答/);
  assert.match(packet.prediction.rule, /不是实测/);
  assert.match(packet.prediction.rule, /把握/);
  assert.ok(Array.isArray(packet.prediction.basis) && packet.prediction.basis.length >= 1,
    '必须说清这一问能拿什么推断（空表就等于没给依据）');
  assert.ok(packet.prediction.forbid.some((row) => row.includes('不知道')), '禁止项必须点名"不带依据的不知道"');
  assert.ok(packet.prediction.forbid.some((row) => /伤害|倍率|概率|胜率/.test(row)),
    '禁止项必须保住数字红线（自己算的数一律不许）');
  // 构造两类输入，脚手架的依据表必须**跟着变**（不是一句恒定的套话）
  const withReceipts = predictionScaffold({toolTrace: [{result: {ok: true}}], battle: {id: 'x'}, evidence: ['e']});
  const bare = predictionScaffold({});
  // 2026-09-27（审计 ②，**改钉不删**）：依据栏的说法从内部叫法换成玩家也读得懂的说法
  //（「工具回执」→「已经查到的记录」、「规则常量」→「规则表」）。判据的意思没变：
  // ① 有回执时依据里必须写"查过"；② 没有回执时依据只剩规则表那一栏；③ 两处必须**跟着输入变**。
  assert.ok(withReceipts.basis.some((row) => row.includes('已经查到的记录')), '有回执时依据里必须写查到过');
  assert.ok(bare.basis.some((row) => row.includes('规则表')), '没有回执时依据只剩规则表');
  assert.ok(!bare.basis.some((row) => row.includes('已经查到的记录')), '没有回执时不许写"查到了"');
  assert.match(withReceipts.numbers_from, /已查到的记录/);
  assert.match(bare.numbers_from, /规则表/);
  for (const row of [...withReceipts.basis, withReceipts.numbers_from, bare.numbers_from]) {
   assert.doesNotMatch(row, /回执|常量/, `模型包里的说法也要说人话（模型会照抄进回答）：${row}`);
  }
  // 反证方向一：脚手架只给**模型看的副本**（挂到 packet 上会顺手改掉答案对象的键表 ——
  // 那个形状被 ③ 的回归钉逐字节钉着）
  const src = readFileSync(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  // 2026-09-26 改钉（**只收紧，不放松**）：`modelPacket` 多了第二个参数 `{message}`。
  // 原因是一条真缺陷（子代理核实 + 真机实测）：本地 4B 那一路只拿到 `packet.text` 的
  // 3–25 字引擎草稿，既没有玩家原话也没有输出要求 ⇒ 冷启 5135 ms 后回「您似乎只输入了我在。」
  // ⇒ 把玩家原话随包交给模型层。原来的两条断言（两次生成都走 modelPacket、且形状是
  // 「原包 + prediction」）**一条都没删**，只是把 `packet` 收紧成 `packet,{message}`。
  assert.match(src, /provider\.generate\(modelPacket\(packet,\{message\}\)\)/,
    '两次生成都必须走 modelPacket()（只给模型看的副本），并带上玩家原话');
  assert.match(src, /export function modelPacket\(packet,\{message=null\}=\{\}\)\{/,
    'modelPacket 必须是「原包 + prediction（+ 玩家原话）」这一种形状');
  assert.match(src, /prediction:predictionScaffold\(packet\)\};/,
    'prediction 脚手架必须还在（改钉时不许顺手丢了它）');
  // 反证方向二：系统提示必须**真的**用上那条策略
  const server = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(server, /'\+PREDICTION_POLICY\+'/, '系统提示必须插值 PREDICTION_POLICY');
  const {PREDICTION_POLICY} = await import('../src/server/index.js');
  assert.doesNotMatch(PREDICTION_POLICY, /说明不足/, '策略正文里不许再出现旧口径');
  assert.match(PREDICTION_POLICY, /不知道|查不到/, '策略必须点名"不知道/查不到"这种交白卷');
  assert.match(PREDICTION_POLICY, /回执或规则常量/, '策略必须写清数字从哪来（数字红线）');
  // 旧口径的原文只许留在注释里（改钉不删）：把纯注释行去掉之后，源码里不许再有那句话
  const codeOnly = server.split('\n').filter((line) => {
    const t = line.trim();
    return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
  }).join('\n');
  assert.doesNotMatch(codeOnly, /未支持的信息请说明不足/, '旧的"说明不足"口径必须已被替换（原文留在注释里）');
});
