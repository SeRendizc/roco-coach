#!/usr/bin/env node
// Agent 政策路由小评测（离线、0 模型调用）。
//
// 目的：把「该不该调工具、调哪个、参数关键字段对不对」变成可复跑的分桶指标，
// 而不是靠人肉试。这是面试里「你如何评测 Agent」的最小可运行样例：
//   · 分母 = 全部任务（含失败）；known_gap 只报告、不计入阈值；
//   · 每条期望写死（不是从实现反推），改政策必须重新解释一次；
//   · 0 次网络/模型调用，毫秒级。
//
// 用法：
//   node scripts/roco/agent-policy-eval.mjs           # 人类可读
//   node scripts/roco/agent-policy-eval.mjs --json    # 机器可读
//   npm run eval:agent-policy

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {policyFor, defaultArgsFor} from '../../src/coach/runtime.js';

const TASKS_PATH = fileURLToPath(new URL('../../tests/evals/roco/agent-policy-tasks.json', import.meta.url));

const camp = () => ({mode: 'camp', battle: null,
 profile: {pets: [{id: 'pet_000118', name: '音速犬', types: ['火系']}]}});
const roco = () => ({mode: 'camp',
 profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]},
 roco_battle: {turn: 1, phase: 'battle', state_version: 0, battle_id: 's1-eval',
  // 只保留政策判定需要的公开面字段；能量值不在这里写死（RC-101：唯一事实源是 rulesets）
  self: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 425, max_hp: 425, alive: true, types: ['龙系', '幽系']}],
  self_active: 0,
  foe: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 425, max_hp: 425, alive: true, types: ['龙系', '幽系']}],
  legal: [{label: '龙血', kind: 'skill'}, {label: '换上第2位', kind: 'switch'}]}});
const CONTEXTS = {camp, roco};

const subsetEqual = (actual, expected) => expected === undefined
 || Object.entries(expected).every(([key, want]) => {
   const got = actual?.[key];
   if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((v, i) => v === got[i]);
   if (want && typeof want === 'object') return subsetEqual(got, want);
   return got === want;
 });

export function runEval(tasks = JSON.parse(readFileSync(TASKS_PATH, 'utf8')).tasks) {
 const rows = [];
 for (const task of tasks) {
  const ctx = CONTEXTS[task.context]();
  const policy = policyFor(task.message, ctx) ?? {need: null, reason: null};
  const args = policy.need ? defaultArgsFor(policy.need, ctx, task.message) : null;
  const reasonOk = policy.reason === task.expect.reason;
  const toolOk = (policy.need ?? null) === (task.expect.tool ?? null);
  const argsOk = !task.expect.args || subsetEqual(args, task.expect.args);
  const pass = reasonOk && toolOk && argsOk;
  rows.push({id: task.id, category: task.category, known_gap: Boolean(task.known_gap), message: task.message,
   pass, expected: task.expect, actual: {reason: policy.reason, tool: policy.need ?? null, args},
   failures: [reasonOk ? null : `reason ${policy.reason} ≠ ${task.expect.reason}`,
              toolOk ? null : `tool ${policy.need} ≠ ${task.expect.tool}`,
              argsOk ? null : `args ${JSON.stringify(args)}`].filter(Boolean)});
 }
 const scored = rows.filter((r) => !r.known_gap);
 const passed = scored.filter((r) => r.pass);
 const byCategory = {};
 for (const row of scored) {
  const bucket = byCategory[row.category] ??= {total: 0, pass: 0};
  bucket.total += 1;
  if (row.pass) bucket.pass += 1;
 }
 const knownGaps = rows.filter((r) => r.known_gap);
 const result = {
  schema: 'roco-agent-policy-eval-result/v1',
  at: new Date().toISOString(),
  total: rows.length,
  scored: scored.length,
  passed: passed.length,
  accuracy: scored.length ? Number((passed.length / scored.length).toFixed(4)) : null,
  threshold: 0.9,
  ok: scored.length > 0 && passed.length / scored.length >= 0.9,
  byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, {...v, accuracy: Number((v.pass / v.total).toFixed(4))}])),
  knownGaps: knownGaps.map((r) => ({id: r.id, category: r.category, message: r.message, note: r.note ?? null,
   expected: r.expected, actual: r.actual})),
  failures: scored.filter((r) => !r.pass).map((r) => ({id: r.id, category: r.category, message: r.message,
   expected: r.expected, actual: r.actual, failures: r.failures})),
 };
 return result;
}

if (process.argv[1] && process.argv[1].endsWith('agent-policy-eval.mjs')) {
 const result = runEval();
 if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
 } else {
  console.log('Agent 政策路由小评测（离线，0 模型调用）');
  console.log(`任务 ${result.total} 条（计分 ${result.scored}，known-gap ${result.knownGaps.length}）；`
   + `通过 ${result.passed}/${result.scored} = ${(result.accuracy * 100).toFixed(1)}%（阈值 ≥90%）`);
  for (const [k, v] of Object.entries(result.byCategory)) console.log(`  · ${k}: ${v.pass}/${v.total}`);
  if (result.knownGaps.length) console.log(`  known-gap: ${result.knownGaps.map((g) => `${g.id}(${g.category})`).join(', ')}`);
  for (const f of result.failures) console.log(`  ✖ ${f.id} ${f.message} → ${f.failures.join('；')}`);
  console.log(result.ok ? '✔ PASS' : '✖ FAIL');
 }
 process.exit(result.ok ? 0 : 1);
}
