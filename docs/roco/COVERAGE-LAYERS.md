# 分层覆盖设计：622 图鉴检索 → 60 阵容评估 → 29 可模拟核心 → 48 Demo

> 第 46 轮 · **只设计/审计，不改引擎实现**。每一层给：进入条件、数据来源与版本、
> refused 原因分类、**这一层能声称什么 / 不能声称什么**，以及**现在的实测覆盖率**。
>
> 相关产物：
> `reports/roco/coverage/roster-48.json`、`reports/roco/coverage/roster-60.json`、
> `reports/roco/coverage/roster-48-support.json`、`reports/roco/coverage/roster-48-smoke.json`、
> `reports/roco/coverage/roster-60-smoke.json`、`docs/roco/ROSTER-48.md`。
> 三维度（技能效果 / 特性 / 支持等级 / Demo 替代规则）的定义见 `docs/roco/COVERAGE-AXES.md`。

---

## 0. 分层总表

| 层 | 目标规模 | **本轮实测** | 进入条件 | 判定它是哪一层的硬指标 |
|---|---|---|---|---|
| L1 全量图鉴检索 | **622** | **12 / 622（1.9%）** ⚠ 未达成 | 全量 `Catalog.lua` 导入到可检索语料 | 每只可被名字/属性/技能文本检索；**不声称可模拟** |
| L2 阵容评估 / 候选生成 | **≥60** | **60 / 60** ✅ | 每只 4 技能配招 + 通过 `validate_team` | `C(60,3)=34220` 个三元组**全部合法**（实测） |
| L3 可模拟核心池 | **≥24** | **29 / 60**（48 只内是 **26 / 48**）✅ | 4 个技能里**没有** fail closed 的 | 逐技能走引擎代码路径逐条判定（见 `roster-*-support.json`） |
| L4 Demo 展示 | **48** | **48 / 48** ✅（可玩性已实测，UI 未做） | 可浏览 / 可选择 / 可组任意合法 3v3 / 可打完 / 可进评估·规划·复盘 | 实测 1000/1000 完赛、0 非法、0 截断；UI 交付见 §4.3 |

> **L4 与 L3 的关系**：L4 的 48 只里，**26 只**的 4 技能没有 fail closed（= L3）；
> 另 22 只各带 1 个 fail closed 技能（技能本身会被登记为 `unsupported`，回合继续）。
> 这不是「把其余的降级成只读」：48 只**都**能选、能打、能进评估/规划/复盘，
> 差别只在「其中 22 只有 1 个技能槽当前什么都不做」。这 22 个槽的清单与原因在
> `roster-48-support.json` 的 `pets[*].fail_closed_skills`，替换备选在
> `roster-48.json` 的 `moveset`（每只是否给了备选见 §4.2 的实现批次）。

---

## 1. L1 · 全量图鉴检索（622 只知识库）

### 1.1 进入条件

| 条件 | 说明 | 现在 |
|---|---|---|
| 全量图鉴落成结构化数据 | 622 只，每只 name / title / number / game_id / types / stats(6) / class / release / learnset_id / feature_skill_id | ⚠ **只在 `Catalog.lua` 里**；规范化目录 `pets.json` 只落了 **12** 只（`source` 见 `roster-48.json#sources.pets.entries = 12`） |
| 检索语料 | 名称/别名/拼音检索键在 `Overview.lua`（622 行，逐 `pet_xxxxxx = {search=..., season=...}`）；描述在 `Catalog.lua#description`、`Handbooks.lua` | 未导入 |
| 技能说明可检索 | `skills.json` **824/824 已规范化**（含 `desc` / `desc_notes` / `flavor`） | ✅ 已有 |
| 学习表可查询 | `Learnsets.lua` **312** 张表（622 只共享 312 张，`distinct learnset_id = 312`） | ⚠ `learnsets.json` 只落了 12 张 |
| 属性相性 | `types.json`：18 单属性 + 显式双属性行，共 120 组 | ✅ 已有 |

