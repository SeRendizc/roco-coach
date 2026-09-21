# RC-204 RAG 索引与 held-out 评测

> 施工日期：2026-09-21。语料：`data/roco/game-data-pack/v2/pack.json`（1446 实体）、
> `data/roco/evidence/rule-evidence-ledger.json`（20 条分级结论）、`data/roco/rulesets/*.json`（2 份配置）、
> `data/roco/owned/owned-pets.json`（80 个个体）。语料**只读**，本任务没有改动它们。

## 0. 一句话结论

新索引（实体/别名 + 结构化过滤 + BM25 + evidence/ruleset rerank + 弃答）在主集 45 条查询上
Recall@1/3/10 = 1.000、MRR = 1.000、版本命中率 = 1.000、grounded precision = 1.000、
④ 类弃答率 = 1.000；**同一份语料**上的词法基线（复刻 `strategist.js` 的分词与加权配方）是
Recall@1 = 0.706、Recall@10 = 0.941、MRR = 0.781、版本命中率 = 0.333、弃答率 = 0.000；
现有 `searchKnowledge` 原样在 pack 的 id 空间里全部为 0（它表达的是另一套 id，见 §4 的说明）。

**但这个 1.000 不是泛化能力**：主集的措辞是在看过检索行为之后改过的（污染声明见 §9.1），
另外的 13 条探针（写完只跑一次）里有 **1 条未按预期**。诚实结论在 §9，不在这一句。

## 1. 五类查询

`data/roco/rag/heldout-queries.json`，schema `roco-rag-heldout-queries/v1`。

| 类别 | 条数 | 是什么 | 期望值来源 |
| --- | --- | --- | --- |
| ① `entity_alias` | 9 | 名字 / 形态名 / 编号 / game_id / owned 个体；含**只在公网索引里标记的形态**（冻结 title 无后缀、公网 data-form=lord/regional）与只在冻结 title 里出现的描述性形态名 | `pack` 的 entity_key |
| ② `skill_mechanic` | 8 | 技能标签、特性双属性，以及印记/迅捷/离场/触发面/倍率分档等机制结论 | 台账条目 id |
| ③ `rule_version` | 8 | 哪套 ruleset 配置、默认/候选状态、某字段在哪一版写成多少、台账条目的实机挂点 | 配置字段 / 台账条目 |
| ④ `conflict_abstain` | 11 | 期望结论**就是弃答**：身份冲突未解决、等级不足、语料里根本没有该名字 | pack 冲突条目 / 台账 / 缺席证明 |
| ⑤ `lineup_counter` | 9 | 六宠口径、魔力与力竭、对手未知的产品前提、模式参数化、属性倍率、按属性筛实体 | 台账条目 / pack 实体 |

每条查询的字段：`id` / `category` / `query` / `expected` / `acceptable_entity_keys[]` /
`evidence_level_expected` / `why`，另有机器可校的 `derived_from`（`kind` + `ref` + `anchors`）
与可选的 `min_evidence_level` / `requires_ruleset_config_id`。

### ① 实体/别名（9）

| id | 查询 | 期望 | 期望等级 |
| --- | --- | --- | --- |
| E01 | 雪绒鸟在公网索引里被标成地区形态了吗 | `pet::pet_000420` | COMMUNITY_CURRENT |
| E02 | 彩虹独角兽在公开索引里是首领形态吗 | `pet::pet_000535` | COMMUNITY_CURRENT |
| E03 | 编号 002 是哪个精灵 | `pet::pet_000001` | COMMUNITY_CURRENT |
| E04 | 哪个精灵的 game_id 是 3001 | `pet::pet_000001` | COMMUNITY_CURRENT |
| E05 | 蓬松的样子说的是哪只鸭吉吉的形态 | `pet::pet_000011` | COMMUNITY_CURRENT |
| E06 | 抓挠在公网索引里算什么类别 | `battle_skill::skill_000246` | COMMUNITY_CURRENT |
| E07 | own-0001 是哪只精灵的个体，带哪几个技能 | `owned::own-0001` | COMMUNITY_CURRENT |
| E08 | 偏振这个特性的双属性标注是什么 | `trait::skill_000001` | COMMUNITY_CURRENT |
| E09 | 缓一缓在公网索引里带什么标签 | `battle_skill::skill_000337` | COMMUNITY_CURRENT |

「只在公网索引里出现的形态」由 pack 的 `form_axis.assignments[].divergence` 提供：
E01/E02 两条的冻结 title 没有形态后缀（`frozen.title.plain`），公网侧却标了
`regional` / `lord`（`live.form.*`），所以「地区/首领」这个标记只在公网那一侧存在。
描述性形态名（E05 的「蓬松的样子」）反过来只在冻结 title 的括号里存在。

