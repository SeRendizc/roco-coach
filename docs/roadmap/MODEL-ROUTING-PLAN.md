# 三档模型分工与「3 秒出结果」预算（2026-09-25 规划）

> **人类口径（原话）**：「记得我们的规划是 **deepseek api + qwen3.5-4B + qwen3.8-27B**（这个还没训，我想自己实操），
> 你记得帮我规划一下怎么分配，然后就是尽可能**响应速度要快**，比如**配队时候评估阵容尽可能在 3s 左右出结果/建议**」。
>
> 本文只做**规划 + 现状盘点**，不执行任何训练、不发外网请求、不下载权重。所有结论都带仓内证据路径；
> 标注沿用仓内惯例：`[实测]` = 本仓真跑出来的数字或产物；`[文档]` = 仓内文档写的；`[人类]` = 人类口述；
> `[推断]` = 由前两者推出的工程判断（会写明推的是什么）。**读不出来的地方写「读不出来」。**

---

## 0. 一句话结论

三档不是「三个候选互相替代」，而是**三层职责 + 一条单向降级链**：

> **规则引擎**（唯一事实源，永远在场）→ **Qwen3.5-4B 本机**（局内 ~0.5s 档：意图路由 / 工具提议 / 短提示措辞 / 离线降级）
> → **DeepSeek API**（需要长上下文或更高质量的**解释/复盘**，2.5s 档，可缓存可放弃）
> → **Qwen3.8-27B**（**只离线**：teacher / 评测 / 数据生成 / 慢速深度复盘，**永不进 3 秒路径**）。

「配队评估 3 秒出结果」这条**今天就已经满足**（当前树真服务端到端 **11–15ms**，`[实测]` 主线程 2026-09-25），
所以真正要设计的是「**LLM 解释段**怎么在不拖垮 3 秒的前提下加上去」，而不是让 LLM 去算配队。

---

## 1. 现状盘点（逐条带证据）

### 1.1 三只模型的真实状态

| 档 | 状态 | 证据 |
|---|---|---|
| **DeepSeek API** | **可用且已实测打通**：默认模型 `deepseek-flash`；key 来自环境变量或 `/connect.html` 加密录入（进程内存，不落盘）。`POST /api/verify` 真调用回执 = `{configured:true,verified:true,provider:"deepseek",usage:{prompt_tokens:9,completion_tokens:2}}` | `src/server/index.js:176`（默认模型）、`:227`（env key，**命中即 `verified=true`，零网络**）、`:250`（`status()`）、`:256-262`（真调用 + 401/402/429 映射）、`:398-400`（`/api/verify`）、`[实测]` 本会话真调用 |
| **Qwen3.5-4B（本机）** | **已部署、有实测**：`mlx-community/Qwen3.5-4B-4bit`（4bit affine），跑在 `mlx-lm 0.31.3` + `.venv-mlx`，Mac17,9 / M5 Pro / 48GB 统一内存；常驻 MLX 子进程 + Node 网关（:8766，OpenAI 兼容）。**默认关闭**（`ROCO_LOCAL_MODEL=off`） | `models/registry.json`（模型/revision/逐文件 sha256/实测）、`src/coach/local-model.js:30-56`（路径与 flag）、`scripts/model/local-gateway.mjs:1-18`、`docs/roco/LOCAL-MODEL.md:89-114` |
| **Qwen3.8-27B** | **未下载、未训练**，且仓里**明确写了它不进局内关键路径**：`not_downloaded` 里的理由是「只做离线 teacher/eval/数据生成或慢速深度复盘，不进入约 3 秒的局内关键路径」。训练是**人类自己实操**（仓里只有规划器与前置检查，**明确不代跑**） | `models/registry.json` 的 `not_downloaded`、`docs/roco/LOCAL-MODEL.md:85-86`、`docs/roadmap/FLAGSHIP-V3-CHECKLIST.md:104`（「用户明确延后：…Qwen 27B 部署/微调」）、`scripts/train/plan-27b-steps.mjs:1-20`、`scripts/train/check-27b-prereqs.mjs:1-20` |

**4B 的实测延迟（决定它能不能进 3 秒）**`[实测]` —— `docs/roco/LOCAL-MODEL.md:127-138`，8 次调用 × 两次独立重跑：

| 指标 | 第一次 | 第二次 | 读法 |
|---|---|---|---|
| 首 token p50 / p95 | 214.5 / 318.1 ms | 214.5 / 271.9 ms | p95 抖动 ±17%，**不能当 SLA** |
| 总延迟 p50 / p95 | 362.9 / 470.5 ms | 366.3 / 439.5 ms | 稳定；**这就是「4B 档」的真实成本** |
| 吞吐 p50 | 29.8 tok/s | 32.9 tok/s | — |
| 峰值内存 | 2.51 GB | 2.51 GB | 与 27B 的 ~15GB 不同量级 |
| 结构化合法率 | **8/8** | **8/8** | 程序判定（JSON 可解析 + 工具名在集合内 + 未核验事实不给数字），**不是质量** |

