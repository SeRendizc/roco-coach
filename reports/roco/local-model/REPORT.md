# 本地 Qwen3.5-4B 实测：能不能用、有多好（2026-09-24）

人类口径：「好像 4b 那个模型之前据称已经训练好了，你可以测试一下，我不清楚我没自己测试过」。

这份报告把这句话变成**可复算的数字**。所有数字由
`reports/roco/local-model/build-verdict.mjs` 从 `/tmp/roco-4b/**` 的原始产物算出，
落成 `reports/roco/local-model/verdict.json`；**没有一个数字是手写的**。
`REPORT.md`（本文）与 `docs/roco/{LOCAL-MODEL.md,W4-02-MODEL-CANDIDATES.md}` 的追加段引用同一份产物。

---

## 0. 一句话结论

**权重在、能跑起来、「训练」也确实有效——但它的高通过率主要来自「评测窗口就是它的训练数据」，
而它接入产品的两条实际调用路径（工具提议、正文改写）现在都不能用：一条永远输出 `{"stop":true}`，
另一条有 45% 的正文会被产品自己的守卫扔掉。**

所以：**不能进请求路径**（既不进首判、也不进工具提议、也不进正文）。
唯一可以进的是**离线/评测用途**（候选数据、困难样本、shadow 记录）。
`off` 保持默认是对的；下面的 §7 给出要进任何一段之前必须先满足的条件。

---

## 1. 权重在哪、怎么加载

| 项 | 实测值 | 怎么得到的 |
|---|---|---|
| 基座权重目录 | `.models/mlx/Qwen3.5-4B-4bit/` | `ls` |
| `model.safetensors` | **3,034,300,695 B**，mtime **2026-09-21 05:57:09**，sha256 前 12 位 `5fb9acd02468` | `stat` / `shasum -a 256` |
| manifest | 有：`models/registry.json`（逐文件 SHA256 + 字节数 + revision `0e7ffd5c62` + apache-2.0） | `node scripts/model/verify-manifest.mjs` → **✔ 11/11 个文件** |
| **「训练好了」指的是 LoRA 适配器** | `.models/adapters/qwen35-4b-tool-v1 … v4`，每个 `adapters.safetensors` **16,247,908 B** | `ls -la` |
| v4（最新、也是已发布产物用的那份） | mtime **2026-09-21 09:37:42**，sha256 `362cc02087177eb5b61e185d324630aa8319408ebb2b64ff1c37c9c5bd9e33d6` | `shasum`；与 `tests/evals/agent-trajectories-model-v1.manifest.json` 记的 `adapter_sha256` **一致** |
| 训练配置 | `adapter_config.json`：lora、rank 8、scale 20、`num_layers 8`、iters 900、`max_seq_length 768`、`data: reports/roco/sft`、seed 20260921 | `cat .models/adapters/qwen35-4b-tool-v4/adapter_config.json` |

**加载方式：MLX，不是 llama.cpp / ollama / transformers。** 没有 GGUF，没有 ollama 仓库。

```
Node 网关（OpenAI 兼容 :PORT）
  └─ scripts/model/local-gateway.mjs
       └─ .venv-mlx/bin/python scripts/model/serve_mlx.py --model <权重> [--adapter <适配器>]
            └─ mlx_lm 0.31.3 / mlx 0.32.2（Python 3.12.14，uv 建的 .venv-mlx）
```

环境变量语义（`src/coach/local-model.js` 与 `scripts/model/local-gateway.mjs` 的一致读法）：

| 变量 | 语义 |
|---|---|
| `ROCO_LOCAL_MODEL` | `off`（默认）/ `shadow` / `on`；也接受 `1/true/yes` → `on`，`0/false/no/空/其它` → `off` |
| `ROCO_LOCAL_MODEL_PATH` | 权重目录，默认 `.models/mlx/Qwen3.5-4B-4bit` |
| `ROCO_LOCAL_ADAPTER` | LoRA 适配器目录；**不设就是基座**（这是「没训过的 4B」那一臂） |
| `ROCO_LOCAL_TIMEOUT_MS` | 单请求超时，默认 **3000**（网关侧） |
| `ROCO_LOCAL_MAX_CONCURRENCY` / `MAX_QUEUE` | 默认 1 / 4（打满快速 429） |
| `ROCO_LOCAL_PORT` | 网关端口，默认 8766 |

