# 陪练实现说明（Companion Implementation）

> 配套文档：`docs/COMPANION-DESIGN.md`（设计与实现状态逐条标注）、`docs/CHECKLIST.md` 的 T05（**仍未勾**）。
>
> 代码基线：`src/coach/companion.js`。**本文只描述当前这一版陪练**；§11 与 §12 保留的是「在场方式」与「重做」两件事的来路，凡与代码冲突处以代码为准。
>
> 全量 `npm test` 与 `tests/companion.test.js` 的条数请现场跑，不要引用本文里的数字：测试数随代码增长，`package.json` 的 `test` 脚本是唯一权威。
>
> **本文只写已经跑起来、且有测试的东西。** 没做的部分单独列在「§6 仍然是设计的部分」与「§8 已知边界」，不用「部分实现」「理论上支持」这类说法。

---

## 1. 一句话

陪练的**被动通道**（玩家先开口）现在是一个纯函数闭环：

```
真实记录 → companionState() 派生状态 → 决定语气档位 R0–R4 → 从跨局账本挑观察（含一句有落点的情绪）
        → 证据包（含档位与约束）交给模型改写 → 生成后克制扫描 → 越界则回退模板
```

**主动通道**（对局中不请自来地说话）已经接线：`src/client/app.js` 的 `act()` 在每回合结算后调用 `companionEvents()`，命中事件就交给 `notify()` → `queueCompanionCue()`，左下角那个人的气泡会真的弹出来（`notify()` 的调用点在第一轮之后就已经接上，第三轮把它接到了新的出现方式上）。

**陪练现在已经是一个在场的人**：`COMPANION_EVENTS` 一共 11 个事件（§11.1），出现方式是左下角带头像与名字的一个人（§11.2），说话额度与军师彻底分开（§11.3）。**情绪的边界见 §11.4**：可以说有落点的态度，不许播报自己的感受。

改动落在 5 个文件，**没有新增任何模块**（浏览器只允许加载 `src/server/index.js` 的 `publicAssets` 白名单里的文件，新增文件会 404，所以 `src/coach/companion.js` 一个文件承担了状态、档位、模板与扫描）：

| 文件 | 改了什么 |
|---|---|
| `src/coach/companion.js` | 从 6 行重写为状态模型 / 档位表 / 真实事件模板 / 克制扫描 / 主动侧模板 |
| `src/coach/memory.js` | `rememberBattle` 记录真实对局事实（对手、倒下顺序、首个减员、剩余道具）；`readMemory` 逐字段校验新增字段 |
| `src/coach/session.js` | `coachContext` 补上关卡、当前对位、倒下伙伴、剩余只数；`coachEvent` 接上 `proactiveRegister` + `proactiveText` |
| `src/coach/client.js` | 陪练路由下增加一次 `checkCompanionRestraint`，越界回退本机模板（复用既有降级路径） |
| `tests/companion.test.js` | 新增 12 条测试；`package.json` 加入 `test` 脚本与 `test:companion` |

**未改动**：`src/client/app.js`、`src/server/index.js`、`src/game/engine.js`、`src/client/index.html`、`src/client/style.css`（硬性约束），也没有改 `src/coach/runtime.js`（陪练路由与 `companion(context, memory, message)` 的调用方式保持不变，因此这次改动与同批其他改动互不冲突）。

---

## 2. 状态怎么算（`companionState`）

`src/coach/companion.js:83`，纯函数，签名与设计一致：`companionState(memory, context, session, now)`。

| 字段 | 算法 | 数据来源（真实字段） |
|---|---|---|
| `momentum` | 最近 3 局 `win=+1 / draw=0 / loss=-1` 求和，范围 −3..+3 | `memory.events[].result` |
| `lossStreak` / `winStreak` | 末尾连续同结果的局数 | 同上 |
| `consideration` | `2 - min(2, 近 7 天 dismiss 条数)` | `memory.journal` 里 `kind==='dismiss'` 且 `time` 在 7 天内——**与 `adaptiveGate` 读同一份数据，不新建计数** |
| `engagement` | 本轮玩家发起 → 2；有真实历史（events 或 dialogue）→ 1；**一条记录都没有 → 0** | 本轮消息 + `memory.events` / `memory.dialogue` |
| `reasons` | 4 条中文原因，每条都写明数值与来源字段 | 上面三项 + 档位判定结论 |

`reasons` 就是「你为什么现在是这个语气」的答案。真实输出示例（对局由引擎实跑，不是手写数据）：

```
最近2局0胜2负，momentum=-2（来源：memory.events）
近7天有1次主动关闭提示，consideration=1（来源：memory.journal 的 dismiss）
本轮由玩家发起，意图=emotion，engagement=2（来源：本轮消息）
判定：玩家本轮倾诉，且真实记录里连着输（连败2局，momentum=-2）
```

**与设计的两处收窄**（不是遗漏，都有理由）：

1. `engagement` 的 0 档：设计写「近 3 天内有对话 → 1；否则 1」，需要一个对话时间戳，而 `memory.dialogue` 的条目只有 `{role, content}`（`src/coach/runtime.js:79`）。实现改为「有历史 → 1；什么都没有 → 0」，并把 0 用来执行原则 P3：**没有任何真实经历时只输出最短承接句，不进入具体关切**。
2. `engagement` 不参与升档：它只用来判定「有没有可依据的经历」，档位不会被它抬高——表驱动测试遍历 210 种组合断言 `engagement<=2`，且次数上限仍由 `src/coach/session.js` / `src/coach/experience.js` 的既有门控承担。

---

## 3. 档位怎么切换（R0–R4）

决策顺序（先命中先返回，纯函数，`src/coach/companion.js:110`）：

