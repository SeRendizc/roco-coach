# 陪练能力缺口审计（COMPANION GAP AUDIT）

日期：2026-09-21　状态：**只读审计，不改陪练一行**
被测对象：`src/coach/companion.js`、`src/coach/memory.js`，以及它们真实的调用方
（`src/coach/session.js`、`src/coach/runtime.js`）。
契约测试：`tests/evals/companion-contract.test.js`（新建）。

> **第 45 轮修复状态（先读这一段再看下文）**
>
> 本审计报告点名的四处缺陷已按各自的「最小修复方向」修好，并在原处标了
> 「✅ 第 45 轮已修」；逐条的改法、正向证明与**反证**见 §10。
> 改动的文件是 `src/coach/companion.js`、`src/coach/runtime.js`、
> `tests/evals/companion-contract.test.js`、`docs/roco/COMPANION-NONINTRUSION.md`；
> 下文保留的是**修复前的实测输出**，它们是这次改动的依据，
> 不要照着旧输出推断当前行为。
>
> | 缺陷 | 原来 | 现在 | 钉住它的用例 |
> |---|---|---|---|
> | §4.1 情绪话拿到纯战报 | `输了/好菜/气死/崩了/好难` 判成 emotion 却拼不出心情句 | 五个词进心情出口，回答是「接词 + 一句陪着」，无战报读数 | `companion-contract` 的「情绪词一律走心情出口…」 |
> | §2.2 情绪话被复盘路由截走 | `输了` / `别复盘了` → `route='teacher'` | 都归陪练；`输在哪` / `整局复盘一下` 仍归老师 | `companion-contract` 的「情绪与拒绝优先于复盘路由…」 |
> | §3.2 三张词表不同源 | `EMOTION_WORDS` 只对齐了 `MOOD_WORD_RE`，没有对齐测试 | 情绪字面量归一，模块加载时逐词自检（取不到词/拼不出句即抛错） | 同上 + `companion.js` 的加载期自检 |
> | §5.1 静默偏好只在主动侧生效 | `context.preference` 在聊天链路上永远是 `undefined`，闸门是死的 | `runCoach` 把档位透传下去，`quiet` 的回话是 R0 | `companion-contract` 的「静默偏好同时管住局内气泡与聊天回话」 |
>
> 同轮还修了 **§4.4 `chatStyle` 死代码**（玩家自己说过的那一份全库没人读）——
> 现在 `companion()` 只读一个 `style = f.chatStyle ?? f.preference`，
> 守卫拆开验：只留 `stated`、清空旧字段，效果必须照旧。
>
> 仍**未修**的（都属于「口径要先定 / 素材不够，不能靠加词」）：
> 情绪词表的覆盖范围（§4.1 末尾的 `打得不好`/`心态炸了`、§4.2）、
> §5.2 的 `detailed` 一半（实测与未设置逐字相同，因为真实记录里凑不出第三条观察）、
> §5.3 语音偏好没有进教练记忆、§5.4 聊天侧没有与主动侧对应的额度机制。

契约原文（逐条拆开审计）：

> 陪练**独立**处理玩家**情绪**、**语气**和**长期偏好**，避免把**战绩摘要冒充共情**，
> **学习静默/简短/语音偏好且不过度打扰**。

这份审计只做三件事：说清哪一条成立、哪一条只是部分成立、哪一条不成立，
每一条都给出文件与行号，或者给出能复现它的命令与用例。
**它不修改陪练**；发现缺陷时只写「最小修复方向」，改由上层决定。

---

## 0. 方法、以及这份审计不声称什么

- 全部结论来自对本仓库当前工作区的**直接执行**，证据脚本放在 gitignore 覆盖的
  `tmp/companion-audit/`（不入库），文中的命令可原样重跑。
- 已有预注册验收 `docs/roco/COMPANION-NONINTRUSION.md`（P1—P7）的数字，
  **一律转引**自 `reports/roco/companion-nonintrusion.json`
  （由 `scripts/roco/verify-companion-nonintrusion.mjs` 生成，
  由 `tests/evals/companion-nonintrusion.test.js` 断言）。这份审计**不做新的比率测量**，
  只核对那套判据覆盖到哪、以及同一份文档里有没有自相矛盾的数。
- 这份审计**不声称**：真人觉得不烦（那要 W5-05 盲评）、陪练文案好不好读、
  以及「没被 audit 到的打扰形式不存在」。

## 1. 五条契约的结论速览

| # | 契约条款 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 陪练独立处理玩家情绪 | **部分满足** | 模块与预算确实独立（`companion.js:2259-2274`），但真实路由里 `输了`、`别复盘了` 被 `runtime.js:38,66` 送到老师，陪练根本拿不到 |
| 2 | 语气（档位） | **部分满足** | `REGISTERS`（`companion.js:227-253`）与 `decideRegister`（`:526-551`）齐全，但意图词表 `EMOTION_WORDS`（`:255`）与实际出口词表 `MOOD_LINE`（`:1555`）不同源，同一句话被判成「情绪」却接不住 |
| 3 | 长期偏好 | **部分满足** | `memory.stated` 层可查/可纠正/可逐条删/可级联（`memory.js:242-247,457-493`），但 `facts.chatStyle`（`companion.js:475`）**全程没有任何决策读它**，`brief` 只在一个分支被用上 |
| 4 | 不把战绩摘要冒充共情 | **不满足** | 玩家说「输了／好菜／崩了／好难」时返回的是一段纯战报（`:2016-2029`），实测见 §4 |
| 5 | 学习静默/简短/语音偏好且不过度打扰 | **部分满足** | 静默偏好只在主动侧生效（`session.js:20`），聊天侧拿到的 context 里根本没有 `preference`（`runtime.js:10-27`）；语音偏好从未进入教练记忆（`app.js:1099-1101`）；不打扰在主动侧成立、且验收只覆盖主动侧（`verify-companion-nonintrusion.mjs:7`） |

