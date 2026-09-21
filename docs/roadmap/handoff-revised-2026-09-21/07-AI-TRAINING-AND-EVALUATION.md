# AI / 算法 / 训练 / 评测路线

## 1. 不要把三个学习问题混成“一个 RL”

### A. Battle Policy

> 在当前公开状态下，选哪个动作？

```text
state → action distribution / value
```

### B. Intervention Policy

> 现在应该主动提醒吗？

```text
state + context + player preference
→ speak / defer / silent
```

### C. Coach Agent Policy

> 用户问了问题，需要查什么工具、如何解释？

```text
dialogue + state
→ tool calls
→ grounded response
```

三者 reward、数据、部署时机不同。

## 2. 为什么战斗要单独拿出来

Battle Policy 的监督信号：胜负、局面价值、未来 rollout、动作优势。

Agent Tool Use 的监督信号：工具选对没、参数对没、证据对没、有没有编事实。

如果混在一个“最终赢了 +1”的 reward，LLM 可能学到少查工具、编动作、利用 simulator 漏洞或忽略用户约束。拆开才能知道改善来自哪里。

## 3. 配队为什么不必先做 RL

配队首先是：

```text
constrained combinatorial optimization + ranking
```

数据不多时优先：

```text
rule baseline
→ learned ranker
→ simulator validation
```

有稳定 simulator、大量对手池与 team-level reward 后，再考虑 evolutionary search / RL / self-play。

## 4. 当前已有实验如何定位

当前仓库已有：规则 team baseline、logistic team evaluator、Qwen3.5-4B 本地推理、tool-use LoRA SFT、intervention classifier、shadow replay、多臂评测、轨迹数据。

这些都保留，但基础游戏规则变化后必须判断哪些实验被污染。尤其 energy/action legality 修正会改变 trajectory distribution。

## 5. Battle AI 进阶路线

### B0：Heuristic
必须保留，作为可解释 baseline。

### B1：Short-horizon Expectimax / Beam Search

同步动作下：

\[
V(s,a) = \sum_{a_o} P(a_o|s) Q(s,a,a_o)
\]

### B2：Behavior Cloning

从 rule/search teacher、人工高质量轨迹或 self-play 强策略学习 policy prior。

### B3：Value Model

输入 observation 估局面价值，用于截断搜索。

**本项目中 B3 属于 P1，而不是“有余力再做”。** 当前已有 12,000 局、234,058 transitions、family split、确定性 replay 和 search baseline，已经具备预注册 Value 实验的条件。至少比较：heuristic / search / search+value，并报告 held-out family 的校准、regret、配对胜负和失败样例。

### B4：Self-play RL

前置：simulator 基础规则稳定、reward 无明显漏洞、held-out opponent families、训练/评测规则独立。PPO 只是一个选项，不要先锁死算法名。

## 6. Opponent Belief

同步选择意味着你不知道对方本回合动作。可建：

\[
P(a_{opp} \mid o_t, history)
\]

baseline：uniform legal / frequency heuristic / rule policy mixture。

learned：small MLP / transformer over recent events。

Search 使用 belief，而不是假装知道敌方动作。

## 7. 配队模型

推荐 target 做 pairwise：

```text
team A vs team B
which performs better against the declared opponent pool?
```

输入 team static features + support coverage + opponent pool embedding；输出 rank/preference。

评测：held-out pet families、held-out archetypes、held-out opponent policies。

## 8. Tool-use SFT

扩到真实新产品任务：

```text
“我想保留这两只，逐步补成六只”
“这两个个体练哪个”
“为什么刚才叫我换”
“上一回合我做错了吗”
“这个建议是不是因为属性克制”
```

工具：

```text
inspect_owned_pet
compare_owned_pets
evaluate_team
compare_team_change
read_public_state
plan_actions
read_turn
query_rules
```

4B 的定位仍是在线低延迟工具路由；27B 的定位是离线 teacher/evaluator/数据生成与慢速复盘。两者都不替代 Battle Policy 或 Value Model。

## 8.5 全量知识的 RAG 评测

数据导入不等于 RAG 完成。检索应组合实体/别名匹配、结构化过滤、BM25、可选向量召回和证据版本 rerank，并在冲突时 abstain。建立至少五类 held-out 查询：实体规则、版本变化、养成、个体比较、阵容补位。报告 Recall@K、MRR、版本命中率、grounded claim precision 与 conflict abstention。

## 9. Agentic RL 进入条件

只有当：

1. SFT 已有强 baseline；
2. reward 可独立判定；
3. reward 不等于训练模型自己打分；
4. 有 tool-cost penalty 但不会奖励“不查资料”；
5. 有真实 recovery task；
6. 有 held-out task families；
7. RL 对至少一个具体 failure class 稳定改善。

合理 reward：

\[
R = w_1R_{task}+w_2R_{constraint}+w_3R_{evidence}-w_4C_{tool}-w_5P_{hallucination}
\]

不是“少调用工具 = 高分”。

## 10. Evaluation Matrix

最终至少：

```text
Rule/Search baseline
Base LLM
SFT LLM
SFT + RL（若做）
External model (DeepSeek) reference
```

指标：

| 维度 | 指标 |
|---|---|
| 任务完成 | task success |
| 约束 | hard constraint violation |
| 工具 | tool + args accuracy |
| 证据 | grounded claim precision |
| 规则 | illegal action rate |
| 恢复 | tool failure recovery |
| 泛化 | held-out family |
| 主动提醒 | precision / recall / nuisance |
| 时延 | p50 / p95 |
| 成本 | tokens / calls / GPU |
| 过期 | stale suggestion rate |
| 战斗 | return / regret / declared simulator metric |
| 校准 | ECE / Brier when probabilistic |

## 11. 训练顺序

```text
规则校准
  ↓
重建 trajectories
  ↓
重新跑 rule/search baseline
  ↓
重训 team ranker
  ↓
重跑 tool-use SFT benchmark
  ↓
Learned Value（P1，接入搜索叶节点）
  ↓
Opponent belief / Battle BC policy prior
  ↓
Self-play（可选）
  ↓
Agentic RL（可选）
```

同时保留独立的产品评测支线：陪练真人盲评、老师后续局核对、主动介入 nuisance rate。算法指标不能替代玩家体验。

不要现在直接做大 RL。

## 12. 面试中怎么说 RL

推荐：

> 我没有把 RL 当装饰，而是把训练问题拆开。规则引擎先保证环境可信；战斗策略、主动介入和工具使用有不同状态、动作与 reward。我先用规则/搜索和 SFT 建 baseline，只有 reward 可独立验证后才引入 RL，并做 held-out 与消融。

不要说“用了 PPO，所以 Coach 会自己学怎么玩”。

## 13. 硬件分工

### M5 Pro 48GB

Qwen 4B local inference、LoRA/SFT、tool-use experiments、embedding/RAG、产品开发。

### RTX 3060 Laptop 6GB

小型 PyTorch learned value / policy prior、simulator batch、PPO/self-play 小规模、CUDA profiling。第一项应由用户亲手完成，用来形成可讲清楚的数据集、网络、loss、切分、校准、消融和接入证据。

### 云 GPU

只在更大 RL 或大量并行 rollout 成为明确瓶颈后租，不为“看起来像大模型项目”烧钱。
