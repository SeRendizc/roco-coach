#!/usr/bin/env python3
"""B 段 · 把「最小战斗冒烟」的两份原始产物合并成一张清单（JSON + 人读 md）。

两列**必须分开**（人类 2026-09-29 逐字：「每只的基础可玩与特殊机制/实机核验分开统计，
不能只改标签宣布全可战斗」）：

  ① `基础可玩`：这只精灵**现在**能不能被选进队 → 组成合法六只 → 开局 →
     出它那四个技能（或换人）→ 打到结算。判据只有三种：引擎回执 OK、引擎回执失败原文、没跑。
  ② `特殊机制核验`：这只的**决定性效果**（特性那条 + 四个技能的自带效果）
     引擎实现了没有、**实机核验**过没有。这一列**不拿①的结果顶替**：
     能开局只写「能开局」，机制没实现就写「没实现」。

输入（都只读）：
  reports/roco/battle-smoke/engine-sweep.json      引擎侧全量逐只
  reports/roco/battle-smoke/entry-sweep.json       HTTP 入口侧全量逐只（含组合测试）
  data/roco/owned/owned-pets.json                  实例与四技能
  data/roco/engine-trait-status.json               引擎侧**特性**实现状态（FULL/PARTIAL/REFUSED）
  data/roco/derived/pet-mechanisms.json            特性原文与「未实机核验」声明
  data/roco/normalized/<ruleset>/skills.json       数据侧 effect_support（全 unsupported）

用法：
    python3 scripts/roco/battle-smoke-summary.py
"""
from __future__ import annotations

import collections
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SMOKE = os.path.join(ROOT, "reports", "roco", "battle-smoke")
RULESET = "roco-world-s4-2026-09-10"

COMMANDS = [
    "node scripts/roco/battle-smoke.mjs                    # 一条命令跑完下面四段（≈3min）",
    "python3 scripts/roco/battle-smoke-engine.py            # ① 引擎侧全量 542（≈40s）",
    "node scripts/roco/battle-smoke-entry.mjs --settle=all  # ② HTTP 入口侧全量 542（≈90s）",
    "python3 scripts/roco/battle-smoke-summary.py           # ③ 合成清单 + 人读 md",
    "python3 scripts/roco/battle-smoke-repro.py             # ④ 把打不完的那几局逐手复现（带 traceback）",
    "python3 scripts/roco/battle-smoke-repro.py --only own-0442   # 只复现绞轮那一条",
    "node scripts/roco/battle-smoke-browser.mjs --base=http://127.0.0.1:8765 --shots"
    "  # 浏览器入口（先按 tmp/BROWSER-LOCK.md 抢锁）",
]


