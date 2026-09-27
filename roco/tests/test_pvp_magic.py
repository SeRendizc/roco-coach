"""PVP 魔法「愿力强化 / 愿力冲击」的判据（2026-09-23）。

人类 2026-09-23 口述登记了整套口径（台账 `EV-PVP-WISH-POWER-UP`，RECORDED_IN_GAME）：
占一次行动、每局两次、冷却三回合、目标是自己场上那只；把它的**第一个技能**换成
「愿力冲击」（属性 = 该精灵的愿力属性、能耗 2、威力 80、物攻/魔攻取更高的那一项、
对「应对状态」额外 150%）；**再用一次「愿力强化」解除，且不消耗次数、开始冷却**。

每条判据都带必红方向（反证写在同一用例里）。运行：
    cd roco && PYTHONPATH=src python3 -m unittest tests.test_pvp_magic
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from dataclasses import replace as dc_replace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import effects as fx            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env.schema import ACTION_MAGIC, Action   # noqa: E402
from roco_env.service import RocoService          # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MAGIC_ARTIFACT = os.path.join(ROOT, "data", "roco", "derived", "pvp-magic.json")
MODES = os.path.join(ROOT, "data", "roco", "battle-modes.json")

RS = rdata.load_ruleset()
TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
TEAM_B = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]
IDS_A = [RS.pets_by_name(n)[0].pet_id for n in TEAM_A]
IDS_B = [RS.pets_by_name(n)[0].pet_id for n in TEAM_B]
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
WISH = "wish_power_up"


def _v3() -> rc.RuleConfig:
    rc.clear_cache()
    return rc.load_config(V3)


def _overrides() -> list:
    return [{
        "path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS",
        "reason": "同速平手裁决未核验（MC-E05 未录制），按已登记的工程权宜走",
        "microcase_id": "MC-E05",
    }]


def _state(cfg: rc.RuleConfig | None = None):
    return renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=cfg or _v3(),
                      unverified_overrides=_overrides())


def _magic_registry_row():
    """从**登记表**与**派生产物**读这一条魔法的口径（判据里不写 3 这个字面量）。

    · `data/roco/battle-modes.json` 的 `policies.magic_policy.registered[]` 记的是**人类口径**
      （每局几次、冷却几回合、能不能解除），行里用 `kind` 做名字；
    · `data/roco/derived/pvp-magic.json` 是生成器产物，把 `magic_id` 与上面那条对上；
    两处都点名同一条，才说明「判据读的是声明」而不是「跟我记的一样」。
    """
    with open(MODES, encoding="utf-8") as handle:
        modes = json.load(handle)
    row = None
    for mode in modes["modes"]:
        policy = (mode.get("policies") or {}).get("magic_policy") or {}
        for item in policy.get("registered") or []:
            if item.get("kind") == "愿力强化":
                row = item
    if row is None:
        raise AssertionError("登记表里没有愿力强化那一条")
    with open(MAGIC_ARTIFACT, encoding="utf-8") as handle:
        derived = json.load(handle)
    if derived["magic"]["magic_id"] != WISH:
        raise AssertionError(f"派生产物的 magic_id 不是 {WISH}：{derived['magic']['magic_id']}")
    if derived["magic"]["cooldown_turns"] != row["cooldown_turns"]:
        raise AssertionError("派生产物与登记表的冷却回合数不一致")
    return row


def _magic_actions(state, side: str = "player"):
    return [a for a in renv.legal_actions(state, RS, side, _v3()) if a.kind == ACTION_MAGIC]


def _play(state, side: str, action):
    """把一方的一手真的走一遍（另一侧让引擎按合法动作随便挑一个）。"""
    foe_side = "enemy" if side == "player" else "player"
    legal = renv.legal_actions(state, RS, foe_side, _v3())
    if not legal:                       # 对手没有合法动作时这一手走不动，直接返回
        return
    foe_action = legal[0]
    renv.step_joint(state, RS,
                    action if side == "player" else foe_action,
                    foe_action if side == "player" else action)


def _use_free(state, action, side: str = "player"):
    """把一次**自由动作**（PVP 魔法 / 背包物品）真的走一遍。

    2026-09-25（人类口径）：「愿力强化不占行动，自由动作」⇒ 它**不**经过 `step_joint`
    （那条路会让回合照走）。自由动作走 `env.step_free`：回合不变、对手这一手还没结算。
    """
    return renv.step_free(state, RS, side, action)


class TestArtifact(unittest.TestCase):
    """派生产物本身：数值只许来自登记表，id 不许与冻结技能表碰撞。"""

    def setUp(self):
        rc.clear_cache()
        with open(MAGIC_ARTIFACT, encoding="utf-8") as fh:
            self.doc = json.load(fh)
        with open(MODES, encoding="utf-8") as fh:
            self.modes = json.load(fh)

    def _registered(self):
        mode = next(m for m in self.modes["modes"] if m["id"] == "pvp-standard-six-pet")
        return mode["policies"]["magic_policy"]["registered"][0]

    def test_artifact_matches_registered_policy(self):
        reg = self._registered()
        magic = self.doc["magic"]
        self.assertEqual(magic["magic_id"], WISH)
        # 2026-09-25：口径从「占一次行动」改成「**不占行动**（自由动作）」——
        # 这条判据只钉「派生产物 == 登记表」，具体取值由登记表说了算（别在判据里写死方向）。
        self.assertEqual(magic["occupies_action"], reg["occupies_action"])
        self.assertIs(reg["occupies_action"], False,
                      "登记表里愿力强化那一条必须是「不占行动」= false（人类 2026-09-25 口径）")
        self.assertEqual(magic["per_battle_uses"], reg["per_battle_uses"])
        self.assertEqual(magic["cooldown_turns"], reg["cooldown_turns"])
        self.assertEqual(magic["target"], "self_active")
        self.assertEqual(magic["swap_slot"], 0, "只替换第一个技能")
        self.assertEqual(magic["restore"]["consumes_use"], False, "解除不消耗次数")
        self.assertIs(magic["restore"]["starts_cooldown"], True, "解除之后进冷却")

    def test_impact_variants_cover_18_elements_and_two_classes(self):
        skills = self.doc["impact_skills"]
        self.assertEqual(len(skills), 36, "18 属性 × 物攻/魔攻")
        for s in skills:
            self.assertEqual((s["energy"], s["power"]), (2, 80))
            self.assertIn(s["damage_class"], ("物攻", "魔攻"))
            self.assertEqual(s["evidence_id"], "EV-PVP-WISH-POWER-UP")

    def test_variant_ids_never_collide_with_frozen_skills(self):
        with open(os.path.join(
                ROOT, "data/roco/normalized/roco-world-s4-2026-09-10/skills.json"), encoding="utf-8") as fh:
            frozen = json.load(fh)
        overlap = set(frozen["skills"]) & {s["skill_id"] for s in self.doc["impact_skills"]}
        self.assertEqual(overlap, set(), "派生产物不许覆盖冻结技能表里的任何一条")

    def test_engine_can_parse_the_respond_bonus(self):
        """「额外 150%」必须写成引擎**读得出来**的那种措辞，否则是静默空转。"""
        skill = RS.skills["magic_wish_impact__火系__物攻"]
        self.assertEqual(fx.respond_to(skill), "状态")
        self.assertEqual(fx._extract_multiple(skill.desc), 2.5)


class TestStateAndLegalActions(unittest.TestCase):
    def test_standard_pvp_initialises_magic_state(self):
        state = _state()
        for side in (state.player, state.enemy):
            self.assertEqual(side.magic["uses_left"], 2)
            self.assertEqual(side.magic["cooldown"], 0)
            self.assertEqual(side.magic["swapped"], {})

    def test_legacy_has_no_magic_state_and_no_magic_action(self):
        """legacy / v2 没声明 magic 这一类 → 状态里没有它，序列化里也不出现这个键。"""
        legacy = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID)
        state = renv.reset(IDS_A[:3], IDS_B[:3], seed=3, rs=RS, config=legacy)
        self.assertIsNone(state.player.magic)
        self.assertNotIn("magic", state.player.to_dict(), "没声明的配置不许凭空多出一个键")
        self.assertEqual(_magic_actions(state), [], "legacy 的合法动作里不许有 PVP 魔法")

    def test_magic_action_appears_in_standard_pvp(self):
        state = _state()
        acts = _magic_actions(state)
        self.assertEqual(len(acts), 1)
        self.assertEqual(acts[0].magic_id, WISH)

    def test_magic_is_not_an_item(self):
        """口径：PVP 魔法**不是**普通道具。标准 PVP 依旧没有 item 动作。"""
        state = _state()
        kinds = {a.kind for a in renv.legal_actions(state, RS, "player", _v3())}
        self.assertIn(ACTION_MAGIC, kinds)
        self.assertNotIn("item", kinds)


class TestUseMagic(unittest.TestCase):
    def setUp(self):
        self.state = _state()
        self.pet = self.state.player.field_pet
        self.before = list(self.state.player.loadouts[self.pet.pet_id])

    def _use(self):
        """用一次愿力强化 —— **自由动作**（不占行动，回合不变）。"""
        act = _magic_actions(self.state)[0]
        turn_before = self.state.turn
        _use_free(self.state, act)
        assert self.state.turn == turn_before, "自由动作不许推进回合"
        return act

    def test_transform_swaps_first_skill_and_consumes_one_use(self):
        self._use()
        row = list(self.state.player.loadouts[self.pet.pet_id])
        self.assertEqual(row[1:], self.before[1:], "只动第一个技能")
        self.assertEqual(row[0], renv.wish_impact_skill_id(RS, self.pet))
        self.assertEqual(self.state.player.magic["uses_left"], 1)
        self.assertIn(self.pet.pet_id, self.state.player.magic["swapped"])
        self.assertEqual(self.state.player.magic["swapped"][self.pet.pet_id], self.before[0])

    def test_transform_starts_the_three_turn_cooldown(self):
        """人类 2026-09-23 实测报的 bug：**「用了愿力强化没进冷却」**。

        转换那一支原来只扣次数、不设冷却 → 下一回合它立刻又能用（两次次数连着用两个回合），
        与「每局两次、冷却三回合」直接冲突。这条判据同时钉住四件事：
          ① 转换之后冷却 = 3（值来自声明，不写字面量）；
          ② 冷却期间合法动作里**没有**它（不是只有界面灰、引擎照发）；
          ③ 冷却**逐回合**走完 3 → 2 → 1 → 0；
          ④ 次数只扣了 1（冷却不该额外扣次数）。
        """
        reg = _magic_registry_row()
        turn_before = self.state.turn
        self._use()
        self.assertEqual(self.state.player.magic["cooldown"], reg["cooldown_turns"],
                         "转换之后必须进冷却（值取声明里的 cooldown_turns）")
        # 记的是**用它的那一回合**（推进之后 `state.turn` 已经往后走了，所以先存下来再比），
        # 这条记号是 `_tick_magic_cooldowns` 判「当回合不递减」的依据。
        self.assertEqual(self.state.player.magic["cooldown_set_turn"], turn_before)
        self.assertEqual(self.state.player.magic["uses_left"], 1, "冷却不该额外扣次数")
        self.assertEqual(_magic_actions(self.state), [], "冷却期间不许再出这个动作")
        seen = []
        for _ in range(6):
            if self.state.result:
                break
            if self.state.phase == "replace":
                self._settle_replacements()
                continue
            _play(self.state, "player", renv.legal_actions(self.state, RS, "player", _v3())[0])
            # 采样点必须在**推进之后**：自由动作不推进回合，若在推进前采样，
            # 用它的那一回合会被多记一次（[3,3,2,1,0]），那条判据就变成在量采样点而不是量递减。
            seen.append(self.state.player.magic["cooldown"])
            if self.state.player.magic["cooldown"] == 0:
                break
        self.assertEqual(seen[:3], [3, 2, 1], f"冷却递减序列不对：{seen}")
        self.assertEqual(self.state.player.magic["cooldown"], 0, "三回合之后冷却应当走完")
        if not self.state.result and self.state.phase == "battle":
            acts = _magic_actions(self.state)
            self.assertTrue(acts, "冷却走完 + 还有次数 + 已经换过 → 动作回来（这一下是解除）")

    def test_restore_does_not_consume_a_use_but_starts_cooldown(self):
        """冷却走完后，再用一次愿力强化是**解除**：还原、不消耗次数、重新进冷却。

        2026-09-24：这条不再靠「打几个回合把冷却等完」（那会让场上换人，判据变成在测别的东西），
        而是把冷却**显式清零**模拟「冷却已过」，再走解除那一支 —— 判据只测解除的语义。
        """
        self._use()
        self.assertEqual(_magic_actions(self.state), [], "冷却期间连解除也不许（整支动作被锁）")
        self.state.player.magic["cooldown"] = 0
        self.state.player.magic["cooldown_set_turn"] = None
        # 场上那只还带着换过的技能（没有被换下/打倒）才谈得上解除
        if self.state.player.field_pet.pet_id != self.pet.pet_id:
            self.state.player.active = next(i for i, p in enumerate(self.state.player.pets)
                                            if p.pet_id == self.pet.pet_id)
        act = _magic_actions(self.state)
        self.assertEqual(len(act), 1, "冷却结束后这一下是解除（不消耗次数）")
        _use_free(self.state, act[0])
        row = list(self.state.player.loadouts[self.pet.pet_id])
        self.assertEqual(row, self.before, "解除之后第一个技能应当还原")
        self.assertEqual(self.state.player.magic["uses_left"], 1, "解除**不**消耗次数")
        self.assertEqual(self.state.player.magic["cooldown"], 3, "解除之后进 3 回合冷却")
        self.assertEqual(self.state.player.magic["swapped"], {})

    def test_wish_impact_is_one_shot_and_restores_after_use(self):
        """人类 2026-09-24 口径（B）：**愿力冲击是借来的，用掉就还**。

        旧口径是「替换持续到再用一次愿力强化解除」；新口径是一次性。这条判据同时钉住：
          ① 用掉之后第一个技能还原成原技能；
          ② **不消耗次数、不改冷却**（愿力强化在用它时已经扣过）；
          ③ `swapped` 里那一只被清掉（否则会出现「技能没换、状态说换过」的错位）。
        """
        self._use()
        pet = self.state.player.field_pet
        wish = renv.wish_impact_skill_id(RS, pet)
        self.assertEqual(list(self.state.player.loadouts[pet.pet_id])[0], wish)
        uses_before = self.state.player.magic["uses_left"]
        cd_before = self.state.player.magic["cooldown"]
        turn_before = self.state.turn
        acts = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                if a.kind == "skill" and a.skill_id == wish]
        self.assertTrue(acts, "换进来的愿力冲击必须能出招")
        _play(self.state, "player", acts[0])
        self.assertEqual(list(self.state.player.loadouts[pet.pet_id])[0], self.before[0],
                         "用掉之后第一个技能必须还回去")
        self.assertNotIn(pet.pet_id, self.state.player.magic["swapped"])
        self.assertEqual(self.state.player.magic["uses_left"], uses_before, "还原不消耗次数")
        # 冷却只允许被**回合末那一跳**减 1（`_tick_magic_cooldowns`），还原自己不许动它。
        # 2026-09-25：愿力强化是自由动作 ⇒ 用它和用愿力冲击落在**同一回合**，
        # 而设冷却的那一回合按口径不递减 ⇒ 这里应当**一分都没减**。
        self.assertEqual(self.state.turn, turn_before + 1,
                         "用愿力冲击**是**一次行动：回合必须往前走一手")
        self.assertEqual(self.state.player.magic["cooldown"], cd_before,
                         "还原既不加冷却、也不额外减冷却（设冷却的那一回合按口径不递减）")
        modes = [(e.detail or {}).get("mode") for e in self.state.events if e.kind == "magic"]
        self.assertIn("restore", modes, "要有一条 restore 事件给页面看")

    def test_other_attack_skills_do_not_consume_the_wish_impact(self):
        """真正的机复现（2026-09-24，`/tmp/wish-verify/report.md` 的 BUG-1）：

        **愿力冲击还没打出去之前，用这一只的别的技能不许把它静默收回。**

        旧实现的 `_restore_if_wish_impact` 只判「第一个技能**是不是**愿力冲击」，
        没判「这一手打出的**是不是它**」——于是这一只用任何一招攻击技能都会触发还原：
        实测事件序列 `[turn_start, damage(skill_000744), damage(skill_000744),
        magic/restore/consumed]`，`swapped` 被清空、`row0` 回到原技能，而次数在
        「愿力强化」那一下已经白扣了 1。

        反证方向：把 `used_skill` 那一条比较删掉（或恒等喂一个「就是愿力冲击」的假动作），
        这条判据必须红 —— 下面是这条判据的牙齿：只有 `action.skill_id == wish` 才还原。
        """
        self._use()
        pet = self.state.player.field_pet
        wish = renv.wish_impact_skill_id(RS, pet)
        swapped_before = dict(self.state.player.magic["swapped"])
        self.assertIn(pet.pet_id, swapped_before, "转换之后 swapped 里必须有这一只")
        others = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                  if a.kind == "skill" and a.skill_id != wish]
        attacks = [a for a in others if RS.skills[a.skill_id].category == "攻击"]
        self.assertTrue(attacks, "这一只必须还有别的攻击技能，否则判据退化成空转")
        picked = attacks[0]
        turn = self.state.turn
        _play(self.state, "player", picked)

        restores = [e for e in self.state.events
                    if e.kind == "magic" and (e.detail or {}).get("reason") == "consumed"
                    and e.turn == turn]
        self.assertEqual(restores, [],
                         f"用别的攻击技能（{picked.skill_id}）不该触发「愿力冲击被用掉」")
        self.assertEqual(self.state.player.loadouts[pet.pet_id][0], wish,
                         "愿力冲击必须还在第一格（它这一手没打出去）")
        self.assertEqual(self.state.player.magic["swapped"], swapped_before,
                         "swapped 不许被清 —— 清了就等于白白吃掉一次愿力强化")

        # 反向控制：**真的**打出去那一手必须还原（同一条判据的另一半，防止「干脆永不还原」）
        acts = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                if a.kind == "skill" and a.skill_id == wish]
        if acts:
            _play(self.state, "player", acts[0])
            self.assertNotIn(pet.pet_id, self.state.player.magic["swapped"],
                             "愿力冲击本人打出去之后必须还原（否则这条判据会把功能删掉）")

    def test_swapped_skill_is_executable(self):
        """换进来的愿力冲击必须真的能出招（不是只能看）。"""
        self._use()
        sid = list(self.state.player.loadouts[self.pet.pet_id])[0]
        acts = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                if a.kind == "skill" and a.skill_id == sid]
        self.assertTrue(acts, "第一个技能已经是愿力冲击，它必须出现在合法技能里")
        skill = RS.skills[sid]
        self.assertEqual((skill.energy, skill.power, skill.damage_class),
                         (2, 80, "物攻" if self.pet.pet_id == "pet_000062" else skill.damage_class))

    def _settle_replacements(self):
        """补位阶段：把两边该补的都补掉（补位不占回合）。"""
        for side in ("player", "enemy"):
            if self.state.phase != "replace":
                return
            legal = [a for a in renv.legal_actions(self.state, RS, side, _v3()) if a.kind == "switch"]
            if legal:
                renv.step_replace(self.state, RS, side, legal[0].target_index)

    def _wait_out_cooldown(self):
        """推进到冷却走完为止（返回观察到的冷却序列）。对局提前结束就停下。

        2026-09-23：冷却现在**锁住整支动作**（转换与解除都不给），所以「等冷却」这件事
        本身必须先做到，才能测解除 —— 这段助手就是那一步。
        """
        seen = []
        for _ in range(8):
            if self.state.result:
                break
            if self.state.phase == "replace":
                self._settle_replacements()
                continue
            _play(self.state, "player", renv.legal_actions(self.state, RS, "player", _v3())[0])
            seen.append(self.state.player.magic["cooldown"])
            if self.state.player.magic["cooldown"] == 0:
                break
        return seen

    def test_cooldown_blocks_then_expires(self):
        self._use()                                   # 转换 → 已经进冷却（见上面那条）
        self.assertEqual(self.state.player.magic["cooldown"], 3)
        self.assertEqual(_magic_actions(self.state), [], "转换之后立刻就在冷却里")
        self.assertEqual(_magic_actions(self.state), [], "冷却期间不许再出这个动作")
        seen = []
        for _ in range(6):
            if self.state.result:
                break
            if self.state.phase == "replace":
                self._settle_replacements()
                continue
            # 同 `test_transform_starts_the_three_turn_cooldown`：采样点必须在推进之后，
            # 否则自由动作那一回合会被多记一次（[3,3,2,1,0]）。
            _play(self.state, "player", renv.legal_actions(self.state, RS, "player", _v3())[0])
            seen.append(self.state.player.magic["cooldown"])
            if self.state.player.magic["cooldown"] == 0:
                break
        # 冷却必须**逐回合**走完：3 → 2 → 1 → 0（不是一步到位，也不是永远不减）
        self.assertEqual(seen[:3], [3, 2, 1], f"冷却递减序列不对：{seen}")
        self.assertEqual(self.state.player.magic["cooldown"], 0, "三回合之后冷却应当走完")
        if not self.state.result and self.state.phase == "battle":
            self.assertTrue(_magic_actions(self.state), "冷却走完 + 还有次数 → 动作回来")

    def test_fail_closed_when_out_of_uses(self):
        st = self.state.player.magic
        st["uses_left"] = 0
        st["cooldown"] = 0
        st["swapped"] = {}
        self.assertEqual(_magic_actions(self.state), [], "没次数且没换过 → 不出现这个动作")
        with self.assertRaises(ValueError):
            renv._use_magic(self.state, RS, "player", Action(kind=ACTION_MAGIC, magic_id=WISH), _v3())

    def test_unknown_magic_id_is_rejected(self):
        with self.assertRaises(ValueError):
            renv._use_magic(self.state, RS, "player",
                            Action(kind=ACTION_MAGIC, magic_id="不存在的魔法"), _v3())


#: 对手首发换成**带状态技**的那一只（铠甲虫：啃咬/防御/翅刃/风隐，风隐是状态技）。
#: 为什么必须换：默认对手首发没有状态技，「应对状态」这条子句就永远驱动不到。
RESPOND_FOE_LEAD = "铠甲虫"
RESPOND_FOE_REST = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V"]


def _impact_multiplier(skill) -> float:
    """从**技能描述**里读出「本次技能威力变为N倍」的 N（不写死 2.5 这个字面量）。"""
    import re as _re
    m = _re.search(r"威力变为\s*(\d+(?:\.\d+)?)\s*倍", skill.desc or "")
    if not m:
        raise AssertionError(f"愿力冲击的描述里读不出应对倍率：{skill.desc!r}")
    return float(m.group(1))


def _respond_case_swing(enemy_category: str, lead: str = "寂灭骨龙") -> "tuple[dict, str]":
    """这一手：我方出愿力冲击，敌方出指定**类别**的技能。返回 (我方伤害事件 detail, 愿力冲击 id)。

    为什么要换对手首发：默认对手首发没有状态技，「应对状态」这条子句永远驱动不到，
    判据会退化成恒真。`铠甲虫` 的配招里有 `风隐`（category=状态）。
    """
    lead_id = RS.pets_by_name(lead)[0].pet_id
    ids_a = [lead_id] + [p for p in IDS_A if p != lead_id][:5]
    ids_b = [RS.pets_by_name(RESPOND_FOE_LEAD)[0].pet_id] + [
        RS.pets_by_name(n)[0].pet_id for n in RESPOND_FOE_REST]
    state = renv.reset(ids_a, ids_b, seed=3, rs=RS, config=_v3(),
                       unverified_overrides=_overrides())
    magic = [a for a in renv.legal_actions(state, RS, "player", _v3()) if a.kind == ACTION_MAGIC]
    assert magic, "标准 PVP 第 1 回合必须能出愿力强化"
    _use_free(state, magic[0])          # 自由动作：回合不变，下面那一手技能照常出
    wish = renv.wish_impact_skill_id(RS, state.player.field_pet)
    assert wish, "愿力强化之后第一个技能必须是愿力冲击"
    mine = [a for a in renv.legal_actions(state, RS, "player", _v3())
            if a.kind == "skill" and a.skill_id == wish]
    assert mine, "换进来的愿力冲击必须能出招"
    pool = [a for a in renv.legal_actions(state, RS, "enemy", _v3()) if a.kind == "skill"]
    theirs = [a for a in pool if RS.skills[a.skill_id].category == enemy_category]
    assert theirs, f"对手这一回合没有「{enemy_category}」类技能可用，判据会空转"
    turn = state.turn
    renv.step_joint(state, RS, mine[0], theirs[0])
    hits = [e.detail for e in state.events
            if e.kind == "damage" and e.turn == turn
            and (e.detail or {}).get("side") == "player"
            and (e.detail or {}).get("skill_id") == wish]
    assert hits, "我方那一下必须真的造成伤害（否则这条判据是空转的）"
    return hits[0], wish


class TestRespondStateMultiplier(unittest.TestCase):
    """愿力冲击的「应对状态：本次技能威力变为 2.5 倍」**真的会结算**（2026-09-24 实测）。

    主线只验到「page 通」与「次数/冷却」，这一条数值一直没人量过。构造很窄：
    对手首发必须是**带状态技**的那一只，否则「应对状态」永远不成立 —— 判据会退化成恒真。
    倍率从**技能描述**读（`_impact_multiplier`），断言里不出现 2.5 这个字面量。
    """

    def test_respond_state_success_multiplies_power(self):
        detail, wish = _respond_case_swing("状态")
        skill = RS.skills[wish]
        mult = _impact_multiplier(skill)
        self.assertTrue(detail.get("conditional_power"), "应对成功必须标记为条件化威力")
        self.assertIn("应对成功", str(detail.get("conditional_reason")))
        self.assertAlmostEqual(float(detail["power_used"]), float(skill.power) * mult, places=6,
                               msg=f"应对状态成功 ⇒ 威力应当 ×{mult}（实际 {detail}）")

    def test_respond_state_failure_keeps_static_power(self):
        detail, wish = _respond_case_swing("攻击")
        skill = RS.skills[wish]
        self.assertEqual(float(detail["power_used"]), float(skill.power),
                         f"应对不成功 ⇒ 用静态威力（实际 {detail}）")
        self.assertEqual(str(detail.get("conditional_reason") or ""), "",
                         "应对没成功就不该有「应对成功 → 威力 ×2.5」这类理由")

    def test_multiplier_is_element_independent(self):
        """换一个属性的愿力冲击变体（水系），倍率必须一样 —— 起作用的只有应对判定。"""
        detail, wish = _respond_case_swing("状态", lead="圆号鱼")   # 圆号鱼第一属性 = 水系
        skill = RS.skills[wish]
        self.assertEqual(skill.element, "水系", f"这一只换出来的应当是水系愿力冲击：{skill.skill_id}")
        self.assertAlmostEqual(float(detail["power_used"]),
                               float(skill.power) * _impact_multiplier(skill), places=6)


class TestRespondStateMultiplierRedProof(unittest.TestCase):
    """**必红反证**：把「应对成功」短路成 False，上面那条 2.5 倍的判据必须红。

    做法与 `tests/test_turn_order_fail_closed.py` 的「改坏再判」同一手法：只在这次运行里
    把 `env._respond_success` 换成恒 False，跑同一个构造，断言**判据本身**给出不同的结论。
    """

    def test_short_circuiting_respond_makes_the_multiplier_disappear(self):
        original = renv._respond_success
        renv._respond_success = lambda action, opponent, rs: False   # noqa: ARG005
        try:
            detail, wish = _respond_case_swing("状态")
            skill = RS.skills[wish]
            mult = _impact_multiplier(skill)
        finally:
            renv._respond_success = original
        self.assertEqual(float(detail["power_used"]), float(skill.power),
                         "短路之后威力必须回到静态值 —— 否则上面那条判据量的不是应对判定")
        self.assertNotAlmostEqual(float(detail["power_used"]), float(skill.power) * mult,
                                  places=6,
                                  msg="反证失败：短路后仍然是 2.5 倍，说明倍率不是由应对判定驱动的")


class TestFreeActionDoesNotOccupyTheTurn(unittest.TestCase):
    """人类 2026-09-25 口径：「愿力强化**不占行动**，自由动作，背包物品都不占行动」。

    这一组判据钉住四件事（每条都带必红方向）：
      ① 用掉之后 **回合数不变**、对手这一手**还没结算**；
      ② 用完之后**仍然可以照常出一手技能**（「『愿力冲击』就是个技能，这个算行动」）；
      ③ 用完之后 **`step_joint` 不再接受**把它当成那一手交上来（否则「不占行动」会在
         最容易被忽略的一条路上失效：调用方把它当这一手交上去，回合照走、白搭一个回合）；
      ④ **能力由配置声明**：把声明改成 `True` / 拿掉（`None`）时，自由动作入口必须
         fail closed —— 未声明就放行等于白送一个能力。
    """

    def setUp(self):
        rc.clear_cache()
        self.state = _state()
        self.pet = self.state.player.field_pet
        self.before = list(self.state.player.loadouts[self.pet.pet_id])
        self.row = _magic_registry_row()

    def tearDown(self):
        rc.clear_cache()

    def _magic(self):
        acts = _magic_actions(self.state)
        self.assertTrue(acts, "标准 PVP 第 1 回合必须能出愿力强化")
        return acts[0]

    def test_free_action_does_not_advance_the_turn_and_still_leaves_a_hand(self):
        turn_before = self.state.turn
        version_before = self.state.state_version
        foe_hp_before = self.state.enemy.field_pet.hp
        foe_energy_before = self.state.enemy.field_pet.energy
        _use_free(self.state, self._magic())

        self.assertEqual(self.state.turn, turn_before, "自由动作**不许**推进回合")
        self.assertGreater(self.state.state_version, version_before,
                           "自由动作必须让 state_version 往前走（页面靠它作废过期规划）")
        self.assertEqual(self.state.enemy.field_pet.hp, foe_hp_before,
                         "对手这一手还没结算，血量不该动")
        self.assertEqual(self.state.enemy.field_pet.energy, foe_energy_before,
                         "对手这一手还没结算，能量不该动")
        # ① 转换本身还是照常发生（扣次数、换第一个技能、进冷却）
        self.assertEqual(list(self.state.player.loadouts[self.pet.pet_id])[0],
                         renv.wish_impact_skill_id(RS, self.pet))
        self.assertEqual(self.state.player.magic["uses_left"], 1)
        # ② 这一手还在：技能照常可出
        skills = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                  if a.kind == "skill"]
        self.assertTrue(skills, "自由动作之后这一手仍然必须能出技能")

    def test_wish_impact_is_a_normal_skill_that_costs_the_action(self):
        """「『愿力冲击』就是个技能，这个算行动」——它照常占这一手，并推进回合。"""
        _use_free(self.state, self._magic())
        pet = self.state.player.field_pet
        wish = renv.wish_impact_skill_id(RS, pet)
        mine = [a for a in renv.legal_actions(self.state, RS, "player", _v3())
                if a.kind == "skill" and a.skill_id == wish]
        self.assertTrue(mine, "换进来的愿力冲击必须能出招")
        turn_before = self.state.turn
        _play(self.state, "player", mine[0])
        self.assertGreater(self.state.turn, turn_before,
                           "用愿力冲击**是**一次行动：回合必须往前走")
        self.assertEqual(list(self.state.player.loadouts[pet.pet_id])[0], self.before[0],
                         "愿力冲击用掉之后第一个技能应当还回去（一次性）")

    def test_service_boundary_refuses_a_free_action_as_the_turn_action(self):
        """必红反证的另一半：**玩家可达到的 API 边界**上不许把它当这一手交上来。

        拦截点选在服务层而不是 `env.step_joint`：机器人推演（`opponents.play_match`）走的是
        `step_joint`，那里「这一手用了道具」只是推演里少出一招，不是玩家可见的规则违规；
        而 `/battle/advance` 是页面唯一会走的那条路 —— 在那里放行才会真让玩家白搭一个回合。
        这条同时钉住正反两面：`/battle/free` 放行且**回合不变**；`/battle/advance` 拒绝。
        """
        svc = RocoService()
        base = {"ruleset_id": RS.ruleset_id, "team": IDS_A, "enemy_team": IDS_B, "seed": 3,
                "strategy": "greedy_damage", "ruleset_config_id": V3,
                "unverified_overrides": _overrides()}
        status, opened = svc.battle_new({**base, "state_version": 0})
        self.assertEqual(status, 200, opened.get("error"))
        self.assertTrue(opened["ok"], opened.get("error"))
        first = opened["result"]
        magic = [a for a in first["legal"]["player"] if a["kind"] == ACTION_MAGIC]
        self.assertTrue(magic, "标准 PVP 第 1 回合必须能出愿力强化")
        turn_before = first["turn"]
        same_state = {**base, "state_version": first["state_version"], "state": first["state"]}

        # ① 自由动作端点：放行，而且**回合不变**、这一手还在
        status_free, freed = svc.battle_free({**same_state, "action": magic[0]})
        self.assertEqual(status_free, 200, freed.get("error"))
        self.assertTrue(freed["ok"], freed.get("error"))
        self.assertEqual(freed["result"]["turn"], turn_before, "自由动作**不许**推进回合")
        self.assertTrue([a for a in freed["result"]["legal"]["player"] if a["kind"] == "skill"],
                        "自由动作之后这一手仍然要能出技能")

        # ② 必红方向：同一份状态把它当这一手交上去 → 拒绝（400），且提示走 /battle/free
        status_bad, refused = svc.battle_advance({**same_state, "action": magic[0]})
        self.assertEqual(status_bad, 400, f"把它当这一手交上来必须被拒：{refused}")
        self.assertFalse(refused["ok"])
        self.assertIn("自由动作", refused.get("error") or "")
        self.assertIn("/battle/free", refused.get("error") or "")

    def test_missing_or_true_declaration_makes_the_free_entry_fail_closed(self):
        """**必红反证**：把声明改成 True / 拿掉（None），自由动作入口必须拒绝。"""
        magic = self._magic()
        base = _v3()
        self.assertIs(base.magic_occupies_action, False, "v3 必须已经声明「不占行动」（False）")
        original_get = rc.get_rule_config
        try:
            for patched in (True, None):          # 旧口径「占一手」 / 没声明（UNKNOWN）
                variant = dc_replace(base, magic_occupies_action=patched)
                rc.get_rule_config = lambda override=None, _v=variant: _v
                with self.assertRaises(fx.UnsupportedEffect) as ctx:
                    renv.step_free(self.state, RS, "player", magic)
                self.assertIn("fail closed", str(ctx.exception))
        finally:
            rc.get_rule_config = original_get
        # 还原之后同一个动作必须能走通（否则上面那两条量的不是声明本身）
        _use_free(self.state, magic)

    def test_legacy_and_v2_do_not_declare_free_actions(self):
        """红线：没有声明这块能力的配置**一个字节的行为都不许变**（自由动作一律拒绝）。"""
        # legacy 是每方 3 只的模式、v2 是六宠模式 —— 队伍规模按各自模式给，
        # 这条判据量的是「没声明就一律拒绝」，与规模无关。
        for config_id, size in (("legacy_sim_v1", 3), ("mobile_s4_candidate_v2", 6)):
            cfg = rc.load_config(config_id)
            self.assertIsNone(cfg.magic_occupies_action,
                              f"{config_id} 不许声明 magic_occupies_action")
            state = renv.reset(IDS_A[:size], IDS_B[:size], seed=3, rs=RS, config=cfg)
            with self.assertRaises(fx.UnsupportedEffect):
                renv.step_free(state, RS, "player",
                               Action(kind=ACTION_MAGIC, magic_id=WISH))

    def test_registration_and_derived_artifact_declare_the_free_action(self):
        """登记表与派生产物必须**同时**写 false —— 判据读声明，不读我的记忆。"""
        self.assertIs(self.row["occupies_action"], False,
                      "battle-modes.json 的愿力强化那一条必须是 occupies_action=false")
        with open(MAGIC_ARTIFACT, encoding="utf-8") as handle:
            derived = json.load(handle)
        self.assertIs(derived["magic"]["occupies_action"], False,
                      "pvp-magic.json 的 occupies_action 必须跟着登记表")
        self.assertIs(_v3().magic_occupies_action, False,
                      "v3 配置里必须能读到这条声明（生成器从登记表照抄）")

    def test_restore_after_cooldown_still_costs_no_use_and_starts_cooldown(self):
        """解除那一支的语义不变（人类 2026-09-25 重申）：不恢复次数、进入 3 回合冷却。"""
        _use_free(self.state, self._magic())
        self.state.player.magic["cooldown"] = 0        # 显式模拟「冷却已过」
        self.state.player.magic["cooldown_set_turn"] = None
        act = _magic_actions(self.state)
        self.assertEqual(len(act), 1, "冷却结束后这一下是解除")
        _use_free(self.state, act[0])
        self.assertEqual(list(self.state.player.loadouts[self.pet.pet_id]), self.before,
                         "解除之后第一个技能应当还原")
        self.assertEqual(self.state.player.magic["uses_left"], 1, "解除**不**恢复已消耗的次数")
        self.assertEqual(self.state.player.magic["cooldown"], self.row["cooldown_turns"],
                         "解除之后进冷却（值取声明里的 cooldown_turns）")
        self.assertEqual(self.state.player.magic["swapped"], {})


if __name__ == "__main__":       # pragma: no cover
    unittest.main()
