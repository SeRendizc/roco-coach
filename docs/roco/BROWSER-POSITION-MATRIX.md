# 浏览器局面矩阵（BROWSER-POSITION-MATRIX）

一句话：**同一批写死的真实局面，在真页面上逐个收集气泡，再用同一批公开可观测量
在 Node 里独立重算一遍，逐字比对。** 产物是
`reports/roco/demo-acceptance/coach-positions-browser.json` + 每个局面一张截图。

它替换掉了 `scripts/roco/demo-acceptance.mjs` 里原来那段弱判据。原来那段有三处硬伤：

1. 判据只有「形状 ≥3 种」「最大占比 ≤60%」——证明不了「这不是同一个句式换数字」；
2. 阵容是 `ids.sort(()=>Math.random()-0.5)` 挑的——**同一个验收每次跑的结果都不一样**，
   这种「证据」本身不可复现；
3. 只按形状聚合，没有逐局面记录这是哪个局面，也没有和引擎侧独立重算对齐。

---

## 0. 这份验收**不**声称什么

放在最前面，免得被当成功劳：

- **不声称 12 个局面代表了所有可能的局面。** 它们是 12 个**写死的**真实窗口，
  证明的是「这 12 个局面各自得到对路的建议、而且互相不是同一句式」。
  覆盖面靠 §5 的两份引擎侧扫描单独说明；其中 `foe-low-hp` 是**已知的、已披露的**覆盖缺口。
- **不声称气泡一定能帮玩家赢。** 一条都没有跑过真人对照；文案质量是「说得具体、
  可核对、不编造」，不是「有效」。
- **不声称未核验机制可用。** 伤害一律带「估」（引擎自己标着 `formula_verified: false`），
  不出现胜率、不出现「最优」。
- **不声称采集过程不影响页面。** 采集时把 `session.dismissed` 置真、把冷却时钟往前拨
  （见 §2），目的只是让采样可控；门控与评分**照常跑**，所以 `action` 是真实判定结果。
- **不声称两侧独立实现。** Node 侧重算与页面**共用同一份构造**
  （`scripts/roco/coach-position-harness.mjs`）。这条是刻意的：两侧各写一份的话，
  对不上时分不清是页面错了还是重算错了。它证明的是「同一份公开量喂进去，
  页面显示的那一句和重算的那一句相同」，不是「两套独立实现互证」。

---

## 1. 产物与怎么跑

| 是什么 | 在哪 |
| --- | --- |
| 逐局面矩阵（12 条 + 汇总 + 引擎侧扫描） | `reports/roco/demo-acceptance/coach-positions-browser.json` |
| 每个局面一张截图 | `reports/roco/demo-acceptance/09-position-01-ko-now.png` … `09-position-12-silent.png`（`.gitignore` 第 45 行 `reports/roco/demo-acceptance/*.png` 一直把截图挡在 git 外，这是仓库原有约定，没有改；它们在磁盘上，报告里按名字引用） |
| 同一次运行的全部判据（当前 70 条，其中矩阵 12 条） | `reports/roco/demo-acceptance/demo-acceptance.json` |
| 只读产物的守卫 | `tests/evals/roco/browser-position-matrix.test.js`（在 `package.json` 的 `test:unit` 显式列表里） |
| 全量 kind 覆盖扫描（2640 局，约 33 分钟） | `npm run roco:kind-coverage` → `reports/roco/demo-acceptance/coach-kind-coverage-scan.json`（产物里的 `coverage_scan.full_scan_report` 会把它一起记下来） |

跑法：

```bash
npm run roco:demo-acceptance          # 真 Python 规则服务 + 真无头 Chrome；本机实测 93 秒
node --test tests/evals/roco/browser-position-matrix.test.js   # 只读产物的守卫（<1 秒）
npm run roco:kind-coverage            # 全量 2640 局覆盖扫描，约 33 分钟（独立命令，不阻塞上面两条）
```

`npm run roco:demo-acceptance` 会：跑完页面/产品判据（当前 58 条）→ 跑 12 个局面的矩阵
（**两遍**，共 24 局）→ 跑 110 局的抽样 kind 覆盖扫描 → 写产物 → 用 12 条新判据把矩阵量一遍；
如果 `coach-kind-coverage-scan.json` 在，还会把全量扫描的数字一并记进产物。
本机实测这段总耗时 **93 秒**（另有约 5 秒的 Chrome 启动）。
本文件里所有数字都来自上面这几份产物；没有一处是估的。

