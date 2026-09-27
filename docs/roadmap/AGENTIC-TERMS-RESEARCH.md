# 术语调研：`agenticjev` / `jev` 与相关近期热点

> **任务**：人类说「最近 **agenticjev** 和 **jev** 很火，你可以看看是否有用，但我不是太熟，提供个思路」，
> 并自己注明这两个词**可能是转述失真/拼写不全**。本文把它们当**失真候选**去查，逐个给结论。
>
> **纪律**：
> ① **不许猜**。查不到可信来源就写「**查不到可信来源，疑似 TTS/拼写失真**」，并列出查过的关键词与最接近的候选。
> ② 每条外部信息都给 **URL + 日期**，并明确标注为 **`[外部]`（外部资料，未在仓内验证）**。
> ③ 一手来源（论文/公司官方博客/官方文档/规范）与二手来源（媒体、博客总结、推文）、
> **独立第三方测试**三者**分开标**。
> ④ 日期一律显式写出；**日期读不出来就写「日期不明」**。
> ⑤ 本文**只读**，没有联网改仓，没有改任何既有文件。
>
> **产出**：本文只新增两个文件（本文与 `docs/roadmap/AGENT-FIRST-AT-SCALE.md`）。
>
> **⚠ 时效声明**：本次检索到的一手页面自标日期集中在 **2026-09-17 ～ 2026-09-22**。
> 这些日期**晚于检索工具的静态知识**，但它们**是实时抓取到的页面自己标注的日期**，不是推算的。
> 凡无法核实的日期，一律标「日期不明」。

---

## 0. 一句话结论

> **`jev` 查得到，而且是真事**：**TypeSafe AI** 的「**System One 模型**」，
> 公司 **2026-09-15 正式亮相**，**2026-09-21 全量开放**（`[外部]` 一手=官方文档；二手=36氪/投资界转述）。
> 它**不是 LLM**：不吃「写一段话」，而是吃 **state + 一组有类型的 questions**，
> 返回 **有类型的决策 + 概率**（三种题型 **Noul / Choice / Score**）。
>
> **`agenticjev` 查不到**：作为一个**独立术语、产品、论文或框架**，
> 检索不到任何可信一手来源。它最可能是 **`agentic` + `Jev` 在语音转写里被粘成一个词**
> —— TTS/听写把**高频共现搭配**压成连写词是完全可预期的形状。
> 另有若干**听感接近且确实存在**的候选，见 §1.2。
>
> **⚠ 三条必须先说的“坑”**（细节见 §3.7、§3.11、§2.5）：
> ① **`RLCD` 有两个完全不同的含义**，一个是 TypeSafe 的厂商术语、一个是 ICLR 2024 的论文，**引错就是错误引用**；
> ② Jev 官方明说**中文（CJK）精度降级**——对本项目是**一等风险**；
> ③ Jev 的概率**不是确定性的**（独立实测：同一输入两次只有 24%～39% 逐位相同）。

---

## 1. `agenticjev` —— **查不到可信来源，疑似 TTS/拼写失真**

### 1.1 结论

**作为一个独立的术语、产品、论文或框架：查不到可信来源。**

- 精确串 `"agenticjev"` 检索：**没有任何一手来源**（无论文、无官方文档、无规范、无公司公告）。
- `"agentic jev"` / `"agentic-jev"` / `"Agentic Jev" TypeSafe`：命中全部是
  「agentic（形容词）+ Jev（那个模型）」的**自然共现**，**不是**一个新的复合名词。
  返回的其余结果是含独立词 `agentic` 和 `Jev` 的无关页面
  （例：OECD 的 agentic AI 概览报告）——这是**分词匹配噪声**，不是真实命中。

### 1.2 最可能的解释（按可能性排序）

| # | 解释 | 依据 | 可信度 |
|---|---|---|---|
| 1 | **是「agentic」+「Jev」的转写连写**。Jev 在 2026-09 爆火的**核心叙事本身就是「agentic 场景」**——把 agent 循环里大量微小的 LLM 判断调用换掉；LangChain 那篇整合文章标题就是《Building a Harness with Jev》，内容全讲 agent 中间件（模型路由、AutoMode 工具风险闸门）。所以这两个词在真实语境里是**高频共现搭配** | 人类自己在任务里注明「可能是转述失真/拼写不全」 | **最可能** |
| 2 | 是 **`Agentic-JEPA`** 的失真（`jev`/`jepa` 听感接近） | 这个**真的存在**（见 §3.6），但是**单作者未评审预印本**，且结果对自己不利 | 可能 |
| 3 | 是 **`agentic` + `Jev`** 两个热词的**组合表达**（想说「agentic 方向 + Jev 这个模型」） | 两个词各自都热 | 可能 |

### 1.3 我查过的关键词（节选，完整清单见 §5）

`"agenticjev"` ・ `"agentic jev"` ・ `"agentic-jev"` ・ `"Agentic Jev" TypeSafe` ・ `agentic JEV` ・
`"agenticjev" OR "agentic-jev" OR "agentic jev" TypeSafe` ・ `"jevi" AI model 2026`（排错用）
—— **全部无一手来源命中**。

---

## 2. `jev` —— **查得到，是真事**

### 2.1 一句话定义

`[外部]` **Jev 是 TypeSafe AI 的「System One 模型」**：输入一个 **state**（要评估的上下文，**只有文本**）
与一组**有类型的 questions**，返回**有界的决策与概率**，**不生成文本、不解释推理过程**。

### 2.2 公司、发布与时间线（一手优先）

| 事实 | 日期 | 来源 | 性质 |
|---|---|---|---|
| TypeSafe AI 正式亮相 + Jev 发布 | **2026-09-15** | 发布推文（创始人 Diogo Almeida，@CompleteSkeptic）：https://x.com/CompleteSkeptic/status/2099925682726002904 | **一手**（作者本人） |
| 同期宣布 **4000 万美元种子轮，DCVC 领投**；创始人 **Diogo Almeida**（前 OpenAI，RLHF/InstructGPT 参与者）、Erik Gafni、Sasha Sheng | 2026-09-22 / 2026-09-21 | 投资界（清科）https://m.pedaily.cn/news/569459 ・ 36氪 https://eu.36kr.com/en/p/3992394169613316 | 二手 |
| **全量开放**（取消 waitlist），注册送 $5 额度（≈1.2 亿 token） | **2026-09-21** | 36氪同上 | 二手 |
| 名字来源：19 世纪经济学家 **William Stanley Jevons**（杰文斯悖论）；"System One" 取自 Kahneman《思考，快与慢》 | — | 官方文档 https://docs.typesafe.ai/concepts/system-one | **一手** |
| LangChain 整合指南《Building a Harness with Jev》（Sydney Runkle / Hunter Lovell） | **2026-09-17** | https://www.langchain.com/blog/building-a-harness-with-jev | 二手（厂商官方博客） |
| Requesty 逐条整理《TypeSafe Jev explained》 | **最后更新 2026-09-19**（文中记发布日为 2026-09-15） | https://www.requesty.ai/blog/typesafe-jev-explained | 二手 |
| 官方博客《Introducing System One Models & Jev》 | **日期不明**（页面 JS 渲染，正文抓不到） | https://typesafe.ai/blog/introducing-system-one-models-and-jev | **一手**（但**正文读不出来**） |
| 官方 API 文档 | — | https://api.typesafe.ai/docs ・ https://docs.typesafe.ai/introduction/quickstart | **一手** |
| 官方服务条款 | — | https://typesafe.ai/legal/mca | **一手** |
| 中文媒体（中国广播网） | **2026-09-20** | https://tech.cnr.cn/techph/20260920/t20260920_527819594.shtml | 二手 |

### 2.3 技术形状（**一手 = 官方文档**，`[外部]` 未在仓内验证）

**端点**：`POST https://api.typesafe.ai/v1/systemone`，Bearer 鉴权。

```json
{ "state": "<字符串 | JSON 对象 | 字符串数组>",
  "model": "jev-latest",
  "questions": { "<id>": { "type": "noul|choice|score", "instructions": "...", "criteria": {...} } } }
```

- **`state` 只有文本**：字符串 / JSON 对象 / 文本数组。**不支持图像、音频、视频**（官方写 "not supported (yet)"）。
- **`questions`**：一次请求可带**任意多个**问题，对**同一份 state 并行评估**；
  **加问题几乎不增加延迟**，只多花输入 token。
- **上下文**：**64k tokens / 请求**；其中 `state` + 最长单问题 **≤ 32k**。
- **官方 Patterns**：`Speculative fan-out`、`Confidence-gated routing`、`Composite scoring`、`Intent routing`。

