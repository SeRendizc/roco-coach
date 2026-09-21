# v3 纠偏：标准 PVP 六宠 / 600+ 候选宇宙 / 3 秒阵容工坊

> 写下时 HEAD：`87d0eea`（基线见 `reports/roco/flagship-upgrade/baseline.json`）。
> 依据：`/tmp/roco-coach-handoff-revised-2026-09-21/` 的 00 / 08 / 09 / 10 / 13 号文档（人类指定的必读清单）。
> 本文是**变更说明**，不是计划书：它写清「停止什么、保留什么、迁移什么」，以及第一批施工的拆分。
> 判据与产物：`scripts/roco/flagship-baseline.mjs`、`scripts/roco/artifact-invalidation.mjs`、
> `data/roco/artifact-registry.json`、`data/roco/battle-modes.json`、`tests/roco-v3-redirect.test.js`（9/9）。

---

## 1. 我读到的现状（以当前 HEAD 的可跑事实为准）

| 事实 | 值 | 来源 |
|---|---|---|
| HEAD | `87d0eea`，工作区干净，门禁 14/14 全绿 | `baseline.json` |
| 引擎能量常量 | `ENERGY_MAX=6` / 回合末 `+1` / 入场 `2`，源码自注「假设」 | `roco/src/roco_env/env.py:58-59` |
| L1 冻结目录 | 622 条精灵记录；技能记录 824 | `data/roco/normalized/roco-world-s4-2026-09-10/` |
| 当前可玩池 | 48 只（12 基线 + 36 overlay），UI 里是**固定 3 只**编队 | `layer-playable-48/`、`src/client/roco.js` |
| BattleMode | 只有一种：练习局 3v3（无魔力概念） | `env.py`、`battle-modes.json` |
| 已有能力（KEEP） | 规则引擎 joint-step/replay、Node↔Python 桥、bounded tool loop、多动作比较+未来后果、stale-plan 丢弃、PVP 公平门控、RAG 证据透传、game adapter + mock host、三角色闭环、release guard/浏览器验收 | `PROGRESS.md`、`GAME-ADAPTER.md` |
| 旧规则产物 | 8 个家族有指纹；其中 13 条绑定旧规则 → 已进「禁止重跑」清单 | `artifact-invalidation.json` |

**最重要的一条现状判断**：当前引擎的胜负是「打光一方」，而且能量上限 6 是**假设**。
标准 PVP 的目标是「先让对方魔力归零」——这意味着 **`env.py` 现在这套结算不能直接当作标准 PVP 的实现**，
而 v3 也明确要求不要在规则未定时继续生产轨迹。所以这一阶段的顺序必须是
**规则 candidate → 数据/候选宇宙 → 阵容工坊 → 模拟层扩展**，不能反过来。

---

## 2. 停止 / 保留 / 迁移（旧目标影响清单）

### 2.1 立即停止（本指令生效起）

| # | 停止项 | 为什么 | 落点 |
|---|---|---|---|
| S1 | 用**旧规则**（max=6 / 入场 2 / 回合末 +1）生成或重训任何轨迹、SFT 数据、team model、介入窗口 | 只是再生产一批绑定旧规则的产物 | `artifact-invalidation.json` 的 `do_not_regenerate`（13 条） |
| S2 | 把「标准 PVP」当 3v3 / 固定 3 只实现 | 官方 3v3/2 魔力是**极速对决活动**；标准 PVP 是六宠（候选） | `battle-modes.json`、`tests/roco-v3-redirect.test.js` |
| S3 | 把 48 只（或 60 只）当运行时白名单 / 候选宇宙 / 「已选 3 只固定栏」 | 48 只只是**迁移夹具**；候选宇宙是全量 600+ | 本文 §4、RC-303 |
| S4 | 在线请求里做批量模拟（Top-K rollout） | 3 秒预算装不下，且会随候选宇宙扩大而崩 | 本文 §5、RC-306 |
| S5 | 把社区交叉支持写成官方事实（尤其 4 点魔力、六宠强制、能量 10） | 社区 ≠ 官方 | `battle-modes.json` 的 `invariants`、evidence ledger |

### 2.2 保留（KEEP + revalidate，**不许重写或退化**）

多动作比较与 2–3 回合后果、stale-plan 丢弃、PVP 公平门控、RAG 证据透传、game adapter + mock host、
军师/老师/陪练三角色、`runtime.js` 的有界工具循环、local Qwen 网关、release guard/浏览器验收、
provenance/conflicts/L1 目录、`roco/src/roco_env` 的 joint-step/replay 地基。

