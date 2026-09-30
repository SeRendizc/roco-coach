# 独立复验：分计划 00 · 族②（`plan00-family2.md`）（harness-verifier）

**对象**：`plan00-closer` 的 task-1（`RESPOND_POWER_SETTLED_RE` 只许跳命中那一段）
**结论**：**声明全部成立** —— 分句级结构、换档范围、运行时反例三项都被独立复算证实。
**方式**：不复用实现者脚本；自写 3 支探针（`scripts/roco/verify-family2-clauses.py` ·
`verify-family2-runtime.py` · `verify-readings.py --all`），读数自带 `STAMP` 源码指纹。

---

## 1 · 分句级结构（`verify-family2-clauses.py`）

```
PREFIX_MATCHED_SKILLS 12        （实现者声明 12）✓
WHOLE_CLAUSE_SETTLED 11         （实现者声明 11）✓
PREFIX_ONLY ['skill_000398']    （实现者声明只有 398）✓
my_fullmatch == impl_fullmatch  （12/12 行，两把尺子逐条同值）✓
DECLARATION_MISMATCHES 0
```

**我自己写的**正则与仓库里的 `_is_settled_respond_power_clause()` 在 12 行上**逐条判定相同**
⇒ 不存在「实现者把正则改细到只放过自己想要的行」这种自证循环。

12 行原文（部分）：
- `255/259/662/665/674`：`造成物伤，应对状态：本次技能威力变为N倍。` ⇒ 整条
- `518`：`…本次技能威力翻倍，**且物防额外+70%**。` ⇒ 前一分句整条（后一分句归别的闸）
- `637`：`…本次技能威力变为2倍，无视敌方系别抵抗。` ⇒ 前一分句整条
- **`398`：`造成魔伤，敌方获得4层灼烧，应对状态：本次技能威力**和赋予灼烧翻倍**。` ⇒ 只有它整条不匹配**

## 2 · 换档范围（`verify-readings.py --all` 全量 579 行快照对照）

拿 `83ed968`（族② 动手前，totals=313）的全量逐 id 快照当**改前**对照：

```
VS_PRE_SNAPSHOT_CHANGED ['skill_000398']   （实现者声明只有 398）✓
VS_306_BASELINE_CHANGED []                 （12 行现在**全部**回到 306 基线的档位）
398: base306=PARTIAL  pre=SIM  now=PARTIAL
```

⚠ 一处口径差异（**不构成缺陷，已在报告 §4 里说明**）：实现者说「398 从 SIM 降 PARTIAL」是相对
**改前工作树**说的；相对 **306 真基线**，398 本来就是 `PARTIAL` ⇒ 本族是**把它降回基线值**，
而不是把基线之下再压一层（这一点很重要：说明没有为凑 306 而过冲）。

## 3 · 运行时反例（`verify-family2-runtime.py`，**差分夹具**）

实现者的反例是单组读数。我改成**差分**：同一 seed、同一配招、同一只精灵，**只改敌方出什么招** ——
A 组敌方出状态技（应对成功）· B 组敌方出攻击技（应对失败）。

```
skill_000398 炙热波动  base_power=55
  A(敌 273 休息回复/状态)  power_used=110.0  conditional_reason="应对成功 → 威力翻倍"  status_added layers=4
  B(敌 246 抓挠/攻击)      power_used= 55.0  conditional_reason=null                    status_added layers=4
  ctl_fixture_flips_power=True   ctl_status_event_seen=True   layers A=4 B=4

skill_000255 突袭 base_power=70   A power_used=210.0（"应对成功 → 威力 ×3.0"）· B 70.0   ✓ 整条结算
skill_000637 虫击 base_power=90   A power_used=180.0（"应对成功 → 威力 ×2.0"）· B 90.0   ✓ 整条结算
RUNTIME_FAILS 0
```

**控件说明（这是这条结论值钱的地方）**：
- `ctl_fixture_flips_power=True` ⇒ 夹具**真的**触发了应对成功（A 翻倍 / B 不翻），不是空转；
- `ctl_status_event_seen=True`（398）⇒ 层数探测器**看得见** `status_added layers=4`，
  所以「A/B 都是 4」不是「探测器瞎了」；
- `255/637` 的层数控件标 `n/a(不施加状态)` —— 它们整条就是威力形状、不施加状态，
  这一项对它们不适用（**如实标 N/A，不静默跳过**）。

⇒ **「赋予灼烧翻倍」那半零实现**（应对成功与否，层数都是 4）；「本次技能威力」那半真结算。
⇒ 收窄**真的生效**且**没有误伤**：398 该降，11 条整条形状的照旧 `SIM`。

## 4 · 复跑

```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-family2.sh
cd /mnt/e/roco-coach/roco && PYTHONPATH=src python3 ../scripts/roco/verify-family2-runtime.py
```
原文：`reports/roco/product-execution/00/verify-family2-runtime.txt` ·
`reports/roco/product-execution/harness/readings-83ed968-all.json`（改前全量快照）。

## 5 · 未覆盖 / 边界

- 本复验针对 `coverage.py` 的族② 改动；**全量用例读数**见第 3 阶段冻结 bundle（族② 自己的全量
  读数是在含 plan01 未提交改动的树上跑的，我不用它下结论）。
- `plan00-family2.md` §3 里 8 条 plan01 契约红：属 plan01 中间态，本报告不裁。
