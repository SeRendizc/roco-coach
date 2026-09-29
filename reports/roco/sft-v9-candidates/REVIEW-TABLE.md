# v9 候选 · 逐条审查表（**待审，不是训练数据**）

- 生成：`scripts/roco/build-sft-candidates.mjs`｜契约指纹 `tools:97a79a115da6`
- 候选 93 条｜语义族 23 个（措辞变体 276 个）
- 分片：{"train":42,"valid":10,"test":17}｜**语义族跨片重叠 0**
- 标记：失败回复 **24**｜目标实体不可核 **0**｜干净 **69**

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
| 13 | valid | be-defense | 为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 14 | valid | be-defense | 为什么这一手要防御啊？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 15 | valid | be-defense | 再确认一下，为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 16 | valid | be-defense | 我在练习场，想问下：为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 17 | valid | be-defense | 我锁定寂灭骨龙，为什么这一手要防御啊？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 18 | valid | be-defense | 我锁定寂灭骨龙，再确认一下，为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 19 | valid | be-defense | 我队里带了画间沉铁兽，为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 20 | valid | be-defense | 我队里带了画间沉铁兽，为什么这一手要防御啊？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 21 | valid | be-defense | 我队里带了画间沉铁兽，再确认一下，为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 22 | valid | be-defense | 我队里带了画间沉铁兽，我在练习场，想问下：为什么这一手要防御？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 23 | train | be-energy | 能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 24 | train | be-energy | 我在练习场，想问下：能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 25 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 26 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系啊？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 27 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系啊？ | `{"tool":"query_rules","args":{"kind":"ruleset","attack_element":"寂灭骨龙"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 28 | train | be-energy | 我锁定寂灭骨龙，再确认一下，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 29 | train | be-energy | 我锁定寂灭骨龙，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"term","term_id":"1015"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 30 | train | be-energy | 我队里带了画间沉铁兽，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 31 | train | be-energy | 我队里带了画间沉铁兽，能量和威力是什么关系啊？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 32 | train | be-energy | 我队里带了画间沉铁兽，再确认一下，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 33 | train | be-energy | 我队里带了画间沉铁兽，我在练习场，想问下：能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 34 | train | be-energy | 我队里带了画间沉铁兽，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"term","term_id":"1015"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 35 | train | be-energy | 能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 36 | train | be-energy | 能量和威力是什么关系啊？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 37 | train | be-energy | 能量和威力是什么关系啊？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 38 | train | be-energy | 再确认一下，能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 39 | train | be-energy | 再确认一下，能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 40 | train | be-energy | 我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 41 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 42 | train | be-energy | 我锁定寂灭骨龙，能量和威力是什么关系啊？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 43 | train | be-energy | 我锁定寂灭骨龙，再确认一下，能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 44 | train | be-energy | 我锁定寂灭骨龙，我在练习场，想问下：能量和威力是什么关系？ | `{"stop":true}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 45 | train | be-energy | 我锁定寂灭骨龙，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 46 | train | be-energy | 我队里带了画间沉铁兽，能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 47 | train | be-energy | 我队里带了画间沉铁兽，再确认一下，能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
| 48 | train | be-energy | 我队里带了画间沉铁兽，我在练习场，想问下：能量和威力是什么关系？ | `{"tool":"query_rules","args":{"kind":"ruleset"}}` | 这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。能说的 | — |
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
| 61 | test | cs-diagnose | 这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 62 | test | cs-diagnose | 这套阵容为什么坦度不够呢？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 63 | test | cs-diagnose | 帮我看看这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 64 | test | cs-diagnose | 我在练习场，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 65 | test | cs-diagnose | 我在练习场，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 66 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 67 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 68 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够呢？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 69 | test | cs-diagnose | 我锁定寂灭骨龙，这套阵容为什么坦度不够呢？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 70 | test | cs-diagnose | 我锁定寂灭骨龙，帮我看看这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 71 | test | cs-diagnose | 我锁定寂灭骨龙，我在练习场，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 72 | test | cs-diagnose | 我锁定寂灭骨龙，我在练习场，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 73 | test | cs-diagnose | 我队里带了画间沉铁兽，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 74 | test | cs-diagnose | 我队里带了画间沉铁兽，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 75 | test | cs-diagnose | 我队里带了画间沉铁兽，这套阵容为什么坦度不够呢？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 76 | test | cs-diagnose | 我队里带了画间沉铁兽，帮我看看这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 77 | test | cs-diagnose | 我队里带了画间沉铁兽，我在练习场，这套阵容为什么坦度不够？ | `{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"],"locked_pet":"pet_000225"}}` | 这套阵容按规则特征评估：属性覆盖 0.4545。只能说规则特征差，不 | — |
| 78 | train | rc-swap | 第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 79 | train | rc-swap | 第三只换成圆号鱼好不好啊？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 80 | train | rc-swap | 再确认一下，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 81 | train | rc-swap | 我在练习场，想问下：第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 82 | train | rc-swap | 我锁定寂灭骨龙，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 83 | train | rc-swap | 我锁定寂灭骨龙，第三只换成圆号鱼好不好啊？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 84 | train | rc-swap | 我锁定寂灭骨龙，再确认一下，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 85 | train | rc-swap | 我锁定寂灭骨龙，我在练习场，想问下：第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 86 | train | rc-swap | 我队里带了画间沉铁兽，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 87 | train | rc-swap | 我队里带了画间沉铁兽，第三只换成圆号鱼好不好啊？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 88 | train | rc-swap | 我队里带了画间沉铁兽，再确认一下，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 89 | train | rc-swap | 我队里带了画间沉铁兽，我在练习场，想问下：第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"],"locked_pet":"pet_000225"}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 90 | train | rc-swap | 我队里带了画间沉铁兽，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"]}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 91 | train | rc-swap | 我队里带了画间沉铁兽，第三只换成圆号鱼好不好啊？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"]}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 92 | train | rc-swap | 我队里带了画间沉铁兽，再确认一下，第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"]}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
| 93 | train | rc-swap | 我队里带了画间沉铁兽，我在练习场，想问下：第三只换成圆号鱼好不好？ | `{"tool":"compare_team_change","args":{"team_before":["pet_000225","pet_000190","pet_000445"],"team_after":["pet_000225","pet_000190","pet_000417"]}}` | 我按刚才查到的公开事实回答，没有额外数字可以补充。 | — |
