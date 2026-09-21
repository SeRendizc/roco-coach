# 600+ 精灵、我的盒子与养成系统设计

## 1. 600+ 精灵会不会把工作量炸掉？

**如果架构正确，不会。**

把一只新精灵加入系统可以分成四种成本：

| 层 | 每只成本 | 是否需要人工逐只写代码 |
|---|---:|---|
| 图鉴数据 | 极低 | 否 |
| 我的盒子个体实例 | 极低 | 否 |
| 阵容静态评估 | 低 | 否，依赖通用特征 |
| 完整战斗语义 | 取决于它用了哪些新机制 | **只为新机制写一次** |

如果第 501 只精灵使用的都是已经实现的 `direct_damage / respond_attack / heal / mark / switch_trigger / priority`，它进入 simulator 基本只是数据接入和回归测试。

如果第 502 只第一次引入“把敌方本回合回复生命改为失去 2 倍”，真正要实现的是一个新的 **effect primitive**。实现一次后，同类技能复用。

增长曲线应该是：

```text
错误架构：pets ↑ → source code roughly linear ↑
正确架构：pets ↑ → data rows ↑；unique mechanics ↑ → engine code ↑
```

当前仓库已经从 824 条技能记录里抽出了约 68 类效果原语，这是正确方向。

## 2. 四层数据模型

### L1：Catalog，全量静态知识

```ts
type PetCatalogEntry = {
  catalog_id: string
  display_name: string
  form_name?: string
  dex_no?: string
  types: TypeId[]
  base_stats: StatVector
  trait_ref?: string
  learnset_ref: string
  evolution?: EvolutionSpec
  boss_form?: FormRef
  provenance: Provenance[]
  unknown_fields: string[]
}
```

它回答“这只是谁、属性/六维/技能来源/特性/形态是什么”，不回答“当前版本一定强不强”。

### L2：OwnedPet，我真正拥有的那一只

```ts
type OwnedPet = {
  instance_id: string
  catalog_id: string
  level: number
  talent_grade?: string
  individual_qualifications: StatVector
  nature?: NatureId
  specialty?: SpecialtyId
  bloodline?: BloodlineId
  growth?: GrowthState
  move_slots: [SkillId, SkillId, SkillId, SkillId]
  boss_form_unlocked?: boolean
  favorite?: boolean
  locked?: boolean
  data_source: "demo" | "manual" | "imported_game_state"
}
```

同一个物种可以有多个个体，Coach 才能比较“这两只到底练哪只”。

### L3：BattleBuild，某次出战配置

```ts
type BattleBuild = {
  owned_pet_instance_id: string
  effective_form: FormId
  ordered_skills: [SkillId, SkillId, SkillId, SkillId]
  effective_bloodline?: BloodlineId
  derived_stats: StatVector | Unknown
  derived_stats_confidence: Confidence
}
```

技能位必须有序，因为当前游戏有“传动”“1/3号位”“两侧技能”等机制。

### L4：SimulationSupport（动态能力门槛，不是固定名单）

```ts
type SimulationSupport = {
  build_hash: string
  ruleset_id: string
  trait_support: "verified" | "implemented_unverified" | "refused"
  skill_support: Record<SkillId,
    "verified" | "implemented_unverified" | "partial" | "fail_closed">
  timing_support: "verified" | "partial" | "unknown"
  required_primitives: string[]
  missing_primitives: string[]
  evidence_ids: string[]
}
```

“在图鉴里”永远不等于“可精确模拟”，但这也不意味着只有一份写死的 48 只名单能战斗。

### 2.5：一个数据包，按选择编译

所有 621/622 条精灵记录进入同一个版本化 `GameDataPack`：

```ts
type GameDataPack = {
  ruleset_id: string
  catalog: Record<PetId, PetCatalogEntry>
  skills: Record<SkillId, SkillDefinition>
  traits: Record<TraitId, TraitDefinition>
  learnsets: Record<PetId, SkillId[]>
  natures: Record<NatureId, NatureDefinition>
  bloodlines: Record<BloodlineId, BloodlineDefinition>
  source_manifest: ProvenanceManifest
}
```

玩家选中某个 `OwnedPet` 与四个有序技能后，系统才为这一个 build 做按需编译：

```text
resolve species/form
→ validate owned fields and learnset
→ collect skill + trait dependencies
→ lower into Effect/Trigger IR
→ compare with primitive and timing registry
→ emit SimulationSupport
→ cache by ruleset_id + entity revisions + build_hash
```

因此：

- 622 只全部可以查资料、筛选、收藏、生成个体、参与有置信度的静态配队；
- 使用已支持原语的新精灵可以自动进入模拟器；
- 遇到新机制时只实现一次 primitive/trigger，同类精灵随之解锁；
- 当前 48 个 Demo build 只作为迁移回归夹具；长期回归按机制 microcase、全量目录分层抽样和历史失败样本组织，不维护精灵白名单；
- 不支持的 build 不会被偷偷近似成普通攻击，系统会列出缺失能力并给兼容配招或替代精灵。

## 3. “我的盒子”怎么生成

### A. Demo 盒子

