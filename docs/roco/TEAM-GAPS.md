# RC-302 阵容缺口诊断

> 这份文档说明**七个维度各自怎么算**、**每条结论的置信等级怎么定**、
> **哪些量现在根本算不出来**，以及它与 RC-303/RC-304 的分工。
>
> 模块：`src/coach/team-gaps.js`（纯函数；顶层只 import 同仓的 `./team-request.js`，
> 没有 npm 依赖，不碰 DOM）。守卫：`tests/roco-team-gaps.test.js`（16 条判据，含 8 条必红反证）。
> 机器可读报告：`reports/roco/flagship-upgrade/rc-302-team-gaps.json`。

## 1. 本 RC 只诊断缺口：不排序、不推荐

| 做 | 不做 |
|---|---|
| 输入一份**经 RC-301 校验过**的 `RecommendationRequest`，输出这套阵容的**缺口** | 不给候选名单、不给 Top-K、不排序（**RC-303**） |
| 每条 gap 带 `machine_evidence[]`（文件 + 指针 + 字段 + 值） | 不给伪精确胜率、不给「强度分」、不引用社区榜单标签（T0 / 强势 / 必带） |
| 每条 gap 带台账六级之一的 `confidence` 与 `unverified[]` | 不做未知对手下的 expected value / 最差体系 / matchup spread（**RC-304**） |
| 硬约束不可满足时 `ok:false`（fail closed） | 不因为「必须有结论」就猜一个 |

一句话：**RC-302 回答「这套队缺什么」，不回答「这套队好不好」。**
`buildRc302Report()` 把这条边界写进报告的 `does_not_rank_or_recommend`。

## 2. 接口

```js
import {diagnoseTeamGaps, auditGapDiagnosis, loadTeamGapsInputs} from './src/coach/team-gaps.js';
import {validateRecommendationRequest, loadRecommendationInputs} from './src/coach/team-request.js';

const inputs = await loadTeamGapsInputs();                     // 只在 Node 侧读盘（只读，不写）
const rc301 = await loadRecommendationInputs();
const {ok, request} = validateRecommendationRequest({mode: 'pvp-standard-six-pet', selected: ['own-0001']}, rc301);
const diagnosis = diagnoseTeamGaps(request, inputs);
// → {ok, gaps[], evidence[], confidence, problems[], facts, policy}
const audit = auditGapDiagnosis(diagnosis, {ledger: inputs.ledger});  // 把纪律变成机器判据
```

一条 gap 的形状（每个字段都由 `auditGapDiagnosis()` 检查）：

```jsonc
{
  "id": "coverage.unresisted.火系",
  "dimension": "coverage",            // 七维之一
  "severity": "medium",               // blocking | high | medium | low | info
  "confidence": "COMMUNITY_CURRENT",  // 台账六级之一
  "criteria": "……可复算判据原文……",
  "why": "队里没有一只对 火系 有抗性（3 只被它克制）：全队只能靠中性承伤",
  "value": { "attack_type": "火系", "weak_members": [...] },      // 实测值
  "domain": { "basis": "validated_layer", "known": 48, "unknown": 574, "total": 622 },
  "machine_evidence": [ {"source_file": ".../types.json", "pointer": "types[\"火系|草系\"]", "field": "weak", "value": [...]} ],
  "unverified": ["……这条结论里哪些量其实没数据……"],
  "depends_on": ["turn_order.priority"]
}
```

## 3. 七个维度的判据（可复算，不是形容词）

判据文本的唯一事实源是 `DIMENSION_CRITERIA`（代码与本文档、报告引用同一份）。

### 3.1 `coverage` —— 队伍对已登记属性的覆盖

**判据**：对每个**已登记攻击系别** T（`types.json` 的 18 个单系键），把成员的属性组合按
`types.join("|")` 拼成防御键去查 `types.json#types[key]`：`weak[]` 命中 T 取该项倍率、
`resist[]` 命中 T 取该项倍率，两处都没有 ⇒ 中性 ×1。
**「队伍能接 T」= 存在成员倍率 < 1**；一个都没有 ⇒ 出一条 `coverage.unresisted.<T>`。

