# 批次 1：全部已拥有实例的基础立绘接入（列表 / 详情 / 配队 / 对战）

- **批次**：B1（Codex 长线计划「近期双优先级」A 段的第一刀）
- **版本**：HEAD `2bd5711` + 本批次工作区改动（提交见文末）
- **范围**：只做**基础立绘**的接入与验证。**不做**动作立绘（人类已裁决「舍弃动作立绘、保留动效」），
  **不做**技能特效，**不动**战斗结算、**不动**旧 48 张策展立绘（非破坏性替换，见"未完成"）。
- **模型**：本轮**没有**新增训练、下载或切换默认模型（用户对 4B/27B 的分析尚未确认）。

## 1. 问题与玩家行为的前后变化

| | 之前 | 现在 |
|---|---|---|
| 盒子列表 | 只有迪莫 1 张有官方立绘（本批次之前刚实装），其余画系别 emoji | **24/24 张全部是官方立绘**（截图 `docs/roco/review-2026-09-28/shots/batch01/batch1-01-box-list.png`） |
| 盒子详情 | 只有迪莫有 | 有图就画图（256×256），没有才画 emoji |
| 配队候选池 | 没有头像 | 每行一个立绘（截图 `batch1-03-team-candidates.png`） |
| 配队六槽 | 没有头像 | 六个槽位各一个立绘（截图 `batch1-04-team-slots.png`） |
| 对战 | 只有策展 48 只能出图，其余整块空白 | 走同一个映射；基础立绘**不再因为动作态 404 而消失** |
| 覆盖 | 530 / 542 拿得到抓包图，但**只有 1 只接了页面** | **542 / 542 已拥有实例都有图**（530 抓包 + 12 策展），**没有图 0** |
| 加载体积 | 无管线，直接发 1024×1024 原件（≈ 370–580 KB/张） | 默认发 **256px 预览**（均 53 KB/张）；原件要 `&full=1` 才发 |

## 2. 代码与当前版本

| 文件 | 改了什么 |
|---|---|
| `scripts/roco/fetch-capture-art.mjs` | 资产管线：`--only` / `--all` / `--thumbs-only` / `--check`；原件进 `originals/`（gitignore）、256px 预览进 `thumb/`（入库）；逐张记 `source_url` + 两个 sha256 + 抓包源文件出处；写体积总账 |
| `data/roco/assets/capture-pets/` | 530 条清单 + 530 张预览（**27.0 MB**）；原件 234.9 MB 在 `originals/`（gitignore，可按清单重取） |
| `src/server/index.js` | `/api/roco/sprite` 的抓包回落改成**默认发缩略图**、`&full=1` 发原件、缩略图缺失退原件；响应头带 `X-Roco-Sprite-{Source,Variant,Licence}` |
| `src/server/roco-service.js` | `art` 字段覆盖**抓包 ∪ 策展 48**（那 12 只基线精灵本来就有自己的图，不是借图）；卡片与详情回执都带 |
| `src/client/box.js` `box.css` | 列表卡与详情大头像走 `avatarHtml()`：有图画图、没有画 emoji；`.avatar-art` 样式 |
| `src/client/team-workshop.js` | 候选行、六槽、理论阵容槽位共用 `twArtHtml()`；`state.artBySpecies` 由池子那一趟回执顺手建（不额外请求）；缺图画**明确的空占位**（虚线框 + 首字），不借别的精灵的图 |
| `scripts/roco/verify-capture-art.mjs` | **文件级**全量核对：逐实例 → 路径 / PNG 签名 / IHDR 宽高 / sha256 |
| `scripts/roco/browser-capture-art-decode.mjs` | **浏览器级**全量解码核对 + 字节与耗时实测 |

## 3. 正向 / 反向测试与实测结果

**文件级（不联网）** —— `node scripts/roco/verify-capture-art.mjs`：

```
已拥有实例 542 只：抓包缩略图 530 + 策展立绘 12 = 有图 542；没有图 0
体积：预览合计 27.0 MB、均 53352 字节/张；首页 24 张 ≈ 1238 KB；原件合计 234.9 MB
✔ 路径与解码（文件级）全部通过
```

