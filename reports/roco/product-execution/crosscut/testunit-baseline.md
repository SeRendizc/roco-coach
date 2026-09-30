# 门禁基线分类：`npm run test:unit` 的 30 个失败文件（task-39）

**执行**：`plan02-front` · **时间**：2026-10-01 04:5x–05:2x · **仓库** `E:\roco-coach` · **HEAD** `26b5518`（工作区含他人 WIP）
**性质**：只读分类 + 一次可还原的重算实验；唯一写入 = 本文件与同目录 `filter-testunit.mjs`。

---

## 0 · 结论（先看这段）

1. **本机 `test:unit` 的权威基线**（`--test-concurrency=1`，本报告的命令）：**1994 tests · 1885 pass · 87 fail · 22 skip · 454s（约 7.6 分钟）**，失败面 **30 个文件**。
2. **瞬时红 = 0**：30 个失败文件**逐个单独重跑 1 次**，**无一转绿**（`companion.test.js` 也稳定红 4 条；这与 task-27 记的「companion 有一条瞬时红」不同，本次不可复现）。
3. **分类（30）**：产物过期/缺失 **14** · 真回归 **7** · 环境依赖 **4** · 判据/文档过期 **3** · 判据路径缺陷 **1** · 待裁决 **1**。
4. **最重要的单条发现**：`scripts/roco/build-rule-configs.mjs:690` 有一个**已入库的语法错误**（一行多余的 `)`），
   让 **5 个判据文件**（`roco-mana-actions`/`roco-rule-config`/`roco-rule-promotion`/`roco-six-pet-battle`/`roco-weather-pvp`）
   **模块加载即崩**（每个只报 `ℹ tests 1 · pass 0 · fail 1`，一条真判据都没跑）。已单独回报 Lead（不在本任务写域）。
5. **「重算能转绿」已实证**（§4）：代表样本 `roco-corpus-verification` 重算后 **9/8/1 → 9/9/0**，产物已按字节还原、`git status` 干净。
6. **O-42 口径**：以后说「套件绿」必须**指明入口 + 子集**；本机不存在「`test:unit` 全绿」这回事（至少 4 个文件本机无解，见 §5）。

---

## 1 · 可复跑命令（含一个必须知道的编码坑）

```powershell
cd E:\roco-coach
$env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
# ⚠ PowerShell 5.1 的 `*>` 会写成 UTF-16LE（实测文件头 FF FE），下游解析会全部读不到 ⇒ 用 Out-File -Encoding utf8
npm run test:unit 2>&1 | Out-File -FilePath E:\roco-scratch\unit.txt -Encoding utf8
node reports/roco/product-execution/crosscut/filter-testunit.mjs E:\roco-scratch\unit.txt E:\roco-scratch\classified.json
```
- 分类器 `filter-testunit.mjs`（同目录）**粗筛**用：给出总览 + 每个失败文件的失败数/分类/首条原因。
  ⚠ **它有一个已知不可靠点**：多文件合并跑时 Node 的 spec 树会把子测试挂到父块上，导致「首条原因」偶尔**串到别的文件**（实测 `local-model` 的 15 条被算成环境类，但首条消息其实来自 `agent.test.js`）。
  ⇒ **分类结论以「逐文件单独重跑」为准**（本报告的表格就是这么来的）：`for f in <files>; do node --test --test-concurrency=1 $f; done`。
- 单文件复核（推荐复核手段）：`node --test --test-concurrency=1 tests/<file>.test.js`。

原始件：`E:\roco-scratch\t39-unit-run1.txt`（UTF-16LE 原始输出）· `t39-unit-run1.utf8.txt`（转换后）·
`t39-rerun\*.txt`（30 个文件各自的单独重跑日志）· `t39-classified.json` · `t39-digest.txt`（逐文件原因摘要）。

---

## 2 · 30 个失败文件逐个分类（以**逐文件重跑日志**为证据）

