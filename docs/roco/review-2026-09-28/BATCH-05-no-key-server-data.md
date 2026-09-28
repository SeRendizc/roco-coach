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
改为交一份点名缺项的失败（`agentStop:'server-data-unavailable'` + 结构化 `taskFailure`）：

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
