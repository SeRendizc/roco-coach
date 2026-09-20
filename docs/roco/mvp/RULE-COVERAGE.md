# F03 · 规则覆盖表（RULE COVERAGE）

> 口径：本表回答「12 只目标精灵与手游机制，**现在**被覆盖到什么程度」。
> 每个数字标「证据」= 我实际读过的文件或实际跑过的命令。
>
> **实跑命令**（本轮）：
> ```bash
> cd roco && PYTHONPATH=src python3 -m roco_env.parse
> cd roco && PYTHONPATH=src python3 -c "…parse.coverage_report(set(rs.skills), rs)…"
> cd roco && PYTHONPATH=src python3 -m unittest discover -s tests      # 122 tests OK
> npm run test:roco-all                                                 # exit 0
> npm run test:roco                                                     # 15/15 通过
> ```

---

## 0. 支持等级定义（来自实施书，`docs/roco/PET-SUPPORT-MATRIX.md` §0）

```text
CATALOG_ONLY     只能展示图鉴
KNOWLEDGE_ONLY   可用于 RAG 问答，不能进入战斗
SIM_PARTIAL      部分技能可模拟，不能用于强度结论
SIM_VERIFIED     所选配招的全部效果通过 microcase，可实战
EVAL_ELIGIBLE    可进入阵容模型训练与正式评测
```

`support-matrix.json` 里 12 只精灵的 `support.current` **一律是 `KNOWLEDGE_ONLY`**（实读 JSON）。
`support.target_next` 是**下一轮目标**，不是当前能力——`data-acceptance.test.js` 有一条断言专门钉这一点
（「支持等级与目标等级必须分开，且不得声称已完成」，`npm run test:roco` 15/15 通过）。

---

## 1. 12 只目标精灵：支持等级与已被验证的事实

| # | 组 | 精灵 | pet_id | 属性 | 种族值合计 | 技能池 | 固有 | 静态威力 | 动态/条件威力 | 机制种类 | 特性（登记） | 特性实现 | 当前支持等级 |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | A | 寂灭骨龙 | `pet_000225` | 龙系+幽系 | 552 | 44 | 13 | 18 | 8 | 14 | 不朽 | — | `KNOWLEDGE_ONLY` |
| 2 | A | 海豹船长 | `pet_000190` | 武系+水系 | 600 | 49 | 15 | 23 | 7 | 14 | 身经百练 | **FULL** | `KNOWLEDGE_ONLY` |
| 3 | A | 黑猫巫师 | `pet_000445` | 普通系 | 615 | 45 | 13 | 13 | 3 | 13 | 预警 | PARTIAL | `KNOWLEDGE_ONLY` |
| 4 | A | 圆号鱼 | `pet_000417` | 水系 | 549 | 45 | 13 | 13 | 1 | 13 | 泛音列 | **FULL** | `KNOWLEDGE_ONLY` |
| 5 | A | 雪影娃娃 | `pet_000112` | 冰系+萌系 | 617 | 50 | 16 | 17 | 3 | 14 | 捉迷藏 | PARTIAL | `KNOWLEDGE_ONLY` |
| 6 | A | 音速犬 | `pet_000062` | 火系 | 542 | 44 | 13 | 32 | 8 | 14 | 专注力 | **FULL** | `KNOWLEDGE_ONLY` |
| 7 | B | 画间沉铁兽 | `pet_000474` | 普通系+武系 | 604 | 58 | 16 | 42 | 13 | 12 | 变形活画 | — | `KNOWLEDGE_ONLY` |
| 8 | B | 秩序鱿墨 | `pet_000451` | 幽系+萌系 | 604 | 51 | 16 | 23 | 9 | 13 | 绝对秩序 | — | `KNOWLEDGE_ONLY` |
| 9 | B | 化蝶 | `pet_000124` | 虫系+萌系 | 377 | 49 | 15 | 15 | 2 | 14 | 化茧 | — | `KNOWLEDGE_ONLY` |
| 10 | C | 银月狼王 | `pet_000608` | 幽系+幻系 | 650 | 46 | 13 | 37 | 11 | 13 | 铭记于月亮 | — | `KNOWLEDGE_ONLY` |
| 11 | C | 圣凯布米龙 | `pet_000601` | 火系+虫系 | 569 | 44 | 13 | 29 | 10 | 13 | 热成像 | — | `KNOWLEDGE_ONLY` |
| 12 | C | 月使鹭纳 | `pet_000611` | 翼系+冰系 | 614 | 49 | 15 | 24 | 9 | 13 | 冷光源 | — | `KNOWLEDGE_ONLY` |

