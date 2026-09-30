# 回归集变更说明｜task-25「获得 属性±N」读点与解析形状（2026-09-29/30）

- **产物**：`reports/roco/rc404/regression-set.json`
- **指纹**：`3586b5992d40c5bf…`（改前，工作区版本）→ `fc637a208e10b7f2…`（改后）
- **重建命令**（产物由 `roco_env.regression` 写，**不是手改**）：
  ```
  cd roco && PYTHONPATH=src python3 -m roco_env.regression --out ../reports/roco/rc404/regression-set.json
  ```
- **复跑比对**：`cd roco && PYTHONPATH=src python3 -m roco_env.regression --check`（绿）

## 变了几个场景：**29 个里 1 个**

判据：重建**之前**的磁盘版本与"同代码重跑"逐条比对，`test_regression_set` 报出的过期项
只有 `['type-sweep-毒系']` ⇒ **本批只动了这一个**。

⚠ 与 `git HEAD` 版本相比另外还有 3 个场景（`speed-order` · `type-sweep-翼系` · `type-sweep-虫系`）
也不同 —— 那**不是本批造成的**：从它们用到的招可以逐条对上别批的改动
（`skill_000750 诡刺` 的纯伤害先手 = task-23 速度投影；`skill_000686 啄击`「2连击」/
`skill_000632 啃咬`「1连击」= task-20 批二的连击认领）。本批的 `stat_gain.*` 形状在这三个场景的
`used_skills` 里**一条都不出现**。

## `type-sweep-毒系` 逐值对照（`skill_000624 腐化`）

```
用到的招：skill_000286 · skill_000418 · skill_000612 · skill_000619 · skill_000624
事件计数：
  action_cancelled                 1 → 2
  debuff_foe                      16 → （0，键消失）
  defense                          2 → 3
  effects_registered_unsupported   2 → 3
  energy_gain                  （0）→ 1
  faint                            1 → 2
  mana_loss                        1 → 2
  replacement                      1 → 2
  status_applied                   8 → （0，键消失）
  status_tick                     11 → 6
  status_unsupported           （0）→ 4
  turn_start                      11 → 10
```

### 为什么变：**这一条是修掉"把没结算的说成已结算"**

`skill_000624 腐化`的描述是：

> **敌方每有1层中毒效果**，敌方获得双攻-30%。

旧路径把它读成**无条件**的 `foe_stat`（`_FOE_STAT` 是**无条件**正则，只认形状不认条件）
⇒ 每一手都白扣对手 30% 双攻，**跟对手有没有中毒层数无关** —— `debuff_foe` 那 16 次就是这么来的。
那不是"少实现了一个机制"，是**算错了一个数**（人类红线：不许把未结算说成已结算；
静默错算比不结算更糟）。

本批给「获得 属性±N」加了**条件句闸**：命中所在的整句里、命中之前出现
「若 / 选择 / 应对 / 期间 / 每 / 或 / 时 / 后 / 前 / 当」就**不认领**（如实报未结算）。
于是 `skill_000624` 的效果不再产出 ⇒

- `debuff_foe` 16 → 0（不再白扣）✓ **这是本批要的**
- 那一手的附带效果归零 ⇒ 该场景后续回合的轨迹整体位移（`status_applied` / `status_tick` /
  `faint` / `replacement` / `mana_loss` 等随之变）—— 这些是**同一处改动的级联**，不是各自独立的第二处改动
- `status_unsupported` 0 → 4：这一段本身**如实登记为未实现**（fail closed），
  而它的判据（`mechanics.resolved`）本来就是 `false` ✓ 两边不再打架

### 反证（必红方向）

把 `parse.resolve_stat_gain_extended` 的**回收那一段**去掉（或让 `stat_gain_extended` 不声明），
`type-sweep-毒系` 的 `debuff_foe` 立刻回到 16 —— 也就是"无条件白扣"回来。
另外 `roco/tests/test_effect_coverage.py` 的
`test_report_has_no_simulatable_with_unclaimed_mechanic_spans` 会直接把
`skill_000528 砂石冲撞` 这类"条件被无条件认领"的技能打成红。

## 前后两个数（口径一致，供核对）

| 读数 | 改前 | 改后 |
| --- | --- | --- |
| 29 个场景的 `state_digest` 变化数 | — | **1**（`type-sweep-毒系`） |
| `build_coverage` 可模拟实体总数 | 307 | **317** |
| 427 条并集的 `resolved_true`（`pets100_census.py`） | 215 | **224** |
| `roco/tests` 全量 | 709 OK (1 skipped) | **723 OK (1 skipped)** |
| `build-rule-configs.mjs --check` | 绿 | **绿** |
