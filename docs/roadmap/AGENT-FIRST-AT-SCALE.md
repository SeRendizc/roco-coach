# 600 只精灵 + 复杂机制下的「以 agent 为中心」方案

> **人类口径（2026-09-25 睡前，逐字）**：
> ①「我希望模拟的是 **600 只精灵数据量很大机制很复杂**的情况」；
> ②「**尽可能不要只依赖脚本计算和预制数据，更多依赖模型和 agent 本身**，当然可以结合」；
> ③「**加上 RAG 等**」；
> ④「但是**依旧重心在 agent 上不在游戏系统**」。
>
> **本文性质**：只读调研 + 方案。**没有跑任何门禁，没有联网改仓，`data/roco/normalized/**` 只读，没有改动任何既有文件。**
> 本文只新增两个文件（本文与 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md`）。
>
> **标注惯例如仓内**：`[实测]` = 本会话真读出来的仓内数字/产物；`[文档]` = 仓内文档写的；`[人类]` = 人类口述；
> `[推断]` = 由上两者推出的工程判断；`[外部]` = 仓外资料，**未在仓内验证**。**读不出来的地方写「读不出来」。**
>
> **与已有文档的关系（同一条人类口径在仓内已经有三份文档，别重复劳动）**：
> - `docs/roadmap/AGENT-FIRST-600-PLAN.md`（mtime 2026-09-24 04:02）：**方向与验收设计**，
>   已经切到同一个方向，并且**对 `jev` 的判断是对的**（引了 LangChain + TypeSafe 两条来源）。
>   本文**不重复**它的分阶段（P0–P3），本文的贡献是**把现状钉到数字与行号、把口径翻成可判定原则、给出五阶段验收**。
>   ⚠ 它的 §2 写「RAG：`src/coach/rag-index.js`（**1678 文档**）」——那是**旧数字**，当前现算是 **1694**（见 §1.2）。
> - `docs/roadmap/AGENTIC-TECH-IDEAS.md`（2026-09-25）：扫过一轮「agentic 技术候选」并逐条给判断。
>   本文**不重复它的候选清单**。⚠ 它的附录 `:158-159` 说 `jev` **没有可信一手来源**——**这条是错的**（见 §7 第 11 条）。
> - `docs/roadmap/JEV-DECISION-EVALUATION.md`（2026-09-22）：**对 `jev` 的评估是对的**，本文 §6.4 直接引用它。
>
> **两份新文件的分工**：本文 = **方案**；`docs/roadmap/AGENTIC-TERMS-RESEARCH.md` = **术语调研（含「读不出来」的如实结论）**。

---

## 1. 现状：622 只现在到底能用到什么程度

> 人类说「600 只」，仓内冻结目录的**实际数字是 622 只精灵 / 824 条技能记录**
> （`docs/roadmap/FLAGSHIP-V3-REDIRECT.md:17`）。下文一律用 622，并在需要时写清口径。

### 1.1 规模账（全部来自磁盘产物）

| 项 | 值 | 出处 | 性质 |
|---|---|---|---|
| 冻结 L1 精灵记录 | **622** | `docs/roadmap/FLAGSHIP-V3-REDIRECT.md:17` | 冻结数据 |
| 冻结技能记录 | **824** | 同上 `:17` | 冻结数据 |
| 可模拟的「效果实体」（技能+特性） | **344 / 824 = 41.75%** | `reports/roco/rc401/effect-coverage.json` → `totals.{entities,simulatable_entities,simulatable_ratio}` | `[实测]` 读产物 |
| 其中技能分档 | `SIMULATABLE 335 / PARTIAL 181 / KNOWLEDGE_ONLY 63 / FULL 0 / REFUSED 0` | 同上 `support_levels.battle_skills` | 同上 |
| 其中特性分档 | `FULL 9 / SIMULATABLE 0 / PARTIAL 4 / KNOWLEDGE_ONLY 228 / REFUSED 4` | 同上 `support_levels.traits` | 同上 |
| 精灵档（RC-403 逐只） | `FULL_VERIFIED 0 / SIMULATABLE_UNVERIFIED 12 / PARTIAL 610 / KNOWLEDGE_ONLY 0 / REFUSED 0` | `reports/roco/rc403/support-classification.json` → `totals` | `[实测]` 读产物 |
| 卡点 | 特性 **605 只**、配招里的技能 **150 只** | 同上 `blockers` | 同上 |
| 特性登记条数 | **12 条**（`traits.py`） | `docs/roco/RC-403-SUPPORT-CLASSIFIER.md:14` | `[文档]` |
| 按需配招编译 | **622 = 48 已核验 + 574 按需推算**，跳过 0 | `docs/roco/RC-402-ON-DEMAND-BUILDS.md:26` | `[文档]` |
| 编译规则**不复现**冻结那一份 | `compiled_matches_frozen = 0` | 同上 `:35` | `[文档]` |
| 组合空间 | `C(622, 6) ≈ 6.4 × 10^13`，**不可枚举** | `docs/roco/TEAM-CANDIDATES.md:182` | `[文档]` |
| 当前可玩池 | **48 只**（迁移夹具，**不是**候选宇宙） | `docs/roadmap/FLAGSHIP-V3-REDIRECT.md:18`、`:38`（S3） | `[文档]` |
| 索引包 | **1446 条实体 / 2888 条 provenance**，状态 `draft`（7/9 就绪项） | `docs/roco/GAME-DATA-PACK.md:11`、`:14` | `[文档]` |
| 索引包冲突 | 99 条（IDENTITY 65 / VALUE 0 / GRANULARITY 34），**未解决 4 条** | 同上 `:145` | `[文档]` |
| 形态轴 | 196 条落表 `{BASE:426, LORD:64, REGIONAL:131, MUTATION:1, OTHER:0, UNMAPPED:0}` | 同上 `:146` | `[文档]` |
| 数值一致性 | **没有证明**（§9 第 6 项 `satisfied=false`）：公网索引页根本没有种族值/学招表/威力字段 | 同上 `:147`、`:179` | `[文档]` |
| `power` 缺失 | `skills.json` 里 **466/824** 条 `power_status=not_provided_by_source`（**不等于 0 伤害**） | 同上 `:178` | `[文档]` |

### 1.2 RAG 现状（**这里有一处必须如实说明的产物/文档漂移**）

`[实测]` 本会话直接调 `src/coach/rag-index.js` 的 `loadCorpus()` + `buildDocuments()`（只读，不写盘），当前语料是：

```text
CURRENT docs = 1694
{"battle_skill":579,"pet_record":460,"pet_form":162,"trait_record":245,
 "ledger_entry":23,"conflict_record":99,"conflict_policy":1,"ruleset_config":77,"owned_instance":48}
