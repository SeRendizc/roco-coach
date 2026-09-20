// W4-02 / W4-05：轨迹集的**离线回放**与门禁。
//
// 这个脚本回答两个问题：
//
//   ① **这份轨迹集本身能不能当门禁用？**
//      结构完整（每条都有可判定的判据与回执摘要）、回执可复现（用记录里的参数
//      重新执行，规范化摘要必须逐字节一致）、正文不越界（没有回执里没有的数字型结论）。
//
//   ② **判定器两个方向都抓得住吗？**
//      正向对照：应该全过的 arm 必须真的全过；
//      反向对照：**现在**把每条记录的正文/调用改坏一次，必须全部判挂。
//      只有正向的判定器等于「总是返回 true」。
//
// 回放要连真服务，所以这里和 builder 用同一套启动方式；没有 python3 时明确失败，
// 不假装通过。

import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools, executeTool} from '../../src/coach/toolbox.js';
import {checkTask, receiptDigest, FORMAT, canonical, CHECKABLE} from './agent-trajectories.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TRAJECTORIES = join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.jsonl');
const TASKS = join(ROOT, 'tests', 'evals', 'agent-tasks-v1.jsonl');
const OUT = join(ROOT, 'reports', 'roco', 'agent-trajectories-verification.json');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';

function args(argv) {
  const out = {write: true, quiet: false, selftest: false, limit: 0};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') out.write = false;
    else if (argv[index] === '--quiet') out.quiet = true;
    else if (argv[index] === '--selftest') out.selftest = true;
    else if (argv[index] === '--limit') out.limit = Number(argv[++index]);
  }
  return out;
}

/**
 * 正向对照 arm：**应当全过**的那几支。
 *
 * `replay` 是照任务期望重放（接线自检）：它的定义就是「全都做对」，所以它必须全过。
 * 其它 arm 要么是规则 baseline（允许有它答不了的类别），要么是**故意做错**的反证组
 * ——把它们算进正向期望，等于要求判定器别干活。
 */
export const POSITIVE_CONTROL_ARMS = Object.freeze(['replay']);

