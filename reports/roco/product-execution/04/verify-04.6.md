# 独立复验：04.6（harness-verifier）· **部分完成（按顺序做多少报多少）**

**锚点**：`git archive HEAD`（HEAD 含 04.6）→ `E:\roco-scratch\verify-046`。
冻结哈希（Lead 给的）未逐个复核 —— 我按 HEAD 跑，**这一步欠账**（如实登记）。

## §1 非有限数（重点 1）→ **合格**

```
缺省（金标基线）：expected = 1.6645 · **non_finite_sanitized 字段不出现** ✓ · json.dumps(allow_nan=False) 不抛 ✓
自造 PlanResult：expected=inf · worst=-inf · best=nan · first_second_margin=nan（规划器级这些是**标量**）
  走产品出口 to_dict() ⇒ expected/worst/best/first_second_margin **全部 null**
  non_finite_sanitized = ["$.expected", "$.worst", "$.best", "$.first_second_margin"]（逐路径登记 ✓）
  json.dumps(出口, allow_nan=False) ⇒ 不抛（8975 字符）✓
```
⚠ 我的探针第一版把 `expected` 当 `{min,max,mean}` 构造 ⇒ `to_dict()` 抛 `TypeError: type dict doesn't define __round__`
—— 这顺带确认了**规划器级是标量、service 级投影才是对象**（我自己的探针错，已修正重跑）。

## §2 超时保守有界（重点 2）→ **主要成立，但「numerator < denominator」这条我测不到**

```
注入时钟强制超时 ⇒ timed_out = True · budget.timed_out = True ✓
  note = 「超时：未完成任何分支。上层应当把 coverage 当作 0 并降级。」 ✓
  coverage = 0.0 ✓
  **coverage_detail.by_seed = null**（不是 0/n 的行）⇒ 「numerator < denominator」**无法在本情形验证**
```
⇒ 我的读数是：**硬超时（一个分支都没跑完）时 `by_seed` 是 null**。
「numerator < denominator」应当属于**部分完成**的搜索（跑了一部分、分母大于分子）—— 那需要另一个
「预算刚够跑一点」的场景。**我不主张这条**，登记为「未验证 / 需要部分完成场景」。

## §3 候选不全仍合法（重点 3）→ **合格**

```
beam=1：recommended = 换上第6位 · 候选数 = 2 · **在 legal_actions 里 = True** ✓
beam=2：同上 ✓
```
（候选被束宽裁到 2 条，推荐仍是当前合法动作之一 ⇒ 没补造未计算分支。）

## §4 未做（如实登记，按 Lead 给的顺序）

- **重点 4**（`search.budget_ms` vs `engineBudgetMs` 不许混）—— 未做
- **重点 5**（扫面表第 ⑦ 格改成真视图投影 + 自造 N19 变异）—— 未做
- **重点 6**（不设 `ROCO_PYTHON` 时整文件 skip ≠ 绿）—— 未做
- **① `/api/coach` 收尾**：已推进到 **`/api/coach` = 200 · `provider:"deepseek"`**（假模型按 JSON-in-content 改法已就绪），
  但**取证阶段仍未触发**（`planActions` 调用 0 次）⇒ 尚未拿到「`executeTool(plan_actions)` 真跑通 + 体带
  `opponent_scenarios`」。响应体里已出现 `toolPolicy`/`toolTrace`/`agentStop` 三个键（诊断下一步用）。
- **② `d4cdef8` 文本整刀** —— 未做
- **③ 三个判据修复复核** —— 未做
- 另：04.6 **五个冻结哈希我没逐个核**（只按 HEAD 跑）。

## §5 复跑

```bash
cd /mnt/e/roco-scratch/verify-046/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-046.py
```
