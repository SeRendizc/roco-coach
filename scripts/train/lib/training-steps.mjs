// 27B 用户亲训：**只检查与解释**那一半的共享底座。
//
// 这套 `scripts/train/*` 的边界（写给以后的自己和读代码的人）
// ------------------------------------------------------------
// 它们**不下载、不训练、不连接第二台机器**。它们能做的事只有两件：
//   ① 读本机已有的文件与系统信息，判断「现在处于第几步、上一步产物对不对」；
//   ② 把「这一步该敲哪条命令、成功长什么样、失败了怎么办」打印出来。
//
// 之所以要有一个共享底座，是因为「步骤表」同时被两个脚本读：
//   · `plan-27b-steps.mjs`      —— 按产物判断当前步，打印该敲的命令；
//   · `verify-training-artifacts.mjs` —— 按同一步骤表核对产物是否合格。
// 两份实现各写一遍步骤表，就一定会漂——那时「规划器说第 4 步」和
// 「校验器说第 3 步」同时成立，而没有任何检查会发现。
//
// 本模块**不许**起子进程、不许联网。`--selftest` 会扫自己的源码来证明这一点
// （见 `assertNoAutomation`）——所以下面所有被禁的字符串都**拆开拼**，
// 否则检查器会命中自己写的规则，自检永远红。

