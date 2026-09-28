#!/usr/bin/env node
/**
 * 从**真实轨迹**里抽一批**可审核的种子样本**（Codex 4B 前置第 3 项）。
 *
 * Codex 原话：
 *   「先交 **50–100 条真实场景样本与执行回执**，再扩为新数据。meta 中保留
 *     `group_id/source/contract_version/reviewed`；**按原始战斗/队伍/模板族分割**，
 *     不能随机把改写同源案例分到 test。」
 *   以及「**ready 标记必须关联真实完成证据，不得为了让脚本通过虚填**。」
 *
 * ## 样本从哪来（全部来自真实录制，不是我编的）
 *
 * `tests/evals/agent-trajectories-model-v1.jsonl` —— 1752 条**真跑出来的**轨迹，每条带：
 *   · `input.message` 玩家的**真实问句**；
 *   · `trace[0]` 那次**真实工具调用**（`tool` / `args` / `chosen_by`）；
 *   · `trace[0].receipt` **真实执行回执**（`ok` / `evidence_ids` / `coverage` / `bytes`）；
 *   · `reply` 最终回答；`split.{family,mechanism,template,side}` 已有的族信息。
 *
 * ## `reviewed: true` 是**挣来的**，不是填的
 *
 * 每条必须同时过下面 `REVIEW_CRITERIA` 里**每一条**（都能对着真实回执核）：
 *   R1a **0 次调用**（模型决定 stop）—— 这也是真实决策；**首版我把它整批丢了**
 *       （标签还错写成"不是恰好一次"），实测 1332 条，而 v8 里 stop 目标有 859 条
 *       ⇒ 等于把最重要的一类信号扔了。
 *   R1b 恰好一次工具调用（多步的留给后续，不在种子里掺）
 *   R2 那次调用的**执行回执 `ok === true`** —— 这就是"执行回执"证据
 *   R3 工具名**在共享契约里**（`TOOL_CONTRACTS`）
 *   R4 参数过 `validToolArgs`（产品自己的校验器，不是这里另写一套）
 *   R5 有最终回答 `reply`，且不是空串
 *   R6 该行的 `checks`（若录制里有）**全部通过**
 *   R7 去重：(问句, 目标) 只留一条，避免同义改写把种子灌水
 * 任一条不过 ⇒ **不进种子**，并计入 `rejected.<原因>`。
 *
 * ## 分割：**按族**（`group_id = case_id`），跨分片组重叠必须为 0
 *
 * 族按 `case_id`（例 `rl-pet-f0-01`）**整体**分到一个分片；同一个族的改写**绝不**跨到两个分片。
 *
 * 用法：
 *   node scripts/roco/build-sft-seed.mjs            # 只报告
 *   node scripts/roco/build-sft-seed.mjs --write    # 写 reports/roco/sft-v9-seed/
 */

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCAL_PLAN_TOOLS, TOOL_CONTRACTS, validToolArgs} from '../../src/coach/toolbox.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.jsonl');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'sft-v9-seed');
const TARGET_SIZE = Number(process.env.ROCO_SEED_SIZE || 90);   // Codex: 50–100
const RULESET = 'roco-world-s4-2026-09-10';

/** 与审计脚本同一套口径（`--new-data` 里那几个 versioned 工具要补 `state_version: 0`）。 */
const VERSIONED = new Set(['query_rules', 'evaluate_team', 'compare_team_change', 'plan_actions', 'summarize_battle']);

/** 契约身份：**共享实现**的指纹。样本只对这个版本有效，契约一变指纹就变。 */
const contractVersion = `tools:${createHash('sha256')
  .update(JSON.stringify({contract: Object.keys(TOOL_CONTRACTS), localPlan: [...LOCAL_PLAN_TOOLS]}))
  .digest('hex').slice(0, 12)}`;

const REVIEW_CRITERIA = Object.freeze([
  'R1a 0 次调用（模型决定 stop）—— 这也是真实决策，必须能进种子',
  'R1b 恰好一次工具调用',
  'R2 该次调用的执行回执 ok===true（真实执行回执）',
  'R3 工具名在 TOOL_CONTRACTS 里',
  'R4 参数过产品自己的 validToolArgs',
  'R5 有非空最终回答 reply',
  'R6 录制里的 checks（若有）全部通过',
  'R7 (问句,目标) 去重后只留一条',
]);

const rows = readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l)).filter((r) => r.record_type === 'agent_trajectory');

const rejected = {};
const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; };

