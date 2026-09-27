# 288 条任务集上的两个家族：`rules_lookup` 与 `roster_constraint`（2026-09-25）

> 目标书点名的缺口：「4B/云臂在 622 只图鉴上做检索与查询（`rules_lookup` 12/72、
> `roster_constraint` 0/24 用**检索+工具**补，不再加训）」。这一份把这两族今天的实测数字
> 与**每一处失败的根因**写清楚，含一条负结论与三次我自己的口径错误。

## 0. 先纠正目标书里那两个数字的归属

`rules_lookup 12/72` / `roster_constraint 0/24` 是 **288 条轨迹任务集**上的
「冻结提示 + 单步」基线（出处 `scripts/roco/agent-trajectories.mjs:712`），
**不是** `roster_constraint` 的云臂数字。实测复现：对照臂（冻结提示）`roster_constraint` = **3/24**
（`docs/roco/SHADOW-REPLAY.md:53` 里也是 3/24；0/24 是 SFT v1 适配器那条线）。

## 1. 图鉴家族 `rules_lookup`（72 条）

| 臂 | 通过 | 说明 |
|---|---|---|
| 冻结提示（对照） | **12/72** | 目标书引用的基线 |
| 生产提示 · **单步** | **26/72** | 加了图鉴规则之后 |
| 生产提示 · **多步（产品的真实循环）** | **46/72** | 14 条真的走了两步 |

**第三行才是产品路径的忠实还原**：产品的 `gatherAgentEvidenceOnce` 是**多步 + 回执**（最多 4 步），
而 `--arm deepseek_product` 用的 `localModelPlanner` 是**单步**（它不看回执）。
⇒ 我先前用单步臂量生产提示，**系统性低估**了它；"必须两步"的题（学习表只认 `pet_id`）
在单步臂上**永远不可能过**。为此新增忠实臂 `--arm deepseek_product_agent`（同提示 + 回执/多步）。

## 2. 阵容家族 `roster_constraint`（24 条）

| 臂 | 通过 |
|---|---|
| 冻结提示（对照） | 3/24 |
| 生产提示（改前） | **0/24** |
| 生产提示（加了「阵容两条」） | **12/24** |

失败根因（改前 24 条里）：12 条问「第三只换成圆号鱼好不好？」——**一次都没调** `compare_team_change`；
7 条调了 `evaluate_team` 但**漏了 `locked_pet`**（hints 里明明给了）。
加的两条规则正是照这两处写的：`evaluate_team` 要原样带上 `team` 与 `locked_pet`；
「换成 X 好不好 / 换谁更好」用 `compare_team_change`。
**剩下 12 条仍是"不调"**（`compare_team_change` 的要求没被触发）——如实留着。

## 3. 每一处失败的根因（`rules_lookup` 58 条失败）

| 条数 | 失败原文 | 根因 | 今天动了没有 |
|---|---|---|---|
| 23 | 没有调用 `query_rules` | 「应对」术语 ×12 + 「规则集是哪个版本」×11 —— 前者**工具根本答不了**（见 §4） | 未解决 |
| 12 | `type_multiplier` 参数不匹配 | 模型写 `attack_element:"龙"`，引擎要 `"龙系"` ⇒ 引擎 `unsupported_effect` **直接拒** | **已修**（12 → 0） |
| 11 | `learnset` 要 `pet_id` | 真·多步：查完名字拿到记录就停了 | **已修**（多步臂） |
| 10 | `pet` 要 `pet_id` | 模型按**名字**查（产品自己的图鉴路径就是这么查的、确实回数据） | **口径问题**，非能力 |
| 2 | `skill` 要 `name` | 参数装配 | 未解决 |

**「名字 vs id」是口径问题，有硬证据**：产品自己的 `defaultArgsFor('query_rules')` 注释写着
「图鉴查询的参数**从问题里取名字**：引擎按名字查，查不到就 fail closed（不编 id、不编数值）」，
而玩家路径验收（`roco:coach-agent-acceptance` ①）用这条路**真拿到了数值**（「合计 370」）。
⇒ 要求"必须带 `pet_id`"量的是**写法**，不是能力或诚实。与契约 A 的 0/120 同源。

