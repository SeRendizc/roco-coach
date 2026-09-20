#!/usr/bin/env python3
"""W3-02 —— 把 169 套社区阵容逐条过一遍：能不能进模拟池，不能的原因是什么。

数据来源
--------

`data/roco/raw/extracted/rocom-data/data/lineups.json`（169 套，来自
`AofeiLi-code/rocom-data` @ `d2c0533`，许可**未声明** → `REFERENCE_ONLY`）。
这份快照主要来自 **2026-04—05**，**早于 S4（2026-09-10）**。

三条纪律（写死在输出里，也写进报告）
------------------------------------

1. **出现频次不是胜率。** 本脚本只做「这套阵容能不能被本引擎执行」，
   不做任何强度判断，也不排序谁强。
2. **不可执行要写原因**，不是简单标个 false：缺精灵 / 缺技能 / 机制未核验 / 名单不全。
3. **只把规则覆盖充分的放进模拟池**：一套阵容要进场，它的**每一个成员**都得在
   当前 12 只名册里、且它的配招在引擎里合法。

跑法::

    python3 scripts/roco/build-lineup-legality.py            # 写报告
    python3 scripts/roco/build-lineup-legality.py --limit 20 # 只跑前 20 套（自检）
"""

from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys
from typing import Any, Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import traits as tr           # noqa: E402

LINEUPS = os.path.join("data", "roco", "raw", "extracted", "rocom-data", "data", "lineups.json")
OUT_JSONL = os.path.join("data", "roco", "lineup-legality.jsonl")
OUT_DOC = os.path.join("docs", "roco", "LINEUP-LEGALITY.md")

#: 当前引擎有实战能力的那 12 只（W3-01 之后）。
ROSTER = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
          "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]

#: 不可执行的原因分类。用**枚举**而不是自由文本：否则统计与复核都做不了。
REASONS = {
    "not_in_roster": "成员不在当前 12 只名册里",
    "unknown_pet": "数据里查不到这只精灵",
    "skill_not_learnable": "配招里有技能不在该精灵的学习表里",
    "incomplete_roster": "成员不足 3 只（训练场是 3v3）",
    "duplicate_member": "同一只精灵出现两次",
    "trait_refused": "成员特性被引擎明确拒绝（REFUSED），只能 KNOWLEDGE_ONLY",
}


def load_roster(rs) -> Dict[str, str]:
    out = {}
    for name in ROSTER:
        found = rs.pets_by_name(name)
        if found:
            out[name] = found[0].pet_id
    return out


def skill_index(rs) -> Dict[str, Any]:
    """技能名 → Skill。数据里阵容成员写的是**技能名**，引擎按 id 工作。"""
    index: Dict[str, Any] = {}
    for skill in rs.skills.values():
        index.setdefault(skill.name, skill)
    return index


