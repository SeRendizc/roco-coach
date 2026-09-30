# 分计划 01 步骤日志

分工：`plan01-recon`（Lead 于 2026-09-30 16:47 批准写域：`roco/src/roco_env/env.py`、`schema.py`、`service.py`）。
`coverage.py` 与 `roco/tests/test_effect_coverage.py` **归 Lead，未碰**。

本轮（01 步骤 A/B）范围：把三条公开协议对齐到同一份公开观察投影 + 修掉最大的真值泄漏。
**未做**：`opening_roster_revealed` 事件、`match_id`/`event_seq` 契约字段、Node 转发、前端预览。

---

## 0 · 这一轮最该先知道的三件事

1. **Lead 报的 4 条新红里，后 3 条的原因不是「legacy 被误改」，而是「观察载荷」被改。**
   我有决定性读数：六局 + 短局的**决策序列 / `state.events` / `serialize()` 剔除 `history`**
   **全部逐位相同**，只有 `history` 与 `observation_for` 变了。证据见 §3。
2. **`ui.legal.enemy` 那条泄漏修掉了**：递归扫描整个 UI 载荷，对手技能可见数 `3 → 0`。
   度量的**控件已证明有效**（合成 id 能被扫到），不是「恒 0 假绿」。证据见 §1。
3. **我自己的探针写错过三次，每次都产出一个假绿读数**，都已定位并修好。
   这段留在 §4 —— 它是本轮最该被复核的部分：**读数的度量本身也要被度量**。

---

## 1 · 改动清单（我写的每一行）

### 1.1 `roco/src/roco_env/env.py`

| 位置 | 改动 | 理由 |
|---|---|---|
| `public_planner_state.opponent.bench` | `{slot, pet_id, fainted}` → `{slot, fainted}` | 后备物种身份不是公开事实（预览前）；与 `ui_public_view` 长期不一致 |
| `public_planner_state` docstring | 「对手后备只有位次、精灵 id、是否倒下」→ 去掉 id | 文档与实现同步 |
| `public_planner_state.assumptions.note` | 补「物种」也在未知量里 | 重建现在真的按占位物种建模，措辞要如实 |
| `state_from_public_planner` | 后备 `b["pet_id"]` → `b.get("pet_id") or fallback_id`；`fallback_id` 提到循环外 | 缺身份时走**本来就有**的占位分支；保留老形状兼容（带 id 的老 fixture 行为逐位不变） |
| `ui_public_view.ui_legal` | 删掉 `"enemy"` 键 | **本轮最大的真值泄漏**：那份载荷含对手每个技能的 `skill_id`/`name`/`desc`/`power`/`energy`，等于把对手真实四招交给 Node |
| `ui_public_view` docstring | 补「对手合法动作表不给」 | 口径写下来才守得住 |
| `ui_public_view` 后备注释 | 更新为「规划协议也已是同一形状」 | 原注释描述的是已不成立的前提 |

### 1.2 `roco/src/roco_env/schema.py`

| 位置 | 改动 | 理由 |
|---|---|---|
| `foe_bench_pet()` | 去掉 `pet_id` / `name`，保留 `slot`/`fainted`/`field`/`active` | 它自称「隐藏信息的唯一边界」，却把对手**整队真名**交给双方策略（`opponents.py:1064`/`:1080`）。`field`/`active` 不是在描述物种，是分层标记，保留 |
| `observation_for` docstring | 明确「物种身份」也不可见；记录这次修正 | 原文档承诺与实现不符 |

### 1.3 为什么 `ui.legal.enemy` 在**今天浏览器拿不到**的情况下仍然要修

`result.ui` 只待在 Node 内存里（`src/server/roco-service.js:165` 只读它做投影；
`publicView()` 只取 `ui.legal.player`，见 `:234`），所以它**不是**一个玩家可见的现网泄漏。
但仍然要修，两个理由：

1. `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:60` 的口径是「任何一层泄漏，边界都不成立」——
   而 `ui_public_view` 按签名与 docstring 就是**公开**视图；