**三种题型的确切含义**：

| 类型 | 问什么 | 返回 |
|---|---|---|
| **Noul** | 是非判断（官方例子："Does this message express urgency?"） | **一个 0～1 的概率**（CEO 在 HN 确认 "Noul = Bernoulli"） |
| **Choice** | 从你给的选项里选一个（**最多 255 个选项**） | `choice` + 全选项 `probabilities` 分布 + `confidence` |
| **Score** | 按你给的**有序 levels** 打分 | `score` 连续值 + 各 level 分布 + `confidence` |

**关键坑（一手：官方 Confidence 页 https://docs.typesafe.ai/confidence ）**：
**Noul 不带 `confidence` 字段**，只有 Choice/Score 有。
`confidence` 是**从 `probabilities` 分布算出的一个统计量**——
官方说「你可以不用我们的定义，所以我们把完整 `probabilities` 给你」。
**`confidence` 不应该被自动读成「所选答案是正确的那一概率」。**

### 2.4 概率是否「校准」、官方怎么声称

- **官方声称**：RLCD（官方定义 = **R**einforcement **L**earning for **C**alibrated **D**ecisions）
  训练出的概率「针对结果优化以反映不确定性」；官方举例：标 0.2 的结果应约 20% 发生、标 0.8 应约 80% 发生。
- **官方同时给出的限定（很重要）**：
  「Calibration is measured **across groups of predictions**; it **does not guarantee that an individual answer is correct**」，
  以及「These rates describe groups of predictions, **not a guarantee about any single answer**」。
  来源：https://docs.typesafe.ai/introduction/machine-learning-primer ・ https://docs.typesafe.ai/confidence
- **⇒ 对本仓的直接含义**：即便「校准」成立，**它也不保证单条答案对**。所以它**不能**被用来提供任何「保证」。

### 2.5 独立第三方测试（**最有价值的一节：不是厂商数据**）

| 测试 | 规模与出处 | 关键结果 |
|---|---|---|
| **willkelly/jev-evaluation**（预先注册式评测） | 9 个实验、**28 条事先写死的预测**、**123,805 次请求、138 分钟、$12.69**，模型 `jev-1.13.0`，原始日志 1.3 GB 公开 → https://github.com/willkelly/jev-evaluation ・ https://jev-logs.wilk.dev | ①支持工单路由任务 **ECE = 0.075**（算校准得住）；②**随机 3-SAT 上完全失败**：任何 clause ratio 下恒答 "satisfiable"，平均概率只变 0.026 而真实可满足比例变 1.000；`x AND NOT x` 这种显然不可满足的给 **P=0.38**；③置信度**能**区分「状态里根本没有答案」（缺事实 0.992 / 自相矛盾 0.985 / **通顺胡话 0.893**）但**没有单一阈值**：0.8 闸门抓住 95.5% 的「缺事实」，却抓住 **0%** 的「通顺胡话」；④**AUROC 0.878 是被池化抬高的**，单一条件内只有 **0.699**；⑤注入攻击：生硬的 "IGNORE THE INSTRUCTIONS" 200 张票只动 1 张，**伪造「主管已决定」的权威型注入 200 张动了 147 张**；⑥所有概率落在**两位小数网格**上，**决策位概率 52% 恰好等于 1.0**；⑦`confidence` 在 **47%** 的 choice/score 回答上**不等于**最大返回概率 |
| **Archestra**（真实 agent 工具调用标注） | 100 条真实调用 → https://archestra.ai/blog/we-tested-jev-on-100-real-agent-calls ，**2026-09-21** | 0-shot **93%** / 9-shot **95%**（Sonnet 5 为 98%，常数基线 79%）；响应约 **300ms**；置信度 ≥0.7 时零错误。**但稳定性有保留**：3 次完全相同重复中 400 个决策里只有 **394～398 个 label 相同**，**概率仅 35%～39% 逐位相同**，同 payload 概率漂移最大 **0.17**；**3 选 1 对选项顺序敏感**（翻转/轮转 criteria keys 会改变 100 题中 5～7 题） |
| **Wunderlandmedia** | 732 个决策 × 3 次 → https://wunderlandmedia.com/jev-not-deterministic-732-decisions-three-runs ，**2026-09-19** | **只有 24% 逐位相同**；漂移中位数 0.010 / p90 0.030 / p99 0.050 / **最坏 0.070**；12/732（1.6%）**跨过阈值翻转了判定**。建议：**把阈值放在分布的「山谷」里，不要放在密集区** |

> **这三份独立测试的合起来的意思**：
> ① 「校准」在**它擅长的窄任务上**可能成立（ECE 0.075）；
> ② 但**概率会漂移**，「同一输入可复现的胜率」在物理上做不到；
> ③ **52% 的决策位概率就是 1.0** ⇒ 高阈值闸门形同虚设；
> ④ 它在**对抗内容**上可被 73.5%（147/200）地翻转 ⇒ 官方自己说「**不要把模型当安全边界**」。

### 2.6 价格、延迟、上下文（含**厂商自己的免责**）

- **官方定价表**（一手 https://docs.typesafe.ai/models ）：
  `jev-1.13.0` = **$42 / 十亿输入 token**（= **$0.042 / 百万**），**输出 token 免费**；
  限流 **250,000 tokens/秒 + 1,200 请求/分**（官方注明「正在动态调整」）；上下文 **64k**。
- **厂商性能声称**：端到端延迟 **70ms～500ms**；自动化工作流任务上**快 193.6 倍、成本低 444.6 倍**。
- **⚠ 厂商自己注明**（经二手转述其官网脚注）：这些数字来自其自动化工作流评测，
  「**预计这些数字处于实际收益的较高端**」，且**评测由公司模型能力团队成员制作，存在偏差可能性**
  （`[外部]` https://m.pedaily.cn/news/569459 ，2026-09-22）。
- LangChain 的表述是「**up to** 200x faster / 400x lower cost」——即**最高**，**不是保证值**。
  **不许引用成确定的倍率。**

### 2.7 **官方自己写出来的 9 类已知失败模式（对本仓最重要的一段）**

`[外部]` 一手：**https://docs.typesafe.ai/model-jaggedness/jev-1.13**，页面标 **Last reviewed 2026-09-17**。

| # | 失败模式 | 官方原话要点 |
|---|---|---|
| 1 | **字面理解** | 「回答你**写**的问题，而不是你**想问**的问题」；否定、隐含条件按字面读 |
| 2 | **数学 / 数字** | **不是计算器**；**计数不可靠**（数词里字符数、出现次数、长列表项数），误差**随规模增长**；建议**在代码里数** |
| 3 | **Score 的数值校准很弱** | **明确说不要用 score 的期望值/概率去反推两个 level 之间的精确数值**，只能用来过阈值 |
| 4 | **日期时间** | 把日期当**文本**读，不当有序量；比较先后、算间隔都不可靠 |
| 5 | **多跳 / 间接推理** | — |
| 6 | **state 里塞大量无关细节** | — |
| 7 | **对抗性内容**（prompt injection） | 与独立测试的 147/200 相互印证 |
| 8 | **自相矛盾的 instructions 与 criteria** | — |
| 9 | **需要生成的任务** | 请改用生成模型 |

> **这一节直接支撑本仓的红线**：「LLM 只解释不结算」（`docs/roadmap/MODEL-ROUTING-PLAN.md:262-263`）。
> 一个**专门为决策训练**的模型都自认**算数与计数不可靠** ⇒ 「让模型算伤害」在本仓更不成立。

### 2.8 **中文（CJK）支持：官方明说降级**（⭐ 对本项目是一等风险）

`[外部]` 一手原文（https://docs.typesafe.ai/models 的 Language support 段）：

> "English is the primary training language and where accuracy is currently best.
> **Other languages, including CJK scripts, are handled but not equally well;
> test on your own content before relying on Jev for a non-English workload,
> and pay close attention to Confidence when routing.**"

⇒ **中文能跑，但官方明说精度不如英文，并要求你自己测。**
旁证（二手，日期不明）：日语实测 https://zenn.dev/genelab_999/articles/533144853290a7
发现**顺序量表会因「选项位置」而崩坏**——与 Archestra 的顺序敏感性一致。

### 2.9 确定性与可复现性

- **官方没有承诺确定性**，但给了工程手段：`model` 字段回传**真实版本号**，
  可以**固定版本 ID**（如 `jev-1.13.0`）而不是用 `jev-latest` 别名；
  官方说「如果你的置信度阈值是针对某个版本调的，就 **pin 版本 ID**」。来源：https://docs.typesafe.ai/models
