# 三切片权威复验汇总（harness-verifier · task-4）

**方式**：每个切片都用**整仓 `git archive <SHA>`** 解到 `E:\roco-scratch\verify-<sha>` 的不可变副本里跑，
**不在共享工作树上跑**。三个副本与产物：

| 切片 | 副本 | 日志 |
|---|---|---|
| `2e30a4f` | `/mnt/e/roco-scratch/verify-2e30a4f` | `harness/verify-slice-2e30a4f.txt`（首跑）· `full-2e30a4f-rerun.{stdout,stderr}.txt`（整仓重跑） |
| `5002433` | `/mnt/e/roco-scratch/verify-5002433` | `harness/verify-slice-5002433.txt` · `targeted-5002433.stderr.txt` · `full-5002433.stderr.txt` |
| `59e55df` | `/mnt/e/roco-scratch/verify-59e55df` | `harness/verify-slice-59e55df.txt` · `full-59e55df.stderr.txt` |

---

## 0 · 一张表

| 项 | `2e30a4f`（缺陷 B，无 01） | `5002433`（01 引擎侧，无 D-8） | `59e55df`（全部，含 D-8） |
|---|---|---|---|
| 全量汇总行（原文） | `Ran 847 tests in 170.046s` / `FAILED (failures=1, skipped=2)` | `Ran 872 tests in 162.004s` / `FAILED (failures=1, skipped=2)` | `Ran 872 tests in 164.470s` / `FAILED (failures=1, skipped=2)` |
| 退出码 | 1 | 1 | 1 |
| 唯一红 | 反证 `5 >= 8` | 反证 `5 >= 8` | 反证 `5 >= 8` |
| `totals.simulatable_entities` | **306** | **306** | **309** |
| 并集打架（427） | **0** | **0** | **0** |
| 关闸反证 | 5（`412/510/539/671/694`） | —（01 未动闸） | 5（**同组**）· `CONTROL_FLIPS 23`（非 0 ⇒ patch 有效） |
| 定向 5 模块 | — | `Ran 122` **OK** exit 0 | — |
| 隔离验收 | exit 0 · 6/6 | exit 0 · 6/6 | exit 0 · 6/6 |
| 树 hash `roco/src` | `06036bf291a1d68e970f4247276d78b0953e86e8e4a40272fd7825a3a007fee3` | `6dc07a8312ae4ca0dbe29b96f396ccb60ccd1d0febfebe67f84b30e736ffc8ad` | `4b5f6137e0f6dc76dec183cda6a58d0b2a2b87c9b0a24140e8f2c77be18fd5bc` |
| 树 hash `roco/tests` | `e98b8abef998c1a43c6a8cab4921e860d9eb21d624e53496183857fee6e5069d` | `7e9859d05897d56872cb017d4a5f6fc465172f3f38c8d553abafd9cad45a3a16` | `5ea7472f6da29cef7af8292c4504c778bab191f977ef6e1505b933ca1800288c` |
| `TREE` | `81fa0753180e6766d901ec8fa9e554dd83254b48be88afd4a53f850d414eb81b` | `b62fac0b59a1bfebb2580cf7eeb33b4701177af6577d2bc299a7c77e0ca8746a` | `644d7b4a2ee6759624cd5b019b481a42a8aa0cce3cfd4f5f4dae4d0c69afa312` |

**三组都与 Lead 的预期逐项一致；没有任何一条「第 2 红」。**

## 1 · `2e30a4f`（缺陷 B）细则

```
SETTLED_CHANGED_ROWS 38（其中未带动 tier/resolved 的 32）
CHANGED_ROWS 6 -> ['273','344','346','472','756','762']
GUARD_ROWS（改前有目标类效果但未结算）15 -> 被误翻正 0
GUARD_ROWS_B（改前未结算且 unsettled 非空）274 -> 被误翻正 0
7 条真·零事件反例（269/366/369/537/745/760/793，各 12 组敌手动作，按 side/skill_id 归因）全过
TOTALS 306 · UNION_MISMATCHES 0 · GATES_OFF_COUNT 5（同组）· DEFECT_B_FAILS 0
LEDGER_VS_PRODUCT_DIVERGENCE 0（改前 6）
```
`--selftest` 6 项控件 `ALL_PASS`。**`settled` 是真类名**（`回复生命/回能/吸取能量/扣能`），不是只翻标志。

## 2 · `5002433`（01 引擎侧）细则