2. `service._sim_envelope` 已有一份 `result.legal.enemy`（私有域），要「对手有几个合法动作」
   的调用方读那一份就够（`src/server/roco-service.js:242` 的 `cpu_legal_count` 正是这么算的）
   ⇒ **删掉这份公开副本不需要动任何契约**。

---

## 2 · 前后读数（可复跑）

命令与原始读数：

```sh
cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-04-align-before-after.py verified-before
cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-04-align-before-after.py verified-after
```

| 量 | BEFORE | AFTER | 原始文件 |
|---|---|---|---|
| 对手技能在 `ui_public_view` 里的可见数（9 seed 均值 / 对手场上真实 4 招的回收率） | **0.75** | **0.00** | `raw-align-verified-*.json` |
| `ui.legal` 的键 | `['enemy','player']` | `['player']` | 同上 |
| `public_planner_state.opponent.bench` 键 | `['fainted','pet_id','slot']` | `['fainted','slot']` | 同上 |
| `ui_public_view.opponent.bench` 键 | `['fainted','slot']` | `['fainted','slot']` | 同上 |
| `observation_for` 后备键 | `['active','fainted','field','name','pet_id','slot']` | `['active','fainted','field','slot']` | 同上 |
| 场上那只仍有 `pet_id`（不能把「亮明的」也一起剥掉） | `True` | `True` | 同上 |
| 对手技能出现在 `public_planner_state` 里 | `0` | `0` | 同上 |
| **控件：合成 id 能被扫到** | `True` | `True` | 同上 `control.metric_can_detect_leak` |

> ⚠ 与 `recon.md` §3.4 里 `probe-03` 的 **1.000** 不同：那是**镜像队伍**（对手 = 己方六只的
> 排列），`ui.legal.enemy` 在那局的可见集合恰好等于真实配招。`verified-*` 用的是**不相交**
> 的两组六只，回收率 0.75（4 招里 3 招可复原；差的那只是通用动作「防御」而非配招）。
> 两个数都真，但**只有后者是可比的**。§4.1 记了这次翻车。

---

## 3 · 那 3 条「新红」的定位（Lead 点名要的）

### 3.1 三条红的共同根因

`state.history` 装的是**决策前的观察载荷**（`env.py` 的 `step_joint`：
`pre_player = observation_for(state, rs, "player")`），而：

* `test_turn_order_fail_closed` 的黄金指纹 = `_digest(renv.serialize(state))`，
  而 `serialize()` 里**有** `history`（`schema.py:452`）；
* `test_regression_set` 的 `regression.py:284` 同样对 `serialize()` 整体取 sha256。

⇒ 改了 `observation_for` 的后备投影 ⇒ `history` 字节变了 ⇒ 两处指纹都动。
**这不是结算被改，是「指纹把观察载荷也算进去了」。**

### 3.2 决定性读数（六局 + 短局，A/B/A）

```sh
cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-05-legacy-evidence.py athead
cd roco && PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-05-legacy-evidence.py withchange
```

| 指纹 | HEAD vs 改动后 |
|---|---|
| `F1_decision_digest`（双方每步**实际选出的动作**） | **六局全同** |
| `F2_events_digest`（`state.events`） | **六局全同** |
| `F3_state_no_history_digest`（`serialize()` 剔除 `history`） | **六局全同** |
| `F4_history_digest`（决策前观察载荷） | 六局全变（预期） |
| `F5_obs_digest`（`observation_for`） | 六局全变（预期） |

短局同形：`F1_picks` 逐位相同（`picks identical = True`）、`F2`/`F3` 相同，只有 `F4` 变。

⇒ **引擎行为一个字节都没动**；动的是公开观察载荷 —— 而那正是 01 要求动的东西。

### 3.3 处置 1：`test_turn_order_fail_closed`（改钉，已做）

* 原断言逐字留档在文件里的 `GOLDEN_*_PRIOR_2026_09_30` 注释块内（含两条 `assertEqual` 原文）。
* 最小修订：结算指纹**收窄**到 `_state_without_history(state)`（`serialize()` 剔除 `history`，
  并用 `assert` 当场证明**只剔了这一个键**）；**另立**一枚 `history` 指纹
  （`GOLDEN_HISTORY_DIGESTS` / `GOLDEN_SHORT_HISTORY`）。
  ⇒ 收窄**没有**制造盲区：历史载荷再变仍然会红，只是红在该红的那一枚上。