- **实测结论：不是确定性的**（三家独立测试，见 §2.5：24% 逐位相同 / 35～39% 概率逐位相同 / 最坏漂移 0.17）。
- **可复现的做法（综合官方 + 独立测试）**：固定版本 ID ・ 把阈值放在**分布山谷** ・
  用 **`probabilities` 而不是只看 `confidence`** ・ 记录 `usage.input_tokens`。

### 2.10 其他一手细节

- **不是 LLM，不生成文本，不做微调 / LoRA**：官方说「**同一份权重服务所有账号**」，
  你只能通过 `state` + `instructions` / `criteria` 塑形。来源：https://docs.typesafe.ai/models
- 官方**自己就发了一个 Agent Skill**（`npx skills add typesafe-ai/skills`）——
  说明它**本来就是被设计成塞进 agent harness 的组件**：https://docs.typesafe.ai/agent-skill
- **`Speculative fan-out` 被独立测试证实**：第 200 个问题和第 1 个准确率相同；
  60 个问题比逐个问**省 20 倍 token、快 8 倍**且答案完全一致；
  **但有前提**：每个问题必须**自己命名它的主语**——说 "Ticket 1" 会掉到 0.420 并沿列表衰减。
- **「Zero Hallucinations」是营销话术**：其含义**仅限**「输出类型/结构预先定义，所以不会跳格式、
  不会编造不存在的字段、不会跑出选项之外」。**不等于不会答错。**
  （二手转述称 TypeSafe 自己的 FAQ 承认 Jev「仍然可能出错」，但
  `https://typesafe.ai/faq` **返回 404**，**我没能取得一手原文** ⇒ 这句标记为**二级来源转述，未取得一手原文**。）

### 2.11 与本仓的关系

| 维度 | 结论 | 依据 |
|---|---|---|
| **能用在哪** | 仓内**已经**把它限定在**两处**：① **介入门控**（`silent` / `brief_hint` / `expandable_hint` 三选一）；② **问题路由**（阵容/培养/战况/复盘/陪练） | `docs/roadmap/JEV-DECISION-EVALUATION.md:9-11` |
| **绝不能用在哪** | 不许让它产出游戏事实、不许绕过权限；**规则引擎仍负责合法行动、伤害和胜负**；正式 PVP 权限**先于**模型；用户静默偏好与频控是**硬约束，模型不可覆盖** | 同上 `:10-11`、`:26` |
| **判据怎么写** | 仓内已写好一份**最小对照**方案：同一份冻结样本同时跑「现有规则/学习策略 / Jev / 必要时本地 Qwen 路由」，覆盖关键提醒、应沉默、用户明确静默、连续多轮、未知机制、网络超时与服务不可用；记录每组**关键提醒漏报率、无用打扰率、工具路由正确率、置信分桶校准、端到端 p50/p95（从中国网络实测）、每千局成本**；用户侧 3–5 人盲评 | 同上 `:22-24` |
| **准入条件** | 「仅当 Jev 在核心指标上有**稳定收益**、**没有增加打扰和延迟**，且**失败可安全回退**时，才增加一个**可关闭的** `decision_provider=jev` 适配器」；离线/超时/低置信度一律**退回现有策略，不阻塞游戏回合** | 同上 `:26` |
| **反面风险 ①：概率红线** | 本仓红线是「**不造胜率 / 概率 / 百分数**」（`docs/roadmap/MODEL-ROUTING-PLAN.md:265`）。Jev 的**核心卖点就是返回概率** ⇒ **直接冲突**。合规用法只有一种：**概率只当内部路由/门控信号，永远不进玩家可见正文，也不许被当成胜率** | 见 §4 |
| **反面风险 ②：不是本地替代** | 仓内已核实：「**未发现官方公开权重或本地部署方案**；第三方 `open-jev` 自称从原理重建、未提供原版权重或等效性能，**不能作为 Jev 的本地替代**」 | `docs/roadmap/JEV-DECISION-EVALUATION.md:7` |
| **反面风险 ③：外部依赖 + 数据出境** | 它是**托管服务** ⇒ 引入后本地/离线承诺破裂；前置条件是「可用经脱敏的对局与多轮问答样本；**不上传原始玩家聊天、身份信息或密钥**」 | 同上 `:7`、`:20` |
| **反面风险 ④：不是确定性系统** | 同一输入概率**会漂移**（24%～39% 逐位相同）；把它当「查表」的用法必然翻车 | §2.5、§2.9 |
| **反面风险 ⑤：中文精度降级** | **官方明说 CJK 不如英文，要求你自己测** | §2.8 |
| **反面风险 ⑥：供应商数据 ≠ 本项目实测** | 「官方公布的速度与价格是供应商数据，**不能直接当作本项目从国内调用的实测结果**。结构化输出**保证类型，不保证判断正确**；所有效果声明须经本项目对照和真实试玩验证」 | `docs/roadmap/JEV-DECISION-EVALUATION.md:35` |
| **反面风险 ⑦：许可 / 条款** | 仓内已写明：「先核对 TypeSafe 服务条款对输出训练/蒸馏的限制」 | 同上 `:13` |

### 2.12 ⚠ 仓内一处**必须指出的自相矛盾**（本文的附带发现）

仓内三份文档对 `jev` 的结论**一份错、两份对**：

| 文件 | 日期（mtime） | 它说什么 | 行号 |
|---|---|---|---|
| `docs/roadmap/JEV-DECISION-EVALUATION.md` | **2026-09-22** | **对**：「Jev 是 TypeSafe AI 托管的快速结构化决策模型……」，并列了**官方产品介绍 / 官方 API / 官方服务条款 / 第三方重建项目**四条来源 | `:1-7`、`:30-33` |
| `docs/roadmap/AGENT-FIRST-600-PLAN.md` | 2026-09-24 04:02 | **对**：「LangChain 已提供 `TypeSafeClassifier` 与两种现成中间件……来源：LangChain：Building a Harness with Jev、TypeSafe：Introducing System One Models and Jev」 | §6（该文件约 `:95-97`） |
| `docs/roadmap/AGENTIC-TECH-IDEAS.md` | **2026-09-25** | **错**：附录逐字写「`agenticjev` / `jev` 这两个词**没有找到可信一手来源**，最接近的三个候选是 **GEPA**、**Agentic RL**、**JEPA**」 | `:158-159` |

**事实**：`JEV-DECISION-EVALUATION.md` **比最后一份早三天**，而且**已经把官方一手 URL 列出来了**
（`https://typesafe.ai/blog/introducing-system-one-models-and-jev`，同文件 `:30`）；
`AGENT-FIRST-600-PLAN.md` 也引了同一条。**三份里有两份是对的。**

所以 `AGENTIC-TECH-IDEAS.md:158-159` 的附录结论**是错的（或至少是过时的）**：
`jev` **有**可信一手来源；`AGENTIC-TECH-IDEAS.md` §1③ 与 §3 把 `jev` 归到「JEPA/世界模型」一类去劝退，
**是把它当成了另一个东西**：
**JEPA 是 LeCun 的世界模型路线（表征预测），Jev 是 TypeSafe 的决策模型（输出离散决策 + 概率），两者无关。**

> **建议（不在本任务权限内）**：`AGENTIC-TECH-IDEAS.md` 的附录与 §3 需要一处更正；
> 本文作为**独立证据**记录这件事，**本文没有改动那份文件**。

---

## 3. 逐个术语

> 每个术语四件事：**一句话是什么** / **一手来源（URL + 日期）** / **与本仓的关系（能用在哪、判据怎么写、反面风险）** / **可靠性**。
> 全部为 **`[外部]` 资料，未在仓内验证**，不得写成产品承诺。

### 3.1 `Agentic RAG`

- **一句话**：把**自主 agent**（反思、规划、工具使用、多 agent 协作）嵌进 RAG 管线，
  让**检索策略由 agent 动态决定**，而不是走一条固定的 workflow。
- **一手来源**：`Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG`，
  **arXiv:2501.09136**，**v1 2025-01-15**，**v4 2026-04-01**，
  https://arxiv.org/abs/2501.09136
  （Aditi Singh、Abul Ehtesham、Saket Kumar、Tala Talaei Khoei、Athanasios V. Vasilakos）。
  另有 ACL Findings 2026 数据视角综述 https://aclanthology.org/2026.findings-acl.78/ ；
  SoK https://ar5iv.labs.arxiv.org/html/2603.07379 （**日期不明**）。