**浏览器级（真解码）** —— `node scripts/roco/browser-capture-art-decode.mjs`：

```
全部已拥有实例 542 只：解码成功 542，失败 0
合计 43.6 MB（均 84294 字节/张）｜单张解码均 15.5 ms、最慢 40 ms｜整趟墙钟 1.1 s（并发 8）
尺寸分布：{"256x256":501,"384x512":41}
```

落盘读数（`reports/roco/capture-art/decode-sweep.json`，`--json` 那一次的记录；两次跑有正常波动）：
`total 542 / ok 542 / failed []`，`bytes 45,687,398`，`decode_avg_ms 12.24`、`max_ms 35.7`、
`wall_ms 835`。两次都 **0 失败** —— 这一条要的是"有没有解不出来的"，字节/耗时的差异属正常。
（41 张 384×512 是**策展**那套 —— 48 只登记名单里没被撤下的 41 只优先走它们自己的策展图，
这是"不借图"的正确行为，不是同图复用。）

**服务端三条路都实测过**：

| 请求 | 结果 |
|---|---|
| `?id=pet_000004&v=default` | 200 / 45,357 字节 / `X-Roco-Sprite-Variant: thumb` |
| `?id=pet_000004&v=default&full=1` | 200 / 430,997 字节 / `Variant: original` |
| `?id=pet_000112&v=default`（雪影娃娃，策展 48 之一） | 200 / `X-Roco-Sprite-Key: pet-02-雪影娃娃`（老路没坏） |

**页面级**（真机截图，见下）：
- 盒子列表：`卡 24 | 立绘 img 24（加载出来 24）| emoji 0`
- 盒子详情：`立绘 true 256×256`
- 配队候选池：`行 7 | 立绘 7（加载 7）| 空占位 0`
- 配队六槽：`槽位 6 | 立绘 6（加载 6）`，名字 `["喵喵","水蓝蓝","火花","迪莫","水灵","火神"]`

**反向（判据自己的必红方向）**：盒子验收判据 **41** 依旧带三种坏样本
（有 `art` 不画图 / 图画了但 `naturalWidth=0` / 没图的卡留空框），三种都能被同一条判据抓住。

## 4. 实际浏览器截图

| 截图 | 看什么 |
|---|---|
| `docs/roco/review-2026-09-28/shots/batch01/batch1-01-box-list.png` | 盒子列表 24 张全是官方立绘 |
| `docs/roco/review-2026-09-28/shots/batch01/batch1-02-box-detail.png` | 详情页大头像 256×256 |
| `docs/roco/review-2026-09-28/shots/batch01/batch1-03-team-candidates.png` | 候选池每行一个立绘 |
| `docs/roco/review-2026-09-28/shots/batch01/batch1-04-team-slots.png` | 六槽各一个立绘（截图里六只：喵喵/水蓝蓝/火花/迪莫/水灵/火神） |

## 5. 已知未完成（精确缺口）

1. **旧 48 张策展立绘仍在，且仍被优先使用**（41 只）。Codex 计划要求「替换验证后再退出页面依赖，
   不盲删原始文件」—— 本批次**没有**删任何旧文件，也**没有**让它们退出依赖。
   下一步：把 41 只的映射切到抓包图（或确认保留），验证通过后再谈退役。
   > ⚠ **2026-09-29 补丁（§8）**：这一条已被推翻 —— 解析顺序反转成「官方抓包图优先」，
   > 41 只 → 3 只（只有抓包里根本没有的 3 只继续用策展图）。旧文**不删**，作为当时的真实状态留档。
2. **动作态仍不存在**（人类已裁决不要），`b3SwapVariant` 只写标记不换图 —— 已按裁决改完。
3. **首页 24 张缩略图 1238 KB**：比"轻量"的目标偏重。可选项：缩到 192px、或按需只预载首屏可见的几张
   （现在已有 `loading="lazy"`）。**要人类/审阅者选**：视觉优先还是体积优先。
