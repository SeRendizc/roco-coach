# 4B 实测 · Agentic RAG · 600 只量级的 agent 优先路线（2026-09-25 睡前口径）

> 人类三条睡前口径的**调研 + 实测**产物。全部数字都是本机真跑；命令都贴了，可复算。
> 只新建了本文件；没改任何在办文件；没跑全量门禁；**没有下载任何东西**。

---

## ① 4B：训好没有、能不能用（实测）

### 事实（命令 + 原始回执）

| 项 | 实测 |
|---|---|
| 权重 | `.models/mlx/Qwen3.5-4B-4bit` **在盘上**（`mlx-community/Qwen3.5-4B-4bit`，4bit，~3.13 GB，apache-2.0；`models/registry.json` 的 `models[0]`） |
| 运行时 | `.venv-mlx`：**mlx-lm 0.31.3** / Python 3.12.14 / `mx.default_device() == Device(gpu, 0)`（M5 Pro、48 GB 统一内存） |
| **网关** | `http://127.0.0.1:8766/healthz` → **200 且在跑**：`model=.models/mlx/Qwen3.5-4B-4bit`、**`adapter=.models/adapters/qwen35-4b-tool-v3`**、`ready:true`、`p50_total_ms=511.3`、`p95_total_ms=3661.6`、`peak_memory_gb=2.564`、`counters={requests:12, ok:12, timeouts:0, upstream_errors:0}` |
| 训练产物 | LoRA adapters：`.models/adapters/qwen35-4b-tool-v1/`、`-v2/`（各带 100/200/400/600 档 checkpoint）；**v3 已挂载**（`healthz` 的 `adapter` 字段） |
| 真推理（我直连网关 3 条，原样） | ① 一条我引号写坏 → `400 bad_json`（**我的命令问题，不是模型**）；②「这一手该不该查局面？只回 yes/no」→ **`no`**，**340 ms**；③「用一句话说明防御的减伤」→ 回了一段**通用世界知识**（防护装备/环境改造…），**775 ms** —— 没有本作上下文时它不认得游戏术语 |

### 结论（明确回答人类那三问）

- **训好没有**：**底座 + 工具 adapter 都在、能真跑**；`.models/adapters/qwen35-4b-tool-v3` 已挂载 ⇒「之前据称已经训练好了」指的是这些 LoRA 工具适配器，**属实**（v1/v2/v3 都在盘上）。
- **能不能用**：**工程意义上能用**（网关常驻、`ready:true`、12/12 成功、峰值 2.56 GB、短调用 0.34–0.78 s）。
  **但质量上不能宣称「好了」**：仓库里那份评测（`docs/roco/W4-02-MODEL-CANDIDATES.md`）实测 4B 相对**规则 baseline 退化 42、扳回 0**（864 个配对窗口）；本轮 3 条样例里也有一条答成通用知识。
- **与规则 baseline 比**：**规则更准**（那只比较过的工作面）；4B 的价值在**规则给不出的东西**（判定「该不该查/该不该开口」、把 600 只的未知讲成人话、措辞），**不在能不能替代规则**。
- **与真 DeepSeek 比**：`docs/roco/LOCAL-MODEL.md:151-152` 自己承认**从未做过同提示集对照**；本轮也没做（那需要一次成规模的臂对照，见 ④-a）。
- **延迟**：`p50 0.51 s` 适合「短段/判定」；**`p95 3.66 s` 已经吃掉整个 3 秒预算** ⇒ 必须按段限流 + 超时降级（与 `MODEL-ROUTING-PLAN.md` 的「4B ≤500ms 短段」一致），**不能**把它放在会阻塞首屏的路径上。

---

## ② Agentic RAG 有没有用（带外部来源 + 本仓现状）

