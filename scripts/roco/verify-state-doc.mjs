#!/usr/bin/env node
// 状态文档与现实的一致性检查。
//
// 存在理由（第 30 轮的教训）：`DSH-EXECUTION-STATE.md` 里写着「判定层已在真实页面生效」，
// 而它其实一直没生效——文档说的是**当时以为**的事，不是**现在**的事。
// 文档一旦能漂，后面每个读它的人（包括我）都会在错的前提上继续做事。
//
// 这个脚本只核对**机器可核对**的那几项：声明的 HEAD 是不是当前历史的祖先、
// 声明的验证产物是否存在、登记的证据文件路径是否真的在磁盘上。
// 它**不**核对散文里的技术断言——那些只能靠代码与量测，不能被这个脚本替代。
//
// 跑法::
//
//     node scripts/roco/verify-state-doc.mjs
//     node scripts/roco/verify-state-doc.mjs --json

import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const DOC = join(ROOT, 'docs', 'roadmap', 'DSH-EXECUTION-STATE.md');

/**
 * 从文本里抽出所有反引号包起来的、看起来像提交哈希的片段。
 *
 * 只认 7—40 位十六进制：`round8`、`v1`、`0.6` 这类不该被当成哈希。
 * 这是**保守**的取法——漏掉几个可以接受，误报（把普通标识当哈希）会让检查失去意义。
 */
export function hashesIn(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/`([0-9a-f]{7,40})`/g)) {
    const value = match[1];
    // 纯数字不是哈希（例如 20260921 这种日期/种子）
    if (/^\d+$/.test(value)) continue;
    found.add(value);
  }
  return [...found];
}

/** 从「当前 HEAD 与工作区」那一节里取声明的 HEAD。 */
export function declaredHead(text) {
  const match = /^\|\s*HEAD\s*\|\s*`([0-9a-f]{7,40})`/m.exec(String(text));
  return match ? match[1] : null;
}

export function check({doc = DOC, root = ROOT} = {}) {
  const git = (args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const problems = [];
  if (!existsSync(doc)) return {ok: false, problems: [`找不到状态文档：${doc}`]};
  const text = readFileSync(doc, 'utf8');

  const head = git(['rev-parse', 'HEAD']);
  const declared = declaredHead(text);
  if (!declared) {
    problems.push('状态文档里找不到「| HEAD | `<hash>`」这一行——无法核对它说的是哪一次');
  } else {
    // 声明的 HEAD 必须**仍然在历史里**（是当前 HEAD 的祖先或就是它）。
    // 允许它是祖先，是因为文档写完之后还会提交（例如写文档本身的那一次）；
    // 不允许的是「文档说的是一个不在历史里的提交」——那种情况要么写错了，
    // 要么历史被改过，两种都必须停下来查。
    let ancestor = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', declared, head], {cwd: root, stdio: 'pipe'});
    } catch {
      ancestor = false;
    }
    if (!ancestor) {
      problems.push(`状态文档声明的 HEAD ${declared} 不是当前 HEAD ${head.slice(0, 7)} 的祖先`
        + '（历史被改过，或者哈希写错了）');
    } else if (!head.startsWith(declared) && !declared.startsWith(head)) {
      // 祖先关系成立但落后了：只提示，不当失败——文档落后一次提交是正常的。
      // 但**落后太多**通常意味着有人忘了更新它。
      const behind = Number(git(['rev-list', '--count', `${declared}..${head}`]));
      // 12 是**观测到的实际落后量**（第 27—30 轮期间文档落后 4—5 个提交仍算合理），
      // 留一倍余量。写死这个数的风险是「落后 13 个提交就不再算错」，
      // 所以真正的防线是把它放进 verify:release：每轮收尾都会跑一次。
      if (behind > 12) {
        problems.push(`状态文档的 HEAD 落后当前 ${behind} 个提交：它说的「现状」已经很久不是现状了`);
      }
    }
  }

  // 文档里提到的、必须存在的验证产物
  const artifacts = [
    'reports/roco/verification/latest.json',
    'reports/roco/verification',
  ];
  for (const rel of artifacts) {
    if (!existsSync(join(root, rel))) problems.push(`文档依赖的验证产物不存在：${rel}`);
  }

  // 最新一次 verify:release 必须是 pass，且套件数不为零
  const latest = join(root, 'reports', 'roco', 'verification', 'latest.json');
  let latestReport = null;
  if (existsSync(latest)) {
    try {
      latestReport = JSON.parse(readFileSync(latest, 'utf8'));
      if (latestReport.verdict !== 'pass') {
        problems.push(`最近一次 verify:release 不是 pass（${latestReport.verdict}）：`
          + `失败套件 ${JSON.stringify(latestReport.failed)}`);
      }
      if (!Array.isArray(latestReport.suites) || latestReport.suites.length < 8) {
        problems.push(`最近一次的套件数只有 ${latestReport.suites?.length ?? 0} 个，少于清单应有的数量`);
      }
      for (const suite of latestReport.suites || []) {
        if (!suite.ok) problems.push(`套件 ${suite.id} 最近一次是失败的`);
      }
    } catch (error) {
      problems.push(`latest.json 读不出来：${error.message}`);
    }
  }

  // 文档里引用的、形如 `reports/...` 的路径抽样核对：至少目录/文件真的在
  const referenced = new Set([...text.matchAll(/`(reports\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]));
  const missingRefs = [];
  for (const rel of referenced) {
    const path = join(root, rel);
    // 允许通配写法（round8..round30-*.log）与目录
    if (rel.includes('*') || rel.includes('..')) continue;
    if (!existsSync(path)) missingRefs.push(rel);
  }
  if (missingRefs.length) {
    problems.push(`文档引用了不存在的产物路径：\n  ${missingRefs.slice(0, 8).join('\n  ')}`);
  }

  return {
    ok: problems.length === 0,
    head,
    declared_head: declared,
    suites: latestReport?.suites?.length ?? null,
    referenced_artifacts: referenced.size,
    problems,
  };
}

function main(argv) {
  const report = check();
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else {
    process.stdout.write(`状态文档：声明 HEAD ${report.declared_head ?? '（缺）'}，当前 ${report.head.slice(0, 7)}，`
      + `最近验证套件 ${report.suites ?? '（缺）'} 个\n`);
    if (report.ok) process.stdout.write('一致\n');
    else process.stdout.write(`不一致：\n  ${report.problems.join('\n  ')}\n`);
  }
  return report.ok ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