4. **原件 234.9 MB 不在仓库**（gitignore）。换机器要跑一次 `--all` 才能拿回原件；
   预览（27 MB）在仓库里，页面不依赖原件。
5. **素材授权未解决**：许可仍是 UNKNOWN / REFERENCE_ONLY。计划 P1-03 末句明确
   「对外分发前要把素材授权当成发布要求解决」—— 本批次**没有**解决，也不声称解决。
6. **手机版式未实测**（计划要求"桌面和手机实测"）。本批次只跑了 1440×900；390×844 还没量。
   > ⚠ **2026-09-29 补丁（§8）**：已实测 —— 390×844 下 `scrollWidth 390 = innerWidth 390`（不横向溢出）、
   > 24 张立绘全部不撑出卡片（最紧的边距 12px）。截图 `art-03-mobile-390.png`。
7. **不同形态/双属性的抽检截图**还没单独出（候选池截图里能看到「鸭吉吉（蓬松的样子）」等形态，
   但没有单独成组的"形态对照"截图）。
   > ⚠ **2026-09-29 补丁（§8）**：已出 —— 千棘盔 `pet_000271`/`pet_000378` 两张卡各自解出
   > **不同**的 sha256（07dbd5…/74f132…），双系 `pet_000016` 卡片两个系别胶囊 + 自己的图。
   > 截图 `art-04-forms.png` / `art-05-dual-type.png`。

## 6. 下一项（按优先级）

1. **B 段：全部已拥有实例可合法配六只并完成本地训练战斗**（计划里与 A 段并列的另一半）——
   先做**全量逐只最小战斗冒烟**，统计总数 / 成功数 / 精确失败 ID / 失败步骤，并把
   **基础可玩**与**特殊机制核验**分开统计（人类明确：「不能只改标签宣布全可战斗」）。
2. 手机版式实测 + 形态/双属性抽检截图（补 §5.6/5.7 的验收尾巴）。
3. 「培养配置随战斗入口完整传递」与小芽当前对象通路（对应 P0-02 / P0-05），
   这一条与 B 段耦合：进战斗的那份六只/四技能必须与详情页看到的是同一份。


---

## 7. Lead 自纠（2026-09-29，本批次交付之后发现的两处）

1. **截图原先没进仓库**：`.gitignore:79` 有一条 `reports/roco/**/*.png` ——
   我把交付截图写在 `reports/roco/capture-art/`，所以它们**只在磁盘上、clone 下来没有**。
   现已复制到 `docs/roco/review-2026-09-28/shots/batch01/`（这一处不被忽略）并随提交入库。
   上面第 4 节的路径已改成新位置。**给队友的提醒：截图要放 `docs/.../shots/`，不要放 `reports/`。**
2. **浏览器串行锁踩了两个坑**（约定已升级，写在 `tmp/BROWSER-LOCK.md`）：
   ① 第一版只有 `mkdir`，有一把锁被留了 5 分多钟、期间没有任何 Chrome，把四个人全堵住
   ⇒ 现在**必须写 owner（pid + 时间戳）**，且「owner 超 5 分钟 + 无 Chrome」允许任何人清掉；
   ② 我自己把清理写成了无条件 `rm -rf`，而那一刻锁已被队友重新拿上 ⇒ **删了别人的锁**
   （当时没有 Chrome 在跑，没造成碰撞）。正确写法是**只删自己的**（拿不到就一个字都不删）。

---

# 8. 批次 1 补丁（2026-09-29）：官方图优先 + 两档尺寸 + 官方 CDN 补图

> 交付人：`art-finish`（共享任务板 `task-1`）。改前/改后都是**实测读数**，每条都带可复验命令。
> 本节的旧文一律不删：§5.1/§5.6/§5.7 只加日期注记，脚本里的旧断言留在注释里（清单见 §8.6）。

## 8.1 人类裁决与目标

1. **人类 2026-09-29 逐字**：「我看以前我上了自制立绘的还是原来的，你都改成官方吧」
   ⇒ `/api/roco/sprite` 的解析顺序**反转**：先官方抓包图，没有才用策展（自制）图。
