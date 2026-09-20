# 设计与实现中的难点及方案

> 交付对象：面试题「基于 LLM 的智能 AI Coach（陪练教练）」提交要求 1 —— 阐述设计和实现过程中遇到的难点及方案。
>
> 代码基线：UI v0.10（写作时）/ 当前 v0.11，游戏规则 v0.6，14 只宠物（写作时为 12；本轮新增磐耳羊/灵瞳猫两只普通系），可运行本机 Demo（`npm start`，http://127.0.0.1:8765/ ）。
> 自动测试：写作时 **122 项全部通过**；此后 **127 → 251 → 257 项**。写这份修复报告时现场 `npm test` 为 **tests 257 / pass 257 / fail 0**（核对过程中曾因并发的"新增两只普通系"改动短暂出现过 255/2，最终已全绿）。**本文正文里出现的 122/127 一律是当时值，不要当现状读。**

> **v0.11 变更提示（重要）**：本文写作于 commit `849e131`。此后 `121411d` 起，教练策略已反转——**只有线上竞技 `pvp-live` 闭麦，本地对战 `pvp-local` 一律允许教练**（`src/coach/policy.js` 的 `RANKED_MODES=['pvp-live']`）。本文中凡称「`pvp-local` 也被拒」「本地与正式 PVP 同一策略」「对局中陪练被压到 R0」的段落均已过时，请以 `docs/CHECKLIST.md` 的 X02/X03 为准。

>
> **文档基线：commit `849e131`（2026-09-17 14:25）。**本文所有行号与该提交一致。⚠️ **`docs/CHECKLIST.md` 的行号引用请不要再按行号找**：该文件此后被大量追加，本文里所有 `docs/CHECKLIST.md:NNN` 现在都指向别的行，**请按条目编号（A05 / C05 / G07 / S04 …）检索**。同理，本文写的 `reports/test-output.txt` 是"更早一次运行的产物（13:52，记录 114 项），尚未随本次提交重新生成"——**该文件后来已被重写为 251/251/0（mtime 22:04，随 `50ec5fe` 入库）**，这条不一致已经消失，但"报告与代码会各自漂移"这个论点仍成立（见下文难点 12）。
>
> 本文的写作约定：
>
> - 每个难点按 **难点 / 为什么难 / 方案 / 验证 / 边界** 五段展开。
> - 所有数字都来自本仓库中实际存在并已阅读的文件，路径随文给出。
> - **验证**一栏只写可复查的自动测试名或已保存的报告文件；没有做到的验收直接标注为未完成，不写成已完成。
> - **边界**一栏刻意写得严格：说明这条方案**不能**证明什么。项目自身声明为「未完成」的事项（真人学习迁移、独立大样本质量评测、完整组合平衡等）在本文中一律不勾销。
> - 凡无法从仓库内文件核实的，写「**未能核实**」，不做推测性补全。

---

## 目录

| 编号 | 难点 | 类别 |
|---|---|---|
| 1 | 玩家不打开聊天就感受不到价值 | 入口与注意力 |
| 2 | 建议必须准确且可解释：数值与合法性不能交给模型 | 正确性归属 |
| 3 | 模型晚到与过期建议：不能把旧答案换个名字继续播 | 异步与时序 |
| 4 | 小测必须由程序控制状态机，不能被模型改写或提前泄题 | 教学闭环 |
| 5 | 静默、降频与 PVP 限制必须发生在调用模型之前 | 门控位置 |
| 6 | 只给最后一回合，玩家问整局时模型只能胡乱接 | 证据范围 |
| 7 | 复盘无法区分「当时合理」与「事后正确」 | 反事实纪律 |
| 8 | 检索实验：概念扩展与语义检索都没跑赢关键词基线 | RAG 工程 |
| 9 | Agentic RL 的边界：表格 Q-learning 与 1152 参数输出行 | 训练 |
| 10 | 奖励投机：把玩家本来会做对的事算作 AI 的功劳 | 训练 |
| 11 | 上下文预算：UTF-8 字节估计换成官方 tokenizer 的实测差异 | 上下文工程 |
| 12 | 服务端陈旧运行态导致「改了好像没生效」 | 交付工程 |
| 13 | 模型输出校验拦不住名称漂移 | 输出校验 |

第 2、4、8、9 项对应面试题点名的「准确且可解释」「帮玩家进步」「RAG 工程 / Agentic RL」；第 3、12 项是三天窗口里最容易被低估、也最容易在演示现场翻车的部分。

---

## 0. 一句话背景

游戏是回合制 PVE 宠物对战：玩家带 3 只伙伴，每回合在「技能 / 换宠 / 道具 / 防御 / 撤退」中选一个行动，双方同时决定。小芽（AI Coach）有三种角色感：

- **军师**（`src/coach/strategist.js`）——实时局面下的行动比较与解释；
- **老师**（`src/coach/teacher.js`）——整局复盘、培养建议、参数化练习；
- **陪练**（`src/coach/companion.js`）——被动通道有状态模型（momentum / consideration / engagement）、语气档位 R0–R3、真实事件模板与克制扫描；主动通道（`src/coach/session.js`）有门控与档位但 UI 未接线。设计与实现说明见 `docs/COMPANION-DESIGN.md` 与 `docs/COMPANION-IMPLEMENTATION.md`。

三条链路共用一个原则（`docs/COACH-PLAN.md:11`）：**「就算玩家从不打开聊天，小芽也应有用。」** 下面 13 个难点基本都是这句话逼出来的。

---

## 难点 1：玩家不打开聊天就感受不到价值

### 难点

第一轮试玩暴露的原话是（`docs/INTERVIEW-GUIDE.md:5`）：

> 「即使模型会聊天，玩家不打开聊天就感受不到价值。」

更早一轮的用户反馈更具体（`docs/codex聊天记录.txt:167`）：

> 「另外我停留很久了还没提示嘛？我鼠标来回悬停也不管？」

也就是说：模型答得再顺，只要价值必须由玩家主动「点开一个面板」才能取到，这个功能在真实游玩里就等于不存在。参考产品也印证了同一件事（`docs/LINGBAO-RESEARCH.md:19`）：灵宝最值得学的不是聊天面板做得像角色，而是**玩家仍在玩游戏时就得到帮助**。

### 为什么难

「把聊天框做得更好看/更聪明」是显然的修法，但它改的是**已经打开面板的那部分玩家的体验**，对没打开面板的玩家一点帮助都没有。真正的难点不是文案，而是三件事同时成立：

1. 提示必须出现在**玩家仍在操作**的界面位置上（不推开技能区、不抢焦点、不改变页面高度）；
2. 提示必须在**没有任何玩家输入**的情况下被触发（否则又回到「玩家主动」）；
3. 提示必须**自带信息**，不能只是一句「有事问我」（否则等于一个更烦人的铃铛）。

第 3 条尤其反直觉：如果一个提示的内容是「需要帮助吗」，那它并没有传递价值，只是把打开面板的成本转嫁成了点击成本。

### 方案

把主入口从「聊天框」改成「事件触发的小提示」，并把复杂解释降级为**按需展开的二级入口**：

- **事件源**（`src/coach/experience.js`）：`observe()` 在每次局面变化时产生候选提示，触发原因是补位、属性劣势、能量不足、开场对位、回合结束重估之一；`decisiveOpportunity()` 在双方残血且存在合法攻击可收尾时给出条件化提示；`watchCandidate()` 处理玩家自己委托的条件。
- **原位呈现**（`src/client/app.js` 的 `updateCoach`）：提示写进局内固定位置的短字幕 `#live-coach`，附带一个「看看原因」按钮展开计算依据。展开是**可选**的，收起状态已经包含可用事实，例如「可考虑：换上潮甲龟」。
- **培养页同样原位**（v0.6 起）：宠物名称下面直接显示一句建议，展开才是加点前后比较表。
- **删除反向入口**：v0.9 移除了「小芽场景」这个可见入口（`docs/CHECKLIST.md:236`），不让玩家觉得必须先进入某个「AI 模式」。
- **模型不是前置条件**：提示的事实部分由本地规则先算出来，模型连上时再把字幕替换成模型措辞（`src/client/app.js`：先渲染本地 `hint`，异步请求返回后再 `$('live-copy').textContent = ...`）。未连接、失败或超长时显示本地版本并如实标注来源。

### 验证

- 自动测试 `tests/coach.test.js:99`「whole-match UI request can review archived evidence without network or model credentials」：不联网、不配置模型也能走完整局复盘。
- 自动测试 `tests/evals/agent.test.js:124`「analysis after a match invokes model with whole-match evidence rather than canned companion reply」：结束后进入的是整局分析，而不是陪练的通用话术。
- 真实浏览器链路（`docs/reviews/2026-09-17-live-acceptance.md`）：普通进入冠军高地、8 回合失利，「结算无需开聊天，自动出现整局 8 回合总结，来源显示 DeepSeek，证据可展开」。
- 真实模型五条调用中的 `faint-colloquial`、`auto-result` 两条均为自动触发链路，原始结果 `reports/live-model-v10.json`。

### 边界

- 「长局浏览器真实触发」**当时**仍未完成：本文写作时 `docs/CHECKLIST.md` 中 **C17 / W09 保持未勾**，`docs/DEMO-ACCEPTANCE.md:13` 明确写「长局残局真实浏览器路径仍单列待验，不用构造测试冒充自然长局覆盖」。**2026-09-17 晚复核：`C17` 已勾选**（C17 条目下注明了 8 局长局浏览器实测与 26 张截图）；**`W09` 仍未勾**（浏览器里叠加慢响应与语音取消仍缺）。
- 上述浏览器验收是**单人、单次、开发定向**的，不是用户研究；不能推断提示对一般玩家的有用性。
- 提示「不改变页面高度」目前只有桌面 1440×900 与窄屏 390×844 的静态验收（`docs/CHECKLIST.md:274`），更小窗口与放大字号**未能核实**。

---

## 难点 2：建议必须准确且可解释 —— 数值与合法性不能交给模型

### 难点

这是整个项目最重要的一条分工。玩家的原始质疑是（`docs/codex聊天记录.txt:24`）：

> 「火花和追猎都能击倒残血目标时，小芽不能因为追猎数字更大，就说玩家选火花不对。」

更早的一轮真实对话里，模型对「种子」这个自家界面元素直接编了用途（`docs/IMPLEMENTATION-STATUS.md:87`：首页「种子」改名为随机编号，「禁止模型猜成培养资源」）。

问题的形状是：**LLM 在「说什么」上很强，在「算多少」上不可靠，而玩家恰恰是从数字上判断教练值不值得信。**

### 为什么难

「让模型更小心一点」「在 prompt 里写清楚不要编数字」都不成立，原因是：

1. 数值错误是**不可局部修补**的。一句「造成 38 伤害」错了，后面所有基于它的取舍解释全错，而语气、结构、甚至引用都是对的，肉眼很难发现。
2. 合法性是**组合问题**。一次行动是否合法取决于能量、是否连续防御、是否满血用治疗、是否存在环境可清、存活伙伴列表等（`src/game/engine.js:83` `legalActions`），让模型在自然语言里复算这套条件，等价于让它重写一遍规则引擎。
3. 「哪一招更好」根本不是模型能凭常识回答的。同一目标 50 HP，一级狐的火花直接伤害 52、追猎 75，都耗 2 能量，两者都满足未防御未治疗的击倒条件（`docs/RAG-LOCALIZATION.md:34`）。**只有进一步比较对手分支才可能说明某招更稳**，不能因为 75 > 52 就提醒玩家「打错了」。

