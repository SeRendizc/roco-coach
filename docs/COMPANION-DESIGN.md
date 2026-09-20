# 陪练角色设计（Companion Design）

> 配套文档：`docs/DIFFICULTY-AND-SOLUTIONS.md`（实现难点与方案）、`docs/COACH-PLAN.md`（整体方案）、`docs/IMPLEMENTATION-STATUS.md`（当前状态）。
>
> **唯一事实来源是 `src/coach/companion.js`。** 本文与任何数字、行号、行为描述一旦与它冲突，以代码为准。配套阅读：`src/coach/memory.js`（记忆读写与校验）、`src/coach/session.js`（主动侧门控）、`src/coach/client.js`（模型越界回退）、`tests/companion.test.js`。
>
> **陪练改过四轮，本文只描述当前这一版。** 前几轮的反复（克制为主 → 放开情绪与吐槽 → 禁掉全部第一人称情绪 → 再把情绪做回来）不再逐条保留。当前边界只有四条：
>
> - **闲聊**：玩家主动搭话按 R1 接住，先应一声，再落一件真的记得的事（`intentOf` 的 `chat` 分支；有真实记录才接，什么都没记过时只回最短承接句）。
> - **情绪**：可以说，但必须有落点。`AFFECTS` 只有 `可惜 / 漂亮 / 悬 / 憋屈 / 松口气` 五个词，每一句都要带一个能对回同一条观察的锚点（`checkCompanionStance` 的锚点检查）；结算与首次减员这两类**必须**带一句（`STANCE_REQUIRED=['result','faint']`），没有就说不出话。
> - **历史与偏好**：跨局账本 `companionLedger()`，数据来自 `memory.events` / `dialogue` / `lessons` / `goal` / `favorite` / `preference`。
> - **仍然禁止**：第一人称感受（`SELF_CENTERED_EMOTION`，「我看得有点急」是反例）、复述屏幕（`SCREEN_ECHO`，「被草系按着打」是反例）、空泛安慰、评价玩家水平、说教、战术越界。
>
> 一条与陪练无关但会影响阅读的既有结论：**只有线上竞技 `pvp-live` 闭麦，本地对战 `pvp-local` 一律允许教练**（`src/coach/policy.js` 的 `RANKED_MODES=['pvp-live']`）。
>
> **本文是设计文档，不是验收报告。** 面试题明确允许非主角色「仅做设计」，因此本文的目标是：**把陪练这一角色的现状、设计、差距、风险一次讲清楚，并且绝不把设计写成已完成的现实。**
>
> **仍未实现的**（全文只有这一处集中列出）：§4.2 的 journal schema 扩展、§4.3 的三因子检索打分、§4.4 的 Reflection 合成、§6 R3 的「倾诉原文默认不进上下文」、§7 的第 4–7 项、以及第 8 项真人试玩与语言评审（U07 / T05 的勾选，`docs/CHECKLIST.md` 未改）。

---

## 0. 状态标注约定

全文每一个设计点都带一个状态标记，只有两种取值：

| 标记 | 含义 | 判定标准 |
|---|---|---|
| **【已实现】** | 当前仓库代码中可读到，且有自动测试或已保存的报告作为证据 | 必须能给出文件与行号、测试名或报告路径 |
| **【仅设计未实现】** | 只存在于本文档的设计中，仓库内没有对应实现 | 会额外给出「实现大致需要动哪里」与「怎么验证」 |

不使用的表述：「部分实现」（无法界定范围）、「已规划」（没有时间与产物）、「理论上支持」（没有代码）。如果一个设计点在实现与设计之间，会拆成两条分别标注。

陪练的实现证据集中在 `src/coach/companion.js`（状态、档位、模板、克制扫描）、`src/coach/memory.js`（对局事实的写入与读取校验）、`src/coach/session.js`（主动侧门控与档位）、`src/coach/client.js`（模型输出越界时的降级）与 `tests/companion.test.js`（35 条测试）。本文中标注【已实现】的陪练条目，都能在这 5 个文件里指到行、在 `tests/companion.test.js` 里指到测试名。


**当前总体状态一句话**：面试三角色中，**军师**（`src/coach/strategist.js`）与**老师**（`src/coach/teacher.js`）各自有完整闭环；**陪练的被动通道**（玩家先开口）现在有状态模型、语气档位、真实事件模板与克制扫描（`src/coach/companion.js`），**主动通道**（对局中不请自来地说话）有 11 个真实事件、独立于军师的预算，以及自己的出现方式（左下角带头像的一个人），已在 headless Chrome 里实测到（详见 §2.2 与 `docs/COMPANION-IMPLEMENTATION.md` §11–§12）。原始执行清单中 **T05「陪练」本身仍然是一个未勾项**（`docs/CHECKLIST.md:70`）：

> `- [ ] T05 陪练：真实事件关联的克制反馈、胜负后是否说话的判断、偏好跨局保持。`

本文的设计就是围绕 T05 这条未勾项展开的；实现完成后 T05 **仍不勾**——理由与证据见 `docs/COMPANION-IMPLEMENTATION.md` 的「仍未完成」一节。

---

## 1. 角色定位

### 1.1 陪练在这款游戏里应该做什么

先说结论：**陪练不是聊天机器人，也不是情绪出口。它的职责是让玩家愿意再开一局。**

这个定位来自项目已经确定的立场，而不是本文的新主张。三处原文：

- `docs/COACH-PLAN.md:9`：「陪练通过具体而克制的回应和持续记忆建立关系。三种角色不必对应三个独立 Agent。」
- `docs/COACH-PLAN.md:47`：「失败后不强行安慰；肯定应指出实际做好的选择，不生成空泛鼓励。」
- `docs/LINGBAO-RESEARCH.md:22` 的对照表里，产品问题一栏写的是「情绪陪伴容易油腻」，小芽的选择是「基于实际经历，少说；允许沉默」，验证方式是「不因每次失败都强制弹安慰」。

把这三条合起来，陪练的工作内容只有三件：

1. **记得发生过什么**——用玩家自己真实打过的对局、做过的选择、改过的偏好说话，而不是用泛泛的鼓励。
2. **决定要不要开口**——「不说话」是一个合法的、常见的、有时候是唯一正确的输出。
3. **在玩家开口时接住**——接住的是**话题**（刚才在聊什么、上一句是什么意思），不是情绪本身。

三件都不是「陪玩家聊天」。这一点必须写在设计的最前面，因为一旦把陪练定义成「聊天」，所有指标都会滑向聊天轮数——而 `docs/LINGBAO-RESEARCH.md:33` 已经把这条否掉了：

> 「最值得学的是『玩家仍在玩游戏时就得到帮助』，而不是把聊天面板做得更像一个角色。小芽的验收标准因此围绕自动介入、主动沉默、证据准确性与玩家自主操作，而不是聊天轮数。」

### 1.2 情绪可以有，但要有落点

情绪陪伴有三个已知的具体失败形态，都在这个项目里出现过或被预判过：

- **油腻**：每局失败都弹一句安慰。`docs/CHECKLIST.md:227` 记录了针对这条的修复：「首次倒下不再叠加旧版通用安慰气泡。」
- **空转**：玩家问一个具体问题，陪练给了一段正确但没用的话。真实对话里出现过（`docs/codex聊天记录.txt:136-140`）：玩家问「种子啥意思」，陪练分支回了一段「种子一般是可培养/可成长的基础伙伴或资源」的猜测，依据栏标着「陪练」。用户随后的评价是（`:165`）「我觉得这一点都不聪明？」
- **接不住追问**：玩家只发一个「？」，上一版把它当成新问题（`docs/codex聊天记录.txt:155`），随即又被当成「想问下一步干嘛」。

所以当前这一版对「情绪」的处理方式是：**给陪练一组有落点的态度词，而不是一组情绪标签。**

- **有落点**：可以说「可惜 / 漂亮 / 悬 / 憋屈 / 松口气」，但每一句都必须绑在一条真实读数上（第几回合收掉、哪一只顶了几个回合、这一局有几个回合贴着血皮撑过来）。判据是机械可执行的：句子里要出现一个能对回同一条观察的数字或名字（`checkCompanionStance` 的 `affect-without-anchor`）。
- **不落在自己身上**：出现第一人称 + 情绪词（`SELF_CENTERED_EMOTION`）就是违规——「我看得有点急」正是被这条拦下的原句，它把玩家变成了来看 AI 着急的旁观者。
- **不落在玩家水平上**：`skill-insult` 与 `preach` 两条硬线任何时候都不放。

玩家能感觉到的应该是「它今天话少了」「它没有又来安慰我」「它记得上次那件事」，以及「这次它是真的替这局可惜」，而不是「它现在很开心」。

---

## 2. 现状盘点

> 本节原写作于实现之前（commit `849e131`），2026-09-17 已按实现后的代码**就地更正**。改动前的行号与描述不再保留，需要对照时请看 git 历史。

### 2.1 被动侧：`src/coach/companion.js` —— 先算档位，再按档位选材料

文件导出 `companion(context, memory, message)`。每个入口的输出都不是固定字符串，而是「先由 `companionState()` 算出 `register`，再按档位从跨局账本里挑观察拼句」。

| 意图（`intentOf`） | 输出的档位 | 依据字段 |
|---|---|---|
| 情绪词（`EMOTION_WORDS`） | 真实连着输 → **R3**；否则 **R2** | `memory.events` 的连败与最近一局事实 |
| 追问 / 连续性（`FOLLOWUP_WORDS`） | **R2** | `memory.dialogue` 的最后一条 assistant 消息（去问号、截 36 字） |
| **闲聊**（`SOCIAL_ONLY`：你好 / 谢谢 / 在吗…） | **R1**（有真实记录才接） | 一句话先应住，再落一条跨局记录 |
| 有问题的提问（`ASK_WORDS`） | **R2** | 跨局账本里优先级最高的两条观察 |
| 其余 / 无明确意图 | **R1** | 同上，只取一条 |
| 本机一条记录都没有 | **R0**（最短承接句「我在。」） | 不编造过去 |

