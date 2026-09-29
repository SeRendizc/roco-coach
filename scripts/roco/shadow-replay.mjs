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
//     node scripts/roco/shadow-replay.mjs --arm deepseek_agent --pool catalog --limit 120
//     ROCO_PLANNER_RULES=catalog node scripts/roco/shadow-replay.mjs --arm deepseek_product \
//       --pool catalog --limit 120      # 生产提示 + 图鉴两条规则（默认口径是 off）

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {dirname, join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
// 2026-09-25（4B 实测发现）：这个文件在 `:267` 用了 `gatewayAsk`，却从来没有 import 过它 ⇒
// `npm run roco:shadow-replay -- --arm local_4b` 直接 `ReferenceError: gatewayAsk is not defined`，
// 本地臂因此**跑不起来**（不是模型问题）。实现与再导出都在 `./local-model-ask.mjs`。
import {gatewayAsk, deepseekAsk} from './local-model-ask.mjs';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {
  loadTasks, worldState, sourceConflictFor, versionAuthority,
} from './build-agent-trajectories.mjs';
import {
  worldsFor, runInput, runArm, finalAnswer, refusalsIn, makePlanner, armLimit,
  checkTask, receiptSummary, localModelPlanner, localAgentPlanner, canonical, digest,
  LOCAL_TOOL_SYSTEM, AGENT_TOOL_SYSTEM, buildProvenance, engineProvenance, sourceProvenance,
} from './agent-trajectories.mjs';
// 2026-09-25（主线程修，与 `gatewayAsk` 同源的一类缺陷）：这个文件在 `:290` 还用了 `modelIdentity`，
// 同样**从来没有 import 过** ⇒ `npm run roco:shadow-replay -- --arm local_4b` 直接
// `ReferenceError: modelIdentity is not defined`（本地臂第二次跑不起来 —— 仍然不是模型的问题）。
// 实现与签名见 `scripts/roco/model-identity.mjs:30`：`modelIdentity(gatewayUrl, adapterPath?)`。
import {modelIdentity} from './model-identity.mjs';
// 全图鉴（622 只）的取证任务：现有 288 条只用 4 只精灵、任务池写死 12 只，
// 这份把同一个问题族铺到整本图鉴（判据/世界都不新造，见该文件的说明）。
import {catalogLookupTasks, ambiguousNames, catalogPets} from './catalog-lookup-tasks.mjs';
// 生产真正发出去的那份 planner 提示（2026-09-25）：`--arm deepseek` 用的是**测评内**的冻结提示，
// 而玩家那边跑的是 `src/server/index.js` 里的这一份。两者不是同一份文字，所以"生产提示下 agent
// 自己会不会查图鉴"必须单独量 —— 这个臂就是为它存在的（提示从模块取，不在这里再抄一份）。
import {productionPlannerSystem, plannerRulesMode} from '../../src/coach/planner-prompt.js';

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
//: 2026-09-29（task-11）：生成器有 `--policy-first`（默认关），影子回放**没有这个开关** ——
//: 于是「第一步该不该调工具交给谁」这个变量在两份产物之间根本对不上、还看不出来。
//: 现在两边同名同默认（默认关）；开关由 `main()` 从命令行读一次写在这里。
let POLICY_FIRST = false;

export async function replayTask({task, world, state, authority, arm, ask, client}) {
  const input = runInput(task, world, state);
  let callIndex = 0;
  resetRocoTools();
  configureRocoTools({client, stateVersion: () => {
    const value = callIndex === 0 ? authority.authority : state.state_version;
    callIndex += 1;
    return value;
  }});
  // `local_4b_agent`（2026-09-25，人类口径「agent 优先」）：同一个模型、同一套任务、
  // 同一个判定器，只换成**用工具回执做决策**的规划器（多步 + 判定规则 + 名字→id 解析）。
  // 旧臂 `local_4b` 一字不动，两条各自出数字、可逐条对比。
  const planner = arm === 'rule'
    ? makePlanner('baseline', task, input.hints)
    : arm === 'deepseek_agent'
      // 云端 + agent 配置（回执/多步 + 判定规则）
      ? localAgentPlanner(task, input.hints, {ask})
      : arm === 'deepseek_product'
        // 云端 + **生产提示**（`ROCO_PLANNER_RULES=catalog` 时含"图鉴事实必须查证 / 先按名字查 id"）。
        // 与 `deepseek`（测评内冻结提示）只差 system：用来量"生产提示下 agent 自己会不会查"。
        // ⚠ 这一条是**单步**（`localModelPlanner` 不看回执）。产品运行时其实是**多步 + 回执**
        //（`gatherAgentEvidenceOnce` 最多 4 步），所以"必须两步"的题（学习表只认 pet_id）
        // 在单步臂上**永远不可能过** —— 那不是模型的问题，是这一条臂的口径。
        // 量产品真实循环请用 `deepseek_product_agent`（同提示 + 回执/多步）。
        ? localModelPlanner(task, input.hints, {ask, system: productionPlannerSystem()})
        : arm === 'deepseek_product_agent'
          // 云端 + **生产提示 + 产品的多步循环**（回执喂回去、最多 3 步）= 产品路径的忠实还原
          ? localAgentPlanner(task, input.hints, {ask, system: productionPlannerSystem()})
          : arm === 'deepseek'
        // 云端 + 与本地臂**同一份**冻结提示、同样单步：只换模型的对照
        ? localModelPlanner(task, input.hints, {ask})
        : arm === 'local_4b_agent'
      // ①+③：新判定提示 + 回执/多步
      ? localAgentPlanner(task, input.hints, {ask})
      : arm === 'local_4b_receipts'
        // **只动 ①**：系统提示逐字用冻结那份（adapter 是对着它 SFT 的），
        // 只把「回执喂回去 + 允许多步」打开。用来把「提示改写」与「用回执」两个变量分开。
        ? localAgentPlanner(task, input.hints, {ask, system: LOCAL_TOOL_SYSTEM})
        : localModelPlanner(task, input.hints, {ask});
  const started = Date.now();
  // 2026-09-29（task-11）：这里原来写死 `armLimit('baseline')` —— 生成器那边传的是
  // `armLimit(arm)`。今天两者的值恰好都是 3（两个 arm 都没登记 limit），所以**行为没差**；
  // 但写死一个别的 arm 的名字迟早会漂，而漂了之后两条链的对拍就再也说不清。
  const run = await runArm({task, arm, input, planner, limit: armLimit(arm), policyFirst: POLICY_FIRST});
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
    // 2026-09-29（task-11 实测踩到）：只认 `--flag value` 的话，传 `--flag=value` 会**静默**用默认值 ——
    // 我传 `--repeat=2` 就跑了一遍，`self_consistency` 静默为 null，差一点把它当成「没法量」。
    // 两种写法都认。
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const arm = arg('--arm', 'rule');
  // 与生成器的 `--policy-first` 同名同默认（默认关）：第一步「该不该调工具」交给代码政策。
  // 不把它做成显式开关，两份产物之间这个变量就永远对不上（2026-09-29 task-11 实测）。
  POLICY_FIRST = argv.includes('--policy-first');
  const repeat = Number(arg('--repeat', '1')) || 1;   // 同一把尺子跑几遍（量噪声底用）
  const limit = Number(arg('--limit', '0')) || 0;
  const gateway = arg('--gateway', `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`);
  const write = !argv.includes('--check');
  const compareWith = arg('--compare');   // 参考臂的 JSON 路径
  const outPath = arg('--out');           // 显式指定产物路径（存档名不该由 arm 名猜）

  // `--category`：只跑某一类任务（量一个改动的影响时不必每次都跑满 288 条）。
  const category = arg('--category');
  // `--pool catalog --contract A|B`：把问题族铺到全图鉴 622 只（见 `catalog-lookup-tasks.mjs`）。
  const pool = arg('--pool', 'tasks');
  const contract = arg('--contract', 'A');
  if (pool !== 'tasks' && pool !== 'catalog') {
    throw new Error(`未知 --pool ${JSON.stringify(pool)}（只有 tasks / catalog）`);
  }
  const tasks = (pool === 'catalog'
    ? catalogLookupTasks({contract, limit})
    : loadTasks())
    .filter((task) => !category || task.category === category)
    .slice(0, limit || undefined);
  if (pool === 'catalog') {
    const excluded = catalogLookupTasks({contract}).excluded_ambiguous;
    console.error(`[catalog] 契约 ${contract}：图鉴 ${catalogPets().length} 只、同名异形 ${ambiguousNames().length} 个`
      + `（A 契约排除 ${excluded} 个名字）⇒ 本次任务 ${tasks.length} 条`);
  }
  // 云端臂（2026-09-25）：与本地臂**同一个 ask 形状**、同一份提示集、同一套判据，
  // 只有模型不同（`deepseekAsk` 与产品侧 `/api/coach` 用同一个上游与同一个 model）。
  // 这样「同一批任务上 4B 与云端各能查到什么」才是可比的。
  const CLOUD_ARMS = new Set(['deepseek', 'deepseek_agent', 'deepseek_product', 'deepseek_product_agent']);
  const ask = arm === 'rule' ? null : CLOUD_ARMS.has(arm) ? deepseekAsk() : gatewayAsk(gateway);

  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const rows = [];
  // 2026-09-29（task-11）：同一把尺子**跑几遍**，逐窗口比出「噪声底」。
  // 为什么要它：`tests/evals/roco/model-trajectories.test.js` 那条判据拿「两条独立链的
  // 逐窗口结果必须逐条相同」当标准，而模型抽样**本来就会翻面** —— 噪声底是这个标准唯一
  // 站得住的参照物。第 2 遍起的结果进 `self_consistency`，不进 `rows`（`rows` 只留第 1 遍）。
  const repeatRuns = [];
  // 2026-09-29（task-17）：引擎身份要在客户端活着的时候抓（只留确定性字段）。
  let engineIdentity = null;
  try {
    await client.startService();
    engineIdentity = engineProvenance(await client.health().catch(() => null));
    for (let pass = 0; pass < repeat; pass += 1) {
      const passRows = [];
      for (const task of tasks) {
        const world = worldsFor(task, WORLDS_PER_TASK)[0];
        if (!world) continue;
        const base = worldState(world);
        const state = {...base, source_conflict: sourceConflictFor(world, base)};
        passRows.push(await replayTask({task, world, state, authority: versionAuthority(world, state), arm, ask, client}));
      }
      repeatRuns.push(passRows);
      if (pass === 0) rows.push(...passRows);
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }
  const selfConsistency = repeatRuns.length > 1
    ? (() => {
      const key = (row) => `${row.case_id}@${row.world}`;
      const base = new Map(repeatRuns[0].map((row) => [key(row), row]));
      const flipped = [];
      for (const other of repeatRuns.slice(1)) {
        for (const row of other) {
          const first = base.get(key(row));
          if (first && first.passed !== row.passed) {
            flipped.push({key: key(row), pass0: first.passed, passN: row.passed});
          }
        }
      }
      return {runs: repeatRuns.length, of: repeatRuns[0].length, flipped_windows: flipped.length,
        flipped_examples: flipped.slice(0, 5),
        note: '同一 arm、同一批窗口、同一把尺子，连跑 ' + repeatRuns.length
          + ' 遍之间**逐窗口翻面**的条数 —— 这就是「两条独立运行必须逐条相同」那个标准的噪声底。'};
    })()
    : null;

  const identity = arm === 'rule'
    ? {role: 'rule-arm', note: '规则臂不经过模型，没有模型身份'}
    : CLOUD_ARMS.has(arm)
      ? {role: 'cloud-arm', adapter: null, adapter_basename: null, adapter_sha256: null,
        model: 'deepseek-flash',
        // 生产提示臂必须把**当时的口径**记进身份里：同一臂名、两个口径会给出两个数，
        // 不写下来就分不清哪次是哪次（`ROCO_PLANNER_RULES` 是环境变量）。
        note: arm === 'deepseek_product'
          ? `云端臂：**生产 planner 提示**（单步；src/coach/planner-prompt.js，口径 ROCO_PLANNER_RULES=${plannerRulesMode()}）`
          : arm === 'deepseek_product_agent'
            ? `云端臂：**生产 planner 提示 + 产品的多步循环**（回执喂回去；口径 ROCO_PLANNER_RULES=${plannerRulesMode()}）`
            : '云端臂：同一份任务/提示/判据，只换模型（deepseekAsk）'}
      : modelIdentity(gateway);
  // 2026-09-25（实测踩到，值得单记）：`--limit` 的**冒烟跑**与全量跑写的是同一个文件名 ——
  // 我用 `--limit 5` 干跑了一次参考臂，就把已发布的 442 条产物覆盖成 5 条
  //（`tests/evals/shadow-replay.test.js` 要求 `summary.tasks >= 200`，差一步就红）。
  // 现在：**带 `--limit` 且没显式给 `--out` 时，产物名自动带 `-sliceN`**；
  // 全量跑（不带 `--limit`）的路径一个字不变 —— 文档里引用的就是那些。
  const path = outPath || (limit > 0
    ? OUT.replace(/\.json$/, `-slice${limit}${arm === 'rule' ? '' : `-${arm}`}.json`)
    : OUT.replace(/\.json$/, arm === 'rule' ? '.json' : `-${arm}.json`));
  const report = buildShadowReport({arm, gateway, rows, compareWith, identity, outPath: write ? path : null,
    provenance: buildProvenance({
      policyFirst: POLICY_FIRST,
      arms: [arm],
      limits: {[arm]: armLimit(arm)},
      engine: engineIdentity,
      sources: sourceProvenance([
        'scripts/roco/agent-trajectories.mjs',
        'scripts/roco/shadow-replay.mjs',
        'src/coach/roco-client.js',
        'roco/src/roco_env/env.py',
        'roco/src/roco_env/service.py',
        'roco/src/roco_env/data.py',
      ]),
    })});
  if (selfConsistency) {
    report.self_consistency = selfConsistency;
    report.policy_first = POLICY_FIRST;
  }
  if (write) {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
    report.written_to = path;
  }
  process.stdout.write(`${JSON.stringify({arm, summary: report.summary,
    comparison: report.comparison || null, written_to: report.written_to || null,
    policy_first: POLICY_FIRST, self_consistency: report.self_consistency || null}, null, 1)}\n`);
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
  identity = null, outPath = null, provenance = null}) {
  const report = {
    generated_by: 'scripts/roco/shadow-replay.mjs',
    arm,
    // 2026-09-29（task-17）：口径 + 版本 + 源码 hash（与生成器那一份**同一个** `buildProvenance`）。
    // 改前这份产物只有 `identity`（模型/适配器）与 `prompt_digest`，查不到 `policy_first`/limit/引擎版本 ——
    // 而 B5 那一轮正是拿两个口径的产物互比才演了三次乌龙。
    provenance,
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