* 原值逐字保留在 `*_PRIOR_2026_09_30`。
* **加强必红反证**（原来只测 events）：新增 ①结算状态指纹对结算字段敏感
  ②`history` 指纹对 history 敏感 ③改 history **不**影响结算状态指纹
  （③ 证明剔除真的生效，而不是碰巧）。
* 我自己写的两处「占位值」与一处自比较断言是**错的**，已按实测值替换、按真判据重写 —— 见 §4.2。

### 3.4 处置 2：`test_regression_set`（产物重建，已做；**但有一处待 Lead 裁决**）

先证明「只有 `state_digest` 变了」：

```
29 个场景里 state_digest 变了 29 个；
除 state_digest 之外的字段有变化的场景：0 个；
totals / problems / unreachable / event_kinds / key_events：全部逐字相同。
```

⇒ 不是「引擎变了」，是**产物过期**。按 `test_regression_set.py:144` 的指路重建：

```sh
cd /Users/serendizc/Developer/roco-coach          # ← 必须在仓库根，脚本按 cwd 解析 --out
PYTHONPATH=roco/src python3 -m roco_env.regression --out reports/roco/rc404/regression-set.json
# exit=0 · 日志：reports/roco/product-execution/01/regression-rebuild.log
PYTHONPATH=roco/src python3 -m roco_env.regression --check
# exit=0 · 「✔ 回归集与磁盘上的指纹一致」
```

重建后复查：29 个场景 `state_digest` 全变，**其余字段仍然 0 个变化**，totals/problems/unreachable/event_kinds 逐字不变。

**⚠ 待 Lead 裁决（不在我写域，未动）**：`roco/src/roco_env/regression.py:284` 的 `state_digest`
把 `history` 也算进去了，与 §3.3 属于同一个设计问题。这轮我只**重建了产物**，
没有改生成器。**建议**：把 `state_digest` 同样收窄（剔除 `history`），
否则「引擎指纹」会继续被观察载荷的变化牵着走 —— 每次改动观察边界都要重建一次产物，
而且**真正**的引擎回归会淹没在这种噪声里。这一步需要 Lead 授权 `regression.py` 写域。

---

## 4 · 本轮我写错的四处（自查记录，请重点复核）

这一节留着，因为**每一处都产出了一个看起来正常的错误读数**。

### 4.1 探针 1：镜像队伍让度量恒为 0（假绿）

第一版 `probe-04` 把对手设成「己方六只的排列」，而度量要扣掉`own_all`（己方技能）。
两队同种 ⇒ 对手技能全在 `own_all` 里 ⇒ 交集恒空 ⇒ 报 `mean_recovery_ratio = 0.0`。
**看起来像「已修好」，其实什么都没量。**
⇒ 修：改成从候选宇宙取**两组不相交**的六只，并加 `assert not (set(team) & set(foe))`。

### 4.2 我在测试文件里写了占位值和一句空断言

第一次改钉时我写了 `GOLDEN_STATE_NO_HISTORY_PRIOR_2026_09_30 = {"1000": "c4e2dd7a…"}`（**编的**）
和 `assertEqual(_digest(x), _digest(x))`（**恒真，什么都不测**）。
⇒ 都换成了实测值 / 真判据。**教训：占位值绝不能进测试文件**，哪怕只是「留个记录」。

### 4.3 探针 2：递归收集器只在 dict 分支判定字符串（假绿）

`all_skill_ids` 第一版只在 `isinstance(node, dict)` 分支里 `if isinstance(v, str) and v.startswith("skill_")`。
但递归进 list 元素时那个元素本身是 `str`，两个分支都不命中 ⇒ **恒返回空集** ⇒ 度量恒 0。
实测复现：`all_skill_ids({'x': ['skill_900001']}, set()) == set()`。
⇒ 修：把「判定字符串」提到最前面，任何位置都算。

### 4.4 探针 2 的控件也是坏的