**⚠ 2026-09-25 复核更正（主线程 + 4B 实测子代理，三次独立测量）**——上面那张表**只覆盖热态**，不能直接当预算，而且 §3 里给 4B 的「≤500ms」必须改写：
| 量（同一台机、`serve_mlx.py` + 网关 `:8766`、adapter `qwen35-4b-tool-v3`） | 实测 |
|---|---|
| **热态**首 token / 总延迟 | **286–324 ms / 328–711 ms**（连打同型请求） |
| **冷启动第一条** | **1844–4310 ms**（另一路量到 4067–4310ms）⇒ **>3s 会 504**，进请求路径前**必须先预热** |
| 网关端到端（冷，含预热） / 吞吐 | 1988.9 ms / 6.03 tok/s；热态 37.95 tok/s（CLI 直跑 85.74 tok/s） |
| 网关 p50 / p95（真服务计数） | **511.3 / 3661.6 ms**（`counters.requests=12, ok=12`） |
| 并发 | **max=1**（两个请求会互相拖慢，`src/coach/local-model.js:41-46`） |
**读法（改完之后）**：4B 的预算是 **p50 ≈ 0.5s**，**p95 已经吃掉整个 3 秒** ⇒ 它**只能做「判定 / 短措辞」**，**不许进阻塞首屏的路径**；页面首次打开会遇到**冷启动**，所以要么预热、要么把它放在**可选段**（拿不到就回落规则结论，`provider:'local-fallback'`）。
**质量边界（同日实测，别当卖点）**：生产提示下 **工具提议 14/14 全是 `{"stop":true}`、0/14 提议工具**；正文改写 **9/20 = 45% 被产品自己的守卫拒掉**；`local_4b`(v3 adapter) 在 **24 条 `rules_lookup` 困难样本上只过 1/24**（p50 415ms）——而老的「288 任务 268/288 = 0.9306」**是分布内复现**（那批窗口就是 SFT 训练数据，子代理已证明 `worldsFor(task,3) ⊆ worldsFor(task,9)` 288/288），**不是能力**。

### 1.2 调用点地图（谁在什么时候调模型）

| 入口 | 链路 | 模型？ | 证据 |
|---|---|---|---|
| `POST /api/coach` | 玩家对话/复盘/陪练（三角色） | ✅ 云臂；`applyLocalModel()` 可选包一层本地 | `src/server/index.js:402-424`（`plan` 调用 **160 max_tokens / 2500ms 超时**；`generate` **320 / 8000ms**）、`:191-224`（`applyLocalModel`）、`:419` |
| `POST /api/opponent` | 对手 agent 的决策 | ✅ 云臂，**独立链路**：无对话、无记忆、**故意不吃 `inflight` 串行闸门**（否则玩家一问教练对手就干等） | `src/server/index.js:425-432`、`src/server/opponent.js:22`（`OPPONENT_TIMEOUT_MS=4000`） |
| `GET /api/roco/workshop?stage=first\|full` | **配队评估**（RC-301→302→303→304→602） | ❌ **完全不调模型**：整条链是纯规则纯函数 | `src/server/roco-service.js:774-878`（`workshop*` 全是本地函数；全文件**没有** `runCoach` / `complete(` 调用）、`src/coach/team-serving.mjs:20-38` |
| `GET /api/roco/{status,roster,box}` | 只读数据 | ❌ | `src/server/index.js:358-380` |
| `GET /api/models` | 面板如实报**三只模型**状态 | ❌（只 `stat` 权重目录，**不 ping**，理由写在代码里：ping 会拉起一次推理几秒 + 占内存） | `src/server/index.js:232-247`（`localModelReport`）、`:287-291` |
| Agent 工具循环 | `gatherAgentEvidence` | ✅ 由 `provider.plan` 决定查哪些工具 | `src/coach/runtime.js:244-288` |

**本地模型怎么被接进去的**（关键设计，规划要沿用）：

- 单一调用点：`src/coach/local-model.js`（文件头写明「Agent 侧的**唯一**调用点」）。
- 三档 flag：`off`（默认）/ `shadow`（**跑本地但不改玩家看到的结果**）/ `on`（本地可用时用本地）。
- **shadow 契约的坑已经踩过并修好**：第 38 轮 `applyLocalModel` 在 shadow 档也把 `wrapped.plan` 换成本地规划器
  ⇒ 「查什么」被本地模型改了。现在只有 `on` 档才接管工具选择，shadow 只记录 `shadowPlans`。
  `[实测]` `src/server/index.js:191-224`、`docs/roco/LOCAL-MODEL.md:160-176`。
- 超时/并发：`DEFAULT_TIMEOUT_MS=3000`、`DEFAULT_MAX_TOKENS=256`、`DEFAULT_MAX_CONCURRENCY=1`
  （理由：单机统一内存，两个 4B 并发会互相拖慢）`[实测]` `src/coach/local-model.js:41-46`。

### 1.3 已有的模型评测资产（这是「能规划」的前提）

