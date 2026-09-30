# 分计划 01 只读勘察报告 · 公开观察与决策快照契约

**勘察人**：`plan01-recon`（只读，未改任何源码） · **时间**：2026-09-30 16:38–16:45（Asia/Shanghai）
**仓库**：`/Users/serendizc/Developer/roco-coach` · **分支**：`wip/roco-coach-2026-09-30-1418`
**基线 HEAD**：开工时 `f418fda`，收尾时已推进到 `4345045`（`fix(engine): 复合子句闸接进共用读数（289 关 triggered_ramp 必须 PARTIAL）`，Lead 侧 00 的提交）
**只读核对**：开工时 `git status --porcelain` 为 `M roco/src/roco_env/coverage.py`（Lead 的 00 修复）；收尾时该项已被 Lead 提交
**引擎导入**：`IMPORT_OK`（00 的 coverage 修复已生效）· **用户 8765**：`available:true`（只读探活，未重启）

**本文性质**：任务指令书。每条论断都带 `文件:行号` 或可复跑命令读数。**「必须留下的结果」= 待办，不是已完成。**

---

## 0 · 结论摘要（先看这五条）

1. **Codex 点名的那条链成立，且比它说的更宽**：引擎里不是两条并行协议，是**三条**——`public_planner_state`、`ui_public_view`、`observation_for`（`roco/src/roco_env/schema.py:485`，`env.observe()` 的唯一实现）。三者对「对手后备」给出**三种不同答案**。
2. **最大的泄漏不在后备，在 `legal.enemy`**：`ui_public_view.legal.enemy`（`env.py:4377-4380`）里对手**场上那只是完整真实配招**——实测 9/9 seed、回收率 **1.000**（`raw-foe-legal-leak.json`）。`env.py:4370` 那句「对手的技能表从来不在公开视图里」与实际读数矛盾。
3. **`opening_roster_revealed` / `match_id` / `event_seq` / `decision_id` 在 Python 侧零命中**（全仓 grep：`roco/**/*.py` 0 处）。`match_id` 的最接近等价物是 Node 侧的 `state.battleId`（`src/client/roco.js:4949`、`roco-experience.js:53`），引擎**不认识**它。
4. **四条历史断言会挡住 01 的实现**（详见 §5）：`roco/tests/test_public_planner.py:43-48` 与 `tests/roco-battle-context.test.js:124` 把「对手后备**不得**带 id」钉死；而 `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53` 与 01-PLAN:27/38 要求「预览实际展示的物种/顺序属于已观察」。**必须显式改钉 + 写理由，不能反向拟合。**
5. **不变性预演的基线是绿的**：只换真实 seed（`raw-leaks.json` Q4a）与只改对手后备真实血量/能量（Q4b），公开面逐字段相同。这是 01.6 的起点，不是终点。

---

## 1 · 现状读数：三个公开面各给了什么

### 1.1 逐字顶层字段名（真实读数，非源码推断）

复跑：`cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-01-fields.py`
原始：`raw-fields.json` · `raw-public_planner_state.json` · `raw-ui_public_view.json` · `raw-observation_for.json`

| 公开面 | 实现位置 | schema 常量 | 体积 | 顶层键（逐字） |
|---|---|---|---|---|
| `public_planner_state` | `roco/src/roco_env/env.py:4078` | `PUBLIC_PLANNER_SCHEMA_VERSION=1`（`env.py:4069`） | 1748 B | `assumptions` `opponent` `phase` `result` `ruleset_config_id` `ruleset_id` `schema_version` `self` `side` `state_version` `turn` `unverified_overrides` |
| `ui_public_view` | `roco/src/roco_env/env.py:4257` | `UI_PUBLIC_VIEW_SCHEMA_VERSION=1`（`env.py:4210`） | 9898 B | `legal` `notes` `opponent` `phase` `result` `ruleset_config_id` `ruleset_id` `schema_version` `self` `side` `state_version` `turn` `unverified_overrides` |
| `observation_for` | `roco/src/roco_env/schema.py:485` | **无** | 1463 B | `opponent` `phase` `result` `ruleset_id` `self` `side` `state_version` `turn` |

> ⚠ 三者的可选键（`mana` / `weather` / `ruleset_config_id`）在本次读数里**恰好都不出现**（默认 legacy 配置无魔力、无天气、无 config id）。上表是「本次读数」，不是「全集」——判据要按「有/无该能力」分别覆盖。

### 1.2 `self` / `opponent` 的逐字键名

| 路径 | 逐字键 | 位置 |
|---|---|---|
| `public.self` | `active` `items` `loadouts` `pets` | `env.py:4185-4191` |
| `ui.self` | `active` `energy_charge` `energy_max` `items` `loadouts` `magic` `pets` `skills` | `env.py:4355-4374` |
| `observation_for.self` | `active` `items` `pets` | `schema.py:570-574` |
| `public.opponent` | `active` `bench` `field` `living_count` | `env.py:4192-4201` |
| `ui.opponent` | `active` `bench` `energy_charge` `energy_max` `field` `living_count` | `env.py:4382-4395` |
| `observation_for.opponent` | `active` `field` `living_count` `pets` | `schema.py:575-584` |

### 1.3 逐宠行的逐字键名（本次读数，按 paths 展开）

```
public.self.pets[0]        = buffs charging defense_cooldown energy entered_turn fainted hp marks max_hp pet_id slot statuses
public.opponent.field      = charging defense_cooldown energy fainted hp marks max_hp pet_id slot statuses
public.opponent.bench[0]   = fainted pet_id slot                      ← ★ 泄漏点 A
ui.self.pets[0]            = buffs charging class defense_cooldown energy entered_turn fainted hp marks max_hp name pet_id slot stage stats stats_source statuses types
ui.opponent.field          = charging class defense_cooldown energy fainted hp marks max_hp name pet_id slot stage stats stats_source statuses types
ui.opponent.bench[0]       = fainted slot                             ← 只有 2 个键
observation_for.opponent.pets[i≠active] = active fainted field name pet_id slot   ← ★ 泄漏点 B
observation_for.opponent.pets[active]   = active energy fainted field hp marks max_hp name pet_id slot statuses
```

### 1.4 两者不一致的**确切位置**（Codex 点名的那条链，逐行钉死）