**证据**：上表每一行都由实跑 Python 从
`data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json` 逐字段读出
（`pets[].{group,name,pet_id,types,stat_total,learnset.pool_size,learnset.native,learnset.with_static_power,learnset.dynamic_or_conditional_power,learnset.distinct_mechanisms,trait.name,support.current}`）。
特性实现列来自 `roco/src/roco_env/traits.py` 的 `TRAITS` 与 `implementation_summary()`
（实跑：`{'FULL': 3, 'PARTIAL': 2, 'REFUSED': 1}`）；「—」= 该特性**不在** `TRAITS` 里，引擎未实现
（`env.py` 文件头「12 只精灵的特性效果（MC-014…019）」列为未实现项）。

### 1.1 逐只「已被验证了什么」

「验证」分三类，都指向可复核的文件：

| 精灵 | RAG 可回答（数据完整） | 交叉核验 | 文本解析覆盖（该精灵技能池） |
|---|---|---|---|
| 寂灭骨龙 | ✅ 12/12 解析成功、0 孤儿引用 | 有两源差异 7 处，**全部有解释** | 池 44：完全可解析 **12** / 部分 0 / 未覆盖 32 |
| 海豹船长 | ✅ | 差异 1 处，全部有解释 | 池 49：**11** / 0 / 38 |
| 黑猫巫师 | ✅ | 差异 5 处，全部有解释 | 池 45：**13** / 0 / 32 |
| 圆号鱼 | ✅ | 差异 2 处，全部有解释 | 池 45：**16** / 0 / 29 |
| 雪影娃娃 | ✅ | 差异 1 处，全部有解释 | 池 50：**20** / 0 / 30 |
| 音速犬 | ✅ | 差异 2 处，全部有解释 | 池 44：**8** / 0 / 36 |
| 画间沉铁兽 | ✅ | 差异 5 处，全部有解释 | 池 58：**11** / 0 / 47 |
| 秩序鱿墨 | ✅ | 差异 1 处，全部有解释 | 池 51：**19** / 0 / 32 |
| 化蝶 | ✅ | **单一来源**（无交叉核验） | 池 49：**17** / 0 / 32 |
| 银月狼王 | ✅ | **单一来源**（S4 新精灵） | 池 46：**6** / 0 / 40 |
| 圣凯布米龙 | ✅ | **单一来源**（S4 新精灵） | 池 44：**7** / 0 / 37 |
| 月使鹭纳 | ✅ | **单一来源**（S4 新精灵） | 池 49：**6** / 2 / 41 |

**证据**：交叉核验列来自 `docs/roco/DATA-CONFLICTS.md` §3 与
`data/roco/normalized/roco-world-s4-2026-09-10/import-report.json` 的 `cross_check.details`；
解析覆盖列来自本轮实跑 `parse.coverage_report(pool, rs)`（每只精灵以其学习表全池 `all_skill_ids` 为输入）。

> **「完全可解析」≠「引擎能模拟」。** `parse.coverage_report()` 统计的是
> **技能描述文本**能被 `parse_skill()` 机械读出的比例（见 §3 的口径警告）。
> 上表所有精灵的 `support.current` 仍是 `KNOWLEDGE_ONLY`。

---

## 2. 机制类别覆盖表

