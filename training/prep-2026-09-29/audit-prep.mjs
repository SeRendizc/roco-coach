// 4B 训练前准备｜实测审计（只读产品代码 + 只读数据集；产物只写 training/prep-2026-09-29/）。
// 用法：node training/prep-2026-09-29/audit-prep.mjs
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
mkdirSync(HERE, {recursive: true});
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const short = (s) => sha(s).slice(0, 12);
const rel = (p) => p.replace(ROOT + '/', '');

const {TOOL_CONTRACTS, LOCAL_PLAN_TOOLS, executeTool, validToolArgs} = await import(join(ROOT, 'src/coach/toolbox.js'));
const {createLocalPlan} = await import(join(ROOT, 'src/coach/local-model.js'));
const PP = await import(join(ROOT, 'src/coach/planner-prompt.js'));
const AT = await import(join(ROOT, 'scripts/roco/agent-trajectories.mjs'));
const {RULES_VERSION} = await import(join(ROOT, 'src/game/engine.js'));

// ── ① 运行时实际发出去的提示（不是读代码抄，是把 model.generate 接住）──────────
const captured = [];
const stubModel = {async generate({system, prompt, maxTokens, temperature, timeoutMs}) {
  captured.push({system, prompt, maxTokens, temperature, timeoutMs});
  return {text: '{"stop":true}'};
}};
const plan = createLocalPlan({model: stubModel, tools: [...LOCAL_PLAN_TOOLS]});
await plan.plan({message: '水蓝蓝的种族值是多少？', receipts: [], tools: [...LOCAL_PLAN_TOOLS]});
const runtimeCall = captured[0];
const runtimeUser = (() => { try { return JSON.parse(runtimeCall.prompt); } catch { return null; } })();

const prompts = {
  runtime_local_plan: {
    path: 'src/coach/local-model.js:382-388（createLocalPlan 内联 system）+ 393-394（user 序列化）',
    chars: runtimeCall.system.length, sha12: short(runtimeCall.system), text: runtimeCall.system,
    userKeys: runtimeUser ? Object.keys(runtimeUser) : null,
    userChars: runtimeCall.prompt.length,
    maxTokens: runtimeCall.maxTokens, temperature: runtimeCall.temperature, timeoutMs: runtimeCall.timeoutMs,
  },
  production_planner_catalog: {path: 'src/coach/planner-prompt.js productionPlannerSystem()（默认 catalog 档）',
    chars: PP.productionPlannerSystem().length, sha12: short(PP.productionPlannerSystem()),
    text: PP.productionPlannerSystem()},
  production_planner_off: {path: '同上一行，rules:"off"（已发布数字的钉子）',
    chars: PP.productionPlannerSystem({rules: 'off'}).length, sha12: short(PP.productionPlannerSystem({rules: 'off'})),
    pinnedChars: PP.PLANNER_PROMPT_CHARS, pinnedSha: PP.PLANNER_PROMPT_DIGEST, rulesMode: PP.plannerRulesMode()},
  training_agent_tool_system: {path: 'scripts/roco/agent-trajectories.mjs:802 AGENT_TOOL_SYSTEM',
    chars: AT.AGENT_TOOL_SYSTEM.length, sha12: short(AT.AGENT_TOOL_SYSTEM), text: AT.AGENT_TOOL_SYSTEM},
  training_buildLocalToolSystem: {path: 'scripts/roco/agent-trajectories.mjs:532 buildLocalToolSystem()（实验版，默认不用）',
    chars: AT.buildLocalToolSystem().length, sha12: short(AT.buildLocalToolSystem()), text: AT.buildLocalToolSystem()},
};
// 每份提示里"点名了哪些工具"
const mentions = (text) => Object.keys(TOOL_CONTRACTS).filter((n) => text.includes(n));
for (const [k, v] of Object.entries(prompts)) v.toolsMentioned = v.text ? mentions(v.text) : [];

// ── 契约指纹（与 build-sft-candidates.mjs:63 / review-candidates.mjs:136 同一算法）──
const contractVersionNow = `tools:${createHash('sha256')
  .update(JSON.stringify({contract: Object.keys(TOOL_CONTRACTS), localPlan: [...LOCAL_PLAN_TOOLS]}))
  .digest('hex').slice(0, 12)}`;

