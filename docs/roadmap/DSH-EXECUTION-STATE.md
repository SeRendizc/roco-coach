# DSH 执行状态（断点续跑文件）

> 本文件是 DeepSeek Harness 接手本仓库时的**唯一断点状态**。
> 上下文压缩、进程重启或换 Agent 接手后，先读：
> `01-COLD-START-CONTEXT.md` → 本文件 → `git diff` → `reports/roco/m0-baseline/` 最近日志，
> 然后从下面「下一步」继续。**禁止重复已经验证过的工作。**
>
> 本文件不得写入 API key、完整模型响应或玩家隐私数据。

---

## 1. 当前目标与本轮范围

**产品目标**：把 `pet-game-coach` 从自创宠物对战 Demo 升级为《洛克王国：世界》**手游**内嵌主动 AI Coach「小芽 2.0」。

**本轮范围（严格执行，不多做）**：仅 **M0 + M1**。

| 编号 | 内容 | 状态 |
|---|---|---|
| M0-a | 固化当前仓库 / 测试 / 页面 / 性能基线 | 进行中 |
| M0-b | KEEP / ADAPT / RETIRE / MISSING 仓库审计 | 未开始 |
| M1-a | 版本化数据 schema、来源清单、许可状态 | 未开始 |
| M1-b | 导入 12 只手游精灵静态数据 | 未开始 |
| M1-c | 生成精灵支持矩阵 | 未开始 |
| M1-d | A 组 6 只候选配招（须有数据证据） | 未开始 |
| M1-e | 下一轮真实规则引擎 microcase 计划 | 未开始 |

**明确不在本轮做**：替换默认 UI、重写完整战斗引擎、下载/训练模型、租用云 GPU、安装任何 DSH 插件、
把规划和已实现混写、把页游数据混入手游规则域。

**验收方式**：每个完成项必须指向具体代码 / 数据文件 / 测试日志 / 浏览器证据；
未核验机制标 `unknown` / `unsupported`；测试通过不得替代数据真实性检查与真实页面验收。

---

## 1.5 后续轮次（M0/M1 之后，同一会话继续）

M0/M1 完成后，用户要求「不定格在 M2，目标定高、一直做」。因此本文件继续作为断点记录，
范围扩到旗舰线的可独立完成部分（不需要真人实验、官方一手数据、云 GPU 的那些）。

已完成的后续工作：

| # | 工作 | 证据 |
|---|---|---|
| 1 | 文件结构整理：顶层 38 → 3 个文件；`src/{game,coach,server,client}`、`tests/`、`tools/` | `docs/STRUCTURE.md`、`tests/evals/structure-contract.test.js` |
| 2 | 结构守卫：6 项契约测试，含「顶层只允许约定条目」并反向验证过会红 | 同上 |
| 3 | **规则引擎 `roco_env` 建成**：完整 3v3、确定性回放、隐藏信息边界、fail closed | `roco/tests/test_microcases.py`（38/38 通过） |
| 4 | **关键数据发现**：站点快照的 `stats` 是**种族值**而非面板值；从社区快照 452 条记录反推出换算（hp/atk/def 零误差） | `roco/src/roco_env/data.py` 的 `PANEL_FORMULAS` |
| 5 | 伤害公式作为**可替换假设**落地（带来源/许可/未核验标记），不冒充官方 | `roco/src/roco_env/effects.py` |

**尚未核验、因而引擎 fail closed 的机制**（每条都有对应 microcase）：
能量上限与回能时机、同速裁决、印记叠加替换、传动、天气、连击数、
属性增减层数语义、12 只精灵的特性效果、状态类技能的具体效果原语。

## 1.6 第 1 轮 goal（30 项 MVP）——隐私边界修正与四条支线

**本轮最重要的一次纠偏（监工指出，我原判断错误）**：我曾给 `state.seed` 开了
「只允许 state 下一层」的例外，放行真实对局 seed。那是**错的方向**：
真实 seed 能预测同速裁决与后续伤害的随机结果，它就是隐藏信息；
toolbox 的 `plan_actions` 合同也明确禁止真实随机种子——开后门会让
客户端与服务端契约互相矛盾。已修正：

