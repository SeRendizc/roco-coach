// 工具任务集的**契约覆盖**检查（人类 2026-09-26 ⑤：「toolv3 按最新需求做」）。
//
// 为什么必须有这一条：适配器成绩是在 288 条任务门禁上量的，而那套门禁只问了
// **5 个工具**（query_rules / evaluate_team / compare_team_change / plan_actions / summarize_battle）；
// 现在 `TOOL_CONTRACTS` 已经有 **13 个**工具 —— 也就是说 v1–v4 的分数里，
// **8 个工具从来没被考过**。分数不低不代表覆盖得住，这件事必须机器可查。
//
// 用法：
//   node scripts/roco/verify-tool-task-coverage.mjs            # 检查（不通过时非零退出）
//   node scripts/roco/verify-tool-task-coverage.mjs --selftest # 反证：故意抽掉一个工具必须报出来
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
/** 老门禁（288 条）与新版补充切片（本轮新增）都算覆盖来源。 */
export const TASK_FILES = ['tests/evals/agent-tasks-v1.jsonl', 'tests/evals/agent-tasks-v2-tool-coverage.jsonl'];
/** 这些工具**故意**不放进工具选择任务：它们由政策强制、不是"模型来选"。空表就是"没有例外"。 */
export const INTENTIONALLY_UNCOVERED = new Set();

function readCases(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    .filter((row) => row?.record_type !== 'agent_task_set_header');
}

/** 每个工具被哪些用例覆盖（`expect.tool` 命中的才算）。 */
export function coverageOf(cases, contracts = TOOL_CONTRACTS) {
  const covered = new Map(Object.keys(contracts).map((name) => [name, []]));
  for (const row of cases) {
    const tool = row?.expect?.tool;
    if (typeof tool === 'string' && covered.has(tool)) covered.get(tool).push(row.case_id);
  }
  return covered;
}

export function problemsOf(cases, contracts = TOOL_CONTRACTS) {
  const problems = [];
  const covered = coverageOf(cases, contracts);
  for (const [name, ids] of covered) {
    if (ids.length === 0 && !INTENTIONALLY_UNCOVERED.has(name)) {
      problems.push(`工具「${name}」一条用例都没有 ⇒ 它在适配器成绩里从未被考过`);
    }
  }
  // 反向：用例里出现了契约里没有的工具名（契约改过、用例没跟上）
  for (const row of cases) {
    const tool = row?.expect?.tool;
    if (typeof tool === 'string' && !(tool in contracts)) {
      problems.push(`用例 ${row.case_id} 期望的工具「${tool}」不在当前契约里（用例过期了）`);
    }
  }
  return problems;
}

function main() {
  const files = process.argv.includes('--selftest') ? TASK_FILES : TASK_FILES;
  const cases = files.flatMap((file) => readCases(file));
  const problems = problemsOf(cases);
  const covered = coverageOf(cases);
  console.log(`契约工具 ${Object.keys(TOOL_CONTRACTS).length} 个 · 用例 ${cases.length} 条 · 覆盖 ${[...covered.values()].filter((ids) => ids.length).length} 个`);
  for (const [name, ids] of covered) console.log(` ${ids.length ? '✔' : '✖'} ${name}：${ids.length} 条`);
  if (process.argv.includes('--selftest')) {
    // 反证：把某个工具的用例全抽走 ⇒ 同一条检查必须报出来
    const victim = 'read_state';
    const without = cases.filter((row) => row?.expect?.tool !== victim);
    const caught = problemsOf(without).some((row) => row.includes(victim));
    console.log(caught ? `✔ 反证成立：抽掉「${victim}」的用例后检查报红` : `✖ 反证失败：抽掉「${victim}」也没报 —— 检查是空的`);
    process.exit(caught ? 0 : 1);
  }
  if (problems.length) { console.log(`✖ ${problems.length} 个问题：\n - ${problems.join('\n - ')}`); process.exit(1); }
  console.log('✔ 每个契约工具都被至少一条用例考过，且用例里没有过期工具名');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
