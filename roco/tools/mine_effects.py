#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mine effect primitives out of the 824 skill descriptions.

这个脚本回答一个问题：**要实现这套规则引擎，到底需要哪些效果原语？**

它的输入只有已经规范化的 JSON（`data/roco/normalized/<ruleset>/`），
不执行任何第三方 Lua / Python，也不写规则数据本身。

三条原则：

1. **原语从文本里挖出来，不靠猜。** 每个原语都带一条正则可复现的 `pattern`，
   并且脚本会打印/记录它在 824 条描述上的命中数。改 pattern 会改结论。
2. **「文本说了」和「术语表定义了」是两件事。** 术语表（`terms.json`）是唯一
   独立证据；只有技能描述、没有术语的原语一律进风险清单。
3. **不确定就写不确定。** 数值量级模糊、取整方向未知、依赖缺失字段的描述
   会被记进 `ambiguities`，不替它选一个解释。

输出（只写这两个文件）：

  roco/effect-inventory.json          机器可读清单（keys 排序，可 diff）
  docs/roco/EFFECT-PRIMITIVES.md      人读文档，按「解锁 A 组配招的能力」排序

用法：

  python3 roco/tools/mine_effects.py
  python3 roco/tools/mine_effects.py --ruleset roco-world-s4-2026-09-10
  python3 roco/tools/mine_effects.py --stdout      # 只打印摘要，不写文件

Python 3.9，标准库。
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import sys

DEFAULT_RULESET = "roco-world-s4-2026-09-10"
CATEGORIES = ("攻击", "状态", "防御", "特性")

# ────────────────────────────────────────────────────────────────────────────
# 1. 原语表
#
# 每条：id / label / family / pattern / terms / related_terms / note
#
#   terms           = terms.json 中**定义**该原语规则的条目 id（可为空 = 风险项）
#   related_terms   = 提到该机制但不定义其规则的条目 id（弱关联，仅作线索）
#   pattern         = 在 desc 上跑的判定；命中即「该技能需要这个原语」
#
# 原语来自对 824 条 desc 的实际统计：先看高频子串（造成物伤 355、
# 应对 148、能耗 97、威力+ 84、连击 76、印记 59…），再看低频但语义独立的分支
# （复活 1、突破能量上限、继承、附加中毒…）。宁可细一点，因为
# 「需要什么原语」是给实现者的清单，「算不算同一类」是后续合并的事。
# ────────────────────────────────────────────────────────────────────────────

