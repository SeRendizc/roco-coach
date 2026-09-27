# Jev / System One 决策模型：它对本仓有没有用、用在哪（2026-09-25 调研）

> 人类口径：「最近 **agentic jev 和 jev** 很火，你可以看看是否有用，但我不是太熟，提供个思路」。
> 本文只回答两件事：**它是什么（逐条带出处）**、**对本仓三个判定点能不能用（带判据与反证）**。
> 纪律：只读仓内其它文件；**没读到的写成「读不出来」**；**不为迎合而说它有用**。
> 抓取日期：**2026-09-25**（时区以本机为准）。

---

## ① Jev 是什么（逐条带出处）

| # | 事实 | 出处（抓取日期 2026-09-25） |
|---|---|---|
| 1 | 它是 TypeSafe 的 **System One 模型**：**不生成文本**，输入 `state` + 一组 `questions`，返回**类型化的判定**（`noul` 是否概率 / `choice` 选项概率 / `score` 有序打分）与置信 | [官方 Quick start](https://docs.typesafe.ai/introduction/quickstart)、[LangChain 指南](https://www.langchain.com/blog/building-a-harness-with-jev) |
| 2 | 接口形态：`POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer <API_KEY>`，body = `{state, model, questions}`；一次请求里问多个问题**并行评估** | 官方 Quick start（同 1）、[Models 参考](https://docs.typesafe.ai/models) |
| 3 | 当前型号 **Jev 1.13**（`jev-1.13.0`，别名 `jev-latest`） | Models 参考 |
| 4 | **价格：按输入 token 计费 $42 / Btok（= $0.042 / Mtok），输出 token 免费** | Models 参考 |
| 5 | 速率限制：250,000 tokens/s、1,200 req/min（官方声明**动态调整、可能无预告变化**）；超出返回 429 | Models 参考 |
| 6 | 上下文：单请求 64k（其中 `state` + 最长一问 ≤ 32k）；**只吃文本**（字符串 / JSON / 字符串数组），图片音视频要先转文本 | Models 参考 |
| 7 | **不做客户级微调/LoRA**，所有账号同一份权重；领域适配靠 `state` 里塞材料 + 在 `instructions` / `criteria` 里写规则与边界 | Models 参考「Customizing Jev」 |
| 8 | **语言：英文是主要训练语言、准确率最好；包括 CJK 在内的其它语言「handled but not equally well」，官方要求「在你自己的内容上先测」** | Models 参考「Language support」 |
| 9 | 数据：不拿客户请求/响应训练；企业可谈零留存（ZDR） | Models 参考「Data handling」 |
| 10 | 官方给的**模式**里，与本仓最相关的四个：**intent routing（意图路由）**、**confidence-gated routing（按置信路由/升级）**、speculative fan-out（一次问很多）、composite scoring（拆成原子问题再在代码里合成） | 官方文档侧栏 Patterns：`/patterns/intent-routing`、`/patterns/confidence-routing`、`/patterns/fan-out`、`/patterns/composite-scoring`（页面列出了这些路径，正文我只读到标题级） |
| 11 | 官方 cookbook 里有两篇直接对口的：**「Auto-Approve Coding Agent Permission Prompts with Jev」**（用它给工具调用做放行判定）与**「Cut LLM Cost with a Jev-Verified Cascade」**（级联省钱） | OpenRouter cookbook 目录（抓取到的导航列表） |
| 12 | **独立评测（不是官方）**：在一批 100 条真实 agent 工具调用 × 4 个标签（337 条三方评审一致的判定）上，`jev-latest` 零样本 **93%**、9-shot **95%**；对照 Sonnet 5 **98%**、**常数基线 79%**；危险调用召回 Jev **78%(7/9)**、Sonnet **44%(4/9)**；作者结论：**「Jev 是有前途的路由器」**，响应约 **300ms**、成本很低 | [Archestra：We Tested Jev on 100 Real Agent Calls](https://archestra.ai/blog/we-tested-jev-on-100-real-agent-calls)（2026-09-21） |
| 13 | **同一评测的稳定性警告**：同一 payload 重复跑，**只有 35–39% 的概率值逐位相同**（中位漂移 0.01、p95 0.05、最大 0.17）；标签本身较稳（400 条里 394–398 相同）；**三选一问题对选项顺序敏感**（约 4/100 翻转 ⇒ 准确率 −1.5~2pp），二选一不受影响；**置信度 ≥0.7 时在该数据集上零错**，作者据此认为「按置信升级」可行 | 同上 |
| 14 | **该评测的告警（对我们尤其重要）**：真实 trace 里 79% 的调用是「无害」的 ⇒ **一个常数分类器就有 79%**；「整体准确率好看」不代表在**执行边界**上可靠，必须看**它怎么错**（误拦 vs 漏放） | 同上 |
| 15 | 存在**开源/第三方复现与替代**：SemIf（原 OpenJev，`openjev.com`，Qwen3.5-4B / MiniCPM5-2B 骨干）、Laya（ModernBERT-large）、Qwen3-Reranker-4B、Bespoke-Nimble-9B；另有报道称 APUS 交出跨平台开源复现 | Archestra 评测的对照表（同 12）；中文报道 [科技日报](https://www.stdaily.com/web/gdxw/2026-09/20/content_584657.html)、[央广网](https://tech.cnr.cn/techph/20260920/t20260920_527819594.shtml)——**我只读到标题与摘要，未逐字核实其许可与权重可得性** |
| 16 | **读不出来 / 未核实**：Jev **自身**有没有开源权重或自托管方案（官方 Models 页面只说同一份权重服务所有账号，**没有**提开源自托管）；也没有读到明确的服务 SLA；`jev-capability-atlas`（独立证据库）与 TypeSafe 官方博客正文**抓取失败/为空**（前者 30s 超时，后者只回了标题） | —— |

**一句话**：Jev 是「**把一步判断变成一次便宜、可校准的分类调用**」的云服务；它**不产生事实**，
也不适合当生成模型用（[LangChain](https://www.langchain.com/blog/building-a-harness-with-jev) 原话：use an LLM for open-ended reasoning and generation, and Jev for fast, structured decisions）。

---

## ② 与仓内三个判定点的对照

### 判定点 1：**工具该不该调**（`src/coach/runtime.js::gatherAgentEvidence`）

| 维度 | 内容 |
|---|---|
| 现在怎么做 | **由代码政策决定**是否进入查证：`runtime.js:112-122` 用 `policyFor(message,context).need` 决定要不要调 `gatherAgentEvidence`，模型**只在「要调」之后**参与「还要不要继续查」；`:178` 的注释逐字写着「但『该不该调』只有 50%，所以把后者从模型手里拿走」 |
| 实测痛点 | 真 DeepSeek 臂在 49 例预注册评测里 **工具选择 33/49 = 0.673**，16 条失败中 **15 条是「该调却没调」**、1 条首枪选错（`reports/live-model-eval.json`） |
| ⚠ 必须先读懂的**口径冲突** | 那 15 条**不是模型能力问题**：`buildContext`（`runtime.js:23`）把**整份局面**（`player/enemy` 的 structuredClone）塞进 receipts，而 planner 提示（`src/server/index.js:418-420`）逐字写着「**默认是停止**……不需要调用的情况：……任何你已经能从 receipts 答出来的问题」。⇒ **口径不定，换谁判都白搭**：（甲）实时状态必须查证 vs（乙）不浪费调用 + 数字必须被守卫守住 |
| Jev 式做法能不能替代 | **形状完全对口**：`state` = 玩家原话 + receipts 摘要，`questions` = `{需要查证吗: noul, 查哪个工具: choice}`。它同时能替掉**代码政策**（第一步）与**云端 planner 的第一步** |
| 代价 | 新增一个**云依赖**（TypeSafe key；Jev 无自托管说明）；**CJK 风险**（官方明说中文「not equally well」，必须先冒烟）；调用约 300ms、按输入计费且输出免费 ⇒ 49 例约 0.1M token ≈ **不到 1 分钱**；`jev-latest` 是别名、会漂（要钉 `jev-1.13.0`） |
| 怎么判据化 | 沿用**现有 49 例预注册评测**＋`src/coach/cloud-replay.mjs`（录制一次、之后离线回放）：① 工具选择率；② cat2（该不调）的**过度调用率**；③ 延迟 P50/P95；④ **必须同时报「常数基线」**（Archestra 的教训：79% 常数基线能骗过宏观分数）。**必红反证**：(a) 把判定桩成「永远不调」⇒ 该调的用例必须红；(b) 桩成「永远调」⇒ cat2 用例必须红；(c) 常数基线必须出现在报告里，缺了判红 |
| 与红线冲突？ | **不冲突，但有两条边界**：它只决定「要不要查证据」，**事实仍由引擎/工具给**；它的**概率不得出现在玩家可见界面**（红线是「不造胜率/概率/百分数」）。另：不得因为引入它就把「未知 fail closed」改成「按概率猜」 |

### 判定点 2：**教练该不该开口**（`coach-advice.js` 检测器 + `roco-experience.js` 门控）

| 维度 | 内容 |
|---|---|
| 现在怎么做 | `coach-advice.js` 的每个检测器返回候选 `{kind,text,why,risk,evidence}` 并按 `KIND_PRIORITY` 排序；`roco-experience.js` 有一层经验门控，返回 `{action,gate,reason,value,floor,decisive,budget}`，其中 **`decision_margin_threshold = 0.146532` 是在一把尺子上标定出来的**（`roco-experience.js:127`），另有硬门（如 `hard-gate:stale-state`） |
| 已知状态 | 介入学习 **RC-704 BLOCKED**：要 3–5 人盲评才能开 `on`（`FLAGSHIP-V3-CHECKLIST.md:88`、`:101`） |
| Jev 式做法能不能替代 | **可以试，但不该现在替换**：`noul`「这一刻值得开口吗」+ `score`「打扰程度」形状合适；但这条链是**人环盲评**的地盘，且我们有「陪练不许打扰」的产品口径（`companion-nonintrusion` 判据） |
| 代价 | 同上的云依赖与 CJK 风险；额外风险是**假阳性**（多嘴）——评测里已有 `H2_false_positive_ceiling` 这条现成尺子，必须一起量 |
| 怎么判据化 | 用仓内已有的**介入窗口/一致性**产物（`reports/roco/rc704*`、`reports/roco/intervention-agreement.json`）当标注集：① 与现有门控的**一致性**；② 假阳性上限；③ 「该沉默时沉默」的比例。**必红反证**：判定桩成「永远开口」⇒ 沉默期望的用例必须红；桩成「永远不开口」⇒ 该开口的用例必须红 |
| 与红线冲突？ | 不冲突（它只决定「说不说」，不产生事实、不给胜率），但**不许**把它当成「可以绕过人环盲评」的捷径：RC-704 的闸门是**人**，不是模型 |

### 判定点 3：**`/api/coach` 的 planner**（`src/server/index.js`）

| 维度 | 内容 |
|---|---|
| 现在怎么做 | 一次云端 LLM planner 调用（约 160 输出 token / 2500ms 预算），提示里**明确带「默认是停止」的偏置**（`:418-420`）——这正是「欠调用」的直接原因之一 |
| Jev 式做法能不能替代 | **最适合先试这一处**：把「要不要查、查哪个」交给结构化判定，LLM 只留**生成**（解释/复盘）⇒ 更快、更省、也**不再依赖提示里的偏置措辞** |
| 代价 | 新云依赖 + CJK 风险；**必须「替换」而不是「叠加」**，否则出现两个事实源；`jev-latest` 漂移要钉版本号 |
| 怎么判据化 | 49 例前后对照（工具选择 / 过度调用 / 延迟 / 成本），离线回放可复现；**必红反证**同上（全停 / 全调 / 缺常数基线） |
| 与红线冲突？ | 不冲突：planner 只决定**去不去查证据**，不改任何数值；但**不许**用它生成面向玩家的结论（那是 LLM 的活，且要过服务端守卫 `validation`） |

---

## ③ 最小可验证实验（建议，**不要求现在实施**）

**目标**：只回答一个问题——「把**工具/查证判定**换成一次结构化判定，比现在的『代码政策 + 带偏置提示的云端 planner』更好吗？」

**做法（最小改动面）**
1. 加一个判定后端开关（例如 `ROCO_TOOL_DECISION=policy|llm|jev|const`），**默认仍是现状**（`policy`）；
2. `jev` 分支：`POST /v1/systemone`，`model` **钉 `jev-1.13.0`**，`state` = 玩家原话 + receipts 摘要，
   `questions` = `{need_lookup: noul, which_tool: choice(工具表)}`；
3. `const` 分支：**常数基线**（永远「不调」）——专门用来防「宏观分数好看」的假象；
4. 用**现有 49 例**跑四个后端，报告：工具选择率 / 过度调用率 / 延迟 P50·P95 / 成本 / **常数基线**。

**先决条件（缺一不可）**
- `TYPESAFE_API_KEY`（仓内目前**零引用**：`grep typesafe|systemone|Jev` 无命中）；
- **中文冒烟 3 条**：官方明说 CJK「not equally well」——先证明它能按中文 `instructions` 给出稳定判定，再谈准确率；
- **先把「工具该不该调」的口径定下来**（甲/乙，见判定点 1）——否则这个实验没有 ground truth 可对。

**判据与反证**：见判定点 1 的表格（三条反证必须真跑，且**缺常数基线判红**）。

**成本**：49 例 × 约 1–2k 输入 token ≈ 0.05–0.1M token ≈ **不到 $0.01**；即使把 1000 次重复跑满，也就几美元量级。
**失败时 fail closed**：判定服务超时/报错/置信低于阈值 ⇒ **回落到现在的代码政策 + 云端 planner**（现状行为），
**绝不**回落成「不查证据就作答」；阈值**不许**在同一批 49 例上调（避免把评测集当训练集）。

---

## ④ 结论

**值得试——但只值得在一个点上试：`planner`/工具查证的「该不该查、查哪个」。而且必须先定口径、先过中文冒烟。**
不建议现在替换「教练该不该开口」的门控，也不建议把它的概率暴露给玩家。

理由（逐条）：
1. **形状对口**：我们量到的痛点是**分类式判定**（该不该调 / 调哪个），不是生成；Jev 的 `noul` + `choice` 天生就是干这个的。
2. **便宜到可以忽略、比现状快**：$0.042/Mtok（输出免费）＋ 独立评测里约 **300ms**，而我们现在每例 planner 要 0.4–2.1s。
3. **但不是「魔法」，而且有两处硬不确定**：
   - 官方自己写着**英文最好、CJK 只是「handled」**——我们整条产品线是中文，**没做冒烟之前，任何准确率数字都不算数**；
   - 我们那 16 条失败里 **15 条是口径冲突**（事实本来就在 receipts 里）——**口径不定，换谁判都一样**。这条必须先解决，否则实验白做。
4. **独立评测把话说得很直**：它有前途（93–95%，危险调用召回 78% 高于 Sonnet 的 44%，置信 ≥0.7 时零错），
   但**常数基线就有 79%**、概率会漂（同 payload 只有 35–39% 逐位相同）、三选一有选项顺序敏感 —— 所以**必须带常数基线、必须钉版本、必须按置信升级**。
5. **就算不接它的云服务，思路也值得借鉴**（这部分是**零成本**的）：把「判断」与「生成」拆开、
   让判断走**结构化 + 可校准**的小模型/本地模型（我们本机已有 Qwen3.5-4B + LoRA：本轮实测
   结构化合法率 **12/12**、总延迟 p50 **511ms**、峰值内存 2.56GB），并**按置信升级到云端大模型**。
   开源复现（SemIf/`openjev.com` 等）也在，可作为不自建云依赖时的备选——**但它们的许可与质量我这次没有逐字核实**。
6. **有一个「不值得」的明确清单**：不值得用它做结算/数值（红线）；不值得用它替代人环盲评；
   不值得把它叠加在现有 planner 之上（会变成两个事实源）；不值得把它的概率当玩家可见结论。

**下一步（若人类点头）**：先要一个 TypeSafe key + 定下工具查证口径 → 跑 §③ 的四后端对照（几美分）→ 用数据决定「接入 / 只借鉴思路」。
