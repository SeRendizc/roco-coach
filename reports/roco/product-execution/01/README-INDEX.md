# reports/roco/product-execution/01/ · 产物索引（**先读这一页**）

分计划 01（公开观察与决策快照契约）。**哪些读数算数、哪些已经作废**，逐条写在这里 ——
第一轮（步骤 A/B）曾有三次探针写错并产出了**假绿读数**，作废件必须标出来，否则后人会拿它当证据。

> **本机路径**：这一页的命令按**当前机器**（Windows + WSL Ubuntu-22.04）写：
> 仓库根 `/mnt/e/roco-coach`（Windows `E:\roco-coach`）。文件里出现的
> `/Users/serendizc/…` 是**上一台机器**的历史路径，只作留痕，不要照抄。
> 临时脚本放 `E:\roco-scratch\`（`/mnt/e/roco-scratch/`，不入库）。

---

## 一、权威读数（引用这些）

### 第一轮（步骤 A/B：灭泄漏 + 三协议对齐）

| 文件 | 是什么 | 关键数字 |
|---|---|---|
| `recon.md` | 01 的只读勘察报告（三条协议现状、缺口清单、实施清单、冲突登记、不确定点） | — |
| `step-log.md` | 步骤 A/B 的改动日志 + 那 3 条「新红」的定位 + **我写错的四处自查** | — |
| `raw-align-verified-before.json` | 改动前：泄漏与后备键集（**最终口径**） | 对手技能 UI 可见回收率 **0.75** |
| `raw-align-verified-after.json` | 改动后：同上 | **0.00**；`ui.legal` 只剩 `player` |
| `raw-legacy-athead.json` / `raw-legacy-withchange.json` | 六局 + 短局的 F1–F5 指纹对照（证明只动观察载荷、不动结算） | F1/F2/F3 六局全同；仅 F4/F5 变 |
| `raw-golden-athead.json` / `raw-golden-withchange.json` | 黄金指纹改钉用的精确值 | — |
| `raw-fields.json` | 三条协议顶层/逐行键名（recon §1 的依据；**不含** 01.2/01.3 的新字段） | — |
| `raw-foe-legal-leak.json` | 六宠**镜像队伍**下 `ui.legal.enemy` 的回收率 | 1.000（9/9）——见下方警告 |
| `raw-leaks.json` | 隐藏真值扫描 + 不变性预演 Q1–Q4 | — |
| `raw-event-seq-baseline.txt` | `state_version` 唯一写入点 + 恒等于 `len(state.events)` | — |
| `unittest-after-01AB.txt` | 那一轮的全量 Python 日志（**早于**本轮） | Ran 847 · 2 failures（均为 00 既有欠账） |
| `regression-rebuild.log` | 那一轮的回归产物重建日志 | exit=0 |

### 第二轮（01.2 / 01.3 / 01.6：契约字段 + 开局预览 + 反例；提交 `5002433`）

| 文件 | 是什么 | 关键数字 |
|---|---|---|
| `01.3-reveal-and-contract.md` | 这一轮的读数与证据主文（契约字段 / 预览事件 / 01.6 反例 / 指纹处置 / Node 转发 / 未做项） | — |
| `raw-contract.json` | 契约字段探针（`match_id`/`rules_version`/`decision_id`/`event_seq`） | 三面同源 `true`；与真实 seed 无关 `true`；同队同规则两局**相同**（已知性质）；`seq_equals_index=true` |
| `raw-preview.json` | 开局预览探针（无预览 / 有预览 / 推进后 / 重复登记） | 无预览：无 `opening_reveal` 键、后备 `['fainted','slot']`；有预览：后备带 `pet_id`+来源、`revealed_skills` |
| `raw-regression-narrowing.json` | 证明「本轮只有 `history` 动」的三次构建对照 | 关掉新块重建 29 场景与磁盘产物**一条不差**；开/关的「剔除 history」指纹 **29/29 相同** |
| `raw-regression-before-after.json` | 回归集重建前后逐场景对照（审计用） | `state_digest_moved=29`（口径本身）·**其它字段 0 个变** |
| `regression-rebuild-01-3.log` / `regression-check-01-3.log` | 收窄 `state_digest` 后的产物重建与校验 | exit=0 / exit=0（`✔ 一致`） |
| `unittest-targeted-01ABC.txt` / `unittest-targeted-01ABCDE.txt` | 定向 5 模块（Lead 指定命令） | **Ran 122 · OK**（基线 99 ⇒ +23 全是新增用例） |
| `unittest-full-01ABC.txt` / `unittest-full-01ABCDE.txt` | 全量（收尾树：`TREE 2c5da5f9…`） | **Ran 872 · 1F** · skipped=2（唯一红 = 00 既有欠账 `tier_verdict`） |
| `probe-07-regression-narrowing.py` / `probe-08-regression-before-after.py` | 上面两份对照的**可复跑**探针 | exit 0 / exit 0 |

### 收尾（01.1 字段矩阵 + 01.4 同源对照 + 验收件）

| 文件 | 是什么 | 关键数字 |
|---|---|---|
| `result.json` | 按 `EVIDENCE-TEMPLATE.md` 的分计划结果（命令/退出码/日志、checks、反例、三栏 runtime、缺口） | code=fixed · isolated=passed · **player=unavailable** |
| `acceptance.md` | 验收说明：通过条件逐条对账 + 反例 + U1 + 未做项 + 唯一 next_action | 三条通过条件逐条给出证据 |
| `01-STEPS-MAP.md` | **六步映射**：01.1–01.6 各自「要求 → 落点 → 命令 → 读数 → 缺口」 | 缺口 G1–G10 集中登记 |
| `01.1-field-matrix.md` | 字段流矩阵（真状态 → Python 三面 → Node → 客户端 → Coach/缓存/回放），逐字段标 🟢事实/🟡推测/🔴隐藏真值/⚪结构性 | 引用 `recon.md` §1，不重复抄 |
| `01.4-decision-trace.md` | 同一 `decision_id` 下 UI / 工具输入 / 回放同源对照（含与 `history.pre_observation_hash`、`event_seq` 的关系） | 三处同值 3/3；回放 trace 与 history 哈希 **21/21** 相同 |
| `raw-field-matrix.json` | 三条 Python 协议 + `serialize()` + `history` 的**键树** | — |
| `raw-leg-receipt.json` | 给 Node 那一跳的回执切片（**已剔除私有 `state`**） | — |
| `raw-publicview-keys.json` | Node `publicView` 键树（真跑，不是源码推断） | 24 个顶层键；`has_private_state=false`；`contract_forwarded=true` |
| `raw-decision-trace.json` | 01.4 的逐回合读数 + 回放腿 + 边界标记 | `all_three_faces_same_decision_id=true`；`trace_equals_replay_history=true` |
| `probe-09-field-matrix.py` / `probe-10-publicview-keys.mjs` / `probe-11-decision-trace.py` | 上面三份读数的**可复跑**探针 | exit 0 全部 |

> `verify-01-*.json` 属于 **harness-verifier**（写域不在实现者），本目录出现时不要当成实现者证据。

---

## 二、作废件（**不要引用**，保留只为留痕）

以下文件是 `probe-04` / `probe-05` / `probe-06` **早期有缺陷版本**的输出。每一版都产出了
一个看起来正常、实则错误的读数；缺陷与修法记在 `step-log.md` §4。

| 文件 | 作废原因 | 错在哪 |
|---|---|---|
| `raw-align-before.json` / `raw-align-after.json` | 探针 v1：度量只看 `ui.legal.enemy[].skill_id`，那条路径一被删，度量就退化成恒 0 | 度量随被测对象一起消失 |
| `raw-align-before-v2.json` / `raw-align-after-v2.json` | 探针 v2：递归收集器只在 dict 分支判定字符串 ⇒ 恒返回空集 | 度量恒 0（假绿） |
| `raw-align-before-v3.json` | 探针 v3：控件拿真实配招 id 注入，被 `- own_all` 扣掉 ⇒ 控件自己失真 | `metric_can_detect_leak=False` |

> 判定真伪的最短路径：权威件的 `A_foe_loadout_recovery.control.metric_can_detect_leak`
> 必须是 `true`。作废件的这一格是 `false`（或压根没有这一格）。
>
> `raw-legacy-*.json` 与 `raw-golden-*.json` **不在**作废清单里：它们由 `probe-05` /
> `probe-06` 产出，那两支脚本没被改过。唯一要留意的是 `probe-05` 里
> `short_scripted` 那一段用的是**近似**夹具（不是测试真正的 `_fresh_state` +
> `pick_action`），所以它的短局指纹只可用于「同脚本内 A/B 比较」，
> **绝对值不可用于改钉** —— 改钉用的绝对值由 `probe-06` 与测试自身助手给出。
>
> **第二轮与收尾（01.2/01.3/01.4/01.6）没有新增作废件**：新探针都带自证字段
> （`metric_can_detect_leak` 式的控件、`identical/differing` 对照、`checks.*`），
> 且 `raw-regression-narrowing.json` 的结论建立在**三次构建**而不是单次跑数上。

---

## 三、复跑命令（当前机器：WSL，仓库根 `/mnt/e/roco-coach`）

```sh
# ── 0. 引擎可导入 ──────────────────────────────────────────────────────────
cd /mnt/e/roco-coach && PYTHONPATH=roco/src python3 -c "import roco_env.service; print('IMPORT_OK')"

