# 分计划 00 · 族② 收窄：`RESPOND_POWER_SETTLED_RE` 只许跳**命中那一段**（task-1）

- 执行者：`plan00-closer` · 2026-09-30 · 分支 `wip/roco-coach-2026-09-30-1418`
- 接手基线 commit `83ed968`；复核时 HEAD = `6b66147`（Lead 只加了 `STATE.json` + `harness/last-run.json`；
  两次的 `coverage.py` blob 逐字相同：`4ac9f1fb977b14f4917e6246cc6bbb2686674053`）
- 唯一源码写域：`roco/src/roco_env/coverage.py`
- 原始输出（不入库，留在 `E:\roco-scratch\`）：
  `p00-fam2.out.txt`（快速三件套+逐行）· `p00-fam2-unittest.stderr.txt`（全量）·
  `p00-respond.out.txt`（真打一手反例）· `p00-exit.out.txt`（早退爆炸半径）· `p00-sim.out.txt`（改前模拟）

## 0. 一句话

「应对…：本次技能威力…」在旧口径里是**前缀命中就放行整句**；`398 炙热波动`
「应对状态：本次技能威力**和赋予灼烧翻倍**」的后半段（引擎零产出）因此被当成已结算。
收窄成「**整条分句**都是那个形状才放行」后：`398` 如实记 `respond_clause_gaps` 并降 `PARTIAL`，
其余 11 条前缀命中行**档位不变**；并集打架仍 `0`，totals `313 → 312`。

⚠ **与派工描述的一处出入（如实登记）**：派工写「受影响行：398/637」，实测 **637 在我动手前就已经是
`PARTIAL`**（`b78474b` 补回「无视抵抗」诊断形状时一并修掉，见 §4 读数）⇒ 本族真实翻正**只有 398 一行**。

## 1. 改动（`roco/src/roco_env/coverage.py`）

| | git blob | sha256 | 行数 |
|---|---|---|---|
| 改前（HEAD） | `4ac9f1fb977b14f4917e6246cc6bbb2686674053` | `36650edf4f2e87f36947b459bdeb4bcc5e7eecee225331ca74047839bf577022` | 1582 |
| 改后（工作树） | — | `e7e7edc21a97a4ba35eb095dbd9f8e491b6459ab29583caf355cebd8cfd92a86` | 1622 |

三处改动（**同一个谓词，三处调用** —— 不各写一份）：

1. 新增 `RESPOND_POWER_SETTLED_CLAUSE_RE`（**整条分句**形状）+
   `_is_settled_respond_power_clause(clause)`（`fullmatch`，不是 `search`）+
   `_has_settled_respond_power_clause(skill)`（描述里**有没有整条分句**是那个形状）；
2. `classify_skill` 第 306-308 行那条早退：`RESPOND_POWER_SETTLED_RE.search(desc)` →
   `_has_settled_respond_power_clause(skill)`（**全描述级前缀命中**收成**分句级整条**）；
3. `residual_mechanic_spans()` 与 `respond_clause_gaps()` 两处跳步：`search(clause)` →
   `_is_settled_respond_power_clause(clause)`。

`RESPOND_POWER_SETTLED_RE` **本体逐字不动**（`test_effect_coverage.py:209` 与
`scripts/roco/smoke-service-import.py` 逐字按名用它）—— 注释改成「**前缀**形状，只留给诊断读数」。
两条既有豁免照旧：只有 `has_static_power` 的技能才吃这个跳步；防御技那条光秃秃的「应对攻击」照旧豁免。

## 2. 改前读数（`p00-fam2.out.txt` 之前的一轮，totals＝313）

```
union 0 totals 313
相对真基线 reports/roco/rc401/effect-coverage.json（totals=306）：
  翻正 8 = 398 + 430/441/531/532/534/682（族③）+ 762 小型打劫
  翻负 1 = 584 引雷
skill_000398 炙热波动：TIER=SIMULATABLE_UNVERIFIED
    respond_clause_gaps=[]  residual_mechanic_spans=[]  diagnostic_shape_gaps=[]
    settlement_verdict: resolved=True  unsettled=[]