| # | 位置 | 事实 |
|---|---|---|
| **A** | `env.py:4197-4200` `public_planner_state` 的后备推导式 `{"slot", "pet_id", "fainted"}` | 规划器拿到对手**全部后备物种身份** |
| **A′** | `env.py:4394-4395` `ui_public_view` 的同名投影 `[{"slot", "fainted"}]` | UI 侧**故意剥掉** `pet_id`（`env.py:4387-4393` 写了理由：「手游里后备直到上场才亮明，提前给 id 等于泄露对手阵容」） |
| **A″** | `env.py:4553` `state_from_public_planner` 里 `state.enemy.loadouts = {p.pet_id: rs.candidate_moveset(p.pet_id) ...}` | 规划器靠 A 给的 `pet_id` 就能反查**规范配招**——「后备没有配招」在语义上不成立 |
| **A‴** | `env.py:4091-4133` `own_pet()` 带 `panel`/`individual_source`/`individual_id`/`panel_projection`/`individual_level`；`env.py:4135-4148` `foe_field_pet()` **一个都不带** | 设计上对手个体真值被隔离 ✅（但见 §3.6 的不确定点） |
| **B** | `schema.py:540-549` `foe_bench_pet()` 返回 `{"slot", "pet_id", "name", "fainted", "field", "active"}` | `observation_for` 同时泄漏**后备 id 与真名**；而 `schema.py:486` docstring 自称「隐藏信息的唯一边界」，`schema.py:491` 写「只看得到…后备的存活与否」——**文档与实现矛盾** |
| **C** | `env.py:4377-4380` `ui_legal = {"player": ui_legal_actions(...), "enemy": ui_legal_actions(state, rs, "enemy")}` | UI 视图里塞进**对手的完整合法动作表**（见 §3.4，实测回收率 1.000） |

**consumer 逐条对照**（同一条链的下游）：

| 消费点 | 读的是 | 位置 | 结果 |
|---|---|---|---|
| Node 桥 UI 白名单 | `result.ui` 优先，`ui.opponent.bench[].{slot,fainted}` | `src/server/roco-service.js:163`、`:192-195`、`:230-231` | 后备**只** slot+fainted ✅ |
| Node 桥 planner 面 | `result.public`，**原样**交给 `/battle/plan` | `src/server/roco-service.js:313-317`（`plannerPublicOf`）、`:2838-2840` | 后备 `pet_id` **进了规划器** ⚠ |
| 浏览器渲染后备 | `` `第 ${(b.slot??0)+1} 位` `` | `src/client/roco.js:959`、`:2830-2834` | 画成「第 N 位」 |
| 教练上下文快照 | `view.opponent.bench` → `{slot, fainted}` | `src/client/roco.js:4968-4972` | 后备 id **不入包** |
| 教练上下文校验 | `foe_bench` 只收 slot/fainted | `src/server/index.js:359-366` | 结构性拒绝 id |
| 经验层投影 | `{ id: entry.pet_id ?? null, name: entry.pet_id ?? null, ... }` | `src/coach/roco-experience.js:102` | **这行现在是死代码**（UI 后备无 `pet_id` ⇒ 恒 `null`）；加了预览它才会活 |
| 建议层读后备 | `rawFoe?.bench` | `src/coach/coach-advice.js:290` | 同上 |
| 对手信念白名单 | 注释声明「与 `public_planner_state` 逐条对齐（对手后备只有位次/id/是否倒下）」 | `src/coach/opponent-belief.mjs:24`、`:82`、`:101-102` | **口径取自 A，不是 A′** ⇒ 改契约会让这份白名单的声明失效 |
| 回放/展示 matchId | `rocoGameView(view, {matchId})` → `game.id` | `src/coach/roco-experience.js:53`、`src/client/roco.js:3585-3586` | match id **已存在**，但在 Node，不在引擎 |
| 工具契约 | `simulate_branch` 合同写「一局三只」 | `src/coach/toolbox.js:161` | ⚠ **与实际六宠模式不符**（`toolbox.js:158-160` 的 `compare_team_change` 同样写 3 只）——见 §5.5 |

**已有的 `state_version` 口径（三条链一致）**：`env.py:4162`（public）、`env.py:4413`（ui）、`schema.py:563`（obs）都读同一个 `state.state_version`；`env.py:827-830` `_bump()` 每发一个事件 `state_version += 1`，是**整局单调计数器**。`service.py:2960-2971` `_coerce_state_version()` 把它当「这条事实对应哪个状态」的钉子；`src/server/index.js:382-385` 用它做「规划与战况必须同一版」的跨字段校验。

---

## 2 · 缺口清单：01-PLAN 每一步 × 当前代码

图例：**【已有】**= 能直接用，有证据 · **【半有】**= 有零件但缺契约/缺串联 · **【没有】**= 零命中

### 2.1 版本化观察契约（01.2）

| 要素 | 状态 | 证据行号 |
|---|---|---|
| `rules_version` | 【半有】 | 有 `ruleset_id`（`env.py:4159`）+ `ruleset_config_id`（`env.py:4161`、`env.py:4529`）+ `snapshot_fingerprint`（`service.py` envelope，实测 `4d5c169f…`）。**没有**统一成一个 `rules_version` 字段名 |
| `state_version` | 【已有】 | `env.py:4162` / `:4413` / `schema.py:563`；`env.py:827-830` |
| `match_id` | 【半有】**只在 Node** | `src/client/roco.js:4949`（`state.battleId`）、`roco-experience.js:53`（`matchId`）。引擎 `GameState`（`schema.py:392-429`）**没有**这个字段；`serialize()`（`schema.py:431-444`）也不含 |
| `event_seq` | 【没有】**但底层计数是对的** | 全仓 Python 0 命中。只有每事件的 `turn`（`schema.py:379`）与全局 `state_version`。**同一回合内多个事件的先后只能靠数组下标**（`service.py:2913-2915` 按 `state.events[events_from:]` 切片）。<br>**关键读数（U5 已解，见 §6.5）**：`state_version` 的**唯一写入点**是 `env.py:829` `_bump()`（`grep -rn "state_version\s*+=" roco/src/roco_env/*.py` 只有这 1 处），且实测逐回合恒等于 `len(state.events)`（`reset` 后 `0/0`；每回合 `5/5`、`10/10`、`15/15`…）。⇒ **`state_version` 语义上就是「已追加事件数」，`event_seq = state.events 的 0-based 下标 = 该事件发生后的 state_version - 1`，今天没有任何信息缺口。** 缺的只是：`Event`（`schema.py:375-389`）**不记自己的序号**，一旦被切片/过滤（`service.py:2913-2915`）就无法复原 |
| 事件序号的**稳定性** | 【没有·易踩】 | `service.py:2913-2915` 用 `state.events[events_from:]` 切片下发 ⇒ 回执里的 `events[]` **没有下标信息**，消费方只能按数组位置猜序号。任何过滤/分页（如 `tests` 的 `read_evidence` 按回合取）都会让「位置」与「序号」脱钩 |
| `decision_id` | 【没有】 | 全仓 Python 0 命中。`service.py` 的 `evidence_ids` 用的是 `ev(rs.ruleset_id, "public-state", str(state.state_version))`（`service.py:2920`）与 `ev:…:public-state@<sv>`（`service.py:2317`） |
| 「同一份投影」 | 【半有】**同源但是两次独立调用** | `service.py:2902` 调 `public_planner_state`，`:2906` **再调一次** `ui_public_view`（后者内部又调一次 `public_planner_state`，`env.py:4278`）。共 3 次构造，**没有共享同一份投影对象**。今天 `state_version` 相同所以看不出差别；一旦投影变成「按事件序列取数」，两/三次独立调用就有分叉风险 |
| 观察事件记录（追加式） | 【半有】 | `state.events`（`schema.py:405`）是追加式（`env.py:827-830` `_bump`）；`state.history`（`schema.py:409`）存决策前快照，`env.py:954-955` 存了 `pre_player`/`pre_enemy` 观察。**没有**「公开观察记录」这个独立投影，也没有 source/可见范围字段 |
| `opening_roster_revealed` | 【没有】 | 全仓 Python 0 命中；`events_text.KNOWN_EVENT_KINDS`（`events_text.py:514-545`）里**没有**这个名字 ⇒ 直接加会落到兜底句「发生了一件事（引擎事件 …，本页还没有它的中文说法）」（`events_text.py:509`），并被 `test_event_text.py` 判红 |
| 事件携带 `match_id`/`event_seq` | 【没有】 | `Event` dataclass 只有 `kind`/`turn`/`detail`/`evidence`（`schema.py:375-389`） |

