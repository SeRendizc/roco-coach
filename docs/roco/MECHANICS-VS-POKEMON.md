# 洛手机制 × 宝可梦算法：逐层对照（查证 + 判据）

> **这份文档是什么**：人类 2026-09-27 贴了四段评论（逐字见下），并问「是否应该查一下宝可梦的计算方式？」。
> 这份文档就是那次查证的**结果**：把洛手（人类口述 + 抓包）↔ 宝可梦（公开资料 + URL）↔ 本仓实现（文件:行号）
> 摆在一张四列表上，逐层判**一致 / 缺 / 可能错**。
>
> **它不是什么**：不是设计决定。凡是"要不要建星级""性格按哪种解释"这类**产品裁决**，
> 本文只把两种做法的改动清单列清，**不替人类拍板**（人类原话：「pvP 大哥，公平、博弈知道吗？」那套口径同理）。
>
> **红线**：数字只来自引擎 / 数据层 / 有出处的公开资料；查不到的写"查不到"，**不凭印象编**。
> 守这条的是判据 `tests/roco-mechanics-sources.test.js`（每个小节必须有 `来源：` 或 URL、必须点到仓内实现位置、
> 必须写明本仓缺的三层，且带"有结论没出处必红"的反证）。
>
> **来源**：本文所有宝可梦侧 URL 见 §1 与 §4；仓内来源见每节的 `来源：` 行。

## ★ 人类原话（逐字，别改写）

**来源**：这四段评论的记录处 `reports/roco/DESKTOP-BRIEF.md:63-70`（表格第 1–6 行逐条对照）与
`docs/roadmap/HANDOFF-2026-09-27.md:74-77`（"机制层"未完成项）；引用时**不许转述**。

- **① 2026-09-27**：「宠物的种族值是对标宝可梦的，然后升星系统的前 5 星，都会增加种族值，以五星为例，100 血量，其他 5 项都是 50，这个星级系统会缩小高低种族值宠物之间的差距，650 种族值的宠物升五星以后实际相当于 1000 种族值，500 种族值的宠物升五星以后实际有 850 种族值。然后是资质，相当于宝可梦的努力值和个体值的融合简化，主要用于区分同类宝可梦之间的数值差距，并且以三条固定数值增益的形式呈现。最后是性格，和宝可梦大差不差，去掉了平衡类性格，新增增加血量的性格，以及增加幅度从 10% 提到 20%」
- **② 2026-09-27**：「pvp 只看精灵资质，等级学习力双方都拉满，和宝可梦一样。pve 还是需要自己升级升星加数值的」
- **③ 2026-09-27**：「种族值固定，这个你不用管。性格都是一项 +10%，一项 -10%，看加减项目就可以了。个体值最多就是 3 个 +10。」
- **④ 人类的问题**：「是否应该查一下宝可梦的计算方式？」

**一句话答复**：该查，而且查完的结论是 —— **洛手在"分层"上确实对标宝可梦（种族值 / 个体 / 性格 / 等级 四层同构），但在"数值与结构"上已经改过（性格 30 条无中性、资质 0–10 不是 0–31、多出升星层、没有加点）**。所以我们能照搬的是**分层与公式形状**，不能照搬的是**每一条具体数值**。

---

## 一、逐层对照表（主表）

