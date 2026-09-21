# Qwen3.8-27B 亲训操作手册（用户自己跑：下载 → 基准 → 数据 → LoRA → 评测）

> **这份文档只教你做，不替你做。** 配套的三个脚本**只检查和解释**：
> 它们不会下载任何权重、不会启动任何训练、不会写任何文件（自检会扫自己的源码证明这一点）。
> 每一步都得由你亲手敲命令。
>
> **本仓库当前状态：** 27B 一个字节都没下载，一次训练都没跑，**27B 的任何性能数字都不存在**。
> 本文里出现的 27B 尺寸/内存数字**全部标注为估算**，出处写在 §5 与 §10。

## 0. 七步总览与三个脚本

| # | 步骤 | 谁执行 | 主要产物 |
|---|---|---|---|
| 1 | 环境与磁盘前置检查 | 你敲 `npm run train:prereqs` | `reports/roco/train-27b/ledger.json`（台账） |
| 2 | 下载基座权重 | 你 | `.models/mlx/Qwen3.8-27B-4bit/` |
| 3 | 基座基准（同一把尺子） | 你 | `reports/roco/shadow-replay-27b-base.json` |
| 4 | 构造数据（复用既有口径） | 你 | `reports/roco/sft-27b/` |
| 5 | LoRA | 你 | `.models/adapters/qwen38-27b-tool-v1/` |
| 6 | 评测（四件事分别报） | 你 | `reports/roco/shadow-replay-27b-tool-v1.json` |
| 7 | 记录与回滚 | 你 | 台账 + 回滚演练 |

三个脚本（离线可跑、可独立运行）：

```bash
npm run train:prereqs                        # 第 1 步：环境/磁盘/依赖的判定与解释
npm run train:plan                           # 「现在处于第几步、该敲哪条命令」
npm run train:plan -- --dry-run              # 只打印七步命令清单（仍然不执行）
npm run train:plan -- --step lora            # 单看某一步的全部说明
npm run train:verify-artifacts               # 核对上一步的产物是不是真的合格
npm run train:verify-artifacts -- --step data
```

三个脚本都带 `--selftest`，实测输出贴在 §8。

**每一步的循环**：`train:plan` 看当前步 → 敲命令 → `train:verify-artifacts --step <刚做完的那步>` 核对。

**为什么「未开始」和「不合格」必须分开？**
检查器把「产物还不存在」当 `pending`（退出码 0），把「产物在但不自洽」当 `fail`（退出码 1）。
一个从第一天起就天天报红的检查器，三天后就没有人再看它了。

---

## 1. 环境与磁盘前置检查

### 目的
先确认这台机器装得下、跑得动 27B，并且**知道「跑得动」这个判断是根据什么下的**。
这一步不产生大文件，但它决定后面要不要开始下载 15 GB。

### 前置检查
- 一台 Apple Silicon Mac（MLX 的 GPU 后端只在 Apple Silicon macOS 上有）。
- 仓库里已经有 `.venv-mlx`（Python 3.12 + mlx-lm）。没有的话先跑 `bash scripts/model/setup-mac.sh --check-only`（**只校验、不下载**）。
- 至少「权重估算 + 20 GB」的可用磁盘。

### 用户要敲的命令

```bash
npm run train:prereqs                                          # 人读的判定
npm run train:prereqs -- --json                                # 机器可读（写台账时抄这个）
mkdir -p reports/roco/train-27b
npm run train:prereqs -- --emit-ledger-template > reports/roco/train-27b/ledger.json
npm run train:prereqs -- --expect-weights                       # 已经在下第 2 步时加这个开关
```

### 成功的样子
本机（Mac17,9 / M5 Pro / 48 GiB 统一内存）**当前的实测判定是 `must-measure`**。这是正确结果，不是失败
（下面是本机实跑输出的**节选**，省略号处是完整句子）：

```
判定：must-measure
  ✔ [macos] macOS 27.0（build 26A428）≥ 下限 14；芯片 Apple M5 Pro。
  ✔ [node] Node v24.20.0。
  ✔ [venv] .venv-mlx：Python 3.12，mlx 0.32.2，mlx-lm 0.31.3。
  ✔ [disk] 可用 738.7 GB ≥ 需要 35.0 GB（估算）。
  ? [memory-band] 统一内存 48.0 GiB 落在估算区间 26.2–74.3 GiB 之内 ...
  ? [no-measured-peak] 台账里没有 `lora.smoke_peak_mem_gb` ...
  · [weights-missing] 权重目录 .models/mlx/Qwen3.8-27B-4bit 不存在。（第 1 步本来就没下载，这不算失败。）
```

三档判定：

| 判定 | 含义 | 退出码 |
|---|---|---|
| `blocked` | 硬条件明确不满足（磁盘/依赖/路径冲突/平台不对） | 1 |
| `must-measure` | 硬条件都过了，但内存峰值**必须先量再定** | 0 |
| `ready` | 台账里**已经有实测峰值**，且留出余量后仍装得下 | 0 |

