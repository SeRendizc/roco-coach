# META-PRIOR —— RC-304 前置：版本化「环境先验」契约

> 契约：`data/roco/meta-prior/schema.json` + `data/roco/meta-prior/v1.json`
> 构建器：`scripts/roco/build-meta-prior.mjs`（`--check` / `--json` / `--selftest`）
> 校验器：`scripts/roco/verify-meta-prior.mjs`（`--json` / `--selftest` / `--meta-prior`）
> 共享判据：`scripts/roco/meta-prior-lib.mjs`（构建器、校验器、测试跑的是**同一份**）
> 测试：`tests/roco-meta-prior.test.js`（20 组，含 8 条必红反证 + 8 条结构反证）
> 机器可读报告：`reports/roco/flagship-upgrade/rc-304-metaprior.json`
> 设计依据：`/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §3 / §4；
> `10-SOURCES-AND-CONFIDENCE.md`；台账 `data/roco/evidence/rule-evidence-ledger.json`（只读）
> 上游：RC-302 `src/coach/team-gaps.js`（可复算判据）、RC-303 `src/coach/team-candidates.mjs`（召回 / Beam / 排序）

---

## 1. 一句话

**匹配前不知道对手阵容，所以「队伍强不强」只能对着版本环境分布去说。**
这份先验把「这一版环境里有哪些体系、每个体系凭什么被识别、占比是多少、还缺什么实机证据」
写成一份**能被机器检查**的契约——它现在唯一能做的事是**定义体系与特征轴**，而不是排序。

```text
匹配前 UNKNOWN_PREMATCH（13 号文档 §1：阵容工坊固定 UNKNOWN_PREMATCH）
  → 只能依据版本 Meta prior 说话
  → 环境分布 = 这份先验的 distribution[]
  → 现在 distribution 全部是 unknown + value: null + reason
  → 所以 RC-304 的期望值 / 散度 / 容错**现在无定义**，只能如实返回 unknown
```

---

## 2. 为什么环境先验必须**版本化**

先验不是「一只精灵怎么样」，而是「**这一版环境**长什么样」。同一只精灵在不同赛季、不同规则配置下
可以是完全不同的东西，所以这份先验把四个东西钉在文件头里，缺一不可：

| 字段 | 当前值 | 为什么不能少 |
|---|---|---|
| `season` | `S4「月涌狂想」` | 换赛季环境就换了一版，旧的体系结论不能直接延用 |
| `ruleset_id` | `roco-world-s4-2026-09-10` | 必须与台账、GameDataPack 的规则绑定一致（校验器会逐条对） |
| `ruleset_config_id` | `legacy_sim_v1` | 规则配置不同，判据算出来的东西就不同；`mobile_s4_candidate_v2` 是候选配置 |
| `as_of` | `2026-09-21` | 说的是「这些结论是哪天有效的」，不是构建时间（构建器里**没有挂钟时间戳**） |

`ruleset_config_id` 这一项在本仓有额外含义：默认配置 `legacy_sim_v1` 的能量上限 6 被台账判成
`ENGINE_HYPOTHESIS`（`EV-ENERGY-MAX`），候选配置 `mobile_s4_candidate_v2` 用的是另一套值。
先验**不替 RC-101 做规则选择**，它只把当前绑定如实写下来，让读的人知道这些特征轴是按哪套规则算的。

另外，先验引用谁就必须能核对谁：`derived_from[]` 逐条给出路径 + sha256 + 角色：

```text
rule_evidence_ledger    data/roco/evidence/rule-evidence-ledger.json
game_data_pack          data/roco/game-data-pack/v2/pack.json
ruleset_config          data/roco/rulesets/legacy-sim-v1.json
catalog_reconciliation  reports/roco/reconciliation/catalog-reconciliation.json
pack_schema             data/roco/game-data-pack/v2/schema.json
```

任何一份对应文件变了，sha256 就对不上，校验器立刻红——**先验不是新证据，它只是对已有产物的引用**。

---

## 3. 体系清单（v1 实测）

七个体系全部来自 13 号文档 §3 点名的 archetype seed：

> 「毒、翼王、陨星、萌化、冰、沙暴、武等体系作为版本 archetype seed，是否仍强由版本数据和评测决定。」

| archetype_id | label | 种子数 | feature_axes | confidence | 逐条证据等级 | 待录证据 |
|---|---|---:|---|---|---|---:|
| `poison_stack` | 毒系消耗 | 28 | coverage/synergy/respond/energy | ENGINE_HYPOTHESIS | 社区 1 / 工程假设 2 | 2 |
| `wing_king_flyer` | 翼王飞翼 | 1 | speed/pivot/coverage | ENGINE_HYPOTHESIS | 跨源 1 / 工程假设 2 | 2 |
| `meteor_burst` | 陨星爆发 | 2 | energy/coverage/cost | ENGINE_HYPOTHESIS | 跨源 1 / 工程假设 2 | 2 |
| `sugar_morph` | 萌化叠层 | 5 | energy/respond/synergy | ENGINE_HYPOTHESIS | 社区 1 / 工程假设 2 | 2 |
| `ice_control` | 冰系控场 | 32 | coverage/speed/respond | ENGINE_HYPOTHESIS | 社区 2 / 工程假设 1 | 2 |
| `sandstorm_weather` | 沙暴天气 | **0** | coverage/respond/pivot | ENGINE_HYPOTHESIS | 跨源 1 / 工程假设 2 | **3** |
| `fighting_press` | 武系压制 | 24 | coverage/speed/energy | ENGINE_HYPOTHESIS | 跨源 1 / 社区 1 / 工程假设 1 | 2 |

逐条证据共 21 条，等级分布（`reports/roco/flagship-upgrade/rc-304-metaprior.json#evidence_confidence`）：

