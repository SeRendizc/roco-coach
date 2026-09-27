# Mac 本地小模型：部署、角色与验收

日期：2026-09-21　设备：MacBook Pro Mac17,9 / Apple M5 Pro（15 核）/ 48 GB 统一内存

这份文档回答四个问题：**这台机器上装了什么、它负责什么、怎么证明它在工作、它现在还不能声称什么。**

## 1. preflight（先量，再下）

| 项 | 实测值 | 来源 |
|---|---|---|
| 芯片 / 核心 | Apple M5 Pro，15 核（5 Super + 10 Performance） | `system_profiler SPHardwareDataType` |
| 统一内存 | 48 GB | `sysctl hw.memsize` |
| 可用磁盘 | 694 GB（已用 206 GB / 926 GB） | `df -g /` |
| 现有 `.models/` | 723 MB（SmolLM2-135M、multilingual-MiniLM、deepseek tokenizer） | `find .models` |
| 现有 `.venv-agent` | Python **3.9.6** —— MLX 需要 3.10+，**不能复用** | `.venv-agent/bin/python -V` |
| 本机 mlx / llama.cpp / ollama | **都没有装** | `which` 全空 |
| `no_proxy` | 含 `[::1]`，httpx 解析会报 `Invalid port: ':1]'` | 第一次下载失败的原因 |

**结论**：另建 `.venv-mlx`（Python 3.12.14，`uv venv --python 3.12`），不动机器上原有的 `.venv-agent`；
下载前把 `no_proxy/NO_PROXY` 设成不含方括号 IPv6 的干净值。两条都写进了 `scripts/model/setup-mac.sh`。

## 2. 版本与许可证（一手来源，逐个核对）

用 Hugging Face API（`/api/models/<id>`）核对，**不是**凭记忆或二手描述：

| 模型 | 许可证 | revision（前 10） | 修改日期 | 结论 |
|---|---|---|---|---|
| `Qwen/Qwen3.5-4B` | apache-2.0 | — | 2026-03-02 | **主候选的底座** |
| `Qwen/Qwen3.5-9B` | apache-2.0 | — | 2026-03-02 | 备选，先不下载 |
| `Qwen/Qwen3.5-27B` | apache-2.0 | — | 2026-04-24 | teacher 候选 |
| `Qwen/Qwen3.8-27B` | apache-2.0 | `1d4bf0f2ff` | 2026-08-14 | teacher 候选 |
| `Qwen/Qwen3-4B-Instruct-2507` | apache-2.0 | `cdbee75f17` | 2025-09-17 | 同量级对照 |
| `mlx-community/Qwen3.5-4B-4bit` | apache-2.0 | `0e7ffd5c62` | 2026-03-02 | **实际下载的这一份** |
| `Qwen/Qwen3.8-2.4T-A95B(-FP8)` | apache-2.0 | — | — | **出界**：48 GB 装不下，不评估 |

交接文档里的 `Qwen3.8-27B` 与 `Qwen3.5-4B/9B` 都真实存在；`2.4T-A95B` 明确不评估。

## 3. 只下载一个主候选

```
mlx-community/Qwen3.5-4B-4bit   revision 0e7ffd5c62
量化 mlx-4bit（bits=4, group_size=64, affine）
2.9 GB（11 个文件），来源 apache-2.0
```

**不下载 9B / 27B**，理由写进 `models/registry.json` 的 `not_downloaded`：
9B 只在 4B 被证明容量不足时才上；27B 按角色分工只做离线 teacher，等评测说出「需要 teacher」再下。
不为展示而多拉 checkpoint。

### 3.1 运行时的选择：MLX，不是 Ollama

| 候选 | 决定 | 理由 |
|---|---|---|
| **MLX（mlx-lm 0.31.3）** | **采用** | Apple Silicon 原生，权重/KV/计算同处统一内存；官方有工具调用示例，工程接口能直接对齐本项目的工具契约；同一套权重后续可 `mlx_lm.lora` 做 LoRA，不需要第二套后端 |
| Ollama | 不用 | 它自建模型仓库与常驻调度，把版本、量化与超时口径从本项目手里拿走；本项目要求 manifest 可校验、超时可控、回退路径明确 |
| llama.cpp | 备用 | 只有在需要 GGUF 生态或跨平台一致性时才评估；本机全是 Apple Silicon，MLX 更直接 |