---

## 2. 条款一：陪练是**独立**能力，自己处理情绪

### 2.1 成立的部分（可以钉）

陪练确实是三个角色里独立的那一个，不是军师或老师的别名：

- 自己的跨局账本：`companionLedger`（`companion.js:311-429`），读 `memory.events` 的
  成对字段（`firstFallen` + `firstLossTurn`，见 `:466-468` 的注释与实现）；
  军师只看当前局面、老师只看知识点。
- 自己的预算与冷却：`COMPANION_LIMITS`（`companion.js:2262`）+ `companionSession`
  （`:2268-2274`），与 `strategistSession` 是两个对象，注释写在 `:2259-2261`，
  由 `tests/companion.test.js:481`（`the companion budget is its own...`）守。
- 自己的档位表与克制扫描：`REGISTERS`（`:227-253`）、`checkCompanionRestraint`
  （`:2217-2250`）。

### 2.2 不成立的部分：真实路由会把情绪话截走　✅ 第 45 轮已修

**修后的行为（同一份 fixture 重跑）**：`输了` 与 `别复盘了` 都是
`route='companion'`，`输了` 拿到「输了啊——输了就输了，先不找原因。」，
`别复盘了` 拿到「好，不复盘了。」；反向对照 `输在哪` / `整局复盘一下` / `为什么输了`
仍是 `route='teacher'`。修法与判据见文末「第 45 轮修复」。以下为修复前的实测记录。

`intentOf` 自己把 `输了` 判成情绪（`companion.js:255,300`，
`EMOTION_WORDS=/烦|输了|难受|好菜|气死|崩了|不想玩|好难/`）。
但真实入口 `runCoach` 在到达陪练之前先做路由（`runtime.js:38,66,68`）：

```
38: const matchRequest=/整局|整场|上一局|一整局/...||(situational||followup)&&!!(context.battle?.result||!context.battle&&context.lastMatch);
66: if(role==='auto')route=...?'strategist':'companion';
68: packet=route==='strategist'?...:route==='teacher'?teacher(context):companion(context,next,message);
```

其中 `situational`（`runtime.js:37`）包含 `输了`／`打不过`。只要存在
`context.lastMatch` 或已结束的 `battle`，`输了` 就命中 `matchRequest` → `route='teacher'`。
`别复盘了` 命中「`/复盘|回顾/` 且没有 `回合`」同样进 `matchRequest`。

复现（本审计实际跑过，见 §7 命令）：

| 玩家原话 | `route` | 实际输出（截断） |
|---|---|---|
| `输了`（有上一局） | **teacher** | 「训练场，共13回合，失利。你出手13次。结束时还剩回复药3个。下次在伙伴进入危险血线时，先比较吃药、换宠和继续攻击…」 |
| `别复盘了`（同一次会话） | **teacher** | 同上——**一段完整复盘**，而 `memory.stated` 里 `refusal:review` 已经写下了 |
| `今天有点累` | companion | 「今天累了啊——那就先歇着，不用急着做什么。」 |
| `好烦` | companion | 「烦啊——连着3局没赢。到这儿也行，先歇会儿。」 |

第二条附带一个更重的后果：拒绝**被记录了但没有被遵守**。
`memory.js` 在路由前写入 `refusal:review`（`runtime.js:33` 调
`rememberPreference`，写入点 `memory.js:283-284`），
而 `src/coach/teacher.js` **一处都没有**引用 `playerWishes` / `stated` / `refuses`
（整文件检索为空）。陪练那一侧的 `noReview` 闸门（`companion.js:1920,1970,2163`）
根本不在处理链上，因为处理者不是陪练。

**最小修复方向（留给上层）**：路由把「玩家表达情绪」排在 `matchRequest` 之前，
或让 `reviewMatch` 读 `playerWishes(...).refusedReview` 并让位。
这两处都在 `runtime.js` / `teacher.js`，不在本次可改范围内。

**实际采用的修法（第 45 轮）**：两条都用了，而且都不靠「情绪优先」这一句笼统的话——
① `runtime.js` 的 `situational` 里删掉 `输了`（只留真正的分析问法：`输在哪`、`哪里出`、
`问题出在`、`为什么输`、`怎么办`…），于是「打完一局 + 一句情绪」不再构成复盘请求；
② 复盘请求拆成「显式」（`整局/上一局/复盘/回顾`）与「推断」（情绪或追问 + 已有对局）：
显式照旧走老师，推断要看 `playerWishes(next).refusedReview`——拒绝生效期间不再推复盘，
但玩家**再明确要**复盘时显式请求优先，改主意要照办；③ 拒绝以**整句**判（`别复盘`、
`不想复盘`、`别回顾`…），它同时挡住 `matchRequest` 与 `/复盘|回顾/` 两个分支，
避免「说了不要复盘却因为句子里有『复盘』两个字被送进复盘通道」。`teacher.js` 不必
读 `playerWishes`：拒绝已经在路由处生效，而显式请求本来就该被照办。

---

## 3. 条款二：语气（档位）