| 资产 | 现状 | 证据 |
|---|---|---|
| 轨迹臂 `ARMS` | 8 个臂：`replay` / `baseline`（规则）/ `stubborn`·`stop_now`·`no_rules`·`drop_args`（反证）/ `blind` / **`local_4b`（唯一的模型臂）** | `scripts/roco/agent-trajectories.mjs:673-691` |
| 模型臂的硬纪律 | **没有注入 `ask` 就抛**（不许安静退化成规则臂）；每次运行工具预算默认 **3**（与 `gatherAgentEvidence` 一致） | 同上 `:704-714`、`:693-696` |
| 臂成绩（288 任务，同一把尺子） | 4B 基座（无适配器）**225/288 = 78.13%**；`local_4b` **268/288 = 93.06%**；**`sft-v4` 275/288 = 95.49%** | `[实测]` `reports/roco/shadow-replay-{base,local_4b,sft-v4}.json` |
| 大样本模型臂（W4-02） | **1,752 条**轨迹（= 结构天花板），结构 + 离线回放 **1,752/1,752 全过**；身份 `qwen35-4b-tool-v4`、权重 sha256 `362cc0208717…`、提示摘要 `a5cb0fbcc53f…` | `[实测]` `docs/roco/W4-02-MODEL-CANDIDATES.md:87-97` |
| **与规则臂逐任务配对** | 864 个重合窗口：规则 baseline **864/864**；**模型退化 42、扳回 0** | `[实测]` 同上 `:123-138` |
| SFT 之后的失败**换了形状** | `asked-nothing` 34 → **0**；`stopped-without-tool` 1 → **90**；`wrong-args` 15 → 36；`wrong-tool` 13 → 9 | `[实测]` 同上 `:140-157` |
| 云端预注册评测 | `scripts/eval-live-s04.js`：44 条判据（`[实测]` 2026-09-17 那次 `executed 44`、`serverVerified true`）；价格口径写死在脚本里 | `reports/live-model-eval.json`、`scripts/eval-live-s04.js:406-417` |
| 云臂身份守卫 | `reports/roco/shadow-replay-*.json` **不许**写 DeepSeek 报告（模型身份守卫会红） | `scripts/roco/model-identity.mjs:1-22`、`tests/evals/roco/model-arm-identity.test.js` |
| 影子工具面板 | 开发者抽屉里「同一条提示，一边问规则引擎一边问本地模型」——**逐字复刻评测那份提示**（sha256 钉住，改一个字就红） | `src/coach/shadow-tools.js:1-22` |

**四条必须记住的结论**（都来自上面的实测）：

1. **4B 已经够格做「工具提议」，但没有任何证据说它够格做「事实与结论」**：合法率 8/8 只是格式与边界，
   与规则臂配对是 **退化 42 / 扳回 0** ⇒ 它的产物用途是**候选数据与困难样本**，不是替换规则
   （`W4-02-MODEL-CANDIDATES.md:135-138` 逐字如此）。
2. **SFT 没消灭失败，只把失败搬了家**：现在主要失败是「格式全对但**选择停下不查**」（90 条）与 `roster_constraint`（105/135）。
   下一步该补的是这类数据，而不是继续教格式（`:151-157`）。
3. **4B 的总延迟 ~0.36–0.47s**（p50–p95）⇒ 它**能**进 3 秒预算；27B 的 ~15GB 权重与离线定位 ⇒ **不能**。
4. **云端与本地从来没有做过同提示集的质量对照**（`LOCAL-MODEL.md:151-152` 自己写着「需要 key 才能比较」）。
   现在 key 通了（§1.1），这件事**第一次变得可做** —— 这是下一轮最该补的证据。

---

## 2. 三档分工设计

### 2.1 每档负责什么（建议，含判据口径）

| 档 | 负责 | **明确不负责** | 为什么这么分（证据） |
|---|---|---|---|
| **规则引擎 + planner** | 面板值、伤害、合法动作、状态版本、配队筛选/排序/评分、**候选生成** | —— 它不是「一档模型」，是**事实层**，永远在场 | `docs/roco/LOCAL-MODEL.md:76`；`team-candidates.mjs` 全纯函数 |
| **Qwen3.5-4B（本机）** | ① 工具提议（`provider.plan` 的 `on` 档）；② 短提示/干预措辞（≤96–256 token，`enable_thinking=false`）；③ **云端不可用时的降级解释**；④ shadow 档下的对照观测 | ❌ 不算数值、不选事实、不改工具回执；❌ 不做长文复盘（那是 DeepSeek/27B） | 角色原文 `models/registry.json`（`role_description`）；`LOCAL-MODEL.md:78-79` |
| **DeepSeek API** | ① 长上下文解释与开放陪伴（对话/复盘/教学）；② 工具**规划**（`/api/coach` 的 `plan`）；③ 对手 agent 决策（`/api/opponent`）；④ 4B 失败/超时且预算还余时的兜底 | ❌ 不算伤害/胜负；❌ 不出胜率或百分数；❌ 不进配队评估的关键路径（现在也没进） | `src/server/index.js:402-432`；红线见 §6 |
| **Qwen3.8-27B（离线）** | ① teacher：给 4B 造 SFT/偏好数据；② 离线评测的强判官（与规则判据并列，不替代）；③ 慢速深度复盘（**离线批处理**，玩家要等就明说「离线生成」）；④ 训练/推理数据的困难样本挖掘 | ❌ **永不进请求路径**（连 3000ms 档都不进）；❌ 不把它的分数当胜率 | `models/registry.json` 的 `not_downloaded[1].why`；`LOCAL-MODEL.md:85-86` |

> **一句话版**：**规则算事、4B 说话快、DeepSeek 说得好、27B 在后台教它们。**

### 2.2 降级链与 fail closed（每一跳的触发条件与输出）

```
玩家/页面请求
   │
   ├─(1) 规则段（永远先跑、永远最先出结果）        ← 事实：面板/伤害/合法动作/评分
   │      失败 → 按各自契约 fail closed（缺就 null，不补 0）   [team-serving.mjs:10-18]
   │
   ├─(2) 需要文字解释？
   │      ├─ 局内短提示（≤300–500ms 档）→ 4B ──失败/超时→ DeepSeek ──失败→ 规则模板
   │      └─ 长解释/复盘（≤3s 档）      → DeepSeek ──失败/超时→ 4B ──失败→ 规则模板
   │
   └─(3) 27B：**只在离线批处理**（teacher / eval / 数据生成 / 慢速复盘），不在上面任何一条链上
```

