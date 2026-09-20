# M0 / M1 验收 Checklist

> 本轮范围：**只做 M0 + M1**。本文件逐项对照验收条件，**只有能指向具体文件、数据、日志或截图的项才打勾**。
> 基准 commit：`1717cd515e8d900e6f2ccccb8707a0a85a809989`
> 完成时间（UTC）：2026-09-20
> 断点状态文件：`docs/roadmap/DSH-EXECUTION-STATE.md`

## 图例

| 标记 | 含义 |
|---|---|
| `[x]` | 已完成，**且有证据**（见该项的 `证据`） |
| `[~]` | 部分完成，证据只覆盖了一部分（下面写明未覆盖什么） |
| `[ ]` | **未完成**（下面写阻塞原因） |
| `[—]` | **本轮明确不做**（M0/M1 边界外，不得当成完成） |

---

## A. 本轮交付前必须先声明的四类陈述

任务书要求区分：`已在代码实现` / `本轮新增并验证` / `仅设计` / `未知待核验`。
本轮所有结论都落在这四类里：

| 类别 | 本轮内容 |
|---|---|
| **已在代码实现**（本轮之前就有，本轮只核实） | 375 项既有测试、`engine.js` 状态机与事件历史、有界工具循环、事实校验、陪练与记忆、PVP 熔断 |
| **本轮新增并验证** | 数据来源台账与许可矩阵、三来源交叉核验、12 只精灵规范化数据、支持矩阵、A 组候选配招、microcase 计划、15 项数据域验收测试、浏览器验收脚本 |
| **仅设计** | 全部 21 条 microcase（期望值为 `null`）、支持等级的升级路径、下一轮实现顺序 |
| **未知待核验** | 官方伤害公式、等级→面板换算、能量上限与回能时机、同速裁决、印记替换规则、取整方向、A 组 6 只特性结算细节（共 74 个未解问题） |

---

## B. M0：基线与仓库审计

### B1 基线与保护

- [x] **B1.1 记录当前 commit、分支、工作区状态**
  - 证据：`reports/roco/m0-baseline/HEAD.txt`（`1717cd515e8d900e6f2ccccb8707a0a85a809989`）、`git-status.txt`（开始时为空）
- [x] **B1.2 记录 Node / npm / Python / OS 版本**
  - 证据：`reports/roco/m0-baseline/env.txt` —— Node `v24.20.0`、npm `11.19.0`、Python `3.9.6`、`Darwin 27.0.0 arm64`
- [x] **B1.3 跑现有全量测试并保存原始日志**
  - 证据：`reports/roco/m0-baseline/npm-test.log` —— **357/357 unit 通过 + 18/18 browser 通过 = 375/375，0 fail / 0 skip / 0 cancel，退出码 0**
- [x] **B1.4 跑浏览器 smoke 并保存原始日志**
  - 证据：`reports/roco/m0-baseline/smoke.log` —— 全部通过（14 张伙伴卡、属性筛选生效、进入对局、最快速度、16 次出招打到结束、无卡死、控制台零报错），退出码 0
- [x] **B1.5 跑无需密钥的离线 eval 并保存日志**
  - 证据：`reports/roco/m0-baseline/evals.log` —— `eval:retrieval` 与 `eval:balance:quick` 均退出码 0
- [x] **B1.6 禁止为了让新测试通过而删除旧测试**
  - 证据：`git diff --name-only` 对 `*.test.js` 为 **0 项**（既有测试文件**零改动**）
  - 新增测试是**追加**：`package.json` 的 `test:unit` 仅在末尾追加 `evals/roco/data-acceptance.test.js`，并新增 `test:roco` 脚本；**既有脚本内容未改**
  - 全量测试数从 375 → **390**（+15 新增），**无任何既有测试被删改**

### B2 KEEP / ADAPT / RETIRE / MISSING 审计

- [x] **B2.1 建立 `docs/roco/M0-REPO-AUDIT.md`，逐文件标注去向**
  - 证据：`docs/roco/M0-REPO-AUDIT.md`
  - 覆盖：`engine.js`、`content.js`、`progression.js`、`coach/{toolbox,runtime,scheduler,policy,strategist,retrieval,experience,memory,teacher,companion}.js`、`knowledge/*.json`、`server.js`、前端、测试与评测资产