| 项 | 修正 |
|---|---|
| seed 例外 | **彻底移除**。任何深度、任何位置的 `seed`/`rng_seed`/`random_seed` 都被拒 |
| `_pending_enemy` 等内部字段 | 补进 HIDDEN_KEYS（归一化后比较），现已拦截 |
| `/battle/plan` 输入 | 改为**公开 planner state**（`env.public_planner_state`），不再接受 `env.serialize()` 私有状态 |
| 随机性 | 用与真实对局无关的 `DEFAULT_ANALYSIS_SEEDS=(11,29,47)`，并**跨种子聚合**给区间而非单点 |
| 反证测试 | 新增 `roco/tests/test_public_planner.py`（12 项）：同公开观察+不同真实 seed → 请求与推荐必须一致 |

**另一处真 bug（本轮修）**：`observation_for` 之前**连对手场上那只**都不给
`hp/max_hp/energy`——那不是安全取舍，是真漏：对手场上的血条与能量本来就画在屏幕上，
看不到反而无法判断「这一击够不够收」。现在场上给面板、**后备仍隐藏**（血量/配能/配招）。

**四条支线（子 agent）已交付**：

| 支线 | 任务 | 交付 |
|---|---|---|
| ① 对手池+先导 | S01/S02 | `opponents.py`（五策略，隐藏信息只读代理）+ `run_pilot.py`；**1000 局 49.3 局/秒，非法动作 0、截断 0、异常 0** |
| ② coach 工具接入 | T02/G03 | `toolbox.js` 五个新工具契约 + 陈旧状态拒绝 + `toolbox-roco.test.js` |
| ③ 老师陪练记忆 | C01/C02/C03 | `memory.js` 显式偏好层/低置信心情/记忆控制；`teacher.js`；`companion.js` 六场景 |
| ④ 主动介入 | P01/P02 | 四档动作 `silent/micro_hint/action_hint/defer_to_review` + 硬门控先于评分；30 窗口评测（precision 1.0、stale 0） |

**我这一轮自己做的**：planner（G04）`roco/src/roco_env/planner.py` +
`/battle/plan` 接上服务；隐藏信息边界收紧；`observation_for` 修复。

### 本轮结束时的测试现状（全部绿）

| 套件 | 结果 |
|---|---|
| Node 全量（unit + browser） | **421 + 18，0 失败** |
| Python（引擎 + 对局域 + 公开 schema + 增伤接线） | **141 / 141**（1 项按守卫 skip） |
| Node↔Python 桥契约 | **11 / 11** |
| coach 工具层（toolbox-roco） | **17 / 17** |
| 规划端到端（plan-e2e，真 Python 服务） | **8 / 8** |
| 结构契约（含多页面白名单） | **8 / 8** |
| 投影层（roco-experience） | **9 / 9** |
| **合计** | **610 项，0 失败**（browser 1 项按测试自身的前置守卫跳过） |

另有两项**浏览器真机验收**（起真 Chrome、真 Python 引擎）：
`npm run roco:acceptance`（营地页 9/9）与 `npm run roco:demo-acceptance`（演示页 16/16）。

一条命令跑全部服务侧：`npm run test:roco-all`
（= `test:env` + `test:bridge` + `test:toolbox-roco` + `test:plan-e2e`）。

陪练支线那 3 条红已由该支线修好（都是它自己新加的场景测试里的 `undefined.some`
TypeError），**没有放宽任何既有断言**。

### 本轮收尾时补上的两处（监工纠偏的落地）

**① 两层隐藏信息边界曾经漏了一层（真漏洞，已修）。**
桥的 `HIDDEN_KEYS` 只有 13 个键，缺 `pendingenemy` / `pendingplayer` /
`pendingenemyaction` / `pendingplayeraction` / `replacequeue`。而
`env.serialize()` 里对手待执行动作的真实键名就是 `_pending_enemy`
（归一化 `pendingenemy`）——也就是说**私有状态能从桥本地穿过去**，
只剩 Python 服务端兜底。MC-013 要求两层都拦，桥是第一层，这个缺口必须补。