```text
OFFICIAL_CURRENT        0
RECORDED_IN_GAME        0     ← 一条实机证据都没有
COMMUNITY_CURRENT       5
CROSS_SOURCE_SUPPORTED  4
ENGINE_HYPOTHESIS      12
UNKNOWN                 0
```

**没有任何一条是 `OFFICIAL_CURRENT` 或 `RECORDED_IN_GAME`。** 这不是保守，这是实况：
本仓没有录屏、没有匿名对局、没有离线联赛产物；台账里唯一的两条官方一手证据
（极速对决 3v3、领地试炼 2v2）都不是「哪个体系强」的证据，所以它们不出现在这里。

每条证据还带一个 `ledger_entry` 锚点，指回台账里真正支撑它的那一条：

```text
21 条证据 = 14 条 13 号文档 §3 / §4 锚点（每个体系各 2 条，ENGINE_HYPOTHESIS）
          +  6 条台账 EV-* 条目（现读等级与首要来源）
          +  1 条仓内数据面锚点（冻结层 skills.json，作者自注 effect_support = unsupported）
去重后只有 9 个不同 ref；等级分布见上表。
```

锚点是**现读现比**的：构建器从台账读该条目的 `confidence` 与**首要来源 URL**，与引用表里抄的那份比，
不一致就直接拒绝构建（`等级只有台账那一份`）。校验器再独立核对一次：
`ledger_entry` 不在台账里、等级对不上、或者 `ref` 与台账首要来源不同，都会报 `EVIDENCE` / `CONFIDENCE`
（反证⑤c 实测三条全红）。所以「台账里翻不到的那条来源」进不了这份先验。
证据的 `ref` 因此是**逐条可点开**的：`https://wiki.biligame.com/nrc/深渊罗隐`、
`https://news.17173.com/content/03182026/104940843.shtml`、
`roco/src/roco_env/env.py#L59`、`data/roco/normalized/roco-world-s4-2026-09-10/skills.json` ……

### 3.1 「沙暴天气」为什么种子是空的（如实登记的缺口）