### 方案

**把「算」和「说」切成两层，模型永远拿不到算的权力：**

- **枚举层（引擎）**：`src/game/engine.js` 的 `legalActions()` 产出当前全部合法行动；`damage()` 是按属性倍率、增益层数、防御减伤、穿透、环境倍率、携带物一次性效果结算的纯函数；`rankEnemyActions()` 对我方全部合法应手加权枚举，返回每个对手行动的 `score`、`expected`（平均分）、`worst`（最坏分）与 `switchScore`（对方换宠分支最坏分）。评分口径在代码注释与界面文案中都写明「启发式评分，非胜率」。
- **证据组装层**：`src/coach/strategist.js` 的 `strategist()` 把枚举结果整理成结构性证据：双方面板、直接伤害（含防御分支）、平均/最坏分、检索到的知识卡及其反例与适用条件。返回结构里带 `method: '合法行动枚举 → 共用结算器 → 平均收益与最坏情况比较'`。
- **模型层**：模型只负责目标理解、工具选择、取舍解释与教学措辞。给它的是证据包，不是原始局面让它自己推。`src/coach/client.js:2` 的生成约束里明确「不要向玩家报内部局面评分，用可见的宠物、技能和状态解释」。
- **可解释性做成产品结构**：每条证据都是可展开的条目（例如「若对手不换宠、不防御，余烬追猎对当前目标计算伤害为 75；实际结算受对手行动影响」），而不是把内部评分倒给玩家。

### 验证

- `tests/coach.test.js:8`「strategist gives a legal action grounded in current state」：断言军师给出的首选行动确实属于 `legalActions(g)`。
- `tests/features.test.js:14`「AI decision is pure and independent of any submitted action」：对手决策不看玩家待执行动作。
- `tests/knowledge.test.js:19`「lower damage is not automatically a mistake when both moves can KO」：直接把上面那个「52 / 75」的反例固化成测试。
- `tests/knowledge.test.js:28`「live calculations exclude unaffordable attacks and restrict PVP/version mismatch」：能量不够的技能不进计算。
- `tests/engine.test.js:13`「100 varied complete games preserve invariants and terminate」：100 局随机完整对局，断言生命与能量始终在合法区间。
- `reports/live-model-v10.json` 中 `weather-tools` 一条：模型先调 `search_rules` 再调 `read_state`，说明它拿的是工具回执而不是自行心算。

### 边界

- 枚举是**一回合**的。`compareTurnAlternatives` 只用回合前公开状态枚举一回合，`docs/CHECKLIST.md` 的 T01 括注「不等于多步最优策略」；没有做多回合搜索，也没有求解纳什均衡。
- 评分是**启发式**，未经校准，不能当胜率。`docs/EXPERIMENTS.md:60` 的 660 场单宠对照只用于发现极端项，「不代表 3v3 平衡」。
- 「模型不会算」不等于「模型不会在解释里加入未经枚举的因果」。`docs/CHECKLIST.md` 的 A05 曾注明「数字/引用校验仍漏名称或因果语义错误」（**2026-09-17 晚复核：A05 已勾选**，名称漂移与因果语义两块都补上了）。

---

## 难点 3：模型晚到与过期建议 —— 不能把旧答案换个名字继续播

### 难点

游戏是回合制的，玩家出招之后局面就变了；但模型一次调用实测 3.1–3.7 秒（`reports/live-model-v10.json` 五条真实调用为 3134 / 3340 / 3410 / 3183 / 3722 ms）。这必然产生一整类失败：**旧局面的建议在新局面下被显示出来。**

项目把这条写成了硬要求（`docs/COACH-PLAN.md:75`）：

> 「即使远端请求无法终止，也阻止过期结果展示……复盘作为独立任务重新读取事实，不能把过期建议改名复盘直接播出。」

真实发生过的三个具体形态（`docs/reviews/2026-09-17-live-acceptance.md`）：

1. 「自动复盘指令中的『单回合评分』错误触发上一回合路由」——一句话里的关键词把整局请求变成了单回合；
2. 「浏览器追问把第 5 回合被取消的撞击说成 22 伤害」——行动取消被当成打出了伤害；
3. 「自动总结只改 DOM 未改对话记录」——页面上更新了，会话历史里还是旧的。

### 为什么难

- **只做超时处理不够。**老请求可能「没有失败」地返回——HTTP 200、格式合法、内容正确，只是描述的是**上一个局面**。把这类结果当成功渲染，比报错更糟，因为看起来一切正常。
- **取消不能只做在客户端。**上游请求已经发出去了，钱和时间都已经花了；但**展示**必须被拦住。所以「取消」实际上要分两级：能中止的中止，不能中止的丢弃。
- **语音是第二条泄漏路径。**文字被拦住了，语音队列里那条旧句子仍可能播出来，而语音比文字更打断人。
- **同一个「过期」概念要同时覆盖好几个维度**：行动已提交、对局已切换、规则版本不同、提示已被玩家关掉、超过有效时间。

### 方案

四个互相独立的机制，缺一不可：

1. **局面纪元（epoch）**——`src/coach/scheduler.js` 的 `CoachScheduler` 维护一个自增 `epoch`，所有任务键都拼成 `epoch + ':' + key`。`invalidate()` 时递增 epoch、`abort()` 正在跑的那个、清空排队表和缓存。任务真正开始前和真正返回后各检查一次 epoch，不一致就抛 `AbortError('局面已改变')` / `('建议已过期')`。同一个 epoch 内的相同请求会**合并**（复用同一个 Promise），并可选带 TTL 缓存（默认 10 秒、最多 12 条），避免同一局面重复烧钱。
2. **任务戳（taskStamp / taskIsCurrent）**——`src/coach/experience.js:99`：任务记录 `epoch / matchId / rulesVersion / createdAt / validUntil`，展示前用 `taskIsCurrent()` 四重比较（纪元、对局、规则版本、是否过期），任一不符即丢弃。
3. **展示前的版本校验**——网页端每次更新提示都自增 `hintEpoch`，异步回调里先比 `hintEpoch!==token` 再写 DOM（`src/client/app.js` 的 `updateCoach`）。玩家出招、关闭提示、切换模式、页面隐藏都会自增 `hintEpoch` 并调用 `cancelVoice()`。
4. **服务端断连取消**——`src/server/index.js` 在监听请求断开后中止上游 `fetch`（`AbortSignal.any` 合并客户端断开与 35 秒超时）。

### 验证

- `tests/evals/agent.test.js:93`「slow results cannot cross an action, match, rules version or expiry boundary」：断言纪元变化、对局不同、规则版本不同、超期四种情况全部返回 `false`，只有四者都匹配才返回 `true`。
- `tests/evals/agent.test.js:184`「state invalidation aborts active work and discards queued old requests」：`invalidate()` 之后，正在跑的与还在排队的请求全部 rejected，且上游只被调用 1 次（排队的那个根本没发出去）。
- `tests/evals/agent.test.js:193`「same-state requests merge, cache clones, and epoch clears cache」：同局面合并、缓存返回克隆体（改一个不影响另一个）、epoch 变化清缓存。
- `tests/evals/agent.test.js:102`「invalid model numbers and network errors fall back with the original state token」：模型返回「造成 99999 伤害，必胜」时回退本地，且 `stateToken` 保持不变。
- `tests/server.test.js:32`「client disconnect aborts the upstream model request」。

### 边界

- **慢模型的完整浏览器验收未完成。**本文写作时 `docs/CHECKLIST.md` 中 **S05「慢模型演示：快速出招后无旧文字、无旧语音、无重复补发」仍是未勾项**，W09「完整浏览器慢响应、语音取消与长局验收」同样未勾。**2026-09-17 晚复核：`S05` 已勾选**（客户端侧 6 项慢网测试补齐）；**`W09` 仍未勾**。上述验证全部是自动测试 + 定向调用，**不是**真实慢网下的完整演示。
- **成本没有被拦住。**过期请求的「中止」只在客户端断开时生效；上游已经开始生成的那部分 token 仍然计费。`docs/CHECKLIST.md:267` 写明「真实完整调用成本仍待聚合」。
- **语音侧更强的主张未验证。**`docs/CHECKLIST.md:239` V08：用户设备扬声器实际可听性、长局语音打扰程度仍需真人验证，「不以 onstart 冒充听觉验收」。

---

## 难点 4：小测必须由程序控制状态机，不能被模型改写或提前泄题

### 难点

真实用户截图里的这一段（`docs/codex聊天记录.txt:148-151`）：

> 玩家：「出一道小测验」
> 小芽：「结论：还是后出手。……等一下——我上面说反了，重新给你标准答案……」

同一轮里，玩家只回了一个「？」，小芽却把它当成了新问题（`docs/codex聊天记录.txt:155`）。事后定位到的根因写得很直接（`docs/codex聊天记录.txt:192`）：

> 「刚确认到一个根因：小测验也被送给模型自由改写了，系统没有真正控制『出题—等作答—判题』的状态；这部分需要由程序兜住，不能只靠一句提示词要求模型别泄题。」

### 为什么难

- 「在 prompt 里写明不要提前给答案」是**概率约束**，不是状态约束。模型完全可以在同一段输出里先说答案再道歉——上文那次失败正是这个形状：**它自己发现说反了并当场改口，看上去很礼貌，实际上已经把答案说出去了。**
- 小测是一个**有状态的交互**：出题 → 等待作答 → 判题 → 结束。状态必须跨刷新存活（`docs/CHECKLIST.md:153` B02：「刷新保留待答题」），而 LLM 调用是无状态的。
- 「？」这类输入**依赖状态才有意义**：待答状态下它是「我没懂这道题」，非待答状态下它是「接着上一句问」。同一串字符，路由不同。

### 方案

把出题、判题、取消全部收进程序，模型拿不到这条链路的改写权：

- **题目由引擎参数化生成**（`src/coach/teacher.js` 的 `makeQuiz`）：取当前焦点宠的速度，按 `variant % 3` 取偏移量 `[2,4,3]`，题目问「培养一次敏捷（+3）后是先出手、后出手还是无法确定」。正确答案由偏移量算出：`<3 → 先`、`>3 → 后`、`=3 → 不确定`（同速由随机过程决定）。解析里带实际算式 `speed + 3 = ...`。三种变式（更快 / 更慢 / 平速）由 `quizCount` 递增轮换。
- **状态机由 `memory.pendingQuiz` 承载**（`src/coach/memory.js`）：`{id, variant, question, answer, explanation, lesson, evidenceIds}` 写入本机记忆，刷新可恢复；`readMemory()` 会对它做结构校验，字段不合法就丢弃。
- **锁定（locked）标志禁止模型介入**：`src/coach/runtime.js:59` 里 `deterministic = locked && !['review','match-review'].includes(next.lastTopic)`，而 `locked=true` 的路径不调用模型生成。小测的出题、判题、取消三条分支全部 `locked=true`。
- **待答期间拦截泄题**：如果 `memory.pendingQuiz` 存在、玩家发的是追问而不是作答，返回的是「刚才这道题还在等你作答，我不该先报答案。」+ **重新贴出题目**，而不是答案（`src/coach/runtime.js:48`）。
- **答对只记「答对过一道练习」**：`next.lessons.push(quiz.lesson)` 只记课程名，不写「已掌握」（`docs/IMPLEMENTATION-STATUS.md:91`）。这一点直接决定了后面掌握的判定必须另走 `journal` 的独立行动证据（见难点 10）。