### 3.1 成立的部分

- 五档语义清楚、上限是硬约束：`R0` 安静承接 24 字、`R1` 就事论事 72、
  `R2` 具体关切 120、`R3` 收尾陪坐 64、`R4` 在场搭话 112
  （`companion.js:227-253`），并由 `fitSentences`（`:1325`）与
  `checkCompanionRestraint` 的 `over-limit`（`:2221`）双重复核。
- 档位是按玩家这句话选的纯函数：`decideRegister`（`:526-551`），
  顺序是「硬边界 → 倾诉 → 追问 → 闲聊 → 提问 → 观察」。

### 3.2 部分不成立：意图词表与实际出口词表不同源　✅ 第 45 轮已修

**修后**：`companion.js` 里情绪字面量只剩一处来源 `EMOTION_WORDS_LIST`
（`烦/输了/难受/好菜/气死/崩了/不想玩/好难`），`MOOD_WORD_RE` 与 `MOOD_LINE`
从 `EMOTION_EXTRA_WORDS` 取那五个补充词，模块加载时逐词自检：
判得成 emotion 的词必须取得到心情词、拼得出整句（`moodLine(w)` 非空、
三张文案表都有它），任何一个漏了直接抛错——**少一个词页面起不来**，
比一条运行时悄悄降级的判断更难被忽略。
⚠ 有一处**有意保留的不对称**：`累了` / `没睡好` / `状态不好` 这类状态词在心情出口里、
但不进 `EMOTION_WORDS`。它们判成 emotion 会把档位从 R1 抬到 R2、让第一轮就开始讲对局
（实测 `今天有点累` → R2 + 连败句，`tests/companion.test.js` 有 4 条用例守着）。
本节的缺口方向是「判成情绪**却接不住**」，与这一条方向相反，不要一起改。
以下为修复前的实测记录。

这是本审计认为**第二有价值**的结构性发现。同一个模块里有**三张**「玩家在说情绪」
的词表，彼此不相等：

| 词表 | 位置 | 作用 |
|---|---|---|
| `EMOTION_WORDS` | `companion.js:255` | **决定 `intent`**（`:300`）→ 决定档位 |
| `MOOD_LINE` / `MOOD_WORD_RE` | `companion.js:1547-1555,1637` | **决定接不接得住**（`moodLine`，`:1675`） |
| `MOOD_WORDS` | `memory.js:205` | 决定要不要写情绪假设 |

`EMOTION_WORDS` 里有 5 个词**不在** `MOOD_LINE` 里：`输了`、`好菜`、`气死`、
`崩了`、`好难`。于是出现「判成情绪、却接不住」：

```
intentOf('输了') === 'emotion'          // companion.js:255,300
moodWord('输了') === null               // MOOD_WORD_RE 里没有它（:1637）
```

后果不是沉默，而是**掉进观察通道**（见条款四）。
`memory.js:202-204` 的注释写着「两张表必须认到同一批词」，
但被对齐的是 `MOOD_WORDS` 与 `MOOD_WORD_RE` 这一对；`EMOTION_WORDS` 是第三张，
没有对齐测试。已有的 `tests/companion.test.js:1483` (`MOOD_CASES`) 只覆盖
`累/烦/难受/不想打/压力` 五个词——全部落在 `MOOD_LINE` 内，
所以这个缺口至今没有被任何测试碰到。

**最小修复方向**：把 `EMOTION_WORDS` 与 `MOOD_LINE`（或与 `memory.MOOD_WORDS`）
并成同一批字面量，并补一条「`EMOTION_WORDS ⊆ MOOD_LINE`」的对齐断言。

**实际采用的修法（第 45 轮）**：没有把两张表并成一张（那会把状态词误判成情绪，
见上面的不对称说明），而是①把情绪字面量收敛到 `EMOTION_WORDS_LIST` 一处；
②把缺的五个词补进 `MOOD_WORD_RE` 与三张文案表；③在 `companion.js` 里加**加载期自检**：
对 `EMOTION_WORDS_LIST` 的每一个词验 `MOOD_WORD_RE.test(w)` 与 `moodLine(w)` 非空，
不成立即 `throw`。这比断言更强——它不依赖测试被跑起来。反向对照：删掉
`MOOD_ECHO` 里的 `好难`，`import('./src/coach/companion.js')` 立刻抛
`心情文案分叉：好难 拼不出整句`；恢复后 13/13 用例全绿。

---

## 4. 条款三与四：长期偏好；不把战绩摘要冒充共情

### 4.1 缺陷一（最重）：情绪话拿到纯战报　✅ 第 45 轮已修

**修后实测（同一 fixture：记录 = 胜、胜、胜，`intent` 全部仍是 `emotion`）**：

```
"输了"  => "输了啊——输了就输了，先不找原因。"
"好菜"  => "好菜啊——谁菜不菜我不评，你先说你的。"
"气死"  => "气死了啊——气就先气着，不用马上消。"
"崩了"  => "崩了啊——崩了就崩了，先不收拾。"
"好难"  => "好难啊——难就先放着，不急着解决。"
```

五句都是「接词 + 一句陪着」，`REPORT` 判据（回合数/倒下/伤害/N胜N负）一个都不命中；
`companion-contract` 里那条用例同时断言**每个词都被原样接回**（mimic）与
**回答里没有战绩读数**，并带一条反向对照（`输在哪` 不许拿到心情句）。
以下为修复前的实测记录。