# ── 1. 第一轮的三支只读探针（01 勘察）────────────────────────────────────
cd /mnt/e/roco-coach/roco
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-01-fields.py
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-02-leaks.py
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py
# probe-04/05/06 的 <标签> 决定输出文件名（raw-align-<标签>.json 等）：
#   复现权威件用 verified-before / verified-after / athead / withchange
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-04-align-before-after.py <标签>
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-05-legacy-evidence.py <标签>
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-06-golden-digests.py <标签>

# ── 2. 第二轮与收尾的探针（01.1/01.2/01.3/01.4 + 指纹对照）──────────────
cd /mnt/e/roco-coach
PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-07-regression-narrowing.py
PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-08-regression-before-after.py
PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-09-field-matrix.py
node       reports/roco/product-execution/01/probe-10-publicview-keys.mjs
PYTHONPATH=roco/src python3 reports/roco/product-execution/01/probe-11-decision-trace.py
# 契约 / 预览两支探针在临时目录（不入库）：
#   PYTHONPATH=src python3 /mnt/e/roco-scratch/p01_probe_contract.py   → raw-contract.json 的口径
#   PYTHONPATH=src python3 /mnt/e/roco-scratch/p01_probe_preview.py    → raw-preview.json 的口径

# ── 3. 判据 ───────────────────────────────────────────────────────────────
cd /mnt/e/roco-coach/roco
PYTHONPATH=src python3 -m unittest tests.test_public_planner tests.test_ui_public_view \
  tests.test_turn_order_fail_closed tests.test_regression_set tests.test_opponents -q   # 期望 Ran 122 · OK
