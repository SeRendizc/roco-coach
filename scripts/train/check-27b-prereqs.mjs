#!/usr/bin/env node
// 第 1 步：27B 亲训的**环境与磁盘前置检查**。
//
// 它只做两件事：探测本机事实，然后**解释**这些事实对「用户亲自跑 27B LoRA」
// 意味着什么。它不下载、不训练、不写任何文件（自检会扫自己的源码来证明）。
//
// 跑法::
//
//     npm run train:prereqs                      # 人读的输出
//     npm run train:prereqs -- --json            # 机器可读（写台账时抄这个）
//     npm run train:prereqs -- --emit-ledger-template
//     npm run train:prereqs -- --expect-weights  # 已经在下第 2 步时用：权重缺失判红
//     npm run train:prereqs -- --selftest        # 构造状态断言判断正确（含必红反证）
//
// 为什么判定分三档而不是「够 / 不够」
// ----------------------------------
// 48 GiB 统一内存到底装不装得下 27B 的 LoRA，本仓库**没有实测**。所以：
//   · `blocked`      —— 硬条件明确不满足（磁盘/依赖/被保护的路径冲突）；
//   · `must-measure` —— 硬条件都过了，但内存峰值必须**先量再定**（默认档）；
//   · `ready`        —— 只有台账里已经有实测峰值、且留出余量，才给这一档。
// 默认不会给 ready。给一个编出来的 ready 比不给结论更糟。

import {readFileSync, readdirSync, existsSync, statfsSync, statSync} from 'node:fs';
import {totalmem, cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ROOT, PATHS, GIB, GB, SIZE, MEMORY_PLANNING, gbToGib, frag,
  assertNotProtectedPath, assertNoAutomation,
} from './lib/training-steps.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const LIB_PATH = join(ROOT, 'scripts', 'train', 'lib', 'training-steps.mjs');

//: MLX 需要 Apple Silicon + 较新的 macOS。这两个数不是从 mlx 的安装元数据里读出来的，
//: 是**保守下限**：写低了会在半路报更难懂的错，写高了会挡住本来能跑的环境。
const MIN_MACOS_MAJOR = 14;
const MIN_NODE_MAJOR = 18;
//: 本仓库 `.venv-mlx` 固定在这一版（见 `models/registry.json` 的 `runtime.engine_version`
//: 与 `scripts/model/setup-mac.sh` 的 `MLX_LM_VERSION`）。不一致只 warn 不 block：
//: 换版本可能是用户有意的，但必须留痕。
const EXPECTED_MLX_LM = '0.31.3';

// ── 探测（只读，不起子进程） ─────────────────────────────────────────────

/** 读 macOS 的版本 plist。**不启动 sw_vers**（本脚本连子进程都起不了，见 `--selftest`）。 */
export function probeMacos(readText = (p) => readFileSync(p, 'utf8')) {
  try {
    const text = readText('/System/Library/CoreServices/SystemVersion.plist');
    const pick = (key) => {
      const hit = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
      return hit ? hit[1].trim() : null;
    };
    return {version: pick('ProductVersion'), build: pick('ProductBuildVersion')};
  } catch (error) {
    return {version: null, build: null, why: `读不到 SystemVersion.plist：${String(error.message).slice(0, 80)}`};
  }
}