这是本轮唯一一个**没有可核对载体**的体系，值得单独写清楚：

```text
skills.json 里 desc 含「沙暴」的技能 3 条：沙涌 / 扬尘 / 流沙统治者
冻结迁移层 learnsets.json 覆盖 12 只精灵
→ 这 12 只里**没有任何一只**学得到上面三条
→ 所以 seed_species 只能是 []
```

按契约，空种子**必须显式声明** `seed_selection.source = "none_available"` + 写清 note + `needs_recording` 非空，
否则校验器判红（`SEED_SPECIES`）。这条判据防的正是「静默降级成一个空体系」：
一个空体系如果长得跟正常体系一样，读的人会以为它只是没填。

这不是「沙暴不存在」，而是「本仓现有的可核对面里没有沙暴的载体」——需要更全的学招数据或实机录屏。

### 3.2 种子物种是怎么选出来的（不许手写榜单）

每个体系都带 `seed_selection`，说明这批种子**怎么被选出来**，四选一：

| selector.kind | 含义 | 用在哪 |
|---|---|---|
| `named_in_authority` | 名字在权威文档里被点名 | 翼王（13 号文档 §3 点名「翼王」→ `圣羽翼王`） |
| `name_contains` | 名字包含某个字符串 | 陨星（`陨星虫` / `落陨星兔`） |
| `type_tag_main_forms` | pack 里 `record_kind = pet_record` 且 `tags.types` 含某系 | 毒系（28）/ 冰系（32）/ 武系（24） |
| `learnable_move_keyword` | 冻结迁移层 learnsets 里学得到 `desc` 含某关键词的技能 | 萌化（5）/ 沙暴（0） |

**可复算的那一份是 selector，`default_seeds` 只是人工挑出的代表元。** 两者都写进 v1.json，
读的人可以自己跑一遍 selector 复算。种子物种数量实测 92 个，全部在 pack 的 504 个 pet 名字里逐字命中。

### 3.3 feature_axes 复用 RC-302，不许自创形容词

`feature_axes[].criterion` **只能**是 `src/coach/team-gaps.js#DIMENSION_CRITERIA` 的键：

```text
coverage  属性防御键 × 18 个攻击系别：有没有成员倍率 < 1（有抗性）
speed     冻结迁移层 roster-48.json 的 speed_tier 梯度；没有档位的一律 unknown
energy    成员具体 build 四个技能在 skills.json 的 energy vs 本次 ruleset 的 energy.max.value
respond   学招池 / build 里 skills[].desc 的「应对攻击 / 应对状态 / 应对防御」词条计数
pivot     desc 含「迅捷」（台账 swift.injection）或「自己脱离 / 立即替换」的技能计数
synergy   answers(m,T) / shared(T) 的可复算计数
cost      locked ∪ must_include / max_replacements / 候选池 的可满足性算术
```

判据是**结构判据**：`criterion` 不在上面七个键里就红（`CRITERION`），连 `axis` 写错也红。
测试里把 `criterion` 改成「看起来很压制」再跑同一判据，实测输出：

```text
[CRITERION] archetypes[poison_stack].feature_axes[0].axis：axis 不在 RC-302 的七维里："看起来很压制"
[CRITERION] archetypes[poison_stack].feature_axes[0].criterion：criterion 不是 src/coach/team-gaps.js#DIMENSION_CRITERIA 的判据 ID：
  "看起来很压制"（合法 ID：coverage / speed / energy / respond / pivot / synergy / cost）——先验不许自创形容词
```

---

## 4. `measured` 与 `unknown`：本任务最重要的一条

`distribution[]` **只允许两种形态**：

