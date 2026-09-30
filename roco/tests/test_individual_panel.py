"""Q8（要求④「同一规则同一投影」）**引擎那一半**的判据：2026-09-29。

人类逐字：「**同一个体**列表详情 / 培养刷新 / **战斗实际 stats** / 小芽工具 / 推荐 读同一规则
同一投影」，并且「**必须把选中的 instanceID 和培养快照连入规则投影**，实例重复物种时
**不能只靠 speciesID 推断来源**」。

三条判据，每条都有必红方向：

  1. **跨语言逐值相同**：`roco/tests/data/individual-panel-vectors.json` 是用**前端**
     `panelOfIndividual()` 现算出来的 66 条向量（6 物种 × 11 性格/资质组合）；
     Python 侧 `panel_from_snapshot()` 必须与它**逐值相同** —— 这是"两侧同一份投影"的机器判据。
  2. **战斗真的用上了它**：带 `individuals` 开局 ⇒ 私有状态与 UI 视图里的六维 == 向量那一份，
     且 `hp == 面板生命`；不带 ⇒ 走种族值路径，且**两种情况能分辨**（`stats_source`）。
  3. **反证**：同一物种**两只不同个体**（不同性格/资质）⇒ 战斗六维**必须不同**
     （若相同 ⇒ 说明还在按物种算）；形状不对 ⇒ **说清哪里不对**（400，不是静默忽略）。
  4. **伤害也读同一份投影**（2026-09-30 补，人类逐字：「肯定要按照最终结算出来应该怎么样就
     怎么样啊，**不能偷懒**」）：`effects.compute_damage` 过去只读 `panel_stats(species.stats)`
     ⇒「面板上写着物攻 125，打出来的却按 132.6 算」。现在两边逐值相同，且**没有快照的
     路径（legacy / v2）逐位不变**（见 `DamageUsesTheSameIndividualPanelTest`）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_individual_panel -v
"""

from __future__ import annotations

import json
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata            # noqa: E402
from roco_env import effects as fx            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import individuals as ind       # noqa: E402
from roco_env import rule_config as RC        # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

RS = rdata.load_ruleset()
CFG = RC.get_rule_config("mobile_s4_candidate_v3")
VECTORS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "data", "individual-panel-vectors.json")
TEAM = ["pet_000001", "pet_000002", "pet_000040", "pet_000083", "pet_000086", "pet_000127"]
FOES = ["pet_000550", "pet_000225", "pet_000190", "pet_000445", "pet_000417", "pet_000124"]
#: 先手判据用的对手：首发**寂灭骨龙**（物种面板速度 161.476），正好落在
#: 「稳重个体 275」与「保守个体 96」之间 ⇒ 两只个体的先手会翻面（反证 A 的构造）。
FOES_SLOW_LEAD = ["pet_000225"] + [f for f in FOES if f != "pet_000225"]
#: v3 的 `turn_order.speed_tie` 是 UNKNOWN（MC-E05 未录制）⇒ 真跑回合要显式带覆盖
#: （与产品那一跳同一份，见 `src/server/roco-service.js` 的 STANDARD_PVP_UNVERIFIED_OVERRIDES）。
OVR = [{"path": "turn_order.speed_tie", "value": "random_seeded",
        "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用（MC-E05 未录制）",
        "microcase_id": "MC-E05"}]

#: 喵喵的两个个体（性格/资质不同）—— 反证用
SNAPSHOT_A = {"individual_id": "own-0001", "species_id": "pet_000001", "level": 60,
              "nature": "稳重", "talent": {"hp": 7, "spa": 10, "spe": 9, "atk": 0, "spd": 0, "def": 0}}
SNAPSHOT_B = {"individual_id": "own-0001", "species_id": "pet_000001", "level": 60,
              "nature": "保守", "talent": {"hp": 0, "spa": 10, "spe": 0, "atk": 0, "spd": 0, "def": 0}}
#: 水蓝蓝（`pet_000002`）的真实个体 —— 它的规范配招里有**魔攻**技能（甩水），
#: 用来钉「魔攻取个体面板的 spa/spd」这一半。数值取自
#: `GET /api/roco/box?detail=own-0002` 的 `.dev.growth`（性格 稳重 / 天分 速度 7）。
SNAPSHOT_WATER = {"individual_id": "own-0002", "species_id": "pet_000002", "level": 60,
                  "nature": "稳重", "talent": {"hp": 0, "spa": 0, "spe": 7, "atk": 0, "spd": 0, "def": 0}}