**revalidate（不是重写）**：48 只回归集、planner 比较与风险、轨迹与 team evaluator、介入窗口与判定层、
SFT 里依赖能量/合法动作的样本、UI 的能量与高费技能文案、Demo 截图与性能报告。
判据：产物 manifest 必须绑 `ruleset + rule_config_id`，旧产物保留为 legacy 基线。

### 2.3 迁移（旧目标 → v3 的对应关系）

| 旧目标口径 | v3 口径 | 迁移动作 |
|---|---|---|
| 「已选 3 只」固定队伍栏 | **六个队伍槽位**，0～6 只渐进 | UI 重构（RC-305），保留现有选择器与真实键鼠验收钩子 |
| `C(48,3)=17,296` 全合法 | `C(622,6)` 不可枚举 → 召回 + Beam | RC-303 候选生成 |
| 固定池 48/60 | 全量 600+ 候选宇宙 | RC-201/202 数据包 + RC-303 |
| 练习局 3v3 胜负（打光） | 标准 PVP：魔力归零（候选规则） | RC-101 candidate ruleset + microcase |
| 「对手已被看见」的评估 | **匹配前未知**，按版本 Meta prior | RC-301/304 `UNKNOWN_PREMATCH` |
| 局内建议为主 | 战前配队 → 局中建议 → 局后复盘闭环 | RC-301～305 + RC-504（三角色不变） |
| 48 只 coverage 文档 | 机制/原语覆盖 + 分层抽样 | RC-404 代表性回归集 |

---

## 3. BattleMode：一张表说清「哪个是官方、哪个是候选」

机器可读版：`data/roco/battle-modes.json`（含来源 URL、置信等级、未核实项、microcase 需求）。

| 模式 | 编成 | 魔力 | 置信等级 | 状态 | 待录 microcase |
|---|---|---|---|---|---|
| 标准 PVP（六宠阵容工坊） | **6** | **4（通常）**，力竭 -1 | `CROSS_SOURCE_SUPPORTED` | **CANDIDATE** | `MC-BM01/02/03` |
| 极速对决（限时活动） | 3 | 2 | `OFFICIAL_CURRENT` | ACTIVITY | — |
| 领地试炼 | 2（同时 2 只上场） | — | `OFFICIAL_CURRENT` | ACTIVITY | `MC-BM04` |
| 当前 Demo 练习局 | 3 | —（打光判负） | `ENGINE_HYPOTHESIS` | **LEGACY_FIXTURE** | — |
| 营地 PVE | — | — | `OFFICIAL_CURRENT` | EXISTING | — |

三条写进登记表的硬纪律（有测试钉住）：
1. 标准 PVP 六宠的置信等级**不得**升成 `OFFICIAL_CURRENT`（录到实机之前）；
2. 极速对决是**独立模式**，它的 3v3/2 魔力不能当标准模式口径；
3. 任何模式的规模都**不得**取自「当前 Demo 的 48 只名单」。

---

## 4. 数据 / 模型 artifact 失效图（RC-104）

`data/roco/artifact-registry.json` 登记 **20 条产物**与 **17 个规则主题**，每条产物声明它依赖哪些主题；
`node scripts/roco/artifact-invalidation.mjs` 据此算出「规则一变 → 谁受影响 → 怎么重建」，
产物在 `reports/roco/flagship-upgrade/artifact-invalidation.json`。

当前结果：全部主题都变时，**20/20 条受影响**，其中 **13 条绑定旧规则 → 禁止重跑**：

```text
playable-48-layer            layer-playable-48/（48 只的「可玩」资格按当前引擎规则算）
traj-rule-arm-v1             tests/evals/agent-trajectories-v1.jsonl
traj-model-arm-v1            tests/evals/agent-trajectories-model-v1.jsonl
model-error-trajectories-v4  tests/evals/roco/model-error-trajectories-v4.jsonl
sft-dataset                  reports/roco/sft/dataset-report.json
team-model-g02               reports/roco/g02-team/model.json
intervention-windows-roco    tests/evals/roco/intervention-windows-roco.jsonl
intervention-model-generated src/coach/intervention-model.generated.js
planner-benchmarks           reports/roco/planner-benchmark.json
position-fixtures            tests/evals/roco/coach-positions.test.js
browser-position-matrix      reports/roco/demo-acceptance/coach-positions-browser.json
pet-support-matrix-doc       docs/roco/PET-SUPPORT-MATRIX.md
roster-48-doc                docs/roco/ROSTER-48.md
```