```jsonc
// ① measured：真的有一份可核对的来源，逐条给 ref + date + confidence
{
  "archetype_id": "poison_stack",
  "source": "measured",
  "value": 0.3,
  "unit": "share",
  "sources": [
    {"ref": "https://…", "date": "2026-09-21", "confidence": "COMMUNITY_CURRENT", "claim": "……"}
  ],
  "value_source": {"availability": "available", "ref": "…"}   // 或 not_available + 说明
}

// ② unknown：我们没有真实对局数据 → 如实写不知道
{
  "archetype_id": "poison_stack",
  "source": "unknown",
  "value": null,
  "unit": null,
  "sources": [],
  "reason": "仓库里没有任何真实对局数据（录屏 / 匿名对局 / 离线联赛产物都没有），所以……"
}
```

**当前实测：`measured 0 项 / unknown 7 项`，`distribution_source = "unknown"`。**

判据（构建器 fail closed，校验器与测试各自再拦一遍）：

| 形态 | 必须满足 | 违反时报的码 |
|---|---|---|
| `measured` | `sources` 非空且逐条可核对 + `date` + 台账六级 `confidence` | `DISTRIBUTION` / `EVIDENCE` / `CONFIDENCE` |
| `measured` | `value` 是有限数值 | `DISTRIBUTION` |
| `measured` | `value_source` 写清这个数值本身出自哪里（`available` + 可核对 ref，或 `not_available`） | `DISTRIBUTION` |
| `unknown` | `value === null` | `DISTRIBUTION` |
| `unknown` | `reason` ≥ 12 字符 | `DISTRIBUTION` |
| `unknown` | **不挂** `sources`（挂了会让「不知道」看起来像有依据） | `DISTRIBUTION` |

为什么连「一个看起来合理的数字」都不能填：环境占比是所有下游结论的**分母**。
分母编出来之后，`expected_meta_value`、`matchup_spread`、`worst_archetype` 全都会建在沙子上，
而且它们看起来跟真的一样。**宁可输出 unknown，也不输出一个没人能核对的数。**

---

## 5. 为什么**禁止**把攻略排名变成胜率

13 号文档 §3 原文：

> 攻略中的「T0」不能直接转成胜率标签。

具体到本仓，这句话落成三条硬约束：

1. **等级只有台账那一份**。`confidence` 只能取台账六级
   （`OFFICIAL_CURRENT / RECORDED_IN_GAME / COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED / ENGINE_HYPOTHESIS / UNKNOWN`），
   先验不许自造等级（反证⑤实测：写成 `VERIFIED_OFFICIAL` 立刻红）。
   `COMMUNITY_CURRENT` 的社区攻略**不得**升成 `OFFICIAL_CURRENT`——只有官方一手或项目自己保存的
   可复核实机 case 才能直接 promotion（10 号文档「重要订正」）。

2. **键名禁令是结构性的**。先验任何层级都不许出现 `win_rate` / `tier` / `T0` / `strength_score`
   一类的**键名**，写成 `null` 也照样红（反证①）。为什么连 `null` 也拦：
   `win_rate: null` 读起来像「这个字段以后会填」，而不是「我们不产出这种东西」。

3. **弱判据也要有牙**。先验是 JSON，真正的风险不在键名而在**散文**里——
   「这只的胜率是 62%」可以直接写进 `notes`。所以还有一条文本判据：命中禁词且**前面 12 个字符里
   没有否定词**，就进 `soft_problems`（不判红，但必须有人解释）。否定语境豁免是必要的：
   否则实现方会为了躲判据而删掉「本先验不输出胜率」这句话——那正好删掉了最该保留的一句。

```text
[实际输出] 反证⑭：真写了「这只的胜率是 62%」这类正面结论必须进弱判据
  soft_problems 2 条：
    archetypes[0].notes → 文本里出现禁词「胜率」，而它前面 12 个字符里没有任何否定词
    archetypes[0].notes → 文本里出现禁词「%（伪精确百分数）」，而它前面 12 个字符里没有任何否定词
```

---

## 6. RC-304 将怎样消费它

`usage.inputs` 写成**字段说明**（`definition` / `inputs` / `honesty` 三栏），不是散文。
五个口径就是 13 号文档 §4 那五条：

