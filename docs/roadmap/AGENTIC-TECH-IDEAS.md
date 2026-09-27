# Agentic 技术候选：扫一遍 + 对本仓的判断（2026-09-25）

> 起因：人类说「最近 **agenticjev / jev** 很火，看看是否有用，我不是太熟，提供个思路」。
> **那个词很可能是转述/拼写失真**，所以本文不纠结名字，直接把「最近一年 agent 圈真正在火、且与本仓有关」
> 的一组候选技术逐条过一遍给判断。
>
> **纪律**：① 外部资料一律标 URL + 日期，且**只当参考、不当事实**（仓内没有验证过的一律不许写成承诺）；
> ② 每条候选给：是什么 / 对本仓有没有用 / 落在哪个文件 / 判据与必红反证 / 工作量 / 风险；
> ③ 仓内数字都来自本会话实测产物，标注路径。

---

## 0. 本仓现状（做判断的基线，全部有出处）

| 维度 | 现状 | 出处 |
|---|---|---|
| agent 循环 | **只有一处**：`gatherAgentEvidence`（政策首枪 + 最多 3–4 步 + 2026-09-25 起**一次纠错券** + `stopped` 分类） | `src/coach/runtime.js:265+` |
| 云端臂实测 | 49 例：**工具选择 33/49 = 0.673**（15 条「该调没调」+1 条首枪不符）、参数 5/5、证据 5/5、一致性 47/49、stale 1/1；API input 104 926 tok | `reports/live-model-eval.json` |
| 「该调没调」的真因 | **口径冲突**：`buildContext` 把整份局面放进 receipts，而提示说「已能从 receipts 答出来就别调」 | `src/coach/runtime.js:23` + planner prompt |
| 守卫 | 服务端 + 浏览器两层：数字白名单/引用/确定性承诺（`checkGroundedAnswer`）+ 回执一致性 | `tests/roco-server-side-guard.test.js` |
| 可复现回放 | 云臂**离线录制回放**（指纹不含时间戳，未命中抛错，真输出不进仓） | `src/coach/cloud-replay.mjs`、`docs/roco/CLOUD-ARM-REPLAY.md` |
| 规模 | 图鉴 622；可模拟实体 **344/824**；按需推算 574 只；RAG 语料 **1694** 篇 / 检索判据 13/13（**开发集**数字） | `reports/roco/rc401/effect-coverage.json`、`reports/roco/rag/rag-eval.json` |
| 延迟预算 | 规则段 **11–15ms**；计划：4B ≤500ms / DeepSeek ≤2500ms / 27B 只离线 | `reports/roco/team-serving/latency-live-2026-09-25.json`、`docs/roadmap/MODEL-ROUTING-PLAN.md` |
| 训练侧 | RC-702/703 **NOT_STARTED**；RC-601 **BLOCKED**（候选规则未定）⇒ RC-605 也阻塞 | `docs/roadmap/FLAGSHIP-V3-CHECKLIST.md` |

---

## 1. 候选清单（8 条）

### ① GEPA 式**反思驱动的提示进化**（不是权重训练）
- **是什么**：用「轨迹 + 自然语言反思」迭代提示，论文自称在若干任务上优于 RL（ICLR 2026 proceedings：[GEPA](https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html)）。
- **对本仓有用吗**：**有用，但必须先解决口径冲突**。本仓天然具备它的三件套：预注册判据（49 例）、轨迹臂、离线回放门禁。
- **落点**：`docs/roadmap/MODEL-ROUTING-PLAN.md` §4（工程落点）＋ 新增一个离线优化脚本（不碰产品代码）。
- **判据**：工具选择率（现 0.673）在**留出集**上提升，且 `answerConsistency` 不降；**必红反证**：把提示改回原版必须回落到 0.673 附近（说明指标真的在测提示）。
- **工作量**：中（一轮）。**风险**：**对着评测过拟合** —— 必须留出集 + 不许改判据口径 + 判据口径本身先定死（见 §2 推荐一）。

