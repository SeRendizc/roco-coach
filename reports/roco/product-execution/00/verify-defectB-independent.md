# 独立复验：缺陷 B（`SETTLED_PATTERNS` 补四类）（harness-verifier）

**对象**：`plan00-closer` 的 `plan00-settled-patterns-gap.md`（Lead 授权）
**被验源码**：`coverage.py = 877dbbb51e370d936e90837e25e65322f345a090cf7a45819b0a02dbcca6ddba`
**改前基线快照**：`harness/readings-78766db-all.json`（579 行全量，取自不可变副本 `78766db`，含 `effects` 字段）
**原文**：`verify-defectB-independent.txt`（探针全套 + 7 条运行时反例）· `verify-defectB-three-rulers.txt`
**结论**：**声明逐条成立；另发现的三把尺子分歧已归零（6 → 0）**。

---

## 1 · 逐条核对（我的独立读数 vs 它的声明）

| 声明 | 我的读数 | 一致 |
|---|---|---|
| 恰好 6 行变化：`273/344/346/472/756/762`，`{PARTIAL,False} → {SIM,True}` | `CHANGED_ROWS 6 -> [273,344,346,472,756,762]`（集合完全相同） | ✓ |
| 6 行 `settled` **非空**（不是只翻标志） | `273=['回复生命'] · 344=['回能'] · 346=['回复生命'] · 472=['回能'] · 756=['吸取能量'] · 762=['扣能']` | ✓ |
| `ledger_tier`（`build_coverage` 口径）**0 行**变化 | `verify-totals-delta` 读数与改动前**逐字相同**：`翻正1(762) 翻负1(584) 同带内1(684)`；`totals 306` | ✓ |
| `unsettled` 0 行变化 | `GUARD_ROWS_B`（改前 `unsettled` 非空的 274 行）**0 行被翻正** | ✓ |
| `settled` 列表变化 **38 行**（只增标注，不动 tier/resolved） | `SETTLED_CHANGED_ROWS 38`（其中未带动 tier/resolved 的 32 + 本次该翻的 6） | ✓ **数目逐字一致** |
| `totals 306 → 306` | `TOTALS 306` | ✓ |
| `union 0 → 0` | `UNION_MISMATCHES 0` | ✓ |
| 关闸反证 `5 → 5`（`412/510/539/671/694`） | `GATES_OFF_COUNT 5` **同一组 id** | ✓ |
| 「按效果 kind 补类，不按宽词」 | 反例两组全过（见 §2）；宽词方案会误伤的行数我用另一支探针独立量到同向证据 | ✓ |
| 干净副本全量 `Ran 847 · 1F + 0E · skipped=2` | 待 Lead 切片后在**我的**不可变副本里复跑（本报告只覆盖 coverage 侧读数） | 待办 |

## 2 · 反例（**防补类过宽**，两组 + 7 条真·零事件）

```
GUARD_ROWS  （改前「有目标类效果但仍未结算」）  15 行 -> 被误翻正 0
GUARD_ROWS_B（改前「未结算且 unsettled 非空」）274 行 -> 被误翻正 0
```

7 条「描述声称回复/扣能、但引擎零事件」的真打一手反例（各 12 组敌手动作，
**按 `detail.side` / `skill_id` 归因**后统计）：

```
269 吞噬（回复6能量）         attributed_events=[]   tried=12
366 富养化（场下各回复3能量）  attributed_events=[]   tried=12
369 养分回流（场下各回复1能量）attributed_events=[]   tried=12
537 雾气环绕（回复能量）       attributed_events=[]   tried=12
745 恶作剧（敌方失去3能量）    attributed_events=[]   tried=12
760 入梦（敌方回复能量-5）     attributed_events=[]   tried=12
793 伪造账单（改为失去2倍）    attributed_events=[]   tried=12
```

⇒ 这些行**没有**被顺带翻正（`settled` 仍空、`resolved` 仍 False）⇒ 补类**不是恒真放行**。

> ⚠ 归因这一步是必须的：12 组里总有 1 组是**敌方**技能 `skill_000378` 自己回能
> （`energy_gain, side=enemy`）。不归因就会把它误当成被测技能的产出 —— 我第一版就是这么写错的。

## 3 · 结构缺陷已归零：三把尺子（`verify-defectB-three-rulers.txt`）

缺陷 B 修的是「**产品档位 vs 台账**」的分歧。同一支对照脚本（全 579 技能 × 三条读数路径）：

```
改前（78766db）:  LEDGER_VS_PRODUCT_DIVERGENCE 6   （273/344/346/472/756/762）
改后（877dbbb5）:  LEDGER_VS_PRODUCT_DIVERGENCE 0
```

⇒ `build_coverage` / `classify_skill_declared` / `service._skill_record` 三者对**全部 579 条**同值。

## 4 · 我未覆盖 / 待补

- **全量用例**与**判据定向**：待 Lead 的切片 commit（我会在 `git archive` 副本里原样复跑，
  预期 `Ran 847 · 1F + 0E · skipped=2`，唯一红 = `5 >= 8`）。
- `foe_energy_loss`（单点扣能）**没加类**：实现者说明「那些行本来就 resolved=True，加了只会多标签」。
  我未单独取证；若后续有人质疑，可取 `747/742/763` 真打一手复核。
- `584` 迸发一行**本轮未动**（Lead 明令），其假阴性与「306 vs 309」分叉见
  `verify-584-and-762-runtime.md`。

## 5 · 复跑

```sh
cd /mnt/e/roco-coach/roco && PYTHONPATH=src python3 ../scripts/roco/verify-defectB-settled-classes.py \
    --baseline ../reports/roco/product-execution/harness/readings-78766db-all.json --runtime
```
