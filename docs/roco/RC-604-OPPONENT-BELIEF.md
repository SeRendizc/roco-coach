# RC-604 对手信念基线（uniform / 公开事实条件化 / frequency）

> 一句话：**「匹配前对手未知」这件事被做成了三条会自报可用性的基线** ——
> 均匀基线给一个**从数据数出来的**分母（无信息，不是强度）；公开事实条件化只用
> **对手已亮明的那只 + 我方阵容 + 模式规模**做可复算的筛选与分层；
> 频次基线需要**真实对局数据**，本仓没有 ⇒ `available:false` + 点名「缺什么、去哪拿」。
> 三条都不产出胜率、不产出伪精确百分数，也不偷看对手的配招与后备。

- 模块：`src/coach/opponent-belief.mjs`
- 判据：`tests/roco-opponent-belief.test.js`（**26 条**：RC-604 原始 13 条 + 03.1 的 H1/H2/H4/H5/R2-R4 5 条
  + 03.2 的候选协议 6 条 + R2 扩展 1 条 + F-03-1 在线段覆盖 1 条；含多类必红反证与反向控制）
- 产物：`reports/roco/rc604/opponent-belief.json`（含 `candidate_protocol` 与候选样本）
- 跑法：`node --test tests/roco-opponent-belief.test.js`
  （重新生成产物：`RC604_WRITE_REPORT=1 node --test tests/roco-opponent-belief.test.js`）
- 进度（2026-09-30）：03.1（公开性口径按实测重写 + 来源必填 + 假设只降权）、
  03.2（候选协议 + 三个可复现局面）与 F-03-1（在线段判据覆盖率）已落地；
  03.3–03.5（证据更新 / 无频率情景集合 / 预算细化）**待做**。

---

## 1. 为什么需要这个模块

`docs/roadmap/FLAGSHIP-V3-CHECKLIST.md` 的 RC-604 行写的是
「对手信念基线（uniform / frequency / 规则策略混合）」。这句话最容易做错的地方不是算法，
而是**把不知道的事情说成知道**：

| 诱惑 | 后果 | 本模块的做法 |
|---|---|---|
| 反正不知道对手要出什么，就写「每只 1/48」 | 48 是**迁移夹具**不是候选宇宙 ⇒ 分母是编的 | 分母**从注入数据现数**（本仓 622；换数据就变） |
| 把 1/N 说成「每只的出现概率」 | 无信息基线被读成版本环境占比 | 必须同时给出「**无信息基线，不是强度判断**」的声明与红线清单 |
| 没有频次数据就拿均匀分布顶上 | 用无信息基线冒充实测 | `available:false` + 点名缺什么、去哪拿 |
| 既然能读到对手后备，就顺手用一下 | 信念变成「偷看之后的答案」，搜索学到的也是偷看 | **隐藏字段出现即拒绝整个输入**，并逐条点名泄漏路径 |
| 用浮点数累加权重，再给个 0.9999 的容差 | 容差是伪精确的温床 | 权重用**整数分子/分母**，合计**恰好** 1 |

## 2. 三条基线

### 2.1 `uniformBelief({catalog})` —— 均匀基线

```js
const belief = uniformBelief({catalog: index});   // index = buildCandidateIndex(await loadTeamCandidatesInputs({root}))
belief.universe_size                 // 622（从注入数据数出来的候选宇宙大小）
belief.expected_per_candidate        // {numerator: 1, denominator: 622, value: 0.001607717042, unit: '…（无信息基线，不是强度、不是胜率）'}
belief.declared_semantics            // 必须含「无信息基线」+「不是」两处声明
belief.red_lines                     // 4 条「这份权重不能用来做什么」
```

- **分母**：候选宇宙大小。认两种输入形状：
  - RC-303 的 `buildCandidateIndex()` 产物（`universeSpecies` + `featureFor()`）——报告与测试走这条；
  - 朴素对象 `{pets: [{species_id, types, speed}], owned: [...]}` —— 小夹具走这条（判据①用它证明分母随数据变）。
  去重口径是**物种**：owned 的 **542** 个物种**全部**落在 pack 的 622 里 ⇒ 本仓实测并集 = 622
  （2026-09-28 前 owned 是 48 个物种；人类这一轮拍板「所有精灵实装」后盒子扩到 542 只，**并集仍是 622**，没变）。
  这个数字不是常量：判据①换一份 3 条的 catalog，要求 `universe_size` 与 1/N 跟着变。