全部意图都由 `src/coach/companion.js` 的 `intentOf()` 与 `decideRegister()` 判定，纯函数、表驱动测试覆盖。**闲聊在旧版恒为 R0**，等于「玩家主动搭话永远换不来一句有内容的回应」，题目里的「能闲聊」落不了地——现在有真实记录就按 R1 接住。

三个可以直接观察到的性质（这是 §2 原本要指出的问题，现在逐条对照结果）：

三个可以直接观察到的性质：

- 倾诉分支不再是**固定文本**，`evidence` 也不再为空：它会说出真实的连败局数与最近一局的关卡/回合。但**只有在真实记录里确实连着输时**才进 R3 收尾语气，没有连败记录时退到 R2 具体关切。
- 追问分支做的是「把上一句接回来」，引用的确实是 `memory.dialogue` 里那条真实回复；有上一句时结尾不再反问，没有上一句时才问一句「你说的是哪一处？」——R2 的问句上限是 1，这一句用掉了它。
- 旧版硬编码的「我们已经练过速度判断了」**已删除**：现在只按 `memory.lessons` 里真实存在过的课程名说。对应测试：`one loss never becomes comfort, and silence stays a real output`。

### 2.2 主动侧：`coachEvent` —— 17 个事件，引用局内真实事实

> **事件数 11 → 12**：新增 `clutch`（这一局有几个回合贴着血皮撑过来、后来有没有撑住）。
> 没有它，「松口气」与「悬」在真实对局里永远说不出口：live 事件会先把那一次说掉。

陪练还有一半在 `src/coach/session.js` 里：它在**没有任何玩家输入**的情况下决定要不要说话。门控在 `src/coach/session.js`，措辞引用这一局的真实读数（对手、倒下的伙伴、伤害落在谁身上、连续几个回合没输出、局势逆转、僵持、跨局连败/连胜）。

`COMPANION_EVENTS` 一共 17 个：`result`、`streak-loss`、`streak-win`、`first-faint`、`return`、`rematch`、`stage`、`type`、`habit`、`trend`、`live`。判定顺序就是优先级，且**一次调用最多返回一个事件**；同一事件本局只报一次（`said` 去重），一个话题一局只说一次（`topics` 去重）。

**首次减员与整局结算这两类必须带一句有落点的情绪**（`STANCE_REQUIRED`）：这不是装饰，去掉它这两类会直接说不出话。真实输出（引擎实跑，种子 7、冠军高地、三连败）：

```
第14回合 [result] R3 → 连着4局没赢。这一局你打出去281点、挨了338点，还是没翻过来，可惜。
                       到这儿也行，想继续我就在。
```

**读不到事实就不说**：`proactiveText` 对每个事件都要求 `context.signals` 里那一项存在，缺了就返回 `null`。

门控（`src/coach/session.js:9-11`）：`isLiveMatch(context)` 或 `preference==='quiet'` 或 `session.dismissed` 或 `session.count>=2` 直接返回 `null`；同一局内两次提示至少间隔 3 回合（`result` 事件不受此限）。R3 与 R1 的档位由 `proactiveRegister({lossStreak})` 决定（`src/coach/companion.js:133`）。

`act()` 每回合结算后都会调用 `companionEvents()`，命中就交给 `notify()` → `queueCompanionCue()`，左下角的气泡会真的出现。「什么时候说」的额度与军师彻底分成两份记账（`companionSession()` vs `strategistSession()`）。判定逻辑全部在 `src/coach/companion.js` 里，纯函数，可脱开 DOM 单测。

**仍然只是设计的**：主动侧气泡里的文案是本机模板，不经过模型（`/api/coach` 只服务被动通道），因此也没有「生成后克制扫描」这一层；`src/client/app.js` 的 `notify()` 现在有两个调用点，但都只喂模板。

陪练的行为分布在两个文件里，这一点在阅读代码时容易漏掉，先说明。

### 2.3 路由位置：陪练是兜底路由

`src/coach/runtime.js:55` 的路由顺序是：先判「培养/加点/成长」→ 老师；再判战术词或存在对战局面 → 军师；**都不命中才落到陪练**。

```js
route = /培养|加点|成长/.test(message) ? 'teacher'
      : (/怎么打|建议|这回合|换宠|技能|先手|能量|豆|属性|克制|防御|预判/.test(message)
         || situational && context.battle) ? 'strategist'
      : 'companion';
```

这意味着：陪练目前是**剩余类别**，而不是一个被主动设计过的角色。

### 2.4 一轮完整链路里，剧本由谁决定

这点很关键，容易误解，必须写清楚：

- **分支判定由程序决定。**`companion()` 是纯同步函数，输入 `(context, memory, message)`，输出 `{text, evidence, register, companionState, replyConstraints, intent, silent}`（`src/coach/companion.js:170`），无随机、无网络。
- **措辞会经过模型改写。**陪练路由下 `locked` 保持 `false`（`src/coach/runtime.js:32-53` 里只有偏好回执、条件委托、种子解释、规则卡、小测、整局复盘等分支会 `locked=true`），因此 `deterministic=false`、`useModel=true`（`src/coach/runtime.js:59-60`），`companion()` 产出的整个包会作为证据包交给 DeepSeek 重新组织语言。
- 所以准确的表述是：**【已实现】陪练的「什么情况说什么、用什么档位说」由 `src/coach/companion.js` 的规则决定；「具体怎么说」由模型决定。** 未连接模型时输出 `src/coach/companion.js` 的原文。
- **档位如何真的影响模型输出（两处，都可测）**：一是模板句本身按档位不同（`src/coach/companion.js:170`）；二是证据包里多出 `replyConstraints`，明确给出字数上限、问句上限与禁止项，模型在 `src/server/index.js` 里收到的是整个证据包（`src/server/index.js:101` 的 `game_evidence: packet`）。**无法在服务端 system prompt 里单独加一段档位指令**，因为 `src/server/index.js` 不在本轮允许修改的文件里——这一点是边界，不是遗漏。测试：`runCoach routes to the companion and hands the register to the model`。
- **模型越界后的兜底是真实的**：`src/coach/client.js:31-34` 对陪练路由额外跑一次 `checkCompanionRestraint`，命中即回退到 `runCoach` 已经算好的本机模板（`local`），并把原因写进 `fallbackReason`。测试：`a model reply that breaks the register falls back to the recorded template`。


### 2.5 记忆侧现状（陪练可用的全部素材）

来自 `src/coach/memory.js` 的 `freshMemory()`，与陪练相关的字段：

| 字段 | 上限 | 内容 | 写入点 | 状态 |
|---|---|---|---|---|
| `events` | 12 条 | 已结束对局的 `{id,result,stage,turns,time,source,rulesVersion}`；**2026-09-17 起新增真实对局事实**：`enemy`（对手阵容）、`faints`（我方倒下顺序）、`firstLossTurn` + `firstFallen`（首个减员成对记录）、`survivors`（结束时存活数）、`items`（结束时剩余道具）。预制场景不写 | `rememberBattle` + `matchFacts`（`src/coach/memory.js:20`），读回时逐字段校验（`src/coach/memory.js:5-8`） | **【已实现】** 测试：`templates cite the real match, the fallen pet and the opponent` |
| `dialogue` | 8 条 | `{role,content}`，每条截 600 字 | `runCoach` 末尾 | **【已实现】** |
| `lessons` | 12 条 | 答对过的练习课程名 | 小测判对时 | **【已实现】** |
| `lastTopic` | 1 | 上一轮话题字符串 | 各分支 | **【已实现】** |
| `journal` | 240 条 | 教练事件：`hint`（含 channel）、`dismiss`、`decision`（含 lesson/reasonable/prompted/scoreGap/caseKey，confidence 0.6）、`coach-fallback`、`stale` | `recordCoachEvent` / `rememberDecision` | **【已实现】** |
| `reflections` | 以 lesson 为 key | `{label, reduceHints, evidenceIds, confidence, updatedAt, basis}` | `rememberDecision` | **【已实现，但只有雏形】** |
| `goal` / `favorite` | 1 / 1 | 「稳健 / 速攻」、本命宠 id | `rememberPreference`（仅玩家显式表达时） | **【已实现】** |
| `preference` | 1 | `brief` / `detailed` | 同上 | **【已实现】** |

**陪练实际读哪些字段（改动后的准确版本）**：`events`（含新增的真实对局事实）、`dialogue`、`lessons`、`goal` / `favorite` / `preference`，以及 `journal` 里的 `dismiss` 条数（用于 `consideration`，与 `adaptiveGate` 读同一份数据、不新建计数）。当前局面另从 `context.battle` / `context.lastMatch` 读取。**仍然没有读的**是 `reflections` 与 journal 里的 `decision` / `hint` 条目——§4.4 的 Reflection 合成仍然是设计。

### 2.6 测试覆盖现状

