# 独立观察 O-7：**文档/注释与原始读数不符**（harness-verifier）

**性质**：不是功能缺陷，但会让后续读者按**不存在的机制**推理 —— 建议按 Lead 的指示记为独立观察 O-7。
**口径**：只登记「文档/注释里的一句话」与「可复跑读数的原文」，附最小复现命令。

---

## 案例 1 · `coverage.py` 关于「迸发」的注释描述的机制不存在

**原话**（`roco/src/roco_env/coverage.py`，`_DIAGNOSTIC_SHAPE_PATTERNS` 上方，行 1234 一带）：

> `313 天旋地转`/`581 电弧` 的「迸发：本次技能威力+N」真有 effect（`effects.py:270`+`env.py:1263`
> 已接线，真打一手 power_used=60+30 / 80+40）⇒ **被 evidence 盖住、不记缺口**；
> 而 `583 超导` 的「迸发：本技能能耗-2」、`598 双联脉冲` 的「使用次数+1」没有产出 ⇒ 记缺口。

**读数**（`78766db` 副本；`scripts/roco/verify-584-and-762-runtime.py`）：

```
313 天旋地转  parsed_effects=[]  diagnostic_shape_gaps=['迸发']  tier=PARTIAL  verdict=False  power_used=90.0(60+30)
581 电弧      parsed_effects=[]  diagnostic_shape_gaps=['迸发']  tier=PARTIAL  verdict=False  power_used=120.0(80+40)
584 引雷      parsed_effects=[]  diagnostic_shape_gaps=['迸发']  tier=PARTIAL  verdict=False  power_used=55.0(35+20)
```

- 注释说「**被 evidence 盖住、不记缺口**」——实测这两条**照样记了「迸发」缺口**、档位都是 `PARTIAL`。
  原因：`parse` 对这三条**一条 effect 都不产** ⇒ `_evidence_ranges` 为空 ⇒ 不可能被 evidence 盖住。
  （注释说的「runtime 真打一手 90/120」是对的；错的是它对**台账那一侧行为**的推断。）
- 附带事实：`313/581` 在 **306 基线里就已经是 PARTIAL** ⇒ 这不是本批造成的回归，但注释会让读者
  以为它们已被覆盖、从而在排查「迸发」缺口语料时漏掉它们。
- 影响：`584 引雷` 因此**跨过 SIM/PARTIAL 边界**（306 基线 SIM → 现在 PARTIAL），totals 少 1。
  **处置由 Lead/用户裁决，本文件不动任何代码。**

**最小复现**：
```sh
cd /mnt/e/roco-scratch/verify-78766db/roco && PYTHONPATH=src \
  python3 /mnt/e/roco-coach/scripts/roco/verify-584-and-762-runtime.py | head -3
```

## 案例 2 · 「三条公开投影已对齐为 `{slot, fainted}`」与实现者自己的原始读数不符

**原话**（`HANDOFF-2026-09-30-TO-NEXT-MACHINE.md` §9 与 `docs/roco/execution/STATE.json`）：

> 三条公开投影（`public_planner_state` / `ui_public_view` / `observation_for`）对「对手后备」
> **已对齐**为 `{slot, fainted}`（场上那只带 `pet_id`）。

**读数**（独立探针 `scripts/roco/verify-01-public-surface.py`；产出见
`reports/roco/product-execution/01/verify-01-public-surface-83ed968.json`）：

```
B_keys_aligned_literally False   identity_free True
observation_for 后备行键 = ['active','fainted','field','slot']
public_planner_state / ui_public_view 后备行键 = ['fainted','slot']
```

- **实现者自己的原始读数就是这么写的**：`reports/roco/product-execution/01/raw-align-verified-after.json`
  的 `B_bench_keys.all_three_aligned` = **`false`**（同一份文件里 `obs_bench_id_free/name_free` = `true`）。
- ⇒ **实质性质成立**（三条投影的后备都不带身份字段、场上那只带 `pet_id`），
  **字面声明不成立**（`observation_for` 是「逐号位标记行」形状，键集多 `active`/`field`）。
- 建议措辞：改成「后备均无身份字段；`observation_for` 为逐号位标记行（键集与另两条不同）」。

**最小复现**：
```sh
cd /mnt/e/roco-scratch/pin83ed968/roco && PYTHONPATH=src \
  python3 /mnt/e/roco-coach/scripts/roco/verify-01-public-surface.py | grep ^B_
```

---

## 这类问题的共同形态（给后续读者的一句话）

两次都发生在**「代码行为」与「作者对代码行为的叙述」之间**，而不是代码与期望之间：
- 叙述里出现**因果断言**（「因为 X 所以 Y」）时最容易失真 —— 数值读数（90/120）是真的，
  由它推出「所以不记缺口」是错的；
- **同一份原始产物里就有反证**（`all_three_aligned: false`），只是叙述没跟着改。

**低成本的防法**：每条带因果/数值的断言后面附一条**可复跑命令**，并把读数行**原文**抄进去
（本仓的 `scripts/roco/verify-*.py` 都自带 `STAMP <文件> <sha256>` 行，读数自带出处，
不需要读者信任叙述）。