import {readFileSync, existsSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 scripts/train/lib/ 下）。 */
export const ROOT = resolve(HERE, '..', '..', '..');

export const GIB = 1024 ** 3;
export const GB = 1e9;

// ── 产物路径：**新目录**，与 4B 那一套完全不重叠 ─────────────────────────
//
// 用户与监工的共同要求：不要碰现有 4B v4 的任何产物。所以 27B 的每一个
// 落盘位置都是新名字：`sft-27b` 而不是 `sft`、`qwen38-27b-tool-v1` 而不是
// `qwen35-4b-tool-*`、`shadow-replay-27b-*.json` 而不是 `shadow-replay-sft-v4.json`。
export const PATHS = Object.freeze({
  // 27B 自己的一套（本次新增）
  weights: '.models/mlx/Qwen3.8-27B-4bit',
  dataset: 'reports/roco/sft-27b',
  adapter: '.models/adapters/qwen38-27b-tool-v1',
  work: 'reports/roco/train-27b',
  ledger: 'reports/roco/train-27b/ledger.json',
  baseEval: 'reports/roco/shadow-replay-27b-base.json',
  sftEval: 'reports/roco/shadow-replay-27b-tool-v1.json',
  // 只读的既有口径（**不写**）
  ruleArm: 'reports/roco/shadow-replay.json',
  tasks: 'tests/evals/agent-tasks-v1.jsonl',
  fourBv4Eval: 'reports/roco/shadow-replay-sft-v4.json',
  fourBv4Adapter: '.models/adapters/qwen35-4b-tool-v4',
  fourBv4Prereg: 'docs/roco/W4-04-SFT-PREREGISTRATION.md',
  fourBv4Log: 'reports/roco/sft/train-v4.log',
  registry: 'models/registry.json',
});

/**
 * **不许写**的路径：现有 4B v4 的产物与它的登记处。
 *
 * 用**逐段**前缀比较，不用字符串前缀：`reports/roco/sft-27b` 不能因为
 * 字符串上以 `reports/roco/sft` 开头就被判成受保护路径（那会把本次交付
 * 自己的数据集目录挡在门外）；反过来 `reports/roco/sft/train.jsonl`
 * 必须被判成受保护。
 */
export const PROTECTED_PATHS = Object.freeze([
  '.models/adapters/qwen35-4b-tool-v1',
  '.models/adapters/qwen35-4b-tool-v2',
  '.models/adapters/qwen35-4b-tool-v3',
  '.models/adapters/qwen35-4b-tool-v4',
  'reports/roco/sft',
  'reports/roco/shadow-replay-sft-v4.json',
  'models/registry.json',
  'docs/roco/W4-04-SFT-PREREGISTRATION.md',
]);

const segments = (path) => String(path).replace(/\\/g, '/').replace(/^\.\//, '').split('/')
  .filter((part) => part !== '' && part !== '.');

/** `child` 是否在 `parent` 之内（含相等）。逐段比较，避免 `sft` 命中 `sft-27b`。 */
export function isInside(child, parent) {
  const c = segments(child);
  const p = segments(parent);
  if (p.length > c.length) return false;
  return p.every((part, index) => part === c[index]);
}

/**
 * 抛错：**写目标落在受保护路径里**。
 *
 * 这道闸不是形式主义：把 27B 的适配器输出到 `qwen35-4b-tool-v4` 就会**覆盖**
 * 现有产物，而 4B v4 是当前唯一有完整产物支持的适配器（见
 * `docs/roco/W4-04-SFT-PREREGISTRATION.md`）。覆盖掉它，回滚就没有锚点了。
 */
export function assertNotProtectedPath(target, {protectedPaths = PROTECTED_PATHS} = {}) {
  for (const guard of protectedPaths) {
    if (isInside(target, guard)) {
      throw new Error(`拒绝：${target} 落在受保护路径 ${guard} 里。27B 的产物必须写到独立目录，`
        + '现有 4B v4 产物一个字节都不能动。');
    }
  }
  return true;
}

// ── 「不许自动开跑」的机器化判据 ─────────────────────────────────────────
//
// 一个检查器最糟的失败不是漏判，而是**它自己会动手**。所以这里把
// 「脚本能不能起进程 / 能不能上网 / 能不能写文件」变成会失败的正则检查，
// 而不是一句注释。**入口脚本**连写文件都不许：产物只能由用户敲命令产生，
// 否则「脚本只检查」这句话就没有约束力。
//
// 这些字面量必须**拆开拼**（`frag('write','File','Sync')`）：本文件自己
// 会被 `assertNoAutomation` 扫，写全了就会自证违规。
export const frag = (...parts) => parts.join('');

const FORBIDDEN_EVERYWHERE = [
  {re: new RegExp(frag('child', '_process')), why: '不得起子进程：那就能拉起训练或下载进程'},
  {re: /\bfetch\s*\(/, why: '不得调用取数接口：那就能联网下载权重'},
  {re: new RegExp(frag('node:(ht', 'tp|htt', 'ps|net)')), why: '不得引入网络模块：检查器必须能离线跑'},
];
const WRITE_APIS = [
  frag('write', 'File', 'Sync'), frag('append', 'File', 'Sync'),
  frag('write', 'File'), frag('append', 'File'), frag('create', 'Write', 'Stream'),
  frag('mkdir', 'Sync'), frag('rm', 'Sync'), frag('rmdir', 'Sync'),
  frag('unlink', 'Sync'), frag('copy', 'File', 'Sync'), frag('rename', 'Sync'),
];
const FORBIDDEN_IN_ENTRY = [
  {re: new RegExp(`\\b(${WRITE_APIS.join('|')})\\b`),
    why: '入口脚本不得写文件：产物必须由用户敲的命令产生，检查器只读'},
];

/**
 * 源码自查。`--selftest` 拿它扫自己的源码，并用一个**必然含违规**的字符串
 * 做反证——只做正向的检查器等于永远返回 true。
 */
export function assertNoAutomation(source, label = 'source', {allowWrites = false} = {}) {
  const rules = allowWrites ? FORBIDDEN_EVERYWHERE : [...FORBIDDEN_EVERYWHERE, ...FORBIDDEN_IN_ENTRY];
  for (const rule of rules) {
    const hit = source.match(rule.re);
    if (hit) throw new Error(`${label} 出现被禁止的写法「${hit[0]}」：${rule.why}`);
  }
  return true;
}

// ── 27B 的尺寸与内存口径：每条数字都要有出处或标注为估算 ─────────────────
//
// 这一节是整份交付里最容易说谎的地方，所以把**每一**个数的来源写在旁边，
// 并把两个读法各自的结论都摆出来，而不是挑一个好看的说。
export const SIZE = Object.freeze({
  weights_gb: 15,
  weights_source: '估算：`models/registry.json` → `not_downloaded` 里 '
    + '`mlx-community/Qwen3.8-27B-4bit` 的 why 写着「27B 4bit 约 15 GB」。'
    + '按 27e9 参数 × 4bit = 13.5 GB 裸权重 + 量化 scale/元数据，量级一致。'
    + '**下载后必须以实际字节数为准**，本仓库不为此背书。',
  min_free_disk_gb: 20,
  // 4B 的实测锚点，用来给 27B 一个「不是凭空猜」的区间。
  anchor: Object.freeze({
    model: 'Qwen3.5-4B-4bit',
    weights_gb: 3.03,
    weights_source: '`models/registry.json` 的 `download_bytes` 3,030,700,695 字节（实测校验过 SHA256）',
    measured_peak_gb: 16.113,
    peak_source: '`reports/roco/sft/train-v4.log`：900 iters 的 LoRA 训练里反复打印 '
      + '`Peak mem 16.113 GB`（末段 16.129 GB）。这是**实测**，不是估算。',
  }),
});

//: 由 4B 锚点推出的 27B 峰值区间。**两个读法都列出来**，因为哪一种对没有实测依据：
//:   · 固定开销读法：峰值 − 权重 = 13.08 GB 的固定开销（优化器/激活/全精度副本），
//:     27B ≈ 15 + 13.08 = 28.1 GB；
//:   · 比例读法：峰值/权重 = 5.32 倍，27B ≈ 15 × 5.32 = 79.8 GB。
//: 两者相差近三倍，所以本checker 在 48 GiB 机器上**不会**直接给 ready。
export const MEMORY_PLANNING = Object.freeze({
  overhead_gb: Number((SIZE.anchor.measured_peak_gb - SIZE.anchor.weights_gb).toFixed(2)),
  low_gb: Number((SIZE.weights_gb + (SIZE.anchor.measured_peak_gb - SIZE.anchor.weights_gb)).toFixed(1)),
  high_gb: Number((SIZE.weights_gb * (SIZE.anchor.measured_peak_gb / SIZE.anchor.weights_gb)).toFixed(1)),
  // 峰值 × 1.25 + 4 GiB ≤ 总内存 才算 ready（留出 macOS 与其它进程的余量）。
  headroom_factor: 1.25,
  headroom_absolute_gib: 4,
});

/** GB（十进制，mlx 打印口径）→ GiB（`os.totalmem()` 口径）。 */
export const gbToGib = (gb) => gb * GB / GIB;

// ── 七步表 ────────────────────────────────────────────────────────────────
//
// 字段与教学文档 `docs/roco/QWEN-27B-USER-RUN-GUIDE.md` 的小节一一对应。
// `commands` 是**给人敲的字符串**，脚本只会把它打印出来。
export const STEPS = Object.freeze([
  {
    id: 'env', index: 1,
    title: '环境与磁盘前置检查',
    purpose: '先确认这台机器装得下、跑得动，并且知道「跑得动」是根据什么判断的。',
    precheck: ['macOS 版本与芯片', '统一内存总量', '可用磁盘', 'Node 与 .venv-mlx 的 mlx-lm 版本'],
    commands: [
      {label: '一次跑完全部前置检查', cmd: 'npm run train:prereqs'},
      {label: '机器可读输出（写台账时抄这个）', cmd: 'npm run train:prereqs -- --json'},
      {label: '生成台账骨架（只打印，不写文件）', cmd: 'npm run train:prereqs -- --emit-ledger-template'},
    ],
    success: [
      '判定不是 blocked；退出码 0',
      '打印里出现「内存区间」与两个读法（固定开销 / 比例）',
      '明确写出：本机在**没有实测峰值**之前，判定只能是 must-measure，不是 ready',
    ],
    on_failure: [
      {symptom: '缺少 .venv-mlx', action: '先跑 `bash scripts/model/setup-mac.sh --check-only` 看缺什么（它不下载）'},
      {symptom: '磁盘不足', action: '腾出至少「权重估算 + 20 GB」，或换外置盘并改 PATHS 里的 weights'},
      {symptom: '判定 must-measure', action: '**这是正常的**。先做第 5 步的 1-iteration 冒烟，把实测峰值写进台账再回来'},
    ],
    artifacts: {dir: 'reports/roco/train-27b', files: ['ledger.json（由用户按骨架创建）']},
    rollback: '无需回滚：这一步不产生任何大文件。',
  },
  {
    id: 'download', index: 2,
    title: '下载基座权重（用户执行）',
    purpose: '把 4bit 量化权重取到本机，并把 revision / 许可 / 逐文件 sha256 记进台账。',
    precheck: ['第 1 步判定不是 blocked', '已确认磁盘余量', '已确认模型卡上的许可允许本地使用'],
    commands: [
      {label: '下载到独立目录（不要用 setup-mac.sh：它只认 models/registry.json 里登记的模型）',
        cmd: '.venv-mlx/bin/python -m huggingface_hub.commands.huggingface_cli download '
          + '<repo_id> --local-dir "' + PATHS.weights + '" --revision <rev>'},
      {label: '核对落盘文件与字节数', cmd: 'npm run train:verify-artifacts -- --step download'},
      {label: '记录逐文件 sha256（新模型，先算一次）', cmd: 'shasum -a 256 "' + PATHS.weights + '"/*.safetensors'},
    ],
    success: [
      '权重目录存在 config.json 与全部 safetensors 分片',
      '台账里有 repo_id / revision / license / 下载日期 / 总字节数',
      '`npm run train:verify-artifacts -- --step download` 没有红项',
    ],
    on_failure: [
      {symptom: '下载中断留下半个文件', action: '删掉该目录重下一次；半个 safetensors 会让加载期报出很难懂的形状错'},
      {symptom: '模型卡没有声明许可', action: '**停下**，把许可问题记进台账并问监工，不要先下载'},
    ],
    artifacts: {dir: PATHS.weights, files: ['config.json', '*.safetensors', 'tokenizer*.json']},
    rollback: '删掉 ' + PATHS.weights + ' 即可，不动仓库任何既有文件。',
  },
  {
    id: 'baseline', index: 3,
    title: '基座基准（同一把尺子）',
    purpose: '先量**没训过**的 27B 在本仓现有门禁上的表现，作为后面每一版 LoRA 的对照。',
    precheck: ['第 2 步产物通过校验', '网关没有被 4B 占着（先 stop）'],
    commands: [
      {label: '停掉任何在跑的网关', cmd: 'bash scripts/model/stop-mac.sh'},
      {label: '把网关指向 27B（**不改** 4B 的任何文件，只改本次进程的环境变量）',
        cmd: 'ROCO_LOCAL_MODEL_PATH="$PWD/' + PATHS.weights + '" bash scripts/model/start-mac.sh'},
      {label: '核对网关自报身份', cmd: 'curl -sS http://127.0.0.1:8766/healthz'},
      {label: '跑 288 条单世界门禁，写到自己那个名字上',
        cmd: 'node scripts/roco/shadow-replay.mjs --arm local_27b '
          + '--out ' + PATHS.baseEval + ' --compare ' + PATHS.ruleArm},
      {label: '停网关（换任何模型前都必须先停）', cmd: 'bash scripts/model/stop-mac.sh'},
    ],
    success: [
      '产物里的 identity.model 指向 ' + PATHS.weights + '，且 identity.adapter 为 null',
      'summary 里有 tasks / passed / pass_rate / latency.p50_ms / latency.p95_ms',
      '与规则臂的配对差异（comparison.regressed / fixed）被记下来',
    ],
    on_failure: [
      {symptom: '网关 180s 内没就绪', action: '看 reports/roco/local-model/gateway.log；27B 冷加载比 4B 慢很多，必要时调 ROCO_LOCAL_READY_TIMEOUT_MS'},
      {symptom: 'identity.model 还是 4B', action: '环境变量没生效——ROCO_LOCAL_MODEL_PATH 必须给绝对路径，且要在 start 之前在同一行里给'},
    ],
    artifacts: {dir: 'reports/roco', files: [PATHS.baseEval]},
    rollback: '删掉 ' + PATHS.baseEval + '；网关用 stop-mac.sh 停掉。',
  },
  {
    id: 'data', index: 4,
    title: '构造数据（复用既有口径）',
    purpose: '用**完全相同**的生成器与切分规则产出 27B 的训练数据，只是写到独立目录。',
    precheck: ['Python 3.9 可用（生成器要起 roco 规则服务）', '4B 的数据目录保持原样，不要复用'],
    commands: [
      {label: '先跑验证器的自检（证明它的判红方向真的抓得住）',
        cmd: 'node scripts/roco/verify-sft-split.mjs --selftest'},
      {label: '不写盘地看一遍口径与各种计数',
        cmd: 'ROCO_SFT_OUT="' + PATHS.dataset + '" node scripts/roco/build-agent-sft-data.mjs --check'},
      {label: '写入独立目录',
        cmd: 'ROCO_SFT_OUT="' + PATHS.dataset + '" node scripts/roco/build-agent-sft-data.mjs --write'},
      {label: '独立复核（重算对账 + 产物性质 + 反向对照）',
        cmd: 'ROCO_SFT_OUT="' + PATHS.dataset + '" node scripts/roco/verify-sft-split.mjs'},
    ],
    success: [
      '`dataset-report.json` 的 invariants 三项全 true',
      'train/valid/test 三份 jsonl 都在且非空',
      '`verify-sft-split.mjs` 的对账通过（它会把「报告说的」和「实际切的」逐项比）',
    ],
    on_failure: [
      {symptom: 'every_family_in_train 为 false', action: '说明某个家族在训练侧缺席（第 33 轮事故）。先看 split_mode，再决定是不是动切分'},
      {symptom: '对账报「产物与代码不一致」', action: '把 `--write` 重跑一遍；不要手改 jsonl'},
    ],
    artifacts: {dir: PATHS.dataset, files: ['train.jsonl', 'valid.jsonl', 'test.jsonl', 'dataset-report.json']},
    rollback: '删掉 ' + PATHS.dataset + ' 整个目录；它和 4B 的 ' + PROTECTED_PATHS[4] + ' 是两个目录。',
  },
  {
    id: 'lora', index: 5,
    title: 'LoRA（用户执行，「每次只改一个变量」）',
    purpose: '在 27B 上做教学式 LoRA，并把每一次尝试的配置与显存观测点记全。',
    precheck: ['第 4 步产物通过校验', '**先跑 1—2 个 iteration 冒烟**拿到实测峰值内存', '磁盘余量足够放 save_every 个中间 checkpoint'],
    commands: [
      {label: '① 冒烟：只跑 2 个 iter，只为拿 Peak mem（不要跳过这一步）',
        cmd: '.venv-mlx/bin/python -m mlx_lm.lora --model "' + PATHS.weights + '" '
          + '--data "' + PATHS.dataset + '" --train --fine-tune-type lora --num-layers 4 '
          + '--batch-size 1 --iters 2 --learning-rate 1e-5 --max-seq-length 512 '
          + '--mask-prompt --seed 20260921 --adapter-path "' + PATHS.adapter + '-smoke"'},
      {label: '② 把 ① 打印的 Peak mem 抄进台账的 lora.smoke_peak_mem_gb，再回来确认判定翻转',
        cmd: 'npm run train:prereqs    # 记入实测峰值后，判定应从 must-measure 变成 ready'},
      {label: '③ 正式训练：一次只改一个变量的起点配置',
        cmd: '.venv-mlx/bin/python -m mlx_lm.lora --model "' + PATHS.weights + '" '
          + '--data "' + PATHS.dataset + '" --train --fine-tune-type lora --num-layers 8 '
          + '--batch-size 1 --iters 900 --learning-rate 1e-5 --max-seq-length 768 '
          + '--mask-prompt --seed 20260921 --steps-per-report 150 --steps-per-eval 450 '
          + '--save-every 450 --val-batches 25 --adapter-path "' + PATHS.adapter + '"'},
      {label: '④ 核对适配器产物', cmd: 'npm run train:verify-artifacts -- --step lora'},
    ],
    success: [
      '日志里每一段都有 `Peak mem … GB`，且被抄进台账',
      'Val loss 在多个 eval 点上是下降的（不是只看最后一个数）',
      '适配器目录里有 adapter_config.json 与 adapters.safetensors',
      '`adapter_config.json` 的 `model` 指向 27B 权重、`data` 指向 ' + PATHS.dataset,
    ],
    on_failure: [
      {symptom: 'Peak mem 超过总内存的 ~80%', action: '**立刻停**。降 --num-layers 或 --max-seq-length，或改走更小的量化；不要靠 swap 硬撑'},
      {symptom: 'Val loss 不降或上升', action: '先查数据侧（是不是切分/目标写错），再调超参；每次只改一个变量'},
    ],
    artifacts: {dir: PATHS.adapter, files: ['adapter_config.json', 'adapters.safetensors', '0000XXX_adapters.safetensors']},
    rollback: '停掉训练进程；适配器目录改名或删除——它不在受保护路径里，删它不影响 4B。',
  },
  {
    id: 'eval', index: 6,
    title: '评测（同一把尺子，四件事分别报）',
    purpose: '用第 3 步完全相同的命令量 LoRA 版，并**分开**报通过率、非法参数率、延迟分位、与 4B v4 的逐任务配对差异。',
    precheck: ['第 5 步产物通过校验', '第 3 步的基座产物还在（要跟它配对）', '4B v4 的产物还在（要跟它配对）'],
    commands: [
      {label: '停掉旧网关', cmd: 'bash scripts/model/stop-mac.sh'},
      {label: '起 27B + 新适配器',
        cmd: 'ROCO_LOCAL_MODEL_PATH="$PWD/' + PATHS.weights + '" '
          + 'ROCO_LOCAL_ADAPTER="$PWD/' + PATHS.adapter + '" bash scripts/model/start-mac.sh'},
      {label: '核对身份（adapter_basename 必须是 qwen38-27b-tool-v1）',
        cmd: 'curl -sS http://127.0.0.1:8766/healthz'},
      {label: '对规则臂跑门禁',
        cmd: 'node scripts/roco/shadow-replay.mjs --arm local_27b --out ' + PATHS.sftEval
          + ' --compare ' + PATHS.ruleArm},
      {label: '停网关', cmd: 'bash scripts/model/stop-mac.sh'},
      {label: '四项分别核对（含与 4B v4 的逐任务配对）',
        cmd: 'npm run train:verify-artifacts -- --step eval --pair-against ' + PATHS.fourBv4Eval},
    ],
    success: [
      'report.identity.adapter_basename 与文件名里的版本号一致',
      '四项都在：pass_rate、非法参数条数、latency.p50_ms/p95_ms、配对 regressed/fixed',
      '配对差异与总数一起报（总数上升也可能同时有退化）',
    ],
    on_failure: [
      {symptom: 'identity.adapter 为 null', action: '网关没加载到适配器：ROCO_LOCAL_ADAPTER 要给绝对路径，且 start 之前要真的 stop 过'},
      {symptom: '只有总数没有配对', action: '补跑 `--compare`；没有配对的通过率不能用来支持「变好了」'},
    ],
    artifacts: {dir: 'reports/roco', files: [PATHS.sftEval]},
    rollback: '删掉 ' + PATHS.sftEval + '；适配器保留，评测可重跑。',
  },
  {
    id: 'record', index: 7,
    title: '记录与回滚',
    purpose: '把版本锚点、判据与结论写进台账，并确认撤回路径真的可用。',
    precheck: ['第 6 步四项数字齐全', '台账里每一步都有 revision/sha256'],
    commands: [
      {label: '核对台账与全部产物', cmd: 'npm run train:verify-artifacts -- --all'},
      {label: '确认回滚开关（默认 off，off 下不启动本地模型）', cmd: 'grep -n "ROCO_LOCAL_MODEL" src/coach/local-model.js'},
      {label: '回滚演练：停网关 + 移走适配器', cmd: 'bash scripts/model/stop-mac.sh'},
    ],
    success: [
      '台账含 repo_id / revision / license / 数据 sha256 / 超参 / 四项评测数字',
      '`npm run train:verify-artifacts -- --all` 无红项',
      '明确写出「本版是工具路由，不是战斗策略」，且通过率不被称为胜率',
    ],
    on_failure: [
      {symptom: '台账缺字段', action: '缺哪个补哪个；**不要**用估算值填空缺字段'},
      {symptom: '回滚后仍有 27B 进程', action: '`lsof -ti tcp:8766` 找残留进程再杀；PID 文件在 reports/roco/local-model/'},
    ],
    artifacts: {dir: PATHS.work, files: ['ledger.json', '*.log']},
    rollback: '台账里把该版本标 `status: retired` 并保留产物；不要删掉证据。',
  },
]);

/** 步骤 id → 第几步（1-based）。未知 id 返回 null。 */
export function stepById(id) {
  const step = STEPS.find((entry) => entry.id === id);
  return step || null;
}

// ── 评测报告的读法（**同一把尺子**的四件事） ─────────────────────────────
//
// `checkTask` 的违规字符串是判定器的唯一输出，四件事里有两件要从它推出来：
//   · 非法参数：违规里带「的参数里没有同时满足」（见 agent-trajectories.mjs）
//   · 通过率：summary.pass_rate
// 另外两件是 latency.p50_ms/p95_ms 与 comparison 的 regressed/fixed。
export const INVALID_ARGS_VIOLATION = '的参数里没有同时满足';

export function readEvalReport(report) {
  const summary = report?.summary || {};
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const invalidArgs = rows.filter((row) => (row.violations || [])
    .some((text) => String(text).includes(INVALID_ARGS_VIOLATION))).length;
  const comparison = report?.comparison || null;
  return {
    tasks: summary.tasks ?? rows.length,
    passed: summary.passed ?? null,
    pass_rate: summary.pass_rate ?? null,
    invalid_arguments: invalidArgs,
    invalid_arguments_source: '按行统计违规里含「' + INVALID_ARGS_VIOLATION + '」的条数',
    p50_ms: summary.latency?.p50_ms ?? null,
    p95_ms: summary.latency?.p95_ms ?? null,
    pairing: comparison ? {
      against: comparison.against ?? null,
      regressed: comparison.regressed ?? null,
      fixed: comparison.fixed ?? null,
      both_failed: comparison.both_failed ?? null,
    } : null,
  };
}

// ── io：真实文件系统 / 内存（给 --selftest 用） ───────────────────────────
export function fsIo(root = ROOT) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    readText: (rel) => readFileSync(join(root, rel), 'utf8'),
    readJson: (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')),
    //: 只取体积，不把大权重读进内存（4B 的 safetensors 就超过 Node 的 buffer 上限）。
    stat: (rel) => statSync(join(root, rel)),
  };
}

/**
 * 纯内存 io：`{path: text|object}`。`--selftest` 用它构造状态，不碰真磁盘。
 *
 * 值为 `undefined` 的键**当成不存在**：这样夹具可以用
 * `{...好夹具, [`${dir}/train.jsonl`]: undefined}` 从一份完整状态里删掉一个文件，
 * 而不必重写整份夹具。
 */
export function memoryIo(files = {}) {
  const table = new Map(Object.entries(files).filter(([, value]) => value !== undefined));
  return {
    // 目录不必在夹具里单列：只要它里面有文件，就算存在（与真磁盘一致）。
    exists: (rel) => table.has(rel) || [...table.keys()].some((key) => key.startsWith(`${rel}/`)),
    readText: (rel) => {
      if (!table.has(rel)) throw new Error(`memoryIo: 没有 ${rel}`);
      const value = table.get(rel);
      return typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
    },
    readJson: (rel) => {
      if (!table.has(rel)) throw new Error(`memoryIo: 没有 ${rel}`);
      const value = table.get(rel);
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
  };
}
