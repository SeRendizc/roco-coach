"""04.5 定向判据：**七类场景冻结** + **独立于评分函数**的简单规则基线对照 + 真实结算复核。

跑法（仓库根）：
  `wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p04-04.5.sh`
或在 `roco/` 下：
  `PYTHONPATH=src python3 -m unittest tests.test_plan_seven -v`

三条纪律（分别对应 04.5 的三项要求）：
  ① **七类场景冻结**：克制换人 / 未知配招 / 低能量 / 濒死 / 同速 / 未上场已见宠 / 对手实际换人 ——
     每类都有**确定性夹具**与**它自己那条**可判死的性质；
  ② **基线独立于评分函数**：`rule_baseline()` 只用公开事实与冻结数据（威力 × 相性 / 血量 / 能量），
     **不许**碰 `planner.evaluate` / `plan_actions` / `one_ply_value` —— 并且这一条是**行为判据**：
     把 `pm.evaluate` 换成「一调用就抛」之后，基线**照样**能算出动作；
  ③ **真实结算复核**：用 `env.step_joint` 把「推荐的那一手 × 对手每一种合法回应」**真结算**一遍，
     读**原始量**（谁倒下、剩多少血），**不用** `expected/worst` 那些估值 —— 不让同一把尺子自证最优。
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from roco_env import data as rdata          # noqa: E402
from roco_env import env as renv            # noqa: E402
from roco_env import planner as pm          # noqa: E402
from roco_env.schema import GameState       # noqa: E402
from roco_env.service import RocoService    # noqa: E402

RS = rdata.load_ruleset()
A_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("喵喵", "水蓝蓝", "火花")]
B_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("圆号鱼", "雪影娃娃", "音速犬")]
#: 濒死那一类沿用 04.4 的**实测反例夹具**（旧口径会推「期望高但必然崩」的那一手）
COUNTER_TEAM = [RS.pets_by_name(n)[0].pet_id for n in ("寂灭骨龙", "海豹船长", "黑猫巫师")]


# ── 夹具 ────────────────────────────────────────────────────────────────

def open_public(*, team=None, enemy=None, seed=5, hp=None, energy=None, preview=False):
    """开一局并返回 `(public, state)`；`hp/energy` 用于把**场上那只**压到指定值（公开信息）。"""
    svc = RocoService()
    body = {"team": team or A_TEAM, "enemy_team": enemy or B_TEAM,
            "seed": seed, "state_version": 0}
    if preview:
        body["opening_preview"] = True
    status, envelope = svc.battle_new(body)
    assert status == 200, (status, envelope)
    public = json.loads(json.dumps(envelope["result"]["public"]))
    active = int(public["self"]["active"])
    if hp is not None:
        public["self"]["pets"][active]["hp"] = hp
    if energy is not None:
        public["self"]["pets"][active]["energy"] = energy
    return public, renv.state_from_public_planner(public, RS, analysis_seed=11)


def plan(state, *, depth=2, beam=4, budget_ms=800):
    """规划（**注入确定性时钟**：判据与负载无关）。"""
    return pm.plan_actions(state, RS, depth=depth, beam=beam, budget_ms=budget_ms,
                           clock=lambda: 0.0)


def legal(state, side="player"):
    return [a for a in renv.legal_actions(state, RS, side) if a.kind != "escape"]


def clone(state):
    return GameState.from_dict(state.to_dict())


# ── ② 简单规则基线（**独立于评分函数**）────────────────────────────────────

def rule_baseline(state, rs):
    """简单规则基线：只用公开事实 + 冻结数据，**不碰** `evaluate` / `plan_actions`。

    规则（顺序固定、逐条可解释）：
      ① 有技能能**一击收掉**对手场上那只（`威力 × 相性 ≥ 对手血量 × 2`，粗估）⇒ 用威力最高的攻击；
      ② 我方场上那只血量 ≤ 1/4 且后备有**更优对位**（承受倍率更低）⇒ 换到那一只；
      ③ 否则用「威力 × 相性」最高的攻击；
      ④ 都不行 ⇒ 防御（没有防御技能就用第一个合法动作）。
    它**故意粗糙**：基线的作用是「换一把尺子看同一件事」，不是更准的规划器。
    """
    actions = legal(state, "player")
    if not actions:
        return None, "no-legal-action"
    mine = state.player.field_pet
    foe = state.enemy.field_pet
    foe_types = rs.pet(foe.pet_id).types
    my_types = rs.pet(mine.pet_id).types

    def attack_score(action):
        sk = rs.skills.get(action.skill_id or "")
        if sk is None or not sk.is_attack or not sk.power:
            return None
        mult = rs.type_chart.multiplier(foe_types, sk.element) if sk.element else 1.0
        return float(sk.power) * float(mult)

    best_attack, best_score = None, None
    for action in actions:
        if action.kind != "skill":
            continue
        score = attack_score(action)
        if score is None:
            continue
        if best_score is None or score > best_score:
            best_attack, best_score = action, score
    # ① 粗估「一击收掉」：威力 × 相性 ≥ 对手当前血量 × 2（经验系数，属于基线自己的口径）
    if best_attack is not None and best_score >= foe.hp * 2:
        return best_attack, "lethal-estimate"
    # ② 濒死且后备更优对位 ⇒ 换人
    if mine.hp <= max(1, mine.max_hp // 4) and my_types:
        worst_now = rs.type_chart.multiplier(my_types, foe_types[0]) if foe_types else 1.0
        best_switch, best_mult = None, worst_now
        for action in actions:
            if action.kind != "switch" or action.target_index is None:
                continue
            slot = int(action.target_index)
            pets = [p for p in state.player.pets if int(p.slot) == slot]
            if not pets or pets[0].fainted:
                continue
            types = rs.pet(pets[0].pet_id).types
            if not types:
                continue
            mult = rs.type_chart.multiplier(types, foe_types[0]) if foe_types else 1.0
            if mult < best_mult:
                best_switch, best_mult = action, mult
        if best_switch is not None:
            return best_switch, "switch-to-better-matchup"
    # ③ 最高「威力 × 相性」
    if best_attack is not None:
        return best_attack, "best-raw-attack"
    # ④ 防御兜底
    for action in actions:
        sk = rs.skills.get(action.skill_id or "")
        if sk is not None and getattr(sk, "is_defense", False):
            return action, "defense-fallback"
    return actions[0], "first-legal-fallback"


# ── ③ 真实结算复核（原始量，不用估值）──────────────────────────────────────

def settlement(state, rs, action):
    """把 `action` 与**对手每一种合法回应**真走一遍（`step_joint`），只读原始量。"""
    rows = []
    for opp in legal(state, "enemy"):
        nxt = clone(state)
        try:
            nxt = renv.step_joint(nxt, rs, action, opp)
        except Exception as exc:                       # noqa: BLE001
            rows.append({"enemy": pm._label(rs, opp), "error": type(exc).__name__})
            continue
        mine, foe = nxt.player.field_pet, nxt.enemy.field_pet
        rows.append({"enemy": pm._label(rs, opp), "my_fainted": bool(mine.fainted),
                     "foe_fainted": bool(foe.fainted),
                     "my_hp": int(mine.hp), "foe_hp": int(foe.hp),
                     "my_energy": int(mine.energy)})
    return rows


def survives_all(state, rs, action):
    """这一手在对手**每一种**合法回应下都活着（原始结算；算不出来的分支视为「不知」⇒ 不算通过）。"""
    rows = settlement(state, rs, action)
    if not rows or any("error" in row for row in rows):
        return None
    return all(not row["my_fainted"] for row in rows)


# ── ① 七类场景 ──────────────────────────────────────────────────────────

class SevenScenariosTest(unittest.TestCase):
    """每一类：确定性夹具 + 一条**它自己**可判死的性质 + 基线与真实结算读数。"""

    def _report(self, name, state, result, baseline_kind, extra=None):
        rows = settlement(state, RS, result.recommended)
        payload = {"scenario": name, "recommended": result.recommended_label,
                   "baseline": pm._label(RS, baseline_kind[0]) if baseline_kind[0] else None,
                   "baseline_rule": baseline_kind[1],
                   "expected": round(result.expected, 4), "worst": round(result.worst, 4),
                   "settlement": rows}
        if extra:
            payload.update(extra)
        print("  · [04.5] " + json.dumps(payload, ensure_ascii=False))
        return rows

    def test_01_type_advantage_switch(self):
        """① 克制换人：对位被克时，换人必须进合法动作且规划必须考虑它（候选/风险里能看到换人）。"""
        _public, state = open_public()
        mine = state.player.field_pet
        foe = state.enemy.field_pet
        mult_in = RS.type_chart.multiplier(RS.pet(mine.pet_id).types,
                                           RS.pet(foe.pet_id).types[0])
        switches = [a for a in legal(state, "player") if a.kind == "switch"]
        self.assertTrue(switches, "夹具必须给得出换人动作（否则这一类是空的）")
        result = plan(state)
        kinds = {row["action"]: row for row in result.robustness["candidates_ranked"]}
        switch_labels = {pm._label(RS, a) for a in switches}
        self.assertTrue(set(kinds) & switch_labels,
                        f"候选留痕里必须至少有换人这一手：{sorted(kinds)}")
        rows = self._report("type-advantage-switch", state, result,
                            rule_baseline(state, RS), {"matchup_multiplier": mult_in})
        self.assertTrue(rows and all("error" not in row for row in rows),
                        f"真实结算必须走得通：{rows}")

    def test_02_unknown_moveset_declares_assumption(self):
        """② 未知配招：对手后备身份/配招未知 ⇒ 回执必须**声明假设**（P3），且规划仍合法。"""
        public, state = open_public()
        self.assertTrue(public["assumptions"]["opponent_bench"], "公开面必须带假设声明")
        result = plan(state)
        self.assertIsNotNone(result.recommended, "未知配招也要给出可执行的一手")
        self.assertIn("满血", public["assumptions"]["note"])
        self.assertIn("规范配招", public["assumptions"]["note"])
        rows = self._report("unknown-moveset", state, result, rule_baseline(state, RS),
                            {"assumption": public["assumptions"]["opponent_bench"]})
        self.assertTrue(rows)

    def test_03_low_energy(self):
        """③ 低能量：场上能量 0 ⇒ 推荐那一手的**能耗必须为 0**（真实结算复核能耗）。"""
        _public, state = open_public(energy=0)
        result = plan(state)
        self.assertIsNotNone(result.recommended)
        action = result.recommended
        if action.kind == "skill" and action.skill_id:
            sk = RS.skills.get(action.skill_id)
            cost = int(getattr(sk, "cost", 0) or 0) if sk else 0
            self.assertEqual(cost, 0, f"能量 0 时不许推荐要花能量的技能：{result.recommended_label} cost={cost}")
        rows = self._report("low-energy", state, result, rule_baseline(state, RS))
        for row in rows:
            if "error" not in row:
                self.assertGreaterEqual(row["my_energy"], 0)

    def test_04_near_death_survival(self):
        """④ 濒死（**必做反例②同族**）：只要存在「对手怎么打都活着」的一手，推荐就必须是这种。"""
        _public, state = open_public(team=COUNTER_TEAM, enemy=COUNTER_TEAM, hp=1)
        result = plan(state)
        safe = [a for a in legal(state, "player") if survives_all(state, RS, a) is True]
        self.assertTrue(safe, "夹具里必须存在一条「怎么打都活着」的路（否则判据是空的）")
        self.assertIs(survives_all(state, RS, result.recommended), True,
                      f"推荐的这一手 {result.recommended_label} 会被对手某一手打死，而存在安全路 "
                      f"{[pm._label(RS, a) for a in safe]}")
        rows = self._report("near-death", state, result, rule_baseline(state, RS),
                            {"safe_actions": [pm._label(RS, a) for a in safe]})
        self.assertTrue(rows)

    def test_05_same_speed_is_seed_driven_not_claimed(self):
        """⑤ 同速：镜像阵容（同物种⇒同速）；同速裁决由 seed 驱动 ⇒ 跨种子**不许**假装唯一。"""
        public, state = open_public(team=COUNTER_TEAM, enemy=COUNTER_TEAM)
        svc = RocoService()
        svc.plan_clock = lambda: 0.0
        status, env = svc.battle_plan({"state_version": public.get("state_version"),
                                       "public": public, "depth": 2, "beam": 4,
                                       "budget_ms": 5000, "analysis_seeds": [11, 29, 47]})
        self.assertEqual(status, 200, env.get("error"))
        payload = env["result"]
        # 诚实性：要么跨种子一致（stable=true），要么如实给出区间与 by_seed（不许只报一个点）
        if payload["recommendation_stable"] is False:
            self.assertIsNone(payload["recommended_label"],
                              "跨种子不一致时不许给单一推荐")
            self.assertGreaterEqual(len(set(payload["recommended_by_seed"].values())), 2)
        self.assertIn("min", payload["expected"])
        self.assertIn("max", payload["expected"])
        result = plan(state)
        self._report("same-speed", state, result, rule_baseline(state, RS),
                     {"stable": payload["recommendation_stable"],
                      "by_seed": payload["recommended_by_seed"]})

    def test_06_seen_but_not_yet_on_field(self):
        """⑥ 未上场已见宠：开局预览亮明过 ⇒ 后备**带身份**（C-1 的正面例），规划仍合法。"""
        public, state = open_public(preview=True)
        bench = public["opponent"]["bench"]
        self.assertTrue(bench, "夹具必须有对手后备")
        revealed = public.get("revealed") or {}
        has_identity = any("pet_id" in row for row in bench) or bool(revealed)
        self.assertTrue(has_identity,
                        f"预览亮明过的后备必须能看出身份（C-1 正面例）：bench={bench} revealed={revealed}")
        result = plan(state)
        self.assertIsNotNone(result.recommended)
        rows = self._report("seen-not-yet-on-field", state, result, rule_baseline(state, RS),
                            {"bench_rows": bench})
        self.assertTrue(rows)

    def test_07_opponent_actually_switched(self):
        """⑦ 对手实际换人：真推进一回合（对手换人）⇒ 新场上身份必须进状态，规划仍合法。"""
        public, _state = open_public()
        svc = RocoService()
        begun = public  # 已开局
        # 用私有会话推进：直接构造 step（走 service 的 advance 需要 session；这里用引擎本体）
        state = renv.state_from_public_planner(begun, RS, analysis_seed=11)
        before = state.enemy.field_pet.pet_id
        opp_switch = [a for a in legal(state, "enemy") if a.kind == "switch"]
        self.assertTrue(opp_switch, "夹具里对手必须能换人")
        mine = [a for a in legal(state, "player")][0]
        nxt = renv.step_joint(clone(state), RS, mine, opp_switch[0])
        after = nxt.enemy.field_pet.pet_id
        self.assertNotEqual(before, after, "对手换人后场上身份必须变（否则这条判据是空的）")
        result = plan(nxt)
        self.assertIsNotNone(result.recommended)
        rows = self._report("opponent-actually-switched", nxt, result, rule_baseline(nxt, RS),
                            {"field_before": before, "field_after": after})
        self.assertTrue(rows)


class BaselineIndependenceTest(unittest.TestCase):
    """② 基线**独立于评分函数**：行为判据 —— 把 `pm.evaluate` 变成「一调用就抛」，基线照样跑。"""

    def test_baseline_survives_without_the_scoring_function(self):
        _public, state = open_public()
        original = pm.evaluate
        calls = {"n": 0}

        def forbidden(*_args, **_kwargs):
            calls["n"] += 1
            raise AssertionError("基线不许调用评分函数 planner.evaluate")

        pm.evaluate = forbidden
        try:
            action, why = rule_baseline(state, RS)
        finally:
            pm.evaluate = original
        self.assertEqual(calls["n"], 0, "基线一次都不许碰 evaluate")
        self.assertIsNotNone(action, "基线必须能给出动作")
        self.assertTrue(why)
        # 结构性反证：基线源码里不许出现那些名字（防止「以后偷偷接上」）
        import inspect
        source = inspect.getsource(rule_baseline)
        for forbidden_name in ("evaluate(", "plan_actions(", "one_ply_value(", "robust_sort_key("):
            self.assertNotIn(forbidden_name, source,
                             f"基线源码里不许出现 {forbidden_name}（基线必须独立于评分函数）")


class BaselineComparisonTest(unittest.TestCase):
    """③ 基线对照 + 真实结算：两类尺子在同一批场景上的读数**逐条打印**，差异必须能解释。"""

    def test_comparison_table_and_raw_outcomes(self):
        rows_out = []
        fixtures = [
            ("type-advantage-switch", open_public()),
            ("unknown-moveset", open_public()),
            ("low-energy", open_public(energy=0)),
            ("near-death", open_public(team=COUNTER_TEAM, enemy=COUNTER_TEAM, hp=1)),
            ("seen-not-yet-on-field", open_public(preview=True)),
        ]
        for name, (_public, state) in fixtures:
            result = plan(state)
            base_action, base_rule = rule_baseline(state, RS)
            rec_settle = settlement(state, RS, result.recommended)
            base_settle = settlement(state, RS, base_action) if base_action is not None else []
            row = {
                "scenario": name,
                "planner": {"action": result.recommended_label,
                            "survives_all": survives_all(state, RS, result.recommended),
                            "worst_my_hp": min((r["my_hp"] for r in rec_settle if "error" not in r),
                                               default=None)},
                "baseline": {"action": pm._label(RS, base_action) if base_action else None,
                             "rule": base_rule,
                             "survives_all": survives_all(state, RS, base_action)
                             if base_action is not None else None,
                             "worst_my_hp": min((r["my_hp"] for r in base_settle if "error" not in r),
                                                default=None)},
                "agree": (base_action is not None and base_action == result.recommended),
            }
            rows_out.append(row)
            print("  · [04.5 对照] " + json.dumps(row, ensure_ascii=False))
        # 每一条都要走通真实结算（不是空跑）
        self.assertEqual(len(rows_out), 5)
        for row in rows_out:
            self.assertIsNotNone(row["planner"]["action"], f"{row['scenario']} 必须有推荐")
            self.assertIsNotNone(row["baseline"]["action"], f"{row['scenario']} 基线必须有动作")
        # 「相近动作用不同尺子会分叉」是**允许**的；但两条都必须**合法且能结算**（上面已保证）。
        # 关键不许发生的事：规划器推荐的动作在真实结算里**连一次都活不过**而基线活得过。
        for row in rows_out:
            if row["planner"]["survives_all"] is False and row["baseline"]["survives_all"] is True:
                self.fail(f"{row['scenario']}：规划器推荐的动作会被打死，而基线那一手活得下来 "
                          f"（真实结算读数 {json.dumps(row, ensure_ascii=False)}）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
