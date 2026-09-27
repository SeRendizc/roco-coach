# 面试题：缘起与背景（**不是交卷计划**）

> **定位（先读这一句）**：本仓的**缘起**是腾讯 IEG 面试题「基于 LLM 的智能 AI Coach」。
> **v0.1 已经交付过**（`docs/RELEASE-v0.1.md`；tag `v0.1.0`，见 `README.md:13-14`）。
> **PDF / 交卷物暂不用管** —— 人类 2026-09-25 明确：「**这个面试题我 v0.1 已经交付过了，我们主要还是做我们的项目，这个是缘起，pdf 暂时不用管**」。
> ⇒ 本仓当前重心是**项目本身的能力建设**（见 `docs/roadmap/AGENT-TECH-SURVEY.md` §3、`docs/roadmap/AGENT-TECH-INSTALL-TABLE.md`），
> **面试题只作缘起与验收视角的参照**。本文**不列交卷待办**。
>
> **纪律**：本文只做记录与对照。所有"本仓落点"都带 `文件:行号`；查不到的写「未找到」，**不猜**。
> 本文**没有改动任何源码、判据、`package.json` 或其它文档**。

---

## 1. 面试题原文（**逐字照抄，不许改写**）

> 面试题：基于 LLM 的智能 AI Coach
>
> 请设计并交付一个基于 LLM 的智能 AI Coach（陪练教练），可使用任何 AI 工具、框架与模型。
>
> 场景设定
> 一款宠物对战类游戏（如"洛克王国"式玩法：玩家拥有背包精灵，进行 PVP 对战、阵容搭配、日常成长）。
>
> 核心功能
> 你的 Coach 需要具备以下三种角色感（至少完整闭环其中一项，其它可仅做设计）：
> 1. 军师：在对战 / 阵容场景给出准确且可解释的决策建议；
> 2. 陪练：能闲聊、有情绪、记得玩家的历史与偏好；
> 3. 老师：不只是给答案，还能帮玩家进步（复盘、讲解、循序渐进）。
>
> 额外参考信息
> Agent 相关：Agentic RL、RAG 工程、ReAct、Memory Stream / Reflection 等。
> 产品参考：和平精英"小田"、王者荣耀"灵宝"。
>
> 提交要求
> 1. 阐述设计和实现过程中遇到的难点及方案
> 2. 提交 Word / PDF 均可，如果有运行 Demo更佳。
> 3. 截止时间： 3 天。

### 1.1 从题面拆出的三条硬约束（供验收视角参照）

| # | 题面要求 | 本项目怎么理解 |
|---|---|---|
| 1 | **三种角色感，至少完整闭环一项，其它可仅做设计** | 本仓**三项都做了实现**（见 §2 对照表），其中**军师与老师是完整闭环**（有引擎/判据/回执），**陪练是完整闭环但边界被刻意收窄**（只读不写记忆，见 `src/coach/companion.js:182-186`）。**"可仅做设计"这一豁免本仓没有使用。** |
| 2 | **"准确且可解释"**（军师） | 本仓把它读成两件可判定的事：**数字必须有出处**（`src/coach/runtime.js:1186` `checkGroundedAnswer`）＋**降级要说出来**（`src/coach/activity.js:13-15`）。 |
| 3 | **点名了五项 agent 技术**（Agentic RL / RAG 工程 / ReAct / Memory Stream / Reflection"等"） | 这五项**逐条**的现状、缺口、落地建议与判据见 `docs/roadmap/AGENT-TECH-SURVEY.md` 新增章「面试题点名的 agent 技术逐条深挖」。**那个"等"字按同章补的四项（Planning / 工具学习 / 多智能体 / 可观测性）一起看。** |

> **"截止时间 3 天"的时间线意义（如实登记，不美化）**：这个 3 天是**原始面试窗口**，对应的是 **v0.1 那一次交付**。
> **本仓 master 早已越过它**（`README.md:16-18`：master 正在往《洛克王国：世界》手游方向演进），
> 因此**不要把"3 天"当成当前任何工作的截止时间**。