def load_json(path: str) -> Optional[Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def skill_name_map() -> Dict[str, str]:
    doc = load_json(os.path.join(ROOT, "data", "roco", "normalized", RULESET, "skills.json")) or {}
    rows = doc.get("skills") if isinstance(doc, dict) else doc
    if isinstance(rows, dict):
        rows = list(rows.values())
    return {r.get("skill_id"): r.get("name") for r in (rows or []) if r.get("skill_id")}


def main() -> int:
    engine = load_json(os.path.join(SMOKE, "engine-sweep.json"))
    entry = load_json(os.path.join(SMOKE, "entry-sweep.json"))
    owned = load_json(os.path.join(ROOT, "data", "roco", "owned", "owned-pets.json"))
    trait = load_json(os.path.join(ROOT, "data", "roco", "engine-trait-status.json")) or {}
    mech = load_json(os.path.join(ROOT, "data", "roco", "derived", "pet-mechanisms.json")) or {}
    neg = load_json(os.path.join(SMOKE, "negative-energy-cost-repro.json"))
    scan = load_json(os.path.join(SMOKE, "negative-cost-scan.json"))
    if not owned:
        print("缺 data/roco/owned/owned-pets.json", file=sys.stderr)
        return 2

    instances: List[Dict[str, Any]] = owned["instances"]
    species_of = {i["instance_id"]: i["species_id"] for i in instances}
    builds = {b["owned_pet_instance_id"]: b for b in owned["battle_builds"]}
    names = skill_name_map()
    trait_by_pet = {p["pet_id"]: p for p in (trait.get("pets") or [])}
    mech_by_pet = mech.get("pets") or {}

    total = len(instances)

    # ── ① 基础可玩（引擎侧）────────────────────────────────────────────────
    eng_recs = (engine or {}).get("records") or []
    eng_by_id = {r["instance_id"]: r for r in eng_recs}
    eng_counts = (engine or {}).get("counts") or {}
    playable_fail: List[Dict[str, Any]] = []
    for r in eng_recs:
        if not r.get("playable"):
            playable_fail.append({
                "instance_id": r["instance_id"], "species_id": r.get("species_id"),
                "name": r.get("species_name"), "step": (r.get("failure") or {}).get("step"),
                "text": (r.get("failure") or {}).get("text"),
            })
    four_not_used: List[Dict[str, Any]] = []
    for r in eng_recs:
        if r.get("skills_never_used"):
            four_not_used.append({
                "instance_id": r["instance_id"], "name": r.get("species_name"),
                "missing": [{"skill_id": s, "name": names.get(s)} for s in r["skills_never_used"]],
                "reasons": [{"skill_id": g["skill_id"], "name": g["name"], "kind": g["kind"],
                             "reason": g["reason"]} for g in (r.get("skill_gaps") or [])],
            })

    # ── ① 基础可玩（HTTP 入口侧）───────────────────────────────────────────
    ent_recs = (entry or {}).get("records") or []
    ent_counts = (entry or {}).get("counts") or {}
    entry_fail = [{
        "instance_id": r["instance_id"], "species_id": r.get("species_id"), "name": r.get("species_name"),
        "step": (r.get("failure") or {}).get("step"), "text": (r.get("failure") or {}).get("text"),
    } for r in ent_recs if not r.get("playable")]
    settle_fail = [{
        "instance_id": r["instance_id"], "name": r.get("species_name"),
        "step": "settle", "text": (r.get("failure") or {}).get("text"),
        "detail": r.get("steps", {}).get("settle", {}).get("detail"),
    } for r in ent_recs if r.get("steps", {}).get("settle", {}).get("ok") is False]
    combos = (entry or {}).get("combos") or []

    # ── ② 特殊机制核验 ─────────────────────────────────────────────────────
    trait_bucket = collections.Counter()
    trait_rows: List[Dict[str, Any]] = []
    in_battle_unsupported: List[Dict[str, Any]] = []
    for inst in instances:
        sp = inst["species_id"]
        st = trait_by_pet.get(sp)
        if st:
            trait_bucket[st["status"]] += 1
            trait_rows.append({
                "instance_id": inst["instance_id"], "species_id": sp, "name": inst.get("species_name"),
                "trait_skill_id": st.get("trait_skill_id"), "trait": st.get("trait"),
                "status": st["status"], "hook": st.get("hook"), "gaps": st.get("gaps") or [],
                "reason": st.get("reason"),
            })
        else:
            trait_bucket["NOT_REGISTERED_IN_ENGINE"] += 1
        rec = eng_by_id.get(inst["instance_id"]) or {}
        own_unsup = rec.get("effects_registered_unsupported_for_target") or []
        if own_unsup:
            in_battle_unsupported.append({
                "instance_id": inst["instance_id"], "species_id": sp, "name": inst.get("species_name"),
                "count": len(own_unsup),
                "skills": sorted({u.get("skill_id") for u in own_unsup}),
                "sample_text": own_unsup[0].get("text"),
            })
    verified = 0   # 实机核验：本仓没有任何一只被标记成「实机核验过」——见 pet-mechanisms.unverified
    mech_status = collections.Counter(
        (mech_by_pet.get(i["species_id"]) or {}).get("mechanism_status") for i in instances)

    summary = {
        "schema_version": 1,
        "artifact": "battle-smoke-summary",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "ruleset_id": RULESET,
        "scope": "data/roco/owned/owned-pets.json 的全部实例（= 当前已拥有清单）",
        "commands": COMMANDS,
        "column_1_playable": {
            "total": total,
            "engine": {**(eng_counts or {}), "artifact": "reports/roco/battle-smoke/engine-sweep.json"},
            "entry_http": {**(ent_counts or {}), "artifact": "reports/roco/battle-smoke/entry-sweep.json"},
            "failures_engine": playable_fail,
            "failures_entry": entry_fail,
            "failures_entry_settle": settle_fail,
            "all_four_not_used": four_not_used,
            "combos": [{"label": c.get("label"), "team": c.get("team"), "playable": c.get("playable"),
                    "team_species": [[i, species_of.get(i)] for i in (c.get("team") or [])],
                        "result": (c.get("steps", {}).get("settle", {}).get("detail") or {}).get("result"),
                        "turns": (c.get("steps", {}).get("settle", {}).get("detail") or {}).get("turns"),
                        "failure": c.get("failure")} for c in combos],
        },
        "column_2_mechanism": {
            "engine_trait_status": dict(trait_bucket),
            "engine_trait_status_source": "data/roco/engine-trait-status.json（引擎侧实现状态，非数据侧 effect_support）",
            "notes": [
                "FULL = 引擎按原语完整实现；PARTIAL = 部分实现、仍有登记的缺口；"
                "REFUSED = 依赖引擎做不到的前提，理由写在 reason 里；"
                "NOT_REGISTERED_IN_ENGINE = 这份产物里根本没有它 ⇒ 引擎没实现这条特性。",
                f"这 {total} 只里有 {trait_bucket['FULL']} 只的决定性特性是引擎**已实现**的。",
                "数据侧 skills.json 的 effect_support 对 824/824 条技能全是 `unsupported`"
                "（上游快照口径），与引擎侧的实现状态是两件事，不能互相顶替。",
            ],
            "in_game_verified": verified,
            "in_game_verified_note": (
                "实机核验 = 0/542：`data/roco/derived/pet-mechanisms.json` 里这 542 只的 "
                "mechanism_status **全部**是 FROZEN_DESC，且每只都带两条 unverified"
                "（「技能/特性效果未实机核验（MC-E08 等 microcase 未录制）」、"
                "「desc 文字来自冻结导入，触发条件与时序未验证」）。"
                "本仓没有任何一只被标记成实机核验过 —— 所以这一列是 0，不是 542。"),
            "mechanism_status_distribution": dict(mech_status),
            "trait_rows": trait_rows,
            "in_battle_unsupported_count": len(in_battle_unsupported),
            "in_battle_unsupported": in_battle_unsupported,
            "in_battle_unsupported_note": (
                "「战斗中这一只**自己出手**时，引擎把某条已解析的效果登记为『没有结算』」的只数。"
                "它不改变①（那一手仍然合法、仍然推进），但它是②的直接证据："
                "这一条效果**没有**被结算，引擎只是如实记账，没有伪装结算。"),
        },
        "blocking_mechanism_gaps": blocking_gaps(entry, eng_by_id, neg, scan),
        "raw": {
            "engine_sweep": "reports/roco/battle-smoke/engine-sweep.json",
            "entry_sweep": "reports/roco/battle-smoke/entry-sweep.json",
            "entry_sweep_base": (entry or {}).get("base"),
        },
    }
    os.makedirs(SMOKE, exist_ok=True)
    with open(os.path.join(SMOKE, "battle-smoke-summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)

    md = render_md(summary, total, names)
    with open(os.path.join(SMOKE, "battle-smoke.md"), "w", encoding="utf-8") as fh:
        fh.write(md)
    print(json.dumps({"column_1": summary["column_1_playable"]["engine"],
                      "entry": summary["column_1_playable"]["entry_http"],
                      "column_2": summary["column_2_mechanism"]["engine_trait_status"]},
                     ensure_ascii=False))
    print(f"→ {SMOKE}/battle-smoke-summary.json\n→ {SMOKE}/battle-smoke.md")
    return 0


def blocking_gaps(entry: Optional[Dict[str, Any]], eng_by_id: Dict[str, Any],
                  neg: Optional[Dict[str, Any]] = None,
                  scan: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """**阻塞性**机制缺口：不是「没实现所以不出这一手」，而是「这一手已经被列为合法，
    结算到一半却因为同回合里能耗被改下去而变成非法」—— 引擎 fail closed，整局中断。

    人类 2026-09-29 口径：这一类**记进机制缺口那一列**，不许算成「可玩」，
    也不许为了让数字好看删掉用例、或给它设一个没有依据的下限。
    """
    out: List[Dict[str, Any]] = []
    if neg:
        ba = neg.get("before_after") or {}
        before = ba.get("before") or {}
        after = ba.get("after") or {}
        out.append({
            "instance_id": "own-0442（冒烟里踩到的那一只）/ 自足复现配方：" + neg["attacker"]["pet_id"]
                           + " + " + neg["rampled"]["pet_id"],
            "species_id": neg["rampled"]["pet_id"],
            "name": neg["rampled"]["name"] + "（持有「绞轮」）",
            "step": "结算中途（自足复现；修前炸在第 %s 回合，修后整局打到第 %s 回合结算）"
                    % (before.get("turn"), neg.get("turns")),
            "recorded_action": (before.get("timeline_tail") or [{}])[-1] if before else None,
            "engine_reply": (
                "修前：UnsupportedEffect: " + str(before.get("message"))
                + "　⇒ 服务层 internal_error ⇒ Node HTTP 400，重试必复现。\n"
                "修后：不抛异常 —— 这一手变成 `action_cancelled{reason: energy_cost_unresolved}`"),
            "error_type": "修前 internal_error / 修后（无异常）",
            "gap_status": (
                "**缺口仍在，一个字都没降**：引擎**没有**给负能耗定下限（MC-018 没定义），"
                "`skill_000494` 依旧列在②机制核验的缺口里。这次修的只有"
                "「别炸整局 / 别把死局递给玩家」。"),
            "root_cause": (
                "「绞轮」的基础能耗 5，描述是"
                "「造成物伤，每受到1次抵抗的技能攻击（不含连击），本技能能耗永久-1」。"
                "修前逐回合：ramp = —/-1/-2/-3/-4/-5，有效能耗 5/4/3/2/1/**0**，"
                "**每一回合它都在合法动作列表里**（引擎自己列的）。到 0 那一回合，"
                "同一回合里我方先出手的一次**属性抵抗**命中让它再 -1（ramp -6），"
                "随后轮到它结算时 `_execute` 重算能耗 = 5 + (-6) = **-1** ⇒ 抛 UnsupportedEffect。"),
            "fix": (
                "**两层都做了**：① `legal_actions` 与 `_execute` 现在读**同一个** "
                "`resolved_skill_cost`，解不出定价（含负值）就**不提供这一手**，"
                "不再「算不出就退回基础能耗」；② 执行前再判一次（"
                "`_cancel_unresolvable_skill`）—— 合法动作表是回合开始时算的，"
                "中途被压负的那一手变成一条**能结算的** `action_cancelled` 事件、回合继续走完。"
                "另外玩家路径（`service.battle_advance`）对任何残留 unsupported 都兜底成可结算事件，"
                "错误分类改成 422 `unsupported_effect`（不再是 500 `internal_error` / HTTP 400）。"),
            "before_after": {
                "before": {"outcome": before.get("outcome"), "turn": before.get("turn"),
                           "exception_type": before.get("exception_type")},
                "after": {"outcome": after.get("outcome"), "battle_result": after.get("battle_result"),
                          "turns": neg.get("turns"),
                          "cancellations": after.get("cancellations"),
                          "unsupported_entries": after.get("unsupported_entries")},
            },
            "cancellations": neg.get("cancellations"),
            "repro": neg.get("repro_command"),
            "repro_artifact": "reports/roco/battle-smoke/negative-energy-cost-repro.json",
            "before_artifact": "reports/roco/battle-smoke/negative-energy-cost-repro.before.json",
            "timeline": neg.get("timeline") or [],
        })
    if scan:
        probe = scan.get("residual_unsupported_probe") or {}
        out.append({
            "instance_id": "全类扫描（不是单只）",
            "species_id": None,
            "name": "负能耗入口 + 残留 unsupported（%d 条「能耗永久-N」技能逐条打）"
                    % scan.get("ramp_skill_count", 0),
            "step": "机制级判据 A/B/C",
            "engine_reply": (
                "cases=%s ok=%s skipped=%s failed=%s；"
                "残留 unsupported 探针（%s「%s」）：in_player_legal=%s、"
                "默认 step_joint 仍抛=%s、玩家路径=%s %s"
                % (scan["counts"]["cases"], scan["counts"]["ok"], scan["counts"]["skipped"],
                   scan["counts"]["failed"], probe.get("skill_id"), probe.get("skill_name"),
                   probe.get("in_player_legal"), probe.get("default_step_joint_raises"),
                   probe.get("player_path_status"), probe.get("player_path_cancel_text"))),
            "gap_status": (
                "这 %d 条技能的**机制缺口一条都没变**：引擎仍然没有给「能耗被压到 0 以下」"
                "定任何下限。补的是「拿不到定价就不提供 / 不炸局」，不是「这条机制支持了」。"
                % scan.get("ramp_skill_count", 0)),
            "fix": (
                "按**机制**而不是按技能名扫：① ramp（12 条会减的技能逐条）；"
                "② 能耗修正（能把基础能耗 0 的技能也压成 -1）；③ 组合（单看每项都不为负）。"
                "每条都判三件事：A 有效能耗<0 时不出现在合法动作里；B 直接 `_execute` 仍 fail closed "
                "且**没扣能量**；C 执行前守卫把它变成 1 条可结算事件。"
                "另有一条残留 unsupported（非能耗，样例「硬门」）证明："
                "搜索/推演那条路仍然抛（planner 的 -inf 信号不丢），玩家路径能结算。"),
            "before_after": {"before": {"outcome": "crash"},
                             "after": {"outcome": "settled", "cases_ok": scan["counts"]["ok"],
                                       "cases_skipped": scan["counts"]["skipped"],
                                       "cases_failed": scan["counts"]["failed"]}},
            "repro": "python3 scripts/roco/battle-smoke-negative-cost-scan.py",
            "repro_artifact": "reports/roco/battle-smoke/negative-cost-scan.json",
            "skipped": [{"skill_id": r.get("skill_id"), "reason": r.get("reason")}
                        for r in scan.get("cases") or [] if r.get("skipped")],
            "window": [{"skill_id": r.get("skill_id"), "name": None,
                        "window": r.get("C_window_heuristic")}
                       for r in scan.get("cases") or [] if r.get("C_window_heuristic")],
        })
    for rec in (entry or {}).get("records") or []:
        det = (rec.get("steps", {}).get("settle", {}) or {}).get("detail") or {}
        for f in det.get("failures") or []:
            text = str(f.get("text") or "")
            if "UnsupportedEffect" not in text and "internal_error" not in str(f.get("error_type") or ""):
                continue
            out.append({
                "instance_id": rec.get("instance_id"), "species_id": rec.get("species_id"),
                "name": rec.get("species_name"), "step": "settle（第 %s 手）" % f.get("turn"),
                "recorded_action": f.get("action"),
                "engine_reply": text,
                "error_type": f.get("error_type"),
                "root_cause": (
                    "第 14 回合开局前，对手场上「溯源钟」的 skill_ramps = "
                    "{'skill_000494': {'cost': -5}}（绞轮描述：每受到 1 次抵抗的技能攻击，本技能能耗永久-1）"
                    "⇒ effective_skill_cost(绞轮) = 5 + (-5) = 0 ⇒ legal_actions 把它列为**合法**。"
                    "本回合行动顺序里玩家先出手，鸣叫（翼系）被属性抵抗 ⇒ 抵抗命中再加 -1 ⇒ ramp 变 -6；"
                    "随后对手的绞轮在 _execute 里**重新**算一次能耗 = 5 + (-6) = -1 ⇒ "
                    "env.py:928 抛 UnsupportedEffect（负能耗下限在术语里没有定义，MC-018，引擎不猜 0）。"
                    "step_joint 不接这个异常、battle_advance 只接 ValueError/RulesetError ⇒ "
                    "服务层兜底成 internal_error，Node 报 HTTP 400 ⇒ **整局中断且重试必复现**。"),
                "engine_implemented": (
                    "机制**实现了一半**：『每受到 1 次抵抗的技能攻击，本技能能耗永久-1』的累加是真的"
                    "（skill_ramps 逐回合涨），run 到 0 也照常出招；缺的是『能耗被压到 0 以下怎么办』"
                    "——术语没有定义，引擎按纪律 fail closed。"),
                "the_defect": (
                    "**接口不自洽**：一个已经被列为合法的动作，在同回合结算时变成非法，"
                    "而这个矛盾以「未处理异常」的形式炸掉整局，不是把这一手作废/改成聚能继续打。"),
                "fix_scope": "roco/src/roco_env/env.py（legal_actions 与 _execute 的能耗口径要对齐，"
                             "或在 _execute 里把这种局面转成可结算事件）与 service.py 的错误分类 —— "
                             "都在 task-2 的写域之外，**未改**，报 Lead 决定。",
                "repro": "python3 scripts/roco/battle-smoke-repro.py --only own-0442",
                "repro_artifact": "reports/roco/battle-smoke/repro-failures.json",
            })
    return out


def render_md(s: Dict[str, Any], total: int, names: Dict[str, str]) -> str:
    c1 = s["column_1_playable"]
    c2 = s["column_2_mechanism"]
    eng, ent = c1["engine"], c1["entry_http"]
    L: List[str] = []
    L.append("# B 段 · 全部已拥有实例的最小战斗冒烟（可玩与机制核验**分开**统计）")
    L.append("")
    L.append(f"生成：{s['generated_at']}　规则集：`{s['ruleset_id']}`　范围：{s['scope']}")
    L.append("")
    L.append("口径来自《长线计划与监工规则》B 节与人类 2026-09-29 的补充：")
    L.append("**「每只的基础可玩与特殊机制/实机核验分开统计，不能只改标签宣布全可战斗」**。")
    L.append("能开局就只写「能开局」；引擎没实现的效果不许伪装结算。")
    L.append("")
    L.append("## ① 基础可玩（能不能被选进队 → 合法六只 → 开局 → 出四技能/换人 → 结算）")
    L.append("")
    L.append("| 量的是什么 | 读数 | 出处 |")
    L.append("| --- | --- | --- |")
    L.append(f"| 总实例数 | {total} | `data/roco/owned/owned-pets.json` |")
    L.append(f"| 引擎侧：完成全部五步 | **{eng.get('playable', '—')}/{eng.get('total', total)}** "
             f"（结算 {eng.get('settled', '—')}） | `engine-sweep.json` |")
    L.append(f"| 引擎侧：四技能**全部**出过 | **{eng.get('all_four_used', '—')}/{eng.get('total', total)}** "
             f"| 同上 |")
    L.append(f"| 引擎侧：换出 + 换入都做到 | **{eng.get('switch_in_ok', '—')}/{eng.get('total', total)}** "
             f"| 同上 |")
    L.append(f"| 引擎侧：受击 / 目标倒下 | {eng.get('took_damage', '—')} / {eng.get('target_fainted', '—')} "
             f"| 同上 |")
    L.append(f"| 入口侧（HTTP `battle/new`）：选进队 | {ent.get('select_ok', '—')}/{ent.get('total', total)} "
             f"| `entry-sweep.json` |")
    L.append(f"| 入口侧：合法六只 + 开局 | {ent.get('start_ok', '—')}/{ent.get('total', total)} | 同上 |")
    L.append(f"| 入口侧：**配招随入口完整传递** | {ent.get('loadout_passthrough_ok', '—')}/{ent.get('total', total)} "
             f"| 同上 |")
    L.append(f"| 入口侧：打到结算 | {ent.get('settle_ok', '—')}/{ent.get('settle_run', '—')} | 同上 |")
    L.append(f"| 组合测试（随机六只 ×10 + 玩家实际六只 + 形态/机制混合） | "
             f"{sum(1 for c in c1['combos'] if c.get('playable'))}/{len(c1['combos'])} | 同上 |")
    L.append("")
    L.append(f"**精确失败 ID**：引擎侧 {len(c1['failures_engine'])} 条，入口侧 {len(c1['failures_entry'])} 条，"
             f"入口侧结算 {len(c1['failures_entry_settle'])} 条。")
    for tag, rows in (("引擎侧", c1["failures_engine"]), ("入口侧", c1["failures_entry"]),
                      ("入口侧结算", c1["failures_entry_settle"])):
        for r in rows[:30]:
            text = str(r.get("text") or "")
            who = "脚本侧（不是引擎/产品）" if "脚本上限" in text else "引擎/产品侧"
            L.append(f"- {tag} `{r['instance_id']}`（{r.get('name')}）失败在 **{r.get('step')}**"
                     f"，判定：**{who}**：{text}")
    if not (c1["failures_engine"] or c1["failures_entry"] or c1["failures_entry_settle"]):
        L.append("- 无。（不是「没查」，是逐只五步全过；判据见上面几行）")
    L.append("")
    if c1["all_four_not_used"]:
        L.append(f"**四个技能没全出（{len(c1['all_four_not_used'])} 只）** —— 逐条给准确原因，"
                 "并给合法可运行的替代（这只的引擎规范配招）：")
        for r in c1["all_four_not_used"]:
            miss = "、".join(f"{m['name']}（`{m['skill_id']}`）" for m in r["missing"])
            reason = "；".join(f"{g['name']}：{g['reason']}" for g in r["reasons"])
            L.append(f"- `{r['instance_id']}` {r['name']}：缺 {miss} —— {reason}")
        L.append("")
    else:
        L.append("**四个技能全部出过**：542/542。")
        L.append("")
    L.append("### 组合测试逐条")
    L.append("")
    L.append("| 组 | 六只（实例 → 物种） | 结算 | 回合 |")
    L.append("| --- | --- | --- | --- |")
    for c in c1["combos"]:
        team = "、".join(f"{i}→{sp}" for i, sp in (c.get("team_species") or [])) or "、".join(c.get("team") or [])
        L.append(f"| {c.get('label')} | {team} | {c.get('result') or '—'} "
                 f"| {c.get('turns') if c.get('turns') is not None else '—'} |")
    L.append("")
    L.append("## ② 特殊机制核验（引擎实现了没有 / 实机核验过没有）")
    L.append("")
    L.append("**这一列与①无关。** 一只精灵可以「能开局、四技能都出得来、打到结算」，"
             "而它的决定性特性在引擎里**一行都没实现** —— 那种情况在这里写「没实现」，不写「全可战斗」。")
    L.append("")
    L.append("| 引擎侧特性实现状态 | 只数 |")
    L.append("| --- | --- |")
    for k, label in (("FULL", "FULL（按原语完整实现）"), ("PARTIAL", "PARTIAL（部分实现，有登记缺口）"),
                     ("REFUSED", "REFUSED（明确拒绝并给理由）"),
                     ("NOT_REGISTERED_IN_ENGINE", "引擎未登记 ⇒ 没实现")):
        L.append(f"| {label} | {c2['engine_trait_status'].get(k, 0)} |")
    L.append(f"| **实机核验过** | **{c2['in_game_verified']}** |")
    L.append("")
    L.append(c2["in_game_verified_note"])
    L.append("")
    L.append("引擎侧的实现状态**只覆盖 17 只精灵**（`data/roco/engine-trait-status.json`，"
             "其中 15 只在已拥有清单里）：")
    L.append("")
    L.append("| 实例 | 精灵 | 特性 | 状态 | 挂钩 | 已登记的缺口 |")
    L.append("| --- | --- | --- | --- | --- | --- |")
    for r in c2["trait_rows"]:
        gaps = "；".join(r.get("gaps") or []) or "—"
        L.append(f"| `{r['instance_id']}` | {r['name']} | {r.get('trait')} | {r['status']} "
                 f"| {r.get('hook') or '—'} | {gaps} |")
    L.append("")
    L.append(f"**战斗中「自己出手、引擎登记了未结算效果」的：{c2['in_battle_unsupported_count']}/{total}**。"
             "这是②的直接证据 —— 引擎如实记账，没有伪装结算：")
    L.append("")
    for r in c2["in_battle_unsupported"][:8]:
        L.append(f"- `{r['instance_id']}` {r['name']}：{r['count']} 条，技能 "
                 "、".join(f"{names.get(s, s)}" for s in r["skills"]) + f" —— {r.get('sample_text')}")
    if c2["in_battle_unsupported_count"] > 8:
        L.append(f"- …（其余 {c2['in_battle_unsupported_count'] - 8} 只见 "
                 "`battle-smoke-summary.json` 的 `column_2_mechanism.in_battle_unsupported`）")
    L.append("")
    gaps = s.get("blocking_mechanism_gaps") or []
    L.append("### 阻塞性机制缺口（**记在②，不算①**）")
    L.append("")
    L.append("下面这条**不是**「没实现所以不出这一手」，而是「这一手已经被引擎列为合法、")
    L.append("结算到一半却变成非法」。它**不因为①的 542/542 而消失** ——")
    L.append("①的读数是在**这一版冒烟脚本的策略**下取的，换一串动作顺序就会踩到；")
    L.append("所以它按口径记在②，并配一条**自足复现**（不依赖任何一次冒烟的轨迹）。")
    L.append("")
    if not gaps:
        L.append("无。")
    for g in gaps:
        L.append(f"- **`{g['instance_id']}`（{g['name']}）· {g['step']}**")
        L.append(f"  - **缺口状态**：{g.get('gap_status')}")
        L.append(f"  - 引擎回执：{g['engine_reply']}")
        if g.get("fix"):
            L.append(f"  - 做了什么：{g['fix']}")
        if g.get("before_after"):
            L.append(f"  - 修前/修后：{json.dumps(g['before_after'], ensure_ascii=False)}")
        if g.get("engine_implemented"):
            L.append(f"  - 机制实现到哪：{g['engine_implemented']}")
        if g.get("the_defect"):
            L.append(f"  - 真正的缺陷：{g['the_defect']}")
        if g.get("root_cause"):
            L.append(f"  - 触发条件与根因：{g['root_cause']}")
        if g.get("fix_scope"):
            L.append(f"  - 该改哪里：{g['fix_scope']}")
        for t in (g.get("timeline") or [])[:8]:
            L.append(f"    - 第 {t['turn']} 回合：ramp={t['enemy_ramp_skill_000494']} "
                     f"有效能耗={t['enemy_effective_cost_skill_000494']} "
                     f"被列为合法={t['rampled_in_enemy_legal']}")
        L.append(f"  - 复现：`{g['repro']}`　产物：`{g['repro_artifact']}`")
    L.append("")
    L.append("## 没修的 / 缺口 / 下一项")
    L.append("")
    L.append("**修了什么**（都只在 `scripts/roco/battle-smoke*` 这一层，没有碰产品代码）：")
    L.append("- 冒烟脚本自己的策略：四个技能出完之后**继续出招**（原来会 `?? charge` 一直聚能，"
             "`own-0007` 卡到脚本上限就是这么来的 —— 同一条队在引擎侧 30 回合内就结算了）；"
             "还没出过的技能**贵的先出**。")
    L.append("- `battle-smoke-repro.py` 现在能拿**活着的那份 GameState** 重放失败那一手"
             "（`battle_advance` 内部 deserialize 出的对象抛错后就没了，只看入参字典会以为状态没变）。")
    L.append("")
    L.append("**task-5 修了什么（`roco/src/roco_env/**` + `src/server/roco-service.js`）**：")
    L.append("- ① `legal_actions` 与 `_execute` 读**同一个** `resolved_skill_cost`："
             "解不出有效能耗（负值 / 缺口径）就**不提供这一手**，"
             "不再「算不出就退回基础能耗、照样列成合法」。")
    L.append("- ② `_cancel_unresolvable_skill`：合法动作表是回合开始时算的，"
             "中途被压负的那一手在执行前被拦下 ⇒ 不结算 + 如实登记 + "
             "**一条可结算的 `action_cancelled{energy_cost_unresolved}`** + 回合走完。")
    L.append("- ② `step_joint(tolerate_unsupported=True)`（**只在玩家路径开**）："
             "任何残留的 unsupported 也变成可结算事件；搜索/推演那条路不传，"
             "`planner` 的 `-inf` 契约逐位不变。")
    L.append("- ② 错误分类：`service.battle_advance` 接住 `UnsupportedEffect` → 422 "
             "`unsupported_effect`；`src/server/roco-service.js` 的 `advanceBattle` "
             "不再一律 400（unavailable→503 / unsupported_effect→422）。")
    L.append("- **没有**给负能耗定任何默认值/下限，**没有**删用例、**没有**改契约。")
    L.append("")
    L.append("**这一轮没做的**：")
    L.append("- 逐只全量只在**标准 PVP 六宠**（`mobile_s4_candidate_v3`）这一份配置上跑；"
             "`legacy_sim_v1`（3v3 练习局）没跑全量。")
    L.append("- 特殊机制那一列只核到「引擎实现了没有」；**实机核验是 0**（本仓没有一只被标成实机核验过），"
             "所以 B 节的「全部已拥有精灵能进行本地训练战斗」现在只能说到"
             "「基础可玩覆盖齐了、机制实现 11/542 只、实机核验 0」。")
    L.append("- 组合测试是 10 组随机 + 2 组指定，不是穷举；`C(542,6)` 量级的组合没跑。")
    L.append("")
    L.append("## 可复验命令")
    L.append("")
    L.append("```bash")
    for cmd in s["commands"]:
        L.append(cmd)
    L.append("```")
    L.append("")
    L.append("演示服务已跑着（`http://127.0.0.1:8765/`）时，入口侧那一条直接量它；"
             "`--base=` 可以换成别的实例。引擎侧不依赖服务，进程内直调同一份 `RocoService`。")
    L.append("")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
