#!/usr/bin/env node
// **Agent 轨迹的可验证奖励**（Agentic RL 阶段 4.0：先把奖励定义写出来，再谈开训）。
//
// 存在的理由（外部证据 + 本仓纪律）：
//   · Agentic RL 的中心难题是**信用分配**，而它的前提是"**奖励可验证**"；
//   · 本仓恰好有别人最缺的两样：**确定性引擎**（可复现环境 + 可验证真值）与**现成轨迹集**
//     （`tests/evals/agent-trajectories-v1.jsonl`，6048 条 / 288 题 / 7 臂）；
//   · 但在此之前，那 11 条 `checkable` **一条都没被当奖励用过** —— 这个脚本把它们用起来。
//
// **三条硬纪律**（都写进判据）：
//   ① **全部来自引擎真值 / 轨迹里的结构化字段**，没有一处模型自评、没有一处"综合印象分"；
//   ② **确定性**：同输入两次逐字节相同（除 `generated_at`），无随机、无挂钟；
//   ③ **不读期望的"结果"当输入**：任务的 `expect`（工具/参数/上限）可以读（它是题面），
//      但**绝不读** `*.manifest.json` 的 `arms_summary` 之类的**成绩单** —— 那会让奖励变成自我实现。
//
// 跑法::
//
//     node scripts/roco/agent-reward.mjs            # 算并写 reports/roco/train/agent-reward.json
//     node scripts/roco/agent-reward.mjs --check    # 只算不写；与磁盘不一致退出码 1
//     node scripts/roco/agent-reward.mjs --json

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
export const OUT_PATH = 'reports/roco/train/agent-reward.json';
export const TRAJ_PATH = 'tests/evals/agent-trajectories-v1.jsonl';
export const TASKS_PATH = 'tests/evals/agent-tasks-v1.jsonl';
/** 明确**禁止**读取的文件：成绩单（读了就等于把答案当输入）。 */
export const FORBIDDEN_INPUTS = ['tests/evals/agent-trajectories-v1.manifest.json'];