> **本机在没有实测峰值之前，检查器不会给出 `ready`。** 为什么是这个设计，见 §5。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| `venv-missing` | `bash scripts/model/setup-mac.sh --check-only` 看缺什么；它**不会**下载权重 |
| `disk` 判红 | 腾出至少「权重估算 15 GB + 20 GB」；或把权重换到外置盘并同步改 `scripts/train/lib/training-steps.mjs` 的 `PATHS.weights` |
| `protected-*` 判红 | 你把 27B 的某个输出目录写成了 4B 的目录。**停下来改路径**——现有 4B 产物一个字节都不能动 |
| `must-measure` | **这是正常的**。先做 §5 的「① 冒烟」，把实测峰值记进台账，再回来跑一次本命令 |

### 产物落在哪
`reports/roco/train-27b/ledger.json`（台账）。它由**你**按 `--emit-ledger-template` 打印的骨架创建；
检查器只读它，不替你写。**缺字段时留 `null`，不要用估算值填。**

---

## 2. 下载基座权重

### 目的
把 4bit 量化权重取到本机，并把 `repo_id` / `revision` / 许可 / 逐文件 sha256 记进台账。
没有版本锚点的权重，后面任何一次评测都无法复现。

### 前置检查
- §1 判定不是 `blocked`。
- **先确认模型卡上的许可允许你的用法**。许可不明就**不要**先下载，问清楚再动。
- 本仓库的 `models/registry.json` 里，这个模型登记在 `not_downloaded` 段，写成
  `mlx-community/Qwen3.8-27B-4bit`，并注明「27B 4bit 约 15 GB」。
  **那只是一个候选 id 与一个估算**：真正的 repo id、revision、文件清单、许可，
  以你在模型卡上看到的为准。本手册不替你确认它存在。

### 用户要敲的命令

```bash
# 下载到独立目录（**不要**用 scripts/model/setup-mac.sh：它只认 models/registry.json 里登记过的模型，
# 而 27B 被有意留在 not_downloaded 里，就是不想让任何脚本顺手把它拉下来）
.venv-mlx/bin/python -m huggingface_hub.commands.huggingface_cli download \
  <repo_id> --local-dir "$PWD/.models/mlx/Qwen3.8-27B-4bit" --revision <rev>

# 核对落盘文件、字节数与台账
npm run train:verify-artifacts -- --step download

# 逐文件 sha256（新模型先算一次，把结果抄进台账 base.files_sha256）
shasum -a 256 "$PWD/.models/mlx/Qwen3.8-27B-4bit"/*.safetensors

# 台账里必须补上：repo_id / revision / license / license_source / downloaded_on / total_bytes
```

### 成功的样子
- 权重目录里有 `config.json`、全部 `*.safetensors` 分片（分片索引点名的每一个都在盘上）。
- 台账里 `base.revision`、`base.license` 都不是空；`base.total_bytes` 与盘上权重分片字节数**一致**。
- `npm run train:verify-artifacts -- --step download` 没有 `✖` 项。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| 下载中断留下半个文件 | **删掉整个目录重下**。半个 safetensors 只会在加载期以形状错暴露，是最难查的一类错 |
| `base.total_bytes` 与盘上不一致 | 台账没更新，或换过权重。重新核对，不要改检查器 |
| 模型卡没有声明许可 | **停下**，把许可证问题记进台账并去问，不要先下载 |
| 下载被墙/太慢 | 那是你的网络问题，不是本仓库的路径问题；本手册不提供任何镜像或凭据 |

### 产物落在哪
`.models/mlx/Qwen3.8-27B-4bit/`（已在 `.gitignore` 里，**不入库**）+ 台账的 `base` 节。

---

## 3. 基座基准（同一把尺子）

### 目的
先量**没训过**的 27B 在本仓现有门禁上的表现。没有这一步，后面 LoRA 的分数就没有对照。

### 前置检查
- §2 产物通过 `--step download`。
- 网关没有被 4B 占着：**换任何模型之前必须先 `stop`**。第 37 轮的「成绩存档错位」事故，上游原因就是旧 `stop-mac.sh` 找的 PID 文件从来没被写过，于是「停」是空操作、下一个 arm 其实还在用上一个的权重。

### 用户要敲的命令

```bash
bash scripts/model/stop-mac.sh

# 只改**本次进程**的环境变量。4B 的任何文件都不动。
ROCO_LOCAL_MODEL_PATH="$PWD/.models/mlx/Qwen3.8-27B-4bit" bash scripts/model/start-mac.sh

curl -sS http://127.0.0.1:8766/healthz     # 记下它自报的 model / adapter

# 同一把尺子：288 条单世界门禁（tests/evals/agent-tasks-v1.jsonl，每任务 1 个世界）
node scripts/roco/shadow-replay.mjs --arm local_27b \
  --out reports/roco/shadow-replay-27b-base.json \
  --compare reports/roco/shadow-replay.json

bash scripts/model/stop-mac.sh
npm run train:verify-artifacts -- --step baseline
```

`ROCO_LOCAL_MODEL_PATH` 与 `ROCO_LOCAL_ADAPTER` 是 `scripts/model/local-gateway.mjs` 读的两个环境变量
（网关启动 MLX 子进程时用它们拼 `--model` / `--adapter`）。
**别把它和 `ROCO_LOCAL_MODEL` 搞混**：后者是 `src/coach/local-model.js` 里的**回滚开关**（默认 `off`），
W4-04 预注册 §2 的 P8 专门订正过这个命名混淆。

