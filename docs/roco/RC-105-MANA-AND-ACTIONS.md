# 合法行动裁剪与魔力（心）结算（RC-105）

> 一句话：**标准 PVP 能做什么、还剩几点魔力，现在由 `data/roco/rulesets/*.json` 说了算。**
> 新增的候选配置 `mobile_s4_candidate_v3.json` 声明了 `mana`（4 点魔力 / 力竭扣 1 / 归零判负 /
> 允许投降）与 `actions`（合法动作类只有 `skill → charge → switch → surrender`，禁 `item`/`escape`），
> 引擎按它裁剪合法动作、按它结算胜负；**legacy 默认路径一个比特都没变**。
>
> 机器可读报告：`reports/roco/rc105/mode-actions-and-mana.json`（由
> `scripts/roco/report-rc105-mana-actions.py` 现场生成，含三条反证的**实际报错原文**）。

覆盖面：`mana.pool` / `mana.faint_cost` / `mana.loss_when_zero` / `mana.surrender` /
`actions.allowed_kinds` / `actions.forbidden_kinds` / `actions.unknown_kinds_allowed` /
`actions.kinds.*`；引擎侧的 `legal_actions` 裁剪、`Action` 新动作类、力竭扣魔力与归零判负。
能量与时序仍见 `docs/roco/RULE-CONFIG.md`（RC-101）与 `docs/roco/TURN-ORDER.md`（RC-103）。

## 1. 变更清单（只动引擎与规则配置）

| 文件 | 改了什么 |
| --- | --- |
| `data/roco/rulesets/mobile-s4-candidate-v3.json` | **新增**候选配置：沿用 v2 的 `energy`/`turn_order`（逐字复制），新增 `mana` 与 `actions` |
| `scripts/roco/build-rule-configs.mjs` | 生成第三份配置；新增 `mana`/`actions` 的落盘前校验（与 Python 侧并行判据） |
| `roco/src/roco_env/rule_config.py` | `mana.*` / `actions.*` 的加载期校验（**白名单**：只有 v3 必填）；`RuleConfig` 新字段与 `has_mana`/`has_actions` |
| `roco/src/roco_env/schema.py` | 新增 `ACTION_CHARGE` / `ACTION_SURRENDER`；`Action` 构造期必需字段校验；`SideState.mana`（`None` = 没有这条概念） |
| `roco/src/roco_env/env.py` | 按 `actions` 裁剪合法动作；聚能/投降的结算；力竭扣魔力与归零判负；mana 进序列化/观察/两个公开视图 |
| `roco/tests/test_mana_actions.py` | **新增** 29 条 Python 判据（每条带必红方向） |
| `tests/roco-mana-actions.test.js` | **新增** 6 条 Node 契约判据；已加进 `package.json` 的 `test:unit` 手写清单 |
| `tests/roco-rule-config.test.js` | 配置集合的「恰好等于」断言从 2 份改成 3 份（新增配置必须有人解释） |
| `tests/roco-team-request.test.js` | 同上：注册表（`rulesets/*.json`）的「恰好等于」断言改成 3 份 |
| `reports/roco/rag/rag-eval.json` | **重新生成**（RAG 语料把每份规则配置当文档：1678 → 1710 篇，13 条闸门仍全绿） |
| `reports/roco/flagship-upgrade/rc-301-team-request.json`、`rc-302-team-gaps.json` | **重新生成**（注册表 / `rulesetCaps` 多了一行） |
| `scripts/roco/report-rc105-mana-actions.py` | **新增**：现场生成机器可读报告（含三条反证的原文） |
| `roco/tests/test_rule_config.py` | 「加载器源码 < 40000 字符」的上限上调到 46000，**同时加强**了精确的内联常量判据（见 §8） |

## 2. 哪些是**台账支持**的

台账条目一个字都没改，等级也没有升降（`data/roco/evidence/rule-evidence-ledger.json` 的 sha256
仍是 `aefd634a8bafec79…`，这就是配置里 `derived_from_ledger_sha256` 的值）。

