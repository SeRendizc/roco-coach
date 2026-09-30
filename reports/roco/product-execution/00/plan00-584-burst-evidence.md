# `skill_000584 引雷`「迸发」翻负 · **运行时报据**（只出证据，不改代码）

- 执行者：`plan00-closer` · 2026-09-30 · 委托：Lead（task-1/task-2 之后的独立证据件）
- **本件不含任何代码改动**；`coverage.py` 维持在 `21b80d3fe4dddf4c249a6a1ee1d53f4f2fe764be867ec9cba99c9885e2631006`
- 原始输出（留 `E:\roco-scratch\`）：`p00-burst-rows.out.txt`（逐项读数）· `p00-burst-584.out.txt`（真打一手）·
  `p00-burst-runtime.out.txt`（含 583 负对照）· `p00-burst-sim.out.txt`（候选修订爆炸半径）·
  `p00-burst-base2.out.txt`（306 基线台账原文）

## 0. 一句话结论

**584 的 `PARTIAL` 是「过窄」，不是「修对了」**：引擎**真的结算**「迸发：本次技能威力+20」——
真开局真出招、6 个敌手动作各一次，`damage` 事件逐字为
`power_used=55.0`（基础 35）· `hits=2` · `conditional_power=True` · `conditional_reason="迸发 → 威力 +20.0"`；
窗口过后（第 2/3 回合）掉回 `35.0`、reason 为空 ⇒ 不是恒加，是**按迸发窗口真的加减**。

⚠ **但这一行不能单独修**：与它**同形状同结算**的 `581 电弧`、`313 天旋地转` 同样真的加
（`80→120` / `60→90`，reason 逐字），只是它们在 **306 基线里本来就是 `PARTIAL`**。
任何「豁免 `迸发：本次技能威力+N`」的修订都会**同时**把这两行翻正 ⇒ totals 会走到 **309**，
`test_effect_coverage` 里钉的 **306** 会红。**这是需要用户裁决的分叉，我不动手**（见 §5/§6）。

## 1. 逐项读数（交付件 ① 的台账侧）

`584 引雷`「造成魔伤，2连击，迸发：本次技能威力+20。」· power=35 · `has_static_power=True`

| 项 | 当前（收口后） | 306 基线台账（`rc401/effect-coverage.json`） |
|---|---|---|
| `support_tier` | **`PARTIAL`** | `SIMULATABLE_UNVERIFIED` |
| `support_why` | 「读出了 0 条效果，但描述里还有 1 段机制**引擎没结算**（会被写进 unsupported）：**迸发**」 | 「描述里的机制由已声明能力认领（连击×2、hit_count），没有未认领片段」 |
| `settlement_verdict` | `resolved=False` · `settled=['伤害','本手威力加成']` · `unsettled=['迸发']` | — |
| `unclaimed_mechanic_spans`（裸解析） | `[]`（**空**） | `[]` |
| `residual_mechanic_spans` | `[]`（**空**） | — |
| `claims` / `effects` | `['连击×2']` / `[hit_count ← evidence='2连击']` | `claimed=['连击×2','hit_count']` / `effects=[]` |
| `_DIAGNOSTIC_SHAPE_PATTERNS` 命中 | **`("迸发", re.compile(r"迸发"))`** 命中 `'迸发'@[9,11)`，且 **不被任何 evidence 区间覆盖**（唯一区间是 `(5,8,'hit_count')`）⇒ 记缺口 | 该形状当时**不在**表里（`b78474b` 才补回） |
| `respond_clause_gaps` / `compound_clause_gaps` | `[]` / `[]` | — |
| `unsettled_mechanic_gaps` | `['迸发']` | — |

**306 基线为什么把它记成 SIM（内部不一致的由来）**：基线那一层没有「迸发」这条诊断形状，
`584` 走的是 `elif claimed:` 那支（`claimed=['连击×2','hit_count']` + `settled` 非空）⇒ SIM；
而 `581`/`313` 在同一层走的是**三空匿名桶**（基线 `why` 逐字：「读不出效果，描述里没有已登记的机制词
（原句：…）：需人工读描述，引擎不按普通伤害结算（fail closed）」）⇒ PARTIAL。
⇒ **同一机制、同一结算、基线里却两个说法**；`b78474b` 补回形状后三行才被同一把尺子量，584 因此「翻负」。

## 2. 真开局真出招（交付件 ① 的运行时报据）

命令：`wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p00-burst-584.sh` → **exit=0**；原文 `p00-burst-584.out.txt`。
同一 seed（7）、同一配招（首发 `pet_000172`，攻略 `[584,+3]`）、`config=mobile_s4_candidate_v3`。

**A. 6 个敌手动作（第 1 回合＝入场当回合＝迸发窗口），6/6 一致：**

```
[敌 0] 敌=skill_000286(防御)   turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
[敌 1] 敌=skill_000378(火苗)   turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
[敌 2] 敌=skill_000392         turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
[敌 3] 敌=skill_000567         turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
[敌 4] 敌=charge              turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
[敌 5] 敌=switch              turn=1 side=player power_used=55.0 hits=2 conditional=True reason='迸发 → 威力 +20.0'
```

**B. 同一局连打 3 回合（窗口前 vs 窗口后，事件带 `turn` 号）：**

```
第 1 手：出手前 turn=1 entered_turn=1 used_burst=False energy=10
    turn=1 power_used=55.0 hits=2 reason='迸发 → 威力 +20.0'     ← 窗口内：+20 真的加了
