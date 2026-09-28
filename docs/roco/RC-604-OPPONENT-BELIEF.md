# RC-604 对手信念基线（uniform / 公开事实条件化 / frequency）

> 一句话：**「匹配前对手未知」这件事被做成了三条会自报可用性的基线** ——
> 均匀基线给一个**从数据数出来的**分母（无信息，不是强度）；公开事实条件化只用
> **对手已亮明的那只 + 我方阵容 + 模式规模**做可复算的筛选与分层；
> 频次基线需要**真实对局数据**，本仓没有 ⇒ `available:false` + 点名「缺什么、去哪拿」。
> 三条都不产出胜率、不产出伪精确百分数，也不偷看对手的配招与后备。

- 模块：`src/coach/opponent-belief.mjs`
- 判据：`tests/roco-opponent-belief.test.js`（13 条，含 12 类必红反证 + 3 条反向控制）
- 产物：`reports/roco/rc604/opponent-belief.json`
- 跑法：`node --test tests/roco-opponent-belief.test.js`
  （重新生成产物：`RC604_WRITE_REPORT=1 node --test tests/roco-opponent-belief.test.js`）

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
| `filter.opponent_speed_tier` | filter | `opponent_active.speed` / `opponent_revealed[].speed` | 同档候选数 | 速度档来自 RC-303 的 `speedBandFor()`（候选宇宙内三分位），本模块不另立分档 |
| `weight.own_speed_tier_match` | weight | `own_team[].speed` | 选中层 + 层大小 | 「自家最常见**且池子里真的还有候选**的速度层」——工程口径，层内等权 |

**三条不应用（`not_applied`）的情形，都要写清原因**（池子因此更宽——宽是安全的，窄才是编的）：

1. 对手**一条速度档都没亮明** ⇒ 速度规则不应用（不自己算一个档位）；
2. 对手**快慢两端都亮明** ⇒ 速度规则也不应用。
   实测踩过的坑：早先的写法在两端亮明时「照两端留」，把三分位分档下的 **mid 档 237 只全剔掉**，
   于是自家是 mid 档的队伍拿到空层 → 整条信念 fail closed；反过来硬选一头又会造出一个
   **看着精确、实际任意**的池子。速度对「他会出什么」不再有区分度时，正确的话是「不知道」。
3. 我方阵容**没有一个成员带速度档** ⇒ 分层规则不应用（不自己算档位）。

权重的形状（可复算）：

