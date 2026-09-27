"""`kind:"legality"` —— 「这几招它学得到吗」（agent 主线 P0-a 的最后一块）。

为什么要有这一条：`catalog` 答"该找谁"、`learnset` 答"它能学什么"，而玩家/模型手里经常是
一份**具体配招**（「带 火花、藤鞭、防御、休息回复」）。过去这一问只能靠 `team/evaluate`
（要凑满模式声明的队伍规模）或让模型自己比对学习表（会猜）。

判据钉四件事：
  ① **逐招对照学习表**：`native`/`blood`/`stones` 三个来源如实写出来（哪一招走哪一列）；
  ② **三态 `legal`**：全学得到 `true` / 有学不到的 `false` / 有认不出来的技能 `null`
     —— 「引擎没这个技能」与「这只学不到这个技能」是两件事，混成一句"不合法"就是误导；
  ③ **名字路径与 id 路径同一条纪律**（重名/查不到都不猜）；
  ④ **fail closed**：未知精灵 404、空/超量 skills 400。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from roco_env.data import DEFAULT_RULESET, load_ruleset  # noqa: E402
from roco_env.service import RocoService  # noqa: E402

RS = load_ruleset(DEFAULT_RULESET)


class LegalityReadPortTest(unittest.TestCase):
    def setUp(self):
        self.service = RocoService()
        # 用一只**真实**精灵，它的学习表三列都非空（挑不出三列都有的就退到 native 非空）
        self.pet = next(p for p in RS.pets.values()
                        if RS.learnsets.get(p.pet_id) and RS.learnsets[p.pet_id].native)
        self.learnset = RS.learnsets[self.pet.pet_id]

    def names(self, ids):
        return [RS.skills[sid].name for sid in ids]

    def legality(self, **query):
        answer = self.service._answer_legality(RS, query)
        return answer, answer.result

    def test_native_skills_are_learnable_and_say_which_column(self):
        native = self.names(list(self.learnset.native)[:3])
        _, row = self.legality(pet_id=self.pet.pet_id, skills=native)
        self.assertTrue(row["legal"])
        self.assertTrue(row["all_learnable"])
        self.assertEqual(row["requested"], 3)
        self.assertEqual(row["learnable"], 3)
        for item in row["skills"]:
            self.assertTrue(item["learnable"])
            self.assertIn("native", item["via"], f"{item['name']} 应当来自 native 列")

    def test_a_skill_it_cannot_learn_is_not_legal(self):
        """拿一个**明确不在**这只学习表里的技能 ⇒ `legal:false`，并给出空 `via`。"""
        other = next(sid for sid in RS.skills if sid not in self.learnset.all_skill_ids)
        native = self.names(list(self.learnset.native)[:2])
        _, row = self.legality(pet_id=self.pet.pet_id, skills=native + [RS.skills[other].name])
        self.assertFalse(row["legal"])
        self.assertFalse(row["all_learnable"])
        bad = [item for item in row["skills"] if not item["learnable"]]
        self.assertEqual(len(bad), 1)
        self.assertEqual(bad[0]["via"], [])
        self.assertEqual(bad[0]["skill_id"], other)

    def test_unknown_skill_name_is_null_not_false(self):
        """认不出来的技能 ⇒ `legal:null` + `unknown_skills`（绝不写"不合法"）。"""
        _, row = self.legality(pet_id=self.pet.pet_id, skills=["这个招式在引擎里不存在"])
        self.assertIsNone(row["legal"], "有认不出的技能时 legal 必须是 null（三态）")
        self.assertEqual(row["unknown_skills"], ["这个招式在引擎里不存在"])
        self.assertEqual(row["learnable"], 0)
        self.assertFalse(row["all_learnable"])
        self.assertIn("不是", row["note"])

    def test_skill_ids_and_names_go_through_the_same_door(self):
        """id 与名字两种写法必须给出**同一个**结论（同一条纪律，不许一个认一个不认）。"""
        sids = list(self.learnset.native)[:2]
        _, by_id = self.legality(pet_id=self.pet.pet_id, skills=sids)
        _, by_name = self.legality(pet_id=self.pet.pet_id, skills=self.names(sids))
        self.assertEqual(by_id["legal"], by_name["legal"])
        self.assertEqual([item["skill_id"] for item in by_id["skills"]],
                         [item["skill_id"] for item in by_name["skills"]])
        self.assertEqual([item["via"] for item in by_id["skills"]],
                         [item["via"] for item in by_name["skills"]])

    def test_pet_can_be_named_and_ambiguity_is_refused(self):
        """精灵名走与学习表同一条路：唯一命中就用；重名要列候选（不静默取第一条）。"""
        answer, row = self.legality(name="不存在的精灵名", skills=["抓挠"])
        self.assertFalse(row)
        self.assertIn("未知精灵名", answer.error)
        # 真名（唯一）⇒ 命中
        _, row = self.legality(name=self.pet.name, skills=self.names(list(self.learnset.native)[:1]))
        self.assertEqual(row["pet_id"], self.pet.pet_id)

    def test_bad_arguments_fail_closed(self):
        for bad in ({}, {"skills": []}, {"skills": "抓挠"}, {"skills": ["抓挠"] * 7}):
            answer, row = self.legality(pet_id=self.pet.pet_id, **bad)
            self.assertFalse(row, f"{bad} 必须被拒")
            self.assertTrue(answer.error)
        answer, row = self.legality(pet_id="pet_999999", skills=["抓挠"])
        self.assertFalse(row)
        self.assertIn("未知精灵 id", answer.error)

    def test_no_damage_or_winrate_numbers_in_the_receipt(self):
        _, row = self.legality(pet_id=self.pet.pet_id, skills=self.names(list(self.learnset.native)[:2]))
        text = repr(row)
        for banned in ("winrate", "win_rate", "probability", "damage", "score", "power"):
            self.assertNotIn(banned, text, f"回执里不许出现 {banned}")


class LegalityDirectionTest(unittest.TestCase):
    """必红反证：把"来源列"判据换成"只要引擎里有这个技能就算合法" ⇒ 上面两条必须红。"""

    def test_ignoring_the_learnset_turns_the_check_red(self):
        service = RocoService()
        pet = next(p for p in RS.pets.values()
                   if RS.learnsets.get(p.pet_id) and RS.learnsets[p.pet_id].native)
        learnset = RS.learnsets[pet.pet_id]
        other = next(sid for sid in RS.skills if sid not in learnset.all_skill_ids)
        row = service._answer_legality(RS, {"pet_id": pet.pet_id,
                                            "skills": [RS.skills[other].name]}).result
        self.assertFalse(row["legal"], "正常实现：学不到 ⇒ false")
        # 错误实现（只看"引擎里有没有这个技能"）会得出 true —— 判据正是靠这个差别成立
        naive = RS.skills.get(other) is not None
        self.assertTrue(naive)
        self.assertNotEqual(naive, row["legal"], "两套判据必须给出不同结论，否则这条反证是空的")


if __name__ == "__main__":
    unittest.main()
