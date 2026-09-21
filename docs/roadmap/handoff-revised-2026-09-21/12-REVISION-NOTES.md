# 2026-09-21 路线复核与修订说明

## 为什么不能直接使用原升级包

原包方向正确，但存在六个执行风险：社区资料的置信度写高；差距审计落后于当前 HEAD；48～60 容易被误解成固定白名单；Agent/RAG/Memory/三角色在路线中被弱化；Learned Value 被放到过低优先级；P0 过大，容易长时间重构而无可玩增量。

## 本版做出的决策

1. 规则置信度改为 OFFICIAL_CURRENT / RECORDED_IN_GAME / COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED / ENGINE_HYPOTHESIS / UNKNOWN。
2. 能量 10 / 聚能 +5 进入 candidate ruleset，不凭社区攻略直接覆盖 current。
3. 622 条进入统一 GameDataPack；全量知识、OwnedPet 与静态阵容层一次性扩展。
4. 当前 48 个 Demo build 只作迁移夹具；长期 regression 改为规则 microcase、全量目录分层抽样与历史失败样本，不设宠物白名单。
5. 新增按 build 按需执行的 Capability Compiler；复用已有原语的新精灵自动进入模拟层。
6. 增加版本缓存与失效键，未知机制 fail closed，并提供兼容配招/静态评估/替代精灵。
7. 补上 RAG held-out 查询与 Recall@K/MRR/grounding/conflict abstention。
8. 更新 KEEP 清单，避免重做已经完成的多动作比较、未来后果、game adapter、RAG evidence、stale guard、三角色闭环。
9. Learned Value 提升到 P1，并明确由用户在 RTX 3060 上亲自训练。
10. Agent 工具合同、SFT、失败恢复和三角色产品验收贯穿各阶段。
11. PPO/self-play/Agentic RL 放在规则、Value、SFT 和独立 reward 之后。
12. P0 拆成事实迁移、全量数据/RAG/OwnedPet、阵容工坊三个可独立验收阶段。

## v3 追加修订：标准 PVP 与 3 秒阵容工坊

- 纠正此前误用 3v3：官方 3v3/2 魔力属于「极速对决」活动；标准 PVP 按六宠候选模式设计，4 魔力胜负先标交叉支持并补实机证据。
- 阵容工坊发生在匹配前，不假设知道对手；按版本 Meta prior 评价。
- 全量 600+ 都参与候选召回，不用 48～60 运行时名单。
- 取消“48～60 只代表未来能力边界”的表达；回归单位改成机制与 build case，不用于限制 Ranker 的候选宇宙。
- 在线取消 Top-K 批量模拟；离线模拟/自博弈训练 Team Ranker 与 Completion Value，线上 300ms 初判、3 秒解释。
- 支持六槽渐进配队：选第 2～5 只时就推荐下一只，选满后做环境强度与最小替换分析。

## DSH 使用方法

先读当前仓库事实，再读本包。以 `08-IMPLEMENTATION-ROADMAP.md` 为施工顺序，以 `09-CODING-AGENT-MASTER-PROMPT.md` 为总合同。每次只领取一个 RC ID；不得把整个 P0 作为一个无边界长任务。每个 RC 都必须有代码、自动测试、反证、浏览器证据或机器可读产物，以及 known limits。

本包目前用于用户审阅，尚未授权直接施工。
