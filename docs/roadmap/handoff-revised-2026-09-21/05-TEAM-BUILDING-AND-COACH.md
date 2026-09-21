# 配队、个体选择与 AI Coach 产品规格

## 1. 用户真正会问什么

至少有：

```text
A. 我什么都没定，帮我从盒子配一队
B. 我一定要带这只
C. 我已经选了两只/三只/五只，边选边帮我补到六只
D. 我已经选满六只，这套队在未知对手环境里是否稳定
E. 我有两个同种个体，练哪一个
F. 我缺某个角色，但不想重新培养太多
G. 我想打某类对手
H. 我只是剧情/PVE，不是 PVP
```

不能都塞进同一个“LLM 推荐六只”。

## 2. RecommendationRequest

```ts
type RecommendationRequest = {
  mode: "PVP" | "PVE" | "SIMULATION"
  owned_pool: OwnedPet[]
  locked_instances: string[]
  banned_instances?: string[]
  must_keep_favorites?: boolean
  target_team_size: number
  user_preferences?: {
    preferred_pets?: string[]
    max_new_investment?: number
    play_style?: string[]
  }
  opponent_context?: KnownOpponentTeam | OpponentPool | UnknownOpponent
}
```

## 3. 三阶段算法

### Stage 1：合法性 + 硬约束

过滤不在盒子、不可用形态、技能非法、锁定冲突、重复限制、模式限制。这一步不需要 LLM。同时分别输出 `knowledge_support / static_team_support / simulation_support`；不能因为某个 build 暂不可精确模拟，就把它从图鉴或静态配队层删掉。

### Stage 2：结构性候选

Cheap score 不追求绝对胜率，至少含：

```text
type coverage
shared weaknesses
roles
speed lines
energy economy
respond coverage
switch-in safety
entry/leave synergy
mark/weather synergy
status pressure
cleanup ability
user investment cost
individual quality
```

可用 rule score、logistic/GBDT ranker、pairwise ranker、Pareto front。

### Stage 3：低延迟 Ranker，不在请求内批量模拟

标准 PVP 配队发生在匹配前，对手未知；线上 SLA 为 3 秒，不能临时让每个 Top-K 阵容与几十套对手打完模拟赛。正确链路是：

```text
离线：版本化规则引擎 / 自博弈 / 社区阵容弱标签
→ 六宠阵容轨迹与 matchup bank
→ Team Ranker / Completion Value / calibration
→ 版本化模型与缓存

在线：全量 600+ 候选
→ 硬约束与廉价召回
→ Beam 补全到六只
→ Ranker 对 Top-K 排序
→ 规则证据与差距解释
```

模拟器仍是训练标签、回归和离线评测器，不是 3 秒主路径。只有低置信或新机制阵容进入异步离线验证；不能让用户等待大批 rollout。

### Stage 4：未知对手的 Meta prior

匹配前 `opponent_context=UNKNOWN_PREMATCH`。阵容强度按版本化对手分布评估，而不是针对一支虚构敌队：

```text
expected_meta_value
worst_archetype / CVaR
matchup_spread
execution_tolerance
support_confidence
```

Meta prior 来源必须有版本与证据：官方推荐阵容只作强种子；社区高分阵容作弱标签；规则引擎和自博弈产生覆盖样本；后续真实匿名对局用于校准。排行榜文章不能直接变成 ground truth。

## 4. 不输出“总分 92”

用户要 trade-off：

```text
方案 A：保留你锁定的迪莫 + 水灵

改善：
+ 补了高速收尾
+ 对火系压力更稳
+ 多一个低费技能窗口

代价：
- 对机械系联防仍薄
- 新增一只需要重新培养速度个体

适合：
你想保留迪莫，而且不想换超过 2 只
```

## 5. 六宠队伍的渐进式交互

```text
已锁定 2 / 6
[迪莫 🔒] [罗隐 🔒] [空] [空] [空] [空]

小芽：
现在已经有核心输出和承伤位，但还缺稳定拦截与协防。
先给 3 个方向，不替你自动填满：
1. 加入 A：补高速拦截，环境价值提升最多
2. 加入 B：补安全换入，稳定性更高
3. 加入 C：保留你偏爱的火系体系，但怕控能

[继续补第三只]
[只看我拥有的精灵]
[只看最强方案]
```

每新增一只就增量重算，不等选满六只才批评。第 1 只只提示定位；第 2～5 只开始给补位候选；第 6 只给完整的环境强度、最差体系、容错和一个最小替换方案。主动提示只在候选能显著改善或玩家停顿时出现。

