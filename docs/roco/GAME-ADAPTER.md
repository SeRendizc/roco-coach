# 手游适配契约（GAME-ADAPTER）

> 契约实现：`src/coach/game-adapter.js`（纯函数 + 运行时校验，零依赖）
> 契约版本：`GAME_ADAPTER_CONTRACT_VERSION = 1`
> 集成夹具：`tests/evals/roco/mock-host/*` + `tests/evals/roco/mock-host-integration.test.js`
> 负载证据：`reports/roco/adapter-load/adapter-load.json`（命令 `npm run roco:adapter-load`）

这一份文档回答一个具体问题：**把「小芽」从这台演示页搬到另一个宿主（假定的真实手游宿主）上，
需要满足什么？** 答案是一份**有版本号、运行时逐条校验**的契约，而不是一段「照着这个字段读」的说明。

---

## 0. 三条不可协商的纪律

| # | 纪律 | 落在哪里 |
|---|---|---|
| ① | **Coach 核心不读 DOM。** 核心只认契约对象；适配层是纯函数，能在 Node 里跑完 | `game-adapter.js` 不 import `node:*`、不碰 `document`/`fetch`/计时器；`tests/evals/roco/game-adapter.test.js` 在无浏览器环境下全绿 |
| ② | **Coach 核心不读隐藏信息。** 对手**后备**只有位次与是否倒下；合法动作表由宿主给，核心不实现任何规则结算 | `FOE_BENCH_FIELDS = ['slot','fainted']` 白名单；多一个键 = `hidden_field_leaked` 直接拒 |
| ③ | **规则引擎是唯一真值源。** 模型只能提议**工具**；事实与数值一律来自引擎回执；模型输出与回执冲突时以回执为准 | `normalizeToolProposal()` 只保留 `{tool,args,stop}`；`enforceReceipts()` 冲突即丢弃模型正文并换回执那一句 |

三条都由测试钉住，包括**必红方向**（见 §6）。

---

## 1. 公开遥测（`validateTelemetry`）

宿主每一版状态给一份「此刻屏幕上双方能看见什么」。**白名单式**：不在表里的字段一律拒收。

| 分组 | 字段 | 说明 |
|---|---|---|
| 元数据 | `ruleset_id` | 字符串，必须与会话钉住的规则集一致，否则 `state_version_mismatch` |
| | `state_version` | 非负整数，**严格递增**（见 §5） |
| | `turn` / `phase` | `phase ∈ {battle, replace, ended}` |
| | `mode` | 可选，给了就必须 ∈ `{camp, pve, pvp-local, pvp-live}`；**丢了这个字段 = 线上竞技门控静默失效** |
| | `result` / `needs_replacement` | 结算结果与补位队列 |
| 己方 | `self.active`、`self.pets[]`、`self.skills[]` | 己方全体公开：`slot/pet_id/name/types/stats/class/stage/hp/max_hp/energy/fainted/statuses/marks/buffs` |
| 对手**场上** | `opponent.field` | 与己方**同一套字段**（名字/系别/血条/能量都画在屏幕上） |
| 对手**后备** | `opponent.bench[]` | **只有** `{slot, fainted}`。多任何键 → `hidden_field_leaked` |
| 未核验机制 | `unsupported[]` | 每条**必须带 `reason`**，缺了就拒（`unsupported_without_reason`） |

硬约束（缺一条就 `GameAdapterContractError`，**不静默兜底**）：

- `hp` / `max_hp` / `energy` 必须是有限数字——不是 `null`、不是字符串、不是 `NaN`；
- `statuses` 必须是对象（没有就 `{}`，不是 `null`）；
- `self.active` 必须在 `self.pets` 范围内（越界 = 拒绝，不是取模）；
- 对手后备**一个额外字段都不许有**。

## 2. 合法动作（`validateActions`）

**这一回合所有合法动作**，每条带结构化字段。核心**不自己实现规则结算**：动作表是宿主的规则引擎给的。

| 字段 | 要求 |
|---|---|
| `kind` | ∈ `{skill, switch, item, escape}`；别的类别 = `unknown_action` 拒 |
| `label` | 玩家看到的名字（字符串，非空） |
| `skill_id` + `power` + `power_status` | 技能动作必填 id；**威力与出处必须成对** |
| `target_index` | 换人动作必填非负整数 |
| `item_id` / `label` | 道具动作至少要能认出是哪个道具（宿主给「使用回复药」这种动作句子时，适配层做一次可核对的剥壳） |

**威力与来源状态的硬约束**（这是 fail closed 的核心）：

- 有数值 ⇒ 必须 `power_status = static_value_present`；否则 `unverified_power_without_status`；
- 没有数值 ⇒ 必须明确 `not_provided_by_source` / `unsupported`，并带上一句原因
  （`power_reason`：`来源未给威力（power_status=…），不近似成普通伤害`）；
- **不许把「不知道威力」近似成 0 或普通伤害**——这是这套系统最危险的失败模式。

## 3. 战斗生命周期与事件流（`validateEvents`）

生命周期事件按顺序发，乱序即拒：

```
match-start → turn-start → action-resolved → replacement-required → match-end
```

每条事件必须带：

| 字段 | 要求 |
|---|---|
| `kind` | 事件类型（生命周期四类之外允许引擎自定义） |
| `turn` | 非负整数 |
| `state_version` | **它属于哪一版状态**；增量事件靠它判新旧，回退即 `state_version_not_monotonic` |
| `text` | **中文文案**——玩家唯一会读的东西；核心**不许自己造句** |
| `evidence` | 原始出处（数组；引擎当前给的是快照行号）。没有出处就给空数组，**不许省略** |
| `detail` / `extra` | 引擎原始 JSON（只给开发者抽屉，玩家看不到） |

