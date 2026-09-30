# 分计划 02 · 开局预览与已见阵容回看 —— 验收

**执行**：`plan02-front` · **状态**：实现与证据就绪，等 Lead 标 passed / 提交 · **HEAD 基线** `3589f73`，复验时仓库 tip `b5306f2`
**权威读数**：`result.json`（本目录） · **唯一执行状态**：`docs/roco/execution/STATE.json`（Lead 独占）

## 1 · 玩家问题与本次结果

**问题**：玩家在首个决策前看不到对手六只；预览关掉之后就再也回看不了；Coach 与页面各记各的。
**结果**：标准 PVP 六宠开局时，页面在**第一个决策之前**把对手亮明的六只摆出来（形象 / 名字 / 属性 / 出场位次），
默认 **5.5 秒**自动关闭、也能主动关（按钮 / Esc / 点遮罩），关闭后顶栏留一个紧凑的**「已见阵容 N」**入口可随时回看；
回看**只读**、不重发任何请求、不重复记事件；Coach 拿到的是**同一份**已亮明名单与已公开技能。

## 2 · 改了哪些文件及原因

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `src/client/roco.js` | `state.openingPreview` / `state.seenRoster`；02.2 的预览层（`maybeShowOpeningPreview` 等 11 个函数，唯一触发点是 `applyResult()` 的 `render()` 之后）；02.3 的入口与只读面板（`renderSeenRosterEntry` 挂在 `render()`）；`startStandardPvp()` 请求体加 `opening_preview:true` 并并行预取物种名单；两条开局路径清预览/入口状态；`coachRocoBattle()` 增加 `seen_roster` / `revealed_skills`；`window.rocoDemo` 增出 `applyResult` / `coachRocoBattle` / `openSeenRoster` / `closeSeenRoster` | 02.2/02.3 的落点；验收脚本要读真函数（与既有 `startBattle`/`playAction` 同一类出口） |
| `src/client/roco.css` | `.roco-opening*`（预览层，z-index 74、≤430px 单列）+ `.roco-opening-icon`（立绘缺图时的自制形象）+ `.roco-seen*`（入口胶囊 + 只读面板） | 桌面/窄屏两套版式；不挤占动作坞 |
| `tests/roco-battle-context.test.js` | D-11 **最小改钉**第 124 行：正则窗口判据 → 结构判据（`bench` 构造里不许有 `pet_id`/`name`；身份只许来自 `seen_roster`） | 原判据会被 02.2 的**注释**误伤；原断言逐字留档在 `test-relaxation.md`，意图一条没松 |

## 3 · 已通过与失败的验收（原始证据）

