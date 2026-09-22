"""RC-403 Support Classifier v2：**一只精灵到底能不能模拟、能到什么程度**。

为什么需要它
------------
到上一轮为止，仓库里有了两份零散的事实：
  · `data.py::build_support_of()` —— 配招是冻结的（`FULL_VERIFIED`）还是按需推算的
    （`SIMULATABLE_UNVERIFIED`）（RC-402）；
  · `coverage.py` —— 每条**技能/特性**的支持等级（RC-401 的覆盖台账）。

但产品与训练数据要问的是**第三件事**：**这一只精灵**能不能上场、上场之后有多少行为是
真的在按规则走。把「能上场」当成「能模拟」是这一轮最容易犯的错：一只按需推算配招的精灵，
它的四个技能可能都读得出来（能打），而它的**特性**大概率没有实现（239/245 条特性连登记都没有）
—— 那意味着它在场上的行为**跟真实游戏不一样**。

判据（每条都有必杀方向）
------------------------
按**部件**定档，再按**最坏部件**取整体档：

    build（配招来源） + trait（特性） + 四个技能（各自的支持等级）

严重度顺序：`REFUSED` > `KNOWLEDGE_ONLY` > `PARTIAL` > `SIMULATABLE_UNVERIFIED` > `FULL_VERIFIED`。
整体取最坏的那一件，并把每一件都记下来（`pieces`）——所以页面/报告可以说清
「能上场，但特性未实现」「能上场，其中一个技能有未认领机制」。

它**不**判断机制对不对（那要靠实机 microcase）。它只回答：这一只身上，有多少部件是我们
**真的会结算**的、多少只是「有资料」。
"""

from __future__ import annotations

import collections
import json
import os
from typing import Any, Dict, List, Optional

from . import coverage as coverage_mod
from .data import SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED

SUPPORT_PARTIAL = coverage_mod.SUPPORT_PARTIAL
SUPPORT_KNOWLEDGE_ONLY = coverage_mod.SUPPORT_KNOWLEDGE_ONLY
SUPPORT_REFUSED = coverage_mod.SUPPORT_REFUSED

#: 严重度顺序（数字越大越差）。整体档 = 所有部件里最差的那个。
SEVERITY = {
    SUPPORT_FULL_VERIFIED: 0,
    SUPPORT_SIMULATABLE_UNVERIFIED: 1,
    SUPPORT_PARTIAL: 2,
    SUPPORT_KNOWLEDGE_ONLY: 3,
    SUPPORT_REFUSED: 4,
}


def _worst(levels: List[str]) -> str:
    known = [lv for lv in levels if lv in SEVERITY]
    if not known:
        return SUPPORT_KNOWLEDGE_ONLY
    return max(known, key=lambda lv: SEVERITY[lv])


