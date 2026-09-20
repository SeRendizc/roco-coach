# P02 干预窗口评测（fixture，非人体实验）

Offline authored/replayed decision windows for the intervention policy. NOT human data, NOT an experiment with real players, and NOT evidence that the coach helps.

- 窗口：30（该提示 15 / 不该提示 15），对局 9 局
- 提示 = `micro_hint` | `action_hint`；`defer_to_review` 不算打断

## P01 策略（被评测的对象）

- 特征进：局面风险、best-vs-second-best 分差、剩余可行动时间、技能证据、近期提示数、显式偏好、焦点状态
- 动作出：silent | micro_hint | action_hint | defer_to_review
- 硬门控（评分之前）：安静偏好 / 线上竞技 / 窗口失焦 / 状态陈旧 / 刚被点掉 / 后台 / 动画 / 聊天 / 预制 / 已结束 / 每决策一次
- 预算：每局 2 条、45 秒冷却 —— 命中时决定性局面转成 `defer_to_review`，不判死

## 指标

| 策略 | hint precision | necessary recall | unnecessary/match | stale rate | emitted |
|---|---|---|---|---|---|
| P01 四动作策略 | 1 | 1 | 0 | 0 | 15 |
| 固定等待基线 | 0.429 | 0.25 | 0.444 | 0.286 | 7 |

## 逐窗口

| id | match | expected | P01 | 固定等待 | 门控/理由 | stale |
|---|---|---|---|---|---|---|
| w01 | m1 | action_hint | action_hint | fire | decisive-gap |  |
| w02 | m2 | action_hint | action_hint | fire | decisive-gap |  |
| w03 | m3 | action_hint | action_hint | fire | decisive-gap |  |
| w04 | m4 | action_hint | action_hint | silent | decisive-gap |  |
| w05 | m5 | action_hint | action_hint | silent | decisive-gap |  |
| w06 | m6 | action_hint | action_hint | silent | decisive-gap |  |
| w07 | m7 | action_hint | action_hint | silent | decisive-gap |  |
| w08 | m8 | action_hint | action_hint | silent | decisive-gap |  |
| w09 | m9 | action_hint | action_hint | silent | decisive-gap |  |
| w10 | m1 | action_hint | action_hint | silent | critical-risk |  |
| w11 | m2 | action_hint | action_hint | silent | critical-risk |  |
| w12 | m3 | action_hint | action_hint | silent | critical-risk |  |
| w13 | m5 | micro_hint | micro_hint | silent | moderate-risk |  |
| w14 | m6 | micro_hint | micro_hint | silent | moderate-risk |  |
| w15 | m7 | micro_hint | micro_hint | silent | moderate-risk |  |
| w16 | m1 | silent | silent | fire | below-threshold |  |
| w17 | m2 | silent | silent | fire | below-threshold |  |
| w18 | m3 | silent | silent | silent | ended |  |
| w19 | m4 | defer_to_review | defer_to_review | silent | hint-budget |  |
| w20 | m5 | defer_to_review | defer_to_review | silent | cooldown |  |
| w21 | m6 | silent | silent | fire | stale-state | stale |
| w22 | m7 | silent | silent | fire | stale-state | stale |
| w23 | m8 | silent | silent | silent | explicit-quiet |  |
| w24 | m9 | silent | silent | silent | pvp-live |  |
| w25 | m1 | silent | silent | silent | window-unfocused |  |
| w26 | m2 | silent | silent | silent | hint-dismissed |  |
| w27 | m3 | silent | silent | silent | background |  |
| w28 | m4 | silent | silent | silent | animating |  |
| w29 | m5 | silent | silent | silent | chatting |  |
| w30 | m6 | silent | silent | silent | preview |  |

## 读数边界

- 这是离线 fixture：数字说明的是两条规则在同一批标注上的差异，不是「提示帮到了真人」。
- 标注与策略共享同一套产品规则，因此一致性部分是构造使然；能独立读的是**基线对比**与 **stale rate = 0**。
- 基线只隔离「固定等待」这条规则；真实构建里 fall / mistake / dwell 另有分支，所以它的召回不能读成「老版本整体只做到这样」。
- 本评测直接调用 `experience.shouldIntervene`。页面侧的接线在 `src/client/app.js`（本任务不改）；
  目前线上路径里生效的是 `shouldNudge`，它与新策略共用同一套硬门控 + 预算实现。