| 顺序 | 条件 | 档位 |
|---|---|---|
| 1 | 线上竞技进行中（`isLiveMatch`）或 `preference==='quiet'` 或 `session.dismissed` | **R0** |
| 2 | `consideration===0` 且本条不涉及新的真实证据（只在主动通道可达） | **R0** |
| 3 | 玩家发起 + 情绪词 + **真实记录里确实在连着输**（连败 ≥2 或 momentum ≤ −2） | **R3** |
| 4 | 玩家发起：追问 → **R2**；带问题的提问 → **R2**；纯寒暄 → **R0**；无明确意图 → **R1**；本机无任何记录 → **R0** | R2 / R1 / R0 |
| 5 | 非玩家发起 + 在连着输 + 本局尚未就此事说过 | **R3** |
| 6 | 非玩家发起 + 有一条尚未说过的真实观察 | **R1** |
| 7 | 其余 | **R0** |

档位表（`REGISTERS`，`src/coach/companion.js:12`）与生效方式：

| 档位 | 字数上限 | 问句上限 | 允许建议 | 真实输出示例（引擎实跑的对局） |
|---|---|---|---|---|
| R0 不说 | 8（主动通道 0） | 0 | 否 | `我在。` |
| R1 就事论事 | 72 | 0 | 否 | `你好` → `我在——小芽，一直跟着你的那只。你打过的那2局我都留着底。` |
| R2 具体关切 | 120 | 1 | 是 | `我该怎么打` → `上一局你碰的就是这套阵容。那局打到第13回合失利，你先倒下的是烬尾狐。…` |
| R3 收尾陪坐 | 64 | 0 | 否 | `好烦` → `连着2局没赢。上一局你碰的就是这套阵容。到这儿也行，想继续我就在。` |
| R4 在场搭话 | 112 | 0 | 否 | 主动通道对局中间插话用；不允许问句 |

**R1–R3 的上限在重做那一轮整体调高过**（R1 40→72、R2 80→120、R3 30→64），因为每条观察从一句话变成了 2–3 句。

**档位是真的影响输出，不是算完就丢**，三个通道各有一条测试：

1. **本机模板**（未接模型）：四个档位给出四段不同文本，且长度都在各自上限内（测试 `the register changes the wording, not only the field`）。
2. **模型路径**：档位与 `replyConstraints`（`maxChars` / `maxQuestions` / `forbid` / 一句中文指令）随证据包进入 `game_evidence`（`src/server/index.js:96`），模型看到的是「本轮档位 R1：正文不超过40字，不要问句，只写有本机记录支撑的事实」。测试 `runCoach routes to the companion and hands the register to the model` 断言不同档位送出的约束不同（40 / 30 字上限）。
   - **边界**：不能在服务端 system prompt 里另加一段档位指令，因为 `src/server/index.js` 不在本轮允许修改的文件里。这件事写在文档里，不假装做到了。
3. **生成后强制**：`src/coach/client.js:31-34` 对陪练输出跑一次 `checkCompanionRestraint`，命中即回退到本机模板，并把原因写进 `fallbackReason`。测试 `a model reply that breaks the register falls back to the recorded template`（模型回「别灰心，你已经很棒了。」→ 被拦下，显示本机模板）。

**一处有意的重新界定**：设计里 R0 是「0 字，什么都不说」。主动通道确实如此（`coachEvent` 返回 `null`）；但被动通道（玩家先开口的聊天）不能返回空文本——`runCoach` 会以「教练暂时没有生成有效回答」抛错（`src/coach/runtime.js:76`）。所以 R0 在那里是最短承接句「我在。」（3 字），不新增事实、不评价、不提问。

---

## 4. 真实事件关联：引用了什么，从哪来

陪练说的每一件「过去的事」都必须能在本机记录里指到。字段来源只有两处：

**（1）跨局记录 `memory.events`**（`src/coach/memory.js:20-29` 新增，读回时逐字段校验 `:5-8`）：

| 字段 | 内容 | 例（引擎实跑：种子 1、青芽草地、17 回合） |
|---|---|---|
| `enemy` | 对手阵容（真实名字） | `['炽鬃狮','潮甲龟','芽角鹿']` |
| `faints` | 我方倒下顺序 | `['烬尾狐','潮甲龟','芽角鹿']` |
| `firstLossTurn` + `firstFallen` | **成对记录**首个减员的回合与那一只 | `3` + `'烬尾狐'` |
| `survivors` | 结束时存活只数 | `0` |
| `items` | 结束时剩余道具 | `{potion:3,cleanse:2,ether:2}` |

`firstLossTurn` 与 `firstFallen` 必须成对，这是一条真实的坑：`faints[0]` 是队伍顺序里的第一只，不一定是第 `firstLossTurn` 回合倒下的那只——混用会说出一句听起来具体、实际上是假的话。测试 `templates cite the real match, the fallen pet and the opponent` 直接比对引擎对象与文本。

**（2）当前局面**（`context.battle` / `context.lastMatch` / `coachContext`）：当前对手、已倒下伙伴、剩余只数、关卡、回合数。

**旧存档的降级是明确的**：没有新字段的记录读回来是 `[]` / `null`，模板就少说一句，绝不补默认值（测试 `companion facts degrade to null instead of default values`：一条只有 `stage` 和 `turns` 的旧记录，输出停在「青芽草地9回合」，不出现「倒下」「回复药」）。

**一条比正则更硬的约束**：陪练文本里的每个数字都必须出现在它自己的 `evidence` 里。否则模型照抄这些真实数字时，会被 `checkGroundedAnswer` 的 `unsupported-number` 判成编造、再被降级一次（假阳性回退）。测试 `every number the companion says is backed by its own evidence` 对 2 份真实存档 × 5 种意图逐个数字核对。

---

## 5. 克制：五条约束与它们的测试

`checkCompanionRestraint(text, {register, facts, previousAssistant})` 实现设计 §3.5 的约束，出句后扫描，命中即回退本机模板：