| 口径 | 定义 | 现在能不能算 | 诚实边界（`honesty`） |
|---|---|---|---|
| `expected_meta_value` | 六宠队伍对版本对手分布的期望表现 | **不能** | 分布 unknown 时禁止输出任何数值型期望；只能标 unknown 或给相对排序且附 `ENGINE_HYPOTHESIS` |
| `worst_archetype` | 最怕的**主流**体系 | **不能** | 「主流」= 分布；分布 unknown 时只能输出「按**结构判据**算最吃亏的体系」，并注明它不是「最主流」 |
| `matchup_spread` | 是否严重依赖撞到特定阵容 | **不能**（缺 matchup bank） | 没有逐体系表现估计时禁止报散度数值，只能报「无法计算」并列出缺失产物 |
| `execution_tolerance` | 次优操作下掉多少 | **不能** | 规则本身还在 candidate 阶段（严格总序仍是 `ENGINE_HYPOTHESIS`）时，容错数值一定是伪精确 |
| `coverage_confidence` | 六宠 build 的规则与数据覆盖 | **能**（唯一一条） | 它是**自我描述**（我们知道自己知道多少），不是实力判断；覆盖率低时必须 fail closed |

一句话：**这份先验现在只能用来定义体系与特征轴，不能用来排序队伍。**
RC-304 拿到它之后，前四个口径必须如实返回 unknown，第五个口径可以做。

---

## 7. 必红判据（每条都给「什么输入必须让它红」）

| 码 | 方向 |
|---|---|
| `SCHEMA` | 顶层 schema / `meta_prior_id` 不对，或 `version_scope` 四缺一 ⇒ 红 |
| `BANNED_KEY` | 任何层级出现胜率 / 榜单 / 强度分一类**键名**（写成 `null` 也算）⇒ 红 |
| `ARCHETYPE_SHAPE` | 体系缺必填字段、`archetype_id` 不合 `^[a-z][a-z0-9_]*$`、id 重复 ⇒ 红 |
| `SEED_SPECIES` | `seed_species[]` 里的物种在 pack 的 pet 实体里不存在 ⇒ 红；空种子不声明 `none_available` ⇒ 红 |
| `CRITERION` | `feature_axes[].criterion` 不是 RC-302 已实现的判据 ID（自创形容词）⇒ 红 |
| `EVIDENCE` | 某条 `evidence` 的 `ref` 既不是 http(s)、也不是仓里真实存在的文件，或缺 `date` ⇒ 红；`ledger_entry` 不在台账里、或 `ref` 与台账首要来源不同 ⇒ 红 |
| `CONFIDENCE`（台账锚点） | 逐条证据的等级与它指向的台账条目不一致（自己抄一份抬高了等级）⇒ 红 |
| `CONFIDENCE` | `confidence` 用了台账六级之外的等级 ⇒ 红 |
| `DISTRIBUTION` | `measured` 却没来源 / 没 `value_source`；`unknown` 却带非 null `value` 或没 `reason` ⇒ 红 |
| `USAGE` | `usage.inputs` 缺 RC-304 五个口径之一，或某个口径没有可读说明 ⇒ 红 |
| `DERIVED_FROM` | 缺必需角色、引用的文件不存在、或 sha256 与磁盘不一致 ⇒ 红 |
| `CHECK` | `--check` 时磁盘上的 v1.json 与重新构建的结果不一致（含排序）⇒ 红 |

反证的**实际输出原文**逐条留痕在三处：

1. `reports/roco/flagship-upgrade/rc-304-metaprior.json#red_proofs[]`：15 条必红方向**现场重放**一次，
   每条带 `expect_code` / `where` / `passed` / `actual`（去掉 `meta_prior_id` 漂移后的真实报错原文）；
2. 同一个报告的 `criteria[]`：10 条判据的判据文本 + 实际值 + 是否通过；
3. 测试运行日志：每条反证都 `console.log('  · [实际输出] …')` 打印改坏之后的完整问题清单。