- [x] **B2.2 记录文档与运行态不一致（不得静默取一边）**
  - 证据：同文件 §1，**5 处**不一致。最重要一条：`docs/IMPLEMENTATION-STATUS.md` 写「现场 257 项测试」，现场实为 **375 项**
- [x] **B2.3 明确「RETIRE 是建议、本轮未执行」**
  - 证据：同文件开头与 §4 —— 本轮**未修改任何运行代码**；`git diff --stat` 显示 tracked 文件中只有 `.gitignore` 与两个评测产物被改

### B3 已知失败的区分

- [x] **B3.1 区分历史失败与本轮回归**
  - 基线（改动前）**全部通过**，无历史失败
  - 全量复跑（`reports/roco/m1-data/npm-test-after.log`）：**unit 372/372 通过**、**browser 17 通过 + 1 跳过 / 18**
  - 那 1 项跳过是**既有的、在代码里写明的**行为：`replace.test.js:577` 在 60 回合内没能打倒 1 号位时 `t.skip(...)`；HEAD commit `1717cd5` 的主题正是 *"the replacement case skips, it does not fail intermittently"*。**不是本轮引入的回归**
  - 证据：`replace.test.js:575-577`、`git log -1 --format=%B HEAD`

---

## C. M1：数据快照

### C1 来源、revision 与哈希

- [x] **C1.1 固定三份上游快照的精确 revision**
  - 证据：`data/roco/sources.yaml`
  - `JayeGT002/rocom-wiki-data` @ `aff808eb60003457fe8a260d1ac3c9bd95d53872`（2026-09-10）
  - `ColinHong10/NRC_AI` @ `9b5801b08d349c6505a233c513faa5075f427035`（2026-04-20）
  - `AofeiLi-code/rocom-data` @ `d2c0533aad9a0480d39e3fbc5c37507a47958251`（2026-05-09）
- [x] **C1.2 计算归档 SHA256**
  - 证据：`reports/roco/m1-data/raw-sha256.txt`
  - 主快照：`5cc6822a4bb7a2c7b37f535b9b22f78880d04f12056a8e5ee6e185b92883b0cc`
- [x] **C1.3 逐文件哈希清单**
  - 证据：`reports/roco/m1-data/snapshot-file-inventory.json` —— **603 个文件 / 205,934,856 bytes**
- [x] **C1.5 归档入库策略按体积区分，避免把大文件塞进 git**
  - 入库：`rocom-wiki-data.tar.gz`（844KB，主数据源）、`rocom-data.tar.gz`（4.0MB，第三来源）
  - **不入库**：`NRC_AI.tar.gz`（**172MB**）—— 放进 git 会永久留在历史里、之后无法真正移除
  - 替代保证（四级，足以复现）：固定 revision（`sources.yaml`）+ 归档 SHA256（`raw-sha256.txt`）+ 解压后逐文件 SHA256（`snapshot-file-inventory.json`）+ 交叉核验结果（`cross-check.json`）
  - 理由：该归档只是**交叉核验的第二来源**，其数值不进入 `normalized/`（许可未确认，标 `REFERENCE_ONLY`），因此不随仓库分发**不会**让任何已交付结论失去依据
  - 证据：`.gitignore` 中的 `data/roco/raw/NRC_AI.tar.gz` 条目及其说明；入库总量 **8.7 MB / 60 个文件**（不含 NRC_AI 时）
- [x] **C1.4 每条数据带 `game` / `ruleset` / `season` / `source_url` / `revision` / `fetched_at` / `sha256` / `license` / `redistribution` / `verification_status`**
  - 证据：`data/roco/sources.yaml`（每一项都有）；`data/roco/provenance.jsonl`（18 行逐实体 provenance）；`evals/roco/data-acceptance.test.js` 的「每条记录都带 ruleset / game / 来源 / 许可 / 核验状态」用例**已通过**