**⚠ 冲突登记（不要反向拟合）**：`docs/roco/execution/EVIDENCE-TEMPLATE.md:19` 已经把 `match_id`、`decision_id/state_version`、`event_seq` 列为「工具或引擎分析还需保留」的字段——**证据模板的要求已经先行于实现**。这不是要改模板迁就代码，而是模板记录的目标尚未落地。

### 2.2 预览前不给六只 / 预览只含实际展示字段（01.3）

| 要素 | 状态 | 证据行号 |
|---|---|---|
| 预览前不给对方六只 | 【没有·且被反向钉住】 | `ui.opponent.bench` 无 id ✅，但：① `public.opponent.bench` 给全部后备 `pet_id`（`env.py:4197-4200`）；② `observation_for` 给全部后备 `pet_id`+`name`（`schema.py:540-549`）；③ **`test_public_planner.py:43-48` 把 ① 钉成必须**；④ `tests/roco-battle-context.test.js:124` 用正则把「后备补 id」判红 |
| 预览事件本身 | 【没有】 | 见 2.1 |
| 无预览模式只记已出场者 | 【没有】 | 无模式概念进入公开投影：投影只吃 `side`，不吃模式（`env.py:4078`、`:4257`）；`ui_public_view` docstring 说 `mode` 由页面读（`roco-experience.js:67`），但引擎侧没有「本模式是否展示预览」这个输入 |
| 记录已出场/已出招 | 【半有】 | `state.events` 有 `switch`/`replacement`/`defense`/各类技能 kind（`events_text.py:514-545`），但没有「这只**已亮明**」的累计集合 |
| 可见状态与资源 | 【半有】 | `hp`/`max_hp`/`energy`/`statuses`/`marks` 在场上那只有（`env.py:4137-4148`）；后备**没有**（正确） |
| 「不把种族参考当个体真值」 | 【半有·可分辨】 | `stats_source` 三态：`individual-snapshot`/`species-panel`/`species-race`（`env.py:4314`/`:4329`/`:4338`）；对手侧本次读数 = `species-race`（`raw-ui_public_view.json`），即图鉴种族值。**带来源 ✅**，但 `public_planner_state` 侧**完全没有** `stats_source`（`env.py:4135-4148` 无此键） |

### 2.3 决策快照固化可回放 / 推测不回写成事实（01.4）

| 要素 | 状态 | 证据行号 |
|---|---|---|
| 决策观察快照 | 【半有】 | `state.history`（`schema.py:409`）在 `env.py:954-955` 存 `pre_player`/`pre_enemy`；`_obs_hash`（`env.py:1134`）对观察取哈希 |
| 同一 decision 的 UI/Coach 同源 | 【半有】 | 同源（都出自 `env.py` 的同一 `state`）但**三次独立构造**（见 2.1） |
| 推测单独存放 | 【半有】 | `public_planner_state.assumptions`（`env.py:4202-4206`，只声明 `opponent_bench=full_hp_nominal_loadout`）+ `service.py` 的 `limitations` 列表（`:2313-2325`） |
| 推测**带来源与不确定度** | 【半有】 | `src/coach/opponent-belief.mjs:88-94` `PUBLIC_FACT_FIELDS` 有 `source` 字段；但那是 **Node 侧自造形状**，引擎侧没有 |
| 可回放 | 【半有】 | `schema.py:431-479` 有反序列化（含老存档缺键的降级：`:473-477`）；`env.py` 有 `replay`。**但**回放里没有 `match_id` ⇒ 「同一局」的身份靠 Node 的 session 表 |

### 2.4 缓存键与旧协议兼容（01.5）

| 要素 | 状态 | 证据行号 |
|---|---|---|
| 绑定局/状态/规则/观察版本 | 【半有】 | Node session 存 `{state, strategy, seed, turn, mode_id, ruleset_config_id}`（`roco-service.js:2321-2322`），**不含观察版本/schema 版本**；`state_version` CAS 只在 `advanceBattle`（`roco-service.js:2361-2372`）与 409 `stale_state` |
| 取消陈旧分析 | 【已有·部分】 | `src/server/index.js:382-385` 跨字段对齐（规划 vs 战况），不一致 400；`roco.js:4991` 注释提到 `rocoPlanFreshness()` |
| 旧数据缺字段降级 | 【已有】 | `schema.py:473-477`（缺 `unverified_overrides` → `[]`；缺 `weather` → `None`）；`roco-service.js:157-158`（无 `result.ui` 退回 `public`） |
| **不补隐藏真值** | 【已有】 | `env.py:4116`（无快照时四个键一个都不出现）、`roco-service.js:176-177`（`undefined` 才带）、`:262-270`（无天气不出现键） |

### 2.5 隐藏变量不变性 / 公开变化正例（01.6）

