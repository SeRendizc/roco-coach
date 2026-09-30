# 02 勘察（02.1 模式—可见字段矩阵草案 + 02.2~02.5 实现方案 + 浏览器夹具）

**执行**：`plan02-front` · **时间**：2026-09-30 18:44–19:15 · **HEAD**：`3589f73`（只读勘察，`src/client/**` 一行未改）
**本文件性质**：02.1 要求的「模式—可见字段矩阵」**草案**，外加 02.2~02.5 的落点方案。**不是**完成声明。

**读过的权威入口**（不重抄）：
`docs/roco/execution/02-PLAN.md` · `reports/roco/product-execution/01/{01.1-field-matrix,01.3-reveal-and-contract,raw-contract,raw-preview,raw-publicview-keys}.{md,json}` ·
`data/roco/battle-modes.json` · `src/server/roco-service.js`（`publicView` 163-339、`startBattle` 2264-2432）·
`src/client/roco.js`（`startBattle` 4311、`startStandardPvp` 5523、`applyResult` 3572、`render` 887、`coachRocoBattle` 4926、`bind` 5201）·
`src/client/roco.html` · `src/coach/roco-client.js:948-958` · `tests/roco-battle-context.test.js:113-126`

---

## 1 · 02.1 模式—可见字段矩阵（草案）

四档标注沿用 01.1：🟢事实（公开可见）/ 🟡推测 / 🔴隐藏真值 / ⚪结构性。

| # | 模式（登记表 id） | 页面真实入口 | 队伍规模 | 02 建议是否展示预览 | 展示哪些字段（顺序语义） | 依据 |
|---|---|---|---|---|---|---|
| 1 | `pvp-standard-six-pet`（CANDIDATE） | `#start-standard-pvp` → `startStandardPvp()` → `POST /api/roco/battle/new {mode,team×6}` | 6（登记表 `parameters.team_size`） | **是（唯一启用）** | `view.seen_roster[]`：`slot`（⚪ 次序即服务端给的出场位次，**照抄不重排**）、`pet_id`、`name`、`revealed_via='opening_preview'`、`revealed_turn`；形象 = `/api/roco/sprite?id&name&size=battle`；属性 = 本地名单按 `pet_id` join（见 §3b） | `data/roco/battle-modes.json` `modes[1]`；`roco.js:5523-5575`；`roco-service.js:2276-2298` |
| 2 | legacy 3v3 练习局（**无 `mode`**，服务端 `modeId=null` → `DEFAULT_TEAM` 3 只） | `roco.html?legacy3v3=1` → `#start-battle` → `startBattle()` | 3 | **否**（02.2 的判据是「六只」；3 只不是那个模式） | 不弹预览层；但「已见阵容」入口**按数据出现**：`switch`/`replacement` 事件同样进 `seen_roster`（`revealed_via` = 事件 kind） | `roco.js:5394-5404`、`4311-4346`；`roco-service.js:2298` |
| 3 | `pvp-speed-duel-3v3` / `pvp-territory-trial-2v2`（ACTIVITY） | **页面无入口**（全仓只有 `STANDARD_PVP_MODE_ID` 一处字面量） | 3 / 2（`active_count` 2） | 不适用（不可达） | 若将来接：门控 = ①该模式登记了 `team_size` ②页面**真的**按该规模开局 ③真的展示；2v2 的「六只」语义不成立，不得套用 | `src/game/battle-modes.js`（只有一处 id）；`roco.js:56` |
| 4 | `pve-camp`（EXISTING） | 不在本页（营地/剧情页） | — | 不适用 | — | `battle-modes.json` `modes[4]`；本页无入口 |
| 5 | `demo-training-3v3`（LEGACY_FIXTURE） | 登记表里的迁移夹具；页面等价路径即 #2 | 3 | 否（同上） | — | `modes[0]` |

**口径（三条，写进实现）**
1. **「是否展示」由页面显式决定**：引擎侧 `opening_preview` 是**请求字段**（`service.battle_new`），省略 = 不展示（`roco-service.js:2379-2386`）。页面不传，请求体里就没有这个键（Node 白名单要求显式传）。
2. **只在真实展示模式启用**：门控 = 服务端回执 `view.mode_id === 'pvp-standard-six-pet'` **且** `view.seen_roster` 里真有 `revealed_via === 'opening_preview'` 的行 **且** 页面确实把那六只画出来了。三者缺一 ⇒ 不弹预览层、不显示「完整阵容」入口。
3. **不得从槽位猜未公开顺序**：只用 `seen_roster[].slot` 的原始值/顺序；`view.opponent.bench[]` 只有 `{slot,fainted}`，**不能**拿它补名字或补身份（既有反例判据 `tests/roco-battle-context.test.js:124` 钉的就是这条）。

