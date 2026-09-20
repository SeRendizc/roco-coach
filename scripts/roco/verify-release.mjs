#!/usr/bin/env node
// 一次跑完**发布前必须过**的验收，并把「跑了什么、结果是什么」落成产物。
//
// 存在理由（第 24 轮的事故）：浏览器验收有三轮没跑，期间一个静态 `node:*`
// 把页面整条 import 链打断，而 `test:unit` 一直全绿。问题不在某条测试，
// 而在于「哪些套件必须跑」只活在人的记忆里和状态文档的散文里。
// 这个脚本把它变成可执行的一份清单：跑完写 `reports/roco/verification/latest.json`，
// 任何一项失败就非零退出。
//
// 它不是新测试：只是把已有的验收按固定顺序跑一遍并记账。
//
// 跑法::
//
//     node scripts/roco/verify-release.mjs              # 全跑
//     node scripts/roco/verify-release.mjs --quick      # 跳过浏览器（无 Chrome 时用）

import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'verification');
const OUT = join(OUT_DIR, 'latest.json');

/**
 * 清单：`{id, cmd, args, why, quick}`。
 *
 * `why` 写的是**这条为什么必须在清单里**——不是「有这个测试」，而是
 * 「漏跑它会漏掉哪一类错误」。没有 why 的条目不该进来。
 */
export const SUITES = [
  {id: 'env', cmd: 'npm', args: ['run', 'test:env'],
    why: '规则引擎与 Python 服务的不变量；这一层坏了上层全是假的'},
  {id: 'unit', cmd: 'npm', args: ['run', 'test:unit'],
    why: '教练/判定器/轨迹/本地模型/结构契约；单测绿不等于页面能开，下面两条补这一刀'},
  {id: 'bridge', cmd: 'npm', args: ['run', 'test:bridge'],
    why: '桥的隐藏信息边界；这条只在 Node 侧，单测与浏览器都覆盖不到'},
  {id: 'toolbox-roco', cmd: 'npm', args: ['run', 'test:toolbox-roco'],
    why: '工具契约与 roco-client 的逐键镜像；漂了就静默给出错参数'},
  {id: 'plan-e2e', cmd: 'npm', args: ['run', 'test:plan-e2e'],
    why: '真 Python 服务的端到端规划；两边单测都绿而对不上，T02 阶段发生过'},
  {id: 'trajectories', cmd: 'node', args: ['scripts/roco/verify-agent-trajectories.mjs', '--quiet'],
    why: '轨迹集与判定器的两个方向；判定器写坏了只有这里看得见'},
  {id: 'model-manifest', cmd: 'node', args: ['scripts/model/verify-manifest.mjs'],
    why: '本地权重与登记表是否同一份；换版不校验等于不知道跑的是什么'},
  {id: 'browser-acceptance', cmd: 'node', args: ['scripts/roco/browser-acceptance.mjs'],
    why: '**页面真的能开**。第 24 轮的回归只有这条抓得到', quick: true},
  {id: 'demo-acceptance', cmd: 'npm', args: ['run', 'roco:demo-acceptance'],
    why: '无聊天入口的完整演示链路；页面能开但演示链路断了也在这里', quick: true},
];

function run(suite) {
  const started = Date.now();
  try {
    const stdout = execFileSync(suite.cmd, suite.args,
      {cwd: ROOT, encoding: 'utf8', timeout: 1800000, stdio: ['ignore', 'pipe', 'pipe']});
    return {id: suite.id, why: suite.why, ok: true, ms: Date.now() - started,
      tail: stdout.trim().split('\n').slice(-4).join('\n')};
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    return {id: suite.id, why: suite.why, ok: false, ms: Date.now() - started,
      tail: output.split('\n').slice(-12).join('\n')};
  }
}

export function runSuites({quick = false, log = () => {}} = {}) {
  const selected = SUITES.filter((suite) => !(quick && suite.quick));
  const rows = [];
  for (const suite of selected) {
    log(`… ${suite.id}`);
    const row = run(suite);
    rows.push(row);
    log(`  ${row.ok ? '✔' : '✖'} ${suite.id}（${Math.round(row.ms / 1000)}s）`);
  }
  return rows;
}

function main(argv) {
  const quick = argv.includes('--quick');
  const rows = runSuites({quick, log: (line) => process.stdout.write(`${line}\n`)});
  const failed = rows.filter((row) => !row.ok).map((row) => row.id);
  const report = {
    generated_by: 'scripts/roco/verify-release.mjs',
    quick,
    suites: rows.map((row) => ({...row, tail: row.tail.split('\n').slice(0, 4)})),
    failed,
    verdict: failed.length ? 'failed' : 'pass',
    note: '时间戳与耗时是易变字段；这里保留是因为它要回答「哪一次跑的」，'
      + '而稳定的验收产物各自另有落盘位置。',
  };
  mkdirSync(OUT_DIR, {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({verdict: report.verdict, failed,
    ran: rows.map((r) => r.id)}, null, 1)}\n`);
  return failed.length ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