### 成功的样子
- 产物的 `identity.model` 指向 `.models/mlx/Qwen3.8-27B-4bit`，`identity.adapter` 为 `null`。
- `summary` 里有 `tasks` / `passed` / `pass_rate` / `latency.p50_ms` / `latency.p95_ms`。
- 与规则臂的配对差异（`comparison.regressed` / `comparison.fixed`）被记下来。
- `--step baseline` 没有 `✖`。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| 网关 180 s 内没就绪 | 看 `reports/roco/local-model/gateway.log`。27B 冷加载比 4B 慢很多，必要时调 `ROCO_LOCAL_READY_TIMEOUT_MS` |
| `identity.model` 还是 4B | 环境变量没生效。`ROCO_LOCAL_MODEL_PATH` 必须是**绝对路径**，且与 `start` 在同一行 |
| 想对比 4B | **不要**重跑 4B。用已有的 `reports/roco/shadow-replay-sft-v4.json` 做 `--compare`（§6） |

### 产物落在哪
`reports/roco/shadow-replay-27b-base.json`，日志在 `reports/roco/local-model/`。

### 哪些数字**不可比**（这一步就要想清楚）
1. **窄口径 ≠ 宽口径。** 本节用的是「每任务 1 个世界」的 288 个窗口；本仓库另有一套「每任务取满 9 个世界」的 1,752 窗口宽口径（见 `docs/roco/W4-02-MODEL-CANDIDATES.md` §5）。
   两套都真实，但**只有宽口径那一套可以拿来描述「模型在这套任务集上的整体能力」**，窄口径只能在声明了窗口集的前提下做 arm 之间的横向比较。
   `tests/evals/claim-honesty.test.js` 会扫 `docs/` 与 `reports/` 里的 markdown，把「拿窄口径数字当整体能力说」的句子判红。写报告时别踩。
2. **不同提示不可比。** 产物里的 `prompt_digest` 必须逐字节相同，否则逐任务配对没有意义。
   `npm run train:verify-artifacts -- --step eval` 会把两份产物的 `prompt_digest` 比一遍，不一致直接判红。
3. **`Peak mem` 不是 RSS。** mlx 打印的 `Peak mem` 是 MLX 分配器的峰值；`ps` 的 RSS、macOS 活动监视器的「内存」都是另一个口径。三者不要互相换算。
4. **通过率不是胜率。** 这里没有胜负，只有判据过没过。

---

## 4. 构造数据（复用既有口径）

### 目的
用**完全相同**的生成器与切分规则产出 27B 的训练数据，只是写到独立目录，
这样 4B 那一套 `reports/roco/sft/` 一个字节都不动。

### 前置检查
- Python 3.9 可用（生成器要起 roco 规则服务）。
- 确认你不会覆盖 4B 的数据：本次输出目录是 `reports/roco/sft-27b`，与 `reports/roco/sft` 是两个目录。

### 用户要敲的命令

```bash
# ① 先跑**验证器**的自检：证明它的判红方向真的抓得住（这一步很快，且不联网）
node scripts/roco/verify-sft-split.mjs --selftest

# ② 不写盘地看一遍口径与各种计数
ROCO_SFT_OUT="reports/roco/sft-27b" node scripts/roco/build-agent-sft-data.mjs --check

# ③ 写入独立目录
ROCO_SFT_OUT="reports/roco/sft-27b" node scripts/roco/build-agent-sft-data.mjs --write

# ④ 独立复核（重算对账 + 产物性质 + 反向对照）
ROCO_SFT_OUT="reports/roco/sft-27b" node scripts/roco/verify-sft-split.mjs

npm run train:verify-artifacts -- --step data
```

> **一处必须说清的细节：** `build-agent-sft-data.mjs` **没有** `--selftest`，它只有 `--check`（不写盘）
> 与 `--write`。带 `--selftest` 的是**验证器** `verify-sft-split.mjs`。
> 顺序是：验证器自检 → 生成器 `--check` → 生成器 `--write` → 验证器完整复核。

### 为什么「留出维度」是这一步的核心
切分**不沿用**任务集的 family 切分。这一条是被两次真事故逼出来的：

- 第 33 轮留出**家族** → `roster_constraint` 整类归零：那个家族在训练里一条都没有，
  模型根本没学「没有锁定伙伴时怎么办」。
- 第 34 轮留出**机制** → `阵容诊断` 24/24 只输出 `stop`。
- 现在的规则（`strict` 模式）：**每个家族都出现在训练侧**，只留出**机制**（`轮次推进` / `拒绝`）到 test 侧、
  留出表达模板（`追问`）到 val 侧；且每个**未留出**的机制在训练侧至少 2 条。

留出的必须是「该泛化的东西」，不能是「模型根本没学过的知识」。
`dataset-report.json` 的 `invariants` 三项就是这三条约束的机器判据：

| 字段 | 含义 |
|---|---|
| `every_family_in_train` | 每个家族都在训练侧（第 33 轮那条） |
| `no_designed_holdout_in_train` | 设计上要留出的机制/模板**没有泄漏**进训练侧 |
| `every_taught_mechanism_has_two_train_rows` | 被教的机制在训练侧至少 2 条（第 34 轮那条） |

