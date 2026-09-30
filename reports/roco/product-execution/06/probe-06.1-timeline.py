"""06.1 只读探针（task-14 勘察）：真实六宠对局里「当时信息」的时间线。

三件事（全部走**真服务入口** `RocoService.battle_advance`）：

  1. 一次决策点上「当时信息」留下了什么：逐 step 记 `decision_id` / `state_version` /
     `turn` / `phase` / 本 step 的 `legal` / 本次推进产生的事件；
     并从私有 `state.history` 记下**行的键**、`pre_observation_hash`，核对
     `decision_id = <match_id>:v{history.state_version − len(history.events)}` 这条推导。
  2. 「按回合号攒合法表」会不会被同一回合的后一段覆盖：`turn` 在 battle → replace → battle
     里重复，而客户端是 `legalByTurn = {...legalByTurn, [turn]: legal}`（`src/client/roco.js:4220`）＝后写覆盖。
  3. 「固定当时信息、只改以后发生的事」能不能真造出来：
     (a) 同队同 seed、只把**补位那一手**换成另一只 ⇒ 前缀逐位相同、之后分叉（可用于必做反例）；
     (b) 只把**对手后备（阵容）**换掉 ⇒ 反证：开局预览把这批人**亮明**了，所以这不算「隐藏配置」。

产出 `raw-06.1-timeline.json`（**已剔除私有 `state`**；Node 侧 `publicView()` 认的形状）。
用法（WSL）：bash /mnt/e/roco-scratch/plan06/run-probe-timeline.sh
"""
from __future__ import annotations

import json
import os
import sys
import traceback

ROOT = "/mnt/e/roco-coach"
OUT_DIR = os.path.join(ROOT, "reports", "roco", "product-execution", "06")
OUT = os.path.join(OUT_DIR, "raw-06.1-timeline.json")
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env.service import RocoService      # noqa: E402

RS = rdata.load_ruleset()
CFG = "mobile_s4_candidate_v3"
SIX = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花", "迪莫", "水灵", "火神")]
SIX_B = [RS.pets_by_name(n)[0].pet_id for n in ("魔力猫", "草头鸭", "恶魔叮", "恶魔狼", "鸭吉吉", "铠甲虫")]
_C_POOL = [pid for pid in sorted(RS.pets) if pid not in set(SIX_B) and pid not in set(SIX)]
SIX_C = [SIX_B[0]] + _C_POOL[:5]          # 第 1 只相同、后备全换（用于反证 (b)）
MAX_STEPS = 40


def legal_rows(raw):
    rows = (raw.get("legal") or {}).get("player") or []
    return [{k: a.get(k) for k in ("kind", "label", "skill_id", "skill_name", "item_id", "target_index")
             if a.get(k) is not None} for a in rows if isinstance(a, dict)]


def pick_first_skill(rows):
    skills = [a for a in rows if a.get("kind") == "skill"]
    pick = (skills or rows or [None])[0]
    return None if pick is None else {k: v for k, v in pick.items() if k != "skill"}


def view_slice(receipt):
    """Node `publicView()` 认的形状（私有 state 剔除；`events` 另存于 step，避免重复占体积）。"""
    keep = ("state_version", "phase", "turn", "result", "match_id", "rules_version", "decision_id",
            "public", "ui", "legal", "needs_replacement")
    return {k: receipt.get(k) for k in keep if k in receipt}


