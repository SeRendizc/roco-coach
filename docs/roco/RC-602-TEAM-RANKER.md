# RC-602 —— Team Pairwise Ranker + Partial-team Completion Value

> 代码：`src/coach/team-ranker.mjs`（纯函数 + 显式注入数据；不读盘、不联网、不起进程、不模拟对局）
> 产物：`reports/roco/rc602/team-ranker.json`（实测时延 + 可算/unknown 计数 + Top-5 + 权重表 + `RANKER_STATUS`）
> 反证原文：`reports/roco/rc602/red-proofs.json`（测试实际打印的 9 条必红反证）
> 生成脚本：`scripts/roco/build-rc602-report.mjs`（`node scripts/roco/build-rc602-report.mjs` 写盘；`--check` 只比对）
> 测试：`tests/roco-team-ranker.test.js`（16 条判据，其中 9 条必红反证）
> 上游：RC-302 `src/coach/team-gaps.js`（索引 / 属性相性 / 能耗 / 应对 / 换入判据）、
> RC-303 `src/coach/team-candidates.mjs`（队伍特征聚合与 `resolveRanker` 契约）、
> RC-304 `src/coach/team-compare.mjs`（最小替换，报告里的例子直接调它）
> 路线图：`docs/roadmap/FLAGSHIP-V3-CHECKLIST.md` Phase 1C 的 RC-602

---

## 1. 一句话

RC-303 的 `scoreTeams()` 里有一个诚实的洞：注入的 Team Ranker 不存在时它报 `ranker_status: 'missing'`
并退化成规则打分。这一批**补的是那个洞的形状，不是那个洞的承诺**：给出一个确定性、可复算、
**权重全部公开且标 `ENGINE_HYPOTHESIS`** 的成对结构排序器，外加一个「已选 k 只还能补到什么」的
结构价值口径 —— 同时把「没有真实对局数据 ⇒ 不承诺任何预测能力」写成机器可读的 `RANKER_STATUS`。

---

## 2. 为什么先做「可算但非强度」的排序器

三个上游事实决定了这一批只能是启发式：

| 上游 | 现状 | 对本模块的后果 |
| --- | --- | --- |
| RC-601 规则绑定的轨迹重建 | **BLOCKED**（规则 candidate 未定，且人类明令先不要用旧规则生成轨迹） | 拿不到「双方六宠 build + 出手序列」的标签 ⇒ **学不到权重** |
| RC-603 Learned Value | **DEFERRED 给用户**（RTX 3060 亲训） | 真正的学习排序器由用户训练，本模块不冒充 |
| RC-304 版本对手分布 | `data/roco/meta-prior/v1.json` 的 `distribution[]` 全部 `source: unknown` + `value: null` | 「对谁更强」的口径仍然无定义 ⇒ 排序器只排**结构**，不排强度 |

于是这一批的定位是：**把「能算的结构量」算到极致，把「算不出的量」逐条点名**。
它排出来的名次是「在本次注入的队伍集合里，六维结构加权分谁高」——不是「谁更可能赢」。

`RANKER_STATUS.fills_rc303_ranker_missing = 'heuristic_only'` 就是这件事的机器可读版本：
RC-303 那个 `missing` 被**形状上**补上了（`resolveRanker()` 现在报 `ready`），但
`calibrated: false` 保证 `scoreTeams()` 的置信等级**停在 `ENGINE_HYPOTHESIS`**，
`no_win_rate: true` 一个字没动。

---

## 3. 特征与权重：来源与不确定性

### 3.1 六个成对维度

每一维都**双侧各算一次**，方向固定为「A 相对 B」，取值是 RC-303 `teamFeatures()` 已经聚合好的量
（`FEATURE_SOURCE_KEYS` 是唯一一份映射表，本模块不重算任何一项）：