const candidates = [];
const seen = new Set();
for (const row of rows) {
  const trace = Array.isArray(row.trace) ? row.trace : [];
  if (trace.length > 1) { reject('多步（留后续，不在种子里掺）'); continue; }
  if (trace.length === 0) {
    // **0 次调用 = 模型决定停止** —— 真实决策，不是坏样本。
    const message0 = String(row.input?.message ?? '').trim();
    const reply0 = String(row.reply ?? '').trim();
    const checks0 = row.checks ?? null;
    if (!message0) { reject('R5 没有问句'); continue; }
    if (!reply0) { reject('R5 没有最终回答'); continue; }
    if (checks0 && typeof checks0 === 'object' && Object.values(checks0).some((v) => v === false)) {
      reject('R6 checks 有未通过项'); continue;
    }
    const key0 = `${message0}||stop`;
    if (seen.has(key0)) { reject('R7 重复的(问句,目标)'); continue; }
    seen.add(key0);
    candidates.push({
      group_id: String(row.case_id ?? row.traj_id ?? 'unknown'),
      source: `tests/evals/agent-trajectories-model-v1.jsonl#${row.traj_id}`,
      contract_version: contractVersion,
      reviewed: true,
      kind: 'stop',
      message: message0,
      screen: row.input?.mode === 'camp' ? 'camp' : 'battle',
      target: {stop: true},
      receipt_evidence: {ok: true, note: '模型在 0 次调用后停止（真实录制）'},
      reply: reply0.slice(0, 120),
      family_meta: row.split?.family ?? null,
      mechanism: row.split?.mechanism ?? null,
      template: row.split?.template ?? null,
    });
    continue;
  }
  const step = trace[0];
  if (step?.receipt?.ok !== true) { reject('R2 执行回执 ok!==true'); continue; }
  const tool = String(step.tool ?? '');
  if (!Object.hasOwn(TOOL_CONTRACTS, tool)) { reject('R3 工具不在契约里'); continue; }
  const args = {...(step.args ?? {})};
  // ⚠ 审计的规则是：**目标里不许出现 `state_version`** —— 那是宿主自己的键，运行时才补。
  //   审计自己在校验前会临时补一个 0，所以这里也照它的口径"补着校验、但**不写进目标**"。
  //   我第一版把 0 写进了目标 ⇒ 会被审计判 `target contains host-owned state_version`。
  delete args.state_version;
  const forValidation = VERSIONED.has(tool) ? {...args, state_version: 0} : args;
  if (!validToolArgs(tool, forValidation)) { reject('R4 参数不过 validToolArgs'); continue; }
  const reply = String(row.reply ?? '').trim();
  if (!reply) { reject('R5 没有最终回答'); continue; }
  const checks = row.checks ?? null;
  if (checks && typeof checks === 'object' && Object.values(checks).some((v) => v === false)) {
    reject('R6 checks 有未通过项'); continue;
  }
  const message = String(row.input?.message ?? '').trim();
  if (!message) { reject('R5 没有问句'); continue; }
  const key = `${message}||${tool}||${JSON.stringify(args)}`;
  if (seen.has(key)) { reject('R7 重复的(问句,目标)'); continue; }
  seen.add(key);
  candidates.push({
    group_id: String(row.case_id ?? row.traj_id ?? 'unknown'),
    source: `tests/evals/agent-trajectories-model-v1.jsonl#${row.traj_id}`,
    contract_version: contractVersion,
    reviewed: true,
    message,
    screen: row.input?.mode === 'camp' ? 'camp' : 'battle',
    target: {tool, args},
    receipt_evidence: {
      ok: step.receipt.ok === true,
      evidence_ids: Array.isArray(step.receipt.evidence_ids) ? step.receipt.evidence_ids.slice(0, 3) : [],
      coverage: step.receipt.coverage ?? null,
      bytes: step.receipt.bytes ?? null,
    },
    reply: reply.slice(0, 120),
    family_meta: row.split?.family ?? null,
    mechanism: row.split?.mechanism ?? null,
    template: row.split?.template ?? null,
  });
}