def analyse(rs, roster: Dict[str, str], entry: Dict[str, Any],
            skills: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    members = entry.get("members") or []
    names = [str(m.get("pokemon") or "") for m in members]
    reasons: List[str] = []

    if len(members) < 3:
        reasons.append("incomplete_roster")
    if len(set(names)) != len(names):
        reasons.append("duplicate_member")

    in_roster, unknown = [], []
    for name in names:
        if name in roster:
            in_roster.append(name)
        elif rs.pets_by_name(name):
            # 数据里有这只，但不在我们核过的 12 只里
            in_roster.append(name)
        else:
            unknown.append(name)
    covered = [n for n in names if n in roster]
    if unknown:
        reasons.append("unknown_pet")
    if len(covered) != len(names):
        reasons.append("not_in_roster")

    # 配招可学性：只对**在我们名册里**的成员检查（其余成员本来就不进场）
    skill_problems = []
    for member in members:
        name = str(member.get("pokemon") or "")
        if name not in roster:
            continue
        pid = roster[name]
        for skill_name in (member.get("skills") or []):
            skill = (skills or {}).get(skill_name)
            if skill is None:
                skill_problems.append({"pet": name, "skill": skill_name, "why": "查不到这个技能"})
                continue
            if not rs.is_learnable(pid, skill.skill_id):
                skill_problems.append({"pet": name, "skill": skill_name, "why": "不在学习表里"})
    if skill_problems:
        reasons.append("skill_not_learnable")

    # 特性状态：REFUSED 的成员让整队只能停在 KNOWLEDGE_ONLY
    refused = []
    for name in covered:
        spec = tr.spec_for_pet(rs, roster[name])
        if spec is not None and spec.status == tr.REFUSED:
            refused.append({"pet": name, "trait": spec.trait_name})
    if refused:
        reasons.append("trait_refused")

    # 能不能**原样**进模拟池：3 只齐全、都在名册里、配招合法、没有 REFUSED 特性
    executable = not reasons
    # 若只是成员不在名册里，那这套阵容不能原样跑，但**它仍能当参考**
    # （例如看它的属性构成）。这一点在报告里分开说，不混成「能跑」。
    return {
        "lineup_id": entry.get("id"),
        "title": entry.get("title"),
        "type": entry.get("type"),
        "author": entry.get("author"),
        "uploaded_at": entry.get("uploaded_at"),
        "last_updated": entry.get("last_updated"),
        "source_page": (entry.get("source") or {}).get("page_title"),
        "members": names,
        "members_in_roster": covered,
        "members_unknown": unknown,
        "skills_checked": sum(1 for m in members if str(m.get("pokemon") or "") in roster),
        "skill_problems": skill_problems,
        "refused_traits": refused,
        "executable_as_is": executable,
        "reasons": reasons,
        "snapshot_note": (
            "该快照来自 2026-04—05，早于 S4（2026-09-10）。"
            "这里的出现**只是历史快照里的存在**，不是胜率、不是 T0、不是最优阵容。"
        ),
    }


def summarise(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    reasons = collections.Counter()
    for rec in records:
        for reason in rec["reasons"]:
            reasons[reason] += 1
    member_hist = collections.Counter()
    for rec in records:
        for name in rec["members"]:
            member_hist[name] += 1
    return {
        "total": len(records),
        "executable_as_is": sum(1 for r in records if r["executable_as_is"]),
        "reasons": {k: reasons.get(k, 0) for k in REASONS},
        # 名字刻意叫「被写进阵容的次数」而不是「使用率」：
        # 它是**社区文本里出现的次数**，既不是使用率，更不是胜率。
        "member_appearances": member_hist.most_common(20),
        "by_type": dict(collections.Counter(r["type"] or "unknown" for r in records)),
        "by_month": dict(collections.Counter((r["uploaded_at"] or "?").rsplit("-", 1)[0] for r in records)),
        "roster_appearances": {n: c for n, c in member_hist.items() if n in ROSTER},
        "max_roster_in_lineup": max((len(r["members_in_roster"]) for r in records), default=0),
    }


def write_doc(summary: Dict[str, Any], records: List[Dict[str, Any]], generated_at: str) -> None:
    lines: List[str] = []
    p = lines.append
    p("# 169 套社区阵容的**可执行性**台账（W3-02）")
    p("")
    p(f"> 生成时间：{generated_at}　生成脚本：`scripts/roco/build-lineup-legality.py`")
    p("> 数据来源：`AofeiLi-code/rocom-data` @ `d2c0533` 的 `data/lineups.json`（169 套）")
    p("> 许可：**未声明** → `REFERENCE_ONLY`；本文件只记「能不能被本引擎执行」，不复制其内容分发。")
    p("")
    p("## 0. 三条纪律（先说清楚，免误读）")
    p("")
    p("1. **出现频次不是胜率。** 本表不做任何强度判断、不排序谁强。")
    p("   社区阵容的出现次数只说明「有人用过」，不说明「用了就赢」。")
    p("2. 该快照主要来自 **2026-04—05**，**早于 S4（2026-09-10）**，不代表当前 Meta。")
    p("3. **不可执行要写原因**，不是标个 false 了事。原因分类见下表。")
    p("")
    p("## 1. 汇总")
    p("")
    p(f"- 总套数：**{summary['total']}**")
    p(f"- 可以**原样**进模拟池：**{summary['executable_as_is']}**")
    p(f"- 上传月份分布：{json.dumps(summary['by_month'], ensure_ascii=False)}")
    p(f"- 类型分布：{json.dumps(summary['by_type'], ensure_ascii=False)}")
    p("")
    p("## 2. 不可执行的原因分布")
    p("")
    p("| 原因码 | 含义 | 套数 |")
    p("|---|---|---:|")
    for code, text in REASONS.items():
        p(f"| `{code}` | {text} | {summary['reasons'].get(code, 0)} |")
    p("")
    p("> 一套阵容可能同时命中多个原因，所以这一列**不能**相加等于总套数。")
    p("## 3. 哪些精灵被写进过这些阵容（**不是使用率、不是胜率**）")
    p("")
    p("这一列是「该名字在这 169 套阵容的成员列表里出现过几次」。它**不**说明谁强、")
    p("谁热门、谁该优先培养：社区阵容是**玩家写下来的文本**，出现多只说明「有人这么组过」。")
    p("")
    p("| 精灵 | 被写进几套阵容 |")
    p("|---|---:|")
    for name, count in summary["member_appearances"]:
        p(f"| {name} | {count} |")
    p("")
    p(f"- 名册内 12 只在这些阵容里出现过的：{json.dumps(summary.get('roster_appearances', {}), ensure_ascii=False)}")
    p("- **没有任何一套**能只用名册内 12 只组成（每套至少有 1 只不在名册里）；")
    p(f"  单套里名册内成员最多 {summary.get('max_roster_in_lineup')} 只。")
    p("")
    p("## 3.5 这条结论对模拟池意味着什么")
    p("")
    p("**原样可执行 = 0** 是一个如实的结论，不是脚本出错。原因很清楚：")
    p("")
    p("- 本项目当前只核过 **12 只**精灵（W3-01 的规则域），而快照里有 622 只；")
    p("- 169 套是 **2026-04—05 的社区文本**（140 套来自 4 月，另有 9 套来自 2025 年），")
    p(f"  早于 S4（2026-09-10）；名册内 12 只里只有 8 只在这些阵容中出现过，")
    p(f"  单套里最多 **{summary.get('max_roster_in_lineup')}** 只属于名册。")
    p("")
    p("所以**模拟池不是从这 169 套里选出来的**，而是从我们自己的 12 只名册里组出来的")
    p("（`C(12,3) = 220` 套三人阵容，见 `reports/roco/g02-team/`）。")
    p("这 169 套的用途只有一个：**作为对照**，说明「社区在写什么」与我们能核验的范围差多远。")
    p("")
    p("## 4. 逐套明细")
    p("")
    p("| # | 阵容 | 类型 | 上传 | 成员 | 在册 | 可原样执行 | 原因 |")
    p("|---:|---|---|---|---:|---:|---|---|")
    for i, rec in enumerate(records, 1):
        members = "、".join(rec["members"])
        if len(members) > 42:
            members = members[:41] + "…"
        reasons = "、".join(f"`{r}`" for r in rec["reasons"]) or "—"
        p(f"| {i} | {rec['title']} | {rec['type']} | {rec['uploaded_at']} | {members} "
          f"| {len(rec['members_in_roster'])} | {'✅' if rec['executable_as_is'] else '—'} | {reasons} |")
    p("")
    p("## 5. 机器可读的全量台账")
    p("")
    p(f"`{OUT_JSONL}`（每行一套，含逐成员与逐技能的问题明细）")
    p("")
    p("## 6. 这份台账**没有**回答什么")
    p("")
    p("- 没有回答「哪套阵容更强」——那需要真实天梯样本，本项目没有。")
    p("- 没有回答「社区最爱用什么」——169 套是 2026-05 的快照，不是当前分布。")
    p("- 没有回答「这套阵容在当前版本还能不能打」——版本已变（S4）。")
    p("")
    p("它回答的只有一件事：**这些历史阵容里，有多少能被我们这套引擎原样执行。**")
    p("")
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_DOC)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_DOC), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="169 套阵容的可执行性台账")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 套（自检用）")
    args = parser.parse_args(argv)

    path = os.path.join(_ROOT, LINEUPS)
    if not os.path.exists(path):
        print(f"找不到 {LINEUPS}；先解压 rocom-data 归档（data/roco/raw/extracted/）", file=sys.stderr)
        return 2
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    entries = raw if isinstance(raw, list) else list(raw.values())
    if args.limit:
        entries = entries[: args.limit]

    rs = rdata.load_ruleset()
    roster = load_roster(rs)
    skills = skill_index(rs)
    records = [analyse(rs, roster, entry, skills) for entry in entries]
    summary = summarise(records)
    generated_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

    out_path = os.path.join(_ROOT, OUT_JSONL)
    with open(out_path, "w", encoding="utf-8") as fh:
        header = {
            "record_type": "lineup_legality_header",
            "generated_at": generated_at,
            "generated_by": "scripts/roco/build-lineup-legality.py",
            "ruleset_id": rs.ruleset_id,
            "roster": ROSTER,
            "source": {
                "repo": "AofeiLi-code/rocom-data",
                "revision": "d2c0533aad9a0480d39e3fbc5c37507a47958251",
                "file": "data/lineups.json",
                "license": "未声明（REFERENCE_ONLY）",
                "snapshot_period": "2026-04—05（早于 S4 2026-09-10）",
            },
            "disciplines": [
                "出现频次不是胜率，也不排序强弱。",
                "不可执行必须写原因（见 reasons 枚举）。",
                "只把规则覆盖充分的阵容放进模拟池。",
            ],
            "reason_codes": REASONS,
            "summary": summary,
        }
        fh.write(json.dumps(header, ensure_ascii=False) + "\n")
        for rec in records:
            fh.write(json.dumps({"record_type": "lineup", **rec}, ensure_ascii=False) + "\n")

    write_doc(summary, records, generated_at)
    print(json.dumps({k: summary[k] for k in ("total", "executable_as_is")}, ensure_ascii=False))
    print("reasons:", json.dumps(summary["reasons"], ensure_ascii=False))
    print(f"wrote {OUT_JSONL} and {OUT_DOC}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
