# TEAM-COMPARE —— RC-304 未知对手下的队伍比较（能算的算、算不出的 fail closed）

> 代码：`src/coach/team-compare.mjs`（纯函数 + 显式注入数据，**在线不调引擎**）
> 机器可读报告：`reports/roco/flagship-upgrade/rc-304-team-compare.json`
> 测试：`tests/roco-team-compare.test.js`（14 组，含 **27 条必红反证** + 3 组负向/正向控制）
> 上游：RC-301 `src/coach/team-request.js`（校验过的请求）、RC-302 `src/coach/team-gaps.js`（缺口诊断与台账六级）、
> RC-303 `src/coach/team-candidates.mjs`（候选生成）
> 环境先验：`data/roco/meta-prior/v1.json`（**只读**；`docs/roco/META-PRIOR.md`）
> 设计依据：`/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §4–§6；
> 路线图：`08-IMPLEMENTATION-ROADMAP.md` 的 RC-304 / RC-305

---

## 1. 一句话

匹配前没有具体敌队，能评价的只有「这支队伍**对版本环境分布**的表现」。
「对环境的期望」必须先有**分母**，而分母是「对手分布」。本仓没有任何真实对局数据
（没有录屏、没有匿名对局、没有离线联赛产物、没有 matchup bank），所以分母只有两种合法来源：

1. **声明假设**（`source: "assumption"`）：先验逐条写下「每个已识别体系等权 1/K」，
   带 `basis`（`kind` / `denominator` / `recomputable_from`），可复算、可替换，**不许挂 `sources[]`**；
2. **实测分布**（`source: "measured"`）：逐条带 url / 仓内文件 + 日期。

这两档到位时，**五轴全部真算**（`available:true`）。第三档是 `unknown`：连声明假设都没有，
四轴回到 `available:false` + 点名缺什么（`value: null`，**不是 0**）。

**没有胜率，也没有 0。** 两档的置信等级不同、写法不同，绝不混用：

```text
assumption 档 → 四轴 confidence = 'ENGINE_HYPOTHESIS'
                分母 = 声明假设（先验的 basis，可复算）
                相对分 / 容错 = RC-302 的**结构分**（队伍级，ENGINE_HYPOTHESIS）
measured 档   → 四轴 confidence = 'CROSS_SOURCE_SUPPORTED'
                值 = 注入分布自带的 relative_score / tolerance（离线联赛产物，逐条带来源）
unknown 档    → available:false + value:null + unknown_reason
```

---

## 2. 五轴：定义、公式、值从哪来

| 轴（输出键） | 13 号文档 §4 / 先验字段 | 定义与算法 | 现在（磁盘先验 = assumption 档） | 值依赖什么 |
|---|---|---|---|---|
| `environment_value` | `expected_meta_value` | `Σ(relative_score × 占比) / Σ占比`：对每个可识别体系求相对表现的加权均值，权重 = 该体系在环境里的占比 | **能算** | 占比（声明假设的分母）+ 逐体系相对分 |
| `worst_archetype` | `worst_archetype` | 逐体系相对表现里**最差**的那一个（含 `archetype_id` / `relative_score` / 权重） | **能算** | 同上 |
| `matchup_spread` | `matchup_spread` | `max(relative_score) − min(relative_score)`：极差越大越说明严重依赖撞到特定阵容 | **能算** | 逐体系相对分 |
| `execution_tolerance` | `execution_tolerance` | `Σ(tolerance × 占比) / Σ占比`：次优操作下的相对表现 | **能算（下界代理）** | 占比 + 逐体系**结构短板** |
| `coverage_confidence` | `coverage_confidence` | 三个可对账因子的均值：`criterion`（缺口里没被台账标 UNKNOWN 的条数比例）、`evidence`（带完整机器证据的缺口比例）、`build_data`（有具体 build 数据的成员比例） | **能算** | 只吃 build / 台账数据，**不依赖对手分布** |

四轴的 `value` 形状（读的人一眼能分清「不知道」与「知道」）：

```text
available:false  →  value: null      + unknown_reason（点名缺什么）+ confidence: 'UNKNOWN'
available:true   →  value: 数值/对象  + unit（量纲）+ value_numbers（逐条声明单位）
                    + distribution_kind（'assumption' / 'measured'）
                    + structural_basis（assumption 档：逐体系的判据、分子 / 分母、重算入口）
