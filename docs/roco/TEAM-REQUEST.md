# RC-301 `RecommendationRequest` 合同

> 这份文档说明**怎么用**这份合同、**为什么标准 PVP 匹配前必须 `UNKNOWN_PREMATCH`**、
> **LLM 只出 schema 的边界在哪**，以及它与 RC-302/303/304 的分工。
> 合同本体是 `src/coach/team-request.js`（纯函数、零依赖）；工具入口在
> `src/coach/toolbox.js` 的 `request_team_recommendation`；机器可读报告在
> `reports/roco/flagship-upgrade/rc-301-team-request.json`。

## 1. 它解决什么问题

配队请求里有一类错误**不会报错**，只会悄悄把结论带偏：

| 静默失效 | 后果 |
|---|---|
| 模型把没说过的约束补成默认值 | 玩家没要求锁定，系统却「贴心地」钉死三只 |
| 模型把不存在的精灵/模式/规则集当成存在的 | 幻觉 id 一路进到下游，最后算出一套不存在的队伍 |
| 匹配前假设已知对手 | 用一套具体敌队算出的「强」，上线遇到别的阵容就崩 |
| 「随便配一队」被编成一份六只名单 | 用户看到的是**编造的确定性**，不是「还不知道」 |

`RecommendationRequest` 就是把这四件事挡在**进入推荐链路之前**：
把自然语言变成一份**显式、可校验、可追责**的请求对象；说不清就 `ok:false` + 缺什么。

## 2. 合同字段

字段的**唯一**事实源是 `REQUEST_FIELDS`（`src/coach/team-request.js`）。
每个字段都有 `kind` / `required` / `semantics`，有默认值的字段还必须有 `default_reason`
或 `derived_from`——不允许出现「这个字段为什么是这个值」说不清的情况。

| 字段 | 形状 | 必填 | 默认 | 语义要点 |
|---|---|---|---|---|
| `mode` | 枚举（注册表 id） | ✅ | `pvp-standard-six-pet` | 必须来自 `data/roco/battle-modes.json`；不许自创 |
| `team_size` | 整数（由 mode 推导） | ✅ | 由 `mode.parameters.team_size` 代入 | 标准 PVP = 6、极速对决 = 3；对不上就拒；注册表没写就拒 |
| `visibility` | 枚举 | ✅ | `UNKNOWN_PREMATCH` | 标准 PVP 默认且首选匹配前口径 |
| `must_include` | instance_id / species_id 数组 | — | `[]` | 必须进最终队伍 |
| `must_exclude` | 同上 | — | `[]` | 不许进最终队伍；与 `must_include` 有交集即拒 |
| `locked` | instance_id 数组 | — | `[]` | 钉死不许换；`locked ⊆ must_include ∪ selected` |
| `selected` | instance_id 数组 | — | `[]` | 已进槽位（0～team_size）；RC-303 以它为基础补全 |
| `max_replacements` | 非负整数 | — | `null` = **未指定** | `0` 与「没限制」是两件事 |
| `favourites_only` | 布尔 | — | `false` | 候选池收窄到收藏；与「必须带非收藏」冲突时拒 |
| `preference` | 枚举（可选） | — | `null` | `gentle` / `brief` / `detailed`；只影响措辞 |
| `ruleset_config_id` | 注册表 id | ✅ | 由 `mode.ruleset_binding` 代入 | 必须出现在 `data/roco/rulesets/*.json` |
| `opponent_roster` | 引用数组 | 条件 | `null` | 只有 `KNOWN_SCENARIO` 允许且必须有值 |
| `constraints` | 固定键布尔对象 | — | `null` | 键只能是 `no_duplicate_instances` / `species_unique` / `avoid_unknown_mechanics` |

**引用一律真实存在**：`instance_id` 对着 `data/roco/owned/owned-pets.json` 查，
`species_id` 对着 `data/roco/game-data-pack/v2/pack.json` 的 pet 实体查，
`mode` / `ruleset_config_id` 对着注册表查。查不到就是拒——不是「放行」。

## 3. 怎么用

```js
import {loadRecommendationInputs, validateRecommendationRequest, requestFromNaturalLanguage}
  from './src/coach/team-request.js';

const inputs = await loadRecommendationInputs();          // 只在 Node 侧：读四份登记数据

// ① 结构化输入：模型/前端给的就是合同字段
const direct = validateRecommendationRequest({mode: 'pvp-standard-six-pet', must_include: ['pet_000012']}, inputs);
// → {ok:true, request:{...规范化后的请求}, problems:[], info:[...]}

// ② 自然语言输入：抽取器只做「自然语言 → 候选 schema」，产出**必须**再走同一份校验
const mapped = requestFromNaturalLanguage('标准PVP，队伍里必须有铠甲虫', inputs);
// → ok:true 时 mapped.request 是同一形状；ok:false 时 problems 逐条点明缺什么/错在哪
```

工具层（`src/coach/toolbox.js`）：

```js
import {executeRequestTeamRecommendation} from './src/coach/toolbox.js';
await executeRequestTeamRecommendation({natural_language: '标准PVP，带上铠甲虫'}, {recommendationInputs: inputs});
// → {ok, request, problems, info, doesNotRecommend:true, needs, contract, source}
```

