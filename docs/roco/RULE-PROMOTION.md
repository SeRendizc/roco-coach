# 规则 promotion gate（RC-102 后半）

> 一句话：**没有实机（或官方一手）记录，候选配置的每个字段都拿不到 `PROMOTABLE`。**
> 判决书由 `node scripts/roco/evaluate-rule-promotion.mjs` 生成 →
> `reports/roco/flagship-upgrade/rule-promotion.json`。
>
> **本脚本只报告，不写配置。** 哪怕它判了 `REFUTED`（记录说候选值是错的），
> 它也不会去改 `data/roco/rulesets/mobile-s4-candidate-v2.json` —— 改配置是人的决定，
> 并且要连带改台账、跑 RC-101 的影响清单、重建绑定旧规则的产物。
> 报告里的 `writes_config: false` 与 `config_unchanged: true`（sha256 前后对比）就是这条边界的机器证据。

## 1. 为什么需要它

RC-101 做到了「候选值与默认基线分家」，并且给每个字段挂了
`confidence` / `evidence_id` / `microcase_id` / `value_status`。但那只是**登记**了
「这个值还没被实机验证」——它没有回答施工层真正会问的问题：

```text
这个字段现在可不可以 promotion？如果不可以，缺的是哪一条证据？
```

一条边界如果没有可执行的判据，它真正的状态仍然是「没人知道」。所以 RC-102 后半把
10 号文档 §7 的那句「没有 RECORDED_IN_GAME/官方证据前不直接 promotion」变成一份
**逐字段的判决书**，每一条判决都带「为什么」。

## 2. 跑法

```bash
node scripts/roco/evaluate-rule-promotion.mjs            # 逐字段判决 + 写报告文件
node scripts/roco/evaluate-rule-promotion.mjs --json     # 同上，报告打到 stdout
node scripts/roco/evaluate-rule-promotion.mjs --selftest # 自带正反用例（12 条，含 10 条反证）
node scripts/roco/evaluate-rule-promotion.mjs --no-write # 只评判，不落盘
node --test tests/roco-rule-promotion.test.js            # 同一批判据的测试
```

取证开关（报告要贴「换成坏输入后的真实报错原文」，而反证不许改真数据）：

```bash
cp data/roco/evidence/microcase-recordings.json /tmp/bad.json   # 在 /tmp 上改坏
node scripts/roco/evaluate-rule-promotion.mjs --recordings /tmp/bad.json --json
node scripts/roco/evaluate-rule-promotion.mjs --config  /tmp/bad-config.json --json
```

退出码：`0` = 全部 PROMOTABLE；`1` = 有字段 NOT_PROMOTABLE（证据不全，本阶段就是这个）；
`2` = 出现 REFUTED（有反证，必须有人读录像）。**当前是 1。**

## 3. 输入和输出

| 角色 | 文件 |
| --- | --- |
| 候选配置（被判决对象，只读） | `data/roco/rulesets/mobile-s4-candidate-v2.json` |
| 证据台账（等级定义与结论，只读） | `data/roco/evidence/rule-evidence-ledger.json` |
| microcase 计划（要录什么、录到什么算通过） | `data/roco/evidence/rule-evidence-microcase-records.json` |
| **录像/观测登记表**（本阶段为空数组） | `data/roco/evidence/microcase-recordings.json` |
| 影响清单（RC-101，只引用不重算） | `reports/roco/flagship-upgrade/rc-101-rule-config.json` |
| **判决书（唯一写出的文件）** | `reports/roco/flagship-upgrade/rule-promotion.json` |

等级与来源标记的定义**复用** `scripts/roco/evidence-ledger-lib.mjs`
（`CONFIDENCE_ORDER` / `PROMOTABLE_LEVELS` / `formatIssues`），不另写一套：

- 台账的六选一等级：`OFFICIAL_CURRENT > RECORDED_IN_GAME > COMMUNITY_CURRENT > CROSS_SOURCE_SUPPORTED > ENGINE_HYPOTHESIS > UNKNOWN`；
- 只有前两级能直接成为 current 规则（`PROMOTABLE_LEVELS`）；
- 登记的记录等级只允许 `RECORDED_IN_GAME` / `OFFICIAL_CURRENT` 两级；
  `script` 的来源标记只允许 `recorded_gameplay` / `official_first_party`
  （`official_reproduction` 被刻意排除：转载无法证明与原公告逐字一致）。