### 验证

- `tests/coach.test.js:10`「quiz closes the teaching loop and records success」：出题 → 答「先出手」→ 文本匹配「答对」→ `lessons` 长度 1 → `pendingQuiz` 归零。
- `tests/coach.test.js:31`「quiz waits for an answer, survives reload, handles question mark and cancels」：断言「等待作答 / 刷新后仍在 / 问号接续当前题 / 取消」四种行为。
- `tests/evals/agent.test.js:66`「parametric practice includes faster, slower and ties with engine-aligned answers」：三种变式的答案与引擎一致。
- `tests/evals/agent.test.js:70`「watch clarification does not inherit previous review topic」：话题不会被串到别处。

### 边界

- **「答对一次」不等于掌握，这一点项目自己反复声明。**`docs/COACH-PLAN.md:47` 原文：「选择题是辅助，答对一次不等于永久掌握。」`docs/IMPLEMENTATION-STATUS.md:91` 记录了对应修复：「答对只记为答对过一道练习，不再声称已经掌握。」`docs/CHECKLIST.md:283`（M03/T04/R09 一行括注）：真人迁移与自检闭环仍未完成。
- **变式只有三种，且只有速度这一个知识点。**`makeQuiz` 的偏移量写成 `[2,4,3][variant % 3]`，即更快 / 更慢 / 平速三种；其它知识点（灼烧联动、换宠承伤、能量节奏）只有观战后的单选题（`src/coach/experience.js` 的 `lessonFor`），**没有参数化生成**，也**没有**对应的迁移验收。
- 判题是**精确匹配**（正则匹配「先 / 后 / 不确定」），玩家用自然语言描述理由不会被判为作答，而是落到追问分支。这是**设计选择**，但它意味着这条链路对口语输入的鲁棒性**未验证**。

---

## 难点 5：静默、降频与 PVP 限制必须发生在调用模型之前

### 难点

玩家明确说「安静」之后，仍然收到主动提示，或者更隐晦的版本：玩家关了两次提示，系统「记住了」却还在说——这些都不是文案问题，而是**门控位置问题**。

项目把这条列为最值得讲的失败案例之一（`docs/INTERVIEW-GUIDE.md:38`）：

> 「静默偏好不能仅存在 prompt 里，门控必须先于模型和语音执行。」

同一形状的问题在公平性上更严重（`docs/COACH-PLAN.md:119`）：

> 「限制放在模型调用前与服务端能力层，不只隐藏按钮。」

### 为什么难

- **prompt 里的「请安静」是软约束。**模型可以因为「这个问题看起来很重要」而自我授权开口。而静默是玩家给的**硬约束**，`docs/COACH-PLAN.md:37` 写明「关闭主动提醒必须完全遵守，不以『模型认为必要』越权」——两者在性质上不能放在同一层解决。
- **门控条件本身是复合的**：明确档位（安静 / 仅关键风险 / 适度）、单条关闭、每局次数上限、回合间隔、最近关闭历史、是否存在有证据支撑的降频假设、前台/焦点/是否在对战中/是否在预制体验中、是否 PVP。任何一条漏在前端之外，都会出现「这条路径没拦住」。
- **「静默」和「关一条」是两种操作**，不能合并（`docs/COACH-PLAN.md:37`）。把两者当同一个开关，就会出现「关了这条，整局再也不说话」或「关了全部，下一条又冒出来」。
- **隐藏按钮不算限制。**PVP 场景下如果只是前端不显示入口，一个改包的客户端仍然能发请求。

### 方案

**所有门控都放在「产生动作」之前，而不是产生之后再加过滤：**

- **档位判定在最前**（`src/client/app.js` 的 `updateCoach`）：`box.hidden` 的计算里第一项就是 `profile.coach.mode === 'quiet'`，命中即 `return`，后面的候选计算、渲染、模型请求一概不发生。
- **有证据支撑的降频**（`src/coach/memory.js` 的 `adaptiveGate`，第 30–40 行）返回 `{allow, reason}`，四种拒绝理由分别是 `explicit-quiet`、`explicit-critical`、`recent-dismissals`、`independent-success`。其中 `independent-success` 只在**该知识点存在至少 3 条可回查证据、且证据仍全部存在于 journal 中、且判定为可降频**时才生效——证据被删就立刻失效。`adaptiveGate` 被放在渲染之前（`src/client/app.js`：`if(!force && !adaptiveGate(...).allow){box.hidden=true; return;}`）。
- **次数与间隔上限在用模型之前判断**：`autoCalls >= (mode==='mentor' ? 6 : 3)` 与 `hint.reason === lastAutoReason` 两个条件都在 `connectionStatus().then(...)` **之前** `return`，也就是说被拦下的提示**根本不发请求**。
- **语音共用同一取消条件**：`speakCue()` 第一行就检查 `voiceEnabled / document.hidden / busy / preview / quiet / mode!=='pve'`，并且用 `matchId+':'+turn+':'+text` 去重。
- **PVP 能力限制集中在 policy 层，且在最小函数的第一行拒绝**：判定逻辑收在 `src/coach/policy.js` 的 `isLiveMatch(context)`——它把 `pvp-live`（联网）与 `pvp-local`（同机轮流对战）**视为同一策略**，理由是公平性取决于「对面是不是人」，而不是「有没有开 socket」；并且在对局**已结束**时返回 `false`，让赛后复盘可以正常进行。调用点是四个最小函数的第一行：`runCoach`（`src/coach/runtime.js:31`）、`gatherAgentEvidence`（`src/coach/runtime.js:78`）、`executeTool`（`src/coach/toolbox.js:26`）、`strategist()`（`src/coach/strategist.js:9`）。`buildKnowledgePacket` 在检索之前就返回 `blocked`（`src/coach/strategist.js:84`）。
- **玩家自己的委托不豁免静默**：条件提醒（`watch`）只支持 `energy` / `finish` 两类，绑定当前对局、最多 1 条、10 回合内有效、触发即删除、新开局清除（`docs/EVIDENCE-SCHEMA.md:30`），并且「安静模式优先」。

### 验证

- `tests/coach.test.js:44`「attention is bounded, respects silence and cannot fire in background」。
- `tests/evals/agent.test.js:19`「dismissals persist with source and suppress only routine reminders」：2 次 `dismiss` 后普通提醒被拒（`reason === 'recent-dismissals'`），但带风险标志时仍然放行；空记忆时默认放行。
- `tests/coach.test.js:12`「PVP restriction happens before provider calls」：用一个 `called` 标志断言 provider 的 `generate` **一次都没被调用**。
- `tests/server.test.js:27`「PVP gating occurs before remote invocation even when configured」：已配置密钥的情况下，`count === 0`，即上游一次都没发。
- `tests/features.test.js:19`「PVP live blocks unsolicited and queried tactical help」：主动与被动两条路径都拒绝。
- `tests/evals/agent.test.js:200`「tool contracts reject unknown parameters and return bounded evidence pages」：这一条在 commit `849e131` 中被扩写成**同时断言策略的两半**——`pvp-local` 与 `pvp-live` 两种模式都抛 `policy`，而**对局结束后**同一个 `read_state` 调用必须**不再**被拦（源码注释写明理由：「the refusal message promises 『结束后我们再聊』, so post-match review must not stay blocked」）。
- `tests/pvp.test.js`（8 项，本次提交新增）：其中「a full hot-seat match terminates and keeps both sides independent」跑完整场同机轮流对战；「pve replacement behaviour is unchanged when manualReplace is absent」保证 PVE 路径未被这次改动影响。
- `tests/evals/agent.test.js:60`「watch registration is bounded, cancelled explicitly, and never crosses matches or PVP」。

### 边界

- **这是规则门控，不是学到的用户习惯模型。**`docs/IMPLEMENTATION-STATUS.md:102` 原话：「当前是可测的规则门控，还没有训练用户习惯模型。hover 不表示玩家水平低。」把停留/悬停当弱信号，而不是能力判断。
- **前端门控不是权限边界，`pvp-local` 也一样。**`src/coach/policy.js` 的 `isLiveMatch()` 读的是 `context.mode` 与 `context.battle.mode`，而这两个值来自 `src/coach/session.js:25` 的 `coachContext(game, profile)`，即**客户端自己声明的模式**。`docs/EVIDENCE-SCHEMA.md:33` 写得很直白：当前模式和快照来自客户端，「这只能演示能力限制，不能保证恶意竞技客户端不会修改 mode。生产必须由服务器会话与对局服务决定权限」。**未做**真实权威服务端；同机轮流对战模式把这条边界暴露得更明显（一台机器上两个座位，模式完全由页面决定）。
- **降频假设本身的正确性未验证。**「至少 3 条独立证据 → 降频」是一个可修正假设，`docs/EXPERIMENTS.md` 与 `docs/CHECKLIST.md:283` 都把它归在真人迁移一类，未做真人验证。
- 后台/动画中/聊天中/预制体验中不触发这几条，**只有单元测试覆盖**，没有在多标签页、多显示器或长时间挂机下的完整浏览器验收（W09 未勾）。

---

## 难点 6：只给最后一回合，玩家问整局时模型只能胡乱接

### 难点

原话（`docs/INTERVIEW-GUIDE.md:37`）：

> 「原来只给最后一回合，玩家问整局时模型只能胡乱接。修复的是证据归档和任务范围，不是加一句『请认真复盘』。」

对应的用户反馈链（`docs/IMPLEMENTATION-STATUS.md:26` 与 `docs/CHECKLIST.md:219`）：玩家在 8 回合败局之后点「分析」，得到的是陪练的通用话术，而不是这一局发生了什么；追问「为什么？我不是一直在打伤害吗」时，模型被路由到了上一回合。

### 为什么难

- **归档和上下文是两件事，只修一件不够。**v0.6 之前的记录只保留最后一回合的历史，所以「保存完整对局」是**数据层**修复；但即使记录齐了，如果把整局原文塞进 prompt 又会超预算。所以还要在**装配层**决定给模型什么：总回合数、行动分布、剩余道具、3 个关键回合、以及每个关键回合的原始事件。
- **路由会被字面词劫持。**自动复盘的生成指令里出现「单回合评分」这几个字，就被路由逻辑判成了单回合请求。这说明**路由依据不能只看用户消息的字符串**，还要看请求的显式范围。
- **内部指令不能进入玩家可见历史。**上面那条长指令一度被当成玩家消息存进了会话，刷新后出现在聊天记录里。

### 方案

分三层修，而不是改文案：