2. **人类 2026-09-29 逐字**：「战斗用大比例，用两组图呗」
   ⇒ 一图两档：256px（列表/详情/候选池/六槽，默认）＋ 512px（战斗页，显式 `&size=battle`）。
3. **监工要求（团队实测）**：官方 CDN 对未知 id **不返回 404，而是拿别人的图顶上**
   （73 条里 36 条共用 8 个 sha，其中一张被 10 只共用）⇒ 兜底判定必须**写进脚本**，不能只信 json。

## 8.2 改了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `src/server/index.js`（只动 `/api/roco/sprite` 那一块） | ① 抓包图**优先于** roster-48 槽位策展图；② 新增 `&size=battle` → 发 `battle/` 512px；回落链「要的那档 → 另一档 → 原件 →（非抓包则）策展图 → 404」；③ 响应头 `X-Roco-Sprite-Variant` 现在是 `thumb`/`battle`/`original`。**显式 `key=` 的调用方仍优先**（点名要哪一张，不是回落） |
| `scripts/roco/fetch-capture-art.mjs` | ① `captureIndex()` 加 `game_id` 兜底（基线 12 只只有 game_id，没有 capture_id）；② 新增 512px `battle/` 一档 + `--battle-only`；③ 新增 `--cdn-catalog`（按 game_id 直探官方 CDN）+ `--cdn-dry-run`（只复探不写盘）+ 兜底判定与探测产物对账；④ `--check` 两档都核 |
| `scripts/roco/verify-capture-art.mjs` | ① 文件级两档核对；② 新增 `--server`（逐只打服务端，读回执头 + 响应字节 sha256）；③ 新增 `--catalog`（范围换成图鉴 622） |
| `scripts/roco/browser-capture-art-decode.mjs` | ① 全量解码加**来源核对**与**字节 sha256 核对**；② 加 512 战斗档那一轮；③ 新增 `--shots`（真机截图 + 版式/形态判据）；④ 截图落 `docs/.../shots/batch01/`（`reports/roco/**/*.png` 被 gitignore） |
| `data/roco/assets/capture-pets/` | 565 条清单（530 → 539 基线 9 只 → 565 含 CDN 26 只）；`thumb/` 565 张（28.9 MB）、**新增 `battle/` 565 张（91.6 MB）**、`originals/` 251.7 MB（gitignore） |
| `src/client/box.css` | **没改** —— 手机版式实测本来就通过（读数见 §8.3），没有 CSS 需要修 |
| `src/client/roco.js` | **不在我的写域**：`b3SpriteUrl()` 那一行由 Lead 落（`params.set('size','battle')`），服务端已按该 URL 形式实测 |

## 8.3 读数（改前 → 改后）

**① 文件级**（不联网）：`node scripts/roco/verify-capture-art.mjs`

| | 改前 | 改后 |
|---|---|---|
| 有图 | 抓包 256 档 **530** + 策展 **12** = 542，没有图 0 | 抓包 **539**（其中战斗档 512px **539**）+ 策展 **3** = 542，没有图 0 |
| 列表档体积 | 27.0 MB、均 53352 字节/张；首页 24 张 ≈ **1238 KB** | 27.5 MB、均 53419 字节/张；首页 24 张 ≈ **1238 KB** |
| 战斗档体积 | （不存在这一档） | **87.0 MB、均 169320 字节/张** |
| 原件 | 234.9 MB | 251.7 MB |
| 门禁 | ✔ | ✔ |

**② 服务端逐只**（`--server`，542 只，两次请求/只）：

| | 改前（旧顺序） | 改后（官方优先） |
|---|---|---|
| 来源 | 抓包 **501** + 策展 **41** | 抓包 **539** + 策展 **3** + 明确没有 0 |
| 默认档尺寸 | `{"256x256":501,"384x512":41}` | **`{"256x256":539,"384x512":3}`** |
| 与官方优先口径的不符 | **29 条**（名单里有官方图却发自制图，判据红） | **0 条**（✔） |
| 战斗档 `&size=battle` | — | **539 只全 512×512、Variant 全 `battle`、均 169320 字节、0 不符** |
| 字节核对 | — | 每只响应的 sha256 = 磁盘那张的 sha256（0 条不符） |