现在三份词汇表一一对应：Python `service.HIDDEN_KEYS`、Node 桥
`roco-client.HIDDEN_KEYS`、浏览器工具层镜像 `toolbox.ROCO_HIDDEN_KEYS`。
并且新增了**跨文件比对测试**（`plan-e2e.test.js` 最后一条）：直接读三个源文件
比对集合，任何一侧改单边都会变红——不靠注释约定。

**② 真链路能出计划这件事，此前没有任何测试证明。**
`bridge.test.js` 只证明了「缺 public 会被拒」；`toolbox-roco.test.js` 用的是假客户端。
两边都绿而真实链路对不上是完全可能的（T02 阶段就是这样：桥发 state、服务要 public）。
新增 `tests/evals/roco/plan-e2e.test.js`：

- 公开 planner state 由 **Python 引擎现场生成**
  （`scripts/roco/gen-plan-state.py`），不是测试里手抄的 fixture ——
  手抄的 fixture 会随引擎改动悄悄过期；
- 端到端：`toolbox → roco-client → HTTP → 真 Python 服务` 确实产出了计划
  （`planAvailable=true`、`search.completed=true`、推荐非空、有最坏尾部区间）；
- 反证：私有 `serialize()` 两层都被拒（客户端本地 + 绕过守卫的 raw POST）；
- 反证：`state.seed` / `state.foo.seed` / `state.history[0].seed` /
  对手待执行动作 / `rng_seed` 别名在客户端就拦下，用**记账 HTTP 端点**证明
  请求数为 0，并配一条「干净状态确实发得出请求」的对照组
  （没有对照组的话，「0 个请求」也可能只是端点根本打不通）；
- 反证：两个不同真实内部 seed（7 / 12345）的公开面逐字节一致、规划结论一致，
  且桥实际发出的请求体里连真实 seed 的**取值**都不出现；
  再加一条「真实 seed 恰好等于某个 analysis seed 时结论不变」。

同时把 `toolbox-roco.test.js` 里那条断言「已删除的补发兜底」的过时测试，
换成断言**直连契约**：一次调用、桥独占 `public` 键、私有传输层
（`_request` / `_payload`）不可达。

### 已知未完成（如实记录）

- **G02（阵容模型）**：**做了，但没过自己的门槛** → `evaluate_team` 继续用规则评分，
  模型不接入玩家可见的结论。见 `reports/roco/g02-team/G02-MODEL-2026-09-21.md`：
  log loss 0.6704 vs 规则分 0.6808 ✓、Brier 0.2392 vs 0.2438 ✓、**ECE 0.1098 ✗**
  （且 AUC 0.59 接近随机）。根因是家族空间被 A 组 6 只卡在 360，
  下一步是扩阵容池（6→12 只，家族空间 ×11），不是换模型。
- `summarize_battle` 仍无服务端点，返回结构化 `not_implemented`（**现在回 501**，
  不再混进 404），**不编摘要**。
- microcase 的「12/12 通过」仍**做不到**：需要游戏内实测。
- **`npm run test:smoke` 不自举**：它要求 8765 上已有服务，否则退出码 2。
  M0/M1 遗留的冒烟脚本，属于独立工作量（未改）。
- 录屏（F03 里那一项）**需要人来做**：脚本已备好（`docs/roco/mvp/DEMO-SCRIPT.md`，
  2 分 30 秒，逐段写清「点什么、屏幕上出现什么、说哪句」）。

### W3-01（扩域）与监工复核（本轮）

**已做的**：12 只精灵全部接入特性系统（FULL 6 / PARTIAL 2 / REFUSED 4），
B/C 组 3v3 实战跑通；`parse` 覆盖率语义修正；G02 判定为不过门槛。

**监工复核后必须分清的两类问题**（这一区分写进代码注释、测试名与断点文件）：

| 类别 | 内容 | 状态 |
|---|---|---|
| **程序接线 / 生命周期 bug**（已证实，可用引擎不变量断言） | buff 写入后伤害入口硬编码 1.0；`_defense_reduction` 跨回合残留；`replay` 丢 `loadouts`；`reset` 只按我方校验配招 | **已修**，每一条都有会变红的测试 |
| **真实手游语义**（未证实，无一手来源） | `+100%` 是否恰为 ×2；攻防增减相加还是相乘；减伤比例与结算时机 | **仍是假设**，属 `COMMUNITY_HYPOTHESIS_V1`（MC-010/011/020），事件带 `formula_verified: false` |