| 维度 | 取自 | 数据出处（可逐条核对） | 不确定性 |
| --- | --- | --- | --- |
| `type_coverage` | `teamFeatures().coverage` | 冻结相性表 `types.json` 的 `.resist`（**组合行优先**） | 组合行没登记 ⇒ 该成员整体 unknown |
| `weakness_exposure` | `teamFeatures().synergy` | 同一张表的 `.weak` | 同上 |
| `speed_layers` | `teamFeatures().speed` | 冻结 `roster-48.json` 的 `stats.spe` + `speed_tier`（5 档声明） | **只是种族值与档位**，不是面板速度 |
| `respond_coverage` | `teamFeatures().respond` | 冻结 `skills.json` 的 `desc`（判据在 RC-302 `respondVariantsOf`） | 12/48 只有图鉴推测的学招表 |
| `energy_curve` | `teamFeatures().energy` | 冻结 `skills[].energy` + 注入规则配置的能耗上限 | 上限本身在候选规则版本里（RC-601 未定） |
| `pivot_sustain` | `teamFeatures().pivot` | `skills[].desc` 关键字（`isPivotSkill`） | 六维里最弱的一条判据 |

属性这一维**必须组合行优先**：冻结相性表 120 行 = 18 个单属性行 + 102 个组合行，48 只里 33 只是双属性。
反证里用的例子：`own-0003`（`地系|幻系`）的组合行有 **6** 个抗性，只看 `types[0]=地系` 只有 **5** 个 ——
判据要求模块输出必须等于组合行的数，退回单属性算法即判红。

### 3.2 权重表（全部 `ENGINE_HYPOTHESIS`，逐条带理由）

```text
type_coverage      0.24   冻结相性表（120 行，含 102 行组合）逐条可复算，六维里证据最硬
weakness_exposure  0.20   与属性覆盖同源、方向相反；略低，因为它对队伍人数更敏感
speed_layers       0.16   只用冻结 stats.spe/speed_tier（48/48 有值）；面板值未知 ⇒ 不给最高
respond_coverage   0.16   应对三类词条由冻结 desc 判定；12 只走图鉴推测 ⇒ 中档
energy_curve       0.14   能耗来自冻结 energy 与注入上限；上限随规则版本未定 ⇒ 中低档
pivot_sustain      0.10   换入/离场只靠描述关键字，是最弱的一条 ⇒ 最低
```

- 权重和 = 1（便于读），`auditWeightTable()` 要求每条权重有
  `{weight ∈ [0,1], feature ∈ FEATURE_IDS, provenance ∈ {ENGINE_HYPOTHESIS}, reason, source_ref}`；
- 允许的来源等级**只有 `ENGINE_HYPOTHESIS` 一种** —— 写 `COMMUNITY_CURRENT` 会假装有社区口径来源，
  写 `MEASURED_*` 会假装有对局数据，两者都是编；
- 数值本身是工程判断：**换一组权重排序会变**，这一点写在每一行的 `unverified[]` 里。

### 3.3 打分口径

`score = Σ(weightᵢ × valueᵢ) / Σ(weightᵢ)`，`value` 是那一维双侧值里更占优的一侧
（等价于 `max`，好处是 A↔B 互换后分数不变，成对镜面对称）。

**六维是一个整体契约**：只要有一维算不出，`pairwiseScore` 返回 `available: false` + `score: null` + 点名缺哪一维，
**不用剩余维度重归一**（那会静默改变量纲，让两次分数没法放在一起比），也不返回 0。
`rankTeams()` 里这种队伍进 `unranked[]`，不参与排序。

---

## 4. `available:false` 的触发条件（fail closed，全都有判据钉住）

