// 官方「斯嘉丽」公开 Bad Case 同族：**属性等级词**必须与证据一致（2026-10-17）。
//
// 官方 2026-08-15 采访里那个错误的本质是「有依据，但事实错」：
// AI 从资料里读到了电系/翼/水的相性，却把「克制」与「强力克制」当近义词 ——
// 电系打翠顶夫人（翼+水）实际是 **3×（强力克制）**，说成「2 倍」就是错。
//
// 为什么原来拦不住（读码 + 实测）：
//   ① `checkGroundedAnswer` 的数字校验只认「数字是否在事实集/规则常量里」，
//      而 `2`/`3` 是规则常量，所以「2 倍」和「3 倍」都过 —— **数值有出处 ≠ 语义正确**；
//   ② 中文数字正则只翻「紧挨量词（个/只/次/回合/层…）」的数字，量词表里没有「倍」；
//   ③ 「强力克制」这类等级词本身没有数字，守卫完全看不见。
//
// 本组判据只做**窄规则**（不假装能判所有语义）：
//   正文谈属性相性（克制/抵抗/相性/属性/「X系」）时，声称的倍率必须能在证据里找到；
//   「强力克制」对应 3；旧的「双弱 ×4」一律判退役口径（官方/上游/游戏数据三处都是 3）。
//
// 用法：node --test tests/roco-scarlett-tier-grounding.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {checkGroundedAnswer} from '../src/coach/runtime.js';

/** 一条「属性相性」证据：翼+水 受电 = ×3（官方采访里的那一格）。 */
const TYPE_EVIDENCE_3X = [{kind: 'type_multiplier', text: '翼系|水系 受 电系 ×3（强力克制）', multiplier: 3}];
const TYPE_EVIDENCE_2X = [{kind: 'type_multiplier', text: '翼系 受 电系 ×2（克制）', multiplier: 2}];

const check = (text, evidence = TYPE_EVIDENCE_3X) =>
  checkGroundedAnswer({text, evidence, toolTrace: []});

test('① 官方 Bad Case 同族：证据是 3×，正文说「2 倍」⇒ 必须判不合格（旧守卫会放行）', () => {
  const result = check('电系打翠顶夫人是 2 倍伤害');
  assert.equal(result.valid, false, `「2 倍」与证据 ×3 矛盾，必须被拦：${JSON.stringify(result)}`);
  assert.ok(result.reasons.includes('unsupported-type-tier:2'), `理由必须点名：${JSON.stringify(result.reasons)}`);
});

test('② 正确说法通过：证据 3×，正文写「3 倍」或「强力克制」⇒ 合格', () => {
  for (const text of ['电系打翠顶夫人是 3 倍伤害', '电系强力克制翠顶夫人（翼+水）']) {
    const result = check(text);
    assert.equal(result.valid, true, `正确说法不该被误伤：${text} → ${JSON.stringify(result.reasons)}`);
  }
});

test('③ 「强力克制」对应 3：证据只有 ×2 时，正文说「强力克制」⇒ 必须判不合格', () => {
  const result = check('电系强力克制翠顶夫人', TYPE_EVIDENCE_2X);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('unsupported-type-tier:3'), JSON.stringify(result.reasons));
});

test('④ 旧的「双弱 ×4」是退役口径：正文写「四倍」⇒ 必须判不合格', () => {
  for (const text of ['电系打翠顶夫人是四倍伤害', '电系这一格是 ×4']) {
    const result = check(text);
    assert.equal(result.valid, false, `旧裁决的 4× 不该被展示：${text}`);
    assert.ok(result.reasons.includes('retired-dual-weak-tier:4x'), JSON.stringify(result.reasons));
  }
});

test('⑤ 反证（必红方向）：同一个「2 倍」在证据为 ×2 时**不许**被拦', () => {
  const result = check('电系打翠顶夫人是 2 倍伤害', TYPE_EVIDENCE_2X);
  assert.equal(result.valid, true, `证据是 ×2 时，「2 倍」是正确说法：${JSON.stringify(result.reasons)}`);
  // 同一句话，证据从 ×2 换成 ×3 ⇒ 判定必须翻转 —— 否则上面①可能只是恒真。
  assert.notEqual(check('电系打翠顶夫人是 2 倍伤害', TYPE_EVIDENCE_3X).valid, true);
});

test('⑥ 不误伤：没有属性相性上下文的数字/承诺，仍走原有守卫（行为不变）', () => {
  // 非属性上下文：数字 3 不被当成倍率。
  assert.equal(check('这回合先防御，第 3 回合再换人').valid, true);
  // 原有数字守卫不能被削弱：999 不在证据里 ⇒ 仍判不合格。
  const unsupported = check('造成 999 伤害');
  assert.equal(unsupported.valid, false);
  assert.ok(unsupported.reasons.includes('unsupported-number:999'), JSON.stringify(unsupported.reasons));
});

test('⑦ 守卫 scope 必须如实写「不是万能语义证明」', () => {
  const result = check('电系打翠顶夫人是 3 倍伤害');
  assert.match(result.scope, /type-tier/);
  assert.match(result.scope, /not a proof/);
});


// ── 2026-10-17（吸收 Codex 混合证据反例）：倍率必须绑定到对象 ──────────────────
// 旧实现把所有证据里的 ×N 收进一个集合，于是「电系打翠顶夫人是 2 倍」+ 任意一条无关 ×2
// 就能过守卫。下面三条是同一反例族的正反控制。
test('对象绑定：同对象冲突倍率必须拒绝（不能拿无关/冲突 ×2 抵账）', () => {
 const wrong = {text: '电系打翠顶夫人是 2 倍伤害',
  evidence: [TYPE_EVIDENCE_3X, TYPE_EVIDENCE_2X], toolTrace: []};
 const result = checkGroundedAnswer(wrong);
 assert.equal(result.valid, false, '同对象同时有 ×3/×2 时，2 倍断言必须 fail closed');
 assert.ok(result.reasons.some((r) => /conflicting-type-tier|unsupported-type-tier/.test(r)),
  JSON.stringify(result.reasons));
});

test('对象绑定：只是无关属性的 ×2 不许抵账（3 倍正解必须放行）', () => {
 const unrelated = {kind: 'type_multiplier', text: '草系 受 地系 ×2', multiplier: 2};
 const right = {text: '电系打翠顶夫人是 3 倍伤害', evidence: [TYPE_EVIDENCE_3X, unrelated], toolTrace: []};
 assert.deepEqual(checkGroundedAnswer(right).reasons, [], '无关属性纪录不该影响 3 倍正解');
});

test('对象绑定：同攻击属性出现冲突倍率时保守拒绝（3 倍正解也不放行）', () => {
 const right = {text: '电系打翠顶夫人是 3 倍伤害', evidence: [TYPE_EVIDENCE_3X, TYPE_EVIDENCE_2X], toolTrace: []};
 assert.equal(checkGroundedAnswer(right).valid, false, '证据自身冲突时应保守拒绝');
});
