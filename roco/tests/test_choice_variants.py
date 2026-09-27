"""RC-401 批次七（**只到解析层**）：选择（术语 3019）的两条分支。

术语 3019 的原话是「可以从2个效果中选择1个使用。（2个效果视为相同技能，分别记为「明」和「暗」）」，
所以「选择：A 或 B」是一条技能、两个效果，用的时候二选一。

为什么这一轮**只做解析层**：结算要先回答「玩家选了哪一条」这个动作字段（`Action.variant`）
怎么传、AI 策略替自己那一方怎么选 —— 那是结算层的事，得连着服务端公开视图与策略一起改。
本轮交付的是那之前必须钉死的一半：**结构读出来、读不全的具名登记、没有配置声明时逐位不变**。

判据（每条都带必红方向）：
  ① 19 条带「选择：」的技能都拆成两条，第一条记「明」、第二条记「暗」（证据源是术语 3019）；
  ② **目标判不出来就不发效果**（反证：默认成敌方会把「物攻+90%」变成给对手加攻击）；
  ③ **并列省略要认**（`野火` 的第二条继承敌方的显式目标）；
  ④ **没有配置声明能力时一条标记都不许摘**（legacy 逐位不变的地基）；
  ⑤ **声明了也只认两条分支读全、且描述里没有别的静默缺口**的技能 ——
     `沙石阵` 的主句是平值修正（「自己获得速度-20」），只看选择子句会把它算成"可结算"，
     那是**假可模拟**，所以它必须留着标记并给出具名原因。
"""

import unittest

from roco_env import parse as parse_mod
from roco_env.data import load_ruleset


class ChoiceVariantParseTest(unittest.TestCase):
    """「选择：A 或 B」的解析判据。

    为什么先做解析层：术语 3019 把语义写死了（「可以从2个效果中选择1个使用。（2个效果视为
    相同技能，分别记为「明」和「暗」）」），而**结算**要先决定「玩家选了哪一条」这个动作字段
    （`Action.variant`）怎么传、AI 策略怎么选 —— 那是结算层的事，本轮不做。
    所以本轮交付的是：**结构读出来 + 读不全的如实登记 + 一条配置能力都没声明时行为逐位不变**。
    """

    @classmethod
    def setUpClass(cls):
        cls.rs = load_ruleset()
        cls.choice = {}
        for skill in cls.rs.skills.values():
            if skill.is_trait:
                continue
            if "选择：" in (skill.desc or ""):
                cls.choice[skill.skill_id] = skill

    def test_term_3019_writes_the_semantics(self):
        """先钉证据源：术语 3019 的原文（`明`/`暗` 的读法就是从这一句来的）。"""
        term = self.rs.terms.get("3019")
        self.assertIsNotNone(term, "术语表里必须有 3019（选择的定义）")
        self.assertIn("2个效果中选择1个", term.desc)
        self.assertIn("明", term.desc)
        self.assertIn("暗", term.desc)

    def test_every_choice_skill_gets_two_labelled_branches(self):
        """19 条带「选择：」的技能都要拆成两条，并且第一条记「明」、第二条记「暗」。"""
        self.assertEqual(len(self.choice), 19, "冻结语料里带「选择：」的技能数变了，先核对再改这条")
        for sid, skill in self.choice.items():
            parsed = parse_mod.parse_skill(skill)
            self.assertEqual(len(parsed.choice_branches), 2, f"{sid} {skill.name} 没拆成两条分支")
            self.assertEqual([b.label for b in parsed.choice_branches], ["明", "暗"])

    def test_fully_readable_branches_are_exactly_these_three(self):
        """今天**两条分支都读得全**的恰好 3 条（其余都因为别的机制读不出来，如实留着）。"""
        full = {}
        for sid, skill in self.choice.items():
            parsed = parse_mod.parse_skill(skill)
            if parsed.choice_branches and all(not b.leftover for b in parsed.choice_branches):
                full[skill.name] = [
                    [(e.kind, e.target, tuple(sorted(e.value.items()))) for e in b.effects]
                    for b in parsed.choice_branches
                ]
        self.assertEqual(sorted(full), ["沙石阵", "补觉", "野火"], f"可读全的选择技能变了：{sorted(full)}")
        self.assertEqual(full["补觉"], [[("heal", "self", (("percent", 25),))],
                                        [("self_energy", "self", (("amount", 8),))]])
        self.assertEqual(full["野火"], [[("foe_status", "foe", (("layers", 7), ("status", "灼烧")))],
                                        [("foe_stat", "foe", (("delta_pct", -90), ("stat", "def")))]])

    def test_target_is_never_guessed(self):
        """**目标判不出来就不发效果**（反证：默认成敌方会把「物攻+90%」变成给对手加攻击）。

        `蒸汽进行曲` = 「选择：自己获得速度+60或物攻+90%。」：第一条是**平值**修正（+60 不带 %，
        速度也不在未认领标记表里），第二条没有主语。两条都不许猜。
        """
        parsed = parse_mod.parse_skill(self.choice["skill_000485"])
        self.assertEqual(parsed.choice_branches[0].effects, [], "平值「速度+60」不许当成百分比读进来")
        self.assertEqual(parsed.choice_branches[1].effects, [], "没有主语的「物攻+90%」不许默认成敌方")
        self.assertIn("物攻+90%", parsed.choice_branches[1].leftover)

    def test_parallel_branch_inherits_the_explicit_target(self):
        """并列省略要认：`野火` = 「敌方获得7层灼烧或物防-90%」 —— 第二条继承敌方的显式目标。"""
        parsed = parse_mod.parse_skill(self.choice["skill_000414"])
        self.assertEqual(parsed.choice_branches[1].effects[0].target, "foe")
        self.assertEqual(parsed.choice_branches[1].effects[0].value, {"stat": "def", "delta_pct": -90})

    def test_undeclared_capability_keeps_every_marker(self):
        """**没有配置声明这条能力时，未认领标记一条都不许少** —— legacy 逐位不变的地基。"""
        for sid in ("skill_000373", "skill_000414", "skill_000527"):
            skill = self.rs.skills[sid]
            parsed = parse_mod.resolve_choice_variants(skill, declared=False)
            self.assertTrue(any(str(row).startswith("选择（") for row in parsed.unparsed),
                            f"{sid} 未声明能力时不许摘掉「选择」标记")

    def test_declared_capability_claims_only_what_is_fully_read(self):
        """声明了能力也只认**两条分支都读全、且描述里没有别的静默缺口**的技能。

        反证：`沙石阵` 的两条分支读得全，但主句「自己获得速度-20」是**平值**修正、解析器与
        未认领标记表都不认它 —— 只看选择子句会把它算成"整条可结算"，而引擎会静默丢掉 -20 速度。
        所以它必须**留着标记**，并给出具名原因（「平值属性修正」）。
        """
        claimed = []
        for sid, skill in self.choice.items():
            parsed = parse_mod.resolve_choice_variants(skill, declared=True)
            if not any(str(row).startswith("选择（") for row in parsed.unparsed):
                claimed.append(skill.name)
            if skill.name == "沙石阵":
                self.assertTrue(any("平值属性修正" in str(row) for row in parsed.unparsed),
                                "沙石阵 的平值修正必须被具名登记，不许当成读全了")
        self.assertEqual(sorted(claimed), ["补觉", "野火"], f"可认领的选择技能变了：{sorted(claimed)}")


if __name__ == "__main__":
    unittest.main()
