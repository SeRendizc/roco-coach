"""task-25 B 族（2026-09-30）：**「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，
本技能<属性>永久±N」** 的解析、触发、对照与序列化。

三条（冻结语料里**只有**这三条）：
  · `skill_000270 蓄能轰击`「造成魔伤，**每使用1次其他普通系技能**，本技能能耗永久-2。」
  · `skill_000343 光能聚集`「造成魔伤，**每次使用其他草系技能后**，本技能威力永久+60。」
  · `skill_000450 过曝`    「造成魔伤，**每使用过1个其他系别技能**，本技能威力永久+30。」

语义核心是**「其他」**（本技能自己不算 ✗）；口径 = **次数**（不是"不同系别个数"），
由生成器 `damage.element_use_ramp` 的 `reason` 登记为 `ENGINE_HYPOTHESIS`，
**唯一改点** = `env._element_ramp_should_fire`。

每一条都配**对照实验**（触发条件不成立 ⇒ Δ 必须为 0）—— 这是本批最容易写错的地方。
"""
import unittest

from roco_env import data as rdata, env, parse as parse_mod, rule_config as RC
from roco_env.schema import Action, ACTION_SKILL

FILL = ["pet_000550", "pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000124"]
OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "单测用（速度平手与本批无关）",
        "microcase_id": "MC-E05"}]
B_SKILLS = ("skill_000270", "skill_000343", "skill_000450")


def _elem(rs, sid):
    return str(getattr(rs.skills.get(sid), "element", "") or "")


class ParseShapesTest(unittest.TestCase):
    """① 解析层：三种写法各读出正确的 `element_ramp`（只记结构，不发 Effect）。"""

    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()

    def test_three_shapes_are_read(self):
        want = {
            "skill_000270": ("same_element", "普通系", "cost", -2),
            "skill_000343": ("same_element", "草系", "power", 60),
            "skill_000450": ("other_element", None, "power", 30),
        }
        for sid, (scope, element, field, delta) in want.items():
            with self.subTest(sid=sid):
                info = parse_mod.parse_skill(self.rs.skills[sid]).element_ramp
                self.assertIsNotNone(info, f"{sid} 应当读出 element_ramp")
                self.assertEqual(info["scope"], scope)
                self.assertEqual(info["element"], element)
                self.assertEqual(info["field"], field)
                self.assertEqual(info["delta"], delta)
                # `evidence` 就是原文那一段（认领要盖住「每」那个机制词）
                self.assertIn("本技能", info["evidence"])

    def test_only_these_three_skills_have_the_shape(self):
        hit = [sid for sid, sk in self.rs.skills.items()
               if parse_mod.parse_skill(sk).element_ramp is not None]
        # 冻结语料就是三条（多出来 ⇒ 正则放宽了；少 ⇒ 有写法没认出来）
        self.assertEqual(sorted(hit), sorted(B_SKILLS))

    def test_declared_gate_emits_effect_only_when_declared(self):
        for sid in B_SKILLS:
            sk = self.rs.skills[sid]
            off = parse_mod.resolve_element_use_ramp(sk, declared=False,
                                                     parsed=parse_mod.parse_skill(sk))
            self.assertEqual([e for e in off.effects if e.kind == "element_ramp"], [],
                             f"{sid}: 没声明能力位时**不许**产出效果（legacy / v2 逐位不变）")
            on = parse_mod.resolve_element_use_ramp(sk, declared=True,
                                                    parsed=parse_mod.parse_skill(sk))
            self.assertEqual(len([e for e in on.effects if e.kind == "element_ramp"]), 1)

    def test_resolver_is_idempotent_with_parsed(self):
        sk = self.rs.skills["skill_000270"]
        once = parse_mod.resolve_element_use_ramp(sk, declared=True, parsed=parse_mod.parse_skill(sk))
        twice = parse_mod.resolve_element_use_ramp(sk, declared=True, parsed=once)
        self.assertEqual(len([e for e in twice.effects if e.kind == "element_ramp"]), 1,
                         "同一个 parsed 上重复调用不许加出第二条")


