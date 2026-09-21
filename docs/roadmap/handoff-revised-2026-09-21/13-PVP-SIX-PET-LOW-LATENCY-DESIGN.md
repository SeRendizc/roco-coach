# 标准 PVP 六宠与 3 秒阵容工坊设计

> 本文修正此前把活动 3v3 当成标准模式、把固定宠物池当成候选宇宙、把在线批量模拟放进 3 秒请求的错误。事实等级以 `10-SOURCES-AND-CONFIDENCE.md` 为准。

## 1. 当前能说到什么程度

| 结论 | 当前证据等级 | 工程处理 |
|---|---|---|
| 「极速对决」是 3v3、2 点魔力 | OFFICIAL_CURRENT | 独立活动 BattleMode |
| PVP 随机精灵最多可携带 6 只 | OFFICIAL_CURRENT | 支持六宠编队 |
| 标准 PVP 六宠，通常 4 点魔力，力竭通常扣 1 | CROSS_SOURCE_SUPPORTED | 建 candidate ruleset，补录屏 microcase |
| 匹配前不知道对手阵容 | 产品场景 + 待录屏 | 阵容工坊固定 UNKNOWN_PREMATCH |
| 入局后可看到对方精灵，配招与策略仍未知 | COMMUNITY_CURRENT | 可见 roster 与隐藏 build 分开建模 |

不能把特殊 3v3 活动、标准闪耀大赛、2v2 领地试炼写成同一个模式。也不能引用页游天梯规则替代手游证据。

## 2. 产品边界

核心模式：标准化六宠 PVP 阵容工坊。

- 六个队伍槽位；
- 600+ 图鉴全部进入候选宇宙；
- Demo 对竞技 build 使用标准化满级模板，减少练度噪声；这是 Demo 设定，不冒充官方 PVP 全部养成规则；
- 两只额外低等级精灵用于老师的培养闭环，不污染 PVP Ranker；
- 选队阶段不知道具体对手，只依据版本 Meta prior；
- 在线 300ms 内先给结构化初判，3 秒内给完整解释；
- 在线不批量模拟对局。

## 3. “强势阵容”不是手写榜单

强势阵容库只保存可追溯样本，不直接决定答案：

```text
官方推荐阵容             strong seed
社区高分/热门六宠阵容     weak label
规则引擎离线联赛          synthetic label
自博弈发现的反制阵容       exploration sample
未来真实匿名对局           calibration label
```

每条样本绑定：赛季、规则版本、六只精灵、有序技能、血脉/魔法、来源、证据等级、采集日期、适用分段。攻略中的“T0”不能直接转成胜率标签。

社区资料提出主 C、副 C、拦截、协防等常见职能，但系统把它们作为 multi-label feature，不把“一主一副两拦截两协防”写成硬规则。毒、翼王、陨星、萌化、冰、沙暴、武等体系作为版本 archetype seed，是否仍强由版本数据和评测决定。

## 4. 未知对手时怎样定义队伍强度

匹配前没有具体敌队，评价的是六宠队伍对版本环境分布的表现：

```text
expected_meta_value   对版本对手分布的期望表现
worst_archetype       最怕的主流体系
CVaR / robustness     在不利对局尾部是否崩溃
matchup_spread        是否严重依赖撞到特定阵容
execution_tolerance   次优操作下掉多少
coverage_confidence   六宠 build 的规则与数据覆盖
```

胜负标签必须按标准模式候选规则计算：目标是先让对方魔力归零，而不是默认打光六只。随机精灵带来的额外星级/奖励属于 ladder objective，不得混入纯战斗强度；可另给“上分效率”目标。

## 5. 离线生产，在线排序

### 5.1 离线

```text
GameDataPack + candidate BattleMode
→ Capability Compiler
→ 规则引擎与多种 opponent policy
→ 联赛 / 自博弈 / counterfactual substitutions
→ matchup bank
→ Team Pairwise Ranker
→ Partial-team Completion Value
→ calibration + held-out family/archetype evaluation
```

模拟器的价值是生产标签、发现反例、做回归和训练 Value。它不承担每次页面请求的在线大批计算。

### 5.2 在线

```text
玩家已选 0～5 只
→ hard legality / owned / favorite constraints
→ 从 600+ 召回 20～50 个候选
→ Beam Search 补全到六只
→ Completion Value / Team Ranker 排序
→ evidence assembler
→ 立即显示短结论
→ LLM 在剩余预算内组织自然语言
```

建议延迟预算：

| 阶段 | P95 预算 |
|---|---:|
| 状态与版本读取 | 50ms |
| 600+ 候选过滤/召回 | 150ms |
| Beam + Ranker | 300ms |
| 证据与反事实替换 | 300ms |
| 首屏短结论 | 800ms 内 |
| LLM 自然语言 | 总计 3s 内，超时则保留短结论 |

## 6. 六槽渐进推荐

- 0 只：按玩家目标给体系入口，不假装存在唯一答案；
- 1 只：说明它可能承担的多个职能与常见搭档机制；
- 2～5 只：推荐三个下一只候选，分别代表强度、稳定、偏好保留等取舍；
- 6 只：给环境价值、最差体系、容错、支持置信度和一个最小替换方案。

推荐第六只不是独立分类任务。`CompletionValue(S)` 估计当前部分队伍能被补成强队的上限与稳健性：

```text
candidate c
→ BeamComplete(S ∪ {c}, remaining slots)
→ rank best feasible completions
→ compare marginal gain and new weakness
```

玩家每点一只就增量更新；候选显著变化、出现明显结构缺口或停留时才轻量提醒。

## 7. 600+ 候选怎样避免组合爆炸

不枚举 `C(622, 6)`。召回与排序分层：

1. 合法性、模式、拥有状态和用户锁定；
2. 属性/速度/能量/应对/入离场/印记/天气等倒排索引；
3. pair synergy 与 role coverage 的廉价分；
4. ANN 或 GBDT 召回 20～50；
5. Beam Search 生成少量六宠队；
6. Pairwise Ranker / Set model 排序；
7. 用反事实替换生成“为什么”。

任何精灵只要 build 数据与能力依赖可用，就参与评分；未知关键机制降低 support confidence 或 fail closed，不从候选宇宙里静默消失。

## 8. 模型分工

- LightGBM/GBDT：可解释的 Team Ranker 基线；
- DeepSets/Set Transformer：学习六只精灵的集合交互；
- Completion Value：支持 0～5 只部分阵容；
- Battle Value/Policy：离线模拟与局中搜索；
- 4B LLM：在线工具路由、约束解析、短解释；
- 27B LLM：离线教师、难例生成、评审，不直接替代规则和 Ranker；
- RAG：检索版本化技能、机制、阵容来源和适用条件。

## 9. 首批验收

1. 六槽 UI，不能再显示标准 PVP 3v3；
2. 候选检索能从全量目录命中非当前 48 Demo 的精灵；
3. 固定两只后，第三只候选会随版本、偏好和锁定约束变化；
4. 固定五只后，推荐的第六只能指出填补的具体缺口与新增风险；
5. 同一阵容在不同 Meta prior 下排序可变化；
6. P95 小于 3 秒，模型超时仍有可用短结论；
7. 不输出伪精确胜率；有校准证据前显示区间与置信等级；
8. 未知机制不得被 LLM 补写；
9. 特殊 3v3 活动通过独立 BattleMode 仍可运行；
10. 所有强势阵容结论能追溯到版本、来源或离线评测产物。