| 情形 | 行为 | 点名内容 |
| --- | --- | --- |
| 没注入 `ctx.index` / `ctx.inputs` | 整包 `available:false` | 缺 `ctx.index`（本模块不读盘） |
| 空队伍 / 没有成员 | 该侧不可算 | `EMPTY_TEAM`：空队伍没有成对结构特征 |
| 成员 id 解析不出 species | 该侧不可算 | `UNRESOLVED_MEMBER`：既不是 owned 实例、也没有 species_id |
| 成员重复登记 | 该侧不可算 | `DUPLICATE_MEMBER`：同一只上两次不构成第二层覆盖 |
| 属性组合行没登记 | `type_coverage` / `weakness_exposure` 不可算 | 点名是哪个成员、哪张表多少行 |
| 速度值拿不到 | `speed_layers` 不可算 | 点名是哪个成员 |
| 没有具体 build | `energy_curve` / `respond_coverage` / `pivot_sustain` 不可算 | 点名是哪个成员 |
| 没注入规则配置的能耗上限 | `energy_curve` 不可算 | 点名 `ctx.ruleset_energy_cap` |
| 权重表缺失 / 空 / 全 0 / 权重越界 / 缺 provenance / 缺 reason | `pairwiseScore` 不可算 | 逐条 `WEIGHT_*` 问题码 |
| 特征包自报 `available !== true` | 不可算 | 转述特征包自己的原因 |
| `partialCompletionValue` 的 k=0 / k>6 / 重复 id / 非法 id | 不可算 | 各自的原因（见 §6） |

**唯一的永久 unknown：关键速度线。** 判先手关系要真实面板值（等级 / 性格 / 资质 / 特长 / 血脉换算后），
而冻结数据里 48 个实例的 `panel_stats` 一律 `null`、养成效果 `effect: UNKNOWN`
（`data/roco/owned/owned-pets.json` 的 `growth_attribute_policy`），
所以 `speed_layers.detail.key_speed_lines` 永远是 `available:false` + `values: {teamA: null, teamB: null}`。
这是诚实的算不出来，不是 bug —— 它**不许**用 0 顶替，也不许拿种族值档位冒充先手关系。

---

## 5. 工具与契约

| 导出 | 输入 | 输出要点 |
| --- | --- | --- |
| `pairwiseFeatures(teamA, teamB, ctx)` | 两支队伍 + `{index\|inputs, ruleset_energy_cap}` | 六维双侧值 + `advantage` + `leads` + 每维 `available/unknown_reason` + `evidence[]` + `unverified[]` + `problems[]` |
| `pairwiseScore(features, weights = WEIGHTS)` | 成对特征包 | `{available, score ∈ [0,1] 或 null, unknown_reason, parts, weights_used, weight_problems}` |
| `rankTeams(teams, ctx, opts)` | 队伍数组 | `{ranked[]（带 rank/score/parts/availability）, unranked[]（带原因）, tie_break, ranked_count, unranked_count}` |
| `partialCompletionValue(partial, ctx)` | 已选 k 只 + `{candidates}` | 结构价值 + `uncertainty`（池规模 / unknown 占比 / 分数区间）；**不是概率** |
| `auditWeightTable(weights)` | 权重表 | 每条权重的 provenance / reason / feature 判据 |
| `scanBannedClaims(value)` | 任意产出 | 伪精确字段名与词的深度扫描 |
| `auditRanker({weights, status})` | — | 权重审计 + 状态声明扫描 + `learned_weights/calibrated/emits_*` 必须为 `false` |
| `RANKER_STATUS` | — | 机器可读的诚实声明（下节） |
| `RULE_PAIRWISE_RANKER` | — | 给 RC-303 `resolveRanker()` 用的 `{ranker_id, version, calibrated:false, score(features)}` |
| `WEIGHTS` / `FEATURE_IDS` / `FEATURE_SOURCE_KEYS` / `FEATURE_DEFINITIONS` / `TIE_BREAKS` / `SPEED_TIERS` | — | 权重表 / 维度表 / 映射表 / tie-break 口径 / 速度档位边界 |

队伍成员引用接受 RC-301/302 的登记键（`instance:own-0001` / `catalog:pet_000001`）或
`{key|instance_id|id|species_id}`；**普通对象必须至少声明一个标识**，否则按 `INVALID_MEMBER` 点名
（`{nonsense: true}` 不许静默溜进解析流程）。