> 关于 `ROCO_LOCAL_MODEL_4B_PATH`：仓里**没有**这个名字，实际读的是 `ROCO_LOCAL_MODEL_PATH`；
> 面板 stat 用的 `ROCO_LOCAL_MODEL_27B_PATH` 同样只是展示字段，没有调用路径（27B 本轮未碰）。
> 大文件没有复制进仓；`.models/**` 本来就在工作区里。

---

## 2. 冒烟：真的跑起来了

逐字命令（本机同时有别的会话在跑自己的网关，所以**没有**用共享 pidfile 的
`start-mac.sh`，而是直接起网关类；这也避免了覆盖 `reports/roco/local-model/gateway.pid`）：

```bash
# ① 带 v4 适配器的私有网关（用仓里既有的类，没写第二套推理栈）
ROCO_LOCAL_ADAPTER="$PWD/.models/adapters/qwen35-4b-tool-v4" \
  node /tmp/roco-4b/launch-gateway.mjs 8799        # = LocalModelGateway + createGatewayServer

# ② 仓里的一键健康检查（manifest + 网关 + 真跑一次生成）
ROCO_LOCAL_PORT=8799 bash scripts/model/healthcheck-mac.sh
```

| 项 | 实测 |
|---|---|
| 模型加载 | **成功**。`{"event":"ready","load_seconds":1.07,"peak_memory_gb":2.205}` |
| manifest 校验 | **✔ 11/11** |
| 冷启动（加载后**第一个**请求） | **504 Gateway Timeout**（超过网关默认 3000 ms）。重启后复测：wall **4067 ms**、TTFT **2799 ms**、总 4053 ms |
| 冷启动（`LocalModel` 直连口径，另一条独立测量） | wall **4310 ms**、TTFT **2612 ms**、总 2636 ms → `cold_within_3s = false` |
| 热态（仓里 healthcheck 探针） | 首 token **286.5 ms**；总 **327.6 ms**；9.16 tok/s；峰值内存 **2.35 GB** |
| 热态（20 个真实规划提示，空载，p50/p95） | 总延迟 **643.9 / 705.9 ms**；首 token **317.9 / 337.1 ms**；38.6 tok/s |
| 输出是合法 JSON 吗 | 是，见 §3「合法率」：**120/120 = 1.000**（空载）/ 827/828（有并发时 1 条超时） |

**「冷启动超预算」不是小事**：`ROCO_LOCAL_TIMEOUT_MS` 默认 3000 ms，而加载后第一个请求需要
**≈2.6–2.8 s 首 token / 4.0–4.3 s 总时长**（MLX 首次编译 kernel）。也就是说
**网关刚起来就进请求路径，第一条一定会超时并降级**。要可用就必须预热（启动后先打一发），
或者把首条请求的预算单独放宽。

---

## 3. 对照实验设计（同一提示集、三条臂、同一把尺子）

用的全是仓里既有的设施，**没有新写推理栈、提示词、判定器或工具层**：

| 组成 | 来自哪里 |
|---|---|
| 提示（system） | `src/coach/shadow-tools.js` 的 `LOCAL_TOOL_SYSTEM`，digest `a5cb0fbcc53fbecd…`（被已发布产物钉住，本轮**一个字节没改**） |
| 任务集与世界 | `tests/evals/agent-tasks-v1.jsonl`（288 条）× `worldsFor(task, 3)` = **864 个窗口** |
| 世界构造 | `build-agent-trajectories.mjs` 导出的 `worldState` / `sourceConflictFor` / `versionAuthority` |
| 工具层与运行 | `agent-trajectories.mjs` 的 `runInput` / `runArm` / `finalAnswer` |
| 判定器 | `agent-trajectories.mjs` 的 `checkTask`（预注册判据，三条臂**同一个函数**） |
| 本地臂的 ask | `scripts/roco/local-model-ask.mjs` 的 `gatewayAsk`（仓里既有） |
| 云端臂的 ask | 本轮**新增**在同一个文件的 `deepseekAsk`（同一 URL / model / `thinking: disabled`，多返回真 `usage`） |