/** `.venv-mlx` 的实情：解释器版本、mlx / mlx-lm 版本。**不 import 任何库、不起进程。** */
export function probeVenv(root = ROOT) {
  const venv = join(root, '.venv-mlx');
  if (!existsSync(venv)) return {exists: false, path: '.venv-mlx'};
  const out = {exists: true, path: '.venv-mlx', python: null, mlx: null, mlx_lm: null, layout: null, problems: []};
  const libDir = join(venv, 'lib');
  let interpreter = null;
  try {
    const entry = readdirSync(libDir).find((name) => name.startsWith('python3.'));
    if (entry) { interpreter = entry; out.layout = `lib/${entry}`; }
  } catch { /* 下面统一报 */ }
  if (!interpreter) {
    out.problems.push('找不到 .venv-mlx/lib/python3.* —— 环境可能只建了一半');
    return out;
  }
  try {
    const cfg = readFileSync(join(venv, 'pyvenv.cfg'), 'utf8');
    const hit = cfg.match(/^version(?:_info)?\s*=\s*(.+)$/m);
    out.python = hit ? hit[1].trim() : interpreter.replace('python', '');
  } catch {
    out.python = interpreter.replace('python', '');
  }
  const site = join(libDir, interpreter, 'site-packages');
  const distVersion = (prefix) => {
    try {
      const hit = readdirSync(site).find((name) => name.startsWith(`${prefix}-`) && name.endsWith('.dist-info'));
      return hit ? hit.slice(prefix.length + 1, -'.dist-info'.length) : null;
    } catch (error) {
      out.problems.push(`读不到 ${site}：${String(error.message).slice(0, 80)}`);
      return null;
    }
  };
  // mlx_lm 的 dist-info 名字带下划线，mlx 的不带；两者分开查，别用一个正则硬套。
  out.mlx_lm = distVersion('mlx_lm');
  out.mlx = distVersion('mlx');
  if (!out.mlx_lm) out.problems.push('site-packages 里没有 mlx_lm-*.dist-info：mlx-lm 没装上');
  return out;
}

/** 权重目录的实情：存在吗、有多少字节、有没有 config.json 与分片。 */
export function probeWeights(root = ROOT, rel = PATHS.weights) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return {path: rel, exists: false, bytes: 0, files: []};
  let names = [];
  try { names = readdirSync(dir).filter((name) => !name.startsWith('.')); } catch { names = []; }
  const weights = names.filter((name) => name.endsWith('.safetensors'));
  // 只 stat 体积，**不读内容**：真的读进内存会在 3 GB 级文件上撞 Node 的 buffer 上限。
  let bytes = 0;
  for (const name of names) {
    try { bytes += statSync(join(dir, name)).size; } catch { /* 单个文件读不到不影响下限意义 */ }
  }
  return {path: rel, exists: true, bytes, files: names,
    has_config: names.includes('config.json'), shards: weights.length};
}

/** 台账里的实测记录（第 5 步冒烟之后才有）。 */
export function probeLedger(root = ROOT) {
  const file = join(root, PATHS.ledger);
  if (!existsSync(file)) return {exists: false, path: PATHS.ledger};
  try {
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    return {exists: true, path: PATHS.ledger, lora: ledger.lora || null, base: ledger.base || null, status: ledger.status ?? null};
  } catch (error) {
    return {exists: true, path: PATHS.ledger, problems: [`台账不是合法 JSON：${String(error.message).slice(0, 80)}`]};
  }
}

/** 可用磁盘（字节）。取仓库所在卷。 */
export function probeDisk(root = ROOT) {
  try {
    const stats = statfsSync(root);
    return {free_bytes: Number(stats.bavail) * Number(stats.bsize),
      total_bytes: Number(stats.blocks) * Number(stats.bsize), volume: root};
  } catch (error) {
    return {free_bytes: null, why: String(error.message).slice(0, 120)};
  }
}

/** 一次性探测本机事实。纯只读。 */
export function probeEnvironment(root = ROOT) {
  return {
    platform: platform(),
    os_release: release(),
    macos: probeMacos(),
    cpu: cpus()?.[0]?.model || 'unknown',
    cores: cpus()?.length || 0,
    total_memory_bytes: totalmem(),
    node: process.version,
    disk: probeDisk(root),
    venv: probeVenv(root),
    weights: probeWeights(root),
    ledger: probeLedger(root),
  };
}

// ── 判定（纯函数，自检直接注入状态） ─────────────────────────────────────

/**
 * @param {object} probe  `probeEnvironment()` 的输出（自检时手工构造）
 * @param {object} options `{expectWeights, targets, requiredMlxLm}`
 * @returns `{verdict, findings, numbers}`
 */