- **`available:false` 的唯一情形**：数不出候选（没注入 catalog / catalog 里一条都没有）⇒
  `unknown_reason = CATALOG_MISSING`。**不写死某个只数（48 / 542 / 600 / 622 都只是举例）来「凑出」一个 1/N。**
- `confidence: ENGINE_HYPOTHESIS`（分母来自数据，但「等权」本身是工程口径）。

### 2.2 `revealedConditioned({catalog, publicFacts})` —— 公开事实条件化

输入是**公开事实**（白名单见 §3），输出是「池子 + 层内等权」的权重。三条规则逐条应用，
每条都写成 `{输入 → 输出 → 依据}`（`rule_ledger[]`）：

| 规则 ID | 类型 | 读什么（公开事实） | 输出 | 依据 |
|---|---|---|---|---|
| `filter.revealed_types` | filter | `opponent_active.types` / `opponent_revealed[].types` | 能接住这些系别的候选数 | 相性表来自 RC-302/303 的冻结 `types.json`（整数标度 ×4，未登记 = unknown，不猜成 1 倍） |
| `filter.opponent_speed_tier` | filter | `opponent_active.spe+spe_source` / `opponent_revealed[].spe+spe_source` | 同档候选数 | **本模块自己**调 RC-303 `speedBandFor()` 现算档位（`speed_band` 三面零命中 ⇒ 不是引擎字段），账本留 `band_source` |
| `weight.own_speed_tier_match` | weight | `own_team[].spe+spe_source` | 选中层 + 层大小 | 「自家最常见**且池子里真的还有候选**的速度层」——工程口径，层内等权；**只降权（2 : 1）不排除** |

**三条不应用（`not_applied`）的情形，都要写清原因**（池子因此更宽——宽是安全的，窄才是编的）：

1. 对手**一条速度档都算不出来**（没有物种级 `spe`）⇒ 速度规则不应用（不自己编一个档位）；
2. 对手**快慢两端都亮明** ⇒ 速度规则也不应用。
   实测踩过的坑：早先的写法在两端亮明时「照两端留」，把三分位分档下的 **mid 档 237 只全剔掉**，
   于是自家是 mid 档的队伍拿到空层 → 整条信念 fail closed；反过来硬选一头又会造出一个
   **看着精确、实际任意**的池子。速度对「他会出什么」不再有区分度时，正确的话是「不知道」。
   ⚠ 03.1 起「选层失败」**不再 fail closed**：退回池内等权基线（`uniform_over_pool_baseline`），
   因为「已亮明系别」那条规则的结果仍然是真信息。
3. 我方阵容**没有一个成员带物种级速度** ⇒ 分层规则不应用（个体面板速度与物种速度**不是同一套量纲**，
   不换算、不硬套；要它生效就传物种级 `spe` + `spe_source`）。

权重的形状（可复算）：

```js
belief.weights = {
  normalization: 'exact_fraction',
  total:   {numerator: 1, denominator: 1, value: 1},      // 合计**恰好** 1（分数，不是浮点容差）
  rows:    [{key, numerator, denominator, value, unit, note}, …],   // 层内 2 份、层外 1 份（**没有一行是 0**）
  basis:              'own_speed_tier_downweight' | 'uniform_over_pool_baseline',   // 必须显式声明
  is_probability:     false,                              // 权重合计 1 只是归一化，不是概率预测
  weight_ratio:       [2, 1],
  baseline_declaration: '…（层内等权仅作基线）',
  assumption:         '…（层间 2:1 是声明过的假设，不排除任何候选）',
  candidate_count: belief.pool_size,
}
belief.pool_ratio = {numerator: pool, denominator: universe, value, unit: '候选池占比（计数比，不是把握度）'}
```

### 2.3 `frequencyBelief({frequencyData})` —— 频次基线

**需要真实对局频次数据。本仓没有 ⇒ `available:false`。**
`unknown_reason` 点名缺什么、去哪拿（三条通路）：

1. **实机对局统计**：游戏内匹配记录 / 赛季数据面板导出（必须带 url 或仓内文件 + 日期）；
2. **玩家自己提供的对局记录**：匿名化的「队伍-出场频次」表，需说明样本量、时间窗与采集方式；
3. **离线联赛 / 自博弈产物**：本仓现在也**没有**，且 RC-601（规则绑定的轨迹重建）还是 `BLOCKED`。

