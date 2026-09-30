"""RC-401/403：**效果覆盖台账**——把「哪些机制真的能模拟」变成机器可读的事实。

为什么要单独一层
----------------
`skills.json` 里 824 条记录的 `effect_support` 一律写着 `unsupported`（导入期的保守标注），
它回答不了「引擎现在到底能跑多少」。而「按覆盖收益增量迁移效果原语」（RC-401 的施工口径）
需要的是：**每一个未实现的原语，会解锁多少条精灵/技能**。

所以这里做的是一件很窄的事：
  · 拿 `parse.parse_skill` 逐条跑**战斗技能**，按能否机械读出效果分成四档；
  · 拿 `traits.TRAITS` 的登记状态把**特性**分成四档（没登记的就是「只有资料」）；
  · 把「解析不出来」的原因**按频次排序**——那就是下一步该实现哪个原语的依据。

四档沿用 RC-403 的支持等级词汇：
  · `SIMULATABLE_UNVERIFIED`：描述被完整读出（或有明确效果）且引擎真的会结算；
  · `PARTIAL`：读出了一部分，但还有没认领的机制片段（引擎**不做部分应用**，如实登记）；
  · `KNOWLEDGE_ONLY`：只有文字资料，引擎不会结算；
  · `REFUSED`：明确拒绝实现（缺少一手证据，见 `traits.py` 里的理由）。

**它不判断机制对不对**（那要靠实机 microcase），只回答「我们现在站在哪里」。
"""

from __future__ import annotations

import collections
import re as _re
import json
import os
from typing import Any, Dict, List, Optional

from . import parse as parse_mod
from . import traits as traits_mod

#: RC-403 的支持等级词汇（与产物/接口里用的是同一套字符串）。
SUPPORT_FULL_VERIFIED = "FULL_VERIFIED"
SUPPORT_SIMULATABLE_UNVERIFIED = "SIMULATABLE_UNVERIFIED"
SUPPORT_PARTIAL = "PARTIAL"
SUPPORT_KNOWLEDGE_ONLY = "KNOWLEDGE_ONLY"
SUPPORT_REFUSED = "REFUSED"

#: 特性登记状态 → 支持等级（`traits.py` 用的是 FULL/PARTIAL/REFUSED）。
TRAIT_STATUS_TO_SUPPORT = {
    "FULL": SUPPORT_FULL_VERIFIED,
    "PARTIAL": SUPPORT_PARTIAL,
    "REFUSED": SUPPORT_REFUSED,
}


def resolve_claims(skill: Any, capabilities: Optional[Dict[str, bool]] = None,
                   parsed: Any = None) -> "tuple[Any, List[str]]":
    """按**能力声明**把各条 `resolve_*` 串成一条认领链，返回 `(parsed, claimed)`。

    为什么抽出来（第 42 轮）：判据里要独立复核"可模拟的技能是不是真的没有未认领片段"，
    而**认领链的顺序是有意义的**（每个 `resolve_*` 都就地摘标记，重新 `parse_skill` 会把标记装回去）。
    让判据自己抄一遍这条链，迟早会漂 —— 所以它是**唯一实现**，`classify_skill` 与判据都调它。
    """
    caps = dict(capabilities or {})
    parsed = parsed if parsed is not None else parse_mod.parse_skill(skill)
    claimed: List[str] = []
    if not caps.get("foe_energy_loss", False):
        parsed = parse_mod.resolve_foe_energy_loss(skill, declared=False, parsed=parsed)
    if caps.get("slot_condition") or caps.get("position_shift"):
        parsed = parse_mod.resolve_position_mechanics(
            skill, slot_declared=bool(caps.get("slot_condition")),
            shift_declared=bool(caps.get("position_shift")), parsed=parsed)
        if caps.get("slot_condition") and parsed.slot_conditions:
            claimed.append("号位条件")
        if caps.get("position_shift") and parsed.position_shift is not None:
            claimed.append(f"传动×{parsed.position_shift}")
    if caps.get("initiative_condition") and getattr(parsed, "initiative_power", None):
        parsed = parse_mod.resolve_initiative_condition(skill, declared=True, parsed=parsed)
        claimed.append(_initiative_claim_label(parsed))
    if caps.get("foe_switch_condition") and getattr(parsed, "foe_switch_effects", None) \
            and not getattr(parsed, "foe_switch_leftover", ""):
        parsed = parse_mod.resolve_foe_switch_condition(skill, declared=True, parsed=parsed)
        claimed.append("对手换人条件")
    if caps.get("per_use_ramp") and getattr(parsed, "per_use_ramp", None):
        parsed = parse_mod.resolve_per_use_ramp(skill, declared=True, parsed=parsed)
        claimed.append(f"每次使用后永久{int(parsed.per_use_ramp['delta']):+d}")
    if caps.get("on_hit_ramp") and getattr(parsed, "on_hit_ramp", None):
        parsed = parse_mod.resolve_on_hit_ramp(skill, declared=True, parsed=parsed)
        claimed.append(f"挨打永久{int(parsed.on_hit_ramp['delta']):+d}")
    if caps.get("per_layer_cost") and getattr(parsed, "per_layer_cost", None):
        parsed = parse_mod.resolve_per_layer_cost(skill, declared=True, parsed=parsed)
        claimed.append(f"动态能耗修正（每 {int(parsed.per_layer_cost['layer_step'])} 层 "
                       f"{int(parsed.per_layer_cost['delta'])} 能量）")
    if caps.get("multi_hit"):
        # 2026-09-30（按只读诊断的读数改，替换"自己摘标记"那版）：**跑 env 跑的那同一个
        # resolver**。`parse.resolve_hit_count(declared=True)` 对 N=1 也会补一条带出处的
        # `hit_count` effect（`evidence='1连击'`，见 `parse.py:1758-1766`，task-20 批二），
        # 于是 `unclaimed_mechanic_spans` 的**证据尺子**自然把「1连击」那一段算作已认领
        # —— 不必再手抄第二份词表（手抄的都会漂：判据侧那份就还写着 `hit_count > 1`）。
        # 运行时依据（实测）：V3 下真打一手，这四条技能的 `state.unsupported` 里
        # 「连击」相关行数为 0；legacy（`damage_multi_hit=False`）同样一手写 2 条，
        # 其中一条逐字是「连击：1连击」⇒ 这道闸真实且双向。
        # 动态连击标记（「改为3连击」那类）照旧留着：`resolve_hit_count` 自己不动它。
        _hits, parsed = parse_mod.resolve_hit_count(skill, declared=True, parsed=parsed)
        if _hits:
            claimed.append(f"连击×{_hits}")
    # 2026-09-30（协作链对齐）：**扩展族也必须在这条链里认领** ——
    # `resolve_claims` 的 docstring 写着它是「唯一实现，`classify_skill` 与判据都调它」，
    # 而 `test_effect_coverage:534-578` 正是拿**它的**输出去算 `residual_mechanic_spans`，
    # 并要求「台账判了可模拟的行，残余片段必须为空」。只在 `_apply_capability_resolvers`
    # 里认领（不进这条链）⇒ 判据那条路看不到认领 ⇒ skill_000252 这类行被误报成
    # 「可模拟却还有残余片段」。所以扩展族接在九步之后，**同一条链、同一份证据尺子**。
    parsed, _family_claimed = _apply_capability_resolvers(skill, caps, parsed)
    claimed.extend(_family_claimed)
    # 2026-09-30（按逐行审计修第二处**假阴性**）：号位/传动的**认领 effect 要在链尾补一次**。
    # 中间任一族 resolver 会重建 `effects`，把先前那条 claim effect 冲掉 —— 实测
    # `483 啮合传递`「本技能位于1号或3号位时额外获得物攻+80%」：真打一手 1 号位会发
    # `slot_condition_applied` + `buffs={'atk':80}`，但残余片段「获得：…」还在 ⇒ 档位被压成 PARTIAL。
    if caps.get("slot_condition") or caps.get("position_shift"):
        parsed = parse_mod.resolve_position_mechanics(
            skill, slot_declared=bool(caps.get("slot_condition")),
            shift_declared=bool(caps.get("position_shift")),
            claim_effects=True, parsed=parsed)
    return parsed, claimed


