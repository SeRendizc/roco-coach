# 分计划 00 · 族③ 收窄：`global_skill_mods` 认领要求 **env 真有写点**（task-2）

- 执行者：`plan00-closer` · 2026-09-30 · 分支 `wip/roco-coach-2026-09-30-1418`
- 接手基线 commit `83ed968`；复核时 HEAD = `6b66147`（Lead 只加 `STATE.json` + `harness/last-run.json`）
- 唯一源码写域：`roco/src/roco_env/coverage.py`
- 前置：task-1（族②）已完成并 complete —— 同一文件**串行**改，两次三件套分开留档
- 原始输出（不入库，留 `E:\roco-scratch\`）：
  `p00-fam3.out.txt`（快速三件套+逐行）· `p00-fam3-unittest.stderr.txt`（全量）·
  `p00-rt-family3.txt`（**真开局真出招**事件流原文）· `p00-counterproof.out.txt`（反证条数）

## 0. 结论：选 **(A) 认领必须要求 env 真有写点**

`430 水环` / `441 洗礼` / `531 冰晶坠` / `532 冰雹` / `534 冰冻光线` / `682 防御反击` 六条的
非冒号体「（并）获得全技能威力/能耗±N」文本被 `resolve_global_skill_mod(declared=True)` 认领，
但**运行时那条链一个字节都不结算**：36 组真打一手（6 技能 × 6 敌手动作）**没有一次**
`global_skill_mod_applied`，两边 `global_skill_mods` 恒为 `{}`。⇒ 按 A 案**不认领**。
（B 案不成立：不是"认领入口写错"，是 env 三处的门挂在**不存在的配置叶子**上 —— 见 §2。）

改动后：**并集打架 0 · totals 313 → 306（＝钉住的真基线）**，六条如实降 `PARTIAL` + 判据
`resolved=False`，且**六行都点得出缺口原文**（不是匿名桶）。

## 1. 逐行运行时报据（交付件 ①）：引擎到底发不发 `global_skill_mod_applied`

做法（`p00-runtime.py`，真开局、真出招）：为每条技能找一只学得会的精灵、把那手技能放进攻略，
`env.reset(..., config="mobile_s4_candidate_v3")` 后对**每一个合法敌手动作**各重置一次再 `step_joint`，
读 `events` / 双方 `global_skill_mods`。原文：`p00-rt-family3.txt`。

| skill | category | me_mods（6 组敌手动作） | `global_skill_mod_applied` |
|---|---|---|---|
| 430 水环 | 防御 | `{}` ×6 | **0/6** |
| 441 洗礼 | 状态 | `{}` ×6 | **0/6** |
| 531 冰晶坠 | 攻击 | `{}` ×6 | **0/6** |
| 532 冰雹 | 攻击 | `{}` ×6 | **0/6** |
| 534 冰冻光线 | 攻击 | `{}` ×6 | **0/6** |
| 682 防御反击 | 防御 | `{}` ×6 | **0/6** |
| **721 赤子之心**（对照·冒号体） | 状态 | `{'cost_delta': -2}` ×6 | **6/6** |
| **728 撒娇**（对照·冒号体） | 攻击 | `{'power_pct': 10}` ×6 | **6/6** |

对照组的**事件流原文**（`721`，任一敌手动作下都一样）：

```json
{"kind": "global_skill_mod_applied", "turn": 1,
 "detail": {"side": "player", "skill_id": "skill_000721", "key": "cost_delta",
            "delta": -2, "total": -2, "evidence": "全技能能耗永久-2"}, "evidence": []}
```

六条的代表性事件流（每条 6 组，节选）：

```
430 水环   kind=skill 286 → turn_start,defense,defense                     me_mods={} foe_mods={}
430 水环   kind=skill 378 → turn_start,defense,damage,energy_gain,…        me_mods={} foe_mods={}
441 洗礼   kind=skill 392 → turn_start,damage,cleanse,status_applied       me_mods={} foe_mods={}
531 冰晶坠 kind=skill 567 → turn_start,damage,damage                       me_mods={} foe_mods={}
532 冰雹   kind=skill 378 → turn_start,damage,damage,energy_gain,…         me_mods={} foe_mods={}
534 冰冻光线 kind=skill 392 → turn_start,damage,faint,mana_loss,…          me_mods={} foe_mods={}
682 防御反击 kind=skill 378 → turn_start,defense,damage,energy_gain,…      me_mods={} foe_mods={}
```

六条各自的 `gate` 也逐条不同（防御支 / 敌方方向 / 无条件子句），但**结论一致**：
没有任何一条走到写点。

## 2. 为什么是 (A)：结构依据（只读 `env.py` / `rule_config.py`，未改它们）

```
env.py:1294-1295（防御支）  parse.resolve_global_skill_mod(
                              skill, declared=bool(getattr(cfg, "damage_global_skill_mod_text", False)), …)
