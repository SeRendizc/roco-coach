# 版本化规则配置（RC-101）

> 一句话：**能量上限 / 回合末回能 / 入场初始能量只有一个事实源 —— `data/roco/rulesets/*.json`。**
> 默认是 `legacy_sim_v1`（与当前引擎逐位相同）；`mobile_s4_candidate_v2` 是**候选规则**，
> **未被实机 microcase 支持前不得作为默认。**

## 1. 怎么选配置

| 场景 | 做法 |
| --- | --- |
| 默认（所有既有测试、replay、产物） | 什么都不用做 —— 生效的是 `legacy_sim_v1` |
| 想试候选规则（探索/对照） | `ROCO_RULE_CONFIG=mobile_s4_candidate_v2` |
| 单次调用指定（Python） | `renv.reset(team, enemy, config="mobile_s4_candidate_v2")` |
| 单次调用指定（回放） | 记录里带 `ruleset_config_id`，`replay()` 自动绑它；也可显式 `config=` |
| 校验两份配置还对不对 | `node scripts/roco/build-rule-configs.mjs --check` |
| 看切换影响 | `node scripts/roco/report-rc101-rule-config.mjs` → `reports/roco/flagship-upgrade/rc-101-rule-config.json` |

写错 id **不会**悄悄退回 legacy：`ROCO_RULE_CONFIG=xxx` 指向不存在的配置时直接抛
`RuleConfigError`（见 `roco/src/roco_env/rule_config.py`）。一次误配置必须表现成一次失败，
而不是一次「看起来成功了」。

## 2. 两份配置分别是什么

### `legacy_sim_v1`（默认，`status: LEGACY_BASELINE_BIT_EXACT`）

当前引擎行为的逐位快照。它的存在意义**只有**一个：让默认路径一个比特都不变，
于是所有既有 replay / 夹具 / 训练产物继续成立。