### ② 自我纠正 / Reflexion 类
- **是什么**：让 agent 用「失败反馈」重试或多轮自省。
- **对本仓有用吗**：**已经在做**——2026-09-25 刚落地的「**一次纠错券**」（非法工具/非法参数/重复调用/工具抛错 → 错误回执喂回规划器一次，硬上限不变）。
- **要注意的反面证据**：有研究指出反思型 agent 的记忆会**自我编造**（[Honest Lying: Memory Confabulation in Reflexive Agents](https://browse-export.arxiv.org/pdf/2605.29463)，外部资料）。
  ⇒ 对本仓的直接含义：**纠错可以，但错误回执必须是程序生成的收据**（我们现在正是这么做的：`{error, hint, contract}` 由代码写），不许让模型自己总结「我上次错在哪」当事实。
- **落点**：`src/coach/runtime.js`。**判据**：已落地 8 条（`tests/evals/roco/agent-loop-correction.test.js`）。**风险**：低（已有上限与反证）。

### ③ JEPA / 世界模型类（替换规则引擎）
- **是什么**：以表征预测/世界模型替代逐步符号推理（相关公开讨论：[LeCun 谈世界模型与 LLM 局限](https://zdnet.co.kr/view/?no=20251027181618)，2025-10；[其离职创业做世界模型](https://en.tmtpost.com/post/7773738)，外部资料）。
- **⚠ 先澄清一处极易混的**：**JEPA（LeCun 的世界模型）与 `jev`（TypeSafe AI 的 System One，见 ⑨）完全无关**，只是名字像。本文第一版把它们混在一起，已更正。
- **对本仓有用吗**：**明确劝退**（见 §3）。本仓的红线是「伤害与胜负永远由 Python 规则引擎算」，而且 8 条 golden 指纹 + 6048 条轨迹复验钉着行为；换世界模型 = 把可复算性换成不可复算性。
- **可以吸收的部分**：只吸收**思路**——「先预测再行动」用在**解释层**（例如把「这一手之后大概会怎样」做成**声明未核验的**启发式并标注），**不参与结算**。

### ⑨ `jev` / TypeSafe AI「System One」（**术语澄清后的真事，不是 LLM**）
- **是什么**：TypeSafe AI 的 System One 模型（2026-09-15 发布、2026-09-21 全量开放）——吃 `state` + **有类型的 questions**，返回**决策 + 概率**（Noul / Choice / Score）。
  **本仓更早的文档已经做过一手调研**：`docs/roadmap/JEV-DECISION-EVALUATION.md:30-33`（官方产品介绍 `https://typesafe.ai/blog/introducing-system-one-models-and-jev`、官方 API `https://api.typesafe.ai/docs`、官方条款 `https://typesafe.ai/legal/mca`、第三方重建 `https://github.com/kyegomez/open-jev`），另有 `docs/roadmap/AGENT-FIRST-600-PLAN.md` §6 与本轮新交付的 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md`（710 行）。**`agenticjev` 查不到可信来源，判定为「agentic + Jev」的转写粘连。**
- **对本仓有用吗**：**默认危险品，不是 600 只规模问题的解**。理由（外部实测，标来源日期）：
  ① 它的输出**是概率** —— 与本仓红线「不造胜率/概率/百分数」正面冲突，要用只能**内部做门控且页面对玩家不暴露概率**；
  ② **概率还在漂移**：独立实测同一输入仅 **24%～39%** 逐位相同、**52%** 的决策位概率恰好 = 1.0（0.95 闸门形同虚设）、伪造权威型注入翻转 **147/200**；
  ③ **官方明说中文（CJK）精度降级** ⇒ 本项目的中文场景正好踩在最弱的一档；
  ④ 术语陷阱：`RLCD` 有两个含义（TypeSafe 的 **R**einforcement **L**earning for **C**alibrated **D**ecisions = 厂商术语；ICLR 2024 的 **R**einforcement **L**earning from **C**ontrastive **D**istillation = arXiv:2307.12950），**两者无继承关系证据，引错就是错误引用**。
- **落点（若将来要做）**：一个**可关闭**的 `decision_provider=jev` 适配器，离线/超时/低置信度一律回退现有策略（`docs/roadmap/JEV-DECISION-EVALUATION.md` 已写清口径）；**不许**让它生成游戏事实或绕过权限。
- **判据与必红反证**：同一局面重复请求的**逐位一致率**必须达标（漂移是它的已知弱点）；中文样本单独分层测；**反证** = 把它的输出接进结算路径必须被结构判据拦住。
- **工作量/时机**：**阶段 E 之后**的可选实验（先做完本文件 §2 的推荐一/二）。**风险**：把概率带进产品 = 直接踩红线。

### ④ Agentic RL（用可验证奖励训工具使用）
- **是什么**：用可验证 reward 训 agent 的工具选择/规划（例：[Agentic RL Scaling Law](https://neurips.cc/virtual/2025/loc/san-diego/poster/116372)；[用过程奖励训 agent 规划](https://aclanthology.org/2025.emnlp-industry.116/)，外部资料）。
- **对本仓有用吗**：**方向对，但现在不能开训**：RC-601 仍 BLOCKED（候选规则未定），轨迹无法重建；而**过程奖励本身就是我们已有的判据**（该不该调 / 参数合法 / 证据匹配）⇒ 现在能做的是**把数据与奖励做出来**，不是训练。
- **落点**：`reports/live-model-eval.json` 的判据 → 转成reward 记录（新脚本，只读产物）。**判据**：reward 与人工预注册判据逐条一致（一致性检查）；**反证**：故意把一条 reward 反号必须被检查抓到。**风险**：无判据的 RL 在本仓等于刷分。

### ⑤ Context engineering / 记忆与检索
- **是什么**：把「上下文当预算」来设计（摘要、分层记忆、按需取用）。公开做法举例：[OpenAI cookbook 的长期记忆笔记](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization)、[Google 的多智能体上下文架构](https://developers.googleblog.com/en/architecting-efficient-context-aware-multi-agent-framework-for-production/)（外部资料）。
- **对本仓有用吗**：**有用且立刻可量**：本仓 49 例烧掉 **104 926 API input tokens**（≈2.1k/例），而 receipts 里装着**整份局面**（`buildContext` 把 `player/enemy` 整块 structuredClone 进去）。
- **落点**：`src/coach/runtime.js` 的 context 组装 + `src/coach/rag-index.js` 的取用策略。**判据**：单例 token 下降 **且** 工具选择率/一致性不降、守卫不放行未登记数字；**必红反证**：掐掉一条必要事实 → 守卫必须拒答（而不是照答）。
- **风险**：省 token 很容易变成**省掉必要证据**，所以必须与守卫联动判。

### ⑥ 工具/协议层（MCP、结构化 schema、多智能体分工）
- **是什么**：MCP 等工具协议标准化（[MCP 加入 Agentic AI Foundation](https://modelcontextprotocol.info/blog/joins-agentic-ai-foundation/)，外部资料）；多智能体分工。
- **对本仓有用吗**：**MCP 现在不加**（本仓已有显式工具合同 + 判据 + 白名单，接协议会多一层进程/网络面，收益不明）；**多智能体也不加**（产品口径已经是三角色：军师/陪练/老师，再加 agent 只增失败面）。
- **可以吸收的**：把**工具合同**写得更像协议（输入 schema、错误码、幂等），这本来就是本仓强项（`src/coach/toolbox.js` 的 `TOOL_CONTRACTS`）。

### ⑦ 评测方法学（LLM-as-judge 的偏差 / 可复现回放）
- **是什么**：LLM 评委存在位置偏差等问题（[Judging the Judges（IJCNLP 2025）](https://aclanthology.org/2025.ijcnlp-long.18/)、[偏差感知评审团](https://zenodo.org/records/21158214/files/july2025-IJISAE.pdf)（外部资料）；工程侧常见做法见 [Microsoft 的评测方法综述](https://learn.microsoft.com/ro-ro/agents/architecture/common-evaluation-approaches)）。
- **对本仓有用吗**：**有用，但只用来「探索」不用来「判定」**：本仓已经有**预注册判据 + 离线回放门禁**（比 LLM 评委更硬）。
- **落点**：`docs/roco/CLOUD-ARM-REPLAY.md` 旁补一节「LLM 评委只能当候选生成器」。**反证**：把评委评分与预注册判据不一致的样本列出来，必须能被解释（否则不许用）。

### ⑧ 长时程记忆 / 跨局迁移
- **是什么**：把「学到的东西」跨局带过去。
- **对本仓有用吗**：**已有雏形**（老师复盘 → 下一局核对，`next-match` 目标；A9 迁移验证已在玩家闭环里）。可加强的是**记忆的可核对性**（记忆条目必须带证据 id，不许模型自述）。
- **落点**：`src/coach/experience.js`、`src/coach/memory.js`。**判据**：跨局核对的 `checked/recurred/improved` 三态不许把「没出现」说成「做到了」（本仓已有这条判据）。**风险**：编造型记忆。

---

## 2. 推荐（只推荐 3 条，按优先级）

### 推荐一：**先把「该不该调工具」的口径定死，再谈任何提示/训练优化**（前提，不是选项）
- **为什么最值**：今天 0.673 这个数字里 **15/16 条失败是口径冲突**（局面事实就在 receipts 里，而提示说「能答就别调」）。
  口径不定，后面所有优化（GEPA/RL/上下文瘦身）都是在**错的靶子上打分**。
- **落点**：`src/coach/runtime.js`（planner 提示与 context 组装）+ `scripts/roco/eval-live-s04.js` 的 `cat1` 期望口径。
- **两条出路（要人类拍板，本文件不代拍）**：**（甲）实时状态必须查证**（receipts 不预装实时状态）；**（乙）不浪费调用 + 答案里的数字必须被证据守住**（守卫已在服务端落地 ⇒ 是加严不是放松）。
- **指标**：工具选择率（33/49）、参数 5/5、证据 5/5、一致性 47/49 —— 口径变更后**重新量一遍**并把新旧并列。
- **必红反证**：把（乙）下的守卫短路 ⇒ 含未登记数字的回答必须被拒（现已有真跑反证 `tests/roco-server-side-guard.test.js`）。

### 推荐二：**上下文瘦身（receipts 按需取用）+ 用它换工具调用的「最小充分性」**
- **为什么比别的重要**：它是**唯一同时改善「贵」与「慢」**的一条，而且可立刻量：2.1k tok/例、规则段只花 11–15ms ⇒ 3s 预算几乎全被 LLM 段吃掉。
- **落点**：`src/coach/runtime.js` context 组装、`src/coach/rag-index.js` 取用、`docs/roadmap/MODEL-ROUTING-PLAN.md` §3 的分段预算。
- **指标**：单例 token、首字延迟、工具选择率/一致性/守卫通过率**同时**不降。
- **必红反证**：掐掉一条必要事实 ⇒ 守卫必须拒答；把 token 降下来但一致性下降 ⇒ 判红（不许只报好消息）。

### 推荐三：**把「过程奖励」数据做出来（为将来的 agentic RL 备料，不现在开训）**
- **为什么**：RC-601/605/702/703 全卡在「规则候选未定 / 没有可独立判 reward」；而**reward 其实是现成的**（该不该调、参数合法、证据匹配、stale 拦截）。
- **落点**：新脚本把 49 例判据导成 reward 记录（只读产物，不改产品代码）。
- **指标**：reward 与预注册判据**逐条一致**（一致性检查脚本）。
- **必红反证**：把一条 reward 反号必须被检查抓到。
- **风险**：没有留出集与反证的 RL 在本仓一律等于刷分。

---

## 3. 明确劝退（逐条说清为什么不做）

| 劝退项 | 为什么 |
|---|---|
| **用模型算伤害 / 算胜负 / 算概率或胜率** | 违反本仓第一红线；而且会把 8 条 golden 指纹与 6048 条轨迹复验变成不可复算 |
| **用 JEPA/世界模型替代规则引擎** | 同上；本仓要的是**可复算**，世界模型的输出无法被引擎逐位复验 |
| **把 LLM-as-judge 当成判定闸门** | 位置偏差等已有一手证据（见 ⑦）；本仓已有更硬的预注册判据 + 离线回放 ⇒ 评委只做候选生成 |
| **现在接 MCP / 拆多智能体** | 多一层进程/网络面与失败模式，收益不明；本仓的工具合同 + 白名单已经能判「该调什么、参数对不对」 |
| **给「不确定」硬凑答案** | 本仓的 fail closed 是资产：宁可弃答，也不许把读不出的机制近似成普通伤害（这条在引擎、支持度、RAG 三层都已在守） |
| **拿「合法率」当「说得好」** | 本仓已有前车之鉴（本地模型 8 条提示程序判定通过 ≠ 质量好）；指标必须分维度报 |

---

## 4. 与人类最新方向的关系：「600 只 + 机制极复杂，重心在 agent 不在游戏系统」

人类口径（2026-09-25）：**不要只依赖脚本与预制数据，更多依赖模型与 agent 本身，可以结合 RAG，但重心在 agent**。
把它翻成**可判定的分工**（这是本文最该被实现的一节）：

| 层 | 谁负责 | 具体做法 | 不许做什么 |
|---|---|---|---|
| **事实层（结算）** | **Python 规则引擎**（不动摇） | 伤害、胜负、合法行动、能量/魔力、按需编译的配招 | 模型**不许**产出任何结算数字 |
| **理解与决策层** | **agent（模型 + 工具循环）** | 自己决定**查什么证据**（不只是"要不要查"）、自己**组合多个工具**、自己判断**证据够不够**、不够就**弃答**并说清缺什么 | 不许把「记忆里的印象」当证据（Reflexion 编造风险，见 ②） |
| **证据层** | **RAG + 引擎回执** | 预制数据**降级为「证据源」而不是「答案源」**：语料按需检索、回执带 id 可复算 | 不许把预制表当结论直接端给玩家 |
| **守卫层** | **服务端**（已落地） | 数字/引用/确定性承诺白名单；未登记 ⇒ 拒答/降级并如实记账 | 不许静默降级 |

**600 只怎么不靠手写表**：① 图鉴全量进 RAG（现 1694 篇）；② 引擎侧按需编译（已实测 622 只 = 48 冻结 + 574 推算）；
③ **agent 承担「规模」**：玩家问哪只，agent 去检索/查工具，而不是我们提前把 600 只的答案写死；
④ **把「不知道」变成一等公民**：弃答率、弃答正确率要作为指标（现在 RAG 有 1 条保留失败，正是这种诚实）。

**判据（新增能力的）**：① 证据命中（现 5/5）；② 弃答正确率（该弃就弃、不该弃不许弃）；③ **工具调用的最小充分性**（不是越多越好）；
④ 单例 token 与首字延迟不退化；⑤ 所有模型输出必须过服务端守卫。**每条都要配必红反证。**

---

## 5. 如果只做一件事

**把推荐一做完**：把「该不该调工具」的**口径**定死（甲/乙二选一），并用**离线回放门禁**把它守住。
理由是它同时满足三件事：**唯一有真数字**（33/49，且 15/16 条失败已归因清楚）、**是所有后续优化的靶子**（提示进化 / RL / 上下文瘦身都靠它打分）、
并且**今天就能做**（不需要训练、不需要新依赖、不需要冻结层）。口径不定就动手优化，等于把分数打在错的靶子上。

---

## 附：本文引用到的外部资料（**参考，不构成本仓承诺**）

| 主题 | 来源 | 日期（页面所示） |
|---|---|---|
| GEPA 反思式提示进化 | https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html | ICLR 2026 |
| Agentic RL（可执行代码/扩展律） | https://neurips.cc/virtual/2025/loc/san-diego/poster/116372 | NeurIPS 2025 |
| 过程奖励训 agent 规划 | https://aclanthology.org/2025.emnlp-industry.116/ | EMNLP 2025 |
| 反思型 agent 的记忆编造 | https://browse-export.arxiv.org/pdf/2605.29463 | 2026（预印本） |
| 世界模型 vs LLM（观点） | https://zdnet.co.kr/view/?no=20251027181618 ・ https://en.tmtpost.com/post/7773738 | 2025-10 |
| 上下文/长期记忆工程 | https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization ・ https://developers.googleblog.com/en/architecting-efficient-context-aware-multi-agent-framework-for-production/ | 2025 |
| MCP 生态 | https://modelcontextprotocol.info/blog/joins-agentic-ai-foundation/ | 2025 |
| LLM-as-judge 偏差 | https://aclanthology.org/2025.ijcnlp-long.18/ ・ https://zenodo.org/records/21158214/files/july2025-IJISAE.pdf | 2025 |
| 评测方法综述 | https://learn.microsoft.com/ro-ro/agents/architecture/common-evaluation-approaches | 2025 |

**更正记录（2026-09-25，本文第一版错了，如实留档）**：第一版在附录里写「`agenticjev` / `jev` 没有找到可信一手来源，
最接近的候选是 GEPA / Agentic RL / JEPA」——**`jev` 那半句是错的**：它是 TypeSafe AI 的 System One（真产品），
而且**本仓更早的 `docs/roadmap/JEV-DECISION-EVALUATION.md:30-33` 早就引了官方一手来源**（我没先 grep 仓内就下了结论，这是我的错）。
**JEPA（世界模型）与 `jev`（决策模型）无关**，第一版把两者混为一谈去劝退，已改（见 ⑨）。
仍然成立的部分：**`agenticjev` 查不到可信来源**，判定为「agentic + Jev」的转写粘连。

**⚠ 引用指标前必须先重跑（本轮实测到的文档漂移）**：`docs/roco/RAG-EVAL.md:133` 写「1678 条文档」，
而**现算与磁盘产物都是 1694**（`reports/roco/rag/rag-eval.json#corpus.documents`）；同一份文档的「冲突弃答率 1.000」
与磁盘报告的 **0.909**（有一条实际没弃答）也不一致。同批还发现 RC-403（文档 8/614 vs 报告 12/610）、
RC-401（文档 473/507 vs 报告 **344/824**）两处漂移。⇒ **本文件与任何方案文档引用这些数字时，一律以「现跑产物」为准**，
不要转抄旧文档（发现者：本轮 `docs/roadmap/AGENTIC-TERMS-RESEARCH.md` §1.2 与 §7，我复核了 RAG 那一处）。

**同一轮新增的两份方案文档（本文的姊妹篇，建议一起读）**：
`docs/roadmap/AGENT-FIRST-AT-SCALE.md`（556 行：8 条可判定原则 + 五层架构 + 判据威胁清单 + 5 阶段分期，
其中 **B/C/D 阶段不需要 key**、只有 E 需要）、`docs/roadmap/AGENTIC-TERMS-RESEARCH.md`（710 行：术语逐个给一手来源 + 日期）。
