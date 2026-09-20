# F03 · 状态标签：已实现 / 模拟 / 待做

> 这套标签是给读者（评审、面试官、下一轮接手的自己）用的：**哪一块可以当真、哪一块只是能跑、哪一块干脆没有。**
> 全部依据来自我实际读过的代码与实际跑过的命令，逐行标「证据」。

---

## 1. 三个标签的精确定义

### ✅ 已实现（IMPLEMENTED）

**同时满足两条**：

1. 仓库里有能跑的实现代码；
2. 有一条**会红**的测试守着它 —— 破坏实现，测试必须失败。

第 2 条是关键：没有测试的代码不算「已实现」，只算「写过了」。
判定方式不是印象，而是「这条测试断言的是不是这个行为」。

**例证**：`roco/tests/test_microcases.py::TestMC001Priority::test_higher_priority_acts_first_even_when_slower`
断言「先手度高但速度慢的一方仍先动」。把 `env.order_actions()` 的排序键从
`(not respond, -priority, -speed, tie)` 改成 `(-speed, …)`，这条测试立刻红。

### 🟡 模拟（SIMULATED）

**定义**：引擎**真的算出了一个数**，但这个数建立在**未核验的假设**上 ——
机制本身没有一手证据，只是从社区实现或文本反推出来的候选。
输出必须带「未核验」标记，且**不得**被当作结论使用。

本仓库的标准范例就是伤害公式 `COMMUNITY_HYPOTHESIS_V1`：

```python
COMMUNITY_HYPOTHESIS_V1 = DamageModel(
    name="community-hypothesis-v1",
    verified=False,                     # ← 这就是「模拟」的机器可读标记
    source="ColinHong10/NRC_AI src/battle.py（社区实现）",
    license_note="…本公式仅作为**候选假设**，不是官方公式，未核验。",
    …
)
```

**证据**：`roco/src/roco_env/effects.py:86-99`。并且每一次伤害事件都带
`"damage_model": model.name, "formula_verified": model.verified`（`env.py:552-566`），
所以「这个数字来自未核验公式」在**事件流里可见**，不靠注释。
测试 `test_microcases.py::TestFailClosed::test_damage_model_is_marked_unverified` 钉住这一点。

**和「已实现」的区别**：模拟可以有测试 —— 但测试守的是「我们确实按这个假设算」，
不是「这个假设是对的」。二者的差别决定了能不能拿它下强度结论（不能）。

### ⛔ 待做（NOT DONE，fail closed）

**定义**：没有实现。遇到它时**必须明确拒绝**，不能退化成一个看起来合理的默认值。

三条落点，缺一不可：

| 落点 | 代码 | 证据 |
|---|---|---|
| 抛结构化异常，不返回默认数 | `raise UnsupportedEffect(...)` —「没有实现的效果原语一律抛 `UnsupportedEffect`，**绝不**返回一个默认数值」 | `effects.py:16,28-39,153-159` |
| 记进对局事件流，让上层能看见 | `_note_unsupported(state, what, detail, evidence)` → `state.unsupported`，并产生 `kind="unsupported"` 事件（页面渲染成「未核验、因此未结算：…」） | `env.py:330-334`；`src/client/roco.js:137` |
| 接口层给可区分错误码 | `unsupported_effect` / `not_implemented` → `failure_class: "unsupported"`；`coverage: 0` | `roco-client.js:53-54,79-80,246-267` |

**两条纪律**（来自 `docs/roco/MICROCASE-PLAN.md` §5，已在代码里落实）：

- 禁止「默认 40 威力普通攻击」这类自创默认值；
- 没有静态威力 **≠ 0 伤害**：`effective_power()` 对 `power is None` 直接抛，而不是返回 0
  （`effects.py:153-159`；测试 `TestFailClosed::test_no_static_power_raises_instead_of_returning_zero`；
  数据侧由 `data-acceptance.test.js` 的「动态/条件威力不得被当成 0 伤害（power 缺失必须为 null 而非 0）」把守）。

---

## 2. 标签应用表（按功能，不是按模块）

### A. 数据与规则集

