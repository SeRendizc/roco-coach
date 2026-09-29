#!/usr/bin/env node
/**
 * 从真实轨迹里抽**待审候选**（**不是** reviewed 数据集）。
 *
 * ## 为什么重做（Codex 2026-09-29 02:03 巡检的纠偏，逐条成立）
 *
 * 第一版（`build-sft-seed.mjs` → `reports/roco/sft-v9-seed/`）把
 * **历史模型输出 + 工具回执 ok** 当成了**黄金标签**，这是错的。实测到的三条：
 *
 * 1. **「为什么这一手要防御？」被标 `stop`**，而 `reply` 是「这次没有查到可用的规则事实（complete），
 *    未核验的部分我不编。」—— 这是一条**真实失败轨迹**，不是正确的任务决策；
 *    同一句在数据里出现 **12 次**（只换措辞/锁定前缀）。
 * 2. **「化蝶是哪一只」的目标是 `pet_000225`** —— 而 `pet_000225` 是**寂灭骨龙**
 *    （化蝶是 `pet_000124`）；另一行还给过 `pet_000190`。**目标语义本身就错**。
 * 3. **同一语义族跨片**：`be-defense-f0-01/f0-02` 在 train、`f1-02` 在 valid、`f2-02` 在 test。
 *    ⇒ 第一版按 `case_id` 分组，而那是**措辞变体**不是语义族
 *    （实测：`case_id` **288** 个 vs 去掉 `-fN-N` 后的语义族 **27** 个）。
 *    所以"88 族、跨片 0 重叠"**技术为真、语义无意义**。
 *
 * ## 这一版怎么改
 *
 * · `reviewed` **一律 false**，`review_status: 'candidate-pending-human-review'`
 *   —— **不许**拿它当训练数据（`train_v9.sh` 的 READY.json 也不许据此生成）；
 * · **语义族** = `case_id` 去掉 `-fN-N` 后缀（27 个），**按语义族整族分片**，断言跨片 0 重叠；
 * · 逐行打**审查标记**：`reply_is_failure`（回复自述"没查到事实"）、
 *   `target_entity_not_in_question`（`pet_id` 指的那只**名字没出现在问句里** ⇒ 疑似错标）；
 * · 出**逐条审查表**（markdown），让人能一行一行看。
 *
 * ## 缺什么（**不用样本条数掩盖**）
 *
 * Codex 指出「补关键工具任务」。实测**这批录制给不出**：非 `query_rules` 的工具
 * （`compare_actions` 8 步 / `read_state` 4 / `read_last_turn` 3）**回执 `ok` 全是 0**。
 * ⇒ 要覆盖它们**必须另找成功录制或人工构造**，本脚本**不编**，如实写在报告里。
 *
 * 用法：node scripts/roco/build-sft-candidates.mjs [--write]
 */

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCAL_PLAN_TOOLS, TOOL_CONTRACTS, validToolArgs} from '../../src/coach/toolbox.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// ⚠ 2026-09-29（阶段 3）**补关键工具覆盖**：第一版只读了一个文件，
// 于是我在报告里写了"compare_actions/evaluate_team 这批录制给不出"—— **那句话是错的**：
// 仓里另一份 `agent-trajectories-v1.jsonl`（8.8MB）里，`evaluate_team` **101/101 ok**、
// `compare_team_change` **94/94 ok**。所以候选集**可以**覆盖它们，**不必靠加条数掩盖**。
const SRCS = [
  join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.jsonl'),
  join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.jsonl'),
];
const OUT_DIR = join(ROOT, 'reports', 'roco', 'sft-v9-candidates');
const TARGET_SIZE = Number(process.env.ROCO_CANDIDATE_SIZE || 90);
const VERSIONED = new Set(['query_rules', 'evaluate_team', 'compare_team_change', 'plan_actions', 'summarize_battle']);

/** **语义族**：`case_id` 去掉措辞变体后缀 `-fN-N`。 */
const semanticFamily = (caseId) => String(caseId ?? '').replace(/-f\d+-\d+$/, '') || 'unknown';

/** 回复自述"没查到事实" ⇒ 这条轨迹是**失败**，不是正确决策。 */
const FAILURE_REPLY = /没有查到可用的规则事实|没查到事实|这条我没依据|连不上服务端的资料|暂时无法/;

const contractVersion = `tools:${createHash('sha256')
  .update(JSON.stringify({contract: Object.keys(TOOL_CONTRACTS), localPlan: [...LOCAL_PLAN_TOOLS]}))
  .digest('hex').slice(0, 12)}`;

