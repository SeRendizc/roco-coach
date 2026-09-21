#!/usr/bin/env node
// W4-05 / W5-02：同 Agent 回放门禁——把「谁在选工具」换掉，用**同一套判据**再跑一遍。
//
// 它回答的问题很窄，但正是旗舰路线要证明的那个：
// **换一个模型之后，哪些任务退化、哪些持平、哪些变好。**
//
// 与 `build-agent-trajectories.mjs` 的分工：那份生成**规则臂**的轨迹集并判定；
// 这一份**不重新生成数据**，而是把同一个任务集喂给注入的 provider（真实模型或桩），
// 用同一个判定器判，再和参考臂（规则 baseline）逐任务对比。
//
// 事实边界
// --------
// 模型只负责**选工具**。它给的参数照常走 `validToolArgs` 与真实引擎；
// 状态版本由运行时覆盖，不采信模型编的那个。也就是说：这条链路里
// 「模型说的一定对」不是任何一步的前提。
//
// 跑法::
//
//     node scripts/roco/shadow-replay.mjs --arm rule                 # 参考臂（不需要模型）
//     node scripts/roco/shadow-replay.mjs --arm local_4b --limit 24  # 真模型（要网关在线）
//     node scripts/roco/shadow-replay.mjs --arm local_4b --gateway http://127.0.0.1:8766

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {dirname, join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {
  loadTasks, worldState, sourceConflictFor, versionAuthority,
} from './build-agent-trajectories.mjs';
import {
  worldsFor, runInput, runArm, finalAnswer, refusalsIn, makePlanner, armLimit,
  checkTask, receiptSummary, localModelPlanner, canonical, digest, LOCAL_TOOL_SYSTEM,
} from './agent-trajectories.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GENERATOR = join(ROOT, 'scripts', 'roco', 'gen-plan-state.py');
const OUT = join(ROOT, 'reports', 'roco', 'shadow-replay.json');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';

/** 与任务集对齐的默认世界数（与 build 一致，保证同一条任务落在同一个局面上）。 */
const WORLDS_PER_TASK = 1;

// `modelIdentity` 搬到了 `model-identity.mjs`（轨迹生成器也要用它，
// 放在这里会形成循环引用）。这里重新导出，保持既有 import 路径不变。
export {modelIdentity} from './model-identity.mjs';

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


// `gatewayAsk` 的实现见 `local-model-ask.mjs`（上面已重新导出）。

/** 跑一条任务：同一个世界、同一个判定器，只换「谁在选工具」。 */
export async function replayTask({task, world, state, authority, arm, ask, client}) {
  const input = runInput(task, world, state);
  let callIndex = 0;
  resetRocoTools();
  configureRocoTools({client, stateVersion: () => {
    const value = callIndex === 0 ? authority.authority : state.state_version;
    callIndex += 1;
    return value;
  }});
  const planner = arm === 'rule'
    ? makePlanner('baseline', task, input.hints)
    : localModelPlanner(task, input.hints, {ask});
  const started = Date.now();
  const run = await runArm({task, arm, input, planner, limit: armLimit('baseline')});
  const reply = finalAnswer(task, {trace: run.trace, stopped: run.stopped, hints: input.hints});
  const engineRefused = refusalsIn(run.trace).length > 0;
  const check = checkTask(task, {toolCalls: run.trace, reply, engineRefused});
  return {
    case_id: task.case_id,
    category: task.category,
    arm,
    world: world.id,
    // 切分信息必须随行带出：报告要能自己说出「家族外 / 机制外 / 模板外」的成绩，
    // 而不是让读的人去任务集里手工 join。少了它，`by_split` 只能给一条空表。
    family: task.split?.family ?? null,
    mechanism: task.split?.mechanism ?? null,
    template: task.split?.template ?? null,
    held_out_dimensions: task.split?.held_out_dimensions ?? [],
    trace: run.trace.map((item) => ({
      tool: item.tool,
      args: item.args,
      ok: item.result?.ok === true,
      error_type: item.result?.error_type ?? null,
    })),
    stopped: run.stopped,
    passed: check.passed,
    violations: check.violations,
    wall_ms: Date.now() - started,
  };
}

export function summarise(rows) {
  const byCategory = {};
  for (const row of rows) {
    const bucket = byCategory[row.category] || (byCategory[row.category] = {total: 0, passed: 0, latency: []});
    bucket.total += 1;
    if (row.passed) bucket.passed += 1;
    bucket.latency.push(row.wall_ms);
  }
  const decile = (list, p) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };
  for (const bucket of Object.values(byCategory)) {
    bucket.pass_rate = Number((bucket.passed / bucket.total).toFixed(4));
    bucket.p50_ms = decile(bucket.latency, 0.5);
    bucket.p95_ms = decile(bucket.latency, 0.95);
    delete bucket.latency;
  }
  const all = rows.map((row) => row.wall_ms);
  return {
    tasks: rows.length,
    passed: rows.filter((row) => row.passed).length,
    pass_rate: rows.length ? Number((rows.filter((row) => row.passed).length / rows.length).toFixed(4)) : null,
    stopped: rows.reduce((acc, row) => {
      acc[row.stopped] = (acc[row.stopped] || 0) + 1; return acc;
    }, {}),
    latency: {p50_ms: decile(all, 0.5), p95_ms: decile(all, 0.95)},
    by_category: byCategory,
    by_split: bySplit(rows),
  };
}