**③ 浏览器真解码**（`browser-capture-art-decode.mjs --json`）：

| | 改前（`decode-sweep-before-2026-09-28.json`） | 改后（`decode-sweep.json`） |
|---|---|---|
| 解码 | 542/542、失败 0 | 542/542、失败 0 |
| 尺寸分布 | `{"256x256":501,"384x512":41}` | **`{"256x256":539,"384x512":3}`** |
| 来源 | （当时没记） | `{"capture":539,"curated":3}`，来源不符 **0**、字节 sha256 不符 **0** |
| 战斗档 | — | **539 张 512×512、失败 0、sha256 不符 0**，合计 87.0 MB、整趟墙钟 2.7 s（并发 8） |
| 字节/耗时 | 45.7 MB、均 84294 字节/张 | 27.5 MB（默认档）、均 53419 字节/张、单张解码均 18.3 ms |

**④ 图鉴 622 条**（`--server --catalog` + 页面回执 `art` 字段）：

| | 改前 | 改后 |
|---|---|---|
| 服务端解析 | 抓包 530 + 策展 10 + 明确没有 82 | 抓包 **565** + 策展 **10** + 明确没有 **47** |
| 页面回执 `art=true` | 549 / 622 | **575 / 622**（`catalog-art-coverage.json`） |

> 改后 575 而**不是** 576：少的正是 §8.5 第 3 条那只 —— 它被兜底判定扣下了。

**⑤ 谁被切了**（`sprite-resolution-diff.json`，改前/改后两份 JSON 逐只对比）：
**38 只从策展图切到官方抓包图**（29 只可玩层 + 9 只基线新抓）；策展 41 → 3。
逐只样例：`pet_000012 铠甲虫` 472780 字节 384×512（`pet-30-铠甲虫`）→ 71024 字节 256×256（capture_id 3012）；
`pet_000062 音速犬` 499888 字节 384×512（`pet-01-音速犬`）→ 66611 字节 256×256。

**⑥ CDN 补图对账**（`cdn-catalog-ingest.log` / `cdn-catalog-recheck.log`）：
73 条直探 → **真图 26 / 兜底 37 / 没有 10**；与团队探测产物 `cdn-probe.json` 逐条对账，
**只有 1 条结论不同**（`pet_000562`，原因见 §8.5）。

## 8.4 截图（5 张，都在 `docs/roco/review-2026-09-28/shots/batch01/`）

| 截图 | 看什么（伴随的真实读数） |
|---|---|
| `art-01-list-official.png` | 全部精灵第 3/26 页：音速犬 → `id=pet_000062`、`capture`、256×256、sha `a31a45…` |
| `art-02-detail.png` | 雪影娃娃详情（点卡片进二级页）：`id=pet_000112`、`capture`、256×256、sha `08dd8d…` |
| `art-03-mobile-390.png` | 390×844：`scrollWidth 390 = innerWidth 390`；24 张立绘 0 张撑出卡片（最紧 12px）；0 张未解码 |
| `art-04-forms.png` | 同名形态：千棘盔 `pet_000271`（capture_id 3332，sha `07dbd5…`）与「千棘盔（磨损的样子）」`pet_000378`（capture_id 3477，sha `74f132…`）**各自一张、字节不同** |
| `art-05-dual-type.png` | 双系：蹦蹦种子（海神球形态）`pet_000016` 卡片两个系别胶囊（草系｜毒系）+ 自己的官方图（sha `7a8ae2…`） |

判据脚本 `browser-capture-art-decode.mjs --shots` **exit 0**，读数落在 `reports/roco/capture-art/shot-checks.json`。

## 8.5 精确缺口（诚实单列，一条都不含糊）