| 要素 | 状态 | 证据 |
|---|---|---|
| 只改隐藏真值 → 公开面不变 | 【半有·已实测部分】 | `raw-leaks.json` Q4a（换 seed）= `true`；Q4b（改后备真实 `hp`/`energy`）= public/ui/`ui.legal.enemy` 全 `true`。**但**：① 改**对手个体面板**（天分/六维）当前**没有对局内入口**（`foe_field_panel_value = {}`，见 Q4c）；② 改对手后备 `pet_id` **会变**（那是它的「公开」内容）——而按 01-PLAN:27 它**本该**只在预览后公开 |
| 已展示物种/技能变化 → 观察变化 | 【已有·现成】 | `roco/tests/test_public_planner.py:94-102` `test_public_state_is_identical_across_internal_seeds` 是**反向**那条；正向那条要新写 |
| 确定性建议不因隐藏改动而变 | 【已有】 | `test_public_planner.py:104-130` 跨 3 个真实 seed 比规划结果一致 |

---

## 3 · 隐藏信息反例面（全部 grep / 读数，不猜）

复跑：`cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-02-leaks.py` · `python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py`
原始：`raw-leaks.json` · `raw-foe-legal-leak.json`

### 3.1 真实种子（seed）：干净 ✅

- `GameState.seed`（`schema.py:397`）只进 `serialize()`（`schema.py:435`）。
- `public_planner_state` / `ui_public_view` / `observation_for` 三份读数 `hidden_leak_scan` **全为空**。
- 入站守卫：`service.py:265-296` `find_hidden_keys()`（`HIDDEN_KEYS` 匹配，无深度例外）；`service.py:2157-2162` 缺 `public` 直接 400「而不是 `env.serialize()` 的私有状态（后者含真实 seed…）」。
- 测试：`test_public_planner.py:34-41`（blob 里不得出现 `seed`/`pending`/`rng`/`random`，3 个 seed）、`:64-83`、`:140-148`。
- 分析侧：`state_from_public_planner(..., analysis_seed=sv)` 显式用调用方给的种子（`env.py:4447`、`:4530`）；`service.py:2225-2227` 跨种子聚合。

### 3.2 `_pending_*`（对手待执行动作）：干净 ✅

- 全仓 `_pending` 命中 8 处（`grep -n "_pending" roco/src/roco_env/*.py`）：`env.py:945`、`:946`、`:951`（写入 + 注释）、`:2535`（`_opponent_action_of` 读）、`:3145`（`_foe_switched_this_turn` 读）、`:4086`（public docstring 声明不含）、`planner.py:7`、`planner.py:203`（声明不读）。
- 三份公开读数 `hidden_leak_scan` 无 `_pending`。
- 测试：`test_public_planner.py:79-83`。

### 3.3 对手后备物种身份：**泄漏（两个面）** ❌

```
public_planner_state.opponent.bench_pet_ids = ["pet_000190", "pet_000445"]   ← 真实后备物种
ui_public_view.opponent.bench_pet_ids       = [null, null]
observation_for.opponent.bench_pet_ids      = ["pet_000112", "pet_000062"]
observation_for.opponent.bench_names        = ["雪影娃娃", "音速犬"]
```

- 位置：`env.py:4197-4200`（public）、`env.py:4394-4395`（ui，唯一正确的那个）、`schema.py:540-549`（obs）。
- **`observation_for` 为什么重要**：它不只是文档里的名字。`env.py:4556-4558 observe()` 转发它，`opponents.py:1064`/`:1080` 用它给**双方策略**做决策输入，`opponents.py:114-129 _candidates()` 从返回结构**自动展开**白名单，`opponents.py:87-111` 的 `HIDDEN_READS`/`HIDDEN_READ_PATHS` 只记录**越界**读取。⇒ **观察里给什么，策略就能读什么。** 现在双方策略都能读到对手整队身份。
- 现有测试**不会**红：`roco/tests/test_opponents.py:125-133` 只断言后备不得暴露 `hp/max_hp/energy/buffs/statuses/marks`，**没断言 `pet_id`/`name`**。

### 3.4 对手**真实四技能**：**泄漏（浏览器可见载荷）** ❌❌

```
foe_active_pet_id                  = "pet_000417"（圆号鱼）
real_loadout_of_foe_active         = ["skill_000286", "skill_000305", "skill_000418", "skill_000483"]
ui_legal_enemy_skill_ids           = ["skill_000286", "skill_000418", "skill_000483"]
ui.legal.enemy[]                   = {kind, skill_id, skill_name, label, skill:{name,element,category,energy,power,power_status,damage_class,desc,is_trait,effect_support}}
```

- 位置：`env.py:4377-4380`（`ui_legal` 同时算 `player`/`enemy`），装饰函数 `env.py:4213-4242` `ui_action_public()`。
- **六宠模式量化**（`probe-03`，配置 `mobile_s4_candidate_v3`，9 个 seed）：**回收率 1.000（9/9），即浏览器侧能完整复原对手场上那只是哪四招**，且 `extra_not_in_loadout = []`（可见集合**恰好等于**真实配招）。
  - 三宠模式（`probe-02`，seed 20260930）回收 3/4——差异是「防御」是通用动作而非配招，**不构成保护**。
- 下游：`src/server/roco-service.js:242` `cpu_legal_count: Array.isArray(result.legal?.enemy) ? result.legal.enemy.length : null` —— Node 桥**明确知道** `result.legal.enemy` 存在并读了它（只要了条数）。浏览器侧 `publicView()` 只取 `ui.legal.player`（`roco-service.js:234`），**所以这条链今天没有把 `skill_id` 送到浏览器**。
- **但它仍然是边界缺口**，两个理由：
  1. `_sim_envelope`（`service.py:2862-2922`）把 `result.ui` 整份序列化进回执（`:2906`），Node 内存里就有；按 `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:60`「任何一层泄漏，边界都不成立」，这是「差一行就漏」的状态。
  2. `env.py:4370` 的注释逐字写「**对手的技能表从来不在公开视图里**（`observation_for` 同一口径）」——**这句话与 `env.py:4377-4380` 的实际读数矛盾**。注释是错的，而错的注释会让后来的人据此做判断。
- **`observation_for` 侧正确**：`schema.py:518-538` `foe_field_pet()` 不含 `skills`/`loadouts`；`roco/tests/test_opponents.py:129-130` 断言 `loadouts` 越界读取抛 `KeyError`。

### 3.5 对手场上**血条/能量**（`hp`/`max_hp`/`energy`/`statuses`/`marks`）