---

## 2. 每个局面怎么构造

### 2.1 输入写死在代码里

`scripts/roco/demo-acceptance.mjs` 的 `POSITION_MATRIX` 是唯一的事实来源：
每个局面固定 `{seed, 我方 3 只, 对手 3 只, 推进几手}`，按数组顺序遍历。
`Math.random()` 在这一段里**一次都不用**（历史缺陷正是它）。

第几手不是猜的：先在真引擎上从第 0 手逐步跑到第 12 手，把每一手的
`kind / action / gate / 双方血量比 / 能量 / 速度 / 合法动作` 全打出来，
挑出「这一步期望哪个检测器开口」，再把那一手写进矩阵。

### 2.2 页面上的采样方式（四步，缺一条这些数就不可信）

1. 显式设好双方阵容（页面默认的对手阵容是 `sort(()=>Math.random()-0.5)` 挑的，
   不显式设，同一个局面每次都不一样），再设 `state.seedOverride`；
2. `await startBattle()` 之后把局内记账清干净，并把 `session.dismissed` **置真**：
   推进途中的气泡就不会进 `said` 记账。否则某一手会因为「同一句已经说过」而沉默——
   那是**采样方式**造成的沉默，不是局面的沉默；
3. 用 `autoTurn()`（= `POST /api/roco/battle/advance {auto:true}`）推进写死的那几手；
4. 到位后才把 `dismissed` 放开，并**就这一手**问一次 `/api/roco/plan`，
   让 `state.plan` 属于这个局面（不是上一手的陈旧 plan），然后读 DOM 与公开可观测量。

冷却与每局配额照旧越过（`hints=0 / lastAt=-Infinity`）：那是**把时钟往前拨**，
`interventionGate` 与 `interventionScore` 照常跑，所以记下来的 `action/gate`
是真实判定结果。

### 2.3 收集什么

页面侧（全部来自 `window.rocoDemo.state` 与 DOM）：

- `#hint-text` 的原句（气泡隐藏时记 `null`，**不**把上一局的残留文本当成这一局的观测）；
- `#hint-why` 的依据行；
- `state.lastDetail.advice` 的 `kind / text / why / risk`（对外契约的四个字段）；
- `state.view` 里的**公开可观测量**：双方**场上**那一只的名字/系别/`hp`/`max_hp`/能量/
  速度/状态、我方后备、对手后备**只有位次与是否倒下**、本回合合法动作的种类与数量、
  第几回合、阶段。

产物里**不写**：`pet_id`、`skill_id`、`state_version`、任何内部评分
（`value`/`floor`/`decisive`）、对手后备的血量/能量/配招、任何密钥。
这一条由 `demo-acceptance.mjs` 与守卫**各扫一遍落盘的字节**（不是扫自己的字段），
任一命中就变红。

---

## 3. 12 个局面与实测结果

`seed` 一律 `20260921`（引擎是确定性回放，换个 seed 只是换一局，不换判据）。
「推进」= 从开局那一手之后 `autoTurn()` 的次数。

