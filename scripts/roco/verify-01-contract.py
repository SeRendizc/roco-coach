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

import argparse
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-preview", action="store_true",
                    help="不请求开局预览（默认请求，因为预览事件只在显式请求时产生）")
    args = ap.parse_args()
    rs = D.load_ruleset()
    svc = S.RocoService()
    cand = list(rs.candidate_movesets)
    team, foe = cand[0:6], cand[6:12]
    body = {"ruleset_id": getattr(rs, "ruleset_id", None), "state_version": 0,
            "team": team, "enemy_team": foe, "seed": 11,
            "strategy": "greedy_damage", "ruleset_config_id": "mobile_s4_candidate_v3"}
    if not args.no_preview:
        body["opening_preview"] = True
    status, env = svc.battle_new(body)
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

    # C5 事件序号：**契约里的 `event_seq` 是每个事件行上的 `seq`**（信封行），顶层没有这个键。
    # ⚠ 本探针第一版把期望写成「事件里要有 `event_seq` 键 / 回执要有顶层 `event_seq`」——
    #   那是**探针期望写错**（Lead 2026-09-30 裁定，我复核后同意）：
    #   `state.events` 是引擎内部事实（不带序号），`_sim_envelope` 给**每一行**加 `seq`。
    rows = res.get("events") or []
    seqs = [r.get("seq") for r in rows]
    if not rows:
        # 本跳没有新增事件（例如 battle_new 只有预览那一条，它落在 state.events 里）
        print(f"C5 envelope_rows=0（本跳无新增事件行；state.events 有 {len(events or [])} 条）")
    elif any(s is None for s in seqs):
        absent.append("envelope row seq")
    else:
        n_state = len(events or [])
        expect = list(range(n_state - len(rows), n_state))
        print(f"C5 envelope seqs={seqs} expect={expect} state_events={n_state}")
        if seqs != expect:
            fails.append(f"事件行 seq 与 state.events 下标不符：{seqs} != {expect}")

    # C6 opening_roster_revealed：`state.events` 与回执 **`result.opening_reveal`** 同源。
    # ⚠ 第二版修正（Lead 裁定后我复核同意）：回执那一份在 `result.opening_reveal`，
    #   **不在** `result.events` —— `battle_new` 一跳没有「新增事件行」，`result.events` 是空数组。
    receipt_prev = res.get("opening_reveal")
    kinds_receipt = [e.get("kind") for e in (res.get("events") or []) if isinstance(e, dict)]
    if isinstance(receipt_prev, dict):
        kinds_receipt = kinds_receipt + [receipt_prev.get("kind")]
    kinds_state = [e.get("kind") for e in (events or []) if isinstance(e, dict)]
    has_preview = ("opening_roster_revealed" in kinds_receipt
                   or "opening_roster_revealed" in kinds_state)
    print(f"C6 kinds receipt={kinds_receipt} state={kinds_state} "
          f"receipt_opening_reveal={'present' if isinstance(receipt_prev, dict) else 'absent'}")
    if not has_preview:
        absent.append("opening_roster_revealed（本次未请求）")
    else:
        prev_state = [e for e in (events or [])
                      if isinstance(e, dict) and e.get("kind") == "opening_roster_revealed"]
        row_prev = [e for e in (res.get("events") or [])
                    if isinstance(e, dict) and e.get("kind") == "opening_roster_revealed"]
        se = (row_prev or prev_state or [None])[0]
        re_ = receipt_prev if isinstance(receipt_prev, dict) else (row_prev[0] if row_prev else None)
        if se is None or re_ is None:
            fails.append(f"预览事件未两处齐备：state={len(prev_state)} receipt={re_ is not None}")
        else:
            core = lambda d: json.dumps({k: d.get(k) for k in ("kind", "turn", "detail")},  # noqa: E731
                                        ensure_ascii=False, sort_keys=True)
            extra = sorted(set(re_) - set(se))
            print(f"C6 same_source(kind/turn/detail)={core(se) == core(re_)} "
                  f"receipt_extra_keys={extra}")
            if core(se) != core(re_):
                fails.append("预览事件与回执那一份的实质载荷不同（不是同源）")
            if set(extra) - {"seq", "text"}:
                fails.append(f"回执预览多出非信封键：{sorted(set(extra) - {'seq', 'text'})}")
            detail = se.get("detail")
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

    print(f"ABSENT/NOT-REQUESTED（按设计不出现或本次未请求）{absent}")
    print(f"CONTRACT_FAILS {len(fails)}")
    for f in fails:
        print(f"  FAIL {f}")
    return 0 if not fails else 3


if __name__ == "__main__":
    raise SystemExit(main())