运行器是 `reports/roco/local-model/ab-arms.mjs`（放在本报告目录里；**不改**
`build-agent-trajectories.mjs`，因为它的模型臂 ask 写死成本地网关）。

三条臂：

| 臂 | 是什么 |
|---|---|
| `baseline` | 纯规则 planner（`ARMS.baseline`）——**模型必须超过的那条线** |
| `local_4b` | 基座 + **SFT v4 适配器**（「据称训好了」的那份） |
| `local_base` | **不带适配器的基座**（「没训过」的对照） |
| `cloud_deepseek` | `deepseek-flash`，与 4B **逐字节相同的 prompt**，`max_tokens 96`、`temperature 0` |

> 云端臂只在本轮新增的 `deepseekAsk` 里发请求；密钥从 macOS 钥匙串取
> （`security find-generic-password -s pet-coach-deepseek`，与 `scripts/start.sh` 同一处），
> **不进仓、不进 shell 历史**。

---

## 4. 数字（全部可复算）

### 4.1 工具提议：同一批窗口上的通过率

窗口数不同是因为云端调用要花钱：规则 vs SFT 跑**全量 864**，基座与云端跑
**分层抽样的 144 条任务 × 3 世界 = 432**（`CLOUD_SAMPLE`，抽样规则写死在 `ab-arms.mjs` 里，确定性）。

| 臂 | 通过 / 总数 | 通过率 | 合法率（程序判定） |
|---|---|---|---|
| 规则 baseline（864 窗口） | 864/864 | **1.000** | — |
| **4B + SFT v4**（864 窗口） | 822/864 | **0.9514** | 827/828 = **0.9988**（1 条超时） |
| 4B 基座（432 窗口） | 326/432 | **0.7546** | 396/396 = **1.000** |
| DeepSeek（432 窗口） | 334/432 | **0.7731** | 396/396 = **1.000** |

**合法率不是区分度所在**：三条模型臂都≈1.000 —— 输出都能解析成 JSON 对象、
工具名都在注册表里。差别全在**参数装配**。

按类别（通过率）：

| 类别 | 规则 baseline | 4B+SFT v4 | 4B 基座 | DeepSeek |
|---|---|---|---|---|
| `brief_explain` | 1.000 | 1.000 | 1.000 | 1.000 |
| `continue_stop` | 1.000 | 1.000 | 1.000 | 1.000 |
| `evidence_conflict` | 1.000 | 1.000 | 1.000 | 1.000 |
| `silence` | 1.000 | 1.000 | 1.000 | 1.000 |
| `stale_state` | 1.000 | 1.000 | 1.000 | 1.000 |
| `tool_failure` | 1.000 | 1.000 | 1.000 | 1.000 |
| `rules_lookup` | 1.000 | **0.9583** | 0.3889 | 0.5139 |
| `roster_constraint` | 1.000 | **0.5417** | 0.1389 | 0.1250 |

八类里**六类三条臂都满分**（那六类区分不出差别）；信号只来自 `rules_lookup` 与
`roster_constraint` —— 与 W4-02 §5.4 的判断一致。

### 4.2 与规则 baseline 逐条配对：退化 / 扳回

| 配对 | 共同窗口 | 都对 | **规则对、模型错（退化）** | **规则错、模型对（扳回）** | 都错 |
|---|---|---|---|---|---|
| 规则 vs **4B+SFT v4** | 864 | 822 | **42** | **0** | 0 |
| 规则 vs 4B 基座 | 432 | 326 | **106** | **0** | 0 |
| 规则 vs DeepSeek | 432 | 334 | **98** | **0** | 0 |

**SFT v4 的「退化 42、扳回 0」与 W4-02 §5.2 记录的 42/0 逐条复现**
（同一批 864 窗口、同一把尺子、同一份适配器 sha256）——这份数字是可复现的。

### 4.3 4B 与 DeepSeek 逐条对照（同样的 432 窗口）