**回执里只有「经校验的请求 + 校验问题 + 信息」**。没有候选名单、没有排序、没有胜率。
`doesNotRecommend: true` 是显式声明；测试逐键比对回执键集合，并断言
`candidates` / `ranking` / `recommendation` / `win_rate` 这些字段不会出现。

### 为什么这个工具**不**进 `TOOL_CONTRACTS`

`TOOL_CONTRACTS` 不只是「工具表」，它同时是三处既成事实的输入：

1. `src/coach/shadow-tools.js` 的 `TOOL_LABELS` 必须逐个覆盖它的键
   （`tests/evals/shadow-tools.test.js` 逐键核对）；
2. 那份**已发布评测**的 user 提示把 13 个工具名与提示 SHA-256 钉成了字面量
   （`PROMPT_DIGEST_PIN` / `PROMPT_CHAR_COUNT` / `CAMP_PROMPT`）；
3. `runtime.js` 的 `gatherAgentEvidence` 用 `Object.keys(TOOL_CONTRACTS)` 决定
   「模型能提议哪些工具」。

所以往里加一个工具会顺手改掉已发布评测的口径。RC-301 的做法是把合同做成**独立合同**
（参数校验 + 执行入口 + 回执形状齐全），要不要把它接进模型可见的工具列表，是**另一个**
需要单独处理的决定（要同时更新面板标签、评测提示与钉子）。本 RC 明确不改那三处。

## 4. 为什么匹配前必须 `UNKNOWN_PREMATCH`

事实与产品前提（见 `13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §1/§4）：

- 「匹配前不知道对手阵容」是**产品场景**（待录屏核实到更强证据，但产品流程如此）；
- 入局后能看到对方**精灵**，配招与策略仍然未知 —— 这是两种不同的信息状态，必须分开建模；
- 匹配前能依据的只有**版本 Meta prior**，不是某一支具体敌队。

于是合同把三种状态显式化，并且**不让它们互相冒充**：

| `visibility` | 允许的推理 | 禁止的推理 |
|---|---|---|
| `UNKNOWN_PREMATCH`（标准 PVP 默认且首选） | 对版本环境分布求期望（RC-304 的 `expected_meta_value`） | 「他一定会派 X」这类具名对手推理；给出 `opponent_roster` 直接判红 |
| `VISIBLE_ROSTER_IN_BATTLE` | 已知对方精灵列表，配招/策略仍需假设 | 把可见 roster 当成完整信息 |
| `KNOWN_SCENARIO` | 对手条目已知，可针对 | 不给 `opponent_roster`（判 `OPPONENT_INFO_REQUIRED`） |

两条方向相反的判据都在实现里：

- `visibility=KNOWN_SCENARIO` 但没有对手信息 ⇒ `OPPONENT_INFO_REQUIRED`（拒）；
- `visibility=UNKNOWN_PREMATCH`（或入局可见 roster）却给出具体对手 ⇒ `OPPONENT_INFO_NOT_ALLOWED`（拒）。

标准 PVP 下用非首选可见性**不是错误**（例如玩家在匹配后回来复盘），但会被记一条
`VISIBILITY_NOT_DEFAULT` 信息：下游不得把它当成匹配前口径。这一条是「不静默」，
而不是「一刀切禁止」。

## 5. LLM 只出 schema：边界在哪

分工是合同的一部分，不是实现细节：

```text
玩家原话 ──LLM/抽取器──► 候选 schema ──程序校验──► 经校验的请求 ──RC-303──► 候选队伍
                              │                        │
                         只说「映射」              唯一的对错判据
