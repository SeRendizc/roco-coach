#!/usr/bin/env python3
"""导出 12 只精灵特性的**实现状态**，给文档生成器与报告用。

为什么需要有这么一个导出：数据侧的 `effect_support` 字段在快照里恒为
`unsupported`（那是**上游数据**的说法），而引擎侧有的特性已经实现、有的被明确拒绝。
两个数字说的是两件事，混在一张表里必然误导。

    python3 scripts/roco/export-trait-status.py            # 打印
    python3 scripts/roco/export-trait-status.py --write    # 写到 data/roco/engine-trait-status.json

输出形状::

    {"schema_version": 1, "ruleset_id": "...", "generated_by": "...",
     "counts": {"FULL": 6, "PARTIAL": 2, "REFUSED": 4},
     "pets": [{"pet_id": ..., "name": ..., "trait": ..., "status": "FULL",
               "hook": "on_enter", "reason": "..."}]}

`status` 的含义与 `roco_env/traits.py` 的常量一致：
    FULL     描述能被机械实现，且有测试
    PARTIAL  只实现了描述的一部分
    REFUSED  依赖引擎做不到的前提，**明确拒绝**而不是近似
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import traits as tr           # noqa: E402


def build() -> Dict[str, Any]:
    rs = rdata.load_ruleset()
    pets: List[Dict[str, Any]] = []
    for name, spec in tr.TRAITS.items():
        found = rs.pets_by_name(spec.pet_name)
        pet_id = found[0].pet_id if found else None
        pets.append({
            "pet_id": pet_id,
            "name": spec.pet_name,
            "trait": name,
            "trait_skill_id": found[0].feature_skill_id if found else None,
            "status": spec.status,
            "hook": spec.hook,
            "reason": spec.reason,
            "desc": spec.desc,
        })
    pets.sort(key=lambda p: (p["pet_id"] or ""))
    return {
        "schema_version": 1,
        "ruleset_id": rs.ruleset_id,
        "snapshot_fingerprint": rs.snapshot_fingerprint(),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "generated_by": "scripts/roco/export-trait-status.py",
        "note": (
            "这是**引擎侧**的实现状态，与数据侧的 `effect_support` 字段是两件事。"
            "数据侧全部标 unsupported（上游快照的说法），引擎侧有实现、部分实现与被拒绝三档。"
            "REFUSED 不等于「没做」：它表示依赖引擎做不到的前提，理由写在 reason 里。"
        ),
        "counts": tr.implementation_summary(),
        "pets": pets,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="导出特性实现状态")
    parser.add_argument("--write", action="store_true", help="写到 data/roco/engine-trait-status.json")
    parser.add_argument("--out", default=os.path.join("data", "roco", "engine-trait-status.json"))
    args = parser.parse_args(argv)

    payload = build()
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.write:
        path = os.path.join(_ROOT, args.out)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {args.out}")
    else:
        print(text)
    print("counts:", json.dumps(payload["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
