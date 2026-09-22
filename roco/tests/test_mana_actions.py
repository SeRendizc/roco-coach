"""RC-105：BattleMode 驱动的**合法行动裁剪**与**魔力（心）结算**。

判据（每条都有必红方向，反证就写在同一条用例里或紧邻那条）：

  1. `mobile_s4_candidate_v3` 是一份**合规的候选**：mana 四件套（4 / 1 / 归零判负 / 允许投降）
     与 actions 三件套（allowed / forbidden / unknown_kinds_allowed）都进加载期校验，
     非法值（负数、未知 kind、两张清单有交集、缺字段）**加载期**就抛 `RuleConfigError`；
  2. **legacy / v2 不受影响**：它们没有 `mana`、没有 `actions`，`mana_pool is None`
     —— 不是 0。序列化里**不出现** `mana` 键（8 条 golden 指纹因此仍然成立），
     胜负判据仍然是「打光整队」；
  3. 标准 PVP 下合法动作里**没有** item / escape，**有** charge / surrender：
     而这两条都由**配置**驱动 —— 把 item 写进 `allowed_kinds` 它就真的会出现，
     把 item 写成「既不允许也不禁止」且 `unknown_kinds_allowed=false` 时**抛错**；
  4. 魔力结算：开局 4 点；一次力竭扣 1 点（`faint_cost` 来自配置）；归零**立即**判负。

第 3 条的两个方向都是判据本体：只断言「没有道具」而不断言「配置允许时就会出现」，
这条检查就可能是恒真的（例如有人把 item 硬编码过滤掉，检查照样绿）。

运行：cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import effects as fx            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env.schema import (                 # noqa: E402
    ACTION_CHARGE,
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SKILL,
    ACTION_SURRENDER,
    ACTION_SWITCH,
    VALID_KINDS,
    Action,
)

RS = rdata.load_ruleset()

#: 标准 PVP 是**六宠**（v3 的 `battle_mode.team_size = 6`）。RC-105 时引擎的
#: `reset` / `validate_team` 只收 3 只，所以那一轮的夹具是「3 只队伍 +
#: `dataclasses.replace(energy_initial=…)`」；RC-106 把模式规模接进引擎之后，
#: 夹具就是**真的六宠队伍**，而入场能量走**显式未核验覆盖**（见 `_override_energy_initial`）。
#:
#: 12 只的速度**两两不同**（快照种族值：60/100/70/105/90/120 与 130/92/115/80/75/108）：
#: v3 沿用 v2 的 `speed_tie = null`，同速平手会让 `order_actions` 按 RC-103 的纪律抛错
#: —— 那是判据，不是本活的缺陷，所以夹具刻意避开它。
TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
TEAM_B = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]
IDS_A = [RS.pets_by_name(n)[0].pet_id for n in TEAM_A]
IDS_B = [RS.pets_by_name(n)[0].pet_id for n in TEAM_B]

#: legacy 的**训练场**队伍：`legacy_sim_v1` 绑的 `demo-training-3v3` 登记的
#: `team_size` 是 3，所以 legacy 的对照局只收 3 只 —— 这本身就是「模式规模真的
#: 按配置走」的另一半证据（同一份引擎，两份配置，两种场地规模）。
LEGACY_IDS_A = IDS_A[:3]
LEGACY_IDS_B = IDS_B[:3]

V3 = rc.MANA_ACTIONS_CANDIDATE_ID


def _v3() -> rc.RuleConfig:
    rc.clear_cache()
    return rc.load_config(V3)


def _legacy_initial_energy() -> int:
    """夹具借用的入场能量：**从默认配置读**，不在测试里写死一个字面量。

    结构契约的纪律是「能量值的唯一事实源是 data/roco/rulesets/*.json」；测试不是那份
    事实源，所以这里也不抄一个数。

    **它是练习局口径，不是标准 PVP 的实机结论**（MC-E04 未录制）——报告里写着同一句话。
    """
    value = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID).energy_initial
    if value is None:                                   # pragma: no cover - 默认配置不会是这样
        raise AssertionError("默认配置的 energy.initial 是 UNKNOWN，夹具取不到入场能量")
    return int(value)


def _v3_overrides() -> list:
    """v3 开局需要的**显式未核验覆盖**。

    2026-09-22：`energy.initial` 不再需要覆盖（用户实机核对开局双方各 10 星 → 台账 RECORDED_IN_GAME，
    配置里已是登记值 10）；覆盖只用于把 UNKNOWN 显式假设掉。仍需要覆盖的只剩同速平手裁决。
    """
    return [{
        "path": "turn_order.speed_tie",
        "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS",
        "reason": "同速平手裁决未核验（MC-E05 未录制），按已登记的工程权宜走",
        "microcase_id": "MC-E05",
    }]


def _new_state(cfg: rc.RuleConfig | None = None):
    return renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=cfg or _v3(),
                      unverified_overrides=_v3_overrides())


def _attack_actions(state, side: str):
    return [a for a in renv.legal_actions(state, RS, side)
            if a.kind == ACTION_SKILL and RS.skill(a.skill_id).is_attack]


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


# ── 1. 配置层：v3 合规、非法值加载期炸、legacy/v2 不受影响 ────────────────


class RuleConfigManaActionsTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_v3_is_a_candidate_and_declares_mana_and_actions(self):
        cfg = _v3()
        self.assertEqual(cfg.battle_mode_id, "pvp-standard-six-pet")
        self.assertFalse(cfg.is_default, "候选不得作为默认配置")
        self.assertTrue(cfg.requires_microcase_before_default)
        self.assertEqual(cfg.status, "CANDIDATE_NOT_FOR_DEFAULT")
        self.assertEqual(cfg.raw["promotion_policy"], "BLOCKED_UNTIL_MICROCASE")
        # mana 四件套
        self.assertTrue(cfg.has_mana)
        self.assertEqual((cfg.mana_pool, cfg.mana_faint_cost), (4, 1))
        self.assertIs(cfg.mana_loss_when_zero, True)
        self.assertIs(cfg.mana_surrender, True)
        # actions 三件套
        self.assertEqual(cfg.allowed_kinds, ("skill", "charge", "switch", "surrender"))
        self.assertEqual(cfg.forbidden_kinds, ("item", "escape"))
        self.assertIs(cfg.unknown_kinds_allowed, False)
        # 一个 problem 都没有（对照组：下面每一条反证都往同一份 raw 上动手）
        self.assertEqual(rc.validate_config(cfg.raw, rc._load_ledger()), [])

    def test_v3_energy_and_turn_order_are_verbatim_copies_of_v2(self):
        """v3 只新增 mana/actions；`energy` 与 `turn_order` 必须与 v2 逐字相同。"""
        v2 = rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID)
        v3 = _v3()
        self.assertEqual(json.dumps(v3.raw["energy"], sort_keys=True),
                         json.dumps(v2.raw["energy"], sort_keys=True))
        self.assertEqual(json.dumps(v3.raw["turn_order"], sort_keys=True),
                         json.dumps(v2.raw["turn_order"], sort_keys=True))

    def test_mana_and_actions_evidence_refs_stay_at_ledger_level(self):
        """台账等级不许被抬高：引台账的字段必须与台账逐字同级。"""
        ledger = {e["id"]: e for e in rc._load_ledger()["entries"]}
        cfg = _v3()
        checked = 0
        for path, leaf in rc._iter_leaves(cfg.raw):
            if not leaf.get("evidence_id"):
                continue
            checked += 1
            entry = ledger[leaf["evidence_id"]]
            if leaf.get("evidence_role") == "supports":
                self.assertEqual(leaf["confidence"], entry["confidence"], path)
            # 2026-09-22：改成**更严的**一致性判据 —— 配置等级不许高于它引用的台账条目。
            _order = ("UNKNOWN", "ENGINE_HYPOTHESIS", "COMMUNITY_CURRENT",
                      "CROSS_SOURCE_SUPPORTED", "RECORDED_IN_GAME", "OFFICIAL_CURRENT")
            self.assertIn(leaf["confidence"], _order)
            self.assertIn(entry["confidence"], _order)
            self.assertLessEqual(_order.index(leaf["confidence"]), _order.index(entry["confidence"]),
                                 f"{path} 被抬到了 {leaf['confidence']}，台账只到 {entry['confidence']}")
        self.assertGreaterEqual(checked, 3, "v3 至少要引三条台账条目（六宠/魔力/力竭）")
        # mana 四件套里，投降**没有**台账支撑 —— 必须如实写成 ENGINE_HYPOTHESIS + reason
        surrender = cfg.raw["mana"]["surrender"]
        self.assertEqual(surrender["confidence"], "ENGINE_HYPOTHESIS")
        self.assertIsNone(surrender["evidence_id"])
        self.assertTrue(surrender["reason"])
        # 引台账的那三条必须仍停在 CROSS_SOURCE_SUPPORTED
        for key, ev in (("pool", "EV-PVP-STANDARD-MANA"),
                        ("faint_cost", "EV-PVP-FAINT-MANA-LOSS"),
                        ("loss_when_zero", "EV-PVP-FAINT-MANA-LOSS")):
            leaf = cfg.raw["mana"][key]
            self.assertEqual(leaf["evidence_id"], ev)
            self.assertEqual(leaf["confidence"], "CROSS_SOURCE_SUPPORTED")
            self.assertEqual(leaf["evidence_role"], "supports")

    def test_repo_internal_evidence_quotes_really_exist_in_the_frozen_snapshot(self):
        """配置里引的**仓内原文**必须真的在冻结快照里 —— 引文是可核对的，不是抄来的印象。

        这些引文是「魔力」语义**唯一**来自游戏内文本的线索（6 条特性 desc）。
        它们只有一份仓内来源（社区快照），所以**不新增台账条目、也不升级等级**
        （见配置的 `repo_internal_evidence`，以及文档里的「哪些是台账支持的」一节）。
        """
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        cfg = _v3()
        rows = cfg.raw["repo_internal_evidence"]
        self.assertGreaterEqual(len(rows), 5, "至少要登记诈死 / 付给恶魔的赎价 / 飓风 / 御驾亲征 + 历史改动")
        for row in rows:
            with self.subTest(record=row.get("record")):
                self.assertEqual(row["kind"], "repo_internal")
                self.assertTrue(row["quote"])
                self.assertTrue(row["ref"])
                self.assertTrue(row["note"])

        with open(os.path.join(root, "data/roco/normalized/roco-world-s4-2026-09-10/skills.json"),
                  encoding="utf-8") as fh:
            skills = json.load(fh)["skills"]
        quotes = {row["quote"] for row in rows}
        # ① 逐字核对：这几条 desc 必须**原样**出现在配置的引文里（不是「大意如此」）
        for sid in ("skill_000007", "skill_000060", "skill_000113", "skill_000142",
                    "skill_000143", "skill_000226"):
            with self.subTest(skill=sid):
                self.assertTrue(any(skills[sid]["desc"] in q for q in quotes),
                                f"{sid} 的 desc 原文没有被逐字引用：{skills[sid]['desc']!r}")
        # ② 扫描口径真的是「整个冻结快照」：提到魔力的 desc **恰好**这六条
        hits = sorted(sid for sid, sk in skills.items() if "魔力" in (sk.get("desc") or ""))
        self.assertEqual(hits, ["skill_000007", "skill_000060", "skill_000113",
                                "skill_000142", "skill_000143", "skill_000226"],
                         f"冻结快照里的魔力 desc 清单变了：{hits}")
        # ③ 必红反证：把引文改一个字，逐字核对必须失败
        original = skills["skill_000007"]["desc"]
        tampered = [q.replace(original, "自己力竭时，少损失1点能量。") for q in quotes]
        self.assertFalse(any(original in q for q in tampered),
                         "引文被改掉之后仍能对上原文 —— 那说明这条检查没咬住逐字核对")
        self.assertTrue(any(original in q for q in quotes))
        # ④ 「御驾亲征」的 4 点是**首领/棋契形态**的写法：只能当旁证，不许当标准 PVP 默认值
        self.assertIn("棋契", skills["skill_000226"]["desc"])
        self.assertNotEqual(cfg.mana_faint_cost, 4, "首领形态的 4 点不是标准口径的力竭扣减")

    def test_legacy_and_v2_have_no_mana_and_no_action_clipping(self):
        for cid in (rc.DEFAULT_RULE_CONFIG_ID, rc.CANDIDATE_RULE_CONFIG_ID):
            cfg = rc.load_config(cid)
            self.assertFalse(cfg.has_mana, cid)
            self.assertFalse(cfg.has_actions, cid)
            # **None 不是 0**：0 的意思是「魔力归零、已经判负」
            self.assertIsNone(cfg.mana_pool, cid)
            self.assertIsNone(cfg.mana_faint_cost, cid)
            self.assertIsNone(cfg.mana_loss_when_zero, cid)
            self.assertIsNone(cfg.mana_surrender, cid)
            self.assertIsNone(cfg.allowed_kinds, cid)
            self.assertIsNone(cfg.unknown_kinds_allowed, cid)
            self.assertEqual(cfg.forbidden_kinds, (), cid)

    def test_illegal_configs_fail_closed_at_validate(self):
        cfg = _v3()
        base = json.loads(json.dumps(cfg.raw))

        def problems(mutate):
            raw = json.loads(json.dumps(base))
            mutate(raw)
            return rc.validate_config(raw, rc._load_ledger())

        cases = {
            "负数魔力池": (lambda raw: raw["mana"]["pool"].__setitem__("value", -1), "mana.pool"),
            "力竭扣减为负": (lambda raw: raw["mana"]["faint_cost"].__setitem__("value", -2), "mana.faint_cost"),
            "未知动作类": (lambda raw: raw["actions"]["allowed_kinds"]["value"].append("fuse"), "不认识的动作类"),
            "两张清单有交集": (
                lambda raw: (raw["actions"]["allowed_kinds"]["value"].append("item"),
                             raw["actions"]["kinds"]["item"].__setitem__("value", "allowed")), "交集"),
            "缺 mana.loss_when_zero": (lambda raw: raw["mana"].pop("loss_when_zero"), "mana.loss_when_zero"),
            "缺 actions.allowed_kinds": (lambda raw: raw["actions"].pop("allowed_kinds"), "actions.allowed_kinds"),
            "开关不是布尔": (
                lambda raw: raw["actions"]["unknown_kinds_allowed"].__setitem__("value", "false"),
                "unknown_kinds_allowed"),
            "kinds 少登记一个": (lambda raw: raw["actions"]["kinds"].pop("charge"), "actions.kinds"),
            "kinds 与清单不一致": (
                lambda raw: raw["actions"]["kinds"]["escape"].__setitem__("value", "allowed"),
                "与两张清单不一致"),
        }
        for name, (mutate, needle) in cases.items():
            with self.subTest(case=name):
                found = problems(mutate)
                self.assertTrue(any(needle in p for p in found),
                                f"{name} 必须被判红（找 {needle!r}），实际 {found}")
        # 对照组：一份不改的配置必须零问题 —— 否则上面的红可能来自别处
        self.assertEqual(rc.validate_config(base, rc._load_ledger()), [])

    def test_illegal_config_fails_at_load_not_at_battle(self):
        """**加载期**就抛 `RuleConfigError`：不是等打起来才发现配置缺字段。"""
        cfg = _v3()
        broken = json.loads(json.dumps(cfg.raw))
        broken["mana"]["pool"]["value"] = -3
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "mobile-s4-candidate-v3.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(broken, fh, ensure_ascii=False)
            with mock.patch.object(rc, "config_path", lambda cid: path):
                with self.assertRaises(rc.RuleConfigError) as ctx:
                    rc.load_config(V3)
                message = str(ctx.exception)
        self.assertIn("mana.pool", message)
        self.assertIn(">= 0", message)
        # 反证：把非法值改回合法，同一个加载路径必须能过（证明这条红是坏值造成的）
        fixed = json.loads(json.dumps(broken))
        fixed["mana"]["pool"]["value"] = 4
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "mobile-s4-candidate-v3.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(fixed, fh, ensure_ascii=False)
            with mock.patch.object(rc, "config_path", lambda cid: path):
                loaded = rc.load_config(V3)
        self.assertEqual(loaded.mana_pool, 4)

    def test_legacy_is_still_the_default(self):
        self.assertEqual(rc.DEFAULT_RULE_CONFIG_ID, "legacy_sim_v1")
        self.assertEqual(rc.default_ruleset_config_id(), "legacy_sim_v1")
        self.assertTrue(rc.get_rule_config().is_default)
        self.assertIn(V3, rc.available_rule_configs())


# ── 2. 引擎：魔力结算 ────────────────────────────────────────────────────


class ManaSettlementTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()

    def tearDown(self):
        rc.clear_cache()

    def test_six_pet_mode_starts_with_four_mana_per_side(self):
        cfg = _v3()
        # 模式规模来自登记表（六宠），魔力池来自配置（4）
        self.assertEqual(cfg.raw["battle_mode"]["team_size"]["value"], 6)
        state = _new_state()
        self.assertEqual((state.player.mana, state.enemy.mana), (4, 4))
        serialized = renv.serialize(state)
        self.assertEqual(serialized["player"]["mana"], 4)
        self.assertEqual(serialized["enemy"]["mana"], 4)
        # RC-105 时这里断言的是「引擎仍然只收 3 只」（模式规模与场地规模没打通）。
        # RC-106 把那条差距接上了：**六宠真的能开局**，所以判据从「3」翻成「6」。
        # 必红方向：把 `reset` 里的 team_size 硬编码回 3，这一条会以
        # 「每方需要恰好 3 只精灵，实际 6 只」变红（反证原文见报告 checks[]）。
        self.assertEqual(len(state.player.pets), 6)
        self.assertEqual(len(state.enemy.pets), 6)
        self.assertEqual(cfg.battle_mode_id, "pvp-standard-six-pet")

    def test_one_faint_costs_exactly_one_mana(self):
        cfg = _v3()
        state = _new_state()
        self.assertEqual(state.enemy.mana, 4)
        state.enemy.field_pet.hp = 1
        renv._execute(state, RS, "player", _attack_actions(state, "player")[0], cfg)
        self.assertEqual(state.enemy.mana, 3, "对手的精灵力竭 → 对手扣 1 点魔力（4 → 3）")
        self.assertEqual(state.player.mana, 4, "力竭扣的是**那一方**的魔力，不是双方")
        kinds = [e.kind for e in state.events]
        self.assertIn("faint", kinds)
        self.assertIn("mana_loss", kinds)
        loss = [e for e in state.events if e.kind == "mana_loss"][-1]
        self.assertEqual(loss.detail["side"], "enemy")
        self.assertEqual(loss.detail["faint_cost"], 1)
        self.assertEqual(loss.detail["mana"], 3)
        # 反证①：把扣减改成 0（配置层）→ 同一次力竭不该再让魔力下降
        zero_cost = replace(cfg, mana_faint_cost=0)
        other = _new_state()
        other.enemy.field_pet.hp = 1
        renv._execute(other, RS, "player", _attack_actions(other, "player")[0], zero_cost)
        self.assertEqual(other.enemy.mana, 4,
                         "mana_faint_cost=0 时魔力不该下降 —— 说明上面那条红真的是扣减造成的")
        # 反证②：把结算函数整个摘掉 → 魔力同样不动（判据咬在结算路径上，不是咬在注释上）
        third = _new_state()
        third.enemy.field_pet.hp = 1
        with mock.patch.object(renv, "_settle_faint_mana", lambda *a, **k: None):
            renv._execute(third, RS, "player", _attack_actions(third, "player")[0], cfg)
        self.assertEqual(third.enemy.mana, 4)
        self.assertNotEqual(third.enemy.mana, 3)

    def test_faint_cost_comes_from_the_config_not_from_code(self):
        """扣减量是**读配置**的：把 faint_cost 改成 2，同一次力竭必须扣 2。"""
        cfg = _v3()
        state = _new_state()
        state.enemy.field_pet.hp = 1
        renv._execute(state, RS, "player", _attack_actions(state, "player")[0],
                      replace(cfg, mana_faint_cost=2))
        self.assertEqual(state.enemy.mana, 2)
        self.assertNotEqual(state.enemy.mana, 3)

    def test_mana_zero_ends_the_battle_immediately(self):
        cfg = _v3()
        state = _new_state()
        state.enemy.mana = 1
        state.enemy.field_pet.hp = 1
        renv._execute(state, RS, "player", _attack_actions(state, "player")[0], cfg)
        self.assertEqual(state.enemy.mana, 0)
        self.assertEqual(state.result, "win", "对方魔力归零 → 立即判我方胜，不需要打光整队")
        self.assertEqual(state.phase, "ended")
        self.assertTrue(state.enemy.living(), "对方**还有存活精灵** —— 胜负不是按打光判的")
        end = [e for e in state.events if e.kind == "game_end"][-1]
        self.assertEqual(end.detail["reason"], "mana_depleted")
        self.assertEqual(end.detail["enemy_mana"], 0)
        # 收尾阶段不再覆盖这个结果：走一遍 step_joint 的收尾逻辑也一样
        renv._advance_after_turn(state, cfg)
        self.assertEqual(state.result, "win")
        # 反证：把「归零判负」关掉 → 同一局面不该结束（证明这条判据不是恒真的）
        open_ended = replace(cfg, mana_loss_when_zero=False)
        other = _new_state()
        other.enemy.mana = 1
        other.enemy.field_pet.hp = 1
        renv._execute(other, RS, "player", _attack_actions(other, "player")[0], open_ended)
        self.assertEqual(other.enemy.mana, 0)
        self.assertIsNone(other.result, "mana_loss_when_zero=false 时不结束对局")

    def test_both_sides_zero_at_once_is_a_draw(self):
        """双方同时归零：台账没有条目 —— 引擎按平局处理，且**不**假装知道优先级。"""
        cfg = _v3()
        state = _new_state()
        state.player.mana = 0
        state.enemy.mana = 0
        renv._finish_mana_depletion(state, cfg)
        self.assertEqual(state.result, "draw")
        self.assertEqual(state.phase, "ended")

    def test_mana_survives_a_serialize_roundtrip(self):
        state = _new_state()
        state.enemy.mana = 2
        dumped = json.loads(json.dumps(renv.serialize(state)))
        # `deserialize` 会核对「记录里的配置 id == 当前生效配置」（RC-101），
        # 所以要先把当前配置切到 v3 再还原 —— 这条本身也是那条纪律的见证。
        os.environ[rc.ENV_VAR] = V3
        rc.clear_cache()
        try:
            restored = renv.deserialize(dumped, RS)
        finally:
            os.environ.pop(rc.ENV_VAR, None)
            rc.clear_cache()
        self.assertEqual(restored.enemy.mana, 2)
        self.assertEqual(restored.player.mana, 4)
        # 反证：不切配置时必须抛（状态不能跨配置混用）
        with self.assertRaises(fx.UnsupportedEffect):
            renv.deserialize(dumped, RS)

    def test_mana_is_public_in_observation_and_planner_state(self):
        """魔力是**公开**信息（它就是胜负判据）：观察与两个公开视图都要带上，但只在声明了 mana 时。"""
        state = _new_state()
        obs = renv.observe(state, RS, "player")
        self.assertEqual(obs["mana"], {"self": 4, "opponent": 4})
        planner = renv.public_planner_state(state, RS, "player")
        self.assertEqual(planner["mana"], {"self": 4, "opponent": 4})
        ui = renv.ui_public_view(state, RS, "player")
        self.assertEqual(ui["mana"], {"self": 4, "opponent": 4})
        # 重建出来的分析状态也要保住魔力（否则规划会把「还有几点魔力」忘掉）
        rebuilt = renv.state_from_public_planner(planner, RS, analysis_seed=7)
        self.assertEqual(rebuilt.player.mana, 4)
        self.assertEqual(rebuilt.enemy.mana, 4)

    def test_charge_action_gains_configured_energy(self):
        """聚能是独立动作类：回复量来自配置的 `energy.charge`，未知就抛。"""
        cfg = _v3()
        state = _new_state()
        before = state.player.field_pet.energy
        self.assertEqual(cfg.energy_charge, 5)
        action = [a for a in renv.legal_actions(state, RS, "player") if a.kind == ACTION_CHARGE]
        self.assertEqual(len(action), 1, "标准 PVP 的合法动作里必须**有**聚能（独立动作类）")
        renv._execute(state, RS, "player", action[0], cfg)
        self.assertEqual(state.player.field_pet.energy, min(cfg.energy_max, before + 5))
        event = [e for e in state.events if e.kind == "charge"][-1]
        self.assertEqual(event.detail["side"], "player")
        self.assertIn("EV-ENERGY-CHARGE", event.evidence)
        # 「聚能可否突破上限」台账明说未定 → 必须留一条 unsupported 记录，不许当成已知
        self.assertTrue(any("聚能" in row["what"] for row in state.unsupported), state.unsupported)
        # 反证：energy.charge 是 UNKNOWN(null) 时必须抛，而不是按 0 处理
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv._execute(state, RS, "player", action[0], replace(cfg, energy_charge=None))
        self.assertIn("energy.charge", str(ctx.exception))

    def test_surrender_is_allowed_in_standard_pvp_and_concedes(self):
        cfg = _v3()
        state = _new_state()
        legal = renv.legal_actions(state, RS, "player")
        self.assertTrue(any(a.kind == ACTION_SURRENDER for a in legal),
                        "标准 PVP 必须给出「投降」这个出口（它既无道具也无逃跑）")
        surrender = [a for a in legal if a.kind == ACTION_SURRENDER][0]
        renv._execute(state, RS, "player", surrender, cfg)
        self.assertEqual(state.result, "loss")
        self.assertEqual(state.phase, "ended")
        self.assertIn("surrender", [e.kind for e in state.events])
        # 语义没有台账支撑 → 必须留一条 unsupported 记录（不许当成已确认规则）
        self.assertTrue(any("投降" in row["what"] for row in state.unsupported), state.unsupported)
        # 反证：legacy 没声明 actions，因而没有这个动作类 —— 直接执行必须抛
        legacy_state = renv.reset(LEGACY_IDS_A, LEGACY_IDS_B, seed=3, rs=RS)
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv._execute(legacy_state, RS, "player", surrender)
        self.assertIn("没有声明 actions", str(ctx.exception))


# ── 3. 引擎：按 BattleMode 裁剪合法行动 ─────────────────────────────────


class ActionClippingTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()
        self.cfg = _v3()

    def tearDown(self):
        rc.clear_cache()

    def test_standard_pvp_has_no_item_and_no_escape(self):
        state = _new_state()
        self.assertTrue(state.player.items, "前提：引擎默认给了道具，否则这条判据是空转的")
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player")]
        self.assertNotIn(ACTION_ITEM, kinds, "标准 PVP 的合法动作里不得出现道具（回复药/净化药/能量果）")
        self.assertNotIn(ACTION_ESCAPE, kinds, "标准 PVP 的合法动作里不得出现逃跑")
        for item_id in ("回复药", "净化药", "能量果"):
            self.assertNotIn(item_id, json.dumps(renv.ui_legal_actions(state, RS, "player"), ensure_ascii=False),
                             f"{item_id} 不得出现在对外合法动作里")

    def test_standard_pvp_has_charge_and_surrender(self):
        state = _new_state()
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player")]
        self.assertIn(ACTION_CHARGE, kinds, "聚能必须是**独立动作类**并出现在合法动作里")
        self.assertIn(ACTION_SURRENDER, kinds, "投降必须出现在合法动作里")
        # 展示顺序 = 配置里 allowed_kinds 的顺序（去掉技能本身只出现一次的限制）
        ordered = [k for k in kinds if k not in (ACTION_SKILL, ACTION_SWITCH)]
        self.assertEqual(ordered, [ACTION_CHARGE, ACTION_SURRENDER],
                         f"聚能/投降的展示顺序应当跟 allowed_kinds 一致，实际 {kinds}")
        # 每个动作都补得上 label（不是内部标识符）
        for action in renv.legal_actions(state, RS, "player"):
            self.assertTrue(action.label(RS))

    def test_clipping_is_driven_by_the_config_not_hardcoded(self):
        """必红反证①：把 item 塞进 `allowed_kinds`，它就必须**真的**出现。

        只断言「标准 PVP 没有道具」的话，一个把 item 硬编码过滤掉的实现照样绿；
        这条反证把判据钉在配置上：配置允许 → 出现，配置禁止 → 不出现。
        """
        state = _new_state()
        allowed_with_item = replace(self.cfg,
                                    allowed_kinds=("skill", "charge", "switch", "surrender", "item"),
                                    forbidden_kinds=("escape",))
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player", allowed_with_item)]
        self.assertIn(ACTION_ITEM, kinds,
                      "配置把 item 写进 allowed_kinds 之后它必须出现 —— 否则「没有道具」不是因为配置")
        # 再把 escape 也放行（从 forbidden 里去掉），逃跑同样必须回来
        allowed_both = replace(
            self.cfg,
            allowed_kinds=("skill", "charge", "switch", "surrender", "item", "escape"),
            forbidden_kinds=())
        kinds2 = [a.kind for a in renv.legal_actions(state, RS, "player", allowed_both)]
        self.assertIn(ACTION_ITEM, kinds2)
        self.assertIn(ACTION_ESCAPE, kinds2,
                      "配置把 escape 从 forbidden 移进 allowed 之后它必须出现")
        # 最后：配置真正生效的那一份（磁盘上的 v3）依旧没有这两类
        kinds3 = [a.kind for a in renv.legal_actions(state, RS, "player", self.cfg)]
        self.assertNotIn(ACTION_ITEM, kinds3)
        self.assertNotIn(ACTION_ESCAPE, kinds3)

    def test_undeclared_kind_raises_when_unknown_kinds_are_not_allowed(self):
        """必红反证③：既不在 allowed、也不在 forbidden 的动作类必须**抛错**，不许静默放过。"""
        state = _new_state()
        strict = replace(self.cfg,
                         allowed_kinds=("skill", "charge", "switch", "surrender"),
                         forbidden_kinds=("escape",))
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv.legal_actions(state, RS, "player", strict)
        message = str(ctx.exception)
        self.assertIn("item", message)
        self.assertIn("unknown_kinds_allowed", message)
        self.assertIn("mobile_s4_candidate_v3", message, "错误必须点名是哪份配置")
        # 反证：把开关打开（配置显式放行未声明的类）→ 不再抛
        lax = replace(strict, unknown_kinds_allowed=True)
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player", lax)]
        self.assertIn(ACTION_ITEM, kinds)

    def test_declared_kind_the_engine_cannot_produce_fails_closed(self):
        """声明一个引擎产不出的动作类（struggle）→ 抛错，不静默跳过。"""
        state = _new_state()
        broken = replace(self.cfg, allowed_kinds=("skill", "switch", "struggle"))
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv.legal_actions(state, RS, "player", broken)
        self.assertIn("struggle", str(ctx.exception))
        # 前提自检：struggle 在**配置词汇表**里（schema.VALID_KINDS），但不在引擎会产出的清单里
        self.assertIn("struggle", VALID_KINDS)
        self.assertNotIn("struggle", renv.ACTION_KINDS_IMPLEMENTED)
        # 反证：把那个产不出的类去掉之后不许抛
        renv.legal_actions(state, RS, "player", replace(self.cfg, allowed_kinds=("skill", "switch")))

    def test_legacy_keeps_items_and_escape(self):
        """legacy 是 PVE/练习局：它没有声明 actions，因此**不裁剪**（道具与逃跑继续存在）。"""
        state = renv.reset(LEGACY_IDS_A, LEGACY_IDS_B, seed=3, rs=RS)
        kinds = [a.kind for a in renv.legal_actions(state, RS, "player")]
        self.assertIn(ACTION_ITEM, kinds)
        self.assertIn(ACTION_ESCAPE, kinds)
        self.assertNotIn(ACTION_CHARGE, kinds, "legacy 没有声明聚能，就不该凭空多出一个动作")
        self.assertNotIn(ACTION_SURRENDER, kinds)

    def test_action_kind_vocabulary_matches_the_schema_whitelist(self):
        """配置词汇表（rule_config）与引擎白名单（schema）必须一致 —— 两边各写一份就会漂。"""
        self.assertEqual(tuple(sorted(rc.KNOWN_ACTION_KINDS)), tuple(sorted(VALID_KINDS)))
        self.assertEqual(set(renv.ACTION_KINDS_IMPLEMENTED) | {"struggle"}, set(VALID_KINDS))

    def test_new_action_kinds_validate_their_required_fields(self):
        self.assertEqual(Action(kind=ACTION_CHARGE).kind, "charge")
        self.assertEqual(Action(kind=ACTION_SURRENDER).kind, "surrender")
        self.assertEqual(Action.from_dict({"kind": "charge"}).kind, "charge")
        self.assertEqual(Action.from_dict({"kind": "surrender"}).kind, "surrender")
        # 缺字段要抛（和 skill / switch / item 一样）
        for bad in ({"kind": "skill"}, {"kind": "switch"}, {"kind": "item"}, {"kind": "fuse"}):
            with self.subTest(payload=bad):
                with self.assertRaises(ValueError):
                    Action.from_dict(bad)
        with self.assertRaises(ValueError):
            Action(kind=ACTION_SKILL)          # 构造期就抛，不是等结算
        with self.assertRaises(ValueError):
            Action(kind=ACTION_SWITCH)
        # 反证：字段给全了就一个都不抛
        self.assertEqual(Action(kind=ACTION_SKILL, skill_id="skill_000576").kind, "skill")
        self.assertEqual(Action(kind=ACTION_SWITCH, target_index=1).kind, "switch")
        self.assertEqual(Action(kind=ACTION_ITEM, item_id="回复药").kind, "item")


# ── 4. legacy 逐位不变（没有 mana 这条概念）──────────────────────────────


class LegacyManaAbsenceTest(unittest.TestCase):
    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_legacy_state_has_no_mana_field_anywhere(self):
        state = renv.reset(LEGACY_IDS_A, LEGACY_IDS_B, seed=3, rs=RS)
        self.assertIsNone(state.player.mana)
        self.assertIsNone(state.enemy.mana)
        dumped = json.dumps(renv.serialize(state), ensure_ascii=False, sort_keys=True)
        self.assertNotIn('"mana"', dumped, "legacy 的序列化里不得出现 mana 键（8 条 golden 指纹靠它成立）")
        self.assertNotIn('"mana"', json.dumps(renv.observe(state, RS, "player"), ensure_ascii=False))
        self.assertNotIn('"mana"', json.dumps(renv.public_planner_state(state, RS, "player"), ensure_ascii=False))
        self.assertNotIn('"mana"', json.dumps(renv.ui_public_view(state, RS, "player"), ensure_ascii=False))
        restored = renv.deserialize(json.loads(dumped), RS)
        self.assertIsNone(restored.player.mana, "老存档没有 mana 键 → None，不是 0")

    def test_legacy_victory_is_still_decided_by_team_wipe(self):
        """legacy 的胜负判据仍然是「打光整队」，而且**没有**任何 mana 事件。"""
        state = renv.reset(LEGACY_IDS_A, LEGACY_IDS_B, seed=3, rs=RS)
        for pet in state.player.pets:
            pet.hp = 0
            pet.fainted = True
        renv._finish(state)
        self.assertEqual(state.result, "loss")
        self.assertNotIn("mana_loss", [e.kind for e in state.events])
        self.assertNotIn("mana_depleted",
                         [e.detail.get("reason") for e in state.events if e.kind == "game_end"])
        # 魔力结算的入口在 legacy 下必须是**空操作**（不是「按 0 扣」）
        before = [e.kind for e in state.events]
        renv._settle_faint_mana(state, RS, rc.get_rule_config(), "player")
        renv._finish_mana_depletion(state, rc.get_rule_config())
        self.assertEqual([e.kind for e in state.events], before)

    def test_fake_mana_on_legacy_would_move_the_fingerprint(self):
        """必红反证③：给 legacy 的序列化补一个假 `mana: 0`，指纹必须变。

        这就是「legacy 逐位不变」这条判据的牙齿：golden 指纹是改动前抓的
        （`test_turn_order_fail_closed.LegacyBitExactGoldenTest`），
        任何多写出来的键都会让它当场变红。
        """
        state = renv.reset(LEGACY_IDS_A, LEGACY_IDS_B, seed=3, rs=RS)
        clean = renv.serialize(state)
        before = _digest(clean)
        faked = json.loads(json.dumps(clean))
        faked["player"]["mana"] = 0
        self.assertNotEqual(_digest(faked), before,
                            "补一个假 mana 之后指纹必须变 —— 否则 golden 指纹抓不到「凭空多了字段」")
        # 再确认一遍：干净的版本里确实没有这个键（否则上面那条比较没有意义）
        self.assertNotIn("mana", clean["player"])
        self.assertNotIn("mana", clean["enemy"])

    def test_default_rule_config_module_view_is_unchanged(self):
        self.assertEqual(renv.ENERGY_MAX, 6)
        self.assertEqual(renv.ENERGY_REGEN_PER_TURN, 1)
        cfg = rc.get_rule_config()
        self.assertFalse(cfg.has_mana)
        self.assertFalse(cfg.has_actions)


if __name__ == "__main__":       # pragma: no cover - 手工跑
    unittest.main()
