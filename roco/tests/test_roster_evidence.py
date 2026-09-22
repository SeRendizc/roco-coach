"""roster 回执里**精灵级 / 技能级出处**（第 61 轮 A65-16）。

**这个文件存在的理由**：`docs/roco/GAME-ADAPTER.md` §7 之前登记了一个缺口——
`/rules/query` 的 roster 回执只有**一条 roster 级** evidence（`ev:<ruleset>:roster#total=…`），
它只说明「这份名单是哪一次查询」，**钉不到具体某只精灵、某一招技能**。
于是宿主（浏览器 / mock-host）拿到 48 只精灵时，没有任何可回查的出处。

现在的约定（逐条可核对，不是「看起来一样」）：

  · 每只精灵：`evidence_ids == ["ev:<ruleset>:pets.json#<pet_id>"]`；
  · 配招里每一招：`evidence_ids == ["ev:<ruleset>:skills.json#<skill_id>"]`；
  · 孤儿技能（`missing_in_skills_json: true`，`skills.json` 里查不到这条）
    **不编出处**：`evidence_ids == []`；
  · roster 级那条（信封里的 `evidence_ids`）照旧，用来钉「哪一次查询」。

**反证（必红）**：`test_counterproof_*` 把字段剥掉再喂给同一条判据
（`roster_evidence_problems`），断言它必须报出问题——判据本身有牙，不是恒真。
反过来，如果把 `service.py::_answer_roster` 里刚加的 `evidence_ids` 删掉，
下面的正向用例就会红（实际报错原文见交付汇报）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_roster_evidence -v
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

#: 出处 id 的**形状**（`ev.<ruleset>.pets.json#<pet_id>`），用来先钉形状、再逐 id 比内容。
# RC-402 起，精灵级的出处有两种合法形状：冻结覆盖的指 `pets.json`，
# 按需推算的指 `on-demand-builds.json`（两者都必须是各自那只精灵自己的记录）。
PET_EVIDENCE_RE = re.compile(r"^ev:[^:]+:(?P<file>pets|on-demand-builds)\.json#(?P<pet_id>[A-Za-z0-9_]+)$")
SKILL_EVIDENCE_RE = re.compile(r"^ev:[^:]+:skills\.json#(?P<skill_id>[A-Za-z0-9_]+)$")
ROSTER_EVIDENCE_RE = re.compile(r"^ev:(?P<ruleset>[^:]+):roster#")


def roster_evidence_problems(result, answer_evidence):
    """逐只、逐招核对出处，返回问题清单；空列表 = 合格。

    抽成纯函数只有一个理由：**反证要能复用同一条判据**。
    如果判据写成 `assertTrue(any(...))` 这种一句话，剥掉字段也照样绿，
    那就不是判据。这里每一处都要求**精确相等**（`== [want]`），
    而不是「包含」或「看起来像」。
    """
    problems = []
    if not isinstance(answer_evidence, list) or not answer_evidence:
        return ["信封里没有 roster 级的 evidence_ids"]
    match = ROSTER_EVIDENCE_RE.match(str(answer_evidence[0]))
    if match is None:
        return [f"roster 级 evidence_ids 形状不对：{answer_evidence!r}"]
    ruleset = match.group("ruleset")

    pets = result.get("pets") if isinstance(result, dict) else None
    if not isinstance(pets, list) or not pets:
        return ["回执里没有 pets"]

    for pet in pets:
        pet_id = pet.get("pet_id")
        # RC-402 起，出处**按支持等级**分开：冻结覆盖的指 pets.json，按需推算的指
        # on-demand-builds.json（它在冻结 pets.json 里根本不存在，写那一份就是编出处）。
        # 两种形状都必须精确命中自己的那一只，不接受「包含」。
        frozen_pet = f"ev:{ruleset}:pets.json#{pet_id}"
        on_demand_pet = f"ev:{ruleset}:on-demand-builds.json#{pet_id}"
        want_pet = on_demand_pet if pet.get("build_support") == "SIMULATABLE_UNVERIFIED" else frozen_pet
        got_pet = pet.get("evidence_ids")
        if got_pet != [want_pet]:
            problems.append(f"{pet_id} 的 evidence_ids={got_pet!r}，应为 [{want_pet!r}]")
        else:
            shape = PET_EVIDENCE_RE.match(str(got_pet[0]))
            if shape is None or shape.group("pet_id") != pet_id:
                # 形状不对、或形状对但钉到的是**别的**精灵：后者正是「看起来一样」的陷阱
                problems.append(f"{pet_id} 的出处形状不对或钉到了别的精灵：{got_pet[0]!r}")
        for move in pet.get("moveset") or []:
            skill_id = move.get("skill_id")
            if move.get("missing_in_skills_json") is True:
                if move.get("evidence_ids") != []:
                    problems.append(
                        f"{pet_id}/{skill_id} 是孤儿技能（skills.json 里没有），"
                        f"却编了出处：{move.get('evidence_ids')!r}"
                    )
                continue
            want_skill = f"ev:{ruleset}:skills.json#{skill_id}"
            got_skill = move.get("evidence_ids")
            if got_skill != [want_skill]:
                problems.append(
                    f"{pet_id}/{skill_id} 的 evidence_ids={got_skill!r}，应为 [{want_skill!r}]"
                )
            else:
                shape = SKILL_EVIDENCE_RE.match(str(got_skill[0]))
                if shape is None or shape.group("skill_id") != skill_id:
                    problems.append(f"{pet_id}/{skill_id} 的出处形状不对或钉到了别的技能：{got_skill[0]!r}")
    return problems


def query_roster(service, **params):
    status, envelope = service.rules_query({**BASE, "kind": "roster", **params})
    assert status == 200 and envelope["ok"], f"roster 查询失败：{status} {envelope.get('error')}"
    return envelope


class RosterCarriesPerPetAndPerSkillEvidence(unittest.TestCase):
    """正向：逐只、逐招都有自己的出处。"""

    @classmethod
    def setUpClass(cls):
        cls.service = RocoService(served_ruleset_id=RULESET_ID)

    def test_full_roster_every_pet_and_move_has_its_own_evidence(self):
        envelope = query_roster(self.service)
        result = envelope["result"]
        problems = roster_evidence_problems(result, envelope["evidence_ids"])
        self.assertEqual(problems, [], "出处核对不通过：\n" + "\n".join(problems))

        # 顺便钉住「核到了几只在 / 几招」：全绿但 pets 为空也算通过，那是假绿。
        # RC-402 起默认名单是**冻结已核验的 48 只**（练习局/迁移夹具口径）；
        # 全量 622 走 `support=all`（配队与检索口径），下面单独钉。
        pets = result["pets"]
        self.assertEqual(len(pets), 48, f"默认名单应当仍是 48 只（已核验档），实际 {len(pets)}")
        self.assertTrue(all(p["moveset_size"] == len(p["moveset"]) for p in pets))
        self.assertEqual(sum(len(p["moveset"]) for p in pets), 192,
                         "48 只 × 4 招 = 192 条技能级出处，逐条核过")
        self.assertTrue(all(p["build_support"] == "FULL_VERIFIED" for p in pets),
                        "默认名单里不该出现按需推算的那一档")

    def test_support_all_returns_the_full_catalog_with_two_evidence_files(self):
        """`support=all`：全量 622，且出处按支持等级分成两种文件，两种都要真的出现。"""
        envelope = query_roster(self.service, support="all")
        result = envelope["result"]
        problems = roster_evidence_problems(result, envelope["evidence_ids"])
        self.assertEqual(problems, [], "全量名单的出处核对不通过：\n" + "\n".join(problems[:5]))
        pets = result["pets"]
        self.assertEqual(len(pets), 622)
        by_support = {}
        for pet in pets:
            by_support.setdefault(pet["build_support"], []).append(pet["pet_id"])
        self.assertEqual(sorted(by_support), ["FULL_VERIFIED", "SIMULATABLE_UNVERIFIED"])
        self.assertEqual(len(by_support["FULL_VERIFIED"]), 48)
        self.assertEqual(len(by_support["SIMULATABLE_UNVERIFIED"]), 574)
        for pet in pets:
            want_file = "on-demand-builds.json" if pet["build_support"] == "SIMULATABLE_UNVERIFIED" else "pets.json"
            self.assertIn(f":{want_file}#{pet['pet_id']}", pet["evidence_ids"][0],
                          f"{pet['pet_id']} 的出处文件与支持等级不符：{pet['evidence_ids']}")

    def test_roster_level_evidence_is_unchanged_and_distinct(self):
        """roster 级那条保持原样（钉 total/offset/limit），不是被逐只出处顶替掉。"""
        envelope = query_roster(self.service)
        self.assertEqual(len(envelope["evidence_ids"]), 1)
        self.assertRegex(envelope["evidence_ids"][0], r"^ev:[^:]+:roster#total=\d+;offset=0;limit=None$")

    def test_paged_branch_also_carries_evidence(self):
        envelope = query_roster(self.service, limit=2, offset=0)
        result = envelope["result"]
        self.assertEqual(len(result["pets"]), 2)
        problems = roster_evidence_problems(result, envelope["evidence_ids"])
        self.assertEqual(problems, [], "分页分支出处核对不通过：\n" + "\n".join(problems))
        self.assertIn("limit=2", envelope["evidence_ids"][0])


class OrphanSkillIsNotGivenInventedEvidence(unittest.TestCase):
    """孤儿技能：`skills.json` 里查不到，**不许编**出处。"""

    def test_orphan_move_gets_empty_evidence_and_a_marker(self):
        class _StubPet:
            pet_id = "pet_999999"
            name = "测试孤儿"
            types = ()
            stats = {}
            pet_class = None
            stage = None
            role = None
            speed_tier = None

        class _StubRuleset:
            ruleset_id = "roco-stub-1"
            pets = {"pet_999999": _StubPet()}
            skills = {}          # 空的：候选配招里那一招一定查不到

            def candidate_moveset(self, pet_id):
                return ("skill_999999",)

            def build_support_of(self, pet_id):
                return "FULL_VERIFIED"   # 桩：没有按需产物，一律当作已核验那一档

        service = RocoService(served_ruleset_id=RULESET_ID)
        answer = service._answer_roster(_StubRuleset(), {})   # noqa: SLF001
        result = answer.result
        self.assertEqual(result["pets"][0]["evidence_ids"],
                         ["ev:roco-stub-1:pets.json#pet_999999"])
        move = result["pets"][0]["moveset"][0]
        self.assertEqual(move, {"skill_id": "skill_999999",
                                "missing_in_skills_json": True,
                                "evidence_ids": []})
        # 同一条判据在「精灵有出处、技能没有」时也必须判合格（空数组是唯一合法答案）
        self.assertEqual(roster_evidence_problems(result, answer.evidence_ids), [])


class CounterproofStrippingTheEvidenceTurnsItRed(unittest.TestCase):
    """反证：判据必须有必红方向——剥掉字段，同一条判据必须报错。"""

    @classmethod
    def setUpClass(cls):
        cls.service = RocoService(served_ruleset_id=RULESET_ID)
        cls.envelope = query_roster(cls.service, limit=3, offset=0)

    def _problems(self, result, evidence):
        return roster_evidence_problems(result, evidence)

    def test_baseline_is_green(self):
        """先证明这份样本本身是绿的——否则下面的「变红」毫无意义。"""
        self.assertEqual(self._problems(self.envelope["result"], self.envelope["evidence_ids"]), [])

    def test_stripping_pet_evidence_is_red(self):
        stripped = copy.deepcopy(self.envelope["result"])
        for pet in stripped["pets"]:
            pet.pop("evidence_ids")
        problems = self._problems(stripped, self.envelope["evidence_ids"])
        self.assertTrue(problems, "剥掉 pets[].evidence_ids 之后判据仍然通过——这条判据是空的")
        self.assertIn("evidence_ids=None", problems[0])

    def test_stripping_move_evidence_is_red(self):
        stripped = copy.deepcopy(self.envelope["result"])
        for pet in stripped["pets"]:
            for move in pet["moveset"]:
                move.pop("evidence_ids")
        problems = self._problems(stripped, self.envelope["evidence_ids"])
        self.assertTrue(problems, "剥掉 moveset[].evidence_ids 之后判据仍然通过——这条判据是空的")

    def test_pointing_at_the_wrong_pet_is_red(self):
        """钉到别的精灵（形状对、内容错）也算红——防「看起来一样」。"""
        wrong = copy.deepcopy(self.envelope["result"])
        first, second = wrong["pets"][0], wrong["pets"][1]
        first["evidence_ids"] = [f"ev:{RULESET_ID}:pets.json#{second['pet_id']}"]
        problems = self._problems(wrong, self.envelope["evidence_ids"])
        self.assertTrue(problems, "出处钉错了精灵却判绿——判据只看形状没看内容")

    def test_dropping_roster_level_evidence_is_red(self):
        problems = self._problems(self.envelope["result"], [])
        self.assertTrue(problems, "信封里没有 roster 级 evidence 却判绿")


if __name__ == "__main__":
    unittest.main()