| 配对 | 都对 | **4B 对、DeepSeek 错** | **4B 错、DeepSeek 对** | 都错 |
|---|---|---|---|---|
| 4B+SFT v4 vs DeepSeek | 333 | **65** | **1** | 33 |
| 4B 基座 vs DeepSeek | 323 | 3 | 11 | 95 |
| 4B+SFT v4 vs 4B 基座 | 323 | **75** | **3** | 31 |

读法必须小心（见 §5 的泄漏）：在这套任务集上 **SFT v4 明显强于 DeepSeek（65:1）**，
但这是因为**这套任务集的答案就是它的训练目标**，而 DeepSeek 从没见过。

### 4.4 SFT 到底训没训好：`train / val / test` 分侧

`scripts/roco/build-agent-sft-data.mjs` 的切分（`strict`）：留出**机制**「轮次推进 / 拒绝」到 test、
留出**模板**「追问」到 val。按 `sftSideOf` 给每个窗口打标签：

| 侧（任务数 / 窗口数） | 规则 baseline | **4B+SFT v4** | 4B 基座 | DeepSeek |
|---|---|---|---|---|
| `train`（225 / 675） | 675/675 = 1.000 | **651/675 = 0.9644** | 268/351 = 0.7635 | 276/351 = 0.7863 |
| `val`（48 / 144） | 144/144 = 1.000 | **126/144 = 0.8750** | 37/60 = 0.6167 | 37/60 = 0.6167 |
| `test`（15 / 45） | 45/45 = 1.000 | **45/45 = 1.000** | 21/21 = 1.000 | 21/21 = 1.000 |

两条必须直说的：

1. **`val` 侧 SFT 仍然赢**（0.875 vs 0.617）——说明适配器不是纯背答案，至少对留出模板有泛化。
2. **`test` 侧区分不出任何东西**：test 只装了 `stale_state`（12 条）与 `silence`（3 条）
   —— 这两类**所有臂都 1.000**。也就是说仓里现在**没有**任何能测「困难类别（`roster_constraint`
   / `rules_lookup`）泛化」的留出窗口。想回答「它是不是真的学会了」必须**新造**留出集。

### 4.5 ⚠️ 训练/评测重叠：已证明，不是推测

- `reports/roco/sft/dataset-report.json`：`source_task_set: agent-tasks-v1`、
  `worlds_per_task: 9`、总数 1752。
- SFT 的目标就是 `expect.tool` + `expect.args_must_match`，而 `checkTask` 判对错**用的正是这份期望**。
- `worldsFor(task, 3)` ⊆ `worldsFor(task, 9)`：**288/288 个任务成立，0 个窗口落在 SFT 世界池之外**
  （`worldsFor` 是确定性前缀选择）。

⇒ **本报告里 4B 的 864 个窗口，逐条都是它在 SFT 里见过的 prompt**（test 侧 45 条除外，
而那 45 条所有臂都满分）。所以 §4.1 的 0.9514 **不能读成能力**，只能读成
「分布内复现训练答案」。`docs/roco/W4-02-MODEL-CANDIDATES.md` 说「不声称这是模型能力的度量」，
本轮把这句话量成了数字。

### 4.6 延迟与内存

| 条件 | 样本 | 总延迟 p50 / p95 | 首 token p50 / p95 | tok/s p50 | 峰值内存 |
|---|---|---|---|---|---|
| 空载（40 任务 ×3 世界，只有这一个网关在跑） | 120 | **643.9 / 705.9 ms** | **317.9 / 337.1 ms** | 38.6 | 2.35–2.40 GB |
| 有并发（全量 864 窗口那一次，同机另有 2 个网关 + 1 个云端 run） | 828 | 754.8 / **1828.2 ms** | 498.9 / 719.7 ms | 13.9 | 3.37 GB |
| 冷启动（加载后第一条） | 2 次独立测量 | **4053 / 2636 ms** | **2799 / 2612 ms** | — | 2.34 GB |

**同机并发会把 p95 抬高约 2.6 倍**（706 ms → 1828 ms）。要拿它当 SLA，必须写明机器上还有谁在跑。
`ROCO_LOCAL_TIMEOUT_MS` 默认 3000 ms 在空载下够用（p95 0.71 s），在并发下已经贴边。

