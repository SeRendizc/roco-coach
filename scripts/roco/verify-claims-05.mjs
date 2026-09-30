#!/usr/bin/env node
/**
 * 独立取证（05 关键缺陷）：引擎回执的 expected / worst / first_second_margin 是**对象**，
 * 而客户端投影 `coachRocoPlan()`（roco.js:5588 的 Number.isFinite 循环）把它们**静默丢掉**；
 * 服务端 `validateChat()`（index.js:389 同一份键表）反而**拒绝**对象型取值（400）。
 *
 * 方法（如实登记）：客户端函数**逐字抽取**自 src/client/roco.js 并在沙箱里执行
 * （文件是浏览器脚本、非 ESM，无法直接 import）；服务端校验器是**真 import**。
 * 只读；用法：node scripts/roco/verify-claims-05.mjs
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const CLIENT = join(ROOT, 'src', 'client', 'roco.js');
const receipt = JSON.parse(readFileSync('E:/roco-scratch/plan-receipt.json', 'utf8'));
const plan = receipt.plan;
const KEYS = ['expected', 'worst', 'first_second_margin', 'branches_evaluated', 'depth_searched'];

console.log('=== [1] 引擎回执（真 /battle/plan，隔离副本）===');
for (const k of KEYS) {
  const v = plan[k];
  console.log(`  ${k.padEnd(22)} type=${Array.isArray(v) ? 'array' : typeof v}` +
    (v && typeof v === 'object' ? ` keys=${Object.keys(v).join(',')}` : ` value=${JSON.stringify(v)}`));
}

// ── [2] 客户端投影：逐字抽取 coachRocoPlan() 并在沙箱里跑 ──
const src = readFileSync(CLIENT, 'utf8');
const lines = src.split('\n');
const startIdx = lines.findIndex((l) => /^function coachRocoPlan\(\) \{/.test(l));
if (startIdx < 0) { console.log('CLIENT_FN_NOT_FOUND'); process.exit(3); }
let depth = 0, endIdx = -1;
for (let i = startIdx; i < lines.length; i += 1) {
  for (const ch of lines[i]) {
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx >= 0) break;
}
const fnText = lines.slice(startIdx, endIdx + 1).join('\n');
console.log(`\n=== [2] 客户端投影（抽自 ${CLIENT.replace(/\\/g, '/')}:${startIdx + 1}-${endIdx + 1}，逐字）===`);
console.log(`  抽取到的函数首行: ${fnText.split('\n')[0]}`);
console.log(`  含 isFinite 循环: ${fnText.includes("Number.isFinite(plan[key])")}`);

const {rocoPlanFreshness} = await import(`file:///${R}/src/coach/roco-experience.js`);
const state = {plan, view: {state_version: plan.state_version}};
const make = new Function('state', 'rocoPlanFreshness', `${fnText}\nreturn coachRocoPlan();`);
let projected;
try {
  projected = make(state, rocoPlanFreshness);
} catch (e) {
  console.log('  执行抛错:', String(e.message).slice(0, 120));
  process.exit(4);
}
console.log('  投影产出的键 =', Object.keys(projected ?? {}).join(','));
console.log('\n  逐字段前后对照：');
let dropped = [];
for (const k of KEYS) {
  const before = plan[k];
  const after = projected?.[k];
  const lost = before !== undefined && after === undefined;
  if (lost) dropped.push(k);
  console.log(`    ${k.padEnd(22)} 引擎=${before === undefined ? '(无)' : JSON.stringify(before).slice(0, 46)}` +
    `  ⇒ 投影后=${after === undefined ? '**丢了**' : JSON.stringify(after)}`);
}
console.log(`  ⇒ 被静默丢掉的字段: ${JSON.stringify(dropped)}`);

// ── [3] 服务端 validateChat：对象型取值会被拒 ──
console.log('\n=== [3] 服务端 validateChat（真 import）===');
const {validateChat} = await import(`file:///${R}/src/server/index.js`);
const base = {
  message: '这一手怎么打？', role: 'strategist',
  context: {mode: 'pvp-live', profile: {pets: [{name: 'x'}]}},
  memory: {version: 1},
};
for (const [label, rp] of [
  ['标量形（现状页面会发的形状）', {state_version: plan.state_version, branches_evaluated: plan.branches_evaluated, depth_searched: plan.depth_searched}],
  ['对象形（引擎真实的 expected/worst/first_second_margin）',
    {state_version: plan.state_version, expected: plan.expected, worst: plan.worst, first_second_margin: plan.first_second_margin}],
]) {
  try {
    validateChat({...base, context: {...base.context, roco_plan: rp}});
    console.log(`  ${label}: **通过**（未抛错）`);
  } catch (e) {
    console.log(`  ${label}: **拒绝** → ${String(e.message).slice(0, 90)}`);
  }
}

const ok = dropped.length === 3
  && Object.keys(projected ?? {}).includes('branches_evaluated')
  && Object.keys(projected ?? {}).includes('depth_searched');
console.log('\nRESULT =', ok ? 'CONFIRMED: 三个对象字段在客户端投影里被静默丢弃（标量保留）'
  : 'CHECK-NEEDED');
process.exit(ok ? 0 : 1);