### 3.2 manifest 与可复现校验

`models/registry.json` 记录：model_id、revision、来源 URL、许可证与来源字段、量化参数、**逐文件 SHA256 + 字节数**、
设备与运行时、以及 `not_downloaded` 与 `forbidden` 两段。

```bash
node scripts/model/verify-manifest.mjs        # 通过：11/11 个文件
```

一个真实的坑：3.03 GB 的 `model.safetensors` 超过 Node `readFileSync` 的 2 GiB 上限
（`ERR_FS_FILE_TOO_LARGE`）。哈希必须流式做——这个错误只在**真的**校验大权重时才出现，
小文件测试永远发现不了。

## 4. 角色分工（谁在什么位置）

```
玩家话语 / 事件
   │
   ├─ 规则引擎 + planner ............. **唯一事实源**（面板值、伤害、合法动作、状态版本）
   │
   ├─ 本地 Qwen3.5-4B-4bit ........... 意图路由、工具选择、干预措辞、本地降级
   │                                   （局内，约 3 秒预算）
   │
   └─ DeepSeek API ................... 云端高质量解释与开放陪伴；本地失败时的兜底
```

- **本地模型不进入事实层。** 它只产出「一段文字」或「一次工具选择」；工具回执与 planner 才是事实。
- **27B 不进局内关键路径。** 按用户要求它只做离线 teacher / eval / 数据生成或慢速深度复盘；
  preflight 判断 15 GB 的 4bit 装得下，但没有证据说明现在需要它，所以**先不下载**。
- **DeepSeek 保留。** 本地模型不是替代关系；在拿到质量对照之前不声称可以替代。

## 5. 交付物与一键操作

| 动作 | 命令 |
|---|---|
| 建环境 + 补权重 + 校验（幂等） | `bash scripts/model/setup-mac.sh` |
| 只校验（断网可用） | `bash scripts/model/setup-mac.sh --check-only` |
| 启动常驻网关 | `bash scripts/model/start-mac.sh` |
| 健康检查（真跑一次生成） | `bash scripts/model/healthcheck-mac.sh` |
| 停止 | `bash scripts/model/stop-mac.sh` |
| 延迟/内存/合法率评测 | `node scripts/model/bench-local-model.mjs --runs 3` |
| 接进 Agent（默认关闭） | `ROCO_LOCAL_MODEL=shadow`（或 `on`） |

架构：`Node 网关（OpenAI-compatible :8766）→ 常驻 MLX 推理子进程（stdio JSONL）`。
网关实现 `/v1/chat/completions`、`/v1/models`、`/healthz`、`/metrics`；
**流式明确 501**（不假装支持），超时 **504**、忙 **429**、不可用 **503**。

失败语义（都有测试）：

| 情况 | 行为 |
|---|---|
| 超过预算 | `timeout`，回退 |
| 进程崩溃 | 在途请求**立刻**失败，不等各自的超时 |
| 客户端取消 | `AbortSignal` 生效，立刻释放并发名额 |
| 并发打满 | 快速 429，**不无限排队** |
| 上游 `ok=false` | 如实变成错误，不返回空字符串冒充成功 |
| 工具选择输出不是 JSON / 工具名不认识 | 一律 `{stop: true}` |

## 6. 实测（可复现）

单次探针（关闭 `enable_thinking`）：

```
首 token 1621 ms；总 1859 ms；22 token；11.8 tok/s；MLX 峰值 2.43 GB
```

固定提示集（`bench-local-model.mjs`，8 次调用，走网关）。**两次独立重跑**，
所以下面给的是「两次的区间」而不是一次的好看数字：