| # | 局面 id | 期望 kind | 推进 | 回合/阶段 | 我方场上 | 对手场上 | 实际气泡（原句） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `01-ko-now-lethal` | `ko-now` | 5 | 6 / battle | 寂灭骨龙 龙/幽 35/425 E3 | 寂灭骨龙 龙/幽 35/425 E3 | 「诡刺」估 130，够收对面「寂灭骨龙」这 35 血：这一轮直接收 |
| 2 | `02-ko-now-mid` | `ko-now` | 11 | 12 / battle | 雪影娃娃 冰/萌 173/442 E3 | 雪影娃娃 冰/萌 173/442 E3 | 「超级糖果」估 176，够收对面「雪影娃娃」这 173 血：这一轮直接收 |
| 3 | `03-energy-short` | `energy-short` | 3 | 4 / battle | 寂灭骨龙 龙/幽 165/425 E3 | 寂灭骨龙 龙/幽 165/425 E3 | 能量还差 1 才能收掉它：先吃「能量果」补上，这一轮别硬顶 |
| 4 | `04-type-resisted` | `type-resisted` | 5 | 6 / battle | 雪影娃娃 冰/萌 214/442 E2 | 雪影娃娃 冰/萌 214/442 E2 | 「风吹雪」打「雪影娃娃」只有抵抗（26 伤害）：别再硬用它 |
| 5 | `05-type-favoured` | `type-favoured` | 5 | 6 / battle | 圆号鱼 水 230/413 E5 | 圣凯布米龙 火/虫 238/355 E5 | 「甩水」上一手打出克制（39 伤害）：继续用它压上去 |
| 6 | `06-foe-energy-high` | `foe-energy-high` | 7 | 8 / battle | 圆号鱼 水 169/413 E6 | 圣凯布米龙 火/虫 199/355 E6 | 对面能量到 6 了（上限 6）：重招随时来，别拿残血硬接这一手 |
| 7 | `07-replace-required` | `replace-required` | 9 | 8 / replace | 寂灭骨龙 龙/幽 0/425 E3 | 黑猫巫师 普通 474/474 E2 | 「寂灭骨龙」倒了，换「海豹船长」顶上：对面「黑猫巫师」还在场，补位别一上来就挨打 |
| 8 | `08-switch-low-hp-mid` | `switch-low-hp` | 8 | 8 / battle | 音速犬 火 89/366 E1 | 圆号鱼 水 413/413 E1 | 你只剩 24% 血，换「雪影娃娃」上来：它还厚，别把「音速犬」白送掉 |
| 9 | `09-switch-low-hp-low` | `switch-low-hp` | 6 | 7 / battle | 海豹船长 武/水 57/374 E4 | 音速犬 火 134/366 E1 | 你只剩 15% 血，换「银月狼王」上来：它还厚，别把「海豹船长」白送掉 |
| 10 | `10-speed-faster` | `speed-decides` | 5 | 6 / battle | 秩序鱿墨 幽/萌 174/354 E1 | 画间沉铁兽 普通/武 293/435 E5 | 你速度 130 快过它 92：这一轮先手压上去，别把节奏让掉 |
| 11 | `11-speed-slower-defend` | `speed-decides` | 11 | 9 / battle | 黑猫巫师 普通 180/474 E3 | 月使鹭纳 翼/冰 362/362 E0 | 它速度 115 快过你 70：别硬对拼，先换人或者用「防御」顶这一下 |
| 12 | `12-peaceful-silent` | **（期望沉默）** | 0 | 1 / battle | 雪影娃娃 冰/萌 442/442 E2 | 雪影娃娃 冰/萌 442/442 E2 | **（没有气泡）** |

阵容（`pet_id` 只写在代码里，产物里只有真名）：

| # | 我方 | 对手 |
| --- | --- | --- |
| 1 / 3 / 7 | 寂灭骨龙 + 海豹船长 + 黑猫巫师 | 同我方（镜像） |
| 2 / 4 / 12 | 雪影娃娃 + 月使鹭纳 + 化蝶 | 同我方（镜像） |
| 5 / 6 | 圆号鱼 + 银月狼王 + 圣凯布米龙 | 圣凯布米龙 + 银月狼王 + 圆号鱼（倒序） |
| 8 | 音速犬 + 雪影娃娃 + 圆号鱼 | 同我方（镜像） |
| 9 | 海豹船长 + 银月狼王 + 月使鹭纳 | 音速犬 + 黑猫巫师 + 圆号鱼 |
| 10 | 秩序鱿墨 + 圣凯布米龙 + 雪影娃娃 | 画间沉铁兽 + 化蝶 + 圆号鱼 |
| 11 | 寂灭骨龙 + 海豹船长 + 黑猫巫师 | 雪影娃娃 + 月使鹭纳 + 海豹船长 |

### 3.1 唯一的沉默局面：第 12 条

- `state.lastDetail = {action: "silent", gate: null, reason: "below-threshold"}`；
- 建议层同时返回 `null`（这一手没有一条成立的局面事实）。

也就是说：这条沉默有**两个**独立原因同时成立——门控没放行（满血 → `situationRisk = 0.2`
→ `value 0.6 < floor 1.2`），而且就算放行，`coachAdvice` 也没有一条值得说的事实。
产物里的 `silent_reason` 就是这么写的，不是一句「没有建议」。