第 2 手：出手前 turn=2 entered_turn=1 energy=7
    turn=2 power_used=35.0 hits=2 reason=''                      ← 窗口过：回到基础 35
第 3 手：出手前 turn=3 entered_turn=1 energy=4
    turn=3 power_used=35.0 hits=2 reason=''                      ← 仍然 35
```

⇒ `effects.effective_power()`（`effects.py:270-277`：`"迸发" in desc` + `attacker._burst_active` ⇒
`power += _extract_plus(desc)`）**真接线、真生效**，`env.py:1266` 的窗口判定也在工作。
（`used_burst` 全程 `False`：窗口靠 `entered_turn == state.turn` 判，不靠这个标志 —— 如实登记。）

## 3. 控件（交付件 ②：证明探针不是恒 0 读数）

同一探针、同一 seed、同一读法，**三种方向都能分辨**：

| 控件 | 描述 | 运行时读数 | 说明 |
|---|---|---|---|
| **正对照** `581 电弧` | 迸发：本次技能威力+40（power 80） | `power_used=120.0`（窗口内）→ `80.0`（窗口后），reason 逐字 `'迸发 → 威力 +40.0'` | 同类形状**真的加** |
| **正对照** `313 天旋地转` | 先手+1，迸发：本次技能威力+30（power 60） | `power_used=90.0` → `60.0`，reason `'迸发 → 威力 +30.0'`；另 `env._priority_of(313)=1`（`先手+1` 确有读点：`env.py:540-560` 正则 → `order_actions` 的 `priority` 维） | 同类形状**真的加**；另一条子句也有读点 |
| **负对照** `583 超导` | 迸发：本技能能耗-2（power 90） | 两回合都是 `power_used=90.0`、reason 空；energy `10→7`、`7→4`（**都付 3 点**，没有 -2） | 同词不同值 ⇒ **真没结算**，PARTIAL 正确 |
| 未测（形状不同） | `587 雷暴`（获得已触发迸发…）· `598 双联脉冲`（使用次数+1）· `607 踏雷`（无静态威力） | — | 候选修订**不覆盖**它们（§5 模拟里仍 PARTIAL） |

⇒ 探针既看得见「加了 +20/+30/+40」，也看得见「能耗没减」——不是恒 0 的假读数。

## 4. 全库「迸发」名单（7 条，判定应当分成两档）

```
skill_000313 天旋地转 | power=60  | 迸发：本次技能威力+30                    | 基线PARTIAL 当前PARTIAL  ← 引擎真加 → 应为 SIM
skill_000581 电弧     | power=80  | 迸发：本次技能威力+40                    | 基线PARTIAL 当前PARTIAL  ← 引擎真加 → 应为 SIM
skill_000583 超导     | power=90  | 迸发：本技能能耗-2                       | 基线PARTIAL 当前PARTIAL  ← 真未结算 → 应保持 PARTIAL
skill_000584 引雷     | power=35  | 2连击，迸发：本次技能威力+20              | 基线SIM     当前PARTIAL  ← 引擎真加 → 应为 SIM
skill_000587 雷暴     | power=55  | 迸发：本技能获得所有生效过的迸发，每获得1种… | 基线PARTIAL 当前PARTIAL  ← 未结算 ✓
skill_000598 双联脉冲 | power=50  | 迸发：本技能使用次数+1                    | 基线PARTIAL 当前PARTIAL  ← 未结算 ✓
skill_000607 踏雷     | power=None| （无静态威力）…获得1个已触发过的迸发效果…  | 基线PARTIAL 当前PARTIAL  ← 未结算 ✓
```

## 5. 最小修订方案（**只给方案 + 预期读数，未落笔**）

**方案**：给 `diagnostic_shape_gaps()` 的「迸发」这一条加一个**已结算形状豁免**（与「应对…本次技能威力…」
那条同型）：desc 里有 `迸发[:：]本次技能威力+N` **且该技能 `has_static_power=True`** ⇒ 不记「迸发」缺口。
（`has_static_power` 守卫必须留：没有静态威力的技能根本不会走到 `effective_power()`，不得豁免。）

改法最小形态（示意，二选一）：
```python
# 表里换成正则（负向前瞻）……
("迸发", _re.compile(r"迸发(?!\s*[:：]\s*本次技能威力\s*[+＋]\s*\d+)")),
# ……或在 diagnostic_shape_gaps 的循环里加一条与 _is_settled_respond_power_clause 同型的豁免
```
⚠ 只收紧正则、不加 `has_static_power` 守卫，会把「非攻击技能里出现同样字样」也放行 —— 与本仓
「只对有静态威力的技能生效」的既有纪律不符（`residual_mechanic_spans` 就是这么写的）。

**内存模拟的预期读数**（`p00-burst-sim.sh`，monkeypatch，未改文件；exit=0）：

```
[现状（不改）]                          totals=306 union=0 翻正=1 翻负=1 反证(关闸)=5
[候选：迸发-威力形状豁免（需静态威力）]  totals=309 union=0 翻正=3 翻负=0 反证(关闸)=5
     翻正: 313(PARTIAL→SIM) · 581(PARTIAL→SIM) · 762(合法，原有)
     翻负: （无 —— 584 回到基线值 SIMULATABLE_UNVERIFIED）
     带迸发行的档位: 313 SIM · 581 SIM · 584 SIM · 583 PARTIAL · 587 PARTIAL · 598 PARTIAL · 607 PARTIAL
