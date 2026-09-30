"""UI 公开视图与**模型规划协议**的分离（第 42 轮，P0-1）。

用户实测 `/roco.html` 看到 `pet_000225` 而不是「寂灭骨龙」。根因不是渲染，
而是**两条本该分开的协议被当成了一条**：

  · `public_planner_state` 是**交给模型规划用的最小协议**，刻意不含 `name`——
    名字对搜索没有用，只是白烧 token；
  · 页面一直拿它当 UI 状态用，于是屏幕上只能显示 id。

修法是给 UI 一份**并行**视图（`ui_public_view`），而不是给规划协议加字段。
这一组测试钉的就是这条分离——两边都必须成立，缺一条都算改坏：

  1. 规划协议里**不许**出现 `name` / `types`（它为 UI 扩大就失去了「最小」的意义）；
  2. UI 视图里**必须**有真名与系别；
  3. 两个视图描述**同一时刻的同一局**：`state_version` / `turn` / `phase` 必须一致，
     同一只精灵的 `hp`/`max_hp`/`energy` 也必须一致（不一致就是 bug，不是「各有侧重」）；
  4. 对手**后备**在 UI 里只给位次与是否倒下：既不给 `pet_id`（会泄露对手阵容，
   且渲染出来又是占位），也不给血量与配招。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_ui_public_view -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


def fresh() -> "renv.GameState":
    return renv.reset(A_TEAM, B_TEAM, seed=20260921, rs=RS)


def keys_anywhere(payload) -> set:
    """把 payload 里出现过的**所有键名**收集起来（任意深度）。"""
    found = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            found.add(key)
            found |= keys_anywhere(value)
    elif isinstance(payload, list):
        for item in payload:
            found |= keys_anywhere(item)
    return found


class PlannerProtocolStaysMinimal(unittest.TestCase):
    """判据 1：模型协议不许因为 UI 而变胖。"""

    def test_planner_state_has_no_display_fields(self):
        state = fresh()
        public = renv.public_planner_state(state, RS, "player")
        keys = keys_anywhere(public)
        for banned in ("name", "types", "stats", "class", "stage", "desc"):
            self.assertNotIn(
                banned, keys,
                f"规划协议里出现了展示字段 `{banned}`——那是给 UI 的东西，"
                "加进模型协议等于每次请求都为它付 token")

    def test_planner_state_still_declares_its_schema_version(self):
        # 反向：确认这个断言不是因为「取不到数据」而空过
        public = renv.public_planner_state(fresh(), RS, "player")
        self.assertIn("schema_version", public)
        self.assertIn("pets", public["self"])


class UiViewCarriesRealNames(unittest.TestCase):
    """判据 2：UI 视图必须有真名与系别。"""

    def test_ui_view_names_every_own_pet(self):
        state = fresh()
        ui = renv.ui_public_view(state, RS, "player")
        self.assertEqual(len(ui["self"]["pets"]), 3)
        for pet in ui["self"]["pets"]:
            self.assertTrue(pet["name"], f"{pet['pet_id']} 在 UI 视图里没有名字")
            self.assertTrue(pet["types"], f"{pet['name']} 没有系别")
            # 名字必须是**规则集里那个名字**，不是 id、也不是别的什么
            self.assertEqual(pet["name"], RS.pet(pet["pet_id"]).name)
            self.assertNotIn("pet_", pet["name"])

    def test_ui_view_names_the_opponent_field_pet(self):
        # 对手**场上**那一只的名字与血条就画在屏幕上，属于公开信息
        ui = renv.ui_public_view(fresh(), RS, "player")
        field = ui["opponent"]["field"]
        self.assertIsNotNone(field)
        self.assertTrue(field["name"])
        self.assertEqual(field["name"], RS.pet(field["pet_id"]).name)

    def test_ui_view_skills_list_is_nested_like_legal(self):
        # `ui.self.skills` 与 `legal[].skill` **同形**：技能本体在 `.skill` 下面。
        # 桥那一侧按这个形状取名字，Node 侧的假 payload 第一版写成了扁平形状、
        # 于是红在测试自己身上。这里从**真实视图**钉住形状。
        ui = renv.ui_public_view(fresh(), RS, "player")
        self.assertTrue(ui["self"]["skills"], "己方技能列表是空的：这条检查会空过")
        for row in ui["self"]["skills"]:
            self.assertIn("skill", row, "己方技能必须嵌在 `.skill` 下")
            self.assertTrue(row["skill"]["name"])
            self.assertEqual(set(row.keys()) & {"kind", "skill_id"}, {"kind", "skill_id"})

    def test_ui_view_decorates_legal_actions_with_skill_facts(self):
        ui = renv.ui_public_view(fresh(), RS, "player")
        actions = [a for a in ui["legal"]["player"] if a["kind"] == "skill"]
        self.assertTrue(actions, "一个技能动作都没有：这条检查会空过")
        for action in actions:
            skill = action.get("skill")
            self.assertIsNotNone(skill, f"{action.get('label')} 没有带技能说明")
            self.assertTrue(skill["name"])
            self.assertIn("desc", skill)
            # 威力口径必须**照实**：两种状态互斥且穷尽，不许出现「没威力也没说明」。
            #
            # 这条不变式是从数据里**量出来**的，不是猜的（第 42 轮第一次写这条断言时
            # 假设「没威力就必须有 power_status」，结果被 `龙血`（防御类）判红——
            # 那条假设本身是错的：数据里 466 条非攻击技能全都是
            # `not_provided_by_source`）：
            #   · `static_value_present`  ⟺ power 是数字（358/358）
            #   · `not_provided_by_source` ⟺ power 是 None（466/466）
            # 2026-09-23：多出第三档 `recorded_from_human` —— PVP 魔法换进来的「愿力冲击」
            # 的威力/能耗来自人类实机口述（台账 EV-PVP-WISH-POWER-UP），不是冻结来源给的。
            # 口径不放宽：有威力就必须说得出**这一档是哪种来历**，不许含混。
            if skill["power"] is not None:
                self.assertIn(skill["power_status"],
                              {"static_value_present", "recorded_from_human"},
                              f"{skill['name']} 有威力却标着 {skill['power_status']}")
            else:
                self.assertEqual(skill["power_status"], "not_provided_by_source",
                                 f"{skill['name']} 的威力状态不可识别：{skill['power_status']}")


class SkillPowerIsNeverInvented(unittest.TestCase):
    """判据 2b：全量技能上的威力口径（从数据量出来的不变式）。"""

    def test_all_skills_have_a_recognisable_power_status(self):
        counts = {"static_value_present": 0, "not_provided_by_source": 0, "recorded_from_human": 0}
        for skill in RS.skills.values():
            status = skill.power_status
            self.assertIn(status, counts,
                          f"{skill.name} 的 power_status 不是已知取值：{status!r}")
            counts[status] += 1
            if status == "static_value_present":
                self.assertIsInstance(skill.power, int,
                                      f"{skill.name} 标了有静态威力，power 却是 {skill.power!r}")
                self.assertFalse(skill.derived, f"{skill.name} 是派生产物却标着冻结来源的威力口径")
            elif status == "recorded_from_human":
                # 2026-09-23：第三档 = 「这个数来自人类实机口述」（愿力冲击的 2 能耗 / 80 威力）。
                # 不变式：必须**是派生产物**（`derived`），否则就是往冻结表里塞了一个口述的数 ——
                # 那正是这条判据原本要挡的事。
                self.assertIsInstance(skill.power, int,
                                      f"{skill.name} 标了口述威力，power 却是 {skill.power!r}")
                self.assertTrue(skill.derived,
                                f"{skill.name} 标着 recorded_from_human 却不在派生产物里")
            else:
                self.assertIsNone(skill.power,
                                  f"{skill.name} 标了来源未给威力，却带着 power={skill.power!r}")
        # 反向：确认两类**都真的存在**，否则这条断言可能因为取不到数据而空过
        self.assertGreater(counts["static_value_present"], 0)
        self.assertGreater(counts["not_provided_by_source"], 0)
        self.assertEqual(sum(counts.values()), len(RS.skills))


class BothViewsDescribeTheSameMoment(unittest.TestCase):
    """判据 3：两个视图不许各说各话。"""

    def test_versions_and_counters_agree(self):
        state = fresh()
        public = renv.public_planner_state(state, RS, "player")
        ui = renv.ui_public_view(state, RS, "player")
        for field in ("state_version", "turn", "phase", "result", "ruleset_id"):
            self.assertEqual(ui[field], public[field], f"两个视图的 {field} 不一致")

    def test_same_pet_same_numbers(self):
        state = fresh()
        public = renv.public_planner_state(state, RS, "player")
        ui = renv.ui_public_view(state, RS, "player")
        by_slot = {p["slot"]: p for p in public["self"]["pets"]}
        for pet in ui["self"]["pets"]:
            other = by_slot[pet["slot"]]
            for field in ("pet_id", "hp", "max_hp", "energy", "fainted"):
                self.assertEqual(pet[field], other[field],
                                 f"槽位 {pet['slot']} 的 {field} 在两个视图里不同")

    def test_opponent_field_numbers_agree(self):
        state = fresh()
        public = renv.public_planner_state(state, RS, "player")
        ui = renv.ui_public_view(state, RS, "player")
        a, b = public["opponent"]["field"], ui["opponent"]["field"]
        for field in ("pet_id", "hp", "max_hp", "energy", "fainted"):
            self.assertEqual(b[field], a[field], f"对手场上的 {field} 两个视图不同")


class OpponentBenchFollowsRevealRules(unittest.TestCase):
    """判据 4：对手后备直到上场才亮明。**两条视图同一条口径。**

    ── 2026-09-30（分计划 01）改钉记录 ───────────────────────────────────────
    这里原来是**一对方向相反**的断言：

      · `test_ui_bench_has_no_identity_and_no_panel`（保留，未改）：
        断言 `ui_public_view` 的后备键集 == `{"slot", "fainted"}` —— **今天仍然成立**；
      · `test_planner_bench_keeps_pet_id_for_reconstruction`（**已改钉**），原断言逐字：
            public = renv.public_planner_state(fresh(), RS, "player")
            for entry in public["opponent"]["bench"]:
                self.assertIn("pet_id", entry)
        它的注释写着：「反向：规划协议**必须**留着 pet_id（重建搜索状态要用）。
        两条视图口径不同是有意的，不是漏改。」

    **为什么它必须撤（独立证据，不是为了让测试绿）**：
    这条断言把「两条视图**公开性口径不同**」当成了设计意图，而当前有效规则要求的是
    **字段集可以不同、公开边界必须相同**：
      · `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53`（对手物种只在预览实际展示后公开）；
      · `docs/roco/execution/01-PLAN.md:38`（预览前 / 无预览模式不得提前泄漏阵容）；
      · Codex 修订计划（2026-09-30）：「预览尚未出现时不许提前读阵容」。
    实测（`reports/roco/product-execution/01/raw-align-before.json`）：改前规划协议给出
    对手**整队六只**的 `pet_id`；`observation_for` 更是连 `name` 一起给（整队真名）。
    而 `src/coach/game-adapter.js:74` 的 `FOE_BENCH_FIELDS = ['slot','fainted']` 说明
    **下游早就按「后备无身份」在守** —— 是规划协议这一侧落单了。

    那么「重建搜索状态要用 pet_id」怎么办？重建**不需要**对手后备的身份：它本来就按
    `OPPONENT_BENCH_ASSUMPTION`（满血 + 规范配招）把后备当未知量建模。去掉身份之后
    `state_from_public_planner` 走它**本来就有**的占位分支，从「假装知道是哪只」变成
    「如实说不知道」。这一条由下面的
    `test_planner_reconstruction_still_works_without_bench_identity` 直接钉住
    （不只是「应该还能跑」）。
    """

    def test_ui_bench_has_no_identity_and_no_panel(self):
        ui = renv.ui_public_view(fresh(), RS, "player")
        bench = ui["opponent"]["bench"]
        self.assertTrue(bench, "后备是空的：这条检查会空过")
        for entry in bench:
            self.assertEqual(set(entry.keys()), {"slot", "fainted"},
                             "对手后备只该给位次与是否倒下")
        self.assertNotIn("pet_", json.dumps(bench, ensure_ascii=False))

    def test_planner_bench_has_no_identity_either(self):
        """规划协议与 UI 视图**同一条公开性边界**（方向已从"相反"统一为"相同"）。"""
        public = renv.public_planner_state(fresh(), RS, "player")
        bench = public["opponent"]["bench"]
        self.assertTrue(bench, "后备是空的：这条检查会空过")
        for entry in bench:
            self.assertEqual(set(entry.keys()), {"slot", "fainted"},
                             "规划协议的后备也不许带物种身份（与 UI 视图同一条边界）")
        self.assertNotIn("pet_", json.dumps(bench, ensure_ascii=False))
        # 场上那只**已经亮明** ⇒ 身份是公开的。这条防止上面被误读成「一律不给身份」。
        self.assertIn("pet_id", public["opponent"]["field"])

    def test_planner_reconstruction_still_works_without_bench_identity(self):
        """撤掉重建依据之后，重建必须**仍然能跑**，且如实标注这是假设。

        为什么必须有这一条：改钉的理由之一是「重建不需要后备身份」。那是**主张**，
        主张要被跑一遍才算数。
        """
        public = renv.public_planner_state(fresh(), RS, "player")
        back = renv.state_from_public_planner(public, RS, analysis_seed=4242)
        self.assertEqual(back.seed, 4242, "重建必须用 analysis_seed，不是真实 seed")
        # 场上那只**逐字还原**（它是公开的）
        self.assertEqual(back.enemy.field_pet.pet_id, public["opponent"]["field"]["pet_id"])
        self.assertEqual(back.enemy.field_pet.hp, public["opponent"]["field"]["hp"])
        # 后备：位次与存活要对，身份**允许是占位**（公开信息里没有）
        bench_slots = sorted(int(b["slot"]) for b in public["opponent"]["bench"])
        self.assertEqual(len(back.enemy.pets), max(bench_slots) + 1,
                         "重建出来的对手队列长度必须覆盖到最后一个后备位次")
        for b in public["opponent"]["bench"]:
            pet = back.enemy.pets[int(b["slot"])]
            self.assertEqual(pet.fainted, bool(b["fainted"]), "存活情况必须还原")
        # 假设必须被标注出来（不是静默填数）
        self.assertIn("opponent_bench", public["assumptions"])


if __name__ == "__main__":
    unittest.main()
