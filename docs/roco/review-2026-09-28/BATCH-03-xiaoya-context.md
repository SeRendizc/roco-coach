# BATCH-03：小芽的当前对象 / 资料通路 / 意图分叉（P0-05 + Codex 监工第 1/2/5 条）

- 任务：共享任务板 `task-3`（P0-05「小芽不知道我在看谁」）
- 日期：2026-09-29
- 写域：`src/client/xiaoya.js`、`src/coach/client.js`、`src/coach/runtime.js`、
  `tests/roco-xiaoya-context.test.js`、`reports/roco/xiaoya-context/**`、
  `docs/roco/review-2026-09-28/BATCH-03-*.md`、`docs/roco/review-2026-09-28/shots/coach-context/**`
- 演示服务：`http://127.0.0.1:8765/`（只改 `src/**`，**没有重启服务**，页面拿到的是新代码）

---

## 一、修前 / 修后（复现：问句 + 实际回答 + 期望）

问句一律在**盒子详情页** `box.html?pet=<own-XXXX>` 的右上角小芽里打（真键鼠）。

### 1. 「我在看谁」——修前答的是**名单第一只**，不是页面上那一只

| | 问句 | 修前实际回答 | 期望 |
|---|---|---|---|
| ① | `这只是什么性格？`（页面看的是 `own-0004` 迪莫，性格「专注」） | `这条我没依据，换个说法或点名一只精灵。`（route=companion） | 逐字答出页面上的「专注」 |
| ② | `它带哪四个技能？` | `进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。`（route=strategist） | 逐字答出页面上的四个技能 |
| ③ | `迪莫是什么性格？`（点了名） | `这条我没依据，换个说法或点名一只精灵。` | 同上 |

根因（Codex P0-05 的推断，复核**成立**）：
- `xiaoya.js` 取焦点时写的是 `activeProfile.pets[0].id` —— **名单第一只**（那是 `own-0001 喵喵`）；
- 上下文里那份名单来自 `/api/roco/box?kind=mine&limit=48`，**没有培养细节**（没有性格/资质/技能），
  所以就算对象对了也答不出页面上那一栏；页面自己用的是另一条 `/api/roco/box?detail=<个体>`。

修后（真机截图 [`01-fact-short-own-0004.png`](shots/coach-context/01-fact-short-own-0004.png)）：

```
问：这只是什么性格？
答：你现在看的这一只是迪莫（Lv.60）：性格「专注」。
```

### 2. 同一焦点上的**意图分叉**（Codex 监工第 5 条）

| | 问句 | 修前 | 修后 |
|---|---|---|---|
| 事实问 | `这只是什么性格？` | 一整段当前值复述 | **短答**：`性格「专注」` |
| 建议问 | `这只适合什么性格？为什么？` | **同一整段复述**（答非所问） | 建议 + 代价 + 依据（下） |

修后建议问（真机截图 [`02-advice-vs-fact-own-0004.png`](shots/coach-context/02-advice-vs-fact-own-0004.png)）：

```
**建议**（它种族值最高的是生命 120；每条都带代价）：1. 「平和」把生命抬 +10%（374 → 401），
代价是魔攻掉 -10%（148 → 138）。 2. 「踏实」…… 3. 「沉默」……
你现在带的「专注」实际做的是：「专注」把魔攻抬 +10%（148 → 158），代价是物防掉 -10%（374 → 342）。
依据：种族值：页面「六维（60 级）」那一栏的「种族 N」；性格加成：游戏性格表
（长处初始 +10%、短处固定 −10%；这里按**零突破**算）。
```

三条硬口径：
- **当前值只能当依据**（出现在「你现在带的…」那一句），不许当答案；
- **每一条推荐都带现算的取舍**（换来什么 / 牺牲什么），不是"就用某某性格"；
- **没有登记依据的那一层如实说给不了**：资质的加成数值没有登记（页面上那句「养成效果未校准」），
  所以这一支不给"哪种资质更好"。

### 3. 同一只**刷新/回滚**之后要跟着变（Codex 监工第 2 条）

修前：`createFocusProvider` 只在**个体编号**变化时才重取详情 ⇒ 同一只刷完再问，读的还是旧那一份。