```

**对既有钉子的影响（必须一起裁决）**：
- `roco/tests/test_effect_coverage.py` 的 `assertEqual(report["totals"]["simulatable_entities"], 306)`
  ⇒ 会红（`309 != 306`），需要按规矩**改钉 306→309**（原断言逐字留档 + 本件的独立运行时报据 + 最小理由），
  或者接受这条判据保持红。
- `test_tier_verdict_agreement`：并集打架仍 **0**（两把尺子同时翻正）；关闸反证仍 **5**（不受影响）。
- `test_global_skill_mods_transition` / `test_cleanse_marks` / `test_respond_override` 等不受影响（未触碰）。

**三个选项摆给用户**（裁决前谁都不许改这一行）：
| 选项 | 动作 | totals | 代价 |
|---|---|---|---|
| **A 不动**（现状） | 保持 584 `PARTIAL` | 306 | 接受 584/581/313 三行「把已结算说成未结算」；584 与基线的同一机制两说法**仍在**（只是反过来） |
| **B 豁免 + 改钉**（证据推荐） | 按上面方案改 + 306→309 改钉 | 309 | 要改一条钉子（但基线 306 本身在这族上内部不一致，已逐字留证） |
| C 只修 584 | 任何只让 584 翻正的写法 | 307 | **不建议**：584/581/313 同形状同结算，只放一行 = 反向拟合 |

## 6. 命令与退出码汇总

```
bash /mnt/e/roco-scratch/p00-burst-rows.sh    → exit=0   （584/581/313/583/598 逐项读数）
bash /mnt/e/roco-scratch/p00-burst-base.sh    → exit=0   （306 基线台账原文 + 先手读点）
bash /mnt/e/roco-scratch/p00-burst-584.sh     → exit=0   （6 敌手动作 × 3 回合真打一手）
bash /mnt/e/roco-scratch/p00-burst-runtime.sh → exit=0   （584/581/313/583 两回合对照）
bash /mnt/e/roco-scratch/p00-burst-sim.sh     → exit=0   （候选修订爆炸半径模拟）
```

## 7. 诚实边界

1. 本件**没有改任何文件**（除本报告）；`coverage.py`/`env.py`/`tests/**` 一行未动。
2. 「引擎真的加」的证据只覆盖**威力那半**与**窗口语义**（进场当回合 vs 之后）；「迸发」在术语里是否
   还有别的语义（如多段触发）**没有一手资料**，本件不推断。
3. `583` 的负对照只证明**能耗那半没减**（10→7 两次）；它的 `conditional_reason` 为空但
   `conditional_power=True`，与「有迸发字样但没实现」一致。
4. `587`/`598`/`607` 未做真打一手（形状不同、不在候选修订范围内），其档位由形状闸决定 ——
   若要动它们需另出证据。
5. 306 基线的 `584=SIM` 走的是 `elif claimed:` 兜底路径（§1 逐字），**不是**因为「迸发」被豁免；
   所以「恢复 584 到基线」与「让 581/313 也 SIM」在证据上是**同一件事**。
