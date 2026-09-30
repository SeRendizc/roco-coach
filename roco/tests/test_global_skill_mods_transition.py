"""**过渡期判据**：`global_skill_mods` 接线中间态的守门（task-28 · 2026-09-30）。

## 为什么要有这个文件

`721 赤子之心` / `728 撒娇` 的实现分两段：
  ① **机制段**（已做 ✓）：`parse` 第四半 ⇒ `global_cost_delta` / `global_power_pct`
     + 能力位 `damage.global_skill_mods`（**v3 已声明 = True** ✓）
     + `env` 写点（`_apply_effect_batch` ✓）与两条读点（`effective_skill_cost` ✓ / 本手威力 ✓）
  ② **判据段**（**已做** ✓ · 2026-09-30 同轮）：`coverage` 三条链传 `global_declared` + `settled` 标签 + 两把尺子收窄

⇒ ⇒ ⚠ **这个中间态有一个真实风险** ✗：**能力位已经声明（v3 True）而没人消费** ✓
  —— 这正是本会话见过 6 次的「**声明了却不生效**」形态 ✗
  ⇒ 若有人只看"叶子声明了"就以为 `721` 已实现 ⇒ **假绿** ✗✗
  ⇒ ⇒ **所以本文件钉住**：**接线完成前，`721`/`728` 必须仍如实说"未结算"** ✓✓

## ⚠ 这一条是"过渡期判据"，**④ 接完线后必须改钉**（改钉不删 ✓）

`coverage` 三条链传上 `global_declared`、`settled` 补标签、两把尺子收窄之后：
  · `721`/`728` 会**真的翻正**（`verdict=True` + 档位 `SIMULATABLE_UNVERIFIED` ✓）
  · 那时 **`test_settles_after_the_wiring`** 那一条要从 `assertFalse` 改成 `assertTrue` ✓
    （**不要删本文件** ✗ —— 它记录了"中间态长什么样、为什么必须钉住" ✓）

⚠ 另：本文件**不是**在测"未实现"本身 ✓ —— 它测的是**"声明与消费必须同步"** ✓
  （叶子声明了 ⇒ 要么真消费、要么如实报未结算 ⇒ **不许"声明即已实现"** ✗）
"""

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import coverage as C  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import PetState  # noqa: E402

SIDS = ("skill_000721", "skill_000728")


class GlobalSkillModsTransitionTest(unittest.TestCase):
    def test_leaf_is_declared_but_nothing_consumes_it_yet(self):
        """⚠ **本判据存在的理由**：**叶子声明了（v3 True）而没人消费** ✓ —— 这是"声明了却不生效"的形态 ✗。

        两条一起钉：
          · **能力位确实声明了** ✓（否则本文件没意义 ✓）
          · **而 `721`/`728` 仍如实未结算** ✓（**不许"声明即已实现"** ✗）
        """
        cfg = RC.get_rule_config("mobile_s4_candidate_v3")
        self.assertTrue(cfg.damage_global_skill_mods,
                        "能力位应已在 v3 声明（True）—— 若变成 False，说明规则集被改动了 ✗")
        self.assertEqual(RC.get_rule_config("legacy_sim_v1").damage_global_skill_mods, False,
                         "legacy 不该声明它 ✗")
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        self.assertTrue(caps.get("global_skill_mods"),
                        "判据侧的声明读数应与配置一致 ✗（不一致 ⇒ 又是'两处口径打架'）")

    def test_settles_after_the_wiring(self):
        """⚠⚠ **本条已按自己的预告改钉**（2026-09-30 · 同一轮内）✗：
        **过渡期结束** —— `coverage` 三条链传上了 `global_declared`、`settled` 补了标签、
        两把尺子同步 ⇒ `721`/`728` **现在真的翻正** ✓。

        改钉前的断言（留档 ✓）：`assertFalse(v["resolved"])` + 档位 `PARTIAL`
          ⇒ 那时叶子已声明而**没人消费** ⇒ 钉的是"声明了却不生效"的过渡形态 ✓
        改钉后（现在 ✓）：**必须真结算** ✓ —— 若它又变回 False，说明接线被回退了 ✗
        ⚠ **本方法不再改回去**：过渡期已经结束 ✓；再出现中间态 ⇒ 应当**新加**一条过渡判据 ✓（不是复活旧断言 ✗）
        """
        rs = D.load_ruleset()
        caps = C.declared_capabilities_of("mobile_s4_candidate_v3")
        for sid in SIDS:
            sk = rs.skills[sid]
            v = C.settlement_verdict(sk, declared=caps)
            self.assertTrue(v["resolved"],
                            f"{sid} 接线完成后**必须真结算** ✗ —— 若变回 False ⇒ 接线被回退了 ✓")
            self.assertIn("全技能持久修正", v["settled"], f"{sid} 的 `settled` 要有那一条 ✗")
            self.assertEqual(C.classify_skill_declared(sk)["support"],
                             C.SUPPORT_SIMULATABLE_UNVERIFIED,
                             f"{sid} 两把尺子必须一致 ✗")

    def test_schema_field_roundtrips_and_stays_out_when_empty(self):
        """新字段的**序列化纪律**（照 `element_power_mods` 那条 ✓）：**空 ⇒ 不进序列化** ✓。"""
        p = PetState.from_dict({
            "pet_id": "p1", "species_id": "fox", "level": 50,
            "hp": 100, "max_hp": 100, "energy": 10, "slot": 0,
        })
        self.assertEqual(dict(p.global_skill_mods or {}), {}, "默认应为空 ✓")
        self.assertNotIn("global_skill_mods", p.to_dict(),
                         "⚠ **空字段不许进序列化** ✗ —— 那会改 legacy / v2 的逐位形状 ✓")
        p.global_skill_mods = {"cost_delta": -2, "power_pct": 10}
        d = p.to_dict()
        self.assertEqual(d.get("global_skill_mods"), {"cost_delta": -2, "power_pct": 10},
                         "非空时进序列化 ✓")
        self.assertEqual(PetState.from_dict(d).global_skill_mods, p.global_skill_mods,
                         "roundtrip 必须逐字一致 ✓")


if __name__ == "__main__":
    unittest.main()