```

抽取器（`requestFromNaturalLanguage()`）**只做映射**：

**能做**（`natural_language_mapping.can`，报告里带 9 条可通过样例）：

- 模式说法 → 注册表 id（标准PVP / 极速对决 / 领地试炼 / 练习局）；
- 「N 只」→ `team_size`（阿拉伯数字与中文数词）；
- 「匹配前/不知道对面」「入局后看到」「对手是…」→ 三种 `visibility`；
- 「带上/必须有 X」「别带/排除 X」「锁定/不许换 X」→ `must_include` / `must_exclude` / `locked`；
- 「只要收藏的」「不要重复」「说详细一点」→ `favourites_only` / `constraints.species_unique` / `preference`；
- 「对手是 X」→ `opponent_roster`（并因此落到 `KNOWN_SCENARIO`）。

**不能做**（`natural_language_mapping.cannot`，报告里带 8 条判红样例）：

- **不补默认值**：没说的字段不写进候选 schema。`mode` / `visibility` 的默认由 `validate`
  代入，并且**一定**留一条 `DEFAULTED_FIELD`（写明「这是代入的，不是调用方给的」）；
- **不猜名字**：认不出的名字进 `UNRESOLVED_MENTION`，`ok:false`，不映射成任何一只；
- **不发明 id**：`mode` / `ruleset_config_id` 只能来自注册表；
- **不选一边**：同一句话里出现互斥信号（两种模式 / 两种可见性 / 两个队伍规模）时
  `CONTRADICTORY_FLAGS`；
- **不产出推荐**：它只输出候选 schema；队伍名单、排序、解释都不是它的事；
- **不做同义词消解**：断词、简称、错别字、方言说法覆盖有限；
- **不做全句语义解析**：「多个名字 + 连接词 + 后置动词」（如「铠甲虫还有熔岩巨兽都带上」）
  这类句子后半段可能既没被映射、也报不出 `UNRESOLVED_MENTION`，于是 `ok:true` 但
  `must_include` 比人读到的少。这是**已知覆盖缺口**：调用方必须把原话与 schema 一起看。

## 6. 错误码

完整清单在报告 `error_codes`（每条都带 `direction` = 必红方向）。分四组：

| 组 | 码 |
|---|---|
| 形状 | `INVALID_TYPE`、`MISSING_FIELD`、`INVALID_ENUM` |
| 未知即拒 | `UNKNOWN_FIELD`、`UNKNOWN_CONSTRAINT_KEY` |
| 引用真实性 | `UNKNOWN_MODE`、`UNKNOWN_RULESET`、`UNKNOWN_INSTANCE_ID`、`UNKNOWN_SPECIES_ID`、`UNKNOWN_OPPONENT`、`MODE_TEAM_SIZE_UNKNOWN` |
| 矛盾/不可满足 | `MODE_TEAM_SIZE_MISMATCH`、`LOCKED_NOT_SELECTED`、`LOCKED_EXCLUDED_CONFLICT`、`MUST_INCLUDE_EXCLUDE_OVERLAP`、`SELECTED_OVER_TEAM_SIZE`、`SELECTED_HAS_EXCLUDED`、`LOCKED_FAVOURITES_ONLY_CONFLICT`、`FAVOURITES_ONLY_EMPTY_POOL`、`MUST_INCLUDE_HAS_UNOWNED_SPECIES`、`TEAM_CONSTRAINT_WITHOUT_NAMES`、`OPPONENT_INFO_REQUIRED`、`OPPONENT_INFO_NOT_ALLOWED` |
| 自然语言 | `UNRESOLVED_MENTION`、`NO_REQUEST_INTENT`、`CONTRADICTORY_FLAGS`、`MODE_SIZE_WITHOUT_MODE` |

信息码（不是错误，但必须让下游知道来源）：`DEFAULTED_FIELD`、`DERIVED_FIELD`、
`SORTED_LIST`、`EMPTY_LIST`、`VISIBILITY_NOT_DEFAULT`、`CONSTRAINT_NOTE`、`MODE_NOTE`。

`ok:false` 时 `request` 恒为 `null`——**判红就不给任何半成品**，避免调用方「将就用一下」。

## 7. 与 RC-302 / 303 / 304 的分工

| RC | 它吃什么 | 它产出什么 | 与 RC-301 的边界 |
|---|---|---|---|
| **RC-301（本 RC）** | 玩家原话 / 结构化字段 | **经校验的请求对象** + 校验问题 | 不产名单、不排序、不给胜率 |
| RC-302 缺口诊断 | 经校验的请求 + 候选池 | coverage / speed / energy / respond / pivot / synergy / cost，每条带证据与置信 | 读 `must_include` / `locked` / `selected` 决定「缺口算给谁」 |
| RC-303 候选生成 | 经校验的请求 | 召回 20～50 → Beam 补全六宠 → Top-K（0～5 只时增量推荐下一只） | 硬约束（`must_include`/`must_exclude`/`locked`/`max_replacements`/`favourites_only`）由 RC-301 保证自洽；RC-303 不许再放宽 |
| RC-304 未知对手比较 | 请求的 `visibility` + 候选队伍 | expected value / 最差体系 / matchup spread / 容错 / 覆盖置信 | `UNKNOWN_PREMATCH` 下只能对版本 Meta prior 求期望；`KNOWN_SCENARIO` 才允许具名对手 |

一句话：**RC-301 负责「这份请求说不说得通」，RC-302/303/304 负责「这套阵容强不强」。**

## 8. 怎么验证它没退化

```bash
node --test tests/roco-team-request.test.js      # 17 个 test（含 8 组必红反证）
npm run test:unit                                # 既有套件必须仍绿（817 条）
node --test tests/evals/tool-arguments.test.js   # 既有工具参数判据必须仍绿
```

报告（`reports/roco/flagship-upgrade/rc-301-team-request.json`）由
`buildRc301Report()` 生成，测试会**复跑并逐字节比对**；两者不一致即红。
要重新生成：

```bash
RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js
```

报告里的 `criteria`（25 行，比 test 多，是因为「未知即拒」「引用真实性」等每一类都单独一行）
逐条给出 `text` / `expected` / `actual` / `actual_output`：`actual_output` 是**实际调用的原文**
（问题行或回执对象），红了就地看得出差在哪，
`natural_language_mapping` 给出能/不能两组样例的**实际问题文本**，
`does_not_produce_recommendations` 是「本 RC 不产生推荐结果」的机器可读声明。
