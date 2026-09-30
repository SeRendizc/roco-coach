# 03b 动作级情景导出（`rc604-opponent-action-scenarios/v1`）

**执行**：`plan03-belief` · **任务**：task-34（Lead 裁决 D-33）· **起点**：`63a6bd7` 之后的 03 写域
**写域**：`src/coach/opponent-belief.mjs` · `tests/roco-opponent-belief.test.js` · `reports/roco/product-execution/03/`
**不动**：`buildScenarioOutlook()` 的现有语义与判据（03.4 交付，已冻结）。

---

## 1 · 命令 + 退出码 + 读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `node --test tests/roco-opponent-belief.test.js` | **0** | **40 ✔ / 0 ✖**（新增 03b-A / 03b-B / 03b-M 三条） |
| `RC604_WRITE_REPORT=1 …` + 复跑 | **0** | 报告由生成器重写后仍 **40/40** |
| 实现变异（删掉换人分支 ⇒ 塌缩成只剩留场） | **1** | 37 pass / **3 fail**：`03b-A…`、`03b-M…`、`RC-604 报告…`；读数 `counts.switch=0`（还原后 40/40） |

原始留档：`raw-03b-tests.txt` · `raw-03b-mutation-collapse.txt`
sha256(16)：`src/coach/opponent-belief.mjs` = **39d3a9e5a4a7512b**（243993 B）·
`tests/roco-opponent-belief.test.js` = **6c8546ce32804953**（137380 B）·
`reports/roco/rc604/opponent-belief.json` = **d110368f4fe80dd8**（248043 B）

---

## 2 · 真 view 实测输出（`raw-03.3-view-pvp.json` + 冻结技能池）

```
counts = {stay: 4, switch: 5, observed: 7, hypothesis: 2}
sources = {stay_available: true, switch_available: true, pool_candidates: 2}
scenarios（节选）:
  stay:attack:pet_000007:skill_000340   stay_attack   observed   slots=[0]  skill_ids=1
  stay:defense:pet_000007:skill_000286  stay_defense  observed   slots=[0]  skill_ids=1
  stay:pool:pet_000239                  stay_attack   learnable_pool_hypothesis  slots=[]  skill_ids=4
  switch:pet_000008:slot1 … switch:pet_000012:slot5   switch_in_seen  observed  slots=[1..5]
```
- 已出技能（观察）：`skill_000286 防御`、`skill_000340 仙人掌刺击` ⇒ 分别落 `stay_defense` / `stay_attack`，都带 `evidence_id`；
- 换人情景 5 条：位次全部来自 `view.seen_roster[].slot`，**排除场上那只**（slot 0）与倒下位次；
- 可学池情景 2 条：`evidence_basis:'learnable_pool_hypothesis'`、`slots: []`（位次不可判定 ⇒ 不猜）。

## 3 · `unavailable[]` 逐条原因

| what | 原因 |
|---|---|
| `inferred_candidate_slots` | 未亮明的后备在公开面上只有 `{slot, fainted}`、**没有 pet_id** ⇒ 推断候选的位次不可判定 |
| `opponent_will_switch` | 公开面没有任何「他要换」的证据：换人只是**可能**（两类动作必须并存） |
| `bench_hp_and_moveset` | **P3 残留**：后备按满血 + 规范配招假设建模（引擎 `state_from_planner`），不是观察 |
| `unrevealed_skills_as_actions` | 未出过的技能只有可学池语义 ⇒ 标假设，不当观察、不落位次 |
| `range_or_weight_as_probability` | 03.4 的区间/权重是基线表达（`is_probability:false`）⇒ 不许转成动作概率 |
| `used_skill_of_non_active:*` | 出过招但当前不在场的那只：不许替引擎假定它已上场 |

**「可学池选中标记而不是丢弃」的理由**：04.3 要在「对手可能出什么」上展开分支，可学池是**合法的假设空间**；
按 03.4 的先例（宁可声明语义、不要静默丢），标 `learnable_pool_hypothesis` + `slots: []` 比直接进
`unavailable[]` 更有用，而且 `POOL_AS_OBSERVED` 判据钉住了「不许当观察」这条底线。

## 4 · 判据与变异（两向）

| 判据 | 内容 | 变异 |
|---|---|---|
| `03b-A` | 两类动作**并存**（`stay>0 && switch>0`）、`observed` 情景必带 `evidence_ids`、换人位次 ∈ `seen_roster` 且 ≠ 场上位次、池情景 `slots=[]`、`unavailable` 四类必在 | 删换人分支 ⇒ **红**（`counts.switch=0`） |
| `03b-B` | 隐藏真值变化（种 `_truth` / `hidden_individual`）⇒ `scenarios[]` **逐字段相同** | —— |
| `03b-M` | 克隆变异五条必红：塌缩 / 池冒充观察 `POOL_AS_OBSERVED` / 无证据 `ACTION_SCENARIO_UNTRACEABLE` / 换人无位次 `ACTION_SCENARIO_SHAPE` / 声明成概率；**反向控制**：没有换人证据时不许误报塌缩 | 见上 |

⚠ 诚实说明：`ACTION_SCENARIOS_COLLAPSED` 判据只覆盖「`sources` 声称两类可用但 `counts` 缺一类」；
**「公开面有换人证据、产出却一条都没有」这一情形由 `03b-A` 的独立期望抓住**（期望从 `view.seen_roster` 现算，
不读模块自己的 `sources`）—— 因为实现变异后 `sources` 会自恰地变成 `false`，只靠文档内判据是抓不到的。
