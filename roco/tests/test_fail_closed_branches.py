"""攻击 / 防御分支的 fail-closed 纪律（第 47 轮批 0 的钉子）。

**这个文件存在的理由**：第 46 轮审计（`scripts/roco/audit-roster-48.py`）实测到引擎里有两处
**静默丢弃**——效果既没生效，也没进 `state.unsupported`：

  1. **攻击分支丢弃附带效果**。`甩水`（`skill_000418`，描述「造成魔伤，自己回复1能量」）
     实测 `energy` 不变、`events = ['damage']`、`unsupported = []`。
     落点：`env.py` 的攻击区段只调 `fx.compute_damage`，从不处理描述里的附带效果。
  2. **防御分支丢弃「应对成功：…」子句**。`水泡盾`（`skill_000429`，描述
     「减伤80%，应对攻击：自己获得魔攻+70%」）实测 `buffs = {}`、`unsupported = []`。
     落点：`env.py` 的防御区段应用减伤后直接 `return`。
     `parse.parse_skill` 其实**解析出了**这条效果（`parsed_effects` 含 `self_stat`），
     但没有任何一段代码去应用或登记它。

静默丢弃比 fail closed 更糟：`effects.py` 的纪律是「不知道就说不支持」，
而这两条让上层以为技能已经可用。所以本文件的断言是**二选一的强约束**：

    描述里被解析/被标记出来的一条效果，在事件或回执里**要么真的生效、
    要么进 `unsupported` 并带上原因**。两者都没有 = 红。

**反证（必红）**：去掉实现里的登记与生效（只保留伤害/减伤），下面两条用例会红。
反证命令写在 `docs/roco/FULL-CATALOG.md` 旁边不适用，实际过程见交付汇报：
把 `env.py` 的攻击区段恢复成「只算伤害」即红。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as rparse        # noqa: E402
from roco_env.schema import (               # noqa: E402
    ACTION_ITEM,
    ACTION_SKILL,
    Action,
)

RS = rdata.load_ruleset()

#: 两只都有出处：甩水在圆号鱼配招里，水泡盾在海豹船长的规范配招里。
WATER_GUN = "skill_000418"          # 甩水：造成魔伤，自己回复1能量（自带效果缺陷，见用例 1）
BUBBLE_SHIELD = "skill_000429"      # 水泡盾：减伤80%，应对攻击：自己获得魔攻+70%
NEUTRAL_ATTACK = "skill_000434"     # 泡沫：对敌方精灵造成物理伤害（纯伤害，无附带机制）
DEFENSE = "skill_000286"            # 防御：只在需要制造「应对失败」时用

#: 对手首发（圆号鱼，一定会攻击）。只用它自己学得到的技能。
ENEMY_FIRST = "pet_000417"
ENEMY_TEAM = [ENEMY_FIRST, "pet_000445", "pet_000062"]

#: 每只填充精灵的配招都取自它自己的学习表（否则 validate_team 会拒）。
#: 对手首发圆号鱼带**甩水**（水系攻击）与**防御**（用来制造「应对失败」）。
_FILLER_LOADOUTS = {
    "pet_000417": (WATER_GUN, DEFENSE, "skill_000305", "skill_000483"),
    "pet_000062": (NEUTRAL_ATTACK, "skill_000286", "skill_000392", "skill_000408"),
    "pet_000445": tuple(RS.candidate_moveset("pet_000445")),
    "pet_000190": tuple(RS.candidate_moveset("pet_000190")),
}


def _team_setup(attacker_pid, attacker_skills):
    """造一局：player 首发 = `attacker_pid`（配招 `attacker_skills`），enemy 首发 = 圆号鱼。"""
    player = list(dict.fromkeys([attacker_pid, "pet_000190", "pet_000062"]))
    for filler in ("pet_000417", "pet_000445", "pet_000062"):
        if len(player) >= 3:
            break
        if filler not in player:
            player.append(filler)
    loadouts = dict(_FILLER_LOADOUTS)
    loadouts[attacker_pid] = tuple(attacker_skills)
    for pid, sids in loadouts.items():
        learnable = RS.learnsets[pid].all_skill_ids
        for sid in sids:
            assert sid in learnable, f"{RS.pets[pid].name} 学不到 {RS.skills[sid].name}"
    return renv.reset(player, list(ENEMY_TEAM), seed=11, rs=RS, loadouts=loadouts)


def _enemy_action(state, skill_id):
    """断言这个动作对对手合法，再返回它。避免手搓一个不在配招里的技能。"""
    act = Action(ACTION_SKILL, skill_id=skill_id)
    legal = renv.legal_actions(state, RS, "enemy")
    assert act in legal, f"对手的行动不合法：{act.label(RS)}（合法：{[a.label(RS) for a in legal]}）"
    return act


def _events(state, kind):
    return [e for e in state.events if e.kind == kind]


class AttackBranchDropsAttachedEffects(unittest.TestCase):
    """甩水（附带「自己回复1能量」）不能既没生效、又没登记。"""

    def test_energy_gain_is_applied_or_registered(self):
        state = _team_setup("pet_000417", [WATER_GUN, "skill_000286",
                                           "skill_000305", "skill_000483"])
        pet = state.player.field_pet
        self.assertEqual(pet.pet_id, "pet_000417")
        pet.energy = 3            # 甩水能耗 0，所以这 3 点是纯起点

        skill = RS.skills[WATER_GUN]
        parsed = rparse.parse_skill(skill)
        self.assertIn("能量", skill.desc)          # 描述里确实写了附带效果

        after = renv.step_joint(
            state, RS,
            Action(ACTION_SKILL, skill_id=WATER_GUN),
            _enemy_action(state, WATER_GUN),
        )
        pet_after = after.player.field_pet

        # 「真的生效」的判据：有 energy 类事件，或能量数值确实涨了（扣掉回合末 +1）
        window = [e for e in after.events if e.turn == 1]
        energy_events = [e for e in window if e.kind in ("energy_gain", "self_energy")]
        regen = [e for e in window if e.kind == "energy_regen" and e.detail.get("side") == "player"]
        applied = bool(energy_events) or (pet_after.energy == 4 and not regen)
        # 「如实登记」的判据：unsupported 里有一条指向这个技能
        registered = [u for u in after.unsupported
                      if u.get("evidence") == WATER_GUN or "甩水" in str(u.get("what", ""))]

        self.assertTrue(
            applied or registered,
            "甩水的附带效果「自己回复1能量」既没生效也没登记："
            f"energy {pet.energy} -> {pet_after.energy}，"
            f"energy_events={energy_events}，unsupported={after.unsupported}，"
            f"parse.effects={parsed.kinds()}，parse.unparsed={parsed.unparsed}",
        )

    def test_registered_unsupported_carries_a_reason(self):
        """登记时**必须**写明原因，不能塞一个空字符串。"""
        state = _team_setup("pet_000417", [WATER_GUN, "skill_000286",
                                           "skill_000305", "skill_000483"])
        state.player.field_pet.energy = 3
        after = renv.step_joint(
            state, RS,
            Action(ACTION_SKILL, skill_id=WATER_GUN),
            _enemy_action(state, DEFENSE),
        )
        for u in after.unsupported:
            self.assertTrue(str(u.get("detail", "")).strip(),
                            f"unsupported 条目没有 detail：{u}")


class DefenseBranchDropsRespondClause(unittest.TestCase):
    """水泡盾的「应对成功：自己获得魔攻+70%」不能既没生效、又没登记。"""

    def _run(self, enemy_skill):
        state = _team_setup("pet_000190", [NEUTRAL_ATTACK, BUBBLE_SHIELD,
                                           "skill_000678", "skill_000294"])
        pet = state.player.field_pet
        self.assertEqual(pet.pet_id, "pet_000190")
        pet.energy = 3
        return renv.step_joint(
            state, RS,
            Action(ACTION_SKILL, skill_id=BUBBLE_SHIELD),
            _enemy_action(state, enemy_skill),
        )

    def test_respond_clause_applied_when_respond_succeeds(self):
        after = self._run(WATER_GUN)          # 对手用水系攻击 → 应对成功
        pet = after.player.field_pet
        defense_events = [e for e in after.events if e.kind == "defense"]
        self.assertEqual(len(defense_events), 1)
        self.assertTrue(defense_events[0].detail.get("respond"), "前提没成立：应对没成功")

        applied = pet.buffs.get("spa") == 70 or any(
            e.kind == "buff_self" for e in after.events
        )
        registered = [u for u in after.unsupported if "水泡盾" in str(u.get("what", ""))]
        self.assertTrue(
            applied or registered,
            "水泡盾的「应对成功：自己获得魔攻+70%」既没生效也没登记："
            f"buffs={pet.buffs}，unsupported={after.unsupported}，"
            f"parsed={rparse.parse_skill(RS.skills[BUBBLE_SHIELD]).kinds()}",
        )

    def test_respond_clause_registered_when_respond_fails(self):
        """没应对成功时，这条子句**不能**被当成已生效（也不能静默）。"""
        after = self._run(DEFENSE)       # 对手用防御 → 应对攻击失败
        pet = after.player.field_pet
        defense_events = [e for e in after.events if e.kind == "defense"]
        self.assertFalse(defense_events[0].detail.get("respond"), "前提不成立：应对不该成功")
        self.assertNotIn("spa", pet.buffs, "应对失败却把「应对成功」的效果算上了")
        registered = [u for u in after.unsupported if "水泡盾" in str(u.get("what", ""))]
        self.assertTrue(
            registered,
            "应对失败时既没生效也没登记（静默丢弃）："
            f"buffs={pet.buffs}，unsupported={after.unsupported}",
        )

    def test_registered_unsupported_carries_a_reason(self):
        after = self._run(DEFENSE)
        for u in after.unsupported:
            self.assertTrue(str(u.get("detail", "")).strip(),
                            f"unsupported 条目没有 detail：{u}")


class NeverApproximatedAsPlainDamage(unittest.TestCase):
    """禁止把 unsupported 效果近似成普通伤害——两处的伤害事件都必须照旧只来自伤害路径。"""

    def test_registering_effects_does_not_invent_a_damage_event(self):
        state = _team_setup("pet_000417", [WATER_GUN, "skill_000286",
                                           "skill_000305", "skill_000483"])
        state.player.field_pet.energy = 3
        after = renv.step_joint(
            state, RS,
            Action(ACTION_SKILL, skill_id=WATER_GUN),
            Action(ACTION_ITEM, item_id="回复药", target_index=0),
        )
        damaging = [e for e in after.events
                    if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertEqual(len(damaging), 1, "攻击技能只应产生一次伤害事件")
        self.assertEqual(damaging[0].detail.get("skill_id"), WATER_GUN)
        self.assertEqual(damaging[0].detail.get("power_used"), 30.0)


if __name__ == "__main__":
    unittest.main()
