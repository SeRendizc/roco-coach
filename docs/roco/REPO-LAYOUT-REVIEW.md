# 仓库目录逻辑审视（只读审阅 + 提案）

> **一句话结论**：这份仓库的分层在 `src/`、`roco/`、`data/roco/` 三处是**清楚且有判据守着的**；
> 真正乱的是三个「只增不减的平铺层」——`tests/`（116 个平铺测试）、`scripts/roco/`（142 个平铺脚本）、
> `reports/roco/`（90 个子目录 + 64 个平铺文件）；它们的乱**不是审美问题**，而是
> 「**手工清单 + 人名记忆**」这条索引方式的容量已经到顶：`package.json` 的 `test:unit` 一行 5,103 字符、
> 枚举 149 个测试文件，任何搬迁都要同步 481 个文件里的 1,989 处路径。
>
> **本文是审阅与提案，不是重构**。本轮**没有移动、重命名、删除任何现有文件**，
> 也**没有改 `package.json` 与 `docs/roadmap/DSH-EXECUTION-STATE.md`**。唯一新增文件就是本文。

---

## 0. 方法与口径

| 项 | 值 |
|---|---|
| 测量时间 | 2026-09-27T20:28–20:33Z（本机 09-28 04:28–04:33） |
| HEAD（主测量） | `e02faaf`（`master`），已跟踪文件 **1,471** |
| HEAD（复核） | `d315b3d`，已跟踪文件 **1,475**（测量期间有并发提交，见下） |
| 历史提交数 | 587 |
| 用到的命令 | 只读：`git ls-files` / `git log --name-only` / `git grep` / `git check-ignore` / `du` / `stat` / `ls` / `shasum` |

> **⚠️ 一处自我修正（必读）**：我最初写的 §4.2 说「`reports/c17/` 全仓引用数 = 0」。
> **这句话是错的**，复核时（`d315b3d`）用 `git grep -F 'reports/c17'` 查到 **8 个文件**引用它——
> 它们引用的是**目录通配** `reports/c17/*.png`，不是单个文件名。
> 准确说法是：**26 个文件的完整路径各自引用数 = 0**（逐文件查过），
> **但「`reports/c17/*.png` 这 26 张截图」作为 C17 验收的证据链被 8 个文件引用**
> （`docs/CHECKLIST.md`、`docs/W10-ACCEPTANCE-MAPPING.md`、`docs/DOCS-AUDIT.md`
> 「26 张截图全部存在 ✓」、`docs/INTERVIEW-DRILL.md`，以及**生成它们的脚本**
> `scripts/cdp-long-game.js:27` 的默认 `--out=dir`）。
> 这个区别**改变了 §4.2 的建议等级**：从「最干净的零引用候选」降为「需要人裁决」。
> 详见 §4.2 的修正版。

**口径说明（免得数字对不上）**：

- **`tracked`** = `git ls-files` 的条数；**`tracked KB`** = 这些文件的字节和；**`worktree`** = `du -sh`，**包含被忽略的解压快照、截图、日志**。三者不同是正常的，别混用。
- `git ls-files -- tests/*.test.js` 里的 `*` 在 git 路径规格里**跨 `/`**，所以它数的是「tests/ 下任意深度的 .test.js」。要按层级数得再用 `awk -F/ 'NF==n'` 过滤——本文里所有分层计数都这么做的。
- 非 ASCII 路径（`docs/codex聊天记录.txt`）在默认输出里被转义，凡是逐文件 `stat` 的地方都加了 `-c core.quotePath=false`。
- **干扰项（重要）**：测量期间**有另一个 agent 在并发提交**。工作区当时有 21 个已修改文件与 5 个未跟踪文件（含尚未登记的 `tests/roco-hke-reconcile.test.js`、`scripts/roco/shoot-layout.mjs`）。所以 `tests/` 的「磁盘 117 个平铺测试 / 清单 100 条」这类数字是**快照**，会随那次提交变动 ±1。

**没做的事**：没跑测试套件（用户明确要求不跑）、没起浏览器、没碰 8765/8766/3080 上任何进程、没在仓库外写任何文件。

---

## 1. 现状盘点（实测）

### 1.1 顶层目录

> 下表是 **`e02faaf` / 20:28–20:32Z 的快照**。`d315b3d` 复核时的漂移：
> tracked 总数 1,471 → **1,475**；`tests/` 175（不变，但磁盘多 2 个未跟踪 `.test.js`）；
> `scripts/` 196 → **197**；`data/` 158 → **159**；`docs/` 238 → **239**（`docs/roco/` 159 → **160**，
> 平铺 86 → **87**）；`reports/` 458 → **459**；`scripts/roco/` 142 → **143**。
> **漂移全部来自并发 agent，不是我的测量误差。**

| 目录 | tracked | tracked 体积 | worktree | 最后提交 | 装什么 | 谁在读它 |
|---|---:|---:|---:|---|---|---|
| `src/` | 80 | 3.5 MB | 3.6 M | 09-28 04:26 | 全部实现代码（`game`/`coach`/`server`/`client`） | 浏览器模块图、`src/server/index.js` 白名单、几乎全部测试 |
| `tests/` | 175 | 14.8 MB | 15 M | 09-28 04:26 | 154 个 `.test.js` + 判据数据（jsonl/json） | `package.json` 的 6 个 test:* + `verify-release.mjs` 的 **27** 条套件 |
| `scripts/` | 196 | 4.1 MB | 4.5 M | 09-28 04:26 | 实验、评测、产物生成、浏览器驱动 | `package.json`（102 个 script）、`verify-release.mjs` |
| `data/` | 158 | **62.3 MB** | 472 M | 09-28 04:26 | 版本化数据与来源台账（`data/roco/` 独占全部） | `roco/src/roco_env/data.py`（唯一 I/O）、`src/coach/roco-client.js`、判据 |
| `docs/` | 238 | 10.5 MB | 11 M | 09-28 04:26 | 文档（`roco/` 159、`roadmap/` 44、根 33、`reviews/` 2） | 人；少量 `verify:state-doc` / `claim-honesty` |
| `reports/` | **458** | **100.8 MB** | 280 M | 09-28 04:26 | 运行产物：评测 JSON、验收回执、截图、日志 | 判据按绝对路径读若干份；其余靠人 |
| `knowledge/` | 4 | 126 KB | 132 K | 09-28 01:26 | 4 份 RAG 知识卡与语料（`tactics.json` 等） | `src/coach/rag-index.js`、`build:knowledge` |
| `roco/` | 70 | 1.9 MB | 2.0 M | 09-28 00:19 | 手游规则引擎（Python，零依赖）+ 它自己的 55 个 unittest | `npm run test:env`（`unittest discover`）、`roco_env/service.py` |
| `report/` | 38 | 1.8 MB | 1.8 M | **09-21 01:52** | LaTeX 报告源码与图 | `npm run build:report`（`.venv-agent` Python） |
| `output/` | 43 | 9.8 MB | 9.9 M | **09-18 10:45** | 可交付产物：PDF、`demo/`+`demo-live/` 各 21 张图 | `README.md` 直接引用图片、PDF |
| `checkpoints/` | 2 | 27 KB | 32 K | **09-17 14:14** | 已训练小模型（`tool-router-head.pt`、干预策略 JSON） | `tests/evals/slow-model.test.js` 等 |
| `training/` | 1 | 3 KB | 4 K | **09-17 14:14** | `intervention.js` | `scripts/train-intervention.js` |
| `tools/` | 1 | 2 KB | 4 K | 09-21 01:45 | `benchmark.js`（基准，刻意不是测试） | `npm run`?  实际只有人手动跑 |
| `models/` | 1 | 5 KB | 8 K | 09-21 06:04 | `registry.json` 模型登记表 | `scripts/model/verify-manifest.mjs` |
| `.dsh-sources/` | 1 | 0 KB | — | 09-25 | 一个 `.gitignore` | DSH 工具链 |
| 根文件 | 5 | — | — | 09-28 04:13 | `.gitignore`、`package.json`、`README.md`、两份 `requirements-*.lock.txt` | — |
| `tmp/` | 0 | 0 | **3.1 G** | — | 开发期临时与浏览器 profile | 无（已忽略） |

`src/` 的内部（**这四个是清楚的，可作模板**）：
`src/client/` 24 文件 1.2 M、`src/coach/` 46 文件 2.1 M、`src/game/` 5 文件 120 K、`src/server/` 5 文件 248 K。
按**依赖方向**分层（`client → coach → game`、`server → coach → game`），
并且有一条真判据守着（`game` 不许反向依赖 `coach`）。

