#!/usr/bin/env python3
"""独立验收用的 **台账逐行对照工具**（harness-verifier 自建，task-4 第 2 阶段）。

目的：把「当前 `coverage.build_coverage()` 台账」与仓库里那份 306 钉
（`reports/roco/rc401/effect-coverage.json`，交接文档点名的**真基线**）逐行对照，
产出「多 / 少 / 档位变更（翻正、翻负、同带内变更）」，每一行都带 `why`。

**自带控件**（`--selftest`）——没有控件的 diff 工具就是空判据：
  1. 同一份报告自比 ⇒ 必须 0 差异（防误报）；
  2. 人为把一行 `SIMULATABLE* → PARTIAL` ⇒ 必须报「翻负」且只报那一行；
  3. 人为把一行 `PARTIAL → SIMULATABLE_UNVERIFIED` ⇒ 必须报「翻正」且只报那一行；
  4. 人为删掉一个实体 ⇒ 必须报「仅基线有」；
  5. 人为加一个合成实体 ⇒ 必须报「仅当前有」；
  6. 人为把 `PARTIAL → KNOWLEDGE_ONLY` ⇒ 必须报「同带内档位变更」。
任一条不成立 ⇒ 退出码 5，且**本次对照读数作废**。

用法:
    cd /mnt/e/roco-coach && PYTHONPATH=roco/src python3 scripts/roco/verify-totals-delta.py --limit 40
    … --selftest            # 只跑控件
    … --repo <隔离副本根>    # 对照隔离副本的 src（基线文件仍在真仓库里找）
    … --json <path>         # 落一份机器可读的逐行结果
退出码: 0 正常；5 控件失败；2 用法错误。
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys

BASELINE_REL = "reports/roco/rc401/effect-coverage.json"
SIM = ("SIMULATABLE_UNVERIFIED", "FULL_VERIFIED")
KINDS = ("skills", "traits")


def file_sha(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def diff_kind(b: dict, c: dict) -> dict:
    """逐实体对照一个 kind（skills / traits）。"""
    out = {"only_base": sorted(set(b) - set(c)), "only_cur": sorted(set(c) - set(b)),
           "up": [], "down": [], "band_change": []}
    for eid in sorted(set(b) & set(c)):
        bs, cs = b[eid].get("support"), c[eid].get("support")
        if bs == cs:
            continue
        row = [eid, bs, cs, c[eid].get("why")]
        if cs in SIM and bs not in SIM:
            out["up"].append(row)
        elif bs in SIM and cs not in SIM:
            out["down"].append(row)
        else:
            out["band_change"].append(row)
    return out


def diff_reports(base: dict, cur: dict) -> dict:
    res = {kind: diff_kind(base.get(kind) or {}, cur.get(kind) or {}) for kind in KINDS}
    res["_totals"] = {"baseline": (base.get("totals") or {}).get("simulatable_entities"),
                      "current": (cur.get("totals") or {}).get("simulatable_entities")}
    return res


def net(d: dict) -> int:
    return sum(len(d[k]["up"]) - len(d[k]["down"]) for k in KINDS)


def selftest(base: dict, cur: dict) -> int:
    """控件：证明这把尺子**能**报出每一类变化。"""
    ok = True
    sim_row = next((k, eid) for k in KINDS for eid, v in (cur.get(k) or {}).items()
                   if v.get("support") in SIM)
    non_row = next((k, eid) for k in KINDS for eid, v in (cur.get(k) or {}).items()
                   if v.get("support") not in SIM)

    # 1 自比必须 0
    d = diff_reports(cur, copy.deepcopy(cur))
    c1 = net(d) == 0 and not any(d[k]["only_base"] or d[k]["only_cur"] for k in KINDS)
    print(f"CONTROL identity_zero_diff {'PASS' if c1 else 'FAIL'} net={net(d)}")
    ok &= c1

    # 2 人为 SIM -> PARTIAL ⇒ 翻负且只有那一行
    k, eid = sim_row
    m = copy.deepcopy(cur)
    m[k][eid] = dict(m[k][eid], support="PARTIAL", why="[selftest] 人为降档")
    d = diff_reports(cur, m)
    c2 = [r[0] for r in d[k]["down"]] == [eid] and len(d[k]["up"]) == 0
    print(f"CONTROL detect_down {'PASS' if c2 else 'FAIL'} {eid} down={[r[0] for r in d[k]['down']]}")
    ok &= c2

    # 3 人为 PARTIAL -> SIM ⇒ 翻正且只有那一行
    k2, eid2 = non_row
    m = copy.deepcopy(cur)
    m[k2][eid2] = dict(m[k2][eid2], support="SIMULATABLE_UNVERIFIED", why="[selftest] 人为升档")
    d = diff_reports(cur, m)
    c3 = [r[0] for r in d[k2]["up"]] == [eid2] and len(d[k2]["down"]) == 0
    print(f"CONTROL detect_up {'PASS' if c3 else 'FAIL'} {eid2} up={[r[0] for r in d[k2]['up']]}")
    ok &= c3

    # 4 删一个实体 ⇒ 仅基线有
    k3, eid3 = sim_row
    m = copy.deepcopy(cur)
    del m[k3][eid3]
    d = diff_reports(cur, m)
    c4 = d[k3]["only_base"] == [eid3] and not d[k3]["only_cur"]
    print(f"CONTROL detect_missing_entity {'PASS' if c4 else 'FAIL'} {eid3}")
    ok &= c4

    # 5 加一个合成实体 ⇒ 仅当前有
    m = copy.deepcopy(cur)
    m["skills"]["skill_999999"] = {"support": "PARTIAL", "why": "[selftest] 合成"}
    d = diff_reports(cur, m)
    c5 = d["skills"]["only_cur"] == ["skill_999999"]
    print(f"CONTROL detect_extra_entity {'PASS' if c5 else 'FAIL'}")
    ok &= c5

    # 6 同带内档位变更（PARTIAL -> KNOWLEDGE_ONLY）⇒ 必须单独报出来，不许静默
    k4, eid4 = non_row
    m = copy.deepcopy(cur)
    m[k4][eid4] = dict(m[k4][eid4], support="KNOWLEDGE_ONLY", why="[selftest] 同带内变更")
    d = diff_reports(cur, m)
    c6 = any(r[0] == eid4 for r in d[k4]["band_change"])
    print(f"CONTROL detect_band_change {'PASS' if c6 else 'FAIL'} {eid4} "
          f"band={[r[0] for r in d[k4]['band_change']]}")
    ok &= c6

    print(f"CONTROL_SUMMARY {'ALL_PASS' if ok else 'HAS_FAIL'}")
    return 0 if ok else 5


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--repo", default=None, help="放 src 的仓库根（默认脚本所在仓库）")
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--json", dest="json_path", default=None)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    script_repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    repo = os.path.abspath(args.repo) if args.repo else script_repo
    baseline_path = os.path.abspath(args.baseline) if args.baseline else \
        os.path.join(script_repo, BASELINE_REL)
    sys.path.insert(0, os.path.join(repo, "roco", "src"))
    from roco_env import coverage as C  # noqa: E402
    from roco_env import data as D  # noqa: E402
    from roco_env import service as S  # noqa: E402

    with open(baseline_path, encoding="utf-8") as fh:
        base = json.load(fh)
    cur = C.build_coverage(D.load_ruleset())

    for mod in (C, S, D):
        path = getattr(mod, "__file__", None)
        print(f"STAMP {os.path.basename(path or '?'):14s} {file_sha(path)} {path}")

    if args.selftest:
        return selftest(base, cur)

    d = diff_reports(base, cur)
    print(f"REPO {repo}")
    print(f"BASELINE {baseline_path}")
    print(f"TOTALS baseline_simulatable={d['_totals']['baseline']} "
          f"current_simulatable={d['_totals']['current']} "
          f"delta={net(d)} (up-down)")
    print(f"SUPPORT_LEVELS baseline={json.dumps(base.get('support_levels'), ensure_ascii=False)}")
    print(f"SUPPORT_LEVELS current ={json.dumps(cur.get('support_levels'), ensure_ascii=False)}")
    print(f"CONTROL_RUN {'included' if not args.quiet else 'skipped'}")
    for kind in KINDS:
        r = d[kind]
        print(f"\n== {kind} == only_base={len(r['only_base'])} only_cur={len(r['only_cur'])} "
              f"翻正={len(r['up'])} 翻负={len(r['down'])} 同带内变更={len(r['band_change'])}")
        for label, rows in (("翻正", r["up"]), ("翻负", r["down"]), ("同带内变更", r["band_change"])):
            for eid, bs, cs, why in rows[:args.limit]:
                print(f"   {label} {eid} {bs} -> {cs} | {why}")
        for eid in r["only_base"][:args.limit]:
            print(f"   仅基线有 {eid} | {json.dumps((base.get(kind) or {}).get(eid), ensure_ascii=False)[:160]}")
        for eid in r["only_cur"][:args.limit]:
            print(f"   仅当前有 {eid} | {json.dumps((cur.get(kind) or {}).get(eid), ensure_ascii=False)[:160]}")
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump({"baseline": baseline_path, "repo": repo,
                       "stamp": {m: file_sha(getattr(mod, "__file__", None))
                                 for m, mod in (("coverage.py", C), ("service.py", S), ("data.py", D))},
                       "diff": d}, fh, ensure_ascii=False, indent=2, sort_keys=True)
        print(f"\nWROTE {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