### ② 技能/机制语义（8）

| id | 查询 | 期望 | 期望等级 |
| --- | --- | --- | --- |
| M01 | 印记在精灵下场之后会不会消失 | `EV-MARKS-PERSISTENCE` | COMMUNITY_CURRENT |
| M02 | 精灵主动换上来的时候迅捷会自动放技能吗 | `EV-SWIFT-INJECTION` | COMMUNITY_CURRENT |
| M03 | 离场包括哪些情形，力竭下场算吗 | `EV-LEAVE-SEMANTICS` | COMMUNITY_CURRENT |
| M04 | 技能耗能存在 8 的情况吗 | `EV-ENERGY-COST8-EXISTS` | COMMUNITY_CURRENT |
| M05 | 特性触发面都覆盖了哪些时机 | `EV-TRAITS-TRIGGER-COMPLEXITY` | COMMUNITY_CURRENT |
| M06 | 应对和先手这些机制是真实存在的吗 | `EV-TURN-ORDER-MECHANISMS-EXIST` | CROSS_SOURCE_SUPPORTED |
| M07 | 属性倍率一共有哪几档 | `EV-TYPE-MULTIPLIER` | COMMUNITY_CURRENT |
| M08 | 吞噬这个技能在公网索引里的属性是什么 | `battle_skill::skill_000269` | COMMUNITY_CURRENT |

### ③ 规则与版本（8）

| id | 查询 | 期望 | 期望等级 |
| --- | --- | --- | --- |
| R01 | S4 现在默认用哪一套 ruleset 配置 | `ruleset_config::legacy_sim_v1` | ENGINE_HYPOTHESIS |
| R02 | 哪套配置被标成不能当默认 | `ruleset_config::mobile_s4_candidate_v2` | ENGINE_HYPOTHESIS |
| R03 | 候选配置把常规能量上限施工成多少 | `ruleset_config::mobile_s4_candidate_v2#energy.max` | CROSS_SOURCE_SUPPORTED |
| R04 | 默认配置里能量上限写的几 | `ruleset_config::legacy_sim_v1` | ENGINE_HYPOTHESIS |
| R05 | 候选配置里首次入场能量填了吗 | `ruleset_config::mobile_s4_candidate_v2` | UNKNOWN |
| R06 | 台账里能量上限那条结论挂在哪张 microcase | `EV-ENERGY-MAX` | CROSS_SOURCE_SUPPORTED |
| R07 | 哪条台账说回合末自然回能被多源反驳 | `EV-ENERGY-ENDTURN-REGEN` | ENGINE_HYPOTHESIS |
| R08 | 哪份配置的 status 写着 LEGACY_BASELINE_BIT_EXACT | `ruleset_config::legacy_sim_v1` | ENGINE_HYPOTHESIS |

### ④ 冲突/证据不足（11，必须弃答）

| id | 查询 | 弃答原因（实测） |
| --- | --- | --- |
| C01 | 同速时多次录像能看出谁先动吗 | EVIDENCE_LEVEL_INSUFFICIENT（配置里 `turn_order.speed_tie`=null/UNKNOWN） |
| C02 | 初次入场到底给几点能量，实机测过吗 | EVIDENCE_LEVEL_INSUFFICIENT（`EV-ENERGY-INITIAL`，MC-E04 未录） |
| C03 | 聚能能不能突破能量上限 | EVIDENCE_LEVEL_INSUFFICIENT（`EV-ENERGY-CHARGE`：是否突破上限未定） |
| C04 | 回合末会自然回一点能量吗 | EVIDENCE_LEVEL_INSUFFICIENT（`EV-ENERGY-ENDTURN-REGEN` 只有 ENGINE_HYPOTHESIS 且被多源反驳） |
| C05 | 应对和换宠谁先结算，这条严格总序有官方文字吗 | EVIDENCE_LEVEL_INSUFFICIENT（`EV-TURN-ORDER-STRICT` 自注「不得写成规则」） |
| C06 | 我的个体面板换算公式有吗 | EVIDENCE_LEVEL_INSUFFICIENT（owned 的 `nature/talent/...effect`=UNKNOWN） |
| C07 | 冻结层和公网索引的字段值逐条比过吗 | EVIDENCE_LEVEL_INSUFFICIENT（`VALUE_CONFLICT`：不是「没有差异」，是「没比过」） |
| C08 | 幽影树的突变样子对应哪个 id | UNRESOLVED_IDENTITY_CONFLICT（`CF-UNRESOLVED-0001`） |
| C09 | 腾挪这个特性该算哪一条 | UNRESOLVED_IDENTITY_CONFLICT（`CF-UNRESOLVED-0002`） |
| C10 | 保卫和好象坏象到底是特性还是技能 | UNRESOLVED_IDENTITY_CONFLICT（`CF-UNRESOLVED-0003/0004`） |
| C11 | 破晓之刃这把武器在语料里有吗 | NO_MATCH（缺席证明：全语料 name/title 不含该词） |