// ── ② enable_thinking / 模板：训练侧与服务侧的实际设置 ───────────────────────
const readMaybe = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const servePy = readMaybe('scripts/model/serve_mlx.py');
const alignedPy = readMaybe('scripts/model/train_v9_aligned.py');
const guideTrain = readMaybe('docs/roco/review-2026-09-28/codex-healthcheck/4b-training-guide/train_v9.sh');
const version = {
  rules_version: RULES_VERSION,
  contract_version_now: contractVersionNow,
  tools_in_contract: Object.keys(TOOL_CONTRACTS),
  local_plan_tools: [...LOCAL_PLAN_TOOLS],
  serve_enable_thinking: servePy ? (servePy.match(/[^\n]*enable_thinking[^\n]*/) || []).map((s) => s.trim()) : null,
  aligned_train_enable_thinking: alignedPy ? (alignedPy.match(/[^\n]*enable_thinking[^\n]*/) || []).map((s) => s.trim()) : null,
  guide_train_script: guideTrain ? {usesAlignedPy: /train_v9_aligned\.py/.test(guideTrain),
    passesThinking: /enable_thinking/.test(guideTrain), head: guideTrain.split('\n').slice(0, 6)} : null,
};

// ── ③ 数据集逐行审计 ──────────────────────────────────────────────────────────
const FILES = [
  ['sft-v8-train', 'reports/roco/sft-v8/train.jsonl'], ['sft-v8-valid', 'reports/roco/sft-v8/valid.jsonl'],
  ['sft-v8-test', 'reports/roco/sft-v8/test.jsonl'],
  ['sft-v8-clean-train', 'reports/roco/sft-v8-clean/train.jsonl'],
  ['sft-v8-clean-valid', 'reports/roco/sft-v8-clean/valid.jsonl'],
  ['sft-v8-clean-test', 'reports/roco/sft-v8-clean/test.jsonl'],
  ['sft-v9-cand-train', 'reports/roco/sft-v9-candidates/train.jsonl'],
  ['sft-v9-cand-valid', 'reports/roco/sft-v9-candidates/valid.jsonl'],
  ['sft-v9-cand-test', 'reports/roco/sft-v9-candidates/test.jsonl'],
  ['sft-v9-cand-contrast', 'reports/roco/sft-v9-candidates/contrast.jsonl'],
  ['sft-v9-cand-from-eval', 'reports/roco/sft-v9-candidates/from-eval-expectation.jsonl'],
  ['sft-v9-seed-train', 'reports/roco/sft-v9-seed/train.jsonl'],
  ['sft-v9-seed-valid', 'reports/roco/sft-v9-seed/valid.jsonl'],
  ['sft-v9-seed-test', 'reports/roco/sft-v9-seed/test.jsonl'],
];
const pct = (list, q) => { if (!list.length) return null; const a = [...list].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]; };
const dist = (list) => ({n: list.length, min: list.length ? Math.min(...list) : null, p50: pct(list, 0.5),
  p90: pct(list, 0.9), p99: pct(list, 0.99), max: list.length ? Math.max(...list) : null,
  mean: list.length ? Math.round(list.reduce((s, x) => s + x, 0) / list.length) : null});

