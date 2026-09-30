# 半成品排查 · 前端可见面（`xiaoya-review`）

> **一句话总结**：逐页逐板块量了 **11 个状态 / 30 个板块**，**默认可见面上基本都是真读数**（不是占位/等权假设）；
> **找到 1 条确定的半成品 ⓐ**（`traitChips` 的「天分 已加成 N/3 级」**写了没人读** ⇒ 玩家看不到"加成过几级"的合计 ✗）、
> **1 条疑似 ⓓ**（同一个 `/3` 分母：它是**每轮刷新次数**、不是加成上限 ⇒ 连刷会出现 4/3；**但这条我只有源码读数、没拿到运行时报据** ✗）、
> **2 条"要逐张/逐次展开才看得到"**（工坊每张候选卡的机制行 `<details>` 默认收起 · 面板的记忆列表在二级折叠里）；
> 另外**更正一处我自己的误读**：盒子默认档是**「全图鉴」**，不是「我的盒子」。

## 0. 我审的是哪一版（纪律：读前记 hash）

| 项 | 值 |
|---|---|
| `git rev-parse HEAD` | `51c04fb1488c7c629e659d6619b094bb92c6570a` |
| `git status --short` | **200 条** · sha256 `7a94d9e8c6946a197fd2b01ad6f7c668`（**我开跑时**） |
| 服务 | **pid 1896** · `127.0.0.1:8765` · `started_at=2026-09-29T17:30:29.788Z` · configured · provider=deepseek |
| `src/client/roco.js` | `ec1dff2115` |
| `src/client/box.js` | `ee87e14c6c` |
| `src/client/box-drawer.js` | `23e31d468f` |
| `src/client/team-workshop.js` | `b5ad7be8d3` |
| `src/client/xiaoya.js` | `c7a45cb518` |
| `src/coach/individuals.js` | `3234ce44bc` |

⚠ **我写这份表的时候服务又重启了一次**（`lsof` 已是 **pid 8870**，`git status` 208 条，WIP sha256 变成 `b72df2d3a5468797`）
—— **不是我干的**（我全程只读、没重启、没提交）。**本表所有读数都来自 pid 1896 那一版**；若产品代码在那之后又改了，**这张表要重跑**。

**探针**（`tmp/`，只读）：`tmp/xy-inventory.mjs`（11 态 × 1440/390，22 张图）· `tmp/xy-narrow-drawer.mjs`（390 档专测）·
`tmp/xy-box-count.mjs`（盒子计数行）· `tmp/xy-talent-roll.mjs`（真刷天分 4 次）· `tmp/xy-talent-sample.mjs`（造样本·失败）
→ 机器可读：`reports/roco/xy-review/inventory.json`；截图：`docs/roco/review-2026-09-28/shots/xy2-2026-09-30/`。

## 1. 表（页面 | 板块 | 默认可见? | 内容是真读数? | 要几个动作 | 判定 | 优先级）

