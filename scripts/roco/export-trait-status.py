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
            # 2026-09-25（第 40 轮）：`gaps` 是**机器可读**的"还没实现的那一块"。
            # 以前它只是理由里的一句话，于是 `泛音列` 能一边写着「只挂印记、不结算能耗」一边标 FULL。
            "gaps": list(getattr(spec, "gaps", ()) or ()),
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
    parser.add_argument("--check", action="store_true",
                        help="只对比：磁盘产物与**现在重算**是否一致（除 generated_at）；不一致退出 1")
    parser.add_argument("--out", default=os.path.join("data", "roco", "engine-trait-status.json"))
    args = parser.parse_args(argv)

    payload = build()
    # 2026-09-25（第 29 轮）：账本会**静默漂移** —— `traits.py` 加到 17 条（渴求 / 贪得无厌）而
    # `data/roco/engine-trait-status.json` 一直是 15 条（FULL 8 / PARTIAL 3），没有任何一条判据会发现，
    # 而三份文档还在引更旧的 6/2/4。加 `--check`：与"现在重算"逐字节比（除 `generated_at`），
    # 好让判据（`roco/tests/test_trait_status_export.py`）把它钉住。
    if args.check:
        path = os.path.join(_ROOT, args.out)
        if not os.path.exists(path):
            print(f"MISSING {args.out}：账本不存在，先跑 --write")
            return 1
        with open(path, encoding="utf-8") as fh:
            disk = json.load(fh)
        a, b = dict(payload), dict(disk)
        a.pop("generated_at", None)
        b.pop("generated_at", None)
        if json.dumps(a, ensure_ascii=False, sort_keys=True) != json.dumps(b, ensure_ascii=False, sort_keys=True):
            fresh_traits = {p.get("trait") for p in payload.get("pets", [])}
            disk_traits = {p.get("trait") for p in disk.get("pets", [])}
            print("MISMATCH：账本与现在重算不一致")
            print("  现在重算 counts:", json.dumps(payload["counts"], ensure_ascii=False),
                  f"（{len(payload.get('pets', []))} 条）")
            print("  磁盘账本 counts:", json.dumps(disk.get("counts", {}), ensure_ascii=False),
                  f"（{len(disk.get('pets', []))} 条）")
            if fresh_traits - disk_traits:
                print("  账本里缺：", "、".join(sorted(fresh_traits - disk_traits)))
            if disk_traits - fresh_traits:
                print("  账本里多：", "、".join(sorted(disk_traits - fresh_traits)))
            print("  修法：python3 scripts/roco/export-trait-status.py --write")
            return 1
        print(f"check ok：{args.out} 与现在重算一致（counts {json.dumps(payload['counts'], ensure_ascii=False)}，"
              f"{len(payload.get('pets', []))} 条）")
        return 0

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