---

## 4. Node 侧独立重算：逐字比对

对每个局面，Node 侧用**同一批公开可观测量**重跑一次
`coachAdvice({game, plan, session, host})`：

- `game = rocoGameView(state.view)`（页面 `refreshHint` 里走的是同一个投影）；
- `plan = state.hint.plan`（就是页面上这一步用的那一份）；
- `session.said =` 页面上**显示这一条之前**的记账（页面在显示后才把形状写进去）；
- `host = {preference:'gentle', stale:false, ended:false, background:false, focus:true}`。

实测：**11/11 条逐字相同，kind 也 11/11 相同**。任何一条不同，判据直接变红
（`✖ 局面矩阵：页面上显示的那一句 === Node 侧用同一批公开量重算的那一句`），
并且不一致的两句话会原样写进产物的 `summary.dom_node_mismatches`。

---

## 5. kind 覆盖：8 种可达 + 3 种不可达

`coach-advice.js` 对外契约一共 11 个 kind（`COACH_ADVICE_KINDS`）。
矩阵实测到 **8 种**：

```
energy-short  foe-energy-high  ko-now  replace-required
speed-decides  switch-low-hp  type-favoured  type-resisted
```

矩阵本身证明不了「剩下 3 种为什么没进来」，所以 `demo-acceptance.mjs` 会跑**两份**
引擎侧扫描，两份都走页面正在用的那个服务、同一条
（`/api/roco/battle/new → advance → plan → rocoIntervention`）、**都不用随机**：

- **抽样扫描（每次运行都跑，约 1 分钟）**：按固定顺序枚举我方三人排列（1320 个），
  每 24 个取一个，每个再配「镜像对手」与「倒序对手」= **110 局**。
  它进判据：任何「抽样说这个 kind 的气泡真的显示过、而矩阵里却没有」的 kind，
  直接变红（第一版矩阵只有 6 种 kind，就是被它逼出第 5、6 条局面的）。
- **全量扫描（`npm run roco:kind-coverage`，约 33 分钟，产物另存）**：
  `stride 1` = **2640 局 / 34021 个窗口**。它不进「≥8 种 kind」那条判据，
  但**进披露判据**：它说「真的显示过」而矩阵里没有的 kind，必须被披露（见 §5.3、§5.4）。

抽样扫描的表（本次运行，`coverage_scan.kinds`）：

| kind | 命中 | 气泡真的显示 | 低血档沉默 | 满血档沉默 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `energy-short` | 228 | 60 | 0 | 168 | 可达（矩阵 #3） |
| `ko-now` | 183 | 114 | 0 | 69 | 可达（矩阵 #1/#2） |
| `switch-low-hp` | 246 | 246 | 0 | 0 | 可达（矩阵 #8/#9） |
| `speed-decides` | 286 | 98 | 0 | 188 | 可达（矩阵 #10/#11） |
| `type-resisted` | 94 | 34 | 0 | 60 | 可达（矩阵 #4） |
| `type-favoured` | 27 | **2** | 0 | 25 | 可达（矩阵 #5） |
| `replace-required` | 68 | 68 | 0 | 0 | 可达（矩阵 #7） |
| `foe-energy-high` | 9 | **1** | 0 | 8 | 可达（矩阵 #6） |
| `foe-low-hp` | 4 | 0 | 0 | 4 | 抽样里没显示过（**不等于不可达**，见 §5.3） |
| `ko-maybe` | 0 | 0 | 0 | 0 | 结构上不可达（§5.1） |
| `foe-status-ticking` | 0 | 0 | 0 | 0 | 没有入口（§5.2） |

全量扫描的表（`reports/roco/demo-acceptance/coach-kind-coverage-scan.json`，
`battles_scanned = 2640`、`steps_scanned = 34021`）：

