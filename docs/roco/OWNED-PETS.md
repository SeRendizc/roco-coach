# OwnedPet 与 BattleBuild（RC-203）

这一页讲清楚三件事：

1. **OwnedPet / BattleBuild 是什么**，它们和「图鉴里那只精灵」不是一回事；
2. **怎么重建、怎么校验**（命令、判据、必红方向）；
3. **边界**：哪些字段是**标签**、哪些是**未知**，以及为什么阵容评估现在**不能**把它们当成已知加成。

产物的三个文件（其余都是输入，只读）：

| 文件 | 是什么 | 谁写的 |
|---|---|---|
| `data/roco/owned/schema.json` | OwnedPet / BattleBuild 的**自描述契约**（字段类型 / 必填 / 可空 / 来源要求） | `scripts/roco/build-owned-pets.mjs` |
| `data/roco/owned/owned-pets.json` | 80 个 Demo owned 实例 + 80 条 BattleBuild（固定 seed） | 同上 |
| `reports/roco/flagship-upgrade/rc-203-owned-pets.json` | 机器可读报告：逐条判据的实际值、逐只点名、跳过原因、复现命令 | 同上（`verify-owned-pets.mjs` 的判据） |

---

## 1. 为什么要有这一层

数据分四层（`/tmp/roco-coach-handoff-revised-2026-09-21/02-DATA-SCALE-AND-CULTIVATION.md`）：

```text
L1 PetDefinition   这个物种是谁：属性 / 静态种族值 / 可学技能 / 特性 / 形态
L2 OwnedPet        我真正拥有的那一只：等级 / 性格 / 资质 / 特长 / 血脉 / 四技能 / 收藏 / 锁定
L3 BattleBuild     某一次出战配置：出战形态 + 有序四技能 + 有效血脉 + 派生面板
L4 SimulationSupport  这份 build 现在能不能精确模拟（动态门槛，不是白名单）
```

L1 回答「这是什么」，**不回答**「我这只怎么样」。同一个物种可以有多个个体，
教练才有得比——「这两只到底练哪一只」是 L2 才回答得了的问题。
所以 **`instance_id` 是主键，`species_id` 只是外键**。

`BattleBuild` 把「哪个个体 + 哪套技能位顺序」钉下来。技能位**有序**不是格式洁癖：
当前游戏有「传动」「1/3 号位」「两侧技能」这类机制，顺序不同就是不同 build。
产物里 `BattleBuild.ordered_skills` 必须与 `OwnedPet.skills` **逐位相同**，
少一位、换一位都判红（`skill_order` 判据）。

---

## 2. 「600+ 是候选宇宙，48 只只是迁移夹具」

这句话在本任务里不是口号，是被**判据**钉住的：

- 候选宇宙的起点是 `pack.json` 的 **622** 条 pet 实体，不是一份写死的 48 只名单；
- 但**技能只能来自 learnsets**。冻结目录里只有 **48** 只精灵有 `learnsets.json` 条目：
  - `learnsets.json`（主目录）**12 只**——文档里叫 baseline；
  - `layer-playable-48/learnsets.json` **36 只**——overlay；
  - 合计 48。上游快照里其实有 312 份 learnset，其余那些**没有导入冻结目录**。
- 于是产物是：**从 622 只出发 → 574 只因「没有冻结 learnset」被跳过 → 在 48 只里生成 80 个实例**。
  跳过的每一只都在报告的 `skips.species[]` 里逐只点名，不是一句「大概没数据」。

判据要求：

| 判据 | 下界 | 实际 |
|---|---|---|
| 实例数 | ≥ 80 | 80 |
| 不同 `species_id` 数 | ≥ 40 | 48 |
| **不在 `layer-playable-48` 里的 species 数** | **≥ 12** | **12** |
| 同种不同个体组数（每组至少一项个体属性不同） | ≥ 20 | 32 |