| 跳 | 触发条件（可判定） | 失败时的行为（**fail closed**） | 证据 |
|---|---|---|---|
| 27B → DeepSeek | 请求路径**永不**用 27B；离线任务里 27B 不可用（权重目录不存在 / 加载失败 / 磁盘或内存 preflight 不通过） | 离线任务**如实失败**，不偷偷换成小模型冒充 teacher 产物 | `scripts/train/check-27b-prereqs.mjs:8-16`（三档 `blocked`/`must-measure`/`ready`，**默认 `must-measure`，不给编出来的 ready**） |
| DeepSeek → 4B | 未配置 key（`configured:false`）/ 401·402·429 / 网络失败（502）/ 超时 | 503/502 如实上报；**`provider` 如实降级**，不把失败包装成成功 | `src/server/index.js:257`（错误映射）、`local-model.js:1-22`、`LOCAL-MODEL.md:107-114` |
| 4B → 规则模板 | 超时（3000ms）/ 网关 503/504/429 / 输出不是 JSON 或工具名不认识 → **一律 `{stop:true}`** | 用引擎数据生成的本地结论（`packet.text`）+ `provider:'local-fallback'` + 如实 `fallbackReason` | `src/coach/runtime.js:144-156`、`LOCAL-MODEL.md:107-114` |
| **任何模型 → 事实层** | 模型说了未登记的数字/引用（`checkGroundedAnswer`）或与工具回执不一致（`checkReceiptConsistency`） | **整段丢弃**，换 `packet.text`，`validation.rejected=true` + `rejectedReason` 如实写 | `[实测]` `src/coach/runtime.js:126-156`（**服务端守卫**已补，2026-09-25）、判据 `tests/roco-server-side-guard.test.js`（含**必红反证** `:121`）、已在 `test:unit` 清单里 |

**三条不许破的语义**（本轮实测确认已在代码里）：
① 「主动不要某段」与「超时降级」**分开记账**（`full_withheld` vs `degraded`）；
② 缺的东西恒 `null`，**绝不补默认值**；
③ 降级**必须留痕**（`provider` / `fallbackReason` / `validation` / `agentStop` / `stopped`）。

### 2.3 成本与不浪费（哪些调用可以省）

**现状（诚实说）**：`src/server/index.js` 里**没有**响应缓存 —— 只有 `stateToken` 回显（`：421`），
它是**作废凭据**不是缓存。已有的省法只有四条：

| 已有机制 | 省什么 | 证据 |
|---|---|---|
| `stateToken` / 规划版本作废 | 省掉「拿过期局面去问模型」的整轮 | `src/coach/runtime.js`、`tests/evals/roco/browser-position-matrix.test.js`（陈旧规划丢弃） |
| `inflight` 串行闸门（`/api/coach` 返回 429） | 省掉并发重复请求 | `src/server/index.js:403` |
| 分段 serving 的 `withheldStages`（`stage=first` 只跑必需段） | 省掉**整段算力**（证据段根本不跑） | `src/coach/team-serving.mjs:60+`、`src/server/roco-service.js:690` |
| 4B 单并发 + 快速 429 | 省掉「排队排到超时」的浪费 | `src/coach/local-model.js:41-46`、`LOCAL-MODEL.md:112` |

**建议新增（每条都要判据 + 必红反证）**：

1. **回答缓存**：key = `stateToken + role + message 摘要 + 工具回执摘要 + 提示摘要`；
   命中直接返回并标 `cache:'hit'`。**反证**：改 `stateToken` 必须 miss（否则会把上一局的答案发给下一局）。
2. **同局去重**：同一 `stateToken` 下同一 `role` 的重复请求合并（`inflight` 已有 429 的口径，可升级为等待同一 Promise）。
   **反证**：两个不同消息不许合并。
3. **云端只在「值这个钱」时才发**：判定条件写死为**可判定的三条** ——
   ① 任务类型 ∈ {长复盘, 开放性提问, 局末教学}（`runtime.js:306` 已有 `task` 分类）；
   ② 4B 档不可用或置信不足；③ 预算还够（< 2500ms 余量）。
   **反证**：把它降级成「一律先问云端」必须红（那会把 4B 的意义抹掉，也把延迟顶到秒级）。
4. **影子对照只在 shadow 档跑**（玩家路径零影响），已实现，别改。

---

## 3. 「配队评估 3 秒出结果」的分段预算

### 3.1 现在的实测（**完全不含 LLM**）

| 段 | 预算 | 实测 | 证据 |
|---|---|---|---|
| 状态与版本 | 50 ms | p95 **3.2 ms** | `src/coach/team-candidates.mjs:37-44`（`LATENCY_BUDGET_MS`）、`[实测]` `reports/roco/team-serving/serving.json` |
| 召回 | 150 ms | p95 **23.0 ms**（serving 那次 10.2 ms） | `reports/roco/team-candidates/latency.json`、`serving.json` |
| Beam + 排序 | 300 ms | p95 **25.9 ms**（beam 18.5 + score 7.4） | 同上 |
| 首屏（四段合计） | 800 ms | p95 **29.4 ms** | 同上 |
| **交付契约：初判** | **300 ms** | 路由实测 p95 **13.4 ms** | `src/coach/team-serving.mjs:29`（`SERVING_BUDGETS`）、`serving.json.checks[0]` |
| **交付契约：完整解释** | **3000 ms** | 路由实测 p95 **33.4 ms** | 同上 `checks[1]` |
| **端到端（当前树真服务 :8765）`stage=first`** | 300 ms | **10.4 / 10.5 / 11.2 / 12.0 / 14.5 ms（5 次）** | `[实测]` **主线程 2026-09-25**：`GET /api/roco/workshop?selected=own-0001..own-0006&stage=first` |
| **端到端（当前树真服务 :8765）`stage=full`** | 3000 ms | **11.6 / 12.3 / 13.3 / 14.2 / 14.4 ms（5 次）** | `[实测]` **主线程 2026-09-25**：同参数 `stage=full` |
| `total_with_llm`（预留） | **3000 ms** | **尚未被任何 LLM 使用** | `team-candidates.mjs:37-44` |

