// 4B 首版「工具路由 + 依据结果短解释」任务判分器（**可执行**，不是纸面）。
//
// 只读产品代码与冻结任务集；产物只写 training/prep-2026-09-29/。
//
// 用法：
//   node training/prep-2026-09-29/tool-tasks.mjs --selftest
//     → 用两个桩模型（oracle 按题目给答案 / adversary 故意答错）证明**判分器能分开对错**。
//       这是本文件的核心：一个判不红的判分器等于没有。
//   node training/prep-2026-09-29/tool-tasks.mjs --endpoint http://127.0.0.1:PORT [--limit N]
//     → 把同一批冻结任务打到**用户自己起的**模型服务（OpenAI 兼容 /v1/chat/completions），
//       用**运行时同一份 system**（createLocalPlan 实际发出的那条）与同一份判据打分。
//       ⚠ 本脚本自己不训练、不下载、不起服务；endpoint 必须由用户提供。
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'tool-tasks-report.json');

const {TOOL_CONTRACTS, LOCAL_PLAN_TOOLS, validToolArgs} = await import(join(ROOT, 'src/coach/toolbox.js'));
const {createLocalPlan} = await import(join(ROOT, 'src/coach/local-model.js'));

// ── 运行时真实发出去的那条 system（与 audit-prep.mjs 同一手法：接住 model.generate）──
let runtimeSystem = null;
{
  const stub = {async generate({system}) { runtimeSystem = system; return {text: '{"stop":true}'}; }};
  const plan = createLocalPlan({model: stub, tools: [...LOCAL_PLAN_TOOLS]});
  await plan.plan({message: '探测', receipts: []});
}

/** 每个工具的**合法示例参数**（产品 validToolArgs 必须放行；selftest 的 oracle 用它）。 */
const EXAMPLE_ARGS = {
  read_state: {}, compare_actions: {}, read_last_turn: {},
  search_rules: {query: '水系 克制'},
  read_match: {offset: 0, limit: 3},
  read_evidence: {turn: 1},
  query_rules: {kind: 'pet', pet_id: 'pet_000225', state_version: 7},
  evaluate_team: {team: ['pet_000118', 'pet_000137', 'pet_000143'], state_version: 7},
  compare_team_change: {team_before: ['pet_000118', 'pet_000137', 'pet_000143'],
    team_after: ['pet_000118', 'pet_000137', 'pet_000225'], state_version: 7},
  plan_actions: {state: {turn: 1}, state_version: 7},
  summarize_battle: {record: {turn: 1}, state_version: 7},
  // ⚠ 实测：`candidates` 必须是**数组**（1..3 条短文本），`unresolved` 也是数组；
  // 而 actionIndex/opponentIndex 是**互斥的旧参数**（给了它们就不许再给 candidates，见 toolbox.js:387）
  simulate_branch: {candidates: ['skill:guard']},
};

/** 按「键名」补值的默认表（用于检验冻结题里 `args_keys` 这种口径要求能不能被满足）。 */
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
const exampleOk = Object.fromEntries(Object.entries(EXAMPLE_ARGS)
  .map(([k, v]) => [k, validToolArgs(k, v)]));

