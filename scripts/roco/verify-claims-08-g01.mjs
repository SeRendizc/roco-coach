#!/usr/bin/env node
/**
 * 独立复验（08 · G01）：同物种两只个体是否共用一份配招？
 *   · HEAD 版（提交态，纯物种级 v1）：`pet_…` 一个键 ⇒ 后配的覆盖先配的
 *   · 工作树版（08·S1 在飞，个体级 v2 + resolveLoadout）：两只各读各的；旧 v1 记录如实标注
 * 只用**内存假 storage**；不碰真实 localStorage / data/**；只读导入两份模块。
 * 用法：node scripts/roco/verify-claims-08-g01.mjs
 */
const HEAD = 'file:///E:/roco-scratch/g01-head-loadout-store.mjs';
const WORK = 'file:///E:/roco-scratch/g01-worktree-loadout-store.mjs';

const A4 = ['skill_a1', 'skill_a2', 'skill_a3', 'skill_a4'];   // 个体 A（own-0001 / 物种 pet_000012）
const B4 = ['skill_b1', 'skill_b2', 'skill_b3', 'skill_b4'];   // 个体 B（own-0002 / 同一物种）
const SPECIES = 'pet_000012';
const IND_A = 'own-0001';
const IND_B = 'own-0002';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    dump: () => Object.fromEntries(m),
  };
}

let pass = true;
const check = (label, ok, extra = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`); };

// ── [1] HEAD 版：物种级共用 ⇒ 互相覆盖 ──
console.log('=== [1] HEAD 版（提交态）· 模拟两只同物种个体各配四招 ===');
const h = await import(HEAD);
const s1 = memStorage();
console.log('  两只个体： A=own-0001(species pet_000012) · B=own-0002(同一物种)');
console.log('  盒子页写的键 = state.petId（引擎回执的 pet_id）＝', SPECIES, '；工坊页写的键 = row.species ＝', SPECIES);
const okA1 = h.writeSharedLoadout(s1, SPECIES, A4);
console.log(`  A 配四招 ${JSON.stringify(A4)} ⇒ 写入成功=${okA1}`);
console.log(`    A 立刻读回 = ${JSON.stringify(h.readSharedLoadout(s1, SPECIES))}`);
const okB1 = h.writeSharedLoadout(s1, SPECIES, B4);
console.log(`  B 配四招 ${JSON.stringify(B4)} ⇒ 写入成功=${okB1}`);
const afterB = h.readSharedLoadout(s1, SPECIES);
console.log(`    **A 现在读回** = ${JSON.stringify(afterB)}   ← 是不是 B 的四招？`);
console.log(`  storage 里只有这些键: ${JSON.stringify(Object.keys(s1.dump()))}`);
const collision = JSON.stringify(afterB) === JSON.stringify(B4);
check('HEAD 版：物种级记录被后配的覆盖（A 读到 B 的四招）', collision);
check('HEAD 版：没有个体级 API（无法按个体分开存）',
  typeof h.writeIndividualLoadout !== 'function' && typeof h.resolveLoadout !== 'function');

// ── [2] 工作树版：个体级 ⇒ 不互相覆盖 ──
console.log('\n=== [2] 工作树版（08·S1 在飞）· 同一场景 ===');
const w = await import(WORK);
const s2 = memStorage();
console.log(`  A 写个体级=${w.writeIndividualLoadout(s2, IND_A, A4)} · B 写个体级=${w.writeIndividualLoadout(s2, IND_B, B4)}`);
const rA = w.resolveLoadout(s2, {instanceId: IND_A, speciesId: SPECIES});
const rB = w.resolveLoadout(s2, {instanceId: IND_B, speciesId: SPECIES});
console.log(`  A 解析 = ${JSON.stringify(rA)}`);
console.log(`  B 解析 = ${JSON.stringify(rB)}`);
check('工作树版：A 拿到自己的四招', JSON.stringify(rA?.ids) === JSON.stringify(A4));
check('工作树版：B 拿到自己的四招（未覆盖 A）', JSON.stringify(rB?.ids) === JSON.stringify(B4));
check('工作树版：两条都是个体级（scope=individual, note=null）',
  rA?.scope === 'individual' && rB?.scope === 'individual' && rA?.note === null && rB?.note === null);
console.log(`  storage 键: ${JSON.stringify(Object.keys(s2.dump()))}`);

// ── [3] 工作树版：旧物种级记录（历史）怎么读 ──
console.log('\n=== [3] 工作树版：只有旧 v1（物种级）记录时 ===');
const s3 = memStorage();
w.writeSharedLoadout(s3, SPECIES, A4);           // 模拟历史遗留
const legacyA = w.resolveLoadout(s3, {instanceId: IND_A, speciesId: SPECIES});
const legacyB = w.resolveLoadout(s3, {instanceId: IND_B, speciesId: SPECIES});
console.log(`  A 解析 = ${JSON.stringify(legacyA)}`);
console.log(`  B 解析 = ${JSON.stringify(legacyB)}`);
check('旧记录仍可读（兼容）', JSON.stringify(legacyA?.ids) === JSON.stringify(A4));
check('旧记录如实标注物种级（scope=species + 那句 note）',
  legacyA?.scope === 'species' && legacyA?.note === w.SPECIES_SCOPE_NOTE,
  `note=${JSON.stringify(legacyA?.note)}`);
check('旧记录下两只**确实读到同一份**（如实承认，不假装个体级）',
  JSON.stringify(legacyA?.ids) === JSON.stringify(legacyB?.ids));

// ── [4] 工作树版：v1 与 v2 并存 ⇒ 个体级优先（单向迁移）──
console.log('\n=== [4] 工作树版：旧 v1 + 新个体级 v2 并存 ===');
const s4 = memStorage();
w.writeSharedLoadout(s4, SPECIES, A4);            // 历史：物种级
w.writeIndividualLoadout(s4, IND_A, B4);          // A 后来编辑过 ⇒ 个体级
const mixA = w.resolveLoadout(s4, {instanceId: IND_A, speciesId: SPECIES});
const mixB = w.resolveLoadout(s4, {instanceId: IND_B, speciesId: SPECIES});
console.log(`  A 解析 = ${JSON.stringify(mixA)}`);
console.log(`  B 解析 = ${JSON.stringify(mixB)}`);
check('个体级优先（A 拿到 v2）', JSON.stringify(mixA?.ids) === JSON.stringify(B4) && mixA?.scope === 'individual');
check('未编辑过的 B 回落到旧物种级 + 标注',
  JSON.stringify(mixB?.ids) === JSON.stringify(A4) && mixB?.scope === 'species' && mixB?.note === w.SPECIES_SCOPE_NOTE);

console.log('\nRESULT =', pass ? 'G01 REPRODUCED AT HEAD · FIXED IN WORKTREE' : 'CHECK-NEEDED');
process.exit(pass ? 0 : 1);