| 测试 | 覆盖内容 | 状态 |
|---|---|---|
| `tests/companion.test.js`（43 条） | 跨局账本（老对手 / 习惯 / 节奏 / 道具 / 地图）、每句的信息量自检、档位表与长度上限、真实事件引用、数字与依据一致、克制扫描与情绪落点、一次失败不出安慰、静默可用、偏好跨局保持、`runCoach` 把档位与约束交给模型、模型越界时回退模板、主动侧 11 个事件与预算、气泡几何与时长、旧存档降级 | **【已实现】** |
| `tests/features.test.js:18`「companion can initiate without a complaint and respects suppression」 | 主动侧：`first-faint` 与 `result` 会说话；同局第二次同事件不说话；`quiet` 档位不说话；已关闭不说话 | **【已实现】** |
| `tests/features.test.js:19`「PVP live blocks unsolicited and queried tactical help」 | PVP 下主动与被动的陪练通道均被拒 | **【已实现】** |
| `tests/evals/agent.test.js:131`「analysis after a match invokes model with whole-match evidence rather than canned companion reply」 | 对局结束后必须走整局分析，**不能**退回陪练通用话术 | **【已实现】** |
| `tests/evals/agent.test.js`「tool contracts reject unknown parameters and return bounded evidence pages」 | 陪练的主动侧与工具侧共用同一套 live-match 策略：只有 `pvp-live` 进行中被拒，对局结束后恢复可用 | **【已实现】**（commit `849e131` 扩写，2026-09-17 按 `src/coach/policy.js` 复核） |
| `tests/pvp.test.js:106`「a full hot-seat match terminates and keeps both sides independent」 | 同机轮流对战整场跑通，双方互不读对方选择；`pvp-local` 进行中陪练照常可用，只有 `pvp-live` 闭麦 | **【已实现】** |

**有测试覆盖的**：`src/coach/companion.js` 的三个分支（`tests/companion.test.js`）、档位表（表驱动，遍历 momentum × consideration × 发起方 × 意图）、克制约束（正反用例各一条）。

**仍然没有测试覆盖的**：陪练措辞的语言质量（需要真人读），以及陪练的态度在长时间游玩中的累积表现。这两项都属于 §7 第 8 项，**未做**。

**一处需要注意的范围变化**：`121411d` 起，「比赛进行中不给战术帮助」这条策略由 `src/coach/policy.js` 的 `isLiveMatch()` 承担，而 `RANKED_MODES=['pvp-live']`——**只有线上竞技闭麦，同机轮流对战 `pvp-local` 一律允许教练**。对陪练的影响是：`pvp-local` 进行中陪练照常可用（**以 `src/coach/policy.js` 与 `docs/CHECKLIST.md` 的 X02/X03 为准**）。


---

## 3. 情绪模型设计

> 本节原为【仅设计未实现】，**2026-09-17 已实现 §3.2 的状态模型、§3.3 的档位表、§3.4 的触发表（除注明者）与 §3.5 的克制扫描**；实现位置与测试名逐条写在下面。§3.1 是原则，从一开始就是约束而不是待办。

### 3.1 设计原则（先定约束，再定机制）

| # | 原则 | 理由 |
|---|---|---|
| P1 | **不声称内部情绪体验。** 文本里不出现「我难过 / 我开心 / 我生气了」这类第一人称情绪断言 | 既不可验证，也是油腻的主要来源。注意这条禁的是「谁在感受」，不是「有没有情绪」——情绪落在事件上是允许的，见下面第二条 |
| P1b | **情绪必须有落点。** 可以说「可惜 / 漂亮 / 悬 / 憋屈 / 松口气」，但每一句都要带一个能对回同一条观察的锚点 | 情绪空降等于空泛安慰；落在自己身上是把玩家变成旁观者 |
| P2 | **沉默是合法输出。** 每个触发点都必须有一个「什么都不说」的分支，且默认值偏保守 | `docs/COACH-PLAN.md:11`「就算玩家从不打开聊天，小芽也应有用」；说话本身是有成本的 |
| P3 | **基于真实经历。** 任何涉及过去的陈述，必须能对应到本机一条真实记录 | `docs/LINGBAO-RESEARCH.md:22`「基于实际经历，少说」 |
| P4 | **态度不改变事实。** 情绪档位只影响「说不说、说多长、从哪个角度说」，**绝不影响**数字、合法性、伤害计算与提示档位 | 与 `docs/DIFFICULTY-AND-SOLUTIONS.md` 难点 2 的分工一致 |

P1 与 P1b 合起来才是完整的边界，因为它最容易被误读成「陪练没有情绪」。当前版本的立场是**情绪可以有，但只能落在事件上**：`AFFECTS` 只有五个词，`checkCompanionStance` 会检查这句情绪是否带锚点、是否含第一人称；结算与首次减员这两类还被要求**必须**带一句（`STANCE_REQUIRED`）。玩家能感觉到的是「它替这局可惜」，而不是「它现在很开心」。

**实现注记**：P1 由 `SELF_CENTERED_EMOTION`（第一人称 + 情绪词出现在同一个分句里）与 `SELF_FOCUS` 强制；P1b 由 `checkCompanionStance` 的三关强制——说出五种立场之一、不含第一人称感受、带一个能对回同一条观察的锚点（`affect-without-anchor`）；P2 由 `decideRegister` 的 R0 分支与 `src/coach/session.js` 的门控强制；P3 由「所有事实片段都从 `memory.events` / `dialogue` / `lessons` / `context.battle` 里取，缺字段就不写该片段」强制；P4 由分工强制——档位只出现在陪练包里，`strategist` / `teacher` / `engine` 一行未改。

### 3.2 状态表示

**【已实现】** 纯函数 `companionState(memory, context, session, now)`（`src/coach/companion.js:83`），返回值与设计一致，另加 `registerReason` / `lossStreak` / `winStreak` / `facts`：

```
companionState(memory, context, session, now) -> {
  register,        // 'R0' | 'R1' | 'R2' | 'R3'  ← 唯一对外可见的枚举
  engagement,      // 0 | 1 | 2
  consideration,   // 0 | 1 | 2
  momentum,        // -3 .. +3
  reasons          // string[]，每个升降档的原因，用于自审与调试
}
```

**三个输入维度**（刻意做成三个正交标量，而不是一根「好感度条」）：

| 维度 | 取值来源 | 计算 | 是否新建存储 |
|---|---|---|---|
| `momentum`（势头） | `memory.events` 最近 3 局的 `result` | `win=+1, draw=0, loss=-1` 求和 | 否，复用现有字段 |
| `consideration`（体贴度） | `memory.journal` 中 `kind==='dismiss'` 且 7 天内的条数 `d` | `2 - min(2, d)` | 否，**与 `adaptiveGate` 读同一份数据**（`src/coach/memory.js:47`），不新建计数 |
| `engagement`（关注度） | 本轮是否由玩家发起 + `memory.dialogue` / `memory.events` 是否有内容 | 本轮玩家发起 → 2；有真实历史 → 1；**一条记录都没有 → 0**（**永不超过 2**） | 否，复用现有字段 |

`engagement` 的上限被刻意压在 2，理由是风险 R2（见 §6）：如果「被回应越多 → 越主动说话」，会形成一个自增强回路。因此 **`engagement` 只允许把档位往下压，不允许突破既有的全局频率上限**（全局上限来自 `src/coach/session.js:9` 与 `src/coach/experience.js` 的 `shouldNudge`，不参与任何打分）。

**实现注记（与设计的两处偏差，都是收窄）**：

1. **`engagement` 的 0 档与时间窗口**：设计写「近 3 天内有对话 → 1；否则 1」，需要一个对话时间戳，但 `memory.dialogue` 的条目只有 `{role, content}`，没有 `time`（`src/coach/runtime.js:71`），新建时间戳要动 `src/coach/runtime.js` 的写入点。实现改为「有真实历史 → 1；一条记录都没有 → 0」，并把 0 用来执行 P3：**没有任何真实经历时只输出最短承接句，不进具体关切**（测试 `one loss never becomes comfort, and silence stays a real output`）。
2. **`engagement` 不参与 R3 的判定**：R3 只由「真实连败」触发（见下），`engagement` 高低不会把档位抬上去。表驱动测试遍历 `momentum × consideration × 发起方 × 意图` 的全部 210 种组合，断言 `engagement<=2` 且 `consideration===0 && !playerInitiated` 时恒为 R0（测试 `register table: silence stays first and engagement never raises the ceiling`）。

**语气档位 `register` 的决策顺序**（先命中先返回，纯函数，表驱动测试）：

| 顺序 | 条件 | 结果 | 状态 |
|---|---|---|---|
| 1 | `isLiveMatch(context)`（当前只覆盖 `pvp-live` 进行中）或 `preference==='quiet'` 或 `session.dismissed` | **R0** | **【已实现】** `src/coach/companion.js:114-116` |
| 2 | `consideration===0` 且本条不涉及新的真实证据 | **R0** | **【已实现】** `:117`。被动通道下玩家这句话本身就是新输入，因此这条只在主动通道生效（那里由 `src/coach/session.js` 的门控承担） |
| 3 | 本轮由玩家发起，且命中情绪词表，**且真实记录里确实在连着输**（`lossStreak>=2` 或 `momentum<=-2`） | **R3** | **【已实现】** `:119` |
| 4 | 本轮由玩家发起（追问 / 具体提问 / 无明确意图） | **R2**（追问、提问）／**R1**（无明确意图） | **【已实现】** `:120-124` |
| 5 | 本轮不是玩家发起，且 `momentum<=-2`（或 `lossStreak>=2`），且本局尚未就此事说过 | **R3** | **【已实现】** `:126`（`alreadySaid` 由 `src/coach/session.js` 的 `session.count` / `lastTurn` 维护） |
| 6 | 本轮不是玩家发起，且存在一条**尚未说过**的具体观察 | **R1** | **【已实现】** `:127` |
| 7 | 其余 | **R0** | **【已实现】** `:128` |

注意第 1 条：**静默与 PVP 的判定位置与现状一致，仍然在一切之前**，这与 `docs/DIFFICULTY-AND-SOLUTIONS.md` 难点 5 的门控纪律是同一条。

**实现注记（三处有意收窄，避免文档与代码各说一套）**：