**版本 / 指纹**（`roster-48.json#sources`，`sha256` 可复核）：

| 文件 | sha256（前 16） | 条数 |
|---|---|---:|
| `roco-wiki-data/wiki_modules/Pets/data/Catalog.lua` | `537fba5e8cb779c1` | 622 |
| `.../Learnsets.lua` | `740e84def6f142fc` | 312 |
| `data/roco/normalized/roco-world-s4-2026-09-10/skills.json` | `9d01a6476a529be7` | 824 |
| `data/roco/normalized/roco-world-s4-2026-09-10/pets.json` | `8ba09fd7a05e1d02` | **12** |
| ruleset | `roco-world-s4-2026-09-10` | 赛季 S4（2026-09-10） |

### 1.2 refused 原因分类（L1 一律不进入战斗，所以整层只有一类）

| 代码 | 原因 | 数量 | 证据 |
|---|---|---:|---|
| `R6_data_field_unsupported` | 824/824 技能的 `effect_support` 都是 `unsupported` | 824 | `python3 -c "import json,collections;s=json.load(open('data/roco/normalized/roco-world-s4-2026-09-10/skills.json'));print(collections.Counter(v['effect_support'] for v in s['skills'].values()))"` → `Counter({'unsupported': 824})` |
| `R7_no_mobile_evidence` | 622 只里只有 12 只做过交叉核验；其余 610 只只有主快照一个来源 | 610 | `docs/roco/DATA-CONFLICTS.md`、`docs/roco/RULE-COVERAGE.md` §1.1 |

### 1.3 能声称 / 不能声称

- ✅ **能**：给定名字/属性/编号，返回该精灵的图鉴字段、技能学习表、技能文本、属性相性。
- ✅ **能**：说「这条技能的描述里有 X 机制」（文本标注，不推断时序）。
- ❌ **不能**：说任何一只「可模拟」——`effect_support` 全 `unsupported`，且 610 只无交叉核验。
- ❌ **不能**：把「可学」当成「这场带得上」（`env.py:98-100` 明写这两件事不同）。
- ⚠ **现状**：这一层**没有交付**。`pets.json`/`learnsets.json` 只有 12 条，全量图鉴只在原始 Lua 里。
  最小实现路径写在 §5 批次 0。

---

## 2. L2 · 阵容评估 / 候选生成（60 只）

### 2.1 进入条件

| 条件 | 阈值 | 依据 |
|---|---|---|
| 只数 | **≥60** | 监工要求 |
| 每只可学习技能数 | `pool_size ≥ 40` | 622 只的 p10 = 45；留余量（`build-roster-48.mjs#POOL_MIN`） |
| 每只 4 技能配招 | 必须是它自己学习表里的技能 | `validate_team` → `Ruleset.is_learnable`（`data.py:239-241`） |
| 配招能耗 | `energy ≤ 6` | 引擎假设 `ENERGY_MAX = 6`（`env.py:45`）+ `env.py:184` 的能耗门；能耗 >6 的技能**永远不合法**，所以不进配招（被排除的条数见 §2.3） |
| 合法性 | 任意 3 只都能组队 | 实测 `C(60,3) = 34220` **全部合法** |

### 2.2 实测

```bash
node scripts/roco/build-roster-48.mjs --size 60
python3 scripts/roco/audit-roster-48.py --roster reports/roco/coverage/roster-60.json --skip-matches
```

| 指标 | 值 |
|---|---|
| 只数 | **60**（且 **48 只是它的前缀**，逐位相同，可复核：`roster-60.json#pets[:48] == roster-48.json#pets`） |
| 独特技能数 | **76**（60 × 4 = 240 个槽 → 76 个去重技能） |
| 18 属性覆盖 | 全覆盖；龙系 2、电系 2、光系 2（最低 2 只） |
| 角色分布 | attacker 15 / recovery 18 / support 6 / tank 14 / control 7 |
| 速度档分布 | `<=50` 5 / `51-70` 9 / `71-90` 22 / `91-110` 13 / `>=111` 11 |
| 硬机制覆盖 | charge / mark / multi_hit / position / random / escape / respond / priority **8/8** |
| 三元组合法 | `34220 / 34220` 合法，非法 **0** |
| 3v3 冒烟 | **1000/1000 完赛**，0 截断，0 异常；回合 p50 25 / p95 49；单局 p50 14 ms / p95 28 ms |