## 4. 玩家偏好、拒绝与长期记忆

| 入口 | 契约 |
|---|---|
| `host.readPreference()` | 返回 `{verbosity, voice, hintBudgetPerMatch, cooldownMs, interventionMode, refusals[], memory}` |
| `refusals[]` | 每条必须带 `kind ∈ {review, advice, proactive, memory-write}`、`expires_at`（**时效**）、`said`（玩家原话）。过期的条目在校验时被过滤掉 |
| `host.writeMemory(entry)` | 必须带 `kind`；适配层补 `at_ms`。核心**不直接碰宿主的存储** |

## 5. 状态版本与取消语义

- `state_version` **严格递增**：`acceptState` 收到 ≤ 当前版本直接拒（回退 / 重复一律不接受）。
- 新一版到来时，**在飞的建议整条作废**：适配层对 `inflight` 调宿主提供的 `signal.abort()`，
  并把取消记成 `{reason:'state-advanced', from, to}`。
- **迟到结果必须被丢弃**：`acceptResult(version)` / `isStale(version)` 是唯一判据。
  丢弃分两种理由，都进 `adapter.lateDiscards()`：

  | 理由 | 什么时候 | 含义 |
  |---|---|---|
  | `state-advanced` | 结果所属版本 ≠ 当前版本 | 这份数据描述的局面**已经不存在** |
  | `after-deadline` | 版本没变，但总时限已过 | 局面还在，但这条建议已经被规则短提示替换过了 |

- 建议本身也带版本：返回时版本已变 → `text` 置 `null`、`fallback: true`，**整条丢弃**。

## 6. 建议总时限（默认 3000ms）与回退

`adapter.advise()` 的流程（`ADVICE_DEADLINE_MS = 3000`）：

1. **规则短提示先拿到手**：纯函数检测器（`kernel.detect` + `kernel.decide`），无网、无模型；
2. 向宿主取规划，**带时限**；
3. 超时 / 状态推进 / 宿主报错 → **立刻回退规则短提示**，
   `fallback: true` + 可核对的 `fallback_reason`，并把迟到的结果记进 `discarded[]`。

实测（`reports/roco/adapter-load/adapter-load.json`，本机 Node + 本机 Python 子进程）：

| 路径 | 数字 | 来源 |
|---|---|---|
| 正常路径完整 advice | P50 **64 ms**、最大场景 P95 **76 ms**（64 个窗口） | `npm run roco:adapter-load` |
| 复杂环境（最多 10 个合法动作、双方满编） | advice P95 **81 ms** | 同上 |
| 超时路径（宿主挂起，时限 1500ms） | P50 **1502 ms**、回退发生 **24/24 = 100%** | 同上 `advice_timeout_path` |
| 检测器（纯函数，48 只 × 各 5 次） | P50 **0.021 ms**、P95 **0.049 ms**、max **0.928 ms**（n=240） | 同上 |
| 检测器（打完整局，含状态异常回合） | P50 **0.054 ms**、P95 **0.114 ms**（n=55；带异常 n=9，P95 0.078 ms） | 同上 |
| `unsupported` 探测率 | **1.0**（2/2 机制探测被引擎明确拒绝；对照探针成功） | 同上 |

**不声称什么**：

- 这些数字**不是**手游真机上的端到端延迟——它是本机 Node + 本机 Python 子进程；
- 不是真人玩家的体验数据，也不是胜率或效果证明；
- 「超时率 1.0」是**构造**出来的（宿主被故意挂起），不是线上观测到的超时率；
- 检测器的微秒级数字只说明「它是查表判定」，不代表端到端体验。

## 7. 已知缺口（如实记录，不修成绿的）

| 缺口 | 现状 | 证据 |
|---|---|---|
| 事件级 `evidence` 是**行号**，不是 `…json#实体` | 引擎就是这么给的；宿主可见层收到的也是行号 | mock-host 场景 c3 的 actual |
| ~~精灵/技能级 `evidence_ids` **没有**透到宿主可见层~~ **（已修，第 61 轮）** | `/rules/query` 的 roster 回执逐只带 `ev:<ruleset>:pets.json#<pet_id>`、逐招带 `ev:<ruleset>:skills.json#<skill_id>`；`src/server/roco-service.js` 的映射层两个分支（不传参数 / 分页）都搬出来，Answer 级那条也有了顶层出口。孤儿技能（`missing_in_skills_json`）**不编**出处，`evidence_ids` 是空数组 | 判据：mock-host 场景 c3「⑥ 精灵/技能级 evidence_ids 透到宿主可见层…」+ 同组反证；`roco/tests/test_roster_evidence.py`（9 例含反证）；`tests/evals/roco/roster-evidence.test.js`（含反证） |
| RL 判定层在页面上默认 `off` | 默认档位不改任何结论；`on` 仍需真人审阅 | `docs/roco/PROGRESS.md` / `docs/roco/W5-04-INTERVENTION-GATE.md` |
| 手游真机指标 | 未做 | — |

## 8. 换宿主时要改什么

1. 实现 §1–§4 的宿主方法（`telemetry` / `legalActions` / `events` / `plan` / `proposeTool` /
   `allowedTools` / `readPreference` / `writeMemory`）；
2. 用 `createGameAdapter({host, kernel, rulesetId, deadlineMs})` 装配——
   **缺任何一个能力都在装配期抛错**（`kernel_capability_missing@host.<name>`），不会变成运行期降级；
3. 跑 `npm run test:game-adapter`（纯契约，无依赖）与
   `npx node --test tests/evals/roco/mock-host-integration.test.js`（需要 python3）；
4. 字段语义有变化 ⇒ **改版本号**，别在原版本上偷偷扩字段。