PRIMITIVES = [
    # ── 伤害结算 ──────────────────────────────────────────────────────────
    {
        "id": "direct_damage",
        "label": "直接伤害",
        "family": "damage",
        "pattern": r"造成(物伤|魔伤|物理伤害|魔法伤害)|对敌方精灵造成(物理|魔法)伤害",
        "terms": [],
        "related_terms": [],
        "note": "最基础的一条：按面板与相性算一次伤害。伤害公式本身没有官方来源"
                "（pets.json 的 unknown_fields 里明确列着 official_damage_formula）。",
    },
    {
        "id": "multi_hit",
        "label": "多段连击",
        "family": "damage",
        "pattern": r"\d连击",
        "terms": ["3005"],
        "related_terms": [],
        "note": "描述里写死段数（2连击/3连击/5连击）。术语 3005 只定义『连击数』"
                "这个可被修改的量，没有定义每段各自的命中/暴击/相性结算方式。",
    },
    {
        "id": "multi_hit_modifier",
        "label": "连击数修改",
        "family": "damage",
        "pattern": r"连击数",
        "terms": ["3005"],
        "related_terms": [],
        "note": "『连击数+1』『本技能连击数永久+1』。3005 明确『仅对有连击的技能生效』，"
                "因此修改器与 multi_hit 是两个原语。",
    },
    {
        "id": "dynamic_power",
        "label": "结算时动态威力",
        "family": "damage",
        "pattern": r"本次技能威力|本次威力|威力变为|威力翻倍|威力越高|消耗越高|比敌方越高|体重差",
        "terms": [],
        "related_terms": ["1012"],
        "note": "威力在结算时才定：『敌方每有1能量，本次技能威力-10%』"
                "『消耗越高，伤害越高』『速度比敌方越高，本次技能威力越高』。"
                "MICROCASE-PLAN 的 MC-010 就是问它，尚无答案 → fail closed。",
    },
    {
        "id": "power_modifier",
        "label": "技能威力增减",
        "family": "damage",
        "pattern": r"威力[+\-]\d|威力提升|技能威力[+\-]|全技能威力[+\-]|威力永久",
        "terms": [],
        "related_terms": ["1012"],
        "note": "持续性的威力加减（携带技能、系别条件、永久成长都落在这里）。"
                "与 dynamic_power 的 pattern 有意重叠：动态威力在实现上就是"
                "『结算时把威力改掉』，两个原语都要有。",
    },
    {
        "id": "percent_hp_effect",
        "label": "百分比生命结算",
        "family": "damage",
        "pattern": r"\d+%生命",
        "terms": [],
        "related_terms": ["1001", "1002", "1004", "1008"],
        "note": "回复/伤害/消耗都以『X%生命』表述。基数是最大生命还是当前生命、"
                "取整方向，**没有任何术语定义**（MC-011）→ 风险项。",
    },
    {
        "id": "self_hp_cost",
        "label": "自身生命代价",
        "family": "damage",
        "pattern": r"消耗全部生命|消耗\d+%生命|消耗\d+%最大生命|失去\d+%生命|失去自己一半",
        "terms": [],
        "related_terms": [],
        "note": "『使用后消耗全部生命』『消耗5%生命，代替1能量』。力竭判定与"
                "『当前生命低于代价』的先后顺序未定义。",
    },
    {
        "id": "lifesteal",
        "label": "吸血",
        "family": "damage",
        "pattern": r"吸血",
        "terms": ["1029"],
        "related_terms": [],
        "note": "唯一一条给出完整公式形状的机制：『根据吸血比例和造成伤害值，回复生命』。",
    },
    {
        "id": "ignore_resist",
        "label": "无视系别抵抗",
        "family": "damage",
        "pattern": r"无视",
        "terms": [],
        "related_terms": [],
        "note": "『无视敌方系别抵抗』：在相性倍率计算里跳过抵抗侧。"
                "与 types.json 的倍率表直接耦合（双属性相乘还是相加本身也未核验）。",
    },
    {
        "id": "resisted_damage_condition",
        "label": "抵抗伤害条件",
        "family": "damage",
        "pattern": r"抵抗",
        "terms": [],
        "related_terms": [],
        "note": "『每受到1次抵抗的技能攻击（不含连击）』『抵抗自己携带技能系别的攻击伤害』。"
                "需要先有相性判定，才能判断一次伤害是否『被抵抗』。",
    },
    {
        "id": "extra_damage",
        "label": "额外伤害",
        "family": "damage",
        "pattern": r"额外造成",
        "terms": [],
        "related_terms": ["1035"],
        "note": "『下一次攻击时，额外造成100%幻系伤害』。"
                "星陨印记（1035）是同类效果的一个具体载体，但『额外伤害』本身无术语。",
    },
    {
        "id": "counter_damage",
        "label": "受击反伤",
        "family": "damage",
        "pattern": r"对攻击自己的精灵造成",
        "terms": [],
        "related_terms": [],
        "note": "『每受到1次攻击伤害，对攻击自己的精灵造成50威力物理伤害』。"
                "反伤是否吃相性/减伤未定义。",
    },

    # ── 承伤与生存 ────────────────────────────────────────────────────────
    {
        "id": "damage_reduction",
        "label": "减伤",
        "family": "defense",
        "pattern": r"减伤",
        "terms": [],
        "related_terms": ["1016"],
        "note": "A 组六只的配招里几乎每只都有『减伤70%/80%』，但 terms.json "
                "**没有**任何条目定义减伤：与攻击方威力如何相乘、多来源是否相乘、"
                "应对失败时是否仍生效（MC-020 / §5 第 11 条）全部未知 → 最高风险项。",
    },
    {
        "id": "heal",
        "label": "回复生命",
        "family": "defense",
        "pattern": r"回复\d*%?生命|回满.*生命|回复生命|回复等量生命|回复\d+%生命",
        "terms": [],
        "related_terms": ["1029"],
        "note": "『回复X%生命』『回复等量生命』。与 percent_hp_effect 配对使用；"
                "治疗上限、过量回复、回复是否被『无法回复生命』改写都无术语。",
    },
    {
        "id": "overheal_conversion",
        "label": "过量回复转化",
        "family": "defense",
        "pattern": r"过量回复",
        "terms": [],
        "related_terms": [],
        "note": "『每过量回复5%生命转化为10%物攻』：先要定义『过量』。",
    },
    {
        "id": "immunity",
        "label": "免疫与不受影响",
        "family": "defense",
        "pattern": r"免疫|无法对自己造成伤害|不受限制",
        "terms": [],
        "related_terms": ["1001", "1002", "1004", "1008", "3007", "3021", "3022"],
        "note": "『免疫寄生/冻结/灼烧』『免疫此次伤害』。各系别免疫写在对应状态术语的"
                "括号里（『火系精灵免疫此效果』），但『免疫』作为原语没有独立术语。",
    },
    {
        "id": "damage_taken_modifier",
        "label": "受到伤害增减",
        "family": "defense",
        "pattern": r"伤害[-+]\d+%|受到[^。]{0,12}伤害[+\-]|伤害-40%|伤害\+25%",
        "terms": [],
        "related_terms": ["1013"],
        "note": "『受到自己携带技能系别的攻击伤害-40%』：写在特性上的承伤修正。"
                "与 damage_reduction 的区别是它挂在精灵身上而不是技能上。",
    },
    {
        "id": "revive",
        "label": "复活",
        "family": "defense",
        "pattern": r"复活",
        "terms": [],
        "related_terms": [],
        "note": "A 组寂灭骨龙特性『不朽』= 力竭4回合后复活，是本组唯一一条，"
                "但术语表里没有『复活』也没有『力竭』→ MC-014。",
    },
    {
        "id": "hp_ratio_manipulation",
        "label": "生命比例操作",
        "family": "defense",
        "pattern": r"生命比例|血量百分比",
        "terms": [],
        "related_terms": [],
        "note": "『与敌方交换生命比例』『自己的生命比例变为与敌方生命比例相同』。"
                "交换后是否触发力竭判定未定义。",
    },

    # ── 能量 ──────────────────────────────────────────────────────────────
    {
        "id": "energy_gain",
        "label": "获得能量",
        "family": "energy",
        "pattern": r"回复\d*能量|回满能量|获得\d+能量|回复能量|回复等量|每回复1能量",
        "terms": [],
        "related_terms": [],
        "note": "A 组多个 0 能耗技能带『自己回复1能量』。能量上限、回合末回能、"
                "技能自带回能的先后顺序都是 MC-007 的未解问题 → 风险项。",
    },
    {
        "id": "energy_drain",
        "label": "失去/偷取能量",
        "family": "energy",
        "pattern": r"(失去|偷取|扣除)\d*能量|失去能耗之差",
        "terms": [],
        "related_terms": [],
        "note": "『偷取敌方3能量』：偷取＝敌方失去＋自己获得，但描述未写清；"
                "『失去能耗之差的能量』把能耗当差值来源，语义更含混。",
    },
    {
        "id": "energy_spend_all",
        "label": "消耗全部能量",
        "family": "energy",
        "pattern": r"消耗所有能量",
        "terms": [],
        "related_terms": [],
        "note": "『使用时消耗所有能量，消耗越高，伤害越高』（魔能爆）。",
    },
    {
        "id": "energy_cost_modifier",
        "label": "能耗增减",
        "family": "energy",
        "pattern": r"能耗[+\-]|能耗减半|能耗为\d|全技能能耗|本技能能耗|能耗重置",
        "terms": [],
        "related_terms": [],
        "note": "A 组取念『该技能能耗-2』、啮合传递『传动1』都落在这里。"
                "能耗下限/上限、与天气减半的乘法顺序无术语。",
    },
    {
        "id": "energy_cap_change",
        "label": "能量上限变更",
        "family": "energy",
        "pattern": r"能量上限|超过能量上限|突破能量上限",
        "terms": [],
        "related_terms": [],
        "note": "『自己的能量可以超过能量上限』『突破能量上限并立即回复10能量』："
                "上限数值本身在数据里就不存在。",
    },
    {
        "id": "hp_as_energy_substitute",
        "label": "生命代替能量",
        "family": "energy",
        "pattern": r"代替1能量",
        "terms": [],
        "related_terms": [],
        "note": "『能量不足时，消耗5%生命，代替1能量』：能量不足的判定时机未定义。",
    },

    # ── 属性 / 增益减益 ───────────────────────────────────────────────────
    {
        "id": "stat_boost",
        "label": "属性增益",
        "family": "attribute",
        "pattern": r"(双攻|双防|攻防速|攻防|物攻|物防|魔攻|魔防|速度|种族资质)[^，。]{0,3}\+\d",
        "terms": ["3014"],
        "related_terms": ["1012"],
        "note": "3014 明确『属性增益』= 物攻/魔攻/物防/魔防/速度的提升，"
                "但**没有给刻度**：+10% 是加在面板上还是伤害公式里、"
                "多种增益是相加还是相乘，仍然未知。",
    },
    {
        "id": "stat_drop",
        "label": "属性减益",
        "family": "attribute",
        "pattern": r"(双攻|双防|攻防速|攻防|物攻|物防|魔攻|魔防|速度|种族资质)[^，。]{0,3}-\d",
        "terms": ["3018"],
        "related_terms": ["1013"],
        "note": "与 stat_boost 同构，方向相反。3018 同样只定义范围、不给刻度。",
    },
    {
        "id": "buff_layer_modifier",
        "label": "增益/减益层数与固定值修改",
        "family": "attribute",
        "pattern": r"层数[+\-]|层数翻倍|增益翻倍|减益层数|获得\d+层随机|层数固定|层数不受限制|固定为\d",
        "terms": [],
        "related_terms": ["1012", "1013"],
        "note": "『额外获得层数+2』『减益层数+3』『所有精灵连击数固定为2』。"
                "1012/1013 定义了什么叫增益/减益，但没说层数怎么改、上限是多少。",
    },
    {
        "id": "buff_transfer",
        "label": "增益/减益继承与交换",
        "family": "attribute",
        "pattern": r"继承|交换增益|交换.*减益|变为对应的属性减益|复制敌方的增益|若敌方获得增益|转化为相同层数",
        "terms": [],
        "related_terms": ["1012", "1013"],
        "note": "『自己的增益和减益会被更换入场的精灵继承』『与敌方交换增益和减益』"
                "『敌方的属性增益变为对应的属性减益』。继承是否含印记/持续时间未定义。",
    },
    {
        "id": "dispel",
        "label": "驱散",
        "family": "attribute",
        "pattern": r"驱散",
        "terms": [],
        "related_terms": ["1012", "1013", "3010"],
        "note": "A 组音速犬的机制补充技能『焚烧烙印』= 驱散双方所有印记，"
                "因此这条直接卡住 A 组。『驱散X层』在多种增益并存时驱散哪一个，无定义。",
    },

    # ── 状态 ──────────────────────────────────────────────────────────────
    {
        "id": "status_dot",
        "label": "持续伤害状态（中毒/灼烧/寄生）",
        "family": "status",
        "pattern": r"中毒|灼烧|寄生",
        "terms": ["1001", "1002", "1008", "1014", "1036"],
        "related_terms": ["1013"],
        "note": "三种状态的术语都写了『回合结束时造成X%生命伤害』。"
                "灼烧『衰减一半层数』的取整方向是 MC-008。",
    },
    {
        "id": "status_freeze",
        "label": "冻结",
        "family": "status",
        "pattern": r"冻结",
        "terms": ["1004"],
        "related_terms": [],
        "note": "术语 1004 是**即时**结算：『冻结5%生命，若当前生命低于冻结比例，则力竭』，"
                "而技能描述按『层』给（『敌方获得2层冻结』）；层数→伤害的换算未定义。",
    },
    {
        "id": "status_electric_shock",
        "label": "引电",
        "family": "status",
        "pattern": r"引电",
        "terms": ["3022"],
        "related_terms": ["3021", "1013"],
        "note": "『获得2层引电时，立即受到25%生命的电系伤害』。数据里只有 2 条技能用到。",
    },
    {
        "id": "status_dizzy",
        "label": "眩晕",
        "family": "status",
        "pattern": r"眩晕",
        "terms": [],
        "related_terms": [],
        "note": "『自己下回合获得眩晕』『敌方下回合获得眩晕』。"
                "**terms.json 里没有眩晕**，效果与持续完全靠猜 → 风险项。",
    },
    {
        "id": "status_no_escape",
        "label": "禁足",
        "family": "status",
        "pattern": r"禁足",
        "terms": ["3023"],
        "related_terms": [],
        "note": "术语写的是状态本身（无法离场、不可叠加），技能按『3回合』给时长。",
    },
    {
        "id": "status_morph",
        "label": "萌化",
        "family": "status",
        "pattern": r"萌化",
        "terms": ["1006"],
        "related_terms": [],
        "note": "A 组雪影娃娃的主要输出『超级糖果』= 自己获得萌化：本次技能威力+60。"
                "1006 说萌化会『退化到上一阶，种族资质相应降低』，"
                "但退化台阶的资质数据不在 pets.json 里。",
    },
    {
        "id": "status_conceal",
        "label": "隐藏信息状态",
        "family": "status",
        "pattern": r"木桶状态|月陨星状态|伪装|识破",
        "terms": ["3024", "3025"],
        "related_terms": [],
        "note": "木桶/月陨星状态会隐藏精灵信息。这是**信息面**原语，不是数值原语："
                "它直接与 MC-013（隐藏信息不变量）耦合。",
    },
    {
        "id": "status_conversion",
        "label": "状态转化",
        "family": "status",
        "pattern": r"转化为相同层数|变为相同层数的|衰减变为增长|转化为.*中毒|转化为.*印记|变为相同层数",
        "terms": [],
        "related_terms": ["1001", "1002", "1014", "1015"],
        "note": "『将敌方所有增益，转化为相同层数的中毒』『衰减的灼烧变为相同层数的中毒』。"
                "映射关系只给了『相同层数』这一个例子。",
    },

    # ── 行动结构 / 时机 ───────────────────────────────────────────────────
    {
        "id": "priority",
        "label": "先手度",
        "family": "flow",
        "pattern": r"先手",
        "terms": ["1020"],
        "related_terms": [],
        "note": "A 组多只配招含『应对必定先手』。术语给了『先手度可叠加』与"
                "『忽略速度差异』，但刻度与并列裁决仍是 MC-001/MC-004。",
    },
    {
        "id": "swift",
        "label": "迅捷",
        "family": "flow",
        "pattern": r"迅捷",
        "terms": ["1005"],
        "related_terms": [],
        "note": "『通过主动更换精灵的方式入场时，使用第一个能量满足要求、并带有迅捷的技能』。"
                "它把换宠与出招绑在一起，直接影响 MC-005。",
    },
    {
        "id": "charge",
        "label": "蓄力",
        "family": "flow",
        "pattern": r"蓄力",
        "terms": ["1007"],
        "related_terms": [],
        "note": "A 组寂灭骨龙的应对型防御『龙血』含『本技能可以在蓄力状态下使用，"
                "应对攻击：下次技能无需蓄力』→ MC-021。",
    },
    {
        "id": "respond_attack",
        "label": "应对攻击",
        "family": "flow",
        "pattern": r"应对攻击",
        "terms": ["1016"],
        "related_terms": [],
        "note": "A 组六只的『应对型防御』全部命中这一条；1016 一条同时规定三件事"
                "（必定先手、触发应对效果、携带的防御技能进入1回合冷却）→ MC-020。",
    },
    {
        "id": "respond_status",
        "label": "应对状态",
        "family": "flow",
        "pattern": r"应对状态",
        "terms": ["1015"],
        "related_terms": [],
        "note": "命中数最多的一条应对（攻击类技能的『应对状态：威力翻倍』）。",
    },
    {
        "id": "respond_defense",
        "label": "应对防御",
        "family": "flow",
        "pattern": r"应对防御",
        "terms": ["1017"],
        "related_terms": [],
        "note": "要求敌方使用防御技能才成立，因此必须有『敌方本回合用了防御技能』的观察量。",
    },
    {
        "id": "respond_success_trigger",
        "label": "应对成功后的奖励",
        "family": "flow",
        "pattern": r"应对成功后|应对\d次后",
        "terms": [],
        "related_terms": ["1015", "1016", "1017", "1020"],
        "note": "『应对成功后，获得全技能威力永久+30』『攻击技能应对1次后，回满能量和生命，"
                "变为棋绮后』。术语只定义『应对成功』这个条件，**奖励本身无任何术语** → 风险项。",
    },
    {
        "id": "cooldown",
        "label": "冷却",
        "family": "flow",
        "pattern": r"冷却",
        "terms": [],
        "related_terms": ["1016"],
        "note": "『携带的防御技能进入1回合冷却』『该技能冷却1回合』『被应对技能冷却2回合』。"
                "冷却的粒度与是否阻止释放无术语 → 风险项（§5 第 12 条）。",
    },
    {
        "id": "interrupt",
        "label": "打断",
        "family": "flow",
        "pattern": r"打断",
        "terms": ["1011"],
        "related_terms": [],
        "note": "『使敌方本次无法释放对应技能』。需要出手顺序先定型。",
    },
    {
        "id": "burst",
        "label": "迸发",
        "family": "flow",
        "pattern": r"迸发",
        "terms": ["1010"],
        "related_terms": [],
        "note": "『入场后的首次行动，会获得额外效果』，与 extra_trigger 联动"
                "（踏雷会复制『已触发过的迸发效果』）。",
    },
    {
        "id": "marks",
        "label": "印记",
        "family": "flow",
        "pattern": r"印记",
        "terms": ["3010"],
        "related_terms": ["1014", "1018", "1019", "1021", "1022", "1023", "1027",
                          "1028", "1030", "1031", "1032", "1035", "3020", "3012"],
        "note": "术语 3010 只规定**槽位**规则（下场不消失、最多1正1负）；"
                "每个具名印记的数值规则写在自己那条术语里。见 named_mark_variants。",
    },
    {
        "id": "transmission",
        "label": "技能位/传动",
        "family": "flow",
        "pattern": r"传动|号位|两侧技能|技能位置|向下移动\d个位置|跨精灵",
        "terms": ["1033"],
        "related_terms": [],
        "note": "A 组黑猫巫师/圆号鱼/雪影娃娃的机制补充技能『啮合传递』就是"
                "『位于1号或3号位时额外获得物攻+80%，传动1』。",
    },
    {
        "id": "choice",
        "label": "选择（明/暗）",
        "family": "flow",
        "pattern": r"选择",
        "terms": ["3019"],
        "related_terms": [],
        "note": "1019 说『可以从2个效果中选择1个使用』并明确『分别记为明和暗』。"
                "选择发生在选招时还是结算时未定义。",
    },
    {
        "id": "devotion",
        "label": "奉献",
        "family": "flow",
        "pattern": r"奉献",
        "terms": ["1009"],
        "related_terms": [],
        "note": "『使己方队伍中所有的「啃咬」和「虫群」技能获得奉献对应的强化效果』："
                "需要『队伍共享强化』这一层结构。",
    },
    {
        "id": "weather",
        "label": "天气",
        "family": "flow",
        "pattern": r"天气|雨天|沙暴|暴风雪|雷鸣",
        "terms": ["3006", "3007", "3008", "3021"],
        "related_terms": [],
        "note": "四种天气各有术语。数据里没有『无天气/放晴』的条目，"
                "而存在技能名为『放晴』但描述只写光系威力加成的条目（见 ambiguities）。",
    },
    {
        "id": "skill_transform",
        "label": "巧变/技能变化",
        "family": "flow",
        "pattern": r"巧变|变为指定范围内|随机变成.*技能|变为.*技能|交换携带的技能|变为被应对的技能",
        "terms": ["3011"],
        "related_terms": [],
        "note": "A 组海豹船长的机制补充技能『取念』= 每回合随机变成敌方任意精灵的技能且能耗-2。"
                "3011 定义『用后变回原技能』，但随机池与观测面（是否可见）未定义。",
    },
    {
        "id": "form_change",
        "label": "形态变化",
        "family": "flow",
        "pattern": r"变为棋绮后|变为未完虫",
        "terms": [],
        "related_terms": ["1006"],
        "note": "『回满能量和生命，变为棋绮后』『力竭1回合后会变为未完虫』。"
                "形态对应另一套种族值，但 pets.json 只有单一 stats → 风险项。",
    },
    {
        "id": "switch_leave",
        "label": "离场/脱离/返场",
        "family": "flow",
        "pattern": r"脱离|返场",
        "terms": ["1003", "1024", "1026"],
        "related_terms": ["3009", "1007"],
        "note": "A 组寂灭骨龙『集中』= 应对攻击：自己回合结束返场。"
                "3009 定义『离场』，1003/1024/1026 定义三种离场后果。",
    },
    {
        "id": "switch_trigger",
        "label": "换人/入场触发",
        "family": "timing",
        "pattern": r"离场后|离场时|更换精灵|入场|下场",
        "terms": [],
        "related_terms": ["1010", "3009"],
        "note": "『入场时获得X』『离场后，更换入场的精灵…』。**入场没有术语**："
                "入场时机（换宠后 / 补位后 / 复活后）不同会改变结论 → 风险项。",
    },
    {
        "id": "end_turn_trigger",
        "label": "回合结束触发",
        "family": "timing",
        "pattern": r"回合结束",
        "terms": [],
        "related_terms": ["1001", "1002", "1008", "1021"],
        "note": "『回合结束时，回复3能量』『回合结束时，若自己能量为0则脱离』。"
                "只有三种持续状态术语写了自己的回合末结算，"
                "『回合末效果』的触发排序（MC-012）无术语 → 风险项。",
    },
    {
        "id": "on_field_continuous",
        "label": "在场持续效果",
        "family": "timing",
        "pattern": r"在场时",
        "terms": [],
        "related_terms": [],
        "note": "『在场时，敌方全技能能耗+1』：持续光环，进出场都会改变全局状态。",
    },
    {
        "id": "on_hit_trigger",
        "label": "受击触发",
        "family": "timing",
        "pattern": r"每受到1次",
        "terms": [],
        "related_terms": [],
        "note": "『每受到1次技能攻击（不含连击），敌方获得1层棘刺印记』。"
                "合计伤害与逐次命中是两个不同的计时点，描述里的『不含连击』正说明这一点。",
    },
    {
        "id": "first_action_bonus",
        "label": "首次行动奖励",
        "family": "timing",
        "pattern": r"入场后的首次|本场战斗首次|首次入场|首次使用",
        "terms": ["1010"],
        "related_terms": [],
        "note": "A 组音速犬特性『专注力』= 入场首回合获得物攻+100%，但没写哪一句是那个特性。"
                "1010 定义了『入场后的首次行动』＝迸发的挂载点。",
    },
    {
        "id": "extra_trigger",
        "label": "额外触发/额外使用",
        "family": "timing",
        "pattern": r"额外触发|额外使用|使用次数\+1|额外获得|会额外|额外获得三个",
        "terms": [],
        "related_terms": ["1010"],
        "note": "『双方回合结束时的效果会额外触发1次』『会额外使用1次相同的「选择」效果』。"
                "额外触发的结算插入点无术语。",
    },
    {
        "id": "random_effect",
        "label": "随机化",
        "family": "timing",
        "pattern": r"随机",
        "terms": [],
        "related_terms": ["3011"],
        "note": "『随机奉献』『随机5层属性减益』『随机分配给场下的精灵』。"
                "随机池、权重、以及随机数是否进入教练观察面（MC-013）都未定义 → 风险项。",
    },
    {
        "id": "team_scope_effect",
        "label": "队伍级效果",
        "family": "timing",
        "pattern": r"己方队伍|双方队伍|队伍中每有|双方场上|场下|场上的己方精灵",
        "terms": [],
        "related_terms": ["1009"],
        "note": "『己方队伍获得1次随机奉献』『为场下每个精灵回复3能量』。"
                "需要『队伍』这一层状态容器，而当前数据只描述单只精灵。",
    },
    {
        "id": "mana_point",
        "label": "魔力点",
        "family": "timing",
        "pattern": r"魔力",
        "terms": [],
        "related_terms": [],
        "note": "『少损失1点魔力』『力竭时扣除4魔力』。术语表里没有魔力，"
                "数据里也没有魔力上限字段 → 风险项。",
    },
    {
        "id": "ko_count_scaling",
        "label": "力竭状态与计数",
        "family": "timing",
        "pattern": r"力竭",
        "terms": [],
        "related_terms": [],
        "note": "『己方队伍中每有1只力竭的精灵』『力竭4回合后复活』。"
                "『力竭』没有术语，也没有『力竭后是否还能被替换』的定义 → 风险项（MC-006）。",
    },
    {
        "id": "grant_skill_effect",
        "label": "赋予技能效果",
        "family": "timing",
        "pattern": r"技能的效果|获得「.*」技能",
        "terms": [],
        "related_terms": [],
        "note": "A 组圆号鱼特性『泛音列』= 使用状态技能后，敌方获得「聒噪」技能的效果，"
                "持续3回合。『获得某个技能的效果』指向什么、如何结算完全没有定义 → 风险项。",
    },
]