export function evaluatePrereqs(probe, {
  expectWeights = false,
  targets = {adapter: PATHS.adapter, dataset: PATHS.dataset, work: PATHS.work, weights: PATHS.weights},
  requiredMlxLm = EXPECTED_MLX_LM,
} = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({level, code, message});

  // ① 平台
  if (probe.platform !== 'darwin') {
    add('block', 'platform', `平台是 ${probe.platform}：MLX 只在 Apple Silicon macOS 上有 GPU 后端，本指引不适用于这台机器。`);
  } else {
    const major = Number(String(probe.macos?.version || '').split('.')[0]);
    if (!Number.isFinite(major)) {
      add('warn', 'macos-unknown', '读不到 macOS 版本；本检查无法确认是否满足 MLX 的下限。');
    } else if (major < MIN_MACOS_MAJOR) {
      add('block', 'macos-too-old', `macOS ${probe.macos.version} 低于本检查的保守下限 ${MIN_MACOS_MAJOR}。`);
    } else {
      add('ok', 'macos', `macOS ${probe.macos.version}（build ${probe.macos.build ?? '未知'}）≥ 下限 ${MIN_MACOS_MAJOR}；芯片 ${probe.cpu}。`);
    }
  }

  // ② Node
  const nodeMajor = Number(String(probe.node || '').replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    add('block', 'node-too-old', `Node ${probe.node} 低于 ${MIN_NODE_MAJOR}；本套脚本用到 statfsSync / node:test。`);
  } else {
    add('ok', 'node', `Node ${probe.node}。`);
  }

  // ③ 运行时（.venv-mlx）
  const venv = probe.venv || {exists: false};
  if (!venv.exists) {
    add('block', 'venv-missing', '缺少 .venv-mlx：27B 的推理与 LoRA 都靠它。先跑 `bash scripts/model/setup-mac.sh --check-only`（只校验、不下载）。');
  } else if (venv.problems?.length) {
    for (const problem of venv.problems) add('block', 'venv-broken', `.venv-mlx 不完整：${problem}`);
  } else if (venv.mlx_lm !== requiredMlxLm) {
    add('warn', 'mlx-lm-version', `.venv-mlx 里是 mlx-lm ${venv.mlx_lm}，本仓库固定 ${requiredMlxLm}（models/registry.json 的 runtime.engine_version）。换版本可以有理由，但必须记进台账。`);
  } else {
    add('ok', 'venv', `.venv-mlx：Python ${venv.python}，mlx ${venv.mlx}，mlx-lm ${venv.mlx_lm}。`);
  }

  // ④ 磁盘
  const weightsBytes = SIZE.weights_gb * GB;
  const needBytes = weightsBytes + SIZE.min_free_disk_gb * GB;
  if (probe.disk?.free_bytes == null) {
    add('warn', 'disk-unknown', `读不到可用磁盘：${probe.disk?.why || '未知原因'}`);
  } else if (probe.disk.free_bytes < needBytes) {
    add('block', 'disk', `可用 ${(probe.disk.free_bytes / GB).toFixed(1)} GB < 需要 ${(needBytes / GB).toFixed(1)} GB`
      + `（权重估算 ${SIZE.weights_gb} GB + 余量 ${SIZE.min_free_disk_gb} GB）。`);
  } else {
    add('ok', 'disk', `可用 ${(probe.disk.free_bytes / GB).toFixed(1)} GB ≥ 需要 ${(needBytes / GB).toFixed(1)} GB（估算）。`);
  }

  // ⑤⑥ 内存：先看有没有实测峰值。**有实测就以实测为准**，估算区间降级成参考。
  // 反过来说：没有实测时，估算区间就是唯一依据，而它宽到无法给出 ready。
  const totalGib = probe.total_memory_bytes / GIB;
  const lowGib = gbToGib(MEMORY_PLANNING.low_gb);
  const highGib = gbToGib(MEMORY_PLANNING.high_gb);
  const measured = Number(probe.ledger?.lora?.smoke_peak_mem_gb);
  const hasMeasured = Number.isFinite(measured) && measured > 0;
  const numbers = {
    total_memory_gib: Number(totalGib.toFixed(1)),
    weights_gb_estimate: SIZE.weights_gb,
    peak_low_gb_estimate: MEMORY_PLANNING.low_gb,
    peak_high_gb_estimate: MEMORY_PLANNING.high_gb,
    peak_measured_gb: hasMeasured ? measured : null,
    peak_band_source: `估算区间：由 ${SIZE.anchor.model} 的实测峰值 ${SIZE.anchor.measured_peak_gb} GB `
      + `（权重 ${SIZE.anchor.weights_gb} GB）外推。固定开销读法 → ${MEMORY_PLANNING.low_gb} GB；`
      + `比例读法（${(SIZE.anchor.measured_peak_gb / SIZE.anchor.weights_gb).toFixed(2)}×）→ ${MEMORY_PLANNING.high_gb} GB。`
      + '**27B 本身没有任何实测**，所以这是估算区间，不是结论。',
  };

  if (hasMeasured) {
    // 实测已经把估算区间取代了：保留一条 info 说明「先验被后验替换」，便于读报告的人对上。
    add('info', 'memory-band-superseded',
      `已有实测峰值 ${measured} GB，第 ⑤ 档的估算区间（${MEMORY_PLANNING.low_gb}–${MEMORY_PLANNING.high_gb} GB）`
      + '不再参与判定，仅作参考：先验被后验替换。');
    const measuredGib = gbToGib(measured);
    const need = measuredGib * MEMORY_PLANNING.headroom_factor + MEMORY_PLANNING.headroom_absolute_gib;
    if (need > totalGib) {
      add('block', 'memory-measured-insufficient',
        `台账里的实测峰值 ${measured} GB（≈ ${measuredGib.toFixed(1)} GiB）× ${MEMORY_PLANNING.headroom_factor} `
        + `+ ${MEMORY_PLANNING.headroom_absolute_gib} GiB = ${need.toFixed(1)} GiB > 总内存 ${totalGib.toFixed(1)} GiB：余量不足，不许跑完整轮。`);
    } else {
      add('ok', 'memory-measured',
        `台账已记实测峰值 ${measured} GB（≈ ${measuredGib.toFixed(1)} GiB）；留出 ${MEMORY_PLANNING.headroom_factor}× + `
        + `${MEMORY_PLANNING.headroom_absolute_gib} GiB 后仍 ≤ ${totalGib.toFixed(1)} GiB。`);
    }
  } else if (totalGib < lowGib) {
    add('block', 'memory-below-low',
      `统一内存 ${totalGib.toFixed(1)} GiB 低于估算下界 ${lowGib.toFixed(1)} GiB（≈ ${MEMORY_PLANNING.low_gb} GB）：连最乐观的读法都装不下。`);
  } else if (totalGib < highGib) {
    add('must-measure', 'memory-band',
      `统一内存 ${totalGib.toFixed(1)} GiB 落在估算区间 ${lowGib.toFixed(1)}–${highGib.toFixed(1)} GiB 之内：`
      + `下界 ${MEMORY_PLANNING.low_gb} GB 能过，上界 ${MEMORY_PLANNING.high_gb} GB 过不去。`
      + '**必须先用 1—2 个 iteration 的冒烟量一次真实峰值**，再决定要不要跑完整轮。');
  } else {
    add('ok', 'memory-headroom',
      `统一内存 ${totalGib.toFixed(1)} GiB ≥ 估算上界 ${highGib.toFixed(1)} GiB（≈ ${MEMORY_PLANNING.high_gb} GB）：即使按比例读法也有余量。`);
  }

  if (!hasMeasured) {
    add('must-measure', 'no-measured-peak',
      '台账里没有 `lora.smoke_peak_mem_gb`：在拿到实测峰值之前，本检查**不会**给出 ready。'
      + '先做 `npm run train:plan -- --step lora` 里的 ① 冒烟。');
  }

  // ⑦ 权重
  const weights = probe.weights || {exists: false};
  if (!weights.exists) {
    add(expectWeights ? 'block' : 'info', 'weights-missing',
      `权重目录 ${PATHS.weights} 不存在。${expectWeights ? '（你用了 --expect-weights，所以这判红）' : '第 1 步本来就没下载，这不算失败。'}`);
  } else {
    const missing = ['config.json'].filter((name) => !weights.files?.includes(name));
    if (missing.length) {
      add('block', 'weights-incomplete', `${PATHS.weights} 存在但缺 ${missing.join('、')}：半个下载不能用来起服务。`);
    } else {
      add('ok', 'weights', `${PATHS.weights}：${weights.files.length} 个文件，${weights.shards} 个 safetensors 分片，`
        + `合计 ${(weights.bytes / GB).toFixed(2)} GB（若与估算 ${SIZE.weights_gb} GB 差别大，以实际为准并更新台账）。`);
    }
  }

  // ⑧ 受保护路径：27B 的产物不许落到 4B 的任何地方
  for (const [kind, target] of Object.entries(targets)) {
    try {
      assertNotProtectedPath(target);
    } catch (error) {
      add('block', `protected-${kind}`, error.message);
    }
  }

  if (probe.ledger?.problems) for (const problem of probe.ledger.problems) add('block', 'ledger-broken', problem);

  const verdict = findings.some((f) => f.level === 'block') ? 'blocked'
    : findings.some((f) => f.level === 'must-measure') ? 'must-measure' : 'ready';
  return {verdict, findings, numbers};
}