「不在 `layer-playable-48` 里」按**目录字面**算：`layer-playable-48/` 目录
（`pets.json` / `learnsets.json` / `support-matrix.json` 的 pet 集合，36 只 overlay）里
没有、而主 `learnsets.json` 里有的那 12 只，就是 baseline 层。逐只点名：

```text
pet_000062 音速犬      pet_000112 雪影娃娃    pet_000124 化蝶
pet_000190 海豹船长    pet_000225 寂灭骨龙    pet_000417 圆号鱼
pet_000445 黑猫巫师    pet_000451 秩序鱿墨    pet_000474 画间沉铁兽
pet_000601 圣凯布米龙  pet_000608 银月狼王    pet_000611 月使鹭纳
```

> **需要知道的紧张点（写在报告里，不藏着）**：`roster-48.json`（48 条）把 baseline 12 只
> **也算进去**（doc 里叫「48 只 = 12 基线 + 36 overlay」）。有冻结 learnset 的 48 只
> **恰好等于** roster-48 的 48 只，所以若把 roster-48 当成「48 层」，
> 池外 species 数是 **0**。本仓按任务文本点名的 **`layer-playable-48` 目录** 做判据
> （实际值 12），并在报告的 `outside_layer_playable_48.alternative_reading` 里
> 把另一个口径的数一并给出——两个口径都摆在明面上，由读者判断，
> 而不是挑一个对自己有利的算法。

---

## 3. 怎么重建 / 怎么校验

```bash
# 重建三份产物（确定性：同输入两次逐字节相同）
node scripts/roco/build-owned-pets.mjs

# 可复跑判据：现在重建的结果必须与磁盘**逐字节相同**，不写盘
node scripts/roco/build-owned-pets.mjs --check

# 必红反证：把产物改坏，对应判据必须翻红（13 条）
node scripts/roco/build-owned-pets.mjs --selftest

# 独立校验（16 组判据；rc=0/1）
node scripts/roco/verify-owned-pets.mjs
node scripts/roco/verify-owned-pets.mjs --json
node scripts/roco/verify-owned-pets.mjs --selftest

# 单元测试（真产物判据 + 必红反证 + 比较器）
node --test tests/roco-owned-pets.test.js
```

### 确定性

- 固定 `seed = 20301`（自写 mulberry32，不用 `Math.random`，跨 Node 版本逐位可复现）；
- **产物里一个挂钟字段都没有**：`generated_at` 由 `ruleset_id` 推导
  （`roco-world-s4-2026-09-10` → `2026-09-10T00:00:00.000Z`），`clock_fields` 恒为 `[]`。
  这样 `--check` 可以逐字节比对，**不需要任何字段豁免**；
- 三级哈希：`instance.build_hash` / `build.build_hash` / `dataset.dataset_hash`，
  都可以重算（产物被手改即红）。

### 16 组判据

`schema_compliance` / `schema_file` / `species_existence` / `species_universe` /
`learnset_membership` / `skill_order` / `instance_identity` / `growth_attributes` /
`unknown_fields` / `provenance_on_disk` / `licence_refs` / `build_hashes` /
`battle_builds` / `base_stats_pointers` / `determinism_declaration` / `declared_counts`

每一条都在报告里出现（通过的也出现——否则「判据通过」和「没有这条判据」分不清）。

### `unknown_fields` 的唯一判据

`unknown_fields` 不许人工列举，必须**从实例本身重算**，否则做不到双向判红：

```text
unknown_fields ≡ { f | instance[f] === null }
              ∪ { f | instance[f] 是养成属性且 instance[f].value === null }
```

- 有值却标 `unknown` ⇒ 红（例如把 `level` 塞进去）；
- 该标没标 ⇒ 红（例如把 `talent` 抽出来）。

实例级 `unknown_fields_allowlist` = `["nature","talent","specialty","bloodline","panel_stats"]`。
BattleBuild 级的 `unknown_fields` 恒为 `["derived_stats"]`（overlay 个体的
`effective_bloodline` 取值为 null 时也列入）。