### 4.7 成本

| 侧 | 实测 |
|---|---|
| 本地 4B | **0 API token**；代价是常驻 ≈2.4 GB 统一内存 + 上面那张延迟表 |
| DeepSeek（本轮全部工具提议调用，真回执 `usage`） | 396 次请求：输入 **144,048**（其中缓存命中 **36,608**、未命中 **107,440**）+ 输出 **8,020** = **152,068** tokens |
| 折算（用仓里已固化的公开价，`scripts/eval-live-s04.js`，USD/1M） | **$0.0210**（非高峰界）/ **$0.0421**（高峰界） |

即：**这 432 个窗口的全量云端对照花了大约两到四分钱美元**。成本不是这里的约束；延迟与质量才是。

### 4.8 短解释（≤1 句）：产品自己会不会把这段正文扔掉

提示来自**产品自己的 runtime**：`runCoach({provider: localProvider})` 产出的 `packet.text`
——这正是 `on` 档 `wrapWithLocalModel` 喂给本地模型的那段（两条臂逐字节相同）。
判据跑之前钉死：J1 非空；J2 ≤180 可见字；J3 句末标点 ≤1（人类本轮口径）；J4 过产品自己的
`checkGroundedAnswer`。另外算一条**产品真正的接受规则**（`src/coach/runtime.js:141-143`：
`>360` 字 → `too-long`；否则回执不一致 → `receipt-inconsistent`；否则 `ungrounded`）。

| 臂 | J1–J4 全过 | **被产品拒绝** | 拒绝原因 | 正文字数（均值 / 最大） | 单次耗时（均值 / >3 s 的条数） |
|---|---|---|---|---|---|
| `rule_template`（就是那段模板本身） | 11/20 | 0（它就是降级目标） | — | 23.6 / 84 | 0 |
| **4B + SFT v4** | **0/20** | **9/20 = 45%** | `too-long` 8、`ungrounded` 1 | **234.6 / 465** | **2039.9 ms / 8 条** |
| DeepSeek | 4/20 | 4/20 = 20% | `too-long` 3、`ungrounded` 1 | 132.5 / 450 | 1069.2 ms / 0 条 |

**45% 的 4B 正文会被产品自己丢掉**（8 条超过 360 字硬上限、1 条编了未登记的数字），
被丢掉之后玩家看到的还是规则模板 —— 也就是说这段本地推理**白跑**，还多付了 3.6 秒。
J3（≤1 句）20/20 全不过，但**规则模板自己也 9/20 不过**，所以这条是「比现状更严」的口径，
不是产品现状。

**为什么它会写成那样（已定位到确切的提示）**：`on` 档把 `packet.text` 当作**唯一**输入，
**没有任何 system 提示**。用真 tokenizer 渲染出来的 prompt 逐字是：

```
<|im_start|>user
这一回合优先考虑「回复药 → 潮甲龟」。可比较的备选是「水流弹」。<|im_end|>
<|im_start|>assistant
<think>

</think>
```

模型**根本不知道自己是小芽**（没有 system turn、没有人设、没有「≤180 字」那句要求）。
于是它按通用助手的习惯作答：`mid-02` 那条吐了 417 字的 markdown（`### 1. 选项分析`、
`#### **选项 A：回复药 → 潮甲龟**`），`camp-04` 那条（模板正文是「我在。」）回的是
「您好！您似乎只输入了"我在。"…」。

`src/coach/local-model.js` 是所有本地调用点的**唯一**实现处，这条缺口就在
`wrapWithLocalModel.runLocal`（`model.generate({prompt: text})`，无 system）。
本轮**没有改它**：改生产提示是行为变更，得配自己的验收。

### 4.9 局内预算与 fail-closed（用产品自己的类，不是 HTTP 网关）

`ab-fail-closed.mjs` 直接 `new LocalModel(...)`，走
`createLocalPlan` / `wrapWithLocalModel` 这两条局内真正会跑的路径。

**（a）失败方向是对的**（都在 `src/coach/local-model.js` 里，实测）：