```js
belief.weights = {
  normalization: 'exact_fraction',
  total:   {numerator: 1, denominator: 1, value: 1},      // 合计**恰好** 1（分数，不是浮点容差）
  rows:    [{key, numerator, denominator, value, unit, note}, …],   // 逐条候选：层内 1/层大小，层外 0/1
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

口径与引擎逐条对齐：`roco/src/roco_env/env.py::public_planner_state`
（对手**场上**公开：名字 / 系别 / 血条 / 能量 / 异常 / 印记；对手**后备只有**位次 / id / 是否倒下）。

**白名单**（`PUBLIC_FACT_FIELDS`）：

| 事实 | 允许字段 |
|---|---|
| `opponent.active` | `species_id` / `types` / `speed` / `speed_band` / `source` |
| `opponent.revealed_pets[]` | 同上 + `revealed_as` / `revealed_turn` / `fainted` |
| `own_team.pets[]` | `key` / `species_id` / `types` / `speed` / `speed_band` / `source` / `slot` |
| `mode` | `team_size` / `battle_mode` / `ruleset_config_id` |

**隐藏字段出现即拒绝**（`HIDDEN_FACT_FIELDS`：`moves` / `skills` / `loadout(s)` / `item(s)` /
`hp` / `max_hp` / `energy` / `nature` / `talent` / `specialty` / `bloodline` / `stats` /
`panel_stats` / `derived_stats` / `build(s)`，顶层还有 `opponent_bench` / `opponent_team` / `opponent_moves`…）：

- **拒绝，不是忽略**。忽略在产出里看不出来（池子只是小了一点），拒绝会在
  `available:false` + `leaked_fields[]` 里**逐条点名**泄漏路径 ⇒ 泄漏必须可见。
- 白名单外的**未知**键（既不是允许也不是已知隐藏）不进信念，但会记在 `ignored_public_keys[]` 里
  ——不静默丢弃。

## 4. 明确 `available:false` 的项与原因

| 项 | 原因（`unknown_reason`） | 关键点 |
|---|---|---|
| `frequencyBelief()` | `FREQUENCY_NO_DECLARED_SOURCE`（缺**频次数据的来源声明**） | 仓库里没有任何真实对局数据（`meta-prior/v1.json` 的 `distribution[]` 全部 `source:"unknown"` + `value:null`）；去哪拿见 §2.3 |
| `uniformBelief()`（无 catalog 时） | `CATALOG_MISSING`（缺**候选宇宙**） | 没有宇宙就没有分母；不写死一个数字 |
| `revealedConditioned()`（公开事实越界时） | `REVEALED_LEAKED_HIDDEN_FACTS`（输入越界） | 逐条点名路径，整份拒绝 |
| `revealedConditioned()`（池子被筛空时） | `REVEALED_EMPTY_POOL` | 空池不是「更精确」，是「没有可说的」 |
| `revealedConditioned()`（选中层为空时） | `REVEALED_EMPTY_STRATUM` | 权重全 0 的向量不是概率向量 |
| `revealedConditioned()`（一条规则都驱动不起来时） | `REVEALED_NO_RULE_APPLIED` | 把均匀分布换个名字交出去就是编 |

## 5. 判据（13 条 / 12 类必红反证）

| # | 判据 | 必红方向（注入之后的错误码） |
|---|---|---|
| ① | 均匀基线分母来自数据 | 写死 48 / 600 ⇒ `DENOMINATOR_NOT_FROM_DATA`；**自洽地**连 1/N、`candidate_count` 一起改成 48 ⇒ 注入 catalog 复核后照样红 |
| ② | 1/N 必须带「无信息基线」声明 | 删掉声明与红线 ⇒ `NON_INFORMATIVE_NOT_DECLARED` |
| ③ | 公开事实之外必须**拒绝** | 5 种泄漏输入（配招 / 道具 / 体力 / 后备 / 性格）各自拒绝；改成「静默过滤后照样出权重」⇒ `PUBLIC_FACTS_BOUNDARY` |
| ④ | 规则账本可复算 | 拆掉 `basis` / `reads` / `output` ⇒ `RULE_LEDGER_INCOMPLETE`；并独立重算「层内 1/层大小、合计恰好 1」 |
| ⑤ | 频次必须有来源 | 6 种无来源形态全部拒绝 + 理由码；伪造「已测」⇒ `FREQUENCY_FAKED` |
| ⑤b | **反向控制**：有来源的构造样例真的会亮 | `available:true` + `kind:measured_frequency` + 12/19 的分数权重 |
| ⑥ | unknown 不许拿权重顶替 | `weights` / `weights=0` / `pool_ratio` ⇒ `UNKNOWN_BELIEF_HAS_VALUE`；权重合计凑不到 1 ⇒ `AVAILABILITY_SHAPE` |
| ⑦ | 零胜率零伪精确 | `win_rate` 键 / 百分数量纲 / 渲染文本里的「胜率 62%」⇒ `PSEUDO_PRECISION`；**反向控制**：声明边界的句子必须放行 |
| ⑧ | 确定性 | 两次调用、重建索引后逐字节相同；快照不一致 ⇒ `NONDETERMINISTIC` |
| 结构 | 在线段没有引擎 / 子进程 | 塞一行 `step_joint` ⇒ `ONLINE_ENGINE_CALL` |
| 报告 | 产物与生成逻辑逐字节一致 | 磁盘字节对照 + 每条基线自报 `available/evidence/confidence/unknown_reason` + ≥8 条反证留痕 |
| ⑨ | **注入式**：把 unknown 改成「已测」 | 补一个样本量、换成「声称有来源」的证据 ⇒ `FREQUENCY_FAKED` |
| ⑩ | **注入式**：缺速度值不许自己算档位 | 速度规则 `not_applied` + 写清原因；公开事实全空时 `REVEALED_NO_RULE_APPLIED` |

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

fail closed 的分支也**如实报池子的实况**：`REVEALED_EMPTY_STRATUM` 会带
`pool_size`（非零，说明池子有候选、只是选中层里没有），`REVEALED_NO_RULE_APPLIED` 会带
`pool_size = 宇宙大小`（说明不是池子空了，而是没有可用条件）——
「池子是空的」与「没有可用的条件」是两件事，产出里必须分得开。

## 7. 不做什么（边界）

- **不产出胜率、概率、百分数、强度分、榜单名次**：权重是信念权重与计数比。
- **不偷看**：对手后备 / 配招 / 道具 / 体力数值 / 性格天赋不进输入（传进来即拒绝）。
- **不在线跑模拟、不调引擎、不起子进程**：信念只读注入数据（结构判据扫源码在线段）。
- **不做「规则策略混合」的学习版**：任务行里的第三项在本轮落成「规则驱动 + 可复算账本」，
  小型 learned model（以及 frequency 的真实接入）属于后续 RC（RC-602 Ranker / RC-603 Learned Value）。
- **不做候选之间的排序**：`revealedConditioned()` 的层内**完全等权**，它筛不排序。
- **不把频次按候选宇宙补零**：没见过的候选不因为「没出现」而被算成 0 频次（那是另一个问题，
  需要「样本里必须覆盖全宇宙」这个额外前提，本仓没有这种数据）。

## 8. 依赖与「不复制第二套语义」

| 复用什么 | 从哪来 | 为什么不能自己写一套 |
|---|---|---|
| 候选宇宙 / 属性 / 速度值 | `src/coach/team-candidates.mjs` 的 `buildCandidateIndex()` | 候选宇宙的口径（owned ∪ pack、物种去重）只有一份 |
| 属性相性表（整数标度 ×4） | 同上索引的 `scaleByCombo`（RC-302 从冻结 `types.json` 预计算） | 相性两套实现 ⇒ 两个答案 |
| 速度档 | 同上 `speedBandFor()`（候选宇宙内三分位） | 分档两套实现 ⇒ 两个答案 |
| 证据形状 / 置信台账六级 | `src/coach/team-compare.mjs`（`evidence`）/ `team-gaps.js`（`CONFIDENCE_LEVELS`） | 台账等级是全域口径 |
| 伪精确禁令词表 | `team-compare.mjs` 的 `BANNED_UNIT_WORDS` | 禁令漂移会让某个模块变成后门 |

## 9. 文件清单

- `src/coach/opponent-belief.mjs`（在线段 + 离线段，边界由 `ONLINE_SECTION_MARKER` 分开）
- `tests/roco-opponent-belief.test.js`（13 条，已登记进 `package.json` 的 `test:unit` 枚举清单）
- `reports/roco/rc604/opponent-belief.json`（由测试复跑比对，逐字节）
- `docs/roco/RC-604-OPPONENT-BELIEF.md`（本文）