### ⑤ 阵容/克制（9）

| id | 查询 | 期望 | 期望等级 |
| --- | --- | --- | --- |
| L01 | 标准 PVP 到底带几只，官方确认过吗 | `EV-PVP-STANDARD-TEAM-SIZE` | CROSS_SOURCE_SUPPORTED |
| L02 | 标准 PVP 的魔力点数按几点施工 | `EV-PVP-STANDARD-MANA` | CROSS_SOURCE_SUPPORTED |
| L03 | 力竭以后魔力怎么扣，会直接判负吗 | `EV-PVP-FAINT-MANA-LOSS` | CROSS_SOURCE_SUPPORTED |
| L04 | 匹配之前看不到对手阵容，这算规则吗 | `EV-PVP-UNKNOWN-OPPONENT` | ENGINE_HYPOTHESIS |
| L05 | 进对局之后能看见对面哪几只，配招也能看见吗 | `EV-PVP-OPPONENT-ROSTER-VISIBLE` | COMMUNITY_CURRENT |
| L06 | 极速对决是几打几，几点魔力 | `EV-PVP-SPEED-DUEL-MODE` | OFFICIAL_CURRENT |
| L07 | 领地试炼那种模式要单独参数化吗 | `EV-BATTLEMODE-PARAMETERIZED` | OFFICIAL_CURRENT |
| L08 | 草毒双属性的海神球形态是哪几只精灵 | `pet::pet_000016`（可接受：000016/000017/000018/000537） | COMMUNITY_CURRENT |
| L09 | 光草双属性的圣草迪莫是什么形态 | `pet::pet_000559` | COMMUNITY_CURRENT |

「对手未知」的语料出处是 L04：`EV-PVP-UNKNOWN-OPPONENT` 明说这是**产品场景**
（`UNKNOWN_PREMATCH`），不是可引用的游戏规则；所以它只能当先验，不能当事实。

### held-out 的三条硬判据

1. **不逐字泄漏**：`checkLeakage` 做两个方向 ——
   (a) 归一化后**完全包含**（任一条文档文本含有整条查询）；
   (b) **最长逐字重合** ≤ 8 个中文字符（字符级 DP；候选先用 bigram 倒排缩小，
   共享长度 ≥2 的连续子串必然共享 bigram，所以这个筛选不漏）。
   ASCII 标识符（配置 id / status / 证据 id / 编号）在 (b) 里先被屏蔽：
   原样引用 `LEGACY_BASELINE_BIT_EXACT` 是**结构化查找**，不是抄散文；完全包含判据仍用原文。
   实测：45 条里最长逐字重合 = **7**（上限 8）。
2. **不与既有 fixture 撞题**：与 `tests/evals/retrieval.json` + `tests/evals/retrieval-extended.json`
   共 148 条查询做归一化字符串交集 = **0**；同时报出最高 token Jaccard = 0.1667
   （留作「语义相近但不同题」的透明指标）。
3. **期望值可追**：`checkDerivation` 逐条核对 `derived_from.ref` 是否存在、`anchors` 是否真的
   出现在被引用记录里；`pack_absence` 类反过来做全语料反向扫描（任何 name/title 命中就判红）。
   45 条实测 0 问题。

## 2. 索引层 `src/coach/rag-index.js`

在 `strategist.js` 的既有能力**之上**新增，**没有**改动既有卡片检索的行为（只把 `tokens`
加上 `export`，好让同语料基线用**同一个**分词器，否则基线差里会混进分词差异）。

语料 → 1678 条文档：

| record_kind | 条数 | 说明 |
| --- | --- | --- |
| `battle_skill` | 579 | pack 技能实体 |
| `pet_record` / `pet_form` | 460 / 162 | pack 精灵记录与形态记录 |
| `trait_record` | 245 | pack 特性 |
| `ledger_entry` | 20 | 台账条目（含 claim / sources / microcase 挂点） |
| `conflict_record` / `conflict_policy` | 99 / 1 | pack 的冲突条目与冲突登记政策（含「没比过」的原文） |
| `ruleset_config` | 32 | 2 份配置的根文档 + 按路径拆出的字段段落文档 |
| `owned_instance` | 80 | owned 个体（含 `effect_reason` 与 provenance 指针） |

