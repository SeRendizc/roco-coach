# Task A — 相性口径对抗复核

日期：2026-10-17（北京时间）。付费模型调用：**0**。本任务只做 A；B/C/D 未执行。

## 判定

**A 的审计工作 verified；“规则口径已全面收口”不成立。** 指定五组测试全绿，但活动检索语料、服务回执说明和桥接旧断言仍互相冲突。没有把“测试全绿”升级成模型可靠或玩家验收结论。

最高优先级发现是 **L1 活动规则台账仍宣称双弱 ×4**，与 L3 相性文档的 ×3 同时进入索引。纯离线检索“属性倍率有哪些档位？”和“双属性双克制是几倍？”都以该旧台账为 top-1，且没有弃答；这是已经复现的检索结果，不只是代码风险猜测。

## 版本与隔离

- HEAD：`b2ccfb8c07e57c333c86534c9f8c77f74f2620dd`，分支 `interview/2026-10-17`；`a52c1dfd` 在父链内。完整起点见 `source-manifest.json`、`logs/git-start.txt`。
- **H** 表示该 HEAD 的冻结代码；**W** 表示 `latest-working-manifest.json` 所记录的未提交相关文件覆盖层。表内 `file:line` 均标明适用版本。
- 起点就已有 DS 的 `service.py` 修改：修掉名单弱点汇总的相乘及旧相性自检。不能算作本轮 Codex 修复，也不能冒称已提交。
- 审计期间 DS 又修改 `rag-index.js`、`effects.py` 等文件。额外冻结 `snapshots/latest-overlay/` 并复跑相关测试；未覆盖共享源码。
- `snapshots/head/` 是复现沙盒：变异源码已恢复为 H；其中额外保留本次新增测试文件。W 原文分别保存在 `snapshots/service-working.py`、`snapshots/latest-overlay/`。不要把整个沙盒当新分支推送。
- 全程未请求 8765/8910、未启停其进程、未读 Keychain/凭证文件、未读 CV、未提交/推送。独立桥接测试只起停其自有临时 Python 子进程和随机端口。

## 新发现与影响

### A1 / 高：活动 RAG 规则仍返回已退役的 4×

- 位置：`data/roco/evidence/rule-evidence-ledger.json:552`，`src/coach/rag-index.js:398`（`ledgerBody`）、`:650`（入库，H/W）。
- `EV-TYPE-MULTIPLIER` 的 **当前 claim** 仍是“双属性按两系相乘——双克制 ×4”，证据等级仍标 `RECORDED_IN_GAME`；不只是历史注释。L3 的 `type_chart::翼系|水系` 同时写“电系 ×3”。
- `searchIndex` 对“属性倍率有哪些档位？”、“双属性双克制是几倍？”两条自然问句均返回旧 claim，`abstained=false`，top-1 为 `EV-TYPE-MULTIPLIER`。
- H 与最新 W 均复现。证据：`logs/head-rag-sources.log`、`logs/latest-working-rag-sources.log`；新增检索闸门 `check-active-rule-claim.mjs` 在二者下均 exit 1（`logs/*active-ledger*.log`）。
- 判定：**verified，未修复**。没有真实模型调用，因此不声称模型已经照着旧 claim 作答。
- 建议：同步活动 claim、gold M07 与派生先验；历史正文/旧原话继续留档，但应与默认提供模型的当前规则分离。仅把 claim 中 4 替换成 3，还会留下 `ledgerBody()` 无条件拼接的旧 notes/source quotes，仍可能给模型相反指令。

### A2 / 高：服务回执的文字仍解释成相乘

- W `roco/src/roco_env/service.py:1705`：`weakness_summary.multiplier_rule` 仍称“双属性按两系相乘……同一套乘法”。
- W `roco/src/roco_env/service.py:2009`：`type_row.note` 仍称“结算……双属性按两系相乘”。同一条 `type_row` 的 weak 数据却有电系 ×3。
- 证据：`logs/working-service-sources.log`。这两句会进入真实工具回执，不能按“只剩代码注释”忽略。
- 新增契约测试在 H 为 **4 红 / 4**；DS 的既有 W 修复后 **2 红 / 4**；叠加本轮只改活动回执文案的补丁后 **20/20**（4 新 + 16 原有），原始日志见 `logs/new-contract-*.log`。
- 补丁：`patches/001-service-regression-tests.patch`、`patches/002-service-active-text.patch`。002 基于捕获的 DS W，不包含也不重复 DS 对名单算术/自检的改动；旧返回文案保留在明确标退役的注释里。
- 判定：**verified（隔离补丁绿），共享源码未应用**。

