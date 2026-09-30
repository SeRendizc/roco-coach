# 分计划 00 · 缺陷 B 收口：`settled` 补四类（回复生命 / 回能 / 吸取能量 / 扣能）

- 执行者：`plan00-closer` · 2026-09-30 · 授权：Lead（用户先前写进任务书的预授权：
  「若要动 `build_coverage` 走 `classify_skill_declared`，**必须同时**给 `SETTLED_PATTERNS` 补
  回复生命/回能/吸取能量/扣能 类（否则 273/344/346/472/756/762 误降）」）
- 写域：`roco/src/roco_env/coverage.py`（唯一源码改动）+ `reports/roco/product-execution/00/`
- **不在共享工作树上跑全量**：全部读数在 `git archive 78766db` 的干净副本
  （`/mnt/e/roco-scratch/p00-clean`，不含 plan01-engine 在飞改动）里做
- 原始输出（留 `E:\roco-scratch\`）：`p00-b-after.out.txt`（逐行差分）· `p00-b-runtime.out.txt`（真打一手）·
  `p00-b-magnitude.out.txt`（幅度 + 宽词误贴标签计数）· `p00-b-targeted.out.txt`（定向）·
  `p00-b-unittest.stderr.txt`（全量）· `p00-b-orig-blocks.txt`（原值逐字）· `p00-snap-{before,after}.json`（579 行快照）

## 0. 一句话

判据侧过去**只按文本子串**认已结算类，漏了四个**引擎真有结算支**的原语类 ⇒
`273/344/346/472/756/762` 六行 `settled=[]` ⇒ `resolved=False`（**假阴性**：产品档位被"比结论"跟着降成 `PARTIAL`）。
补类后：**恰好这 6 行** `{PARTIAL, resolved=False}` → `{SIMULATABLE_UNVERIFIED, resolved=True}`，
`ledger_tier`/`unsettled` **0 行**变化，`totals 306 → 306`、`union 0 → 0`、关闸反证 `5 → 5`，
干净副本全量 `Ran 847 · 1F + 0E`（唯一红 = 已知的 `5 >= 8` 反证）。

## 1. 原值逐字留档（交付件 ②）

### 1.1 原 `SETTLED_PATTERNS` 全块（`78766db:roco/src/roco_env/coverage.py`，逐字）

```python
#: 「描述里写了、且引擎真的会出这一手」的**类**（类名, 触发词）。命中 ⇒ 记进 `settled`。
#: 形状与既有实现一致（`[类名, [触发词…]]` 的列表）。
#:
#: 类名/覆盖面来自**三处已落盘的读数**（缺一不可）：
#:   · `_settlement_lists-抽取前基线-2026-09-30.md`：原版语义 + 指纹 + 「`settled` 非空 535 / 空 44」；
#:   · 由**丢失的那版实现**生成的 `roco/tests/data/pets100-skills-census.json`：类名与频次
#:     （伤害 89 · 应对 67 · 持续状态层数/回合 26 · 双攻升降 24 · 减伤 24 · 印记层数累加 13 · 驱散 11 …）；
#:   · 各判据 `assertIn` 逐字点名的类名（转移标记 / 本手威力加成 / 全技能持久修正）。
#: ⚠ **「伤害」这一类不许用裸词**：`389 充分燃烧`「触发1次灼烧伤害」里也有「伤害」二字，
#:   而它必须 `resolved=False`（E 堆）。所以只认「造成物伤 / 造成魔伤」这种**真的出兵**的写法。
SETTLED_PATTERNS = (
    ("伤害", ("造成物伤", "造成魔伤", "造成物理伤害", "造成魔法伤害")),
    ("减伤", ("减伤",)),
    ("应对", ("应对",)),
    ("能量回复", ("能量回复",)),
    ("持续状态层数/回合", ("层",)),
    ("双攻升降", ("双攻", "物攻", "魔攻", "物防", "魔防", "速度")),
    ("印记层数累加", ("印记",)),
    ("驱散", ("驱散",)),
    ("转移标记", ("转移",)),
    # 萌化标记：`env` 真的把它路由到 `PetState.marks`（`STATUS_AS_MARK`）⇒ 是一类
    # "引擎会出这一手"的机制。`test_moe_mark` / `test_moe_bidirectional` / `test_moe_colon`
    # 都要求「`resolved` True **且 `settled` 非空**」；而 `273 休息回复`（只有 heal、
    # 没有这一类）照旧 `settled` 空 ⇒ 仍判 False（两条不冲突，靠的是**这个类只匹配萌化**）。
    ("萌化标记", ("萌化",)),
    ("本手威力加成", ("本次技能威力",)),
    ("全技能持久修正", ("全技能",)),
)
```

（注意最后那条注释：它**逐字写下了**「`273 休息回复`…照旧 `settled` 空 ⇒ 仍判 False」——
那是**旧的**设计意图；`5` 行同类假阴性就是它留下的。本件按预授权改掉的是**结果**，
原注释一并留档在这里。）

### 1.2 原 `settlement_verdict()` 里算 `settled` 的两行（逐字）

```python
    settled = [name for name, words in SETTLED_PATTERNS
               if any(word and word in desc for word in words)]
