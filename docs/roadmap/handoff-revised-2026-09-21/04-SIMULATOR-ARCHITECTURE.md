# Simulator / Rule Engine 扩展架构

## 1. 目标

达到：**增加精灵主要是增加数据；只有遇到新的战斗语义时才增加代码。**

不是：

```text
if pet == A ...
elif pet == B ...
elif pet == C ...
```

## 2. 五层结构

```text
Source Snapshots
      ↓
Normalizer
      ↓
Canonical Game Data
      ↓
Effect / Trigger IR
      ↓
Capability Compiler + versioned cache
      ↓
Deterministic Battle Engine
      ↓
Observation / Planner / Coach
```

### 2.1 Source Snapshot

永远只读：`source_id / revision / sha256 / fetched_at / license`。

### 2.2 Canonical Game Data

统一 `pets / skills / traits / types / learnsets / natures / specialties / bloodlines / battle_modes`。

### 2.3 Effect IR

```json
{
  "id": "skill_x",
  "cost": 2,
  "category": "defense",
  "triggers": [
    {
      "when": "ON_USE",
      "effects": [{"kind": "DAMAGE_REDUCTION", "ratio": 0.8}]
    },
    {
      "when": "ON_RESPOND_SUCCESS",
      "condition": {"opponent_action": "attack"},
      "effects": [{
        "kind": "MODIFY_SKILL_COST",
        "target": "ADJACENT_SKILLS",
        "delta": -1,
        "duration": "permanent"
      }]
    }
  ]
}
```

## 3. Effect Primitive Registry

当前仓库抽出的约 68 类 primitive 是正确工作单位。

```text
新宠 ≠ 新代码
新技能名 ≠ 新代码
新特性名 ≠ 新代码
新语义 primitive = 新代码
```

每个 primitive：

```ts
interface EffectPrimitive {
  kind: string
  validate(spec, ruleset): ValidationResult
  apply(ctx, spec): BattleEvent[]
}
```

核心族：

```text
DIRECT_DAMAGE / DYNAMIC_POWER / POWER_MODIFIER / MULTI_HIT
HEAL / LIFESTEAL
ENERGY_GAIN / ENERGY_DRAIN / ENERGY_COST_MODIFIER
STAT_BOOST / STAT_DROP / DAMAGE_REDUCTION
MARK / STATUS_DOT / WEATHER
SWITCH_LEAVE / SWITCH_TRIGGER / SWIFT
PRIORITY / TRANSMISSION / INTERRUPT / FORM_CHANGE / REVIVE
```

## 4. Trigger Registry

Skill 和 Trait 共用：

```text
ON_BATTLE_START
ON_ENTER
ON_LEAVE
ON_TURN_START
ON_DECISION_LOCK
ON_SKILL_USE
ON_RESPOND_SUCCESS
BEFORE_DAMAGE
ON_DAMAGE
AFTER_DAMAGE
ON_FAINT
ON_TURN_END
```

242 个特性大多数应该只是 `trigger + conditions + existing effects`，不需要 242 个 Python 分支。

## 5. Event-sourced Resolver

每次状态变化产生 Event：

```json
{
  "event_id": "e123",
  "turn": 7,
  "phase": "ACTION_1",
  "kind": "damage",
  "source": "...",
  "target": "...",
  "before": {"hp": 311},
  "after": {"hp": 247},
  "evidence_ids": ["..."],
  "ruleset_id": "...",
  "verified": false
}
```

用途：replay、debugging、复盘、Coach evidence、training trajectory、版本对比。

## 6. TrueState 与 Observation 继续分开

保持：

```text
TrueState
  所有隐藏信息
      ↓ observe(side)
PublicObservation
  该玩家当前应该知道的东西
```

Planner 只能读 Observation。UI 可以有 UIPublicView 增加名字、徽标、文案，但绝不能因此泄漏对手隐藏信息。

## 7. Joint Action 必须保留

```python
step_joint(action_a, action_b)
```

而不是先 player.step 再 enemy.step，否则第二决策者会偷看到第一个动作。

```text
O_t
→ A_t_player + A_t_enemy
→ lock
→ resolve
→ O_{t+1}
```

## 8. 版本与不确定性

每条规则：