class RuntimeTriggerTest(unittest.TestCase):
    """② 运行时报据：**真的用出别的技能之后**才累加，且**读点真的消费它**。"""

    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()
        cls.v3 = RC.get_rule_config("mobile_s4_candidate_v3")
        cls.partner = {}
        for sid in B_SKILLS:
            need_same = sid != "skill_000450"
            for pid in sorted(cls.rs.pets):
                ls = cls.rs.learnsets.get(pid)
                if not ls or sid not in ls.all_skill_ids:
                    continue
                pool = [s for s in sorted(ls.all_skill_ids) if s != sid]
                pt = next((s for s in pool if (_elem(cls.rs, s) == _elem(cls.rs, sid)) == need_same), None)
                if pt:
                    cls.partner[sid] = (pid, pt, pool)
                    break

    def _setup(self, sid, cfg=None):
        cfg = cfg or self.v3
        pid, partner, pool = self.partner[sid]
        rest = [s for s in pool if s != partner][:2]
        loadout = (sid, partner) + tuple(rest)
        team = [pid] + [x for x in FILL if x != pid][:5]
        st = env.reset(team, FILL[:6], seed=7, rs=self.rs, config=cfg,
                       loadouts={pid: loadout}, unverified_overrides=OVR)
        st.player.field_pet.energy = 99
        st.enemy.field_pet.energy = 99
        return st, partner

    def test_trigger_accumulates_and_is_read(self):
        # 270：能耗永久-2 ⇒ **读点是 `effective_skill_cost`**（真的从 6 变 4）
        st, partner = self._setup("skill_000270")
        before = env.effective_skill_cost(st.player.field_pet, self.rs.skills["skill_000270"], cfg=self.v3)
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=partner),
                               Action("charge"))
        pet = after.player.field_pet
        self.assertEqual(pet.skill_ramps.get("skill_000270"), {"cost": -2})
        self.assertEqual(pet.skill_use_elems.get("普通系"), 1)
        now = env.effective_skill_cost(pet, self.rs.skills["skill_000270"], cfg=self.v3)
        self.assertEqual((before, now), (6, 4), "「有 Δ」= 读点真的消费了这条 ramp")
        self.assertTrue([v for v in after.events if v.kind == "element_use_ramp"],
                        "要有一条可结算的 element_use_ramp 事件（审计用）")

    def test_trigger_for_power_skills(self):
        for sid, field, delta in (("skill_000343", "power", 60), ("skill_000450", "power", 30)):
            with self.subTest(sid=sid):
                st, partner = self._setup(sid)
                after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=partner),
                                       Action("charge"))
                # 同上：只看目标那一条（身上别的 B 族技能会各按自己的口径动 ✓ 那是对的）
                self.assertEqual(after.player.field_pet.skill_ramps.get(sid), {field: delta})


