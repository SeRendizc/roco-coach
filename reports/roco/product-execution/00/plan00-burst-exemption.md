# 分计划 00 · A 批（D-8）：迸发已结算形状豁免 + 按规矩改钉 306→309

- 执行者：`plan00-closer` · 2026-09-30 · task-5 · 授权：**用户裁决 D-8 = A**（Lead 转达）
- 基线（本件所有"改前"读数）＝ **`git archive 2e30a4f`**（缺陷 B 已入库）的干净副本 `/mnt/e/roco-scratch/p00-clean2`
- 写域：`roco/src/roco_env/coverage.py` · `roco/tests/test_effect_coverage.py` · `reports/roco/product-execution/00/`
- 原始输出（`E:\roco-scratch\`）：`p00-a-after.out.txt`（逐行差分）· `p00-a-runtime.out.txt`（真打一手）·
  `p00-a-targeted.out.txt` · `p00-a-unittest.stderr.txt`（全量）· `p00-a-orig.txt`（原值逐字）·
  `p00-a-treehash.out.txt` · `p00-snap-{before,after}.json`

## 0. 一句话

「迸发：本次技能威力+N」的威力那半**不是解析层产出的效果**，是**结算期**由
`effects.effective_power()` 算的（窗口 = `env.py:1266` 的 `_burst_active`）；诊断形状闸只按
"形状在 desc 里、且没有 effect evidence 覆盖"判 ⇒ `313/581/584` 被判未结算（**假阴性**）。
A 案 = 给「迸发」加**同源豁免**（直接调 `effective_power()`，不另抄形状清单）+ `has_static_power` 守卫，
并按规矩改钉 `306 → 309`。实测：**恰好 3 行翻正**、`totals 306→309`、`union` 仍 **0**、关闸反证仍 **5**、
四条守卫（`583/587/598/607`）**仍 PARTIAL**、干净副本全量 `Ran 847 · 1F + 0E`（唯一红 = 已知 `5>=8`）。

## 1. 改动（两处，均最小）

| 文件 | 改前 sha256（`2e30a4f`） | 改后 sha256 |
|---|---|---|
| `roco/src/roco_env/coverage.py` | `877dbbb51e370d936e90837e25e65322f345a090cf7a45819b0a02dbcca6ddba` | **`e3e330090b91cf67f9715dd836b2cb6b3527353c91a598e6e84d151d77e80df3`** |
| `roco/tests/test_effect_coverage.py` | `44eae4c8866945baca9977025e085e12f900c75bb986390bb47ba1bf6c452f` | **`12657b2898ce81cf503fab6d1e1a3bdf516215931f4d495aadd59a43151b0102`** |

### 1.1 `coverage.py`：**同源豁免**（不是另抄一张形状清单）

```python
class _BurstProbe:            # 只为调 effective_power 造的最小替身（只读 energy/_respond_succeeded/_burst_active）
    __slots__ = ("energy", "_respond_succeeded", "_burst_active")
    def __init__(self, burst_active: bool) -> None:
        self.energy = 0
        self._respond_succeeded = False
        self._burst_active = bool(burst_active)


def _burst_power_is_settled(skill: Any) -> bool:
    if not getattr(skill, "has_static_power", False):
        return False
    try:
        res = fx.effective_power(skill, attacker=_BurstProbe(True),
                                 defender=_BurstProbe(False), rs=None)
    except Exception:
        return False
    return "迸发" in str(getattr(res, "reason", "") or "")
```

`diagnostic_shape_gaps()` 的循环里加两行：

```python
        if label == "迸发" and _burst_power_is_settled(skill):
            continue                      # 「迸发：本次技能威力+N」引擎真的加 ⇒ 不算缺口
```

**为什么这样算"同源"**：判据与结算调的是**同一个函数**（`env` 结算走 `env.py:1380`
`fx.effective_power(...)`），窗口也是同一个标志（`env.py:1266` 设 `_burst_active`）。
判据只做一件事：窗口开/关各跑一次，看**函数自己给出的** `reason` 里有没有「迸发 →」。
⇒ 不再有"判据侧另抄一张形状清单、一漂就散"的余地（上一轮抄漂过一次，见 `plan00-584-burst-evidence.md` §2）。

**守卫（fail closed）**：① `has_static_power=False` ⇒ False（无静态威力时该函数会抛，且引擎也不走伤害支）；
② 任何异常 ⇒ False（**不把"问不出来"当成"已结算"**）。

### 1.2 `test_effect_coverage.py`：改钉 `306 → 309`（最小修订）

只动**数字**与**那一段新注释**（文件既有风格的带日期改钉记录），其余断言一行未动；
`test_totals_add_up` / `test_ratio_is_recomputed_from_the_buckets`（`:30-47`）**没有硬编码**
`306`/`0.3714` —— 它们从报告自身重算（`sum(levels)==totals`、`tally/824≈ratio`），所以**无需连带修订**
（改钉后 `test_effect_coverage` 21 条**全绿**，见 §5）。

## 2. 原断言 + 撤回记录逐字留档（交付件 ②）

### 2.1 原断言（`2e30a4f:roco/tests/test_effect_coverage.py`，改钉前逐字）

```python
        #   ⇒ 所以：**这里回 306**，去修上面那四族 + 两条假阴性；修到能自洽再谈改数。
        #   ⚠ 被撤回的 `328` 与新证据一起留档（改钉不删）✓
        self.assertEqual(report["totals"]["simulatable_entities"], 306,
          "可模拟总数变了，先核对再改这条")
