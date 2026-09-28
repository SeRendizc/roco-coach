# 批次 7：D 组独立 UI / 上下文验收（task-10，只验不改）

- **验收方**：`art-finish`（独立于建设方；本轮**没有改任何 `src/**`**）
- **HEAD**：`56b668d`（工作区含其他队友未提交的 WIP；读数时 `src/client/xiaoya.js` / `box.js` / `team-workshop.js` 的 sha256 前后一致，见下）
- **实况**：8765 在跑（`serve.mjs --restart` 由别人做过，我**没重启**）；健康检查**降级**（http/data/engine/sprite 全绿，云端模型未连 ⇒ 断线档）
- **复验命令**（一条跑完四块 + 截图；自带浏览器锁与 Chrome 清理）：
  ```sh
  node reports/roco/ui-context/ui-context-acceptance.mjs
  ```
  读数 `reports/roco/ui-context/ui-context-readings.json`；截图 `docs/roco/review-2026-09-28/shots/ui-context/`
- **本次运行**：`2026-09-28T17:58:56Z → 17:59:19Z`（约 23 s，一次抢锁跑完；读数与截图都是这一次的）
- **源码快照（防"读数取在移动目标上"）**：本次运行**跑前 == 跑后**
  `team-workshop.js 426441e88971 / xiaoya.js 05dd23d4865f / box.js 73a5e027b472`
  （⚠ 说明：`team-workshop.js` 在验收期间被队友连续改了 3 次
  `4afdb1da5704 → d5371b09dcb7 → 30a6d3d306f9 → 426441e88971`；下面所有 ① 的读数都**钉在上面那次稳定窗口**上。
  最后一次稳定窗口里我还补了一条**名字↔个体 id 对照**判据——队友注释里写过真机上撞到
  「第 1 格写着『喵喵』而 instance 是 own-0004」，这条判据专门查它。）

---

## ① 六槽选中焦点 + 默认图鉴页签的行 —— **通过（钩子真带个体 id），但"消费方"仍是缺口**

**步骤**：`roco.html` → 等 `#team-workshop >>> #tw-cand-list .tw-row` → 读默认页签与每行的
`data-tw-instance` → 对 3 行「持有」候选各派发一次**真键鼠点击**（CDP `Input.dispatchMouseEvent`）
→ 每次读 `#team-workshop` 的 `data-tw-selected/`data-tw-filled`` 与每格 `.tw-slot[data-tw-slot-instance]`
→ 再走第二条真实路径 `roco.html?team=own-0001`（盒子「带上它去配队」那条交接）。

**期望**：默认「全图鉴」页签里**拥有**的行带非空 `own-XXXX`；点行之后六槽对应格带同一 id；交接路径同样带。

**实际（读数）**：

| 量 | 读数 | 判定 |
|---|---|---|
| 默认页签 | `scopeAll=aria-pressed:true`、`scopeMine:false`（全图鉴确实是默认档） | ✔ |
| 候选行 | 10 行、**10 行都是 `held` 且 `data-tw-instance` 非空**（喵喵=own-0001 / 水蓝蓝=own-0002 / 火花=own-0003 / 迪莫=own-0004 …） | ✔ fix `0781ca0` 有效 |
| 未拥有的行 | 搜「星星眼」（图鉴里有、玩家没有）：**1 行、`data-tw-status="on_demand"`、`data-tw-instance=""`（空）** | ✔ 物种级就是物种级，没编个体 |
| 点 3 行候选 | `twSelected 1→2→3`、`twFilled 1→2→3`；槽 1/2/3 依次 `own-0001`/`own-0002`/`own-0003` | ✔ fix `1d54ea7` 有效，且**顺序与点击一致** |
| **名字↔id 对照**（本轮新增判据） | 槽 1「喵喵」=own-0001、槽 2「水蓝蓝」=own-0002、槽 3「火花」=own-0003 —— **逐格同名同 id** | ✔ 队友注释里那条"第 1 格写着喵喵、instance 却是 own-0004"的错位**在本次窗口里不存在** |
| 交接路径 `?team=own-0001` | `twHandoff=1`、`twSelected=1`、槽 1 = `own-0001` 且显示「喵喵」 | ✔ 第二条真实路径也带 id 且名 id 一致 |
| 页面异常 | `exceptionsDuringClicks: []` | ✔ |
| 这些点击有没有更新"小芽在看谁" | `roco.html` 上 `xiaoyaMounted: null`、`[data-xy-focus]` 计数 **0** ⇒ **这一页根本没有小芽实例** | ✖ 缺口 ①-a |

