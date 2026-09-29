# BATCH-05：没有模型密钥也要走服务端真资料（P0-01）+ 六槽聚焦（D①-b / D①-c）

- 任务：共享任务板 `task-7`（A / P0-01），外加 art-finish D 组复现单里的两条焦点缺口
- 日期：2026-09-29
- 写域：`src/coach/client.js`、`src/coach/runtime.js`、`src/coach/toolbox.js`、
  `src/client/xiaoya.js`、`src/server/index.js`、`tests/roco-xiaoya-context.test.js`、
  `tests/offline.test.js`（Lead 批准改钉）、`reports/roco/xiaoya-context/**`、本文
- **没有重启主服务 8765**；服务端那半边的验收跑在自起的独立实例上（见下）

---

## 一、修前 / 修后（复现：问句 + 实际回答 + 网络事实）

三条事实问，在**小芽页**（`/xiaoya.html`）用真键鼠问，网络面板记下真的发生了什么：

| 问句 | 修前回答 | 修前网络 | 修后回答 | 修后网络 |
|---|---|---|---|---|
| 雨天水系伤害加多少？ | 「这条我没依据，换个说法或点名一只精灵。」 | `/api/coach` **0 次**；浏览器去拉 `/src/coach/roco-client.js` **失败** | 天气只能存在一种，持续 8 回合。雨天水系威力 **+75%**…（来源：规则配置 `mobile_s4_candidate_v3`） | **POST `/api/coach` → 200** |
| 火系克制什么属性？ | 「**进入一场 PVE 对战后**，我可以结合当前生命、能量和队伍比较行动。」 | `/api/coach` **0 次** | 火系克制：冰系 ×2、机械系 ×2、草系 ×2、虫系 ×2…（依据：游戏图鉴的相性表 火系 那一行，逐字抄录） | **POST `/api/coach` → 200** |
| 喵喵的种族值是多少？ | 「…**规则服务不可用：Failed to fetch dynamically imported module: http://…/roco-client.js**。手游图鉴（622 只）里查不到这个名字…」（自相矛盾 + 工程噪声） | `/api/coach` **0 次** | 喵喵：草系，种族值合计 **370**（生命 65 / 物攻 66 / 魔攻 66 / 物防 49 / 魔防 91 / 速度 33） | **POST `/api/coach` → 200** |

修前证据（一次运行，`/api/coach` 命中 0）：`shots/coach-context/capability-before-fix.json`（5/12）。
修后证据：`capability-live-8765.json`（对**正在跑的主服务**）、`capability-own-server.json`（16/16）。

根因（Codex P0-01 的推断，复核**成立**）：`src/coach/client.js` 原来**先在浏览器里跑 `runCoach`**，
`localOnly` / `route==='policy'` 直接 return；**没有密钥时**又有一句
`session.configured===false → return local` ⇒ `/api/coach` **一次都没发出去**。
而浏览器那层规则资料工具（`toolbox.js` 动态 `import('./roco-client.js')`）**不在静态模块图里**，
于是每次事实问都在浏览器里失败，再落到陪练/军师那两句与本作无关的模板。

修后执行位置：**浏览器只负责输入/上下文/显示**，游戏数据与工具一律由服务端执行；
服务端在没有凭据时走 `provider:'local'` 的**确定性执行**（0 次云端调用）。
Lead 独立核过这个前提（`model-routing.js` 的 `cloudDecision()` 三条 task 全 `cloud-not-configured`；
`index.js` 的 `baseProvider` 只在有 `credential` 时才建）。

---

## 二、能力状态与模型状态**分开**（第 2 条）

`GET /api/bootstrap` 的回执新增 `capabilities`（**成组**，不平铺）：

```json
{"serverReady":true,"toolsReady":null,"modelReady":false,
 "rulesetId":"roco-world-s4-2026-09-10",
 "missing":["规则服务还没被拉起来（它是第一次查询才启动的：没启动过 ≠ 坏了）",
            "云端模型没配（只影响自由发挥的文字）"],
 "toolsBridge":{"loadable":true,"clientReady":false,"engineAlive":null,"builds":0},
 "note":"toolsReady 只管资料查询；modelReady 只管自由文本生成。没配密钥不影响资料查询。"}
```

- `toolsReady` 是**三态**：`true` 在 / `false` 明确不在 / `null` **还没被拉起来过**（惰性启动，
  把"还没拉起来"报成"不可用"就是**假红灯**，与假绿灯一样是撒谎）。
- 它取**两个引擎**的并集：`rocoService.status()`（`/api/roco/status` 报的那个）**与**
  `toolbox.rocoToolsStatus()`（`/api/coach` 的资料工具实际用的那条桥）。真机实测过：
  小芽已经答出了相性表，而 `/api/roco/status` 仍 `available:false` —— 两者不是一个进程。
- 只缓存**规则服务那一半**（它会发健康检查）；工具桥是纯内存读，**每次现读**。
- 页面上是**两行**（`#xy-capability` / `#xiaoya-capability`），各自说清后果：

> 资料查询：可用（本机规则服务已连，规则集 roco-world-s4-2026-09-10）；云端模型：没有连 —— 只影响自由发挥的文字，上面那些资料查询照常

截图：`shots/coach-context/capability-own-server-status-lines.png`。
机器可读钩子：`body[data-xy-capability]="tools=ok;model=off;server=ok"`。

---

## 三、失败要说清**缺哪一项**（第 3 条）

`runCoach` 现在会记账「这一轮里服务端的资料工具跑起来没有」，跑不起来时**不许**落到旧模板，
改为交一份点名缺项的失败（`agentStop:'policy-server-data-unavailable'` + 结构化 `taskFailure`）：

```
这条要查**服务端的资料**（规则与图鉴），但这份资料现在用不了。

缺的是：本机**规则服务**（跑规则/图鉴/相性表的那个进程）没有连上。
（浏览器这一侧连不上本机规则服务）

先别急 —— 这一步**不需要模型密钥**：规则 / 图鉴 / 相性表都在本机规则服务里。
确认服务已启动（`npm start` 会一起把规则服务拉起来）之后，把这句话原样再问一次就行。

（我不会拿别的内容顶这一条：洛手的资料只从规则服务那一份来。）
```

`error_type → 缺什么` 的映射是**唯一一处**（`SERVER_MISSING_LABELS`）：`unavailable`=规则服务没连、
`not_found`=图鉴里没有这一条、`ruleset_unsupported`=规则集没登记、`version_mismatch`=局面版本对不上、
`timeout`=没算完、`not_implemented`=还没做…… 玩家正文里**不出现** URL / 模块加载器英文
（实测抓到过 `Failed to fetch dynamically imported module: http://…` 这种噪声，已改成一句人话，
原话留在 `evidence` 那一层给排障）。

验收：`capability-coach-down.json` **4/4**（用 CDP 在网络层把 `/api/coach` 打成失败，
其余一切照旧：三问都不再是旧模板、也不含糊，页面上那一行也不是绿的）。

---