1. **3 只基线精灵继续用策展图**：银月狼王 `pet_000608` / 圣凯布米龙 `pet_000601` / 月使鹭纳 `pet_000611`
   —— 它们的抓包原始回执**根本不存在**（`data/roco/raw/hke-2026-09-27/raw/pet-<game_id>-*.json` 没有这三份），
   服务端实测仍发策展图（`X-Roco-Sprite-Key: pet-11-银月狼王` 等）。
2. **图鉴 47 条没有图**（622 − 575）：36 条 CDN 兜底 + 10 条 CDN 404 + **1 条被扣**。
   这 47 条页面画明确的空占位，不借别的精灵的图。
3. **`pet_000562` 千棘海针（磨损的样子）被我扣下**（团队探测把它算成"真图"，我只算 26 而不是 27）：
   CDN 给它的字节与**已有** `pet_000545` 千棘海针的官方图**逐字节相同**（sha `24bffa5e7c59…`）
   ⇒ 按团队自己写下的规则「同一 sha 被 ≥2 只共用 ⇒ 判兜底」，它属于共用图，不入库；
   否则页面会在「磨损的样子」这个标签下显示普通千棘海针的图。**霜翼领主的三个季节形态同理**
   （sha `5694ad6b…` 与已有 `pet_000547` 相同）。复核命令：`node scripts/roco/fetch-capture-art.mjs --cdn-catalog --cdn-dry-run`。
4. **`src/client/box.js` 两处缺口（不在我的写域，只报不改）**：
   ① **默认档「全部精灵」的卡片没有 `data-detail`** —— 点击处理器只认 `[data-detail]`，
   所以在默认视图**点卡片进不了详情**（实测 `viewAfterClick=list`；`data-detail` 计数 0）。
   「我的盒子」档走分组抽屉、行上有 `data-detail`，能点（本次 ②/⑤ 走的就是那条路）。
   ② **深链到"不在当前页"的那一只没有立绘** —— `?pet=pet_000012`（第 1 页）正常出图；
   `?pet=pet_000112`（第 5 页）大头像 `src` 是空 id ⇒ 服务端 404 ⇒ 详情页没有立绘。
   两处读数都在 `reports/roco/capture-art/shot-checks.json` 的 `⑥ 缺口读数*`。
5. **战斗页 512 的页面级读数还没拍**：服务端侧已实测（URL 形式
   `?id=pet_000004&name=迪莫&v=default&size=battle` → 200 / 149192 字节 / 512×512 / `Variant: battle`），
   `src/client/roco.js` 那一行也已由 Lead 落在工作区；**但"战斗页上真的变大了"这张截图没有**（留给下一项）。
6. **素材授权仍未解决**：许可 UNKNOWN / REFERENCE_ONLY（565 条逐张记 `source_url` + sha256）。
   本批次**没有**解决，也不声称解决。
7. **预览仍是 PNG，不是 WebP**：这台机器上 `sips` 没有 WebP 写支持，也没有 `cwebp/ffmpeg/magick`，
   本项目不装图像库；透明底 + 深色页面 ⇒ JPEG 会留白框。这一条如实记在 manifest 里。
8. **CDN 那 26 只的出处类型与抓包那 539 只不同**：`source_kind: 'cdn-image'`（按 `game_id` 直取官方 CDN），
   没有抓包原始回执可挂；逐张仍记 `source_url` + 两个 sha256 + 判定依据。
9. **重启后健康检查是"降级"**：`node scripts/roco/healthcheck.mjs` exit 2 —— http/data/engine/sprite 全绿，
   只有云端模型 `connected=false`（没有 API key）。与本批次改动无关，但不写成"全绿"。
10. **那 46 条「实在不行就算了」**（人类裁决）：47 条无图里除 `pet_000562` 之外的 46 条，
    连本体图都没有（36 兜底 + 10 个 404）；不引图像生成模型，继续明确占位。

## 8.6 改钉清单（旧断言一律留档，不删）