判据的牙（都在 `--selftest` 与测试里）：
- 产物没写依赖 → 红；登记想象中的路径 → 红；有主题没人依赖 → 红（说明图漏了东西）；
- **把某条依赖删掉，那条产物必须从受影响清单里消失**（证明清单是算出来的，不是写死的）；
- 绑定旧规则的产物必须出现在 `do_not_regenerate` 里。

**为什么这一条最值钱**：第 63 轮已经因为「引擎改了、12 个局面夹具失配」红过一次；
现在再改规则，`position-fixtures` 会**自动**出现在清单里，而不是等到门禁红才发现。

---

## 5. 六槽 UI 与 3 秒 Serving 的实施拆分

### 5.1 六槽 UI（RC-305，依附 RC-301/303/304）

| 步 | 改动 | 文件 | 验收 / 负向验证 |
|---|---|---|---|
| U1 | 队伍槽从 3 → **6**，去掉「已选 3 只固定栏」的硬编码；槽位支持锁定/收藏/拥有状态 | `src/client/roco.js`、`roco.html`、`roco.css`、`src/coach/roco-experience.js` | 浏览器：能选满 6 只并开局；**负向**：故意只选 3 只时界面不许宣称「已满编」 |
| U2 | 候选区从「48 只分页池」改成**全量候选 + 搜索/筛选**，48 只只作默认视图 | 同上 + `src/server/roco-service.js` | 浏览器：能选到非 48 名单里的精灵 |
| U3 | 选第 2～5 只时给**三个下一只候选**（强度/稳定/偏好保留），并显示「为什么是它」 | `src/coach/team-workshop.js`（新） | 机器可读：每个候选带 gap/evidence/confidence；**负向**：硬约束违反必须为 0 |
| U4 | 选满 6 只后给环境价值、最差体系、容错、支持置信度、**一个最小替换** | 同上 | 报告：字段齐全；**负向**：没有校准证据时不许输出伪精确胜率 |
| U5 | 工程字段（ruleset/support/latency/digest/state_version）进开发者抽屉 | `roco.html` | 复用现有 `#about-drawer` + demo-acceptance 的玩家层工程话判据 |
| U6 | 模式标识：标准 PVP 标「候选规则（待实机核对）」；极速对决作为独立可选模式 | 同上 + `battle-modes.json` | **负向**：把候选模式标成「官方规则」必须被判据抓住 |

### 5.2 3 秒 Serving（RC-306）

```text
在线（禁止批量模拟）：
  0–300ms   结构化初判（硬约束 + 召回 + Beam 补全 + Ranker 排序 + 证据装配）→ 先上屏
  300–3000ms LLM 组织自然语言（工具循环在预算内），超时 → 保留短结论
离线（生产标签）：
  规则引擎 + 多种 opponent policy → 联赛/自博弈/反事实替换 → matchup bank
  → Team Pairwise Ranker + Partial-team Completion Value（版本化产物）
```

| 分段 | P95 预算 | 判据 | 负向验证 |
|---|---|---|---|
| 状态与版本读取 | 50ms | 报告分段延迟 | 注入慢读 → 必须回退缓存值并如实标记 |
| 600+ 召回 | 150ms | 报告 recall 候选数 | 把候选限制到 48 只 → 判据必须红 |
| Beam + Ranker | 300ms | 报告 beam 宽度与耗时 | 关掉 Ranker → 排序必须退化且被记录 |
| 证据与反事实替换 | 300ms | 每条结论带 evidence | 拿掉证据 → 结论不许上屏 |
| 首屏短结论 | 800ms | 浏览器实测 | 引擎挂起 → 仍要有短结论（复用 adapter 的 3s 回退） |
| LLM 自然语言 | 总计 3s | 分段 P50/P95 | 模型超时 → 短结论必须还在 |

复用而不重写：`game-adapter.js` 的 `advise()` 已经实现了「规则短提示先到手 + 总时限 + 迟到结果丢弃」，
RC-306 是把它接到阵容工坊这条链路上，而不是另写一套超时逻辑。

---

## 6. 第一批的实际改动（已落盘）

