"""前 100 条**特性**（`skill_000001`…`skill_000100`）的现状普查（task-18 第 1 步的机器产物）。

Lead 已量清：按 `skill_id` 升序前 100 条 = **100/100 都是特性**（`is_trait=True`），
不是招式 ⇒ 它们进战斗的路径是**挂在精灵身上**（`feature_skill_id`），不是"出一手"。
所以这张表的"现状"列必须回答**特性那一套**问题：

  · **引擎有没有这条特性的规格**（`traits.TRAITS`，含 status/hook/gaps）—— 这是权威答案；
  · **解析层能不能读出**说明里的效果（`parse.parse_skill` 的 effects / unparsed / unclaimed）；
  · **可达性**：哪几只精灵带这条特性、它们在不在冻结可玩池（542）、有没有 4 格候选配招
    —— 判"没生效"之前先证明"这一只真的带着它上场了"；
  · **要实现还缺什么**（按类：纯数值修正 / 状态层数 / 层数驱动 / 印记 / 需要新机制 / 条件未定 / 无功能词）。

产物：`roco/tests/data/traits-first-100.json` 与 `-表.md`。

    cd roco && PYTHONPATH=src python3 tests/trait_census.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata              # noqa: E402
from roco_env import parse as parse_mod         # noqa: E402
from roco_env import traits as tr               # noqa: E402

FIRST, LAST = 1, 100
OUT_JSON = os.path.join(HERE, "data", "traits-first-100.json")
OUT_MD = os.path.join(HERE, "data", "traits-first-100-表.md")

RS = rdata.load_ruleset()


def _frozen_pool() -> set:
    from roco_env.data import SUPPORT_FULL_VERIFIED
    return {pid for pid in RS.pets if RS.build_support_of(pid) == SUPPORT_FULL_VERIFIED}


FROZEN = _frozen_pool()
OWNERS: dict = defaultdict(list)
for _pid in RS.pets:
    fid = getattr(RS.pet(_pid), "feature_skill_id", None)
    if fid:
        OWNERS[str(fid)].append(_pid)


def classify(desc: str, parsed, unclaimed, spec) -> list:
    """这条特性"要实现还缺什么"的**分类**（可以多类）。

    分类只描述**工作性质**（要接什么），不代替引擎的判定 —— 引擎判定在 `traits.TRAITS`
    与 `mechanics.resolved` 里。**已经实现**的（spec.status in (FULL, PARTIAL)）也照样列出
    它属于哪一类，方便按类批量推进。
    """
    classes = []
    if spec is not None:
        classes.append(f"已登记（{spec.status}"
                       + (f"，钩子 {spec.hook or spec.extra_hooks}" if (spec.hook or spec.extra_hooks) else "")
                       + "）")
        if spec.gaps:
            classes.append("登记里自述的缺口：" + "；".join(spec.gaps))
    if re.search(r"(威力|伤害)\s*[+＋\-－]\s*\d+", desc):
        classes.append("纯数值修正（威力/伤害±N%）")
    if re.search(r"(魔力|心)\s*[+＋\-－]?\s*[少损]?[失]?\s*\d*\s*点", desc) or "魔力" in desc:
        classes.append("魔力相关")
    if re.search(r"获得\s*\d+\s*层\s*(中毒|灼烧|寄生)", desc):
        classes.append("状态层数（已实现的原语，可直接复用）")
    if re.search(r"获得\s*\d+\s*层\s*(冻结|引电|萌化)", desc):
        classes.append("状态层数（**没有回合末实现**：冻结/引电/萌化）")
    if re.search(r"每有\s*\d+\s*层", desc):
        classes.append("层数驱动（需要读层数改数值）")
    if "印记" in desc:
        classes.append("印记")
    if re.search(r"(蓄力|木桶|偷取|交换|复制|变成|复活|免疫|免疫此次|变身)", desc):
        classes.append("需要新机制/新状态")
    if re.search(r"(若|当|如果)", desc):
        classes.append("带条件（要判条件是否成立）")
    if not classes:
        classes.append("说明里没有已知功能词")
    if unclaimed:
        classes.append("解析层有未认领片段：" + "；".join(unclaimed))
    if parsed.unparsed:
        classes.append("解析层没读出：" + "；".join(str(x) for x in parsed.unparsed))
    return classes


def main() -> int:
    rows = []
    for number in range(FIRST, LAST + 1):
        sid = f"skill_{number:06d}"
        skill = RS.skills.get(sid)
        if skill is None:
            continue
        desc = skill.desc or ""
        parsed = parse_mod.parse_skill(skill)
        unclaimed = parse_mod.unclaimed_mechanic_spans(skill, parsed)
        spec = tr.spec_for_trait_name(skill.name)
        owners = OWNERS.get(sid, [])
        rows.append({
            "skill_id": sid,
            "name": skill.name,
            "category": skill.category,
            "element": skill.element,
            "power": getattr(skill, "power", None),
            "is_trait": bool(getattr(skill, "is_trait", False)),
            "desc": desc,
            "parsed_kinds": sorted({e.kind for e in parsed.effects}),
            "parsed_effects": [{"kind": e.kind, "value": e.value, "evidence": e.evidence}
                               for e in parsed.effects],
            "unparsed": [str(x) for x in parsed.unparsed],
            "unclaimed": list(unclaimed),
            "engine_spec": ({"status": spec.status, "hook": spec.hook,
                             "extra_hooks": list(spec.extra_hooks), "gaps": list(spec.gaps),
                             "reason": spec.reason} if spec else None),
            "owner_pets": owners,
            "owner_count": len(owners),
            "owners_in_frozen": [p for p in owners if p in FROZEN],
            "owner_names": [RS.pet(p).name for p in owners[:4]],
            "classes": classify(desc, parsed, unclaimed, spec),
        })

    class_counter = Counter()
    for row in rows:
        for item in row["classes"]:
            class_counter[item.split("（")[0]] += 1
    summary = {
        "count": len(rows),
        "all_traits": all(r["is_trait"] for r in rows),
        "with_engine_spec": sum(1 for r in rows if r["engine_spec"]),
        "engine_spec_statuses": dict(Counter(r["engine_spec"]["status"] for r in rows
                                             if r["engine_spec"])),
        "parsed_something": sum(1 for r in rows if r["parsed_effects"]),
        "with_unclaimed": sum(1 for r in rows if r["unclaimed"]),
        "with_unparsed": sum(1 for r in rows if r["unparsed"]),
        "reachable_frozen": sum(1 for r in rows if r["owners_in_frozen"]),
        "no_owner": sum(1 for r in rows if not r["owner_pets"]),
        "class_counter": dict(class_counter.most_common()),
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump({"ruleset_id": RS.ruleset_id, "summary": summary, "rows": rows},
                  fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write(render(rows, summary))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("→", OUT_JSON)
    return 0


def render(rows, summary) -> str:
    lines = [
        "# 前 100 条**特性** · 现状与缺口普查",
        "",
        f"- 条数 {summary['count']}（全部 `is_trait` = {summary['all_traits']}）",
        f"- 引擎**已登记**的：{summary['with_engine_spec']} 条"
        f"（状态分布 {summary['engine_spec_statuses']}）⇒ 其余 "
        f"{summary['count'] - summary['with_engine_spec']} 条**引擎完全没有规格**（`traits.TRAITS` 里没有）",
        f"- 解析层读出效果的：{summary['parsed_something']} 条"
        f"｜有未认领片段的：{summary['with_unclaimed']} 条｜有没读出标记的：{summary['with_unparsed']} 条",
        f"- 可达性：带它的精灵里有**冻结可玩池**成员的：{summary['reachable_frozen']} 条"
        f"（没有任何精灵携带的：{summary['no_owner']} 条）",
        "",
        "## 按类（一条可属多类）",
        "",
    ]
    for name, count in summary["class_counter"].items():
        lines.append(f"- {name}：**{count}** 条")
    lines += ["", "## 逐条", "",
              "| # | skill_id | 名字 | 说明 | 引擎现状 | 解析读出 | 缺口/要做 | 带它的精灵（冻结池） |",
              "|---|---|---|---|---|---|---|---|"]
    for index, row in enumerate(rows, 1):
        spec = row["engine_spec"]
        engine = (f"已登记 {spec['status']}"
                  + (f"（{spec['hook'] or spec['extra_hooks']}）" if (spec["hook"] or spec["extra_hooks"]) else "")
                  ) if spec else "**没有规格（未接）**"
        kinds = ", ".join(row["parsed_kinds"]) or "—"
        classes = "；".join(c for c in row["classes"] if not c.startswith("已登记")) or "—"
        owners = f"{row['owner_count']} 只（冻结 {len(row['owners_in_frozen'])}）" \
            + (f"：{'、'.join(row['owner_names'])}" if row["owner_names"] else "")
        lines.append(f"| {index} | `{row['skill_id']}` | {row['name']} | "
                     f"{(row['desc'] or '').replace('|', '｜')} | {engine} | {kinds} | "
                     f"{classes.replace('|', '｜')} | {owners} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