**可见字段（客户端真拿到什么，实测）**
- `view.seen_roster` = `[{slot, pet_id, name, revealed_via, revealed_turn}]`（Node `publicView` 219-221、245）——**没有** types / stats / 形象字段。
- `view.opponent.bench` = `[{slot, fainted}]`（274-275，未亮明时不含身份）。
- `view.opponent.revealed_skills` = `{pet_id:[{skill_id,name,element,category,energy,power,...}]}`（276-278），形状同 `legal[].skill`。
- `view.events[]` = `{turn,kind,side,detail,extra,text,evidence}`；`extra.seq` 是事件在 `state.events` 里的绝对下标（294-300）。
- `view.match_id / rules_version / decision_id`（241-243）——有才出现。

---

## 2 · 关键接线点（函数 + 行号）

| 落点 | 位置 | 现状 | 02 要做什么 |
|---|---|---|---|
| 开局（标准 PVP） | `startStandardPvp()` `roco.js:5523`，body 在 `5553`，POST 在 `5575` | body `{mode,team,strategy[,seed,loadouts]}`，**没有** `opening_preview` | 门控通过时加 `body.opening_preview = true`（唯一一处） |
| 开局（legacy 3v3） | `startBattle()` `roco.js:4311`，POST 在 `4346` | 同上、无 mode | **不加**（矩阵 #2） |
| 新局事实收口 | `applyResult(data)` `roco.js:3572` → `state.view = data.view` `3668` → `render()` `3675` | 每次推进的唯一收口；`state.matchEvents` 累积、`matchHistory` 记前后局面 | 预览层/已见阵容的**唯一**触发点放这里（`render()` 之后） |
| 对手后备渲染 | `render()` `roco.js:887`；`#foe-roster-line` `956-962`；`#foe-bench` `984-993` | 写「第 N 位」「对手后备 N 只 · 上场时亮明」 | 已亮明的按 `seen_roster` 显示名字/形象；未亮明的保持原样 |
| Coach 快照 | `coachRocoBattle()` `roco.js:4926`；bench `4968-4972`；注释 `4920-4925` | `foe_bench` 只带 `{slot,fainted}`，注释写「不许补 pet_id」 | 02.3 加 `seen_roster`（公开已亮明）+ `revealed_skills`，并更新那句注释 |
| 事件→Coach | `roco.js:521` 附近 `context.roco_battle`（`if (rocoBattle) context.roco_battle = rocoBattle;`） | 已有 | 不改形状 |
| CSS | `battle-v3.css`（b3 版式）/ `roco.css`（战斗态开关 `body[data-roco-view="ready"]`） | — | 预览层与入口样式 |
| 键盘/文字替代 | `bind()` `roco.js:5201` 的既有模式（`on(id,'click',…)`、`hidden`、`aria-live`、`dataset.bound` 防重复绑定） | — | 预览层复用同一套 |

---

## 3 · 与 02-PLAN 假设不符之处（必读）

**(a) 预览事件在客户端看不到。** `battle_new` 的 `view.events` 是**空数组**（01 的 `raw-contract.json` 里 `battle_new_events: []` 也是这个）；`opening_roster_revealed` 只存在于私有回执 `opening_reveal` 与 `state.events`，`publicView` **不转发**它。
实测（`raw-probe-service-http.log`）：`battle_new` 回执 `view.events` 里 `opening_event = null`，但 `view.seen_roster` 有 6 行。
⇒ 02.2 的「展示开始与观察事件一致」在页面上只能锚在 **`seen_roster[].revealed_via/revealed_turn`** 这条**同一来源**（引擎由事件折出）的痕迹上；页面上拿不到 `event_seq`（`extra.seq` 要到 advance 之后的事件里才有）。

**(b) `seen_roster` 不带 types/stats/形象。** 02.2 要「名称、形象和属性」：名称/`pet_id` 有了；形象可由 `b3SpriteUrl(pet,'battle'|'thumb')`（`roco.js:2902`）拼；**属性需要页面自己 join**（`state.roster`/`state.rosterAll` 行里有 `types`/`stats`，`roco.js:4673-4703` 已有唯一匹配的现成写法）。
两条路：**页面 join（我倾向）** —— 物种属性是公开图鉴事实，不需要服务端切片；或请 Lead 开一个 Node 侧切片把 `ui.opponent.bench[i].types`（引擎本来就有）并进 `seen_roster`。**在没拿到 go 之前我不动服务端。**

**(c) `bench` 与 `seen_roster` 是两份数据。** 页面要按 `slot` join；**不能**改 `bench` 的形状（那是 01 的显式边界）。

**(d) 测试判据会误伤。** `tests/roco-battle-context.test.js:124`：`assert.ok(!/bench[\s\S]{0,120}pet_id/.test(CLIENT_SRC))` —— 只要 `pet_id` 出现在 `bench` 之后 120 字符内就判红。02.3 给 `coachRocoBattle()` 加 `seen_roster` 时必然踩到。建议改钉成结构断言（「后备的 pet_id 只能来自 `view.seen_roster`」+「无预览时不得出现」）。**这是 `tests/` 下的文件，不在我的写域，需要 Lead 指派。**