四层能力与它们各自的可证伪点：

- **实体/别名表**：名字、带括号的完整 title、括号内容（形态名）、去掉括号的 basename、
  编号、`game_id`、职业、系别、形态轴标签、**实体 id / entity_key**。
  名字/形态名权重高（3 / 2.5），系别与形态轴标签权重压到 0.05 —— 它们一次能命中上百条文档，
  权重大了就是噪声。数字类别名（编号 / game_id）必须落在**数字边界**上，否则「编号 002」
  会命中查询里的「3001」（E04 就是这条的反例守护）。
- **结构化过滤**：`record_kind`（精灵/技能/特性/台账/配置/个体/冲突）与 `source_scope`
  （公网索引 / 冻结快照）按查询里的显式词做硬过滤；**过滤把更好的候选滤掉时退回不过滤**，
  并在 `intent.filter_fallback` 里如实标记（主集里 M01/M02/M04/M05 触发了退回——
  它们的句子里有「精灵」「技能」，而正确答案在台账里。这是设计要处理的真实情况，不是隐藏项）。
  「哪套配置」「不能当默认」这类问题用 `is_default`、`config_level` 做属性过滤（权威属性，
  不按分数退让）；显式提到「哪条台账 / 哪套配置 / 我的个体 / 冲突」时答案空间只有 2～100 条，
  这时**不设相关性门槛**（见 §5 的门槛标定）。
- **BM25（纯 JS）**：字段级（名字 / 别名 / 正文）分别算 idf 与长度归一，`k1=1.2, b=0.75`，
  无外部依赖、无模型调用。
- **evidence / ruleset rerank**：只在**相关性门槛之上**的候选之间微调（等级 + 版本 + provenance），
  不允许把不相关但等级高的记录顶上来。
- **可选向量**：**没做**。没有本地嵌入模型、也不联网；接口留在 `searchIndex` 的 `vector` 选项上
  （传 `{embed, docs}` 才走余弦加成），报告里写 `NOT_IMPLEMENTED`。硬塞假向量只会造出不可复跑的指标。

### 弃答是合法结论

`searchIndex` 返回 `{abstained, reason_code, reason, results}`，三种原因：

| reason_code | 触发条件 | 主集里的例子 |
| --- | --- | --- |
| `UNRESOLVED_IDENTITY_CONFLICT` | 候选命中 pack 里 `status=UNRESOLVED` 的实体，且查询没给比名字更具体的消歧词（实体 id / 带括号完整 title） | C08 C09 C10 |
| `EVIDENCE_LEVEL_INSUFFICIENT` | 查询带了 `min_evidence_level`，而最强候选的证据等级弱于它；原因里附上候选 id 与它的等级 | C01–C07 |
| `NO_MATCH` | 过滤后（或退回后）没有任何候选过相关性门槛 | C11 |

## 3. 指标定义

设 `K ∈ {1,3,10}`，`answerable` = `expected !== 'ABSTAIN'` 的查询，`keys` = `expected` ∪
`acceptable_entity_keys`。**根文档与它的字段段落视为同一条配置**：
`id === key`、`id.startsWith(key + '#')` 或 `key.startsWith(id + '#')` 都算命中
（`ruleset_config::legacy_sim_v1` 与 `ruleset_config::legacy_sim_v1#energy.max` 同粒度互换）。

| 指标 | 定义 | 分母 |
| --- | --- | --- |
| Recall@K | `keys` 命中 top-K 的 answerable 查询占比 | answerable |
| MRR | 首个命中位置的 `1/rank` 的均值（未命中记 0） | answerable |
| 实体命中率 | top-10 里出现任一 `keys` 的 answerable 查询占比（= Recall@10） | answerable |
| 版本命中率 | top-1 的 id 或其 `ruleset_config_id` 等于查询要求的配置 id 的比例 | 带 `requires_ruleset_config_id` 的查询 |
| grounded precision | 抽样（每条查询的 top-1，含弃答时被引用的那条候选）里，provenance/证据**能追到磁盘**的比例 | 抽样条数 |
| 冲突弃答率 | `expected=ABSTAIN` 的查询里真的返回弃答的比例 | ④ 类（含任何期望弃答的查询） |
| 弃答精确率 | 系统弃答的查询里**本来就该**弃答的比例（防守过度弃答） | 系统弃答的查询 |
| 证据等级匹配率 | top-1 的证据等级**不弱于** `evidence_level_expected` 的比例 | answerable |

