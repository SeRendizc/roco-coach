#!/usr/bin/env node
/**
 * 把**冻结题**接进 `scripts/roco/eval-tool-execution.mjs`（Lead 已交付的评测入口）。
 *
 * 题源与 `training/prep-2026-09-29/tool-tasks.mjs` 的 `loadTasks()` **同一批文件、同一套字段**
 * （这里只是把"模型输出"按题目期望合成出来 ⇒ 用来证明**评测链路能真的跑通**，
 *  **不是**模型成绩 ✗ —— 成绩要人类把模型输出喂进来才算）。
 *
 * 产出（同目录）：
 *   · `cases-dev.jsonl`    开发题（`agent-tasks-v3-difficulty/*`，无 held_out 标记）
 *   · `cases-frozen.jsonl` **冻结题**（v2 coverage 里 `split === 'held_out'` 的 18 条）
 *   · `cases-stop.jsonl`   负向/停止题（**本评测器不评它**：它只评"真执行工具"那六步；
 *                          停止题由 `tool-tasks.mjs` 的 `judge()` 评 —— 分开交，不混算通过率）
 *   · `cases-excluded.jsonl` **本机不评的**（`plan_actions`：实测 >12 分钟 ⇒ 不硬等，如实登记）
 *
 * ⚠ 纪律：**冻结题不许进训练集**（这两个 cases 文件只用于评测，不写进 train/valid/test）✓
 */
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

const readJsonl = (p) => readFileSync(join(ROOT, p), 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** 与 tool-tasks.mjs 的 `DEFAULT_BY_KEY` 同一张表（照抄它的键与样例值，不另发明语义）。 */
const DEFAULT_BY_KEY = {
  query: '水系 克制', turn: 3, matchId: 'm-1', offset: 0, limit: 3, candidates: ['skill:guard'],
  opponent: 'switch:turtle', unresolved: ['刚刚那手'], actionIndex: 0, opponentIndex: 0,
  kind: 'pet', pet_id: 'pet_000225', skill_id: 'skill_000744', name: '喵喵', term_id: '1015',
  type: '龙系', defender_types: ['幽系'], attack_element: '龙系', element: '龙系', resist: '龙系',
  weak: '龙系', beats: '龙系', pet_ids: ['pet_000225'], skills: ['skill_000744'], compact: false,
  ruleset: 'roco-world-s4-2026-09-10', ruleset_config_id: 'pvp-standard', mode_id: 'pvp-standard-six-pet',
  state: {turn: 1}, record: {turn: 1}, state_version: 7,
  team: ['pet_000118', 'pet_000137', 'pet_000143'],
  team_before: ['pet_000118', 'pet_000137', 'pet_000143'],
  team_after: ['pet_000118', 'pet_000137', 'pet_000225'], locked_pet: 'pet_000118',
};
/** 没有 `args_keys` 的题：按工具给**合同要求的最小参数**（键都能在 TOOL_CONTRACTS 里查到）。 */
const MINIMAL_ARGS = {
  read_state: {}, compare_actions: {}, read_last_turn: {},
  search_rules: {query: DEFAULT_BY_KEY.query},
  read_match: {offset: 0, limit: 3},
  read_evidence: {turn: DEFAULT_BY_KEY.turn},
  read_last_turn: {},
  query_rules: {kind: 'pet', pet_id: DEFAULT_BY_KEY.pet_id, state_version: DEFAULT_BY_KEY.state_version},
  evaluate_team: {team: DEFAULT_BY_KEY.team, state_version: DEFAULT_BY_KEY.state_version},
  compare_team_change: {team_before: DEFAULT_BY_KEY.team_before, team_after: DEFAULT_BY_KEY.team_after,
    state_version: DEFAULT_BY_KEY.state_version},
  plan_actions: {state: DEFAULT_BY_KEY.state, state_version: DEFAULT_BY_KEY.state_version},
  summarize_battle: {record: DEFAULT_BY_KEY.record, state_version: DEFAULT_BY_KEY.state_version},
  simulate_branch: {candidates: DEFAULT_BY_KEY.candidates},
};

// ── ① 题源（与 tool-tasks.mjs 的 loadTasks 同一批）────────────────────────────
const tasks = [];
for (const r of readJsonl('tests/evals/agent-tasks-v2-tool-coverage.jsonl')) {
  if (r.record_type === 'agent_task_set_header') continue;
  tasks.push({id: r.case_id, source: 'agent-tasks-v2-tool-coverage.jsonl', heldOut: r.split === 'held_out',
    message: r.message, expect: r.expect ?? {}});
}
for (const name of ['multi-turn', 'conflicting-receipts', 'long-context', 'vague-reference']) {
  const p = `tests/evals/agent-tasks-v3-difficulty/${name}.jsonl`;
  if (!existsSync(join(ROOT, p))) continue;
  for (const r of readJsonl(p)) {
    tasks.push({id: r.case_id ?? `${name}-${tasks.length}`, source: p, heldOut: r.split === 'held_out',
      message: r.message, expect: r.expect ?? {}});
  }
}

// ── ② 每条 → 评测器的 case 形状 ─────────────────────────────────────────────
const dev = [], frozen = [], stop = [], excluded = [];
for (const t of tasks) {
  const exp = t.expect ?? {};
  const wantTool = exp.tool ?? (Array.isArray(exp.tools) ? exp.tools[0] : null);
  const isStopCase = !wantTool || Boolean(exp.must_not_call);
  if (isStopCase) { stop.push({id: t.id, question: t.message, expect: exp, source: t.source}); continue; }
  // 参数：题目声明了 `args_keys` 就按它补（值取同一张默认表）；否则按工具给最小合法参数。
  const args = Array.isArray(exp.args_keys) && exp.args_keys.length
    ? Object.fromEntries(exp.args_keys.map((k) => [k, Object.hasOwn(DEFAULT_BY_KEY, k) ? DEFAULT_BY_KEY[k] : null]))
    : {...(MINIMAL_ARGS[wantTool] ?? {})};
  if (wantTool === 'plan_actions') {
    excluded.push({id: t.id, question: t.message, tool: wantTool, args,
      why: '实测 >12 分钟（Lead 已量过）⇒ 本机不硬等：如实登记为"未评"，不拿超时当通过/失败'});
    continue;
  }
  const row = {id: t.id, question: t.message, model_output: {tool: wantTool, args},
    _source: t.source, _expect: exp};
  (t.heldOut ? frozen : dev).push(row);
}
const writeJsonl = (name, rows) => writeFileSync(join(HERE, name), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
writeJsonl('cases-dev.jsonl', dev);
writeJsonl('cases-frozen.jsonl', frozen);
writeJsonl('cases-stop.jsonl', stop);
writeJsonl('cases-excluded.jsonl', excluded);
writeFileSync(join(HERE, 'cases-manifest.json'), JSON.stringify({
  at: new Date().toISOString(),
  counts: {dev: dev.length, frozen: frozen.length, stop: stop.length, excluded: excluded.length},
  note: '模型输出是按题目期望合成的 ⇒ 用来证明"评测链路能跑通"；**不是模型成绩**。停止题不在本评测器口径内（分开交）。',
}, null, 1));
console.log('cases-dev.jsonl', dev.length, '｜cases-frozen.jsonl', frozen.length,
  '｜cases-stop.jsonl', stop.length, '｜cases-excluded.jsonl', excluded.length);
console.log('未评（plan_actions）:', excluded.map((r) => r.id).join('、') || '无');