---

## 4. 边界：这些字段现在**只是标签**

10 号文档 §13 的原话是：性格 / 个体资质 / 特长 / 血脉技能来源 / 首领形态这些字段
**在条目里广泛展示**，但「具体面板换算公式仍需独立校准，不因字段存在就自造换算」。

本产物的处理方式：

| 字段 | 产物里的内容 | 为什么 |
|---|---|---|
| `nature` 性格 | `value: null`，`effect: "UNKNOWN"` | 冻结目录里没有任何性格取值枚举。仓里唯一一张性格加成表在 `data/roco/raw/extracted/NRC_AI/src/pokemon_nature_table.py`——那是 **REFERENCE_ONLY**（不得进入可分发产物）的交叉核验来源，而且标的是**另一款游戏**（页游洛克王国，百度百科）。不用。 |
| `talent` 个体资质 | `value: null`，`effect: "UNKNOWN"` | 没有任何取值枚举。字段存在 ≠ 换算已知。 |
| `specialty` 特长 | `value: null`，`effect: "UNKNOWN"` | 同上；快照只说「一般般的天分无法获得特长」，没有取值表。 |
| `bloodline` 血脉 | baseline 12 只：`value` = 真实血脉名（来自 `learnsets.json` 的 `blood_skills[].blood`）；overlay 36 只：`value: null` | `layer-playable-48` 那份 learnsets 里 `blood` 是 `null`（`blood_status: not_provided_by_source`）。无名可标就标 UNKNOWN，不拿 18 条无名的 `skill_id` 编一个「血脉」出来。 |
| `base_stats` 静态种族值 | **有值**，带 `provenance` pointer 指回 `full-catalog.json` 的 `pets[i].stats` | 这是冻结目录里真有的**静态**种族值，不是等级换算后的面板值。 |
| `panel_stats` 面板值 | `null` | 等级换算后的面板值需要未校准的公式。**不给数**（fail closed，而不是给个估数）。 |
| `BattleBuild.derived_stats` | `null`，`derived_stats_confidence: "UNKNOWN"` | 同上。 |

纪律：

- 养成属性里禁止出现 `formula` / `multiplier` / `modifier` / `percent` / `ratio` /
  `coefficient` / `bonus` / `公式` / `系数` / `加成值` 这类字段名——出现即红；
- `effect` 只能是 `"UNKNOWN"`，或者一个能在 `GROWTH_EFFECT_EVIDENCE_IDS` 白名单里查到的证据 id。
  本仓该白名单**当前是空的**（面板换算证据一条都没有），所以任何具体数值（例如 `0.2`）
  或臆造的证据 id（例如 `microcase:panel-formula-v1`）都直接判红；
- `effect_reason` 必须逐字是「面板换算公式未校准（见 10 号文档 §13）」，`microcase_id` 必须是 `null`。

### 因此：阵容评估**不得**把它们当成已知加成

`nature` / `talent` / `specialty` / `bloodline` 现在能提供的信息只有：

- 「这两个个体在这一项上取值不同 / 相同 / 未知」（`compareOwnedPets` 的逐字段结论）；
- 血脉那一层，baseline 12 只还多一条 `(blood → skill_id)` 的静态映射。

它们**不能**提供任何面板增量。任何把性格/资质/特长/血脉换算成数值的代码，
在这份数据上都是**在编公式**。要解锁，需要：一条可分发来源给出取值与换算 +
一条 microcase 校准 —— 校准之后再由 RC-403 的支持分级接管。

---

## 5. 同种个体比较（纯函数）

`scripts/roco/owned-pets-lib.mjs` 导出 `compareOwnedPets(a, b)`：

- **不同物种直接抛 `OwnedPetSpeciesMismatchError`**，不静默比较
  （「比较两只不同的精灵」是编程错误，不是「结果为空」）；
