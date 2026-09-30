# 01 六步映射（01.1–01.6）：要求 → 落点 → 可复跑命令 → 原始读数 → **缺口**

**执行**：`plan01-engine`（task-6） · **时间**：2026-09-30 18:5x
**分支**：`wip/roco-coach-2026-09-30-1418` · **01 引擎侧提交**：`5002433`（远端 SHA 已核） · **本文不重复抄读数**，逐条给文件指针。

> 读法：每一节先给 **01-PLAN 的要求原文（摘要）**，再给**落点**、**可复跑命令**（含退出码）、
> **原始读数**（文件）、最后是 **缺口**（本步没做到 / 做不到的地方）。缺口集中列在 §7。

---

## 01.1 · 画出字段流，逐字段登记事实/推测/隐藏真值

| 项 | 内容 |
|---|---|
| 要求 | 「真状态 → Python public/UI → Node 响应 → 客户端 → Coach 工具、缓存和回放的字段流。逐字段登记事实、推测、隐藏真值及来源」；必须留下 `field-matrix.md` 与真实调用路径 |
| 落点 | **前一轮**：`recon.md` §1.1–1.4（三条 Python 协议逐字键名 + 消费点对照表，权威）。**本轮补**：`01.1-field-matrix.md`（五段链路 + 四档标注 🟢事实/🟡推测/🔴隐藏真值/⚪结构性）+ `probe-09-field-matrix.py` + `probe-10-publicview-keys.mjs` |
| 命令 | `PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-09-field-matrix.py` ⇒ **exit 0**；`node reports/roco/product-execution/01/probe-10-publicview-keys.mjs` ⇒ **exit 0** |
| 原始读数 | `raw-field-matrix.json`（三面键树 + `serialize_top_keys` + `history_entry_keys`）· `raw-leg-receipt.json`（Python 回执切片，**无私有 `state`**）· `raw-publicview-keys.json`（Node `publicView` 24 个顶层键；`has_private_state=false`；`contract_forwarded=true`；`seen_roster` 3 行；`bench_keys=[['fainted','slot'],…]`） |
| 与 01-PLAN 的差 | 01-PLAN 要求「客户端」一跳；本轮只到 `src/client/roco.js` 的**源码与既有判据**（见 `01.1-field-matrix.md` §1 第 4 段），**没有**真实渲染读数 |

## 01.2 · 版本化观察契约（match_id / event_seq / decision_id / rules_version）

| 项 | 内容 |
|---|---|
| 要求 | 「定义并实现版本化观察契约：match_id、event_seq、decision_id/state_version、rules_version、来源事件与可见范围。命名可适配现有代码，但**含义不能丢**」 |
| 落点 | `env.py`「观察契约」一节（`rules_version_of` / `match_id_of` / `decision_id_of` / `observation_contract` / `event_seq_of`）· `service.py`（回执顶层三字段 + 事件行 `seq` + `battle_plan` 原样回吐，§1.1/§2.3）· `01.3-reveal-and-contract.md` §2 · 提交 `5002433` |
| 命令 | `PYTHONPATH=src python3 /mnt/e/roco-scratch/p01_probe_contract.py` ⇒ **exit 0**；定向 5 模块 ⇒ **exit 0 · Ran 122 · OK** |
| 原始读数 | `raw-contract.json`：三面同源 `true`；`match_id_same_across_real_seeds=true`；`match_id_differs_on_own_team=true`；`roundtrip_*_stable=true`；`seq_equals_index=true`；`advance_events_seq=[(turn_start,0)…(energy_regen,4)]` |
| 判据（新增） | `tests/test_public_planner.py::TestObservationContractFields`（10 条，含必红反例：绕过 `_bump` append ⇒ `event_seq_of` 抛错） |
| 「含义不能丢」的落点 | `decision_id = <match_id>:v<state_version>`，`state_version` 仍是既有钉子（`service._coerce_state_version` 判过期）；`event_seq` = `state.events` 绝对下标，切片后仍可复原 |

## 01.3 · 预览前不给六只；预览事件只含实际展示字段；已出场/已出招可追溯