| # | 禁止 | 判定 |
|---|---|---|
| 1 | 第一人称情绪断言 | `SELF_CENTERED_EMOTION`：第一人称 + 情绪/体感词出现在同一个分句里（「我看得有点急」是反例）；`SELF_FOCUS` 另拦「我盯着 / 我在旁边」这类。**两种声线下都拦** |
| 1a | 情绪没有落点 | `checkCompanionStance`：情绪句必须是 `AFFECTS` 五个词之一、不含第一人称、且带一个能对回同一条观察的锚点；`STANCE_REQUIRED=['result','faint']` 这两类还必须带一句 |
| 2 | 空泛鼓励 | `加油 / 别灰心 / 你已经很棒 / 再接再厉 / 下次一定 / 一定可以 / 你可以的 / 不要放弃 / 没关系的 / 放轻松` |
| 3 | 强行追问 | 问号数超过档位上限（R0/R1/R3 = 0，R2 = 1），或连续两轮都以问句结尾 |
| 4 | 水平羞辱 | `菜 / 太弱 / 你错了 / 你不行 / 水平不够 / 速度意识差` |
| 5 | 无证据的过去陈述 | 出现「记得/上次/之前/上回/我们已经/上一场/那一局/连着」时要求本机确有 `events`/`lessons`/`dialogue`；提到「速度判断」时要求 `memory.lessons` 里真有这条课程 |

另外三条可测的行为约束：

- **不因一次失败就弹话**：只有 1 连败时走 R2 具体关切（陈述那一局的真实事实），不进 R3 收尾语气；主动侧同一局最多 2 次、`result` 同局第二次不说话。
- **允许沉默**：`preference==='quiet'`、`pvp-live` 进行中、`session.dismissed`、本机无任何记录，四种情况都返回 R0（主动通道返回 `null`)。
- **旧 bug 已修**：不再无条件说「我们已经练过速度判断了」；`lessons=['灼烧追击']` 时不得出现「速度判断」，`lessons=['速度判断']` 时才允许。

---

## 6. 偏好跨局保持

`rememberPreference` 写入的三类偏好现在都会**改变输出**，且经 `readMemory` 往返后保持一致：

| 偏好 | 怎么影响输出 | 测试断言 |
|---|---|---|
| `preference: brief / detailed` | `brief` 丢掉「想回看第 N 回合说一声」这类可选动作，文本更短 | `brief.length < detailed.length`，且 `brief` 不含「说一声」 |
| `goal: 稳健 / 速攻` | 观察角度不同：稳健优先说「还剩几瓶回复药 / 几只伙伴站着」，速攻优先说「哪只在第几回合倒下」 | 两种目标下 R2 文本不相等，并各自匹配对应的真实字段 |
| `favorite: 本命宠 id` | 只在**那只宠物真的出现在那一局**时才点名，说法是「你的本命烬尾狐在第 3 回合倒下」 | 命中时说「你的本命」，换一只没在场的宠物时不说 |
| 三者合计 | 存盘 → `readMemory` → 同一句话的输出完全相同（跨局、跨刷新保持） | `stored.events.at(-1).firstFallen === last.firstFallen` 且输出文本相等 |

---

## 7. 主动通道（`coachEvent`）

- 门控不变（`src/coach/session.js:9-11`）：`isLiveMatch` / `quiet` / `dismissed` / `count>=2` 直接 `null`；非 `result` 事件两次至少隔 3 回合。
- 档位：`proactiveRegister({lossStreak})`——连败 ≥2 → **R3**，否则 **R1**（只陈述事实）。
- 措辞：`proactiveText(event, context, register)` 引用局内真实字段。实跑示例（种子 4、冠军高地、28 回合、胜利、倒下的两只分别是烬尾狐与潮甲龟、结束时剩 1 只、场上对手是潮甲龟——`coachContext` 的实测输出就是这些值）：
  - `first-faint` → `潮甲龟倒下了。还剩1只。补位不占回合，你先选。`
  - `result`（胜）→ `冠军高地28回合打完，拿下了。回营地可以继续培养。`
  - `result`（1 连败）→ `冠军高地28回合结束，失利。对手是潮甲龟。还剩1只。`
  - `result`（2 连败）→ `连着2局没赢。到这儿也行，想继续我就在。`
- **它和被动通道共用同一套档位表与克制扫描**：测试 `proactive companion cites the live match and stays silent by design` 对四条主动文本逐个跑 `checkCompanionRestraint`。

---

## 8. 仍然是设计的部分（没做的，逐条列清）

**§8.1（已修复，保留标题以示来路）曾经是：主动气泡在 UI 里不会弹出。** 当时 `notify(event)` 只有定义、没有调用处。现在它有两个调用点：`act()` 里每回合结算后的事件循环，以及第三轮的 `queueCompanionCue()`。真实游玩中的出现已被 headless Chrome 实测到（§11.6，截图在 `reports/companion/`）。

**§8.1b 仍然只是设计的两条（第三轮新增的边界）：**
- **模型改写的主动侧文案没有走克制扫描。** `checkCompanionRestraint` 只接在被动通道（`src/coach/client.js` 的 `companionRestraint`）上；左下角气泡里显示的始终是本机模板（`proactiveText`），不经模型。也就是说：主动侧的措辞目前是**写死的模板**，不是模型生成的。
- **语音没有陪练这一路。** `speakCue()` 只服务顶部条/中间提示；陪练气泡是纯文字的（`VOICE_FEATURE=false`，语音整体停用）。

**§8.2 记忆层一行没动。** 设计 §4.2 的 journal 扩展（`importance` / `poignancy` / `refs` / `lastAccess` / `supersededBy`，以及 `utterance` / `preference` / `milestone` 三类条目）、§4.3 的三因子检索打分（`0.5·recency + 0.3·importance + 0.2·relevance`，权重未标定）、§4.4 的 Reflection 合成（可否定 claim + `supersededBy`）**全部未实现**。本轮只把 `memory.events` 的字段加厚——它是对局摘要，不是玩家的经历条目，不改变这一差距。

**§8.3 「多日未登录后由陪练先开口」未实现。** 只实现了玩家先开口时把「上一次记录是 N 天前」作为一条观察；主动开场需要 §8.1 的调用点。

**§8.4 倾诉原文默认不进模型上下文：未实现。** 设计 §6 R3 的第 3 条缓解要求「倾诉原文默认不进入送给模型的上下文」。当前 `src/coach/client.js` 会把最近 8 条对话（含玩家原话）放进请求，这一条**没有对应机制**，仍标【仅设计未实现】。

