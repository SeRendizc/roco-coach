# 1,000 场先导（S02）

> 本报告的分组胜负计数是**环境自检，不是胜率、不是强度榜**。社区阵容出现频率不是胜率；模拟出来的胜场数也不是天梯强度。这里没有任何一个策略可以被称为「强」或「T0」——本项目的策略池按**行为**命名而不按名次命名，正是因为「谁强」需要真实天梯样本，而本项目没有。

## 身份

| 项 | 值 |
|---|---|
| 规则集 | `roco-world-s4-2026-09-10` |
| 快照指纹 | `affa4273ae5fb87578d038084e7a30dc6f5e2fd5e59d11049f0aa989c40a1f7a` |
| 代码 commit | `4da4fca4964c18434335e4a50db4976cae4f5ebd`（工作区有未提交改动） |
| 种子范围 | 20260921 … 20261920 |
| 场次 | 1000 |
| 回合上限 | 300 |
| 策略版本 | v1 |

## 策略

| 策略 | 版本 | 怎么决策 |
|---|---:|---|
| `random_legal` | v1 | 在 legal_actions 上均匀随机；对照组。 |
| `greedy_damage` | v1 | 取即时伤害估计最高的一手（能耗折价；残血时才吃药）。 |
| `conservative_switch` | v1 | 对位吃亏且后备明显更能扛时换人，否则吃药/防御/省能量出手。 |
| `status_control` | v1 | 优先施加状态/减益/印记（解析器说没覆盖的算半套，打对折）。 |
| `shallow_search` | v1 | 对每一手做 1 层前瞻：收益 − 对手最疼还手 − 换人整回合成本。 |

## 验收

| 指标 | 值 | 口径 |
|---|---:|---|
| 吞吐 | 49.3 局/秒 | 端到端墙钟；20.3s / 1000 局 |
| 非法动作 | **0** | 策略返回值不在 `legal_actions` 里（必须为 0） |
| 截断 | 0 | 撞上 300 回合上限 |
| 异常 | 0 | 未捕获异常 / 非法动作；原因见 `exception_causes` |
| 无结局对局 | 0 | 既没胜负也没平局 |
| 隐藏字段读取 | 0 | 策略试图读 observation 之外的键的次数（必须为 0） |

## 回合数分布

- `turns` = 对局走到的回合号；`battle_turns` = 真正结算过的战斗回合数（补位不消耗回合，两者会差若干个补位步）。
- 均值 51.13，标准差 35.29，中位 42，最大 214。

| 回合区间 | 局数 |
|---|---:|
| 0-19 | 157 |
| 20-39 | 318 |
| 40-59 | 196 |
| 60-79 | 143 |
| 80-99 | 77 |
| 100-119 | 54 |
| 120-139 | 37 |
| 140-159 | 11 |
| 160-179 | 2 |
| 200-219 | 5 |

## 结局

| 座位 | 胜场 |
|---|---:|
| player（A 侧） | 499 |
| enemy（B 侧） | 497 |
| 平局 | 4 |

> player/enemy 是**对局里的座位**，不是「更强的一方」。每个有序策略对场次相同。

### 分组胜负计数（自检用）

> 这些数字是**环境自检**：它们说明引擎能把不同策略区分开、并且每局都能走到明确结局。**它们不是胜率，不构成强度榜，也不支持任何「某策略强」的说法。**