| 项 | 内容 |
|---|---|
| 要求 | 「首次预览尚未发生时不给对方六只；预览事件只包含实际展示字段。记录已出场、已出招、可见状态与资源，不把种族参考当个体真值」 |
| 落点 | `schema.py`（`OPENING_REVEAL_KIND` / `revealed_facts` / `observation_for` 的条件键 `revealed`）· `env.py`（`opening_roster_reveal` / `_bench_public_row` / 两公开面的 `revealed` 块）· `events_text.py`（中文句 + `KNOWN_EVENT_KINDS`）· `service.py`（`battle_new` 收 `opening_preview`；回执 `opening_reveal` 与 `state.events` 同源）· 提交 `5002433` |
| 命令 | `bash /mnt/e/roco-scratch/p01-probe-preview.sh` ⇒ **exit 0**；`tests.test_ui_public_view` / `tests.test_event_text` 在定向与全量里都绿 |
| 原始读数 | `raw-preview.json`：无预览 ⇒ 无 `opening_reveal` 键、后备 `['fainted','slot']`、`blob_has_pet_=false`、观察无 `revealed`；有预览 ⇒ 后备带 `pet_id/revealed_via/revealed_turn/revealed_event_seq`；推进后 `revealed_skills={'pet_000417':['skill_000286']}`；`duplicate_reveal_raises=true` |
| 判据（新增） | `tests/test_ui_public_view.py::OpeningRevealFollowsTheDisplayedFields`（6 条：预览前不泄漏 / 事件只含展示字段 / 两公开面 + 观察同源 / 不可重复登记 / 已出场换下去仍在 / 已出招且未出的不出现）· `tests/test_event_text.py::OpeningRevealSentenceTest`（2 条，从真跑 `battle_new` 取值）· `tests/test_opponents.py` X3 补钉 |
| 「不把种族参考当个体真值」 | `ui` 面的 `stats_source` 三态（`individual-snapshot` / `species-panel` / `species-race`）**照旧**；对手侧读数 = `species-race`（图鉴值），重建不读它 |

## 01.4 · 同一 decision_id 的 UI / 工具输入 / 回放对照

| 项 | 内容 |
|---|---|
| 要求 | 「把当前决策观察快照固化到可回放记录；同一局的 UI/Coach 使用同一来源投影。推测单独存放，不回写成观察事实」；证据「同一 decision_id 的 UI、工具输入与回放对照」 |
| 落点 | `01.4-decision-trace.md` + `probe-11-decision-trace.py`；契约字段（01.2）是它的前置；提交 `5002433` |
| 命令 | `PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-11-decision-trace.py` ⇒ **exit 0** |
| 原始读数 | `raw-decision-trace.json`：`all_three_faces_same_decision_id=true`（3/3 回合 `ui == public == plan == m-…:v{version_before}`）；`all_history_hashes_match=true`（决策前重算的 `_obs_hash` 与 `history[-1].pre_observation_hash` 逐字相同）；`all_derived_versions_match=true`（`v = history.state_version − len(history.events)`）；回放腿 `trace_equals_replay_history=true`（21/21）、`replay_is_deterministic=true` |
| 推测单存 | `assumptions.opponent_bench` + `limitations` + `unverified_overrides` 三类都在公开面上**带出处**（`01.1-field-matrix.md` §2.3）；重建状态（`state_from_public_planner`）从不回写进对局状态 |

## 01.5 · 缓存键与旧协议兼容

| 项 | 内容 |
|---|---|
| 要求 | 「绑定局、状态、规则与观察版本，取消陈旧分析；旧数据缺字段时明确降级，不补隐藏真值」 |
| 落点 | `roco-service.js`：`sessions` 存 `(match_id, battle_id, state_version, rules_version)`；`matchMismatch` 在 `advance/free/plan` 三处 fail closed（409 `match_mismatch`）；`roco-client.js` 白名单加 `openingPreview`；提交 `5002433` |
| 命令 | `node --test tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js tests/roco-server-side-guard.test.js tests/roco-observation-contract.test.js` ⇒ **exit 0 · 28/28**；`node --test tests/server.test.js` ⇒ **exit 0 · 26/26**；`ROCO_PYTHON=<Windows python> node --test tests/roco-standard-pvp-battle.test.js` ⇒ **exit 0 · 15/15** |
| 原始读数 | 反向用例 ⑥（不传 `openingPreview` ⇒ 请求体没有 `opening_preview`；传 `true` ⇒ 必须有）· ⑦（`m-one`→`m-two` ⇒ 409 `match_mismatch`；老回执读不到 ⇒ 跳过守卫）· ①b（空串/非字符串不当契约字段） |
| 旧数据降级 | 引擎侧：`schema.py` 的 `from_dict` 对老存档缺键给 `[]`/`None`（既有）；契约字段与 `revealed` 是「缺就不出现」；Node 侧：`publicView` 对旧 fixture 一个键都不加（判据 ①/①b/②/③ 的反向分支） |
| 未核验覆盖 | `unverified_overrides` 照旧进公开面并带 `confidence/reason/microcase_id`（`view.unverified_overrides` 逐条 `unverified:true`） |

