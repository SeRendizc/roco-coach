# 退役单位词清零 S4：`src/client/**` DOM 文案 + 服务端词表一次性对齐（Lead 批准 (A)）

- 执行者：`plan02-front` · 2026-10-01 · task-43 · **未入库**（等 Lead 提交）
- 上游：[S3 迁移](player-text-migration-s3.md) · [横切审计](player-text-audit.md) · [独立复验](verify-text-vocab.md)（O-53 由它登记）
- 口径（Lead 定，未变）：行文用 **`血`** · 面板/属性名用 **`血量`** · 能量类唯一叫法 **`能量`** · 退役词 **`HP` / `生命` / `豆`**
- **扩权记录**：Lead 在中期回报后选 **(A)**，批准本刀写域临时覆盖
  `src/server/roco-service.js`（标签侧）· `scripts/roco/browser-box-acceptance.mjs`（`PET_STAT_LABELS`）·
  `tests/roco-box-drawer.test.js` / `tests/roco-box-individuals.test.js`（按改钉规矩），并要求**新增一条两侧绑定判据**。

## 0. 一页结论

| 项 | 结果 |
|---|---|
| 迁移 | `src/client/app.js` 8 行 · `xiaoya.js` 2 行 · `box.js` 4 行 · `box-drawer.js` 2 行 · `src/server/roco-service.js` 2 行 · `scripts/roco/browser-box-acceptance.mjs` 1 行 ⇒ **我写域内玩家可见文案的退役词 = 0**（残留只剩注释） |
| 判据 | **改钉 2 条**（`roco-box-drawer:394` / `roco-box-individuals:249`；原断言逐字留档在文件内）· **新增 1 条绑定判据**（`roco-box-drawer` **㉑**） |
| 两向变异 | 客户端单侧换回 `生命` ⇒ **⑰ + ㉑ 红**；**服务端单侧**换回 ⇒ **㉑ 红**（这就是「任一侧单独改词必红」的读数） |
| 判据批（17 文件） | 改前 291/288/1 → 改后 **293/290/1**；唯一红是**并发的** `roco-plain-speak`（命中在 `src/coach/runtime.js`，不是本刀，见 §6） |
| 门禁 | 退役词命中 **0 处**（语料 503 · 覆盖审计 ok）；另有一条既存 FAIL「230 vs 503」（他人器材，已转 harness-verifier） |
| 结构发现 | 「属性名」这套词表有 **4 个 owner**：client（本刀）· server（本刀）· `src/coach/runtime.js:255`（**未覆盖，见 §7**）· `src/client/roco.js:471`（归 05） |

## 1. 迁移明细（逐处 before → after；**只动字符串，键名/内部字段一律未动**）

### 1.1 `src/client/app.js`（8 行 · sha16 `046d48bd42cabbcd` · 130949B）

| 行 | 前 | 后 | 口径 |
|---|---|---|---|
| 147 | `<span>生命 ${p.maxHp}</span>`（营地名单卡） | `<span>血量 ${p.maxHp}</span>` | 面板属性名 ⇒ 血量 |
| 191 | `<span>生命 ${p.maxHp}</span>`（出征页卡） | `<span>血量 ${p.maxHp}</span>` | 面板属性名 ⇒ 血量 |
| 314 | `升级 生命+${…}` | `升级 血量+${…}` | 面板属性名 ⇒ 血量 |
| 335 | `${s.cost} 豆` | `${s.cost} 能量` | 能量单位 ⇒ 能量 |
| 345 | `:'生命'}`（hp-line 标签） | `:'血量'}` | 面板属性名 ⇒ 血量 |
| 345 | `${p.hp}HP · ${p.energy}能量` | `${p.hp} 血 · ${p.energy} 能量` | 行文单位 ⇒ 血 + 间距统一 |
| 397 | `消耗 ${sk.cost} 豆` | `消耗 ${sk.cost} 能量` | 能量单位 ⇒ 能量 |
| 398 | `${q.hp}/${q.maxHp} HP · ${q.energy} 能量` | `${q.hp}/${q.maxHp} 血 · ${q.energy} 能量` | 行文单位 ⇒ 血 |
| 433 | `消耗 ${sk.cost} 豆` | `消耗 ${sk.cost} 能量` | 能量单位 ⇒ 能量 |

### 1.2 其余 5 个产品文件

