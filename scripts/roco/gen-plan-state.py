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


def advance(state, rs, turns: int, strategy_name: str = "greedy_damage"):
    """把这局推进若干回合，用来产出**中局**的公开状态。

    轨迹集需要的不只是开局：开局双方满血、后备齐全，很多工具分支走不到。
    推进用的是引擎自己的对手策略（`opponents.get_strategy`），和
    `/battle/advance` 走**同一套**决策代码与同一个确定性随机源
    `(seed, turn)`——所以同一 seed、同一回合数必然推出同一状态，
    不引入时钟或全局 random。

    推进不了就停在当前回合并**说明原因**，不伪造一个「看起来打到第 3 回合」的状态。
    """
    if turns <= 0:
        return state
    from roco_env import opponents as opp

    # 策略需要**显式**绑定规则集才能估伤害（`_rs()` 宁愿抛错也不猜一个默认表）。
    opp.bind_ruleset(rs)
    strategy = opp.get_strategy(strategy_name)
    for _ in range(turns):
        if state.phase == "finished" or state.result is not None:
            break
        queue = renv.needs_replacement(state)
        if state.phase == "replace" or queue:
            for side in renv.needs_replacement(state):
                legal = [a for a in renv.legal_actions(state, rs, side) if a.kind == "switch"]
                if not legal:
                    continue
                slot = strategy.act(renv.observe(state, rs, side), legal, int(state.seed), int(state.turn))
                renv.step_replace(state, rs, side, int(slot.target_index))
            continue
        legal_player = renv.legal_actions(state, rs, "player")
        legal_enemy = renv.legal_actions(state, rs, "enemy")
        if not legal_player or not legal_enemy:
            sys.stderr.write("第 %d 回合没有合法动作，停止推进\n" % state.turn)
            break
        player_action = strategy.act(
            renv.observe(state, rs, "player"), legal_player, int(state.seed), int(state.turn)
        )
        enemy_action = strategy.act(
            renv.observe(state, rs, "enemy"), legal_enemy, int(state.seed), int(state.turn)
        )
        renv.step_joint(state, rs, player_action, enemy_action)
    return state


def build(seed: int, turns: int = 0, version: int = 0) -> dict:
    rs = rdata.load_ruleset()
    team = [rs.pets_by_name(name)[0].pet_id for name in TEAM_NAMES]
    state = renv.reset(team, team, seed=seed, rs=rs)
    if turns:
        state = advance(state, rs, turns)
    if version:
        # 「当前公开状态版本」由调用方指定：轨迹集要构造**同一份局面、不同版本号**
        # 的世界，用来验证状态过期保护真的会作废旧结论（而不是靠约定不传旧版本）。
        state.state_version = version
    public = renv.public_planner_state(state, rs)
    return {
        "seed": seed,
        "turns": turns,
        "state_version": public.get("state_version"),
        "ruleset_id": rs.ruleset_id,
        "team": team,
        "strategy": "greedy_damage",
        "public": public,
        "private": renv.serialize(state),
    }


def main(argv) -> int:
    seed = None
    turns = 0
    version = 0
    rest = list(argv[1:])
    while rest:
        token = rest.pop(0)
        if token == "--turns":
            if not rest:
                sys.stderr.write("--turns 需要一个整数\n")
                return 2
            turns = int(rest.pop(0))
        elif token == "--version":
            if not rest:
                sys.stderr.write("--version 需要一个整数\n")
                return 2
            version = int(rest.pop(0))
        elif token.startswith("--"):
            sys.stderr.write("未知参数：%s\n" % token)
            return 2
        elif seed is None:
            seed = int(token)
        else:
            sys.stderr.write("用法：gen-plan-state.py <seed> [--turns N] [--version N]\n")
            return 2
    if seed is None:
        sys.stderr.write("用法：gen-plan-state.py <seed> [--turns N] [--version N]\n")
        return 2
    if turns < 0 or version < 0:
        sys.stderr.write("--turns / --version 不能为负\n")
        return 2
    json.dump(build(seed, turns, version), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