修后：失效条件 = `个体id + 培养指纹 + 刷新计数`（`coach/individuals.js` 的
`cultivationFingerprint` / `cultivationOf().revision`，由 build-snapshot 提供，**直接用、不重写**）；
培养那三栏（性格 / 六项资质 / 天分档位）改从**本机记录**读 —— 与页面上那一栏**同一份来源**
（A7 之后 `box.js` 的 `buildSnapshotOf` 就是从那里读的）。

真机剧本（每一步都核对**页面那一栏**与**小芽的回答**），截图
[`03-after-refresh-talent.png`](shots/coach-context/03-after-refresh-talent.png) /
[`04-after-refresh-nature.png`](shots/coach-context/04-after-refresh-nature.png) /
[`05-after-undo.png`](shots/coach-context/05-after-undo.png)：

| 步骤 | 页面那一栏 | 小芽的回答 | 判定 |
|---|---|---|---|
| 初始 | 性格 专注；资质 `生命 0 / 物攻 7 / …` | `性格「专注」` | ✔ |
| 点「刷新天分」 | 资质 → `生命 10 / 物攻 7 / …` | 逐字同一串（**新的**） | ✔ |
| 点「刷新性格」 | 性格 → 沉默 | `性格「沉默」` | ✔ |
| 点「回滚上一次」 | 性格 → 专注（指纹逐字回去） | `性格「专注」` | ✔ |

### 4. 历史可见 + 两个显式动作

重载后旧轮次在屏上（[`06-history-after-reload.png`](shots/coach-context/06-history-after-reload.png)）；
「新对话」只换会话（旧段落留在 `xiaoya-chats-v1` 里：`{"sessions":2,"turns":[0,14]}`）；
「清空本次对话」只清这一段，`xiaoya-memory-v1` 一个字段没动
（[`09-history-and-actions.png`](shots/coach-context/09-history-and-actions.png)）。

### 5. 跨域串味（P0-05 ④）：**没发现旧语料进来**

```
$ node reports/roco/xiaoya-context/probe-legacy-corpus.mjs
```
- 正常档与断线档（`/api/roco/box` 拿不到 ⇒ `{pets:[],unavailable:true}`）都**没有**让练习局那几只
  （`fox/turtle/deer/lion/…`，即烬尾狐/潮甲龟/林鹿）进入上下文或回答；
- 断线档上下文里的名单是**空的**，回答是「这份名单里有 0 只伙伴总数我这边看不到」（如实说看不到），
  **不退回** `pet-coach-growth-v1` 那份练习局存档；
- 唯一命中「烬尾狐」的一行是玩家**自己问句里的名字被回引**，回答是
  「手游图鉴（622 只）里没有这个名字，你的名单里也没有」——这是要的行为，不是串味。

---

## 二、改动（文件 + 为什么）

| 文件 | 改动 |
|---|---|
| `src/client/xiaoya.js` | 新增 host context provider：`focusFromUrl` / `focusSnapshotFrom` / `mergeFocusIntoProfile` / `detectFocus` / `createFocusProvider`（`getContext` / `subscribeContextChanged` / `resolve`）、焦点那一行 chip、历史重画、`新对话`/`清空本次对话`；`ask()` 不再取 `pets[0]`，改现算焦点并把它那一份挂进 `context.focusDetail` |
| `src/coach/runtime.js` | `focusAsk` / `focusIntent` / `focusFactAnswer`（短答 + 缺字段诚实降级）/ `focusAdviceAnswer`（有依据的建议）；`localFactAsk` 放行、`localFactAnswer` 按意图分叉 |
| `src/coach/client.js` | `beginNewChatSession`（连点「新对话」不许造空会话把真会话挤掉）、`clearActiveChatSession`（只清当前这一段） |
| `tests/roco-xiaoya-context.test.js` | 新建，18 条判据（焦点/同源/换一只/缺字段/意图分叉/刷新失效/历史/反漂移） |

