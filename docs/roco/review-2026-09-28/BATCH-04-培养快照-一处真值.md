# BATCH-04 培养快照：刷新要真的改变屏幕上的数值（一处真值）

- **任务**：共享任务板 `task-4`（人类 2026-09-29 近期清单第三项的前半）
- **人类原话**：「刷新天分没效果，刷新性格没试过但也要检查下」（A7）
- **Codex 体检**：P0-02「One BuildSnapshot for cultivation, team, coach and battle」
- **做的人**：build-snapshot（队友），2026-09-29
- **状态**：前半做完（本文），**未做**的部分写在最后一节，一条都没含糊

---

## 1. 复现（改之前，真机读数）

命令（**先抢浏览器锁**，见 `tmp/BROWSER-LOCK.md`）：

```sh
node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag before
```

读数（`reports/roco/build-snapshot/a7-before.json`，`own-0001`，屏幕文字逐字）：

| 步骤 | 「性格」 | 「资质」 | 「天分档位」 | 「六维（60 级）」 |
|---|---|---|---|---|
| 刷新前 | 稳重 | 生命 7 / 物攻 0 / 物防 0 / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 物防 338 = 种族 49 **+10** |
| 点「刷新天分」后 | 稳重 | **一个字都没变** | 相当好的天分 | 物防 338 = 种族 49 **+10** |

- 截图：`reports/roco/build-snapshot/a7-before-2-after-refresh-talent.png`
- 同屏两套数（这一张图上肉眼可见）：**「资质 物防 0」** 与 **「六维 物防 种族 49 +10」**；
  状态行还写着「上一次刷天分（第 1 级）：+10 加到「物防」（**结果就在这一页上**）」。
- 旧判据为什么是绿的：验收 28 号量的是 `localStorage` 的计数 + 那行小字
  （`scripts/roco/browser-box-acceptance.mjs:1534`），**没有量屏幕上的资质数值**
  —— 即 `docs/roco/review-2026-09-28/README.md` §B4 表格第三行那一条。

**根因复核结论**：根因属实，但**方向要按 Codex 的纠正重写**——
按钮**不是完全假的**（「六维（60 级）」那一栏读的是本机记录，刷新之后它真的会变），
坏的是**语义与传播**：同一屏上「性格与资质」读**服务端回执**、面板读**本机记录**。
两处代码位置：

- `box.js` 的 `petBodyHtml(player, individual)`：`性格/资质/天分档位` 取自 `player.traits`
  （= `?detail=` 回执，`roco-service.js` 的 `withIndividualGrowth` 按 `instance_id` **现算的纯函数**，没有写路径）；
- `box.js` 的 `panelGrid(rows, individual)`：天分与性格取自**本机记录**（`roco.box.individuals.v1`）。

⇒ 刷新只改本机记录 ⇒ 屏幕上「资质」两个字永远不动；回滚同理。

---

## 2. 哪一份是真值，为什么

**培养那四样（性格 / 六项资质 / 天分档位 / 60 级面板）以「本机记录」为唯一真值。**
三条理由，每条都能当场复验：

1. **只有它记得玩家做过什么。** 刷新/回滚的写路径就是本机记录（`refreshIndividual` /
   `undoIndividual`）；服务端那份是 `individualFromInstance(instance)` 的**纯函数**结果，
   没有任何写路径、也没有 `talent_boosts`。以服务端为真值 = 宣布这两个按钮永远是假的（那就是 A7）。
2. **没刷过的时候两份逐值相等** ⇒ 换真值**不改变任何一只的初始显示**。
   服务端 `withIndividualGrowth` 与本机 `individualFor` 都落到 `rollNatureAndTalent(instance_id)`
   —— 同一个函数、同一个种子。实测 `own-0001` 两边都是
   `稳重 / 生命7 物攻0 物防0 魔攻10 魔防0 速度9`（判据 `tests/roco-box-individuals.test.js` ⑳①②）。
   > 这条不等式**只在数据里 `nature`/`talent` 非空时**才可能不成立：`data/roco/owned/owned-pets.json`
   > 542 条**全是 `null`**（已核：`nature non-null: 0 / talent non-null: 0`）⇒ 现状下恒等。
   > 哪天小黑盒那份导出了真值，两边会分叉 —— 那时要改的是 `box-individuals.js` 的
   > `individualFor`（让它先吃数据集里那一份，再掷缺的那一份），不是这一层。