### 2.3 refused 原因分类

| 代码 | 原因 | 数量（本轮实测） | 证据 |
|---|---|---:|---|
| `R1_skill_primitive_not_implemented` | 技能原语未实现（引擎 fail closed） | **9 / 76** 独特技能 | `roster-48-support.json#skills[*].verdict == "fail_closed"` |
| `R3_effect_silently_dropped` | 分支根本不处理该类效果（防御的「应对成功：…」子句、攻击的附带效果） | **6**（防御子句）+ **28**（攻击路径未纠正） | `reason_code = defense_branch_never_applies_respond_clause` / `attack_path_uncorrected` |
| `R2_primitive_implemented_unverified` | 有实现但口径无一手证据 | 33（`computed` + `computed_unverified`） | 同上 |
| `R8_assumption_only` | 引擎自定假设（能量上限 6 / 回合末 +1 / 入场 2 / 换宠先手 5 / 同速随机） | 全层适用 | `env.py:13,45-48,138` |
| `R4_trait_not_registered` | 特性未登记（`traits.py` 只登记 12 只） | 60 只里 **48** 只的特性未登记 | `engine-trait-status.json#pets` 只有 12 条 |
| `R5_trait_refused_no_evidence` | 特性登记为 REFUSED | 4 / 60（也正好是 4 / 48：化蝶·化茧、寂灭骨龙·不朽、秩序鱿墨·绝对秩序、银月狼王·铭记于月亮，四只都在必须包含的 12 只里） | `engine-trait-status.json#counts.REFUSED = 4` |
| `R_energy_over_engine_max` | 技能能耗 > 引擎上限假设 6 → 永远不合法 | 824 条里 **20** 条；60 只可学池里 **18** 条 | `roster-48.json#summary.skills_excluded_energy_over_max` |

### 2.4 能声称 / 不能声称

- ✅ **能**：给出 60 只的真名/属性/六维/4 技能/学习来源，做阵容结构的**规则特征**评估
  （属性覆盖、角色、速度档、能量曲线、机制缺口），以及「换谁 / 牺牲什么」的候选生成。
- ✅ **能**：说「这 60 只的任意 3 只组合都通过引擎的合法性与可学性检查」（实测 34220/34220）。
- ❌ **不能**：**不能输出胜率**。端到端评分建立在未核验伤害公式之上；
  `docs/roco/mvp/RULE-COVERAGE.md` 的口径「明确不输出胜率」仍然有效。
- ❌ **不能**：说这 60 只「特性可用」——`traits.py` 只登记 12 条。

---

## 3. L3 · 可模拟核心池（29 只 / 48 只内 26 只）

### 3.1 进入条件

| 条件 | 阈值 | 依据 |
|---|---|---|
| 只数 | **≥24** | 监工要求 |
| 每只 4 技能**都有证据** | 技能来自该只学习表（native / blood / stone） | `roster-48.json#pets[*].moveset[*].learn_from` |
| 每个技能在引擎里**不是 fail closed** | `verdict ∈ {computed, computed_unverified, computed_uncorrected}`（**不含** `fail_closed`） | `roster-48-support.json#pets[*].no_fail_closed` |
| 能打完一局 | 该只出现在完赛记录里 | `roster-48-smoke.json`（1000 局） |

### 3.2 实测

| 池 | 满足「4 技能无 fail closed」的只数 | 阈值 |
|---|---:|---:|
| 48 只 Demo 名单 | **26 / 48** | ≥24 ✅ |
| 60 只 L2 池 | **29 / 60** | ≥24 ✅ |