env.py:1395-1396（攻击支）  同上
env.py:1868-1869（状态支）  同上
rule_config.py              全文件 grep 'global_skill_mod_text' = **0 命中**（`RuleConfig` 没有这个叶子）
```

⇒ `getattr(cfg, "damage_global_skill_mod_text", False)` **恒 False** ⇒ 三处 `resolve_global_skill_mod`
**永不产出** ⇒ 写点（`env.py:2014-2027` 的 `global_skill_mod_applied`）在这三条链上永远走不到。
（该叶子的接线曾被**回退**：`docs/roco/coach-理想形态-计划书-2026-09-30.md` §"回退"附录 BT/BU 逐字记着
「27 条名单 / 重叠 = 0 / 先回退让树回绿」，`grep -c global_skill_mod_text` 在那两处当时就回 `0`。）

**旁证（方向也错）**：`531 冰晶坠`「**敌方**获得全技能能耗+1」、`534`「**敌方**获得全技能能耗+2」
被解析成 `target=self`（`evidence='获得全技能能耗+1'`，连主语都丢了）⇒ 即使哪天真接上写点，
这一支也会写到自己身上。**两条独立理由都指向"不许认领"**。

**依派工要求：需要改 `env.py` 才有正确行为 ⇒ 停下、不改、如实回报**（`env.py` 属 01 写域）。
`damage_global_skill_mod_text` 的三处 `getattr` 要么接线、要么删死代码，留给 Lead 派单。

## 3. 改动（`roco/src/roco_env/coverage.py`，一处）

| 阶段 | sha256 | 行数 |
|---|---|---|
| HEAD（`83ed968`/`6b66147` 同 blob `4ac9f1fb…`） | `36650edf4f2e87f36947b459bdeb4bcc5e7eecee225331ca74047839bf577022` | 1582 |
| 族② 后（task-1） | `e7e7edc21a97a4ba35eb095dbd9f8e491b6459ab29583caf355cebd8cfd92a86` | 1622 |
| **族③ 后（本件）** | `21b80d3fe4dddf4c249a6a1ee1d53f4f2fe764be867ec9cba99c9885e2631006` | 1640 |

`_claim_global_skill_mods()`：**删掉** `parse_mod.resolve_global_skill_mod(skill, declared=True, …)`
这一句（非冒号体），只留 `resolve_moe_colon(…, global_declared=True)`（冒号体）。
docstring 里写全了运行时报据、结构依据、A/B 选择理由与**只动本族**的边界。

## 4. 三件套（原始输出）

```
$ wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p00-fam3.sh
=== [1] import ===                      OK                 exit=0
=== [2] union-check.py ===              union 0 totals 306 exit=0
=== [3] p00-delta.py ===                exit=0
=== [4] p00-rows.py ===                 exit=0
```

- **并集打架 427 条：`0`**
- **totals：`306`** —— 与真基线 `reports/roco/rc401/effect-coverage.json` **逐桶一致**：
  `battle_skills 298 / PARTIAL 280 / KNOWLEDGE_ONLY 1`（基线 298 / 279 / 2，`684` 一行为
  `KNOWLEDGE_ONLY → PARTIAL` 的换档，见 §6），traits 桶逐字相同，`simulatable_ratio 0.3714`。
- 逐行差（totals 口径）只剩 1 正 1 负，**都不是本族**：

```
+ 762 小型打劫（有运行时报据，合法翻正）
- 584 引雷（假阴性）
~ 684（KNOWLEDGE_ONLY → PARTIAL）
```

- **定向判据**：

```
tests.test_effect_coverage              Ran 21  OK        exit=0   ← 基线 21 ran 1F；本族收口后转绿
tests.test_tier_verdict_agreement       Ran 8   1F        exit=1   ← 仍是那条 5<8 反证（不属本族）
tests.test_global_skill_mods_transition Ran 3   OK        exit=0   ← 721/728 的正向钉子未动
tests.test_cleanse_marks                Ran 16  OK        exit=0
tests.test_respond_override             Ran 31  OK        exit=0
tests.test_moe_mark                     Ran 5   OK        exit=0
tests.test_element_power_ramp_defense_transition  Ran 3  OK        exit=0
```

- **全量**（`p00-fam3-full.sh`，174.4 s；⚠ 树含 plan01-engine 未提交改动）：
  `Ran 857 · 5 failures + 0 errors · skipped=2`。5 条失败的归属：

| 失败 | 归属 |
|---|---|
| `test_event_text.test_sample_events_cover_every_declared_kind`（`['opening_roster_revealed']` 没有样例事件） | plan01-engine（观察契约新事件） |
| `test_regression_set.test_disk_artifact_matches_a_fresh_build` | plan01-engine（`rc404/regression-set.json` 陈旧） |
| `test_turn_order_fail_closed` ×2（golden 指纹 `bdc7bcc3…` / `5b2d20fc…` 变了） | plan01-engine（新事件进了短期观察载荷） |
| `test_tier_verdict_agreement.test_counter_proof…`（`5 not >= 8`） | **00 已知红**，本族前后都是 5（见 §5） |

⇒ 与族②那次全量（8F）相比，**`test_report_has_no_simulatable_with_unclaimed_mechanic_spans`
（`312 != 306`）已转绿** —— 那是本族的直接效果；其余 4 条是 plan01 的在飞改动，与本族无关。
`coverage.py` 在两次全量之间只动了本族这一处（sha256 见 §3）。

## 5. 反例（交付件 ④，两向都有运行时报据）

**「有写点 ⇒ 认领」**：`721 赤子之心` / `728 撒娇`（冒号体「自己获得萌化：全技能能耗永久-2 / 全技能威力永久+10」）
—— 真打一手 **6/6 组**都发 `global_skill_mod_applied`（§1 的 RAW），改后仍 `SIMULATABLE_UNVERIFIED` +
判据 `resolved=True`；`test_global_skill_mods_transition` 3 条全 OK。

**「没写点 ⇒ 不认领」**：`441 洗礼`（无条件子句，最能说明问题的一条）——
6 组敌手动作**一次事件都没有**，`global_skill_mods` 恒 `{}`；改后：

```
skill_000441 洗礼 | TIER=PARTIAL
  why=读出了 1 条效果，但描述里还有 1 段机制**引擎没结算**：获得：并获得全技能能耗-1
  VERDICT resolved=False · unsettled=['获得：并获得全技能能耗-1']
