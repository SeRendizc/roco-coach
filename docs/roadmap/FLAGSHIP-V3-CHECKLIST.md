# 旗舰 v3 checklist（RC 台账）

> 单一事实源：`08-IMPLEMENTATION-ROADMAP.md`（施工顺序）+ `09-CODING-AGENT-MASTER-PROMPT.md`（总合同）。
> 本文件只记**状态与证据**，不重复路线图里的验收标准。一次只做一个 RC。
> 每个 RC 的完成定义：代码 + 自动测试 + **负向验证（必红反证）** + 机器可读产物（+ 涉及 UI 时的浏览器证据）+ known limits。
> 更新纪律：改了状态就必须同时写证据路径；没有证据的项一律停在 `IN_PROGRESS`。

状态图例：`DONE`（有判据+反证+产物）/ `IN_PROGRESS` / `NOT_STARTED` / `BLOCKED`（外部依赖）/ `DEFERRED`（用户明确延后）

## Phase 0A：冻结基线与事实迁移框架

| RC | 内容 | 状态 | 证据 / 备注 |
|---|---|---|---|
| RC-000 | 当前 master 基线审计 | **DONE** | `scripts/roco/flagship-baseline.mjs`、`reports/roco/flagship-upgrade/baseline.json`（6/6 自检） |
| RC-101 | 版本化规则配置（`legacy_sim_v1` / `mobile_s4_candidate_v2`） | NOT_STARTED | 目标：JS/Python/UI 都不再各写一份常量 |
| RC-102 | 能量证据与 microcase（candidate 只能进 candidate） | NOT_STARTED | 依赖 evidence ledger 的 `energy.*` 条目 |
| RC-103 | 回合顺序与回合末登记表 | NOT_STARTED | 未知顺序 fail closed |
| RC-104 | 规则 → 产物失效图 | **DONE** | `data/roco/artifact-registry.json`、`scripts/roco/artifact-invalidation.mjs`、`reports/roco/flagship-upgrade/artifact-invalidation.json`（6/6 自检，13 条禁止重跑） |
| — | 规则证据台账（evidence ledger，贯穿所有 RC） | **DONE** | `data/roco/evidence/rule-evidence-ledger.json`（20 条：OFFICIAL 3 / COMMUNITY 7 / CROSS_SOURCE 7 / HYPOTHESIS 3 / RECORDED **0**）、`data/roco/evidence/rule-evidence-microcase-records.json`（14 条待录 MC-E**）、`scripts/roco/verify-evidence-ledger.mjs`（12 条自检）、`tests/roco-evidence-ledger.test.js`（17 条）、`docs/roco/RULE-EVIDENCE-LEDGER.md`；含一处对升级包来源指向的**证伪**（见 REDIRECT §7） |
| — | BattleMode 参数化登记 | **DONE**（登记）/ 待接代码 | `data/roco/battle-modes.json`（RC-101 消费它） |
| — | 六槽 UI 与 3 秒 Serving 拆分 | **DONE**（拆分文档） | `docs/roadmap/FLAGSHIP-V3-REDIRECT.md` §5 |

**P0A 验收**：双规则并存；旧 replay 可重放；candidate 差异报告可复现；未验证规则没有被静默 promotion。

## Phase 0B：全量数据包、RAG 与 OwnedPet

| RC | 内容 | 状态 |
|---|---|---|
| RC-201 | 公网 621/579/242 与仓库 622/824 的对账（不删记录凑数） | NOT_STARTED |
| RC-202 | 统一 GameDataPack（catalog/skills/traits/learnsets/…/battle_modes/source manifest） | NOT_STARTED |
| RC-203 | OwnedPet / BattleBuild（同种多实例、有序四技能、锁定、约 80 个 Demo 个体） | NOT_STARTED |
| RC-204 | RAG 索引与 held-out 评测（Recall@K / MRR / 版本命中 / grounding / 冲突弃答） | NOT_STARTED |
| RC-205 | 精灵盒子 UI（我的/全图鉴、搜索、个体比较） | NOT_STARTED |

## Phase 0C：阵容工坊与 Agent 约束理解

| RC | 内容 | 状态 |
|---|---|---|
| RC-301 | RecommendationRequest 合同（六宠、锁定、must include/exclude、`UNKNOWN_PREMATCH`） | NOT_STARTED |
| RC-302 | 缺口诊断（coverage/speed/energy/respond/pivot/synergy/cost，每条带证据与置信） | NOT_STARTED |
| RC-303 | 候选生成（全量 600+ → 召回 20～50 → Beam 补全六宠 → Completion Value / Ranker） | NOT_STARTED |
| RC-304 | 未知对手下的队伍比较（环境价值 / 最差体系 / 容错 / 覆盖置信） | NOT_STARTED |
| RC-305 | 阵容工坊 UI 与工具合同（`query_owned_roster` / `evaluate_team` / `compare_change`…） | NOT_STARTED |
| RC-306 | 3 秒 Serving 合同（300ms 初判 / 3s 解释 / 分段延迟 / 超时保短结论） | NOT_STARTED |