### 1.2 「谁在读它」的实证

不是猜的，用 `git grep -o -F` 数了路径前缀在全仓的出现次数：

| 路径前缀 | 出现次数 | 出现在多少个文件里 |
|---|---:|---:|
| `data/roco/` | 12,827 | 300 |
| `src/coach/` | 2,255 | 338 |
| `scripts/roco/` | 1,989 | **481** |
| `reports/roco/` | 1,755 | 339 |
| `tests/roco-` | 911 | 196 |
| `docs/roco/` | 778 | 179 |
| `src/game/` | 463 | 113 |
| `roco/src/roco_env/` | 390 | 103 |
| `tests/evals/roco/` | 382 | 88 |
| `docs/roadmap/` | 339 | 59 |
| `knowledge/` | 80 | 21 |

**这张表本身就是结论**：`scripts/roco/` 一个目录被 **481 个文件**按路径引用，
它是全仓**耦合度最高的目录**，也是搬迁成本最高的目录（见 §3.2）。

---

## 2. 具体的乱在哪（每条都有实测证据）

### 2.1 `tests/` 是一个 116 文件的平铺目录 —— 是，但没有想象中那么糟

实测（`e02faaf` 快照；括号里是 `d315b3d` 复核值）：

```
tests/ 顶层条目           119  (120)   = 2 个目录 + 117 个文件 (119 文件，含 .DS_Store)
tests/*.test.js（平铺）    116  (116 已跟踪 / 118 磁盘)   其中 tests/roco-*.test.js 占 100 (101 磁盘)
tests/evals/*.test.js       19
tests/evals/roco/*.test.js  18
tests/ 全部 .test.js       154
tests/helpers/               1   （subprocess.mjs）
```

- **`tests/roco-*.test.js` 100 个文件全部平铺**，文件名只靠 `roco-` 前缀区分域。
  按前缀粗分：`roco-team-*`、`roco-box-*`、`roco-rag-*`、`roco-planner-*`、`roco-tool-*`、
  `roco-model-*`、`roco-answer-*`、`roco-context-*` …… 已经自然形成 8–10 个域，
  但**域只活在文件名里，不活在目录里**。
- `tests/evals/` 这一层是**清楚的**：58 个文件 = 19 个 `.test.js` + 数据 + `roco/` 子域 + `mock-host/`。
  它是「按域分组」在本仓的**已成功先例**（`docs/STRUCTURE.md` §3 有约定）。
- **搬迁成本极高（实测）**：把 `tests/roco-*.test.js` 移进 `tests/roco/` 需要动
  - 移动 **100** 个文件；
  - 这 100 个文件内部有 **325 条相对 import/引用**要整体升一层（`../src/` **252 条**、`../scripts/` **51 条**、`./helpers/` **1 条**，其余是拼路径的字符串）；
  - 其中 **88 条**是文件里写死的 `tests/roco-*.test.js` 路径字符串；
  - 仓内 `tests/roco-*.test.js` 这个形状的路径串一共 **911 处**：
    `package.json` **101** + `docs/roadmap/` 333 + `docs/roco/` 103 + `tests/` 88 + `scripts/roco/` 65 + `src/coach/` 30 + `src/client/` 16 + `src/server/` 3 + `reports/`（含 `flagship-upgrade` 26、`rc602` 18、`rc106` 17…）= **809**。
  - **合计约 1,236 处文本要改**（325 条 import + 911 处路径串）。

> 一个必须说清的前提修正：本仓**已经有**一条判据在守「测试写了但没人跑」——
> `tests/evals/structure-contract.test.js` 第 900 行的
> 「结构契约：每个 Node 测试文件都必须被某个 npm script 或自检登记表引用」。
> 我用它的判定逻辑（`scriptText.includes(rel)`）**离线模拟**过：
> `tests/roco-plain-speak.test.js` → `true`（现在有人跑），
> 改成 `tests/roco/roco-plain-speak.test.js` → **`false`（会变红）**。
> 所以「搬家会静默漏跑」这个担心**在 `.test.js` 上是错的**——搬家会**响亮地红**。
> 真正静默的是**它扫不到的东西**：`tests/**` 下的非 `.test.js` 资产（jsonl 夹具、`mock-host/`、`helpers/`），
> 以及 `scripts/roco/`（见 §2.2）。

### 2.2 `scripts/roco/` 平铺 142 个脚本，没有任何「每个脚本都被引用」的判据

实测：

```
scripts/roco/ 已跟踪            142
scripts/ 顶层平铺文件            30
scripts/ 其他子目录：model/ 13, sources/ 6, train/ 5
scripts/ 语言：.mjs 135、.py 29、.js 21、.sh 10
```

按**命名前缀**分类（分类靠名字，不是靠读全文，这是本层最直接的病灶）：

| 类别 | 个数 | 判据（前缀） | 例 |
|---|---:|---|---|
| **一次性产物生成器** | 49 | `build-` `export-` `import-` `hash-` `sync-` `rebuild-` `fetch-` `capture-` `shot-` `report-rc*` | `build-roster-48.mjs`、`build-support-matrix.mjs`、`export-trait-status.py` |
| **验收套件 / 守卫** | 41 | `browser-*` `*acceptance*` `verify-` `check-` `revalidate-` `guard-selftest` `selftest-` `cross-check` `run-microcase` | `browser-acceptance.mjs`、`verify-release.mjs`、`verify-state-doc.mjs` |
| **分析 / 评测 / 训练工具** | 21 | `eval-` `measure-` `probe-` `analyze-` `audit-` `benchmark-` `calibrate-` `train-` `triage-` | `eval-rag-retrieval.mjs`、`measure-team-serving.mjs`、`train-intervention-model.py` |
| **库 / 基础设施** | 11 | `*-lib.mjs`、`schema.mjs`、`lua-safe-parse.mjs`、`notify.mjs`、`model-identity.mjs`、`ruleset-energy.mjs` | 被上面三类 import |
| **未归类（名字不带类别前缀）** | 22 | — | `shadow-replay.mjs`、`gold-review.mjs`、`agent-metrics.mjs`、`refresh-receipts.mjs`、`record-measurements.py`、`query-full-catalog.mjs`、`reconcile-*.mjs` |

**「类别只活在命名约定里」的代价（实测）**：有些脚本**名字骗人**——
`verify-release.mjs` 是 **27** 条套件的总闸（验收），`guard-selftest.mjs` 是注入自检（验收），
但 `record-measurements.py`（名字像分析）实际是**写 `data/roco/` 的生成器**，
`shadow-replay.mjs`（名字像分析）实际**写 `reports/roco/shadow-replay*.json`**。
光看名字分类会分错；这说明**前缀约定已经不够用了**，需要目录来固化。

**`package.json` 的 `test:unit` 手工清单有多长（实测）**：

| 项 | 值 |
|---|---:|
| `test:unit` 指令的字符长度 | **5,103** |
| 其中列出的测试文件 | **149** |
| 其中 `tests/roco-*` | **99** |
| 分布 | `tests/` 平铺 114、`tests/evals/` 19、`tests/evals/roco/` 15、`reports/roco/local-model/verdict.test.mjs` 1 |
| `package.json` 里的 script 总数 | **102** |
| 磁盘上有、但**不在** `test:unit` 的测试 | 5（`browser.test.js`、`replace.test.js`、`evals/roco/{bridge,plan-e2e,toolbox-roco}.test.js`）——都有各自的 script，**不是孤儿** |
| `test:unit` 里有、磁盘上没有的 | **0** |

> 顺带发现的**口径不一致**：`reports/roco/local-model/verdict.test.mjs` 被 `test:unit` 枚举着，
> 但它**不在 `tests/` 下**，所以上面那条「孤儿判据」扫不到它（它 `walk('tests')`）。
> 也就是说 `reports/` 里的测试文件处在**判据盲区**。这是个真缺口，但只有 1 个文件，不急。

`test:unit` 一行 5,103 字符、149 条清单本身**不是错误**——它是本仓刻意选择的
「显式枚举、绝不靠 glob」纪律（判据第 900 行就是靠这个枚举工作的）。
问题是它的**维护成本随域数量线性增长**，而现在已经 149 条了。

### 2.3 `reports/` 的「结论 vs 每次跑都变」已经部分分离，但 `.gitignore` 只盖到一半

