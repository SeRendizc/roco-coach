# v9 候选 · 逐条审查表（**待审，不是训练数据**）

- 生成：`scripts/roco/build-sft-candidates.mjs`｜契约指纹 `tools:97a79a115da6`
- 候选 94 条｜语义族 19 个（措辞变体 214 个）
- 分片：{"train":60,"valid":12,"test":22}｜**语义族跨片重叠 0**
- 标记：失败回复 **60**｜目标实体不可核 **7**｜干净 **27**

## 为什么要逐条看

历史模型输出 **不是**黄金标签。三个已证实的反例：「为什么这一手要防御？」被标 `stop` 而回复是
「这次没有查到可用的规则事实」；「化蝶是哪一只」的目标是 `pet_000225`（寂灭骨龙，不是化蝶）。

| # | 片 | 语义族 | 问句 | 目标 | 回复（截断） | 标记 |
|---|---|---|---|---|---|---|
| 1 | valid | be-defense | 为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 2 | valid | be-defense | 为什么这一手要防御啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 3 | valid | be-defense | 再确认一下，为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 4 | valid | be-defense | 我在练习场，想问下：为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 5 | valid | be-defense | 我锁定寂灭骨龙，为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 6 | valid | be-defense | 我锁定寂灭骨龙，为什么这一手要防御啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 7 | valid | be-defense | 我锁定寂灭骨龙，再确认一下，为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 8 | valid | be-defense | 我锁定寂灭骨龙，我在练习场，想问下：为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 9 | valid | be-defense | 我队里带了画间沉铁兽，为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 10 | valid | be-defense | 我队里带了画间沉铁兽，为什么这一手要防御啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 11 | valid | be-defense | 我队里带了画间沉铁兽，再确认一下，为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 12 | valid | be-defense | 我队里带了画间沉铁兽，我在练习场，想问下：为什么这一手要防御？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 13 | train | be-energy | 能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 14 | train | be-energy | 我在练习场，想问下：能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 15 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 16 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系啊？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 17 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系啊？ | `{"tool":"query_rules","args":{"kind":"ruleset","attack_element":"寂灭骨龙"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 18 | train | be-energy | 我锁定寂灭骨龙，再确认一下，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 19 | train | be-energy | 我锁定寂灭骨龙，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"term","term_id":"1015"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 20 | train | be-energy | 我队里带了画间沉铁兽，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 21 | train | be-energy | 我队里带了画间沉铁兽，能量和威力是什么关系啊？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 22 | train | be-energy | 我队里带了画间沉铁兽，再确认一下，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 23 | train | be-energy | 我队里带了画间沉铁兽，我在练习场，想问下：能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 24 | train | be-energy | 我队里带了画间沉铁兽，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"term","term_id":"1015"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 25 | train | be-loss | 我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 26 | train | be-loss | 我这局输在哪啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 27 | train | be-loss | 再确认一下，我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 28 | train | be-loss | 我在练习场，想问下：我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 29 | train | be-loss | 我锁定寂灭骨龙，我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 30 | train | be-loss | 我锁定寂灭骨龙，我这局输在哪啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 31 | train | be-loss | 我锁定寂灭骨龙，再确认一下，我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 32 | train | be-loss | 我锁定寂灭骨龙，我在练习场，想问下：我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 33 | train | be-loss | 我队里带了画间沉铁兽，我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 34 | train | be-loss | 我队里带了画间沉铁兽，我这局输在哪啊？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 35 | train | be-loss | 我队里带了画间沉铁兽，再确认一下，我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 36 | train | be-loss | 我队里带了画间沉铁兽，我在练习场，想问下：我这局输在哪？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 37 | train | cs-answered | 寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 38 | train | cs-answered | 寂灭骨龙是什么属性呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 39 | train | cs-answered | 帮我看看寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 40 | train | cs-answered | 我在练习场，寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 41 | train | cs-answered | 我锁定寂灭骨龙，寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 42 | train | cs-answered | 我锁定寂灭骨龙，寂灭骨龙是什么属性呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 43 | train | cs-answered | 我锁定寂灭骨龙，帮我看看寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 44 | train | cs-answered | 我锁定寂灭骨龙，我在练习场，寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 45 | train | cs-answered | 我队里带了画间沉铁兽，寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 46 | train | cs-answered | 我队里带了画间沉铁兽，寂灭骨龙是什么属性呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 47 | train | cs-answered | 我队里带了画间沉铁兽，帮我看看寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 48 | train | cs-answered | 我队里带了画间沉铁兽，我在练习场，寂灭骨龙是什么属性？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 49 | test | cs-diagnose | 这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 50 | test | cs-diagnose | 这套阵容为什么坦度不够呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 51 | test | cs-diagnose | 帮我看看这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 52 | test | cs-diagnose | 我在练习场，这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 53 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 54 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 55 | test | cs-diagnose | 我锁定寂灭骨龙，帮我看看这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 56 | test | cs-diagnose | 我锁定寂灭骨龙，我在练习场，这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 57 | test | cs-diagnose | 我队里带了画间沉铁兽，这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 58 | test | cs-diagnose | 我队里带了画间沉铁兽，这套阵容为什么坦度不够呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 59 | test | cs-diagnose | 我队里带了画间沉铁兽，帮我看看这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 60 | test | cs-diagnose | 我队里带了画间沉铁兽，我在练习场，这套阵容为什么坦度不够？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 61 | train | cs-lastturn | 我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 62 | train | cs-lastturn | 我刚才那回合做了什么呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 63 | train | cs-lastturn | 帮我看看我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 64 | train | cs-lastturn | 我在练习场，我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 65 | train | cs-lastturn | 我锁定寂灭骨龙，我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 66 | train | cs-lastturn | 我锁定寂灭骨龙，我刚才那回合做了什么呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 67 | train | cs-lastturn | 我锁定寂灭骨龙，帮我看看我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 68 | train | cs-lastturn | 我锁定寂灭骨龙，我在练习场，我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 69 | train | cs-lastturn | 我队里带了画间沉铁兽，我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 70 | train | cs-lastturn | 我队里带了画间沉铁兽，我刚才那回合做了什么呢？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 71 | train | cs-lastturn | 我队里带了画间沉铁兽，帮我看看我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 72 | train | cs-lastturn | 我队里带了画间沉铁兽，我在练习场，我刚才那回合做了什么？ | `{"stop":true}` | 这次没有查到可用的规则事实（complete），未核验的部分我不编。 | reply_is_failure |
| 73 | test | ec-form | 化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 74 | test | ec-form | 是不是化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 75 | test | ec-form | 你确定化蝶是哪一只吗？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 76 | test | ec-form | 跟别的比，化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 77 | test | ec-form | 我锁定寂灭骨龙，化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 78 | test | ec-form | 我锁定寂灭骨龙，是不是化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 79 | test | ec-form | 我队里带了画间沉铁兽，化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 80 | test | ec-form | 我队里带了画间沉铁兽，是不是化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 81 | test | ec-form | 我队里带了画间沉铁兽，你确定化蝶是哪一只吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 82 | test | ec-form | 我队里带了画间沉铁兽，跟别的比，化蝶是哪一只？ | `{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000190"}}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | target_entity_not_in_question |
| 83 | train | ec-strength | 音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 84 | train | ec-strength | 是不是音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 85 | train | ec-strength | 你确定音速犬现在算强吗吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 86 | train | ec-strength | 跟别的比，音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 87 | train | ec-strength | 我锁定寂灭骨龙，音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 88 | train | ec-strength | 我锁定寂灭骨龙，是不是音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 89 | train | ec-strength | 我锁定寂灭骨龙，你确定音速犬现在算强吗吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 90 | train | ec-strength | 我锁定寂灭骨龙，跟别的比，音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 91 | train | ec-strength | 我队里带了画间沉铁兽，音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 92 | train | ec-strength | 我队里带了画间沉铁兽，是不是音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 93 | train | ec-strength | 我队里带了画间沉铁兽，你确定音速犬现在算强吗吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
| 94 | train | ec-strength | 我队里带了画间沉铁兽，跟别的比，音速犬现在算强吗？ | `{"stop":true}` | 两个来源对不上：目标精灵.atk 在 ruleset_panel_c | — |