| 场景 | 实测 |
|---|---|
| python / 权重目录不存在 | `preflight()` 逐条说出缺什么；`start()` 以 `code:'preflight'` 拒绝，**不是静默** |
| 模型不可用时 `createLocalPlan` | 返回 `{stop:true}`，`lastDecision.reason='preflight'` |
| 模型不可用时 `wrapWithLocalModel(mode:'on')` | **不抛**，返回 base 的正文，`lastFallback.code='preflight'`，`stats={localUsed:0,localFailed:1}` |
| 空证据包 | 同样回退，`lastFallback.code='empty-packet'` |

**（b）`createLocalPlan` 这条路是死的（14/14 全 stop）**：

| 项 | 实测（14 个真实规划提示，预算 1200 ms） |
|---|---|
| 超时 | **0**；延迟 p50 **313.6 ms**、p95 **988.3 ms** |
| 合法 JSON | **14/14** |
| **输出 `{"stop":true}`** | **14/14** |
| 提出工具 | **0/14**（9 条本该查工具的题全部选择「不查」） |
| `lastDecision.reason` | 全部 `model-stop`（不是超时、不是解析失败、不是工具名不认识） |
| 与期望一致 | 5/14（就是那 5 条本来就该停的） |

**为什么**：我做了对照 —— 同一个模型、同一句提示、只换工具清单
（产品那份 8 个工具 vs `TOOL_CONTRACTS` 全 13 个），**两次都是 0/8 提议工具、8/8 stop**。
所以不是工具清单的问题，是**提示词不同**：`createLocalPlan` 的 system 只有工具**名字**、
没有一句话描述，而 SFT 训练用的是 `LOCAL_TOOL_SYSTEM`（带每个工具的一句话说明、
带 `query_rules` 的 `kind` 枚举）。

⇒ **适配器是在 A 提示上训的，产品在 B 提示上用它。** 这是「工具提议」这一段现在不能用的直接原因。

---

## 5. 结论：能不能进请求路径

**不能。** 三个候选位置逐个说：

| 位置 | 判定 | 依据 |
|---|---|---|
| **首判 / 意图路由** | ❌ 不进 | 没有独立证据：本轮量的都是工具提议与正文，首判需要自己的判据集；且下面两条已经堵住 |
| **工具提议（`createLocalPlan`，`on` 档的 `plan`）** | ❌ **现在不能用** | 生产提示下 **14/14 输出 `{"stop":true}`**，0 次提议工具（§4.9b）。它不会做错事，但**也不会做任何事** |
| **正文改写（`wrapWithLocalModel`，`on` 档的 `generate`）** | ❌ 现在不能用 | **45% 的正文被产品自己的守卫拒掉**（§4.8），且没有 system 提示（模型不知道自己是小芽）；被拒后玩家看到的还是模板，等于白跑 |
| **离线降级 / 评测数据生成 / shadow 记录** | ✅ **可以** | 合法率≈1.000、格式稳定、零 API 成本、`off` 档一个字节都不占；`shadow` 契约（跑本地但**不改玩家看到的结果**）已经有测试守着 |

### 必须保留的 fail-closed（一条都不许去掉）

1. **`ROCO_LOCAL_MODEL` 默认 `off`** —— 已实测：`off` 时 `wrapWithLocalModel` 原样返回 base。
2. **本地给不出合法输出 → 退回规则**：`createLocalPlan` 对「解析失败 / 工具名不在允许集合 /
   超时 / 不可用」一律 `{stop:true}`（实测 4 条路径都走通）。**不许静默降级**：
   失败必须留在 `lastDecision` / `lastFallback`，并带上 `code`。
3. **`wrapWithLocalModel` 的 `fallback` 必填**（构造时就抛）—— 没有降级路径不许构造。
4. **正文仍然过 `checkGroundedAnswer` / `checkReceiptConsistency`**，被拒就换 `packet.text`
   并写 `fallbackReason`（实测 9/20 确实走了这条）。这条**不能因为「本地模型」而放宽**。
5. **冷启动要预热**：加载后第一条实测 4.0–4.3 s > 3 s 预算 → 会降级。网关起来后先打一发探针。
6. **并发上限 1 + 快速 429** 保持；同机并发把 p95 从 0.71 s 抬到 1.83 s。