实测：

```
reports/ 已跟踪        458 文件 / 100.8 MB / 367 个在 reports/roco/ 下
reports/ 磁盘上        871 文件 / 280 MB
reports/roco/ 子目录    90 个
reports/roco/ 平铺文件  64 个
reports/ 顶层平铺文件   59 个
```

**「结论」与「回执」的区分，本仓其实已经想清楚了**，`.gitignore` 第 48–58 行的注释写得很准：
「浏览器验收：结论入库，**每次运行都变的那一份**与截图不入库」。
**而且它在持续收紧**：`.gitignore` 在测量期间从 **67 行长到 79 行**
（新增第 28–37 行的「小黑盒 API 抓包原始响应不入库：1120 个 JSON / 35MB」裁决）。
问题是**执行只覆盖了一部分**，而且**这份文件本身就在膨胀**。

`.gitignore` 现在盖到的（实测 `git status --ignored` 有 **174** 条命中）：

| 已盖住的模式（`.gitignore` 现第 n 行） | 评价 |
|---|---|
| `reports/roco/**/*.png`（79） | ✅ 生效：`reports/roco/` 下**已跟踪 PNG = 0** |
| `reports/roco/acceptance/*-run.json` 等 6 条 `*-run.json`（50–57） | ✅ 生效：全仓 `*-run.json` 已跟踪数 = **0** |
| `reports/roco/verification/failures/`（75） | ✅ 生效（磁盘 174 文件 / 16 MB 不入库） |
| `reports/roco/trajectories/*.jsonl`（46） | ✅ 生效（91 MB 的 12,000 局轨迹不入库，manifest 入库） |
| `data/roco/raw/hke-2026-09-27/raw/`（37） | ✅ 新增：1120 个 JSON / 35 MB 不入库，结论 10 个文件约 765 KB 入库 |
| `reports/roco/local-model/*.log` `*.pid` `responses.jsonl` `requests.fifo`（67–70） | ✅ 生效 |

**没盖住的（实测证据）**：

1. **`reports/c17/` 26 个 PNG，4.0 MB** ⚠️（**这一条我在初稿里说错了，见 §0 的修正**）
   - **逐文件引用数 = 0**：26 个文件的**完整路径**在 `src/ tests/ scripts/ docs/ data/ package.json README.md` 里逐个 `git grep -F` 查过，**全部 0 命中**。
   - **但目录通配被 8 个文件引用**：`git grep -F 'reports/c17'` 命中
     `docs/CHECKLIST.md`（4 处）、`docs/DIFFICULTY-AND-SOLUTIONS.md`、`docs/DOCS-AUDIT.md`（2 处，
     其中 `:154` 明确写「`reports/c17/*.png` 26 张 …… 全部存在 ✓」）、`docs/INTERVIEW-DRILL.md`、
     `docs/P05-RULES-SOURCE.md`、`docs/S05-W09-SLOW-MODEL.md`、`docs/W10-ACCEPTANCE-MAPPING.md`（2 处）、
     **以及生成它的脚本 `scripts/cdp-long-game.js:27`（`--out=dir` 默认 `reports/c17`）**。
   - **含义**：这 26 张 PNG 是 **C17 验收项的证据链**（「8 局长局 + 残局提示 8/8 + 26 张截图」），
     **同时又是可重跑生成物**。→ **它不是一个干脆的「零引用」候选，见 §4.2 的修正结论。**
   - **不被忽略**：`.gitignore` 只有 `reports/roco/**/*.png`（79）与 `reports/roco/acceptance|demo-acceptance/*.png`（51、57），**都不覆盖 `reports/c17/`**。
   - 它还在 churn 榜上（`git log --name-only -- reports/c17` 命中 26 行），说明这批图被反复重跑重提。
2. **`reports/p05-rules-dialog.png`（顶层）1 个**：同样不被忽略，也同样被
   `docs/W10-ACCEPTANCE-MAPPING.md:85` 当作 P05/G08 的验收证据引用（**同样不是零引用**）。
3. **`reports/test-output.txt`**（38 KB，**81 次提交在改**）是裸测试日志，**没有**被忽略，且仍被 11 份文档引用（`docs/CHECKLIST.md`、`docs/EXPERIMENTS.md` 等）。→ **不能**直接忽略，会造成文档悬空引用。

**「每次跑都变」但现在仍入库的高 churn 文件（实测 `git log --name-only` 计数）**：

| 提交次数 | 文件 | 被引用数 | 判断 |
|---:|---|---:|---|
| 101 | `reports/roco/verification/latest.json` | 9 | **刻意入库**：`.gitignore` 注释明确写了「结论已经落在 latest.json 与 last-green.json 里」 |
| 99 | `reports/roco/demo-acceptance/demo-acceptance.json` | 10 | 同上，是结论回执 |
| 88 | `reports/roco/verification/last-green.json` | 6 | 刻意入库（全绿记录） |
| 81 | `reports/test-output.txt` | 9 | **半裸产物**：结论重复、日志也进库 |
| 74 | `reports/roco/acceptance/browser-acceptance.json` | 3 | 结论回执 |
| 73 | `reports/roco/rag/rag-eval.json` | **15** | 结论，被引用最多 |
| 54 | `reports/roco/workshop-acceptance/browser-workshop-acceptance.json` | 4 | 结论回执 |
| 49 | `reports/roco/ux-acceptance/browser-roco-ux-acceptance.json` | 3 | 结论回执 |
| 47 | `reports/roco/box-acceptance/browser-box-acceptance.json` | 2 | 结论回执 |
| 37 | `reports/roco/demo-acceptance/demo-dom-snapshots.json` | **1** | **候选**：DOM 快照，只有 1 处引用 |
| 25 | `reports/roco/dashboard.json` | 2 | 生成物，可复现 |
| 20 | `reports/roco/rc505/mobile-sweep.json` | 3 | 结论回执 |
| 41 / 40 / 39 / 37 … | `reports/roco/**/*.png` | — | **已忽略**（历史遗留仍在索引里的 0 个） |

**churn 分布（全部 685 个曾被改过的 reports 文件）**：

```
  0–  9 次 : 626 文件   ← 绝大多数是「一次写下的结论」
 10– 19 次 :  28 文件
 20– 29 次 :  11 文件
 30– 39 次 :   9 文件
 40– 49 次 :   4 文件
 50– 59 次 :   1 文件
 70– 79 次 :   2 文件
 80– 89 次 :   2 文件
 90– 99 次 :   1 文件
100–109 次 :   1 文件   ← latest.json
```

> 这张分布是关键：**626/685 的文件只动过个位数次**，它们是结论，该入库；
> 真正「每次跑都变」的是**顶部那 ~13 个**文件。所以 `reports/` 的问题不是
> 「整个目录该 gitignore」（那会把结论扔掉），而是**顶部那十几个没有和底部 600 多个分开**。

**「同一份东西两处存」——实测 11 组字节完全相同**（`shasum -a 256` 逐对比）：

```
2 份  reports/roco/invalidated/shadow-replay-sft-v1.json  =  .../shadow-replay-sft-v2.json
3 份  reports/roco/{invalidated/shadow-replay-local_4b.json, invalidated/shadow-replay-sft-v3.json, shadow-replay-local_4b.json}
2 份  reports/roco/{invalidated/shadow-replay-local_4b-promptv2.json, shadow-replay-local_4b-promptv2.json}
2 份  reports/roco/{rules-numbers-2026-09-25/eval-summary-before.json, swap-compare-2026-09-25/eval-summary-with-swap-policy.json}
2 份  reports/roco/{swap-compare-2026-09-25/eval-summary-before-swap-policy.json, term-lookup-2026-09-25/eval-summary-with-term-policy.json}
2 份  reports/roco/{rules-numbers-2026-09-25/eval-summary-after.json, six-pet-stats-2026-09-25/eval-summary-before.json}
2 份  reports/roco/{compare-pets-2026-09-25/eval-summary-before.json, six-pet-stats-2026-09-25/eval-summary-after.json}
2 份  reports/roco/{planner-rules-2026-09-25/eval-summary-catalog.json, roster-agent-2026-09-25/eval-summary-two-rules.json}
2 份  reports/roco/{roster-agent-2026-09-25/eval-summary-final.json, term-lookup-2026-09-25/eval-summary-before-term-policy.json}
2 份  reports/roco/{coach-agent/acceptance.json, six-pet-stats-2026-09-25/coach-agent-acceptance.json}
2 份  reports/roco/{pilot-1000/metrics.json, regression/logs/pilot-1000-metrics.json}
```