`--selftest`（构建器与校验器各一份，跑的是同一份库）自带 16 条用例：
正向 1 + 必红 13 + 弱判据 1 + 可复跑 1。
`tests/roco-meta-prior.test.js` 有 20 组，全部打印实际输出
（对象压成单行，避免 `node --test` 日志截断后看不出实际值到底是什么）。

---

## 8. 怎么跑

```bash
node scripts/roco/build-meta-prior.mjs            # 写 data/roco/meta-prior/v1.json
node scripts/roco/build-meta-prior.mjs --check    # 只核对磁盘上的是不是与重建一致
node scripts/roco/build-meta-prior.mjs --selftest # 构建器自带正反用例
node scripts/roco/verify-meta-prior.mjs           # 校验（rc=0/1）
node scripts/roco/verify-meta-prior.mjs --json    # 机器可读结论（stdout），问题走 stderr
node scripts/roco/verify-meta-prior.mjs --selftest
node --test tests/roco-meta-prior.test.js
RC304_WRITE_REPORT=1 node --test tests/roco-meta-prior.test.js   # 重新生成 rc-304-metaprior.json
```

`--meta-prior <path>` 是给**取证**用的：报告里要贴「改坏之后真实的报错原文」，
而反证不许写盘改真文件——把改坏的副本写到 `/tmp`，再用这个开关指过去即可。

---

## 9. 诚实边界（没做到 / 有风险）

- **没有任何真实对局数据。** 分布只能全部是 `unknown`，`expected_meta_value` / `matchup_spread` /
  `execution_tolerance` / `worst_archetype` 现在**都算不出来**。本先验现在只能用来定义体系与特征轴，
  **不能用来排序队伍**，更不能说哪个体系强。
- **一条实机证据都没有。** 21 条证据里 `RECORDED_IN_GAME` 为 0；台账里唯一两条官方一手证据
  与「体系强弱」无关。所以每个体系的 `confidence` 实测都是 `ENGINE_HYPOTHESIS`（取该体系最弱的一条证据）。
- **`sugar_morph` 的判据只覆盖 12 只迁移层精灵。** `learnable_move_keyword` 选择器只能看
  `learnsets.json` 的 12 只；全量 622 只的学招数据不在冻结层里。所以「萌化只有 5 只」应读成
  「**本仓现在能核对的**只有这 5 只」，不是「游戏里只有 5 只」。
- **`sandstorm_weather` 是空体系。** 见 §3.1；它被如实登记为 `none_available`，不是被静默删掉。
- **`type_tag_main_forms` 的种子是「所有主形态」，不是「代表元」。** 毒系 28 只、冰系 32 只、
  武系 24 只全是主形态枚举。这样可复算，但读起来不像榜单那么短——这是刻意的取舍：
  **可复算优先于好看**。
- **`ruleset_config_id` 绑定的是 `legacy_sim_v1`（默认配置），不是候选配置。** 候选配置
  `mobile_s4_candidate_v2` 换了能量上限等参数，会让 `energy` 轴算出来的东西不同；本先验不替 RC-101 做选择。
- **14 条证据引用的是 `/tmp` 下的交付包路径。** `13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` 不是仓内文件，
  `/tmp` 一旦被清理，这 14 条 `ref` 就核不动了（校验器会红，构建器会直接拒绝重建）。
  要长期保留就必须把交付包收进仓库或转成仓内文档——那一步本轮**没有做**，这是本先验最大的外部依赖风险。
- **弱判据会漏肯定句里的一部分表达。** 否定豁免窗口是「命中词前 12 个字符」，
  一段很长的、把否定词放得很远的句子可能被误判成 `soft_problems`（不判红，人工复核即可）。
- **本先验只是契约，不是评测。** 它不跑模拟、不产标签、不做校准；离线联赛 / 自博弈 / matchup bank
  这些产物一旦出现，`distribution` 才有机会从 `unknown` 变成 `measured`。
