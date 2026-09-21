#!/usr/bin/env node
// 版本化「环境先验」（Meta prior）构建器。
//
// 为什么需要它：匹配前不知道对手阵容，所以「队伍强不强」只能对着**版本环境分布**去说。
// 而在此之前，仓库里**没有任何机器可检查的地方**记着「这一版环境有哪些体系、每个体系凭什么被识别、
// 占比是多少、哪些结论根本没证据」。一条没有检查的边界，它真正的状态是「没人知道」——
// 于是它一定会被手写的 T0 榜单填满。
//
// 这个构建器只做三件事：
//   ① 从 RC-302 已经注册的判据里取出「体系靠什么被识别」（feature_axes[].criterion 直接引用
//      src/coach/team-gaps.js#DIMENSION_CRITERIA 的键，**不许自创形容词**）；
//   ② 把种子物种在 GameDataPack v2 的 pet 实体上真的核一遍（不存在的名字直接拒绝构建）；
//   ③ 写分布时 **fail closed**：没有逐条可核对的来源，就只允许写 `unknown` + `value: null` + `reason`。
//      这是本任务最重要的一条：不许拿一个看起来合理的数字去填环境占比。
//
// 运行是确定性的：输出里**没有挂钟时间戳**，时间信息只来自 `as_of` 与各来源的 date。
//
// 跑法：
//
//     node scripts/roco/build-meta-prior.mjs            # 写 data/roco/meta-prior/v1.json
//     node scripts/roco/build-meta-prior.mjs --check    # 只核对磁盘上的 v1.json 是否与重建结果一致
//     node scripts/roco/build-meta-prior.mjs --json     # 把构建结果打到 stdout（不写盘）
//     node scripts/roco/build-meta-prior.mjs --selftest # 自带正反用例
//
// 退出码：0 = 干完了；1 = 有必红方向被触发。

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import {
  DEFAULT_META_PRIOR_PATH,
  ROOT,
  buildMetaPrior,
  checkAgainstBuild,
  formatProblem,
  loadRepoData,
  selftest,
  stableStringify,
  validateMetaPrior,
} from './meta-prior-lib.mjs';

const write = (text) => process.stdout.write(text);

/**
 * 先构建，再自校验。**构建器自己也要过校验器**：一份构建器写得出、校验器读不过的先验，
 * 等于把问题留给下一个读它的人。
 */
function build({root = ROOT} = {}) {
  const repo = loadRepoData({root});
  const document = buildMetaPrior({repo, asOf: '2026-09-21'});
  const report = validateMetaPrior(document, {root, repo});
  return {document, report, text: stableStringify(document)};
}

function humanSummary(report) {
  const summary = report.summary || {};
  const lines = [];
  lines.push(`体系 ${summary.archetypes ?? 0} 个 · 逐条证据 ${summary.evidence ?? 0} 条 · 种子物种 ${summary.seed_species ?? 0} 个`);
  lines.push(`证据等级分布：${JSON.stringify(summary.evidence_confidence || {})}`);
  lines.push(`分布形态：${summary.distribution_source ?? '(无)'}`
    + `（measured ${summary.distribution?.measured ?? 0} 项 / unknown ${summary.distribution?.unknown ?? 0} 项）`);
  lines.push(`版本作用域：${JSON.stringify(summary.version_scope || {})}`);
  return lines.join('\n');
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

  let built;
  try {
    built = build();
  } catch (error) {
    write(`构建失败：${error.message}\n`);
    return 1;
  }

  if (!built.report.ok) {
    write('构建结果没过校验器——先修判据，不写盘：\n');
    for (const row of built.report.problems) write(`  ${formatProblem(row)}\n`);
    return 1;
  }

  if (argv.includes('--json')) {
    write(built.text);
    return 0;
  }

  const target = join(ROOT, DEFAULT_META_PRIOR_PATH);
  if (argv.includes('--check')) {
    const onDisk = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (onDisk === null) {
      write(`--check 失败：磁盘上没有 ${DEFAULT_META_PRIOR_PATH}\n`);
      return 1;
    }
    const compared = checkAgainstBuild({built: built.text, onDisk});
    write(`${compared.ok ? 'PASS' : 'FAIL'} --check：${compared.reason}\n`);
    if (!compared.ok) return 1;
    write(`${humanSummary(built.report)}\n`);
    return 0;
  }

  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, built.text);
  write(`写入 ${DEFAULT_META_PRIOR_PATH}\n${humanSummary(built.report)}\n`);
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === `file://${resolve(process.argv[1])}` : false;
if (invoked) process.exit(main(process.argv.slice(2)));

export {build, main};
