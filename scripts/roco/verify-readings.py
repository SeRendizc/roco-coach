#!/usr/bin/env python3
"""独立验收用的 **逐 id 读数快照 / 差异**工具（harness-verifier 自建）。

用途：任何「收窄类」改动都必须给出**收窄真的生效**的反例，否则是空判据。
本工具把一段时间点的逐 id 读数（档位 / 判据 / settled / unsettled / 效果数）落成 JSON，
再 diff 两个快照 ⇒ **0 变化 = 该改动没有改变任何一条实体的读数（空判据嫌疑）**。

用法:
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-readings.py --dump /tmp/a.json
    cd roco && PYTHONPATH=src python3 ../scripts/roco/verify-readings.py --diff /tmp/a.json /tmp/b.json
退出码: diff 模式 —— 有变化 0；**无变化 4**（空判据）；用法错误 2。
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join("roco", "src") if os.path.isdir(os.path.join("roco", "src")) else "src")

from roco_env import coverage as C  # noqa: E402
from roco_env import data as D  # noqa: E402
from roco_env import service as S  # noqa: E402

CENSUS = ("tests/data/pets100-skills-census.json",
          "roco/tests/data/pets100-skills-census.json")


def census_ids() -> list[str]:
    for path in CENSUS:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return sorted({row["skill_id"] for row in json.load(fh)["rows"]})
    raise SystemExit("census 找不到")


def file_sha(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def dump(path: str, all_entities: bool = False) -> int:
    rs = D.load_ruleset()
    svc = S.RocoService()
    out = {"stamp": {}, "rows": {}, "scope": "all" if all_entities else "union"}
    for mod, name in ((C, "coverage.py"), (S, "service.py"), (D, "data.py")):
        out["stamp"][name] = file_sha(getattr(mod, "__file__", None))
    if all_entities:
        # 全台账口径（579 战斗技能）：族②/族③ 的受影响行多数**不在 427 并集内**
        # ⇒ 只对并集做 diff 会漏掉它们（那正是「收窄真的生效」要看的行）。
        ids = sorted((C.build_coverage(rs).get("skills") or {}))
    else:
        ids = census_ids()
    for sid in ids:
        sk = rs.skills.get(sid)
        if sk is None:
            continue
        rec = svc._skill_record(rs, sk, with_tier=True)
        v = C.settlement_verdict(sk)
        parsed = v.get("parsed")
        out["rows"][sid] = {
            "tier": rec["support_tier"],
            "resolved": bool(v["resolved"]),
            "settled": list(v.get("settled") or []),
            "unsettled": [str(x) for x in (v.get("unsettled") or [])],
            "n_effects": len(getattr(parsed, "effects", None) or []),
            "unparsed": [str(x) for x in (getattr(parsed, "unparsed", None) or [])],
        }
    out["totals"] = C.build_coverage(rs)["totals"]
    out["n"] = len(out["rows"])
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"DUMP {path} n={out['n']} scope={out['scope']} totals={out['totals']}")
    print(f"DUMP stamp={json.dumps(out['stamp'], ensure_ascii=False)}")
    return 0


def diff(a_path: str, b_path: str) -> int:
    a = json.load(open(a_path, encoding="utf-8"))
    b = json.load(open(b_path, encoding="utf-8"))
    print(f"A {a_path} stamp={json.dumps(a['stamp'], ensure_ascii=False)} totals={a['totals']}")
    print(f"B {b_path} stamp={json.dumps(b['stamp'], ensure_ascii=False)} totals={b['totals']}")
    ids = sorted(set(a["rows"]) | set(b["rows"]))
    changed = []
    for sid in ids:
        ra, rb = a["rows"].get(sid), b["rows"].get(sid)
        if ra == rb:
            continue
        fields = []
        if ra is None or rb is None:
            fields.append("存在性")
        else:
            for key in ("tier", "resolved", "settled", "unsettled", "n_effects", "unparsed"):
                if ra.get(key) != rb.get(key):
                    fields.append(key)
        changed.append((sid, fields, ra, rb))
    print(f"CHANGED_IDS {len(changed)} / {len(ids)}")
    for sid, fields, ra, rb in changed:
        print(f"  DIFF {sid} fields={fields}")
        for key in fields:
            print(f"      {key}: {json.dumps((ra or {}).get(key), ensure_ascii=False)[:200]}"
                  f" -> {json.dumps((rb or {}).get(key), ensure_ascii=False)[:200]}")
    if not changed:
        print("EMPTY_CRITERION 两个快照逐 id 完全相同 ⇒ 该改动没有让任何一条实体的读数发生变化")
        return 4
    return 0


def main(argv: list[str]) -> int:
    if "--dump" in argv:
        return dump(argv[argv.index("--dump") + 1], all_entities="--all" in argv)
    if "--diff" in argv:
        i = argv.index("--diff")
        return diff(argv[i + 1], argv[i + 2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
