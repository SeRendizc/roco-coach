# 00 切片隔离验收：`78766db`（harness-verifier）

**对象**：Lead 的 00 切片提交 `78766dbedd363e83bc26495332fe6a4fc7a30a1f`（只含 00：`coverage.py` 族②+族③ + 00/harness 证据）
**方式**：`git archive <SHA>` 解到不可变副本，**在工作树之外**跑；全程只读，未改共享源码
**副本**：`/mnt/e/roco-scratch/verify-78766db`
**结论**：**与 Lead 的预期逐项相符** —— `Ran 847 · 1 failures + 0 errors · skipped=2`，唯一红是 `5 >= 8`。

---

## 1 · 原始读数（命令 + 退出码 + 汇总行原文）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 0 | `git -C /mnt/e/roco-coach archive 78766db \| tar -x -C …` | 0 | 副本就绪 |
| 0b | `diff -rq base-6b66147/roco/src verify-78766db/roco/src` | 1 | **只有 `coverage.py` 一个文件不同**（`diff` 返回 1 = 有差异，符合预期） |
| 1 | `cd roco && PYTHONPATH=src python3 -c "import roco_env.service; print('IMPORT OK')"` | 0 | `IMPORT OK` |
| 2 | `PYTHONPATH=src python3 scripts/roco/verify-union-totals.py` | 0 | `census_ids=427 union_mismatches=0` · `totals.simulatable_entities=306` |
| 3a | `PYTHONPATH=roco/src python3 scripts/roco/verify-totals-delta.py --selftest` | 0 | `CONTROL_SUMMARY ALL_PASS`（6 项控件全过） |
| 3b | `PYTHONPATH=roco/src python3 scripts/roco/verify-totals-delta.py --quiet` | 0 | `delta=0` · `翻正=1(762) 翻负=1(584) 同带内变更=1(684)` |
| 4 | `python3 scripts/roco/isolated-acceptance.py` | 0 | `PASS exit_code=0 … steps_passed 6/6` |
| 6 | `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -q` | **1** | 见下 |

**全量汇总行原文**（`harness/full-78766db.stderr.txt`）：

```
Ran 847 tests in 171.180s

FAILED (failures=1, skipped=2)
```

**唯一的红（原文逐字）**：

```
FAIL: test_counter_proof_disabling_the_shared_gates_brings_them_back (test_tier_verdict_agreement.TierAndVerdictAgreeTest)
AssertionError: 5 not greater than or equal to 8 : 关掉两道共用闸之后必须重新出现打架（否则这条判据是空的）
```

⇒ **`test_report_has_no_simulatable_with_unclaimed_mechanic_spans`（`313 != 306`）已转绿** —— 00 收口的直接效果。
⇒ `0 errors`；`skipped=2`（与 Lead 的 O-3 登记一致）。
⇒ **没有出现第 3 条红。**

## 2 · 归档副本指纹

```
ROOT roco/src  295dab07498dcc43aa6eb6a4e5dca3b321515178db637802cb171b817da9cfd2 files=19 bytes=1156043
ROOT roco/tests e98b8abef998c1a43c6a8cab4921e860d9eb21d624e53496183857fee6e5069d files=83 bytes=2076357
TREE 9b37cd70146df5cd1ecc02d6ea7533b16fa739d7e2f17f7e9fecc63077930e81
```

对照 `6b66147` 冻结指纹（`ROOT roco/src 695a98ac…` / `ROOT roco/tests e98b8ab…` / `TREE 2b2a5b95…`）：
- `roco/tests` **逐字节相同**（`e98b8ab…`）⇒ 本切片**一行判据都没改**；
- `roco/src` 指纹变化**只来自 `coverage.py`**（`diff -rq` 逐文件证明），
  且副本内 `coverage.py` = `21b80d3fe4dddf4c249a6a1ee1d53f4f2fe764be867ec9cba99c9885e2631006`；
- 副本内 `service.py` = `74f53be5…`（HEAD 版）⇒ **plan01 的在飞改动确实没进这一批**（已用 STAMP 行自证）。

## 3 · 证据文件（都在我的写域）

| 文件 | 内容 |
|---|---|
| `harness/verify-slice-78766db-log.txt` | 本次 7 步整段原始日志 |
| `harness/full-78766db.stdout.txt` / `.stderr.txt` | 干净副本全量原始输出 |
| `harness/ledger-78766db.json` | 逐行台账对照（含 STAMP） |
| `harness/last-run-78766db.json` | 副本内隔离验收产物 |

## 4 · 复跑

```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-slice-78766db.sh
```

## 5 · 边界

- 本读数只对 **00 切片**负责；01 侧（env.py/service.py/tests 的在飞改动）**不在**这一批里，
  其读数需另起一个切片副本复验。
- 逐行台账仍留 3 行差异（`762` 翻正 / `584` 翻负 / `684` 同带内变更）：前两条的运行时报据见
  `verify-584-and-762-runtime.md`（**584 是假阴性、762 是产品侧假阴性**），`684` 属同带内换档、不影响 totals。