折算逻辑收敛到唯一一处 `roco_env/effects.py::buff_damage_multiplier`，
面板值一律用未加成原始面板（两边同时乘会把增益精确抵消——这条有反例测试）。
测试分两组：**强断言**只用于程序不变量（零 buff 基线不变、单调、只生效一次、
下一回合清零、replay 两次一致、缺配招回放抛错）；
**与社区模型对齐**的那条在名字里写明它验证的是「模型被正确实现」，
不是「手游就是这么算的」。

### F01 / F02 / F03 交付（本轮完成）

| 任务 | 交付 | 证据 |
|---|---|---|
| **F01 无聊天入口演示** | `/roco.html`（无聊天框；主动短提示、阵容变化重判、局末一个教学入口、陪练先接情绪） | `npm run roco:demo-acceptance` → **16/16**，6 张截图；`tests/roco-experience.test.js` 9 项 |
| **F02 全链路回归** | 人读报告 + JSON + 18 份原始日志 | `reports/roco/regression/F02-REGRESSION-2026-09-21.md`（含协调者补记） |
| **F03 MVP 材料** | 架构图 / 数据卡 / 规则覆盖表 / 实现状态标签 / 录屏脚本 | `docs/roco/mvp/`（5 份，每节标了证据来源） |

F02 报的四条问题，三条已修（能力表说假话、`NOT_IMPLEMENTED` 空字典导致 501 不可达、
补位局面的规划实际上从未算过），一条留作已知问题（test:smoke 不自举）。

## 2. 当前 HEAD 与工作区

| 项 | 值 |
|---|---|
| 仓库 | `/Users/serendizc/Developer/roco-coach` |
| 分支 | `master` |
| **HEAD（本轮开始时）** | `1717cd515e8d900e6f2ccccb8707a0a85a809989` |
| 交接包记录的基线 commit | `1717cd5` —— **一致**，无差异需要说明 |
| 开始时工作区 | **干净**（`git status --porcelain` 为空，0 条未提交修改） |
| 用户未提交修改 | 无。因此本轮不涉及「保护用户改动」的冲突场景 |

基线证据：`reports/roco/m0-baseline/HEAD.txt`、`reports/roco/m0-baseline/git-status.txt`。

**环境**（完整见 `reports/roco/m0-baseline/env.txt`）：

| 项 | 值 |
|---|---|
| Node | `v24.20.0` |
| npm | `11.19.0` |
| 系统 python3 | `3.9.6` |
| 仓库 `.venv-agent` python | `3.9.6` |
| OS | `Darwin 27.0.0 arm64`（Apple Silicon） |

---

## 3. 已完成事项及证据