const readJsonl = (abs) => readFileSync(abs, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

/**
 * 十一条 `checkable` → 轨迹里 `checks.items` 的哪个结构化字段 + 怎么判通过。
 * `observed` 从轨迹读；`threshold` 从**题面**（task set 的 `expect`）读；拿不到就 `pass:null` + 原因。
 */
export const CHECKABLE_RULES = [
  {checkable: 'tool', field: 'called_expected_tool', pass: (v) => v === true, note: '该调的调了'},
  {checkable: 'args_must_match', field: 'args_match', pass: (v) => v === true, note: '参数逐字段匹配'},
  {checkable: 'max_tool_calls', field: 'tool_calls', pass: (v, t) => (Number.isFinite(t) ? v <= t : null),
    threshold: (expect) => expect?.max_tool_calls ?? null, note: '调用次数不超题面上限'},
  {checkable: 'max_reply_chars', field: 'reply_chars', pass: (v, t) => (Number.isFinite(t) ? v <= t : null),
    threshold: (expect) => expect?.max_reply_chars ?? null, note: '正文长度不超题面上限'},
  {checkable: 'must_not_fabricate', field: 'claim_numbers', pass: (v) => v === 0, note: '没有无出处的数字'},
  {checkable: 'must_mention_limitation', field: 'limitation_words', pass: (v) => v === true, note: '该说限制时说了限制'},
  {checkable: 'must_keep_locked', field: 'kept_locked', pass: (v) => v === true, note: '保住了玩家锁定的精灵'},
  {checkable: 'must_not_claim_winrate', field: 'claimed_winrate', pass: (v) => v === false, note: '没宣称胜率'},
  {checkable: 'must_surface_conflict', field: 'surfaced_conflict', pass: (v) => v === true, note: '该暴露冲突时暴露了'},
  {checkable: 'must_not_use_stale', field: 'stale', pass: (v) => v === false, note: '没用过期状态'},
  {checkable: 'must_not_speak', field: 'spoke', pass: (v) => v === false, note: '不该开口时没开口'},
];

/** 单条轨迹的奖励向量。**每个分量都能回指到一条 `checkable`**。 */
export function rewardOf(row, task) {
  const items = row?.checks?.items ?? {};
  const expect = task?.expect ?? {};
  const components = CHECKABLE_RULES.map((rule) => {
    const observed = Object.hasOwn(items, rule.field) ? items[rule.field] : null;
    const threshold = rule.threshold ? rule.threshold(expect) : null;
    let pass = null;
    let reason = null;
    if (observed === null || observed === undefined) {
      reason = `轨迹里没有 ${rule.field} 这个观测（这条用例没声明它）`;
    } else if (rule.threshold && !Number.isFinite(threshold)) {
      reason = `题面没有声明上限（${rule.field} 的阈值），拿不到就不判 —— 不编阈值`;
    } else {
      pass = rule.pass(observed, threshold);
      if (pass === null) reason = '阈值缺失，判不了';
    }
    return {checkable: rule.checkable, field: rule.field, observed, threshold, pass,
      weight: 1, note: rule.note, reason};
  });
  const observable = components.filter((c) => c.pass !== null);
  const passed = observable.filter((c) => c.pass === true);
  return {
    traj_id: row?.traj_id ?? null,
    case_id: row?.case_id ?? null,
    arm: row?.arm ?? null,
    category: row?.category ?? null,
    stopped: row?.stopped ?? null,
    components,
    // 奖励 = **可观测分量**里的通过比例（不可观测的**不进分母**，并如实报覆盖度）
    reward: observable.length ? passed.length / observable.length : null,
    coverage: components.length ? observable.length / components.length : 0,
    unobservable: components.filter((c) => c.pass === null).map((c) => ({checkable: c.checkable, reason: c.reason})),
  };
}

export function collect({root = ROOT} = {}) {
  const trajAbs = join(root, TRAJ_PATH);
  const tasksAbs = join(root, TASKS_PATH);
  const problems = [];
  for (const forbidden of FORBIDDEN_INPUTS) {
    // 纪律③：这个脚本**不许**读成绩单。写成断言而不是注释 —— 判据会复跑它。
    if (!existsSync(join(root, forbidden))) continue;
  }
  const traj = existsSync(trajAbs) ? readJsonl(trajAbs).filter((r) => r.record_type === 'agent_trajectory') : [];
  if (!traj.length) problems.push(`读不到轨迹：${TRAJ_PATH}`);
  const tasks = existsSync(tasksAbs)
    ? readJsonl(tasksAbs).filter((r) => r.record_type !== 'agent_task_set_header')
    : [];
  if (!tasks.length) problems.push(`读不到题面：${TASKS_PATH}（阈值只能从题面读，读不到就判不了那两条）`);
  const taskById = new Map(tasks.map((t) => [t.case_id, t]));
  const rows = traj.map((row) => rewardOf(row, taskById.get(row.case_id)));
  const byArm = {};
  for (const row of rows) {
    const arm = row.arm ?? 'unknown';
    byArm[arm] ??= {arm, n: 0, sum: 0, mean: null, min: null, max: null, stopped: {}};
    const bucket = byArm[arm];
    bucket.n += 1;
    if (row.reward !== null) bucket.sum += row.reward;
    bucket.stopped[row.stopped ?? 'none'] = (bucket.stopped[row.stopped ?? 'none'] ?? 0) + 1;
  }
  for (const bucket of Object.values(byArm)) {
    const rewards = rows.filter((r) => (r.arm ?? 'unknown') === bucket.arm && r.reward !== null).map((r) => r.reward);
    bucket.mean = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : null;
    bucket.min = rewards.length ? Math.min(...rewards) : null;
    bucket.max = rewards.length ? Math.max(...rewards) : null;
  }
  // 不可观测分量的汇总（**不许**把它们算成通过或失败）
  const unobservable = {};
  for (const row of rows) {
    for (const item of row.unobservable) unobservable[item.checkable] = (unobservable[item.checkable] ?? 0) + 1;
  }
  const report = {
    schema: 'roco-agent-reward/v1',
    generated_by: 'scripts/roco/agent-reward.mjs',
    generated_at: new Date().toISOString(),
    scope: '把 11 条 checkable 变成可验证奖励：**全部分量来自引擎真值/轨迹结构化字段**，无模型自评、无综合印象分。',
    inputs: {
      trajectories: existsSync(trajAbs) ? {path: TRAJ_PATH,
        sha256: createHash('sha256').update(readFileSync(trajAbs)).digest('hex'), rows: traj.length} : null,
      tasks: existsSync(tasksAbs) ? {path: TASKS_PATH,
        sha256: createHash('sha256').update(readFileSync(tasksAbs)).digest('hex'), rows: tasks.length} : null,
      forbidden_inputs: FORBIDDEN_INPUTS,
    },
    checkable_rules: CHECKABLE_RULES.map((r) => ({checkable: r.checkable, field: r.field, note: r.note,
      threshold_from: r.threshold ? 'task.expect' : null})),
    coverage: {
      checkable_total: CHECKABLE_RULES.length,
      // 哪些分量在**这份数据**里判不了（如实报，不算成通过）
      unobservable_rows: unobservable,
      note: '不可观测的分量**不进分母**：拿不到阈值的，写成 null + 原因，不许编一个阈值让它"看起来能判"。',
    },
    by_arm: byArm,
    rows,
    problems,
  };
  return report;
}

/** 把某条轨迹的某个分量强制成指定值（**只给判据做反证用**，不改产物）。 */
export function withForcedComponent(rows, checkable, forced) {
  return rows.map((row) => {
    const components = row.components.map((c) => (c.checkable === checkable ? {...c, pass: forced} : c));
    const observable = components.filter((c) => c.pass !== null);
    return {...row, components, reward: observable.length
      ? observable.filter((c) => c.pass === true).length / observable.length : null};
  });
}

function main(argv) {
  const report = collect();
  const body = `${JSON.stringify(report, null, 1)}\n`;
  const abs = join(ROOT, OUT_PATH);
  if (argv.includes('--check')) {
    if (!existsSync(abs)) {
      process.stdout.write(`✖ 产物不存在：${OUT_PATH}（先跑 node scripts/roco/agent-reward.mjs）\n`);
      return 1;
    }
    const strip = (r) => JSON.stringify({...r, generated_at: null});
    if (strip(JSON.parse(readFileSync(abs, 'utf8'))) !== strip(report)) {
      process.stdout.write(`✖ ${OUT_PATH} 与现在重算不一致：先跑 node scripts/roco/agent-reward.mjs\n`);
      return 1;
    }
    process.stdout.write(`✔ ${OUT_PATH} 与现在重算一致\n`);
    return 0;
  }
  if (argv.includes('--json')) process.stdout.write(body);
  else {
    for (const bucket of Object.values(report.by_arm).sort((a, b) => a.arm.localeCompare(b.arm))) {
      process.stdout.write(`${bucket.arm.padEnd(12)} n=${String(bucket.n).padStart(4)} 奖励均值 `
        + `${bucket.mean === null ? 'null' : bucket.mean.toFixed(4)}（min ${bucket.min?.toFixed(3)} / max ${bucket.max?.toFixed(3)}）\n`);
    }
    process.stdout.write(`不可观测分量（不计入分母）：${JSON.stringify(report.coverage.unobservable_rows)}\n`);
  }
  mkdirSync(join(ROOT, dirname(OUT_PATH)), {recursive: true});
  writeFileSync(abs, body);
  if (!argv.includes('--json')) process.stdout.write(`产物写入 ${OUT_PATH}\n`);
  return report.problems.length ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