| # | 文件 | fail | 分类 | 证据（逐文件日志首条） |
|---|---|---|---|---|
| 1 | `tests/roco-pet-mechanisms.test.js` | 15 | 产物过期/缺失 | 子进程崩：`ENOENT … scripts/roco/data/roco/derived/pet-mechanisms.json` |
| 2 | `tests/evals/local-model.test.js` | 15 | **环境依赖** | `python 不存在：E:\roco-coach\.venv-mlx\bin\python（先跑 scripts/model/setup-mac.sh）；权重目录不存在：.models\mlx\Qwen3.5-4B-4bit` |
| 3 | `tests/roco-on-demand-builds.test.js` | 7 | 产物过期 | 「报告过期：跑 `RC304_WRITE_REPORT=1 node --test tests/roco-meta-prior.test.js` 重新生成」 |
| 4 | `tests/roco-panel-model-env-key.test.js` | 5 | **判据路径缺陷（同族新成员）** | 子进程 `node --input-type=module -e import("E:\\roco-coach\\src\\…")` ⇒ `ERR_UNSUPPORTED_ESM_URL_SCHEME` |
| 5 | `tests/roco-workshop.test.js` | 5 | 产物过期/缺失 | 同一缺口：`ENOENT … scripts/roco/data/roco/derived/pet-mechanisms.json` |
| 6 | `tests/companion.test.js` | 4 | **真回归（待 owner 裁决）** | `moment 1 highlight` / `moment 3 clutch` / `proactive path stays silent` / `each companion event fires once` 四条行为断言 |
| 7 | `tests/roco-rag-eval.test.js` | 4 | 产物过期 | 「磁盘报告必须等于『现在重算』的结果（`--check` 判据）」 |
| 8 | `tests/evals/roco/agent-trajectories.test.js` | 3 | 产物过期/生成器漂移 | 「产物必须是**现在这个生成器**产出来的」+ `verify-agent-trajectories.mjs` 退出非 0 |
| 9 | `tests/roco-owned-pets.test.js` | 3 | 产物过期/缺失 | `ENOENT … tests/data/roco/derived/on-demand-builds.json` |
| 10 | `tests/roco-sft-dataset-contract.test.js` | 3 | **环境依赖（机器特定路径）** | `ERR_MODULE_NOT_FOUND: 'E:\Users\serendizc\Developer\roco-coach\src\coach\toolbox.js'`（文档脚本里写死**作者 mac 路径**） |
| 11 | `tests/evals/provenance.test.js` | 2 | **环境依赖（原始快照缺失）** | 「`nrc-ai-sqlite` 声明的 `archive_sha256` 在 `data/roco/raw/` 里找不到对应文件」+ 两份产物无 `source_id` |
| 12 | `tests/roco-catalog-reconciliation.test.js` | 2 | 待裁决（判据/数据） | 「RC-201 许可与再分发：快照必须登记许可，且与 `sources.yaml` 逐字一致」 |
| 13 | `tests/roco-hke-layer.test.js` | 2 | 产物过期 | 「磁盘 `pack.json` 必须等于『现在重建』的结果」；②「来路写清…不许并进 `normalized`」 |
| 14 | `tests/evals/agent.test.js` | 1 | **判据过期（文本迁移撞钉）** | 正则仍钉 `/消耗4豆/`，实际文本已是「消耗4**能量**」 |
| 15 | `tests/evals/roco/mock-host-integration.test.js` | 1 | 产物过期/缺失 | `ENOENT … mock-host/data/roco/normalized/…/roster-48.json` |
| 16 | `tests/evals/state-doc.test.js` | 1 | **判据/文档过期** | 「状态文档的 HEAD 落后当前 **135** 个提交」+ 引用 7 条不存在的产物路径 |
| 17 | `tests/evals/subprocess-env.test.js` | 1 | **环境依赖（平台/运行器）** | `cleanEnv` 断言期望 `'string'`、实得 `'undefined'` |
| 18 | `tests/evals/tool-arguments.test.js` | 1 | **判据/文档过期** | 「README 的命令块应当被解析出来，实际只找到 8 条」 |
| 19 | `tests/roco-battle-context.test.js` | 1 | **真回归（待 owner 裁决）** | 「⑧ 结构性：客户端快照真的带编号、服务端真的注入读口、工具真的用它」（`tests/roco-battle-context.test.js:268`） |
| 20 | `tests/roco-corpus-verification.test.js` | 1 | **产物过期（已实证重算转绿，§4）** | 「磁盘产物与重算不一致」 |
| 21 | `tests/roco-difficulty-holdout.test.js` | 1 | 产物过期 | 同上（先跑 `scripts/roco/verify-rules-corpus.mjs`） |
| 22 | `tests/roco-full-catalog.test.js` | 1 | 产物过期/缺失 | `ENOENT … scripts/roco/data/roco/normalized/…/full-catalog.json` |
| 23 | `tests/roco-game-data-pack.test.js` | 1 | 产物过期 | pack 与重建不一致（`--check`） |
| 24 | `tests/roco-mana-actions.test.js` | 1 | **真回归（已入库语法错误）** | `build-rule-configs.mjs:690 SyntaxError: Unexpected token ')'` |
| 25 | `tests/roco-meta-prior.test.js` | 1 | 产物过期 | 报告过期（`RC304_WRITE_REPORT=1` 重新生成） |
| 26 | `tests/roco-rule-config.test.js` | 1 | **真回归（同语法错误）** | 同上 |
| 27 | `tests/roco-rule-promotion.test.js` | 1 | **真回归（同语法错误）** | 同上；另见 `E:\roco-coach\E:\roco-coach\data\…` **双根路径**（路径家族） |
| 28 | `tests/roco-six-pet-battle.test.js` | 1 | **真回归（同语法错误）** | 同上 |
| 29 | `tests/roco-tool-task-coverage.test.js` | 1 | 产物过期/缺失 | `ENOENT … scripts/roco/tests/evals/agent-tasks-v2-tool-coverage.jsonl` |
| 30 | `tests/roco-weather-pvp.test.js` | 1 | **真回归（同语法错误）** | 同上 |

