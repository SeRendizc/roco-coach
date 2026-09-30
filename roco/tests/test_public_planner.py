"""公开 planner state 与隐藏信息边界（MC-013）的反证测试。

这一组测试是为了回答一个问题：**教练规划时能不能利用真实对局 seed？**
答案必须是不能。做法不是「我们保证不读」，而是把它变成会失败的检查：

  1. 公开 schema 里**没有** seed / pending / 对手后备血量这些字段
  2. 任何深度、任何位置的 `seed` 都被隐藏信息检测拒绝（没有例外）
  3. **同一公开观察 + 不同真实内部 seed → 请求内容与推荐必须一致**
     （如果推荐随真实 seed 变化，就说明真实 seed 漏进去了）
  4. 真实 seed 只影响对局内同速裁决；分析用与它无关的 analysis seeds，
     并跨种子聚合，所以结论是区间而不是单点

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402
from roco_env.service import RocoService, find_hidden_keys  # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]
#: 01.6 反例要用到的两支队（互不相同，且都不是 A_TEAM 的排列）。
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]


class TestPublicSchemaHasNoSecrets(unittest.TestCase):
    def test_schema_carries_no_seed_pending_or_bench_detail(self):
        for seed in (3, 17, 999):
            st = renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)
            pub = renv.public_planner_state(st, RS)
            blob = json.dumps(pub, ensure_ascii=False)
            for forbidden in ("seed", "pending", "_pending", "rng", "random"):
                self.assertNotIn(forbidden, blob,
                                 f"公开 planner state 里出现了 {forbidden}（seed={seed}）")

    def test_opponent_bench_exposes_only_public_facts(self):
        """对手后备只给位次与是否倒下。

        **原断言（逐字，改钉不删）**：
            self.assertEqual(set(entry.keys()), {"slot", "pet_id", "fainted"},
                             "对手后备只应有位次/id/是否倒下；血量与配招是隐藏信息")

        **为什么它与当前有效规则冲突（独立证据）**：
        `pet_id` 是**物种身份**，不是「位次/存活」那种结构性事实。按当前口径：
          · `docs/roco/PRODUCT-VISION-AND-ROADMAP.md:53`——「开局对方阵容」一栏里，
            **可以**知道的是「预览实际展示的物种、形象、属性及明确可见的顺序」；
            **不可以**假定看见物种就知道天分/性格/真实六维与四技能；
          · `docs/roco/execution/01-PLAN.md:38`——通过条件之一：「预览发生前及无预览模式
            **没有提前泄漏阵容**」；
          · Codex 修订计划（2026-09-30）——「预览**尚未出现**时不许提前读阵容」。
        在**尚未发生预览**的一局里给出后备 `pet_id`，就是把整队物种身份提前交出去。
        实测（`reports/roco/product-execution/01/raw-align-before.json`）：
        改前 `public_planner_state.opponent.bench_pet_ids == ['pet_000112','pet_000062',…]`
        ——对手**整队六只**的身份可读。

        ⇒ 新口径：后备只有 `slot` / `fainted`；物种身份等第 02 分计划做出「开局预览」
        之后，按**实际亮明的**那一份带 `revealed_*` 字段进来。
        """
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertTrue(pub["opponent"]["bench"], "后备是空的：这条检查会空过")
        for entry in pub["opponent"]["bench"]:
            self.assertEqual(set(entry.keys()), {"slot", "fainted"},
                             "对手后备只应有位次与是否倒下；物种身份、血量、配招都是隐藏信息")
        # 物种身份不得从任何别的地方漏出来
        self.assertNotIn("pet_", json.dumps(pub["opponent"]["bench"], ensure_ascii=False))
        # 场上那只的面板是公开的（屏幕上就写着）——**包括身份**，因为它已经亮明了
        field = pub["opponent"]["field"]
        self.assertIn("hp", field)
        self.assertIn("energy", field)
        self.assertIn("pet_id", field, "场上那只已经亮明，身份是公开的")

    def test_assumptions_are_declared(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertIn("assumptions", pub)
        self.assertIn("opponent_bench", pub["assumptions"])


class TestHiddenKeyDetectionHasNoException(unittest.TestCase):
    """任何深度、任何位置的 seed 都必须被拒。上一版给 state.seed 开了后门，已移除。"""

    def test_seed_rejected_at_every_depth(self):
        cases = [
            {"seed": 1},
            {"state": {"seed": 1}},
            {"state": {"foo": {"seed": 1}}},
            {"state": {"history": [{"seed": 9}]}},
            {"public": {"seed": 1}},
            {"public": {"self": {"pets": [{"seed": 1}]}}},
            {"analysis": {"rng_seed": 3}},
            {"deep": {"a": {"b": {"c": {"random_seed": 7}}}}},
        ]
        for payload in cases:
            hits = find_hidden_keys(payload)
            self.assertTrue(hits, f"隐藏信息检测漏了：{payload}")

    def test_pending_opponent_action_rejected(self):
        for payload in ({"state": {"_pending_enemy": {}}},
                        {"state": {"pending_enemy_action": {}}},
                        {"_pending_player": {}}):
            self.assertTrue(find_hidden_keys(payload), f"漏了 {payload}")

    def test_clean_public_payload_passes(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=5, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertEqual(find_hidden_keys({"public": pub, "state_version": pub["state_version"]}), [])


class TestRealSeedCannotLeak(unittest.TestCase):
    """核心反证：真实内部 seed 不影响规划请求，也不影响推荐。"""

    def test_public_state_is_identical_across_internal_seeds(self):
        a = renv.public_planner_state(renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS), RS)
        b = renv.public_planner_state(renv.reset(A_TEAM, A_TEAM, seed=12345, rs=RS), RS)
        # 除了 state_version（会随事件推进）以外，公开信息应当完全一致
        a.pop("state_version", None)
        b.pop("state_version", None)
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False),
                         "不同真实 seed 的公开观察不一致——说明有内部信息泄进了公开 schema")

    def test_recommendation_identical_across_internal_seeds(self):
        svc = RocoService()
        results = []
        for seed in (7, 12345, 999):
            st = renv.reset(A_TEAM, A_TEAM, seed=seed, rs=RS)
            pub = renv.public_planner_state(st, RS)
            status, env = svc.battle_plan({
                "public": pub, "state_version": pub["state_version"],
                "depth": 2, "beam": 3, "analysis_seeds": [11, 29],
            })
            self.assertEqual(status, 200)
            self.assertTrue(env["ok"])
            r = env["result"]
            # 只比**实质规划结果**。不要整对象比较：result 里带 state_version，
            # 那一项会随事件推进而变化，跟 seed 泄漏无关（我第一版就是这么假红的）。
            results.append(json.dumps({
                "recommended_stable": r["recommendation_stable"],
                "labels_by_seed": r["recommended_by_seed"],
                "expected": r["expected"],
                "worst": r["worst"],
                "main_counter": r["main_counter"],
                "branches": r["branches_evaluated"],
                "per_seed_labels": [p["recommended_label"] for p in r["per_seed"]],
                "per_seed_expected": [round(p["expected"], 6) for p in r["per_seed"]],
            }, sort_keys=True, ensure_ascii=False))
        self.assertEqual(len(set(results)), 1,
                         "推荐随真实内部 seed 变化——真实 seed 被利用了")

    def test_reconstruction_uses_analysis_seed_not_real_seed(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=777, rs=RS)
        pub = renv.public_planner_state(st, RS)
        back = renv.state_from_public_planner(pub, RS, analysis_seed=4242)
        self.assertEqual(back.seed, 4242)
        self.assertNotEqual(back.seed, 777, "重建状态不能沿用真实对局 seed")


class TestServiceRejectsPrivateState(unittest.TestCase):
    def test_private_serialize_is_refused_because_of_seed(self):
        svc = RocoService()
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        status, env = svc.battle_plan({"state": renv.serialize(st),
                                       "state_version": st.state_version})
        self.assertEqual(status, 400)
        self.assertEqual(env["error_type"], "hidden_information")
        self.assertIn("seed", env["error"])

    def test_plan_without_public_is_a_clear_bad_request(self):
        svc = RocoService()
        status, env = svc.battle_plan({"state_version": 0})
        self.assertEqual(status, 400)
        self.assertIn("public", env["error"])

    def test_aggregation_reports_a_range_not_a_point(self):
        svc = RocoService()
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        pub = renv.public_planner_state(st, RS)
        status, env = svc.battle_plan({"public": pub, "state_version": pub["state_version"],
                                       "depth": 2, "beam": 3,
                                       "analysis_seeds": [1, 2, 3, 4]})
        self.assertEqual(status, 200)
        r = env["result"]
        self.assertEqual(r["analysis_seeds"], [1, 2, 3, 4])
        exp = r["expected"]
        self.assertLessEqual(exp["min"], exp["max"], "期望值必须给区间而不是单点")
        self.assertIn("worst", r)
        # limitations 必须说明这不是胜率、且随机性与真实 seed 无关
        joined = " ".join(env["limitations"])
        self.assertIn("不是胜率", joined)
        self.assertIn("真实 seed", joined)


class TestObservationContractFields(unittest.TestCase):
    """分计划 01.2：版本化观察契约（match_id / rules_version / decision_id / event_seq）。

    口径与理由见 `env.py` 的「观察契约」一节。这一组判据钉四件事：

      1. 三个契约字段在**两个公开面**与 service 回执里**同源同值**（各算一份就会漂）；
      2. `match_id` 与**真实 seed 无关**（这是它能进公开面的前提），
         但**换己方队员 / 换规则配置会变**（否则它不是身份，是个常量）；
      3. `decision_id = <match_id>:v<state_version>`，且**序列化往返不丢身份**；
      4. `event_seq` 等于事件在 `state.events` 里的 0-based 追加序号，
         且当场校验「`state_version` 的唯一写入点是 `_bump`」这条不变式
         （绕过它 append ⇒ 必须抛错，而不是给一个错的序号）。
    """

    def test_contract_fields_are_shared_by_both_public_faces(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=20260930, rs=RS)
        pub = renv.public_planner_state(st, RS)
        ui = renv.ui_public_view(st, RS)
        for field in ("match_id", "rules_version", "decision_id"):
            self.assertIn(field, pub, f"规划协议缺契约字段 {field}")
            self.assertIn(field, ui, f"UI 视图缺契约字段 {field}")
            self.assertEqual(ui[field], pub[field], f"两个视图的 {field} 不一致（各算了一份？）")
        self.assertTrue(pub["match_id"].startswith("m-"), pub["match_id"])
        self.assertEqual(pub["rules_version"], f"{RS.ruleset_id}/{st.ruleset_config_id}")

    def test_match_id_ignores_the_real_seed(self):
        """match_id 进公开面的前提：与真实 seed 无关。"""
        a = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        b = renv.reset(A_TEAM, A_TEAM, seed=12345, rs=RS)
        self.assertEqual(renv.match_id_of(a, RS), renv.match_id_of(b, RS),
                         "match_id 随真实 seed 变了 —— 那是隐藏信息漏进了公开面")

    def test_match_id_changes_with_own_team_or_rules_version(self):
        """反向控制：换一名己方队员、或换规则配置，match_id **必须**变。"""
        a = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        swapped = [A_TEAM[0], A_TEAM[1], RS.pets_by_name("音速犬")[0].pet_id]
        b = renv.reset(swapped, A_TEAM, seed=7, rs=RS)
        self.assertNotEqual(renv.match_id_of(a, RS), renv.match_id_of(b, RS),
                            "换了一名己方队员 match_id 却没变：它不是身份")
        # 换规则配置（不改数据，只改这一局绑定的配置 id）
        c = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        c.ruleset_config_id = "another-config"
        self.assertNotEqual(renv.match_id_of(a, RS), renv.match_id_of(c, RS),
                            "换了规则配置 match_id 却没变")
        self.assertEqual(renv.rules_version_of(c, RS), f"{RS.ruleset_id}/another-config")

    def test_match_id_is_a_setup_identity_not_a_unique_match_id(self):
        """**已知性质，不是 bug**：同规则同己方队伍的两局，match_id 相同。

        引擎是确定性状态机，不伪造唯一性（见 `env.py` 的「观察契约」一节）。
        「每局不同」的会话唯一性由 Node 侧 session id 负责
        （`src/server/roco-service.js` 的 `newSessionId()`）。
        这条断言把它**写下来**，免得后来的人把「相同」读成实现坏了。
        """
        first = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        second = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        self.assertEqual(renv.match_id_of(first, RS), renv.match_id_of(second, RS),
                         "同开局事实的两局必须是同一个 match_id（确定性派生）")

    def test_decision_id_binds_match_and_state_version(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        pub = renv.public_planner_state(st, RS)
        self.assertEqual(pub["decision_id"], f"{pub['match_id']}:v{st.state_version}")
        # 状态推进 ⇒ decision_id 跟着 state_version 走（同一个局的另一个决策点）
        st.turn = 3
        st.state_version = 17
        pub2 = renv.public_planner_state(st, RS)
        self.assertEqual(pub2["decision_id"], f"{pub2['match_id']}:v17")
        self.assertEqual(pub2["match_id"], pub["match_id"], "同一个局的 match_id 不许随状态变")

    def test_identity_survives_serialize_roundtrip(self):
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        back = renv.deserialize(renv.serialize(st), RS)
        self.assertEqual(renv.match_id_of(back, RS), renv.match_id_of(st, RS))
        self.assertEqual(renv.decision_id_of(back, RS), renv.decision_id_of(st, RS))
        self.assertEqual(renv.rules_version_of(back, RS), renv.rules_version_of(st, RS))

    def test_observation_payload_does_not_carry_envelope_identity(self):
        """`observation_for` 是「看得见的事实」载荷，不装信封身份（这是有意的边界）。

        代价写下来：策略观察里没有 match_id/decision_id（要它们的是 UI / 教练 / 回放，
        那些走的是公开面与回执）。好处是 `state.history` 的观察哈希**逐字节不变**——
        加一个常量键就会让 `test_turn_order_fail_closed` 的 history 指纹整批改钉，
        那测的是「引擎默认路径没变」，不该被信封字段牵着走。
        """
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        obs = renv.observation_for(st, RS, "player")
        for field in ("match_id", "rules_version", "decision_id"):
            self.assertNotIn(field, obs, f"观察载荷里出现了信封字段 {field}（口径已变）")
        self.assertIn("state_version", obs, "state_version 是既有钉子，必须在")

    def _advance_once(self, svc: RocoService):
        status, env = svc.battle_new({"ruleset_id": RS.ruleset_id, "team": A_TEAM,
                                      "enemy_team": A_TEAM, "seed": 5, "state_version": 0})
        self.assertEqual(status, 200)
        result = env["result"]
        action = next(a for a in result["legal"]["player"] if a["kind"] == "skill")
        status2, env2 = svc.battle_advance({"state": result["state"],
                                            "state_version": result["state_version"],
                                            "action": action})
        self.assertEqual(status2, 200)
        return result, env2["result"]

    def test_receipt_carries_the_same_contract_fields(self):
        svc = RocoService()
        new_result, advance_result = self._advance_once(svc)
        for field in ("match_id", "rules_version", "decision_id"):
            self.assertEqual(new_result[field], new_result["public"][field])
            self.assertEqual(new_result[field], new_result["ui"][field])
            self.assertEqual(advance_result[field], advance_result["public"][field])
        self.assertEqual(new_result["match_id"], advance_result["match_id"],
                         "同一局推进之后 match_id 变了")
        self.assertNotEqual(new_result["decision_id"], advance_result["decision_id"],
                            "推进之后 decision_id 必须跟着 state_version 变")

    def test_event_seq_is_the_absolute_append_index(self):
        svc = RocoService()
        _, result = self._advance_once(svc)
        events = result["events"]
        self.assertTrue(events, "这一回合一个事件都没有：这条检查会空过")
        state = result["state"]
        self.assertEqual(state["state_version"], len(state["events"]),
                         "state_version 必须恒等于 len(state.events)（_bump 是唯一写入点）")
        first = len(state["events"]) - len(events)
        self.assertEqual([e["seq"] for e in events], list(range(first, len(state["events"]))),
                         "event_seq 不是 state.events 里的绝对下标（切片之后就复原不出来了）")
        self.assertEqual(events[0]["seq"], 0, "本局第一条事件的序号必须是 0")
        for prev, cur in zip(events, events[1:]):
            self.assertLess(prev["seq"], cur["seq"], "事件序号不是严格递增的")

    def test_event_seq_refuses_to_guess_when_the_counter_is_bypassed(self):
        """必红方向：绕过 `_bump` 直接 append ⇒ 序号口径被破坏，必须抛错。"""
        st = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        st.events.append(renv.Event(kind="turn_start", turn=1, detail={"turn": 1}))  # 绕过 _bump
        self.assertEqual(st.state_version, 0)
        self.assertEqual(len(st.events), 1)
        with self.assertRaises(ValueError) as ctx:
            renv.event_seq_of(st, 0)
        self.assertIn("state_version", str(ctx.exception))
        # 反向控制：走 `_bump` 的局必须给 0（证明上面那条红不是「恒抛」）
        clean = renv.reset(A_TEAM, A_TEAM, seed=7, rs=RS)
        renv._bump(clean, "turn_start", {"turn": clean.turn})
        self.assertEqual(renv.event_seq_of(clean, 0), 0)
        with self.assertRaises(ValueError):
            renv.event_seq_of(clean, 5)


#: 01.2 契约字段的用例复用文件顶部那份 A_TEAM（三只：寂灭骨龙 / 海豹船长 / 黑猫巫师）。


class TestHiddenTruthInvarianceAndPublicChange(unittest.TestCase):
    """分计划 01.6 的反例（必须做）：

      A. **固定公开史**，只改隐藏真值（对手真实配招 / 后备资源 / 隐藏个体面板）
         ⇒ 公开输入**逐字段相同**；
      B. 改**已经展示**的东西（预览亮明的物种、对手已经打出来的技能）⇒ 观察**确实变化**。

    「公开输入」= 两个公开面（规划协议 / UI 视图）+ 两侧的 `observation_for`
    —— 后者是策略与工具输入的共同来源（`env.observe`）。三份一起比，避免只比一份。

    ⚠ U1（对局内改对手个体）**仍然 blocked:needs_injection_entry**：`reset(individuals=…)`
    只按**玩家**队伍位次解析（实测），引擎没有对局内注入对手个体的入口。这里的第三条
    用例**不是**一个入口，而是**直接改隐藏真值字段**，用来证明公开面不读它；不猜、也不静默跳过。
    """

    C_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("画间沉铁兽", "秩序鱿墨", "化蝶")]

    def _snapshot(self, st):
        """**玩家这一侧**的公开输入。

        为什么不比 `observation_for(..., "enemy")`：**对手自己的血/能量是它自己的信息**
        （`own_pet` 把面板给自己看）。改对手后备资源必然改到那一份 —— 那是对侧视角，
        不是泄漏。隐藏真值的「隐藏」是**相对玩家**说的，所以这一组只比玩家看到的那些。
        """
        return {
            "public": renv.public_planner_state(st, RS, "player"),
            "ui": renv.ui_public_view(st, RS, "player"),
            "obs": renv.observation_for(st, RS, "player"),
        }

    def _blob(self, snapshots):
        return json.dumps(snapshots, sort_keys=True, ensure_ascii=False)

    def _scripted_history(self, *, enemy_loadouts=None, enemy_skill_index=0, turns=3):
        """固定公开史：每一步都用**写死的技能 id**，只有隐藏真值在变。"""
        st = renv.reset(A_TEAM, B_TEAM, seed=20260930, rs=RS, loadouts=enemy_loadouts)
        mine = RS.candidate_moveset(A_TEAM[0])[0]
        theirs = RS.candidate_moveset(B_TEAM[0])[enemy_skill_index]
        snapshots = [self._snapshot(st)]
        for _ in range(turns):
            if st.result:
                break
            renv.step_joint(st, RS,
                            Action(kind=ACTION_SKILL, skill_id=mine),
                            Action(kind=ACTION_SKILL, skill_id=theirs))
            snapshots.append(self._snapshot(st))
        return snapshots

    def _swapped_enemy_loadout(self):
        """对手**真实配招**里换掉最后一招（换成一个它学得到、但整局不会用到的技能）。"""
        pet_id = B_TEAM[0]
        canonical = list(RS.candidate_moveset(pet_id))
        learnset = RS.learnsets[pet_id].all_skill_ids
        replacement = sorted(sid for sid in learnset if sid not in canonical)
        self.assertTrue(replacement, f"{pet_id} 没有可换的备选技能：这条检查会空过")
        swapped = canonical[:-1] + [replacement[0]]
        self.assertNotEqual(swapped, canonical)
        return {pet_id: swapped}

    def test_hidden_loadout_change_leaves_every_public_input_identical(self):
        a = self._scripted_history()
        b = self._scripted_history(enemy_loadouts=self._swapped_enemy_loadout())
        self.assertEqual(self._blob(a), self._blob(b),
                         "只改了对手**真实配招**（未打出的那一招），公开输入却变了")

    def test_hidden_bench_resources_leave_every_public_input_identical(self):
        st = renv.reset(A_TEAM, B_TEAM, seed=9, rs=RS)
        before = self._blob(self._snapshot(st))
        for pet in st.enemy.pets[1:]:
            pet.hp = 1
            pet.energy = 9
            pet.statuses["中毒"] = {"layers": 3}
            pet.marks["mark"] = {"layers": 2}
        self.assertEqual(self._blob(self._snapshot(st)), before,
                         "只改了对手**后备**的血量/能量/异常，公开输入却变了")

    def test_hidden_individual_panel_never_reaches_the_public_inputs(self):
        """改对手**隐藏个体面板** ⇒ 个体真值一个都不进公开输入（U1 说明见类 docstring）。"""
        st = renv.reset(A_TEAM, B_TEAM, seed=20260930, rs=RS)
        pub_before = json.dumps(renv.public_planner_state(st, RS), sort_keys=True, ensure_ascii=False)
        obs_before = json.dumps(renv.observation_for(st, RS, "player"), sort_keys=True, ensure_ascii=False)
        injected = {"atk": 611111, "def": 622222, "hp": 633333,
                    "spa": 644444, "spd": 655555, "spe": 666666}
        st.enemy.field_pet.panel = dict(injected)
        self.assertEqual(
            json.dumps(renv.public_planner_state(st, RS), sort_keys=True, ensure_ascii=False),
            pub_before, "对手个体面板漏进了规划协议")
        self.assertEqual(
            json.dumps(renv.observation_for(st, RS, "player"), sort_keys=True, ensure_ascii=False),
            obs_before, "对手个体面板漏进了观察载荷")
        ui = renv.ui_public_view(st, RS)
        for value in injected.values():
            self.assertNotIn(str(value), json.dumps(ui, ensure_ascii=False),
                             "对手个体真值漏进了 UI 公开面")
        # 已知连带影响（如实断言，不掩盖）：`battle_uses_panel_scale` 是「本局有人带快照」的
        # **全局展示口径**，注入后面板口径打开 ⇒ 对手展示切到**物种面板**（不是个体真值）。
        self.assertEqual(ui["opponent"]["field"]["stats_source"], "species-panel")

    def test_changing_a_displayed_species_changes_the_observation(self):
        """正例：改**已经展示**的物种 ⇒ 观察确实变化。"""
        a = renv.reset(A_TEAM, B_TEAM, seed=1, rs=RS)
        renv.opening_roster_reveal(a, RS)
        c = renv.reset(A_TEAM, self.C_TEAM, seed=1, rs=RS)
        renv.opening_roster_reveal(c, RS)
        roster_a = [row["pet_id"] for row in
                    renv.observation_for(a, RS, "player")["revealed"]["opponent_roster"]]
        roster_c = [row["pet_id"] for row in
                    renv.observation_for(c, RS, "player")["revealed"]["opponent_roster"]]
        self.assertEqual(roster_a, list(B_TEAM))
        self.assertEqual(roster_c, list(self.C_TEAM))
        self.assertNotEqual(roster_a, roster_c, "换了已展示的物种，观察却没变")
        self.assertNotEqual(
            json.dumps(renv.public_planner_state(a, RS), sort_keys=True),
            json.dumps(renv.public_planner_state(c, RS), sort_keys=True),
            "换了已展示的物种，公开面却没变")

    def test_changing_a_publicly_used_skill_changes_the_observation(self):
        """正例：改**已经公开**的那一招（对手打出来的技能）⇒ 观察确实变化。"""
        first = self._scripted_history(enemy_skill_index=0, turns=1)
        second = self._scripted_history(enemy_skill_index=1, turns=1)
        used_first = first[-1]["obs"]["revealed"]["opponent_skills"][B_TEAM[0]]
        used_second = second[-1]["obs"]["revealed"]["opponent_skills"][B_TEAM[0]]
        self.assertEqual(used_first, [RS.candidate_moveset(B_TEAM[0])[0]])
        self.assertEqual(used_second, [RS.candidate_moveset(B_TEAM[0])[1]])
        self.assertNotEqual(self._blob(first[-1]), self._blob(second[-1]),
                            "换了对手打出来的那一招，观察却没变")

    def test_reveal_facts_stay_empty_without_any_reveal_event(self):
        """反向控制：没有任何亮明事件时，`revealed_facts` 必须是 `{}`（不是空壳对象）。"""
        st = renv.reset(A_TEAM, B_TEAM, seed=3, rs=RS)
        self.assertEqual(renv.revealed_facts(st, RS, side="player"), {})
        self.assertNotIn("revealed", renv.observation_for(st, RS, "player"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
