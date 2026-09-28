# A7「刷新天分没效果」真机证据包（task-4 / P0-02）

**结论**：改之前在真机上「资质」那一栏点刷新**一个字都不变**（同屏还有两套数）；
改之后同一只 `own-0001` 上，**刷新天分 → 资质当场变、回滚 → 逐值还原、刷新性格 → 性格与档位一起变**。

- 真机判据脚本（新增）：[`browser-a7-refresh-proof.mjs`](./browser-a7-refresh-proof.mjs)
  —— 量的是**屏幕上的文字**（`#pet-body` 里「性格」「资质」「天分档位」与「六维」那一栏），
  **不量 localStorage**。这正是上一轮验收 28 号漏掉的那一半。
- 批次记录：[`BATCH-04-培养快照-一处真值.md`](../../../docs/roco/review-2026-09-28/BATCH-04-培养快照-一处真值.md)

## 怎么跑

```sh
# 先抢浏览器锁（owner 必写，见 tmp/BROWSER-LOCK.md）
if mkdir tmp/browser-lock 2>/dev/null; then printf '%s %s\n' "$$" "$(date +%s)" > tmp/browser-lock/owner; fi
node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag after
rm -rf tmp/browser-lock
```

演示服务要开着（`http://127.0.0.1:8765/`）；脚本只读它，自己另起一个无头 Chrome（1440×1400）。

## 读数

### 改之前（`--tag before` → `a7-before.json`）

| 步骤 | 性格 | 资质（屏幕逐字） | 天分档位 | 六维（60 级） |
|---|---|---|---|---|
| 刷新前 | 稳重 | 生命 7 / 物攻 0 / 物防 0 / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「刷新天分」后 | 稳重 | **没变** | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「回滚」后 | 稳重 | 没变 | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「刷新性格」后 | 稳重 | **没变** | 相当好的天分 | 物防 338 · 种族 49 +10 |

判据：**C1 红 / C4 红 / C5 红**（C2 绿 —— 面板本来就读本机记录，所以 Codex 那句纠正
「buttons are not wholly fake」在这份读数里也能看见）。

### 改之后（`--tag after` → `a7-after.json`）

| 步骤 | 性格 | 资质 | 天分档位 | 六维（60 级） |
|---|---|---|---|---|
| 刷新前 | 稳重 | 生命 7 / 物攻 0 / **物防 0** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「刷新天分」后 | 稳重 | 生命 7 / 物攻 0 / **物防 10** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「回滚」后 | 稳重 | 生命 7 / 物攻 0 / **物防 0** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 物防 338 · 种族 49 +10 |
| 点「刷新性格」后 | **踏实** | （不变） | **了不起的天分** | 面板跟着性格变（物防 338→114、速度 275→253） |

判据 **C1–C9 全绿**（C6 = 必红反证；C7 = 图鉴物种页不许编数字；C8 = 跨模块指纹；C9 = 六维那一栏不许自相矛盾）。
服务端 `?detail=` 那一份**从头到尾没变**（`稳重 / hp7 atk0 def0 spa10 spd0 spe9 / 相当好的天分`）
—— 这就是"服务端那份按编号现算、没有写路径"的直接证据。

跨模块那两个字段（`data-build-fingerprint` / `data-build-revision`）的读数：

| 步骤 | revision | fingerprint |
|---|---|---|
| 刷新前 | `0.0` | `id=own-0001\|nature=稳重\|talent=hp7.atk0.spa10.def0.spd0.spe9\|boosts=-` |
| 刷新天分后 | `0.1` | `…\|talent=hp7.atk0.spa10.def10.spd0.spe9\|boosts=1:def:10` |
| 回滚后 | `0.1`（**只增不减**） | **逐字回到刷新前那一份** |

「六维」那一栏的标注（Codex 在 `own-0004` 上抓到的前后矛盾，改后）：

- 标题：`六维（60 级 · 估算）` ＋ 徽标 `推导值`
- 说明：`这是推导值（估算）……前提是「60 级 · 默认 5 星 · 零突破」这三条（这套换算还没校准，
  前提也没在游戏里核验过）……引擎对战里用的不是这一份 —— 「培养出来的数值有没有真的进到队伍/对战」
  这条链还没验证过，所以这一栏不能当结论用。`
