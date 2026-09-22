# RC-404 代表性回归集

> 模块：`roco/src/roco_env/regression.py`（`python3 -m roco_env.regression [--check]`）
> 指纹表：`reports/roco/rc404/regression-set.json`
> 守卫：`roco/tests/test_regression_set.py`（8 条，含 3 条必红方向）

## 为什么需要它

镜像对局（`greedy_damage` vs `greedy_damage`）只能压出 14 种事件，**印记、天气、应对、持续状态
根本不会出现**（实测）。所以「引擎支持这些机制」这句话在回归集之前是**没有证据**的。

本集用**脚本化**对局逐条驱动机制，每个场景声明它**期望看到的证据**；跑完没出现就是**空转**，
如实报出来（第一版跑出 5 条空转，正好证明这条判据不是摆设）。

## 场景表（9 条 / 9 个维度）

| 场景 | 维度 | 关键证据 |
|---|---|---|
| `damage-type-advantage` | 属性/伤害 | damage 30 / faint 6 / replacement 5 |
| `defense-branch` | 防御 | defense 7（按**技能类别**选招，不是按 desc 里的词） |
| `energy-and-charge` | 资源（能量/聚能） | charge 16（注：v3 的回合末回能是 **0**，所以这条**不**期望 `energy_regen`） |
| `faint-and-mana` | 力竭/魔力 | faint 7 / mana_loss 7 / game_end 1 |
| `replacement` | 换入离场 | replacement 6 |
| `mark` | 印记 | **`mark_added` 1**（自动找一条**真的会加印记**的技能当首发） |
| `weather` | 天气 | **登记为不可达**：没有任何精灵的**规范配招**带 `weather` 效果（学得到 ≠ 带得上场） |
| `status` | 持续状态 | **`status_added` 1 / `status_tick` 10** |
| `legacy-practice-3v3` | 迁移夹具 | legacy 3v3 场景也在集里（`energy_regen` 34 —— 那是 legacy 的回合末回能） |

## 两条判据（都在代码里，不靠自觉）

1. **空转不算通过**：`expect_kinds` 逐条核对；声明了「找一条带某机制的精灵」时，
   那条技能必须**真的用出来过**（`used_skills`）。
   —— 自动选首发按**解析出的效果类型**找（不是按 desc 里的词）：实测按词会先命中
   「驱散敌方所有印记」（翅刃），那是**反着**的机制，场景会空转；能耗低的优先，
   否则一条 8 能耗的技能在 25 回合里可能一次都放不出来。
2. **不可达要如实登记**：数据里没有可驱动的精灵 ⇒ 进 `unreachable` 并写明原因，
   与「没出现在报告里」区分开。

## 指纹与 `--check`

每条场景记 `state_digest`（终局序列化摘要）+ `event_kinds`（分布）+ `key_events`。
`--check` 与磁盘上的指纹表比对：**引擎一改这里就会红**，那正是它的用途。
反证：篡改摘要 / 篡改事件分布 / 删掉一个场景，`check_against()` 都必须报出来。

## 实测

`test:env` 397 → **405 条 OK**（新增 8 条）；`--check` 与磁盘指纹一致；门禁 **17/17**。

## 如实边界

- 场景只覆盖**能驱动得了**的机制；驱动不了的（如天气）登记为不可达，而不是当作通过。
- 指纹绑定当前引擎 + 规则配置：**引擎一改就应当红**——这是它的用途，不是障碍。
- 对局用固定选择器或引擎策略，**不代表**最优打法；它验的是「机制真的跑到了」。
- 集合规模还小（9 条）：18 属性只覆盖了一部分，角色/速度层次的场景待补。