- **与本仓的关系**：
  - **能用在哪**：**这是本文里对「600 只 + 复杂机制」最对症的一条**。本仓已有
    **检索层**（纯 JS BM25 + 别名 + 过滤 + rerank + 弃答，`src/coach/rag-index.js:1-27`）
    与 **agent 循环**（`src/coach/runtime.js:265-351`），但两者**只有一处细线相连**：
    `retrieve` 只在 `search_rules` 这个分支里被调用（`src/coach/runtime.js:261-263`）。
    Agentic RAG 要补的正是这条线：**让模型自己发起检索、自己判断检索够不够、不够就弃答**。
  - **判据怎么写**：仓内已有现成指标可直接用——
    `Recall@K / MRR / 版本命中率 / grounded precision / 弃答率 / **弃答精确率** / 证据等级匹配率`
    （`docs/roco/RAG-EVAL.md:183-192`）。新增「模型自主检索」后必须**同时**报：
    ①检索质量不降；②**工具调用的最小充分性**（不是越多越好）；③单例 token 与首字延迟不退化。
  - **反面风险**：**「自主要多花时间」有代价**——Anthropic 自己写着
    「runtime exploration is slower than retrieving pre-computed data」，
    且「没有恰当引导时 agent 会**误用工具、钻死胡同、找不到关键信息**」（§3.4 同一份来源）。
    本仓的 **3 秒硬上限**（`docs/roadmap/MODEL-ROUTING-PLAN.md:215`）对这条特别敏感。
- **可靠性**：**高**（有正式 survey 与 taxonomy，**已确立的学术术语**，不是营销词）。
  但它是 survey / arXiv，**不是同行评审期刊**，且 survey 本身不产生新实证。

### 3.2 `agentic retrieval`（≈ agentic search / just-in-time retrieval）

- **一句话（产品化定义）**：**多查询检索管线**——用 LLM 把复杂问题**拆成子查询**、并行跑、
  语义重排、合并成**带引用的统一结果**，专为 RAG 与 agent-to-agent 设计。
- **一句话（Anthropic 的说法）**：**just-in-time 检索**——不做一次性嵌入预检索，
  让 agent 持有**轻量标识**（文件路径、存好的查询、链接），**运行时用工具按需拉进上下文**。
- **一手来源**：
  - Microsoft Learn《Agentic retrieval in Azure AI Search》，**Last updated 2026-09-17**，
    https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview
    （已 GA 的 `2026-04-01` REST API + preview 的 `2026-08-01-preview`）。
  - Anthropic《Effective context engineering for AI agents》，**2025-09-29**，
    https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
    （「agentic search / just-in-time」与「progressive disclosure」成一节；
    明确列出折中「runtime exploration is slower than retrieving pre-computed data」，
    并说**混合策略**（一部分预先塞进去换速度，其余自主探索）常常最好）。
- **与本仓的关系**：
  - **能用在哪**：本仓**已经是这个形状的一部分**——语料 **1694 篇**（`[实测]`，见 `AGENT-FIRST-AT-SCALE.md` §1.2），
    工具合同有 **13 个工具**、每个带显式参数 schema（`src/coach/toolbox.js:144-162`），
    且**参数里没有路径、文件名、URL 或代码**（`:155-156` 注释逐字如此）。
    「just in time」在本仓的对应物 = **让模型按需调 `query_rules` / 检索工具**，
    而不是把 622 只的资料塞进提示。
  - **判据怎么写**：**上下文预算**是现成硬判据——
    `assembleContext` 工作预算 `WORKING_CONTEXT = 200000` 字节，输出预留 4096、系统 4096、工具 2048
    （`src/coach/runtime.js:359-364`）；实测 49 例烧 **104 926 API input tokens**（≈2.1k/例）
    （`docs/roadmap/AGENTIC-TECH-IDEAS.md:56`）。
    判据 =「**单例 token 下降 且 工具选择率/一致性/守卫通过率不降**」。
  - **反面风险**：**省 token 很容易变成省掉必要证据** ⇒ 这条判据必须与守卫联动：
    「掐掉一条必要事实 ⇒ **守卫必须拒答**（而不是照答）」（同文件 `:91`）。
- **可靠性**：**高**（Azure 官方文档已 GA + Anthropic 官方工程博客）。与 `Agentic RAG` 是
  **近义但不同侧重**：前者指**架构范式**，后者特指**检索管线本身**。

### 3.3 `agent memory`（长期 / 跨会话记忆）

- **一句话**：让 agent 把「跨上下文窗口还有用的东西」**持久化到窗口之外**
  （文件系统、笔记、向量库），之后**再召回**，从而跨上下文重置保持连贯。
- **一手来源**：
  - Anthropic 前引博客（**2025-09-29**）的「**Structured note-taking**」一节，
    原文直接称之为「**agentic memory**」，例子与本项目高度相关：
    **Claude playing Pokémon**——agent 在成千上万步里维持**精确计数**
    （「过去 1,234 步我在 1 号路练级，皮卡丘为目标 10 级已升 8 级」），
    自己画出已探索区域地图、记住解锁了什么、维护战斗策略笔记；
    **上下文重置后它读自己的笔记继续**。
  - 官方同期发布 **memory tool 公开 beta**（官方链接指向 anthropic.com/news/context-management）。
  - ACL Findings 2026 survey《From Storage to Experience: A Survey on the Evolution of LLM Agent Memory Mechanisms》
    https://aclanthology.org/2026.findings-acl.2069/ （⚠ **只拿到检索结果的标题与 URL，未打开正文核实作者与确切日期** ⇒ 待核）。
  - `Anatomy of Agentic Memory` https://ar5iv.labs.arxiv.org/html/2602.19320 （**日期不明**）。
- **与本仓的关系**：
  - **能用在哪**：本仓**已有雏形**——`journal` / `reflections` / `stated` 偏好；
    而且 `assembleContext` 会**按任务过滤记忆，并把证据不足的反思丢掉**：
    `m.reflections` 只保留 `evidenceIds.length >= 3` 的条目（`src/coach/runtime.js:371`），
    证据对象**整块移除**、绝不切碎成非法 JSON（`:378`）。
    这条「**记忆必须带证据 id**」正是本仓比通用做法**更严**的地方。
  - **判据怎么写**：①记忆条目必须带**证据 id**，无证据的必须被丢掉；
    ②跨局核对保持 `checked/recurred/improved` 三态，**不许把「没出现」说成「做到了」**
    （`docs/roadmap/AGENTIC-TECH-IDEAS.md:73`）；③预算不够时必须**整块丢证据**并如实报
    `retainedEvidenceIds`（`src/coach/runtime.js:379-381`）。
  - **反面风险**：**编造型记忆**。仓内已记一条外部反面证据：
    `Honest Lying: Memory Confabulation in Reflexive Agents`
    （`[外部]` https://browse-export.arxiv.org/pdf/2605.29463 ，仓内标为「2026（预印本）」，
    出处 `docs/roadmap/AGENTIC-TECH-IDEAS.md:40`）——
    直接含义：「**纠错可以，但错误回执必须是程序生成的收据**，不许让模型自己总结『我上次错在哪』当事实」。
  - **额外风险**：Anthropic 提醒**压缩/记忆是有损的**——
    「过度激进的压缩会丢掉那些**重要性后来才显现**的细微但关键的上下文」。
- **可靠性**：**高**（官方博客 + 可核对的工程实践 + ACL Findings 级 survey）。
  「Claude playing Pokémon」是官方**举例**，**不是学术评测**，别当能力证据。

### 3.4 `context engineering`

- **一句话**：把「**推理时到底放哪些 token**」当**工程问题**优化——
  目标是在模型有限的**注意力预算**下找到**最小的高信号 token 集合**；
  它是 prompt engineering 的**自然演进**。
- **一手来源**：Anthropic Applied AI 团队（Prithvi Rajasekaran、Ethan Dixon、Carly Ryan、Jeremy Hadfield 等），
  《Effective context engineering for AI agents》，**2025-09-29**，
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **关键论点（逐条，都可判定）**：
  1. **上下文有限、边际收益递减**：token 越多，模型**准确召回**上下文信息的能力**越下降**
     （文中称 **context rot**，引 Chroma 研究 https://research.trychroma.com/context-rot ）。
  2. **系统提示要「海拔对」**：一端是**硬编码的脆弱 if-else 提示**，另一端是**过度笼统**；最优在中间。
  3. **工具要自足、少重叠**：tool 定义的是 agent 与信息/动作空间的**契约**；
     最常见的失败模式之一是「**臃肿的工具集**」——「如果人类工程师都说不清该用哪个工具，不能指望 agent 说清」。
  4. **few-shot 给「多样的典范例子」，不要堆边界情况清单**。
  5. **长时程三件套**：**compaction**（压缩后重开窗口）、**structured note-taking**（= agentic memory）、
     **sub-agent 架构**（子 agent 探索几万 token，只回 1,000～2,000 token 的浓缩摘要）。
  6. **趋势判断**：「随着模型变强，agentic 设计会趋向于**让智能模型自主行动**，人工策展越来越少」，
     但「**做最简单且能跑通的事**」仍是最好的建议。