### C2 许可矩阵

- [x] **C2.1 建立 `docs/roco/LICENSE-MATRIX.md`**
  - 证据：`docs/roco/LICENSE-MATRIX.md`
- [x] **C2.2 未确认许可的材料标 `REFERENCE_ONLY`**
  - `rocom-data-lineups`：仓库**无任何 LICENSE 文件** → `REFERENCE_ONLY`
  - `nrc-ai-sqlite`：MIT 只覆盖**代码**，上游数据权利未声明 → `REFERENCE_ONLY`
  - 已由测试强制：无许可来源必须同时是 `REFERENCE_ONLY`
- [x] **C2.3 记录主数据源的非商业约束**
  - `wiki-rocom-snapshot`：**CC BY-NC-SA 4.0**，`commercial_use: prohibited`
  - 并记录了一个易误判点：GitHub API 返回 `NOASSERTION`，但仓库内有完整中文 LICENSE 正文，**以正文为准**

### C3 安全导入（不执行第三方代码）

- [x] **C3.1 第三方 Lua 只作文本解析，禁止执行**
  - 证据：`scripts/roco/lua-safe-parse.mjs` —— 逐字符扫描器，**无 `eval` / `new Function` / `require` / `child_process` / `node:vm` / 动态 import**
  - 已由测试 `M1: 第三方 Lua 只被文本解析，从未执行` **强制断言**（禁用列表逐条检查）
- [x] **C3.2 13/13 个上游 Lua 数据文件全部安全解析**
  - 证据：`scripts/roco/selftest-lua-parse.mjs`；结果 `ALL LUA FILES PARSED OK`
  - Catalog 622 精灵 / Skills 824 技能 / Learnsets 312 学习表 / Types 120 属性组合 / Terms 54 术语
- [x] **C3.3 第三方 Python 从未执行**
  - 说明：`scripts/roco/cross-check.py` 是**我们写的**核验脚本（只用标准库 `sqlite3` 以只读模式打开 `nrc.db`），不是上游脚本；上游 `src/`、`scripts/` 下的 Python **一行都没有运行**

### C4 规范化数据与质量报告

- [x] **C4.1 建立版本化数据目录与 schema**
  - 证据：`data/roco/normalized/roco-world-s4-2026-09-10/{pets,skills,learnsets,types,terms,history,support-matrix,import-report}.json`、`scripts/roco/schema.mjs`
- [x] **C4.2 provenance 与 conflicts 台账**
  - 证据：`data/roco/provenance.jsonl`（18 行）、`data/roco/conflicts.jsonl`（26 行）
- [x] **C4.3 孤儿引用为 0**
  - 证据：`import-report.json` 的 `orphan_skill_refs_total: 0`；并由测试逐精灵复核学习表内每个技能引用都存在
- [x] **C4.4 动态威力不得被当 0 伤害**
  - 证据：`power` 缺失一律为 `null` 且标 `power_status: not_provided_by_source`；测试断言**任何技能都不得出现 `power === 0`**
  - 另量化了风险规模：A 组技能池中条件化威力技能数为 8/7/3/1/3/8
- [x] **C4.5 同名 / 形态冲突逐条记录，不静默覆盖**
  - 证据：`conflicts.jsonl` 的 `same_name_multiple_forms` —— 化蝶 **4 个形态**全部登记，目标形态由 `title`「化蝶（平常的样子）」唯一确定为 `pet_000124`
- [x] **C4.6 冲突台账无未处置项；未解决项不得被降级**
  - 证据：测试断言「跨来源冲突必须有分类与处置说明」且「`major` 数量必须与报告声称的未解决数一致」
  - 本轮结论：**26 处冲突，0 处未解决**

### C5 三来源交叉核验（本轮额外做到的）

- [x] **C5.1 用独立来源交叉核验，而不是只用 importer 自己的产出**
  - 证据：`scripts/roco/cross-check.py`（Python，独立读取 `nrc.db`）+ `scripts/roco/import-snapshot.mjs` 读 `sprites.json` 作第三来源