- **绝不**用均匀分布冒充频次（本 RC 最想防的错误）。判据⑤/⑨在两条路上都钉住了它：
  - 正路：不注入数据 ⇒ `available:false`；注入各种「没有来源」的形态（裸数组、缺 `declared_source`、
    缺 `scope`/`revision`、有 ref 没日期、`sources: []`、`count` 不是整数）⇒ **逐个拒绝**且 `weights:null`；
  - 反路：把没有来源的数据改成 `available:true + kind:measured_frequency` ⇒ `FREQUENCY_FAKED`（红）。
- **拒绝的顺序是有意的**：先问「这份数据自己说是从哪来的」，再问「它的行齐不齐」。
  一份裸数组必须先拿到「没有来源声明」这句，而不是「行不可用」——
  后者会让读的人看不到最关键的那句话。
- **接口是活的（反向控制）**：注入一份**带来源**的构造样例（`buildMeasuredFrequencySample()`）后
  `available:true + kind:measured_frequency`，权重 = `count / total`（分数）。样例每行的
  `sources[].measured === false` 且 `revision` 里写着 `constructed` ⇒ 它自报是构造的，
  任何把它当版本数据的用法都越过了它的边界。
- 归一化的分母是**该份频次数据的总次数**（不是候选宇宙大小）：两者是不同的问题，
  本模块不把「出现频次」按候选宇宙去补零（那会编出没见过的候选）。

## 3. 公开性边界（**不偷看**）

口径**按实测**（2026-09-30 · 分计划 03.1 的真引擎三公开面 dump：探针与原始读数见
`reports/roco/product-execution/03/probe-03-public-keys.py` / `probe-03-bench-keys.py`
+ `raw-03.1-engine-public-keys.txt` / `raw-03.1-engine-bench-keys.txt`）：

- 对手**场上**那只：`ui_public_view.opponent.field` 与 `public_planner_state.opponent.field` 都带
  `hp` / `max_hp` / `energy` / `statuses` / `marks`（血条、能量、异常、印记画在屏幕上）；
  UI 面另给 `name` / `types` / `stats` + `stats_source`（**物种级**：`species-panel` / `species-race`，
  `individual-snapshot` 才是个体真值 ⇒ 拒绝）。
- 对手**后备**（`bench[]`）：**未亮明**时只有 `{slot, fainted}`（**没有 `pet_id`**，唯实现
  `env.py::_bench_public_row()`）；亮明之后才追加 `pet_id` / `revealed_via` / `revealed_turn` /
  `revealed_event_seq`，身份走 `view.seen_roster`（= `opponent.revealed_pets[]`）那条路。
- **`speed` / `speed_band` 在三条公开投影里零命中**：速度档是本模块调 RC-303 `speedBandFor()`
  从公开物种速度**现算**的工程三分位构造（换一份图鉴，分位与档位都会变），不是游戏字段；
  裸 `speed` 可能是个体真值 ⇒ 拒绝，只收 `spe` + `spe_source`。

**白名单**（`PUBLIC_FACT_FIELDS`）：

| 事实 | 允许字段 |
|---|---|
| `opponent.active` | `pet_id` / `species_id` / `name` / `slot` / `types` / `stats` + `stats_source` / `spe` + `spe_source` / `hp` / `max_hp` / `energy` / `statuses` / `marks` / `fainted` / `source` |
| `opponent.revealed_pets[]` | 同上（不含 `hp` / `max_hp` / `energy`：后备血量不是公开信息）+ **`revealed_via` + `revealed_turn`（必填）** + `revealed_event_seq` |
| `opponent.bench[]` | **只有** `slot` / `fainted`（多一个键就是越界） |
| `own_team.pets[]` | `key` / `pet_id` / `species_id` / `types` / `stats` + `stats_source` / `spe` + `spe_source`（自己的可以是个体面板）/ `source` / `slot` |
| `mode` | `team_size` / `battle_mode` / `ruleset_config_id` |
| `provenance` | `match_id` / `rules_version` / `decision_id`（01.2 契约三件套，**原样转发**，缺就是 `null`） |