**没有动**：`src/client/box.js`、`src/client/team-workshop.js`、`src/server/**`、`data/**`、`roco/**`、
`scripts/roco/browser-*.mjs`。跨模块只**读**它们已经画在 DOM 上的钩子
（`body[data-box-pet]`、`#pet-view`、`[data-tw-instance]`、`window.rocoDemo`）。

---

## 三、可复验命令与读数

```bash
# ① 单测（18 条；含"建议问路由"那条改钉 —— 函数对了不等于路由接上了）
node --test tests/roco-xiaoya-context.test.js          # tests 18 / pass 18 / fail 0
# 相邻几族回归（84 条）
node --test tests/roco-ask-coverage.test.js tests/roco-nature-advice.test.js tests/roco-panel-ask.test.js
# ② 真机验收（自己开无头 Chrome，打正在跑的 8765；跑前先抢 tmp/browser-lock）
node reports/roco/xiaoya-context/browser-focus-acceptance.mjs   # 判据 26/26 通过
# ③ 跨域串味复核
node reports/roco/xiaoya-context/probe-legacy-corpus.mjs
# ④ 修前形状的对照（不带 focusDetail ⇒ 仍是老行为）
node reports/roco/xiaoya-context/probe-focus.mjs http://127.0.0.1:8765 own-0004 off
```

真机验收读数（`docs/roco/review-2026-09-28/shots/coach-context/acceptance.json`）：
`①a 事实问短答：性格逐字一致` / `①c 建议问 542 字 vs 事实问 127 字` /
`②b 刷新天分之后资质与页面新那一栏逐字一致` / `②e 刷新性格之后逐字一致` /
`②i 回滚之后念回滚后那一份` / `③ 重载后历史可见` / `④a 页面上换一只焦点跟着换` / `⑥ 控制台 0 报错`。

---

## 四、精确缺口（没做到的，如实列）

1. **配队六槽 / 候选池的"选中"只有一半**：候选池点过的 `[data-tw-instance]` 这一层接了
   （`createFocusProvider().notePicked`），但**六个槽位**自己在 DOM 上没有"哪一格被选中"的钩子
   （只有 `data-tw-slot` 序号与名字）⇒ 槽位那一层接不进去。要么 `team-workshop.js` 加一个
   `data-tw-slot-instance`（写域外），要么维持现状（只有候选池算焦点）。
2. **对战场上那一只只有物种级**：引擎公开视图不给个体 id ⇒ 没有性格/资质/技能，小芽如实说
   "这一档读不到"（不许拿别的数据补）。要给到个体级，得引擎那边把个体编号进公开视图。
3. **建议只覆盖性格**：资质/技能这两层的加成效果没有登记数值，建议支**明确不给结论**；
   要做"资质该怎么刷"这类建议，先得有登记好的档位效果（数据侧）。
4. **`tests/roco-xiaoya-context.test.js` 还没进 `test:unit`**：结构契约
   「每个 Node 测试文件都必须被某个 npm script 或自检登记表引用」因此红着 —— `package.json`
   不在我的写域，已把最小改动（追加三个文件名，其中两个不是我的）报给 Lead。
5. 相邻红（**不是我引入的**，未动）：`src/client/box.js:353/362` 的玩家可见词「本仓」
   （`roco-plain-speak` ①）；`scripts/roco/battle-smoke-engine.py:597` 写死能量上限（RC-101）与
   `battle-smoke-browser.mjs` 的 `rmSync` 缺重试（两条结构契约）。

---

## 五、这一轮踩到并记下来的两个坑（给下一个人）

1. **`focusAdviceAnswer` 写对了 ≠ 玩家拿得到**：`localFactAnswer` 的**分发**漏接时，
   `runCoach` 的 try/catch 会把异常/空结果静默吃掉，页面上只看到陪练那句
   「你想问哪一段，我再说一遍。」。所以判据必须从 `runCoach` 进（`tests/…` 的 ⑨c 就是为它加的）。
2. **建议支不许用 `raceOf()`**：它走 `import('node:fs')` 读归一化图鉴 —— **浏览器里那条路是断的**
   （实测：整支抛异常 → 玩家拿到陪练句）。种族值改成读页面自己那份「六维（60 级）」的
   「种族 N」（`detail.race`），`raceOf` 只做服务端退路且必须包 try。