- **与本仓的关系**：
  - **能用在哪**：**这是本仓最该先做的一条**。仓内已有真数字：49 例烧 **104 926 API input tokens（≈2.1k/例）**，
    而**根因已定位**——`buildContext` 把整份局面（`player`/`enemy` 整块 `structuredClone`）放进 receipts
    （`src/coach/runtime.js:23`），与提示里「已能从 receipts 答出来就别调」**口径打架**，
    导致「该调没调」占 15/16 条失败（`docs/roadmap/AGENTIC-TECH-IDEAS.md:18-19`、`:56`、`:80`）。
  - **判据怎么写**：**单例 token** 与**工具选择率（现 33/49）**、**answerConsistency（现 47/49）**、
    **守卫通过率**必须**同时**报、**同时**不退化。机读落点是 `assembleContext` 的 `audit`
    （`window` / `outputReserve` / `systemReserve` / `toolReserve` / `estimatedInput` / `retainedEvidenceIds`，
    `src/coach/runtime.js:381`）。
  - **反面风险**：①**省 token 会省掉必要证据** ⇒ 必须与守卫联动判；
    ②「硬编码脆弱逻辑进提示」正是本仓 `policyFor` 的形状（`src/coach/runtime.js:179-188`）——
    它有实测理由（模型「该不该调」只有 50%，`:176-178`），但按 Anthropic 的「海拔」标准它**偏低**；
    ③**compaction 有损**：本仓 `assembleContext` 已在做整块丢证据并如实记账（`:375-381`），这条纪律不能松。
- **可靠性**：**高**（官方工程博客，论点可核，且给了外部研究链接）。
  ⚠ 术语归属：文中把 "art and science of curating what goes into the context window" 归给
  **Karpathy** 的一条推文（https://x.com/karpathy/status/1937902205765607626 ，**日期不明**）。

### 3.5 `agent skills`（Agent Skills）

- **一句话**：一个 skill 就是**一个文件夹里的 Markdown 文件**（含 YAML frontmatter）+ 可选脚本；
  agent 启动时只扫每条的**几十个 token 的摘要**，**需要时才加载全文**——
  用「**渐进式披露**」给通用 agent 装专业知识。
- **一手来源**：
  - Anthropic 官方公告 **2025-10-16**：https://www.anthropic.com/news/skills ；
    官方工程详解 https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
    （日期由 Simon Willison 当日报道并引用原文锚定：https://simonwillison.net/2025/Oct/16/claude-skills/ ，**2025-10-16**）。
  - 官方博文《Building Agents with Skills》 https://claude.com/blog/building-agents-with-skills-equipping-agents-for-specialized-work
    —— **页面日期抓不到，日期不明**。
  - 官方文档（概览）：https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview （**日期不明**）。
  - 示例仓库：https://github.com/anthropics/skills
- **生态**：后续（**日期不明**）已**开源为开放标准**，并有**组织级管理 + 合作伙伴目录**；
  Microsoft Agent Framework 也内置了 Agent Skills：https://learn.microsoft.com/en-us/agent-framework/agents/skills 。
- **与本仓的关系**：
  - **能用在哪**：**结构上高度对应，但本仓已经有等价物，且更严**。本仓的「技能」就是
    **工具合同**（`src/coach/toolbox.js:144-162` 的 `TOOL_CONTRACTS`，13 个工具）与
    **硬工具**（`:22-27` 的 `HARD_TOOLS`，只有三个且都必须经过引擎）。
    仓内对 MCP / 协议层 / 多 agent 的既定判断是「**现在不加**」
    （`docs/roadmap/AGENTIC-TECH-IDEAS.md:62`）。**可吸收的部分**：把**工具合同写得更像协议**
    （输入 schema、错误码、幂等）——这本来就是本仓强项。
  - **判据怎么写**：本仓现成的强判据是「**回执必须能被复算**」：每个回执带
    `ruleset_id / state_version / coverage / evidence_ids / latency_ms / error_type`，
    引擎说「不支持」时 `result` 为 `null`，**绝不出现编造的数值**
    （`src/coach/toolbox.js:154-156`、`:508-509`）。新增「技能」必须**同样**带回执与证据 id。
  - **反面风险**：①**技能会膨胀工具集**，而 Anthropic 自己警告过臃肿工具集（§3.4 论点 3）；
    ②`SKILL.md` 这类「可装载指令」在本仓语境下等于**又一份事实源**，
    与「包只做索引、不许出现第三份事实源」的纪律冲突（`docs/roco/GAME-DATA-PACK.md:160-168`）。
  - **与 Jev 的交叉点**：**Jev 官方自己也发了一个 Agent Skill**
    （`npx skills add typesafe-ai/skills`，https://docs.typesafe.ai/agent-skill ）——
    说明「决策模型作为 harness 组件」正是这个生态的当前形状。
- **可靠性**：**高**（官方公告有明确日期 2025-10-16，且已被 Microsoft 等第三方实现）。
  但**部分页面日期不明**，且带产品推广色彩。

### 3.6 `Agentic-JEPA`（`agenticjev` 的第 2 号候选）

- **一句话**：把 **JEPA**（Joint Embedding Predictive Architecture）拿来做**文本环境里**的
  **无奖励世界模型**，用「预测下一状态嵌入 + 与目标嵌入的余弦相似度」给候选动作打分、从而做规划。
- **一手来源**：**HAL** https://hal.science/hal-05546567 （v1 **2026-03-10**，v2 **2026-05-16**，
  HAL 明确标「Pré-Publication / Preprint」）；
  **Zenodo** https://zenodo.org/records/20237490 （v2，**2026-05-16**，DOI `10.5281/zenodo.20237490`，
  资源类型标 **Preprint**，CC-BY-4.0；抓取时 428 次浏览 / 81 次下载）；
  代码 https://github.com/franfj/agentic-jepa （MIT）。
  作者 **Francisco-Javier Rodrigo-Ginés**（**唯一作者**），ORCID 0000-0001-6235-6860，
  UNED（西班牙国立远程教育大学）NLP & IR Group。
- **是否同行评审：否。** 证据：① HAL 与 Zenodo 都归类为 **preprint / working paper**，
  **没有期刊或会议信息**，**没有 DOI 指向正式出版物**；
  ② 项目 README 的 BibTeX **写着 `journal={arXiv preprint arXiv:XXXX.XXXXX}`——占位符**，
  **该论文没有 arXiv 编号**（多角度检索 arXiv 均未命中）；
  ③ 专门检索「peer reviewed / published conference 2026」**没有找到任何接收记录**。
- **它自己的结论（比论文本身更重要）**：
  - **分布内**环境：**100% 成功**、接近 oracle 的规划效率；
  - **每一个分布外**环境：**0% 成功**（无论什么动力学类型）；
  - **k 步前瞻反而变差**（k=3 时 100% → 40%，作者归因于预测误差累积）；
  - 骨干从 GPT-2 换到 4-bit Qwen 2.5-1.5B **没有**恢复 OOD 成功；
  - 作者诊断：编码器**按「环境身份」而不是「功能角色」划分表征**，
    跨环境迁移的两个必要条件（encoder coverage、structural alignment）**都不成立**。
  - HAL v1 版本更弱（GPT-2、3 个环境、proof-of-concept）。
- **与本仓的关系**：
  - **能用在哪**：**不能用**。只值得吸收**思路**：把「先预测再行动」用在**解释层**，
    而且必须**声明为未核验的启发式**，**不参与结算**（仓内同口径：`docs/roadmap/AGENTIC-TECH-IDEAS.md:47`）。
  - **判据怎么写**：若真要做实验，判据必须是「**分布外**环境的成功率」——
    这篇论文的教训正是「分布内 100% 是幻觉」。
  - **反面风险**：**这是本仓最强的一条劝退证据**。本仓有 622 只精灵、824 条技能、245 条特性，
    绝大多数组合对任何训练分布都是**分布外**；一篇专门做这件事的论文在 OOD 上拿到 **0%**。
    ⇒ 「用世界模型替代规则引擎」在本仓**既有红线**（不可复算）之外，**还多了一条实证**。
- **可靠性**：**低**（**单作者、未经同行评审的自上传预印本**）。
  **绝不能说「有研究证明 / 已发表论文表明」**；只能说「有这样一个预印本」。
  但它「对自己不利」的结论反而是**可信度加分项**（没人会为营销去发 0% OOD 的结果）。