def run_match(svc, seed, *, enemy_team=None, diverge=None, max_steps=MAX_STEPS):
    """真服务跑一局。diverge = (phase, turn, picker)：只在那一 step 换一手（全局限一次）。"""
    team_b = enemy_team or SIX_B
    status, env0 = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": SIX, "enemy_team": team_b,
                                   "seed": seed, "state_version": 0, "opening_preview": True,
                                   "ruleset_config_id": CFG})
    out = {"seed": seed, "enemy_team": list(team_b), "new_status": status, "steps": [],
           "history_hashes": [], "error": None}
    if status != 200:
        out["error"] = env0
        return out
    receipt = env0["result"]
    diverged = False
    for i in range(max_steps):
        before = receipt
        turn, phase = before.get("turn"), before.get("phase")
        rows = legal_rows(before)
        action = pick_first_skill(rows)
        note = None
        if (not diverged) and diverge and phase == diverge[0] and turn == diverge[1]:
            alt = diverge[2](rows)
            if alt is not None and alt != action:
                action, diverged, note = alt, True, "diverged-here"
        step = {"i": i, "turn": turn, "phase": phase, "state_version": before.get("state_version"),
                "decision_id": before.get("decision_id"), "legal_n": len(rows), "action": action,
                "note": note, "has_result": bool(before.get("result")),
                "view_before": view_slice(before), "view_after": None, "events": []}
        if action is None or before.get("result"):
            step["view_after"] = view_slice(before)
            out["steps"].append(step)
            out["finished"] = bool(before.get("result"))
            break
        status, env = svc.battle_advance({"state": before["state"],
                                          "state_version": before.get("state_version"),
                                          "action": action})
        if status != 200:
            step["error"] = {"status": status, "error": (env or {}).get("error"),
                             "error_type": (env or {}).get("error_type")}
            step["view_after"] = step["view_before"]
            out["steps"].append(step)
            break
        receipt = env["result"]
        step["view_after"] = view_slice(receipt)
        step["events"] = receipt.get("events") or []
        row = (receipt.get("state") or {}).get("history") or []
        if row:
            last = row[-1]
            out["history_hashes"].append({
                "turn": last.get("turn"), "pre_observation_hash": last.get("pre_observation_hash"),
                "state_version": last.get("state_version"), "events_n": len(last.get("events") or []),
                "player_action": last.get("player_action")})
            out["history_row_keys"] = sorted(last.keys())
        out["steps"].append(step)
    else:
        out["finished"] = False
    out["private_serialize_keys"] = sorted((receipt.get("state") or {}).keys())
    return out


def flatten_events(run):
    """整局事件 = 每个 step 那一次推进产生的事件（与前端 `state.matchEvents` 同一条拼接口径）。"""
    out = []
    for step in run.get("steps") or []:
        out.extend(step.get("events") or [])
    return out


def turn_collisions(run):
    out = {}
    by_turn = {}
    for step in run.get("steps") or []:
        rows = ((step.get("view_before") or {}).get("legal") or {}).get("player") or []
        by_turn.setdefault(str(step.get("turn")), []).append({
            "i": step.get("i"), "phase": step.get("phase"), "state_version": step.get("state_version"),
            "legal_n": len(rows), "legal_kinds": [r.get("kind") for r in rows],
            "legal_labels": [r.get("label") for r in rows]})
    for turn, rows in by_turn.items():
        if len(rows) > 1:
            out[turn] = rows
    return out


def derived_check(run):
    rows = []
    for step, hist in zip(run.get("steps") or [], run.get("history_hashes") or []):
        before = (hist["state_version"] - hist["events_n"]) if isinstance(hist.get("state_version"), int) else None
        rows.append({"turn": step.get("turn"), "decision_id_at_view": step.get("decision_id"),
                     "derived_version_before": before, "history_state_version": hist.get("state_version"),
                     "events_n": hist.get("events_n")})
    ok = [r for r in rows if r["decision_id_at_view"] and r["derived_version_before"] is not None
          and r["decision_id_at_view"].endswith(":v%d" % r["derived_version_before"])]
    return {"rows": rows, "derivable_matches": len(ok), "rows_n": len(rows)}


def common_prefix(a, b):
    ha = [r.get("pre_observation_hash") for r in a.get("history_hashes") or []]
    hb = [r.get("pre_observation_hash") for r in b.get("history_hashes") or []]
    n = 0
    for x, y in zip(ha, hb):
        if x != y:
            break
        n += 1
    ea = flatten_events(a)
    eb = flatten_events(b)
    key = lambda e: (e.get("seq"), e.get("turn"), e.get("kind"), json.dumps(e.get("detail"), sort_keys=True))
    m = 0
    for x, y in zip(ea, eb):
        if key(x) != key(y):
            break
        m += 1
    return {"equal_prefix_turns": n, "equal_prefix_events": m, "a_turns": len(ha), "b_turns": len(hb),
            "a_events": len(ea), "b_events": len(eb),
            "first_divergent_turn": (n + 1 if n < min(len(ha), len(hb)) else None)}