// ── 输出 ─────────────────────────────────────────────────────────────────

const ICON = {ok: '✔', info: '·', warn: '!', block: '✖', 'must-measure': '?'};

export function formatReport(probe, result) {
  const lines = [];
  lines.push('第 1 步 / 环境与磁盘前置检查（离线；不下载、不训练、不写文件）');
  lines.push('='.repeat(72));
  lines.push(`判定：${result.verdict}`);
  lines.push('');
  for (const finding of result.findings) {
    lines.push(`  ${ICON[finding.level] || '·'} [${finding.code}] ${finding.message}`);
  }
  lines.push('');
  lines.push('关键数字（每条都有出处或标注为估算）');
  lines.push('-'.repeat(72));
  lines.push(`  统一内存      ${result.numbers.total_memory_gib} GiB（${probe.total_memory_bytes} 字节，os.totalmem()）`);
  lines.push(`  权重估算      ${SIZE.weights_gb} GB —— ${SIZE.weights_source}`);
  lines.push(`  峰值估算区间  ${result.numbers.peak_low_gb_estimate}–${result.numbers.peak_high_gb_estimate} GB —— ${result.numbers.peak_band_source}`);
  lines.push(`  实测峰值      ${result.numbers.peak_measured_gb == null ? '尚未测量（台账 lora.smoke_peak_mem_gb 为空）' : `${result.numbers.peak_measured_gb} GB（来源：台账，用户冒烟实测）`}`);
  lines.push(`  4B 实测锚点   ${SIZE.anchor.model} 权重 ${SIZE.anchor.weights_gb} GB、训练峰值 ${SIZE.anchor.measured_peak_gb} GB`);
  lines.push(`                权重：${SIZE.anchor.weights_source}`);
  lines.push(`                峰值：${SIZE.anchor.peak_source}`);
  lines.push('');
  if (result.verdict === 'must-measure') {
    lines.push('下一步（判定为 must-measure 时唯一该做的事）：');
    lines.push(`  1) mkdir -p ${PATHS.work} && npm run train:prereqs -- --emit-ledger-template > ${PATHS.ledger}`);
    lines.push('  2) 按第 5 步的 ① 冒烟跑 1—2 个 iteration，只取 Peak mem');
    lines.push('  3) 把峰值抄进台账的 lora.smoke_peak_mem_gb，再跑一次本命令');
  } else if (result.verdict === 'ready') {
    lines.push('下一步：`npm run train:plan` 看当前整体进度。');
  } else {
    lines.push('下一步：先解决上面 ✖ 的项；本检查在它们解决前不会给 ready。');
  }
  return `${lines.join('\n')}\n`;
}

