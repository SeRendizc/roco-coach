# 《洛克王国：世界》战斗规则与回合结算规格

> 本文是 Roco Coach 的候选可执行规格，不冒充官方完整规则书。置信等级统一为 `OFFICIAL_CURRENT / RECORDED_IN_GAME / COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED / ENGINE_HYPOTHESIS / UNKNOWN`。只有前两级可以直接 promotion 为当前真实规则；社区交叉支持只能进入 candidate ruleset。

## 1. 已高置信确认的基础结构

### 1.1 回合制 + 同回合双方决策

双方在一个回合中各选择动作，结算器再决定顺序。核心不是“速度快就永远先打”，而是多层优先关系。

### 1.2 能量取代单技能 PP

当前多份社区资料和实际体验文章交叉支持：

```text
技能共享当前精灵的能量池
常规上限 10
聚能是主动行动
聚能恢复 5
```

**当前仓库的 6 上限 / 每回合 +1 / 初始 2 是显式假设，与这些公开资料冲突，必须重新校准。** 但在缺少官方规则文字或录制实机 microcase 前，`10 / 聚能+5 / 无自然回能` 只能进入 `mobile_s4_candidate_v2`，不能直接覆盖 current ruleset。

不要 search-and-replace 后宣布修好；必须连带重建合法动作、名单过滤、轨迹、模型和测试。

### 1.3 技能类型与机制规模

现行 BWIKI 2026-09-09：579 个战斗技能、18 系；物攻 199、魔攻 159、防御 54、状态 167。

同时存在应对、印记、先手、离场、天气、选择、巧变、连击、萌化、引电、迅捷、传动、迸发、奉献、打断等机制。因此 simulator 必须是“事件 + 效果原语”，不能只有 Damage/Defense/Buff 三类。

## 2. 推荐 BattleState

```ts
type BattleState = {
  ruleset_id: string
  state_version: number
  turn: number
  phase: BattlePhase
  global: {
    weather?: WeatherState
    battle_mode: BattleMode
  }
  player: SideState
  opponent: SideState
  pending_events: BattleEvent[]
  history_digest: string
}
```

SideState：

```ts
type SideState = {
  magic_points: number
  active_slot: number
  roster: BattlePetState[]
  positive_mark?: MarkState
  negative_mark?: MarkState
  resonance_magic?: ResonanceState
  item_uses?: ItemUseState
}
```

**印记优先建模成 side-level state**：现行图鉴说明下场后不消失、新入场继承，且同时最多 1 正 + 1 负。

## 3. 一回合的决策对象

```ts
type TurnDecision = {
  main:
    | UseSkill
    | SwitchPet
    | Charge
    | ForcedReplacement
  auxiliary?: {
    resonance_magic?: ResonanceMagicUse
    recovery_item?: RecoveryItemUse
  }
}
```

“道具/共鸣是否与主行动并存”的精确规则仍需版本实机验证；数据结构先支持二级动作，不要绑死。

## 4. 推荐事件阶段

```text
P00 PRE_TURN
P10 DECISION_LOCK
P20 PRE_RESOLUTION
P30 ACTION_ORDER
P40 ACTION_1
P45 BETWEEN_ACTIONS
P50 ACTION_2
P60 POST_ACTIONS
P70 END_TURN
P80 FAINT_AND_REPLACEMENT
P90 TERMINAL_CHECK
```

特性/技能挂 hook：

```text
ON_ENTER
ON_LEAVE
ON_SKILL_SELECTED
BEFORE_SKILL
ON_RESPOND_SUCCESS
ON_DAMAGE
AFTER_DAMAGE
AFTER_SKILL
ON_FAINT
END_TURN
```

## 5. 行动优先顺序

当前工程规格建议：

```text
1. 特殊立即动作 / 强制动作
2. 应对成功产生的顺序修正
3. 主动换人优先层
4. 技能先手等级
5. 速度
6. 同速 tie-break
```

置信度拆开：

| 规则 | 置信 |
|---|---|
| “先手 +N”真实存在 | COMMUNITY_CURRENT |
| 应对会影响行动/效果 | COMMUNITY_CURRENT |
| 主动换人是独立动作 | CROSS_SOURCE_SUPPORTED |
| 严格 `应对 > 换人 > 先手 > 速度` | ENGINE_HYPOTHESIS，需录像 microcase |
| 完全同优先级同速裁决 | UNKNOWN |

当前 repo 的 seeded random 只能标 deterministic `ENGINE_HYPOTHESIS`，不能写成游戏事实。

## 6. 应对系统

至少支持：

```text
防御 应对 攻击
攻击 应对 状态
状态 应对 防御
```

“应对成功”不能只做 `priority += 100`，它可能改变本次威力、减伤、buff/debuff、能耗、离场和额外触发。

```ts
type RespondResult = {
  matched: boolean
  relation?: "attack_vs_status" | "status_vs_defense" | "defense_vs_attack"
  priority_delta?: number
  injected_effects: Effect[]
}
```

## 7. 换宠

必须区分：

```text
ACTIVE_SWITCH
FORCED_SWITCH
SKILL_LEAVE
FAINT_REPLACEMENT
AUTO_REPLACE
```

现行特性说明明确：“离场”包含主动更换或脱离效果，不包括力竭后下场。这证明不能用一个无语义的 `switch()` 吞掉所有情况。