## 四、网络取证（第 4 条）+ 判据与**必红反证**

```bash
# ① 对**正在跑的主服务 8765**（不重启）：客户端那半边已经是新的
node reports/roco/xiaoya-context/browser-capability-acceptance.mjs            # 14/16
# ② 自起的独立实例（新服务端代码）：随机端口 + 自己那份 roco 引擎子进程，8765 不受影响
node reports/roco/xiaoya-context/browser-capability-acceptance.mjs --own-server   # 16/16
# ③ 掐断 /api/coach：缺项要说清（第 3 条）
node reports/roco/xiaoya-context/browser-capability-acceptance.mjs --own-server --coach-down  # 4/4
# ④ 必红反证：把 /api/coach 的**响应体**换成旧练习局那句话 ⇒ ①a 三条当场红
node reports/roco/xiaoya-context/browser-capability-acceptance.mjs --own-server --red-proof  # 11/16（红 3）
# ⑤ 六槽聚焦（D①-b/①-c）
node reports/roco/xiaoya-context/browser-slot-focus-acceptance.mjs                    # 6/6
node reports/roco/xiaoya-context/browser-slot-focus-acceptance.mjs --red-proof        # 3/5（红 ①b/①c）
```

**独立实例的端口与数据目录**（Lead 要的那条证据）：脚本用 `createCoachServer` 在本进程起服务、
`listen(0)` 拿随机端口（本轮实测 `127.0.0.1:58777` 等），roco 引擎是 `createRocoService()`
自己那一个**子进程**；数据目录仍是仓库 `data/**`（只读），**没有写任何数据**。
主服务 8765 全程没被重启（`started_at` 在验收前后都是 `2026-09-28T16:36:34.037Z`）。

**反证的响度（实测）**：把 `/api/coach` 的响应体换成「进入一场 PVE 对战后…」之后，
**正好**三条 `①a 答的是洛手的内容` 变红（11/16），其余判据照旧绿 —— 说明这几条判据
真的能抓住"退成旧语料"这件事，不是空判据。六槽那边同理：把 `data-tw-slot-instance` 抹掉，
`①b/①c` 当场红（3/5）。

---

## 五、D 组复现单里那两条焦点缺口（本轮一并收掉）

出处：`docs/roco/review-2026-09-28/BATCH-07-UI独立验收.md`（art-finish）。

- **①-b `data-tw-slot-instance` 有写入、无读取方** ⇒ 已接：`xiaoya.js` 新增 `focusFromClick()`，
  点第 N 格即焦点=该格的 `own-XXXX`（**不按名字猜物种** —— 重名猜不了）。
- **①-c 焦点滞后一拍** ⇒ 已修：`notePicked()` 现在**同步**把 `last` 切过去并 `notify()`
  （原来只改 `picked`，而 `getContext()` 读的是 `last` ⇒ 点完立刻读仍是"没在看"，
  要**再问一句**才变）；详情还没取回来那一帧也如实写「正在看：迪莫（正在读它的培养数据…）」，
  `data-xy-focus` 当场就是那个个体 id。
- **另一个真机才会踩到的坑**：工作台挂在 **shadow DOM** 里（`team-workshop.js` 的 `attachShadow`），
  shadow 里的 click 冒泡到 document 时 `event.target` 会被**重定向成宿主元素**
  ⇒ 在 document 上用 `event.target.closest(...)` **永远找不到槽位**。现在走 `event.composedPath()`。
- 真机截图：`shots/coach-context/slot-focus-normal-after-click.png`（点完立刻是 `own-0004`）、
  `slot-focus-normal-answer.png`（问一句，答的是这一格的迪莫，性格与盒子详情页逐字一致）。

---

## 六、Lead 转来的那条观察：内部出处串到底可不可见

**结论**：**默认可见文本里没有**；展开「依据」之后**看得到**。

- 收起态（玩家默认看到的正文，剪掉 `details`）：三问都**干净** —— 正则
  `ev:…|own-\d{4}|pet_\d{6}|skill_\d{6}|tactic:|rule:|query_rules{|state_version|ruleset_config_id`
  一个都不命中（判据 `④`）。
- 展开「依据 / 小芽查了什么」两个折叠块之后：命中 **`ev:roco-world-s4-2026-09-10:pets`**（判据 `④a`，如实记录不判红）。
  这是**证据 id**，落在"依据"那一层；Lead 的脚本用 `textContent` 读整个 `.xy-entry`，
  所以把折叠内容也算进去了 —— 那一条**很可能默认不可见**的猜测是对的。
- 要不要把 `ev:` 前缀也滤掉，是 `src/client/evidence-view.js` 的 `INTERNAL` 正则的事
  （**我写域外**，未动）：最小改动是在该正则里加 `\bev:`。我给出结论，改不改由你/写域主定。

---

## 七、未完成项（缺哪一项，如实列）

1. **主服务 8765 上的 `capabilities` 要重启才生效**（硬边界：不许重启）。
   所以对 8765 那一轮是 **14/16**：客户端那半边全绿，红的恰好是 ②/②c 两条
   （`bootstrap` 里还没有 `capabilities` 字段）。谁在允许的窗口重启 8765，这一轮就会变 16/16。
2. **D①-a：`roco.html` / `workshop.html` 都没有 `mountXiaoya`** —— 也就是说
   **产品页上仍然没有小芽实例**，槽位焦点接好了也没有"小芽"能看见它。
   这一条要动 `roco.html`/`roco.js`（battle-smoke 写域）或 `workshop.html`（夹具，不在我写域），
   Lead 说由你协调。我的验收用 `import('/src/client/xiaoya.js') + mountXiaoya({mode:'popup'})`
   覆盖了"我这一半"（页面该做的那一行）。
3. **对战场上那一只仍然只有物种级**（引擎公开视图不给个体 id）⇒ 那三格如实说读不到。
4. `box.html` 那条主线的焦点/同源验收（task-3）在 `acceptance.json`；本轮没重跑它，改动只叠加、未触碰。

---

## 八、可复验命令汇总

```bash
node --test tests/roco-xiaoya-context.test.js            # 20/20（含 D①-b/①-c 两条新钉）
node --test tests/offline.test.js                        # 8/8（含 Lead 批准的改钉）
node --test --test-concurrency=1 tests/roco-xiaoya-context.test.js tests/offline.test.js \
  tests/coach.test.js tests/server.test.js tests/wiring.test.js tests/roco-plain-speak.test.js \
  tests/evals/structure-contract.test.js                 # 142/142
node --test --test-concurrency=1 tests/offline.test.js tests/coach.test.js tests/features.test.js \
  tests/wiring.test.js tests/copy.test.js tests/server.test.js tests/roco-ask-coverage.test.js \
  tests/roco-model-wiring-honesty.test.js tests/roco-answer-cache.test.js \
  tests/roco-xiaoya-context.test.js tests/roco-nature-advice.test.js tests/roco-panel-ask.test.js \
  tests/roco-codex-local.test.js tests/roco-local-output-contract.test.js \
  tests/roco-tool-contract-drift.test.js                 # 238/238
```