/** `pet_id` → 这一只的所有名字（图鉴里的 `title`/`name`）。用来判断"目标是那只吗"。 */
const PET_NAMES = (() => {
  const map = new Map();
  try {
    const cat = JSON.parse(readFileSync(join(ROOT, 'data', 'roco', 'normalized',
      'roco-world-s4-2026-09-10', 'full-catalog.json'), 'utf8'));
    for (const e of (cat.pets ?? [])) {
      const names = [e.title, e.name].filter((x) => typeof x === 'string' && x);
      if (e.pet_id) map.set(String(e.pet_id), names);
    }
  } catch { /* 图鉴读不到就退化成"全都不可核"，如实标出来 */ }
  return map;
})();

const rows = [];
for (const src of SRCS) {
  if (!existsSync(src)) continue;
  for (const line of readFileSync(src, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    // ⚠ 两个文件的首行都是 **header**（`record_type: 'agent_trajectory_header'`）——
    //    不过滤就会把 header 当成一条轨迹。
    if (r.record_type !== 'agent_trajectory') continue;
    rows.push({...r, __src: src.split('/').pop()});
  }
}

const rejected = {};
const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; };

const candidates = [];
const seen = new Set();
for (const row of rows) {
  const trace = Array.isArray(row.trace) ? row.trace : [];
  if (trace.length > 1) { reject('多步（留后续）'); continue; }
  const message = String(row.input?.message ?? '').trim();
  const reply = String(row.reply ?? '').trim();
  if (!message || !reply) { reject('缺问句或回答'); continue; }
  const checks = row.checks ?? null;
  if (checks && typeof checks === 'object' && Object.values(checks).some((v) => v === false)) continue;

  let target = null;
  if (trace.length === 0) target = {stop: true};
  else {
    const step = trace[0];
    if (step?.receipt?.ok !== true) { reject('执行回执 ok!==true'); continue; }
    const tool = String(step.tool ?? '');
    if (!Object.hasOwn(TOOL_CONTRACTS, tool)) { reject('工具不在契约里'); continue; }
    const args = {...(step.args ?? {})};
    delete args.state_version;
    const forValidation = VERSIONED.has(tool) ? {...args, state_version: 0} : args;
    if (!validToolArgs(tool, forValidation)) { reject('参数不过 validToolArgs'); continue; }
    target = {tool, args};
  }

  const key = `${message}||${JSON.stringify(target)}`;
  if (seen.has(key)) { reject('重复(问句,目标)'); continue; }
  seen.add(key);

  // ── 逐行审查标记（**这些就是"待审"的理由**）────────────────────────────
  const flags = [];
  if (FAILURE_REPLY.test(reply)) flags.push('reply_is_failure');
  const targetId = target.tool ? String(target.args?.pet_id ?? '') : '';
  if (targetId) {
    // `pet_id` 指的那只，**名字有没有出现在问句里**？没有 ⇒ 疑似错标。
    // 「化蝶是哪一只？」目标是 `pet_000225`（寂灭骨龙）就是这么抓到的。
    // 名字表来自图鉴（`full-catalog.json`），不是从问句里猜的。
    const names = PET_NAMES.get(targetId) ?? [];
    const mentioned = names.some((n) => n && message.includes(n));
    if (!mentioned) flags.push('target_entity_not_in_question');
  }
  candidates.push({
    semantic_family: semanticFamily(row.case_id),
    wording_variant: String(row.case_id ?? ''),
    source: `tests/evals/${row.__src}#${row.traj_id ?? row.case_id}`,
    message, screen: row.input?.mode === 'camp' ? 'camp' : 'battle',
    target, reply: reply.slice(0, 120),
    flags,
    review_status: 'candidate-pending-human-review',
    reviewed: false,
    contract_version: contractVersion,
    ruleset_id: 'roco-world-s4-2026-09-10',
  });
}