def classify_skill(skill: Any, *, foe_energy_loss_declared: bool = False,
                   multi_hit_declared: bool = False,
                   slot_condition_declared: bool = False,
                   position_shift_declared: bool = False,
                   initiative_declared: bool = False,
                   per_layer_cost_declared: bool = False,
                   foe_switch_condition_declared: bool = False,
                   per_use_ramp_declared: bool = False,
                   on_hit_ramp_declared: bool = False,
                   # 2026-09-30：扩展族能力位。判据按 `_CAPABILITY_TO_FLAG` 展开后
                   # splat 进来（`classify_skill(sk, **flags)`，九处），所以这里用兜底
                   # 形参收下任意族，**不逐族再抄一遍形参名**（抄一遍就又多一处漂移点）。
                   **declared_flags: bool) -> Dict[str, Any]:
    """一条战斗技能的支持等级。判据只看**解析结果 + 已声明的能力**，不看名字或人工名单。

    `multi_hit_declared`：当前规则配置有没有声明连击能力（RC-401 的第一条增量）。
    声明了且描述里静态写着「N连击」时，「连击」那一条不再算未实现——**否则会重复计数**
    （同一个机制被算成「已实现」又被算成「未实现」）。
    """
    parsed = parse_mod.parse_skill(skill)
    # RC-401 批次六：与 `env.py` 同一把尺子 —— 未声明这条能力时，解析层会把效果收回
    # （连未认领标记都不补）。台账要按**同一条口径**判，否则"台账说可模拟、引擎不会结算"。
    if not foe_energy_loss_declared:
        parsed = parse_mod.resolve_foe_energy_loss(skill, declared=False, parsed=parsed)
    claimed: List[str] = []
    # ⚠ 顺序有意义：每个 `resolve_*` 都会**就地**在传进去的 `parsed` 上摘标记
    # （`parse.resolve_position_mechanics` 的 `parsed=` 参数）。谁要是再自己
    # `parse_skill` 一次，就会把前面摘掉的标记装回去 —— 那是重复解析造成的假漂移。
    # C1（第 139 轮）：号位条件 / 传动 与连击同一套口径 —— **配置声明了能力**才摘掉那两条
    # 未认领标记（默认都不声明，legacy / v2 的档位逐字不变）。
    if slot_condition_declared or position_shift_declared:
        parsed = parse_mod.resolve_position_mechanics(
            skill, slot_declared=slot_condition_declared,
            shift_declared=position_shift_declared, parsed=parsed)
        if slot_condition_declared and parsed.slot_conditions:
            claimed.append("号位条件")
        if position_shift_declared and parsed.position_shift is not None:
            claimed.append(f"传动×{parsed.position_shift}")
    # RC-401 批次八（2026-09-25）：「若先于敌方攻击，本次技能威力+N%」。
    # 与另外几条同一口径：**声明了能力**才算认领 —— 补一条 `initiative_power` 效果，
    # 它的 evidence 正好盖住那段原文，于是"已认领"由**同一把尺子**（`unclaimed_mechanic_spans`）算出来。
    if initiative_declared and getattr(parsed, "initiative_power", None):
        parsed = parse_mod.resolve_initiative_condition(skill, declared=True, parsed=parsed)
        claimed.append(_initiative_claim_label(parsed))
    # RC-401 批次九（2026-09-25）：「敌方每有 N 层中毒效果，本技能能耗 -M」（动态能耗修正）。
    # 同上：声明了能力才补 `per_layer_cost` 效果 —— 它的 evidence 覆盖整条子句，
    # 于是「每」「层」两个机制词由**同一把尺子**判为已认领。
    # RC-401 批次十一（2026-09-25）：「若敌方本回合更换精灵，<效果>」。
    # 只在**条件后面的效果全读出来**时才算认领（`parse` 那边用 leftover 挡住半条规则）。
    if foe_switch_condition_declared and getattr(parsed, "foe_switch_effects", None) \
            and not getattr(parsed, "foe_switch_leftover", ""):
        parsed = parse_mod.resolve_foe_switch_condition(skill, declared=True, parsed=parsed)
        claimed.append("对手换人条件")
    # RC-401 批次十二（2026-09-25）：「每次使用后，本技能<属性>永久±N」。
    if per_use_ramp_declared and getattr(parsed, "per_use_ramp", None):
        parsed = parse_mod.resolve_per_use_ramp(skill, declared=True, parsed=parsed)
        claimed.append(f"每次使用后永久{int(parsed.per_use_ramp['delta']):+d}"
                       f"{ {'power': '威力', 'cost': '能耗', 'hits': '连击数'}.get(parsed.per_use_ramp['field'], '') }")
    # RC-401 批次十三（2026-09-25）：「每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N」。
    if on_hit_ramp_declared and getattr(parsed, "on_hit_ramp", None):
        parsed = parse_mod.resolve_on_hit_ramp(skill, declared=True, parsed=parsed)
        claimed.append(f"挨打永久{int(parsed.on_hit_ramp['delta']):+d}"
                       f"{ {'power': '威力', 'cost': '能耗', 'hits': '连击数'}.get(parsed.on_hit_ramp['field'], '') }"
                       f"{'（仅被抵抗）' if parsed.on_hit_ramp['requires_resisted'] else ''}")
    if per_layer_cost_declared and getattr(parsed, "per_layer_cost", None):
        parsed = parse_mod.resolve_per_layer_cost(skill, declared=True, parsed=parsed)
        claimed.append(f"动态能耗修正（每 {int(parsed.per_layer_cost['layer_step'])} 层 "
                       f"{int(parsed.per_layer_cost['delta'])} 能量）")
    # 2026-09-30（task-28 改钉）：**N=1 也算已结算** —— 描述里明写「1连击」时，解析层
    # 真的读出了 `hit_count=1`、引擎也真的按它出兵（一击就是普通伤害路径）⇒ 那条标记
    # 没有任何"没实现"的成分，留着它等于**假免责**（`test_respond_override:
    # test_static_one_hit_is_credited_under_v3` 逐字要求 257/514/304 在 v3 下翻正、
    # 在 legacy 下仍不翻正）。⚠ 只摘「连击」那一条：`动态连击数` 必须留着
    # （姊妹判据 `test_unreadable_hits_phrase_stays_leftover` 钉的就是它）。
    if multi_hit_declared and parsed.hit_count:
        # 只摘静态连击那一条；动态连击仍算未实现（见 parse.resolve_hit_count 的同一处判据）。
        kept = [row for row in parsed.unparsed if "动态" in str(row) or "连击" not in str(row)]
        if len(kept) != len(parsed.unparsed):
            claimed.append(f"连击×{parsed.hit_count}")
        parsed.unparsed = kept
    # 2026-09-30 **扩展族**：每个能力位挂一个 `parse` 里已有的 resolver（唯一映射表
    # `_RESOLVER_BY_CAPABILITY`）。与自己上面九步**同一套口径**：声明了才产出、
    # 产出的效果自带 `evidence` ⇒ 那段文本自然从"未认领"里消失（不另抄词表）。
    # 能力读数（能力位名 → 有没有声明）。九条既有形参**覆盖**同名 flag，这样
    # `classify_skill(sk, multi_hit_declared=True)` 这种直接调用也与表展开同值。
    _caps_now = {name: bool(declared_flags.get(flag, False))
                 for name, flag in _CAPABILITY_TO_FLAG.items()}
    _caps_now.update({
        "multi_hit": bool(multi_hit_declared),
        "slot_condition": bool(slot_condition_declared),
        "position_shift": bool(position_shift_declared),
        "foe_energy_loss": bool(foe_energy_loss_declared),
        "initiative_condition": bool(initiative_declared),
        "per_layer_cost": bool(per_layer_cost_declared),
        "foe_switch_condition": bool(foe_switch_condition_declared),
        "per_use_ramp": bool(per_use_ramp_declared),
        "on_hit_ramp": bool(on_hit_ramp_declared),
    })
    parsed, _family_claimed = _apply_capability_resolvers(
        skill,
        _caps_now,
        parsed)
    claimed.extend(_family_claimed)
    # ⚠ 与 `resolve_claims` 的那一步**必须成对**：两把尺子读同一份 `parsed` 才谈得上
    # 一致（少一边 ⇒ 并集就会出现"判据 true / 档位 PARTIAL"的打架）。号位/传动的认领
    # effect 在链尾补一次，防中间族 resolver 重建 effects 时冲掉（实测 `483 啮合传递`）。
    if _caps_now.get("slot_condition") or _caps_now.get("position_shift"):
        parsed = parse_mod.resolve_position_mechanics(
            skill, slot_declared=bool(_caps_now.get("slot_condition")),
            shift_declared=bool(_caps_now.get("position_shift")),
            claim_effects=True, parsed=parsed)

    # ── 两把尺子的**共用读数**（2026-09-30 收口）────────────────────────────
    # 认领词表 / 残余片段 / 逐句应对缺口 + 没拉起的原语，全部只在这里算一次，
    # 判据（`settlement_verdict`）调**同一对函数** ⇒ 不会再出现"同一招两处两个说法"。
    _flags_now = dict(declared_flags)
    _flags_now.update({
        "multi_hit_declared": multi_hit_declared,
        "slot_condition_declared": slot_condition_declared,
        "position_shift_declared": position_shift_declared,
        "foe_energy_loss_declared": foe_energy_loss_declared,
        "initiative_declared": initiative_declared,
        "per_layer_cost_declared": per_layer_cost_declared,
        "foe_switch_condition_declared": foe_switch_condition_declared,
        "per_use_ramp_declared": per_use_ramp_declared,
        "on_hit_ramp_declared": on_hit_ramp_declared,
    })
    _claimed_words = claimed_mechanic_words(parsed, _flags_now)
    _residual_spans = residual_mechanic_spans(skill, parsed, _claimed_words)
    _gates = unsettled_mechanic_gaps(skill, parsed, _claimed_words, _caps_now)
    # 「已结算的类」（与判据**同一个** `SETTLED_PATTERNS`）—— 下面那个"三空"出口要它。
    _settled_classes = [name for name, words in SETTLED_PATTERNS
                        if any(w and w in str(getattr(skill, "desc", "") or "") for w in words)]
    # 2026-09-25（第 31 轮实测）：**纯防御技能**（描述里只有「减伤 N%」与「应对X」标记）由
    # 另一条路径结算 —— `effects.parse_defense_reduction()` 读减伤比例、`effects.respond_to()`
    # 读应对类别（`env._execute` 的防御分支就是这两条）。`parse_skill` 对它们**没有 effect**，
    # 于是过去落到「未识别机制」里 —— 连 `防御` 这条技能本身都被判成"读不出来"，那是**假 PARTIAL**。
    # 这里按"解析器 + 防御路径"合起来判：两条都读得到、且没有别的子句 ⇒ 可模拟。
    if getattr(skill, "is_defense", False):
        _desc = str(getattr(skill, "desc", "") or "")
        _residual = _re.sub(r"减伤\s*\d+(?:\.\d+)?%", "", _desc)
        _residual = _re.sub(r"应对(?:状态|攻击|防御)", "", _residual)
        _residual = _re.sub(r"[，。；、,;:：\s]", "", _residual)
        _has_reduction = bool(_re.search(r"减伤\s*\d+(?:\.\d+)?%", _desc))
        # 2026-09-30：共用闸（逐句应对 / 没拉起的原语）**也必须放行**才准说可模拟 ——
        # 防御技能那条路同样不许绕开它们（否则「应对状态：下次…」这类没实现的分句会被放过）。
        if _has_reduction and not _residual and not _residual_spans and not _gates:
            return {
                "support": SUPPORT_SIMULATABLE_UNVERIFIED,
                "why": "防御技能：减伤比例由 effects.parse_defense_reduction() 读、应对类别由"
                       " effects.respond_to() 读（描述里没有别的子句）",
                "effects": ["defense_reduction"],
                "unparsed": [],
                "claimed_by_capability": claimed,
            }

    # ── 第 39 轮：**「读得出效果」不等于「描述被完整读出」** ───────────────────────
    #
    # 实测（本轮）：337 条被判可模拟的技能里，有 **60 条**的描述里仍有
    # `unclaimed_mechanic_spans()` 认不出的机制词（「并获得魔攻魔防+10%」「每次连击…」
    # 「持续8回合」「若本次攻击未被防御技能应对」…）。而那个函数**正是** `env._execute`
    # 写 `state.unsupported` 用的同一把尺子 ⇒ 引擎自己都在回执里说"这段没结算"，
    # 台账却说"描述被完整读出且引擎会结算" —— 两处打架，而且台账那句是假的。
    #
    # 所以这一档现在多一个**必要条件**：`unclaimed_mechanic_spans()` 里没有残余片段。
    # 「已声明能力」覆盖的那些词（连击 / 号位 / 传动 / 先手条件 / 敌方失能）不算残余 ——
    # 认领口径与 `env.py` / 服务端**同一份读数**。档位只会因此**变保守**，不会变宽松。
    # （认领词表 / 残余片段 / 共用闸已在上面算过，见「两把尺子的**共用读数**」。）
    if _residual_spans or _gates:
        # ⚠ 这里**不要**往 `claimed` 里塞"缺口"：`claimed_by_capability` 的语义是
        # 「被哪条已声明能力认领了」，塞进未认领片段会让那一栏自相矛盾。
        _gap_all = list(_residual_spans) + list(_gates)
        return {
            "support": SUPPORT_PARTIAL,
            "why": ("读出了 " + str(len(parsed.effects)) + " 条效果，但描述里还有 "
                    + str(len(_gap_all)) + " 段机制**引擎没结算**（会被写进 unsupported）："
                    + "、".join(str(x) for x in _gap_all[:2])),
            "effects": [e.kind for e in parsed.effects],
            "unparsed": [str(x) for x in _gap_all],
            "claimed_by_capability": claimed,
        }
    # 2026-09-29（task-24）**改钉**：新增一条**同样有依据**的可结算形态 ——
    # 「**有静态威力的纯伤害 + 已结算的应对子句**」。实测 8 条（`255 突袭` / `259 偷袭` /
    # `379 闪燃`…）：描述里有「应对状态」⇒ `plain_attack=False`，但那一句引擎**真的结算**
    # （`effects.effective_power()` 按倍率改这一手的威力）—— 过去它们掉进匿名桶判 PARTIAL，
    # 是**假保守**。判据的意图一个字没松：可结算仍然必须**说得出来源**，只是来源多了一种。
    if not _residual_spans and not _gates and not parsed.effects \
            and getattr(skill, "has_static_power", False) \
            and _has_settled_respond_power_clause(skill):
        return {
            "support": SUPPORT_SIMULATABLE_UNVERIFIED,
            "why": "纯伤害 + 已结算的应对子句（effects.effective_power() 按倍率改这一手的威力），"
                   "没有别的残余片段",
            "effects": [],
            "unparsed": [],
            "claimed_by_capability": claimed,
        }
    if _gates:
        # 2026-09-30：**共用闸的落点** —— 「逐句判应对子句」与「没拉起的原语」这两条
        # 以前只有判据（`settlement_verdict`）看，档位那两条早退分支（`plain_attack` /
        # 「效果齐 + 无 unparsed」）两样都不看 ⇒ 同一招两处两个说法（实测 18 条，后来 8 条）。
        # 现在两条闸由**同一对函数**给出，档位与判据一起看。方向只会更保守：fail closed。
        level = SUPPORT_PARTIAL
        why = ("描述里有没结算的分句（" + "、".join(str(x) for x in _gates[:2])
               + "）：引擎不按普通伤害结算（fail closed）")
        _seen_gap = {str(x) for x in parsed.unparsed}
        parsed.unparsed = list(parsed.unparsed) + [str(g) for g in _gates
                                                  if str(g) not in _seen_gap]
    elif parsed.effects and not parsed.unparsed:
        level = SUPPORT_SIMULATABLE_UNVERIFIED
        why = f"描述被完整读出（{len(parsed.effects)} 条效果），且没有未认领片段"
    elif parsed.effects and parsed.unparsed:
        level = SUPPORT_PARTIAL
        why = f"读出一部分（{len(parsed.effects)} 条），另有 {len(parsed.unparsed)} 段没认领"
    elif not parsed.effects and not parsed.unparsed:
        # C3-c（2026-09-22，人类红线「未支持的效果不得暗中按普通伤害结算」）：
        # 「没读出效果」**不等于**「没有机制」。`parse.py` 自己有更严的判定
        # （`plain_attack` = 描述里没有机制词、且是带威力的攻击）——只有它为真时，
        # 才能落「纯伤害」这一档；否则说明描述里有机制而它既没被读出、
        # 也没被登记为未认领片段 —— 过去这种情况被判成纯伤害，引擎会**默默只算伤害**。
        if getattr(parsed, "plain_attack", False):
            level = SUPPORT_SIMULATABLE_UNVERIFIED
            why = "纯伤害技能（解析器确认描述里没有机制词），引擎按基础结算处理"
        elif claimed and (parsed.effects or _settled_classes or
                          getattr(parsed, "plain_attack", False)):
            # 2026-09-30（按逐行审计收窄）：**光有认领标记不算结算** —— 实测
            # `473 轴承支撑` / `489 减压阀`（「被动：…，传动1。」）只认领到 `传动×1`
            # 这一个**位移标记**就被这一支放行，而引擎自己还在写 `status_unsupported`
            # ⇒ 那是"把未结算说成已结算"。收窄口径：要有**产出**、或是**纯伤害**、
            # 或点得出**已结算的类**，三者之一（`ledger-delta-audit.txt` 第 ④ 族）。
            level = SUPPORT_SIMULATABLE_UNVERIFIED
            why = f"描述里的机制由已声明能力认领（{'、'.join(claimed)}），没有未认领片段"
        else:
            # 2026-09-30：**「三空」出口**（`_settlement_lists-抽取前基线-2026-09-30.md:58,63-66` 逐字）——
            # 「三空 = 无产出 且 无缺口 且 `settled` 空」⇒ 补理由
            # 「描述里没有任何可识别的机制（三空：无产出/无缺口/无已结算）」，
            # 且「**只补理由 · 不改 `resolved` · 档位跟着一致**」+「前者说未结算 ⇒ 后者不许说可模拟」。
            # ⚠ 关键是**第三条**：只有 `settled` 空的才落这一档。`257 追打`
            # 「造成魔伤，1连击，应对状态：本技能变为3连击。」已经点得出「伤害/应对」两类
            # （`settled` 非空）⇒ 不该掉进匿名桶（实测：那是 427 并集里"判据 true/档位 PARTIAL"
            # 的唯一来源；`test_static_one_hit_is_credited_under_v3` 也逐字要它被认领）。
            if _settled_classes and not getattr(skill, "is_defense", False):
                level = SUPPORT_SIMULATABLE_UNVERIFIED
                why = ("描述点得出已结算的类（" + "、".join(_settled_classes[:3])
                       + "），且没有未认领片段")
            else:
                    # 2026-09-25（第 30 轮）：这一档原来只说「认不出的机制」，**不说是哪一段** ——
                # 于是台账里出现一个匿名的「（未命名）174 条」桶，按频次排序的下一批工作单看不见它。
                # 运行时其实有这把尺子：`parse.unclaimed_mechanic_spans()` 正是 `env._execute` 写
                # `state.unsupported` 用的那一个（同一份实现，不是另抄一套）。这里把它叫出来，
                # 把片段按 `{机制词}：{原句}` 登记进台账 —— **只补诊断，不改结算**（档位仍是 PARTIAL）。
                # ⚠ 传 `parsed`：上面几条 `resolve_*` 可能已经把声明过的能力补成效果了，
                # 重新 `parse_skill` 会把那份认领丢掉（同一段文本又被登记成未认领）。
                # 2026-09-30：**span 计算全走同一个实现**（`residual_mechanic_spans`）——
                # 这里以前自己又算一份 raw spans，于是「应对…：本次技能威力N倍」那条**已结算形状**
                # 在这个分支里又被报成缺口（255/259/379 三条的档位就是这么被压低成 PARTIAL 的）。
                spans = list(residual_mechanic_spans(skill, parsed, _claimed_words))
                _desc_tail = str(getattr(skill, "desc", "") or "")[:60]
                # 同一个分句常被**多个机制词**命中（「每」「若」「回合」经常同现，实测「若敌方本回合
                # 更换精灵」被登记成 `回合：…` 与 `若：…` 两条）——按分句去重，排序时才不会被同一段
                # 文本刷两遍频次。
                _seen, _dedup = set(), []
                for _row in spans:
                    _s = str(_row)
                    _word, _, _clause = _s.partition("：")
                    _key = (_clause or _word).strip()
                    if not _key or _key in _seen:
                        continue
                    _seen.add(_key)
                    _dedup.append(_s if _clause else _key)
                spans = _dedup
                level = SUPPORT_PARTIAL
                if spans:
                    why = (f"读不出效果，描述里有 {len(spans)} 段未认领机制"
                           "（运行时同样会写进 state.unsupported，引擎不按普通伤害结算）")
                    parsed.unparsed = spans
                else:
                    # 描述里连一个**已登记的机制词**都没有命中（实测 22 条：防御/减伤/应对攻击/交换/
                    # 迅捷… 这些词不在 `_EXTRA_MECHANIC` 的表里）。这时**不能**留一个匿名桶：
                    # 台账按频次排序的下一批工作单会看不见它。给它一个**说得清的分组名**，
                    # 原句放进 `why`（人读得懂），分组由 `_primitive_bucket` 收到「未识别机制」下。
                    why = (f"读不出效果，描述里没有已登记的机制词（原句：{_desc_tail}）"
                           "：需人工读描述，引擎不按普通伤害结算（fail closed）")
                    parsed.unparsed = ["未识别机制（描述里没有已登记的机制词）"]
    else:
        level = SUPPORT_KNOWLEDGE_ONLY
        why = f"只有资料：{len(parsed.unparsed)} 段机制没被读出"
    return {
        "support": level,
        "why": why,
        "effects": [e.kind for e in parsed.effects],
        "unparsed": list(parsed.unparsed),
        "claimed_by_capability": claimed,
        **({"hit_count": parsed.hit_count} if parsed.hit_count else {}),
    }