---

# 附录（task-12）：产品页的**第二套小芽** —— 对照表与两方案（等 Lead 拍板）

出处：`docs/roco/review-2026-09-28/BATCH-07-UI独立验收.md`（art-finish D①-a）。
真机证据：`shots/coach-context/companion-vs-xiaoya.json`、
`companion-01-fact-question.png`、`companion-02-after-reload.png`。

## 一、真机实测（`roco.html`，清档后、无模型密钥）

在 `#say-input` 里真键鼠问 **「火系克制什么属性？」**：

```
答：我在。想聊哪一只伙伴，或者刚才那一手？（现在没接模型：我只能给规则事实与主动提示。
    想自由问答——规则、阵容、战术、复盘——请点右上角「小芽 → 设置 → 连接模型」配置密钥；
    配置后这里的每个问题都会走模型 + 只读证据。）
网络：/api/coach 0 次（这一段里除 bootstrap/roster 外没有任何 api 调用）
```

⇒ 本任务（P0-01）在**产品页的第二份实现上原样还在**：没密钥就不发服务端 ⇒ 事实问答不出来。
它不只是"缺个焦点"。

## 二、逐项对照（每一项都是量出来的）

| 维度 | `#companion-card`（`roco.html`；`roco.js` 的 `mountCompanion`/`askXiaoya`） | `xiaoya.js`（`box.html` / `xiaoya.html`） |
|---|---|---|
| 没密钥时的事实问 | 「我在。…现在没接模型…请配置密钥」；**`/api/coach` 0 次** | 服务端确定性执行，答真资料；**1 次 → 200** |
| 焦点（我在看谁） | **无**：`[data-xy-focus]` 计数 0、无 chip、不读 `data-tw-slot-instance` | 有：点第 N 格立刻 `data-xy-focus=own-XXXX` |
| 能力状态 | 只有 `#model-chip`：「模型：未连接（只给规则事实）」——把两件事写成一句 | 两行分开 + `toolsReady` 三态 + `missing[]` |
| 历史 | 单条 `#say-reply`：第二句**覆盖**第一句（`replyStillHasFirst=false`）；重载后空白 | 重载后 10+ 轮可见；「新对话」「清空本次对话」 |
| 对话存档 | 无 | `xiaoya-chats-v1` |
| 跨局记忆 | `roco-coach-memory-v1` | `xiaoya-memory-v1`（与 `app.js` 同键）→ **两个键、两套记忆** |
| **对局上下文** | **有**：`coachRocoBattle()` + `coachRocoPlan()` → `roco_battle` / `roco_plan` | **没有**（`buildContext(null, …, 'meadow', …)`，`game` 写死 `null`） |
| 记忆弹窗（查看/忘掉） | 有（`#memory-pop`） | 无 |
| 三模型列表 / 连接入口 | 有（`#model-list`、`open-connect`）；判据 `live-model-status` 读 `#model-chip` | 无 |
| 主动提示 / 语气档位 / activityLine | 有（roco.js 的介入链路） | 无 |

## 三、两方案与代价

**甲：`xiaoya.js` 成唯一实现，`#companion-card` 退役。**
- 必做（否则是功能倒退）：① 给 `mountXiaoya` 一个**宿主动局上下文**的注入口
  （`contextProvider`/`extraContext`，把 `roco_battle`/`roco_plan`/stage 传进来）；
  ② `#model-chip` 与三模型列表要么搬进 xiaoya、要么改钉；③ 记忆弹窗的处置（搬或明确砍）；
  ④ 主动提示/activityLine 的落点。
- 另：`tests/roco-page-ux.test.js` 的 `#companion-card`/`#model-chip`/`$('coach-entry')…` 字面量**改钉不删**。
- 代价：**中到大**（页面级重构 + 一个宿主上下文口 + 2–3 处入口搬迁）。收益：真正一套实现、
  P0-01 全站生效、记忆/历史/焦点全站一致。风险：`roco.js` 是 battle-smoke 的写域，要协调窗口。

**乙：保留 `#companion-card`，把焦点接进去。**
- "焦点逻辑写第二遍"这一条**可以避免**：`createFocusProvider()` / `focusFromClick()` 已是导出的、
  与 DOM 无关的模块，`roco.js` 只需 `import` + ≈10 行接线（不是第二份实现）。
- 改不掉的部分：两套聊天 UI 并存；两套记忆继续分裂；**P0-01 要在 roco.js 那侧再修一次**
  （`if (!configured) → offline` 那一支），否则那张卡永远只会回「请配置密钥」。
- 代价：**小**；但与"唯一实现"纪律相悖，债留着。

**建议（供拍板）**：先做乙的低风险半边（焦点走共享模块 + 修那一处断线档），
让"点第 N 格 → 问一句 → 答的是那一格那只"**今天**在产品页成立；甲另立一条，与宿主上下文口和版式一起做。

---

# 丙案落地（task-12，Lead 拍板）—— 产品页也走服务端真资料 + 焦点走共享实现

Lead 拍板走**丙**（乙的低风险半边）：**不新起第三套小芽**，只把共享模块接进 `#companion-card`。
记忆弹窗 / 介入链路 / 三模型列表 / 两套记忆键合并 / `#companion-card` 退役 —— **全部留给甲**，本轮没碰。

## 一、改了哪三处（就这三处）

| # | 改动 | 文件 |
|---|---|---|
| 丙① | **焦点走共享实现**：`import {createFocusProvider, focusFromClick} from './xiaoya.js'`，本文件只接线（≈40 行，含一行焦点文字 `#companion-focus`）；`focusDetail` 同时挂进 `sayOnce()` 与 `askXiaoya()` 的上下文 | `roco.js` + `roco.html` |
| 丙② | **断线档**：`if (!configured) { 改屏 + return offline }` → 只记一个数据钩子，**照样发 `/api/coach`**；离线模板降级为"请求失败后的兜底" | `roco.js` |
| 丙③ | **chip 改真**：`模型：未连接（只给规则事实）` → `资料查询：…；云端模型：未连接 —— 不影响上面的资料查询`（与 `xiaoya.js` 同一口径）；`data-roco-tools` 新增钩子 | `roco.js` |

口径纪律：焦点**只有一份实现**（`focusFromClick` / `createFocusProvider` 都在 `xiaoya.js`，
`roco.js` 里没有第二份）—— 钉在 `tests/roco-xiaoya-context.test.js` ⑮。

## 二、屏幕判据（量屏幕，不量属性）

`reports/roco/xiaoya-context/browser-product-focus-acceptance.mjs`（**不预设**小芽是哪一套实现：
甲看 `.xy-entry`、乙看 `#say-reply` 都认；两套都能跑）：

真机 `roco.html` 工作台：装两只 → 真鼠标点第 1 格 → 开小芽 → 真键鼠问「这只是什么性格？」

