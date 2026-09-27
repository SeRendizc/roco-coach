"""属性相性：**双属性按两系相乘**（2026-09-25 人类裁决）。

人类原话：「属性双属性叠加：快照 3×（现用）vs 两个社区源 4×，差 41 格。**使用社区源**」。

这条裁决**推翻了**本仓此前的口径（旧口径逐字留在下面与台账 EV-TYPE-MULTIPLIER 的 notes 里，
「改钉不删」），所以这一组判据的四条都要能咬人：

  ① 单属性 18/18 与改前**逐字相同**（克制 2× / 抵抗 0.5× / 无关 1×）；
  ② 双属性 = 两条单属性相乘：`冰系|地系` 受火系 = 1.0（0.5×2）、
     `火系|冰系` 受地系 = 4.0、`虫系|草系` 受火系 = 4.0；
  ③ 与旧快照的差异**恰好 41 格**，且**逐格列出来**（41 格全部是 3 → 4，没有别的形态）；
  ④ **必红反证**：把相乘改回「读快照封顶行」，同一个复算必须报出这 41 格
     —— 否则 ①③ 只是恒真的装饰。

另加一条 fail closed：快照只给了 86 个双属性组合（18 选 2 共 153），
其余 **67** 个组合「不可查」：`TypeChart.multiplier` 抛 `TypeCombinationUnknown`，
既不返回中性 1.0、也不用别的组合顶。

运行：cd roco && PYTHONPATH=src python3 -m unittest tests.test_type_multiplier_ruling -v
（`npm run test:env` 会自动发现它）
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata       # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
RS = rdata.load_ruleset()
TYPES_JSON = os.path.join(ROOT, "data", "roco", "normalized", RS.ruleset_id, "types.json")
with open(TYPES_JSON, "r", encoding="utf-8") as _fh:
    SNAPSHOT = json.load(_fh)["types"]

SINGLE_KEYS = sorted(key for key in SNAPSHOT if "|" not in key)
DUAL_KEYS = sorted(key for key in SNAPSHOT if "|" in key)

#: 与旧快照不同的 **41 格**（逐格列出）：`(双属性键, 攻击属性, 快照值, 相乘值)`。
#: 这个清单**手写在判据里**，不是从数据算出来的 —— 算出来的清单只能证明「代码与代码一致」，
#: 手写的清单才能证明「代码与裁决一致」。改一行就要重新解释一次。
FORTY_ONE_CELLS = [
    ("光系|地系", "草系", 3.0, 4.0),
    ("光系|水系", "草系", 3.0, 4.0),
    ("冰系|地系", "机械系", 3.0, 4.0),
    ("冰系|地系", "武系", 3.0, 4.0),
    ("冰系|电系", "地系", 3.0, 4.0),
    ("冰系|草系", "火系", 3.0, 4.0),
    ("冰系|萌系", "机械系", 3.0, 4.0),
    ("地系|光系", "草系", 3.0, 4.0),
    ("地系|恶系", "武系", 3.0, 4.0),
    ("地系|水系", "草系", 3.0, 4.0),
    ("地系|翼系", "冰系", 3.0, 4.0),
    ("地系|草系", "冰系", 3.0, 4.0),
    ("幻系|光系", "幽系", 3.0, 4.0),
    ("幻系|幽系", "幽系", 3.0, 4.0),
    ("幽系|光系", "幽系", 3.0, 4.0),
    ("幽系|幻系", "幽系", 3.0, 4.0),
    ("幽系|恶系", "光系", 3.0, 4.0),
    ("幽系|毒系", "恶系", 3.0, 4.0),
    ("幽系|萌系", "恶系", 3.0, 4.0),
    ("恶系|冰系", "武系", 3.0, 4.0),
    ("恶系|地系", "武系", 3.0, 4.0),
    ("普通系|机械系", "武系", 3.0, 4.0),
    ("机械系|地系", "武系", 3.0, 4.0),
    ("机械系|地系", "水系", 3.0, 4.0),
    ("机械系|火系", "水系", 3.0, 4.0),
    ("机械系|草系", "火系", 3.0, 4.0),
    ("机械系|虫系", "火系", 3.0, 4.0),
    ("毒系|萌系", "恶系", 3.0, 4.0),
    ("水系|翼系", "电系", 3.0, 4.0),
    ("火系|冰系", "地系", 3.0, 4.0),
    ("火系|毒系", "地系", 3.0, 4.0),
    ("翼系|水系", "电系", 3.0, 4.0),
    ("草系|冰系", "火系", 3.0, 4.0),
    ("草系|地系", "冰系", 3.0, 4.0),
    ("草系|幻系", "虫系", 3.0, 4.0),
    ("草系|武系", "翼系", 3.0, 4.0),
    ("草系|萌系", "毒系", 3.0, 4.0),
    ("萌系|毒系", "恶系", 3.0, 4.0),
    ("虫系|草系", "火系", 3.0, 4.0),
    ("虫系|草系", "翼系", 3.0, 4.0),
    ("龙系|翼系", "冰系", 3.0, 4.0),
]


def snapshot_row(key: str) -> dict:
    """快照那一行的逐字倍率（未列出 = 中性 1.0）。"""
    table = {}
    for item in SNAPSHOT[key].get("weak", []):
        table[item["type"]] = float(item["multiplier"])
    for item in SNAPSHOT[key].get("resist", []):
        table.setdefault(item["type"], float(item["multiplier"]))
    return table


def single_multiplier(key: str, attack: str) -> float:
    return snapshot_row(key).get(attack, 1.0)


def differences_vs_snapshot(chart) -> list:
    """把引擎的双属性倍率与旧快照逐格对拍，返回 `(键, 攻击属性, 快照值, 引擎值)`。

    这是本文件的核心复算：判据 ③ 与反证 ④ 用的是**同一个函数** ——
    反证必须能让它报出东西，否则 ③ 的「恰好 41 格」只是恒真。
    """
    out = []
    for key in DUAL_KEYS:
        a, b = key.split("|")
        row = snapshot_row(key)
        for attack in SINGLE_KEYS:
            engine = chart.multiplier((a, b), attack)
            snap = row.get(attack, 1.0)
            if abs(engine - snap) > 1e-9:
                out.append((key, attack, snap, float(engine)))
    return out


class DoubleTypeMultipliesTest(unittest.TestCase):
    def setUp(self):
        self.chart = RS.type_chart

    # ── ① 单属性逐字不变 ────────────────────────────────────────────────
    def test_single_types_are_bit_identical_to_the_snapshot(self):
        """18×18 逐格：单属性行为与改前（= 快照的单属性行）一字不差。"""
        checked = 0
        for defender in SINGLE_KEYS:
            row = snapshot_row(defender)
            for attack in SINGLE_KEYS:
                actual = self.chart.multiplier((defender,), attack)
                self.assertEqual(actual, row.get(attack, 1.0),
                                 f"{defender} 受 {attack}：单属性口径被改动了")
                checked += 1
        self.assertEqual(checked, 18 * 18)
        # 三档都在（否则上面那 324 格可能是「一律 1.0」的假绿）。
        tiers = {self.chart.multiplier((d,), a) for d in SINGLE_KEYS for a in SINGLE_KEYS}
        self.assertEqual(tiers, {0.5, 1.0, 2.0}, f"单属性档位 = {sorted(tiers)}")
        # 判据的牙：把一个单属性倍率改掉，同一个复算必须报不等。
        tampered = mock.patch.object(
            rdata.TypeChart, "multiplier",
            lambda self, types, element: 4.0 if tuple(types) == ("冰系",) else 1.0,
        )
        with tampered:
            self.assertNotEqual(self.chart.multiplier(("冰系",), "火系"),
                                snapshot_row("冰系")["火系"])

    # ── ② 双属性 = 两系相乘（三条人类点名的例子） ──────────────────────
    def test_dual_types_multiply_the_two_single_rows(self):
        cases = [
            (("冰系", "地系"), "火系", 1.0, "0.5（冰系抵抗火系）× 2（地系被火系克制）"),
            (("火系", "冰系"), "地系", 4.0, "2 × 2"),
            (("虫系", "草系"), "火系", 4.0, "2 × 2"),
        ]
        for defenders, attack, expected, why in cases:
            actual = self.chart.multiplier(defenders, attack)
            self.assertEqual(actual, expected, f"{'|'.join(defenders)} 受 {attack} 应为 {expected}（{why}），实际 {actual}")
            product = 1.0
            for d in defenders:
                product *= single_multiplier(d, attack)
            self.assertEqual(actual, product, f"{'|'.join(defenders)} 受 {attack} 与两系相乘不一致")
        # 全量：102 条双属性键 × 18 个攻击属性 = 1836 格，逐格都等于两系相乘。
        mismatched = []
        for key in DUAL_KEYS:
            a, b = key.split("|")
            for attack in SINGLE_KEYS:
                expected = single_multiplier(a, attack) * single_multiplier(b, attack)
                if abs(self.chart.multiplier((a, b), attack) - expected) > 1e-9:
                    mismatched.append((key, attack))
        self.assertEqual(mismatched, [], f"这些格不是两系相乘：{mismatched[:5]}")
        # 反写（16 对）必须给出同一个值 —— 同一组合的两种写法不许各算一套。
        for key in DUAL_KEYS:
            a, b = key.split("|")
            if f"{b}|{a}" not in SNAPSHOT:
                continue
            for attack in SINGLE_KEYS:
                self.assertEqual(self.chart.multiplier((a, b), attack),
                                 self.chart.multiplier((b, a), attack),
                                 f"{key} 与 {b}|{a} 的结果不同（同一组合被算了两次）")

    # ── ③ 恰好 41 格与旧快照不同，逐格列出 ─────────────────────────────
    def test_exactly_41_cells_differ_from_the_snapshot(self):
        actual = sorted(differences_vs_snapshot(self.chart))
        expected = sorted(FORTY_ONE_CELLS)
        self.assertEqual(len(actual), 41, f"与旧快照的差异格数 = {len(actual)}，应为 41：{actual[:5]}")
        self.assertEqual(actual, expected, "41 格的清单与裁决时登记的清单不一致")
        for key, attack, snap, engine in actual:
            self.assertEqual(snap, 3.0, f"{key}/{attack} 的快照值不是 3.0")
            self.assertEqual(engine, 4.0, f"{key}/{attack} 的相乘值不是 4.0")
        # 差异只在 weak（3 → 4）上，没有别的形态；且归类（克制/抵抗/中性）没有一格改变。
        for key in DUAL_KEYS:
            a, b = key.split("|")
            for attack in SINGLE_KEYS:
                snap = snapshot_row(key).get(attack, 1.0)
                engine = self.chart.multiplier((a, b), attack)
                self.assertEqual(snap > 1.0, engine > 1.0, f"{key}/{attack} 的克制归类被改了")
                self.assertEqual(snap < 1.0, engine < 1.0, f"{key}/{attack} 的抵抗归类被改了")
        # 逐格打印（报告里要贴实际值，不能只写「应当为真」）。
        print(f"\n[实际] 与旧快照不同的 {len(actual)} 格（全部 3.0 → 4.0）：")
        for key, attack, snap, engine in actual:
            print(f"  · {key} 受 {attack}：快照 ×{snap} → 裁决 ×{engine}")
        combos = {tuple(sorted(key.split("|"))) for key, _, _, _ in actual}
        pairs = {(tuple(sorted(key.split("|"))), attack) for key, attack, _, _ in actual}
        print(f"[实际] 涉及 {len(combos)} 个组合（按去重计）、{len(pairs)} 个「组合×攻击属性」对"
              f"（41 格是**按 102 条键逐格数**的结果，16 对反写各算一次）")

    # ── ④ 必红反证：改回封顶 ⇒ 同一个复算必须报红 ──────────────────────
    def test_reverting_to_the_capped_snapshot_makes_the_same_check_red(self):
        """必红反证：判据③ 用的**同一个复算**，在旧实现下必须留下 0 格差异。

        判据③ 的本体是「差异恰好 41 格，且逐格等于手写清单」。旧实现（读快照封顶行）
        下同一个复算给出 0 格 ⇒ 判据③ 必红（41 ≠ 0）；而手写清单里那 41 条
        `assertEqual(引擎值, 4.0)` 也会逐条变红（旧实现给的是快照的 3.0）。
        """

        def capped_multiplier(self, defender_types, attack_element):
            """旧实现（改钉不删）：直接读快照那一行，双属性封顶 3.0。"""
            row = self.rows.get(tuple(sorted(set(defender_types))))
            if row is not None:
                return row.get(attack_element, self.DEFAULT)
            return self.DEFAULT

        with mock.patch.object(rdata.TypeChart, "multiplier", capped_multiplier):
            old_diffs = differences_vs_snapshot(self.chart)
            old_cells = [(key, attack, self.chart.multiplier(tuple(key.split("|")), attack))
                         for key, attack, _snap, _engine in FORTY_ONE_CELLS]
        new_diffs = differences_vs_snapshot(self.chart)
        new_cells = [(key, attack, self.chart.multiplier(tuple(key.split("|")), attack))
                     for key, attack, _snap, _engine in FORTY_ONE_CELLS]
        print(f"\n[实际] 反证：旧实现（读快照封顶行）与快照的差异 = {len(old_diffs)} 格 ⇒ 判据③（要求 41）必红；"
              f"真实现 = {len(new_diffs)} 格")
        print(f"[实际] 手写清单里那 41 格：旧实现给 {sorted({v for _, _, v in old_cells})}，"
              f"真实现给 {sorted({v for _, _, v in new_cells})}")
        self.assertEqual(len(old_diffs), 0, "旧实现本该与快照逐格相同（它的值就是从快照读的）")
        self.assertEqual(len(new_diffs), 41)
        self.assertNotEqual(len(old_diffs), 41, "旧实现下判据③ 必须报红（差异不是 41 格）")
        for _key, _attack, snap, engine in FORTY_ONE_CELLS:
            old = next(v for k, a, v in old_cells if (k, a) == (_key, _attack))
            new = next(v for k, a, v in new_cells if (k, a) == (_key, _attack))
            self.assertEqual(old, snap, f"{_key}/{_attack}：旧实现应当给快照值 {snap}")
            self.assertEqual(new, engine, f"{_key}/{_attack}：真实现应当给相乘值 {engine}")
            self.assertNotEqual(old, new, f"{_key}/{_attack}：两种口径必须不同，否则这条反证没有牙")

    # ── fail closed：67 个组合不可查 ───────────────────────────────────
    def test_missing_combinations_are_unqueryable(self):
        declared = {tuple(sorted(key.split("|"))) for key in DUAL_KEYS}
        all_combos = {(a, b) for i, a in enumerate(SINGLE_KEYS) for b in SINGLE_KEYS[i + 1:]}
        missing = sorted(all_combos - declared)
        self.assertEqual(len(declared), 86, "快照给出的不同双属性组合数不是 86")
        self.assertEqual(len(all_combos), 153, "18 选 2 应当是 153")
        self.assertEqual(len(missing), 67, f"缺组合数 = {len(missing)}，应为 67")
        self.assertEqual(self.chart.declared_combinations, frozenset(declared))
        for combo in missing:
            with self.assertRaises(rdata.TypeCombinationUnknown,
                                   msg=f"{combo} 快照没有行，必须 fail closed，不许返回倍率"):
                self.chart.multiplier(combo, "草系")
            self.assertFalse(self.chart.has_row(combo), f"{combo} 不该被报成「有行」")
        for combo in declared:
            self.assertTrue(self.chart.has_row(combo))
            self.chart.multiplier(combo, "草系")     # 有行 ⇒ 不许抛
        # 当前规则集里的每一只精灵都必须落在可查集合里（否则一场对局会中途抛错）。
        unqueryable = sorted({pet.name for pet in RS.pets.values()
                              if len(set(pet.types)) > 1 and not self.chart.has_row(pet.types)})
        self.assertEqual(unqueryable, [],
                         f"这些精灵的属性组合不可查（引擎会在结算时 fail closed）：{unqueryable}")
        print(f"\n[实际] 快照给出 {len(declared)} 个双属性组合；缺 {len(missing)} 个 ⇒ 一律不可查")


class TypeRowOffenseViewTest(unittest.TestCase):
    """`type_row` 的**进攻向** `offense`（2026-09-25 加，服务层）。

    为什么加：英文/中文里「A 克制什么」是**进攻向**（A 打谁 ×2），而快照每一行给的是
    **防守向**（这一系怕什么/抗什么）。过去玩家问「火系克制什么属性」，
    要么模型凭记忆答、要么拿防守向列表答错方向（真机实测：营地问句拿到的是
    「进入一场 PVE 对战后…」这种非答案）。所以进攻向必须由**引擎逐行数出来**：
    谁的 weak 里有它，就是它克制的 —— 18 行单属性逐字来自快照，不做推断。
    """

    def _row(self, key):
        from roco_env.service import RocoService
        service = RocoService()          # 服务自己按默认规则集装载（与线上同一条路）
        answer = service._answer_type_row(RS, {"type": key})
        self.assertTrue(answer.result, f"{key} 应该有相性行")
        return answer.result

    def test_offense_is_counted_from_the_snapshot_rows(self):
        row = self._row("火系")
        offense = {item["type"]: item["multiplier"] for item in row["offense"]}
        # 逐行数出来的期望值：快照里谁把「火系」写进 weak，谁就被火系克制
        expected = {}
        for other, other_row in SNAPSHOT.items():
            if "|" in other:
                continue
            for entry in other_row.get("weak", []):
                if entry.get("type") == "火系":
                    expected[other] = float(entry["multiplier"])
        self.assertEqual(offense, expected, "offense 必须与逐行数 weak 的结果逐值相同")
        self.assertIn("冰系", offense)
        self.assertEqual(offense["冰系"], 2.0)
        print(f"\n[实际] 火系克制：{sorted(offense)}（共 {len(offense)} 系）")

    def test_offense_and_defense_are_different_views(self):
        """进攻向与防守向**不是同一份数据**：火系怕水系，但火系并不克制水系。"""
        row = self._row("火系")
        weak = {item["type"] for item in row["weak"]}
        offense = {item["type"] for item in row["offense"]}
        self.assertIn("水系", weak)
        self.assertNotIn("水系", offense)
        self.assertNotIn("地系", offense)

    def test_every_single_type_has_a_consistent_offense_view(self):
        """18 个单属性逐个核对：offense 里的每一项都能在对方那一行里找到 ×N 的出处。"""
        for key in SINGLE_KEYS:
            row = self._row(key)
            for item in row["offense"]:
                target = SNAPSHOT[item["type"]]
                hits = [entry for entry in target.get("weak", []) if entry.get("type") == key]
                self.assertEqual(len(hits), 1, f"{key} → {item['type']} 应在对方 weak 里恰好一条")
                self.assertEqual(float(hits[0]["multiplier"]), float(item["multiplier"]))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
