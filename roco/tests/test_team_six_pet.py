"""阵容评估的**规模口径**（2026-09-25 人类口径：「我这六只怎么样」问不出来）。

背景：`evaluate_team()` 原来硬判 `len(team) != 3` 就抛「训练场评估按 3 只队伍进行；
完整 6 只阵容在第 5 周扩展」⇒ 玩家问「我这六只怎么样」连评估都进不去，而它自己的
六只阵容（`pvp-standard-six-pet.parameters.team_size = 6`）在登记表里明明白白写着。

现在的口径：**按登记表里各模式声明过的规模收**（`declared_team_sizes()` = 2/3/6），
不在其中的规模一律 refuse（fail closed，不猜）。特征函数本来就是按队伍长度聚合的
（比值口径），所以 6 只走的是**同一套特征**，不是另写一份算法。

判据形状：① 规模表来自登记表（不是这里写死的）；② 六只评得出来、且**不是胜率/概率**、
每条特征都带出处；③ **三只的结果逐位不变**（回归钉）；④ 其它规模被拒且**列出支持哪些**。
"""
import unittest

from roco_env import data, team
from roco_env.service import RocoService


class TeamSizeTest(unittest.TestCase):
    def setUp(self):
        self.rs = data.load_ruleset()
        self.three = ["pet_000012", "pet_000062", "pet_000100"]
        self.six = self.three + ["pet_000112", "pet_000118", "pet_000124"]

    # ① 规模表来自登记表
    def test_declared_sizes_come_from_the_registry(self):
        self.assertEqual(team.declared_team_sizes(), [2, 3, 6])
        # `pve-camp` 的 team_size 是 null（营地没有上场队伍）⇒ 不许被当成"0 只也是一种规模"
        self.assertNotIn(0, team.declared_team_sizes())
        self.assertNotIn(None, team.declared_team_sizes())

    # ② 六只评得出来，而且不是胜率
    def test_six_pet_evaluation_works(self):
        out = team.evaluate_team(self.six, rs=self.rs)
        self.assertEqual(len(out.team), 6)
        self.assertEqual(len(out.features), 6)
        self.assertEqual(
            sorted(out.coverage), ["damage_balance", "energy", "roles", "speed", "types"])
        text = " ".join(out.strengths + out.weaknesses)
        for banned in ("胜率", "概率", "百分", "%"):
            self.assertNotIn(banned, text, f"阵容结论里出现了本仓库没有的数据口径：{banned}")
        # 每条特征都要带出处（引擎侧的证据串），否则等于"结论没有来源"。
        # **已知（既有，不是这次改口径引入的）**：`gaps` 在三只时也不带 evidence
        # （实测三只：types 40 / roles 3 / speed 3 / damage 20 / energy 40 / **gaps 0**）。
        # 这里把它**如实钉住**而不是放过：哪天补上了这条会红，提醒改这里。
        by_name = {f.name: f for f in out.features}
        for name in ("types", "roles", "speed", "damage", "energy"):
            self.assertTrue(by_name[name].evidence, f"特征 {name} 没有 evidence")
        self.assertEqual(by_name["gaps"].evidence, [],
                         "gaps 现在确实不带 evidence（既有限制）；补上了就把这条改成 assertTrue")

    # ③ 三只的结果逐位不变（这次改口径**不许**动到既有行为）
    def test_three_pet_result_is_bit_identical(self):
        out = team.evaluate_team(self.three, rs=self.rs)
        self.assertEqual(out.coverage, {
            "damage_balance": 0.4, "energy": 0.714, "roles": 1.0, "speed": 0.288, "types": 0.556})
        self.assertEqual(out.strengths, [
            "职责覆盖齐全：输出、承伤、控制、回复、驱散、增益", "30 个低能耗技能，能量循环稳"])
        self.assertEqual(out.weaknesses, ["被 9 种属性克制，对位面偏窄"])

    # ④ 登记表里声明过的规模都收（2 是双打），没声明的被拒且**说清支持哪些**
    def test_other_sizes_refused_with_the_supported_list(self):
        # 2 只：`pvp-territory-trial-2v2` 声明的规模 ⇒ 也要收（不是"只能 3 或 6"）
        two = team.evaluate_team(self.six[:2], rs=self.rs)
        self.assertEqual(len(two.team), 2)
        for size, squad in ((1, self.six[:1]), (4, self.six[:4]), (5, self.six[:5]),
                            (7, self.six + [self.six[0]])):
            with self.assertRaises(ValueError) as ctx:
                team.evaluate_team(squad, rs=self.rs)
            message = str(ctx.exception)
            self.assertIn("[2, 3, 6]", message, f"{size} 只被拒时要说清支持哪些规模：{message}")
            self.assertIn(f"实际 {size} 只", message)

    # ⑤ 教练走的那条路（service → evaluate_team）六只也是 200，四只是 400
    def test_service_endpoint_accepts_six_and_refuses_four(self):
        svc = RocoService(served_ruleset_id=self.rs.ruleset_id)
        body = {"ruleset_id": self.rs.ruleset_id, "state_version": 0}
        status, env = svc.team_evaluate({**body, "team": self.six})
        self.assertEqual(status, 200, env)
        self.assertTrue(env.get("ok"), env)
        self.assertEqual(len((env.get("result") or {}).get("features") or []), 6)
        status4, env4 = svc.team_evaluate({**body, "team": self.six[:4]})
        self.assertEqual(status4, 400, env4)
        self.assertIn("[2, 3, 6]", str(env4.get("error")))


if __name__ == "__main__":
    unittest.main()
