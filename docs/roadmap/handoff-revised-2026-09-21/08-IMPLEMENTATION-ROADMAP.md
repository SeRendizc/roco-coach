# Coding Agent 施工路线 v2：从当前 master 到旗舰 Agent

> 本版根据当前 HEAD 重排。原则：不重复已完成能力；全量知识与精确模拟分层；规则 candidate 未经实机证据不得 promotion；Agent、算法和产品闭环贯穿施工，而不是最后补一个聊天层。

## 0. 总完成定义

最终 5 分钟链路：

```text
全量图鉴/我的盒子
→ 比较同种不同个体
→ 锁定喜欢的精灵
→ 阵容缺口诊断与两个方案
→ capability compiler 判断当前 build 能否精确模拟
→ 完成一局同步决策对战
→ 小芽在关键窗口主动给短建议
→ 展开比较至少两个动作及 2–3 回合后果
→ 局末只抓一个可教点
→ 下一局核对是否改善
```

每项任务开始前必须写：Goal / current evidence / files / acceptance / negative test / migration impact。完成后写：Changed / tests / artifacts / known limits / next task。

## Phase 0A：冻结基线与事实迁移框架

### RC-000 Current Master Audit

记录 HEAD、dirty status、release guard、catalog/roster/model identity；不得把升级包里的旧差距当当前事实。

### RC-101 Versioned Rule Configuration

建立 `legacy_sim_v1` 与 `mobile_s4_candidate_v2`。energy cap、initial energy、natural regen、charge amount、turn order、end-turn order 全部来自单一版本化配置，JS/Python/UI 不重复常量。旧 replay 绑定 legacy ruleset。

### RC-102 Energy Evidence and Microcases

社区交叉支持的 `max=10 / 聚能+5` 只能进入 candidate。建立 microcases、来源登记和 migration impact；在官方文字或录制实机 case 之前不得标 `OFFICIAL_CURRENT/RECORDED_IN_GAME`。

### RC-103 Turn Order and End-turn Registry

分别覆盖 switch/respond/priority/speed/tie/swift/faint replacement，以及 DOT/trait/weather/energy/replacement。未知顺序 fail closed。

### RC-104 Artifact Dependency Graph

规则变化自动列出受影响 primitive、skills、traits、pets、fixtures、trajectories、team model、SFT 与截图。旧产物不得继续标 current。

**P0A 验收**：双规则并存；旧 replay 可重放；candidate 的差异报告可复现；未验证规则没有被静默 promotion。

## Phase 0B：全量数据包、RAG 与 OwnedPet

### RC-201 Live Catalog Reconciliation

保留现有 622 L1，新增当前公开 621/579/242 的版本化快照与许可记录。用实体对齐处理名称、形态和 record kind；生成 only-in-snapshot / only-in-live / changed / unresolved，不删记录凑数。

### RC-202 Unified GameDataPack

统一 catalog/skills/traits/learnsets/natures/specialties/bloodlines/battle_modes/source manifest。全量数据通过 schema、provenance、conflict 与 orphan reference 检查。

### RC-203 OwnedPet and BattleBuild

新增同物种多实例、等级、性格、资质、特长、血脉、四个有序技能、来源、收藏与锁定。固定 seed 生成约 80 个 Demo owned instances，含多组同种不同个体。

### RC-204 RAG Index and Evaluation

实体/别名 + 结构化过滤 + BM25 + 可选向量 + evidence/ruleset rerank。五类 held-out query；报告 Recall@K、MRR、实体与版本命中、grounded precision、conflict abstention。

### RC-205 Pet Box UI

我的/全图鉴、搜索、属性/角色/收藏/支持等级、个体详情、两个个体比较。玩家主区不显示原始工程字段。

**P0B 验收**：621/622 全部可查；80 个 owned 可持久化；同种个体可比较；检索指标和失败查询落盘。

## Phase 0C：阵容工坊与 Agent 约束理解

### RC-301 RecommendationRequest Contract

支持六宠队伍、must include/exclude、locked instances、max replacements、favorites、mode、`UNKNOWN_PREMATCH / VISIBLE_ROSTER_IN_BATTLE / KNOWN_SCENARIO`。LLM 只把自然语言转换成 schema，程序校验。标准 PVP 配队不得假设已知对手。

### RC-302 Gap Diagnosis

coverage/speed/energy/respond/pivot/synergy/cost，每个 gap 有机器证据与规则置信度。

### RC-303 Candidate Generation

以全量 600+ 为候选宇宙：hard filter → ANN/规则召回 20–50 → cheap features → Beam 补全六宠 → Completion Value / Team Ranker → Top-K。支持玩家选第 2～5 只时增量推荐下一只。禁止固定 60 宠候选池、全组合爆搜和 LLM 枚举。

### RC-304 Unknown-opponent Team Comparison

current / A / B 面向版本 Meta prior 输出 expected value、最差体系、matchup spread、容错、improves / worsens / assumptions / coverage。在线只读版本化 Ranker 和缓存，不批量 rollout。不能模拟的 build 保留静态诊断并给兼容配招或替代。

### RC-305 Team Workshop UI and Tools

完成 query_owned_roster、inspect/compare owned pets、evaluate team、compare change、apply candidate；覆盖锁定 0/1/3 只和允许换一只。

### RC-306 Three-second Serving Contract

300ms 内返回结构化初判，3 秒内完成自然语言解释；模型超时不影响初判。记录 retrieval/ranker/evidence/LLM 分段延迟。低置信或新机制进入异步验证，不阻塞页面。

**P0C 验收**：六宠队伍；600+ 候选可检索；选 2～5 只时推荐会变化；用户偏好真的改变候选；硬约束零违反；P95 小于 3 秒；页面先诊断后推荐。

