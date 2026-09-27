"""RC-404 代表性回归集的守卫。

这一组钉四件事（每条都有必红方向）：
  ① **空转不算通过**：每个场景声明的期望证据必须真的出现（`expect_kinds`），
     声明「找一条带某机制的精灵」时那条技能必须**真的用出来过**；
  ② **不可达要如实登记**：数据里根本没有精灵的规范配招带某机制时，进 `unreachable`
     并写明原因——「没出现在报告里」与「登记为不可达」是两件事；
  ③ **指纹可比对**：`check_against()` 必须能抓到终局摘要或事件分布的变化；
  ④ **确定性**：同一份输入跑两遍，指纹逐字节相同；
  ⑤ **磁盘上那份产物不许过期**（2026-09-23 补）：`reports/roco/rc404/regression-set.json`
     必须与「现在重算」一致 —— 判据 ③ 只在内存里比两次构建，**从不看磁盘**，
     于是产物可以在没人发现的情况下落后于引擎（我自己就踩到：跑 `--check` 时用了
     CWD 相对路径，检查的是一个不存在的文件，真正的产物一个字都没动）。
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata       # noqa: E402
from roco_env import regression as reg   # noqa: E402

RS = rdata.load_ruleset()


class RegressionSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = reg.build_regression_set(RS)
        cls.rows = {row["id"]: row for row in cls.report["scenarios"]}

    def test_no_vacuous_scenario(self):
        """期望证据缺失必须进 `problems` —— 这条红了说明有场景在空转。"""
        self.assertEqual(self.report["problems"], [], f"有场景空转：{self.report['problems']}")

    def test_expectations_actually_appeared(self):
        for scenario in reg.SCENARIOS:
            row = self.rows[scenario["id"]]
            if row.get("unreachable"):
                self.assertTrue(any("规范配招" in reason for reason in row["unreachable"]))
                continue
            for want in scenario.get("expect_kinds", []):
                self.assertGreater(row["event_kinds"].get(want, 0), 0,
                                   f"{scenario['id']} 缺期望证据 {want}")
            if scenario.get("find_lead"):
                self.assertIn(row["lead_skill"], row["used_skills"],
                              f"{scenario['id']} 找到的首发技能一次都没用出来")

    def test_deterministic(self):
        again = reg.build_regression_set(RS)
        self.assertEqual(json.dumps(again, ensure_ascii=False, sort_keys=True),
                         json.dumps(self.report, ensure_ascii=False, sort_keys=True))

    def test_type_sweep_covers_every_registered_type(self):
        """18 个单属性各一条场景，且**相性倍率真的被算过**（否则属性表是没用的）。"""
        sweep = [row for row in self.report["scenarios"] if row["id"].startswith("type-sweep-")]
        self.assertEqual(len(sweep), 18, f"18 个属性应当各有一条扫描场景，实际 {len(sweep)}")
        multipliers = {value for row in sweep for value in row.get("type_multipliers", [])}
        self.assertTrue(any(v > 1.0 for v in multipliers), f"没有出现克制倍率：{sorted(multipliers)}")
        self.assertTrue(any(v < 1.0 for v in multipliers), f"没有出现抵抗倍率：{sorted(multipliers)}")
        self.assertIn(1.0, multipliers, "没有中性倍率，说明扫描没真的打到过")
        for row in sweep:
            self.assertTrue(row["type_multipliers"], f"{row['id']} 一次伤害都没记到")

    def test_legacy_scenario_is_in_the_set(self):
        """迁移夹具那条必须在：legacy 的行为也要有代表性场景兜着。"""
        legacy = [row for row in self.report["scenarios"] if row["config"] == reg.LEGACY]
        self.assertEqual(len(legacy), 1, "至少要有一条 legacy 场景")
        self.assertGreater(legacy[0]["event_kinds"].get("damage", 0), 0)


class SpeedDimensionTest(unittest.TestCase):
    """速度层次那条**必须真的在量速度**。

    反证方向：把两边对调（慢的给玩家）⇒ 先手方必须整体翻转。
    如果对调后仍然是「玩家先手居多」，那这条场景量的就不是速度，
    而是别的什么（例如动作顺序与选择器耦合），`expect_first_damage` 就成了摆设。
    """

    @classmethod
    def setUpClass(cls):
        cls.scenario = next(row for row in reg.SCENARIOS if row["id"] == "speed-order")
        cls.forward = reg.run_scenario(RS, cls.scenario)
        cls.swapped = reg.run_scenario(RS, dict(
            cls.scenario, id="speed-order-swapped",
            team_a=cls.scenario["team_b"], team_b=cls.scenario["team_a"],
            expect_first_damage="enemy"))

    @staticmethod
    def _lead(row, side):
        return sum(1 for value in row["first_damage_by_turn"].values() if value == side)

    def test_faster_side_acts_first_overall(self):
        self.assertGreater(self._lead(self.forward, "player"), self._lead(self.forward, "enemy"),
                           f"130 速那侧没有先手居多：{self.forward['first_damage_by_turn']}")

    def test_swapping_sides_flips_the_lead(self):
        self.assertGreater(self._lead(self.swapped, "enemy"), self._lead(self.swapped, "player"),
                           f"对调后没有翻转 ⇒ 这条量的不是速度：{self.swapped['first_damage_by_turn']}")
        self.assertLess(self._lead(self.swapped, "player"), self._lead(self.forward, "player"))

    def test_swapped_scenario_is_still_clean(self):
        """对调后也不能空转（`expect_first_damage='enemy'` 同样要被满足）。"""
        self.assertEqual(self.swapped["problems"], [], self.swapped["problems"])

    def test_tie_is_reproducible(self):
        """同速平手：`random_seeded` 是引擎权宜，**至少要可复现**，否则指纹毫无意义。"""
        tie = next(row for row in reg.SCENARIOS if row["id"] == "speed-tie")
        first, second = reg.run_scenario(RS, tie), reg.run_scenario(RS, tie)
        self.assertEqual(first["state_digest"], second["state_digest"])
        self.assertEqual(first["first_damage_by_turn"], second["first_damage_by_turn"])


class DiskArtifactIsFreshTest(unittest.TestCase):
    """⑤ 磁盘上的回归产物必须与「现在重算」一致（忽略 `generated_at`）。"""

    ARTIFACT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "reports", "roco", "rc404", "regression-set.json")

    def test_disk_artifact_matches_a_fresh_build(self):
        self.assertTrue(os.path.exists(self.ARTIFACT),
                        f"回归产物不存在：{self.ARTIFACT}；先跑 python3 -m roco_env.regression")
        with open(self.ARTIFACT, encoding="utf-8") as handle:
            on_disk = json.load(handle)
        fresh = reg.build_regression_set(RS)

        def strip(doc):
            clone = json.loads(json.dumps(doc))
            clone.pop("generated_at", None)
            return clone

        disk_rows = {row["id"]: row for row in strip(on_disk).get("scenarios", [])}
        fresh_rows = {row["id"]: row for row in strip(fresh).get("scenarios", [])}
        self.assertEqual(sorted(disk_rows), sorted(fresh_rows), "场景清单对不上")
        stale = [sid for sid in fresh_rows
                 if json.dumps(disk_rows[sid], sort_keys=True) != json.dumps(fresh_rows[sid], sort_keys=True)]
        self.assertEqual(stale, [],
                         "磁盘上的回归指纹已经过期（引擎改了、产物没重建）："
                         f"{stale[:5]} …；跑 `cd roco && PYTHONPATH=src python3 -m roco_env.regression"
                         " --out ../reports/roco/rc404/regression-set.json` 重建，并把变化写进文档")
        self.assertEqual(json.dumps(strip(on_disk).get("unreachable"), sort_keys=True),
                         json.dumps(strip(fresh).get("unreachable"), sort_keys=True),
                         "不可达清单与现在重算不一致")


class CheckAgainstTest(unittest.TestCase):
    """反证：指纹变了必须被抓到（否则这套回归集没有牙）。"""

    def setUp(self):
        self.report = reg.build_regression_set(RS)

    def test_identical_reports_have_no_problems(self):
        self.assertEqual(reg.check_against(self.report, reg.build_regression_set(RS)), [])

    def test_tampered_digest_is_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"][0]["state_digest"] = "0" * 64
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("终局指纹变了" in row for row in problems), problems)

    def test_tampered_event_kinds_are_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"][0]["event_kinds"]["damage"] = 999
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("事件分布变了" in row for row in problems), problems)

    def test_missing_scenario_is_caught(self):
        tampered = json.loads(json.dumps(self.report))
        tampered["scenarios"] = tampered["scenarios"][1:]
        # 磁盘上的指纹表少了一个场景 ⇒ 重跑时它是「新的」，必须提示重新生成指纹表。
        problems = reg.check_against(tampered, self.report)
        self.assertTrue(any("是新的" in row or "消失了" in row for row in problems), problems)


class UnreachableRegistryTest(unittest.TestCase):
    """不可达维度必须出现在**顶层** `unreachable` 里，且理由是现算的。

    反证方向：把 `probe_unreachable()` 的贡献从顶层清单里去掉 ⇒ 这里必须红。
    早先真的漏过：`unreachable` 被重复赋值，探针结果只活在子结构里。
    """

    @classmethod
    def setUpClass(cls):
        cls.report = reg.build_regression_set(RS)
        cls.unreachable = cls.report["unreachable"]

    def test_probes_land_in_top_level_list(self):
        probed = reg.probe_unreachable(RS)
        self.assertTrue(probed, "探针一条都没算出来：这条守卫自己就是空转的")
        for row in probed:
            hit = [line for line in self.unreachable if line.startswith(row["dimension"] + "：")]
            self.assertEqual(len(hit), 1, f"{row['dimension']} 没在顶层 unreachable 里出现恰好一次：{self.unreachable}")
            self.assertIn(row["reason"], hit[0])
            self.assertIn(row["evidence"], hit[0])

    def test_swift_and_transmission_are_named_with_evidence(self):
        """迅捷/传动是当前**真正**驱动不了的维度：必须点名并带上「提了几条、建模几条」。"""
        for name in ("迅捷", "传动"):
            line = next((row for row in self.unreachable if row.startswith(name + "：")), None)
            self.assertIsNotNone(line, f"{name} 没有登记为不可达：{self.unreachable}")
            self.assertRegex(line, r"提到它.{0,3}但解析器一条都没建模|根本没有提到它")

    def test_evidence_numbers_are_recomputed_not_hardcoded(self):
        """把判据反过来验：真去数一遍 desc，探针给的数字必须与现场数出来的一致。"""
        for row in reg.probe_unreachable(RS):
            name = row["dimension"]
            counted = 0
            for pet in RS.pets.values():
                for sid in (RS.candidate_moveset(pet.pet_id) or ()):
                    skill = RS.skills.get(sid)
                    if skill is not None and name in (skill.desc or ""):
                        counted += 1
            self.assertIn(str(counted), row["evidence"],
                          f"{name} 的条数是写死的？现场数出 {counted}，报告写的是「{row['evidence']}」")

    def test_unreachable_change_is_caught(self):
        """反证：清单变了（新出现 / 悄悄消失）必须被 `check_against` 抓到。"""
        gone = self.report["unreachable"][-1]
        name = gone.split("：")[0]
        # 方向 A：磁盘上的旧表有它，重跑结果不再登记 ⇒ 必须问「是修好了还是漏登记了」。
        older = dict(self.report, unreachable=list(self.report["unreachable"]) + [f"{name}·已消失：理由｜证据"])
        problems = reg.check_against(older, self.report)
        self.assertTrue(any("不再登记" in row for row in problems), problems)

        # 方向 B：磁盘上没有它，重跑冒出来 ⇒ 必须提示补场景或重新生成指纹表。
        added = list(self.report["unreachable"]) + ["凭空多出来的维度：理由｜证据"]
        problems = reg.check_against(self.report, dict(self.report, unreachable=added))
        self.assertTrue(any("新出现不可达" in row for row in problems), problems)
