"""前 100 条技能（按 skill_id 升序）的**现状普查**（task-18 第 1 步的机器产物）。

它回答三件事，**每一条都用引擎自己的判据**（不另写一套口径）：

  1. **解析层读出什么**：`parse.parse_skill()` 的 `effects` / `unparsed` / `unclaimed_mechanic_spans()`；
  2. **引擎怎么判它**：走**真服务**（`RocoService.rules_query`，与线上同一段按类判定）
     ⇒ `mechanics.resolved` / `reason`；再带 `with_tier=True` 拿唯一分类器 `coverage.classify_skill` 的档位；
  3. **可达性**：是否出现在任何一只的**候选配招**里（`candidate_moveset`）、多少只学得到
     —— 上一轮的坑：「没生效」经常只是**这一手没上场**，不是没实现。

产物：
  · `roco/tests/data/skills-first-100.json` —— 机器可读（每条一行，含缺口分类）
  · `roco/tests/data/skills-first-100.md`   —— 人看的表

    cd roco && PYTHONPATH=src python3 tests/skill_census.py
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata              # noqa: E402
from roco_env import parse as parse_mod         # noqa: E402
from roco_env import effects as fx              # noqa: E402
from roco_env import coverage as cov            # noqa: E402
from roco_env.service import RocoService        # noqa: E402

LIMIT = 100
OUT_JSON = os.path.join(HERE, "data", "skills-first-100.json")
OUT_MD = os.path.join(HERE, "data", "skills-first-100.md")
#: 两套"前 100"（**字面顺序 ≠ 图鉴里的技能**，这一条必须先说清）：
#:   · `literal` = `sorted(skill_id)[:100]` —— 36 条 `magic_wish_impact__*` + 64 条**特性**，
#:     **0 条**在候选配招里（特性走的是钩子，不是"出一手"）；
#:   · `active`  = **主动技能**（`not is_trait`）按 id 升序前 100 —— 36 magic + 64 条 `skill_*`
#:     （到 `skill_000318`），攻击 77 / 状态 19 / 防御 4，**33 条**在候选配招里。
SETS = {"literal": lambda ids, rs: ids,
        "active": lambda ids, rs: [i for i in ids if not getattr(rs.skills[i], "is_trait", False)]}

#: `_apply_effect_batch` 真的会结算的 effect kind（与 `env.py` 对齐；写在这里只为**分类**，
#: 不是第二份实现 —— 判定一律以服务返回的 `mechanics.resolved` 为准）。
HANDLED_KINDS = {
    "self_stat", "foe_stat", "self_mark", "foe_mark", "foe_status", "cleanse", "heal",
    "self_energy", "drain_energy", "foe_energy_loss", "foe_team_energy_loss",
}
#: 解析得出但**没有结算分支**的 kind（举例：离场 / 天气）。
UNSETTLED_KINDS = {"escape", "weather", "self_lifesteal", "overheal_to_stat"}


def learnable_set(pid: str) -> set:
    learn = RS.learnsets.get(pid)
    out = set()
    for attr in ("native", "blood", "stones"):
        values = getattr(learn, attr, None)
        if values:
            out |= {str(x) for x in values}
    return out


RS = rdata.load_ruleset()
MOVESET_IDS: set = set()
for _pid in RS.pets:
    MOVESET_IDS |= {str(x) for x in RS.candidate_moveset(_pid)}
LEARN_COUNT: Counter = Counter()
for _pid, _learn in RS.learnsets.items():
    for _sid in learnable_set(_pid):
        LEARN_COUNT[_sid] += 1


def census(skill_ids: list) -> dict:
    svc = RocoService()
    rows = []
    for sid in skill_ids:
        skill = RS.skills[sid]
        desc = skill.desc or ""
        parsed = parse_mod.parse_skill(skill)
        unclaimed = parse_mod.unclaimed_mechanic_spans(skill, parsed)
        kinds = sorted({e.kind for e in parsed.effects})
        status, env = svc.rules_query({"ruleset_id": RS.ruleset_id, "state_version": 0,
                                       "kind": "skill", "skill_id": sid, "with_tier": True})
        record = (env.get("result") or {}) if status == 200 else {}
        mech = record.get("mechanics") or {}
        resolved = bool(mech.get("resolved"))
        reason = mech.get("reason")
        # 缺口的分类（"还缺什么"）
        gaps = []
        for kind in kinds:
            if kind == "foe_status":
                names = sorted({str(e.value.get("status")) for e in parsed.effects
                                if e.kind == "foe_status"})
                missing = [n for n in names if n not in fx.END_OF_TURN_STATUS]
                if missing:
                    gaps.append("没有回合末实现的状态：" + "/".join(missing))
            elif kind not in HANDLED_KINDS and kind in UNSETTLED_KINDS:
                gaps.append(f"解析出来但没有结算分支：{kind}")
        for marker in parsed.unparsed:
            gaps.append(f"解析层没读出：「{marker}」")
        for span in unclaimed:
            gaps.append(f"描述里有未认领的机制词：「{span}」")
        rows.append({
            "skill_id": sid,
            "name": skill.name,
            "category": skill.category,
            "element": skill.element,
            "energy": skill.energy,
            "damage_class": skill.damage_class,
            "has_static_power": bool(getattr(skill, "has_static_power", False)),
            "is_attack": bool(getattr(skill, "is_attack", False)),
            "is_status": bool(getattr(skill, "is_status", False)),
            "is_defense": bool(getattr(skill, "is_defense", False)),
            "is_trait": bool(getattr(skill, "is_trait", False)),
            "desc": desc,
            "parsed_kinds": kinds,
            "parsed_effects": [{"kind": e.kind, "value": e.value, "evidence": e.evidence,
                                "term": e.term} for e in parsed.effects],
            "unparsed": list(parsed.unparsed),
            "unclaimed": list(unclaimed),
            "resolved": resolved,
            "reason": reason,
            "support_tier": record.get("support"),
            "support_why": record.get("support_why"),
            "support_unparsed": record.get("support_unparsed"),
            "in_any_candidate_moveset": sid in MOVESET_IDS,
            "learnable_by_pets": LEARN_COUNT.get(sid, 0),
            "gaps": gaps,
            "verdict": ("已结算" if resolved and not gaps else
                        "明确不支持" if not resolved else "已结算但有未认领片段"),
        })
    return {"limit": LIMIT, "ruleset_id": RS.ruleset_id,
            "total_skills": len(RS.skills), "rows": rows}


def render_markdown(data: dict, title: str) -> str:
    rows = data["rows"]
    kinds = Counter()
    for row in rows:
        kinds[row["verdict"]] += 1
    lines = [
        f"# {title}（{data['ruleset_id']}）",
        "",
        f"- 技能总数 {data['total_skills']}；本表取 skill_id 升序前 {data['limit']} 条",
        f"- 判定：{' · '.join(f'{k} {v}' for k, v in sorted(kinds.items()))}",
        f"- 可达性：其中 **{sum(1 for r in rows if r['in_any_candidate_moveset'])}** 条"
        f"出现在某只的候选配招里（其余只能靠「换招」递 loadout 才验得到）",
        "",
        "| # | skill_id | 名字 | 类别 | 描述 | 解析读出 | 引擎判 | 缺口（还缺什么） | 候选配招 | 可学只数 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for index, row in enumerate(rows, 1):
        kinds_text = ", ".join(
            f"{e['kind']}" + (f"({e['value'].get('status') or e['value'].get('stat') or ''})"
                              if isinstance(e["value"], dict) else "")
            for e in row["parsed_effects"]) or "—"
        gaps = "；".join(row["gaps"]) if row["gaps"] else "—"
        lines.append(
            f"| {index} | `{row['skill_id']}` | {row['name']} | {row['category']} | "
            f"{(row['desc'] or '').replace('|', '｜')} | {kinds_text} | "
            f"{'✅ 已结算' if row['resolved'] else '⚠ 未结算'} | {gaps.replace('|', '｜')} | "
            f"{'✔' if row['in_any_candidate_moveset'] else '—'} | {row['learnable_by_pets']} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    all_ids = sorted(RS.skills)
    payload = {"ruleset_id": RS.ruleset_id, "total_skills": len(RS.skills), "sets": {}}
    summary = {}
    for name, pick in SETS.items():
        data = census(pick(all_ids, RS)[:LIMIT])
        payload["sets"][name] = data
        rows = data["rows"]
        summary[name] = {
            "skills": len(rows),
            "id_first": rows[0]["skill_id"], "id_last": rows[-1]["skill_id"],
            "resolved": sum(1 for r in rows if r["resolved"]),
            "in_moveset": sum(1 for r in rows if r["in_any_candidate_moveset"]),
            "traits": sum(1 for r in rows if r["is_trait"]),
            "categories": dict(Counter(r["category"] for r in rows)),
            "with_gaps": sum(1 for r in rows if r["gaps"]),
            "gap_classes": dict(Counter(g.split("：")[0] for r in rows for g in r["gaps"])),
        }
        titles = {"literal": "前 100 条（字面 sorted(skill_id)[:100]）· 现状普查",
                  "active": "前 100 条**主动技能**（按 id 升序）· 现状普查"}
        with open(OUT_MD.replace(".md", f"-{name}.md"), "w", encoding="utf-8") as fh:
            fh.write(render_markdown(data, titles[name]))
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(json.dumps({"summary": summary, "out_json": OUT_JSON}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
