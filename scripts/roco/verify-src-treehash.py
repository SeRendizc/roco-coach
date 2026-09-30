#!/usr/bin/env python3
"""独立验收用的 **src 树内容指纹**（harness-verifier 自建，非实现者工具）。

用途：证明某次读数**是在冻结的源码树上取得的** —— 跑长用例前后各取一次，
两次相同 ⇒ 期间没有别的成员改动被测量的源码，读数有效。

用法:
    cd /mnt/e/roco-coach && python3 scripts/roco/verify-src-treehash.py [根目录...]
默认根目录: roco/src 与 roco/tests。
输出: 每个根一行 `ROOT <sha256> <文件数> <字节数>`，最后一行 `TREE <sha256>`。
"""
from __future__ import annotations

import hashlib
import os
import sys

DEFAULTS = ("roco/src", "roco/tests")


def tree_digest(root: str) -> tuple[str, int, int]:
    entries: list[tuple[str, str]] = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        for name in sorted(filenames):
            if name.endswith(".pyc"):
                continue
            path = os.path.join(dirpath, name)
            try:
                with open(path, "rb") as fh:
                    blob = fh.read()
            except OSError:
                continue
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            entries.append((rel, hashlib.sha256(blob).hexdigest()))
            total += len(blob)
    h = hashlib.sha256()
    for rel, digest in entries:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(digest.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest(), len(entries), total


def main(argv: list[str]) -> int:
    roots = argv[1:] or list(DEFAULTS)
    overall = hashlib.sha256()
    for root in roots:
        digest, count, size = tree_digest(root)
        print(f"ROOT {root} {digest} files={count} bytes={size}")
        overall.update(f"{root}:{digest}\n".encode("utf-8"))
    print(f"TREE {overall.hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