### 3.7 ⚠ `RLCD` —— **这个词有两个完全不同的含义，引错就是错误引用**

> **这是本次调研里最容易出错的一处。仓内 `AGENTIC-TECH-IDEAS.md` 与常见转述都只提到一个含义。**

| | **含义 A：TypeSafe 的用法** | **含义 B：学术既有用法（早两年）** |
|---|---|---|
| 全称 | **R**einforcement **L**earning for **C**alibrated **D**ecisions | **R**einforcement **L**earning from **C**ontrastive **D**istillation |
| 是什么 | 训练模型返回**决策 + 校准概率**而不是生成文本 | 用**正/负两组 prompt** 生成**对比输出**造偏好对，**无需人工标注**训练偏好模型，再做 RL |
| 一手来源 | 官方定义：https://docs.typesafe.ai/introduction/machine-learning-primer （**日期不明**） | Kevin Yang, Dan Klein, Asli Celikyilmaz, Nanyun Peng, Yuandong Tian，**arXiv:2307.12950**，v1 **2023-07-24**，v3 **2024-03-16**，**ICLR 2024**，https://arxiv.org/abs/2307.12950 |
| 任务域 | 结构化决策 / 分类 / 路由 | harmlessness / helpfulness / story outline |
| 学术一手性 | **⚠ 没有找到正式论文/预印本**——**只有厂商自己的文档与博文** ⇒ **目前是厂商术语** | **有**（ICLR 2024） |

- **⚠ 结论**：**引用时必须写全称并注明是哪一个。**
  把 ICLR 2024 那篇 `RLCD` 当成 Jev 的训练方法来引用会是**错误引用**；
  **没有任何证据表明二者存在继承关系**。
- **与本仓的关系**：
  - **能用在哪**：只作为「**为什么它敢报概率**」的解释，不构成本仓任何技术承诺。
  - **判据怎么写**：若真评它，「**置信分桶校准**」是仓内**已经写好**的判据项
    （`docs/roadmap/JEV-DECISION-EVALUATION.md:24`）。
  - **反面风险**：**「校准是训练目标」不等于「这个模型的输出在你的任务上已校准」。**
    校准是**任务与分布相关**的；跨到本仓的 622 只精灵语境上**必须自己重量**
    （仓内同口径：`:35`「结构化输出保证类型，不保证判断正确」）。
- **可靠性**：**含义 A 低**（供应商自述，**无独立同行评审或第三方复现**）；
  **含义 B 高**（ICLR 2024 论文）。**两者都必须标清。**

### 3.8 `MCP`（Model Context Protocol）

- **一句话**：一个**开放标准**，让 AI 应用以统一协议连接外部数据源与工具
  （MCP server 暴露数据，MCP client 连接），替代碎片化的定制集成。
- **一手来源**：
  - Anthropic 发布公告 **2024-11-25**，作者 **David Soria Parra** & **Justin Spahr-Summers**：
    https://www.anthropic.com/news/model-context-protocol
  - 规范与 SDK：https://modelcontextprotocol.io ・ https://github.com/modelcontextprotocol
  - **2025-12-09 捐给 Linux Foundation 旗下的 Agentic AI Foundation（AAIF）**，
    与 Block 的 goose、OpenAI 的 **AGENTS.md** 并列创始项目；当时
    **10,000+ 活跃公共 MCP server**、SDK 月下载 **97M+**：
    https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ・
    https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- **与本仓的关系**：
  - **能用在哪**：**仓内的既定判断是「现在不加」**——
    「本仓已有显式工具合同 + 判据 + 白名单，接协议会多一层进程/网络面，收益不明」
    （`docs/roadmap/AGENTIC-TECH-IDEAS.md:62`）。
    可吸收的是**把工具合同写得更像协议**，而这在本仓已是强项
    （`src/coach/toolbox.js:144-162` + `:308-309` 的两张错误码表 `ROCO_ERROR` / `ROCO_FAILURE_CLASS`）。
  - **判据怎么写**：若将来要接，判据必须是「**回执语义不变**」——
    本仓两套现成约束可照搬：①`FORBIDDEN_ONLINE_PATTERNS` 禁止在线路径出现子进程 / Python 客户端
    （`src/coach/team-candidates.mjs:98-131`）；②工具参数里**不许有路径、文件名、URL 或代码**
    （`src/coach/toolbox.js:155-156`）。MCP **同时**触碰这两条（外部进程 + 外部资源），
    所以这两条判据必须先扩写再谈接入。
  - **反面风险**：①**多一层进程/网络失败面**（本仓已有 11 种错误码，再叠协议错误会继续膨胀）；
    ②**安全边界**：Jev 官方 limitations 都提醒「**不要把模型当作安全边界**」——
    MCP 把外部工具接上 agent，等于把攻击面从「模型可能说错」扩到「工具可能被诱导调用」。
  - **⚠ 重要减分项（供评估）**：Simon Willison **2025-10-16** 指出 MCP 的**token 开销**是显著缺陷
    （GitHub 官方 MCP 单独就吃掉**数万 token** context），并说他自己的兴趣在用了 coding agent 之后已经减弱
    ——「几乎任何 MCP 能做的事，一个 CLI 工具都能做，而 LLM 会 `cli-tool --help`」。
    **Skills 相比 MCP 的最大优势正是 token 效率。**
    （`[外部]` https://simonwillison.net/2025/Oct/16/claude-skills/ ）
- **可靠性**：**最高的一档**（开放规范，已中立治理，已 GA，有 Linux Foundation 新闻稿）。

### 3.9 其他真正在热的术语（简表）

| 术语 | 一句话 | 一手来源（URL + 日期） | 与本仓 |
|---|---|---|---|
| **agent harness / harness engineering** | harness = 包在模型外面的那层「**循环 + 工具 + 上下文管理 + 权限**」脚手架；harness engineering = 把工程重心放在这层而不是 prompt 上 | `[外部]` GitHub 官方博客《Decoding the new AI lingo: Loops, harnesses, squads, hill climbing…》https://github.blog/ai-and-ml/decoding-the-new-ai-lingo-loops-harnesses-squads-hill-climbing-oh-my/ （**日期不明**）；LangChain《Building a Harness with Jev》**2026-09-17** | **高度对口**：本仓的 harness 就是 `src/coach/runtime.js` + `src/coach/toolbox.js`。**可靠性：半稳定**——GitHub 官方都在解释它，说明已进主流；但 Zenodo 预印本《Loop Engineering》（v2 **2026-08-21**，https://zenodo.org/records/22051081 ）记录该词「从一篇博客造出来到成为厂商抢占的有争议术语**只用了数周**」⇒ **带明显 marketing 成分** |
| **「agents = LLMs autonomously using tools in a loop」** | agent 的**工作定义** | `[外部]` Simon Willison，**2025-09-18**，https://simonwillison.net/2025/Sep/18/agents/ ；**已被 Anthropic 2025-09-29 文章采纳**为工作定义 | **能直接用**：本仓唯一的真 agent 循环就是 `gatherAgentEvidence`（`src/coach/runtime.js:265-351`）。这也是让「Jev 这类循环内判断层」成立的概念基础 |
| **GEPA**（反思驱动的提示进化） | 用「轨迹 + 自然语言反思」迭代**提示**，而非训权重 | `[外部]` ICLR 2026 proceedings：https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html （标为 ICLR 2026；**仓内已引用**，`docs/roadmap/AGENTIC-TECH-IDEAS.md:31`） | 仓内判为「**有用，但必须先解决『该不该调工具』的口径冲突**」；最大风险是**对着评测过拟合**（同文件 `:32-35`） |
| **Agentic AI Foundation（AAIF）** | Linux Foundation 下 **2025-12-09** 成立的定向基金，Anthropic / Block / OpenAI 共创，Google / Microsoft / AWS / Cloudflare / Bloomberg 支持 | `[外部]` https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation | 生态背景；**本仓暂无相关动作** |
| **AGENTS.md** | OpenAI 提出的 Markdown 指令约定，AAIF 创始项目之一 | `[外部]` https://agents.md （**日期不明**） | 与本仓 `CLAUDE.md` / handoff 文档习惯同源 |
| **confidence-gated routing** | 用置信度决定「自动执行 / 交更强模型复核 / 转人工」 | `[外部]` Jev 官方 Patterns（https://docs.typesafe.ai/ ，**日期不明**） | **这正是 §4 里唯一合规的用法** |
| **context rot** | token 越多，模型准确**召回**上下文信息的能力**越下降** | `[外部]` Chroma 研究 https://research.trychroma.com/context-rot （**日期不明**；经 Anthropic 2025-09-29 引用） | **本项目 2.1k tok/例的上下文瘦身，理论依据就是它** |

