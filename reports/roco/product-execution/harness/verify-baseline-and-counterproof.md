# 独立验收报告（harness-verifier · task-4）第 1 阶段：基线冻结复核 + 反证 5/6 差异独立复现

**写于** 2026-09-30 17:2x–17:4x（Asia/Shanghai）· 分支 `wip/roco-coach-2026-09-30-1418`
**口径**：只登记原始命令输出；与声明不符处单列；**未改动任何实现者源码/判据**（只读 git + 隔离副本 A/B）。

---

## 0 · 结论摘要（先看这四行）

| # | 事项 | 独立读数 | 与声明 |
|---|---|---|---|
| 1 | 基线三件套（import / 并集+totals / 隔离验收） | **OK · 0 打架 · totals 313 · exit 0 · 6/6** | **相符** |
| 2 | 全量 `Ran 847 · 2F + 0E` | `Ran 847 tests in 173.591s` · `FAILED (failures=2, skipped=2)` · exit 1 | 数字相符，**但该次读数期间源码在动（见 §2）⇒ 只作参考，已排期重跑** |
| 3 | 反证闸「关闸后打架 6 条」 | **不能复现**：6 个 hash seed、4 个 `coverage.py` 版本、6 种补丁组合，**全部 5 条**，且 5 条同方向 | **与记载不符（记为 O-2′）** |
| 4 | 反证度量是否空转（假绿排查） | **控件通过**：关闸后 **25** 条技能的 `resolved` 真翻正 ⇒ 补丁有效、度量非恒 0 | 相符 |

---

## 1 · 基线冻结三件套（原始读数）

命令与输出原文见 `baseline-verify-log.txt`（本次整段日志）。**取数时 HEAD = `6b66147`**（不是交接说的 `83ed968`，见 §3），
但 `git diff --stat 83ed968 6b66147 -- roco/src` = **空** —— 被测量的源码与 `83ed968` **逐字节相同**。
自查指纹（本报告新增的 `scripts/roco/verify-src-treehash.py`，跑长用例前后各取一次）：

```
ROOT roco/src   695a98ac7508dda7bd6eef07c2ce97162fc8e8c2f8269b9d7a89f896517f5f39 files=19 bytes=1150822
ROOT roco/tests e98b8abef998c1a43c6a8cab4921e860d9eb21d624e53496183857fee6e5069d files=83 bytes=2076357
TREE 2b2a5b95edc0902ad5a0adbff7bf10f03d1e0b00a89e45a03115f1c732f147a2
```

| 检查 | 命令（原样） | 原始读数 | 退出码 |
|---|---|---|---|
| ① 引擎入口 | `cd roco && PYTHONPATH=src python3 -c "import roco_env.service; print('IMPORT OK')"` | `IMPORT OK` | 0 |
| ② 并集 + totals | `PYTHONPATH=src python3 scripts/roco/verify-union-totals.py`（**自建探针**） | `census_ids=427 union_mismatches=0` / `totals.simulatable_entities=313` | 0 |
| ③ 隔离验收 | `python3 scripts/roco/isolated-acceptance.py` | `[acceptance] PASS exit_code=0 {"steps_total": 6, "steps_passed": 6, "steps_failed": 0, "steps_skipped": 0}` | 0 |

③ 的产物已留档：`last-run-baseline-6b66147.json`（内含 `coverage_file_sha256 = 36650edf…`、
`coverage_file_sha256_at_end` 相同、`source_stable_during_run: true`、`snapshot_fingerprint = 4d5c169f…`，
与交接/上一次 `last-run.json` 的指纹**完全一致**）。

---

## 2 · 必须登记的事故：全量跑期间源码在动（`TREE_STABLE NO`）

全量用例（173.6s）跑完后的自查指纹变了：

```
ROOT roco/src 59b99cedb996a646932c9f3a8ec3330b8bed29d8d3c6c008c17e0675a5fadc56 files=19 bytes=1161638  ← 前: 695a98ac… bytes=1150822
TREE_STABLE NO（读数作废：期间源码变了）
 M roco/src/roco_env/coverage.py     (36650edf… → e7e7edc2…)
 M roco/src/roco_env/env.py
 M roco/src/roco_env/service.py
 M roco/tests/test_public_planner.py
```

**判定**：
- ①②③ 在漂移**之前**完成，且 ③ 自带 `source_stable_during_run: true` ⇒ **①②③ 是冻结读数，有效**。
- ④ 全量：**严格意义上无效**（进程内已 import 的模块是旧版，但运行期读文件的用例可能吃到新版）。
  ⇒ 已按「参考读数」登记，**排期在两位实现者报「冻结」后原样重跑**。
