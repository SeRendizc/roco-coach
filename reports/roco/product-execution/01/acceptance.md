# 分计划 01 验收说明（公开观察与决策快照契约 · 引擎侧 + Node 转发）

**提交**：`5002433`（远端 SHA 已核 `5002433309be2f902498a15a74c7522a02d04353`；其后 `3cc3010` 只改 STATE.json）
**树指纹**：`TREE 2c5da5f9a273698d00c837568765a877b1e9073081083731f310de876050348d`（`roco/src` `cb7e5c39…` / `roco/tests` `7e9859d0…`，全量跑前跑后两次相同 —— **冻结提交 `5002433` 那一棵**）。
⚠ **收尾之后** plan00-closer 的 D-8 改动落在 `roco/src/roco_env/coverage.py` + `roco/tests/test_effect_coverage.py`（他人的在飞改动，不在本切片）⇒ 当前工作区 TREE 已是 `d22269baad6fd2363a198f687ac0f66d41489087ff7c2637448ca8ed9f347639`。本验收件引用的读数都属于冻结那一棵。
**完整字段清单**：见 [result.json](result.json)（含每条命令的 cwd/退出码/日志路径与逐文件 hash）。

---

## 1 · 玩家问题与本次结果

**问题**：玩家、UI、教练、规划器、复盘五方看到的「同一局事实」必须可追溯、且不得互相泄漏隐藏信息 ——
包括「开局预览之前不许知道对手六只」「已经出场的、已经打出的才算公开」「同一次决策在三处要能对上号」。

**结果**（01 的六步在引擎侧与 Node 转发范围内落地）：

- **观察契约（01.2）**：`match_id` / `rules_version` / `decision_id` / `event_seq` 四处同源；
  `event_seq` 由既有 `state_version` 口径派生（**没有新计数器**），切片下发后仍可复原。
- **开局预览（01.3）**：`opening_roster_revealed` 事件发在 `service.battle_new`
  （请求 `opening_preview:true`），`state.events` 留同源一条、回执 `opening_reveal` 就是那一条；
  **无预览 ⇒ 零事件、公开面逐字节不变**。
- **同源对照（01.4）**：同一 `decision_id` 下 UI / 工具输入 / 回放三处一致；回放复现同一条观察序列。
- **缓存键与旧协议（01.5）**：Node session 绑 `(match_id, battle_id, state_version, rules_version)`，
  串局 ⇒ **409 `match_mismatch`**；`roco-client.js` 白名单加 `openingPreview`（不加就静默丢掉）。
- **反例（01.6）**：固定公开史改隐藏真值 ⇒ 公开输入逐字段相同；改已展示物种/已公开技能 ⇒ 观察确实变化。

**不宣称完成的**：前端渲染（属 02）；玩家常驻版本（本机 8765 未运行 ⇒ 不可得）。

---

## 2 · 改了哪些文件及原因（完整清单见 result.json）

| 文件 | 为什么改 |
|---|---|
| `roco/src/roco_env/env.py` | 观察契约派生（5 个函数）+ 开局预览事件 + 后备行身份/来源 + 两公开面接 `revealed` 块 |
| `roco/src/roco_env/schema.py` | `revealed_facts`（事件流 → 已亮明事实，**唯一实现**）+ `observation_for` 的条件键 |
| `roco/src/roco_env/service.py` | 回执顶层契约字段 + 事件行 `seq` + `battle_new` 收 `opening_preview` + `battle_plan` 原样回吐 |
| `roco/src/roco_env/events_text.py` | 新 kind 的中文句 + 登记进 `KNOWN_EVENT_KINDS`（漏登记 ⇒ 玩家看到兜底句） |
| `roco/src/roco_env/regression.py` | `state_digest` 收窄为「剔除 history」（Lead 授权）+ 另立 `history_digest`（不制造盲区） |
| `roco/tests/*`（5 个文件） | 新增判据 23 条 + `history` 指纹按规矩改钉（原值留档 `*_PRIOR_2026_09_30_REVEAL`） |
| `reports/roco/rc404/regression-set.json` | 上面的收窄的**必然产物**（Lead 已批准算本切片） |
| `src/server/roco-service.js` | `publicView` 转发契约字段 + `seen_roster` + `revealed_skills`；session 四元组 + `matchMismatch` 守卫；`opening_preview` 转发 |
| `src/coach/roco-client.js` | `battleNew` 白名单加 `openingPreview`（该函数显式解构，不加就静默丢掉） |
| `tests/roco-observation-contract.test.js` | 新增 8 条 Node 契约判据（含两条反向用例） |

---

## 3 · 通过条件逐条对账

| # | 01-PLAN 通过条件 | 判定 | 原始证据 |
|---|---|---|---|
| ① | 公开输入中没有未观察的隐藏个体值、四技能和对手待执行动作 | **pass** | `raw-align-verified-after.json`（对手技能 UI 可见回收率 0.00）· `test_opponents.py::test_observation_bench_rows_have_no_species_identity`（X3 补钉）· 01.6 的 A 组反例（改隐藏真值公开输入不变） |
| ② | 同一决策的 UI、Coach、回放可追溯到同一观察序列 | **pass（有 4 条未闭合边界）** | [01.4-decision-trace.md](01.4-decision-trace.md) + `raw-decision-trace.json`：三处 `decision_id` 同值 3/3；`history[-1].pre_observation_hash` == 决策前重算哈希；回放 `observation_trace` 与 `history` 哈希序列 21/21 相同 |
| ③ | 预览前 / 无预览模式不提前泄漏阵容；新局不继承旧局事实 | **pass** | `raw-preview.json`（无预览 ⇒ 无 `opening_reveal`、后备 `['fainted','slot']`、观察无 `revealed`）· Node ⑥⑦（预览开关必须显式传；串局 409） |

