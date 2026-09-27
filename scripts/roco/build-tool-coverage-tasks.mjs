// 生成「工具覆盖补充切片」：给 **8 个从未被考过**的工具各配正/负用例（人类 ⑤：toolv3 按最新需求做）。
//
// 为什么要有这一份：老门禁 288 条只考了 5 个工具，而 `TOOL_CONTRACTS` 有 13 个 ——
// v1–v4 的分数里 8 个工具**从来没被考过**（`verify-tool-task-coverage.mjs` 量出来的）。
// 这里按**当前契约**补上，并且：
//   · 参数键**从 `TOOL_CONTRACTS` 现取**，不手抄（手抄一定会漂）；
//   · 每条都标 `split: 'held_out'`，且 case_id 不出现在任何 SFT 数据里（判据会查）；
//   · 每个工具**正例 + 负例**各一条：负例是"这句话**不该**调它"，
//     只考"会不会调"不考"会不会不调"，那不是能力，是倾向。
//
// 用法：node scripts/roco/build-tool-coverage-tasks.mjs
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = 'tests/evals/agent-tasks-v2-tool-coverage.jsonl';

/** 问句是**人写的**（要像玩家说话）；期望参数键**从契约取**。 */
// ⚠ 每条正例都必须带**让这个工具成为必需品**的最小上下文（上一轮量出来的教训）：
// 没有对局、没有队伍、没有回执时，「这回合给我一个出招计划」这类问句**停下是合理的**，
// 那时量到的只是"会不会主动要上下文"，不是工具选择。
export const SPECS = [
  {tool: 'read_state', yes: '现在场上是什么情况？', no: '什么是应对？', hints: {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']}, why: '对局中问场上情况 ⇒ 只有它拿得到；术语用常识就够'},
  {tool: 'search_rules', yes: '应对到底怎么算？', no: '帮我开一局', hints: {mode: 'battle', state_version: 7}, why: '规则原文不在常识里 ⇒ 要检索；开局不是查规则'},
  {tool: 'compare_actions', yes: '这回合出招还是换人，哪个更稳？', no: '我上一局输在哪？', hints: {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']}, why: '有对局+队伍 ⇒ 比较两个真实候选才有意义'},
  {tool: 'simulate_branch', yes: '要是我先手换人，对面打过来会怎样？', no: '火系克制什么属性？', hints: {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']}, why: '分支推演要有对局才推得动；相性查表归检索'},
  {tool: 'read_match', yes: '我最近打了哪几局？', no: '这回合该干嘛？', hints: {mode: 'camp', state_version: 0}, why: '对局历史不在常识里 ⇒ 要读；当前回合归军师'},
  {tool: 'read_evidence', yes: '第 3 回合到底发生了什么？', no: '给我讲讲这队的思路', hints: {mode: 'battle', state_version: 7}, receipts: [{turn: 1, note: '只带了第 1 回合的回执'}], why: '回执里没有第 3 回合 ⇒ 必须去读那一条'},
  {tool: 'read_last_turn', yes: '刚才那一手结算了吗？', no: '帮我组个队', hints: {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']}, why: '结算结果不在回执里 ⇒ 要读上一回合；组队归阵容'},
  {tool: 'plan_actions', yes: '这回合给我一个出招计划', no: '你好', hints: {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']}, why: '有对局才谈得上出招计划；寒暄不该调工具'},
  // 第 13 个工具：老门禁的表头里列过它，但**一条断言的用例都没有**（覆盖检查量出来的）。
  {tool: 'summarize_battle', yes: '这一局打完帮我总结一下', no: '这只精灵的属性是什么？', hints: {mode: 'battle', state_version: 12, team: ['pet_000118', 'pet_000137', 'pet_000143']}, receipts: [{result: 'win', turns: 11}], why: '局末总结要有这一局的结果 ⇒ 只有它给得出；单只属性归图鉴'},
];

function header() {
  return {record_type: 'agent_task_set_header', set_id: 'agent-tasks-v2-tool-coverage',
    built_by: 'scripts/roco/build-tool-coverage-tasks.mjs',
    ruleset_id: 'roco-standard-pvp',
    purpose: '给 TOOL_CONTRACTS 里**老门禁没考过**的工具补正/负用例；参数键从契约现取',
    tools: SPECS.map((row) => row.tool),
    note: '全部 split=held_out：不进任何 SFT 数据（判据查 case_id 不在训练侧出现）'};
}

function rows() {
  const out = [];
  for (const spec of SPECS) {
    const contract = TOOL_CONTRACTS[spec.tool];
    if (!contract) throw new Error(`契约里没有「${spec.tool}」—— SPECS 过期了`);
    const keys = Object.keys(contract.arguments ?? {});
    out.push({record_type: 'agent_tool_coverage_case', case_id: `cov-${spec.tool}-yes`,
      category: 'tool_coverage', tool: spec.tool, message: spec.yes,
      hints: spec.hints ?? {mode: 'battle', state_version: 0},
      receipts: spec.receipts ?? null,
      expect: {tool: spec.tool, args_keys: keys, max_tool_calls: 1}, split: 'held_out', why: spec.why});
    out.push({record_type: 'agent_tool_coverage_case', case_id: `cov-${spec.tool}-no`,
      category: 'tool_restraint', tool: spec.tool, message: spec.no,
      hints: spec.hints ?? {mode: 'battle', state_version: 0}, receipts: spec.receipts ?? null,
      expect: {tool: null, must_not_call: spec.tool, max_tool_calls: 1}, split: 'held_out', why: spec.why});
  }
  return out;
}

const all = [header(), ...rows()];
writeFileSync(join(ROOT, OUT), `${all.map((row) => JSON.stringify(row)).join('\n')}\n`);
console.log(`已生成 ${OUT}：${all.length - 1} 条（${SPECS.length} 个工具 × 正负各一）`);