**截图**：`ui-01-workshop-focus.png`（三格已填：喵喵/水蓝蓝/火花；候选池「全图鉴 622 条 · 本页 10」）。

**①b 焦点消费方合约探针**（**合成行**，不是产品页面路径，如实标注）：在 `xiaoya.html` 里插入一个
`<button data-tw-instance="own-0004"><span class="tw-name">迪莫</span></button>` → 真键鼠点它 → 再问一句：

- 点击后**立刻**读焦点那一行：`没在看具体的某一只 —— 问"这只"我会先请你点开一只。`（`data-xy-focus=""`）
- 提问之后：`正在看：迪莫 · 性格 专注 · 4 个技能`，`data-xy-focus="own-0004"`、`live=yes` ✔

⇒ **点击监听 + 焦点 provider 这条合约是通的**（下一次提问就现算），但**焦点那一行不会在点击那一刻变**——
`notePicked()` 只把 `picked` 记下并 `notify()`，而 `notify()` 给订阅者的 context 取的是**上一次 resolve 的 `last`**。
玩家看到的是"刚点了一只，小芽还写着没在看"。

**精确缺口（①）**：
1. **①-a 工作台页面上没有小芽**：`roco.html` 不挂 `mountXiaoya`（全仓只有 `box.js:1308` 与
   `xiaoya.html` 的 `data-xiaoya-page` 两处挂载）。所以在工作台点候选/点槽位，**页面上没有任何"小芽"能知道**。
   最小复现：`roco.html` → 点任一行候选 → `document.querySelectorAll('[data-xy-focus]').length === 0`。
2. **①-b `data-tw-slot-instance` 全仓没有读取方**：`grep -rn "tw-slot-instance" src/` 只有
   `team-workshop.js` 的**写入一处（1180 行）+ 注释三处**，没有任何读取方；点六槽也不会派发 `xiaoya:focus`。
   缺口原文（coach-context 报的）是"槽位 DOM 上没有钩子"——**钩子现在有了（实测已带 id，且名 id 一致）**，
   但"点这一格 → 小芽知道"这半段还没有接线。
3. **①-c 焦点那一行滞后一拍**：见 ①b，`data-xy-focus` 只在**下一次提问**后才更新（截图/读数都在上面）。

---

## ② 默认图鉴：点卡片进详情 + 深链缺口③ —— **修好的那条通过；缺口③仍未修**

**步骤**：`box.html`（默认档，不切页签）→ 数 `#box-grid .card[data-detail]` → 真键鼠点第一张卡
→ 读 `body[data-box-view]/[data-box-pet]`、地址与详情大头像的 `naturalWidth`
→ 再对照两条深链：`?pet=pet_000012`（在第 1 页，对照）与 `?pet=pet_000112`（在第 5 页，缺口③）。

**期望**：默认档每张卡都能点进详情并画出官方立绘；深链到任意已拥有个体都该有立绘。

**实际（读数）**：

| 量 | 读数 | 判定 |
|---|---|---|
| 默认档 | `kind=catalog`、`grouped=no`、**24 张卡里 24 张带 `data-detail`** | ✔ fix `38e3a50` 有效 |
| 点第一张卡（喵喵） | `view=pet`、`boxPet=pet_000001`、地址带 `?pet=`、标题「喵喵 · 详情」、立绘 256×256 | ✔ |
| 深链对照 `?pet=pet_000012` | 标题「铠甲虫 · 详情」、`img src=…id=pet_000012…`、**256×256** | ✔ |
| 深链缺口③ `?pet=pet_000112` | 标题「雪影娃娃 · 详情」，但**根本没有 `.avatar-art`**（`imgSrc: null`、`natural 0×0`）；同一屏的技能全是「游戏数据里没有这一项」、等级「—」 | ✖ 缺口③**仍在** |

**截图**：`ui-02-box-default-detail.png`（默认档点卡进详情、有立绘）、`ui-03-deeplink-offpage.png`
（缺口③现场：头像位置是一个占位菱形，不是立绘）。

**精确缺口（②）**：
- **②-a 缺口③（我在 2026-09-29 批次里报过、至今未修）**：深链到**不在当前页**的个体时，
  二级页只从"当前已加载那一页的 rows"找卡片 ⇒ `card.group` 为空 ⇒ 大头像 `src` 变成
  `/api/roco/sprite?id=&v=default`（空 id ⇒ 404）⇒ 立绘没了，并且**等级/技能/六维的个体那一份也一起塌**
  （见截图：等级「—」、四个技能「游戏数据里没有这一项」）。
  最小复现：`box.html?pet=pet_000112`（第 5 页）对比 `box.html?pet=pet_000012`（第 1 页）。
  注：这条要改的是 `src/client/box.js` 的卡片查找（用服务端详情回执里的 `group` 兜底），**不在本轮写域**。

