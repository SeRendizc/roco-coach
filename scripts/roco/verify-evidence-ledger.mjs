#!/usr/bin/env node
// 规则证据台账检查器：把「涉及规则的施工必须先分证据等级、必须写清来源、
// 需要实机的必须挂 microcase」从散文变成检查。
//
// 为什么需要它：v3 纠偏指令里有一条硬要求——涉及规则、强势阵容、技能/特性和 Meta
// 的任务必须先建 evidence ledger，禁止凭模型记忆、页游规则或单篇榜单施工。
// 但在此之前，仓库里**没有任何机器可检查的地方**记着“哪条规则是什么置信等级、
// 来源是什么、需不需要实机 microcase”。一条边界如果没有检查，它真正的状态是“没人知道”。
//
// 它核对的是**台账里到底写了什么**，不是“我们打算写什么”：
//   · 六个置信等级的定义齐全，且只有前两级能直接成为 current 规则；
//   · 每条规则有中文施工口径（claim）、有来源、有受影响产物清单；
//   · OFFICIAL_CURRENT / RECORDED_IN_GAME 必须有官方一手或录屏来源——
//     官方公告的媒体转载（official_reproduction）**不算**；
//   · CROSS_SOURCE_SUPPORTED 必须有两条 URL 不同的来源；
//   · needs_microcase=true 必须有形如 MC-E01 的 case，且该 case 真的在录屏清单里。
//
// 它**不**判断规则对不对（那要靠实机 microcase），也不联网核对 URL 是否可达。
//
// 跑法：
//
//     node scripts/roco/verify-evidence-ledger.mjs
//     node scripts/roco/verify-evidence-ledger.mjs --json
//     node scripts/roco/verify-evidence-ledger.mjs --selftest
//     node scripts/roco/verify-evidence-ledger.mjs --ledger /tmp/tampered.json
//
// `--ledger` 是给**取证**用的：报告里要贴“改坏之后真实的报错原文”，
// 而反证不许写盘改真台账。把改坏的副本写到 /tmp，再用这个开关指过去即可。

import {checkRepo, selftest, formatIssues, CONFIDENCE_ORDER} from './evidence-ledger-lib.mjs';
import {resolve} from 'node:path';

function human(report) {
  const lines = [];
  const summary = report.summary || {};
  lines.push(`台账条目 ${summary.entries ?? 0} 条，需实机 microcase ${summary.needs_microcase ?? 0} 条，`
    + `覆盖 topic ${(summary.topics || []).length} 个`);
  for (const level of CONFIDENCE_ORDER) {
    lines.push(`  ${level}: ${summary.confidence?.[level] ?? 0}`);
  }
  if (report.ok) {
    lines.push('证据等级、来源、microcase 三栏都写清了');
  } else {
    lines.push(`问题 ${report.issues.length} 条：`);
    for (const issue of report.issues) {
      lines.push(`  [${issue.rule}] ${issue.evidence_id} — ${issue.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    } else {
      for (const row of result.cases) {
        process.stdout.write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n`);
        process.stdout.write(`      期望：${row.want}\n      实际：${row.got}\n`);
      }
      process.stdout.write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n`
        : `自带用例失败 ${result.failed} 条\n`);
    }
    return result.ok ? 0 : 1;
  }
  const ledgerFlag = argv.indexOf('--ledger');
  const ledgerPath = ledgerFlag >= 0 && argv[ledgerFlag + 1] ? resolve(argv[ledgerFlag + 1]) : null;
  const report = checkRepo({ledgerPath});
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else process.stdout.write(human(report));
  if (!report.ok && !argv.includes('--json')) {
    process.stdout.write(`（问题原文共 ${report.issues.length} 条）\n`);
  }
  if (!report.ok && argv.includes('--json')) {
    process.stderr.write(`台账问题 ${report.issues.length} 条：\n${formatIssues(report.issues)}\n`);
  }
  return report.ok ? 0 : 1;
}

const invoked = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (invoked) process.exit(main(process.argv.slice(2)));

export {main};