| 判据 | 修前（`product-focus-before-fix.json`） | 修后（`product-focus-normal.json`） |
|---|---|---|
| ② 屏幕上那句答复出的是**这一格那只**的性格（与盒子详情页逐字一致） | ✖ 「我在。想聊哪一只伙伴…（现在没接模型…请配置密钥）」 | ✔ 「你现在看的这一只是迪莫（Lv.60）：性格「专注」。」（第 1 格 = 迪莫 `own-0004`） |
| ③ 这一问真的走了服务端 | ✖ **`/api/coach` 一次都没有** | ✔ **POST `/api/coach` → 200** |
| ④ 屏幕上没有"请配置密钥"这类绕开 | ✖ 命中 | ✔ |
| ⑤b `#model-chip` 与判据 `live-model-status` 同尺子自查 | — | ✔ 「资料查询：还没拉起来…；云端模型：未连接 —— 不影响上面的资料查询」hook=offline h=26px |
| **合计** | **2/5** | **6/6** |

截图：`product-focus-normal-after-slot-click.png`（点完那一格）、`product-focus-normal-answer.png`
（**同框**：工作台六槽 + 小芽面板里的「正在看：迪莫 · 性格 专注 · 4 个技能」+ 问句 + 回答 + 依据）。

## 三、必红反证（两条，响度都实测过）

1. **把槽位钩子摘掉**（抹掉页面上所有 `data-tw-slot-instance`）：
   `--red-proof` ⇒ **5/6，正好红 ②**（③④ 仍绿 —— 它们量的是另一件事）。
2. **把断线档改回 `return offline`**（临时改回旧写法再跑，跑完逐字恢复）：
   ⇒ **3/6，正好红 ②③④**，其中 ③ 的读数就是「**`/api/coach` 一次都没有**」、
   ④ 是「请点右上角…配置密钥」原文。

## 四、顺手修掉的一条**真回归**（Lead 在已提交状态里抓到，玩家可见）

`executeCoach` 的守卫降级原来写 `text: data.localText ?? data.text` —— `localText` 缺席时
**把模型那段没过守卫的正文原样端出去**，而 `provider` 还标着 `local-fallback`。
实测（`tests/evals/agent.test.js` 打桩 `{provider:'deepseek',text:'造成99999伤害，必胜'}`）：
守卫判它不合格，兜底却把「99999」漏给了玩家。

修后：`localText` 缺席 ⇒ **回到确定性那一份**（本机 `runCoach`，与修前同一条路）；
两条降级路都带 `deterministicFrom`（`server|local-run|none`）说清正文是哪来的；
连确定性那份都拿不到时交一句如实的话，**绝不放模型原文**。

- `node --test tests/evals/agent.test.js` ⇒ **38/38**（那条转绿，其余 37 条没动）。
- **响度实测**：把兜底临时改回 `data.localText ?? data.text` ⇒ 那条**立刻红**（`assert(!a.text.includes('99999'))`），
  恢复后 38/38。
- 另在 `tests/roco-xiaoya-context.test.js` ⑭ 从 `requestCoach` 那一层再钉一遍（含"服务端给了 `localText` 就用它"）。

## 五、两条"加东西没登记"的红（Lead 点的，已收）

| 判据 | 读数 | 做法 |
|---|---|---|
| `tests/roco-agent-stops.test.js` | **5/5** | 新值改名登记为 `policy-server-data-unavailable`（前缀要落进 `policy-*` 那一组；含义写进 `AGENT_STOPS` 上方注释） |
| `tests/roco-answer-level-correction.test.js` | **12/12** | **改钉不删**：旧键表（24 键，无 `localText`）与旧 sha256 留档在注释里；`localText` 显式登记进键表（25 键）+ 新哈希 |

## 六、本轮读数汇总

```
node --test tests/roco-xiaoya-context.test.js                      # 22/22（含丙的结构钉 ⑮ 与守卫回归钉 ⑭）
node --test tests/evals/agent.test.js                              # 38/38
node --test tests/roco-agent-stops.test.js                         # 5/5
node --test tests/roco-answer-level-correction.test.js             # 12/12
node --test --test-concurrency=1 （page-ux / wiring / plain-speak / agent / xiaoya-context /
  offline / agent-stops / answer-level-correction / local-output-contract）   # 151/151
node reports/roco/xiaoya-context/browser-product-focus-acceptance.mjs          # 6/6（丙验收）
node .../browser-product-focus-acceptance.mjs --red-proof                      # 5/6（红 ②）
（反证二：临时改回 return offline ⇒ 3/6，红 ②③④；已逐字恢复）
```

## 七、未完成项（缺哪一项）

1. **甲**（你另立那条）：记忆弹窗、介入链路/activityLine/语气档位、三模型列表、
   两套记忆键（`roco-coach-memory-v1` / `xiaoya-memory-v1`）合并、`#companion-card` 退役、
   以及 `mountXiaoya` 需要的**宿主动局上下文口**（`roco_battle`/`roco_plan`/stage）。
   ⚠ 丙之后**两套聊天 UI 仍然并存**（这是甲的范围，我没顺手做）。
2. `tests/roco-page-ux.test.js` 里**没有**关于 `#model-chip` 文案的钉子可改（36/36 一直绿）——
   该文案真正的判据是 `scripts/roco/browser-live-acceptance.mjs` 的 `live-model-status`，
   我**没改那条判据**，而是把产品文案写成它认的那个词（「未连接」）+ 在同尺子自查（⑤b）。
3. 局中（对战中）焦点/资料这条组合路径本轮没量（工作台是在**选队**那一屏量的）——
   `#companion-card` 的 `roco_battle` 仍然照旧带上，未受影响。

---

# 甲（task-13）进度：已落地两条 + 搬迁读数表（设计，未写代码）

## 一、已落地（都有读数）

| 项 | 内容 | 读数 |
|---|---|---|
| 甲① 宿主上下文口 | `mountXiaoya({contextProvider})` + 导出 `hostContextOf()`（规整 `{game,archive,stageId,extra}`，null/undefined 不并）/ `readHostContext()`（provider 抛异常记 `hostContextFailure`，不打断问话）；`ask()` 里替掉写死的 `buildContext(null, …, 'meadow', …)` | `roco-xiaoya-context` ⑯（含反证"摘掉口就没有战况"）；**局中真机 5/5**（`battle-context-normal.json`：请求体 `roco_battle=true turn=1`、`roco_plan=true`）｜**必红反证 4/5**（藏 `state.view` ⇒ 正好红 ③，`roco_battle=false`） |
| 甲③ 记忆键合并 | `migrateLegacyMemory()`：读旧键 → 合并（新键优先、列表按 id 取并集）→ 写新键 → 旧键**只加标记、内容不删** → 幂等；`roco.js` 的 `MEMORY_KEY` 切到 `xiaoya-memory-v1`，`loadMemory()` 前先迁移 | 单测 ⑰（旧键有数据 ⇒ 新键读得到 / 旧键内容不删 / 幂等 / 无 storage 不炸）；`browser-adapter-acceptance` **13/13**（四个键一起清） |
| 随之改钉的两处脚本 | `browser-product-wiring.mjs`（③/⑤ 两处读新键，旧键名与旧断言留注释）；`browser-adapter-acceptance.mjs:155`（清 `xiaoya-memory-v1` + 旧键 + 迁移标记 + onboard） | `product-wiring` 10/15：**⑤ Memory 已能读到新键**（journal=1）；其余红见下"既有缺陷" |
| `tests/wiring.test.js:189` 改钉 | `buildContext(null, …)` → `buildContext(incoming.context.game, …)`；**旧断言原文留注释 + 日期 + 依据**，第二个参数仍必须 `activeProfile` | 12/12；相关九族 175/175 |

