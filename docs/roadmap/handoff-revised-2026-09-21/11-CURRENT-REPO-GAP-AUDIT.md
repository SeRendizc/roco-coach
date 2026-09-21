# 当前仓库差距审计 v2：KEEP / REVALIDATE / FIX / ADD / DEFER

> 本版按 2026-09-21 当前 HEAD 重写。旧升级包把部分已完成功能列为 ADD，会造成重复施工。

## KEEP：不要重写

| 模块 | 当前价值 |
|---|---|
| `roco/src/roco_env` 合同 | joint-step / replay / observation 地基 |
| Node ↔ Python bridge 与 toolbox | 工具、错误、版本、证据通路 |
| `runtime.js` bounded tool loop | Agent 运行主干 |
| stale-plan discard | 已抓到真实竞态，必须保留 |
| PVP fairness gate | 公平边界 |
| 多动作比较与未来后果 | 当前已经实现，不再列 ADD |
| companion / teacher / memory | 已有闭环，后续做真人效果验证 |
| RAG evidence 透传 | 精灵/技能证据已到宿主可见层 |
| game adapter + mock host | 真实宿主可移植性基础 |
| local Qwen gateway + v4 adapter | 在线工具路由实验锚点 |
| release guard / browser acceptance | 项目最强工程资产之一 |
| provenance / conflicts / L1 catalog | 全量数据扩展基础 |

## REVALIDATE：能力已有，但基础规则变化后必须重跑

- 48 只回归集、行动合法性与战斗完成率；
- planner 多动作比较、风险和 2–3 回合后果；
- 12,000 局轨迹与 team evaluator；
- intervention windows/classifier；
- tool-use SFT task 中依赖能量/合法动作的部分；
- UI 中能量、聚能与高费技能文案；
- Demo 截图和性能报告。

REVALIDATE 不等于重写。产物 manifest 必须绑定规则版本；旧产物可保留为 legacy 基线。

## FIX：最高优先级

### G-001 规则版本化与能量 candidate

当前 max 6 / end-turn +1 / initial 2 是 ENGINE_HYPOTHESIS。社区多源支持 max 10 / 聚能 +5，但没有官方或项目实机 case 前只能进 candidate ruleset。

### G-002 规则变化的 artifact dependency

规则变化必须自动定位并 invalidate/rebuild trajectories、models、fixtures、thresholds 与截图。

### G-003 621/622、579/824 口径与许可

做实体/形态/record kind 对账；BWIKI 标 COMMUNITY_CURRENT；不把社区页面包装成官方真值，不在许可不清时随意再分发原始内容。

### G-004 特性数据与 SimulationSupport

导入文本与映射不代表可模拟。Trait 与 Skill 共享 Effect/Trigger IR；支持状态按 build+ruleset 动态编译。

### G-005 现有页面仍缺完整产品入口

现有对战 Demo 已可玩，但缺全量图鉴、OwnedPet、阵容工坊和统一导航；UI 迁移不得退化已有 Coach 能力。

## ADD：真正缺少

### A-001 Unified GameDataPack + Entity Reconciliation

全量 catalog/skill/trait/learnset/养成字段/来源；按版本差异更新。

### A-002 OwnedPet / BattleBuild

同种多实例、四技能有序、个体比较、收藏/锁定、培养约束。

### A-003 RAG Index and Held-out Evaluation

实体/结构化/BM25/可选向量/rerank；Recall@K、MRR、版本命中、grounding、冲突 abstention。

### A-004 Team Workshop

约束解析 → 缺口诊断 → 候选生成 → 方案比较 → 应用；支持锁定 0/1/3 只。

### A-005 On-demand Capability Compiler

全量精灵不是白名单。按 selected build 收集依赖、编译 IR、分类支持、版本缓存；兼容 build 自动进入模拟层。

### A-006 Rule Confidence End-to-end

从 rule evidence 进入 events/planner/coach/report/UI；玩家只看自然语言置信提示，工程细节进抽屉。

### A-007 Learned Value（P1）

接搜索叶节点，比较 heuristic/search/search+value；由用户亲训并完成 held-out、校准、regret、配对和消融。

### A-008 Opponent Belief + Team Pairwise Ranker

前者处理同步隐藏动作；后者处理匹配前未知对手的版本 Meta prior 与六宠阵容比较。

### A-009 真人产品评测

陪练盲评、主动提醒 nuisance、老师学习目标后续局核对。机器词表不能替代真人体验。

## DEFER：现在不要陷进去

| 项 | 原因 |
|---|---|
| 621/622 全量精确 simulator | 缺规则证据；应按能力自动扩展 |
| 高保真官方美术 | 许可和求职收益低 |
| 27B 进入局内关键路径 | 延迟和定位不合适；只做离线 teacher/evaluator |
| 大模型 Agentic RL | 先有稳定 SFT、独立 reward 与 recovery tasks |
| 长期画像 RL | 没真实流量 |
| 自动操作真实客户端 | 公平与产品风险 |
| 深 MCTS / 大规模 self-play | 先稳定环境与 Value baseline |

## 完成度 KPI

```text
1. 全量知识与 RAG 指标
2. OwnedPet/阵容任务成功率和硬约束违反率
3. primitive/trait/timing/evidence 覆盖
4. capability compiler 自动准入与拒绝正确率
5. 代表性 regression archetype 覆盖
6. planner/value 的 regret、校准与配对结果
7. Agent tool+args、grounding、recovery、stale rate
8. intervention precision/recall/nuisance
9. 陪练真人盲评与老师后续局改善
10. 规则变化后的影响定位与可复现重建
```

旗舰项目的判断单位是“能力是否有证据闭环”，不是“手写了多少只精灵”。
