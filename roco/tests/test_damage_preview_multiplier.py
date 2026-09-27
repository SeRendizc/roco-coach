"""属性倍率要跟到**计划回执**里（2026-09-25）。

**为什么有这一条**：人类报「优势劣势（红绿色）不是实时计算的？上一回合优势、下回合劣势了，
显示还是绿色的优势」。查下来根因在**页面模板**：`roco.html` 里写死了设计稿的
`data-b3-rel="up"` 与 `class="b3-dmg--up"`，JS 从来不更新它们。

修法分两半，这一份钉**引擎那一半**：`_damage_preview` 里算出的属性倍率，必须跟着
`_merge_previews` 一起出现在**计划回执**的 `damage_preview.samples[]` 上
（计划走的是合并结果；只在 `_damage_preview` 里加字段等于没做 —— 实测踩到过一次）。

口径：倍率取**结算用的那一份表**（`effects.compute_damage` 内部就是
`rs.type_chart.multiplier(defender_species.types, skill.element)`），
所以页面上的三角与"玩家真会看到的结果"同源；拿不到对手属性时是 `None`（页面据此**不画**）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_damage_preview_multiplier -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
RULESET_ID = RS.ruleset_id
TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
BASE = {"ruleset_id": RULESET_ID}


def sample(label, damage, multiplier, element="虫系", defenders=("恶系",)):
    return {"label": label, "kind": "skill", "skill_id": f"skill_{label}", "damage": damage,
            "energy": 1, "formula_verified": False,
            "multiplier": multiplier, "multiplier_element": element,
            "multiplier_defender_types": list(defenders),
            "multiplier_source": "effects.compute_damage 用的同一份 TypeChart"}


def preview(seed_offset):
    """一份"某个分析种子"的预览（形状照 `_damage_preview` 的产出）。"""
    return {"available": True, "min": 100 + seed_offset, "max": 200 + seed_offset,
            "best_label": "翅刃", "lethal": False, "lethal_stable": True, "foe_hp": 391,
            "samples": [sample("翅刃", 200 + seed_offset, 2.0), sample("啃咬", 100 + seed_offset, 1.0)],
            "skipped_skills": [], "candidates": 2,
            # `_merge_previews` 还会读这几个顶层字段：形状要照真回执给全。
            "formula_verified": False, "damage_model": "community-hypothesis-v1"}


class MergePreviewsKeepsMultiplier(unittest.TestCase):
    """**这一条钉的是我实际踩到的那一步**：倍率在 `_damage_preview` 里算好了，
    但计划回执走的是 `_merge_previews` —— 不在合并里带出来，页面就永远拿不到。"""

    def test_merge_keeps_multiplier_per_skill(self):
        merged = RocoService._merge_previews([preview(0), preview(3)])
        by_label = {row["label"]: row for row in merged["samples"]}
        self.assertEqual(sorted(by_label), ["啃咬", "翅刃"])
        self.assertEqual(by_label["翅刃"]["multiplier"], 2.0)
        self.assertEqual(by_label["啃咬"]["multiplier"], 1.0)
        self.assertEqual(by_label["翅刃"]["multiplier_element"], "虫系")
        self.assertEqual(by_label["翅刃"]["multiplier_defender_types"], ["恶系"])
        # 伤害仍是区间（合并没有被这次改动影响）
        self.assertEqual((by_label["翅刃"]["min"], by_label["翅刃"]["max"]), (200, 203))

    def test_counterproof_dropping_the_field_merges_to_none(self):
        """反证：上游一旦不带这个字段，合并结果必须是 `None`（而不是编一个或留旧的）。
        这一条同时说明上面的断言**不是恒真**：字段没了它就红。"""
        bare = preview(0)
        for row in bare["samples"]:
            for key in ("multiplier", "multiplier_element", "multiplier_defender_types"):
                row.pop(key, None)
        merged = RocoService._merge_previews([bare])
        for row in merged["samples"]:
            self.assertIsNone(row["multiplier"], f"{row['label']} 没有倍率时必须写 None")
        self.assertNotEqual(merged["samples"][0]["multiplier"], 2.0)

    def test_disagreeing_seeds_fail_closed(self):
        """各分析种子的倍率不一致 ⇒ 不写（不挑一个）。"""
        a, b = preview(0), preview(3)
        b["samples"][0]["multiplier"] = 0.5
        merged = RocoService._merge_previews([a, b])
        top = next(row for row in merged["samples"] if row["label"] == "翅刃")
        self.assertIsNone(top["multiplier"], "两个种子不一致时不许挑一个")


if __name__ == "__main__":
    unittest.main()