### `browser-product-wiring.mjs` 那 5 条红的归因（**不是本次改动引入**）
- **③ 陪练 / ⑤ Memory**：脚本的 `saySentence()` **从来没点 `#coach-entry`**（全文 grep 只有 `#say-input` /
  `#say-form button`），而 `#companion-card` 默认 `hidden`（`roco.js:117` `coach:{open:false}`）
  ⇒ 往隐藏输入框打字、点击落在 (0,0) ⇒ `sayOnce()` 没跑 ⇒ `data-rocoCompanion=null`、`stated` 为空。
  **既有缺陷**；修它要动选择器，而**甲④ 退役之后这些选择器本来就要重指**（`#xiaoya-input`/`#xiaoya-send`），
  所以留到退役那一步一起改，给"改前/改后"对照。
- **④ 本机小模型两条**：环境（本机模型网关没起；脚本头部写明"不在线时如实记没跑成"）。

## 二、搬迁读数表（**设计；没写代码**）

### ① `#memory-pop`（查看/忘掉）→ xiaoya 的浮层
- **搬前量什么**（真机）：点「查看记忆」⇒ `#memory-pop` 可见；`#memory-list li .mem-label` 的行数/文字（先说过「以后叫我老王」⇒ ≥1 行）；
  点某一行的「忘掉」⇒ 该行消失、`memoryItems()` 少一条、`xiaoya-memory-v1` 里对应条目被删（**不是整键清空**）。
- **搬后同样量**：同一组读数（id/class 若沿用，探针可以逐行对照）。
- **反证**：把「忘掉」的接线摘掉 ⇒ 行数不变 ⇒ 判据必须红（响度=行数与删除结果同时红）。
- **现有钉子**：`browser-product-wiring.mjs` 两处读 `#memory-list li .mem-label`（已在我写域）。

### ② `#model-list` + `open-connect`
- **搬前量什么**：打开面板后 `#model-list .model-cell` 的格数与文字（3 格）+ 点 `open-connect` 真的到 `connect.html`。
- **搬后同样量**：同样三格（建议**沿用 `#model-list`/`.model-cell` 这套 id/class**，这样探针不用改）。
- **现有钉子**：`scripts/roco/browser-workshop-acceptance.mjs:2260–2302` 读 `#model-list .model-cell`
  —— **这个脚本不在我写域** ⇒ 走"沿用同一套 id/class"就不必动它；若你要我改它，给我写域。
- `#model-chip`（`browser-live-acceptance.mjs` 的 `live-model-status` 读它）：沿用同一个 id，把状态写成**真**的
  （丙已经把它改成"资料查询 / 云端模型"两段，且保留了判据要的「未连接」字样）。

### ③ activityLine / 介入链路 / 语气档位
- **activityLine**：它是**服务端字段**（判据在 `tests/roco-answer-level-correction.test.js`，不是 UI 元素）。
  UI 侧要做的只是让 `xiaoya.js` 把它渲染出来（现在只有 `roco.js` 渲染成 `.say-basis`）。
  量：真机读回答下方那一行的文字（与回执里的 `activityLine` 逐字相同）。
- **介入链路（`#hint` 浮条 / 自动气泡）**：注意它**不在 `#companion-card` 里**，是页面级的战斗内机制
  ⇒ 退役卡片**不应**动它。要量的是"退役后自动气泡仍然出现"（`data-roco-hint` / `data-rocoCompanionSeen` 钩子 + 真机截图）。
- **语气档位（register）**：由服务端 `companion()` 决定；`xiaoya.js` 的 **page 模式**有 4 个 role 按钮，
  **popup 模式没有** ⇒ 退役前要决定：popup 里也放 role 选择，或固定 `auto`（这会改玩家可见行为，**需要你拍板**）。

### ④ 退役 `#companion-card`
- **要改钉不删的钉子**：`tests/roco-page-ux.test.js` 里 `#companion-card` / `#model-chip` /
  `$('coach-entry').addEventListener` 那几处字面量（**我写域内**）。
- **探针侧**：`browser-live-acceptance.mjs`（`#model-chip`）、`browser-workshop-acceptance.mjs`（`#model-list`）、
  `browser-product-wiring.mjs`（`#say-input`/`#say-reply`/`#memory-list`）—— **3 个脚本读旧面板的字面量**，
  其中 2 个不在我写域。
  ⇒ **代价最小的一条路**：xiaoya 的浮层里**沿用同一套 id/class**（`#model-list`/`.model-cell`/`#memory-list`），
  并把 `#say-input`/`#say-reply` 作为**别名**保留（或让那 3 个脚本改指 `#xiaoya-*`，需写域）。
- **必红反证**：退役后把 `mountXiaoya` 的装卸掉 ⇒ 产品页 `#coach-entry` 打不开任何面板 ⇒ 判据必须红（响度=面板不可见）。
- **顺序**：①②③ 都搬完并各有"搬前/搬后"读数，**才**做 ④。

## 三、当前未完成项（不含糊）
1. 甲② 的 ①②③ 三处搬迁：**一行没动**（等读数表被认可以及窗口）。
2. 甲④ 退役：**没动**（依赖 ①②③）。
3. 语气档位在 popup 模式下怎么呈现：**需要 Lead 拍板**（会改玩家可见行为）。
4. `browser-workshop-acceptance.mjs` 是否要改 `#model-list` 的读法：**需要 Lead 给写域或确认沿用 id**。

## 四、`browser-product-wiring.mjs` 的 10/15：**三类红分开列**（混在一起就不可信）

判据：**本次改动引入的红 = 0**。下面每条都给了可复验的读数。

