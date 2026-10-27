"""属性相性：**双属性逐字遵循快照**（2026-10-17 复核；推翻 2026-09-25 裁决）。

**2026-09-25 旧裁决原文（改钉不删，逐字保留）**：
    「属性双属性叠加：快照 3×（现用）vs 两个社区源 4×，差 41 格。**使用社区源**」
⇒ 双属性倍率 = 两条单属性相乘（双弱 4×）。

**2026-10-17 复核：旧裁决被新证据推翻**，理由三条：
  ① 官方 2026-08-15 采访（游戏葡萄/36氪）：电系打翠顶夫人（翼系+水系）玩家「不假思索答三倍」，
     而 AI 分不清「克制 / 强力克制」；
  ② 上游模拟器 `data/roco/raw/extracted/rocom-data/sim/damage_calc.py:92-107` 注释逐字：
     「双属性均弱（两个均 2x）→ 3x（强力克制，非乘算的 4x）」；
  ③ 游戏数据 `types.json`（上游 `Types.lua` 的机械转录）本身把双属性组合封顶在 3。
⇒ **现口径：双属性倍率 = 快照那一行的逐字值**（双弱 3×）。客户端 `type-affinity` 一直读快照；
  本次修复让「结算层（引擎）/ 教学层（RAG 语料）」与展示层对齐。

所以这一组判据的四条都要能咬人：
  ① 单属性 18/18 与旧口径**逐字相同**（克制 2× / 抵抗 0.5× / 无关 1×）；
  ② 双属性 = 快照逐字：全量 1836 格逐格对账 + 三条点名例子
     （`翼系|水系` 受电系 = 3、`虫系|草系` 受火系 = 3、`火系|冰系` 受地系 = 3）；
  ③ 旧裁决的 **41 格必须原样留痕**：用旧「两系相乘」实现跑同一复算，
     必须恰好报出 41 格，且逐格等于手写清单（全部 3 → 4，没有别的形态）；
  ④ **必红反证**：若有人把实现改回相乘，② 的同一个复算必须报出这 41 格 ⇒ ② 必红。

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

#: 旧裁决（两系相乘）与快照不同的 **41 格**（逐格手写）：`(双属性键, 攻击属性, 快照值, 相乘值)`。
#: 这个清单**手写在判据里**，不是从数据算出来的 —— 算出来的清单只能证明「代码与代码一致」，
#: 手写的清单才能证明「代码与旧裁决一致」。改一行就要重新解释一次。
#: 2026-10-17 之后它不再是「现行口径」，而是**旧裁决的留痕**：判据③ 用它证明旧实现确实长这样。
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


def multiply_multiplier(key: str, attack: str) -> float:
    """旧裁决（2026-09-25 → 2026-10-17）：双属性 = 两条单属性相乘。"""
    product = 1.0
    for part in key.split("|"):
        product *= single_multiplier(part, attack)
    return product


def differences_vs_snapshot(chart) -> list:
    """把引擎的双属性倍率与快照逐格对拍，返回 `(键, 攻击属性, 快照值, 引擎值)`。

    这是本文件的核心复算：判据② 与反证④ 用的是**同一个函数** ——
    反证必须能让它报出东西，否则② 的「恰好 0 格差异」只是恒真。
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


def _legacy_multiplier(self, defender_types, attack_element):
    """旧实现（两系相乘）：与本文件顶部留痕的 2026-09-25 裁决一致。"""
    key = self._key(defender_types)
    if len(key) <= 1:
        row = self.rows.get(key)
        return (row or {}).get(attack_element, self.DEFAULT)
    if len(key) != 2 or key not in self.rows:
        raise rdata.TypeCombinationUnknown(defender_types)
    return self.fallback_multiplier(key, attack_element)


class DoubleTypeSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.chart = RS.type_chart

    # ── ① 单属性逐字不变 ────────────────────────────────────────────────
    def test_single_types_are_bit_identical_to_the_snapshot(self):
        """18×18 逐格：单属性行为与旧口径（= 快照的单属性行）一字不差。"""
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

    # ── ② 双属性 = 快照逐字（三条点名例子 + 1836 格全量） ─────────────
    def test_dual_types_follow_the_snapshot_row(self):
        cases = [
            (("翼系", "水系"), "电系", 3.0, "官方采访 Bad Case：电系打翠顶夫人（翼+水）= 三倍"),
            (("虫系", "草系"), "火系", 3.0, "官方采访 Bad Case：花衣蝶（虫+草）被火神三倍克制"),
            (("火系", "冰系"), "地系", 3.0, "旧裁决里的 2×2 例子：快照本身就是 3"),
        ]
        for defenders, attack, expected, why in cases:
            actual = self.chart.multiplier(defenders, attack)
            self.assertEqual(actual, expected,
                             f"{'|'.join(defenders)} 受 {attack} 应为快照的 {expected}（{why}），实际 {actual}")
            self.assertEqual(actual, snapshot_row("|".join(defenders)).get(attack, 1.0),
                             f"{'|'.join(defenders)} 受 {attack} 与快照那一行不一致")

        # 全量：102 条双属性键 × 18 个攻击属性 = 1836 格，逐格等于快照。
        mismatched = []
        for key in DUAL_KEYS:
            a, b = key.split("|")
            row = snapshot_row(key)
            for attack in SINGLE_KEYS:
                if abs(self.chart.multiplier((a, b), attack) - row.get(attack, 1.0)) > 1e-9:
                    mismatched.append((key, attack))
        self.assertEqual(mismatched, [], f"这些格与快照不一致：{mismatched[:5]}")

        # 双属性的档位里**不许出现 4.0**（旧裁决的相乘档）：3 档之外只有 0.25/0.5/1/2。
        dual_tiers = {self.chart.multiplier(tuple(key.split("|")), a)
                      for key in DUAL_KEYS for a in SINGLE_KEYS}
        self.assertNotIn(4.0, dual_tiers, f"双属性出现了相乘档 4.0：{sorted(dual_tiers)}")
        self.assertEqual(dual_tiers, {0.25, 0.5, 1.0, 2.0, 3.0},
                         f"双属性档位 = {sorted(dual_tiers)}")

        # 反写（16 对）必须给出同一个值 —— 同一组合的两种写法不许各算一套。
        for key in DUAL_KEYS:
            a, b = key.split("|")
            if f"{b}|{a}" not in SNAPSHOT:
                continue
            for attack in SINGLE_KEYS:
                self.assertEqual(self.chart.multiplier((a, b), attack),
                                 self.chart.multiplier((b, a), attack),
                                 f"{key} 与 {b}|{a} 的结果不同（同一组合被算了两次）")

    # ── ③ 旧裁决 41 格原样留痕（不是现行口径） ─────────────────────────
    def test_legacy_multiply_would_differ_in_exactly_41_cells(self):
        """用旧「两系相乘」实现跑同一复算：必须恰好报出 41 格，且逐格等于手写清单。"""
        with mock.patch.object(rdata.TypeChart, "multiplier", _legacy_multiplier):
            actual = sorted(differences_vs_snapshot(self.chart))
        expected = sorted(FORTY_ONE_CELLS)
        self.assertEqual(len(actual), 41, f"旧裁决与快照的差异格数 = {len(actual)}，应为 41：{actual[:5]}")
        self.assertEqual(actual, expected, "41 格的清单与 2026-09-25 裁决时登记的清单不一致")
        for key, attack, snap, legacy in actual:
            self.assertEqual(snap, 3.0, f"{key}/{attack} 的快照值不是 3.0")
            self.assertEqual(legacy, 4.0, f"{key}/{attack} 的相乘值不是 4.0")
        # 差异只在 weak（3 → 4）上，没有别的形态；且归类（克制/抵抗/中性）没有一格改变。
        for key in DUAL_KEYS:
            a, b = key.split("|")
            row = snapshot_row(key)
            for attack in SINGLE_KEYS:
                snap = row.get(attack, 1.0)
                legacy = multiply_multiplier(key, attack)
                self.assertEqual(snap > 1.0, legacy > 1.0, f"{key}/{attack} 的克制归类被改了")
                self.assertEqual(snap < 1.0, legacy < 1.0, f"{key}/{attack} 的抵抗归类被改了")
        print(f"\n[实际] 旧裁决（两系相乘）与快照不同的 {len(actual)} 格（全部 3.0 → 4.0），"
              "已按「改钉不删」原样留痕")

    # ── ④ 必红反证：改回相乘 ⇒ 快照判据必红 ───────────────────────────
    def test_reverting_to_multiply_makes_the_snapshot_check_red(self):
        """判据② 用的**同一个复算**，在旧实现下必须报出 41 格 ⇒ 判据②（要求 0 格）必红。"""
        new_diffs = differences_vs_snapshot(self.chart)
        with mock.patch.object(rdata.TypeChart, "multiplier", _legacy_multiplier):
            legacy_diffs = differences_vs_snapshot(self.chart)
            legacy_cells = [(key, attack, self.chart.multiplier(tuple(key.split("|")), attack))
                            for key, attack, _snap, _legacy in FORTY_ONE_CELLS]
        new_cells = [(key, attack, self.chart.multiplier(tuple(key.split("|")), attack))
                     for key, attack, _snap, _legacy in FORTY_ONE_CELLS]
        print(f"\n[实际] 反证：真实现（读快照行）与快照的差异 = {len(new_diffs)} 格；"
              f"旧实现（两系相乘）= {len(legacy_diffs)} 格")
        print(f"[实际] 手写清单里那 41 格：旧实现给 {sorted({v for _, _, v in legacy_cells})}，"
              f"真实现给 {sorted({v for _, _, v in new_cells})}")
        self.assertEqual(new_diffs, [], "真实现必须与快照逐格相同（0 格差异）")
        self.assertEqual(len(legacy_diffs), 41, "旧实现必须报出 41 格差异（否则旧账清单没有牙）")
        self.assertNotEqual(len(legacy_diffs), 0, "旧实现下判据② 必须报红（差异不是 0 格）")
        for _key, _attack, snap, legacy in FORTY_ONE_CELLS:
            new = next(v for k, a, v in new_cells if (k, a) == (_key, _attack))
            old = next(v for k, a, v in legacy_cells if (k, a) == (_key, _attack))
            self.assertEqual(new, snap, f"{_key}/{_attack}：真实现应当给快照值 {snap}")
            self.assertEqual(old, legacy, f"{_key}/{_attack}：旧实现应当给相乘值 {legacy}")
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