```

两队的值都留在 `axis.teams[team_id]` 里（不合并、不平均）；
比较视角在 `axis.comparison`（`delta` / `winner` / `why`）。
`coverage_confidence` 是自我描述的数，**取两队的下界**（较保守的那一边），
`worst_archetype` 取更差的一边（含 `criterion` / `structural` 引用，说明它按哪条判据算）。

`unit` 与 `value_numbers[].unit` 一律是「相对分（0～1 的序数标度，不预测胜负）」这类**中性量纲**：
判据（`unitProblems()`，`BANNED_UNIT_WORDS = ['胜率', '概率', '百分比', '%']`）
会扫**两个量纲字段**，有就判红——量纲是伪精确最常见的藏身处。

### 相对分是什么，不是什么

- 是：0～1 的**序数标度**，只在**同一份注入分布**内可比（谁高谁低、差多少）。
- 不是：胜率、强度分、上分效率、榜单名次。五轴里没有任何一个口径的**定义**是「赢的概率」。

---

## 3. assumption 档的结构分：队伍 × 体系，怎么算出来的

`relative_score` / `tolerance` 是**队伍级**的量，**不许写进版本先验**（先验只带占比）。
assumption 档下它们由本模块按**体系自己声明的** `archetypes[].feature_axes[].criterion`
从 RC-302 的缺口诊断里算出来（`structuralCriteriaScores()`；分子 / 分母都是可复算计数，
没有阈值、没有拟合参数、没有第二份权重表）：

| 判据 | 结构分 = 分子 / 分母 | 依据（RC-302 字段） |
|---|---|---|
| `coverage` | `1 − Σ|weak_members| / Σ(成员槽位)` | `coverage.unresisted.*.value.{weak,resisting,neutral,unknown}_members`；一条缺口都没有时要求 `facts.registered_attack_types > 0`（证明扫描跑过） |
| `synergy` | `1 − unanswered_weaknesses / weaknesses_total` | `synergy.summary.value`（并与 `synergy.unanswered_weakness.*` 的条数**交叉核对**，不一致就不给数） |
| `respond` | `|variants_in_team_learnsets| / 3` | `respond.effect_unverified.value`，分母 = RC-302 自己声明的 `RESPOND_VARIANTS`（3 种应对）；与 `respond.variant_missing.*` 条数交叉核对 |
| `energy` | `|{成员 : zero_cost_moves ≥ 1}| / |members|` | `energy.build_curve.value.members[].zero_cost_moves` |
| `speed` | `|distinct speed_tier| / |members|` | `speed.team_tiers.value.members[].speed_tier`（梯度铺开程度） |
| `pivot` | `|members_with_tool_in_build| / |队伍成员|` | `pivot.tool_coverage.value` |
| `cost` | `validated_members / team_size` | `cost.build_support.value` |

合成（每个体系各算一份）：

```text
relative_score(team, 体系) = mean(该体系 feature_axes[].criterion 上的结构分)   # 等权，分母 = 判据条数
tolerance(team, 体系)      = min (该体系 feature_axes[].criterion 上的结构分)   # 结构短板 = 次优操作余量的下界代理
```

**缺任何一个判据的输入 ⇒ 整轴 fail closed**（`NO_STRUCTURAL_SIGNAL`，点名缺哪个判据），
不拿别的数据顶替、不给 0。轴产出里带 `structural_basis`：逐体系的判据、每个判据的值、
`relative_score` / `tolerance`，以及先验的 `basis`（分母 + 重算入口）——只报一个数没法对账。

### 声明假设的牙（判据 ⑨ 的必红方向）

| 改坏方式 | 期望结果 |
|---|---|
| 把 assumption 行的 `basis` 整条删掉（`value` 保留） | 整份分布退回 `unknown`，四轴 `available:false`（`ASSUMPTION_BASIS_MISSING`） |
| 给 assumption 行挂 `sources[]`（伪装 measured） | 同上（`ASSUMPTION_CARRIES_SOURCE`） |
| 把某条 `value` 改成 `0.5`（合计 ≠ 1） | 同上（`NO_PARTITION`，容差 0.001） |
| `confidence` 不是 `ENGINE_HYPOTHESIS` / `unit` 不是 `share` / `notes` 太短 | 同上（`ASSUMPTION_BASIS_MISSING`） |
| 分母 K 改成 K+1（每行 1/(K+1) + 一条合成体系） | 占比与权重**必须跟着变**（`weight 0.142857 → 0.125`），四轴仍可用 |
| 把四轴整体退回 unknown（假装算不出来） | `NO_STRUCTURAL_SIGNAL`（能算的必须算出来） |
| 抹掉轴上的 `structural_basis` | `STRUCTURAL_BASIS_MISSING` |

**一个不带依据的裸数字不是 assumption，是编造**：整份分布退回 unknown，而不是照用这个数。

---

## 4. 实测样例（磁盘先验 assumption 档，6 支真实队伍）

`reports/roco/flagship-upgrade/rc-304-team-compare.json`：

```text
分布形态：source = assumption（7 个体系各 1/7，basis.denominator = 7，合计 0.999999）
重算入口：scripts/roco/build-meta-prior.mjs（确定性、无挂钟字段）
替换通道：赛季面板导出 / 匿名对局记录 / 离线联赛产物（须带 url 或仓内文件 + 日期 + 台账等级）⇒ source 改 measured