```ts
RuleEvidence {
  rule_id
  ruleset_id
  status: OFFICIAL_CURRENT | RECORDED_IN_GAME | COMMUNITY_CURRENT |
          CROSS_SOURCE_SUPPORTED | ENGINE_HYPOTHESIS | UNKNOWN
  source_refs[]
  observed_cases[]
}
```

UNKNOWN 时不能退化成默认 40 威力普攻。应 `fail closed` 或明确 `partial + unsupported event`。

## 9. 规则变化后的依赖图

```text
RuleChange
   ↓
affected primitives
   ↓
affected skills / traits
   ↓
affected pets
   ↓
affected fixtures
   ↓
affected trajectories
   ↓
affected trained models
```

每个训练产物 manifest：

```json
{
  "artifact": "agent-sft-v4",
  "depends_on": {
    "ruleset": "...",
    "engine_sha": "...",
    "trajectory_sha": "..."
  }
}
```

规则修正后，不允许旧模型报告继续标 current。

## 10. 能量规则迁移策略

### Phase A：加入新规则配置，不删旧规则

```text
community_hypothesis_v1
mobile_s4_candidate_v2
```

### Phase B：双规则对照

输出合法动作、回合长度、可使用技能、planner 推荐、team score 的差异。

### Phase C：microcase 通过后 promotion

```text
mobile_s4_candidate_v2 → current
```

### Phase D：重建 roster、support reports、trajectories、team model、SFT datasets、evaluation fixtures、demo screenshots。

## 11. 全量 621/622 的正确扩展方式

支持状态按 **build + ruleset** 动态计算，而不是维护固定的 48 只白名单：

```python
for build in selected_or_regression_builds:
    required = union(
        build.trait.required_primitives,
        *[skill.required_primitives for skill in build.ordered_moveset],
        build.form.required_rules,
        battle_mode.required_rules,
    )
    support = classify(required, primitive_registry, timing_registry, rule_evidence)
```

输出：

```text
FULL_VERIFIED
FULL_SIMULATABLE_UNVERIFIED
PARTIAL
KNOWLEDGE_ONLY
REFUSED
```

KPI 看 primitive coverage / trait semantic coverage / skill semantic coverage / representative archetype coverage，不只看 pets_supported。

编译产物缓存键必须至少包含：

```text
ruleset_id + pet revision + trait revision + ordered skill revisions
+ nature/bloodline/specialty revisions + battle_mode + compiler version
```

任何依赖变化都让缓存失效。第 49 只精灵如果只依赖已支持原语，会自动成为 simulatable；若出现一个未知特性，就保持 knowledge/static-evaluation 可用，战斗层 fail closed，并输出缺失依赖与兼容 build 建议。

## 12. 测试金字塔

### L0 primitive test
一个效果一个最小测试。

### L1 microcase
一个真实机制一个 tiny battle。

### L2 interaction case
如 swift+transmission、respond+energy modifier、mark+switch、weather+end-turn。

### L3 random replay
数千局 invariants：HP/能量不越界、terminal 后不可 step、replay digest 一致、无 hidden leakage。

### L4 recorded real case
真实游戏录像/测量：输入状态、双方行动、真实输出、模拟输出。

### L5 product E2E
浏览器：状态 → plan → suggestion → action → stale suggestion disappears。

### L6 capability admission
从全量图鉴随机抽样 build：已支持依赖必须自动通过；注入一个未知 primitive 必须拒绝；相同 build 第二次命中版本缓存；任一来源 revision 变化必须重新编译。

## 13. 性能目标

```text
catalog search < 50 ms
team cheap evaluate < 100 ms
battle legal actions < 10 ms
single deterministic step < 10 ms
2–3 ply plan < 300 ms local target
Coach first visible hint < 500 ms rules path
LLM explanation async
```

规则层短建议先显示，模型解释晚到不能阻塞游戏。

## 14. 与当前仓库的迁移原则

### 保留

- `roco/src/roco_env`
- current service envelope
- public observation
- replay
- Node toolbox
- stale result checks
- release guard
- mock host
- current evaluation artifacts

### 改造

- hard-coded assumptions → versioned rule config
- partial parser → Effect IR
- trait registration → data-driven trait DSL
- roster filtering → support classifier
- current 3v3 demo → 活动型 `BattleMode`；标准 PVP 单独使用六宠候选配置

### 避免新增

- pet-specific special case
- Coach hard-code energy max
- duplicate constants in JS + Python
- UI-specific game-rule logic