| 交付物 | 说明 |
|---|---|
| `scripts/roco/flagship-baseline.mjs` + `reports/roco/flagship-upgrade/baseline.json` | RC-000：HEAD/工作区/规则常量/数据规模/模型指纹/门禁灯，**6/6 自检**（含「读不到必须是 null」的反向控制） |
| `data/roco/artifact-registry.json` + `scripts/roco/artifact-invalidation.mjs` + `reports/roco/flagship-upgrade/artifact-invalidation.json` | RC-104：20 条产物 × 17 个规则主题，**6/6 自检**，13 条旧规则产物进「禁止重跑」 |
| `data/roco/battle-modes.json` | BattleMode 参数化登记（六宠候选 / 极速对决 3v3·2 魔力 / 领地试炼 2v2 / 练习局 legacy） |
| `tests/roco-v3-redirect.test.js` | 9 条判据（含 6 条反向控制），`node --test` 9/9 |
| `data/roco/evidence/rule-evidence-ledger.json` + `data/roco/evidence/rule-evidence-microcase-records.json` + `scripts/roco/{verify-evidence-ledger,evidence-ledger-lib}.mjs` + `tests/roco-evidence-ledger.test.js` + `docs/roco/RULE-EVIDENCE-LEDGER.md` | 规则证据台账：**20 条**（OFFICIAL_CURRENT 3 / COMMUNITY_CURRENT 7 / CROSS_SOURCE_SUPPORTED 7 / ENGINE_HYPOTHESIS 3 / RECORDED_IN_GAME **0**），14 条需要实机 microcase；校验 12 条自检 + 17 条测试，反向检查「每一条抬到 OFFICIAL_CURRENT 都必须红」（幸存者 0） |

---

## 7. 证据台账的结论（第一批并行交付，已跑绿）

- 条目 **20** 条：`OFFICIAL_CURRENT` 3（极速对决 3v3/2 魔力、官方配队 AI「斯嘉丽」、BattleMode 参数化）、
  `COMMUNITY_CURRENT` 7、`CROSS_SOURCE_SUPPORTED` 7、`ENGINE_HYPOTHESIS` 3、**`RECORDED_IN_GAME` 0**（本批没录到任何实机）。
- **14 条**标了「需要实机 microcase」，落点在 `data/roco/evidence/rule-evidence-microcase-records.json`
  （`MC-E01…MC-E15`，每条写清「录到哪个观测值算通过」）。
- **证伪了升级包 10 号文档的一处来源指向**（这条比台账本身更值钱）：§12.1 把「随机精灵最多携带 6 只」
  标 `OFFICIAL_CURRENT` 并署 `taptap.cn/moment/838434682965067210`，**实测该 URL 是「极速对决」公告**
  （3v3、2 点魔力、主题精灵限制），正文没有「最多携带 6 只」。所以 `EV-PVP-STANDARD-TEAM-SIZE` 保持
  `CROSS_SOURCE_SUPPORTED`（TapTap 社区攻略 + 17173 全文转载官方更新公告两源），证伪写进 notes。
  **这条恰好证明了「必须先建台账再施工」**：如果照抄文档，我们就会把 3v3 活动公告当成六宠标准模式的官方依据。
- 证据最弱的两条：`EV-PVP-STANDARD-MANA`（4 点魔力，两份来源没有一处逐字写出该规则，引句是特性回能里的
  「4 能量」）与 `EV-PVP-FAINT-MANA-LOSS`（第二来源正文不含该规则）。两条都**没有**升级，
  **`MC-E08` 是最高优先录制项**。
- 附带核对（可直接用作 RC-102 的输入）：冻结快照 `skills.json` 里有 **20 条能耗 > 6 的技能**
  （8 点 3 条：过山车/岩土暴击/隐藏条款；10 点 3 条；1 条记 30 点数值可疑）——
  在 `ENERGY_MAX=6` 下它们**永久不可用**，这正是「规则基线错了会污染行动合法性」的实证。
- 「升一级必须红」这条反向检查的第一版写法是错的（按强度序往下退一格会更宽松、永远绿），
  实现改成「**抬到更强的档**」，并写成**全量**判据；它当场抓出一处真实自欺：
  `EV-PVP-UNKNOWN-OPPONENT` 曾挂一条只支持活动 PVE 的官方来源，已移除，
  并新增判据「官方一手来源只能出现在 `OFFICIAL_CURRENT` 条目上」。