> 注意 `test` 侧（51 条）的目标**全部**是 `{stop:true}`——留出的两个机制恰好都是「该停」的情形。
> 所以那一侧**不能**用来衡量工具选择能力。这一点由 `verify-sft-split.mjs` 的 `targets_by_side` 报出来。
> 完整口径与重复行统计见 `docs/roco/W4-04-SFT-PREREGISTRATION.md` §4 与 §6.4。

### 成功的样子
- `reports/roco/sft-27b/` 下有 `train.jsonl` / `valid.jsonl` / `test.jsonl` / `dataset-report.json`，三份 jsonl 非空。
- `invariants` 三项全 `true`。
- `verify-sft-split.mjs` 的「重算对账」通过（它按当前代码重算一遍切分，与盘上的 jsonl 逐项比）。
- `npm run train:verify-artifacts -- --step data` 没有 `✖`（它会自己重数行数，与报告里的计数对账）。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| `every_family_in_train` 为 `false` | 有家族在训练侧缺席 → 先看 `split_mode`，再决定改切分。**不要**靠手改 jsonl 蒙过去 |
| 对账报「产物与代码不一致」 | 重跑 `--write`。数据是**生成物**，任何时候都不要手改 |
| `--write` 之后 `verify-sft-split` 仍红 | 完整报错贴进台账；这属于代码与产物的契约问题 |

### 产物落在哪
`reports/roco/sft-27b/`（新目录）。台账的 `data` 节记 `dir` / `split_mode` / `worlds_per_task` / `train_rows` / 报告 sha256。

---

## 5. LoRA（**你**执行；每次只改一个变量）

### 目的
在 27B 上做教学式 LoRA（工具路由），并把每一次尝试的配置与内存观测点记全。

### 前置检查（先读这一节再动手）
**27B 的峰值内存没有实测来源。** 本仓库只有一个 4B 的实测锚点，把它外推会得到两个差近三倍的读法：

| 读法 | 算法 | 27B 峰值估算 |
|---|---|---|
| 固定开销 | 4B 实测峰值 16.113 GB − 4B 权重 3.03 GB = 13.08 GB 固定开销；27B ≈ 15 + 13.08 | **≈ 28.1 GB** |
| 比例 | 4B 峰值/权重 = 5.32×；27B ≈ 15 × 5.32 | **≈ 79.8 GB** |

出处：4B 权重 3,030,700,695 字节来自 `models/registry.json` 的 `download_bytes`（该文件逐文件校验过 SHA256）；
峰值 16.113 GB 来自 `reports/roco/sft/train-v4.log` 里 900 iters 训练时反复打印的 `Peak mem 16.113 GB`。
**这两个外推都是估算**，27B 本身一个数都没测过。

所以本机（48 GiB）落在 28.1–79.8 GB 这个区间**之内**：
下界能过、上界过不去。这就是为什么 `npm run train:prereqs` 在本机给的是 `must-measure`——**先量一次**。

顺带一条同样重要的前置：`--num-layers`、`--max-seq-length`、`--batch-size` 都会显著改变峰值。
冒烟时用最小的组合拿到峰值，再决定正式那一次能用多大。

### 用户要敲的命令

```bash
# ① 冒烟：只跑 2 个 iteration，**只为拿 Peak mem**。不要跳过这一步。
.venv-mlx/bin/python -m mlx_lm.lora \
  --model "$PWD/.models/mlx/Qwen3.8-27B-4bit" \
  --data "$PWD/reports/roco/sft-27b" \
  --train --fine-tune-type lora --num-layers 4 --batch-size 1 \
  --iters 2 --learning-rate 1e-5 --max-seq-length 512 --mask-prompt \
  --seed 20260921 --adapter-path "$PWD/.models/adapters/qwen38-27b-tool-v1-smoke"

# ② 把①打印的 Peak mem 抄进台账的 lora.smoke_peak_mem_gb，再确认判定翻转：
npm run train:prereqs          # must-measure → ready（或 → blocked，如果余量不够）

# ③ 正式训练：起点配置 = 4B v4 那一套（见下表），只是模型换成 27B
.venv-mlx/bin/python -m mlx_lm.lora \
  --model "$PWD/.models/mlx/Qwen3.8-27B-4bit" \
  --data "$PWD/reports/roco/sft-27b" \
  --train --fine-tune-type lora --num-layers 8 --batch-size 1 \
  --iters 900 --learning-rate 1e-5 --max-seq-length 768 --mask-prompt \
  --seed 20260921 --steps-per-report 150 --steps-per-eval 450 \
  --save-every 450 --val-batches 25 \
  --adapter-path "$PWD/.models/adapters/qwen38-27b-tool-v1"

# ④ 核对适配器产物
npm run train:verify-artifacts -- --step lora
```

**起点超参为什么是这些**：它们逐项来自现有 4B v4 适配器的 `adapter_config.json`
（`.models/adapters/qwen35-4b-tool-v4/adapter_config.json`，**只读**）：

| 超参 | 值 | 来源 |
|---|---|---|
| `fine_tune_type` | `lora` | 4B v4 `adapter_config.json` |
| `num_layers` | 8 | 同上 |
| `batch_size` | 1 | 同上 |
| `iters` | 900 | 同上 |
| `learning_rate` | 1e-5 | 同上 |
| `max_seq_length` | 768 | 同上 |
| `mask_prompt` | true | 同上 |
| `lora_parameters.rank` | 8 | 同上 |
| `seed` | 20260921 | 同上 |
| `save_every` / `steps_per_eval` / `val_batches` | 450 / 450 / 25 | 同上 |
| 4B v4 训练峰值内存 | 16.113 GB（实测） | `reports/roco/sft/train-v4.log` |
| 27B 的对应值 | **未测** | —— |

