"""task-28（2026-09-30）：**按系别的持久威力修正** `PetState.element_power_mods` 的**读点**。

本文件只钉**读点那一半**（字段 + `effects.compute_damage` 的按系别读取）；
写入方（`skill_000462 放晴` 的解析/施加）在下一批 ⇒ 这里**手工塞值**跑 A/B ✓
（这正是"读点先通、写入方随后"，且**空字段 ⇒ 一切照旧** ⇒ 不留假绿 ✓）。

⚠ 读数用**引擎自己的事件**：`damage`（真伤害）与 `power_multiplier`（威力乘区）——
**不是 `power_used`** ✗（实测：`power_used` 是**基础威力**，加了 mod 也仍写 100.0，
我以前读错过一次 ⇒ 记在这里）。
"""
import unittest, dataclasses

from roco_env import data as rdata, env, rule_config as RC
from roco_env.schema import Action, ACTION_SKILL, PetState

FILL = ["pet_000550", "pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000124"]
OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "单测（速度平手与本批无关）",
        "microcase_id": "MC-E05"}]


class FieldTest(unittest.TestCase):
    """① 字段：照 `skill_ramps` 同型 —— **只在非空时进序列化**（legacy 逐字不变 ✓）。"""

    def test_field_exists(self):
        self.assertIn("element_power_mods", [f.name for f in dataclasses.fields(PetState)])

    def test_absent_when_empty(self):
        pet = PetState(pet_id="pet_000001", slot=0)
        self.assertNotIn("element_power_mods", pet.to_dict(),
                         "空的时候不许出现在序列化里（legacy 逐位不变）")

    def test_roundtrip(self):
        pet = PetState(pet_id="pet_000001", slot=0)
        pet.element_power_mods = {"光系": 50}
        d = pet.to_dict()
        self.assertEqual(d["element_power_mods"], {"光系": 50})
        self.assertEqual(PetState.from_dict(d).element_power_mods, {"光系": 50})


class DamageReadTest(unittest.TestCase):
    """② 读点：`compute_damage` 按 **`skill.element`** 读，且只影响那一个系别。"""

    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()
        cls.v3 = RC.get_rule_config("mobile_s4_candidate_v3")
        # 一个**光系**攻击技 + 一个**非光系**攻击技（同一只精灵学得到 ⇒ 别的变量都一样）
        cls.guang = cls.other = None
        cls.pid = None
        for pid in sorted(cls.rs.pets):
            ls = cls.rs.learnsets.get(pid)
            if not ls:
                continue
            atk = [s for s in sorted(ls.all_skill_ids)
                   if cls.rs.skills[s].is_attack and cls.rs.skills[s].power]
            g = next((s for s in atk if cls.rs.skills[s].element == "光系"), None)
            o = next((s for s in atk if cls.rs.skills[s].element != "光系"), None)
            if g and o:
                cls.pid, cls.guang, cls.other = pid, g, o
                break

    def _run(self, sid, mods):
        pid = self.pid
        ids = sorted(self.rs.learnsets[pid].all_skill_ids)
        st = env.reset([pid] + [x for x in FILL if x != pid][:5], FILL[:6], seed=7, rs=self.rs,
                       config=self.v3, loadouts={pid: (sid,) + tuple(s for s in ids if s != sid)[:3]},
                       unverified_overrides=OVR)
        st.player.field_pet.energy = 99
        st.enemy.field_pet.energy = 99
        if mods:
            st.player.field_pet.element_power_mods = dict(mods)
        foe = [a for a in env.legal_actions(st, self.rs, "enemy")
               if a.kind == "skill" and self.rs.skills[a.skill_id].is_attack][0]
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=sid), foe)
        ev = [v.detail for v in after.events
              if v.kind == "damage" and v.detail.get("side") == "player"]
        self.assertTrue(ev, "这一手应当有 damage 事件")
        return ev[0]

    def test_same_element_gets_the_multiplier(self):
        base = self._run(self.guang, None)
        mod = self._run(self.guang, {"光系": 50})
        self.assertAlmostEqual(float(base["power_multiplier"]), 1.0, places=6)
        self.assertAlmostEqual(float(mod["power_multiplier"]), 1.5, places=6,
                               msg="光系 +50% ⇒ 乘区 1.5（**引擎自己的读数**）")
        self.assertGreater(int(mod["damage"]), int(base["damage"]), "真伤害要涨")

    def test_other_element_is_untouched(self):
        """对照实验：**别的系**技能 ⇒ Δ 必须 0（火系技能配 `{'光系':50}` 不许动）。"""
        base = self._run(self.other, None)
        mod = self._run(self.other, {"光系": 50})
        self.assertEqual(int(mod["damage"]), int(base["damage"]), "非光系技能不许受影响")
        self.assertAlmostEqual(float(mod["power_multiplier"]), float(base["power_multiplier"]), places=6)

    def test_empty_field_changes_nothing(self):
        """空字段 = 与"没有这个字段"逐位相同（legacy / v2 的行为不变 ✓）。"""
        a = self._run(self.guang, None)
        b = self._run(self.guang, {})
        self.assertEqual((int(a["damage"]), float(a["power_multiplier"])),
                         (int(b["damage"]), float(b["power_multiplier"])))

    def test_config_without_the_capability_is_identical(self):
        """本次**不引入能力位**（读点是数据驱动的）⇒ v2 / legacy 下同一份数据读数相同 ✓。"""
        base = self._run(self.guang, None)
        # v2：同一手、没有 mods ⇒ 读数与 v3 对照完全一致（读点不吃配置）
        pid = self.pid
        ids = sorted(self.rs.learnsets[pid].all_skill_ids)
        st = env.reset([pid] + [x for x in FILL if x != pid][:5], FILL[:6], seed=7, rs=self.rs,
                       config=RC.get_rule_config("mobile_s4_candidate_v2"),
                       loadouts={pid: (self.guang,) + tuple(s for s in ids if s != self.guang)[:3]},
                       unverified_overrides=OVR)
        st.player.field_pet.energy = 99
        st.enemy.field_pet.energy = 99
        foe = [a for a in env.legal_actions(st, self.rs, "enemy")
               if a.kind == "skill" and self.rs.skills[a.skill_id].is_attack][0]
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=self.guang), foe)
        ev = [v.detail for v in after.events
              if v.kind == "damage" and v.detail.get("side") == "player"][0]
        self.assertAlmostEqual(float(ev["power_multiplier"]), float(base["power_multiplier"]), places=6)


if __name__ == "__main__":
    unittest.main()
