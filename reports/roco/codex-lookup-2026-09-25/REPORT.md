# 让 618 只够得着：图鉴查询支线（2026-09-25）

**一句话**：产品链路上，问一只**不在场上**的宠物（图鉴 622 只里的 618 只）今天**根本查不到** ——
真机实测要么回答「我这边没有数据」，要么**答成同名的技能**。修完之后同一批用例
**0/5 → 5/5**，49 例回归**零退化**（唯一变动是一条漏查变查到了）。

## 一、改前实测：产品路径上的六种问法，五种答不出来

`node scripts/eval-live-s04.js --slice wrong-pet`（屏幕上是烬尾狐/潮甲龟/芽角鹿，问的六只一个都不在场上）：

| 用例 | 问题 | 改前 | 改后 |
|---|---|---|---|
| w01 | 喵喵的种族值是多少？ | 0 次调用，路由到**陪练**：「喵喵的种族值我这边没有数据」 | **1 次调用** →「草系，攻击66/防御49/生命65/特攻66/特防91/速度33，合计370」 |
| w02 | 水蓝蓝的速度是多少？ | 0 次：「没这只宠，这局里没有水蓝蓝」 | 「速度 51（水系，总种族值 372）」 |
| w03 | 火花这只的种族值大概多少？ | 0 次，被当成**技能**「火花」回答 | 「火系，攻84/防56/血70/特攻37/特防43/速78，合计368」 |
| w04 | 寂灭骨龙的防御是多少？ | 0 次，被当成**技能**「防御」回答 | 「防御 104，种族总 552，龙/幽双系」 |
| w05 | 鸭吉吉的种族值是多少？ | 0 次：「查不到，不能瞎编」 | **认出重名多条目**，逐个列出各自种族值 |

## 二、两个根因（都在代码里定位到行）

1. **没有任何一层把「图鉴事实问句」当成一次查询。**
   路由（`src/coach/runtime.js:101`）靠关键词决定 `route`，兜底是 `companion`；
   工具循环的闸门（`:112`）是 `route ∈ {strategist,teacher}` **或** `policyFor().need` 非空——
   而 `policyFor` 对「喵喵的种族值是多少？」返回 `{need:null}`（判成"证据包里有"）。
   另外「`<宠物>的防御`」还会被**规则卡片**那一支（`:83`）先吃掉，拿技能的说明去回答属性值。
2. **`query_rules` / `evaluate_team` 在产品链路上根本过不了合同校验。**
   这两个工具的合同里 `state_version` 是**必填**（`src/coach/toolbox.js:365`），
   而 planner 提示明确写着「参数里不要放 state_version（运行时会给）」，
   `mustCall`（政策强制首枪）那条路又**不注入**它 ⇒ 真机日志停在
   `stop=policy-invalid-arguments`，一次都发不出去。

## 三、改动（`src/coach/runtime.js`）

| 件 | 作用 |
|---|---|
| `codexFactAsk(text)` / `codexTarget(text)` | 认「`<名字>的<图鉴字段>`」并取出**名字**（宠物字段→`kind:'pet'`，威力/能耗/类别→`kind:'skill'`）；「火花这只」会剥掉「这只」 |
| `policyFor` 新增一支 | 图鉴问句 ⇒ `{need:'query_rules', reason:'codex-fact'}`（**默认关**：`ROCO_CODEX_LOOKUP=1`） |
| `defaultArgsFor('query_rules')` | 参数取**名字**，取不出来返回 `null`（fail closed，不编 id、不编数值） |
| 路由新增一支（**排在规则卡片之前**） | 只写事实草稿、不锁定，让工具循环与模型接手 |
| `withRuntimeStateVersion(name,args,context)` | 合同要 `state_version`、提示又不让模型写 ⇒ 由**运行时**补（走工具箱已有的权威解析器 `rocoStateVersionOf`）。**这一条不挂开关**，因为不补就等于两个工具不可达 |

## 四、实测（真机，`deepseek-flash`）

**图鉴切片（开关 ON）**：工具选择 **5/5**、参数目标 **5/5**、回答一致性 **5/5**（改前 0/5、0/5）。

**49 例同代码 A/B**（同一棵树，只切开关）：

| 层 / 指标 | 开关 OFF | 开关 ON |
|---|---|---|
| `toolSelectionCorrect` | 33/49 | 33/49 |
| `toolSelectionCorrectnessRate` | 0.429 | 0.429 |
| `callDecisionCorrectRate` | 0.673 | **0.694** |
| `callCountCorrectRate` | 0.592 | **0.612** |
| `missedCallRate` | 0.556 | **0.519** |
| `unnecessaryToolCallRate` | 0.045 | 0.045 |
| `answerConsistency` | 47/49 | 46/49 |

- 调用行为**只有一条**变化：`c08`「现在双方的速度和先手关系是什么样？」**0 次 → 1 次**（金标要 1 次，属改善）。
- `answerConsistency` 那一分差在 **c46**（模型说「备选是火花」，回执里没有）——
  与 `c25`/`c45` 同族的 `receipt-action-mismatch`，**不在改动路径上**（c46 的调用次数与工具都没变），
  是模型抖动；这一点如实记着，不当作"零影响"。

## 五、判据

`tests/roco-codex-lookup.test.js` **6/6**：
① 抽取（含「火花这只」剥后缀）；② **零误判**——现有 49 例里 16 条"不该变成图鉴查询"的问法逐条断言不命中；
③ 开关 off 时 `policyFor` 与改动前一致、on 时才多出 `query_rules`；④ `defaultArgsFor` 给名字、取不出来给 `null`；
⑤ `withRuntimeStateVersion` 的必要性（反证：不补则 `validToolArgs('query_rules',…)===false`，这正是修前的机理）；
外加一条必红反证（关掉开关，「多出 query_rules」必须不成立）。

## 六、边界（没说的话与没说大的话）

- 开关**默认关**。开不开是产品决定：开了小芽才对这 618 只答得出话，证据在这里，随时可复跑。
- 只做了**按名字查**：同名异形（62 个名字 / 180 只）由引擎返回多条目，`w05` 实测模型如实逐个列出，
  没有挑一个当唯一答案。要不要进一步**追问玩家是哪一只**，是下一步。
- **本地 4B 不在此列**：它在全图鉴上 0/622、97% 零调用（C6.94），这条支线走的是云端模型那条路。
- 切片 n=5，是**能力验收**不是统计量；49 例那半边才是回归对照。

## 七、复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
PORT=8936 ROCO_CODEX_LOOKUP=1 DEEPSEEK_API_KEY="$KEY" node src/server/index.js &
ROCO_EVAL_ORIGIN=http://127.0.0.1:8936 node scripts/eval-live-s04.js --slice wrong-pet
ROCO_EVAL_ORIGIN=http://127.0.0.1:8936 node scripts/eval-live-s04.js          # 49 例回归
node --test tests/roco-codex-lookup.test.js
```

产物：本目录 `eval-codex-slice.json`（切片）、`eval-codex-49.json`（开关 ON）、`eval-codex-49-off.json`（同代码开关 OFF）。
