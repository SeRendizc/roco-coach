# P1-B 只读分类：新局被上一局 `lastMatch` 抢答（31 处读点）

- 执行者：`plan00-closer` · 2026-10-01 · task-46（**只读阶段**，等 Lead 批准再改）
- 来源：跨机伙伴 lead-mac 的 P1-B（`agent-coop/verification/OPEN-ITEMS.md`，锚点 `f6fd3b4`）
- 计数复核：`companion.js` **13** · `runtime.js` **10** · `teacher.js` **3** · `xiaoya.js` **4** · `client.js` **1** = **31** ✓（另有 `toolbox.js` 2、`server/index.js` 1 不在本刀）

## 0. 结论

**必须改 9 处 · 边界待定 6 处 · 可不动 16 处**（合计 31）。

**根因 1 行**：`src/coach/runtime.js:56` 的 `buildContext` 优先序兜底 —— 当调用方**没给 `game`**（小芽面板路径）而 archive 里既有 `current`（进行中的新局）又有 `completed`（上一局）时：

```js
const source = /本局|当前.*局/.test(message) || game && !/上一局/.test(message) ? current
  : /上一局/.test(message) ? previous || (game?.result ? game : null)
  : game?.result ? game : previous || current;      // ← 这里：上一局优先
```

⇒ `context.lastMatch = summarizeMatch(source)` 拿到的是**上一局**；而 `battle: game ? {…} : null` 让下游连"当前局存在"都判不出来。

## 1. 复现（进程内，真引擎 + 真 archive 形状，只读）

夹具：`archive.current = 新局（NEW-MATCH-ID，进行中，第 2 回合）`、`archive.completed = [上一局（PREV-MATCH-ID，已结束，16 回合）]`。
命令：`node E:\roco-scratch\p46-repro4.mjs`（原始输出 `p46-repro4`）。

| 路径 | `context.lastMatch.id` | 玩家读到的（原文节选） |
|---|---|---|
| **面板** `buildContext(null, …)` 问「这一手该怎么打」 | **PREV-MATCH-ID** ✗ | 「开一局之后，我才能按当前生命、能量和队伍比较这一手。」（**未**拿上一局顶替，但也没认出 archive 里的新局） |
| **面板** 问「现在该出什么招」 | **PREV-MATCH-ID** ✗ | **「你上一局在PREV[stage]打到第16回合，没拿下来。最先倒下的是烬尾狐，第2回合。」** ← **lead-mac 报的现象，复现** |
| **面板** 问「帮我复盘」 | PREV-MATCH-ID ✗ | 上一局的整局复盘（新局明明在进行中，正文不说） |
| **面板** 问「上一局打得怎么样」 | PREV-MATCH-ID ✓ | 上一局复盘（**意图正确**，但正文不说是哪一局） |
| **训练页** `buildContext(game=新局, …)` 问「这一手该怎么打」 | NEW-MATCH-ID ✓ | 「这一回合优先考虑「潮汐重击」…」（基于当前局 ✓） |
| **训练页** 问「帮我复盘」 | NEW-MATCH-ID ✓ | 新局（尚未结束）的进行中回顾 ✓ |

⇒ 症状**只在"宿主没给 `game`、但 archive 里有进行中的 current"时出现**（小芽面板/营地页），机制就是 §0 那一行。

## 2. 31 处三桶分类

### A. 必须改（9 处）—— 违背「当前局优先」的盲取

| # | 位置 | 现读法 | 建议改法 |
|---|---|---|---|
| A1 | `runtime.js:4552` | `task==='review' ? e.matchId===p.context.lastMatch?.id : e.kind==='dismiss'` | 用**同一个判定**取 `activeMatchId`（当前局优先），不再直读 `lastMatch` |
| A2 | `runtime.js:4555` | `if(task!=='review'){delete p.context.lastMatch;…}` | 判据从"任务类型"换成"当前局是否存在"：当前局存在 ⇒ 不注入上一局（或注入但带 `matchScope:'previous'`） |
| A3 | `runtime.js:4561` | `while(bytes>budget&&p.context.lastMatch?.keyTurns?.length>1)…pop()` | 随 A1/A2 的判定一起改（裁剪对象 = 本次依据的那一局） |
| A4 | `runtime.js:4563` | `retainedEvidenceIds:[...(p.context.lastMatch?.keyTurns||[]).map(x=>x.id),…]` | 同上（"我引用了哪一局的哪些证据"必须与依据一致） |
| A5 | `companion.js:469` | `const summary=context.lastMatch&&typeof … ==='object'?context.lastMatch:null;` | 当前局存在 ⇒ `summary=null`；`lastMatch` 只在"无当前局"时参与 |
| A6 | `companion.js:483` | `source:last?'memory.events':summary?'context.lastMatch':null` | 同上（`source` 是给玩家看的依据标签，必须与真正依据一致） |
| A7 | `xiaoya.js:1141` | `if(!context.lastMatch&&Array.isArray(state.memory?.events)&&…)` | 加"无当前局"条件：`&& !context.battle && !context.currentMatch` |
| A8 | `xiaoya.js:1142` | `context.lastMatch=state.memory.events[state.memory.events.length-1]` | 补上来的那份要**标记来源**（`matchScope:'previous'`），供下游显式标注 |
| A9 | `teacher.js:267` | `const m=context.lastMatch;`（复盘入口唯一数据源） | 由调用方按判定传入"这次复盘哪一局"+ 是否上一局；`reviewMatch` 自身不再假设 |

### B. 边界待定（6 处）—— 需要判断依据，不能一刀切