```

### 2.2 上面那段撤回记录（`:853-868`）的原意（逐字保留在文件里，未删）

```
        # ── 2026-09-30（分计划 00 · Lead）**改钉被撤回：328 → 306（回到原值）** ──────────
        #   ⚠ **先记教训**：我上一版把这里改成 328，依据是「影子注入 782 行 HEAD 备份 ⇒ 302」+
        #     「59 条翻正与判据一致」。**两条依据都不够**：
        #       · 782 行那份**不是 306 那一版**（它太旧，缺丢失层的多族 resolver）；
        #       · 「判据也说 True」是**循环**：判据与档位读同一批表，一起宽就会一起说 True。
        #   真正的 306 基线**就在仓库里**：`reports/roco/rc401/effect-coverage.json`
        #   （丢失那层留下的台账产物，`totals.simulatable_entities = 306`，可逐行对照）。
        #   按它逐行复核（`reports/roco/product-execution/00/ledger-delta-audit.txt`）：
        #     · 相对 306：**24 翻正 / 2 翻负**（净 +22）
        #     · 24 翻正里 **只有 3 条有运行时报据**（313/581 的「迸发」真结算、762 真发 `foe_team_energy_loss`）；
        #       **21 条是把未结算说成已结算**（真打一手 `power_used` 等于基础值、无对应事件），
        #       根因四族：诊断形状表缺形状（11）· `RESPOND_POWER_SETTLED_RE` 整句跳步（2）·
        #       `global_skill_mods` 认领不看 env 写点（6）· `elif claimed:` 只凭 `传动×1` 放行（2）
        #     · 2 条翻负（462/483）是**假阴性**，已有真打一手读数，属**该修的**（不是该改钉的）
        #   ⇒ 所以：**这里回 306**，去修上面那四族 + 两条假阴性；修到能自洽再谈改数。
        #   ⚠ 被撤回的 `328` 与新证据一起留档（改钉不删）✓
```

**这次为什么可以动它**：上一轮撤回的理由是"依据不够（影子比对 + 循环读数）"。
本件的依据**不是**影子比对，而是**新增的运行时报据**：三条行真打一手真的加威力（§3），
且逐行差分证明**只有这三行**变化（§4）。这正是那段记录的末句「修到能自洽再谈改数」的兑现。

### 2.3 新增的改钉记录（写在原记录之后，逐字）

见文件末段：`# ── 2026-09-30（分计划 00 · plan00-closer · **用户裁决后改钉 306 → 309**）`，
含依据（同源豁免函数名）、三行真打一手读数（60→90 / 80→120 / 35→55）、逐行差分（恰好 3 行 ·
totals 309 · union 0 · 反证 5 · ledger 3 / unsettled 4）、四条守卫仍 PARTIAL、以及
**旧值 `306` 逐字留档**（改钉不删）。

## 3. 独立运行时报据（交付件 ③）

`p00-a-runtime.sh`（干净副本终版，真开局 seed=7 / v3 / 真出招）：

### 3.1 三条翻正行（引擎真的加威力）

```
313 天旋地转  power=60  同源探针 窗口关=60.0(reason='') → 窗口开=90.0(reason='迸发 → 威力 +30.0')
              真打一手 damage: turn=1 power_used=90.0  reason='迸发 → 威力 +30.0'
              TIER=SIMULATABLE_UNVERIFIED | resolved=True | diagnostic_shape_gaps=[]
581 电弧      power=80  同源探针 80.0 → 120.0（+40.0）
              真打一手 damage: turn=1 power_used=120.0 reason='迸发 → 威力 +40.0'
584 引雷      power=35  同源探针 35.0 → 55.0（+20.0）
              真打一手 damage: turn=1 power_used=55.0 hits=2 reason='迸发 → 威力 +20.0'
```

### 3.2 四条守卫（仍 PARTIAL —— 交付件 ④）

```
583 超导     「造成魔伤，迸发：本技能能耗-2。」      _burst_power_is_settled=False（差值 0）
             真打一手 power_used=90.0 reason='' ⇒ TIER=PARTIAL · gaps=['迸发']   ← **负对照：描述有迸发但引擎不加威力**
598 双联脉冲 「造成魔伤，迸发：本技能使用次数+1。」   _burst_power_is_settled=False（差值 0）
             真打一手 power_used=50.0 reason='' ⇒ TIER=PARTIAL · gaps=['使用次数','迸发']  ← 第二条负对照
587 雷暴     「…迸发：本技能获得所有生效过的迸发，每获得1种，本技能能耗+1，威力+10。」
             _burst_power_is_settled=True（`_extract_plus` 读到句中「威力+10」⇒ 豁免），
             但**另有三条残余缺口**（`获得：…`×2 / `每：…`）⇒ TIER=PARTIAL · resolved=False ✓
607 踏雷     power=None（无静态威力）⇒ 守卫直接 False（函数抛 UnsupportedEffect，异常路径 fail closed）
             ⇒ TIER=PARTIAL · gaps=['迸发'] ✓
```