## Phase 1A：按需 Capability Compiler 与代表性 Simulator

### RC-401 Effect/Trigger IR Incremental Migration

按覆盖收益迁移 primitive，不一次重写 68 个。Skill 与 Trait 共享 Trigger/Effect runtime。

### RC-402 On-demand Build Compiler

```text
selected OwnedPet + ordered build + battle mode
→ dependency collection
→ IR validation
→ support classification
→ versioned cache
```

当前 48 个 Demo build 只是迁移夹具。长期回归按机制 microcase、全量目录分层抽样和历史失败样本组织。任何全量精灵只要当前 build 依赖均满足就自动进入模拟层。

### RC-403 Support Classifier v2

输出 FULL_VERIFIED / SIMULATABLE_UNVERIFIED / PARTIAL / KNOWLEDGE_ONLY / REFUSED；携带 missing primitives、rules、evidence 和兼容 build。

### RC-404 Representative Regression Set

覆盖 18 属性、角色、速度、资源、换入/离场、应对、印记、天气、迅捷、传动等。每次从 600+ 按机制与置信层级分层抽样，叠加固定 microcase 与历史失败样本；验收 capability admission、cache invalidation、random replay 和真实 microcase。

**P1A 验收**：新增复用已支持原语的第 49/301 只精灵无需改引擎代码即可通过；注入未知 primitive 必须 fail closed。

## Phase 1B：战斗 UX 与 Coach 主链路

### RC-501 Preserve Current Product Assets

保留并重新验证已经完成的多动作比较、未来后果、stale-plan discard、PVP gate、RAG evidence、mock host、48 roster coverage。不得重复重写成更弱版本。

### RC-502 Battle Information Architecture

展示 HP、能量/上限、属性、可见状态、印记、天气、魔力、公开后备、四技能与消耗；工程信息进入开发者抽屉。

### RC-503 Coach Comparison and Consequences

至少两个合法动作；展示 next-turn opportunity、resource state、largest downside 与规则置信度，不展示伪精确胜率。

### RC-504 Three-role Product Loop

- 军师：战前/局中/局后工具闭环。
- 陪练：情绪、显式偏好、拒绝与静默、跨局记忆；做真人盲评。
- 老师：转折点、改法、下一局目标、后续局核对。

### RC-505 Mobile Acceptance

390px 无横向溢出、触控目标、短提示不遮挡关键动作、展开可读。

## Phase 1C：算法旗舰线

### RC-601 Rebuild Rules-bound Trajectories

新轨迹 manifest 强制绑定 ruleset、engine、data pack、opponent policy、split 和 sha256。

### RC-602 Team Pairwise Ranker

比较六宠 team A/B 面对版本化未知对手分布的表现；训练标签来自离线模拟、自博弈和有版本的阵容弱标签。评估 held-out pet families/archetypes/opponent policies；报告校准、regret、最差体系与失败分析。另训 partial-team Completion Value，支持选第 2～5 只时补下一只。

### RC-603 Learned Value（P1 必做）

用公开 observation/state tensor 预测 return/value，接入搜索叶节点。预注册并比较 random、heuristic、search、search+value；报告 held-out calibration、regret、paired win/loss 与消融。由用户在 RTX 3060 上亲手训练。

### RC-604 Opponent Belief Baseline

uniform legal / frequency / rule-policy mixture；再评估小型 learned model。搜索不能读取隐藏动作。

### RC-605 Tool-use SFT Rebuild

加入 owned pet compare、team gap、candidate compare、rule conflict、state stale、tool failure recovery。4B 为在线 router；27B 为离线 teacher/evaluator，二者都不替代 Value/Battle Policy。

## Phase 2：可选 RL

### RC-701 Battle BC / Policy Prior

从 search teacher、人工高质量轨迹或 self-play 强策略学习动作先验。

### RC-702 Self-play and RL

只有规则稳定、reward 审计、held-out opponent families 和独立 evaluator 到位后选择 PPO 或其他算法。先训练对手/战斗策略，不训练“小芽说话”。

### RC-703 Agentic RL

在 SFT 强 baseline、可独立判 reward、真实 recovery tasks 与 held-out families 下，优化工具策略。奖励含 task/constraint/evidence，惩罚 hallucination、illegal action、无意义调用和打扰；不能奖励“不查资料”。

### RC-704 Intervention Learning

规则硬门控保持；分类器先 shadow。只有 3～5 人盲评确认收益后才能开 on；随后才考虑 bandit/RL 个性化。

## Phase 3：旗舰交付

### RC-801 Five-minute Demo

盒子 → 个体比较 → 锁定 → 补队 → 战斗 → 主动提示 → 展开取舍 → 局末教学。

### RC-802 Developer Evidence Drawer

默认隐藏 ruleset/support/planner/state/model/latency/evidence/artifact identity。

### RC-803 Interview Report

Problem / differentiation / system / rule truth / Agent / RAG / search+value / training / evaluation / failures / ablations / product / limits。

## 优先级总表

| 优先级 | 范围 |
|---|---|
| P0 | RC-000～104、RC-201～205、RC-301～305 |
| P1 | RC-401～505、RC-601～605、RC-801/802 |
| P2 | RC-701～704、RC-803 |

## 何时停止扩宠

全量知识、OwnedPet、候选召回与静态阵容层默认覆盖 600+。精确模拟按 primitive/trigger/timing/evidence 扩展；如果任一 build 的依赖已支持，它自动进入，不等人工“加名单”。回归单位是机制和 build case，不是宠物名单。项目 KPI 是能力覆盖、校准、任务成功和真实体验，不是手写宠物数量。