**§8.5 没有服务端档位提示词。** `src/server/index.js` 的 system prompt 未改（不允许改），档位约束只能通过证据包字段与客户端事后扫描生效。

**§8.6 没有真人语言评审，也没有密度验证。** 克制扫描能拦住「说了不该说的」，拦不住「说得太频繁」。这是 R1 风险的核心，只能靠真人试玩；U07 与 T05 **都仍未勾**，本轮没有做任何真人测试，也没有据此调整任何文案。

**§8.7 `engagement` 的时间窗口未实现**（见 §2 收窄 1），需要先给 `memory.dialogue` 加时间戳。

**§8.8 模型引用更早一局的数字时会被打回。** `assembleContext` 会带最近 3 条 `memory.events` 进上下文（`src/coach/runtime.js:195`），而陪练的 `evidence` 只详细描述最近一局。因此模型若引用倒数第二局的回合数，`checkGroundedAnswer` 的 `unsupported-number` 会判它不合格并回退到本机模板。**这是保守方向的失败**（玩家看到的是可核对的模板句，不是错数字），但会让模型改写在这类追问上更常被回退。修法是把陪练用到的 `events` 也写进 `evidence`，属于下一步的事，本轮没做。

---

## 9. 怎么验证

```bash
npm test               # 全量（条数以本次运行输出为准）
npm run test:companion # 只跑陪练
node scripts/cdp-companion-presence.js --viewport=1440x900 --port=9340   # 浏览器实测，见 §11.6
```

`tests/companion.test.js` 的测试与它们覆盖的要求：

| 测试 | 覆盖 |
|---|---|
| `companion state is derived from real matches, dismissals and dialogue` | 状态派生（momentum / 连败 / consideration / engagement），原因字段带来源 |
| `register table: silence stays first and engagement never raises the ceiling` | 档位切换（含 210 种组合的表驱动、quiet 与 pvp-live 恒 R0） |
| `the register changes the wording, not only the field` | 四个档位四段不同文本 + 字数/问句上限 + 送模型的约束 |
| `templates cite the real match, the fallen pet and the opponent` | 真实事件引用（关卡、回合、倒下的宠物、对手、首次减员回合） |
| `every number the companion says is backed by its own evidence` | 每个数字都能在自己的依据里核到 |
| `restraint scan rejects the five forbidden shapes and accepts our own templates` | 克制五条（正反用例）+ 自我一致性 |
| `one loss never becomes comfort, and silence stays a real output` | 一次失败不出安慰、静默可用、旧「速度判断」bug 已修 |
| `player preferences survive matches and change the reply` | 偏好跨局保持（brief/detailed、稳健/速攻、本命、存档往返） |
| `runCoach routes to the companion and hands the register to the model` | 路由到陪练、档位与约束真的送达模型 |
| `a model reply that breaks the register falls back to the recorded template` | 模型越界 → 回退本机模板（端到端，mock fetch） |
| `proactive companion cites the live match and stays silent by design` | 主动侧真实事实引用 + 全部门控 + 克制扫描 |
| `companion facts degrade to null instead of default values` | 旧存档降级：缺字段就少说，不补默认值 |
| ★ `each companion event fires once per match, and stops when the facts stop` | 7 个事件各自的「本局只报一次」、里程碑优先于普通结算、一次调用最多一个事件 |
| ★ `the companion speaks on real in-match events, and every line cites the fact behind it` | 四类局内事件各有真实对局夹具，文本必须出现那条事实本身；缺 `signals` 一律 `null`；已结束的对局不再产生局内事件 |
| ★ `the companion budget is its own: the strategist going quiet never silences it, and the other way round` | 两份记账互不影响；安静档 / 点掉 / pvp-live 压过一切；近 7 天关闭 2 次 → 1 次、4 次 → 0 次 |
| ★ `one companion line at a time, and never at the same moment as the strategist bar` | `companionCueSlot` 的 show / hold / drop、排队超时、最小显示窗口 |
| ★ `the bubble stays as long as the words need, and wears an existing pet portrait` | 时长公式（40 字 → 27 秒、10 字 → 18 秒）、位置常量、头像取自 `SPECIES` |

`tests/browser.test.js` 另加 1 条★：静态检查 `src/client/app.js` 是否真的接上了在场层（`companionSession` / `queueCompanionCue` / `flushCompanionCue` / `yieldCompanionCue` / `placeCompanionBubble` / `bubbleDurationMs` / `companionCueSlot`），以及 `strategistCue` 不再往陪练气泡里写正文、军师开口时陪练必须让位、悬停必须暂停计时、安静档必须立刻收起气泡。

**测试数据不是手写的**：每一局都由引擎真实跑出来（随机出招必输、按枚举推荐出招会赢），测试里的期望值直接从 `game` 对象推导（`loss.player.pets.filter(p=>p.hp<=0).map(p=>p.name)`），因此「引用真实事件」这件事是被比对验证的，不是断言一句写死的文案。

---

## 10. 为什么 T05 仍然不勾

T05 的验收口径包含**真人语言评审**（U07：具体、自然、无水平羞辱；不空泛安慰、不强行提问；使用者觉得烦时降低打扰），本轮只有自动测试；而主动通道的调用点后来补上了（见 §8.1 的就地更正），但本轮仍无真人语言评审。两项都写在 `docs/CHECKLIST.md` 的 T05 注释里，**勾选状态没有改动**。

---

## 11. 第三轮：在场方式与人格（2026-09-17）

### 11.1 触发事件：从 2 个到 7 个，每一个都读真实回合记录

上一版的问题不是门控太紧，而是**没有事件可报**：`coachEvent` 只认 `first-faint` 与 `result`，一局最多说两次——那是赛后评论员，不是陪练。第三轮补的五类事件全部从 `game.history` 的真实回合记录里读出来（`companionSignals()`，纯函数）：

