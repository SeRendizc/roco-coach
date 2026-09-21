#!/usr/bin/env node
// W4-04 的数据那一半：把固定的 Agent 任务集转成**工具选择**的 SFT 数据。
//
// 边界（写给以后的自己）
// --------------------
// - 目标来自**任务期望**（`expect.tool` + `expect.args_must_match`），不是规则臂的输出，
//   也不是模型自己的输出。用后两者当目标等于让学生抄自己的作业。
// - 只用**公开**信息：系统提示 + 题面 + 公开提示（模式、状态版本、队伍、锁定伙伴）。
//   任何隐藏信息（对手待执行动作、真实 seed）都不进数据。
// - 切分**沿用任务集的 family 切分**：test 家族在训练里完全不出现。
//   这不是形式——它让「换一个阵容家族还灵不灵」变成可测的问题。
// - 这是**合成/构造**数据，不是真人对话。不得据此声称对真人效果。
//
// 输出：mlx-lm 的 chat 格式（`{"messages":[{role,content},…]}`），三个文件。
//
// 跑法::
//
//     node scripts/roco/build-agent-sft-data.mjs --write
//     node scripts/roco/build-agent-sft-data.mjs --check

import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {loadTasks, worldState, sourceConflictFor} from './build-agent-trajectories.mjs';
import {worldsFor, runInput, LOCAL_TOOL_SYSTEM} from './agent-trajectories.mjs';
import {cleanEnv} from '../../tests/helpers/subprocess.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'sft');
export const WORLDS_PER_TASK = 4;

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
 * 一条任务 → 一条训练样本。
 *
 * 目标是 `{"tool":…,"args":{…}}` 或 `{"stop":true}`。
 * `state_version` **不写进目标**：它是运行时给的，写进去会让模型学会编版本号。
 * 参数只保留任务期望里明确要求的键——那正是它必须学对的东西。
 */
export function sampleOf(task, hints) {
  const expect = task.expect || {};
  const target = expect.tool
    ? {tool: expect.tool, args: {...(expect.args_must_match || {})}}
    : {stop: true};
  const user = JSON.stringify({
    message: task.message,
    screen: hints.mode === 'camp' ? 'camp' : 'battle',
    hints: {
      state_version: hints.state_version,
      ...(hints.locked_pet ? {locked_pet: hints.locked_pet} : {}),
      ...(hints.team ? {team: hints.team} : {}),
    },
  });
  return {
    messages: [
      {role: 'system', content: LOCAL_TOOL_SYSTEM},
      {role: 'user', content: user},
      {role: 'assistant', content: JSON.stringify(target)},
    ],
    // 元数据单独放，训练时 mlx-lm 只读 messages；留着是为了评测能按类别/家族核对
    // `side` 用 **SFT 专属切分**，不是任务集的 side：
    // 任务集留出家族（导致某个家族在训练里完全缺席），SFT 留出机制与模板。
    // 两个 side 都留下，报告里能看出它们不一样——这是这一轮的核心改动。
    meta: {case_id: task.case_id, category: task.category, side: sftSideOf(task),
      task_side: task.split.side, family: task.split.family,
      mechanism: task.split.mechanism, template: task.split.template, world: hints.mode},
  };
}