export function ledgerTemplate(probe, result) {
  return {
    schema: 'roco-27b-training-ledger/1',
    note: '本文件由**用户手工维护**。检查器只读它，不会替你写。字段缺失时留 null，不要用估算值填。',
    base: {
      repo_id: null,
      revision: null,
      license: null,
      license_source: null,
      downloaded_on: null,
      local_dir: PATHS.weights,
      total_bytes: probe.weights?.exists ? probe.weights.bytes : null,
      files_sha256: {},
    },
    env: {
      machine: probe.macos?.model ?? null,
      chip: probe.cpu,
      unified_memory_gib: result.numbers.total_memory_gib,
      macos: probe.macos?.version ?? null,
      node: probe.node,
      mlx: probe.venv?.mlx ?? null,
      mlx_lm: probe.venv?.mlx_lm ?? null,
      probed_on: null,
    },
    data: {dir: PATHS.dataset, split_mode: null, worlds_per_task: null, train_rows: null, dataset_report_sha256: null},
    lora: {
      config: null,
      smoke_peak_mem_gb: null,
      smoke_note: '① 冒烟（2 iters）打印的 Peak mem，**必须**是实测值',
      final_peak_mem_gb: null,
      hyperparams: {},
      change_log: [],
    },
    eval: {
      base_report: PATHS.baseEval,
      tuned_report: PATHS.sftEval,
      pass_rate: null,
      invalid_arguments: null,
      p50_ms: null,
      p95_ms: null,
      paired_vs_4b_v4: {regressed: null, fixed: null},
    },
    claims: {
      this_is: '工具路由（选哪个工具、参数对不对）',
      this_is_not: ['战斗策略模型', '价值模型', '胜率', '真人效果'],
    },
    status: 'in-progress',
    rollback: {stop_gateway: 'bash scripts/model/stop-mac.sh',
      retire_adapter: `把 ${PATHS.adapter} 改名或删除，并在此标 status=retired`},
  };
}