| # | 事项 | 证据 |
|---|---|---|
| 1 | 读完交接包全部 8 份材料 + 仓库 README / IMPLEMENTATION-STATUS | 见本文件第 5 节「已读材料」 |
| 2 | 核对 Git HEAD、分支、工作区状态 | `reports/roco/m0-baseline/HEAD.txt`、`git-status.txt` |
| 3 | 记录 Node / npm / Python / OS 版本 | `reports/roco/m0-baseline/env.txt` |
| 4 | **全量基线测试通过 375/375** | `reports/roco/m0-baseline/npm-test.log`（详见第 6 节） |
| 5 | 下载并固定 3 份上游快照 revision + SHA256 | `data/roco/raw/*.tar.gz`、`reports/roco/m1-data/raw-sha256.txt` |
| 6 | 逐文件 SHA256 清单（603 文件 / 205.9 MB） | `reports/roco/m1-data/snapshot-file-inventory.json` |
| 7 | 许可状态台账 | `data/roco/sources.yaml` |
| 8 | 安全 Lua 文本解析器（**不执行**第三方 Lua），13/13 数据文件解析通过 | `scripts/roco/lua-safe-parse.mjs`、`scripts/roco/selftest-lua-parse.mjs` |
| 9 | normalized 数据：622 精灵 / 824 技能 / 312 学习表 / 120 属性组合 / 54 术语 | `data/roco/normalized/roco-world-s4-2026-09-10/` |
| 10 | 12/12 目标精灵解析成功，**孤儿技能引用 = 0** | `import-report.json` |
| 11 | 三来源交叉核验：24 处差异**全部**有解释，未解决冲突 = 0 | `data/roco/conflicts.jsonl`、`reports/roco/m1-data/cross-check.json` |
| 12 | 建立断点状态文件 | 本文件 |
| 13 | 页面/性能基线：`npm run test:smoke` 全部通过（14 张卡、属性筛选、进对局、16 次出招、无卡死、控制台零报错） | `reports/roco/m0-baseline/smoke.log` |
| 14 | 离线 eval 基线：`eval:retrieval`、`eval:balance:quick` 退出码 0 | `reports/roco/m0-baseline/evals.log` |
| 15 | **M0 仓库审计完成**（逐模块 KEEP/ADAPT/RETIRE/MISSING，含 5 条文档与运行态不一致） | `docs/roco/M0-REPO-AUDIT.md` |
| 16 | **许可矩阵完成**：3 个来源的许可、再分发等级、署名要求、禁用场景 | `docs/roco/LICENSE-MATRIX.md` |
| 17 | **冲突记录完成**：25 处差异全部分类，**未解决 = 0** | `docs/roco/DATA-CONFLICTS.md`、`data/roco/conflicts.jsonl` |
| 18 | **12 只精灵支持矩阵完成**，含当前支持等级与下一轮目标等级 | `docs/roco/PET-SUPPORT-MATRIX.md`、`.../support-matrix.json` |
| 19 | **A 组 6 只候选配招**：每只 4 技能，含角色、候选数、来源池与备选清单 | 同上 `candidate_moveset.selection_evidence` |
| 20 | **microcase 计划完成**：21 条，覆盖任务书要求的全部 11 个方向 + 应对/蓄力 2 组 | `tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md` |
| 21 | 通知通道接通（PushPlus），阶段完成自动推送 | `scripts/roco/notify.mjs`、`reports/roco/notify-log.jsonl`（均已忽略入库） |

### 3.2 本轮的关键数据结论（每条都有落盘证据）

| 结论 | 证据 |
|---|---|
| 主快照 `terms.json` 含 **54 条机制文本定义**，是本轮能区分「文本说了什么」与「没说什么」的依据 | `data/roco/normalized/.../terms.json` |
| 12 只精灵全部解析成功，**孤儿技能引用 = 0** | `.../import-report.json` |
| 跨来源 25 处差异**全部有解释**，其中 13 处是**版本重平衡**（由主快照自带的 S1—S4 改动记录解释） | `data/roco/conflicts.jsonl` |
| 4 只精灵（黑猫巫师/圆号鱼/音速犬/画间沉铁兽）在 2026-05→09 之间被改过数值；若直接采用旧快照会得到**过时的种族值** | `.../history.json`、`docs/roco/DATA-CONFLICTS.md` §4.1 |
| 化蝶有 **4 个同名形态**，目标形态由 `title`「化蝶（平常的样子）」唯一确定为 `pet_000124` | `docs/roco/DATA-CONFLICTS.md` §5 |
| C 组 3 只是 S4 新精灵（2026-09-10 发布），**不在**任何历史阵容快照里，**单一来源无交叉核验** | `docs/roco/PET-SUPPORT-MATRIX.md` §1 |
| 全部 12 只当前支持等级 = `KNOWLEDGE_ONLY`（未实现任何效果原语，未通过任何 microcase） | `.../support-matrix.json` |

### 3.1 本轮发现并必须留痕的副作用

| 现象 | 原因 | 处理 |
|---|---|---|
| `reports/balance.json`、`reports/retrieval.json` 被改写 | 运行 `npm run eval:balance:quick` 与 `eval:retrieval` 时，脚本按设计把结果**原地写回**这两个**已入库**文件 | 这是既有行为，不是我手改。原始内容仍在 git 中（`git diff` 可回退）。**未删除、未 reset、未覆盖其他改动** |
| `reports/roco/m0-baseline/server.log` 内容为「端口被占用」 | 8765 上**已有**一个先前启动的服务在跑（`runtimeVersion 0.11 / configured true`），我方重复启动被拒 | 直接复用现有服务做页面验收，**不重启、不读取钥匙串**。日志中无任何密钥材料（已 grep 核验，0 命中） |
| `NRC_AI.tar.gz`（172MB）不随仓库分发 | 大文件进 git 会永久留在历史中 | `.gitignore` 已忽略；由「固定 revision + 归档 SHA256 + 逐文件 SHA256 + 交叉核验结果」四级保证复现。入库总量因此为 **8.7MB / 60 个文件** |

