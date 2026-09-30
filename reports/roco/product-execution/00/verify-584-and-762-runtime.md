# 独立运行时取证：`584 引雷` 的翻负 & `762 小型打劫` 的正对照（harness-verifier）

**指派**：Lead（task-4 追加项）· **只出读数与结论，未改任何源码/判据/钉子**
**取证副本**：`/mnt/e/roco-scratch/verify-78766db`（`git archive 78766db`，00 切片）
**副本指纹**：`coverage.py = 21b80d3fe4dddf4c249a6a1ee1d53f4f2fe764be867ec9cba99c9885e2631006` ·
`env.py`/`service.py` = HEAD 版（plan01 在飞改动不在切片里）
**原文**：`verify-584-762-runtime.txt` / `verify-584-762-runtime.json`（本目录）

---

## 0 · 三行结论（先看这里）

| 行 | 台账（totals 用） | 产品档位 | 运行时 | 判定 |
|---|---|---|---|---|
| **584 引雷** | `PARTIAL` | `PARTIAL` | **迸发加成真的发生**（35 → 55） | **假阴性**：306 基线说 `SIM`，现在被降 ⇒ 这一行是**误降** |
| **313 / 581**（对照） | `PARTIAL` | `PARTIAL` | 加成真的发生（60→90 / 80→120） | 同样带 `迸发` 缺口，**在 306 基线里就已经是 PARTIAL** ⇒ 不是本批新造成 |
| **762 / 273 / 344 / 346 / 472 / 756** | **`SIMULATABLE_UNVERIFIED`** | **`PARTIAL`** | **真的结算**（heal / energy_gain / drain_energy / foe_team_energy_loss） | **三把尺子不同值**；**产品侧是假阴性，台账侧是对的** |

## 1 · 取证方法与控件（控件是正的，不是恒 0）

真开局、真出招：为每条技能找一只学得会的精灵 → 放进配招 → `reset(..., config="mobile_s4_candidate_v3", seed=7)`
→ 首发出手（敌手动作取 `charge` 以免互相干扰）。

**控件**：
- 正对照 `313 天旋地转`(power 60) / `581 电弧`(power 80)：运行时 `power_used = 90.0 / 120.0`，
  `conditional_reason = "迸发 → 威力 +30.0 / +40.0"` ⇒ **探针量得到迸发加成**（不是恒 0）。
- `762`：**两条独立通道**互证 —— `foe_team_energy_loss` 事件 1 条 **且** 敌方全队能量 `10→9`（6/6 只）。

```
CONTROL 313_burst_applied True
CONTROL 581_burst_applied True
CONTROL 584_burst_applied True
CONTROL 762_event_and_energy_drop {'events': 1, 'before': [10,10,10,10,10,10], 'after': [9,9,9,9,9,9]}
```

## 2 · 逐行运行时读数（原文见 `.txt`/`.json`）

