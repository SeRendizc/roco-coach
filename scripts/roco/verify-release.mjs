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
import {dirname, join, relative} from 'node:path';
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
  {id: 'trajectories-model', cmd: 'node',
    args: ['scripts/roco/verify-agent-trajectories.mjs',
      '--trajectories', 'tests/evals/agent-trajectories-model-v1.jsonl', '--quiet'],
    why: 'W4-02 的第二半（模型候选轨迹）：同一把尺子、同一个判定器。'
      + '这一份**不声称字节可复现**（模型重跑会逐条不同），它靠 `model_identity` 钉住；'
      + '结构与离线回放仍然必须全过——模型臂的产物要是格式漂了，模型与规则就没法横向比'},
  {id: 'sft-split', cmd: 'node', args: ['scripts/roco/verify-sft-split.mjs', '--quiet'],
    why: 'SFT 训练数据的切分：家族是否都在训练侧、留出有没有泄漏、'
      + '报告里的自我描述与切分模式是否自洽，以及**逐字节复现**。'
      + '第 37 轮发现报告把「留出机制」描述成「留出模板」，那一类错误只有这条抓得到'},
  {id: 'model-manifest', cmd: 'node', args: ['scripts/model/verify-manifest.mjs'],
    why: '本地权重与登记表是否同一份；换版不校验等于不知道跑的是什么'},
  {id: 'provenance', cmd: 'node', args: ['scripts/roco/verify-provenance.mjs'],
    why: '数据溯源：每条来源有可核对的锚点（归档哈希 / 逐文件清单）、'
      + '逐实体的 provenance 台账完整。「所有数据必须记录来源」这条边界从散文变成检查'},
  {id: 'game-data-pack', cmd: 'node', args: ['scripts/roco/verify-game-data-pack.mjs'],
    why: 'RC-202：统一索引包 `data/roco/game-data-pack/v2/pack.json` 必须与 schema 一致、'
      + '逐实体 provenance 的 artifact_sha256 与磁盘对得上、licence_ref 在 sources.yaml 里找得到、'
      + '**REFERENCE_ONLY 不得进 distributable 分节**、unknown_fields 与冻结产物重算一致、'
      + '孤儿引用为 0、冲突未解决时**拒绝 ready**、就绪报告是最新的。'
      + '判据的牙在 `unit` 里（tests/roco-game-data-pack.test.js 16 条含 8 条必红反证）'
      + '以及两条脚本的 `--selftest`（10/10 与 11/11）'},
  {id: 'reconciliation', cmd: 'node', args: ['scripts/roco/verify-reconciliation.mjs', '--gate'],
    why: 'RC-201 §9 第 9 项：公网快照 + 对账产物接进闸门。判据三条 —— ①快照能由**本地 HTML**'
      + '逐字节重抽（不打网，确定性）；②报告的 reconciled/licence_ok 为真且四桶与许可登记齐全；'
      + '③**已提交的报告与"现在重算"一致**（忽略 generated_at），即报告没过期。'
      + '`--gate` 会先跑判据自检（5 条反证：reconciled=false / licence_ok=false / 离线重抽失败 / '
      + '报告过期 / 报告缺失），所以这条套件同时证明「现在是对的」与「错了会被发现」。'
      + '手工触发的对账会静默过期 —— 这条就是防它（本仓库已经吃过一次：'
      + 'agent-trajectories-verification-model.json 声称 1752/1752、实际 1644/1752）'},
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
    // **失败必须留全量输出**：`latest.json` 只留尾部几行，而「哪个用例红了」通常在中段。
    // 第 81 轮实测踩到：`unit` 在门禁里红、单跑却绿，而尾部只剩栈帧 —— 那是
    // 「有失败但不可诊断」。现在每次失败都落一份完整日志，并在 tail 里写出路径。
    const dir = join(ROOT, 'reports', 'roco', 'verification', 'failures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let fullLog = null;
    let note = '';
    try {
      mkdirSync(dir, {recursive: true});
      fullLog = join(dir, `${suite.id}-${stamp}.log`);
      writeFileSync(fullLog, `${suite.cmd} ${(suite.args ?? []).join(' ')}\n\n${output}\n`);
      note = `\n[full log] ${relative(ROOT, fullLog)}`;
    } catch (writeError) {
      note = `\n[full log] 写入失败：${writeError?.message ?? writeError}`;
    }
    return {id: suite.id, why: suite.why, ok: false, ms: Date.now() - started,
      full_log: fullLog ? relative(ROOT, fullLog) : null,
      tail: output.split('\n').slice(-12).join('\n') + note};
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
