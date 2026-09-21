# 跨机器协作区（Mac DSH ↔ Windows DSH）

> 建立于 2026-09-21（用户指令）。**本文件只是记录与协议摘要**；权威内容在协作仓。
> 记录时（Mac 侧）产品 HEAD：`b183b32`。

## 1. 协作区在哪

| 项 | 值 |
|---|---|
| 控制仓 | `https://github.com/SeRendizc/ai-dev-platform` |
| 长期分支 | `coord/roco-coach`（不要 force-push） |
| 目录 | `projects/roco-coach/` |
| 产品仓（不变） | `https://github.com/SeRendizc/roco-coach` |

目录里的文件与归属（README 原文口径）：

| 文件 | 归属 | 用途 |
|---|---|---|
| `MAC_STATUS.md` | **Mac DSH（我）** | 产品、规则、模拟器与数据集就绪度 |
| `WIN_STATUS.md` | Windows DSH | WSL/CUDA、训练、评测与导出状态 |
| `CONTRACTS.md` | **Mac DSH（我）** | 版本化数据集与在线模型契约（**训练闸门**） |
| `BLOCKERS.md` | 双方（追加唯一 id） | 需要对方或用户解决的事 |
| `DECISIONS.md` | 双方（**只追加**） | 改变数据/模型/产品方向的决策 |

**归属纪律**：各自只改自己的状态文件；Mac 拥有 `CONTRACTS.md`（因为规则、标签与数据集生成归 Mac）；
双方都可以往 `BLOCKERS.md` / `DECISIONS.md` 追加；**永远不要重写对方的在办条目**；
产品代码仍然只在 `roco-coach`，协作区只存协作事实。

## 2. 分工（D-20260921-02，已接受）

- **Mac（我）**：产品主线、六精灵规则、600+ 精灵数据语义、模拟器、数据集生成器、Agent 工具协议、最终集成。
- **Windows**：CUDA 训练、评测、导出。**不得**在本地重定义标签或规则。
- `CONTRACTS.md` 是「产品变更」与「模型训练」之间的**正式闸门**：Windows 只有看到
  `status: ready` 且字段齐全才能消费某个产物。允许的状态：`missing` / `draft` / `ready` / `invalidated`。

## 3. 同步循环（每个工作阶段开始与结束各一次）

1. `git fetch origin coord/roco-coach`；
2. 读两边状态、契约、阻塞与决策；
3. **确认所需输入是 `ready`** 再去消费；
4. 在对应仓库干活；
5. 只更新本机拥有的文件；
6. 提交并推送协作分支；远端前进过就先 pull/rebase，**不 force-push**，
   无法在不覆盖对方报告的前提下解决冲突 → 停下问用户。

**大文件**：不要把权重、原始数据集、运行目录、虚拟环境、密钥放进协作区。改为登记：
产物名与用途、生产它的 commit、ruleset/schema 版本、字节数、SHA-256、存放位置或可复现的生成命令、评测报告路径。

**何时必须找用户**：规则决策没有证据支撑；Git 冲突会丢掉对方的工作；需要登录/token/付费/大文件托管；
新结果实质改变已约定的项目范围。

## 4. 当前契约状态（记录时；权威值看协作区 `CONTRACTS.md`）

| 契约 | 状态 | 说明 |
|---|---|---|
| `BattleModeV2` | **draft** | `data/roco/battle-modes.json` 已有 5 个模式（含标准 PVP 六宠 `CANDIDATE`/`CROSS_SOURCE_SUPPORTED`、极速对决 3v3·2 魔力 `OFFICIAL_CURRENT`），有 schema 与 invariants 测试；**缺实机 microcase**，故不是 `ready` |
| `GameDataPackV2` | **draft** | L1 622 + 技能 824 + 48 只迁移层 + 证据台账 + 失效图都在；**统一 GameDataPack 与 621/579/242 对账（RC-201/202）未做** |
| `TeamFeatureV2` | **missing** | 未开工（RC-302/303）；未知对手口径已定（`UNKNOWN_PREMATCH`） |
| `MetaPriorV1` | **missing** | 未开工；版本范围与来源分级待定 |
| `TeamDatasetV2` | **missing** | 旧 team 数据集是**小池 + 对手已知**时代产物 → 失效 |
| `CompletionDatasetV1` | **missing** | 未开工（含 2/3/4/5 只部分队伍标签） |
| `OnlineTeamScoringV1` | **missing** | 3 秒 Serving（RC-306）未开工；`latency_budget_ms: 3000` 已定 |