## 「每次只改一个变量」记录表

每跑完一次就补一行。**一次只改一个**，否则你无法把结果归因到任何一处。

| 轮次 | 日期 | num_layers | max_seq_length | iters | lr | rank | 冒烟峰值 (GB) | 训练峰值 (GB) | 最后 val loss | `invalid-arguments` | 备注（改了什么、为什么） |
|---|---|---|---|---|---|---|---|---|---|---|---|
| smoke | | 4 | 512 | 2 | 1e-5 | 8 | | —— | —— | —— | 只为量峰值 |
| r1 | | 8 | 768 | 900 | 1e-5 | 8 | | | | | 起点配置 |
| r2 | | | | | | | | | | | 只改一项…… |

### 显存/内存观测点
- **训练日志里的 `Peak mem … GB`**：mlx-lm 每一段 `steps-per-report` 都会打印，把它抄下来。
- 运行中另开一个终端看整体压力：`memory_pressure`、`vm_stat`、或活动监视器。**不要**用 `ps` 的 RSS 当「模型占用」。
- 判据：`实测峰值 × 1.25 + 4 GiB ≤ 总内存`。检查器用的就是这个式子。

### 成功的样子
- ① 打印出了 `Peak mem … GB`，且被抄进台账 `lora.smoke_peak_mem_gb`；
- ② `npm run train:prereqs` 的判定**从 `must-measure` 变成了别的**（`ready` 或 `blocked`）。
  还停在 `must-measure` 说明台账没填对；
- ③ 多个 eval 点的 Val loss 是下降的（不是只看最后一个数）；
- ④ 适配器目录里有 `adapter_config.json` 与 `adapters.safetensors`，
  且 `adapter_config.model` 指向 27B 权重、`adapter_config.data` 指向 `reports/roco/sft-27b`。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| 冒烟 `Peak mem` 超过总内存 ~80% | **立刻停。** 降 `--num-layers` 或 `--max-seq-length`，或换更小的量化。**不要靠 swap 硬撑**——那会把一次训练变成几小时 |
| Val loss 不降 / 上升 | 先查数据侧（切分、目标是否写错），再动超参。参考 `docs/roco/SHADOW-REPLAY.md` §5.4：历史上有一版适配器**比基座还差**，原因就在数据切分 |
| 训练中途被杀 | 看日志最后一段与 `memory_pressure`；`--save-every` 的中间 checkpoint 可以用来续，但续之前先想清楚「哪一步开始不对」 |
| 适配器目录被写到 4B 那儿 | 不可能：**脚本会先抛错**（受保护路径守卫），而且 `adapter_config.model` 必须指向 27B 才通过校验 |

### 产物落在哪
`.models/adapters/qwen38-27b-tool-v1/`（新目录，与 `qwen35-4b-tool-*` 不重叠），
中间 checkpoint 叫 `0000XXX_adapters.safetensors`，训练日志自己留一份到 `reports/roco/train-27b/`。

---

## 6. 评测（同一把尺子，**四件事必须分别报**）

### 目的
用与 §3 **完全相同**的命令量 LoRA 版，并且**分开**报四件事——只报一个总数是最容易骗自己的一种写法。

### 前置检查
- §5 产物通过 `--step lora`。
- §3 的基座产物还在（要跟它配对）。
- 4B v4 的产物 `reports/roco/shadow-replay-sft-v4.json` 还在（要跟它配对）。**只读，不改。**

### 用户要敲的命令

```bash
bash scripts/model/stop-mac.sh

ROCO_LOCAL_MODEL_PATH="$PWD/.models/mlx/Qwen3.8-27B-4bit" \
ROCO_LOCAL_ADAPTER="$PWD/.models/adapters/qwen38-27b-tool-v1" \
  bash scripts/model/start-mac.sh

curl -sS http://127.0.0.1:8766/healthz    # adapter_basename 必须是 qwen38-27b-tool-v1

node scripts/roco/shadow-replay.mjs --arm local_27b \
  --out reports/roco/shadow-replay-27b-tool-v1.json \
  --compare reports/roco/shadow-replay.json

bash scripts/model/stop-mac.sh

# 四项分别核对，并把与 4B v4 的逐任务配对**重算一遍**与报告对账
npm run train:verify-artifacts -- --step eval \
  --pair-against reports/roco/shadow-replay-sft-v4.json
```

### 必须分别报的四件事
| # | 指标 | 从产物哪里读 | 为什么单独报 |
|---|---|---|---|
| 1 | **通过率** | `summary.pass_rate` / `summary.passed` / `summary.tasks` | 唯一的总量指标，但它会把「这边修好 20 条、那边坏 20 条」盖住 |
| 2 | **非法参数率** | 逐行统计 `rows[].violations` 里含「的参数里没有同时满足」的条数 | 工具选对了但参数错，是完全不同的失败模式；4B 基座在这一点上退化最明显 |
| 3 | **延迟 p50 / p95** | `summary.latency.p50_ms` / `p95_ms` | 局内路径要在约 3 s 内出结果；这是可用性下限，不是性能目标 |
| 4 | **与 4B v4 的逐任务配对差异** | `comparison.regressed` / `fixed` / `both_failed`（以及 `--pair-against` 的重算） | 总数上升也可能同时有退化。配对差异必须与总数一起报 |

