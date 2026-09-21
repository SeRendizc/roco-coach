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
    meta: {case_id: task.case_id, category: task.category, side: task.split.side,
      family: task.split.family, mechanism: task.split.mechanism, world: hints.mode},
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
  // 切分隔离检查：test 家族不许出现在 train/val 里
  const trainFamilies = new Set(families.train || []);
  const leaked = (families.test || []).filter((f) => trainFamilies.has(f));
  const report = {
    generated_by: 'scripts/roco/build-agent-sft-data.mjs',
    purpose: 'W4-04 的工具选择 SFT 数据：目标来自**任务期望**，不是规则臂或模型的输出',
    source_task_set: 'agent-tasks-v1',
    worlds_per_task: WORLDS_PER_TASK,
    origin: 'synthetic/constructed — 不是真人对话，不得据此声称真人效果',
    split_rule: '沿用任务集的 family 切分；test 家族不在训练侧出现',
    counts: summary,
    families,
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