- ⚠ 只报告不修：漂移来自 `plan00-closer`（coverage.py）与 `plan01-engine`（env.py / service.py / 测试），属正常在写。

---

## 3 · 与声明不符处（最值钱的部分）

1. **HEAD 不是 `83ed968`**：本次取数时已是 `6b66147`（`state(00): 新机接手基线复跑核实…`，Lead 自己提交）。
   `git diff --stat 83ed968 6b66147` 只有 `docs/roco/execution/STATE.json` 与 `harness/last-run.json`，
   `-- roco/src` **空** ⇒ 源码没变，基线可比。**建议把基线 SHA 明确重钉为 `6b66147`（或记明「src 等价」）**。
2. **全量有 `skipped=2`**：`FAILED (failures=2, skipped=2)`。声明只写了 `2F + 0E`，未提 skip。
   （Lead 的提交信息里有 `O-3 skip=2 已查实`，此处只做交叉登记。）
3. **反证「6 条」不可复现** —— 见 §4，独立证据充分。

---

## 4 · 反证计数差异的独立复现：**不能复现 6**（本机 5）

判据：`roco/tests/test_tier_verdict_agreement.py:83`，要求关掉 `respond_clause_gaps` + `UNSETTLED_WORDS`
后打架 `>= 8`；交接文档（另一台电脑）记「回来 **6** 条」。本机独立读数为 **5**。

**自建探针** `scripts/roco/verify-counterproof-gates.py`（不复用实现者脚本；自带源码指纹 `STAMP` 行）。
所有读数在 **`git archive 83ed968` 出来的不可变副本**上取得，探针输出自带出处：

```
STAMP coverage.py 36650edf4f2e87f36947b459bdeb4bcc5e7eecee225331ca74047839bf577022
STAMP service.py  74f53be59fb01dc19db51dd401dfb25039aea69fc238662991b3484445fcad33
IDS 427
BASELINE_MISMATCHES 0
GATES_OFF_MISMATCHES 5
AFTER_RESTORE_MISMATCHES 0
CONTROL_FLIPS 25
DIRECTIONS ['判据 true / 档位 PARTIAL']
  MM skill_000412 | 判据 true / 档位 PARTIAL
  MM skill_000510 | 判据 true / 档位 PARTIAL
  MM skill_000539 | 判据 true / 档位 PARTIAL
  MM skill_000671 | 判据 true / 档位 PARTIAL
  MM skill_000694 | 判据 true / 档位 PARTIAL
```

全文：`verify-counterproof-83ed968.txt`。

### 4.1 四条独立排除（都指向「就是 5」）

| 试法 | 读数 | 结论 |
|---|---|---|
| 6 个 `PYTHONHASHSEED`（`unset/0/1/7/42/12345`，各自隔离子进程） | 全部 `GATES_OFF_MISMATCHES 5` | 不是哈希序 |
| **4 个 `coverage.py` 版本**（`83ed968`/`b78474b`/`3e5ddea`/`9717e5c`，隔离副本内换文件） | 全部 5，**同 5 个 id** | 不是版本漂移（对照见 `verify-ab-coverage-revs.txt`，原文件 sha256 前后一致） |
| 补丁组合扫描（6 种） | `both-off=5` · `respond-only=4` · `words-only=1` · `both-off+compound+diag=5` · `all-text-gates-off=14` | 5 是「两道共用闸」这一组合的**稳定值**；度量本身灵敏（能到 14） |
| 方向分类 | `DIRECTIONS = ['判据 true / 档位 PARTIAL']`，5/5 同向 | 与判据注释描述的方向一致，无反向条目 |

> 4 个版本的 `CONTROL_FLIPS` 分别是 25/25/26/27 —— **版本确实有差异**，但差异全落在
> 「两侧一起翻正」的技能上，落到「判据翻正而档位是 PARTIAL」的始终是那 5 条。

### 4.2 「少的几条去哪了」——逐条答案（回答交接 §3 的待查问题）

1. **关闸后共有 25 条技能的 `resolved` 翻正**；其中 **5 条**因「档位底档本来就是 PARTIAL」而成打架，
   另外 **20 条**两侧一起翻正 ⇒ 不打架。**没有第 6 条**可被这一对闸放出来。