---

## 4. 「Jev 这类**校准概率**模型」对「禁止造胜率/概率」红线的评估

> 这是本文最该给出诚实判断的一节。**结论：有条件有帮助，但默认是危险品。**

**红线（仓内）**：**不造胜率 / 概率 / 百分数。** 模型分数、通过率、覆盖率**都不是**胜率
（`docs/roadmap/MODEL-ROUTING-PLAN.md:265-266`）。
机读落点：`BANNED_CLAIM_KEYS`（含 `win_rate` / `win_probability` / `胜率` / `期望值` / `评分`…）、
`BANNED_CLAIM_WORDS`（含 `T0` / `强势` / `必带` / `梯队`…）、
`NEGATION_MARKERS`（否定语境豁免），以及 `no_win_rate: true`
（`src/coach/team-candidates.mjs:1808-1826`、`:1585`、`:2371`）。

### 4.1 为什么它**看起来**是解药

1. **它不生成文本，所以结构上不可能「编造」输出**：你只能得到预定义选项里的一个 label + 一个 0～1 的数。
   对「绝不凭空写出一句 62.5% 胜率」这类失败模式，它是**结构性免疫**的——**比任何 prompt 约束都强**。
2. **它把不确定性变成可编程接口**：官方 Confidence 页的「**I don't know is a useful signal**」
   与三级路径（高置信自动 / 中置信确认 / 低置信不行动）正好映射到本仓的
   「缺证据时必须弃答」（`docs/roadmap/CULTIVATION-PAGE-PLAN.md:66`）。
3. **官方自己就在教你防幻觉式过度声称**：文档写着校准「**不保证单条答案正确**」；
   jaggedness 页写着「**不要用 score 的期望值反推精确数值**」。

### 4.2 为什么它**默认是危险品**（每条都有实测/官方证据）

| # | 危险 | 证据（出处见 §2.5 / §2.7 / §2.8） |
|---|---|---|
| 1 | **一个 0～1 的数天然会被读成概率、进而被读成胜率** | 这正是红线要防的东西。**Jev 的 API 形状本身就在鼓励**把 `noul: 0.95` 渲染成 "95%"——**接口形状就是风险来源** |
| 2 | **它的概率不是确定性的，而且会漂移** | 同 payload 只有 **24%～39% 逐位相同**；p99 漂移 0.05、**最坏 0.17**；12/732 跨过阈值翻转判定 ⇒ **「可复现的胜率」在物理上做不到** |
| 3 | **52% 的决策位概率恰好是 1.0** | 若设 0.95 闸门，**超一半回答直接通过**，闸门形同虚设 ⇒ 「高置信」在这种模型上是**廉价且廉价的自信** |
| 4 | **有已知的系统性崩坏域，包括对抗内容** | 3-SAT 上**恒答 satisfiable**；伪造权威的注入**翻转 147/200** 张工单的判定；而 0.8 闸门只能抓住 **0%** 的「通顺胡话」⇒ **state 里含任何用户可控文本，判断就可被操纵** |
| 5 | **中文精度官方明说是降级区** | 「including CJK scripts, are handled but not equally well; test on your own content」；且顺序量表在日语实测中已因**选项位置**崩坏 ⇒ **本仓用户是中文，这是叠加风险** |
| 6 | **它是一个「黑箱浮点数」** | 它**不给你理由**（不生成解释）——「如果它标记为 spam，是哪些内容信号触发的？」没有理由地把浮点数呈现给用户，**可审计性为零**，而本仓红线的本质**就是可审计性要求** |
| 7 | **「校准」只保证群体统计** | 官方原话：「does **not** guarantee that an individual answer is correct」⇒ **它不能提供任何「保证」** |

### 4.3 可判定的合规约束（如果将来真要接）

1. **概率不出网**：概率/置信值**只允许**存在于服务端回执的内部字段；
   **任何**面向玩家的文案生成路径都**不得**读到它。
   判据 = 在 `checkGroundedAnswer` 的数字白名单里**不登记**任何来自决策模型概率的值
   （现成机制：`src/coach/runtime.js:462-463` 的 `supported` 集合）。
2. **在代码里离散化**：用**自己的**分箱把 `probabilities` 折成**低/中/高三档的有序 label**，
   对外只说**定性档位**（「证据充分 / 证据不足 / 无法判断」），并**永远附上依据清单**
   （依据来自**本仓自己的数据**，不来自 Jev 的分数）。
3. **要展示数字就展示「样本量 + 来源」，不展示「概率」**：
   「基于该对局数据库中的 N 场同类对局」是**可核查的统计**；
   而 Jev 的 0.83 是**模型信念**。**前者可以说，后者不能说。**
4. **置信度只用于「是否转人工 / 是否拒答」的闸门**，不用于「答案的强度」——
   这是官方与独立测试**都验证过**的唯一可靠用法（≥0.7 时零错误 / AUROC 排序能力）。
5. **不许改名叫「强度」**：`BANNED_CLAIM_WORDS` 已涵盖「强度分/强度值/期望值」，
   所以「把概率包装成强度」这条路**判据已经堵住**（`src/coach/team-candidates.mjs:1812-1814`）。
   **必须保留否定语境豁免**——否则会把「这不是胜率」这类**边界声明**也判红，
   等于逼实现方删掉最该保留的一句话（同文件 `:1816-1825` 的注释逐字解释了这个设计）。
6. **固定版本 ID**（`jev-1.13.0`，**别用 `jev-latest`**）+ **每题跑 3 次看漂移** +
   **阈值放在分布的山谷里** + **用 `probabilities` 而不是只看 `confidence`**。
7. **state 里绝不放未经净化的用户可控文本**，或至少对注入做**专门测试**。
8. **失败必须可安全回退**：离线、超时、低置信度一律**退回现有策略、不阻塞游戏回合**，
   且**不许让 Jev 生成游戏事实或绕过权限**（`docs/roadmap/JEV-DECISION-EVALUATION.md:26`）。

### 4.4 诚实结论

> **Jev 能帮你「不说假话」（结构上不生成），但不能帮你「不出错」，而且极易被包装成假话。**
> 它降低的是「**造数字**」的成本，**不是**「造数字」的风险。
> 对于一个红线是「**绝不编造概率**」的产品，它的默认姿态应当是
> 「**只用来做内部分流，不进入任何数值型用户输出**」。
>
> **而且它不是「600 只 + 复杂机制」这个问题的解。**
> 它解决的是「**在 agent loop 里把大量 LLM 调用换成廉价的窄判断**」这个问题
> （`[外部]` 腾讯云开发者社区标题即「它想把 Agent 里的大量 LLM 调用干掉」，
> https://cloud.tencent.com.cn/developer/article/2748203 ，**日期不明**）。
> 本仓的规模问题在**检索与证据**（1694 篇语料、344/824 可模拟实体、605 只卡在特性），
> **不在「分类调用太贵」**；而且它**自己承认算数与计数不可靠**（§2.7），
> **连结算的边都碰不到**。
> ⇒ **定位：阶段 E 之后的可选实验；现在不在关键路径上。** 详见 `docs/roadmap/AGENT-FIRST-AT-SCALE.md` §6.4。

---

## 5. 我查过的关键词清单（**完整**，便于复核）

### 5.1 `agenticjev` / `jev` 方向

1. `agenticjev` ・ 2. `"agentic jev"` ・ 3. `"agentic-jev"` ・ 4. `"Agentic Jev" TypeSafe` ・
5. `"agenticjev" OR "agentic-jev" OR "agentic jev" TypeSafe` ・ 6. `"jevi" AI model 2026` ・
7. `Jev System One model TypeSafe AI` ・ 8. `TypeSafe AI Jev calibrated probabilities state questions` ・
9. `"System One Models" Jev noul choice score` ・ 10. `TypeSafe AI Jev pricing per million latency` ・
11. `docs.typesafe.ai noul choice score question types` ・ 12. `Jev calibration calibration error benchmark TypeSafe` ・
13. `Jev limitations multilingual non-English state TypeSafe` ・ 14. `TypeSafe Jev determinism temperature reproducible outputs` ・
15. `docs.typesafe.ai primitives noul definition` ・ 16. `Jev adversarial evaluation willkelly 28 predictions results` ・
17. `willkelly jev-evaluation results calibration findings` ・ 18. `Jev deterministic output same input same answer reproducibility determinism` ・
19. `TypeSafe Jev 200x faster 400x cheaper claim benchmark` ・ 20. `typesafe.ai blog introducing System One Models Jev release date September 2026` ・
21. `TypeSafe AI Jev launch date unveiled September 2026 first System One model` ・
22. `LangChain blog building a harness with Jev September 17 2026` ・
23. `TypeSafe AI Jev waitlist available to everyone September 2026 open access date` ・
24. `Jev public launch all users 120 million free tokens date September 2026` ・
25. `Jev全网解禁 1.2亿Token 日期` ・ 26. `36kr Jev full public launch 120 million free tokens date` ・
27. `TypeSafe AI $40 million seed DCVC Jev stealth debut` ・ 28. `pedaily Jev 193倍 444倍 只做选择题的模型` ・
29. `Diogo Almeida TypeSafe cofounder RLCD calibrated decisions` ・
30. `TypeSafe "reinforcement learning for calibrated decisions" paper arxiv calibrated decisions decision models` ・
31. `TypeSafe Jev "zero hallucinations" claim official site` ・ 32. `docs.typesafe.ai hallucination Jev cannot hallucinate` ・
33. `emergent.sh what is jev TypeSafe date` ・ 34. `Jev classifier not an LLM criticism 2026 limitations honest` ・
35. `game AI coaching agent LLM Pokemon 2026`