### 3.2 仓库文档与现状的差异（必须记录，不得静默取一边）

| 文档说法 | 现场核对结果 | 处理 |
|---|---|---|
| `docs/IMPLEMENTATION-STATUS.md` 顶部写「现场 `npm test` 为 **257 项**」 | 本轮开始时现场为 **375 项**（357 unit + 18 browser），全通过；本轮结束后为 **390 项** | 文档数字过时。以现场日志为准，**本文件不改该文档**（属 M0 审计发现，已登记在 `M0-REPO-AUDIT.md` §1） |
| `README.md` 称 14 宠 | 代码/测试中确认 14 只自创宠物（含磐耳羊、灵瞳猫） | 一致 |
| 交接包称基线 commit `1717cd5` | HEAD = `1717cd5…` | 一致 |
| `03-IMPLEMENTATION-BRIEF.md` §2 称数据写在 `src/game/engine.js` / `src/game/content.js` / `src/game/progression.js` 等 | 已核对文件确实存在且非空（见 M0 审计） | 一致 |
| `README.md` 称「没有第三方 npm 运行依赖」 | `dependencies` 与 `devDependencies` **均为空对象** | 一致，且是重要优势；本轮未引入任何 npm 依赖 |

---

## 4. 状态：本轮已完成 / 下一步 / 阻塞

### ✅ 本轮（M0 + M1）状态：**已全部完成，等待人工审阅**

逐项验收结果见 `docs/roco/M0-M1-ACCEPTANCE.md`（A—L 共 12 节，每项带证据）。
**7 项有明确证据的未完成项**（§J）全部属于「需要游戏内实测或官方资料才能确定」的机制，
本轮**没有**用默认值补齐，而是转成了 21 条 microcase 与 74 个未解问题。

### 最终验证结果（本轮结束时）

| 项 | 结果 | 日志 |
|---|---|---|
| 全量回归 | **390/390 通过**（372 unit + 18 browser），0 失败 / 0 跳过 | `reports/roco/m1-data/npm-test-final.log` |
| 数据域验收 | **15/15 通过** | `reports/roco/m1-data/`（`npm run test:roco`） |
| 浏览器验收 | **9/9 通过**，4 张互不相同的截图 | `reports/roco/acceptance/browser-acceptance.json` |
| Lua 安全解析 | **13/13 文件解析成功**，无执行 | `reports/roco/m1-data/lua-parse-selftest.log` |
| 数据管线可整体重跑 | 通过 | `reports/roco/m1-data/{cross-check,import}.log` |

### 下一步（M2，需人工审阅后再启动）

1. 按 `docs/roco/MICROCASE-PLAN.md` §6 的顺序实现 `roco_env`：
   `MC-001→004`（先手度与排序键）→ `MC-003`（joint-step）→ `MC-013`（隐藏信息）→ `MC-005→007`（换宠/补位/能量）→ `MC-020→021`（应对/蓄力）→ `MC-008→012`（状态/印记/取整/事件序）→ `MC-010`（动态威力）→ `MC-014→019`（A 组特性）。
2. **每一步必须 fail closed**：未核验机制返回 `unsupported_effect`，禁止退化成自创默认值。
3. A 组 6 只所选 4 技能的效果原语通过 microcase 后，才可从 `KNOWLEDGE_ONLY` 升到 `SIM_PARTIAL`。

### 阻塞与未知

- **无硬阻塞**：M0/M1 范围内可验证的项目已全部完成。
- **7 项机制性未完成**（详见 `M0-M1-ACCEPTANCE.md` §J）：官方伤害公式、等级→面板换算、
  同速裁决、能量上限与回能时机、印记替换规则、百分比取整方向、A 组 6 只特性结算细节。
  它们**只能**通过游戏内实测或官方资料解决；本轮已转成 microcase，**未补默认值**。