| skill | 描述要点 | 解析效果 | 事件 | 运行时读数 | tier | verdict |
|---|---|---|---|---|---|---|
| **584 引雷** | `造成魔伤，2连击，迸发：本次技能威力+20。` | `[]` | turn_start, charge, damage, effects_registered_unsupported | `power_used=55.0`（35+20）· `conditional_reason="迸发 → 威力 +20.0"` | PARTIAL | False |
| 313 天旋地转 | `…先手+1，迸发：本次技能威力+30。` | `[]` | turn_start, damage, charge | `power_used=90.0`（60+30）· `"迸发 → 威力 +30.0"` | PARTIAL | False |
| 581 电弧 | `造成物伤，迸发：本次技能威力+40。` | `[]` | turn_start, damage, charge | `power_used=120.0`（80+40）· `"迸发 → 威力 +40.0"` | PARTIAL | False |
| 583 超导 | `迸发：本技能能耗-2。` | `[]` | turn_start, damage, charge | 能耗 `10→7`（未见折扣） | PARTIAL | False |
| 598 双联脉冲 | `迸发：本技能使用次数+1。` | `[]` | turn_start, charge, damage | 无「次数」事件 | PARTIAL | False |
| **762 小型打劫** | `敌方队伍中所有精灵失去1能量。` | `foe_team_energy_loss` | turn_start, charge, **foe_team_energy_loss**, status_applied | 事件 1 条 · 敌方 `[10×6] → [9×6]` | 台账 **SIM** / 产品 PARTIAL | False |
| 273 休息回复 | `自己回复30%生命。` | `heal` | turn_start, charge, **heal**, status_applied | `heal` 事件 1 条 | 台账 **SIM** / 产品 PARTIAL | False |
| 344 徒长 | `自己回复10能量。` | `self_energy` | turn_start, charge, **energy_gain**, status_applied | `energy_gain` 1 条 | 台账 **SIM** / 产品 PARTIAL | False |
| 346 根吸收 | `自己回复15%生命和4能量。` | `heal` | turn_start, **heal**, status_applied, charge | `heal` 1 条 | 台账 **SIM** / 产品 PARTIAL | False |
| 472 杠杆置换 | `自己回复2能量，交换两侧技能位置。` | `self_energy` | turn_start, charge, **energy_gain**, status_applied | `energy_gain` 1 条 | 台账 **SIM** / 产品 PARTIAL | False |
| 756 勾魂 | `偷取敌方3能量。` | `drain_energy` | turn_start, charge, **drain_energy**, status_applied | 敌方 `10 → 7` | 台账 **SIM** / 产品 PARTIAL | False |

## 3 · 结构根因（两条独立缺陷，别混成一条）

### 3.1 「迸发」两条链不同源 ⇒ 584 被误降（**新发现**）

- 运行时那条链是 **desc 驱动**：`effects.effective_power()` 里 `if "迸发" in desc` 且
  `attacker._burst_active`（`env.py:1266` 设置）⇒ 直接加威力，**不依赖解析层有没有 effect**。
- 台账那条链是 **evidence 驱动**：`diagnostic_shape_gaps()` 只认「有没有效果的 evidence 覆盖这段文本」。
  而 `parse` 对这 5 条**一条 effect 都不产**（上表 `parsed_effects=[]`）⇒ `_evidence_ranges` 为空
  ⇒ `_DIAGNOSTIC_SHAPE_PATTERNS` 的「迸发」形状**必然**记缺口。
- ⇒ 两条链对「迸发」的判定**不同源**，584 只是因此**跨过 SIM/PARTIAL 边界**的那一条。
- ⚠ **coverage.py 里那句注释与读数不符**：注释称「`313`/`581` 的迸发有 effect（`effects.py:270`+`env.py:1263`
  已接线）⇒ 被 evidence 盖住、**不记缺口**」；实测两者 `diagnostic_shape_gaps=['迸发']`、档位都是 `PARTIAL`
  （在 306 基线里也是 PARTIAL，不是本批新造成）。**注释描述的机制不存在**。

### 3.2 `SETTLED_PATTERNS` 缺 4 个类 ⇒ 6 行「三把尺子不同值」（**覆盖面比 762 一条更大**）

全台账（579 技能）逐行对照三条读数路径，**恰好 6 行**不一致：

```
skill            build_coverage(台账)        classify_declared   product_tier   verdict  settled
skill_000273     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
skill_000344     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
skill_000346     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
skill_000472     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
skill_000756     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
skill_000762     SIMULATABLE_UNVERIFIED      PARTIAL             PARTIAL        False    []
LEDGER_VS_PRODUCT_DIVERGENCE 6   （其中 ledger=SIM 而 product 非 SIM 的：6）
```

- 机制：`coverage.py:634` 的台账行用 **`classify_skill`**（不带对齐）；产品档位用
  **`classify_skill_declared`**（多一层「判据说未结算 ⇒ SIM 降 PARTIAL」的单向对齐）。
  这 6 行 `settled=[]`（`SETTLED_PATTERNS` 点不出「回复生命 / 回能 / 吸取能量 / 扣能」类）
  ⇒ `resolved=False` ⇒ 产品降 PARTIAL，台账不动。