### 5.2 `Agentic-JEPA` 方向

36. `agentic JEPA world model agent` ・ 37. `"agentic JEPA" paper` ・ 38. `Agentic-JEPA paper` ・
39. `"Agentic-JEPA" arxiv abs 2026` ・ 40. `arxiv Rodrigo-Ginés Agentic-JEPA world model text-based agent environments` ・
41. `"Agentic-JEPA" peer reviewed published conference 2026 Rodrigo-Ginés` ・
42. `franfj agentic-jepa github repository JEPA world model`

### 5.3 相邻热点

43. `Agentic RAG survey 2025` ・ 44. `Agentic RAG survey arxiv 2025` ・
45. `arxiv 2501.09136 Agentic Retrieval-Augmented Generation survey` ・ 46. `"Agentic RAG" arxiv 2501 survey` ・
47. `"agentic RAG" 定义 中文 智能体检索增强生成` ・ 48. `agentic retrieval` ・
49. `"agentic retrieval" Azure AI Search agentic retrieval GA Microsoft` ・ 50. `agent memory` ・
51. `agent memory long-term memory LLM agents paper survey` ・ 52. `agent memory survey 2025 long-term memory LLM agents arxiv` ・
53. `MemGPT Letta paper arxiv long-term memory` ・ 54. `agent skills` ・
55. `Anthropic Agent Skills announcement engineering blog` ・ 56. `Anthropic "Agent Skills" announcement October 2025 SKILL.md` ・
57. `"Agent Skills" Anthropic October 16 2025 announcement SKILL.md` ・
58. `Anthropic "Introducing Agent Skills" October 16 2025` ・ 59. `Anthropic news "Agent Skills" October 2025 introduce skills claude` ・
60. `anthropic.com engineering equipping agents for the real world with agent skills` ・
61. `claude.com/blog/skills published date October 2025` ・ 62. `agent skills SKILL.md progressive disclosure open standard` ・
63. `context engineering` ・ 64. `context engineering definition Anthropic effective agents` ・
65. `MCP` ・ 66. `Model Context Protocol specification introduction Anthropic` ・
67. `Model Context Protocol specification Anthropic announcement November 2024` ・
68. `MCP donation Linux Foundation agentic AI` ・ 69. `OpenAI AGENTS.md standard agentic AI foundation` ・
70. `Agentic AI Foundation AAIF launch December 9 2025 founding projects AGENTS.md goose` ・
71. `RLCD reinforcement learning from contrast distillation paper arxiv` ・
72. `"RLCD" calibrated decisions TypeSafe definition origin` ・
73. `agent harness term 2026 why agent harness popular` ・ 74. `"harness engineering" term 2026 origin` ・
75. `"loop engineering" AI agents 2026 term` ・ 76. `agentic commerce protocol 2026 hot agent terms` ・
77. `agentic AI hot terms late 2025 2026 glossary harness loop engineering` ・
78. `simonwillison.net/2025/Sep/18/agents tools in a loop definition agent` ・
79. `agentic retrieval memory context engineering 2025`

### 5.4 实际抓取过的页面（HTTP 200）与**抓取失败/受限**的页面

| URL | 结果 |
|---|---|
| https://arxiv.org/abs/2501.09136 | ✅ 成功；**v1 2025-01-15，v4 2026-04-01** |
| https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | ✅ 成功；**2025-09-29** |
| https://www.anthropic.com/news/model-context-protocol | ✅ 成功；**2024-11-25** |
| https://zenodo.org/records/20237490 | ✅ 成功；**2026-05-16** |
| https://www.requesty.ai/blog/typesafe-jev-explained | ✅ 成功；**最后更新 2026-09-19** |
| https://www.langchain.com/blog/building-a-harness-with-jev | ✅ 成功；**2026-09-17** |
| https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev | ⚠ 200 但**正文截断，日期不明** |
| https://claude.com/blog/building-agents-with-skills-equipping-agents-for-specialized-work | ⚠ 200 但**正文截断，日期不明** |
| https://typesafe.ai/blog/introducing-system-one-models-and-jev | ❌ **JS 渲染，正文读不出来**（一手来源**不可直接引用原文**） |
| https://typesafe.ai/faq | ❌ **404**（「官方承认仍可能出错」这句**只有二级转述，未取得一手原文**） |
| https://venturebeat.com/security/…jev…prompt-injection… | ❌ **429 + 安全验证**，未取得内容 |
| https://techcrunch.com/2026/09/18/… | ⚠ 200 但正文截断，仅用于确认 **2026-09-18** 这个日期存在 |
| https://github.blog/…decoding-the-new-ai-lingo… ・ https://www.anthropic.com/news/skills ・ https://claude.com/blog/skills | ⚠ 正文截断 / **日期不明** |

> **⚠ 证据链的诚实说明**：因为 `typesafe.ai` 主站是 JS 渲染、FAQ 页 404，
> **本文里所有「厂商声称」我都改用官方 `docs.typesafe.ai` 或二级来源转述，并逐条标注了性质。**
> 凡标「日期不明」的，就是**真的读不出来**，不是省略。

---

## 6. 读不出来 / 未验证（**别当成事实**）

1. **`agenticjev`：查不到可信来源，疑似 TTS/拼写失真。** 最接近的三个候选是
   ①**「agentic + Jev」的转写连写**（最可能）；
   ② **`Agentic-JEPA`**（真实存在，但**单作者、未经同行评审**，且作者自己的 OOD 结果是 **0%**）；
   ③ **`agentic` + `Jev` 的组合表达**。
2. **TypeSafe 官方博客正文读不出来**（JS 渲染），**发布日期读不出来**，**官方 FAQ 404**。
   目前最可靠的日期锚点是**发布推文 2026-09-15** 与 **Requesty 的「Last updated 2026-09-19」**。
3. **`RLCD` 含义 A（Calibrated Decisions）没有学术一手来源**——只有厂商文档与博文。
   **引用时必须写全称**，别与 ICLR 2024 的 Contrastive Distillation 混为一谈（§3.7）。
4. **`Agent Skills` 部分官方页面日期不明**；该方向带产品推广色彩。
5. **Jev 的「193.6 倍 / 444.6 倍」是厂商在自动化工作流上的自测**，
   且**厂商自己注明「预计处于实际收益的较高端」且评测存在偏差可能性**；
   LangChain 写作「**up to** 200x / 400x」。**不许当成本项目从国内调用的实测结果**，
   **不许引用成确定的倍率**（仓内同口径：`docs/roadmap/JEV-DECISION-EVALUATION.md:35`）。
6. **「Zero Hallucinations」的含义仅限结构/类型层面**，**不等于不会答错**。
   「官方 FAQ 承认会出错」这句**只有二级转述**（FAQ 页 404）。
7. **ACL Findings 2026 那篇 agent memory survey 未打开正文核实**作者与确切日期 ⇒ **待核**。
8. **本文所有外部资料都未在本仓验证**，不得写成产品承诺。要落地必须走仓内既有的
   「最小对照 + 预注册判据 + 必红反证」流程（`docs/roadmap/JEV-DECISION-EVALUATION.md:22-26`）。
9. **仓内 `docs/roadmap/AGENTIC-TECH-IDEAS.md:158-159` 的附录结论（`jev` 没有可信一手来源）是错的**，
   与更早的 `docs/roadmap/JEV-DECISION-EVALUATION.md:30-33` 及
   `docs/roadmap/AGENT-FIRST-600-PLAN.md` §6 直接矛盾。本文只记录，**没有改动那三份文件**。
10. **本文没有跑任何门禁**，没有联网改仓，`data/roco/normalized/**` 只读。