```

### 1.3 消费方「`settled` 必须有东西」的原断言（逐字，未改一行）

```
test_moe_colon.py:89          self.assertTrue(v["settled"], "⚠ **`settled` 必须有东西** —— 否则 `unsettled` 空 + `settled` 空 ⇒ 打架 ✗")
test_moe_bidirectional.py:91  self.assertTrue(v["settled"], "⚠ `settled` 必须有东西（否则两边空 ⇒ 打架 ✗）")
test_mark_transfer.py:98      self.assertIn("转移标记", v["settled"], "`settled` 必须有这一条（否则永远 False ✗）")
test_self_power_flat.py:102   self.assertIn("本手威力加成", v["settled"], "`settled` 必须有这一条（否则两边空 ⇒ 打架 ✗）")
test_global_skill_mods_transition.py:75  self.assertIn("全技能持久修正", v["settled"], f"{sid} 的 `settled` 要有那一条 ✗")
test_tier_verdict_agreement.py:117       self.assertIn("驱散", v["settled"])
```

⇒ 所以**不许只翻 `resolved` 标志**（verifier 的模拟正是只翻标志，不能当实现）：必须真的往 `settled` 里补类。

### 1.4 改动前读到的「四类效果」现状（`rc401/effect-coverage.json` 基线 + 本次实测）

| 行 | desc | 解析效果 kind | 改动前 |
|---|---|---|---|
| 273 休息回复 | 自己回复30%生命。 | `heal` | `settled=[]` · `resolved=False` · 产品档 `PARTIAL` |
| 344 徒长 | 自己回复10能量。 | `self_energy` | 同上 |
| 346 根吸收 | 自己回复15%生命和4能量。 | `heal` | 同上 |
| 472 杠杆置换 | 自己回复2能量，交换两侧技能位置。 | `self_energy` | 同上 |
| 756 勾魂 | 偷取敌方3能量。 | `drain_energy` | 同上 |
| 762 小型打劫 | 敌方队伍中所有精灵失去1能量。 | `foe_team_energy_loss` | 同上 |

## 2. 改了什么（最小改动 · 三处）

`coverage.py` sha256 轨迹：`21b80d3f…`（`78766db`，族②③收口后）→ **`877dbbb5…`**（本件，1646 行）

1. **新增 `_SETTLED_EFFECT_CLASSES`**（`SETTLED_PATTERNS` 的**按效果 kind** 姊妹表）：
   ```python
   _SETTLED_EFFECT_CLASSES = (
       ("heal", "回复生命"),
       ("self_energy", "回能"),
       ("drain_energy", "吸取能量"),
       ("foe_team_energy_loss", "扣能"),
   )
   ```
2. **`settlement_verdict()` 末尾**：文本表算完 `settled` 后，按上表把**真的存在那条效果**的类追加进去
   （只追加、不去重文本表已有的名字；不碰 `unsettled`/`resolved` 的算法）。
3. **改正一处与实测不符的注释**（见 §6）。

### 2.1 为什么是「按 kind」而不是「往文本表里加 `回复`/`偷取`/`失去`」

那张表是**子串匹配**（`any(word in desc)`）。逐词量化（`p00-b-magnitude.sh` B 段，只读）：

```
词「回复」命中 46 行；其中**没有**对应效果 kind 的 12 行（会被贴错标签）
词「偷取」命中  5 行；其中没有对应效果 kind 的  2 行（650 翅刃「偷取**印记**」/ 655 拟寄生「偷取敌方1层印记」）
词「失去」命中 12 行；其中没有对应效果 kind 的  8 行（266/321/406/774/796「每失去5%生命」·
                                                    745「应对覆盖」· 758 魔镜 foe_stat · 793）