| A 侧 | B 侧 | 场次 | A 胜 | B 胜 | 平 | 截断 | 异常 |
|---|---|---:|---:|---:|---:|---:|---:|
| `conservative_switch` | `conservative_switch` | 40 | 20 | 20 | 0 | 0 | 0 |
| `conservative_switch` | `greedy_damage` | 40 | 17 | 23 | 0 | 0 | 0 |
| `conservative_switch` | `random_legal` | 40 | 26 | 14 | 0 | 0 | 0 |
| `conservative_switch` | `shallow_search` | 40 | 23 | 17 | 0 | 0 | 0 |
| `conservative_switch` | `status_control` | 40 | 23 | 17 | 0 | 0 | 0 |
| `greedy_damage` | `conservative_switch` | 40 | 22 | 18 | 0 | 0 | 0 |
| `greedy_damage` | `greedy_damage` | 40 | 20 | 20 | 0 | 0 | 0 |
| `greedy_damage` | `random_legal` | 40 | 29 | 11 | 0 | 0 | 0 |
| `greedy_damage` | `shallow_search` | 40 | 26 | 14 | 0 | 0 | 0 |
| `greedy_damage` | `status_control` | 40 | 30 | 10 | 0 | 0 | 0 |
| `random_legal` | `conservative_switch` | 40 | 14 | 26 | 0 | 0 | 0 |
| `random_legal` | `greedy_damage` | 40 | 11 | 29 | 0 | 0 | 0 |
| `random_legal` | `random_legal` | 40 | 23 | 16 | 1 | 0 | 0 |
| `random_legal` | `shallow_search` | 40 | 11 | 29 | 0 | 0 | 0 |
| `random_legal` | `status_control` | 40 | 16 | 24 | 0 | 0 | 0 |
| `shallow_search` | `conservative_switch` | 40 | 17 | 23 | 0 | 0 | 0 |
| `shallow_search` | `greedy_damage` | 40 | 15 | 25 | 0 | 0 | 0 |
| `shallow_search` | `random_legal` | 40 | 25 | 14 | 1 | 0 | 0 |
| `shallow_search` | `shallow_search` | 40 | 21 | 19 | 0 | 0 | 0 |
| `shallow_search` | `status_control` | 40 | 19 | 21 | 0 | 0 | 0 |
| `status_control` | `conservative_switch` | 40 | 16 | 24 | 0 | 0 | 0 |
| `status_control` | `greedy_damage` | 40 | 12 | 28 | 0 | 0 | 0 |
| `status_control` | `random_legal` | 40 | 24 | 16 | 0 | 0 | 0 |
| `status_control` | `shallow_search` | 40 | 19 | 21 | 0 | 0 | 0 |
| `status_control` | `status_control` | 40 | 20 | 18 | 2 | 0 | 0 |

## 队伍效应（为什么不能把上面的表读成强度）

暴露平衡：`balanced=True`（每个策略对场次相同，且队伍对的多重集合完全相同（逐格场次也相同）），每个策略对 [40] 场，覆盖 [16] 种有序队伍对，暴露模式 1 种。

下表按队伍对拆分。如果同一对队伍换了策略还是同样的悬殊比分，那么差异来自**队伍与属性相性**，不是策略：

| 队伍对 | 场次 | A 胜 | B 胜 | 平 |
|---|---:|---:|---:|---:|
| `T0__vs__T0` | 75 | 40 | 35 | 0 |
| `T0__vs__T1` | 75 | 74 | 1 | 0 |
| `T0__vs__T2` | 75 | 54 | 21 | 0 |
| `T0__vs__T3` | 75 | 75 | 0 | 0 |
| `T1__vs__T0` | 75 | 1 | 74 | 0 |
| `T1__vs__T1` | 75 | 35 | 37 | 3 |
| `T1__vs__T2` | 75 | 0 | 75 | 0 |
| `T1__vs__T3` | 75 | 13 | 62 | 0 |
| `T2__vs__T0` | 50 | 16 | 34 | 0 |
| `T2__vs__T1` | 50 | 49 | 1 | 0 |
| `T2__vs__T2` | 50 | 25 | 25 | 0 |
| `T2__vs__T3` | 50 | 48 | 2 | 0 |
| `T3__vs__T0` | 50 | 0 | 50 | 0 |
| `T3__vs__T1` | 50 | 42 | 8 | 0 |
| `T3__vs__T2` | 50 | 2 | 48 | 0 |
| `T3__vs__T3` | 50 | 25 | 24 | 1 |

> 队伍池：`T0` = 寂灭骨龙、海豹船长、黑猫巫师；`T1` = 圆号鱼、雪影娃娃、音速犬；`T2` = 寂灭骨龙、黑猫巫师、雪影娃娃；`T3` = 海豹船长、圆号鱼、音速犬。队伍对之间场次不完全相同是因为块内轮换的余数，不是加权。

## 复现

```sh
cd /Users/serendizc/Developer/roco-coach && python3 roco/run_pilot.py --games 1000 --base-seed 20260921 --out /Users/serendizc/Developer/roco-coach/reports/roco/pilot-1000
```

异常局的逐条复现记录在 `failures.jsonl`（每行一局，含种子、队伍、策略版本与可重放的行动序列）。正常运行时该文件是空的。
