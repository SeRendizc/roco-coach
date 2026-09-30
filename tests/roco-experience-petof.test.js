// 2026-09-30（Lead 裁定修复的钉桩 · 判定/笔：advice-engine）────────────────────────
// 缺陷：`petOf()` 把「公开视图没给」的 hp / max_hp / energy **折叠成 0** ✗
//   ⇒ 后果（#70 条件式）：**在"视图没给这三个字段"的输入下**，`hp=0` 会被 `coach-advice.js:1400`
//     的 `mineHpForKind <= 0` 读成「我方倒下」✗（把"没读到"说成"倒下了"）
// 修法：缺 ⇒ `null`（与同文件 `:100` 对对手后备行的写法同一手法 ✓「补了就等于编造隐藏信息」）
// 🔴 反证：把 `null` 改回 `0` ⇒ 本文件两条断言必须红（用 `PETOF_MODULE` 指到 tmp/ 副本即可复现 ✓）
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import(process.env.PETOF_MODULE ?? '../src/coach/roco-experience.js');
const {rocoGameView} = mod;

test('petOf：缺 hp / max_hp / energy ⇒ 必须是 null（不许折叠成 0）', () => {
  const view = rocoGameView({self: {pets: [{pet_id: 'own-1', name: '喵喵'}]}});
  const pet = view.player.pets[0];
  assert.equal(pet.hp, null, `缺 hp 不许折叠成 0（实际 ${pet.hp}）`);
  assert.equal(pet.maxHp, null, `缺 max_hp 不许折叠成 0（实际 ${pet.maxHp}）`);
  assert.equal(pet.energy, null, `缺 energy 不许折叠成 0（实际 ${pet.energy}）`);
});

test('petOf：有值 ⇒ 逐字不变（回归）', () => {
  const view = rocoGameView({self: {pets: [{pet_id: 'own-1', name: '喵喵', hp: 246, max_hp: 360, energy: 7}]}});
  const pet = view.player.pets[0];
  assert.deepEqual([pet.hp, pet.maxHp, pet.energy], [246, 360, 7]);
});