---

## 2. 本仓 ↔ 三角色对照表（**给 `文件:行号`**）

**入口**：`src/coach/runtime.js:51` `export async function runCoach({message, role='auto', context, memory, conversation=[], provider=localProvider})`
—— 这是三角色**唯一的共同入口**，`role` 默认 `'auto'`（自动路由）。

### 2.1 路由：一句话怎么被分到某个角色

| 环节 | 位置 | 说明 |
|---|---|---|
| **自动路由（三选一）** | `src/coach/runtime.js:146` | 一行三目：`/培养\|加点\|成长/` ⇒ `teacher`；否则 `/怎么打\|建议\|这回合\|换宠\|换上\|换成\|换掉\|换一只\|补位\|技能\|出招\|先手\|能量\|豆\|属性\|克制\|防御\|守一下\|守住\|预判/` 或"局内情境" ⇒ `strategist`；**其余 ⇒ `companion`**。 |
| **路由的坑（有注释、有来历）** | `src/coach/runtime.js:144-145` | 原话记着一次真实故障：只说「守一下和换潮甲龟哪个好」时**一个关键词都不匹配 ⇒ 被判成陪练**，于是政策要求的行动比较被整段跳过。`route` 的这份正则就是这么被补出来的。 |
| **追问继承上一轮角色** | `src/coach/runtime.js:147` | `followup && ['teacher','strategist'].includes(memory.lastTopic)` ⇒ 沿用上一轮角色（陪练不继承）。 |
| **分派** | `src/coach/runtime.js:148` | `packet = route==='strategist' ? strategist({...context, query:message}) : route==='teacher' ? teacher(context) : companion(context, next, message, Date.now(), {...})` |
| **先于角色的"锁定"分支** | `src/coach/runtime.js:106,119-142` | 线上竞技闭麦（`:106`）、阵容引导（`:119`）、条件委托/提醒（`:123-125`）、种子解释（`:127`）、规则卡（`:128`）、小测状态机（`:129-139`）、整局复盘（`:140-141`）。**这些分支命中时 `locked=true`，不进模型。** |
| **模型参与的门槛** | `src/coach/runtime.js:178` | `useModel && provider.plan && (['strategist','teacher'].includes(route) \|\| policyFor(message,context).need)`。**注意：陪练也能进这一支**——只要政策判定"需要取证"。`runtime.js:176-177` 记着这里原来写死 `['strategist','teacher']`，于是「守一下和换潮甲龟哪个好」被判陪练后 `agentStop` 记成 `policy-route-without-tools`：**政策说要查，实际一次都没查。** |

### 2.2 军师（Strategist）

