# 独立复核：03.2 冻结版 `2253c2e`（harness-verifier）

**冻结件 sha256（我亲自核过，与 Lead 声称逐一吻合）**

| 文件 | sha256 | 字节 |
|---|---|---|
| `src/coach/opponent-belief.mjs` | `7f538edd7fd36a5f386f0a1dde7b890eabacb9196b04492be0a280ce2d180270` | 175375 |
| `tests/roco-opponent-belief.test.js` | `4d4f2296c008df91474c6d1a…` | 87663 |
| `reports/roco/rc604/opponent-belief.json` | `67d5d905a754d793b30592c7ea90a798c0eb510c089e541d182c1555484e6371` | 173278 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `4120d6167dc3fb842d8b7108…` | 25384 |

**复核方式**：`git archive 2253c2e` 整仓副本（3424 文件）到 `E:\roco-scratch\verify-03.2`，
**在该不可变副本上**跑（不再有「跑着跑着被改写」的问题）；改坏版只在副本内做，做完还原并核对 sha256。

---

## §0 判定：**主体合格 · 1 项不合格（覆盖缺口）**

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1① | 冻结版测试读数 | **合格** | `tests 25 · pass 25 · fail 0 · exit 0` |
| 1② | 新断言**非恒真**（改坏版必红） | **不合格（部分）** | R4 变异 ⇒ 红 ✓；但**删掉条件③的矛盾记录 ⇒ 套件仍 25/25 绿**（我的探针却红）⇒ 该行为**无断言守护** |
| 1③ | 报告与生成器一致 / 数据面 | **合格** | 副本内 `RC604_WRITE_REPORT=1` 重生成 ⇒ 与冻结件**逐字节相同**（`67d5d905…`） |
| 2 | R2 扩展到「任何带 weights 的对象」 | **合格** | `--require-r2-uniform` **exit 0**（03.1 时是 exit 1）；uniform 三字段齐；R2 三连改坏版全红 |
| 3 | 反例② 不合法技能不进 kept | **合格** | 控件（合法集）不误判 `ok=true`；重复技能 / 池外技能 / 无 legality 三版**全红** |
| 4 | 反例①「没假装做过」 | **合格** | `does_not_do` 明确「不偷看个体面板」；候选行**结构性**无 nature/talent/panel/stats 键；`individual_range` 保留多解；多解枚举留给 03.3 ✓ |
| 5 | S2「场上那只被筛出池 ⇒ 保留 + 写矛盾」是真的 | **合格** | 我用**真引擎 view** 自己跑：`pet_000225` 保留为 `basis=observed`、`in_filtered_pool=false`，矛盾 `OBSERVED_NOT_IN_FILTERED_POOL` 如实写出 |

---

## §1 逐条原始读数（我自己跑的）

### 1① 测试（副本内）
```
[1①] exit=0   ℹ tests 25   ℹ pass 25   ℹ fail 0   （含新用例 03.2-R2（扩展）… uniform 改坏必红 ✔）
```
**哪些 03.1 断言还在 / 哪些随 03.2 演进**（Lead 点名要分开写）：
- `03.1-R4/R2：假设只降权不压 0…`（test 行 843）**仍在**，原样通过。
- 03.1 的两处**旧**断言（④ `rows.filter(numerator===1)`、⑩ `速度规则都不应用时池子不许被收窄`）
  在 03.2 文件里是**注释留档**（行 375 / 1273）⇒ 属「**随 03.1 改钉演进、已不在运行集**」，不是 03.2 改的。
- 03.2 新增：`03.2-S1/S2/S3（真 view）`、`03.2-手工栏`、`03.2-反例②`、`03.2-反例①（协议前提）`、`03.2-R2（扩展）`、`RC-604 报告逐字节一致`。

### 1② **变异测试**（这是本次最重的发现）
| 变异 | 套件结果 | 我的 S2 探针 | 判读 |
|---|---|---|---|
| 删掉 `contradictions.push({code:'OBSERVED_NOT_IN_FILTERED_POOL'…})`（唯一一处，模块行 1835） | **exit 0 · 25/25 绿** | **exit 1 · `contradictions: []`** | ⇒ 行为确实没了，**套件却抓不到** |
| （对照）把权重 `2:1` 改回 `1:0`（R4 违规） | **exit 1 · 23 pass / 2 fail**（红的正是 `03.1-R4/R2…` 与 `RC-604 报告逐字节一致`） | — | ⇒ 套件**在 R4 这块是有牙的**，不是普遍失灵 |

**为什么漏**：`03.2-手工栏` 那条用例的注释写着「与规则池的矛盾必须报出来（不静默丢）」，
但代码里只用 `raw(...)` **打印** `contradictions.map(code)`，**没有断言**；它断言的是
`observed_kept === 2` 与 `pet_000017` 在候选里。
⇒ **条件③的降级行为（如实报矛盾）目前是无守护的**：删掉它，25/25 依旧全绿。
**建议**（供 Lead 派单，我不改）：在那条用例里补一句
`assert.ok(withContradiction.contradictions.some((r) => r.code === 'OBSERVED_NOT_IN_FILTERED_POOL'))`
（`USED_SKILL_NOT_LEARNABLE` 同理），并在 S2 真 view 那条上也钉一次。

