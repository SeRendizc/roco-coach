# 分计划 08 · S1 冻结证据：配招记录从**物种级**改到**个体级**（G01）

**执行**：`plan01-engine`（task-19） · **时间**：2026-09-30 23:0x–23:3x（Asia/Hong_Kong）
**性质**：S1 = 缺口 **G01**（同物种两只个体共用一份配招）的修复 + 旧记录兼容读取。
**授权**：Lead 裁决 **Q1/Q2** + STATE **D-25**（08 正式进入条件（07 通过）之前批准的**窄例外**：
这是现有行为的**数据正确性缺陷**、**不消费 05/06/07 的任何产物**、且正是 08 必做反例②的对象）。
**S2–S5 未做**（仍受门槛约束，等 07 通过后另行放行）。

---

## 1 · 改了什么（写域内 6 个文件）

| 文件 | 改动 | sha256 前16 | 字节 | diff（+/-） |
|---|---|---|---|---|
| `src/client/loadout-store.js` | 新增 v2 个体级 API（键 `roco.workshop.loadouts.v2`）、`SPECIES_SCOPE_NOTE`、`resolveLoadout`（个体级优先 + 旧键兼容）、`teamLoadouts`（队级解析 + 来源标注）；**v1 的读写语义一字未改** | `ce928eef509968bf` | 13256 | +167 / −1 |
| `src/client/box-loadout.js` | 读走 `resolveLoadout`（个体级优先；读到旧物种级记录**如实标注**）、保存写**个体级**键（不再写旧键）、来源句唯一实现 `seedNoteText()` | `df8fed16b037e3d3` | 60573 | +35 / −10 |
| `src/client/team-workshop.js` | 引新 API；新增 `instanceForSpecies()`（按物种唯一解析实例）与 `overlayIndividualLoadouts()`（`load()` 之后叠个体级）；**4 个写入点**全部改个体级；撤销改 `clearIndividualLoadout` | `7d45f16e7b0f5ca4` | 253082 | +60 / −8 |
| `tests/roco-loadout-integration.test.js` | 新增 ④/④b/④c 三条 S1 判据（含两向变异）；① 结构钉扩到**两代键** | `9361967afaa7a141` | 14443 | +94 / −3 |
| `tests/roco-box-loadout.test.js` | ③e **改钉**（个体级键 + 旧键不许被写）+ ③f 新增「物种级」标注断言 | `e433c22476cabaff` | 50845 | +21 / −6 |
| `tests/roco-workshop.test.js` | 两处**改钉**（import 行、保存写回、应用写回）+ 键字面量结构钉扩到 v2 | `2a987b16aa0a6082` | 92407 | +33 / −8 |

> ⚠ **`src/client/roco.js` 也出现在 `git status` 里（+149/−30），那不是我的** —— 我从未编辑它
> （Q5 明写「要改 `src/client/roco.js` 先回报」，我没有动）。它是**别人的在飞改动**（plan02-front 的域）。
> 同一时刻 `roco/src/roco_env/{planner,service}.py` 与 `roco/tests/test_plan_scenarios.py` 的在飞改动同理。

**红线遵守**：`data/**` 只读（未写、未删；两个探针只 `readFileSync`）；验收只用**内存假 storage**
与 `E:\roco-scratch\base2` 的 `git archive` 隔离副本；**未**启动/重启 8765；**未**训练；未碰 README/roadmap；
**未用 git 写命令**（`archive` 是只读 plumbing，只写 tar 到 scratch）。

---

## 2 · 设计（Lead 裁决 Q2 的逐条落点）

| Q2 要求 | 落点 |
|---|---|
| **新键 + 兼容读取，不删旧键** | v2 = `LOADOUT_STORE_INDIVIDUAL_KEY`（键 = `own-…`）；v1 `LOADOUT_STORE_KEY`（键 = `pet_…`）**只读**保留；`resolveLoadout()` 先查个体级、再回退旧物种级 |
| ① 读到旧记录**如实标注** | `SPECIES_SCOPE_NOTE = '物种级（未区分个体）'`（唯一实现）；盒子状态行由 `seedNoteText()` 拼；队级解析把 `scope/note` 带出来 |
| ② 下次编辑写个体级新键（**单向迁移、幂等**） | 产品 5 个写入点全部 `writeIndividualLoadout` / `clearIndividualLoadout`；`writeStoreEntry` **按键排序落盘** ⇒ 同样内容重复写 = 同样字节 |
| ③ 两条同时存在时**个体级优先** | `resolveLoadout()` 一处判定（先 v2 后 v1），产品层不自己判 |
| 键字面量只许一处 | `tests/roco-loadout-integration.test.js` ① 与 `tests/roco-workshop.test.js` ④ 都扫 **v1+v2 两个字面量** |
| 引擎边界不动 | `loadouts` 交给 `battle/new` 时仍是**物种键**（`teamLoadouts()` 输出；引擎只认 `pet_…`）—— 个体维度只活在本机记录这一层 |