命令：`python3 scripts/roco/audit-roster-48.py --skip-matches`（输出 `pets_no_fail_closed`）

9 个 fail closed 技能（逐条，`skill_id` / 名字 / 原因码）：

| skill_id | 技能 | 原因码 | 中文原因 |
|---|---|---|---|
| `skill_000294` | 取念 | `unparsed_markers` | 描述含「随机」——`parse.py:46-49` 明确不覆盖 |
| `skill_000298` | 复写 | `unparsed_markers` | 同上（「随机变成自己未携带的技能」） |
| `skill_000415` | 焚尽 | `no_parseable_effect` | 「驱散自己所有印记」的**自己**侧不在解析器覆盖内（`parse.py:89` 只认驱散敌方增益/双方印记） |
| `skill_000483` | 啮合传递 | `unparsed_markers` | 含「号位／传动」——术语 1033，引擎无技能位移动 |
| `skill_000599` | 过载回路 | `effect_kinds_not_implemented` | 「回合结束自己返场」需要调用方选人（`env.py:679-682` 只登记） |
| `skill_000603` | 电离爆破 | `unparsed_markers` | 含「连击」（`hit_count=1` 硬编码，`env.py:540` 区段） |
| `skill_000683` | 马步 | `unparsed_markers` | 含「选择」（术语 3019 明/暗） |
| `skill_000704` | 风隐 | `effect_kinds_not_implemented` | 「敌方和自己均脱离」= 离场需选人 |
| `skill_000793` | 伪造账单 | `no_parseable_effect` | 「若敌方本回合回复生命，改为失去2倍」——无对应原语 |

### 3.3 refused 原因分类（L3 的核心）

| 代码 | 中文 | 典型 | 是不是「不许近似」守住的 |
|---|---|---|---|
| `R1_skill_primitive_not_implemented` | 技能原语未实现 | 上表 9 条 | ✅ 引擎抛 `UnsupportedEffect` 或记 `unsupported`，**没有**退化成 40 威力普攻 |
| `R3_effect_silently_dropped` | 效果被静默丢弃 | `水泡盾`「应对攻击：自己获得魔攻+70%」→ 实测 `buffs={}` 且 `unsupported=[]`；`甩水`「自己回复1能量」→ 实测 energy 3→3 | ❌ **这不符合项目自己的纪律**（应当至少登记），是缺陷，见 §3.4 |
| `R2_primitive_implemented_unverified` | 有实现、无一手证据 | 伤害公式、面板拟合、能量口径 | ✅ 每个伤害事件都带 `formula_verified:false` |
| `R5_trait_refused_no_evidence` | 特性拒绝 | 化茧 / 不朽 / 绝对秩序 / 铭记于月亮 | ✅ 理由写明「拒绝而不是近似」 |

### 3.4 两个**实测**的缺陷（本轮发现，附反证）

```bash
python3 - <<'EOF'
# 见 scripts/roco/audit-roster-48.py 的 classify_skill；下面是它的实测输出
EOF
```

1. **攻击分支丢弃附带效果，且不登记。**
   `甩水`（`skill_000418`，描述「造成魔伤，自己回复1能量」）实测：
   `energy before/after = 3 3`；`events = ['damage']`；`unsupported = []`。
   引擎只算伤害，回能既没生效也**没进 `unsupported`**。
   落点：`env.py:535-592` 的攻击分支从不调用 `_apply_status_effects`。
2. **防御分支丢弃「应对成功：…」子句，且不登记。**
   `水泡盾`（`skill_000429`，描述「减伤80%，应对攻击：自己获得魔攻+70%」）实测：
   `buffs = {}`；`events = ['defense']`；`unsupported = []`。
   落点：`env.py:510-524` 在应用减伤后直接 `return`。
   `parse.parse_skill` 其实**解析出了**这条效果（`parsed_effects` 非空），但没有任何一段代码去应用或登记它。

