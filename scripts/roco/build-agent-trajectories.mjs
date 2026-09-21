// W4-02：生成 Agent 工具轨迹集，并当场用判定器判一遍。
//
// 为什么现在就做：模型候选生成需要 key，但**轨迹格式、判定器、离线回放**这三件
// 不需要。而且它们是后面所有事情的前置——没有它们，就算拿到 5,000 条候选，
// 也没有任何东西能说清其中哪几条是错的。
//
// 这份脚本做四件事：
//   ① 用**真服务**产出的公开状态给每条任务造局面（不是手抄 fixture）；
//   ② 用一组 arm（规则 baseline / 反证 / 接线自检）跑出工具轨迹；
//   ③ 用 verify-agent-trajectories.mjs 的同一条判定器判每一条；
//   ④ 写 `tests/evals/roco/agent-trajectories-v1.jsonl` 与 `manifest.json`。
//
// 产物全部是**确定性**的：没有生成时间、没有 HEAD、没有随机数（随机只来自固定 seed
// 的哈希）。所以「产物过期」这件事可以直接用字节比较发现。

import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {
  FORMAT, ARM_NAMES, ARMS, armLimit, canonical, digest, finalAnswer, makePlanner,
  runArm, runInput, receiptSummary, worldsFor, CHECKABLE, refusalsIn, checkTask,
  LOCAL_TOOL_SYSTEM,
} from './agent-trajectories.mjs';
import {gatewayAsk} from './local-model-ask.mjs';
import {modelIdentity} from './model-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GENERATOR = join(ROOT, 'scripts', 'roco', 'gen-plan-state.py');
const TASKS = join(ROOT, 'tests', 'evals', 'agent-tasks-v1.jsonl');
const OUT_DIR = join(ROOT, 'tests', 'evals');
const OUT_JSONL = join(OUT_DIR, 'agent-trajectories-v1.jsonl');
const OUT_MANIFEST = join(OUT_DIR, 'agent-trajectories-v1.manifest.json');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';
const WORLDS_PER_TASK = Number(process.env.ROCO_TRAJ_WORLDS || 3);