倍率一律用**整数标度**（×4：0.25→1 / 0.5→2 / 1→4 / 2→8 / 3→12）比较，不做浮点运算 ——
所以同一输入两次运行不可能因为浮点残差而不一致。

| 严重度 | 触发条件 |
|---|---|
| `high` | 没有任何成员有抗性，且**全队都被 T 克制** |
| `medium` | 没有任何成员有抗性，至少有成员被 T 克制 |
| `low` | 没有任何成员有抗性，也没有成员被克制（全员中性：只是「没有答案」，不是「会被打穿」） |
| 有成员属性未知时 | 严重度**压到 medium**，并把未知成员写进 `unverified` |

**80 个 owned 实例上的实测分布**（`resist` = 对该系别有抗性的实例数，`weak` = 被它克制的实例数）：

| 系别 | resist | weak | 系别 | resist | weak |
|---|---:|---:|---|---:|---:|
| 虫系 | 37 | 14 | 光系 | 17 | 14 |
| 草系 | 28 | 21 | 恶系 | 16 | 15 |
| 普通系 | 27 | 0 | 冰系 | 15 | 16 |
| 机械系 | 26 | 29 | 水系 | 15 | 19 |
| 毒系 | 26 | 8 | 萌系 | 15 | 19 |
| 电系 | 25 | 18 | 幻系 | 14 | 14 |
| 火系 | 23 | 30 | 地系 | 9 | 25 |
| 翼系 | 23 | 22 | 幽系 | 9 | 12 |
| 武系 | 18 | 25 | 龙系 | 6 | 3 |

> 「多少只能补某个弱点」= 上表的 `resist` 列。龙系只有 6 只能抗、幽系/地系各 9 只：
> 这三条是 80 只箱子里最稀缺的覆盖资源。这些数字是**箱子口径**，换一批 owned 就变。

### 3.2 `speed` —— 速度层次

**判据**：速度取**冻结迁移层** `roster-48.json#pets[].stats.spe` 与同一行的 `speed_tier` 标注；
队内已知成员按 `speed_tier` 统计梯度（只有 1 档且成员 ≥ 2 ⇒ `medium`）。
**任何「谁先动」的推断都不做**：先手严格总序在台账里是 `ENGINE_HYPOTHESIS`，速度平手是 `UNKNOWN`。

| 实测 | 值 |
|---|---|
| 冻结迁移层有速度档的物种 | **48** |
| full-catalog 里有 `stats.spe` 的精灵 | 622（但自注 `knowledge_only`、`panel_formula` 未知） |
| pack 的 pet 实体 | 622 |
| 80 个实例（全部在迁移层内）的档位分布 | `<=50`: 7、`51-70`: 15、`71-90`: 24、`91-110`: 20、`>=111`: 14 |
| 拥有迁移层速度值的实例 | 80 / 80 |

### 3.3 `energy` —— 能耗曲线（威力 fail-closed）

**判据**：能耗取成员**具体 build** 的四个技能（`owned.instances[].skills`，有序四个）在
`skills.json` 的 `energy`；统计 min / max / 合计 / 0 费技能数，以及与**本次请求所用规则配置**
相比超限的技能数。上限只从 `data/roco/rulesets/*.json` 的 `energy.max.value` 读
（RC-101 的结构契约把「把能量值写死在代码里」判红，所以本模块一个能量数字都不写）；
请求没带 `ruleset_config_id` 时按 RC-301 的规则用**模式注册表绑定的那一份**，
两者都拿不到就 `energy.cap_unknown`（UNKNOWN，fail closed）。
`power_status !== "static_value_present"` 的技能**不写任何伤害数值**。
「这招第一回合付不付得起」依赖入场初始能量与回能，两者是占位值/工程假设 ⇒ **只报结构，不报可用性**。