| 指标 | 第一次 | 第二次 | 说明 |
|---|---|---|---|
| 首 token p50 | 214.5 ms | 214.5 ms | 中位数稳定 |
| 首 token p95 | 318.1 ms | 271.9 ms | 尾部有抖动（±17%） |
| 总延迟 p50 | 362.9 ms | 366.3 ms | 稳定 |
| 总延迟 p95 | 470.5 ms | 439.5 ms | 稳定 |
| 吞吐 p50 | 29.8 tok/s | 32.9 tok/s | — |
| 峰值内存 | 2.51 GB | 2.51 GB | 一致 |
| **结构化合法率** | **1.0（8/8）** | **1.0（8/8）** | route 4/4、short 2/2、refuse 2/2 |

单次跑出来的数字**不能**当 SLA：两次之间首 token 的 p95 差了 17%。
真正稳定的结论是「p50 首 token 约 0.21 s、总延迟约 0.36 s」，以及合法率 8/8。

「合法率」是**程序判定**：能否解析出 JSON、工具名是否在允许集合内、
回答未核验事实时有没有给数字。它不是人工打分，也不是质量结论。

两条必须记住的 API 事实（都是跑出来才发现的）：

1. mlx-lm 0.31 的采样接口是 `sampler` 可调用对象，**不再接受** `temp=`；
2. 这个模型的 chat template **默认会先写一段 `<think>` 推理**，必须显式
   `enable_thinking=False` 才不写——这一步是它能不能进 3 秒预算的关键。

## 7. 现在**不能**声称什么

- **没有与 DeepSeek 的质量对照。** 需要 key 才能在同一提示集上双向比较；
  在此之前「本地模型可以替代云端」没有证据。
- **合法率 ≠ 说得好。** 8 条提示的程序判定只说明格式与边界没坏，
  不说明措辞像人、共情合适、不冒犯。那需要人工审阅或盲评（`docs/roco/` 的盲评计划）。
- **这些延迟是这台机器、这份权重、这几条提示上的数字。** 换机器、换量化、
  换提示长度都会变；不是产品 SLA。
- **27B teacher 未部署**，也不在局内路径上。
- **Windows 3060 未做**（按用户指令留到明天）。

## shadow 档的契约：跑本地，但**不改变玩家看到的结果**

第 38 轮修掉一个破坏这条契约的缺陷，记在这里免得再犯。

`createCoachServer` 的 `applyLocalModel` 原来**无论 `shadow` 还是 `on`** 都把
`wrapped.plan` 换成本地规划器。而 `src/coach/runtime.js` 正是用 `provider.plan`
决定**去查哪些工具**：

```js
if (useModel && provider.plan && (...)) { ... gatherAgentEvidence({plan: provider.plan, ...}) }
```

于是 shadow 档下「查什么」被本地模型改掉了：收集到的证据不同，最终正文就可能不同。
**shadow 的意义就是「先量，不改」**——这条契约在工具选择这一环上被破坏过。

现在的行为：

| 档位 | `generate`（正文） | `plan`（选工具） |
|---|---|---|
| `off` | 原样返回 base，本地进程一次都不启动 | 不接管 |
| `shadow` | 返回 base 的结果，另外跑一次本地并记 `shadow` | **不接管**：本地规划器照跑（记录在 `shadowPlans`），但返回的永远是 base 的决定；base 本来没有 `plan` 时也不凭空加 |
| `on` | 本地成功就用本地，失败回退 base 并记 `lastFallback` | 本地规划器接管 |

守在哪里：`tests/server.test.js` 的
「shadow 档不许改变玩家看到的结果」——它只做一件最硬的事：**同一条请求在 `off` 与
`shadow` 两档下各跑一次，正文 / provider / 路由 / 证据必须完全一致**，同时本地模型
必须真的被调用过（否则 shadow 没有可观测性）。

> 测试里用的是注入的假模型（`createCoachServer({localModelFactory})`）。**不要**在单测里
> 用真的 `LocalModel`：它会拉起 3 GB 的 MLX 子进程。第一次写这条测试时就是这么挂到
> 超时的，还留下了孤儿进程。

---

# 8. 2026-09-24 实测追加：4B **能不能用、有多好**（人类口径：「好像 4b 那个模型之前据称已经训练好了」）

