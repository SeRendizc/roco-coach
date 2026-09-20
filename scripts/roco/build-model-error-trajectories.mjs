#!/usr/bin/env node
// W4-02 的另一半：把**模型臂**产生的错误轨迹抽出来，逐条给出可核对的失败分类
// 与**候选**修复，做成目录。
//
// 与 `agent-trajectories-v1.jsonl` 的分工：那份有 4,536 条，但全是**规则臂**的；
// 这一份是**模型真的自己选工具**时留下的记录（`shadow-replay-local_4b.json`）。
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

import {writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const SOURCE = join(ROOT, 'reports', 'roco', 'shadow-replay-local_4b.json');
export const OUT = join(ROOT, 'tests', 'evals', 'roco', 'model-error-trajectories-v1.jsonl');

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

export function build({source = SOURCE} = {}) {
  const report = JSON.parse(readFileSync(source, 'utf8'));
  const rows = [];
  for (const row of report.rows) {
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
  if (!existsSync(SOURCE)) {
    process.stderr.write(`[model-errors] 找不到 ${SOURCE}；先跑 npm run roco:shadow-replay -- --arm local_4b\n`);
    return 2;
  }
  const {report, rows} = build();
  const summary = summarise(rows);
  const header = {
    record_type: 'model_error_trajectory_header',
    set_id: 'model-error-trajectories-v1',
    built_by: 'scripts/roco/build-model-error-trajectories.mjs',
    source: 'reports/roco/shadow-replay-local_4b.json',
    source_arm: report.arm,
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
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${[JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({written: !check, out: check ? null : OUT, summary}, null, 1)}\n`);
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
