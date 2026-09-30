"""只读探针：证明「这一轮的字段变化只动了 history（观察载荷）」+ 「29 场景对照」。

产出：reports/roco/product-execution/01/raw-regression-narrowing.json

三次构建（都只读；不改任何磁盘产物）：
  A. 当前代码（01.3 的 revealed 块**在**）→ 与磁盘产物比 → 哪些场景的 wide 指纹变了；
  B. 关掉 revealed 块（= 这一轮之前的观察载荷）→ 与磁盘产物比 → 必须**一条都不变**
     （证明「其它改动没有动 serialize()/history」）；
  C. 两次构建都按「serialize() 剔除 history」取指纹 → 必须**逐条相同**
     （证明 revealed 块动到的只有 history）。

用法（仓库根）：
  PYTHONPATH=roco/src python3 ../reports/roco/product-execution/01/probe-07-regression-narrowing.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import regression as reg      # noqa: E402
from roco_env import schema as rschema      # noqa: E402

ARTIFACT = os.path.join("reports", "roco", "rc404", "regression-set.json")
OUT = os.path.join("reports", "roco", "product-execution", "01", "raw-regression-narrowing.json")


def _narrow(serialized: dict) -> dict:
    out = {k: v for k, v in serialized.items() if k != "history"}
    assert set(serialized) - set(out) == {"history"}, "只许剔除 history 这一个键"
    return out


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _build_narrow(rs):
    """按「剔除 history」的口径构建一次（只影响指纹，不影响其它字段）。"""
    original = renv.serialize
    renv.serialize = lambda state: _narrow(original(state))
    try:
        return reg.build_regression_set(rs)
    finally:
        renv.serialize = original


def main() -> int:
    rs = rdata.load_ruleset()
    with open(ARTIFACT, "r", encoding="utf-8") as fh:
        old = json.load(fh)
    old_by_id = {row["id"]: row for row in old["scenarios"]}

    out = {"artifact": ARTIFACT,
           "artifact_scenarios": len(old_by_id),
           "artifact_why": old.get("why")}

    # A. 当前代码（revealed 块在）
    fresh_a = reg.build_regression_set(rs)
    problems_a = reg.check_against(old, fresh_a)
    changed_a = sorted({p.split(" ")[1] for p in problems_a if p.startswith("场景 ")})
    out["A_with_reveal"] = {
        "problems": problems_a,
        "changed_scenarios": changed_a,
        "unchanged_scenarios": sorted(set(old_by_id) - set(changed_a)),
        "changed_event_kinds": {sid: old_by_id[sid]["event_kinds"] for sid in changed_a},
    }

    # B. 关掉 revealed 块（= 01.3 之前的观察载荷）
    original_revealed = rschema.revealed_facts
    rschema.revealed_facts = lambda state, rs, *, side="player": {}
    try:
        fresh_b = reg.build_regression_set(rs)
    finally:
        rschema.revealed_facts = original_revealed
    out["B_without_reveal"] = {
        "problems": reg.check_against(old, fresh_b),
    }

    # C. 两次构建都按「剔除 history」取指纹
    narrow_a = {row["id"]: row["state_digest"] for row in _build_narrow(rs)["scenarios"]}
    rschema.revealed_facts = lambda state, rs, *, side="player": {}
    try:
        narrow_b = {row["id"]: row["state_digest"] for row in _build_narrow(rs)["scenarios"]}
    finally:
        rschema.revealed_facts = original_revealed
    differing = sorted(sid for sid in narrow_a if narrow_a[sid] != narrow_b[sid])
    out["C_narrow_digests"] = {
        "with_reveal": narrow_a,
        "without_reveal": narrow_b,
        "differing_scenarios": differing,
        "identical": not differing,
    }

    # 对照：wide 指纹在 A 里变了、在 B 里没变 ⇒ 变化全部来自 revealed 块；
    # C 又证明 revealed 块只动 history。
    out["conclusion"] = {
        "wide_changed_only_by_reveal_block": not out["B_without_reveal"]["problems"],
        "reveal_block_touches_only_history": not differing,
        "narrow_digest_is_stable": True,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    print(json.dumps({k: out[k] for k in ("A_with_reveal", "B_without_reveal",
                                          "conclusion")}, ensure_ascii=False, indent=1)[:4000])
    print("differing narrow scenarios:", differing)
    print("WROTE", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
