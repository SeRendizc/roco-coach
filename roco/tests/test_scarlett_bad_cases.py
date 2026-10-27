"""官方「斯嘉丽」公开 Bad Case 回归判据（2026-10-17）。

官方 2026-08-15 深度采访（游戏葡萄/36氪转载）点名了两个真实错误，本文件把它们做成
**可回归判据**（而不是只在面试里讲）：

  ① 电系打翠顶夫人（翼系+水系）= **三倍**（AI 把「克制 / 强力克制」搞混）；
  ② 虫队打火神：AI 让花衣蝶用灼烧逼退火神 —— 但花衣蝶被火神**三倍克制**、
     而且**火神不吃灼烧**（术语 1002：「（火系精灵免疫此效果）」）。

三条判据各自带反证方向：

  A. 倍率：翼|水 受电 = 3；虫|草 受火 = 3（引擎；不是 RAG 文本、不是前端缓存）。
  B. 灼烧免疫：技能挂上的灼烧对**火系目标**必须 no-op（事件 `status_immune`、层数不写）；
     对**非火系目标**必须真的挂上（反向对照，防止「一律不挂」的假绿）。
  C. 必红反证：把 `_status_immune` 打掉 ⇒ 火系目标会被挂上灼烧 ⇒ B 必红。

运行：cd roco && PYTHONPATH=src python3 -m unittest tests.test_scarlett_bad_cases -v
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import rule_config as RC        # noqa: E402
from roco_env.schema import ACTION_SKILL      # noqa: E402

RS = rdata.load_ruleset()
SEED = 20261017
CFG = RC.get_rule_config("mobile_s4_candidate_v3")

CASTER = "pet_000445"          # 黑猫巫师：会「引燃」（skill_000387，敌方获得 10 层灼烧）
BURN_SKILL = "skill_000387"
FIRE = "pet_000006"            # 火神（火系）—— 官方 Bad Case 2 的受害者
GRASS = "pet_000001"           # 喵喵（草系）—— 非火系对照
CRIMSON = "pet_000280"         # 翠顶夫人（翼系+水系）
BUTTERFLY = "pet_000127"       # 花衣蝶（虫系+草系）

TEAM = [CASTER, "pet_000001", "pet_000007", "pet_000022", "pet_000118", "pet_000137"]
LOADOUT = {CASTER: [BURN_SKILL, "skill_000614", "skill_000251", "skill_000260"]}
FILLERS = ["pet_000003", "pet_000004", "pet_000005", "pet_000009", "pet_000010"]


def _open(foes):
    return renv.reset(TEAM, foes, seed=SEED, rs=RS, loadouts=LOADOUT, config=CFG)


def _pick_skill(state, side, skill_id):
    for action in renv.legal_actions(state, RS, side, CFG):
        if action.kind == ACTION_SKILL and action.skill_id == skill_id:
            return action
    raise AssertionError(f"{side} 这一手没有 {skill_id}（{RS.skills[skill_id].name}）—— 前提不成立")


def _enemy_action(state):
    acts = renv.legal_actions(state, RS, "enemy", CFG)
    for action in acts:
        if action.kind == ACTION_SKILL and RS.skills[action.skill_id].is_defense:
            return action
    for action in acts:
        if action.kind == ACTION_SKILL:
            return action
    return acts[0]


def _play_burn(state):
    before = len(state.events)
    player = _pick_skill(state, "player", BURN_SKILL)
    state = renv.step_joint(state, RS, player, _enemy_action(state))
    return state, [(ev.kind, ev.detail) for ev in state.events[before:]]


class ScarlettTypeBadCaseTest(unittest.TestCase):
    """官方 Bad Case ①：电系打翠顶夫人（翼+水）= 三倍（双弱封顶 3，不是相乘的 4）。"""

    def test_electric_vs_wing_water_is_three(self):
        chart = RS.type_chart
        self.assertEqual(tuple(RS.pets[CRIMSON].types), ("翼系", "水系"))
        self.assertEqual(chart.multiplier(("翼系", "水系"), "电系"), 3.0,
                         "官方采访：电系打翠顶夫人（翼+水）玩家答「三倍」；双弱不是相乘的 4×")
        self.assertEqual(chart.multiplier(("水系", "翼系"), "电系"), 3.0, "反写必须同值")

    def test_fire_vs_bug_grass_is_three(self):
        chart = RS.type_chart
        self.assertEqual(tuple(RS.pets[BUTTERFLY].types), ("虫系", "草系"))
        self.assertEqual(chart.multiplier(("虫系", "草系"), "火系"), 3.0,
                         "官方采访：花衣蝶（虫+草）被火神「三倍克制」")
        self.assertEqual(chart.multiplier(("草系", "虫系"), "火系"), 3.0, "反写必须同值")

    def test_no_dual_type_ever_reports_four(self):
        """双属性倍率里不许出现旧裁决的 ×4（全部 102 条键 × 18 属性逐格扫）。"""
        chart = RS.type_chart
        duals = [key for key in RS.type_chart.rows if len(key) > 1]
        singles = [key[0] for key in RS.type_chart.rows if len(key) == 1]
        offenders = []
        for combo in duals:
            for attack in singles:
                value = chart.multiplier(combo, attack)
                if abs(value - 4.0) < 1e-9:
                    offenders.append((combo, attack))
        self.assertEqual(offenders, [], f"双属性出现了旧裁决的 ×4：{offenders[:5]}")
        print(f"\n[实际] 双属性组合 {len(duals)} 条 × {len(singles)} 属性：0 格 ×4（官方口径 3× 生效）")


class ScarlettBurnImmunityTest(unittest.TestCase):
    """官方 Bad Case ②：火神不吃灼烧（术语 1002「火系精灵免疫此效果」）。"""

    def test_burn_on_fire_target_is_immune(self):
        state = _open([FIRE] + FILLERS)
        self.assertEqual(state.enemy.field_pet.pet_id, FIRE, "对手场上必须是火神（前提）")
        state, events = _play_burn(state)
        kinds = [kind for kind, _ in events]
        self.assertIn("status_immune", kinds, f"火系目标必须产生 status_immune 事件（实际 {kinds}）")
        self.assertNotIn("灼烧", state.enemy.field_pet.statuses,
                         f"火神身上不许出现灼烧层数：{state.enemy.field_pet.statuses}")
        self.assertFalse(any(kind == "status_added" and detail.get("status") == "灼烧"
                             for kind, detail in events),
                         "火系目标上不许有 status_added{灼烧}")
        print(f"\n[实际] 火神免疫：events={kinds}；statuses={state.enemy.field_pet.statuses}")

    def test_burn_on_non_fire_target_still_applies(self):
        """反向对照：非火系目标必须真的挂上 10 层灼烧（否则「免疫」可能是「一律不挂」的假绿）。"""
        state = _open([GRASS] + FILLERS)
        self.assertEqual(state.enemy.field_pet.pet_id, GRASS)
        state, events = _play_burn(state)
        added = [detail for kind, detail in events
                 if kind == "status_added" and detail.get("status") == "灼烧"]
        self.assertTrue(added, "非火系目标必须有 status_added{灼烧}")
        self.assertEqual(added[0].get("layers"), 10, "「引燃」写的是敌方获得 10 层灼烧")
        layers = (state.enemy.field_pet.statuses.get("灼烧") or {}).get("layers")
        # 回合末会按本地规则衰减（10 → 5），所以这里只要求「写进去了、>0」；
        # 精确的施加层数用事件 detail 钉。
        self.assertTrue(layers and layers > 0, f"喵喵身上必须有灼烧层数，实际 {state.enemy.field_pet.statuses}")
        self.assertNotIn("status_immune", [kind for kind, _ in events])
        print(f"\n[实际] 非火系对照：status_added layers={added[0].get('layers')}，回合末后={layers}")

    def test_removing_immunity_makes_the_fire_case_red(self):
        """必红反证：把 `_status_immune` 打掉 ⇒ 火系目标会被挂上灼烧 ⇒ 判据 B 必红。"""
        with mock.patch.object(renv, "_status_immune", lambda rs, pet, spec: None):
            state = _open([FIRE] + FILLERS)
            state, events = _play_burn(state)
        added = [detail for kind, detail in events
                 if kind == "status_added" and detail.get("status") == "灼烧"]
        self.assertTrue(added, "打掉免疫之后，火神应当被挂上灼烧（否则这条反证没有牙）")
        self.assertEqual(added[0].get("layers"), 10)
        layers = (state.enemy.field_pet.statuses.get("灼烧") or {}).get("layers")
        self.assertTrue(layers and layers > 0, "打掉免疫后火神身上应有灼烧层数")
        self.assertNotIn("status_immune", [kind for kind, _ in events])
        print(f"\n[实际] 反证：打掉 _status_immune 后火神 status_added layers={added[0].get('layers')}、"
              f"回合末后={layers} ⇒ 判据 B（要求免疫）必红")


class ServiceTypeMultiplierReadTest(unittest.TestCase):
    """服务层读口（`query_rules kind=type_multiplier`）必须与引擎结算同一个数。

    2026-10-17：这里曾是**第四份独立算术**（服务层自己把两条单属性相乘，双弱 4×），
    与 TypeChart/客户端/RAG 都不一致——真实模型链路里模型答 3、回执给 4，被守卫整条打回。
    """

    def test_read_returns_snapshot_tier_three(self):
        from roco_env.service import RocoService
        svc = RocoService()
        cases = [
            ("电系", ["翼系", "水系"]),   # 官方 Bad Case 1：电系打翠顶夫人 = 3
            ("火系", ["虫系", "草系"]),   # 官方 Bad Case 2：花衣蝶被火神三倍克制
            ("地系", ["火系", "冰系"]),   # 旧裁决点名的 2×2 例子：快照也是 3
        ]
        for attack, defenders in cases:
            answer = svc._answer_type_multiplier(RS, {"attack_element": attack, "defender_types": defenders})
            mult = (answer.result or {}).get("multiplier")
            self.assertEqual(mult, 3.0, f"{attack} 打 {'|'.join(defenders)} 的服务读口不是 3×：{answer.result}")
            self.assertEqual((answer.result or {}).get("combination_rule"), "snapshot_row",
                             "读口必须声明与快照/引擎同源（不再是服务层自己相乘）")
            self.assertNotEqual(mult, 4.0, "旧的「双弱 ×4」不许再出现在读口")

    def test_read_missing_combination_fails_closed(self):
        from roco_env.service import RocoService
        svc = RocoService()
        singles = [key[0] for key in RS.type_chart.rows if len(key) == 1]
        missing = None
        for i, a in enumerate(singles):
            for b in singles[i + 1:]:
                if not RS.type_chart.has_row((a, b)):
                    missing = (a, b)
                    break
            if missing:
                break
        self.assertIsNotNone(missing, "测试前提：快照必须有缺行组合（18 选 2 共 153，快照只给 86）")
        answer = svc._answer_type_multiplier(RS, {"attack_element": "电系", "defender_types": list(missing)})
        self.assertIsNone(answer.result, f"缺行组合必须 fail closed，不许猜：{answer.result}")
        self.assertTrue(str(answer.error_type).startswith("unsupported"), f"缺行要报 unsupported：{answer.error_type}")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