| 类别 | 条目 | 可复验读数 | 归因证据 |
|---|---|---|---|
| **脚本既有缺陷** | ③ 陪练（`data-rocoCompanion=null`） | 跑完脚本后读 `body.dataset.rocoCompanion` = `null`、`#say-reply` 为空 | 脚本 `saySentence()`（`:128-131`）只做 `typeText('#say-input')` + 点 `#say-form button`；**全文没有点击 `#coach-entry`**（grep 只有 `#say-input` / `#say-form button`）；而 `#companion-card` 默认 `hidden`（`roco.js:117` `coach:{open:false}`）⇒ `getBoundingClientRect()` 全 0、点击落在 (0,0) ⇒ `sayOnce()` 一次没跑 |
| **脚本既有缺陷（下游）** | ⑤ Memory（`stated 0 条 []`） | `localStorage['xiaoya-memory-v1']` 里 `journal=["teach"]`（**新键确实被写进去了** —— 改钉生效）、`stated=[]` | `stated` 只由 ③ 那一步的 `rememberPreference()` 写；③ 没跑 ⇒ 必然空。**与改键无关**：改键前读旧键同样是空（同一条链没跑） |
| **环境** | ④ 本机小模型 ×2（耗时 `null ms`） | 页面里 `typeof process === 'undefined'`、本机模型网关未起 | 脚本头部自述："依赖本机模型网关（不在线时第 ④ 项如实记「没跑成」）" |
| **本次改动引入** | **无（0 条）** | — | 本次只改了：读的键名（③/⑤ 两处）、清档键集合、以及 `tests/wiring.test.js` 的断言格式；没有一条与 ③④ 的失败链有关 |

**甲④ 要逐条对照修掉的**：③ 与 ⑤ 这两条 —— 退役 `#companion-card` 之后，`saySentence()` 的选择器要重指到
**活着的那个 UI**（`#xiaoya-input`/`#xiaoya-send`，或沿用 `#say-input`/`#say-reply` 作别名），
并且**先点开面板再打字**（`#coach-entry`）；改完给"改前/改后"两行读数（`data-rocoCompanion` / `stated` 条数）。

## 五、甲②① 落地：`#memory-pop`（查看/忘掉）搬进 xiaoya —— 搬前/搬后读数

实现（`src/client/xiaoya.js`，**不是第二份实现**）：沿用 `memoryItems` / `deleteMemoryItem` / `MEMORY_GROUPS`
（`coach/memory.js`，与旧面板**同一批函数**）+ **同一套 id/class**（`#memory-list` / `.mem-kind` /
`.mem-label` / `.mem-forget` / `data-forget`，Lead 批的"同一语义同一名字"）；入口沿用 `#open-memory`。
`deleted:false` 时**不改页面、也不假装成功**（与旧面板逐字同一条口径）。
面板换了主人 ⇒ 钩子换成 `body[data-xy-memory]`（`data-roco-memory` 属于旧面板，退役时一起消失；
**没有做 `#say-input`/`#say-reply` 别名** —— Lead 明确不批，探针按"改钉不删"更新）。

读数（`memory-migration-normal.json`，真键鼠；两次运行分别覆盖"旧面板开着/关着"）：

| | 搬前（`#companion-card`，旧面板） | 搬后（`mountXiaoya({mode:'popup'})`，新主人） |
|---|---|---|
| 说一句 | 「以后叫我老王」→ `data-roco-companion=R1` | 「以后叫我老李」→ 回答里「怎么称呼你老李」 |
| 查看记忆 | `#companion-modal #memory-list` 列出 `["称呼：老王"]` | `#xiaoya-pop #memory-list` 列出 `["称呼：老李"]`，`data-xy-memory=1` |
| 点「忘掉」 | 行 1 → 0；存储 `stated` 1 → 0（键数 17 ⇒ **只删条目、不是整键清空**） | 行 1 → 0；存储 `stated` 1 → 0；命中测试 `top=mem-forget`、`insideXiaoyaPop=true` ⇒ **真鼠标打中** |
| 同一份账本 | — | 两处读的都是 `xiaoya-memory-v1`（甲③ 合并后的那一个键） |

**必红反证（响度实测）**：把 `forgetMemory()` 的接线摘掉（`if (id) return;`）再跑 ⇒ **5/6，正好红"搬后②"**
（行 1 → 1、存储 1 → 1）；恢复后逐字相同、6/6。

### 顺带量到的一条真发现（给甲④）
两次运行对照出：**旧面板开着时，它的弹窗会盖住小芽浮层** —— 真鼠标点在小芽浮层的按钮上，
`document.elementFromPoint` 返回的是 **`memory-pop`（旧面板的三级弹窗）**、`insideXiaoyaPop=false`；
把旧面板关掉之后同一个点命中 `mem-forget`（`insideXiaoyaPop=true`），真鼠标可用。
⇒ 过渡期"两套同时在屏"不只是观感问题，是**真的抢点击**；甲④ 退役旧面板本身就解决它，
不需要为过渡期加 z-index 补丁。

## 六、甲②② 落地：`#model-list` + `#open-connect` 搬进 xiaoya —— 搬前/搬后 + 命中测试

实现（`src/client/xiaoya.js`）：同一个数据源 `/api/models`，**同一套 id/class**
（`#model-list` / `.model-cell[data-model-id]` / `.mc-name` / `.mc-state` / `#open-connect`，放在
`#xy-fold-status` 那个折叠里）；名字放不下**缩小字号**（不是省略号）、拿不到数据写「未知」不猜；
`#open-connect` 与旧面板**逐字同一条行为**（`window.open('connect.html','roco-connect','width=520,height=680,noopener')`）。
**这一块不写 `#model-chip`**（旧面板踩过的"一个读取点两个写入者"坑，判据见 ⑲）。
钩子：面板换主人 ⇒ `body[data-xy-models]`。

读数（`model-list-migration-normal.json`，真机 1600×1100）：

| | 搬前（旧面板 `#companion-modal`） | 搬后（`#xiaoya-pop`） |
|---|---|---|
| 三格 | `DeepSeek ● 未连` / `Qwen3.5-4B ● 未连` / `Qwen3.8-27B ● 未连`（`data-roco-models=offline`） | **逐格逐字相同**（`data-xy-models=offline`） |
| 命中测试 | — | `elementFromPoint` → `top=open-connect`、`inside=true`、`popZ=70` ⇒ **真鼠标打中的就是新浮层的按钮** |
| 点「调试连接」 | 真鼠标 ⇒ `window.open` 实参 `["connect.html"]` | 真鼠标 ⇒ `window.open` 实参 `["connect.html"]` |
| 走的路 | `real-mouse` | `real-mouse`（**没有降级**） |

**必红反证（响度实测）**：把三格的接线摘掉（`renderModelList` 提前 `return`）⇒ **5/6，正好红"搬后①"**
（格数 0、`data-xy-models=null`；命中测试与 `#open-connect` 那两条**仍然绿** —— 它们量的是别的东西）；
恢复后逐字相同、6/6。

### 探针里两条"如实记"的取舍
1. **`window.open` 用间谍 + 新窗口 target 两条路一起量**：headless 下新窗口的 `Target.targetCreated`
   在本次环境里没被观察到（`新窗口 target=false`），所以主判据用**间谍记录的 `window.open` 实参**
   （`["connect.html"]`）—— 它正是"同一条行为"的那个行为，且**读数里写明了这一点**。
2. 搬前/搬后的「点一下」都写成**走的是真鼠标还是 `element.click()`**（本次两次都是 `real-mouse`）。

## 七、甲②③ 落地：activityLine + popup 的 role 选择 + `#model-chip` 归谁写