**来源必填**：`revealed_pets[]` 的每一行缺 `revealed_via`（∈ `opening_preview` / `switch` / `replacement`）
或 `revealed_turn` ⇒ `REVEALED_NO_PROVENANCE`；速度 / 面板带个体口径出处（`individual-snapshot`）或无出处
⇒ `REVEALED_INDIVIDUAL_FACTS`。**为什么**：在输入形状上，「公开亮明的整队」与「从私有 state 直读的整队」
长得一模一样，只有来源能区分它们。

**隐藏字段出现即拒绝**（`HIDDEN_FACT_FIELDS`：`moves` / `skills` / `loadout(s)` / `item(s)` /
`nature` / `talent` / `specialty` / `bloodline` / `panel_stats` / `derived_stats` / `build(s)` /
`speed` / `speed_band` / `individual_id` / `panel` / `panel_projection` / `buffs` / `entered_turn`，
顶层还有 `opponent_bench` / `opponent_team` / `opponent_moves`…）：

- **拒绝，不是忽略**。忽略在产出里看不出来（池子只是小了一点），拒绝会在
  `available:false` + `leaked_fields[]` 里**逐条点名** `code:path` ⇒ 泄漏必须可见。
- `leaked_fields[].code` 四类：`HIDDEN_FIELD` / `NO_PROVENANCE` / `INDIVIDUAL_FACTS` / `BENCH_IDENTITY`。
- 白名单外的**未知**键（既不是允许也不是已知隐藏）不进信念，但会记在 `ignored_public_keys[]` 里
  ——不静默丢弃。

## 4. 明确 `available:false` 的项与原因

| 项 | 原因（`unknown_reason`） | 关键点 |
|---|---|---|
| `frequencyBelief()` | `FREQUENCY_NO_DECLARED_SOURCE`（缺**频次数据的来源声明**） | 仓库里没有任何真实对局频次（`meta-prior/v1.json` 的 7 个体系全是 `source:"assumption"` + 均匀假设 `1/7`，自注「不是实测分布」）；去哪拿见 §2.3 |
| `uniformBelief()`（无 catalog 时） | `CATALOG_MISSING`（缺**候选宇宙**） | 没有宇宙就没有分母；不写死一个数字 |
| `revealedConditioned()`（公开事实越界时） | `REVEALED_LEAKED_HIDDEN_FACTS` / `REVEALED_NO_PROVENANCE` / `REVEALED_INDIVIDUAL_FACTS` | 逐条点名 `code:path`，整份拒绝（缺来源与个体口径各有专门的码） |
| `revealedConditioned()`（池子被筛空时） | `REVEALED_EMPTY_POOL` | 空池不是「更精确」，是「没有可说的」 |
| `revealedConditioned()`（选中层为空时） | `REVEALED_EMPTY_STRATUM` | **防御性不变量**：03.1 的 R4 裁决之后权重只降权不压 0，且选中层来自「池子里真的存在的档」⇒ 正常路径不可达；一旦触发说明选择逻辑坏了 |
| `revealedConditioned()`（一条规则都驱动不起来时） | `REVEALED_NO_RULE_APPLIED` | 把均匀分布换个名字交出去就是编 |

> 「我方没有速度数据」**不再**是 fail closed：退回**池内等权基线**
> （`weights.basis = 'uniform_over_pool_baseline'`，显式标记 + `is_probability:false` + 无 0 权重行），
> 因为「已亮明系别」这条规则的结果仍然是真信息。

## 5. 判据（24 条单测 / 判据正文见 `STRUCTURAL_CRITERIA`）