| 文件 | 行 | 前 → 后 | sha16 / 字节 |
|---|---|---|---|
| `src/client/xiaoya.js` | 1227 | `我按当前生命、能量和队伍比这一手。` → `…当前血量…` | `d1db3b6c76a94be8` / 119274 |
| `src/client/xiaoya.js` | 131 | `FOCUS_STAT_BY_LABEL = {生命: 'hp', …}` → `{血量: 'hp', …}` | 同上 |
| `src/client/box.js` | 737 | `STAT_LABELS = {hp: '生命', …}` → `{hp: '血量', …}` | `1e0c567a8caeddf6` / 139766 |
| `src/client/box.js` | 739 | `STAT_NAMES_OF_KEY = {hp: '生命', …}` → `{hp: '血量', …}` | 同上 |
| `src/client/box.js` | 708 / 733 | JSDoc 里引用的旧标签名同步成 `血量`（文档不再与代码矛盾） | 同上 |
| `src/client/box-drawer.js` | 49 | `STAT_ORDER = [['hp', '生命'], …]` → `[['hp', '血量'], …]` | `3d854f33ea83f2cc` / 34845 |
| `src/client/box-drawer.js` | 59 | JSDoc 同步 `血量 10 / 物攻 3 …` | 同上 |
| `src/server/roco-service.js` | 418 | `BOX_STAT_FIELDS=[['hp','生命'],…]` → `[['hp','血量'],…]` | `fd02e4b2f942c691` / 179500 |
| `src/server/roco-service.js` | 755 | `const order={hp:'生命',…}`（`individual_label` 的「天分 速度 7 / 生命 0」）→ `{hp:'血量',…}` | 同上 |
| `scripts/roco/browser-box-acceptance.mjs` | 232 | `PET_STAT_LABELS = ['生命', …]` → `['血量', …]` | `4dc32126cca8f0d7` / 176802 |

- **`:755` 是中期回报里没列到的第二处服务端标签表**（`individual_label` 的「天分 …」人话串），与 `:418` 同属「服务端词表」，一并按 (A) 的口径改掉。
- `node --check` 6 个产品文件全部 exit 0。
- **没动**：`src/client/roco.js`（9 处，归 05）· `src/server/opponent.js:35/36`（Lead 说另排）· `data/**` · `package.json` · `knowledge/**`。

## 2. 逐文件「退役词命中数」前后对比

扫描口径 = 门禁同款 `/\bHP\b|生命|豆/`（行级；注释单列，注释不进玩家可见正文）。

| 文件 | 改前 | 改后 | 残留 |
|---|---|---|---|
| `src/client/app.js` | 9 行（10 处） | **1 行** | 仅注释 `:184`（描述旧 bug 的举例） |
| `src/client/xiaoya.js` | 3 行 | **1 行** | 仅注释 `:1475` |
| `src/client/box.js` | 5 行 | **1 行** | 仅注释 `:297`（引用服务端 `individual_label` 的样例） |
| `src/client/box-drawer.js` | 2 行 | **0 行** | — |
| `src/client/box-loadout.js` | 1 行 | 1 行 | JSDoc `:240`（技能描述原文引用，非本页文案） |
| `src/client/roco.js` | 9 行 | 9 行 | **本次不动**（`:471`/`:753`/`:1562`/`:2299`/`:5160` 真文案 + 4 处注释） |
| `src/server/roco-service.js` | 2 行（`:418`/`:755`） | **0 行** | — |

⇒ 本刀写域内**玩家可见文案清零**；余下 4 行全是注释/JSDoc（逐条给了行号）。

## 3. 改钉（按规矩：原断言逐字留档 + 运行时报数 + 最小修订）

| 判据 | 位置 | 原断言（**逐字留档在文件内**） | 最小修订 |
|---|---|---|---|
| ⑰ 资质是六维表 | `tests/roco-box-drawer.test.js:394` | `assert.equal(formatTraitValue(real), '生命 10 / 物攻 3 / 物防 1 / 魔攻 7 / 魔防 3 / 速度 10', '六维要按固定顺序摊成一行（顺序与 roco-service 的 BOX_STAT_FIELDS 同一套）');` | 期望串首标签 `生命`→`血量`；语义（按固定顺序摊成一行、不许 `[object Object]`）未变 |
| ⑳ A7 培养快照 | `tests/roco-box-individuals.test.js:249` | `assert.match(formatTraitValue(before.talent), /^生命 \d+ \/ 物攻 \d+ \/ 物防 \d+ \/ 魔攻 \d+ \/ 魔防 \d+ \/ 速度 \d+$/, …)` | 正则首标签 `生命`→`血量`；语义（六维逐字印出）未变 |