当记录不是连败（走 R2/R1）时，上表那 5 个词换回的是一段**纯战绩摘要**。
实测（`tmp/companion-audit/probe9.mjs`，记录 = 胜、胜、胜）：

```
"输了"    intent=emotion reg=R2 => "最近3局里，最先倒下的都是烬尾狐——最近几次在第2回合、第3回合、第4回合。掉人的回合从第2一路推到第4。你上一局在训练场打到第12回合，拿下了。"
"好菜"    intent=emotion reg=R2 => 同上
"崩了"    intent=emotion reg=R2 => 同上
"好难"    intent=emotion reg=R2 => 同上
"气死"    intent=emotion reg=R2 => 同上
```

这正是契约里点名要避免的那件事。成因链条可逐行指认：

1. `decideRegister` 走 `intent==='emotion'` 分支（`companion.js:535`）→ `R2`；
2. R2 那一格的顺序是 `chat → mood → social → 观察`（`:1987-2029`）；
3. `chatReply` 的第一道门（`:1838`）要求 `MOOD_LINE.test(text)` 才让开——
   对 `输了` 不成立，于是它继续往下走，但认不出任何线程（`chatThread`，`:1804-1814`）
   而返回 `null`；
4. `moodFits(mood)` 里 `mood` 来自 `moodLine`（`:1961`），对 `输了` 是 `null`；
5. 落到 `reading=pick(CLASSES)`（`:2018`）→ 一段跨局统计。

注意第 3 步的门是**逐字面量**的：`chatReply` 让开只看 `MOOD_LINE`，
不看 `intent`。所以「判成 emotion」这个结论在正文出口处被丢掉了——这就是
「两张词表不同源」在运行时的具体表现。

还有一类不经过 `EMOTION_WORDS` 的表达：`打得不好`、`心态炸了`
（`intentOf` → `other`，因为 `EMOTION_WORDS` 也不含它们）。
带记录时它们走 `R1` 的 `else if(register==='R1')`（`:1993-1996`），
同样拿到一段统计：

```
"打得不好"  intent=other reg=R1 => "最近3局里，最先倒下的都是烬尾狐——最近几次在第3回合、第4回合、第5回合。掉人的回合从第3一路推到第5。"
```

### 4.2 被误伤之前的澄清：设计上确实有一处例外，而且它成立

`MOOD_LINE` 覆盖到的词（`今天有点累`、`好烦`、`难受`、`不想玩了`、`今天没睡好`、
`我睡不着`…）**没有**这个毛病：`moodLine`（`:1675-1683`）给的是
「接词 + 一句陪着」，`chatReply` 在 `hasRecord && MOOD_LINE && intent!=='chat'`
时主动让开（`:1838`），整段不含任何事实。实测：

```
"今天有点累" => "今天累了啊——那就先歇着，不用急着做什么。"      （空账本与有记录相同）
"好烦"       => "烦啊——那就先搁着，不聊对局也行。"
"今天没睡好"  => "没睡好啊——那就先缓缓，今天不用急着做什么。"
```

所以条款四应读作：**词表内的成立、词表外的破功**。已有测试
`tests/companion.test.js:1502`（`人味②停在心情上：玩家说心情时，回答里不许出现战报`）
守的正是这一条，但它用的是 `MOOD_CASES` 那 5 个词，因此守不住破功的那一半。

**第 45 轮之后**：上面那五个词已经守住了（用例在 `companion-contract`），
但「词表外」这一半**仍然成立**——§4.1 末尾那两类表达（`打得不好`、`心态炸了`）
`intentOf` 仍是 `other`，带记录时走 R1 的统计分支，拿到的是跨局数字而不是陪伴。
这一条**故意没有一起改**：它不是「判成情绪却接不住」的同一种病，而是
**情绪词表本身的覆盖范围**问题，改它要先定「哪些话算说情绪」——
那是产品口径，得用真实玩家语料定，不能靠我在这里加词。
详见文末「仍未修」。

### 4.3 长期偏好：写入/纠正/删除这一层是真的

这一层我认为**成立**，逐项可核：

- 单一数据源：`memory.stated`，`STATED_KINDS` 七类
  （`address/favorite/chat-style/review-after-loss/milestone/goal/refusal`，`memory.js:195`）；
- 读回校验：`readStated`（`memory.js:242-247`）逐条要求 `id/kind/value/time` 且
  `kind ∈ STATED_KINDS`，值截断到 `STATED_LIMITS.value`；
- 「同一类换值」旧的让位、不留两份矛盾记忆（`memory.js:311-317`）；
- 纠正：`correctMemoryItem`（`memory.js:457-474`）只对 `stated` 开放，
  留下 `correctedAt` 与 `previous`，并调 `purgeDerived` 让旧值推出来的判断一起失效；
- 逐条删除：`deleteMemoryItem`（`memory.js:477-493`）对比前后快照，
  删不到就明说 `deleted:false`；
- 全部/分组清空：`clearMemory`（`memory.js:495-516`），并按组重算旧字段。
- 往返实测（`tmp/companion-audit/probe4.mjs`）：
  `rememberPreference(m,'记住，以后说短一点')` → `m.preference==='brief'`；
  `readMemory(JSON.stringify(m)).preference==='brief'`，`stated` 保留 `chat-style:brief`，
  `playerWishes(...).chatStyle==='brief'`；`correctMemoryItem` → `'detailed'`；
  `deleteMemoryItem` → `preference===null` 且 `stated` 为空。
  这三步也由 `tests/companion.test.js:2228,2256` 覆盖。