| # | 判据 | 必红方向（注入之后的错误码） |
|---|---|---|
| ① | 均匀基线分母来自数据 | 写死 48 / 600 ⇒ `DENOMINATOR_NOT_FROM_DATA`；**自洽地**连 1/N、`candidate_count` 一起改成 48 ⇒ 注入 catalog 复核后照样红 |
| ② | 1/N 必须带「无信息基线」声明 | 删掉声明与红线 ⇒ `NON_INFORMATIVE_NOT_DECLARED` |
| ③ | 公开事实之外必须**拒绝** | 5 种泄漏输入（配招 / 道具 / 后备身份 / 后备血量 / 性格）各自拒绝；改成「静默过滤后照样出权重」⇒ `PUBLIC_FACTS_BOUNDARY` |
| ④ | 规则账本可复算 | 拆掉 `basis` / `reads` / `output` ⇒ `RULE_LEDGER_INCOMPLETE`；并独立重算「层内等权、层间 2:1、合计恰好 1、**没有一行是 0**」 |
| ⑤ | 频次必须有来源 | 6 种无来源形态全部拒绝 + 理由码；伪造「已测」⇒ `FREQUENCY_FAKED` |
| ⑤b | **反向控制**：有来源的构造样例真的会亮 | `available:true` + `kind:measured_frequency` + 12/19 的分数权重 |
| ⑥ | unknown 不许拿权重顶替 | `weights` / `weights=0` / `pool_ratio` ⇒ `UNKNOWN_BELIEF_HAS_VALUE`；权重合计凑不到 1 ⇒ `AVAILABILITY_SHAPE` |
| ⑦ | 零胜率零伪精确 | `win_rate` 键 / 百分数量纲 / 渲染文本里的「胜率 62%」⇒ `PSEUDO_PRECISION`；**反向控制**：声明边界的句子必须放行 |
| ⑧ | 确定性 | 两次调用、重建索引后逐字节相同；快照不一致 ⇒ `NONDETERMINISTIC` |
| 结构 | 在线段没有引擎 / 子进程 | 塞一行 `step_joint` **到在线函数体里** ⇒ `ONLINE_ENGINE_CALL`；把在线段压空 ⇒ `ONLINE_COVERAGE_INCOMPLETE`（覆盖为空判红，F-03-1 修复） |
| 报告 | 产物与生成逻辑逐字节一致 | 磁盘字节对照 + 每条基线自报 `available/evidence/confidence/unknown_reason` + ≥8 条反证留痕 |
| ⑨ | **注入式**：把 unknown 改成「已测」 | 补一个样本量、换成「声称有来源」的证据 ⇒ `FREQUENCY_FAKED` |
| ⑩ | **注入式**：缺速度值不许自己算档位 | 速度规则 `not_applied` + 写清原因；缺速度时退回**池内等权基线**（`uniform_over_pool_baseline`），池子只由已应用的规则决定 |
| H1 | 来源必填（03.1） | 把隐藏整队当「已亮明」传 ⇒ `REVEALED_NO_PROVENANCE`；公开史相同、隐藏真值不同 ⇒ 候选逐字节相同 |
| H2 | 速度出处（03.1） | 个体面板速度 ⇒ `REVEALED_INDIVIDUAL_FACTS`；裸 `speed` / `speed_band` ⇒ `HIDDEN_FIELD`；**反向控制**：物种级 `stats` + `stats_source` 必须放行 |
| H4 | 可见面板（03.1） | 场上那只的 `hp` / `max_hp` / `energy` / `statuses` / `marks` 收；后备行带 `pet_id` ⇒ `BENCH_IDENTITY`；`{slot, fainted}` 不许误拒 |
| H5 | 契约三件套（03.1） | 缺 `rules_version` ⇒ `PROVENANCE_MISSING` + `unverified` 点名（候选仍出，不自己造版本号） |
| R2/R4 | 假设不许压 0（03.1） | 权重压 0 ⇒ `ASSUMPTION_ZEROES_CANDIDATE`；抹掉 `weights.basis` ⇒ `WEIGHT_BASIS_NOT_DECLARED` |
| 候选①② | 候选协议（03.2） | 不合法技能组合混进 `kept` ⇒ `ILLEGAL_LOADOUT_IN_CANDIDATES`（独立复算 legality）；个体真值不可见 + 保留多解声明 |

反证留痕（22 条**实际输出原文**）在报告 `red_proofs[]` 里逐条可见。
报告正文里的胜率类字样是**被拆开写的**（`胜‹›率`）——报告自己也受「零伪精确」这条判据约束
（`obscureBannedWords()`，实现与测试共用同一个函数）。**`%` 只允许出现在两处**：
判据正文（`criteria[].criteria`，它必须能写「本模块不产出百分数」）与
反证留痕（`red_proofs[]`，那里贴的是「把量纲改成百分比之后审计说了什么」的**被改坏样本原文**）——
两者都不是模块给出的结论；除这两处以外，产物里没有任何百分号（判据⑦与报告自检都扫这一条）。