| 配置字段 | 值 | confidence | evidence_id | microcase | 台账说了什么 |
| --- | --- | --- | --- | --- | --- |
| `battle_mode.team_size` | 6 | `CROSS_SOURCE_SUPPORTED` | `EV-PVP-STANDARD-TEAM-SIZE` | `MC-E07` 未录制 | 标准 PVP 六宠：交叉支持，**不是**官方原文 |
| `mana.pool` | 4 | `CROSS_SOURCE_SUPPORTED` | `EV-PVP-STANDARD-MANA` | `MC-E08` 未录制 | 「通常 4 点魔力」；台账自注**这条降级风险最高**（两份来源里没有一处逐字写出 4 点） |
| `mana.faint_cost` | 1 | `CROSS_SOURCE_SUPPORTED` | `EV-PVP-FAINT-MANA-LOSS` | `MC-E09` 未录制 | 「力竭通常扣 1 点魔力」；只有 17173 的「额外损失1点魔力」间接支持 |
| `mana.loss_when_zero` | true | `CROSS_SOURCE_SUPPORTED` | `EV-PVP-FAINT-MANA-LOSS` | `MC-E09` 未录制 | 同一台账条目的 claim：「目标是先让对方魔力归零，而不是默认打光整队」 |
| `actions.kinds.charge` | allowed | `CROSS_SOURCE_SUPPORTED` | `EV-ENERGY-CHARGE` | `MC-E02` 未录制 | 「聚能是一个主动行动，回复 5」→ 支持「聚能是独立动作类」 |

引台账的字段全部标了 `value_status: CANDIDATE_HYPOTHESIS`（引用了「待实机验证」的条目却带具体值时的
硬要求）；**没有任何字段被升到 `OFFICIAL_CURRENT` / `RECORDED_IN_GAME`**。

## 3. 哪些是 **ENGINE_HYPOTHESIS**（台账里**没有**支撑）

| 配置字段 | 值 | 为什么只能这么写 |
| --- | --- | --- |
| `mana.surrender` | true | 「投降算不算判负的独立动作、是否扣魔力、是否消耗回合」**台账里没有任何条目**；这里只登记「本候选把投降列为合法动作类」这一实现选择 |
| `actions.allowed_kinds` | 四类 | 台账只支持其中「聚能是主动行动」这一点；「标准 PVP 的动作全集就这四类」是从模式口径推出来的引擎策略 |
| `actions.forbidden_kinds` | item / escape | 「标准 PVP 无道具与逃跑；仅当某 PVE 模式登记允许时才出现」——同上，是策略不是引文 |
| `actions.kinds.skill` / `.switch` | allowed | 引擎一直在结算这两类，但台账没有「它们是合法动作」的条目 → 如实标成实现现状 |
| `actions.kinds.item` / `.escape` | forbidden | 同上，从模式口径推出的策略 |
| `actions.unknown_kinds_allowed` | false | **引擎纪律开关**：约束的是我们自己的实现，不是手游行为 |

引擎侧对应的诚实登记：`state.unsupported` 里会留下
「聚能与能量上限的先后顺序（MC-E02 未录制）」「投降的结算语义（无台账条目）」「双方同时归零」
三类记录 —— 不知道就写下来，不假装知道。

## 4. 仓内原文佐证：冻结快照里的 6 条「魔力」文本

这是**唯一**来自游戏内文本的魔力语义线索。扫描口径：正则 `魔力` 扫
`data/roco/normalized/roco-world-s4-2026-09-10/skills.json` 的 `desc`，**恰好 6 条，全是特性**：

| skill_id | 名称 | desc 原文（逐字） |
| --- | --- | --- |
| `skill_000007` | 诈死 | 自己力竭时，少损失1点魔力。 |
| `skill_000060` | 付给恶魔的赎价 | 击败敌方精灵时，敌方额外损失1点魔力。被敌方精灵击败时，自己额外损失1点魔力。 |
| `skill_000113` | 飓风 | 对本精灵的技能，若其他翼系精灵携带相同技能，则获得迅捷。被敌方精灵击败时，自己额外损失1点魔力。 |
| `skill_000142` | 图书守卫者 | 入场时，若自己魔力值为1，自己获得双攻+100%。 |
| `skill_000143` | 构装契约者 | 入场时，若敌方魔力值为1，自己获得双防+100%。 |
| `skill_000226` | 御驾亲征 | 棋契陛下大幅提升种族资质，力竭时扣除4魔力。 |

