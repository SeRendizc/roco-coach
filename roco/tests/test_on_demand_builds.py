"""RC-402：按需配招让全量图鉴精灵**真的能上场**。

这一组钉四件事，每条都有必红方向：

  ① **等级不许混**：冻结层那 48 只是 `FULL_VERIFIED` 且配招与冻结那一份逐位相同；
     按需推算的 574 只是 `SIMULATABLE_UNVERIFIED`。同一只不许同时属于两档。
  ② **能上场且能打完**：拿六只**冻结学招表里没有**的图鉴精灵开局，打完整局并分出胜负
     （不是「能构造出来」就算数——那正是 RC-203 当初的缺口）。
  ③ **配招可核对**：每只的四个技能都在它自己的可学池里，且都能在冻结 `skills.json` 里解析。
  ④ **聚能不是换人**（本轮实测踩到的坑）：标准 PVP 里能量付不起技能时，
     对手策略必须**聚能**而不是无限换人——否则 200 回合无人力竭、魔力一直 4/4。
     legacy（没有聚能这个动作类）的行为必须**逐位不变**。
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import opponents as ropp      # noqa: E402
from roco_env import rule_config as rc      # noqa: E402
from roco_env.data import (                 # noqa: E402
    SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED,
)

RS = rdata.load_ruleset()
ropp.bind_ruleset(RS)
V3 = rc.MANA_ACTIONS_CANDIDATE_ID
LEGACY = rc.DEFAULT_RULE_CONFIG_ID

#: 六只**不在冻结 learnset 里**的图鉴精灵（RC-203 那批跳过的物种）。
CATALOG_SIX = ["pet_000001", "pet_000002", "pet_000003", "pet_000004", "pet_000005", "pet_000006"]

#: 标准 PVP 需要的两条未核验覆盖（与服务端 `STANDARD_PVP_UNVERIFIED_OVERRIDES` 同一口径）。
OVERRIDES = [
    {"path": "energy.initial", "value": 2, "confidence": "ENGINE_HYPOTHESIS",
     "reason": "练习局口径（MC-E04 未录制），不是实机结论", "microcase_id": "MC-E04"},
    {"path": "turn_order.speed_tie", "value": "random_seeded", "confidence": "ENGINE_HYPOTHESIS",
     "reason": "同速裁决未核验（MC-E05 未录制），按已登记的工程权宜走", "microcase_id": "MC-E05"},
]

#: RC-106 的两支队（速度两两不同，原本用来避开同速平手）。
TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬"]
TEAM_B = ["秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫"]


class SupportLevelsTest(unittest.TestCase):
    def test_pool_is_split_and_nothing_is_in_both_buckets(self):
        supports = {pid: RS.build_support_of(pid) for pid in RS.pets}
        full = {pid for pid, level in supports.items() if level == SUPPORT_FULL_VERIFIED}
        on_demand = {pid for pid, level in supports.items() if level == SUPPORT_SIMULATABLE_UNVERIFIED}
        self.assertEqual(len(full), 48)
        self.assertEqual(len(on_demand), 574)
        self.assertEqual(full & on_demand, set())
        self.assertEqual(full | on_demand, set(RS.pets))

    def test_frozen_species_keep_the_frozen_matrix_moveset(self):
        """冻结覆盖的每一只，配招必须仍是**冻结 support-matrix** 的那一份。

        注意别拿 `owned-pets.json` 的 `ordered_skills` 当期望值：那是 RC-203 的另一种投影，
        与引擎的规范配招（来自 support-matrix）本来就可能不同。这条判据去读引擎真正的来源：
        基线 `support-matrix.json` + 叠加层 `layer-playable-48/support-matrix.json`。
        """
        import json
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                            "data", "roco", "normalized", "roco-world-s4-2026-09-10")
        frozen = {}
        for path in (os.path.join(base, "support-matrix.json"),
                     os.path.join(base, "layer-playable-48", "support-matrix.json")):
            if not os.path.exists(path):
                continue
            with open(path, "r", encoding="utf-8") as fh:
                for entry in json.load(fh).get("pets", []):
                    ids = tuple(s["skill_id"] for s in ((entry.get("candidate_moveset") or {}).get("skills") or [])
                                if s.get("skill_id"))
                    if ids:
                        frozen[entry["pet_id"]] = ids
        checked = 0
        for pid in RS.pets:
            if RS.build_support_of(pid) != SUPPORT_FULL_VERIFIED:
                continue
            self.assertIn(pid, frozen, f"{pid} 标成已核验，但冻结 support-matrix 里没有它")
            self.assertEqual(tuple(RS.candidate_moveset(pid)), frozen[pid],
                             f"{pid} 的配招被改过（冻结那一份不许动）")
            checked += 1
        self.assertEqual(checked, 48, "已核验那一档必须正好 48 只")

    def test_on_demand_species_get_the_compiled_build(self):
        """按需推算的每一只，配招必须**正是** RC-402 产物里编出来的那四个。"""
        import json
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                            "data", "roco", "derived", "on-demand-builds.json")
        with open(path, "r", encoding="utf-8") as fh:
            builds = json.load(fh)["builds"]
        checked = 0
        for pid in RS.pets:
            if RS.build_support_of(pid) != SUPPORT_SIMULATABLE_UNVERIFIED:
                continue
            want = tuple(row["skill_id"] for row in builds[pid]["skills"])
            self.assertEqual(tuple(RS.candidate_moveset(pid)), want, f"{pid} 的配招与产物不一致")
            # 可学池比**集合**：引擎的 `Learnset.all_skill_ids` 是排序去重后的视图，
            # 而产物保留的是图鉴里的原始顺序——顺序不同不代表内容不同。
            self.assertEqual(set(RS.learnsets[pid].all_skill_ids),
                             set(builds[pid]["learnable_pool"]), f"{pid} 的可学池与产物不一致")
            checked += 1
        self.assertEqual(checked, 574)

    def test_on_demand_moves_are_inside_the_learnable_pool_and_resolvable(self):
        catalog_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                    "data", "roco", "normalized", "roco-world-s4-2026-09-10",
                                    "full-catalog.json")
        import json
        with open(catalog_path, "r", encoding="utf-8") as fh:
            pets = {row["pet_id"]: row for row in json.load(fh)["pets"]}
        checked = 0
        for pid, level in ((p, RS.build_support_of(p)) for p in RS.pets):
            if level != SUPPORT_SIMULATABLE_UNVERIFIED:
                continue
            pool = set(pets[pid]["learnable_skills"])
            moves = RS.candidate_moveset(pid)
            self.assertEqual(len(moves), 4, f"{pid} 必须有四个技能")
            for sid in moves:
                self.assertIn(sid, pool, f"{pid} 学不到 {sid}")
                self.assertTrue(RS.is_learnable(pid, sid))
                self.assertIn(sid, RS.skills)
                checked += 1
        self.assertEqual(checked, 574 * 4)


class OnDemandBattleTest(unittest.TestCase):
    def test_six_catalog_species_can_open_a_standard_battle(self):
        """以前上不了场的六只，现在能开局（这条在 RC-402 之前会抛「未知精灵」）。"""
        state = renv.reset(CATALOG_SIX, CATALOG_SIX, seed=11, rs=RS, config=V3,
                           unverified_overrides=OVERRIDES)
        self.assertEqual(len(state.player.pets), 6)
        self.assertEqual(state.player.mana, 4)
        self.assertTrue(all(p.pet_id in RS.pets for p in state.player.pets))

    def test_six_catalog_species_play_to_a_finish(self):
        """**跑完一局**：不是「构造得出来」，而是真的打到魔力归零。"""
        record = ropp.play_match(RS, CATALOG_SIX, CATALOG_SIX, "greedy_damage", "greedy_damage",
                                 seed=11, config=V3, unverified_overrides=OVERRIDES)
        self.assertFalse(record.truncated, "撞上回合上限：局面停滞了")
        state = renv.replay(record.replay_plan(), RS)
        self.assertIn(state.result, ("win", "loss", "draw"))
        self.assertEqual(min(state.player.mana, state.enemy.mana), 0, "判负依据必须是魔力归零")

    def test_charge_is_not_treated_as_a_switch(self):
        """聚能必须有自己的分支：付不起技能时要聚能，而不是无限换人。

        反证方向：把聚能重新归到「换人」那一类（本轮修之前的样子）之后，
        同样的两支队会跑到回合上限（`truncated=True`）——下面用真实对局钉住这件事。
        """
        for label, (team_a, team_b) in (
            ("图鉴队", (CATALOG_SIX, CATALOG_SIX)),
            ("RC-106 队", ([RS.pets_by_name(n)[0].pet_id for n in TEAM_A],
                           [RS.pets_by_name(n)[0].pet_id for n in TEAM_B])),
        ):
            record = ropp.play_match(RS, team_a, team_b, "greedy_damage", "greedy_damage",
                                     seed=11, config=V3, unverified_overrides=OVERRIDES)
            self.assertFalse(record.truncated, f"{label} 停滞了（聚能又被当成换人了？）")
            state = renv.replay(record.replay_plan(), RS)
            self.assertIn(state.result, ("win", "loss", "draw"), label)
            self.assertEqual(min(state.player.mana, state.enemy.mana), 0, label)

    def test_legacy_has_no_charge_so_behavior_is_unchanged(self):
        """legacy 没声明聚能 ⇒ 合法动作里没有它，策略里那条分支根本走不到。"""
        state = renv.reset(["pet_000225", "pet_000190", "pet_000445"],
                           ["pet_000225", "pet_000190", "pet_000445"], seed=1000, rs=RS,
                           config=LEGACY)
        kinds = {a.kind for a in renv.legal_actions(state, RS, "player")}
        self.assertNotIn("charge", kinds, "legacy 不该凭空多出聚能")