两条**都在文件里留了 `原断言逐字留档（改钉不删）` 注释**；改钉前后各自单跑：`roco-box-drawer` 21/21 → **22/22**、`roco-box-individuals` 11/11 → **11/11**（改钉当场是 10/11，改完回绿）。

## 4. 新增：两侧绑定判据（Lead 要求 ④）

`tests/roco-box-drawer.test.js` 新增 **㉑ 两侧绑定：详情页的六维标签 === 服务端 BOX_STAT_FIELDS 提供的那一组（任一侧单独改词必红）**。
它把两件事钉在一起（**根因守卫**，不是文案快照）：
1. `STAT_ORDER`（客户端）与 `BOX_STAT_FIELDS`（服务端）**逐字逐序** deepEqual；
2. 服务端给的每个 `label` 必须能在客户端反查表里落回正确 `key`（这正是 `box.js:954` / `xiaoya.js:190` 的路径 —— 分叉会让详情页数字**不显示**）；
3. `formatTraitValue` 渲染出来的那一行必须逐字用服务端提供的那组标签；
4. 源码级兜底：`box.js` 与 `xiaoya.js` 必须出现同一组标签、且不许回退 `hp:'生命'` / `生命:'hp'`。

## 5. 两向变异（换回旧词 ⇒ **必红**，这次真有牙）

| 变异（脚本 `E:\roco-scratch\t43-mut-pair.mjs`） | 结果 |
|---|---|
| **客户端单侧**：`box-drawer.js` `[['hp','血量']` → `[['hp','生命']` | `roco-box-drawer` **exit 1 · 22 tests · 20 pass · 2 fail** ⇒ 红的是 **⑰ + ㉑** |
| **服务端单侧**：`roco-service.js` `[['hp','血量']` → `[['hp','生命']` | `roco-box-drawer` **exit 1 · 22 · 21 · 1 fail** ⇒ 红的是 **㉑** |
| 还原 | `box-drawer.js` 回到 `3d854f33ea83f2cc`、`roco-service.js` 回到 `fd02e4b2f942c691`（**逐位相同**） |

⇒ 满足 Lead 的 ⑤「不许出现『改回旧词仍然全绿』」——**这一条是本刀新增的结构性牙**。
（对照：本刀开始时那 30 处 client 文案**完全没牙**，见 [S4 中期版本] 里记录的「10 个判据 0 红」；现在属性名那一套有了。）

## 6. 判据批读数（同一脚本跑三次：before / after / final）

命令：`node --test --test-concurrency=1 <file>`（`ROCO_PYTHON` 已设），17 个文件。

| 阶段 | 文件数 | tests | pass | fail | 说明 |
|---|---|---|---|---|---|
| before（未动任何文件） | 17 | 291 | 288 | 1 | 唯一红：`roco-battle-context` ⑧（既存） |
| after（安全子集：app.js/xiaoya.js） | 17 | 292 | 288 | 2 | 多出的红是**并发**新增的 ⑨（见下） |
| **final（本刀全部改动）** | 17 | **293** | **290** | **1** | 唯一红是**并发的** `roco-plain-speak` ① |

- `roco-box-drawer` **22/22**（含新增 ㉑）· `roco-box-individuals` **11/11**（改钉后）· `roco-box` 14/14 · `roco-box-loadout` 17/17 · `roco-box-redo` 15/15 · `roco-xiaoya-context` 41/41 · `roco-page-ux` 36/36 · `roco-ask-coverage` 49/49 · `roco-battle-panel-static` 8/8 · `roco-loadout-ui` 9/9 · `roco-panel-level` 8/8 · `copy` 17/17 · `evals/player-copy` 2/2 · `browser` 12/12(2 skip) · `roco-player-text-gate` 6/6 · `roco-battle-context` **12/12**（并发那条 ⑨ 已被它的 owner 修好）。
- **唯一红 `tests/roco-plain-speak.test.js` ① = 并发的，不是本刀**：
  `actual: [ 'src/coach/runtime.js:2756 「.js」 data/roco/battle-modes.json 的 parameters.team_size（各模式自己声明能带…' ]`（硬禁词超欠账）。
  证据：① 命中点在 **`src/coach/runtime.js`**（我一行未动）；② 该文件 `git status = M`（**未提交的并发改动**）；③ 本刀 before/after 两轮它都是**绿的**（12/12）⇒ 是这中间由别人引入的。**已登记，请转该文件 owner。**

## 7. ⚠ 未覆盖的同类文案源（登记，本刀不动）