排序的 tie-break 只有两种，写入 `TIE_BREAKS`：`team_id_lexicographic`（默认）与 `input_order`；
无论哪种都以输入下标兜底，保证**全序** ⇒ 同一输入两次运行逐位相同、倒序输入名次不变。
同分会被标出来（`tied_with_previous: true`）—— 读的人有权知道 tie-break 参与了决定。

---

## 6. Partial-team Completion Value

给定已选 k 只，算「补满六只还能补到什么」的**结构**价值：

```text
coverage_resistable_types   现在能抗住多少个攻击系别（分子/分母都是计数）
speed_bands_covered         现在占了几个速度档位（3 档）
respond_variants_covered    现在覆盖了几类应对词条（3 类）
pivot_holders               有换入/离场手段的成员数 / 成员数
pool_fillable_slots         候选池里还有几只能补进剩余槽位（去重、去已在队里的）
score                       上面三个覆盖比的等权平均（0～1），或 null
uncertainty                 {available_pool_size, pool_unknown_ratio, pool_fully_known_ratio,
                             fillability_ratio, structural_gap_count, score_band{low,high}, why}
```

`uncertainty` 是**「我们不知道多少」的区间**，不是任何意义上的可能性：区间半宽只由
「候选池能填满几个剩余槽位」与「池里有多少只带 unknown」决定。
池子缩小 ⇒ 区间不许变窄（判据钉住）。

边界行为（全部 fail closed 并逐条点名）：

| 输入 | 行为 |
| --- | --- |
| k = 0 | `available:false`：没有已选结构，覆盖/速度/应对缺口无从谈起（也不给 0） |
| k = 6 | **仍然算**：`available:true`、`remaining_slots: 0`、`pool_fillable_slots: 0` |
| k > 6 | `available:false`：超出标准六宠的语义在本仓没有依据 |
| 重复 id | `available:false`：同一只算两次会虚增覆盖计数 |
| 非法 id | 合法部分仍算，非法的进 `problems[]`（`UNRESOLVED_MEMBER` / `INVALID_MEMBER`），并如实报 `rejected_count` |
| 池里有非法候选 | 点名 `INVALID_CANDIDATE` / `CANDIDATE_ALREADY_IN_TEAM`，可补只数按合法候选算 |

单调性判据：补进一只抗性集合严格更大的成员，`coverage_resistable_types`、`speed_bands_covered`、
`respond_variants_covered` 与 `score` **都不许下降**；补进更差的成员不许反超更好那一版。

---

## 7. 边界（这一批**不**承诺什么）

- **这是启发式，不是强度排序。** 六维权重全是工程假设，没有任何对局数据支持
  「排前面的更可能赢」；换一组权重名次会变。
- **没有真实对局数据前不承诺任何预测能力。** 模块不产出胜负预测、概率、百分数、强度分、榜单标签；
  `RANKER_STATUS` 里 `learned_weights: false` / `calibrated: false` / `training_labels: 0` /
  `emits_outcome_prediction: false` / `emits_win_rate: false` / `emits_percent: false`。
- **名次只在本次注入的队伍集合内有意义**：换一批队伍进来，名次会变。
- **关键速度线、面板值、养成效果现在算不出来**（§4）。
- **图鉴物种（非冻结 48 只）** 的面板与养成只有 `on-demand-builds.json` 的 `SIMULATABLE_UNVERIFIED`
  推算配招，没有实机核验 —— 本模块把它们当「有值但带 unknown 的候选」，不升格。
- **对版本环境分布的表现（RC-304 前四轴）** 现在是 assumption 档的结构分（`meta-prior/v1.json` 的分母是
  **声明假设**：7 个已识别体系各 1/7，相对表现由 RC-304 从 RC-302 结构性算出，`ENGINE_HYPOTHESIS`），
  所以本模块的排序与那四轴**仍然不是一回事**（前者是本次注入队伍集合内的名次，后者是结构描述），
  两者不许互相引用。
