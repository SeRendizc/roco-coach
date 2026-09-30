# task-25 验收读数｜「获得 属性±N」的**读点**（2026-09-29/30）

> 本文件只登记**实测读数**：每条判据都写清「**哪个读点被影响、读数是几**」，
> 而不是"我跑了/判据绿了"。复跑命令附在文末；所有数字都可用 `tmp/ab-acceptance.py` 复现。

## 一、这一批要修的是什么（人类红线）

A 族 53 条「自己/敌方获得 物攻·魔攻·物防·魔防·速度±N%」里，有 **11 条是"假绿"**：
判据 `mechanics.resolved = true`、`buff_self` 事件也真的发了，但**引擎里没有任何读点读它**：

```
改前实测（tmp/ab-fakegreen.py）：
  攻方 spa=+100% 打魔攻技能 : damage 101 → 101   ✗ 乘区恒 1.0，增益被静默丢掉
  守方 spd=+100% 打魔攻技能 : damage 101 → 101   ✗
  order_speed 源码里出现 'buffs' : False          ✗ 速度 buff 根本不进先手
  而 atk=+100% → 202 ✓ / def=+100% → 50 ✓         （这两条本来就有读点）
```
这就是「**接上了但不生效**」那一族的第三次出现（前两次：`resolve_hit_count` 覆盖 · `_damage_preview` 恒不触发）。

## 二、修法（两处读点）

| 读点 | 位置 | 能力位 | 改前 | 改后 |
| --- | --- | --- | --- | --- |
| 伤害乘区按**伤害类别**取键对 | `effects.buff_damage_multiplier(atk_key=, def_key=)` ← `compute_damage` 传 `spa/spd` 或 `atk/def` | 复用已声明的 `damage.attack_stat_by_class` | 写死读 `atk`/`def` | 魔攻技能读 `spa`/`spd` |
| 先手速度 | `env.order_speed` → `_speed_with_buffs` | 新增 `stat_gain.speed_buff`（%）· `stat_gain.flat`（平值） | 完全不读 `buffs` | ×`(1+buffs["spe"]/100)` 与 `+buffs_flat["spe"]` |

⚠ 第一条**不需要新能力位**：`damage.attack_stat_by_class` 说的是"伤害按技能的伤害类别结算"，
乘区本来就是结算的一部分；只补面板不补乘区才是缺陷。legacy / v2 没声明 ⇒ 面板与乘区**同一对键**
（`atk`/`def`）⇒ 逐位不变。

## 三、11 条逐条的「实现前 / 实现后」读数

**口径**（这一步踩过坑，写清楚）：不能拿 v2 直接比 v3 —— v3 还多声明了 `damage.attack_stat_by_class`，
那会把伤害整体换一套面板。所以口径是**同一配置内**：第 1 手「用被测技能」vs「基准手（不带 buff）」
的第 2 手伤害差 **Δ**；读数用 `effects.compute_damage`（引擎唯一的伤害实现），
探针招用 `plain_attack` 的纯伤害招（否则会读对手能量，把"能量差"混进 Δ）。
防御招那几条让**敌方真的出攻击招**，好让「应对攻击：…」有机会成立；
读数前把 `_defense_reduction` 对称清零（那是术语 1016 的减伤，属另一条机制）。

| skill | 效果 | 读点 | 实现前 Δ | 实现后 Δ | 读数（不带 → 带） |
| --- | --- | --- | --- | --- | --- |
| `skill_000272` 魔法增效 | 自己魔攻+70% | 伤害乘区 `spa` | **0** | **+77** | 111 → 188 |
| `skill_000424` 润泽 | 自己魔攻+190% | 伤害乘区 `spa` | **0** | **+211** | 111 → 322 |
| `skill_000429` 水泡盾 | 应对攻击→自己魔攻+70% | 伤害乘区 `spa` | **0** | **+77** | 111 → 188 |
| `skill_000547` 寒风吹 | 敌方魔防-50% | 伤害乘区 `spd` | **0** | **+111** | 111 → 222 |
| `skill_000758` 魔镜 | 敌方魔防-50% | 伤害乘区 `spd` | **0** | **+107** | 107 → 214 |
| `skill_000757` 虚化 | 应对攻击→自己魔防+70% | 伤害乘区 `spd` | **0** | **-47** | 敌打我方魔攻 112 → 65 |
| `skill_000319` 鼓劲 | 自己魔防+170% | 伤害乘区 `spd` | **0** | **-51** | 敌打我方魔攻 81 → 30 |
| `skill_000350` 丰饶 ⟡ | 物攻和魔攻+140% | 乘区 `atk`+`spa` | +133 | **+141** | 101 → 242 |
| `skill_000588` 麻痹 ⟡ | 敌方双攻-70% | 乘区（对侧） | -182 | **-71** | 敌打我方魔攻 101 → 30 |
| `skill_000287` 防反 ⟡ | 应对攻击→物攻和魔攻+70% | 乘区 `atk`+`spa` | +49 | **+77** | 111 → 188 |
| `skill_000404` 怒火 ⟡ | 物攻和魔攻+120% | 乘区 `atk`+`spa` | +131 | **+86** | 72 → 158 |

