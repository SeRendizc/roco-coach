#!/usr/bin/env node
// 第 1—7 步的**规划器**：告诉你「现在处于第几步、上一步产物在不在、现在该敲哪条命令、
// 这一步的成功判据是什么」。
//
// 它不执行任何命令。`--dry-run` 也只是把命令**打印**出来——
// `--selftest` 会扫自己的源码来证明入口脚本连子进程都起不了、连文件都写不了。
//
// 跑法::
//
//     npm run train:plan                    # 状态表 + 当前步
//     npm run train:plan -- --dry-run       # 打印七步的完整命令清单
//     npm run train:plan -- --step lora     # 只看某一步的全部说明
//     npm run train:plan -- --json
//     npm run train:plan -- --selftest
//
// 判断「第几步做完」只认**盘上的产物**，不认「我记得跑过」。
// 产物存在但不合格时，它会说「存在但不合格」，而不是当成「还没做」——
// 这两件事的处置完全不同。

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ROOT, PATHS, STEPS, stepById, readEvalReport, frag,
  assertNotProtectedPath, assertNoAutomation, fsIo, memoryIo,
} from './lib/training-steps.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const LIB_PATH = join(ROOT, 'scripts', 'train', 'lib', 'training-steps.mjs');

const basename = (path) => String(path).split('/').filter(Boolean).pop();

// ── 每一步的「做完了吗」判据（纯函数，注入 io） ───────────────────────────

const ok = (reason) => ({done: true, problem: false, reason});
const pending = (reason) => ({done: false, problem: false, reason});
const broken = (reason) => ({done: false, problem: true, reason});

function readJsonOr(io, rel) {
  try { return {value: io.readJson(rel), error: null}; } catch (error) { return {value: null, error: String(error.message).slice(0, 120)}; }
}

/** 台账：7 步里有 5 步都要看它，所以抽出来，避免各判各的。 */
function ledgerOf(io) {
  if (!io.exists(PATHS.ledger)) return {exists: false};
  const {value, error} = readJsonOr(io, PATHS.ledger);
  return {exists: true, value: value || {}, error};
}

function probeEnv(io, ledger) {
  if (!ledger.exists) return pending(`台账 ${PATHS.ledger} 还不存在（用 train:prereqs --emit-ledger-template 生成骨架）`);
  if (ledger.error) return broken(`台账不是合法 JSON：${ledger.error}`);
  if (!ledger.value.env) return broken('台账里没有 `env` 节：第 1 步探测到的事实没有落进台账');
  return ok(`台账存在，env 节已填（unified_memory_gib=${ledger.value.env.unified_memory_gib ?? 'null'}）`);
}

function probeDownload(io, ledger) {
  if (!io.exists(PATHS.weights)) return pending(`权重目录 ${PATHS.weights} 不存在`);
  if (!io.exists(`${PATHS.weights}/config.json`)) return broken(`${PATHS.weights} 存在但没有 config.json：这是半个下载`);
  if (!ledger.exists) return pending('有权重但还没有台账：第 2 步要求把 revision/许可/sha256 记下来');
  if (ledger.error) return broken(`台账不是合法 JSON：${ledger.error}`);
  const base = ledger.value.base || {};
  if (!base.revision) return broken('台账 base.revision 为空：没有版本锚点的权重，后面无法复现');
  if (!base.license) return broken('台账 base.license 为空：许可没记，等于没用过这一步');
  return ok(`权重在盘上（config.json 存在），台账记了 revision=${base.revision}、license=${base.license}`);
}