- **本轮范围外**（未被要求、也未做）：阵容模型、planner、SFT、RL、云 GPU。

---

## 5. 已读材料（本轮）

交接包（只读副本在 `~/.dsh/attachments/v1/files/`，原始路径 `~/Codex/Internship/roco-coach-dsh-handoff-2026-09-21/`）：
`00-START-HERE.md`、`01-COLD-START-CONTEXT.md`、`02-DSH-MASTER-PROMPT.md`、`03-IMPLEMENTATION-BRIEF.md`、
`04-DSH-PLUGIN-DECISION.md`、`05-MODEL-GROUP-AND-TASK-MATRIX.md`、`06-INTEGRATED-BUILD-ROADMAP.md`、
`07-FINAL-DECISION-AND-EXECUTION-PLAN.md`。
仓库：`README.md`、`docs/IMPLEMENTATION-STATUS.md`、`docs/CHECKLIST.md`、`package.json`。
（仓库内**不存在** `AGENTS.md`，已用 glob 全仓确认。）

---

## 6. 最近一次验证命令与结果

### 6.1 M0/M1 基线（保留原样，不要覆盖——它是「开始时的样子」）

| 项 | 值 |
|---|---|
| 命令 | `npm test` |
| 等价于 | `npm run test:unit && npm run test:browser` |
| 运行时间 | 2026-09-20T16:14Z（UTC） |
| 结果 | **357/357 unit 通过，18/18 browser 通过，合计 375/375 通过，0 fail / 0 cancelled / 0 skipped / 0 todo** |
| unit 耗时 | 13 720 ms |
| browser 耗时 | 71 105 ms |
| 退出码 | `0` |
| **原始日志** | `reports/roco/m0-baseline/npm-test.log` |

> 注意：`npm test` 的 `test:browser` 部分会真实启动 Chrome 并驱动页面，因此
> 「浏览器验收」与「单元回归」在本仓库是**两件事**：前者证明页面可交互，
> 后者证明逻辑不变量。M0/M1 结束时两者都要有本轮日志。

### 6.2 第 1 轮 goal（MVP）收尾时的验证（追加，不覆盖 6.1）

| 项 | 值 |
|---|---|
| 命令 | `npm run test:unit` |
| 结果 | **410 / 410 通过**，0 fail / 0 skipped，13.8 s |
| 命令 | `npm run test:browser` |
| 结果 | **17 通过 / 1 按设计 skip**（skip 原因：20 步内对手 0 号位未倒下，场景前置不成立） |
| 命令 | `npm run test:env` |
| 结果 | **111 / 111 通过**（引擎 + 先导 + 公开 schema 隐私），1.0 s |
| 命令 | `npm run test:bridge` |
| 结果 | **11 / 11 通过**，3.6 s |
| 命令 | `npm run test:toolbox-roco` |
| 结果 | **17 / 17 通过**，0.05 s |
| 命令 | `npm run test:plan-e2e` |
| 结果 | **6 / 6 通过**，1.5 s（真 Python 服务，包含本文件 1.6 节所述的隐藏信息反证） |
| 命令 | `npm run test:roco-all` |
| 结果 | 上述四项服务侧套件一次跑完：**145 / 145 通过** |

运行时间 2026-09-21（本地）。这些是**逻辑与契约**证据；「页面真的能用」仍以
`npm run roco:acceptance` 的浏览器证据为准，两者不可互相替代。

---

## 7. 变更记录（每次完成一个可验收步骤就追加一行）