1. **第 3 条加了「确实在连着输」这个前提。** 设计原文是「本轮由玩家发起 + 命中情绪词表 → R3」；但本文 §3.4 的触发表同时写着「连败第 3 局起 → R3」。两者冲突时以更保守的一条为准：**没有真实连败记录的玩家不该收到「到这儿也行」**——那会是一句没有依据的收尾。没有连败时退到 R2 具体关切（引用那一局的真实事实）。
2. **第 4 条在第 3 条之外分成了 R2 与 R1。** 设计 §3.2 第 4 行说「玩家发起（其它意图）→ R2」，§3.4 又说「无明确意图的闲聊 → R1」。实现按 §3.4 处理闲聊（R1 只陈述事实），把「带着问题的提问」留在 R2（具体关切），纯寒暄走 R0（最短承接句）。意图由 `intentOf()` 判定（`src/coach/companion.js:29`）。
3. **第 2 条在被动通道不可达**（原因见上表）。这不是省略，而是「玩家先开口」这一事实本身就构成了新证据；主动通道那边由 `src/coach/session.js:9-11` 的 `count` / `lastTurn` / `dismissed` 门控执行同一件事。


### 3.3 语气档位表（这就是「可感知的情绪」）

**【已实现】** 档位表落成 `REGISTERS`（`src/coach/companion.js`），每个档位的上限与禁止项都被 `checkCompanionRestraint` 事后扫描，并随证据包以 `replyConstraints` 交给模型。

| 档位 | 允许说什么 | 明确禁止 | 长度上限 | 问句上限 |
|---|---|---|---|---|
| **R0 不说** | 什么都不说（主动通道 = 不发消息） | — | 主动通道 0 字；被动通道 8 字（最短承接句） | 0 |
| **R1 就事论事** | 一条可核对的事实陈述 | 任何评价、任何提问、任何建议 | 72 字 | 0 |
| **R2 具体关切** | 一条事实 + 一个有依据的观察 + 至多一个可选动作 | 空泛鼓励、水平评价 | 120 字 | 1 |
| **R3 收尾陪坐** | 一句「到这儿也行」+ 一个**不要求回应**的选项 | 任何建议、任何追问、任何追问式安慰 | 64 字 | 0 |
| **R4 在场搭话** | 对局中间插一句自己的观察（2–3 句，每句都有信息） | 问句（在场的话不是提问）、建议、评价 | 112 字 | 0 |

R4 是「在场」档：主动通道在对局中间开口时用它，长度介于 R1 与 R2 之间，且**不允许问句**——在场的话不是提问。R1–R3 的上限在第四轮整体调高过一次，因为「每条至少带一句玩家算不出来的事」把每条观察从一句变成 2–3 句。

**实现注记**：设计里 R0 的上限是「0 字」，实现分成两个通道——**主动通道**是真的不发消息（`coachEvent` 返回 `null`），**被动通道**（玩家先开口的聊天）不能返回空文本（`runCoach` 会以「教练暂时没有生成有效回答」拒绝，`src/coach/runtime.js:76`），所以 R0 在那里是最短承接句「我在。」（3 字），不新增事实、不评价、不提问。这是本轮唯一一处对档位语义的重新界定，理由写在 `src/coach/companion.js:168-169`。

R1 与 R2 的组合方式也说明一句，免得文档和代码各说一套：**R1 = 一条跨局记录 + 至多一条其它可核对细节**（同一局的观察、`memory.lessons` 里真实练过的课程名，或「上一次记录是 N 天前」；都是可核对陈述，不含评价、提问、建议）；**R2 = 同样的陈述 + 一条有依据的观察 + 至多一个「想回看第 N 回合说一声」式的可选动作**（`brief` 偏好下丢掉可选动作）。片段按上限整条取舍，超限就丢，不截半句。

**同一事件在四个档位下的对照示例**（设计示例，用于人工语言评审；**下面另附程序的真实输出**）：

> 事件：玩家 8 回合失利，这是第 2 连败，`journal` 中有 1 条 `dismiss`，局面为「结束时还剩 3 瓶回复药」。以下示例全部基于这一条真实数据。

- **R1**：「上一场冠军高地，8 回合，结束时还剩 3 瓶回复药。」
- **R2**：「上一场 8 回合，你有 3 次是在第 3 回合前后减员的。要看第 3 回合吗？」
- **R3**：「这两局先到这儿也行。想继续我就在。」
- **R0**：（不发消息。玩家下一次打开面板时，那条记录仍在「查看最近的行为依据」里。）
- **禁止示例**：「别灰心，你已经很棒了！下次一定能赢！」—— 同时违反三条：空泛鼓励、「下次一定」的绝对承诺、以及无证据的过去陈述。

**程序当前的真实输出**（对局由引擎实跑：种子 1、难度 normal、青芽草地、17 回合、失利、三只伙伴全部倒下、首次减员在第 3 回合、结束剩回复药 3 瓶；下面第二段是同一份记忆再输一局后的结果）：

```
你好（纯寒暄）        → R1  我在——小芽，一直跟着你的那只。你打过的那2局我都留着底。
好烦（倾诉，2 连败）  → R3  连着2局没赢。上一局你碰的就是这套阵容。到这儿也行，想继续我就在。
我该怎么打（提问）    → R2  上一局你碰的就是这套阵容。那局打到第13回合失利，你先倒下的是烬尾狐。
                           上一局你第13回合就收了，这一局已经到第24回合。
```

下面这两句来自主动通道（引擎实跑的对局，`report/sections/02-delivery.tex` 引的是同两句）：

```
胜：第15回合收掉，这一局拿得漂亮。
负：连着4局没赢。这一局你打出去281点、挨了338点，还是没翻过来，可惜。到这儿也行，想继续我就在。
```

这张表的作用是**可感知性来自取舍，而不是来自标签**：同一个事实，档位不同，说不说、说多长、说不说建议都不一样；情绪句只在有锚点时出现，且结算与首次减员**必须**有。玩家感受到的「态度」正是这个差异。**这些句子目前只有自动测试与上表的机械核对，没有经过真人语言评审**——U07 仍未勾。

### 3.4 触发条件表（设计与实现的合同）

| 触发源 | 前置条件 | 目标档位 | 是否允许沉默 | 现状 |
|---|---|---|---|---|
| 首次有伙伴倒下 | pve、前台、非预制对局、`count<2` | R1 | 是 | **【已实现】** 引用真实的倒下伙伴与剩余只数；`STANCE_REQUIRED` 要求这一条带一句有落点的情绪 |
| 对局结束（胜） | 同上 | R1 | 是 | **【已实现】** 引用真实关卡与回合数 |
| 对局结束（负） | 同上 | R1；`lossStreak>=2` → R3 | 是 | **【已实现】** 失败引真实关卡/回合/对手/剩余只数；连败 ≥2 转收尾（`src/coach/companion.js:133`） |
| 玩家倾诉负面情绪 | 本轮消息命中情绪词表 | R3；**无真实连败记录时 R2** | 否（玩家先开的口） | **【已实现】**（`src/coach/companion.js:19,116,142`），`evidence` 非空且逐条可核对 |
| 追问 / 连续性 | 消息是「？」或延续词 | R2 | 否 | **【已实现】** 引用 `memory.dialogue` 里真实的上一句（`:193`） |
| 无明确意图的闲聊 | 上述均不命中 | R1 | 是 | **【已实现】** 事实来自本机对战记录（`:136`） |
| 连败第 3 局起 | 且本局尚未就此事说过 | R3 | 是 | **【已实现】** 以 `lossStreak>=2` + `alreadySaid` 判定（`:123`）；**主动通道已接线**——2026-09-17 补上 `src/client/app.js` 里 `notify()` 的调用点（本局首次减员 / 整局结束两个真实事件），判定逻辑放在 `src/coach/companion.js` 的 `companionEvents()` 以便脱开 DOM 单测 |
| 多日未登录后首次进入 | ≥3 天无 `journal` 条目 | R1（只陈述，不追问） | 是 | **【仅设计未实现】** 只实现了「玩家先开口时，把『上一次记录是 N 天前』作为一条观察」（`:148`）；**没实现**「多日未登录后由陪练先开口」——那需要 §2.2 里缺失的主动调用点 |
| 偏好 / 目标变更回执 | 紧接确认句 | R2 | 否（这是回执） | **【已实现】**（`src/coach/runtime.js:32-33`，且 `locked=true`，不经模型改写） |
| 玩家关闭提示两次 | 7 天内 2 条 `dismiss` | 压到 R0（普通提示全压，风险提示仍放行） | — | **【已实现】**（`adaptiveGate`，`src/coach/memory.js:47`；同一份计数现在也喂给 `consideration`） |
| 玩家完成后主动提问 | 任意 | R2 | 否 | **【已实现】**（一切主动消息都会进入某个分支） |

### 3.5 反油腻的可测约束

**【已实现】** 禁止句式做成生成后扫描 `checkCompanionRestraint(text, {register, facts, previousAssistant})`，命中即回退到 `companion()` 已经算好的模板句——复用的正是 `checkGroundedAnswer` 的那条降级路径（`src/coach/client.js:31-34`），并在 `fallbackReason` 里写明原因，不冒充模型回答。测试 `restraint scan rejects the five forbidden shapes and accepts our own templates`（五条各一条正例 + 反向用例）与 `a model reply that breaks the register falls back to the recorded template`（端到端回退）。

