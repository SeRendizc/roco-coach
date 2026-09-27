// 「本地 4B 到底能不能用」的**同提示集对照**运行器（2026-09-24）。
//
// 为什么需要它，而不是直接跑 `build-agent-trajectories.mjs`：
// 那个脚本的 `--arms` 只认 `ARMS` 里注册的臂，而模型臂的 `ask` 被写死成
// `gatewayAsk(...)`（本地网关）。要跑**云端臂**（DeepSeek）就得改它，
// 而它不在本轮的允许改动清单里。所以这里把**已经导出的**零件重新组装一遍：
//
//   世界构造：`worldState` / `sourceConflictFor` / `versionAuthority`（build-agent-trajectories.mjs）
//   输入与判定：`runInput` / `runArm` / `finalAnswer` / `checkTask` / `worldsFor`（agent-trajectories.mjs）
//   两条臂的 ask：`gatewayAsk`（本地网关）/ `deepseekAsk`（云端）（local-model-ask.mjs）
//
// **没有**任何新写的推理栈、提示词、判定器或工具层：三条臂跑的是同一批窗口、
// 同一个 `LOCAL_TOOL_SYSTEM`、同一个 `checkTask`。`local_4b` 臂的提示与判定
// 与已发布的 `agent-trajectories-model-v1.jsonl` 完全同源。
//
// 用法：
//   node reports/roco/local-model/ab-arms.mjs \
//     --arms baseline,local_4b --gateway http://127.0.0.1:8799 \
//     --out /tmp/roco-4b/traj-sft-v4.jsonl --label sft-v4
//
//   node reports/roco/local-model/ab-arms.mjs \
//     --arms cloud_deepseek --cloud-sample --out /tmp/roco-4b/traj-cloud.jsonl
//
// 原始回执（每次 ask 的原文、usage、延迟；每次判定的逐项检查）另外落
// `--receipts` 指定的 JSONL：轨迹集里只有**解析后**的决定，而「合法率」
// 必须看原文才判得了。

import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {mkdirSync, readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID as RULESET_ID_FALLBACK} from '../../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../../src/coach/toolbox.js';
import {
  FORMAT, ARMS, armLimit, canonical, digest, finalAnswer, makePlanner,
  runArm, runInput, receiptSummary, worldsFor, CHECKABLE, refusalsIn, checkTask, extractFirstJson,
  LOCAL_TOOL_SYSTEM, localModelPlanner,
} from '../../../scripts/roco/agent-trajectories.mjs';
import {
  loadTasks, worldState, sourceConflictFor, versionAuthority,
} from '../../../scripts/roco/build-agent-trajectories.mjs';
import {gatewayAsk, deepseekAsk} from '../../../scripts/roco/local-model-ask.mjs';
import {modelIdentity} from '../../../scripts/roco/model-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/** 云端臂的**声明**（跑之前钉死，跑完不改）。`silence` 类不经过模型，保留只为守判据。 */
export const CLOUD_SAMPLE = Object.freeze({
  roster_constraint: 24, rules_lookup: 24, continue_stop: 36, silence: 12,
  brief_explain: 12, tool_failure: 12, stale_state: 12, evidence_conflict: 12,
});

/** 从文件顺序里**均匀**取 n 条（确定性：不随机、不依赖时间）。 */
export function sampleTasks(tasks, quota) {
  const byCategory = new Map();
  for (const task of tasks) {
    const list = byCategory.get(task.category) || [];
    list.push(task);
    byCategory.set(task.category, list);
  }
  const picked = [];
  for (const [category, list] of byCategory) {
    const want = quota[category];
    if (want === undefined || want >= list.length) { picked.push(...list); continue; }
    const step = list.length / want;
    for (let i = 0; i < want; i += 1) picked.push(list[Math.floor(i * step)]);
  }
  const order = new Map(tasks.map((task, index) => [task.case_id, index]));
  return picked.sort((a, b) => order.get(a.case_id) - order.get(b.case_id));
}

