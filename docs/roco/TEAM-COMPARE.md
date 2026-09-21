# TEAM-COMPARE —— RC-304 未知对手下的队伍比较（能算的算、算不出的 fail closed）

> 代码：`src/coach/team-compare.mjs`（纯函数 + 显式注入数据，**在线不调引擎**）
> 机器可读报告：`reports/roco/flagship-upgrade/rc-304-team-compare.json`
> 测试：`tests/roco-team-compare.test.js`（13 组，含 **8 条必红反证** + 1 条反向控制）
> 上游：RC-301 `src/coach/team-request.js`（校验过的请求）、RC-302 `src/coach/team-gaps.js`（缺口诊断与台账六级）、
> RC-303 `src/coach/team-candidates.mjs`（候选生成）
> 环境先验：`data/roco/meta-prior/v1.json`（**只读**；`docs/roco/META-PRIOR.md`）
> 设计依据：`/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §4–§6；
> 路线图：`08-IMPLEMENTATION-ROADMAP.md` 的 RC-304 / RC-305

---

## 1. 一句话

匹配前没有具体敌队，能评价的只有「这支队伍**对版本环境分布**的表现」。
这份先验现在**没有分布**（7 个体系全部 `source: "unknown"` + `value: null`），
所以五轴里**四轴无定义**（`available:false` + 点名缺什么），**只有一轴真算**：
`coverage_confidence`（它只依赖 build 的规则与数据覆盖，不依赖对手分布）。

**没有胜率，也没有 0**。分布到位时前四轴会真的亮起来（测试里有这条反向控制）。

---

## 2. 五轴：定义、公式、现在能不能算

| 轴（输出键） | 13 号文档 §4 / 先验字段 | 定义与算法 | 现在 | why |
|---|---|---|---|---|
| `environment_value` | `expected_meta_value` | `Σ(relative_score × 占比) / Σ占比`：对每个可识别体系求相对表现的加权均值，权重 = 该体系在环境里的占比 | **unknown** | 没有分布 ⇒ 没有分母 |
| `worst_archetype` | `worst_archetype` | 逐体系相对表现里**最差**的那一个（含它的 `archetype_id` / `relative_score` / 权重） | **unknown** | 「最主流」= 分布；分布 unknown 时连「主流」都没有定义 |
| `matchup_spread` | `matchup_spread` | `max(relative_score) − min(relative_score)`：极差越大越说明严重依赖撞到特定阵容 | **unknown** | 散度是对分布的矩，分布未知时无定义 |
| `execution_tolerance` | `execution_tolerance` | `Σ(tolerance × 占比) / Σ占比`：次优操作下的相对表现在分布上的加权均值 | **unknown** | 需要可复跑的对局采样（离线回放/联赛），本仓一次都没跑过 |
| `coverage_confidence` | `coverage_confidence` | 三个可对账因子的均值：`criterion`（缺口里没被台账标 UNKNOWN 的条数比例）、`evidence`（带完整机器证据的缺口比例）、`build_data`（有具体 build 数据的成员比例） | **能算** | 它是**自我描述**（我们知道自己知道多少），不是实力判断 |

三轴的 `value` 形状（读的人一眼能分清「不知道」与「知道」）：

```text
available:false  →  value: null      + unknown_reason（点名缺什么）+ confidence: 'UNKNOWN'
available:true   →  value: 数值/对象  + unit（量纲）+ value_numbers（逐条声明单位）
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

## 3. 为什么现在只有一轴可算

`data/roco/meta-prior/v1.json` 自己写着：

```text
distribution[0..6].source = "unknown"
distribution[0..6].value  = null
claim.does_not_contain    = ["任何体系的占比数值：当前没有任何可核对的来源……"]
usage.inputs.*.honesty    = 「分布 unknown 时禁止输出任何数值型期望」
```

「对环境的期望」必须先有一个分母，而分母就是**对手分布**。仓库里没有任何真实对局数据
（没有录屏、没有匿名对局、没有离线联赛产物、没有 matchup bank），所以：