skill_000637 虫击：TIER=PARTIAL
    diagnostic_shape_gaps=['无视抵抗']  unsettled=['无视抵抗']
```

**旧口径跳掉了哪些分句（改前逐行，`p00-radius.py` A 段）**：579 条战斗技能里共 **12 条**
分句命中前缀，其中 11 条是完整形状、只有 `398` 是「前缀 + 另一条机制」：

| skill | 分句 | 命中前缀 | 剩余 |
|---|---|---|---|
| 000255 突袭 | 应对状态：本次技能威力变为3倍 | 应对状态：本次技能威力 | 变为3倍 |
| 000259 偷袭 | 应对状态：本次技能威力变为3倍 | 同上 | 变为3倍 |
| 000379 闪燃 | 应对状态：本次技能威力变为4倍 | 同上 | 变为4倍 |
| **000398 炙热波动** | 应对状态：本次技能威力**和赋予灼烧翻倍** | 同上 | **和赋予灼烧翻倍** |
| 000518 地陷 | 应对状态：本次技能威力翻倍 | 同上 | 翻倍 |
| 000564 吹炎 | 应对状态：本次技能威力翻倍 | 同上 | 翻倍 |
| 000637 虫击 | 应对状态：本次技能威力变为2倍 | 同上 | 变为2倍 |
| 000662 无影脚 | 应对状态：本次技能威力变为2倍 | 同上 | 变为2倍 |
| 000665 技巧打击 | 应对状态：本次技能威力变为10倍 | 同上 | 变为10倍 |
| 000674 爆冲 | 应对状态：本次技能威力变为5倍 | 同上 | 变为5倍 |
| 000690 龙卷风 | 应对状态：本次技能威力变为1.5倍 | 同上 | 变为1.5倍 |
| 000771 暗突袭 | 应对状态：本次技能威力翻倍 | 同上 | 翻倍 |

**爆炸半径先测后改**（`p00-sim.py`，monkeypatch 模拟，**没落笔**）：

```
[0 · 现状]                                  totals=313 union=0 翻正=8 翻负=1 反证(关闸)=5
[族② v1 · 只收窄 respond_clause_gaps]        totals=312 union=0 翻正=7 翻负=1 反证(关闸)=5
[族② v2 · 上述 + residual_mechanic_spans]    totals=312 union=0 翻正=7 翻负=1 反证(关闸)=5
[族③ · 非冒号体不再认领]                     totals=307 union=0 翻正=2 翻负=1 反证(关闸)=5
[族②v2 + 族③]                              totals=306 union=0 翻正=1 翻负=1 反证(关闸)=5
```

⇒ v1 与 v2 **读数完全相同**（都只动 `398` 一行），所以「三处共用同一谓词」不是行为扩大，是**关掉同一类洞**。
第 306-308 行那条早退单独测（`p00-exit.py`）：命中它且**没有整条分句**的技能 = **0 行** ⇒ 该处收窄
对当前语料 **0 影响**（属「留着一个洞」，不是改读数）。

## 3. 改后三件套（原始输出）

```
$ wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p00-fam2.sh
=== [1] import roco_env.service ===        OK                       exit=0
=== [2] union-check.py ===                 union 0 totals 312       exit=0
=== [3] p00-delta.py ===                   exit=0
=== [4] p00-rows.py ===                    exit=0
=== [5] p00-radius.py ===                  exit=0
```

- **并集打架 427 条：`0`**（未新增任何打架）
- **totals：`312`**（313 → 312；相对真基线 306 仍 +6，全部是族③的六行）
- 逐行差（`p00-delta.py`，totals 口径 = `classify_skill`）：

```
翻正=7 翻负=1 其他=1
  + 430 水环 / 441 洗礼 / 531 冰晶坠 / 532 冰雹 / 534 冰冻光线 / 682 防御反击   ← 族③（下一件）
  + 762 小型打劫（有运行时报据，属合法翻正，不动）
  - 584 引雷（假阴性，不属本族，不动）
  ~ 684（KNOWLEDGE_ONLY → PARTIAL，非 SIM 换档）