```
定向 : Ran 122 tests in 15.685s / OK / exit 0
契约 : 浅探针 CONTRACT_FAILS 0 · 深探针 DEEP_FAILS 0
公开面: FAILS 0（差分控件见下）
Node : 4 支契约用例 tests 28 · pass 28 · fail 0（exit 0）
       server.test.js  tests 26 · pass 26 · fail 0（exit 0）
       roco-standard-pvp-battle.test.js（ROCO_PYTHON=C:\Users\ASUS\anaconda3\python.exe）
                      tests 15 · pass 15 · fail 0（exit 0）  ← 实现者报「本机跑不了」的那批，我跑通了
```
**深探针读数**（`verify-01-contract-deep.py`，自建）：
```
D1 match_id 同队同规则换 seed 相同 · 换己方队员变 · 换 config 变
D2 decision_id=<match_id>:v<state_version>，推进后跟随（:v4）
D3 state_version == len(state.events)；信封行 seq=[1,2,3] == 它们在 state.events 里的下标
D4 预览事件与回执 opening_reveal 实质载荷同源（回执只多 seq/text）；roster 行键恰为 {slot,pet_id,name}；
   无 skill_*/隐藏个体字段
D5 不请求预览 ⇒ 0 事件、state_version=0、无 opening_reveal 键；只改隐藏真值（对手真实配招+后备 hp/energy）
   ⇒ 三面 JSON 逐字节相同
D6 换已展示阵容 ⇒ 预览载荷确实变（反向对照）
```

**Node 端到端那条实现者没跑的**：`ROCO_PYTHON` 指向 Windows 侧 Python 3.11.5 后
`node --test tests/roco-standard-pvp-battle.test.js` **15/15 全绿**，不再受「找不到 python3」限制。

## 3 · `59e55df`（D-8 全量）细则

```
逐 id 差分（2e30a4f -> 59e55df）: CHANGED_IDS 4 / 579
  313 / 581 / 584 : fields=['tier','resolved','unsettled']   ← 恰好 3 行翻正
  587              : fields=['unsettled']                     ← **只动缺口列表**，tier/resolved 仍 PARTIAL/False
迸发专项: 313=SIM · 581=SIM · 584=SIM · 583/587/598/607=PARTIAL
  CTL power_type_bonus_applied ['313','581','584']
  CTL non_power_type_still_unresolved ['583','587','598','607'] · wrongly_resolved []
台账（vs 306 钉）: 翻正 313/581/762 · 翻负 0 · 同带内 684 ⇒ 306 + 3 = 309
```

## 4 · 与声明不符处

**实现侧：没有发现不符。** 三处「对不上」都是**我自己的工具/期望错**，已在写域内修正并留注释：

| # | 现象 | 裁定 | 处置 |
|---|---|---|---|
| 1 | `2e30a4f` 首跑出现第 2 红 `test_every_done_item_has_existing_evidence` | **我的抽取命令漏了 `docs/`**（选择性抽取 + git pathspec 不带斜杠会在任意深度匹配，只带进 `docs/roco/*`）。tracked 文件 `docs/roadmap/DSH-EXECUTION-STATE.md` 不在副本里 ⇒ 判据红。**改整仓 `git archive` 重跑 = `Ran 847 · 1F`** ⇒ 与代码无关 | 已改：三切片一律整仓抽取；首跑读数如实留在 `verify-slice-2e30a4f.txt` |
| 2 | 浅探针把 `event_seq`/`opening_roster_revealed` 记为「尚未实现」 | **探针期望写错**（Lead 裁定，我复核后同意）：`event_seq` 是每个事件行上的 `seq`；预览事件只在显式请求 `opening_preview` 时产生 | 已改：查信封行 `seq` 下标；默认请求预览 + 新增 `--no-preview`；标签改 `ABSENT/NOT-REQUESTED` |
| 3 | 浅探针报「预览事件未两处同源」 | **探针找错位置**：回执那一份在 `result.opening_reveal`，不在 `result.events`（`battle_new` 一跳无新增事件行） | 已改：回执侧取 `opening_reveal`，比 `kind/turn/detail` 实质载荷 ⇒ `same_source=True` |

**一处实现者数字与切片实测不同（不影响结论，登记）**：`01.3-reveal-and-contract.md` §8 #11 声称
`roco/src` 树 hash = `cb7e5c39…`；我在**切片副本**上实测 =
`6dc07a83…`（`roco/tests 7e9859d0…` 与它**一致**）。⇒ 它的数字取自**当时的工作树**，不是切片提交内容；
`tests` 一致说明判据树相同，只有 `src` 有差异。**以切片实测为准。**

## 5 · 复跑

```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-slices-fixed.sh   # 2e30a4f 重跑 + 5002433
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-slice-59e55df.sh  # D-8
# Node（Windows 侧，工作目录 = 副本）
#   node --test tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js \
#               tests/roco-server-side-guard.test.js tests/roco-observation-contract.test.js
#   node --test tests/server.test.js
#   $env:ROCO_PYTHON='C:\Users\ASUS\anaconda3\python.exe'; node --test tests/roco-standard-pvp-battle.test.js
```
