#!/usr/bin/env python3
"""task-6 第一步 · **先量**：开局的 battle view 回执里，每个 action 有没有带
「这一手有未实现效果」的字段？

量的是**玩家真正拿到的那份回执**（`POST /api/roco/battle/new` 的 `view`），不是引擎的私有面。
输出（`reports/roco/battle-smoke/unsupported-flag-probe.json`）：
  · 每个 action 对象的**键清单**；
  · 任何带 `unsupported / unverified / unresolved / effect_support` 这类字样的字段与取值；
  · **命中次数**：多少个 action 带上了「这一手有未实现效果」的信息；
  · 对照：同一条回执里 `state.unsupported`（引擎的逐手登记）是什么、有多少。

用法：
    python3 scripts/roco/battle-smoke-unsupported-flag.py                  # 量在跑的 8765
    python3 scripts/roco/battle-smoke-unsupported-flag.py --base=http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SMOKE = os.path.join(ROOT, "reports", "roco", "battle-smoke")
OWNED = os.path.join(ROOT, "data", "roco", "owned", "owned-pets.json")

# 「这一手有没有未实现效果」这件事，回执里可能用的字眼
MARKER_HINTS = ("unsupported", "unverified", "unresolved", "effect_support", "coverage",
                "mechanics", "unsupported_effect", "not_implemented")


def post(base: str, path: str, body: Dict[str, Any], cookie: str = "", csrf: str = "") -> Dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("origin", base)
    if cookie:
        req.add_header("cookie", cookie)
    if csrf:
        req.add_header("x-coach-csrf", csrf)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(base: str, path: str, cookie: str = "") -> Dict[str, Any]:
    req = urllib.request.Request(base + path, method="GET")
    req.add_header("origin", base)
    if cookie:
        req.add_header("cookie", cookie)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def bootstrap(base: str):
    req = urllib.request.Request(base + "/api/bootstrap", method="GET")
    req.add_header("origin", base)
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        set_cookie = resp.headers.get("set-cookie") or ""
    cookie = ""
    for part in set_cookie.split(";"):
        part = part.strip()
        if part.startswith("coach_session="):
            cookie = part
    return cookie, body.get("csrf")


def find_marks(obj: Any, path: str = "") -> List[Dict[str, Any]]:
    """把对象里**任何**带标记字样的键值抓出来（深度不限）。"""
    out: List[Dict[str, Any]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if any(h in str(k).lower() for h in MARKER_HINTS):
                out.append({"path": p, "value": v if not isinstance(v, (dict, list)) else
                            json.dumps(v, ensure_ascii=False)[:200]})
            out.extend(find_marks(v, p))
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:40]):
            out.extend(find_marks(v, f"{path}[{i}]"))
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("ROCO_BASE", "http://127.0.0.1:8765"))
    args = ap.parse_args(argv)
    base = args.base.rstrip("/")

    cookie, csrf = bootstrap(base)
    owned = json.load(open(OWNED, encoding="utf-8"))
    by_instance = {i["instance_id"]: i for i in owned["instances"]}

    # 用 task-5 那条实测配方的前六个实例当队伍（海豹船长在队里，它的配招含「硬门」）
    ids = [i["instance_id"] for i in owned["instances"]][:6]
    team = ids
    loadouts = {}
    builds = {b["owned_pet_instance_id"]: b for b in owned["battle_builds"]}
    for i in team:
        sp = by_instance[i]["species_id"]
        loadouts[sp] = list(builds[i]["ordered_skills"])

    enemy = [i["instance_id"] for i in owned["instances"]][100:106]
    started = post(base, "/api/roco/battle/new", {
        "mode": "pvp-standard-six-pet", "team": team, "enemy_team": enemy,
        "loadouts": loadouts, "seed": 20260921, "strategy": "greedy_damage",
    }, cookie, csrf)

    view = (started or {}).get("view") or {}
    actions = view.get("legal") or []
    action_keys = sorted({k for a in actions for k in (a or {}).keys()})
    skill_keys = sorted({k for a in actions for k in ((a or {}).get("skill") or {}).keys()})
    action_marks = [{"action_index": i, "skill_id": a.get("skill_id"),
                     "marks": find_marks(a)} for i, a in enumerate(actions)]
    hits = [m for m in action_marks if m["marks"]]
    # 「带 marked 字段吗」还要单独看有没有一个**专门**表示「这一手结算不了」的布尔/文本
    dedicated = sorted({k for k in action_keys
                        if any(h in k.lower() for h in ("unsupported", "unverified", "unresolved"))})

    out = {
        "schema_version": 1,
        "artifact": "unsupported-flag-probe",
        "base": base,
        "question": "开局的 battle view 里，每个 action 有没有带「这一手有未实现效果」的字段？",
        "battle_new_ok": bool((started or {}).get("ok")),
        "view_top_keys": sorted(view.keys()) if isinstance(view, dict) else None,
        "action_count": len(actions),
        "action_keys": action_keys,
        "action_skill_subkeys": skill_keys,
        "dedicated_marker_keys": dedicated,
        "actions_with_any_marker": len(hits),
        "action_marks": action_marks,
        "engine_runtime_registry": {
            "note": ("同一份回执里引擎的**逐手登记**（`state.unsupported`）。"
                     "注意它是**用完之后**才有的运行时记录，不是「点之前」的静态属性。"),
            "unsupported_seen_count": len(view.get("unsupported_seen") or []),
            "unsupported_seen_sample": (view.get("unsupported_seen") or [])[:3],
            "has_unsupported_seen_key": "unsupported_seen" in view,
        },
        "self_skills_rows": [
            {"skill_id": s.get("skill_id"),
             "keys": sorted((s or {}).keys()),
             "effect_support": ((s.get("skill") or {}).get("effect_support"))}
            for s in (view.get("self", {}).get("skills") or [])
        ][:8],
        "verdict": None,
    }
    # 判据：**专门**表示「这一手结算不了」的键，在 action 上存在吗
    if dedicated:
        out["verdict"] = "有：action 上存在专门字段 " + "、".join(dedicated)
    else:
        out["verdict"] = ("没有：action 对象只有 " + "、".join(action_keys)
                          + " —— 没有**任何**「这一手结算不了」的字段。"
                          "唯一沾边的是 `skill.effect_support`，而它对**全部 824 条技能**都是 "
                          "`unsupported`（数据侧口径），分辨不出「硬门」这种具体哪一手会白搭。")
    os.makedirs(SMOKE, exist_ok=True)
    with open(os.path.join(SMOKE, "unsupported-flag-probe.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps({
        "battle_new_ok": out["battle_new_ok"],
        "action_count": out["action_count"],
        "action_keys": out["action_keys"],
        "action_skill_subkeys": out["action_skill_subkeys"],
        "dedicated_marker_keys": out["dedicated_marker_keys"],
        "actions_with_any_marker": out["actions_with_any_marker"],
        "unsupported_seen_count": out["engine_runtime_registry"]["unsupported_seen_count"],
        "verdict": out["verdict"],
    }, ensure_ascii=False, indent=1))
    print(f"→ {os.path.join(SMOKE, 'unsupported-flag-probe.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
