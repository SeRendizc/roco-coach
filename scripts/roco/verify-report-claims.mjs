#!/usr/bin/env node
/**
 * **报告里的"实测"数字，从源重算一遍** —— 对不上就红。
 *
 * ## 为什么要这个（这脚本是冲着 Lead 自己反复犯的错造的）
 *
 * 这一程我在同一件事上反复栽跟头，全都留了档：
 *  · 只读**一个**文件就断言「`evaluate_team` 这批给不出」（实际另一份录制里 101/101）；
 *  · 真引擎检查**只验 `team_after`**，漏了 16 份 `team_before`；
 *  · 审核**只读 3 个文件**（189 条里的 69 条），63% 没审；
 *  · **把"零调用+回复正常"(1801) 说成"都带 `limitation_words`"**（实际 864，两者都满足 792）；
 *  · 判据挑字眼造出假阳 **7 次**。
 *
 * ⇒ 共同点：**写在报告里的数字，没有一个是"当场能重算"的。**
 * 这个脚本把报告里**声称实测**的数字**从原始数据重算**并逐条比对 ——
 * **对不上就红**。跑一次几秒，比人肉复核可靠。
 *
 * 用法：`node scripts/roco/verify-report-claims.mjs`
 * 退出码：0 = 全部对得上；2 = 有数字与源不符（**报告在说谎，或源变了没重跑**）。
 */

import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CAND = join(ROOT, 'reports', 'roco', 'sft-v9-candidates');
const SRCS = [
  join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.jsonl'),
  join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.jsonl'),
];

const FAILURE_REPLY = /没有查到可用的规则事实|没查到事实|这条我没依据/;
const zeroCall = (r) => (Array.isArray(r.trace) ? r.trace : []).length === 0;
const normalReply = (r) => Boolean(String(r.reply ?? '').trim()) && !FAILURE_REPLY.test(String(r.reply ?? ''));
const hasLimitation = (r) => (r.checks?.items?.limitation_words ?? []).length > 0;

// ── 从源重算 ────────────────────────────────────────────────────────────────
const raw = [];
for (const f of SRCS) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.record_type !== 'agent_trajectory') continue;
    raw.push(r);
  }
}

const fileOf = {};
for (const [f, r] of [['agent-trajectories-model-v1.jsonl', []], ['agent-trajectories-v1.jsonl', []]]) fileOf[f] = r;
{
  let idx = 0;
  for (const f of SRCS) {
    if (!existsSync(f)) continue;
    const key = f.split('/').pop();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.record_type !== 'agent_trajectory') continue;
      (fileOf[key] ??= []).push(r);
      idx += 1;
    }
  }
}

const measured = {
  source_rows: raw.length,
  'eval_judgment_contradiction.measured_on_source.passed_but_reply_is_failure':
    raw.filter((r) => r.checks?.passed === true && FAILURE_REPLY.test(String(r.reply ?? ''))).length,
  'eval_judgment_contradiction.measured_on_source.of_which_zero_tool_calls':
    raw.filter((r) => r.checks?.passed === true && FAILURE_REPLY.test(String(r.reply ?? '')) && zeroCall(r)).length,
  'eval_judgment_contradiction.measured_on_source.failed_and_reply_is_failure':
    raw.filter((r) => r.checks?.passed !== true && FAILURE_REPLY.test(String(r.reply ?? ''))).length,
  'eval_judgment_contradiction.measured_on_source.passed_and_reply_ok':
    raw.filter((r) => r.checks?.passed === true && !FAILURE_REPLY.test(String(r.reply ?? ''))).length,
  'limitation_words_evidence.measured_corrected.limitation_words_nonempty': raw.filter(hasLimitation).length,
  'limitation_words_evidence.measured_corrected.zero_call_and_normal_reply':
    raw.filter((r) => zeroCall(r) && normalReply(r)).length,
  'limitation_words_evidence.measured_corrected.both':
    raw.filter((r) => hasLimitation(r) && zeroCall(r) && normalReply(r)).length,
};

// 输入键清点
const census = {};
for (const r of raw) for (const k of Object.keys(r.input ?? {})) census[k] = (census[k] ?? 0) + 1;

// ── 与报告比对 ──────────────────────────────────────────────────────────────
const reportPath = join(CAND, 'REPORT.json');
if (!existsSync(reportPath)) { console.error('[核报告] 还没有 REPORT.json —— 先跑 build-sft-candidates.mjs --write'); process.exit(1); }
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const problems = [];
const checked = [];
for (const [path, recomputed] of Object.entries(measured)) {
  const claimed = pick(report, path);
  checked.push({path, claimed, recomputed});
  if (claimed !== recomputed) problems.push({path, claimed, recomputed});
}
// 输入键清点也要对得上（它是"源里有什么"的底座）
for (const [k, v] of Object.entries(report.input_context?.source_input_keys_census ?? {})) {
  const recomputed = census[k] ?? 0;
  checked.push({path: `input_context.source_input_keys_census.${k}`, claimed: v, recomputed});
  if (v !== recomputed) problems.push({path: `input_context.source_input_keys_census.${k}`, claimed: v, recomputed});
}
// 工具覆盖：**逐文件**核（`measured_per_file`）。
// ⚠ 第一版这里核的是 `measured_second_source`，而那个字段的数字**来自错的文件**
// （写 101/94，实为 324/180）⇒ **护栏当场把它抓出来了**，这一节就是修完之后的形态。
const perFileOk = {};
for (const [f, r] of Object.entries(fileOf)) {
  perFileOk[f] = {};
  for (const row of r) for (const s of (Array.isArray(row.trace) ? row.trace : [])) {
    if (s.receipt?.ok !== true) continue;
    const t = String(s.tool ?? '?');
    perFileOk[f][t] = (perFileOk[f][t] ?? 0) + 1;
  }
}
for (const [file, tools] of Object.entries(report.key_tool_coverage?.measured_per_file ?? {})) {
  if (file === '__total') continue;
  for (const [tool, claimed] of Object.entries(tools ?? {})) {
    const recomputed = perFileOk[file]?.[tool] ?? 0;
    checked.push({path: `key_tool_coverage.measured_per_file.${file}.${tool}`, claimed, recomputed});
    if (Number(claimed) !== recomputed) {
      problems.push({path: `key_tool_coverage.measured_per_file.${file}.${tool}`, claimed, recomputed});
    }
  }
}

console.log(`[核报告] 从源重算了 ${checked.length} 个数字（源 ${raw.length} 条）`);
for (const c of checked) {
  if (c.ok === false || (c.claimed !== undefined && c.claimed !== c.recomputed)) {
    console.log(`  ✖ ${c.path}：报告说 ${JSON.stringify(c.claimed)}，重算 ${JSON.stringify(c.recomputed)}`);
  }
}
if (problems.length) {
  console.log(`[核报告] ✖ ${problems.length} 个数字与源不符 ⇒ **报告在说谎，或源变了没重跑**`);
  process.exit(2);
}
console.log('[核报告] ✔ 报告里声称"实测"的数字**全部能从源重算出来**');