def classify_trait(trait: Any) -> Dict[str, Any]:
    """一条特性的支持等级：登记表里查得到就用登记状态，否则只有资料。"""
    spec = traits_mod.TRAITS.get(trait.name)
    if spec is None:
        return {"support": SUPPORT_KNOWLEDGE_ONLY, "why": "未被 traits.py 登记（引擎不会结算）",
                "hook": None, "reason": None}
    level = TRAIT_STATUS_TO_SUPPORT.get(spec.status, SUPPORT_KNOWLEDGE_ONLY)
    hooks = [h for h in (spec.hook, *(spec.extra_hooks or ())) if h]
    return {"support": level, "why": f"登记状态 {spec.status}", "hook": spec.hook,
            "hooks": hooks, "reason": spec.reason}


#: 触发词 → 引擎**真的有**的钩子。只登记我们真能挂上的那些；其余一律 `unknown`，
#: 因为「效果读得出来」不等于「知道它什么时候触发」——猜触发时点就是编规则。
TRIGGER_HOOKS: "dict[str, str]" = {
    "入场时": "on_enter",
    "登场时": "on_enter",
    "换上时": "on_enter",
    "入场后": "on_enter",
    "攻击时": "on_action",
    "使用技能时": "on_action",
}

#: 触发词的识别顺序（长词优先，避免「入场时」被「场时」抢先）。
_TRIGGER_ORDER = ("入场时", "登场时", "换上时", "入场后", "攻击时", "使用技能时")


def trigger_hook_of(desc: str) -> "dict[str, object]":
    """这条描述里的触发词映射到哪个钩子（没有 = 未知触发）。

    **只认闭集里的词**。识别不到触发时就如实返回 `unknown` —— 效果能被读出来 ≠ 我们知道
    它什么时候触发，而按错时点结算比不结算更糟（那是静默错算）。
    """
    text = str(desc or "")
    for word in _TRIGGER_ORDER:
        if word in text:
            return {"trigger": word, "hook": TRIGGER_HOOKS[word], "known": True}
    return {"trigger": None, "hook": None, "known": False}


def anonymous_entities(report: Dict[str, Any]) -> List[str]:
    """台账里**说不出原因**的实体（第 30 轮新增的判据，判据本体在这里、测试与 CLI 共用）。

    为什么需要它：这一档原来只写一句「描述里有解析器认不出的机制」，**不说是哪一段** ——
    于是 `coverage_ranking` 里出现一个匿名的「（未命名）174 条」桶，而"按频次排序的下一批工作单"
    看不见它（174 条技能里其实有 7 条是「若敌方本回合更换精灵」这类**同一段文本**）。
    现在：未认领片段按**分句**登记（同一个分句被多个机制词命中时去重），
    连一个已登记机制词都没命中的 22 条归到具名的「未识别机制」下并把原句写进 `why`。

    返回**匿名实体**的 id 列表（空 = 每一条都说得出为什么不能模拟）。
    判定：`PARTIAL` / `KNOWLEDGE_ONLY` 的条目必须同时满足
      · `why`（技能）或 `reason`（特性）非空；
      · 且 `unparsed`（技能）或 `reason`（特性）里至少有一句**人读得懂的原因**。
    """
    bad: List[str] = []
    for sid, row in (report.get("skills") or {}).items():
        if row.get("support") not in (SUPPORT_PARTIAL, SUPPORT_KNOWLEDGE_ONLY):
            continue
        if not str(row.get("why") or "").strip() or not (row.get("unparsed") or []):
            bad.append(str(sid))
    for tid, row in (report.get("traits") or {}).items():
        if row.get("support") not in (SUPPORT_PARTIAL, SUPPORT_KNOWLEDGE_ONLY):
            continue
        # 特性的"说得清"有两种形态：① 登记表里有这条（`reason` 是拒绝/部分实现的理由）；
        # ② 登记表里根本没有它 —— 那 `reason` 是 null，但 `why` 写着「未被 traits.py 登记
        # （引擎不会结算）」，这本身就是原因（`coverage_ranking` 的「未被登记」桶）。
        # 判据要求的是"有原因"，不是"必须长成某个字段"，所以两种都收。
        named = bool(str(row.get("reason") or "").strip()) or str(row.get("why") or "").strip() != ""
        if not named:
            bad.append(str(tid))
    return sorted(bad)


def _primitive_bucket(reason: str) -> str:
    """把「没认领的片段」归成一个原语名（台账里按它排序）。"""
    head = str(reason).split("（")[0].strip()
    for marker in parse_mod.UNPARSED_MARKERS:
        if marker and marker in head:
            return marker
    return head.split(":")[0][:24] or "（未命名）"


def loadout_reachability(rs: Any, *, builds: Optional[Dict[str, Any]] = None,
                         source: Optional[str] = None) -> Dict[str, Any]:
    """**产品可达性**：这些实体在「配招里真的带得上」这一层能不能碰到。

    为什么单列一栏（第 36 轮实测教训）：覆盖台账原来的排序只有「能解锁多少条实体」，
    于是「选择（20 条）」排到第三 —— 可实测下来，这 20 条里**出现在任何配招里的只有 4 条**
    （友谊满溢 / 透镜实验 / 蹦跶 / 撒花，共 10 只），而它们的另一条分支全都要别的机制
    （应对子句 / 每次使用后威力永久 / 萌化），所以那一个批次做完**产品上一点变化都没有**。
    「引擎支持」≠「产品可达」——这一栏就是把后者量出来，排序时才有得选。

    口径：
      · **冻结配招**来自 `rs.candidate_moveset(pid)`（引擎唯一事实源，基线 12 + overlay 36）；
      · **按需推算配招**来自 `data/roco/derived/on-demand-builds.json`（RC-402 的 622 只）；
      · 读不到那份产物时**如实说读不到**（`source=None` + `reason`），不假装 0。
    """
    frozen: Dict[str, set] = {}
    for pid in rs.pets:
        for sid in (rs.candidate_moveset(pid) or ()):
            frozen.setdefault(sid, set()).add(pid)
    if builds is None:
        if source is None:
            source = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..",
                                                  "data", "roco", "derived", "on-demand-builds.json"))
        try:
            with open(source, "r", encoding="utf-8") as fh:
                builds = json.load(fh).get("builds") or {}
        except Exception as exc:      # 产物不在/读坏了 ⇒ 如实报读不到
            return {"source": None, "reason": f"读不到按需推算配招产物：{exc}",
                    "frozen_pets": len(rs.pets), "builds": 0,
                    "skills": {sid: sorted(pets) for sid, pets in frozen.items()},
                    "traits": {}}
    derived: Dict[str, set] = {}
    for pid, row in (builds or {}).items():
        for entry in (row.get("skills") or ()):
            sid = entry.get("skill_id") if isinstance(entry, dict) else entry
            if sid:
                derived.setdefault(str(sid), set()).add(str(pid))
    # 特性：一只精灵只带一条特性（`feature_skill_id`），所以"带得上"就是"这只在名单里"
    trait_pets: Dict[str, set] = {}
    for pid in (builds or {}):
        pet = rs.pets.get(pid)
        if pet is not None and getattr(pet, "feature_skill_id", None):
            trait_pets.setdefault(str(pet.feature_skill_id), set()).add(str(pid))
    merged: Dict[str, set] = {}
    for table in (frozen, derived):
        for sid, pets in table.items():
            merged.setdefault(sid, set()).update(pets)
    return {"source": source, "reason": None,
            "frozen_pets": len(rs.pets), "builds": len(builds or {}),
            "skills": {sid: sorted(pets) for sid, pets in merged.items()},
            "traits": {sid: sorted(pets) for sid, pets in trait_pets.items()},
            "frozen_skills": {sid: sorted(pets) for sid, pets in frozen.items()}}


def declared_capabilities_of(config_id: str = "mobile_s4_candidate_v3") -> Dict[str, bool]:
    """这份配置**声明了哪些能力** —— 覆盖台账与教练的技能档位回执共用**同一份读数**。

    为什么要抽出来（第 38 轮实测踩到的）：`service._skill_record(with_tier=True)` 原来
    **写死** `multi_hit_declared=True`，后面几条能力（号位/传动/敌方失能/先手条件）一条都没传
    ⇒ 教练的工具回执说「扇风：PARTIAL，有一段没读出来」，而台账（按候选口径算）说
    SIMULATABLE —— **同一个机制两处口径打架**。现在两处都调这一个函数。
    配置读不到时退回「只认连击」（宁可少算，也不假装支持）。
    """
    try:
        from . import rule_config as _rc
        cfg = _rc.get_rule_config(config_id)
        base = {"multi_hit": bool(getattr(cfg, "damage_multi_hit", False)),
                "slot_condition": bool(getattr(cfg, "damage_slot_condition", False)),
                "position_shift": bool(getattr(cfg, "damage_position_shift", False)),
                # RC-401 批三（2026-09-23）：技能能耗修正。它不改「哪些技能能结算」，
                # 但它是**已声明的能力**，尺子要如实列出来（否则台账与引擎各说各话）。
                "cost_modifier": bool(getattr(cfg, "energy_cost_modifier", False)),
                # RC-401 批次六（2026-09-25）：「敌方失去 N 能量」（场上 / 全队两读法）。
                "foe_energy_loss": bool(getattr(cfg, "energy_foe_energy_loss", False)),
                # RC-401 批次八（2026-09-25）：「若先于敌方攻击」的威力加成。
                "initiative_condition": bool(getattr(cfg, "damage_initiative_condition", False)),
                # RC-401 批次九（2026-09-25）：「敌方每有 N 层中毒效果，本技能能耗 -M」。
                "per_layer_cost": bool(getattr(cfg, "energy_per_layer_cost", False)),
                # RC-401 批次十一（2026-09-25）：「若敌方本回合更换精灵，<效果>」。
                "foe_switch_condition": bool(getattr(cfg, "damage_foe_switch_condition", False)),
                # RC-401 批次十二（2026-09-25）：「每次使用后，本技能<属性>永久±N」。
                "per_use_ramp": bool(getattr(cfg, "damage_per_use_ramp", False)),
                # RC-401 批次十三（2026-09-25）：「每被攻击1次…永久±N」。
                "on_hit_ramp": bool(getattr(cfg, "damage_on_hit_ramp", False))}
        # 2026-09-30：**只加叶子，不动上面十个键**。为什么强调：`build_coverage` 只读那
        # 十个键（逐条显式调用 `classify_skill(...)`），所以台账口径**逐位不变**；
        # 新叶子是给 `classify_skill_declared` / 判据用的**同一份读数**
        # （`test_element_use_ramp:270` 要 `["element_use_ramp"]`，`test_global_skill_mods_transition`
        # 要 `["global_skill_mods"]`）。属性名逐条写在 `_CAPABILITY_ATTR` 里，**不按名字猜**。
        for _name, _attr in _CAPABILITY_ATTR.items():
            if _name not in base:
                base[_name] = bool(getattr(cfg, _attr, False))
        return base
    except Exception:
        return {"multi_hit": True}