2. 另有 5 条底档 SIM 但判据未翻正的候选：`273 / 344 / 346 / 472 / 756`，
   它们的 `verdict_unsettled=[]`（**不是被别的闸兜住**）—— 是 `SETTLED_PATTERNS` **缺「回复生命/回能/扣能」类**
   导致 `settled` 为空。这与交接 §3「762 判据侧陈旧」是同一个根因族，**与反证计数无关**，靠多关闸也放不出来。
3. 只有在**额外关掉 `residual_mechanic_spans`** 时（`all-text-gates-off`）才有 14 条 ——
   这批来自 span 闸，不属于「两道共用闸」的反证范围。
   ⇒ **`>= 8` 这个阈值用当前这对闸的 patch 组合达不到；要达到必须换 patch 组合（把 span 闸也算进去）。**
   本报告只登记读数，**不建议也不实施任何拟合改动**。

---

## 5 · 假绿排查（控件）

- `CONTROL_FLIPS 25`：关闸后确有 25 条技能 `resolved` 翻正 ⇒ monkeypatch **不是空转**，度量不恒 0/不恒 5。
  （对照 `reports/roco/product-execution/01/README-INDEX.md` 的假绿前车之鉴：那条错在「控件证明度量无效」。）
- `BASELINE_MISMATCHES 0` 与 `AFTER_RESTORE_MISMATCHES 0` 同时成立 ⇒ 恢复后回到 0，patch 有还原。
- 全量红的两条断言消息与声明**逐字一致**：`AssertionError: 313 != 306` 与
  `AssertionError: 5 not greater than or equal to 8`（原文见 `baseline-unittest.stderr.txt`）。

---

## 6 · 本阶段新增/使用的探针与证据（都在写域内）

| 文件 | 作用 |
|---|---|
| `scripts/roco/verify-src-treehash.py` | src/tests 内容指纹（冻结判据） |
| `scripts/roco/verify-union-totals.py` | 并集打架 + totals（自带 STAMP 源码指纹） |
| `scripts/roco/verify-counterproof-gates.py` | 反证闸复现：`--once/--sweep/--variants/--components`，自带 STAMP |
| `reports/roco/product-execution/harness/baseline-verify-log.txt` | 基线整段原始日志 |
| `reports/roco/product-execution/harness/baseline-unittest.{stdout,stderr}.txt` | 全量原始输出（含 2 红原文） |
| `reports/roco/product-execution/harness/baseline-treehash-{pre,post}.txt` | 漂移前后指纹 |
| `reports/roco/product-execution/harness/last-run-baseline-6b66147.json` | 隔离验收产物留档 |
| `reports/roco/product-execution/harness/verify-counterproof-83ed968.txt` | 冻结副本上的反证全套读数 |
| `reports/roco/product-execution/harness/verify-ab-coverage-revs.txt` | 4 个 coverage.py 版本的隔离 A/B |

复跑（原样可贴）：
```sh
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-baseline.sh        # 基线三件套 + 全量
wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-pinned-counterproof.sh   # 冻结副本上的反证全套
```

---

## 7 · 待办（第 2 阶段，等 `plan00-closer` / `plan01-engine` 报「冻结」）

- [ ] 原样重跑全量（必须在 `TREE_STABLE yes` 的窗口内），与基线 `847 · 2F + 0E` 逐项比。
- [ ] 并集必须仍 0；`totals` 变化逐行对照 `reports/roco/rc401/effect-coverage.json`（306 基线）。
- [ ] 收窄类改动必须给「收窄真的生效」的反例；无反例一律按空判据登记。
- [ ] 证据里不得出现「控件证明度量无效 / 恒 0」类假绿。
- [ ] src 树 hash 与实现者声称的一致。

---

## 8 · 第 2 阶段工具已就绪（自建，均在 `scripts/roco/`）

| 探针 | 回答什么问题 | 退出码约定 |
|---|---|---|
| `verify-src-treehash.py` | 这次读数是不是冻结树上的 | 0 |
| `verify-union-totals.py` | 并集打架 / totals（自带 STAMP 源码指纹） | 0 干净；3 有打架 |
| `verify-counterproof-gates.py` | 反证闸复现（`--once/--sweep/--variants/--components`） | 0 有效；3 补丁空转/基线非 0 |
| `verify-totals-delta.py` | **逐行**对照 306 基线（翻正/翻负 + 逐条 why） | 0 |
| `verify-readings.py` | 逐 id 读数快照与 diff：**0 变化 = 空判据** | 0 有变化；**4 = 逐 id 完全相同** |
| `verify-01-public-surface.py` | 01 公开面：泄漏回收率（**差分控件**：私有域必须量得到 / 公开域必须量不到）、三条投影后备、隐藏真值不变性、契约字段与预览事件 | 0 无硬失败；3 有 |