```

这与磁盘上的报告 `reports/roco/rag/rag-eval.json` 的 `corpus.documents = 1694` **完全一致**，
但与文档 `docs/roco/RAG-EVAL.md:133` 写的「**1678 条文档**」以及它 §2 表里的分项
（`ledger_entry 20 / ruleset_config 32 / owned_instance 80`）**不一致**。
同一份 `rag-index.js` 的文件头注释（`src/coach/rag-index.js:4`）也还写着「台账 20 条结论、2 份 ruleset 配置、80 个 owned 个体」。

**检索指标同样有两套数字**：

| 指标 | 文档说（`docs/roco/RAG-EVAL.md`） | 磁盘报告说（`reports/roco/rag/rag-eval.json`，`metadata.generated_at=2026-09-23T19:59:19Z`） |
|---|---|---|
| 语料文档数 | 1678（`:133`） | **1694**（`corpus.documents`） |
| `rag_index` Recall@1/3/10、MRR | 1.000 / 1.000 / 1.000 / 1.000（`:213`） | 1 / 1 / 1 / 1（一致） |
| 冲突弃答率 | **1.000**（`:213`、判据 `:265`） | **0.9090909…**（`metrics.rag_index.conflict_abstention_rate`） |
| 弃答精确率 | 1.000 | 1（一致） |
| 版本命中率 | 1.000 | 1（一致） |
| 判据 | 「13/13 通过」（`:273`） | 报告里**没有** gates 段，我**没有跑门禁**（本任务禁止），所以**读不出来**现在是绿是红 |

`[实测]` 逐条查了 11 条 `conflict_abstain` 查询：**C02 没有弃答**（`abstained=false`），其余 10 条弃答 →
10/11 = 0.909 正是报告里那个数字。而文档 §1 表格把 C02 写成
「`EVIDENCE_LEVEL_INSUFFICIENT`（`EV-ENERGY-INITIAL`，MC-E04 未录）」（`docs/roco/RAG-EVAL.md:84`）。

> **结论（不许含糊）**：**文档 `RAG-EVAL.md` 的数字是旧的，磁盘报告是新的，两者不一致**；
> 谁现在是对的**读不出来**（跑一次 `--check` 才知道，而本任务明令不跑门禁）。
> 上线前必须以重跑后的产物为准；**在本文与任何方案里引用 RAG 指标时，必须同时标出这个漂移**。

其余 RAG 事实（文档与报告一致的）：

- 检索层是**纯 JS 的 BM25 + 别名表 + 结构化过滤 + evidence/ruleset rerank**，
  **不做任何模型调用、无外部依赖**（`src/coach/rag-index.js:15-16`、`docs/roco/RAG-EVAL.md:159-160`）。
- **向量检索没做**：没有本地嵌入模型、不联网；接口留在 `searchIndex` 的 `vector` 选项上，
  报告里写 `NOT_IMPLEMENTED`（`src/coach/rag-index.js:24-28`、`docs/roco/RAG-EVAL.md:164`）。
- **弃答是合法结论而且是默认保守方向**，三种原因码：
  `NO_MATCH` / `UNRESOLVED_IDENTITY_CONFLICT` / `EVIDENCE_LEVEL_INSUFFICIENT`
  （`src/coach/rag-index.js:76-80`，判定分支 `:916-959`）。
- 相关性门槛 `SCORE_FLOOR = 25`，且**只作用于普通路径**；强意图查询把答案空间钉死成 2～100 条时走 `floor = 0`
  （`src/coach/rag-index.js:732`、`:813`、`docs/roco/RAG-EVAL.md:240-253`）。
- **污染声明**：`Recall@1 = 1.000` 是**开发集**数字，主集措辞在看过检索行为之后改过
  （`docs/roco/RAG-EVAL.md:15`、`:330-338`）。
- **最大的风险面**：`NO_MATCH` 依赖相关性门槛标定，换个说法命中泛词就可能从「弃答」滑成「给一条错答案」
  —— 探针 P10「冰系被哪些属性克制」**保留失败**（同一份报告 `probe.failures`、`docs/roco/RAG-EVAL.md:352-355`）。
- **别名表是机械规则**，没有任何同义词/简称扩展；玩家常用简称会直接 `NO_MATCH`（`docs/roco/RAG-EVAL.md:363-364`）。

### 1.3 哪些是**脚本/预制数据**在撑（逐条）

| 能力 | 谁在撑 | 出处 |
|---|---|---|
| 伤害、胜负、能量/魔力结算 | **Python 规则引擎**（joint-step / replay），是**唯一事实源** | `docs/roadmap/MODEL-ROUTING-PLAN.md:99` |
| 合法行动裁剪 | 引擎 `rs.is_learnable`；**服务端不许自造可学表** | `docs/roadmap/CULTIVATION-PAGE-PLAN.md:49` |
| 支持度定档（精灵档 / 效果档） | `roco/src/roco_env/support.py`（按部件定档取最坏件，`SEVERITY` 表在 `:44`）+ `coverage.py`（`:48` `classify_skill`、`:115` `classify_trait`） | `roco/src/roco_env/support.py:60`、`roco/src/roco_env/coverage.py:164` |
| 574 只的按需配招 | 预制产物 `data/roco/derived/on-demand-builds.json`（1.4 MB）+ 一条写死的启发式 | `docs/roco/RC-402-ON-DEMAND-BUILDS.md:3`、`:32-33` |
| 600+ 召回 / Beam 补全 / 排序 / 评分 | `src/coach/team-candidates.mjs`，**全纯函数** | `docs/roadmap/MODEL-ROUTING-PLAN.md:51`（「完全不调模型」） |
| 配队评估整条链 | 同上，路由实测 **11–15 ms** | `docs/roadmap/MODEL-ROUTING-PLAN.md:20`、`reports/roco/team-serving/latency-live-2026-09-25.json` |
| RAG 检索 | 纯 JS BM25，无模型调用 | `src/coach/rag-index.js:15-16` |
| 「该不该调工具」 | **写死在代码里**（连模型都不给判断权） | `src/coach/runtime.js:179-188`（`policyFor`）、`:112-120` |
| 事实/数字/引用守卫 | 纯字符串 + 正则，**不发模型请求** | `src/coach/runtime.js:391-467`、`docs/roadmap/MODEL-ROUTING-PLAN.md:196` |
| 胜率禁令 | 键名/词表 + 否定语境豁免 | `src/coach/team-candidates.mjs:1808-1826`、`:1585`（`no_win_rate: true`） |
| 产物失效图 | `data/roco/artifact-registry.json` → 20 条产物 × 17 个规则主题，13 条禁止重跑 | `docs/roadmap/FLAGSHIP-V3-REDIRECT.md:91` |

### 1.4 哪些**已经**是模型在撑（逐条）

| 能力 | 谁在撑 | 出处 | 实测 |
|---|---|---|---|
| **决定「查什么证据」**（有界工具循环，最多 3–4 步） | 云端 planner（`provider.plan`） | `src/coach/runtime.js:265-351`；云端 planner 提示 `src/server/index.js:417-423` | 49 例工具选择 **33/49 = 0.673**（`reports/live-model-eval.json` → `metrics.layered.toolSelectionCorrect`） |
| **把结构化结论说成人话** | `/api/coach` 的 `generate` | `src/server/index.js:424-427`（`complete(messages,320,8000)`） | — |
| 对手 agent 的决策 | `/api/opponent`（**独立链路**，无对话无记忆，故意绕开 `inflight`） | `src/server/index.js:425-432`、`docs/roadmap/MODEL-ROUTING-PLAN.md:50` | — |
| 本地 4B 档 | `off`（默认）/ `shadow` / `on` 三档 flag | `src/server/index.js:191-224`、`docs/roadmap/MODEL-ROUTING-PLAN.md:58-64` | 4B 总延迟 p50 **362.9ms** / p95 **470.5ms**（`MODEL-ROUTING-PLAN.md:40`） |
| 轨迹臂上的模型能力 | `local_4b` / `sft-v4` | `docs/roadmap/MODEL-ROUTING-PLAN.md:72` | 4B 基座 **225/288**、`local_4b` **268/288 = 93.06%**、`sft-v4` **275/288 = 95.49%** |
| **与规则臂配对（关键负面数字）** | 同上 | 同上 `:74`、`:84` | 864 个重合窗口：规则臂 **864/864**；**模型退化 42、扳回 0** |
| 27B | **未下载、未训练，永不进请求路径** | 同上 `:33`、`:102` | — |

### 1.5 一句话现状

> **模型今天只承担两件事：①「查什么」的选择权；②把已经算好的结构化结论说成人话。**
> 其余全部（结算、合法行动、支持度、配招、召回/Beam/排序、检索打分、事实守卫、胜率禁令）都在**脚本 + 预制数据**手里。
> 而模型这两件事里，「选择」已经量出 **0.673**，「说人话」**从来没有跟云端/本地做过同提示集的质量对照**
> （`docs/roadmap/MODEL-ROUTING-PLAN.md:88-89`、`:283`）。

---

## 2. 原则：把人类那句话翻成**可判定**的工程原则

> 人类口径 → 原则的翻译不是修辞，每条都必须能回答「**什么样的改法算违反**」。

### P1 —— 事实可检索/可复算，就**不许**再写进预制结论表

- **可判定写法**：任何面向玩家的**事实性结论**，必须能在回执里指出它的来源属于
  {引擎回执, 工具回执, RAG 文档 id + provenance} **之一**；指出不出来的，不许上屏。
- **反例（算违反）**：为「600 只该怎么配队」再写一张 `docs/roco/600-ANSWERS.md` 之类的结论表；
  或者把某个玩家会问到的答案**提前算好写进代码常量**。现行同类反例是
  `src/coach/runtime.js:2-4` 注释里记录过的「以前这里写死 `energyLimit:6`，与规则表里的上限是两份事实」。
- **现有落点**：`docs/roco/GAME-DATA-PACK.md:160-168`（包只做索引，值留在冻结目录，**抄进来就会出现第三份事实源**）。

### P2 —— 脚本只负责**可复算的规则结算**与**守卫**；模型负责**选择、解释、检索、归纳**

- **可判定写法**：新增任何一段逻辑前，先回答「它是不是可逐位复算的？」——
  是 ⇒ 归脚本；否且属于{选择/解释/检索/归纳} ⇒ 归模型；**两者都不是 ⇒ 不许做**。
- **反例**：让模型输出一个伤害数字（可复算却给了模型）；或者让脚本用关键词表硬编码「玩家这句话该用什么语气」
  （属于解释/选择却给了脚本，且拐弯抹角无法被证据复算）。
- **现有落点**：`docs/roadmap/MODEL-ROUTING-PLAN.md:99-104`（规则引擎是事实层；4B 不算数值不选事实；DeepSeek 不算伤害/胜负）。
  **⚠ 注意一处需要澄清的既存事实**：今天「该不该调工具」是**脚本**决定的
  （`src/coach/runtime.js:179-188`），这与人类「更多依赖模型」的口径**方向相反**——但它有实测理由
  （模型「选哪个工具」90–100%，「该不该调」只有 50%，见 `src/coach/runtime.js:176-178`）。
  按 P2 的判据，「该不该调」**不是可复算的规则结算**，所以它**终局应该归模型**；
  但要先用「最小充分性」判据（§4 J3）证明它归模型不会掉分，**不许今天直接翻**。

### P3 —— 任何模型输出都必须**能被引擎/证据复算，或拒答**

- **可判定写法**：模型正文进守卫（数字白名单 / 引用白名单 / 确定性承诺 / 回执一致性），
  命中 ⇒ **整段丢弃**，换 `packet.text`，并把 `validation.rejected=true` + `rejectedReason` 如实写。
- **反例**：静默降级（换掉了却不说）；或者「守卫拦不住的就不拦了」——现行反例是
  `docs/roadmap/MODEL-ROUTING-PLAN.md:130-137` 记录的服务端守卫缺口（原来只挂在浏览器层，
  curl/headless 拿到的是**没筛过**的正文）。
- **现有落点**：`src/coach/runtime.js:138-157`（服务端守卫 + 如实回执）、`:463`（`unsupported-number`）、`:465`（`unsupported-citation`）。

### P4 —— **规模由检索承担，不由枚举承担**

- **可判定写法**：任何在线路径都不许出现「对全体候选做组合展开」的代码；候选必须经召回（20–50）→ Beam（宽度 4、节点 2000、时间 50ms）收窄。
- **反例**：把 `C(622,6)` 拿去跑；或者**在线请求里做批量模拟**（现行 S4 已明令停止）。
- **现有落点**：`docs/roadmap/FLAGSHIP-V3-REDIRECT.md:39`（S4）、`:57`（`C(622,6)` 不可枚举 → 召回 + Beam）、
  `src/coach/team-candidates.mjs:15`、`:47-49`（`RECALL_MIN 20 / RECALL_MAX 50`）、`:1135-1140`（`DEFAULT_BEAM_BUDGETS`）、
  `:98-131`（`FORBIDDEN_ONLINE_PATTERNS`：在线路径**不许**出现 `step_joint` / `plan_actions` / `child_process` / `spawn` / `RocoClient`）。

### P5 —— 「不知道」是**一等公民**：弃答要记账、要有判据、要有正确率

- **可判定写法**：每个会回答事实的组件必须能返回弃答，且弃答带**原因码**；
  同时统计**两个方向**——该弃没弃（危险）与不该弃却弃了（过度保守）。
- **反例**：为了让指标好看把该弃答的问成「给一条最像的」；或者相反，为了保守把能答的全部弃答。
- **现有落点**：`src/coach/rag-index.js:76-80`（三种原因码）、`docs/roco/RAG-EVAL.md:191`（弃答精确率＝防守过度弃答）、
  `docs/roadmap/CULTIVATION-PAGE-PLAN.md:66`（缺证据时必须弃答）。

### P6 —— 反思**有上限**，且错误反馈必须是**程序生成的收据**

- **可判定写法**：纠错预算是一个**有限整数**（现为全局 1 次），且失败回执由代码写成
  `{error, hint, contract}`，**不许**让模型自己总结「我上次错在哪」当事实。
- **反例**：无限 Reflexion 循环；或者让模型自述失败原因并把它当作事实输入下一轮
  （外部资料指出反思型 agent 的记忆会**自我编造**：`docs/roadmap/AGENTIC-TECH-IDEAS.md:40`，`[外部]` 未在本仓验证）。
- **现有落点**：`src/coach/runtime.js:268-292`（一次纠错券，「全局只允许一次」）、`:281`
  （干净路径一个字节都不变，有逐字节钉）。

### P7 —— 降级必须**留痕**，而且「没回来」与「说错了」**分开记账**

- **可判定写法**：`late/timeout`（LLM 没回来）与 `validation.rejected`（LLM 说错了）必须是两个字段，
  不许合并成一个 `degraded`。
- **反例**：把超时与守卫拒绝都写成 `provider:'local-fallback'` 一句了事（玩家与后续排障都无法区分「慢」与「错」）。
- **现有落点**：`docs/roadmap/MODEL-ROUTING-PLAN.md:129-131`（三条不许破的语义：主动不要 vs 超时降级分开记账；
  缺的恒 `null` 不补默认值；降级必须留痕）、`src/coach/runtime.js:150-157`。

### P8 —— 模型不许**越权结算**，也不许**越权定档**

- **可判定写法**：伤害/胜负/合法行动/支持度四类字段，**只允许**来自引擎与已登记产物；
  回执里出现别的来源即判红。
- **反例**：让模型判断「这只能不能模拟」（支持度定档）；或者让模型「估算一下大概掉多少血」。
- **现有落点**：`docs/roadmap/MODEL-ROUTING-PLAN.md:262-264`（红线 1、2）、`src/coach/toolbox.js:22-27`（`HARD_TOOLS` 只有三个，且都要经过引擎）。

---

## 3. 架构：600 只 + 复杂机制下的 agent 结构

### 3.1 五层结构（沿用仓内既有骨架，不推倒重来）

```text
玩家提问 / 阵型请求
   │
   ├─【L0 状态与版本层】  stateToken + ruleset_config_id + as_of       ← 脚本（唯一事实源）
   │      职责：谁在场上、什么版本、什么合法行动；陈旧即作废
   │
   ├─【L1 检索层 RAG】     1694 篇文档（现算）/ 别名表 / BM25 / rerank / 弃答  ← 脚本打分，模型消费
   │      职责：把「600 只 + 824 技能 + 245 特性 + 台账 + 配置」变成可检索证据
   │      硬性：弃答是合法输出；provenance 必须能追到磁盘（groundDocument）
   │
   ├─【L2 工具层】         3 个硬工具 + 只读规则域工具 + 引擎查询工具      ← 引擎执行，模型发起
   │      职责：凡「事实」必须走工具；凡「结算」必须走引擎
   │
   ├─【L3 计划 / 反思层】  planner（模型）→ 回执 → 再决定；全局一次纠错；stale 作废
   │      职责：选择、组合、判断证据够不够、不够就弃答
   │
   ├─【L4 记忆层】         跨局：journal / reflections / stated 偏好 / next-match 核对
   │      职责：把「上一局说过什么」带过去；**每条记忆必须带证据 id，不许模型自述**
   │
   └─【L5 守卫层】         checkGroundedAnswer + checkReceiptConsistency + 胜率禁令  ← 纯字符串/正则
          职责：数字/引用/确定性承诺/回执一致性；命中即整段丢弃并如实记账
