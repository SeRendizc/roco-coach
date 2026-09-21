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
import {execFileSync as gitExec} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'verification');
const OUT = join(OUT_DIR, 'latest.json');
// 最近一次**通过**的那次运行。只有它能在「套件全绿」时被更新。
//
// 为什么需要单独一份：原来只有 `latest.json`，而 `unit` 里有一条断言
// 「最近一次 verify:release 必须是 pass」。于是**一次失败就把闸门永久卡死**——
// 之后每次跑的 `unit` 都会因为上一次是红的而红，而 latest.json 只能靠一次成功的
// 运行变绿，成功的运行又必须先过 `unit`。唯一的出路是手改 latest.json，
// 那正是这个仓库最不该鼓励的动作。现在：
//   · `latest.json`   = 最近一次运行（任何结论），用来回答「刚刚跑得怎么样」；
//   · `last-green.json` = 最近一次**全绿**的运行，用来回答「上一次可信的闸门是什么时候」。
const LAST_GREEN = join(OUT_DIR, 'last-green.json');

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
  {id: 'sft-split', cmd: 'node', args: ['scripts/roco/verify-sft-split.mjs', '--quiet'],
    why: 'SFT 训练数据的切分：家族是否都在训练侧、留出有没有泄漏、'
      + '报告里的自我描述与切分模式是否自洽，以及**逐字节复现**。'
      + '第 37 轮发现报告把「留出机制」描述成「留出模板」，那一类错误只有这条抓得到'},
  {id: 'model-manifest', cmd: 'node', args: ['scripts/model/verify-manifest.mjs'],
    why: '本地权重与登记表是否同一份；换版不校验等于不知道跑的是什么'},
  {id: 'provenance', cmd: 'node', args: ['scripts/roco/verify-provenance.mjs'],
    why: '数据溯源：每条来源有可核对的锚点（归档哈希 / 逐文件清单）、'
      + '逐实体的 provenance 台账完整。「所有数据必须记录来源」这条边界从散文变成检查'},
  {id: 'state-doc', cmd: 'node', args: ['scripts/roco/verify-state-doc.mjs'],
    why: '状态文档与现实一致：声明的 HEAD 还在历史里、验证产物在、没有引用不存在的路径。'
      + '第 30 轮的教训是文档能漂，而读它的人会在错的前提上继续做事'},
  {id: 'guard-selftest', cmd: 'node', args: ['scripts/roco/guard-selftest.mjs'],
    why: '注入真实违规，验证登记过的守卫**真的会红**。它逐个改写仓库文件并恢复，'
      + '所以**不能**和并行跑的单测放在一起（会互相读到注入中的文件，'
      + '第 28 轮实测把结构契约搞成偶发红）——只能在这里串行跑'},
  {id: 'browser-acceptance', cmd: 'node', args: ['scripts/roco/browser-acceptance.mjs'],
    why: '**页面真的能开**。第 24 轮的回归只有这条抓得到', quick: true},
  {id: 'demo-acceptance', cmd: 'npm', args: ['run', 'roco:demo-acceptance'],
    why: '无聊天入口的完整演示链路；页面能开但演示链路断了也在这里', quick: true},
];

/** 清净的子进程环境：清掉测试运行器自己的变量（见 tests/helpers/subprocess.mjs 的说明）。 */
function childEnv() {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function run(suite) {
  const started = Date.now();
  try {
    const stdout = execFileSync(suite.cmd, suite.args,
      {cwd: ROOT, encoding: 'utf8', timeout: 1800000, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv()});
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
  if (report.verdict === 'pass') {
    let head = null;
    try {
      head = gitExec('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
    } catch { /* 没有 git 时留 null，报告里能看出来 */ }
    writeFileSync(LAST_GREEN, `${JSON.stringify({
      generated_by: 'scripts/roco/verify-release.mjs',
      quick,
      verdict: 'pass',
      head,
      suites: rows.map((row) => row.id),
      ran_at: new Date().toISOString(),
      note: '只有全部套件通过时才会被写。`latest.json` 可能是红的，这一份一定是绿的。',
    }, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify({verdict: report.verdict, failed,
    ran: rows.map((r) => r.id)}, null, 1)}\n`);
  return failed.length ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