从全量数据包固定 seed 生成 80～150 个 owned instances：允许同种重复，但性格、资质、特长、血脉、当前技能不同。至少包含若干“同种不同个体”，让比较功能有真实任务。

目的不是模拟抽卡，而是让“个体选择”和“培养成本”真实出现。

### B. 手工导入

```text
添加我拥有的精灵
→ 选择物种
→ 性格
→ 资质
→ 特长
→ 血脉
→ 当前技能
```

### C. 官方宿主适配器

真实嵌入时由游戏宿主传：

```text
RosterSnapshot
OwnedPetSnapshot
BuildSnapshot
```

不要把 OCR 当最终架构。

## 4. 养成模拟到哪一步

只建模**会影响 Coach 决策**的变量。

### P0

- 物种 / 形态
- 六维种族资质
- 等级
- 性格
- 个体资质
- 特性
- 特长
- 血脉
- 四技能及顺序
- 首领形态可用性

### P1

- 成长次数 / 成长值
- 培养资源成本
- 当前可调整项 / 不可逆项
- 亲密/羁绊（拿到可靠规则后）
- 技能获取成本

### P2

- 捕捉过程
- 孵蛋
- 地图获取路线
- 资源刷取路线

## 5. “天分不行要不要练”怎么判断

不要做一个单一 `quality_score = 83`。

先确定角色：

```python
quality(instance, role, build, opponent_pool)
```

例如高速物攻角色重点看速度、主攻资质、性格和关键速度线；坦克重点完全不同。

输出结构：

```json
{
  "verdict": "usable_but_not_ideal",
  "role": "fast_physical_attacker",
  "hard_fail": [],
  "advantages": ["物攻资质高", "性格不压速度"],
  "limitations": ["速度距目标速度线差 4"],
  "upgrade_priority": ["优先换速度更高个体"]
}
```

不要用总资质简单相加。

## 6. 玩家锁定 0 / 1 / 3 只时任务如何变化

### 一个都没选

```text
Owned Box
→ 合法性过滤
→ 角色/体系候选
→ 核心组合
→ 补联防/资源/速度/工具位
→ shortlist
→ versioned Completion Value / Team Ranker
```

### 锁定一只

“我一定要带迪莫”变成硬约束：

```text
MUST_INCLUDE(instance_42)
```

不是先算最强队再硬塞。

### 锁定部分成员但结构很差

先诊断：

```text
- 某高威胁无人稳定承接
- 速度线全低
- 高费核心过多
- 攻击类过多、应对结构单一
```

然后每个补位都说明“填了哪个缺口、牺牲了什么”。

### 允许换掉一只

输出：

```text
保留 2 / 3
替换 1 / 3
```

而不是一键重配。

## 7. 组合爆炸怎么控制

不暴力枚举 `C(622, 6)`，也不把 622 份完整定义全部装进每次请求。

```text
Hard Constraints
→ Candidate Retrieval（每槽 10~30）
→ Cheap Team Features
→ Beam / Pareto / Learned Ranker
→ Top-K 六宠队伍
→ versioned Team Ranker / Completion Value
→ explanation
```

在线请求只加载：玩家 owned pool 的轻量索引、召回出的候选定义、Top-K 六宠阵容涉及的 build、版本 Meta prior 与模型缓存。全量包驻留为索引或本地数据库，Effect IR 编译结果按版本缓存。批量对战和自博弈在离线完成，线上不临时跑 opponent pool simulation。

Cheap features：

- 属性覆盖 / 共同弱点
- 角色覆盖
- 关键速度线
- 能量曲线
- 应对类别覆盖
- 入场/离场协同
- 印记/天气体系
- 特性依赖
- 用户锁定约束
- 个体可用性
- 培养成本

## 8. 600+ 数据真正需要做的工程

不是写 622 个对象字面量，而是：

```text
ingest
→ normalize
→ provenance
→ schema validation
→ conflict detection
→ diff by season
→ support classification
→ searchable index
→ owned-instance layer
```

每赛季应有：

```bash
npm run roco:sync-live-catalog
npm run roco:catalog-diff
npm run roco:coverage-report
```

还应有：

```bash
npm run roco:compile-build -- --owned-id <id>
npm run roco:verify-capability-cache
npm run roco:rag-eval
```

其中 RAG 不能只证明“数据存在”，至少评估实体命中率、Recall@K、MRR、版本命中率、证据归属正确率和来源冲突时的 abstention。

输出新增精灵、变化特性/技能/属性/学习表、受影响规则和需重建轨迹。

## 9. 当前 622 与公开 621 的处理要求

生成：

`reports/roco/live-catalog-diff-YYYY-MM-DD.json`

至少列：

```json
{
  "frozen_snapshot_pet_records": 622,
  "live_public_trait_linked_forms": 621,
  "only_in_snapshot": [],
  "only_in_live": [],
  "same_id_changed": [],
  "explanation_status": "unresolved"
}
```

原因没找清前，UI 可以诚实显示“数据快照 622 条；当前公开特性图鉴关联 621 个形态；口径待对账”，不要偷偷删一条。