| # | 页面 · 板块 | 默认可见？（可见面读数） | 内容 | 动作数 | 判定 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `roco.html` · 工坊「队伍」`#tw-team` | ✓ 可见，1440 整块在视口 / 390 整块在视口 | 真读数：「还差 6 只」+ 6 个空槽位（空态如实） | 0 | 已完成 ✓ | — |
| 2 | `roco.html` · 工坊「候选池」`#tw-cand` | ✓ 可见（长列表 ⇒ 要滚，1440 半 / 390 半） | 真读数：542 只（能出战）· 24 张卡/页 | 0 | 已完成 ✓ | — |
| 3 | `roco.html` · 「开一局（标准 PVP · 六宠）」`#standard-pvp-bar` | ✓ 可见，两档整块在视口 | 真读数（条件说明） | 0 | 已完成 ✓ | — |
| 4 | `roco.html` · 工坊「阵容评估」抽屉 `#tw-eval-drawer` | ✓ **把手**可见（`data-open=no`）· 正文默认收 | 真读数（展开后：已选 0/6 + 候选参考 + "不是唯一答案"） | **1** | 登记（人类口径，不算半成品）✓ | — |
| 5 | `roco.html` · 工坊**四块判断** `#tw-teamplan` | ✓ 满队后抽屉里**四块全在视口**：1440 strength@145/118 · shortfalls@269/147 · priority@269/253 · playstyle@528/345（bottom **873** < 900）；390 满队：strength@145 · shortfalls@263 · priority@416 · playstyle@503/339（bottom **842** < 844） | 真读数（强度判断/两条短板/一个优先调整/基本打法，含「范围：本机训练场（没有指定对手）」） | **7**（选 6 只 + 开抽屉） | 已完成 ✓（**上次"playstyle 要滚动"已不成立** —— R03 的两栏布局真的生效了） | — |
| 6 | `roco.html` · 战斗面 `#battle-panel` | ✓ 1440 整块在视口 · ⚠ 390 档读数不实（见 §2.1） | 真读数：回合/技能/预期伤害/承伤相性 | 1（开局） | 已完成 ✓（390 待复核） | 低 |
| 7 | `roco.html` · 顶栏 `#b3-topbar` | ✓ 可见，两档整块在视口 | 真读数：回合数 + 心 | 1（开局） | 已完成 ✓ | — |
| 8 | `roco.html` · 局末卡 `#battle-result-card` | ✓ 可见，两档整块在视口 | 真读数：「我方胜 / 17 回合 / 关键转折在第 6 回合」 | 打完一局自动出现 | 已完成 ✓ | — |
| 9 | `roco.html` · 局末「**完整复盘与依据**」 | ✗ 默认**收起** | 站内真读数（展开后） | **1** | 登记（人类口径）✓ | — |
| 10 | `roco.html` · `#select-panel` / `#result-panel` / `#pool-footbar` / `#log-panel` / `#action-panel` / `#dev-zone` / `#about-drawer` | ✗ 全部 `hidden`（祖先 `display:none`） | 旧 3v3 迁移区 + 开发者抽屉 | 要 `?legacy3v3=1` / 展开 | 设计如此（未实现·不适用）✓ | — |
| 11 | `roco.html` · 小芽主动气泡 `#hint` | ✗ 隐藏（条件触发） | — | — | 设计如此（门控说话才出现）✓ | — |
| 12 | `box.html` · 标签 `nav.tabs` + 计数行 `#box-count` | ✓ 可见，两档整块在视口 | 真读数（**实测**：默认档=**全图鉴 622 项**；点「我的盒子」⇒ **542 项**） | 0（图鉴）/ **1**（我的盒子） | 已完成 ✓ | — |
| 13 | `box.html` · 卡网格 `.panel.box-main` | ✓ 可见（长列表 ⇒ 要滚） | 真读数：名字/系别/Lv.60/定位 | 0 | 已完成 ✓ | — |
| 14 | `box.html` · 种类抽屉 `.species-drawer` | ✗ 只在**我的盒子**档出现 ⇒ 先点标签 | 真读数（点组头 ⇒ 进详情「看详情›」） | **2**（标签 + 组头） | 登记 ✓ | — |
| 15 | `box.html?pet=` · 详情 `#pet-view` + 四技能 `#pet-loadout` | ✓ 可见（1440 四技能整块在视口）· `.metrics` 部分在视口（要滚） | 真读数：4 招各带**系别/类别/耗能/威力**；六维带性格 ±10%（浅黄） | 0（直达 URL） | 已完成 ✓ | — |
| 16 | `box.html` · **「天分 已加成 N/3 级」** | ~~✗ 从来没有出现在可见面上~~ ⇒ **2026-09-30 已修**：现在渲染在详情页 `#pet-traits` 那一排（`[data-pet-boost]`，插在「天分档位」与「刷新天分记录」之间 · **同一排、不新板块**） | 运行时报据：真点 1/2/3 次「刷新天分」⇒ 逐字 `已加成 1/3 → 2/3 → 3/3 级`，1440 与 390 两档 **`fullyInViewport=true`** | 0（有加成即出现） | ~~半成品 ⓐ（写了没人读）~~ ⇒ **已修 ✓**（`traitChips()` 成为活代码 · `box-drawer.js:111` 的 `/3` 改成 `import TALENT_BOOST_LIMIT`） | ~~高~~ 已关闭 |
| 17 | `box.html` · 天分刷新的「`/3`」分母 | 页面上印不出来（同上，已随第 16 行一起可见） | ~~我读到的「真上限六项各一次（可到 6）」~~ ⇒ **2026-09-30 更正**：`individuals.js:31 TALENT_BOOST_LIMIT=3` + `:386` **真值层硬闸**（`code:'boost-limit'`）⇒ `talent_boosts` **到不了 4**；运行时报据：连点到第 4 次 ⇒ 记录**停在 3**。我先前引用的是**改前**的注释 ✗ | — | ~~疑似 ⓓ~~ ⇒ **不是缺陷** ✓（分母是对的 —— `box-team-ui` 的定案经我运行时报据复核 ✓） | ~~中~~ 已关闭 |
| 18 | `workshop.html` · 工坊本体（队伍+候选池） | ✓ 1440 部分在视口（长页要滚）· 390 同 | 真读数 | 0 | 已完成 ✓ | — |
| 19 | `workshop.html` · 候选卡「特性」机制行 `.tw-mech-fold` | ✗ 每张卡是 `<details>` **默认收起**（首屏 24 张卡各要 1 次点击才看到机制原文） | 真读数（展开后是冻结文案） | **24**（每卡 1 次） | 登记（可讨论：机制是候选筛选的关键信息）⚠ | 中 |
| 20 | `workshop.html` · `#tw-plan-box`（6×4 结果区） | ✗ 隐藏（要按「小芽给一套 6×4」） | 未验（归 `team-workshop-u04`） | 1+ | 登记 | — |
| 21 | 小芽面板 · 对话区 `#xiaoya-log` / 快捷问 `#xiaoya-quick` / 输入行 `#xiaoya-form` / 模型格 `#model-chip` | ✓ 全部可见，两档整块在视口 | 真读数（开场白 + 4 个快捷问 + 「资料可用 · 云端已连接」） | **1**（点入口） | 已完成 ✓ | — |
| 22 | 小芽面板 · **记忆列表** `#memory-list` | ✗ 在二级折叠 `#xy-fold-more`（「设置」）里 ⇒ 默认**看不到"她记住了什么"** | 本次读数**空**（新 profile 无记忆） | **2**（入口 + 设置） | 登记（另一块归 `xiaoya-panel`）⚠ | 中 |