| 机制类别 | 状态 | 引擎里到底做了什么 | 证据 |
|---|---|---|---|
| **伤害公式** | **模拟** | `COMMUNITY_HYPOTHESIS_V1`：`base = (atk/def) * power * 0.9`，乘属性克制 × 本系 1.5 × 连击 × 威力 buff，向下取整、最小 1。**`verified=False`**，`source` 字段写明取自 `ColinHong10/NRC_AI src/battle.py`（社区实现，非官方）。 | `roco/src/roco_env/effects.py:57-99`；每个 `damage` 事件带 `damage_model` 与 `formula_verified`（`env.py:552-566`）；`test_microcases.py::TestFailClosed::test_damage_model_is_marked_unverified` |
| **能量** | **模拟** | 消耗：`pet.energy = max(0, pet.energy - skill.energy)`（注释「假设：消耗先扣（MC-007）」）；上限 `ENERGY_MAX = 6`、回合末 `ENERGY_REGEN_PER_TURN = 1`、道具「能量果 +4」——三者都是**假设**，数据未给。 | `env.py:45-46,50-51,471,744-749`；`test_microcases.py::TestMC007Energy`（消耗与回能、非法动作拒绝） |
| **同速裁决（speed ties）** | **模拟** | 排序键第 4 位是 `rng.random()`，rng 由 `(seed, turn)` 派生，确定性可回放。文件头明写「同速且同先手度时的裁决依据；此处用 seed 驱动的确定性随机，**这是假设**（MC-002）」。 | `env.py:13,288-323,420-427` |
| **先手度 / 出手顺序** | **已实现（术语背书 + 测试）** | 排序键：① 应对成功 → ② 先手度 → ③ 速度 → ④ seed 随机。依据术语 1020。 | `env.py:238-260,288-323`；`test_microcases.py::TestMC001Priority`（高一档先手度慢速也先动、换人优先、顺序是完整全序） |
| **印记（marks）** | **待做（只登记，不结算效果）** | 收到 `self_mark`/`foe_mark` 时**累加层数**进 `pet.marks`，并显式登记「叠加/替换规则未定义（MC-009）」。**没有任何具名印记的效果被计算**——例如术语 1035「星陨印记」的触发伤害没有实现。 | `env.py:607-620`（`_note_unsupported(state, f"印记「{name}」的叠加/替换规则", …)`）；`env.py:13-16` 未实现清单 |
| **天气（weather）** | **待做** | `parse_skill()` 能识别「将天气改为X」并给出 `kind="weather"`，但应用时**只登记不支持**：`_note_unsupported(state, f"天气「{v['weather']}」", "引擎尚未实现天气层")`。 | `parse.py:89`（`_WEATHER` 正则，能认出「将天气改为X」）；`env.py:663-664`（应用时登记不支持）；在 `roco/tests/*.py` 里搜「天气」或「weather」都**没有命中任何测试** |
| **连击数（combo counts）** | **待做** | 伤害计算里 `hit_count=1` 是**硬编码**；术语 3005「连击数」与 `N连击` 描述都没有参与结算。 | `env.py:540`（`hit_count=1,`）；`env.py:17` 未实现清单含「连击数」 |
| **属性增减 / 层数语义（stat stages）** | **待做（只登记，不参与结算）** | `self_stat`/`foe_stat` 会把 `delta_pct` 累加进 `pet.buffs[...]`，但伤害计算里 `ability_level=1.0` 与 `power_multiplier=1.0` **都是硬编码**——即 buff 记录了却没有改变伤害。`effects.ability_level()` 有实现，但**没有被调用**。 | `env.py:594-604`（写 buffs）、`env.py:540-542`（`ability_level=1.0`）；`effects.py:117-126` 的 `ability_level()` 未被 env 使用；`env.py:17` 未实现清单含「属性增减的层数语义」 |
| **特性（traits）** | **部分已实现（A 组 6 只：FULL 3 / PARTIAL 2 / REFUSED 1）；其余待做** | 逐条标注实现状态而不是一律当「已实现」：身经百练 FULL、泛音列 FULL、专注力 FULL；预警 PARTIAL（触发条件依赖未核验伤害公式，条件未实现）、捉迷藏 PARTIAL（能耗复合顺序未定义）；不朽 **REFUSED**（明写「拒绝而不是近似」）。 | `traits.py:41-107`；实跑 `implementation_summary()` = `{'FULL': 3, 'PARTIAL': 2, 'REFUSED': 1}`；`test_microcases.py::TestTraits`（含「被拒绝的特性不得被静默近似」） |
| **状态效果（status effects）** | **模拟（中毒/灼烧/寄生三种回合末 DOT）；其余待做** | 术语 1001 中毒 3%、1002 灼烧 2%（并衰减一半层数）、1008 寄生 2% 有实现；**取整方向与基数（最大生命 vs 当前生命）是假设**（MC-011）。冻结 1004、引电 3022、眩晕、禁足 3023、萌化 1006、木桶/月陨星 3024/3025 均**未实现**。 | `effects.py:247-286`（`END_OF_TURN_STATUS` / `percent_of_max_hp` / `status_tick` / `decay_layers`，注释逐条标「假设」）；`env.py:709-749`（`_end_of_turn`，注释「先状态伤害再回能是假设（MC-012）」）；`test_microcases.py::TestMC008Status` |
| **应对（respond）** | **已实现（检测/先手/减伤/冷却，术语 1015–1017 背书 + 测试）；后续效果结算为模拟** | `respond_to()` 按术语分类；应对成功在 `order_actions()` 里排到最前；防御技能读「减伤 N%」并在**无条件**生效；`应对攻击` 落 2 回合冷却。**假设**：减伤无条件生效（MC-020）、冷却只作用本技能。 | `effects.py:289-331`；`env.py:474-495`；`test_microcases.py::TestMC020Respond`（4 条：与术语一致、只有应对攻击给冷却、减伤能从文本解析、只在类别匹配时成功） |
| **蓄力（charge）** | **待做（只有字段与「被打断」这一处副作用）** | `PetState.charge` 字段存在且被序列化；但**没有任何一处把 charge 设成蓄力中**——只在主动换人与力竭时把它清空。没有跨回合状态机，也没有「免蓄力」消耗规则。 | `schema.py:92,113,292`；`env.py:447,570`（只 `= None`）；在 `roco/tests/*.py` 里搜「蓄力」或「charge」只命中一处「对手不得读 charge」的隐私断言 |