### 4.4 长期偏好里的一处死代码：`chatStyle` 没人读　✅ 第 45 轮已修

**修后**：`companion()` 里只留一个 `style = f.chatStyle ?? f.preference`，
各个出口都读这一个。守卫写在 `tests/evals/companion-contract.test.js` 里，
而且是**拆开验**的：只留 `memory.stated` 的 `chat-style` 条目、把旧的
`memory.preference` 清成 `null`，效果必须照旧（实测 brief 58 字 vs 未设置 73 字）。
「旧字段刚好也被 `syncKinds` 同步了」不算修好——那正是这一节描述的静默忽略。
以下为修复前的记录。

`companionFacts` 同时导出两个字段（`companion.js:472,475`）：

```
472:  preference:['brief','detailed'].includes(memory.preference)?memory.preference:null,
475:  chatStyle:wishes.chatStyle,   // ← 来自 memory.stated（更新的那一层）
```

`memory.js:342` 的 `chatStyle` 会优先取 `stated` 里的 `chat-style` 条目，
这是**更权威**的那一份（可纠正、可删除、带来源）。
但全库检索 `chatStyle` 只有两处命中：`memory.js:342`（产生）与 `companion.js:475`（搬运）。
**没有任何决策读 `f.chatStyle`**；决策读的是 `f.preference`（`:2019`），
也就是旧的 `memory.preference` 字段。当两者不一致时（例如存档只有 `stated` 而缺
`preference` 字段），真实的偏好会被静默忽略。
`tests/companion.test.js:2249` 断言了 `f.chatStyle==='brief'`——
它证明了字段被赋值，但没有证明它被**使用**。

**最小修复方向**：把 `:2019` 与 `:2093` 的 `f.preference` 换成
`f.chatStyle ?? f.preference`（或让 `companionFacts` 只暴露一个字段）。

**实际采用的修法（第 45 轮）**：在 `companion()` 里收成一个局部量
`style=['brief','detailed'].includes(f.chatStyle)?f.chatStyle:(['brief','detailed'].includes(f.preference)?f.preference:null)`，
`companionFacts` 的字段保持不变（它同时服务页面与运行时，改形状要动的地方更多）。

---

## 5. 条款四/五：静默 / 简短 / 语音偏好，以及「不过度打扰」

### 5.1 静默偏好：存在，但只在主动侧生效　✅ 第 45 轮已修

**修后**：`runCoach` 在路由之前把档位透传下去——
`context={...context,preference:context.preference??context.profile?.coach?.mode??null}`。
反向对照（`companion-contract` 里那条已改名成正向断言的用例）：
`buildContext(null, {coach:{mode:'quiet'}}, 'fox')` 的 `profile.coach.mode` 是 `'quiet'`，
跑 `runCoach` 得到 `register==='R0'`；把档位换成 `gentle`，同一句话不再是 R0。
`context.mode`（游戏模式 camp/battle）**没有被复用**，仍然与 `preference` 分开——
文档里提醒的那处同名不同物没有踩。以下为修复前的实测记录。

静默有**两个来源**，都要分开说：

1. **玩家显式设置**：`profile.coach.mode === 'quiet'`（界面选择，
   `src/client/index.html:28` 的 `#coach-mode`）。
2. **行为推断**：近 7 天主动关闭次数 → 收紧上限。判据在
   `companionSession`（`companion.js:2268-2274`）：≥2 次 → 上限 1，≥4 次 → 上限 0；
   `decideRegister` 用同一份 `journal` 算 `consideration`
   （`companion.js:505-506,533`）。

**主动侧确实拦得住**（实测 `tmp/companion-audit/probe3,5.mjs`）：

```
coachEvent('result', {...coachContext, preference:'quiet'}, session) → null      // session.js:20
companionSession(journal 有 2 次 dismiss).limit → 1；有 4 次 → 0
```

**聊天侧拿不到这个偏好**——这是本审计认为**最有价值**的发现。
聊天链路上 `companion(context, next, message)` 的 `context` 来自
`buildContext`（`runtime.js:10-27`），它的键是
`evidenceIndex,mode,focus,stageId,profile,lastMatch,evidenceRulesVersion,requestedTurn,lastTurn,battle`：
**没有 `preference`**。`runCoach` 只补了 `goal` 与 `favorite`（`runtime.js:32`）。
于是 `decideRegister` 的第一道软闸门

```
531: if(context.preference==='quiet')return {register:'R0',reason:'玩家把提示档设为安静（profile.coach.mode）'};
```

在聊天链路上**永远不会命中**（`context.preference === undefined`）。
实测：

```
buildContext(...).preference            → undefined      （profile.coach.mode 确为 'quiet'）
decideRegister({context: buildContext(...), intent:'chat', playerInitiated:true})
                                        → R1（不是 R0）
decideRegister({context:{preference:'quiet'}, ...})  → R0   （闸门本身是好的）
companion({}, m,'你好')                  → R1，"下午好——一天过了一半，我是小芽。慢慢来，不急。"
companion({preference:'quiet'}, m,'你好') → R0，"下午好——一天过了一半，我是小芽。"
```

即：**同一个「安静」设置，管得住对局里的主动气泡，管不住聊天里的回话**。
闸门写对了，但只有一条路径真的把参数送到了它面前。
（`context.mode` 是**游戏模式** `game.mode`，与教练档位同名不同物，
很容易被后来的人误当成 `preference`；这一点也值得在 `buildContext` 里写清。）

