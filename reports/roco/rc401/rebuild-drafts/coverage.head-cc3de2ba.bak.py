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
        claimed.append(f"先手条件（威力+{int(parsed.initiative_power['pct'])}%）")
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
    if caps.get("multi_hit") and parsed.hit_count and parsed.hit_count > 1:
        kept = [row for row in parsed.unparsed if "动态" in str(row) or "连击" not in str(row)]
        if len(kept) != len(parsed.unparsed):
            claimed.append(f"连击×{parsed.hit_count}")
        parsed.unparsed = kept
    return parsed, claimed


def classify_skill(skill: Any, *, foe_energy_loss_declared: bool = False,
                   multi_hit_declared: bool = False,
                   slot_condition_declared: bool = False,
                   position_shift_declared: bool = False,
                   initiative_declared: bool = False,
                   per_layer_cost_declared: bool = False,
                   foe_switch_condition_declared: bool = False,
                   per_use_ramp_declared: bool = False,
                   on_hit_ramp_declared: bool = False) -> Dict[str, Any]:
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
        claimed.append(f"先手条件（威力+{int(parsed.initiative_power['pct'])}%）")
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
    if multi_hit_declared and parsed.hit_count and parsed.hit_count > 1:
        # 只摘静态连击那一条；动态连击仍算未实现（见 parse.resolve_hit_count 的同一处判据）。
        kept = [row for row in parsed.unparsed if "动态" in str(row) or "连击" not in str(row)]
        if len(kept) != len(parsed.unparsed):
            claimed.append(f"连击×{parsed.hit_count}")
        parsed.unparsed = kept
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
        if _has_reduction and not _residual:
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
    _claimed_words = set()
    if multi_hit_declared and parsed.hit_count and parsed.hit_count > 1:
        _claimed_words.add("连击")
    if slot_condition_declared and parsed.slot_conditions:
        _claimed_words.add("号位")
    if position_shift_declared and parsed.position_shift is not None:
        _claimed_words.add("传动")
    if initiative_declared and getattr(parsed, "initiative_power", None):
        _claimed_words.add("若")
    if foe_energy_loss_declared:
        _claimed_words.add("能量")
    if per_layer_cost_declared and getattr(parsed, "per_layer_cost", None):
        # 「敌方每有 N 层中毒效果」里的两个机制词：整条子句都被 `per_layer_cost` 效果覆盖了。
        _claimed_words.update(("每", "层"))
    if foe_switch_condition_declared and getattr(parsed, "foe_switch_effects", None) \
            and not getattr(parsed, "foe_switch_leftover", ""):
        # 「若敌方本回合更换精灵」里的两个机制词（若 / 回合）同理。
        _claimed_words.update(("若", "回合"))
    if per_use_ramp_declared and getattr(parsed, "per_use_ramp", None):
        _claimed_words.add("每")
    if on_hit_ramp_declared and getattr(parsed, "on_hit_ramp", None):
        # 认领「每」与「连击」两个词：`微型斥候`/`绞轮` 的「（不含连击）」也在这条效果的 evidence 里。
        _claimed_words.update(("每", "连击"))
    _residual_spans = [span for span in parse_mod.unclaimed_mechanic_spans(skill, parsed=parsed)
                       if str(span).split("：")[0] not in _claimed_words]
    if _residual_spans:
        # ⚠ 这里**不要**往 `claimed` 里塞"缺口"：`claimed_by_capability` 的语义是
        # 「被哪条已声明能力认领了」，塞进未认领片段会让那一栏自相矛盾。
        return {
            "support": SUPPORT_PARTIAL,
            "why": ("读出了 " + str(len(parsed.effects)) + " 条效果，但描述里还有 "
                    + str(len(_residual_spans)) + " 段机制**引擎没结算**（会被写进 unsupported）："
                    + "、".join(str(x) for x in _residual_spans[:2])),
            "effects": [e.kind for e in parsed.effects],
            "unparsed": [str(x) for x in _residual_spans],
            "claimed_by_capability": claimed,
        }
    if parsed.effects and not parsed.unparsed:
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
        elif claimed:
            # 描述里的机制被**已声明能力**认领了（例如候选口径声明了连击，
            # 静态「3连击」就不算未实现）——这时它同样没有未认领片段，可结算。
            level = SUPPORT_SIMULATABLE_UNVERIFIED
            why = f"描述里的机制由已声明能力认领（{'、'.join(claimed)}），没有未认领片段"
        else:
            # 2026-09-25（第 30 轮）：这一档原来只说「认不出的机制」，**不说是哪一段** ——
            # 于是台账里出现一个匿名的「（未命名）174 条」桶，按频次排序的下一批工作单看不见它。
            # 运行时其实有这把尺子：`parse.unclaimed_mechanic_spans()` 正是 `env._execute` 写
            # `state.unsupported` 用的那一个（同一份实现，不是另抄一套）。这里把它叫出来，
            # 把片段按 `{机制词}：{原句}` 登记进台账 —— **只补诊断，不改结算**（档位仍是 PARTIAL）。
            # ⚠ 传 `parsed`：上面几条 `resolve_*` 可能已经把声明过的能力补成效果了，
            # 重新 `parse_skill` 会把那份认领丢掉（同一段文本又被登记成未认领）。
            spans = list(parse_mod.unclaimed_mechanic_spans(skill, parsed=parsed))
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
        return {"multi_hit": bool(getattr(cfg, "damage_multi_hit", False)),
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

    skill_rows = {s.skill_id: classify_skill(
        s, multi_hit_declared=capabilities.get("multi_hit", False),
        slot_condition_declared=capabilities.get("slot_condition", False),
        position_shift_declared=capabilities.get("position_shift", False),
        foe_energy_loss_declared=capabilities.get("foe_energy_loss", False),
        initiative_declared=capabilities.get("initiative_condition", False),
        per_layer_cost_declared=capabilities.get("per_layer_cost", False),
        foe_switch_condition_declared=capabilities.get("foe_switch_condition", False),
        per_use_ramp_declared=capabilities.get("per_use_ramp", False),
        on_hit_ramp_declared=capabilities.get("on_hit_ramp", False))
                  for s in skills}
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