| # | 功能 | 标签 | 证据（文件 / 测试） |
|---:|---|---|---|
| A1 | Lua 归档 → normalized JSON 的导入（12 只精灵、824 技能、12 学习表、120 属性行、54 术语） | ✅ 已实现 | `data/roco/normalized/roco-world-s4-2026-09-10/import-report.json`；`scripts/roco/import-snapshot.mjs`；`tests/evals/roco/data-acceptance.test.js` **15/15 通过**（实跑 `npm run test:roco`），含「规范化精灵与原始 Lua 逐字段一致（独立重新解析对拍）」 |
| A2 | 来源台账 + 许可/再分发/商用标注 | ✅ 已实现 | `data/roco/sources.yaml`；`data-acceptance.test.js` 的「来源台账不得含页游数据，且未确认许可必须标 REFERENCE_ONLY」 |
| A3 | 交叉核验 + 冲突台账（26 条，未解决 0） | ✅ 已实现 | `reports/roco/m1-data/cross-check.log`；`data/roco/conflicts.jsonl`；`data-acceptance.test.js` 的「冲突台账每条都有处置结论；未解决项不得被降级隐藏」 |
| A4 | 规则集加载与一致性校验（只允许手游、12 只齐全、0 孤儿引用、指纹稳定） | ✅ 已实现 | `data.py:276-388` 的 `load_ruleset()`（`ruleset_id`/`game` 不符直接 `RulesetError`）；`test_microcases.py::TestRulesetLoading`（5 条） |
| A5 | 种族值 → 面板值换算 | 🟡 模拟 | `data.py:160-183` 的 `PANEL_FORMULAS`：hp/atk/def 在 452 条记录上**零误差**、spa/spd/spe **有残差**；注释原文「仍然**不是官方公式**——它是从社区数据反推的，可被官方数据推翻」。`panel_formula_is_exact()` 提供机器可读的精确性标记 |
| A6 | 属性相性（显式双属性行优先，缺行不猜） | ✅ 已实现 | `data.py:114-131` 的 `TypeChart.multiplier()` / `has_row()`；`tests/evals/roco/bridge.test.js` 的「双属性相性只用快照显式行（缺行时 unsupported，不相乘）」 |
| A7 | microcase 通过（21 条真实规则验证） | ⛔ 待做 | `tests/evals/roco/cases/microcases-v1.jsonl`：22 行 = 1 行 header + 21 条 case，**`passed` 计数 0**（实跑）；`docs/roco/MICROCASE-PLAN.md` 的 `status = PLAN_ONLY_NOT_EXECUTED` |

### B. 规则引擎机制

