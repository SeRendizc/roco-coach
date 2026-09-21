#!/usr/bin/env node
// W4-02 的另一半：把**模型臂**产生的错误轨迹抽出来，逐条给出可核对的失败分类
// 与**候选**修复，做成目录。
//
// 与 `agent-trajectories-v1.jsonl` 的分工：那份有 6,048 条，但全是**规则臂**的；
// （条数以 `tests/evals/agent-trajectories-v1.manifest.json` 为准，别抄在这里。）
// 这一份是**模型真的自己选工具**时留下的记录（`shadow-replay-base.json`，基座臂）。
// 按 W4-02 的要求，错误轨迹与修复理由必须保存——这里保存的是
// **程序判定的失败分类**与**据此给出的候选修复**。
//
// 一条纪律：`candidate_fix` 是**候选**，不是已验证的修法。
// 没有任何一条被模型重新执行并确认修好——所以字段叫 candidate_ 而不是 fix_，
// 验收里也不许把它读成「已经修好了」。真正的修复轨迹要等 SFT 之后才可能产生。
//
// 跑法::
//
//     node scripts/roco/build-model-error-trajectories.mjs          # 生成
//     node scripts/roco/build-model-error-trajectories.mjs --check  # 只报统计

import {createHash} from 'node:crypto';
import {writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
// 源报告必须是**带身份的基座产物**。原来指向 `shadow-replay-local_4b.json`，
// 而那个文件每次跑模型臂都会被覆盖——所以这份目录声称的 `source_pass_rate`
// 与它指向的路径早就不是同一份东西了。现在指向显式的基座产物，并把摘要记下来。
export const SOURCE = join(ROOT, 'reports', 'roco', 'shadow-replay-base.json');
export const OUT = join(ROOT, 'tests', 'evals', 'roco', 'model-error-trajectories-v1.jsonl');
//: 第 41 轮：SFT 之后还剩哪些错。来源是**模型候选轨迹集**（走同一个判定器）。
export const SOURCE_AFTER_SFT = join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.jsonl');
export const OUT_AFTER_SFT = join(ROOT, 'tests', 'evals', 'roco', 'model-error-trajectories-v4.jsonl');

/**
 * 失败分类。每一类都对应一个**可核对的证据**与一个**候选修复**。
 *
 * 分类只看程序能判定的事实：走了哪条停止路径、调了什么工具、引擎报了什么错。
 * 不做「模型在想什么」的推测。
 */
export const FAILURE_CLASSES = [
  {
    id: 'asked-nothing',
    match: (row) => row.trace.length === 0 && row.stopped === 'invalid-arguments',
    evidence: '没有发出任何工具调用，而装配层因为参数装配被拒 → 停止原因是 invalid-arguments',
    candidate_fix: '这类任务在 hints 里有明确的 `target_kind`/`target_args`，模型却输出了非 JSON 或空动作；'
      + '候选修复是给推理侧加结构化输出约束（如 grammar/JSON schema），而不是继续加长提示'
      + '（第 23 轮的提示实验说明加长提示会加重犹豫）。',
  },
  {
    id: 'no-limitation-word',
    match: (row) => row.violations.some((v) => v.includes('限制')),
    evidence: '判据要求正文说清「未核验 / 没有端点 / 不支持」，实际没说',
    candidate_fix: '⚠️ 注意这条**不是模型文案问题**：正文由 `finalAnswer()` 的确定性模板生成，'
      + '模板在「引擎返回 ok 但没给结论」这一支上没有带上限制措辞。'
      + '候选修复是**改模板**，与模型无关——这条正好说明分类要落到正确的层。',
  },
  {
    id: 'stopped-without-tool',
    match: (row) => row.trace.length === 0 && row.stopped === 'complete',
    evidence: '返回了 {"stop":true}，而任务要求查一次',
    candidate_fix: '候选修复是在提示里把「默认停止」的边界收窄到「receipts 里已有答案」，'
      + '并用 few-shot 给出「有具体事实问题 → 必须查」的对照样例；需要重跑同一套判据验证。',
  },
  {
    id: 'wrong-tool',
    match: (row) => row.trace.length > 0 && row.violations.some((v) => v.includes('没有调用应当调用的工具')),
    evidence: '调了工具，但不是任务要求的那个（violations 里含「没有调用应当调用的工具」）',
    candidate_fix: '候选修复是按工具职责补一条路由规则说明（何时用 evaluate_team 而不是 query_rules、'
      + '何时用 compare_team_change 而不是 evaluate_team），再用同一套判据复测。',
  },
  {
    id: 'wrong-args',
    match: (row) => row.trace.length > 0 && row.violations.some((v) => v.includes('参数里没有同时满足')),
    evidence: '工具选对了，但参数不满足期望（violations 里含「参数里没有同时满足」）',
    candidate_fix: '候选修复是**参数级**监督：训练数据里给出「问题 → 正确的 kind + 定位参数」对，'
      + '而不是把参数名塞进提示（第 23 轮证明后者无效）。',
  },
  {
    id: 'engine-refused',
    match: (row) => row.trace.some((t) => t.error_type && t.error_type !== 'version_mismatch'),
    evidence: '引擎回了 error_type（如 not_found）：工具与参数格式合法，但指向了引擎里不存在的事实',
    candidate_fix: '候选修复是让模型先用名字查、拿回 id 再查细节（两跳），'
      + '而不是凭记忆编一个 id；这条需要 planner/toolbox 支持两跳，属接口改动。',
  },
  {
    // 这一类必须在**最后**：它按 `stopped` 兜底，放前面会把真正的模型失败吞掉。
    id: 'budget-or-policy',
    match: (row) => row.stopped === 'receipt-budget' || row.stopped === 'policy'
      || (row.stopped !== 'complete' && row.stopped !== 'invalid-arguments'),
    evidence: '停止原因是回执超预算或策略拦截，不是模型的判断',
    candidate_fix: '**不是模型缺陷**：分别属于回执体积与硬门控。'
      + '单列出来是为了不要把它们计入模型错误率。',
  },
];

export function classify(row) {
  for (const item of FAILURE_CLASSES) if (item.match(row)) return item;
  return {id: 'unclassified', evidence: '没有匹配到任何已知失败分类', candidate_fix: null};
}

/**
 * 读出源产物里的「一行一条结果」。
 *
 * 两种形状都认，因为这一层的两个来源本来就不同：
 *   · `shadow-replay-*.json`（JSON）：`report.rows`，判定结果在**顶层** `passed`/`violations`；
 *   · `agent-trajectories-*.jsonl`（JSONL）：头部一行 + 每行一条，判定结果在 `checks` 里。
 * 第一版只认前者，所以「用模型候选轨迹集重建目录」这件事做不了——
 * 而两种形状的差别只是**同一个判定器的结果放在哪一层**，不该成为阻碍。
 */
export function loadSource(source) {
  const raw = readFileSync(source, 'utf8');
  if (source.endsWith('.jsonl')) {
    const all = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const rows = all.filter((row) => row.record_type === 'agent_trajectory').map((row) => ({
      case_id: row.case_id, category: row.category, arm: row.arm,
      passed: row.checks?.passed === true, violations: row.checks?.violations ?? [],
      trace: row.trace, stopped: row.stopped, wall_ms: row.wall_ms ?? null,
      world: row.input?.world?.id ?? null,
    }));
    const header = all.find((row) => row.record_type === 'agent_trajectory_header') ?? {};
    return {report: {arm: header.arms?.[0] ?? 'local_4b', prompt_digest: header.prompt_digest ?? null,
      summary: {pass_rate: header.totals?.trajectories
        ? Number(((header.totals.passed ?? 0) / header.totals.trajectories).toFixed(4)) : null},
      identity: header.model_identity ?? null, rows}, rows};
  }
  const report = JSON.parse(raw);
  return {report, rows: report.rows};
}

export function build({source = SOURCE} = {}) {
  const {report, rows: sourceRows} = loadSource(source);
  const rows = [];
  for (const row of sourceRows) {
    if (row.passed) continue;
    const klass = classify(row);
    rows.push({
      record_type: 'model_error_trajectory',
      traj_id: `${row.case_id}#${row.arm}`,
      case_id: row.case_id,
      category: row.category,
      arm: row.arm,
      failure_class: klass.id,
      evidence: klass.evidence,
      violations: row.violations,
      tool_calls: row.trace,
      stopped: row.stopped,
      wall_ms: row.wall_ms,
      world: row.world ?? null,
      /** 候选修复：**未经复测**，不得读成「已修好」。 */
      candidate_fix: klass.candidate_fix,
      verified: false,
    });
  }
  return {report, rows};
}

export function summarise(rows) {
  const byClass = {};
  for (const row of rows) {
    const bucket = byClass[row.failure_class] || (byClass[row.failure_class] = {count: 0, categories: {}});
    bucket.count += 1;
    bucket.categories[row.category] = (bucket.categories[row.category] || 0) + 1;
  }
  return {total: rows.length, by_class: byClass,
    by_category: rows.reduce((acc, row) => {
      acc[row.category] = (acc[row.category] || 0) + 1; return acc;
    }, {})};
}

function main(argv) {
  const check = argv.includes('--check');
  const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  // 两个来源：基座那次（v1，找的是模板不诚实那类问题）与 SFT 之后那次（v4，看还剩什么）。
  const source = argv.includes('--after-sft') ? SOURCE_AFTER_SFT : arg('--source', SOURCE);
  const out = argv.includes('--after-sft') ? OUT_AFTER_SFT : arg('--out', OUT);
  const setName = argv.includes('--after-sft') ? 'model-error-trajectories-v4' : 'model-error-trajectories-v1';
  const relSource = relative(ROOT, source);
  if (!existsSync(source)) {
    process.stderr.write(`[model-errors] 找不到 ${source}\n`);
    return 2;
  }
  const {report, rows} = build({source});
  const summary = summarise(rows);
  const header = {
    record_type: 'model_error_trajectory_header',
    set_id: setName,
    built_by: 'scripts/roco/build-model-error-trajectories.mjs',
    source: relSource,
    // 源文件的**内容摘要**：只记路径不够——路径上的文件会被换掉，摘要不会。
    source_sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    source_arm: report.arm,
    source_identity: report.identity || null,
    source_prompt_digest: report.prompt_digest || null,
    source_pass_rate: report.summary.pass_rate,
    disciplines: [
      '这是**模型真的自己选工具**时的错误记录，不是规则臂的（规则臂在 agent-trajectories-v1.jsonl）',
      '失败分类只看程序可判定的事实（停止路径 / 调了什么工具 / 引擎报了什么错），不推测模型的意图',
      'candidate_fix 是**候选**：没有任何一条被重新执行并确认修好，verified 恒为 false',
      '预算与策略拦截单列一类，避免把它们算进模型错误率',
    ],
    summary,
  };
  if (!check) {
    mkdirSync(dirname(out), {recursive: true});
    writeFileSync(out, `${[JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({written: !check, out: check ? null : out, summary}, null, 1)}\n`);
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