### 2.1 覆盖率的真实数字（实跑）

| 范围 | 技能数 | 完全可解析 | 部分可解析 | 完全未覆盖 |
|---|---:|---:|---:|---:|
| **规则集全部技能** | 824 | **164** | 20 | 640 |
| **12 只目标精灵学习表并集** | 264 | **62** | 2 | 200 |
| **A 组 6 只学习表并集** | 174 | **47** | 0 | 127 |

**证据**：本轮实跑 `parse.coverage_report()`。
第三行与 `python3 -m roco_env.parse` 的官方输出一致（`A 组六只技能池并集：174 个技能 / 完全可解析: 47 / 部分可解析: 0 / 完全未覆盖: 127`）。

**一个必须说清的口径警告**：`parse.coverage_report()` 统计的是**文本**能被读懂的比例，不是**引擎能模拟**的比例。
实证反例：12 只技能池里含「蓄力」字样的技能有 **5** 个，其中 **1** 个被 `parse_skill()` 判为 `fully_supported`
——因为 `parse.py` 的 `UNPARSED_MARKERS` 里**没有**「蓄力」。也就是说这个数在蓄力类技能上会偏高。
（实跑脚本：对 12 只并集统计 `"蓄力" in desc` 的技能数与其 `parse_skill(...).fully_supported`。）
因此 §2 表里的「待做」必须以**引擎代码**为准，不能只看覆盖率数字。

---

## 3. 原语清单与 microcase 计划（这两份文件说的「还没实现」是什么意思）

| 文件 | 关键数字 | 证据 |
|---|---|---|
| `docs/roco/EFFECT-PRIMITIVES.md` | 需要实现的效果原语 **68** 个；有术语表定义 **27** 个；**只有技能描述、没有术语定义 41** 个；术语表条目 54；12 只学习表技能并集 264；A 组候选配招并集 19，其中**完全由术语表背书、不依赖纯描述原语的只有 1 个**；被标「文本不确定」的技能 163 | 该文件表头；`roco/effect-inventory.json` 的 `primitives`(68) / `glossary_backed_primitives`(27) / `prose_only_primitives`(41) / `ambiguous_skills`(163) 实读 |
| `docs/roco/MICROCASE-PLAN.md` | case **21** 条，`status = PLAN_ONLY_NOT_EXECUTED`，**每一条 `verification.passed` 都是 `false`**，21 条 `expected_event_sequence` 全是 `null`；优先级 P0 5 / P1 5 / P2 5 / P4 6；覆盖任务书 11 个方向 + 补充 2 组（应对、蓄力） | 该文件 §1、§2、§3；`tests/evals/roco/cases/microcases-v1.jsonl` 实跑：22 行 = 1 行 `microcase_plan_header` + **21** 条 case，`passed` 计数 **0** |