> 完整数字、复算命令、原始产物位置：**`reports/roco/local-model/REPORT.md`**，
> 机器可读的那一份是 **`reports/roco/local-model/verdict.json`**（由
> `reports/roco/local-model/build-verdict.mjs` 从 `/tmp/roco-4b/**` 的原始产物算出，
> **没有一个数字是手写的**）。判据 `reports/roco/local-model/verdict.test.mjs` 已进 `npm run test:unit`。
> 本节只写结论与新出现的事实；§1–§7 的原结论一条没有删。

## 8.1 结论（先给能/不能）

**不能进请求路径。** 三个候选位置逐个说：

| 位置 | 判定 | 依据（都是本轮实测） |
|---|---|---|
| 首判 / 意图路由 | ❌ 没有证据 | 本轮量的是工具提议与正文；首判要自己的判据集 |
| 工具提议（`on` 档的 `plan` = `createLocalPlan`） | ❌ **现在不能用** | 生产提示下 **14/14 输出 `{"stop":true}`、0 次提议工具**（§8.4） |
| 正文改写（`on` 档的 `generate` = `wrapWithLocalModel`） | ❌ 现在不能用 | **45%（9/20）的正文被产品自己的守卫拒掉**（§8.5） |
| 离线降级 / 评测数据生成 / `shadow` 记录 | ✅ 可以 | 合法率≈1.000、零 API 成本、`off` 档零占用 |

「训练好了」这句话现在的准确表述是：**在它自己的训练分布上训好了；分布外没有证据**（§8.3）。

## 8.2 冒烟与延迟（实测，2026-09-24）

| 项 | 实测 |
|---|---|
| 加载 | 成功；`{"event":"ready","load_seconds":1.07,"peak_memory_gb":2.205}` |
| manifest | `verify-manifest.mjs` ✔ 11/11 |
| **冷启动（加载后第一条）** | **超出 3000 ms 预算**：网关侧 504；重启复测 wall **4067 ms** / TTFT **2799 ms**；`LocalModel` 直连口径 wall **4310 ms** / TTFT 2612 ms |
| 热态（空载，120 次真实规划提示） | 总延迟 p50/p95 **643.9 / 705.9 ms**；首 token **317.9 / 337.1 ms**；38.6 tok/s；峰值内存 **2.35 GB** |
| 热态（同机另有 2 个网关 + 1 个云端 run，828 次） | 总延迟 p50/p95 **754.8 / 1828.2 ms**（p95 抬高约 2.6×） |
| 输出合法性 | **120/120 = 1.000**（空载）；827/828（并发时 1 条超时） |

两条新事实：

1. **网关刚起来就进请求路径，第一条一定超时降级**（实测 4.0–4.3 s）。要进任何一段，必须**先预热**。
2. **同机并发会把 p95 从 0.71 s 抬到 1.83 s**。3000 ms 默认预算空载够用、并发下贴边。

## 8.3 ⚠️ 训练/评测重叠：**这套评测的窗口就是 SFT 的训练数据**（已证明）

- `reports/roco/sft/dataset-report.json`：`source_task_set: agent-tasks-v1`、`worlds_per_task: 9`、总数 1752。
- SFT 的目标就是 `expect.tool` + `expect.args_must_match` —— **`checkTask` 判对错用的就是这份期望**。
- 已证明 `worldsFor(task, 3)` ⊆ `worldsFor(task, 9)`：**288/288 个任务成立，0 个窗口落在 SFT 世界池之外**。

⇒ 「4B 通过率 0.9514」**不能读成能力**，只能读成分布内复现训练答案。按切分分侧：

| 侧 | 规则 baseline | **4B + SFT v4** | 4B 基座（无适配器） | DeepSeek |
|---|---|---|---|---|
| `train` | 1.000 | **0.9644** | 0.7635 | 0.7863 |
| `val`（留出模板「追问」） | 1.000 | **0.8750** | 0.6167 | 0.6167 |
| `test`（留出机制「轮次推进/拒绝」） | 1.000 | 1.000 | 1.000 | 1.000 |

**`test` 侧区分不出任何东西**：它只装了 `stale_state`（12 条）与 `silence`（3 条），
而这两类所有臂都 1.000。**仓里现在没有能测困难类别泛化的留出窗口** —— 想回答
「它是不是真的学会了」，必须新造留出集。