| kind | 命中 | 气泡真的显示 | 其中 battle 阶段 | 低血档沉默 | 满血档沉默 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `replace-required` | 1732 | 1732 | 0 | 0 | 0 | 可达（矩阵 #7） |
| `ko-now` | 4192 | 2684 | 2684 | 0 | 1508 | 可达（矩阵 #1/#2） |
| `ko-maybe` | 0 | 0 | 0 | 0 | 0 | **不可达**（§5.1） |
| `foe-low-hp` | 67 | **6** | 6 | 0 | 61 | **可达但极稀有**（§5.3） |
| `switch-low-hp` | 6151 | 6151 | 5415 | 0 | 0 | 可达（矩阵 #8/#9） |
| `energy-short` | 4967 | 1433 | 1433 | 0 | 3534 | 可达（矩阵 #3） |
| `foe-status-ticking` | 0 | 0 | 0 | 0 | 0 | **不可达**（§5.2） |
| `type-resisted` | 2706 | 842 | 842 | 0 | 1864 | 可达（矩阵 #4） |
| `type-favoured` | 378 | 63 | 63 | 0 | 315 | 可达（矩阵 #5） |
| `speed-decides` | 7307 | 2369 | 1663 | 0 | 4938 | 可达（矩阵 #10/#11） |
| `foe-energy-high` | 286 | 40 | 40 | 0 | 246 | 可达（矩阵 #6） |

### 5.1 `ko-maybe`：结构上不可达

`damage_preview.samples[]` 里**每一个技能只有一个数**（三个分析种子对同一招给出同一个
`damage`），而 `ko-maybe` 要的正是「下限 < 血 ≤ 上限」这个形状——它不存在。
`damage_preview.min/max` 只是「最弱那招 / 最狠那招」两个**不同**技能的包络。
抽样 110 局、全量 2640 局里都命中 **0** 次。

### 5.2 `foe-status-ticking`：没有入口

12 只手游精灵的**规范配招**里，没有任何一招在引擎 `effect_support` 支持范围内会施加
中毒/灼烧/寄生（不支持的那些 fail closed），而 `POST /api/roco/battle/new` 不接受
`loadouts`——别的地方也挂不上去。抽样 110 局、全量 2640 局里都命中 **0** 次。

### 5.3 `foe-low-hp`：**可达，但这一轮矩阵没有覆盖它（已披露的缺口）**

- 全量扫描：命中 67 次，**气泡真的显示 6 次**。`first_shown` 写在第 7 回合、
  `phase = battle`、`action = micro_hint`、我方血量比 0.483、对面 5.3% 血，
  文案形状「对面「◆」只剩 # 血：这一轮先把它补掉，别让它换人喘口气」。
  出现率约 **6 / 34021 ≈ 0.018%**。
- 抽样扫描（110 局）：命中 4 次、显示 **0** 次，**全部**落在我方血量比 > 0.6 的窗口
  （低血档 0 次）。那 4 次被门控压住的原因是
  `value = 3 × risk = 0.6 < floor = 1.2`——压住它们的是**门控**，不是检测器。
- 所以：**抽样扫描证明不了「不可达」**，只能说「小样本里逮不到」。
  这一轮矩阵上限 12 格、已经 8 种 kind，没有为它定位窗口，
  于是它被登记在产物的 `summary.kinds_reachable_only_in_full_scan` 里，
  带 `disclosed: true` 与一条披露理由。判据要求：全量说可达而矩阵里没有的 kind
  **必须被披露**，披露不出理由就变红。
- 想把它补进矩阵：`npm run roco:kind-coverage`（全量）会记录
  `kinds['foe-low-hp'].shown_windows[]`（**阵容、seed、第几手、血量比、形状**），
  按那条窗口写进 `POSITION_MATRIX` 再跑一遍即可。
  ⚠️ 措辞精确一点：**盘上那份 `coach-kind-coverage-scan.json` 是旧版扫描器写的**，
  它每个 kind 只留了 `first_shown`（第 7 回合那一条就是从这里读的），**没有** `shown_windows[]`；
  当前代码已经会记 `shown_windows[]`，重跑一次就会出现。产物 `coverage_scan.kinds[*].shown_windows`
  是本次抽样扫描记的（12 个局面里那 8 种 kind 各 0—4 条）。

### 5.4 这一节的走法都不是「放宽判据」

矩阵那条判据是：

```
互不相同的 kind ≥ 8   ← 本次走这一支（实际 8 种）
或：把 11 个 kind 列全，每个缺口给出实测命中数 + 机制原因，且观测数 ≥ 6
```