/**
 * 按**切分维度**分解通过率：家族 / 机制 / 表达模板各切一刀，再按
 * `held_out_dimensions` 把「训练时被留出的」和「见过的」分开算。
 *
 * 为什么要单独给这个：总体通过率会把两类完全不同的成绩混在一起——
 * 「在训练见过的家族上做对」与「换一个家族还做对」。
 * 前者只说明记住了，后者才说明泛化。之前只有总体数字，
 * 于是 v1 那次「`roster_constraint` 整类归零」要靠人工去翻 test 家族才发现，
 * 而这件事本来应该是报告自己说出来的。
 *
 * 口径：**只看留出侧**（`held_out_dimensions` 里列了 `family` 的任务），
 * 因为只有那部分才回答「家族外还灵不灵」。没标留出的任务归入 `seen`。
 */
export function bySplit(rows) {
  const slice = (key) => {
    const out = {held_out: {total: 0, passed: 0}, seen: {total: 0, passed: 0}, by_value: {}};
    for (const row of rows) {
      const value = row[key] ?? '(缺)';
      const heldOut = Array.isArray(row.held_out_dimensions) && row.held_out_dimensions.includes(key);
      const bucket = heldOut ? out.held_out : out.seen;
      bucket.total += 1;
      if (row.passed) bucket.passed += 1;
      const per = out.by_value[value] || (out.by_value[value] = {total: 0, passed: 0, held_out: heldOut});
      per.total += 1;
      if (row.passed) per.passed += 1;
    }
    out.held_out.pass_rate = out.held_out.total
      ? Number((out.held_out.passed / out.held_out.total).toFixed(4)) : null;
    out.seen.pass_rate = out.seen.total
      ? Number((out.seen.passed / out.seen.total).toFixed(4)) : null;
    for (const per of Object.values(out.by_value)) {
      per.pass_rate = Number((per.passed / per.total).toFixed(4));
    }
    return out;
  };
  return {family: slice('family'), mechanism: slice('mechanism'), template: slice('template')};
}

/** 两臂逐任务对比：谁退化了、谁扳回来了。 */
export function compare(reference, candidate) {
  const byId = new Map(reference.map((row) => [row.case_id, row]));
  const regressed = [];
  const fixed = [];
  const bothFail = [];
  for (const row of candidate) {
    const ref = byId.get(row.case_id);
    if (!ref) continue;
    if (ref.passed && !row.passed) regressed.push({case_id: row.case_id, category: row.category,
      why: row.violations.slice(0, 2), stopped: row.stopped});
    else if (!ref.passed && row.passed) fixed.push({case_id: row.case_id, category: row.category});
    else if (!ref.passed && !row.passed) bothFail.push({case_id: row.case_id, category: row.category});
  }
  const byCategory = {};
  for (const row of candidate) {
    const ref = byId.get(row.case_id);
    if (!ref) continue;
    const bucket = byCategory[row.category] || (byCategory[row.category] = {total: 0, regressed: 0, fixed: 0});
    bucket.total += 1;
    if (ref.passed && !row.passed) bucket.regressed += 1;
    if (!ref.passed && row.passed) bucket.fixed += 1;
  }
  return {
    compared: candidate.length,
    regressed: regressed.length,
    fixed: fixed.length,
    both_failed: bothFail.length,
    by_category: byCategory,
    worst_regressions: regressed.slice(0, 8),
  };
}

/**
 * 存档名与身份是否对得上。返回不一致的理由，一致时返回 `null`。
 *
 * 这是「存档错位」那一类事故的守卫：`-sft-v2.json` 里装着 v1 的成绩，
 * 光看通过率是看不出来的（数字都合理），只有把**文件名**与**报告里记的适配器**
 * 对上，才能当场发现。约定：
 *   · `shadow-replay-base.json`    → `adapter === null`
 *   · `shadow-replay-sft-vN.json`  → `adapter_basename === qwen35-4b-tool-vN`
 *   · 其它（如 `-local_4b.json`）   → 只要求有身份，不要求名字匹配

/**
 * 存档名与身份是否对得上。返回不一致的理由，一致时返回 `null`。
 *
 * 这是「存档错位」那一类事故的守卫：`-sft-v2.json` 里装着 v1 的成绩，
 * 光看通过率是看不出来的（数字都合理），只有把**文件名**与**报告里记的适配器**
 * 对上，才能当场发现。约定：
 *   · `shadow-replay-base.json`    → `adapter === null`
 *   · `shadow-replay-sft-vN.json`  → `adapter_basename === qwen35-4b-tool-vN`
 *   · 其它（如 `-local_4b.json`）   → 只要求有身份，不要求名字匹配
 */