| # | 禁止模式 | 实现里的正则 | 理由 |
|---|---|---|---|
| 1 | 第一人称情绪断言 | `SELF_CENTERED_EMOTION`：`(我\|咱)…(开心\|难过\|着急\|急(?!着)\|慌\|心疼\|坐不住\|捏把汗\|跟着念…)`，以及 `SELF_FOCUS` 的「我(看得\|看着\|盯着\|跟着\|在旁边…)」 | **两种声线下都拦**，不按声线分开。「我看得有点急」是这条的原型：它讲的是陪练自己的感受，把玩家变成了旁观者。注意它拦的是「谁在感受」，不是「有没有情绪」 |
| 1a | 情绪没有落点 | `checkCompanionStance`：情绪句必须是 `AFFECTS` 里的五个词之一、不含第一人称、且带一个能对回同一条观察的锚点（数字或共享名字）；`STANCE_REQUIRED` 的结算与首次减员两类还必须**有**这一句 | 情绪空降就是空泛安慰；「可惜」必须可惜在一件具体发生过的事上 |
| 1b | 说教 | `你应该 / 你必须 / 你最好 / 下次别 / 要记住 / 不该…` | 说的是「以后你要怎样」就拦 |
| 1c | 战术越界 | `建议你换 / 不如 / 最好… / 换上 / 改用 / 别用 / 先出…` | 战术指令是军师的活，陪练只评论局面 |
| 2 | 空泛鼓励 | `加油\|别灰心\|你已经很棒\|再接再厉\|下次一定\|一定可以\|你可以的\|不要放弃\|没关系的\|放轻松` | `docs/COACH-PLAN.md:47` |
| 3 | 强行追问 | 问号数 > 该档位的问句上限（R0/R1/R3 = 0，R2 = 1）；R2 上再要求不能连续两轮都以问句结尾（其它档位本来就不允许问句，所以这条只在 R2 上有额外效果） | `docs/CHECKLIST.md:44`（U07「不强行提问」） |
| 4 | 水平羞辱 / 能力判断 | `菜\|太弱\|你错了\|你不行\|水平不够\|速度意识差` | `docs/CHECKLIST.md:44`（「无水平羞辱」） |
| 5 | 无证据的过去陈述 | 出现「记得 / 上次 / 之前 / 上回 / 我们已经 / 上一场 / 那一局 / 连着」时，要求 `facts.allowPast`（本机确有 `events` / `lessons` / `dialogue`）；另外文本提到「速度判断」时，要求 `memory.lessons` 里真的有这条课程 | 原则 P3 |

第 5 条是这五条里最有价值的一条，因为它把「基于真实经历」从一句设计口号变成了**可失败、可回退**的检查。**它修掉的正是本文原来点名的那个反例**：旧代码硬编码的「我们已经练过速度判断了」现在不存在了，课程名只说 `memory.lessons` 里真实有的（测试 `one loss never becomes comfort, and silence stays a real output` 断言：`lessons=['灼烧追击']` 时不得出现「速度判断」，`lessons=['速度判断']` 时才允许）。

**一条额外的、比正则更硬的约束**：**陪练说出的每个数字都必须能在它自己的 `evidence` 里找到**（否则模型照抄就会被 `checkGroundedAnswer` 的 `unsupported-number` 判为编造、又被降级一次）。测试 `every number the companion says is backed by its own evidence` 对两个真实存档 × 五种意图逐个数字核对。


---

## 4. 记忆设计：Memory Stream 与 Reflection

> 面试参考信息里点名了 Memory Stream / Reflection。本节先给现状的精确边界，再给接近 Generative Agents 的设计，最后逐项对照差距。

### 4.1 现状的精确边界

**【已实现】** 的部分：

- **事件流存在**：`journal` 最多 240 条，`recordCoachEvent` 写入（`src/coach/memory.js:32`），按 `id` 去重，字段为 `id / kind / matchId / turn / rulesVersion / time / source / confidence`，并随 `kind` 附加专属字段。已有 5 类：`hint`（含 channel：`inline` / `attention` / `endgame` / `watch`）、`dismiss`、`decision`（含 `lesson / reasonable / prompted / scoreGap / caseKey`，`confidence` 固定 0.6）、`coach-fallback`、`stale`。
- **对局记录在 2026-09-17 变厚了（但不是在 §4.2 说的那一层）**：`memory.events` 的每条记录新增了 `enemy` / `faints` / `firstLossTurn`+`firstFallen` / `survivors` / `items`（`src/coach/memory.js:20-29`），读回时逐字段校验（`:5-8`）。这是陪练「引用真实事件」的数据基础。**这不等于 §4.2 已实现**：§4.2 说的是给 `journal` 加 `importance` / `poignancy` / `refs` / `lastAccess` / `supersededBy` 与新条目类型，这些**一个都没有做**。
- **反思存在，但是单一阈值规则**：`rememberDecision`（`src/coach/memory.js:39`）取该 `lesson` 下 **`!prompted`** 的最近 6 条，若 **≥3 条**就写一条 `reflections[lesson]`，`label` 只有两个取值——`good>=3 && good/recent>=0.75` 时为「多次独立选择合理，可减少该类提示」，否则为「继续观察，暂不判断掌握」。`basis` 字段自己写着「一回合启发式比较，不等于真正掌握」。
- **证据链是活的**：`adaptiveGate`（`src/coach/memory.js:47`）要求反思的 `evidenceIds` **全部**仍能在 `journal` 中找到，才能据此降频；`deleteMemoryEvidence`（`:58`）删除某条证据时，会一并删除**所有引用它的反思**，并清空 `dialogue` 与 `lastTopic`。
- **装配时会再过滤一次**：`assembleContext`（`src/coach/runtime.js:186`）在复盘任务下只保留同一 `matchId` 的条目、其他任务只保留 `dismiss`，各取最近 6 条；反思只保留 `evidenceIds.length>=3` 的。
- **迁移判定存在且严格**：`transferAssessment`（`src/coach/memory.js:71`）要求「跨 ≥2 局、跨 ≥2 种情境、≥3 次**无提示**行动、合理率 ≥75%」才输出「出现跨局独立迁移迹象，仍需观察」，且固定带 `causalClaim: false`。
- **自我审计雏形存在**：`coachSelfAudit`（`src/coach/memory.js:77`）统计 `coach-fallback / dismiss / stale` 三类，给出「降低普通提示频率 / 优先检查模型回答 / 继续观察」的动作建议。

**【仅设计未实现】/ 缺失** 的部分：

- **`journal` 里没有「经历」条目。**它记录的全部是**教练侧事件**（我提示了、玩家关了、玩家选了）。玩家的原话、玩家自己说出的目标、玩家反复关注的动作，都**没有**结构化条目。
- **没有重要性字段。**所有条目在装配时地位相同，靠 `slice(-6)` 决定去留。
- **没有检索打分。**装配是「过滤 + 截断」，不是排序。`Memory Stream` 的检索维度（recency / importance / relevance）一个都不存在。
- **没有时间衰减。**唯一的窗口是 `adaptiveGate` 里 dismiss 的 7 天硬阈值。
- **反思的 `label` 是固定字符串**，不是从证据合成出来的句子；也没有「新旧反思冲突」的处理。
- **反思只覆盖玩家侧。**`coachSelfAudit` 是一个即时统计，不是一条带 `evidenceIds` 的可修正假设。
- **原始清单确认了这一状态**：`docs/CHECKLIST.md:53` 的 **M03「多证据 Reflection：形成可修正假设；同时复盘小芽是否迟到、重复或错误」是未勾项**。也就是说，反思这一块在项目自己的账本里就只算雏形。

### 4.2 设计：Memory Stream 条目 schema

**【仅设计未实现】** 在现有 `journal` 上扩展字段（**不新建存储层级**，仍然是本机 localStorage 里的同一个数组、同一个 240 条上限）：

```
{
  // —— 现状已有 ——
  id,                 // `${matchId}:${kind}:${turn}` 或 `talk:${iso}:${seq}`
  kind,               // 现状 5 类 + 设计新增 3 类（见下）
  matchId, turn,
  rulesVersion, time, source, confidence,

  // —— 设计新增 ——
  importance,         // 1..10 整数，写入时由规则表确定，不由模型确定
  poignancy,          // 1..10，仅玩家主动表达时使用（规则计算，非情绪识别）
  refs,               // 本条引用到的证据 id 数组
  lastAccess,         // 上次被装配进上下文或被引用时的时间戳（recency 用）
  supersededBy        // 仅 Reflection 条目使用
}
```

**`kind` 的扩展**【仅设计未实现】：

| 新 kind | 记录什么 | 写入点 |
|---|---|---|
| `utterance` | 玩家一句话的**摘要 + 原文引用**（原文另存在 `dialogue`，此处只存引用，避免重复占额度） | `runCoach` 入口 |
| `preference` | 偏好 / 目标 / 本命的变化，含变化前后值 | `rememberPreference` 命中时 |
| `milestone` | 首次通关某关卡、首次跨过某个速度或伤害阈值 | 对局结算处 |

**`importance` 规则表**【仅设计未实现】——关键点是**由规则给出，不由模型给出**，这样它可以被单测，也不会因为模型措辞而变化：

| 事件 | importance |
|---|---|
| 玩家显式表达玩法目标或本命 | 9 |
| 玩家主动倾诉负面情绪 | 8 |
| 首次通关某关卡 / 首次跨过速度或伤害阈值 | 7 |
| 玩家在**无提示**下做出合理选择（`!prompted && reasonable`） | 6 |
| 玩家关闭一条提示（`dismiss`） | 5 |
| 小芽降级为本地回答（`coach-fallback`） | 4 |
| 普通提示已展示（`hint`） | 3 |
| 同一局面重复提示（去重后） | 1 |

### 4.3 设计：检索打分

**【仅设计未实现】** 采用 Generative Agents 式的三因子线性组合（`docs/RESEARCH-NOTES.md:32` 已把该论文列为可借鉴但不可照搬其社会模拟效果的来源）：

