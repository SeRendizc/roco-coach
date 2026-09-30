// 2026-09-30（Lead · P0 矛盾收口）：`skillSupportFact` 的**单文件判据**。
//
// 背景（报告 L19/L30 实测）：玩家点「防御」，战报逐字「本回合减伤约 70%」、能量 10→9，
// 而同一技能详情逐字「引擎没有结算这条效果」。根因**不在引擎**（`service.py:871-877` 已统一）：
//   `skillSupportFact` 对**可算**的档位返回 `null` ⇒ `attachSkillSupport` 什么都不挂
//   ⇒ 前端分不清「会结算」与「不知道」，只能回落读静态 `effect_support`（引擎早不用它判结论）。
//   = ㉛「三种空」的又一实例：**`null` 同时表示「会结算」和「不知道」**。
//
// 本判据钉四件事（**两个方向都钉**）：
//   ① 可算档位 ⇒ **不再是 `null`**，且 `settled === true`   ← **这就是本次修复**
//   ② 真未知（没有 `support_tier`）⇒ **仍然 `null`**（不许把 fail-closed 一起放宽）
//   ③ 不可算档位 ⇒ 带 `tier` + 人话 `note`，且 **`settled` 不为 `true`**（负向控制）
//   ④ 反证/对照：① 若按**旧实现**（`if(!tier||SETTLED.has(tier))return null`）会红 —— 见最后一条
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/server/roco-service.js');
const fact = mod.skillSupportFact;

// 旧实现（留档 · 改钉不删）：用来做**对照实验**，证明本判据真的能抓住回归。
const OLD_IMPL = (record, SETTLED) => {
  const tier = String(record?.support_tier ?? '');
  if (!tier || SETTLED.has(tier)) return null;
  return 'old-branch';
};
const SETTLED = new Set(['SIMULATABLE_UNVERIFIED', 'FULL_VERIFIED']);

test('① 可算档位 ⇒ 不再返回 null，且 settled===true（本次修复点）', () => {
  for (const tier of ['SIMULATABLE_UNVERIFIED', 'FULL_VERIFIED']) {
    const r = fact({ support_tier: tier });
    assert.notEqual(r, null, `${tier} 不许再返回 null（旧实现就是这里错了）`);
    assert.equal(r.settled, true, `${tier} 必须带 settled:true`);
    assert.equal(r.tier, tier, 'tier 原样带出');
    assert.ok(typeof r.note === 'string' && r.note.trim(), '必须有玩家能读的一句话');
  }
});

test('② 真未知（没有 support_tier）⇒ 仍然 null（不许把 fail-closed 放宽）', () => {
  assert.equal(fact({}), null);
  assert.equal(fact({ support_tier: '' }), null);
  assert.equal(fact(null), null);
  assert.equal(fact(undefined), null);
});

test('③ 负向控制：不可算档位 ⇒ 带 tier + note，且 settled 不为 true', () => {
  const r = fact({ support_tier: 'KNOWLEDGE_ONLY', support_unparsed: ['变：把对手的攻击降一档'] });
  assert.notEqual(r, null, '不可算也要给事实（那正是这一层的用途）');
  assert.notEqual(r.settled, true, '不可算**不许**自称 settled');
  assert.equal(r.tier, 'KNOWLEDGE_ONLY');
  assert.ok(typeof r.note === 'string' && r.note.trim(), '必须点名缺什么');
});

test('④ 对照实验：同一批输入喂旧实现 ⇒ ① 必须红（判据真的有牙）', () => {
  // 旧实现对可算档位返回 null ⇒ 与 ① 的断言直接冲突
  assert.equal(OLD_IMPL({ support_tier: 'FULL_VERIFIED' }, SETTLED), null, '旧实现确实返回 null');
  assert.notEqual(fact({ support_tier: 'FULL_VERIFIED' }), null, '新实现不再为 null ⇒ 旧实现必红');
  // 反过来：② 那一支新旧**都要**为 null（**没有把 fail-closed 放宽**）
  assert.equal(OLD_IMPL({}, SETTLED), null);
  assert.equal(fact({}), null);
});