- 旧那句「不给伪精确的成品数值」**不再与数字同屏**（只在算不出推导值时画）。

## 截图（`docs/roco/review-2026-09-28/shots/build-snapshot/`，**不放 `reports/roco/**`**）

| 文件 | 是什么 |
|---|---|
| `a7-before-1-before-refresh.png` | 改之前：刷新前（这一批是**改代码之前**用同一条判据真机拍的） |
| `a7-before-2-after-refresh-talent.png` | 改之前：点完「刷新天分」—— 资质没变，同屏却有 `物防 种族 49 +10` |
| `a7-before-3-after-undo.png` | 改之前：回滚后 |
| `a7-before-4-after-refresh-nature.png` | 改之前：刷完性格 —— 性格没变 |
| `a7-after-1-before-refresh.png` | 改之后：刷新前 |
| `a7-after-2-after-refresh-talent.png` | 改之后：**资质 物防 0 → 10**，面板同步 |
| `a7-after-3-after-undo.png` | 改之后：回滚 —— **逐值还原** |
| `a7-after-4-after-refresh-nature.png` | 改之后：**性格 稳重 → 踏实、档位 相当好 → 了不起**，面板同步 |
| `a7-after-5-species-page.png` | 改之后：图鉴物种页（`?pet=pet_000062`）—— 只有「等级 —」与「六维（种族值）」，没有编出来的性格/资质 |
| `a7-after-6-panel-is-estimate.png` | 改之后：「六维（60 级 · 估算）[推导值]」+ 六项数字 + 那段前提说明，**同一屏**（裁剪） |

> `a7-before-*.png` 原本落在 `reports/roco/build-snapshot/`（被 `.gitignore:79` 的
> `reports/roco/**/*.png` 挡在仓库外）⇒ 按 Lead 的口径**复制**进 `docs/…/shots/build-snapshot/`。
> 它们是改代码**之前**真机拍的（机器的读数是 `a7-before.json`）；脚本本身没动过判据口径。

## 单测与回归读数

```sh
node --test tests/roco-box.test.js tests/roco-box-redo.test.js \
  tests/roco-box-individuals.test.js tests/roco-box-drawer.test.js
# → tests 58 / pass 58 / fail 0        （task-4 要求的那四条；新增 ⑳㉑㉔㉕ 四条）

node --test tests/roco-box.test.js tests/roco-box-redo.test.js \
  tests/roco-box-individuals.test.js tests/roco-box-drawer.test.js tests/roco-box-loadout.test.js
# → tests 73 / pass 73 / fail 0

node scripts/roco/browser-box-acceptance.mjs
# → 判据 41/41 通过；反证 27/27 命中；consoleErrors=[] pageErrors=[]（22 号）
#   其中：10b 资质 =「生命 7 / 物攻 0 / 物防 0 / 魔攻 10 / 魔防 0 / 速度 9」，[object Object] 0 处
#         28 刷新→回滚→重刷：0级/3次 → 1级/2次 → 回滚 0级/2次（按钮=false）→ 重刷换落点
#         32 完整六维：六项一项不落、性格/天分栏 3 行、技能 4 个
```

> ⚠ 期间有一次红：`tests/roco-box.test.js` 的「卡片首层的键」在 00:26 被**别人的**服务端改动
> （`src/server/roco-service.js` 的 `boxCatalogCard` 新增 `level`，为 A3「pvp选精灵看不到等级？」）
> 顶红了。那一条断言在我的写域（`tests/roco-box.test.js`）里 ⇒ 我按本仓「多一个键就要显式登记」
> 的约定把 `level` 登记进键表（旧键表留档 + 日期 + 依据），并顺手加了一条
> 「`level` 只能是数字或 null，不许拿字符串/`Lv—`/0 顶替」。**没有动别人的服务端文件。**

## 与本任务无关但顺带看到的红（**不是我改的**）

`node --test tests/evals/structure-contract.test.js` 有 3 条红，全部来自别的队友正在写的文件：

- `scripts/roco/battle-smoke-engine.py:597: cfg_energy_max = 10`（RC-101 字面量）
- `tests/roco-xiaoya-context.test.js` 没被任何 npm script 引用
- `battle-smoke-browser.mjs: rmSync(profile, {recursive: true, force: true})` 缺重试