function probeBaseline(io) {
  if (!io.exists(PATHS.baseEval)) return pending(`基座产物 ${PATHS.baseEval} 不存在`);
  const {value, error} = readJsonOr(io, PATHS.baseEval);
  if (error) return broken(`基座产物不是合法 JSON：${error}`);
  const identity = value.identity || {};
  if (identity.adapter != null) return broken(`基座产物的 identity.adapter=${identity.adapter}：它其实是某个适配器的成绩，不是基座`);
  if (!identity.model) return broken('基座产物没有 identity.model：认不出这份是谁跑出来的');
  const want = basename(PATHS.weights);
  if (!String(identity.model).includes(want)) {
    return broken(`基座产物的 identity.model=${identity.model} 不含 ${want}：这不是 27B 的基座成绩，`
      + '很可能网关还在指向 4B（ROCO_LOCAL_MODEL_PATH 没生效）');
  }
  if (!value.summary || value.summary.pass_rate == null) return broken('基座产物没有 summary.pass_rate');
  return ok(`identity.model 指向 27B、adapter 为 null；pass_rate=${value.summary.pass_rate}`);
}

function probeData(io) {
  const report = `${PATHS.dataset}/dataset-report.json`;
  const sides = ['train.jsonl', 'valid.jsonl', 'test.jsonl'].map((name) => `${PATHS.dataset}/${name}`);
  const missing = sides.filter((rel) => !io.exists(rel));
  if (!io.exists(report) && missing.length === sides.length) return pending(`数据集目录 ${PATHS.dataset} 还没有产物`);
  if (!io.exists(report)) return broken(`有 jsonl 但没有 ${report}：数据是怎么切的没有任何记录`);
  if (missing.length) return broken(`缺 ${missing.join('、')}：生成器跑一半就中断了`);
  const {value, error} = readJsonOr(io, report);
  if (error) return broken(`dataset-report.json 不是合法 JSON：${error}`);
  const invariants = value.invariants || {};
  const bad = Object.entries(invariants).filter(([key, val]) => key !== 'thin_mechanisms_in_train' && val !== true);
  if (bad.length) return broken(`dataset-report.json 的不变量不成立：${bad.map(([k]) => k).join('、')}`);
  return ok(`三份 jsonl 都在，不变量三项全 true；worlds_per_task=${value.worlds_per_task}、split_mode=${value.split_mode}`);
}

function probeLora(io) {
  if (!io.exists(PATHS.adapter)) return pending(`适配器目录 ${PATHS.adapter} 不存在`);
  const config = `${PATHS.adapter}/adapter_config.json`;
  const weights = `${PATHS.adapter}/adapters.safetensors`;
  if (!io.exists(config)) return broken(`${PATHS.adapter} 存在但没有 adapter_config.json：认不出用了什么配置`);
  if (!io.exists(weights)) return broken(`${PATHS.adapter} 存在但没有 adapters.safetensors：没有权重`);
  const {value, error} = readJsonOr(io, config);
  if (error) return broken(`adapter_config.json 不是合法 JSON：${error}`);
  if (!String(value.model || '').includes(basename(PATHS.weights))) {
    return broken(`adapter_config.model=${value.model} 不含 ${basename(PATHS.weights)}：这个适配器不是训在 27B 上的`);
  }
  if (!String(value.data || '').includes(PATHS.dataset)) {
    return broken(`adapter_config.data=${value.data} 不是 ${PATHS.dataset}：数据来源对不上`);
  }
  return ok(`适配器存在，model 指向 27B、data 指向 ${PATHS.dataset}；iters=${value.iters ?? '未记'}`);
}

function probeEval(io) {
  if (!io.exists(PATHS.sftEval)) return pending(`评测产物 ${PATHS.sftEval} 不存在`);
  const {value, error} = readJsonOr(io, PATHS.sftEval);
  if (error) return broken(`评测产物不是合法 JSON：${error}`);
  const identity = value.identity || {};
  if (!identity.adapter) return broken('评测产物的 identity.adapter 为 null：网关没加载到适配器，这份等于在量基座');
  if (identity.adapter_basename !== basename(PATHS.adapter)) {
    return broken(`identity.adapter_basename=${identity.adapter_basename}，文件名与目录名要求 ${basename(PATHS.adapter)}：`
      + '这正是第 37 轮「存档错位」那类事故');
  }
  const read = readEvalReport(value);
  const four = {
    pass_rate: read.pass_rate, invalid_arguments: read.invalid_arguments,
    p50_ms: read.p50_ms, p95_ms: read.p95_ms,
  };
  const missing = Object.entries(four).filter(([, val]) => val == null).map(([key]) => key);
  if (missing.length) return broken(`评测产物缺这四项里的：${missing.join('、')}`);
  if (!read.pairing) return broken('评测产物没有 comparison：没有逐任务配对，通过率不能用来支持「变好了」');
  return ok(`四项齐全：pass_rate=${four.pass_rate}、非法参数=${four.invalid_arguments}、`
    + `p50=${four.p50_ms}ms、p95=${four.p95_ms}ms；配对 against=${read.pairing.against}`);
}

