# 给 Coding Agent / DSH 的总 Prompt v2

你现在接手 `SeRendizc/roco-coach`。目标是把当前项目升级成面向《洛克王国：世界》手游的旗舰主动 AI Coach。它不是新项目，不得推倒重写。

## 1. 先读与基线

先读当前仓库的 README、`docs/roco/PROGRESS.md`、`docs/roadmap/DSH-EXECUTION-STATE.md`、FULL-CATALOG、COVERAGE-LAYERS、EFFECT-PRIMITIVES、COACH-ADVICE-DESIGN、GAME-ADAPTER，以及本升级包全部文档，尤其修订后的 `08-IMPLEMENTATION-ROADMAP.md`。

先运行现有基线与 release guard，生成 `reports/roco/flagship-upgrade/baseline.json`。升级包与代码冲突时，以当前代码和可跑证据为准，更新审计，不得重复施工。

任何涉及手游规则、PVP 模式、强势阵容、技能/特性语义或版本 Meta 的任务，必须先读 `10-SOURCES-AND-CONFIDENCE.md` 与对应原始来源，再建立 evidence ledger。官方、实机录屏、社区当前资料、交叉支持、工程假设和未知必须分级；不得凭模型记忆、页游规则或单篇榜单施工。没有足够证据时先保留 candidate/unknown，并把需要录制的 microcase 写入验收。

## 2. 产品与技术目标

```text
全量 GameDataPack / RAG / OwnedPet
→ 有约束阵容工坊
→ capability compiler 按 build 判断模拟资格
→ deterministic simulator + search/value
→ Agent 调工具并组织证据
→ 主动短提示
→ 局末教学与偏好记忆
```

规则引擎负责事实、合法性和结算；Search/Value 负责策略；LLM 负责约束理解、工具选择、证据组织和解释。LLM 不得计算伤害、猜合法动作或制造胜率。

## 3. 600+ 精灵的唯一正确实现

621/622 条全部进入一个版本化 `GameDataPack`，不是 622 份手写代码。知识、OwnedPet 和静态阵容评估覆盖全量。

当前 48 个 Demo build 只作迁移夹具，不是未来 regression 白名单。长期回归使用固定机制 microcase、全量目录分层抽样与历史失败样本。玩家选中某个 OwnedPet 与 ordered build 后：

```text
collect skill/trait/form/mode dependencies
→ lower to Effect/Trigger IR
→ compare primitive/timing/rule evidence
→ classify support
→ cache by ruleset + entity revisions + build hash
```

只要第 49/301 只精灵复用已支持原语，它必须无需新增 pet-specific 分支就能进入模拟层。未知机制必须 fail closed，列出缺失依赖，并提供兼容配招、静态评估或替代精灵。

标准 PVP 阵容固定按 6 个槽位设计；官方活动 3v3 是独立 BattleMode，不能拿来替代标准模式。全量 600+ 都是候选宇宙；任何固定宠物名单都不能成为检索、Ranker 或 UI 的运行时白名单。

阵容工坊发生在匹配前，必须按未知对手 Meta prior 评价。线上 3 秒内禁止批量模拟：离线规则引擎/自博弈生成标签并训练 Team Ranker 与 Completion Value；在线做候选召回、Beam 补全、Ranker 排序和有证据解释。玩家选 2～5 只时应增量推荐下一只。

## 4. 当前 P0：规则 candidate，不得擅自 promotion

当前引擎的 `max=6 / initial=2 / end-turn+1` 是假设；多份社区资料交叉支持 `max=10 / 聚能+5`。先建立 `legacy_sim_v1` 和 `mobile_s4_candidate_v2`，写 microcase、影响报告与双规则对照。

置信等级：

```text
OFFICIAL_CURRENT
RECORDED_IN_GAME
COMMUNITY_CURRENT
CROSS_SOURCE_SUPPORTED
ENGINE_HYPOTHESIS
UNKNOWN
```

只有前两级可直接成为真实 current 规则。社区交叉支持只能进入 candidate。未知项不得通过改测试“确认”。

## 5. 当前 P0：全量知识、RAG、OwnedPet、阵容工坊

- 保留已有 622 L1，并对账当前公开 621/579/242；不删记录凑数。
- 新建 traits 与 entity reconciliation，记录许可、revision、sha256 和 unresolved。
- 固定 seed 生成约 80 个 owned instances，包含同种不同个体；可持久化、比较、收藏、锁定。
- RAG = 实体/别名 + structured filter + BM25 + optional vector + evidence/ruleset rerank；必须有 Recall@K/MRR/版本命中/grounded precision/conflict abstention。
- 阵容支持六宠、锁定 0～6 只、最多替换数、偏好和模式；先诊断缺口再推荐；全量 600+ 经 filter/retrieval/Beam/Completion Value/Team Ranker 生成，LLM 不枚举。选 2～5 只时提供渐进补位。

## 6. 不准重复或退化当前完成能力

以下是 KEEP + revalidate，不是 ADD：多动作比较、2–3 回合后果、stale result discard、PVP gate、RAG evidence、game adapter、mock host、48 roster coverage、老师闭环、陪练记忆、local gateway、release guard。

重设计 UI 可以迁移 acceptance hooks，不得删掉或把产品能力改弱。

## 7. Agent 主线必须贯穿

每个新产品能力都要同时交付工具合同和 Agent 任务：

- inspect/compare OwnedPet；
- query catalog/rules；
- diagnose team gaps；
- generate/compare candidates；
- capability compile；
- plan/compare actions；
- match review/practice case。

评测覆盖 tool+args、hard constraints、grounding、stale state、tool failure recovery、evidence conflict、stop/silent。4B 为在线 router，27B 为离线 teacher/evaluator；两者都不替代 Battle Value。

## 8. 算法优先级

规则 candidate 稳定后重建 trajectories。Learned Value 是 P1 必做：由用户在 RTX 3060 上亲手训练，比较 heuristic/search/search+value，做 family/archetype/opponent held-out、校准、regret、配对胜负和消融。再做 opponent belief、BC policy prior；PPO/self-play 与 Agentic RL 属 P2，必须先有独立 reward/evaluator。

## 9. 三角色产品闭环

- 军师：战前配队、局中比较、局后反事实。
- 陪练：接情绪、记显式偏好、尊重拒绝与安静、避免重复；真人盲评后才开学习型介入。
- 老师：一个转折点、一条改法、下一局目标、后续局核对。

模型指标不能代替玩家体验。

## 10. 工作纪律

一次只做一个 RC ID。开始前写 Goal / evidence / files / acceptance / negative test / migration impact；完成后写 Changed / tests / artifacts / known limits / next。

禁止：页游规则、抓包/内存/自动点击、官方素材复刻、600 个 pet-specific 分支、社区公式冒充 verified、旧轨迹冒充新 ruleset、单局证明模型更强、为了 UI 重写 runtime、为了全绿删测试或放宽断言。

出现来源冲突、规则变化将 invalidates 产物、许可不明或需实机验证时，记录冲突、提供最小继续路径、保持 unknown/fail closed，然后报告，不得猜。

## 11. 开工顺序

严格按修订路线：

```text
RC-000
→ RC-101～104
→ RC-201～205
→ RC-301～305
→ RC-401～505
→ RC-601～605
→ RC-801/802
→ P2 RL 与最终材料
```

不得在 P0 规则和数据迁移尚未收口时下载/训练 27B 或重跑大规模 RL。