3. **服务端那份连"刷过"都不知道** ⇒ 同屏并排必然出现两套数（截图里那处 `+10`）。

服务端回执**仍然是真值**，但只管它独有的**物种冻结事实**：名字 / 系别 / 立绘 / 种族值 /
四个技能 / 特性简介。两者在 `buildSnapshotOf()` 里拼成**一份** `petBuild`，这一屏只画这一份。

**两个投影，一份记录**（不是两个来源，写在这里免得下一个人误会）：

- 「资质」= **现值**（含玩家刷出来的 `talent_boosts`）—— 与 60 级面板的输入**同一批数**；
- 「天分档位」= 把 `talent_boosts` **扣掉**那一份（"抓到时是什么天分"）—— 与列表行
  `box-drawer.js` 的 `traitChips` 同一口径。不扣的话：刷新天分每次都落在**当前是 0** 的项上，
  加满三级会把"激活条数"顶到 4 条以上 ⇒ `talentTierOf` 只能返回「认不出」，档位这一栏就死了。

---

## 3. 改了什么（全部在 task-4 的写域内）

| 文件 | 改动 |
|---|---|
| `src/coach/individuals.js` | 新增导出 `cultivationOf(individual)`：培养快照的唯一投影（现值 / 抓到时那一份 / 档位 / 剩余次数）。纯函数，Node 判据可直接钉 |
| `src/client/box.js` | 新增 `buildSnapshotOf()` + `petTraitsOf()`：**一份**快照；`petBodyHtml`/`panelGrid` 改成只吃快照；`renderPetPage` 只拼一份；`mountLoadout` 的技能也取自快照；`state.petBuild` + `#pet-view[data-build-cultivation]` 钩子；`data-talent-raw` 从"慢一帧"改成渲染后读 |
| `src/client/box.js`（状态行） | 「（结果就在这一页上）」**留着**，因为它现在**是真的**了（改钉记录写在那一支的注释里） |
| `src/client/box.js`（物种页） | 图鉴那一档（`?pet=pet_XXXXXX`，没有个体）**不再**拿物种编号掷天赋去算 60 级面板：标题改成「六维（种族值）」、提示换成 `PANEL_NOTE_SPECIES`、性格/资质/档位整段不画（判据 C7） |
| `tests/roco-box-individuals.test.js` | 新增 ⑳（A7 数据链路：变、逐值还原、服务端那份不变、指纹语义）与 ㉑（形状/现值口径不抛） |
| `tests/roco-box-redo.test.js` | 新增 ㉔（静态接线：一处真值，防回退）＋ ㉕（六维那一栏不许自相矛盾）；① 里那条 `六维（60 级）` 改钉成 `六维（60 级 · 估算）`（旧断言留档在注释里） |
| `tests/roco-box.test.js` | 别人给目录卡加了 `level`（A3）顶红了「卡片首层的键」那一句 ⇒ 按本仓「多一个键就要显式登记」把 `level` 登记进键表（旧键表留档），并加一条「`level` 只能是数字或 null」 |
| `src/coach/individuals.js` | 新增导出 `cultivationFingerprint()`（跨模块同一份内容指纹）＋ `cultivationOf()` 带出 `fingerprint`/`revision` |
| `reports/roco/build-snapshot/**` | 真机判据脚本 + 读数 JSON + `SUMMARY.md`（新建） |
| `docs/roco/review-2026-09-28/shots/build-snapshot/**` | 真机截图（按 Lead 口径：**不放** `reports/roco/**`，那里被 `reports/roco/**/*.png` 挡在仓库外） |

**没动**：`src/server/**`、`src/client/box.css`、`data/**`、`box-drawer.js`、`box-individuals.js`
（这条任务里它们不需要改）、`scripts/roco/browser-*.mjs`。**没有** `git add` / `git commit`。
**没有**新增训练、没有下载模型、没有切默认模型。