**(e) 本机浏览器链路的环境限制（影响 02.5）。** 见 `fixture-interruption.md`：一旦走到「开局」或「打开小芽」那一下，整棵进程树在 ~0.5s 内被外力中断。

---

## 4 · 02.2~02.5 实现方案（待 go）

### 02.2 首个决策前的六只预览
- **落点**：新函数 `renderOpeningPreview(view)`，只在 `applyResult()` 的 `render()` 之后调用（唯一收口）；`state.openingPreview = {key, shownAt, closedAt, closedBy, slots}`。
- **触发**（缺一不可）：`view.mode_id === 'pvp-standard-six-pet'`；`view.seen_roster` 有 `revealed_via==='opening_preview'` 的行；本局还没弹过（键 = `state.battleId + ':' + match_id + ':' + state_version`）。
- **展示**：六格按 `slot` 升序（缺格不补）；每格 = 形象 + 名称 + 属性 chips（join 不到就写「属性不在本地名单里」，**不猜**）+ 一行文字说明这是对手的出场位次。
- **计时**：默认 **5.5s**（落在 5–6s）；`shownAt = performance.now()` 是**展示开始**，也是「首次看见」的时刻；计时器 id 存进 state，手动关时 clear。
- **关闭**：按钮「知道了」/ Esc / 点遮罩 → 同一个 `closeOpeningPreview(reason)`，`reason ∈ {auto,button,esc,overlay}` 记进 `state.openingPreview`（证据要读）。
- **键盘与文字替代**：`role="dialog" aria-modal="true"` + 初始焦点落在关闭按钮 + `Esc` + 一句可见文字（读屏也能读到同样的信息）。
- **不把计时结束当首次看见**：事件/证据里写的是 `shownAt`（DOM 插入那一下），`closedAt` 只用于「自动 vs 主动关闭」的区分。

### 02.3 关闭后的「已见阵容」入口
- 紧凑入口（`已见阵容 N`）放在对手一侧/顶栏，点击展开只读浮层；**渲染函数与 02.2 共用**一份。
- **回看不触发首次事件**：只读，不发任何 `/api/roco/*`；服务端 `duplicate_reveal_raises=true`（01 实测），重复登记会抛 ⇒ 回看**绝不能**重发 `battle_new`。
- **按来源追加**：`seen_roster` 每行带 `revealed_via`（`opening_preview`/`switch`/`replacement`）+ `revealed_turn` ⇒ 回看里按来源与回合分组；新技能走 `view.opponent.revealed_skills[pet_id]`。
- **Coach 引用**：`coachRocoBattle()` 加 `seen_roster` + `revealed_skills`，让聊天里的「小芽」引用**同一份**已见阵容（同时改 (d) 那条判据）。

### 02.4 新局 / 刷新 / 重连 / 旧存档
- 新局：在 `startBattle()`（`4314-4325`）与 `startStandardPvp()`（`5534-5546`）**同一处**清 `state.openingPreview` / 已见阵容 UI 状态；卡片重画前校验本局身份（用 `battle_id` 做会话唯一性，`match_id` 只做一致性校验 —— 它由公开开局事实派生，同规则同队伍两局会相同）。
- 刷新/重连：不持久化观察，从当前 `view.seen_roster` 重建；拿不到就如实写「这一局的已见阵容还没恢复」，**不显示上一局**。
- 旧存档：`view` 里没有 `seen_roster` ⇒ 入口不出现（无预览模式的反例）。

### 02.5 桌面 + 390px 真实操作
- **前置依赖**：本机 Windows 浏览器中断问题（§3e）。若不能解除，这一条在本机只能拿到「大厅 + 390 静态 + 数据面探针」的证据，**不足以**宣称走完预览→关闭→回看→开小芽→选择动作。
- 风险最高两处：**焦点管理**（遮罩打开时焦点在遮罩内、关闭回到触发按钮）与 **390px 遮挡**（动作坞 / 小芽浮条是 fixed，预览层要 z-index 高于它们但不改它们的定位；用 `elementFromPoint` 量）。

---

## 5 · 复跑命令（本轮实测）

```powershell
# 浏览器夹具（默认：隔离服务 + 无头 Chrome + 1440/390 截图 + 命中测试）
node E:\roco-scratch\plan02\browser-fixture.mjs          # ⇒ checks 6/6 pass, exit 0
# 复现外力中断（开局那一下 / 打开小芽那一下）
node E:\roco-scratch\plan02\browser-fixture.mjs --battle
node E:\roco-scratch\plan02\browser-fixture.mjs --coach
# 数据面探针（不经浏览器，真引擎）：battle_new / seen_roster / advance / plan
node E:\roco-scratch\plan02\probe-service-http.mjs       # ⇒ 200 / seen_roster 6 行 / 200
# 进程树监视器（判「整棵树是否原子消失」）
node E:\roco-scratch\plan02\monitor.mjs 45
```

读数与截图见 `fixture-run.json`、`raw-*.log`、`shots/`。