```
recency(m)      = 0.995 ^ hoursSince(m.lastAccess)          ∈ (0, 1]
importance(m)   = m.importance / 10                          ∈ [0.1, 1]
relevance(m, q) = 归一化到 [0,1] 的检索分数
score(m, q)     = w_r · recency + w_i · importance + w_v · relevance
```

三因子的来源与约束：

| 因子 | 怎么算 | 关键约束 |
|---|---|---|
| **recency** | `0.995 ^ 距上次访问的小时数`。注意用的是 `lastAccess`（上次被**访问**），不是 `time`（创建时间）——被反复想起的记忆衰减得更慢，这是 Generative Agents 的原始做法 | 需要新增 `lastAccess` 写入点 |
| **importance** | 直接读 §4.2 的规则表，除以 10 归一 | **不允许模型打分** |
| **relevance** | **复用现有检索，不新造**：词项走 `searchKnowledge` 的中文双字切分 + 同义词 + IDF（`src/coach/strategist.js:54`）；语义走 `src/server/semantic-server.js` 的 MiniLM 384 维 + RRF（`k=60`，`1/(60+rank)`） | 语义不可用时**退回词项并标注状态**——这条降级路径**【已实现】**（返回 `semanticStatus:'unavailable-or-warming'`） |

权重默认取 `w_r=0.5, w_i=0.3, w_v=0.2`。**这是设计取值，未经任何标定。** 在标定之前，本文不声称它优于现状的「过滤 + `slice(-6)`」——按 `docs/DIFFICULTY-AND-SOLUTIONS.md` 难点 8 的教训，检索类改动必须**先建对照集再改默认**。

两条硬约束（与现状一致，不得被打分覆盖）：

1. **硬偏好不参与竞争。**`goal` / `favorite` / `preference` 永远装配，不进入打分排序。这是 `assembleContext` 现有行为的延续（`docs/CHECKLIST.md:269` 对 C01/C04 的记录：「官方 tokenizer 实际计数及 API 差值；工具分页、指定回合、超长拒绝；不裁断 JSON」，以及 C03「压缩保留证据 ID、版本、时间、未完成委托」）。
2. **打分只决定「装不装进上下文」，不决定「掌握程度」。**掌握判定必须继续走 `transferAssessment` 的 `!prompted && 跨局 && 跨情境` 三重条件（`src/coach/memory.js:54-59`）。`docs/EXPERIMENTS.md` 与本项目多处声明：看过提示之后做对**不能**当作独立掌握证据。

### 4.4 设计：Reflection 如何从零散记忆合成更高层结论

**【仅设计未实现】**，但触发与失效语义**沿用已实现的骨架**。

**触发条件**（比现状更保守）：

| 条件 | 现状 | 设计 |
|---|---|---|
| 证据条数 | 同一 lesson 最近 6 条中 ≥3 条 | 同一主题**新增** ≥5 条 |
| 跨局要求 | 无 | 必须跨 ≥2 局 |
| 额外触发 | 无 | 出现与现有 Reflection **不一致**的新证据时立即重跑 |
| 输入范围 | 只统计 `reasonable` 计数 | 按 §4.3 的 `score` 排序取 top-k（k≤8）条目**原文 + id** |

把阈值从 3 提到 5 并加上跨局要求，理由很具体：**3 条同局证据可能只是同一局里的重复**，而 `transferAssessment` 早就把「跨 ≥2 局、跨 ≥2 情境」写成了硬条件（`src/coach/memory.js:58`）。设计把同一条纪律前移到 Reflection 的触发阶段。

**输出 schema**【仅设计未实现】：

```
{
  id, theme,
  claim,            // 必须是可否证的陈述
  evidenceIds[],    // 非空，且全部能在 journal 中查到
  confidence,       // 0..1
  createdAt,
  supersedes,       // 被本条取代的旧 Reflection id（可选）
  contradictedBy[]  // 与本条冲突的条目 id
}
```

**`claim` 的可否证性要求**——这是让 Reflection 有价值的关键：

- ✅ 「你最近三次减员都发生在第 3 回合前后。」（可以逐条核对）
- ❌ 「你的速度意识偏弱。」（不可否证，且是对玩家的能力判断）

**三类 Reflection**（对应 `docs/COACH-PLAN.md:91-92`「既反思玩家可能遗漏什么，也反思小芽是否重复、迟到或判断错误」）：

| 类别 | 合成什么 | 现状 |
|---|---|---|
| `player-pattern` | 玩家侧的候选模式，**只能作为可修正假设**，不得用于降低提示之外的任何自动决策 | **【已实现】雏形**（`reflections[lesson]`，但是固定字符串 label） |
| `self-audit` | 小芽自身是否重复、迟到、降级或判断错误 | **【已实现】雏形**（`coachSelfAudit`，但是即时统计，无 `evidenceIds`，不是可修正假设） |
| `preference-drift` | 偏好可能已变化（「最近三次你都选了稳健」）→ **只提议，必须玩家确认后才改 `goal`** | **【仅设计未实现】** |

`preference-drift` 的「只提议」不是保守，而是沿用 `rememberPreference` 已经确立的立场：**只有玩家显式表达才改偏好**（`src/coach/memory.js:7-9` 全部依赖显式句式「记住…」「以后…」）。行为推断只能逐步调整，不能替玩家改目标。

**失效链**（这是整个记忆设计里最不能省的一部分）：
1. 证据被玩家手动删除 → 相关 Reflection 立即失效（**已实现**，`deleteMemoryEvidence`）。
2. 证据因 240 条上限被淘汰 → Reflection 不能再据此生效（**已实现**，`adaptiveGate` 的 `backed` 检查；`docs/EVIDENCE-SCHEMA.md:20` 明确：「记录被保留上限淘汰时，也不能继续凭失去来源的假设调整」）。
3. 新旧 Reflection 冲突 → **不物理覆盖**旧条目，而是标 `supersededBy` 保留，便于审查（**【仅设计未实现】**）。

### 4.5 与现状的差距表（差多少）

| 维度 | 现状 | 设计 | 差距评估 |
|---|---|---|---|
| 条目类型 | `journal` 5 类（全部是教练事件）；`events` 每条另带真实对局事实（2026-09-17 新加） | +3 类（utterance / preference / milestone） | 需新增 2–3 个写入点；`utterance` 是最大的一项。**新加的 events 事实字段不改变这一条差距**：它加的是对局摘要，不是玩家的经历条目 |
| importance | 无 | 8 行规则表 | 小，纯函数，约 30 行 |
| poignancy | 无 | 规则计算 | 小，但**未验证**是否真的能反映强度，需真人对照 |
| 时间衰减 | 无（只有 dismiss 的 7 天窗口） | `0.995 ^ hours` | 小，纯函数 |
| 检索 | 过滤 + `slice(-6)` | 三因子加权排序 | **中等**：需新增打分器 + 一次权重标定 |
| relevance | 无 | 复用 MiniLM / 词项 + RRF | 小，组件已有，主要是接线与降级处理 |
| Reflection 触发 | 同 lesson 最近 6 条 ≥3 条 | 新增 ≥5 条 + 跨 ≥2 局 | 中，需重写 `rememberDecision` 的反思段 |
| Reflection 形态 | 固定字符串 label（两种取值） | 合成 claim + 可否定 + 证据 id | **大**：需新增一次模型调用 + 输出校验（模型只写 `claim`，其余字段由程序填） |
| 新旧 Reflection 冲突 | 无处理（直接覆盖） | `supersededBy` / `contradictedBy` | 中 |
| `self-audit` | 即时统计，无证据 id | 带 `evidenceIds` 的 Reflection | 中 |
| 删除级联 | **已实现** | 保持 | **0** |
| 硬偏好不被覆盖 | **已实现** | 保持 | **0** |
| 掌握判定门槛（`!prompted` + 跨局 + 跨情境） | **已实现** | 保持 | **0** |

**一句话总结差距**：删除、失效、硬约束这三条最难做对的部分**已经实现且经过测试**；缺的是「条目更丰富」「检索会排序」「反思能合成」这三层，而这三层里最难的是第三层（需要一次模型调用与配套校验）。

**2026-09-17 复述**：本节表格**一行都没有变**——陪练落地（§3）没有动记忆层，只把 `memory.events` 的字段加厚，并在 `readMemory` 里补了这些字段的校验。§4.2–§4.4 全部仍是设计。

---

## 5. 与三个角色的关系

陪练不是第四个系统，它和另外两个角色共用同一份记忆与同一套门控。设计上明确三条分工线：

| | 军师（`src/coach/strategist.js`） | 老师（`src/coach/teacher.js`） | 陪练（`src/coach/companion.js` + `src/coach/session.js`） |
|---|---|---|---|
| 回答什么问题 | 「这一手怎么打」 | 「我哪里可以进步」 | 「我们之前到哪了」 |
| 事实来源 | 引擎枚举 | 归档回合 + 引擎 | `events`（含对手/倒下顺序/剩余道具）/ `dialogue` / `lessons` / `goal`·`favorite`·`preference` / `journal` 的 dismiss 计数 / 当前局面 |
| 是否用模型 | 是（解释） | 是（教学措辞） | 是（措辞）；**分支由规则定** |
| 允许沉默 | 是（门控） | 是（复盘按需） | **是，且默认偏沉默** |
| 当前状态 | 完整闭环 | 完整闭环 | **被动通道已按 §3 落地；主动通道有实现但 UI 未接线（§2.2）；T05 未勾** |

`docs/COACH-PLAN.md:9` 已经写明「三种角色不必对应三个独立 Agent」——本设计保持单一 Agent + 三个路由分支的结构，只增加一个语气档位计算与一层记忆检索，不新增 Agent 数量。**实现遵守了这条**：没有任何新 Agent、新服务或新存储，`src/coach/companion.js` 是一个纯函数模块，档位与模板都在同一个包里返回。

