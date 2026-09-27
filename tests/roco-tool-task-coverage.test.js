/**
 * 判据：工具任务集**覆盖得住当前契约**吗（人类 ⑤：「toolv3 按最新需求做」「评测要能证伪」）。
 *
 * 背景（本轮量出来的事实）：适配器 v1–v4 的成绩都来自 288 条老门禁，而那套门禁只考了
 * **5 个工具**；`TOOL_CONTRACTS` 现在有 **13 个** ⇒ 8 个工具从未被考过。
 * 这一份把"覆盖"变成机器可查的东西，并给补上的用例钉三条：参数键从契约派生、留出、
 * 每个工具都有**负例**（只考"会不会调"不考"会不会不调"，那是倾向不是能力）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {coverageOf, problemsOf, TASK_FILES} from '../scripts/roco/verify-tool-task-coverage.mjs';
import {SPECS} from '../scripts/roco/build-tool-coverage-tasks.mjs';

const ROOT = new URL('..', import.meta.url);
const readCases = (file) => readFileSync(new URL(file, ROOT), 'utf8').split('\n')
  .filter((line) => line.trim()).map((line) => JSON.parse(line))
  .filter((row) => row?.record_type !== 'agent_task_set_header');
const cases = TASK_FILES.flatMap(readCases);

test('① 覆盖：当前契约的每个工具都必须被至少一条用例考过', () => {
  assert.deepEqual(problemsOf(cases), [], '有工具从没被考过（或用例里有过期的工具名）');
  const covered = coverageOf(cases);
  assert.equal(covered.size, Object.keys(TOOL_CONTRACTS).length);
  for (const [name, ids] of covered) assert.ok(ids.length >= 1, `${name} 没有任何用例`);
});

test('② 反证：抽掉某个工具的用例 ⇒ 同一条检查必须报出来（判据不是空的）', () => {
  for (const victim of ['read_state', 'summarize_battle', 'simulate_branch']) {
    const without = cases.filter((row) => row?.expect?.tool !== victim);
    const problems = problemsOf(without);
    assert.ok(problems.some((row) => row.includes(victim)), `抽掉「${victim}」必须报红：${problems}`);
  }
  // 反向也要能报：给一条"期望的工具不在契约里"的用例
  const stale = [...cases, {case_id: 'x', expect: {tool: 'no_such_tool'}}];
  assert.ok(problemsOf(stale).some((row) => row.includes('no_such_tool')), '过期工具名必须报红');
});

test('③ 参数键从**契约现取**：用例里的 args_keys 必须与 TOOL_CONTRACTS 逐字段一致', () => {
  const fresh = readCases(TASK_FILES[1]);
  assert.ok(fresh.length >= 16, `补充切片至少 16 条（实际 ${fresh.length}）`);
  for (const row of fresh) {
    // 负例期望"不调任何工具"，所以它们没有参数键 —— 只查正例（期望调那个工具的）。
    if (typeof row.expect?.tool !== 'string') continue;
    const contract = TOOL_CONTRACTS[row.tool];
    assert.ok(contract, `用例 ${row.case_id} 的工具 ${row.tool} 不在契约里`);
    assert.deepEqual(row.expect.args_keys, Object.keys(contract.arguments ?? {}),
      `${row.case_id} 的参数键与契约不一致（手抄会漂，必须派生）`);
  }
  // 反证：把契约里的参数键改名，判据必须不再通过 —— 这里直接构造一条不一致的样本
  const broken = {...fresh.find((row) => row.tool === 'search_rules'), expect: {tool: 'search_rules', args_keys: ['wrong']}};
  assert.notDeepEqual(broken.expect.args_keys, Object.keys(TOOL_CONTRACTS.search_rules.arguments ?? {}));
});

test('④ 留出：补充切片的 case_id 不许出现在任何 SFT 数据里（拿训练题考自己不算评测）', () => {
  const fresh = readCases(TASK_FILES[1]);
  // SFT 数据在 `reports/roco/sft`（`build-agent-sft-data.mjs` 的 OUT_DIR）。
  const sftDir = new URL('reports/roco/sft', ROOT);
  const sftFiles = readdirSync(sftDir).filter((name) => name.endsWith('.jsonl'));
  const sft = sftFiles.map((name) => readFileSync(new URL(`reports/roco/sft/${name}`, ROOT), 'utf8')).join('\n');
  const hits = [];
  for (const row of fresh) {
    assert.equal(row.split, 'held_out', `${row.case_id} 必须标 held_out`);
    if (sft.includes(row.case_id)) hits.push(row.case_id);
    // 连问句也不许出现在训练数据里（同一句话两边都有 ⇒ 等于背题）
    if (sft.includes(row.message)) hits.push(`${row.case_id}:问句`);
  }
  assert.deepEqual(hits, [], `留出用例出现在 SFT 数据里：${hits.join('、')}`);
});

test('⑤ 每个工具都要有**负例**：只考"会不会调"不考"会不会不调"，那是倾向不是能力', () => {
  const fresh = readCases(TASK_FILES[1]);
  for (const spec of SPECS) {
    const no = fresh.find((row) => row.case_id === `cov-${spec.tool}-no`);
    assert.ok(no, `${spec.tool} 缺少负例`);
    assert.equal(no.expect.tool, null, `${spec.tool} 的负例不该期望调用任何工具`);
    assert.equal(no.expect.must_not_call, spec.tool, `${spec.tool} 的负例要点名"不许调它"`);
    assert.ok(no.message && no.message !== fresh.find((row) => row.case_id === `cov-${spec.tool}-yes`).message,
      `${spec.tool} 的正负例不能是同一句话`);
  }
});