PYTHONPATH=src python3 -m unittest discover -s tests -q                                 # 期望 Ran 872 · 1F（00 反证）
cd /mnt/e/roco-coach
PYTHONPATH=roco/src python3 -m roco_env.regression --check                              # 期望 ✔ 一致

# ── 4. Node 判据（无需 node_modules）─────────────────────────────────────
node --test tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js \
  tests/roco-server-side-guard.test.js tests/roco-observation-contract.test.js          # 期望 28/28
node --test tests/server.test.js                                                        # 期望 26/26
# 起真引擎的端到端**需要**指定 Windows 侧 Python：
ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe' \
  node --test tests/roco-standard-pvp-battle.test.js                                    # 期望 15/15

# ── 5. 冻结时点的树指纹 ───────────────────────────────────────────────────
#    期望（冻结提交 5002433 那一棵）：TREE 2c5da5f9…（roco/src cb7e5c39… / roco/tests 7e9859d0…）
#    ⚠ 若 plan00-closer 的 D-8 在飞（coverage.py / test_effect_coverage.py），当前树会不同
#      （2026-09-30 收尾后实测：TREE d22269baad6fd2363a198f687ac0f66d41489087ff7c2637448ca8ed9f347639）
python3 scripts/roco/verify-src-treehash.py

# ── 6. 只读探活（不得重启用户服务）──────────────────────────────────────
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/roco/status   # 本机：000 / exit 7
```
