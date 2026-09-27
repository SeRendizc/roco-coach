"""RC-401 批次六：**「敌方失去 N 能量」** 两条读法（场上一只 / 全队）。

人类口径⑤（按覆盖收益排序）在批次五之后给出的第一名是"能量操纵 6 条"。这一批先落其中**语义最清楚**的
两条 —— 「敌方失去 N 能量」（不是"偷取"：**没有任何一方获得**）与「敌方队伍中所有精灵失去 N 能量」：

  · `skill_000747` 报复「减伤70%，应对攻击：敌方失去3能量」—— 防御技能：**应对成功才结算**，
    应对失败要登记（`env.py` 的防御分支）；
  · `skill_000762` 小型打劫「敌方队伍中所有精灵失去1能量」—— 状态技能：**全队**都扣；
  · `skill_000745` 恶作剧「敌方失去3能量，应对防御：**改为**敌方失去6能量」—— 条件**覆盖**，
    两值互斥；引擎还没有覆盖语义 ⇒ **整条不许按 3 结算**（只登记未认领）。

每条都对应一个**会红的方向**（不是"跑一遍没报错"）：
  ① 应对成功 ⇒ 对手场上那只真的少 3 点，且**自己不加**（与"偷取"分开）；
  ② 应对失败 ⇒ 一点都不扣，且 `unsupported` 里有指向该技能的一条；
  ③ 全队读法逐只扣、且**下限 0**（不出现负能量）；
  ④ 有「改为」时基础值**不结算**（恶作剧）：状态分支拒绝应用 + 登记未认领；
  ⑤ 反证：`偷取敌方 2 能量` 照旧走 `drain_energy`（自己加），不能被我这两条吃掉。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import parse as rparse        # noqa: E402
from roco_env import rule_config as rc      # noqa: E402
from roco_env.schema import ACTION_SKILL, Action   # noqa: E402

RS = rdata.load_ruleset()

#: 这条能力**只在候选配置里声明**（`energy.foe_energy_loss`）。legacy / v2 没声明 ⇒
#: 效果在解析层就被收回，「两种配置对照」那条判据量的就是这个差别。
CANDIDATE = "mobile_s4_candidate_v3"
LEGACY = "legacy_sim_v1"

REVENGE = "skill_000747"        # 报复：减伤70%，应对攻击：敌方失去3能量（可学者：寂灭骨龙等 17 只）
PETTY_ROBBERY = "skill_000762"  # 小型打劫：敌方队伍中所有精灵失去1能量（可学者：幽铃 / 摇铃魔偶）
PRANK = "skill_000745"          # 恶作剧：敌方失去3能量，应对防御：改为敌方失去6能量（可学者：圆号鱼等）
WATER_GUN = "skill_000418"      # 甩水（对手用；纯攻击，用来制造/破坏「应对」）
DRAIN = "skill_000756"          # 勾魂：偷取敌方3能量（描述⑤的对照：这一条是"偷取"）
REVENGE_PET = "pet_000225"      # 寂灭骨龙（会 报复）
ROBBERY_PET = "pet_000616"      # 幽铃（会 小型打劫）
#: 会 恶作剧 的精灵里挑**速度与对手首发不同**的一只（圆号鱼 spe105 / 权杖-V spe75）：
#: 候选配置把 `turn_order.speed_tie` 声明为 UNKNOWN ⇒ 同速会 fail closed（那是引擎的诚实，
#: 但夹具不该制造这种局面）。
PRANK_PET = "pet_000330"        # 权杖-V（会 恶作剧，spe 75 ≠ 对手首发 105）

#: 候选配置（`pvp-standard-six-pet`）要求**每方恰好 6 只** ⇒ 夹具按 6v6 造。
#: 全部取自冻结图鉴里有学习表的物种，配招一律用它们自己的**规范配招**（`candidate_moveset`）。
_POOL = ["pet_000417", "pet_000445", "pet_000062", "pet_000152", "pet_000153",
         "pet_000190", "pet_000225", "pet_000052", "pet_000053", "pet_000118",
         "pet_000130", "pet_000240"]
_ENEMY = ["pet_000417", "pet_000445", "pet_000062", "pet_000152", "pet_000153", "pet_000190"]


def _my_loadout(attacker_pid, primary):
    """我方首发配招：`primary` 放第一位，其余三格从**它自己的规范配招**里补（不写死别人的招）。"""
    rest = [sid for sid in RS.candidate_moveset(attacker_pid) if sid != primary]
    return tuple([primary] + rest[:3])


def _setup(attacker_pid, skills, config_id=CANDIDATE):
    """一局：player 首发 = attacker_pid（配招 skills），enemy 首发 = 圆号鱼。

    **队伍规模按配置取**（legacy 是 3v3、候选是 6v6）—— 写死 6 只会让 legacy 那一侧直接抛。
    """
    """一局：player 首发 = attacker_pid（配招 skills），enemy 首发 = 圆号鱼。

    配招必须都在学习表里（否则 `reset` 会拒）—— 这条断言本身就是判据的一部分。
    其余精灵的配招一律取**它自己的规范配招**（`candidate_moveset`），不写死别人的招。
    """
    size = int(getattr(rc.load_config(config_id), "battle_mode_team_size", 3))
    player = [attacker_pid] + [p for p in _POOL if p != attacker_pid]
    player = list(dict.fromkeys(player))[:size]
    enemy = list(_ENEMY)[:size]
    loadouts = {attacker_pid: tuple(skills)}
    for pid in player + enemy:                     # 只给**真的在队伍里**的精灵配招（多一条会被 reset 拒）
        loadouts.setdefault(pid, tuple(RS.candidate_moveset(pid)))
    for pid, sids in loadouts.items():
        learnable = RS.learnsets[pid].all_skill_ids
        for sid in sids:
            assert sid in learnable, f"{RS.pets[pid].name} 学不到 {RS.skills[sid].name}"
    return renv.reset(player, enemy, seed=11, rs=RS, loadouts=loadouts,
                      config=rc.load_config(config_id))


def _enemy_action(state, skill_id):
    act = Action(ACTION_SKILL, skill_id=skill_id)
    assert act in renv.legal_actions(state, RS, "enemy"), "对手这个动作不合法"
    return act


class FoeEnergyLossTest(unittest.TestCase):
    def test_respond_success_deducts_and_does_not_give_self(self):
        """① 报复应对成功：对手场上那只 -3，**自己不加**（与偷取区分）。"""
        state = _setup(REVENGE_PET, _my_loadout(REVENGE_PET, REVENGE))
        me = state.player.field_pet
        me.energy = 4
        state.enemy.field_pet.energy = 5          # 给足 3 点，扣减不被下限截断
        after = renv.step_joint(state, RS,
                                Action(ACTION_SKILL, skill_id=REVENGE),
                                _enemy_action(state, WATER_GUN))
        lost = [e for e in after.events if e.kind == "foe_energy_loss"]
        self.assertTrue(lost, f"应有一条 foe_energy_loss 事件：{[e.kind for e in after.events]}")
        # 数量以**事件里的 lost** 为准（那是引擎真的扣掉的数），再用回合末回能校正终值
        self.assertEqual(int(lost[0].detail.get("lost", -1)), 3,
                         f"这一手应当扣掉 3 点：{lost[0].detail}")
        # 终值里混着"对手自己回能"（它的技能自带回能 + 回合末回能）⇒ 按**事件逐项对账**：
        # 5（起始）− 3（这一条效果）+ 它自己的回能 + 回合末回能 = 终值。
        # 不用"另跑一局当对照"：对照那一手会改变回合走向（实测诡刺把对手打倒 ⇒ 连回合末回能都没有了），
        # 那种对照比不比都一样说不清。
        # 终值逐项对账（都能在上面的事件里核）：5（起始）− 3（这一条效果）+ 1（它的甩水自带回能）
        # = **3**。候选配置声明 `energy.regen.per_turn = 0`（「默认无自然回能」）⇒ 没有回合末回能那一项。
        # 写死终值是有意的：这一局是固定 seed + 固定双方动作，任何一项变了都该让这条判据红。
        self.assertEqual(after.enemy.field_pet.energy, 3,
                         f"对账：5 − 3 + 1（甩水自带回能）= 3（候选口径无回合末回能）；"
                         f"实际 {after.enemy.field_pet.energy}，事件 {[(e.kind, e.detail) for e in after.events if 'energy' in e.kind]}")
        # 「自己不加」：这一手之后（含回合末回能）我方能量不得比"扣掉自己技能能耗 + 回能"更多
        self.assertLessEqual(after.player.field_pet.energy, 4,
                             "失去能量不是偷取：我方不该因为这一手多出能量")

    def test_respond_failure_keeps_energy_and_registers(self):
        """② 应对失败（对手也防御）：一点都不扣，且登记一条指向该技能的 unsupported。"""
        state = _setup(REVENGE_PET, _my_loadout(REVENGE_PET, REVENGE))
        state.player.field_pet.energy = 4
        state.enemy.field_pet.energy = 5
        foe_before = state.enemy.field_pet.energy
        after = renv.step_joint(state, RS,
                                Action(ACTION_SKILL, skill_id=REVENGE),
                                _enemy_action(state, "skill_000286"))
        # 对手这一手是「防御」（能耗 1）⇒ 它的能量只会因为**自己出手**下降，不会因为我们的技能下降。
        cost = int(RS.skills["skill_000286"].energy)
        self.assertEqual(after.enemy.field_pet.energy, foe_before - cost,
                         f"应对没成立时只该少它自己的技能能耗 {cost} 点")
        self.assertFalse([e for e in after.events if e.kind == "foe_energy_loss"],
                         "应对没成立时不许出现扣能事件")
        self.assertTrue([u for u in after.unsupported if REVENGE in str(u.get("evidence", ""))],
                        f"应对失败必须登记为 unsupported：{after.unsupported}")

    def test_team_wide_loss_hits_every_member_and_floors_at_zero(self):
        """③ 小型打劫：全队逐只 -1；能量为 0 的成员不出负值。"""
        state = _setup(ROBBERY_PET, _my_loadout(ROBBERY_PET, PETTY_ROBBERY))
        for idx, mate in enumerate(state.enemy.pets):
            mate.energy = 0 if idx == 1 else 3      # 第二只故意 0 能量
        before = [p.energy for p in state.enemy.pets]
        after = renv.step_joint(state, RS,
                                Action(ACTION_SKILL, skill_id=PETTY_ROBBERY),
                                _enemy_action(state, WATER_GUN))
        got = [e for e in after.events if e.kind == "foe_team_energy_loss"]
        self.assertTrue(got, f"应有一条 foe_team_energy_loss 事件：{[e.kind for e in after.events]}")
        after_energy = [p.energy for p in after.enemy.pets]
        # 回合末回能只给**在场且存活**的那只 ⇒ 逐只比"扣 1"时只看不曾在场的那两只
        for idx in (1, 2):
            self.assertGreaterEqual(after_energy[idx], before[idx] - 1,
                                    f"第 {idx + 1} 只最多扣 1 点")
        self.assertTrue(all(e >= 0 for e in after_energy), f"能量不许为负：{after_energy}")
        self.assertTrue([u for u in after.unsupported if PETTY_ROBBERY in str(u.get("evidence", ""))],
                        "全队扣能要如实登记它的假设（力竭个体是否照扣）")

    def test_respond_override_is_not_settled_by_the_base_value(self):
        """④ 恶作剧（有「应对防御：改为…」）不许按基础值 3 结算。"""
        skill = RS.skills[PRANK]
        parsed = rparse.parse_skill(skill)
        self.assertEqual([e.kind for e in parsed.effects], [],
                         f"有「改为」覆盖时不许解析出可结算效果：{parsed.effects}")
        self.assertTrue(any("应对覆盖" in str(x) for x in parsed.unparsed),
                        f"覆盖段要登记为未认领：{parsed.unparsed}")
        state = _setup(PRANK_PET, _my_loadout(PRANK_PET, PRANK))
        foe_before = state.enemy.field_pet.energy
        after = renv.step_joint(state, RS,
                                Action(ACTION_SKILL, skill_id=PRANK),
                                _enemy_action(state, WATER_GUN))
        cost = int(RS.skills[WATER_GUN].energy)
        self.assertGreaterEqual(after.enemy.field_pet.energy + cost, foe_before,
                                "覆盖语义没实现之前，一点都不许扣（只该少它自己出手的能耗）")
        self.assertFalse([e for e in after.events if "energy_loss" in str(e.kind)],
                         "覆盖语义没实现之前，不许出现任何扣能事件")
        self.assertTrue([u for u in after.unsupported if PRANK in str(u.get("evidence", ""))],
                        f"未认领的覆盖段必须登记：{after.unsupported}")

    def test_legacy_config_does_not_settle_and_does_not_register(self):
        """两种配置对照：**legacy 没声明这条能力 ⇒ 结算与 `unsupported` 都与批六之前逐位相同。**

        这是这一批的纪律判据（与 `energy.cost_modifier` / 连击那两条同一套）：新机制只在**配置声明**时生效。
        未声明时效果在解析层就被收回（`parse.resolve_foe_energy_loss(declared=False)`）——
        **连未认领标记都不补**，因为这一批之前解析器对这一段什么都不产出，
        补一条标记会让 legacy 的 `unsupported`（进 `serialize()`）变样。
        """
        legacy_cfg = rc.load_config(LEGACY)
        self.assertFalse(getattr(legacy_cfg, "energy_foe_energy_loss", True),
                         "legacy 配置不该声明这条能力")
        parsed_legacy = rparse.resolve_foe_energy_loss(
            RS.skills[REVENGE], declared=bool(legacy_cfg.energy_foe_energy_loss))
        self.assertEqual([e.kind for e in parsed_legacy.effects], [],
                         "未声明时效果必须被收回")
        self.assertEqual(parsed_legacy.unparsed, [],
                         "未声明时**不许**补未认领标记（那会改 legacy 的 unsupported）")
        # 真打一手：对手能量只因它自己出手而变，且 unsupported 里没有我们的技能
        state = _setup(REVENGE_PET, _my_loadout(REVENGE_PET, REVENGE), config_id=LEGACY)
        state.player.field_pet.energy = 4
        state.enemy.field_pet.energy = 5
        after = renv.step_joint(state, RS,
                                Action(ACTION_SKILL, skill_id=REVENGE),
                                _enemy_action(state, WATER_GUN))
        self.assertFalse([e for e in after.events if "foe_energy_loss" in str(e.kind)],
                         "legacy 口径下不许扣对手能量")
        self.assertFalse([u for u in after.unsupported if REVENGE in str(u.get("evidence", ""))],
                         f"legacy 口径下不许新增 unsupported（批六之前这里一条都没有）：{after.unsupported}")
        # 反证：同一条状态换成候选口径 ⇒ 必须真的扣（否则上面那条判据是空的）
        cand = _setup(REVENGE_PET, _my_loadout(REVENGE_PET, REVENGE), config_id=CANDIDATE)
        cand.player.field_pet.energy = 4
        cand.enemy.field_pet.energy = 5
        cand_after = renv.step_joint(cand, RS,
                                     Action(ACTION_SKILL, skill_id=REVENGE),
                                     _enemy_action(cand, WATER_GUN))
        self.assertTrue([e for e in cand_after.events if e.kind == "foe_energy_loss"],
                        "候选口径必须结算（否则「两种配置对照」没有对照）")

    def test_counterproof_drain_still_goes_to_self(self):
        """⑤ 反证：「偷取敌方 N 能量」照旧是 `drain_energy`（我方加、对手减）。"""
        drain = RS.skills[DRAIN]
        self.assertTrue(any(e.kind == "drain_energy" for e in rparse.parse_skill(drain).effects),
                        f"{drain} 的「偷取敌方」读法没变：{rparse.parse_skill(drain).effects}")
        self.assertFalse(any(e.kind.startswith("foe_energy_loss") for e in rparse.parse_skill(drain).effects),
                         "偷取不许被读成「敌方失去」（那会少算我方回能）")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