---

## 4. 改之后（真机读数）

```sh
node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag after
```

| 步骤 | 「性格」 | 「资质」 | 「天分档位」 | 备注 |
|---|---|---|---|---|
| 刷新前 | 稳重 | 生命 7 / 物攻 0 / **物防 0** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | 与 `?detail=` 回执逐值一致 |
| 点「刷新天分」后 | 稳重 | 生命 7 / 物攻 0 / **物防 10** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | **肉眼可见地变了**；面板「物防 种族 49 +10」同步 |
| 点「回滚」后 | 稳重 | 生命 7 / 物攻 0 / **物防 0** / 魔攻 10 / 魔防 0 / 速度 9 | 相当好的天分 | **逐值**回到刷新前（含面板） |
| 点「刷新性格」后 | **踏实** | （不变） | **了不起的天分** | 档位随现值性格变（性格长处落在被激活的三项里）；面板同步变 |

判据（`a7-after.json`）：**C1–C7 全绿**（C6 是必红反证，C7 是物种页不许编数字）。

截图（**同一只 `own-0001`，同一屏**；全部在 `docs/roco/review-2026-09-28/shots/build-snapshot/`）：

- 刷新前：`a7-after-1-before-refresh.png`
- 刷新天分后：`a7-after-2-after-refresh-talent.png`
- 回滚后：`a7-after-3-after-undo.png`
- 刷新性格后：`a7-after-4-after-refresh-nature.png`
- 物种页（图鉴那一档）：`a7-after-5-species-page.png`
- 「六维」那一栏的标注（裁剪）：`a7-after-6-panel-is-estimate.png`
- 改之前那四张（**同一批判据、同一只、真机拍的**，脚本落盘时还没改代码）：`a7-before-1..4-*.png`

---

## 4b. 六维那一栏的「前后矛盾」（Codex 在 `box.html?pet=own-0004` 实测）

**现象**：同一屏上 ① 「六维（60 级）」+ 一串换算出来的数字（读起来像精确结论）；
② 末尾又写「……换算公式还没校准，所以盒子里只给迁移层登记过的种族值，**不给伪精确的成品数值**」。
两句一前一后就是打架；而且页面明说引擎不是用这份数值。

**改成什么样**（Lead 转达 Codex 的口径，采用 a：明确标成推导值 + 视觉上分开）：

```
六维（60 级 · 估算）  [推导值]
 生命 495 / 物攻 125 / …            ← 数字照旧给（面板是活的，不该删）
 这是推导值（估算），不是游戏里的成品数值：主数按 60 级公式换算，前提是
 「60 级 · 默认 5 星 · 零突破」这三条（这套换算还没校准，前提也没在游戏里核验过）。
 下面一行是它的两个输入：种族值（静态登记）与这一只的天分（黄色）。
 引擎对战里用的不是这一份 —— 「培养出来的数值有没有真的进到队伍/对战」这条链
 还没验证过，所以这一栏不能当结论用。
```

- 标题写「**估算**」+ 复用页面已有的 `tag-badge` 徽标写「**推导值**」（`box.css` 不在我的写域 ⇒ 一个 CSS 都没新增）；
- 那句服务端的「不给伪精确的成品数值」**只在算不出推导值的时候画**（`panelReasonHtml()`），
  有数字时不再画 —— 两句话从此不会一前一后出现（判据 C9 + `tests/roco-box-redo.test.js` ㉕ 钉着）；
- 物种页那一档照旧不算面板，标题「六维（种族值）」。
- ⚠ 玩家可见文案里的硬禁词「本仓」不许出现（Lead 抓到 353/362 那两行）⇒ 改成「**这套换算**还没校准」。
  判据：`node --test tests/roco-plain-speak.test.js` → **12/12 绿**（改前红 1 条）。

看图：`docs/roco/review-2026-09-28/shots/build-snapshot/a7-after-6-panel-is-estimate.png`
（同一屏上「估算 / 推导值 / 三个前提 / 引擎不用它 / 未验证」与六项数字一起可见）。

