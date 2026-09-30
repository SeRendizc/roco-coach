"""「我的盒子前 100 只精灵」的技能并集（**427 条**）· 现状与缺口普查（task-18 第 1 步）。

范围（人类 2026-09-29 澄清）：「**列表前 100 个精灵的技能**」= 盒子默认排序前 100 只
**学习到的技能并集**（去重后 427 条；攻击 257 / 状态 128 / 防御 42）。

这份表要回答**每一条现在到哪一步**，并且**分成三堆**（第一堆直接划掉，省工夫）：

  · `已通`        —— 引擎会结算、描述也被完整读出（没有未认领片段、没有没读出的标记）
  · `缺一段`      —— 引擎会结算**一部分**，但说明里还有没认领的片段 / 解析没读出的标记
  · `没读出来`    —— 引擎按"没对应原语"报未结算（`mechanics.resolved=false`）

判定**全部走引擎自己的路径**（不另写一套口径）：

  1. `parse.parse_skill()` + `parse.unclaimed_mechanic_spans()` —— 解析层读出什么；
  2. **配置驱动的解析链**（与 `env._execute` 攻击/防御/状态分支同一条）：
     `resolve_hit_count` / `resolve_initiative_condition` / `resolve_foe_switch_condition` /
     `resolve_per_use_ramp` / `resolve_foe_energy_loss` / `resolve_per_layer_cost` /
     `resolve_position_mechanics` / `resolve_choice_variants` —— **不套这条链会把已结算的
     连击/先手/传动报成缺口**（第一版就踩了这个坑）；
  3. `RocoService.rules_query(with_tier=True)` —— 服务端的按类判定（`mechanics.resolved`）+ 唯一分类器档位；
  4. 可达性：**前 100 只里几只学得到**、是否在某只的候选配招里。

产物：`roco/tests/data/pets100-skills-census.json` 与 `-表.md`
输入：`tmp/pets100-skills.json`（Lead 的产物；同时**独立复核**条数与类别分布）

    cd roco && PYTHONPATH=src python3 tests/pets100_census.py
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata              # noqa: E402
from roco_env import effects as fx              # noqa: E402
from roco_env import parse as parse_mod         # noqa: E402
from roco_env import rule_config as RC          # noqa: E402
from roco_env.service import RocoService        # noqa: E402

IN_PATH = os.path.join(ROOT, "tmp", "pets100-skills.json")
OUT_JSON = os.path.join(HERE, "data", "pets100-skills-census.json")
OUT_MD = os.path.join(HERE, "data", "pets100-skills-census-表.md")

RS = rdata.load_ruleset()
CFG = RC.get_rule_config("mobile_s4_candidate_v3")


def resolved_chain(skill):
    """**与引擎同一条**配置驱动解析链（缺了它会把已结算的连击/先手/传动报成缺口）。"""
    parsed = parse_mod.parse_skill(skill)
    parsed = parse_mod.resolve_foe_energy_loss(
        skill, declared=bool(getattr(CFG, "energy_foe_energy_loss", False)), parsed=parsed)
    parsed = parse_mod.resolve_foe_switch_condition(
        skill, declared=bool(getattr(CFG, "damage_foe_switch_condition", False)), parsed=parsed)
    parsed = parse_mod.resolve_per_use_ramp(
        skill, declared=bool(getattr(CFG, "damage_per_use_ramp", False)), parsed=parsed)
    parsed = parse_mod.resolve_initiative_condition(
        skill, declared=bool(getattr(CFG, "damage_initiative_condition", False)), parsed=parsed)
    parsed = parse_mod.resolve_per_layer_cost(
        skill, declared=bool(getattr(CFG, "energy_per_layer_cost", False)), parsed=parsed)
    parsed = parse_mod.resolve_position_mechanics(
        skill, slot_declared=bool(getattr(CFG, "damage_slot_condition", False)),
        shift_declared=bool(getattr(CFG, "damage_position_shift", False)), parsed=parsed)
    parsed = parse_mod.resolve_choice_variants(
        skill, declared=True, parsed=parsed)
    # 2026-09-29（task-25）：A 族「获得 属性±N」的扩展形状 / 平值。
    # **必须与 `coverage.resolve_claims` / `env` 同一条链**（三处口径一致），
    # 否则台账会把"引擎真的结算了"的形状报成缺口。
    parsed = parse_mod.resolve_stat_gain_extended(
        skill, declared=bool(getattr(CFG, "stat_gain_extended", False)),
        flat_declared=bool(getattr(CFG, "stat_gain_flat", False)), parsed=parsed)
    _hits, parsed = parse_mod.resolve_hit_count(
        skill, declared=bool(getattr(CFG, "damage_multi_hit", False)), parsed=parsed)
    return parsed


def main() -> int:
    with open(IN_PATH, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    source_skills = payload["skills"]
    source_pets = payload.get("pets") or []
    svc = RocoService()
    # 前 100 只里每只学得到哪些技能（可达性）
    learn_count: Counter = Counter()
    for row in source_pets:
        for sid in row.get("learnable_skills") or row.get("skills") or []:
            learn_count[str(sid)] += 1

    rows = []
    for item in source_skills:
        sid = item["skill_id"]
        skill = RS.skills.get(sid)
        if skill is None:
            rows.append({**item, "in_ruleset": False, "verdict": "不在规则集里"})
            continue
        desc = skill.desc or ""
        raw = parse_mod.parse_skill(skill)
        parsed = resolved_chain(skill)
        unclaimed = parse_mod.unclaimed_mechanic_spans(skill, parsed)
        status, env = svc.rules_query({"ruleset_id": RS.ruleset_id, "state_version": 0,
                                       "kind": "skill", "skill_id": sid, "with_tier": True})
        record = (env.get("result") or {}) if status == 200 else {}
        mech = record.get("mechanics") or {}
        resolved = bool(mech.get("resolved"))
        statuses = sorted({str(e.value.get("status")) for e in parsed.effects
                           if e.kind == "foe_status"} or
                          {str(e.value.get("status")) for e in raw.effects if e.kind == "foe_status"})
        missing_statuses = [n for n in statuses if n not in fx.END_OF_TURN_STATUS]
        gaps = []
        for marker in parsed.unparsed:
            gaps.append(f"解析层没读出：「{marker}」")
        for span in unclaimed:
            gaps.append(f"未认领片段：「{span}」")
        for name in missing_statuses:
            gaps.append(f"没有回合末实现的状态：{name}")
        for kind in sorted({e.kind for e in parsed.effects}):
            if kind in ("escape", "weather", "self_lifesteal", "overheal_to_stat"):
                gaps.append(f"解析得出但没有结算分支：{kind}")
        if resolved and not gaps:
            pile = "已通"
        elif resolved:
            pile = "缺一段"
        else:
            pile = "没读出来"
        rows.append({
            "skill_id": sid, "name": skill.name, "category": skill.category,
            "element": skill.element, "power": getattr(skill, "power", None),
            "energy": skill.energy, "damage_class": skill.damage_class,
            "is_attack": bool(getattr(skill, "is_attack", False)),
            "is_status": bool(getattr(skill, "is_status", False)),
            "is_defense": bool(getattr(skill, "is_defense", False)),
            "desc": desc,
            "parsed_kinds": sorted({e.kind for e in parsed.effects}),
            "unparsed": [str(x) for x in parsed.unparsed],
            "unclaimed": list(unclaimed),
            "statuses": statuses, "missing_statuses": missing_statuses,
            "resolved": resolved, "reason": mech.get("reason"),
            "support_tier": record.get("support"),
            "learnable_by_first100": learn_count.get(sid, 0),
            "gaps": gaps, "verdict": pile,
        })

    piles = Counter(r["verdict"] for r in rows)
    gap_classes = Counter()
    for row in rows:
        for gap in row["gaps"]:
            gap_classes[gap.split("「")[0].rstrip("：")] += 1
    summary = {
        "skills": len(rows),
        "piles": dict(piles),
        "categories": dict(Counter(r.get("category") for r in rows)),
        "resolved_true": sum(1 for r in rows if r.get("resolved")),
        "gap_classes": dict(gap_classes.most_common()),
        "not_in_ruleset": sum(1 for r in rows if r.get("in_ruleset") is False),
        "source": {"path": "tmp/pets100-skills.json",
                   "pets": len(source_pets), "skills": len(source_skills)},
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
        "# 盒子前 100 只精灵的技能并集 · 现状与缺口普查",
        "",
        f"- 技能 {summary['skills']} 条（来源 `{summary['source']['path']}`：{summary['source']['pets']} 只精灵）",
        f"- 类别：{summary['categories']}",
        f"- **三堆**：{summary['piles']}",
        f"- `mechanics.resolved=true` 的：**{summary['resolved_true']}** 条",
        "",
        "## 缺口分类",
        "",
    ]
    for name, count in summary["gap_classes"].items():
        lines.append(f"- {name}：**{count}** 处")
    lines += ["", "## 逐条", "",
              "| # | skill_id | 名字 | 类别 | 威力 | 耗能 | 说明 | 引擎现状 | 缺口 | 前 100 只里学得到的只数 |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for index, row in enumerate(rows, 1):
        if row.get("in_ruleset") is False:
            lines.append(f"| {index} | `{row['skill_id']}` | {row.get('name')} | | | | | **不在规则集** | | |")
            continue
        engine = f"{'✅' if row['resolved'] else '⚠'} {row['verdict']}" + \
            (f"（{row['support_tier']}）" if row.get("support_tier") else "")
        gaps = "；".join(row["gaps"]) if row["gaps"] else "—"
        lines.append(f"| {index} | `{row['skill_id']}` | {row['name']} | {row['category']} | "
                     f"{row['power'] if row['power'] is not None else '—'} | {row['energy']} | "
                     f"{(row['desc'] or '').replace('|', '｜')} | {engine} | "
                     f"{gaps.replace('|', '｜')} | {row['learnable_by_first100']} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