- **是公开的，且三面一致**：`env.py:4137-4148`、`schema.py:518-538`。依据 `schema.py:521-524`（血条画在屏幕上）。这**不是**泄漏。
- 对手场上**没有** `buffs`（`env.py:4135-4148` 无此键 ✔）、**没有** `entered_turn`（`env.py:4091-4105` 给己方，`:4135-4148` 不给对手 ✔）。
- 对手场上**有** `defense_cooldown` 与 `charging`：`env.py:4146-4147`（public）、`roco-service.js:171-177`（Node 明确转发并写了理由）。
- ⚠ 对照 `schema.py:528-536`：`observation_for` 的对手场上**没有** `defense_cooldown`/`charge`。**三面在「对手场上给了什么」上也不一致**。

### 3.6 对手个体真值（天分/性格/六维/`panel`）

- `PetState.panel` 存在（`hasattr == True`），但对手侧本次读数 `panel == {}`（`raw-leaks.json` Q4c）——`reset()` 的 `individuals` 只按**玩家队伍位次**解析（`env.py:249` `resolve_snapshots(individuals, list(team))`），对手没有注入入口。
- 公开面：`public_planner_state.own_pet()` **只在己方** `p.panel` 非空时带那 5 个键（`env.py:4125-4132`）；`foe_field_pet()` 不带（`:4135-4148`）。UI 侧对手 `stats_source = "species-race"`（`env.py:4332-4339`）＝图鉴种族值，**带来源**。
- ⇒ **当前没有泄漏**；但 `01-PLAN:30` 要求的正例「只改隐藏天分/六维 → 公开不变」**今天无法直接跑**，因为没有对局内改对手个体的入口。**这是不确定点 U1（见 §6）**。

### 3.7 其它泄漏面（读数登记的次要项）

| # | 面 | 读数 | 说明 |
|---|---|---|---|
| 1 | `risk.worst_seed_risks`（`service.py:2282-2286`） | 描述「真实对手动作名」 | 这些名字来自**按 `pet_id` 反查的规范配招**（`env.py:4553`），不是对局真值；但配合 3.3 的后备 `pet_id`，它的「可能性」粒度比公开面允许的更细。**不确定点 U2** |
| 2 | `service.py:2902` + `:2906` 各自独立构造 | 同 `state_version`，但非同一对象 | 见 2.1「同一份投影」 |
| 3 | `service.py:2907` `legal.enemy` 进了**所有**本地对局域回执 | `battle_new`/`battle_legal`/`battle_advance`/`battle_free` | 见 3.4 |
| 4 | `roco/src/roco_env/coverage.py` | 工作区 `M` | **Lead 独占**，本勘察只读、未碰（`git status --porcelain` 仅此一行） |

---

## 4 · 实施清单（最小改动、先契约后前端）

**排序原则**：先补契约与守卫（Python，可独立测），再改 Node 转发，最后前端预览；每步都带必红反例。
**写域红线**：`roco/src/roco_env/coverage.py` **不与任何步骤重叠**（Lead 当前独占）。本清单**不**触碰它。

> **前置条件**：Lead 需先在 `docs/roco/execution/STATE.json.write_owners` 追加 01 的实际写域；在此之前**本勘察不写任何源码**（已遵守）。
> 建议写域（供 Lead 登记）：`roco/src/roco_env/env.py`、`roco/src/roco_env/schema.py`、`roco/src/roco_env/events_text.py`、`roco/tests/**`、`src/server/roco-service.js`、`src/server/index.js`、`src/client/roco.js`、`src/coach/roco-experience.js`、`reports/roco/product-execution/01/**`。**注意 `opponent-belief.mjs` 的口径注释依赖 A**（§1.4）——若它不在写域内，就必须在报告里登记为「已知未同步」。

---

### 步骤 1 — 收口 `public_planner_state.opponent.bench`（先做，最小、影响最大）

- **涉及**：`roco/src/roco_env/env.py:4192-4201`（后备推导式）；`roco/tests/test_public_planner.py:43-48`（**必须显式改钉**）
- **写什么**：把后备的公开性**参数化**，而不是直接删 `pet_id`：默认（无预览）只给 `{slot, fainted}`；预览发生后给 `{slot, pet_id, fainted, revealed_via, revealed_turn}`（字段名待 01.2 定）。理由：删干净会让 `state_from_public_planner`（`env.py:4507-4524`）失去重建对手队列的依据，那是**另一个**功能（规划器需要位次与存活，不需要物种）。
- **通过条件**：无预览时 `public_planner_state.opponent.bench[i]` 的键集 == `ui_public_view` 同位置键集 == `{slot, fainted}`；预览后两者都带同一份已亮明字段。
- **必红反例**：① 无预览局，断言 `"pet_id" not in json.dumps(pub["opponent"]["bench"])`；② 反向控制——把 `pet_id` 塞回去，断言必须红；③ 带预览局，断言 `pet_id` **在**（证明不是恒空实现）。
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner tests.test_ui_public_view tests.test_state_roundtrip -v`
- **风险**：`state_from_public_planner` 在缺 `pet_id` 时走 `env.py:4520-4524` 的占位分支（用 `rs.candidate_movesets` 第一只）——**那会让规划器算错对位**。所以本步必须同时决定「规划器的后备身份从哪来」，不能只改投影。⇒ **建议本步只做「加预览门槛 + 加 `revealed_via` 来源标注」，保留 `pet_id` 但把它标成 `assumed`/`revealed`**，并在 `assumptions` 里如实说。

### 步骤 2 — 定义版本化观察契约（01.2）

- **涉及**：新建契约常量（建议放 `roco/src/roco_env/schema.py`，与 `observation_for` 同文件）；`env.py` 的 `Event` 构造点 `env.py:827-830`
- **写什么**：投影顶层加 `observation_schema_version`、`match_id`、`event_seq`、`rules_version`；`Event.to_dict()`（`schema.py:383-389`）加 `seq`（= 该事件在 `state.events` 里的 0-based 下标，等价于「追加序」）与 `match_id`。
- **通过条件**：`event_seq` 严格单调递增且与 `state.events` 下标一致；同一 `match_id` 内不重复；`match_id` 由 `reset()` 生成并进 `serialize()`/反序列化往返。
- **必红反例**：① 同一回合发 3 个事件，断言 seq 是 `n, n+1, n+2`（今天只有 `turn`，三个都是同一个 turn，**这条现在必红**）；② 两个不同局断言 `match_id` 不同；③ 反序列化往返后 `match_id`/`event_seq` 不变。
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_state_roundtrip tests.test_replay_invariants tests.test_event_text -v`
- **写域**：`env.py`、`schema.py`、`roco/tests/**`（**与步骤 1 同文件 ⇒ 必须串行，不能并行两个写者**）

### 步骤 3 — 注册 `opening_roster_revealed` 事件（01.3）