### 3.1 登记表 `microcase-recordings.json` 的形状

顶层：`schema` / `generated_by` / `ruleset_id` / `game` / `status` /
`accepted_confidence` / `source_kind_allowed` / `record_shape` /
`max_record_age_days` / `why_empty` / `recordings[]`。

每条记录：

| 字段 | 约束 |
| --- | --- |
| `microcase_id` | 形如 `MC-E01`，必须与 `rule-evidence-microcase-records.json` 同 id |
| `recorded_at` | 可解析的 ISO 日期（时间）；超过 `max_record_age_days`（现为 548 天）即过期 |
| `confidence` | **只允许** `RECORDED_IN_GAME` / `OFFICIAL_CURRENT` |
| `source_kind` | **只允许** `recorded_gameplay` / `official_first_party` |
| `media_ref` | http(s) 链接，或**仓库里真实存在**的文件路径；`/tmp`、不存在的路径、`file://` 都算「不可核对」 |
| `observations` | 字段 → 观测值；必须覆盖该 case 的 `pass_criteria` 要求的量 |
| `notes` | 非空：录的是哪个版本/赛季、有没有干扰因素 |

**本阶段 `recordings` 是空数组**，而且这就是正确状态：仓库里没有任何实机录制。
文件里的 `why_empty` 明写「不许为了看起来完整填假记录」。演示用的假记录只允许活在
测试的内存副本或 `os.tmpdir()` 里。

## 4. 判据（每条都有必红方向）

| # | 判据 | 必红方向（什么输入必须让它红） | 判决 |
| --- | --- | --- | --- |
| ① | 字段有候选值（`UNKNOWN`+`null` 不算） | 给 `energy.initial` 保持 `null` → 必须红 | `NOT_PROMOTABLE` |
| ② | 字段能指到一条 microcase（叶子 / 台账 / `unknowns[]` 三处任一） | 把 `battle_mode.team_size` 这类没有 case 的字段交进来 → 必须红并写明「没有落点」 | `NOT_PROMOTABLE` |
| ③ | 该 microcase **有记录** | `recordings: []` → 必须红并点名 `MC-E01…E05` | `NOT_PROMOTABLE` |
| ④ | 记录的 `confidence` 属于 `RECORDED_IN_GAME` / `OFFICIAL_CURRENT` | 记录写 `COMMUNITY_CURRENT` → 必须红 | `NOT_PROMOTABLE` |
| ⑤ | 字段有 `evidence_id`，且它在台账里真的存在 | 写成 `EV-NOT-IN-LEDGER` → 必须红 | `NOT_PROMOTABLE` |
| ⑥ | 记录的观测值与候选值一致 | 观测 `energy_max_observed=12`、候选 `10` → 必须红（`REFUTED`），并同时贴出两个值 | `REFUTED` |
| ⑦ | `pass_criteria` 折算出的必观测项都录到了 | 只录 `energy_max_observed`、缺 `charge_energy_delta` → 必须红并点名键名 | `NOT_PROMOTABLE` |
| ⑧ | `media_ref` 可核对 | `/tmp/does-not-exist.mp4` → 必须红 | `NOT_PROMOTABLE` |
| ⑨ | 记录没过期 | `recorded_at=2020-01-01` → 必须红（距今天数写进理由） | `NOT_PROMOTABLE` |
| ⑩ | 记录日期可解析 | `recorded_at="上个月"` → 必须红 | `NOT_PROMOTABLE` |
| ⑪ | 观测值形状是有效读数（正整数 / 整数 / 布尔 / 非空字符串数组） | `energy_max_observed=-1` → 必须红 | `NOT_PROMOTABLE` |
| ⑫ | 所有判据都过才 `PROMOTABLE` | 任何一条红 → 不许绿 | — |
| ⑬ | `candidate_config_can_be_default` **恒为 false** | 即便所有能顶的字段全绿也必须是 false | — |