**grounded 的判定不是「有没有 provenance 字段」**：`groundDocument` 逐条检查
artifact 文件存在、`artifact_sha256` 与磁盘一致、首条 `pointer` 能在该 artifact 上解析到值；
台账条目检查等级在六级内且每条 source 带 marker/level/url；配置文档检查文件存在且 sha256 命中。
逐项判定原文都在报告的 `grounded.rows[].checks` 里。

**证据等级**用台账那六级，顺序与 `scripts/roco/evidence-ledger-lib.mjs` 的 `CONFIDENCE_ORDER`
**逐字一致**（runner 启动时 `deepEqual` 对一次，对不上直接抛；测试里再对一次）：
`OFFICIAL_CURRENT > RECORDED_IN_GAME > COMMUNITY_CURRENT > CROSS_SOURCE_SUPPORTED > ENGINE_HYPOTHESIS > UNKNOWN`。
文档自身的等级取它**来源里最强的一级**（wiki 快照/公网索引 → COMMUNITY_CURRENT，
台账条目 → 它自己的 `confidence`，配置文档 → 配置里出现的最强一级，owned → COMMUNITY_CURRENT）。

## 4. 基线 vs 新索引（实际数字）

三套检索器跑同一份 45 条 held-out 查询、同一份语料：

| 检索器 | Recall@1 | Recall@3 | Recall@10 | MRR | 实体命中 | 版本命中 | 冲突弃答 | 弃答精确率 | 等级匹配 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 基线A：现有 `searchKnowledge` 原样 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | n/a | 0.000 |
| 基线B：同语料、只换词法层 | 0.706 | 0.824 | 0.941 | 0.781 | 0.941 | 0.333 | 0.000 | n/a | 0.971 |
| 新版：`rag-index` | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** |

分类对照（answerable 条数 / Recall@10 / MRR）：

| 类别 | 基线A | 基线B | 新版 |
| --- | --- | --- | --- |
| ① 实体/别名（n=9） | 0.000 / 0.000 | 0.889 / 0.744 | 1.000 / 1.000 |
| ② 技能/机制语义（n=8） | 0.000 / 0.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| ③ 规则与版本（n=8） | 0.000 / 0.000 | 0.875 / 0.483 | 1.000 / 1.000 |
| ④ 冲突/证据不足（n=11） | 不适用（不弃答） | 0.000 弃答率 | 1.000 弃答率 |
| ⑤ 阵容/克制（n=9） | 0.000 / 0.000 | 1.000 / 0.889 | 1.000 / 1.000 |

**怎么读这张表（不许只看对自己有利的那一套）**：

- 基线A 全 0 **不是**「旧实现差」，而是**它根本不表达 pack 的 id**：`searchKnowledge` 返回
  `tactic:* / rule:skill:*` 这类卡片 id，与 `pet::pet_000420` / `EV-MARKS-PERSISTENCE` /
  `ruleset_config::legacy_sim_v1` 不是同一套 id 空间。把它当成能力对比是错的；
  它的价值是回答「**实体/版本类问题它压根覆盖不到**」，所以 ② 以外全部为 0。
- 真正同口径的对照是**基线B**（同一份语料、同一分词器、字段加权 tf、无 idf/无长度归一、
  无别名、无过滤、无 rerank、不弃答）。差值是**新增的那几层**贡献的，不是语料不同。
- 基线B 最弱的两处正好是新索引的强项：**③ 规则与版本**（0.875 R@10 / 0.483 MRR / 0.333 版本命中）
  与 **④ 弃答**（基线B 没有弃答这个概念，弃答率 0.000）。
- 基线B 在 ② 上与新版打平（1.000 / 1.000）：机制类问题的正文里本来就有「印记」「迅捷」这些词，
  别名表与 idf 在这里没有增量。这是**如实报出的无差异项**。
- 两套基线都跑了、都写进报告（`metrics.baseline_searchKnowledge` / `metrics.baseline_lexical_pack`），
  闸门 `baselines_reported` 会检查三套都在。

## 5. 门槛标定（不是拍脑袋）

相关性门槛 `SCORE_FLOOR = 25` 只作用于**普通路径**；命中强意图词的查询把答案空间钉死
（2～100 条），走 `floor = 0`。实测两组数字（`score_calibration`）：

