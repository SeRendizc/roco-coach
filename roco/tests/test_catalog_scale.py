"""600 只规模的图鉴读口判据（P2 的第一刀，离线版）。

为什么要有这一条：`catalog`/`legality`/`pet` 这几个读口是按名字或属性进出的，而**名字不是唯一的**
—— 冻结图鉴 622 只里有 **62 个名字是重名的**（涉及 180 只，一个名字最多 6 只形态）。
按名字查必须：唯一名 ⇒ 直接给记录；重名 ⇒ 回 `ambiguous` + 候选清单（**不挑一只替另一只答**）。
真机实测踩过：教练模板没读 `ambiguous` 分支，把 8/30 抽样名印成了「属性未登记」（像引擎没数据）。

判据形状（与 held-out 评测同一条纪律：**独立于被测实现**取真值）：
  ① 抽样是**确定性**的（按 pet_id 排序后等距取 30 只），真值来自冻结图鉴 `full-catalog.json`；
  ② 唯一名：回执的 types / stats / stat_total 必须与图鉴**逐值相同**；
  ③ 重名：回执必须是 `ambiguous` + ≥2 个候选，且每个候选按 pet_id 查回来的记录也与图鉴逐值相同；
  ④ fail closed：查不到的名字必须是 not_found（不许编一条记录）。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from roco_env.data import DEFAULT_RULESET, load_ruleset  # noqa: E402
from roco_env.service import RocoService  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_PATH = os.path.join(
    os.path.dirname(ROOT), "data", "roco", "normalized", "roco-world-s4-2026-09-10", "full-catalog.json")

SAMPLE_SIZE = 30


def load_catalog():
    with open(CATALOG_PATH, encoding="utf-8") as handle:
        return json.load(handle)["pets"]


def sample(pets, count=SAMPLE_SIZE):
    ordered = sorted(pets, key=lambda row: row["pet_id"])
    if len(ordered) <= count:
        return ordered
    step = len(ordered) / count
    return [ordered[int(i * step)] for i in range(count)]


class CatalogScaleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = RocoService()
        cls.catalog = load_catalog()
        cls.by_id = {row["pet_id"]: row for row in cls.catalog}
        cls.names = {}
        for row in cls.catalog:
            cls.names.setdefault(row["name"], []).append(row["pet_id"])
        cls.sample = sample(cls.catalog)

    def answer(self, **query):
        return self.service._answer_pet(RS, query)

    def test_samples_are_deterministic_and_drawn_from_the_frozen_catalog(self):
        first = [row["pet_id"] for row in self.sample]
        second = [row["pet_id"] for row in sample(self.catalog)]
        self.assertEqual(first, second, "两次抽样必须逐条相同（判据要可复算）")
        self.assertEqual(len(set(first)), len(first), "抽样不许重复")
        self.assertEqual(first, sorted(first), "按 pet_id 升序")
        self.assertEqual(len(self.catalog), 622, "冻结图鉴的规模（622）就是这条判据的采样池")

    def test_unique_names_match_the_catalog_value_for_value(self):
        uniques = [row for row in self.sample if len(self.names[row["name"]]) == 1]
        self.assertTrue(uniques, "抽样里应当有唯一名")
        for row in uniques:
            result = self.answer(name=row["name"]).result
            self.assertIsNotNone(result, f"{row['name']} 按名字查不到")
            self.assertEqual(result["pet_id"], row["pet_id"])
            self.assertEqual(sorted(result["types"]), sorted(row["types"]),
                             f"{row['name']} 的属性必须与图鉴逐字相同")
            self.assertEqual(result["stats"], row["stats"],
                             f"{row['name']} 的六维必须与图鉴逐值相同")
            self.assertEqual(result["stat_total"], sum(row["stats"].values()))

    def test_ambiguous_names_return_candidates_and_each_candidate_matches_the_catalog(self):
        ambiguous = [row for row in self.sample if len(self.names[row["name"]]) > 1]
        self.assertTrue(ambiguous, "抽样里应当有重名（622 只里 62 个名字是重名的）")
        for row in ambiguous:
            answer = self.answer(name=row["name"])
            result = answer.result
            self.assertTrue(result.get("ambiguous") is True,
                            f"{row['name']} 有 {len(self.names[row['name']])} 只形态，必须回 ambiguous")
            matches = result.get("matches") or []
            self.assertEqual(len(matches), len(self.names[row["name"]]),
                             f"{row['name']} 的候选数必须等于图鉴里的形态数")
            self.assertFalse(hasattr(answer, "unsupported") and answer.unsupported,
                             "重名不是 unsupported —— 它是可查的，只是要按 pet_id 挑一只")
            for match in matches:
                record = self.answer(pet_id=match["pet_id"]).result
                self.assertIsNotNone(record, f"候选 {match['pet_id']} 按 id 查不到")
                truth = self.by_id[match["pet_id"]]
                self.assertEqual(sorted(record["types"]), sorted(truth["types"]))
                self.assertEqual(record["stats"], truth["stats"])

    def test_unknown_names_fail_closed(self):
        for name in ("烬尾狐", "雷人兽", "不存在的精灵名xyz"):
            answer = self.answer(name=name)
            self.assertIsNone(answer.result, f"{name} 不该有记录")
            self.assertIn("未知精灵名", answer.error)

    def test_reverse_proof_sample_without_ambiguity_would_hide_the_bug(self):
        """必红反证：只在**唯一名**上抽样，就永远看不到重名分支的缺陷。

        真机实测（8/30 印成「属性未登记」）正是靠"抽样里混进了重名"才暴露的；
        这一条把那个差别固定下来 —— 抽样池里必须同时有两种名字。
        """
        kinds = {len(self.names[row["name"]]) == 1 for row in self.sample}
        self.assertEqual(kinds, {True, False},
                         "抽样必须同时覆盖唯一名与重名（否则重名分支的缺陷测不出来）")
        # 而且重名在**全量**里不是罕见情况：
        duplicate_names = [name for name, ids in self.names.items() if len(ids) > 1]
        self.assertGreaterEqual(len(duplicate_names), 50,
                                f"重名名字数应当是一个可观的比例，实际 {len(duplicate_names)}")
        print(f"\n[实际] 图鉴 {len(self.catalog)} 只；抽样 {len(self.sample)} 只；"
              f"重名名字 {len(duplicate_names)} 个，涉及 "
              f"{sum(len(self.names[name]) for name in duplicate_names)} 只")


RS = load_ruleset(DEFAULT_RULESET) if not isinstance(DEFAULT_RULESET, str) else load_ruleset()

if __name__ == "__main__":
    unittest.main()