- 前四轴不是「算得不准」，而是**无定义**——它的输入根本不存在。返回 0 或「差不多」
  会把这个「不存在」伪装成一个数，后面所有比较都会建在一个编出来的分母上。
- `coverage_confidence` 的唯一输入是**队伍自己的 build**（RC-302 的缺口诊断），
  所以它现在就能算：它是「这份比较有多少是建立在真实数据上的」的自我描述。

判据（`FAIL_CLOSED_REASONS` / `STRUCTURAL_CRITERIA.distribution_fail_closed`）：
`distribution_source === 'unknown'`（或 `distribution[].value` 含 null）时，
前四轴的 `available` 必须是 `false`、`value` 必须是 `null`、`unknown_reason` 必须点名缺什么；
出现数值 / `0` / 「差不多」/ 胜率 ⇒ `UNKNOWN_AXIS_HAS_VALUE`（红）。

---

## 4. measured 分布到来后，哪些会亮

模块的分布判定**两套形状都认**（`resolveDistribution`）：

| 形状 | 出处 | 判定 |
|---|---|---|
| `metaPrior.distribution_source === 'unknown' / 'measured'` | RC-304 任务书的顶层判定 | 顶层写了就按顶层 |
| `metaPrior.distribution[] {source, value, sources[]}` | 先验 v1.json 的实际形状 | 顶层没写就逐条推断 |

`measured` 的条件（三条同时成立）：顶层没写 `unknown`、逐条 `value` 非 null、逐条带可核对的来源
（url 或仓内文件 + 日期，先验 `DISTRIBUTION` 判据的要求）。这时：

| 轴 | 值从哪来 | 还缺什么才会 unavailable |
|---|---|---|
| `environment_value` | `distribution[].value`（占比）× `relative_score` 的加权均值 | `relative_score` 缺失 ⇒ `NO_RELATIVE_SCORE` |
| `worst_archetype` | `min(relative_score)` 那一条 | 同上 |
| `matchup_spread` | `max − min` | 同上 |
| `execution_tolerance` | `tolerance` 的加权均值 | `tolerance` 缺失 ⇒ `NO_EXECUTION_SAMPLE` |
| `coverage_confidence` | （不变）注入的 build / 台账数据 | 没有注入缺口诊断 ⇒ `NO_GAP_DIAGNOSIS` |

`relative_score` 与 `tolerance` 是**离线产物**（13 号文档 §5.1 的 matchup bank / 联赛标签），
不是这份先验能凭空长出来的字段；接口先接好，是为了让「分布到位后接口是活的」可验证。

**反向控制**（必红方向 ④）：测试注入一份 `measured` 对照样例
（`buildMeasuredDistributionSample()`，每条来源都标 `measured: false`，**不是版本数据**），
前四轴必须 `available:true`，且 `environment_value` 必须等于**判据独立重算**的加权均值。
报告里的实测值：

```text
注入样例：poison_stack 0.35/0.30/0.80、ice_control 0.25/0.72/0.90、fighting_press 0.40/0.55/0.60
（三列 = 占比 value / 相对表现 relative_score / 操作容错 tolerance）
environment_value    = 0.505   （判据重算 0.505，逐位相同）
worst_archetype      = poison_stack（relative_score 0.30，权重 0.35）
matchup_spread       = 0.42    （0.72 − 0.30）
execution_tolerance  = 0.745   （加权均值）
coverage_confidence  = 0.851852（**不随注入分布变**：它只吃 build 数据）
```

反过来，如果 `measured` 分布下某一轴仍然 unknown ⇒ `MEASURED_NOT_WIRED`（红）：
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
把 build 数据整体抽掉后覆盖置信降到 `0.518519`——这条反向控制证明它真的在读 build 数据。

---

## 5. 为什么没有胜率

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

## 6. 最小替换（13 号文档 §6 的「一个最小替换方案」）

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
- **分布 unknown 时不许判「哪个更好」**：`confirmed_by_distribution: false`，
  `why` 只写结构理由并**明确说不知道**换谁在这个版本里更强；
  写成「换它更好」或 `confirmed_by_distribution: true` ⇒ `REPLACEMENT_OVERCLAIM`（红）。
