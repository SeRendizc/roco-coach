# router-v9 数据闸怎么用（README）

**2026-09-30** · 交付人 `box-team-ui` · 写域：`training/**` · `scripts/roco/eval-tool-execution.mjs` · `tmp/**`

---

## 1. 两个名字，别搞混（**审计 ③**）

| 名字 | 在哪 | 是什么 |
|---|---|---|
| **`_expect`** | **数据集行**（`train.jsonl` / `valid.jsonl` / `test.jsonl` 的每一行） | **内部元数据**（下划线开头）。它是"这一句问句期望什么"的记录，随行交付、供审计比对；**评测器不读它** |
| **`expect`** | **评测输入**（`cases-for-gate.jsonl` 的每一行） | 评测器**真正读**的字段（`G0`/`G7` 靠它判"题目 ↔ 标签"的语义） |

> ⚠ **不要把数据集行直接喂给评测器** ✗ —— 数据集行里没有 `expect`（只有 `_expect`），
> 喂进去会**全红在 `G0`**（"没有声明期望 ⇒ 判失败"）。**响是响** ✓，但那不是"字段名不一致"的 bug，
> 是**设计如此**：数据闸要求"每条 case 必须自带可比的期望"。
> 正确做法：用生成器顺带产出的 **`cases-for-gate.jsonl`**（`_expect` → `expect` 的投影 ✓）。

## 2. 跑什么（三条命令，按顺序）

```bash
# ① 生成（--check 只写 tmp/router-v9-v2/，不覆盖正式三份 jsonl）
node training/prep-2026-09-29/router-v9/evidence/gen-router-v9-v2.mjs --check

# ② 问句→意图 的回归钉（8 条；漂了就退出 1）
node training/prep-2026-09-29/router-v9/evidence/check-expect-of.mjs

# ③ 数据闸（用真评测器当闸：错 query / 错回合 / 裸名候选 / 凭空队伍 直接判死）
node scripts/roco/eval-tool-execution.mjs <cases-for-gate.jsonl> --out <gate-report.json>
```

- 评测器自测（19 条：正例 4 全过 + 反例 15 全败）：`node scripts/roco/eval-tool-execution.mjs --selftest`
- **`skip ≠ pass`** ✓：`evaluate_team` / `compare_team_change` 这两族要**活的规则服务**；
  服务不可用时**判失败**（专用闸 `G4service`），**不是跳过** ✓（静默降覆盖会让这两族"看起来过了" ✗）

## 3. hash 口径（**交读数必带**）

```bash
shasum -a 256 scripts/roco/eval-tool-execution.mjs | cut -c1-10     # 例：ed871ed1d8
```

评测器**每改一次 hash 都变**（`ff579942a3` → `f9e4532b10` → `ed871ed1d8`）⇒ 任何读数都要写清是哪个 hash 跑出来的（冻结口径 ✓）。

**冻结跑**还要求**无写者窗口**：跑前 / 跑后各记 6 个 hash，不一致 ⇒ **整轮作废重跑** ✓

```bash
for f in parse env coverage service effects; do
  printf '%s %s\n' "$(shasum -a 256 roco/src/roco_env/$f.py | cut -c1-10)" "$f.py"
done
shasum -a 256 scripts/roco/eval-tool-execution.mjs | cut -c1-10
```

> ⚠ 崩溃/失败若与这些 hash 的变化**时间上相容**，**只写相容性、不下因果结论**（审计者口径 ✓）。

## 4. 这一版数据的规矩（改之前先读）

1. **标签与期望都从问句来**：`gen-router-v9-v2.mjs` 的 `expectOf(question, scene)` 是**纯函数、只吃问句**；
   标签由它生成、`expect` 也由它生成 ⇒ **同源，但不是从标签抄** ✓（从标签抄 ⇒ 错标签会生成"错期望"，蒙过去 ✗）
2. **场景只补两样问句里没有的**：`candidates`（这一局真算出来的**稳定标识** `skill:` / `switch:`）与队伍（**从该场景的回执里来**）
3. `turn` **有具体回合号才写**（从问句解析）；指代（「上一回合」）走 `read_last_turn{}`，**不许填 1** ✗
4. 回执按运行时的 **`{id,tool,args,result,chosenBy?}` 包络**原样保留（不是裸 `result` ✗）
5. **家族整体进一个集合**；三集**不许出现同一个队伍组合**；每条带 `source` / `source_detail`（可追溯 ✓）
6. 每条 case **必须带期望** —— 没有 `expect`（或 `expect_stop`）的 case **不许进训练集**（`G0` 直接判失败 ✓）
