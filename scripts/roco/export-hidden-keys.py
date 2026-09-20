#!/usr/bin/env python3
"""把 service.py 的 HIDDEN_KEYS 块导出成 JSON，供 Node 桥与结构测试共用。

为什么要导出：隐藏信息词汇表现在有**三份**实现（Python 服务、Node 桥、
浏览器工具层镜像）。三份各自手写迟早会漂——而且已经漂过一次：
桥的 HIDDEN_KEYS 少了 `pendingenemy` / `pendingplayer` / `replacequeue`，
于是私有状态能从第一层（桥）穿过去，只剩服务端兜底。

这里让 Python 侧成为**唯一事实来源**，另外两份从它派生：

    python3 scripts/roco/export-hidden-keys.py            # 打印
    python3 scripts/roco/export-hidden-keys.py --write    # 写 data/roco/hidden-keys.json

`roco-client.js` 读这个文件（构建期生成的 JSON 随仓库走）；
`tests/evals/roco/plan-e2e.test.js` 的三份比对继续保留，用来兜住「有人改了
JSON 但没改 JS」这种情况。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SERVICE = os.path.join(_ROOT, "roco", "src", "roco_env", "service.py")
_OUT = os.path.join("data", "roco", "hidden-keys.json")


def extract() -> dict:
    with open(_SERVICE, encoding="utf-8") as fh:
        src = fh.read()
    start = src.index("HIDDEN_KEYS = frozenset(")
    end = src.index("# 查询 kind", start)
    block = src[start:end]
    keys = sorted(set(re.findall(r'"([a-z0-9]+)"', block)))
    if len(keys) < 10:
        raise SystemExit(f"解析 HIDDEN_KEYS 失败：只读到 {len(keys)} 个键")
    return {
        "schema_version": 1,
        "source": "roco/src/roco_env/service.py",
        "generated_by": "scripts/roco/export-hidden-keys.py",
        "note": (
            "隐藏信息键（归一化后比较）。Python 服务是唯一事实来源；"
            "Node 桥与浏览器工具层镜像从这份 JSON 派生，"
            "由 tests/evals/roco/plan-e2e.test.js 的三份比对兜底。"
        ),
        "normalize": "lowercase + strip non-alphanumeric",
        "keys": keys,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="导出隐藏信息键")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--out", default=_OUT)
    args = parser.parse_args(argv)
    payload = extract()
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.write:
        path = os.path.join(_ROOT, args.out)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {args.out}（{len(payload['keys'])} 个键）")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
