#!/usr/bin/env python3
"""48 只名单的**引擎侧**审计：技能逐条分类 + 3v3 冒烟。

只读、不改引擎：所有判定都调用 `roco/src/roco_env/` 里**已有的**代码路径
（`effects.parse_defense_reduction` / `effects.effective_power` / `env._apply_status_effects`
/ `env._execute` / `opponents.play_match`），本脚本自己**不重写**任何规则。

与 `build-roster-48.mjs` 的分工：
  · Node 侧：622 只里选 48 只、每只 4 技能（选择规则可复现）。
  · 本脚本：这 76 个独特技能在引擎里**到底会怎样**——会算 / 只登记不算 / fail closed。

输入：
  tmp/roco-full-catalog.json                      （由 export-full-catalog.mjs 生成，gitignore）
  reports/roco/coverage/roster-48.json            （由 build-roster-48.mjs 生成）
  data/roco/normalized/roco-world-s4-2026-09-10/{skills,types,terms}.json

输出：
  reports/roco/coverage/roster-48-support.json    技能分类 + 每只精灵的可用性
  reports/roco/coverage/roster-48-smoke.json      3v3 冒烟（合法 3 元组 / 完赛 / unsupported / 延迟）

用法：
  python3 scripts/roco/audit-roster-48.py [--matches-per-strategy 12] [--seed 20260910]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import statistics
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import effects as fx          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import parse as rparse        # noqa: E402
from roco_env.schema import Action, GameState, PetState, SideState   # noqa: E402

NORM = os.path.join(ROOT, "data", "roco", "normalized", "roco-world-s4-2026-09-10")
CATALOG = os.path.join(ROOT, "tmp", "roco-full-catalog.json")
ROSTER = os.path.join(ROOT, "reports", "roco", "coverage", "roster-48.json")
OUT_SUPPORT = os.path.join(ROOT, "reports", "roco", "coverage", "roster-48-support.json")
OUT_SMOKE = os.path.join(ROOT, "reports", "roco", "coverage", "roster-48-smoke.json")

#: `effective_power` **真的**会拿去改威力的四类模式（`effects.py:207-244`）。
#: 不在这四类里的条件化威力，引擎按静态威力算——这是本轮要如实报出来的。
ENGINE_POWER_PATTERNS = {
    "energy_scaling": ("每有1能量", "每有 1 能量"),
    "energy_threshold": ("若敌方能量小于等于",),
    "respond_multiplier": ("应对状态", "应对攻击", "应对防御"),
    "burst": ("迸发",),
}
#: 与 `scripts/roco/build-support-matrix.mjs:249` **逐字相同**的「动态/条件威力」宽口径。
DATA_DYNAMIC_RE_HINT = ("每有1能量", "若敌方", "应对", "迸发", "蓄力", "翻倍", "变为", "连击")
#: 描述里出现这些词，说明这条技能除了伤害还有别的东西；攻击分支不会应用它们。
EXTRA_EFFECT_HINTS = (
    "回复", "获得", "消耗", "连击", "印记", "蓄力", "驱散", "免疫", "附带", "传说",
    "每", "若", "回合", "层", "影响", "奉献", "随机", "变",
)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# ── 用全量图鉴拼一个内存规则集（**只在本脚本里**，不写回仓库数据目录）──

def build_ruleset(roster_map: Dict[str, List[str]]) -> rdata.Ruleset:
    with open(CATALOG, "r", encoding="utf-8") as fh:
        cat = json.load(fh)
    with open(os.path.join(NORM, "skills.json"), "r", encoding="utf-8") as fh:
        sk = json.load(fh)
    with open(os.path.join(NORM, "types.json"), "r", encoding="utf-8") as fh:
        ty = json.load(fh)
    with open(os.path.join(NORM, "terms.json"), "r", encoding="utf-8") as fh:
        tm = json.load(fh)

    skills = {}
    for sid, s in sk["skills"].items():
        skills[sid] = rdata.Skill(
            skill_id=sid, name=s["name"], category=s.get("category") or "",
            element=s.get("element") or "", energy=int(s.get("energy") or 0),
            power=s.get("power"), power_status=s.get("power_status"),
            damage_class=s.get("damage_class"), desc=s.get("desc") or "",
            is_trait=bool(s.get("is_trait")), effect_support=s.get("effect_support", "unsupported"),
        )

    pets, by_name = {}, {}
    for pid, p in cat["pets"].items():
        pets[pid] = rdata.Pet(
            pet_id=pid, name=p["name"], title=p.get("title") or p["name"],
            types=tuple(p.get("types") or ()), stats={k: int(v) for k, v in p["stats"].items()},
            feature_skill_id=p.get("feature_skill_id"), learnset_id=p.get("learnset_id"),
            release_date=(p.get("release") or {}).get("date"), game_id=p.get("game_id"),
        )
        by_name.setdefault(p["name"], []).append(pid)

    learnsets = {}
    for pid, p in cat["pets"].items():
        l = cat["learnsets"].get(p.get("learnset_id"))
        if l is None:
            continue
        learnsets[pid] = rdata.Learnset(
            pet_id=pid, native=tuple(l["native"]), blood=tuple(l["blood"]),
            stones=tuple(l["stones"]),
        )

    rows: Dict[Tuple[str, ...], Dict[str, float]] = {}
    for key, row in ty["types"].items():
        table: Dict[str, float] = {}
        for e in row.get("weak", []):
            table[e["type"]] = float(e["multiplier"])
        for e in row.get("resist", []):
            table.setdefault(e["type"], float(e["multiplier"]))
        rows[tuple(sorted(key.split("|")))] = table

    terms = {str(k): rdata.Term(term_id=str(k), note=v.get("note") or "", desc=v.get("desc") or "")
             for k, v in tm["terms"].items()}

    files = {f"{n}.json": sha256(os.path.join(NORM, f"{n}.json")) for n in ("skills", "types", "terms")}
    files["roster-48.json"] = sha256(ROSTER)
    return rdata.Ruleset(
        ruleset_id="roco-world-s4-2026-09-10+roster48-audit", game="roco_world_mobile",
        source_revision=sk.get("source_revision", "audit"), skills=skills, pets=pets,
        learnsets=learnsets, type_chart=rdata.TypeChart(rows=rows), terms=terms,
        files=files, by_name=by_name,
        candidate_movesets={k: tuple(v) for k, v in roster_map.items()},
    )


def mkstate(rs: rdata.Ruleset, pid: str, foe_pid: str, *, energy: int = 6, foe_energy: int = 3) -> GameState:
    return GameState(
        ruleset_id=rs.ruleset_id, seed=1,
        player=SideState(name="player", pets=[PetState(pet_id=pid, slot=0, hp=100, max_hp=100, energy=energy)]),
        enemy=SideState(name="enemy", pets=[PetState(pet_id=foe_pid, slot=0, hp=100, max_hp=100, energy=foe_energy)]),
    )


# ── 技能逐条分类 ────────────────────────────────────────────────────────

def classify_skill(rs: rdata.Ruleset, sid: str, test_pet: str, foe_pet: str) -> Dict[str, Any]:
    skill = rs.skills[sid]
    parsed = rparse.parse_skill(skill)
    rec: Dict[str, Any] = {
        "skill_id": sid, "name": skill.name, "category": skill.category,
        "element": skill.element, "energy": skill.energy, "power": skill.power,
        "power_status": skill.power_status, "damage_class": skill.damage_class,
        "desc": skill.desc,
        "data_effect_support": skill.effect_support,
        "parsed_effect_kinds": parsed.kinds(),
        "parsed_unparsed": parsed.unparsed,
        "data_dynamic_power_hint": skill.power is not None and any(h in (skill.desc or "") for h in DATA_DYNAMIC_RE_HINT),
    }

    if skill.category == "防御":
        try:
            reduction = fx.parse_defense_reduction(skill)
            rec["engine_return"] = {"defense_reduction": reduction, "cooldown": fx.defense_cooldown_applies(skill),
                                    "respond_to": fx.respond_to(skill)}
            clause = parsed.respond_clause or ""
            rec["respond_clause"] = clause
            if clause and any(w in clause for w in ("获得", "回复", "驱散", "返场", "离场", "免疫",
                                                    "印记", "能量", "威力", "先手", "蓄力", "冻结",
                                                    "灼烧", "中毒", "寄生", "眩晕", "沉默", "封印",
                                                    "随机", "选择", "连击")):
                # 实测证明：防御分支在 `env.py:510-524` 直接 return，从不调用
                # `_apply_status_effects`，所以「应对成功：自己获得X」只解析、不应用、也不登记。
                st = mkstate(rs, test_pet, foe_pet)
                renv._execute(st, rs, "player", Action(kind="skill", skill_id=sid))
                rec["engine_probe"] = {
                    "event_kinds": [e.kind for e in st.events],
                    "unsupported_count": len(st.unsupported),
                    "buff_after": dict(st.player.field_pet.buffs),
                }
                rec["verdict"] = "partial_refused_subset"
                rec["reason_code"] = "defense_branch_never_applies_respond_clause"
                rec["reason"] = ("减伤比例会被结算；「应对成功：…」后面那条效果**既不应用也不登记**"
                                 "（防御分支 env.py:510-524 直接 return）")
            else:
                rec["verdict"] = "computed_unverified"
                rec["reason_code"] = "defense_reduction_unconditional_assumption"
                rec["reason"] = "减伤% 从描述读出并按无条件生效结算（假设 MC-020；术语 1016）"
            return rec
        except fx.UnsupportedEffect as exc:
            rec["verdict"] = "fail_closed"
            rec["reason_code"] = "defense_reduction_unreadable"
            rec["reason"] = str(exc)
            return rec

    if skill.category == "攻击":
        pet = PetState(pet_id=test_pet, slot=0, hp=100, max_hp=100, energy=6)
        foe = PetState(pet_id=foe_pet, slot=0, hp=100, max_hp=100, energy=3)
        try:
            pr = fx.effective_power(skill, attacker=pet, defender=foe, rs=rs)
        except fx.UnsupportedEffect as exc:
            rec["verdict"] = "fail_closed"
            rec["reason_code"] = "no_static_power"
            rec["reason"] = str(exc)
            return rec
        patterns = [k for k, words in ENGINE_POWER_PATTERNS.items() if any(w in (skill.desc or "") for w in words)]
        rec["engine_return"] = {"power": pr.power, "conditional": pr.conditional, "reason": pr.reason}
        notes = []
        if rec["data_dynamic_power_hint"] and not patterns:
            notes.append("宽口径判定为动态/条件威力，但 `effective_power` 的四类模式一个都没命中 → 按静态威力算")
        if "连击" in (skill.desc or ""):
            notes.append("`env.py:540` 的 `hit_count=1` 是硬编码，连击数不参与结算")
        # 攻击分支只做伤害：描述里其余效果既不应用也不登记。
        dropped = []
        if parsed.effects:
            dropped.append("parsed_effects:" + ",".join(parsed.kinds()))
        if parsed.unparsed:
            dropped.append("unparsed:" + ",".join(u.split("（")[0] for u in parsed.unparsed))
        if any(h in (skill.desc or "") for h in EXTRA_EFFECT_HINTS) and not parsed.effects and not parsed.unparsed:
            dropped.append("extra_mechanic_marker_unparsed")
        if dropped:
            notes.append("攻击分支只结算伤害；这些效果被静默丢弃（" + " / ".join(dropped) + "）")
        rec["verdict"] = "computed_uncorrected" if notes else "computed"
        rec["reason_code"] = "attack_path_uncorrected" if notes else "plain_damage_path"
        rec["reason"] = "；".join(notes) if notes else "描述里没有引擎未覆盖的附加机制，走纯伤害路径"
        rec["dropped_effects"] = dropped
        return rec

    if skill.category == "状态":
        st = mkstate(rs, test_pet, foe_pet)
        applied = renv._apply_status_effects(st, rs, "player", skill)
        rec["engine_probe"] = {
            "applied": applied,
            "event_kinds": [e.kind for e in st.events],
            "unsupported": [u["what"] for u in st.unsupported],
        }
        if parsed.unparsed:
            rec["verdict"] = "fail_closed"
            rec["reason_code"] = "unparsed_markers"
            rec["reason"] = "描述里有解析器没覆盖的机制标记（parse.py:46-49）：" + ",".join(
                u.split("（")[0] for u in parsed.unparsed)
            return rec
        if not parsed.effects:
            rec["verdict"] = "fail_closed"
            rec["reason_code"] = "no_parseable_effect"
            rec["reason"] = "描述里读不出任何被覆盖的效果原语（parse.py:83-93 全不命中）"
            return rec
        if not applied:
            rec["verdict"] = "fail_closed"
            rec["reason_code"] = "effect_kinds_not_implemented"
            rec["reason"] = "解析出了效果，但 `_apply_status_effects` 一条都没应用（env.py:612-684）"
            return rec
        kinds = set(parsed.kinds())
        refused = []
        if "escape" in kinds:
            refused.append("escape（离场需调用方选人，env.py:679-682 只登记）")
        if "weather" in kinds:
            refused.append("weather（没有天气层，env.py:683-684 只登记）")
        for e in parsed.effects:
            if e.kind == "foe_status" and str(e.value.get("status")) not in fx.END_OF_TURN_STATUS:
                refused.append("foe_status:" + str(e.value.get("status")) + "（不在 END_OF_TURN_STATUS，env.py:643-645 跳过）")
        registered = [k for k in ("self_mark", "foe_mark") if k in kinds]
        if refused:
            rec["verdict"] = "partial_refused_subset"
            rec["reason_code"] = "some_effects_refused"
            rec["reason"] = "部分效果被拒绝而不是近似：" + " / ".join(refused)
        elif registered:
            rec["verdict"] = "registered_not_computed"
            rec["reason_code"] = "mark_counted_effect_not_computed"
            rec["reason"] = "印记只累加层数并登记「叠加规则未定义（MC-009）」，印记的**效果**不结算"
        else:
            rec["verdict"] = "computed_unverified"
            rec["reason_code"] = "status_effects_applied_with_assumptions"
            rec["reason"] = "效果被应用；数值口径（基数/取整/回能顺序）是假设（MC-007/011/012）"
        return rec

    rec["verdict"] = "not_classified"
    rec["reason_code"] = "category_not_executable"
    rec["reason"] = f"类别「{skill.category}」不在可执行分支里（env.py:526-538 只处理 攻击/状态/防御）"
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", default=None,
                    help="名单 JSON 路径（默认 reports/roco/coverage/roster-48.json）")
    ap.add_argument("--matches-per-strategy", type=int, default=12)
    ap.add_argument("--seed", type=int, default=20260910)
    ap.add_argument("--skip-matches", action="store_true")
    args = ap.parse_args()

    global ROSTER, OUT_SUPPORT, OUT_SMOKE
    if args.roster:
        ROSTER = os.path.abspath(args.roster)
        tag = os.path.basename(ROSTER).replace(".json", "")
        OUT_SUPPORT = os.path.join(os.path.dirname(ROSTER), tag + "-support.json")
        OUT_SMOKE = os.path.join(os.path.dirname(ROSTER), tag + "-smoke.json")
    if not os.path.exists(CATALOG):
        print("缺 tmp/roco-full-catalog.json —— 先跑 node scripts/roco/export-full-catalog.mjs", file=sys.stderr)
        return 2
    with open(ROSTER, "r", encoding="utf-8") as fh:
        roster = json.load(fh)
    roster_map = {p["pet_id"]: [m["skill_id"] for m in p["moveset"]] for p in roster["pets"]}
    pet_order = [p["pet_id"] for p in roster["pets"]]
    rs = build_ruleset(roster_map)

    # 1) 全部 C(48,3) 三元的队伍/配招合法性
    legal = 0
    illegal = []
    n = len(pet_order)
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                trio = [pet_order[i], pet_order[j], pet_order[k]]
                # 只传这一组的配招（与 play_match 的口径一致：loadouts 覆盖双方队伍）
                probs = renv.validate_team(rs, trio, {pid: roster_map[pid] for pid in trio})
                if probs:
                    illegal.append({"team": trio, "problems": probs})
                else:
                    legal += 1
    total_trios = n * (n - 1) * (n - 2) // 6

    # 2) 每个独特技能的分类（用一只真的会带它的精灵做宿主，避免用不存在的 pet_id）
    skill_host: Dict[str, str] = {}
    for p in roster["pets"]:
        for m in p["moveset"]:
            skill_host.setdefault(m["skill_id"], p["pet_id"])
    unique_skills = sorted(skill_host)
    foe_pet = next(pid for pid in pet_order if pid != skill_host[unique_skills[0]])
    classifications = []
    for sid in unique_skills:
        classifications.append(classify_skill(rs, sid, skill_host[sid], foe_pet))

    verdict_hist: Dict[str, int] = {}
    reason_hist: Dict[str, int] = {}
    for c in classifications:
        verdict_hist[c["verdict"]] = verdict_hist.get(c["verdict"], 0) + 1
        reason_hist[c["reason_code"]] = reason_hist.get(c["reason_code"], 0) + 1

    by_skill = {c["skill_id"]: c for c in classifications}
    per_pet = []
    for p in roster["pets"]:
        vs = [by_skill[m["skill_id"]]["verdict"] for m in p["moveset"]]
        per_pet.append({
            "pet_id": p["pet_id"], "name": p["name"],
            "verdicts": vs,
            "all_four_computed": all(v in ("computed", "computed_unverified") for v in vs),
            "has_fail_closed": any(v == "fail_closed" for v in vs),
            "no_fail_closed": not any(v == "fail_closed" for v in vs),
            "fail_closed_skills": [m["skill_id"] for m, v in zip(p["moveset"], vs) if v == "fail_closed"],
            "partial_skills": [m["skill_id"] for m, v in zip(p["moveset"], vs) if v.startswith("partial") or v == "registered_not_computed"],
        })

    support = {
        "schema_version": 1,
        "generated_by": "scripts/roco/audit-roster-48.py",
        "command": "python3 scripts/roco/audit-roster-48.py",
        "ruleset_id_audit": rs.ruleset_id,
        "note": "分类由**引擎自己的代码路径**判定，不是文本猜测；每条都带 reason_code 与探测结果。",
        "roster_json_sha256": sha256(ROSTER),
        "catalog_sha256": sha256(CATALOG),
        "counts": {
            "pets": len(pet_order),
            "unique_skills": len(unique_skills),
            "verdicts": verdict_hist,
            "reason_codes": reason_hist,
            "fail_closed_skills": sum(1 for c in classifications if c["verdict"] == "fail_closed"),
            "computed_skills": sum(1 for c in classifications if c["verdict"].startswith("computed")),
            "partial_or_registered_skills": sum(1 for c in classifications
                                                if c["verdict"].startswith("partial") or c["verdict"] == "registered_not_computed"),
            "pets_all_four_computed": sum(1 for p in per_pet if p["all_four_computed"]),
            "pets_with_fail_closed": sum(1 for p in per_pet if p["has_fail_closed"]),
            "pets_no_fail_closed": sum(1 for p in per_pet if p["no_fail_closed"]),
        },
        "team_legality": {"checked_3subsets": total_trios, "legal": legal, "illegal_count": len(illegal),
                          "illegal_examples": illegal[:10]},
        "skills": classifications,
        "pets": per_pet,
    }
    os.makedirs(os.path.dirname(OUT_SUPPORT), exist_ok=True)
    with open(OUT_SUPPORT, "w", encoding="utf-8") as fh:
        json.dump(support, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    print(f"技能分类：{len(unique_skills)} 个独特技能 → {json.dumps(verdict_hist, ensure_ascii=False)}")
    print(f"原因码：{json.dumps(reason_hist, ensure_ascii=False)}")
    print(f"3 元组合法性：{legal}/{total_trios} 合法，非法 {len(illegal)}")
    print(f"四技能全部走 damage/status 路径的精灵：{support['counts']['pets_all_four_computed']}/{len(pet_order)}；"
          f"含 fail closed 技能的：{support['counts']['pets_with_fail_closed']}/{len(pet_order)}；"
          f"四技能里没有 fail closed 的：{support['counts']['pets_no_fail_closed']}/{len(pet_order)}")

    if args.skip_matches:
        return 0

    # 3) 3v3 冒烟：随机 3 只 vs 随机 3 只，5 类对手策略
    rng = random.Random(args.seed)
    strategies = [s["name"] for s in ropp.list_strategies()]
    matches = []
    latencies = []
    unsupported_counts = []
    for strat in strategies:
        for rep in range(args.matches_per_strategy):
            a = rng.sample(pet_order, 3)
            b = rng.sample(pet_order, 3)
            seed = rng.randrange(1, 10 ** 6)
            load = {pid: roster_map[pid] for pid in set(a) | set(b)}
            t0 = time.perf_counter()
            try:
                rec = ropp.play_match(rs, a, b, "greedy_damage", strat, seed=seed, loadouts=load, turn_limit=200)
                dt = (time.perf_counter() - t0) * 1000.0
                latencies.append(dt)
                unsupported_counts.append(len(rec.unsupported or []))
                matches.append({"seed": seed, "team_a": a, "team_b": b, "strategy_b": strat,
                                "winner": rec.winner, "battle_turns": rec.battle_turns,
                                "truncated": rec.truncated, "error": rec.error,
                                "unsupported": len(rec.unsupported or []), "latency_ms": round(dt, 2)})
            except Exception as exc:                      # noqa: BLE001 —— 异常要如实记账，不吞
                dt = (time.perf_counter() - t0) * 1000.0
                latencies.append(dt)
                matches.append({"seed": seed, "team_a": a, "team_b": b, "strategy_b": strat,
                                "error": f"{type(exc).__name__}: {exc}", "latency_ms": round(dt, 2)})

    ok = [m for m in matches if not m.get("error") and not m.get("truncated")]
    errs = [m for m in matches if m.get("error")]
    trunc = [m for m in matches if m.get("truncated")]
    pct = lambda xs, p: (sorted(xs)[min(len(xs) - 1, int(len(xs) * p))] if xs else None)
    turns = [m["battle_turns"] for m in ok]
    smoke = {
        "schema_version": 1,
        "generated_by": "scripts/roco/audit-roster-48.py",
        "command": f"python3 scripts/roco/audit-roster-48.py --matches-per-strategy {args.matches_per_strategy} --seed {args.seed}",
        "note": ("这是**冒烟**，不是 1 万局压测：本轮只设计压测矩阵，未跑满。"
                 "口径：双方各随机 3 只（来自 48 只），我方固定 greedy_damage，对手依次取 5 类策略，"
                 "turn_limit=200，配招来自 roster-48.json。"),
        "team_legality": {"checked_3subsets": total_trios, "legal": legal, "illegal": len(illegal)},
        "matches_total": len(matches),
        "completed": len(ok), "errors": len(errs), "truncated": len(trunc),
        "completion_rate": (len(ok) / len(matches)) if matches else None,
        "battle_turns": {"min": min(turns) if turns else None, "p50": pct(turns, 0.5), "p95": pct(turns, 0.95),
                         "max": max(turns) if turns else None},
        "latency_ms": {"p50": pct(latencies, 0.5), "p95": pct(latencies, 0.95),
                       "max": max(latencies) if latencies else None},
        "unsupported_per_match": {"p50": pct(unsupported_counts, 0.5), "p95": pct(unsupported_counts, 0.95),
                                  "max": max(unsupported_counts) if unsupported_counts else None,
                                  "mean": (statistics.mean(unsupported_counts) if unsupported_counts else None)},
        "by_strategy": {s: {"n": sum(1 for m in matches if m["strategy_b"] == s),
                            "completed": sum(1 for m in matches if m["strategy_b"] == s and not m.get("error") and not m.get("truncated")),
                            "errors": sum(1 for m in matches if m["strategy_b"] == s and m.get("error")),
                            "truncated": sum(1 for m in matches if m["strategy_b"] == s and m.get("truncated"))}
                        for s in strategies},
        "error_examples": [m for m in errs[:5]],
        "matches": matches,
    }
    with open(OUT_SMOKE, "w", encoding="utf-8") as fh:
        json.dump(smoke, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"3v3 冒烟：{len(ok)}/{len(matches)} 完赛，截断 {len(trunc)}，异常 {len(errs)}；"
          f"回合 p50={smoke['battle_turns']['p50']} p95={smoke['battle_turns']['p95']}；"
          f"单局耗时 p50={smoke['latency_ms']['p50']:.0f}ms p95={smoke['latency_ms']['p95']:.0f}ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