### 8.1 逐行台账基线（83ed968 vs 306）——第 2 阶段的对照表

`verify-totals-delta.py` 在 83ed968 上的读数（原文见本节末命令）：

```
TOTALS_DELTA simulatable_entities 306 -> 313
SUPPORT_LEVELS baseline battle_skills={SIM 298, PARTIAL 279, KNOWLEDGE_ONLY 2}
SUPPORT_LEVELS current  battle_skills={SIM 305, PARTIAL 273, KNOWLEDGE_ONLY 1}
翻正 8：398 430 441 531 532 534 682 762
翻负 1：584（「迸发」诊断形状）
```

⇒ 与交接 §3 的四族**逐行对上**：族②`398`、族③`430/441/531/532/534/682`、`762`（判据侧陈旧）、
`584`（诊断形状收窄的翻负）。**`637` 在 306 基线里本来就是 PARTIAL** ⇒ 对它做收窄不会让 totals 下穿 306。
（`398/531/534/762/584` 不在 427 并集内，只在 579 技能全台账里 —— 这解释了为何并集读数动不了 totals。）

### 8.2 在飞（in-flight）观测，**不作结论**（2026-09-30 17:36，coverage.py=`e7e7edc2`）

- `union_mismatches=0`（保持）· `totals 313 → 312`：族② 的 `398` 已从翻正名单消失。
- `verify-readings --diff`：427 并集内 **CHANGED_IDS 0 / 427**（变动行在并集外，与上一条一致）。
- 剩余翻正 7 = `430 441 531 532 534 682`（族③ 6 行）+ `762`；翻负 1 = `584`。
  ⇒ 若族③ 6 行全部收窄且 `762` 保持，则 `306 + 1 - 1 = 306`。**这正是需要逐行运行时报据的地方，
  不能用「刚好等于 306」当证据**（反向拟合风险最高的一段）。

### 8.3 与实现者声明不符处（01，**只报告不修**）

`HANDOFF …md` §9 与 `STATE.json` 说「三条公开投影（`public_planner_state` / `ui_public_view` /
`observation_for`）对『对手后备』**已对齐**为 `{slot, fainted}`」。独立读数（本报告 §8 探针，
冻结 83ed968 副本）**不支持这个字面说法**：

```
B_keys_aligned_literally False identity_free True
observation_for 后备行键 = ['active','fainted','field','slot']    ← 多两个标记键
public_planner_state / ui_public_view 后备行键 = ['fainted','slot']
```

**而且实现者自己的原始读数就是这么写的**：`reports/roco/product-execution/01/raw-align-verified-after.json`
的 `B_bench_keys.all_three_aligned` = **`false`**（同一份文件里 `obs_bench_id_free`/`obs_bench_name_free` =
`true`）。⇒ 结论分两层：

- **实质性质成立**：三条投影的后备行都**不带身份字段**（无 `pet_id`/`name`/`skills`），
  场上那只仍带 `pet_id`（`field_has_pet_id=true`，`obs_active_row_has_pet_id=true`）。
- **字面声明不成立**：`observation_for` 是「逐号位标记行」形状，键集比另两条多
  `active`/`field`。这是**措辞/口径问题**，不是新泄漏；登记为「声明与原始读数不符」，
  建议交接与 `STATE.json` 改成「后备均无身份字段；`observation_for` 为逐号位标记行（键集不同）」。

### 8.4 01 冻结基线读数（83ed968，供第 2 阶段对照）

`reports/roco/product-execution/01/verify-01-public-surface-83ed968.json`

```
CONTROLS private_enemy_legal_recovered=[4 个真实技能 id]  synthetic_ids_scanner_finds=[2/2]
         own_skill_ids_found_in_public_ui=[19 个]      ← 差分控件正域成立，度量没死
A_total_leaked_ids 0                                  ← 9 seed × 3 投影，对手真实技能零泄漏
C_invariance seed_change_public_identical=true · bench_hp_energy_change_identical=[true,true,true]
D_receipt http 200 ok=true · state_events_n=0 · event_kinds=[] · match_id/event_seq/decision_id/
          opening_roster_revealed 全部 absent          ← 第 2 阶段要有的新增项，现在都还没有
```