> 这两条不是「未核验机制 fail closed」——fail closed 是**登记后拒绝**，它们是**静默丢弃**。
> 按本项目的纪律（`effects.py:1-17`「不知道就说不支持」），它们应当至少进 `state.unsupported`。
> 本轮**只报不改**（纪律：不改 `roco/src/**`）。修法：在攻击/防御分支把
> `parse_skill` 解析出但未应用的效果登记为 `unsupported`，代价是每局 `unsupported` 条数上升。

### 3.5 能声称 / 不能声称

- ✅ **能**：这 29（48 内 26）只的 4 个技能**都能被引擎执行到某个结果**（会算 / 会算但有未纠正项 / 部分效果被拒绝并登记），
  且都跑完过整局（1000 局冒烟里出现过）。
- ✅ **能**：给出每只每技能的三分类与原因码，可逐条反驳。
- ❌ **不能**：说这些技能**算对了**。伤害公式未核验、面板拟合有残差、能量口径是假设。
- ❌ **不能**：把 `computed_uncorrected` 当 `computed`——28 条技能里有条件化威力按静态算、
  连击按 1 次算、附带效果被丢弃。

---

## 4. L4 · Demo 展示（48 只）

### 4.1 进入条件（六条，缺一不可）

| # | 条件 | 现在 |
|---|---|---|
| 1 | 可浏览（列表可分页/筛选，不是一屏塞 48 只） | ⚠ **UI 未做**（本轮只设计） |
| 2 | 可选择（点得动、有状态、有可执行提示） | ⚠ **UI 未做**；现有选择 UX 只覆盖 12 只（`/api/roco/roster` 按 `moveset_size > 0` 过滤，`src/client/roco.js:591`） |
| 3 | 可组成**任意合法 3v3** | ✅ 实测 `C(48,3) = 17296 / 17296` 合法 |
| 4 | 可完整打完一局 | ✅ 实测 **1000/1000 完赛**、0 截断、0 异常 |
| 5 | 可被**阵容评估**使用 | ⚠ 服务端 `evaluate_team` 走规则特征；48 只的 `candidate_movesets` 尚未落库（`data.py:368-380` 从 `support-matrix.json` 读，现在只有 12 条） |
| 6 | 可被**局内规划 / 局后复盘**使用 | ⚠ 依赖 5；规划器只用公开视图（`public_planner_state`），48 只进来后会自然生效，但**未实测** |

> **不许把其余的降级成只读来冒充完成**：L4 的判定标准是上面 6 条**全部**满足，
> 而不是「列表里能显示 48 个名字」。

### 4.2 48 只名单的统计（硬产出）

| 项 | 值 |
|---|---|
| 只数 | **48**（其中原 12 只全部在内，`roster-48.json#summary.must_include_all_present = true`） |
| 独特技能数 | **76**（48 × 4 = 192 槽 → 76 个去重技能） |
| 技能类别分布（独特技能） | 攻击 58 / 防御 8 / 状态 10 |
| 技能能耗分布（独特技能） | 0→24、1→8、2→9、3→19、4→9、5→5、6→2（逐值见 `roster-48.json#summary.skill_energy`） |
| 属性分布 | 地系 8 / 冰系 9 / 水系 7 / 虫系 7 / 武系 6 / 幻系 5 / 翼系 5 / 恶系 5 / 幽系 4 / 毒系 4 / 火系 3 / 萌系 3 / 普通系 3 / 草系 3 / 机械系 3 / 龙系 2 / 电系 2 / 光系 2 |
| 角色分布 | attacker 12 / recovery 12 / tank 11 / control 7 / support 6 |
| 速度档分布 | `71-90` 13 / `91-110` 13 / `51-70` 9 / `>=111` 8 / `<=50` 5 |
| 机制覆盖（含该机制的精灵数 / 独特技能数） | damage 48/58、respond 48/15、shield 48/8、energy 37/19、heal 22/9、stat_mod 20/8、multi_hit 15/6、escape 12/6、mark 11/5、priority 11/5、position 10/3、random 3/2、charge 3/2、status_dot 9/5 |
| **fail closed 技能** | **9 / 76 独特技能**；命中的精灵 **22 / 48** |
| 四技能无 fail closed 的精灵 | **26 / 48** |
| 每只特性 | 48 只全部有（`Catalog.lua#feature_skill_id` → `skills.json#is_trait`）；其中 **12 只**引擎有实现状态，**36 只**为未登记（`R4`） |
| Demo 实测 | 1000/1000 完赛；回合 p50 24 / p95 50（max 78）；单局 p50 13 ms / p95 29 ms；`unsupported` 每局 p50 0 / p95 4 / max 18 / mean 0.625 |