**分类计数**：产物过期/缺失 **14** · 真回归 **7**（其中 **5** 个源自同一个语法错误）· 环境依赖 **4** · 判据/文档过期 **3** · 判据路径缺陷 **1** · 待裁决 **1**。

---

## 3 · 瞬时红（重跑 3 次口径）

- 第 1 步：30 个文件**逐个单独重跑 1 次** ⇒ **30/30 仍然红**（`TRANSIENT(exit=0 on rerun): （空）`）。
- 因为「一次重跑全红」，不存在需要「重跑 3 次」的候选 ⇒ **瞬时红出现次数 = 0**（口径照实说明：不是没做，而是没有候选可做）。
- ⚠ 与 task-27 记录的差异：那份记录说 `companion.test.js` 有一条瞬时红；本次两轮（套件内 4 条 + 单跑 4 条）都稳定红 4 条，**不可复现**。

---

## 4 · 「产物过期 ⇒ 重算能转绿」的实证（可还原，工作区已复原）

代表样本：`tests/roco-corpus-verification.test.js`；产物 `reports/roco/rag/corpus-verification.json`（**已入库、被 git 跟踪**）。

```powershell
cd E:\roco-coach
Copy-Item reports\roco\rag\corpus-verification.json E:\roco-scratch\t39-corpus-backup.json -Force
node scripts/roco/verify-rules-corpus.mjs            # 重算（脚本里只有这一处 writeFileSync）
node --test --test-concurrency=1 tests/roco-corpus-verification.test.js
Copy-Item E:\roco-scratch\t39-corpus-backup.json reports\roco\rag\corpus-verification.json -Force   # 还原
```
| 读数 | 值 |
|---|---|
| 产物 sha256(前16) 改前 | `a8409ec4fdce521d` |
| `node scripts/roco/verify-rules-corpus.mjs` | exit **0** |
| 产物 sha256(前16) 重算后 | `97ff3059afb39dde` |
| 判据（重算后） | **exit 0 · tests 9 · pass 9 · fail 0**（改前 9/8/1） |
| 还原后 sha256 | `a8409ec4fdce521d`（**与改前逐位相同**），`git status` 该文件**干净** |

