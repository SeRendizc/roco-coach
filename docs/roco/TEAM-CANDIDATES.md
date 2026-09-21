# TEAM-CANDIDATES —— RC-303 候选生成（离线产标签、在线只召回 + Beam + 排序）

> 代码：`src/coach/team-candidates.mjs`（纯函数 + 显式注入数据）
> 延迟证据：`scripts/roco/measure-team-candidates.mjs` → `reports/roco/team-candidates/latency.json`
> 机器可读报告：`reports/roco/flagship-upgrade/rc-303-team-candidates.json`
> 测试：`tests/roco-team-candidates.test.js`（12 组，含 8 条必红反证）
> 上游：RC-301 `src/coach/team-request.js`（校验过的请求）、RC-302 `src/coach/team-gaps.js`（索引与判据）
> 设计依据：`/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §5–§8；
> 路线图：`08-IMPLEMENTATION-ROADMAP.md` 的 RC-303 / RC-306

---

## 1. 一句话

玩家选 0～5 只，在线路径只做三件事：**从全量候选宇宙召回 20～50 个候选**、
**确定性 Beam 补全到六只**、**Top-K 逐队排序**。模拟器一次都不跑——它只负责离线产标签。

---

## 2. 召回 → Beam → 排序怎么走

```text
RecommendationRequest（RC-301 校验过）
  │
  ├─① recallCandidates(request, {owned, pack, frozen, gaps, policy, limits})
  │     hard filter：must_exclude / 已选 / species_unique / favourites_only
  │     候选宇宙：owned 实例 ∪ pack 的 600+ pet 实体（由 policy.candidate_universe 决定口径）
  │     便宜特征打分（全部读表 O(1)，不跑引擎）：
  │       属性互补 × 速度层次 × 能耗曲线 × synergy 的 answers 计数 × favourite/locked × 证据层级
  │     → 20～50 个候选（凑不满就写 shortfall_reason，不凑数）
  │
  ├─② beamComplete(request, recalled, {beamWidth, nodeBudget, timeBudgetMs, maxTeams})
  │     硬要求（locked / must_include）先占位 → 之后每层按结构分排序取前 beamWidth 个
  │     结构分 = 规则特征分 × 完成度折扣 − 重复物种惩罚 − 图鉴候选惩罚
  │     达到节点/时间/队伍上限就停下并记 truncated（已完成的部分照常返回）
  │     → 若干**完整**六宠队伍（确定性：同分用 team_key 字典序 break tie）
  │
  ├─③ scoreTeams(teams, {ranker, k})
  │     有版本化 ranker → 用它；**没有 → ranker_status:'missing'，退化成规则打分**
  │     → Top-K（K ≤ 10），逐队带 machine_evidence[] / confidence / unverified[]
  │
  └─④ progressiveNext(request)
        已选 2～5 只时给**恰好三个**下一只候选，分别带「强度 / 稳定 / 偏好保留」取舍标签
        0～1 只 / 6 只 **不适用**：如实返回 applies:false + 原因，不硬凑三个假候选
```

三段各自都是纯函数，可以单独调用，也可以走 `buildTeamCandidatePlan()` 一条龙。

### 召回的便宜特征（判据文本与代码同源：`RECALL_SCORE_CRITERIA`）

| 特征 | 怎么算 | 证据层级 |
|---|---|---|
| 属性互补 | 对「队伍现在没有抗性」的 18 个攻击系别，候选的登记倍率 < 1 记 1 分、= 1 记 0.25、> 1 记 0；已诊断出的未承接弱点加倍 | `types.json`（台账 `type.multiplier` = COMMUNITY_CURRENT） |
| 速度层次 | 速度按**候选宇宙内三分位**分 fast/mid/slow；补上新档位记 1、重复记 0.3、没有速度值记 0 | 48 只冻结档位 = validated；其余用 full-catalog base stats 并标 `knowledge_only` |
| 能耗曲线 | 只看候选**自己的 build** 四个技能：有 0 费 +0.5、无超限 +0.3、最低费 ≤2 +0.2 | `owned.instances[].skills` → `skills.json#energy` |
| synergy answers | 用 RC-302 §synergy 的 `answers(m,T)` 计数：候选能接住「队里没人接」的弱点就计分，全队 ≥3 只同弱再加权 | 可复算计数，不用社区职能标签 |
| favourite / locked | favourite=true 记 1、locked=true 记 1 | `owned-pets.json` |
| 证据层级 | 在冻结迁移层记 1；只有 pack 图鉴信息记 0.3，并在 `unverified[]` 点名 | — |