- 逐字段给出 `same / different / unknown`：
  - 双方都有值且相等 → `same`；
  - 双方都有值且不等 → `different`；
  - 任一方为 `null` → `unknown`（不可比，而不是「不同」）；
- 技能是**有序数组**：顺序不同即 `different`，另外单独给一条 `skills_as_set`
  （集合比较），让「同技能不同顺序」与「技能不同」能分开看；
- 返回 `different_fields` / `unknown_fields` / `differs_in_at_least_one_attribute`。

「同种不同个体」的判据直接复用这个函数：80 个实例里 32 组同种，
每一组都至少有一项个体属性不同（实际全部由 `level` + `skills` 保证；
生产器对每一对同种个体强制 `level` 不同，所以这条不靠运气）。

---

## 6. 已知缺口（如实）

1. **技能的覆盖面受冻结目录限制**：只有 48 只精灵有 `learnsets.json`，
   574 只被跳过。上游快照里明明有 312 份 learnset，但没有导入冻结目录，
   本产物 fail closed，不给它们配技能。「全量 600+ 都能出战」要等导入或
   等 RC-402/RC-403 的按需编译，不是这一条能解决的。
2. **`nature` / `talent` / `specialty` 全部是 `null`**，`bloodline` 有 56/80 个实例是 `null`
   （全部 overlay 个体）。也就是说 80 个实例里，能拿来做个体差异比较的只有
   `level` 与 `skills`。这是数据现实，不是生成器的选择。
3. **血脉只有 baseline 12 只有名字**，且**没有任何血脉结算信息**——只有
   `(blood → skill_id)` 的静态映射。
4. **`panel_stats` / `derived_stats` 全为 `null`**：这批 build 现在只能做
   **静态诊断**（技能/属性/个体差异），不能算面板数值，也因此不能进需要
   数值面板的模拟路径。
5. **`favourite` / `locked` / `level` 是 Demo 值**：它们描述「玩家拥有什么」，
   不是游戏常量，所以由固定 seed 生成；冻结目录只提供技能的习得等级
   （`native_skills[].level`），本产物用它做过一致性约束（四技能的习得等级 ≤ 实例等级）。

## 这批实例**不能**证明什么（如实）

- **它能证明的**：80 个 owned 实例、48 个 species、32 组同种不同个体、每个实例四个**有序**且**真实可学**的技能，
  全部可复跑（`--check` 逐字节相同）、带逐实体 provenance 与 licence_ref、养成效果一律标 UNKNOWN。
- **它不能证明的**：**「600+ 都能出战」**。冻结目录只导入了 **48 份 learnset**（12 基线 + 36 overlay），
  上游快照另有 264 份未导入，所以 622 个候选里有 **574 只**在 `no_frozen_learnset` 上 fail closed 跳过。
  可出战的子集**恰好等于** `roster-48.json` 的 48 只 —— 换句话说，**48 是「冻结 learnset 覆盖」的上限，
  不是我们设的白名单**，但它现在确实是边界。要突破它需要导入其余 learnset，或走 RC-402 的按需能力编译。
- **一个容易误读的数**：报告里「不在 `layer-playable-48` 目录的 species = 12」。那 12 只是**基线层**的 12 只，
  它们本来就在 `roster-48.json` 的 48 只**之内**；按 roster-48 口径，池外是 **0**。
  所以这个数**不能**当作「候选宇宙不止 48 只」的证据（报告的 `outside_layer_playable_48.alternative_reading`
  与 `buildability_ceiling` 两段都写明了这一点）。
- **个体属性**：`nature` / `talent` / `specialty` 的 `value` 恒为 `null`，`bloodline.value` 有 56/80 为 `null`，
  `panel_stats` / `derived_stats` 全为 `null` —— 因此**能用来做个体比较的只有 `level` 与技能组合**，
  阵容评估**不得**把养成属性当已知加成。