def build_coverage(rs: Any, *, headline: Optional[List[str]] = None,
                   declared_capabilities: Optional[Dict[str, bool]] = None,
                   reachability: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """跑一遍全量数据，产出覆盖台账。**确定性**：同样的数据 ⇒ 同样的报告。

    `declared_capabilities` 默认取**候选口径**（`mobile_s4_candidate_v3` 已声明连击）。
    之所以要显式带上它：覆盖率不是数据的属性，而是「**数据 × 已声明的能力**」的属性——
    同一份数据，legacy 口径与候选口径的覆盖率本来就不同，混在一起谈就是自欺。
    """
    # 默认口径 = **当前候选配置声明的能力**（C1 起含号位条件 / 传动，与 `damage.multi_hit` 并列）。
    # 为什么从配置读而不是写死：能力是**配置声明的**，报告必须跟着它走，
    # 否则「台账说支持」与「引擎真的会结算」会各说各话。
    if declared_capabilities is None:
        capabilities = declared_capabilities_of()
    else:
        capabilities = dict(declared_capabilities)
    # 2026-09-23：**只统计冻结那一份**。PVP 魔法换进来的「愿力冲击」（`Skill.derived`）
    # 是派生产物（见 data/roco/derived/pvp-magic.json），把它算进来会改掉冻结快照的
    # 覆盖口径（实测 battle_skills 579 → 615、可模拟比例跟着漂），而这份报告的语义是
    # 「冻结的 824 条里我们能结算多少」。
    skills = [s for s in rs.skills.values() if not s.is_trait and not s.derived]
    traits = [s for s in rs.skills.values() if s.is_trait and not s.derived]

    reach = reachability if reachability is not None else loadout_reachability(rs)
    reach_skills = reach.get("skills") or {}
    reach_traits = reach.get("traits") or {}

    def _reach_of(skill_id: str, *, trait: bool = False) -> Optional[int]:
        table = reach_traits if trait else reach_skills
        if skill_id not in table:
            # 表里没有这一条 = 没有任何配招带它（**不是**读不到）；读不到时 source=None。
            return 0 if reach.get("source") else None
        return len(table[skill_id])

    # 2026-09-30：台账与产品/判据**同一份能力读数**（`_flags_of` 展开唯一映射表）。
    # 以前这里逐条手抄九个 `xxx_declared=`，于是新增的能力族**台账永远看不到**
    # （家族的 resolver 一个都不跑 ⇒ 台账少算），正是「一处声明、多处不共读」的老病。
    # 既有九个形参名逐字不变（`_flags_of` 出的就是同一批名字），所以旧口径不漂。
    skill_rows = {s.skill_id: classify_skill(s, **_flags_of(capabilities)) for s in skills}
    trait_rows = {t.skill_id: classify_trait(t) for t in traits}
    for sid, row in skill_rows.items():
        row["loadout_pets"] = _reach_of(sid)
    for tid, row in trait_rows.items():
        row["loadout_pets"] = _reach_of(tid, trait=True)

    def tally(rows):
        out = collections.Counter(row["support"] for row in rows.values())
        return {level: out.get(level, 0) for level in (
            SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_PARTIAL,
            SUPPORT_KNOWLEDGE_ONLY, SUPPORT_REFUSED)}

    # 「按覆盖收益」：每个未实现原语能解锁多少条实体（技能 + 特性分开数）。
    benefit: Dict[str, Dict[str, int]] = {}
    for sid, row in skill_rows.items():
        if row["support"] in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED):
            continue
        for span in row["unparsed"] or ["（未知，解析器没有给出片段）"]:
            key = _primitive_bucket(span)
            benefit.setdefault(key, {"skills": 0, "traits": 0})["skills"] += 1
    for tid, row in trait_rows.items():
        if row["support"] in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED):
            continue
        reason = row.get("reason") or "未被登记"
        key = _primitive_bucket(str(reason)[:40])
        benefit.setdefault(key, {"skills": 0, "traits": 0})["traits"] += 1

    # 可达性要按**原语桶**汇总：这个桶卡住了多少只"配招里真的带得上"的精灵。
    # 同一只精灵可能带多条未实现机制，所以这一列是"受影响精灵数"，不是"实体的数量"。
    bucket_pets: Dict[str, set] = {}
    for sid, row in skill_rows.items():
        if row["support"] in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED):
            continue
        pets = set(reach_skills.get(sid) or ())
        if not pets:
            continue
        for span in row["unparsed"] or ["（未知，解析器没有给出片段）"]:
            bucket_pets.setdefault(_primitive_bucket(span), set()).update(pets)
    for tid, row in trait_rows.items():
        if row["support"] in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED):
            continue
        pets = set(reach_traits.get(tid) or ())
        if not pets:
            continue
        bucket_pets.setdefault(_primitive_bucket(str(row.get("reason") or "未被登记")[:40]), set()).update(pets)

    ranked = sorted(
        ({"primitive": key, **counts, "total": counts["skills"] + counts["traits"],
          "loadout_pets": len(bucket_pets.get(key, ()))}
         for key, counts in benefit.items()),
        key=lambda row: (-row["total"], row["primitive"]),
    )
    # 产品可达口径的排序：**先看卡住多少只带得上的精灵**，再看实体条数。
    reach_ranked = sorted(
        (row for row in ranked if row["loadout_pets"]),
        key=lambda row: (-row["loadout_pets"], -row["total"], row["primitive"]),
    )

    skill_tally = tally(skill_rows)
    trait_tally = tally(trait_rows)
    total_entities = len(skills) + len(traits)
    simulatable = (skill_tally[SUPPORT_SIMULATABLE_UNVERIFIED] + trait_tally[SUPPORT_SIMULATABLE_UNVERIFIED]
                   + skill_tally[SUPPORT_FULL_VERIFIED] + trait_tally[SUPPORT_FULL_VERIFIED])
    return {
        "schema": "roco-effect-coverage/v1",
        "rc": "RC-401 / RC-403",
        "generated_by": "roco/src/roco_env/coverage.py",
        "ruleset_id": rs.ruleset_id,
        "why": "「按覆盖收益增量迁移」需要一个能量出来的尺子：每条未实现原语能解锁多少实体。"
               "本报告只回答「我们现在站在哪里」，不判断机制对不对。",
        "totals": {
            "battle_skills": len(skills),
            "traits": len(traits),
            "entities": total_entities,
            "simulatable_entities": simulatable,
            "simulatable_ratio": round(simulatable / total_entities, 4) if total_entities else None,
        },
        "declared_capabilities": capabilities,
        "support_levels": {
            "battle_skills": skill_tally,
            "traits": trait_tally,
        },
        "coverage_ranking": ranked[:40],
        "reachability": {
            "source": reach.get("source"),
            "reason": reach.get("reason"),
            "ruleset_pets": reach.get("frozen_pets"),
            "derived_builds": reach.get("builds"),
            "skills_in_loadouts": len([k for k, v in reach_skills.items() if v]),
            "why": "「引擎支持」≠「产品可达」：这一栏数的是**配招里真的带得上的**精灵数"
                   "（来源取并集：`rs.candidate_moveset` 覆盖规则集里的 "
                   + str(reach.get("frozen_pets")) + " 只，`on-demand-builds.json` 另有 "
                   + str(reach.get("builds")) + " 条推算配招）。"
                   "排序只看条数会把「做完产品上没变化」的批次排到前面 —— 第 36 轮实测："
                   "「选择」20 条里**读得全的只有 2 条、而这两条一条配招都没带**；"
                   "真正带得上选择技能的是 15 只，且它们的另一条分支全都要别的机制。",
            "top_blocked_by_reach": [dict(row) for row in reach_ranked[:15]],
        },
        "anonymous_entities": anonymous_entities({"skills": skill_rows, "traits": trait_rows}),
        "headline": list(headline or []),
        "known_limits": [
            "`SIMULATABLE_UNVERIFIED` 只表示「描述被完整读出且引擎会结算」，**不是**实机核验过",
            "解析器读不出的**条件化**机制（条件化回能、动态连击数…）一律进 PARTIAL/KNOWLEDGE_ONLY，不做近似",
            "特性的收益排序用的是它与实现状态，粒度到「原语」而不是到具体句子",
        ],
        "skills": skill_rows,
        "traits": trait_rows,
    }


def build_trait_worklist(rs: Any) -> Dict[str, Any]:
    """**特性层的工作清单**：按「实现它能让多少只精灵变成可模拟」排序。

    为什么单独做这一份：RC-403 的分类显示 609 只精灵卡在特性那一件上，但特性有 245 条，
    不能一起上。排序依据是**覆盖收益**，而不是「哪条看起来简单」：

      · `pets_blocked`：把这条特性实现掉，能让多少只精灵从 `PARTIAL` 变成「全可模拟」；
      · `readiness`：`ready`（触发钩子已知 **且** 描述能被完整读出）/ `effect_unparsed`
        （知道什么时候触发，但效果读不出来）/ `trigger_unknown`（效果也许读得出，
        但不知道什么时候触发 —— 这一类比前一类更危险，按错时点就是静默错算）/
        `registered`（已在 `traits.py` 里登记）。

    数据来源全部可复跑：`rs` 的冻结数据 + `parse.parse_skill` + `traits.TRAITS`。
    """
    from . import traits as traits_mod

    # 按 **skill_id** 索引：冻结数据里有同名特性（不同形态/不同系别），按名字索引会把它们合并掉
    # （实测 245 条会被压成 242 条）。名字只当标签用。
    trait_skills = {t.skill_id: t for t in rs.skills.values() if t.is_trait}
    # 每只精灵卡在哪条特性上（只有「唯一没实现的部件是特性」才算能被它解锁）
    blocked: "dict[str, list[str]]" = {}
    for pet_id in rs.pets:
        pet = rs.pets[pet_id]
        trait = rs.skills.get(pet.feature_skill_id) if pet.feature_skill_id else None
        if trait is None or not getattr(trait, "is_trait", False):
            continue
        moves_ok = all(
            classify_skill(rs.skills[sid], multi_hit_declared=True)["support"]
            in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED)
            for sid in (rs.candidate_moveset(pet_id) or ()) if sid in rs.skills)
        trait_row = classify_trait(trait)
        trait_ok = trait_row["support"] in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED)
        if moves_ok and not trait_ok:
            blocked.setdefault(trait.name, []).append(pet_id)

    rows = []
    for skill_id, skill in sorted(trait_skills.items()):
        hook = trigger_hook_of(skill.desc)
        parsed = parse_mod.parse_skill(skill)
        effect_clean = bool(parsed.effects) and not parsed.unparsed
        registered = skill.name in traits_mod.TRAITS
        if registered:
            readiness = "registered"
        elif hook["known"] and effect_clean:
            readiness = "ready"
        elif hook["known"]:
            readiness = "effect_unparsed"
        else:
            readiness = "trigger_unknown"
        rows.append({
            "trait": skill.name, "skill_id": skill.skill_id,
            "trigger": hook["trigger"], "hook": hook["hook"], "trigger_known": hook["known"],
            "effect_clean": effect_clean, "parsed_effects": [e.kind for e in parsed.effects],
            "unparsed": list(parsed.unparsed),
            "readiness": readiness,
            "pets_blocked": len(blocked.get(skill.name, [])),
            "blocked_pets": sorted(blocked.get(skill.name, []))[:8],
            "desc": (skill.desc or "")[:80],
        })
    # 覆盖收益排序：唯它能解锁的精灵数 → 就绪度（ready 优先）→ 名字（确定性）
    order = {"ready": 0, "registered": 1, "effect_unparsed": 2, "trigger_unknown": 3}
    rows.sort(key=lambda r: (-r["pets_blocked"], order.get(r["readiness"], 9), r["trait"], r["skill_id"]))
    tally = collections.Counter(r["readiness"] for r in rows)
    return {
        "schema": "roco-trait-worklist/v1",
        "rc": "RC-401 / RC-403",
        "generated_by": "roco/src/roco_env/coverage.py",
        "ruleset_id": rs.ruleset_id,
        "why": "609 只精灵卡在特性那一件上。245 条特性不能一起上，所以按**覆盖收益**排序："
               "先做「触发钩子已知 + 描述能被完整读出」的那批。",
        "totals": {"traits": len(rows), **dict(tally)},
        "trigger_vocabulary": dict(TRIGGER_HOOKS),
        "pets_blocked_by_traits": sum(len(v) for v in blocked.values()),
        "known_limits": [
            "`pets_blocked` 只统计「**唯一**没实现的部件是特性」的精灵；还有别的部件没实现的精灵不计入",
            "`trigger_unknown` 不等于「不能做」，而是「不知道什么时候触发」——按错时点结算比不结算更糟",
            "本清单是**排序依据**，不是实现：任何一条特性落地都要有自己的判据与反证",
        ],
        "worklist": rows,
    }


def write_report(rs: Any, path: str, *, headline: Optional[List[str]] = None) -> Dict[str, Any]:
    report = build_coverage(rs, headline=headline)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    return report