| 事件 | 成立条件（可核对） | 读的是哪个字段 |
|---|---|---|
| `countered` | 末尾连续 ≥2 回合，对手当时在场那只是一直克制我方当时在场那只是一方 | `history[].before` 双方 active 宠物的 `type` + `src/game/engine.js` 的 `multiplier()` |
| `repeat-skill` | 末尾连续 ≥3 回合玩家用的是同一个技能 | `history[].action.id` |
| `swing` | 我方血量占比从 ≥60% 掉到 ≤40%（或反向），且至少 4 个回合 | `history[].after` 双方全部宠物的 `hp/maxHp` |
| `stalemate` | ≥8 回合，双方一只都没倒下 | 同上 |
| `streak-win` / `streak-loss` | 结算时连胜 ≥2 / 连败 ≥3（跨局计数） | `memory.events` 的末尾连续结果（`src/coach/session.js` 的 `coachContext(game,profile,memory)`） |

判定顺序就是优先级，且**一次调用最多返回一个事件**（`swing` > `countered` > `repeat-skill` > `stalemate`；`first-faint` 优先于全部局内事件；结算事件优先于一切）。同一事件本局只报一次。

措辞模板只引用让它成立的那条事实，例如（真实对局实测输出）：
- `countered` → `潮甲龟连着2个回合被草系按着打，我看得有点急。`
- `repeat-skill` → `又是疾爪，连着3个回合了——我在旁边都跟着念出来。`
- `swing` → `打到第8回合，血线反过来了：前面一直是你占上风。`
- `stalemate` → `9个回合过去，两边都还没人倒下，我都有点坐不住了。`

> **上面四句是第三轮的原句，四条现在全部被拦**：前两条撞 `SCREEN_ECHO` 与 `SELF_CENTERED_EMOTION`，后两条一条复述屏幕、一条播报自己。它们保留在这里只作反例，当前的真实输出见 §12.4 与 `report/sections/02-delivery.tex`。

**读不到事实就不说**：`proactiveText` 对这四个事件都要求 `context.signals` 里那一项存在，缺了就返回 `null`（测试 `the companion speaks on real in-match events…` 逐个断言文本里出现那条事实本身，并断言空 `signals` 时全部返回 `null`）。

### 11.2 出现方式：左下角一个人，与军师条分开

| | 军师 / 老师 | 陪练 |
|---|---|---|
| 位置 | 顶部条 `#live-coach` 一句短话 + 「看看原因」 | 左下角 `#coach-bubble`，离底/离左 14px |
| 形态 | 一条提示 | **一个人**：头像（`SPECIES` 的 `icon`，芽角鹿 🦌）+ 名字「小芽 · 陪练」+ 2–3 行正文 + 「跟它聊两句」 |
| 时长 | 短；同一条内容停留超过 `LIVE_COACH_MS`(17s) 自动收起 | **按时长算**：`bubbleDurationMs = 15000 + ⌊字数/10⌋×3000`（40 字 ≈ 27 秒，10 字 ≈ 18 秒） |
| 关闭 | 「×」按角色记账 | 「×」= 本局不再让陪练插话（角色自己的静音；全局静音仍在中间提示的「×」与安静档） |

- **悬停暂停**：指针停在气泡上就清掉计时器，移开后用剩余时间重新计时（正在读就不该消失）。
- **下一条替换上一条**：队列里只保留最新的一条，不会在角上摞一叠。
- **位置是量出来的**，不是写死的：`placeCompanionBubble()` 先试左下角，若与受保护区域（`#actions` 技能区、`#tabs`、`#panel-enemy` 对方面板、`#player-coach`/`#enemy-coach` 底部教练条、`#live-coach`、`#attention-cue`）相交就退到右下角；气泡可见时每秒复量一次，结算面板改变版面也能自己挪开。

### 11.3 不同时出现：一条判定，三处执行

判定只有一处——`src/coach/companion.js` 的 `companionCueSlot({barVisible,queuedAt,now,holdUntil})`，返回 `show` / `hold` / `drop`：

1. **排队超时**：排队超过 `maxWaitMs`(20s) 直接丢掉（补一句过期的话不如不说）。
2. **让位**：军师/老师正在说话（顶部条 **或** 中间那条 `#attention-cue`）→ 陪练排队，条收起来再补上。
3. **不被切碎**：刚显示过的 `minVisibleMs`(5s) 内不重开；`strategistHintsAllowed()` 在这段时间里也不放行军师——触发的判定照常，只是**晚一点说**。
4. 军师/老师要开口时（`strategistCue`、`showTacticalCue`、`showWatchCue`、`showMatchReview`）会调用 `yieldCompanionCue()`：正在显示的那一句回队列（排队时间从它**第一次**排上算起），等条收起来再说。

`updateCoach` 里那句 `LIVE_COACH_MS` 超时不是装饰：顶部条原先一旦出现就会一直挂在页面上，而「两者不同时出现」于是变成「陪练永远别说话」。同一条理由停够 17 秒就自己收起来，新的理由会换 key、照常出现——**这条超时是陪练能在场的前提**。

### 11.4 人格：情绪要有落点，硬线一条不放

这一节的原稿写的是「按声线放开第一人称情绪」。**那个口径已经作废**，当前实现是：情绪可以有，但必须落在真实事件上，**第一人称感受一律拦**（`SELF_CENTERED_EMOTION`）。理由是原句本身——「我看得有点急」讲的是陪练自己的情绪，把玩家变成了来看 AI 着急的旁观者。

| 写什么 | 判定 |
|---|---|
| 「比上一局多撑了 1 个回合，最后还是没翻过来，可惜。」 | 合规：情绪落在一条真实读数上 |
| 「第 15 回合收掉，这一局拿得漂亮。」 | 合规：同上 |
| 「我看得有点急。」 | 违规 `self-centered-affect`：第一人称 + 情绪词 |
| 「可惜。」（不带任何数字或名字） | 违规 `affect-without-anchor`：情绪空降 |
| 结算与首次减员**没有**情绪句 | 违规 `no-grounded-affect`：这两类由 `STANCE_REQUIRED` 要求必须有 |

无条件拦下的四条硬线：