| 洛手（人类口述 / 抓包数据） | 宝可梦（公开资料，带 URL） | 本仓现在怎么做 | 结论 |
| --- | --- | --- | --- |
| **1 种族值·定义** 人类：「种族值固定，这个你不用管」（③）。抓包每只给 `base_race_params` 六项（`hp_max_race`/`phy_attack_race`/`spe_attack_race`/`phy_defence_race`/`spe_defence_race`/`speed_race`） | 种族值（Base stats）＝**同种相同、异种不同**的固定值，每项取值范围 0–255（[52poke 种族值](https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC)） | `data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json` 的 `pets[].stats`（622 只，六项）；读它的唯一入口 `src/coach/nature-advice.js:16 RACE_SOURCE` + `raceOf()` | **一致** |
| **2 种族值·量级** 人类举例 650 / 500（①）。本仓 622 只逐只累加：最小 214、中位 516、平均 514.6、最大 920（总和系本仓累加，非接口原值） | 每项 0–255；**总和（BST）**：最低 **175**（弱丁鱼单独的样子）、180（索侦虫/向日种子）；最高 **1125**（无极巨化的无极汰那）、次高 780（超级超梦X/Y、超级烈空坐）；400–600 占 **757/1261**（[pokemondb 全表](https://pokemondb.net/pokedex/all)、[弱丁鱼](https://pokemondb.net/pokedex/wishiwashi)、[无极汰那](https://pokemondb.net/pokedex/eternatus)） | `full-catalog.json` 的 `stats`；面板只吃这份（`src/coach/talent.js:141 panelOf` 的 `race` 入参） | **一致（量级同档；口径不同，见 §1）** |
| **3 升星** 人类：「升星系统的前 5 星，都会增加种族值，以五星为例，100 血量，其他 5 项都是 50」「650…相当于 1000，500…有 850」（①）；PVE 要自己升星（②） | **宝可梦没有这一层**：种族值不随任何个体成长变化；养成的两条轴是**等级**与**努力值**（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)） | **完全没有**。`grep -rn "星级" src/` 零命中；`src/` 里唯一的"星"是能量 ⭐（`src/coach/runtime.js:256`、`src/coach/team-gaps.js:92`），与升星无关 | **缺** |
| **4 资质·结构** 人类：「相当于宝可梦的努力值和个体值的融合简化」「以三条固定数值增益的形式呈现」（①）「个体值最多就是 3 个 +10」（③） | 个体值（IV）每项 0–31、天生不可改（[pokemondb IVs](https://pokemondb.net/mechanics/hidden)；极限特训只提能力值不改个体值，[52poke 极限特训](https://wiki.52poke.com/wiki/%E6%9E%81%E9%99%90%E7%89%B9%E8%AE%AD)）；努力值（EV）总 510、单项 255（第六世代起 252）、每 4 点＝L100 一点能力（[pokemondb EVs](https://pokemondb.net/ev)、[52poke 基础点数](https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0)）；《Champions》另有一套简化：能力点数每项 0–32、总和 ≤66（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)） | 天分三级各 +10：`src/coach/individuals.js:164 TALENT_STEP=10`、`:166 TALENT_TIERS=3`、`:220` 加到一个**没加过**的项；范围 `src/coach/talent.js:108 TALENT_RANGE`（六项各 0–10） | **一致（三条 +10 的口述）** |
| **5 资质·面板换算** 人类未给换算；桌面笔记另有一处「个体值 pvp 中自动乘六倍，7-8-9-10 分别增加 42-48-54-60」 | L100 化简：HP＝`2×种族值 + 个体值 + ⌊努力值/4⌋ + 110`；其他＝`(2×种族值 + 个体值 + ⌊努力值/4⌋ + 5) × 性格`（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）。**注意系数是 2** | `src/coach/talent.js:93 TALENT_PVP_STEP`（每点 +6，PVP 默认）与 `:87 PANEL_FORMULA`（0.85/0.55，升级口径）**两条都留着、不合并**（`:83-86` 明写冲突） | **可能错（口径冲突未裁决）** |
| **6 性格·条数与结构** 人类：「去掉了平衡类性格，新增增加血量的性格」（①） | 25 条性格，其中 **5 条中性**（勤奋/坦率/害羞/浮躁/认真；英文 Hardy/Docile/Bashful/Quirky/Serious），修正只作用于攻/防/特攻/特防/速**五项，不含 HP**：「宝可梦的一些性格会影响宝可梦除了ＨＰ以外的两项能力…另外还有5种性格（勤奋、坦率、害羞、浮躁、认真）不会影响宝可梦的能力」（[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)、[pokemondb Natures](https://pokemondb.net/mechanics/natures)） | 30 条＝6 长处 × 5 短处、**无中性**、**含 5 个加生命**（沉默/平和/忧郁/粗心/踏实）：`data/roco/systems/natures.json`、浏览器镜像 `src/coach/natures-data.js:6 NATURES_MODIFIER`、结构由 `src/coach/talent.js:33 validateNatures` 钉住 | **一致（人类口述 ⟷ 仓内）** |
| **7 性格·幅度** 人类同一段里两句：①「增加幅度从 10% 提到 20%」；③「一项 +10%，一项 -10%」 | 性格＝一项 ×1.1、一项 ×0.9（「提高的能力会提升10%，另一项降低的能力则下降10%」，L100 时），5 条中性（[pokemondb Natures](https://pokemondb.net/mechanics/natures)、[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)） | PVP 档 `up:0.2 / down:-0.1`（`natures-data.js:6-13`，出处 `EV-NATURE-BALANCE-PVP`）；**非 PVP 档整档 unknown**（`src/coach/talent.js:144-147`，缺"突破次数"） | **可能错 / 待人类裁决**（见 §4 的 A/B 两种解释） |
| **8 性格·幅度在面板上的落点** 人类：「看加减项目就可以了」（③） | 性格乘在**能力值**上（先算 IV/EV/等级，再乘 1.1/0.9）（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)） | `src/coach/talent.js:72 natureFactor`（长处 ×1.2、短处 ×0.9、不受影响 ×1.0），乘在 `panelOf` 的 `raw` 上（`:170`） | **一致（同构：只改幅度不改项）** |
| **9 等级** 人类：「pvp…等级学习力双方拉满」（②）；PVE 要自己升级（②）。洛手官方原文：「等级平衡至60级，成长等级平衡至50级」（`EV-NATURE-BALANCE-PVP`） | **官方一手（VGC 规则页逐字）**：「All Pokémon's levels are set to level 50.」（https://play.pokemon.com/en-us/resources/rules/?category=vgc ）；剑盾对战塔「宝可梦等级被限制为50级」（[52poke 对战塔](https://wiki.52poke.com/wiki/%E5%AF%B9%E6%88%98%E5%A1%94%EF%BC%88%E5%89%91%EF%BC%8F%E7%9B%BE%EF%BC%89)） | PVP 面板＝**满级 + 天分**：`src/coach/individuals.js:109 level_source='default-100'`；⚠ `panelOf`/`pvpPanelOf` **根本不接受 `level` 入参**（`talent.js:126`、`:141`）——等级在面板公式里不是变量 | **一致（"PVP 把等级拉平"两边都成立）** |
| **10 学习力** 人类：「等级学习力双方拉满」（②），PVE 才需要自己练 | 努力值 510 / 单项 252 有效 / 每 4 点 = L100 一点（[pokemondb EVs](https://pokemondb.net/ev)）；⚠ VGC 规则页**全文不含 Effort/EV 字样** ⇒ 「是否限制努力值」**查不到**，但**可确认努力值始终由玩家自由分配**，不是"双方都拉满同一套" | **完全没有这一层**。`grep -rn "学习力" src/` 零命中；`data/roco/systems/` 只有 `natures.json`；个体字段只有 `{level, talent, nature, refreshes, history}`（`src/coach/individuals.js:104-119`） | **缺（"等级拉平"与宝可梦一致；"努力值双方拉满"与宝可梦**不**一致）** |
| **11 突破次数** 官方引文：非 PVP 性格增益「初始 +10%，每突破一次 +2%，满突破 +20%」（`EV-NATURE-BALANCE-PVP`） | 宝可梦**没有突破层**；相近的是等级（1–100）与努力值上限 | **没有这个数据**：`src/coach/talent.js:146` 明写「本仓没有这个数据 ⇒ 这一档只给中性面板」；`:145` 注释「非 PVP 档的性格加成随突破次数走」 | **缺** |
| **12 PVP / PVE 分档** 人类：「pvp 只看精灵资质」（②）、「pve 还是需要自己升级升星加数值的」（②） | 宝可梦官方对战与主线是两套数值环境（对战自动同一档 vs 主线自己练） | 本仓有 `scope` 分档：`panelOf({scope:'pvp'})` 与非 PVP 分支（`talent.js:141-147`）；大厅/盒子档走 `pvpPanelOf`（`talent.js:126`） | **一致（分档存在）** |
| **13 抓包能不能补这些层** 抓包每只只有 `base_race_params` 六维 + 特性 + 技能 + 进化链 + 克制表，**不含**性格/天分/星级/学习力 | —（宝可梦侧无对应；这是本仓的数据边界） | `data/roco/raw/hke-2026-09-27/raw/pet-3001-1790537111.json`（逐字段读过）；字段清单见 `data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md` | **缺（数据源也没有）** |

**来源**：宝可梦侧 [52poke 种族值](https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC)、[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)、[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)、[52poke 基础点数](https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0)、[pokemondb Natures](https://pokemondb.net/mechanics/natures)、[pokemondb IVs](https://pokemondb.net/mechanics/hidden)、[pokemondb EVs](https://pokemondb.net/ev)、[pokemondb 全表](https://pokemondb.net/pokedex/all)；仓内：`data/roco/systems/natures.json`、`data/roco/evidence/rule-evidence-ledger.json`、`src/coach/talent.js`、`src/coach/individuals.js`、`src/coach/natures-data.js`、`src/coach/nature-advice.js`、`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`。

---

## 二、来源等级与查证边界（先说清楚哪一级）

**这份文档里"宝可梦那一列"几乎全是社区百科**（pokemondb.net / 52poke），等级相当于本仓的 `COMMUNITY_CURRENT`，
**不是** Game Freak / 任天堂一手文本：`bulbapedia.bulbagarden.net` 本轮**取不到**（HTTP 403，Cloudflare 挡了）。
**唯一的官方一手**是 VGC 规则页（https://play.pokemon.com/en-us/resources/rules/?category=vgc ，
逐字「All Pokémon's levels are set to level 50.」），只用来支撑"官方对战把等级拉平"这一条。
⇒ **宝可梦那一列只能当"公开共识"，不能当"官方裁定"**；要升级成 `OFFICIAL_CURRENT`，得另找一手来源。

**洛手那一列分三级**，读表时别混：
1. **人类口述**（★ 那一段，逐字）＝本仓最高权威；
2. **官方/社区引文**（`data/roco/evidence/rule-evidence-ledger.json` 的 `EV-NATURE-BALANCE-PVP`，confidence=`OFFICIAL_CURRENT`）；
3. **抓包**（`data/roco/raw/hke-2026-09-27/`，社区接口、许可 UNKNOWN、`REFERENCE_ONLY`）。

**来源**：`data/roco/evidence/rule-evidence-ledger.json:906`（`EV-NATURE-BALANCE-PVP` 的三条来源与逐字引文）、`data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md:1-30`（抓包总量与已知数据质量问题）。

---

## 三、逐层细账

**来源**：下面六节各自的 `来源：` 行；汇总清单在 §六。判定所依据的仓内实现位置：
`src/coach/talent.js`、`src/coach/individuals.js`、`src/coach/natures-data.js`、`src/coach/nature-advice.js`、
`data/roco/systems/natures.json`、`data/roco/evidence/rule-evidence-ledger.json`、
`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`。

### 1. 种族值（洛手六维 ↔ 宝可梦 Base Stats）

**宝可梦侧**：种族值是"反映不同种类宝可梦之间各项能力大致情况的数值"，**每项取值范围 0 到 255**，
在不同游戏之间可能被调整（[52poke 种族值](https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC)）。
L100 化简后：其他能力＝`(2×种族值 + 个体值 + ⌊努力值/4⌋ + 5) × 性格修正`，HP＝`2×种族值 + 个体值 + ⌊努力值/4⌋ + 110`
（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）—— 也就是说**种族值的系数是 2**。

**宝可梦侧的总和（BST）分布**（由 [pokemondb 全表](https://pokemondb.net/pokedex/all) 1261 行现算，含形态变化与超级进化）：

| | 宝可梦（1261 行，pokemondb 全表现算） | 洛手（本仓 622 只逐只累加） |
|---|---|---|
| 最低 | **175** 弱丁鱼（单独的样子）（[页面](https://pokemondb.net/pokedex/wishiwashi)）；180 索侦虫/向日种子 | **214** |
| 中位 / 平均 | 471 / 449.5 | 516 / 514.6 |
| 400–600 区间 | 757 / 1261（**60%**） | 367 / 622（**59%**） |
| 最高 | **1125** 无极巨化的无极汰那（[页面](https://pokemondb.net/pokedex/eternatus)）；次高 780 超级超梦X/Y、超级烈空坐 | **920** |

分世代（[PokéBase 用户答案](https://pokemondb.net/pokebase/435630/what-are-the-mean-and-median-base-stats-of-pokemon-generation)，
**等级较低**：用户答题，声明排除超级进化与形态变化）：第 9 世代全部平均 461 / 中位 490；第 1 世代 407.6 / 405；
第 9 世代最终进化型 534 / 530。

**⚠ 口径不同，别直接比大小**：宝可梦那个 1261 行含形态变化、超级进化与传说；本仓 622 只只含社区快照收录的精灵
（且不同形态可能占多行）。⇒ 能下的结论只有**"同档"**：两边都是"四五百是主体、顶到七八百以上是个别"，
且**两边 400–600 都占约六成**。**不能**据此说"洛手种族值普遍更高"。

**洛手侧（仓内实测）**：`full-catalog.json` 622 只逐只累加六维：
最小 **214**、5% 分位 335、中位 **516**、平均 **514.6**、75% 分位 603、最大 **920**。
六项各自的区间：生命 32–290、物攻 5–200、物防 27–183、魔攻 8–192、魔防 27–183、速度 26–145。
人类举例的 650 / 500 落在中上游（650 ≈ p92、500 ≈ p48），**与他描述的"中高种族值 / 中种族值"对得上**；
而 650 已接近本仓 p95（657）—— 也就是说他举的 650 是相当强的一只，这也解释了为什么"升星"那 +350 值得单列一层。

**⚠ 抓包的总和字段不能用**：`sum_race` 与六维之和对不上的有 **521/547** 条，49 条是 `sum_race=5` 这类哨兵值
（例：秩序鱿墨 3579 六维和 604，接口给 5）⇒ **要总和请自行累加六维，并注明"总和系本仓计算，非接口原值"**。

**本仓怎么做**：`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json` 的 `pets[].stats` 是唯一来源；
读它的入口只有 `src/coach/nature-advice.js:16 RACE_SOURCE` 与 `raceOf()`（读不到就 null，不许用别处的数顶）；
面板换算在 `src/coach/talent.js:141 panelOf({race, talent, nature, scope})`。

**结论：一致。** 洛手六维就是宝可梦的六维（生命/物攻/物防/魔攻/魔防/速度），量级**同档**
（中位 516 vs 471、400–600 都占约六成）；差别在**系数**（我方 1.1/1.7 vs 宝可梦 2），这一点下面 §6 会点出来。
⚠ 人类说的"对标"在**分层与量级**上成立，在**系数与总和上限**上不成立（宝可梦能到 1125，本仓快照最高 920）。

**来源**：[52poke 种族值](https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC)、[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)、
[pokemondb 全表](https://pokemondb.net/pokedex/all)、[弱丁鱼](https://pokemondb.net/pokedex/wishiwashi)、[无极汰那](https://pokemondb.net/pokedex/eternatus)、
[PokéBase 分世代均/中位](https://pokemondb.net/pokebase/435630/what-are-the-mean-and-median-base-stats-of-pokemon-generation)、
`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`（622 只 `stats`）、
`data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md:22-28`（`sum_race` 不可信）、`src/coach/nature-advice.js:16`。

### 2. 升星 —— **本仓完全没有这一层**

**人类口述（①，逐字）**：「升星系统的前 5 星，都会增加种族值，以五星为例，100 血量，其他 5 项都是 50，
这个星级系统会缩小高低种族值宠物之间的差距，650 种族值的宠物升五星以后实际相当于 1000 种族值，
500 种族值的宠物升五星以后实际有 850 种族值。」

**这句口述是算术自洽的（本仓推论，需人类确认）**：5 星增益 = 生命 **+100**、其余五项**各 +50**（总值 **+350**）；
650+350=1000、500+350=850 —— 两个例子**同时**对上，且比例从 650/500=**1.30** 压到 1000/850=**1.176**，
这正是他说的"缩小高低种族值宠物之间的差距"。按五颗星均摊，即**每星：生命 +20、其他五项各 +10**。
（这一条是**我从他的数字反推的**，不是他说的；建层前必须让他点头。）
用这个模型套本仓 622 只：极差比从 **4.30**（214↔920）压到 **2.25**（564↔1270）—— 方向与他的判断一致。

**本仓现状（grep 证据，只读不改）**：
- `grep -rn "星级" src/` → **零命中**（`src/` 下没有任何"星级"）；
- `grep -rniE "\bstar(s|_level|Level)?\b" src/` → 命中的全是**能量 ⭐**（`src/client/roco.js:1938-1939` 的 `⭐ ${pet.energy}`）与
  `src/coach/memory.js:251` 的段位里程碑正则（星耀），**没有一处是升星**；
- `grep -rn "升星" --include=*.js --include=*.mjs src/` → **零命中**；"升星"只出现在文档/报告里
  （`docs/roadmap/HANDOFF-2026-09-27.md:76`、`reports/roco/DESKTOP-BRIEF.md:66`、`:87`）；
- `src/coach/individuals.js` 的个体只有 `{level, talent, nature, refreshes, history}`（`:104-119`），**没有 `star`/`stars` 字段**；
- 抓包也没有：「抓包**不含**性格、天分、升星、学习力这类"每只个体"的值」（`reports/roco/DESKTOP-BRIEF.md:87`），
  逐字段复核 `data/roco/raw/hke-2026-09-27/raw/pet-3001-1790537111.json`：只有 `base_race_params`（六维 + `sum_race`）、
  `feature`、`skill_list`、`evolution_chain`、`counter_or_resist_list`、`size_params` —— **没有任何星级字段**。

**若要建，最少需要哪些输入（逐条，缺一条就不许动手）**：
1. **每只实例的当前星级**（0–几？"前 5 星"这个说法暗示 5 星之上还有东西，或 5 星就是满 —— **未知，必须问**）；
2. **每星增量是否恒定**：是"每星固定 +20 HP / +10 其他"，还是越往后越多（递增/递减）；
3. **增量落在哪几项**：六项同增，还是只增"种族值高的那几项"（决定它是否真能"缩小差距"）；
4. **5 星之后的规则**（人类只说了"前 5 星"）；
5. **星级进面板的位置**：是改 `panelOf({race})` 的**入参**（等价于"升星后种族值"），还是单独一个加项
   （两者在本仓是不同的接线：前者只动 `race`，后者要动 `talent.js` 的公式本体）；
6. **两个以上读数点**用于定标：同一只精灵在不同星级下抓到的六维（或面板值）——只有 1 个点定不出斜率；
7. **来源等级**：只能按人类口径 +（将来的）实机读数建模 ⇒ 落盘时必须标 `MODELLED_NOT_OBSERVED`
   （与 `src/coach/individuals.js:20` 的掷点规则同级），**不许**当成实测。
   ⚠ 抓包接口给的是 `base_race_params`（**基础**种族值）；它到底是"0 星"还是"当前星级"**未确认** ⇒ 建层前必须先定这一条，
   否则会把基础值当成已升星值，全盘偏高。

**来源**：`docs/roadmap/HANDOFF-2026-09-27.md:76`、`reports/roco/DESKTOP-BRIEF.md:66`、`:87`、
`data/roco/raw/hke-2026-09-27/raw/pet-3001-1790537111.json`、`src/coach/individuals.js:104-119`、
`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`（本仓累加）。宝可梦侧：**没有对应层**
（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B) 列的养成参数是种族值/等级/性格/个体值/基础点数，没有"星级"）。

### 3. 资质 ＝ 个体值 + 努力值的**融合简化**（人类口述 ↔ 本仓）

**人类口述（①③）**：「资质，相当于宝可梦的努力值和个体值的融合简化，主要用于区分同类宝可梦之间的数值差距，
并且以三条固定数值增益的形式呈现」「个体值最多就是 3 个 +10」。

**宝可梦侧（两层，分开管）**：

| | 个体值 IV | 努力值 EV |
|---|---|---|
| 范围 | 每项 **0–31**（六项各自一个数） | 总 **510**、单项 **255**（第六世代起单项上限降为 **252**；实际有效的合计是 508，剩 2 点没意义） |
| 怎么来 | 遇到/孵化时**随机**，**不能改**（极限特训只提能力值、不改个体值，也不影响遗传与觉醒力量） | 打怪/道具**训练**出来，**可由玩家规划** |
| 面板贡献 | L100 直接 1 点 = 1 点能力（HP 项也是 1:1） | **每 4 点 = L100 一点能力**（252 ⇒ +63）；**50 级时是 8 点 = 1 点** |

（[pokemondb IVs](https://pokemondb.net/mechanics/hidden)、[52poke 极限特训](https://wiki.52poke.com/wiki/%E6%9E%81%E9%99%90%E7%89%B9%E8%AE%AD)、
[pokemondb EVs](https://pokemondb.net/ev)、[52poke 基础点数](https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0)、[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）

**一个值得注意的旁证**：宝可梦自己在《Champions》里也做了一次"融合简化" ——
`HP能力值 = 种族值 + 能力点数 + 75`、`其他能力值 = ⌊(种族值 + 能力点数 + 20) × 能力调整⌋`，
**能力点数每项最小 0 最大 32、所有能力点数累计总和最大 66**，能力调整 ×1.1/×0.9
（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）。它同样把 IV/EV 压成了一层**点数**。
⇒ 洛手把"努力值+个体值"合成"资质"不是孤例，**方向与官方的简化版一致**。

**逐条对照（我们的做法 vs 人类口述）**：

| 人类口述 | 本仓实现 | 一致 / 不同 |
|---|---|---|
| 「主要用于区分同类宝可梦之间的数值差距」 | 掷点按 `instance_id` 种子化、随机三项 7–10、其余 0–6（`src/coach/individuals.js:79-94 rollNatureAndTalent`）；同一个体可重复拥有（`duplicateIndividual`） | **一致**（同种之间的差就差在这层） |
| 「三条固定数值增益」 | `TALENT_TIERS = 3`（`individuals.js:166`）、每级 `TALENT_STEP = 10`（`:164`）、加到一个**还没加过**的项（`:218-222`） | **一致**（3 × +10） |
| 「最多就是 3 个 +10」 | 三次刷新分别落在三个**不重复**的项上；六项都加过就 `no-stat-left`（`:219`） | **一致**（"最多"这层语义对上了） |
| 「资质＝努力值+个体值的融合简化」 | 本仓**只有一层** `talent`（六项各 0–10，`TALENT_RANGE`）；没有"天生值 vs 练出来"的区分 | **一致（合成一层）**，但**丢了"哪个是天生的、哪个是练出来的"这个区分** —— 见下面 ⚠ |
| （人类没说谁来决定） | 洛手**没有加点**，用**刷新**代替：性格/天分各 3 次、可回滚一步（`REFRESH_LIMIT=3`、`undoLastRefresh`） | **与宝可梦不同**（宝可梦 EV 是玩家自由分配）。不是"错"，是洛手改过的地方 |

**⚠ 一处可能错（口径混在一层里）**：`TALENT_RANGE` 说六项各 **0–10**（外部攻略口径："天分值一级的时候单一属性最高为 10"，
`src/coach/talent.js:98-102`），而"三条 +10 增益"是在这个 0–10 的**同一个对象**上继续加（`:220`）——
加完之后单项会到 17–20，**超过"一级单项最高 10"**。`pvpPanelOf` 只能事后打一条 unknown
（`:135`「天分值 ${value} 超过"一级单项最高 10"（外部攻略口径）」）。
两种读法（**必须人类裁决，我不拍板**）：
- **读法甲**：0–10 是**天生那一半**的上限，「三条 +10」是**另一层**（对应宝可梦的 EV 那一半）⇒ 本仓应当把
  `talent` 拆成 `innate`（0–10）与 `boosts`（三条 +10），面板分别按各自的系数算；
- **读法乙**：0–10 只是**一级（未突破）时**的上限，突破后上限上抬 ⇒ 本仓缺"突破次数"（见 §5），
  在拿到它之前不该把 >10 当成异常。

**来源**：[pokemondb IVs](https://pokemondb.net/mechanics/hidden)、[pokemondb EVs](https://pokemondb.net/ev)、
[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)（含《Champions》的能力点数 0–32/总和 66）、
`src/coach/individuals.js:14`、`:79-94`、`:164`、`:166`、`:218-222`、`src/coach/talent.js:98-108`、`:135`。

### 4. 性格：人类两句话的**矛盾**，与两种解释

**人类同一天的两句话**：
- ① 「性格…增加幅度从 **10% 提到 20%**」
- ③ 「性格都是一项 **+10%**，一项 **-10%**，看加减项目就可以了」

**宝可梦侧**：25 条性格，**每条 +10% / −10%**（L100 时），**5 条中性**（增与减是同一项）；
修正作用于攻/防/特攻/特防/速，**不含 HP**（[pokemondb Natures](https://pokemondb.net/mechanics/natures)）。
52poke 逐字：「宝可梦的一些性格会影响宝可梦**除了ＨＰ以外**的两项能力，其中提高的能力会提升10%，
另一项降低的能力则下降10%。另外还有5种性格（**勤奋、坦率、害羞、浮躁、认真**）不会影响宝可梦的能力。」
（[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)；HP 公式里也确实没有 `×性格修正` 项，见 [52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）
⚠ 顺带一个"别照搬"的细节：宝可梦的 ±10% 乘在**最终能力值**上，所以它的**绝对值随宝可梦而变**
（例：向日种子物攻种族值 30、个体 31、努力 252 ⇒ 159，±10% 约 ±16 点）——
**不是**"每只都 ±N 点"。洛手 `natureFactor` 同样是乘数（`src/coach/talent.js:72`），这一点形状一致。

**仓内证据（唯一一条与百分比有关的官方引文）** —— `data/roco/evidence/rule-evidence-ledger.json:906`，
`EV-NATURE-BALANCE-PVP`，confidence=`OFFICIAL_CURRENT`，三条来源逐字：
1. 官方号《洛个明白》（2026-04-14，https://news.qq.com/rain/a/20260414A0644900 ）：
   「等级平衡至60级，成长等级平衡至50级，成长星级平衡至5星，觉醒星级平衡至0星；**当前性格的加成值平衡至20%，负面效果无变化**」
2. 社区 biligame《性格图鉴》（2026-09-25）：
   「**降低固定 −10%；提升初始 +10%，精灵每完成一次突破（20/30/40/50/60 级，共 5 次）再 +2%，满突破 +20%**」
3. 社区《PVP一速榜》（2026-09-25）：「在PVP中平衡练度后，修正=1.2」

**明确判断（这是本节的核心结论）**：

> **能同时解释人类两句话的，只有"解释 B"。解释 A 在仓内没有任何来源支持。**

- **解释 B（与仓内证据一致）**：`±10%` 是**非 PVP / 零突破档**；`+20% / −10%` 是 **PVP 平衡档**
  （也等于**满突破档**）。⇒ 人类①说的是"满档/PVP 档到了 20%"（相对宝可梦的 10% 是"提上去了"），
  人类③说的是**底档**（刚抓到的精灵，零突破，就是 ±10%）。**两句话都对，只是场景不同**，
  而且与 `EV-NATURE-BALANCE-PVP` 第 1、2 条引文**逐字吻合**。
- **解释 A（与仓内证据冲突）**：`+20% / −10%` 是**全局**幅度（洛手把宝可梦的 ±10% 整体改成 +20%/−10%），
  人类③的 ±10% 是口误/旧记忆。⇒ 采用 A 就等于判定 `EV-NATURE-BALANCE-PVP` 第 2 条的
  「提升初始 +10%…每突破一次 +2%…满突破 +20%」**是错的**；那是**推翻一条 `OFFICIAL_CURRENT` 引文**，
  不是改一个常数。

**各自的适用场景**：
- **按 B 走**：保留"非 PVP 随突破成长"这条官方机制。**代价**：非 PVP 面板要每只的**突破次数**（本仓没有）
  ⇒ 只能先给"**零突破下界**（+10% / −10%）并标注"，或在拿到突破数据前继续整档留 unknown。**PVP 档不用动**。
- **按 A 走**：全场景一个幅度，不用等突破数据，实现最省。**代价**：与官方 4/14 引文及其后的社区复述冲突；
  零突破的精灵会被按满档算 ⇒ **PvE 面板偏高**；将来拿到突破数据要再改回来。

**如果按 B 改（改动清单，供人类勾选后执行）**：
1. `data/roco/systems/natures.json` 的 `modifier` 拆成 `pvp:{up:0.2,down:-0.1}` 与 `non_pvp:{up:0.1,down:-0.1,per_breakthrough:0.02,max:0.2}`
   （**不是**把 0.2 拿去顶非 PVP）；
2. `src/coach/talent.js:144-147` 的非 PVP 分支改成读 `non_pvp`，缺突破次数时按 0 次给 **1.1/0.9** 并在 `unknown` 里写明
   "按零突破计，实际可能更高"；
3. `src/coach/natures-data.js` 由 `scripts/roco/sync-browser-data.mjs` 重新生成（**不要手改**，文件头逐字写着）；
4. **改钉判据**：`tests/roco-talent-nature.test.js` 里"非 PVP 档不给数"的那条要改成"给零突破下界 + 标注"，
   并写日期 + 原因（台账规矩：改钉不删）。
**如果按 A 改（改动清单）**：
1. 台账 `data/roco/evidence/rule-evidence-ledger.json:906` 的 `claim` 与第 1/2 条引文要重写
   （**旧引文原样留档，不许删**），confidence 降级或改挂"人类口述优先"；
2. `modifier` 加 `scope:'global'`，`src/coach/talent.js` 的非 PVP 分支改成也用 `1.2/0.9`；
3. `tests/roco-talent-nature.test.js`、`tests/roco-nature-advice.test.js` 里"非 PVP 是 unknown"的断言要改钉；
4. 在 `docs/roco/TALENT-NATURE.md` 的规则表里把"非 PVP"那一行改掉（那张表写着"缺每只的突破次数 ⇒ 按 unknown"）。

**来源**：[pokemondb Natures](https://pokemondb.net/mechanics/natures)、[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)、[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)、
`data/roco/evidence/rule-evidence-ledger.json:906-933`、`data/roco/systems/natures.json:20-27`、
`src/coach/talent.js:67-75`、`:144-147`、`src/coach/natures-data.js:6-13`、`docs/roco/TALENT-NATURE.md:11-13`。

### 5. 等级 / 学习力：PVP 里"双方拉满"的等价物

**人类口述（②）**：「pvp 只看精灵资质，等级学习力双方都拉满，和宝可梦一样。pve 还是需要自己升级升星加数值的」

**宝可梦侧的等价物（这一条查到了，而且是官方一手）**：
- **等级**：VGC 官方规则页逐字「**All Pokémon's levels are set to level 50.**」
  （https://play.pokemon.com/en-us/resources/rules/?category=vgc ）；剑盾对战塔同样是「宝可梦等级被限制为50级」
  （[52poke 对战塔（剑／盾）](https://wiki.52poke.com/wiki/%E5%AF%B9%E6%88%98%E5%A1%94%EF%BC%88%E5%89%91%EF%BC%8F%E7%9B%BE%EF%BC%89)）。
  ⇒ 人类②的「等级…双方都拉满，**和宝可梦一样**」**成立**：两边都把等级拉平成常数。
  洛手自己的官方原文也是同一手法：「**等级平衡至60级，成长等级平衡至50级**，成长星级平衡至5星，觉醒星级平衡至0星；
  当前性格的加成值平衡至20%」（https://news.qq.com/rain/a/20260414A0644900 ，经 `EV-NATURE-BALANCE-PVP` 登记）。
- **努力值（学习力）**：⚠ **"和宝可梦一样"在这一半不成立**。努力值在宝可梦本家里**始终由玩家自由分配**
  （总 510、单项 252 有效、每 4 点 = L100 一点，[pokemondb EVs](https://pokemondb.net/ev)、
  [52poke 基础点数](https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0)；50 级时是 8 点 = 1 点能力）——
  **不存在"双方都拉满同一套努力值"这件事**（那等于人人 252/252/4，分配就没意义了）。
  而 VGC 官方规则页**全文不含 Effort/EV 字样** ⇒ "官方对战是否对努力值设限"**查不到**；
  能确认的只有"未明文限制"。⇒ 洛手"学习力双方拉满"是**洛手自己的平衡方式**，不是从宝可梦抄来的。

**本仓怎么做**：
- 等级：`src/coach/individuals.js:109 level_source='default-100（人类口径 2026-09-26：拥有的精灵都默认 100 级）'`；
  ⚠ **`panelOf` / `pvpPanelOf` 的签名里没有 `level`**（`src/coach/talent.js:126`、`:141`）——
  等级**根本没进面板公式**，所以"等级拉满"在本仓是**结构性成立**的（不是被算成 100，是压根不作为变量）。
- 学习力：**没有这一层**。`grep -rn "学习力" src/` 零命中；`data/roco/systems/` 只有 `natures.json`；
  个体字段只有 `{level, talent, nature, refreshes, history}`（`src/coach/individuals.js:104-119`）。
- **但常数项其实可以解释它**：宝可梦 L100 公式的两个常数（其他项 `+5`、HP 项 `+10+等级`＝L100 时 `+110`）
  就是"等级拉满之后剩下的那一截"；再把个体值（≤31）与努力值（≤63）拉满，L100 就是
  **其他＝`(2×种族值 + 99) × 性格`、HP＝`2×种族值 + 204`**（[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)，
  算术由本仓代入得出）。⇒ 宝可梦的"拉满"是一个**只含种族值与常数**的式子，个体与努力都被折成了常数。
  本仓 `PANEL_FORMULA` 也有常数项（HP `+70/+100`、其他 `+10/+50`，`src/coach/talent.js:87-92`）——
  **如果**将来要"解释这些常数从哪来"，宝可梦这个"常数＝等级×努力×个体拉满后的残项"就是可照搬的**解释模板**。
  ⚠ 这只是**解释模板**，不是数值来源；`PANEL_FORMULA` 的 confidence 是 `COMMUNITY_CURRENT`（小黑盒笔记逐字），
  目前**没有任何来源把洛手那两个常数拆开过**。

**结论**：等级＝**一致**（两边 PVP 都把等级拉平；本仓更彻底：等级压根不是面板变量）、学习力＝**缺**。
而"缺"这件事在 PVP 档**不一定有害**：双方都拉满 ⇒ 只贡献一个**对所有精灵相同的常数** ⇒ 它不影响排序，
只影响"绝对值好不好看"（也就是它无法解释"为什么这只打那只更疼"）。真正需要它的是 **PvE 档**
（人类②：「pve 还是需要自己升级升星加数值的」）——那一档本仓现在只有公式的一半（见 §3、§6）。

**来源**：https://play.pokemon.com/en-us/resources/rules/?category=vgc （官方一手：「All Pokémon's levels are set to level 50.」）、
[52poke 对战塔（剑／盾）](https://wiki.52poke.com/wiki/%E5%AF%B9%E6%88%98%E5%A1%94%EF%BC%88%E5%89%91%EF%BC%8F%E7%9B%BE%EF%BC%89)、[pokemondb EVs](https://pokemondb.net/ev)、
[52poke 基础点数](https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0)、[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)、
`data/roco/evidence/rule-evidence-ledger.json:906-933`（官方"等级平衡至60级/成长等级平衡至50级"逐字）、
`src/coach/individuals.js:104-119`、`src/coach/talent.js:87-92`、`:126`、`:141`、`docs/roco/TALENT-NATURE.md:13`。

### 6. 一句话总判断：哪些值得照搬、哪些不能

**值得照搬（能解释我们缺的层）**：

1. **"分层"的骨架**：宝可梦把面板拆成 `种族值（种）+ 个体值（天生）+ 努力值（练）+ 等级（常数）+ 性格（乘数）`
   （[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）。本仓的骨架**同构**，
   只是把"个体值 + 努力值"合成了 `talent`、把"等级 + 努力值"折成了常数。
   ⇒ 将来要拆层，宝可梦这套命名可以直接当 schema。
2. **"融合简化"这条路上有官方先例**：宝可梦《Champions》把 IV/EV 压成"能力点数 0–32、总和 ≤66、×1.1/0.9"
   （[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)）—— 和洛手"资质＋三条固定增益"是同一个方向。
   ⇒ 这条可以拿来说服自己"我们不是把宝可梦抄歪了，是走在它后来也走的那条路上"。
3. **性格的实现形状**：宝可梦 = 一项 ×1.1 / 一项 ×0.9、其余 ×1.0；本仓 `natureFactor` 是同一形状
   （`src/coach/talent.js:67-75`），只换了数字。⇒ **形状照搬没问题，数字必须来自我们自己的台账**。
4. **"PVP 双方拉满 ⇒ 折叠成常数"的处理手法**：宝可梦 VGC 官方规则逐字「All Pokémon's levels are set to level 50.」
   （https://play.pokemon.com/en-us/resources/rules/?category=vgc ），洛手官方原文同样是「等级平衡至60级，成长等级平衡至50级」
   （`EV-NATURE-BALANCE-PVP`）⇒ 两边都拿"把等级拉平"换公平。**这一条可以照搬**，而且本仓已经做过头了：
   等级压根不进 `panelOf` 的签名（`src/coach/talent.js:126`、`:141`）。
   ⚠ 但**只能照搬"等级"这一半**：宝可梦的**努力值不作平衡**（仍由玩家分配），所以"学习力也照宝可梦那样双方拉满"
   **没有来源支持** ⇐ 这是人类②里唯一一处"和宝可梦一样"不成立的地方。

**不能照搬（洛手已经改过的地方）**：

1. **性格幅度**：宝可梦 ±10%，洛手 PVP 档 **+20% / −10%**（`NATURES_MODIFIER`，出处 `EV-NATURE-BALANCE-PVP`）。
   照搬 10% 会直接把 PVP 面板算低。
2. **性格表**：宝可梦 **25 条含 5 条中性、不含 HP**；洛手 **30 条无中性、含 5 个加生命**。
   照搬宝可梦的性格名/上下项 ⇒ 认不出性格（`natureOf` 返回 null ⇒ `natureFactor` 记 unknown）。
3. **个体值 0–31**：洛手资质是 **0–10 且"最多 3 个 +10"**。照搬 31 点 ⇒ 面板起飞。
4. **努力值 510 / 252 / 每 4 点 1 点**：洛手**没有加点这一层**（人类 2026-09-26：「洛手没有加点」；
   `src/coach/individuals.js:7`、`:14` 用刷新代替）。照搬会凭空多出一个玩家可分配层。
5. **面板公式的系数与常数**：宝可梦 L100 其他项 `2×种族值 + 个体值 + 努力值/4 + 5`（系数 **2**）；
   本仓 `PANEL_FORMULA.other` 是 `1.1×种族值 + 0.55×天分 + 10`（系数 **1.1**）。
   **照搬宝可梦的系数会把本仓面板算成大约两倍** ⇒ 绝对不能混用。
   （顺手一个量级感受：宝可梦"个体 + 努力全拉满"在 L100 只贡献 `31 + 63 = 94` 点，
   而种族值那一项贡献 `2×种族值`（约 400–1400）—— 也就是说**宝可梦的面板主要由种族值决定**，
   这跟人类①说的"资质主要用于区分同类之间的差距"是同一个意思：**资质那一层天生就不该主导面板**。
   本仓 `1.1×种族值` vs `0.55×天分`（天分 0–10 时最多 5.5 点）也符合这个量级关系 —— **一致**。）
6. **"种族值固定"只在宝可梦成立**：洛手有升星层（且人类③说"种族值固定，这个你不用管"指的是**基础**种族值别去纠）。
   ⇒ 我们可以照搬宝可梦的"种族值 = 种属性"这一层，但**升星必须自己建**（见 §2 的输入清单）。
7. **性格乘在什么上**：宝可梦乘在"含 IV/EV/等级"的完整能力值上；本仓非 PVP 档**连性格系数都给不出来**
   （缺突破次数）⇒ 照搬"乘在能力值上"没问题，但**不能**照搬"一定有 10% 可乘"。

**来源**：[52poke 能力](https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B)、[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)、
[pokemondb IVs](https://pokemondb.net/mechanics/hidden)、[pokemondb EVs](https://pokemondb.net/ev)、[pokemondb Natures](https://pokemondb.net/mechanics/natures)、
https://play.pokemon.com/en-us/resources/rules/?category=vgc （官方一手：VGC 等级统一为 50）、
`src/coach/talent.js:87-92`、`:93-107`、`:108`、`:126-139`、`:141-174`、`src/coach/individuals.js:14`、`:164`、`:166`、
`data/roco/systems/natures.json:20-27`、`data/roco/evidence/rule-evidence-ledger.json:906-933`。

---

## 四、本仓没有建的层（清单，逐条可勾）

| 层 | 人类口径 | 本仓状态（证据） | 要建的话最少缺什么 |
|---|---|---|---|
| **星级**（升星加种族值） | ①（前 5 星；650→1000、500→850；五星＝生命+100/其他+50） | **零命中**（`grep -rn "星级" src/`、`grep -rn "升星" src/`）、个体字段无 `star`（`src/coach/individuals.js:104-119`） | 每只星级 / 每星增量与落点 / 5 星后规则 / 进面板的位置 / ≥2 个定标读数 / 抓包 `base_race_params` 是哪一星 |
| **学习力** | ②（PVP 双方拉满；PVE 自己练） | **零命中**（`grep -rn "学习力" src/`）、`data/roco/systems/` 只有 `natures.json` | 洛手到底有没有这一层 / 每只数值与上限 / 换算系数 / 它与 `PANEL_FORMULA` 常数项的关系 |
| **突破次数** | 官方引文：非 PVP 增益每突破 +2%（`EV-NATURE-BALANCE-PVP`） | **没有数据**（`src/coach/talent.js:145-147` 明写，缺了就把整档记 unknown） | 每只的突破次数（0–5）；以及减益是否也随突破变化（引文说"负面效果无变化"） |

**来源**：`data/roco/evidence/rule-evidence-ledger.json:906-933`、`src/coach/talent.js:144-147`、
`src/coach/individuals.js:104-119`、`reports/roco/DESKTOP-BRIEF.md:66`、`:87`、`docs/roadmap/HANDOFF-2026-09-27.md:76`。

---

## 五、查不到 / 没做到的（诚实边界）

1. **宝可梦 BST"平均/中位"没有权威出处**：数字（449.5 / 471、400–600 占 757/1261）是本文**自己从
   [pokemondb 全表](https://pokemondb.net/pokedex/all) 1261 行现算的、只算了一遍（没有第二种方法复核）**，并含形态变化与超级进化 ⇒
   **不能**当官方统计引用，也不能和"不含形态"的口径直接比。分世代那两个数来自
   [PokéBase 用户答案](https://pokemondb.net/pokebase/435630/what-are-the-mean-and-median-base-stats-of-pokemon-generation)，
   等级更低（用户答题、样本口径与全表不同，**不可与 449.5/471 直接比较**）。
2. **bulbapedia 取不到**（HTTP 403，Cloudflare）⇒ 宝可梦侧主要依赖 **pokemondb.net 与 52poke**（社区百科，
   等级 ≈ `COMMUNITY_CURRENT`）。**唯一一条官方一手**是 VGC 规则页「All Pokémon's levels are set to level 50.」
   （https://play.pokemon.com/en-us/resources/rules/?category=vgc ）。
   **"级别对战/排位也用 50 级"的明文出处查不到**（52poke 对战竞技场页 0 次出现"50"，SV 官方页与规则 PDF 403）
   ⇒ 本文只写了 VGC 与剑盾对战塔。
3. **VGC 是否允许/限制努力值：查不到**（官方规则页全文无 Effort/EV 字样，只能确认"未明文限制"）。
4. **人类两句话的矛盾**：本文的处理是**并置两种解释 + 各自改动清单**，**没有替人类拍板**。
   我给出的判断只有一条：**解释 B 与仓内 `OFFICIAL_CURRENT` 引文一致，解释 A 与它冲突**（§4 已写明）。
5. **升星的每星增量（生命 +20 / 其他 +10）是我反推的**，不是人类逐字 ⇒ 建层前必须确认。
6. **抓包的 `base_race_params` 是"0 星"还是"当前星级"未确认** ⇒ 建星级层之前必须先定这一条。

**来源**：[52poke 种族值](https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC)、[52poke 性格](https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC)、
[pokemondb 全表](https://pokemondb.net/pokedex/all)、[PokéBase 分世代均/中位](https://pokemondb.net/pokebase/435630/what-are-the-mean-and-median-base-stats-of-pokemon-generation)、
https://play.pokemon.com/en-us/resources/rules/?category=vgc 、
`data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md`、`data/roco/evidence/rule-evidence-ledger.json:906-933`。

---

## 六、来源清单（URL + 仓内文件:行号）

**宝可梦（社区百科，全部本轮实际抓取成功；★ = 官方一手）**
- ★ https://play.pokemon.com/en-us/resources/rules/?category=vgc （VGC 规则逐字「All Pokémon's levels are set to level 50.」；全页无 Effort/EV 字样）
- https://wiki.52poke.com/wiki/%E7%A7%8D%E6%97%8F%E5%80%BC （种族值定义、每项 0–255、跨版本可调整）
- https://wiki.52poke.com/wiki/%E8%83%BD%E5%8A%9B （L100 能力公式、性格 ±10% 与"除ＨＰ以外"、《Champions》能力点数 0–32/总和 66）
- https://wiki.52poke.com/wiki/%E6%80%A7%E6%A0%BC （25 条性格、5 条中性（勤奋/坦率/害羞/浮躁/认真）、HP 不受影响）
- https://wiki.52poke.com/wiki/%E5%9F%BA%E7%A1%80%E7%82%B9%E6%95%B0 （总 510、单项 255→第六世代起 252、每 4 点 1 能力值、50 级为 8 点 1 点）
- https://wiki.52poke.com/wiki/%E6%9E%81%E9%99%90%E7%89%B9%E8%AE%AD （极限特训只提能力值、不改个体值）
- https://wiki.52poke.com/wiki/%E5%AF%B9%E6%88%98%E5%A1%94%EF%BC%88%E5%89%91%EF%BC%8F%E7%9B%BE%EF%BC%89 （剑盾对战塔「宝可梦等级被限制为50级」）
- https://pokemondb.net/mechanics/natures （25 条、±10%、5 条中性、修正只作用于五项）
- https://pokemondb.net/mechanics/hidden （个体值每项 0–31、随机、不可改）
- https://pokemondb.net/ev （努力值总 510、单项 255、252 有效、每 4 点 = L100 一点）
- https://pokemondb.net/pokedex/all （全表 1261 行；本文的 BST 均/中位与 400–600 计数系由该表现算）
- https://pokemondb.net/pokedex/wishiwashi 、https://pokemondb.net/pokedex/eternatus （BST 最低 175 / 最高 1125）
- https://pokemondb.net/pokebase/435630/what-are-the-mean-and-median-base-stats-of-pokemon-generation （分世代均/中位；用户答案，等级低）

**洛手（仓内）**
- `data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json` — 622 只六维 `pets[].stats`（唯一来源）
- `data/roco/systems/natures.json:20-27` — 性格规则与 `up:0.2 / down:-0.1`
- `data/roco/evidence/rule-evidence-ledger.json:906-933` — `EV-NATURE-BALANCE-PVP`（官方/社区逐字引文）
- `src/coach/talent.js:33`、`:67-75`、`:87-92`、`:93-107`、`:108`、`:126-139`、`:141-174` — 性格校验、系数、公式、天分步进、PVP 面板
- `src/coach/individuals.js:14`、`:79-94`、`:104-119`、`:164`、`:166`、`:218-222` — 个体、掷点、三级 +10、刷新
- `src/coach/natures-data.js:6-13` — 30 条性格的浏览器镜像（自动生成，不要手改）
- `src/coach/nature-advice.js:16`、`:55` — 种族值来源常量与"说法层"
- `data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md:15-30` — 抓包字段与 `sum_race` 不可信
- `data/roco/raw/hke-2026-09-27/raw/pet-3001-1790537111.json` — 抓包单只逐字段（只有 `base_race_params`）
- `docs/roco/TALENT-NATURE.md:11-13` — 本仓自己的规则表（非 PVP 档 unknown）
- `docs/roadmap/HANDOFF-2026-09-27.md:76`、`reports/roco/DESKTOP-BRIEF.md:66`、`:87` — "星级/学习力完全没建"的登记

**判据**：`tests/roco-mechanics-sources.test.js`（① 每个 `##`/`###` 小节必须有 `来源：` 或 URL；② 必须点到上列仓内路径且文件存在；
③ 必须写明"星级/学习力/突破次数"三层缺失；④ 主表必须四列；⑤ 性格必须写出两种解释；⑥/⑦/⑧ 反证：有结论没出处必红、加 URL 才过、文件不存在必红）。