### 1③ 报告重生成
```
副本内 RC604_WRITE_REPORT=1 node --test tests/roco-opponent-belief.test.js   ⇒ exit 0
重生成 sha16 = 67D5D905A754D793   冻结件 sha16 = 67D5D905A754D793   逐字节相同 = True
```
（核对完把副本里的报告还原成冻结件，sha256 复核一致。）

### 2 R2 扩展（`scripts/roco/verify-03-redproof.mjs`）
```
控件（未改报告）                       两条码都不出现           ← 非恒红
A 把一行 numerator 压 0                ASSUMPTION_ZEROES_CANDIDATE = true
B 条件化信念 basis 改坏                WEIGHT_BASIS_NOT_DECLARED = true
B2 **uniform** 信念 basis 改坏         WEIGHT_BASIS_NOT_DECLARED = true   ← 03.1 时是 false，缺口已补
C1 delete basis                        true
C2 is_probability = true               true
C3 baseline_declaration = ''           true
⇒ --require-r2-uniform  exit=0（03.1 时 exit=1）  REDPROOF PASS
```
报告里两条带 `weights` 的信念：uniform `basis='non_informative_uniform_baseline'` · `is_probability=false` ·
`baseline_declaration` 95 字；条件化 `basis='own_speed_tier_downweight'` · `false` · 82 字 ⇒ **三样齐**。

### 3 反例②（`scripts/roco/verify-03.2-legality.mjs`，我自己复算，不看它的脚本）
```
CTL(合法候选原样)  ILLEGAL_LOADOUT_IN_CANDIDATES = false  ok = true      ← 不误判
B1 kept 里塞重复技能            = true（"kept 里有重复技能 / 与独立复算不一致"）
B2 kept 里放池外技能            = true（"不在可学池里 / ok 与独立复算不一致 / 混进了 kept"）
B3 整块 skills.legality 抹掉    = true（"没有 skills.legality ⇒ 无法证明"）
⇒ LEGALITY REDPROOF PASS
```

### 4 反例①（协议前提，**没假装做过**）
- `does_not_do` 原文含：「不偷看：对手配招 / 道具 / 天赋性格 / 个体面板 / 后备身份与血量不进输入（传进来即拒绝）」。
- **结构性**检查候选行键（不是文本计数）：`candidate_sample.candidates[*]` =
  `actions, band_source, basis, candidate_id, evidence, in_filtered_pool, individual_range, inferred_rank,
  name, observed, rules_version, skills, sources, spe` ⇒ **没有 nature/talent/panel/个体值字段**；
  `skills.possible` 行只有 `grade/name/pointer/skill_id/source_file`。
- `candidate_protocol` 明写 `degrade_policy` 与 `default_budget.limit=24`；
  `individual_range.scenarios` 保留多解 ⇒ 「多解枚举」这件 03.3 的活**没有被算进 03.2** ✓。

### 5 S2 矛盾（**真引擎 view，不是手搓**）
```
view = reports/roco/product-execution/02/raw-view-no-preview.json（02 夹具从真引擎 dump）
  顶层键：schema_version,ruleset_id,state_version,turn,phase,battle_result,match_id,rules_version,
          decision_id,self,opponent,legal,cpu_legal_count,needs_replacement
对手场上那只 = pet_000225（寂灭骨龙，龙系/幽系，hp 425/425，energy 2 —— 真引擎数据）
候选 24 条；pet_000225 **在候选里**：basis=observed · in_filtered_pool=false · types=["龙系","幽系"]
contradictions = [{code:"OBSERVED_NOT_IN_FILTERED_POOL", species_id:"pet_000225",
                   detail:"…却被「已亮明系别 / 速度档」规则筛出了池子：规则与观察冲突 ⇒ 候选保留、矛盾如实报出（以观察为准）"}]
```
⇒ Lead 第 5 条要的降级行为**在真 view 上成立** ✓（但**没有断言守护**，见 §1②）。

## §2 我自己新增/更新的复核器材（写域内，随本报告入库）

- `scripts/roco/verify-03-redproof.mjs`：R2 判据（含控件 + B2 uniform + C1/C2/C3 三连），`--require-r2-uniform` 计入判定。
- `scripts/roco/verify-03.2-legality.mjs`：候选合法性反向证明（控件 + 3 改坏版）。
- `scripts/roco/verify-03.2-s2.mjs`：S2 真 view 降级行为（保留 + 矛盾）。

## §3 诚实边界

- 我**没有**验 03.2 之外的代码路径（`src/client/**`、Python 引擎侧）；03.2 的 Node 侧结论仅覆盖上述判据。
- 「数据面 0 差异」我是用**重生成逐字节相同**证的（同一次运行、同一输入），没有逐字段做 diff——
  但逐字节相同是更强的判据。
- 本报告读数全部来自我在**不可变副本** `E:\roco-scratch\verify-03.2` 的实测；副本内改坏版**已全部还原**
  （收尾 sha256：实现 `7f538edd…`、报告 `67d5d905…`，与冻结件一致）。