## 2. 证据与"没验到"的如实交代

### 2.1 我对自己一处读数的更正（**先怀疑自己** ✓）
- 我第一版把盒子的**默认档**写成「我的盒子」（因为 `box.html:28` 的静态 HTML 给 `#tab-mine` 带了 `class="selected"`）✗
- **实测**（`tmp/xy-box-count.mjs`，1440×900，pid 1896）：默认 `body[data-box-kind]=catalog` · `#box-count`=「全图鉴 622 项，这一页 24 项」· `.tab.selected`=`#tab-catalog`
  ⇒ **默认档是全图鉴，我的盒子要 1 个动作**。表里第 12/14 行已按实测写。
- 同理：我 390 档的读数是在**同一页面 resize** 出来的（`Emulation.setDeviceMetricsOverride`），
  390 下「评估抽屉打开后 0×0」就是**resize 造成的假象** ✗ —— 我另起一档**从 390 冷加载**重测：把手 44×132、点开后**面板 300×287 正常显示** ✓。
  ⇒ 表里 390 的结论只在**冷加载**那一档成立；`#battle-panel` 390「不在视口」这条**我标成待复核**（同一原因的嫌疑很大）。

### 2.2 第 16 行的运行时报据（这是"ⓐ"的实证）
`tmp/xy-talent-roll.mjs`：在**探针自己的 profile**（不碰玩家数据）里真点「刷新天分」3 次：
```
第 1 次 → 资质 生命 0→10 ·「刷新天分记录 还剩 2 次（性格还剩 3 次） 上一次刷天分（第 1 级）：+10 加到「生命」」
第 2 次 → 物防 10→20 ·「还剩 1 次 … 第 2 级：+10 加到「物防」」
第 3 次 → 速度 0→10 ·「还剩 3 次 … 第 3 级：+10 加到「速度」」   ← 用完最后一次**回满** ✓（源码 :432）
详情页 chips 全程 = [性格…, 资质…, 天分档位…, 刷新天分记录…] —— **没有一条含「已加成」** ✗
本机记录（localStorage `roco.box.individuals.v1`）⇒ {"n":3,"refreshes":{"talent":3},"rolls":{"talent":3},"stats":["hp","def","spe"]}
```
截图：`13-天分-3级-1440x900.png`（样本注入那轮）· `14-天分-刷第4次后-1440x900.png`。

### 2.3 第 17 行「没定案」的原因（如实报）
- 我**试图造样本**：往探针 profile 注入 `talent_boosts` = 3/4/6 级的记录 ⇒ 页面**没有采纳**（详情页仍印服务端那一份），
  截图 `13-天分-3级-1440x900.png` ⇒ **这条造样本的路走不通**（本机记录不是那样生效的）✗