**端到端那两次的原始回执事实**（主线程实测）：`stage=first` 回执 **294 KB**、
`candidates: 50`、`axes_status: "not_requested"`（证据段**根本没跑** —— 这正是 RC-306 的两阶段设计）。

**读法**：规则段（状态 → 召回 → Beam → 诊断 → 候选 → 五轴）**总耗时约 11–15 ms**，
把 3000ms 里的 **~0.5%** 用掉了 ⇒ 「3 秒出结果」今天**靠规则就已经做到，而且余量是 200 倍**。
所以 3 秒预算**在设计上不是给规则段的，是留给 LLM 解释段的**：规则段先出结论（≤300ms 有保证），
LLM 解释段在 3 秒内**增量替换**文字，超时就保留短结论
（与 RC-306 的「300ms 结构化初判 / 3s 完整解释 / 超时保短结论」合同一致）。
**要守的红线是「别把 15ms 变成 3000ms」，不是「把 3 秒塞满」**。

### 3.2 接 LLM 之后的分段预算（建议，按档给）

**一句话**：规则段先出结论（≤300ms 有保证，实测 11–15ms）→ **LLM 解释段增量替换**（≤3s，超时保短结论）。
下表把「哪一档模型放在哪一段、超时/不可用怎么降级」写死：

| 段 | 预算（ms） | 放哪一档 | 内容 | 超时 / 不可用时的行为（**fail closed**） |
|---|---|---|---|---|
| ① 规则段：状态 → 召回 → Beam → 诊断 → 候选 → 五轴 | ≤ **300**（实测 **11–15ms**，余量 ~20×） | **规则引擎**（不是模型） | 结构化结论：缺口、最小替换、候选 50 → 排序 | 按 serving 契约：**初判只在必需段全成功时给出**，否则 `null` + 逐条 `reason`；缺的值恒 `null`，**绝不补 0** |
| ② **初判上屏**（结构化结论 + 缺口 + 最小替换） | 300 内（同上） | **规则引擎** | 「3 秒内一定有东西看」的那一份 | **永远不依赖模型**；模型段失败**不得**影响它 |
| ③ **解释段（短）** | ≤ **500** | **Qwen3.5-4B（本机）** | 把 ①② 的结构化结论说成人话（≤96–256 token，`enable_thinking=false`） | 超时（默认 3000ms 上限）/ 网关 503·504·429 / 输出不是合法 JSON → **回退到规则模板文案**（`packet.text`）+ `provider:'local-fallback'` + 如实 `fallbackReason` |
| ④ **解释段（长/可选）** | ≤ **2500** | **DeepSeek API** | 长上下文解释 / 开放提问 / 局末教学；**不是**配队评估的必经段 | 未配置 key / 401·402·429 / 网络失败 / 超时 → **保留 ③ 的短解释，原地不替换**（第二段失败**不清空**已渲染的初判，`team-workshop.js` 已有这条口径） |
| ⑤ 服务端事实守卫（两段共用） | **~0**（纯字符串/正则，不发模型请求） | `checkGroundedAnswer` + `checkReceiptConsistency` | 数字/引用白名单、与工具回执一致 | 命中 → **整段丢弃**换 `packet.text`，`validation.rejected=true` + `rejectedReason` 如实写 |
| ⑥ **27B** | **不进这条链** | —— | 只在离线批处理（teacher / eval / 数据生成 / 慢速复盘） | 离线任务失败**如实失败**，不拿小模型冒充 teacher 产物 |

**三段各自的「哪一档」为什么这么定**（都有证据，不是拍脑袋）：

- **①② 永远归规则**：规则段实测 11–15ms（§3.1），而**任何**模型调用的 p95 都比它高一个量级
  （4B 总延迟 p95 470.5ms `[实测] LOCAL-MODEL.md:132`；DeepSeek 的 `plan` 调用口径就是 2500ms 超时
  `[实测] src/server/index.js:406-415`）⇒ 让模型参与「出结论」只会更慢且没有事实增益。
- **③ 归 4B**：它是唯一**延迟可预期**（p50 363ms / p95 470ms）、**免费**、**离线可用**的一档，
  且它的角色在仓里本来就写成「意图路由、工具选择、**干预措辞**、本地降级」（`models/registry.json`）。
  ⚠ 但注意边界：现有 4B 评测量的是**工具选择**，不是「解释配队缺口」；③ 的 500ms 是**按延迟**推的预算，
  **不是**质量结论（见 §7 第 2 条）。
- **④ 归 DeepSeek**：只有它能在 1M 上下文（`MODEL_CONTEXT=1000000`，`runtime.js:293`）里做长解释与开放陪伴；
  把它放成**可选段**而不是必经段，是「快」与「好」的分界点。
- **⑥ 27B 永不入链**：`models/registry.json` 的 `not_downloaded[1].why` 逐字写着「**不进入约 3 秒的局内关键路径**」。