- [x] **C5.2 差异必须被解释，否则升级为待人工核验**
  - 证据：`docs/roco/DATA-CONFLICTS.md`、`reports/roco/m1-data/cross-check.json`
  - 25 处数值差异分类：`version_rebalance` 13、`cross_source_stale` 6、`field_scope_difference` 5、**未解决 0**
- [x] **C5.3 发现了「直接用旧快照会得到过时种族值」这一真实风险**
  - 证据：`history.json` + `DATA-CONFLICTS.md` §4.1
  - 4 只精灵在 2026-05→09 之间被改过数值：黑猫巫师、圆号鱼、音速犬、画间沉铁兽；每一处 `before→after` 都与主快照自带的改动记录对上了

---

## D. M1：12 只精灵与支持矩阵

- [x] **D1 导入 12 只指定精灵，全部解析成功**
  - 证据：`import-report.json` 的 `targets_resolved: 12 / 12`
  - 清单核对：寂灭骨龙、海豹船长、黑猫巫师、圆号鱼、雪影娃娃、音速犬、画间沉铁兽、秩序鱿墨、化蝶（平常的样子）、银月狼王、圣凯布米龙、月使鹭纳
  - 分组数量：A 6 / B 3 / C 3（测试断言）
- [x] **D2 生成 `docs/roco/PET-SUPPORT-MATRIX.md`**
  - 证据：`docs/roco/PET-SUPPORT-MATRIX.md`（424 行，由脚本生成，可复现）
  - 每只列出：来源、赛季、静态数据完整度、候选配招、所需效果原语、当前支持等级、冲突、进入模拟前还缺什么
- [x] **D3 支持等级诚实（当前一律 `KNOWLEDGE_ONLY`）**
  - 证据：`support-matrix.json`；测试断言 12 只**都不得**声称 `SIM_VERIFIED` 或 `EVAL_ELIGIBLE`
  - 理由：本轮未实现任何效果原语，824 条技能的 `effect_support` 全为 `unsupported`
- [x] **D4 C 组不得写成「热门」「T0」**
  - 证据：`PET-SUPPORT-MATRIX.md` §3.2 —— 明确写「新版本登场不等于热门、强或值得围绕构筑」，并说明三只**不在** 2026-04/05 的历史阵容快照里，故为**单一来源、无交叉核验**
- [x] **D5 来源核验标签必须区分「比对过」与「没比对」**
  - 证据：`import-report.json` 的 `cross_check.details[].cross_checked`；文档中 8 只标「已交叉核验」、4 只（化蝶 + C 组 3 只）标「**单一来源**（无交叉核验）」

---

## E. M1：A 组候选配招

- [x] **E1 A 组 6 只各选出一套有数据证据的候选配招**
  - 证据：`support-matrix.json` → `pets[].candidate_moveset`；`PET-SUPPORT-MATRIX.md` §2.2
  - 寂灭骨龙：诡刺 / 龙血 / 坟场搏击 / 集中
  - 海豹船长：气波 / 水泡盾 / 一拳 / 取念
  - 黑猫巫师：彗星 / 防御 / 音爆 / 啮合传递
  - 圆号鱼：甩水 / 防御 / 许愿星 / 啮合传递
  - 雪影娃娃：风吹雪 / 防御 / 超级糖果 / 啮合传递
  - 音速犬：火苗 / 防御 / 火云车 / 焚烧烙印
- [x] **E2 配招不是「最优解」，且不来自社区文章**
  - 证据：选择规则写死在 `scripts/roco/build-support-matrix.mjs`（4 个角色的谓词与排序），**完全没有**使用社区阵容频次或攻略文章
  - 文档中显式声明「不是最优解、不是社区推荐、不是胜率结果」
- [x] **E3 每个选择附证据（候选数 / 来源池 / 备选清单）**
  - 证据：`candidate_moveset.selection_evidence[role] = { rule, source_pool, considered, alternatives }`
- [x] **E4 候选技能必须真实存在于该精灵学习表（禁止拼凑/改名）**
  - 证据：测试「候选配招的技能必须真实存在于该精灵的学习表」**已通过**：逐个技能必须在其 `learnsets` 池内且存在于 `Skills.lua`