`invalidated/` 那三组是**刻意**的（作废存档保留原字节，`reports/roco/invalidated/README.md` 有说明，且 `model-arm-identity.test.js` 守着它）。
**另外 8 组不是刻意的**：它们是「按日期命名的轮次目录」（`*-2026-09-25/`）各自留了一份同名 `eval-summary-*.json`，
内容一模一样，分不清哪份是「这一轮的结论」、哪份是「顺手拷的上一轮」。

**「结论 / 未引用」的量化**（用 `git grep -h -o -F -f` 单趟扫，把每个 reports 路径当模式）：

```
已跟踪 reports 文件    458  （100.8 MB）
  被引用（结论型）      210  （ 72.3 MB）
  没被引用（回执型）    248  （ 28.5 MB）
```

未引用的 248 个里，按目录集中的是：`reports/roco/verification` 26、`reports/c17` 26、
`reports/roco/regression/logs` 19、`reports/roco/roster-agent-2026-09-25` 14、
`reports/roco/tool-coverage-arms` 9、`reports/roco/agent-tooluse-2026-09-25` 8、`reports/roco/sft*` 各 3–7。

> **注意**：这个「引用」只统计**已跟踪文本文件**里的引用。`reports/roco/*-run.json`
> 这类被忽略的文件里的引用**没算进去**，所以「未引用」是**上界**，不是判决书。
> 但它足以指出方向：248 个文件 / 28.5 MB 里，大多数是「跑完就没人再看」的回执。

### 2.4 `data/roco/` 的分层基本清楚，但有两处「同名不同物」

实测 `data/roco/`（**158 文件 / 62.3 MB**，全部 data 都在 roco 域下）：

| 层 | 文件 | 体积 | 是什么 | 分层判断 |
|---|---:|---:|---|---|
| `raw/` | 11 | 5.6 MB | 上游归档（`rocom-wiki-data.tar.gz` 844 KB、`rocom-data.tar.gz` 4.0 MB）+ `hke-2026-09-27/` 抓取 | ✅ 清楚：**只进不出，带 SHA256** |
| `normalized/` | 13 | 4.4 MB | `roco-world-s4-2026-09-10/`（12 精灵、824 技能、312 学习表、120 相性）+ `layer-playable-48/` 子层 | ✅ 清楚：**按 revision 冻结在目录名里** |
| `derived/` | 6 | 2.2 MB | `on-demand-builds.json` 1.4 MB、`pet-mechanisms.json` 0.7 MB、`pet-sprite-map.json`、`pvp-magic.json`、`tactic-cards.json`、`pet-sprite-audit.json` | ✅ 清楚：**可从 normalized 重算** |
| `evidence/` | 4 | 108 KB | `rule-evidence-ledger.json`、`microcase-recordings.json`、`user-in-game-reports.json` | ✅ 清楚 |
| `owned/` | 2 | 284 KB | 玩家自己的精灵盒 `owned-pets.json` + schema | ✅ 清楚：**玩家数据，与规则数据分开** |
| `systems/` | **1** | **4 KB** | `natures.json`（性格）**孤零零一个文件** | ⚠️ 分层过度：为 1 个文件开一层 |
| `assets/` | **102** | **45.8 MB** | 精灵立绘 PNG（`pets/`、`pets-unmapped/`） | ⚠️ **占了 data/ 73% 的体积**，且是二进制美术资源，和「数据」不是一回事 |
| `game-data-pack/` | 2 | 3.3 MB | `v2/pack.json` + schema | ⚠️ 与 `normalized/` **职责重叠**（见下） |
| `gold/` `rag/` `rulesets/` `meta-prior/` `live/` | 1/2/3/2/1 | 小 | 各有 schema | ✅ 清楚：**每个域自带 schema** |
| **根平铺** | **8** | — | `sources.yaml`、`provenance.jsonl`、`conflicts.jsonl`、`battle-modes.json`、`artifact-registry.json`、`engine-trait-status.json`、`hidden-keys.json`、`lineup-legality.jsonl` | ⚠️ **8 个平铺文件没有归属层**：`sources.yaml`/`provenance.jsonl` 明显属于「台账」，`battle-modes.json`/`rulesets/` 属于「规则」，`hidden-keys.json`/`engine-trait-status.json` 是**生成物**（应由 `export-hidden-keys.py`/`export-trait-status.py` 重算） |

**「同一份东西两处存」的两处实证**：

1. **`layer-playable-48/` 与它的父目录同名不同物**（实测 `cmp` 不同 + 体积差 5.7 倍）：

   | 文件 | `normalized/<rev>/` | `normalized/<rev>/layer-playable-48/` |
   |---|---:|---:|
   | `pets.json` | 14,374 B | 82,540 B |
   | `learnsets.json` | 48,746 B | 220,041 B |
   | `support-matrix.json` | 191,836 B | 195,439 B |

   **同一个 basename 在同一个 revision 下出现两次、内容不同**，靠路径区分「全量」和「48 只可玩层」。
   这是可用的，但**读的人必须记住**「不带子目录的是全量、带 `layer-playable-48/` 的是层」——
   没有 README 说这件事。

2. **`data/roco/derived/on-demand-builds.json`（1.45 MB）vs `reports/roco/rc402/on-demand-builds.json`（shasum 不同）**：
   同一份「按需构建」产物，一份在数据层、一份在报告层，内容已漂移。
   同理 `data/roco/normalized/<rev>/roster-48.json` vs `reports/roco/coverage/roster-48.json`（shasum 不同）。
   全仓 `data/`+`reports/` 之间**同名不同物**的 basename 共 **26 组**。

> 一个正面发现：**`data/roco/` 是全仓引用最多的路径（12,827 处 / 300 文件）却没有出现「找不到」的问题**——
> 因为 `roco/src/roco_env/data.py` 是**唯一的 I/O 入口**（`docs/STRUCTURE.md` §3.5 明确的约束），
> 引用密度高但**收口在一处**。这是本仓最好的一条架构纪律，值得在别处复制。

### 2.5 `docs/roco/` 与 `docs/roadmap/` 的边界：**单向清晰，反向模糊**

实测：

| | `docs/roco/` | `docs/roadmap/` |
|---|---:|---:|
| 文件 | **159**（平铺 86 + `mockups/` 68 + `mvp/` 5） | **44**（平铺 29 + `handoff-revised-2026-09-21/` 15） |
| 体积 | 1.3 MB（平铺部分） | **2.0 MB** |
| 最大单文件 | — | `DSH-EXECUTION-STATE.md` **1,037 KB** |
| 最后提交 | 09-28 04:26 | 09-28 04:26 |

**引用方向严重不对称（实测）**：

```
docs/roadmap → docs/roco/     282 处，23 个文件
docs/roco/   → docs/roadmap/   14 处，12 个文件
```

**边界在这两个方向上是清楚的**（这是本仓**已经写下来**的约定，不是我的发明）：

- **`docs/roadmap/` = 「往下怎么走」**：断点状态（`DSH-EXECUTION-STATE.md`）、交接
  （`HANDOFF-*`、`handoff-revised-*`）、计划（`LONG-TERM-PLAN`、`FLAGSHIP-V3-*`）、
  决策（`HUMAN-RULINGS-*`、`JEV-AND-SYSTEM1-DECISIONS`）、调研（`AGENT-TECH-*`）。
- **`docs/roco/` = 「东西是什么、怎么验」**：规则域定义（`RC-*` 11 份、`W5-04-*` 4 份、`M0/M1-*` 2 份）、
  数据台账（`DATA-CONFLICTS`、`RULE-EVIDENCE-LEDGER`、`LICENSE-MATRIX`）、
  界面与机制（`PET-MECHANISMS`、`TEAM-*`、`TURN-ORDER`）、规范（`PLAIN-SPEAK`、`WORKSHOP`）。

**乱在哪（实测）**：