| # | 位置 | 现状 | 判断依据 |
|---|---|---|---|
| B1 | `runtime.js:59` | `lastMatch:summarizeMatch(source)` + `battle:game?{…}:null` | 字段名与实际语义不符（它是"本问句依据的那一局"）。**判定函数的落点就在这里**：新增 `matchScope:'current'｜'previous'` 与 `hasCurrentMatch` |
| B2 | `runtime.js:2295` | `reviewInferred=(situational\|\|followup)&&!!(context.battle?.result\|\|!context.battle&&context.lastMatch)` | 已是"无当前局才用 lastMatch" ✓；但 `battle?.result`（当前局已结束）也推断 review ⇒ 与 A1/A2 的"当前局优先"要**同一口径**（当前局已结束 ⇒ 复盘**当前局**） |
| B3 | `runtime.js:3016` | `hasMatch=Boolean(context?.battle\|\|…\|\|context?.lastMatch\|\|…)` | 用于"没有对局就别硬复盘"的兜底 —— 合法；但应换成"当前局或上一局**任一**存在"的显式判定，避免把上一局当成可复盘对象 |
| B4 | `runtime.js:2357` | `liveId=context.battle?.id??context.lastMatch?.id??null` | **已经是"当前优先"** ✓ —— 建议把它作为**范式**：判定函数抽出后，各处照此写法 |
| B5 | `runtime.js:2712` | `matchId:context.battle?.id??context.lastMatch?.id??null` | 同 B4 ✓ |
| B6 | `client.js:25` | `(payload.context.battle?.result\|\|!payload.context.battle&&payload.context.lastMatch)&&/优化\|总结\|分析…/` | 已是"无当前局才走 lastMatch" ✓；但它与 A1/A2 若各写各的，两条路会分叉 ⇒ **并入同一个判定函数** |

### C. 可不动（16 处）—— 合法的历史读者，且都已显式标注「上一局」

| # | 位置 | 为什么合法 |
|---|---|---|
| C1–C11 | `companion.js:348, 1105, 1107, 1114, 1115, 1198, 1209, 1221, 1222, 1252, 1302` | 账本字段与**主动观察句**：正文逐字写「你上一局…」「上一局你第N回合就收了」「跨局比较：上一局第N回合…」，是**跨局对比**这一功能的正当素材 |
| C12 | `runtime.js:1485` | 纯**依据文案**（"这一份上下文里 … lastMatch 都没有 ⇒ 复盘那一族本地算不了"），不参与取数 |
| C13–C14 | `teacher.js:271, 311` | 注释 + 依据说明文案（不取数） |
| C15–C16 | `xiaoya.js:1135, 1136` | 注释（解释"复盘那一支为什么要 lastMatch"） |

## 3. 修法方案（建议）

**抽一个单一判定**（放 `src/coach/runtime.js`，与 `buildContext` 同层；导出给 `companion.js`/`teacher.js`/`client.js`/`xiaoya.js` 复用）：

```
activeMatchOf({game, archive, message}) →
  { scope:'current', match, id }        // 当前局存在（live game 或 archive.current 未结束）
| { scope:'previous', match, id }       // 只在"当前局不存在"时回落
| { scope:null, match:null, id:null }
```
规则（三条，全部可判）：
1. **当前局存在 ⇒ 只用当前局**（无论问句提不提"上一局"；提了则由"历史回顾"这一支显式请求 `scope:'previous'`）；
2. **无当前局 ⇒ 允许回落**上一局，且上下文带 `matchScope:'previous'`，**玩家可见文案必须显式标注**「这是上一局」（现在一个字都不说）；
3. **所有读点走这一个判定** —— 上面 A 桶 9 处 + B 桶 6 处（B4/B5 已是范本，改成调用它）。

**影响面（哪些玩家可见文案会变）**：
- 面板路径问「现在该出什么招/该怎么办」：从**上一局小结**变成**当前局建议**（或明确说"这一局还没开始/还没打完"）；
- 面板路径问「帮我复盘」：从"上一局的整局复盘"变成"当前局的进行中回顾"，或在无当前局时**标注**「上一局」；
- `companion.js` 的依据标签 `source`（`memory.events` / `context.lastMatch`）：当前局存在时不再指向上一局；
- 小芽主动观察句（C 桶）**不变**（它们本来就写「上一局」）—— 这条是"不许一刀切"的护栏。

## 4. 判据（两向，改后落地）

1. **①新局 + 上一局都在** ⇒ 问「这一手该怎么打」的回答**只基于当前局**，且**不出现上一局复盘内容**（用 §1 的 `NEW[…]`/`PREV[…]` 标记做判据，禁的是标记出现，不是文案逐字）；
2. **②无当前局 + 有上一局** ⇒ 允许回落，但**必须显式标注**「上一局」（判据：正文含「上一局」且依据标签为 `previous`）；
3. **变异**：把判定去掉（回到 `previous || current`）⇒ ①必红；把回落路径删掉 ⇒ ②必红（或给出明确行为变化读数：从"上一局复盘"变成"没有可复盘的记录"）。

## 5. 边界与待确认

- 本次复现是**进程内**（`runCoach` + 真 archive 形状），**没有**跑真实 UI；lead-mac 的原始 UI 路径（哪个页面、哪一句话、第几回合）我没有他的原始记录 ⇒ 若我的机制与他观察到的入口不同，请他把**入口页面 + 问句原文**给我，我按那条路再复现一次。
- 「必须改 9 处」里 **A7/A8（`xiaoya.js`）是客户端**：`src/client/xiaoya.js` 属 task-43/task-39 在飞的文件（写域警告：与 task-39 重叠）⇒ **改前需 Lead 明确放行顺序**。
- `companion.js` 属 09 的将来写域、`runtime.js` 属 05 ⇒ 按 Lead 指定顺序改，避免双写。