### A3 / 中：桥接契约仍钉 4×，不能只说全套只剩 tier 旧红

- H/W `tests/evals/roco/bridge.test.js:441`，尤其 `:454`：仍要求 `multiplier===4`、`snapshot_agrees===false`、`combination_rule==='multiply'`。
- 单独执行该桥接测试实际 exit 1：**actual 3 / expected 4**；这是旧测试与已经采纳的 2026-10-17 规则冲突。它是否早于本次修复就红，本轮没有建立旧主干运行基线，不能自动归为 pre-existing。
- 提案 `patches/003-bridge-ruling-proposal.patch` 把钉改为 3/true/snapshot_row，并保留旧断言历史；本轮隔离运行 **1/1 绿**。引擎再退回相乘时，同一条新钉 **4 !== 3，必红**。
- 证据：`logs/bridge-current-contract.log`、`logs/bridge-proposed-green.log`、`logs/bridge-proposed-mutant-red.log`。
- 判定：**verified；改钉提案待 DS 整合及金标送审**。没有删测试或放宽相乘的正确性断言。

### A4 / 中：等级词守卫仍不绑定“哪个对象的哪个倍率”

- H/W `src/coach/runtime.js:4865` 起把所有证据里的倍率收进一个集合，再检查正文倍率是否属于集合。
- 固定错误正文“电系打翠顶夫人是 2 倍伤害”：只有该目标的 ×3 回执时 `valid=false`；再加另一条“翼系受电 ×2”的无关回执后 `valid=true`。
- 证据：`probe-mixed-evidence.mjs`、`logs/guard-mixed-evidence.log`。原 7/7 是窄守卫测试，不能证明多证据下的主语/攻击属性/防御组合绑定正确。
- 判定：**verified（离线反例），本轮未修复**。建议后续按 `(ruleset, attack_element, defender_types)` 绑定结构化事实后校验，不靠数字集合证明整句正确。

### A5 / 中：先验、金标与源码说明还保留活动旧口径

- `scripts/roco/meta-prior-lib.mjs:1046` 仍生成双弱 ×4 的 claim；`data/roco/meta-prior/v1.json:22` 等多个位置已带旧 claim。修派生 JSON 而不修生成器会再次覆盖。
- `data/roco/rag/heldout-queries.json:340` 的 M07 查询“属性倍率一共有哪几档”，其 `derived_from.anchors` 仍含 `×4`（约 `:353`），why 仍认相乘。它会奖励检索到错误的活动说法。
- `roco/src/roco_env/data.py:157`、`:192`、`:224`、`:563`；`service.py:78`、`:1524`；`opponents.py:347` 仍有把相乘描述为“现在”的源码说明。它们不代表另一份运行算术，但会误导后续修改与面试走查。
- 判定：**verified（静态内容）；所有派生产物消费者的运行影响未穷尽**。本轮未自动改规则台账或重建金标；送审清单见 `gold-review-request.md`。

## 逐处算术/口径台账

“数据同源”表示读同一冻结 `types.json` 或其受哈希校验的派生件；**不等于调用同一个函数**。不能在面试里把这两件事混为一谈。