`docs/roco/EFFECT-PRIMITIVES.md` 表头原文：「本轮**没有实现任何原语**，`skills.json` 里 824 条技能的
`effect_support` 仍全部是 `unsupported`；本清单回答的是「要实现它们，需要哪些原语、按什么顺序」，不是「已经实现」。」
——**这句话到今天仍然成立**（本文实读 `skills.json`：`Counter({'unsupported': 824})`）。
它与 §2 表里「引擎已实现部分机制」**不矛盾**：前者说的是 M1 导入时写死在**数据字段**里的背书状态，
后者说的是 `roco/src/roco_env/` 里后来写下的代码。两者必须分开看，不能互相替代。

`MICROCASE-PLAN.md` §5 的口径（引擎的行为准则）：在这些问题有答案之前实现必须 **fail closed**，
遇到未核验机制返回 `unsupported_effect`，**禁止**退化成「默认 40 威力普通攻击」这类自创默认值。
代码落点：`effects.py:16`（「没有实现的效果原语一律抛 `UnsupportedEffect`，**绝不**返回一个默认数值」）、
`env.py:8-17`、`errors`/`unsupported` 记账 `env.py:330-334`。

---

## 4. 结论（一句话）

**12 只精灵全部可做 RAG 问答（`KNOWLEDGE_ONLY`），一只都不能进入战斗结论。**
机制侧：伤害公式是**模拟**（未核验假设），能量/同速/状态 DOT 是**模拟**，
印记 / 天气 / 连击数 / 属性增减结算 / 蓄力是**待做**（fail closed），
应对机制与先手排序是**已实现（术语背书 + 有测试）**，A 组 6 只特性 3 只 FULL、2 只 PARTIAL、1 只 REFUSED，
其余 6 只特性未实现。

---

## W3-01 之后的更新（技能池与实测状态）

上面那些数字是 M1 时代的（12 只 A 组 / 30 个候选技能）。W3-01 之后有变化，
两套数字都留着，免得读的人以为没动过：

| 项 | M1 时代 | 现在 |
|---|---|---|
| 接入引擎的精灵 | 6（A 组） | **12**（A 组 6 + B/C 组 6） |
| 特性实现状态 | 未登记 | **FULL 6 / PARTIAL 2 / REFUSED 4**（`data/roco/engine-trait-status.json`） |
| 候选技能池 | 30（12 只 × 4 去重） | **55**（新增 `candidate_extras` 一栏，3 个/只；规范配招未动） |
| 解析层完全支持 | 16 / 30 | **29 / 55（52.7%）**，其中 13 个是纯伤害、走 damage 路径 |
| microcase | 21 | **30**（新增 B/C 组 6 条 + 属性复合/减伤时机/取整 3 条） |
| 通过实测核验的 microcase | 0 | **仍然是 0** |

最后一行是这份表里最重要的：**扩域不等于核验。** 30 条 microcase 里
26 条「引擎有明确行为」（那行为是假设）、4 条连前提都缺，
**没有一条**因为「引擎写完了」而变成通过。逐条状态见
`docs/roco/MICROCASE-HARNESS.md`；实测录入与标定见
`scripts/roco/record-measurements.py` 与 `docs/roco/CALIBRATION.md`。

### 两套「支持」不要混

| 字段 | 说的是什么 | 现在的值 |
|---|---|---|
| `skills.json` 的 `effect_support` | **上游数据**对这条技能的支持声明 | 824/824 全是 `unsupported` |
| `data/roco/engine-trait-status.json` 的 `status` | **本仓库引擎**对这条特性的实现状态 | FULL 6 / PARTIAL 2 / REFUSED 4 |
| 支持等级 `current` | 「机制是否被**实测**核验过」 | 12 只全部 `KNOWLEDGE_ONLY` |

第一个恒为 `unsupported` 是数据的事实，第二个是引擎的事实，第三个是**验收**的事实。
把三者混着读必然得出错误结论 —— `PET-SUPPORT-MATRIX.md` 现在每个特性都分两行写。
