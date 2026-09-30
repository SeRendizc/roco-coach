"""「应对X：**改为** …」的**覆盖语义**（RC-401 批次十四 · 2026-09-29 task-20）。

**这个文件存在的理由**（实测缺陷，不是推演）：`应对X：改为…`（`parse._RESPOND_OVERRIDE`）
在**任何分支都不产出效果** —— 它只在"基础效果恰是敌方失去能量"时用来**压掉**基础值，
别的基础效果则把「改为」的值**静默丢弃**：

    skill_000616 剧毒（category=**状态**、`is_defense=False` ⇒ 永远进不了防御支）
    描述「敌方获得3层中毒，应对防御：改为获得8层」
    应对成功那一手照样读 `status_added{layers: 3}`，而屏幕上没有任何"这一段没生效"。

**静默错值比"没实现"更糟**，所以本文件的断言分两半：

  1. **接上了**：应对成功 ⇒ `status_added.layers` 是**改为值**（3 → 8），
     并且 `respond_override_applied` 事件里 `replaced` / `with` 两栏逐字可查；
  2. **接不上的仍然如实报不支持**：读不出来的覆盖写法（「改为敌方失去6能量」等）
     必须留在 `unsupported` 并**点名那段原文**；应对**没成功**时基础值照旧（3 层）**且**登记一条
     —— 三态都不许静默（既没生效、又没登记 = 红）。

**反证（必红）**：把 `env._apply_respond_override` 的落地那一段去掉（或让
`resolve_respond_override` 的 `declared` 永远为 False），
`test_layers_override_becomes_8_when_respond_succeeds` 立刻红（读回 3 层）。

三个分支都要覆盖（缺一个就是漏接）：**状态支**（剧毒/天火）· **攻击支**（毒囊，附带效果）·
**防御支**（描述带「改为」的防御招——用合成技能钉住，语料里暂无样本）。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as rcov            # noqa: E402
from roco_env import data as rdata               # noqa: E402
from roco_env import env as renv                 # noqa: E402
from roco_env import parse as rparse             # noqa: E402
from roco_env import rule_config as rrc          # noqa: E402
from roco_env import service as rsvc            # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

RS = rdata.load_ruleset()
V3 = "mobile_s4_candidate_v3"

#: 三个样本都用**学得到它的那一只**自己去打（纪律：不为用某条招硬换人）。
POISON = "skill_000616"      # 剧毒：敌方获得3层中毒，应对防御：改为获得8层（喵喵 pet_000001，状态）
FIRE = "skill_000390"        # 天火：敌方获得10层灼烧，应对防御：改为获得30层（圣凯布米龙 pet_000601，状态）
VENOM_SAC = "skill_000611"   # 毒囊：造成物伤，敌方获得2层中毒，应对状态：改为获得6层（地鼠 pet_000019，攻击）
DEFENSE = "skill_000286"     # 防御：用来让「应对防御」成功
ATTACK = "skill_000418"      # 甩水：水系攻击，用来让「应对防御」失败
STATUS = "skill_000272"      # 魔法增效：状态招，用来让「应对状态」成功
UNPARSED_OVERRIDE = "skill_000745"   # 恶作剧：应对防御：改为敌方失去6能量（本批**没实现**）
UNPARSED_OVERRIDE_2 = "skill_000442"  # 盐水浴：应对防御：改为技能能耗-3（本批**没实现**）

PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000417", "pet_000474",
        "pet_000001", "pet_000019", "pet_000601"]


def _battle(attacker: str, our_skill: str, enemy_skill: str):
    """造一局 v3 六宠对局：attacker 首发用 our_skill，对手首发圆号鱼用 enemy_skill。

    `loadouts` 的键是**物种 id**，且每一手都断言在该物种的学习表里
    （否则 `reset` 会以「队伍不合法」开局失败）。
    """
    # 两队都要含 attacker（首发）与 pet_000417（对手首发，带我们指定的那一手）；
    # 每方恰好 6 只且**不许重复** —— 补位池要够（`PETS` 8 只，含 attacker 也可能在里面）。
    pool = list(dict.fromkeys([attacker, "pet_000417"] + PETS))
    assert len(pool) >= 6, f"补位池不够 6 只不同的精灵：{pool}"
    team_p = pool[:6]
    team_e = list(dict.fromkeys(["pet_000417", attacker] + pool))[:6]
    assert len(set(team_p)) == len(team_p) == 6, f"player 队伍有重复：{team_p}"
    assert len(set(team_e)) == len(team_e) == 6, f"enemy 队伍有重复：{team_e}"
    loadouts = {pid: tuple(RS.candidate_moveset(pid)) for pid in set(team_p + team_e)}

    def _with(pid, must_have):
        rest = [s for s in RS.candidate_moveset(pid) if s != must_have]
        return tuple([must_have] + rest[:3])

    loadouts[attacker] = _with(attacker, our_skill)
    loadouts["pet_000417"] = _with("pet_000417", enemy_skill)
    for pid, sids in loadouts.items():
        learnable = RS.learnsets[pid].all_skill_ids
        for sid in sids:
            assert sid in learnable, f"{RS.pets[pid].name} 学不到 {RS.skills[sid].name}"

    state = renv.reset(team_p, team_e, seed=11, rs=RS, loadouts=loadouts)
    act = Action(ACTION_SKILL, skill_id=enemy_skill)
    legal = renv.legal_actions(state, RS, "enemy")
    assert act in legal, f"对手的行动不合法：{enemy_skill}（合法：{[a.label(RS) for a in legal]}）"
    return renv.step_joint(state, RS, Action(ACTION_SKILL, skill_id=our_skill), act)


def _kinds(state, *kinds):
    return [e for e in state.events if e.kind in kinds]


def _status_added(state):
    rows = _kinds(state, "status_added")
    assert len(rows) == 1, f"这一手应有且只有一条 status_added：{[r.detail for r in rows]}"
    return rows[0].detail


class RespondOverrideConfigGate(unittest.TestCase):
    """能力位：**配置声明了才产出结构** —— 这是 legacy / v2 逐位不变的根据。"""

    def test_capability_is_declared_only_in_v3(self):
        self.assertTrue(rrc.get_rule_config(V3).energy_respond_override)
        self.assertFalse(rrc.get_rule_config("legacy_sim_v1").energy_respond_override)
        self.assertFalse(rrc.get_rule_config("mobile_s4_candidate_v2").energy_respond_override)

    def test_not_declared_produces_nothing(self):
        """`declared=False` ⇒ `respond_override is None`，连结构都没有（逐位不变的强条件）。"""
        skill = RS.skills[POISON]
        self.assertIsNone(rparse.resolve_respond_override(skill, declared=False).respond_override)
        self.assertIsNotNone(rparse.resolve_respond_override(skill, declared=True).respond_override)

    def test_declared_parses_the_layers_override(self):
        ov = rparse.resolve_respond_override(RS.skills[POISON], declared=True).respond_override
        self.assertEqual(ov["mode"], "layers")
        self.assertEqual(ov["layers"], 8)
        self.assertEqual(ov["respond_to"], "防御")
        # 被覆盖的是**基础那一条**（证据原文逐字），改为值是**派生**出来的那一条。
        self.assertEqual(ov["replaces_evidence"], "敌方获得3层中毒")
        self.assertEqual([e.value["layers"] for e in ov["effects"]], [8])
        self.assertEqual(ov["leftover"], "")


class RespondOverrideApplied(unittest.TestCase):
    """① 接上了：应对成功 ⇒ 用**改为值**替换基础值（不是追加）。"""

    def setUp(self):
        self._backup = os.environ.get(rrc.ENV_VAR)
        os.environ[rrc.ENV_VAR] = V3
        rrc.clear_cache()

    def tearDown(self):
        if self._backup is None:
            os.environ.pop(rrc.ENV_VAR, None)
        else:
            os.environ[rrc.ENV_VAR] = self._backup
        rrc.clear_cache()

    def test_layers_override_becomes_8_when_respond_succeeds(self):
        """★ 任务验收读数：同一手里 `status_added.layers` **3 → 8**。"""
        after = _battle("pet_000001", POISON, DEFENSE)
        detail = _status_added(after)
        self.assertEqual(detail["status"], "中毒")
        self.assertEqual(detail["layers"], 8, f"改为值没生效（读回 {detail['layers']}）")
        # 事件里逐字可查：替换了什么、换成什么（不是"追加"）
        applied = _kinds(after, "respond_override_applied")
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0].detail["replaced"]["value"]["layers"], 3)
        self.assertEqual(applied[0].detail["with"][0]["value"]["layers"], 8)
        self.assertEqual(applied[0].detail["evidence"], "应对防御：改为获得8层")

    def test_burn_override_reaches_the_local_rule(self):
        """天火 10 → 30：覆盖值真的送进状态层。

        ⚠ 2026-09-29（task-20 批四）**改钉**：这条用例原来断言
        `layers_total == 10` + `capped_from == 30`（被本地规则的全局上限夹住）。
        人类随后逐字回答「**为什么不行，针对这一个技能改一下不行吗？**」⇒
        「应对X：改为获得N层」是**这一条技能明写的数值**，**允许突破**全局 `max_layers`。
        现在：`layers_total == 30` + `cap_override`；全局上限**本身没动**（`max_layers` 仍如实报 10），
        普通路径照旧被夹 —— 那条反证在 `RespondOverrideBreaksLayerCap.test_plain_30_layers_is_still_capped`。
        """
        after = _battle("pet_000601", FIRE, DEFENSE)
        detail = _status_added(after)
        self.assertEqual(detail["status"], "灼烧")
        self.assertEqual(detail["layers"], 30)       # 这一次施加的量
        self.assertEqual(detail["max_layers"], 10)   # 全局上限的值仍如实报出来
        self.assertEqual(detail["layers_total"], 30)  # 覆盖值不再被夹
        self.assertIn("respond_override", str(detail.get("cap_override") or ""))

    def test_attack_branch_also_lands_the_override(self):
        """攻击支（毒囊「造成物伤，敌方获得2层中毒，应对状态：改为获得6层」）必须同样接上。"""
        after = _battle("pet_000019", VENOM_SAC, STATUS)
        self.assertTrue(_kinds(after, "damage"), "前提没成立：这一手是攻击招，应该打出伤害")
        detail = _status_added(after)
        self.assertEqual(detail["status"], "中毒")
        self.assertEqual(detail["layers"], 6, f"攻击支的覆盖没生效（读回 {detail['layers']}）")

    def test_defense_branch_also_lands_the_override(self):
        """防御支：语料里暂无「防御招 + 改为」样本 ⇒ 用**合成技能**钉住这一支（改钉不删）。"""
        import dataclasses
        from roco_env import effects as fx

        base = RS.skills[DEFENSE]
        synthetic = dataclasses.replace(
            base,
            desc="减伤70%，敌方获得2层中毒，应对攻击：改为获得5层。",
            category="防御",
        )
        self.assertTrue(fx.parse_defense_reduction(synthetic), "前提没成立：合成技能没被读成防御招")
        parsed = rparse.resolve_respond_override(synthetic, declared=True)
        self.assertEqual((parsed.respond_override or {}).get("layers"), 5)
        # 把这一支真的跑一遍：`_apply_respond_override` 在应对成功时替换、失败时登记。
        team = list(dict.fromkeys(["pet_000190", "pet_000001"] + PETS))[:6]
        self.assertEqual(len(team), 6, "v3 要求每方恰好 6 只")
        state = renv.reset(
            team, list(reversed(team)),
            seed=11, rs=RS,
            loadouts={pid: tuple(RS.candidate_moveset(pid)) for pid in team},
        )
        cfg = rrc.get_rule_config()
        out, landed = renv._apply_respond_override(
            state, RS, "player", synthetic, parsed, succeeded=True, cfg=cfg)
        self.assertTrue(landed)
        self.assertEqual([e.value["layers"] for e in out.effects], [5])


class RespondOverrideStillUnsupported(unittest.TestCase):
    """② 反证：**没实现**的覆盖写法与**没成功**的应对都必须如实登记，一条都不许静默。"""

    def setUp(self):
        self._backup = os.environ.get(rrc.ENV_VAR)
        os.environ[rrc.ENV_VAR] = V3
        rrc.clear_cache()

    def tearDown(self):
        if self._backup is None:
            os.environ.pop(rrc.ENV_VAR, None)
        else:
            os.environ[rrc.ENV_VAR] = self._backup
        rrc.clear_cache()

    def test_base_value_stays_and_is_registered_when_respond_fails(self):
        """应对**没成功**：基础值照旧（3 层），并且登记一条（不许静默）。"""
        after = _battle("pet_000001", POISON, ATTACK)      # 对手用水系攻击 ⇒ 应对防御失败
        self.assertFalse(_kinds(after, "respond_override_applied"))
        detail = _status_added(after)
        self.assertEqual(detail["layers"], 3, "应对没成功却把「改为」的值算上了")
        skipped = _kinds(after, "respond_override_skipped")
        self.assertEqual(len(skipped), 1, "应对失败时既没生效也没记事件（静默）")
        self.assertEqual(skipped[0].detail["reason"], "respond_failed")
        registered = [u for u in after.unsupported if "应对覆盖子句" in str(u.get("what", ""))]
        self.assertTrue(registered, f"应对失败时没有如实登记：{after.unsupported}")
        self.assertIn("应对防御：改为获得8层", str(registered[0].get("detail", "")))

    def test_unreadable_override_is_named_not_guessed(self):
        """读不出来的覆盖写法 ⇒ `leftover` 点名原文，`effects` 为空（绝不猜一个数）。"""
        for sid, body in ((UNPARSED_OVERRIDE, "改为敌方失去6能量"),
                          (UNPARSED_OVERRIDE_2, "改为技能能耗-3")):
            ov = rparse.resolve_respond_override(RS.skills[sid], declared=True).respond_override
            self.assertIsNotNone(ov, f"{sid} 应认出这里有一条覆盖子句")
            self.assertEqual(ov["effects"], [], f"{sid} 不该猜出效果")
            self.assertTrue(ov["leftover"], f"{sid} 应留残余说明")
            self.assertIn(body, ov["leftover"])

    def test_unreadable_override_keeps_the_verdict_false(self):
        """判据：没实现的写法**不许**被算成已结算（点名的就是那一段）。"""
        caps = rcov.declared_capabilities_of(V3)
        for sid in (UNPARSED_OVERRIDE, UNPARSED_OVERRIDE_2):
            verdict = rcov.settlement_verdict(RS.skills[sid], declared=caps)
            self.assertFalse(verdict["resolved"], f"{sid} 被谎报成已结算")
            self.assertTrue(any("应对：" in str(x) for x in verdict["unsettled"]),
                            f"{sid} 没有点名那段应对子句：{verdict['unsettled']}")

    def test_implemented_three_flip_only_under_v3(self):
        """本批三条：v3 判已结算、legacy 判未结算（能力位门禁的判据面证据）。"""
        caps3, capsl = rcov.declared_capabilities_of(V3), rcov.declared_capabilities_of("legacy_sim_v1")
        for sid in (POISON, FIRE, VENOM_SAC):
            self.assertTrue(rcov.settlement_verdict(RS.skills[sid], declared=caps3)["resolved"], sid)
            self.assertFalse(rcov.settlement_verdict(RS.skills[sid], declared=capsl)["resolved"], sid)


class LegacyStaysBitIdentical(unittest.TestCase):
    """③ `declared=False` 的老路径：解析层**连结构都不产出** ⇒ 未认领片段逐字不变。"""

    def test_unclaimed_spans_unchanged_without_the_capability(self):
        for sid in (POISON, FIRE, VENOM_SAC):
            skill = RS.skills[sid]
            without = rparse.unclaimed_mechanic_spans(skill, parsed=rparse.parse_skill(skill))
            declared = rparse.resolve_respond_override(skill, declared=True)
            with_it = rparse.unclaimed_mechanic_spans(skill, parsed=declared)
            self.assertTrue(without, f"{sid} 的前提不成立：未声明时就该有未认领片段")
            self.assertTrue(all("应对" in s for s in without), without)
            self.assertEqual(with_it, [], f"{sid} 声明后仍留着未认领片段：{with_it}")

    def test_parse_shape_unchanged_without_the_capability(self):
        """未声明时：`effects` 与 `unparsed` 与"没这个函数"时逐位相同。"""
        skill = RS.skills[POISON]
        base = rparse.parse_skill(skill)
        after = rparse.resolve_respond_override(skill, declared=False, parsed=base)
        self.assertEqual([(e.kind, e.value) for e in after.effects],
                         [("foe_status", {"status": "中毒", "layers": 3})])
        self.assertEqual(after.unparsed, [])
        self.assertIsNone(after.respond_override)


class RespondHitCountOverride(unittest.TestCase):
    """批二（RC-401 批次十五）：**连击数覆盖** —— 都走同一个能力位，加 `mode="hits"`。

    实测三条（都在前 100 只的技能并集里、都是攻击招、都是「应对状态」）：
      · `skill_000661 散手`     「造成物伤，2连击，应对状态：本技能改为6连击。」  → 成功 6 / 失败 2
      · `skill_000256 连续爪击` 「造成物伤，2连击，应对状态：本次技能连击数翻倍。」→ 成功 4 / 失败 2
      · `skill_000257 追打`     「造成魔伤，1连击，应对状态：本技能变为3连击。」  → 成功 3 / 失败 1
    ⚠ 这三条的**子句里没有「改为」紧跟冒号**（`散手` 是「本技能改为6连击」、`追打` 是「变为」、
    `连续爪击` 是「连击数翻倍」）⇒ 只挂「应对X：改为…」那一条正则**认不到**（实测全 None）。
    """

    DUCK = "skill_000661"       # 散手（绝对值 2 → 6）
    CLAW = "skill_000256"       # 连续爪击（倍数 2 → 4）
    PURSUIT = "skill_000257"    # 追打（绝对值 1 → 3）

    def setUp(self):
        self._backup = os.environ.get(rrc.ENV_VAR)
        os.environ[rrc.ENV_VAR] = V3
        rrc.clear_cache()

    def tearDown(self):
        if self._backup is None:
            os.environ.pop(rrc.ENV_VAR, None)
        else:
            os.environ[rrc.ENV_VAR] = self._backup
        rrc.clear_cache()

    def _owner(self, sid):
        for pid, ls in RS.learnsets.items():
            if sid in ls.all_skill_ids:
                return pid
        raise AssertionError(f"没有精灵学得到 {sid}")

    def _hits_on(self, sid):
        """应对**状态**成功：对手用状态招「魔法增效」。"""
        after = _battle(self._owner(sid), sid, STATUS)
        damages = [e for e in after.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertEqual(len(damages), 1, f"这一手应只打出一条伤害：{[e.detail for e in damages]}")
        return damages[0].detail.get("hits")

    def _hits_off(self, sid):
        """应对**状态**失败：对手用攻击招「甩水」。"""
        after = _battle(self._owner(sid), sid, ATTACK)
        skipped = _kinds(after, "respond_override_skipped")
        self.assertTrue(skipped, "前提没成立：应对该失败")
        damages = [e for e in after.events if e.kind == "damage" and e.detail.get("side") == "player"]
        return damages[0].detail.get("hits")

    def test_parse_shapes(self):
        cases = {self.DUCK: (6, None), self.CLAW: (4, 2), self.PURSUIT: (3, None)}
        for sid, (hits, mult) in cases.items():
            skill = RS.skills[sid]
            _base, parsed = rparse.resolve_hit_count(skill, declared=True)
            parsed = rparse.resolve_respond_override(skill, declared=True, parsed=parsed)
            ov = parsed.respond_override or {}
            self.assertEqual(ov.get("mode"), "hits", f"{sid} 没读成连击覆盖")
            self.assertEqual(ov.get("hits"), hits, f"{sid} 覆盖值")
            self.assertEqual(ov.get("hit_multiplier"), mult, f"{sid} 倍数")
            # 条件化实现之后「动态连击数」那一条**必须摘掉**（不摘 = 既结算又报未实现）
            self.assertEqual(parsed.unparsed, [], f"{sid} 仍留着动态连击标记：{parsed.unparsed}")
            self.assertEqual(rparse.unclaimed_mechanic_spans(skill, parsed=parsed), [],
                             f"{sid} 仍留着未认领的连击片段")

    def test_absolute_override(self):
        self.assertEqual(self._hits_on(self.DUCK), 6, "散手 应对成功该按 6 连击结算")
        self.assertEqual(self._hits_off(self.DUCK), 2, "散手 应对失败该按基础的 2 连击结算")

    def test_multiplier_override(self):
        self.assertEqual(self._hits_on(self.CLAW), 4, "连续爪击 应对成功该按 2×2=4 连击结算")
        self.assertEqual(self._hits_off(self.CLAW), 2, "连续爪击 应对失败该按基础的 2 连击结算")

    def test_one_hit_base_override(self):
        """基础 1 连击时，`damage` 事件按老口径**不带 `hits` 键**（只在 >1 时才带）。"""
        self.assertEqual(self._hits_on(self.PURSUIT), 3, "追打 应对成功该按 3 连击结算")
        self.assertIsNone(self._hits_off(self.PURSUIT), "追打 应对失败该按 1 次结算（不带 hits 键）")

    def test_static_one_hit_is_credited_under_v3(self):
        """**改钉**：描述里明写「1连击」时，N=1 也算已结算（此前被判未结算 = 假免责）。

        实测波及面：全库含「1连击」10 条，判据翻正的**恰好 3 条**
        （`追打` 有应对覆盖；`落石` / `音波弹` 是「造成X伤，1连击。」的纯单体一击）。
        """
        caps3 = rcov.declared_capabilities_of(V3)
        capsl = rcov.declared_capabilities_of("legacy_sim_v1")
        for sid in (self.PURSUIT, "skill_000514", "skill_000304"):
            self.assertTrue(rcov.settlement_verdict(RS.skills[sid], declared=caps3)["resolved"],
                            f"{sid} 明写 1连击却没被认领")
            self.assertFalse(rcov.settlement_verdict(RS.skills[sid], declared=capsl)["resolved"],
                             f"{sid} 在 legacy（未声明）下不该翻正")


class RespondHitCountStillUnsupported(unittest.TestCase):
    """反证：连击覆盖**认不出的写法**照样点名，绝不猜。"""

    def test_unreadable_hits_phrase_stays_leftover(self):
        """「若先于敌方攻击，改为3连击」（`疾风刺` 那类）**不是应对子句** ⇒ 本能力位不许认领它。"""
        import re as _re
        # 语料实测：`skill_000689 疾风刺` 的「改为3连击」挂在**先手条件**上，不是「应对X」。
        sid = "skill_000689"
        parsed = rparse.parse_skill(RS.skills[sid])
        parsed = rparse.resolve_respond_override(RS.skills[sid], declared=True, parsed=parsed)
        self.assertIsNone(parsed.respond_override,
                          f"{sid} 的「改为3连击」不该被当成本能力位的覆盖（它不是应对子句）")
        self.assertTrue(any("动态连击" in str(x) for x in parsed.unparsed),
                        f"{sid} 的动态连击标记不该被摘掉：{parsed.unparsed}")
        self.assertTrue(_re.search(r"改为\s*3\s*连击", RS.skills[sid].desc or ""))


class ClaimsSurviveLaterResolvers(unittest.TestCase):
    """批三（2026-09-29 task-20）：**后跑的解析器不许把先跑的认领效果盖掉**。

    缺陷（实测，不是推演）：`parse.resolve_hit_count` 内部 `parse_skill(skill)` **重新解析**
    并**整体覆盖**调用方手上的 `parsed` ⇒ `coverage.settlement_verdict` 里排在它**前面**的
    五个解析器（号位/传动 · 先手条件 · 动态能耗 · 对手换人条件 · 每次使用后永久±N · 挨打永久±N）
    刚补上的认领效果被悄悄丢掉 ⇒ 判据把**引擎真的在结算**的机制报成未实现（**假免责**）。

    实测代价（427 条里 11 条）：`毒液渗透` 的「每有1层中毒效果→能耗-1」（批次九就实现了）·
    `重击/水炮/吹火`（每次使用后永久±N）· `离子震荡/械斗`（号位+传动）· `扇风`（先手条件）·
    `针刺射击/当头棒喝/回旋踢`（对手换人条件）· `岩土暴击`（挨打永久±N）。
    """

    CASES = {
        # skill_id: (名字, 判据里被点名的机制族)
        "skill_000612": ("毒液渗透", "层数驱动"),
        "skill_000264": ("重击", "每次使用后"),
        "skill_000421": ("水炮", "每次使用后"),
        "skill_000381": ("吹火", "每次使用后"),
        "skill_000477": ("离子震荡", "号位"),
        "skill_000468": ("械斗", "传动"),
        "skill_000687": ("扇风", "先手"),
        "skill_000374": ("针刺射击", "换人"),
        "skill_000316": ("当头棒喝", "换人"),
        "skill_000685": ("回旋踢", "换人"),
        "skill_000500": ("岩土暴击", "挨打"),
    }

    def test_prior_claims_survive_a_later_resolver(self):
        """`resolve_hit_count(parsed=…)` 不许把先补上的 `per_layer_cost` 认领覆盖掉。"""
        skill = RS.skills["skill_000612"]
        parsed = rparse.resolve_per_layer_cost(skill, declared=True,
                                               parsed=rparse.parse_skill(skill))
        self.assertTrue([e for e in parsed.effects if e.kind == "per_layer_cost"],
                        "前提不成立：声明后该补上 per_layer_cost 认领")
        _hits, after = rparse.resolve_hit_count(skill, declared=True, parsed=parsed)
        self.assertTrue([e for e in after.effects if e.kind == "per_layer_cost"],
                        "resolve_hit_count 把先前的认领覆盖掉了（传 parsed= 就是为了防这个）")
        self.assertEqual(rparse.unclaimed_mechanic_spans(skill, parsed=after), [])

    def test_hit_count_claim_is_idempotent(self):
        """`parsed=` 传进来时可能已带标记 ⇒ 重复调用不许叠两条。"""
        skill = RS.skills["skill_000304"]          # 音波弹：造成魔伤，1连击。
        _h1, first = rparse.resolve_hit_count(skill, declared=True, parsed=rparse.parse_skill(skill))
        _h2, second = rparse.resolve_hit_count(skill, declared=True, parsed=first)
        self.assertEqual(sum(1 for e in second.effects if e.kind == "hit_count"), 1,
                         f"hit_count 认领被叠了：{[(e.kind, e.evidence) for e in second.effects]}")

    def test_all_eleven_are_credited_under_v3_only(self):
        caps3 = rcov.declared_capabilities_of(V3)
        capsl = rcov.declared_capabilities_of("legacy_sim_v1")
        for sid, (name, _family) in self.CASES.items():
            v3 = rcov.settlement_verdict(RS.skills[sid], declared=caps3)
            legacy = rcov.settlement_verdict(RS.skills[sid], declared=capsl)
            self.assertTrue(v3["resolved"], f"{sid} {name} 仍被判未结算：{v3['unsettled']}")
            self.assertFalse(legacy["resolved"],
                             f"{sid} {name} 在 legacy（未声明）下不该翻正：{legacy['unsettled']}")

    def test_other_layer_shapes_are_still_named(self):
        """**反证**：判据只放行了"已实现"的层数形状，别的层数形状照旧点名。

        ⚠ 2026-09-29（task-20 批四）**改钉**：这里原来还列着 `skill_000825 天体吸积`
        （「敌方每有1层印记，本次攻击威力+20」）。批四把**这一个形状真的实现了**
        （`damage.per_layer_boost`，见 `PerLayerBoost` 那一组用例）⇒ 它**应该**翻正，
        从这份"必须保持 false"的清单里**移出**。其余四条仍然没实现，继续点名 ✓
        """
        caps3 = rcov.declared_capabilities_of(V3)
        others = {
            "skill_000624": "腐化",      # 敌方每有1层中毒效果，敌方获得双攻-30%
            "skill_000626": "不可接触",  # 敌方每有1层中毒效果，本技能减伤+10%
            "skill_000808_hits_src": "",  # 占位：多维击打在批四已翻正，见下面单独的反证
            "skill_000618": "落井下毒",  # 使敌方精灵减益的层数翻倍
            "skill_000731": "月光合奏",  # 双方携带的所有精灵每有1层萌化（萌化未实现 = C 堆）
        }
        others.pop("skill_000808_hits_src")
        for sid, name in others.items():
            verdict = rcov.settlement_verdict(RS.skills[sid], declared=caps3)
            self.assertFalse(verdict["resolved"], f"{sid} {name} 被谎报成已结算")
            self.assertTrue(any("层数驱动" in str(x) or "萌化" in str(x) for x in verdict["unsettled"]),
                            f"{sid} {name} 没有点名那一段：{verdict['unsettled']}")


class PerLayerBoost(unittest.TestCase):
    """批四（RC-401 批次十六）：「敌方每有 N 层<来源>，本次技能威力/连击数 +M」。

    走**新能力位** `damage.per_layer_boost`；只认三种来源（中毒/印记/星陨印记），
    `月光合奏` 的「双方携带的所有精灵每有1层萌化」**不认**（萌化未实现，C 堆）。
    """

    def setUp(self):
        self._backup = os.environ.get(rrc.ENV_VAR)
        os.environ[rrc.ENV_VAR] = V3
        rrc.clear_cache()

    def tearDown(self):
        if self._backup is None:
            os.environ.pop(rrc.ENV_VAR, None)
        else:
            os.environ[rrc.ENV_VAR] = self._backup
        rrc.clear_cache()

    def _battle(self, attacker, our, enemy_skill, *, poison=0, marks=None):
        team = list(dict.fromkeys([attacker, "pet_000417"] + PETS))[:6]
        other = list(dict.fromkeys(["pet_000417", attacker] + PETS))[:6]
        loadouts = {p: tuple(RS.candidate_moveset(p)) for p in set(team + other)}
        for pid, sid in ((attacker, our), ("pet_000417", enemy_skill)):
            loadouts[pid] = tuple([sid] + [s for s in RS.candidate_moveset(pid) if s != sid][:3])
            for s in loadouts[pid]:
                assert s in RS.learnsets[pid].all_skill_ids, f"{RS.pets[pid].name} 学不到 {RS.skills[s].name}"
        state = renv.reset(team, other, seed=11, rs=RS, loadouts=loadouts)
        foe = state.enemy.field_pet
        if poison:
            foe.statuses["中毒"] = {"layers": poison, "turns_left": 5}
        if marks:
            foe.marks.update(marks)
        a, b = Action(ACTION_SKILL, skill_id=our), Action(ACTION_SKILL, skill_id=enemy_skill)
        assert a in renv.legal_actions(state, RS, "player")
        assert b in renv.legal_actions(state, RS, "enemy")
        return renv.step_joint(state, RS, a, b)

    def _owner(self, sid):
        return next(pid for pid, ls in RS.learnsets.items() if sid in ls.all_skill_ids)

    def _boost(self, state):
        rows = _kinds(state, "per_layer_boost_applied", "per_layer_boost_skipped")
        self.assertEqual(len(rows), 1, f"应有且只有一条加成事件：{[e.detail for e in rows]}")
        return rows[0]

    def _player_damage(self, state):
        rows = [e for e in state.events if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertEqual(len(rows), 1)
        return rows[0].detail

    def test_poison_layers_boost_power(self):
        """鸩毒：敌方 4 层中毒 ⇒ 威力 +40（75 → 115）。"""
        sid = "skill_000623"
        off = self._battle(self._owner(sid), sid, DEFENSE)
        self.assertEqual(self._boost(off).kind, "per_layer_boost_skipped")
        self.assertEqual(self._boost(off).detail["reason"], "no_layers")
        base_power = self._player_damage(off)["power_used"]

        on = self._battle(self._owner(sid), sid, DEFENSE, poison=4)
        ev = self._boost(on)
        self.assertEqual(ev.kind, "per_layer_boost_applied")
        self.assertEqual((ev.detail["layers"], ev.detail["delta"]), (4, 40))
        self.assertAlmostEqual(self._player_damage(on)["power_used"], base_power + 40)

    def test_mark_layers_boost_power(self):
        """天体吸积：敌方印记**合计** 5 层 ⇒ 威力 +100（20 → 120）。"""
        sid = "skill_000825"
        on = self._battle(self._owner(sid), sid, DEFENSE, marks={"星陨印记": 3, "风起印记": 2})
        ev = self._boost(on)
        self.assertEqual((ev.detail["field"], ev.detail["source"]), ("power", "印记"))
        self.assertEqual((ev.detail["layers"], ev.detail["delta"]), (5, 100))
        self.assertAlmostEqual(self._player_damage(on)["power_used"], 120.0)

    def test_named_mark_layers_boost_hits(self):
        """多维击打：星陨印记 4 层 ⇒ 连击数 1+4 = 5。"""
        sid = "skill_000808"
        on = self._battle(self._owner(sid), sid, DEFENSE, marks={"星陨印记": 4})
        ev = self._boost(on)
        self.assertEqual((ev.detail["field"], ev.detail["source"]), ("hits", "星陨印记"))
        self.assertEqual(self._player_damage(on)["hits"], 5)

    def test_moonlight_chorus_is_not_claimed(self):
        """**反证**：`月光合奏` 的「每有1层萌化」不许被这个能力位认领（萌化未实现）。"""
        sid = "skill_000731"
        parsed = rparse.resolve_per_layer_boost(RS.skills[sid], declared=True,
                                                parsed=rparse.parse_skill(RS.skills[sid]))
        self.assertIsNone(parsed.per_layer_boost, "萌化那一段被误认领了")
        caps3 = rcov.declared_capabilities_of(V3)
        self.assertFalse(rcov.settlement_verdict(RS.skills[sid], declared=caps3)["resolved"])

    def test_lie_in_wait_stays_false_and_named(self):
        """鸩毒还有一条**读不出来**的「应对状态：改为本次威力+40」⇒ 整条仍 false 且点名。"""
        caps3 = rcov.declared_capabilities_of(V3)
        verdict = rcov.settlement_verdict(RS.skills["skill_000623"], declared=caps3)
        self.assertFalse(verdict["resolved"], "鸩毒被谎报成已结算")
        self.assertTrue(any("应对" in str(x) for x in verdict["unsettled"]), verdict["unsettled"])

    def test_tier_and_verdict_agree(self):
        """**同一条技能两处口径不许打架**（档位 SIMULATABLE ⇔ 判据 resolved）。"""
        svc = rsvc.RocoService()
        for sid in ("skill_000623", "skill_000825", "skill_000808", "skill_000616",
                    "skill_000612", "skill_000731"):
            _st, env = svc.rules_query({"ruleset_id": "roco-world-s4-2026-09-10",
                                        "state_version": 0,
                                        "query": {"kind": "skill", "skill_id": sid, "with_tier": True}})
            row = env["result"]
            resolved = (row.get("mechanics") or {}).get("resolved")
            simulatable = row.get("support_tier") == rcov.SUPPORT_SIMULATABLE_UNVERIFIED
            self.assertEqual(resolved is True, simulatable,
                             f"{sid} {row.get('name')}：档位={row.get('support_tier')}、"
                             f"判据 resolved={resolved} —— 两处打架")


class RespondOverrideBreaksLayerCap(unittest.TestCase):
    """人类 2026-09-29 逐字：「为什么不行，**针对这一个技能改一下**不行吗？」

    「应对X：改为获得N层」是**这一条技能明写的数值** ⇒ 允许突破本地规则的**全局**上限；
    **普通路径照旧被夹住**（反证在下面第二条）。
    """

    def setUp(self):
        self._backup = os.environ.get(rrc.ENV_VAR)
        os.environ[rrc.ENV_VAR] = V3
        rrc.clear_cache()

    def tearDown(self):
        if self._backup is None:
            os.environ.pop(rrc.ENV_VAR, None)
        else:
            os.environ[rrc.ENV_VAR] = self._backup
        rrc.clear_cache()

    def test_respond_override_reaches_30_burn_layers(self):
        """天火 应对成功 ⇒ 灼烧真的到 30 层（v3 的全局上限是 10）。"""
        after = _battle("pet_000601", FIRE, DEFENSE)
        detail = _status_added(after)
        self.assertEqual(detail["layers_total"], 30, f"没突破上限：{detail}")
        self.assertEqual(detail["max_layers"], 10, "全局上限的值仍要如实报出来")
        self.assertIn("respond_override", str(detail.get("cap_override") or ""))
        self.assertGreaterEqual(after.enemy.field_pet.statuses["灼烧"]["layers"], 15)

    def test_plain_30_layers_is_still_capped(self):
        """**反证**：**不是** override 来源的 30 层灼烧仍被夹到 10。"""
        team = list(dict.fromkeys(["pet_000601"] + PETS))[:6]
        state = renv.reset(team, list(reversed(team)), seed=11, rs=RS,
                           loadouts={p: tuple(RS.candidate_moveset(p)) for p in team})

        class _Eff:
            kind = "foe_status"
            target = "foe"
            term = ""
            value = {"status": "灼烧", "layers": 30}
            evidence = "合成：敌方获得30层灼烧（没有 cap_override）"

        renv._apply_effect_batch(state, RS, "player", RS.skills[FIRE],
                                 type("P", (), {"effects": [_Eff()]})(),
                                 rrc.get_rule_config())
        detail = [e for e in state.events if e.kind == "status_added"][-1].detail
        self.assertEqual(detail["layers_total"], 10, f"普通路径也突破了上限：{detail}")
        self.assertEqual(detail["capped_from"], 30)
        self.assertEqual(state.enemy.field_pet.statuses["灼烧"]["layers"], 10)


if __name__ == "__main__":
    unittest.main()