### 进任何一段之前必须先做到（本轮**没有做**，是建议不是结论）

1. **把 `createLocalPlan` 的 system 换成适配器训练时用的那一份**
   （`src/coach/shadow-tools.js` 的 `LOCAL_TOOL_SYSTEM`），或者用 `createLocalPlan` 的提示重训。
   这是最便宜、收益最直接的一条：现在这条路的通过率是 5/14（全靠「该停的停了」）。
2. **给正文改写加 system 提示**（人设 + ≤180 字 + 不许 markdown），否则 45% 的拒绝率不会降。
3. **新造一个真正有区分度的留出集**：现有 `test` 侧只有 `stale_state` + `silence`，
   所有臂都 1.000（§4.4）。要测泛化，留出必须覆盖 `roster_constraint` 与 `rules_lookup`。
4. **重新量 DeepSeek 的基线**：DeepSeek 在这套任务集上也是「退化 98、扳回 0」，
   说明**这套判据本身可能过严或过拟合规则臂**。在做「4B 能不能替代云端」的判断之前，
   先确认判据是不是在量真正重要的东西。

---

## 6. 没做到 / 不确定的（如实说）

1. **「它到底训没训好」这个问题，本报告只能给一个受限的答案。**
   - 能说的：SFT **确实改变了模型**（同一批 432 窗口：0.7546 → 0.9213；配对 75 扳回 / 3 退化），
     并且在**留出模板**的 `val` 侧也赢（0.875 vs 0.617）。
   - 不能说的：它在**困难类别**上的泛化。因为那些窗口就是训练数据（§4.5 已证明），
     而唯一的机制留出集（`test`）只装了所有臂都满分的两类。
   - 所以「训好了」这句话现在的准确表述是：**在它自己的训练分布上训好了；分布外没有证据**。
2. **短解释只有 20 条提示**，且其中若干条的模板正文本身就是退化回答
   （例如 `camp-04` 的 `packet.text` 是「我在。」）。所以 §4.8 的比例
   （45% / 20%）应读成「这 20 条上的比例」，不是总体比例。
3. **J3（≤1 句）是我按人类口径定的判据，产品没有这条要求**；规则模板自己 9/20 不过。
   不要把它当成「产品要求模型一句说完」。
4. **本轮没有跑 `scripts/eval-live-s04.js` 的 44 条预注册判据。** 原因：那 44 条走
   `POST /api/coach` 到 :8765 的**产品整链**（含会话、记忆、路由），量的是「云端整条链的质量」，
   而不是「同一提示集上 4B vs DeepSeek 的工具提议」，两者不可比。我用的是它的**判据设施**
   （同一个 `checkTask`、同一批任务集、同样预注册的办法），这条路是可复算的。
   想要那 44 条的数字，直接跑 `node scripts/eval-live-s04.js`（需要 :8765 上已配置 key）。
5. **同机并发污染过一轮测量**：第一遍短解释有 6/20 因网关排队超时（`AbortError`），
   已空载重测；报告里只采用重测那一份。全量 864 窗口那次的延迟是在
   「另有 2 个网关 + 1 个云端 run」的条件下测的，§4.6 把两种条件分开列了。
6. **重复性只查了 120 个窗口**（空载那次 vs 全量那次，逐条判定与工具调用**完全一致** 120/120）。
   没做全量重跑的字节级对拍 —— `temperature 0` 下应当一致，但没有量。
7. **没有改任何生产行为。** `src/coach/local-model.js` 本轮只读，没有落改动
   （§5 末尾那四条是建议）。`scripts/roco/local-model-ask.mjs` 新增了 `deepseekAsk`；
   `scripts/roco/agent-trajectories.mjs` 未改。
8. **27B 未碰**，`ROCO_LOCAL_MODEL_27B_PATH` 仍然只是面板 stat。
9. **`/tmp/roco-4b/` 是共享目录**：本机另一个会话也在写它（`SUMMARY.md`、`chat.json`、`gateway-v4.log`
   里 8791 的 EADDRINUSE 就是它）。本报告只用自己的前缀
   （`traj-*`、`smoke*`、`short-explain*`、`fail-closed*`、`plan-tools-control*`）。