def classify_pet(rs: Any, pet_id: str, *, multi_hit_declared: bool = True) -> Dict[str, Any]:
    """一只精灵的支持等级（按部件定档 + 最坏部件取胜）。

    `multi_hit_declared`：与覆盖台账同一口径（当前配置声明了连击能力与否）——
    标定「这一只在这个口径下」的支持等级，而不是一个含糊的全局值。
    """
    pet = rs.pets.get(pet_id)
    if pet is None:
        return {"pet_id": pet_id, "support": SUPPORT_KNOWLEDGE_ONLY,
                "pieces": {}, "reasons": ["不在当前规则集的精灵表里"]}

    build_level = rs.build_support_of(pet_id) or SUPPORT_KNOWLEDGE_ONLY
    pieces: Dict[str, Any] = {
        "build": {"support": build_level,
                  "why": "配招来自冻结 learnset" if build_level == SUPPORT_FULL_VERIFIED
                         else "配招由全量图鉴的 learnable_skills 按需推算（RC-402）"},
    }

    trait = rs.skills.get(pet.feature_skill_id) if pet.feature_skill_id else None
    if trait is not None and getattr(trait, "is_trait", False):
        row = coverage_mod.classify_trait(trait)
        pieces["trait"] = {"skill_id": trait.skill_id, "name": trait.name,
                           "support": row["support"], "why": row["why"]}
    else:
        pieces["trait"] = {"skill_id": None, "name": None,
                           "support": SUPPORT_KNOWLEDGE_ONLY,
                           "why": "这只精灵没有登记特性（或特性 id 指向的不是特性）"}

    skills = []
    for sid in rs.candidate_moveset(pet_id) or ():
        skill = rs.skills.get(sid)
        if skill is None:
            skills.append({"skill_id": sid, "support": SUPPORT_KNOWLEDGE_ONLY, "why": "技能解析不到"})
            continue
        row = coverage_mod.classify_skill(skill, multi_hit_declared=multi_hit_declared)
        skills.append({"skill_id": sid, "name": skill.name, "support": row["support"], "why": row["why"],
                       **({"unparsed": row["unparsed"]} if row["unparsed"] else {})})
    pieces["moveset"] = skills

    # 精灵档**不是**简单的最坏件：它描述的是「**作为一只可上场的单位**，有多少行为真的按规则走」。
    #
    # 为什么不能用最坏件：239/245 条特性没有登记，最坏件规则会把 599 只**明明能上场、
    # 四个技能也都能结算**的精灵判成 `KNOWLEDGE_ONLY`（「只有资料」）——那句话是错的。
    # 正确的读法是：能上场 + 有部件没实现 = **PARTIAL（部分模拟）**，
    # 而「明确拒绝实现」的部件单独列进 `refused_pieces`，让页面能说清是哪一件。
    levels = [pieces["build"]["support"], pieces["trait"]["support"]] + [s["support"] for s in skills]
    fieldable = pieces["build"]["support"] in (SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED)
    if not fieldable:
        overall = SUPPORT_KNOWLEDGE_ONLY
    elif all(lv == SUPPORT_FULL_VERIFIED for lv in levels):
        overall = SUPPORT_FULL_VERIFIED
    elif all(lv in (SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED) for lv in levels):
        overall = SUPPORT_SIMULATABLE_UNVERIFIED
    else:
        overall = SUPPORT_PARTIAL

    refused = [row["skill_id"] for row in skills if row["support"] == SUPPORT_REFUSED]
    if pieces["trait"]["support"] == SUPPORT_REFUSED:
        refused.append(pieces["trait"]["skill_id"])
    # 两个清单必须**分开**，否则「说全可模拟却列着未核验部件」这种自相矛盾就会出现：
    #   · `unverified_pieces`：结算了、但没有一手/实机证据（SIMULATABLE_UNVERIFIED）；
    #   · `unsimulated_pieces`：**根本没在按规则走**（PARTIAL / KNOWLEDGE_ONLY / REFUSED）。
    below_simulatable = {SUPPORT_PARTIAL, SUPPORT_KNOWLEDGE_ONLY, SUPPORT_REFUSED}
    unverified = ([f"trait:{pieces['trait']['skill_id']}"]
                  if pieces["trait"]["support"] == SUPPORT_SIMULATABLE_UNVERIFIED else []) \
        + [f"skill:{row['skill_id']}" for row in skills
           if row["support"] == SUPPORT_SIMULATABLE_UNVERIFIED]
    unsimulated = ([f"trait:{pieces['trait']['skill_id']}"]
                   if pieces["trait"]["support"] in below_simulatable else []) \
        + [f"skill:{row['skill_id']}" for row in skills if row["support"] in below_simulatable]
    reasons = [f"{name}：{row['support']}（{row['why']}）" if isinstance(row, dict) and "why" in row
               else f"{name}：{row['support']}" for name, row in
               (("配招", pieces["build"]), ("特性", pieces["trait"]))]
    for row in skills:
        if row["support"] != SUPPORT_FULL_VERIFIED:
            reasons.append(f"技能「{row.get('name') or row['skill_id']}」：{row['support']}")
    return {"pet_id": pet_id, "name": pet.name, "support": overall, "fieldable": fieldable,
            "refused_pieces": refused, "unverified_pieces": unverified,
            "unsimulated_pieces": unsimulated,
            "pieces": pieces, "reasons": reasons}