function probeRecord(io, ledger) {
  if (!ledger.exists) return pending('还没有台账');
  if (ledger.error) return broken(`台账不是合法 JSON：${ledger.error}`);
  if (!io.exists(PATHS.sftEval)) return pending(`第 6 步的评测产物 ${PATHS.sftEval} 还不存在，台账最后一段无从核对`);
  const value = ledger.value;
  // 判据只有一条：**已经声称记录完毕**的台账，字段必须真的齐。
  // 还没标 recorded 的台账是「第 7 步还没做」，不是「产物坏了」——两者处置不同，
  // 混成一个「不合格」会让刚开始的人天天看到假警报，久了就没人看这个字段了。
  if (value.status !== 'recorded') return pending(`台账还没标 status=recorded（当前 ${value.status ?? 'null'}）`);
  const missing = ['repo_id', 'revision', 'license'].filter((key) => !(value.base || {})[key]);
  if (missing.length) return broken(`台账标了 recorded 但 base 缺 ${missing.join('、')}`);
  if (!value.lora?.smoke_peak_mem_gb) return broken('台账标了 recorded 但没有 lora.smoke_peak_mem_gb：显存/内存峰值没有实测记录');
  const four = ['pass_rate', 'invalid_arguments', 'p50_ms', 'p95_ms'].filter((key) => value.eval?.[key] == null);
  if (four.length) return broken(`台账标了 recorded 但 eval 缺 ${four.join('、')}`);
  if (value.eval?.paired_vs_4b_v4?.regressed == null || value.eval?.paired_vs_4b_v4?.fixed == null) {
    return broken('台账标了 recorded 但缺与 4B v4 的配对差异（paired_vs_4b_v4.regressed / .fixed）');
  }
  return ok('台账字段齐全且 status=recorded');
}

const PROBES = {
  env: probeEnv, download: probeDownload, baseline: probeBaseline,
  data: probeData, lora: probeLora, eval: probeEval, record: probeRecord,
};

/**
 * 按盘上产物判断每一步做完了没有。
 * @returns `{current_step, steps, all_done, suspicious}`
 */
export function planSteps(io) {
  const ledger = ledgerOf(io);
  const steps = STEPS.map((step) => {
    let verdict;
    try {
      verdict = PROBES[step.id](io, ledger);
    } catch (error) {
      verdict = broken(`判据抛错：${String(error.message).slice(0, 120)}`);
    }
    return {id: step.id, index: step.index, title: step.title, ...verdict};
  });
  const firstOpen = steps.find((step) => !step.done) || null;
  return {
    steps,
    current_step: firstOpen,
    all_done: firstOpen === null,
    // 「产物在但不合格」和「还没做」必须分开报：前者要修，后者要跑。
    suspicious: steps.filter((step) => step.problem).map((step) => step.id),
  };
}

/** 目标路径的守卫：规划器也要挡「把 27B 写到 4B 目录里去」。 */
export function assertTargetsSafe(targets = {adapter: PATHS.adapter, dataset: PATHS.dataset, weights: PATHS.weights}) {
  for (const [kind, target] of Object.entries(targets)) assertNotProtectedPath(target);
  return true;
}

// ── 输出 ─────────────────────────────────────────────────────────────────