### 5.2 简短偏好：学了，但只在一个分支被咨询　🟡 第 45 轮部分修（如实记剩下的那一半）

**修后**：`brief` 仍然只在 R2 那一格能收（一条观察只讲第一句 → 两句 58 字，
未设置是三条 73 字），并且**改从玩家自己说过的那一份读**（见 §4.4）。
**没修的是 `detailed`**：R2 的默认已经是「这条观察说完 + 再讲一条别的」共三句、
带宽 120 字，而真实记录里能凑出的第三条观察在实测的几种账本形状下都不存在，
所以 `detailed` 与未设置**输出相同**。这是**素材不够，不是代码没写**——
`detailed` 现在会多讲第三类观察（上限 4 句），只是实测里没有第三类可讲。
**不许**在文档或页面上说「说多说一点会展开」；要让它真的有效，得先有更多可讲的记录，
或者改变 R2 默认的取法（那是产品口径，另开一轮）。
R1/R3 **有意不按偏好收放**：观察通道有一道「至少两句」的信息闸，再砍会整条作废、
降成 R0「我在。」（实测：把 R1 砍成一句，brief 直接掉到 R0）。
以下为修复前的记录。

- 学：`statedFromMessage`（`memory.js:275-276`，`BRIEF_LINE` 在 `:216`）→
  `stated:chat-style`，并同步旧字段 `memory.preference`（`syncKinds`，`memory.js:290`）。
- 用：**只有两处**。
  1. `companion.js:2019`（R2 那一格）：
     `f.preference==='brief' ? reading.sentences.slice(0,1) : slice(0,2)`；
  2. `runtime.js:72`：非锁定回答超过 160 字就截到 157 + `…`。

实测（`tmp/companion-audit/probe4,5.mjs`，同一提问）：

```
q="最近打得怎么样" brief → 59 字    未设置/detailed → 74 字     ← R2 生效
q="你好"          brief → 19 字    未设置       → 19 字       ← R1 不生效
q="好烦"          brief → 22 字    未设置       → 22 字       ← R3 不生效
q="随便聊聊"       brief → 19 字    未设置       → 19 字       ← R1 不生效
```

另外 `detailed` 与「未设置」的输出**完全相同**（都是 `slice(0,2)`）——
`detailed` 目前只是一个不产生任何差别的值。
结论：`简短`属于**部分满足**——被学习了，但只在 R2 一格与一个外层截断里被咨询。

**第 45 轮实测复核**（同一批账本形状，4 局 / 8 局 / 12 局三种）：
brief 58—59 字、未设置 71—73 字、`detailed` 与未设置**逐字相同**（71—73 字）。
即：`brief` 这一半坐实了，`detailed` 这一半仍然是空的。

### 5.3 语音偏好：只活在浏览器 localStorage，从未进入教练记忆

- 界面上有：`#voice-enabled` / `#voice-volume` / `#voice-pick`
  （`src/client/index.html:28`），欢迎弹窗里也有一句
  （`#welcome-voice`，`index.html:29`）。
- 存储位置：`localStorage['xiaoya-voice']`（`app.js:1101` 读、`app.js:1176` 写），
  键名 `{enabled, volume, voice}`。
- **它不在教练记忆里**：`STATED_KINDS`（`memory.js:195`）没有 voice 这一类，
  `playerWishes`（`memory.js:331-345`）不返回任何语音字段，
  `companion.js` 里没有任何一处读语音偏好。
  （`companion.js:2183` 的 `VOICES={companion,sober}` 是**叙述声线**，
  与 TTS 语音无关，只是同名。）
- 而且它当前被**硬关掉**：`const VOICE_FEATURE=false;`（`app.js:1099`），
  `app.js:1103-1108` 会把已保存的开启状态改回关闭。

所以准确的表述是：**语音「偏好」在陪练这一层不存在**——
它只作为一个浏览器本地显示设置存在，任何决策都不咨询它，并且当前恒定关闭。
契约要求「学习语音偏好」，这一条今天没有对应实现。
（在 `memory.stated` 里新增一类 kind 涉及改 `memory.js`，属上层决定。）

### 5.4 不过度打扰：主动侧成立，聊天侧没有对应机制，且验收只覆盖主动侧

主动侧的四道闸门在 `coachEvent`（`session.js:18-44`），顺序即优先级：

```
19: isLiveMatch(context) → null
20: context.preference==='quiet' → null
21: session.dismissed → null
27: session.said.has(event) → null                       （同一事件一局一次）
34: session.count >= limit → null                        （每局额度，来自 companionSession）
35: cooldownTurns 未到 → null                            （两次开口至少隔 3 回合）
```

气泡时序第五道在 `companionCueSlot`（`companion.js:2297-2321`）：
先判 `hold`（刚显示过、最短可见 5 秒），再判 `drop`（排队超 20 秒）。
`coachEvent` 同时也是**唯一**会返回「什么都不说」的那条路——
`companion()` 永不返回空消息，它在最后一定会兜到 `R0` 的「我在。」
（这一点由代码注释自己写明：`companion.js:1912-1913`）。

聊天侧**没有**额度、没有冷却、也没有把 `dismissed` 送到 `decideRegister`
（`buildContext` 不含 `dismissed`，`runtime.js:10-27`）。
这并不是说聊天侧应该被限流（玩家主动说话本来不算打扰），
但契约问的是「防止过度打扰的强制在两路径上是否同一套」，
答案是**不同一套**：主动侧五道闸门，聊天侧只剩「判出情绪 / 寒暄时不报战报」这类内容约束。