1. **`docs/roco/` 86 个平铺文件里，81 个是全大写横杠命名**——命名约定统一，但**没有二级分组**。
   按用途至少有 4 组已经成形却混在一起：
   - **RC-/W#-/M#- 轮次产物（19 份）**：`RC-105-MANA-AND-ACTIONS`、`RC-106-SIX-PET-BATTLE`、`RC-401…404`、`RC-501/502/505`、`RC-602/604`、`W4-02`、`W4-04`、`W5-04-*`（4 份）、`M0-REPO-AUDIT`、`M0-M1-ACCEPTANCE`
   - **域定义（约 25 份）**：`PET-MECHANISMS`、`TEAM-*`、`TURN-ORDER`、`EFFECT-PRIMITIVES`、`LINEUP-LEGALITY`、`PVP-FAIRNESS-RULES`、`ROSTER-48/60`、`OWNED-PETS`、`PET-BOX` …
   - **数据与许可台账（约 8 份）**：`DATA-CONFLICTS`、`RULE-EVIDENCE-LEDGER`、`LICENSE-MATRIX`、`CATALOG-RECONCILIATION`、`COMMUNITY-SOURCES`、`FULL-CATALOG`、`GAME-DATA-PACK`
   - **规范与流程（约 6 份）**：`PLAIN-SPEAK`、`RULE-PROMOTION`、`RULE-CONFIG`、`GUARD-SELFTEST`、`HUMAN-REVIEW-CHECKLIST`、`WORKSHOP`
2. **`docs/roco/mockups/` 是「按时间抄目录」而不是「按版本归档」**：
   69 个文件 / 6.5 MB，其中 `v3b/` `v3c/` `v3d/` `v3e/` `v3f/` `v3g/` **7 个平行目录各自存了一份同名截图**
   （`battle-v3-default-1440x900.png` 在 8 个位置、`battle-v3-switch-1440x900.png` 在 8 个位置、
   `battle-v3-xiaoya-1440x900.png` 在 8 个位置）。
   **69 个文件内容两两不同**（我按 sha 查过，没有一组字节重复），所以不是「拷贝粘贴」，
   而是**8 代 mockup 迭代一代一个目录，一代都没退休**。
3. **一份 basename 撞车**：`docs/RELEASE-v0.1.md`（6,223 B）与 `docs/roco/RELEASE-v0.1.md`（7,177 B）
   同名不同内容（`diff` 300 行），且 `docs/roco/RELEASE-v0.1.md` 是**孤儿**（全仓 0 引用）。
   两份都讲 v0.1 发行，读的人不知道看哪份。
4. **孤儿文档 23 份**（全仓 tracked 文本里 0 引用）：`docs/COACH-ACCEPTANCE.md`、
   `docs/ENVIRONMENT-NOTES.md`、`docs/roadmap/` 的 19 份（`HANDOFF-2026-09-27`、
   `handoff-revised-2026-09-21/*` 11 份、`MORNING-REPORT-*` 2 份、`SELF-REVIEW-2026-09-25`）、
   `docs/roco/` 的 6 份（`AGENT-LOOP-CORRECTION`、`PET-MECHANISMS`、`RELEASE-v0.1`、
   `ROSTER-60`、`STRESS-AND-PLANNING-DESIGN`、`TEAM-SERVING`）。
   → 164 份 `.md` 里 141 份被引用、23 份没有。**没有判据要求文档被索引**，所以孤儿会一直攒。
5. **`docs/` 根目录 33 个文件里混了 1 个 `.txt`**：`docs/codex聊天记录.txt`。
   其余 32 份是 `.md`。命名也不统一（`coach-design-notes.md` 全小写 vs `COACH-PLAN.md` 全大写）。

**该合并的**：`docs/roco/RELEASE-v0.1.md` 与 `docs/RELEASE-v0.1.md`（撞名、一份孤儿）。
**该拆的**：`docs/roadmap/DSH-EXECUTION-STATE.md` —— **单文件 1,037 KB / 1.0 MB**，
是全仓最大的文本文件，比第二名（`AGENT-TECH-SURVEY.md` 181 KB）大 5.7 倍。
它承载「第 1 轮…第 95 轮」的全部断点，一条 `git diff` 就能让它整段重排。
**这是 `docs/` 里唯一一个「体积本身已经是问题」的文件。**

### 2.6 机制性原因：**索引层完全没跟上增长速度**（测量期间亲历）

这一条不是从文件里读出来的，是**测量过程本身撞上的**：

```
20:28Z  HEAD e02faaf   tracked 1,471
20:33Z  HEAD d315b3d   tracked 1,475     ← 5 分钟内 1 次提交
```

期间仓库自己长出了：`docs/roco/MECHANICS-VS-POKEMON.md`、
`scripts/roco/build-difficulty-holdout.mjs`、`scripts/roco/verify-difficulty-holdout.mjs`、
`scripts/roco/build-hke-layer.mjs`、`tests/roco-difficulty-holdout.test.js`、
`tests/roco-mechanics-sources.test.js`、`tests/evals/agent-tasks-v3-difficulty/`、
`reports/roco/difficulty-holdout.json`，
并且 **`.gitignore` 从 67 行长到 79 行**（新增「小黑盒抓包 1120 个 JSON / 35 MB 不入库」裁决）。

**新增的 6 个源文件全部落进了平坦层**（4 个进 `scripts/roco/` 根、2 个进 `tests/` 根），
`.gitignore` 又长了 12 行——**这就是 §2.1–2.3 那三个平铺层持续恶化的机制**：
新增成本极低（往平坦层丢一个文件），索引成本极高（要记得同步 `package.json` 的 149 条清单、
`verify-release.mjs` 的 27 条套件、`docs/STRUCTURE.md`、`docs/roadmap/*`）。
**只要索引是「手工清单」，增长就一定会跑在索引前面**——
`scripts/roco/` 已经 143 个脚本而**没有任何判据要求它被引用**，正是这条规律的结果。

**几分钟后我拿到了这条规律的直接证据**：复核时 `git diff -- package.json` 显示，
那次提交**改的正好是 `test:unit` 那一行**——把 `tests/roco-hke-layer.test.js`、
`tests/roco-mechanics-sources.test.js`、`tests/roco-difficulty-holdout.test.js`
**手工插进那 5,103 字符（现约 5,250）的清单里**。
也就是说：**同一段时间里，「手工清单」这个索引被手工维护了一次，而平坦层同时长了 6 个文件。**
这不是推断，是同一时刻的两份 diff。
（附注：`package.json` 的那处修改**不是我做的**——本文只新增了本文件这一个路径；
本文 §1.1 的 `tracked` 数字也因此与现值有 ±个位数漂移。）

---

## 3. 提案：目标布局（分组 + 索引，**默认不搬家**）

**总原则**：本仓的迁移成本**几乎全部来自「手工清单 + 路径字符串写死在文档里」**。
所以提案分三档，**收益递减、成本递增**：

- **A 档（索引）**：只加 `README.md`，零引用改动。→ §4
- **B 档（分组 + 单向兼容）**：新建目录、**旧位置留转发/留空**，或只对**新增文件**生效。→ §3.1–3.3
- **C 档（真搬家）**：给出现有文件的完整迁移成本，**本轮不建议做**。→ §3.4

### 3.1 `tests/`：先给「新文件」定域，旧文件原地不动

**目标布局（新增文件生效，旧文件不动）**：

```
tests/
├── README.md              ← A 档：116 个平铺测试按域索引（见 §4）
├── helpers/               ← 已有
├── evals/                 ← 已有，保持
│   └── roco/              ← 已有，保持
├── coach/                 ← 新：教练链路（未来新测试落这里）
├── roco/                  ← 新：手游规则域（未来新测试落这里）
└── roco-*.test.js  ×100   ← 旧文件原地不动（不搬！）
```

| 项 | 内容 |
|---|---|
| **收益** | 域从此有**目录**这个落点，不靠人记前缀；新测试不用再问「放 `tests/` 还是 `tests/evals/`」；`tests/README.md` 把已有 100 个 `roco-*` 按 8–10 个域列出来，**找文件从「靠记忆」变成「查索引」** |
| **风险** | **极低**。新增目录 + `README.md` 不触发任何现有判据（实测见 §4.1）。唯一风险是「新文件进新目录、旧文件在老位置」的**中间态会持续存在**——这是刻意的，用 README 顶住 |
| **迁移成本（实测）** | **0 处引用改动**（不动任何现有文件）。若要做 C 档真搬家：**100 个文件移动 + 325 条 import + 911 处路径串 ≈ 1,236 处**，其中 `package.json` 101 处（`test:unit` 98 + `test:browser` 1 + `test:roco-experience` 1）、`scripts/` 65 处 / 29 文件、`docs/` 436 处 / 49+ 文件、`src/` 49 处、`reports/` 约 100 处 |
| **判据保护现状** | `.test.js` **有**（structure-contract 第 900 行，漏改会红）；`tests/**` 的非 `.test.js` 资产（jsonl 夹具、`mock-host/`）**没有**——搬它们会**静默**在运行时 `ENOENT` 失败 |