**选入标准（可核对，写死在 `scripts/roco/build-roster-48.mjs#selection_rules`）**

1. **属性覆盖**：18 个属性每个 ≥2 只（龙系全图鉴只 14 只，目标降为 1 只；实测 2 只）。
2. **角色**（阈值是设计选择，不是游戏事实）：`attacker` 物攻或魔攻 ≥115 且速度 ≥95；
   `tank` 生命+物防+魔防 ≥340；`recovery` 技能池里「回复生命/吸血」类描述 ≥2 条；
   `control` 「冻结/眩晕/禁足/沉默/封印/麻痹」类 ≥2 条；`support` 「自己获得/敌方获得/驱散」类 ≥3 条；无命中→`attacker`。
   配额（**下限**）：attacker 11 / tank 9 / recovery 11 / control 7 / support 6 = 44，余 4 位给机制与均衡。
3. **速度档**（按种族速度）：`<=50`/`51-70`/`71-90`/`91-110`/`>=111` 配额 5/9/12/11/7 = 44。
4. **资源曲线**：配招**排除** `energy > 6` 的技能（20 条全库 / 18 条落在 48 只可学池），
   因为 `ENERGY_MAX = 6` 让它们永远不合法；`free_attack` 位固定要求 0 能耗攻击。
5. **真实机制（不许只挑好实现的）**：硬机制 8 项 **charge / mark / multi_hit / position / random / escape / respond / priority**
   必须出现在名单并集里；缺一个就抛错。实测 8/8 覆盖（`damage`/`shield` 也全中）。
6. **必须包含原 12 只**（已有 M1 证据链与特性登记）。
7. 选择过程：显式**约束填空**（按候选最稀缺的空缺先填）+ 字典序贪心
   `[新属性, 角色配额, 速度档配额, 新硬机制, 新机制, 技能池大小, 种族值合计]`；同分按 `pet_id` 升序。
8. **不接受**任何社区推荐/使用率：选择只在快照数据内进行。

### 4.3 实现批次（4 批，每批独立可验收）

每批的验收口径统一是三条：**① 能打完一局；② 能进阵容评估；③ 能进局内规划 / 局后复盘**。

| 批次 | 范围 | 交付 | 独立验收 |
|---|---|---|---|
| **批 0 · 地基（必须先做）** | 全量图鉴导入 + 48 只配招落库 | `pets.json`/`learnsets.json` 扩到 622/312（或新增 `catalog.json`）；`support-matrix.json` 增补 48 只的 `candidate_moveset` | ① `validate_team` 对 `C(48,3)` 全绿（已有脚本）；② `/api/roco/roster` 返回 48 且 `moveset_size=4`；③ 现有 16 项 demo-acceptance 不回归 |
| **批 1 · Demo 前 16 只** | 48 只里排序前 16 | UI 分页/筛选首屏；16 只可浏览/可选择/可打 | ① 16 只的两两 3v3 各打 1 局完赛；② `evaluate_team` 对这 16 只返回候选；③ 局末复盘入口出现且有素材 |
| **批 2 · +16 只（共 32）** | 再 16 只 | 同上铺开 | 同上 |
| **批 3 · +16 只（共 48）** | 全部 48 只 | 同上；并处理 9 个 fail closed 技能（见下） | 同上 + ① `C(48,3)` 全绿；② `unsupported` 逐条可见（页面「未核验、因此未结算」） |
| **批 4 · 可选加固** | L3 核心池 26 只 | 把这 26 只标成 `SIM_PARTIAL`（**需要 microcase 通过**，不是代码写完就能升） | 预注册判据通过才算 |