def trim_run(run):
    """把逐 step 的完整视图裁成「Node 侧真要用到的三份 + 每 step 的合法表」。

    为什么裁：完整 public/ui 每步都存，会让产物到 MB 量级（仓库既有 raw 产物都在 10–100 KB）。
    Node 探针要的只有：① 锚点决策（我方第一次倒地那一刻的**决策前**视图）、
    ② 最后一个还能行动的局面（前端 `lastLiveView` 的口径）、③ 终局视图；外加每 step 的合法表。
    """
    steps = []
    anchor = last_live = final = None
    for step in run.get("steps") or []:
        before = step.get("view_before") or {}
        after = step.get("view_after") or {}
        rows = ((before.get("legal") or {}).get("player")) or []
        if rows:
            last_live = before
        hit_faint = any(e.get("kind") == "faint" and (e.get("detail") or {}).get("side") == "player"
                        for e in (step.get("events") or []))
        if hit_faint and anchor is None:
            anchor = before
        final = after or final
        steps.append({"i": step.get("i"), "turn": step.get("turn"), "phase": step.get("phase"),
                      "state_version": step.get("state_version"), "decision_id": step.get("decision_id"),
                      "action": step.get("action"), "note": step.get("note"),
                      "has_result": step.get("has_result"), "error": step.get("error"),
                      "legal": rows, "events": step.get("events") or []})
    run["steps"] = steps
    run["views"] = {"anchor": anchor, "last_live": last_live, "final": final}
    return run


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    result = {"ruleset_id": RS.ruleset_id, "ruleset_config_id": CFG,
              "teams": {"player": SIX, "enemy_base": SIX_B, "enemy_alt": SIX_C},
              "runs": {}, "pairs": {}, "notes": []}
    svc = RocoService()
    try:
        base = run_match(svc, 5)
        result["runs"]["base"] = base
        result["runs"]["replace_diverged"] = run_match(
            svc, 5, diverge=("replace", 3, lambda rows: {k: v for k, v in (rows[-1] if rows else {}).items() if k != "skill"}))
        result["runs"]["hidden_bench_alt"] = run_match(svc, 5, enemy_team=SIX_C)
        for key in ("replace_diverged", "hidden_bench_alt"):
            result["pairs"]["base-vs-%s" % key] = common_prefix(base, result["runs"][key])
        result["turn_collisions_base"] = turn_collisions(base)
        result["derived_check_base"] = derived_check(base)
        faint_steps = [s for s in base["steps"]
                       if any(e.get("kind") == "faint" and (e.get("detail") or {}).get("side") == "player"
                              for e in (s.get("events") or []))]
        result["player_faint_step"] = ({"i": faint_steps[0]["i"], "turn": faint_steps[0]["turn"],
                                        "decision_id": faint_steps[0]["decision_id"]} if faint_steps else None)
        for key in result["runs"]:
            trim_run(result["runs"][key])
        bview = base["views"]["anchor"] or base["views"]["last_live"] or {}
        bench = ((bview.get("ui") or {}).get("opponent") or {}).get("bench") or []
        aview = (result["runs"]["hidden_bench_alt"]["views"]["anchor"]
                 or result["runs"]["hidden_bench_alt"]["views"]["last_live"] or {})
        alt_bench = ((aview.get("ui") or {}).get("opponent") or {}).get("bench") or []
        result["opening_preview_revealed"] = {
            "base_bench_n": len(bench), "base_bench_ids": [r.get("pet_id") for r in bench],
            "base_bench_revealed_via": [r.get("revealed_via") for r in bench],
            "alt_bench_ids": [r.get("pet_id") for r in alt_bench],
        }
        # 体积裁剪：对照局 (b) 的完整视图 Node 侧不用（它的证据已在 opening_preview_revealed 里）
        result["runs"]["hidden_bench_alt"]["views"] = None
    except Exception as exc:
        result["notes"].append("EXCEPTION: %s" % exc)
        result["traceback"] = traceback.format_exc()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print("OUT=%s bytes=%d" % (OUT, os.path.getsize(OUT)))
    for key, run in result["runs"].items():
        print("run %-17s status=%s steps=%d events=%d finished=%s" % (
            key, run.get("new_status"), len(run.get("steps") or []), len(flatten_events(run)), run.get("finished")))
    for key, row in result["pairs"].items():
        print("pair %-30s equal_prefix_turns=%s/%s equal_prefix_events=%s/%s" % (
            key, row["equal_prefix_turns"], row["a_turns"], row["equal_prefix_events"], row["a_events"]))
    for turn, rows in (result.get("turn_collisions_base") or {}).items():
        print("collision turn %s: %s" % (turn, [(r["phase"], r["legal_n"], r["legal_kinds"][:2]) for r in rows]))
    dc = result.get("derived_check_base") or {}
    print("decision_id derivable: %s/%s" % (dc.get("derivable_matches"), dc.get("rows_n")))
    print("history row keys:", base.get("history_row_keys"))
    print("private serialize keys:", base.get("private_serialize_keys"))
    print("player_faint_step:", result.get("player_faint_step"))
    print("opening preview:", json.dumps(result.get("opening_preview_revealed"), ensure_ascii=False)[:400])
    for note in result["notes"]:
        print("NOTE: %s" % note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