**`instanceForSpecies()` 的取舍**：同一个物种在队里不可能有两只（RC-301 判 `DUPLICATE_SPECIES_IN_TEAM`）
⇒ 物种 → 实例的解析唯一。解析不到实例时**不写**任何记录（宁可不写，也不写一条物种级的去污染同种的另一只）。

---

## 3 · 改前 / 改后逐条红绿对照（隔离副本 `git archive HEAD`，同一台机器、同一 `ROCO_PYTHON`）

隔离副本：`E:\roco-scratch\base2`（`git archive HEAD src tests package.json roco scripts` + `reports/` 拷贝 +
`data/` 用 **Windows junction** 指回仓库，**真实数据只读**）。

| 测试文件 | 基线（pristine HEAD） | 改后（S1） | 净变化 |
|---|---|---|---|
| `tests/roco-workshop.test.js` | 41 · **36 pass** · 5 fail | 41 · **36 pass** · 5 fail | **0**（改钉后回到基线；5 条红**基线就红**，见下） |
| `tests/roco-box-loadout.test.js` | 17 · **17 pass** · 0 fail | 17 · **17 pass** · 0 fail | 0（③e 改钉 + ③f 加断言后全绿） |
| `tests/roco-loadout-integration.test.js` | 6 · **6 pass** · 0 fail | 9 · **9 pass** · 0 fail | +3（新增 S1 三条） |
| `tests/roco-loadout-ui.test.js`（需 `ROCO_PYTHON`） | 9 · 9 pass | 9 · **9 pass** | 0 |

**基线就红的 5 条（与本改动无因果，已单独复现）**：
`路由契约：回执里不出现胜率/伪精确字段` · `机制原文：冻结 desc 逐字进玩家层` ·
`机制原文的百分数是可核对的豁免` · `反证：六条必红方向都抓得住违规样本` · `反证：判据本身不是恒真的`。
它们在 **pristine HEAD 副本上同样红**（读数见上表第一列），属别人在飞改动/既有欠账，**我没有碰**。

**「改钉前会红多少」也留了读数**（改钉前的临时状态）：workshop **7 fail**（基线 5 + 我的 2：
`换招要读共用记录…`、`阵容配置：接线…`）、box **16/17**（③e）。⇒ 两处改钉正是为了把这 3 条按新语义重新钉住。

---

## 4 · 两向变异 red-proof（在隔离副本里真跑，逐条给红读数）

| # | 变异（把正确的做法改坏） | 期望 | 实测 |
|---|---|---|---|
| **A** | `writeIndividualLoadout()` 改成写**旧物种级键**（模拟"没做迁移"） | 必红 | `roco-box-loadout` **16/17**（✖ ③e 保存要写进个体级记录）· `roco-loadout-integration` **6/9**（✖ ④ / ④b / ④c） |
| **B** | `resolveLoadout()` **去掉兼容读取分支**（模拟"不读旧记录"） | 必红 | `roco-box-loadout` **16/17**（✖ ③f 工坊里配过的招盒子要接着改）· `roco-loadout-integration` **6/9**（✖ ④ / ④b / ④c） |

变异脚本：`E:\roco-scratch\p08_mutate.py`（scratch，不入库）；每次变异后都把文件从仓库拷回（`ARCHIVE_RESTORED`）。
另外，**判据内部**也各带一条就地反证（不依赖变异脚本也能自证）：
`④`「写成物种级 ⇒ 同种另一只继承」· `④b`「关掉兼容读取 ⇒ 旧记录读不到」·
`④c`「换成旧记录 ⇒ 来源标注必须变成 species + 那句话」· `③e`「只写盒子那份 ⇒ 共用记录缺这一条」。

---

## 5 · 改钉留档（原断言逐字保留在文件里）

| 文件:位置 | 原断言（逐字，已在注释里留档） | 最小修订理由 |
|---|---|---|
| `tests/roco-workshop.test.js`（import 行） | `/import \{readSharedLoadouts, writeSharedLoadout, clearSharedLoadout, SHARED_LOADOUT_SLOTS\} from '\.\/loadout-store\.js'/` | 工坊改用个体级那一套口（`writeIndividualLoadout` / `clearIndividualLoadout` / `teamLoadouts`）；**意图不变**：钥匙只能从那一个模块引 |
| `tests/roco-workshop.test.js`（保存写回） | `/writeSharedLoadout\(null, editor\.petId \?\? editor\.species, editor\.draft\.slice\(\)\)/` | 写物种级会让同种另一只继承（G01）⇒ 改个体级（`instanceForSpecies()` 解析） |
| `tests/roco-workshop.test.js`（应用写回） | `/loadouts\.set\(speciesId, ids\.slice\(\)\);\s*\n\s*writeSharedLoadout\(null, speciesId, ids\.slice\(\)\);/` | 同上，应用那一刻也改个体级；内存 Map 仍是物种键（引擎要的） |
| `tests/roco-box-loadout.test.js`（③e） | `const shared = JSON.parse(storage.getItem(LOADOUT_STORE_KEY) ?? '{}'); assert.deepEqual(shared[REPLY.pet_id], picked, …)` | 同上；并**新增**一句「旧键不许被这次保存写入」把"单向迁移"钉死 |