## 4c. 三件事**分开写**（Lead 转达 Codex：「不许用刷新界面通过了就报贯通完成」）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| ① | 刷新**界面**对不对 | **已修、已真机验**：点「刷新天分」屏幕上的资质当场变、回滚逐值还原、刷新性格连档位一起变 | C1–C5（真鼠标 + 逐字符比屏幕文字）＋截图 |
| ② | 页面这份数值**来自哪一份真值** | **本机记录**（`roco.box.individuals.v1`，经 `cultivationOf`）；服务端回执只管物种冻结事实 | C4（屏幕 == 本机记录）＋ §2 的三条理由 |
| ③ | 这份真值**有没有真的进到队伍/战斗** | **未验证**。页面上的数字**不是**引擎对局用的那一份（页面自己就这么写着）；这条链的实证由 `battle-smoke` 负责，我这边**没有任何实测**，**不主张已贯通** | 缺口 §7 第 1–2 条 |


## 5. 判据（量屏幕，不量状态）

| 号 | 量什么 | 反证 |
|---|---|---|
| C1 | 点「刷新天分」前后，`#pet-body` 里**「资质」那一行的文字**必须不同 | 前后相同的坏数据必须报错 |
| C2 | 同一次刷新后「六维（60 级）」那一栏的文字必须变 | 同上 |
| C3 | 「回滚」之后资质/性格/档位/面板**逐值**回到刷新前 | 只还原一半的坏数据必须报错 |
| C4 | 屏幕上的性格与六项资质 **== 本机记录那一份**（同屏只有一个来源） | 来源不一致必须报错 |
| C5 | 「刷新性格」之后屏幕上的性格必须变（人类："没试过但也要检查下"） | —— |
| C6 | 上面四条喂坏数据必须全部报错 | 本身即反证 |
| C7 | 物种页一个新数字都不许编（无性格/资质/档位/等级） | 塞"性格+资质+Lv.60"必须报满 3 条 |
| C8 | 页面暴露 `data-build-fingerprint` / `data-build-revision`：刷新要变、回滚要变回去、计数只增不减 | 喂"刷新前后同一个指纹"必须报错 |
| C9 | 六维那一栏：标题写「估算」+「推导值」徽标 + 三个前提 + "引擎不用它 / 那条链未验证"，且**不许**同时出现"不给伪精确的成品数值" | 喂"旧标题 + 两句并存"的样本必须报错 |

### 跨模块（Lead 转达 Codex 的第一条）—— 我这半做了什么、哪半不是我的

`xiaoya.js` 的 `createFocusProvider` 原来只在 `snapshotId` 变化时拉详情，而**同一只**刷过之后
`snapshotId` 不变 ⇒ 小芽读旧的那一份。我这边**只做页面那一半，没碰 `xiaoya.js`**（不是我的写域）：

- `src/coach/individuals.js` 导出 **`cultivationFingerprint(individual)`**（唯一一处实现）：
  `id=…|nature=…|talent=hp7.atk0.spa10.def0.spd0.spe9|boosts=1:def:10`（六项按 `STAT_KEYS` 固定顺序；
  **不含** `rolls` ⇒ 回滚之后逐字回到刷新前那一份）；
- `cultivationOf()` 另带 **`revision`** = `rolls.nature`.`rolls.talent`（**只增不减**，回滚不动它）
  ⇒ 消费方的失效条件建议是 **`snapshotId` + `fingerprint` + `revision` 三个一起看**
  （指纹认"内容变过"，计数认"刷过又退回去"这种净效果为零的操作）；
- 页面钩子（`#pet-view`）：`data-build-fingerprint` / `data-build-revision` / `data-build-cultivation` /
  `data-talent-raw`；再加 `#pet-traits` 里那三行的文本。
- 契约与用法已发给 `coach-context`（消息 `team-message-bfe9f52e`）。
  **小芽回答逐值一致那条验收不在我这里、我也没有假装跑过** —— 由他那边的脚本负责。


## 6. 判据改钉记录（改钉不删）

