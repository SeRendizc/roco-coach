// 「这套评测到底测的是记忆还是泛化」——把 SFT 切分与轨迹产物对起来算。
//
// 为什么必须有这一条：`reports/roco/sft/dataset-report.json` 与
// `tests/evals/agent-trajectories*` **来源是同一批任务**（`source_task_set: agent-tasks-v1`），
// 而 SFT 的目标正是 `expect.tool` + `expect.args_must_match` —— 也就是 `checkTask`
// 用来判对错的那份期望。于是「模型臂通过率高」既可能是学到了，也可能只是**背过答案**。
// 不把这件事量出来，任何「4B 行不行」的结论都会把记忆当成能力。
//
// 两件事：
//   ① 证明（不是声称）`worldsFor(task, 3)` ⊆ `worldsFor(task, 9)`：
//      SFT 数据用 9 个世界/task，轨迹门禁用 3 个/task，而 `worldsFor` 是确定性的
//      前缀选择。若是子集，则轨迹里的窗口**逐条**都是 SFT 见过的 prompt。
//   ② 按 `sftSideOf` 给每个窗口打 train/val/test 标签，分侧报每臂通过率。
//      `test` 侧（机制「轮次推进」「拒绝」）是唯一没进训练的窗口——那里的数字
//      才是泛化，其余都是分布内。
//
// 用法：
//   node reports/roco/local-model/leakage.mjs --arm sft-v4=/tmp/roco-4b/traj-sft-v4.jsonl ...

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {worldsFor} from '../../../scripts/roco/agent-trajectories.mjs';
import {loadTasks} from '../../../scripts/roco/build-agent-trajectories.mjs';
import {sftSideOf, WORLDS_PER_TASK} from '../../../scripts/roco/build-agent-sft-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** ① 子集证明：轨迹的 3 个世界是否逐条落在 SFT 的 9 个世界里。 */
export function worldSubsetCheck(tasks, trajectoryWorlds = 3, sftWorlds = WORLDS_PER_TASK) {
  const rows = [];
  let missing = 0;
  for (const task of tasks) {
    const small = worldsFor(task, trajectoryWorlds).map((w) => w.id);
    const big = new Set(worldsFor(task, sftWorlds).map((w) => w.id));
    const outside = small.filter((id) => !big.has(id));
    if (outside.length) missing += 1;
    rows.push({case_id: task.case_id, side: sftSideOf(task), trajectory_worlds: small,
      sft_worlds: [...big], outside_sft_worlds: outside});
  }
  return {tasks: rows.length, tasks_with_worlds_outside_sft: missing,
    subset_holds: missing === 0, rows};
}

function parseArgs(argv) {
  const arms = []; let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arm') arms.push(String(argv[++i]));
    else if (argv[i] === '--out') out = String(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return {arms, out};
}

async function main() {
  const {arms, out} = parseArgs(process.argv.slice(2));
  const tasks = loadTasks();
  const subset = worldSubsetCheck(tasks);
  const sideOfTask = new Map(tasks.map((task) => [task.case_id, sftSideOf(task)]));
  const report = {
    generated_by: 'reports/roco/local-model/leakage.mjs',
    sft_dataset_report: JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'reports', 'roco', 'sft', 'dataset-report.json'), 'utf8')).counts,
    subset_check: {tasks: subset.tasks, tasks_with_worlds_outside_sft: subset.tasks_with_worlds_outside_sft,
      subset_holds: subset.subset_holds},
    side_of_tasks: Object.fromEntries(['train', 'val', 'test'].map((side) =>
      [side, [...sideOfTask.values()].filter((s) => s === side).length])),
    per_arm: {},
  };
  for (const spec of arms) {
    const [label, path] = spec.split('=');
    const rows = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
      .map((line) => JSON.parse(line)).filter((row) => row.record_type === 'agent_trajectory');
    const bySide = {};
    for (const row of rows) {
      const side = sideOfTask.get(row.case_id) ?? 'unknown';
      const armBucket = bySide[row.arm] || (bySide[row.arm] = {});
      const bucket = armBucket[side] || (armBucket[side] = {windows: 0, passed: 0, cases: new Set()});
      bucket.windows += 1;
      if (row.checks.passed) bucket.passed += 1;
      bucket.cases.add(row.case_id);
    }
    for (const armBucket of Object.values(bySide)) {
      for (const bucket of Object.values(armBucket)) {
        bucket.pass_rate = bucket.windows ? Number((bucket.passed / bucket.windows).toFixed(4)) : null;
        bucket.case_count = bucket.cases.size;
        delete bucket.cases;
      }
    }
    report.per_arm[label] = bySide;
  }
  const target = out || join('/tmp', 'roco-4b', 'leakage.json');
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({...report, subset_check: report.subset_check}, null, 1)}\n`);
  process.stdout.write(`written_to=${target}\n`);
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  main().catch((error) => { process.stderr.write(`[leakage] 失败：${error?.stack || error}\n`); process.exit(1); });
}