export function identityMismatch(filename, identity) {
  const stem = String(filename).replace(/^.*\//, '').replace(/\.json$/, '');
  if (stem === 'shadow-replay-base') {
    if (!identity) return '基座报告必须带 identity 对象（里面 adapter 应为 null）';
    if (identity.adapter !== null) {
      return `基座报告的 adapter 是 ${identity.adapter}，不是 null——它其实是某个适配器的成绩`;
    }
    return null;
  }
  const match = stem.match(/^shadow-replay-sft-(v\d+)$/);
  if (!match) return null;
  if (!identity) return `${stem} 没有 identity：无法判断它是哪个适配器产出的`;
  const want = `qwen35-4b-tool-${match[1]}`;
  if (identity.adapter_basename !== want) {
    return `${stem} 里记的适配器是 ${identity.adapter_basename || '（无）'}，应当是 ${want}`;
  }
  if (!identity.adapter_sha256) return `${stem} 没有记适配器权重哈希，换版之后无法分辨`;
  return null;
}

async function main(argv) {
  const arg = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const arm = arg('--arm', 'rule');
  const limit = Number(arg('--limit', '0')) || 0;
  const gateway = arg('--gateway', `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`);
  const write = !argv.includes('--check');
  const compareWith = arg('--compare');   // 参考臂的 JSON 路径
  const outPath = arg('--out');           // 显式指定产物路径（存档名不该由 arm 名猜）

  const tasks = loadTasks().slice(0, limit || undefined);
  const ask = arm === 'rule' ? null : gatewayAsk(gateway);

  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const rows = [];
  try {
    await client.startService();
    for (const task of tasks) {
      const world = worldsFor(task, WORLDS_PER_TASK)[0];
      if (!world) continue;
      const base = worldState(world);
      const state = {...base, source_conflict: sourceConflictFor(world, base)};
      rows.push(await replayTask({task, world, state, authority: versionAuthority(world, state), arm, ask, client}));
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }

  const identity = arm === 'rule'
    ? {role: 'rule-arm', note: '规则臂不经过模型，没有模型身份'}
    : modelIdentity(gateway);
  const path = outPath || OUT.replace(/\.json$/, arm === 'rule' ? '.json' : `-${arm}.json`);
  const report = buildShadowReport({arm, gateway, rows, compareWith, identity, outPath: write ? path : null});
  if (write) {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
    report.written_to = path;
  }
  process.stdout.write(`${JSON.stringify({arm, summary: report.summary,
    comparison: report.comparison || null, written_to: report.written_to || null}, null, 1)}\n`);
  return 0;
}

/**
 * 组装报告对象。**抽出来是为了能被测试直接调用**。
 *
 * 只写文件的那一版有个盲点：测试只能读**已经落盘的**报告，
 * 于是「代码里的组装逻辑被改坏」不会被任何测试发现——守卫自检的注入实验
 * 抓到了这一点（把 prompt_digest 改成恒 null，注入后仍然全绿）。
 */
export function buildShadowReport({arm, gateway = null, rows, compareWith = null,
  identity = null, outPath = null}) {
  const report = {
    generated_by: 'scripts/roco/shadow-replay.mjs',
    arm,
    // 身份栏：这份报告是哪个模型/适配器产出的。**没有它，存档错位不会被发现。**
    identity: identity || null,
    written_to: outPath,
    gateway: arm === 'rule' ? null : gateway,
    // 提示版本进产物：两份报告只有提示不同时，光看通过率是分不出差别的，
    // 必须能核对「这两次跑的是不是同一份提示」。没有它，第 22→23 轮那次
    // 提示实验就只能靠人工记忆解释。
    prompt_digest: arm === 'rule' ? null : digest(LOCAL_TOOL_SYSTEM),
    prompt: arm === 'rule' ? null : LOCAL_TOOL_SYSTEM,
    note: '同一任务集、同一世界、同一判定器，只换「谁在选工具」。模型只选工具；'
      + '参数照常过 validToolArgs 与真实引擎，状态版本由运行时覆盖。',
    summary: summarise(rows),
    rows,
  };
  if (compareWith) {
    const reference = JSON.parse(readFileSync(compareWith, 'utf8')).rows;
    report.comparison = compare(reference, rows);
    report.comparison.against = compareWith;
  }
  return report;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shadow-replay] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