预注册验收的覆盖范围也正好只有主动侧。`docs/roco/COMPANION-NONINTRUSION.md:17-25`
第 1 节明写被测入口是**唯一**那个 `companionEvents(game, {...})`；
脚本里 3 处调用也全部是它（`scripts/roco/verify-companion-nonintrusion.mjs:44,58,124,146,171`，
文件头 `:7` 写「被测对象是真实通道 `companionEvents`」）。
所以 **P1—P7 全过 ≠ 两条路径都满足不打扰**，它只说明了主动侧。

---

## 6. 与预注册 P1—P7 的对照（数字一律转引）

来源：`reports/roco/companion-nonintrusion.json`，
生成器 `scripts/roco/verify-companion-nonintrusion.mjs`，
断言者 `tests/evals/companion-nonintrusion.test.js:26-35`。

| 判据 | 报告里的值 | 阈值 | 本审计是否同意 |
|---|---|---|---|
| P1 该沉默时沉默 | `0.9884`（该沉默 86 个窗口，实际沉默 85 个） | ≥0.90 | 同意。口径是「同一窗口重放后不再提出事件」，只测 `companionEvents` |
| P2 该说话时说话 | `1`（20 个窗口全部开口） | ≥0.80 | 同意，同上仅主动侧 |
| P3 硬边界零违反 | `0`（pvp-live / preview / dismissed / quiet-preference 四类） | =0 | 同意。注意 quiet-preference 只断言 `session.limit===0`（`companion-nonintrusion.test.js:54-56`），是**主动侧上限**，不是聊天侧的静默 |
| P4 每局上限 | `0` 次超限 | =0 | 同意，该上限由 `companionSession`（`:2268-2274`）产生 |
| P5 冷却与去重 | `0` 次重复 | =0 | 同意 |
| P6 每条话都有素材 | `0` 条无支撑 | =0 | 同意（`proactiveText` + `checkCompanionRestraint` 双关，`:2395-2407`） |
| P7 气泡时序 | `0` 次违反 | =0 | 同意。该条在 `companion.js:2300-2311` 记着第 20 轮量出的真缺陷（`hold` 原先挂在 `queuedAt` 上） |

**同一份文档里有一处自相矛盾的数**（这正是本审计要找的
「claimed but not true」）：`docs/roco/COMPANION-NONINTRUSION.md:35`
把「该沉默」窗口写成 **86** 个，同一张表的 P1 行 `:43` 却写
「**≥ 0.90**（20 个里最多 2 个开口）」。
按同一文档 `:44` 的口径（P2 是 20 个「该说话」窗口），
`:43` 括号里的「20」显然是复制 P2 那一列串行了。
`:43` 的实际含义应是「86 个里最多 8 个开口」（0.90 × 86 ≈ 77）。
报告里的 detail 用的是 86，所以**判据本身没有错，错的是预注册文档里的括注**。
（P2 的 20 没错：`reports/...json` 的 `fixture.should_speak_windows = 20`。）

---

## 7. 复现命令

```bash
# 审计证据脚本（gitignore 覆盖，不入库）
node tmp/companion-audit/probe2.mjs   # intentOf 与 EMOTION_WORDS / MOOD_LINE 的分叉
node tmp/companion-audit/probe3.mjs   # 静默偏好：buildContext 里没有 preference
node tmp/companion-audit/probe4.mjs   # brief 的写入/往返/纠正/删除，畸形值降级
node tmp/companion-audit/probe5.mjs   # mood 只在依据里；主动侧预算与冷却
node tmp/companion-audit/probe7.mjs   # role=auto 的真实路由（输了 → teacher）
node tmp/companion-audit/probe8.mjs   # 真实打完一局后：别复盘了 → 老师给复盘
node tmp/companion-audit/probe9.mjs   # 条款四的缺陷：情绪词换回纯战报

# 契约测试（新建）
env -u NODE_TEST_CONTEXT -u NODE_TEST_WORKER_ID node --test tests/evals/companion-contract.test.js

# 预注册验收（数字来源）
env -u NODE_TEST_CONTEXT -u NODE_TEST_WORKER_ID node --test tests/evals/companion-nonintrusion.test.js
```

---

## 8. 这份审计没有碰的东西（审计当时）

> 第 45 轮的修复**动了**第 2 条里列的 `src/coach/companion.js` 与
> `src/coach/runtime.js`（以及 `tests/evals/companion-contract.test.js` 的三条用例）。
> 这是审计之后、按它自己写的「最小修复方向」执行的改动，不是审计的一部分。
> 下面这段记录的是**审计当时**的边界，保留原文以便对照。



- **没有改陪练**：`src/coach/companion.js`、`src/coach/memory.js` 一个字节都没动。
- **没有改** `src/coach/session.js`、`src/coach/runtime.js`、`src/client/*`、
  `src/server/*`、`tests/companion.test.js`、`tests/evals/companion-nonintrusion.test.js`、
  `docs/roco/COMPANION-NONINTRUSION.md`、`scripts/roco/verify-companion-nonintrusion.mjs`、
  `reports/roco/companion-nonintrusion.json`。以上都只**读**。
- **没有写新测试去挂**未满足的条款：条款四与 5.1/5.2/5.3 的缺口在
  `tests/evals/companion-contract.test.js` 里按「当前行为 + TODO」记录并保持绿色。
  审计文档才是报告缺口的地方。
- **没有 git commit / git push**。