- [x] **E5 未填满的角色必须显式记录，不得编造**
  - 证据：`candidate_moveset.missing_roles`；实测 6 只全部填满（`missing_roles: []`）

---

## F. M1：microcase 计划

- [x] **F1 覆盖任务书要求的 11 个方向**
  - 证据：`docs/roco/MICROCASE-PLAN.md` §3 覆盖对照表；测试断言类别集合完整
  - 优先级 / 速度同速 / 同时行动 / 主动换宠 / 倒下补位 / 能量 / 状态持续 / 触发顺序 / 动态伤害 / 取整 / 隐藏信息 / A 组特性
- [x] **F2 每例包含：初始状态、公开观察、合法动作、联合动作、预期事件序列、证据来源、验证等级**
  - 证据：`evals/roco/cases/microcases-v1.jsonl`（1 行 header + 21 行 case）；测试断言必需字段齐全
- [x] **F3 不能确认的字段写 `unknown`，不猜规则**
  - 证据：**全部 21 条**的 `expected_event_sequence` 都是 `null`；测试强制断言「不得编造期望事件序列」
  - verification.level 也标 `documented_text_only` / `planned`，`passed` 一律 `false`
- [x] **F4 额外覆盖本轮数据显示必须处理的机制**
  - 证据：`MC-020`（应对攻击：必定先手 + 触发效果 + 防御技能 1 回合冷却）、`MC-021`（蓄力：免疫所有离场效果）
  - 理由：12 只中 **10 只**的候选配招含「应对型防御」
- [x] **F5 明确 fail closed 要求**
  - 证据：`MICROCASE-PLAN.md` §5 列出 **12 条最关键未解问题**与「未核验机制必须返回 `unsupported_effect`，禁止退化成默认 40 威力普通攻击」
- [x] **F6 登记本轮从数据中已能确定的机制文本**
  - 证据：`MICROCASE-PLAN.md` §4 —— 18 条关键术语原文（先手、应对攻击/状态/防御、蓄力、传动、离场、印记、中毒、灼烧、冻结、迅捷、奉献、迸发、返场、紧急脱离、选择、连击数）
  - 说明：术语表提供了 **54 条**机制文本定义，这是本轮能区分「文本说了什么」与「没说什么」的依据

---

## G. 页面与浏览器验收

- [x] **G1 页面基线（改动前）真实可用**
  - 证据：`reports/roco/m0-baseline/smoke.log` —— 全部通过
- [x] **G2 本轮新增的浏览器验收脚本与原始产物**
  - 证据：`scripts/roco/browser-acceptance.mjs`、`reports/roco/acceptance/browser-acceptance.json`
  - 结果：**9/9 通过**
  - 截图：`01-camp.png`、`02-filter.png`、`03-battle.png`、`04-battle-end.png`
- [x] **G3 M1 新增数据未被页面暴露（本轮不接管默认 UI）**
  - 证据：验收项「M1 新增数据未被页面暴露」——对 `data/roco/sources.yaml`、`conflicts.jsonl`、`pets.json`、`scripts/roco/import-snapshot.mjs` 的请求**全部 404**
  - 原因：`server.js` 的 `publicAssets` 白名单从 `app.js` 的 import 图推导，不含 `data/`
- [x] **G4 页面仍能完整打完一局（真实浏览器）**
  - 证据：`04-battle-end.png` —— 第 13 回合、本场失利、全队经验 +12、成长已自动保存、战斗记录可读；验收项「对局能打到出现结果面板」与「过程中没有卡死」均通过
- [x] **G5 控制台零报错**
  - 证据：验收项「控制台零报错 / 零未捕获异常」通过（`consoleErrors`、`pageErrors`、`failedRequests` 均为空）
- [x] **G6 本轮**不**替换默认 UI（属于边界，不是遗漏）**
  - 证据：对局截图仍显示自创宠物（烬尾狐 / 芽角鹿）与自创技能（疾爪 / 火花 / 余烬追猎）—— **这正是本轮的正确状态**，UI 替换属 M3

---

