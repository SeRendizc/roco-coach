// 离线降级 / fail-closed 实测：**用产品自己的类**（`src/coach/local-model.js`），
// 不是 HTTP 网关，也不是另写一套推理栈。
//
// 为什么必须用 `LocalModel` 而不是网关：局内真正会跑的是
// `createCoachServer` → `applyLocalModel` → `wrapWithLocalModel` / `createLocalPlan`，
// 而它们拿到的 `model` 就是这个 stdio 常驻子进程句柄。网关只是同一实现的
// HTTP 外壳；只测网关等于没测「按 1200 ms 预算跑会怎样」。
//
// 四段，逐段都有**明确判据**：
//   A. preflight：权重/python 不在时的**明确失败**（不是静默）
//   B. 就绪与冷启动：第一次生成 vs 稳态（3 s 预算下第一次会不会超时）
//   C. 局内预算下的规划：`createLocalPlan({timeoutMs: 1200})` 在真实证据包上
//      的合法率 / 超时率 / 决定分布（call / stop），并与规则 planner 的决定逐条配对
//   D. 失败方向：模型不可用时 `createLocalPlan` / `wrapWithLocalModel` 必须
//      **回退到规则**、把原因记进 `lastFallback` / `lastDecision`，且**不抛**
//
// 用法：
//   node reports/roco/local-model/ab-fail-closed.mjs --adapter .models/adapters/qwen35-4b-tool-v4 \
//     --out /tmp/roco-4b/fail-closed.json

import {writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {LocalModel, createLocalPlan, wrapWithLocalModel, extractJson,
  DEFAULT_MODEL_DIR, DEFAULT_VENV_PYTHON} from '../../../src/coach/local-model.js';
import {TOOL_CONTRACTS} from '../../../src/coach/toolbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const TOOLS = ['read_state', 'search_rules', 'compare_actions', 'simulate_branch',
  'inspect_training', 'read_match', 'read_evidence', 'read_last_turn'];

/** 局内会真的发生的那一类规划任务：玩家一句具体事实问题 + 一份 receipts。 */
export const PLAN_TASKS = Object.freeze([
  {id: 'plan-read-state', message: '现在场上还剩几只？', receipts: [], expect: {tool: 'read_state'}},
  {id: 'plan-read-state-2', message: '我的宠物还剩多少血？', receipts: [], expect: {tool: 'read_state'}},
  {id: 'plan-rules-1', message: '寂灭骨龙的种族值是多少？', receipts: [], expect: {tool: 'query_rules'}},
  {id: 'plan-rules-2', message: '先手判定是按什么算的？', receipts: [], expect: {tool: 'search_rules'}},
  {id: 'plan-compare', message: '这两个技能哪个伤害更高？', receipts: [], expect: {tool: 'compare_actions'}},
  {id: 'plan-training', message: '这只宠物还能怎么培养？', receipts: [], expect: {tool: 'inspect_training'}},
  {id: 'plan-stop-chat', message: '谢谢你，刚才那局打得挺开心。', receipts: [], expect: {stop: true}},
  {id: 'plan-stop-chat-2', message: '你好呀', receipts: [], expect: {stop: true}},
  {id: 'plan-stop-chat-3', message: '我有点紧张，陪我聊两句。', receipts: [], expect: {stop: true}},
  {id: 'plan-stop-has-evidence', message: '那我该出哪一招？', receipts: [
    {tool: 'read_state', ok: true, result: {turn: 4, player: {active: 0, pets: [{name: '音速犬', hp: 41, maxHp: 60, energy: 3}]},
      enemy: {active: 0, pets: [{name: '雪影娃娃', hp: 33, maxHp: 58, energy: 1}]}}}], expect: {stop: true}},
  {id: 'plan-stop-has-evidence-2', message: '再确认一下它还剩多少血。', receipts: [
    {tool: 'read_state', ok: true, result: {turn: 4, enemy: {active: 0, pets: [{name: '雪影娃娃', hp: 33, maxHp: 58, energy: 1}]}}}],
    expect: {stop: true}},
  {id: 'plan-evidence', message: '刚才第 4 回合发生了什么？', receipts: [], expect: {tool: 'read_evidence'}},
  {id: 'plan-match', message: '整局总结一下。', receipts: [], expect: {tool: 'read_match'}},
  {id: 'plan-last-turn', message: '上一回合发生了什么？', receipts: [], expect: {tool: 'read_last_turn'}},
]);

