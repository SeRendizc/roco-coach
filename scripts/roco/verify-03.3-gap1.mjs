#!/usr/bin/env node
/**
 * 03.3 缺口#1 独立复核（harness-verifier）：我自己算「用到 ⊆ 白名单」与「白名单每项被用或在 OPTIONAL」，
 * 并**按组**核对（场上那只 vs 已亮明后备行）。只读冻结件。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const M = await import(`file:///${R}/src/coach/opponent-belief.mjs`);

const WL = M.PUBLIC_FACT_FIELDS;
const OPT = M.PUBLIC_FACT_FIELDS_OPTIONAL;
const rep = JSON.parse(readFileSync(join(ROOT, 'reports/roco/rc604/opponent-belief.json'), 'utf8'));

// 报告里条件化信念实际用到的 public_facts 键（按组）
const pf = (rep.beliefs ?? []).map((b) => b.public_facts).find(Boolean) ?? {};
const usedByGroup = {
  opponent_active: Object.keys(pf.opponent?.active ?? {}),
  opponent_revealed: [...new Set((pf.opponent?.revealed_pets ?? []).flatMap((r) => Object.keys(r)))],
  own_team: [...new Set((pf.own_team ?? []).flatMap((r) => Object.keys(r)))],
  mode: Object.keys(pf.mode ?? {}),
};
console.log('=== 白名单（按组）===');
for (const [g, keys] of Object.entries(WL)) console.log(' ', g, '=', JSON.stringify(keys));
console.log('=== OPTIONAL ===');
for (const [g, keys] of Object.entries(OPT)) console.log(' ', g, '=', JSON.stringify(keys));
console.log('\n=== 报告里实际用到的键（按组）===');
for (const [g, keys] of Object.entries(usedByGroup)) console.log(' ', g, '=', JSON.stringify(keys));

console.log('\n=== 判定 A：用到 ⊆ 白名单（按组）===');
let aOk = true;
for (const [g, keys] of Object.entries(usedByGroup)) {
  const bad = keys.filter((k) => !(WL[g] ?? []).includes(k));
  if (bad.length) aOk = false;
  console.log(`  ${g}: 未在白名单 = ${JSON.stringify(bad)}`);
}

console.log('\n=== 判定 B：白名单每一项 被用到 或 在 OPTIONAL 点名（按组）===');
let bOk = true;
for (const [g, keys] of Object.entries(WL)) {
  const dead = keys.filter((k) => !(usedByGroup[g] ?? []).includes(k) && !(OPT[g] ?? []).includes(k));
  if (dead.length) bOk = false;
  console.log(`  ${g}: 死条目 = ${JSON.stringify(dead)}`);
}

console.log('\n=== 判定 C：按组判（不是跨组取交集）===');
const activeHas = ['hp', 'max_hp', 'energy'].filter((k) => (WL.opponent_active ?? []).includes(k));
const revealedHides = ['hp', 'max_hp', 'energy'].filter((k) => (M.HIDDEN_FACT_FIELDS?.opponent_revealed ?? []).includes(k));
const crossGroup = ['hp', 'max_hp', 'energy'].filter((k) => (WL.opponent_active ?? []).includes(k) && (WL.opponent_revealed ?? []).includes(k));
console.log('  场上那只公开的 hp/max_hp/energy =', JSON.stringify(activeHas));
console.log('  已亮明后备行隐藏的同类键 =', JSON.stringify(revealedHides));
console.log('  同时出现在两组白名单的 =', JSON.stringify(crossGroup), '（应为空）');

const ok = aOk && bOk && crossGroup.length === 0 && activeHas.length === 3;
console.log('\nRESULT =', ok ? 'GAP1 PASS（两半都成立且按组判）' : 'GAP1 FAIL');
process.exit(ok ? 0 : 1);
