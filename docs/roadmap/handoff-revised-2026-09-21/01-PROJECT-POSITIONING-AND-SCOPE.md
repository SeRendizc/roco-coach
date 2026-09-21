# 项目定位、求职价值与风险边界

## 1. 最终要展示的不是“AI 会玩洛克王国”

项目真正有价值的技术命题是：

> 在一个具有大规模实体库、同步决策、隐藏对手动作、技能时序、资源管理和规则版本变化的环境里，如何让一个 AI Coach **既能给出有用建议，又能证明建议基于什么事实，并且知道什么时候不该说话**。

这比“LLM + RAG + 配队”难一个层级。

## 2. 为什么仍然值得做成旗舰项目

截至 2026-08，官方已经推出智能配队 AI 伙伴“斯嘉丽”。因此“AI 帮玩家配队”已经被真实产品验证为有需求。

这同时意味着：

- **好处**：题目不是自嗨，官方已经验证产品价值；
- **风险**：如果项目只是“聊天 + 推荐阵容”，差异化不足。

你的差异化锁定五点：

### 2.1 可验证

每个数值、合法动作、状态变化来自规则引擎和证据，不由 LLM 自由生成。

### 2.2 主动

Coach 不只是玩家问一句答一句，而是从游戏事件判断：

```text
现在说话 / 局后再说 / 保持沉默
```

### 2.3 局中决策

处理当前 HP/能量、天气/印记/状态、后备阵容、对手未知动作、换人风险与 2–3 回合反事实搜索。

### 2.4 可训练

至少有真实参数更新实验：team evaluator、tool-use SFT、intervention classifier、后续 Battle Policy / Value Model。

### 2.5 可评测

每条能力有独立 held-out benchmark、回放、失败类型和版本。

## 3. 对不同岗位应该强调什么

### Agent / LLM 岗

重点：工具合同、证据包、stale result、state/version constraints、RAG、tool-use SFT、hallucination guard、proactive intervention、memory / preference constraints。

### AI Infra / LLM Systems 岗

重点：deterministic replay、event log、bridge/service、local model gateway、latency、shadow traffic、versioned artifacts、reproducible training、regression gates、fallback、fail closed、local/cloud routing。

### 算法 / Game AI 岗

重点：simultaneous/joint action、partial observability、opponent belief、short-horizon search、policy/value、behavior cloning、self-play、RL、calibration、OOD opponent families。

### 产品型 AI 岗

重点：战前/局中/局后闭环、“有用但不打扰”、用户硬约束、个体养成、推荐解释、可信度、人机协作。

## 4. 项目风险

### R1：官方功能撞题

面试官可能问：“官方自己都有斯嘉丽，你做这个有什么新意？”

回答：

> 官方能力验证了场景价值；我的研究重点不是复刻聊天配队助手，而是把“规则真值、回合级决策、主动介入、训练、评测、版本约束”做成完整工程闭环。

现场最好展示：

```text
同一局面
→ 3 个合法动作
→ 对手响应分支
→ 风险
→ state version
→ 选完动作后旧建议自动失效
```

### R2：外挂观感

绝对不要描述为读内存、抓包、自动点击、自动排位。

描述为：

```text
GameAdapter
  receive(GameEvent)
  observe(PublicState)
  emit(CoachSuggestion)
```

Demo 使用 mock host / simulator；真实落地假设获得游戏官方授权状态流。

### R3：知识库很大，但技术含量是假大

“我导了 622 只”本身没什么技术价值。真正技术点是：

> 为什么导 622 只不需要 622 份代码，以及怎样知道其中哪一只目前可以被精确模拟。

### R4：RL 装饰

如果 RL 没有 baseline、reward definition、independent evaluator、seed、held-out split、failure examples，就不要把它写成主卖点。

### R5：规则不准导致整条链路失真

```text
错误 simulator
→ 错误轨迹
→ 错误 team model
→ 错误 planner
→ 错误 SFT/RL 数据
→ Coach 很“聪明”但在学习一个假的游戏
```

因此 P0 是校准，不是继续堆算法。

## 5. 范围：必须做 / 后做 / 不做

### 必须完成

1. 基础战斗规则的版本化 candidate、microcase 与迁移影响；
2. 全量图鉴 / RAG 评测 / 我的盒子；
3. 个体养成建模；
4. 有约束配队；
5. 代表性可模拟池；
6. 主动局中建议；
7. 局末复盘；
8. Learned Value 接入搜索叶节点的严格对照；
9. Tool-use SFT/Agent 的严格对照；
10. 陪练真人盲评与老师后续局核对；
11. 完整评测；
12. 演示 UI。

### 后做

- 全 621/622 特性精确模拟；
- 深层 MCTS；
- 大模型 Agentic RL；
- 真实玩家长期个性化；
- 27B 大规模训练或进入局内关键路径。

### 不做

- 完整开放世界；
- 抓宠地图；
- 家园/剧情/商店；
- 官方美术资产复刻；
- 联网排位；
- 600+ 精灵逐个手写逻辑；
- 大量与求职目标无关的装饰动画。

## 6. Flagship 的验收标准

面试官打开项目 5 分钟应该看到：

1. “我的盒子”里不是 12 个预制宠，而是 600+ 图鉴和几十/几百个 owned instances；
2. 选中一个具体个体，Coach 能解释“这只为什么值得/不值得继续培养”；
3. 六宠 PVP 工坊从全量 600+ 候选中工作；锁定第 2～5 只时逐步给下一只候选，选满后给 Meta 稳健性和 trade-off；
4. 选中的 build 由 capability compiler 判断模拟资格，而不是查固定白名单；
5. 匹配前不假设知道对手；开局后只使用宿主明确公开的对手 roster/state，双方同步选动作；
6. Coach 不是每回合都弹；
7. 关键局面出现一个可验证建议；
8. 点开能看到行动对比与风险；
9. 局面推进后旧建议消失；
10. 局末只抓一个真正可教的点；
11. 开发者抽屉能展示 rule version、coverage、model arm、latency、evidence。

达到这 10 点，比“把所有精灵都写完”更像成熟旗舰项目。