# ────────────────────────────────────────────────────────────────────────────
# 2. 不确定项（ambiguity）规则
#
# 命中即把该技能记进 ambiguities：**不替它选一个解释**。
# ────────────────────────────────────────────────────────────────────────────

AMBIGUITY_RULES = [
    {
        "id": "AMB-REDUCTION-SCOPE",
        "pattern": r"减伤\d+%",
        "reason": "减伤与攻击方威力的合成方式、多来源是否叠乘都没有术语定义；"
                  "更关键的是『减伤X%，应对攻击』在应对**失败**时减伤是否仍生效（§5 第 11 条）。",
    },
    {
        "id": "AMB-PERCENT-HP",
        "pattern": r"\d+%生命",
        "reason": "『X%生命』的最大/当前生命基数与取整方向无定义（MC-011）。",
    },
    {
        "id": "AMB-BURN-HALVE",
        "pattern": r"衰减一半层数|衰减变为增长|衰减的灼烧",
        "reason": "『衰减一半层数』在奇数层的取整方向无定义（MC-008）。",
    },
    {
        "id": "AMB-VAGUE-MAGNITUDE",
        "pattern": r"高额|大幅|消耗越高|威力越高|比敌方越高|体重差越大|所有可能",
        "reason": "量级只用『高额/大幅/越高』描述，没有可实现的数值或函数形状。",
    },
    {
        "id": "AMB-WEIGHT",
        "pattern": r"体重",
        "reason": "以『体重』为自变量，但 pets.json 没有任何体重字段，当前数据无法实现。",
    },
    {
        "id": "AMB-DIZZY",
        "pattern": r"眩晕",
        "reason": "『眩晕』在 terms.json 中没有任何条目，持续回合与具体效果未定义。",
    },
    {
        "id": "AMB-COOLDOWN",
        "pattern": r"冷却\d*回合",
        "reason": "冷却作用在单个技能位还是全部防御技能、是否阻止释放，无术语定义（§5 第 12 条）。",
    },
    {
        "id": "AMB-DISPEL-COUNT",
        "pattern": r"驱散",
        "reason": "『驱散X层』在多种增益/印记并存时的选择顺序无定义。",
    },
    {
        "id": "AMB-RANDOM",
        "pattern": r"随机",
        "reason": "随机池与权重未定义，且随机结果是否进入教练观察面未定义（MC-013）。",
    },
    {
        "id": "AMB-ENERGY-CAP",
        "pattern": r"能量上限|超过能量上限",
        "reason": "能量上限的数值与突破规则在数据与术语里都不存在。",
    },
    {
        "id": "AMB-CONVERSION",
        "pattern": r"转化为相同层数|变为相同层数|变为相同层数的",
        "reason": "转化映射只给了『相同层数』这一个关系，其他种类未定义。",
    },
    {
        "id": "AMB-INHERIT",
        "pattern": r"继承",
        "reason": "『继承』是否包含印记、层数与持续时间未定义。",
    },
    {
        "id": "AMB-RESPOND-FAIL",
        "pattern": r"应对(攻击|状态|防御)(?!：)",
        "reason": "术语只定义『应对成功』；失败时描述里无条件写的效果是否生效未定义（§5 第 11 条）。",
    },
    {
        "id": "AMB-SKILL-EFFECT-GRANT",
        "pattern": r"技能的效果",
        "reason": "『获得「X」技能的效果』具体指向哪个效果不明确。",
    },
    {
        "id": "AMB-WEATHER-CLEAR",
        "pattern": r"放晴|光系技能威力永久\+50%",
        "reason": "技能名『放晴』暗示改变天气，但描述只写光系威力；是否清空天气无法从文本判定。",
    },
    {
        "id": "AMB-DURATION-VS-LAYER",
        "pattern": r"持续\d回合|\d回合禁足|下回合获得",
        "reason": "同一份数据里层数与回合两种计量混用，二者的换算规则未定义。",
    },
    {
        "id": "AMB-OVERHEAL",
        "pattern": r"过量回复",
        "reason": "『过量回复』的定义（超出上限的部分）无术语条目。",
    },
]