- 在线路径不读盘、不联网、不起进程、不调引擎、不模拟对局；源码里连 `Date.now` / `Math.random` 都没有
  （判据扫源码，注入一个 `fetch` 必须判红）。

---

## 8. 接线计划

### 8.1 已经能对上的那一半（本批已实测）

`RULE_PAIRWISE_RANKER` 的形状正好是 RC-303 `resolveRanker()` 认的版本化产物：

```js
resolveRanker(RULE_PAIRWISE_RANKER)
// → {status:'ready', ranker_id:'roco-rule-pairwise-ranker', version:'rc602/1', ...}
scoreTeams(teams, {ranker: RULE_PAIRWISE_RANKER, k, __index})
// → ranker_status:'ready', ranker_injected:true, score_source:'ranker',
//   confidence:'ENGINE_HYPOTHESIS'（因为 calibrated:false）, no_win_rate:true
```

这就是对 `team-candidates.mjs` 那个 `missing` 的**代码级**影响：洞的形状补上了，
但 `calibrated:false` 保证置信等级不升档。接线是**显式注入**（调用方传 `ranker`），
不是把常量硬塞进 `scoreTeams()` 的默认值 —— 谁想用谁就得写出来。

### 8.2 还需要主线程决定的接线（本批**没有**改那些文件）

1. **`src/coach/team-candidates.mjs` 的 Top-K**：把 `progressiveNext()` / `buildTeamCandidatePlan()`
   的默认 `ranker` 参数接成 `RULE_PAIRWISE_RANKER`（或由上层注入）。注意 `score()` 吃的是
   RC-303 的 `teamFeatures()` 形状（不是成对特征），适配器已经按那个形状写好并测过。
2. **工坊 `evaluate_team`（`src/coach/toolbox.js` → `client.evaluateTeam`）**：
   `evaluate_team` 现在走手游客户端的规则 baseline（训练场 3 只），拿回来的是 `coverage_delta` 之类
   的分项特征。**允许**把 `RULE_PAIRWISE_RANKER` 接到它的候选比较上（同样的分项 → 同一个加权平均），
   但**必须先满足**这三个条件：
   - 候选阵容满足 `locked_pet` 约束（现有 `rocoEvaluateTeam` 已经在做，不许绕过）；
   - 输出里同时带 `ranker_status` / `ranker_id` / `ranker_version` / `calibrated:false`，
     让读的人看得见「这是启发式」；
   - `opponentPool` 那一栏继续写 `specified:false`（没有具名对手池），不许因为排序器存在就改口径。
3. **谁在什么条件下才允许把它当排序依据**：
   - **允许**：候选召回/束搜索的**收窄**（把 20～50 个候选排个序）、渐进推荐的三选一、
     工坊里「换这只比换那只的结构覆盖更好」这类**结构**叙述；
   - **不允许**：任何「胜率更高 / 更可能赢 / 强度更高 / 应该带」的措辞；跨批次的分数比较
     （换一批队伍或换一组权重后，旧分数失效）；把名次当作工坊的最终结论而不是候选排序输入。
4. **RC-603 到位后的替换路径**：用户训出学习排序器后，注入的 `ranker` 换成那份产物
   （`calibrated:true` + held-out 校准证据），`scoreTeams()` 会自动把置信等级升到
   `COMMUNITY_CURRENT`；本模块则退回「缺排序器时的结构降级口径」。
   在那之前 `RANKER_STATUS.learned_ranker_unlock_requirements` 就是解锁条件的清单。
5. **`docs/roadmap/DSH-EXECUTION-STATE.md`** 与清单状态由主线程维护（本批不改）。

### 8.3 门禁接线（主线程执行；本批不改 `package.json`）

`package.json` 的 `test:unit` 末尾加一项即可：

