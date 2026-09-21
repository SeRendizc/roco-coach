# 三套「支持」不要混：12 只全 `KNOWLEDGE_ONLY` vs FULL 6 / PARTIAL 2 / REFUSED 4

> 第 46 轮 · **只设计/审计，不改引擎实现**。
> 本文回答监工点名的那处文档冲突：`docs/roco/PET-SUPPORT-MATRIX.md` 说 12 只全部
> `KNOWLEDGE_ONLY`，`docs/roco/PROGRESS.md` 说 `FULL 6 / PARTIAL 2 / REFUSED 4`。
> 两者**不是同一件事的两种说法**，是三个不同维度。本文逐条给出维度定义、覆盖数字、
> 证据文件与字段，并说明**哪一处写错了、错在哪、已怎么改**。
>
> 所有数字都由命令实跑得到，命令写在每张表下面。

---

## 0. 一句话结论

| 文档 | 那句话说的维度 | 对不对 |
|---|---|---|
| `PET-SUPPORT-MATRIX.md` §0/§1「12 只一律 `KNOWLEDGE_ONLY`」 | **③ 支持等级**（机制有没有被**实测**核验过） | ✅ 数字对（12/12），**但理由句写错了**（见 §4） |
| `PROGRESS.md` W3-01「FULL 6 / PARTIAL 2 / REFUSED 4」 | **② 特性覆盖**（本仓库**引擎**对特性的实现状态） | ✅ 对，与 `data/roco/engine-trait-status.json` 的 `counts` 逐字段一致 |
| 两者都没写清楚的 | **① 技能效果覆盖**（数据侧 `effect_support` + 引擎侧原语实现）；**③′ Demo 替代规则**（3v3 靠什么替代规则跑完） | ⚠ 缺一列，已补进本文 |

**写错的那一处 = `docs/roco/PET-SUPPORT-MATRIX.md` 第 32 行（修正前）的**
「理由（可核验）：本轮**没有实现任何效果原语**」。
判定它错的依据是**同一份文件自相矛盾**：该文件 §2 在同一篇里就写着
「引擎侧 ✅ **FULL**」（原第 156、241、328 行等）。一句话不可能既「没有实现任何效果原语」
又「引擎侧 FULL」。详见 §4。

---

## 1. ① 技能效果覆盖（skill effect coverage）

这一维有两个**不同来源**的数字，必须分开报：

| 侧 | 字段 / 代码 | 现在是什么 | 覆盖面 |
|---|---|---|---|
| **数据侧**（上游快照的说法） | `skills.json` → `skills[*].effect_support` | `unsupported` × **824/824** | 0 / 824 |
| **数据侧**（威力来源） | `skills.json` → `skills[*].power_status` | `static_value_present` **358** / `not_provided_by_source` **466** | 358 条有静态威力 |
| **数据侧**（类别） | `skills.json` → `counts` | 技能 824 / 特性 245 / 有静态威力 358 / 无 466 | — |
| **引擎侧**（本仓库实现了哪些原语） | `roco/src/roco_env/effects.py`、`env.py` | 见下表 | 见下表 |

**引擎侧已实现的原语（有代码路径，不是声明）**