- 运行时证明**引擎真的结算**这 6 行（上表）⇒ **产品侧/判据侧是假阴性，台账侧是对的**。
- **现有判据测不到这个分歧**：并集检查（427）比的是 `_skill_record` 档位 ↔ 判据（两者都 PARTIAL/False，一致）；
  钉子检查只钉 `totals == 306`。⇒ 这个分歧是「三把尺子里有两把一起错」的盲区。

## 4 · 对裁决的影响（**只给读数与推论，不替用户决定**）

| 若这么改 | totals | 别的读数 | 代价 |
|---|---|---|---|
| 把「迸发」诊断形状收窄到与 `effective_power()` 同源（即「真有加成才算结算」） | **306 → 307** | 584 回 `SIM`；313/581 也会回 `SIM` | 钉子 `assertEqual(totals, 306)` **重新变红** ⇒ 要改钉并附本条运行时报据 |
| 给 `SETTLED_PATTERNS` 补「回复生命 / 回能 / 吸取能量 / 扣能」类 | **不变（仍 306）** | 这 6 行判据 `resolved=True`、产品档位变 `SIM`，三把尺子同值；6 行假阴性消失 | 不动钉子；不碰反证计数（这 6 行 `unsettled` 本来就空，关闸反证仍是 5） |
| 两个都不做 | 306 | 6 行产品侧仍说 PARTIAL + 584 被误降 | —— |

> 注意两条**互不冲突**（可只做其一）；且**第一条会把钉子顶到 307**、第二条**不会动钉子**。
> 依「不许为凑 306 反向拟合」的纪律，本条只登记读数，**建议由用户裁决后再动手**。

### 4.1 上表第二行的「不变」是**实测**，不是推论

`scripts/roco/verify-settled-patterns-sim.py`（**只在隔离进程里包一层 `settlement_verdict`，
不写任何文件**；跑在 `verify-78766db` 副本上）：当「`resolved=False` 且 `unsettled==[]`
且解析效果含 `heal`/`self_energy`/`drain_energy`/`foe_team_energy_loss` 之一」时判为已结算
（即：补上缺失那几个类**应当**起的作用）：

```
TOTALS              before=306  after=306        ← 不动钉子
UNION_MISMATCHES    before=0    after=0          ← 不制造新打架
GATES_OFF_COUNT     before=5    after=5          ← 不动反证计数
CHANGED_ROWS        6 -> 273 344 346 472 756 762 ← 恰好 6 行，零旁及
   273/344/346/472/756/762: {PARTIAL, resolved=False} -> {SIMULATABLE_UNVERIFIED, resolved=True}
```

⚠ **模拟的口径边界**：本模拟只翻了 `resolved` 标志，`settled` 仍为空 —— 而
`settlement_verdict` 的原口径是 `resolved = bool(settled) and not _rows`。真正的修法必须**补类**
让 `settled` 非空（有些消费方逐字要求「`resolved` True **且** `settled` 非空」，例如 `test_moe_mark`）。
所以上面的 306/0/5 三条对「补类」的后果是可信的，但**不能**用本模拟替代实现。

## 5 · 复跑

```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-584-clean.sh
# 或：
cd /mnt/e/roco-scratch/verify-78766db/roco && PYTHONPATH=src python3 /mnt/e/roco-coach/scripts/roco/verify-584-and-762-runtime.py
# 六行分歧（三把尺子）：
cd /mnt/e/roco-scratch/verify-78766db/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-ledger-vs-product.py
```

## 6 · 边界 / 未做

- **未改任何源码、判据、钉子**（写域不同）。
- 417 条之外是否有同类「解析无 effect 但运行时 desc 驱动」的技能：本报告只对**迸发**这一类下了结论
  （5 条已逐条取数）；别类（如「应对」）另见 `verify-family2-independent.md`。
- `583 超导`（迸发 能耗-2）、`598 双联脉冲`（迸发 使用次数+1）**未见运行时产出** ⇒ 这两条的
  `PARTIAL` 与读数一致，不在假阴性清单里。
- 6 行分歧的覆盖面是**全 579 技能台账**（不是 427 并集）；`trait` 桶（245）未做同类对照。