const datasets = [];
for (const [label, path] of FILES) {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) { datasets.push({label, path, missing: true}); continue; }
  const lines = readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim());
  const systems = new Map(); const userKeys = new Map(); const targets = new Map(); const metas = new Map();
  const lens = {system: [], user: [], assistant: [], total: []};
  let inspectTargets = 0; let inspectAnywhere = 0; let reviewedTrue = 0; let noSystem = 0;
  const contractVersions = new Set(); const rulesets = new Set(); const groups = new Set();
  for (const line of lines) {
    let row = null; try { row = JSON.parse(line); } catch { continue; }
    const msgs = Array.isArray(row.messages) ? row.messages : [];
    const sys = msgs.find((m) => m.role === 'system');
    const usr = msgs.find((m) => m.role === 'user');
    const asst = msgs.find((m) => m.role === 'assistant');
    if (!sys) noSystem += 1; else { systems.set(short(sys.content), (systems.get(short(sys.content)) ?? 0) + 1);
      lens.system.push(String(sys.content).length); }
    if (usr) { lens.user.push(String(usr.content).length);
      try { const j = JSON.parse(usr.content); const k = Object.keys(j).sort().join(','); userKeys.set(k, (userKeys.get(k) ?? 0) + 1); }
      catch { userKeys.set('(非 JSON)', (userKeys.get('(非 JSON)') ?? 0) + 1); } }
    if (asst) {
      lens.assistant.push(String(asst.content).length);
      try { const t = JSON.parse(asst.content); const k = t.stop === true ? 'stop' : String(t.tool);
        targets.set(k, (targets.get(k) ?? 0) + 1); if (k === 'inspect_training') inspectTargets += 1; }
      catch { targets.set('(非 JSON)', (targets.get('(非 JSON)') ?? 0) + 1); }
    }
    lens.total.push(msgs.reduce((s, m) => s + String(m.content ?? '').length, 0));
    if (JSON.stringify(row).includes('inspect_training')) inspectAnywhere += 1;
    const meta = row.meta ?? null;
    if (meta) {
      if (meta.reviewed === true) reviewedTrue += 1;
      if (meta.contract_version) contractVersions.add(meta.contract_version);
      if (meta.ruleset_id) rulesets.add(meta.ruleset_id);
      if (meta.group_id) groups.add(meta.group_id);
      metas.set(Object.keys(meta).sort().join(','), (metas.get(Object.keys(meta).sort().join(',')) ?? 0) + 1);
    }
  }
  datasets.push({label, path, rows: lines.length, noSystem,
    systems: [...systems.entries()].map(([s, n]) => ({sha12: s, rows: n,
      matches: Object.entries(prompts).filter(([, p]) => p.sha12 === s).map(([k]) => k)})),
    userKeySchemas: [...userKeys.entries()].map(([k, n]) => ({keys: k, rows: n})),
    targets: Object.fromEntries([...targets.entries()].sort((a, b) => b[1] - a[1])),
    metaSchemas: [...metas.entries()].map(([k, n]) => ({keys: k, rows: n})),
    reviewedTrue, groups: groups.size, contractVersions: [...contractVersions], rulesets: [...rulesets],
    inspectTraining: {asTarget: inspectTargets, anywhereInRow: inspectAnywhere},
    chars: {system: dist(lens.system), user: dist(lens.user), assistant: dist(lens.assistant), total: dist(lens.total)},
    contractFresh: contractVersions.size === 0 ? null : [...contractVersions].every((v) => v === contractVersionNow),
  });
}

// ── ④ 冻结评测集 ──────────────────────────────────────────────────────────────
const evalSets = [];
const evalFiles = [
  ['agent-tasks-v1', 'tests/evals/agent-tasks-v1.jsonl'],
  ['agent-tasks-v2-tool-coverage', 'tests/evals/agent-tasks-v2-tool-coverage.jsonl'],
  ['agent-tasks-v3-difficulty/conflicting-receipts', 'tests/evals/agent-tasks-v3-difficulty/conflicting-receipts.jsonl'],
  ['agent-tasks-v3-difficulty/long-context', 'tests/evals/agent-tasks-v3-difficulty/long-context.jsonl'],
  ['agent-tasks-v3-difficulty/multi-turn', 'tests/evals/agent-tasks-v3-difficulty/multi-turn.jsonl'],
  ['agent-tasks-v3-difficulty/vague-reference', 'tests/evals/agent-tasks-v3-difficulty/vague-reference.jsonl'],
];
for (const [label, path] of evalFiles) {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) { evalSets.push({label, path, missing: true}); continue; }
  const lines = readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const header = rows.find((r) => String(r.record_type ?? '').includes('header')) ?? null;
  const tasks = header ? rows.filter((r) => r !== header) : rows;
  const expectKeys = new Map();
  for (const t of tasks) {
    const e = t.expect ?? t.expected ?? t.expectation ?? null;
    const k = e ? Object.keys(e).sort().join(',') : '(无 expect)';
    expectKeys.set(k, (expectKeys.get(k) ?? 0) + 1);
  }
  evalSets.push({label, path, lines: lines.length, tasks: tasks.length,
    header: header ? {set_id: header.set_id ?? null, built_by: header.built_by ?? null, ruleset_id: header.ruleset_id ?? null,
      purpose: String(header.purpose ?? '').slice(0, 160), tools: header.tools ?? null} : null,
    hasContractVersion: rows.some((r) => r.contract_version ?? r.meta?.contract_version),
    expectSchemas: [...expectKeys.entries()].map(([k, n]) => ({keys: k, rows: n})),
    sample: tasks.slice(0, 2)});
}