### 先说我怎么理解人类那两个词（人类自己也不熟，我列全）
1. **Agentic RAG**：让 agent 自己决定「检索什么 / 多轮检索 / 自评要不要再检索 / 什么时候拒答」，而不是一次向量查询就作答。
2. **普通 RAG**：向量/关键词检索 + 拼接上下文。
3. **另一种更可能的解释（重点）**：**Jev = TypeSafe AI 的「System One」模型** —— 定位是**判断与决策**（带类型化的判定输出），不是聊天模型（[LangChain 的 harness 文章](https://www.langchain.com/blog/building-a-harness-with-jev)、[awesome-typesafe-jev](https://github.com/AbdelStark/awesome-typesafe-jev)、[awesome-jev-typesafe](https://github.com/valentynkit/awesome-jev-typesafe)）。
   若人类指的是这个，它**与本仓最弱的一环正好对上**：工具该不该调（云臂实测真臂 33/49）、教练该不该开口、planner 提示里那句「默认是停止」的偏置 ⇒ **不需要引入第三方产品，用本机 4B 就能复刻这条思路**（见 ③-1）。

### 外部证据（代价与边界）
- [SoK: Agentic RAG（arXiv 2603.07379）](https://arxiv.org/html/2603.07379v1#5)：系统化梳理了 agentic 检索的分类与架构，并明确点出**「部署这些框架会暴露学术基准里很少遇到的运维瓶颈」**（延迟/成本/可观测性）。
- [What Is Agentic RAG?（FutureAGI, 2026）](https://futureagi.com/glossary/agentic-rag/#why-it-matters-in-production-llm-and-agent-systems)：多轮检索 + 自评的标准形态。
- [Cost and Latency Trade-Offs: Agentic RAG vs Traditional Retrieval](https://www.m365.fm/blog/cost-latency-trade-offs-agentic-rag-vs-traditional-retrieval/)：**agentic 的代价主要是轮次**（每多一轮就多一次模型调用 + 一次检索）。
- [Graph-Based and Agentic Retrieval 的系统评测（arXiv 2604.11419）](https://ar5iv.labs.arxiv.org/html/2604.11419#6)：给的是**任务相关**的结论 —— agentic 不是普遍更优，取决于任务是否需要多跳证据。

### 本仓现状（要改的地方）
- 索引与评测：`src/coach/rag-index.js`（**1694** 文档 —— 2026-09-25 复算：1446 pack + 23 台账 + 77 规则配置 + 100 冲突 + 48 玩家个体；本文原写 1678，与 `reports/roco/rag/rag-eval.json` 的 `corpus.documents` 差 16 条，现已按产物更正）、`data/roco/rag/heldout-queries.json`（45 条 + 13 探针）、`scripts/roco/eval-rag-retrieval.mjs`（13 组判据 + 三套基线；**R@1 1.000 是开发集数字**，13 条探针里 **1 条保留失败**）、产物 `reports/roco/rag/rag-eval.json`。
- agent 侧：`src/coach/toolbox.js` 的 `search_rules`（工具合同）+ `src/coach/runtime.js` 的 `gatherAgentEvidence`（**3 步上限、以「一次检索」为主**，且有 `seen` 去重 ⇒ **结构上做不了多轮再检索**）。

### 判断：**值得做，但不是「再上一个大向量库」**
它能解决**三条已实测的具体问题**：① 云臂工具选择 **15/49「该调却没调」**（「该不该检索」本身就是判定问题，不是检索问题）；② **45+13 条开发集相对 600+ 实体太小** ⇒ 需要的是「**证据不足就再检索/就拒答**」的判据，而不是更大的库；③ RC-403 的分档（`PARTIAL 614 / SIMULATABLE_UNVERIFIED 8 / FULL 0`）与 `effect_unparsed 31` / `trigger_unknown 192` 这些**知识→规则的桥**，靠 agent + 检索比再手写规则更符合人类「重心在 agent」的方向。
**代价**：延迟（每多一轮 ≈ +0.3–3.6 s，取决于用 4B 还是云端）；判据难写点在「什么算检索够了」——可落成三条可复算判据（证据覆盖 / 冲突弃答 / 引用可回执）；**检索本身不花钱**（本地索引）。
**最小第一步（含判据与必红反证）**：把 `search_rules` 拆成 **`search_rules`（检索）+ `assess_evidence`（自评：够不够 / 要不要再检索 / 要不要拒答）**，在 `gatherAgentEvidence` 里允许**至多一轮再检索**（步数上限仍是硬约束）。判据：
① 证据不足 ⇒ 必须再检索或拒答（**反证**：把 `assess_evidence` 短路成「永远够」→ 必须红）；
② 冲突证据 ⇒ 必须弃答（**反证**：喂两条互相冲突的卡片仍作答 → 红）；
③ 引用必须可回执（**反证**：编一个不存在的证据 id → 红）；
④ 预算：再检索 ≤1 轮、总时长 ≤3 s，超时保短结论（**反证**：去掉轮次上限 → 红）。

---

## ③ 600 只精灵 / 机制复杂：agent 优先路线（按价值排序）

> 现状（都用仓内实测数字）：622 只已有**按需推算**配招（`data/roco/derived/on-demand-builds.json`）；支持度分档 `PARTIAL 614 / SIMULATABLE_UNVERIFIED 8 / FULL_VERIFIED 0`；回归集 `unreachable` **3** 条（天气/迅捷/传动）；覆盖尺子 `可模拟 344/824`；规则段延迟 **10.5–14.5 ms**（`reports/roco/team-serving/latency-live-2026-09-25.json`）。
> ⇒ **「算得快、算得准」这一半已经很好了；缺的是「判断、解释、把未知讲清楚」那一半** —— 这正是模型/agent 该接管的部分。

| # | 做什么 | 解决哪条实测问题 | 依赖 | 判据 + 必红反证 |
|---|---|---|---|---|
| **1** | **判定回路（Jev / System One 思路）**：把「该不该调工具 / 该不该开口 / 要不要再检索 / 要不要拒答」做成**带类型的判定**，用**本机 4B**（p50 0.51 s）或云端跑，替掉提示里那句「默认是停止」 | 云臂 **15/49 欠调用**；coach 开口门控 | 4B（已可用） | 预注册判定集上的准确率 + **反证：把判定换成常量（恒 yes/恒 no）→ 必须红** |
| **2** | **检索闭环**（② 的最小第一步）：多一轮再检索 + 拒答 | 开发集太小、未知机制多 | 4B / 云端 | 见 ② 的四条 + 四条反证 |
| **3** | **把「支持度」讲成人话**：`PARTIAL/SIMULATABLE_UNVERIFIED/FULL` 与「这只为什么只能给建议不能模拟」由 agent 解释，而不是再补规则覆盖 | `FULL_VERIFIED 0`、`PARTIAL 614` | 云端（解释） | 文案不得出现未登记数字/胜率（**反证**：塞一个「胜率 58%」→ 红）；必须点名缺哪个部件（**反证**：泛泛而谈 → 红） |
| **4** | **未支持机制的受控提案**：对 `effect_unparsed 31` / `trigger_unknown 192`，让 agent **起草**机制假设 + 要求证据，进台账后**才**由人改成引擎规则 | 覆盖缺口 480 条 | 云端 + 台账 | 提案必须带证据要求与反例（**反证**：无证据要求 → 红）；**模型不许直接改规则事实** |
| **5** | **配队解释的 3 秒增量段（RC-902）**：规则段 11–15 ms 先出结论 → agent 段增量替换，超时保短结论 | 「配队评估 3s 出结果」 | 4B（短段）+ 云端（长段） | 首结论非模型依赖（**反证**：模型超时后首屏空 → 红）；总时长 ≤3 s |

**必须留给规则引擎（红线，别把「少用脚本」读成「让模型算伤害」）**：伤害、命中、胜负、合法性、资源结算、面板值与状态版本 —— 一律出自 Python 规则引擎；模型只解释、只判定「要不要用工具/要不要说话」。
**两条硬约束照旧**：不造胜率/概率/百分数；未知一律 fail closed（无证据时**弃答**而不是给一个像结论的句子）。

---

## ④ 需要人类拍板的（**不阻塞**，起来一起处理）

| # | 问题 | 我的建议 |
|---|---|---|
| a | 要不要现在跑一次 **v3 adapter 的正式本地臂评测**（旧数字 退化 42/扳回 0 是 v1/v2 时代）？ | 要，但排在门禁之后（评测要占 CPU，会与门禁抢） |
| b | 4B 的 p95 **3.66 s** 已超「短解释 ≤500 ms」预算 ⇒ 4B 只做「判定/短措辞」，长解释一律云端？ | 是 |
| c | Agentic RAG 的最小第一步（两个工具 + 至多一轮再检索）现在做吗？ | 做，它直接对着 15/49 欠调用 |
| d | ③-1 判定回路 与「培养页」谁优先？ | 判定回路（agent 主线，人类口径） |
| e | 人类说的 **Jev** 是不是 TypeSafe AI 的 System One？（我按「判定模型」理解并给了来源；若指别的请给链接） | 按 System One 思路做，**不引入第三方产品** |
| f | `roster-48` 与引擎的 **2/48 漂移**：改盒子页读点，还是授权动 `data/roco/normalized/**`？ | 改读点（冻结层是红线） |
| g | 云臂「工具选择」口径：**甲**（实时状态必须查证）还是**乙**（不浪费调用 + 数字必须被证据守住）？ | 乙（并把守卫从浏览器升级到服务端，已做） |
