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


def classify_skill(skill: Any, *, multi_hit_declared: bool = False) -> Dict[str, Any]:
    """一条战斗技能的支持等级。判据只看**解析结果 + 已声明的能力**，不看名字或人工名单。

    `multi_hit_declared`：当前规则配置有没有声明连击能力（RC-401 的第一条增量）。
    声明了且描述里静态写着「N连击」时，「连击」那一条不再算未实现——**否则会重复计数**
    （同一个机制被算成「已实现」又被算成「未实现」）。
    """
    parsed = parse_mod.parse_skill(skill)
    claimed: List[str] = []
    if multi_hit_declared and parsed.hit_count and parsed.hit_count > 1:
        # 只摘静态连击那一条；动态连击仍算未实现（见 parse.resolve_hit_count 的同一处判据）。
        kept = [row for row in parsed.unparsed if "动态" in str(row) or "连击" not in str(row)]
        if len(kept) != len(parsed.unparsed):
            claimed.append(f"连击×{parsed.hit_count}")
        parsed.unparsed = kept
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
            level = SUPPORT_PARTIAL
            why = ("描述里有解析器认不出的机制，而且它既没被读出、也没被登记为未认领片段："
                   "不能按普通伤害结算（fail closed）")
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
    return {"support": level, "why": f"登记状态 {spec.status}", "hook": spec.hook, "reason": spec.reason}


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


def _primitive_bucket(reason: str) -> str:
    """把「没认领的片段」归成一个原语名（台账里按它排序）。"""
    head = str(reason).split("（")[0].strip()
    for marker in parse_mod.UNPARSED_MARKERS:
        if marker and marker in head:
            return marker
    return head.split(":")[0][:24] or "（未命名）"


def build_coverage(rs: Any, *, headline: Optional[List[str]] = None,
                   declared_capabilities: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """跑一遍全量数据，产出覆盖台账。**确定性**：同样的数据 ⇒ 同样的报告。

    `declared_capabilities` 默认取**候选口径**（`mobile_s4_candidate_v3` 已声明连击）。
    之所以要显式带上它：覆盖率不是数据的属性，而是「**数据 × 已声明的能力**」的属性——
    同一份数据，legacy 口径与候选口径的覆盖率本来就不同，混在一起谈就是自欺。
    """
    capabilities = dict(declared_capabilities or {"multi_hit": True})
    skills = [s for s in rs.skills.values() if not s.is_trait]
    traits = [s for s in rs.skills.values() if s.is_trait]

    skill_rows = {s.skill_id: classify_skill(s, multi_hit_declared=capabilities.get("multi_hit", False))
                  for s in skills}
    trait_rows = {t.skill_id: classify_trait(t) for t in traits}

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

    ranked = sorted(
        ({"primitive": key, **counts, "total": counts["skills"] + counts["traits"]}
         for key, counts in benefit.items()),
        key=lambda row: (-row["total"], row["primitive"]),
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
    parser.add_argument("--out", default=os.path.join("reports", "roco", "rc401", "effect-coverage.json"))
    parser.add_argument("--traits-out", default=os.path.join("reports", "roco", "rc401", "trait-worklist.json"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rs = data_mod.load_ruleset()
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