---

## ③ 手机 390×844：盒子列表 / 详情 / 配队 —— **通过**

**步骤**：`Emulation.setDeviceMetricsOverride{390,844,dsf:1,mobile:true}` → 三屏分别量
`documentElement.scrollWidth` vs `innerWidth`、立绘有没有撑出卡片、可点区域（`button/a/input/[role=button]`）
有没有小于 44px 的 → 各出一张截图。

**期望**：不横向溢出、立绘不撑破卡片、可点区域 ≥44px。

**实际（读数）**：

| 屏 | scrollWidth / innerWidth | 溢出 | 立绘 | 可点区域 <44px | 截图 |
|---|---|---|---|---|---|
| 盒子列表（默认档 24 张） | 390 / 390 | 无 | 24 张全解码、0 张撑出卡片 | 0 | `ui-04-mobile-box-list.png` |
| 盒子详情（点卡进二级页） | 390 / 390 | 无 | 256×256，且完整落在 `#pet-view` 内 | 0 | `ui-05-mobile-box-detail.png` |
| 配队工作台（shadow 内） | 390 / 390 | 无 | 候选行 0 行溢出容器 | 0 | `ui-06-mobile-workshop.png` |
| 补量：「我的盒子」分组档 | 390 / 390 | 无 | — | **0**（这一档也没量到小控件） | — |

**判定**：**通过**（三屏皆无横向溢出、无立绘撑破、无可点区域 <44px）。

---

## ④ 小芽回答层次 + 断线档如实性 —— **通过**（附一处正文渲染缺陷）

**步骤**：`xiaoya.html`（页面版小芽）→ 在真输入框里逐条提问、真点「发送」→ 等小芽那一条落进
`#xy-log` → 把**正文**与**依据折页**分开量（条目结构：`<div class="xy-entry"><strong>小芽</strong>正文
<details>依据…</details></div>`）→ 读状态行。

**期望**：事实问与建议问的正文**不同形、不复用**；断线档（云端未连）如实说不猜，且**不串旧语料**。

**实际（读数，5 问 5 个不同正文）**：

| 问 | 正文（逐字） | 正文字数 | 依据折页 |
|---|---|---:|---:|
| 事实问：迪莫的种族值是多少？ | 「迪莫：光系，种族值合计 582（生命 120 / 物攻 80 / 魔攻 80 / 物防 105 / 魔防 105 / 速度 92）。」 | 66 | 2 |
| 建议问：怎么培养迪莫？ | 「这一版没有加点：培养就是改性格与天分 —— 在我的盒子里按种类点开个体，每只各能刷 3 次（刷性格与刷天分分开计数）。等级与经验照常涨。」 | 68 | 1 |
| 无依据问：帮我预测下个版本会出什么新精灵 | 「这条我没依据，换个说法或点名一只精灵。」 | 19 | 0 |
| 旧语料探针：烬尾狐的种族值是多少？ | 「「烬尾狐」这一问我没核到：未知精灵名：烬尾狐。手游图鉴（622 只）里没有这个名字，我不凭印象给它编数值。」 | 53 | 0 |
| 名单问：我都有哪些精灵？ | 「你的持有总数是 542 只（这一页给了 48 只）：…（还有 36 只没列出来）。要按属性/定位筛…（名单来自精灵盒子「我的」，只读、不猜）。」 | 140 | 1 |

- **层次差异**：**长度不是判据**（事实 66 vs 建议 68，几乎一样长），**结构才是** ——
  事实问是**数据型**（点名 + 系别 + 合计 + 六维逐项）+ 2 条依据；建议问是**指示型**（这一版有没有这套机制 +
  去哪儿改）+ 1 条依据；无依据问是**一句拒答**。五条正文互不相同（`unique 5/5`）。
- **断线档如实性**：状态行写「**本地规则核验** · 依据可展开查看」；问没有依据的事就明说没依据；
  点名一个**旧语料**宠物（烬尾狐）时明确回「手游图鉴（622 只）里没有这个名字，我不凭印象给它编数值」——
  没有编数值，也没有退回那三只老版宠物。
- **不串旧语料**：在**问句里没提那些名字**的回答里，烬尾狐/潮甲龟/林鹿命中 **0** 次（`stale_corpus_leaks: []`）。
  （我第一版把"回答里出现烬尾狐"直接判成串语料，那是**误判**——玩家自己点名的探针允许回显名字，
  已改成"回显可以、必须拒答且不编数值"，并把旧语料检查限制在未点名的问句上。）