| 位置（H/W） | 现状 | 与 TypeChart.multiplier 的关系 | 证据 / 判定 |
|---|---|---|---|
| `roco/src/roco_env/data.py:188` | 双属性读显式快照行；缺 67 个组合抛异常 | Python 结算函数本体 | `head-python.log`；verified |
| `roco/src/roco_env/effects.py:471` | 伤害结算直接调 chart | 同一实现 | 源码调用；引擎变异导致 Bad Case 红；verified |
| `roco/src/roco_env/team.py:114` | 按 chart 选弱点 | 同一实现 | 源码调用；verified（静态） |
| `roco/src/roco_env/opponents.py:358` | 对手策略直接调 chart；旧 docstring 未改 | 同一实现，说明 stale | 源码调用；verified/stale |
| `roco/src/roco_env/planner.py:326`、`:329`、`:379` | 计划评分/换宠查 chart | 同一实现 | 源码调用；verified（静态） |
| `service.py` H`:2071` / W`:2072` | 双属性 `type_multiplier` 委托 chart；回执 `snapshot_value` 只用于对账 | 同一实现；对账数值数据同源 | 原服务读口测试、引擎变异读口红；verified |
| `service.py` H/W`:2047`、约`:2100` | 单属性分支直接读 chart.rows / 原始行；缺项中性 | 数据同源，未调用 multiplier | 单属性逐格、offense 读口测试；verified |
| `service.py` H`:1684` / W`:1687` | **H 的第五份独立相乘仍在；W 已由 DS 委托 chart** | H 否；W 同一实现 | 注入全中性 chart 时 H 仍报弱点、W 返回空；verified |
| `service.py` H`:2124` / W`:2129` | H 自检仍称相乘为现口径；W 是当前引擎对快照 0 差异，旧 41 格独立留痕 | W 调 chart；legacy 乘法只作历史对照 | `head/working-service-sources.log`；verified |
| `service.py` H`:2116` / W`:2117` `_single_multiplier` | H 被名单汇总调用；W 留下定义但无调用 | W 非活动算术；注释称 legacy 使用它也不准确，legacy 实际用局部 snap | 全仓调用检索；verified（静态） |
| `data.py:220` `fallback_multiplier` | 仍按两系相乘 | 不属于现行 multiplier；本仓非 raw 调用仅测试中的 legacy 反证 | grep + `test_type_multiplier_ruling.py:150`；verified（静态） |
| `src/coach/rag-index.js:505` `typeChartBody` | H 已读快照但残留死代码；W 已清死代码 | **数据同源，独立 JS 投影**，不调 Python | RAG 11/11；RAG 相乘变异 3 红；verified |
| `src/client/type-affinity.data.js:19` | 标注冻结源哈希；双弱标度 12（÷4=3） | 数据同源的生成件 | 客户端逐字节再生成和 2160 格测试；verified |
| `scripts/roco/build-client-type-affinity.mjs:47` | 只把倍率乘 4 转为整数标度 | 数据同源；**不是双属性相乘** | 客户端生成一致性测试；verified |
| `src/client/type-affinity.js:72`、`:98` | 查组合表，÷4；未知组合空；对多个攻击系取最坏格而非相乘 | 数据同源，独立展示投影 | 客户端 7/7；verified |
| `src/coach/team-gaps.js:370`、`:440` | raw 弱抗项转标度，按组合查表 | 数据同源；不是 Python 同一实现 | 源码；未新跑其全套下游，verified（静态） |
| `src/coach/opponent-belief.mjs:1422` | 复用 gap 索引 scaleByCombo | 复用 JS 表，不调 Python | 源码；verified（静态） |
| `src/game/engine.js:109` | 自研 camp 单属性 1.5/0.75 | **不同规则，不同实现** | 源码及 L3 注册表 RETIRE 钉；不能冒充洛克真源；verified |
| `src/coach/strategist.js:212`、`scripts/build-knowledge.js:8` | 自研 camp 消费 TYPE_ADVANTAGES | camp 同源；与洛克隔离仍需 B | 源码；跨上下文实际输出本轮 unverified |
| `src/coach/runtime.js:1520` | 相性教学消费 type_row 回执 | 消费服务数据，非新增算术 | 静态走查；verified（静态） |
| `src/coach/runtime.js:4865` | 守卫收集所有 evidence 的倍率集合 | 无对象绑定，不是相性计算器 | mixed-evidence 反例；verified |
| `data/roco/evidence/rule-evidence-ledger.json:552` | L1 活动 claim 仍认 4 | **不同口径**，直接入 RAG | 两条自然问句均命中旧 claim；verified |
| `scripts/roco/meta-prior-lib.mjs:1046` / `data/roco/meta-prior/v1.json:22` | 生成器及先验复制旧 claim | **不同口径**；不能只重建不改源 | grep；verified（静态） |
| `data/roco/rag/heldout-queries.json:340` M07 | 当前 golden anchor 仍为 ×4 | **旧判据** | 静态 gold；verified/stale |
| `tests/evals/roco/bridge.test.js:441` | 当前断言 4，与服务实际 3 相反 | **旧判据** | 单条桥接实际红；改钉提案及变异已跑；verified/stale |
| `roco/tests/test_type_multiplier_ruling.py:117`、`:139` / RAG 测试旧乘法 helper | 乘法仅用于刻意反证 | 不应删除的历史算术 | 41 格旧账及外部变异日志；verified |
| `data/roco/raw/extracted/rocom-data/sim/damage_calc.py:94` | 上游另有双弱特判 3，其余相乘 | **另一实现**；本仓运行结算不调用它 | raw 本地源码，非外部独立证实；verified（静态） |
| `data/roco/raw/extracted/rocom-data/sim/strategy.py:64` / `NRC_AI/src/models.py:90` | 上游策略还会按单属性相乘；另有单属性表实现 | 原始参考代码，不属于 roco_env 结算链 | 扩展 effectiveness 检索；verified（静态） |
| `parse.py:1108`、`:1372`；`rule_config.py:784`；`effects.py:82` | 连击、技能能耗/威力、总伤害乘区等 | **不是属性组合算术** | 分类排除，未误判为第五处；verified（静态） |