**关键工程约束（写进判据）**：
- LLM 段**只允许增量替换文字**，**不许阻塞 ①②**；
- 「LLM 没回来」（`late` / `timeout`）与「LLM 说错了」（`validation.rejected`）是**两种不同的降级**，必须分开记账；
- 3 秒不是「平均 3 秒」，是**硬上限**：超时后**不再开始新段**（`serveStages` 已有这条语义）；
- 新增的 explain 段**不抢** `/api/coach` 的 `inflight` 串行闸门（`/api/opponent` 已经故意绕开它，见 §6 第 4 条）。

`[推断]` ③ 的 500ms 与 ④ 的 2500ms 是按「实测 p95 + 余量」推的**建议值**，**不是实测**；
落地时必须用 `node scripts/model/bench-local-model.mjs`（4B）与一次真云端调用（DeepSeek）**各量一遍**再定死。

---

## 4. 接入的工程落点（逐条：改哪 / 判据 / 必红反证 / 工作量）

| # | 落点 | 改哪里 | 判据 | 必红反证 | 工作量 |
|---|---|---|---|---|---|
| R1 | **云端质量对照（第一优先）** | 新脚本 `scripts/roco/compare-arms-quality.mjs`：同提示集跑 4B 网关与 DeepSeek，产 `reports/roco/model-quality-compare.json` | 两边都记**模型身份 + 采样参数 + 提示 sha256**；差异逐条列出 | 把身份去掉、或把 provider 写死 ⇒ 必须红（模型身份守卫 `model-identity.mjs` 已有先例） | 1 轮 |
| R2 | **`deepseek` 轨迹臂** | `scripts/roco/agent-trajectories.mjs:673-691` 加 `deepseek: {kind:'model', model:true}`；`local-model-ask.mjs:13-24` 的 `gatewayAsk` **不带鉴权头**（只 `Content-Type`）⇒ 需要新的 `deepseekAsk`（经 app server 或直连 + key），**不许**把 key 打进产物 | 臂必须能注入 `ask`（否则 `makePlanner:704-714` 已经会抛）；报告头记身份；**不写进 `shadow-replay-*.json`**（身份守卫会红） | 不注入 ask 就让模型臂跑 ⇒ 现在就会抛（保留这条） | 1 轮 |
| R3 | **27B 只留接口** | `scripts/train/*`（已有 7 步规划器 + 前置检查）不动；只在 `models/registry.json` 的 `not_downloaded` 与本文维护「离线 teacher」清单 | `npm run train:plan` 只认盘上产物；`--selftest` 证明它**起不了子进程、写不了文件** | 让规划器真去跑训练 ⇒ 自检必须红（已有） | 0（已完成） |
| R4 | **回答缓存 + 同局去重** | `src/server/index.js`（`/api/coach` 之前加一层）；键见 §2.3 | 命中/未命中都要能在回执里看到（`cache:'hit'/'miss'`）；过期必须 miss | 改 `stateToken` 仍命中 ⇒ 必红 | 1 轮 |
| R5 | **云端只在值这个钱时才发** | `src/server/index.js` 的 provider 选择处（现在只有 `credential?cloud:local` 二分） | 三条可判定条件（§2.3）逐条有判据 | 改成「一律先问云端」⇒ 必红 | 半轮 |
| R6 | **配队解释段进 serving 契约** | `src/coach/team-serving.mjs` 新增一个**可选**段（例如 `explain`）；`src/server/roco-service.js` 的 `stage=first\|full` 增加 `explain` 的取数 | 段预算 + 「初判不受影响」+ 「两种降级分开记账」三条判据 | 把 explain 段放进 `required_for_first` ⇒ 初判被判红（这条反证要显式写） | 1 轮 |
| R7 | **本地模型进 3 秒的实测口径** | `scripts/model/bench-local-model.mjs`（已有）+ 新增「配队解释」提示集 | 记 p50/p95 + 合法率 + 峰值内存；**样本量写清、不许单次当 SLA** | 用单次数字当 SLA ⇒ 文档判据（`LOCAL-MODEL.md:137` 已有口径） | 半轮 |
| R8 | **服务端守卫** | ✅ **已完成**（2026-09-25 未提交）：`src/coach/runtime.js:126-156` | `tests/roco-server-side-guard.test.js`（在 `test:unit` 清单里） | 同文件 `:121` 已有「回退成只有浏览器守」的必红反证 | 0（已完成，见 §7 的边界） |

---

## 5. 与现有 RC 的关系

| 已有 RC | 覆盖了本文哪一块 | 结论 |
|---|---|---|
| **RC-306**（3 秒 Serving 合同） | §3 的**全部机制**：300ms 初判 / 3s 完整 / 超时保短结论 / 分段账 | **已覆盖**：新增 LLM 段**只需要往契约里加一个可选段**，不要另起一套 |
| **RC-303 / RC-602 / RC-604** | §3 的规则段（召回/Beam/排序/评分/对手信念） | **已覆盖**；它们都**不调模型**，是 LLM 段的**输入**而不是竞争者 |
| **RC-704**（介入学习） | 「模型能不能自己决定要不要开口」 | **BLOCKED**（需 3–5 人盲评）；本文的降级链**不动**它的硬门控 |
| RC-601 / RC-605 | 轨迹/SFT 重建 | **BLOCKED**；本文的 R2（deepseek 臂）**不依赖**它们，但 R1（质量对照）产出的数据**可以喂**它们 |
| 本地模型部署（W4-02 / LOCAL-MODEL） | §1.1 的 4B 档 | 已落地；本文**不改**它的 flag 语义 |
| 27B（用户延后） | §2.1 的第四档 | 仓里已有 `train:plan` / `train:prereqs`，**不要**把训练做进本仓 |

