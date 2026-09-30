# 反证闸 5 vs 记载 6 · 独立复现与根因（harness-verifier · task-4）

**状态**：**不能复现 6**（本机稳定 5）· **只登记，不拟合**（用户既定纪律：反证 6<8 不动阈值、不动闸、不换 patch 够 8）
**取数出处**：`git archive 83ed968` 出的**不可变副本**，探针逐行自带 `STAMP`（实际加载的源码 sha256）
**原文**：`reports/roco/product-execution/harness/verify-counterproof-83ed968.txt`

```
STAMP coverage.py 36650edf4f2e87f36947b459bdeb4bcc5e7eecee225331ca74047839bf577022
STAMP service.py  74f53be59fb01dc19db51dd401dfb25039aea69fc238662991b3484445fcad33
IDS 427   BASELINE_MISMATCHES 0   GATES_OFF_MISMATCHES 5   AFTER_RESTORE_MISMATCHES 0
CONTROL_FLIPS 25
DIRECTIONS ['判据 true / 档位 PARTIAL']
  MM skill_000412 / skill_000510 / skill_000539 / skill_000671 / skill_000694
```

判据原文（`roco/tests/test_tier_verdict_agreement.py:83`）要求关闸后 `len(bad) >= 8`；
全量红消息逐字为 `AssertionError: 5 not greater than or equal to 8`。

---

## 1 · 四条独立排除（都指向「就是 5」）

| 试法 | 读数 | 排除了什么 |
|---|---|---|
| 6 个 `PYTHONHASHSEED`（`unset/0/1/7/42/12345`，各自隔离子进程） | 全部 **5** | 哈希序/字典序 |
| **4 个 `coverage.py` 版本**（`83ed968` / `b78474b` / `3e5ddea` / `9717e5c`，隔离副本换文件） | 全部 **5**，**同 5 个 id** | 代码版本漂移（原文件 sha256 前后一致，见 `harness/verify-ab-coverage-revs.txt`） |
| 补丁组合扫描（6 种，见 §3） | `both-off=5` | 「组合选错」 |
| 方向分类 | 5/5 均为「判据 true / 档位 PARTIAL」 | 反向条目（判据 false / 档位可模拟） |

四个版本的 `CONTROL_FLIPS` 分别是 **25 / 25 / 26 / 27** —— 版本**确有**差异，
但差异全部落在「两侧一起翻正」的技能上，落到「判据翻正、档位仍是 PARTIAL」的恒为那 5 条。

## 2 · 控件（证明这次 monkeypatch 不是空转）

`CONTROL_FLIPS = 25`：关掉 `respond_clause_gaps` + `UNSETTLED_WORDS` 后，427 并集里有 **25** 条技能的
`resolved` **真的翻正** ⇒ 补丁生效、度量灵敏（既不恒 0 也不恒 5）。
`BASELINE_MISMATCHES 0` 与 `AFTER_RESTORE_MISMATCHES 0` 同时成立 ⇒ patch 有还原、无残留。

> 对照教训：`reports/roco/product-execution/01/README-INDEX.md` 记的三份作废件，错在
> 「控件证明度量无效 / 度量恒 0」。本条读数的控件是**正**的，不属于那一类。

## 3 · 补丁组合扫描：5 是这对闸的稳定值，`>= 8` 用它天然达不到

```
VARIANT baseline(无补丁)            mismatches=0
VARIANT both-off(判据口径)          mismatches=5   412 510 539 671 694
VARIANT respond-only                mismatches=4   412 510 539 671
VARIANT words-only                  mismatches=1   694
VARIANT both-off+compound+diag      mismatches=5   412 510 539 671 694
VARIANT all-text-gates-off          mismatches=14  288 326 327 354 412 509 510 539 553 626 631 671 694 791
VARIANT baseline(恢复后)            mismatches=0
```

- `respond-only(4) + words-only(1) = 5` ⇒ 两个闸的贡献**不重叠**，合起来就是 5。
- 再关 `compound_clause_gaps` + `diagnostic_shape_gaps` **仍是 5** ⇒ 这两道闸**没有**兜住任何一条候选。
- 只有**额外关掉 `residual_mechanic_spans`** 才到 **14** ⇒ 若要让 `>= 8` 成立，**必须换 patch 组合**
  （把 span 闸算进「被关的闸」里），那已不是判据现在测的那两把尺子。
  **这是留档读数，不是待修缺陷；裁决前不许动。**

## 4 · 「少的那几条去哪了」——逐条答案

关闸后 25 条 `resolved` 翻正的技能里：

| 类别 | 条数 | 说明 |
|---|---|---|
| 变成打架 | **5** | 底档本来就是 `PARTIAL`（`classify_skill` 侧早退），判据翻正而档位跟不上（单向对齐只允许 SIM→PARTIAL） |
| 两侧一起翻正 | **20** | 判据 true 且档位也变 `SIMULATABLE_UNVERIFIED` ⇒ 不打架 |
| 合计 | 25 | **没有第 6 条可被这对闸放出** |

另有 5 条**底档 = SIM、关闸后判据仍未翻正**的候选：

```
CAND skill_000273 / skill_000344 / skill_000346 / skill_000472 / skill_000756
     tier_base=SIMULATABLE_UNVERIFIED   verdict_unsettled=[]   ← 注意：缺口列表是空的
```

`unsettled` 为空而 `resolved=False`，只可能是 `settled` 为空 —— 由
`resolved = bool(settled) and not _rows` 决定。这 5 条的描述里**连一类 `SETTLED_PATTERNS`
都点不出来**（缺「回复生命 / 回能 / 吸取能量 / 扣能」这一类），**不是被别的闸兜住**；
与交接 §3 里 `762 小型打劫`（真发 `foe_team_energy_loss`）**同根因族**。
⇒ 它们靠「多关闸」永远放不出来；`>= 8` 也补不上这 5 条。

## 5 · 对判据的处置建议（**只登记，不实施**）

1. `6` 与 `8` 都**不可复现/达不到**：本机在 6 个 seed、4 个版本、6 种组合下一律 **5**。
   建议把 `test_tier_verdict_agreement:99` 的断言与交接文档的「6」一并**如实改钉/改叙述**
   （附本条读数），**或**保留红并登记为已知欠账 —— **由用户裁决，不由执行者自选**。
2. 若用户选择「让判据继续红」：**什么都不用改**，本条读数即为「它红得有理、不是假绿」的证据。
3. 若用户选择「换 patch 组合够 8」：需明确把 `residual_mechanic_spans` 纳入「被关的共用闸」，
   并同步改判据文档语义 —— **本轮不做**。

## 6 · 复跑（原样可贴）

```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-pinned-counterproof.sh   # 冻结副本全套（once+sweep+variants+components）
cd /mnt/e/roco-coach/roco && PYTHONPATH=src python3 ../scripts/roco/verify-counterproof-gates.py --once --sweep --variants --components
```
