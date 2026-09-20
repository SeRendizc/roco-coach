# 第 7 轮验证日志（收口 planner）

HEAD：见 `reports/roco/verification/round7-head.txt`

## 套件结果

| 套件 | 命令 | 结果 |
|---|---|---|
| Python | `npm run test:env` | **183 / 183**（1 项按守卫 skip） |
| Node unit | `npm run test:unit` | **424 / 424** |
| Node browser | `npm run test:browser` | **18 / 18**（本轮 0 skip） |
| 桥契约 | `npm run test:bridge` | 11 / 11 |
| 工具层 | `npm run test:toolbox-roco` | 17 / 17 |
| 规划端到端 | `npm run test:plan-e2e` | 10 / 10 |
| 结构契约 | — | 8 / 8 |
| 投影层 | `npm run test:roco-experience` | 12 / 12 |
| **合计** | | **683 项，0 失败** |

（核对：424 + 18 + 183 + 11 + 17 + 10 + 8 + 12 = 683。）

## 浏览器真机验收

- `npm run roco:demo-acceptance` → **16 / 16 通过**（`round7-demo-acceptance.log`）
- `node scripts/roco/browser-acceptance.mjs` → **9 / 9 通过**（`round7-browser-acceptance.log`）

## 结论必须同时报告的五个数（见 `round7-planner.log`）

| 口径 | 数值 |
|---|---|
| 一步指标（top1，120 局面） | planner **0.586** vs 朴素贪心 **0.878** |
| 整局胜负 `greedy_damage` | planner **44/80 = 0.550** CI95 (0.441, 0.654) vs 基线 18/40 = 0.450 CI95 (0.307, 0.602) |
| 整局胜负 `shallow_search` | planner 18/80 = 0.225 CI95 (0.147, 0.328) vs 基线 13/40 = 0.325 |
| 整局胜负 `status_control` | planner 21/80 = 0.263 CI95 (0.179, 0.368) vs 基线 15/40 = 0.375 |
| 延迟 | `/battle/plan` 端到端 **p50 = 146 ms**（7 次采样 146—152） |
| 回落率 | **0.0**（三个对手全部），超时决策 **0** |

## 保留 / 撤回的实验

**保留（有明确正确性理由）**

1. 失败的 rollout 不得按「原状态」计分 → 推不动记 `-inf`。
2. `plan_actions(side=...)` 必须真实生效（此前候选写死取 player）。
3. 回落率必须显式暴露，并在 > 25% 时警告。

**撤回（无整局收益、增加复杂度或延迟）**

4. rollout 改成对对手分布取期望：top1 0.667→0.684（噪声内）、
   整局 `greedy_damage` 44/80→**41/80**、延迟 146→**186 ms**。
   撤回后三格精确复原为 44 / 18 / 21，延迟回 146 ms。

**明确不使用**

5. 不以 one-ply top1 自证 planner 更强 —— 它与 planner 共用 `evaluate()`，
   不是手游真值。脚本 docstring 里写了这条边界。