export function formatStatus(io) {
  const plan = planSteps(io);
  const lines = [];
  lines.push('27B 亲训路线图 · 当前进度（只读盘，不执行任何命令）');
  lines.push('='.repeat(72));
  lines.push('  步骤                                  状态              判据');
  lines.push('-'.repeat(72));
  for (const step of plan.steps) {
    const mark = step.done ? '✔ 已完成' : step.problem ? '✖ 存在但不合格' : '· 未开始';
    lines.push(`  ${step.index}. ${step.title} —— ${mark}`);
    lines.push(`     ${step.reason}`);
  }
  lines.push('');
  if (plan.all_done) {
    lines.push('七步全部完成。回滚路径见 `npm run train:plan -- --step record`。');
  } else {
    const step = stepById(plan.current_step.id);
    lines.push(`当前该做：第 ${step.index} 步 ·${step.title}${plan.current_step.problem ? '（注意：这一步的产物已经在盘上，但不合格，先修）' : ''}`);
    lines.push(`  目的：${step.purpose}`);
    lines.push('  该敲的命令：');
    for (const command of step.commands) lines.push(`    # ${command.label}\n    ${command.cmd}`);
    lines.push('  成功的样子：');
    for (const item of step.success) lines.push(`    · ${item}`);
    lines.push(`  产物落在哪：${step.artifacts.dir} → ${step.artifacts.files.join('、')}`);
    lines.push('');
    lines.push('（失败怎么办、回滚怎么做：`npm run train:plan -- --step ' + step.id + '`）');
  }
  if (plan.suspicious.length) {
    lines.push('');
    lines.push(`⚠ 有 ${plan.suspicious.length} 步是「产物存在但不合格」：${plan.suspicious.join('、')}。`
      + '不合格比缺失更危险——它对下一个脚本看起来像是做过了。');
  }
  return `${lines.join('\n')}\n`;
}

export function formatStep(id) {
  const step = stepById(id);
  if (!step) {
    return `未知步骤 id：${id}。可选：${STEPS.map((s) => s.id).join(' / ')}\n`;
  }
  const lines = [];
  lines.push(`第 ${step.index} 步 ·${step.title}`);
  lines.push('='.repeat(72));
  lines.push(`【目的】${step.purpose}`);
  lines.push('');
  lines.push('【前置检查】');
  for (const item of step.precheck) lines.push(`  · ${item}`);
  lines.push('');
  lines.push('【用户要敲的命令】');
  for (const command of step.commands) lines.push(`  # ${command.label}\n  ${command.cmd}`);
  lines.push('');
  lines.push('【成功的样子】');
  for (const item of step.success) lines.push(`  ✔ ${item}`);
  lines.push('');
  lines.push('【失败怎么办】');
  for (const item of step.on_failure) lines.push(`  ✖ ${item.symptom}\n    → ${item.action}`);
  lines.push('');
  lines.push(`【产物落在哪】${step.artifacts.dir} → ${step.artifacts.files.join('、')}`);
  lines.push(`【回滚】${step.rollback}`);
  return `${lines.join('\n')}\n`;
}

export function formatDryRun() {
  const lines = [];
  lines.push('# 27B 亲训 · 七步命令清单（--dry-run：**只打印，不执行**）');
  lines.push('# 每一步都由你亲手敲。本脚本没有执行路径——自检会扫源码证明这一点。');
  for (const step of STEPS) {
    lines.push('');
    lines.push(`# ── 第 ${step.index} 步 ·${step.title} ──`);
    lines.push(`# 目的：${step.purpose}`);
    for (const command of step.commands) lines.push(`${command.cmd}    # ${command.label}`);
    lines.push(`# 成功判据：${step.success.join('；')}`);
  }
  return `${lines.join('\n')}\n`;
}

// ── 自检 ─────────────────────────────────────────────────────────────────