同一段「诈死」文本也挂在 `roster-48.json` 的可用精灵上（`pet_000243 卡卡虫` / `pet_000240 丢丢`）；
`history.json` 里 `pets.pet_000475` 的历史改动把加成从 +50% 改成 +100%，**没有改**「魔力值为 1」这个条件。

**三条推论 + 它们的局限**

1. **力竭默认扣魔力，且默认是 1 点** ——「诈死：少损失1点」「付给恶魔的赎价 / 飓风：**额外**损失1点」
   只有在「默认扣减存在且为 1」时才有意义 ⇒ 支持 `mana.faint_cost = 1`。
2. **魔力是小整数池，且「4」在游戏文本里逐字出现过** —— 御驾亲征「力竭时扣除4魔力」（一次扣掉相当于
   整个候选池子的量）、图书守卫者/构装契约者以「魔力值为 1」为条件（说明魔力会走到 1）⇒ 支持
   `mana.pool = 4` 的候选口径。
3. **局限（必须一起读）**：这 6 条全部来自**社区 wiki 快照**，等级仍是 `CROSS_SOURCE_SUPPORTED`；
   它们**只有一份来源**，不满足台账「两条不同 URL 来源」的入库门槛，所以本活
   **没有新增台账条目、也没有升级任何等级**，只把它们登记成配置里的 `repo_internal_evidence`
   （并有一条测试逐字核对引文真的在冻结快照里）。
   另外御驾亲征讲的是「棋契陛下」首领/棋契形态，把它的 4 点当成**标准 PVP 的默认值**是不成立的 ——
   它只是「4 这个数在魔力语境里真实存在」的旁证。
4. `skills.json` 里另有 4 条只在 `flavor`（世界观文案）里出现「魔力」（`skill_000262` / `000460` /
   `000748` / `000781`），那是叙事文本，**不**作为规则证据。

## 5. MC-E07 / E08 / E09 未录制意味着什么

* 台账里那三条的等级是 `CROSS_SOURCE_SUPPORTED`（交叉支持），**不是**官方原文；8 号 microcase
  一条都没录，所以 v3 的 `promotion_policy` 是 `BLOCKED_UNTIL_MICROCASE`、`is_default: false`、
  `requires_microcase_before_default: true`。
* **任何对外文案都不许把它写成「官方已确认」**：4 点魔力、力竭 -1、六宠都仍是候选口径。
  `promotion` 要走 RC-102 的 gate（`scripts/roco/evaluate-rule-promotion.mjs`），而 gate 的输入
  `data/roco/evidence/microcase-recordings.json` 现在是空数组 —— 所以不可能有字段变绿。
* 引擎侧因此把「不确定」留在数据里：引用了待验条目的字段带 `microcase_id` +
  `microcase_status: NOT_RECORDED` + `value_status: CANDIDATE_HYPOTHESIS`，谁要升级谁去录像。

## 6. legacy 为什么没变（本活**不改变任何默认行为**）

* **默认配置仍然是 `legacy_sim_v1`**（`roco/src/roco_env/rule_config.py::DEFAULT_RULE_CONFIG_ID`），
  `is_default: true`；v3 是候选，只能通过 `ROCO_RULE_CONFIG=mobile_s4_candidate_v3` 或显式参数选中。
* legacy 与 v2 **没有** `mana`、也**没有** `actions`：`mana_pool is None`、`allowed_kinds is None`
  —— `None` 不是 0。`SideState.to_dict()` 只在 `mana is not None` 时才写这个键，
  所以 legacy 的序列化里**不出现** `mana`，8 条 golden 指纹（状态 + 事件）逐位不变。
* 引擎里每一处新行为都先问配置：`cfg.has_mana` 为假就立刻返回，`cfg.allowed_kinds is None`
  就走原来那条枚举路径（legacy 是 PVE/练习局，道具与逃跑继续存在）。胜负仍按打光整队判定。
