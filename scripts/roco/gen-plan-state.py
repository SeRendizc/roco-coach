#!/usr/bin/env python3
"""生成一份**公开** planner state，供 Node 侧的端到端规划测试当输入。

用法::

    PYTHONPATH=roco/src python3 scripts/roco/gen-plan-state.py 7

输出一行 JSON::

    {"seed": 7, "public": {...}, "private": {...}}

三个字段各有用途：

``public``
    ``env.public_planner_state()`` 的产物。它是唯一被允许送到 ``/battle/plan``
    的东西，也是这份脚本存在的理由——端到端测试需要**真实引擎产出的**公开状态，
    而不是测试里手抄一份。手抄的 fixture 会随引擎改动悄悄过期，
    于是测试继续绿、真实链路早已对不上。

``private``
    同一局 ``env.serialize()`` 的私有完整状态。它带 ``seed`` 与对手后备血量，
    **故意**一起输出：反证测试要拿它去撞隐藏信息检测，证明「把私有状态递进去」
    会真的被拒，而不是靠约定不递。

``seed``
    这一局用的真实内部 seed。测试拿两个不同 seed 各生成一次，
    比较 ``public`` 是否逐字节一致——真实 seed 一旦泄进公开面，这条就会红。

本脚本是**测试辅助**，不进浏览器包、不被服务端点调用，也不写任何文件。
"""

from __future__ import annotations

import json
import os
import sys

# 允许直接 `python3 scripts/roco/gen-plan-state.py`（仓库根为 cwd），
# 不要求调用方记得设 PYTHONPATH。
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import data as rdata  # noqa: E402
from roco_env import env as renv  # noqa: E402

# 训练场 3v3 的 A 组阵容（与 docs/roco/PET-SUPPORT-MATRIX.md 的 A 组一致）。
TEAM_NAMES = ("寂灭骨龙", "海豹船长", "黑猫巫师")


def build(seed: int) -> dict:
    rs = rdata.load_ruleset()
    team = [rs.pets_by_name(name)[0].pet_id for name in TEAM_NAMES]
    state = renv.reset(team, team, seed=seed, rs=rs)
    return {
        "seed": seed,
        "ruleset_id": rs.ruleset_id,
        "team": team,
        "public": renv.public_planner_state(state, rs),
        "private": renv.serialize(state),
    }


def main(argv) -> int:
    if len(argv) != 2:
        sys.stderr.write("用法：gen-plan-state.py <seed>\n")
        return 2
    try:
        seed = int(argv[1])
    except ValueError:
        sys.stderr.write("seed 必须是整数\n")
        return 2
    json.dump(build(seed), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