控件原本拿**真实配招 id** 注入，而那些 id 有的和己方技能撞名，被 `- own_all` 扣掉 ⇒
`metric_can_detect_leak = False`，看起来像度量坏了（其实是控件坏了）。
⇒ 修：改用**合成 id**（`skill_900001`）注入，并显式给集合运算加括号
（`(set(real) - set(own)) & got`）—— 一长串 `&`/`-` 混写极易看错，这正是 §4.3 的同类问题。

> 现在的读数里 `control.metric_can_detect_leak = True`，且 AFTER 报 0 ——
> **「0 个泄漏」是在「度量能发现泄漏」被证明之后才成立的。**

---

## 5 · 本轮验证结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner tests.test_ui_public_view tests.test_turn_order_fail_closed tests.test_regression_set tests.test_opponents -q` | 0 | Ran 99 · **OK** |
| `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -q` | 1 | Ran **847** · 2 failures · skipped=1（见下） |
| `PYTHONPATH=roco/src python3 -m roco_env.regression --check`（仓库根） | 0 | ✔ 回归集与磁盘上的指纹一致 |
| `node --test tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js tests/roco-server-side-guard.test.js` | 0 | tests 20 · **pass 20 · fail 0** |

全量那 2 条残余**全部**是 Lead 00 的既有欠账，与本轮改动无关（我改前它们就是红的）：

* `test_effect_coverage.test_report_has_no_simulatable_with_unclaimed_mechanic_spans`
* `test_tier_verdict_agreement.test_counter_proof_disabling_the_shared_gates_brings_them_back`

原始日志：`unittest-after-01AB.txt`。

**Node 侧未改任何文件**：`src/**` 一行没动。`cpu_legal_count` 读的是私有域
`result.legal.enemy`（`_sim_envelope`），不受本轮影响 —— 由上面 20/20 通过佐证。

---

## 6 · 未做 / 待办

| # | 项 | 状态 |
|---|---|---|
| 1 | **U1「只改对手隐藏个体 ⇒ 公开面不变」** | **blocked:needs_injection_entry**。`reset(individuals=…)` 只按**玩家**位次解析（`env.py:249`），对手侧 `panel` 恒为 `{}`（实测）。引擎没有对局内改对手个体的入口 —— **不猜、不静默跳过**。已实测能做的部分：换真实 seed（不变 ✓）、改对手后备真实 hp/energy（不变 ✓）。见 `raw-align-verified-*.json` 的 `D_invariance` |
| 2 | `regression.py:284` 的 `state_digest` 应否同样剔除 `history` | **待 Lead 裁决 + 授权写域**（§3.4） |
| 3 | `opening_roster_revealed` 事件（Lead 已裁决：发在 `service.battle_new`，`state.events` 也留一条同源记录） | 未开始 |
| 4 | `match_id` / `event_seq` / `decision_id` 契约字段（`event_seq` 底层计数已确认现成：`state_version` 唯一写入点 `env.py:829`，恒等于 `len(state.events)`） | 未开始 |
| 5 | Node 转发（`src/server/roco-service.js`、`src/server/index.js`）与前端预览 | 未开始（需 Lead 逐处批准） |
| 6 | `src/coach/opponent-belief.mjs:24` 等处的公开性口径注释已指向**旧**契约（后备带 id） | 未同步（不在我写域）；建议 02 或 Lead 处理 |

---

## 7 · 备份物（Lead 提交前请留意）

`reports/roco/product-execution/01/.work-backup/` 里有我为了做 A/B 对照而留下的副本：

* `env.py` / `schema.py` = 我的改动版（与工作区一致）
* `env.py.head` / `schema.py.head` = `git show HEAD:` 的原版
* `regression-set.json.before` = 重建前的回归产物

它是**对照用的工作副本，不是产物**。Lead 提交时**不要**把它入库（或先删掉）。
我保留它是因为本轮反复做「HEAD ↔ 改动」切换，需要一条 git 之外的退路
（交接文档 §7.3 记过 `git checkout` 抹掉未提交改动的教训）。

**当前工作区状态**：`env.py` / `schema.py` 是我的改动版；`coverage.py` 的改动**是 Lead 的**（我没碰）；
未 commit、未 push、未重启 8765、未清数据。