⇒ 「产物过期」这一类**确实是重算可绿的**，且可在不污染工作区的前提下验证（备份—重算—复核—还原）。
其余 13 个产物类文件**未逐个重算**（原因：重算会改写**共享产物**，本机是多人共用的工作区；逐个重算应由 Lead 在 04 收口时统一安排）。
它们的分类依据是**逐字消息 + 生成器指引**（表 §2 每行的证据列），属**同类机制**而非实测转绿。

---

## 5 · 本机「可绿子集」清单

| 子集 | 文件数 | 说明 |
|---|---|---|
| **重算后可绿**（有明确生成器） | **13–14** | `corpus-verification`（**已实证**）· `difficulty-holdout` · `rag-eval` · `hke-layer` · `game-data-pack` · `meta-prior` · `on-demand-builds` · `owned-pets` · `workshop` · `pet-mechanisms` · `full-catalog` · `tool-task-coverage` · `mock-host-integration` · `agent-trajectories`。**必须由 Lead 统一安排重算时机**（会改写共享产物） |
| **改代码后可绿** | **7** | ① `scripts/roco/build-rule-configs.mjs:690` 语法错误 ⇒ 一次修好 **5** 个文件；② `panel-model-env-key`（子进程 `import("E:\\…")` 改 `pathToFileURL`）；③ `rule-promotion` 的双根路径 |
| **改判据/文档后可绿** | **3** | `evals/agent`（正则撞钉「豆→能量」）· `tool-arguments`（README 命令块漂移）· `state-doc`（状态文档落后 135 提交） |
| **待裁决** | **1** | `catalog-reconciliation`（RC-201 许可登记与 `sources.yaml` 不一致：是数据要补还是判据要改） |
| **本机无解（环境）** | **4** | `local-model`（缺 mac 专用 `.venv-mlx` + MLX 权重）· `sft-dataset-contract`（文档脚本写死作者 mac 路径）· `provenance`（缺 `data/roco/raw/` 原始快照）· `subprocess-env`（平台/运行器差异） |
| **真回归，需 owner 修** | **2** | `companion`（4 条行为）· `roco-battle-context` ⑧（客户端快照/服务端注入/工具使用这条接线） |

---

## 6 · 给后续的「一条命令」与口径

- **一条命令复现分类**：§1 的两条命令（跑套件 → `filter-testunit.mjs`），**并把「逐文件重跑」当作权威复核**（分类器在多文件模式下会串行归属）。
- **O-42 口径（本报告背书）**：任何「套件绿」的声明必须写清 **入口**（`npm run test:unit` / 单文件 / 子集）+ **子集**（哪些文件）+ **前提**（是否已重算产物 / 是否具备本机依赖）。
- **本机可信基线数字**：`npm run test:unit` = **1994 / 1885 / 87 fail / 22 skip**，失败 **30** 个文件；其中 **4 个本机无解**、**1 个待裁决**、其余 **25 个**在「重算 + 修上述三处代码/判据」之后**应当**能绿（逐个转绿未实测，除 corpus 一例外）。

---

## 7 · 附：顺带发现的两个路径家族新成员（建议专项，不在本任务写域）

1. `tests/roco-panel-model-env-key.test.js`（5 条）：子进程用 `--input-type=module -e import("E:\\roco-coach\\src\\…")` ⇒ Windows 绝对路径不能直接喂 `import()`（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）⇒ 需 `pathToFileURL(...).href`。
2. `tests/roco-rule-promotion.test.js`：出现 `E:\roco-coach\E:\roco-coach\data\…` **双根路径**（`join(ROOT, '<绝对路径>')` 形态），与 task-20/24/26/37 修的 `.pathname` 家族同源但**形态不同**。

---

## 8 · 结案更新（Lead 已修，本节由 plan02-front **独立复核**）