**`preference`（温和/简短/详细）不影响候选与排序**，只影响措辞（RC-301 合同里就这么写的）。

### Beam 的显式预算（都是参数，报告里给实际值）

| 参数 | 默认 | 说明 |
|---|---:|---|
| `beamWidth` | 4 | 每层保留的节点数 |
| `nodeBudget` | 2000 | 展开节点上限；到了就 `truncated: ['node_budget']` |
| `timeBudgetMs` | 50 | 时间上限（需要注入 `now()` 才生效；默认不读时钟） |
| `maxTeams` | 24 | 输出的完整队伍上限 |

报告样例用 `REPORT_BEAM_WIDTH = 8`（比在线默认宽），目的只是让报告里有 ≥6 支**不同**的队伍供人看；
在线默认仍是 4。两者都写进报告（`beam.budgets` / `beam.report_beam_width`）。

---

## 3. 为什么在线不模拟

13 号文档 §5 的分工：

- **离线**跑规则引擎与多种 opponent policy → 联赛 / 自博弈 / 反事实替换 → matchup bank →
  Pairwise Ranker → Partial-team Completion Value → 校准。模拟器的价值是**产标签、发现反例、做回归、训练 Value**。
- **在线**只做「静态特征 → 相对排序」。属性倍率、速度档、能耗、应对、换入手段全是读表。

把模拟放在在线会坏在三件事上：

1. **延迟不可控**：一次完整对局要起 Python 进程 + 序列化 + 多回合搜索，量级在百毫秒到秒级（`reports/roco/adapter-load/` 里的实测就是这个量级）；
   它会让 P95 变成「硬件 + 对手策略」的函数，而不是「数据」的函数。
2. **预算装不下**：RC-306 要求 300ms 结构化初判 / 3s 完整解释；13 号文档 §5.2 把召回与 Beam+Ranker 分别限在 150ms / 300ms。
3. **会偷换概念**：在线跑少量 rollout 很容易被读成「算过胜负了」，而本仓现在**没有**校准证据，
   任何胜率式的输出都是伪精确。

### 判据（**结构判据**，不是注释声明）

`src/coach/team-candidates.mjs` 里在线段与离线段用两个标记分开：

- 在线段 = `ONLINE_SECTION_MARKER`（`<!-- ONLINE-SECTION-END -->`）**之前**的全部导出；
- 离线段 = `OFFLINE_SECTION_MARKER` 之后的导出（目前只有 `buildOfflineLabelPlan`）。

判据是：把在线段逐行取出、**剥掉注释**，再对 `FORBIDDEN_ONLINE_PATTERNS` 做子串匹配：

```text
step_joint / plan_actions            → ONLINE_ENGINE_CALL
child_process / spawn / roco-client / RocoClient → ONLINE_SUBPROCESS_CALL
离线入口名出现在在线段              → OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION
```

实测：在线段 94 行，禁止模式命中 **0** 条（`reports/roco/team-candidates/latency.json#online_boundary`）。
测试把在线段整体替换成含 `RocoClient` / `plan_actions` / `step_joint` 的版本再跑同一判据，必须红：

```text
[ONLINE_SUBPROCESS_CALL] src/coach/team-candidates.mjs:3：在线段出现 RocoClient：…
[ONLINE_ENGINE_CALL]     src/coach/team-candidates.mjs:4：在线段出现 plan_actions：…
[ONLINE_ENGINE_CALL]     src/coach/team-candidates.mjs:5：在线段出现 step_joint：…
```

**离线入口**：`buildOfflineLabelPlan()`（导出在离线段）产出的只是**工作单**——
离线该跑 league / 自博弈 / 反事实替换 / matchup bank / Completion Value / Ranker / 校准，产物该落在哪。
它自己 `runs_simulations: false`：本模块一次模拟都不跑。谁调用、写哪些文件写在
`OFFLINE_ENTRYPOINTS` 里，报告原样带出。