除 H 的名单汇总外，**在上述已检查的洛克活动运行链中未再找到一份按单属性相乘的双属性实现**。这不是全仓数学等价证明；保留 raw 参考实现、历史对账算术及 camp 的独立规则是必要的。当前真正影响 Agent 的剩余问题包括 A1/A2 的活动文本冲突。

## 反证与测试读数

| 实验 | 结果 | 日志 / 判定 |
|---|---|---|
| H 指定两个 Python 模块 | 16/16，exit 0 | `logs/head-python.log`，verified |
| H 指定三个 Node 文件 | 21/21 = 11+7+3，exit 0 | `logs/head-node.log`，verified |
| W 两个 Python 模块 | 16/16，exit 0 | `logs/latest-working-python.log`，verified |
| W 三个 Node 文件 + 客户端 | 28/28 = 11+7+3+7，exit 0 | `logs/latest-working-node.log`，verified |
| 引擎源文件双属性 return 实际改回 `fallback_multiplier` | 16 中 6 红，exit 1 | `logs/mutant-engine-python.log`，verified（预期红） |
| 恢复引擎源文件 | 16/16，exit 0 | `logs/restored-python.log`，verified |
| RAG 源函数实际改回按两系相乘 | 11 中 3 红，exit 1 | `logs/mutant-rag-node.log`，verified（预期红） |
| 恢复 RAG 源文件 | 21/21，exit 0 | `logs/restored-node.log`，verified |
| 原桥接断言 | 1 中 1 红，3 !== 4 | `logs/bridge-current-contract.log`，verified（旧钉红） |
| 桥接改钉提案 | 1/1，exit 0；引擎再退回相乘则 1 红 | `logs/bridge-proposed-*.log`，verified |
| 新服务契约 | H 4 红 → DS W 2 红 → 文案补丁叠加后 20/20 | `logs/new-contract-*.log`，verified |
| 活动规则检索 gate | H/W 均 2 个自然问句命中旧 4× claim，exit 1 | `logs/*active-ledger*.log`，verified（问题未修） |
| 混合证据守卫 | 单回执拒绝；加入无关 ×2 后放行相同错句 | `logs/guard-mixed-evidence.log`，verified（问题未修） |

引擎改回相乘，实际红的 6 条：

1. `DoubleTypeSnapshotTest.test_dual_types_follow_the_snapshot_row`
2. `DoubleTypeSnapshotTest.test_reverting_to_multiply_makes_the_snapshot_check_red`
3. `ScarlettTypeBadCaseTest.test_electric_vs_wing_water_is_three`
4. `ScarlettTypeBadCaseTest.test_fire_vs_bug_grass_is_three`
5. `ScarlettTypeBadCaseTest.test_no_dual_type_ever_reports_four`
6. `ServiceTypeMultiplierReadTest.test_read_returns_snapshot_tier_three`

