// 服务端事实/数字守卫（2026-09-25 补的缺口）——**非浏览器调用方**也必须拿到被守卫筛过的正文。
//
// 为什么需要这个文件（可复算的事实）：
//   · `checkGroundedAnswer`（数字白名单 / 引用 id / 确定性承诺 / 道具名漂移 / 因果取消回执）原来**只**在
//     浏览器层被调用：`src/coach/client.js:34`。服务端 `runCoach` 只跑 `checkReceiptConsistency`
//     （missing 回合被当成事实 / 没模拟的行动说成比较过 / 换补位代价说反）与 360 字长度闸门。
//   · 后果：curl / headless / 脚本 / 将来别的前端打 `/api/coach`，拿到的是**没被数字与引用守卫筛过**
//     的模型正文（`scripts/eval-live-s04.js:353` 的 validation 是那个 runner 自己另算的）。
//   · 修法：在 `runCoach` 里用**同一份** `checkGroundedAnswer` 再判一次，命中就与「回执不一致」走
//     同一条降级路径（换成引擎数据生成的本地结论 + `provider:'local-fallback'` + 如实写 `fallbackReason`），
//     并把结果放进**附加字段** `validation`（不动既有字段语义）。
//
// 本文件的结构：判据本体是**纯函数** `serverGuardProblems(answer, modelText)`，
// 真路由那一跑与「把修复回退掉」的合成反证**共用同一条判据**（反证没命中也算失败）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createCoachServer} from '../src/server/index.js';
import {buildContext, checkGroundedAnswer} from '../src/coach/runtime.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {createGame} from '../src/game/engine.js';

const fixtureKey = 'sk-fixture-only-not-a-real-api-key';

/** 判据本体（纯函数）：服务端回执必须**既被守过、又如实说清交付的是哪一份正文**。
 *
 * 输入：`answer` = `/api/coach` 的回执；`modelText` = 这次模型真正生成的那句话。
 * 输出：问题列表（空 = 通过）。 */
function serverGuardProblems(answer, modelText) {
  const bad = [];
  if (!answer || typeof answer !== 'object') return ['回执不是对象'];
  const v = answer.validation;
  if (!v || typeof v !== 'object') {
    return ['回执里没有 validation —— 非浏览器调用方拿不到「这份正文被哪一层守过」的证据'];
  }
  if (v.checked_by !== 'server') bad.push(`validation.checked_by 必须是 'server'，实际 ${JSON.stringify(v.checked_by)}`);
  if (typeof v.valid !== 'boolean') bad.push(`validation.valid 必须是布尔，实际 ${JSON.stringify(v.valid)}`);
  if (!Array.isArray(v.reasons)) bad.push(`validation.reasons 必须是数组，实际 ${JSON.stringify(v.reasons)}`);
  // ① 模型正文里有未经登记的数字 ⇒ 服务端必须判不合格、必须降级、必须如实写原因。
  if (v.valid !== false) bad.push(`模型正文「${String(modelText).slice(0, 40)}」含未经登记的数字，validation.valid 却是 ${JSON.stringify(v.valid)}`);
  if (v.rejected !== true) bad.push(`validation.rejected 必须是 true，实际 ${JSON.stringify(v.rejected)}`);
  if (v.rejectedReason !== 'ungrounded') bad.push(`validation.rejectedReason 必须是 'ungrounded'，实际 ${JSON.stringify(v.rejectedReason)}`);
  if (!v.reasons.some((r) => String(r).startsWith('unsupported-number'))) {
    bad.push(`validation.reasons 里必须点名 unsupported-number，实际 ${JSON.stringify(v.reasons)}`);
  }
  if (answer.provider !== 'local-fallback') {
    bad.push(`降级路径要和浏览器层一致：provider 必须是 'local-fallback'，实际 ${JSON.stringify(answer.provider)}`);
  }
  if (typeof answer.fallbackReason !== 'string' || !/未经登记/.test(answer.fallbackReason)) {
    bad.push(`必须如实写 fallbackReason（要点名「未经登记」），实际 ${JSON.stringify(answer.fallbackReason)}`);
  }
  if (answer.text === modelText) bad.push('被拒的模型正文被原样发出去了 —— 守卫没有生效');
  if (v.deliveredText !== 'local-template') bad.push(`validation.deliveredText 必须是 'local-template'，实际 ${JSON.stringify(v.deliveredText)}`);
  if (typeof answer.text !== 'string' || !answer.text.trim()) bad.push('降级后的正文是空的');
  return bad;
}