| 位置 | 旧口径（留档） | 新口径 |
|---|---|---|
| `src/server/index.js` `/api/roco/sprite` | 先 `slotOfPetId → asset_key` 定策展 key，只有 `!key \|\| !known.has(key)` 才试抓包图（旧顺序**逐字留在注释里**，含后果读数 41 只） | 抓包图优先；策展图只兜底 |
| 同上 | 只有一档预览（`thumb` / `original`） | 两档：`thumb` 256 默认 / `battle` 512（`&size=battle`） |
| `scripts/roco/fetch-capture-art.mjs` | `captureIndex()` 只读 `capture_id ?? captureId`（旧行留在注释里） | 再兜 `game_id`（依据：可玩层 530 条 `capture_id === game_id` 逐条相等） |
| 同上 | `makeThumb(src, tmp)` 固定 256；`--thumbs-only` 只补 256 | `makeThumb(src, tmp, px)`；新增 `--battle-only`（`--thumbs-only` 语义**没变**） |
| `scripts/roco/verify-capture-art.mjs` | 2026-09-28 版口径（只 256 一档、`--server` 只打默认档）**写在文件头留档** | 两档都核 + `--server`/`--catalog` |
| `scripts/roco/browser-capture-art-decode.mjs` | 旧 `by_status` 期望值 `{"256x256":501,"384x512":41}` **写在文件头留档** | `{"256x256":539,"384x512":3}` + 来源/字节核对 |
| 本文档 §5.1 / §5.6 / §5.7 | 原文保持不动 | 各加一条 2026-09-29 日期注记（指向本节） |

## 8.7 可复验命令（逐条，读数见 §8.3）

```sh
# 文件级（不联网，两档都核）
node scripts/roco/fetch-capture-art.mjs --check
node scripts/roco/verify-capture-art.mjs

# 服务端逐只（真解析：来源 + 两档尺寸 + 响应字节 sha256）
node scripts/roco/verify-capture-art.mjs --server            # 已拥有 542 → 539 + 3
node scripts/roco/verify-capture-art.mjs --server --catalog  # 图鉴 622 → 565 + 10 + 47

# 浏览器（先抢锁：tmp/BROWSER-LOCK.md；两条都跑 ≈ 3 分钟）
node scripts/roco/browser-capture-art-decode.mjs --json      # 全量解码 + 来源 + 512 档
node scripts/roco/browser-capture-art-decode.mjs --shots     # 真机截图 + 版式/形态/双系

# 单条 URL 的出处头（一眼看服务端发的是哪一档）
curl -s -D - -o /dev/null "http://127.0.0.1:8765/api/roco/sprite?id=pet_000062&v=default"               # Variant: thumb
curl -s -D - -o /dev/null "http://127.0.0.1:8765/api/roco/sprite?id=pet_000062&v=default&size=battle"   # Variant: battle
curl -s -D - -o /dev/null "http://127.0.0.1:8765/api/roco/sprite?id=pet_000608&v=default"               # 策展兜底（3 只之一）
```

产物：`reports/roco/capture-art/` 下 `sprite-resolution-{before,after}.json`、`sprite-resolution-catalog.json`、
`sprite-resolution-diff.json`、`decode-sweep.json`（改后）、`decode-sweep-before-2026-09-28.json`（改前留档）、
`shot-checks.json`、`catalog-art-coverage.json`、`cdn-catalog-{ingest,recheck}.log`、`file-level-{before,after}.log`、
`battle-backfill.log`；截图在 `docs/roco/review-2026-09-28/shots/batch01/`（`reports/**/*.png` 被 gitignore）。

## 8.8 下一项

1. **战斗页 512 的页面级读数**（截图 + `img.naturalWidth=512`）：客户端那一行已落，服务端已验，缺页面证据。
2. **`src/client/box.js` 两处缺口**（§8.5.4）：默认档卡片补 `data-detail`；二级页的卡片查找加
   「服务端详情回执的 `group`」兜底 —— 两处都影响"玩家能不能看到详情与立绘"。
3. **3 只策展 + 47 条无图**：只能等官方补图或授权解决；不引图像生成模型。
4. **授权**（UNKNOWN / REFERENCE_ONLY）与 **WebP**：两条都还是外部依赖/工具限制，不是代码问题。