RAG 改回相乘，实际红：判据③档位、判据②补双属性逐格、判据④语料 0 差异。变异补丁在 `patches/mutant-*.diff`，**不得作为修复整合**。

名单汇总目前只判断 `>1`：3→4 不改变公开计数，因此原测试不红完全可能。新契约采用“已装载 chart 全中性 → 汇总必须无弱点”的反例，H 红、DS W 绿，才证明此消费者依赖已装载引擎事实；不能把这种结构收口讲成已修复一次对玩家计数的可见错误。

## 命令原文与复现

完整命令、cwd、去凭证后的测试环境、退出码、耗时：`commands.jsonl`；便于查看的逐条原文见 `commands.md`。所有测试子进程只继承 PATH/语言设置，固定 `ROCO_LOCAL_MODEL=off`、`PYTHONDONTWRITEBYTECODE=1`；没有复制模型 key 配置。

核心指定命令（在冻结副本执行；等价于用户给定命令）：

```bash
# cwd: <audit>/snapshots/head/roco
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
# cwd: <audit>/snapshots/head
node --test tests/roco-rag-typechart.test.js tests/roco-scarlett-tier-grounding.test.js tests/roco-type-multiplier-ask.test.js
```

已有快照基线可用 `python3 audit_runner.py` 重跑；探针均接受一个快照根路径参数。变异实验必须先在隔离副本应用相应 `mutant-*.diff`，复跑同一组测试，并在 finally/trap 中恢复；不要在 DS 分支源码上实验。

全仓检索用 `rg --hidden --no-ignore`，包括忽略的 raw，排除 Git/依赖/output/CV/凭证；单行超过 600 字只保留前 600 字及省略标记，准确命中行号保留。另补查 `get_type_effectiveness`/`scaleByCombo` 等异名；不能认为只搜 `multiplier` 就穷尽了相性算术。日志见 `logs/grep-*.log`。

## 建议交给 Lead/DS 的动作

1. 先处理 A1：活动规则台账 + 历史检索隔离 + M07 + 先验生成器/派生件一起送审；以两条自然问句不再返回活动 4× claim 为最低验收，不删弱旧反证。
2. DS 现有 W 基础上审阅 001/002；003 作为 2026-10-17 改钉提案一并送审。三份 patch 均通过指定基底 dry-run。新测试补丁的 dry-run 用 reverse 检查（沙盒已添加该文件）。
3. 修后独立复跑 A，再进入 B。守卫对象绑定作为后续窄回归，不增加付费模型采样。
4. 面试安全说法：“Python 结算与双属性服务读口共用 TypeChart；RAG/客户端通过同一冻结数据及派生校验对齐。离线对抗审计又发现活动台账和回执说明仍落后，正在收口。”不要说“所有层只有同一份实现”或“有证据就能保证每句语义正确”。
5. 对本人能力的最小练习：解释为什么 3→4 不改变名单弱点计数，以及为什么无关的 ×2 回执会放过错误正文。能定位、构造反例、解释补丁边界，才算掌握这段代码。

## 尚未验证的边界

- `test:unit` 全量、`test:env` 全量及历史失败集合本轮未复跑；交接中的 2094/2079/14/1、仅 tier 旧红等属于历史记录，本轮不背书。
- 未验证真实模型是否消费旧语料、camp 跨规则的真实回答、浏览器逐屏行为或任何在线服务的当前状态。
- 本轮以仓库已采纳的 2026-10-17 规则为审计基准，未重新联网核验官方采访、规则更新日期或外部来源权威级别。raw 本地副本不能作为官方事实的独立当前证明。
- 补丁局部红绿不是整合后全套回归；DS 源码仍在变化，最终提交 SHA 必须另行独立验收。

最终封存核对：HEAD 仍为 `b2ccfb8c07e57c333c86534c9f8c77f74f2620dd`；`a52c1dfd` 父链核对 exit 0；最新覆盖层所列相关文件与共享源码的哈希仍一致（漂移 0 文件）。最终状态见 `final-verification.json`。