// ── 按**语义族**整族分片（不是按措辞变体）────────────────────────────────
const byFamily = new Map();
for (const c of candidates) {
  if (!byFamily.has(c.semantic_family)) byFamily.set(c.semantic_family, []);
  byFamily.get(c.semantic_family).push(c);
}
const hash = (s) => createHash('sha256').update(s).digest('hex');
const sideOf = (family) => {
  const h = parseInt(hash(`${family}|candidates-v2`).slice(0, 4), 16) % 100;
  return h < 70 ? 'train' : (h < 85 ? 'valid' : 'test');
};
// ⚠ 2026-09-29（阶段 3）**第二个"先到先得"的坑，这次在族级**：
// 第一版按族名排序取到 90 条就 `break` ⇒ 只写完**排序最前的 4 个族**
// （`be-defense/be-energy/be-loss/cs-answered`），而携带 `evaluate_team` / `compare_team_change`
// 的 `rc-eval` / `rc-swap` **永远轮不到** ⇒ 关键工具覆盖为 0。
// ⇒ 按**目标工具种类**轮转选族，保证每种关键工具都真的进来，再按族补足。
const kindOfTarget = (c) => (c.target.stop ? 'stop' : c.target.tool);
const familyKind = new Map();
for (const [family, items] of byFamily) {
  const kinds = items.reduce((a, c) => (a[kindOfTarget(c)] = (a[kindOfTarget(c)] ?? 0) + 1, a), {});
  familyKind.set(family, Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0]);
}
const byKind = new Map();
for (const [family, items] of [...byFamily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const k = familyKind.get(family);
  if (!byKind.has(k)) byKind.set(k, []);
  byKind.get(k).push([family, items]);
}
// 轮转：每轮从每种工具各取一个族 ⇒ 种类覆盖先于条数
const order = [];
for (let i = 0; order.length < byFamily.size; i += 1) {
  let added = false;
  for (const list of byKind.values()) { if (list[i]) { order.push(list[i]); added = true; } }
  if (!added) break;
}
const picked = [];
const perSplit = {train: 0, valid: 0, test: 0};
const pickedKinds = new Set();
for (const [family, items] of order) {
  const side = sideOf(family);
  for (const c of items) { picked.push({...c, side}); pickedKinds.add(kindOfTarget(c)); }
  perSplit[side] += items.length;
  // 只有在**所有出现过的工具种类都已被覆盖**之后，才允许按条数截断
  const allKinds = new Set([...byFamily.values()].flat().map(kindOfTarget));
  const covered = [...allKinds].every((k) => pickedKinds.has(k));
  if (picked.length >= TARGET_SIZE && covered) break;
}
const familyOfSide = (side) => new Set(picked.filter((c) => c.side === side).map((c) => c.semantic_family));
const sharedFamilies = [];
for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
  for (const f of familyOfSide(a)) if (familyOfSide(b).has(f)) sharedFamilies.push(`${a}/${b}:${f}`);
}