```text
普通路径上「被判定为相关」的候选最低分 = 44.563765
无对应实体时（缺席探针 C11）最高分      = 13.315217
门槛                                    = 25
```

即：普通路径上，真正的相关候选最低也有 44.6 分，而语料里根本没有该实体时最高只有 13.3 分，
25 落在两者之间。强意图路径的两个数字（8.21 / 0.00）低于门槛，是因为那条路径**根本不看门槛**
——这是设计，不是巧合（报告里也这么写）。

## 6. 判据清单（13 组，全部通过）与必红方向

`runGates` 的实际输出：

```text
[rag-eval] ok   coverage: 总计 45 条（≥40）；各 entity_alias=9 skill_mechanic=8 rule_version=8 conflict_abstain=11 lineup_counter=9
[rag-eval] ok   leakage: 45 条里最长逐字重合 = 7 字符（限 8）
[rag-eval] ok   fixture_intersection: 与 148 条既有 fixture 的交集 = 0；最高 token Jaccard = 0.1667
[rag-eval] ok   derivation: 45 条期望值的出处在语料里逐条追到
[rag-eval] ok   abstain_consistency: 弃答与命中口径一致：期望弃答 11 条，全部未被算成命中
[rag-eval] ok   conflict_abstention: ④ 类弃答率 = 1（11 条）
[rag-eval] ok   grounded: grounded precision = 1（抽样 44 条 top-1）
[rag-eval] ok   version_hit: 版本命中率 = 1（6 条版本查询）
[rag-eval] ok   evidence_level: 等级声明全部在六级内；等级不弱于期望的比例 = 1
[rag-eval] ok   baselines_reported: 三套检索器都有指标：baseline_searchKnowledge, baseline_lexical_pack, rag_index
[rag-eval] ok   query_manifest: 清单一致：45 条，sha256=03a600a25048…
[rag-eval] ok   probe_reported: 探针 13 条；未按预期 1 条（失败也登记，不过闸门）
[rag-eval] ok   no_clock: 正文（除 metadata.generated_at）不含挂钟时间戳
[rag-eval] 判据 13/13 通过；报告写入 reports/roco/rag/rag-eval.json
```

| 判据 | 判据文本 | 实测值 | 必红方向（什么输入必须让它红） |
| --- | --- | --- | --- |
| `coverage` | 五类各 ≥8、总计 ≥40 | 45 条；9/8/8/11/9 | 删掉任一类的一条（使其 <8）或总数 <40 |
| `leakage` | 单条文档最长逐字重合 ≤8 且不被完全包含 | 最长 7 | 把任一 query 原文塞进语料 |
| `fixture_intersection` | 与既有 fixture 归一化后交集为空 | 0（148 条） | 把一条 fixture 的 `q` 换成 held-out 的 query |
| `derivation` | ref 存在 + anchors 命中；absence 类反向扫描 | 45/45 | 编一个语料里不存在的 entity_key 当期望值 |
| `abstain_consistency` | 期望弃答的查询 hit@K 必须为 false | 11 条全为 false | 让 runner 把 ABSTAIN 算成命中 |
| `conflict_abstention` | ④ 类弃答率 = 1.0 | 1.000（11 条） | 把 C01 的 `min_evidence_level` 拿掉（它会返回配置字段） |
| `grounded` | grounded precision = 1.0 | 1.000（抽样 44 条） | 抹掉任一条结果的 provenance |
| `version_hit` | 版本命中率 = 1.0 | 1.000（6 条） | 把 R01 的 `requires_ruleset_config_id` 改成另一套配置 |
| `evidence_level` | 等级在六级内且不弱于期望 | 1.000 | 把某条 `evidence_level_expected` 改成 `RECORDED_IN_GAME`（语料达不到） |
| `baselines_reported` | 三套检索器都有完整指标 | 3/3 | 从 `RETRIEVERS` 里删掉基线 |
| `query_manifest` | 查询集清单（总数/分类/sha256）与声明一致 | sha256=03a600a2… | 删改一条查询而不更新 `query_manifest` |
| `probe_reported` | 探针 ≥10 条且逐条给出结论 | 13 条 | 探针集缺失或条数不足 |
| `no_clock` | 正文不含挂钟时间戳 | 通过 | 把 `generated_at` 写到 metadata 之外 |

## 7. 六条必红反证（实际输出原文）

`node scripts/roco/eval-rag-retrieval.mjs --selftest`（退出码 0）：

