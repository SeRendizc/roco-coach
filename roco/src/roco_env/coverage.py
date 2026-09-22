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
        level = SUPPORT_SIMULATABLE_UNVERIFIED
        why = "没有附带效果（纯伤害/纯状态），引擎按基础结算处理"
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
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rs = data_mod.load_ruleset()
    report = write_report(rs, args.out)
    if args.json:
        print(json.dumps({k: report[k] for k in ("totals", "support_levels")}, ensure_ascii=False, indent=1))
    else:
        t = report["totals"]
        print(f"实体 {t['entities']}（战斗技能 {t['battle_skills']} / 特性 {t['traits']}）；"
              f"可模拟 {t['simulatable_entities']}（{t['simulatable_ratio']}）")
        for row in report["coverage_ranking"][:8]:
            print(f"  {row['total']:>4} 条 → {row['primitive']}（技能 {row['skills']} / 特性 {row['traits']}）")
        print(f"报告 → {args.out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