| 维度 | 本仓落点 | 现状 |
|---|---|---|
| **模块与入口** | `src/coach/strategist.js:7` `export function strategist(context)` | 已实现。**纯代码算**：合法行动枚举 + 对手留场/换宠/防御/治疗分支比较，模型只负责把它讲成人话。 |
| **职责分支** | `src/coach/strategist.js`：`:10` 补位（`phase==='replace'`）、`:28` 起行动比较 | 已实现 |
| **闭麦规则** | `src/coach/strategist.js:9` + `src/coach/policy.js:15` `const RANKED_MODES=['pvp-live']` | **只有线上竞技 `pvp-live` 闭麦**；本地对战 `pvp-local` **一律允许**教练（`policy.js:1-14` 的注释解释了这个反转过：早先把本地对战也静音是**过度收紧**，正好把题面要的"对战场景军师"关掉了）。 |
| **知识检索（军师侧的 RAG）** | `src/coach/strategist.js:66` `export function searchKnowledge(query, {rulesVersion, limit=3, budget=2400, strategy='lexical', game=null})`；卡片 `src/coach/strategist.js:5` `cards=[...TACTIC_CARDS,...REFERENCE_CARDS]`（来源 `src/game/content.js:28`，**49 + 44 = 93 张**） | 已实现，**词法**。**注意**：这是一套检索；仓里另有 `src/coach/rag-index.js`（1694 篇语料、`recall@1=1.0`）**没接进产品**——见 `AGENT-TECH-SURVEY.md` §2.1 缺口 1。 |
| **工具面（军师能查什么）** | `src/coach/toolbox.js:146` `search_rules` / `:157` `query_rules` / `:546` `ROCO_TOOL_NAMES`（`query_rules / evaluate_team / compare_team_change / plan_actions / summarize_battle`）/ `:440` 分派 / `:643` `rocoReceipt` | 已实现 |
| **硬政策（该不该调工具）** | `src/coach/runtime.js:257` `policyFor(message, context)` | 已实现。**"该不该调"从模型手里拿走了**：`runtime.js:255-256` 原话——模型"选哪个工具"90–100%，"该不该调"只有 50%。 |
| **判据** | `tests/strategist.test.js:1`（局内主动提示触发边界，"每个用例都要同时回答什么时候该说、以及不该说的时候真的不说"）、`tests/pvp.test.js`、`tests/roco-standard-pvp-battle.test.js`、`tests/roco-swap-compare.test.js` | 已实现 |
| **阵容（题面"阵容搭配"）** | `src/coach/team-serving.mjs:60` `serveStages`（预算 `SERVING_BUDGETS = {first_answer_ms:300, full_answer_ms:3000}`，`:29`）、`src/coach/team-gaps.js`、`src/coach/team-ranker.mjs`、`src/coach/team-candidates.mjs`、`src/coach/team-compare.mjs`、UI 在 `src/client/team-workshop.js:1`（六槽阵容工作台） | 已实现 |

### 2.3 陪练（Companion）

| 维度 | 本仓落点 | 现状 |
|---|---|---|
| **模块与入口** | `src/coach/companion.js:520` `export function companionState(memory={}, context={}, session={}, now=Date.now())`；被 `src/coach/runtime.js:148` 调用 | 已实现 |
| **跨局账本** | `src/coach/companion.js:332` `companionLedger(memory, game, now)` | 已实现。读 `memory.events` / `journal`。 |
| **"说什么"的取数** | `src/coach/companion.js:466` `companionFacts(memory, context, now)`；来源标注在 `:483` | **每一项都标来源**：`source: last ? 'memory.events' : summary ? 'context.lastMatch' : null`；**读不到就是 `null`，不补默认值**（纪律原文在 `companion.js:330-331`）。 |
| **档位与情绪** | `src/coach/companion.js:227` `REGISTERS` / `:254` `REGISTER_ORDER=['R0','R1','R2','R3','R4']` / `:270` `EMOTION_WORDS_LIST` / `:299` `isGreetingTurn` / `:547` `decideRegister` | 已实现。**"有情绪"是有的，但要求情绪有落点**（grounded affect，见 `companion.js:20` 起的第二次修正说明）。 |
| **只读不写记忆** | `src/coach/companion.js:182-186` | **刻意收窄**：陪练**只读** `stated` 层（玩家自己说过的偏好），写入点唯一在 `src/coach/runtime.js:73` 的 `rememberPreference`。 |
| **不越界** | `companion.js:16-18` 的纪律清单：不评价玩家水平、不给战术指令、不说教、不空泛安慰（`skill-insult / preach / tactical-overreach / empty-encouragement` 四条硬线） | 已实现，有事后扫描（`checkCompanionRestraint` / `checkCompanionInformation`）。 |
| **判据** | `tests/companion.test.js`、`tests/evals/companion-contract.test.js`、`tests/evals/companion-nonintrusion.test.js` | 已实现 |

### 2.4 老师（Teacher）