```text
[selftest] ok   R1 把 E01 的 expected 改成 EV-BATTLEMODE-PARAMETERIZED → 该条 hit@1=false（原 true）；Recall@1 1 → 0.9705882352941176
[selftest] ok   R2 删掉 ④ 类查询 C01 → 清单判据=红（声明 45 条 → 实际 44 条）；弃答分母 11 → 10
[selftest] ok   R3 抹掉 pet::pet_000011 的 provenance → grounded precision 1 → 0.9772727272727273；grounded 判据=红
[selftest] ok   R4 把 ABSTAIN 也算成命中 → abstain_consistency 判据=红；问题=11 条
[selftest] ok   R5 把 E01 的查询原文塞进语料 → 泄漏条数=1；E01 泄漏：contained_in=["injected::leak"] max_lcs=18（限 8）
[selftest] ok   R6 把既有 fixture 条目换成 E02 的查询 → 交集=1：E02 与既有 fixture injected 逐字相同：彩虹独角兽在公开索引里是首领形态吗
[selftest] 真产物判据=绿；注入反证 6/6 条按预期翻红
```

同样的六条在 `tests/roco-rag-eval.test.js` 里各有一个独立
测试，并且额外断言了数值（例如 R1 要 `recall_at_1` 与 `mrr` 一起下降，R3 要
`grounded_precision` 严格变小）。

## 8. 命令与退出码

| 命令 | 作用 | 退出码（本次实测） |
| --- | --- | --- |
| `node scripts/roco/eval-rag-retrieval.mjs` | 写 `reports/roco/rag/rag-eval.json` + 打印对照表与逐条明细 | 0 |
| `node scripts/roco/eval-rag-retrieval.mjs --baseline` | 只打印对照表，不写报告 | 0 |
| `node scripts/roco/eval-rag-retrieval.mjs --json` | 打印完整报告 JSON | 0 |
| `node scripts/roco/eval-rag-retrieval.mjs --check` | 重算并与磁盘报告逐字节比较（忽略 `metadata.generated_at`），再跑闸门 | 0 |
| `node scripts/roco/eval-rag-retrieval.mjs --selftest` | 六条注入反证 | 0 |
| `node scripts/roco/eval-rag-retrieval.mjs --refresh-manifest` | 查询集改动后刷新 `query_manifest` | 0 |
| `node --test tests/roco-rag-eval.test.js` | 21 个测试（含六条反证） | 0 |
| `node --test tests/knowledge.test.js` | 既有卡片检索评测（KEEP，未改动行为） | 0 |

**可复跑**：报告正文不含挂钟时间戳，`generated_at` 单独放在 `metadata` 里；
`--check` 与测试都比对「除 `metadata.generated_at` 之外逐字节相同」。查询集本身有一份
`query_manifest`（总数 / 分类计数 / `id + 文本` 的 sha256），删改任何一条查询都必须
用 `--refresh-manifest` 显式承认。

## 9. 诚实结论

### 9.1 污染声明（最重要的一条）

主集 45 条查询的**期望值**逐条从语料推导（出处写在 `why` / `derived_from` 里），这一点有判据守着；
但**措辞**不是纯盲写的：作者在撰写过程中反复跑了检索器，并因此改过少数几条查询的用词
（最明确的一处是 M02：原始措辞与台账 claim 有 9 个连续汉字重合，触发泄漏判据后被改写成
「精灵主动换上来的时候迅捷会自动放技能吗」）。因此：

> **Recall@1 = 1.000 是开发集上的数字，不是泛化能力。** 它证明的是「这套索引能吃下这 45 条
> 按语料事实写出来的问题」，不证明「玩家随便换个说法都能查到」。

为了让这句话可检验，另写了 **13 条探针**（`probe_queries`，写完先跑一次、不按结果回调措辞、
不过闸门、失败也登记）。首轮结果：**11 条按预期、2 条失败**。

- **P13「pet_000532 这个实体是什么」** → NO_MATCH。原因：pack 正文里根本没有实体 id。
  这是索引层的基本能力缺失，已修（把 `entity_key` / `id` 加进别名表），复跑通过。
- **P10「冰系被哪些属性克制」** → 没有弃答，而是按「冰系」这个**系别标签**召回了 84 条冰系精灵里的前三条。
  原因：语料里**没有克制表**（pack 只有系别标签；台账 `EV-TYPE-MULTIPLIER` 只说有四档倍率，
  并明说「具体是哪几组对应哪一档仍需逐条核对」）。要正确弃答，需要一个「匹配表在本语料里是否可用」
  的领域信号；顺手加一条「问克制就弃答」的关键词规则等于对这条探针过拟合，所以**保留失败**。

### 9.2 哪些类还差