| 原语 | 代码落点 | 状态 |
|---|---|---|
| 直接伤害（含属性相性、本系、buff 折算） | `effects.py:333-382`（`compute_damage`，唯一实现）；`effects.py:356-363` 把 `atk/def/power/power_water/power_fight/power_bug/power_ice` 折进伤害 | 会算，但公式**未核验**（`effects.py:57-99`，`verified=False`） |
| 条件化威力（**只覆盖 4 类描述模式**） | `effects.py:207-244`：①「每有1能量」②「若敌方能量小于等于」③「应对…翻倍/×N」④「迸发」 | 部分 |
| 防御减伤 / 应对判定 / 冷却 | `effects.py:455-494`；`env.py:510-524` | 会算（假设：减伤无条件生效 MC-020） |
| 状态技能效果（自我属性、敌方属性、净化、回复、偷能量） | `env.py:612-684` | 部分 |
| 回合末持续状态 | 仅 `中毒 3% / 灼烧 2%（衰减）/ 寄生 2%`：`effects.py:410-437`、`env.py:729-749` | 3 / 至少 6 种（冻结/引电/萌化等未实现） |
| 印记 | `env.py:627-640`：只累加层数 + 登记「叠加规则未定义（MC-009）」 | **只登记，不结算效果** |
| 天气 / 连击数 / 蓄力 / 属性增减的层数语义 | `env.py:11-18` 自报未实现；`parse.py:46-49` 的 `UNPARSED_MARKERS` | **fail closed** |

**实测（本轮，76 个 48 只名单里的独特技能，逐条调用引擎自己的代码路径）**

| 分类 | 技能数 | 含义 |
|---|---:|---|
| `computed` | **30** | 纯伤害路径，描述里没有引擎未覆盖的附加机制 |
| `computed_uncorrected` | **28** | 引擎算了，但描述里的条件/附加机制**没有被正确处理或没被执行**（见 §3） |
| `computed_unverified` | **3** | 状态效果被应用，但数值口径是假设 |
| `partial_refused_subset` | **6** | 部分效果被拒绝（防御技能的「应对成功：…」子句既不应用也不登记） |
| `fail_closed` | **9** | 引擎明确拒绝结算 |

命令：`python3 scripts/roco/audit-roster-48.py --skip-matches`
产物：`reports/roco/coverage/roster-48-support.json`

> **结论**：①这一维的「能模拟多少」**不是 0，也不是 100%**。
> 数据侧 0/824（`effect_support` 全 `unsupported`），引擎侧在 48 只名单的 76 个技能上
> 33/76 走的是「会算但未核验」，9/76 明确 fail closed，34/76 会算但附带未纠正的条件或子句。
> **任何「可模拟」的说法都必须指明是这三层里的哪一层。**

---

## 2. ② 特性覆盖（trait coverage）

| 来源 | 字段 | 值 |
|---|---|---|
| 引擎实现状态 | `data/roco/engine-trait-status.json` → `counts` | `{FULL: 6, PARTIAL: 2, REFUSED: 4}` |
| 引擎代码 | `roco/src/roco_env/traits.py` → `TRAITS`（12 条） | 实跑 `implementation_summary()` = `{'FULL': 6, 'PARTIAL': 2, 'REFUSED': 4}` |
| 数据侧声明（**另一件事**） | `skills.json` 里该特性技能（`is_trait=true`）的 `effect_support` | 245/245 全是 `unsupported` |

命令：
```bash
cd roco && PYTHONPATH=src python3 -c "from roco_env import traits; print(traits.implementation_summary())"
# → {'FULL': 6, 'PARTIAL': 2, 'REFUSED': 4}
```

**逐只（12 只全在 `traits.py` 里登记，不是只有 A 组 6 只）**

| pet_id | 精灵 | 特性 | 状态 | 钩子 |
|---|---|---|---|---|
| `pet_000062` | 音速犬 | 专注力 | FULL | `on_enter` |
| `pet_000112` | 雪影娃娃 | 捉迷藏 | PARTIAL | `after_freeze_applied` |
| `pet_000124` | 化蝶 | 化茧 | REFUSED | — |
| `pet_000190` | 海豹船长 | 身经百练 | FULL | `on_enter` |
| `pet_000225` | 寂灭骨龙 | 不朽 | REFUSED | — |
| `pet_000417` | 圆号鱼 | 泛音列 | FULL | `after_status_skill` |
| `pet_000445` | 黑猫巫师 | 预警 | PARTIAL | `on_turn_start` |
| `pet_000451` | 秩序鱿墨 | 绝对秩序 | REFUSED | — |
| `pet_000474` | 画间沉铁兽 | 变形活画 | FULL | `on_action` |
| `pet_000601` | 圣凯布米龙 | 热成像 | FULL | `on_turn_start` |
| `pet_000608` | 银月狼王 | 铭记于月亮 | REFUSED | — |
| `pet_000611` | 月使鹭纳 | 冷光源 | FULL | `on_turn_start` |