function args(argv) {
  const out = {arms: null, gateway: null, out: null, receipts: null, label: 'run',
    worlds: 3, sample: false, quiet: false, cloudMaxTokens: 96, cloudTimeoutMs: 30000, limit: null};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--arms') out.arms = String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean);
    else if (flag === '--gateway') out.gateway = String(argv[++i]);
    else if (flag === '--out') out.out = String(argv[++i]);
    else if (flag === '--receipts') out.receipts = String(argv[++i]);
    else if (flag === '--label') out.label = String(argv[++i]);
    else if (flag === '--worlds') out.worlds = Number(argv[++i]);
    else if (flag === '--cloud-sample') out.sample = true;
    else if (flag === '--limit') out.limit = Number(argv[++i]);
    else if (flag === '--quiet') out.quiet = true;
    else throw new Error(`未知参数：${flag}`);
  }
  return out;
}

async function pickFreePort() {
  const probe = createNetServer();
  probe.unref();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const {port} = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 把一次 ask 的**原文**记下来：合法率、超时、非法工具名都要从这里判。 */
function recordingAsk(inner, sink, meta) {
  return async (request) => {
    const started = Date.now();
    try {
      const reply = await inner(request);
      sink.push({record_type: 'ask_receipt', ...meta, ok: true,
        wall_ms: Date.now() - started, text: reply?.text ?? null,
        usage: reply?.usage ?? null, upstream_model: reply?.model ?? null,
        x_roco: reply?.x_roco ?? null,
        system_digest: digest(request.system || ''), prompt_digest: digest(request.prompt || '')});
      return reply;
    } catch (error) {
      sink.push({record_type: 'ask_receipt', ...meta, ok: false,
        wall_ms: Date.now() - started, error_code: error?.code || 'unknown',
        error: String(error?.message || error).slice(0, 200),
        system_digest: digest(request.system || ''), prompt_digest: digest(request.prompt || '')});
      throw error;
    }
  };
}

const MODEL_ARMS = new Set(['local_4b', 'local_base', 'cloud_deepseek']);
/** 这个臂注册在 ARMS 里吗？`local_base` / `cloud_deepseek` 是本次实测新增的对照臂。 */
const registered = (arm) => Object.hasOwn(ARMS, arm);

async function main() {
  const options = args(process.argv.slice(2));
  const arms = options.arms || ['baseline', 'local_4b'];
  for (const arm of arms) {
    if (!registered(arm) && !MODEL_ARMS.has(arm)) throw new Error(`未知 arm：${arm}`);
  }
  const selected = options.sample ? sampleTasks(loadTasks(), CLOUD_SAMPLE) : loadTasks();
  const tasks = options.limit === null ? selected : selected.slice(0, options.limit);
  const gateway = options.gateway || `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`;
  const receipts = [];

  const asks = new Map();
  const wantsLocal = arms.includes('local_4b') || arms.includes('local_base');
  if (arms.includes('cloud_deepseek')) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('缺 DEEPSEEK_API_KEY（云端臂要真 key；只跑本地臂不需要）');
    asks.set('cloud_deepseek', deepseekAsk({apiKey: key}));
  }
  if (wantsLocal) {
    const local = gatewayAsk(gateway);
    const probe = await local({prompt: '{"stop":true}', maxTokens: 8, timeoutMs: 20000});
    if (typeof probe?.text !== 'string') throw new Error(`本地网关返回形状不对：${gateway}`);
    asks.set('local_4b', local);
    asks.set('local_base', local);
  }

  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID_FALLBACK, timeoutMs: 20000, startTimeoutMs: 30000});
  const rows = [];
  const worldCache = new Map();
  try {
    await client.startService();
    const prepared = [];
    for (const task of tasks) {
      for (const world of worldsFor(task, options.worlds)) {
        const cacheKey = `${world.id}:${world.seed}:${world.turns}`;
        if (!worldCache.has(cacheKey)) {
          const fresh = worldState(world);
          worldCache.set(cacheKey, {...fresh, source_conflict: sourceConflictFor(world, fresh)});
        }
        const base = worldCache.get(cacheKey);
        const stateVersionOverride = world.bump_version ? base.state_version + 1 : null;
        const state = stateVersionOverride === null ? base
          : {...worldState(world, {stateVersionOverride}), source_conflict: base.source_conflict};
        const authority = versionAuthority(world, state);
        const input = runInput(task, world, state);
        prepared.push({task, world, state, input, authority});
      }
    }
    const total = prepared.length * arms.length;
    if (!options.quiet) {
      process.stderr.write(`[ab-arms] ${tasks.length} 条任务 × ${options.worlds} 个世界 × ${arms.length} 个 arm = ${total} 条轨迹（label=${options.label}）\n`);
    }
    let done = 0;
    for (const {task, world, state, input, authority} of prepared) {
      let callIndex = 0;
      resetRocoTools();
      configureRocoTools({client, stateVersion: () => {
        const value = callIndex === 0 ? authority.authority : state.state_version;
        callIndex += 1;
        return value;
      }});
      for (const arm of arms) {
        callIndex = 0;
        // 模型臂的 ask **一律**先过记录器：合法率必须从原文判，而轨迹集里只有解析后的决定。
        const ask = MODEL_ARMS.has(arm)
          ? recordingAsk(asks.get(arm), receipts,
            {arm, case_id: task.case_id, world_id: world.id, label: options.label})
          : null;
        const planner = registered(arm)
          ? makePlanner(arm, task, input.hints, {ask})
          : localModelPlanner(task, input.hints, {
            ask,
            system: LOCAL_TOOL_SYSTEM,
            // 4B 与云端用**同一个** system / 同一个 prompt 形状；只有超时预算不同，
            // 因为局内预算（3s）本来就是本地才有的约束，云端不该被它卡（也不该因此变好）。
            maxTokens: arm === 'cloud_deepseek' ? options.cloudMaxTokens : 96,
            timeoutMs: arm === 'cloud_deepseek' ? options.cloudTimeoutMs : 8000,
          });
        const run = await runArm({task, arm, input, planner, limit: armLimit(arm)});
        const reply = finalAnswer(task, {trace: run.trace, stopped: run.stopped, arm, hints: input.hints});
        const engineRefused = refusalsIn(run.trace).length > 0;
        const check = checkTask(task, {toolCalls: run.trace, reply, engineRefused});
        const spec = {arm, arm_kind: registered(arm) ? ARMS[arm].kind : 'model',
          mode: input.mode, screen: input.screen, authority: authority.authority};
        rows.push(record(task, world, state, {...spec, check}, run, reply));
        done += 1;
        if (!options.quiet && done % 100 === 0) process.stderr.write(`  ${done}/${total}\n`);
      }
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }

  const manifest = buildManifest(tasks, rows, arms, options, gateway);
  const outJsonl = options.out || join('/tmp', 'roco-4b', `traj-${options.label}.jsonl`);
  const outManifest = outJsonl.replace(/\.jsonl$/, '.manifest.json');
  const outReceipts = options.receipts || outJsonl.replace(/\.jsonl$/, '.receipts.jsonl');
  mkdirSync(dirname(outJsonl), {recursive: true});
  const header = JSON.stringify({record_type: 'agent_trajectory_header', ...manifest.header});
  writeFileSync(outJsonl, `${[header, ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`);
  writeFileSync(outManifest, `${JSON.stringify(manifest, null, 1)}\n`);
  writeFileSync(outReceipts, `${receipts.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const summary = summarise(rows);
  process.stdout.write(`${JSON.stringify({summary, manifest: manifest.header, written_to: outJsonl,
    receipts_to: outReceipts}, null, 1)}\n`);
  if (!options.quiet) process.stderr.write(`[ab-arms] 轨迹 ${rows.length} 条，判定通过 ${summary.passed}/${rows.length}\n`);
}

/** 与 `build-agent-trajectories.mjs` 的 `record()` 同形状（多一个 `label`）。 */
function record(task, world, state, spec, run, reply) {
  const trace = run.trace.map((item) => ({
    tool: item.tool, args: item.args, chosen_by: item.chosenBy, receipt: receiptSummary(item.result),
  }));
  return {
    record_type: 'agent_trajectory', format: FORMAT,
    traj_id: `${task.case_id}@${world.id}#${spec.arm}`,
    case_id: task.case_id, category: task.category, arm: spec.arm, arm_kind: spec.arm_kind,
    split: task.split,
    input: {
      message: task.message, mode: spec.mode, screen: spec.screen,
      world: {id: world.id, seed: world.seed, turns: world.turns,
        ruleset_id: state.ruleset_id, state_version: state.state_version,
        state_version_authority: spec.authority,
        forced_failure: world.forced_failure || null, conflict: Boolean(world.conflict),
        expect_silence: Boolean(world.expect_silence)},
      public_state_digest: digest(canonical(state.public)),
    },
    trace, stopped: run.stopped, reply,
    engine_refused: refusalsIn(run.trace).length > 0,
    checks: {passed: spec.check.passed, violations: spec.check.violations, items: spec.check.checks},
  };
}