| 实测（80 实例 / 320 个技能槽） | 值 |
|---|---|
| 四个技能里没有 0 费技能的实例 | **46 / 80** |
| 四技能能耗合计的分布 | 2～22（众数 7 与 10，各 13 例） |
| 单技能最高能耗 | 10（`skill_000670`） |
| 能耗 > `legacy_sim_v1` 上限（cap = 6，`ENGINE_HYPOTHESIS`）的技能槽 | **8** |
| 能耗 > `mobile_s4_candidate_v2` 上限（cap = 10，`CROSS_SOURCE_SUPPORTED`）的技能槽 | 0 |
| 没有静态威力的技能槽 | **152 / 320** |
| 全量技能表里没有静态威力的技能 | 466 / 824 |

> 标准 PVP 默认绑定 `mobile_s4_candidate_v2`（cap 10），所以默认口径下**不会**出现 over-cap 缺口；
> 报告里的 `legacy-ruleset-cap` 样例把同一份六宠请求换成 `legacy_sim_v1`（cap 6），
> over-cap 缺口就出现了 —— 这就是「版本相关的结论必须读配置」的实测演示。

### 3.4 `respond` —— 应对手段数量

**判据**：从冻结 `learnsets.json`（`native_skills` + `blood_skills` + `skill_stones`）取学招池，
用 `skills[].desc` 的**词条**判定应对种类：`应对攻击` / `应对状态` / `应对防御`（三者互不替代）；
再单独统计这四个技能（build）里带不带任一种。
**只报「描述里出现了这个应对词条」，不报它能不能挡住什么**。

| 实测 | 值 |
|---|---|
| 学招池里有 `应对攻击` 的物种 | **48 / 48** |
| 学招池里有 `应对状态` 的物种 | 34 / 48 |
| 学招池里有 `应对防御` 的物种 | 36 / 48 |
| 80 个实例的 build 里带 `应对攻击` / `应对状态` / `应对防御` | 30 / 25 / 13 |
| build 里一个应对词条都没有的实例 | **23 / 80** |

> 因为 48 只的学招池全部含 `应对攻击`，「全队一条应对都没有」在 owned 队伍里基本不会触发；
> 真正会触发的是 **build 没带**（`respond.build_missing`）与**某一路应对词条全队不存在**
> （`respond.variant_missing.<variant>`，例如队里没人学得到 `应对状态`）。

### 3.5 `pivot` —— 换入/离场手段

**判据**：换入/离场手段 = 学招池里（去掉 `category === "特性"`）`desc` 含 `迅捷`
（台账 `swift.injection`：主动换入时自动使用）或含 `自己脱离` / `立即替换` 的技能；
再单独统计 build 是否携带。

**关键边界**：主动换人本身是基础行动（台账 `turn_order.priority` 登记「主动换人」存在），
所以「队里没有换入工具」**不等于**「不能换人」。特性里的离场/更换词条（全量技能表里 15 条）
**不计入工具数**，只作为 `pivot.trait_based_unverified` 的未知项报出来。

| 实测 | 值 |
|---|---|
| 学招池里有换入/离场工具的物种 | **28 / 48** |
| 80 个实例的 build 里带换入/离场工具 | **7 / 80** |

### 3.6 `synergy` —— 队内互补（只报计数）

**判据**：对每个类型已知的成员 m，取其弱点集合（`types.json` 里倍率 > 1 的 T），
数**其余成员**里能接 T 的个数 `answers(m,T)`，以及同样弱 T 的成员数 `shared(m,T)`；
`answers = 0` ⇒ 一条 `synergy.unanswered_weakness.<T>.<member>`（`shared ≥ 2` 升一档）；
`shared ≥ 3` ⇒ 另出一条 `synergy.shared_weakness.<T>`。全部是可复算计数。

**不使用**任何社区职能标签（主C/副C/拦截/协防）与体系强弱判断 —— 这些在本仓只作为
multi-label feature 存在于别的层（13 号设计文档 §3），不属于本 RC。

