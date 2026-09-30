#!/usr/bin/env python3
"""独立验收用的 **01 契约字段探针**（harness-verifier 自建）。

验 `plan01-engine` 这一批的契约字段与预览事件：
  C1 `match_id`：非空、形如 `m-<16 hex>`，且在 `result` / `result.public` / `ui` 三处**同值**；
  C2 `decision_id`：存在，且**可由 `match_id` + `state_version` 派生**（`<match_id>:v<sv>`）；
  C3 `rules_version`：非空，且同时含 ruleset_id 与 config_id；
  C4 `state_version == len(state.events)`（同一计数器，不另造）；
  C5 `event_seq`：若已实现 ⇒ 事件序号逐条等于其下标（或等于 state_version 链）；
  C6 `opening_roster_revealed`：**回执里拿得到 且 `state.events` 里有同源记录**；
     预览载荷里的对手技能 id **必须 0 个**（复用递归扫描；配 `skill_*` 扫描器的正控件）；
  C7 预览发生前 / 无预览模式：不得提前给出对手六只的身份。

未实现项按 `absent` 登记并**单独列出**（便于冻结时对照）；已实现但违反 ⇒ 硬失败。
用法: cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-01-contract.py
退出码: 0 = 无硬失败；3 = 有硬失败。
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import data as D  # noqa: E402
from roco_env import service as S  # noqa: E402

MATCH_RE = re.compile(r"^m-[0-9a-f]{16}$")


def collect_skill_ids(node, acc=None):
    acc = set() if acc is None else acc
    if isinstance(node, str):
        if node.startswith("skill_"):
            acc.add(node)
    elif isinstance(node, dict):
        for v in node.values():
            collect_skill_ids(v, acc)
    elif isinstance(node, (list, tuple, set)):
        for item in node:
            collect_skill_ids(item, acc)
    return acc


def collect_keys(node, acc=None):
    acc = set() if acc is None else acc
    if isinstance(node, dict):
        for k, v in node.items():
            acc.add(str(k))
            collect_keys(v, acc)
    elif isinstance(node, (list, tuple, set)):
        for item in node:
            collect_keys(item, acc)
    return acc


def main() -> int:
    rs = D.load_ruleset()
    svc = S.RocoService()
    cand = list(rs.candidate_movesets)
    team, foe = cand[0:6], cand[6:12]
    status, env = svc.battle_new({
        "ruleset_id": getattr(rs, "ruleset_id", None), "state_version": 0,
        "team": team, "enemy_team": foe, "seed": 11,
        "strategy": "greedy_damage", "ruleset_config_id": "mobile_s4_candidate_v3"})
    res = (env or {}).get("result") or {}
    pub = res.get("public") or {}
    ui = res.get("ui") or {}
    state = res.get("state") or {}
    events = state.get("events")
    fails, absent = [], []

    # 控件：扫描器活着（否则「0 泄漏」没意义）
    ctl = sorted(collect_skill_ids({"x": ["skill_900001"]}))
    print(f"CONTROL_SCANNER {ctl}")
    if ctl != ["skill_900001"]:
        fails.append("递归扫描器控件失败（连注入的合成 id 都扫不到）")

    print(f"HTTP {status} ok={(env or {}).get('ok')}")

    # C1 match_id
    mids = {k: v for k, v in (("result", res.get("match_id")),
                              ("public", pub.get("match_id")),
                              ("ui", ui.get("match_id"))) if v is not None}
    if not mids:
        absent.append("match_id")
    else:
        print(f"C1 match_id {json.dumps(mids, ensure_ascii=False)}")
        vals = set(mids.values())
        if len(vals) != 1:
            fails.append(f"match_id 多处不同值：{mids}")
        for where, v in mids.items():
            if not MATCH_RE.match(str(v)):
                fails.append(f"match_id 形状不符（{where}={v!r}）")

    # C2 decision_id 可由 match_id + state_version 派生
    sv = res.get("state_version")
    did = res.get("decision_id")
    print(f"C2 decision_id={did!r} state_version={sv!r} "
          f"derived={res.get('match_id')!r}:v{sv}")
    if did is None:
        absent.append("decision_id")
    elif res.get("match_id") and sv is not None:
        if str(did) != f"{res['match_id']}:v{sv}":
            fails.append(f"decision_id 与 match_id+state_version 不一致：{did} != {res['match_id']}:v{sv}")
    if pub.get("decision_id") != did:
        fails.append(f"decision_id 未进公开面：public={pub.get('decision_id')!r} result={did!r}")

    # C3 rules_version
    rv = res.get("rules_version")
    print(f"C3 rules_version={rv!r} (ruleset_id={getattr(rs, 'ruleset_id', None)!r})")
    if not rv:
        absent.append("rules_version")
    else:
        if getattr(rs, "ruleset_id", None) and str(rs.ruleset_id) not in str(rv):
            fails.append(f"rules_version 不含 ruleset_id：{rv}")
        if "mobile_s4_candidate_v3" not in str(rv):
            fails.append(f"rules_version 不含 config_id：{rv}")

    # C4 state_version == len(state.events)
    print(f"C4 state_version={sv!r} len(state.events)={len(events) if isinstance(events, list) else None}")
    if isinstance(events, list) and sv is not None and int(sv) != len(events):
        fails.append(f"state_version({sv}) != len(state.events)({len(events)})")

    # C5 event_seq
    seqs = [e.get("event_seq") for e in events] if isinstance(events, list) else []
    if not any(s is not None for s in seqs):
        absent.append("event_seq")
    else:
        print(f"C5 event_seq={seqs}")
        if seqs != list(range(len(seqs))):
            # 允许「序号是 state_version 链」的等价口径：必须严格递增且首尾与 state_version 自洽
            fails.append(f"event_seq 不是 0..n-1 连续：{seqs}")

    # C6 opening_roster_revealed：回执 + state.events 同源；预览载荷不得含四技能/隐藏个体
    kinds_receipt = [e.get("kind") for e in (res.get("events") or []) if isinstance(e, dict)]
    kinds_state = [e.get("kind") for e in (events or []) if isinstance(e, dict)]
    has_preview = "opening_roster_revealed" in kinds_receipt or "opening_roster_revealed" in kinds_state
    print(f"C6 kinds receipt={kinds_receipt} state={kinds_state}")
    if not has_preview:
        absent.append("opening_roster_revealed")
    else:
        prev_receipt = [e for e in (res.get("events") or [])
                        if isinstance(e, dict) and e.get("kind") == "opening_roster_revealed"]
        prev_state = [e for e in (events or [])
                      if isinstance(e, dict) and e.get("kind") == "opening_roster_revealed"]
        if not prev_receipt or not prev_state:
            fails.append(f"预览事件未两处同源：receipt={len(prev_receipt)} state={len(prev_state)}")
        else:
            a = json.dumps(prev_receipt[0].get("detail"), ensure_ascii=False, sort_keys=True)
            b = json.dumps(prev_state[0].get("detail"), ensure_ascii=False, sort_keys=True)
            print(f"C6 same_source {a == b}")
            if a != b:
                fails.append("预览事件在回执与 state.events 里载荷不同（不是同源）")
            detail = prev_receipt[0].get("detail")
            # 预览只该展示「阵容」：出现任何 skill_* / 隐藏个体字段都算越界
            leaked_skills = sorted(collect_skill_ids(detail))
            forbidden = sorted(collect_keys(detail) & {"seed", "individuals", "talent",
                                                       "nature", "loadout", "skills", "ivs"})
            print(f"C6 preview_skill_ids={leaked_skills} forbidden_keys={forbidden}")
            if leaked_skills:
                fails.append(f"预览载荷里出现技能 id（四招是隐藏信息）：{leaked_skills[:6]}")
            if forbidden:
                fails.append(f"预览载荷里出现隐藏个体/配招字段：{forbidden}")

    # C7 无预览事件时，公开面不得给出对手后备身份（有预览时给身份是**预期**行为，只登记）
    bench = (pub.get("opponent") or {}).get("bench") or []
    bad_bench = [b for b in bench if any(k in b for k in ("pet_id", "name", "skills"))]
    print(f"C7 preview_emitted={has_preview} bench_identity_free={not bad_bench} "
          f"bench_keys={sorted(bench[0].keys()) if bench else None}")
    if not has_preview and bad_bench:
        fails.append(f"未发预览事件却已给后备身份：{bad_bench[:2]}")

    print(f"ABSENT（尚未实现，冻结时对照）{absent}")
    print(f"CONTRACT_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