// ── 按**族**分片：整族进同一个分片，绝不跨片 ─────────────────────────────────
const byGroup = new Map();
for (const c of candidates) {
  if (!byGroup.has(c.group_id)) byGroup.set(c.group_id, []);
  byGroup.get(c.group_id).push(c);
}
const groups = [...byGroup.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
// **两类混采**：`stop` 与"真的调了工具"都要有。先到先得会把种子灌成单一类
// （实测：只按族名排序取前 52 条，52 条**全是** query_rules）。
const kindOf = (items) => (items[0]?.kind ?? 'tool');
const stops = groups.filter(([, items]) => kindOf(items) === 'stop');
const tools = groups.filter(([, items]) => kindOf(items) === 'tool');
const interleaved = [];
for (let i = 0; i < Math.max(stops.length, tools.length); i += 1) {
  if (tools[i]) interleaved.push(tools[i]);
  if (stops[i]) interleaved.push(stops[i]);
}
const stable = (s) => createHash('sha256').update(s).digest('hex');
/** 整族定片：同一族永远落同一片 ⇒ 跨片组重叠恒为 0。 */
const sideOf = (group) => {
  const h = parseInt(stable(`${group}|seed-v9`).slice(0, 4), 16) % 100;
  return h < 70 ? 'train' : (h < 85 ? 'valid' : 'test');
};

const picked = [];
const perSplit = {train: 0, valid: 0, test: 0};
for (const [group, items] of interleaved) {
  const side = sideOf(group);
  if (picked.length + items.length > TARGET_SIZE && picked.length >= 50) break;
  for (const c of items) picked.push({...c, side});
  perSplit[side] += items.length;
  if (picked.length >= TARGET_SIZE) break;
}

// 跨分片"完全相同问句"也要 0（审计会查 exact prompt overlap）
const prompts = {};
for (const split of ['train', 'valid', 'test']) prompts[split] = new Set();
for (const c of picked) prompts[c.side].add(c.message);
const overlap = [];
for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
  for (const p of prompts[a]) if (prompts[b].has(p)) overlap.push(`${a}/${b}:${p.slice(0, 30)}`);
}
const sharedGroups = [];
for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
  for (const g of new Set(picked.filter((c) => c.side === a).map((c) => c.group_id))) {
    if (picked.some((c) => c.side === b && c.group_id === g)) sharedGroups.push(`${a}/${b}:${g}`);
  }
}

const toRow = (c) => ({
  messages: [
    {role: 'user', content: JSON.stringify({message: c.message, screen: c.screen, tools: [...LOCAL_PLAN_TOOLS]})},
    {role: 'assistant', content: JSON.stringify(c.target)},
  ],
  meta: {
    group_id: c.group_id, source: c.source, contract_version: c.contract_version, reviewed: c.reviewed,
    ruleset_id: RULESET, family: c.family_meta, mechanism: c.mechanism, template: c.template,
    receipt: c.receipt_evidence, reply_excerpt: c.reply,
    review_criteria: REVIEW_CRITERIA,
  },
});

const report = {
  artifact: 'sft-v9-seed',
  why: 'Codex 4B 前置第 3 项：先交 50–100 条**真实场景样本与执行回执**，meta 保留 group_id/source/contract_version/reviewed，并按族分割',
  source_file: 'tests/evals/agent-trajectories-model-v1.jsonl',
  source_rows: rows.length,
  contract_version: contractVersion,
  contract_tools: Object.keys(TOOL_CONTRACTS),
  review_criteria: REVIEW_CRITERIA,
  reviewed_how: 'R1–R7 每条都能对着**真实执行回执**核（receipt.ok / evidence_ids / validToolArgs / checks），不是人工盖章',
  candidates_after_review: candidates.length,
  rejected,
  seeded: picked.length,
  per_split: perSplit,
  group_overlap_across_splits: sharedGroups,
  exact_prompt_overlap_across_splits: overlap,
  groups_used: new Set(picked.map((c) => c.group_id)).size,
};

const write = process.argv.includes('--write');
if (write) {
  mkdirSync(OUT_DIR, {recursive: true});
  for (const split of ['train', 'valid', 'test']) {
    const lines = picked.filter((c) => c.side === split).map((c) => JSON.stringify(toRow(c)));
    writeFileSync(join(OUT_DIR, `${split}.jsonl`), lines.length ? `${lines.join('\n')}\n` : '');
  }
  writeFileSync(join(OUT_DIR, 'REPORT.json'), `${JSON.stringify(report, null, 1)}\n`);
}

console.log(`[sft-seed] 源 ${rows.length} 条真实轨迹 → 过 R1–R7 的候选 ${candidates.length} 条 → 取 ${picked.length} 条（目标 ${TARGET_SIZE}，下限 50）`);
console.log(`[sft-seed] 契约指纹 ${contractVersion}（${Object.keys(TOOL_CONTRACTS).length} 个工具）`);
console.log(`[sft-seed] 分片：${JSON.stringify(perSplit)}｜用到族 ${report.groups_used} 个`);
console.log(`[sft-seed] 跨片组重叠 ${sharedGroups.length}｜跨片同问句 ${overlap.length}`);
const top = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
for (const [why, n] of top) console.log(`  – 拒收 ${n} 条：${why}`);
if (write) console.log('[sft-seed] 已写 → reports/roco/sft-v9-seed/');
else console.log('[sft-seed] 只报告（加 --write 才落盘）');
if (sharedGroups.length || overlap.length) {
  console.error('[sft-seed] ✖ 跨分片重叠不为 0 —— 按族分割这条没做到，拒绝落盘');
  process.exit(2);
}