```

- **定向判据**（`p00-fam2-targeted.sh`，与 `result.json` 基线逐条对照）：

```
tests.test_effect_coverage                Ran 21  FAILED (failures=1)   exit=1   ← 基线 21 ran 1F ✓
tests.test_tier_verdict_agreement         Ran 8   FAILED (failures=1)   exit=1   ← 基线 8 ran 1F ✓
tests.test_global_skill_mods_transition   Ran 3   OK                    exit=0
tests.test_cleanse_marks                  Ran 16  OK                    exit=0
tests.test_respond_override               Ran 31  OK                    exit=0
```

- **全量**（`p00-fam2-full.sh`，约 193 s；⚠ 这棵树**含 plan01-engine 未提交的改动**）：

| 跑次 | 结果 | 8/3 条失败归谁 |
|---|---|---|
| A（含 plan01 中间态） | `Ran 857 · 3 failures + 0 errors · skipped=2`，233 s | 2 条 00 已知红（`312 != 306` · `5 < 8`）+ 1 条 plan01 中间态（子进程 `env.py:4198 NameError: OPENING_REVEAL_SOURCE`） |
| B（plan01 中间态修好后） | `Ran 857 · 8 failures + 0 errors · skipped=2`，200.973 s | 同样 2 条 00 已知红 + **6 条 plan01 契约红**（`test_event_text` · `test_public_planner` · `test_regression_set` · `test_sim_endpoints` · `test_turn_order_fail_closed` ×2） |

两次之间 `coverage.py` **sha256 逐字相同**（`e7e7edc2…`）⇒ A→B 新增的 6 条红**全归 plan01 那一批**，
与本族无关。基线 `Ran 847` 变成 `857` 也是 plan01 新增的 `test_public_planner.py`（+10 条）。
**00 的两条已知红读数**：`test_report_has_no_simulatable_with_unclaimed_mechanic_spans` =
`AssertionError: 312 != 306`；`test_counter_proof_disabling_the_shared_gates_brings_them_back` =
`AssertionError: 5 not greater than or equal to 8`（与 verifier 的独立读数 5 一致，不在本任务范围）。

## 4. 受影响行逐行（改前 → 改后）

| skill | 项 | 改前 | 改后 |
|---|---|---|---|
| **398 炙热波动** | support_tier | `SIMULATABLE_UNVERIFIED` | **`PARTIAL`** |
| | support_why | 「描述被完整读出（1 条效果），且没有未认领片段」 | 「读出了 1 条效果，但描述里还有 1 段机制**引擎没结算**：应对：应对状态：本次技能威力和赋予灼烧翻倍」 |
| | `respond_clause_gaps` | `[]` | `['应对：应对状态：本次技能威力和赋予灼烧翻倍']` |
| | `settlement_verdict` | `resolved=True` · `unsettled=[]` | `resolved=False` · `unsettled=['应对：应对状态：本次技能威力和赋予灼烧翻倍']` |
| | claims | `['连击×1']` · effects=`foe_status(敌方获得4层灼烧)` | 同（威力那半本来就不产 effect，靠 `effective_power()`） |
| **637 虫击** | support_tier | `PARTIAL` | `PARTIAL`（**未变**） |
| | `diagnostic_shape_gaps` | `['无视抵抗']`（`b78474b` 已修） | `['无视抵抗']` |
| | `respond_clause_gaps` | `[]` | `[]`（它的应对子句**整条**就是那个形状 ⇒ 照旧放行，正确） |
| | verdict | `resolved=False` · `unsettled=['无视抵抗']` | 同 |

**「不越收」读数**（`p00-over11.py`：12 条前缀命中行，逐行比基线）：

```
skill_000255 基线SIM → 现在SIM  判据True
skill_000259 基线SIM → 现在SIM  判据True
skill_000379 基线SIM → 现在SIM  判据True
skill_000398 基线PARTIAL → 现在PARTIAL 判据False   ← 只有它换了档（SIM→PARTIAL）
skill_000518 基线SIM → 现在SIM  判据True
skill_000564 基线PARTIAL → 现在PARTIAL 判据False
skill_000637 基线PARTIAL → 现在PARTIAL 判据False
skill_000662 基线SIM → 现在SIM  判据True
skill_000665 基线SIM → 现在SIM  判据True
skill_000674 基线SIM → 现在SIM  判据True
skill_000690 基线PARTIAL → 现在PARTIAL 判据False
skill_000771 基线PARTIAL → 现在PARTIAL 判据False
```

## 5. 反例（两向，**真开局、真出招**；`p00-respond.out.txt`）

做法：让**敌方真的出一手状态技**（`skill_000271 力量增效`，应对状态 ⇒ 应对成功），读
`damage.power_used` / 事件流 / 敌方 `statuses`。同一脚本、同一 seed、同一配招。

**反例 A · 收窄抓到的这一段真的没结算（398）**

```
skill_000398 炙热波动 | power=55 | _respond_succeeded=True
  damage        {"skill_id":"skill_000398","damage":125,"power_used":110.0,
                 "conditional_power":true,"conditional_reason":"应对成功 → 威力翻倍"}
  status_added  {"side":"enemy","status":"灼烧","layers":4,"layers_total":4,"turns_left":4}
  敌方 statuses: {} -> {"灼烧": {"layers": 2, "turns_left": 3}}     ← 没有「翻倍」
  state.unsupported(0)=[]