const report = {
  artifact: 'sft-v9-candidates',
  status: 'CANDIDATES — 待人工审查，**不得**直接当训练数据',
  why: 'Codex 02:03 纠偏：历史模型输出 + 工具回执 ok **不是**黄金标签（「为什么这一手要防御？」被标 stop 而 reply 是"没查到事实"；「化蝶是哪一只」目标是寂灭骨龙 pet_000225）',
  corrections_vs_v1: [
    'reviewed 一律 false（v1 写成 true 是错的）',
    '按**语义族**分片（v1 按 case_id=措辞变体，288 个 vs 语义族 27 个）',
    '逐行打审查标记，并出逐条审查表',
  ],
  source_files: SRCS.map((f) => f.replace(`${ROOT}/`, '')),
  source_rows: rows.length,
  contract_version: contractVersion,
  semantic_families_total: byFamily.size,
  wording_variants_total: new Set(candidates.map((c) => c.wording_variant)).size,
  candidates: picked.length,
  per_split: perSplit,
  semantic_family_overlap_across_splits: sharedFamilies,
  flagged: {
    reply_is_failure: picked.filter((c) => c.flags.includes('reply_is_failure')).length,
    target_entity_not_in_question: picked.filter((c) => c.flags.includes('target_entity_not_in_question')).length,
    clean: picked.filter((c) => c.flags.length === 0).length,
  },
  target_kinds_covered: [...new Set(picked.map((c) => (c.target.stop ? 'stop' : c.target.tool)))].sort(),
  target_distribution: picked.reduce((acc, c) => {
    const k = c.target.stop ? 'stop' : c.target.tool;
    acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {}),
  rejected,
  key_tool_coverage: {
    note: '关键工具覆盖（Codex 要求"补关键工具任务，不用扩大条数掩盖"）—— 已用**第二份录制**补上。',
    first_attempt_error: '第一版只读一个文件，于是报告里写"evaluate_team 这批给不出"——**那句话是错的**。',
    measured_second_source: {evaluate_team: '101 步 / ok 101', compare_team_change: '94 步 / ok 94'},
    still_missing: {compare_actions: 'ok 0', read_state: 'ok 0', read_last_turn: 'ok 0',
      simulate_branch: 'ok 0', read_evidence: 'ok 0'},
    verdict: 'evaluate_team / compare_team_change 已可覆盖；其余仍缺 —— 如实列出，不编。',
  },
};

const write = process.argv.includes('--write');
if (write) {
  mkdirSync(OUT_DIR, {recursive: true});
  for (const split of ['train', 'valid', 'test']) {
    const lines = picked.filter((c) => c.side === split).map((c) => JSON.stringify({
      messages: [
        {role: 'user', content: JSON.stringify({message: c.message, screen: c.screen, tools: [...LOCAL_PLAN_TOOLS]})},
        {role: 'assistant', content: JSON.stringify(c.target)},
      ],
      meta: {
        group_id: c.semantic_family, wording_variant: c.wording_variant, source: c.source,
        contract_version: c.contract_version, ruleset_id: c.ruleset_id,
        reviewed: false, review_status: c.review_status, review_flags: c.flags,
        reply_excerpt: c.reply,
      },
    }));
    writeFileSync(join(OUT_DIR, `${split}.jsonl`), lines.length ? `${lines.join('\n')}\n` : '');
  }
  // **逐条审查表**（人能一行一行看）
  const md = ['# v9 候选 · 逐条审查表（**待审，不是训练数据**）', '',
    `- 生成：\`scripts/roco/build-sft-candidates.mjs\`｜契约指纹 \`${contractVersion}\``,
    `- 候选 ${picked.length} 条｜语义族 ${byFamily.size} 个（措辞变体 ${report.wording_variants_total} 个）`,
    `- 分片：${JSON.stringify(perSplit)}｜**语义族跨片重叠 ${sharedFamilies.length}**`,
    `- 标记：失败回复 **${report.flagged.reply_is_failure}**｜目标实体不可核 **${report.flagged.target_entity_not_in_question}**｜干净 **${report.flagged.clean}**`,
    '', '## 为什么要逐条看', '',
    '历史模型输出 **不是**黄金标签。三个已证实的反例：「为什么这一手要防御？」被标 `stop` 而回复是', '「这次没有查到可用的规则事实」；「化蝶是哪一只」的目标是 `pet_000225`（寂灭骨龙，不是化蝶）。', '',
    '| # | 片 | 语义族 | 问句 | 目标 | 回复（截断） | 标记 |', '|---|---|---|---|---|---|---|'];
  picked.forEach((c, i) => {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    md.push(`| ${i + 1} | ${c.side} | ${esc(c.semantic_family)} | ${esc(c.message.slice(0, 34))} | \`${esc(JSON.stringify(c.target))}\` | ${esc(c.reply.slice(0, 34))} | ${c.flags.join(' ') || '—'} |`);
  });
  writeFileSync(join(OUT_DIR, 'REVIEW-TABLE.md'), `${md.join('\n')}\n`);
  writeFileSync(join(OUT_DIR, 'REPORT.json'), `${JSON.stringify(report, null, 1)}\n`);
}

console.log(`[候选] 源 ${rows.length} 条真实轨迹 → 候选 ${picked.length}｜**语义族 ${byFamily.size}**（措辞变体 ${report.wording_variants_total}）`);
console.log(`[候选] 分片 ${JSON.stringify(perSplit)}｜**语义族跨片重叠 ${sharedFamilies.length}**${sharedFamilies.length ? ' ✖' : ' ✔'}`);
console.log(`[候选] 标记：失败回复 ${report.flagged.reply_is_failure}｜目标实体不可核 ${report.flagged.target_entity_not_in_question}｜干净 ${report.flagged.clean}`);
console.log(`[候选] 目标分布 ${JSON.stringify(report.target_distribution)}`);
console.log('[候选] **reviewed 一律 false** —— 这是待审候选，不得直接训练');
for (const [why, n] of Object.entries(rejected).sort((a, b) => b[1] - a[1])) console.log(`  – 拒收 ${n} 条：${why}`);
if (write) console.log('[候选] 已写 → reports/roco/sft-v9-candidates/（含 REVIEW-TABLE.md）');
if (sharedFamilies.length) { console.error('[候选] ✖ 语义族跨片重叠不为 0'); process.exit(2); }