| # | 机制 | 标签 | 证据（文件 / 测试） |
|---:|---|---|---|
| B1 | 3v3 对局主循环 + 确定性回放（`reset`/`step_joint`/`serialize`/`replay`） | ✅ 已实现 | `env.py:84,336,803,817`；`test_microcases.py::TestDeterminism`（同 seed 同结果、不同 seed 都合法、序列化往返）与 `::TestInvariants`（随机对局不产生非法状态、结束局拒绝继续） |
| B2 | 先手度与出手顺序（术语 1020） | ✅ 已实现 | `env.py:238-260,288-323`；`test_microcases.py::TestMC001Priority`（3 条） |
| B3 | 应对机制：识别、必定先手、防御减伤、`应对攻击` 落冷却（术语 1015–1017） | ✅ 已实现 | `effects.py:289-331`；`env.py:474-495`；`test_microcases.py::TestMC020Respond`（4 条） |
| B4 | 隐藏信息边界（教练域不得携带对手待执行动作/真实 seed） | ✅ 已实现 | `roco-client.js:199-213,539-550,617-636`；`tests/evals/roco/plan-e2e.test.js`（8/8 通过，含三份隐藏键词表跨文件比对、请求数为 0 的反证、对照组） |
| B5 | fail closed 记账（未核验机制进 `state.unsupported` + 事件） | ✅ 已实现 | `env.py:330-334`；`test_microcases.py::TestFailClosed`（3 条，含「状态技能要么生效要么被登记」） |
| B6 | 对手策略池（5 种启发式） | ✅ 已实现 | `roco/src/roco_env/opponents.py`（`get_strategy`/`play_match`/`wrap_observation`）；`roco/tests/test_opponents.py`（**36** 条） |
| B7 | team 规则特征评估 / 换人对比（**明确不输出胜率**） | ✅ 已实现 | `team.py:248,299`；`bridge.test.js` 的「阵容评估已接规则 baseline，且明确不输出胜率」；`test_microcases.py::TestTeamBaseline`（6 条） |
| B8 | 伤害结算 | 🟡 **模拟** | `effects.py:57-99`（`verified=False`）；`env.py:540-566`（每次伤害带 `formula_verified`）；`test_microcases.py` 的「伤害模型必须被标为未核验」 |
| B9 | 能量（消耗、上限 6、回合末 +1） | 🟡 模拟 | `env.py:45-46`（`ENERGY_MAX`/`ENERGY_REGEN_PER_TURN`，注释「假设（MC-007）」）；`test_microcases.py::TestMC007Energy` 守的是「按这个假设算」 |
| B10 | 同速裁决 | 🟡 模拟 | `env.py:13`（「此处用 seed 驱动的确定性随机，**这是假设**（MC-002）」）、`env.py:420-427`、排序键第 4 位 `rng.random()` |
| B11 | 回合末状态 DOT（中毒 3% / 灼烧 2% 并衰减 / 寄生 2%） | 🟡 模拟 | `effects.py:247-286`（基数取最大生命、向下取整均为「假设（MC-011）」；衰减奇数向上取整为「假设（MC-008）」）；`env.py:709-749`（「先状态伤害再回能是假设（MC-012）」）；`test_microcases.py::TestMC008Status` |
| B12 | 应对的**后续替代效果**（「应对成功：改为…」） | 🟡 模拟 | `effects.py:182-194` 只覆盖「威力翻倍 / ×N」这类机械可读的模式；读不出的条件**标 `conditional` 并写明未识别**，不猜 |
| B13 | 条件化威力（「敌方每有1能量威力-10%」类） | 🟡 模拟 | `effects.py:139-205`（`effective_power`，逐条模式列出；未覆盖的标 reason 交由上层判 unsupported）；`test_microcases.py::TestMC010DynamicPower` |
| B14 | 道具效果（回复药 / 净化药 / 能量果） | 🟡 模拟 | `env.py:50-51`（`DEFAULT_ITEM_STOCK`/`ITEM_EFFECTS` 是引擎自定假设值）+ `_use_item()`（`env.py:684-707`，未知道具 → `_note_unsupported`）。**没有专项测试**断言这些数值 —— 这一点如实记录 |
| B15 | 规划器 `plan_actions()`（2–3 回合搜索、跨种子聚合、超时如实上报） | 🟡 模拟 | `planner.py:226-388`；`roco/tests/test_planner.py`（13 条）守的是搜索/超时/标签行为；但其**估值与对手建模都建立在 B8（未核验伤害公式）+ B10（同速随机）之上**，所以结论只能是「模拟」 |
| B16 | 印记（marks） | ⛔ 待做 | `env.py:607-620`：只累加层数进 `pet.marks`，并显式登记「叠加/替换规则未定义（MC-009）」；**没有任何具名印记的效果被计算**（例：术语 1035 星陨印记的触发伤害不存在） |
| B17 | 天气（weather） | ⛔ 待做 | `env.py:663-664`：`_note_unsupported(…, "引擎尚未实现天气层", …)`；`parse.py:96` 能认出但只登记 |
| B18 | 连击数（combo counts） | ⛔ 待做 | `env.py:540`：`hit_count=1` 硬编码；`env.py:17` 未实现清单含「连击数」 |
| B19 | 属性增减的**结算**（buff 参与伤害） | ⛔ 待做 | `env.py:540-542`：`ability_level=1.0` 与 `power_multiplier=1.0` 硬编码；`effects.ability_level()` 有实现但**未被调用**。buff 只被记录（`env.py:594-604`），不改变伤害 |
| B20 | 蓄力（charge） | ⛔ 待做 | `schema.py:92` 有字段、`env.py:447,570` 只在换人/力竭时置 `None`；**没有任何一处把它设为蓄力中**，无跨回合状态机；在 `roco/tests/*.py` 里搜「蓄力」或「charge」没有相关测试 |
| B21 | 特性（traits） | 混合：**3 只 ✅ / 2 只 🟡 / 1 只 ⛔ / 其余 ⛔** | `traits.py:41-107`：身经百练 **FULL**、泛音列 **FULL**、专注力 **FULL**（✅）；预警 **PARTIAL**（触发条件依赖未核验伤害公式，条件不实现）、捉迷藏 **PARTIAL**（能耗复合顺序未定义）→ 🟡；不朽 **REFUSED**（「拒绝而不是近似」，MC-014）→ ⛔；实跑 `implementation_summary()` = `{'FULL': 3, 'PARTIAL': 2, 'REFUSED': 1}`。B/C 组 6 只特性不在 `TRAITS` 里 → ⛔ |
| B22 | 等级 ≠ 1 的面板 | ⛔ 待做（明确拒绝） | `env.py:57-70`：等级 → 面板换算公式未知，`level != 1` 直接 `UnsupportedEffect`；测试 `test_microcases.py::TestFailClosed::test_level_other_than_one_is_refused` |
| B23 | 复盘摘要 `summarize_battle` | ⛔ 待做（结构化 `not_implemented`） | `roco-client.js:911-930`：无对应服务端点，`missing: ['event_ordering','official_damage_formula']`，不生成摘要 |

