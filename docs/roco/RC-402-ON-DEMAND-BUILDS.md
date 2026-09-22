# RC-402 按需配招编译（Build Compiler）

> 产物：`data/roco/derived/on-demand-builds.json`（1.4 MB，622 只）
> 构建：`node scripts/roco/build-on-demand-builds.mjs`（`--check` 逐字节复核、`--selftest` 9 条必红反例）
> 检查：`node scripts/roco/verify-on-demand-builds.mjs`
> 守卫：`tests/roco-on-demand-builds.test.js`（9 条）+ `roco/tests/test_on_demand_builds.py`（8 条）
> 报告：`reports/roco/rc402/on-demand-builds.json`

## 它解决的是什么

RC-203 只给「冻结 `learnsets.json` 里真的有 `native_skills`」的精灵编配招：全量 622 只里
**只有 48 只**过得了那一关，另外 **574 只**在引擎的 `is_learnable()` 那里「学不到任何技能」——
**选得到、上不了场**。

而数据其实一直在：全量图鉴 `full-catalog.json` 每只都带 `learnable_skills`（实测 **622/622**，
共 **8787 条引用，全部**能在冻结 `skills.json` 里解析）。所以这不是数据缺失，是**没人把它编成配招**。

## 三条纪律（与 RC-203 同一套，理由不同）

| # | 纪律 | 机器判据 |
|---|---|---|
| ① | **不许发明技能**：每个技能必须同时「在该物种的 `learnable_skills` 里」且「能在 `skills.json` 解析」 | `skill_not_in_pool` / `skill_unresolved` / `skill_is_trait` |
| ② | **不许冒充已核验**：冻结那 48 只标 `FULL_VERIFIED` 且带 `frozen_build` 供对账；推算的一律 `SIMULATABLE_UNVERIFIED` 且 `frozen_build=null` | `support_level` / `frozen_missing` / `unverified_with_frozen` |
| ③ | **不许声称最优**：选择规则是一条工程启发式，逐只带出 `selection_rule_id` 与 `unknowns[]` | `selection_rule_confidence` |

**覆盖账目**：622 = 48 已核验 + 574 按需推算，跳过 0；同一只**不许**既编出来又登记跳过
（`coverage_overlap`）。

## 选择规则（ENGINE_HYPOTHESIS，不是游戏规则）

```
威力降序（来源没给威力的排最后，绝不补 0） → 能耗升序 → skill_id 升序，取前 4 个不同的技能
```

实测：这条规则**不复现**冻结那一份（`compiled_matches_frozen = 0`）——所以两者更不能互相替换，
这也正是要把等级分开的原因。仓库里没有任何「标准 PVP 该怎么配招」的证据（台账没有条目）。

## 引擎侧怎么消费（`data.py` 的叠加）

`load_ruleset()` 在正常合并之后**追加**一层：对每个 `SIMULATABLE_UNVERIFIED` 的物种
（**只补冻结覆盖不到的**）：

- 用产物里的 `stats`（静态种族值，带 `pointer`）、`feature_skill_id`、`types` 建 `Pet`；
- 用 `learnable_pool` 建 `Learnset`（可学池 = 该物种全部可解析的战斗技能），
  用挑出来的四个建 `candidate_moveset`；
- 记 `build_support[pid] = SIMULATABLE_UNVERIFIED`。

已经存在的物种**一个字节都不动**（`pid in pets` 直接跳过），冻结配招与冻结学会表逐位不变。
`Ruleset.build_support_of(pid)` 是唯一的读法；`/api/roco/roster` 的默认名单仍是**已核验 48 只**
（练习局/迁移夹具口径，逐位不变），`?support=all` 才返回全量 622（配队与检索口径）——
**这不是白名单**：引擎两种都收，只是名单的默认视野保持在已核验那一档。
每只的 `evidence_ids` 也按档走：冻结的指 `pets.json#…`，推算的指 `on-demand-builds.json#…`
（写到冻结文件里就是**编出处**）。

## 顺带修掉的停滞（本轮实测）

RC-105 给引擎加了 `ACTION_CHARGE`（聚能），但对手策略 `greedy_damage` 把它归进了「换人」那一支：
`_switch_target()` 对聚能返回 `None` → 得分 0 → **一旦当前能量付不起任何技能，双方就无限换人**。
实测：200 回合、无人力竭、魔力一直 4/4 —— 六宠标准 PVP 打不完（而这恰好只在按需推算的队伍上
暴露：冻结那 48 只的规范配招便宜得多）。

修法：给聚能**自己的分支**（11 分），并在有聚能可选时把换人的上限压到 9 分
（换人不推进局面，聚能至少换来下回合的一次输出；没有聚能的 legacy/v2 保持原上限，逐位不变）。
修完实测：图鉴队与 RC-106 队都在 **26 回合**打到魔力归零。

## 实测数字

| 项 | 值 |
|---|---|
| 图鉴精灵 | 622（48 已核验 + 574 按需推算，跳过 0） |
| 技能槽位 | 2488（622 × 4），其中「来源没给威力」1 个（照实写 `null`） |
| 可学池大小 | 8 ～ 21（最小的两只仍有 8 个技能可选） |
| 六宠对局（图鉴队，seed 11/12/13） | 26 / 26 / 26 回合，终局魔力 0:1 / 1:0 / 0:1 —— **全部打到归零判负** |
| Python 测试 | **371 条 OK**（新增 8 条 RC-402 判据） |

## 如实边界

- 「这份学招表是不是该物种**全部**可学技能（有无等级/道具前置）」仓库里没有证据 —— 逐只写进 `unknowns`。
- 按需推算的配招**没有**实机核验；页面、报告与训练数据生成器都必须按 `build_support` 分档，
  不得把两者混成一句「引擎支持的精灵」。
- 静态种族值来自全量图鉴登记值；等级/性格换算公式仍未校准（与 RC-203 同一条边界）。
- 选择规则只保证「确定、可复核、可替换」，不保证好用 —— 它是一条**起点**，不是结论。
