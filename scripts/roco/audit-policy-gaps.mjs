#!/usr/bin/env node
/**
 * 政策缺口审计（只读，不调模型、不写任何产物）。
 *
 * 为什么要有这一支（2026-09-28，人类：「多琢磨下 agent/coach 功能」）：
 *   `--policy-first` 对照实测出 2 条残留，根因是**政策对某类问句没有形状** ⇒ 静默交回模型。
 *   这种"漏了不报错"的失效模式在产品里是看不见的：玩家只会拿到一句没依据的话。
 *   与其等评测事后发现，不如把「政策判断 ↔ 任务期望」逐条对账跑成一条命令。
 *
 * 它量三件事（全部对着 `tests/evals/agent-tasks-v1.jsonl`，**离线**、0 次模型调用）：
 *   ① **漏判**（gap）：任务期望要工具，政策却说 `need:null` ⇒ 会静默降级成模型自由发挥；
 *   ② **多判**（over）：任务期望不要工具，政策却说要 ⇒ 白查一次（还可能答非所问）；
 *   ③ 参数形状：政策判出 need 之后，`defaultArgsFor` 能不能凑出参数（凑不出 = 白判）。
 *
 * 用法：
 *   node scripts/roco/audit-policy-gaps.mjs            # 打印汇总 + 逐条缺口
 *   node scripts/roco/audit-policy-gaps.mjs --json     # 机器可读
 *
 * ⚠ 它是**审计**，不是判据：不进 `test:unit`、不改任何东西。要变成判据得人类先定口径
 *   （"缺口允许几条"是个产品决定，不是工程决定）。
 *
 * ⚠ 2026-09-28 实测的**已知局限（照实写）**：这份审计只喂"任务自带的阵容"，**没有**喂
 *   `context.roco_battle` / `locked_pet` 等运行期字段 ⇒ 它对**带前缀**的问句
 *   （「我锁定寂灭骨龙，…」「我队里带了画间沉铁兽，…」）会报成"漏判"，
 *   而**端到端不是漏的**（`--policy-first` 实测 288/288 通过，模型把这几条补上了）。
 *   ⇒ 这些数应当读成"**政策单独**能覆盖多少"，不是"系统漏了多少"。
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {policyFor, defaultArgsFor} from '../../src/coach/runtime.js';
import {PET_NAME_ROWS} from '../../src/coach/pet-names-data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKS = join(ROOT, 'tests/evals/agent-tasks-v1.jsonl');
const nameById = new Map(PET_NAME_ROWS.map(([name, id]) => [id, name]));

/** 任务自带的上下文（阵容/锁定）翻成政策认得的 `context`。 */
function contextOf(task) {
  const team = Array.isArray(task.context?.team) ? task.context.team : [];
  const lineup = team.map((id) => ({id, name: nameById.get(id)})).filter((row) => row.name);
  return {
    mode: task.context?.mode ?? 'camp',
    ...(lineup.length ? {profile: {lineup}} : {}),
    ...(task.context?.locked_pet ? {locked_pet: task.context.locked_pet} : {}),
  };
}

const tasks = readFileSync(TASKS, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line)).filter((row) => row.record_type === 'agent_task');

const gaps = [];
const overs = [];
const argGaps = [];
const byNeed = {};

for (const task of tasks) {
  const want = task.expect?.tool ?? null;
  const policy = policyFor(task.message, contextOf(task));
  const got = policy.need;
  byNeed[String(got)] = (byNeed[String(got)] || 0) + 1;
  if (want && !got) gaps.push({case_id: task.case_id, category: task.category, want, message: task.message});
  if (!want && got) overs.push({case_id: task.case_id, category: task.category, got, reason: policy.reason, message: task.message});
  if (got) {
    const args = defaultArgsFor(got, contextOf(task), task.message);
    const empty = args === null || (typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0);
    if (empty) argGaps.push({case_id: task.case_id, need: got, reason: policy.reason, message: task.message});
  }
}

const result = {
  tasks: tasks.length,
  policy_need_distribution: byNeed,
  gaps: gaps.length,
  overs: overs.length,
  arg_gaps: argGaps.length,
  gap_rows: gaps,
  over_rows: overs,
  arg_gap_rows: argGaps,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('=== 政策缺口审计（离线，0 次模型调用）===');
  console.log(JSON.stringify({任务数: result.tasks, 政策need分布: byNeed,
    '漏判(期望要工具但政策没意见)': gaps.length,
    '多判(期望不要工具但政策要)': overs.length,
    '判了却凑不出参数': argGaps.length}, null, 1));
  if (gaps.length) {
    console.log('\n--- 漏判逐条（这些会静默降级成模型自由发挥）---');
    for (const row of gaps) console.log(` ${row.case_id}\t${row.category}\t要 ${row.want}\t${row.message}`);
  }
  if (overs.length) {
    console.log('\n--- 多判逐条（白查一次）---');
    for (const row of overs) console.log(` ${row.case_id}\t${row.category}\t政策要 ${row.got}（${row.reason}）\t${row.message}`);
  }
  if (argGaps.length) {
    console.log('\n--- 判了却凑不出参数（政策白判）---');
    for (const row of argGaps) console.log(` ${row.case_id}\t${row.need}（${row.reason}）\t${row.message}`);
  }
}
