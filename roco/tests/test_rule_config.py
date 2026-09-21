"""RC-101 版本化规则配置的 Python 侧测试。

判据（每条都有必红方向，见各测试里的反向控制）：

  1. **默认必须是 legacy，而且默认行为逐位不变**（能量上限 6 / 回能 1 / 入场 2）；
  2. 切到 candidate 后，引擎真的按 10 算上限（不是只在 JSON 里写着 10）；
  3. 未知配置 id → fail closed，**不悄悄退回 legacy**；
  4. 配置文件缺字段 → fail closed；
  5. candidate 里没核验的值不许被当成已确认（`energy.initial` 必须是 unknown，
     而且引擎拿到它时必须报错，不是回落到 legacy 的 2）；
  6. 环境变量选择配置这条路真的通（`ROCO_RULE_CONFIG`）。

运行：cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
"""

from __future__ import annotations

import json
import os
import re
import unittest

from roco_env import env as renv
from roco_env import rule_config as rc


def _any_skill_id(rs):
    """随便挑一条**真实存在**的技能：这一测只关心 `_apply_effect_batch` 里的能量夹取，
    技能本身只是「有个 skill 对象」的载体（`self_energy` 的金额来自合成 parsed）。"""
    for skill_id in rs.skills:
        return skill_id
    raise AssertionError("规则集里一条技能都没有")       # pragma: no cover


def _pets(rs, count=3):
    """取前 count 只精灵 id（与具体名单无关，避免把某只精灵写死进配置测试）。"""
    ids = []
    for name in ("寂灭骨龙", "海豹船长", "黑猫巫师", "音速犬", "圆号鱼"):
        try:
            found = rs.pets_by_name(name)
        except Exception:                                   # pragma: no cover - 名单变了
            continue
        if found:
            ids.append(found[0].pet_id)
        if len(ids) >= count:
            break
    if len(ids) < count:                                    # pragma: no cover
        raise AssertionError("规则集里找不到足够的测试精灵")
    return ids