## 8.4 `createLocalPlan` 这条路是死的（14/14 全 stop），原因是**提示词不是训练时那一份**

同一批真实规划提示、预算 1200 ms：合法 JSON 14/14、超时 0、延迟 p50 313.6 / p95 988.3 ms，
但 **`{"stop":true}` 14/14、提议工具 0/14**（9 条本该查工具的题全部选择不查），
`lastDecision.reason` 全是 `model-stop`。

**对照实验**（同模型、同句提示、只换工具清单）：产品那份 8 个工具 vs `TOOL_CONTRACTS` 全 13 个
→ **两次都是 0/8 提议工具、8/8 stop**。所以不是工具清单的问题，是**提示词不同**：
`createLocalPlan` 的 system 只有工具**名字**，而适配器是在 `LOCAL_TOOL_SYSTEM`
（带每个工具一句话说明、带 `query_rules` 的 `kind` 枚举）上训的。

⇒ **适配器在 A 提示上训的，产品在 B 提示上用它。** 这是「工具提议」不能用、也是「训练白做了」
里最便宜的一条修复线索（本轮**没有改**生产提示 —— 改提示是行为变更，得配自己的验收）。

## 8.5 正文改写：45% 会被产品自己的守卫扔掉，而且**没有任何 system 提示**

提示来自产品自己的 runtime（`runCoach({provider: localProvider})` 的 `packet.text`，
正是 `on` 档喂给本地模型的那段），20 条，两条臂逐字节相同：

| 臂 | 被产品拒绝 | 原因 | 正文字数 均值/最大 | 单次耗时 均值 / >3 s 条数 |
|---|---|---|---|---|
| 规则模板（降级目标本身） | 0 | — | 23.6 / 84 | 0 |
| **4B + SFT v4** | **9/20 = 45%** | `too-long` 8、`ungrounded` 1 | **234.6 / 465** | **2039.9 ms / 8 条** |
| DeepSeek | 4/20 = 20% | `too-long` 3、`ungrounded` 1 | 132.5 / 450 | 1069.2 ms / 0 条 |

**为什么它会写成那样（已定位到逐字提示）**：`on` 档把 `packet.text` 当作**唯一**输入、
**没有 system**。真 tokenizer 渲染出来是：

```
<|im_start|>user
这一回合优先考虑「回复药 → 潮甲龟」。可比较的备选是「水流弹」。<|im_end|>
<|im_start|>assistant
<think>

</think>
```

模型**不知道自己是小芽**。于是按通用助手习惯作答：吐 417 字 markdown
（`### 1. 选项分析`），或者对模板正文「我在。」回「您好！您似乎只输入了"我在。"…」。
缺口在 `wrapWithLocalModel.runLocal`（`model.generate({prompt: text})`，无 system）。
**本轮没有改它。**

## 8.6 合法率不是区分度所在

| 臂 | 通过 / 总数 | 合法率（程序判定） |
|---|---|---|
| 规则 baseline（864 窗口） | 864/864 = 1.000 | — |
| 4B + SFT v4（864 窗口） | 822/864 = **0.9514** | 827/828 = 0.9988 |
| 4B 基座（432 窗口） | 326/432 = 0.7546 | 396/396 = **1.000** |
| DeepSeek（432 窗口） | 334/432 = 0.7731 | 396/396 = **1.000** |

三条模型臂的合法率都≈1.000（都能解析成 JSON、工具名都注册）。**差别全在参数装配。**
与规则 baseline 配对：规则 vs 4B+SFT v4 = **退化 42、扳回 0**（与 W4-02 §5.2 逐条复现）；
规则 vs 4B 基座 = 退化 106；**规则 vs DeepSeek = 退化 98、扳回 0**。

八类里六类三条臂都满分；信号只来自 `rules_lookup` 与 `roster_constraint`。
**云端臂也过不了规则 baseline** —— 做「4B 能不能替代云端」的判断之前，
先确认这套判据是不是在量真正重要的东西。

## 8.7 成本