const WEIGHTS_OK = {
  [`${PATHS.weights}/config.json`]: {model_type: 'qwen3'},
  [`${PATHS.weights}/model-00001-of-00002.safetensors`]: 'x',
};
const LEDGER_MIN = {
  schema: 'roco-27b-training-ledger/1',
  env: {unified_memory_gib: 48},
  base: {repo_id: 'mlx-community/Qwen3.8-27B-4bit', revision: 'deadbeef', license: 'apache-2.0'},
  lora: {smoke_peak_mem_gb: 30},
  eval: {pass_rate: 0.9, invalid_arguments: 0, p50_ms: 400, p95_ms: 900, paired_vs_4b_v4: {regressed: 2, fixed: 5}},
  status: 'recorded',
};
const BASE_EVAL = {
  identity: {model: `${ROOT}/${PATHS.weights}`, adapter: null, adapter_basename: null},
  summary: {tasks: 288, passed: 250, pass_rate: 0.8681, latency: {p50_ms: 900, p95_ms: 1800}},
};
const DATASET_OK = {
  [`${PATHS.dataset}/train.jsonl`]: '{"messages":[]}',
  [`${PATHS.dataset}/valid.jsonl`]: '{"messages":[]}',
  [`${PATHS.dataset}/test.jsonl`]: '{"messages":[]}',
  [`${PATHS.dataset}/dataset-report.json`]: {
    worlds_per_task: 9, split_mode: 'strict',
    invariants: {every_family_in_train: true, no_designed_holdout_in_train: true,
      every_taught_mechanism_has_two_train_rows: true, thin_mechanisms_in_train: []},
  },
};
const ADAPTER_OK = {
  [`${PATHS.adapter}/adapter_config.json`]: {model: PATHS.weights, data: PATHS.dataset, iters: 900},
  [`${PATHS.adapter}/adapters.safetensors`]: 'x',
};
const SFT_EVAL = {
  identity: {model: `${ROOT}/${PATHS.weights}`, adapter: `${ROOT}/${PATHS.adapter}`,
    adapter_basename: basename(PATHS.adapter)},
  summary: {tasks: 288, passed: 260, pass_rate: 0.9028, latency: {p50_ms: 1200, p95_ms: 2600}},
  rows: [{violations: []}, {violations: ['query_rules 的参数里没有同时满足 {"kind":"pet"} 的一次调用']}],
  comparison: {against: PATHS.fourBv4Eval, regressed: 2, fixed: 5, both_failed: 1},
};

function mem(files) { return memoryIo(files); }