⟡ = 早前分类里的「**半死 4 条**」：`atk` 那一半本来就有读点，**另一半是"归因错"** ——
改前魔攻技能的伤害是被**物攻 buff** 驱动的（`buff_damage_multiplier` 写死读 `atk`），
所以 Δ 不为 0 却**打在对不上的那套面板上**。改后两边各归各的面板。

### 速度读点（`env.order_speed`，回执里登记 `speed_provenance`）

| skill | 效果 | 实现前 | 实现后 |
| --- | --- | --- | --- |
| `skill_000691` 乘风 | 自己获得速度+120（平值） | `order_speed = 78` · `buffs_flat = {}` · **无事件** | **198.0** · `buffs_flat={"spe":120}` · `buff_self_flat{spe:+120}` |
| `skill_000278` 急速转向 | 自己获得速度+80（平值） | `84` · `{}` | **164.0** · `{"spe":80}` |
| `skill_000548` 雪球 | 敌方获得速度-90（平值） | 敌方 `130` | 敌方 **40.0** · `buffs_flat={"spe":-90}` |

## 四、反证（每条都有必红方向）

1. **没声明的路径逐位不变**：同一只手，`legacy_sim_v1` / `mobile_s4_candidate_v2` 的读数
   **逐字等于改动前**（上表"实现前 Δ=0"那一列就是它们）。判据：
   `tests/test_stat_gain.py::test_counter_proof_legacy_and_v2_are_bit_identical`。
2. **条件效果不许当无条件效果**（这一批最容易犯的错）：
   `skill_000790`「应对防御：**改为**敌方获得双攻和双防-120%」**不许**进基础效果（否则应对失败也扣）；
   `skill_000805`「**若击败敌方**，自己获得魔攻+70%」同样回收。
   ⇒ `tests/test_stat_gain.py::test_counter_proof_conditional_clauses_are_not_claimed`。
3. **C 堆照旧如实报不支持**：描述含「冻结」**18/18** 全 `false` · 含「吸血」**15/15** 全 `false` ·
   `skill_000717`（萌化）仍 `false`。
4. **tier ↔ verdict 不许打架**：427 并集 **改前 18 → 改后 8**（本批**引入 0**、修掉 10）。
   三处登记（`settlement_verdict` / `classify_skill_declared` / `service._skill_record` /
   `build_coverage`）逐条同值。

## 五、复跑命令

```bash
# 11 条逐条读数（本文件第三、四节的数字）
python3 tmp/ab-acceptance.py

# 假绿的原始读数（改前那种：101 → 101）
python3 tmp/ab-fakegreen.py

# 判据（14 条）
cd roco && PYTHONPATH=src python3 -m unittest tests.test_stat_gain -v

# 全量
cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -t .
# ⇒ Ran 723 tests · OK (skipped=1)

# 生成器（硬规矩：rulesets 只由生成器写）
node scripts/roco/build-rule-configs.mjs --check
# ⇒ ✔ data/roco/rulesets 的全部配置与台账一致

# 回归集（⚠ 必须从**仓库根**跑：默认 --out 按 cwd 解析）
PYTHONPATH=roco/src python3 -m roco_env.regression --check
# ⇒ ✔ 回归集与磁盘上的指纹一致
```

## 六、已知边界（如实登记，不假装已做）

- **攻打支的「应对」子句仍是无条件应用**（`env._execute` 攻击支没有 `if succeeded` 门）——
  那是**接手前就有**的行为，本批**没动它**（不扩大改动面）；它的原文照旧进 `state.unsupported`。
- **条件式「获得 属性±N」**（「若 / 选择 / 每 / 时 / 后 / 前 / 当 / 或 / 期间」）**一律不认领**，
  如实报未结算 —— 它们要的是新的结算支，不是放宽正则。
- 「**每驱散1层获得 属性+N**」（E 族）仍需新原语「驱散印记」，本批未做。