PROSE_ONLY_NO_TERM_NOTE = (
    "技能文本描述了行为，但 terms.json 中没有任何一条术语定义它的规则。"
    "按 MICROCASE-PLAN §5 的口径，这些必须在引擎里 fail closed，"
    "不得退化成自创默认值。"
)

# ────────────────────────────────────────────────────────────────────────────
# 3. 数据加载
# ────────────────────────────────────────────────────────────────────────────


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", ".."))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


class Inputs(object):
    """脚本需要的一切输入。skills 主体复用 roco_env.data 的加载结果。"""

    def __init__(self):
        self.ruleset_id = DEFAULT_RULESET
        self.loader = "unknown"
        self.source_revision = ""
        self.skills = []            # list[dict]，字段与 roco_env.data.Skill 对齐
        self.terms = {}             # term_id(str) -> {note, desc}
        self.desc_notes = {}        # skill_id -> {slot: term_id}
        self.learnsets = {}         # pet_id -> set(skill_id)
        self.pets = {}              # pet_id -> {name, group}
        self.a_group_movesets = {}  # pet_id -> {role: skill_id}
        self.files = {}             # filename -> sha256
        self.fallback_warnings = []


def load_inputs(ruleset_id):
    """优先复用 roco_env.data.load_ruleset（它已经做了引用完整性校验），
    只在它不可用时退回直接读 JSON，并记录使用的是哪条路径。"""
    inp = Inputs()
    inp.ruleset_id = ruleset_id
    root = repo_root()
    base = os.path.join(root, "data", "roco", "normalized", ruleset_id)
    if not os.path.isdir(base):
        raise SystemExit("找不到规则集目录：%s" % base)

    raw_skills = read_json(os.path.join(base, "skills.json"))
    raw_learn = read_json(os.path.join(base, "learnsets.json"))
    raw_terms = read_json(os.path.join(base, "terms.json"))
    raw_pets = read_json(os.path.join(base, "pets.json"))

    loaded = None
    src_dir = os.path.join(root, "roco", "src")
    if os.path.isdir(src_dir) and src_dir not in sys.path:
        sys.path.insert(0, src_dir)
    try:
        from roco_env.data import load_ruleset  # type: ignore
        loaded = load_ruleset(ruleset_id, root=root)
        inp.loader = "roco_env.data.load_ruleset"
    except Exception as exc:                                    # pragma: no cover
        inp.fallback_warnings.append(
            "roco_env.data 不可用（%s: %s），退回直接读 normalized JSON"
            % (type(exc).__name__, exc)
        )

    if loaded is not None:
        for sid, s in loaded.skills.items():
            inp.skills.append({
                "skill_id": s.skill_id,
                "name": s.name,
                "category": s.category,
                "element": s.element,
                "energy": s.energy,
                "power": s.power,
                "damage_class": s.damage_class,
                "desc": s.desc,
                "is_trait": s.is_trait,
            })
        for pid, ls in loaded.learnsets.items():
            inp.learnsets[pid] = set(ls.all_skill_ids)
        for tid, t in loaded.terms.items():
            inp.terms[str(tid)] = {"note": t.note, "desc": t.desc}
        inp.source_revision = loaded.source_revision
        inp.files = dict(loaded.files)
    else:
        for sid, s in raw_skills["skills"].items():
            inp.skills.append({
                "skill_id": sid,
                "name": s["name"],
                "category": s.get("category") or "",
                "element": s.get("element") or "",
                "energy": int(s.get("energy") or 0),
                "power": s.get("power"),
                "damage_class": s.get("damage_class"),
                "desc": s.get("desc") or "",
                "is_trait": bool(s.get("is_trait")),
            })
        for pid, ls in raw_learn["learnsets"].items():
            ids = set(e["skill_id"] for e in ls.get("native_skills", []) if e.get("skill_id"))
            ids |= set(e["skill_id"] for e in ls.get("blood_skills", []) if e.get("skill_id"))
            ids |= set(x for x in ls.get("skill_stones", []) if x)
            inp.learnsets[pid] = ids
        for tid, t in raw_terms["terms"].items():
            inp.terms[str(tid)] = {"note": t.get("note") or "", "desc": t.get("desc") or ""}
        inp.source_revision = raw_pets.get("source_revision", "")

    inp.skills.sort(key=lambda s: s["skill_id"])
    inp.desc_notes = {
        sid: dict(s.get("desc_notes") or {})
        for sid, s in raw_skills["skills"].items()
    }

    # 12 只目标精灵：分组来自 pets.json 的 target.group（support-matrix.json 是它的投影）
    sm_path = os.path.join(base, "support-matrix.json")
    sm_groups = {}
    if os.path.isfile(sm_path):
        sm = read_json(sm_path)
        for p in sm.get("pets", []):
            sm_groups[p["pet_id"]] = p.get("group")
            inp.a_group_movesets[p["pet_id"]] = dict(
                (p.get("candidate_moveset") or {}).get("roles_filled") or {}
            )
        inp.files["support-matrix.json"] = sha256_file(sm_path)
    for pid, p in raw_pets["pets"].items():
        target = p.get("target") or {}
        group = target.get("group") or sm_groups.get(pid)
        if sm_groups.get(pid) and target.get("group") and target["group"] != sm_groups[pid]:
            inp.fallback_warnings.append(
                "%s 的分组在 pets.json(%s) 与 support-matrix.json(%s) 不一致，采用 pets.json"
                % (pid, target["group"], sm_groups[pid])
            )
        inp.pets[pid] = {"name": p.get("name") or pid, "group": group}
    for name in ("skills.json", "learnsets.json", "terms.json", "pets.json"):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            inp.files.setdefault(name, sha256_file(path))
    return inp