**读数在独立实例上取的**（硬约束「不重启 8765」+ 主服务会话表满 ⇒ 新会话 429）：
`--own-server` = 进程内 `createCoachServer` + `listen(0)`（本次 **`http://127.0.0.1:54074`**）
+ 自己的引擎子进程，`data/**` 只读；**主服务 8765 全程未被触碰**。

| 判据 | 读数 |
|---|---|
| 搬后① popup 里有 4 个 role，默认「自动」 | ✔ `[auto(selected), companion, strategist, teacher]` |
| 搬后② 点「军师」后**请求体** `role` 真的变 | ✔ `role=strategist`、HTTP 200、真鼠标 |
| 搬后③ activityLine 与服务端给的**逐字**相同 | ✔ 服务端「依据：你的名单」= 屏幕 = `data-xy-activity` |
| 搬后④ `#model-chip` 与判据 `live-model-status` 同尺子 | ✔ 「资料查询：可用…；云端模型：未连接…」hook=offline 入口=connect.html 高=69px |
| ⑤ 控制台零报错 | ✔ |

**必红反证（响度实测）**：摘掉 role 接线 + activityLine 不渲染 ⇒ **搬后② 红**（请求体 `role=auto` 恒为默认）、
**搬后③ 红**（屏幕「(没有)」vs 服务端「依据：你的名单」），①④⑤ 仍绿；恢复后逐字相同。

### 顺带修掉一条"甲④ 一退役就红"的真缺陷
xiaoya 原来写「云端模型：**没有连**」，而 `live-model-status` 的正则是 `/未连接|没连|未连/` ——
「没有连」**不匹配**。已改成「云端模型：**未连接**」（口径不变，只换它认的词）。
⇒ 这条**只有在自己实例上**才量得出来（主服务 429 时读到的是"读不到"分支）。

### `#model-chip` 归谁写（Lead 点名要答）：选 **(a′)**
**不是"再放一个 chip"，而是把那块能力状态元素本身就叫 `#model-chip`**（同一语义 ⇒ 同一个名字，
与 `#model-list` 同一条道理）；补上 `href="connect.html"`、`data-roco-model`（**只按真实状态写**）、高度 ≥24。
⇒ `live-model-status` 一个字都不用改（不选 (b)：改判据不如让同一语义继续叫同一个名字）。
读不到状态时写 `offline` + 明说「读不到连接状态：云端模型按「未连接」处理（不谎报已连接）」——
`null` 会被读成"没连"，而"读不到"与"没连"是两件事（本次 429 就是活例子）。

### 两条**弯路**（如实记，本身是读数）
1. **`posts=0 而屏幕上有回答`** 这个形状，既可能是"产品没发请求"（P0-01 那个真 bug），
   也可能是**会话建不起来**（`src/server/index.js:672`：会话表满 100 ⇒ 新会话一律 429）。
   **只能靠 `curl /api/bootstrap` 分辨** —— 我先误判成"证据源不对/产品没发"，最后 curl 定位到 429。
2. **搬前①"屏幕空"是探针读错元素**：截图（`activity-role-normal-card-before.png`）里那一行明明在屏上，
   说明旧面板的 activityLine **不在 `#say-reply` 里**，是我按渲染代码想当然了。
   ⇒ 「屏幕上有、探针读不到」必须分辨是产品没画还是探针看错地方。

## 八、甲④-1 落地：产品页**只剩一套小芽**（`#companion-card` 退役）

Lead 拍板拆成 ④-1（本步）/ ④-2（清死代码）。本步做的是"换实现"，不是"搬 UI"。

| 改动 | 内容 |
|---|---|
| `roco.html` | **移除 `#companion-card` 整块**（2719 字节，含它自己的 `#memory-pop` / `#model-list` / `#model-chip`），原处留注释说明为什么退役、各能力搬到哪儿 |
| `roco.js` | `mountRocoXiaoya()`：`mountXiaoya({mode:'popup', contextProvider})`（上下文口喂 `roco_battle`/`roco_plan`）；`#coach-entry` 改成开/关**浮层**，复用浮层真按钮的 handler（**不是第二套开关**）；旧面板 6 个画法加早退守卫 |
| `rocoDemo` 出口（Lead 批的 (i)） | `companionVisibility()` / `renderCompanion()` / `openCompanion()` **同名同语义**转成浮层的**真实状态** ⇒ 三个验收脚本不用改 |
| 替身（如实记） | roco.js 还有 ~30 处会写旧面板元素，逐个加守卫**漏一处就是一页全白** ⇒ 加 `RETIRED_COMPANION_IDS` + `retiredStub`（游离元素，写进去不抛错也**不上屏**）。**甲④-2 清死代码时一起删**；这不是第二份实现 |
| 判据 | `tests/roco-xiaoya-context.test.js` ⑮③/⑱⑤ **改钉不删**（旧断言原文 + 日期 + 依据）："甲④ 之前旧面板不许删" → "甲④ 之后旧面板不许回来" |

**读数（独立实例，`probe-retire-boot.mjs`）**
```
{"ready":"yes","view":"empty","companionCard":false,"modelChipCount":1,
 "xiaoyaMounted":"yes","xiaoyaPop":true,"workshopApi":true,"bootFallback":false}
addCandidate ok ｜ 装满六只后开局按钮 disabled=false ｜ 入口点一下 → companionVisibility()="visible"
控制台/页面错误：（无）
```
⇒ Lead 加的两条硬指标都在：**`#companion-card` 不在页面里**、**`#model-chip` 只有 1 个**（过渡期是 2）；
`companionVisibility()` 两态给**不同**的值（不是常量）。单测 111/111。

**⚠ 未拿到的读数（不写成通过）**：in-battle（局中 `roco_battle` / 命中测试 / 自动气泡）——
探针在"填六只 → 应用 → 开局"这一步开不出局；因此三个脚本
（`browser-live-acceptance` / `browser-mobile-sweep` / `browser-roco-ux-acceptance`）也没跑。
**但已分辨归属**：把 `roco.js`/`roco.html` **临时回退到 ④-1 之前**，同一探针 + 同一独立实例**一样开不出局**
⇒ **与 ④-1 无关**，是探针×独立实例的交互（该探针此前只在 8765 上跑绿过，而 8765 被会话表 429 挡着）。
回退备份：`/tmp/roco.pre41.js`、`/tmp/roco.html.pre41`（可逐字还原）。

## 九、甲④-1 的**局中读数**补齐（独立实例）+ 必红反证（2026-09-30）

**探针先修好**（"开不出局"的形状曾与"产品坏了"极像，两个真因都不是产品）：
1. **装人装早了**：`window.rocoTeamWorkshop.addCandidate` 是 `mountWorkshop()` 之后才有的 ⇒
   装不上 ⇒ `startStandardPvp()` 里 `team.length !== 6` **静默 return**（连状态行都不写）。
   现在：**等 API 挂上 + 装完读 `state.teamWorkshop.team` 是不是 6**，不是 6 就如实停。
