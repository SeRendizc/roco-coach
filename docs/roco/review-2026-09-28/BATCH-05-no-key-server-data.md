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
