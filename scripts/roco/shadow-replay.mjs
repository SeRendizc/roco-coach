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
import {createServer as createNetServer} from 'node:net';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
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

/** 真实网关客户端：一次请求，带超时；拿不到就如实抛，由臂记成失败。 */
export function gatewayAsk(baseUrl, {timeoutMs = 8000} = {}) {
  return async ({system = null, prompt, maxTokens = 96, temperature = 0, timeoutMs: perCall = null}) => {
    const controller = new AbortController();
    const budget = perCall === null ? timeoutMs : perCall;
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          messages: [...(system ? [{role: 'system', content: system}] : []),
            {role: 'user', content: prompt}],
          max_tokens: maxTokens, temperature, timeout_ms: budget,
        }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`),
          {code: payload?.error?.code || 'http-error'});
      }
      return {text: payload.choices?.[0]?.message?.content ?? '', x_roco: payload.x_roco || null};
    } finally {
      clearTimeout(timer);
    }
  };
}

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
  };
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

  const report = {
    generated_by: 'scripts/roco/shadow-replay.mjs',
    arm,
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
  if (write) {
    mkdirSync(dirname(OUT), {recursive: true});
    const suffix = arm === 'rule' ? '' : `-${arm}`;
    const path = OUT.replace(/\.json$/, `${suffix}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
    report.written_to = path;
  }
  process.stdout.write(`${JSON.stringify({arm, summary: report.summary,
    comparison: report.comparison || null, written_to: report.written_to || null}, null, 1)}\n`);
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shadow-replay] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