**FULL 6 = A 组 3（音速犬 / 海豹船长 / 圆号鱼）+ B 组 1（画间沉铁兽）+ C 组 2（圣凯布米龙 / 月使鹭纳）。**
这就是 `PROGRESS.md` W3-01 那一行的准确含义，也是 `PET-SUPPORT-MATRIX.md` §3 原来缺的那一列
（本轮已补）。

**REFUSED ≠ 没做。** 4 条 REFUSED 都有理由（`engine-trait-status.json` 的 `reason`），
例如「不朽」是因为引擎在力竭时立刻把精灵移出可行动集合，而复活要求「力竭后仍占回合计数位」，
四条前提都没有一手证据（MC-014），所以**拒绝而不是近似**。

---

## 3. ③ 支持等级 与 ③′ Demo 替代规则

### 3.1 ③ 支持等级（acceptance）

| 来源 | 字段 | 值 |
|---|---|---|
| 支持矩阵 | `support-matrix.json` → `pets[*].support.current` | `KNOWLEDGE_ONLY` × **12/12** |
| 支持矩阵 | `pets[*].support.target_next` | A 组 `SIM_PARTIAL`，B 组 `KNOWLEDGE_ONLY`，C 组 `CATALOG_ONLY`（是**目标**，不是现状） |

这一维看的是「机制有没有被**实测**核验过」：`tests/evals/roco/cases/microcases-v1.jsonl` 里
**通过数 = 0**，所以 12 只全部停在 `KNOWLEDGE_ONLY`。
命令：`node --test tests/evals/roco/data-acceptance.test.js`（含「支持等级与目标等级必须分开」断言）。

### 3.2 ③′ Demo 替代规则（为什么 3v3 还能跑完）

`KNOWLEDGE_ONLY` 的字面定义是「可用于 RAG 问答，**不能进入战斗**」，但 Demo 里 3v3 确实能打完
（本轮实测 **1000/1000 完赛、0 截断、0 异常**，见 §5）。两件事不矛盾，因为 Demo 靠的是一组
**登记在案的替代/假设规则**，而不是核验过的机制：

| # | 替代规则 | 代码落点 | 对玩家的可见后果 |
|---|---|---|---|
| 1 | 未核验的**状态技能**：不结算，只登记 `unsupported`，该回合照样过去 | `env.py:526-533` | 页面显示「未核验、因此未结算」；技能等于空过 |
| 2 | 未核验的**威力**（无静态威力）：不结算，只登记 | `env.py:545-551` | 同上 |
| 3 | **伤害公式**用未核验的社区候选假设 `COMMUNITY_HYPOTHESIS_V1` | `effects.py:57-99`，每次伤害事件都带 `damage_model` + `formula_verified:false`（`env.py:571-585`） | 伤害数字可看，**不能当强度结论** |
| 4 | **面板值**用非官方拟合式（hp/atk/def 精确，spa/spd/spe 有残差） | `data.py:165-172`；`panel_formula_is_exact()` 暴露精确性 | 伤害量级取决于这一层 |
| 5 | **印记**只累加层数，印记效果不结算 | `env.py:627-640` | 印记类技能「有动作、无效果」 |
| 6 | 能量上限 6 / 回合末 +1 / 入场初始 2 / 换宠先手 5 / 同速用 seed 随机 | `env.py:13,45-48,138` | 全部标「假设（MC-007 / MC-002 / MC-005）」 |