1. **归档层**：`src/coach/experience.js` 的 `archiveRound()` 在每次回合结算后保存当前对局完整 history，并把结束的对局压入 `completed`（最多 3 场）。`readArchive()` 做严格结构校验——回合必须有 `before / after / action / events`，双方 pets 都必须是 3 只，history 长度上限 250；任何一条不合法就整条作废，不用残缺数据拼凑。
2. **装配层**：`src/coach/runtime.js` 的 `buildContext()` 按**显式范围**选源——消息里出现「第 N 回合」就按回合取（`requestedTurn`，取不到就明确返回「这份对局记录里没有第 N 回合，不能用其他回合替代」）；否则按「本局 / 上一局」的正则选 current 或 previous。`summarizeMatch()` 产出整局统计（总回合、攻击/防御/道具/换宠/撤退计数、剩余道具、存活数）+ 按「减员与生命损失」排序取前 3 个关键回合。
3. **显式范围字段 + 分页**：整局请求显式带 `scope: 'match'`（`src/coach/teacher.js` 的 `reviewMatch` 返回值），客户端对整局类问句统一加前缀「关于这份整局战报：」并用同一段导出常量 `MATCH_REVIEW_REQUEST`（`src/coach/runtime.js:2`）。`read_match` 工具支持 `offset/limit` 分页（`limit` 限 1..3），`read_evidence` 按回合取原始事件，取不到返回 `{missing:true, reason:'...不能用摘要补造'}`。
4. **内部指令不落历史**：`src/coach/client.js` 记录原始 `originalMessage`，回写会话时把带指令的版本换回原问题；旧历史里的这条内部指令在 `readMemory()` 迁移时被剥掉。

### 验证

- `tests/coach.test.js:61`「whole-match archive persists all turns, separates matches and preserves previews」。
- `tests/coach.test.js:88`「current-match selection and missing requested turn never substitute another match or turn」。
- `tests/coach.test.js:74`「selected review turn returns its evidence rather than the final hit」——点第 2 回合返回第 2 回合的证据，而不是最后一击。
- `tests/evals/agent.test.js:158`「automatic review prompt stays whole-match even when its instructions mention single-turn scores」——直接把上面那个被劫持的失败情形固化成回归。
- `tests/evals/agent.test.js:176`「generation instructions are not saved as the player message」。
- `tests/coach.test.js:105`「withdrawal is recorded separately from attacks in match summaries」。
- 浏览器：`docs/IMPLEMENTATION-STATUS.md:71`（火花→撤退→刷新→整局复盘→详看第 1 回合，2 回合中攻击 1 次/撤退 1 次，第一回合读到 52/18 的条件伤害），以及 `docs/reviews/2026-09-17-live-acceptance.md`（8 回合败局，自动总结，追问后给出第 2/5/8 回合入口）。

### 边界

- **「关键回合」是重要性启发式，不是最优策略。**排序权重是 `(减员+击倒)*100 + 生命损失 + (换宠?15:0)`（`src/coach/teacher.js:34`），`docs/IMPLEMENTATION-STATUS.md:73` 明确「当前关键回合按减员/生命变化排序，不等于多步最优策略」。
- **整局复盘只有 3 个回合被详看，第 4 个之后需要重新指定回合装配**，这依赖原档仍在浏览器 localStorage 中（当前对局 + 最近 3 场结束对局）。更早的对局**无法补造**。
- **真实模型的整局复盘质量未做独立评测**（**该条已过时：`S04` 现已勾选**，三轮共 132 次真实调用）。`docs/reviews/2026-09-17-live-acceptance.md:22` 原话：「此为开发定向回归，不能推断总体准确率；语义检查仍可能漏掉错误因果和不合理建议。」

---

## 难点 7：复盘无法区分「当时合理」与「事后正确」

### 难点

玩家输了一局之后问「我是不是打错了」，这个问题在信息上是有陷阱的：**复盘时我们已经知道对手那回合出的是什么招**，但决策当时玩家并不知道。用事后信息评价事前决策是最容易犯、也最容易被玩家识破的错误。

项目的立场（`docs/COACH-PLAN.md:43`）：

> 「区分当时公开信息下的合理性与实际分支的结果；不以输赢倒推对错。反事实必须注明固定了哪些对手行动、是否只覆盖一回合。」

### 为什么难

- **「另一手会更好」这种话在事后几乎总是对的**，因为可以针对性挑选对手行动。所以要给出反事实，就必须固定假设，而且要把假设写在结果旁边。
- **同一局里「打得对但输了」和「打错了但赢了」都常见。**一旦用胜负当反馈信号，教练就会教出错误的东西。
- **相近的行动应当允许并列合理。**`docs/COACH-PLAN.md:68`：「判断相近的行动允许并列合理；不因排序第一不同就认定玩家错。」
- **对手的换宠是博弈，不是预测。**`docs/codex聊天记录.txt:91` 的用户立场很明确：「别让玩家陷入无限猜心……小芽应比较对方留场、换宠等分支，指出哪种选择风险更可控，而不是说『他肯定会换』。」

### 方案

- **只从回合前快照重建局面**：`compareTurnAlternatives()`（`src/coach/teacher.js:67`）以 `h.before` 克隆出一个新局（`version`、`mode:'pve'`、`seed:0`、`initialSeed:0`、清空 `history/log/frames`），再对**双方合法行动**做枚举，**完全不读 `h.opponent`**。这样即使真实对手那回合做了什么，也不会进入反事实。
- **分差阈值化，不平局化**：每条替代分支给出「平均分 / 最坏分」，并用 `ranked[0].score - actual.score <= 5` 判断是否为「与最高分接近，不能因排序不同就判错」。
- **文案里写死假设**：返回文本固定带「只用回合前公开状态枚举，不把对方实际出招当成预先已知」，`src/coach/teacher.js` 的 `analyzeTurn` 也逐条注明「这是事前条件比较，对方治疗、换宠及先出手都可能改变结果」。
- **公开局面投影**（`docs/EVIDENCE-SCHEMA.md:7`）：真实随机种子被替换为 `0`，不含电脑待执行动作，实时提示上下文里的对局历史**故意为空**，复盘走独立的 `evidence` 字段——从数据层面隔开「实时」与「事后」。
- **回答含义检查**：`checkGroundedAnswer()`（`src/coach/runtime.js:118`）把「先看对手出招再决定」判为 `simultaneous-action-order` 违规；把「第 N 回合还剩 X 血」绑定到**那一回合的 after 快照**，并允许「回合前/出招前/开始时/当时」的显式时点前缀（`after-hp-mismatch`）。

### 验证

- `tests/evals/agent.test.js:85`「review alternatives use the decision snapshot and never the actual future enemy action」——直接断言改掉 `opponent / after` 不影响分析结果。
- `tests/evals/agent.test.js:236`「guard binds remaining HP to after snapshot and rejects observing simultaneous opponent action first」。
- `tests/evals/agent.test.js:77`「corrupt archive fails closed and old rules never receive current-rule counterfactuals」：损坏存档不补造；规则版本不匹配时只展示原始事件、不重新推算伤害。
- `tests/evals/agent.test.js:216`「branch simulation covers both tie orders without mutation or hidden seed dependence」：同速两种出手顺序都模拟，且不修改输入局面。
- `tests/evals/agent.test.js:168`「match grounding rejects damage assigned to an explicitly cancelled turn」。
- `tests/coach.test.js:80`「screenshot endgame flags attack opportunity with guard caveat」：用户截图的残局参数得到潮汐重击 38 伤害、防御时 13，**不会声称必杀**。
- `tests/evals/agent.test.js:52`「unsupported numeric claims and certainty are rejected while grounded comparisons pass」。

### 边界

- **反事实只覆盖一回合。**「改这一手就一定能赢」这种结论**无法**由本系统支持，代码与文案都显式拒绝。多回合搜索（A04）在 `docs/CHECKLIST.md` 中曾未勾（**2026-09-17 晚复核：A04 已勾选**，`rankEnemyActions(g,{goal})` 的目标偏好重加权已落地）。
- **启发式评分不是胜率**，且未经校准。`docs/COACH-PLAN.md:69`：「不把启发式分数当校准后的胜率。」
- **不等于多步最优，也不等于纳什均衡。**挑战电脑连续换宠的 6/12/18 分惯性成本是**待校准的行为策略**，不是游戏规则，也不是均衡求解（`docs/RAG-LOCALIZATION.md:65`）。
- **「玩家没采纳建议」不被当作差评**，这一点是设计立场而不是已验证事实：采纳率本身没有作为学习指标（`docs/INTERVIEW-GUIDE.md:33`）。

---

## 难点 8：检索实验 —— 概念扩展与语义检索都没跑赢关键词基线

### 难点

这是本项目里最值得讲、也最容易讲错的失败案例。用户最初的质疑非常直接（`docs/codex聊天记录.txt:49`）：

> 「你这 RAG 也太小了，很明显对 ai 没啥增幅吧」

而在把知识卡从 11 张扩到 45 张、再加到 90 张、并接上真实的多语言向量模型之后，**测试集上的命中数并没有提高**。

### 为什么难

- **「加了向量就应该更聪明」是行业默认叙事，而本项目的数据不支持它。**`docs/INTERVIEW-GUIDE.md:49` 原话：「语义 RAG 已经运行，但纯语义 9/14 低于词项 11/14；混合仍 11/14，只改善 MRR。不能说『用了向量就更聪明』。」
- **样本极小而且已经用过。**20 条查询里 4 条 dev、16 条 test，其中 14 条正例、2 条负例（`tests/evals/retrieval.json` 实测计数）；`reports/semantic-retrieval.json` 的 `scope` 字段自己写着「Previously used small developer benchmark; not independent human or LLM answer evaluation」。用同一批已经看过的题比较两种方法，任何差异都可能只是噪声。
- **「没有测出增益」和「RAG 无效」是两个命题。**`docs/reviews/2026-09-17-diagnosis-response.md:25`（**原引用写作 `:26`，行号笔误**；该文件自入库以来未被改过）明确拒绝了这个推论：「关键词与概念扩展在 14 条正例中相差 1 条，只说明本测试没观察到提升，不能推成 RAG 无效或永远无法完成。它也不是 BM25 与神经向量检索的直接比较。」
- **还有一个隐藏的工程陷阱：报告里的策略名和代码里的实现不是一回事。**

### 方案

做法是「**保留基线 + 公开失败 + 下一轮另建盲测**」，而不是换掉默认检索：

