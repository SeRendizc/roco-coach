# 独立复验：分计划 00 · 族③（`plan00-family3.md`）（harness-verifier）

**对象**：`plan00-closer` 的 task-2（`global_skill_mods` 非冒号体认领要求 env 真有写点）
**结论**：**声明全部成立，且不是反向拟合** —— 运行时差分为「负域 0 / 正域 22」，台账逐行对得上。
**风险背景**：这是「313 → 306」差 +7 里的最后 6 行，**任何反向拟合都会在这里发生** ⇒ 本复验按最严口径做。
**取数**：`coverage.py = 21b80d3fe4dddf4c249a6a1ee1d53f4f2fe764be867ec9cba99c9885e2631006`（族③ 后）

---

## 1 · 运行时差分（`scripts/roco/verify-family3-runtime.py`，我自建）

真开局、真出招；对**每一个合法敌手动作**（12 个）各重置一次再 `step_joint`，数
`global_skill_mod_applied` 事件并读 `player.field_pet.global_skill_mods`。

```
负域（非冒号体，本次被收窄的 6 条）
  430 水环      防御  12 组敌手动作  applied=0  mods={"{}"}
  441 洗礼      状态  12 组          applied=0  mods={"{}"}
  531 冰晶坠    攻击  12 组          applied=0  mods={"{}"}
  532 冰雹      攻击  12 组          applied=0  mods={"{}"}
  534 冰冻光线  攻击  12 组          applied=0  mods={"{}"}
  682 防御反击  防御  12 组          applied=0  mods={"{}"}
正域（冒号体对照，已知有写点）
  721 赤子之心  状态  12 组          applied=11 mods={"cost_delta": -2} / {}
  728 撒娇      攻击  12 组          applied=11 mods={"power_pct": 10} / {}

DIFFERENTIAL neg_applied=0 pos_applied=22 neg_tried=72    RUNTIME_FAILS 0
```

- **差分控件成立**：同一把尺子、同一夹具，正域量得到 22 次写点事件 ⇒ 负域的 0 **不是探针瞎了**。
- 负域 72 次真出招里**一次写点都没有**，`global_skill_mods` 恒 `{}` ⇒ 这 6 条的文本
  在运行时**确实没有结算** ⇒ 收窄**不是误伤**。
- 多条负域事件流里出现 `effects_registered_unsupported`（引擎自己承认这段没实现），
  与「解析得出效果但没写点」一致。
- 我的组数（12/12，正域 11 命中）比实现者的（6/6）更宽，方向与结论一致。

## 2 · 结构依据（我自己 grep 的）

```
rule_config.py  'damage_global_skill_mod_text' 命中数 = 0        ✓（RuleConfig 没这个叶子）
env.py          'damage_global_skill_mod_text' 命中数 = 3        ✓（1298/1399/1872 三处 getattr）
```
⇒ `getattr(cfg, "damage_global_skill_mod_text", False)` **恒 False** ⇒ 非冒号体那条
`resolve_global_skill_mod(...)` 永不产出 ⇒ 写点走不到。实现者的 A/B 选择（选 A「不认领」）
有结构依据，且**没有跨域改 `env.py`**（env.py 属 01 写域）—— 死门如实登记，处置留给 Lead。

## 3 · 台账逐行（`scripts/roco/verify-totals-delta.py`，自带 6 项控件）

```
TOTALS baseline_simulatable=306 current_simulatable=306 delta=0
SUPPORT_LEVELS battle_skills  基线 {SIM 298, PARTIAL 279, KNOWLEDGE_ONLY 2}
                              现在 {SIM 298, PARTIAL 280, KNOWLEDGE_ONLY 1}
翻正 1：762 小型打劫（有运行时报据，非本族）
翻负 1：584 引雷（假阴性，非本族）
同带内变更 1：684（KNOWLEDGE_ONLY -> PARTIAL）
union_mismatches=0 · census_ids=427
```

⇒ **SIM 桶 298 == 基线 298**（这才是「六行收回」的直接证据）；`PARTIAL +1 / KNOWLEDGE_ONLY -1`
来自 `684` 的同带内换档。**totals 落在 306 的账是 `+1(762) −1(584)`，两条都不是本族、都没动** ——
与实现者 §6.1 的说明一致：净额抵平是巧合，不是目标。**没有发现任何反向拟合痕迹。**

## 4 · 判据未被放宽（声明「roco/tests/** 一行未动」）

```
git diff --stat HEAD -- roco/tests
  test_event_text.py / test_public_planner.py / test_turn_order_fail_closed.py / test_ui_public_view.py
  ← 全是 plan01-engine 的文件；**test_effect_coverage.py / test_tier_verdict_agreement.py 不在其中** ✓
```
⇒ `test_effect_coverage` 的 `313 != 306` 转绿**确实来自读数变化**（`assertEqual(..., 306)` 命中），
不是断言被改宽。`coverage.py` 相对 HEAD：`74 insertions(+), 10 deletions(-)`，其中
`- parsed = parse_mod.resolve_global_skill_mod(skill, declared=True, parsed=parsed)` 正是族③ 那一处。

## 5 · 未覆盖 / 边界

- 本复验只对 `coverage.py` 的族③ 改动负责；**全量用例**与 **01 侧**读数见第 3 阶段冻结 bundle
  （族③ 自己的全量是在含 plan01 未提交改动的树上跑的，我不拿它下结论）。
- `667 化劲 / 680 提气 / 776 力量吞噬` 是六条之外的相邻行，实现者已如实登记「另有链产出、本次不动」；
  本复验**未**对它们单独取数（属下一族，需要先证 `buffs["power"]` 读点）。
- 被收窄的 6 条降档后是否**判据侧同值**：由 §3 的 union 0（427 并集）覆盖；
  6 条里只有部分在并集内，并集外部分由 totals 逐行口径覆盖。

## 6 · 复跑

```sh
cd /mnt/e/roco-coach/roco && PYTHONPATH=src python3 ../scripts/roco/verify-family3-runtime.py
cd /mnt/e/roco-coach && PYTHONPATH=roco/src python3 scripts/roco/verify-totals-delta.py --selftest
```
原文：`reports/roco/product-execution/00/verify-family3-runtime.txt`