我这一轮改的文件（`src/client/box.js`、`src/coach/individuals.js`、三个测试文件）一条都没被点到。

另有一次**别人正在写文件时被我撞上**的红（都已自行恢复，我没动它们）：

- 00:26 `src/server/roco-service.js` 的 `boxCatalogCard` 新增 `level`（A3）⇒ 顶红
  `tests/roco-box.test.js` 的「卡片首层的键」。那条断言在我的写域里 ⇒ 按本仓
  「多一个键就要显式登记」把 `level` 登记进键表；**没有动服务端文件**。
- 00:30–00:31 `src/coach/runtime.js` 一度 **SyntaxError**（`Unexpected identifier '$'`，第 381 行附近），
  让三条要 import 服务端的测试集体红。约 30 秒后该文件被它自己的作者修好（`node --check` 通过），
  重跑即绿。**我与它没有任何改动关系**，也没去碰它。

---

# task-8：「迪莫 6×4」端到端 + 二级页深链（2026-09-29）

批次记录：[`BATCH-06-迪莫6x4与深链.md`](../../../docs/roco/review-2026-09-28/BATCH-06-迪莫6x4与深链.md)

## 跑什么

```sh
node reports/roco/build-snapshot/browser-dimo-6x4.mjs          # B1–B11 + 5 条必红反证
node reports/roco/build-snapshot/browser-box-deeplink-proof.mjs # D1–D4 + 5 条必红反证
```

读数：`dimo-6x4.json` / `box-deeplink.json`；截图在 `docs/roco/review-2026-09-28/shots/build-snapshot/dimo-*.png`、`deeplink-*.png`。

## 结果（全绿）

- 锁定迪莫在位、**不许被移除也不许被「清空阵容」清掉**（拦下并说清原因）；
- 真鼠标连点五只 → 六只不同个体、六格各四个技能**都在引擎学习表里**（`data-tw-legality-all=ok`）；
- 应用 → **屏幕指纹 == 应用指纹**；点开局抓到的**真实请求体** `team` 六只（含锁定的迪莫）、
  `loadouts` 六只各四个、与屏幕**逐值一致**；
- 不带参数重新打开 → 读回来的那一份**指纹逐字相同**；换一只再应用 → 撤销 → **逐值回到应用前**；
- 每格的「详情」都写着「引擎按种族值算；性格/资质不进引擎」（**未接**，不是贯通）。

## 深链缺口③（art-finish 报，本任务收）

`box.html?pet=pet_000112`（第 5 页）改前**没有 `.avatar-art`**（`id=` 空 ⇒ 404）、等级「—」、四技能空；
改后：立绘 `id=pet_000112` **256×256**、四个技能 4 个；`?pet=own-0300`（不在第 1 页）拿回
Lv.60 + 四技能 + 培养三栏；立绘 404 的物种**退回系别 emoji、不留空框**。
来源改成"**这一只自己的 `?detail=` 回执为准，页面那一行只作补充**"。

---

# task-15：会话表满了必须有出口（2026-09-29）

批次记录：[`BATCH-08-会话表.md`](../../../docs/roco/review-2026-09-28/BATCH-08-会话表.md)

```sh
node reports/roco/build-snapshot/judge-session-cap.mjs   # 正向 5 条 + 摘掉回收逻辑的必红反证
node --test tests/server.test.js                         # 同一份判据在单测里再跑一遍
```

读数（`session-cap.json`）：连建 100 → 100/100；**第 101 个 HTTP 200 + 新 cookie，带它 POST 200**；
刚用过的那一个 200（没发新 cookie、csrf 不变）；**最久没用过的得到 403**；推满 121 个后逐个探活 ⇒ **恰好 100 个活着**（上限仍生效）。
反证：把 `reclaimSessions(now,1);` 摘掉并换回旧的 429 ⇒ 判据当场红（`实际 HTTP 429…只能重启`）。

⚠ **8765 上仍是旧代码**（进程内存里是旧实现，改完没重启）；验证全部在独立实例上做。
⚠ 探针复用 `tmp/browser-profile/` 时**必须每轮 `localStorage.clear()`**，否则上一轮的本机记录会污染读数。