function args(argv) {
  const out = {arms: null, write: true, quiet: false, out: null, gateway: null};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') out.write = false;
    else if (argv[i] === '--quiet') out.quiet = true;
    else if (argv[i] === '--out') out.out = String(argv[++i]);
    else if (argv[i] === '--gateway') out.gateway = String(argv[++i]);
    else if (argv[i] === '--arms') out.arms = String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

export function loadTasks(path = TASKS) {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((row) => row.record_type === 'agent_task');
}

/**
 * 模型臂的 `ask`：问本地网关，拿到一段文本。
 *
 * 实现只有一处（`local-model-ask.mjs`），`shadow-replay.mjs` 与这里共用。
 * 各写一遍必然漂移，而漂移的后果是两条链上的模型行为不可比、却看不出来。
 *
 * `ask` 只在这里建一次，`makePlanner` 用在每条轨迹上。
 */


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

/** 让引擎自己产出世界的公开状态。turn 数与版本号都由参数决定，产物可复现。 */
export function worldState(world, {stateVersionOverride = null} = {}) {
  const argv = [GENERATOR, String(world.seed), '--turns', String(world.turns || 0)];
  if (stateVersionOverride !== null) argv.push('--version', String(stateVersionOverride));
  const raw = execFileSync(PYTHON_BIN, argv, {cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  return JSON.parse(raw);
}

/**
 * 冲突世界注入的**来源冲突**。
 *
 * 为什么要有这个：`evidence_conflict` 这一类的任务是「两个来源对不上时要把不一致说出来」。
 * 但如果世界里根本没有冲突可看，Agent 唯一能「通过」的方式就是瞎猜——
 * 那样这一类的 100% 就毫无意义。所以这里由**世界**注入一份明确标注为
 * `synthetic` 的冲突，让「说出来」这件事有可观察的依据，也让这份轨迹集
 * 不会假装引擎真的有两份互相矛盾的来源。
 *
 * 数值不是抄的：`primary` 来自面板换算（`1.10*race+60`，种族 136），
 * `secondary` 是社区分布的中位数口径，两者相差 29.2。两份都标着来源与核验状态。
 */
export function sourceConflictFor(world, state) {
  if (!world.conflict) return null;
  const pet = (state.public?.self?.pets || [])[0];
  return {
    fact: `${pet?.name || '目标精灵'}.atk`,
    synthetic: true,
    reason: '评测世界注入：用来验证「来源冲突必须被说出来」，不代表引擎里真的存在两份矛盾数据',
    primary: {source: 'ruleset_panel_conversion', value: 209.7, verified: false, note: '1.10*race+60，公式未核验（MC-010）'},
    secondary: {source: 'community_distribution', value: 180.5, verified: false, note: '社区口径中位数，样本与版本不可比'},
  };
}

/** 世界 → 版本权威。`stale` 世界刻意让权威版本比公开状态高一版。 */
export function versionAuthority(world, state) {
  const exposed = state.state_version;
  return {
    exposed,
    authority: exposed,
    source: 'engine-state-version',
    // 版本推进由 seed/turns 产生的**真实**回合同步造成；
    // 这里不再人为把权威版本抬高，避免「公开状态与权威版本对不上」。
    advanced_by: world.bump_version ? 'turn-advance' : null,
  };
}

/**
 * 一条轨迹记录。
 *
 * 字段都是**程序要用的**，没有为了好看而存在的字段：
 *   - `input.world` 决定重放时用哪个局面；
 *   - `trace[].receipt` 是回执的摘要 + 全文摘要，回放时逐条比对；
 *   - `checks` 是判定器这一条的逐项结果，出问题时不用重跑就能看哪一项挂了；
 *   - `stopped` 记下「为什么停」——把失败洗成成功的第一步就是丢掉这个字段。
 */
function record(task, world, state, spec, run, reply) {
  const trace = run.trace.map((item) => ({
    tool: item.tool,
    args: item.args,
    chosen_by: item.chosenBy,
    receipt: receiptSummary(item.result),
  }));
  const engineRefused = refusalsIn(run.trace).length > 0;
  const checks = spec.check;
  return {
    record_type: 'agent_trajectory',
    format: FORMAT,
    traj_id: `${task.case_id}@${world.id}#${spec.arm}`,
    case_id: task.case_id,
    category: task.category,
    arm: spec.arm,
    arm_kind: spec.arm_kind,
    split: task.split,
    input: {
      message: task.message,
      mode: spec.mode,
      screen: spec.screen,
      world: {
        id: world.id, seed: world.seed, turns: world.turns,
        ruleset_id: state.ruleset_id, state_version: state.state_version,
        state_version_authority: spec.authority,
        forced_failure: world.forced_failure || null,
        conflict: Boolean(world.conflict),
        expect_silence: Boolean(world.expect_silence),
      },
      public_state_digest: digest(canonical(state.public)),
    },
    trace,
    stopped: run.stopped,
    reply,
    engine_refused: engineRefused,
    checks: {passed: checks.passed, violations: checks.violations, items: checks.checks},
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const arms = options.arms || ARM_NAMES.slice();
  for (const arm of arms) if (!ARMS[arm]) throw new Error(`未知 arm：${arm}`);
  const tasks = loadTasks();
  const modelArms = arms.filter((arm) => ARMS[arm].kind === 'model');
  const gateway = options.gateway
    || `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`;
  if (modelArms.length) {
    // 模型臂必须有网关：**没有就明确失败**，不许安静地产出一份「其实是规则臂」的产物。
    const ask = gatewayAsk(gateway);
    try {
      const probe = await ask({prompt: '{"stop":true}', maxTokens: 8, timeoutMs: 20000});
      if (typeof probe?.text !== 'string') throw new Error('网关返回形状不对');
    } catch (error) {
      process.stderr.write(`[agent-trajectories] 模型臂需要可用的本地网关（${gateway}）：`
        + `${error?.message || error}\n先跑 bash scripts/model/start-mac.sh\n`);
      process.exitCode = 2;
      return;
    }
  }
  const ask = modelArms.length ? gatewayAsk(gateway) : null;
  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const rows = [];
  const worldCache = new Map();
  try {
    await client.startService();
    const prepared = [];
    for (const task of tasks) {
      for (const world of worldsFor(task, WORLDS_PER_TASK)) {
        // 缓存里存的是**完整世界**（公开状态 + 世界注入的冲突），不是只存引擎产物：
        // 只缓存引擎产物时，走「版本推进」那条支路会重新取一份**没有冲突**的世界，
        // 于是冲突任务在那条支路上悄悄退化成普通任务（`evidence_conflict` 的通过率
        // 因此从 100% 掉到 33%，看起来像 Agent 变笨了）。
        const cacheKey = `${world.id}:${world.seed}:${world.turns}`;
        if (!worldCache.has(cacheKey)) {
          const fresh = worldState(world);
          worldCache.set(cacheKey, {...fresh, source_conflict: sourceConflictFor(world, fresh)});
        }
        const base = worldCache.get(cacheKey);
        // 版本推进过的世界：**公开状态本身**就是推进后的那一版。
        //
        // 之前的写法是把权威版本 +1、却把手头这份公开状态留在旧版本上，于是连
        // baseline 都会拿着旧版本去查、拿到 version_mismatch——那不是「Agent 犯错」，
        // 那是世界自相矛盾（屏幕上写着 12，包里写着 11）。反证组因此和 baseline
        // 一起变红，差距消失。现在两边一致：公开状态 12、权威 12、旧缓存 11 会被拒。
        const stateVersionOverride = world.bump_version ? base.state_version + 1 : null;
        const state = stateVersionOverride === null
          ? base
          : {...worldState(world, {stateVersionOverride}), source_conflict: base.source_conflict};
        const authority = versionAuthority(world, state);
        const input = runInput(task, world, state);
        prepared.push({task, world, state, input, authority});
      }
    }
    const total = prepared.length * arms.length;
    if (!options.quiet) process.stderr.write(`[agent-trajectories] ${tasks.length} 条任务 × ${WORLDS_PER_TASK} 个世界 × ${arms.length} 个 arm = ${total} 条轨迹\n`);
    let done = 0;
    for (const {task, world, state, input, authority} of prepared) {
      let callIndex = 0;
      // 换世界必须清掉工具层记住的「见过的状态版本」。
      //
      // 不清就会串号：上一个世界把初始版本记到 `rocoSeenStateVersions`，下一个世界
      // 拿着自己的版本 0 去查，被判成「版本倒退」而拒绝——回执里写着
      //「state_version 0 与当前状态 0 不一致」，两个数字一样却是过期错误。
      // 这个错误极难从回执本身看出来，必须先清状态再配置。
      resetRocoTools();
      configureRocoTools({client, stateVersion: () => {
        const value = callIndex === 0 ? authority.authority : state.state_version;
        callIndex += 1;
        return value;
      }});
      for (const arm of arms) {
        callIndex = 0;
        const spec = {arm, arm_kind: ARMS[arm].kind, mode: input.mode, screen: input.screen, authority: authority.authority};
        const planner = makePlanner(arm, task, input.hints, {ask});
        const run = await runArm({task, arm, input, planner, limit: armLimit(arm)});
        const reply = finalAnswer(task, {trace: run.trace, stopped: run.stopped, arm, hints: input.hints});
        const engineRefused = refusalsIn(run.trace).length > 0;
        const check = checkWith(task, run.trace, reply, engineRefused);
        rows.push(record(task, world, state, {...spec, check}, run, reply));
        done += 1;
        if (!options.quiet && done % 200 === 0) process.stderr.write(`  ${done}/${total}\n`);
      }
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }

  const manifest = buildManifest(tasks, rows, arms,
    {identity: modelArms.length ? modelIdentity(gateway) : null});
  // 模型臂的产物写到自己那份路径上（默认仍是规则臂那份）。理由：规则臂那份是
  // **字节可复现**的门禁，模型臂做不到（同一份权重重跑也可能逐条不同），
  // 混进同一个文件会让「字节可复现」这个性质变成假的。
  const outJsonl = options.out || OUT_JSONL;
  const outManifest = options.out
    ? options.out.replace(/\.jsonl$/, '.manifest.json')
    : OUT_MANIFEST;
  if (options.write) {
    mkdirSync(dirname(outJsonl), {recursive: true});
    const header = JSON.stringify({record_type: 'agent_trajectory_header', ...manifest.header});
    writeFileSync(outJsonl, `${[header, ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`);
    writeFileSync(outManifest, `${JSON.stringify(manifest, null, 1)}\n`);
  }
  const summary = summarise(rows);
  process.stdout.write(`${JSON.stringify({summary, manifest: manifest.header,
    written_to: options.write ? outJsonl : null}, null, 1)}\n`);
  if (!options.quiet) process.stderr.write(`[agent-trajectories] 轨迹 ${rows.length} 条，判定通过 ${summary.passed}/${rows.length}\n`);
}

// 判定器只有一份实现（agent-trajectories.mjs 的 checkTask）：生成时与回放时
// 用的是同一个函数，避免「生成一套、回放另一套」——那种漂移最后两边都不算数。
function checkWith(task, trace, reply, engineRefused) {
  return checkTask(task, {toolCalls: trace, reply, engineRefused});
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
  const stopped = {};
  for (const row of rows) stopped[row.stopped] = (stopped[row.stopped] || 0) + 1;
  return {
    total: rows.length,
    passed: rows.filter((row) => row.checks.passed).length,
    by_arm: byArm,
    stopped,
    engine_refused: rows.filter((row) => row.engine_refused).length,
  };
}

/** 头部与清单：只放稳定字段（没有时间戳、没有 HEAD）。 */
function buildManifest(tasks, rows, arms, {identity = null} = {}) {
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const byArm = {};
  for (const arm of arms) {
    const subset = rows.filter((row) => row.arm === arm);
    const perCategory = {};
    for (const category of categories) {
      const inCategory = subset.filter((row) => row.category === category);
      perCategory[category] = {total: inCategory.length, passed: inCategory.filter((row) => row.checks.passed).length};
    }
    byArm[arm] = {
      kind: ARMS[arm].kind,
      note: ARMS[arm].note,
      limit: armLimit(arm),
      total: subset.length,
      passed: subset.filter((row) => row.checks.passed).length,
      pass_rate: subset.length ? Number((subset.filter((row) => row.checks.passed).length / subset.length).toFixed(4)) : null,
      per_category: perCategory,
      stopped: subset.reduce((acc, row) => ({...acc, [row.stopped]: (acc[row.stopped] || 0) + 1}), {}),
    };
  }
  const header = {
    format: FORMAT,
    set_id: 'agent-trajectories-v1',
    built_by: 'scripts/roco/build-agent-trajectories.mjs',
    task_set: 'agent-tasks-v1',
    task_set_digest: digest(readFileSync(TASKS, 'utf8')),
    // 模型臂的产物必须记身份：模型路径 + 适配器 + 权重 sha256 + 提示摘要。
    // 规则臂为 null（它不经过模型）。
    model_identity: identity,
    prompt_digest: rows.some((row) => ARMS[row.arm]?.kind === 'model') ? digest(LOCAL_TOOL_SYSTEM) : null,
    ruleset_id: RULESET_ID,
    worlds_per_task: WORLDS_PER_TASK,
    arms,
    categories,
    checkable: CHECKABLE.slice(),
    totals: {
      trajectories: rows.length,
      passed: rows.filter((row) => row.checks.passed).length,
      engine_refused: rows.filter((row) => row.engine_refused).length,
      cases: new Set(rows.map((row) => row.case_id)).size,
      worlds: new Set(rows.map((row) => row.input.world.id)).size,
    },
    disciplines: [
      '轨迹只记公开输入与工具回执摘要；回执全文不落盘，摘要是剔除延迟后的规范化摘要',
      '正文只用回执里真的出现过的字段生成，不从任务期望抄答案',
      '失败轨迹原样保留（stopped 记明原因），不做「重试到成功」的清洗',
      '产物确定性：无时间戳、无 HEAD、无随机（随机只来自固定 seed 的哈希）',
      ...(rows.some((row) => ARMS[row.arm]?.kind === 'model')
        ? ['**模型臂这一份不声称字节可复现**：同一份权重重跑也可能逐条不同。'
          + '它靠 `model_identity`（适配器 sha256 + 提示摘要）钉住，而不是靠重跑一致。']
        : []),
    ],
    arms_summary: byArm,
  };
  return {header, rows: rows.length};
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  if (existsSync(GENERATOR)) {
    main().catch((error) => {
      process.stderr.write(`[agent-trajectories] 失败：${error?.stack || error}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write('[agent-trajectories] 找不到状态生成器，退出\n');
    process.exit(2);
  }
}