# ────────────────────────────────────────────────────────────────────────────
# 4. 分类与聚合
# ────────────────────────────────────────────────────────────────────────────


def compile_primitives():
    out = []
    for p in PRIMITIVES:
        q = dict(p)
        q["_re"] = re.compile(p["pattern"])
        out.append(q)
    return out


def compile_ambiguities():
    out = []
    for a in AMBIGUITY_RULES:
        b = dict(a)
        b["_re"] = re.compile(a["pattern"])
        out.append(b)
    return out


def classify(desc, prims):
    return [p["id"] for p in prims if p["_re"].search(desc)]


def find_ambiguities(desc, rules):
    hits = []
    for r in rules:
        m = r["_re"].search(desc)
        if m:
            hits.append({"rule": r["id"], "quote": m.group(0)})
    return hits


def term_reference_index(inp):
    """desc_notes 是来源自带的『这条描述引用了哪些术语』标注，
    比在描述里做子串匹配强得多。两份都算，并分开记。"""
    by_note = collections.Counter()
    for sid, notes in inp.desc_notes.items():
        for _slot, tid in notes.items():
            by_note[str(tid)] += 1
    by_text = collections.Counter()
    for s in inp.skills:
        desc = s["desc"]
        for tid, t in inp.terms.items():
            if t["note"] and t["note"] in desc:
                by_text[tid] += 1
    return by_note, by_text