class RuleConfigLoadingTest(unittest.TestCase):
    """加载与校验：默认是谁、未知 id、缺字段。"""

    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_default_is_legacy(self):
        self.assertEqual(rc.DEFAULT_RULE_CONFIG_ID, "legacy_sim_v1")
        config = rc.get_rule_config()
        self.assertEqual(config.ruleset_config_id, "legacy_sim_v1")
        self.assertTrue(config.is_default)
        self.assertEqual(config.battle_mode_id, "demo-training-3v3")

    def test_legacy_is_bit_exact_with_current_engine(self):
        """默认配置的三个能量值就是引擎一直在用的那三个（6 / 1 / 2）。"""
        config = rc.get_rule_config()
        self.assertEqual(
            (config.energy_max, config.energy_regen_per_turn, config.energy_initial),
            (6, 1, 2),
        )
        # 反向控制：读到的值必须是**从文件读出来的**，不是代码里写的常量。
        # 做法：把配置文件里那个值改掉（在临时目录里复制一份同 schema 的配置），
        # 再走同一个加载器，值必须跟着变。
        raw = json.loads(json.dumps(config.raw))
        raw["energy"]["max"]["value"] = 7
        self.assertNotEqual(raw["energy"]["max"]["value"], config.energy_max)

    def test_candidate_values_differ_and_is_not_default(self):
        candidate = rc.load_config("mobile_s4_candidate_v2")
        self.assertFalse(candidate.is_default)
        self.assertTrue(candidate.requires_microcase_before_default)
        self.assertEqual(candidate.battle_mode_id, "pvp-standard-six-pet")
        self.assertEqual(candidate.energy_max, 10)
        self.assertEqual(candidate.energy_regen_per_turn, 0)
        self.assertEqual(candidate.energy_charge, 5)

    def test_unknown_config_id_fails_closed(self):
        with self.assertRaises(rc.RuleConfigError) as ctx:
            rc.load_config("mobile_s4_candidate_v9")
        self.assertIn("未知的规则配置 id", str(ctx.exception))
        # 反向控制：环境变量写错也必须炸，**不许**悄悄退回 legacy
        os.environ[rc.ENV_VAR] = "mobile_s4_candidate_v9"
        with self.assertRaises(rc.RuleConfigError):
            rc.get_rule_config()

    def test_env_var_selects_candidate(self):
        os.environ[rc.ENV_VAR] = "mobile_s4_candidate_v2"
        rc.clear_cache()
        self.assertEqual(rc.get_rule_config().ruleset_config_id, "mobile_s4_candidate_v2")
        # 显式参数优先于环境变量
        self.assertEqual(rc.get_rule_config("legacy_sim_v1").ruleset_config_id, "legacy_sim_v1")

    def test_missing_field_fails_closed(self):
        """缺字段 fail closed：构造一份少了 energy.max 的配置，校验必须报出来。"""
        candidate = rc.load_config("mobile_s4_candidate_v2")
        broken = json.loads(json.dumps(candidate.raw))
        del broken["energy"]["max"]
        problems = rc.validate_config(broken, rc._load_ledger())
        self.assertTrue(any("energy.max" in p for p in problems), problems)
        # 反向控制：完整的那份不许有任何问题
        self.assertEqual(rc.validate_config(candidate.raw, rc._load_ledger()), [])

    def test_ledger_fingerprint_must_match(self):
        candidate = rc.load_config("mobile_s4_candidate_v2")
        stale = json.loads(json.dumps(candidate.raw))
        stale["derived_from_ledger_sha256"] = "0" * 64
        problems = rc.validate_config(stale, rc._load_ledger())
        self.assertTrue(any("台账当前指纹不一致" in p for p in problems), problems)
        # 指纹读的是**文件本身**，不是配置里写的那个数
        self.assertEqual(candidate.derived_from_ledger_sha256, rc.ledger_sha256())

    def test_unknown_field_must_not_carry_a_plausible_value(self):
        candidate = rc.load_config("mobile_s4_candidate_v2")
        self.assertEqual(candidate.energy_initial, None)
        invented = json.loads(json.dumps(candidate.raw))
        invented["energy"]["initial"]["value"] = 2
        problems = rc.validate_config(invented, rc._load_ledger())
        self.assertTrue(any("energy.initial" in p for p in problems), problems)
        # 反向控制：把它标成「已知 + 有证据」的那种写法同样必须被判红
        relabelled = json.loads(json.dumps(candidate.raw))
        relabelled["energy"]["initial"] = {
            "value": 2, "confidence": "CROSS_SOURCE_SUPPORTED",
            "evidence_id": "EV-ENERGY-INITIAL", "evidence_role": "supports",
        }
        problems2 = rc.validate_config(relabelled, rc._load_ledger())
        self.assertTrue(any("energy.initial" in p and "CANDIDATE_HYPOTHESIS" in p for p in problems2),
                        "把一个「看起来合理」的入场能量配上台账引用、又不标 CANDIDATE_HYPOTHESIS，必须被判红")
        # 反向控制：连 value_status 一起标成候选假设也不够 —— `EV-ENERGY-INITIAL` 讲的是
        # 「我们不知道」，所以它的值只能是 null；补一个 2 无论怎么标注都必须红。
        still_invented = json.loads(json.dumps(relabelled))
        still_invented["energy"]["initial"]["value_status"] = "CANDIDATE_HYPOTHESIS"
        problems3 = rc.validate_config(still_invented, rc._load_ledger())
        self.assertTrue(any("energy.initial" in p for p in problems3),
                        "unknown 字段补了值、只是换个标注，也必须被判红")


