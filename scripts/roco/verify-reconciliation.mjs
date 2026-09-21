#!/usr/bin/env node
// RC-201 §9 第 9 项：把「公网快照 + 对账」接进 release gate。
//
// 为什么需要它：对账是我手工触发的一次动作。手工动作会在两种情况下静默失效——
//   ① 快照被抓坏了（或 HTML 被删了），`--check --offline` 才是唯一确定性的判据；
//   ② 有人改了冻结层或抽取口径却忘了重跑对账，仓库里躺着一份**过期**的报告，
//      而所有人仍在引用它（本仓库已经吃过一次：`agent-trajectories-verification-model.json`
//      声称 replay 1752/1752、实际只有 1644/1752）。
//
// 判据（三条，任一不过 rc=1）：
//   ① 快照的 `result` 段能由**本地 HTML** 逐字节重抽（不打网，确定性）；
//   ② 报告的 `reconciled` / `licence_ok` 都为真，且四桶与许可登记齐全；
//   ③ **已提交的报告与"现在重算"的结果一致**（忽略 `generated_at`）——即报告是最新的。
//
// 跑法：`node scripts/roco/verify-reconciliation.mjs [--json]`

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildReport, latestLiveSnapshotPath, REPORT_PATH} from './reconcile-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/** 比较两份报告时忽略的易变字段（生成时间）。 */
export function stripVolatile(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generated_at;
  return copy;
}

/** 逐条判据（纯函数，便于测试直接反证）。返回问题列表。 */
export function judgeReconciliation({committed, fresh, offlineCheck}) {
  const problems = [];
  if (!committed) {
    problems.push(`已提交的对账报告不存在：${relative(ROOT, REPORT_PATH)}（先跑 node scripts/roco/reconcile-catalog.mjs）`);
    return problems;
  }
  if (offlineCheck && offlineCheck.rc !== 0) {
    problems.push(`快照不能由本地 HTML 确定性重抽（fetch --check --offline rc=${offlineCheck.rc}）：`
      + `${String(offlineCheck.tail ?? '').slice(0, 400)}`);
  }
  if (committed.reconciled !== true) {
    problems.push(`报告 reconciled=${committed.reconciled}（reason: ${String(committed.reason ?? '').slice(0, 200)}）`);
  }
  if (committed.licence_ok !== true) {
    problems.push(`报告 licence_ok=${committed.licence_ok}：公网内容的许可登记不齐（license/redistribution/license_evidence 必须都有）`);
  }
  const sizes = committed.bucket_sizes ?? {};
  for (const key of ['only_in_frozen', 'only_in_live', 'changed', 'unresolved']) {
    if (typeof sizes[key] !== 'number') problems.push(`报告缺少 bucket_sizes.${key}`);
  }
  if (fresh) {
    const a = JSON.stringify(stripVolatile(committed));
    const b = JSON.stringify(stripVolatile(fresh));
    if (a !== b) {
      // 不打印两份全文（几十 KB），只报差异位置，够定位。
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      problems.push('已提交的对账报告**不是最新的**：用当前输入重算的结果与它不一致'
        + `（首个差异在第 ${i} 字符附近：committed=${JSON.stringify(a.slice(i, i + 80))} `
        + `fresh=${JSON.stringify(b.slice(i, i + 80))}）。请重跑 node scripts/roco/reconcile-catalog.mjs`);
    }
  }
  return problems;
}

/**
 * 自检：判据本身必须**会红**。每条都用一份**内存副本**构造缺陷，不碰真产物。
 *
 * `--gate` 会先跑这一段再跑真实检查 —— 这样 release gate 里这条套件同时覆盖
 * 「现在是对的」与「错了会不会被发现」两件事。
 */