**建议新起两个编号**（理由：都不是上面任何一条的子集）：

- **RC-901「三档路由与降级链」**：§2 的分工 + §2.2 的降级表 + §2.3 的省法（R4/R5）。
  理由：现在 provider 选择只有 `credential?cloud:local` 两档（`src/server/index.js:420`），
  **没有任何地方回答**「什么任务该给哪一档、每一跳失败算什么」。
- **RC-902「配队解释的 3 秒增量段」**：§3.2 的 ③④ + R6/R7。
  理由：RC-306 是**交付契约**，它回答「超时之后发什么」；本编号回答「LLM 段怎么进来且不破坏它」。
  两者判据不同，合并会让 RC-306 那 12 条单测的语义被冲淡。

---

## 6. 风险与红线（这一节不许被后来的实现放松）

1. **伤害与胜负永远由 Python 规则引擎算，LLM 只解释。** 三档里**没有一档**参与结算
   （`docs/roco/LOCAL-MODEL.md:76`、`models/registry.json` 的 `forbidden` 第 2 条逐字：
   「让模型改写规则事实（面板值、伤害、合法动作、状态版本只能来自规则引擎与 planner）」）。
2. **不造胜率 / 概率 / 百分数。** 模型分数、通过率、覆盖率都**不是**胜率
   （`W4-02-MODEL-CANDIDATES.md:70-71`、`:164`；`RC-602` 的 `emits_win_rate:false`）。
3. **模型不可用时页面显示什么**（现状，照抄即可）：`provider:'local-fallback'` + `fallbackReason`
   （「模型回答里有未经登记的数字或引用，显示已核验的本局分析」等）+ `validation.rejected=true`；
   **绝不显示模型的原始正文**。`[实测]` `src/coach/runtime.js:144-156`。
4. **「响应快」与「事实守卫」不冲突**：守卫是**纯字符串/正则判定**，不发模型请求、不吃网络预算
   （`runtime.js:138-144`）；真正吃预算的是**模型调用本身**，所以省法是「少发、晚发、可放弃」，不是「少守」。
   ⚠ 唯一要小心的是**串行**：`/api/opponent` 已经**故意**绕开 `inflight` 闸门（`index.js:425-432`），
   新增的 explain 段也必须**不抢**这条闸门，否则玩家一问教练、对手就要等。
5. **27B 的产物不许伪装成线上能力**：离线 teacher 生成的数据要标 `offline`，
   不许写进任何在线回执或 `reports/roco/shadow-replay-*.json`（身份守卫会红）。
6. **本地模型的 flag 默认仍是 `off`**：任何「默认走本地」的改动都要人类点头
   （现状 `localModelMode()` 对未知值一律回落 `off`，`local-model.js:56-66`）。

---

## 7. 不确定项 / 读不出来的地方（**别当成事实**）

1. **4B 与 DeepSeek 的质量对照读不出来 —— 因为从来没做过**（没有产物）。
   这正是 R1 要补的；`LOCAL-MODEL.md:151-152` 自己写明「在此之前『本地模型可以替代云端』没有证据」。
2. **「配队解释用 4B 够不够」没有证据**：现有 4B 评测（W4-02）量的是**工具选择**，
   不是「解释配队缺口」这件事。§3.2 里给它 500ms 预算是**按延迟**推的，不是按质量。
3. **27B 的 LoRA 内存峰值没有实测**：`check-27b-prereqs.mjs:8-16` 明说默认档是 `must-measure`，
   **不给 ready**。人类自己要训时，先把 `npm run train:prereqs` 的实测峰值填进台账。
4. **云端单次成本没有按任务分档的实测**：`eval-live-s04.js` 有价格表（`：406-417`）与 44 条的 token 统计，
   但**没有**「配队解释一次多少 token」的测量 —— 需要 R7 补。
5. **`ROCO_LOCAL_MODEL_27B_PATH` 这个环境变量已经存在**（`src/server/index.js:238` 的面板会 `stat` 它），
   但**没有任何代码路径会真的调用 27B**（全文 grep 只有面板那一处）。这是**预留接口**，别误读成已接线。
6. **服务端守卫的补丁是未提交的工作树改动**（`git status` 显示 ` M src/coach/runtime.js`）：
   判据 `tests/roco-server-side-guard.test.js` 已在 `test:unit` 清单里，但**我没有跑门禁**（本任务禁止），
   所以「它在 24 套里绿」这件事**未经本轮复核**，请以门禁为准。

---

## ⚠ 2026-09-26 复核更正（第 37 轮：真网关 + 真云端只读实测）

**怎么量的**：只读代理对着**当时在跑的**网关（`127.0.0.1:8766` = `scripts/model/local-gateway.mjs`，
子进程 `serve_mlx.py --model .models/mlx/Qwen3.5-4B-4bit --adapter .models/adapters/qwen35-4b-tool-v3`）
与**真 DeepSeek** 各跑了一批基准与 8 条端到端问句；复核报告 `/tmp/r7-bench/report.md`（实测数据）
与 `/tmp/doc-repin/report.md`（逐条对账）。上面正文的旧值**保留不动**，这一节只写"今天实测是什么"。

### 1. §3.2 ③「解释段（短）≤500ms → Qwen3.5-4B」：**这一档在 `on` 档不可达**（不是慢，是根本没被调用）

