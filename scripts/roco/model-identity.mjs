// 模型身份：**这份产物是哪个模型/适配器产出的**。
//
// 抽成独立模块的理由与 `local-model-ask.mjs` 相同：`shadow-replay.mjs` 与
// `build-agent-trajectories.mjs` 都要记身份，而两者互相 import（前者用后者的世界构造），
// 再互相依赖会形成循环。第三个模块只依赖 `agent-trajectories.mjs` 的摘要工具。
//
// 为什么必须记（第 37 轮的真实事故）：报告里原来没有模型身份，运行器又总是写到
// 同一个文件名，于是存档逐次错位——`-sft-v2.json` 里装的是 v1 的成绩、
// `-sft-v3.json` 里装的是 v2 的，真正的 v3 一个产物都没留下，而**没有任何检查会发现**。

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {basename, join} from 'node:path';
import {execFileSync} from 'node:child_process';

import {canonical, digest, LOCAL_TOOL_SYSTEM} from './agent-trajectories.mjs';

/**
 * 这份报告**是哪个模型产出的**。
 *
 * 为什么必须记（第 37 轮的真实事故）：报告原来只有 `arm` / `gateway` / `prompt_digest`，
 * **没有模型身份**；而运行器每次把结果写到同一个 `-local_4b.json`。
 * 于是存档逐次错位——`shadow-replay-sft-v2.json` 里装的其实是 v1 的成绩，
 * `-sft-v3.json` 里装的是 v2 的，真正的 v3 结果（0.7118）**一个产物都没留下**。
 * 台账和文档于是都在引用一组对不上号的数字，而没有任何检查会发现。
 *
 * 只记路径还不够：同一个路径上的适配器会被重训覆盖。所以同时把权重文件哈希记下来，
 * 名字对不上、内容对不上，都能被后来的人当场看出来。
 */
export function modelIdentity(gatewayUrl, adapterPath = process.env.ROCO_LOCAL_ADAPTER || null) {
  const identity = {model: null, adapter: adapterPath, adapter_sha256: null, gateway_reachable: false};
  try {
    const health = JSON.parse(execFileSync('curl', ['-sS', '-m', '5', `${gatewayUrl}/healthz`],
      {encoding: 'utf8'}));
    identity.gateway_reachable = true;
    identity.model = health.model ?? null;
    identity.adapter = health.adapter ?? adapterPath;
    identity.ready = health.ready === true;
  } catch {
    // 网关没起时留 null：报告照样写出来，但身份栏为空——不许拿「不知道」当「一样」。
  }
  const dir = identity.adapter;
  if (dir && existsSync(dir)) {
    // 优先哈希真正的权重文件；只有配置时退回配置，并在字段名上说清楚。
    const candidates = readdirSync(dir).filter((name) => name.endsWith('.safetensors')).sort();
    const file = candidates.includes('adapters.safetensors') ? 'adapters.safetensors' : candidates[0];
    if (file) {
      identity.adapter_file = file;
      identity.adapter_sha256 = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
    } else if (existsSync(join(dir, 'adapter_config.json'))) {
      identity.adapter_file = 'adapter_config.json';
      identity.adapter_sha256 = createHash('sha256')
        .update(readFileSync(join(dir, 'adapter_config.json'))).digest('hex');
    }
    identity.adapter_basename = basename(dir);
  }
  const promptDigest = digest(LOCAL_TOOL_SYSTEM);
  identity.identity_digest = digest(canonical(identity));
  identity.prompt_digest = promptDigest;
  return identity;
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

// `gatewayAsk` 的实现搬到了 `local-model-ask.mjs`（轨迹生成器也要用它，
// 放在这里会形成循环引用）。这里重新导出，保持既有 import 路径不变。
export {gatewayAsk} from './local-model-ask.mjs';

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