⇒ 「豁免」**不是恒真放行**：三条守卫里两条因**引擎自己不加威力**被挡、一条因**无静态威力**被挡、
一条因**另有缺口**仍判未结算。

## 4. 579 行逐行差分（干净副本 `2e30a4f` → 终版）

```
before root=/mnt/e/roco-scratch/p00-clean2 | after root=…/p00-clean2 | rows=579
totals            306 -> 309
union_mismatches  0 -> 0
gates_off         5 -> 5

【恰好 3 行】{(svc_tier, resolved)} 变化：
   skill_000313 天旋地转: PARTIAL/False -> SIMULATABLE_UNVERIFIED/True
   skill_000581 电弧:     PARTIAL/False -> SIMULATABLE_UNVERIFIED/True
   skill_000584 引雷:     PARTIAL/False -> SIMULATABLE_UNVERIFIED/True
ledger_tier（build_coverage 口径）变化行: 3 → ['skill_000313','skill_000581','skill_000584']   ← 就是这三行（诊断形状闸同时喂两把尺子）
unsettled 变化行: 4 → ['skill_000313','skill_000581','skill_000584','skill_000587']
                    （`587` 只是**掉了「迸发」这个标签**，另三条缺口还在 ⇒ tier/resolved 未动）
settled 列表变化行: 0
```

- 关闸反证 ID 逐字同组：`['skill_000412','skill_000510','skill_000539','skill_000671','skill_000694']`（before/after 相同）
- 427 并集打架：`[] → []`（0 → 0）

## 5. 定向 + 全量（干净副本终版）

```
tests.test_effect_coverage              Ran 21  OK                    exit=0   ← 改钉后全绿
tests.test_tier_verdict_agreement       Ran 8   1F                    exit=1   ← 只有 `5>=8` 那条红
tests.test_moe_mark                     Ran 5   OK                    exit=0
tests.test_stat_gain                    Ran 14  OK (skipped=1)        exit=0
tests.test_energy_loss_effects          Ran 6   OK                    exit=0
tests.test_moe_colon / moe_bidirectional / mark_transfer / self_power_flat /
tests.test_global_skill_mods_transition / cleanse_marks / respond_override /
tests.test_cond_self_debuff_power        全 OK                        exit=0
```

**全量（干净副本，`git archive 2e30a4f` + 本件·终版）**：

```
Ran 847 tests in 175.506s
FAILED (failures=1, skipped=2)
FAIL: test_counter_proof_disabling_the_shared_gates_brings_them_back
      AssertionError: 5 not greater than or equal to 8
```

⇒ 与 task-5 的预期逐字一致（`Ran 847 · 1F + 0E`），唯一红是**已裁决只登记**的反证那条（D-9）。

## 6. 树 hash（交付件 ⑥）

```
【逐文件比对 · p00-a-treecmp.py（终版）】
pristine(2e30a4f) roco/src+roco/tests: files=102 tree=afd17cfe9cebd611cd3a155bf18f6a08ff6809b3aeaf94b26c413507aba500e8
patched (终版)      roco/src+roco/tests: files=102 tree=790fe730c824389a3f344d5163302c3bbef29555f39cf0974d06f89a2a9feb6e
内容不同的文件：**恰好 2 个** —— roco/src/roco_env/coverage.py · roco/tests/test_effect_coverage.py（= 本件写域）
【独立脚本 · scripts/roco/verify-src-treehash.py（终版 clean2）】
TREE a051eabe1d911e1151cc5b99cacc61e24e73488d372aff8072fb2b90fd7acb8d   （连取两次，逐字相同 ⇒ 读数的树是冻结的）
```

（两个脚本的 digest 定义不同，数值不可互比；各自只与**自己**的前后取值比。）

## 7. 诚实边界

1. **没动 `parse.py`**：`584` 的 parse 产出 0 条 effect、而运行时读 desc，这个**两条链不同源**的更深问题
   按 Lead 指示登记为 **O-8** 留给后续；本件只做 coverage 侧豁免。
2. **没动反证那条**（D-9 已裁决"只登记"）：`5 >= 8` 仍是红，本件前后都是 5（同组 ID）。
3. **`587 雷暴` 的豁免是真豁免**：引擎确实对它加了 +10（`_extract_plus` 读到句中「威力+10」），
   这一半如实登记 —— 它之所以仍 `PARTIAL`，靠的是**另外三条残余缺口**，不是靠这条闸。
   若将来那三条缺口被认领，`587` 会翻正（属另一族，不在本件）。
4. `_BurstProbe` 是**判据侧的只读探针**（不引入游戏状态、不进 `env`）；`rs=None` 是因为
   `effective_power()` 当前不读 `rs`，异常路径 fail closed（返回 False）。
5. 未碰 git；未改任何其他断言；`306` 的旧值与撤回记录**逐字留档**（改钉不删）。