| 代码 | 拦什么 | 与「吐槽」的分界 |
|---|---|---|
| `empty-encouragement` | 加油 / 别灰心 / 你已经很棒 / 没关系的 / 放轻松… | 安慰必须挂在真实事件上 |
| `preach`（本轮新增） | 你应该 / 你必须 / 你最好 / 下次别 / 要记住 / 不该… | 说的是「以后你要怎样」就拦 |
| `tactical-overreach`（本轮新增） | 建议你换 / 不如 / 最好… / 换上 / 改用 / 别用 / 先出… | 战术指令是军师的活，陪练只评论 |
| `skill-insult` | 菜 / 太弱 / 你不行 / 水平不够 / 手残 / 瞎打… | **对局面和选择的判断**可以，**评价玩家水平**不行 |

允许/拒绝的对照示例见上表；测试 `restraint scan keeps the hard lines and blocks self-reported feelings` 逐条断言 `reasons`，另有 `checkCompanionStance` 的锚点用例。

`replyConstraints()` 跟着是同一件事：`forbid` 换成「复述屏幕上已经写着的事 / 播报自己的情绪 / 空泛安慰 / 评价玩家水平 / 说教 / 战术指挥」，`allow` 列出「对真实事件的情绪（必须落在具体回合、数字或记录上）」与「跨局记录与偏好」——送模型的约束与事后扫描必须说同一句话，否则模型会一直被回退。

### 11.5 频率预算：两份独立的记账

| | 军师 / 老师 | 陪练 |
|---|---|---|
| 记账对象 | `strategistSession()` + `attention`（`shouldNudge`） | `companionSession(memory)` |
| 每局上限 | 3 次（含老师的长停留讲解） | 4 次；近 7 天被主动关掉 2 次 → 1 次、4 次 → 0 次 |
| 冷却 | 60 秒 + 同回合一次 + 同理由不重复 | 两次开口至少隔 2 个回合（结算与里程碑不受限） |
| 会话内去重 | `said` 里按 reason / lesson / turn | `said` 里按事件名，同一事件本局只报一次 |

**两边不共用任何一个字段**：测试 `the companion budget is its own…` 把军师推到「3 次用完 + 本局被点掉 + 整局静音」之后断言陪练照常开口，再把陪练推到上限后断言军师的 `fall` 触发仍然成立。

**优先级不被任何推断覆盖**：`coachEvent` 的判定顺序是 `isLiveMatch` → 安静档 → `session.dismissed`（点掉即静音）→ 次数上限 → 事件去重 → 回合冷却。近 7 天的关闭记录只用来**降低**上限，永远排在安静档与点掉之后（测试对四种事件逐个断言 quiet / dismissed / pvp-live 一律返回 `null`）。

### 11.6 浏览器实测（headless Chrome + CDP）

`scripts/cdp-companion-presence.js`：真实打开 `http://127.0.0.1:8765/`、真实点击打完一局（`Page.bringToFront`；端口 9340+，不碰用户的 9333），逐回合记录气泡几何、与控制台报错。

| 检查项 | 1440×900（PVE，默认种子，26 次行动） | 1280×800（22 次行动） |
|---|---|---|
| 气泡真的出现 | ✅ 3 条，来自 3 个不同事件：`repeat-skill` / `countered` / `swing` | ✅ 2 条：`repeat-skill` / `swing` |
| 头像与名字 | ✅ `🦌` + 「小芽 · 陪练」 | ✅ 同 |
| 位置 | ✅ 左下角 `x=14, y=769, 360×117` | ⚠️ 退到右下角 `x=906, y=669`——800px 高的窗口里左下角被操作区占住，按 §11.2 的规则让位 |
| 不遮挡技能区 / 对方面板 / 底部教练条 | ✅ 全部采样的 `skillArea` / `enemyPanel` / `sideCoach` 均为 `false`，命中测试落在气泡自身 | ✅ 同上（两个视口合计 0 次相交） |
| 与军师条不同时出现 | ✅ `simultaneous = 0` | ✅ `simultaneous = 0` |
| 每句实际停留 | ✅ 7.8s / 5.3s / 9.6s | ✅ 8.9s / 8.4s |
| 悬停暂停 | ✅ 指针停在气泡上 3 秒后仍在，文本未变 | ✅ 同 |
| 控制台 | ✅ 唯一一条是既有的 `favicon.ico` 404，与本次改动无关 | ✅ 同 |

截图：`reports/companion/bubble-1.png`、`bubble-2.png`、`bubble-3.png`、`final.png`；逐回合数据 `reports/companion/companion-presence-1440x900.json` 与 `…-1280x800.json`。

**测出来的两件事比预期重要**：① 顶部条原先一旦出现就会一直挂着（`strategistPanel` 会被每个回合重绘），所以「不同时出现」如果不配一条顶部条超时，实际效果是「陪练永远别说话」——`LIVE_COACH_MS` 是这一轮的必需品，不是优化；② 没有 `minVisibleMs` 的保留窗口时，陪练的气泡会被军师的下一句话切到 **0.1 秒**（实测到过 `ms:119`），那比不说更烦。

### 11.7 这一轮仍然没做的

- **主动侧的文案没有模型参与**（见 §8.1b）：气泡里是本机模板，不走 `/api/coach`，也没有生成后的克制扫描。
- **「连续被克」「连着用同一招」的窗口是固定长度**（2 回合 / 3 回合），没有按难度或玩家习惯自适应。
- **没有真人试玩**：时长公式（15 秒 + 每 10 字 3 秒）是从阅读速度推的，没有真人测过「27 秒是不是仍然偏长」。
- **`docs/CHECKLIST.md` 的勾选状态没有改动**，T05 与 U07 仍然未勾：这一轮补的是机制与自动测试，不是真人语言评审。

---

## 12. 第四轮：陪练重做——从「播报发生了什么事」改成「说玩家算不出来的事」（2026-09-17）

> **这一轮之后还有一次修改，见 §13。** 本节里「第一人称情绪从『允许』改成硬线：两种声线下都拦」这句已被 §13 取代：情绪现在可以说，但必须落在真实事件上。其余内容（跨局账本、信息量自检、话题记账、气泡几何）仍然成立。