// ── 冻结任务集 ────────────────────────────────────────────────────────────────
const readJsonl = (p) => readFileSync(join(ROOT, p), 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const loadTasks = () => {
  const tasks = [];
  // ① tests/evals/agent-tasks-v2-tool-coverage.jsonl：9 个工具 × 正负各一（18 条，held_out）
  for (const r of readJsonl('tests/evals/agent-tasks-v2-tool-coverage.jsonl')) {
    if (r.record_type === 'agent_task_set_header') continue;
    tasks.push({id: r.case_id, source: 'agent-tasks-v2-tool-coverage.jsonl', category: r.category ?? 'tool_coverage',
      tool: r.tool, message: r.message, hints: r.hints ?? null, receipts: r.receipts ?? null,
      expect: r.expect ?? {}, why: r.why ?? null, split: r.split ?? null,
      kind: r.expect?.must_not_call ? 'negative' : 'positive'});
  }
  // ② tests/evals/agent-tasks-v3-difficulty/*.jsonl：4 类 × 32（128 条）
  for (const name of ['multi-turn', 'conflicting-receipts', 'long-context', 'vague-reference']) {
    const p = `tests/evals/agent-tasks-v3-difficulty/${name}.jsonl`;
    if (!existsSync(join(ROOT, p))) continue;
    for (const r of readJsonl(p)) {
      tasks.push({id: r.case_id ?? `${name}-${tasks.length}`, source: `agent-tasks-v3-difficulty/${name}.jsonl`,
        category: name, tool: (r.expect?.tools ?? [])[0] ?? null, message: r.message,
        hints: r.hints ?? null, receipts: r.receipts ?? null, expect: r.expect ?? {},
        why: r.why ?? null, kind: (r.expect?.tools ?? []).length ? 'positive' : 'negative'});
    }
  }
  return tasks;
};

/** 判分：**产品自己的 validToolArgs** 是唯一参数校验口径（与运行时同源）。 */
function judge(task, decision, {calls = 1} = {}) {
  const bad = [];
  const shape = decision && typeof decision === 'object' && !Array.isArray(decision) ? decision : null;
  if (!shape) return ['输出不是 JSON 对象（不可解析）'];
  const isStop = shape.stop === true;
  const expectTools = task.expect.tools ?? (task.expect.tool ? [task.expect.tool] : []);
  const mustNot = task.expect.must_not_call ?? null;
  const maxCalls = task.expect.max_tool_calls ?? null;
  const callsRange = Array.isArray(task.expect.calls) ? task.expect.calls : null;
  if (isStop && Object.keys(shape).length !== 1) bad.push('{"stop":true} 里混了别的键');
  if (!isStop) {
    if (typeof shape.tool !== 'string' || !shape.tool) bad.push('既没有 stop 也没有 tool');
    else {
      if (!Object.hasOwn(TOOL_CONTRACTS, shape.tool)) bad.push(`工具不在契约里：${shape.tool}`);
      else if (!validToolArgs(shape.tool, shape.args ?? {})) bad.push(`参数过不了产品的 validToolArgs：${JSON.stringify(shape.args ?? {})}`);
      const keys = Object.keys(shape.args ?? {});
      const allowed = Object.keys(TOOL_CONTRACTS[shape.tool]?.arguments ?? {});
      const extra = keys.filter((k) => !allowed.includes(k));
      if (extra.length) bad.push(`参数里有契约没有的键：${extra.join(',')}`);
      if (Array.isArray(task.expect.args_keys)) {
        const missing = task.expect.args_keys.filter((k) => !keys.includes(k));
        if (missing.length) bad.push(`缺期望参数：${missing.join(',')}`);
      }
      if (task.expect.tool && shape.tool !== task.expect.tool) bad.push(`期望工具 ${task.expect.tool}，实际 ${shape.tool}`);
      if (expectTools.length && !expectTools.includes(shape.tool)) bad.push(`工具不在可接受集 [${expectTools.join(',')}]`);
      if (mustNot && shape.tool === mustNot) bad.push(`不该调的工具被调了：${mustNot}`);
    }
  }
  if (maxCalls !== null && calls > maxCalls) bad.push(`调用次数 ${calls} > max_tool_calls ${maxCalls}`);
  if (callsRange) {
    if (calls < callsRange[0] || calls > callsRange[1]) bad.push(`调用次数 ${calls} 不在闭区间 [${callsRange}]`);
    const stopOk = callsRange[0] === 0;
    if (task.expect.stop_ok !== undefined && task.expect.stop_ok !== stopOk) bad.push('expect.stop_ok 与 calls 区间自相矛盾（数据问题，不是模型问题）');
    if (isStop && !stopOk) bad.push('这一条不允许停（calls 下界 > 0）');
  }
  if (task.kind === 'negative' && !isStop) bad.push('反向题必须停');
  return bad;
}

const summarize = (results) => {
  const byCat = {};
  for (const r of results) {
    const k = `${r.source}|${r.category}`;
    byCat[k] ??= {n: 0, pass: 0, fail: 0, examples: []};
    byCat[k].n += 1;
    if (r.problems.length === 0) byCat[k].pass += 1;
    else { byCat[k].fail += 1; if (byCat[k].examples.length < 2) byCat[k].examples.push({id: r.id, problems: r.problems}); }
  }
  return {tasks: results.length, pass: results.filter((r) => !r.problems.length).length,
    byGroup: byCat, failures: results.filter((r) => r.problems.length).slice(0, 10).map((r) => ({id: r.id, problems: r.problems}))};
};

/** 冻结题 `args_keys` 口径体检：能不能**同时**满足 validToolArgs 与「这些键都得在」？ */
function auditExpectations(list) {
  const bad = [];
  for (const t of list) {
    const keys = t.expect?.args_keys;
    if (!Array.isArray(keys) || !keys.length) continue;
    const tool = t.expect.tool ?? t.tool;
    if (!tool || !Object.hasOwn(TOOL_CONTRACTS, tool)) continue;
    const filled = Object.fromEntries(keys.filter((k) => k in DEFAULT_BY_KEY).map((k) => [k, DEFAULT_BY_KEY[k]]));
    const okFilled = validToolArgs(tool, filled);
    const minimal = EXAMPLE_ARGS[tool] ?? {};
    const okMinimal = validToolArgs(tool, minimal);
    if (!okFilled) bad.push({id: t.id, tool, demandedKeys: keys, filledAccepted: okFilled, minimalAccepted: okMinimal,
      note: '没有任何合法调用能同时满足「这些键都在」与 validToolArgs'});
  }
  return bad;
}
const tasks = loadTasks();
const expectationProblems = auditExpectations(tasks);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

if (has('--endpoint')) {
  const base = String(valueOf('--endpoint')).replace(/\/$/, '');
  const limit = Number(valueOf('--limit') ?? 0) || tasks.length;
  const results = [];
  for (const task of tasks.slice(0, limit)) {
    const user = JSON.stringify({message: task.message, receipts: task.receipts ?? [], tools: [...LOCAL_PLAN_TOOLS],
      contracts: null, remaining: null});
    let decision = null; let calls = 0; let raw = ''; let ms = null;
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: 'local', messages: [{role: 'system', content: runtimeSystem}, {role: 'user', content: user}],
          max_tokens: 160, temperature: 0})});
      const body = await res.json();
      raw = String(body?.choices?.[0]?.message?.content ?? '');
      decision = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? [raw])[0]);
      calls = decision?.stop === true ? 0 : 1;
    } catch (error) { raw = `ERROR ${error?.message ?? error}`; }
    ms = Date.now() - t0;
    results.push({id: task.id, source: task.source, category: task.category, expect: task.expect,
      raw, decision, calls, ms, problems: judge(task, decision, {calls})});
  }
  const report = {mode: 'endpoint', base, at: new Date().toISOString(),
    systemSha12: createHash('sha256').update(runtimeSystem).digest('hex').slice(0, 12),
    ...summarize(results), results};
  const file = join(HERE, `tool-tasks-endpoint-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({file, ...summarize(results)}, null, 1));
  process.exit(report.pass === report.tasks ? 0 : 1);
}

// ── selftest：oracle 必须全过、adversary 必须被抓 ───────────────────────────────
const oracle = (task) => {
  const t = task.expect.tool ?? (task.expect.tools ?? [])[0];
  if (!t || !Object.hasOwn(TOOL_CONTRACTS, t)) return {stop: true};
  const base = {...(EXAMPLE_ARGS[t] ?? {})};
  // 「按题目要求把 args_keys 补齐」——只在**产品校验器仍然放行**时才用补齐版；
  // 不满足就退回最小合法调用（那种题会被 expectationProblems 标成口径问题）。
  const keys = Array.isArray(task.expect.args_keys) ? task.expect.args_keys : [];
  const filled = {...base, ...Object.fromEntries(keys.filter((k) => k in DEFAULT_BY_KEY).map((k) => [k, DEFAULT_BY_KEY[k]]))};
  if (validToolArgs(t, filled)) return {tool: t, args: filled};
  return {tool: t, args: base};
};
const adversary = (task) => {
  // 每一条都故意踩一个不同的坑：反向题去调它、正向题调错工具、参数塞一个契约没有的键。
  if (task.kind === 'negative') {
    const t = task.expect.must_not_call ?? task.tool;
    return (t && Object.hasOwn(TOOL_CONTRACTS, t)) ? {tool: t, args: EXAMPLE_ARGS[t] ?? {}} : {tool: 'read_state', args: {bogus: 1}};
  }
  const t = task.expect.tool;
  if (t === 'search_rules') return {tool: 'search_rules', args: {}};                  // 缺必填参数
  if (t === 'query_rules') return {tool: 'query_rules', args: {kind: 'pet', state_version: 7}}; // 缺定位参数
  return {tool: 'read_state', args: {bogus: 1}};                                      // 错工具 + 非法参数
};

const badIds = new Set(expectationProblems.map((b) => b.id));
const oracleResults = tasks.map((t) => { const d = oracle(t); return {id: t.id, source: t.source, category: t.category,
  expect: t.expect, decision: d, calls: d.stop ? 0 : 1, expectationUnsatisfiable: badIds.has(t.id),
  problems: judge(t, d, {calls: d.stop ? 0 : 1})}; });
const adversaryResults = tasks.map((t) => { const d = adversary(t); return {id: t.id, source: t.source, category: t.category,
  expect: t.expect, decision: d, calls: d.stop ? 0 : 1, problems: judge(t, d, {calls: d.stop ? 0 : 1})}; });
const oracleSummary = summarize(oracleResults);
const adversarySummary = summarize(adversaryResults);
const satisfiable = {n: oracleResults.filter((r) => !r.expectationUnsatisfiable).length,
  pass: oracleResults.filter((r) => !r.expectationUnsatisfiable && !r.problems.length).length};
const report0 = {mode: 'selftest', at: new Date().toISOString(),
  systemSha12: createHash('sha256').update(runtimeSystem).digest('hex').slice(0, 12),
  systemChars: runtimeSystem.length,
  toolsInContract: Object.keys(TOOL_CONTRACTS).length,
  exampleArgsAcceptedByProductValidator: exampleOk,
  tasksBySource: tasks.reduce((m, t) => { m[t.source] = (m[t.source] ?? 0) + 1; return m; }, {}),
  oracle: oracleSummary, adversary: adversarySummary,
  expectationProblems,
  oracleExcludingUnsatisfiableExpectations: satisfiable,
  verdict: {
    oracleAllPass: oracleSummary.pass === oracleSummary.tasks,
    adversaryAllCaught: adversarySummary.pass === 0,
    satisfiableExpectationsAllPass: satisfiable.pass === satisfiable.n,
    separatorWorks: adversarySummary.pass === 0 && satisfiable.pass === satisfiable.n
      && oracleResults.filter((r) => r.expectationUnsatisfiable && r.problems.length)
        .every((r) => r.problems.every((p) => p.includes('缺期望参数'))),
  }};
writeFileSync(OUT, JSON.stringify(report0, null, 1));
console.log(JSON.stringify({out: OUT, tasks: tasks.length, tasksBySource: report0.tasksBySource,
  exampleArgsAcceptedByProductValidator: exampleOk,
  oracle: {n: oracleSummary.tasks, pass: oracleSummary.pass},
  adversary: {n: adversarySummary.tasks, pass: adversarySummary.pass, caught: adversarySummary.tasks - adversarySummary.pass},
  verdict: report0.verdict, expectationProblems,
  adversaryExamples: adversarySummary.failures.slice(0, 2)}, null, 1));
process.exit(report0.verdict.separatorWorks ? 0 : 1);