* 新字段进加载期校验的方式是**显式白名单**（`MANA_ACTIONS_CONFIG_IDS = ("mobile_s4_candidate_v3",)`）：
  把 `mana.pool` 直接塞进 `REQUIRED_PATHS` 会让 legacy 与 v2 当场加载失败（默认路径直接崩），
  或者逼人给 legacy 补一个假 0（而 0 的意思是「魔力归零、已经判负」）—— 两条都不行。

三条反证（改坏之后**真的**变红，报错原文见报告 `checks[].counter_proof` 与
`source_mutation_runs`）：

| 反证 | 怎么改坏的 | 观察到的报错 |
| --- | --- | --- |
| ① 标准 PVP 无道具 | 把 `item` 从 `forbidden_kinds` 挪进 `allowed_kinds` | `AssertionError: 'item' unexpectedly found in ['skill','skill','skill','charge','switch','switch','item','item','item','surrender']` |
| ② 力竭扣 1 | 把扣减改成 `- 0` | `AssertionError: 4 != 3 : 对手的精灵力竭 → 对手扣 1 点魔力（4 → 3）` |
| ③ legacy 逐位不变 | 给没有 mana 的一方补一个假 `mana: 0` | golden 指纹 `e6d8cc92…` != `244e53d3…`（`test_short_scripted_game_is_bit_identical`），另 3 条同类失败 |

## 7. 引擎现在的行为（失败方向也写清楚）

* **合法动作**：`legal_actions` 按 `allowed_kinds` 枚举（顺序 = 展示顺序），`forbidden_kinds`
  一律不出现；若要产出一个既不在 allowed 也不在 forbidden 的类且 `unknown_kinds_allowed=false`
  → 抛 `UnsupportedEffect`（错误信息点名动作类与配置 id）。legacy/v2 不裁剪。
* **开局魔力**：配置声明了 `mana` 时每方拿到 `mana.pool`；`mana.pool` 是 `null`（UNKNOWN）则
  `reset` 抛错，不回落到任何数。
* **力竭**：攻击分支与回合末状态伤害两处都调用同一个 `_settle_faint_mana`：那一方扣
  `mana.faint_cost`（`null` 则抛错），并写 `mana_loss` 事件；`mana.loss_when_zero` 为真且魔力 ≤ 0
  → 立即判负（双方同时归零记平局），`_advance_after_turn` **不再覆盖**这个结果。
* **聚能**：回复 `energy.charge`（`null` 则抛错），夹到 `energy.max`，并在 `state.unsupported`
  登记「能否突破上限 / 无技能时是否自动聚能」这两条未核验项。
* **投降**：按「投降方判负」处理并登记为 `ENGINE_HYPOTHESIS`（无台账条目）。
* **动作类校验**：`Action` 构造期就要求 `skill→skill_id`、`switch→target_index`、`item→item_id`；
  `charge` / `surrender` 不带字段。只在**声明了 `actions`** 的配置下才允许执行这两个新动作类，
  legacy/v2 里直接执行会抛错（没有声明就是没有这个动作）。

## 8. 没做到的部分（如实登记）

1. **六宠 vs 3v3**：v3 绑定的 `pvp-standard-six-pet` 是 `team_size: 6`，但引擎的
   `reset` / `validate_team`（以及 `service.py` 的对局入口）仍然只接受 3v3。所以「六宠模式」
   目前只体现在**模式口径**（mana / actions）上。测试里显式断言 `len(player.pets) == 3`，
   把这个差距变成被测对象；真的排六只要改多处入口，不在本活范围。
2. **v3 开不了局（重要阻断点）**：v3 的 `energy.initial` 是从 v2 **逐字复制**的 `null`
   （UNKNOWN，MC-E04 未录制），所以 `reset(config="mobile_s4_candidate_v3")` 会按 RC-101 的纪律
   fail closed。本活**没有**改 v2/v3 的 energy 值（那是纪律）。测试用
   `dataclasses.replace(cfg, energy_initial=<默认配置的入场能量>)`（**从 legacy 配置读**，不在测试里写死
   字面量）的**显式夹具**把对局开起来，并在测试 docstring 里写明这一点。要让候选真能开局，需要先录 MC-E04，或由产品显式给一个占位入场能量。