def build(inp):
    prims = compile_primitives()
    ambs = compile_ambiguities()

    target_ids = set(inp.pets)
    target_skill_union = set()
    for pid in target_ids:
        target_skill_union |= inp.learnsets.get(pid, set())

    a_pets = sorted(pid for pid in inp.pets if inp.pets[pid]["group"] == "A")
    a_moveset_union = set()
    for pid in a_pets:
        a_moveset_union |= set(inp.a_group_movesets.get(pid, {}).values())

    by_note, by_text = term_reference_index(inp)

    cat_of = dict((s["skill_id"], s["category"]) for s in inp.skills)
    skill_by_id = dict((s["skill_id"], s) for s in inp.skills)

    prim_rows = []
    for p in prims:
        hits = [s for s in inp.skills if p["_re"].search(s["desc"])]
        cats = collections.Counter(s["category"] for s in hits)
        in_target = [s["skill_id"] for s in hits if s["skill_id"] in target_skill_union]
        in_a = [s["skill_id"] for s in hits if s["skill_id"] in a_moveset_union]

        # 该原语的技能里，来源标注引用到的术语（机器可得，用于校验人工映射）
        observed = collections.Counter()
        for s in hits:
            for _slot, tid in (inp.desc_notes.get(s["skill_id"]) or {}).items():
                observed[str(tid)] += 1

        def order(s):
            sid = s["skill_id"]
            rank = 0 if sid in a_moveset_union else (1 if sid in target_skill_union else 2)
            return (rank, sid)

        examples = [{
            "skill_id": s["skill_id"],
            "name": s["name"],
            "category": s["category"],
            "element": s["element"],
            "desc": s["desc"],
            "in_target_learnset": s["skill_id"] in target_skill_union,
            "in_a_group_moveset": s["skill_id"] in a_moveset_union,
        } for s in sorted(hits, key=order)[:3]]

        glossary = []
        for tid in p["terms"]:
            t = inp.terms.get(tid)
            if t is None:
                continue
            glossary.append({
                "term_id": tid,
                "note": t["note"],
                "desc": t["desc"],
                "referenced_in_desc_notes": by_note.get(tid, 0),
                "referenced_in_desc_text": by_text.get(tid, 0),
            })

        prim_rows.append({
            "id": p["id"],
            "label": p["label"],
            "family": p["family"],
            "pattern": p["pattern"],
            "note": p["note"],
            "skill_count": len(hits),
            "skills_by_category": dict((c, cats.get(c, 0)) for c in CATEGORIES),
            "target_learnset_skill_count": len(in_target),
            "a_group_moveset_skill_count": len(in_a),
            "glossary_backed": bool(glossary),
            "glossary_terms": glossary,
            "related_term_ids": list(p["related_terms"]),
            "observed_term_ids_in_matched_skills": dict(
                (k, v) for k, v in sorted(observed.items(), key=lambda kv: (-kv[1], kv[0]))
                if v
            ),
            "target_learnset_skills": sorted(in_target),
            "a_group_moveset_skills": sorted(in_a),
            "examples": examples,
            "skill_ids": sorted(s["skill_id"] for s in hits),
        })

    # 有术语文本却没有被任何技能引用的条目（本数据里应当是空集，空也要写出来）
    unreferenced = []
    for tid in sorted(inp.terms, key=lambda x: int(x)):
        if by_note.get(tid, 0) == 0 and by_text.get(tid, 0) == 0:
            unreferenced.append({
                "term_id": tid,
                "note": inp.terms[tid]["note"],
                "desc": inp.terms[tid]["desc"],
            })
    single_ref = []
    for tid in sorted(inp.terms, key=lambda x: int(x)):
        n_note = by_note.get(tid, 0)
        n_text = by_text.get(tid, 0)
        total = max(n_note, n_text)
        if total == 1:
            who = [s["skill_id"] for s in inp.skills
                   if str(tid) in [str(v) for v in (inp.desc_notes.get(s["skill_id"]) or {}).values()]]
            single_ref.append({
                "term_id": tid,
                "note": inp.terms[tid]["note"],
                "desc": inp.terms[tid]["desc"],
                "referenced_in_desc_notes": n_note,
                "referenced_in_desc_text": n_text,
                "only_referenced_by": sorted(who),
            })

    amb_rows = []
    for s in inp.skills:
        hits = find_ambiguities(s["desc"], ambs)
        if hits:
            amb_rows.append({
                "skill_id": s["skill_id"],
                "name": s["name"],
                "category": s["category"],
                "desc": s["desc"],
                "flags": hits,
            })

    ambiguity_summary = collections.Counter()
    for row in amb_rows:
        for f in row["flags"]:
            ambiguity_summary[f["rule"]] += 1
    ambiguity_rules_out = []
    for r in ambs:
        ambiguity_rules_out.append({
            "id": r["id"],
            "pattern": r["pattern"],
            "reason": r["reason"],
            "skill_count": ambiguity_summary.get(r["id"], 0),
        })

    a_movesets_out = []
    for pid in a_pets:
        roles = inp.a_group_movesets.get(pid, {})
        a_movesets_out.append({
            "pet_id": pid,
            "name": inp.pets[pid]["name"],
            "roles_filled": dict(sorted(roles.items())),
            "skills": [
                {
                    "role": role,
                    "skill_id": sid,
                    "name": skill_by_id[sid]["name"] if sid in skill_by_id else "",
                    "category": cat_of.get(sid, ""),
                    "desc": skill_by_id[sid]["desc"] if sid in skill_by_id else "",
                }
                for role, sid in sorted(roles.items())
                if sid in skill_by_id
            ],
        })

    prims_sorted = sorted(
        prim_rows,
        key=lambda r: (-r["a_group_moveset_skill_count"],
                       -r["target_learnset_skill_count"],
                       -r["skill_count"],
                       r["id"]),
    )

    glossary_backed = [r["id"] for r in prims_sorted if r["glossary_backed"]]
    prose_only = [r["id"] for r in prims_sorted if not r["glossary_backed"]]

    named_marks = []
    for tid in sorted(inp.terms, key=lambda x: int(x)):
        if "印记" in inp.terms[tid]["note"]:
            named_marks.append({
                "term_id": tid,
                "note": inp.terms[tid]["note"],
                "desc": inp.terms[tid]["desc"],
                "referenced_in_desc_notes": by_note.get(tid, 0),
                "referenced_in_desc_text": by_text.get(tid, 0),
            })

    empty_desc = [s["skill_id"] for s in inp.skills if not s["desc"].strip()]
    no_terms_annotated = sum(1 for sid in inp.desc_notes if not inp.desc_notes[sid])

    doc = {
        "schema_version": 1,
        "generated_by": "roco/tools/mine_effects.py",
        "ruleset_id": inp.ruleset_id,
        "game": "roco_world_mobile",
        "source_revision": inp.source_revision,
        "loader": inp.loader,
        "input_sha256": dict(sorted(inp.files.items())),
        "method": {
            "unit": "skill description (skills.json .desc)",
            "primitive_is": "一条需要在引擎里独立实现的机制；用正则判定其出现",
            "glossary_backed": "terms.json 中存在定义该原语规则的条目（最强证据等级 A_glossary_text）",
            "prose_only": "只有技能描述、没有术语定义（证据等级 B_description，必须 fail closed）",
            "term_reference_source": "skills.json 的 desc_notes 字段（来源自带的术语引用标注）+ desc 文本子串匹配",
            "no_execution": "只读 JSON；不执行任何 Lua / Python 第三方代码",
        },
        "counts": {
            "skills_total": len(inp.skills),
            "skills_with_empty_desc": len(empty_desc),
            "skills_with_desc_notes": sum(1 for sid in inp.desc_notes if inp.desc_notes[sid]),
            "skills_without_desc_notes": no_terms_annotated,
            "skills_covered_by_at_least_one_primitive": sum(
                1 for s in inp.skills if classify(s["desc"], prims)
            ),
            "categories": dict(collections.Counter(s["category"] for s in inp.skills)),
            "target_pets": len(target_ids),
            "target_learnset_skill_union": len(target_skill_union),
            "a_group_pets": len(a_pets),
            "a_group_candidate_skill_union": len(a_moveset_union),
            "primitives_total": len(prim_rows),
            "primitives_glossary_backed": len(glossary_backed),
            "primitives_prose_only": len(prose_only),
            "glossary_terms_total": len(inp.terms),
            "glossary_terms_unreferenced_by_any_skill": len(unreferenced),
            "glossary_terms_referenced_by_exactly_one_skill": len(single_ref),
            "ambiguous_skills": len(amb_rows),
        },
        "primitives": prims_sorted,
        "primitives_by_family": dict(
            (fam, [r["id"] for r in prims_sorted if r["family"] == fam])
            for fam in sorted(set(r["family"] for r in prims_sorted))
        ),
        "implementation_order": [r["id"] for r in prims_sorted],
        "glossary_backed_primitives": glossary_backed,
        "prose_only_primitives": prose_only,
        "prose_only_note": PROSE_ONLY_NO_TERM_NOTE,
        "glossary": dict(
            (tid, {
                "term_id": tid,
                "note": inp.terms[tid]["note"],
                "desc": inp.terms[tid]["desc"],
                "referenced_in_desc_notes": by_note.get(tid, 0),
                "referenced_in_desc_text": by_text.get(tid, 0),
            })
            for tid in sorted(inp.terms, key=lambda x: int(x))
        ),
        "glossary_terms_unreferenced_by_any_skill": unreferenced,
        "glossary_terms_referenced_by_exactly_one_skill": single_ref,
        "named_mark_variants": named_marks,
        "a_group_candidate_movesets": a_movesets_out,
        "ambiguity_rules": ambiguity_rules_out,
        "ambiguous_skills": amb_rows,
        "data_gaps": [
            "pets.json 没有体重字段，但存在以『体重』为自变量的技能描述",
            "pets.json 没有性格/天分/等级换算字段（unknown_fields 里已登记）",
            "pets.json 只有单一 stats，没有形态/退化对应的另一套种族值",
            "terms.json 没有『减伤』『回复生命』『能量』『冷却』『眩晕』『力竭』『魔力』"
            "『入场』『回合结束』等原语的条目",
            "terms.json 的 id 有断号（1000/1025/1034、3000-3004/3016/3017 不存在），"
            "说明导入时做过筛选，未导入条目的存在性未知",
        ],
        "warnings": list(inp.fallback_warnings),
    }
    return doc