本地 4B：**0 API token**，代价是常驻 ≈2.4 GB 统一内存 + §8.2 的延迟。
DeepSeek（本轮 396 次工具提议调用，真回执 `usage`）：输入 144,048
（缓存命中 36,608 / 未命中 107,440）+ 输出 8,020 = **152,068 tokens**；
按仓里已固化的公开价折算 **$0.0210（非高峰界）/ $0.0421（高峰界）**。

## 8.8 必须保留的 fail-closed（一条都不许去掉，全部实测）

1. `ROCO_LOCAL_MODEL` 默认 `off`；
2. 本地给不出合法输出 → `createLocalPlan` 一律 `{stop:true}`（解析失败 / 工具名不认识 /
   超时 / 不可用四条路径都实测走通），且原因留在 `lastDecision` —— **不许静默降级**；
3. `wrapWithLocalModel` 的 `fallback` 必填（构造时抛）；
4. 正文仍然过 `checkGroundedAnswer` / `checkReceiptConsistency`，被拒换 `packet.text` 并写
   `fallbackReason`（实测 9/20 确实走了这条）—— **不能因为「本地模型」而放宽**；
5. 冷启动要预热（§8.2）；并发上限 1 + 快速 429 保持。

---

## ⚠ 2026-09-26 复核更正（第 37 轮：4B 热态 n=64 + 网关自算口径）

只读代理实测（`/tmp/r7-bench/report.md`）与逐条对账（`/tmp/doc-repin/report.md`）。
上面 §6 那张表的旧值**保留不动**，这里写今天同口径重量的结果与一处**口径问题**。

| 量 | 文档旧值（n=8） | 2026-09-26 实测（n=64） | 说明 |
|---|---|---|---|
| 总延迟 p50 | 362.9 / 366.3 ms | **449.9 ms**（两次独立重跑 449.9 / 455.9） | 4 提示 × 8 轮 × 2 次，0 失败、合法率 64/64 |
| 总延迟 p90 / p95 / max | （只有 p95）470.5 / 439.5 ms | **573.4 / 576.9 / 578 ms** | —— |
| 首 token p50 / p95 | 214.5 ms | **245.1 / 256 ms** | —— |
| 峰值内存 | 2.51 GB | **4.067 GB**（网关带 adapter v3 自报） | 见下面三口径拆分 |
| 吞吐 | —— | 34.01 tok/s（prompt 54–87 token，输出 6–26 token） | —— |

**⚠ 口径问题（这一条比数字更重要）**：旧表的「p95」在 **n=8** 下**定义上就等于最大值** ——
`scripts/model/bench-local-model.mjs:107-112` 用最近秩取分位数，`floor(0.95×8)=7=n-1`。
所以「p95 从 470.5 涨到 576.9」**不是"p95 变慢了 23%"**，而是"**最大值**从 470.5（max-of-8）
变成 576.9（p95-of-64，max 578）"。同口径（最大值 vs 最大值）差 +23%；p50 差 +23.5%。
旧表由本文 §6 的「route 4/4、short 2/2、refuse 2/2」坐实就是 `--runs 2`（n=8）。
**本轮没有做空载 vs 负载对照**，所以"今天比 09-21 慢 23%"这个判断**没有证据**，不写进口径。

**峰值内存要拆成三个口径**（旧文把其中两个混着写）：
- **加载峰值 2.205 GB**（本文 §8.2 那条，2026-09-26 一字不差复现）—— 保持不变；
- **`LocalModel` 直连（无 adapter）2.341–2.484 GB**；
- **网关（带 adapter `qwen35-4b-tool-v3`）4.067 GB** —— 本轮实读，之前没有这个数。

**冷启动（分开报，不许混进 3 秒合同）**：`LocalModel` 直连口径 wall **3639 / 3805 ms**、TTFT 1765 / 1833 ms；
按**产品默认形状**（`packet.text` 85 字 + `max_tokens=256` + 3000 ms 预算）实测 **9/12 次超时降级**，
放宽预算那次显示模型一路写到 256 token 上限（引擎自报 4682 ms）。⇒ 「短解释 ≤500 ms」这条口径
只对**短输出**成立（48 token ⇒ 327 ms），对产品默认参数**不成立**。
