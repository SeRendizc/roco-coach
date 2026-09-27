"""`/rules/query kind=learnset` 的**名字路径**（2026-09-25）。

**为什么补这一条**：玩家问「喵喵学得到哪些技能？」，而学习表原来**只认 `pet_id`** ——
模型不可能猜到 `pet_000001`，产品路径上这句话连工具循环都进不去，回答是「我这边没有喵喵的技能表」，
**而引擎里就有**（实测 16 个可学技能）。与 `kind=term` 同一条理由：玩家说不出内部 id。

口径（照 `_answer_pet` 的既有纪律）：
  · 名字**唯一命中** ⇒ 用它的 `pet_id` 走原来那条路（`native/blood/stones/total`）；
  · 名字**对应多只** ⇒ 显式列候选（`ambiguous: True` + 每只的 pet_id/name），**绝不挑一只** ——
    这份规则集里 63 个名字是多只共用的（化蝶 4 只、棋契陛下 8 只…），学习表各不相同；
  · 查不到 ⇒ `not_found`；既没 id 也没名字 ⇒ `bad_request`。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_learnset_lookup -v
"""

from __future__ import annotations

import copy
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
RULESET_ID = RS.ruleset_id
BASE = {"ruleset_id": RULESET_ID, "state_version": 0}

PET_EVIDENCE_RE = re.compile(r"^ev:[^:]+:pets\.json#(?P<pet_id>[A-Za-z0-9_]+)$")


def learnset_problems(result, answer_evidence):
    """核对一份 learnset 回执；返回问题清单，空列表 = 合格。

    纯函数是为了**反证能复用同一条判据**（同 `test_term_lookup.py`）。
    """
    problems = []
    if not isinstance(result, dict):
        return ["回执不是对象"]
    if result.get("ambiguous"):
        if "pet_id" in result or "native" in result:
            problems.append("候选回执里出现了 pet_id/native —— 那就是把某一只当成了答案")
        matches = result.get("matches")
        if not isinstance(matches, list) or len(matches) < 2:
            problems.append("ambiguous 至少要两条候选")
            return problems
        for item in matches:
            if not isinstance(item.get("pet_id"), str) or not item.get("pet_id"):
                problems.append(f"候选缺 pet_id：{item!r}")
            want = f"ev:{RULESET_ID}:pets.json#{item.get('pet_id')}"
            if want not in [str(x) for x in (answer_evidence or [])]:
                problems.append(f"候选 {item.get('pet_id')} 没有自己的出处（应有 {want}）")
        return problems
    for key in ("pet_id", "native", "blood", "stones", "total"):
        if key not in result:
            problems.append(f"学习表回执缺 {key}")
    if isinstance(result.get("total"), int):
        counted = len(result.get("native") or []) + len(result.get("blood") or []) + len(result.get("stones") or [])
        if counted != result["total"]:
            problems.append(f"total={result['total']} 与三类之和 {counted} 对不上")
    # 学习表的出处**本来就是这两条**（引擎既有约定，不是这次改出来的）：
    # `learnsets.json#<pet_id>` 钉"哪一只的学习表"、`skills.json` 钉"技能表本体"。
    want = [f"ev:{RULESET_ID}:learnsets.json#{result.get('pet_id')}", f"ev:{RULESET_ID}:skills.json"]
    if [str(x) for x in (answer_evidence or [])] != want:
        problems.append(f"出处应为 {want}，实际 {answer_evidence!r}")
    return problems


def query_learnset(service, **params):
    status, envelope = service.rules_query({**BASE, "kind": "learnset", **params})
    return status, envelope, (envelope.get("result") or {})


class LearnsetLookupByName(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = RocoService(served_ruleset_id=RULESET_ID)
        cls.unique_name = next(iter(sorted(
            name for name in {p.name for p in RS.pets.values()}
            if len(RS.pets_by_name(name)) == 1)))

    def test_unique_name_returns_that_pets_learnset(self):
        status, envelope, result = query_learnset(self.service, name=self.unique_name)
        self.assertEqual(status, 200)
        self.assertTrue(envelope["ok"], envelope.get("error"))
        self.assertEqual(result.get("pet_id"), RS.pets_by_name(self.unique_name)[0].pet_id)
        self.assertGreater(result.get("total") or 0, 0, "学习表不该是空的")
        self.assertEqual(learnset_problems(result, envelope["evidence_ids"]), [])

    def test_by_id_path_unchanged(self):
        pet_id = RS.pets_by_name(self.unique_name)[0].pet_id
        by_id = query_learnset(self.service, pet_id=pet_id)
        by_name = query_learnset(self.service, name=self.unique_name)
        self.assertEqual(by_id[0], 200)
        self.assertEqual(by_id[2], by_name[2], "按名字与按 id 必须回同一份学习表")

    def test_ambiguous_name_lists_candidates_and_never_picks_one(self):
        dup = sorted(name for name in {p.name for p in RS.pets.values()} if len(RS.pets_by_name(name)) > 1)
        self.assertTrue(dup, "前提：这份规则集里有重名精灵")
        name = dup[0]
        status, envelope, result = query_learnset(self.service, name=name)
        self.assertEqual(status, 200)
        self.assertEqual(learnset_problems(result, envelope["evidence_ids"]), [])
        self.assertTrue(result.get("ambiguous"), f"重名必须显式登记：{name}")
        self.assertGreaterEqual(len(result["matches"]), 2)
        # **反证**：把候选伪装成"这就是答案"（补一个 pet_id），同一条判据必须报问题
        forged = copy.deepcopy(result)
        forged.pop("ambiguous")
        forged["pet_id"] = result["matches"][0]["pet_id"]
        forged["native"], forged["blood"], forged["stones"], forged["total"] = [], [], [], 0
        self.assertTrue(learnset_problems(forged, envelope["evidence_ids"]),
                        "把候选当成答案必须被同一条判据抓住")

    def test_unknown_name_is_not_found(self):
        status, envelope, _ = query_learnset(self.service, name="不存在的宠物名")
        self.assertEqual(status, 404)
        self.assertIn("未知精灵名", envelope.get("error", ""))

    def test_neither_id_nor_name_is_bad_request(self):
        status, envelope, _ = query_learnset(self.service)
        self.assertEqual(status, 400)
        self.assertIn("learnset", envelope.get("error", "") + " learnset")

    def test_counterproof_predicate_has_teeth(self):
        status, envelope, result = query_learnset(self.service, name=self.unique_name)
        self.assertEqual(learnset_problems(result, envelope["evidence_ids"]), [], "健康输入必须判空")
        self.assertTrue(learnset_problems(result, []), "没有出处必须报问题")
        self.assertTrue(learnset_problems(result, [f"ev:{RULESET_ID}:learnsets.json#pet_999999",
                                                       f"ev:{RULESET_ID}:skills.json"]),
                        "出处钉到别的精灵必须报问题")
        broken = dict(result)
        broken["total"] = (result.get("total") or 0) + 1
        self.assertTrue(learnset_problems(broken, envelope["evidence_ids"]), "total 对不上必须报问题")


if __name__ == "__main__":
    unittest.main()