def _main() -> int:  # pragma: no cover - CLI 入口
    import argparse

    from . import data as data_mod

    parser = argparse.ArgumentParser(description="RC-401/403 效果覆盖台账")
    # ⚠ 默认路径**相对仓库根**（不是 CWD）：第 30 轮实测踩到 —— 在 `roco/` 里跑
    # `python3 -m roco_env.coverage`，产物写进了 `roco/reports/…`，而 stdout 看着是新的，
    # 真正的产物一个字节没动。`_ROOT` 由 `__file__` 推出来（roco/src/roco_env → 仓库根）。
    _root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    parser.add_argument("--out", default=os.path.join(_root, "reports", "roco", "rc401", "effect-coverage.json"))
    parser.add_argument("--traits-out", default=os.path.join(_root, "reports", "roco", "rc401", "trait-worklist.json"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--check", action="store_true",
                        help="只对比：磁盘产物与现在重算是否一致（除 headline）；不一致退出 1")
    args = parser.parse_args()
    rs = data_mod.load_ruleset()
    if args.check:
        # 与 `export-trait-status.py --check` 同一套纪律：产物必须等于"现在重算"。
        # 排除 `headline`：它是**叙事**（由 `headline` 参数注入，默认为空），不是数据。
        if not os.path.exists(args.out):
            print(f"MISSING {args.out}：先跑一次不带 --check 的（会重写产物）")
            return 1
        with open(args.out, encoding="utf-8") as fh:
            disk = json.load(fh)
        fresh = build_coverage(rs)
        for doc in (disk, fresh):
            doc.pop("headline", None)
        if json.dumps(disk, ensure_ascii=False, sort_keys=True) != json.dumps(fresh, ensure_ascii=False, sort_keys=True):
            print("MISMATCH：覆盖台账与现在重算不一致")
            print("  现在重算 totals:", json.dumps(fresh["totals"], ensure_ascii=False))
            print("  磁盘台账 totals:", json.dumps(disk.get("totals", {}), ensure_ascii=False))
            print(f"  匿名实体：现在 {len(fresh.get('anonymous_entities', []))} 条 /"
                  f" 磁盘 {len(disk.get('anonymous_entities', []))} 条")
            print("  修法：cd roco && PYTHONPATH=src python3 -m roco_env.coverage")
            return 1
        print(f"check ok：{args.out} 与现在重算一致（可模拟 "
              f"{fresh['totals']['simulatable_entities']}/{fresh['totals']['entities']}，"
              f"匿名实体 {len(fresh.get('anonymous_entities', []))} 条）")
        return 0
    report = write_report(rs, args.out)
    worklist = build_trait_worklist(rs)
    os.makedirs(os.path.dirname(args.traits_out), exist_ok=True)
    with open(args.traits_out, "w", encoding="utf-8") as fh:
        json.dump(worklist, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    if args.json:
        print(json.dumps({k: report[k] for k in ("totals", "support_levels")}, ensure_ascii=False, indent=1))
    else:
        t = report["totals"]
        print(f"实体 {t['entities']}（战斗技能 {t['battle_skills']} / 特性 {t['traits']}）；"
              f"可模拟 {t['simulatable_entities']}（{t['simulatable_ratio']}）")
        for row in report["coverage_ranking"][:8]:
            print(f"  {row['total']:>4} 条 → {row['primitive']}（技能 {row['skills']} / 特性 {row['traits']}）")
        top = [r for r in worklist["worklist"] if r["readiness"] == "ready"][:5]
        print(f"特性清单：{worklist['totals']}；唯特性阻塞的精灵 {worklist['pets_blocked_by_traits']} 只")
        for row in top:
            print(f"  ready: {row['trait']}（触发 {row['trigger']}→{row['hook']}，解锁 {row['pets_blocked']} 只）")
        print(f"报告 → {args.out} / {args.traits_out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())


# ══════════════════════════════════════════════════════════════════════════
# 「两把尺子是一把」收口（2026-09-30 补回）
#
# 为什么要补：`service.py:112` 直接 `from .coverage import classify_skill_declared`，
# 而本文件缺这一族名字 ⇒ **整个 Python 服务在就绪前就退出**（8765 的
# `/api/roco/status` 报 `available:false`、`last_error` 是这条 ImportError）。
# 一次 WIP 快照（`b5a8d51`）把 `service.py` 的**新写法**提交了，却把本文件的
# **同一批新写法**漏在提交之外 ⇒ 提交进去的实现引用了一个从未落盘的名字。
#
# 这次补写只做**加法与必要的最小修正**，三条纪律全部沿用本仓既有口径：
#   · **认领只由证据算**：一个机制词算不算已结算，看它是否落在某条**真的产出的效果**
#     的 `evidence` 覆盖范围内（`parse.unclaimed_mechanic_spans` 就是那把尺子）；
#     不另抄一份手写白名单 —— 手抄清单在本仓漏过五次。
#   · **fail closed**：读不出来就说没结算（`PARTIAL`），绝不为了好看放宽。
#   · **声明了能力位才认领**：`declared=False` ⇒ 那条 resolver 一个字节都不产出，
#     legacy / v2 的 `unsupported` 与逐位读数不变。
#
# 明确**不重写**的东西（这些 HEAD 里已有，动它们就会改掉默认口径）：
#   `classify_skill` 的九条既有能力位链 · `build_coverage` · `declared_capabilities_of`
#   的既有十个键 · `resolve_claims` 的既有九步 · `loadout_reachability`。
#   下面只**增量**扩展（见各处 2026-09-30 注）。
# ══════════════════════════════════════════════════════════════════════════


#: 能力位 → `RuleConfig` 上**真正承载它的属性名**。逐条写明，**不按名字猜**
#: （反例：`foe_energy_loss` 的真名是 `energy_foe_energy_loss`，不是 `damage_` 前缀；
#: `multi_hit` 才是 `damage_multi_hit`）。前十个键与 `declared_capabilities_of` 的既有
#: 读法逐字一致。
_CAPABILITY_ATTR: Dict[str, str] = {
    # —— 既有十键（HEAD 的读法，逐字沿用）——
    "multi_hit": "damage_multi_hit",
    "slot_condition": "damage_slot_condition",
    "position_shift": "damage_position_shift",
    "cost_modifier": "energy_cost_modifier",
    "foe_energy_loss": "energy_foe_energy_loss",
    "initiative_condition": "damage_initiative_condition",
    "per_layer_cost": "energy_per_layer_cost",
    "foe_switch_condition": "damage_foe_switch_condition",
    "per_use_ramp": "damage_per_use_ramp",
    "on_hit_ramp": "damage_on_hit_ramp",
    # —— 扩展键（每一个都在 `parse.py` 里有同名的 resolver，见 `_RESOLVER_BY_CAPABILITY`）——
    "global_skill_mods": "damage_global_skill_mods",
    "cleanse_marks": "damage_cleanse_marks",
    "respond_override": "energy_respond_override",
    "respond_reduction_to_heal": "damage_respond_reduction_to_heal",
    "cond_self_debuff_power": "damage_cond_self_debuff_power",
    "self_power_flat": "damage_self_power_flat",
    "element_power_ramp": "damage_element_power_ramp",
    "element_use_ramp": "damage_element_use_ramp",
    "triggered_ramp": "damage_triggered_ramp",
    "per_own_debuff_cost": "damage_per_own_debuff_cost",
    "per_layer_boost": "damage_per_layer_boost",
    "moe_mark": "damage_moe_mark",
    "attack_stat_by_class": "damage_attack_stat_by_class",
    "stat_gain_extended": "stat_gain_extended",
    "stat_gain_flat": "stat_gain_flat",
}

#: 能力位 → `classify_skill` 的**形参名**（唯一映射表）。判据逐字这样用它
#: （`test_cond_self_debuff_power:109`、`test_moe_mark:89` 等九处）：
#:     `flags = {f: bool(caps.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}`
#:     `C.classify_skill(sk, **flags)`
#: ⇒ **值必须是 `classify_skill` 真收的形参名**，否则 splat 当场 TypeError。
#: 前九个沿用 HEAD 的形参名（`build_coverage` 与各判据都在按名调用，**不许改名**）。
_CAPABILITY_TO_FLAG: Dict[str, str] = {
    "multi_hit": "multi_hit_declared",
    "slot_condition": "slot_condition_declared",
    "position_shift": "position_shift_declared",
    "foe_energy_loss": "foe_energy_loss_declared",
    "initiative_condition": "initiative_declared",
    "per_layer_cost": "per_layer_cost_declared",
    "foe_switch_condition": "foe_switch_condition_declared",
    "per_use_ramp": "per_use_ramp_declared",
    "on_hit_ramp": "on_hit_ramp_declared",
    # —— 扩展族：每条都对应 `classify_skill` 新增的一个同名能力位形参 ——
    "global_skill_mods": "global_skill_mods_declared",
    "cleanse_marks": "cleanse_marks_declared",
    "respond_override": "respond_override_declared",
    "respond_reduction_to_heal": "respond_reduction_to_heal_declared",
    "cond_self_debuff_power": "cond_self_debuff_power_declared",
    "self_power_flat": "self_power_flat_declared",
    "element_power_ramp": "element_power_ramp_declared",
    "element_use_ramp": "element_use_ramp_declared",
    "triggered_ramp": "triggered_ramp_declared",
    "per_own_debuff_cost": "per_own_debuff_cost_declared",
    "per_layer_boost": "per_layer_boost_declared",
    "moe_mark": "moe_mark_declared",
    "stat_gain_extended": "stat_gain_extended_declared",
    # `stat_gain_flat` 是**子能力位**：它自己没有独立 resolver，但被 `moe_mark` /
    # `stat_gain_extended` 两条 resolver 读（`flat_declared=`）⇒ 必须进表，
    # 否则判据把它关掉时链上看不见（`test_moe_colon:74-81`）。
    "stat_gain_flat": "stat_gain_flat_declared",
}

#: HEAD 那九步已经在 `classify_skill` / `resolve_claims` 里逐条写死了（含各自的守卫与
#: 认领词），**不再走**下面这张表 —— 免得同一件事两处实现（本仓的老病）。
_HEAD_CAPABILITIES = ("multi_hit", "slot_condition", "position_shift", "foe_energy_loss",
                      "initiative_condition", "per_layer_cost", "foe_switch_condition",
                      "per_use_ramp", "on_hit_ramp")


def _claim_global_skill_mods(skill: Any, parsed: Any, caps: Dict[str, bool]) -> Any:
    """「获得全技能威力/能耗±N%」：**只认冒号体**（运行时真有写点的那条链）。

    ⚠ 2026-09-30（分计划 00 · 族③ 收窄）：**非冒号体不再认领** —— 认领必须要求
    env 真有写点（运行时报据），不是"文本读得出来"就算结算。

    逐行运行时报据（真开局、真出招，每条试 6 个敌手动作；原文见 `plan00-family3.md`）：
      · **冒号体** `721 赤子之心` / `728 撒娇` ⇒ `mark_added` + **`global_skill_mod_applied`**
        （`cost_delta:-2` / `power_pct:+10`，`global_skill_mods` 真的被写）；
      · **非冒号体** `430 水环` / `441 洗礼` / `531 冰晶坠` / `532 冰雹` / `534 冰冻光线`
        / `682 防御反击` ⇒ 6×6 个组合里 **一次 `global_skill_mod_applied` 都没有**，
        两边 `global_skill_mods` 恒为 `{}`（对照：同时段 `721`/`728` 每次都发）。

    结构依据（只读得到的）：非冒号体在 `env.py:1295`（防御支）/`:1396`（攻击支）/`:1869`
    （状态支）三处都挂在 `cfg.damage_global_skill_mod_text` 上，而 `RuleConfig` **没有这个叶子**
    （`rule_config.py` 全文件 0 命中）⇒ `getattr(..., False)` 恒 False ⇒ 那三次
    `resolve_global_skill_mod(...)` 永远不产出 ⇒ 写点走不到。（该叶子的接线曾被回退，
    `docs/roco/coach-理想形态-计划书-2026-09-30.md` §"回退" 有记录。）
    ⇒ 这不是"认领入口写错"（B），是**运行时不结算**（A）⇒ 不认领，缺口如实登记。

    ⚠ 收窄只动本族：
      · 冒号体仍由 `resolve_moe_colon(global_declared=…)` 认领（`721`/`728` 不动）；
      · `667 化劲` / `680 提气` / `776 力量吞噬` 也是非冒号体，但它们的文本**另有**
        `stat_gain_extended` 那条链产出（实测 `buff_self` / `debuff_foe`）⇒ 仍留在可模拟档。
    ⚠ **不跨域改** `env.py`（属 01 写域）：`damage_global_skill_mod_text` 三处 `getattr`
    要么接线、要么删死代码，留给下一轮；本次只让台账别把"没写点"说成已结算。
    """
    return parse_mod.resolve_moe_colon(skill, declared=True, parsed=parsed,
                                       global_declared=True)


def _claim_moe_mark(skill: Any, parsed: Any, caps: Dict[str, bool]) -> Any:
    """萌化那一族**两条写法都要认**（缺一条就是"同族两处一个说法"）：

      · 冒号体「<谁>获得萌化：<效果>」⇒ `resolve_moe_colon`（task-28 · `720 示弱`）；
      · 转移体「将自己的萌化转移给敌方」⇒ `resolve_mark_transfer`（task-28 · `722 反弹`）。

    ⚠ `flat_declared` 必须**真的接上 `stat_gain_flat` 这个能力位**（不能写死 True）——
    `test_moe_colon:74-81` 会把它关掉再要求「判据 False 且档位 PARTIAL」。
    """
    parsed = parse_mod.resolve_moe_colon(
        skill, declared=True, parsed=parsed,
        flat_declared=bool(caps.get("stat_gain_flat", False)),
        power_declared=bool(caps.get("self_power_flat", False)))
    return parse_mod.resolve_mark_transfer(skill, declared=True, parsed=parsed)


def _claim_element_power_ramp(skill: Any, parsed: Any, caps: Dict[str, bool]) -> Any:
    """「<系>技能威力永久±N%」。

    ⚠ 2026-09-30（`test_element_power_ramp_defense_transition:70` 逐字）：**防御支的应对子句
    要显式放宽** —— 「放宽的方式是**调用点显式声明**：`allow_respond_clause=True`」
    （`parse.py:983`）。`463 点亮`「减伤90%，应对攻击：自己获得光系技能威力永久+50%。」就卡在这：
    位置闸不放宽 ⇒ 那条基础子句永远差一条 effect ⇒ 判据恒 False。
    所以这里按**同一套纪律**声明放宽（只在 `respond_override` 被声明时），不是把闸删掉。
    """
    return parse_mod.resolve_element_power_ramp(
        skill, declared=True, parsed=parsed,
        allow_respond_clause=bool(caps.get("respond_override", False)))


def _claim_stat_gain_extended(skill: Any, parsed: Any, caps: Dict[str, bool]) -> Any:
    return parse_mod.resolve_stat_gain_extended(
        skill, declared=True, parsed=parsed,
        flat_declared=bool(caps.get("stat_gain_flat", False)))


#: 能力位 → 产出效果的那个 resolver（签名统一 `(skill, parsed, caps)`）。**唯一映射表**
#: （不许在别处再手抄一份）。只有**逐个读到过函数体**、且语义与该能力位 1:1 的才登在这里；
#: 登不上的一律不写 ⇒ 那条家族停在 `PARTIAL`（fail closed），**绝不含糊地当已结算**。
_RESOLVER_BY_CAPABILITY: Dict[str, Any] = {
    "global_skill_mods": _claim_global_skill_mods,
    "cleanse_marks": lambda skill, parsed, caps: parse_mod.resolve_cleanse_marks(
        skill, declared=True, parsed=parsed),
    "respond_override": lambda skill, parsed, caps: parse_mod.resolve_respond_override(
        skill, declared=True, parsed=parsed),
    "respond_reduction_to_heal": lambda skill, parsed, caps: parse_mod.resolve_respond_reduction_to_heal(
        skill, declared=True, parsed=parsed),
    "cond_self_debuff_power": lambda skill, parsed, caps: parse_mod.resolve_self_debuff_power(
        skill, declared=True, parsed=parsed),
    "element_power_ramp": _claim_element_power_ramp,
    "element_use_ramp": lambda skill, parsed, caps: parse_mod.resolve_element_use_ramp(
        skill, declared=True, parsed=parsed),
    "triggered_ramp": lambda skill, parsed, caps: parse_mod.resolve_triggered_ramp(
        skill, declared=True, parsed=parsed),
    "per_own_debuff_cost": lambda skill, parsed, caps: parse_mod.resolve_cost_per_own_debuff_layer(
        skill, declared=True, parsed=parsed),
    "per_layer_boost": lambda skill, parsed, caps: parse_mod.resolve_per_layer_boost(
        skill, declared=True, parsed=parsed),
    "moe_mark": _claim_moe_mark,
    "stat_gain_extended": _claim_stat_gain_extended,
    "attack_stat_by_class": _claim_stat_gain_extended,
}

#: `self_power_flat` 没有独立 resolver：`parse` 里那条「本次技能威力±N」是**旧正则**，
#: 无条件产出。按「声明了才认领」的同一套纪律，**未声明时把这类效果收回**（不是另写一份解析）。
_SELF_POWER_FLAT_KINDS = ("self_power_flat",)


def _withdraw_kinds(parsed: Any, kinds: Any) -> Any:
    """把 `kinds` 这几类效果从 `parsed.effects` 里收回 ⇒ 那一段文本重新变成未认领。"""
    _kinds = set(kinds)
    parsed.effects = [e for e in getattr(parsed, "effects", []) or []
                      if getattr(e, "kind", "") not in _kinds]
    return parsed


#: 扩展族的**执行顺序**（⚠ 顺序有意义）：能产出"基础子句"的族排在**覆盖体**（`respond_override`）
#: 之前 —— 覆盖体需要"被覆盖的对象"已经存在（`parse.py:1124` 的纪律；`462 放晴` 就是栽在这）。
_FAMILY_CLAIM_ORDER = (
    "element_power_ramp", "moe_mark", "cleanse_marks", "global_skill_mods",
    "respond_reduction_to_heal", "triggered_ramp", "element_use_ramp",
    "per_layer_boost", "per_own_debuff_cost", "cond_self_debuff_power",
    "stat_gain_extended", "attack_stat_by_class", "respond_override",
)


def _apply_capability_resolvers(skill: Any, caps: Dict[str, bool], parsed: Any,
                                *, skip: Any = ()) -> "tuple[Any, List[str]]":
    """按**能力声明**把扩展族的 resolver 接在既有链后面，返回 `(parsed, claimed)`。

    认领仍然**只由证据算**：这些 resolver 产出的每条效果都带 `evidence`，于是
    `parse.unclaimed_mechanic_spans(skill, parsed=parsed)` 自然不再报那一段 ——
    不需要、也不许在这里另抄一份机制词名单。
    """
    claimed: List[str] = []
    # 2026-09-30（按逐行审计修一处**假阴性**）：**"基础子句"要排在"覆盖体"之前跑**。
    # `462 放晴`「光系技能威力永久+50%，应对防御：改为永久+100%」：`resolve_element_power_ramp`
    # 必须先产出基础 effect，`resolve_respond_override` 的覆盖体才有"被覆盖的对象"可摘
    # （`parse.py:1124` 逐字写着这条纪律）。以前按表顺序跑、`respond_override` 在前
    # ⇒ 基础认领不到 ⇒ 判据恒 False（而真打一手：对手出防御时
    # `respond_override_applied` + `element_power_ramp(delta=100)` 都真的发）。
    _ordered = [n for n in _FAMILY_CLAIM_ORDER if n not in skip]
    for name in list(_ordered) + [n for n in _CAPABILITY_TO_FLAG if n not in _ordered]:
        if name in _HEAD_CAPABILITIES or name in skip:
            continue
        if not caps.get(name, False):
            continue
        fn = _RESOLVER_BY_CAPABILITY.get(name)
        if fn is None:
            continue
        before = len(getattr(parsed, "effects", []) or [])
        parsed = fn(skill, parsed, caps)
        if len(getattr(parsed, "effects", []) or []) > before:
            claimed.append(name)
    if not caps.get("self_power_flat", False):
        parsed = _withdraw_kinds(parsed, _SELF_POWER_FLAT_KINDS)
    return parsed, claimed


def _capability_readings(config_id: Any = "mobile_s4_candidate_v3") -> Dict[str, bool]:
    """扩展族的**同一份能力读数**（既有十键仍由 `declared_capabilities_of` 出）。

    读不到的配置（例如 legacy）⇒ 全部 `False` ⇒ 一个字节都不认领（fail closed）。
    """
    try:
        from . import rule_config as _rc
        cfg = _rc.get_rule_config(config_id)
    except Exception:
        return {name: False for name in _CAPABILITY_ATTR}
    return {name: bool(getattr(cfg, attr, False)) for name, attr in _CAPABILITY_ATTR.items()}


# ── 判据口径用的三张表 + 跳步正则（settlement_verdict 与档位共用）──────────────

#: 「描述里写了、且引擎真的会出这一手」的**类**（类名, 触发词）。命中 ⇒ 记进 `settled`。
#: 形状与既有实现一致（`[类名, [触发词…]]` 的列表）。
#:
#: 类名/覆盖面来自**三处已落盘的读数**（缺一不可）：
#:   · `_settlement_lists-抽取前基线-2026-09-30.md`：原版语义 + 指纹 + 「`settled` 非空 535 / 空 44」；
#:   · 由**丢失的那版实现**生成的 `roco/tests/data/pets100-skills-census.json`：类名与频次
#:     （伤害 89 · 应对 67 · 持续状态层数/回合 26 · 双攻升降 24 · 减伤 24 · 印记层数累加 13 · 驱散 11 …）；
#:   · 各判据 `assertIn` 逐字点名的类名（转移标记 / 本手威力加成 / 全技能持久修正）。
#: ⚠ **「伤害」这一类不许用裸词**：`389 充分燃烧`「触发1次灼烧伤害」里也有「伤害」二字，
#:   而它必须 `resolved=False`（E 堆）。所以只认「造成物伤 / 造成魔伤」这种**真的出兵**的写法。
#: ⚠ 本表**只按文本子串**认类 ⇒ 看不见"文本读不出来、但引擎真有结算支"的那几族；
#:   那一族走下面 `_SETTLED_EFFECT_CLASSES`（**按效果 kind**，2026-09-30 补）。
SETTLED_PATTERNS = (
    ("伤害", ("造成物伤", "造成魔伤", "造成物理伤害", "造成魔法伤害")),
    ("减伤", ("减伤",)),
    ("应对", ("应对",)),
    ("能量回复", ("能量回复",)),
    ("持续状态层数/回合", ("层",)),
    ("双攻升降", ("双攻", "物攻", "魔攻", "物防", "魔防", "速度")),
    ("印记层数累加", ("印记",)),
    ("驱散", ("驱散",)),
    ("转移标记", ("转移",)),
    # 萌化标记：`env` 真的把它路由到 `PetState.marks`（`STATUS_AS_MARK`）⇒ 是一类
    # "引擎会出这一手"的机制。`test_moe_mark` / `test_moe_bidirectional` / `test_moe_colon`
    # 都要求「`resolved` True **且 `settled` 非空**」；而 `273 休息回复`（只有 heal、
    # 没有这一类）照旧 `settled` 空 ⇒ 仍判 False（两条不冲突，靠的是**这个类只匹配萌化**）。
    ("萌化标记", ("萌化",)),
    ("本手威力加成", ("本次技能威力",)),
    ("全技能持久修正", ("全技能",)),
)

#: **按效果 kind 认的已结算类**（`SETTLED_PATTERNS` 的姊妹表 · 2026-09-30 分计划 00 补）。
#:
#: 为什么必须**按 kind** 而不是往上面那张文本表里加词：那张表是**子串匹配**
#: （`any(word in desc)`），而语料里
#:   · 「回复N%生命」与「回复N能量」用的是**同一个词**「回复」⇒ 加一个「回复」类，
#:     两个 kind 混成一个标签；拆成两类则会给「只回能」的技能贴「回复生命」；
#:   · 「偷取」还出现在「偷取**印记**」（650/655）里；「失去」还出现在「自己每失去5%生命」
#:     （266/321/406/774/796）里 ⇒ 按宽词加类会给**与能量无关的行贴「扣能」标签**。
#: 按 kind 则**只有真的产出那条效果的行**才拿到类 —— 与「认领只由证据算、不另抄词表」
#: 同一条纪律（`_apply_capability_resolvers` 的注释）。
#:
#: 四类各自对应 `env._apply_effect_batch` 里**真有写点**的分支（真打一手读数见
#: `reports/roco/product-execution/00/plan00-settled-patterns-gap.md`）：
#:   · `heal`                 ⇒ 发 `heal` 事件                 （273 休息回复 / 346 根吸收）
#:   · `self_energy`          ⇒ 发 `energy_gain` 事件           （344 徒长 / 346 / 472 杠杆置换）
#:   · `drain_energy`         ⇒ 发 `drain_energy` 事件          （756 勾魂）
#:   · `foe_team_energy_loss` ⇒ 发 `foe_team_energy_loss` 事件  （762 小型打劫）
#: ⚠ 只列**这四类**（不少列、也不多列）：多列会让"文本里没有、效果里有"的行多拿标签，
#:   而它们本来就已经 `resolved=True`（例：747/742/763 的 `foe_energy_loss` 单点扣能）——
#:   本次的目的是补**假阴性**那六行，不是重建整张表。
_SETTLED_EFFECT_CLASSES = (
    ("heal", "回复生命"),
    ("self_energy", "回能"),
    ("drain_energy", "吸取能量"),
    ("foe_team_energy_loss", "扣能"),
)

#: **没拉起的原语**：描述里出现这些词 ⇒ 引擎还没有对应的结算支 ⇒ 一律记未结算。
#: 逐个都有运行时报据（`test_tier_verdict_agreement` 的 F 堆）。
UNSETTLED_WORDS = ("冻结", "引电", "萌化", "吸血", "天气", "离场", "迅捷")

#: 解析得出效果、但引擎**没有结算分支**的 kind（`test_tier_verdict_agreement` 的
#: 「脱离/返场」那一族就是 `escape`）。判据与档位**共用同一个名字**（可被一处关掉）。
UNSETTLED_EFFECT_KINDS = ("escape", "weather", "self_lifesteal")

#: 「这个词由**哪条已声明能力**真拉起」。**空元组 = 引擎里根本没有它的结算支** ⇒
#: 只要描述里出现就算未结算（fail closed）。逐词写明的理由见每行的注释。
_UNSETTLED_WORD_SETTLERS: Dict[str, Any] = {
    # 「敌方获得1层萌化」现在由 `damage.moe_mark` 路由到 `PetState.marks`（task-28 · 285 退化
    # 起）⇒ **有 settler**：还要真有一条覆盖它的效果才算结算。
    "萌化": ("moe_mark",),
    # 下面六个**没有结算支**（实测）：冻结的回合末结算未实现（只做"获得层数"）、
    # 引电的两层触发未实现、吸血只有一行 docstring（`self_lifesteal`）、
    # 天气与离场同样、迅捷也没有。⇒ 一律未结算。
    "冻结": (),
    "引电": (),
    "吸血": (),
    "天气": (),
    "离场": (),
    "迅捷": (),
}

#: **诊断形状**（类名, 正则）：描述里有这个形状、而**没有任何效果覆盖它** ⇒ 记缺口。
#: `test_cond_self_debuff_power:125-128` 逐字点名了「条件：自身增益/减益」这一条：
#: 它**不是** span 给的，是靠**效果的 evidence 覆盖**消失的 —— 所以能力位关掉时它必须回来
#: （那正是 `test_two_gates_each_required` 的反证方向）。
_DIAGNOSTIC_SHAPE_PATTERNS = (
    ("条件：自身增益/减益", _re.compile(r"(?:自己|自身)?(?:有|存在)(?:增益|减益)")),
    # 「层数驱动」那一族（census 里三种逐字写法：`敌方每有1层中毒效果` /
    # `使敌方精灵减益的层数翻倍` / `双方携带的所有精灵每有1层萌化`）——
    # `test_respond_override:477` 要 `624/626/618` 的 `unsettled` 里出现「层数驱动」。
    ("层数驱动", _re.compile(r"每有\s*\d+\s*层|层数翻倍")),
    # ── 2026-09-30（按逐行审计补回丢失的形状；`test_effect_coverage:682-690` 逐字点名过这批）──
    # ⚠ **判法是"形状在 desc 里 且 没有任何效果的 evidence 覆盖它"** ⇒ 天然**按半句**：
    # ⚠ 2026-09-30（分计划 00 · **改正与实测不符的注释**；harness-verifier 指出）：
    #   本注释原文写「`313 天旋地转`/`581 电弧` 的「迸发：本次技能威力+N」**真有 effect** ⇒
    #   被 evidence 盖住、**不记缺口**」——**那是错的**：解析层对这一段**不产出 effect**
    #   （`effects.effective_power()` 是结算期读文本，不是解析效果）⇒ 实测两行的
    #   `diagnostic_shape_gaps` **都是 `['迸发']`**、档位 `PARTIAL`（`verify-family2` 与
    #   `plan00-584-burst-evidence.md` 的逐项读数）。
    #   ✅ **运行时那半句是对的**：`effects.py:270-277` + `env.py:1266` 真的按迸发窗口加威力
    #   —— 真打一手 `power_used` 60→90（313）/ 80→120（581）/ 35→55（584），
    #   `conditional_reason="迸发 → 威力 +N"`。⇒ 即：**引擎真结算，但诊断形状仍记缺口**，
    #   这是「306 vs 309」那条**待裁决**的分叉（584 取证件 §5 给了三个选项），**本轮不动结论**。
    #   而 `583 超导`「迸发：本技能能耗-2」、`598 双联脉冲`「使用次数+1」**运行时也确实不结算**
    #   （583 真打一手两回合都付 3 点能耗、`power_used` 不变）⇒ 记缺口是对的。
    #   这一条正是审计里「21 行判宽」的第 ① 族（11 行）。
    ("条件：生命阈值", _re.compile(r"生命\s*(?:大于|小于|高于|低于|不低于|不超过)\s*\d+\s*%")),
    ("体重/吨位条件", _re.compile(r"体重|吨位")),
    ("面板比值条件", _re.compile(r"(?:速度|物防|魔防|攻击|双攻|血量|生命)比")),
    ("混血条件", _re.compile(r"混血")),
    ("固定能耗", _re.compile(r"能耗固定|固定为\s*\d+\s*点?\s*能耗")),
    ("使用次数", _re.compile(r"使用次数")),
    ("无视抵抗", _re.compile(r"无视[^，。；]*抵抗")),
    ("效果未定义", _re.compile(r"不同效果")),
    ("迸发", _re.compile(r"迸发")),
    # `383 持续高温`/`145`/`146`/`147`：应对子句的**后半**（「下次…」）没结算。
    ("应对后半（下次）", _re.compile(r"应对[^，。；]*[：:][^，。；]*下次")),
)

#: 「应对…：**本次技能威力**…」的**前缀形状**（`effects.effective_power()` 真的按倍率改这一手
#: 的威力）。⚠ 它只是**前缀**：`skill_000398 炙热波动`「应对状态：本次技能威力**和赋予灼烧翻倍**」
#: 也命中它，但后半段（灼烧翻倍）引擎一个字节都没实现 ⇒ **命中前缀 ≠ 整条结算**。
#: 所以「这一段算不算已结算」一律走下面的 `_is_settled_respond_power_clause()`（整条分句才算），
#: 这个前缀正则只留给「描述里有没有这个形状」的诊断读数（`test_effect_coverage:209` 逐字用它）。
#:   · `skill_000255 突袭`「应对状态：本次技能威力变为3倍」 ✓ 整条
#:   · `skill_000383 持续高温`「应对状态：**下次**攻击技能威力翻倍」 ✗ 不命中（它确实没结算）
#:   · `skill_000533 极寒领域`「应对状态：使冻结翻倍」 ✗ 不命中
RESPOND_POWER_SETTLED_RE = _re.compile(r"应对(?:状态|攻击|防御)?\s*[:：]\s*本次技能威力")

#: 2026-09-30（分计划 00 · 族② 收窄）：**整条分句**都是那个已结算形状才算已结算。
#: 逐行实测（579 条战斗技能里旧口径会跳掉的分句共 **12** 条）：
#:   · **11 条**是完整形状（「应对状态：本次技能威力变为N倍」/「…翻倍」）⇒ 照旧放行；
#:   · `skill_000398 炙热波动`「应对状态：本次技能威力**和赋予灼烧翻倍**」⇒ 只命中前缀
#:     ⇒ 不再整句放行（后半段没有产出效果 ⇒ 记 `respond_clause_gaps`）。
#: 真打一手（应对成功）两向读数：`398` 的威力那半**真的翻了**（`power_used` 55→110，
#: `conditional_reason="应对成功 → 威力翻倍"`），而「赋予灼烧翻倍」那半**零事件、层数没翻**
#: ⇒ 同一条分句里的两半必须分开判（两把尺子共用同一把）。
RESPOND_POWER_SETTLED_CLAUSE_RE = _re.compile(
    r"应对(?:状态|攻击|防御)?\s*[:：]\s*本次技能威力(?:变为|改为)?\s*(?:\d+(?:\.\d+)?\s*倍|翻倍)")


def _is_settled_respond_power_clause(clause: str) -> bool:
    """这条**分句整条**就是「应对…：本次技能威力N倍/翻倍」这个已结算形状吗？

    ⚠ 不许退化成 `search()`：`398` 那种「…本次技能威力**和赋予灼烧翻倍**」只命中前缀，
    后半段是另一条机制而引擎没有产出 —— 命中前缀就整句放行 = 把未结算说成已结算。
    """
    return bool(RESPOND_POWER_SETTLED_CLAUSE_RE.fullmatch(str(clause or "").strip()))


def _has_settled_respond_power_clause(skill: Any) -> bool:
    """描述里有没有**整条分句**就是那个已结算形状（`classify_skill` 那条早退用）。

    ⚠ 别再写成 `RESPOND_POWER_SETTLED_RE.search(desc)`：那是**全描述**级的前缀命中，
    与「只放行命中那一段」同一条纪律冲突（实测该收窄对当前语料的影响 = 0 行，
    属**留着一个洞**而不是改读数 —— 见 `plan00-family2.md` 的爆炸半径读数）。
    """
    desc = str(getattr(skill, "desc", "") or "")
    return any(_is_settled_respond_power_clause(c) for c in _CLAUSE_SPLIT_RE.split(desc))


def _flags_of(caps: Optional[Dict[str, bool]]) -> Dict[str, bool]:
    """能力读数 → `classify_skill` 的形参表（唯一映射表展开）。`None` = 取候选口径。"""
    caps = _capability_readings() if caps is None else caps
    return {flag: bool(caps.get(name, False))
            for name, flag in _CAPABILITY_TO_FLAG.items()}


def claimed_mechanic_words(parsed: Any, flags: Dict[str, bool]) -> set:
    """**已声明能力认领掉的机制词**（唯一实现：档位与判据都调这一个）。

    为什么需要单独一张词表：有些认领**不是**靠产出效果，而是靠把 `parsed.unparsed`
    里的标记摘掉（连击 / 号位 / 传动…），那些词在 `unclaimed_mechanic_spans` 眼里
    仍然"没人认领"。这里按**同一份 flags** 如实列出它们，两把尺子就不会各说各话。
    """
    words = set()
    # 2026-09-30：**「N连击」这一段的认领是"解析层读出来了"就算**，不要求 N>1 ——
    # 实测两处被它卡住：`689 疾风刺`「造成物伤，**1连击**，若先于敌方攻击，改为3连击。」
    # （基础那半永远是 1 连击）与 `257`（`test_respond_override:…static_one_hit_is_credited_under_v3`
    # 逐字要求「明写 1连击」必须被认领）。`parse` 真的读出了 `hit_count`、`env` 真的按它出兵，
    # 所以那一段没有"没实现"的成分；动态连击数（`unparsed` 里的「动态…」）照旧不算认领。
    if flags.get("multi_hit_declared") and getattr(parsed, "hit_count", None):
        words.add("连击")
    if flags.get("slot_condition_declared") and getattr(parsed, "slot_conditions", None):
        words.add("号位")
    if flags.get("position_shift_declared") and getattr(parsed, "position_shift", None) is not None:
        words.add("传动")
    if flags.get("initiative_declared") and getattr(parsed, "initiative_power", None):
        words.add("若")
    if flags.get("foe_energy_loss_declared"):
        words.add("能量")
    if flags.get("per_layer_cost_declared") and getattr(parsed, "per_layer_cost", None):
        words.update(("每", "层"))
    if flags.get("foe_switch_condition_declared") and getattr(parsed, "foe_switch_effects", None) \
            and not getattr(parsed, "foe_switch_leftover", ""):
        words.update(("若", "回合"))
    if flags.get("per_use_ramp_declared") and getattr(parsed, "per_use_ramp", None):
        words.add("每")
    if flags.get("on_hit_ramp_declared") and getattr(parsed, "on_hit_ramp", None):
        words.update(("每", "连击"))
    if flags.get("respond_override_declared"):
        _ov = getattr(parsed, "respond_override", None) or {}
        if _ov.get("effects") and not _ov.get("leftover"):
            words.update(("获得", "层", "应对"))
    return words


def residual_mechanic_spans(skill: Any, parsed: Any, claimed_words: Any = ()) -> List[str]:
    """**残余片段**的唯一实现：`unclaimed_mechanic_spans` 减两道过滤。

    ① 已声明能力认领掉的词（`claimed_mechanic_words`）；
    ② **已结算的形状** —— 「应对…：本次技能威力…」，`effects.effective_power()` 真的
       按倍率改这一手的威力（两把尺子共用 `_is_settled_respond_power_clause()`，
       不各写一份）。⚠ 只对有静态威力的技能生效：状态类技能描述里出现同样字样
       并不代表引擎会结算（`skill_000389` 的假绿就是这么来的）。
    ⚠ 2026-09-30（分计划 00 · 族②）：② 从「`search()` 命中前缀就跳」收窄成
       「**整条分句**都是那个形状才跳」—— `398` 的「本次技能威力**和赋予灼烧翻倍**」
       只命中前缀，后半段没有产出，必须记缺口（实测影响 = 398 一行，见 `plan00-family2.md`）。
    """
    _claimed = set(claimed_words or ())
    _has_power = bool(getattr(skill, "has_static_power", False))
    out: List[str] = []
    for span in parse_mod.unclaimed_mechanic_spans(skill, parsed=parsed):
        text = str(span)
        word, _, clause = text.partition("：")
        if word in _claimed:
            continue
        if _has_power and _is_settled_respond_power_clause(clause or text):
            continue
        out.append(text)
    return out


#: 一句话里出现「应对」的分句切分（判据口径与 `parse` 的分句法一致：，。；）
_CLAUSE_SPLIT_RE = _re.compile(r"[，。；]")


def respond_clause_gaps(skill: Any, parsed: Any) -> List[str]:
    """**逐句判「应对」子句结算了没有**（唯一实现：档位与判据都调这一个）。

    判定与 `parse.unclaimed_mechanic_spans` 同一把尺子：一条分句只在这两种情况算已结算 ——
      · 它的文本落在某条**已产出效果**的 `evidence` 里（含 `respond_override` 的覆盖体）；
      · 它**整条**就是「应对…：本次技能威力…」那个已结算形状（有静态威力时）。
    其余一律算缺口 ⇒ fail closed（`skill_000383 持续高温`「应对状态：下次攻击技能威力翻倍」
    就是被这条抓住的：那句话引擎一个字节都没实现）。
    ⚠ 2026-09-30（分计划 00 · 族②）：「整条」是**收窄后**的口径 —— 旧写法 `search()`
    只要命中前缀就放行整句，于是 `398 炙热波动`「应对状态：本次技能威力**和赋予灼烧翻倍**」
    的后半段（没有产出效果）被当成已结算（真打一手：威力翻了、灼烧层数没翻）。
    """
    desc = str(getattr(skill, "desc", "") or "")
    if "应对" not in desc:
        return []
    evidence = [ev for ev, _kind in _effect_evidences(parsed)]
    _has_power = bool(getattr(skill, "has_static_power", False))
    # 防御技能那条路**真的读得到应对类别**（`effects.respond_to()`，`env._execute` 的防御分支），
    # 所以它那条光秃秃的「应对攻击」不算缺口 —— 这是有运行时依据的豁免，不是放宽。
    _is_defense = bool(getattr(skill, "is_defense", False))
    gaps: List[str] = []
    for clause in _CLAUSE_SPLIT_RE.split(desc):
        clause = clause.strip()
        if "应对" not in clause:
            continue
        if any(e and e in clause for e in evidence):
            continue
        if _is_defense and _re.fullmatch(r"应对(?:状态|攻击|防御)?", clause):
            continue
        if _has_power and _is_settled_respond_power_clause(clause):
            continue
        gaps.append(f"应对：{clause}")
    return gaps


def compound_clause_gaps(skill: Any, parsed: Any) -> List[str]:
    """**一个子句里两条机制、只结算了一条**的缺口。

    与 `diagnostic_shape_gaps` 是姐妹（`compound_clause_gaps` 这个名字与分工在
    `BATCH-1…md:16275` 里逐字记着）。只认有运行时报据的那一种形状 ——
    `289 无畏之心`「减伤100%，应对攻击：减免的伤害变为回复自己生命，且本技能能耗永久+2。」：
      · 两条都声明了（`respond_reduction_to_heal` + `triggered_ramp`）⇒ resolver 各产出一条
        带 `evidence` 的效果 ⇒ **`[]`**（该说已结算就说已结算）；
      · 拿**裸 `parse_skill`**（没跑认领链）⇒ 恰好两条：`减免转回复…` 与 `永久修正…`
        （判据 `test_respond_reduction_to_heal:150-152` 逐字要这两个词）。
    只报这一族：别的形状报不出来就不报（缺口宁可少报，档位只因此更保守）。
    """
    desc = str(getattr(skill, "desc", "") or "")
    if "减免" not in desc or "回复" not in desc or "永久" not in desc:
        return []
    evidence = [ev for ev, _kind in _effect_evidences(parsed)]
    gaps: List[str] = []
    _heal_half = "减免的伤害变为回复"
    _ramp_half = "能耗永久"
    if not any(_heal_half in e for e in evidence):
        gaps.append(f"减免转回复：{_heal_half}自己生命（这一段没有产出效果）")
    if not any(_ramp_half in e for e in evidence):
        gaps.append(f"永久修正：本技能{_ramp_half}（这一段没有产出效果）")
    return gaps


def _initiative_claim_label(parsed: Any) -> str:
    """「先手条件」那条效果的认领标签。

    ⚠ 2026-09-30 修一处**独立缺陷**：`parse.py:2096` 给 `initiative_power` 加了第二种形状
    `hits`（task-28「若先于敌方攻击，改为N连击」），而本文件两处还在硬读 `['pct']`
    ⇒ 语料里只要出现那条形状就 `KeyError`（实测 9 个判据红、`build_coverage` 直接跑不完）。
    这里按**生产者已有的两种形状**如实报，语义一个字没改。
    """
    info = getattr(parsed, "initiative_power", None) or {}
    if "pct" in info:
        return f"先手条件（威力+{int(info['pct'])}%）"
    return f"先手条件（连击×{int(info['hits'])}）"


def _effect_evidences(parsed: Any) -> List["tuple[str, str]"]:
    """`(evidence 原文, 效果 kind)` —— 同上，`respond_override` 的覆盖体也算。"""
    out: List[Any] = []
    for e in getattr(parsed, "effects", []) or []:
        ev = str(getattr(e, "evidence", "") or "")
        if ev:
            out.append((ev, str(getattr(e, "kind", "") or "")))
    for _ov in ((getattr(parsed, "respond_override", None) or {}).get("effects") or []):
        ev = str(getattr(_ov, "evidence", "") or "")
        if ev:
            out.append((ev, str(getattr(_ov, "kind", "") or "")))
    return out


def _evidence_ranges(skill: Any, parsed: Any) -> List["tuple[int, int, str]"]:
    """描述里**被某条效果认领的字符区间** `(lo, hi, kind)` —— 全文件只有这一处算它。"""
    desc = str(getattr(skill, "desc", "") or "")
    out: List[Any] = []
    for ev, kind in _effect_evidences(parsed):
        i = desc.find(ev)
        if i >= 0:
            out.append((i, i + len(ev), kind))
    return out


def unsettled_mechanic_gaps(skill: Any, parsed: Any, claimed_words: Any = (),
                            caps: Optional[Dict[str, bool]] = None) -> List[str]:
    """**两条共用闸合并读数**：① 逐句判「应对」子句 ② 没拉起的原语词。

    为什么合成一个函数：判据那侧的反证要求「把这两条闸关掉 ⇒ 两把尺子重新打架」
    （`test_tier_verdict_agreement:83`），所以它们必须是**可被同一处 monkeypatch 关掉**的
    模块级名字，而且档位与判据调的是**同一个**。

    「没拉起的原语」判法（fail closed，**不靠手抄文本名单**）：
    每个词只说得出"哪条已声明能力真把它拉起来了"才算结算 —— 逐词写明，写在
    `_UNSETTLED_WORD_SETTLERS` 里；**空元组 = 谁都没拉起 ⇒ 永远算未结算**
    （冻结 / 引电的回合末结算、吸血的 `self_lifesteal`、天气、离场、迅捷在引擎里
    都没有结算支，这是实测结论，不是猜）。有 settler 的词（例如「萌化」由
    `moe_mark` 路由到 `marks`）还要**真的有一条覆盖它的效果**才算结算。
    """
    desc = str(getattr(skill, "desc", "") or "")
    claimed = {str(x) for x in (claimed_words or ())}
    ranges = _evidence_ranges(skill, parsed)
    out: List[str] = list(respond_clause_gaps(skill, parsed))
    # 2026-09-30：**复合子句那条闸也要接上** —— 「一个子句里两条机制、只结算了一条」是
    # `test_respond_reduction_to_heal:test_tier_flips_to_partial_when_ramp_is_undeclared`
    # 钉的假绿：关掉 `triggered_ramp` 而 `respond_reduction_to_heal` 还开着时，
    # `resolve_respond_override` 仍可能把整条子句的 evidence 盖住 ⇒ 只看"有没有被覆盖"
    # 会漏掉"另一半没结算"。两把尺子都必须看见它。
    out.extend(compound_clause_gaps(skill, parsed))
    out.extend(diagnostic_shape_gaps(skill, parsed))
    _kinds = {getattr(e, "kind", "") for e in getattr(parsed, "effects", []) or []}
    for kind in UNSETTLED_EFFECT_KINDS:
        if kind in _kinds:
            out.append(f"解析得出但没有结算分支：{kind}")
    for word in UNSETTLED_WORDS:
        if word in claimed:
            continue
        idx = desc.find(word)
        if idx < 0:
            continue
        settlers = _UNSETTLED_WORD_SETTLERS.get(word, ())
        covering_kinds = [k for lo, hi, k in ranges if lo <= idx < hi]
        if not covering_kinds:
            out.append(word)                      # 没有任何效果覆盖它 ⇒ 引擎没拉起
            continue
        if not _settlers_on(settlers, caps):
            out.append(word)                      # 没有哪条"真拉起它"的能力位被声明
    return out


def _settlers_on(names: Any, caps: Optional[Dict[str, bool]] = None) -> bool:
    """这些能力位里有没有被声明。

    ⚠ **必须用调用方那份 `declared`**（不是一律取候选口径）：判据的反证会显式把
    `moe_mark` 关掉再要求「判据说未结算」（`test_moe_mark:101-104`）。默认口径只在
    **没传**的时候兜底（`caps=None`）。这一条曾经写错成"永远取候选口径"，
    结果关掉能力位也照样说已结算 —— 正是"筛了等于没筛"。
    """
    caps = declared_capabilities_of() if caps is None else caps
    return any(bool(caps.get(str(n), False)) for n in names)


def diagnostic_shape_gaps(skill: Any, parsed: Any) -> List[str]:
    """**诊断形状缺口**：描述里有这个形状、却没有任何效果覆盖它 ⇒ 记缺口。

    与 span 那条闸的分工：形状词**不一定在** `parse._EXTRA_MECHANIC` 的词表里
    （「自己有减益时，本次技能威力+60」就是），所以只能靠这张小表认出来。
    它**有 settler**：`cond_self_debuff_power` 的 resolver 产出一条带 `evidence` 的效果
    ⇒ 形状被盖住、缺口消失；能力位一关，缺口立刻回来 —— 这就是
    `test_cond_self_debuff_power:101-113` 那条反证的机制。
    """
    desc = str(getattr(skill, "desc", "") or "")
    ranges = _evidence_ranges(skill, parsed)
    out: List[str] = []
    for label, rx in _DIAGNOSTIC_SHAPE_PATTERNS:
        m = rx.search(desc)
        if not m:
            continue
        lo, hi = m.span()
        if any(lo >= a and hi <= b for a, b, _kind in ranges):
            continue                      # 形状被某条效果的 evidence 盖住 ⇒ 已认领
        out.append(label)
    return out


def classify_skill_declared(skill: Any, caps: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """**唯一分类器**（`service.py:112` 直接 import 这个名字）。

    `:843` 是两参数调用（`classify_skill_declared(skill, declared_capabilities_of())`），
    而 `test_cond_self_debuff_power:123` 只传一个参数 ⇒ **`caps` 必须可缺省**；
    `caps=None` 取候选口径（与 `settlement_verdict(declared=None)` 同一条读数）。

    实现 = ① 把 `caps` 按唯一映射表展开成 flags、交 `classify_skill` 判出**账本档位**；
    ② 与 `settlement_verdict` **比结论**，并且**只往保守那一边对齐**：

        `_settlement_lists` 基线的四条不变量里那条是**单向**的 ——
        「**前者说未结算 ⇒ 后者不许说可模拟**」（`_settlement-lists-抽取前基线…md:64`）。
        所以只有 `档位 ∈ {SIM,FULL}` 而判据说未结算时才降成 `PARTIAL`（同一句理由 + 同一份
        `unparsed`，照既有「未识别机制」那族的形状 ⇒ 不是匿名桶）；
        **反方向不动**（判据 True 而档位 PARTIAL ⇒ 保持 PARTIAL）。

    为什么反方向故意不动：那正是 `test_tier_verdict_agreement:83` 那条反证要测的东西 ——
    把两道共用闸关掉之后，"判据翻正、档位没跟上"必须**重新出现（≥8 条）**；若两边都对齐，
    这条判据就成了空判据（假绿）。
    """
    caps = declared_capabilities_of() if caps is None else caps
    tier = classify_skill(skill, **_flags_of(caps))
    if tier.get("support") in (SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_FULL_VERIFIED):
        verdict = settlement_verdict(skill, declared=caps)
        if not verdict["resolved"]:
            rows = [str(x) for x in (verdict.get("unsettled") or [])]
            return {"support": SUPPORT_PARTIAL,
                    "why": rows[0] if rows else "判据说未结算（fail closed）",
                    "effects": list(tier.get("effects") or []),
                    "unparsed": rows,
                    "claimed_by_capability": list(tier.get("claimed_by_capability") or [])}
    return tier


def settlement_verdict(skill: Any, *, declared: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """这条技能「引擎到底会不会结算」的**判据口径**（产品回执里的 `mechanics.resolved`）。

    契约（消费方逐个读出来的，见 `test_tier_verdict_agreement` / `test_cond_self_debuff_power`
    / `test_slot_reduction` / `test_foe_switch_moe` 等）：

      · `resolved: bool` —— 与档位（`classify_skill_declared`）**必须同值**：
        427 条并集零打架是本文件最硬的一条判据（改前 18 条打架）。
      · `settled: list[str]` —— 描述里写了、且引擎真的会出兵的那几**类**（`SETTLED_PATTERNS`；
        `test_tier_verdict_agreement:117` 逐字要 `"驱散" in v["settled"]`）。
      · `unsettled: list[str]` —— 没结算的分句/原语，字符串，给人看。
      · `parsed` —— 判据自己那份解析结果（`:121` 有消费方拿它去算 spans）。

    `declared=None` ⇒ **取候选口径**（`declared_capabilities_of()`）。⚠ **不是**
    `get_rule_config(None)`：那是 legacy，`damage_*` 全 False ⇒ 已结算的招会被一律说成
    未结算（前任实测踩过这一脚：724 必红）。

    显式传 `declared={…}` 时**照旧逐位筛**（`test_slot_reduction:51` 的反证靠它）。
    """
    declared = declared_capabilities_of() if declared is None else declared
    parsed = parse_mod.parse_skill(skill)
    # 一条链跑到底：`resolve_claims` 现在**既跑九步既有能力、也跑扩展族**
    # （见它末尾那段"协作链对齐"注释）—— 所以这里**不再**另外调一次扩展族，
    # 否则 resolver 会跑两遍、效果重复计入（那会让"已认领"变成假的）。
    parsed, _claimed = resolve_claims(skill, declared, parsed=parsed)
    desc = str(getattr(skill, "desc", "") or "")
    flags = _flags_of(declared)
    claimed_words = claimed_mechanic_words(parsed, flags)

    unsettled: List[str] = []
    unsettled.extend(residual_mechanic_spans(skill, parsed, claimed_words))
    unsettled.extend(str(x) for x in (getattr(parsed, "unparsed", None) or []))
    unsettled.extend(unsettled_mechanic_gaps(skill, parsed, claimed_words, declared))
    _kinds = {getattr(e, "kind", "") for e in getattr(parsed, "effects", []) or []}
    for kind in UNSETTLED_EFFECT_KINDS:
        if kind in _kinds:
            unsettled.append(f"解析得出但没有结算分支：{kind}")

    # 去重但**保持顺序**（同一段文本会被多条闸点到；顺序稳定才可比对、可复盘）
    _seen, _rows = set(), []
    for row in unsettled:
        text = str(row)
        if text and text not in _seen:
            _seen.add(text)
            _rows.append(text)

    # 与档位那个保守出口**同一条口径**（`classify_skill` 的 else 分支）：没读出效果、
    # 也不是「纯伤害」、又没有能力位认领 ⇒ 引擎只会写 `status_unsupported`，
    # **绝不许说已结算**（`test_tier_verdict_agreement` 的 E 堆：`389 充分燃烧`
    # 「使敌方身上的灼烧翻倍，并触发1次灼烧伤害」——文本里有「伤害」二字 ≠ 引擎会结算伤害）。
    if not _rows and not claimed_words \
            and not (getattr(parsed, "effects", None) or []) \
            and not getattr(parsed, "plain_attack", False):
        _rows.append("读不出效果：描述里没有已登记的机制词（引擎不按普通伤害结算，fail closed）")

    settled = [name for name, words in SETTLED_PATTERNS
               if any(word and word in desc for word in words)]
    # 2026-09-30（分计划 00 · **补缺失的类**）：文本表看不见的四类走**按 kind** 的姊妹表
    # （`_SETTLED_EFFECT_CLASSES`）—— 它们各自在 `env._apply_effect_batch` 里真有写点，
    # 而语料把 heal 与 self_energy 都写成「回复N…」、把扣能写成「…失去N能量」
    # ⇒ 按文本加词会给无关行贴错标签（见那张表的注释与证据件）。
    for _kind, _label in _SETTLED_EFFECT_CLASSES:
        if _label not in settled and any(
                getattr(e, "kind", "") == _kind
                for e in (getattr(parsed, "effects", None) or [])):
            settled.append(_label)
    # 原版口径（`_settlement_lists-抽取前基线-2026-09-30.md` L17 + BATCH-1 引的 `:713-719`）：
    # **`resolved` = `settled` 非空 且 `unsettled` 为空**。`settled` 是那把"安全阀"：
    # 描述里连一类"引擎真的会出这一手"的机制都点不出来 ⇒ 不许说已结算
    # （`389 充分燃烧` 就是靠它红的：`unsettled` 为空、`settled` 也为空）。
    return {"resolved": bool(settled) and not _rows,
            "settled": settled, "unsettled": _rows, "parsed": parsed}