def classify_all(rs: Any, *, multi_hit_declared: bool = True,
                 restrict: Optional[List[str]] = None) -> Dict[str, Any]:
    """全量（或指定子集）的精灵支持等级 + 汇总。确定性：同样的输入 ⇒ 同样的报告。"""
    ids = sorted(restrict) if restrict else sorted(rs.pets)
    pets = {pid: classify_pet(rs, pid, multi_hit_declared=multi_hit_declared) for pid in ids}
    by_level = collections.Counter(row["support"] for row in pets.values())
    # 按部件统计：回答「整体档主要卡在哪一件上」
    blockers = collections.Counter()
    for row in pets.values():
        if row["support"] in (SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED):
            continue
        worst = SEVERITY[row["support"]]
        for name in ("build", "trait"):
            piece = row["pieces"].get(name)
            if isinstance(piece, dict) and SEVERITY.get(piece["support"], 0) >= worst:
                blockers[name] += 1
        for skill in row["pieces"].get("moveset", []):
            if SEVERITY.get(skill["support"], 0) >= worst:
                blockers["moveset"] += 1
    return {
        "schema": "roco-support-classification/v1",
        "rc": "RC-403",
        "generated_by": "roco/src/roco_env/support.py",
        "ruleset_id": rs.ruleset_id,
        "assumed_capabilities": {"multi_hit": multi_hit_declared},
        "why": "「能上场」不等于「能模拟」：一只按需推算配招的精灵能打，但它的特性大概率没有实现"
               "（239/245 条特性连登记都没有）。本报告按**部件**定档再取最坏件，"
               "让页面与训练数据能说清「这一只身上有多少行为是真的按规则走的」。",
        "totals": {"pets": len(pets), **{lv: by_level.get(lv, 0) for lv in (
            SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED, SUPPORT_PARTIAL,
            SUPPORT_KNOWLEDGE_ONLY, SUPPORT_REFUSED)}},
        "blockers": dict(blockers),
        "severity_order": [lv for lv, _ in sorted(SEVERITY.items(), key=lambda kv: kv[1])],
        "known_limits": [
            "`FULL_VERIFIED` 要求**每一个部件**都是已核验：目前只有极少数精灵满足（特性层的实机证据不足）",
            "档位只回答「引擎会不会结算」，**不回答机制对不对**（那要靠实机 microcase）",
            "连击能力按参数假定（默认按候选配置的声明）；换口径要重新生成",
        ],
        "pets": pets,
    }


def write_report(rs: Any, path: str, **kwargs: Any) -> Dict[str, Any]:
    report = classify_all(rs, **kwargs)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    return report


def _main() -> int:  # pragma: no cover - CLI 入口
    import argparse

    from . import data as data_mod

    parser = argparse.ArgumentParser(description="RC-403 精灵支持等级分类")
    parser.add_argument("--out", default=os.path.join("reports", "roco", "rc403", "support-classification.json"))
    parser.add_argument("--no-multi-hit", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rs = data_mod.load_ruleset()
    report = write_report(rs, args.out, multi_hit_declared=not args.no_multi_hit)
    if args.json:
        print(json.dumps({"totals": report["totals"], "blockers": report["blockers"]},
                         ensure_ascii=False, indent=1))
    else:
        print(f"精灵 {report['totals']['pets']} 只；分档："
              + "，".join(f"{k} {v}" for k, v in report["totals"].items() if k != "pets"))
        print(f"卡点：{report['blockers']}")
        print(f"报告 → {args.out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