```text
tests/roco-team-ranker.test.js
```

---

## 9. 实测数字（**542** 个冻结个体，`reports/roco/rc602/team-ranker.json`）

> **⚠ 口径注 / 改钉说明（2026-09-28 补）**
>
> 人类 2026-09-28 拍板「所有精灵实装」之后，冻结档从 48 只扩到 **542 只**（可玩层 530 + 基线 12），
> `reports/roco/rc602/team-ranker.json` 随之**重跑过**：它的 `corpus` 现在是
> `owned_instances: 542 / owned_species: 542 / catalog_species: 622 / validated_species: 542 /
> species_with_frozen_learnset: 542 / registered_attack_types: 18 / registered_type_combo_rows: 120`。
> 报告里跟着变的还有：`pairwise_instances.pairs_total = 146611`（= C(542,2)，可算 146611 / unknown 0）、
> `pairwise_six_pet` 现在是 **90 支队 / 4005 对**、`ranking` 是 **90 队 ranked 90 / unranked 0**
> （Top-3 = `rc602-team-86` 0.9448 / `team-83` 0.9327 / `team-89` 0.8983）、
> `partial_completion_value.candidate_pool_size = 536`（六档 0.5185 → 0.5555 → 0.7408 → 0.7778 → 0.7778 → 0.8889）。
>
> **下面那张表除「语料」一行外，都是 2026-09-28 之前那次在 48 只语料上跑出来的读数**（1128 对 / 28 对 /
> 候选池 42 / Top-3 = team-07·08·01）。按「改钉不删」纪律，这些旧读数**留在原地**，
> 但**不能**再当成当前读数引用；当前读数以报告 JSON 为准。
>
> ⚠ **报告里仍有多处写着「48」的字符串**（`generated_note`、`pairwise_instances.criterion`、
> `pairwise_six_pet.criterion`、`not_computable[].why` 等）。成因不在本文：这些句子是
> `src/coach/team-ranker.mjs` 里写死的输出文案（第 76 / 482 / 677 行等），本轮**没有**跟着扩。
> 本文只改文档，**没有**动 `src/**` —— 这一处已知不一致需要另开一轮修。

| 项 | 实测 |
| --- | --- |
| 语料 | **542** 个 owned 实例 / **542** 个物种 / 图鉴 622 物种 / 冻结学招表 **542** / 攻击系别 18 / 相性表 120 行（18 单 + 102 组合）——2026-09-28 前是 48 / 48 / 622 / 48 |
| 全部 C(48,2) 成对特征 | **1128 对，可算 1128、unknown 0**；P50 **0.023 ms**、P95 **0.065 ms**、max 0.835 ms、总 37.15 ms |
| 每维可算性（1128 对） | 六维各 1128/1128 可算 |
| 关键速度线 | **0/1128 可算**（原因：缺面板值 `panel_stats`） |
| 六宠队（8 支互不重叠，C(8,2)=28 对） | 28 对可算 28；P50 **0.102 ms**、P95 **0.159 ms** |
| `rankTeams` 8 支队 | ranked 8、unranked 0；P50 **0.51 ms**、P95 **0.671 ms**；Top-3 = team-07（0.9034）、team-08（0.9027）、team-01（0.8983） |
| PCV（k=1…6，候选池 42） | 0.3704 → 0.6667 → 0.7778 → 0.8148 → 0.8148 → 0.8148；P50 **0.088 ms**、P95 **0.119 ms** |
| `minimalReplacement` 示例 | 复用 RC-304；本脚本不建 RC-302 缺口诊断 ⇒ 它如实返回 `replacement: null` + `confidence: 'UNKNOWN'` |
| 必红反证 | 9 条（`reports/roco/rc602/red-proofs.json`，实际输出原文） |

> 时延是墙钟实测，随机器负载浮动；**可算/unknown 的计数是确定的**，
> 所以 `--check` 只比对除时延外的字段。