```

⇒ 按宽词加类会给 **22 行与效果无关的行**贴「回复生命/回能/吸取能量/扣能」标签
（例如 `266 垂死反击`「自己每失去5%生命」会被标成「扣能」）。
按 kind 则**只有真的产出那条效果的行**才拿到类 —— 与 `_apply_capability_resolvers` 的
「认领只由证据算、不另抄词表」同一条纪律。

## 3. 运行时报据（6 行真打一手；`p00-b-runtime.out.txt` / `p00-b-magnitude.out.txt`）

同一方法：找一只学得会的精灵 → `env.reset(seed=7, config=mobile_s4_candidate_v3)` →
把血/能量压出空间（`hp=max_hp/2`、`energy=4`）→ 真出一手 → 读**事件流原文**。

```
273 休息回复   hp 166->265   RAW {"kind":"heal","detail":{"side":"player","healed":99}}                       settled=['回复生命']
344 徒长       energy 4->10  RAW {"kind":"energy_gain","detail":{"amount":8,"energy_after":10,
                                 "evidence_text":"自己回复10能量"}}                                            settled=['回能']
346 根吸收     hp 188->244   RAW {"kind":"heal","detail":{"side":"player","healed":56}}                       settled=['回复生命']
472 杠杆置换   energy 4->6   RAW {"kind":"energy_gain","detail":{"amount":2,"energy_after":6,
                                 "evidence_text":"自己回复2能量"}}                                             settled=['回能']
756 勾魂       敌 5->1        RAW {"kind":"drain_energy","detail":{"side":"player","taken":3}}                 settled=['吸取能量']
762 小型打劫   敌全队各 -1   RAW {"kind":"foe_team_energy_loss","detail":{"lost":[{"pet_id":"pet_000003","lost":1},
                                 …6 只各 lost 1…],"amount":1}}                                                 settled=['扣能']
```

**空白对照（同法，满血/满能量时）**：273/346 仍发 `heal`（`healed: 0`）、344/472 仍发
`energy_gain`（`amount` 被上限截断）⇒ 事件是**结算支真的跑到**，不是靠数值凑出来的。

## 4. 反例 / 控件（交付件 ④）

**反例 ①（必交）· 声称回复能量但运行时零事件 ⇒ 仍判未结算**：

```
537 雾气环绕「回复能量，回复值等于敌方技能总能耗的一半。」
  台账侧: TIER=PARTIAL | resolved=False | settled=[] | unsettled=['回复：回复能量', '回复：回复值等于敌方技能总能耗的一半']
  真打一手: hp 354->354 | energy 10->9 | 事件流 turn_start,defense,status_unsupported
  ⇒ 能量/生命类事件 **零**（解析层零产出 ⇒ 拿不到任何 kind 类 ⇒ 补类**不是恒真放行**）
```

**控件 ②· 有类但另有缺口 ⇒ 仍判未结算**（防止「补类=万事大吉」）：

```
351 移花接木「自己回复15%生命，随后脱离。」
  settled=['回复生命']（类拿到了）· 但 unresolved=['解析得出但没有结算分支：escape']
  ⇒ TIER=PARTIAL | resolved=False（真打一手确实发 heal，可 escape 那一半没结算）
```

**控件 ③· 负对照（同词不同值不误伤）**：`583 超导`「迸发：本技能能耗-2」两回合都付 3 点能耗、
`power_used` 不变 ⇒ 仍未结算（与 `584 引雷` 取证件 §3 同一份读数）。

**控件 ④· 探针看得出事件**：上表 6 行的事件全都带 `kind` + 数值（99/8/56/2/3/6×1），
不是恒 0 读数；`537` 的「零」是同一次运行里 **`status_unsupported` 在、能量类事件不在**，两向都能分。

## 5. 必交读数（干净副本 `git archive 78766db` + 本件改动）

### 5.1 全 579 行逐行差分（`p00-b-after.sh` → `p00-snap-diff.py`，exit=0）

```
before root=/mnt/e/roco-scratch/p00-clean | after root=/mnt/e/roco-scratch/p00-clean | rows=579
totals            306 -> 306
union_mismatches  0 -> 0
gates_off         5 -> 5

【必须恰好 6】{(svc_tier, resolved)} 变化行: 6
   skill_000273 休息回复: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (自己回复30%生命。)
   skill_000344 徒长: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (自己回复10能量。)
   skill_000346 根吸收: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (自己回复15%生命和4能量。)
   skill_000472 杠杆置换: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (自己回复2能量，交换两侧技能位置。)
   skill_000756 勾魂: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (偷取敌方3能量。)
   skill_000762 小型打劫: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True (敌方队伍中所有精灵失去1能量。)
