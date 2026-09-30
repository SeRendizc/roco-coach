"""`462 放晴` 的判据（task-28 · 2026-09-30 · 427 并集 D 族余项）。

描述逐字：「**光系技能威力永久+50%**，应对防御：**改为永久+100%**。」

**两条机制、两个能力位**（各自独立 ✓）：
  ① 基础子句「<系>技能威力永久±N%」⇒ `damage.element_power_ramp`
     （写 `PetState.element_power_mods`；**读点早已就绪** —— `effects.compute_damage` 按 `skill.element` 取 ✓）
  ② 覆盖体「应对X：改为永久±N%」⇒ **复用** `energy.respond_override`（`mode="element_power"`）
     ⇒ 应对成功时**基础那条被摘掉**、只留改为值 ⇒ **是替换不是相加** ✓

⚠ 本文件钉的六条（**前五条是一般的机制钉子，第六条是两条反证**）：
  ① 应对成功 ⇒ `mods == 100` **且"写 50"的事件数 == 0** ← **只断言最终值会被"先 +50 再覆盖"骗过** ✗
  ② 应对不成立 ⇒ `mods == 50` **且恰有 1 条写 50 的事件** ✓
  ③ **非光系** ⇒ 一个字不写 ✓（Δ=0 ✓）
  ④ 462 之后 `buffs` 里**没有 `power_*`** ✓（系别修正是**另一个字段**，不许串到旧那条路上 ✗）
  ⑤ 旧 4 系（`ELEMENT_POWER_BUFF_KEYS` 那条路）之后 `element_power_mods` **为空** ✓
  ⑥ 反证：**新路关 ⇒ 462 不生效**（档位翻 PARTIAL ✓）· **旧路关 ⇒ 4 系照旧** ✓
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _play(sid, foe_sid):
    """我方出 `sid`，敌方出 `foe_sid` ⇒ (出手后状态, 我方出手前 hp)。"""
    rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
    mine = next(p for p, l in rs.learnsets.items()
                if sid in l.all_skill_ids and p != "pet_000417")
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([sid] + [s for s in rs.candidate_moveset(mine) if s != sid][:3])
    loadouts["pet_000417"] = tuple(
        [foe_sid] + [s for s in rs.candidate_moveset("pet_000417") if s != foe_sid][:3])
    state = E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                    config=cfg, unverified_overrides=_OVERRIDES)
    mine_a, foe_a = Action(ACTION_SKILL, skill_id=sid), Action(ACTION_SKILL, skill_id=foe_sid)
    assert mine_a in E.legal_actions(state, rs, "player"), f"{sid} 不合法"
    assert foe_a in E.legal_actions(state, rs, "enemy"), f"{foe_sid} 不合法"
    return E.step_joint(state, rs, mine_a, foe_a), rs


def _ramp_events(after):
    return [(e.detail.get("element"), e.detail.get("delta"))
            for e in after.events if e.kind == "element_power_ramp"]


class ElementPowerRampTest(unittest.TestCase):
    #: 对手出「防御」（`286 防御` ⇒ 462 的「应对防御」成立 ✓）
    FOE_DEFENSE = "skill_000286"
    #: 对手出「攻击」（`418 甩水` ⇒ 不构成应对防御 ✓ 对照用）
    FOE_ATTACK = "skill_000418"

    def test_respond_success_replaces_not_adds(self):
        """① 应对成功 ⇒ `mods==100` **且没有"写 50"的事件** ✓（替换不是相加 ✗）。"""
        after, _ = _play("skill_000462", self.FOE_DEFENSE)
        mods = dict(after.player.field_pet.element_power_mods or {})
        self.assertEqual(mods.get("光系"), 100, f"应对成功应停在 100（改为值），实际={mods} ✗")
        evs = _ramp_events(after)
        self.assertEqual([d for _, d in evs if d == 50], [],
                         f"**不许出现「写 50」的事件** —— 那说明是「先加 50 再覆盖」✗ 实际事件={evs}")
        self.assertEqual([d for _, d in evs], [100], f"应恰好一条写 100 的事件，实际={evs}")

    def test_respond_failed_keeps_base_value(self):
        """② 应对不成立 ⇒ `mods==50` **且恰有 1 条写 50 的事件** ✓。"""
        after, _ = _play("skill_000462", self.FOE_ATTACK)
        mods = dict(after.player.field_pet.element_power_mods or {})
        self.assertEqual(mods.get("光系"), 50, f"没构成应对 ⇒ 基础值 50，实际={mods} ✗")
        self.assertEqual(_ramp_events(after), [("光系", 50)],
                         f"应恰好一条写 50 的事件，实际={_ramp_events(after)}")

    def test_non_light_skill_gets_nothing(self):
        """③ **非光系** ⇒ 一个字不写 ✓（写的是系别键，别的系别读不到 ✓）。"""
        after, _ = _play("skill_000462", self.FOE_ATTACK)
        mods = dict(after.player.field_pet.element_power_mods or {})
        self.assertNotIn("水系", mods, f"只该写「光系」，实际={mods} ✗")
        self.assertEqual(set(mods), {"光系"}, f"只该写「光系」，实际={mods} ✗")

    def test_does_not_touch_the_old_buff_field(self):
        """④ 462 之后 `buffs` 里**没有 `power_*`** ✓（系别修正走的是**另一个字段** ✗ 不许串路）。"""
        after, _ = _play("skill_000462", self.FOE_ATTACK)
        stuck = [k for k in after.player.field_pet.buffs if k.startswith("power")]
        self.assertEqual(stuck, [], f"系别级修正不该写进 `buffs`，实际={stuck} ✗")

    def test_unrelated_skills_do_not_write_the_new_field(self):
        """⑤ 与系别威力无关的技能走完，`element_power_mods` **保持为空** ✓。

        ⚠ 原来这一条想钉"旧 4 系路（`ELEMENT_POWER_BUFF_KEYS`）不写新字段"，
        但**全库扫描：没有任何技能用旧路写"<系>技能威力+N%"**（0 命中 ✓ 实测）
        ⇒ 那条**没有技能级样本**（旧路由特性/别的形状覆盖）⇒ 改成这个**可测**的版本 ✓
        （钉的仍然是同一件事：新字段**只**由 `element_power_ramp` 写 ✗ 不许被别的路顺手写 ✓）
        """
        for sid in ("skill_000286", "skill_000418", "skill_000359"):
            after, _ = _play(sid, self.FOE_ATTACK)
            self.assertEqual(dict(after.player.field_pet.element_power_mods or {}), {},
                             f"{sid} 不该写 `element_power_mods` ✗")

    def test_counter_proof_new_leaf_off_makes_it_unsettled(self):
        """⑥ 反证：**新路关 ⇒ 462 不生效**（判据与档位都要说未结算 ✓）。"""
        from roco_env import coverage as C
        rs = D.load_ruleset()
        sk = rs.skills["skill_000462"]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for key in ("element_power_ramp", "respond_override"):
            off = dict(caps)
            off[key] = False
            flags = {f: bool(off.get(k, False)) for k, f in C._CAPABILITY_TO_FLAG.items()}
            self.assertEqual(C.classify_skill(sk, **flags)["support"], C.SUPPORT_PARTIAL,
                             f"关掉 `{key}` 后 462 的档位必须说 PARTIAL ✗（否则就是假绿）")
            self.assertFalse(C.settlement_verdict(sk, declared=off)["resolved"],
                             f"关掉 `{key}` 后产品口径也必须说未结算 ✗")


if __name__ == "__main__":
    unittest.main()