```

⇒ 同一条分句里**两半分开**：威力那半**真的翻了**（55→110，`conditional_reason` 逐字），
「赋予灼烧翻倍」那半**零事件**（`status_added` 只发基础 4 层；没有任何 event 提到翻倍；
`unsupported` 也是 0 —— 旧口径下引擎自己的诊断也看不见它，正是那条假绿）。
**这就是「收窄真的生效」**：改后 `respond_clause_gaps` 记了这个缺口、档位降 `PARTIAL`、判据 `resolved=False`。

**反例 B · 收窄没有误伤整条就是那个形状的（255/637）**

```
skill_000255 突袭 | power=70 | _respond_succeeded=True
  damage {"power_used":210.0,"conditional_power":true,"conditional_reason":"应对成功 → 威力 ×3.0"}
skill_000637 虫击 | power=90 | _respond_succeeded=True
  damage {"power_used":180.0,"conditional_power":true,"conditional_reason":"应对成功 → 威力 ×2.0",
          "type_multiplier":0.5}
```

⇒ 两条的应对子句**整条**就是「应对状态：本次技能威力N倍」，运行时确实结算（×3 / ×2）⇒
`respond_clause_gaps` 仍为 `[]`、档位仍 `SIMULATABLE_UNVERIFIED`、判据仍 `True`。
637 的 `type_multiplier=0.5`（虫系被抵抗）恰好旁证：同句**另一条分句**「无视敌方系别抵抗」
确实没结算，而它由**另一条**闸（诊断形状 `无视抵抗`）如实记着 —— 两条闸各管各的分句。

## 6. 诚实边界 / 未做

1. **637 的修复不是本族的功劳**：`b78474b`（族① 补回诊断形状）已经把它降成 `PARTIAL`；
   本族真实翻正 = **398 一行**。派工描述的「398/637 两行」按当前树复核为 **1 行**。
2. 第 306-308 行早退的收窄对当前语料 **0 行影响**（测得），它是**关洞**不是改数；若哪天
   出现「全描述有形状、但没有一条分句整条是形状」的语料，这条收窄才会生效。
3. `totals` 仍比真基线 306 高 **6**，全部是族③ 的六行（下一件 task-2）；`762`（合法翻正）与
   `584`（假阴性）不属本族，**未动**。
4. 全量读数的树**不干净**（含 plan01-engine 未提交改动，见 §3 表）；本报告只对 `coverage.py`
   的改动负责，集成时以 Lead 的 src 树 hash 为准。
5. **未改任何判据断言**（`roco/tests/**` 一行未动）—— 本族不需要改钉。
6. `5 < 8`（关闸反证）与 `312 != 306` 两条已知红：前者不在本任务范围；后者按预判会在
   task-2（族③）收掉六行后回到 **306** 并转绿（届时以 task-2 报告的三件套读数为准）。