`--step eval` 会做四件额外的事，任何一件不成立就判红：
1. `identity.adapter_basename` 必须等于 `qwen38-27b-tool-v1`（挡第 37 轮那类「存档错位」）；
2. 两份产物的 `prompt_digest` 必须逐字节相同（否则不是同一把尺子）；
3. **逐任务配对差异按 `case_id` 重算一遍**，与报告里的 `comparison` 对账；
4. 台账里的四个数字必须与产物里能重算出来的**完全一致**。

### 成功的样子
- 四项齐全，且配对是**重算后仍与报告一致**的。
- `--step eval` 没有 `✖`。
- 报告里写的是「工具选择的判据通过率」，**不是胜率**。
- 泛化切片（`summary.by_split.family.held_out` 等）与总体一起报：288 条门禁**包含** train 侧的题，
  它不是留出评测（`docs/roco/W4-04-SFT-PREREGISTRATION.md` §4 已经写死了这条）。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| `identity.adapter` 为 `null` | 网关没加载到适配器：`ROCO_LOCAL_ADAPTER` 要给绝对路径，且 `start` 之前真的 `stop` 过 |
| `prompt_digest` 不一致 | 两次跑用的提示不是同一份。**不要**解释这个差异，先把它消掉 |
| 配对重算与报告不符 | 那说明报告不是这份产物跑出来的。整条链重跑，不要改报告 |
| 只有总数、没有配对 | 补 `--compare`。没有配对的通过率**不能**用来支持「变好了」 |

### 产物落在哪
`reports/roco/shadow-replay-27b-tool-v1.json`；日志留在 `reports/roco/train-27b/`。

> **一个已知的守卫空档（如实写出来）：** `tests/evals/roco/model-arm-identity.test.js` 只覆盖
> `shadow-replay-base.json` 与 `shadow-replay-sft-vN.json` 两种命名，我们的 `shadow-replay-27b-*.json`
> **不在它的覆盖里**。补上这个空档的就是 `npm run train:verify-artifacts -- --step eval`。

---

## 7. 记录与回滚

### 目的
把版本锚点、判据与结论写进台账，并确认撤回路径**真的可用**。

### 前置检查
- §6 四项数字齐全。
- 台账里每一步的 `revision` / sha256 都填了。

### 用户要敲的命令

```bash
npm run train:verify-artifacts -- --all            # 台账 + 全部产物一次核对
npm run train:plan                                 # 确认七步状态
grep -n "ROCO_LOCAL_MODEL" src/coach/local-model.js # 确认回滚开关默认 off
bash scripts/model/stop-mac.sh                      # 回滚演练：停网关
```

### 台账字段（`reports/roco/train-27b/ledger.json`）
| 节 | 必须有的字段 | 为什么 |
|---|---|---|
| `base` | `repo_id` / `revision` / `license` / `license_source` / `downloaded_on` / `total_bytes` / `files_sha256` | 版本锚点：没有它，任何一个分数都无法复现 |
| `env` | `machine` / `chip` / `unified_memory_gib` / `macos` / `node` / `mlx` / `mlx_lm` | 「在哪台机器、哪个运行时上量的」 |
| `data` | `dir` / `split_mode` / `worlds_per_task` / `train_rows` / `dataset_report_sha256` | 数据是可复现生成物，锚点在切分模式与 sha256 |
| `lora` | `smoke_peak_mem_gb` / `final_peak_mem_gb` / `hyperparams` / `change_log` | 内存实测 + 「每次只改一个变量」的证据 |
| `eval` | `pass_rate` / `invalid_arguments` / `p50_ms` / `p95_ms` / `paired_vs_4b_v4` | 四项分别报；配对差异必须与总数同框 |
| `claims` | `this_is` / `this_is_not` | 写明这份交付是什么、**不是**什么 |
| `status` | `in-progress` → `recorded` → `retired` | 「未开始」与「不合格」靠它区分 |

### 成功的样子
- `npm run train:verify-artifacts -- --all` 没有 `✖`。
- 台账里有 `claims.this_is_not`，且明确包含「战斗策略模型 / 价值模型 / 胜率 / 真人效果」这类否定。
- 回滚演练之后 `lsof -ti tcp:8766` 没有残留进程。

### 失败怎么办
| 症状 | 处置 |
|---|---|
| 台账缺字段 | 缺哪个补哪个。**不要**用估算值填空 |
| 回滚后仍有 27B 进程 | `lsof -ti tcp:8766` 找残留再杀；PID 文件在 `reports/roco/local-model/` |
| 发现某个数字对不上 | 把该版本在台账里标 `retired` 并**保留产物**，不要删证据 |

### 怎么撤回
1. `bash scripts/model/stop-mac.sh`（停网关，回到规则臂）；
2. 把 `.models/adapters/qwen38-27b-tool-v1/` 改名或删除——它不在受保护路径里，删它不影响 4B；
3. 台账里把该版本 `status` 改成 `retired`，保留全部产物与日志；
4. **不需要**碰 `ROCO_LOCAL_MODEL`（默认 `off`，页面走的仍然是规则臂）。