# ────────────────────────────────────────────────────────────────────────────
# 5. 人读文档
# ────────────────────────────────────────────────────────────────────────────

FAMILY_LABEL = {
    "damage": "伤害结算",
    "defense": "承伤与生存",
    "energy": "能量",
    "attribute": "属性与增益减益",
    "status": "状态",
    "flow": "行动结构与流程原语",
    "timing": "触发时机与全局状态",
}


def md_escape(text):
    return (text or "").replace("|", "\\|").replace("\n", " ")


def render_markdown(doc):
    L = []
    add = L.append
    c = doc["counts"]
    add("# 效果原语清单（EFFECT PRIMITIVES）")
    add("")
    add("> 本文件由 `roco/tools/mine_effects.py` 生成，**不要手工编辑**。")
    add("> 机器可读版本：`roco/effect-inventory.json`。")
    add("> 本轮**没有实现任何原语**，`skills.json` 里 824 条技能的 `effect_support` 仍全部是 `unsupported`；")
    add("> 本清单回答的是「要实现它们，需要哪些原语、按什么顺序」，不是「已经实现」。")
    add("")
    add("| 项 | 值 |")
    add("|---|---|")
    add("| ruleset_id | `%s` |" % doc["ruleset_id"])
    add("| 数据装载方式 | `%s` |" % doc["loader"])
    add("| source_revision | `%s` |" % doc["source_revision"])
    add("| 技能总数 | %d |" % c["skills_total"])
    add("| 至少命中一个原语的技能 | %d |" % c["skills_covered_by_at_least_one_primitive"])
    add("| 出现的效果原语 | %d |" % c["primitives_total"])
    add("| 有术语表条目定义的原语 | %d |" % c["primitives_glossary_backed"])
    add("| **只有技能描述、没有术语定义的原语** | **%d** |" % c["primitives_prose_only"])
    add("| 术语表条目总数 | %d |" % c["glossary_terms_total"])
    add("| 术语表中没有任何技能引用的条目 | %d |" % c["glossary_terms_unreferenced_by_any_skill"])
    add("| 目标精灵（12 只）学习表技能并集 | %d |" % c["target_learnset_skill_union"])
    add("| A 组（6 只）候选配招技能并集 | %d |" % c["a_group_candidate_skill_union"])
    add("| 被标为「文本不确定」的技能 | %d |" % c["ambiguous_skills"])
    add("")

    add("## 0. 怎么读这份清单")
    add("")
    add("三条口径，先说清楚：")
    add("")
    add("1. **一个原语 = 一件必须在引擎里独立实现的事。** 判定方式是一条写在脚本里的正则，")
    add("   对 824 条 `desc` 逐条匹配；改正则就会改结论，所以正则原文也放进 JSON 了。")
    add("2. **「有术语」与「没术语」是本清单最重要的分栏。** 术语表（`terms.json`）是唯一")
    add("   独立于技能描述的文本证据；只有技能描述的原语，等于「我们只知道策划这么写了」。")
    add("3. **优先级 = 能解锁多少 A 组候选配招。** A 组六只的 4 技能候选配招是第一条可玩")
    add("   垂直切片，`A组技能数` 就是「实现这个原语能让几个已选定技能变得可模拟」。")
    add("")
    add("优先级排序键：`A组技能数` ↓ → `12只学习表技能数` ↓ → `技能总数` ↓ → `id` ↑。")
    add("")

    add("## 1. 按实现顺序排列的原语总表")
    add("")
    add("| # | 原语 | 族 | A组配招 | 12只学习表 | 技能总数 | 分类分布（攻/状/防/特） | 术语表 |")
    add("|---:|---|---|---:|---:|---:|---|---|")
    for i, r in enumerate(doc["primitives"], 1):
        cats = r["skills_by_category"]
        dist = "%d/%d/%d/%d" % (cats.get("攻击", 0), cats.get("状态", 0),
                                cats.get("防御", 0), cats.get("特性", 0))
        terms = "、".join("%s %s" % (g["term_id"], g["note"]) for g in r["glossary_terms"])
        add("| %d | `%s` %s | %s | %d | %d | %d | %s | %s |" % (
            i, r["id"], md_escape(r["label"]), FAMILY_LABEL.get(r["family"], r["family"]),
            r["a_group_moveset_skill_count"], r["target_learnset_skill_count"],
            r["skill_count"], dist, terms if terms else "—"))
    add("")
    add("> `术语表 = —` 的行就是风险项：技能文本描述了行为，但没有任何一条术语定义它的规则。")
    add("")

    add("## 2. A 组候选配招（优先级信号来源）")
    add("")
    add("这 19 个技能是 `data/roco/normalized/.../support-matrix.json` 里 A 组六只各自")
    add("`candidate_moveset.roles_filled` 的并集。它们**不是**最优解，只是本轮已选定的切片。")
    add("")
    for pet in doc["a_group_candidate_movesets"]:
        skills = "、".join("%s（%s）" % (s["name"], s["role"]) for s in pet["skills"])
        add("- **%s**（`%s`）：%s" % (pet["name"], pet["pet_id"], skills))
    add("")
    add("按这些技能反推，A 组第一个可玩切片**必须**实现的原子集是：")
    add("")
    musts = [r for r in doc["primitives"] if r["a_group_moveset_skill_count"] > 0]
    add("```text")
    for r in musts:
        add("%-32s A组技能 %d / 12只 %d / 全部 %d%s" % (
            r["id"], r["a_group_moveset_skill_count"], r["target_learnset_skill_count"],
            r["skill_count"], "" if r["glossary_backed"] else "   ← 无术语定义"))
    add("```")
    add("")

    add("## 3. 原语明细（按族）")
    add("")
    for fam in ["damage", "defense", "energy", "attribute", "status", "flow", "timing"]:
        rows = [r for r in doc["primitives"] if r["family"] == fam]
        if not rows:
            continue
        add("### 3.%d %s" % (["damage", "defense", "energy", "attribute",
                              "status", "flow", "timing"].index(fam) + 1,
                             FAMILY_LABEL.get(fam, fam)))
        add("")
        for r in rows:
            cats = r["skills_by_category"]
            add("#### `%s` %s" % (r["id"], r["label"]))
            add("")
            add("- 命中：**%d** 条技能（攻击 %d / 状态 %d / 防御 %d / 特性 %d）"
                % (r["skill_count"], cats.get("攻击", 0), cats.get("状态", 0),
                   cats.get("防御", 0), cats.get("特性", 0)))
            add("- 12 只目标精灵学习表：**%d** 条；A 组候选配招：**%d** 条"
                % (r["target_learnset_skill_count"], r["a_group_moveset_skill_count"]))
            add("- 判定正则：`%s`" % r["pattern"].replace("|", "\\|"))
            if r["glossary_terms"]:
                add("- 术语表证据：" + "；".join(
                    "[`%s`] %s —— %s" % (g["term_id"], g["note"], g["desc"])
                    for g in r["glossary_terms"]))
            else:
                add("- 术语表证据：**无**。技能文本描述了行为，但没有任何术语定义它的规则。")
            if r["related_term_ids"]:
                add("- 相关但不定义的术语：" + "、".join(r["related_term_ids"]))
            add("- 说明：%s" % r["note"])
            if r["examples"]:
                add("- 例子：")
                for e in r["examples"]:
                    tag = []
                    if e["in_a_group_moveset"]:
                        tag.append("A组配招")
                    elif e["in_target_learnset"]:
                        tag.append("12只学习表")
                    add("    - `%s` %s（%s%s）：「%s」" % (
                        e["skill_id"], e["name"], e["category"],
                        ("，" + "/".join(tag)) if tag else "", e["desc"]))
            add("")

    add("## 4. 风险清单 A：技能描述了行为，但没有任何术语定义它")
    add("")
    add("证据等级只有 `B_description`。按 MICROCASE-PLAN §5，这些原语在引擎里必须 **fail closed**，")
    add("不得退化成自创默认值。按 A 组解锁能力排序：")
    add("")
    add("| # | 原语 | A组配招 | 12只学习表 | 技能总数 | 为什么危险 |")
    add("|---:|---|---:|---:|---:|---|")
    prose = [r for r in doc["primitives"] if not r["glossary_backed"]]
    for i, r in enumerate(prose, 1):
        add("| %d | `%s` %s | %d | %d | %d | %s |" % (
            i, r["id"], md_escape(r["label"]), r["a_group_moveset_skill_count"],
            r["target_learnset_skill_count"], r["skill_count"], md_escape(r["note"])))
    add("")
    add("> 结构性结论：术语表覆盖的是**名词与流程**（状态、印记、天气、应对、蓄力、传动、触发条件），")
    add("> 而**数值原语**（减伤、回复、能量、属性刻度、取整）几乎没有条目。")
    add("> 也就是说，最容易写的部分（加减血）恰恰是最没有独立证据的部分。")
    add("")

    add("## 5. 风险清单 B：术语表里没有任何技能引用的条目")
    add("")
    unref = doc["glossary_terms_unreferenced_by_any_skill"]
    if not unref:
        add("**本轮结论：没有。** 54 条术语全部至少被一条技能的 `desc_notes` 引用，")
        add("没有发现「定义了但没人用」的死机制。")
        add("")
        add("需要说明两点，避免把这个结论读得过强：")
        add("")
        add("1. **引用 ≠ 被实现。** 被引用只说明文本层面出现了这个机制，")
        add("   不代表它的结算规则已经确定（见第 4 节）。")
        add("2. 有 **%d** 条技能没有任何 `desc_notes` 标注，`terms.json` 的 id 也有断号"
            % c["skills_without_desc_notes"])
        add("   （1000/1025/1034、3000–3004/3016/3017 不存在），")
        add("   所以「没有未引用条目」是**在当前这份规范化数据里**的结论，不是对原始语料的结论。")
        add("")
        add("作为替代信号，下面列出**只被一条技能引用**的术语（单点依赖，最可能是过度拟合或孤例），")
        add("它们是「可能已死机制」的最近似候选：")
        add("")
        add("| 术语 | 名称 | 只用它的技能 | 定义 |")
        add("|---|---|---|---|")
        for t in doc["glossary_terms_referenced_by_exactly_one_skill"]:
            add("| `%s` | %s | %s | %s |" % (
                t["term_id"], md_escape(t["note"]),
                "、".join(t["only_referenced_by"]) if t["only_referenced_by"] else "—",
                md_escape(t["desc"])))
    else:
        add("| 术语 | 名称 | 定义 |")
        add("|---|---|---|")
        for t in unref:
            add("| `%s` | %s | %s |" % (t["term_id"], md_escape(t["note"]), md_escape(t["desc"])))
    add("")

    add("## 6. 风险清单 C：文本本身不确定的地方（不替它选解释）")
    add("")
    add("这些不是「原语没实现」，而是「文本不足以确定一个实现」。")
    add("命中即记录，不推断。")
    add("")
    add("| 规则 | 命中技能数 | 为什么不确定 |")
    add("|---|---:|---|")
    for r in doc["ambiguity_rules"]:
        add("| `%s` | %d | %s |" % (r["id"], r["skill_count"], md_escape(r["reason"])))
    add("")
    add("逐条原文（前若干条，完整清单见 JSON 的 `ambiguous_skills`）：")
    add("")
    shown = 0
    for row in doc["ambiguous_skills"]:
        if shown >= 12:
            break
        flags = "、".join("%s「%s」" % (f["rule"], f["quote"]) for f in row["flags"])
        add("- `%s` %s（%s）：「%s」 → %s" % (
            row["skill_id"], row["name"], row["category"], row["desc"], flags))
        shown += 1
    add("")
    add("> 完整清单共 %d 条技能，见 `roco/effect-inventory.json` 的 `ambiguous_skills`。"
        % len(doc["ambiguous_skills"]))
    add("")

    add("## 7. 具名印记变体（`marks` 的具体内容）")
    add("")
    add("术语 3010 只定义印记的**槽位规则**（下场不消失、最多 1 正 1 负）。")
    add("每个具名印记是一套独立数值规则，实现 `marks` 时必须逐条建表：")
    add("")
    add("| 术语 | 印记 | 定义 | 被技能引用 |")
    add("|---|---|---|---:|")
    for t in doc["named_mark_variants"]:
        add("| `%s` | %s | %s | %d |" % (
            t["term_id"], md_escape(t["note"]), md_escape(t["desc"]),
            max(t["referenced_in_desc_notes"], t["referenced_in_desc_text"])))
    add("")

    add("## 8. 已知数据缺口")
    add("")
    for g in doc["data_gaps"]:
        add("- %s" % g)
    add("")

    add("## 9. 复现")
    add("")
    add("```bash")
    add("python3 roco/tools/mine_effects.py")
    add("")
    add("# 只打印摘要，不写文件")
    add("python3 roco/tools/mine_effects.py --stdout")
    add("```")
    add("")
    add("输入文件的 SHA256（写进 JSON 的 `input_sha256`）：")
    add("")
    add("| 文件 | sha256 |")
    add("|---|---|")
    for name, digest in sorted(doc["input_sha256"].items()):
        add("| `%s` | `%s` |" % (name, digest))
    add("")
    add("> 只读 `data/roco/normalized/**` 下的 JSON；不执行任何 Lua 或第三方 Python；")
    add("> 不修改 `roco/src/roco_env/`。")
    add("")
    return "\n".join(L) + "\n"