```

**边界（不是反例，是本族之外的相邻行）**：`667 化劲` / `680 提气` / `776 力量吞噬` 同样是
非冒号体文本，但它们的文本**另有** `stat_gain_extended` 那条链产出 —— 真打一手实测
`buff_self{stat:"atk"…}` / `debuff_foe` 事件（`p00-rt-family3.txt`），且基线 306 里它们就是
`SIMULATABLE_UNVERIFIED` ⇒ **本次不动、档位不变**。若下一轮要把它们也降档，那是**另一族**的事，
需要先证明 `buffs["power"]` 的读点；本报告只如实登记。

## 6. 诚实边界

1. **totals 落在 306 不是拟合**：账是 `+1（762 合法）/ −1（584 假阴性）`，两条都不属本族、都**未动**。
   本族的贡献是「六行不再被算作可模拟」；净额恰好抵平是两条外部行的巧合，不是目标。
   ⚠ 若要继续收 584 那条假阴性，属**另一族**（诊断形状「迸发」与产出的覆盖关系），需另行派单。
2. **六条降档后点得出缺口**（不是匿名桶）：
   `430`/`532`/`682` = `获得：…` span + `应对：…` 分句两条；`441`/`531`/`534` = `获得：…` span 一条。
3. **未改任何判据断言**（`roco/tests/**` 一行未动）；`test_effect_coverage` 由红转绿是**读数变了**
   （312→306 命中它原有的 `assertEqual(..., 306)`），不是断言被放宽。
4. **未跨域改 `env.py`**：`damage_global_skill_mod_text` 的三处死门如实登记（§2），等 Lead 派单；
   本族的语义是「台账不再把没写点的路径说成已结算」，不替引擎接线。
5. **`5 < 8`（关闸反证）仍是红的**：本族前后都读到 `baseline 0 / gates-off 5`
   （`412/510/539/671/694`，全同方向），与 `harness-verifier` 的独立读数一致 ⇒ 未被本族影响，
   也不在 task-2 范围。
6. 全量读数的树含 plan01-engine 未提交改动（`env.py`/`service.py`/`schema.py`/`events_text.py`/
   `regression.py`/`test_event_text.py`/`test_public_planner.py`/`rc404/regression-set.json`），
   集成时以 Lead 的 src 树 hash 为准。