// ── 自检 ─────────────────────────────────────────────────────────────────

function baseProbe(overrides = {}) {
  const probe = {
    platform: 'darwin',
    os_release: '27.0.0',
    macos: {version: '27.0', build: '26A428', model: 'Mac17,9'},
    cpu: 'Apple M5 Pro',
    cores: 15,
    total_memory_bytes: 48 * GIB,
    node: 'v24.20.0',
    disk: {free_bytes: 688 * GIB, total_bytes: 926 * GIB, volume: ROOT},
    venv: {exists: true, path: '.venv-mlx', python: '3.12', mlx: '0.32.2', mlx_lm: '0.31.3', layout: 'lib/python3.12', problems: []},
    weights: {path: PATHS.weights, exists: false, bytes: 0, files: []},
    ledger: {exists: false, path: PATHS.ledger},
  };
  return {...probe, ...overrides};
}

export function selftest() {
  const cases = [
    {name: '反证 ①：权重缺失 + --expect-weights → blocked（不许报 ready）',
      probe: baseProbe(), options: {expectWeights: true}, expect: 'blocked', must_include: 'weights-missing'},
    {name: '反证 ②：只读得到 5 GB 可用磁盘 → blocked',
      probe: baseProbe({disk: {free_bytes: 5 * GB}}), options: {}, expect: 'blocked', must_include: 'disk'},
    {name: '反证 ③：没有 .venv-mlx → blocked',
      probe: baseProbe({venv: {exists: false, path: '.venv-mlx'}}), options: {}, expect: 'blocked', must_include: 'venv-missing'},
    {name: '反证 ④：适配器输出目录指到受保护的 4B v4 → blocked',
      probe: baseProbe(), options: {targets: {adapter: PATHS.fourBv4Adapter}}, expect: 'blocked', must_include: 'protected-adapter'},
    {name: '反证 ⑤：不是 Apple Silicon → blocked',
      probe: baseProbe({platform: 'linux', macos: {version: null}}), options: {}, expect: 'blocked', must_include: 'platform'},
    {name: '反证 ⑥：实测峰值 46 GB 装进 48 GiB 机器 → blocked（余量不足）',
      probe: baseProbe({ledger: {exists: true, lora: {smoke_peak_mem_gb: 46}}}), options: {}, expect: 'blocked',
      must_include: 'memory-measured-insufficient'},
    {name: '反证 ⑦：8 GiB 内存 → blocked（连估算下界都不到）',
      probe: baseProbe({total_memory_bytes: 8 * GIB}), options: {}, expect: 'blocked', must_include: 'memory-below-low'},
    {name: '主线 ①：本机 48 GiB、未下载、无实测峰值 → must-measure（**不是** ready）',
      probe: baseProbe(), options: {}, expect: 'must-measure', must_include: 'no-measured-peak',
      must_not_include: 'memory-measured'},
    {name: '主线 ②：已有实测峰值 30 GB 且余量够 → ready（估算区间被实测取代）',
      probe: baseProbe({
        weights: {path: PATHS.weights, exists: true, bytes: 15 * GB,
          files: ['config.json', 'model-00001-of-00002.safetensors'], shards: 1},
        ledger: {exists: true, lora: {smoke_peak_mem_gb: 30}}}),
      options: {expectWeights: true}, expect: 'ready', must_include: 'memory-measured',
      must_not_include: 'memory-band'},
    {name: '主线 ③：权重目录半拉（有目录没 config.json）→ blocked',
      probe: baseProbe({weights: {path: PATHS.weights, exists: true, bytes: 1 * GB, files: ['model.safetensors'], shards: 1}}),
      options: {expectWeights: true}, expect: 'blocked', must_include: 'weights-incomplete'},
  ];

  const results = [];
  for (const item of cases) {
    let result;
    try {
      result = evaluatePrereqs(item.probe, item.options);
    } catch (error) {
      results.push({name: item.name, passed: false, why: `抛错：${error.message}`});
      continue;
    }
    const codes = result.findings.map((f) => f.code);
    const ok = result.verdict === item.expect
      && codes.includes(item.must_include)
      && !(item.must_not_include && codes.includes(item.must_not_include));
    results.push({name: item.name, passed: ok,
      why: ok ? '' : `期望 verdict=${item.expect} 且出现 ${item.must_include}`
        + `${item.must_not_include ? `、不出现 ${item.must_not_include}` : ''}，`
        + `实际 verdict=${result.verdict}、codes=${codes.join(',')}`});
  }

  // 「脚本不许自己动手」这条也要有反证：含这些写法的源码必须被拒。
  //
  // 反证样本里的字面量同样要**拆开拼**：这段代码会被 `assertNoAutomation` 扫到，
  // 写全了就等于脚本自己违规——那正是这一整套检查要防的那种自欺。
  const guardCases = [
    {name: '反证 ⑧：assertNoAutomation 必须拒绝子进程源码',
      run: () => {
        try {
          assertNoAutomation(`import {execFileSync} from 'node:${frag('child', '_process')}';`, '反证样本');
          return false; // 没抛 = 检查器是空的
        } catch { return true; }
      }},
    {name: '反证 ⑨：assertNoAutomation 必须拒绝取数接口源码',
      run: () => {
        try {
          assertNoAutomation(`const r = await ${frag('fe', 'tch')}(url);`, '反证样本');
          return false;
        } catch { return true; }
      }},
    {name: '反证 ⑩：入口脚本写文件也必须被拒（产物只能由用户敲出来）',
      run: () => {
        try {
          assertNoAutomation(`import {${frag('write', 'File', 'Sync')}} from 'node:fs';`, '反证样本');
          return false;
        } catch { return true; }
      }},
    {name: '正向：本脚本与共享底座的源码都不含被禁止的写法',
      run: () => {
        assertNoAutomation(readFileSync(SELF_PATH, 'utf8'), 'check-27b-prereqs.mjs');
        assertNoAutomation(readFileSync(LIB_PATH, 'utf8'), 'training-steps.mjs');
        return true;
      }},
  ];
  for (const item of guardCases) {
    let passed = false; let why = '';
    try { passed = item.run(); } catch (error) { passed = false; why = error.message; }
    results.push({name: item.name, passed, why: passed ? '' : (why || '反证没被抓住')});
  }

  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    selftest: argv.includes('--selftest'),
    emitLedger: argv.includes('--emit-ledger-template'),
    expectWeights: argv.includes('--expect-weights'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const HELP = `27B 前置检查（只检查与解释；不下载、不训练、不写文件）

  --json                     机器可读输出
  --emit-ledger-template     打印台账骨架到 stdout（重定向由你自己做）
  --expect-weights           已经在下第 2 步时加：权重缺失判红
  --selftest                 构造状态断言判断正确，含必红反证
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
  const probe = probeEnvironment();
  const result = evaluatePrereqs(probe, {expectWeights: options.expectWeights});
  if (options.emitLedger) {
    process.stdout.write(`${JSON.stringify(ledgerTemplate(probe, result), null, 1)}\n`);
    return 0;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({verdict: result.verdict, findings: result.findings, numbers: result.numbers}, null, 1)}\n`);
  } else {
    process.stdout.write(formatReport(probe, result));
  }
  return result.verdict === 'blocked' ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[train:prereqs] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