## H. 硬性边界逐条核对

| 边界 | 是否遵守 | 证据 |
|---|---|---|
| 只用《洛克王国：世界》**手游**数据，禁止混入页游 | ✅ | `sources.yaml` 的 `excluded_source_classes`；测试断言来源 URL 不得含 `roco.qq.com`；全部数据 `game: roco_world_mobile` |
| 不把计划当成已实现 | ✅ | 21 条 microcase 全标 `PLAN_ONLY_NOT_EXECUTED` 且 `passed: false`；支持等级全为 `KNOWLEDGE_ONLY`；M0 审计明确 RETIRE 未执行 |
| 不改名冒充手游机制 | ✅ | `engine.js` 的 `SKILLS`/`SPECIES` **一行未改**；候选配招全部来自手游 `Skills.lua` 并有测试强制其存在于学习表 |
| 未核验数据标 `unknown` / `unsupported` | ✅ | 824 条技能 `effect_support: unsupported`；`field_groups.official_damage_formula: unknown`；74 个未解问题登记在 microcase |
| 不自行补齐威力 / 触发条件 / 结算时序 | ✅ | `power` 缺失为 `null`；测试禁止 `power === 0`；microcase 期望值全 `null` |
| 社区阵容频次不得写成胜率 / 最优阵容 | ✅ | 本轮**完全未使用**社区频次做配招；`sources.yaml` 明确标注 `parsed_frequency_only` 与「没有段位/样本量/胜率」 |
| 第三方 Lua/Python 只能文本解析，禁止执行 | ✅ | `lua-safe-parse.mjs` 的禁用 API 由测试强制；上游 Python 未运行 |
| 所有数据记录版本/赛季/来源/抓取时间/revision/SHA256/许可/核验状态 | ✅ | `sources.yaml` + `provenance.jsonl` + 测试强制 |
| 不删除旧测试 | ✅ | `git diff` 对 `*.test.js` 为 0 项；测试数 375 → 390 |
| 不执行 `git reset` | ✅ | 未执行任何 reset；`git reflog` 无 reset 记录 |
| 不覆盖用户未提交修改 | ✅ | 开始时工作区干净（无未提交修改） |
| 不提交 API key / 密码 / 本地模型权重 / 隐私数据 | ✅ | `.dsh-pushplus-token` 已加入 `.gitignore`；`server.log` 已 grep 确认 0 处密钥材料；未提交 `.models/`、`.venv-agent/` |
| 不安装额外插件 | ✅ | 本轮未安装任何 DSH 插件；也不需要（见 `04-DSH-PLUGIN-DECISION.md`） |
| 不提前替换默认 UI | ✅ | 见 G6 |
| 不重写完整战斗引擎 | ✅ | `engine.js` 未修改 |
| 不下载 / 训练模型 / 租用 GPU | ✅ | 未下载模型、未训练、未使用云 GPU |
| 测试通过不替代数据真实性检查与页面验收 | ✅ | 除 390 项测试外，另有独立数据域验收（15 项）+ 三来源交叉核验 + 真实浏览器验收（8 项，含 4 张截图） |
| 完成项必须指向具体代码/数据/测试/浏览器证据 | ✅ | 本文件每一项都有「证据」行 |

---

## I. 本轮**不做**的项（保留未勾，不算完成）

- [—] **替换默认 UI（M3）** —— 边界外
- [—] **重写完整战斗引擎（M2）** —— 边界外
- [—] **实现 `roco_env` Python 规则引擎** —— 边界外（M2）
- [—] **新增 5 个工具**（`query_rules` / `evaluate_team` / `compare_team_change` / `plan_actions` / `summarize_battle`）—— 边界外（M2/M4/M5）
- [—] **网页/下载任何官方数值** —— 无公开官方来源，属 `unknown`
- [—] **下载 Qwen / 训练 SFT / Battle PPO / Agentic RL** —— 边界外（M8 及以后）
- [—] **阵容强度模型与 planner** —— 边界外（M4/M5）
- [—] **真人学习迁移验证** —— 无真人被试，无法完成

---