---

## 6. 边界与风险

### R1 油腻（首要风险）

**风险**：主动说话密度过高，或者在玩家没要求的时候安慰他。

**现状缓解**【已实现】：每局最多 2 次停留/关注提示、两次至少间隔 45 秒、显示 10 秒后自动收起（`docs/IMPLEMENTATION-STATUS.md:97`）；模型解释在适度档每局最多 3 次、带我练档最多 6 次（`docs/CHECKLIST.md:235`）；安静档完全不触发。

**设计追加**【已实现，2026-09-17】：§3.5 的五条禁止句式扫描 `checkCompanionRestraint`，命中即回退模板句（`src/coach/companion.js:230`、`src/coach/client.js:31-34`；测试 `restraint scan rejects the five forbidden shapes and accepts our own templates` 与 `a model reply that breaks the register falls back to the recorded template`）。

**怎么验证**：自动测试只能验证「说了什么不该说的」；**「密度是否合适」必须靠真人**。当前 U07（`docs/CHECKLIST.md:44`，语言评审：具体、自然、无水平羞辱；不空泛安慰、不强行提问；使用者觉得烦时降低打扰）**是未勾项**。

### R2 依赖（自增强回路）

**风险**：如果「被回应」提高主动说话的意愿，就会形成正反馈——玩家越回，它越说；越说，玩家越烦。

**缓解**：§3.2 已经把它写进状态定义——`engagement` **只允许把档位往下压，永不允许突破既有的全局频率上限**。全局上限（每局次数、间隔、安静档）是硬约束，不参与任何打分。

**怎么验证**【已实现，2026-09-17】：表驱动测试遍历 `(momentum ∈ -3..3) × (consideration ∈ 0..2) × (是否玩家发起) × (5 种意图)` 共 210 种组合（`tests/companion.test.js` 的 `register table: silence stays first and engagement never raises the ceiling`），断言返回的档位恒在档位表内、`consideration===0 && !playerInitiated` 时恒为 R0、`engagement<=2`；`quiet` 与 `pvp-live` 另行断言恒为 R0。**次数上限本身仍由 `src/coach/session.js` 与 `src/coach/experience.js` 的既有门控承担，任何档位都不会改动它**（这一条是代码结构保证，不是测试断言）。

### R3 把玩家情绪当数据

**风险**：玩家说「今天真的很烦」，这句话被写进 240 条事件流，然后在别的场合被引用出来。

**缓解**：
1. 【已实现】玩家可查看、逐条删除、重置习惯、清除全部记忆；删除会级联清理引用它的反思（`docs/CHECKLIST.md` M04；`src/coach/memory.js:58`）。
2. 【已实现】记忆只在本机 localStorage，不上传；`docs/EVIDENCE-SCHEMA.md` 与 `README.md:41` 都写明了保存范围。
3. 【仅设计未实现】**倾诉原文默认不进入送给模型的上下文**，除非玩家本轮主动提起。这一条是设计新增的，现状没有对应机制。

**怎么验证**：删除级联已有同类测试可仿照（`tests/evals/agent.test.js:9`「three independent receipts reduce routine coaching; helped actions do not prove mastery」与 `:19`「dismissals persist with source and suppress only routine reminders」）；`utterance` 条目的「默认不进上下文」需要新增一条装配层断言。

### R4 错误归因（把「没照做」当「不懂」）

**风险**：玩家看过提示后选了别的行动，被记成「不熟练」。

**缓解**【已实现】：`rememberDecision` 用 `prompted` 标记区分「看过提示的行动」与「独立行动」（`src/coach/memory.js:39`）；`adaptiveGate` 的降频只依据 `!prompted` 的证据（`:47`）；`transferAssessment` 同样排除 `prompted`（`:71`）；`docs/COACH-PLAN.md:43` 明确「不以输赢倒推对错」。设计**保持**这套语义不变。

**怎么验证**：`tests/evals/agent.test.js:221`「transfer assessment excludes prompted actions and requires different matches and situations」；`tests/evals/agent.test.js:9`（三条独立回执才降频；被帮助过的行动不构成掌握证据）。

### R5 沉默被误读成故障

**风险**：R0 说了太多次，玩家以为功能坏了——这正是 `docs/codex聊天记录.txt:167`「我停留很久了还没提示嘛？」的另一种形态。

**缓解**【已实现】：静默档下仍提供一个**不抢焦点、可展开**的结算入口（`docs/CHECKLIST.md:227` 的运行说明：「静默模式下只提供可展开的结算入口，不自动请求模型」）；记忆面板里始终能看到近期行为依据。

**怎么验证**：**未验证。**这属于主观体验，需要真人试玩。

### R6 设计被读成已实现

**风险**：本文档最现实的风险——文档写得很完整，读者（包括面试官）误以为陪练已经做成这样。

**缓解**：全文逐条标注【已实现】/【仅设计未实现】，每条实现都给出文件行号与测试名；§2 给出当前实现（主动气泡的调用点已于第三轮接上，并补了 5 个真实事件、独立预算与左下角的出现方式）；§7 逐项写明哪几项已做、哪几项没做。本文档由实现者本人更正，更正记录见 `docs/COMPANION-IMPLEMENTATION.md` 的 §11。

---

## 7. 实施优先级与验收口径

落地顺序与**实际完成情况**（2026-09-17 更新；原来整表标着「全部为【仅设计未实现】」，现在逐行给出真实状态）：

| 顺序 | 做什么 | 为什么先做 | 验收方式 | 实际状态 |
|---|---|---|---|---|
| 1 | 修旧的硬编码「速度判断」 | 现状是**明确的错误**（不管练过什么都说速度），修它不需要任何新架构 | 单测：`lessons=['灼烧追击']` 时不得输出「速度判断」 | **【已实现】** 旧句已删除；测试 `one loss never becomes comfort, and silence stays a real output`（正反两条断言） |
| 2 | 引入 §3.2 的 `companionState()` + §3.3 档位表 | 情绪模型的最小可用形态；纯函数，可完全表驱动测试 | 遍历 `(momentum, consideration, 主动发起, 意图)` 组合；`quiet` 恒为 R0 | **【已实现】** 210 种组合的表驱动测试 + 四个档位四种文本 |
| 3 | 加 §3.5 的禁止句式扫描与回退 | 复用 `checkGroundedAnswer` 的降级路径，成本低、收益直接（防油腻） | 5 条正则各一条正反用例；命中时回退模板且标注 provider | **【已实现】** `checkCompanionRestraint` + `src/coach/client.js` 回退；两条测试 |
| 4 | 给 `journal` 加 `importance` 与 `lastAccess` 写入 | 检索打分的前置条件；纯写入，不改行为 | 规则表 8 行逐行单测 | **【仅设计未实现】** 未做 |
| 5 | 实现 §4.3 三因子打分，**但先不改默认装配** | 按难点 8 的教训：先建对照集，再切默认 | 与现有「过滤 + slice(-6)」在同一批历史上对照；**若没有增益就保留现状** | **【仅设计未实现】** 未做（前置的第 4 项没做，所以这一项也没有开始） |
| 6 | 扩展 `kind`：`utterance` / `preference` / `milestone` | 让陪练真正「基于真实经历」 | 写入点单测 + 删除级联测试 | **【仅设计未实现】** 未做。本轮改的是 `memory.events` 的字段（对手/倒下顺序/首个减员/剩余道具），**不是** §4.2 说的 journal 条目类型 |
| 7 | Reflection 合成（§4.4） | 最难、依赖最多，且需要一次模型调用与输出校验 | 触发条件、证据失效、`supersededBy` 三组测试 | **【仅设计未实现】** 未做 |
| 8 | 真人试玩与语言评审（U07 / T05） | **前 7 项都不能替代这一项** | 至少 5 人试玩，记录「觉得烦」的具体时刻与原文 | **【未做】** 没有真人试玩，因此 T05 与 U07 都不勾 |

**第 5 项和第 8 项是这份设计能否成立的两个关口。** 第 5 项对应本项目已经吃过一次的教训：向量检索上了、代码跑了、结果没有超过基线，因此**默认保持不变、失败原样保存**（`docs/DIFFICULTY-AND-SOLUTIONS.md` 难点 8）。第 8 项对应项目自己反复声明未完成的那一类验收——**真人效果不能由合成数据代替**（`docs/CHECKLIST.md:283`）。

**这两项都没有做。** 第 1–3 项做完只说明「陪练现在有一个可测试的状态与档位骨架」，不说明它「不烦人」——那是第 8 项的事。

---

## 8. 产品参考：灵宝（王者荣耀）—— 已完成调研

调研产物：`docs/LINGBAO-RESEARCH.md` 与 `docs/RESEARCH-NOTES.md`，查阅日期 2026-09-16，方式为公开公告核对（**不是**客户端实测）。

对陪练直接有用的两条：

- `docs/LINGBAO-RESEARCH.md:7`：2025-01-23 官方版本公告描述局内陪伴，以及频率、风格、音量等设置，并**考虑队友交流时减少打扰**。启发：注意力通道要能避让，而且避让是产品能力的一部分，不是礼貌。
- 同文件第 22 行的对照表：「情绪陪伴容易油腻」→ 小芽的选择是「基于实际经历，少说；允许沉默」，验证方式是「不因每次失败都强制弹安慰」。**本设计的 §3.3 档位表就是这条立场的可执行化。**

同时必须保留该文件的两条边界（第 27、29 行）：

- 小芽是回合制 PVE 原型，节奏与 MOBA 不同；**犹豫不是可靠的低水平信号**，不能只靠停留 20 秒判断玩家需要答案。
- **公开功能资料不能证明灵宝内部采用了 ReAct / RAG / Memory Stream / RL。** 同理，本文的 Memory Stream 设计是小芽自己的方案，不是从灵宝反推的。