## 6. 候选生成不要靠 LLM 枚举

LLM 可以把：

> “我喜欢迪莫，别换太多，而且不想再抓很难出的宠”

转成：

```json
{
  "must_include": ["owned_13"],
  "max_replacements": 2,
  "acquisition_cost": "low"
}
```

但 candidate filtering / team search / simulation 由程序做。

## 7. Team Feature 建议

```ts
type TeamFeatures = {
  type_attack_coverage: number[]
  type_defense_coverage: number[]
  shared_weakness_count: number
  role_vector: {
    breaker: number
    tank: number
    pivot: number
    control: number
    support: number
    cleaner: number
  }
  speed: {
    min: number
    median: number
    max: number
    benchmark_passes: string[]
  }
  energy: {
    avg_cost: number
    zero_cost_count: number
    recover_options: number
    high_cost_dependency: number
  }
  tactical: {
    respond_attack: boolean
    respond_defense: boolean
    respond_status: boolean
    swift_entries: number
    forced_switch: number
    weather_core?: string
    mark_core?: string
  }
  cost: {
    new_pets_to_build: number
    build_changes: number
  }
}
```

## 8. “角色”升级成 multi-label

当前 attacker/tank/recovery/control/support 可以保留 baseline，但旗舰版增加：

```text
fast_breaker
slow_breaker
physical_wall
magic_wall
pivot
energy_control
mark_setter
weather_setter
cleaner
anti_switch
swift_pivot
buffer
debuffer
```

同一只可多个 role。角色来源 = static heuristics + skill/trait semantics + simulation behavior + optional learned embedding。

## 9. Planner 与 Coach 的接口

Planner 不返回中文大作文：

```json
{
  "state_version": 42,
  "recommendations": [
    {
      "action": {"kind": "switch", "target": 2},
      "value": 0.31,
      "confidence": 0.74,
      "top_risks": [{"enemy_action": "skill_x", "loss": 0.23}],
      "evidence_ids": ["..."]
    }
  ]
}
```

Coach 翻译：

> **更倾向换水灵。** 你现在这只吃下一轮风险偏高，而水灵能接住对面的主要攻击；风险是对方如果专门抓换人，你会亏这一轮节奏。

## 10. 什么时候 Coach 沉默

至少：

```text
action value gap 太小
evidence coverage 太低
局面刚变化、结果过期
玩家刚关闭提醒
玩家开启安静模式
PVP 公平边界要求静默
没有新的可行动信息
```

“没有明显最优”本身也是模型输出，不要硬凑建议。

## 11. 战前 → 局中 → 局后工具

### 战前

```text
query_owned_roster
inspect_pet
compare_owned_pets
evaluate_team
compare_team_change
search_rules
```

### 局中

```text
read_public_state
list_legal_actions
plan_actions
query_rule
compare_actions
```

### 局后

```text
read_match_summary
read_turn
find_turning_points
generate_practice_case
```

同一套 evidence id / ruleset / state version 贯穿三段。

## 11.5 RAG 与 Agent 验收

全量图鉴不是把 622 行塞进 prompt。知识路径应是：

```text
名字/别名实体解析
→ 结构化筛选（属性/角色/技能/个体/版本）
→ BM25/向量召回
→ 证据与版本 rerank
→ 冲突检查
→ 工具结果
→ LLM 解释
```

至少建立实体、规则、养成、个体比较、阵容补位五类查询集，评估 Recall@K、MRR、实体命中率、版本命中率、grounded claim precision 和冲突时 abstention。Agent 评测还要覆盖：工具选择、参数、约束满足、失败恢复、stale state、证据冲突和无须调用时停止。

## 11.6 三角色不能在扩系统时丢掉

- **军师**：战前约束配队、局中多动作比较、局后反事实。
- **陪练**：接玩家情绪，使用显式偏好与长期记忆；被拒绝、安静模式、重复事实时沉默。真人盲评是上线门槛。
- **老师**：每局只抓一个可教点，生成下一局目标，并在后续局核对；不能把一次答对写成掌握。

## 12. 与官方“斯嘉丽”的差异化演示

不要只演：问“帮我配队”→ 返回六个名字。

演：

```text
1. 盒子里有两个同种个体
2. 玩家锁定最喜欢的一只
3. Coach 从第 2～5 只开始渐进诊断缺口
4. 给两个补队方向
5. 切一个成员后重新比较
6. 进入战斗
7. 关键回合主动提醒
8. 局后指出一次真正可教的换人/资源决策
```

这才是完整 Agent 产品闭环。