## 4. 一个新发现的能力洞（下一步）：术语**没有名字路径**

引擎 `service.py:_answer_term` 只认 `term_id`（`"查术语需要 term_id / id"`），
`kind=term` 在合同里也**只允许 `term_id`**（`toolbox.js` 的 `validToolArgs`）。
⇒ 「『应对』这条术语是怎么定义的？」这类问题**当前工具答不了**（模型猜 `term_id` 是不可能的），
而玩家会问。要补就得同时动：引擎 `_answer_term` 支持按名字查 + 合同允许 `name` + 判据。
这是**玩家看得见**的缺口（不是内部整洁度问题），列为本轮之后的下一步。

## 5. 一条负结论（留痕）

49 例上唯一一条回退是 **c31**（「对比这回合两个选择的伤害，再引用连续换宠的反例」，金标要 2 次调用）。
我为此加了一条「**多来源的问题要查到齐**」，实测**更差**：
工具选择 .429 → **.408**、`cat1` .471 → **.412**，而 c31 **仍然是 1 次调用**（只调了 `search_rules`）。
⇒ **撤回**，不留在提示里。**"看起来对症"的规则必须量过才算数。**

## 6. 49 例上的代价（四档对照，同一份代码只切提示）

| 指标 | `off` | 两规则 | **最终（出货）** | +多来源（已撤回） |
|---|---|---|---|---|
| 工具选择正确率 | 0.388 | 0.449 | **0.429** | 0.408 |
| 调用次数正确率 | 0.571 | 0.633 | **0.612** | 0.592 |
| 不该查却查了 | 0.045 | 0.045 | **0.045** | 0.045 |
| 漏查率 | 0.519 | 0.519 | 0.519 | 0.519 |
| 有据回答率 | 0.918 | 0.918 | 0.918 | 0.918 |
| `cat1` | 0.353 | 0.471 | **0.471** | 0.412 |
| `cat2`（不该查） | 1.000 | 1.000 | **1.000** | 1.000 |

**「最终」比「两规则」低 1 条**（21/49 vs 22/49，两次独立跑都是 .429 ⇒ 不是抖动），
而它在两个真实家族上是 **+32 条**（rules_lookup 14→46）与 **+9 条**（roster 3→12）。
选择「最终」的理由是**玩家价值**：家族题就是玩家真会问的话（学习表 / 阵容 / 换人 / 倍率）。
**"不该查却查了"四档全部 0.045 不变**、有据回答率不变 ⇒ 加规则没有把"少查"换成"乱查"。

## 7. 我这一轮的三次口径错误（都值得记）

1. 用 `row.tool_calls` 统计调用次数，而字段叫 **`trace`** ⇒ 把四条臂读成"一次都不调"（同上一轮那次）。
2. 差一点又犯：比较两次 49 例产物时用了不存在的字段名，`undefined !== undefined` 恒假 ⇒
   得出"逐例零差异"，与汇总指标（.449 vs .429）矛盾。**先打印字段名**才发现真差异是 1 条（c31）。
3. 用**单步**臂量生产提示，而产品是**多步**循环 ⇒ 系统性低估（26/72 vs 46/72）。

## 8. 复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"; export DEEPSEEK_API_KEY="$KEY"
D=reports/roco/roster-agent-2026-09-25
node scripts/roco/shadow-replay.mjs --arm deepseek_product_agent --category rules_lookup       --out $D/agent-rules.json
node scripts/roco/shadow-replay.mjs --arm deepseek_product_agent --category roster_constraint  --out $D/agent-roster.json
node scripts/roco/shadow-replay.mjs --arm deepseek_product       --category rules_lookup       --out $D/final2-rules.json
node scripts/roco/shadow-replay.mjs --arm deepseek               --category roster_constraint  --out $D/control-roster.json
```
产物都在本目录下（`control-roster.json` / `product-rules.json` / `product-roster.json` /
`after-rules.json` / `after-roster.json` / `final-rules.json` / `final-roster.json` /
`final2-rules.json` / `agent-rules.json` / `agent-roster.json` / `after-catalogB.json`），
报告里每个数字都能在其中逐条核对。