| # | 验收条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | 首个决策前六只清晰可辨（名称/形象/属性/位次） | **pass** | `02.2-acceptance.md` 判据 2/3/12；`flow-desktop-01-preview.png`（`1f293ee8c85a3050`）· `preview-390-01-open.png`（`e1de3c3c58d736d4`） |
| 2 | 默认约 5–6s 自动关闭；可主动关；键盘与文字替代可用 | **pass** | 自动关闭 `duration_ms=5501`、`closedBy=auto`、`shownAt` 不变；真实鼠标 `closedBy=button`；Esc `closedBy=esc`；倒计时文字「知道了（5 秒后自动关闭）」 |
| 3 | 展示开始与观察事件同源；不把计时结束当首次看见 | **pass** | 锚点 = `view.seen_roster[].revealed_via/revealed_turn`（引擎由 `opening_roster_revealed` 折出）；**客户端拿不到 event_seq ⇒ 不造不猜**（Lead 裁决 (a)）；`shownAt` = 渲染那一刻 |
| 4 | 关闭后紧凑入口；回看不重复触发首次事件、不挤占操作区 | **pass** | `02.3-acceptance.md`；回看窗口内 `/api/roco/*` 请求数 = 0；`flow-desktop-02-seen-roster.png`（`810fe73829f77ce0`）动作坞仍在背后 |
| 5 | 新技能与出场信息**按来源追加** | **pass** | 真引擎 `replacement` 亮明 ⇒ 分组「补位上场（1）」；`flow-390-02-seen-roster.png`（`90a529dbad558528`）第 1 行追加「防御 · 普通系 · 1 能」 |
| 6 | Coach 只在真实预览后知道六只，关闭后仍记住 | **pass** | `coachRocoBattle().seen_roster` 6 行、与页面同源同量；字段只有公开项（无 stats/hp/loadout） |
| 7 | 新局 / 刷新 / 重连 / 旧存档 | **pass（重连缺）** | 刷新：`navigation.type=reload` ∧ 无 view/预览/入口（`flow-390-04-after-refresh.png` `5fcaeae9f05d407e`）；换队两局对手互异；旧存档=无 `seen_roster` ⇒ 入口不出现；**重连未单独取证**（页面没有恢复入口） |
| 8 | 桌面 + 390px 真实操作走完预览→关闭→回看→开小芽→选择动作 | **pass** | `browser-fixture.mjs --battle` **18/18**，`raw-fixture-flow.log`；焦點/遮挡读数见 `02.5-acceptance.md` §3 |
| — | 客户端相关判据回归 | **pass** | 117 tests / 117 pass / 0 fail（10 个客户端相关测试文件；`roco-plain-speak` 那条红是 01 的 `roco-service.js` 文案债务，Lead 已派 task-10，不在本轮） |

**失败项**：无（02 范围内）。**未取得**：重连独立读数（如实登记，不编）。

## 4 · 信息边界与反例

- **只用公开事实**：预览与回看的数据源都是 `view.seen_roster`（引擎由事件折出）与 `view.opponent.revealed_skills`；
  物种属性按 `pet_id` join **物种公开图鉴**；**个体面板 stats / 天赋 / 性格 / 六个体值一个都不进 DOM**（`innerText`/`innerHTML` 双扫 + Coach 快照字段检查）。
- **不猜顺序**：只用 `seen_roster[].slot` 原值，不从 `opponent.bench`（只有 `{slot,fainted}`）猜身份。
- **回看只读**：不发任何 `/api/roco/*`（服务端对重复登记是抛错的：01 实测 `duplicate_reveal_raises=true`）。
- 反例：① 无预览模式（真 3v3 视图）⇒ 无浮层/无入口/无后台泄漏；② 同一局同一 view 再喂 ⇒ 不再弹；
  ③ 新局换队 ⇒ 对手阵容完全不同、刷新后不显示上一局。

## 5 · 三栏运行状态

| 栏 | 状态 | 说明 |
|---|---|---|
| **code** | passed（未提交） | `src/client/roco.js` · `src/client/roco.css` · `tests/roco-battle-context.test.js`（HEAD `b5306f2` 上的工作区改动，唯一写入者 `plan02-front`） |
| **isolated** | passed | 自己的隔离实例：独立端口（8879 / 8891）+ 独立 Chrome profile + `ROCO_PYTHON`；无头 Chrome 真鼠标/真按键；`fixture-run.json` 每张截图带**拍前断言 + sha256** |
| **player** | **not_available** | 本机 8765 没有在跑（且按边界不许自行启动用户服务）⇒ 玩家端读数不可得，全部验收走隔离实例 |

## 6 · 剩余问题、下一项入口、唯一 next_action

- **缺口**：G6（服务端 `validateChat` 对新增键只做加性校验，不做形状校验 —— 需要服务侧切片）· G7（重连未单独取证）·
  G9（仓内立绘只覆盖部分物种，预览层按本品自制 emoji 形象兜底并标 `data-opening-sprite="none"`）。
- **证据件索引与复跑命令**：见 `README-INDEX.md`。
- **唯一 next_action**：Lead 审阅 `result.json`/`acceptance.md` → 提交这三个文件 → `harness-verifier` 独立复核
  （哈希唯一 + 拍前断言 + 亲自看画面）→ 通过后 `STATE.json` 标 02 passed 并进入**分计划 03**。