export function selftest() {
  const checks = [];
  const push = (name, ok, actual) => checks.push({name, ok: Boolean(ok), actual});
  const healthy = {
    reconciled: true,
    licence_ok: true,
    bucket_sizes: {only_in_frozen: 4, only_in_live: 0, changed: 0, unresolved: 4},
  };
  push('健康报告必须放行', judgeReconciliation({committed: healthy, fresh: healthy, offlineCheck: {rc: 0}}).length === 0);
  push('反证①：reconciled=false 必须红',
    judgeReconciliation({committed: {...healthy, reconciled: false}, fresh: healthy, offlineCheck: {rc: 0}})
      .some((p) => p.includes('reconciled=false')));
  push('反证②：licence_ok=false 必须红',
    judgeReconciliation({committed: {...healthy, licence_ok: false}, fresh: healthy, offlineCheck: {rc: 0}})
      .some((p) => p.includes('licence_ok=false')));
  push('反证③：离线重抽失败必须红',
    judgeReconciliation({committed: healthy, fresh: healthy, offlineCheck: {rc: 1, tail: 'boom'}})
      .some((p) => p.includes('确定性重抽')));
  push('反证④：报告过期（重算不一致）必须红',
    judgeReconciliation({committed: healthy, fresh: {...healthy, bucket_sizes: {...healthy.bucket_sizes, changed: 1}}, offlineCheck: {rc: 0}})
      .some((p) => p.includes('不是最新的')));
  push('反证⑤：报告不存在必须红',
    judgeReconciliation({committed: null, fresh: healthy, offlineCheck: {rc: 0}}).length > 0);
  const failed = checks.filter((c) => !c.ok);
  if (!process.argv.includes('--quiet')) {
    for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}`);
  }
  return failed.length ? 1 : 0;
}

function main() {
  const live = latestLiveSnapshotPath();
  if (!live) {
    console.error('[reconciliation] 找不到公网快照：data/roco/live/<date>/public-index.json。'
      + '先跑 node scripts/roco/fetch-live-snapshot.mjs');
    process.exit(1);
  }
  // ① 确定性重抽（用已落地 HTML，不打网）
  let offlineCheck = {rc: 0, tail: ''};
  try {
    const out = execFileSync('node', ['scripts/roco/fetch-live-snapshot.mjs', '--check', '--offline'],
      {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    offlineCheck = {rc: 0, tail: out};
  } catch (error) {
    offlineCheck = {rc: error.status ?? 1, tail: `${error.stdout || ''}\n${error.stderr || ''}`};
  }
  // ② 现状报告 + ③ 重算一遍对比
  const committedPath = REPORT_PATH;
  const committed = existsSync(committedPath) ? JSON.parse(readFileSync(committedPath, 'utf8')) : null;
  let fresh = null;
  try {
    fresh = buildReport();
  } catch (error) {
    fresh = null;
    offlineCheck.tail = `${offlineCheck.tail}\n重算失败：${error?.message ?? error}`;
  }
  const problems = judgeReconciliation({committed, fresh, offlineCheck});
  const summary = {
    live_snapshot: relative(ROOT, live),
    report: relative(ROOT, committedPath),
    reconciled: committed?.reconciled ?? null,
    licence_ok: committed?.licence_ok ?? null,
    bucket_sizes: committed?.bucket_sizes ?? null,
    offline_check_rc: offlineCheck.rc,
    report_is_fresh: fresh ? JSON.stringify(stripVolatile(committed)) === JSON.stringify(stripVolatile(fresh)) : null,
    problems,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[reconciliation] live=${summary.live_snapshot}`);
    console.log(`[reconciliation] reconciled=${summary.reconciled} licence_ok=${summary.licence_ok} `
      + `offline_check_rc=${summary.offline_check_rc} report_is_fresh=${summary.report_is_fresh}`);
    console.log(`[reconciliation] buckets=${JSON.stringify(summary.bucket_sizes)}`);
    for (const p of problems) console.log(`✖ ${p}`);
    if (!problems.length) console.log('✔ 对账产物是最新的，且许可登记齐全');
  }
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.includes('--selftest')) process.exit(selftest());
  // `--gate`：先跑自检（判据有没有牙），再跑真实检查（现在对不对）。
  if (argv.includes('--gate') && selftest() !== 0) {
    console.error('[reconciliation] 自检失败：判据本身有问题，真实检查的结论不可信');
    process.exit(1);
  }
  main();
}