class ControlExperimentsTest(unittest.TestCase):
    """③ 对照实验：**触发条件不成立 ⇒ Δ 必须为 0**（本批最容易写错的地方）。"""

    @classmethod
    def setUpClass(cls):
        cls.rs = rdata.load_ruleset()
        cls.v3 = RC.get_rule_config("mobile_s4_candidate_v3")
        cls.owners = {}
        for sid in B_SKILLS:
            for pid in sorted(cls.rs.pets):
                ls = cls.rs.learnsets.get(pid)
                if ls and sid in ls.all_skill_ids:
                    cls.owners[sid] = (pid, sorted(ls.all_skill_ids))
                    break

    def _setup(self, sid, cfg=None, loadout=None):
        cfg = cfg or self.v3
        pid, ids = self.owners[sid]
        lo = loadout or tuple([sid] + [s for s in ids if s != sid][:3])
        team = [pid] + [x for x in FILL if x != pid][:5]
        try:
            st = env.reset(team, FILL[:6], seed=7, rs=self.rs, config=cfg, loadouts={pid: lo},
                           unverified_overrides=OVR)
        except (ValueError, RC.RuleConfigError):
            # legacy 那种 3v3 配置：换小场（这一批只关心记账，跟队伍规模无关）；
            # ⚠ 它也没有 `turn_order.speed_tie` 那条 UNKNOWN ⇒ 覆盖要一起去掉（否则 reset 直接拒绝）
            st = env.reset(team[:3], FILL[:3], seed=7, rs=self.rs, config=cfg,
                           loadouts={pid: lo}, unverified_overrides=[])
        st.player.field_pet.energy = 99
        st.enemy.field_pet.energy = 99
        return st

    def test_other_element_does_not_trigger_same_element_ramps(self):
        """「其他**普通系**技能」——用异系技能**不算** ✗。"""
        for sid in ("skill_000270", "skill_000343"):
            pid, ids = self.owners[sid]
            off = next((s for s in ids if s != sid and _elem(self.rs, s) != _elem(self.rs, sid)), None)
            if off is None:
                continue
            with self.subTest(sid=sid):
                st = self._setup(sid, loadout=(sid, off, ids[0], ids[1]))
                after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=off),
                                       Action("charge"))
                self.assertEqual(after.player.field_pet.skill_ramps, {},
                                 f"{sid}: 用异系「{off}」不该加（Δ 必须 0）")

    def test_same_element_does_not_trigger_other_element_ramps(self):
        """「其他**系别**技能」——用**本系**技能**不算** ✗（450 是光系）。"""
        sid = "skill_000450"
        pid, ids = self.owners[sid]
        same = next((s for s in ids if s != sid and _elem(self.rs, s) == _elem(self.rs, sid)), None)
        if same is None:
            self.skipTest("这只精灵的学习表里没有同系技能，构造不出对照")
        st = self._setup(sid, loadout=(sid, same, ids[0], ids[1]))
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=same), Action("charge"))
        # ⚠ 只看 **450 那一条**：这一手用的是光系（450 自己的系）⇒ 450 **不该**动 ✓；
        # 但身上别的 B 族技能（例如 270「其他普通系」）**该动**，所以不能断言整个字典为空 ✗。
        self.assertIsNone(after.player.field_pet.skill_ramps.get("skill_000450"),
                          "同系技能不该触发 450「其他系别」那条")

    def test_using_the_skill_itself_does_not_trigger_its_own_ramp(self):
        """**「其他」**的语义核心：本技能自己不算 ✗（三条都要成立）。"""
        for sid in B_SKILLS:
            with self.subTest(sid=sid):
                st = self._setup(sid)
                after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=sid),
                                       Action("charge"))
                pet = after.player.field_pet
                self.assertEqual(pet.skill_ramps, {}, f"{sid}: 用它自己不该加")
                # ⚠ 2026-09-30 **改钉**：记账**只对"身上真有 B 族技能"的精灵写** ——
                # 这里 loadout 里只有它自己一条 B 族技能（自己不算"其他"）⇒ 一个能驱动的都没有
                # ⇒ **连账都不写** ✓（好处：没有 B 族技能的精灵/对局**逐位不变**，golden 指纹守得住 ✓）。
                self.assertFalse(getattr(pet, "skill_use_elems", None),
                                 f"{sid}: 没有可驱动的 B 族技能时不该写账")

    def test_counter_is_written_when_the_pet_really_holds_a_ramp(self):
        """对照：身上**真有** B 族技能时，用别的技能⇒账要写、ramp 要加（与上一条互为反证）。"""
        pid, ids = self.owners["skill_000270"]
        same = next(s for s in ids if s != "skill_000270"
                    and _elem(self.rs, s) == _elem(self.rs, "skill_000270"))
        rest = [s for s in ids if s not in ("skill_000270", same)][:2]
        st = self._setup("skill_000270", loadout=("skill_000270", same) + tuple(rest))
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=same), Action("charge"))
        pet = after.player.field_pet
        self.assertEqual(pet.skill_use_elems, {"普通系": 1})
        self.assertEqual(pet.skill_ramps, {"skill_000270": {"cost": -2}})

    def test_cancelled_action_does_not_count(self):
        """这一手**没有打出去**（先被打倒）⇒ 既不记账也不累加（`happened=False`）。"""
        st = self._setup("skill_000270")
        pid, ids = self.owners["skill_000270"]
        partner = next(s for s in ids if s != "skill_000270"
                       and _elem(self.rs, s) == _elem(self.rs, "skill_000270"))
        st.player.field_pet.hp = 1        # 对手那一手必然打倒我 ⇒ 我这一手被取消
        foe = [a for a in env.legal_actions(st, self.rs, "enemy")
               if a.kind == "skill" and self.rs.skills[a.skill_id].is_attack][0]
        after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=partner), foe)
        self.assertTrue([v for v in after.events
                         if v.kind == "action_cancelled" and v.detail.get("reason") == "fainted"],
                        "这一手应当真的被取消了（否则这条对照没测到东西）")
        pet = after.player.field_pet
        self.assertEqual(pet.skill_ramps, {}, "被取消的手不许加 ramp")
        self.assertEqual(getattr(pet, "skill_use_elems", None), {}, "被取消的手不许记账")

    def test_legacy_and_v2_record_nothing(self):
        """legacy / v2 没声明能力位 ⇒ **连记账都不许有**（逐位不变）。"""
        for cfgid in ("legacy_sim_v1", "mobile_s4_candidate_v2"):
            cfg = RC.get_rule_config(cfgid)
            with self.subTest(cfgid=cfgid):
                # 这两份配置都没声明 ⇒ 逐位不变
                self.assertFalse(cfg.damage_element_use_ramp)
                st = self._setup("skill_000270", cfg=cfg)
                pid, ids = self.owners["skill_000270"]
                partner = next(s for s in ids if s != "skill_000270"
                               and _elem(self.rs, s) == _elem(self.rs, "skill_000270"))
                after = env.step_joint(st, self.rs, Action(ACTION_SKILL, skill_id=partner),
                                       # legacy 是 3v3、没有「聚能」⇒ 从合法动作里取一个（与本批无关）
                                       env.legal_actions(st, self.rs, "enemy")[0])
                pet = after.player.field_pet
                self.assertEqual(pet.skill_ramps, {}, f"{cfgid}: 不该写 skill_ramps")
                self.assertFalse(getattr(pet, "skill_use_elems", None),
                                 f"{cfgid}: 不该写 skill_use_elems")