### 12.1 为什么重做

上一版的主动侧是「事件 → 一句话」：引擎里发生了什么，陪练把那件事换个人称说一遍。实测输出里最典型的一句是：

> 「潮甲龟连着 2 个回合被草系按着打，我看得有点急。」

它有三个毛病，也就是这一轮重做的全部理由：**① 复述屏幕**——「被草系按着打」是玩家正在经历的事；**② 方向反了**——「我看得有点急」讲的是陪练自己的情绪，共情是理解对方的处境，不是播报自己的情绪，这句话把玩家变成了旁观者；**③ 太短**——一句话说完，没有任何玩家不知道的信息。用户的原话是「说句废话就是陪伴了？」，判定不合格。

### 12.2 新设计：跨局账本 → 观察 → 档位

- **`companionLedger(memory, game, now)`（新增）**：把 `memory.events` 里最多 12 局真实记录汇成一份跨局账本。陪练唯一不可替代的能力是「记得你」——军师只看当前局面、老师只看知识点。
- **`companionReadings({cross, signals, context})`（新增）**：每条观察 = 2–3 句真话，每句自带 `kind`（`memory` 跨局记录 / `derived` 跨回合统计 / `situation` 处境 / `presence` 陪坐）与来源。优先级 + goal 加权排序，一条观察最多三句。
- **`companionSignals(game)`（重写）**：从 `game.history` 的回合事件里统计打出去多少、挨了多少、伤害落在谁身上、谁连着几回合没输出、对面回了多少血——这些数字屏幕上没有。
- **`checkCompanionInformation(text,{parts})`（新增自检）**：至少一句跨局或跨回合信息、至多一句纯处境、2–3 句；复述屏幕（`SCREEN_ECHO`）、播报情绪（`FIRST_PERSON_EMOTION` / `SELF_FOCUS`）、空泛安慰一律不合格。**说不出来就不说**（`proactiveReading` 返回 null）。
- **话题记账**：`session.topics` + `reading.extraTopics`。同一件事一局只说一次——「最先倒下的总是它」在减员那一刻说过，第 8 回合就不会换个说法再说一遍；局内读数可以「借」一句跨局记录做锚，借过的话题同样记掉。
- **触发层与文案层共用一把尺**：`companionEvents` 用 `fitReading`（字数 + 信息量 + 克制扫描）判断「现在到底有没有话可说」，说不出来的事件根本不会占窗口。这条是实测逼出来的，见 §12.5。
- **档位与出场方式不变**：左下角气泡、头像与名字、悬停暂停、可点掉、15 秒 + 每 10 字 3 秒、与军师条不同时出现，全部沿用。字数上限提高（R1 40→72、R2 80→120、R3 30→64、R4 60→112），因为话变长了。
- **情绪必须落在事件上**：`AFFECTS` 五个词（可惜 / 漂亮 / 悬 / 憋屈 / 松口气）各绑一条真实读数，`checkCompanionStance` 检查锚点；第一人称感受在任何声线下都拦。

### 12.3 跨局观察的类别

| 类别 | 数据来源 | 实测例句 |
|---|---|---|
| 老对手（`rematch`） | `events[].enemy` 与我方当前对手的交集 | 「上一局你碰的就是这套阵容。那局打到第 14 回合失利，你先倒下的是烬尾狐。」 |
| 习惯（`hazard`） | `events[].firstFallen` + `firstLossTurn` | 「最近 3 局里，最先倒下的都是烬尾狐——最近几次在第 3 回合、第 2 回合。」 |
| 克制史（`flow`） | 对手名字 → `SPECIES.type` → `TYPES` | 「带火系的阵容，你已经输过 3 局了。这一局的对手里也有火系。」 |
| 地图账（`stage`） | `events[].stage` + 胜负 | 「青芽草地你打过 2 次，一次都没拿下来。」 |
| 节奏（`trend`） | `events[].turns`（单调才说「一局比一局」） | 「今天你打了 3 局，0 胜 3 负。不过这几局的回合数是 17、17、47，一局比一局拖得久。」 |
| 久别（`return`） | `events[].time` | 「你上次来是 6 天前，那天打了 3 局，最后一局没拿下来。」 |
| 道具习惯（`potion`） | `events[].items.potion` | 「最近 3 局你结束都还剩 3 瓶回复药。这一局到现在也一瓶没动。」 |
| 久撑（`outlast`/`longest`） | 当前回合 vs `events[].turns` | 「上一局你第 13 回合就收了，这一局已经到第 15 回合。多撑了 2 个回合。」 |
| 局内读数（`live`） | `game.history` 的回合事件 | 「对面打出的 73 点伤害全落在烬尾狐身上。烬尾狐一个人顶了 2 个回合。」「这一局你打出去 98 点伤害，自己挨了 128 点。差了 30 点，你一直在挨打。」 |

### 12.4 实测输出（headless Chrome + CDP，`scripts/cdp-companion-lines.js`）

连打 3 局（青芽草地，全败），第 4 局把已真实打完的记录时间戳前移 6 天用于触发「久别」：

```
第 1 局
  第 3 回合｜对面打出的73点伤害全落在烬尾狐身上。烬尾狐一个人顶了2个回合。
  第 9 回合｜这一局你打出去98点伤害，自己挨了128点。差了30点，你一直在挨打。
第 2 局
  第 2 回合｜上一局你碰的就是这套阵容。那局打到第14回合失利，你先倒下的是烬尾狐。
  第 7 回合｜烬尾狐这一局一个人挨了98点，是全队最多的。上一局你是第3回合掉的第一只，这一局是第5回合。
  第14 回合｜这一局你打出去124点伤害，自己挨了141点。差了17点，你一直在挨打。
第 3 局
  第 2 回合｜上一局你碰的就是这套阵容。那局打到第14回合失利，你先倒下的是烬尾狐。
  第 8 回合｜带火系的阵容，你已经输过2局了。这一局的对手里也有火系。
  第14 回合｜青芽草地你打过2次，一次都没拿下来。今天在这里打到第14回合失利。
  第14 回合｜连着3局没赢。这一局你打出去235点伤害，自己挨了332点。到这儿也行，想继续我就在。
第 4 局（时间戳前移 6 天）
  第 2 回合｜你上次来是6天前，那天打了3局，最后一局没拿下来。那天0胜3负。
  第 7 回合｜上一局你碰的就是这套阵容。……
  第15 回合｜带火系的阵容，你已经输过3局了。这一局的对手里也有火系。
  第15 回合｜连着4局没赢。这一局撑到第15回合结束，比上一局多撑了1个回合。到这儿也行，想继续我就在。
```