2. **每轮先清 cookie**：profile 持久（为了不烧会话位），而 cookie **不分端口** ⇒ 换独立实例端口时
   会带上一个实例的 `coach_session` ⇒ 页面报「请启动新版本机后端」。现在每轮 `Network.clearBrowserCookies`
   + `Storage.clearDataForOrigin({origin, storageTypes:'local_storage'})`（**保 cookie 的那一半**由 `build-snapshot` 的
   共用工具统一处理）。
3. **引擎热要问服务端**：`GET /api/roco/status` 真的 ok 才开局（不是只看页面那行文案）。
   实测：热之前开局会失败并写 `#plan-note="标准 PVP开局失败：请启动新版本机后端（npm start）"`。

**读数（独立实例；`battle-context-normal.json`）—— 9/9**
```
① 屏幕上有回答（这一页现在是 xiaoya 那一套）：✔「说一下你的队伍和对手，我按相性挑。依据：本回合的规划（引擎算的）…」
② POST /api/coach → 200 ✔
③ 请求体 **roco_battle=true turn=1**（与屏幕上第 1 回合一致）、roco_plan=true、stageId=meadow ✔
④ 回答与当前局面有关 ✔      ⑤ 控制台零报错 ✔
⑥「只剩一套」：`#companion-card` 不在页面里、`#model-chip` 计数 **1**、`#memory-list` 计数 1 ✔
⑦ 入口开/关浮层：`companionVisibility()` 与真实 DOM 可见性**始终一致**，两态给**不同**值
   （visible(popHidden=false) → hidden(true) → visible(false)）✔
⑧ 不再抢点击：浮层内输入框落点命中 `xiaoya-input`、`insideXiaoyaPop=true` ✔
⑨ 介入链路未动：推进到第 3 手时自动气泡出现（`hint=true`、`datasetHint=action_hint`）✔
```

**必红反证（响度实测）**：把 `mountRocoXiaoya()` 唯一那套装卸掉（`return null`）⇒
**判据 0/1 红**：「打开入口之后页面上有可用的邀请入口（输入框 + 发送键）」——
入口点了之后**没有任何小芽输入框**（面板打不开、邀请发不出去）。恢复后逐字相同、9/9 复现。
反证产物：`retire-companion-41-red-proof.json`。

**与主服务分开写**：以上**全部在独立实例**上取得（本次端口随机、进程内 `createCoachServer` + `listen(0)`）；
**8765 未被触碰**。8765 的新会话已由 8h TTL 自然到期恢复 200（`started_at` 未变 ⇒ 未重启），
但 `task-15` 的会话层修复**尚未部署**到 8765（跑的是旧代码）⇒ 仍需优先独立实例。

## 十、甲④-2 第一件：审计高 11 的行为**接回活着的那一处**（不是放宽断言）

Lead 报的新红（**不在原卡列的三处里**）：`tests/roco-battle-panel-static.test.js` 6/7，
`assert.match(html, /id="say-send"/)` —— 那是**旧面板的发送按钮**，④-1 已移除。

**先查"逻辑还在不在"**（这一步决定是"改钉"还是"报功能丢失"）：
```
roco.js:4394/4399  state.coachInFlight = true / finally = false
roco.js:4637/4638  if (state.coachInFlight) { sayStatus('上一条还在查，等它出来我马上答这一条（你打的字还在）。') }
```
⇒ 逻辑**还在，但只剩在死绑定里**（绑的是已退役元素的替身表单）；而**活着的那一处**（`xiaoya.js` 浮层）
当时用的是**另一种**守卫：把**输入框一起禁用**（玩家打不了第二条）。
⇒ 这不叫"还在"，是审计高 11 的行为在退役时**被换成了另一种**（"禁输入"代替"说一句人话 + 保留原文"）。

**处理（按"功能不许丢"）**：
1. `xiaoya.js`（活着的那一处）把口径接回来：提交时**先判断在飞** ⇒ 说一句人话
   「上一条还在查，等它出来我马上答这一条（你打的字还在）。」⇒ **不清空输入框**；
   在飞时**只禁发送按钮**、**输入框保持可用**（玩家可以先打第二条）。
2. `roco-battle-panel-static.test.js` **改钉不删**：旧断言（`#say-send` / `state.coachInFlight` / `#say-form` 顺序）
   **原文留在注释** + 日期 + 依据 + "审计高 11 的意图一个字没松"；新钉指向 `#xiaoya-send` / `state.asking`，
   并**保留那条反证**（守卫必须排在清空输入框之前）。
读数：该文件 **7/7**；相关六族 **118/118**。

⚠ **同类钉可能还有**（凡是指名 `#say-*` / `#model-*` / `#companion-*` 的结构钉）⇒
④-2 会**全仓扫一遍**再动，不再一处一处撞。

## 十一、甲④-2 开工：`demo-acceptance.mjs` 的复现证据 + 替身缺陷（2026-09-30）

Lead 要求"改之前先跑一次、把抛出的原文贴出来"。**改动之前的原文**：
```
[demo-acceptance] 失败： 页面求值失败：NotFoundError: Failed to execute 'insertBefore' on 'Node':
  The node before which the new node is to be inserted is not a child of this node.
    at sayWritePlayerLine (roco.js:1710:10)
    at sayOnce (roco.js:4433:3)
    at Object.say (roco.js:4397:18)
```
**根因是 ④-1 的 `retiredStub` 替身**：`sayWritePlayerLine()` 里 `body.insertBefore(me, reply)` 要求 `reply`
是 `body` 的**子节点**，而第一版给**每个 id 各建了一个互不相干的游离 div** ⇒ 抛 `NotFoundError`。
⇒ 替身比"静默 no-op"更糟：**它会抛**；这也印证了"替身必须在 ④-2 真的删掉"。
**修**：替身改成**同一棵游离树**（`#companion-body` 的替身是容器，其余挂它下面，与真实 DOM 的父子关系一致）。
修后脚本继续往下跑，下一个失败是**脚本自己**读 `#say-reply`（`null.textContent`）——那才是"退役后断链"的另一半。

**脚本改钉（不删）**：场景 6 旧写法（`rocoDemo.say` + `#say-reply.textContent` + `!hidden`）原文留注释；
新写法拆两层：① 语域 `register` 仍走 `rocoDemo.say()`（本地陪练实现还在）；
② **屏幕上那一句**改从浮层读（点 `#coach-entry` → 真键鼠打「好烦，又输了」→ 读 `#xiaoya-log .xy-entry`）。

**这一改暴露两件待 Lead 定的**（**不自行拍板**）：
1. 陪练那句的**屏幕文案换了来源**：屏幕上是服务端答的「烦啊——烦就先搁着，不聊对局也行。」，
   旧面板那句（本地 `chatReply`）只在 `rocoDemo.say()` 的返回值里（不再上屏）⇒ 改钉成新语义 vs 把本地那一支接回浮层；
2. 「玩家说过的话会出现在『她记住了什么』里」现在红（`{"rows":[]}`）：旧面板 `sayOnce()` 会调
   `rememberPreference()`，浮层这条链**不写 `stated`** ⇒ 可能是**真功能丢失**（不是判据过时）。