### 3.2 `scripts/roco/`：这是**最该分组、也最不该搬家**的目录

**目标布局（分组名 = §2.2 那四类）**：

```
scripts/roco/
├── README.md      ← A 档：142 个脚本按 生成器/验收/分析/库 四类索引（见 §4）
├── lib/           ← 新：*-lib.mjs、schema.mjs、lua-safe-parse.mjs、notify.mjs、model-identity.mjs、ruleset-energy.mjs（11 个）
├── gen/           ← 新：build-*/export-*/import-*/report-rc*（49 个）
├── accept/        ← 新：browser-*/verify-*/check-*/guard-selftest（41 个）
└── *.mjs *.py     ← 旧脚本原地不动
```

| 项 | 内容 |
|---|---|
| **收益** | 把「脚本类别只活在命名前缀里」变成目录事实；`scripts/roco/README.md` 顺手修掉 §2.2 里那三个**名字骗人**的脚本（`record-measurements.py` 其实是生成器、`shadow-replay.mjs` 其实写报告、`verify-release.mjs` 是总闸） |
| **风险** | **中**。`scripts/roco/` 被 **481 个文件**按路径引用——把它整体或部分搬家，是本仓**耦合度最高**的一次改动 |
| **迁移成本（实测）** | 只加 `README.md`：**0 处**。真搬家：`scripts/roco/` 路径串 **1,989 处 / 481 文件**（`package.json` 61 + 其余 1,927），另有 `scripts/roco/*.mjs` 之间 **55 条** `from './xxx.mjs'` 要改成 `from '../xxx.mjs'`；而 `roco/`（Python 引擎）**不受影响**（它自己的测试走 `unittest discover`，自动发现，天然免疫搬家） |
| **判据保护现状** | **没有**。全仓**不存在**「每个 `scripts/roco/*` 都被某个 npm script 引用」的判据。所以把 `build-foo.mjs` 移进 `gen/` 而漏改 `package.json`，**没有任何东西会红**——这是本仓最大的**静默失败面**（见 §5） |

### 3.3 `reports/`：按「稳定性」分三层，只把顶层那 13 个高 churn 文件分出去

**目标布局**：

```
reports/
├── README.md      ← A 档：写清「哪一层是结论、哪一层是回执、哪一层随时可删」（见 §4）
├── conclusions/   ← 新（或沿用现有子目录）：只动个位数次的 626 个文件
├── receipts/      ← 新：churn ≥ 20 的 13 个「每次跑都变」
└── roco/ c17/ companion/  ← 旧结构原地不动
```

| 项 | 内容 |
|---|---|
| **收益** | 一眼分清「这是结论」和「这是上次跑的回执」。现在 churn ≥20 的 13 个文件**和 626 个只动过个位数次的文件混在同一层**，`git status` 每次都被它们弄脏 |
| **风险** | **中高**。`reports/roco/rag/rag-eval.json` 被 **15 处**引用、`demo-acceptance.json` 10 处、`latest.json` 9 处、`test-output.txt` 9 处——搬它们要同步改判据与文档 |
| **迁移成本（实测）** | 只加 `README.md`：**0 处**。真搬家：13 个高 churn 文件共约 **62 处引用**（`latest.json` 9 + `demo-acceptance.json` 10 + `last-green.json` 6 + `test-output.txt` 9 + `browser-acceptance.json` 3 + `rag-eval.json` 15 + `demo-dom-snapshots.json` 1 + `dashboard.json` 2 + `mobile-sweep.json` 3 + 三个 acceptance 各 2–4 + `live-acceptance.json` 1）。另外 `reports/` 整体路径串 **1,755 处 / 339 文件** |
| **更该做的** | 见 §4.2：**先裁决「截图算不算可丢弃产物」**，再谈分组。⚠️ 这一条**不是**零引用改动（初稿说错了，已修正） |

### 3.4 `data/roco/` 与 `docs/`：只收口，不重组

| 提案 | 收益 | 风险 | 迁移成本 |
|---|---|---|---|
| **给 `data/roco/` 加 `README.md`**，写清 `raw → normalized → derived → evidence` 的**单向流向**、以及 `layer-playable-48/` 与父目录同名不同物这件事 | 读的人不用再猜 `pets.json` 有两个 | **极低** | **0 处** |
| **`data/roco/` 根目录 8 个平铺文件归位**（`sources.yaml`/`provenance.jsonl` → `ledger/`；`battle-modes.json` → `rulesets/`；`hidden-keys.json`/`engine-trait-status.json` 标注为生成物） | 8 个文件有归属 | 中：`data/roco/` 是**全仓引用最多的前缀（12,827 处 / 300 文件）** | **不建议本轮做**。真做要动 `roco/src/roco_env/data.py`（唯一 I/O 入口）+ 300 文件的引用 |
| **`data/roco/assets/`（102 文件 / 45.8 MB，占 data/ 73%）单独说明**：它是**美术资源**不是「数据」，且 45.8 MB 已经在 git 历史里 | 至少让人知道 data/ 的体积在哪 | 低 | 0 处（只写文档） |
| **`docs/roco/RELEASE-v0.1.md` 与 `docs/RELEASE-v0.1.md` 合并**（撞名，后者被引用、前者是孤儿） | 消掉一处「看哪份」的歧义 | 低：删 1 个孤儿文件。但**删文件不在本轮约束内** | 待定：需先确认孤儿的 7,177 B 有没有独有内容（`diff` 300 行） |
| **`docs/roadmap/DSH-EXECUTION-STATE.md`（1,037 KB）按轮次拆成 `docs/roadmap/state/round-*.md` + 一份薄索引** | 单文件从 1.0 MB 降到几十 KB，diff 不再整段重排 | **高**：它是**接手时的唯一断点文件**，`verify:state-doc` 判据直接读它；且文档明确「先读这份」 | **不建议本轮做**。要动 `scripts/roco/verify-state-doc.mjs` + 判据 + `docs/STRUCTURE.md` 的指向 |
| **`docs/` 内部分域**：`docs/roco/` 86 个平铺文件按「轮次产物 / 域定义 / 台账 / 规范」分 4 组 | 找文档从「扫 86 个全大写名」变成「进对的组」 | 中：`docs/roco/` 路径串 **778 处 / 179 文件** | 只加 `docs/roco/README.md` 索引：**0 处**（推荐）。真搬家：778 处 + `docs/roadmap/` 339 处 |

---

## 4. 现在就能安全做的一小步（零引用改动）

三条都**只新增文件 / 只改 `.gitignore`**，不动任何现有文件的路径，因此**不可能**让任何
`grep -rn <path>` 失效。逐条说明为什么零风险。

### 4.1 给 8 个目录各加一份 `README.md` 索引（零引用，**推荐**）

**做什么**：新增 `tests/README.md`、`scripts/roco/README.md`、`reports/roco/README.md`、
`data/roco/README.md`、`docs/roco/README.md`、`docs/roadmap/README.md`、`roco/README.md`、`knowledge/README.md`。

**为什么零风险（实测，不是推断）**——我逐条查了本仓所有会枚举目录的判据，它们**全部按扩展名过滤**：

| 判据 | 枚举行为 | 加 `README.md` 会怎样 |
|---|---|---|
| `tests/evals/structure-contract.test.js:914`（孤儿测试判据） | `walk('tests')` 只收 `entry.name.endsWith('.test.js')` | ✅ 不受影响 |
| `tests/evals/structure-contract.test.js:932`（未跟踪源文件判据） | 只把 `.log/.tmp/.bak/.orig/.DS_Store` 判为可疑，且**只扫 `src/ tests/ tools/`** | ✅ 不受影响 |
| `tests/evals/structure-contract.test.js:987`（顶层条目判据） | 只 `readdirSync(ROOT)`，**只看仓库根** | ✅ 不受影响 |
| `tests/evals/structure-contract.test.js:874`（全仓相对 import 判据） | 只扫 `.js/.mjs` | ✅ `.md` 不被扫 |
| `tests/evals/subprocess-env.test.js:20` | 递归只收 `.test.js` | ✅ 不受影响 |
| `tests/roco-tool-task-coverage.test.js:61` | `readdirSync(sftDir).filter(name => name.endsWith('.jsonl'))` | ✅ 不受影响（**但别往 `reports/roco/sft-coverage/` 加 `.jsonl`**） |
| `tests/evals/roco/model-arm-identity.test.js:26,76` | `filter(/^shadow-replay.*\.json$/)` | ✅ 不受影响（**但别往 `reports/roco/` 加 `shadow-replay*.json`**） |
| `tests/roco-teacher-shape.test.js:178`、`roco-single-agent-invariant.test.js:37` | 只收 `.js` | ✅ 不受影响 |