- 没有候选能对接任何缺口时如实 `replacement: null` + 解释，**不编**一个方案。

候选要能进这条通路，必须自己带结构声明（`covers_types` / `has_build`）。
没有声明的候选**不会被猜**——这是「不替候选编一个属性表」的 fail closed。

---

## 7. 与 RC-303（候选生成）、RC-305（工坊 UI）的分工

| | RC-303 `team-candidates.mjs` | **RC-304 `team-compare.mjs`** | RC-305（工坊 UI） |
|---|---|---|---|
| 回答的问题 | 「下一只该选谁」 | 「这两支队在版本环境里差在哪」 | 「把上面两条摆到页面上」 |
| 输入 | 已选 0～5 只 + 全量候选宇宙 | 两支队伍 + 环境先验 + 缺口诊断 | 前两者的产出 |
| 输出 | 召回 20～50 → Beam 六宠 → Top-K；2～5 只时恰好三个下一只 | 五轴（一轴可算 / 四轴 unknown）+ 恰好一个最小替换 | 交互与呈现 |
| 排序口径 | 规则打分（`ranker` 缺失 ⇒ `missing`） | 注入分布上的相对分（`ranker` 缺失 ⇒ `missing`） | 不引入新口径 |
| 边界 | 不做缺口诊断、不做替换、不做期望值 | 不做候选召回、不做 Top-K、不做 UI | 不做口径、不算数 |
| 共享 | RC-302 的索引与判据（**不复制第二套语义**） | RC-302 的 `CONFIDENCE_LEVELS` / 诊断；RC-303 的候选结构声明 | — |

---

## 8. 在线 / 离线边界（结构判据）

- **在线**（`ONLINE_SECTION_MARKER` 之前）：`compareTeams` / `minimalReplacement` /
  `auditTeamCompare` / `resolveDistribution` / `coverageConfidence` / `compareAxisValues` /
  `renderCompareText` / `collectClaimText` / `resolveRanker` / `formatRelative`。
  只读注入数据：**不跑模拟、不调引擎、不起进程**。
  判据扫的是**源码结构**（逐行子串匹配禁止模式），不是注释声明。
- **离线**（`OFFLINE_SECTION_MARKER` 之后）：`loadTeamCompareInputs` / `buildRc304Report` /
  `buildMeasuredDistributionSample` / `diagnoseForCompare`。
- 跨边界扫描口径可切换（`auditTeamCompare(..., {scope: 'whole'})`）：测试用同一份源码
  证明「online 口径放行、whole 口径判红」，说明这条判据真的有牙。

---

## 9. 必红反证（8 条方向 + 实际输出）

每条都先构造**正确的**产出，再把它**改坏**，喂回 `auditTeamCompare()`，必须变红。
测试把改坏后的完整问题清单打印成 `· [实际输出] …`；报告里逐条引用。

| # | 方向 | 改坏方式 | 期望的码 |
|---|---|---|---|
| ① | 分布 unknown 时前四轴返回数值 | 把 `environment_value.value` 改成 `0 / 1 / 0.5` | `UNKNOWN_AXIS_HAS_VALUE` |
| ② | `null` / `0` 却写 `available:true` | 可用轴 `value = null`；unknown 轴 `value = 0`；unknown 轴声明量纲；unknown 轴报台账等级 | `AVAILABILITY_SHAPE` / `UNKNOWN_AXIS_HAS_VALUE` / `CONFIDENCE_NOT_IN_LEDGER` |
| ③ | 输出胜率 / 百分数 / 榜单词 | 加 `win_rate` 键；量纲写「胜率百分比（%）」；渲染文本写「胜率 62%」；用「强势/必带」当依据 | `PSEUDO_PRECISION` |
| ④ | **注入 measured 后前四轴仍 unknown** | 整轴退回 unknown 却仍报 measured；整份分布标 measured 但一条值都没有 | `MEASURED_NOT_WIRED` |
| ⑤ | 覆盖置信用了没有 build 数据支撑的实体却报高置信 | 抽掉可用轴的 `value_parts` / `weakest_part`；把成员的 build 数据抹掉看值是否变低 | `COVERAGE_NOT_FROM_BUILD` |
| ⑥ | 在线导出出现引擎 / 子进程调用 | 在线段插 `engine.step_joint()` / `import('node:child_process')` / 离线入口名 | `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL` / `OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION` |
| ⑦ | `minimalReplacement` 多方案或没有 `why` | 返回数组；`why=''`；一次换两只；unknown 却宣称已确认 | `REPLACEMENT_SHAPE` / `REPLACEMENT_OVERCLAIM` |
| ⑧ | 两次运行不确定（含 tie-break） | 第二次产出的某一轴改成别的值；同分候选按字典序必须固定选一个 | `NONDETERMINISTIC` |