def _vectors() -> dict:
    with open(VECTORS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


class CrossLanguageProjectionTest(unittest.TestCase):
    """① 前端算的六维与引擎算的六维**逐值相同**（向量文件是判据，不是抄来的期望值）。"""

    def test_vectors_were_generated_by_the_frontend_projection(self):
        payload = _vectors()
        self.assertEqual(payload["schema"], "roco-individual-panel-vectors/v1")
        self.assertEqual(payload["projection"], ind.PROJECTION_VERSION,
                         "引擎这一份投影的版本号必须与向量文件一致")
        self.assertEqual(len(payload["vectors"]), 66)
        self.assertIn("panelOfIndividual", payload["generated_by"])

    def test_every_vector_matches_the_python_projection(self):
        bad = []
        for row in _vectors()["vectors"]:
            got = ind.panel_from_snapshot(row["race"], {"talent": row["talent"],
                                                        "nature": row["nature"]})["panel"]
            if got != row["panel"]:
                bad.append({"species": row["species_id"], "nature": row["nature"],
                            "前端": row["panel"], "引擎": got})
        self.assertEqual(bad, [], f"两侧投影不一致（{len(bad)} 条）：{bad[:3]}")

    def test_breakthrough_default_is_zero_like_the_box(self):
        """盒子那条路径（`panelOfIndividual`）按**零突破下界**算 —— 别"顺手修正"成满突破。

        2026-09-29 实测：寂灭骨龙 + 开朗 + 速度资质 10 ⇒ 按 0 是 **351**、按满突破 5 是 379。
        前端 `panelOf` 的 `breakthrough` 缺省是 `null` ⇒ 351。两侧要相同就只能照它的来。
        """
        race = {k: int(v) for k, v in RS.pet("pet_000225").stats.items()}
        talent = {"hp": 5, "atk": 8, "def": 2, "spa": 0, "spd": 4, "spe": 10}
        default = ind.panel_from_snapshot(race, {"talent": talent, "nature": "开朗"})["panel"]
        full = ind.panel_from_snapshot(race, {"talent": talent, "nature": "开朗"},
                                       breakthrough=5)["panel"]
        self.assertEqual(default["spe"], 351, f"零突破下界应当给 351，实际 {default['spe']}")
        self.assertEqual(full["spe"], 379, f"满突破应当给 379，实际 {full['spe']}")
        self.assertNotEqual(default["spe"], full["spe"], "两档必须能区分，否则这条判据是空的")


class BattleUsesTheSnapshotTest(unittest.TestCase):
    """② 战斗里真的用上了个体快照（Q8 的正例）。"""

    def _state(self, individuals=None):
        return renv.reset(TEAM, FOES, seed=7, rs=RS, config=CFG, individuals=individuals)

    def test_snapshot_pet_reports_the_same_panel_as_the_vector(self):
        state = self._state({"own-0001": SNAPSHOT_A})
        pet = state.player.pets[0]
        self.assertEqual(pet.pet_id, "pet_000001")
        self.assertEqual(pet.individual_source, "individual-snapshot")
        self.assertEqual(pet.individual_id, "own-0001")
        self.assertEqual(pet.individual_level, 60)
        self.assertEqual(pet.panel_projection, ind.PROJECTION_VERSION)
        expected = ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"]
        self.assertEqual(pet.panel, expected)
        self.assertEqual(pet.hp, expected["hp"], "开局血量必须等于面板生命")
        self.assertEqual(pet.max_hp, expected["hp"])

    def test_ui_view_exposes_the_panel_and_marks_the_source(self):
        state = self._state({"own-0001": SNAPSHOT_A})
        ui = renv.ui_public_view(state, RS, "player")
        by_id = {p["pet_id"]: p for p in ui["self"]["pets"]}
        with_snapshot = by_id["pet_000001"]
        self.assertEqual(with_snapshot["stats"], state.player.pets[0].panel)
        self.assertEqual(with_snapshot["stats_source"], "individual-snapshot")
        self.assertEqual(with_snapshot["individual_id"], "own-0001")
        self.assertEqual(with_snapshot["individual_level"], 60,
                         "等级来源要能看出来（产品那一跳照白名单转发这个键）")
        self.assertEqual(with_snapshot["panel_projection"], ind.PROJECTION_VERSION)
        # 没有快照的那一只 —— **2026-09-30 改钉（task-23，Lead 裁决）**。
        # 旧断言留档（不删）：
        #   ```
        #   # 没有快照的那一只：仍旧是规则集里的种族值，并且**标出来**
        #   self.assertEqual(without["stats"], dict(RS.pet("pet_000002").stats))
        #   self.assertEqual(without["stats_source"], "species-race")
        #   ```
        # 依据（两条逐字）：人类「**肯定要按照最终结算出来应该怎么样就怎么样啊，不能偷懒**」＋
        # Lead 裁决「**玩家看得见的那一栏，显示的必须是"这一局真在用的那个数"**」——
        # 这一局走**面板口径**（own-0001 带快照），所以没快照的这一只展示的也是**物种面板**
        # （它在结算里真用的那一份：生命 / 伤害 / 先手都按它算），并如实标 `species-panel`。
        # **整局没有快照** ⇒ 逐字仍是种族值（见本类最后那两行反证）。
        without = by_id["pet_000002"]
        self.assertEqual(without["stats"], rdata.panel_stats(RS.pet("pet_000002").stats))
        self.assertEqual(without["stats_source"], "species-panel")
        self.assertEqual(without["panel_projection"], ind.PROJECTION_VERSION)
        self.assertNotIn("individual_id", without)
        # 反证（同一条判据的另一半）：**整局没有快照** ⇒ 回执逐字不变（仍是种族值）
        plain = renv.ui_public_view(renv.reset(TEAM, FOES, seed=7, rs=RS, config=CFG), RS, "player")
        plain_by_id = {p["pet_id"]: p for p in plain["self"]["pets"]}
        self.assertEqual(plain_by_id["pet_000002"]["stats"], dict(RS.pet("pet_000002").stats))
        self.assertEqual(plain_by_id["pet_000002"]["stats_source"], "species-race")
        self.assertNotIn("panel_projection", plain_by_id["pet_000002"])

    def test_two_individuals_of_the_same_species_differ(self):
        """反证：同物种两只不同个体 ⇒ 战斗六维必须不同（否则就是还在按物种算）。"""
        a = self._state({"own-0001": SNAPSHOT_A}).player.pets[0]
        b = self._state({"own-0001": SNAPSHOT_B}).player.pets[0]
        self.assertEqual(a.pet_id, b.pet_id)
        self.assertNotEqual(a.panel, b.panel, "同物种不同个体的面板不该一样")
        self.assertNotEqual(a.max_hp, b.max_hp)
        self.assertEqual(a.max_hp, 495)
        self.assertEqual(b.max_hp, 281)

    def test_snapshot_level_is_recorded_but_pvp_still_normalises_to_60(self):
        """快照的等级记在回执里；面板按 PVP 档 60 算（与列表/详情同一条口径）。"""
        snapshot = dict(SNAPSHOT_A, level=55)
        pet = self._state({"own-0001": snapshot}).player.pets[0]
        self.assertEqual(pet.individual_level, 55, "快照说 55 就要如实记 55")
        self.assertEqual(pet.level, 55)
        expected = ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"]
        self.assertEqual(pet.panel, expected, "面板仍旧按 PVP 归一化的 60 算（与列表/详情一致）")

    def test_pet_to_dict_carries_the_snapshot_markers(self):
        pet = self._state({"own-0001": SNAPSHOT_A}).player.pets[0]
        row = pet.to_dict()
        self.assertEqual(row["individual_source"], "individual-snapshot")
        self.assertEqual(row["individual_id"], "own-0001")
        self.assertEqual(row["panel_projection"], ind.PROJECTION_VERSION)
        self.assertEqual(row["panel"], pet.panel)
        # 往返之后仍然认得出来
        again = type(pet).from_dict(row)
        self.assertEqual(again.panel, pet.panel)
        self.assertEqual(again.individual_id, "own-0001")


class RealProductSnapshotShapeTest(unittest.TestCase):
    """引擎必须吃下**产品真实发下来的整条快照**（多余键忽略、不报错、六维照算）。

    样例取自 `individualFromInstance()` 的现算结果（存在向量文件的 `product_snapshot_sample`）。
    为什么单独一条：产品那一跳**不会替引擎裁剪** —— 它把整条（含 `level_source` /
    `nature_source` / `talent_source` / `refreshes` / `history` 这些引擎用不上的键）发下来，
    引擎只要在**它要用的那几个键**上较真，别的一律忽略。
    """

    def _sample(self):
        return dict(_vectors()["product_snapshot_sample"]["sample"])

    def test_full_snapshot_is_accepted_and_projects_the_same_panel(self):
        sample = self._sample()
        self.assertEqual(sample["species_id"], "pet_000001")
        # 形状校验：整条不许有任何问题
        _, problems = ind.resolve_snapshots({sample["individual_id"]: sample}, list(TEAM))
        self.assertEqual(problems, [], f"产品真实形状不该被拒：{problems}")
        # 开局 + 六维与"只给必要键"的那一份**逐值相同**
        state = renv.reset(TEAM, FOES, seed=7, rs=RS, config=CFG,
                           individuals={sample["individual_id"]: sample})
        pet = state.player.pets[0]
        minimal = {"talent": sample["talent"], "nature": sample["nature"]}
        expected = ind.panel_from_snapshot(RS.pet("pet_000001").stats, minimal)["panel"]
        self.assertEqual(pet.panel, expected)
        self.assertEqual(pet.individual_id, "own-0001")
        self.assertEqual(pet.individual_level, 60)


class NoSnapshotIsUnchangedTest(unittest.TestCase):
    """不带快照的调用方（legacy / v2 / 旧接口）**逐位不变**。"""

    def test_without_snapshot_nothing_new_appears(self):
        state = renv.reset(TEAM, FOES, seed=7, rs=RS, config=CFG)
        row = state.player.pets[0].to_dict()
        for key in ("panel", "individual_source", "individual_id", "individual_level",
                    "panel_projection"):
            self.assertNotIn(key, row, f"没有快照时不该出现 {key}（序列化要逐位不变）")
        self.assertEqual(state.player.pets[0].panel, {})

    def test_level_not_one_still_fails_closed_without_a_snapshot(self):
        with self.assertRaises(fx.UnsupportedEffect):
            renv._make_pet(RS, "pet_000001", 0, 2)


class PlanProtocolCarriesTheIndividualPanelTest(unittest.TestCase):
    """⑤（2026-09-30）**规划/预告那一跳也读同一个体投影**（人类逐字：「不能偷懒」）。

    为什么单独一组：`/battle/plan` 的伤害预告与规划搜索都跑在
    `state_from_public_planner()` **重建**出来的状态上 —— 公开面不带 `panel`，
    重建出来就是空 ⇒ 预告按**种族值**算、真结算按**个体面板**算（预告一个数、打出来另一个数）。

    三条判据，每条都有必红方向：
      ① **带快照**：公开面里己方那只带 `panel`/来源/实例 id/投影版本，重建之后面板**逐值还在**，
         且 `compute_damage` 真的用它（`attacker_atk == panel[atk]`）；
      ② **无快照**：那四个键**一个都不出现**，重建后 `panel == {}`，伤害逐字等于种族值路径；
      ③ **合并预览**：多分析种子的合并结果要**带着**面板来源（不在这里带出来 = 没做）。
    """

    def _public(self, individuals=None, cfg=CFG, team=None, foes=None):
        state = renv.reset(team or TEAM, foes or FOES, seed=7, rs=RS, config=cfg,
                           individuals=individuals)
        return state, renv.public_planner_state(state, RS, "player")

    def test_public_state_carries_the_panel_and_reconstruction_keeps_it(self):
        state, public = self._public({"own-0001": SNAPSHOT_A})
        detail = ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"]
        row = public["self"]["pets"][0]
        self.assertEqual(row["panel"], detail, "协议里那份面板必须与列表/详情逐值相同")
        self.assertEqual(row["individual_source"], "individual-snapshot")
        self.assertEqual(row["individual_id"], "own-0001")
        self.assertEqual(row["panel_projection"], ind.PROJECTION_VERSION)
        # 重建（规划器与伤害预告读的就是这个状态）
        rebuilt = renv.state_from_public_planner(public, RS, analysis_seed=11)
        pet = rebuilt.player.field_pet
        self.assertEqual(pet.panel, detail, "重建之后面板必须还在（否则预告会退回种族值）")
        self.assertEqual(pet.individual_id, "own-0001")
        out = fx.compute_damage(pet, rebuilt.enemy.field_pet, RS.skills["skill_000246"], RS, cfg=CFG)
        self.assertEqual(out.attacker_atk, float(detail["atk"]),
                         "预告/搜索里的伤害用的必须是个体面板，不是种族值")
        self.assertEqual(out.panel_provenance["attacker"]["stats_source"], fx.PANEL_SOURCE_INDIVIDUAL)

    def test_without_a_snapshot_the_protocol_has_no_new_keys(self):
        """② 反证：没有快照 ⇒ 协议里四个键一个都没有，重建后逐字走种族值路径。"""
        _state, public = self._public()
        row = public["self"]["pets"][0]
        for key in ("panel", "individual_source", "individual_id", "panel_projection",
                    "individual_level"):
            self.assertNotIn(key, row, f"没有快照时协议里不该出现 {key}")
        rebuilt = renv.state_from_public_planner(public, RS, analysis_seed=11)
        pet = rebuilt.player.field_pet
        self.assertEqual(pet.panel, {})
        self.assertEqual(pet.individual_source, "")
        out = fx.compute_damage(pet, rebuilt.enemy.field_pet, RS.skills["skill_000246"], RS, cfg=CFG)
        self.assertEqual(out.attacker_atk,
                         rdata.panel_stats(RS.pet("pet_000001").stats)["atk"],
                         "没有快照 ⇒ 逐字仍是种族值路径")
        self.assertFalse(out.individual_panel_used())

    def test_merged_preview_keeps_the_panel_source(self):
        """③ 合并预览（多分析种子）必须**带着**面板来源 —— 不合并带出来就等于没做。"""
        from roco_env import service as svc

        detail = ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"]
        sample = {"label": "抓挠", "damage": 24, "multiplier": 1.0, "multiplier_element": "普通系",
                  "multiplier_defender_types": None,
                  "attacker_atk": float(detail["atk"]), "defender_def": 163.4,
                  "individual_panel": {"attacker": {"stats_source": "individual-snapshot",
                                                    "individual_id": "own-0001",
                                                    "projection": ind.PROJECTION_VERSION,
                                                    "panel": detail},
                                       "defender": {"stats_source": "species-race"}}}
        merged = svc.RocoService._merge_previews([
            {"available": True, "min": 24, "max": 24, "best_label": "抓挠", "lethal": False,
             "foe_hp": 419, "skipped_skills": [], "candidates": 1, "formula_verified": False,
             "damage_model": "community-hypothesis-v1", "samples": [sample]},
            {"available": True, "min": 24, "max": 24, "best_label": "抓挠", "lethal": False,
             "foe_hp": 419, "skipped_skills": [], "candidates": 1, "formula_verified": False,
             "damage_model": "community-hypothesis-v1", "samples": [dict(sample)]}])
        got = merged["samples"][0]
        self.assertEqual(got["attacker_atk"], float(detail["atk"]))
        self.assertEqual(got["individual_panel"]["attacker"]["panel"], detail)
        # 没有快照的样本：不许凭空长出新键（老路径的合并结果逐位不变）
        plain = {"label": "抓挠", "damage": 25, "multiplier": 1.0, "multiplier_element": "普通系",
                 "multiplier_defender_types": None}
        merged2 = svc.RocoService._merge_previews([
            {"available": True, "min": 25, "max": 25, "best_label": "抓挠", "lethal": False,
             "foe_hp": 419, "skipped_skills": [], "candidates": 1, "formula_verified": False,
             "damage_model": "community-hypothesis-v1", "samples": [plain]}])
        for key in ("attacker_atk", "defender_def", "individual_panel"):
            self.assertNotIn(key, merged2["samples"][0],
                             f"没有快照的合并样本不该出现 {key}（老路径逐位不变）")


class SnapshotShapeProblemsTest(unittest.TestCase):
    """③ 形状不对**说清哪里不对**（不静默忽略）。"""

    def test_each_bad_shape_is_named(self):
        cases = {
            "individuals 不是对象": (["x"], "必须是"),
            "species_id 缺失": ({"own-1": {"nature": "保守"}}, "species_id"),
            "nature 类型错": ({"own-1": {"species_id": "pet_000001", "nature": 7}}, "nature"),
            "talent 超范围": ({"own-1": {"species_id": "pet_000001", "talent": {"spe": 99}}}, "talent.spe"),
            "talent 陌生键": ({"own-1": {"species_id": "pet_000001", "talent": {"luck": 1}}}, "luck"),
            "level 越界": ({"own-1": {"species_id": "pet_000001", "level": 61}}, "level"),
        }
        for label, (raw, needle) in cases.items():
            _, problems = ind.resolve_snapshots(raw, list(TEAM))
            joined = "；".join(problems)
            self.assertTrue(problems, f"{label} 应当被拒")
            self.assertIn(needle, joined, f"{label} 的问题描述要点到 {needle}，实际 {joined}")

    def test_instance_that_matches_no_slot_is_reported(self):
        _, problems = ind.resolve_snapshots({"own-9": {"species_id": "pet_000225"}}, list(TEAM))
        self.assertTrue(problems)
        self.assertIn("pet_000225", "；".join(problems))
        self.assertIn("own-9", "；".join(problems))

    def test_reset_raises_and_names_the_field(self):
        with self.assertRaises(ValueError) as ctx:
            renv.reset(TEAM, FOES, seed=7, rs=RS, config=CFG,
                       individuals={"own-1": {"species_id": "pet_000001", "talent": {"spe": 99}}})
        self.assertIn("individuals 不合法", str(ctx.exception))
        self.assertIn("talent.spe", str(ctx.exception))

    def test_two_same_species_snapshots_map_by_order_not_by_species(self):
        """同一物种出现两次时按**插入顺序**配对（人类：「不能只靠 speciesID 推断来源」）。"""
        # 队伍里 pet_000001 只在槽 0；两条快照都指向它 ⇒ 第二条必须被拒（没有第二个位置）
        _, problems = ind.resolve_snapshots(
            {"own-1": {"species_id": "pet_000001"}, "own-2": {"species_id": "pet_000001"}},
            list(TEAM))
        self.assertTrue(problems, "同一个位置被两条快照争用时必须报出来")
        team2 = ["pet_000001", "pet_000001", "pet_000040", "pet_000083", "pet_000086", "pet_000127"]
        out, problems2 = ind.resolve_snapshots(
            {"own-1": {"species_id": "pet_000001", "nature": "稳重"},
             "own-2": {"species_id": "pet_000001", "nature": "保守"}}, team2)
        self.assertEqual(problems2, [])
        self.assertEqual(out[0]["nature"], "稳重", "第一条对槽 0")
        self.assertEqual(out[1]["nature"], "保守", "第二条对槽 1（按插入顺序）")


class DamageUsesTheSameIndividualPanelTest(unittest.TestCase):
    """④（2026-09-30）**伤害公式也读同一个体投影** —— 人类逐字：「不能偷懒」。

    改之前：`effects.compute_damage` 只读 `data.panel_stats(species.stats)`（种族值路径），
    于是同一个体有两套六维 —— 列表/详情给 `atk 125`，伤害却按 `132.6` 算。

    四条判据，每条都有必红方向：
      ① 同一个体：列表/详情 == 战斗面板 == **伤害里用的整份面板**，逐值相同；
      ② **反证 A**：同物种两只不同个体 ⇒ 伤害**必须不同**（相同 ⇒ 没接上）；
      ③ **反证 B**：没有快照（legacy / v2）⇒ 面板与事件**逐位不变**；
      ④ 伤害事件只在**真的用了快照**时多带 `individual_panel` 一把键。
    """

    #: 实测（seed=7、抓挠 `skill_000246` 打 `pet_000550`、无任何 buff）：
    #: 接上个体投影之后，两个个体打出的数**不同**。写死是有意的 ——
    #: 面板、公式、技能任一处变了都该让这条红。
    DAMAGE_A = 24
    DAMAGE_B = 25

    def _state(self, individuals=None, cfg=CFG, team=None, foes=None):
        return renv.reset(team or TEAM, foes or FOES, seed=7, rs=RS, config=cfg,
                          individuals=individuals)

    def _first_attack(self, state):
        pet = state.player.field_pet
        for sid in (state.player.loadouts.get(pet.pet_id) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and skill.is_attack:
                return skill
        self.fail("首发配招里没有攻击技能 —— 这条判据会是空的（先证明被测的事真的跑过）")

    def test_damage_panel_equals_the_list_and_detail_panel(self):
        """① 两边逐值相同：`individual_panel.attacker.panel == panelOfIndividual` 的结果。"""
        state = self._state({"own-0001": SNAPSHOT_A})
        pet = state.player.field_pet
        detail = ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"]
        skill = self._first_attack(state)
        out = fx.compute_damage(pet, state.enemy.field_pet, skill, RS, cfg=CFG)
        prov = out.panel_provenance["attacker"]
        self.assertEqual(prov["stats_source"], fx.PANEL_SOURCE_INDIVIDUAL)
        self.assertEqual(prov["individual_id"], "own-0001")
        self.assertEqual(prov["projection"], ind.PROJECTION_VERSION)
        self.assertEqual(prov["panel"], detail,
                         "伤害里用的整份面板必须与列表/详情**逐值相同**（人类验收①）")
        # 这一手真的取了那一项（抓挠是物攻 ⇒ atk）
        self.assertEqual(out.attacker_atk, float(detail["atk"]))
        # 对手没有快照 ⇒ 防守面仍旧种族值路径，而且**标出来**（两种情况必须能分辨）
        enemy = out.panel_provenance["defender"]
        self.assertEqual(enemy["stats_source"], fx.PANEL_SOURCE_SPECIES)
        self.assertIsNone(enemy["individual_id"])
        self.assertIsNone(enemy["projection"])
        self.assertEqual(out.defender_def,
                         rdata.panel_stats(RS.pet(state.enemy.field_pet.pet_id).stats)["def"])

    def test_magic_attack_takes_spa_from_the_individual_panel(self):
        """①的后半：魔攻技能取个体面板的 `spa`（v3 声明了 `damage.attack_stat_by_class`）。

        用**水蓝蓝的真实个体**（规范配招里就有魔攻技能 甩水），不为用某条招硬换人。
        """
        self.assertTrue(CFG.damage_attack_stat_by_class, "v3 必须声明「按伤害类别取面板」")
        team = ["pet_000002"] + [p for p in TEAM if p != "pet_000002"]
        state = self._state({"own-0002": SNAPSHOT_WATER}, team=team)
        pet = state.player.field_pet
        self.assertEqual(pet.pet_id, "pet_000002")
        skill = RS.skills["skill_000418"]
        self.assertEqual(skill.damage_class, "魔攻")
        detail = ind.panel_from_snapshot(RS.pet("pet_000002").stats, SNAPSHOT_WATER)["panel"]
        species_spa = rdata.panel_stats(RS.pet("pet_000002").stats)["spa"]
        self.assertNotEqual(float(detail["spa"]), species_spa,
                            "这条判据要有区分力：个体面板的 spa 必须与种族值路径不同")
        out = fx.compute_damage(pet, state.enemy.field_pet, skill, RS, cfg=CFG)
        self.assertEqual(out.attacker_atk, float(detail["spa"]), "魔攻要取个体面板的 spa")
        self.assertEqual(out.panel_provenance["attacker"]["panel"], detail)

    def test_two_individuals_of_the_same_species_deal_different_damage(self):
        """② **反证 A**：同物种两只不同个体 ⇒ 伤害必须不同（相同 ⇒ 伤害没接上个体投影）。"""
        a = self._state({"own-0001": SNAPSHOT_A})
        b = self._state({"own-0001": SNAPSHOT_B})
        self.assertEqual(a.player.field_pet.pet_id, b.player.field_pet.pet_id, "前提：同一物种")
        self.assertNotEqual(a.player.field_pet.panel, b.player.field_pet.panel, "前提：不同个体")
        out_a = fx.compute_damage(a.player.field_pet, a.enemy.field_pet,
                                  self._first_attack(a), RS, cfg=CFG)
        out_b = fx.compute_damage(b.player.field_pet, b.enemy.field_pet,
                                  self._first_attack(b), RS, cfg=CFG)
        self.assertEqual((out_a.damage, out_b.damage), (self.DAMAGE_A, self.DAMAGE_B),
                         f"接上个体投影之后这两个个体打出的数不同（A={out_a.damage} B={out_b.damage}）")
        self.assertNotEqual(out_a.damage, out_b.damage,
                            "同物种两只不同个体打出同一个数 ⇒ 伤害还在按物种算")

    def test_without_a_snapshot_the_species_panel_is_used_bit_for_bit(self):
        """③ **反证 B**：没有快照的路径（legacy / v2）**逐位不变**。

        证明方式是**逐值对照**，不是「我保证」：面板等于 `panel_stats(种族值)`、
        来源写着 `species-race`、`to_dict()` 里**不出现**新键。
        """
        cases = (("legacy_sim_v1", TEAM[:3], FOES[:3]), ("mobile_s4_candidate_v2", TEAM, FOES))
        for cfg_id, team, foes in cases:
            with self.subTest(config=cfg_id):
                cfg = RC.get_rule_config(cfg_id)
                state = self._state(cfg=cfg, team=team, foes=foes)
                pet = state.player.field_pet
                self.assertEqual(pet.panel, {}, "没有快照时 PetState.panel 必须是空的")
                skill = self._first_attack(state)
                out = fx.compute_damage(pet, state.enemy.field_pet, skill, RS, cfg=cfg)
                self.assertFalse(out.individual_panel_used())
                self.assertEqual(out.attacker_atk,
                                 rdata.panel_stats(RS.pet(pet.pet_id).stats)["atk"],
                                 "没有快照 ⇒ 攻方必须仍旧读种族值路径（逐位不变）")
                self.assertEqual(out.defender_def,
                                 rdata.panel_stats(RS.pet(state.enemy.field_pet.pet_id).stats)["def"])
                self.assertNotIn("panel_provenance", out.to_dict(),
                                 "没有快照的路径 `to_dict()` 不许长出新键")

    def test_damage_event_only_carries_the_panel_when_a_snapshot_is_used(self):
        """④ 事件里的 `individual_panel` 只在**真的用了快照**时出现（legacy 事件逐位不变）。

        先把被测的事变成**可观测的**：驱动一整回合，要求**真的有**一条我方 `damage` 事件；
        没有事件就红（不许靠「没出现」来假装通过）。
        """
        def play(cfg, team, foes, individuals):
            state = self._state(individuals, cfg=cfg, team=team, foes=foes)
            state.player.field_pet.energy = 10
            skill = self._first_attack(state)
            enemy_action = next(a for a in renv.legal_actions(state, RS, "enemy")
                                if a.kind == ACTION_SKILL)
            after = renv.step_joint(state, RS, Action(ACTION_SKILL, skill_id=skill.skill_id),
                                    enemy_action)
            return [e for e in after.events
                    if e.kind == "damage" and e.detail.get("side") == "player"]

        mine = play(CFG, TEAM, FOES, {"own-0001": SNAPSHOT_A})
        self.assertTrue(mine, "这一回合我方必须真的打出过伤害事件，否则这条判据是空的")
        panel = mine[0].detail["individual_panel"]["attacker"]
        self.assertEqual(panel["stats_source"], "individual-snapshot")
        self.assertEqual(panel["individual_id"], "own-0001")
        self.assertEqual(panel["panel"],
                         ind.panel_from_snapshot(RS.pet("pet_000001").stats, SNAPSHOT_A)["panel"])

        # 老路径：同样的驱动**真的有伤害事件**，但事件里没有这把键
        for cfg_id, team, foes in (("legacy_sim_v1", TEAM[:3], FOES[:3]),
                                   ("mobile_s4_candidate_v2", TEAM, FOES)):
            with self.subTest(config=cfg_id):
                events = play(RC.get_rule_config(cfg_id), team, foes, None)
                self.assertTrue(events, f"{cfg_id} 这一回合必须真的打出过伤害事件")
                for event in events:
                    self.assertNotIn("individual_panel", event.detail,
                                     "没有快照的事件不许出现新键（golden 指纹守得住的前提）")


class OrderUsesTheSameIndividualPanelTest(unittest.TestCase):
    """⑥（2026-09-30，task-23）**先手/速度也读同一个体投影** —— 人类逐字：「不能偷懒」。

    改之前：`order_actions` 读 `rs.pet(pet_id).stats["spe"]`（**种族值**；`PetState` 没有
    `stats` 字段 ⇒ `hasattr` 恒 False ⇒ 走回落）。实测同一个体：列表/详情 **275** ·
    物种面板 116.29 · 先手判定实际用 **33** ✗。

    ⚠ 这一处**不能逐只接**：先手是**两侧比大小**，一侧面板、一侧种族值 = 两套量纲
    （实测 275 vs 130 ⇒ 先手被系统性偏向有快照的一方，而且不报错）。所以口径是**整局**的：
    本局任一只带快照 ⇒ 有快照的用个体面板、没快照的用物种面板；整局没快照 ⇒ 逐字种族值。

    四条判据，每条都有必红方向：
      ① 同一个体：先手判定用的速度 == 列表/详情那份面板的 `spe`，且回执里**写明来源**；
      ② **反证 A**：同物种两只不同个体（速度资质不同）⇒ **先手结果不同**；
      ③ **反证 B**：整局无快照 ⇒ 速度逐字仍是种族值、回执不多键；
      ④ 展示 == 真用：屏幕上给的那一栏就是先手/结算真在用的那个数（三态 `stats_source`）。
    """

    #: 稳重的 own-0001（速度资质 9）与保守的另一只（速度资质 0）—— 两只都在同一物种上。
    SPE_A = 275
    SPE_B = 96
    #: 对手首发寂灭骨龙 `pet_000225` 的**物种面板**速度：正好落在上面两只之间 ⇒ 先手会翻面。
    FOE_SPE = 161.476

    def _state(self, individuals=None, cfg=CFG, team=None, foes=None):
        # ⚠ 只有 v3 的 `speed_tie` 是 UNKNOWN：给 legacy / v2 传覆盖会被引擎当场拒
        # （「覆盖只用于把 UNKNOWN 显式假设掉，不许改一条已登记的值」）。
        overrides = OVR if cfg.ruleset_config_id == CFG.ruleset_config_id else None
        return renv.reset(team or TEAM, foes or FOES_SLOW_LEAD, seed=7, rs=RS, config=cfg,
                          unverified_overrides=overrides, individuals=individuals)

    def _player_action(self, state):
        pet = state.player.field_pet
        for sid in (state.player.loadouts.get(pet.pet_id) or ()):
            skill = RS.skills.get(sid)
            if skill is not None and skill.is_attack:
                return Action(ACTION_SKILL, skill_id=skill.skill_id)
        self.fail("首发配招里没有攻击技能 —— 这条判据会是空的")

    def test_speed_used_by_the_order_is_the_individual_panel(self):
        """① 先手用的速度 == 个体面板的 `spe`；回执里写明两侧各自用的是什么。"""
        state = self._state({"own-0001": SNAPSHOT_A})
        me = state.player.field_pet
        foe = state.enemy.field_pet
        self.assertEqual(me.panel["spe"], self.SPE_A)
        self.assertEqual(renv.order_speed(me, RS, panel_scale=True),
                         (self.SPE_A, renv.SPEED_SOURCE_INDIVIDUAL))
        value, source = renv.order_speed(foe, RS, panel_scale=True)
        self.assertEqual(source, renv.SPEED_SOURCE_SPECIES_PANEL, "对手没有快照 ⇒ 物种面板（同量纲）")
        self.assertEqual(value, rdata.panel_stats(RS.pet(foe.pet_id).stats)["spe"])
        # 真跑一回合：回执里登记的必须是同一对数
        enemy_action = next(a for a in renv.legal_actions(state, RS, "enemy") if a.kind == ACTION_SKILL)
        after = renv.step_joint(state, RS, self._player_action(state), enemy_action)
        start = [e for e in after.events if e.kind == "turn_start"]
        self.assertTrue(start, "这一回合必须有 turn_start 事件")
        prov = start[0].detail.get("speed_provenance")
        self.assertIsNotNone(prov, "面板口径下回执必须登记速度来源（否则没人看得出有没有假接上）")
        self.assertEqual(prov["speeds"]["player"]["value"], self.SPE_A)
        self.assertEqual(prov["speeds"]["player"]["source"], "individual-panel")
        self.assertEqual(prov["speeds"]["player"]["individual_id"], "own-0001")
        self.assertEqual(prov["speeds"]["enemy"]["source"], "species-panel")
        self.assertEqual(prov["speeds"]["enemy"]["value"], self.FOE_SPE)

    def test_two_individuals_of_the_same_species_move_in_different_order(self):
        """② **反证 A**：同物种两只个体 ⇒ 先手结果必须不同（相同 ⇒ 速度没接上个体投影）。

        ⚠ 两侧都出**聚能**：排序键的第一维是「应对成功」、第二维是「先手度」——
        实测用攻击技能时对手那一手是应对招（`respond=True`），它会**压过速度**
        （实测两只个体的先手都变成"敌方"，看着像"没接上"，其实是判据自己没隔离速度这一维）。
        聚能两边 `respond=False`、先手度相同 ⇒ 这一维真的由**速度**说了算。
        """
        rng = random.Random(1)
        charge = Action("charge")
        orders = {}
        for label, snap in (("A", SNAPSHOT_A), ("B", SNAPSHOT_B)):
            state = self._state({"own-0001": snap})
            self.assertTrue(charge in renv.legal_actions(state, RS, "player"))
            self.assertTrue(charge in renv.legal_actions(state, RS, "enemy"))
            order = renv.order_actions(state, RS, charge, charge, rng=rng, cfg=CFG)
            orders[label] = order[0][0]
            self.assertEqual(state.player.field_pet.panel["spe"],
                             self.SPE_A if label == "A" else self.SPE_B)
        self.assertEqual(orders, {"A": "player", "B": "enemy"},
                         f"275 与 96 分居对手 161.5 两侧 ⇒ 先手必须翻面（实际 {orders}）")
        # 这条判据要有区分力：**老读法**（整局种族值）两只都是 33 ⇒ 都是"敌方先手"，看不出差别
        legacy_like = []
        for snap in (SNAPSHOT_A, SNAPSHOT_B):
            state = self._state({"own-0001": snap})
            pet = state.player.field_pet
            legacy_like.append(RS.pet(pet.pet_id).stats["spe"])
        self.assertEqual(legacy_like, [33, 33], "老读法两只同为种族值 33 ⇒ 这条判据正是冲着它来的")
        # **真结算路径**也对得上（不是只看排序函数）：双方都聚能 ⇒ 谁先出手看第一条 charge 事件
        for label, snap, first in (("A", SNAPSHOT_A, "player"), ("B", SNAPSHOT_B, "enemy")):
            with self.subTest(individual=label):
                state = self._state({"own-0001": snap})
                after = renv.step_joint(state, RS, Action("charge"), Action("charge"))
                charges = [e for e in after.events if e.kind == "charge"]
                self.assertTrue(charges, f"个体{label} 这一回合必须有 charge 事件（否则判据是空的）")
                self.assertEqual(charges[0].detail.get("side"), first,
                                 f"个体{label}：真结算里先出手的应当是 {first}")

    def test_without_a_snapshot_the_order_uses_the_race_value_bit_for_bit(self):
        """③ **反证 B**：整局无快照（legacy / v2 / v3 无实例）⇒ 逐字老路径。"""
        cases = (("mobile_s4_candidate_v3", TEAM, FOES_SLOW_LEAD),
                 ("legacy_sim_v1", TEAM[:3], FOES_SLOW_LEAD[:3]),
                 ("mobile_s4_candidate_v2", TEAM, FOES_SLOW_LEAD))
        for cfg_id, team, foes in cases:
            with self.subTest(config=cfg_id):
                cfg = RC.get_rule_config(cfg_id)
                state = self._state(cfg=cfg, team=team, foes=foes)
                self.assertFalse(renv.battle_uses_panel_scale(state), "整局没快照 ⇒ 面板口径关闭")
                me = state.player.field_pet
                self.assertEqual(renv.order_speed(me, RS, panel_scale=False),
                                 (RS.pet(me.pet_id).stats["spe"], "species-race"))
                # 真跑一回合：**回执里不许出现** speed_provenance（全量指纹守得住的前提）
                my_action = self._player_action(state)
                enemy_action = next(a for a in renv.legal_actions(state, RS, "enemy")
                                    if a.kind == ACTION_SKILL)
                after = renv.step_joint(state, RS, my_action, enemy_action)
                starts = [e for e in after.events if e.kind == "turn_start"]
                self.assertTrue(starts, f"{cfg_id} 这一回合必须有 turn_start 事件")
                self.assertNotIn("speed_provenance", starts[0].detail,
                                 "整局无快照时 turn_start 必须逐位不变")

    def test_ui_view_shows_the_speed_actually_used(self):
        """④ 展示 == 真用：面板口径下对手展示的也是物种面板（同一条数，不是两套）。"""
        state = self._state({"own-0001": SNAPSHOT_A})
        ui = renv.ui_public_view(state, RS, "player")
        foe_panel = ui["opponent"]["field"]
        used, source = renv.order_speed(state.enemy.field_pet, RS, panel_scale=True)
        self.assertEqual(foe_panel["stats_source"], "species-panel")
        self.assertEqual(foe_panel["stats"]["spe"], used,
                         "屏幕上写多少、先手就按多少比（不许两套数）")
        self.assertEqual(source, "species-panel")
        # 反证：整局无快照 ⇒ 展示逐字仍是种族值
        plain = renv.ui_public_view(renv.reset(TEAM, FOES_SLOW_LEAD, seed=7, rs=RS, config=CFG),
                                    RS, "player")
        self.assertEqual(plain["opponent"]["field"]["stats_source"], "species-race")
        self.assertEqual(plain["opponent"]["field"]["stats"],
                         dict(RS.pet(plain["opponent"]["field"]["pet_id"]).stats))


    def test_planner_reconstruction_also_uses_the_panel_speed(self):
        """⑤ 规划/预告那一侧（`state_from_public_planner` 重建的状态）也按同一份面板比速度。

        人类口径「不能偷懒」：真结算与预告/规划只能有一套口径 —— 重建状态丢了面板，
        预告就会在种族值量纲上排先手，与打出来的顺序不一致。
        """
        state = self._state({"own-0001": SNAPSHOT_A})
        public = renv.public_planner_state(state, RS, "player")
        rebuilt = renv.state_from_public_planner(public, RS, analysis_seed=11)
        self.assertTrue(renv.battle_uses_panel_scale(rebuilt), "重建之后面板必须还在（task-22 接的那条）")
        self.assertEqual(renv.order_speed(rebuilt.player.field_pet, RS, panel_scale=True),
                         (self.SPE_A, "individual-panel"))
        # 反证：不带 individuals 的公开面重建出来 ⇒ 逐字老路径
        plain_public = renv.public_planner_state(
            renv.reset(TEAM, FOES_SLOW_LEAD, seed=7, rs=RS, config=CFG), RS, "player")
        plain_rebuilt = renv.state_from_public_planner(plain_public, RS, analysis_seed=11)
        self.assertFalse(renv.battle_uses_panel_scale(plain_rebuilt))
        self.assertEqual(renv.order_speed(plain_rebuilt.player.field_pet, RS, panel_scale=False),
                         (RS.pet("pet_000001").stats["spe"], "species-race"))


if __name__ == "__main__":
    unittest.main()