**额外收益**：本仓现在**只有 11 份 `README.md`** 被跟踪（`docs/README.md`、根 `README.md`、
`data/roco/assets/pets{,-unmapped}/README.md`、`data/roco/raw/hke-2026-09-27/{,tools/}README.md`、
`reports/roco/{intervention,invalidated,pilot-1000,rc-free-action,verification}/README.md`）。
`tests/`、`scripts/`、`data/roco/`（根）、`knowledge/`、`roco/`、`src/*/`、`docs/roco/`、`docs/roadmap/`、`reports/`
**全都没有索引**——而 `reports/roco/invalidated/README.md` 已经证明了这个模式在本仓**是生效的**
（它被 `model-arm-identity.test.js` 直接断言「必须存在且写明原因」）。
**`data/roco/raw/hke-2026-09-27/README.md` 是最新的一例**（并发提交里刚加的，
`.gitignore` 第 31 行明确把它当「复抓说明」引用）——**这个模式正在本仓自己长出来**，
本提案只是把它推到还缺索引的那几个大目录。

**成本**：8 个新文件，0 处引用改动，0 个判据需要改。

### 4.2 给 `reports/c17/` 加 `.gitignore` —— **⚠️ 不是零引用，需要人裁决**

> **这一条是初稿里唯一被我自己推翻的建议。** 初稿说「`reports/c17/` 引用数 = 0」，
> 复核后确认**说错了**：引用它的是**目录通配**不是文件名，因此它有**证据链**。

**做什么（如果裁决为「做」）**：在 `.gitignore` 的验收截图那一段
（现第 77–79 行 `reports/roco/**/*.png` 附近）追加：

```gitignore
# reports/c17/ ：2026-09-17 C17「长局残局提示」验收的 26 张整局截图（4.0 MB）。
# 判定依据（与第 77–79 行同一条口径）：
#   · 逐文件引用数 = 0（26 个完整路径在全仓 `git grep -F` 零命中）；
#   · 可重跑生成：`node scripts/cdp-long-game.js`（`--out=dir` 默认就是 reports/c17）；
#   · 结论在 reports/c17-endgame-browser.md 与 docs/CHECKLIST.md 的 C17 条目里。
# ⚠️ 代价：docs/DOCS-AUDIT.md:154 有一句「reports/c17/*.png 26 张 …… 全部存在 ✓」，
#    忽略后这句要改成「可重跑生成」，否则新克隆的人无法复核这句话。
reports/c17/*.png
```

**实测事实（两面都说）**：

| 面 | 实测 |
|---|---|
| **支持忽略** | 逐文件引用数 = **0**（26 个完整路径零命中）；**可重跑生成**（`scripts/cdp-long-game.js:27` 默认输出到 `reports/c17`）；本仓**已有同形先例**（`.gitignore` 第 77–79 行对 `reports/roco/**/*.png` 就是这么裁决的，且生效后 `reports/roco/` 下已跟踪 PNG = 0）；churn 26 次，属于「反复重跑重提」 |
| **反对忽略** | **8 个文件**引用 `reports/c17/*.png` 作为 C17 验收证据：`docs/CHECKLIST.md`（4 处）、`docs/W10-ACCEPTANCE-MAPPING.md`（2 处）、`docs/DOCS-AUDIT.md`（2 处，含「26 张截图全部存在 ✓」）、`docs/DIFFICULTY-AND-SOLUTIONS.md`、`docs/INTERVIEW-DRILL.md`、`docs/P05-RULES-SOURCE.md`、`docs/S05-W09-SLOW-MODEL.md`；其中 `DOCS-AUDIT.md` 那句**审计结论**在被忽略后会失去可复核性 |

**我的建议**：**先不做**。理由是**本仓对「截图」的口径本身还没有统一**——
`reports/roco/**/*.png` 已经忽略（结论在 `*.json` 里），但 `reports/c17/` 与
`reports/p05-rules-dialog.png` 的「结论」是 **`.md` + 人写的审计句**，
不是机器可复算的 `*.json`。**在把 C17 的结论变成一份 `*.json` 之前忽略截图，等于删掉唯一的证据。**
→ **这是一条需要产品负责人裁决的口径问题，不是审阅者能顺手决定的**（见 §6 第 9 条）。

**如果裁决为「做」，风险仍然很低**（机械上）：`.gitignore` **不会**让已跟踪文件消失，
**光加 ignore 一行不改索引**，所以这一条本身纯增量；
真正把 26 个文件从**索引**里拿掉需要 `git rm --cached reports/c17/*.png`——
那是**改索引**的动作，**不在本轮**，也不该由审阅者顺手做。

### 4.3 建 `tests/roco/README.md` 作为**新文件的落点**（零引用）

**做什么**：新建目录 `tests/roco/`（靠 `README.md` 让 git 记住这个目录），
README 里写明：「**旧的 `tests/roco-*.test.js` 留在原地不动**；**新写的**手游规则域测试放这里，
并在 `package.json` 的 `test:unit` 里显式登记（这是本仓纪律，见 `docs/STRUCTURE.md` §3）。」

**为什么零风险（实测）**：

- 孤儿判据 `walk('tests')` 只收 `.test.js`，空的 `tests/roco/` 不产生任何条目；
- 「未跟踪源文件」判据只把 `.log/.tmp/.bak/.orig/.DS_Store` 判为可疑，`README.md` 不在其中；
- **不产生名字冲突**：现有 `tests/evals/roco/` 在**另一个父目录**下，两者不冲突；
- **代价 1 个文件**，收益是「**目标布局先落地一格**」，让后续新增不再往平坦层堆。

> 三条都不做也可以。**排序（按实测风险/收益）**：
> **① 做 4.1**（零引用、8 个文件、修掉「找文件靠记忆」这个根问题）；
> **② 做 4.3**（零引用、1 个文件、给目标布局落地一格）；
> **③ 4.2 先别做**——它有证据链代价，需要产品负责人先裁决「截图算不算可丢弃产物」（见 §4.2 与 §6 第 9 条）。
>
> ~~初稿说「如果只做一条，做 4.2（收益/成本比最高）」~~：**这条建议已被复核推翻**，
> 因为「引用数 = 0」是错的。留着这行是为了让接手的人看到**结论是怎么被改掉的**，
> 而不是只看到一个漂亮的终稿。

---

## 5. 不要做的事（边界，写清理由）

### 5.1 不要在没有判据保护的情况下大规模搬家

**这条结论要保留，但前提要修正**——审阅中发现本仓的判据覆盖**不是均匀的**：

| 被搬的东西 | 有没有判据保护 | 漏改会怎样 |
|---|---|---|
| `tests/**/*.test.js` | ✅ **有**：`structure-contract.test.js:900`「每个 Node 测试文件都必须被某个 npm script 或自检登记表引用」 | **响亮地红**（我离线模拟过：新路径 → `isReferenced` 返回 `false`） |
| `tests/**/` 下的**非 `.test.js` 资产**（jsonl 夹具、`mock-host/`、`helpers/`） | ❌ **没有** | **静默**：判据运行时 `ENOENT` 才炸，且只在跑到那一条时炸 |
| `src/**` 的相对 import | ✅ **有**：全仓「相对 import 都指向真实文件」判据（`structure-contract.test.js:874`） | 响亮地红 |
| `roco/**`（Python） | ✅ **天然免疫**：`unittest discover -s tests` 自动发现，搬家不影响 | 不适用 |
| **`scripts/roco/**`** | ❌ **没有** | **静默**：全仓**不存在**「每个 script 都被某个 npm script 引用」的判据。把 `build-foo.mjs` 移进 `gen/` 而漏改 `package.json`，**没有任何东西会红** |
| `docs/**`、`reports/**` 的路径引用 | ❌ **没有** | **静默**：文档里的死链没有任何判据检查（实测已有 **23 份孤儿文档**） |
| `data/roco/**` | ⚠️ **部分**：`roco/src/roco_env/data.py` 是唯一 I/O 入口，路径在里面收口 | 改这一处能覆盖大部分，但 **300 个文件**里的引用不受保护 |