**正式训练闸门（原文）**：`BattleModeV2`、`TeamFeatureV2`、对应数据集、以及它的切分与泄漏检查**全部 `ready`** 之前，
Windows 不得开始正式训练。

## 5. Mac 侧已交付的可核对事实（写入 `MAC_STATUS.md` 的口径）

- 产品 HEAD `b183b32`；门禁 `node scripts/roco/verify-release.mjs` **14/14 verdict=pass**；
  `test:env` 275、`test:unit` 715、`demo-acceptance` **119 通过 / 0 失败**。
- **v3 纠偏生效**：标准 PVP 按**六宠**设计（候选规则，禁止冒充官方）；官方「极速对决」3v3/2 魔力是
  **独立 BattleMode**；48 只只是**迁移夹具**；候选宇宙是全量 600+；匹配前对手未知按版本 Meta prior；
  **在线 3 秒内禁止批量模拟**。
- **规则证据台账**：20 条（`OFFICIAL_CURRENT` 3 / `COMMUNITY_CURRENT` 7 / `CROSS_SOURCE_SUPPORTED` 7 /
  `ENGINE_HYPOTHESIS` 3 / **`RECORDED_IN_GAME` 0**），**14 条**待实机 microcase。
- **RC-101 版本化规则配置**：`legacy-sim-v1`（默认，逐位不变）+ `mobile-s4-candidate-v2`
  （上限 10 / 聚能 +5 / **入场能量 UNKNOWN**）；能量字面量只许住在配置里（结构判据 0 违规）。
- **旧数据失效**：失效图登记 20 条产物 × 17 个规则主题，其中 **13 条绑定旧规则 → 禁止重跑**
  （两条轨迹臂、模型错误轨迹、SFT 数据、team model、介入窗口、判定层生成物、planner 基准、
  局面夹具、浏览器矩阵、支持矩阵与 48 只文档）。
- **缺的**：一条实机录制都没有（`MC-E01..E04`、`MC-E08` 最高优先；`MC-BM01..04`）。

## 6. 我这边要怎么用这个协作区（写给下一个接手的人）

1. **阶段开始与结束各同步一次**：先 `fetch` + 读 5 个文件，再决定能不能消费 Windows 的产物；
   结束时**只改** `MAC_STATUS.md`（和 `CONTRACTS.md`）并推送。
2. **契约不许提前标 `ready`**：README 与用户指令都写明「只有在代码、测试、schema、标签定义、
   数据切分与泄漏检查都有证据时」才能标 `ready`。含糊地标 `ready` 会让 Windows 开始一次
   错误的训练 —— 那比不训练更贵。
3. **需要 Windows 处理的事**追加到 `BLOCKERS.md`（唯一 id、owner、severity、status、evidence、requested_action）。
4. **方向性改变**追加到 `DECISIONS.md`（只追加，不修改）。
5. **不进 Git 的东西**：权重、原始数据、运行目录、虚拟环境、密钥；只登记指纹与生成命令。

## 7. 记录时（`B-20260921-02`）Mac 侧尚未满足的闸门

`B-20260921-02`（mac 开、P0）：新契约未就绪。当前真实状态是
**`BattleModeV2`/`GameDataPackV2` 为 `draft`，其余为 `missing`** ——
与「v3 纠偏刚做完规则与候选宇宙的定义、还没有统一数据包与阵容特征」的进度一致。

## 8. 同步记录（append-only）

| 时间（UTC） | 方向 | 协作区 commit | 我改了什么 |
|---|---|---|---|
| 2026-09-21T14:22Z | Mac → 协作区 | `5c70bcd`（`f839dcf..5c70bcd`） | `MAC_STATUS.md` 首份（产品 HEAD `b183b32`、v3 纠偏、台账/失效图/RC-101、产物指纹表、缺实机录制）；`CONTRACTS.md` 如实标注（BattleModeV2/GameDataPackV2 = `draft`，其余 `missing`，TeamDatasetV2 = `invalidated`，**训练闸门 blocked**）；`BLOCKERS.md` 追加 `B-20260921-03`（缺实机录制 → 候选规则不得 promotion）与 `B-20260921-04`（Windows 不得消费 draft/invalidated）；`DECISIONS.md` 追加 `D-20260921-03`（六宠标准模式 / 对手未知 / 600+ 候选 / 在线禁批量模拟） |

**没做的事（诚实记录）**：本次**没有**把任何契约标成 `ready`（证据不足）；
没有改 `WIN_STATUS.md`（不属于我）；没有在产品仓里为协作改动任何产品代码。