---

## 7. 复算方法（逐字命令）

```bash
cd /Users/serendizc/Developer/roco-coach

# ① 起私有网关（带 v4 适配器；不覆盖共享 pidfile）
ROCO_LOCAL_ADAPTER="$PWD/.models/adapters/qwen35-4b-tool-v4" \
  node /tmp/roco-4b/launch-gateway.mjs 8799        # 见 §2 说明
ROCO_LOCAL_PORT=8799 bash scripts/model/healthcheck-mac.sh

# ② 全量 864 窗口：规则 baseline + 4B(SFT v4)
node reports/roco/local-model/ab-arms.mjs --arms baseline,local_4b \
  --gateway http://127.0.0.1:8799 --worlds 3 \
  --out /tmp/roco-4b/traj-sft-v4.jsonl --label sft-v4

# ③ 不带适配器的基座（另起一个网关在 8801，除 ROCO_LOCAL_ADAPTER 外参数相同）
( unset ROCO_LOCAL_ADAPTER; node /tmp/roco-4b/launch-gateway.mjs 8801 )
node reports/roco/local-model/ab-arms.mjs --arms local_base \
  --gateway http://127.0.0.1:8801 --cloud-sample --worlds 3 \
  --out /tmp/roco-4b/traj-base.jsonl --label base

# ④ 云端臂（144 条任务分层抽样 ×3 世界；需要真 key）
export DEEPSEEK_API_KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
node reports/roco/local-model/ab-arms.mjs --arms baseline,cloud_deepseek \
  --cloud-sample --worlds 3 --out /tmp/roco-4b/traj-cloud.jsonl --label cloud

# ⑤ 短解释 / 离线降级 / 局内预算
node reports/roco/local-model/ab-short-explain.mjs --gateway http://127.0.0.1:8799 \
  --out /tmp/roco-4b/short-explain-clean.jsonl
node reports/roco/local-model/ab-fail-closed.mjs \
  --adapter "$PWD/.models/adapters/qwen35-4b-tool-v4" --budget 1200 \
  --out /tmp/roco-4b/fail-closed.json

# ⑥ 汇总（生成 verdict.json，本文所有数字的来源）
node reports/roco/local-model/build-verdict.mjs
node --test reports/roco/local-model/verdict.test.mjs     # 判据：数字必须自洽
```

## 8. 产物位置

| 文件 | 内容 |
|---|---|
| `reports/roco/local-model/verdict.json` | **所有头条数字**（机器可读，由脚本从原始产物算出） |
| `reports/roco/local-model/REPORT.md` | 本文 |
| `reports/roco/local-model/{ab-arms,ab-short-explain,ab-fail-closed,summarize,leakage,build-verdict}.mjs` | 运行器与分析脚本 |
| `reports/roco/local-model/verdict.test.mjs` | 判据（自洽 + 与原始产物交叉核对，产物不在时跳过） |
| `/tmp/roco-4b/traj-sft-v4.jsonl` + `.receipts.jsonl` | 864 窗口 × 2 臂的轨迹 + 828 条 ask 原文 |
| `/tmp/roco-4b/traj-base.jsonl` + `.receipts.jsonl` | 基座 432 窗口 + 396 条 ask 原文 |
| `/tmp/roco-4b/traj-cloud.jsonl` + `.receipts.jsonl` | DeepSeek 432 窗口 + 396 条真回执（含 `usage`） |
| `/tmp/roco-4b/traj-clean-latency.jsonl` | 空载延迟样本 120 条 |
| `/tmp/roco-4b/short-explain-clean.jsonl` | 20 条短解释 × 3 臂 + 产品接受/拒绝判定 |
| `/tmp/roco-4b/fail-closed.json` | preflight / 冷启动 / 1200ms 预算 / 失败方向 |
| `/tmp/roco-4b/plan-tools-control.json` | 「提示 vs 工具清单」对照 |
| `/tmp/roco-4b/{run-*.log,receipts/smoke-healthcheck*.txt}` | 逐次运行的日志与健康检查原文 |

（`/tmp` 里的原始产物**不进仓**：它们是运行产物，且另一个会话也在用这个目录。）