> **所以「48 只能打完一局」这句话要拆开说**：能打完 = 1+2（fail closed 后回合继续）+ 3+4（有数可算）；
> 不等于 5+6 或任何机制被核验。**Demo 能跑 ≠ 机制可模拟 ≠ 可以下强度结论**，三者依次收紧。

---

## 4. 判定：哪一处写错了

### 4.1 错的是 `PET-SUPPORT-MATRIX.md` §0 的理由句（原第 32 行）

修正前原文：

```text
**本轮 12 只精灵的当前等级一律是 `KNOWLEDGE_ONLY`。**

理由（可核验）：本轮**没有实现任何效果原语**，也没有通过任何一个 microcase。
```

判定它错的**三条**依据（都可复核）：

1. **同文件自相矛盾。** 该文件 §2 的 A 组逐只条目里写着「引擎侧 ✅ **FULL**」
   （修正前第 156、241、328 行）与「引擎侧 ◐ PARTIAL」（第 198、284 行）、
   「引擎侧 ⛔ REFUSED」（第 113 行）。一份文件不可能同时断言「没有实现任何效果原语」
   和「引擎侧 FULL」。
2. **引擎侧确有实现。** `roco/src/roco_env/effects.py` 有 `compute_damage`（第 333-382 行）、
   `parse_defense_reduction`（第 455-467 行）、`status_tick`（第 432-437 行）；
   `roco/src/roco_env/traits.py` 登记 12 条特性，实跑
   `implementation_summary()` = `{'FULL': 6, 'PARTIAL': 2, 'REFUSED': 4}`
   （`data/roco/engine-trait-status.json` 的 `counts` 同值）。
3. **真正的理由在同一段里就有**：等级没升上去是因为「**没有通过任何一个 microcase**」
   （实测 = 0）。这是**验收**没做，不是**实现**没做。

### 4.2 已做的修正（只改文档）

`docs/roco/PET-SUPPORT-MATRIX.md`：

1. §0 删掉「没有实现任何效果原语」，改为「12 只都没有通过任何一个 microcase」，
   并加一段「⚠ 第 46 轮修正」列出上面三条依据 + 三维度对照 + 指向本文。
2. §3.1（B 组）与 §3.2（C 组）两张表**各补一列**「引擎侧特性状态」：
   画间沉铁兽 `FULL`、秩序鱿墨 `REFUSED`、化蝶 `REFUSED`、
   银月狼王 `REFUSED`、圣凯布米龙 `FULL`、月使鹭纳 `FULL`。
   原来这两张表只有「支持等级」一列，读起来像 B/C 组特性也没实现。
3. 顶部加了一句「重新跑 `npm run roco:docs` 会覆盖本修正」，并给守卫脚本名。

### 4.3 未修的同类过时句（本轮**只**修监工点名的那一处，这些如实列出）

| 文件:行 | 原句 | 为什么错 |
|---|---|---|
| `scripts/roco/build-support-matrix-doc.mjs:56` | `本轮**没有实现任何效果原语**` | 本文件的生成器；它与 §4.2 的修正冲突，需一次**代码改动**才能根治 |
| `scripts/roco/build-support-matrix.mjs:8,199,345` | 同上 + `current: 'KNOWLEDGE_ONLY'` 的注释「一个都没有实现」 | 同上 |
| `docs/roco/mvp/STATUS-LABELS.md:107`（B19） | `env.py:540-542`：`ability_level=1.0` 与 `power_multiplier=1.0` 硬编码 | **实跑 `grep -n "ability_level=1.0" roco/src/roco_env/env.py` 无命中**；这两个量现在由 `effects.py:356-363` 从 buff 折算，属性增减**已经进伤害** |
| `docs/roco/mvp/STATUS-LABELS.md:109`（B21） | `implementation_summary()` = `{'FULL': 3, 'PARTIAL': 2, 'REFUSED': 1}`；「B/C 组 6 只特性不在 `TRAITS` 里」 | 实跑是 `{6,2,4}`，`TRAITS` 有 12 条（`traits.py:44-171`） |
| `docs/roco/mvp/RULE-COVERAGE.md:97` | 同 B19 | 同 B19 |
| `roco/src/roco_env/env.py:18` | 模块头未实现清单含「12 只精灵的特性效果（MC-014…019）」 | `traits.py` 已实现 6 条、部分 2 条 |

