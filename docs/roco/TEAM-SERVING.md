# RC-306 分段 Serving 契约（team-serving）

> 代码：`src/coach/team-serving.mjs`
> 守卫：`tests/roco-team-serving.test.js`（11 条，含 6 条必红方向）
> 度量：`node scripts/roco/measure-team-serving.mjs`（`npm run roco:serving`）→ `reports/roco/team-serving/serving.json`

## 这条契约回答什么

v3 纠偏口径：**在线 3 秒内禁止批量模拟；线上做召回 → Beam 补全六宠 → Ranker 排序 → 证据解释，
300ms 给结构化初判、3s 内给自然语言，超时保留短结论**。

在这之前，仓库里只有**各段自己的耗时**（RC-303 的 `LATENCY_BUDGET_MS` 与 P95 测量），
没有任何地方回答三个交付问题：

| 问题 | 契约的回答 |
|---|---|
| 「初判」什么条件下才允许发出去？ | 标了 `required_for_first` 的段**全部成功**、且没有踩过 300ms 预算，`first` 才不是 null；否则 null + 逐条 reason（`STAGE_FAILED` / `STAGE_SKIPPED` / `OVER_FIRST_BUDGET` / `NO_REQUIRED_STAGE`） |
| 超时了怎么办？ | `full = null`、`degraded = true`、`skipped[]`/`late[]`/`failed[]` 逐段点名；短结论**只用预算内成功的段**拼；一段都没成就如实写「给不出短结论」 |
| 谁来保证页面不会「算不出来却带着值」？ | 本模块只搬运段的结果，**缺失恒为 null**；自己不补 0、不补默认值、不造强度 |

## 实测（`reports/roco/team-serving/serving.json`，20 次）

| 项 | 实测 | 预算 |
|---|---|---|
| 初判（索引 + 召回）P95 | **18.8 ms** | 300 ms |
| 完整解释（+ Beam/排序 + 证据）P95 | **37.5 ms** | 3000 ms |
| 正常路径 degraded 次数 | **0 / 20** | 0 |

## 负向控制（这是本轮的关键判据）

全快路径本来就不会出问题，所以「超时保短结论」必须**真的跑一遍**才算证明过。
度量脚本用真实时钟 + 真实契约做了两次注入，并把结果写进报告：

| 注入 | 期望 | 实测 |
|---|---|---|
| 必需段忙等 350ms（> 300ms 初判预算） | 初判为 **null**，不许发半截 | `first = null`，问题里带 `FIRST_ANSWER_UNAVAILABLE` |
| 某段忙等 600ms（总预算压到 400ms） | 完整解释为 **null**、后续段**不再开始**、短结论只由成功段拼 | `full = null`、`degraded = true`、`never_runs` 状态 `skipped`、短结论含「第一段成功。」 |

另外段一旦**开始**就无法中断，所以「跑完了但已越过总预算」被如实记成 `late`：
它的值是真的，但**不算进完整解释、也不进短结论**（短结论在 3s 那一刻就该发出去）。

## 只发模式合法动作（serving 边界的第二道闸）

第一道闸在引擎里（RC-105：`legal_actions` 按 `actions.allowed_kinds` 裁剪、越界抛错）。
`modeActionProblems(actions, declaration)` 判的是「交给页面的载荷」有没有把不该出现的 kind 带出来：

- `forbidden_kinds` 里的 kind 出现 ⇒ `[FORBIDDEN_KIND_LEAKED]`；
- 没在 `allowed_kinds` 里声明且不许未知 ⇒ `[UNDECLARED_KIND_LEAKED]`；
- 声明缺失 / `allowed_kinds` 为空 / allowed 与 forbidden 有交集 ⇒ fail closed（不给「没有声明就当没事」留口子）。

度量脚本的声明**取自真配置** `data/roco/rulesets/mobile-s4-candidate-v3.json` 的 `actions` 块
（不是手写样例）：合法样本 0 条问题，混进 `item`/`escape` 的样本 2 条问题。

## 接线（第 96 轮）：工坊路由是第一个真实消费者

`GET /api/roco/workshop` 多了 `stage` 参数（白名单里的**交付参数**，不是组队字段）：

| 请求 | 跑哪几段 | 回执 |
|---|---|---|
| `stage=first` | 只跑 `plan`（召回 → 渐进候选 → 缺口 → 槽位/候选/Coach 摘要） | `axes=null`、`axes_status='not_requested'`、`serving.first.kind='structured_first'`、`serving.full=null` + `full_withheld='NOT_REQUESTED'`、`degraded=false` |
| 省略 / `stage=full` | `plan` + `evidence_and_counterfactual`（缺口装配 + 五轴 + 最小替换） | 与接线前同形状，外加 `serving.full.kind='full_answer'` |
| 别的值 | —— | `400` 点名「stage 只能是 first 或 full」（**不静默当 full**） |

两条语义**必须分开**，这是这一节最重要的约定：

- `full_withheld='NOT_REQUESTED'` = 调用方**主动只要初判**（不是降级）；
- `degraded=true` = 超时/失败真的丢了段（`skipped`/`failed`/`late` 逐段点名）。

真实路由实测（`reports/roco/team-serving/serving.json` 的 `route_stages`）：
初判只跑 `plan` 一段、`axes` 确实是 `null`；完整解释两段都跑、五轴 5 条；
两次都在 300ms / 3s 预算内（本地 P95 两位数毫秒）。

## 如实边界

- 度量里的四段都是**规则与统计计算**，没有 LLM；`3s` 那一格目前是**上界**而不是实测瓶颈
  （真实 LLM 参与时的延迟要等云端/本地推理臂接入后再量，那属于 P2 与 RC-603）。
- 契约只保证「分段与超时语义」，**不保证**每段的数字本身正确 —— 那是 RC-302/303/304 各自的判据。
- 还没有接线：`GET /api/roco/workshop` 仍是一次性同步返回。把它改成走本契约（先初判、后完整解释、
  超时降级）是下一步，需要服务端与页面一起改（RC-306 的接线部分）。
