#!/usr/bin/env python3
"""把实测与引擎的预测摆在一起，**由人设定的规则**判定，并给出参数标定。

两件事严格分开
--------------

1. **判定**：实测与引擎预测差多少，是否落在容差内。容差**必须由命令行给**
   （`--tolerance-pct 5`），脚本不替人拍一个「算通过」的阈值。
   不给容差就只报告差异，不下结论。
2. **标定**：把实测代回公式，反解出「如果公式的结构对，那个系数应该等于多少」。
   例如本系加成若真是 1.5，反解出来就该接近 1.5；反解出 1.05 就说明假设错了。
   **标定只报告数字与「与当前假设的偏离」，不自动改公式** ——
   改公式是人的决定（要连带改 `COMMUNITY_HYPOTHESIS_V1` 的版本号与理由）。

跑法::

    python3 scripts/roco/calibrate-from-measurements.py --tolerance-pct 5
    python3 scripts/roco/calibrate-from-measurements.py            # 只报告差异
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import effects as fx          # noqa: E402
from roco_env import env as renv            # noqa: E402

MEASUREMENTS = os.path.join("data", "roco", "measurements.jsonl")
OUT_JSON = os.path.join("reports", "roco", "microcases", "calibration.json")
OUT_DOC = os.path.join("docs", "roco", "CALIBRATION.md")


def load_measurements() -> List[Dict[str, Any]]:
    path = os.path.join(_ROOT, MEASUREMENTS)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def pet_id_of(rs, name: str) -> Optional[str]:
    found = rs.pets_by_name(name)
    return found[0].pet_id if found else None


def skill_of(rs, name: str):
    for skill in rs.skills.values():
        if skill.name == name:
            return skill
    return None


def engine_damage(rs, attacker_name: str, defender_name: str, skill_name: str,
                  defender_guarded: bool) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """用引擎算一次伤害，并把中间量都带出来（标定要用）。

    构造方式刻意最小：只放双方各一只、用同一个技能、其余状态取默认。
    因为实测给的信息就这么少——**多编状态就等于在替实测补数据**。
    """
    atk_id = pet_id_of(rs, attacker_name)
    def_id = pet_id_of(rs, defender_name)
    if atk_id is None:
        return None, f"规则集里查不到攻击方「{attacker_name}」"
    if def_id is None:
        return None, f"规则集里查不到被攻击方「{defender_name}」"
    skill = skill_of(rs, skill_name)
    if skill is None:
        return None, f"规则集里查不到技能「{skill_name}」"
    if skill.power is None:
        return None, f"技能「{skill_name}」没有静态威力（条件化威力需要额外输入）"

    third = [p.pet_id for p in rs.pets.values() if p.pet_id not in (atk_id, def_id)][:1]
    if not third:
        return None, "规则集里凑不出第三只精灵（引擎要求 3v3）"
    loader = {atk_id: [skill.skill_id]}
    # 只给攻击方指定配招；其余用规范配招。这样引擎里唯一被改动的就是「它带了这一招」。
    try:
        st = renv.reset([atk_id, third[0], def_id], [def_id, third[0], atk_id], seed=1,
                        rs=rs, loadouts=loader)
    except Exception as exc:  # noqa: BLE001
        return None, f"构造局面失败：{type(exc).__name__}: {exc}"

    attacker = st.player.field_pet
    defender = st.enemy.field_pet
    if defender_guarded:
        # 实测说被攻击方用了防御：按「一个减伤为 X 的防御技能」建模。
        # 这里不指定具体技能，因为实测记录里没写用的是哪个防御技能 ——
        # 所以标定时把实际生效的 reduction 原样报出来，让人看到这个自由度。
        setattr(defender, "_defense_reduction", 0.0)

    try:
        pr = fx.effective_power(skill, attacker=attacker, defender=defender, rs=rs)
    except fx.UnsupportedEffect as exc:
        return None, f"引擎拒绝算这个技能：{exc}"

    atk_race = rs.pet(attacker.pet_id)
    def_race = rs.pet(defender.pet_id)
    atk_panel = rdata.panel_stats(atk_race.stats)
    def_panel = rdata.panel_stats(def_race.stats)
    attacker_atk = atk_panel.get("atk", float(atk_race.stats.get("atk", 1)))
    defender_def = def_panel.get("def", float(def_race.stats.get("def", 1)))
    type_mult = rs.type_chart.multiplier(def_race.types, skill.element)
    stab = fx.stab_multiplier(skill, atk_race.types)
    model = fx.active_damage_model()
    predicted = model.compute(
        attacker_atk=float(attacker_atk), defender_def=float(defender_def),
        power=float(pr.power), type_multiplier=float(type_mult), stab=float(stab),
        hit_count=1, power_multiplier=1.0,
        ability_level=fx.buff_damage_multiplier(dict(attacker.buffs), dict(defender.buffs)),
    )
    return {
        "predicted": predicted,
        "attacker_atk": attacker_atk,
        "defender_def": defender_def,
        "power": pr.power,
        "type_multiplier": type_mult,
        "stab": stab,
        "damage_model": model.name,
        "formula_verified": model.verified,
        "conditional": pr.conditional,
    }, None


def calibrate_damage(rs, record: Dict[str, Any], tolerance_pct: Optional[float]) -> Dict[str, Any]:
    guarded = str(record.get("defender_guarded", "no")).lower() in ("yes", "y", "true", "1")
    actual = int(record["damage"])
    detail, why = engine_damage(rs, record["attacker"], record["defender"], record["skill"], guarded)
    out: Dict[str, Any] = {
        "kind": "damage",
        "case_id": record.get("case_id"),
        "measured": actual,
        "defender_guarded": guarded,
        "note": record.get("note"),
        "observed_at": record.get("observed_at"),
        "source": record.get("source"),
    }
    if detail is None:
        out.update({"status": "NOT_COMPARABLE", "why": why})
        return out
    predicted = detail["predicted"]
    error = actual - predicted
    error_pct = (error / predicted * 100.0) if predicted else None
    out.update({
        "engine": detail,
        "error": error,
        "error_pct": round(error_pct, 2) if error_pct is not None else None,
    })
    if tolerance_pct is None:
        out["status"] = "REPORTED_ONLY"      # 没给容差就不下结论
    else:
        out["status"] = "WITHIN_TOLERANCE" if abs(error_pct) <= tolerance_pct else "OUT_OF_TOLERANCE"
        out["tolerance_pct"] = tolerance_pct

    # ── 标定：反解本系加成 ────────────────────────────────────────────
    # 公式结构（社区假设）：damage = atk/def * power * 0.9 * 属性 * 本系 * 连击 * 威力buff
    # 已知除本系外的全部因子，就能反解「本系加成应该是多少」。
    base_without_stab = (detail["attacker_atk"] / max(1.0, detail["defender_def"])) \
        * detail["power"] * 0.9 * detail["type_multiplier"]
    if base_without_stab > 0:
        implied_stab = actual / base_without_stab
        out["calibration"] = {
            "implied_stab_multiplier": round(implied_stab, 4),
            "current_hypothesis": detail["stab"],
            "deviation": round(implied_stab - detail["stab"], 4),
            "note": (
                "把实测代回**公式结构**反解出的本系加成。它只在「结构对、其余因子都对」"
                "的前提下有意义；取整误差、个体值/性格未记录都会让它偏移。"
                "**不自动改公式**：改公式要连带改 COMMUNITY_HYPOTHESIS_V1 的版本与理由。"
            ),
        }
    return out


def calibrate_speed_tie(rs, record: Dict[str, Any], tolerance_pct: Optional[float]) -> Dict[str, Any]:
    first = record.get("first_moved")
    repeats = int(record.get("repeats") or 0)
    out = {
        "kind": "speed_tie",
        "case_id": record.get("case_id"),
        "pet_a": record.get("pet_a"),
        "pet_b": record.get("pet_b"),
        "first_moved": first,
        "repeats": repeats,
        "note": record.get("note"),
        "observed_at": record.get("observed_at"),
        "engine_assumption": (
            "引擎在同速且同先手度时用 **seed 驱动的确定性随机**裁决"
            "（env.order_actions 的第 4 个排序键）。"
        ),
    }
    if first == "unknown":
        out["status"] = "NOT_COMPARABLE"
        out["why"] = "实测没记录谁先动，无法与任何一种裁决方式比较"
    elif first == "same_time":
        out["status"] = "CONTRADICTS_ENGINE"
        out["why"] = ("实测是同**时**结算，而引擎假设逐条排序执行。"
                      "这属于结构性差异，不是随机源的问题 —— 需要人的决定。")
    elif repeats < 2:
        out["status"] = "REPORTED_ONLY"
        out["why"] = "只观察一次，无法判断「固定顺序」还是「随机」"
    else:
        out["status"] = "REPORTED_ONLY"
        out["why"] = (
            "引擎用随机裁决；实测若**每次都是同一方先动**，就与引擎的实现方向不符。"
            "判定需要更多重复（建议 ≥ 10 次）与人的决定。"
        )
    return out


def calibrate_buff(rs, record: Dict[str, Any], tolerance_pct: Optional[float]) -> Dict[str, Any]:
    actual = int(record["damage"])
    baseline = int(record["baseline_damage"])
    ratio = (actual / baseline) if baseline else None
    out = {
        "kind": "buff",
        "case_id": record.get("case_id"),
        "buff_desc": record.get("buff_desc"),
        "baseline_damage": baseline,
        "damage_with_buff": actual,
        "observed_ratio": round(ratio, 4) if ratio else None,
        "note": record.get("note"),
        "observed_at": record.get("observed_at"),
        "engine_assumption": (
            "引擎把属性增减折成乘区 `(1 + 攻方物攻增减) / max(0.1, 1 + 守方物防增减)`，"
            "多个来源**相加**（effects.buff_damage_multiplier，标注 COMMUNITY_HYPOTHESIS_V1）。"
        ),
    }
    # 从增减文本里读百分比，算一个「相加口径」的预言值
    import re
    m = re.search(r"([+-]?\d+)\s*%", str(record.get("buff_desc") or ""))
    if not m:
        out["status"] = "NOT_COMPARABLE"
        out["why"] = "`buff_desc` 里读不出百分比，无法与模型比较"
        return out
    pct = int(m.group(1)) / 100.0
    additive_prediction = 1.0 + pct
    out["model_prediction_ratio"] = round(additive_prediction, 4)
    if ratio is not None:
        out["deviation"] = round(ratio - additive_prediction, 4)
        out["status"] = "REPORTED_ONLY" if tolerance_pct is None else (
            "WITHIN_TOLERANCE" if abs(ratio - additive_prediction) <= tolerance_pct / 100.0
            else "OUT_OF_TOLERANCE")
        out["observation"] = (
            "实测倍率与「相加」模型的预测相差 "
            f"{abs(ratio - additive_prediction):.4f}。"
            "若实测倍率接近 (1+pct) 而引擎也按相加算，两者一致；"
            "若实测接近别的形状（例如相乘），说明 MC-028 的假设要改。"
        )
    return out


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="实测 vs 引擎：判定与标定")
    parser.add_argument("--tolerance-pct", type=float, default=None,
                        help="判定容差（百分比）。**必须由人给**；不给就只报告差异，不下结论。")
    args = parser.parse_args(argv)

    rs = rdata.load_ruleset()
    records = load_measurements()
    results: List[Dict[str, Any]] = []
    for record in records:
        kind = record.get("kind")
        if kind == "damage":
            results.append(calibrate_damage(rs, record, args.tolerance_pct))
        elif kind == "speed_tie":
            results.append(calibrate_speed_tie(rs, record, args.tolerance_pct))
        elif kind == "buff":
            results.append(calibrate_buff(rs, record, args.tolerance_pct))
        else:
            results.append({"kind": kind, "status": "UNKNOWN_KIND",
                            "why": f"不认识的 kind：{kind!r}"})

    summary = {
        "measurements": len(records),
        "tolerance_pct": args.tolerance_pct,
        "statuses": {},
    }
    for item in results:
        status = item.get("status", "UNKNOWN")
        summary["statuses"][status] = summary["statuses"].get(status, 0) + 1

    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "generated_by": "scripts/roco/calibrate-from-measurements.py",
        "ruleset_id": rs.ruleset_id,
        "important": [
            "**容差由人给。** 脚本不替人拍一个「算通过」的阈值；不给容差就只报告差异。",
            "标定只反解系数并报出与当前假设的偏离，**不自动改公式**；"
            "改公式要连带改 COMMUNITY_HYPOTHESIS_V1 的版本与理由。",
            "实测记录只有一次时，任何「一致」都只是**一次**观察一致，"
            "不构成「机制已核验」。",
        ],
        "summary": summary,
        "results": results,
    }

    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    write_doc(payload)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not records:
        print("（还没有实测记录：先跑 scripts/roco/record-measurements.py）")
    print(f"wrote {OUT_JSON} and {OUT_DOC}")
    return 0


def write_doc(payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    p = lines.append
    p("# 实测 vs 引擎：标定报告")
    p("")
    # 生成时间不写进文档（每次跑都变，会让 git 每次都显示改动）；
    # 它留在 `reports/roco/microcases/calibration.json` 里。
    p("> 脚本：`scripts/roco/calibrate-from-measurements.py`"
      "　（生成时间是易变字段，留在 `reports/roco/microcases/calibration.json`）")
    p(f"> 规则集：`{payload['ruleset_id']}`")
    p("")
    for line in payload["important"]:
        p(f"- {line}")
    p("")
    p("## 汇总")
    p("")
    p(f"- 实测条数：**{payload['summary']['measurements']}**")
    p(f"- 判定容差：{payload['summary']['tolerance_pct'] if payload['summary']['tolerance_pct'] is not None else '**未给出（只报告差异）**'}")
    p(f"- 各状态计数：`{json.dumps(payload['summary']['statuses'], ensure_ascii=False)}`")
    p("")
    if not payload["results"]:
        p("## 还没有实测")
        p("")
        p("入口：")
        p("")
        p("```bash")
        p("python3 scripts/roco/record-measurements.py --interactive")
        p("python3 scripts/roco/calibrate-from-measurements.py --tolerance-pct 5")
        p("```")
        p("")
        p("值得先测的三条（按「一条能解锁多少条」排序）见")
        p("`docs/roco/MICROCASE-HARNESS.md` §4。")
    else:
        p("## 逐条")
        p("")
        for item in payload["results"]:
            p(f"### {item.get('case_id')}（{item.get('kind')}）")
            p("")
            p(f"```json\n{json.dumps(item, ensure_ascii=False, indent=2)}\n```")
            p("")
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_DOC)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_DOC), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