`pass_criteria` 的折算写在脚本的 `REQUIRED_OBSERVATIONS` 里，每条都带 `from_pass_criteria`
原文，可逐字回查：

| case | 必观测的键 |
| --- | --- |
| `MC-E01` | `energy_max_observed`（正整数）、`charge_energy_delta`（整数） |
| `MC-E02` | `charge_energy_delta`、`charge_beyond_cap`（布尔） |
| `MC-E03` | `regen_per_turn_delta`（整数） |
| `MC-E04` | `initial_energy_observed`（整数）、`entry_inherits_leftover`（布尔） |
| `MC-E05` | `order_observed`（非空字符串数组）、`speed_tie_deterministic`（布尔） |

### 台账等级与「够不够资格」

记录顶住之后，台账那一条还得从 `CROSS_SOURCE_SUPPORTED` 改成 `RECORDED_IN_GAME` ——
**那是人随 promotion 一起做的动作，脚本不代做**。所以脚本不把「台账当前等级低」判成
「缺证据」，而是记一条 `pending_ledger_bump`：明确写出 promotion 时必须一并改台账哪一行，
以及不改就会让 `build-rule-configs.mjs --check` 判红（配置的 confidence 会高于台账）。

## 5. 当前逐字段结论（`recordings: []`）

没有例外：**9/9 个字段全部 `NOT_PROMOTABLE`，`REFUTED` 0 条**。

| 字段 | 候选值 | confidence | 台账引用 | 待录 case | 判决 | 为什么 |
| --- | --- | --- | --- | --- | --- | --- |
| `battle_mode.team_size` | `6` | `ENGINE_HYPOTHESIS` | — | — | **NOT_PROMOTABLE** | 没有 microcase 落点：模式参数，既不属 `energy.*` 也没挂 case |
| `battle_mode.active_count` | `1` | `ENGINE_HYPOTHESIS` | — | — | **NOT_PROMOTABLE** | 同上 |
| `energy.max` | `10` | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-MAX` | `MC-E01` | **NOT_PROMOTABLE** | 缺 `MC-E01` 记录 |
| `energy.regen.per_turn` | `0` | `ENGINE_HYPOTHESIS` | `EV-ENERGY-ENDTURN-REGEN` | `MC-E03` | **NOT_PROMOTABLE** | 缺 `MC-E03` 记录 |
| `energy.initial` | `null` | `UNKNOWN` | — | `MC-E04` | **NOT_PROMOTABLE** | 还是 `UNKNOWN=null`：没有候选值可 promotion + 缺 `MC-E04` 记录 |
| `energy.charge` | `5` | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-CHARGE` | `MC-E02` | **NOT_PROMOTABLE** | 缺 `MC-E02` 记录 |
| `turn_order.end_turn.order` | `["status_tick","regen"]` | `ENGINE_HYPOTHESIS` | — | `MC-E03`（来自 `unknowns`） | **NOT_PROMOTABLE** | 缺 `MC-E03` 记录 |
| `turn_order.end_turn.known_order` | `["respond","switch","priority","speed"]` | `ENGINE_HYPOTHESIS` | `EV-TURN-ORDER-STRICT` | `MC-E05` | **NOT_PROMOTABLE** | 缺 `MC-E05` 记录 |
| `turn_order.end_turn.speed_tie` | `null` | `UNKNOWN` | — | `MC-E05` | **NOT_PROMOTABLE** | 还是 `UNKNOWN=null` + 缺 `MC-E05` 记录 |

```text
candidate_config_can_be_default = false
reason: 候选配置在「每个字段都 PROMOTABLE」之前不得作为默认；本脚本不实现自动转默认，
        当前 0/9 个字段可 promotion（all_promotable=false），
        且即便全绿也需要人类显式批准，所以恒为 false
```

`energy.max=10` 与 `energy.charge=5` 现在只有 `CROSS_SOURCE_SUPPORTED`（社区多源），
**不是** `RECORDED_IN_GAME` —— 这正是「没有实机证据就不许 promotion」的含义：
候选值可以照常做对照实验，但不许被当作已验证的 rule 使用，更不许成为默认。