**P0C 验收**：六宠队伍；600+ 可检索；选 2～5 只时推荐会变；偏好真的改变候选；硬约束零违反；P95 < 3s；页面先诊断后推荐。

## Phase 1A：Capability Compiler 与代表性 Simulator

| RC | 内容 | 状态 |
|---|---|---|
| RC-401 | Effect/Trigger IR 增量迁移（按覆盖收益，不一次重写 68 个原语） | NOT_STARTED |
| RC-402 | 按需 Build Compiler（48 只只是夹具；第 49/301 只复用原语即可进入模拟层） | NOT_STARTED |
| RC-403 | Support Classifier v2（FULL_VERIFIED / SIMULATABLE_UNVERIFIED / PARTIAL / KNOWLEDGE_ONLY / REFUSED） | NOT_STARTED |
| RC-404 | 代表性回归集（18 属性 + 角色 + 速度 + 资源 + 换入离场 + 应对 + 印记 + 天气 + 迅捷 + 传动） | NOT_STARTED |

## Phase 1B：战斗 UX 与 Coach 主链路（**KEEP + revalidate，不许重写**）

| RC | 内容 | 状态 |
|---|---|---|
| RC-501 | 保留并重新验证既有产品资产（多动作比较/未来后果/stale-plan 丢弃/PVP 门控/RAG 证据/mock host） | IN_PROGRESS（规则 candidate 落定后逐项 revalidate） |
| RC-502 | 战斗信息架构（HP、能量/上限、魔力、可见状态、印记、天气、公开后备、四技能） | NOT_STARTED |
| RC-503 | Coach 比较与后果（两个合法动作 + 下一回合机会 + 最大下行 + 规则置信；不展示伪精确胜率） | 已具备（KEEP）/ 待接候选规则 |
| RC-504 | 三角色产品闭环（军师/陪练/老师）+ **真人盲评** | 已具备（KEEP）；盲评 `BLOCKED`（需 3—5 人） |
| RC-505 | 移动端验收（390px 无横向溢出、触控目标、短提示不遮挡） | 已具备（119 条浏览器判据）；六槽改造后需重跑 |

## Phase 1C：算法旗舰线

| RC | 内容 | 状态 |
|---|---|---|
| RC-601 | 规则绑定的轨迹重建（manifest 强制绑 ruleset/engine/data pack/opponent policy/split/sha256） | **BLOCKED**（规则 candidate 未定；且人类明令先不要用旧规则生成轨迹） |
| RC-602 | Team Pairwise Ranker + Partial-team Completion Value | NOT_STARTED |
| RC-603 | Learned Value（P1 必做；由用户在 RTX 3060 亲训） | **DEFERRED 给用户** |
| RC-604 | 对手信念基线（uniform / frequency / 规则策略混合） | NOT_STARTED |
| RC-605 | 工具使用 SFT 重建（含 owned pet compare / team gap / stale / 失败恢复） | **BLOCKED**（依赖 RC-601） |

## Phase 2：可选 RL

| RC | 内容 | 状态 |
|---|---|---|
| RC-701 | 战斗 BC / Policy Prior | NOT_STARTED |
| RC-702 | Self-play 与 RL（需独立 evaluator + reward 审计） | NOT_STARTED |
| RC-703 | Agentic RL（需 SFT 强基线 + 可独立判 reward） | NOT_STARTED |
| RC-704 | 介入学习（规则硬门控不动；3—5 人盲评通过后才能开 `on`） | **BLOCKED**（人在环） |

## Phase 3：旗舰交付

| RC | 内容 | 状态 |
|---|---|---|
| RC-801 | 五分钟 Demo（盒子 → 个体比较 → 锁定 → 补队 → 战斗 → 主动提示 → 展开取舍 → 局末教学） | NOT_STARTED |
| RC-802 | 开发者证据抽屉（默认隐藏 ruleset/support/latency/digest/evidence） | 已具备雏形（`#about-drawer`）；六槽改造后需 revalidate |
| RC-803 | 面试报告 | NOT_STARTED |

## 外部阻塞（不改代码能解决的只有这三件）

1. **一个 DeepSeek key** —— 云臂对照。
2. **3—5 个真人** —— W5-05 陪练盲评、RC-704 开 `on` 的前置。
3. **一次实机录制** —— 优先级最高的几个：**`MC-E08`（标准 PVP 的魔力/力竭，目前证据最弱）**、`MC-E01`（能量上限与聚能）、`MC-E07`（六只上限）、领地试炼 `MC-BM04`；完整清单见 `data/roco/evidence/rule-evidence-microcase-records.json`。

**用户明确延后**：RC-603 Learned Value 训练（用户亲训）、Qwen 27B 部署/微调。

## 最近更新

- 2026-09-21（v3 纠偏第一批）：RC-000、RC-104、BattleMode 登记、六槽 UI 与 3s Serving 拆分、长期 goal 更新。