| 实测（80 实例） | 值 |
|---|---|
| 弱点总数（每实例弱点相加） | **304** |
| 每个实例的弱点数分布 | 1 个: 7、2 个: 15、3 个: 10、4 个: 21、5 个: 12、6 个: 12、7 个: 3 |
| 箱子里被某系别克制的实例数 | 火系 30、机械系 29、地系 25、武系 25、翼系 22、草系 21、水系 19、萌系 19、电系 18、冰系 16、恶系 15、光系 14、幻系 14、虫系 14、幽系 12、毒系 8、龙系 3 |

### 3.7 `cost` —— 成本/约束（不可满足即 fail closed）

**判据**：把请求里的硬约束折成算术：

```text
required      = locked ∪ must_include              // 必须留在队里
replaceable   = selected 里不在 required 的条目
kept          = required ∪ selected
free_slots    = team_size − |required|
min_drops     = max(0, |replaceable| − free_slots)
needed_new    = max(0, team_size − |kept|)
pool          = owned（favourites_only=true 时只算收藏）
available     = pool 里未被 kept 占用的条目数（species_unique=true 时按物种去重）
```

| 条件 | 结论 |
|---|---|
| `|required| > team_size` | `cost.unsatisfiable.slots_exceeded` ⇒ **blocking** |
| `min_drops > max_replacements` | `cost.unsatisfiable.churn_limit` ⇒ **blocking** |
| `available < needed_new` | `cost.unsatisfiable.candidate_pool_shortfall` ⇒ **blocking** |
| `required` 里有 owned 一只都没有的 species（且没开 `policy.allow_unowned`） | `cost.unsatisfiable.required_not_owned` ⇒ **blocking** |
| `team_size` 不是整数 | `cost.unsatisfiable.team_size_unknown` ⇒ **blocking** |

任何一条 blocking ⇒ 顶层 `problems` 里出现 `UNSATISFIABLE_CONSTRAINTS` 且 **`ok:false`**。

| 实测 | 值 |
|---|---|
| 候选宇宙（owned 实例） | **80** |
| 收藏实例 | 24 |
| 不同物种 | 48 |

> `must_include` 的「必须拥有」口径是**工程政策**（`policy.team_source = 'owned'`），不是游戏规则：
> 所以这条 gap 的 `confidence` 是 `ENGINE_HYPOTHESIS`，并且显式给出打开
> `policy.allow_unowned = true` 的替代口径。

## 4. 置信等级怎么定

等级只能取台账 `confidence_levels` 里的六级（`OFFICIAL_CURRENT` / `RECORDED_IN_GAME` /
`COMMUNITY_CURRENT` / `CROSS_SOURCE_SUPPORTED` / `ENGINE_HYPOTHESIS` / `UNKNOWN`），
`auditGapDiagnosis()` 会对着**注入的台账**再核一遍。

| 结论来源 | 等级 | 本模块里的例子 |
|---|---|---|
| 冻结层数值（48 只迁移层的面板/配招/学招表）与 `types.json` 克制关系 | `COMMUNITY_CURRENT` | coverage / synergy / respond / pivot / speed 的实测值 |
| 台账登记为 candidate ruleset 的参数 | `CROSS_SOURCE_SUPPORTED` | `cost.mana_rule`（标准 PVP 4 点魔力） |
| 引擎假设（能耗可用性、时序、可满足性算术） | `ENGINE_HYPOTHESIS` | `energy.*`、`speed.turn_order_inference`、`cost.*` |
| 台账标 UNKNOWN 或来源根本没给的量 | `UNKNOWN` | `respond.effect_unverified`、`pivot.trait_based_unverified`、`energy.power_and_effect_unverified` |
| 官方公告 / 项目实机 case | `OFFICIAL_CURRENT` / `RECORDED_IN_GAME` | 本 RC **一条都没有用**：它不依赖任何官方数值 |

**总置信** = 非 `info` 缺口里**最弱**的那一条 —— 诊断整体不会比它最弱的证据更可信。

**「不得升级」是机器判据**：`LEDGER_QUANTITIES` 把台账里 5 个未核实量连**逐字命中句**一起登记：