**补充判据（不是通过条件本身，但同批跑过）**：定向 5 模块 `exit 0 · Ran 122 · OK`；
全量 `Ran 872 · 1F · skipped=2`（唯一红 = 00 反证那条）；回归集 `--check` exit 0；
六局 + 短局的**结算指纹与事件指纹逐位不变**（只有 `history` 一枚按规矩改钉并留档）。

---

## 4 · 信息边界与反例结果（原文摘要；逐条见 `01.3-reveal-and-contract.md` §4）

| 反例 | 改了什么 | 预期 | 实际 |
|---|---|---|---|
| A1 | 对手真实配招换掉不会用到的一招 | 公开输入逐字段相同 | **全同** |
| A2 | 对手后备血量/能量/异常/印记 | 逐字段相同 | **全同** |
| A3 | 直接改对手隐藏个体面板（U1 无入口，字段级探针） | 个体真值不进公开输入 | 规划协议 + 观察**逐字节相同**；注入值不在 UI 里（已知连带：UI `stats_source` → `species-panel`，那是物种面板） |
| B1 | 预览亮明的物种 B_TEAM → C_TEAM | 观察变化 | `opponent_roster` 与公开面 JSON 均变 |
| B2 | 对手打出的那一招 skill0 → skill1 | 观察变化 | `opponent_skills` 与观察 JSON 均变 |
| C1 | 无预览开局 | 零事件、公开面不变 | 无 `opening_reveal`；`pet_` 不在 blob；观察无 `revealed`；Node 无 `seen_roster` |
| C2 | Node 不传 `openingPreview` | 请求体没有 `opening_preview` | 断言通过（传 `true` 则必须有 ⇒ 白名单那行必需） |
| C3 | 引擎回执 `match_id` 由 `m-one` 变 `m-two` | 明确拒绝 | 409 `match_mismatch`，文案含「对不上」；同 id 才继续；老回执无该字段则跳过守卫 |
| C4 | 绕过 `_bump` 直接 append 事件 | 序号口径被破坏 ⇒ 抛错 | `ValueError`（点名 `state_version` 与 `len(events)`） |

**U1 如实登记**：`blocked:needs_injection_entry` —— 引擎**没有**对局内改对手个体的入口
（`reset(individuals=…)` 只按玩家队伍位次解析，对手侧 `panel` 恒 `{}`）。A3 是**替代反例**，不是入口。

---

## 5 · 代码 / 隔离实例 / 玩家运行版

| 栏 | 状态 | 说明 |
|---|---|---|
| **code** | **fixed** | 引擎 + Node 转发已入库 `5002433`；端点 `/battle/new` `/battle/advance` `/battle/free` `/battle/plan` |
| **isolated** | **passed** | 干净副本（树指纹 `TREE 2c5da5f9…`）：`Ran 872 · 1F + 0E · skipped=2`，唯一红 = 00 既有反证；Node 契约件 28/28、`server.test.js` 26/26、`ROCO_PYTHON=<win python>` 下真引擎端到端 15/15（全部 exit 0） |
| **player** | **不可得（unavailable）** | 本机 **8765 根本没在跑**：`curl -s -m 5` → `http=000 · exit 7`。**不许自行启动**用户服务 ⇒ 玩家运行版一栏只能登记为不可得，**不写通过** |

---

## 6 · 未做项、剩余问题与唯一 next_action

**未做（按 Lead 裁决划出本项）**
1. **前端「开局预览 + 已见阵容回看」入口** ⇒ 分计划 02（写域 `src/client/roco.js` / `roco.html` / `roco.css` / `battle-v3.css`）。数据面已就绪：`view.seen_roster`、`view.opponent.revealed_skills`、`view.match_id|rules_version|decision_id`；**无预览时这几个键不出现**。
2. `src/coach/opponent-belief.mjs` 的公开性口径注释仍指向旧契约（后备一律带 id）—— 不在 01 写域（`recon.md` §5 X4 已登记）。
3. 起真引擎的 Node 端到端**需要设置 `ROCO_PYTHON`**（默认 `python3` 在 Windows 不存在）。
   **更正此前一条表述**：它不是「本机跑不了」——Lead 实测 + 本轮复跑
   `ROCO_PYTHON=C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe node --test tests/roco-standard-pvp-battle.test.js`
   ⇒ **tests 15 · pass 15 · fail 0 · exit 0**（命令 C14）。

**剩余问题（缺口，逐条建议归属见 `result.json` 的 `residual_gaps`）**
- **G2** `history` 行没有 `match_id`/`decision_id`（链接只能推导）→ 01.5 / 06
- **G3** 自由动作（`step_free`）不进 `history` ⇒ 观察序列在自由动作处断开 → 06（先定「自由动作算不算决策点」）
- **G4** `MatchRecord` 没有 `match_id` → 01.5 / 03
- **G5** 观察版本（`schema_version`）没进 Node session 缓存键 → 01.5
- **G6/G7** 前端与 Coach 工具上下文的字段裁剪无逐字段读数 → 02/03
- **G8** `history` 只存哈希不存载荷 ⇒ 恢复不了当时的公开面 → 06
- **G9** `opponent-belief.mjs` 注释未同步 → 02 或 Lead
- **G10** `schema.revealed_facts` docstring 一句不精确（「开局在场上的那只不进名单」，但预览事件列整队含 slot 0）→ 下一轮顺手改文档（**本轮冻结，未动源码**）

**唯一 next_action**：`active_plan=02` —— 前端「开局预览 + 已见阵容回看」入口（写域 `src/client/roco.js` / `roco.html` / `roco.css` / `battle-v3.css`），消费已就绪的 `seen_roster` / `revealed_skills` / 契约字段。
