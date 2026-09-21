"""私有状态 `serialize → deserialize` 往返必须**逐字段**无损（第 43 轮）。

为什么值得单开一个文件
----------------------
私有域的**每一个**端点（`battle/legal`、`battle/advance`、`battle/plan` 取公开面那一步）
都要把 `serialize()` 的状态发出去、再 `deserialize()` 还原。往返只要丢一个字段，
后果不会是报错，而是**安静地换了输入**——这一类问题在这个仓库里已经出现过四次
（特征只读调用方字段、命名不一致、边际量对象形状、damagePreview 没转发），
每一次都不报错、只是行为悄悄变了。

这一轮（第 43 轮）追「伤害预览为什么永远是空」时追到了这里：
`SideState.to_dict()` 一直在丢 `loadouts`，而 `from_dict` 一直在读它。于是

  · `public_planner_state().self.loadouts` 变成 `{}`；
  · 规划器重建状态时退回 `learnsets.all_skill_ids`（**全部可学技能**），
    候选池与真实合法动作不再是同一套；
  · `_damage_preview` 找不到任何攻击技能 → 页面上的伤害预览恒为不可用。

所以这里不做「抽查某个字段」，而是**整份字典逐字段比对**：`to_dict` 的输出往返后
必须与原样一致。加了新字段却忘了写进 `to_dict`（或反之）时，这条会红。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_state_roundtrip -v
"""

from __future__ import annotations

import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


def fresh():
    return renv.reset(A_TEAM, B_TEAM, seed=20260921, rs=RS)


def advance(state, steps: int):
    """按确定性轮换推进若干回合，让往返在**非初始**状态上也被测到。"""
    ropp.bind_ruleset(RS)
    for step in range(steps):
        if state.result:
            break
        if state.phase == "replace":
            for side in list(renv.needs_replacement(state)):
                legal = [a for a in renv.legal_actions(state, RS, side) if a.kind == "switch"]
                if legal:
                    renv.step_replace(state, RS, side, int(legal[step % len(legal)].target_index))
            continue
        mine = [a for a in renv.legal_actions(state, RS, "player") if a.kind != "escape"]
        theirs = [a for a in renv.legal_actions(state, RS, "enemy") if a.kind != "escape"]
        if not mine or not theirs:
            break
        nxt = renv.step_joint(state, RS, mine[step % len(mine)], theirs[step % len(theirs)])
        if nxt is None:
            break
        state = nxt
    return state


class RoundTripIsLossless(unittest.TestCase):
    def test_initial_state_roundtrips_byte_for_byte(self):
        state = fresh()
        before = state.to_dict()
        after = renv.deserialize(copy.deepcopy(before), RS).to_dict()
        self.assertEqual(before, after, "初始状态的往返丢了字段")

    def test_midgame_state_roundtrips_byte_for_byte(self):
        # 初始状态没有异常/印记/换人记录，往返在它上面「看起来」是好的；
        # 打到中局再比才有意义。
        state = advance(fresh(), 8)
        before = state.to_dict()
        after = renv.deserialize(copy.deepcopy(before), RS).to_dict()
        self.assertEqual(before, after, "中局状态的往返丢了字段")

    def test_roundtrip_survives_twice(self):
        state = advance(fresh(), 5)
        once = renv.deserialize(copy.deepcopy(state.to_dict()), RS)
        twice = renv.deserialize(copy.deepcopy(once.to_dict()), RS)
        self.assertEqual(once.to_dict(), twice.to_dict(), "连续两次往返不收敛")


class LoadoutsSpecifically(unittest.TestCase):
    """把这次抓到的那一个字段单独钉住——整份比对红了之后要能立刻看出是它。"""

    def test_loadouts_survive_the_roundtrip(self):
        state = fresh()
        self.assertTrue(state.player.loadouts, "初始状态就该有配招（否则这条会空过）")
        back = renv.deserialize(copy.deepcopy(state.to_dict()), RS)
        self.assertEqual(back.player.loadouts, state.player.loadouts)
        self.assertEqual(back.enemy.loadouts, state.enemy.loadouts)

    def test_public_planner_state_keeps_loadouts_after_a_roundtrip(self):
        # 真实链路：页面拿到公开面的那一步就是「先往返、再取公开面」。
        # 这里丢配招 → 规划器的候选池会退回「全部可学技能」。
        state = fresh()
        pub_before = renv.public_planner_state(state, RS, "player")
        self.assertTrue(pub_before["self"]["loadouts"], "公开面本来就该带配招")
        back = renv.deserialize(copy.deepcopy(state.to_dict()), RS)
        pub_after = renv.public_planner_state(back, RS, "player")
        self.assertEqual(pub_after["self"]["loadouts"], pub_before["self"]["loadouts"])

    def test_plan_candidates_match_after_a_roundtrip(self):
        # 更强的一条：往返之后，**规划器看到的合法动作**必须与原来一致。
        # 丢配招时这里会红，因为候选池会从「4 个配招」变成「全部可学技能」。
        state = fresh()
        before = sorted(a.id if hasattr(a, "id") else str(a) for a in renv.legal_actions(state, RS, "player"))
        back = renv.deserialize(copy.deepcopy(state.to_dict()), RS)
        after = sorted(a.id if hasattr(a, "id") else str(a) for a in renv.legal_actions(back, RS, "player"))
        self.assertEqual(after, before, "往返之后合法动作变了：配招没被保住")

        # 反向：确认这条不是空过——用「清掉配招」的状态算一遍，结果必须不同
        stripped = renv.deserialize(copy.deepcopy(state.to_dict()), RS)
        stripped.player.loadouts = {}
        stripped_actions = sorted(a.id if hasattr(a, "id") else str(a)
                                  for a in renv.legal_actions(stripped, RS, "player"))
        self.assertNotEqual(stripped_actions, before,
                            "把配招清空后合法动作居然没变——那这条检查量不到东西")


if __name__ == "__main__":
    unittest.main()