| 量 | 台账 topic | 台账等级 | severity 上限 |
|---|---|---|---|
| 速度平手（同速谁先动） | `turn_order.priority` | **UNKNOWN** | `medium` |
| 能量上限（6 还是 10） | `energy.max` | `ENGINE_HYPOTHESIS` | `high` |
| 回合末自然回能 | `energy.regen` | `ENGINE_HYPOTHESIS` | `high` |
| 首次入场能量 | `energy.initial` | `CROSS_SOURCE_SUPPORTED` | `high` |
| 标准 PVP 4 点魔力 | `battle_mode.standard_pvp` | `CROSS_SOURCE_SUPPORTED` | `medium` |

依赖某个量的 gap：严重度被压到上限以内，且**必须**在 `unverified[]` 里点名那个量。
台账里那句登记文字被改掉 ⇒ `LEDGER_PATTERN_MISSING`（不再自称「知道它是未知」）。
录屏计划 `data/roco/evidence/rule-evidence-microcase-records.json` 的状态是
`PLAN_ONLY_NOT_EXECUTED`：**MC-E01…MC-E20 一条都没执行**，本模块的 `facts.microcases_executed = 0`。

## 5. 现在算不出来的量（如实列出）

| 量 | 为什么算不出来 | 本模块的处理 |
|---|---|---|
| **实战面板值** | 面板换算公式未校准（10 号文档 §13）；owned 的 `nature` / `talent` / `specialty` / `panel_stats` 全是 `UNKNOWN`，`full-catalog` 对 622 只都自注 `panel_formula` 未知 | 只用静态六维与档位标注；写进 `unverified` |
| **实战速度与先手顺序** | 台账 `turn_order.priority` 的严格总序是 `ENGINE_HYPOTHESIS`；**速度平手 = UNKNOWN** | 只报档位分布，`speed.turn_order_inference` 明确「不据此推断谁先动」 |
| **魔力预算** | 标准 PVP「4 点魔力、力竭 −1」是 `CROSS_SOURCE_SUPPORTED`（台账自注降级风险最高，MC-E08 未执行） | 只登记为 candidate 参数，不参与任何强弱计算 |
| **能量可用性** | 上限（6 vs 10）、回合末回能、入场初始能量三条都没定（MC-E01/E03/E04 未执行） | `energy.build_curve` 只报结构；`unverified` 三条点名 |
| **技能威力与结算时序** | 320 个技能槽里 152 个没有静态威力；冻结层每个技能都自注 `effect_support = unsupported`、未验证触发条件与时序 | fail closed：不写任何伤害数字，不做时序推断 |
| **特性效果** | 特性只登记名称与描述，`engine_status` 多为 `REFUSED`；MC-E17 未执行 | 特性不计入 respond / pivot 工具；只在 `*_unverified` 里点名 |
| **换人/离场语义区分** | 主动换人 / 技能离场 / 力竭补位三种在引擎里未区分（台账 `leave.semantics`，MC-E16 未执行） | `pivot` 只算技能词条，不推断离场触发 |
| **双弱 ×4** | 台账明确「**不再**沿用旧资料里所有双弱 ×4 的说法」，具体分组需逐条核对 | 只读 `types.json` 登记的那一档，不推算 |
| **574 只没有冻结学招表** | owned 生成器对它们 `no_frozen_learnset` skip（四技能与合法性未校验） | energy / respond / pivot 对它们一律 unknown；`cost.build_support` 降级 |
| **版本强弱、体系强弱、胜率** | **本 RC 不做**：没有校准过的离线评测产物 | 不输出；`does_not_rank_or_recommend` 写进报告 |

## 6. 必红方向（8 条反证，逐条打印实际输出原文）

`node --test tests/roco-team-gaps.test.js` 里每条反证都先把正确输出**改坏**，再喂回
`auditGapDiagnosis()`，必须变红；打印出来的就是「实际输出原文」。