- **④ 弃答的「查不到」方向最弱**。三种弃答原因里，`EVIDENCE_LEVEL_INSUFFICIENT`（6 条）与
  `UNRESOLVED_IDENTITY_CONFLICT`（3 条）都是语料里有明确标记才触发的，判据很硬；
  而 `NO_MATCH`（1 条）依赖相关性门槛的标定，一旦问题换个说法、命中了某个泛词（P10 就是活例子），
  就可能从「弃答」滑成「给一条错答案」。这是当前最大的风险面。
- **每个类别只有 8～11 条**：任何一条的翻转都会让该类指标动 0.09～0.125，
  所以「分类指标 = 1.000」的置信区间很宽，不能读出「比基线好 30 个百分点」这种精度。
- **多答案查询只做了弱处理**：L08 是「四条文都算可接受」的手写可接受集，
  没有做「返回全部答案」的集合召回（`set recall`），所以多答案问题只能看 top-1 是否落在集合里。
- **基线A 的 0 无法解释为能力差**，原因见 §4；本轮没有为它建「卡片 id ↔ pack id」的映射表
  （建了就是给旧实现做人工翻译，反而更不客观）。
- **向量检索没做**（接口在，实现不在），所以「换个说法也查得到」这类能力没有被本评测覆盖。
- **别名表是机械规则 + pack 自带的形态轴表**，没有做任何同义词/简称扩展：“洛克王国”里
  玩家常用的简称（比如把「蹦蹦种子」叫别的）不在索引里，会直接 NO_MATCH。

### 9.3 哪些查不到（实测）

- C11「破晓之刃」——语料里没有这个名字，弃答（并附全语料反向扫描的缺席证明）。
- P10「冰系被哪些属性克制」——语料里没有克制表，检索层没有弃答（见上，已知缺口）。
- 任何需要「实机 / 官方」等级才能断言的事情（C01–C07）：语料只有假设/社区级证据，
  一律弃答，并把最强候选的 id 与等级写进原因。

## 10. 本评测**不声称**什么

- **不是端到端效果**：评测的是「检索层能不能把正确记录排到前面、能不能追到证据」，
  不是「小芽回答玩家时说得对不对」。没有任何 LLM/host 参与本次评测。
- **不是真人体验**：没有玩家、没有盲评、没有 IAA（标注者只有一名，就是写查询集的代理）。
- **不是独立盲评**：见 §9.1 的污染声明；主集措辞经过迭代，探针集才是不回调的那一份。
- **不是泛化能力**：45 + 13 = 58 条查询覆盖不了真实提问分布；分类指标样本量小。
- **不是向量检索的评测**：向量路径未实现，`vector_retrieval = NOT_IMPLEMENTED`。
- **不是发布闸门**：本评测**没有**接进 `scripts/roco/verify-release.mjs`（那个文件不在
  RC-204 的可改清单里）。要接闸门，需要主线程显式登记。

## 11. 维护

- 语料变了（pack / 台账 / 配置）：直接重跑；`--check` 若红，跑一次无参命令写新报告。
  若语料变了导致某条期望值不再成立，**先改期望值并写清新出处**，闸门会通过 `derivation` 检查。
- 查询集变了：跑 `--refresh-manifest` 更新清单，闸门 `query_manifest` 才会绿。
- 新增类别或类别下限：改 `CATEGORY_MIN` / `TOTAL_MIN` 与 `GATE_DEFINITIONS`，
  并同步 `tests/roco-rag-eval.test.js` 里的断言（两处必须一起动）。
- 想接真向量：实现 `searchIndex` 的 `vector` 选项（`{embed, docs: Map<id, number[]>}`），
  然后在评测里加一路「索引 + 向量」检索器，**不要**替换掉词法路径 —— 两条都要报。

## 12. 产物清单

| 路径 | 作用 |
| --- | --- |
| `data/roco/rag/heldout-queries.json` | 45 条主集 + 13 条探针 + `query_manifest` |
| `src/coach/rag-index.js` | 索引层（别名 / 过滤 / BM25 / rerank / 弃答 / grounded 判定） |
| `scripts/roco/eval-rag-retrieval.mjs` | 评测 runner（三套检索器 / 指标 / 13 组判据 / 六条反证 / CLI） |
| `tests/roco-rag-eval.test.js` | 21 个测试（真产物判据 + 六条必红反证），已接进 `test:unit` |
| `reports/roco/rag/rag-eval.json` | 评测报告（含逐条明细与 grounded 逐项判定） |
| `docs/roco/RAG-EVAL.md` | 本文件 |