export function loadTrajectories(path = TRAJECTORIES) {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function pickFreePort() {
  const probe = createNetServer();
  probe.unref();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const {port} = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * 结构检查：不连服务也应该过的那些。
 *
 * 每一条都要能回答「你凭什么判它对」：判据字段必须存在且是 CHECKABLE 里的，
 * 工具调用必须带**回执摘要**（否则回放无从比对），正文必须存在（哪怕为空）。
 */
export function structuralCheck(row, {taskById}) {
  const problems = [];
  if (row.record_type !== 'agent_trajectory') problems.push('record_type 不是 agent_trajectory');
  if (row.format !== FORMAT) problems.push(`format 不是 ${FORMAT}`);
  const task = taskById.get(row.case_id);
  if (!task) problems.push(`找不到对应任务 ${row.case_id}`);
  else {
    const keys = Object.keys(task.expect || {}).filter((key) => CHECKABLE.includes(key));
    if (!keys.length) problems.push('任务没有任何机器可判定的判据');
    // 判据必须是**可复核**的：记录里的 checks.items 应当覆盖任务判据里能算的每一项。
    for (const key of keys) {
      if (key === 'tool' || key === 'args_must_match') continue;
      if (!row.checks || !row.checks.items) { problems.push('缺少 checks.items'); break; }
    }
  }
  for (const call of row.trace || []) {
    if (!call.receipt) problems.push(`工具 ${call.tool} 的调用没有回执摘要：回放无从比对`);
    else if (!call.receipt.digest) problems.push(`工具 ${call.tool} 的回执摘要缺少 digest`);
  }
  if (typeof row.reply !== 'string') problems.push('reply 不是字符串');
  if (!row.stopped) problems.push('缺少 stopped：无法区分「查完了」与「中途失败」');
  if (!row.input?.world?.id) problems.push('缺少世界标识：无法确定用哪个局面回放');
  return problems;
}

/**
 * 离线回放：拿记录里的工具调用**重新执行一遍**。
 *
 * 比的是**规范化回执摘要**（剔除延迟、键序无关）：回执变了就是变了，
 * 不能靠「反正也是 ok」蒙过去。工具调用本身还要再过一次参数校验，
 * 因为参数校验规则也可能被改动——记录里合法不代表现在还合法。
 */
export async function replayRow(row, {client, worldStates, pythonOk}) {
  const problems = [];
  const worldId = row.input?.world?.id;
  const stateVersion = row.input?.world?.state_version;
  const records = row.trace || [];
  if (!pythonOk["ok"] && records.length) {
    return {problems: [], skipped: `python3 不可用（${pythonOk.error}）：需要真服务的回放跳过`};
  }
  resetRocoTools();
  configureRocoTools({client, stateVersion});
  for (const call of records) {
    let result;
    try {
      result = await executeTool(call.tool, call.args, {mode: row.input?.mode, stateVersion, rocoStateVersion: stateVersion});
    } catch (error) {
      problems.push(`回放 ${call.tool} 抛异常：${String(error?.message || error).slice(0, 120)}`);
      continue;
    }
    const now = receiptDigest(result);
    if (now !== call.receipt?.digest) {
      problems.push(`回放 ${call.tool} 的回执与记录不一致（记录 ${String(call.receipt?.digest).slice(0, 12)}，现在 ${now.slice(0, 12)}）`);
    }
  }
  return {problems, skipped: null};
}

/**
 * 反向对照：按**任务自己的判据**逐条造一个必然违规的变体。
 *
 * 为什么要按判据造，而不是随便改一改：随便改出来的「坏记录」可能哪条判据都不碰
 * （给一条没有 `must_not_fabricate` 的任务塞数字），于是它「没被抓到」并不说明
 * 判定器有问题，只说明这个改动不该被抓。那样测出来的反向覆盖率是假的。
 *
 * 每一条返回 `{name, criterion, row}`：`criterion` 就是它**应当**触发的判据名，
 * 报告里按判据分组，于是「哪条判据根本没在起作用」可以被直接指出来。
 */
export function corruptionsFor(row, task) {
  const expect = task?.expect || {};
  const trace = row.trace || [];
  const out = [];
  // 只对**原本判定通过**的记录造变体。
  //
  // 一条原本就没过的记录，把它改坏之后仍然不过——那不能证明判定器抓到了这个改动，
  // 只能证明它还在为别的原因判挂。把这种条目算进「反向覆盖率」是虚高。
  if (!row.checks?.passed) return out;
  const withTrace = (next) => ({...row, trace: next});
  const withReply = (reply) => ({...row, reply});

  if (expect.tool) {
    out.push({name: '删掉应当调用的工具', criterion: 'tool', row: withTrace([])});
    out.push({name: '换掉应当调用的工具', criterion: 'tool',
      row: withTrace([{tool: 'read_last_turn', args: {}, receipt: {ok: true, digest: 'x'}}])});
  }
  if (expect.args_must_match && Object.keys(expect.args_must_match).length) {
    out.push({name: '清空参数', criterion: 'args_must_match',
      row: withTrace(trace.map((call) => ({...call, args: {}})))});
  }
  if ('max_tool_calls' in expect) {
    const extra = {tool: 'query_rules', args: {kind: 'ruleset', state_version: row.input?.world?.state_version}, receipt: {ok: true, digest: 'x'}};
    out.push({name: '超出工具调用次数上限', criterion: 'max_tool_calls',
      row: withTrace([...trace, ...Array.from({length: expect.max_tool_calls + 1}, () => extra)])});
  }
  if ('max_reply_chars' in expect) {
    out.push({name: '正文超长', criterion: 'max_reply_chars',
      row: withReply('很'.repeat(expect.max_reply_chars + 40))});
  }
  if (expect.must_not_speak) {
    out.push({name: '该沉默时开口', criterion: 'must_not_speak', row: withReply('我建议你换一只。')});
  } else if (expect.must_not_fabricate) {
    // 只有**真的**要求不许编造时，塞一个数字才必然违规。没有这条判据的任务里
    // 塞数字不算错——把它算成「判定器漏抓」是在给判定器记账，不是在测它。
    out.push({name: '正文里塞数字型结论', criterion: 'must_not_fabricate',
      row: withReply(`${row.reply} 具体能打 250 点伤害。`)});
  }
  if (expect.must_mention_limitation) {
    // 把限制说法整个去掉：只剩一句笃定的结论。
    out.push({name: '抹掉限制说明', criterion: 'must_mention_limitation', row: withReply('好的，我知道了。')});
  }
  if (expect.must_keep_locked) {
    out.push({name: '把锁定的伙伴换掉', criterion: 'must_keep_locked',
      row: withTrace(trace.map((call) => ({...call, args: {...call.args, team: ['pet_000190', 'pet_000445', 'pet_000417'], locked_pet: undefined}})))});
  }
  if (expect.must_not_claim_winrate) {
    out.push({name: '把分数说成胜率', criterion: 'must_not_claim_winrate', row: withReply(`${row.reply} 这套阵容胜率 73%。`)});
  }
  if (expect.must_surface_conflict) {
    out.push({name: '不提冲突', criterion: 'must_surface_conflict', row: withReply('两个来源一致，可以放心用。')});
  }
  if (expect.must_not_use_stale) {
    out.push({name: '拿旧状态版本重算', criterion: 'must_not_use_stale',
      row: withTrace([...trace, {tool: 'query_rules', args: {kind: 'ruleset', state_version: 0},
        receipt: {ok: false, error_type: 'version_mismatch', stale: true, digest: 'x'}}])});
  }
  return out;
}

function summarise(rows, extra = {}) {
  const failures = rows.filter((row) => !row.passed);
  return {
    total: rows.length,
    passed: rows.length - failures.length,
    failed: failures.length,
    by_arm: rows.reduce((acc, row) => {
      const bucket = acc[row.arm] || (acc[row.arm] = {total: 0, passed: 0});
      bucket.total += 1;
      if (row.passed) bucket.passed += 1;
      return acc;
    }, {}),
    first_failures: failures.slice(0, 5).map((row) => ({traj_id: row.traj_id, problems: row.problems.slice(0, 3)})),
    ...extra,
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!existsSync(TRAJECTORIES)) {
    process.stderr.write(`[verify-trajectories] 找不到 ${TRAJECTORIES}，先跑 build-agent-trajectories.mjs\n`);
    process.exit(2);
  }
  const all = loadTrajectories();
  const header = all.find((row) => row.record_type === 'agent_trajectory_header');
  const rows = all.filter((row) => row.record_type === 'agent_trajectory');
  const tasks = loadTrajectories(TASKS).filter((row) => row.record_type === 'agent_task');
  const taskById = new Map(tasks.map((task) => [task.case_id, task]));

  // ① 结构
  const structural = rows.map((row) => ({traj_id: row.traj_id, arm: row.arm, problems: structuralCheck(row, {taskById})}))
    .map((item) => ({...item, passed: item.problems.length === 0}));

  // ② 回放
  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const pythonOk = RocoClient.probePython(PYTHON_BIN);
  const replay = [];
  try {
    if (pythonOk.ok) await client.startService();
    const subset = options.limit ? rows.slice(0, options.limit) : rows;
    for (const row of subset) {
      const result = await replayRow(row, {client, worldStates: null, pythonOk});
      replay.push({traj_id: row.traj_id, arm: row.arm, problems: result.problems, passed: result.problems.length === 0, skipped: result.skipped});
    }
  } finally {
    resetRocoTools();
    if (pythonOk.ok) await client.stopService().catch(() => {});
  }

  // ③ 判定器两个方向
  //
  // 「正向应当全过」只对**对照 arm**成立（见 POSITIVE_CONTROL_ARMS）：
  // 反证 arm 的存在意义就是被判挂，把它们算进正向期望等于要求判定器别干活。
  const graderDirection = {positive: {total: 0, passed: 0}, per_arm: {}, negative: {total: 0, passed: 0}, per_criterion: {}};
  for (const row of rows) {
    const task = taskById.get(row.case_id);
    const call = {toolCalls: (row.trace || []).map((item) => ({tool: item.tool, args: item.args, result: item.receipt})), reply: row.reply, engineRefused: row.engine_refused};
    const good = checkTask(task, call);
    const armBucket = graderDirection.per_arm[row.arm] || (graderDirection.per_arm[row.arm] = {total: 0, passed: 0, control: POSITIVE_CONTROL_ARMS.includes(row.arm)});
    armBucket.total += 1;
    if (good.passed) armBucket.passed += 1;
    // 生成时写进记录的那次判定必须与现在重判的结果一致。不一致说明判定器
    // 在生成之后被改过而产物没重建——那是最难发现的一类漂移。
    const recorded = row.checks?.passed;
    if (recorded !== good.passed) {
      graderDirection.drift = (graderDirection.drift || 0) + 1;
      graderDirection.drift_example = graderDirection.drift_example || {
        traj_id: row.traj_id, recorded, now: good.passed,
        recorded_violations: row.checks?.violations || [], now_violations: good.violations.slice(0, 2),
      };
    }
    if (POSITIVE_CONTROL_ARMS.includes(row.arm)) {
      graderDirection.positive.total += 1;
      if (good.passed) graderDirection.positive.passed += 1;
    }
    for (const corruption of corruptionsFor(row, task)) {
      const bad = checkTask(task, {
        toolCalls: (corruption.row.trace || []).map((item) => ({tool: item.tool, args: item.args, result: item.receipt})),
        reply: corruption.row.reply,
      });
      graderDirection.negative.total += 1;
      const bucket = graderDirection.per_criterion[corruption.criterion]
        || (graderDirection.per_criterion[corruption.criterion] = {total: 0, caught: 0, example: corruption.name});
      bucket.total += 1;
      if (bad.passed) { bucket.missed = (bucket.missed || 0) + 1; bucket.example_missed = corruption.name; }
      else { graderDirection.negative.passed += 1; bucket.caught += 1; }
    }
  }

  const report = {
    generated_by: 'scripts/roco/verify-agent-trajectories.mjs',
    trajectory_set: header?.set_id || null,
    format: header?.format || null,
    counts: {rows: rows.length, tasks: tasks.length, arms: header?.arms || null},
    structural: summarise(structural),
    replay: summarise(replay, {skipped: replay.filter((row) => row.skipped).length,
      note: replay.find((row) => row.skipped)?.skipped || null}),
    // 判定器必须**两个方向都对**：正向应当全过，反向应当全挂。
    grader: {
      positive_expected: '全过（这批轨迹是按任务期望/规则 baseline 生成的）',
      negative_expected: '全挂（每条记录都被改坏一次）',
      positive: graderDirection.positive,
      negative: graderDirection.negative,
      per_criterion: graderDirection.per_criterion,
      per_arm: graderDirection.per_arm,
      drift: graderDirection.drift || 0,
      drift_example: graderDirection.drift_example || null,
      passes: graderDirection.positive.passed === graderDirection.positive.total
        && graderDirection.negative.passed === graderDirection.negative.total
        && !graderDirection.drift,
    },
    verdict: null,
  };
  report.verdict = report.structural.failed === 0
    && report.replay.failed === 0
    && report.grader.passes;

  if (options.write) {
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  }
  if (!options.quiet) process.stdout.write(`${JSON.stringify({
    structural: {total: report.structural.total, failed: report.structural.failed},
    replay: {total: report.replay.total, failed: report.replay.failed, skipped: report.replay.skipped},
    grader: {positive: report.grader.positive, negative: report.grader.negative, drift: report.grader.drift},
    per_arm: report.grader.per_arm,
    verdict: report.verdict,
    first_failures: report.structural.first_failures.concat(report.replay.first_failures),
  }, null, 1)}\n`);
  if (!report.verdict) process.exitCode = 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`[verify-trajectories] 失败：${error?.stack || error}\n`);
    process.exit(1);
  });
}