// v8 数据集里实际用的 system 全文（只取第一条；与当前三份提示对照，供报告逐行引用）
const v8First = JSON.parse(readFileSync(join(ROOT, 'reports/roco/sft-v8/train.jsonl'), 'utf8').split('\n')[0]);
const v8System = v8First.messages.find((m) => m.role === 'system').content;
const v8User = JSON.parse(v8First.messages.find((m) => m.role === 'user').content);
const firstDiffLine = (a, b) => {
  const A = String(a).split('\n'); const B = String(b).split('\n');
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) if (A[i] !== B[i]) return {line: i + 1, a: A[i] ?? null, b: B[i] ?? null};
  return null;
};
const promptCompare = {
  v8_system: {chars: v8System.length, sha12: short(v8System), text: v8System,
    toolsMentioned: mentions(v8System),
    diff_vs_AGENT_TOOL_SYSTEM: firstDiffLine(v8System, AT.AGENT_TOOL_SYSTEM),
    diff_vs_runtime_local_plan: firstDiffLine(v8System, runtimeCall.system)},
  v8_user_payload: {keys: Object.keys(v8User), chars: v8First.messages.find((m) => m.role === 'user').content.length,
    sample: v8User},
  runtime_user_payload: {keys: runtimeUser ? Object.keys(runtimeUser) : null, chars: runtimeCall.prompt.length},
  v9_candidates_has_system: false, v9_seed_has_system: false,
  note: 'v9 候选/种子两套**没有 system 消息**（逐行核对），训练时只能靠 tokenizer 的 chat template 兜底 ⇒ 与运行时发 system 的路径不一致。',
};

const out = {
  at: new Date().toISOString(), root: rel(ROOT), promptCompare,
  runtime: {toolCount: Object.keys(TOOL_CONTRACTS).length, localPlanToolCount: LOCAL_PLAN_TOOLS.length,
    tools: Object.fromEntries(Object.entries(TOOL_CONTRACTS).map(([k, v]) => [k, {args: Object.keys(v.arguments ?? {}),
      description: String(v.description).slice(0, 80)}])),
    validArgsSmoke: Object.fromEntries(Object.keys(TOOL_CONTRACTS).map((n) => [n, (() => {
      try { return typeof validToolArgs(n, {}); } catch (e) { return `throw:${e.message}`; } })()]))},
  prompts, version, contractVersionNow, datasets, evalSets,
};
writeFileSync(join(HERE, 'prep-audit.json'), JSON.stringify(out, null, 1));

console.log('== 运行时工具（TOOL_CONTRACTS）', out.runtime.toolCount, Object.keys(TOOL_CONTRACTS).join(','));
console.log('== 本地规划器白名单', out.runtime.localPlanToolCount, [...LOCAL_PLAN_TOOLS].join(','));
console.log('== 契约指纹 now =', contractVersionNow, '| v9 候选里 = tools:97a79a115da6');
console.log('== 提示词（chars / sha12 / 点名工具数）');
for (const [k, v] of Object.entries(prompts)) console.log(`   ${k}: ${v.chars} / ${v.sha12} / ${v.toolsMentioned.length} → ${v.toolsMentioned.join('|')}`);
console.log('== RULES_VERSION', version.rules_version, '| serve enable_thinking:', JSON.stringify(version.serve_enable_thinking),
  '| aligned train:', JSON.stringify(version.aligned_train_enable_thinking));
console.log('== 数据集');
for (const d of datasets) console.log(`   ${d.label}: rows=${d.rows} noSystem=${d.noSystem} targets=${JSON.stringify(d.targets)} ` +
  `inspect_training=${JSON.stringify(d.inspectTraining)} contractFresh=${d.contractFresh} reviewedTrue=${d.reviewedTrue}`);
console.log('== 长度（total chars p50/p90/p99/max）');
for (const d of datasets) console.log(`   ${d.label}: ${d.chars.total.p50}/${d.chars.total.p90}/${d.chars.total.p99}/${d.chars.total.max}（n=${d.chars.total.n}, mean=${d.chars.total.mean}）`);
console.log('== 冻结评测集');
for (const s of evalSets) console.log(`   ${s.label}: lines=${s.lines} tasks=${s.tasks} header=${s.header ? s.header.set_id : '(无)'} expect=${JSON.stringify(s.expectSchemas)}`);