export async function build({limit = 0} = {}) {
  const tasks = loadTasks().slice(0, limit || undefined);
  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const samples = [];
  const worldCache = new Map();
  try {
    await client.startService();
    for (const task of tasks) {
      for (const world of worldsFor(task, WORLDS_PER_TASK)) {
        const key = `${world.id}:${world.seed}:${world.turns}`;
        if (!worldCache.has(key)) {
          const fresh = worldState(world);
          worldCache.set(key, {...fresh, source_conflict: sourceConflictFor(world, fresh)});
        }
        const state = worldCache.get(key);
        let callIndex = 0;
        resetRocoTools();
        configureRocoTools({client, stateVersion: () => {
          const value = callIndex === 0 ? state.state_version : state.state_version;
          callIndex += 1;
          return value;
        }});
        const input = runInput(task, world, state);
        samples.push(sampleOf(task, input.hints));
      }
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }
  return samples;
}

/**
 * SFT 专属切分：**留出机制与表达模板，让每个家族都出现在训练里**。
 *
 * 为什么不能沿用任务集的切分（第 33 轮实测）：任务集留出的是**家族**，
 * 于是 `A组三人-无锁定` 这个家族在整个训练集里一条都没有，而所有
 * `roster_constraint` 任务恰好只属于这个家族。模型学不到「没有锁定伙伴时怎么办」，
 * 在测试上 24/24 只输出 `{stop:true}`，整类归零。
 *
 * 评测口径不变（同一套 288 条、同一把尺子），只换**训练数据怎么分**：
 *   · 训练：每个家族都参加；留出若干机制与模板不训练；
 *   · 验证：见过来留出机制的题，用来看 loss；
 *   · family/template 侧留给评测去问「没见过的机制/说法还灵不灵」。
 *
 * 这不是放宽评测——评测用的还是任务集原样的 288 条；这里改的只是**训练侧看到什么**。
 */
//: 按**模板名**显式留出，不用哈希分桶。
//: 分桶看起来「客观」，但它对只有 13 个取值的维度会给出极不均衡的切分
//: （实测：819/9/0，val 只拿到 9 条、test 一条都没有）。切分要能解释，
//: 也要真的产生三侧——显式列出留出哪些，比事后解释桶为什么会这样更诚实。
export const HOLDOUT_TEMPLATES = Object.freeze({
  // 留出「换一种说法」的问法。
  //
  // 选择方式是**穷举后取最大留出集**，约束是「每个机制在训练侧至少留 2 条」：
  // 留出某个取值时不能连带把另一个维度的取值也抽走。这一条是被两次真事故逼出来的——
  //   第 33 轮留出家族 → `roster_constraint` 所属家族在训练里缺席，整类归零；
  //   第 34 轮留出机制 → `阵容诊断` 在训练里缺席，该类 24/24 只输出 stop。
  // 两次都是「留出的不是模型该泛化的东西，而是它根本没学过的知识」。
  //
  // 这一组留出 42% 的任务，且每个机制在训练侧仍有 ≥2 条。
  // `scripts/roco/verify-sft-split.mjs` 会独立复核这两条性质（不靠这里的注释）。
  // 留出**两种最常用的问法**（`直问` + `背景`，合计 42% 的任务）。
  // 再留就一定会抽走某个机制在训练里的最后几条——穷举的边界在这里。
  test: ['直问', '背景'],
  // 验证侧留 `追问`（最长的表达，用来看 loss 是否真的在降）
  val: ['追问'],
});

export function sftSideOf(task) {
  const template = task.split.template;
  if (HOLDOUT_TEMPLATES.test.includes(template)) return 'test';
  if (HOLDOUT_TEMPLATES.val.includes(template)) return 'val';
  return 'train';
}

function hashKey(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function summarise(samples) {
  const by = (key) => samples.reduce((acc, row) => {
    const bucket = acc[row.meta[key]] || (acc[row.meta[key]] = 0);
    return {...acc, [row.meta[key]]: bucket + 1};
  }, {});
  return {
    total: samples.length,
    by_side: by('side'),
    by_category: by('category'),
    families_by_side: samples.reduce((acc, row) => {
      const set = acc[row.meta.side] || (acc[row.meta.side] = new Set());
      set.add(row.meta.family);
      return acc;
    }, {}),
  };
}

async function main(argv) {
  const write = argv.includes('--write');
  const samples = await build();
  const summary = summarise(samples);
  const families = Object.fromEntries(Object.entries(summary.families_by_side)
    .map(([side, set]) => [side, [...set]]));
  // 覆盖检查：**每个家族都必须在训练侧出现**。
  // 这正是第 33 轮那次失败的直接原因（A组三人-无锁定 在训练里缺席，
  // 而 roster_constraint 全部属于它）。这条检查让同类错误不可能再静默发生。
  const trainFamilies = new Set(families.train || []);
  const missingFamilies = [...new Set(samples.map((row) => row.meta.family))]
    .filter((family) => !trainFamilies.has(family));
  // 留出检查：留出的机制/模板在训练侧一条都不该有（这是泛化问题真正要问的东西）
  const trainMechanisms = new Set(samples.filter((r) => r.meta.side === 'train').map((r) => r.meta.mechanism));
  const missingMechanisms = [...new Set(samples.map((r) => r.meta.mechanism))]
    .filter((m) => !trainMechanisms.has(m));
  const trainTemplates = new Set(samples.filter((r) => r.meta.side === 'train').map((r) => r.meta.template));
  const heldOutTemplates = [...new Set(samples.map((r) => r.meta.template))]
    .filter((t) => !trainTemplates.has(t));
  const leaked = [...missingFamilies, ...missingMechanisms];
  const report = {
    generated_by: 'scripts/roco/build-agent-sft-data.mjs',
    purpose: 'W4-04 的工具选择 SFT 数据：目标来自**任务期望**，不是规则臂或模型的输出',
    source_task_set: 'agent-tasks-v1',
    worlds_per_task: WORLDS_PER_TASK,
    origin: 'synthetic/constructed — 不是真人对话，不得据此声称真人效果',
    split_rule: 'SFT 专属切分：留出**表达模板**，每个家族与每个机制都出现在训练侧'
      + '（家族切分与机制切分都不适合做训练切分：前者让一个家族在训练里缺席，'
      + '后者让一个机制在训练里缺席——两次都直接导致整类归零。'
      + '模板切分问的才是「换种说法还认不认得」）',
    counts: summary,
    families,
    missing_families_in_train: missingFamilies,
    missing_mechanisms_in_train: missingMechanisms,
    held_out_templates: heldOutTemplates,
    holdout_leak: leaked,
  };
  if (write) {
    mkdirSync(OUT_DIR, {recursive: true});
    for (const side of ['train', 'valid', 'test']) {
      const rows = samples.filter((row) => row.meta.side === (side === 'valid' ? 'val' : side));
      // mlx-lm 认 `train.jsonl` / `valid.jsonl` / `test.jsonl`
      writeFileSync(join(OUT_DIR, `${side}.jsonl`),
        `${rows.map((row) => JSON.stringify({messages: row.messages})).join('\n')}\n`);
    }
    writeFileSync(join(OUT_DIR, 'dataset-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify({written: write, out: write ? OUT_DIR : null,
    total: summary.total, by_side: summary.by_side, holdout_leak: leaked}, null, 1)}\n`);
  return leaked.length ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[sft-data] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