**HEAD 变化**：本报告 §2/§3 的基线取自 `26b5518` 的工作区；Lead 随后提交 `56c517e` 等，复核时 HEAD = **`bde5d8e`**。
基线数字本身仍是**那次运行的快照**（不回溯修改），下面给修复后的**实测**读数。

### 8.1 `build-rule-configs.mjs:690` 语法错误（§0-4 与表 #24/#26/#27/#28/#30）

- **修法以 Lead 的为准，我的建议被否（理由成立，记录在此）**：我建议「把 689/690 两段文案合成一个字符串」；
  Lead 指出那样会把**两个不同叶子**的语义混在一起 —— 690 行那段描述 `damage.global_skill_mods`（冒号体，已声明），
  689 行那段描述**另一个叶子** `damage.global_skill_mod_text`（非冒号体，**刻意未声明**；证据在 `coverage.py:1004-1029`：
  `env.py:1295/1396/1869` 三处挂在 `cfg.damage_global_skill_mod_text` 上，而 `RuleConfig` 没有这个叶子 ⇒ `getattr(..., False)` 恒 False ⇒ 永不产出）。
  Lead 的修法是：**保留冒号体描述、删掉那半截调用**，并把「非冒号体叶子刻意不声明 + 台账口径 + 接线/删死代码属 `env.py` 独立事项」写成注释留档 ⇒ **只恢复可解析性、行为零变化**。
- **我的独立复核读数**（`node --test --test-concurrency=1 <file>`，HEAD `bde5d8e`；`node --check scripts/roco/build-rule-configs.mjs` = exit 0）：

| 文件 | 修复前（基线） | 修复后（我实测） | Lead 报的 |
|---|---|---|---|
| `tests/roco-mana-actions.test.js` | 1 test / 0 pass / 1 fail（模块加载即崩） | **exit 0 · 7 / 7 / 0** | 7/7 ✓ 一致 |
| `tests/roco-rule-config.test.js` | 同上 | **exit 0 · 8 / 8 / 0** | 8/8 ✓ 一致 |
| `tests/roco-six-pet-battle.test.js` | 同上 | **exit 0 · 4 / 4 / 0** | 4/4 ✓ 一致 |
| `tests/roco-weather-pvp.test.js` | 同上 | **exit 0 · 5 tests / 4 pass / 0 fail / 1 skipped** | 报「5/5」——**精确读数是 4 pass + 1 skip**（`skipped 1` 逐字可见） |

⇒ 这一行语法错误**拖垮 5 个文件**的结论成立；修好后 4 个文件全绿、1 个（weather-pvp）**4 绿 1 跳**。

### 8.2 `weather-pvp` 的两处判据缺陷（Lead 修，我记录为「假绿/掩盖」的又一实例）

1. **读了一个不存在的字段**：`PYTHON.path || 'python3'`，而 `RocoClient.probePython()` 只返回 `{ok, version, error}`（**没有 `path`**）⇒ 恒回落 `python3`；POSIX 上恰好有 `python3` ⇒ **长期掩盖**，Windows 上 ⇒ `status=null`、stdout/stderr 全空、断言只报「引擎探针失败：undefined」。修法：用探测时传入的 bin（`PY_BIN`）。
2. **探针缺 UTF-8 环境**：Windows Python 默认 GBK stdout ⇒ 中文变 `????`（`actual '????' vs expected '雨天'`）⇒ 补 `PYTHONIOENCODING=utf-8`。

**为什么写进本报告**：这正是 §0-6 那类**「本机假绿/掩盖」**的又一实例 —— 判据在 POSIX 上绿**不代表**它在 Windows 上真的跑了那条路径；
与 O-35（「WSL 没有 node」其实是没 source nvm）、`subprocess-env` 的 `'undefined' vs 'string'`、以及 §7 的两条路径缺陷同族：
**判据的环境假设不成立时，它给的是「绿」而不是「跳过或红」**。建议专项：给需要外部解释器/子进程的判据加**显式前置断言**（拿不到就 skip 并计入 `skipped`，不许静默回落默认值）。
