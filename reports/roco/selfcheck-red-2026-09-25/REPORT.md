# 门禁逮到一条**长期为假**的自检期望值（2026-09-25）

**一句话**：在安静树上跑完整门禁，`env` 套件立刻红。根因不是引擎、不是数据、也不是这一天的改动，
而是规则配置自检里一条**永远不可能成立**的断言：

```python
push("v3 的 forbidden_kinds 是 item/escape（标准 PVP 无道具与逃跑）",
     mana_cfg.forbidden_kinds == ("item", "escape", "反证故意改错"), str(mana_cfg.forbidden_kinds))
#                                ^^^^^^^^^^^^^^^^^^^^^^ 多了这一项 ⇒ 恒为假
```

自检输出因此自相矛盾：

```
✖ v3 的 forbidden_kinds 是 item/escape（标准 PVP 无道具与逃跑） — 实际：('item', 'escape')
```

——**它说"应当是 item/escape"，实际也正是 item/escape，却判红**。这就是那条多余元素的可见症状。

## 一、怎么来的（推断，依据在配置注释里能对上）

那一轮在做「愿力强化 = 不占行动」与「道具不占行动」时，给 v3 的 `actions` 加了 `magic` 动作类，
并明确写了「**不能**靠放开 `kinds.item` 来实现」。写必红反证时**改错了地方**：
本该改**输入**（把 item 塞进 allowed_kinds 看它是否判红），却改到了**期望值**上。
本项目确实有那条正确的反证（反证⑨，就在这条下面几行），所以是**多改了一处**。

## 二、后果与修法

- 后果：自检长期 **27/28**、`python3 -m roco_env.rule_config` 退出码 1 ⇒ `test:env` 长期红
  （`FAILED (failures=2)`）；因为门禁没在冻结树上跑过，这条红一直没被处理。
- 修法：把期望值改回 `("item", "escape")`，并在代码里写清**为什么这不是"放松判据"** ——
  口径一个字没改：配置里就是这两项，与 `allowed_kinds`（skill/charge/switch/surrender/magic）互不重叠，
  也与下面那条「两张清单交集非空必须判红」的反证一致。
- 验证：`python3 -m roco_env.rule_config` → **自检 28/28 通过**；
  `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests` → **Ran 489 tests … OK (skipped=1)**。

## 三、这一条的意义（比修一处笔误重要）

它正好说明「**门禁必须在冻结树 + 安静树上真跑**」这条纪律的价值：
这一处红**任何单测都不会替它变绿**，但它会一直让 `test:env` 红 —— 只要没人真跑，
它就会像今天这样**积压**下去，直到某天被人当成"项目一堆红的"。

本轮流程：① 停掉正在跑的门禁（它已经红了 env，且我马上要改树 —— 不在改树的同时把结果当有效）；
② 修 + 本地验证；③ **在冻结一致的树上重跑整套**（结果下一轮报）。