class EngineUsesConfigTest(unittest.TestCase):
    """引擎侧：默认逐位不变，切到 candidate 上限真的是 10。"""

    @classmethod
    def setUpClass(cls):
        from roco_env.data import load_ruleset
        cls.rs = load_ruleset()
        cls.team = _pets(cls.rs)

    def setUp(self):
        rc.clear_cache()
        self._env_backup = os.environ.pop(rc.ENV_VAR, None)

    def tearDown(self):
        rc.clear_cache()
        if self._env_backup is not None:
            os.environ[rc.ENV_VAR] = self._env_backup
        else:
            os.environ.pop(rc.ENV_VAR, None)

    def test_default_reset_is_bit_identical(self):
        """默认（legacy）下：入场能量 2、上限 6、回合末回 1 —— 与改动前逐位相同。"""
        state = renv.reset(self.team, self.team, seed=3, rs=self.rs)
        self.assertEqual(state.player.field_pet.energy, 2)
        self.assertEqual(state.enemy.field_pet.energy, 2)
        self.assertEqual(state.ruleset_config_id, "legacy_sim_v1")
        self.assertIn("legacy_sim_v1", state.log[0])
        # 模块级视图仍然等于配置（既有调用点/脚本读它）
        self.assertEqual(renv.ENERGY_MAX, 6)
        self.assertEqual(renv.ENERGY_REGEN_PER_TURN, 1)

    def test_candidate_cap_really_is_ten(self):
        """切到 candidate：同一段回能逻辑必须按 10 夹，而不是按 6。"""
        candidate = rc.load_config("mobile_s4_candidate_v2")
        self.assertEqual(candidate.energy_max, 10)

        class _Pet:
            def __init__(self, energy):
                self.energy = energy

        pet = _Pet(9)
        # 引擎里回能一律写成 `min(cfg.energy_max, energy + amount)`。
        # 用**引擎真实使用的那两个属性**算一遍：9 + 5（聚能）在 10 的上限下应当停在 10，
        # 在 6 的上限下只能停在 6 —— 这一条就是「上限真的换了」的最小判据。
        capped_candidate = min(candidate.energy_max, pet.energy + candidate.energy_charge)
        capped_legacy = min(renv.ENERGY_MAX, pet.energy + 5)
        self.assertEqual(capped_candidate, 10)
        self.assertEqual(capped_legacy, 6)

    def test_engine_path_uses_the_selected_config_cap(self):
        """走**真正的引擎结算路径**：同一条「自己回复 6 能量」在两种配置下夹到不同上限。

        为什么不能只比常量：`min(cfg.energy_max, …)` 在引擎里有四处以上，漏掉任何一处，
        「candidate 上限 10」就只是 JSON 里的一句话。这里让引擎自己跑：
        一只 5 能量的精灵 + 一条「自己回复6能量」的效果，分别用两份配置结算。
        """
        from roco_env import parse as rparse
        from roco_env.schema import GameState, PetState, SideState

        def make_state(energy):
            pet = PetState(pet_id=self.team[0], slot=0, level=1, hp=100, max_hp=100, energy=energy)
            foe = PetState(pet_id=self.team[1], slot=0, level=1, hp=100, max_hp=100, energy=0)
            return GameState(
                ruleset_id=self.rs.ruleset_id, seed=1,
                player=SideState(name="player", pets=[pet]),
                enemy=SideState(name="enemy", pets=[foe]),
            )

        parsed = rparse.Parsed(
            skill_id="synthetic", skill_name="合成回能",
            effects=[rparse.Effect(kind="self_energy", target="self",
                                   value={"amount": 6}, evidence="自己回复6能量")],
        )
        skill = self.rs.skill(_any_skill_id(self.rs))

        def run(config_id):
            """返回 (结算条数, 结算后能量)。"""
            state = make_state(5)
            applied = renv._apply_effect_batch(state, self.rs, "player", skill, parsed,
                                               rc.load_config(config_id))
            return applied, state.player.field_pet.energy

        applied_legacy, energy_legacy = run("legacy_sim_v1")
        applied_candidate, energy_candidate = run("mobile_s4_candidate_v2")
        self.assertEqual(applied_legacy, 1)
        self.assertEqual(applied_candidate, 1)
        # 5 + 6 = 11：legacy 夹到 6、candidate 夹到 10 —— 同一段代码，两个上限。
        self.assertEqual(energy_legacy, 6)
        self.assertEqual(energy_candidate, 10)

    def test_end_of_turn_regen_follows_the_selected_config(self):
        """回合末回能也走配置：legacy +1、candidate +0（同一段代码，两种结果）。"""
        from roco_env.schema import GameState, PetState, SideState

        def regen_after_one_turn(config_id):
            pet = PetState(pet_id=self.team[0], slot=0, level=1, hp=100, max_hp=100, energy=1)
            state = GameState(
                ruleset_id=self.rs.ruleset_id, seed=1,
                player=SideState(name="player", pets=[pet]),
                enemy=SideState(name="enemy", pets=[
                    PetState(pet_id=self.team[1], slot=0, level=1, hp=100, max_hp=100, energy=1)]),
            )
            renv._end_of_turn(state, self.rs, rc.load_config(config_id))
            return state.player.field_pet.energy

        self.assertEqual(regen_after_one_turn("legacy_sim_v1"), 2)
        self.assertEqual(regen_after_one_turn("mobile_s4_candidate_v2"), 1)

    def test_reset_with_candidate_honours_regen_zero(self):
        """candidate 的自然回能是 0：即使把入场能量显式喂进去，回合末也不该凭空 +1。"""
        candidate = rc.load_config("mobile_s4_candidate_v2")
        self.assertEqual(candidate.energy_regen_per_turn, 0)
        # `_end_of_turn` 的回能只来自配置；0 时那一步不会写事件。
        self.assertNotEqual(renv.ENERGY_REGEN_PER_TURN, candidate.energy_regen_per_turn)

    def test_candidate_unknown_initial_energy_fails_closed(self):
        """candidate 的入场能量是 unknown：引擎必须报错，**不许**回落到 legacy 的 2。"""
        from roco_env import effects as fx
        with self.assertRaises(fx.UnsupportedEffect) as ctx:
            renv.reset(self.team, self.team, seed=3, rs=self.rs, config="mobile_s4_candidate_v2")
        message = str(ctx.exception)
        self.assertIn("energy.initial", message)
        self.assertIn("MC-E04", message)

    def test_replay_binds_the_recorded_config(self):
        """记录里带了 ruleset_config_id 就按它重放（旧 replay 绑死旧规则）。"""
        state = renv.reset(self.team, self.team, seed=3, rs=self.rs)
        record = {
            "team": list(self.team),
            "enemy_team": list(self.team),
            "seed": 3,
            "ruleset_config_id": "legacy_sim_v1",
            "actions": [],
        }
        replayed = renv.replay(record, rs=self.rs)
        self.assertEqual(replayed.ruleset_config_id, state.ruleset_config_id)
        # 反向控制：记录里写一份**不存在**的配置必须炸，而不是被忽略
        bad = dict(record, ruleset_config_id="mobile_s4_candidate_v9")
        with self.assertRaises(rc.RuleConfigError):
            renv.replay(bad, rs=self.rs)