| 字段 | 值 | confidence | evidence_id | 角色 |
| --- | --- | --- | --- | --- |
| `energy.max` | `6` | `ENGINE_HYPOTHESIS` | `EV-ENERGY-MAX` | **refutes**（台账那条讲的是「打算按 10 施工」，不可能给 6 背书） |
| `energy.regen.per_turn` | `1` | `ENGINE_HYPOTHESIS` | `EV-ENERGY-ENDTURN-REGEN` | refutes（台账判「被多源反驳」） |
| `energy.initial` | `2` | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-INITIAL` | refutes（台账说「只当占位值，需 MC-E04」） |
| `energy.charge` | `null` | `ENGINE_HYPOTHESIS` | —（无引用） | 引擎没有「聚能」这个动作；`null` = 不适用，不是「聚能 = 0」 |
| `turn_order.end_turn.order` | `["status_tick","regen"]` | `ENGINE_HYPOTHESIS` | —（无引用） | 台账没登记组内顺序，所以**不借**别的条目凑引用（RC-103 起还多了 `action_order` / `speed_tie` / `unknown_stages_allowed`，见 `docs/roco/TURN-ORDER.md`） |
| `battle_mode.id` | `demo-training-3v3` | — | — | 迁移夹具，**不得**作为标准 PVP 的实现依据 |

### `mobile_s4_candidate_v2`（候选，`status: CANDIDATE_NOT_FOR_DEFAULT`）

| 字段 | 值 | confidence | evidence_id | 角色 | value_status |
| --- | --- | --- | --- | --- | --- |
| `energy.max` | `10` | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-MAX` | supports | `CANDIDATE_HYPOTHESIS`（MC-E01 未录） |
| `energy.regen.per_turn` | `0` | `ENGINE_HYPOTHESIS` | `EV-ENERGY-ENDTURN-REGEN` | supports | `CANDIDATE_HYPOTHESIS`（MC-E03 未录） |
| `energy.initial` | **`null`** | `UNKNOWN` | —（无引用） | — | **unknown**：不填一个看起来合理的数 |
| `energy.charge` | `5` | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-CHARGE` | supports | `CANDIDATE_HYPOTHESIS`（MC-E02 未录） |
| `turn_order.action_order` | `["respond","switch","priority","speed"]` | `ENGINE_HYPOTHESIS` | `EV-TURN-ORDER-STRICT` | supports | 社区口径，**不是**严格总序（RC-103 从 `end_turn.known_order` 改名并提到 `turn_order` 下） |
| `turn_order.speed_tie` | **`null`** | `UNKNOWN` | —（无引用） | — | 同速平手判据 UNKNOWN（引擎会抛错，不用随机数假装知道规则，见 `docs/roco/TURN-ORDER.md`） |
| `battle_mode.id` | `pvp-standard-six-pet` | — | — | — | 登记表里是 `CANDIDATE` |

关键差别（`reports/roco/flagship-upgrade/rc-101-rule-config.json` 的 `field_diff` 就是它）：

```text
energy.max               6 → 10        （CROSS_SOURCE_SUPPORTED，MC-E01 待录）
energy.regen.per_turn    1 → 0         （ENGINE_HYPOTHESIS，MC-E03 待录）
energy.initial           2 → unknown   （UNKNOWN，MC-E04 待录）
energy.charge       (不适用) → 5        （CROSS_SOURCE_SUPPORTED，MC-E02 待录）
```

### 候选值从哪来

全部来自证据台账 `data/roco/evidence/rule-evidence-ledger.json`，而台账的每条结论又
逐字来自 `/tmp/roco-coach-handoff-revised-2026-09-21/10-SOURCES-AND-CONFIDENCE.md`
（§7 能量、§8 时序、§12.1 BattleMode）。配置里的 `derived_from_ledger_sha256`
就是台账文件的 sha256：**台账一改，`build-rule-configs.mjs --check` 立刻红**，
逼着人重新生成配置，而不是让两份文件各自漂。

置信等级本身就带门槛（台账 `confidence_levels`）：

```text
OFFICIAL_CURRENT / RECORDED_IN_GAME  → 可以直接成为 current 规则
COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED → 只能进 candidate ruleset
ENGINE_HYPOTHESIS → 只能是有界占位（必须带 reason）
UNKNOWN → 不得施工
```

本阶段没有任何 `RECORDED_IN_GAME` 证据，所以配置文件里**一个字段都没有**达到
可 promotion 的等级 —— 这条由 `tests/roco-rule-config.test.js` 钉住。

## 3. 哪些值是 unknown

| 字段 | 为什么 unknown | 待录 case |
| --- | --- | --- |
| `energy.initial`（candidate） | 10 号文档 §7：「首次入场具体能量：需实机/更强一手证据」 | `MC-E04` |
| `turn_order.speed_tie`（candidate） | 10 号文档 §8：「speed tie = UNKNOWN」 | `MC-E05` |
| `energy.charge.breaks_cap`（candidate，未建模） | 聚能是否可突破上限、无合法技能时是否自动聚能——台账明说未定 | `MC-E02` |
| `turn_order.end_turn.order` | 台账没有登记组内顺序；候选沿用 legacy 的占位只是「有界」 | `MC-E03` |

`energy.initial` 是 unknown 时，**引擎 fail closed**：

```text
RuleConfigError → fx.UnsupportedEffect：规则配置 mobile_s4_candidate_v2 的 energy.initial 是 UNKNOWN
（首次入场能量需实机（MC-E04）；待录 microcase MC-E04）—— 不许用 legacy 的值代替
```

也就是说：切到 candidate 之后 `reset()` 会抛错，直到 `MC-E04` 录到入场读数。
这是**故意**的 —— 一个「看起来合理的 2」会让 candidate 看起来已经被验证过。

## 4. 切换后必须重跑哪些产物

**不要手抄这份清单**：它是算出来的，见
`reports/roco/flagship-upgrade/rc-101-rule-config.json` 的 `switched_to_candidate` 一节，
生成器是 `scripts/roco/report-rc101-rule-config.mjs`；失效逻辑直接复用
`scripts/roco/artifact-invalidation.mjs` 的 `invalidate()`（不另写一份）。

切到 `mobile_s4_candidate_v2` 触到的规则主题（截至本次 RC-101）：

```text
energy.charge, energy.initial, energy.max, energy.regen, turn_order.priority
→ 受影响产物 18 条，其中 13 条属于「绑定旧规则的产物，禁止重跑」
```

那 13 条**禁止重跑**（人类指令：规则 candidate 落定前不许再生产绑定旧规则的产物）：

```text
playable-48-layer            traj-rule-arm-v1          traj-model-arm-v1
model-error-trajectories-v4  sft-dataset               team-model-g02
intervention-windows-roco    intervention-model-generated
planner-benchmarks           position-fixtures          browser-position-matrix
pet-support-matrix-doc       roster-48-doc
```

`do_not_regenerate[].why` 里写着同一条理由：**现在重跑只会再生产一批绑定旧规则的东西。**

## 5. 明确一句话

> **`mobile_s4_candidate_v2` 未被实机 microcase 支持前，不得作为默认规则配置。**

机器判据（不是口号）：

* `legacy_sim_v1` 必须是唯 `is_default: true` 的那一份（Node + Python 两侧都断言）；
* 引用「待实机验证」台账条目的字段，带具体值时必须标 `value_status: CANDIDATE_HYPOTHESIS`，
  且必须带 `microcase_id`；`UNKNOWN` 字段只能是 `null` / `"unknown"` 并带 reason；
* 本阶段任何字段都不得是 `OFFICIAL_CURRENT` / `RECORDED_IN_GAME`。

## 6. 这一版**没有**做的（已知缺口）

| 缺口 | 影响 | 谁来补 |
| --- | --- | --- |
| `src/client/roco.js` 的界面文案「6 能量上限」 | 切到 candidate 后页面文案会与引擎不符 | **主线程**（本次不改 UI） |
| `src/server/index.js` 系统提示词「能量上限6，5豆不是满豆」 | 同上，会让模型说错上限 | 主线程 |
| 服务端公开视图没有下发 `energy_max` | `src/coach/coach-advice.js` 的「对面能量快满了」在**读不到上限时保持沉默**（已改成从 `opponent.energy_max` 读，读不到就不猜） | 主线程：在 `src/server/roco-service.js` 的 `publicView()` 里补 `energy_max`（Python 侧 `roco_env.rule_config.summarize()` 已经能给出这个值） |
| 「聚能」不是引擎动作 | candidate 的 `energy.charge = 5` 只是登记，引擎还没有这个行动 | RC-1xx（另开任务） |
| 只读配置，没有真正的规则分支 | 切到 candidate 目前只会改「上限夹取 / 回能 / 入场值」这三处；时序、BattleMode、魔力系统仍是 legacy 结构 | 后续 RC 任务 |

## 7. 相关文件

```text
data/roco/rulesets/legacy-sim-v1.json          默认规则配置（逐位基线）
data/roco/rulesets/mobile-s4-candidate-v2.json 候选规则配置
data/roco/evidence/rule-evidence-ledger.json   证据台账（只读；本目录之外的文件）
roco/src/roco_env/rule_config.py               加载 + 校验（fail closed）
roco/src/roco_env/env.py                       引擎：能量三件套全部从配置取
scripts/roco/build-rule-configs.mjs            两个配置的唯一写入方（--check / --selftest）
scripts/roco/report-rc101-rule-config.mjs      RC-101 影响报告（--selftest）
scripts/roco/ruleset-energy.mjs                Node 脚本的只读访问口
tests/roco-rule-config.test.js                 配置合法性（Node）
tests/evals/structure-contract.test.js         「字面量只许住在配置里」的结构判据
roco/tests/test_rule_config.py                 Python 侧（默认不变 / candidate 上限 / fail closed）
reports/roco/flagship-upgrade/rc-101-rule-config.json  影响报告（生成物）
```