### 产物落在哪
`reports/roco/train-27b/ledger.json` 与同目录的日志。

---

## 8. 三个脚本的 `--selftest` 实测输出

下面是从仓库根目录实跑的原始输出（`node scripts/train/<脚本>.mjs --selftest`，退出码均为 0）。
每一条里带「反证」的都是**必红反证**：构造一个坏状态，断言检查器**必须**报出来。

### 8.1 `npm run train:prereqs -- --selftest`（14/14，退出码 0）

```
[selftest] 通过：反证 ①：权重缺失 + --expect-weights → blocked（不许报 ready）
[selftest] 通过：反证 ②：只读得到 5 GB 可用磁盘 → blocked
[selftest] 通过：反证 ③：没有 .venv-mlx → blocked
[selftest] 通过：反证 ④：适配器输出目录指到受保护的 4B v4 → blocked
[selftest] 通过：反证 ⑤：不是 Apple Silicon → blocked
[selftest] 通过：反证 ⑥：实测峰值 46 GB 装进 48 GiB 机器 → blocked（余量不足）
[selftest] 通过：反证 ⑦：8 GiB 内存 → blocked（连估算下界都不到）
[selftest] 通过：主线 ①：本机 48 GiB、未下载、无实测峰值 → must-measure（**不是** ready）
[selftest] 通过：主线 ②：已有实测峰值 30 GB 且余量够 → ready（估算区间被实测取代）
[selftest] 通过：主线 ③：权重目录半拉（有目录没 config.json）→ blocked
[selftest] 通过：反证 ⑧：assertNoAutomation 必须拒绝子进程源码
[selftest] 通过：反证 ⑨：assertNoAutomation 必须拒绝取数接口源码
[selftest] 通过：反证 ⑩：入口脚本写文件也必须被拒（产物只能由用户敲出来）
[selftest] 通过：正向：本脚本与共享底座的源码都不含被禁止的写法
[selftest] 14/14 条断言通过
```

### 8.2 `npm run train:plan -- --selftest`（21/21，退出码 0）

```
[selftest] 通过：主线 ①：空仓库 → 当前是第 1 步 env
[selftest] 通过：主线 ②：只有台账 → 当前是第 2 步 download
[selftest] 通过：主线 ③：台账 + 权重 → 当前是第 3 步 baseline
[selftest] 通过：主线 ④：+ 基座产物 → 当前是第 4 步 data
[selftest] 通过：主线 ⑤：+ 数据集 → 当前是第 5 步 lora
[selftest] 通过：主线 ⑥：+ 适配器 → 当前是第 6 步 eval
[selftest] 通过：主线 ⑦：+ 评测产物（台账还没标 recorded）→ 当前是第 7 步 record
[selftest] 通过：主线 ⑧：七步齐全 → all_done 且没有任何「存在但不合格」
[selftest] 通过：反证 ①：不变量声称全 true 但 train.jsonl 缺失 → data 判「存在但不合格」（不许算做完）
[selftest] 通过：反证 ②：基座产物的 identity.model 指向 4B → baseline 判不合格（不许算做完）
[selftest] 通过：反证 ③：基座产物里带着 adapter → baseline 判不合格
[selftest] 通过：反证 ④：适配器 config 的 model 指向 4B 权重 → lora 判不合格
[selftest] 通过：反证 ⑤：评测产物 identity.adapter 为 null（其实在量基座）→ eval 判不合格
[selftest] 通过：反证 ⑥：评测产物缺 p95（延迟分位没报全）→ eval 判不合格
[selftest] 通过：反证 ⑦：台账**标了 recorded** 却缺 eval.p95 → record 判不合格（不许算七步完成）
[selftest] 通过：反证 ⑧：台账不是合法 JSON → env 与 record 判不合格，而不是「还没做」
[selftest] 通过：反证 ⑨：把适配器输出指到受保护的 4B v4 → 必须抛错
[selftest] 通过：主线 ⑨：本交付自己的目标路径不被守卫误伤
[selftest] 通过：主线 ⑩：七步的命令全部是字符串数据（脚本没有执行路径）
[selftest] 通过：反证 ⑩：三种「脚本自己会动手」的写法都必须被抓住
[selftest] 通过：正向：本脚本与共享底座的源码都不含被禁止的写法
[selftest] 21/21 条断言通过
```

### 8.3 `npm run train:verify-artifacts -- --selftest`（16/16，退出码 0）

```
[selftest] 通过：主线 ①：完整产物 + sha256 + 配对重算 → 没有任何不合格
[selftest] 通过：主线 ②：空仓库 → 全部 pending、零 fail（未开始不得判红）
[selftest] 通过：反证 ①：jsonl 行数与报告计数不符 → data 判红
[selftest] 通过：反证 ②：不变量被改成 false（留出泄漏）→ data 判红
[selftest] 通过：反证 ③：adapter_config.model 指向 4B → lora 判红
[selftest] 通过：反证 ④：台账没有冒烟峰值 → lora 判红
[selftest] 通过：反证 ⑤：报告声称退化 0，逐任务重算是 1 → eval 判红（报告与产物不符）
[selftest] 通过：反证 ⑥：台账里的 p95 与产物不一致 → eval 判红
[selftest] 通过：反证 ⑦：评测产物 identity.adapter 为 null → eval 判红
[selftest] 通过：反证 ⑧：台账字节数与盘上不一致 → download 判红
[selftest] 通过：反证 ⑨：sha256 与台账不符 → download 判红
[selftest] 通过：反证 ⑩：与对照产物的 prompt_digest 不一致 → eval 判红（配对无意义）
[selftest] 通过：主线 ③：默认目标路径全部不在受保护路径里 → guard 合格
[selftest] 通过：反证 ⑪：把目标指到受保护的 4B v4 适配器 → 必须抛错
[selftest] 通过：反证 ⑫：三种「脚本自己会动手」的写法都必须被抓住
[selftest] 通过：正向：本脚本 / 共享底座 / 夹具库的源码都不含被禁止的写法
[selftest] 16/16 条断言通过
```

