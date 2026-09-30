#!/usr/bin/env node
/**
 * H4 独立复验（harness-verifier）：换词之后 RC-802 的「值必须来自回执」有没有被放松。
 * 手法：直接驱动**真** `rulesetProblems()`（不是重写判据），自己造 5 种造假 + 控件。
 * 只读。用法：node scripts/roco/verify-h4-rc802.mjs [ROOT]
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const CHECKS = await import(`file:///${R}/scripts/roco/dev-drawer-checks.mjs`);
const {rulesetProblems} = CHECKS;

console.log('=== 指纹（我测的是哪一份）===');
for (const f of ['scripts/roco/dev-drawer-checks.mjs', 'tests/roco-dev-drawer.test.js',
  'src/client/roco.js']) {
  const buf = readFileSync(join(ROOT, f));
  const {createHash} = await import('node:crypto');
  console.log(`  ${createHash('sha256').update(buf).digest('hex').slice(0, 16)}  ${f}`);
}

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };

const ID = 'roco-world-s4-2026-09-10';
const facts = {engineRulesetId: ID, engineStateVersion: 31};
const good = `${ID} · 本局已收到 31 次局面更新`;

console.log('\n=== 控件 + 五种造假（每条都要 red 或 green 如预期）===');
const cases = [
  ['控件：值逐字来自回执', good, false],
  ['① 只写 id（写死的样例）', ID, true],
  ['② 旧措辞（内部术语「本局状态版本」）', `${ID} · 本局状态版本 31`, true],
  ['③ 值不来自回执（次数写 30，回执是 31）', `${ID} · 本局已收到 30 次局面更新`, true],
  ['④ 空文本', '', true],
  ['⑤ id 不是回执里那个', `other-ruleset · 本局已收到 31 次局面更新`, true],
  ['⑥ 把事件计数说成回合', `${ID} · 第 31 回合`, true],
];
for (const [label, shown, shouldRed] of cases) {
  const problems = rulesetProblems({...facts, rulesetText: shown});
  const red = problems.length > 0;
  console.log(`  ${red ? 'RED ' : 'GREEN'} ${label.padEnd(34)} ${red ? JSON.stringify(problems[0]).slice(0, 90) : ''}`);
  check(label, red === shouldRed, red !== shouldRed ? `（期望 ${shouldRed ? 'red' : 'green'}）` : '');
}

console.log('\n=== 「值来自回执」是结构性的：换版本 ⇒ want 跟着变 ===');
for (const v of [31, 32, 99]) {
  const problems = rulesetProblems({...facts, engineStateVersion: v, rulesetText: good});
  const red = problems.length > 0;
  console.log(`  回执版本=${v} 但文本写 31 ⇒ ${red ? 'RED ' : 'GREEN'} ${red ? JSON.stringify(problems[0]).slice(0, 80) : ''}`);
  check(`回执版本 ${v} 与文本不一致 ⇒ red（v=31 时应当 green）`, red === (v !== 31));
}
console.log('  读不到 state_version ⇒', JSON.stringify(rulesetProblems({...facts, engineStateVersion: null})));
check('读不到 state_version ⇒ red（不许当没看见）',
  rulesetProblems({...facts, engineStateVersion: null}).length > 0);

console.log('\n=== 新措辞本身不含内部词 ===');
check('新 want 不含 state_version / 本局状态版本 / 回合',
  !/state_version|本局状态版本|回合/.test(good));

console.log('\nRESULT =', pass ? 'H4 RC802 PASS' : 'H4 RC802 CHECK-NEEDED');
process.exit(pass ? 0 : 1);