反向控制（第 ④ 条的另一半，也是本 RC 最重要的一条）：**注入 measured 分布后前四轴必须真的亮起来**。

---

## 10. 「这份比较不能用来做什么」

- **不能用来排序队伍选强弱**：唯一能算的 `coverage_confidence` 是**自我描述**
  （我们知道自己知道多少），不是实力判断。
- **不能当胜率用**：相对分只在同一份注入分布内可比；本模块不产出胜率，也不给它换名。
- **不能替离线链路生产标签**：`relative_score` / `tolerance` 是离线联赛 / matchup bank 的产物，
  本模块只是消费者；对照样例是**构造**的，每条来源都标 `measured: false`。
- **不能拿它判「哪个候选更好」**：分布 unknown 时 `minimalReplacement` 只给结构理由；
  多方案排序是另一个任务（也是 RC-305 之后的取舍呈现）。
- **不能超出 48 只冻结层**：`build_data` 的口径是冻结迁移层的具体配招，
  622 只图鉴精灵的配招合法性仍未校验；覆盖置信低时必须 fail closed。
- **不覆盖 13 号文档 §4 的 CVaR / robustness**：那一格需要「不利对局尾部是否崩溃」的
  尾部收益分布，本 RC 落的是另外五个口径；报告 `does_not_do` 里写明，不用它冒充已实现。

---

## 11. 怎么跑

```bash
node --test tests/roco-team-compare.test.js          # RC-304 的 13 组（含 8 条必红反证）

# 报告与生成逻辑逐字节一致（磁盘上的报告不一致时用这个重写）
RC304_WRITE_REPORT=1 node --test tests/roco-team-compare.test.js

npm run test:unit                                    # 全量单元测试（RC-304 已加进行末）
node --test tests/roco-team-candidates.test.js       # RC-303 不退化
```

`tests/roco-team-compare.test.js` 已加进 `package.json` 的 `test:unit`（行末）。

---

## 12. 现在还是「未核实」的东西

- **四轴在真实数据到位前永远是 unknown**：没有真实对局数据（没有 matchup bank、
  没有离线联赛产物），`distribution[]` 就一直是 `unknown`。这不是本模块能解决的，
  它的职责只是**不让这段空白被填上假的数**。
- 相对表现（`relative_score`）与操作容错（`tolerance`）的**正确性**：即使注入了来源，
  本模块只检查「有没有 url / 仓内文件 + 日期」，**不联网核对**来源真实性。
- `coverage_confidence` 的三个因子：`criterion` / `evidence` / `build_data` 都是**可复算的计数**，
  但权重（等权）与 0.5 的置信门槛是工程假设（台账里没有对应条目）。
  在真实数据下 `evidence` 与 `build_data` 都容易顶到 1，区分度主要来自 `criterion`。
- 候选的 `covers_types`：由注入方声明（最终来自 RC-303 的召回特征或离线产物），
  本模块**不自己算第二套属性表**；候选没有声明时它不会猜。
- 速度 / 面板 / 效果原语这些上游未核实项，在覆盖置信里表现为 `UNKNOWN` 扣分，
  具体的未核实清单仍在 RC-302 的 `unverified[]` 里。
