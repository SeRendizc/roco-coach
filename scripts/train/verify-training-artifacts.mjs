#!/usr/bin/env node
// 第 1—7 步的**产物校验器**：上一步的产物到底对不对。
//
// 与 `plan-27b-steps.mjs` 的分工：
//   · 规划器回答「现在该做第几步」；
//   · 这个脚本回答「这一步的产物是不是**真的**合格」——把报告里声称的数字
//     重新算一遍，对不上就判红。
//
// 它只读文件，不写、不下载、不训练（自检会扫自己的源码证明这一点）。
//
// 跑法::
//
//     npm run train:verify-artifacts                     # 七步全查
//     npm run train:verify-artifacts -- --step data      # 只查一步
//     npm run train:verify-artifacts -- --sha256         # 顺便核对适配器 sha256（读大文件，慢）
//     npm run train:verify-artifacts -- --step eval --pair-against reports/roco/shadow-replay-sft-v4.json
//     npm run train:verify-artifacts -- --selftest
//
// 判红（退出码 1）与「还没做」（退出码 0）**必须分开**：
// 前者是产物坏了要修，后者是流程还没走到。把「还没做」判红的检查器，
// 会让人从第一天起就习惯忽略红色。

import {readFileSync, existsSync, readdirSync, statSync, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ROOT, PATHS, STEPS, frag, readEvalReport,
  assertNotProtectedPath, assertNoAutomation,
} from './lib/training-steps.mjs';
import {makeTree} from './lib/fixtures.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const LIB_PATH = join(ROOT, 'scripts', 'train', 'lib', 'training-steps.mjs');
const FIXTURES_PATH = join(ROOT, 'scripts', 'train', 'lib', 'fixtures.mjs');
const basename = (path) => String(path).split('/').filter(Boolean).pop();

// ── io ───────────────────────────────────────────────────────────────────

