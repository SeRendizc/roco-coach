// **引用可回查**判据（阶段 1.4；人类口径：「答案里的每个事实都能**回指**到知识库条目 / 回执」）。
//
// 为什么需要它：`checkGroundedAnswer` 的引用白名单原来只认 `(?:tactic|ui|rule):` 这一族（战术卡 id），
// 后来又补了 RAG 文档 id 的形状（RC-205）。但**引擎回执**给的出处是另一种形状：
//   · 回执字段 `evidence_ids: ["ev:roco-world-s4-2026-09-10:pets.json#pet_000225"]`
//   · 上面的白名单**看不见 `ev:` 这一族**，而且 `evidence_ids` 是**数组**，连 `"id":"…"` 的提取也抓不到
// ⇒ 于是"引用了真实的引擎出处"与"编了一个不存在的出处"在判据上**无法区分**（两者都不会被检查）。
// 这一组钉四件事：真的引得出、编的必须红、**没发过的也不许引**、以及"这条检查只在 rag 模式生效"这句 scope 是真的。
//
// 用法：`node --test tests/roco-citation-grounding.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {checkGroundedAnswer} from '../src/coach/runtime.js';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-24）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME_SRC = readFileSync(`${ROOT}src/coach/runtime.js`, 'utf8');

/** 一份"本轮真的发出去过"的引擎回执（形状照轨迹里的 `trace[].receipt`）。 */
const receipt = (ids) => ({
  evidence: [],
  toolTrace: [{tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}, result: {pet_id: 'pet_000225', evidence_ids: ids}}],
  textFacts: null,
});
const REAL_EV = 'ev:roco-world-s4-2026-09-10:pets.json#pet_000225';

test('① 引**发出去过**的引擎出处 ⇒ 不算编（这条以前做不到）', () => {
  const answer = {...receipt([REAL_EV]), text: `它的种族值出自 ${REAL_EV}，这一手没问题。`};
  const out = checkGroundedAnswer(answer, {ragCitations: true});
  assert.ok(!out.reasons.includes(`unsupported-citation:${REAL_EV}`),
    `真发过的出处必须被接受，实际：${JSON.stringify(out.reasons)}`);
});

test('② 编一个**不存在**的引擎出处 ⇒ 必须红', () => {
  const fake = 'ev:roco-world-s4-2026-09-10:pets.json#pet_999999';
  const answer = {...receipt([REAL_EV]), text: `它的种族值出自 ${fake}。`};
  const out = checkGroundedAnswer(answer, {ragCitations: true});
  assert.ok(out.reasons.includes(`unsupported-citation:${fake}`),
    `编的出处必须被抓到，实际：${JSON.stringify(out.reasons)}`);
  assert.equal(out.valid, false);
});

test('③ **没发过**的真出处也不许引（"发过才许引"这条不许松）', () => {
  const notDelivered = 'ev:roco-world-s4-2026-09-10:skills.json#skill_000001';
  const answer = {...receipt([REAL_EV]), text: `技能表里有 ${notDelivered}。`};
  const out = checkGroundedAnswer(answer, {ragCitations: true});
  assert.ok(out.reasons.includes(`unsupported-citation:${notDelivered}`),
    '不在本轮回执里的出处，即使形状合法也不许引');
});

test('④ scope 是真的：不开 ragCitations 时 `ev:` 不参与检查（shadow 只多字段、不改行为）', () => {
  const fake = 'ev:x:y.json#z';
  const answer = {...receipt([REAL_EV]), text: `出处是 ${fake}。`};
  const off = checkGroundedAnswer(answer);
  const on = checkGroundedAnswer(answer, {ragCitations: true});
  assert.ok(!off.reasons.some((r) => r.startsWith('unsupported-citation:')),
    '非 rag 模式下不该因为 `ev:` 形状而判红（那是行为改变，shadow 的定义不允许）');
  assert.ok(on.reasons.includes(`unsupported-citation:${fake}`), '开了 rag 引用校验才检查它');
});

test('⑤ 反证：把 `ev:` 从白名单/可引用集合里去掉 ⇒ 上面 ①② 必须翻红（判据不是装饰）', () => {
  // 实现面两层，缺一不可：白名单要能**认出**这种形状，可引用集合要能**收到**回执里的数组。
  assert.match(RUNTIME_SRC, /\\bev:\[A-Za-z0-9_.:-\]\+#/,
    'RAG_CITATION_RE 必须包含 `ev:` 这一族（去掉它 ⇒ ① 会红：真出处被判成"看不见"）');
  assert.match(RUNTIME_SRC, /"evidence_ids"\\s\*:\\s\*\\\[/,
    'delivered 必须从回执的 `evidence_ids` 数组里收 id（去掉它 ⇒ ② 会红：真出处不在可引用集合里）');
});
