"""`/rules/query kind=term` 的**名字路径**（2026-09-25）。

**这个文件存在的理由**：玩家问的是「『应对』这条术语是怎么定义的？」，而引擎与工具合同
原来**都只认 `term_id`** —— 模型不可能猜到 `1015`，于是这类问题只能靠编。实测（288 条任务集的
`rules_lookup` 家族）里 23 条"一次都没调"当中 12 条就是这类。

现在约定的两段行为（照 `_answer_pet` 的既有纪律，不自己发明）：

  · **精确命中**（`note` 等于查的名字）⇒ 定义，出处钉到 `terms.json#<term_id>`；
  · **精确不中但名字里含这段文字** ⇒ **候选**（`candidates: True`），
    并明说**它们不是这个名字的定义**；玩家说「应对」而册子上是
    「应对状态 / 应对攻击 / 应对防御」三条时，**替玩家挑一条就是拿另一条规则的定义骗人**；
  · 一条都含不到 ⇒ `not_found`；既没 id 也没名字 ⇒ `bad_request`。

**反证（必红）**：`term_answer_problems` 是**纯函数**，反向用例复用它 ——
① 候选回执**不许**通过"这是一个定义"的判据；② 把正向回执里的 `evidence_ids` 剥掉必须报问题；
③ 判据对健康输入必须返回空（不是恒假）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_term_lookup -v
"""

from __future__ import annotations

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

TERM_EVIDENCE_RE = re.compile(r"^ev:(?P<ruleset>[^:]+):terms\.json#(?P<term_id>[A-Za-z0-9_]+)$")


def term_answer_problems(result, answer_evidence):
    """核对一份 term 回执；返回问题清单，空列表 = 合格。

    抽成纯函数的唯一理由是**反证要能复用同一条判据**（同 `test_roster_evidence.py` 的写法）。
    """
    problems = []
    if not isinstance(result, dict):
        return ["回执不是对象"]
    if not isinstance(answer_evidence, list) or not answer_evidence:
        problems.append("信封里没有 evidence_ids（无法回查）")
        answer_evidence = []
    for eid in answer_evidence:
        if TERM_EVIDENCE_RE.match(str(eid)) is None:
            problems.append(f"出处形状不对：{eid!r}")
    if result.get("candidates"):
        # **候选不是定义**：不许带顶层 desc/term_id，且每条候选必须有自己的 id 与出处。
        if "desc" in result or "term_id" in result:
            problems.append("候选回执里出现了顶层 term_id/desc —— 那就是把某一条候选当成了定义")
        matches = result.get("matches")
        if not isinstance(matches, list) or not matches:
            problems.append("候选回执里没有 matches")
            return problems
        for item in matches:
            for key in ("term_id", "note", "desc"):
                if not isinstance(item.get(key), str) or not item.get(key):
                    problems.append(f"候选缺 {key}：{item!r}")
            want = f"ev:{RULESET_ID}:terms.json#{item.get('term_id')}"
            if want not in [str(x) for x in answer_evidence]:
                problems.append(f"候选 {item.get('term_id')} 没有自己的出处（应有 {want}）")
        return problems
    if result.get("ambiguous"):
        if len(result.get("matches") or []) < 2:
            problems.append("ambiguous 至少要两条候选")
        return problems
    # 定义分支：必须有 id/名字/描述，且出处**恰好一条**、钉在同一个 id 上。
    for key in ("term_id", "note", "desc"):
        if not isinstance(result.get(key), str) or not result.get(key):
            problems.append(f"定义回执缺 {key}：{result!r}")
    want = [f"ev:{RULESET_ID}:terms.json#{result.get('term_id')}"]
    if [str(x) for x in answer_evidence] != want:
        problems.append(f"定义的出处应为 {want}，实际 {answer_evidence!r}")
    return problems


def query_term(service, **params):
    status, envelope = service.rules_query({**BASE, "kind": "term", **params})
    return status, envelope, (envelope.get("result") or {})


class TermLookupByName(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = RocoService(served_ruleset_id=RULESET_ID)

    def test_exact_name_returns_the_definition(self):
        status, envelope, result = query_term(self.service, name="应对状态")
        self.assertEqual(status, 200)
        self.assertTrue(envelope["ok"], envelope.get("error"))
        self.assertEqual(result.get("term_id"), "1015")
        self.assertEqual(result.get("note"), "应对状态")
        self.assertTrue(result.get("desc"))
        self.assertEqual(term_answer_problems(result, envelope["evidence_ids"]), [])
        self.assertEqual(envelope["evidence_ids"], [f"ev:{RULESET_ID}:terms.json#1015"])

    def test_short_form_returns_candidates_and_never_picks_one(self):
        """「应对」是玩家会说的短说法；册子上是三条带前缀的名字。"""
        status, envelope, result = query_term(self.service, name="应对")
        self.assertEqual(status, 200)
        self.assertTrue(envelope["ok"], envelope.get("error"))
        self.assertEqual(term_answer_problems(result, envelope["evidence_ids"]), [])
        ids = [item["term_id"] for item in result["matches"]]
        self.assertEqual(ids, ["1015", "1016", "1017"], f"候选应恰好是这三条，实际 {ids}")
        self.assertTrue(result.get("candidates"))
        self.assertIn("不是这个名字的定义", result.get("note", ""))
        # **反证①**：这份回执绝不许通过"这是一个定义"的判据。
        # 做法：把它伪装成定义（补一个 term_id）再喂给同一条判据的**定义分支**，必须报问题。
        forged = dict(result)
        forged.pop("candidates")
        forged["term_id"] = "1015"
        self.assertTrue(term_answer_problems(forged, envelope["evidence_ids"]),
                        "把候选当成定义必须被同一条判据抓住")

    def test_substring_match_is_not_prefix_only(self):
        status, envelope, result = query_term(self.service, name="状态")
        self.assertEqual(status, 200)
        self.assertTrue(result.get("candidates"), f"「状态」应给候选，实际 {result}")
        self.assertIn("1015", [item["term_id"] for item in result["matches"]])

    def test_by_id_path_unchanged(self):
        status, envelope, result = query_term(self.service, term_id="1015")
        self.assertEqual(status, 200)
        self.assertEqual(result.get("term_id"), "1015")
        self.assertEqual(term_answer_problems(result, envelope["evidence_ids"]), [])

    def test_unknown_name_is_not_found(self):
        status, envelope, _ = query_term(self.service, name="不存在的术语名")
        self.assertEqual(status, 404)
        self.assertFalse(envelope["ok"])
        self.assertIn("未知术语名", envelope.get("error", ""))

    def test_neither_id_nor_name_is_bad_request(self):
        status, envelope, _ = query_term(self.service)
        self.assertEqual(status, 400)
        self.assertIn("term_id", envelope.get("error", ""))

    def test_counterproof_predicate_has_teeth(self):
        """反证②③：剥掉出处必须报问题；健康输入必须为空（判据不是恒真/恒假）。"""
        status, envelope, result = query_term(self.service, name="应对状态")
        self.assertEqual(status, 200)
        self.assertEqual(term_answer_problems(result, envelope["evidence_ids"]), [], "健康输入必须判空")
        self.assertTrue(term_answer_problems(result, []), "没有出处必须报问题")
        wrong = [f"ev:{RULESET_ID}:terms.json#1016"]
        self.assertTrue(term_answer_problems(result, wrong), "出处钉到别的术语必须报问题")
        self.assertTrue(term_answer_problems({}, []), "对空回执必须判出问题（不是恒假）")


if __name__ == "__main__":
    unittest.main()