function summarise(rows) {
  const byArm = {};
  for (const row of rows) {
    const bucket = byArm[row.arm] || (byArm[row.arm] = {total: 0, passed: 0, violations: {}});
    bucket.total += 1;
    if (row.checks.passed) bucket.passed += 1;
    for (const violation of row.checks.violations) {
      const key = violation.replace(/[（(].*$/, '').slice(0, 40);
      bucket.violations[key] = (bucket.violations[key] || 0) + 1;
    }
  }
  return {total: rows.length, passed: rows.filter((row) => row.checks.passed).length, by_arm: byArm};
}

function buildManifest(tasks, rows, arms, options, gateway) {
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const byArm = {};
  for (const arm of arms) {
    const subset = rows.filter((row) => row.arm === arm);
    const perCategory = {};
    for (const category of categories) {
      const inCategory = subset.filter((row) => row.category === category);
      perCategory[category] = {total: inCategory.length,
        passed: inCategory.filter((row) => row.checks.passed).length};
    }
    byArm[arm] = {
      kind: registered(arm) ? ARMS[arm].kind : 'model',
      note: registered(arm) ? ARMS[arm].note : `本次实测新增对照臂：${arm}`,
      limit: armLimit(arm), total: subset.length,
      passed: subset.filter((row) => row.checks.passed).length,
      pass_rate: subset.length ? Number((subset.filter((row) => row.checks.passed).length / subset.length).toFixed(4)) : null,
      per_category: perCategory,
      stopped: subset.reduce((acc, row) => ({...acc, [row.stopped]: (acc[row.stopped] || 0) + 1}), {}),
    };
  }
  const header = {
    format: FORMAT, set_id: `ab-arms-${options.label}`,
    built_by: 'reports/roco/local-model/ab-arms.mjs',
    task_set: options.sample ? 'agent-tasks-v1（按类分层抽样）' : 'agent-tasks-v1（全部）',
    task_set_digest: digest(tasks.map((task) => task.case_id).join(',')),
    model_identity: arms.some((arm) => arm.startsWith('local')) ? modelIdentity(gateway) : null,
    prompt_digest: digest(LOCAL_TOOL_SYSTEM),
    ruleset_id: RULESET_ID_FALLBACK,
    worlds_per_task: options.worlds, arms, categories, checkable: CHECKABLE.slice(),
    totals: {trajectories: rows.length, passed: rows.filter((row) => row.checks.passed).length,
      engine_refused: rows.filter((row) => row.engine_refused).length,
      cases: new Set(rows.map((row) => row.case_id)).size,
      worlds: new Set(rows.map((row) => row.input.world.id)).size},
    disciplines: [
      '三条臂跑同一批窗口、同一个 LOCAL_TOOL_SYSTEM、同一个 checkTask 判定器',
      '模型臂只问一次（不重试到成功）：选得准与试得多必须分得开',
      '失败轨迹原样保留（stopped 记明原因），不做清洗',
      '原始回执（原文/usage/延迟）另落 receipts.jsonl —— 轨迹集里只有解析后的决定',
    ],
    arms_summary: byArm,
  };
  return {header, rows: rows.length};
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  main().catch((error) => {
    process.stderr.write(`[ab-arms] 失败：${error?.stack || error}\n`);
    process.exit(1);
  });
}