rc304-six-a vs rc304-six-b：
  environment_value    delta 0.044056  winner rc304-six-a
  worst_archetype      wing_king_flyer（相对分 0.416667，权重 0.142857）
  matchup_spread       delta 0.035715  winner rc304-six-b
  execution_tolerance  delta 0.051562  winner rc304-six-a
  coverage_confidence  0.848485 / 0.848485
```

`rc304-six-a` 这一队的七个结构分（分子 / 分母，来自 RC-302 的真实缺口）：

```text
coverage 0.791667 = 5/24     synergy 0.772727 = 5/22     respond 1 = 3/3
energy   1        = 6/6      speed   0.5      = 3/6      pivot   0 = 0/6
cost     1        = 6/6
```

> **⚠ 口径注（2026-09-28 补，旧读数不删）**：上面这段是 **2026-09-28 之前**那一次跑的读数，
> 当时冻结层是 **48 只**。人类这一轮拍板「所有精灵实装」后冻结档扩到 **542 只**
> （可玩层 530 + 基线 12），上游报告 `reports/roco/flagship-upgrade/rc-304-team-compare.json`
> **已经跟着重生成**：六支队的 `dimension_unknown_counts` 现在是
> `{coverage: 4~10, energy: 1, pivot: 1, respond: 1, speed: 2, synergy: 1}`，
> `rc304-six-a` 的 `coverage_confidence` 也变成 **0.809524**（上面那段里是 0.848485 的配对读数）。
> 所以「`pivot = 0/6`」**不再是当前读数**（现在每队的 `pivot` 未知数是 1）——
> 旧值留在原地存档，当前读数一律以报告 JSON 为准。
> ⚠ 报告内部仍有一句写死「冻结迁移层只有 48 只（RC-302 的域上限）」，那是
> `src/coach/team-compare.mjs` 里的输出文案，本轮**没有**动 `src/**`。

`pivot = 0/6` 是真的：冻结层里这 48 只的**具体配招**都没有换入/离场手段
（`pivot.tool_coverage.value.members_with_tool_in_build = []`）——所以两个以 `pivot` 为判据的体系
（`wing_king_flyer` / `sandstorm_weather`）相对分偏低。这不是模型偏好，是可复算的计数。

### measured 档的对照样例（证明接口不是恒 unknown）

测试注入一份**构造**的 `measured` 样例（`buildMeasuredDistributionSample()`，
每条来源都标 `measured: false`，**不是版本数据**）：

```text
注入样例：poison_stack 0.35/0.30/0.80、ice_control 0.25/0.72/0.90、fighting_press 0.40/0.55/0.60
（三列 = 占比 value / 相对表现 relative_score / 操作容错 tolerance）
environment_value    = 0.505   （判据独立重算 0.505，逐位相同）
worst_archetype      = poison_stack（relative_score 0.30，权重 0.35）
matchup_spread       = 0.42    （0.72 − 0.30）
execution_tolerance  = 0.745   （加权均值）
coverage_confidence  = 0.851852（**不随注入分布变**：它只吃 build 数据）
```

如果 `measured` 分布下某一轴仍然 unknown ⇒ `MEASURED_NOT_WIRED`（红）：
**fail closed 写成「永远 unknown」也是一种骗人。**

### 覆盖置信的实测样例（6 支真实队伍，`rc-304-team-compare.json#teams[]`）

```text
队伍        缺口数  criterion  evidence  build_data  覆盖置信  confidence
rc304-six-a   27     0.555556     1         1        0.851852  COMMUNITY_CURRENT
rc304-six-b   50     0.640000     1         1        0.880000  COMMUNITY_CURRENT
rc304-six-c   43     0.697674     1         1        0.899225  COMMUNITY_CURRENT
rc304-six-d   24     0.583333     1         1        0.861111  COMMUNITY_CURRENT
rc304-six-e   23     0.565217     1         1        0.855072  COMMUNITY_CURRENT
rc304-six-f   23     0.565217     1         1        0.855072  COMMUNITY_CURRENT
```

`evidence` 与 `build_data` 在这批数据上都顶到 1（每条缺口都有机器证据、每只成员都在冻结层里），
所以区分度全部来自 `criterion`；`criterion` 是**缺口条数**的比例，不是维度个数
（六个队都有同样七个维度，按维度算会让所有队伍拿到同一个数）。
把 build 数据整体抽掉后覆盖置信降到 `0.506667`——这条反向控制证明它真的在读 build 数据。

---

## 5. 三档判定：`resolveDistribution()` 是唯一判定点

模块的分布判定**两套形状都认**：

| 形状 | 出处 | 判定 |
|---|---|---|
| `metaPrior.distribution_source` | RC-304 任务书的顶层判定 | 写了 `unknown` 就整份 unknown |
| `metaPrior.distribution[] {source, value, sources[], basis}` | 先验 v1.json 的实际形状 | 顶层没写就逐条推断 |

判定顺序（`measured` → `assumption` → `unknown`）：

```text
measured    顶层非 unknown、每条 source='measured'、value 非 null、带可核对来源（url/仓内文件 + 日期）
assumption  顶层非 unknown、每条 source='assumption'、value ∈ (0,1]、basis 齐全
            （kind='uniform-over-candidate-universe' + denominator>0 + recomputable_from）、
            unit='share'、confidence='ENGINE_HYPOTHESIS'、notes 够长、
            **sources 为空**、全部 value 合计 = 1（容差 0.001）
unknown     其余（含任何一条 source='unknown' / value=null / basis 不全 / 合计不是 1）
```

`measured` 档下 `relative_score` / `tolerance` 缺失时的 fail closed 码不变：
`NO_RELATIVE_SCORE` / `NO_EXECUTION_SAMPLE`（assumption 档下它们由结构分供给）。

---

## 6. 为什么没有胜率

- 13 号文档 §4 的六个口径里**没有一个是胜率**：它们分别是期望、最差体系、尾部稳健性、
  散度、容错、覆盖置信。§4 还明确写「不输出伪精确胜率」。
- 胜率需要真实对局标签 + 版本化 ranker。本仓两者都没有：
  `ranker_status` 只能是 `missing`（RC-303 同一条纪律），比较退化成注入分布上的**相对分**。
- 判据把这件事做成结构性的：`BANNED_CLAIM_KEYS`（含 `win_rate` / `meta_share` / `pick_rate` …）
  与 `BANNED_CLAIM_WORDS`（含 `胜率` / `强势` / `必带` / `T0`…）扫**值承载字段**与渲染文本，
  命中即 `PSEUDO_PRECISION`（红）。**键名检查不受否定语境豁免**：把胜率藏在一个自定义键里照样红。
- 否定语境要留一条口子：判据文本必须能写「本模块不产出胜率」，否则判据会逼着实现方删掉
  最该保留的那句声明。所以扫描范围**只排除** `definition` 与 `criteria`（判据正文），
  其余字段一律照扫；命中点前 18 个字符里有否定词（`不是 / 不许 / 未核实 / 不知道 / …`）时放行。

---

## 7. 最小替换（13 号文档 §6 的「一个最小替换方案」）

```js
minimalReplacement({team, metaPrior, candidates, gapsByTeam})
```

- **恰好一个**方案：`replacement.out`（换下哪一只）+ `replacement.in`（换成哪一只）。
  返回数组 / 多方案 / 没有 `why` ⇒ `REPLACEMENT_SHAPE`（红）。
- 两条**可复算**的结构判据（都不是强度判断）：
  1. 换下谁：该队「无人承接弱点」贡献最多的成员（来自 RC-302 的
     `synergy.unanswered_weakness.*` 条数；同分用登记键字典序 tie-break）；
  2. 换成谁：候选**自己声明**的 `covers_types` 与「队里没人能接的攻击系别」
     （RC-302 的 `coverage.unresisted.*`）求交集，取交集最大者（同分同样用字典序）。
- **分布不是 measured 时不许判「哪个更好」**：`confirmed_by_distribution: false`，
  `why` 只写结构理由并**明确说不知道**换谁在这个版本里更强；
  写成「换它更好」或 `confirmed_by_distribution: true` ⇒ `REPLACEMENT_OVERCLAIM`（红）。
- 没有候选能对接任何缺口时如实 `replacement: null` + 解释，**不编**一个方案。

候选要能进这条通路，必须自己带结构声明（`covers_types` / `has_build`）。
没有声明的候选**不会被猜**——这是「不替候选编一个属性表」的 fail closed。

---

## 8. 与 RC-303（候选生成）、RC-305（工坊 UI）的分工

| | RC-303 `team-candidates.mjs` | **RC-304 `team-compare.mjs`** | RC-305（工坊 UI） |
|---|---|---|---|
| 回答的问题 | 「下一只该选谁」 | 「这两支队在版本环境里差在哪」 | 「把上面两条摆到页面上」 |
| 输入 | 已选 0～5 只 + 全量候选宇宙 | 两支队伍 + 环境先验 + 缺口诊断 | 前两者的产出 |
| 输出 | 召回 20～50 → Beam 六宠 → Top-K；2～5 只时恰好三个下一只 | 五轴（assumption / measured 档全部可算）+ 恰好一个最小替换 | 交互与呈现 |
| 排序口径 | 规则打分（`ranker` 缺失 ⇒ `missing`） | 注入分布上的相对分（`ranker` 缺失 ⇒ `missing`） | 不引入新口径 |
| 边界 | 不做缺口诊断、不做替换、不做期望值 | 不做候选召回、不做 Top-K、不做 UI | 不做口径、不算数 |
| 共享 | RC-302 的索引与判据（**不复制第二套语义**） | RC-302 的 `CONFIDENCE_LEVELS` / `RESPOND_VARIANTS` / 诊断；RC-303 的候选结构声明 | — |

---

## 9. 在线 / 离线边界（结构判据）

- **在线**（`ONLINE_SECTION_MARKER` 之前）：`compareTeams` / `minimalReplacement` /
  `auditTeamCompare` / `resolveDistribution` / `assumptionBasisProblems` /
  `structuralCriteriaScores` / `structuralScoresForTeam` / `applyStructuralScores` /
  `coverageConfidence` / `compareAxisValues` / `renderCompareText` / `collectClaimText` /
  `resolveRanker` / `formatRelative`。
  只读注入数据：**不跑模拟、不调引擎、不起进程**。
  判据扫的是**源码结构**（逐行子串匹配禁止模式），不是注释声明。
- **离线**（`OFFLINE_SECTION_MARKER` 之后）：`loadTeamCompareInputs` / `buildRc304Report` /
  `buildMeasuredDistributionSample` / `diagnoseForCompare`。
- 跨边界扫描口径可切换（`auditTeamCompare(..., {scope: 'whole'})`）：测试用同一份源码
  证明「online 口径放行、whole 口径判红」，说明这条判据真的有牙。

---

## 10. 必红反证（9 条方向 + 3 组控制 + 实际输出）

每条都先构造**正确的**产出，再把它**改坏**，喂回 `auditTeamCompare()`，必须变红。
测试把改坏后的完整问题清单打印成 `· [实际输出] …`；报告 `red_proofs[]`（当前 **27 条**）里逐条引用。

| # | 方向 | 改坏方式 | 期望的码 |
|---|---|---|---|
| ① | 分布 unknown 时前四轴返回数值 | 把 `environment_value.value` 改成 `0 / 1 / 0.5` | `UNKNOWN_AXIS_HAS_VALUE` |
| ② | `null` / `0` 却写 `available:true` | 可用轴 `value = null`；不可用轴 `value = 0`；不可用轴声明量纲；不可用轴报台账等级 | `AVAILABILITY_SHAPE` / `UNKNOWN_AXIS_HAS_VALUE` / `CONFIDENCE_NOT_IN_LEDGER` |
| ③ | 输出胜率 / 百分数 / 榜单词 | 加 `win_rate` 键；量纲写「胜率百分比（%）」；渲染文本写「胜率 62%」；用「强势/必带」当依据 | `PSEUDO_PRECISION` |
| ④ | **注入 measured 后前四轴仍 unknown** | 整轴退回 unknown 却仍报 measured；整份分布标 measured 但一条值都没有 | `MEASURED_NOT_WIRED` |
| ⑤ | 覆盖置信用了没有 build 数据支撑的实体却报高置信 | 抽掉可用轴的 `value_parts` / `weakest_part`；把成员的 build 数据抹掉看值是否变低 | `COVERAGE_NOT_FROM_BUILD` |
| ⑥ | 在线导出出现引擎 / 子进程调用 | 在线段插 `engine.step_joint()` / `import('node:child_process')` / 离线入口名 | `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL` / `OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION` |
| ⑦ | `minimalReplacement` 多方案或没有 `why` | 返回数组；`why=''`；一次换两只；非 measured 却宣称已确认 | `REPLACEMENT_SHAPE` / `REPLACEMENT_OVERCLAIM` |
| ⑧ | 两次运行不确定（含 tie-break） | 第二次产出的某一轴改成别的值；同分候选按字典序必须固定选一个 | `NONDETERMINISTIC` |
| ⑨ | **assumption 档的裸数字 / 缺依据** | 删 `basis`；挂 `sources[]`；`value` 合计 ≠ 1；抹掉 `structural_basis`；把四轴整体退回 unknown；改分母 K | `ASSUMPTION_BASIS_MISSING` / `ASSUMPTION_CARRIES_SOURCE` / `NO_PARTITION` / `STRUCTURAL_BASIS_MISSING` / `NO_STRUCTURAL_SIGNAL` |

三组控制：

- **负向控制**（报告 `negative_controls`）：把注入先验分别降级成 `unknown` / 删 `basis` /
  挂 `sources` / 破坏划分 ⇒ 四轴**必须** `available:false` + `value:null` + 点名缺什么；
- **分母敏感性**（`denominator_sensitivity_control`）：K → K+1 ⇒ 权重 `0.142857 → 0.125`、
  加权值随之变（`delta 0.064592`），且四轴仍可用——四轴真的吃分母，不是恒定的手写数；
- **正向控制**：注入带来源的 `measured` 分布 ⇒ 四轴必须亮起来，值等于判据独立重算的加权均值。

---

## 11. 「这份比较不能用来做什么」

- **不能用来排序队伍选强弱**：`assumption` 档的占比是**声明假设**（每个已识别体系等权），
  相对分是**结构分**；`coverage_confidence` 是自我描述。三者都不是实力判断。
- **不能当胜率用**：相对分只在同一份注入分布内可比；本模块不产出胜率，也不给它换名。
- **不能当实测环境分布用**：assumption 档的分母不是天梯数据，`basis.not_measured_note` 里写明；
  要升级成实测，必须给可核对来源（替换通道见 §5）。
- **不能替离线链路生产标签**：`measured` 档的 `relative_score` / `tolerance` 是离线联赛 /
  matchup bank 的产物，本模块只是消费者；对照样例是**构造**的，每条来源都标 `measured: false`。
- **不能拿它判「哪个候选更好」**：非 measured 档下 `minimalReplacement` 只给结构理由；
  多方案排序是另一个任务（也是 RC-305 之后的取舍呈现）。
- **不能超出冻结层的覆盖**（2026-09-28 改口径）：`build_data` 的口径是冻结层的具体配招。
  冻结档现在是 **542 只**（2026-09-28 前是 48 只），另有 **80 只**走 RC-402 的按需编译
  （`SIMULATABLE_UNVERIFIED`、无实机核验）；覆盖置信低时必须 fail closed，
  不许把 622 只都当成「配招合法性已校验」。
- **不覆盖 13 号文档 §4 的 CVaR / robustness**：那一格需要「不利对局尾部是否崩溃」的
  尾部收益分布，本 RC 落的是另外五个口径；报告 `does_not_do` 里写明，不用它冒充已实现。

---

## 12. 怎么跑

```bash
node --test tests/roco-team-compare.test.js          # RC-304 的 14 组（含 27 条必红反证）

# 报告与生成逻辑逐字节一致（磁盘上的报告不一致时用这个重写）
RC304_WRITE_REPORT=1 node --test tests/roco-team-compare.test.js

node scripts/roco/build-meta-prior.mjs --check       # 先验自检 + 与磁盘逐字节一致
node --test tests/roco-meta-prior.test.js            # 先验的 assumption 档牙
node --test tests/roco-workshop.test.js              # RC-305 工坊：五轴同源性
npm run test:unit                                    # 全量单元测试（RC-304 已加进行末）
```

---

## 13. 现在还是「未核实」的东西

- **占比的正确性**：assumption 档的 1/K 是**声明假设**，不是实测环境占比。
  它可复算、可替换，但**不等于**「每个体系真的各占 1/7」；要实测就得走 measured 档。
- **结构分的正确性**：七个判据的分子 / 分母都是 RC-302 的登记计数，
  但「结构分高 = 面对该体系表现好」这一步是**工程假设**（ENGINE_HYPOTHESIS），
  台账里没有对应条目；它是对局表现的**代理**，不是对局结果。
- **容错的下界代理**：`tolerance` 用「结构短板（最小结构分）」，真的「次优操作下掉多少」
  要离线回放 / 联赛采样，本仓一次都没跑过。
- **`measured` 来源真实性**：即使注入了来源，本模块只检查「有没有 url / 仓内文件 + 日期」，
  **不联网核对**。
- **`coverage_confidence` 的三个因子**：`criterion` / `evidence` / `build_data` 都是**可复算的计数**，
  但权重（等权）与 0.5 的置信门槛是工程假设（台账里没有对应条目）。
  在真实数据下 `evidence` 与 `build_data` 都容易顶到 1，区分度主要来自 `criterion`。
- **`pivot` 判据全队为 0**：冻结层里 48 只的具体配招都没有换入/离场手段，
  所以这一判据当前不带区分度（不是模型偏好，是数据事实）。
- **候选的 `covers_types`**：由注入方声明（最终来自 RC-303 的召回特征或离线产物），
  本模块**不自己算第二套属性表**；候选没有声明时它不会猜。
- 速度 / 面板 / 效果原语这些上游未核实项，在覆盖置信里表现为 `UNKNOWN` 扣分，
  具体的未核实清单仍在 RC-302 的 `unverified[]` 里。