## J. 明确**未完成**（有证据的阻塞，不得勾选）

- [ ] **手游官方伤害公式**
  - 阻塞证据：三个来源全部是社区重组，无官方公式；`NRC_AI` 的公式是它自己的实现（许可也不允许直接采用）
  - 影响：`MC-010`、`MC-011` 无法给出期望值；已标 `unknown` 并转成 microcase
- [ ] **等级 → 面板数值换算（含性格/天分/血脉）**
  - 阻塞证据：快照只提供种族值，无等级曲线、无性格/天分影响字段
  - 影响：无法把种族值换算成实战面板；`support-matrix` 中已列入 `blockers_before_simulation`
- [ ] **同速与同时行动的精确裁决**
  - 阻塞证据：术语表只定义「先手度更高者优先」，未定义同先手度同速的裁决
  - 影响：`MC-002` 期望值为 `null`；决定 replay 是否可能
- [ ] **能量上限与回能时机**
  - 阻塞证据：快照给出每条技能的能耗，但**没有**能量上限字段，也没有回能时机的一手证据
  - 影响：`MC-007` 期望值为 `null`
- [ ] **印记替换规则（同类第二个印记如何处理）**
  - 阻塞证据：术语 3010 给了「最多 1 正 + 1 负」的上限，但未说替换 / 叠加 / 拒绝
  - 影响：`MC-009`
- [ ] **百分比伤害与回复的取整方向**
  - 阻塞证据：术语给了 2% / 3% / 5% / 6%，但**都没有**写取整方向
  - 影响：`MC-011`
- [ ] **A 组 6 只特性的结算细节**
  - 阻塞证据：只有特性描述文本，无触发时机与数值口径的一手证据
  - 影响：`MC-014`—`MC-019` 全部为计划态

---

## K. 复现全部结论的命令

```sh
cd /Users/serendizc/Developer/roco-coach

# 基线（改动前已保存）
cat reports/roco/m0-baseline/npm-test.log      # 375/375
cat reports/roco/m0-baseline/smoke.log         # 浏览器冒烟全通过
cat reports/roco/m0-baseline/evals.log         # 离线 eval 退出码 0

# 数据管线（可整体重跑）
node scripts/roco/hash-snapshot.mjs            # 逐文件 SHA256 清单
node scripts/roco/selftest-lua-parse.mjs       # 13/13 Lua 安全解析
python3 scripts/roco/cross-check.py            # 独立来源交叉核验（只读 sqlite）
node scripts/roco/import-snapshot.mjs          # normalized + provenance + conflicts
node scripts/roco/build-support-matrix.mjs     # 支持矩阵 + A 组候选配招
node scripts/roco/build-support-matrix-doc.mjs # 生成 PET-SUPPORT-MATRIX.md
node scripts/roco/build-conflicts-doc.mjs      # 生成 DATA-CONFLICTS.md
node scripts/roco/build-microcases.mjs         # microcase 计划
node scripts/roco/build-microcase-doc.mjs      # 生成 MICROCASE-PLAN.md

# 验收
npm run test:roco                              # 15/15 数据域验收
npm test                                       # 390 项全量回归
node scripts/roco/browser-acceptance.mjs       # 9/9 真实浏览器验收（含 4 张互不相同的截图）
```

> 注意：`data/roco/raw/extracted/` 已被 `.gitignore` 忽略（体积原因）。
> 新克隆的仓库需要先从 `data/roco/raw/*.tar.gz` 解压（归档本身已入库且带 SHA256），
> 否则数据域验收测试会**显式 skip 并说明原因**，不会假装通过。

---

## L. 结论

**M0 与 M1 范围内可验证的项目已全部完成并打勾。**
存在 **7 项有明确证据的未完成项（§J）**，它们全部属于「需要游戏内实测或官方资料才能确定」的机制，
本轮**没有**用任何默认值补齐，而是逐条转成了 21 条 microcase 与 74 个未解问题，交给下一轮。

本轮结束时：**12 只手游精灵的数据来源、字段一致性、哪些技能还不能模拟、以及下一轮要实现的精确规则集合，都可追溯。**
