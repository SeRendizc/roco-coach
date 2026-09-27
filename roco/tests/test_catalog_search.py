"""`kind:"catalog"` —— 按**属性**检索精灵（agent 主线 P0-a 的第一个"该找谁"读口）。

为什么要有这一条：真机实测（2026-09-25，8765 接了 key）「我想练一只抗龙系的伙伴，配哪四招？」
→ agent **一次工具都没调**就答了（含糊、无依据）。原因是全量 622 只里「谁抗龙系」没有读口：
`pet` 只按 id/名字查一只，`type_row` 只回属性层面的相性表。

这一批判据钉四件事：
  ① **方向不许反**：`resist`（抗 X）/ `weak`（怕 X）/ `beats`（克制 X）三个筛法各自读哪一列；
  ② **交集**：给了 element 与方向词时两个条件同时成立；
  ③ **分页与总数**：`total_matched` 是全部命中数，`truncated` 不许把"这一页"说成"全部"；
  ④ **fail closed**：未知属性 404、缺筛选 400、非法 limit/offset 400，一个都不许猜。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from roco_env import rule_config as rc  # noqa: E402
from roco_env.data import DEFAULT_RULESET, load_ruleset  # noqa: E402
from roco_env.service import RocoService  # noqa: E402

RS = load_ruleset(DEFAULT_RULESET)


class CatalogFilterTest(unittest.TestCase):
    def setUp(self):
        self.service = RocoService()

    def catalog(self, **query):
        answer = self.service._answer_catalog(RS, query)
        return answer, answer.result

    def test_resist_weak_and_beats_read_three_different_columns(self):
        """「抗龙系」/「怕龙系」/「克制龙系」是**三批不同**的精灵，方向一条都不许反。

        依据（快照 types.json 的单属性行）：
          · 抗龙系 = 谁的 resist 列里有龙系 —— 实测只有机械系；
          · 怕龙系 = 谁的 weak 列里有龙系 —— 龙系自己（龙打龙 2×）；
          · 克制龙系 = 龙系那一行 weak 列出的属性（冰/萌/龙）。
        """
        _, resist = self.catalog(resist="龙系")
        self.assertEqual(resist["filters"], {"resist": "龙系"})
        self.assertEqual(resist["matched_types"], ["机械系"])
        self.assertTrue(resist["total_matched"] > 0)

        _, weak = self.catalog(weak="龙系")
        self.assertEqual(weak["matched_types"], ["龙系"])

        _, beats = self.catalog(beats="龙系")
        self.assertEqual(sorted(beats["matched_types"]), ["冰系", "萌系", "龙系"])

        self.assertNotEqual(resist["matched_types"], beats["matched_types"],
                            "「抗」与「克制」如果读出同一批属性，那一定有一条读错了列")

    def test_every_returned_pet_really_satisfies_the_filter(self):
        """回执里每一只都必须**真的**满足筛选（逐只去相性行核对，不信 `matched` 字符串）。"""
        _, beats = self.catalog(beats="龙系", limit=50)
        self.assertTrue(beats["pets"], "对照组不能是空的")
        dragon_row = RS.type_chart.rows.get(("龙系",))
        self.assertIsNotNone(dragon_row, "龙系必须有单属性行")
        beaters = {t for t, mult in dragon_row.items() if mult > 1.0}
        self.assertEqual(beaters, {"冰系", "龙系", "萌系"}, "龙系那行的克制属性")
        for pet in beats["pets"]:
            self.assertTrue(set(pet["types"]) & beaters,
                            f"{pet['name']} 的属性 {pet['types']} 都不在 {sorted(beaters)} 里")

    def test_intersection_of_element_and_direction(self):
        """给了两个条件就是**交集**（"龙系里克制龙系的" = 龙系自己那一批）。"""
        _, both = self.catalog(element="龙系", beats="龙系")
        _, only_element = self.catalog(element="龙系", limit=50)
        self.assertTrue(both["total_matched"] <= only_element["total_matched"])
        for pet in both["pets"]:
            self.assertIn("龙系", pet["types"])
        # 反证：交集之外的组合必须为空（没有龙系抗龙系 —— 龙系那行 resist 里没有龙系）
        _, none = self.catalog(element="龙系", resist="龙系")
        self.assertEqual(none["total_matched"], 0)

    def test_pagination_is_explicit(self):
        """`total_matched` 是全部命中数；`truncated` 如实标出来。"""
        _, first = self.catalog(resist="龙系", limit=3)
        self.assertEqual(first["returned"], 3)
        self.assertTrue(first["truncated"])
        _, second = self.catalog(resist="龙系", limit=3, offset=3)
        self.assertEqual(second["offset"], 3)
        self.assertNotEqual([p["pet_id"] for p in first["pets"]],
                            [p["pet_id"] for p in second["pets"]])
        _, all_rows = self.catalog(resist="龙系", limit=50)
        self.assertEqual(len(all_rows["pets"]), min(50, all_rows["total_matched"]))
        self.assertEqual(all_rows["truncated"], all_rows["total_matched"] > 50)

    def test_bare_element_name_is_normalized_but_unknown_types_fail_closed(self):
        """`龙` → `龙系` 这一种收敛要做；认不出来的属性必须 404（不许猜一个近似属性）。"""
        _, bare = self.catalog(resist="龙")
        _, full = self.catalog(resist="龙系")
        self.assertEqual(bare["matched_types"], full["matched_types"])
        answer, result = self.catalog(resist="雷人系")
        self.assertFalse(result)
        self.assertIn("未知属性", answer.error)
        answer, result = self.catalog()
        self.assertFalse(result)
        self.assertIn("至少要给", answer.error)
        for bad in ({"limit": 0}, {"limit": 51}, {"offset": -1}):
            answer, result = self.catalog(resist="龙系", **bad)
            self.assertFalse(result, f"{bad} 必须被拒")
            self.assertIn("必须是", answer.error)

    def test_no_damage_or_winrate_numbers_in_the_receipt(self):
        """这一读口**不带**任何伤害/胜率/强度数字：它是检索，不是评估。"""
        _, row = self.catalog(resist="龙系", limit=5)
        text = repr(row)
        for banned in ("winrate", "win_rate", "probability", "damage", "damage_preview", "score"):
            self.assertNotIn(banned, text, f"回执里不许出现 {banned}")
        self.assertIn("不含", row["note"])
        for pet in row["pets"]:
            self.assertEqual(set(pet) & {"damage", "winrate", "score"}, set())


class CatalogPetIdFilterTest(unittest.TestCase):
    """`pet_ids`：「我这几只里谁抗龙系」必须一次问清（不许靠分页碰运气）。"""

    def setUp(self):
        self.service = RocoService()

    def catalog(self, **query):
        answer = self.service._answer_catalog(RS, query)
        return answer, answer.result

    def test_only_the_given_ids_are_searched(self):
        mine = ["pet_000012", "pet_000186", "pet_000001"]
        _, all_rows = self.catalog(resist="龙系", limit=50)
        _, mine_rows = self.catalog(resist="龙系", pet_ids=mine)
        self.assertEqual(mine_rows["filters"]["pet_ids"], sorted(mine))
        self.assertTrue(all(pet["pet_id"] in mine for pet in mine_rows["pets"]),
                        "回执里不许出现名单外的精灵")
        self.assertLessEqual(mine_rows["total_matched"], all_rows["total_matched"])
        # 反证：把 id 换成一批**已知命中**的，total 必须 ≥1（否则这条判据是空的）
        hitters = [pet["pet_id"] for pet in all_rows["pets"][:3]]
        _, hit_rows = self.catalog(resist="龙系", pet_ids=hitters)
        self.assertEqual(hit_rows["total_matched"], len(hitters))
        print(f"\n[实际] 全库抗龙系 {all_rows['total_matched']} 只；限 3 个 id 后 "
              f"{mine_rows['total_matched']} 只；给 3 个已知命中 ⇒ {hit_rows['total_matched']} 只")

    def test_unknown_ids_are_listed_not_silently_dropped(self):
        _, row = self.catalog(resist="龙系", pet_ids=["pet_000012", "pet_999999"])
        self.assertEqual(row["unknown_pet_ids"], ["pet_999999"])
        self.assertEqual(row["total_matched"], 0)

    def test_bad_pet_ids_fail_closed(self):
        for bad in ({"pet_ids": "pet_000012"}, {"pet_ids": []},
                    {"pet_ids": ["../etc/passwd"]},
                    {"pet_ids": [f"pet_{i:06d}" for i in range(61)]}):
            answer, row = self.catalog(resist="龙系", **bad)
            self.assertFalse(row, f"{str(bad)[:40]} 必须被拒")
            self.assertTrue(answer.error)


class WeaknessSummaryTest(unittest.TestCase):
    """`kind:"weakness_summary"`：「我这份名单整体最怕什么属性」—— 逐属性数，口径与 `type_multiplier` 同一套。"""

    def setUp(self):
        self.service = RocoService()

    def summary(self, **query):
        answer = self.service._answer_weakness_summary(RS, query)
        return answer, answer.result

    def test_counts_match_type_multiplier_for_every_element(self):
        """交叉核对：汇总里每一栏的计数，必须等于逐只 `type_multiplier` 数出来的只数。"""
        ids = [f"pet_{i:06d}" for i in range(1, 21)]
        _, row = self.summary(pet_ids=ids)
        self.assertEqual(row["counted"], len(ids))
        by_element = {item["element"]: item for item in row["by_element"]}
        for element in ("火系", "冰系", "龙系"):
            counted = 0
            for pid in ids:
                pet = RS.pets.get(pid)
                if pet is None:
                    continue
                value = self.service._answer_type_multiplier(
                    RS, {"attack_element": element, "defender_types": list(pet.types)}).result
                if value and value["multiplier"] > 1.0:
                    counted += 1
            self.assertEqual(by_element.get(element, {"count": 0})["count"], counted,
                             f"{element} 的计数与逐只 type_multiplier 不一致")

    def test_top_is_sorted_and_capped(self):
        ids = [f"pet_{i:06d}" for i in range(1, 61)]
        _, row = self.summary(pet_ids=ids)
        counts = [item["count"] for item in row["by_element"]]
        self.assertEqual(counts, sorted(counts, reverse=True), "by_element 必须按计数降序")
        self.assertLessEqual(len(row["top"]), 5, "top 最多 5 条")
        self.assertTrue(all(item["count"] > 0 for item in row["top"]), "top 里不许出现 0 条的属性")
        self.assertTrue(all(len(item["pet_ids"]) <= row["list_cap_per_element"]
                            for item in row["by_element"]), "每栏的宠物清单要按 cap 截断")

    def test_unknown_ids_and_unknown_combinations_are_reported_not_guessed(self):
        _, row = self.summary(pet_ids=["pet_000001", "pet_999999"])
        self.assertEqual(row["unknown_pet_ids"], ["pet_999999"])
        self.assertEqual(row["counted"], 1)
        self.assertFalse(row["by_element"] and any("pet_999999" in item["pet_ids"] for item in row["by_element"]))
        # 双属性组合缺行时整只不计入（快照 18 选 2 里缺 67 个组合）—— 这里只断言口径存在且是列表
        self.assertIsInstance(row["unknown_combination_pet_ids"], list)

    def test_receipt_has_no_probability_or_strength_claims(self):
        # 不许有**结论式**的概率/强度字段；「不是胜率」这句免责声明本身要留着。
        _, row = self.summary(pet_ids=[f"pet_{i:06d}" for i in range(1, 11)])
        for banned in ("winrate", "win_rate", "probability"):
            self.assertNotIn(banned, repr(row), f"回执里不许出现 {banned}")
        for item in row["by_element"]:
            self.assertEqual(set(item), {"element", "count", "pet_ids"},
                             "每一栏只允许 element/count/pet_ids —— 多一个评分/胜率字段就要红")
        self.assertIn("不是胜率", row["note"], "免责声明要留着（它说明这是什么）")

    def test_bad_arguments_fail_closed(self):
        for bad in ({}, {"pet_ids": "pet_000001"}, {"pet_ids": []},
                    {"pet_ids": ["../etc/passwd"]},
                    {"pet_ids": [f"pet_{i:06d}" for i in range(61)]}):
            answer, row = self.summary(**bad)
            self.assertFalse(row, f"{str(bad)[:40]} 必须被拒")
            self.assertTrue(answer.error)


class LearnsetCompactTest(unittest.TestCase):
    """学习表的**紧凑投影**（配招咨询那一族）：字段更少但事实不变，且必须落进中转预算。

    真机实测（2026-09-25）：「雪影娃娃的配招怎么选？」—— 50 条技能的完整回执 23 064 字节，
    超过教练侧 10 000 字节的中转上限 ⇒ 模型一条技能都拿不到，只能凭记忆说方向；
    最大的那只是 294 条（学院呱呱），完整回执 56 KB。
    """

    BUDGET = 10000   # 与 `src/coach/runtime.js` 的 10 000 字节中转上限同一条

    def setUp(self):
        self.service = RocoService()
        self.biggest = max(RS.learnsets.items(), key=lambda kv: len(kv[1].all_skill_ids))

    def learnset(self, **query):
        answer = self.service._answer_learnset(RS, query)
        return answer, answer.result

    def test_compact_keeps_the_same_skills_but_fewer_fields(self):
        _, full = self.learnset(name="雪影娃娃")
        _, compact = self.learnset(name="雪影娃娃", compact=True, limit=20)
        self.assertEqual(full["total"], compact["total"], "条数口径不许变")
        self.assertEqual([row["skill_id"] for row in full["native"][:20]],
                         [row["skill_id"] for row in compact["native"]], "同一批技能、同一个顺序")
        extra = set(compact["native"][0]) - {"skill_id", "name", "category", "element", "energy",
                                            "damage_class", "power"}
        self.assertEqual(extra, set(), f"精简投影里不许出现额外字段：{extra}")
        self.assertTrue(compact["compact"])

    def test_compact_fits_the_relay_budget_for_every_learnset(self):
        """逐只核一遍：**任何一只**用 compact+limit=20 都必须落进 10 KB。"""
        worst = (0, None)
        for pet_id, learnset in RS.learnsets.items():
            if not learnset.all_skill_ids:
                continue
            _, row = self.learnset(pet_id=pet_id, compact=True, limit=20)
            size = len(json.dumps(row, ensure_ascii=False))
            if size > worst[0]:
                worst = (size, pet_id)
            self.assertLessEqual(size, self.BUDGET,
                                 f"{pet_id} 的精简回执 {size} 字节超过中转上限")
        print(f"\n[实际] 全部 {len(RS.learnsets)} 份学习表：最大紧凑回执 {worst[0]} 字节（{worst[1]}）")

    def test_truncation_is_reported(self):
        pet_id = self.biggest[0]
        _, row = self.learnset(pet_id=pet_id, compact=True, limit=20)
        if row["total"] > 20:
            self.assertTrue(row["truncated"], "截断了就要如实标出来")
            self.assertEqual(sum(row["returned"].values()) < row["total"], True)
        # 小学习表不截断
        _, small = self.learnset(name="喵喵", compact=True, limit=20)
        self.assertFalse(small["truncated"])
        self.assertNotIn("truncated", self.learnset(name="喵喵")[1], "非 compact 模式不加这些字段")

    def test_bad_limit_fails_closed(self):
        for bad in (0, 61, "20", True):
            answer, row = self.learnset(name="喵喵", compact=True, limit=bad)
            self.assertFalse(row, f"limit={bad!r} 必须被拒")
            self.assertIn("limit", answer.error)


class CatalogDirectionMatchesSnapshotTest(unittest.TestCase):
    """必红反证：把 `resist` 与 `beats` 两列对调 ⇒ 上面的方向判据必须红。"""

    def test_swapping_resist_and_beats_turns_the_direction_check_red(self):
        service = RocoService()
        resist = service._answer_catalog(RS, {"resist": "龙系"}).result
        beats = service._answer_catalog(RS, {"beats": "龙系"}).result
        # 正常情况下两批属性不同；把 `_types_with_entry` 的方向换掉会得到同一批
        # （这里直接构造"错误实现"的结果来证明判据抓得住它）。
        wrong_beats = service._types_with_entry(
            {k: v for k, v in service._type_rows(RS)[0].items() if "|" not in str(k)}, "龙系", "resist")
        self.assertEqual(wrong_beats, resist["matched_types"])
        self.assertNotEqual(sorted(wrong_beats), sorted(beats["matched_types"]),
                            "如果没有这一条，方向反了也看不出来")


if __name__ == "__main__":
    unittest.main()