export function selftest() {
  const results = [];
  const push = (name, passed, why = '') => results.push({name, passed, why});

  const stage = (label, files, expectCurrent, expectProblemIds = []) => {
    const plan = planSteps(mem(files));
    const actual = plan.current_step ? plan.current_step.id : null;
    const okCurrent = actual === expectCurrent;
    const okProblems = expectProblemIds.every((id) => plan.steps.find((s) => s.id === id)?.problem === true)
      && plan.steps.filter((s) => s.problem).length === expectProblemIds.length;
    push(label, okCurrent && okProblems,
      okCurrent && okProblems ? ''
        : `期望 current=${expectCurrent}、不合格步=${expectProblemIds.join(',') || '无'}；`
          + `实际 current=${actual}、不合格步=${plan.suspicious.join(',') || '无'}`);
    return plan;
  };

  // 正向推进：每一步的产物补齐，当前步就往前走一格。
  stage('主线 ①：空仓库 → 当前是第 1 步 env', {}, 'env');
  stage('主线 ②：只有台账 → 当前是第 2 步 download', {[PATHS.ledger]: {...LEDGER_MIN, base: {}}}, 'download');
  stage('主线 ③：台账 + 权重 → 当前是第 3 步 baseline', {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK}, 'baseline');
  stage('主线 ④：+ 基座产物 → 当前是第 4 步 data', {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL}, 'data');
  stage('主线 ⑤：+ 数据集 → 当前是第 5 步 lora',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK}, 'lora');
  stage('主线 ⑥：+ 适配器 → 当前是第 6 步 eval',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK, ...ADAPTER_OK}, 'eval');
  stage('主线 ⑦：+ 评测产物（台账还没标 recorded）→ 当前是第 7 步 record',
    {[PATHS.ledger]: {...LEDGER_MIN, status: 'in-progress'}, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL,
      ...DATASET_OK, ...ADAPTER_OK, [PATHS.sftEval]: SFT_EVAL}, 'record');
  {
    const plan = planSteps(mem({[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL,
      ...DATASET_OK, ...ADAPTER_OK, [PATHS.sftEval]: SFT_EVAL}));
    const passed = plan.all_done && plan.suspicious.length === 0;
    push('主线 ⑧：七步齐全 → all_done 且没有任何「存在但不合格」', passed,
      passed ? '' : (plan.suspicious.length ? `仍有不合格步：${plan.suspicious.join(',')}` : `当前步仍是 ${plan.current_step?.id}`));
  }

  // 必红反证：产物「看起来在」但拿去做判据会得出错误结论的情形。
  stage('反证 ①：不变量声称全 true 但 train.jsonl 缺失 → data 判「存在但不合格」（不许算做完）',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK,
      [`${PATHS.dataset}/train.jsonl`]: undefined},
    'data', ['data']);
  stage('反证 ②：基座产物的 identity.model 指向 4B → baseline 判不合格（不许算做完）',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK,
      [PATHS.baseEval]: {identity: {model: `${ROOT}/.models/mlx/Qwen3.5-4B-4bit`, adapter: null},
        summary: {tasks: 288, passed: 225, pass_rate: 0.7813}}},
    'baseline', ['baseline']);
  stage('反证 ③：基座产物里带着 adapter → baseline 判不合格',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK,
      [PATHS.baseEval]: {identity: {model: `${ROOT}/${PATHS.weights}`, adapter: `${ROOT}/${PATHS.fourBv4Adapter}`},
        summary: {pass_rate: 0.9}}},
    'baseline', ['baseline']);
  stage('反证 ④：适配器 config 的 model 指向 4B 权重 → lora 判不合格',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK,
      [`${PATHS.adapter}/adapter_config.json`]: {model: '.models/mlx/Qwen3.5-4B-4bit', data: PATHS.dataset},
      [`${PATHS.adapter}/adapters.safetensors`]: 'x'},
    'lora', ['lora']);
  stage('反证 ⑤：评测产物 identity.adapter 为 null（其实在量基座）→ eval 判不合格',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK, ...ADAPTER_OK,
      [PATHS.sftEval]: {identity: {model: `${ROOT}/${PATHS.weights}`, adapter: null},
        summary: {pass_rate: 0.9, latency: {p50_ms: 1, p95_ms: 2}}}},
    'eval', ['eval']);
  stage('反证 ⑥：评测产物缺 p95（延迟分位没报全）→ eval 判不合格',
    {[PATHS.ledger]: LEDGER_MIN, ...WEIGHTS_OK, [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK, ...ADAPTER_OK,
      [PATHS.sftEval]: {identity: {adapter: 'x', adapter_basename: basename(PATHS.adapter)},
        summary: {pass_rate: 0.9, latency: {p50_ms: 1}}}},
    'eval', ['eval']);
  stage('反证 ⑦：台账**标了 recorded** 却缺 eval.p95 → record 判不合格（不许算七步完成）',
    {[PATHS.ledger]: {...LEDGER_MIN, eval: {...LEDGER_MIN.eval, p95_ms: null}}, ...WEIGHTS_OK,
      [PATHS.baseEval]: BASE_EVAL, ...DATASET_OK, ...ADAPTER_OK, [PATHS.sftEval]: SFT_EVAL},
    'record', ['record']);
  // 台账坏掉会同时影响 env 与 record 两步——这是如实报，不是误报。
  stage('反证 ⑧：台账不是合法 JSON → env 与 record 判不合格，而不是「还没做」',
    {[PATHS.ledger]: '{ 这不是 JSON'}, 'env', ['env', 'record']);

  // 路径守卫：27B 的产物不许落到 4B 那儿去。
  {
    let threw = false; let message = '';
    try { assertTargetsSafe({adapter: PATHS.fourBv4Adapter}); } catch (error) { threw = true; message = error.message; }
    const passed = threw && message.includes('受保护');
    push('反证 ⑨：把适配器输出指到受保护的 4B v4 → 必须抛错', passed,
      passed ? '' : (threw ? `抛了但信息不对：${message}` : '没有抛错——守卫是空的'));
  }
  {
    let passed = true;
    try { assertTargetsSafe(); } catch { passed = false; }
    push('主线 ⑨：本交付自己的目标路径不被守卫误伤', passed, passed ? '' : '自己的路径被判成受保护路径');
  }

  // 静态性质：命令是**数据**，不是被执行的代码。
  {
    const allStrings = STEPS.every((step) => Array.isArray(step.commands)
      && step.commands.every((c) => typeof c.cmd === 'string' && typeof c.label === 'string'));
    push('主线 ⑩：七步的命令全部是字符串数据（脚本没有执行路径）', allStrings);
  }
  {
    let caught = 0;
    const samples = [
      `import {execFileSync} from 'node:${frag('child', '_process')}';`,
      `await ${frag('fe', 'tch')}(url);`,
      `import {${frag('write', 'File', 'Sync')}} from 'node:fs';`,
    ];
    for (const sample of samples) {
      try { assertNoAutomation(sample, '反证样本'); } catch { caught += 1; }
    }
    push('反证 ⑩：三种「脚本自己会动手」的写法都必须被抓住', caught === samples.length,
      caught === samples.length ? '' : `只抓住 ${caught}/${samples.length}`);
  }
  {
    let passed = true; let why = '';
    try {
      assertNoAutomation(readFileSync(SELF_PATH, 'utf8'), 'plan-27b-steps.mjs');
      assertNoAutomation(readFileSync(LIB_PATH, 'utf8'), 'training-steps.mjs');
    } catch (error) { passed = false; why = error.message; }
    push('正向：本脚本与共享底座的源码都不含被禁止的写法', passed, why);
  }

  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {dryRun: argv.includes('--dry-run'), json: argv.includes('--json'),
    selftest: argv.includes('--selftest'), step: null, help: argv.includes('--help') || argv.includes('-h')};
  const index = argv.indexOf('--step');
  if (index >= 0) options.step = argv[index + 1] || '';
  return options;
}