## 9. 三个最值得先动的点（按价值排序）

1. **`EMOTION_WORDS` 与 `MOOD_LINE` 不同源**（`companion.js:255` vs `:1555,1637`）
   —— 玩家说「输了／好菜／崩了」拿到纯战报。改一处词表 + 一条对齐断言即可。
2. **静默偏好没有送到聊天链路**（`runtime.js:10-27` 无 `preference`，
   `companion.js:531` 因此是死闸门）—— 同一个「安静」设置只对气泡生效。
3. **`别复盘了` 被路由进复盘通道且未被遵守**（`runtime.js:38,66,68`；
   `teacher.js` 零引用 `playerWishes`）—— 拒绝被记录了，却没有被执行。

三条**都已在第 45 轮修好**，逐条记录见下节。修完之后仍开着的是下面这几条，
按价值排序（都属于「口径要先定，不能靠加词」那一类，所以没有顺手一起改）：

1. **情绪词表的覆盖范围**（§4.1 末尾、§4.2）：`打得不好`、`心态炸了`、`不想打了`
   之外的表达仍走 R1 的统计分支。要扩词就得先定「哪些话算说情绪」，
   而这该由真实玩家语料定，不是由实现者拍脑袋加词——所以只把「判成情绪却接不住」
   这个**内部不一致**修掉，覆盖范围留给产品口径。
2. **`chatStyle` 是死代码**（§4.4）：`memory.stated` 里记了 `brief/detailed`，
   但没有一处读它来影响聊天措辞（`preference` 只管 R0 闸门与 160 字截断）。
3. **聊天侧没有与主动侧对应的额度机制**（§5.4）：主动侧有每局上限、冷却、去重；
   聊天侧只有「同一屏不重复」。
4. **语音偏好没有进教练记忆**（§5.3）：只活在浏览器 `localStorage`。

---

## 10. 第 45 轮修复（逐条：改了什么、怎么证明、怎么反证）

改动文件：`src/coach/companion.js`、`src/coach/runtime.js`、
`tests/evals/companion-contract.test.js`、`docs/roco/COMPANION-NONINTRUSION.md`（P1 口径）。
复现：`node --test tests/evals/companion-contract.test.js`（13/13）、
`node --test tests/companion.test.js`（87/87）、`npm run test:unit`（580/580）。

### 10.1 情绪话被复盘路由截走（§2.2）

- **改法**：`runtime.js` 的 `situational` 只留分析问法（新增 `ANALYSIS_ASK`，
  删掉 `输了`）；复盘请求拆成显式（`reviewRequest`）与推断（`reviewInferred`），
  推断那一支要 `!playerWishes(next).refusedReview`；新增 `refusesReview` 以**整句**
  判拒绝，同时挡住 `matchRequest` 与 `/复盘|回顾/` 分支。
- **正向证明**：`输了`/`别复盘了` → `route='companion'`；`输了` 的正文不含
  「回合/倒下/伤害/N胜N负」；`别复盘了` 的正文含「不复盘」。
- **反向对照**：`输在哪`、`整局复盘一下`、`为什么输了` 仍 `route='teacher'`；
  旧拒绝生效期间 `然后呢` 走陪练，而 `复盘一下吧`（显式改主意）仍走老师。
- **反证（把修复撤回）**：`git diff` 存盘后 `git checkout` 还原两个源文件，
  同一套用例 4 条变红（其中 3 条正是本节与 10.2 的目标行为），
  重新 `git apply` 后 13/13 绿。

### 10.2 判成情绪却接不住（§3.2 / §4.1）

- **改法**：情绪字面量收敛为 `EMOTION_WORDS_LIST` 一处；五个补充词
  （`EMOTION_EXTRA_WORDS`）进 `MOOD_WORD_RE`、`MOOD_LINE` 与三张文案表
  （`MOOD_ECHO` / `MOOD_ECHO_MORE` / `MOOD_COMPANY`），各给一句
  「接词 + 一句陪着」且**不评价玩家水平、不许劝下一局**；`companion.js` 加载时逐词自检。
- **正向证明**：五个词的回答全部无 `REPORT` 读数，且都原样接回玩家用过的词。
- **有意保留的不对称**：状态词（`累了`/`没睡好`/`状态不好`）留在心情出口、
  不进 `EMOTION_WORDS`——否则档位从 R1 抬到 R2、第一轮就讲对局
  （`tests/companion.test.js` 4 条用例实测变红，这就是没把两张表并成一张的原因）。
- **反证（拆掉自检的目标）**：删掉 `MOOD_ECHO` 里的 `好难`，
  `import('./src/coach/companion.js')` 立即抛
  `Error: 心情文案分叉：好难 拼不出整句`；恢复后 13/13 绿。

### 10.3 静默偏好没到聊天链路（§5.1）

- **改法**：`runCoach` 里 `context={...context,preference:context.preference??context.profile?.coach?.mode??null}`；
  不复用同名的 `context.mode`（那是 `game.mode`）。
- **正向证明 + 反向对照**：`quiet` → `register==='R0'`；`gentle` → 不是 R0。

### 10.4 顺带修掉的一处文档自相矛盾

`docs/roco/COMPANION-NONINTRUSION.md` 的 P1 阈值旁注原文写「20 个里最多 2 个开口」，
而同一张表的窗口数是「该沉默 86」——20 是**该说话**那一列的数。
已改为「本轮 86 个该沉默窗口里最多开口 8 个」，并写明绝对条数跟着窗口数走、
换素材要重算。
