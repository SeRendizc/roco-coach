"""**`463 点亮` 的过渡期判据**（task-28 · 2026-09-30）。

## 为什么要有这个文件（**新规矩第 ③ 条的落实** ✓）

`463 点亮`「减伤90%，**应对攻击**：自己获得光系技能威力永久+50%。」[防御] 的现状：
  · **接线已在** ✓ —— 防御支（`env` 那一段）**已经调** `resolve_element_power_ramp` ✓
  · ⚠ **但行为还没接** ✗ —— `parse.resolve_element_power_ramp` 里的**位置闸**把它挡住了 ✓
    （那道闸是我为 `462 放晴` 加的 ✓ 闸的注释里**逐字**写着「`463` 留原样、如实报不支持 —— 它是后续批次的事」✓
     ⇒ ⇒ 放它过去就会"**没应对也加威力**" ⇒ **假绿** ✗ ✓）
  · ⇒ ⇒ 所以现在是「**闸在、接线在、注释还在**」✗ —— **下一个人读代码会以为它已经接好了** ✗✗
    （**"叶子/接线在而行为没接"这个形态，本会话见过 6 次** ✗）

⇒ ⇒ **本文件曾钉住**：**放宽前 `463` 必须仍如实说"未结算"** ✓✓（**该过渡期已于同日结束 ✓** —— 见下面改钉后的方法 ✓）

## ⚠ 放宽之后（`allow_respond_clause=True` 只在防御支传 ✓）**必须改钉**

改法（Lead 2026-09-30 裁决 ✓）：给 `resolve_element_power_ramp` 加
**`allow_respond_clause: bool = False`** ✓ —— **默认 False ⇒ 别处逐位不变** ✓；
**只在防御支那一处传 `True`** ✓（**只有那一支**具备"应对成功才 `_apply_effect_batch`"的结构 ✓）。
⇒ ⛔ **绝不删那道闸** ✗（删了 ⇒ 任何位置都产出 ⇒ 假绿 ✗）。

改钉后本文件的 `test_stays_unsettled_until_the_gate_is_relaxed` 应改成 `assertTrue` ✓（**改钉不删** ✓）。
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import coverage as C  # noqa: E402
from roco_env import parse as P  # noqa: E402

SID = "skill_000463"
GATE_EVIDENCE = "463 留原样、如实报不支持"


class ElementPowerRampDefenseBranchTransitionTest(unittest.TestCase):
    def test_position_gate_still_exists_and_names_463(self):
        """⚠ **过渡期的"物证"**：那道位置闸**还在**，且它的注释**仍点名 463** ✓。

        若这条红了 ⇒ 说明闸被删/被改动 ⇒ ⚠ **先回来看这一条**（删闸 = 任何位置都产出 = 假绿 ✗）。
        """
        src = Path(P.__file__).read_text(encoding="utf-8")
        i = src.find("def resolve_element_power_ramp")
        self.assertGreater(i, 0, "找不到 resolve_element_power_ramp ✗")
        body = src[i:i + 4000]
        self.assertIn("_RESPOND_KIND_IN_DESC.search(desc)", body,
                      "位置闸的判断语句不见了 ✗（删闸 ⇒ 假绿 ✗）")
        self.assertIn(GATE_EVIDENCE, body,
                      f"闸的注释里应仍点名 463（逐字：{GATE_EVIDENCE!r}）✗ —— 那是本过渡期的物证 ✓"
                      "（放宽后本断言应改钉为『应出现 allow_respond_clause』✓）")

    def test_settles_after_the_gate_is_relaxed(self):
        """⚠⚠ **本条已按自己的预告改钉**（2026-09-30 · 同一轮内）✗：**过渡期结束** ✓。

        放宽后（防御支传 `allow_respond_clause=True` ✓ + `coverage` 三条链对齐 ✓ +
        evidence 覆盖「获得」那一段 ✓）⇒ `463` **真的翻正** ✓。

        改钉前的断言（留档 ✓）：`assertFalse(v["resolved"])` + `assertTrue(v["unsettled"])` + 档位 `PARTIAL`
          ⇒ 那时"接线在而行为没接" ⇒ 钉的是「**声明/闸在，行为没接**」那个过渡形态 ✓
        改钉后（现在 ✓）：**必须真结算 + 两把尺子一致** ✓ —— 若变回 False ⇒ 说明放宽或对齐被回退了 ✗
        ⚠ **本方法不再改回去** ✓；若再出现中间态 ⇒ 应当**新加**一条过渡判据 ✓（不是复活旧断言 ✗）
        """
        rs = D.load_ruleset()
        sk = rs.skills[SID]
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        v = C.settlement_verdict(sk, declared=caps)
        self.assertTrue(v["resolved"], f"{SID} 放宽后**必须真结算** ✗（若变回 False ⇒ 放宽/对齐被回退了）")
        self.assertEqual(v["unsettled"], [], f"{SID} 的 `unsettled` 必须清空 ✗")
        self.assertEqual(P.unclaimed_mechanic_spans(sk, parsed=v["parsed"]), [],
                         f"{SID} 的 `spans` 必须为空 ✗")
        self.assertEqual(C.classify_skill_declared(sk)["support"],
                         C.SUPPORT_SIMULATABLE_UNVERIFIED, f"{SID} 两把尺子必须一致 ✗")

    def test_raw_parse_produces_nothing_for_now(self):
        """过渡期还有一条物证：**裸解析对 `463` 一个字都不产出** ✓（宽度闸挡住 ✓）。"""
        rs = D.load_ruleset()
        self.assertEqual([e.kind for e in P.parse_skill(rs.skills[SID]).effects], [],
                         "过渡期里 463 不该产出 effect（闸在挡 ✓）✗")


if __name__ == "__main__":
    unittest.main()