- `browser-a7-refresh-proof.mjs` 是**新增**判据，没有删改任何旧断言。
- `tests/roco-box-redo.test.js` 只**追加** ㉔；①–㉓ 一行未动。
- `tests/roco-box-individuals.test.js` 只**追加** ⑳/㉑；①–⑲ 一行未动。
- `box.js` 里删掉的两处旧写法（`petBodyHtml(unwrapGrowth(player), individual)` 与
  没回执时另写一套 HTML）**都留了注释**说明日期、依据与它们错在哪；㉔ 里还有反证
  `assert.doesNotMatch` 钉着它们不许回来。

## 7. 缺口（**没做**的，一条都不含糊）

0. **「培养 → 队伍/战斗」有没有贯通：未验证。** 我这一轮只证明了**界面**上的数字会变、
   以及**页面这一屏**的数值来自本机记录。**没有**任何证据表明这份数值真的进了工坊/引擎对局
   （页面自己就写着"引擎对战里用的不是这一份"）。进战斗那条链的实证归 `battle-smoke`，
   我对不上就以他为准 —— **不主张已贯通**。
1. **服务端 `?detail=` 回执在本机刷过之后仍然是"抓到时"那一份**（`nature`/`talent`/`天分档位`
   都是现算的纯函数）。这一屏**已经不信它**（`buildSnapshotOf` 只从回执里取物种冻结事实 +
   `特长/血脉` 两栏），但它还是会被别的消费方读到（例如回答层、比较页、工坊）。
   **真正的一处真值要把快照传到服务端**（P0-02 的完整形态：`revision` + 冲突处理 +
   回执里带玩家编辑的 overlay），那要动 `src/server/**`，**不在本任务写域内**，没做。
2. **跨页一致性没做**：工坊（`roco.html?team=`）与对战读的仍然是自己那一路；刷过天分之后
   带这一只去配队，工坊那边算的仍是"抓到时"那一份。这是 P0-02 的"team stores instance + snapshot/revision"，没做。
3. **多个标签页/多设备**：本机记录是 localStorage，另一个标签页刷了不会通知这一页
   （`storage` 事件没接）。P0-02 的"test reload and duplicate-tab consistency"没做。
4. **性格刷新的 1/30 同名概率**：`rollNature` 可能掷回原来那条性格 —— 那一刻屏幕上确实"没变"，
   状态行会说「换成了「稳重」」（诚实，但玩家可能觉得又是假的）。判据 C5 是单次判定，
   理论上 1/30 会假红（我这一轮五次运行都没遇到）。**没改掷点规则**（改它会动到
   `src/coach/individuals.js` 里已被多处钉住的语义），只在这里记下来。
5. **`天分档位` 那一栏在"认不出档位"时整行不画**（沿用人类 2026-09-28「没有就删掉啊」的口径）。
   现在 542 只都读得出档位，所以看不出来；如果将来出现激活 4 条以上的记录，那一栏会**静默消失**
   而不是写一句"认不出" —— 这是旧口径的延续，我没有改它。

## 8. 可复验命令汇总

```sh
# 抢浏览器锁（owner 必写，见 tmp/BROWSER-LOCK.md）；全仓同一时刻只许一个浏览器任务
if mkdir tmp/browser-lock 2>/dev/null; then printf '%s %s\n' "$$" "$(date +%s)" > tmp/browser-lock/owner; fi
node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag after   # C1–C9（截图落 docs/…/shots/build-snapshot/）
rm -rf tmp/browser-lock

node --test tests/roco-box.test.js tests/roco-box-redo.test.js \
  tests/roco-box-individuals.test.js tests/roco-box-drawer.test.js          # 要求的那四条 → 58/58 绿
node scripts/roco/browser-box-acceptance.mjs                                # 本页那 41 条（回归）→ 41/41 绿
```

读数：见 `reports/roco/build-snapshot/SUMMARY.md`。

**顺带**：期间 `tests/roco-box.test.js` 的「卡片首层的键」被**别人**在 `src/server/roco-service.js`
里新增的 `level`（A3「pvp选精灵看不到等级？」）顶红了一次。那条断言在我的写域里 ⇒ 按本仓
「多一个键就要显式登记」的约定把 `level` 登记进键表（旧键表留档 + 日期 + 依据），并加了一条
「`level` 只能是数字或 null」。**没有动服务端文件。**