**新增（非改钉）**：`③f` 的「物种级（未区分个体）」标注断言 · `④/④b/④c` 三条 S1 判据 ·
①②④ 的结构钉扩到 v2 键字面量。

---

## 6 · 命令与退出码（全部真跑）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | `node --test tests/roco-loadout-integration.test.js`（`ROCO_PYTHON` 已设） | **0** | 9 · pass 9 · fail 0 |
| 2 | `node --test tests/roco-box-loadout.test.js` | **0** | 17 · pass 17 · fail 0 |
| 3 | `ROCO_PYTHON=… node --test tests/roco-loadout-ui.test.js` | **0** | 9 · pass 9 · fail 0 |
| 4 | `node --test tests/roco-workshop.test.js` | 1 | 41 · pass 36 · fail 5 = **pristine 基线同值**（5 条红与本改动无关） |
| 5 | `node --test tests/roco-plain-speak.test.js`（玩家可读性棘轮） | **0** | 12 · pass 12 · fail 0（新增中文串都是大白话，未触发工程语气） |
| 6 | `node --test tests/roco-team-request.test.js` / `roco-team-compare.test.js` / `roco-team-advice.test.js` | **0** | 17/17 · 14/14 · 9/9 |
| 7 | `node --test tests/roco-box.test.js` | **0** | 14 · pass 14 |
| 8 | 基线/改后对照（隔离副本，见 §3） | — | 4 个文件逐条红绿 |
| 9 | 两向变异 A/B（隔离副本，见 §4） | — | 各 3~4 条红 |
| 10 | `node --check src/client/{loadout-store,box-loadout,team-workshop}.js` | **0** | 三个文件语法通过 |

**未跑**：Python 全量（本步只碰 client + 3 个 Node 判据；`roco/src` 未改）；浏览器验收
（工坊/盒子的真机走查属 S4 的验收口径，且需要起服务——本步只跑到 Node 判据 + 隔离副本）。

---

## 7 · S1 的边界（没做到的，留给 S2–S5）

1. **三套本机记录仍互不相识**（G07/U1）：个体培养（`roco.box.individuals.v1`）、阵容配置
   （`roco.workshop.teamconfig.v1`）、配招（`loadouts.v1/v2`）各自一步撤销 —— **一次调整 = 三样一起回退**没有做。
2. **旧物种级记录不会被清理**（Q2 明写"不删"）：它仍会在**没有任何个体级记录**的个体上兜底显示，
   并如实标注「物种级（未区分个体）」。要不要提供"把旧记录清掉"的入口，属 S3 的裁决面。
3. **引擎协议没加个体维度**（有意）：`battle/new` 仍收物种键；同种两只同时在队会被 RC-301 拒（既有约束）。
4. **没动渲染/文案层**：盒子状态行只多了一句标注；工坊的来源标签沿用旧口径（`explicit` / 「你选的 / 默认」），
   没把「个体级 / 物种级」搬进工坊的标签区（那会牵动 `roco-workshop` 的多个快照判据，留给 S3）。
5. **S2–S5 未开工**（门槛：08 的正式进入条件是 07 通过）。

---

## 8 · 可复跑（隔离副本 + 变异脚本）

```powershell
# 隔离副本（已建好，可重建）：WSL 里 git archive HEAD → E:\roco-scratch\base2，data 用 junction
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p08-archive2.sh
cmd /c mklink /J "E:\roco-scratch\base2\data" "E:\roco-coach\data"

# 基线 / 改后 / 变异（PowerShell，ROCO_PYTHON 指向 Windows python）
cd E:\roco-scratch\base2
$env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
node --test tests/roco-workshop.test.js tests/roco-box-loadout.test.js tests/roco-loadout-integration.test.js
wsl.exe -d Ubuntu-22.04 -- bash -c "python3 /mnt/e/roco-scratch/p08_mutate.py A"   # 变异 A
wsl.exe -d Ubuntu-22.04 -- bash -c "python3 /mnt/e/roco-scratch/p08_mutate.py B"   # 变异 B（先拷回原文件）
```