**所以「搬家会静默漏跑」这句话在 `tests/` 上是错的，在 `scripts/roco/` 上是对的。**
本仓真正需要的**不是「禁止搬家」，而是「先给 `scripts/roco/` 补一条和测试孤儿判据同形的判据」**——
即「每个 `scripts/roco/*` 至少被 `package.json`、`verify-release.mjs` 的 SUITES 或别的脚本引用一次」。
那条判据一旦存在，§3.2 的分组才从「C 档」降到「B 档」。

### 5.2 本轮明确不做的（约束，逐条）

1. **不改 `package.json`**（含 `test:unit` 那 5,103 字符的清单）——本次是审阅，不是重构。
2. **不改 `docs/roadmap/DSH-EXECUTION-STATE.md`**——它是接手时的**唯一断点文件**，且 `verify:state-doc` 在守它。
3. **不移动 / 重命名 / 删除任何现有文件**——包括那 23 份孤儿文档、26 个 `reports/c17` PNG（**逐文件零引用，但被 8 个文件按目录通配当作 C17 验收证据引用**）、
   8 组字节重复的 `eval-summary-*.json`、7 代平铺的 `docs/roco/mockups/v3*`。
   **「是孤儿」不等于「可以删」**：`docs/roadmap/handoff-revised-2026-09-21/*` 那 11 份没有任何引用，
   但它们明确是为「接手的人」写的。
4. **不把 `reports/` 整目录 gitignore**——458 个文件里 **210 个（72.3 MB）是被引用的结论**，
   整目录忽略会把 `reports/roco/rag/rag-eval.json`（15 处引用）、
   `reports/roco/flagship-upgrade/*`（11 处引用）、`reports/roco/m1-data/*`（7 处引用）一起扔掉。
   本仓在 `.gitignore` 第 42–46 行**已经就这个问题做过一次明确裁决**
   （「轨迹只入库 manifest，jsonl 不入库，因为完全可复现」），新提案应当**沿用同一条口径**，
   逐条列举，不搞整目录豁免。
5. **不改 `reports/roco/verification/latest.json` 与 `last-green.json` 的入库状态**——
   它们 churn 101 / 88 次，看起来"该忽略"，但 `.gitignore` 第 72–75 行的注释**明确裁决过**
   「结论已经落在 latest.json 与 last-green.json 里」，且被 9 / 6 处引用。
   **高 churn 不等于该忽略**——这是本仓已经做过的判断，审阅不该推翻它。
6. **不给 `reports/roco/sft-coverage/` 加 `.jsonl`、不给 `reports/roco/` 加 `shadow-replay*.json`**——
   这两个形状会被 `tests/roco-tool-task-coverage.test.js:61` 与
   `tests/evals/roco/model-arm-identity.test.js:26,76` 的 `readdirSync` 过滤器扫到，属于**会改变判据行为**的改动。
7. **不跑测试套件、不起浏览器、不碰 8765/8766/3080 上的任何进程**——按任务约束执行。

---

## 6. 本次审阅「没做 / 不确定」的（供接手的人复核）

1. **没跑任何测试**（用户明确要求）。§2.1 关于孤儿判据会「响亮地红」的结论来自
   **离线复现它的判定逻辑**（`scriptText.includes(rel)`，见 §0 的模拟），**不是**真的跑了
   `structure-contract.test.js`。若要坐实，跑一条即可：
   `node --test tests/evals/structure-contract.test.js`。
2. **没验 `scripts/roco/` 那 142 个脚本的实际被引用面**。§3.2 说的「没有判据保护」是
   **「我没找到」**——我用 `git grep` 找过，但**没有逐个脚本**去核对它是否被
   `verify-release.mjs` 的 `SUITES`（**27** 条）或别处调用
   （我只确认了 `SUITES` 里 27 条套件各自指向一个脚本，**没有**反查每个脚本是否只被这一处调用）。
   **`scripts/roco/` 里到底有多少个「写了但没人跑」的脚本，本文没有数字。**
3. **`reports/` 的「被引用 / 未被引用」判定有已知盲区**：只扫了**已跟踪文本文件**里的引用，
   被忽略的 `reports/roco/*-run.json`、`reports/roco/**/*.png` 里的引用**没算**。
   所以 §2.3 的「248 个未引用」是**上界**，不能直接当作删除依据。
4. **`data/roco/` 的 12,827 处引用没有逐条验证**。我只确认了 `data.py` 是唯一 I/O 入口
   （`docs/STRUCTURE.md` §3.5 与 `rebuild-derived-chain.mjs` 的说法），**没有**逐一核对
   300 个文件里是不是都走它。§3.4 关于「不该动 data/roco 根目录 8 个文件」的成本估计
   （300 文件）是**引用密度**，不是精确的改动数。
5. **没读 `docs/roadmap/DSH-EXECUTION-STATE.md` 全文**（1,037 KB）。我只读了开头 60 行与
   §1 / §1.45 的交接断点。**§2.5 说的「该拆」是基于体积与 `verify-state-doc` 的存在**，
   **不是**基于对它内部结构的通读——拆它之前必须通读。
6. **没验证 `docs/roco/RELEASE-v0.1.md` 与 `docs/RELEASE-v0.1.md` 的 300 行差异里有没有独有内容**
   （只比了 sha 与 diff 行数）。合并前必须逐段比对。
7. **`docs/roco/mockups/` 的 69 个文件我只看了文件名与 sha**（确认 8 个版本目录各自存同名截图、
   内容两两不同），**没有逐张看图**，所以不能判断「v3b–v3g 是否全部可以退休」。
8. **并发干扰（比初稿更严重，已升级为一条独立发现）**：测量期间有另一个 agent 在连续提交。
   工作区从 `e02faaf` 走到 **`d315b3d`**（20:28Z → 20:33Z，**5 分钟内 1 次提交**），
   期间新增了至少 5 个未跟踪文件（`docs/roco/MECHANICS-VS-POKEMON.md`、
   `scripts/roco/{build,verify}-difficulty-holdout.mjs`、`scripts/roco/build-hke-layer.mjs`、
   `tests/roco-{difficulty-holdout,mechanics-sources}.test.js`、`tests/evals/agent-tasks-v3-difficulty/`），
   并且 **`.gitignore` 从 67 行长到 79 行**。
   → 本文所有数字是 **20:28–20:33Z** 的快照；**复核时请重跑 §0 的命令，不要直接引用本文的数字当现值。**
   → **这本身就是一条发现**：仓库在「人类离开期间」以 **~1 次提交 / 5 分钟** 的速率自我增长，
     而**索引层（README / 清单 / 文档）完全没有跟上**——这正是 §2 那些「平铺 + 手工清单」
     会持续恶化的机制性原因。
9. **~~没验 `reports/c17` 是否会被某条流水线重新生成~~ → 已验，且结论反转**：
   初稿查 `git grep -l "c17" -- scripts src tests docs` 时把结果读成了「全是文档叙述」，
   **复核发现 `scripts/cdp-long-game.js:27` 就是生成器**（`--out=dir` 默认 `reports/c17`），
   并且 8 个文件按**目录通配**引用它。→ **`reports/c17/` 是可重跑生成物，但同时是 C17 的证据链**，
   所以 §4.2 从「零引用、推荐」改判为「需要人裁决」。**这条自我修正是本文最重要的一条记录。**
   仍未验的部分：**没有实际跑 `scripts/cdp-long-game.js` 确认它今天还能跑通**
   （它需要 headless Chrome 与 8765，**本轮不得起浏览器/碰进程**，所以无法验证）。
10. **没检查 `output/`（43 文件，最后提交 09-18）与 `report/`（38 文件，09-21）是否已退役**。
    它们 10 天没动，且 `output/pdf/xiaoya-coach-report.pdf` 被 `README.md` 引用。
    「一直没动」可能是「已完成」也可能是「被遗忘」，**我没有证据判断**。
11. **没验 `docs/roco/mockups/v3b`–`v3h` 那 7 个平行目录是不是全部由同一个脚本生成**。
    我看到的是「8 代迭代各自一个目录」，但**没找到驱动它们的脚本**
    （`scripts/roco/shoot-layout.mjs` 是**未跟踪**的新文件，名字像截图工具，**我没读它的内容**）。
    如果它们是一次性手工迭代，退休判定要靠人；如果是脚本批量生成，那 `mockups/` 就该重写规则。