class CapabilityReadOnceTest(unittest.TestCase):
    """④ 能力位**只有一份读数**（`coverage.declared_capabilities_of`），三处共用。"""

    def test_v3_declares_it_and_others_do_not(self):
        self.assertTrue(RC.get_rule_config("mobile_s4_candidate_v3").damage_element_use_ramp)
        self.assertFalse(RC.get_rule_config("mobile_s4_candidate_v2").damage_element_use_ramp)
        self.assertFalse(RC.get_rule_config("legacy_sim_v1").damage_element_use_ramp)

    def test_coverage_caps_carry_the_leaf(self):
        from roco_env import coverage
        self.assertTrue(coverage.declared_capabilities_of("mobile_s4_candidate_v3")["element_use_ramp"])
        self.assertFalse(coverage.declared_capabilities_of("mobile_s4_candidate_v2")["element_use_ramp"])

    def test_verdict_flips_only_under_v3(self):
        """判据：三条在 v3 下**结算得掉**，v2 / legacy 下**如实报未结算**。"""
        from roco_env import coverage
        rs = rdata.load_ruleset()
        for sid in B_SKILLS:
            sk = rs.skills[sid]
            with self.subTest(sid=sid):
                for cfgid, want in (("mobile_s4_candidate_v3", True),
                                    ("mobile_s4_candidate_v2", False),
                                    ("legacy_sim_v1", False)):
                    caps = coverage.declared_capabilities_of(cfgid)
                    v = coverage.settlement_verdict(sk, declared=caps)
                    self.assertEqual(bool(v["resolved"]), want,
                                     f"{sid} @ {cfgid}：期望 resolved={want}，实际 {v['resolved']}")


class SerializationTest(unittest.TestCase):
    """⑤ 序列化：与 `skill_ramps` 同一条纪律（**非空才进**，legacy 往返形状不变）。"""

    def test_roundtrip_and_absence_when_empty(self):
        from roco_env.schema import PetState
        pet = PetState(pet_id="pet_000001", slot=0)
        self.assertNotIn("skill_use_elems", pet.to_dict(),
                         "空的时候**不许**出现在序列化里（legacy 逐位不变）")
        pet.skill_use_elems = {"普通系": 2, "草系": 1}
        d = pet.to_dict()
        self.assertEqual(d["skill_use_elems"], {"普通系": 2, "草系": 1})
        back = PetState.from_dict(d)
        self.assertEqual(back.skill_use_elems, {"普通系": 2, "草系": 1})


if __name__ == "__main__":
    unittest.main()