- 我**试图真刷第 4 次**：点击返回 `ok:true`（按钮未 disabled），但 `talent_boosts` 仍是 3、文案仍停在「第 3 级」、
  `refreshes.talent` 仍是 3 ⇒ **我的点击很可能没落到按钮上**（页面重渲染后坐标漂了）⇒ **第 4 级我一次都没真刷出来** ✗
- ⇒ 所以第 17 行**只写成"疑似"**：源码能读到分母 ≠ 上限，但我**没有运行时报据**，**不当作结论**。

### 2.4 这次**没验到**的（照实写）
1. **天分「已加成 N/3 级」上限到几级**（第 17 行）—— 见 §2.3；
2. **390 档战斗面到底要不要滚**（第 6 行）—— 我那次是 resize 读数，不值钱；
3. `#tw-plan-box`（6×4 结果区）与 6×4 应用/撤销流程 —— 归 `team-workshop-u04`，我只登记"默认隐藏"；
4. 「本机加的」全量 0 处 —— 上次只翻到第 3 页，**不是**全 542 条逐条翻（本轮未重做）。

## 3. 建议的施工顺序（按优先级）
1. **P0**：第 16 行 —— 要么把 `traitChips` 接回可见面（列表行或详情页印「天分 已加成 N/3 级」），
   要么删掉这条死代码并把"加成合计"用别的方式给玩家（现在玩家只能看到**最后一次**刷到哪一项 ✗）；
2. **P1**：第 17 行 —— 先把分母的口径定下来（每轮刷新数？还是六项上限？），再决定印什么；
3. **P2**：第 19 行（每张候选卡的机制行默认收起）与第 22 行（记忆列表在二级折叠）—— 这两条是"人类口径 vs 信息可见性"的取舍，建议先问口径再改；
4. **P3**：第 6 行 390 档战斗面复核。

---

## 4. 2026-09-30 修复记录（P0 ⓐ 已关闭）+ 路上看到的**新**缺陷（**只报不修**）

### 4.1 改了什么（前端域，两处）
```
src/client/box-drawer.js  :13   import {REFRESH_LIMIT, TALENT_BOOST_LIMIT, …}（**不再手写 3**）
                          :106  加成 chip 加一个稳定钩子 `key:'talent-boost'`（按 key 认领，不按字面量匹配）
                                 label 改成 `${boosts.length}/${TALENT_BOOST_LIMIT} 级`
src/client/box.js         :32    import 里加 `traitChips`
                          :1027  `const boostChip = traitChips(individual).find(c => c.key==='talent-boost')`
                          :1072  插在「天分档位」与「刷新天分记录」之间 ⇒ `<div class="trait" data-pet-boost="yes">`
                                 （**同一排、不新板块**；**文案只在 `box-drawer.js` 一处产出**，这一层不抄）
```
判据：`tests/roco-box-drawer.test.js` 新增 **⑲**（有 boosts ⇒ 出现且分母 == `TALENT_BOOST_LIMIT`；
**反证**：没有 ⇒ 那一条**不存在**（不是"有但是空的"）；空记录 ⇒ 也不许凭空造；+ 接线三门：按 key 认领 / 真的画出 `[data-pet-boost]` / 文案取自 `traitChips`）。
**改前必红**：`git show HEAD:src/client/box-drawer.js | grep -c talent-boost` = **0** · `…box.js | grep -c data-pet-boost` = **0**。

### 4.2 运行时报据（真点刷新，探针自己的 profile；**不是注入样本**）
```
没刷过          ⇒ `[data-pet-boost]` **不存在** ✓（反证）
点第 1 次       ⇒ chips 逐字「天分 已加成 1/3 级」· offsetParent=true · rect 314×32 · **fullyInViewport=true**
点第 2 次       ⇒ 「天分 已加成 2/3 级」同上
点第 3 次       ⇒ 「天分 已加成 3/3 级」同上（1440×900）· 390×844 冷加载：308×32「天分 已加成 3/3 级」**fullyInViewport=true**
点第 4 次       ⇒ 本机记录**停在 3**（`talent_boosts:["hp","def","spe"]`）⇒ **硬闸真的在挡** ✓
反证（own-0005，没加成）⇒ 1440 与 390 两档都 **`exists:false`** ✓
截图：15-已加成1级-1440x900 / -390x844 · 16-已加成3级-1440x900 / -390x844 · 18-反证-…-1440x900 / -390x844
JSON：reports/roco/xy-review/boost-chip.json
```