另一支（`honest-shortfall`）在代码里保留着，也要能把上面两张表填出来才会判过。
另外有两条**反向**判据：

1. 抽样扫描说「这个 kind 的气泡真的显示过」而矩阵里却没有 → 直接变红。
   第 5、6 条局面就是被它逼出来的：第一版矩阵只有 6 种 kind，
   它报出 `type-favoured` 显示过 2 次、`foe-energy-high` 显示过 1 次。
2. 全量扫描（产物在时）说「这个 kind 显示过」而矩阵里却没有 →
   必须出现在 `summary.kinds_reachable_only_in_full_scan` 里且 `disclosed: true`
   并给出 ≥40 字的理由，否则 `undisclosed_coverage_gaps` 非空 → 直接变红。
   `foe-low-hp` 走的就是这一支。

---

## 6. 形状去重：9 种形状、最大重复 2 次

形状归一化（需求逐字口径）：引号里的名称/动作 → `「◆」`，任何数字 → `#`。

```
2 × 「◆」估 #，够收对面「◆」这 # 血：这一轮直接收
2 × 你只剩 #% 血，换「◆」上来：它还厚，别把「◆」白送掉
1 × 能量还差 # 才能收掉它：先吃「◆」补上，这一轮别硬顶
1 × 「◆」打「◆」只有抵抗（# 伤害）：别再硬用它
1 × 「◆」上一手打出克制（# 伤害）：继续用它压上去
1 × 对面能量到 # 了（上限 #）：重招随时来，别拿残血硬接这一手
1 × 「◆」倒了，换「◆」顶上：对面「◆」还在场，补位别一上来就挨打
1 × 你速度 # 快过它 #：这一轮先手压上去，别把节奏让掉
1 × 它速度 # 快过你 #：别硬对拼，先换人或者用「◆」顶这一下
```

判据：**没有任何形状重复超过一次**（每个形状最多出现在 2 个局面里；
`max_shape_repeat = 2`，`shapes_over_limit = []`）。
守卫**不看产物里的汇总字段**，而是从每一条的 `dom.text` 重新算形状，
再与汇总核对——汇总写错了也会红。

---

## 7. 反证（机械注入，实际报错原文）

### 7.1 把行为改回去：检测器优先级换掉 → 检查变红

把 `DETECTORS` 里 `detectSwitchLowHp` 提到 `detectKo` **之前**
（这正是那一类「优先级被挪坏」的注入），然后跑完整验收。
实际报错（`demo-acceptance` 的输出，原样）：

```
[demo-acceptance] ✖ 局面矩阵：每个局面实际开口的 kind === 写死的期望 kind（12/12） — [{"id":"01-ko-now-lethal","expected":"ko-now","got":"switch-low-hp"}]
[demo-acceptance] ✖ 局面矩阵：没有任何形状重复超过一次（实际最大重复 3 次，上限 2） — 形状 9 种 / 最大重复 3 次；超限 [{"shape":"你只剩 #% 血，换「◆」上来：它还厚，别把「◆」白送掉","count":3}]
[demo-acceptance] 结果：55 通过 / 2 失败
```

同一次注入下，只读产物的守卫也红（`node --test tests/evals/roco/browser-position-matrix.test.js`
→ `pass 8 / fail 2`）：

```
✖ 浏览器局面矩阵：每个局面的实际 kind === 写死的期望 kind
  AssertionError [ERR_ASSERTION]: 实际开口的检测器与写死的期望不一致：要么局面漂了，要么优先级被改坏了
✖ 浏览器局面矩阵：没有任何形状重复超过一次（形状由守卫重算，不看 summary）
  AssertionError [ERR_ASSERTION]: 这些形状出现了 3 次以上（同一句式换数字）：
```

还原：注入前 `sha256(src/coach/coach-advice.js) = bace4815ed87d61bc8fe6c1366a9f8b64394c6a1dae26780aac090de971370de`，
从注入前的副本还原后**逐字节相同**（`diff` 为空），`git status --porcelain src/coach/coach-advice.js` 无输出。

### 7.2 形状去重判据不是空的：构造两条同形状必须被判重

把产物里第 11 条的 `dom.text` / `shape` / `node_recompute.text` 改成与第 10 条**同形**
（只改逐条记录，`summary` 一个字不动），再跑只读守卫：

