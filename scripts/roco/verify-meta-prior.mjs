#!/usr/bin/env node
// 版本化「环境先验」（Meta prior）校验器。
//
// 判据全部在 `scripts/roco/meta-prior-lib.mjs` 里——构建器、校验器、测试跑的是**同一份**，
// 不复制成三份（复制出来的判据会各自漂移，最后谁也不知道哪一份算数）。
//
// 它核对的是**先验里到底写了什么**：
//   · 顶层 schema / meta_prior_id / version_scope（赛季 + ruleset_id + ruleset_config_id + as_of 缺一不可）
//     / derived_from（引用的台账、pack、ruleset、对账报告的 sha256 必须与磁盘一致）/ claim；
//   · archetypes[]：种子物种必须在 pack 的 pet 实体里逐字命中、feature_axes 必须复用 RC-302 的判据 ID、
//     evidence 每条可核对（http(s) 或仓内真实文件）+ 日期 + 台账六级等级、needs_recording；
//   · distribution[]：`measured` 必须有来源，`unknown` 必须 value === null 且有 reason；
//   · **任何层级**都不许出现胜率 / 榜单 / 强度分一类的键名（写成 null 也算）；
//   · usage.inputs 必须覆盖 RC-304 的五个口径。
//
// 它**不**判断「哪个体系更强」——本仓库现在没有任何真实对局数据，那正是这份先验把
// distribution 写成 unknown 的原因。校验器的工作是让这个 unknown 填不进假数。
//
// 跑法：
//
//     node scripts/roco/verify-meta-prior.mjs
//     node scripts/roco/verify-meta-prior.mjs --json
//     node scripts/roco/verify-meta-prior.mjs --selftest
//     node scripts/roco/verify-meta-prior.mjs --meta-prior /tmp/tampered.json
//
// `--meta-prior` 是给**取证**用的：报告里要贴「改坏之后真实的报错原文」，
// 而反证不许写盘改真文件。把改坏的副本写到 /tmp，再用这个开关指过去即可。

import {resolve} from 'node:path';

import {
  CONFIDENCE_LEVELS,
  ROOT,
  checkRepo,
  formatProblem,
  loadRepoData,
  selftest,
  stableStringify,
} from './meta-prior-lib.mjs';

const write = (text) => process.stdout.write(text);

function human(report) {
  const lines = [];
  const summary = report.summary || {};
  lines.push(`先验 ${report.meta_prior_path}`);
  lines.push(`  作用域 ${JSON.stringify(summary.version_scope || {})}`);
  lines.push(`  体系 ${summary.archetypes ?? 0} 个 · 逐条证据 ${summary.evidence ?? 0} 条 · 种子物种 ${summary.seed_species ?? 0} 个`);
  for (const level of CONFIDENCE_LEVELS) {
    lines.push(`  ${level}: ${summary.evidence_confidence?.[level] ?? 0}`);
  }
  lines.push(`  distribution：${summary.distribution_source ?? '(无)'}`
    + `（measured ${summary.distribution?.measured ?? 0} / unknown ${summary.distribution?.unknown ?? 0}）`);
  if (report.soft_problems?.length) {
    lines.push(`弱判据提示 ${report.soft_problems.length} 条（不判红，但要有人解释）：`);
    for (const row of report.soft_problems) lines.push(`  ${formatProblem(row)}`);
  }
  if (report.ok) {
    lines.push('判据逐条通过');
  } else {
    lines.push(`问题 ${report.problems.length} 条：`);
    for (const row of report.problems) lines.push(`  ${formatProblem(row)}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    if (argv.includes('--json')) {
      write(`${JSON.stringify(result, null, 1)}\n`);
    } else {
      for (const row of result.cases) {
        write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n`);
        write(`      期望：${row.want}\n      实际：${row.got}\n`);
      }
      write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n` : `自带用例失败 ${result.failed} 条\n`);
    }
    return result.ok ? 0 : 1;
  }

  const flag = argv.indexOf('--meta-prior');
  const metaPriorPath = flag >= 0 && argv[flag + 1] ? argv[flag + 1] : null;
  const repo = loadRepoData({root: ROOT});
  const report = checkRepo({root: ROOT, metaPriorPath, repo});

  if (argv.includes('--json')) {
    // `--json` 走 stdout 只放机器可读的结论；问题清单是给人看的，走 stderr。
    const payload = {
      ok: report.ok,
      meta_prior_path: report.meta_prior_path,
      summary: report.summary,
      criteria: report.criteria,
      problems: report.problems.map(formatProblem),
      soft_problems: report.soft_problems.map(formatProblem),
    };
    write(`${stableStringify(payload)}\n`);
    if (!report.ok) process.stderr.write(`先验问题 ${report.problems.length} 条：\n${report.problems.map(formatProblem).join('\n')}\n`);
    return report.ok ? 0 : 1;
  }

  write(human(report));
  return report.ok ? 0 : 1;
}

const invoked = process.argv[1] ? import.meta.url === `file://${resolve(process.argv[1])}` : false;
if (invoked) process.exit(main(process.argv.slice(2)));

export {main};