function realIo(root) {
  return {
    root,
    path: (rel) => join(root, rel),
    exists: (rel) => existsSync(join(root, rel)),
    stat: (rel) => statSync(join(root, rel)),
    readText: (rel) => readFileSync(join(root, rel), 'utf8'),
    readJson: (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')),
    list: (rel) => {
      try { return readdirSync(join(root, rel)); } catch { return null; }
    },
    sha256: (rel) => new Promise((ok, bad) => {
      const hash = createHash('sha256');
      const stream = createReadStream(join(root, rel), {highWaterMark: 1 << 22});
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', bad);
      stream.on('end', () => ok(hash.digest('hex')));
    }),
  };
}

// ── 检查项 ───────────────────────────────────────────────────────────────

const PENDING = 'pending';
const OK = 'ok';
const FAIL = 'fail';

function result(step, status, items) {
  return {step, status, items};
}

function pendingResult(step, message) {
  return result(step, PENDING, [{level: 'info', message}]);
}

/** 报告的自描述与重新算出来的数**逐项对账**：这是「报告说的和做的不一样」的唯一防线。 */
export function reconcile(label, claimed, computed, items) {
  const keys = new Set([...Object.keys(claimed || {}), ...Object.keys(computed)]);
  for (const key of keys) {
    const a = claimed?.[key];
    const b = computed[key];
    if (a === undefined || a === null) {
      items.push({level: 'warn', message: `${label}.${key} 缺失（重算得 ${b}）`});
    } else if (a !== b) {
      items.push({level: 'fail', message: `${label}.${key} 报告里是 ${a}，按产物重算是 ${b}：报告与产物不符`});
    } else {
      items.push({level: 'ok', message: `${label}.${key} = ${b}（与产物一致）`});
    }
  }
  return items;
}

/** 逐任务配对差异：只看总数会掩盖「这边修好 20 条、那边坏 20 条」。 */
export function pairDiff(baseRows, tunedRows) {
  const byId = new Map((baseRows || []).map((row) => [row.case_id, row]));
  let compared = 0; let regressed = 0; let fixed = 0; let bothFailed = 0;
  for (const row of tunedRows || []) {
    const other = byId.get(row.case_id);
    if (!other) continue;
    compared += 1;
    if (other.passed && !row.passed) regressed += 1;
    else if (!other.passed && row.passed) fixed += 1;
    else if (!other.passed && !row.passed) bothFailed += 1;
  }
  return {compared, regressed, fixed, both_failed: bothFailed};
}

// ── 各步检查 ─────────────────────────────────────────────────────────────

function checkEnv(io) {
  const items = [];
  if (!io.exists(PATHS.ledger)) return pendingResult('env', `${PATHS.ledger} 还不存在`);
  let ledger;
  try { ledger = io.readJson(PATHS.ledger); } catch (error) {
    return result('env', FAIL, [{level: 'fail', message: `台账不是合法 JSON：${String(error.message).slice(0, 120)}`}]);
  }
  if (!ledger.env) return result('env', FAIL, [{level: 'fail', message: '台账没有 env 节'}]);
  for (const key of ['unified_memory_gib', 'macos', 'node', 'mlx_lm']) {
    if (ledger.env[key] == null) items.push({level: 'fail', message: `台账 env.${key} 为空：第 1 步探测到的事实没记全`});
    else items.push({level: 'ok', message: `env.${key} = ${ledger.env[key]}`});
  }
  return result('env', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

async function checkDownload(io, {sha256 = false} = {}) {
  const items = [];
  if (!io.exists(PATHS.weights)) return pendingResult('download', `${PATHS.weights} 不存在（第 2 步还没做）`);
  const names = io.list(PATHS.weights) || [];
  if (!names.includes('config.json')) {
    return result('download', FAIL, [{level: 'fail', message: `${PATHS.weights} 里没有 config.json：这是半个下载`}]);
  }
  const shards = names.filter((name) => name.endsWith('.safetensors'));
  if (!shards.length) return result('download', FAIL, [{level: 'fail', message: '没有任何 .safetensors 分片'}]);
  // 有分片索引时，索引里点名的每个分片都必须在盘上。少了任何一个
  // 都只会在加载期以形状错暴露出来，那是最难查的一类错。
  const indexName = names.find((name) => name.endsWith('.safetensors.index.json'));
  if (indexName) {
    const index = io.readJson(`${PATHS.weights}/${indexName}`);
    const wanted = [...new Set(Object.values(index.weight_map || {}))];
    const missing = wanted.filter((name) => !names.includes(name));
    if (missing.length) items.push({level: 'fail', message: `索引点名的分片缺 ${missing.join('、')}`});
    else items.push({level: 'ok', message: `索引点名的 ${wanted.length} 个分片都在盘上`});
  } else {
    items.push({level: 'warn', message: '没有 .safetensors.index.json：单文件权重（或索引没下全，需人工确认）'});
  }
  let bytes = 0;
  let weightBytes = 0;
  for (const name of names) {
    try {
      const size = io.stat(`${PATHS.weights}/${name}`).size;
      bytes += size;
      if (name.endsWith('.safetensors')) weightBytes += size;
    } catch { /* 单个文件 stat 失败不影响其余 */ }
  }
  items.push({level: 'ok', message: `盘上合计 ${(bytes / 1e9).toFixed(2)} GB（${names.length} 个文件，其中权重分片 ${(weightBytes / 1e9).toFixed(2)} GB）`});

  if (!io.exists(PATHS.ledger)) {
    items.push({level: 'fail', message: `有权重但没有台账 ${PATHS.ledger}：revision / 许可 / 字节数都没有记录`});
    return result('download', FAIL, items);
  }
  const ledger = io.readJson(PATHS.ledger);
  const base = ledger.base || {};
  for (const key of ['repo_id', 'revision', 'license', 'downloaded_on']) {
    if (!base[key]) items.push({level: 'fail', message: `台账 base.${key} 为空`});
  }
  // 比的是**权重分片**的字节数：那才是「这份权重有多大」，也不受配置小文件改版的影响。
  if (base.total_bytes == null) items.push({level: 'fail', message: '台账 base.total_bytes 为空'});
  else if (base.total_bytes !== weightBytes) {
    items.push({level: 'fail', message: `台账 base.total_bytes=${base.total_bytes} 与盘上权重 ${weightBytes} 不一致：换过权重或台账没更新`});
  } else items.push({level: 'ok', message: `base.total_bytes 与盘上权重一致（${weightBytes}）`});

  if (sha256 && base.files_sha256 && Object.keys(base.files_sha256).length) {
    for (const [name, want] of Object.entries(base.files_sha256)) {
      if (!io.exists(`${PATHS.weights}/${name}`)) { items.push({level: 'fail', message: `台账记了 ${name} 的 sha256，但盘上没有这个文件`}); continue; }
      const got = await io.sha256(`${PATHS.weights}/${name}`);
      items.push(got === want
        ? {level: 'ok', message: `${name} sha256 一致`}
        : {level: 'fail', message: `${name} sha256=${got.slice(0, 16)}… 与台账 ${String(want).slice(0, 16)}… 不一致`});
    }
  } else if (sha256) {
    items.push({level: 'warn', message: '台账 base.files_sha256 为空：没有可核对的哈希'});
  } else {
    items.push({level: 'info', message: '未核对 sha256（加 --sha256 会真的读一遍大文件）'});
  }
  return result('download', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

function probeEvalFile(io, rel) {
  if (!io.exists(rel)) return {exists: false};
  try { return {exists: true, value: io.readJson(rel)}; } catch (error) {
    return {exists: true, error: `不是合法 JSON：${String(error.message).slice(0, 120)}`};
  }
}

function checkBaseline(io) {
  const probe = probeEvalFile(io, PATHS.baseEval);
  if (!probe.exists) return pendingResult('baseline', `${PATHS.baseEval} 不存在`);
  if (probe.error) return result('baseline', FAIL, [{level: 'fail', message: probe.error}]);
  const items = [];
  const identity = probe.value.identity || {};
  if (!identity.model) items.push({level: 'fail', message: '没有 identity.model'});
  else if (!String(identity.model).includes(basename(PATHS.weights))) {
    items.push({level: 'fail', message: `identity.model=${identity.model} 不含 ${basename(PATHS.weights)}：这份不是 27B`});
  } else items.push({level: 'ok', message: `identity.model 指向 27B：${identity.model}`});
  if (identity.adapter != null) items.push({level: 'fail', message: `identity.adapter=${identity.adapter}：基座产物不该带适配器`});
  const read = readEvalReport(probe.value);
  if (read.pass_rate == null) items.push({level: 'fail', message: '没有 summary.pass_rate'});
  else items.push({level: 'ok', message: `pass_rate = ${read.pass_rate}（${read.passed}/${read.tasks}）`});
  return result('baseline', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

function checkData(io) {
  const reportRel = `${PATHS.dataset}/dataset-report.json`;
  const sides = {train: 'train.jsonl', val: 'valid.jsonl', test: 'test.jsonl'};
  if (!io.exists(reportRel) && !Object.values(sides).some((name) => io.exists(`${PATHS.dataset}/${name}`))) {
    return pendingResult('data', `${PATHS.dataset} 还没有产物`);
  }
  const items = [];
  if (!io.exists(reportRel)) return result('data', FAIL, [{level: 'fail', message: `${reportRel} 不存在：数据是怎么切的没有记录`}]);
  const report = io.readJson(reportRel);
  const missing = Object.values(sides).filter((name) => !io.exists(`${PATHS.dataset}/${name}`));
  if (missing.length) items.push({level: 'fail', message: `缺 ${missing.join('、')}`});

  const invariants = report.invariants || {};
  for (const [key, value] of Object.entries(invariants)) {
    if (key === 'thin_mechanisms_in_train') continue;
    items.push(value === true
      ? {level: 'ok', message: `不变量 ${key} = true`}
      : {level: 'fail', message: `不变量 ${key} = ${value}（必须为 true）`});
  }

  // 重算行数：报告里的计数必须能从 jsonl 数出来。
  const computed = {};
  for (const [side, name] of Object.entries(sides)) {
    const rel = `${PATHS.dataset}/${name}`;
    if (!io.exists(rel)) continue;
    const text = io.readText(rel);
    const rows = text.split('\n').filter((line) => line.trim());
    computed[side] = rows.length;
    const bad = rows.map((line, index) => {
      try { JSON.parse(line); return null; } catch { return index + 1; }
    }).filter(Boolean);
    if (bad.length) items.push({level: 'fail', message: `${name} 有 ${bad.length} 行不是合法 JSON（首行 ${bad[0]}）`});
  }
  reconcile('counts.by_side', report.counts?.by_side, computed, items);

  for (const key of ['worlds_per_task', 'split_mode', 'split_rule']) {
    if (report[key] == null) items.push({level: 'fail', message: `dataset-report.${key} 缺失`});
  }
  if (io.exists(PATHS.ledger)) {
    const ledger = io.readJson(PATHS.ledger);
    const want = ledger.data?.train_rows;
    if (want == null) items.push({level: 'warn', message: '台账没有 data.train_rows'});
    else if (want !== computed.train) items.push({level: 'fail', message: `台账 data.train_rows=${want} 与训练侧 ${computed.train} 行不一致`});
    else items.push({level: 'ok', message: `台账 data.train_rows 与产物一致（${want}）`});
  }
  return result('data', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

async function checkLora(io, {sha256 = false} = {}) {
  if (!io.exists(PATHS.adapter)) return pendingResult('lora', `${PATHS.adapter} 不存在`);
  const items = [];
  const configRel = `${PATHS.adapter}/adapter_config.json`;
  const weightsRel = `${PATHS.adapter}/adapters.safetensors`;
  if (!io.exists(configRel)) return result('lora', FAIL, [{level: 'fail', message: `缺 ${configRel}`}]);
  if (!io.exists(weightsRel)) return result('lora', FAIL, [{level: 'fail', message: `缺 ${weightsRel}`}]);
  const config = io.readJson(configRel);
  if (!String(config.model || '').includes(basename(PATHS.weights))) {
    items.push({level: 'fail', message: `adapter_config.model=${config.model} 不含 ${basename(PATHS.weights)}：不是 27B 上的适配器`});
  } else items.push({level: 'ok', message: `adapter_config.model 指向 27B（iters=${config.iters}、rank=${config.lora_parameters?.rank}）`});
  if (config.data !== PATHS.dataset) {
    items.push({level: 'fail', message: `adapter_config.data=${config.data}，期望 ${PATHS.dataset}`});
  } else items.push({level: 'ok', message: `adapter_config.data = ${PATHS.dataset}`});
  for (const key of ['iters', 'learning_rate', 'max_seq_length', 'mask_prompt', 'seed']) {
    if (config[key] == null) items.push({level: 'warn', message: `adapter_config.${key} 缺失：这次训练的超参没留全`});
  }

  if (io.exists(PATHS.ledger)) {
    const ledger = io.readJson(PATHS.ledger);
    const lora = ledger.lora || {};
    if (lora.smoke_peak_mem_gb == null) items.push({level: 'fail', message: '台账没有 lora.smoke_peak_mem_gb：没做冒烟就没法证明装得下'});
    else items.push({level: 'ok', message: `lora.smoke_peak_mem_gb = ${lora.smoke_peak_mem_gb} GB`});
    if (!lora.hyperparams || !Object.keys(lora.hyperparams).length) {
      items.push({level: 'warn', message: '台账 lora.hyperparams 为空'});
    }
    if (sha256) {
      const got = await io.sha256(weightsRel);
      if (!lora.adapter_sha256) items.push({level: 'warn', message: `台账没有 adapter_sha256；实算得 ${got}`});
      else if (lora.adapter_sha256 !== got) {
        items.push({level: 'fail', message: `adapters.safetensors sha256=${got.slice(0, 16)}… 与台账 ${String(lora.adapter_sha256).slice(0, 16)}… 不一致`});
      } else items.push({level: 'ok', message: 'adapters.safetensors sha256 与台账一致'});
    }
  } else {
    items.push({level: 'warn', message: '没有台账，无法核对冒烟峰值'});
  }
  return result('lora', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

function checkEval(io, {pairAgainst = null, onLog = () => {}} = {}) {
  const probe = probeEvalFile(io, PATHS.sftEval);
  if (!probe.exists) return pendingResult('eval', `${PATHS.sftEval} 不存在`);
  if (probe.error) return result('eval', FAIL, [{level: 'fail', message: probe.error}]);
  const items = [];
  const report = probe.value;
  const identity = report.identity || {};
  if (!identity.adapter) items.push({level: 'fail', message: 'identity.adapter 为 null：网关没加载适配器，这份等于在量基座'});
  else if (identity.adapter_basename !== basename(PATHS.adapter)) {
    items.push({level: 'fail', message: `identity.adapter_basename=${identity.adapter_basename}，期望 ${basename(PATHS.adapter)}：`
      + '这正是第 37 轮「成绩存档错位」那类事故'});
  } else items.push({level: 'ok', message: `identity.adapter_basename = ${identity.adapter_basename}`});

  // 四件事必须分别报，缺一件就不算报全。
  const read = readEvalReport(report);
  const four = {
    pass_rate: read.pass_rate, invalid_arguments: read.invalid_arguments,
    p50_ms: read.p50_ms, p95_ms: read.p95_ms,
  };
  for (const [key, value] of Object.entries(four)) {
    items.push(value == null ? {level: 'fail', message: `缺 ${key}`} : {level: 'ok', message: `${key} = ${value}`});
  }
  items.push({level: 'info', message: `非法参数口径：${read.invalid_arguments_source}`});
  if (!read.pairing) items.push({level: 'fail', message: '没有 comparison：没有配对差异就不能说「变好了」'});
  else items.push({level: 'ok', message: `配对 against=${read.pairing.against}：退化 ${read.pairing.regressed}、扳回 ${read.pairing.fixed}、双败 ${read.pairing.both_failed}`});

  // 逐任务配对**重算一遍**，与报告里声称的对账。
  const target = pairAgainst || PATHS.fourBv4Eval;
  const other = probeEvalFile(io, target);
  if (!other.exists) {
    items.push({level: 'warn', message: `找不到要配对的另一份产物 ${target}：无法重算配对差异`});
  } else if (other.error) {
    items.push({level: 'fail', message: `配对产物 ${target} ${other.error}`});
  } else {
    const computed = pairDiff(other.value.rows, report.rows);
    const claimed = report.comparison || {};
    onLog(`  配对重算（${target} → ${PATHS.sftEval}）：${JSON.stringify(computed)}`);
    // 「同一把尺子」的第一条：提示必须逐字节相同。提示不同的话，逐任务配对
    // 比的是两个不同的任务，数字看着像对比，其实没有意义。
    const mine = report.prompt_digest;
    const theirs = other.value.prompt_digest;
    if (mine && theirs && mine !== theirs) {
      items.push({level: 'fail', message: `prompt_digest 不一致（本份 ${String(mine).slice(0, 16)}… / `
        + `对照 ${String(theirs).slice(0, 16)}…）：提示不同就不是同一把尺子，配对差异无意义`});
    } else if (mine && theirs) {
      items.push({level: 'ok', message: `prompt_digest 与对照产物一致（${String(mine).slice(0, 16)}…）`});
    } else {
      items.push({level: 'warn', message: '两侧至少一份没有 prompt_digest：无法确认用的是同一份提示'});
    }
    if (claimed.against && !String(claimed.against).endsWith(basename(target))) {
      items.push({level: 'warn', message: `报告里的 comparison.against=${claimed.against} 与本次配对目标 ${target} 不是同一个文件`});
    }
    reconcile('comparison', {regressed: claimed.regressed, fixed: claimed.fixed, both_failed: claimed.both_failed},
      {regressed: computed.regressed, fixed: computed.fixed, both_failed: computed.both_failed}, items);
  }

  // 台账里的四个数字必须与产物里的一致——否则台账就是一份独立的、无法核对的说辞。
  if (io.exists(PATHS.ledger)) {
    const ledger = io.readJson(PATHS.ledger);
    const claimed = ledger.eval || {};
    reconcile('ledger.eval', {
      pass_rate: claimed.pass_rate, invalid_arguments: claimed.invalid_arguments,
      p50_ms: claimed.p50_ms, p95_ms: claimed.p95_ms,
    }, four, items);
    if (claimed.paired_vs_4b_v4) {
      reconcile('ledger.eval.paired_vs_4b_v4',
        {regressed: claimed.paired_vs_4b_v4.regressed, fixed: claimed.paired_vs_4b_v4.fixed},
        {regressed: read.pairing?.regressed ?? null, fixed: read.pairing?.fixed ?? null}, items);
    } else {
      items.push({level: 'warn', message: '台账没有 eval.paired_vs_4b_v4'});
    }
  } else {
    items.push({level: 'warn', message: '没有台账，无法核对台账里的四项数字'});
  }
  return result('eval', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

function checkRecord(io) {
  if (!io.exists(PATHS.ledger)) return pendingResult('record', `${PATHS.ledger} 不存在`);
  const ledger = io.readJson(PATHS.ledger);
  const items = [];
  if (ledger.status !== 'recorded') {
    return pendingResult('record', `台账 status=${ledger.status ?? 'null'}，第 7 步还没做`);
  }
  const base = ledger.base || {};
  for (const key of ['repo_id', 'revision', 'license']) {
    items.push(base[key] ? {level: 'ok', message: `base.${key} = ${base[key]}`} : {level: 'fail', message: `base.${key} 为空`});
  }
  if (ledger.lora?.smoke_peak_mem_gb == null) items.push({level: 'fail', message: '缺 lora.smoke_peak_mem_gb'});
  for (const key of ['pass_rate', 'invalid_arguments', 'p50_ms', 'p95_ms']) {
    if (ledger.eval?.[key] == null) items.push({level: 'fail', message: `缺 eval.${key}`});
  }
  if (ledger.eval?.paired_vs_4b_v4?.regressed == null || ledger.eval?.paired_vs_4b_v4?.fixed == null) {
    items.push({level: 'fail', message: '缺 eval.paired_vs_4b_v4'});
  }
  const notClaims = ledger.claims?.this_is_not;
  if (!Array.isArray(notClaims) || !notClaims.length) {
    items.push({level: 'fail', message: '台账没有 claims.this_is_not：没有写明这份交付**不**声称什么'});
  } else items.push({level: 'ok', message: `claims.this_is_not = ${notClaims.join('、')}`});
  return result('record', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

/** 受保护路径守卫：27B 的任何读写目标都不许落到 4B 那儿。 */
export function checkProtectedTargets(targets = {
  weights: PATHS.weights, dataset: PATHS.dataset, adapter: PATHS.adapter,
  work: PATHS.work, baseEval: PATHS.baseEval, sftEval: PATHS.sftEval,
}) {
  const items = [];
  for (const [kind, target] of Object.entries(targets)) {
    try {
      assertNotProtectedPath(target);
      items.push({level: 'ok', message: `${kind} → ${target}`});
    } catch (error) {
      items.push({level: 'fail', message: error.message});
    }
  }
  return result('guard', items.some((i) => i.level === 'fail') ? FAIL : OK, items);
}

export const CHECKS = {
  env: (io) => checkEnv(io),
  download: (io, options) => checkDownload(io, options),
  baseline: (io) => checkBaseline(io),
  data: (io) => checkData(io),
  lora: (io, options) => checkLora(io, options),
  eval: (io, options) => checkEval(io, options),
  record: (io) => checkRecord(io),
};

export async function runChecks(io, steps, options = {}) {
  const out = [checkProtectedTargets()];
  for (const id of steps) {
    const check = CHECKS[id];
    if (!check) throw new Error(`未知步骤：${id}`);
    out.push(await check(io, options));
  }
  return out;
}

// ── 输出 ─────────────────────────────────────────────────────────────────

const ICON = {ok: '✔', info: '·', warn: '!', fail: '✖'};

export function formatResults(results) {
  const lines = [];
  const counts = {ok: 0, fail: 0, pending: 0};
  for (const row of results) {
    if (row.status === PENDING) counts.pending += 1;
    else if (row.status === OK) counts.ok += 1;
    else counts.fail += 1;
    const head = row.status === PENDING ? '未开始' : row.status === OK ? '合格' : '不合格';
    lines.push(`【${row.step}】${head}`);
    for (const item of row.items) lines.push(`  ${ICON[item.level] || '·'} ${item.message}`);
    lines.push('');
  }
  lines.push(`小结：合格 ${counts.ok} 步、不合格 ${counts.fail} 步、未开始 ${counts.pending} 步。`
    + '「未开始」不算失败；「不合格」必须修——它比缺失更危险，因为下一个脚本会以为它做过了。');
  return `${lines.join('\n')}\n`;
}

// ── 自检（真临时目录；哈希与流式读都要真文件） ───────────────────────────

const FIXTURE = {
  ledgerOk: {
    schema: 'roco-27b-training-ledger/1',
    base: {repo_id: 'mlx-community/Qwen3.8-27B-4bit', revision: 'deadbeef', license: 'apache-2.0',
      downloaded_on: '2026-09-21', total_bytes: null, files_sha256: {}},
    env: {unified_memory_gib: 48, macos: '27.0', node: 'v24.20.0', mlx_lm: '0.31.3'},
    data: {train_rows: 2},
    lora: {smoke_peak_mem_gb: 30, hyperparams: {rank: 8}},
    eval: {pass_rate: 0.9, invalid_arguments: 1, p50_ms: 1200, p95_ms: 2600,
      paired_vs_4b_v4: {regressed: 1, fixed: 2}},
    claims: {this_is: '工具路由', this_is_not: ['战斗策略模型', '价值模型', '胜率', '真人效果']},
    status: 'recorded',
  },
  datasetReport: {
    worlds_per_task: 9, split_mode: 'strict', split_rule: '留出机制',
    counts: {by_side: {train: 2, val: 1, test: 1}},
    invariants: {every_family_in_train: true, no_designed_holdout_in_train: true,
      every_taught_mechanism_has_two_train_rows: true, thin_mechanisms_in_train: []},
  },
  evalRows: [
    {case_id: 'a', passed: true, violations: []},
    {case_id: 'b', passed: false, violations: ['query_rules 的参数里没有同时满足 {"kind":"pet"} 的一次调用']},
    {case_id: 'c', passed: true, violations: []},
  ],
  baseRows: [
    {case_id: 'a', passed: false, violations: ['没有调用应当调用的工具 query_rules']},
    {case_id: 'b', passed: true, violations: []},
    {case_id: 'c', passed: true, violations: []},
  ],
};

/** 一份「全部合格」的完整夹具（JSON 文件内容）。 */
function goodFiles({weightsBytes = 1000, adapterModel = PATHS.weights} = {}) {
  const ledger = JSON.parse(JSON.stringify(FIXTURE.ledgerOk));
  ledger.base.total_bytes = weightsBytes;
  // 台账里的四个数字必须与产物里能重算出来的**完全一致**，否则主线就会判红
  // （这正是这个检查器要证明的性质）。
  ledger.eval = {pass_rate: 0.6667, invalid_arguments: 1, p50_ms: 1200, p95_ms: 2600,
    paired_vs_4b_v4: {regressed: 1, fixed: 1}};
  return {
    [PATHS.ledger]: ledger,
    [`${PATHS.weights}/config.json`]: {model_type: 'qwen3'},
    [`${PATHS.weights}/model.safetensors`]: 'x'.repeat(weightsBytes),
    [PATHS.baseEval]: {identity: {model: `${ROOT}/${PATHS.weights}`, adapter: null},
      prompt_digest: 'd'.repeat(64),
      summary: {tasks: 3, passed: 2, pass_rate: 0.6667, latency: {p50_ms: 900, p95_ms: 1500}},
      rows: FIXTURE.baseRows},
    [`${PATHS.dataset}/train.jsonl`]: '{"messages":[]}\n{"messages":[]}\n',
    [`${PATHS.dataset}/valid.jsonl`]: '{"messages":[]}\n',
    [`${PATHS.dataset}/test.jsonl`]: '{"messages":[]}\n',
    [`${PATHS.dataset}/dataset-report.json`]: FIXTURE.datasetReport,
    [`${PATHS.adapter}/adapter_config.json`]: {model: adapterModel, data: PATHS.dataset, iters: 900,
      learning_rate: 1e-5, max_seq_length: 768, mask_prompt: true, seed: 20260921,
      lora_parameters: {rank: 8}},
    [`${PATHS.adapter}/adapters.safetensors`]: 'y'.repeat(64),
    // 对照臂（4B v4 那一份）也放进临时树里：**只读**，用来让「逐任务配对重算」
    // 与「prompt_digest 必须一致」这两条真的被执行到。它在临时目录里，
    // 不碰仓库里那份受保护的产物。
    [PATHS.fourBv4Eval]: {prompt_digest: 'd'.repeat(64), rows: FIXTURE.baseRows},
    [PATHS.sftEval]: {identity: {model: `${ROOT}/${PATHS.weights}`, adapter: `${ROOT}/${PATHS.adapter}`,
      adapter_basename: basename(PATHS.adapter)},
      prompt_digest: 'd'.repeat(64),
      summary: {tasks: 3, passed: 2, pass_rate: 0.6667, latency: {p50_ms: 1200, p95_ms: 2600}},
      rows: FIXTURE.evalRows,
      comparison: {against: PATHS.fourBv4Eval, regressed: 1, fixed: 1, both_failed: 0}},
  };
}

export async function selftest() {
  const results = [];
  const push = (name, passed, why = '') => results.push({name, passed, why});
  const allSteps = ['env', 'download', 'baseline', 'data', 'lora', 'eval', 'record'];

  const run = async (files, steps = allSteps, options = {}) => {
    const tree = makeTree(files);
    try {
      const io = realIo(tree.dir);
      return await runChecks(io, steps, options);
    } finally { tree.cleanup(); }
  };
  const statusOf = (rows, step) => rows.find((row) => row.step === step)?.status;

  // 主线 ①：全部合格 → 每一步都 OK（含 sha256 与逐任务配对的重算）
  {
    const rows = await run(goodFiles(), allSteps, {sha256: true, pairAgainst: PATHS.fourBv4Eval});
    const bad = rows.filter((row) => row.status === FAIL).map((row) => `${row.step}: ${row.items.filter((i) => i.level === 'fail').map((i) => i.message).join('；')}`);
    push('主线 ①：完整产物 + sha256 + 配对重算 → 没有任何不合格',
      bad.length === 0, bad.join('\n           '));
  }

  // 主线 ②：空仓库 → 全部「未开始」，且**没有任何不合格**（未开始不是失败）
  {
    const rows = await run({});
    const fails = rows.filter((row) => row.status === FAIL);
    const pendings = rows.filter((row) => row.status === PENDING);
    push('主线 ②：空仓库 → 全部 pending、零 fail（未开始不得判红）',
      fails.length === 0 && pendings.length === allSteps.length,
      `fail=${fails.map((r) => r.step).join(',')}；pending=${pendings.length}/${allSteps.length}`);
  }

  // ── 必红反证 ──
  {
    const files = goodFiles();
    files[`${PATHS.dataset}/train.jsonl`] = '{"messages":[]}\n'; // 报告说 2 行，实际 1 行
    const rows = await run(files, ['data']);
    push('反证 ①：jsonl 行数与报告计数不符 → data 判红',
      statusOf(rows, 'data') === FAIL, `实际 ${statusOf(rows, 'data')}`);
  }
  {
    const files = goodFiles();
    files[`${PATHS.dataset}/dataset-report.json`] = {...FIXTURE.datasetReport,
      invariants: {...FIXTURE.datasetReport.invariants, no_designed_holdout_in_train: false}};
    const rows = await run(files, ['data']);
    push('反证 ②：不变量被改成 false（留出泄漏）→ data 判红',
      statusOf(rows, 'data') === FAIL, `实际 ${statusOf(rows, 'data')}`);
  }
  {
    const rows = await run(goodFiles({adapterModel: '.models/mlx/Qwen3.5-4B-4bit'}), ['lora']);
    push('反证 ③：adapter_config.model 指向 4B → lora 判红',
      statusOf(rows, 'lora') === FAIL, `实际 ${statusOf(rows, 'lora')}`);
  }
  {
    const files = goodFiles();
    files[PATHS.ledger].lora = {hyperparams: {rank: 8}}; // 少了 smoke_peak_mem_gb
    const rows = await run(files, ['lora']);
    push('反证 ④：台账没有冒烟峰值 → lora 判红',
      statusOf(rows, 'lora') === FAIL, `实际 ${statusOf(rows, 'lora')}`);
  }
  {
    const files = goodFiles();
    files[PATHS.sftEval] = {...files[PATHS.sftEval], comparison: {against: PATHS.fourBv4Eval, regressed: 0, fixed: 1, both_failed: 0}};
    const rows = await run(files, ['eval'], {pairAgainst: PATHS.fourBv4Eval});
    push('反证 ⑤：报告声称退化 0，逐任务重算是 1 → eval 判红（报告与产物不符）',
      statusOf(rows, 'eval') === FAIL, `实际 ${statusOf(rows, 'eval')}`);
  }
  {
    const files = goodFiles();
    files[PATHS.ledger] = {...files[PATHS.ledger], eval: {...files[PATHS.ledger].eval, p95_ms: 9999}};
    const rows = await run(files, ['eval'], {pairAgainst: PATHS.fourBv4Eval});
    push('反证 ⑥：台账里的 p95 与产物不一致 → eval 判红',
      statusOf(rows, 'eval') === FAIL, `实际 ${statusOf(rows, 'eval')}`);
  }
  {
    const files = goodFiles();
    files[PATHS.sftEval] = {...files[PATHS.sftEval], identity: {...files[PATHS.sftEval].identity, adapter: null}};
    const rows = await run(files, ['eval']);
    push('反证 ⑦：评测产物 identity.adapter 为 null → eval 判红',
      statusOf(rows, 'eval') === FAIL, `实际 ${statusOf(rows, 'eval')}`);
  }
  {
    const files = goodFiles({weightsBytes: 1000});
    files[PATHS.ledger].base.total_bytes = 2000;
    const rows = await run(files, ['download']);
    push('反证 ⑧：台账字节数与盘上不一致 → download 判红',
      statusOf(rows, 'download') === FAIL, `实际 ${statusOf(rows, 'download')}`);
  }
  {
    const files = goodFiles();
    files[PATHS.ledger].base.files_sha256 = {'model.safetensors': 'f'.repeat(64)};
    const rows = await run(files, ['download'], {sha256: true});
    push('反证 ⑨：sha256 与台账不符 → download 判红',
      statusOf(rows, 'download') === FAIL, `实际 ${statusOf(rows, 'download')}`);
  }
  {
    // 提示不同 = 不是同一把尺子。这一条挡的是「拿两份用不同提示跑出来的分数做配对」。
    const files = goodFiles();
    files[PATHS.sftEval] = {...files[PATHS.sftEval], prompt_digest: 'e'.repeat(64)};
    const rows = await run(files, ['eval'], {pairAgainst: PATHS.fourBv4Eval});
    push('反证 ⑩：与对照产物的 prompt_digest 不一致 → eval 判红（配对无意义）',
      statusOf(rows, 'eval') === FAIL, `实际 ${statusOf(rows, 'eval')}`);
  }
  {
    // 路径守卫：把数据集指到受保护的 4B 数据目录
    const rows = await runChecks(realIo('/tmp/roco-nonexistent-root'), [], {});
    push('主线 ③：默认目标路径全部不在受保护路径里 → guard 合格',
      statusOf(rows, 'guard') === OK, `实际 ${statusOf(rows, 'guard')}`);
  }
  {
    let threw = false; let message = '';
    try { assertNotProtectedPath(PATHS.fourBv4Adapter); } catch (error) { threw = true; message = error.message; }
    push('反证 ⑪：把目标指到受保护的 4B v4 适配器 → 必须抛错',
      threw && message.includes('受保护'), threw ? `信息不对：${message}` : '没有抛错');
  }

  // 「脚本自己不许动手」也要有反证
  {
    const samples = [
      `import {execFileSync} from 'node:${frag('child', '_process')}';`,
      `await ${frag('fe', 'tch')}(url);`,
      `import {${frag('write', 'File', 'Sync')}} from 'node:fs';`,
    ];
    let caught = 0;
    for (const sample of samples) { try { assertNoAutomation(sample, '反证样本'); } catch { caught += 1; } }
    push('反证 ⑫：三种「脚本自己会动手」的写法都必须被抓住', caught === samples.length,
      caught === samples.length ? '' : `只抓住 ${caught}/${samples.length}`);
  }
  {
    let passed = true; let why = '';
    try {
      assertNoAutomation(readFileSync(SELF_PATH, 'utf8'), 'verify-training-artifacts.mjs');
      assertNoAutomation(readFileSync(LIB_PATH, 'utf8'), 'training-steps.mjs');
      assertNoAutomation(readFileSync(FIXTURES_PATH, 'utf8'), 'fixtures.mjs', {allowWrites: true});
    } catch (error) { passed = false; why = error.message; }
    push('正向：本脚本 / 共享底座 / 夹具库的源码都不含被禁止的写法', passed, why);
  }

  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {selftest: argv.includes('--selftest'), json: argv.includes('--json'),
    sha256: argv.includes('--sha256'), step: null, pairAgainst: null, root: null,
    help: argv.includes('--help') || argv.includes('-h')};
  const take = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  options.step = take('--step');
  options.pairAgainst = take('--pair-against');
  options.root = take('--root');
  return options;
}

const HELP = `27B 亲训产物校验（只读；不下载、不训练、不写文件）

  （无参数）                 七步全查
  --step <id>               只查一步：env/download/baseline/data/lora/eval/record
  --pair-against <report>   逐任务配对的目标产物（默认 4B v4 那份）
  --sha256                  顺便核对权重/适配器 sha256（会真的读一遍文件）
  --root <dir>              换个根目录（自检用）
  --json                    机器可读输出
  --selftest                构造产物断言判断正确，含必红反证
  --help

判红（退出码 1）只表示「产物存在但不合格」；「还没做」退出码是 0。
`;

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.selftest) {
    const results = await selftest();
    for (const row of results) {
      process.stdout.write(`[selftest] ${row.passed ? '通过' : '未通过'}：${row.name}${!row.passed && row.why ? `\n           ${row.why}` : ''}\n`);
    }
    const passed = results.filter((row) => row.passed).length;
    process.stdout.write(`[selftest] ${passed}/${results.length} 条断言通过\n`);
    return passed === results.length ? 0 : 1;
  }
  const root = options.root ? resolve(options.root) : ROOT;
  const steps = options.step ? options.step.split(',').map((s) => s.trim()).filter(Boolean)
    : STEPS.map((step) => step.id);
  const unknown = steps.filter((id) => !CHECKS[id]);
  if (unknown.length) {
    process.stderr.write(`未知步骤：${unknown.join('、')}。可选：${Object.keys(CHECKS).join(' / ')}\n`);
    return 2;
  }
  const io = realIo(root);
  const rows = await runChecks(io, steps, {sha256: options.sha256, pairAgainst: options.pairAgainst});
  if (options.json) {
    process.stdout.write(`${JSON.stringify({root, results: rows}, null, 1)}\n`);
  } else {
    process.stdout.write(formatResults(rows));
  }
  return rows.some((row) => row.status === FAIL) ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[train:verify-artifacts] ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