---

## 4. 排序器**不存在**意味着什么

`reports/roco/flagship-upgrade/rc-303-team-candidates.json#ranker`：

```text
status: missing
reason: 本仓现在没有版本化 Team Ranker 产物（13 号文档 §5.1 的离线链路还没产出标签）
degrade_to: rule_score
no_win_rate: true
```

具体后果，逐条说清：

1. `scoreTeams()` 读到 `ranker_status: 'missing'`，用 **`ruleScore(features)`** 打分。
2. `confidence` 一律 **`ENGINE_HYPOTHESIS`**（台账六级里的「工程假设」）；
   权重 `RULE_SCORE_WEIGHTS` 是公开的、**没有对局数据支持**的数值。
3. 每支队伍的 `score_source` 是 `'rule_score'`，`score_scale` 写着
   「0～1 的**排序用**效用值（不是胜率、不是强度分）」。**Top-K 只是启发式排序。**
4. `unverified[]` 里点名这件事：`未核实：排序器不存在 —— Top-K 只是启发式排序`。
5. 输出里**没有** `win_rate` / `强度分` / `期望值` / 社区榜单标签；审计的
   `PSEUDO_PRECISION`（键与语句两条）会判红。

解除条件（报告里也写了）：离线链路产出 `data/roco/ranker/team-ranker-v1.json`
（含 `ranker_id` / `version` / `calibrated`），再作为 `ranker` 注入本模块。
`resolveRanker()` 只认**完整**的版本化产物：

| 注入的东西 | 判定 |
|---|---|
| `null` / `undefined` | `missing` → 规则打分 |
| 函数 | `ready`（`ranker_id: 'anonymous'`，无版本 ⇒ 仍标 ENGINE_HYPOTHESIS） |
| `{score}` 但缺 `ranker_id` / `version` / `calibrated` | `invalid` → 规则打分 |
| `{ranker_id, version, calibrated, score}` | `ready`；只有 `calibrated: true` 才可能升到 COMMUNITY_CURRENT |

产出里还有 `ranking.ranker_injected`：报 `ready` **必须**同时说这次真的注入了排序器，
否则审计报 `RANKER_OVERCLAIM`（防止事后把 `missing` 改成 `ready`）。

---

## 5. 渐进推荐的三个标签口径

13 号文档 §6：已选 2～5 只时推荐**三个**下一只候选，分别代表**强度、稳定、偏好保留**等取舍。
三个标签是**决策口径**，不是胜率（`PROGRESSIVE_STRATEGIES[].intent` 写进每个候选）：

| 标签 | 口径（怎么选） | 代价 |
|---|---|---|
| **强度** | 边际评分增益最大：加入后的队伍规则分 − 当前规则分 | 可能挤掉偏好位 |
| **稳定** | 「队里没有任何队友能接」的弱点数最少（同分再看弱点总数） | 单点强度不如强度口径 |
| **偏好保留** | 在 favourite / locked 里选边际增益最大的；一只收藏都没有时**如实回落**到强度口径并写 `fallback_reason` | 结构增益可能不如前两者 |

- 三个口径**允许指向同一只**（这本身就是信息：它同时最优），但每个口径都有自己的口径说明，`tradeoff_id` 不许重复。
- 0～1 只（体系入口口径）/ 6 只（完整队伍评估口径）**不适用**：返回 `applies: false` + `not_applicable_reason` + 0 个候选；
  审计在 2～5 只却报 `applies:false`、或返回数 ≠ 3、或标签不在三个口径里，一律 `PROGRESSIVE_NOT_THREE`。
- 实测样例：`强度(strength) → owned:own-0006 边际增益 28.3333 未承接弱点 4`、
  `稳定(stability) → catalog:pet_000331 边际增益 23.4722 未承接弱点 2`、`偏好保留(preference) → …`。

---

## 6. 组合爆炸是怎么被避免的

`C(622, 6) ≈ 6.4 × 10^13`。**不可枚举**，也不许 LLM 枚举。收窄发生在四层：