推荐：

```text
ACTIVE_SWITCH
→ BEFORE_LEAVE
→ LEAVE
→ select target
→ ENTER
→ ON_ENTER
→ SWIFT_CHECK
→ injected swift action
→ continue
```

## 8. 迅捷

当前 BWIKI 对迅捷的说明可作为 `COMMUNITY_CURRENT`：通过主动更换精灵入场时，使用第一个能量满足要求并带有迅捷的技能。进入 current ruleset 前仍需录制 microcase。

因此：

- 技能槽是 ordered list；
- “第一个”是规则语义；
- 换宠不一定等于什么都不打；
- 迅捷是 injected action，不是第二次玩家输入。

```ts
trigger_swift(on_active_switch):
  for skill in ordered_skill_slots:
    if skill.has_tag("swift") and can_pay(skill):
      inject(skill)
      break
```

待验证：多重迅捷、0 能技能、技能变化后的 slot 顺序、特性赋予迅捷、力竭补位是否触发。

## 9. 传动 / 技能位置

技能必须：

```ts
skills: [slot1, slot2, slot3, slot4]
```

当前技能文本已出现：位于 1/3 号位改变威力、传动 1、两侧技能、跨精灵移动技能。因此技能顺序本身是 Build。

## 10. 印记

社区当前资料支持：

```text
精灵下场后印记不消失
新入场继承
最多 1 正 + 1 负
```

所以优先：

```python
side.positive_mark
side.negative_mark
```

具名印记再由 effect registry 结算。

## 11. 天气

Weather 是 global state：

```ts
type WeatherState = {
  weather_id: string
  remaining_turns?: number
  source_event_id: string
}
```

不要挂在发动者身上。

## 12. 回合末

需要允许：

```text
END_TURN
  → status effects
  → traits
  → team effects
  → weather duration
  → energy effects
  → auto switch
```

但多个 END_TURN hook 的严格先后暂时不要硬宣称。用稳定 registry：

```ts
HookPriority = { phase, priority, source_kind, stable_tie_key }
```

通过真实 microcase 逐项钉顺序。

## 13. 属性克制

当前 BWIKI 条目可以直接看到 ×2、×0.5、×3、×0.25，先作为 `COMMUNITY_CURRENT`。不要照搬宝可梦“双弱 ×4”，也不要在完整属性矩阵尚未核对时机械相乘。

```json
{
  "ruleset": "S4-2026-09",
  "multipliers": {
    "weak": 2.0,
    "resist": 0.5,
    "double_weak": 3.0,
    "double_resist": 0.25
  }
}
```

仍应通过实际 type matrix 计算，而不是看到双属性就机械相乘。

## 14. 特性

当前公开特性图鉴有 242 个公开特性，关联 621 个精灵形态。特性可能触发于入场、离场、造成克制伤害、被攻击、回合结束、聚能、更换精灵、生命阈值、技能系别、技能能耗、队伍组成。

因此 Trait 与 Skill 共用同一个 Effect/Trigger DSL，而不是另写一套大 if-else。

## 15. 魔力、胜负与模式

胜利条件参数化：

```ts
BattleMode {
  team_size
  magic_points
  active_slots
  items_allowed
  resonance_allowed
  hidden_roster_policy
  trait_sharing?: boolean
}
```

当前证据必须分开：

- 官方「极速对决」明确是活动型 3v3、每方 2 点魔力，不代表标准闪耀大赛；
- 官方更新文字确认 PVP 随机精灵最多可携带 6 只；
- 多源社区拆解和现有模拟器交叉支持：标准 PVP 双方编入 6 只，通常一只力竭扣 1 点魔力，降至 0 判负，常见初始值为 4；这仍是 `CROSS_SOURCE_SUPPORTED`，必须用实机录像补成 `RECORDED_IN_GAME`；
- 匹配前阵容未知；进入对局后有资料显示可见对方六宠，但技能、配招和策略仍不完全可见。该可见性也要录制 microcase。

官方活动还出现 2v2 和特性共享，因此不能把 3v3/六宠/胜利条件写死。标准 PVP 候选模式与活动模式必须是不同 `BattleMode`。

## 16. 当前必须新增的真实规则 microcases

```text
R-ENERGY-01 常规能量上限
R-ENERGY-02 开局/首次入场能量
R-ENERGY-03 聚能回复量
R-ENERGY-04 是否存在自然回合末回能
R-ORDER-01 换人 vs 普通技能
R-ORDER-02 换人 vs +1 先手
R-ORDER-03 应对 vs 换人
R-ORDER-04 同速
R-SWIFT-01 主动换入迅捷
R-SWIFT-02 力竭补位是否触发迅捷
R-END-01 DOT / 特性 / 回能先后
R-FAINT-01 先手击杀后后手动作是否取消
R-MARK-01 换人后印记继承
R-MARK-02 印记替换
R-MAGIC-01 共鸣魔法与主行动关系
```

这些比再加 100 只宠重要。

## 17. 严禁快捷修法

禁止：

```text
攻略说上限10 → 把6改10 → 全测试改10 → Done
```

正确顺序：

```text
来源登记
→ 新 microcase
→ 规则层改动
→ 行动合法性
→ roster/filter 重建
→ simulator replay
→ trajectories invalidation
→ model/eval rebuild
→ UI/Coach thresholds
→ release guard
```