- **涉及**：`roco/src/roco_env/events_text.py:514-545`（`KNOWN_EVENT_KINDS`）+ 该文件的模板表（`events_text.py:103` `event_text()` 的 23 个 kind 分支）；发出点建议放 `env.py:reset()` 之后或 `service.battle_new` 的封装层（**二选一，先定再写**）
- **写什么**：新 kind 名 + 中文句子模板（玩家句子里**不许出现技能 id**——`events_text.py:223` 的既有纪律）+ 只在「本模式确实展示预览」时追加；记录 `species_id`、展示名/图标、可见顺序、观察时间、`source`
- **通过条件**：`test_event_text.py` 跑真对局收 kind 全集后仍全绿（新 kind 在 `KNOWN_EVENT_KINDS` 里且有句子）；无预览模式**不产生**该事件
- **必红反例**：① 临时从 `KNOWN_EVENT_KINDS` 摘掉新 kind → `test_event_text.py` 必须红；② 无预览模式跑一局，断言事件流里 **0** 条 `opening_roster_revealed`；③ 有预览模式跑一局，断言**恰好 1** 条且 `event_seq` 是首个事件
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_event_text tests.test_ui_public_view -v`
- **注意**：`service.py:2913-2915` 只在 `event == ("battle_advance","battle_free")` 时下发事件（`events_from` 切片）⇒ **`battle_new` 的回执里没有 events**，预览事件必须走另一条路带出去。**这是一处必须先定的接口决定。**

### 步骤 4 — 隐藏真值隔离：`observation_for` 后备 + `ui.legal.enemy`（§3.3/§3.4）

- **涉及**：`roco/src/roco_env/schema.py:540-549`；`roco/src/roco_env/env.py:4377-4380`；`roco/src/roco_env/env.py:4370`（**错注释，必须改**）
- **写什么**：① 后备行按步骤 1 的同一门槛输出；② `ui_legal` 的 `enemy` 键**默认不下发**（或只下发表长），要保留就给一个显式开关并写清消费者（`roco-service.js:242` 只要长度）
- **通过条件**：`ui_public_view` 的 JSON blob 里不含对手的 `skill_id`（除已公开事件中亮过的）；`observation_for` 后备行键集可配置且默认最小
- **必红反例**：① 用 `probe-03` 的口径断言 **回收率 < 1.0**（今天 1.000，**这条现在必红**）；② 反向控制——把 `enemy` 加回去，断言必须红；③ `opponents.py` 的越界读取仍是 0（`test_opponents.py:206-215`）
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_opponents tests.test_ui_public_view tests.test_public_planner -v` + `PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py`
- **风险**：`schema.py` 改后备会改 `observation_for` 结构 ⇒ `opponents.py:114-129` 的白名单**自动收缩**（安全方向）；但 `run_pilot.py:356-374` 会记录 `hidden_field_reads`，若策略读了新字段会产生非 0 —— 那是**预期的红**，要按「策略不许依赖未公开身份」处理。

### 步骤 5 — 同源投影：一次构造、三处引用（01.4）