function args(argv) {
  const out = {adapter: process.env.ROCO_LOCAL_ADAPTER || null, out: null, budget: 1200,
    modelPath: process.env.ROCO_LOCAL_MODEL_PATH || DEFAULT_MODEL_DIR,
    python: process.env.ROCO_LOCAL_PYTHON || DEFAULT_VENV_PYTHON};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--adapter') out.adapter = String(argv[++i]);
    else if (argv[i] === '--out') out.out = String(argv[++i]);
    else if (argv[i] === '--budget') out.budget = Number(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return out;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function main() {
  const options = args(process.argv.slice(2));
  const report = {generated_by: 'reports/roco/local-model/ab-fail-closed.mjs',
    budget_ms: options.budget, model_path: options.modelPath, adapter: options.adapter, sections: {}};

  // ── A. preflight：路径不对时必须**说出缺什么** ───────────────────────────────
  const broken = new LocalModel({python: '/nonexistent/python', modelPath: '/nonexistent/model'});
  const brokenPreflight = broken.preflight();
  const brokenStart = await broken.start().then(() => ({ok: true}), (error) => ({ok: false, code: error.code, message: error.message}));
  report.sections.preflight = {
    real: new LocalModel({modelPath: options.modelPath, adapter: options.adapter, python: options.python}).preflight(),
    broken_missing: brokenPreflight.missing,
    broken_start_rejected: brokenStart.ok === false && brokenStart.code === 'preflight',
    broken_start_message: brokenStart.message ?? null,
  };

  // ── B. 就绪 + 冷启动 vs 稳态 ───────────────────────────────────────────────
  const model = new LocalModel({python: options.python, modelPath: options.modelPath,
    adapter: options.adapter, timeoutMs: 3000});
  const started = Date.now();
  const health = await model.healthcheck({timeoutMs: 30000});
  const cold = {wall_ms: Date.now() - started, ...health};
  const warm = await model.healthcheck({timeoutMs: 30000});
  report.sections.readiness = {
    cold: {ok: cold.ok, wall_ms: cold.wall_ms, first_token_ms: cold.first_token_ms ?? null,
      total_ms: cold.total_ms ?? null, peak_memory_gb: cold.peak_memory_gb ?? null,
      error_code: cold.error_code ?? null, text: cold.text ?? null},
    warm: {ok: warm.ok, wall_ms: warm.wall_ms, first_token_ms: warm.first_token_ms ?? null,
      total_ms: warm.total_ms ?? null, tokens_per_second: warm.tokens_per_second ?? null,
      peak_memory_gb: warm.peak_memory_gb ?? null, text: warm.text ?? null},
    // 3 s 预算下的**冷启动会不会超时**：这是「网关一启动就进请求路径」的真实风险。
    cold_within_3s: cold.wall_ms <= 3000,
  };

  // ── C. 局内预算（默认 1200 ms）下的规划 ────────────────────────────────────
  //
  // `plannerRaw` 抓的是 `createLocalPlan` **自己那次**调用的回执：用它自己的 system 与
  // prompt 形状。之前这里额外自己拼了一份 prompt 去问一遍，测出来的原文与 planner 实际
  // 看到的那次不是同一次请求 —— 那种「测 A 报 B」正是本仓库反复踩过的形状。
  const plannerRaw = {ok: null, text: null, total_ms: null, error_code: null};
  const recordingModel = {
    generate: async (request) => {
      try {
        const result = await model.generate(request);
        plannerRaw.ok = true;
        plannerRaw.text = result.text;
        plannerRaw.total_ms = result.total_ms;
        plannerRaw.error_code = null;
        return result;
      } catch (error) {
        plannerRaw.ok = false;
        plannerRaw.text = null;
        plannerRaw.total_ms = null;
        plannerRaw.error_code = error.code || 'unknown';
        throw error;
      }
    },
  };
  const plan = createLocalPlan({model: recordingModel, tools: TOOLS, timeoutMs: options.budget});
  const planRows = [];
  for (const task of PLAN_TASKS) {
    plannerRaw.ok = null; plannerRaw.text = null; plannerRaw.total_ms = null; plannerRaw.error_code = null;
    const planned = await plan.plan({message: task.message, receipts: task.receipts, tools: TOOLS, remaining: 2});
    const last = plan.lastDecision;
    const choseStop = planned?.stop === true;
    // 「选对」的判据在跑之前就写在这里：期待工具名 / 期待 stop。
    let correct = null;
    if (task.expect.stop) correct = choseStop === true;
    else if (task.expect.tool) correct = planned?.tool === task.expect.tool;
    planRows.push({id: task.id, message: task.message, expect: task.expect,
      decision: planned, last_decision: last,
      // 局内那一句的**真实**回执（走 createLocalPlan 自己的 system + prompt）。
      planner_ok: plannerRaw.ok, planner_total_ms: plannerRaw.total_ms ?? null,
      planner_error_code: plannerRaw.error_code ?? null,
      planner_parseable: plannerRaw.text === null ? null : Boolean(extractJson(plannerRaw.text)),
      planner_raw: typeof plannerRaw.text === 'string' ? plannerRaw.text.slice(0, 200) : null,
      correct});
    process.stderr.write(`[fail-closed] ${task.id} ${JSON.stringify(planned)} ${plannerRaw.ok ? `${plannerRaw.total_ms}ms` : plannerRaw.error_code}\n`);
  }
  const okRows = planRows.filter((row) => row.planner_ok === true);
  report.sections.plan_budget = {
    tasks: planRows.length, generate_ok: okRows.length,
    timeouts: planRows.filter((row) => row.planner_error_code === 'timeout').length,
    parseable: planRows.filter((row) => row.planner_parseable === true).length,
    illegal_first_json: planRows.filter((row) => row.planner_ok === true && row.planner_parseable === false).length,
    chose_stop: planRows.filter((row) => row.decision?.stop === true).length,
    chose_tool: planRows.filter((row) => typeof row.decision?.tool === 'string').length,
    tool_name_valid: planRows.filter((row) => typeof row.decision?.tool === 'string'
      && Object.hasOwn(TOOL_CONTRACTS, row.decision.tool)).length,
    correct: planRows.filter((row) => row.correct === true).length,
    correct_denominator: planRows.filter((row) => row.correct !== null).length,
    latency_total_ms: {p50: percentile(okRows.map((r) => r.planner_total_ms), 50),
      p95: percentile(okRows.map((r) => r.planner_total_ms), 95),
      max: Math.max(0, ...okRows.map((r) => Number(r.planner_total_ms) || 0))},
    rows: planRows,
  };

  // ── D. 失败方向：不可用时必须回退、记账、不抛 ─────────────────────────────────
  const dead = new LocalModel({python: '/nonexistent/python', modelPath: '/nonexistent/model'});
  const deadPlan = createLocalPlan({model: dead, tools: TOOLS, timeoutMs: options.budget});
  const deadDecision = await deadPlan.plan({message: '现在场上还剩几只？', receipts: [], tools: TOOLS});
  let wrappedFallbackUsed = null;
  let wrappedThrew = false;
  const wrapState = {calls: 0};
  try {
    const wrapped = wrapWithLocalModel({name: 'base', async generate() { wrapState.calls += 1; return '（规则兜底正文）'; }},
      {model: dead, mode: 'on'});
    const text = await wrapped.generate({text: '规则模板正文'});
    wrappedFallbackUsed = {text, lastFallback: wrapped.lastFallback, stats: wrapped.stats, base_calls: wrapState.calls};
  } catch (error) {
    wrappedThrew = true;
    wrappedFallbackUsed = {error: String(error?.message || error)};
  }
  const emptyPacket = await (async () => {
    const wrapped = wrapWithLocalModel({name: 'base', async generate() { return '（规则兜底正文）'; }},
      {model: dead, mode: 'on'});
    return {text: await wrapped.generate({text: '   '}), lastFallback: wrapped.lastFallback};
  })();
  report.sections.fail_closed = {
    dead_plan_decision: deadDecision,
    dead_plan_reason: deadPlan.lastDecision,
    wrap_used_fallback: wrappedFallbackUsed?.text === '（规则兜底正文）',
    wrap_last_fallback_code: wrappedFallbackUsed?.lastFallback?.code ?? null,
    wrap_threw: wrappedThrew,
    wrap_stats: wrappedFallbackUsed?.stats ?? null,
    empty_packet_used_fallback: emptyPacket.text === '（规则兜底正文）',
    empty_packet_code: emptyPacket.lastFallback?.code ?? null,
  };

  await model.stop();
  const out = options.out || join('/tmp', 'roco-4b', 'fail-closed.json');
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  const {rows, ...planSummary} = report.sections.plan_budget;
  process.stdout.write(`${JSON.stringify({...report.sections, plan_budget: planSummary}, null, 1)}\n`);
  process.stdout.write(`written_to=${out}\n`);
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  main().catch((error) => { process.stderr.write(`[fail-closed] 失败：${error?.stack || error}\n`); process.exit(1); });
}