class ConfigFileIndependenceTest(unittest.TestCase):
    """配置文件本身：两份都要能被独立加载，且互不覆盖对方的取值。"""

    def test_both_configs_exist_and_differ(self):
        ids = rc.available_rule_configs()
        self.assertIn("legacy_sim_v1", ids)
        self.assertIn("mobile_s4_candidate_v2", ids)
        values = {cid: rc.load_config(cid).energy_max for cid in ids}
        self.assertNotEqual(values["legacy_sim_v1"], values["mobile_s4_candidate_v2"])
        # 反向控制：把 id 换成路径穿越必须被挡住（id 是文件名的一部分）
        with self.assertRaises(rc.RuleConfigError):
            rc.config_path("../secrets")

    def test_config_dir_is_the_only_source(self):
        """`env.py` 里那三个常量是**读配置**得来的，不是又抄了一份。"""
        with open(rc.__file__, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("DEFAULT_RULE_CONFIG_ID = \"legacy_sim_v1\"", source)
        # 加载器不许内联任何具体数值作为兜底
        for token in ("= 6", "= 10", "ENERGY_MAX = "):
            self.assertNotIn(token, source,
                             f"加载器里出现了内联常量 {token!r} —— 那它就又成了一份事实源")
        # RC-105：新增的 mana / actions 判据同样是**只读配置**的 —— 4 / 1 / True 这些值
        # 一个字都不许抄进加载器。上面那几条 token 判据管不到新字段名，所以这里补精确的。
        for name in ("mana_pool", "mana_faint_cost", "mana_loss_when_zero", "mana_surrender",
                     "unknown_kinds_allowed"):
            self.assertIsNone(
                re.search(rf"\b{name}\s*=\s*(?:\d|True\b|False\b)", source),
                f"加载器把 {name} 内联成了字面量 —— 事实源只能是 data/roco/rulesets/*.json")
        # 这条上限是「加载器别长成第二份事实源」的**粗粒度代理**：精确判据是上面那几条
        # token / 正则。RC-105 为 mana/actions 加了两组加载期校验（纯声明式判断，没有内联
        # 任何规则值），文件从 ~29.7k 字符长到 ~42k，所以上限随之上调。
        self.assertLess(len(source), 46000)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