`ROCO_LOCAL_MODEL=on` 的 8 条端到端问句实测：7 次 HTTP 200 **全部 `provider:'local'`（引擎模板）**，
墙钟 min 2 / p50 3 / max 137 ms，**0 次 4B 调用、0 次云端调用**；同一批问题在 `off` 档有 5 次真云端
（941 / 1003 / 1511 / 1670 / 2362 ms，仅云端 p50 = 1511 ms）。

代码上的原因（对账代理把三个入口都读了一遍，比"慢"更硬）：
`src/coach/runtime.js` 的三个 provider 调用点（`:1200` `provider.plan`、`:1235` `provider.generate`、
`:1311` 纠错重写）**全部挂在同一个闸门内**，而闸门是
`const useModel=provider.name!=='local'&&…`（`src/coach/runtime.js:1173`）；
`on` 档在判定"不值这个钱"时把 base 换成了 `localProvider`（`src/server/index.js:758`，
`name:'local'`，定义在 `src/coach/runtime.js:28`）⇒ **4B 的 `generate` 与 `plan` 一次都不会执行**。
`src/coach/local-model.js:443-444` 的注释写着「`provider.name` 保留 base 的名字，**除非真的用了本地结果**」
—— 那一句在设计上是对的，但代码里 `:465` 是无条件 `name: base.name`，于是"真的用了本地结果"这一半从未发生。

**当前口径（未修）**：`on` 档 = 「不发任何模型、直接给引擎模板」。修法记在
`/tmp/round38/plan.md`（`on` 档把包装层 `name` 改成 `mlx-local`、回执读 `lastFallback` 如实标降级、
`localAvailable` 换成真探测），本轮**未修**。

### 2. §2.3 第 3 条「云端只在『值这个钱』时才发」：实测等价于「**`on` 档云端永不发**」

两个硬前提在接线层被写死：
- `src/server/index.js:756` 的 `localRejected:false` —— 全仓唯一传参处，**恒为 false**；
- 同一行的 `localAvailable: _mode==='on' && Boolean(localModel())` —— `localModel()`
  （`src/server/index.js:487-491`）只做 `new LocalModel()`，**构造函数不探测、不 spawn**
  （`src/coach/local-model.js:126-154`）⇒ **恒真**。

于是判定里"本地档不可用或置信不足"这一条永远不成立。实测佐证：复盘那条 `task='review'`、
`task_is_cloud_worthy:true`、`useCloud:false`。判据现状：三条条件只有**纯函数层**判据
（`tests/roco-model-routing.test.js`），**接线层没有判据** —— 这正是它能一直"看着对、跑起来不对"的原因。

### 3. §2.2 降级链图：`on` 档上 **DeepSeek 一跳与 4B 一跳都不存在**

正文那张 `DeepSeek ──失败→ 4B ──失败→ 规则模板` 描述的是"本地不可用时"的链；
`on` 档实际的 `_base` 就是 `localProvider`（模板），4B 那一层因为第 1 条的闸门从不执行 ⇒
**直接 `packet.text` 直出**，链上两个模型节点都空转。规划里"本地失败也回同一个模板"这条分支
（`src/coach/local-model.js:450/497`）同样走不到。

### 4. 网关 p50 / p95：`511.3 / 3661.6 ms`（`requests=12`）→ **`477.6 / 721.5 ms`（`requests=4217, timeouts:0`）**

对账代理本轮**独立复读**了网关 `/healthz` 的自算值（只读探测，未发推理请求）。旧值**不是错的**：
它是「刚起网关 + 一次 `--runs 3`」那个 12 样本窗口（`scripts/model/bench-local-model.mjs:36/195`，
与 `docs/roco/LOCAL-MODEL.md:98` 的命令一致）；而 12 个样本下 `floor(0.95×12)=11=n-1`
⇒ **旧「p95」定义上就是那 12 条的最大值**，不是同口径的分位数。今天 4217 次累计口径下 p95 = 721.5 ms。

### 5. `/api/models` 面板「如实报三只模型状态」：**`connected` 不认默认权重目录**

对账代理独立复现：`localModelReport({ROCO_LOCAL_MODEL:'on'})` ⇒
`connected:false, model:null, reason:"没设 ROCO_LOCAL_MODEL_PATH（权重目录）"`，
而 `.models/mlx/Qwen3.5-4B-4bit` 存在、`src/coach/local-model.js:129` 会回落到它。
口径差在：面板的 `connected` = 「**环境变量**给了目录 + 目录存在」，**不含** `DEFAULT_MODEL_DIR` 兜底
⇒ 按本文 §1.1 的启动方式（只设 `ROCO_LOCAL_MODEL=on`）面板会显示「未连」，而运行时照用默认目录。
**注意**：这是**判据明文要求**的行为（`tests/roco-panel-model-env-key.test.js:151`
「没设任何权重目录时必须未连」），`reason` 字面也是真的 —— 要改的是本文的表述（"如实"→"如实但不含兜底"），
**不是代码**（R7 报告里"谎报"的定性过了头）。

### 6. 全篇行号引用：**不是作者写错，是工作树把文件撑大了**

本文里 14 处 `文件:行号` 引用（如 `src/coach/local-model.js:41-46`）在 **HEAD `579ab2f` 上逐字正确**
（对账代理用 `git show HEAD:… | sed -n` 逐条验过）；当前工作树有 300+ 未提交改动把文件撑大
（`src/coach/runtime.js` +2903 行、`src/server/index.js` +496 行），行号才漂的。
⇒ 处理方向是**改用符号引用**（函数名 / 常量名 + 文件），不是逐个改行号。