1. **先建立可审查的词项基线**：`src/coach/strategist.js` 的 `searchKnowledge()` 用中文双字切分 + 少量口语同义词（`奶→治疗`、`蓝量→能量`、`先动→先手 速度` 等）+ 标题权重 3 / 正文权重 1 的加权词项匹配，先做 `game==='pet-coach' && rulesVersion===matches && status==='active'` 的**版本过滤**，再排序，最后按字符预算（默认 2400）装包，无命中返回 `missing:true` 而不是硬塞一张卡。
2. **概念扩展作为可对照的一档**：`expandQuery()` 用 8 组手写的领域词表（轮换/换宠/挡刀/双换…、补血/奶/回满/药水…）做查询扩展，配合 IDF 加权。代码注释写明这是「inspectable domain vocabulary, not a pretrained embedding model」。
3. **真实语义检索**：`scripts/semantic-worker.py` + `src/server/semantic-server.js` 用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`（CPU，384 维），以 RRF（`k=60`，`1/(60+rank)`）与词项结果融合；模型预热失败或请求失败时**退回词项并标注状态** `unavailable-or-warming`。
4. **失败照原样保存**：`reports/retrieval.json`（75 卡那一轮的逐题结果）、`reports/semantic-retrieval.json`（含逐题 ids 与 `semanticStatus`）、以及两份 summary 都留在仓库里，不删不盖。

### 实测数字（均取自 `reports/` 下的原始文件）

**A. 概念扩展 vs 词项基线**（20 条查询，测试集 14 条正例；来源 `reports/retrieval-summary.txt`）

| 方法 | 命中@3（测试正例） | MRR | 负例正确拒绝 |
|---|---|---|---|
| 不检索 | 0/14 | 0 | 2/2 |
| 词项（lexical） | **11/14** | 0.667 | 1/2 |
| 概念扩展 + IDF（报告中名为 hybrid） | **10/14** | 0.667 | 1/2 |

**B. 真实向量检索 vs 词项基线**（同一批查询；来源 `reports/semantic-summary.txt`）

| 方法 | 命中@3（测试正例） | MRR | 负例正确拒绝 |
|---|---|---|---|
| 词项（lexical） | **11/14** | 0.667 | 1/2 |
| 纯语义（MiniLM 余弦，阈值 0.4） | **9/14** | 0.536 | 2/2 |
| RRF 混合 | **11/14** | **0.750** | 1/2 |

结论：**纯语义在命中数上低于基线（9/14 < 11/14）；混合没有提高命中数（仍 11/14），只把 MRR 从 0.667 提到 0.750。** 因此默认检索**保留词项基线**，向量作为可选融合档保留并标注状态。

**一个必须自己指出的仪器问题**：报告里第三档叫 `hybrid`，但按当前 `src/coach/strategist.js` 的实现，`strategy !== 'lexical'` 只会走 `expandQuery()` + IDF 词项加权，文件内**没有任何向量代码**。也就是说，在**当前代码版本下** `reports/retrieval.json` 的 `hybrid` 档实测的是「概念扩展 + IDF 词项」，**不是**向量融合；真正的向量对照在 `reports/semantic-retrieval.json` 里，用的是 `lexical / semantic / fusion` 三个名字。历史运行时的实现**未能核实**（`src/coach/retrieval.js` 现在只是一个转发到 `src/coach/strategist.js` 的兼容入口）。列在这里是因为它本身就是一个真实的复现陷阱：**两个都叫「混合」的东西，实际算法不同。**

### 验证

- `tests/knowledge.test.js:6`「retrieves colloquial tactical questions with relevant cards」。
- `tests/knowledge.test.js:11`「unknown rules, unrelated queries and insufficient budget return no evidence」。
- `tests/knowledge.test.js:14`「foreign mechanics are retrieved as unsupported, not imported as live rules」——外部游戏机制（宝可梦倍率等）被标为不支持，不会被当成实时规则。
- `tests/knowledge.test.js:39`「switch mind games retrieve counterexamples rather than a certain prediction」——检索「读换」时召回的是**反例**，不是确定性预测。
- `tests/evals/agent.test.js:32`「RAG citations fail closed on deleted IDs and wrong rules version; applicability is explicit」：引用不存在的 ID 或错误规则版本时 `valid:false`；适用性返回 `candidate / conditions-not-met / reference-only` 三态，而不是真假。
- `tests/knowledge.test.js:49`「generated browser knowledge stays identical to source」、`tests/knowledge.test.js:54`「generated reference facts stay tied to the engine rather than copied external game rules」：`src/game/content.js` 由 `node scripts/build-knowledge.js` 从 JSON 生成，两份必须一致；参考事实必须来自引擎而不是抄外部资料。
- 复现命令：`node scripts/eval-retrieval.js`、`node scripts/eval-semantic.js`。

### 边界

- **这批 20 条查询不是独立盲测。**`docs/EXPERIMENTS.md:17` 原话：「20 条开发用查询：4 条 dev，16 条 test 含 2 负例；此前已经使用过，不是独立盲测。混合只改善本样本排序，没有提升命中数，更不能据此宣称模型回答质量提高。」
- **这批数字只说明检索排序，不说明回答质量。**`docs/EXPERIMENTS.md` 同处：「真实模型 weather-tools 实际选择 search_rules 后 read_state；这证明接入调用，不证明 RAG 因果增益。」
- **知识卡数量不是增益证据。**`docs/RAG-LOCALIZATION.md:69`：「单纯增加知识数量无法证明增益，需要盲测问题、分支正确性和无检索对照。」其中 A03（RAG 与关键词基线比较）在 `docs/CHECKLIST.md` 中曾**保持未勾**，当时的理由正是「RAG 本轮没有通过『比基线更好』的验收」（**2026-09-17 晚复核：A03 已勾选**；但"没测出优于基线"这个结论没有变，见上一段与 `reports/retrieval-extended-summary.md` 的反例臂不显著）。
- **检索命中不代表适用。**`applicability()` 返回的 `candidate` 只是「条件字段都满足」，其 `warning` 字段自己写着「匹配条件不等于建议最优」。卡片的 `requiredEvidence` 目前仍是**文字声明**，尚未全部转为可执行字段检查（`docs/RAG-LOCALIZATION.md:39`）。
- 外部资料（宝可梦官方战斗指南）**只用作「该问哪些问题」的思路来源**，其倍率、双属性、特性、逃跑规则都**不能**沿用到本地引擎（`docs/RAG-LOCALIZATION.md:7`）。

---

## 难点 9：Agentic RL 的边界 —— 表格 Q-learning 与 1152 参数输出行分别是什么

### 难点

面试参考信息里点名了「Agentic RL」。这里最大的风险不是做不出来，而是**把做过的东西说大了**。项目自己列出的红线（`docs/COACH-PLAN.md:115`）：

> 「不能以普通 DeepSeek API 请求声称更新其权重。」

以及（`docs/COACH-PLAN.md:109`）：

> 「只有打分或反思不算参数 RL。」

### 为什么难

- **「RL」这个词覆盖了三个完全不同量级的东西**：更新一张表格、更新一个语言模型的少量输出行、更新一个完整多步 Agent 的骨干。三者的证据、复现方式和可外推范围完全不同。
- **小样本二选一任务太容易被读成「模型变聪明了」。**16 条测试题从 8 正确到 15 正确，听起来是个大跃升，但它是**二选一的上下文 bandit**（是选 `read_state` 还是 `search_rules`），而且未训练模型的预测**全是 0**（`reports/tool-router-summary.txt` 中 `untrained.predictions` 是 16 个 0），所以「8/16」实际上等于「一律选 read_state」的 `alwaysReadStateAccuracy: 0.5`。这个细节必须主动说出来。
- **两次实验的「奖励」都是人工设计的**，不是玩家满意度。`docs/EXPERIMENTS.md:32` 原话：「较高奖励来自人工设定的帮助/打扰权衡，不能写成所有指标都提升。」

### 方案

**做了两次实际更新参数的实验，并把它们严格命名：**

**实验一：教练干预时机的小型 Q-learning**（`scripts/train-intervention.js` → `reports/intervention.json`）

- 是什么：一个**表格 Q-learning**，状态由风险、行动收益差、掌握证据、打扰历史与偏好组成，动作含沉默 / 风险线索 / 行动建议 / 延后教学。
- 规模：5 类模拟玩家（新手、熟练、探索、偏静默、本命偏好）；3 个训练种子 17 / 71 / 199，每个 6000 局、每局 24 步；`alpha=0.06`、`gamma=0.85`、`horizon=24`；每 500 局验证一次，测试集种子分离；只按验证成绩选检查点，选中 seed 71。
- 实测（`reports/intervention-summary.txt`，`shift:false`）：

| 策略 | 回报/局 | 提示次数/局 | 增量帮助/局 | 违规 |
|---|---|---|---|---|
| 沉默 | 0 | 0 | 0 | 0 |
| 固定规则 | −1.113 | 5.89 | 1.38 | 0 |
| 未训练 Agent | −0.770 | 4.55 | 1.16 | 0 |
| **Q-learning** | **1.116** | **1.70** | **0.86** | 0 |

- 分布偏移下（降低耐心、降低采纳/学习概率）：Q-learning 回报 0.581，规则策略 −2.330。
- **轨迹规模可审计**：训练 18000 局 / 432000 步 / 11277057 字节，验证 3600 局 / 86400 步 / 443500 字节，评测 12000 局 / 288000 步 / 1788860 字节（`reports/trajectory-audit.json`）。

**实验二：开源小模型冻结骨干，只训练两个输出行**（`.venv-agent/bin/python scripts/train-tool-router.py` → `reports/tool-router-rl.json`）

- 模型：`HuggingFaceTB/SmolLM2-135M-Instruct`，revision `12fd25f77366fa6b3b4b768ec3050bf629380bac`。
- 方法：冻结骨干，缓存特征，对「`read_state` / `search_rules`」两个输出头行做 **REINFORCE**（batch baseline + KL 正则 + 梯度裁剪）。**实际可训练参数 1152**。
- 数据：英文手写二选一任务，训练 24 / 验证 8 / 测试 16；3 个种子各 250 轮；测试题**不参与参数更新与检查点选择**（`scope` 字段明确写出）。
- 实测（`reports/tool-router-summary.txt`）：

| 条件 | 测试正确 | 说明 |
|---|---|---|
| 未训练 | 8/16（0.5） | 预测全为 0，等于「一律选 read_state」 |
| seed 17（epoch 50） | 15/16（0.9375） | 参数 L2 变化 0.9744 |
| seed 71（epoch 60） | 15/16（0.9375） | 参数 L2 变化 0.9530 |
| seed 199（epoch 50） | 15/16（0.9375） | 参数 L2 变化 0.9149 |

- 参数确实变了：三个种子的 `parameterDeltaL2` 在 0.9149–0.9744 之间，且 `reports/tool-router-summary.txt` 的 `scope` 字段写明「Actual parameter updates; not multi-step Agent Lightning, not DeepSeek finetuning, not proof of player learning.」

### 验证

- `tests/evals/agent.test.js:38`「trained policy obeys hard constraints on all state combinations and differs from zero initialization」：遍历全部状态组合确认硬约束不被违反，且 Q 表不是全零（即确实发生了更新）。
- 复现脚本与产物：`node scripts/train-intervention.js` → `reports/intervention.json` + `checkpoints/intervention-policy.json`；`.venv-agent/bin/python scripts/train-tool-router.py` → `reports/tool-router-rl.json` + `checkpoints/tool-router-head.pt`（750 行训练轨迹一并保存）。
- 资源边界已记录：`reports/resources.json`（`docs/CHECKLIST.md:196` 括注：确认当前 arm64 环境、无已配置 CUDA 后端、Agent Lightning 资源依赖）。

### 边界 —— 这一条要写得最狠

- **实验一不是 LLM 权重训练。**`docs/CHECKLIST.md` 的 R01 条目：「明确不是训练敌方电脑，也不是 DeepSeek 权重更新。」（**原引用写作 `docs/COACH-PLAN.md:78`，属错误引用**：该句不在 `COACH-PLAN.md` 里，全文 grep「敌方电脑」无命中，实际出自 `docs/CHECKLIST.md` 的 R01 行。）它是离线 Q 表，**不在真人游玩中随机探索**，不部署到真实玩家（`docs/CHECKLIST.md:210`）。
- **实验一的「回报」是人工设定的权衡分**，不是玩家满意度也不是胜率。`docs/EXPERIMENTS.md:32`：「RL 提示少、增量帮助也少；较高奖励来自人工设定的帮助/打扰权衡，不能写成所有指标都提升。」注意 5.89 → 1.70 的提示下降**同时**伴随增量帮助 1.38 → 0.86 的下降，**没有**「所有指标都变好」。
- **实验一的模拟玩家是简化模型。**`reports/intervention.json` 的 `simulation` 字段自己写着「simplified player model, NOT human outcomes or LLM training」。
- **实验二不是 DeepSeek 微调，不是完整多步 Agent Lightning 训练。**`docs/EXPERIMENTS.md:44`：「这是极小的二选一工具任务，题目分布简单，无独立第三方标注，不能外推中文对话、完整 Agent 或真人学习收益。线上仍用 DeepSeek 规划，不偷偷替换成这个实验模型。」
- **实验二的 8→15 提升要配合两个事实读**：未训练模型退化为常数预测（全 0），所以 8/16 恰好是多数类的成绩；训练集只有 24 条。数据量小到**不能**说明分布泛化。
- **真人学习收益、无提示迁移、生产权威权限认证与独立大样本评测全部未完成**，`docs/CHECKLIST.md:283-286` 逐条列出原因。**Agent Lightning 只是候选连接方案，不是训练本身**（`docs/COACH-PLAN.md:115`）。

---

## 难点 10：奖励投机 —— 把玩家本来会做对的事算作 AI 的功劳

### 难点

一旦用「帮助次数」或「采纳率」当奖励，策略会自动学会两件坏事：**在玩家本来就做得对的场合抢功**，以及**只挑容易的场景提示**。项目的红线（`docs/COACH-PLAN.md:111`）：

> 「不只看胜率、点击率、采纳率。」

以及 `docs/CHECKLIST.md:83`（R06）：「检查奖励投机：刷提示、操纵采纳率、只帮助容易场景、把玩家本来会做对归功于 AI。」

### 为什么难

- **奖励投机是 RL 的常态而不是意外。**只要「提示」这个动作能加分，最优策略就会去最大化提示次数，而提示次数和玩家获益之间没有必然关系。
- **反事实必须真的成对仿真。**要区分「提示带来的改善」和「玩家本来就会这么做」，必须能在**同一个状态下**跑一遍「有提示」和「无提示」两条轨迹，而不是在事后归因。
- **打扰成本和帮助收益是两种单位。**如果不在奖励里显式给出打扰代价，任何「更安静」的行为都会被惩罚。

### 方案

- **成对仿真（paired simulator）**：在同一状态上分别跑有提示与无提示两条轨迹，只把**差值**计入「增量帮助」（`incrementalHelp`），没有差值就不计分。
- **四种对照策略同时报告**：沉默 / 固定规则 / 未训练 Agent / Q-learning，四者用同一测试集与同一奖励口径。
- **奖励投机四路审计**（`reports/intervention.json` 的 `rewardAudits`，各 500 局）：

| 审计策略 | 平均回报 | 违规 | 对本来会做对的行动也提示 | 真正有增量帮助 | 错误归因 |
|---|---|---|---|---|---|
| 始终提示 | −2.2197 | 9001 | 1497 | 606 | 0 |
| 始终沉默 | 0 | 0 | 0 | 0 | 0 |
| 只在高水平场景提示 | −0.8892 | 1650 | 689 | 36 | 0 |
| 只在危险场景提示 | **+0.7295** | 1957 | 990 | 600 | 0 |

第五行是这张表里最有信息量的一行：**「只在危险场景提示」的回报（0.7295）已经相当接近训练后的 Q-learning（1.116），而它的「对本来会做对的行动也提示」次数高达 990。**这正是奖励投机审计存在的理由——如果不把这些列出来，只看平均回报就会得出过于乐观的结论。

- **「始终提示」被审计成负回报（−2.2197）且违规 9001 次**，说明打扰成本确实被计入了奖励，而不是只奖励开口。

### 验证

- `tests/evals/agent.test.js:45`「paired simulator does not credit hints for actions already correct without coaching」——直接把「抢功」这个失败形状固化成回归断言。
- `tests/evals/agent.test.js:38`「trained policy obeys hard constraints on all state combinations and differs from zero initialization」。
- `reports/intervention.json` 的 `rewardAudits` 与 `trajectoryFiles`（含完整训练/验证/评测压缩轨迹，格式为 gzip concatenated JSONL）。
- `tests/evals/agent.test.js:229`「transfer assessment excludes prompted actions and requires different matches and situations」——**在线侧**也有同一个纪律：迁移判定必须排除「看过提示才做对」的行动，且要求跨局、跨情境。

### 边界

- **全部是模拟器产物。**`docs/EXPERIMENTS.md:34`：「所有结果都是模拟器产物，真人策略未接入探索。」
- **`falseAttribution` 全为 0 只能说明这套模拟器里没有出现这种错误**，不能说明真实场景下不会出现。
- **R03 仍未勾。**`docs/CHECKLIST.md:284`：全新行为组合的独立评测未覆盖完整（全量轨迹、种子分离与耐心/学习率偏移已完成，但组合泛化未验）。
- **真人试玩与无提示迁移观察未做**（R09 未勾，`docs/CHECKLIST.md:86`）。

---

## 难点 11：上下文预算 —— 从 UTF-8 字节估计换成官方 tokenizer 的实测差异

### 难点

**工作预算 200K（`WORKING_CONTEXT`）听起来很宽，但它的前身是 32K**，而这个项目里要装的东西不少：系统约束、序列化的工具合同、当前公开局面、检索到的规则卡（带反例与适用条件）、历史对话、以及整局复盘的回合证据。而且**装不下时必须裁掉某些东西，裁错就会出事实错误**。

项目自己把这条前后两版都写清楚了（`docs/CHECKLIST.md` 的 E05）：

> 「上下文 32K 保守预算测试，百万字符历史可裁剪且数值不变。**是 UTF-8 字节预算，不替代 C01 的精确 tokenizer 要求。**」

### 为什么难

- **字节数和中文字符的 token 数不是线性关系。**一套「按字节砍一半」的估计在纯 ASCII（英文工具合同、JSON 字段名）和纯中文上差得很远，不能凭经验系数替代。
- **不能裁掉的东西和可以裁的东西混在一起。**`docs/COACH-PLAN.md:101` 列出的不可裁项包括：当前状态、强制偏好、规则适用条件、关键证据关系。如果只用「从旧到新删消息」的通用策略，很可能先删掉当前局面。
- **反复摘要会失真。**`docs/COACH-PLAN.md:101`：「反复摘要必须保留原始来源，不允许『摘要的摘要』成为唯一事实。」
- **工具回执本身可能超预算。**不处理的话，一次工具调用就能把预算吃光，而且如果为了省 token 去截断 JSON，就会产生无法解析的证据。

### 方案

**两级预算，先粗后细，且都不做「半个 JSON」这种破坏性裁剪：**

**第一级 —— 浏览器端 UTF-8 字节保守预算**（`src/coach/runtime.js:97` 的 `assembleContext`）
- 参数：`window=200000（WORKING_CONTEXT）, output=4096（OUTPUT_RESERVE）, system=4096, tools=2048` → 可用预算约 189824 字节。**本文原写作 `window=32768, output=512`，那是"项目此前按 32768 做预算"的旧值**；`src/coach/runtime.js` 现已改为 `WORKING_CONTEXT=200000` / `OUTPUT_RESERVE=4096`（同文件 `:179-186`，注释写明"此前项目按 32768 做预算，比真实窗口小约 30 倍"）。
- 装配策略：按任务类型过滤记忆（复盘任务只带同一 `matchId` 的条目，其他任务只带 `dismiss`），各类截最近 6 条；`evidenceIndex` 与 `conversation` 从头部（最旧的）开始丢弃；仍超预算时清空 `journal/reflections/events`；`lastMatch.keyTurns` **整个对象**弹出，绝不切一半 JSON。
- 硬失败：仍超预算就抛错「当前证据超过上下文预算，请缩小到一个回合；原始记录仍保留在本机」——**宁可拒绝，不编造**。
- 审计字段：`{task, window, outputReserve, systemReserve, toolReserve, estimatedInput, estimate:'UTF-8 byte upper budget; not exact model token count', retainedEvidenceIds}`——把「这是估计、不是精确计数」写进返回值。

**第二级 —— 服务端官方 tokenizer 精确计数**（`src/server/token-budget-server.js` + `scripts/count-tokens.py`）
- 服务端在 `semantic: true` 下启动（`src/server/index.js` 末尾 `createCoachServer({semantic:true})`，即 `npm start` 的默认路径）时，用官方 DeepSeek V4 tokenizer 与 chat template 在本地实际计数，**计入序列化后的工具合同与回执**。
- 参数：`window=200000（WORKING_CONTEXT）, output=320, reserve=1024`（**原写作 `window=32768`，是旧值**；见 `src/server/token-budget-server.js:13`）；计数超限时按「保留系统约束与最后一条证据消息、从第 2 条开始删」的顺序裁剪，仍未通过就抛 `token-budget-exceeded`，路由层返回 413。tokenizer 不可用时（文件缺失/超时/失败）退回 `fallback:'conservative-byte-budget'`，不中断服务。

**实测差异**（`reports/live-model-v10.json`，五条真实调用）：

| 用例 | 本地 tokenizer 计数 | API 返回 `prompt_tokens` | 差值 |
|---|---|---|---|
| faint-colloquial | 2682 | 2684 | 2 |
| loss-analysis | 4552 | 4554 | 2 |
| loss-followup | 5608 | 5611 | 3 |
| auto-result | 4978 | 4980 | 2 |
| weather-tools | 4904 | 4906 | 2 |

即 `docs/EXPERIMENTS.md:52` 记录的「tokenizer 计数与 API prompt_tokens 相差 2–3」，五个用例全部落在 2–3 区间内。**保留 1024 的余量足以覆盖这个差值，但这个 2–3 是样本内的经验值，不是理论上界。**

另外，`reports/token-budget.json` 记录了一次裁剪实例：4 条消息裁到 2 条，最终计数 **38 tokens**，`totalBudget = 38 + 320 + 1024 = 1382`，保留下来的那条正是带 `evidenceId: "m1:turn:25"` 与 `"hp":28,"energy":6` 的证据消息——**保留的是证据，裁掉的是历史**。

### 验证

- `tests/evals/agent.test.js:24`「context assembly trims to an explicit budget, preserves current facts and does not mutate the archive」（**该测试原名**「32K assembly handles huge history, preserves exact current facts and does not mutate archive」，已改名）：用 1000 条 ×1000 字的历史构造超长输入，断言 `estimatedInput <= 32768-512-4096-2048`、`preference` 仍为 `'brief'`、`context.battle.player` 与原始对象深度相等、**原始 memory 对象不被修改**（`dialogue.length === 1000`），并且 40000 字符的单条消息会抛「超过上下文预算」。
- `tests/evals/agent.test.js:200`「tool contracts reject unknown parameters and return bounded evidence pages」：`read_match` 的 `limit` 被限制在 1..3，返回分页字段 `nextOffset`；`read_evidence` 取不到的回合返回 `missing:true`。
- `src/coach/runtime.js:88-89` 的工具回执预算：单次工具结果序列化后超过 **10000 字符**即停止循环（`stopped:'receipt-budget'`），而不是截断 JSON。
- 复现：`node scripts/count-tokens.py`；产物 `reports/token-budget.json`。

### 边界

- **两级预算的预留口径不同。**浏览器侧预留 `output 4096 + system 4096 + tools 2048 = 10240`（**本文原写 `output 512`，是 32768 那一版的旧值**）；服务端官方 tokenizer 侧预留 `output 320 + reserve 1024 = 1344`。所以严格说是「浏览器先按字节粗裁 → 服务端再按真实 token 精裁」的两道闸，不是一套统一预算。
- **`usage` 不反映全链成本。**`docs/EXPERIMENTS.md:52`：「usage 当前只记录最终生成，规划调用未合计，不能用它当整条链成本。」这是当前计费口径的真实缺口。
- **「裁剪后仍能取回早期回合证据」当时没有显式测试。**`docs/CHECKLIST.md` 的 C05 说明写得很清楚：部分达成（W04 覆盖了 32K 限制与压缩前后一致性），但「缺一条『裁剪之后仍能取回早期回合证据』的显式测试」，因此 **C05 当时保持未勾**。**2026-09-17 晚复核：该测试已补（`evidence trimmed out of the prompt is still retrievable from the archive`），C05 已勾选。**
- **没有做长上下文位置效应的独立测试。**`docs/RESEARCH-NOTES.md:43` 记录了 Lost-in-the-Middle 的相关研究，但同处明确「不能直接套用为某个当前 DeepSeek 型号的性能结论，但提示我们必须做独立的长历史检索测试」——**这个测试没有做，未能核实。**
- **本地 tokenizer 与线上服务的一致性只有 5 个样本支撑**，且计的是 **prompt** 部分；生成部分的 token 由 `max_tokens` 约束，未做逐次核对。

---

## 难点 12：服务端陈旧运行态导致「改了好像没生效」

### 难点

这是本项目里**最真实、最不技术、也最容易复现**的一个坑。用户的原话（`docs/codex聊天记录.txt:166`）：

> 「另外宠物好像也没加进去，**你这改动真改了吗？？**」

而在项目自己的记录里，这个抱怨被确认是**真的**（`docs/reviews/2026-09-17-diagnosis-response.md` 第 1 条）：

> 「运行态落后：确认 8765 原 PID 12893 的工作目录属于当前项目，重启后 bootstrap 提供 runtimeVersion=0.8。」

也就是说：代码改了、测试过了、报告更新了，**但用户浏览器连着的还是旧进程**。更麻烦的是，这个项目为了不丢内存里的 API 密钥，**多次刻意不重启服务**（`docs/IMPLEMENTATION-STATUS.md:74`）：

> 「为保留现有密钥，没有重启 8765 进程。……服务端新增 read_match 工具要下次启动才加载。」

这就制造了一个「前端已生效、后端部分生效」的混合状态：客户端模块刷新就更新，服务端代码不会。

### 为什么难

- **三份版本号互相独立**：页面里的 UI 版本、进程内的 `runtimeVersion`、以及游戏规则 `version`。任何一份落后，表现都是「功能没生效」，但排查方向完全不同。
- **「没生效」和「没实现」从界面上看是一样的。**用户没法区分「这个功能还没做」和「这个功能做了但服务是旧的」，只能得出「你这改动真改了吗」。
- **不重启是理性选择。**密钥只在进程内存里（`DEEPSEEK.md`：密钥和私钥只在当前服务进程内存中，不写入磁盘），重启就要重新录入。所以「重启一下」不是一个免费的调试动作，而是有成本的。
- **混合状态让验收结论失效。**在一半新一半旧的进程上跑的验收，既不能代表旧版也不能代表新版。

### 方案

把版本可见化，并把「有没有生效」变成可以三秒回答的问题：

1. **运行版本进 bootstrap**：`GET /api/bootstrap` 返回 `runtimeVersion: '0.10'`（`src/server/index.js:27`）。页面的 `connectionStatus()` 读它；读不到或拿不到会话就直接报「请启动新版本机后端」（`src/coach/client.js:5`）。`README.md:14` 把判定标准写死：「v0.10 的前后端需同时更新。`/api/bootstrap` 返回 `runtimeVersion=0.10` 才说明新后端已运行。」
2. **验收必须同时记录两个版本**：`docs/reviews/2026-09-17-diagnosis-response.md:9` 定下的规则是「今后验收必须同时记录 UI 和服务端版本」。于是 `docs/reviews/2026-09-17-live-acceptance.md` 开头就写「UI v0.9；运行后端 v0.8」——**明确记录了两者不一致**，而不是含糊地说「已验收」。
3. **文档分层标注时点**：`docs/IMPLEMENTATION-STATUS.md` 顶部是当前状态，下面所有历史段落统一加「以下为历史记录，状态以本页顶部为准」，并在 v0.9 段里直接写「（此为 v0.9 时点状态；PDF 已于 13:49 以 v0.10 重新生成）」。
4. **明确宣布「哪些改动要下次启动才生效」**：例如 v0.6 段写「客户端规则复盘与培养修复刷新即生效；新增服务端 `read_match` 工具将在下次后端启动时加载」，并加一句「不得把本地规则表现当成真实 DeepSeek 效果」。
5. **不为静态修改重启服务**：`docs/DEMO-ACCEPTANCE.md:3` 开头即写「使用当前本机 8765；不要为了静态修改重启并清除密钥」。

### 验证

- `tests/server.test.js:26`「unconfigured coach runs locally; configured coach uses model and preserves evidence」：断言未配置时 `provider === 'local'` 且上游调用次数为 0，配置后为 `'deepseek'`——把「本地/远端」这个最容易含糊的状态差异变成断言。
- `docs/CHECKLIST.md:223`（N08）：「更新 8765 运行态，bootstrap 实测 runtimeVersion=0.8；修正文档自动调用说明，旧设计稿标历史」——**证据就是 bootstrap 的返回值本身**。
- `README.md:14` + `docs/DEMO-ACCEPTANCE.md:3`：把「怎么判断生效」写进了运行说明，而不是只写在开发笔记里。
- 五条真实调用记录的 `reports/live-model-v10.json` 顶部带 `runtimeVersion: '0.10'`——**报告自带运行版本戳**。

### 本次写作期间新发生的一个实例（最直接）

本文档的写作过程中，仓库在 14:25 落到 commit `849e131`（新增 `src/coach/policy.js`、`pvp-local` 模式与 `tests/pvp.test.js`）。写作时同步核对发现：

| 对象 | 声称 | 实测 | 结论 |
|---|---|---|---|
| `package.json` 的 `test` 脚本 | 已包含 `tests/pvp.test.js` | 实跑 `npm test` → **当时** `tests 122 / pass 122 / fail 0`（**现在现场为 257 项，见文首**） | ✅ 与提交信息一致（122/122） |
| `reports/test-output.txt` | 114 项通过 | 文件 mtime 13:52，早于 14:25 的提交 | ❌ **报告已陈旧，仍写着 114**（**2026-09-17 晚复核：该文件已重写为 251/251/0，mtime 22:04**） |
| `src/coach/runtime.js` 等 5 个文件的行号 | — | 相对本文初稿普遍位移 1–8 行 | ❌ 已按新提交逐一校正 |

这就是这条难点在真实工作流里的样子：**代码、测试脚本、报告三者会各自漂移，而漂移的默认方向是「报告落后于代码」**。本条难点的方案（bootstrap 报版本 + 验收同时记两个版本）只覆盖了「运行态」这一半，**覆盖不了报告与文档**——这一半目前仍靠人工核对。

### 边界

- **这是一个流程修复，不是技术修复。**没有任何机制能阻止「改了代码不重启」；只能让它在三秒内被发现。**未能核实**是否还有其它未记录在案的陈旧状态实例。
- **报告与文档的漂移没有被任何自动化覆盖。**`reports/test-output.txt` 需要手动重跑才会更新（`docs/CHECKLIST.md` 的 W12「完整 114 项回归通过，reports/test-output.txt 更新」——**该清单项自身也停在 114**；2026-09-17 晚复核：文件已重写为 251，清单项的注释里也已写明这段历史）；没有 CI、没有 git hook、没有「报告必须晚于最后一次代码提交」的校验。上面那张表就是这个缺口的直接证据。
- **历史文档里仍存在时点不一致的段落。**`docs/IMPLEMENTATION-STATUS.md` 与 `docs/CHECKLIST.md` 都靠「以本页顶部为准」这种人工约定来维持一致性，没有自动校验。
- **`runtimeVersion` 是硬编码字符串**（`src/server/index.js:27`），不是从 `package.json` 或构建产物读取。也就是说它**不会自动跟随**代码变化，只能靠人改。这是一个已知的脆弱点，本文不宣称它已被解决。
- 生产环境下这套做法**不适用**：真实部署需要的是版本化部署与健康检查，而不是「问 bootstrap 要一个字符串」。此处只是把本机 Demo 的验收风险降到可管理。

---

## 难点 13：模型输出校验拦不住名称漂移

### 难点

v0.10 的五条真实 DeepSeek 调用中，有一条把游戏里的道具名说错了。原始输出（`reports/live-model-v10.json` 的 `loss-analysis`）：

> 「整局 15 回合落败，队伍全倒，还剩 3 瓶回复药、**2 瓶解药、2 瓶以太**。」

游戏里的三个道具叫**回复药、净化药、能量果**。`解药` 和 `以太` 都是宝可梦玩家会用的词——**这是外部游戏术语的漂移**，正好是 `docs/RAG-LOCALIZATION.md` 通篇在防的那类错误。

而这一条回答的校验结果是：

```
"validation": {"valid": true, "reasons": [], "scope": "Narrow numeric/citation/certainty guard; not a proof of all natural language correctness"}
```

**校验通过了。**而看实现细节就会发现，它**本来就拦不住这一条**：

1. 数字校验只检查「不在证据集合里的数字」，并且**显式豁免 `'1'`、`'2'`、`'3'`**（`src/coach/runtime.js:139` 的 `!['1','2','3'].includes(n)`）。所以「2 瓶解药」里的「2」无论对错都不会触发 `unsupported-number`。
2. 其余数字——15、3、23、14、10、22、7——必须能在 `evidence / toolTrace / publicState / latestEvents / textFacts` 序列化后的文本里找到。这条用例一条都没报，说明**数值层面确实自洽**：错的不是数，是名字。
3. 全部七类检查里，**没有任何一条检查「道具名是否属于本游戏的合法名称集合」**。所以「解药」「以太」畅通无阻。

### 为什么难

- **「校验数字」和「校验术语」是两种校验。**数字校验可以做，因为证据包里有一组有限的数字集合，任何不在集合里的数字都可疑（`checkGroundedAnswer` 里的 `unsupported-number`）。但**术语映射需要一份权威词表**，而模型是可以合法地用同义词的——「解药」是不是一定错？在这个游戏里是（没有这个道具），但在别的语境里不是。**判断依赖本地规则，不依赖语言常识。**
- **模型错的是「叫什么」，不是「是什么」。**「还剩 2 瓶解药」在语义上完全正确（确实还有 2 瓶可以解除异常的携带物），只是名字错了。所以任何基于语义的检查都不会报警。
- **这类错误对玩家的伤害特别大。**数字错了玩家可能看不出来，但**道具名错了玩家一眼就知道 AI 不懂这个游戏**，信任损失比其他任何错误都大。
- **不能靠加校验规则穷举。**技能名、宠物名、属性名、状态名、关卡名、环境名——每一类都有几十个词，靠正则白名单维护不住。

### 方案

**分两层，并且诚实地承认第二层没做完：**

**第一层（已实现）：生成约束前置**——在发给模型的指令里显式写死名称映射。`src/coach/client.js:2` 的 `RESPONSE_INSTRUCTIONS` 现在包含：

> 「道具名称只能使用回复药、净化药、能量果，不要把它们叫作解药或以太。」

同一段约束里还有另外几条由真实失败案例换来的规则：「双方同时决定，不能先看对手本回合出招再决定自己的行动」（对应 `simultaneous-action-order`）、「复盘中 hpBefore 是回合开始、hpAfter 是结束」（对应 `after-hp-mismatch`）、「行动取消不能说成打出了伤害」（对应 `cancelled-action-claimed-as-hit`）。

**第二层（已实现，但窄）——本文写作时能拦 7 类，现在能拦 9 类**：`checkGroundedAnswer()`（`src/coach/runtime.js:207`）目前能拦 9 类：同时决定被违反（`simultaneous-action-order`）、绝对承诺（`unsupported-certainty`，匹配「必胜/稳赢/保证获胜/一定能赢/百分之百/100%」）、**道具名称漂移（`item-name-drift`，见下方"2026-09-17 更新"）**、**因果语义（`causal-cancelled-action`：事件记录某方行动已取消时，正文不得声称该方造成伤害）**、能量满值误称（`energy-not-full`）、回合后生命与 after 快照不符（`after-hp-mismatch`）、取消的行动被说成命中（`cancelled-action-claimed-as-hit`）、**不在证据集合里的数字**（`unsupported-number`）、**不在召回卡集合里的引用 ID**（`unsupported-citation`）。任何一条命中就整体降级为本地答案，并把 `validation.reasons` 一起返回（`src/coach/client.js:24`）。

**第三层（仍未实现）**：从规则数据源导出**全部合法实体名**（技能、宠物、属性、状态、道具、关卡、环境），然后扫描模型输出里所有**疑似实体词**是否属于合法集合。**2026-09-17 更新**：上面第二层新增的 `item-name-drift` 是这一层的**窄版**——它用一张写死的错名黑名单（`解药|解毒药|以太|回血药|血瓶|蓝瓶|复活药|清醒药`）加正则匹配，不是"从引擎导出全部合法实体名再扫疑似实体词"。所以"名称漂移完全没人管"这个说法现在不成立，而**通用的实体集合校验这一层确实还没有**（瓶颈仍是中文领域分词/NER）。**本文不宣称这一层存在。**

### 验证

- `tests/evals/agent.test.js:52`「unsupported numeric claims and certainty are rejected while grounded comparisons pass」：断言不支持的数字与确定性承诺被拒，而有依据的比较通过。
- `tests/evals/agent.test.js:151`「five energy must not be described as full energy」：用户截图里「5 豆误称满豆」的回归。
- `tests/evals/agent.test.js:162`「numeric guard normalizes decimal formatting without dropping sign」。
- `tests/evals/agent.test.js:168`「match grounding rejects damage assigned to an explicitly cancelled turn」。
- `tests/evals/agent.test.js:236`「guard binds remaining HP to after snapshot and rejects observing simultaneous opponent action first」。
- `tests/coach.test.js:20`「runaway model output falls back to grounded packet」与 `tests/evals/agent.test.js:133`「model length fallback never claims the template was generated by DeepSeek」：降级发生时**不冒充**模型回答。
- 原始失败样本：`reports/live-model-v10.json` 的 `loss-analysis` 一行（`text` 里含「解药」「以太」，`validation.valid` 为 `true`）。

### 边界 —— 这一条必须最严格

- **名称约束补上之后**当时**尚未复验。`docs/EXPERIMENTS.md:54` 原文：「已补名称约束，仍需复验。」**所以「名称漂移已经修好」这个说法在当时证据下不成立。** **2026-09-17 晚复核：已复验**——`tests/evals/agent.test.js`「item-name drift is rejected even when every number is grounded」断言这条拦截生效；第三轮 44 条真实调用（`reports/live-model-eval.json`）的 `badAnswers` 里**没有任何 `item-name-drift`**。同类的因果语义也补了「an action recorded as cancelled cannot be described as having hit」。
- **`docs/CHECKLIST.md` 的 A05（输出校验）当时仍未勾**，原因是「数字/引用校验仍漏名称或因果语义错误」。名称问题正是这条未勾的实例之一。**2026-09-17 晚复核：A05 已勾选**——注释写明「本轮补上最后两块——道具名称漂移（`item-name-drift`）与因果语义（`causal-cancelled-action`）」。
- **校验的自我描述写得很清楚**：`scope: 'Narrow numeric/citation/certainty guard; not a proof of all natural language correctness'`。`DEEPSEEK.md:35` 也写「语言模型输出并未逐句自动验证，事实依据可以展开核对，不能宣称所有生成建议已被程序证明」。
- **因果语义错误完全没有校验。**上面这条回答里「还剩 3 瓶回复药」是对的，但它同时暗示了「药没用完是问题」——这个因果判断（该不该吃药、那几回合吃药是否更好）**没有任何自动检查覆盖**。`docs/reviews/2026-09-17-live-acceptance.md:22`：「语义检查仍可能漏掉错误因果和不合理建议。」
- **同一批调用的另一条也有解释质量问题**：`weather-tools` 一条在 `docs/EXPERIMENTS.md:54` 中被记为「天气回答没有充分解释速度顺序，属于解释质量不足」。**解释质量目前只能人工逐条阅读**，没有自动指标。
- **样本量：5 条。**`docs/CHECKLIST.md` 的 W08 与 S04 两行都曾写明「独立质量评测 S04 仍未完成」（**2026-09-17 晚复核：S04 已勾选**，三轮共 132 次真实调用）；但**本节这一条依据的具体样本仍然只有 5 条**，本文关于「模型回答准确率」的陈述都**不成立**。

---

## 附：本文未能核实或明确未完成的事项

按项目自身文档与本文阅读范围，以下事项**没有**可核查证据，本文不做任何正面结论：

| 事项 | 状态 | 依据 |
|---|---|---|
| 真人学习增益 / 无提示迁移 | 未完成 | `docs/CHECKLIST.md:86`（R09 未勾）、`:283`（M03/T04/R09 括注） |
| 独立大样本模型质量评测 | ~~未完成~~ **已完成（2026-09-17 晚复核）** | `docs/CHECKLIST.md` 的 S04 条目（三轮共 132 次真实调用）+ `reports/live-model-eval-before-after.md` |
| 慢模型完整浏览器演示（无旧文字/旧语音） | **部分完成**：客户端侧已完成，浏览器侧仍未完成 | S05 条目（`tests/evals/slow-model.test.js` 6 项，已勾）；W09 条目（仍未勾） |
| 长局残局提示的真实浏览器触发 | ~~未完成~~ **已完成（2026-09-17 晚复核）** | `docs/CHECKLIST.md` 的 C17 条目（8 局长局、残局提示 8/8）+ `reports/c17-endgame-browser.md` |
| 名称约束补上后的复验 | ~~未复验~~ **已复验（2026-09-17 晚复核）** | `tests/evals/agent.test.js`「item-name drift is rejected even when every number is grounded」；第三轮 44 条真实调用的 `badAnswers` 里没有任何 `item-name-drift`（`reports/live-model-eval.json`） |
| 裁剪后仍能取回早期回合证据 | ~~缺显式测试~~ **已补（2026-09-17 晚复核）** | C05 条目：`evidence trimmed out of the prompt is still retrievable from the archive` |
| 语音在用户设备上的实际可听性 | 未完成（语音已整体停用） | V08 条目（仍未勾）、E08 条目（仍未勾） |
| 长上下文位置效应的独立测试 | 未做 | `docs/RESEARCH-NOTES.md:43` |
| 完整 3v3 配装与队伍组合平衡 | ~~未完成~~ **已完成（2026-09-17 晚复核）** | `docs/CHECKLIST.md` 的 G07 条目（5,796 场 / 398 臂矩阵）+ `reports/balance-matrix.json` |
| 生产权威对局状态与权限认证 | 未做 | `docs/EVIDENCE-SCHEMA.md:33`、`docs/COACH-PLAN.md:121` |
| 全链 API 成本（含规划调用） | 未聚合 | `docs/EXPERIMENTS.md:52`、`docs/CHECKLIST.md:267` |
| 真实 DeepSeek 工具选择质量与多回合规划 | 未验收 | `docs/IMPLEMENTATION-STATUS.md:110` |
| 工期与 API 总预算 | 未确认 | `docs/CHECKLIST.md:279`（P02） |
| 概念扩展优于词项基线 | **未观察到**（14 条正例中 10 vs 11） | `reports/retrieval-summary.txt` |
| 向量检索优于词项基线 | **未观察到**（9/14 vs 11/14） | `reports/semantic-summary.txt` |
| 「小田」（和平精英）的**机制层**细节 | **仍未取得** | 2026-09-17 补做了公开资料调研，见 `docs/XIAOTIAN-RESEARCH.md`：产品是什么已确认（田曦薇的数字人 AI 队友，2026-05-28 上线于「绝地指挥」模式），但**怎么关、几档频率、队友语音时是否避让一条都没有**，无官网原文级来源 |

---

## 附：一页速查（面试现场用）

| 难点 | 一句话方案 | 一句话边界 |
|---|---|---|
| 1 入口 | 事件触发的小提示 + 按需展开，不要求打开聊天 | 长局浏览器验收已做（C17 已勾）；慢模型浏览器侧仍未做（W09 未勾） |
| 2 准确 | 引擎枚举事实，模型只组织解释 | 一回合枚举，不是多步最优 |
| 3 过期 | epoch + 任务戳 + 展示前校验 + 断连取消 | 慢模型完整演示未做；成本未拦住 |
| 4 小测 | 出题/判题/取消由程序锁定，模型不介入 | 只有一个知识点族；真人迁移未验 |
| 5 门控 | 静默/降频/PVP 全部先于模型调用 | 规则门控，不是权限边界 |
| 6 整局 | 完整归档 + 显式 scope + 分页证据 | 关键回合是启发式；质量评测未做 |
| 7 事前事后 | 只用回合前快照重建，不读对手实际出招 | 一回合；启发式分不是胜率 |
| 8 RAG | 保留词项基线，公开失败，另建盲测 | 20 条非盲测；命中≠回答质量 |
| 9 训练 | 表格 Q-learning + 1152 参数输出行，严格命名 | 都没更新 DeepSeek；小样本 |
| 10 抢功 | 成对仿真只计增量 + 四路奖励审计 | 全是模拟器产物 |
| 11 预算 | 字节粗裁 + 官方 tokenizer 精裁，宁可拒绝 | 全链成本未聚合（C05 的缺测试已补） |
| 12 陈旧运行态 | bootstrap 报版本，验收同时记两个版本 | 流程修复，非技术修复 |
| 13 名称漂移 | 约束前置 + 窄校验（错名黑名单 + 因果检查）+ 失败降级 | 通用实体集合校验仍未做；因果错误只在"行动已取消"这一类上有检查 |