# ────────────────────────────────────────────────────────────────────────────
# 6. main
# ────────────────────────────────────────────────────────────────────────────


def main(argv=None):
    ap = argparse.ArgumentParser(description="挖掘技能描述里的效果原语")
    ap.add_argument("--ruleset", default=DEFAULT_RULESET)
    ap.add_argument("--stdout", action="store_true", help="只打印摘要，不写文件")
    args = ap.parse_args(argv)

    inp = load_inputs(args.ruleset)
    doc = build(inp)
    md = render_markdown(doc)

    root = repo_root()
    json_path = os.path.join(root, "roco", "effect-inventory.json")
    md_path = os.path.join(root, "docs", "roco", "EFFECT-PRIMITIVES.md")

    if not args.stdout:
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        with open(md_path, "w", encoding="utf-8") as fh:
            fh.write(md)

    c = doc["counts"]
    print("loader            : %s" % doc["loader"])
    print("skills            : %d（至少命中一个原语 %d）"
          % (c["skills_total"], c["skills_covered_by_at_least_one_primitive"]))
    print("primitives        : %d（有术语 %d / 仅描述 %d）"
          % (c["primitives_total"], c["primitives_glossary_backed"], c["primitives_prose_only"]))
    print("glossary terms    : %d（无技能引用 %d / 仅一条技能引用 %d）"
          % (c["glossary_terms_total"], c["glossary_terms_unreferenced_by_any_skill"],
             c["glossary_terms_referenced_by_exactly_one_skill"]))
    print("A group skills    : %d / target learnset union %d"
          % (c["a_group_candidate_skill_union"], c["target_learnset_skill_union"]))
    print("ambiguous skills  : %d" % c["ambiguous_skills"])
    print("")
    print("Top 12 by A-group coverage:")
    for r in doc["primitives"][:12]:
        print("  %-30s A=%-3d target=%-4d all=%-4d glossary=%s" % (
            r["id"], r["a_group_moveset_skill_count"], r["target_learnset_skill_count"],
            r["skill_count"], "yes" if r["glossary_backed"] else "NO"))
    for w in doc["warnings"]:
        print("WARN: %s" % w)
    if not args.stdout:
        print("")
        print("wrote %s" % os.path.relpath(json_path, root))
        print("wrote %s" % os.path.relpath(md_path, root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