| 时间（UTC） | 动作 | 证据 |
|---|---|---|
| 2026-09-20T16:14Z | 建立本状态文件；记录 HEAD / 环境 / 基线测试 | `reports/roco/m0-baseline/` |
| 2026-09-20T16:16Z | 三份上游快照按固定 revision 冻结 + SHA256 + 逐文件清单 | `data/roco/raw/*.tar.gz`、`reports/roco/m1-data/` |
| 2026-09-20T16:20Z | 安全 Lua 文本解析器（不执行第三方代码），13/13 文件通过 | `scripts/roco/lua-safe-parse.mjs` |
| 2026-09-20T16:25Z | 三来源交叉核验：26 处冲突全部分类，未解决 0 | `data/roco/conflicts.jsonl` |
| 2026-09-20T16:30Z | M0 仓库审计完成 | `docs/roco/M0-REPO-AUDIT.md` |
| 2026-09-20T16:33Z | 许可矩阵完成（主来源 CC BY-NC-SA 4.0，两个 REFERENCE_ONLY） | `docs/roco/LICENSE-MATRIX.md` |
| 2026-09-20T16:36Z | 12 只精灵支持矩阵 + A 组候选配招 + 冲突记录文档 | `docs/roco/{PET-SUPPORT-MATRIX,DATA-CONFLICTS}.md` |
| 2026-09-20T16:39Z | microcase 计划 21 条（覆盖 11 个方向 + 应对/蓄力 2 组） | `tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md` |
| 2026-09-20T16:41Z | 新增 15 项数据域验收测试并接入 `test:unit`（追加，不删旧测试） | `tests/evals/roco/data-acceptance.test.js` |
| 2026-09-20T16:42Z | 浏览器验收脚本 + 4 张互不相同截图，9/9 通过 | `reports/roco/acceptance/` |
| 2026-09-20T16:43Z | 全量回归 **390/390 通过**（372 unit + 18 browser），0 跳过 | `reports/roco/m1-data/npm-test-final.log` |
| 2026-09-20T16:43Z | M0/M1 验收 checklist 完成（A—L，每项带证据） | `docs/roco/M0-M1-ACCEPTANCE.md` |
| 2026-09-20T16:43Z | **本轮结束，等待人工审阅。未提交 git（保持工作区可见，便于审阅 diff）** | `git status --porcelain` |
| 2026-09-21 | 第 1 轮 goal（30 项 MVP）启动：隐私边界收紧（移除 `state.seed` 后门、`/battle/plan` 改用公开 schema、对手后备不再暴露血量） | `roco/tests/test_public_planner.py`、`tests/evals/roco/bridge.test.js` |
| 2026-09-21 | **补上二层隐藏信息边界缺口**：桥的 `HIDDEN_KEYS` 缺 `pendingenemy/pendingplayer/replacequeue`，私有 `serialize()` 能从第一层穿过 | commit `8e79a6f`；新增三条词汇表跨文件比对测试 |
| 2026-09-21 | **新增规划端到端测试**（真 Python 服务）：证明正确公开状态确实产出计划，并反证真实 seed 不影响结论 | `tests/evals/roco/plan-e2e.test.js`、`scripts/roco/gen-plan-state.py`、`npm run test:plan-e2e` |
| 2026-09-21 | **F01 无聊天入口演示页** `/roco.html` + 浏览器验收 16/16 | `src/client/roco.{html,js,css}`、`src/coach/roco-experience.js`、`scripts/roco/demo-acceptance.mjs` |
| 2026-09-21 | **F02 全链路回归**：604 项去重合计，0 失败；P50/P95 实测 | `reports/roco/regression/`（含 18 份原始日志） |
| 2026-09-21 | **F03 MVP 材料**：架构图 / 数据卡 / 规则覆盖表 / 状态标签 / 录屏脚本 | `docs/roco/mvp/` |
| 2026-09-21 | 按 F02 的四条发现修掉三条（能力表、501 不可达、补位规划从未算过） | commit `44b4e92`；`roco/tests/test_sim_endpoints.py` |
| 2026-09-21 | **G02 阵容模型：不过门槛**，`evaluate_team` 继续用规则评分 | `reports/roco/g02-team/G02-MODEL-2026-09-21.md` |
| 2026-09-21 | **属性增减真的进伤害了**（此前入口硬编码 1.0）、防御减伤不再跨回合残留 | commit `35d7120`；`TestBuffDamageWiring` |
| 2026-09-21 | **W3-01：12 只精灵全部接入特性**（FULL 6 / PARTIAL 2 / REFUSED 4） | commit `2231191`；`roco/src/roco_env/traits.py` |
| 2026-09-21 | 监工复核后：折算收敛到唯一函数、语义标注为假设、测试改按不变量写 | commit `9085af2`；`TestReplayCarriesLoadouts` |