控制台 0 报错；完整数据 `reports/companion-lines.json`。

### 12.5 这一轮真正抓到的两个 bug（都是实测抓的，不是想出来的）

1. **「提议得出来、但一句都发不出来」**：`soak` 的措辞里有「换人也没换掉这个局面」，撞上 `TACTICAL_OVERREACH` 的 `换(掉|上|成)`，于是每个回合都提议 `live`、每一次都被内容检查退回，一局只说了两次话，而自动测试全绿。修法有两处：把那句话改成可核对的数字（「挨的比另外两只加起来还多」），并把「能不能说」抽成 `fitReading`，触发层与发布层共用——`tests/companion.test.js` 里那条「every reading the trigger proposes can actually be said out loud」守住它。
2. **没说出来也算说过**：`src/client/app.js` 里有一句「有伙伴倒下就把 `first-faint` 标记成已说」，它会把因为冷却没轮上的减员观察直接烧掉。现在改成「没说出来就不算说过」，下个回合还在的话补上。
3. 顺带修掉的同类问题：soak 与减员那句重复说「伤害都落在它身上」（话题 `damage-focus`）、结算与交换比重复（话题 `damage-trade`）、老对手与习惯重复说「最先倒下的是谁」（话题 `first-fallen`）。

### 12.6 仍然不够的

- **句式会重复**：数字每局都是新的，但「这一局你打出去 X 点，自己挨了 Y 点」这个句型在多局里反复出现。信息不重复，读起来仍然单调。
- **顶部条压住收尾**：结算那句要等 `LIVE_COACH_MS`（17 秒）本局回顾收起来才轮到陪练，急着点「返回营地」就看不到它（CDP 脚本因此要等 19 秒）。
- **播放侧仍然是本机模板**（不走模型），所以模型路径只影响聊天通道。
- **没有真人语言评审**：`docs/CHECKLIST.md` 的 T05 / U07 仍未勾，这一轮给的是机制、自动测试与浏览器实测输出，不是真人试玩结论。

---

## 13. 当前这一版：把情绪做回来，但要求有落点（grounded affect）

### 13.1 为什么再改一次

§12 那一版把「复述屏幕」和「第一人称情绪」一起禁掉了。第一条禁得对——「被草系按着打」是玩家看得见的事；第二条禁过头了：题目要求陪练「能闲聊、有情绪、记得历史与偏好」，全禁之后只剩统计播报，「有情绪」这一项变成了 0。

真正的界线不是「能不能有情绪」，而是**情绪落在谁身上**：

- 落在**事件 / 玩家处境**上 → 合规；
- 落在**陪练自己**身上 → 违规（「我看得有点急」把玩家变成来看 AI 着急的旁观者）。

### 13.2 实现（全部在 `src/coach/companion.js`）

| 名字 | 作用 |
|---|---|
| `AFFECTS` | 五个词：`可惜 / 漂亮 / 悬 / 憋屈 / 松口气`。没有第六个，也不接受同义词替换 |
| `AFFECT_WORDS` | 上面五个词加「喘口气」的匹配正则 |
| `kind:'affect'` | 情绪是一种**独立的句子来源**，与 `memory` / `derived` 分开计数——它算情绪，不算信息，所以「至少一句跨局或跨回合信息」这条不会被它满足 |
| `STANCE_REQUIRED=['result','faint']` | 结算与首次减员这两类**必须**带一句有落点的情绪；去掉它这两类会直接说不出话（`proactiveReading` 返回 null） |
| `checkCompanionStance` | 三关：① 必须是五个词之一；② 不含第一人称感受；③ 带一个能对回同一条观察的锚点（数字，或同一句里出现过的名字），否则 `affect-without-anchor` |
| `SELF_CENTERED_EMOTION` | 第一人称 + 情绪/体感词出现在同一个分句里就拦。「急着换人」这种把「急」当状语用的写法显式排除，免得误伤 |
| `orderSentences` | 固定句序：接话 → 信息 → **情绪** → 处境。情绪句是最容易被字数上限挤掉的那一句，所以它有固定位置；只要它存在，信息句就只保留两条 |
| `checkCompanionInformation` | 新增上限：至多一句 `affect`、至多一句 `chat`；`COMPANION_KINDS` 扩到六种 |

`replyConstraints()` 同步：`forbid` 写「播报自己的情绪」，`allow` 写「对真实事件的情绪（必须落在具体回合、数字或记录上）」与「跨局记录与偏好」。送模型的约束与事后扫描必须是同一句话。

### 13.3 实测输出（引擎实跑，不是手写）

```
胜：第15回合收掉，这一局拿得漂亮。
负：连着3局没赢。比上一局多撑了1个回合，最后还是没翻过来，可惜。到这儿也行，想继续我就在。
闲聊：你好 → R1  我在——小芽，一直跟着你的那只。你打过的那2局我都留着底。
提问：我该怎么打 → R2  上一局你碰的就是这套阵容。那局打到第13回合失利，你先倒下的是烬尾狐。…
```

前两句的对局参数：冠军高地、难度 normal、引擎真实跑完。

### 13.4 这一轮仍然不够的

- **真人语言评审仍然没有**：U07 与 T05 在 `docs/CHECKLIST.md` 里**仍未勾**，本轮给的是机制与自动测试，不是试玩结论。
- **`AFFECTS` 只有五个词，句式会重复**：数字每局都是新的，但「可惜」出现的位置在多局里很像。
- **播放侧仍是本机模板**（不走模型），所以情绪句的模型路径只在聊天通道生效。