## 01.6 · 隐藏变量不变性 + 公开变化正例

| 项 | 内容 |
|---|---|
| 要求 | 「只改变隐藏个体值与真实配招，比较所有公开响应、工具输入与确定性分析输入；再改变实际可见事件，证明观察会更新」；反例必须执行 |
| 落点 | `tests/test_public_planner.py::TestHiddenTruthInvarianceAndPublicChange`（7 条）· `01.3-reveal-and-contract.md` §4 · 提交 `5002433` |
| 命令 | `bash /mnt/e/roco-scratch/p01-targeted-wide.sh` ⇒ **exit 0 · Ran 243 · OK**（含本步全部用例）；定向 5 模块 ⇒ exit 0 · Ran 122 |
| 原始读数 | A：改对手真实配招 / 后备资源 / 隐藏个体面板 ⇒ 公开输入（规划协议 + UI 视图 + 玩家侧观察）**逐字段相同**；注入的个体值一个都不在 UI 里。B：改已展示物种 ⇒ `opponent_roster` 与公开面 JSON 变；改已公开技能 ⇒ `opponent_skills` 与观察 JSON 变；无亮明事件 ⇒ `revealed_facts == {}` |
| 「确定性分析输入」 | `/battle/plan` 的请求体就是 `public_planner_state`（同一份对象）⇒ 公开面 JSON 相同即分析输入相同；`battle_plan` 另外把契约字段原样回吐（`raw-decision-trace.json` 的 `plan_*`） |

---

## 7 · 缺口（本步没做到 / 做不到；按「谁该接」分类）

| # | 缺口 | 证据 | 建议归属 |
|---|---|---|---|
| G1 | **U1：对局内改对手个体**没有入口 | `reset(individuals=…)` 只按玩家队伍位次解析；本轮用「直接改 `panel` 字段」的替代反例证明公开面不读它 | `blocked:needs_injection_entry`；接 03（对手候选）或专项 |
| G2 | `history` 行**没有** `match_id`/`decision_id`（链接只能推导） | `raw-decision-trace.json` → `decision_id_is_derivable_not_recorded=true` | 01.5 缓存键 / 06 复盘 |
| G3 | **自由动作不进 `history`** ⇒ 观察序列在自由动作处断开 | `env.py` `step_free` 注释「不进 joint history（那不是一回合）」 | 06 复盘（要做就得先定「自由动作算不算一个决策点」） |
| G4 | `MatchRecord` **没有 `match_id`** ⇒ 回放记录与局的绑定靠 `seed + teams + snapshot_fingerprint` | `raw-decision-trace.json` → `record_has_match_id_field=false` | 01.5 / 03 |
| G5 | **观察版本（`schema_version`）没进 Node session 缓存键**（四元组里没有它） | `roco-service.js` `sessions.set(...)` 只存 `match_id/rules_version/decision_id/state_version` | 01.5 |
| G6 | 前端一跳无渲染读数（预览层 / 「已见阵容」入口） | `01.1-field-matrix.md` §1 第 4 段 | 分计划 02（写域已定） |
| G7 | Coach 工具回执 → 模型上下文的**字段裁剪**没有逐字段读数 | `01.1-field-matrix.md` §4 第 2 条 | 02/03 |
| G8 | `history` 只存观察**哈希**，不存载荷 ⇒ 从记录里恢复不了当时的公开面 | `env.py:1062-1070` | 06 复盘（若产品要「回看当时的公开面」，得先定存哪一份） |
| G9 | `src/coach/opponent-belief.mjs` 的公开性口径注释仍指向旧契约（后备一律带 id） | `recon.md` §5 X4 | 02 或 Lead（不在 01 写域） |
| G10 | `schema.revealed_facts` 的 docstring 有一句不精确：写着「开局就在场上的那只**不进** `opponent_roster`」，但**预览事件列的是整队**（含 slot 0）⇒ 有预览时它在名单里 | `raw-publicview-keys.json` 的 `seen_roster` 三行含 slot 0；行为正确、**只是这句话该改** | 下一轮顺手改文档（**本轮冻结，不动源码**） |

> 注：G10 是写这份映射时**新发现**的文档级不精确（不是行为 bug：无预览 ⇒ 名单为空；
> 预览 ⇒ 名单是整队，这正是「预览实际展示了什么就记什么」）。**没有**为了让它好看去改冻结的源码。