### 4.3 ⚠ 新缺陷（**我没修，按纪律只报**）：被拒时**玩家看不到那句为什么** ✗
```
在**详情页**点「刷新天分」到顶（第 4 次）时，理由写进了 `#box-status`，逐字：
  「天分加成已经 3 级满了（一 / 二 / 三级各加一项，加过的项不会再叠）—— 这一只的资质不会因为再刷而变高」
但 `#box-status` 在 `#box-list-view` 里，而详情页把祖先设成 `display:none`：
  span#box-status  → display:block **w:0 h:0**
  section.panel.box-toolbar → w:0 h:0
  div#box-list-view → **display:none（hidden 属性也在）**
⇒ **玩家点第 4 次：屏幕上一个字都不变、也没有任何提示** ✗（成功那一路有 `#pet-view` 里的 `.pet-note-inline`，失败这一路没有）
判定：**半成品 ⓔ（只在 DOM 里、不在可见面）** · 修复成本低（把拒绝理由也画进 `#pet-view` 的刷新说明位，或让状态行在详情页可见）· 优先级 **中**
探针：tmp/xy-status-vis.mjs（读数见上）· 截图 17-第4次被拒-状态行-1440x900.png
```

### 4.4 ⓔ **已修**（2026-09-30，授权后）——「被拒时玩家看不到那句为什么」⇒ 现在看得见 ✓
```
改法（Lead 选的落点：**同一个位置**，玩家不用学两套）：
  src/client/box.js  :163   state.refreshFailed = ''（新字段：被真值层拒绝时的那句**真实原因**）
                     :1859 失败路：setStatus(result.reason) —— **照旧保留**（列表页那一档要用，**改钉不删** ✓）
                                 + state.refreshFailed = result.reason; renderPetPage();
                     :1867 成功路：state.refreshFailed = ''（**成功路不许被失败提示污染** ✓）
                     :1297/:1319 换一只/重进这一屏也清（失败提示不许跟着跑到别的精灵上）
                     :1227-1241 `#pet-note` 渲染：`state.petNote || refreshFailed || lastNote`
                                 + **分得开的钩子** `data-refresh-failed`（成功那句是 `data-refresh-note`）
判据：tests/roco-box-drawer.test.js **⑳**（行为：到顶再刷 ⇒ `refreshIndividual` 返回 ok:false 且理由是
  「…3 级满了…不会再叠」**不是"操作失败"**；反证：没到顶时同一路 ok:true。接线：失败进 `#pet-note`、
  `setStatus(result.reason)` 还在、成功清空、`refreshFailed=''` 至少三处）
  **改前必红**：`git show HEAD:src/client/box.js | grep -c refreshFailed` = **0** ✓
运行时报据（真点，探针自己 profile；`reports/roco/xy-review/refresh-reason.json`）：
```
【1440×900·到顶第4次】#pet-note[data-refresh-failed=yes]
   逐字：「天分加成已经 3 级满了（一 / 二 / 三级各加一项，加过的项不会再叠）—— 这一只的资质不会因为再刷而变高」
   offsetParent=true · 1164×20 · **fullyInViewport=true** ✓
   `#box-status` 那句**照旧还在** ✓（0×0 是它本来在列表视图里 —— 这次没动它）
【390×844·到顶】同样逐字出现 · 334×60 · **fullyInViewport=true** ✓
【反证·1440 与 390】另一只（没到顶）点刷新 ⇒ 成功 ⇒ `data-refresh-failed` **null**（不存在）✓
   成功那一句照旧（"上一次刷天分（第 1/2 级）：+10 加到「…」"）✓
```
截图：`19-刷新被拒-详情页那句话-{1440x900,390x844}.png` · `20-反证-成功路没有失败提示-{1440x900,390x844}.png`
单测：`tests/roco-box-drawer.test.js` **21/21** · 合并跑（box-drawer + 三件套 + workshop）**146 pass / 0 fail** ·
`roco-workshop + roco-page-ux` **77/77** ✓
⚠ 中途一次合并跑出现过 1 条红（`.xy-page-body{…}` 那条面板 CSS 断言）——**不是我这块**：
  `src/client/style.css` 那一刻正被别的队友写（mtime 02:45:04）⇒ 单独重跑与随后合并跑都 **全绿** ✓（**并发写盘的瞬时读数**）