### C. 教练与演示界面（coach surfaces）

| # | 功能 | 标签 | 证据（文件 / 测试） |
|---:|---|---|---|
| C1 | 主动提示四档 `silent / micro_hint / action_hint / defer_to_review` + 硬门控先于评分 | ✅ 已实现 | `src/coach/experience.js:146-232`；`tests/intervention.test.js`（**13** 条）；离线窗口评测 `reports/roco/intervention/intervention-eval.json`：30 个窗口、`hintPrecision 1`、`falsePositives 0`、`staleHints 0` |
| C2 | 公开视图 → 经验层投影（纯函数）+ 陈旧判定唯一入口 | ✅ 已实现 | `src/coach/roco-experience.js:24-113`；`tests/roco-experience.test.js`（**9** 条，含「投影：私有字段一个都不进来」「陈旧判定：版本对不上就作废，只有一个入口」） |
| C3 | 无聊天入口演示页 + 六条 F01 场景 | ✅ 已实现 | `src/client/roco.html` + `roco.js`；浏览器验收 `scripts/roco/demo-acceptance.mjs`，报告 `reports/roco/demo-acceptance/demo-acceptance.json`：**16 项检查全部 ok、`failed: 0`**，7 张截图 |
| C4 | 局末**一个**教学入口（没有亮点就说没有） | ✅ 已实现 | `roco-experience.js:142-156`；`tests/roco-experience.test.js` 的「局末教学入口：没有值得拎出来的决策点就说没有」；`demo-acceptance.json` 的「局末教学入口在页面上真的显示了」 |
| C5 | 陪练：玩家抱怨时先回应情绪（R2/R3） | ✅ 已实现 | `src/coach/companion.js`（`intentOf`/`decideRegister`/`chatReply`/`REGISTERS`）；`tests/companion.test.js`（**87** 条）；浏览器验收的「玩家抱怨时陪练先回应情绪（R2/R3）」实测 `R2: 嗯，这一局确实不顺。…` |
| C6 | Node 服务端点与会话/CSRF/同源/白名单静态资源 | ✅ 已实现 | `src/server/index.js`；`tests/server.test.js`；`tests/evals/structure-contract.test.js`（白名单与模块图可独立核对） |
| C7 | 演示页不调用模型（因此**不需要 API key**） | ✅ 已实现（可核对） | `roco.js` 实读：只出现 `/api/bootstrap`、`/api/roco/*`，**没有** `api/coach` / `api/opponent` 引用；`/api/opponent` 在无密钥时返回 `source:'unconfigured'`（`index.js:205`） |
| C8 | `POST /api/coach` 模型链路本身（演示不用，但存在且有测试） | ✅ 已实现 | `index.js:180-200`；`tests/server.test.js` / `tests/coach.test.js` |
| C9 | 阵容模型训练（LightGBM 等）/ 正式评测 | ⛔ 待做 | `docs/roadmap/DSH-EXECUTION-STATE.md`「已知未完成」：「**G02（逻辑回归/LightGBM 阵容模型）**：未做」 |

---

## 3. 汇总：数一数

| 标签 | A 数据 | B 引擎 | C 教练/演示 | 合计 |
|---|---:|---:|---:|---:|
| ✅ 已实现 | 6 | 7 | 8 | **21** |
| 🟡 模拟 | 1 | 7 | 0 | **8** |
| ⛔ 待做（含混合项的单列） | 1 | 9 | 1 | **11** |
| 混合（特性 B21） | — | 1 | — | **1** |

**诚实结论**：

- **机制侧大多数是「待做」**。印记、天气、连击数、属性增减结算、蓄力 5 类机制**完全没有实现**，
  引擎按 fail closed 拒绝（会进 `state.unsupported`，页面显示「未核验、因此未结算」）。
  12 只精灵的 `support.current` **一律 `KNOWLEDGE_ONLY`** —— 一只都不能进战斗结论。
- **伤害公式是「模拟」**，不是已实现：它是一个**未核验的社区候选假设**（`verified=False`），
  每个伤害事件都带 `formula_verified: false`。
- **数据导入与教练界面是「已实现」**：数据侧 15/15 测试 + 逐字段对拍，
  教练侧 16/16 浏览器验收 + 13 条提示策略测试 + 9 条投影测试。
- 三份文件说的「本轮没有实现任何效果原语」（`EFFECT-PRIMITIVES.md`）与
  「microcase 全部 `passed=false`」（`MICROCASE-PLAN.md`）**今天仍然成立**，
  它们说的是**数据字段的背书状态**与**规则验证状态**；
  与「引擎里已写了部分机制」不矛盾，也不能互相替代。