| 维度 | 本仓落点 | 现状 |
|---|---|---|
| **模块与入口** | `src/coach/teacher.js:5` `export function teacher(context)` | 已实现 |
| **课程与小测** | `src/coach/teacher.js:24` `makeQuiz`（状态机由代码控制，`QUIZ_OFFSETS` 在 `:23`）、`:36` `decisionLesson`、`:49` `skillLesson` | 已实现。**小测不能被模型改写或提前泄题**（`src/coach/runtime.js:129-139` 是锁定分支，`locked=true` 不进模型）。 |
| **复盘（题面"复盘、讲解"）** | `src/coach/teacher.js:139` `analyzeTurn`、`:172` `reviewMatch`、`:294` `compareTurnAlternatives`；深度复盘模块 `src/coach/teacher-review.js:615` `reviewMatch({events, turns, result, game, memory, skills, bag})`、`:164` `teacherMatchFacts`、`:64` `TEACHER_TURNING_POINT_RULES` | 已实现 |
| **"帮玩家进步"的可回查账** | `src/coach/teacher-review.js:725` `checkLearningProgress`、`:806` `recordTeacherReview`、`:850` `recordLearningCheck`；`teacher-review.js:842-845` 明确写"不出现第二套『学会没有』的账" | 已实现 |
| **反事实纪律** | `src/coach/teacher.js:31` `review`（"未把事后结果当作决策正确性的唯一依据"）、`src/coach/teacher.js:113` `turnDecision`、`:197` `keyDecisionOf` | 已实现。对应难点见 `docs/DIFFICULTY-AND-SOLUTIONS.md` 难点 7。 |
| **教学记忆的落点** | `src/coach/memory.js:125` `markTaught` / `:134` `markUnlearned` / `:109` `teachingPlan` / `:108` `RELEARN` | 已实现。`:139` 的 `basis` 原话明确写"只统计没被提示的独立行动，**不等于真正掌握**"。 |
| **判据** | `tests/evals/teacher-review.test.js`、`tests/evals/agent.test.js`、`tests/coach.test.js` | 已实现 |

### 2.5 三角色共用的地基（题面没点名，但支撑"准确且可解释"）

| 地基 | 位置 |
|---|---|
| **事实守卫（数字/引用/因果/命名）** | `src/coach/runtime.js:1186-1241` `checkGroundedAnswer`；`scope` 自述在 `:1241`（"`Narrow numeric/citation/certainty guard; not a proof of all natural language correctness`"） |
| **回执一致性** | `src/coach/runtime.js:1109` `checkReceiptConsistency` |
| **fail closed（降级到引擎结论 + 说出来）** | `src/coach/runtime.js:207-221`；玩家话术 `src/coach/activity.js:29-33` `FALLBACK_WORDS` |
| **上下文装配与预算** | `src/coach/runtime.js`：`:1081-1100`（`assembleContext`）、`:1075-1082`（预算常量）、`:1243-1248` `fitModelMessages` |
| **玩家可见面（"降级要说出来"）** | `src/coach/activity.js:1-17` 三条纪律、`:21` `TOOL_WORDS`、`:81` `coachActivity`、`:122` `activityLine` |
| **记忆存档** | 形状 `src/coach/memory.js:2` `freshMemory` / `:8` `readMemory`；存储键 `xiaoya-memory-v1`（`src/client/app.js:35,37`、`src/coach/client.js:71-72`） |

---

## 3. 交付形态（**一句话，不当工作流**）

面试要 Word/PDF + Demo ⇒ **Demo 在 `npm start` 起的 `http://127.0.0.1:8765/`（`README.md:26`），可提交 PDF 在 `output/pdf/xiaoya-coach-report.pdf`（`docs/README.md:19`），"难点及方案"在 `docs/DIFFICULTY-AND-SOLUTIONS.md`，判据与真产物在 `reports/roco/` 与 `tests/`。**
**v0.1 已交付，PDF/交卷物暂不用管** —— 这里只作为"缘起与验收视角的参照"记一笔，**不列待办、不排期**。
（⚠️ **8765 是正在被人类看着的实例，不要碰。**）

---

## 4. 人类最新两句原话（**逐字**）

> 「闪耀大赛就是6v6 4魔力v4魔力的pvp啊，不是随机6只啊，自己配队，你后面要多查点来源，可以看看小黑盒啥的这种游戏社区嘛，抖音 b站 小红书也都有啊；对要做agentic rl」