- **涉及**：`roco/src/roco_env/service.py:2902-2906`
- **写什么**：`_sim_envelope` 里构造一次 `public`，`ui` 由**同一份**派生（`ui_public_view` 已经在内部调 `public_planner_state`，`env.py:4278`——改成接收已构造的那份，或至少断言两者 `state_version` 与投影版本相同）
- **通过条件**：同一次回执里 `result.public` 与 `result.ui` 的 `state_version`、`observation_schema_version`、`match_id` 逐字相同；且断言「只构造一次」（可加计数器）
- **必红反例**：人为让两次调用之间 `state.state_version` 变化（例如在两次调用之间插一次 `_bump`），断言必须**红**——今天这条会**静默通过**
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_sim_endpoints tests.test_six_pet_battle -v`
- **写域**：`service.py` —— ⚠ `STATE.json.write_owners` 里 `roco/src/roco_env/service.py` **当前是 Lead**，本步需 Lead 明确让渡或自做

### 步骤 6 — Node 转发与旧协议降级（01.5）

- **涉及**：`src/server/roco-service.js:163-292`（`publicView` 白名单）；`:2321-2322`（session 存什么）；`src/server/index.js:329-374`（`roco_battle` 校验）；`tests/roco-battle-context.test.js:124`（**必须显式改钉**）
- **写什么**：`publicView` 加 `match_id`/`observation_schema_version`/已见阵容（`seen_roster`）白名单；`roco_battle` 校验器接受**已亮明**的后备条目（与引擎同一门槛，不能自己放宽）；session 缓存键加观察版本
- **通过条件**：`/api/roco/battle/new` 回执的 `view` 里 `match_id` 存在且与 `battle_id` 的关系有据；无预览时 `view.seen_roster` 不出现（**不是空数组**，与 `roco-service.js:262-270` 的无天气同口径）
- **必红反例**：① 无预览回执断言 `!("seen_roster" in view)`；② 带 id 的后备条目在**未亮明**时仍被 400 拒绝；③ 跨局：开两局，断言第二局的 `seen_roster` 不含第一局的任何 `pet_id`
- **可复跑**：`node --test tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js tests/roco-server-side-guard.test.js` + `tests/server.test.js`
- **注意**：`tests/roco-coach-context-contract.test.js:28` 的 `CONTEXT_FIELDS` 是**变更探测器**，加 `context.roco_roster` 之类必须同步改三处（服务端校验 / runtime 进包 / 事实守卫），否则它红得对（`tests/roco-coach-context-contract.test.js:56-58`）

### 步骤 7 — 前端预览与「已见阵容」入口（01.3 的 UI 面）

- **涉及**：`src/client/roco.js:959`（后备渲染）、`:4945-4981`（`coachRocoBattle` 快照）、`src/coach/roco-experience.js:100-102`（后备投影，**那行 `entry.pet_id` 现在恒 `null`，会随本步激活**）
- **写什么**：开局预览层（5–6 秒、可关闭）；「已见阵容」小入口；**新局重置**
- **通过条件**：无预览模式页面**一个字**都不列对方六只；刷新后已见阵容仍在；下一局不继承
- **必红反例**：① 无预览模式的 DOM 文本里不含对方任一只真名（结构断言）；② 开两局后断言第一局的 `pet_id` 不出现在第二局任何渲染路径
- **可复跑**：`node --test tests/roco-battle-context.test.js` + 独立实例真机（**不得**动用户 8765）
- **依赖**：必须在步骤 1–4 之后（否则前端在做「把泄漏画出来」）

### 步骤 8 — 反例矩阵（01.6）

- **涉及**：`roco/tests/**`（新判据）+ 证据目录
- **写什么**：把 §2.5 的两条反例补齐成自动化；隐藏变量用**对局前注入**（`reset(..., individuals=..., loadouts=...)`，`env.py:199-209` 是现成入口——见 U1）
- **通过条件**：固定公开史 + 改对手隐藏个体/配招/后备资源 ⇒ 公开输入逐字段相同；改已展示物种/已公开技能 ⇒ 观察确实变化
- **必红反例**：把 `individuals` 注入改成「公开面也带面板」，断言必须红
- **可复跑**：`cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -q`（**只在服务可停时跑全量**；用户服务活着时按交接文档 §6.2 不跑全量 Node 单测）

---

### 4.1 步骤依赖与串行约束（给 Lead 排程用）

```
步骤1 (env.py bench)  ─┬─> 步骤2 (schema.py Event/契约) ─> 步骤3 (events_text.py) ─> 步骤4 (schema.py obs + env.py legal)
                       │                                                                      │
                       └──────────────────────────────────────────────────────────────────────┴─> 步骤5 (service.py)
                                                                                                     │
                                                                   步骤6 (Node) ─> 步骤7 (前端) ─> 步骤8 (反例矩阵)
```

- **同文件串行**：步骤 1/2/4 都改 `env.py`，步骤 2/4 都改 `schema.py` ⇒ **三步不能并行分给三个写者**。建议：一个 Python 写者串行做 1→2→3→4，另一写者**先只做只读准备**（判据骨架、证据目录）。
- **可并行的**：步骤 6（Node，`src/server/*`）与步骤 1–4（Python）**文件不重叠**，可并行，但步骤 6 的**验收**依赖步骤 1–4 的 schema 定稿 ⇒ 用依赖而不是靠协调。
- **不与 `coverage.py` 重叠** ✅（本清单 0 处触及）。

---

## 5 · 与历史判据的冲突（明确登记，**不为刷绿而反向拟合**）

规则层级：`docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53` + 01-PLAN:27/38 + Codex 修订计划 §先纠正信息边界。**这三条都优先于下面四条历史断言。**

| # | 位置 | 历史断言 | 与当前规则的冲突 | 建议处置 |
|---|---|---|---|---|
| **X1** | `roco/tests/test_public_planner.py:43-48` | `assertEqual(set(entry.keys()), {"slot","pet_id","fainted"}, "对手后备只应有位次/id/是否倒下；血量与配招是隐藏信息")` | 01-PLAN:27「预览事件只包含实际展示字段」+ 01-PLAN:38「预览发生前及无预览模式没有提前泄漏阵容」⇒ 「无预览时给 `pet_id`」**就是泄漏** | **改钉**：拆成「无预览 ⇒ `{slot, fainted}`」+「预览后 ⇒ `{slot, pet_id, fainted, revealed_via}`」两条；在测试 docstring 里写清依据变更（`PRODUCT-VISION-AND-ROADMAP.md:53` 与 Codex 修订计划纠正了此前的「后备身份一律隐藏」判断） |
| **X2** | `tests/roco-battle-context.test.js:124` | `assert.ok(!/bench[\s\S]{0,120}pet_id/.test(CLIENT_SRC), '对手后备不许补 pet_id（那是公开面之外的信息）')` | 同上；且该断言是**正则**，`bench` 后 120 字符内的任何 `pet_id` 都会命中 ⇒ 加预览字段会**误伤** | **改钉**：改成「后备的 `pet_id` 必须来自 `view.seen_roster`（已亮明）而不是从 `public.opponent.bench` 直取」的结构断言；同时保留一条「无预览时不得出现」 |
| **X3** | `roco/tests/test_opponents.py:125-133` | 只禁后备的 `hp/max_hp/energy/buffs/statuses/marks`，**不禁** `pet_id`/`name` | `schema.py:486`/`:491` 自称「隐藏信息的唯一边界」「只看得到后备的存活与否」——**文档已承诺但测试没守** | **补钉**（不是改钉）：加断言 `pet_id`/`name` 在后备行的**默认**投影里不存在 |
| **X4** | `src/coach/opponent-belief.mjs:24`、`:82`、`:101-102` | 注释声明公开性口径「与 `public_planner_state` 逐条对齐（对手后备只有位次/id/是否倒下）」 | 一旦 X1 改钉，这份声明**指向的口径就变了**（后备 id 有/无取决于预览） | **同步注释 + 让信念层显式吃「已亮明」而不是「后备 id 全给」**；否则它会把「规划器能看」误当成「已观察」 |

### 5.1 另一类冲突：工具契约与模式规模不符（**不在 01 范围，但会污染证据**）

- `src/coach/toolbox.js:161` `simulate_branch` 写「一局三只」；`:158-160` `compare_team_change` 写「引擎按 3 只队伍算；六只阵容的对比尚未支持」。
- 实测：`mobile_s4_candidate_v3` 每方 **6** 只（`env.py` `cfg.require_team_size()`，`rule_config.py:1261` 上下文）。
- ⇒ 若 01 的证据里引用工具契约的这句话，会与真读数矛盾。**登记为待办，不在本分计划改**（工具契约不属于 01 写域）。

---

## 6 · 不确定的点（**明确标注，不猜**）

| # | 不确定什么 | 我查到哪一步 | 需要谁/什么才能定 |
|---|---|---|---|
| **U1** | 「只改对手隐藏天分/六维」这条反例**今天怎么跑** | `reset()` 有 `individuals` 入参（`env.py:199-209`、`:249`），但 `_individuals.resolve_snapshots(individuals, list(team))` 只按**玩家**队伍位次解析；对手侧 `panel == {}`（`raw-leaks.json` Q4c）。我**没有**找到对局内改对手个体的入口 | 需要 01 实施者确认 `individuals` 能否按 `enemy_team` 注入；**不确定**，故 §4 步骤 8 只写「用 `reset(..., individuals=...)` 这条现成入口」，未断言一定可用 |
| **U2** | `service.py:2282-2286` `risk.worst_seed_risks` 的动作名是否算泄漏 | 名字来自 `state_from_public_planner` 按 `pet_id` 反查的**规范配招**（`env.py:4553`），不是对局真值。但它与「对手场上那只是哪四招」（§3.4，实测已 100% 可复原）叠加后，可能让建议显得比公开面更确定 | 需要产品口径裁决「规范配招算不算公开」——**我倾向按 `opponent-belief.mjs` 的既有口径（图鉴可能招式 ≠ 对方一定携带）处理，但这是我读到的既有约定，不是我的裁决** |
| **U3** | 预览事件的**发出层**：引擎 `env.reset()` 还是 `service.battle_new` | ① `env.reset()` 里发 ⇒ 进 `state.events`，但 `service.py:2913-2915` 只在 `battle_advance`/`battle_free` 下发事件 ⇒ `battle_new` 回执拿不到；② 在 `service.battle_new` 发 ⇒ 不进 `state.events`，回放/序列化看不到 | **这是 01.3 的第一个接口决定，必须先定**。我只登记两条路的后果，不替它选 |
| **U4** | 「本模式是否展示预览」的来源 | 引擎投影只吃 `side`（`env.py:4078`、`:4257`），没有模式输入；`roco-experience.js:67` 从 `view.mode` 读（而 `mode_id` 是 **Node 侧**加的，`roco-service.js:289`） | 需要定：模式开关放规则配置（`rule_config.py`）还是 Node 侧？**不确定** |
| **U5** | ~~`state_version` 是否够当 `event_seq`~~ **已解** | **是，够了。** 见 §6.5：`state_version` 的唯一写入点是 `env.py:829`（全仓 grep 只此一处），实测恒等于 `len(state.events)`（`reset` 后 `0/0`，逐回合 `5/5 → 10/10 → … → 30/30`）。⇒ 序号信息**不缺**，缺的是事件行不携带自己的序号 | 已由本勘察读数解决，**不再是不确定点** |
| **U6** | `mobile_s4_candidate_v3` 是不是「标准六宠」的当前生效配置 | 我用 `config="mobile_s4_candidate_v3"` 跑出 6 只（`probe-03`）；但 `rule_config.py:814` 注释写的是 v3 / `pvp-standard-six-pet`，而 `pvp-standard-six-pet` **不是合法 config id**（`RuleConfigError`） | 需要确认「标准 PVP」默认走哪份配置；**未确认** |
| **U7** | 用户 8765 常驻进程加载的是哪一版代码 | 只读读到 `available:true`、`snapshot_fingerprint:4d5c169f…`（`curl -s localhost:8765/api/roco/status`）；B1 明确「只能只读探活」 | 需要用户授权重启才能确认；**不得**据此宣称玩家端已生效 |

### 6.5 · U5 的解法与读数（本条已从「不确定」升级为「已实测」）

```
$ grep -rn "state_version\s*+=" roco/src/roco_env/*.py
roco/src/roco_env/env.py:829:    state.state_version += 1        ← 全仓唯一写入点（其余出现都是读取/构造参数）

$ cd roco && PYTHONPATH=src python3 -c "<reset + 连续 step_joint，逐回合打印>"
after reset: state_version= 0  len(events)= 0
turn 2  state_version= 5   len(events)= 5   equal= True
turn 3  state_version= 10  len(events)= 10  equal= True
turn 4  state_version= 15  len(events)= 15  equal= True
turn 5  state_version= 20  len(events)= 20  equal= True
turn 6  state_version= 25  len(events)= 25  equal= True
turn 6  state_version= 30  len(events)= 30  equal= True
```

**结论（供 01.2 直接用）**：`event_seq` **不需要新计数器**。语义就是「该事件的 0-based 追加序号」，其值等于「该事件发生后的 `state_version` − 1」。要补的是**把序号写进事件行**（`Event.to_dict()`，`schema.py:383-389`），否则 `service.py:2913-2915` 切片之后就复原不出来。**这降低了 01.2 的实施成本，也意味着 01.2 不需要动 `_bump` 或其调用点。**

---

## 7 · 复跑命令（都能直接粘贴）

```sh
cd /Users/serendizc/Developer/roco-coach

# —— 引擎可用性（00 的前置）——
cd roco && PYTHONPATH=src python3 -c "import roco_env.service; print('IMPORT_OK')" && cd ..

# —— 本勘察的三支只读探针（不写源码/数据）——
cd roco
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-01-fields.py
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-02-leaks.py
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py
cd ..

# —— 公开边界的既有判据（本次读数：Ran 34 · OK）——
cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner tests.test_ui_public_view tests.test_replay_invariants -v && cd ..

# —— Node 侧三条点名判据（本次读数：tests 20 · pass 20 · fail 0）——
node --test tests/roco-coach-context-contract.test.js tests/roco-battle-context.test.js tests/roco-server-side-guard.test.js

# —— 零命中的反证（应当全为 0，除了文档）——
grep -rn "opening_roster_revealed" roco/src src/ | wc -l          # 期望 0
grep -rn "event_seq\|decision_id" roco/src/ | wc -l               # 期望 0
grep -rn "match_id" roco/src/ | wc -l                             # 期望 0

# —— U5：event_seq 的底层计数是现成的（读数存 raw-event-seq-baseline.txt）——
grep -rn "state_version\s*+=" roco/src/roco_env/*.py             # 期望只有 env.py:829 一处

# —— 只读探活（不得重启）——
curl -s localhost:8765/api/roco/status | head -c 200
```

---

## 8 · 附件（本勘察产物，全部在 `reports/roco/product-execution/01/`）

| 文件 | 内容 |
|---|---|
| `recon.md` | 本文 |
| `probe-01-fields.py` | 三份公开面的逐字键名与体积 |
| `probe-02-leaks.py` | 隐藏真值扫描 + 不变性预演（Q1–Q4） |
| `probe-03-foe-legal.py` | `ui.legal.enemy` 对手配招回收率（9 seed × 六宠） |
| `raw-fields.json` | 逐字键名对照（机器可读） |
| `raw-public_planner_state.json` | 真实读数：规划协议全量 |
| `raw-ui_public_view.json` | 真实读数：UI 视图全量 |
| `raw-observation_for.json` | 真实读数：观察边界全量 |
| `raw-leaks.json` | 泄漏扫描与不变性预演结果 |
| `raw-foe-legal-leak.json` | 对手配招回收率逐 seed 明细 |
| `raw-event-seq-baseline.txt` | §6.5 U5 读数：`state_version` 唯一写入点 + 恒等于 `len(state.events)` |

**未做的事（边界声明）**：未改任何源码（`roco/src/**`、`src/**`、`roco/tests/**` 一律只读；开工时工作区唯一改动 `M roco/src/roco_env/coverage.py` 属 Lead，收尾前已被 Lead 提交）；未改 `docs/roco/execution/**`（STATE.json 归 Lead）；未改 `README.md` 与 `docs/roco/PRODUCT-VISION-AND-ROADMAP.md`（后者仅只读引用）；未 commit / push；未重启 8765；未清数据；未训练。**本次唯一新增物 = `reports/roco/product-execution/01/` 目录。** 等 Lead 在 STATE.json 追加写域后再动手改代码。