async function setup(t, fetchImpl) {
  const server = createCoachServer({fetchImpl});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '', boot;
  const r = await fetch(base + '/api/bootstrap');
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  boot = await r.json();
  const post = (path, data) => fetch(base + path, {
    method: 'POST',
    headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data),
  });
  const key = await webcrypto.subtle.importKey('spki', Buffer.from(boot.publicKey, 'base64'),
    {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  const encryptedKey = Buffer.from(await webcrypto.subtle.encrypt('RSA-OAEP', key,
    Buffer.from(JSON.stringify({key: fixtureKey, nonce: boot.nonce})))).toString('base64');
  await post('/api/connect', {encryptedKey, model: 'deepseek-flash'});
  return {server, base, post};
}

const chat = () => ({
  message: '这回合怎么打', role: 'auto',
  context: buildContext(createGame(), newProfile(), 'fox'),
  memory: freshMemory(), stateToken: 17, conversation: [],
});

/** 规划器那一问由 `runCoach` 自己发起：据实回 `{"stop":true}`，只让**正文**那一问吐模型答案。 */
const stub = (modelText) => async (url, args) => {
  const body = JSON.parse(args.body);
  const system = String(body.messages?.[0]?.content ?? '');
  const content = system.includes('选择只读工具') ? '{"stop":true}' : modelText;
  return new Response(JSON.stringify({choices: [{message: {content}}], usage: {prompt_tokens: 8, completion_tokens: 2}}), {status: 200});
};

test('/api/coach：模型正文里的**未经登记的数字**由服务端拦下并降级（非浏览器调用方同样被守）', async (t) => {
  const modelText = '这一下打了 999 伤害。';
  const x = await setup(t, stub(modelText));
  const response = await x.post('/api/coach', chat());
  assert.equal(response.status, 200);
  const answer = await response.json();
  const problems = serverGuardProblems(answer, modelText);
  assert.deepEqual(problems, [], problems.join(' | '));
  assert(answer.evidence.length > 0, '降级后的正文仍要带引擎证据');
});

test('反向控制：干净正文必须放行（守卫不是恒假）', async (t) => {
  const modelText = '先稳住这一手，注意对手的补位机会。';
  const x = await setup(t, stub(modelText));
  const answer = await (await x.post('/api/coach', chat())).json();
  assert.equal(answer.validation.checked_by, 'server');
  assert.equal(answer.validation.valid, true, `干净正文被判不合格：${JSON.stringify(answer.validation.reasons)}`);
  assert.equal(answer.validation.rejected, false);
  assert.equal(answer.validation.checkedText, 'model-answer');
  assert.equal(answer.validation.deliveredText, 'model-answer');
  assert.equal(answer.provider, 'deepseek');
  assert.equal(answer.text, modelText);
  assert.equal(answer.fallbackReason, undefined);
});

test('反证（必红）：把修复回退成「只有浏览器守」的形状，同一条判据必须报', () => {
  const modelText = '这一下打了 999 伤害。';
  // 回退形态①：服务端回执里根本没有 validation（修复前的真实形状）
  const preFix = {provider: 'deepseek', text: modelText, evidence: ['减伤 65%']};
  const hitNoField = serverGuardProblems(preFix, modelText);
  assert(hitNoField.length > 0, '缺 validation 的回退形态没被抓住 —— 判据是空的');
  assert(hitNoField.some((x) => x.includes('没有 validation')), hitNoField.join(' | '));
  // 回退形态②：字段在、但守卫被短路（valid 恒 true、没有降级）
  const shortCircuited = {provider: 'deepseek', text: modelText, fallbackReason: undefined,
    validation: {valid: true, checked_by: 'server', checkedText: 'model-answer', deliveredText: 'model-answer',
      rejected: false, rejectedReason: null, reasons: []}};
  const hitShort = serverGuardProblems(shortCircuited, modelText);
  assert(hitShort.length >= 4, `短路形态只命中 ${hitShort.length} 条：${hitShort.join(' | ')}`);
  assert(hitShort.some((x) => x.includes("provider 必须是 'local-fallback'")), hitShort.join(' | '));
  assert(hitShort.some((x) => x.includes('原样发出去')), hitShort.join(' | '));
});

test('数字守卫本身不空：同一份 checkGroundedAnswer 既拦凭空数字、也放行可追溯数字', () => {
  const bad = checkGroundedAnswer({text: '这一下打了 999 伤害。', evidence: ['减伤 65%']});
  assert.equal(bad.valid, false);
  assert(bad.reasons.some((r) => r.startsWith('unsupported-number:999')), JSON.stringify(bad.reasons));
  const good = checkGroundedAnswer({text: '防御：本回合减伤 65%。', evidence: ['减伤 65%']});
  assert.equal(good.valid, true, `可追溯数字被误伤：${JSON.stringify(good.reasons)}`);
  // 不得为了让服务端变绿而放松既有分支：引用 id 那条反向控制也钉在这里
  assert.equal(checkGroundedAnswer({text: '看 tactic:invented', knowledge: []}).valid, false);
});

// ── C5 的三处宽松：1/2/3 免检与中文数字（2026-09-27）────────────────────────────────
test('数字守卫不许有"1/2/3 免检"，中文数字也要进校验', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  // ① 免检通道必须消失（这是最容易被编的三个数字：连击 3 下 / 用了 2 次 / 剩 1 只）
  // ⚠ 断言前先剥掉**纯注释行**：注释里逐字留着那句"原来有 `if(['1','2','3']…)`"（改钉不删），
  // 不剥就会把注释本身当成代码（第一版判据就是这么误报的）。
  const codeOnly = src.split('\n').filter((line) => !/^\s*\//.test(line)).join('\n');
  assert.doesNotMatch(codeOnly, /if\(\['1','2','3'\]\.includes\(raw\)\)continue;/,
    '1/2/3 不许再免检 —— 它们要么在事实集里、要么在规则常量里');
  assert.match(src, /reasons\.push\('unsupported-number:'\+raw\)/, '普通数字仍然走同一条判据');
  // ② 中文数字进同一条判据（只翻紧挨量词/百分号的那些，避免成语被当数字）
  assert.match(src, /const CN_DIGITS=\{一:1,二:2,两:2,三:3/, '中文数字要有映射');
  assert.match(src, /unsupported-number\(中文\):/, '中文数字也要能被判红');
  assert.ok(/const cnNumber=/.test(src) && /个\|只\|次/.test(src),
    '中文数字只翻紧挨量词的那些（不误伤成语）');
});