## 6. 实测（本仓数据，2026-09-24）

| 量 | 值 |
|---|---|
| 候选宇宙 | **622**（pack 622 ∪ owned 48，owned 物种全部落在 pack 内） |
| 带属性 / 带速度的候选 | 622 / 622（`full-catalog.json` 的 `stats.spe` 622 只全有） |
| 均匀基线 1/N | `0.001607717042`（分数 `1/622`，合计恰好 1） |
| 单一 slow 档亮明（报告主样例） | 属性规则 `622 → 461`；速度规则 `461 → 146`；层 = slow，层内等权 `1/146`；池子占比 `0.234726688103` |
| 单一 fast 档亮明 | 池子 **126** |
| 快慢两端都亮明 | 池子 **585**（速度规则**不应用**，只留属性规则的结果） |
| 公开事实全空 | `available:false` + `REVEALED_NO_RULE_APPLIED` |
| `frequencyBelief()` | `available:false` + `FREQUENCY_NO_DECLARED_SOURCE` |
| 接线对照（构造样例） | `available:true` + `total_count=19` + 权重 `12/19 + 7/19 = 1` |

fail closed 的分支也**如实报池子的实况**：`REVEALED_EMPTY_STRATUM`（防御性不变量，正常不可达）会带
`pool_size`（非零，说明池子有候选、只是选中层里没有），`REVEALED_NO_RULE_APPLIED` 会带
`pool_size = 宇宙大小`（说明不是池子空了，而是没有可用条件）——
「池子是空的」与「没有可用的条件」是两件事，产出里必须分得开。
「缺速度」这一支（03.1 起）走**池内等权基线**，`weights.basis = 'uniform_over_pool_baseline'`。

## 7. 候选协议（03.2 · 机器可读）

`readOpponentView(view)` → `publicFacts`；`buildOpponentCandidates({catalog, publicFacts | view, skillPool, budget})`
→ `{candidates[], budget, contradictions[], rule_ledger, provenance, ...}`，协议版本 `rc604-opponent-candidates/v1`。

每条候选带：`basis`（`observed` / `inferred`，**已观察与推测分字段**）· 物种级 `types` / `spe` + 出处 ·
`speed_band` + `band_source`（工程三分位，不是游戏字段）· `observed{slots, reveals, visible_panel}` ·
`skills{known_used, possible, pool_tier, grade, legality}` · `individual_range`（个体真值不可见 ⇒ 保留多解）·
`actions`（只登记已打出来的技能与可能类别，**不预测下一手**）· `sources` · `unknowns` · `rules_version` · `evidence`。

- 技能池分级：`FULL_VERIFIED`（冻结 `learnsets` 12 + `layer-playable-48` 530 = 542）为主；
  缺冻结学招表时才用 `on-demand-builds`（622 只，等级原样取它的 `support`，其中 80 只
  `SIMULATABLE_UNVERIFIED`）。**未验证的不与已验证的同权呈现**。
- 四技能合法性由 `legalSkillLoadout()` 判：不在可学池 / 重复 / 超 4 条 ⇒ 逐条写理由、**一个都不进 `kept`**。
- `contradictions[]`：已亮明却被规则筛出池子（`OBSERVED_NOT_IN_FILTERED_POOL`，实测有）、
  已出招却不在可学池（`USED_SKILL_NOT_LEARNABLE`）——**报出来，不静默丢**。
- 预算：默认 `limit=24`（`budget.rule` 写明缩减规则），被裁掉的部分留下 `pool_summary.dropped_by_band`
  分布（不隐去）。**威胁保留策略在 03.5 细化**。

三个可复现局面（真引擎 view，01/02 留档）与手工 `publicFacts` 栏的读数见
`reports/roco/product-execution/03/03.2-candidates.md`（两栏不混成一份读数）。

## 8. 不做什么（边界）

- **不产出胜率、概率、百分数、强度分、榜单名次**：权重是信念权重与计数比。
- **不偷看**：对手配招 / 道具 / 天赋性格 / 个体面板 / 后备身份与血量不进输入（传进来即拒绝）；
  没来源的「已亮明」也拒绝。