**这些反证各自意味着什么（各举一例）：**

| 反证 | 它挡住的错 |
|---|---|
| 「权重缺失 + `--expect-weights` → blocked」 | 一个永远返回 `ready` 的前置检查器 |
| 「台账里的实测峰值 46 GB 装进 48 GiB → blocked」 | 只比权重、不算余量，就会让人在 swap 上跑一天 |
| 「数据不变量声称全 true 但 `train.jsonl` 缺失 → 不合格」 | 只看报告、不看产物的空检查器 |
| 「报告声称退化 0、逐任务重算是 1 → eval 判红」 | 报告里的配对数字与产物不符（报告不是这份产物跑出来的） |
| 「`prompt_digest` 不一致 → eval 判红」 | 拿两份用不同提示跑出来的分数做「对比」 |
| 「入口脚本写文件也必须被拒」 | 检查器自己动手生成假产物，把「用户亲自跑」变成一句空话 |

---

## 9. 这份交付**不声称**什么

- **没有下载任何 27B 权重。** `.models/mlx/Qwen3.8-27B-4bit/` 在本仓库里不存在。
- **没有训练任何东西。** 三个脚本没有任何执行路径（自检扫源码证明它们连子进程都起不了、连文件都写不了）。
- **没有量过 27B 的任何性能。** 本文里 27B 的所有尺寸/内存数字都是估算；唯一的实测数字来自 4B。
- **没有碰 4B v4 的任何产物。** 受保护路径守卫会直接抛错；
  `reports/roco/sft-27b/`、`qwen38-27b-tool-v1`、`shadow-replay-27b-*.json` 都是新名字。
- **没有连接第二台机器（Windows 3060 Laptop）。** 见 `docs/roco/TRAINING-ROADMAP-4B-27B-VALUE.md`。
- **不声称 27B 会更好。** 本手册不预测任何提升幅度；4B v4 已经完成的**只是工具路由**，
  不是战斗策略模型，也不是价值模型。
- **不把通过率叫做胜率**，也不据此声称真人效果——任务集是构造的，局面由引擎按固定 seed 生成。

---

## 10. 数字来源表

| 数字 | 值 | 来源 / 性质 |
|---|---|---|
| 统一内存 | 48 GiB（51,539,607,552 字节） | **实测**：`node -e 'os.totalmem()'`，本机 |
| macOS 版本 | 27.0（build 26A428） | **实测**：`/System/Library/CoreServices/SystemVersion.plist` |
| 芯片 / 机型 | Apple M5 Pro / Mac17,9 | **实测**：`os.cpus()`；与 `models/registry.json` 的 `device` 段一致 |
| Node | v24.20.0 | **实测**：`node -v` |
| `.venv-mlx` 运行时 | Python 3.12、mlx 0.32.2、mlx-lm 0.31.3 | **实测**：`pyvenv.cfg` + site-packages 的 `*.dist-info` |
| 可用磁盘 | 738.7 GB（688 GiB） | **实测**：`statfsSync`，仓库所在卷 |
| 27B 权重尺寸 | ≈ 15 GB | **估算**：`models/registry.json` → `not_downloaded` 里「27B 4bit 约 15 GB」；与 27e9 × 4bit = 13.5 GB 的算术量级一致。下载后以实际字节数为准 |
| 4B 权重尺寸 | 3.03 GB（3,030,700,695 字节） | **实测**：`models/registry.json` 的 `download_bytes`（该清单逐文件校验过 SHA256） |
| 4B v4 LoRA 训练峰值内存 | 16.113 GB | **实测**：`reports/roco/sft/train-v4.log`（900 iters 训练里反复打印） |
| 27B 峰值内存 | **未测** | 估算区间 28.1–79.8 GB，由上面两个数用两种读法外推（见 §5） |
| 4B v4 超参 | r=8、8 层、900 iters、lr 1e-5、seq 768、batch 1、seed 20260921 | **实测**：`.models/adapters/qwen35-4b-tool-v4/adapter_config.json` |
| 评测尺子 | `tests/evals/agent-tasks-v1.jsonl` 的 288 条任务、每任务 1 个世界 | **既有口径**：`docs/roco/W4-04-SFT-PREREGISTRATION.md` §1 |
| 4B 各 arm 的门禁成绩 | 见文档 | **产物支持**：`reports/roco/shadow-replay-sft-v4.json` 等；本文**不复述**这些数字，避免口径被搬走 |
| 27B 在门禁上的成绩 | **不存在** | 本交付不产生、不预测 |
