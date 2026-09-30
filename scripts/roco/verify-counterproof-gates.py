#!/usr/bin/env python3
"""独立验收用的 **反证闸复现探针**（harness-verifier 自建，刻意不复用实现者脚本）。

背景：判据 `roco/tests/test_tier_verdict_agreement.py:83`
`test_counter_proof_disabling_the_shared_gates_brings_them_back` 要求「关掉
`respond_clause_gaps` 与 `UNSETTLED_WORDS` 后，427 并集的两把尺子重新打架 **≥8**」。
交接文档（另一台电脑）记的是回来 **6** 条；本机稳定读到 **5**。本探针独立复跑，
并额外回答两件事：
  ① **控件（证明这次 monkeypatch 不是空转）**：关闸后有多少条技能的 `resolved`
     真的翻正 —— 若为 0，说明补丁无效，本次测量**作废**（这正是 01 的假绿前车之鉴）。
  ② **被别的闸兜住的有哪些**：对每条候选，列出关闸后仍在报缺口的**非禁用闸**
     （残余 span / 诊断形状 / 复合子句 / 无结算分支 kind / parsed.unparsed）。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-counterproof-gates.py --once
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-counterproof-gates.py --sweep
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-counterproof-gates.py --components
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import service as S  # noqa: E402

CENSUS_CANDIDATES = (
    os.path.join("tests", "data", "pets100-skills-census.json"),
    os.path.join("roco", "tests", "data", "pets100-skills-census.json"),
)
SIM = (C.SUPPORT_SIMULATABLE_UNVERIFIED, C.SUPPORT_FULL_VERIFIED)


def census_ids() -> list[str]:
    for path in CENSUS_CANDIDATES:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return sorted({row["skill_id"] for row in json.load(fh)["rows"]})
    raise SystemExit("census 找不到")


def stamp() -> None:
    """把**本次读数实际加载的**源码文件指纹打出来 ⇒ 读数自带出处，不靠现场描述。"""
    import hashlib
    for mod in (C, S, D):
        path = getattr(mod, "__file__", None)
        if not path or not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        print(f"STAMP {os.path.basename(path)} {digest} {path}")


def measure() -> dict:
    """一次完整读数：基线 / 关两道共用闸 / 控件 / 方向分类。"""
    rs = D.load_ruleset()
    svc = S.RocoService()
    ids = census_ids()

    def read() -> tuple[list[tuple[str, str, bool]], list[tuple[str, bool]]]:
        rows, verdicts = [], []
        for sid in ids:
            sk = rs.skills.get(sid)
            if sk is None:
                continue
            rec = svc._skill_record(rs, sk, with_tier=True)
            tier = rec["support_tier"]
            v = C.settlement_verdict(sk)
            resolved = bool(v["resolved"])
            verdicts.append((sid, resolved))
            tier_sim = tier in SIM
            if tier_sim != resolved:
                direction = ("判据 true / 档位 " + str(tier)) if resolved else \
                            ("判据 false / 档位 " + str(tier))
                rows.append((sid, direction, resolved))
        return rows, verdicts

    base_mm, base_v = read()
    real_gaps, real_words = C.respond_clause_gaps, C.UNSETTLED_WORDS
    try:
        C.respond_clause_gaps = lambda skill, parsed: []          # noqa: ARG005
        C.UNSETTLED_WORDS = ()
        off_mm, off_v = read()
    finally:
        C.respond_clause_gaps, C.UNSETTLED_WORDS = real_gaps, real_words
    after_mm, _ = read()

    flipped = [(sid, a, b) for (sid, a), (_, b) in zip(base_v, off_v) if a != b]
    return {
        "ids": len(ids),
        "baseline_mismatches": len(base_mm),
        "gates_off_mismatches": len(off_mm),
        "after_mismatches": len(after_mm),
        "control_verdict_flips": len(flipped),
        "control_flip_ids": [sid for sid, _a, _b in flipped],
        "gates_off_detail": [dict(sid=sid, direction=dirn, resolved=res)
                             for sid, dirn, res in off_mm],
        "directions": sorted({dirn for _sid, dirn, _res in off_mm}),
        "py_hash_seed": os.environ.get("PYTHONHASHSEED", "<unset>"),
    }


def components() -> None:
    """逐候选列出「关掉两道共用闸后，还有哪道闸在兜」——回答『少的几条去哪了』。"""
    rs = D.load_ruleset()
    svc = S.RocoService()
    caps = C.declared_capabilities_of()
    flags = C._flags_of(caps)
    ids = census_ids()
    real_gaps, real_words = C.respond_clause_gaps, C.UNSETTLED_WORDS
    try:
        C.respond_clause_gaps = lambda skill, parsed: []          # noqa: ARG005
        C.UNSETTLED_WORDS = ()
        for sid in ids:
            sk = rs.skills.get(sid)
            if sk is None:
                continue
            base = C.classify_skill(sk, **flags)
            base_support = base.get("support")
            if base_support not in SIM:
                continue                      # 只有「底档可模拟」才可能靠对齐降级
            v = C.settlement_verdict(sk)
            if v["resolved"]:
                continue                      # 已翻正 ⇒ 它就是那批打架之一
            parsed = v.get("parsed")
            bits = {
                "residual_spans": C.residual_mechanic_spans(
                    sk, parsed, C.claimed_mechanic_words(parsed, flags)),
                "compound": C.compound_clause_gaps(sk, parsed),
                "diag_shapes": C.diagnostic_shape_gaps(sk, parsed),
                "unparsed": list(getattr(parsed, "unparsed", None) or []),
                "unsettled_kinds": [k for k in C.UNSETTLED_EFFECT_KINDS
                                    if k in {getattr(e, "kind", "") for e in
                                             (getattr(parsed, "effects", None) or [])}],
                "respond_gaps_off": C.respond_clause_gaps(sk, parsed),
            }
            print(f"CAND {sid} tier_base={base_support} verdict_unsettled={v['unsettled']}")
            for name, val in bits.items():
                if val:
                    print(f"    gate {name}: {val}")
    finally:
        C.respond_clause_gaps, C.UNSETTLED_WORDS = real_gaps, real_words


VARIANTS: "dict[str, dict]" = {
    "both-off(判据口径)": {"respond_clause_gaps": lambda skill, parsed: [],
                           "UNSETTLED_WORDS": ()},
    "respond-only": {"respond_clause_gaps": lambda skill, parsed: []},
    "words-only": {"UNSETTLED_WORDS": ()},
    "both-off+compound+diag": {"respond_clause_gaps": lambda skill, parsed: [],
                               "UNSETTLED_WORDS": (),
                               "compound_clause_gaps": lambda skill, parsed: [],
                               "diagnostic_shape_gaps": lambda skill, parsed: []},
    "all-text-gates-off": {"respond_clause_gaps": lambda skill, parsed: [],
                           "UNSETTLED_WORDS": (),
                           "compound_clause_gaps": lambda skill, parsed: [],
                           "diagnostic_shape_gaps": lambda skill, parsed: [],
                           "residual_mechanic_spans": lambda skill, parsed, claimed_words=(): []},
}


def variants() -> None:
    """把「关哪些闸」当自变量扫一遍：反证读数对补丁组合是否敏感。"""
    rs = D.load_ruleset()
    svc = S.RocoService()
    ids = census_ids()

    def count() -> list[str]:
        bad = []
        for sid in ids:
            sk = rs.skills.get(sid)
            if sk is None:
                continue
            tier = svc._skill_record(rs, sk, with_tier=True)["support_tier"]
            resolved = bool(C.settlement_verdict(sk)["resolved"])
            if (tier in SIM) != resolved:
                bad.append(sid)
        return bad

    print(f"VARIANT baseline(无补丁) mismatches={len(count())}")
    for label, patch in VARIANTS.items():
        saved = {k: getattr(C, k) for k in patch}
        try:
            for k, v in patch.items():
                setattr(C, k, v)
            bad = count()
        finally:
            for k, v in saved.items():
                setattr(C, k, v)
        print(f"VARIANT {label} mismatches={len(bad)} ids={bad}")
    print(f"VARIANT baseline(恢复后) mismatches={len(count())}")


def sweep() -> int:
    """6 个 PYTHONHASHSEED（含 unset）各起一个**隔离子进程**跑 --once。"""
    here = os.path.abspath(__file__)
    bad = 0
    for seed in ("<unset>", "0", "1", "7", "42", "12345"):
        env = dict(os.environ)
        if seed == "<unset>":
            env.pop("PYTHONHASHSEED", None)
        else:
            env["PYTHONHASHSEED"] = seed
        proc = subprocess.run([sys.executable, here, "--once"], env=env,
                              capture_output=True, text=True)
        line = next((ln for ln in proc.stdout.splitlines()
                     if ln.startswith("GATES_OFF_MISMATCHES")), "<no reading>")
        ctl = next((ln for ln in proc.stdout.splitlines()
                    if ln.startswith("CONTROL_FLIPS")), "<no reading>")
        print(f"seed={seed:8s} exit={proc.returncode} {line} {ctl}")
        if proc.returncode != 0:
            bad += 1
            print(proc.stderr[-500:])
    return bad


def main(argv: list[str]) -> int:
    stamp()
    data = measure()
    print(f"IDS {data['ids']}")
    print(f"BASELINE_MISMATCHES {data['baseline_mismatches']}")
    print(f"GATES_OFF_MISMATCHES {data['gates_off_mismatches']}")
    print(f"AFTER_RESTORE_MISMATCHES {data['after_mismatches']}")
    print(f"CONTROL_FLIPS {data['control_verdict_flips']} "
          f"(关闸后 resolved 翻正的技能数；0 = 补丁空转 ⇒ 本次测量作废)")
    print(f"DIRECTIONS {data['directions']}")
    for row in data["gates_off_detail"]:
        print(f"  MM {row['sid']} | {row['direction']}")
    print(f"PY_HASH_SEED {data['py_hash_seed']}")
    if "--sweep" in argv:
        print("--- hash seed sweep ---")
        sweep()
    if "--components" in argv:
        print("--- 关闸后仍被别的闸兜住的候选（底档∈SIM 但判据未翻正）---")
        components()
    if "--variants" in argv:
        print("--- 补丁组合扫描 ---")
        variants()
    if "--json" in argv:
        path = argv[argv.index("--json") + 1]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        print(f"WROTE {path}")
    # 退出码：0 = 基线 0 且恢复后 0 且补丁有效；否则 3（读数仍已打印）
    ok = (data["baseline_mismatches"] == 0 and data["after_mismatches"] == 0
          and data["control_verdict_flips"] > 0)
    return 0 if ok else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