```

### 3.2 哪些**必须走工具**、哪些**必须走引擎**（不可互换）

| 问题类型 | 必须走 | 为什么 | 出处 |
|---|---|---|---|
| 某个具体回合当时发生了什么 | **工具** `read_evidence` | 证据包里只有最近回合 | `src/coach/toolbox.js:22-27` |
| 两个具体行动的分支后果 | **工具** `simulate_branch`（内部调引擎） | 需要计算，证据包里没有 | 同上 |
| 整局范围统计 / 翻更早回合 | **工具** `read_match`（分页） | 同上 | 同上 |
| 包里没有的战术规则 | **工具** `search_rules` | 需要检索 | 同上 |
| 精灵/技能/学习表/属性相性/术语 | **只读工具** `query_rules`（经 `coach/roco-client.js`） | 机制未支持时返回 `unsupported`，**不含编造数值** | `src/coach/toolbox.js:157` |
| 伤害 / 胜负 / 能量扣除 | **引擎**（`joint-step` / replay） | 唯一可复算事实源；红线 1 | `docs/roadmap/MODEL-ROUTING-PLAN.md:262` |
| 合法行动裁剪 | **引擎** `rs.is_learnable` | 服务端自造可学表会漂（已有 2/48 漂移前例） | `docs/roadmap/CULTIVATION-PAGE-PLAN.md:49` |
| 支持度定档 | **已登记产物**（`support-classification.json` 等） | 定档是「按部件取最坏件」的可复算过程，不是判断 | `roco/src/roco_env/support.py:60`、`:44` |
| 配队评分 / 排序 | **脚本**（`team-candidates.mjs`） | 纯函数、可复算、实测 11–15 ms | `docs/roadmap/MODEL-ROUTING-PLAN.md:51` |
| 阵容/机制的**解释与归纳** | **模型** | 不可复算，属于解释 | `docs/roadmap/MODEL-ROUTING-PLAN.md:100` |

### 3.3 **不能**交给模型的三件事，以及为什么

> 这一节是这份方案里最不许被后来实现放松的一节。

**（一）伤害与胜负 —— 不能交给模型。**
理由有三条，每条都可判定：
1. **红线**：三档模型里**没有一档**参与结算（`docs/roadmap/MODEL-ROUTING-PLAN.md:262-264`）。
2. **可复算性会被摧毁**：8 条 golden 指纹 + 6048 条轨迹复验钉着引擎行为
   （`docs/roadmap/AGENTIC-TECH-IDEAS.md:46`）；模型输出**无法被逐位复验**。
3. **有实证**：模型与规则臂逐任务配对，**退化 42 / 扳回 0**（`docs/roadmap/MODEL-ROUTING-PLAN.md:74`）。

**（二）支持度定档 —— 不能交给模型。**
「这只精灵能不能模拟」是**部件级最坏件**的可复算结论
（`roco/src/roco_env/support.py:44` 的 `SEVERITY` 表 + `:60` `classify_pet`），
而且**刻意不用「最坏件」以外的任何启发式**——文档明确写了为什么
（`docs/roco/RC-403-SUPPORT-CLASSIFIER.md:34-35`：最坏件会把 599 只明明能上场的精灵判成「只有资料」，
**那句话是错的**）。让模型「估个大概支持度」等于把一条**有明确算术**的判断换成印象，
而且会让页面/训练数据分档失去依据（`docs/roco/RC-403-SUPPORT-CLASSIFIER.md:52-54`）。

**（三）合法行动裁剪 —— 不能交给模型。**
引擎有 `ENERGY_MAX=6` 这类**源码自注「假设」**的常量
（`docs/roadmap/FLAGSHIP-V3-REDIRECT.md:16`），而冻结快照里有 **20 条能耗 > 6 的技能**
（同文件 `:184-185`：8 点 3 条、10 点 3 条、1 条记 30 点数值可疑）——
**在 `ENERGY_MAX=6` 下它们永久不可用**。这正是「规则基线错了会污染行动合法性」的实证：
合法行动集是**规则表算出来的**，不是「看起来能不能用」。一旦让模型裁剪，
面板上的合法行动会与引擎回执不一致，而 `checkReceiptConsistency` 只能事后抓，抓不全
（它自注 `Narrow by design, not a proof of full correctness`，`src/coach/runtime.js:422`）。

### 3.4 计划 / 反思 / 记忆：600 只规模下具体要加什么

| 部件 | 现状 | 600 只规模下要加的 | 不许加的 |
|---|---|---|---|
| **计划** | 政策首枪（脚本）+ 模型后续 2–3 步（`src/coach/runtime.js:293-349`） | ①把 `searchIndex` 变成**模型可发起的检索工具**（今天 `retrieve` 只在 `search_rules` 分支里被调用，`:261-263`）；②让模型能看到**检索诊断**（命中数 / 过滤退回 / 弃答原因）再决定下一步 | 不许让模型自由决定是否走引擎（P8） |
| **反思** | **一次纠错券**（`:268-292`） | 把纠错**分类**（工具名错 / 参数错 / 重复 / 工具抛错），并让每类的 `hint` 更具体；**上限不变** | 不许无限循环；不许模型自述失败原因（P6） |
| **stale 作废** | `stateToken` + 规划版本作废 | 把**检索回执**也绑 `state_version`（`query_rules` 已经有这条：状态版本不一致时**拒绝执行**，`src/coach/toolbox.js:157`） | 不许「拿过期局面去问模型」后照用 |
| **记忆（跨局）** | `journal` / `reflections` / `stated` 偏好；`assembleContext` 会按任务过滤并**丢掉没有证据支撑的反思**（`src/coach/runtime.js:368-377`） | 记忆条目**必须带证据 id**；跨局核对保持 `checked/recurred/improved` 三态，**不许把「没出现」说成「做到了」**（`docs/roadmap/AGENTIC-TECH-IDEAS.md:73`） | 不许编造型记忆（P6 的外部反面证据） |
| **守卫** | 服务端 + 浏览器两层（`src/coach/runtime.js:138-157`） | 新增能力（检索工具、多步计划）全部复用**同一份**守卫函数，**不许抄第二份实现** | 不许只在浏览器层守（那是已修过的缺口） |

---

## 4. 与现有判据的关系

### 4.1 新增能力各配什么判据与**必红反证**

| # | 新能力 | 判据 | **必红反证**（什么输入必须让它红） |
|---|---|---|---|
| J1 | **RAG 成为 agent 的一等检索工具** | ①工具回执带 `doc_id` + `provenance` + `abstained/reason_code`；②`groundDocument` 逐条检查 artifact 存在 / sha256 命中 / pointer 可解析（`src/coach/rag-index.js:999`）；③弃答率与**弃答精确率**同时报（`docs/roco/RAG-EVAL.md:191`） | ①把任一结果的 `provenance` 抹掉 ⇒ `grounded precision` 必须下降且判据翻红（已有先例反证 R3，`docs/roco/RAG-EVAL.md:299`）；②把该弃答的查询的 `min_evidence_level` 拿掉 ⇒ 必须红（已有反证，`:283`） |
| J2 | **多步计划（≥3 步）** | 步数上限仍是 `Math.min(4, limit)`；每步回执都进 trace；`stopped` 取值分类可判 | 把步数上限改成无界 ⇒ 必须红；让同一 `(tool,args)` 复活 ⇒ `seen` 去重必须红（`src/coach/runtime.js:327-331`） |
| J3 | **工具调用的最小充分性**（不是越多越好） | 在**留出集**上同时报：工具选择正确率、**多余调用率**、单例 token、首字延迟；**四项必须同时不退化** | 掐掉一条必要事实 ⇒ 守卫必须拒答（而不是照答）；token 降了但一致性降了 ⇒ 判红（`docs/roadmap/AGENTIC-TECH-IDEAS.md:91`） |
| J4 | **错答滑落防护**（弃答→错答） | 探针集**只跑一次、不回调措辞**，失败也登记；`NO_MATCH` 方向的探针必须 ≥10 条 | 把 P10 类的探针从失败登记改成「按关键词弃答」⇒ 必须判为**对探针过拟合**（`docs/roco/RAG-EVAL.md:346-348` 已明写这条界限） |
| J5 | **跨局记忆可核对** | 记忆条目必须带证据 id；`checked/recurred/improved` 三态不许把「没出现」说成「做到了」 | 把一条无证据的记忆条目写进 `reflections` ⇒ 必须在 `assembleContext` 的过滤里被丢掉（`src/coach/runtime.js:371`） |
| J6 | **降级分开记账** | `late/timeout` 与 `validation.rejected` 必须是两个字段；`provider`/`fallbackReason`/`validation`/`agentStop`/`stopped` 全部留痕 | 把两种降级合并成一个字段 ⇒ 必须红（`docs/roadmap/MODEL-ROUTING-PLAN.md:129-131`） |
| J7 | **模型/脚本分工不漂** | 四类字段（伤害/胜负/合法行动/支持度）的来源白名单 | 让模型产出一个伤害数字 ⇒ 守卫 `unsupported-number` 必须红（`src/coach/runtime.js:463`） |
| J8 | **胜率禁令** | `BANNED_CLAIM_KEYS` 键名检查 + `BANNED_CLAIM_WORDS` 词表 + **否定语境豁免**（前面 12 字符内有否定词不算违规） | 写「这只的胜率是 62%」（无否定词）⇒ 必须红；写「不是胜率」⇒ **不许红**（否则会逼实现方删掉最该保留的边界声明，`src/coach/team-candidates.mjs:1816-1824`） |

### 4.2 这套改动会**威胁**哪些现成判据（必须提前认账）

> 这是本节最值钱的一段：下面每一条都是**会因为「让 agent 多说话/多发工具」而变红**的既有判据。

| 被威胁的判据 | 威胁从哪来 | 现有钉法是怎样的 | 处理原则 |
|---|---|---|---|
| **产物摘要 / 禁止重跑清单**（13 条） | 新增能力一旦改动引擎或规则主题，登记图会算出**新的受影响产物** | `20/20 条受影响`、13 条进 `do_not_regenerate`（`docs/roadmap/FLAGSHIP-V3-REDIRECT.md:91-107`）；「把某条依赖删掉，那条产物必须从受影响清单里消失」是它的牙（`:111`） | **先登记新主题再施工**；不许为了让清单变短而删依赖 |
| **已录制 agent 轨迹**（`traj-rule-arm-v1` / `traj-model-arm-v1` / `model-error-trajectories-v4`） | 任何**工具合同字段变化**都会让轨迹对不上 | `docs/roco/RC-403-SUPPORT-CLASSIFIER.md:62-63` 逐字写着：接口本轮**没有**改动，因为「那条回执被已录制、禁止重跑的 agent 轨迹钉着，**加字段会让它们全部对不上**」 | 新字段走**新端点或新工具**，不许往被钉的回执里加字段 |
| **轨迹复验 + 8 条 golden 指纹** | 影响引擎行为的改动 | `docs/roadmap/AGENTIC-TECH-IDEAS.md:46` | 本轮方案**完全不碰引擎**（§5 各阶段都不改 `roco/src/roco_env/**`），所以这条**不应被触发**；一旦被触发就该停下来重新评估 |
| **RAG 查询集清单 `query_manifest`（sha256）** | 语料变了 → 期望值可能不再成立 | 删改任何一条查询都必须 `--refresh-manifest` 显式承认（`docs/roco/RAG-EVAL.md:270`、`:288`、`:388`） | 语料变更后**先改期望值并写清新出处**，再刷 manifest（`:387`） |
| **云臂身份守卫** | 新增模型臂 / 新 provider | `reports/roco/shadow-replay-*.json` **不许**写 DeepSeek 报告（`docs/roadmap/MODEL-ROUTING-PLAN.md:77`） | deepseek 臂要新产物 + 记身份，不许混进 `shadow-replay-*` |
| **影子工具面板提示 sha256** | 改提示词 | 逐字复刻评测那份提示，**改一个字就红**（`docs/roadmap/MODEL-ROUTING-PLAN.md:78`） | 提示要改就**同时**改面板与评测，且用一次显式承认（与 manifest 同一套做法） |
| **agent-loop-correction 的逐字节钉** | 扩展纠错逻辑 | 「干净路径（一次就对）**一个字节都不变**」（`src/coach/runtime.js:281`） | 扩展纠错**只许改错误路径**，干净路径必须逐字节不变 |
| **服务端守卫的必红反证** | 新增模型输出通道 | `tests/roco-server-side-guard.test.js:121` 有「回退成只有浏览器守」的反证（`docs/roadmap/MODEL-ROUTING-PLAN.md:234`） | 新通道**必须**过同一份守卫；不许新开一条没守卫的输出路径 |
| **页面验收（`roco-ux-acceptance` 39 条）** | 三级导航改造 | 现按「营地=首页」写的，改造后要跟着改，但「**判据口径不许放松**：改的是读取点，不是标准」（`docs/roadmap/CULTIVATION-PAGE-PLAN.md:89-90`） | 同上 |
| **RAG 评测未接闸门** | 有人以为它已经在守 | `docs/roco/RAG-EVAL.md:381-382` 明写：本评测**没有**接进 `verify-release.mjs` | 要接闸门必须主线程显式登记，**不许默认它已经在守** |

### 4.3 一条必须写下来的元判据

> **任何新增的 agent 能力，都必须能回答：「如果把它关掉，哪条判据会红？」**
> 答不出来的能力 = 没有判据的能力 = 不许合入。这条与 `docs/roadmap/FLAGSHIP-V3-REDIRECT.md:111-112` 的
> 「把某条依赖删掉，那条产物必须从受影响清单里消失」是同一个形状，只是对象从产物换成了能力。

---

## 5. 分期：5 个可独立验收的阶段

> **共同纪律**：本方案**不改 `roco/src/roco_env/**`**（引擎不动）⇒ 不应触发 golden 指纹与轨迹复验。
> 每阶段都必须**独立可验收**（有判据 + 有必红反证 + 有产物），且**失败可安全回退**。

### 阶段 A —— 把「该不该调工具」的口径定死（**前提，不是选项**）

| 项 | 内容 |
|---|---|
| **做什么** | 在（甲）「实时状态必须查证」与（乙）「不浪费调用 + 数字必须被守卫守住」之间**由人类拍板**；拍完之后把 planner 提示与 `cat1` 期望口径统一到同一份（两份出路见 `docs/roadmap/AGENTIC-TECH-IDEAS.md:83`） |
| **判据** | 工具选择率（现 **33/49 = 0.673**，`reports/live-model-eval.json`）在**留出集**上重新量一遍，**新旧并列报出**；参数 5/5、证据 5/5、一致性 47/49 不许退化 |
| **必红反证** | 把提示改回原版 ⇒ 指标必须回落到 0.673 附近（说明指标真的在测提示，`docs/roadmap/AGENTIC-TECH-IDEAS.md:34`） |
| **依赖** | 无（不需要引擎、不需要新依赖、不需要冻结层） |
| **工作量** | 1 轮（含一次带 key 的重测） |
| **要 key 吗** | **量指标需要 key**（云臂）；**改提示与判据不需要** |

### 阶段 B —— RAG 变成 agent 的一等检索工具

| 项 | 内容 |
|---|---|
| **做什么** | ①把 `searchIndex` 接成模型**可主动发起**的检索路径（今天 `retrieve` 只挂在 `search_rules` 分支里，`src/coach/runtime.js:261-263`）；②回执带**检索诊断**（候选数 / `filter_fallback` / `abstained` + `reason_code` / top-1 等级）；③把「语料现算 1694 篇」这件事写进产物，消除 §1.2 的**文档/报告漂移** |
| **判据** | J1 + J4；`grounded precision`、弃答率、**弃答精确率**三项同报；`--check` 必须与磁盘报告逐字节一致（`docs/roco/RAG-EVAL.md:317`） |
| **必红反证** | ①抹掉任一结果的 provenance ⇒ grounded 判据红（已有 R3 先例）；②把该弃答的 `min_evidence_level` 拿掉 ⇒ 弃答率红（已有 C01 反例） |
| **依赖** | 阶段 A（口径不定，检索多查一次也会被口径判成「多余调用」） |
| **工作量** | 1–2 轮 |
| **要 key 吗** | **不需要**（判据全在离线的 45 + 13 条查询集上） |

### 阶段 C —— 多步计划 + 纠错分类 + 检索侧 stale 作废

| 项 | 内容 |
|---|---|
| **做什么** | ①纠错券的 `hint` **按错误类**写具体（工具名/参数/重复/抛错四类）；②`search_rules` 之外的检索回执也绑 `state_version`（照 `query_rules` 的做法，`src/coach/toolbox.js:157`）；③把 stale 作废从「规划版本」扩到「检索回执」 |
| **判据** | J2 + J6；步数上限仍 `Math.min(4, limit)`；`stopped` 分类齐全 |
| **必红反证** | ①让同一 `(tool,args)` 复活 ⇒ 去重必须红；②干净路径（一次就对）必须**逐字节不变**（`src/coach/runtime.js:281` 的既有钉）；③拿过期 `state_version` 的检索回执去作答 ⇒ 必须被作废并如实标记 |
| **依赖** | 阶段 B |
| **工作量** | 1 轮 |
| **要 key 吗** | **不需要**（纠错与 stale 的判据都在离线轨迹套件里） |

### 阶段 D —— 跨局记忆可核对 + 「不知道」的指标化

| 项 | 内容 |
|---|---|
| **做什么** | ①记忆条目强制带证据 id（无证据的在 `assembleContext` 里被丢掉，`src/coach/runtime.js:371` 已有这条过滤，把它变成显式判据）；②把**弃答率**与**弃答精确率**从 RAG 评测抬到产品面指标（玩家问到的每个事实型问题都要么有出处、要么明确弃答） |
| **判据** | J4 + J5 |
| **必红反证** | ①塞一条无证据的记忆到 `reflections` ⇒ 必须被丢；②把「没出现」写成「做到了」⇒ 三态判据必须红；③把该弃答的答成结论 ⇒ 弃答精确率必须下降 |
| **依赖** | 阶段 B（弃答的口径来自检索层） |
| **工作量** | 1 轮 |
| **要 key 吗** | **不需要** |

### 阶段 E —— 云端 / 本地质量对照与成本口径（可选，但**最该补的证据**）

| 项 | 内容 |
|---|---|
| **做什么** | 同提示集跑 4B 网关与 DeepSeek，产 `reports/roco/model-quality-compare.json`（`docs/roadmap/MODEL-ROUTING-PLAN.md:227` R1）；补「配队解释一次多少 token」（同文件 `:289-290` 的第 4 条不确定项） |
| **判据** | 两边都记**模型身份 + 采样参数 + 提示 sha256**；差异逐条列出 |
| **必红反证** | 把身份去掉、或把 provider 写死 ⇒ 必须红（身份守卫已有先例，`docs/roadmap/MODEL-ROUTING-PLAN.md:77`） |
| **依赖** | 阶段 A（口径定了对照才有意义） |
| **工作量** | 1 轮 |
| **要 key 吗** | **需要 key**（这是本方案里唯一必须联网带 key 的阶段） |

### 5.1 依赖图与「不需要 key」的边界

```text
A（定口径 / 要key量指标）───┬──> B（RAG 进工具循环 / 不需要 key）───┬──> C（多步+纠错+stale / 不需要 key）
                            │                                      └──> D（记忆+弃答指标 / 不需要 key）
                            └──> E（质量对照 / 需要 key，可选）

A 是本方案唯一的前提节点：口径不定，后面所有优化都在错的靶子上打分
（docs/roadmap/AGENTIC-TECH-IDEAS.md:136-140）。
B/C/D 三个阶段**全部不需要 key** —— 它们的判据跑在离线产物、离线轨迹套件、离线查询集上。
```

---

## 6. 风险与红线（这一节不许被后来的实现放松）

### 6.1 五条不许破的红线

1. **不许造胜率 / 概率 / 百分数。** 模型分数、通过率、覆盖率都**不是**胜率
   （`docs/roadmap/MODEL-ROUTING-PLAN.md:265-266`）。
   机读落点是 `BANNED_CLAIM_KEYS` / `BANNED_CLAIM_WORDS` / `NEGATION_MARKERS`
   （`src/coach/team-candidates.mjs:1808-1826`）与 `no_win_rate: true`（`:1585`、`:2371`）。
   **本条与外部「校准概率」类模型直接冲突，见 §6.4。**
2. **LLM 只解释不结算。** 三档里没有一档参与伤害/胜负/合法行动/状态版本
   （`docs/roadmap/MODEL-ROUTING-PLAN.md:262-263`、`models/registry.json` 的 `forbidden` 第 2 条）。
3. **RAG 失败要弃答，不是编。** 三种弃答原因码是**默认的保守方向**
   （`src/coach/rag-index.js:76-80`）；`NO_MATCH` 方向是**当前最大的风险面**
   —— 换个说法命中泛词就可能从「弃答」滑成「给一条错答案」（`docs/roco/RAG-EVAL.md:352-355`）。
   已知活例子：P10「冰系被哪些属性克制」**保留失败**（`docs/roco/RAG-EVAL.md:346-348`）。
4. **不知道必须是一等公民。** 缺的字段恒 `null`，**绝不补默认值**；缺证据时必须弃答
   （`docs/roadmap/MODEL-ROUTING-PLAN.md:130`、`docs/roadmap/CULTIVATION-PAGE-PLAN.md:66`）。
5. **降级不许静默。** 命中守卫 ⇒ 整段丢弃 + 如实写 `rejectedReason`；`late` 与 `rejected` 分开记账
   （`src/coach/runtime.js:150-157`、`docs/roadmap/MODEL-ROUTING-PLAN.md:129-131`）。

### 6.2 延迟预算（引 `docs/roadmap/MODEL-ROUTING-PLAN.md` 的 3 秒分段）

现状实测：规则段（状态 → 召回 → Beam → 诊断 → 候选 → 五轴）端到端 **10.5–13 ms**
（`reports/roco/team-serving/latency-live-2026-09-25.json`：`first` 中位数 10.99ms、`full` 中位数 12.18ms），
即 3000ms 里只用了约 **0.4%**（`docs/roadmap/MODEL-ROUTING-PLAN.md:20`、`:178-183`）。
**红线是「别把 15ms 变成 3000ms」，不是「把 3 秒塞满」。**

| 段 | 预算 | 放哪一档 | 本方案会不会动它 |
|---|---|---|---|
| ① 规则段 | ≤ **300ms**（实测 11–15ms） | **规则引擎** | **不动** |
| ② 初判上屏 | 300ms 内 | **规则引擎**，**永远不依赖模型** | **不动**（新增检索段不许进 `required_for_first`） |
| ③ 解释段（短） | ≤ **500ms** | Qwen3.5-4B 本机（p50 363ms / p95 470ms，`:40`） | 阶段 B 的检索诊断会**增加提示体积** ⇒ 必须与单例 token / 首字延迟一起量（J3） |
| ④ 解释段（长/可选） | ≤ **2500ms** | DeepSeek API | 阶段 A/E 会改它的提示 ⇒ 只许**增量替换文字**，不许阻塞 ①②（`:213`） |
| ⑤ 服务端事实守卫 | **~0**（纯字符串/正则） | `checkGroundedAnswer` + `checkReceiptConsistency` | 复用，**不发模型请求、不吃网络预算**（`:270-271`） |
| ⑥ 27B | **不进这条链** | 只在离线批处理 | 不动（`:210`） |

**新增能力带来的延迟风险，逐条**：
- **多步计划**：每多一步模型调用 ≈ 一次 2500ms 档的 `plan`（`src/server/index.js:423` 的 `2500` 超时）⇒
  现有上限 `Math.min(4, limit)` **不能放宽**（`src/coach/runtime.js:310`）。
- **检索诊断进提示**：`assembleContext` 的工作预算是 `WORKING_CONTEXT = 200000` 字节、
  输出预留 4096、系统 4096、工具 2048（`src/coach/runtime.js:359-364`）；实测 49 例烧了 **104 926 API input tokens**
  （≈2.1k/例，`docs/roadmap/AGENTIC-TECH-IDEAS.md:56`）⇒ 检索诊断必须**有界**（top-K 摘要，不是全文）。
- **串行闸门**：新增的 explain/检索段**不许抢** `/api/coach` 的 `inflight` 闸门
  （`/api/opponent` 已故意绕开它，`docs/roadmap/MODEL-ROUTING-PLAN.md:272-273`）。

### 6.3 规模上来之后的三个新风险

| 风险 | 为什么在 600 只规模下变严重 | 缓解 |
|---|---|---|
| **检索召回质量随语料膨胀下降** | 语料从 pack 的 1446 实体涨到 1694 篇文档；别名表**没有同义词扩展**，玩家简称直接 `NO_MATCH`（`docs/roco/RAG-EVAL.md:363-364`） | 别名表要做「机械规则 + 可登记的同义词表」两段，同义词表**带出处**（不许凭印象加） |
| **`NO_MATCH` 的标定失效** | 门槛 `SCORE_FLOOR = 25` 是**在 1678 篇语料下标定**的（`:240-253`）；语料变了标定就要重做 | 语料每次变更后**重跑 `score_calibration`**，并把这个数字写进产物 |
| **支持度分档被误读成「能模拟 622 只」** | 真实是 `FULL_VERIFIED 0 / SIMULATABLE 12 / PARTIAL 610`（`reports/roco/rc403/support-classification.json`） | 页面与训练数据生成器**必须按 `build_support` 分档**，不许把两者混成一句「引擎支持的精灵」（`docs/roco/RC-402-ON-DEMAND-BUILDS.md:79-80`） |

### 6.4 「用 Jev 这类**校准概率**模型」与本仓红线的**直接冲突**（必须写清）

`[外部]` Jev 是 TypeSafe AI 的 System One 模型（发布 **2026-09-15**，全量开放 **2026-09-21**），
卖点正是**返回预定义选项的概率与置信度**（LangChain blog，**2026-09-17**，
https://www.langchain.com/blog/building-a-harness-with-jev ；官方
https://typesafe.ai/blog/introducing-system-one-models-and-jev ，**该页 JS 渲染、正文读不出来**）。
仓内 `docs/roadmap/JEV-DECISION-EVALUATION.md:7` 已经把它描述为「公开接口返回**预定义选项、概率与置信信息**」。
**注意**：**它不是一个「不准的概率」问题，而是一个「概率本身就在漂移」的问题**——见下面前两条硬证据。

**冲突**：红线 1 说「**不造概率/百分数**」。
**化解（唯一的合规用法）**：Jev 的概率**只能当内部路由/门控信号**，
**永远不许出现在玩家可见的正文里**，也**不许被当成胜率**。
仓内已经把它限定在两处——① 介入门控（`silent`/`brief_hint`/`expandable_hint` 三选一）、
② 问题路由（阵容/培养/战况/复盘/陪练），且「规则引擎仍负责合法行动、伤害和胜负事实；
正式 PVP 权限先于模型」（`docs/roadmap/JEV-DECISION-EVALUATION.md:9-11`）。
**并且它自己写着「结构化输出保证类型，不保证判断正确」**（同文件 `:35`）。

**四条会把「内部信号」这个用法也推翻的硬证据**（`[外部]`，独立第三方测试 + 官方 limitations 页，
逐条出处见 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md` §2.5 / §2.7 / §2.8）：

| # | 证据 | 为什么它影响「只当内部信号」这个折中 |
|---|---|---|
| 1 | **它不是确定性的**：三家独立实测显示同一输入只有 **24%～39%** 逐位相同，同 payload 概率漂移最坏 **0.17**，732 个决策里有 **1.6% 跨过阈值翻转了判定** | 「同一局面给同一门控结论」做不到 ⇒ 与本仓「可复算」的纪律**根本冲突**；而且它会让**同一问题两次得到不同建议**，这是玩家可见的不一致 |
| 2 | **52% 的决策位概率恰好等于 1.0；`confidence` 在 47% 的 choice/score 回答上不等于最大返回概率** | 任何「置信度 ≥ 0.95 才自动执行」的闸门**形同虚设**（超一半直接通过）⇒ 「只在内部用」的收益也被削掉一大半 |
| 3 | **中文（CJK）精度官方明说降级**：官方原文「Other languages, including CJK scripts, are handled but **not equally well**; test on your own content before relying on Jev for a non-English workload」 | **本仓的玩家与语料是中文**。在评测之前，「用它做门控」这件事**没有任何证据支撑**；而且「置信分桶校准」这个判据项必须在**中文 state + 本仓真实问题分布**上**从零重量** |
| 4 | **对抗内容可被翻转**：伪造权威型注入在 200 张票里**翻转了 147 张**的判定；而 0.8 闸门能抓住 95.5% 的「缺事实」，却抓住 **0%** 的「通顺胡话」 | 只要 state 里含**任何玩家可控文本**（本仓的 `playerMessage` 就是），门控**可被玩家操纵** ⇒ 与「正式 PVP 权限先于模型」这条纪律叠加后会变成一个真实的安全面 |

**⚠ 引用纪律（本次调研最容易出错的一处）**：`RLCD` 有**两个完全不同的含义**——
TypeSafe 的厂商术语 **R**einforcement **L**earning for **C**alibrated **D**ecisions
（**没有找到学术一手来源**）与 ICLR 2024 的
**R**einforcement **L**earning from **C**ontrastive **D**istillation（arXiv:2307.12950）。
**把后者当成 Jev 的训练方法是错误引用**，两者没有任何继承关系的证据。

⇒ 结论：Jev 属于本方案**阶段 E 之后**的可选实验，**不属于 600 只规模问题的解**；
它的正确姿态是「**只做内部分流，不进入任何数值型用户输出**」，
而且**在中文 + 本仓真实分布上重量之前连内部分流都不该接**。
详细评估见 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md`。

### 6.5 明确劝退（沿用并强化 `AGENTIC-TECH-IDEAS.md` §3）

| 劝退项 | 本文补的理由 |
|---|---|
| 用世界模型/JEPA 替代规则引擎 | 外部有**直接反面证据**：Agentic-JEPA 在分布内 100% 成功，但在**每一个分布外环境上 0% 成功**，作者自己把它归因为「编码器按环境身份而不是功能角色划分表征」（Zenodo preprint v2，**2026-05-16**，https://zenodo.org/records/20237490 ）。**⚠ 引用限度**：这是**单作者、未经同行评审的自上传预印本**（HAL/Zenodo 均标 Preprint，作者自己的 BibTeX 里 arXiv 编号还是占位符 `XXXX.XXXXX`）⇒ **只能说「有这样一个预印本」，不许说「有研究证明/已发表论文表明」**。600 只精灵里绝大多数就是「分布外」 |
| 把 LLM-as-judge 当判定闸门 | 本仓已有更硬的预注册判据 + 离线回放（`docs/roadmap/AGENTIC-TECH-IDEAS.md:108`） |
| 现在接 MCP / 拆多智能体 | 同上 `:109`；本仓工具合同已有 **13 个工具** + 显式参数 schema（`src/coach/toolbox.js:144-162`），接协议只增进程/网络面。**`[外部]` 另有一条减分项**：Simon Willison（2025-10-16）指出 MCP 的 **token 开销**是显著缺陷（GitHub 官方 MCP 单独就吃掉数万 token context），而本仓正在做的正是**上下文瘦身** |
| 用模型算伤害/胜负/概率 | 红线；且会让 8 条 golden 指纹 + 6048 条轨迹复验变成**不可复算**。**`[外部]` 补充**：Jev 官方 limitations 页（Last reviewed 2026-09-17）自己就写着它**不是计算器、计数不可靠、误差随规模增长，并建议「在代码里数」** |
| 把「Agent Skills」直接照搬进来当第二套指令源 | 本仓的工具合同已经是等价物且更严（回执必须带 `ruleset_id / state_version / evidence_ids`，`src/coach/toolbox.js:154-156`）；`SKILL.md` 式「可装载指令」会变成**第三份事实源**，与 `docs/roco/GAME-DATA-PACK.md:160-168` 的纪律冲突 |

---

## 7. 读不出来 / 未验证（**别当成事实**）

1. **RAG 评测现在到底是绿是红 —— 读不出来。** 文档说 13/13 通过、弃答率 1.000
   （`docs/roco/RAG-EVAL.md:273`、`:213`）；磁盘报告（2026-09-23T19:59）说弃答率 **0.909**、
   且报告里**没有 gates 段**。本任务明令**不跑门禁**，所以我没有跑 `--check`。
   **必须以重跑后的产物为准。**
2. **`docs/roco/RC-403-SUPPORT-CLASSIFIER.md` 与 `reports/roco/rc403/support-classification.json` 不一致 —— 谁新谁对读不出来。**
   文档写 `SIMULATABLE 8 / PARTIAL 614`、特性卡点 609（`:42`、`:47`）；报告写 `12 / 610`、特性卡点 605。
   报告 mtime（2026-09-22 10:26）**晚于**文档（10:17），所以我按「报告更新」处理，
   但**没有独立复算**（那要跑 Python 分类器）。
3. **`docs/roco/RC-401-EFFECT-COVERAGE.md` 与 `reports/roco/rc401/effect-coverage.json` 不一致 —— 口径差异读不出来。**
   文档写 legacy 口径 **473/824**、声明连击后 **507/824**（doc §「关键口径」表）；报告写 **344/824 = 41.75%**。
   报告 mtime（2026-09-24 03:17）晚于文档（03:15）。两者用的可能不是同一个分母口径，但我**读不出来**差在哪。
4. **`searchKnowledge`（既有卡片检索）与 pack id 空间不是同一套**：基线 A 全 0 **不是**「旧实现差」，
   是它返回 `tactic:*` / `rule:skill:*`，与 `pet::…` / `EV-…` 不是一套 id
   （`docs/roco/RAG-EVAL.md:227-230`）。**不许把那个 0 当能力差距引用。**
5. **4B 与 DeepSeek 的质量对照从来没做过**（无产物）——这正是阶段 E 要补的（`docs/roadmap/MODEL-ROUTING-PLAN.md:283`）。
6. **「配队解释用 4B 够不够」没有证据**：现有 4B 评测量的是**工具选择**，不是「解释配队缺口」
   （`docs/roadmap/MODEL-ROUTING-PLAN.md:285-286`）。
7. **`ROCO_LOCAL_MODEL_27B_PATH` 已存在但没有任何代码路径会真的调用 27B** ——
   那是预留接口，**别误读成已接线**（`docs/roadmap/MODEL-ROUTING-PLAN.md:291-292`）。
8. **服务端守卫的补丁是未提交的工作树改动**（`git status` 显示 ` M src/coach/runtime.js`）；
   本文没有跑门禁，所以「它在 24 套里绿」**未经本轮复核**（同文件 `:293-295`）。
9. **本文所有外部资料均为 `[外部]`，未在仓内验证**，不得写成产品承诺。
   术语调研的逐条来源与日期见 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md`。
10. **`data/roco/normalized/**` 本文只读**；本文没有对冻结目录做任何写入、也没有重算冻结层数字。
11. **仓内对 `jev` 的判断有一处自相矛盾，且错的那一处更新**：
    `docs/roadmap/AGENTIC-TECH-IDEAS.md:158-159`（2026-09-25）说 `jev` **没有可信一手来源**，
    但更早的 `docs/roadmap/JEV-DECISION-EVALUATION.md:30-33`（2026-09-22）与
    `docs/roadmap/AGENT-FIRST-600-PLAN.md` §6 都**已经引了官方一手 URL**。
    ⇒ 以 `JEV-DECISION-EVALUATION.md` 为准；本文**没有改动那三份文件**。逐条证据见
    `docs/roadmap/AGENTIC-TERMS-RESEARCH.md` §2.12。
12. **`docs/roadmap/AGENT-FIRST-600-PLAN.md` §2 的「1678 文档」是旧数字**（当前现算 1694，见 §1.2）；
    该文件另有一处「agentic JEV 和 JEV」，人类原话是「agenticjev 和 jev」——
    两者都按同一份人类口径处理即可，但**引用数字时要换成当前值**。
13. **本次外部检索到的一手页面自标日期集中在 2026-09-17 ～ 2026-09-22**，这些日期**晚于检索工具的静态知识**，
    但它们是**实时抓取到的页面自己标注的日期**。`typesafe.ai` 主站 JS 渲染（正文读不出来）、
    官方 FAQ 页 **404** ⇒ 「官方承认仍可能出错」这句**只有二级转述，未取得一手原文**。