| 位置 | 性质 | 为什么本刀不动 |
|---|---|---|
| `src/client/roco.js:471` `STAT_FIELDS=[['hp','生命'],…]` → `statBlockHtml`（`:478`）⇒ 页面「基础面板」六维 | **玩家可见** | Lead 明确「归 05 实现，避免撞车」；对应判据 `tests/roco-page-ux.test.js:294`（`['生命','物攻',…]`）**必须与 05 同刀改钉** |
| `src/coach/runtime.js:255` `FOCUS_STAT_ORDER=[['hp','生命'],…]` → `focusFactAnswer`（`:391`）⇒ 小芽事实回答里的「资质 **生命** 0 / 物攻 7 …」 | **玩家可见**（coach 侧文案！） | 不在本刀写域，且该文件正被并发修改（`M`）；对应判据 `tests/roco-xiaoya-context.test.js:155` 逐字钉着它。**建议：与 roco.js 那批一起另立一片**（coach 侧 S1–S3 漏网的一处面板属性名） |
| `src/server/opponent.js:35/36`（``消耗 ${cost} 豆`` / ``… HP｜…``） | **玩家可见**（服务端产出） | Lead 说「先别动，我会另排」 |
| `src/coach/player-text.js:83` `hp: ['HP','生命']` | **退役词表本身** | 这是词表定义（列举禁用词），**本来就该保留** |

## 8. 门禁读数（`node scripts/roco/verify-text-vocab.mjs`）

```
语料条目 = 503 | 失败渲染器 = 0 | 覆盖审计 ok = true
玩家可见正文明细命中 = 0 处（HP / 生命 / 豆）
FAIL 语料条数 = 230（9b43bc1 声称）  实际 503      ← 既存，与本刀无关（已转 harness-verifier）
```
⚠ 这个「0」说的是**已审范围**（`src/game/*` + `src/coach/*` 渲染器）。**client 文案仍不在门禁视野内**（本刀新增的 ㉑ 是**结构判据**，不是语料覆盖）⇒ 收编 client 生产者仍按计划交给 `plan00-closer`。

## 9. 交付：`src/client/**` 玩家可见文案的**生产者清单**

- 清单：[`player-text-producers-client.md`](player-text-producers-client.md) —— **157 个 DOM 写入生产者** + **73 个文案表/格式化器**（名字 + 文件:行 + 写入行 + 样例）。
- 生成器：[`player-text-producers.mjs`](player-text-producers.mjs)（可复跑）。
- 接线建议（清单 §C）：① client 侧没有可被 `imp()` 调用的模块导出（文案在 DOM 里拼）⇒ 先做成字符串化入口或给最小 DOM 桩；② **最低成本先收 B 表（标签表）** —— 「面板/属性名」的唯一定义处，退役词一出现就是玩家可见；③ 收编后按 O-44 在 `auditProducerCoverage` 登记 `min`。

## 10. 冻结

| 文件 | sha256 前16 | 字节 | diff |
|---|---|---|---|
| `src/client/app.js` | `046d48bd42cabbcd` | 130949 | 8 / 8 |
| `src/client/xiaoya.js` | `d1db3b6c76a94be8` | 119274 | 2 / 2 |
| `src/client/box.js` | `1e0c567a8caeddf6` | 139766 | 4 / 4 |
| `src/client/box-drawer.js` | `3d854f33ea83f2cc` | 34845 | 2 / 2 |
| `src/server/roco-service.js` | `fd02e4b2f942c691` | 179500 | 2 / 2 |
| `scripts/roco/browser-box-acceptance.mjs` | `4dc32126cca8f0d7` | 176802 | 1 / 1 |
| `tests/roco-box-drawer.test.js` | `dbb4784457308c89` | 46708 | 38 / 2 |
| `tests/roco-box-individuals.test.js` | `30893feaaab9ed8c` | 30529 | 6 / 1 |

`git status --porcelain`（写域内）：上述 8 个 `M` + `reports/…/crosscut/{player-text-migration-s4.md,player-text-producers-client.md,player-text-producers.mjs}` 三个新文件（`??`）。
未跑 git 写命令；未启动/重启服务；未动 `data/**`、`package.json`、`knowledge/**`。
**口径（O-42）**：本刀声称的绿 = §6 那 17 个文件（除并发的 `roco-plain-speak`）+ 门禁退役词 0 命中；**不**声称 `test:unit` 全绿（见 [`testunit-baseline.md`](testunit-baseline.md)）。