| # | 把什么改坏 | 期望的审计码 |
|---|---|---|
| ① | 抹掉某条 gap 的 `machine_evidence`（或证据项缺 `pointer`） | `EVIDENCE_MISSING` |
| ② | `confidence` 写成 `VERY_SURE` / `S_TIER` / 总置信写成台账外等级 | `CONFIDENCE_NOT_IN_LEDGER` |
| ③ | 速度域 `known` 写成 622（或正文写「全 622 只都登记了」，或 `known+unknown≠total`） | `DOMAIN_OVERCLAIM` |
| ④ | 塞 `win_rate: 0.53` / `strength_score: 91` / 正文写「胜率 62%」 | `PSEUDO_PRECISION` |
| ⑤ | 不可满足的结果改成 `ok:true`；或 `ok:false` 却没有 blocking 依据 | `UNSATISFIABLE_NOT_FAILED` |
| ⑥ | 正文写「T0 强势体系，必带」/ 在 value 里挂 `tier: "T0"` | `COMMUNITY_TIER_LABEL` |
| ⑦ | 把依赖 UNKNOWN 量的结论升级成 `high` / `blocking`，或不在 `unverified` 里点名 | `UNKNOWN_ESCALATED` |
| ⑧ | 同一输入两次运行结果不一致（含 `selected` 顺序颠倒、浮点残渣） | 测试直接逐字节比对，不等就 fail |

## 7. 怎么跑

```bash
node --test tests/roco-team-gaps.test.js                      # RC-302 守卫（16 条判据）
RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js # 重新生成 rc-302-team-gaps.json
node --test tests/roco-team-request.test.js                   # RC-301 不许退化
npm run test:unit                                             # 全量单测（末尾已挂上 RC-302）
```

报告 `reports/roco/flagship-upgrade/rc-302-team-gaps.json` 里没有任何挂钟字段，
逐字节可复跑；它包含：七个维度的判据文本、80 个实例上的分布、
未核实量清单（带台账逐字命中句）、`criteria`（14 条判据的**实测值**）、
以及 **13 个不同队伍形态的完整缺口诊断**（逐条带证据与 `unverified`），其中
`churn-limited` / `seven-required` / `must-include-unowned-species` 三个样例是 `ok:false` 的 fail closed 样例，
`legacy-ruleset-cap` 样例演示「换一份规则配置，能耗上限与 over-cap 缺口随之变化」。

## 8. 已知风险与没做到的地方

1. **速度和面板只有 48 只有验证值**：其余 574 只在 energy / respond / pivot / speed 上大面积
   `unknown`。`full-catalog.json` 其实给了 622 条 `stats.spe`，但它自注 `knowledge_only`、
   「面板值为实测」= `is_not`、`panel_formula` 未知 —— 本模块**保守地不采用**，
   并在 `speed.validated_domain` 里把这件事写成实测值（`knowledge_only_species: 622`），
   而不是假装「数据不存在」。
2. **synergy 只算属性相性**：特性/技能互动（护盾、回复、印记、迅捷注入）全部未建模，
   所以「队内互补」是**属性层面的下界**，不是完整互补。
3. **cost 是工程算术**：`max_replacements` 与「候选池够不够」的模型是本仓选定的口径
   （`ENGINE_HYPOTHESIS`），不是游戏规则；`allow_unowned` 开关改变结论，报告里两个口径都留了痕。
4. **respond / pivot 是词条判定**：`desc` 里出现的词不等于机制被实现；
   语义层面一律落在 `*_unverified`，本 RC 不声称任何一个应对/迅捷真的会生效。
5. **覆盖表只覆盖 18 个单系攻击面**：`types.json` 的 102 个双属性键只用于**防御侧查表**，
   不当作攻击面 —— 因为技能的实际攻击系别集合还没有逐条核对完。
6. **报告偏大（磁盘上缩进后的 JSON 约 1.4 MB，紧凑形态约 0.7 MB）**：13 个样例逐条带证据。若下游嫌大，压缩的是样例数量，
   不应压缩 `machine_evidence` —— 那是这个 RC 的全部价值。