【必须 0】ledger_tier（build_coverage 口径）变化行: 0 []
【必须 0】unsettled 变化行: 0 []
【信息】settled 列表变化行: 38（**只增标注**、不动 resolved/tier）
```

⚠ **`settled` 变化行 = 38（不是 6）**，如实登记：这 38 行都是**真的产出**了
`heal/self_energy/drain_energy/foe_team_energy_loss` 之一的行（例如 246 抓挠 / 378 火苗 / 723 甜心续航），
拿到的是**它们确实有**的类名；`resolved`/`unsettled`/两种 tier **一行都没动**。
对照 §2.1：宽词方案会在这 38 行之外再给 22 行贴**假**标签。

### 5.2 totals / union / 关闸反证

| 项 | 改前 | 改后 | 判据 |
|---|---|---|---|
| `totals.simulatable_entities` | 306 | **306** | 必须 306（钉子不动）✓ |
| 427 并集打架 | 0 | **0** | 必须 0 ✓ |
| 关闸反证（`respond_clause_gaps`+`UNSETTLED_WORDS` 关掉） | 5 | **5** | 必须仍 5（`412/510/539/671/694`）✓ |

### 5.3 定向判据（干净副本）

```
tests.test_effect_coverage             Ran 21  OK                    exit=0
tests.test_tier_verdict_agreement      Ran 8   FAILED (failures=1)   exit=1   ← 仍是那条 5>=8 反证（已知红）
tests.test_moe_mark                    Ran 5   OK                    exit=0
tests.test_moe_colon                   Ran 5   OK                    exit=0
tests.test_moe_bidirectional           Ran 6   OK                    exit=0
tests.test_mark_transfer               Ran 6   OK                    exit=0
tests.test_stat_gain                   Ran 14  OK (skipped=1)        exit=0
tests.test_global_skill_mods_transition Ran 3  OK                    exit=0
tests.test_cleanse_marks               Ran 16  OK                    exit=0
tests.test_energy_loss_effects         Ran 6   OK                    exit=0   ← 762/756 的运行时判据
tests.test_self_power_flat             Ran 6   OK                    exit=0
tests.test_respond_override            Ran 31  OK                    exit=0
```

### 5.4 全量（**干净副本**，`p00-b-full.sh`，exit=1，155.1 s）

```
Ran 847 tests in 155.129s
FAILED (failures=1, skipped=2)
FAIL: test_counter_proof_disabling_the_shared_gates_brings_them_back
      AssertionError: 5 not greater than or equal to 8
```

⇒ 与 `STATE.json:next_action` 的预期逐字一致：「预期 `Ran 847·1F+0E`：只剩反证 `5>=8`；
`313!=306` 应已转绿」。**没有新增红、没有改任何断言**。

## 6. 注释改正（诚实性，非功能改动）

`_DIAGNOSTIC_SHAPE_PATTERNS` 上方原注释（逐字见 §1 of `p00-b-orig-blocks.txt`）声称
「`313 天旋地转`/`581 电弧` 的「迸发：本次技能威力+N」**真有 effect** ⇒ 被 evidence 盖住、**不记缺口**」。
**实测不符**：解析层对这一段不产出 effect（`effects.effective_power()` 是**结算期读文本**，不是解析效果），
两行 `diagnostic_shape_gaps` **都是 `['迸发']`**、档位 `PARTIAL`。

新注释（要点）：① 明确「真有 effect ⇒ 不记缺口」是**错的**，实测两行都记缺口；
② 保留**对**的那半句并给读数：运行时真的按迸发窗口加威力（`power_used` 60→90 / 80→120 / 35→55，
`conditional_reason="迸发 → 威力 +N"`）；③ 指向 `plan00-584-burst-evidence.md` 的 **306 vs 309 待裁决分叉**，
声明**本轮不动结论**；④ `583`「能耗-2」/`598`「使用次数+1」**确实不结算** ⇒ 记缺口是对的。

## 7. 诚实边界

1. **未动 `build_coverage` 的尺子**：它仍用 `classify_skill`（`ledger_tier` 0 行变化可证）。
   把它切到 `classify_skill_declared` 是**另一件事**，且现在会被 `584`（`resolved=False`）拖掉一行
   ⇒ 必须等「306 vs 309」裁决；本件只做预授权里的「补类」那半。
2. **584 一行未动**（Lead 明令）：`ledger_tier` 里它仍是 `SIMULATABLE`、产品档仍是 `PARTIAL`，
   与本改动无交互。
3. 只补了**四类中的这四类**：`foe_energy_loss`（单点扣能，747/742/763）**没有**加类 ——
   那些行本来就 `resolved=True`，加了只会多标签（`_SETTLED_EFFECT_CLASSES` 的注释里写明了理由）。
4. 干净副本来自 `78766db`（不含 plan01-engine 在飞改动）；共享工作树上的读数不作为本件依据。
5. **未改任何判据断言**；`test_tier_verdict_agreement` 的 `5 >= 8` 已知红不在本件范围。