> 「里面这个agent相关的都要充分调研，尽可能都做一下ok？现在就rag和memory太少了，不够agent」

### 4.1 这两句话已落成的裁决与要求（**指到落点，不在这里重复**）

| 这句原话里的要求 | 已落到哪 |
|---|---|
| 「闪耀大赛就是 6v6 4 魔力 vs 4 魔力」「不是随机 6 只」「自己配队」 | **人类裁决**，已追加到 `docs/roadmap/HUMAN-RULINGS-2026-09-25.md` §2.3 末尾；**冲突裁决**已加到 `docs/roadmap/AGENT-TECH-INSTALL-TABLE.md` §1.1d（并保留了子代理原来的九游冲突记录，标注为"应属另一模式或不可靠"，**原文不删**）。 |
| 「你后面要多查点来源，可以看看小黑盒啥的…抖音 b站 小红书也都有啊」 | **多来源交叉核对要求**，已加到 `AGENT-TECH-INSTALL-TABLE.md` §1.1d；本轮实际新查到的闪耀大赛来源与可信度评估见该节表格。 |
| 「对要做 agentic rl」＋「agent 相关的都要充分调研，尽可能都做一下」「现在就 rag 和 memory 太少了，不够 agent」 | 五项技术的逐条深挖 + 「尽可能都做」的执行计划，见 `docs/roadmap/AGENT-TECH-SURVEY.md` 新增章。**"不加训"的前一版口径早已被人类推翻**（`AGENT-TECH-INSTALL-TABLE.md` §1.1c 留痕不删）。 |

### 4.2 与前一版口径的关系（**留痕不删**）

- 「**不加训**」**已被人类推翻**（`docs/roadmap/AGENT-TECH-INSTALL-TABLE.md` §1.1c，原话「**不加训就是扯淡，agent coach，不用模型用啥，不是扯淡吗，开倒车**？」）；本节第 4 节那句「**对要做 agentic rl**」是同方向的**再一次确认**。
- `AGENT-TECH-SURVEY.md` §4 第 3 条曾把「**不加训**（全仓无训练步骤）」**当成现约束**——那一行**已经过期**，下一任 agent 不要照它做事（该文 §4 已就地加更正标注）。

---

## 5. 我没能确认的东西（**别当事实用**）

1. **面试题原文的"逐字"来源**：本节的题面文本是**人类在对话里给出的**（本文件照抄）。仓内**没有**面试题的原始文件（我 grep 了 `docs/` 与根目录，**未找到**任何题目附件/截图）。
2. **"3 天"截止的具体日期**：题面只写"3 天"，**没有起算日**。`docs/RELEASE-v0.1.md` 与 `README.md` 都记了 v0.1 交付这件事，但**没有一处写"面试截止日 = 某年某月某日"** ⇒ **我不推算**。
3. **v0.1 实际提交的形态**：`README.md:13-14` 写的是"去 Releases 下载 `v0.1.0` 的源码包"，而 `output/pdf/xiaoya-coach-report.pdf` 也确实存在（1,193,729 字节、mtime 2026-09-18）——**但仓内没有一处说"v0.1 提交给面试方的是哪一个"**（源码包？PDF？两者？）。⇒ **我不判定**。另外，`docs/DOCS-AUDIT-FIXES.md:174,191` 记的 PDF 字节数是 **396,798**，与现在实测的 **1,193,729** 不一致——那是**该文档写作时的历史值**（它自己标了 mtime 22:32），**不是当前值**；引用 PDF 规模请以 `ls -la output/pdf/` 的实测为准。
4. **题面里"至少完整闭环其中一项"的验收口径**：本仓三项都做了实现，但**没有任何一份文档给出"闭环"的判定标准**（"未找到"）。§1.1 第 1 行那句"三项都做了实现"是**我的对照结论**，依据是 §2 的 `文件:行号`，**不是**某份既有文档的结论。