## 6. 还缺哪些录制

`recordings` 为空 ⇒ 全部 5 条待录 case 都还缺。清单（`missing_recordings`）在报告里是
机器可读的，含每条 case 的 `title` / `plan_case` / `pass_criteria` / `required_observations` /
`blocks_fields`：

| case | 卡住的字段 | 必须录到的量 | 已挂接的仓库计划 |
| --- | --- | --- | --- |
| `MC-E01` | `energy.max` | 能量读数最大值、聚能前后差值（同一次录制三段：前读数/动作/后读数） | `MC-007` |
| `MC-E02` | `energy.charge` | 聚能差值、满能量再聚能是否变化 | `MC-007` |
| `MC-E03` | `energy.regen.per_turn`、`turn_order.end_turn.order` | 无回能特性精灵的回合末增量（对照带特性者） | `MC-007` |
| `MC-E04` | `energy.initial` | 首次入场读数、换入是否继承剩余能量 | `MC-007` |
| `MC-E05` | `turn_order.end_turn.known_order`、`turn_order.end_turn.speed_tie` | 四段两两对抗的先后、同速是否固定先手 | `MC-004` |

两条**结构上**不可能靠录制解决的字段（要如实说出来，而不是假装等待录制）：

- `battle_mode.team_size` / `active_count`：模式参数，台账与 case 表里都没有对应结论。
  要 promotion 就得先给它们建 microcase 并挂进台账，否则它们永远 `NOT_PROMOTABLE`。
- `energy.initial`：`null` 是**正确**的当前值。录到读数之后由人决定填什么，
  脚本不会代填（它会照常把这个字段判 `NOT_PROMOTABLE`，直到配置里真的有了值）。

录到第一条真实记录时，只要把记录填进 `microcase-recordings.json` 的 `recordings[]`
（用真实 `media_ref`，不要 `/tmp`），重跑脚本即可看到该字段从 `NOT_PROMOTABLE`
变成 `PROMOTABLE`（或 `REFUTED`）—— `--selftest` 的反证②③就是这条路径的样例，
只不过用的是内存假记录。

## 7. 边界与反自欺

1. **只报告，不写配置。** 脚本的写出目标只有一个：`reports/roco/flagship-upgrade/rule-promotion.json`。
   `writes_config: false` 是声明，`config_unchanged: true`（sha256 前后对比）是证据。
   测试里也有对应断言：伪造 REFUTED 场景后，候选配置的 sha256 必须一模一样。
2. **不许编观测值/录像。** 初始登记表是空数组；假记录只活在测试内存或 `os.tmpdir()`。
   测试结束时还会对比 `data/` 下四个只读输入的 sha256，证明测试自己没写脏数据。
3. **台账等级不靠一次登记就跳级。** 记录只能证明「够资格升级」；把台账那行改成
   `RECORDED_IN_GAME` 是人的动作，脚本只把 `pending_ledger_bump` 记账。
4. **不实现「自动转默认」。** `candidate_config_can_be_default` 恒为 `false`：
   一个能把候选悄悄变成默认的判据，本身就是这一整轮要防的事。
5. **脚本不判断「值对不对」。** 它只核对证据形式（有没有记录、等级够不够、观测与候选是否
   一致、引用是否可核对、判据是否满足）。值本身仍要人读录像确认——`PROMOTABLE` 不等于
   「值已经是对的」，只等于「证据链齐了，可以走人的批准流程」。

## 8. 相关文件

- 机制与判决：`scripts/roco/evaluate-rule-promotion.mjs`、`tests/roco-rule-promotion.test.js`
- 判决书：`reports/roco/flagship-upgrade/rule-promotion.json`
- 登记表（本阶段为空）：`data/roco/evidence/microcase-recordings.json`
- RC-101 的配置与影响清单：`docs/roco/RULE-CONFIG.md`、
  `reports/roco/flagship-upgrade/rc-101-rule-config.json`
- 台账检查器与等级定义：`scripts/roco/verify-evidence-ledger.mjs`、
  `scripts/roco/evidence-ledger-lib.mjs`