```
✖ 浏览器局面矩阵：没有任何形状重复超过一次（形状由守卫重算，不看 summary）
  AssertionError [ERR_ASSERTION]: summary.distinct_shapes 与重算不符
ℹ pass 9 / fail 1
```

也就是：**两条形状相同的记录被数出来了**（形状种数 9 → 8），判据不是空的。
还原：产物 `sha256` 改前改后都是
`3e4320fcf80099c609c516f89ba03e397157e240940a2840fa63f998515fa4d3`（逐字节相同），
守卫恢复 `pass 10 / fail 0`。

### 7.3 确定性不是「说说的」

同一批写死的输入跑两遍（pass A / pass B），去掉 `pass` 与截图名后逐字节比对：

```
digest_pass_a = digest_pass_b = e19f02c1f3221e429ff9573f7e20f7edccdecb22d3e8abca49d7bc7fbfbeaa2c
byte_identical = true
```

更强的版本：产物文件刻意**不含任何时间戳与随机端口**，所以**独立运行的整份
`coach-positions-browser.json` 也是逐字节相同的**——

- 当前代码（含全量扫描披露字段）连续两次独立运行：
  `sha256 = 3e4320fcf80099c609c516f89ba03e397157e240940a2840fa63f998515fa4d3`；
- 加入披露字段之前连续三次独立运行：
  `sha256 = fe08b4cfeb1493783314f05e45e20ca5c038c8d205c919f660a0ea2dd97493af`。

（换了代码内容，产物摘要当然会变；这里说的是**同一版代码重复跑**的结果。）
易变的东西（`started_at`、URL）单独写在 `demo-acceptance-run.json` 里，那份不入库。

`scripts/roco/demo-acceptance.mjs` 里 `POSITION_MATRIX` 那一段**没有任何 `Math.random()`**
（唯一的历史随机源是页面默认对手阵容，现在被显式设阵容覆盖掉了）。
位置截图也会在每次跑之前先清空 `09-position-*.png`，免得旧的图被当成当前矩阵的证据。

---

## 8. 复现与排错

1. `npm run roco:demo-acceptance` → 看 `demo-acceptance.json` 里
   `局面矩阵：*` 那 12 条判据；全绿即通过。
2. `node --test tests/evals/roco/browser-position-matrix.test.js` → 只读产物的守卫
   （`test:unit` 的一员）。产物不存在时它**显式 skip** 并打出重新生成的命令，
   而不是假装通过。
3. 只想看某一手长什么样：`node scripts/roco/coach-kind-coverage-scan.mjs --stride 24`
   会打出一张「每个 kind 命中/显示」的表；`--stride 1` 是全量（2640 局）。
4. 常见红与含义：
   - `kind === 期望 kind` 红 → 局面漂了，或者有人动了检测器优先级；
   - `形状重复超限` 红 → 文案层退化成模板；
   - `DOM === Node 重算` 红 → 页面显示的那一句与建议层算出来的不是同一句（真缺陷）；
   - `产物里没有 pet_id / 内部评分` 红 → 有人把内部字段写进了产物。

---

## 9. 与其它验收的关系

| 层 | 文件 | 它证明什么 | 它证明不了什么 |
| --- | --- | --- | --- |
| 引擎侧 10 个隔离局面 | `tests/evals/roco/coach-positions.test.js` | 在**真引擎**上，10 种局面各自得到对路的检测器（逐例断言 kind），7 种形状 | 页面有没有真的把这句话显示出来 |
| 浏览器 12 个局面矩阵 | 本文 + `coach-positions-browser.json` | 页面上**真的显示**的那一句、与 Node 侧重算逐字相同；8 种 kind；9 种形状 | 这些局面代表了所有可能局面 |
| kind 覆盖扫描 | `coach-kind-coverage-scan.mjs` / 产物里的 `coverage_scan` | 每个 kind 命中几次、显示几次、沉默时血量比多少 | 不是穷举；`--stride 1` 才是全量 |

两侧共用同一份构造（`scripts/roco/coach-position-harness.mjs`）：`windowOf` /
`observableOf` / `adviceOf` / `shapeOf`。引擎侧那份测试也 import 它，
所以「页面这一侧对不上」不会和「重算写错了」混在一起。