---

## 9. 产品参考：小田（和平精英）—— 已完成调研

调研产物：`docs/XIAOTIAN-RESEARCH.md`，查阅日期 2026-09-17，方式为**公开发布与公开报道核对，不是和平精英客户端实测**（沿用 `docs/LINGBAO-RESEARCH.md` 的写法）。

### 9.1 结论先行：资料比灵宝少一个层级

调研做完了，但**它没有给出灵宝那种级别的对照**，这一点必须写在前面，不能让读者以为「做过调研」等于「有等价证据」。

- 灵宝有**官方公告原文**（TapTap 王者荣耀官方资讯栏目，带日期），并且写明过**频率、风格、音量、队友语音时减少打扰**这套机制；小田这轮**没有取得官网或公众号原文**，只有标注「来源：公众号」的转载，且**机制层完全空白**：怎么关、几档频率、是否避让，一条都没找到。
- 因此本文 §8 对灵宝能写「官方确认有避让机制」，对小田**只能写「方向一致，机制未证实」**。

一句话：**资料足以确认「小田是什么」，不足以做机制级设计对照。**

### 9.2 可以确认的（附来源级别）

- **【官方发布】**「小田」是和平精英品牌代言人**田曦薇**的游戏内 AI 数字人身份，**2026-05-28 上线**，进入**「绝地指挥」模式**（和平精英官方微博 2026-05-27 原文：「『绝地指挥』AI明星队友·小田，5月28日海岛与你浪漫相见」）。
- **【官方发布】** 官方定位为「AI 功能**从工具型向情感型升级**」「已具备**独立故事背景**与**记忆功能**」（腾讯游戏发布会 SPARK2026 披露）。
- **【我的推断，非事实】**「小田」**不是**「绝地指挥」这个模式本身——该模式 2025-03 已有公开玩法介绍，早于小田 14 个月。任务书要求「先确认题目所指」：**所指明确**，小田是该模式内的语音 AI 队友，不是语音助手、也不是陪玩服务。
- **一个口径冲突（不合并）**：发布会口径说「**策略大模型**驱动」，转载自公众号的稿件说「**混元 3 preview** 驱动」。两者是否同一件事，**未能核实**。

细节与全部链接见 `docs/XIAOTIAN-RESEARCH.md` 第 0–2 节。

### 9.3 §9.2 那五个问题，这轮答得上几个

原 §9.2 列了 5 个待答问题。**实际只答上 2 个**，如实记录：

| # | 原问题 | 本轮结果 |
|---|---|---|
| 1 | 入口形态 | **答上**：模式内的语音队友，会主动说话；不是面板、不是纯文字 |
| 3 | 内容边界 | **答上**：偏战术（决策/救援/物资/路线）+ 偏情绪（安慰/不满/吐槽），**不偏社交组队** |
| 2 | 触发方式 | **半答**：转载称既有「主动感知游戏变化」也有「响应玩家指令」，两者边界与优先级未找到 |
| 4 | 频率控制与关闭方式 | **答不上**：未找到任何说明 |
| 5 | 是否有可核对的「避免打扰」机制 | **答不上**。原假设是「若小田也有，说明这是品类共识而非个别设计」——**小田查不到，因此该论据不成立**：「避免打扰」目前**仍只有灵宝一侧的官方证据，是单点** |

原 §9.2 写的「如果小田在情绪陪伴上有可核对的具体机制，本文 §3 的情绪模型需要按它修订」——**没有发生**。所以 **§3 的情绪模型维持原样**，并明确标注为：**有外部同向证据，无外部机制对照。**

### 9.4 小田对本设计真正有用的三条

对着**实际实现**（`src/coach/companion.js`、`docs/COMPANION-IMPLEMENTATION.md`）看，有用的不是功能，是下面三点：

1. **「公开资料只讲能力上限，不讲失败时怎么办」本身就是结论。** 小田的公开材料全在讲「她有多像人」，没有一条讲打扰与失败；而小芽有 `checkCompanionRestraint` 的越界回退与无模型时的模板降级。**这正好是这份设计可以主动交代的强项**，不必等面试官问。
2. **一条明确冲突：情绪表达的边界相反。** 小田把「有脾气、会吐槽你瞎指挥」当卖点；小芽的克制扫描把第一人称情绪断言与空泛鼓励**一律拦下**。
   当前这一版把边界挪到了**落点**上：情绪可以有（`AFFECTS` 五个词），但必须绑在一条真实读数上，且**第一人称感受一律拦**（`SELF_CENTERED_EMOTION`）。也就是说，小田的「有脾气」小芽仍然不做，「对局面和选择的判断」它做，**评价玩家水平**仍然是硬线（`skill-insult`），空泛安慰、说教、战术越界也一条不放。原判断里「不放开」的部分仍然成立——小芽防的是 R1 油腻，而油腻的来源不是「有情绪」，是「情绪指向玩家」和「空泛」。**这仍然是「产品定位决定 AI 人格边界」的实例，只是边界换了一个更准的位置。**
3. **「拒绝并给替代方案」只部分适用。** 小田是**队友**，可以被指挥；小芽是**教练**，玩家自己出招。因此原 §9.2 第 3 问的答案**没有因小田而改变**：战术决策是队友的职责，**小芽继续不接管操作**。可借鉴的只是「R2 是唯一允许建议的档位」这条既有收窄。

完整逐条对照（含 6 条「明确不适用」与「与灵宝的一致/冲突」）见 `docs/XIAOTIAN-RESEARCH.md` 第 4 节。

### 9.5 这次调研保留的自我约束

原来那句「我没有可靠的公开资料，也不打算从『和平精英是一款战术竞技游戏』这类常识里推导它的 AI 队友能做什么」——**方向不变，但现在要说得更准确**：

**这轮找得到的资料比预期多**（官方微博原文、发布会披露、多篇媒体体验稿），所以「零命中、完全没有资料」的旧描述已经过期，不能再写在本文档里。**但资料仍然不足以支撑机制级对照**，因此约束换成下面这条，逐字适用于本文与 `docs/XIAOTIAN-RESEARCH.md`：

> 公开资料能证明小田**被怎么宣传、被怎么定位**，**不能证明**它内部采用了混元 3 preview、ReAct、RAG、Memory Stream 或 RL，也不能证明某个机制（如「拒绝指令」）的真实触发条件与频率。凡属转载级来源，一律标注；凡未找到，一律写「本轮未找到」，不写「不存在」。

核对方式沿用灵宝：每条结论附 URL 与查阅日期，并按【官方发布】/【媒体转载·报道】/【我的推断】三级分开标注，不混在一段里读起来像都是事实。

---

## 10. 一页速查

| 问题 | 答案 |
|---|---|
| 陪练现在实现了什么？ | 被动通道：`companionState()` → R0–R4 档位 → 从跨局账本 `companionLedger()` 里挑观察拼句 → `checkCompanionInformation` / `checkCompanionStance` / `checkCompanionRestraint` 三层自检 + 模型越界回退（`src/coach/companion.js`、`src/coach/client.js`）；主动通道：`src/coach/session.js` 门控 + 11 个事件 + 左下角气泡，已在 headless Chrome 实测（§2.2）。用到的记忆字段：`events`（含对手/倒下顺序/首个减员/剩余道具）/ `dialogue` / `lessons` / `goal`·`favorite`·`preference` / `journal` 的 dismiss 计数 |
| 陪练的清单状态？ | **T05 仍未勾**（`docs/CHECKLIST.md:70`）——实现完成不等于验收完成，理由见 `docs/COMPANION-IMPLEMENTATION.md`；反思 M03 也未勾 |
| 情绪模型是什么？ | 三个正交标量（momentum / consideration / engagement）→ 一个语气档位枚举 R0–R4；情绪本身由 `AFFECTS` 五个词 + `checkCompanionStance` 的锚点检查表达。**【已实现】**，对设计的三处收窄见 §3.2 实现注记 |
| 情绪怎么表达？ | 不给自己贴情绪标签，只给有落点的态度：五个词、每句带锚点、第一人称感受一律拦。可感知性来自「说不说、说多长、说不说建议」的取舍 |
| 记忆设计与现状差多少？ | 删除级联、失效保护、`!prompted` 门槛**已实现**；缺条目丰富度、检索打分、反思合成三层 |
| 打分怎么做？ | `0.5·recency + 0.3·importance + 0.2·relevance`；importance 由规则表定、不由模型定；权重**未标定** |
| Reflection 什么时候触发？ | 同一主题新增 ≥5 条证据且跨 ≥2 局；证据被删或淘汰即失效；新旧冲突标 `supersededBy` 不覆盖 |
| 最大的风险？ | 油腻（R1）与自增强依赖（R2）。扫描能拦住「说了不该说的」，**拦不住「说得太频繁」**；密度必须靠真人，U07 未勾 |
| 谁在验证陪练？ | `tests/companion.test.js` 35 条（跨局账本、信息量自检、档位与长度上限、真实事件引用、数字与依据一致、克制扫描与情绪落点、一次失败不出安慰、静默、偏好保持、模型约束送达、越界回退、主动侧 11 个事件、预算与气泡几何、旧存档降级）；**没有真人验证** |
| 小田调研？ | **已完成**（`docs/XIAOTIAN-RESEARCH.md`，查阅日期 2026-09-17）：小田=田曦薇的数字人 AI 队友，2026-05-28 上线于「绝地指挥」模式。**资料比灵宝少一个层级**——无官网原文，机制层（怎么关、几档频率、是否避让）全部「本轮未找到」；原 §9.2 的 5 个问题只答上 2 个。结论：§3 情绪模型维持原样，标注为「有外部同向证据，无外部机制对照」 |