> 这些**没有**在本轮改：本轮纪律是「只设计/审计，不改引擎实现」，且监工点名的只有一处。
> 守卫 `node scripts/roco/verify-coverage-axes.mjs` 会把 §4.2 的修正与 §2/§1 的数字钉住，
> 并在被覆盖时**跑红**。

---

## 5. 三维度对照总表（这就是「哪一张表说的是哪一件事」）

| | ① 技能效果覆盖 | ② 特性覆盖 | ③ 支持等级 | ③′ Demo 替代规则 |
|---|---|---|---|---|
| **说的是什么** | 技能的效果原语：数据侧声明 + 引擎侧实现 | 12 条特性的引擎实现状态 | 机制是否被**实测**核验 | 3v3 靠什么替代规则跑完 |
| **数据来源** | `skills.json#effect_support` / `power_status`；`effects.py`、`env.py`、`parse.py` | `engine-trait-status.json#counts`；`traits.py#TRAITS` | `support-matrix.json#pets[*].support.current`；`microcases-v1.jsonl` | `env.py:526-533/545-551/627-640`；`effects.py:57-99`；`data.py:165-172` |
| **现在的数字** | 数据侧 0/824 支持；引擎侧（48 只名单 76 技能）33 会算 / 34 会算但有未纠正项 / 6 部分拒绝 / 9 fail closed | `FULL 6 / PARTIAL 2 / REFUSED 4`（12/12 已登记） | `KNOWLEDGE_ONLY` × 12/12；microcase 通过 **0** | 1000/1000 局完赛，0 截断，0 异常（**冒烟**，不是 1 万局压测） |
| **哪份文档写的** | 本文 §1（原来没人合起来写） | `PROGRESS.md` W3-01；`engine-trait-status.json` | `PET-SUPPORT-MATRIX.md` §0/§1 | 本文 §3.2（原来没人写） |
| **能声称什么** | 「哪些原语被实现了、哪些没有」 | 「哪条特性引擎会算、哪条明确拒绝」 | 「哪只精灵能下强度结论」→ 一只都不能 | 「Demo 能打完一局」 |
| **不能声称什么** | 不能反过来说「数据字段齐全 = 可模拟」 | 不能把 FULL 当成「特性已被核验正确」 | 不能因为引擎有代码就升等级 | 不能把「跑完」当成「机制正确」 |

---

## 6. 可复核命令清单

```bash
# ① 数据侧
python3 -c "import json,collections;s=json.load(open('data/roco/normalized/roco-world-s4-2026-09-10/skills.json'));print(collections.Counter(v['effect_support'] for v in s['skills'].values()));print(s['counts'])"
# ① 引擎侧（本轮实测）
python3 scripts/roco/audit-roster-48.py --skip-matches

# ② 特性
cd roco && PYTHONPATH=src python3 -c "from roco_env import traits; print(traits.implementation_summary())"
python3 -c "import json;print(json.load(open('data/roco/engine-trait-status.json'))['counts'])"

# ③ 支持等级
python3 -c "import json;d=json.load(open('data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json'));print(sorted({p['support']['current'] for p in d['pets']}))"
node --test tests/evals/roco/data-acceptance.test.js

# ③′ Demo 替代规则（实测冒烟）
python3 scripts/roco/audit-roster-48.py --matches-per-strategy 200 --seed 20260910

# 守卫：修正被覆盖 / 数字漂移就红
node scripts/roco/verify-coverage-axes.mjs
```