- **不用假设排除候选**：只有公开证据能排除且要写证据 ID；我方速度层次只降权（2 : 1），权重一个都不为 0。
- **不在线跑模拟、不调引擎、不起子进程**：信念只读注入数据（结构判据扫源码在线段）。
- **不做「规则策略混合」的学习版**：任务行里的第三项在本轮落成「规则驱动 + 可复算账本」，
  小型 learned model（以及 frequency 的真实接入）属于后续 RC（RC-602 Ranker / RC-603 Learned Value）。
- **不做候选之间的排序**：层内**完全等权**；层间只有一条**声明过的假设**（2 : 1 降权）。
- **不把频次按候选宇宙补零**：没见过的候选不因为「没出现」而被算成 0 频次（那是另一个问题，
  需要「样本里必须覆盖全宇宙」这个额外前提，本仓没有这种数据）。

## 9. 依赖与「不复制第二套语义」

| 复用什么 | 从哪来 | 为什么不能自己写一套 |
|---|---|---|
| 候选宇宙 / 属性 / 速度值 | `src/coach/team-candidates.mjs` 的 `buildCandidateIndex()` | 候选宇宙的口径（owned ∪ pack、物种去重）只有一份 |
| 属性相性表（整数标度 ×4） | 同上索引的 `scaleByCombo`（RC-302 从冻结 `types.json` 预计算） | 相性两套实现 ⇒ 两个答案 |
| 速度档 | 同上 `speedBandFor()`（候选宇宙内三分位，**本模块现算**并留痕） | 分档两套实现 ⇒ 两个答案 |
| 学招表 / 技能名 | `team-gaps.js` 的 `mergeFrozenLearnsets()`（12 + 530）与 `learnsets[].skill_ids` | 学招表两套 ⇒ 合法性两个答案 |
| 证据形状 / 置信台账六级 | `src/coach/team-compare.mjs`（`evidence`）/ `team-gaps.js`（`CONFIDENCE_LEVELS`） | 台账等级是全域口径 |
| 伪精确禁令词表 | `team-compare.mjs` 的 `BANNED_UNIT_WORDS` | 禁令漂移会让某个模块变成后门 |

## 10. 已知缺陷与未做（如实登记）

- **F-03-1（判据没牙）—— 已修（2026-09-30，Lead 指派）**：`ONLINE_SECTION_MARKER` 的字面量原先写在
  它自己的定义行里，而 `onlineSectionOf()` 用 `indexOf(marker)` 取「它之前」的正文 ⇒ 命中的正是定义行本身，
  「在线段」只剩 68–69 行文件头，**所有在线函数一行都没被扫**（判据声称覆盖在线路径，实际覆盖为空）。
  修法：① 标记常量**下移**到判据/白名单/词表这些声明之后、纯在线代码之前；② `onlineSectionOf()`
  取「定义行之后 → `OFFLINE_SECTION_MARKER` 之前」；③ `OFFLINE_SECTION_MARKER` 上移到
  `beliefReport()` **之前**（否则「离线入口定义」会落进在线段，触发假红）；④ 新增
  `onlineSectionCoverage()` 与 `ONLINE_COVERAGE_INCOMPLETE`：在线段必须**定义全部
  `ONLINE_ENTRYPOINTS`**，覆盖为空即判红。
  读数：改前 `{online_lines: 68, covered_online_entrypoints: 0, hits: []}` →
  改后 `{online_lines: 2079, online_chars: 83135, scanned: 14/14, missing: [], hits: []}`。
- **R7**（候选数量上限的威胁保留策略）留给 03.5；现在只有「可解释缩减 + 分布留痕」。
- **03.3 / 03.4 / 03.5 尚待做**：证据更新（已出技能 / 先手关系 / 可见伤害 ⇒ 收窄候选、保留多解）、
  无频率时的情景集合、预算与截断细化。

## 11. 文件清单

- `src/coach/opponent-belief.mjs`（在线段 + 离线段：`ONLINE_SECTION_MARKER` 之后、`OFFLINE_SECTION_MARKER`
  （在 `beliefReport()` 之前）之前是在线段；覆盖读数见 `onlineSectionCoverage()`）
- `tests/roco-opponent-belief.test.js`（**26 条**，已登记进 `package.json` 的 `test:unit` 枚举清单）
- `reports/roco/rc604/opponent-belief.json`（由测试复跑比对，逐字节；含 `candidate_protocol` 与候选样本）
- `docs/roco/RC-604-OPPONENT-BELIEF.md`（本文）