> **批 3 的 9 个 fail closed 技能**有三种处理，必须**明选一种**，不许近似：
> (a) 实现对应原语（前置：术语/实测证据）；
> (b) 换掉该技能槽（用同一只学习表里的另一个技能，选择规则仍走 `mechanism_support` 位）；
> (c) 保留并如实标 `unsupported`（Demo 里该槽空过）。
> 本轮推荐 **(c) 保留 + 标注**（它正是「未核验机制 fail closed」的可见证据），
> 并在 L3 的 26 只里保证核心池不受影响。

---

## 5. refused 原因分类：总表（全层通用）

| 代码 | 中文 | 判定者 | 出现层 | 本轮数量 |
|---|---|---|---|---:|
| `R1_skill_primitive_not_implemented` | 技能原语未实现 | 引擎（`UnsupportedEffect` / `unsupported` 登记） | L2·L3·L4 | 9 / 76 独特技能 |
| `R2_primitive_implemented_unverified` | 有实现但无一手证据（社区假设） | 引擎（`verified=False`） | L2·L3·L4 | 33 / 76 |
| `R3_effect_silently_dropped` | 效果被静默丢弃（**缺陷**） | 实测（§3.4） | L2·L3·L4 | 6 防御子句 + 28 攻击附带 |
| `R4_trait_not_registered` | 特性未登记 | `traits.py#TRAITS`（12 条） | L2·L3·L4 | 48 只里 36 只未登记（60 只里 48 只） |
| `R5_trait_refused_no_evidence` | 特性登记为 REFUSED | `engine-trait-status.json` | L3·L4 | 4（12 只内） |
| `R6_data_field_unsupported` | 上游数据侧标 unsupported | `skills.json#effect_support` | L1·L2·L3·L4 | 824 / 824 |
| `R7_no_mobile_evidence` | 只有单一来源，无交叉核验 | `docs/roco/DATA-CONFLICTS.md` | L1（主）·L2·L3·L4 | 610 / 622 只 |
| `R8_assumption_only` | 引擎自定假设，无手游证据 | `env.py:13,45-48,138` | L2·L3·L4 | 5 类假设 |
| `R_energy_over_engine_max` | 能耗 > 引擎上限假设 → 永远不合法 | `env.py:45,184` | L2·L3·L4 | 20 / 824 技能 |

> **没有手游证据的机制禁止自行设计**：本轮名单里**没有**天气、场地、`地形` 之类
> 只出现在推测里的机制。设计上若需要它们，只能登记为「待实测」，
> 例如 `parse.py:89` 能认出「将天气改为X」但 `env.py:683-684` 拒绝结算——
> 这就是正确的处理方向，而不是补一个天气层。

---

## 6. 复核命令

```bash
# 生成 48 / 60 两份名单（含人类可读版）
node scripts/roco/build-roster-48.mjs
node scripts/roco/build-roster-48.mjs --size 60

# 引擎侧逐技能分类 + 3v3 冒烟（需要先导出全量图鉴到 tmp/）
node scripts/roco/export-full-catalog.mjs
python3 scripts/roco/audit-roster-48.py --skip-matches
python3 scripts/roco/audit-roster-48.py --matches-per-strategy 200 --seed 20260910
python3 scripts/roco/audit-roster-48.py --roster reports/roco/coverage/roster-60.json --matches-per-strategy 200 --seed 20260910

# 守卫（名单/文档/数字漂移就红，且自带必红反证）
node scripts/roco/verify-coverage-axes.mjs
```