**截图**：`ui-07-xiaoya-answers.png`（含上述四条问答与「依据 / 小芽查了什么」折页）。

**精确缺口（④，渲染层，不在我写域）**：
- **④-a 回答里的加粗被拆成整行**：`src/client/style.css:576` 的 `.xy-entry strong{display:block}` 本意是
  给**角色名那一个** `<strong>小芽</strong>`，但它命中正文里所有加粗 ⇒
  `markdown()`（`src/coach/experience.js:47`）把 `**x**` 生成的 `<strong>` 也变成块级。
  实测：正文里 **3 个 `<strong>`，3 个 `computed display = block`**（样本：`没有加点` / `性格` / `天分`）；
  截图里「这一版 / 没有加点 / ：培养就是改 / 性格 / 与 / 天分」被拆成 6 行。
  最小复现：`xiaoya.html` 问「怎么培养迪莫？」→ 看那一条的换行。建议改法：`.xy-entry > strong`
  或给角色名一个类（改的是 CSS，**我没动**）。

---

## 精确缺口清单（哪条没过 / 卡在哪 / 最小复现）

| # | 缺口 | 状态 | 卡在哪 / 最小复现 |
|---|---|---|---|
| ②-a | 深链到**不在当前页**的个体没有立绘（缺口③，连带等级/技能也塌） | **未修（红）** | `src/client/box.js` 的卡片查找只用当前页 rows；`box.html?pet=pet_000112`（第 5 页）vs `?pet=pet_000012`（第 1 页） |
| ①-a | 工作台页面**没有小芽实例**，点候选/点槽位无任何"在看谁"的落点 | 未修 | `roco.html`；`document.querySelectorAll('[data-xy-focus]').length === 0`；全仓只有 `box.js` 与 `xiaoya.html` 挂 `mountXiaoya` |
| ①-b | `data-tw-slot-instance` **有写入、无读取方**（点六槽不会让小芽跟着换） | 未修 | `grep -rn "tw-slot-instance" src/` 只有 team-workshop.js:1175 一处写入 |
| ①-c | 焦点那一行**滞后一拍**：点完候选仍是"没在看"，要问下一句才更新 | 未修 | `xiaoya.html` 合成行点击后立刻读 `#xy-focus`（空）→ 提问后变 `own-0004` |
| ④-a | 回答里 `**加粗**` 被拆成整行（块级 `strong`） | 未修 | `style.css:576` + `experience.js:47`；3/3 加粗 display=block |
| — | 断线档下"事实问 vs 建议问"只在**本地规则**这一档量过 | 范围说明 | 云端模型未连（healthcheck 降级）⇒ 模型档的层次差异**本轮验不了**，不能外推 |
| — | 「未拥有行留空」第一轮没有样本 | **已补验** | 搜「星星眼」→ 1 行 `on_demand`、`data-tw-instance` 为空 ✔ |

## 中途撞到又消失的一个真缺陷（如实记录，不是我这轮修好的）

第一轮验收（01:47 前后）时，**点任意候选行直接抛异常、六槽永远空**：

```
Uncaught (in promise) ReferenceError: SHARED_LOADOUT_SLOTS is not defined
  at slotLegalityProblems (src/client/team-workshop.js:268)
  → legalityRowHtml (1013) → renderTeam (1143) → applyPayload (2116) → reload (2208) → addCandidate (2283)
```

判定依据：该标识符在 `src/` 里**6 处引用、0 处定义**；`git show HEAD:src/client/team-workshop.js` 里
**完全没有**它 ⇒ 是**工作区未提交 WIP** 引入的，而静态文件按请求读盘 ⇒ 当时 8765 服务的就是坏的那版。
我把复现单发给 Lead 之后，队友**补齐了导入**（现在 268 行附近的注释写着"定义本来就在 `loadout-store.js:26`"），
第二轮起 `exceptionsDuringClicks: []`、① 全部通过。**这一条现在不是缺口**，留档是因为它证明了
"只读 HEAD 的代码不够，得在真页面上点一次"。

## 浏览器锁 / 清理

- 按约定清了**两把陈旧锁**（`owner 78829`、`owner 86580`，两次 `kill -0` 都已失败）——都不属于任何活着的进程。
- 每次运行都自己释放锁；Chrome 在 `finally` 里 `SIGKILL`（本轮跑完 `pgrep -f 'roco-uictx-'` 为 0）。
- 全程**没有重启 8765**、没有改 `src/**`、没有改 `tests/**`、没有写别人域的 `reports/**`。