3. **Node 桥 / 客户端契约没有为 mana 增加显式字段**：`service.py` 的 `_sim_envelope` 直接转发
   `serialize(state)`、`public_planner_state`、`ui_public_view`，所以本地对局域的回执里**已经**有
   `state.*.mana` 与 `public.mana`（Python 侧三处都带上了）；但**没有任何 JS 代码读它**，
   页面也不会显示「还剩几点魔力」。最小改动建议（留给客户端同事）：
   ① `src/client/roco.js` 渲染 `ui.mana`（缺键时整个元素不渲染，**不要**显示 0）；
   ② `src/coach/team-gaps.js` 的 `cost.mana_rule` 里写死的 `mana_per_side: 4` 改成读
   `data/roco/rulesets/mobile-s4-candidate-v3.json` 的 `mana.pool.value`；
   ③ 要让 PVP 模式真正走 v3 口径，需要 `battle-modes.json` 的 `ruleset_binding` 决策（主线程的事）。
4. **`events_text.py` 没有新事件的中文模板**：`charge` / `mana_loss` / `surrender` 会落到诚实兜底句。
   legacy 对局产不出这些 kind，所以既有事件覆盖面测试仍然全绿；最小改动建议是加三个模板 +
   把 `KNOWN_EVENT_KINDS` / `SAMPLE_EVENTS` 一起补上，并让取样对局覆盖一份声明 mana 的配置
   （否则「登记了但没测过」那条判据会红）。
5. **特性对魔力的改写没有实现**：诈死（少损失1点）、付给恶魔的赎价 / 飓风（额外损失1点）、
   御驾亲征（力竭时扣除4魔力）都只是**登记在案的证据**，`traits.py` 里没有对应实现。
6. **新增一份规则配置会牵动三份生成产物**：RAG 语料把 `data/roco/rulesets/*.json` 当文档，
   所以 `reports/roco/rag/rag-eval.json` 从 1678 篇变成 1710 篇（报告 diff 约 1000 行，BM25 排序随语料变化；
   13 条闸门仍全部通过），`rc-301` / `rc-302` 两份报告也各多一行。三份都按它们自己的机制重新生成了
   （`--write` / `RC301_WRITE_REPORT=1` / `RC302_WRITE_REPORT=1`）。如果主线程不想让 RAG 语料吸收
   规则配置，应该改 `src/coach/rag-index.js` 的语料口径（客户端同事的模块，不在本活范围），
   而不是让产物与重算长期不一致。
7. **`test_rule_config.py` 的加载器体积上限被上调**（40000 → 46000 字符）：那是「加载器别长成
   第二份事实源」的**粗粒度代理**；RC-105 给它加了两组加载期校验（纯声明式判断，没有内联任何规则值），
   文件从 ~29.7k 长到 ~42k 字符。同时**加强**了精确判据：新增正则断言
   `mana_pool` / `mana_faint_cost` / `mana_loss_when_zero` / `mana_surrender` /
   `unknown_kinds_allowed` 都没有被内联成字面量。精确判据管内容，体积上限只管规模。

## 9. 怎么跑 / 怎么复现

```bash
npm run test:env                     # Python：324 条通过（原 295 + RC-105 的 29），OK（skipped=1）
npm run test:unit                    # Node：935 条通过 / 0 失败（含 tests/roco-mana-actions.test.js）
node scripts/roco/build-rule-configs.mjs --check     # 三份配置与台账/生成逻辑一致
node scripts/roco/build-rule-configs.mjs --selftest  # 18/18（含 5 条 RC-105 反证）
cd roco && PYTHONPATH=src python3 -m roco_env.rule_config   # 配置自检（含 RC-105 的 4 条反证）
python3 scripts/roco/report-rc105-mana-actions.py    # 重新生成机器可读报告
```

只关心本活的判据时：

```bash
cd roco && PYTHONPATH=src python3 -m unittest tests.test_mana_actions -v
node --test tests/roco-mana-actions.test.js
```