1. **合法性 / 拥有 / 锁定**先把候选宇宙砍到可用条目（`must_exclude`、已选、`species_unique`、`favourites_only`）；
2. **便宜特征召回**只留 20～50 个（读表，不跑模拟）；
3. **Beam** 在 `beamWidth × 候选数 × 层数` 的有界工作里补全：默认 4 × 50 × 5，且节点上限 2000；
4. **Top-K** 只对补出来的少量完整队伍排序（K ≤ 10）。

任何精灵只要 build 数据与能力依赖可用就参与评分；未知关键机制**降低 support confidence 或 fail closed**，
不从候选宇宙里静默消失（`unverified[]` 里点名）。

实测（`reports/roco/team-candidates/latency.json`，真实 owned 数据，9 个样例 × 20 次）：

| 阶段 | P50 | P95 | 13 号文档 §5.2 预算 | 结论 |
|---|---:|---:|---:|---|
| 状态与版本读取（索引构建，一次） | 2.7ms 量级 | max 5ms 量级 | 50ms | 在预算内 |
| 召回（600+ 过滤/召回） | 13.893ms | 21.354ms | 150ms | 在预算内 |
| Beam + 排序 | 15.974ms | 24.927ms | 300ms | 在预算内（但见下） |
| 首屏四段和（召回+Beam+排序+渐进） | 19.686ms | 28.296ms | 800ms | 在预算内 |

（分段实测：召回 P95 21.354ms / Beam P95 18.218ms / 排序 P95 6.709ms / 渐进 P95 5.163ms。
具体某一次运行的数字与原始样本都在 `latency.json` 里，报告逐次带 `generated_at`——
**以文件为准，不要以本文档的数字为准**。）

**但这一格是下界**：「Beam + Ranker」里的 Ranker **不存在**，实际跑的是规则打分；
接上真实 GBDT / Set 模型后必须重跑 `node scripts/roco/measure-team-candidates.mjs` 重测。
首屏那一格也**不含**证据装配（§5.2 单列 300ms）与 LLM 自然语言（总计 3s 内）。

---

## 7. 怎么跑

```bash
# 测试（含 8 条必红反证，每条打印实际输出原文）
node --test tests/roco-team-candidates.test.js

# 延迟实测 → reports/roco/team-candidates/latency.json
# 同时把实测合并进 reports/roco/flagship-upgrade/rc-303-team-candidates.json
node scripts/roco/measure-team-candidates.mjs
node scripts/roco/measure-team-candidates.mjs --json      # 只打印 JSON
node scripts/roco/measure-team-candidates.mjs --runs=50   # 改每个样例的重复次数

# 报告与生成逻辑逐字节一致（磁盘上的报告不一致时用这个重写）
RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js
```

`tests/roco-team-candidates.test.js` 已加进 `package.json` 的 `test:unit`（行末）。

---

## 8. 边界：RC-303 不做什么

- 不做缺口诊断（那是 RC-302；候选生成**复用**它的索引与判据，不复制第二套语义：
  `RESPOND_VARIANTS` / `isPivotSkill` 都从 `team-gaps.js` 导出，测试会红着钉住这一点）；
- 不做未知对手下的期望值 / 最差体系 / matchup spread（RC-304）；
- 不做 UI / 工具（RC-305）；
- 不跑模拟、不起进程、不训练模型、不写胜率、不用社区榜单标签；
- 不替换已选成员（要换人走「反事实替换」，RC-304）。

## 9. 现在还是「未核实」的东西

- 任何「强度」结论：`expected_meta_value` / CVaR / matchup spread 都需要离线联赛标签，RC-304 之前不存在；
- `RULE_SCORE_WEIGHTS` 与召回分项的权重：工程假设（台账里没有对应条目）；
- 574 只图鉴精灵的四技能与配招合法性（冻结 learnsets 只有 48 只）；
- 属性倍率逐条正确性（台账 `type.multiplier` = COMMUNITY_CURRENT，明确写「不再沿用旧资料双弱 ×4」）；
- 真机 / 浏览器里的耗时：现在的实测是 Node 进程内纯函数计时，不含 IPC、渲染与网络。