const HELP = `27B 亲训路线图（只检查与解释；不执行任何命令）

  （无参数）        状态表 + 当前该做的那一步
  --dry-run        打印七步的完整命令清单（仍然只是打印）
  --step <id>      某一步的全部说明：env/download/baseline/data/lora/eval/record
  --json           机器可读的状态
  --selftest       构造状态断言判断正确，含必红反证
  --help
`;

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.selftest) {
    const results = selftest();
    for (const row of results) {
      process.stdout.write(`[selftest] ${row.passed ? '通过' : '未通过'}：${row.name}${!row.passed && row.why ? `\n           ${row.why}` : ''}\n`);
    }
    const passed = results.filter((row) => row.passed).length;
    process.stdout.write(`[selftest] ${passed}/${results.length} 条断言通过\n`);
    return passed === results.length ? 0 : 1;
  }
  // 守卫先跑：万一有人改了 PATHS，这一步会立刻炸，而不是写到 4B 那儿去。
  assertTargetsSafe();
  if (options.step !== null) {
    process.stdout.write(formatStep(options.step));
    return options.step && stepById(options.step) ? 0 : 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(planSteps(fsIo()), null, 1)}\n`);
    return 0;
  }
  if (options.dryRun) {
    process.stdout.write(formatDryRun());
    return 0;
  }
  process.stdout.write(formatStatus(fsIo()));
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[train:plan] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
