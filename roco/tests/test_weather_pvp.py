"""天气进标准 PVP（2026-09-25 人类裁决「那你就做！」）。

依据是**官方一手**：腾讯新闻·官方号《洛个明白》闪耀大赛入门篇（2026-04-14）在整篇讲闪耀大赛的
语境下专设「07 对战基础：印记与天气效果」一节，逐字：

  - 「天气是常驻在全场的效果，让对战双方都能获得相应的加成，但天气只能存在一种。」
  - 雨天「水系环境，天气为雨天时，双方水系技能威力提升50%。」（**更早版本**；仓内 S4 术语表 3008 是 +75%）
  - 沙暴「地系环境，天气为沙暴时，双方地系技能能耗减半。」
  - 暴风雪「冰系环境，天气为暴风雪时，双方每回合结束时获得两层冻结（冰系精灵免疫此效果）。」
  - 「场上的天气效果还将受到回合数的限制…对局战报查看当前天气的剩余回合数！」

取值口径：**数值以当前规则集（S4 术语表 terms.json）为准** ⇒ 雨天 +75%（`+50%` 作为更早版本
逐字留在台账 `EV-WEATHER-STANDARD-PVP` 的 notes 里）。效果与数值**全部从规则配置读**
（`policies.weather_policy`，生成器从 `data/roco/battle-modes.json` 照抄），引擎里没有写死的天气数值。

七组判据，每组都有**必红方向**：
  ① 四种天气各自的结算：雨天威力 / 沙暴能耗 / 暴风雪 2 层冻结 / 雷鸣 1 层引电；
  ② **只存在一种**：新天气替换旧天气（官方原话），不叠加；
  ③ **8 回合递减**：每回合末 -1，归零即清除；
  ④ 免疫：冰系不吃暴风雪的冻结、电系不吃雷鸣的引电；
  ⑤ **fail closed**：规则集没声明天气层 / 没声明这一种天气 ⇒ 技能里的「将天气改为…」
     只登记 unsupported，**不改天气**，回合末也不结算（legacy / v2 逐位不变）；
  ⑥ 引擎回执里读得出「当前天气 + 剩余回合数」（serialize / 公开面 / UI 面三处一致）；
  ⑦ **必红反证**：把天气效果短路（`set_weather` 变 no-op / 威力系数恒 1.0）⇒ 同一批判据必须红。

运行：cd roco && PYTHONPATH=src python3 -m unittest tests.test_weather_pvp -v
（`npm run test:env` 会自动发现它）
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import data as rdata       # noqa: E402
from roco_env import effects as fx       # noqa: E402
from roco_env import env as renv         # noqa: E402
from roco_env import rule_config as rc   # noqa: E402
from roco_env.schema import ACTION_SKILL  # noqa: E402

RS = rdata.load_ruleset()
V3 = "mobile_s4_candidate_v3"

#: 标准 PVP 是**六宠**（v3 的 `battle_mode.team_size = 6`）。同速平手裁决未核验（MC-E05），
#: 所以夹具显式覆盖成已登记的工程权宜（与 test_mana_actions 同一套做法）。
OVERRIDES = [{
    "path": "turn_order.speed_tie", "value": "random_seeded",
    "confidence": "ENGINE_HYPOTHESIS", "reason": "同速平手裁决未核验（MC-E05），按已登记的工程权宜走",
    "microcase_id": "MC-E05",
}]

#: 四条造天气技能（冻结快照里的 skill_id；描述逐字「将天气改为X，持续8回合。」）。
SKILL_RAIN = "skill_000427"      # 落雨 → 雨天（水系）
SKILL_SAND = "skill_000507"      # 沙涌 → 沙暴（地系）
SKILL_BLIZZARD = "skill_000555"  # 冬至 → 暴风雪（冰系）
SKILL_THUNDER = "skill_000605"   # 惊雷 → 雷鸣（电系）

#: 我方：0=圆号鱼（水系，会落雨）/ 1=记忆石（地系，会沙涌）/ 2=雪影娃娃（冰系萌系，会冬至）/
#: 3=闪电环（电系，会惊雷）/ 4=深蓝鲸（水系）/ 5=水蓝蓝（水系，有 0 费水系技能）。
TEAM_A = ["pet_000417", "pet_000046", "pet_000112", "pet_000172", "pet_000308", "pet_000002"]
#: 对手：0=仪式巨像（地系幻系）/ 1=丢丢（草系冰系，**冰系**用于免疫判据）/
#: 2=霹雳宝宝（电系，**电系**用于免疫判据）/ 3=雷神之子（电系）/ 4=智辉章脑（光系水系）/ 5=棋契陛下（武系地系）。
TEAM_B = ["pet_000100", "pet_000240", "pet_000285", "pet_000287", "pet_000613", "pet_000575"]

LOADOUTS = {
    # 每只都配「造天气技能 + 几个能学的攻击技能」（配招必须真在 freeze 学习表里）。
    "pet_000417": [SKILL_RAIN, "skill_000419", "skill_000421", "skill_000305"],
    "pet_000046": [SKILL_SAND, "skill_000497", "skill_000498", "skill_000502"],
    "pet_000112": [SKILL_BLIZZARD, "skill_000306", "skill_000316", "skill_000458"],
    "pet_000172": [SKILL_THUNDER, "skill_000434", "skill_000497", "skill_000259"],
    "pet_000308": ["skill_000419", "skill_000420", "skill_000421", "skill_000265"],
    "pet_000002": ["skill_000418", "skill_000420", "skill_000421", "skill_000303"],
    "pet_000100": [SKILL_SAND, "skill_000306", "skill_000458", "skill_000498"],
    "pet_000240": [SKILL_BLIZZARD, "skill_000247", "skill_000256", "skill_000266"],
    "pet_000285": [SKILL_THUNDER, "skill_000580", "skill_000581", "skill_000585"],
    "pet_000287": [SKILL_THUNDER, "skill_000580", "skill_000581", "skill_000585"],
    "pet_000613": [SKILL_RAIN, "skill_000358", "skill_000418", "skill_000420"],
    "pet_000575": [SKILL_SAND, "skill_000247", "skill_000249", "skill_000250"],
}

#: 冻结快照里的造天气技能描述（判据自己读一份，不靠引擎转述）。
WEATHER_SKILL_EXPECTED = {
    SKILL_RAIN: "雨天", SKILL_SAND: "沙暴", SKILL_BLIZZARD: "暴风雪", SKILL_THUNDER: "雷鸣",
}


def _cfg(config_id: str = V3) -> rc.RuleConfig:
    rc.clear_cache()
    return rc.load_config(config_id)


def new_state(config_id: str = V3, *, overrides=None):
    """标准 PVP 六宠开局（默认 v3；传 legacy 用于 fail-closed 判据）。"""
    cfg = _cfg(config_id)
    over = OVERRIDES if overrides is None else overrides
    team_size = cfg.require_team_size()
    if team_size == 3:
        team_a, team_b = TEAM_A[:3], TEAM_B[:3]
    else:
        team_a, team_b = TEAM_A, TEAM_B
    if team_size == 3:
        loadouts = {pid: LOADOUTS[pid] for pid in list(team_a) + list(team_b) if pid in LOADOUTS}
    else:
        loadouts = LOADOUTS
    return renv.reset(team_a, team_b, seed=3, rs=RS, config=cfg,
                      unverified_overrides=over, loadouts=loadouts)


def action_for(state, side: str, skill_id: str):
    for a in renv.legal_actions(state, RS, side):
        if a.kind == ACTION_SKILL and a.skill_id == skill_id:
            return a
    raise AssertionError(f"{side} 这一手拿不到 {skill_id}（合法动作："
                         f"{[a.skill_id for a in renv.legal_actions(state, RS, side) if a.kind == ACTION_SKILL]}）")


def enemy_idle(state):
    """对手那一手：优先出攻击技能（不改变天气），没有就第一手合法动作。"""
    acts = renv.legal_actions(state, RS, "enemy")
    for a in acts:
        if a.kind == ACTION_SKILL and RS.skill(a.skill_id).is_attack:
            return a
    return acts[0]


#: 每条造天气技能由**哪一只**（队伍里的下标）持有 —— 判据要开天气就先把它换上场。
WEATHER_OWNER = {SKILL_RAIN: 0, SKILL_SAND: 1, SKILL_BLIZZARD: 2, SKILL_THUNDER: 3}


def cast_weather(state, side: str, skill_id: str, *, active: int | None = None):
    """把持有这条造天气技能的那只换上场，出一手，并让对手出一手普通攻击（一个完整回合）。"""
    cfg = rc.get_rule_config(state.ruleset_config_id)
    idx = WEATHER_OWNER[skill_id] if active is None else active
    getattr(state, side).active = idx
    me = getattr(state, side).field_pet
    me.energy = max(me.energy, cfg.energy_max)      # 能量不是本判据的主题
    mine = action_for(state, side, skill_id)
    theirs = enemy_idle(state)
    renv.step_joint(state, RS, mine if side == "player" else theirs,
                    theirs if side == "player" else mine)
    return state


class WeatherRuleDeclarationTest(unittest.TestCase):
    """配置层：天气**由配置声明**；legacy / v2 不声明（引擎因此 fail closed）。"""

    def test_only_the_candidate_declares_the_weather_layer(self):
        v3 = _cfg(V3)
        self.assertEqual(v3.battle_mode_id, "pvp-standard-six-pet")
        self.assertTrue(v3.weather_enabled, "v3 必须声明天气层")
        policy = v3.weather_policy
        self.assertEqual(policy["value"], "enabled")
        self.assertEqual(policy["evidence_id"], "EV-WEATHER-STANDARD-PVP")
        self.assertEqual(policy["confidence"], "OFFICIAL_CURRENT")
        self.assertEqual(policy["max_concurrent"], 1, "官方逐字「天气只能存在一种」")
        self.assertEqual(policy["duration_turns"], 8)
        self.assertEqual(policy["duration_source"], "skill_desc")
        effects = policy["effects"]
        self.assertEqual(sorted(effects), sorted(["暴风雪", "沙暴", "雷鸣", "雨天"]))
        # 数值口径 = 当前规则集（S4 术语表）：雨天 +75%（官方 4/14 的 +50% 是更早版本，登记在台账里）。
        self.assertEqual(effects["雨天"]["value"], 1.75)
        self.assertEqual(effects["雨天"]["term_id"], "3008")
        self.assertEqual(effects["沙暴"]["value"], 0.5)
        self.assertEqual(effects["沙暴"]["term_id"], "3006")
        self.assertEqual((effects["暴风雪"]["status"], effects["暴风雪"]["layers"],
                          effects["暴风雪"]["immune_element"]), ("冻结", 2, "冰系"))
        self.assertEqual((effects["雷鸣"]["status"], effects["雷鸣"]["layers"],
                          effects["雷鸣"]["immune_element"]), ("引电", 1, "电系"))
        # 两个数都真实存在过：+50% 必须在台账 notes 里逐字留着（改钉不删）。
        import json
        ledger_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "..", "..", "data", "roco", "evidence", "rule-evidence-ledger.json")
        with open(ledger_path, encoding="utf-8") as fh:
            ledger = json.load(fh)
        entry = next(e for e in ledger["entries"] if e["id"] == "EV-WEATHER-STANDARD-PVP")
        self.assertIn("提升50%", entry["notes"])
        self.assertIn("+75%", entry["notes"])
        self.assertIn("天气只能存在一种", json.dumps(entry["sources"], ensure_ascii=False))
        # 判据的牙：把速度平手覆盖塞进 legacy（它没有 UNKNOWN 可覆盖）必须抛错 ——
        # 证明「配置声明」这条路真的在起作用，不是摆设。
        with self.assertRaises(rc.RuleConfigError):
            new_state("legacy_sim_v1", overrides=OVERRIDES)

    def test_legacy_and_v2_do_not_declare_weather(self):
        for config_id in ("legacy_sim_v1", "mobile_s4_candidate_v2"):
            cfg = _cfg(config_id)
            self.assertFalse(cfg.weather_enabled, f"{config_id} 不该声明天气层")
            self.assertIsNone(cfg.weather_policy)
            with self.assertRaises(rc.RuleConfigError):
                cfg.require_weather_effect("雨天")


class RainPowerTest(unittest.TestCase):
    """①-雨天：**双方**的水系技能威力 +75%（术语 3008；官方 4/14 写 +50%，取值口径见台账）。"""

    def test_rain_boosts_water_skills_by_75_percent(self):
        state = new_state()
        cfg = rc.get_rule_config(state.ruleset_config_id)
        me, foe = state.player.field_pet, state.enemy.field_pet
        water = RS.skills["skill_000421"]      # 水炮：水系 / 110 威力
        other = RS.skills["skill_000305"]      # 许愿星：普通系（对照组）
        self.assertEqual(water.element, "水系")
        base_water = fx.compute_damage(me, foe, water, RS, cfg=cfg, weather=None)
        base_other = fx.compute_damage(me, foe, other, RS, cfg=cfg, weather=None)
        self.assertEqual(base_water.weather_multiplier, 1.0)
        state.weather = {"name": "雨天", "turns_left": 8, "duration_turns": 8,
                         "set_turn": 1, "set_by": "player", "source_skill_id": SKILL_RAIN}
        wet_water = fx.compute_damage(me, foe, water, RS, cfg=cfg, weather=state.weather)
        wet_other = fx.compute_damage(me, foe, other, RS, cfg=cfg, weather=state.weather)
        print(f"\n[实际] 雨天：水炮 {base_water.damage} → {wet_water.damage}"
              f"（系数 {wet_water.weather_multiplier}，{wet_water.weather_note}）；"
              f"普通系 {base_other.damage} → {wet_other.damage}（系数 {wet_other.weather_multiplier}）")
        self.assertEqual(wet_water.weather_multiplier, 1.75)
        self.assertAlmostEqual(wet_water.damage / base_water.damage, 1.75, delta=0.02,
                               msg="雨天应当把水系技能威力乘以 1.75")
        self.assertEqual(wet_other.damage, base_other.damage, "非水系技能不该被雨天加成")
        # 回合中出「落雨」之后，天气真的进状态（端到端，不只是手工塞字段）。
        state = new_state()
        cast_weather(state, "player", SKILL_RAIN)
        self.assertIsInstance(state.weather, dict)
        self.assertEqual(state.weather["name"], "雨天")
        self.assertEqual(state.weather["source_skill_id"], SKILL_RAIN)
        # **双方**都吃加成：对手用水系技能也 +75%（官方逐字「双方」）。
        enemy_water = fx.compute_damage(state.enemy.field_pet, state.player.field_pet, water, RS,
                                       cfg=rc.get_rule_config(state.ruleset_config_id),
                                       weather=state.weather)
        self.assertEqual(enemy_water.weather_multiplier, 1.75)


class SandCostTest(unittest.TestCase):
    """①-沙暴：**双方**的地系技能能耗减半（术语 3006）。"""

    def test_sand_halves_ground_skill_cost(self):
        state = new_state()
        cfg = rc.get_rule_config(state.ruleset_config_id)
        pet = state.player.pets[1]                      # 记忆石（地系）
        ground = RS.skills["skill_000498"]              # 跺地：地系 / 2 能耗
        plain = RS.skills["skill_000309"]               # 践踏：普通系 / 4 能耗
        self.assertEqual((ground.element, ground.energy), ("地系", 2))
        before_ground = renv.effective_skill_cost(pet, ground, cfg, weather=None)
        before_plain = renv.effective_skill_cost(pet, plain, cfg, weather=None)
        weather = {"name": "沙暴", "turns_left": 8}
        after_ground = renv.effective_skill_cost(pet, ground, cfg, weather=weather)
        after_plain = renv.effective_skill_cost(pet, plain, cfg, weather=weather)
        print(f"\n[实际] 沙暴：地系技能能耗 {before_ground} → {after_ground}；"
              f"普通系 {before_plain} → {after_plain}")
        self.assertEqual(before_ground, 2)
        self.assertEqual(after_ground, 1)
        self.assertEqual(after_plain, before_plain, "非地系技能不该被沙暴影响")
        # 端到端：出「沙涌」之后同一只精灵的地系技能真的便宜了。
        state = new_state()
        cast_weather(state, "player", SKILL_SAND)
        self.assertEqual(state.weather["name"], "沙暴")
        self.assertEqual(renv.effective_skill_cost(state.player.field_pet, ground,
                                                   rc.get_rule_config(state.ruleset_config_id),
                                                   weather=state.weather), 1)
        # 如实登记取整口径未核验：1 能耗的地系技能（扬沙）在下取整下变成 0。
        odd = RS.skills["skill_000497"]
        self.assertEqual(odd.energy, 1)
        odd_cost = renv.effective_skill_cost(pet, odd, cfg, weather=weather)
        print(f"[实际] 「能耗减半」遇奇数：{odd.name} 1 → {odd_cost}（下取整；口径未核验，见 unknowns）")
        self.assertEqual(odd_cost, 0)


class BlizzardAndThunderTest(unittest.TestCase):
    """①-暴风雪 / ①-雷鸣 + ④ 免疫：每回合末叠层，本系免疫。"""

    def _form(self, config_id=V3):
        state = new_state(config_id)
        return state, rc.get_rule_config(state.ruleset_config_id)

    def test_blizzard_gives_both_sides_two_freeze_layers(self):
        state, cfg = self._form()
        # 双方场上都换成**非冰系**（圆号鱼 水系 / 仪式巨像 地系幻系），
        # 这样「双方每回合结束获得2层冻结」这句原话能逐字验到。
        state.player.active = 0
        state.enemy.active = 0
        self.assertNotIn("冰系", RS.pets[state.player.field_pet.pet_id].types)
        self.assertNotIn("冰系", RS.pets[state.enemy.field_pet.pet_id].types)
        renv.set_weather(state, RS, "暴风雪", 8, side="player", skill_id=SKILL_BLIZZARD, cfg=cfg)
        renv._end_turn_weather(state, RS, cfg)
        info = state.player.field_pet.statuses.get("冻结")
        self.assertEqual(info["layers"], 2, f"我方应当拿到 2 层冻结，实际 {state.player.field_pet.statuses}")
        self.assertEqual(state.enemy.field_pet.statuses["冻结"]["layers"], 2, "**双方**都要拿到")
        kinds = [e.kind for e in state.events]
        self.assertIn("weather_status", kinds)
        # 第二回合再叠 2 层（官方：每回合结束都获得）。
        renv._end_turn_weather(state, RS, rc.get_rule_config(state.ruleset_config_id))
        self.assertEqual(state.player.field_pet.statuses["冻结"]["layers"], 4)
        # 冻结层数的**结算**（术语 1004）没有实现：引擎如实登记，不静默。
        renv._end_turn_status_tick(state, RS, state.player, state.player.field_pet, cfg)
        self.assertTrue(any("冻结" in str(u.get("what", "")) for u in state.unsupported),
                        f"未实现的冻结结算必须出现在 unsupported 里：{state.unsupported}")

    def test_ice_type_is_immune_to_blizzard(self):
        state, _cfg_v3 = self._form()
        # 开天气的就是冰系（雪影娃娃 冰系萌系）⇒ 它自己免疫；对手（仪式巨像 地系幻系）照常吃。
        state.enemy.active = 0
        cast_weather(state, "player", SKILL_BLIZZARD)
        self.assertIn("冰系", RS.pets[state.player.field_pet.pet_id].types)
        self.assertNotIn("冻结", state.player.field_pet.statuses,
                         "冰系精灵免疫暴风雪的冻结（术语 3007 逐字）")
        self.assertEqual(state.enemy.field_pet.statuses["冻结"]["layers"], 2, "对手不是冰系，照常获得")
        self.assertTrue(any(e.kind == "weather_immune" for e in state.events),
                        f"免疫必须留事件（否则看不出来为什么没叠层）：{[e.kind for e in state.events]}")

    def test_thunder_gives_one_shock_layer_and_electric_is_immune(self):
        state, _cfg_v3 = self._form()
        state.enemy.active = 0                                        # 仪式巨像（地系幻系）：不免疫
        cast_weather(state, "player", SKILL_THUNDER)
        self.assertIn("电系", RS.pets[state.player.field_pet.pet_id].types)
        self.assertNotIn("引电", state.player.field_pet.statuses,
                         "电系精灵免疫雷鸣的引电（术语 3021）——开天气的那只自己就是电系")
        self.assertEqual(state.enemy.field_pet.statuses["引电"]["layers"], 1, "对手不是电系，照常获得")
        # 第二回合再叠 1 层 ⇒ 对手满 2 层。
        # 引电满 2 层的**立即结算**（术语 3022）未实现：登记，不猜伤害、不静默扣层。
        renv._end_turn_weather(state, RS, rc.get_rule_config(state.ruleset_config_id))
        self.assertEqual(state.enemy.field_pet.statuses["引电"]["layers"], 2)
        self.assertNotIn("引电", state.player.field_pet.statuses, "电系那只始终免疫（两层也不吃）")
        self.assertTrue(any("引电" in str(u.get("what", "")) for u in state.unsupported),
                        f"引电 2 层的立即结算必须登记为未实现：{state.unsupported}")


class OneWeatherAtATimeTest(unittest.TestCase):
    """② 只能存在一种 + ③ 8 回合递减。"""

    def test_new_weather_replaces_the_old_one(self):
        state = new_state()
        cast_weather(state, "player", SKILL_RAIN)
        self.assertEqual(state.weather["name"], "雨天")
        first_turns = state.weather["turns_left"]
        # 同一方再开一种天气：替换，不叠加（官方逐字「但天气只能存在一种」）。
        state.player.active = 1                     # 换成记忆石（会「沙涌」）
        state.player.field_pet.energy = rc.get_rule_config(state.ruleset_config_id).energy_max
        mine = None
        for a in renv.legal_actions(state, RS, "player"):
            if a.kind == ACTION_SKILL and a.skill_id in (SKILL_SAND, SKILL_BLIZZARD, SKILL_THUNDER):
                mine = a
                break
        self.assertIsNotNone(mine, "换上来之后应当还能开出别的天气技能（配招里有）")
        renv.step_joint(state, RS, mine, enemy_idle(state))
        print(f"\n[实际] 替换：雨天（{first_turns} 回合）→ {state.weather['name']}")
        self.assertNotEqual(state.weather["name"], "雨天", "新天气必须替换旧天气")
        self.assertEqual(len(state.weather), len({"name", "turns_left", "duration_turns", "set_turn",
                                                  "set_by", "source_skill_id", "term_id"}),
                         f"天气状态只有一种，实际 {state.weather}")
        self.assertTrue(any(e.kind == "weather_set" and e.detail.get("replaced") == "雨天"
                            for e in state.events), "替换必须留痕（旧天气叫什么）")

    def test_weather_counts_down_and_expires_after_eight_turns(self):
        state = new_state()
        cfg = rc.get_rule_config(state.ruleset_config_id)
        self.assertEqual(cfg.weather_policy["duration_turns"], 8)
        cast_weather(state, "player", SKILL_RAIN)
        trace = [state.weather["turns_left"]]
        for _ in range(7):
            renv._end_turn_weather(state, RS, cfg)
            trace.append(None if state.weather is None else state.weather["turns_left"])
        print(f"\n[实际] 8 回合递减轨迹（含出场那一回合的回合末）：{trace}")
        self.assertEqual(trace, [7, 6, 5, 4, 3, 2, 1, None],
                         "天气应当在第 8 个回合末结束（回合数受限制，官方 4/14）")
        self.assertIsNone(state.weather)
        self.assertTrue(any(e.kind == "weather_end" for e in state.events))
        # 清零之后回合末什么都不做（不会把 None 当成一种天气）。
        renv._end_turn_weather(state, RS, cfg)
        self.assertIsNone(state.weather)


class FailClosedTest(unittest.TestCase):
    """⑤ 规则集没声明天气层 ⇒ 引擎**不发明**天气行为（legacy 的结算逐位不变）。"""

    def test_undeclared_config_registers_unsupported_instead_of_setting_weather(self):
        state = new_state("legacy_sim_v1", overrides=[])
        cfg = rc.get_rule_config(state.ruleset_config_id)
        self.assertFalse(cfg.weather_enabled)
        state.player.field_pet.energy = cfg.energy_max
        # legacy 的配招里没有落雨，这里直接用技能对象验证效果应用这一层。
        skill = RS.skills[SKILL_RAIN]
        parsed = __import__("roco_env.parse", fromlist=["parse"]).parse_skill(skill)
        weather_effects = [e for e in parsed.effects if e.kind == "weather"]
        self.assertEqual(len(weather_effects), 1, "解析器要能读出「将天气改为雨天」")
        self.assertEqual(weather_effects[0].value["weather"], "雨天")
        self.assertEqual(weather_effects[0].value["turns"], 8, "持续回合数也要从描述里读出来")
        applied = renv._apply_effect_batch(state, RS, "player", skill, parsed, cfg)
        self.assertIsNone(state.weather, "没声明天气层的配置**不许**被设上天气")
        self.assertEqual(applied, 0)
        self.assertTrue(any("天气" in str(u.get("what", "")) for u in state.unsupported),
                        f"必须如实登记为 unsupported：{state.unsupported}")
        # 回合末也不结算（没有天气，且不发明效果）。
        renv._end_turn_weather(state, RS, cfg)
        self.assertIsNone(state.weather)
        for pet in (state.player.field_pet, state.enemy.field_pet):
            self.assertEqual(pet.statuses, {}, "没声明天气层就不该凭空叠冻结/引电")

    def test_declared_layer_without_that_weather_is_unsupported(self):
        state = new_state()
        cfg = rc.get_rule_config(state.ruleset_config_id)
        self.assertTrue(cfg.weather_enabled)
        self.assertIsNone(cfg.weather_effect("晴天"), "配置里没有「晴天」这一种")
        with self.assertRaises(rc.RuleConfigError):
            cfg.require_weather_effect("晴天")
        ok = renv.set_weather(state, RS, "晴天", 8, side="player", skill_id=SKILL_RAIN, cfg=cfg)
        self.assertFalse(ok)
        self.assertIsNone(state.weather, "没声明的那种天气不许被设上")
        # 描述里读不到回合数时也 fail closed（不拿配置的默认值顶技能描述）。
        ok = renv.set_weather(state, RS, "雨天", None, side="player", skill_id=SKILL_RAIN, cfg=cfg)
        self.assertFalse(ok)
        self.assertIsNone(state.weather)

    def test_receipts_expose_weather_and_remaining_turns(self):
        """⑥ 引擎回执（序列化 / 公开面 / UI 面）都读得到当前天气与剩余回合数。"""
        state = new_state()
        serialized = renv.serialize(state)
        self.assertNotIn("weather", serialized, "没天气时序列化里**不出现**这个键（legacy 逐位不变）")
        cast_weather(state, "player", SKILL_RAIN)
        serialized = renv.serialize(state)
        public = renv.public_planner_state(state, RS, "player")
        ui = renv.ui_public_view(state, RS, "player")
        for label, block in (("serialize", serialized.get("weather")), ("public", public.get("weather")),
                             ("ui", ui.get("weather"))):
            self.assertIsInstance(block, dict, f"{label} 回执里必须读得到天气")
            self.assertEqual(block["name"], "雨天")
            self.assertIsInstance(block["turns_left"], int)
            self.assertGreater(block["turns_left"], 0)
        # 三处描述同一时刻的同一局：名字与剩余回合数必须逐字相同。
        self.assertEqual(serialized["weather"], public["weather"])
        self.assertEqual(public["weather"], ui["weather"])
        # 观察（隐藏信息边界）里也给：天气是公开事实（官方：「双方都能获得相应的加成」）。
        obs = renv.observe(state, RS, "player") if hasattr(renv, "observe") else None
        if obs is not None:
            self.assertEqual(obs["weather"]["name"], "雨天")
        # 回放：序列化 → 反序列化之后天气还在（否则存档一读天气就丢）。
        restored = renv.deserialize(serialized, RS,
                                    rc.get_rule_config(serialized["ruleset_config_id"]))
        self.assertEqual(restored.weather, serialized["weather"])


class PolicyReadPortTest(unittest.TestCase):
    """`query_rules{kind:"policy", name:"weather"}`：逐字回配置，不改口径、不补默认。

    为什么加这一条：`kind:"ruleset"` 只回 counts/files/capabilities，**不含** weather_policy
    ⇒ 教练答不了「雨天水系伤害加多少」（真机实测落到 state-in-packet）。这个读口是那条问句的
    唯一事实通道，所以它必须：① 值逐字等于配置；② 没声明的配置如实回 enabled=false（legacy 是合法状态）。
    """

    def _policy(self, config_id):
        from roco_env.service import RocoService
        service = RocoService()
        return service._answer_policy(RS, {"name": "weather", "ruleset_config_id": config_id}).result

    def test_values_are_verbatim_from_the_config(self):
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
        from roco_env import rule_config as rc
        row = self._policy("mobile_s4_candidate_v3")
        cfg = rc.get_rule_config("mobile_s4_candidate_v3")
        self.assertTrue(row["enabled"])
        self.assertEqual(row["ruleset_config_id"], "mobile_s4_candidate_v3")
        self.assertEqual(row["duration_turns"], cfg.weather_policy["duration_turns"])
        self.assertEqual(row["max_concurrent"], cfg.weather_policy["max_concurrent"])
        self.assertEqual(row["confidence"], cfg.weather_policy["confidence"])
        self.assertEqual(row["evidence_id"], cfg.weather_policy["evidence_id"])
        # 四种天气逐字相同（不是"差不多"）
        self.assertEqual(sorted(row["effects"]), sorted(cfg.weather_policy["effects"]))
        for name, spec in cfg.weather_policy["effects"].items():
            self.assertEqual(row["effects"][name], spec, f"{name} 的效果必须逐字来自配置")
        rain = row["effects"]["雨天"]
        self.assertEqual(rain["value"], 1.75)
        self.assertEqual(rain["term_id"], "3008")
        print(f"\n[实际] 雨天：{rain['text']}（value={rain['value']}，术语 {rain['term_id']}）")

    def test_legacy_config_declares_nothing_and_says_so(self):
        row = self._policy("legacy_sim_v1")
        self.assertFalse(row["enabled"])
        self.assertEqual(row["ruleset_config_id"], "legacy_sim_v1")
        self.assertIn("没有声明", row["note"])
        self.assertNotIn("effects", row, "没声明就不许带一份空的 effects 出来")

    def test_mode_id_resolves_the_bound_config_in_the_registry(self):
        """按**模式**问策略：配置由登记表解析，调用方不用知道配置 id。

        2026-09-25 实测缺口：营地那份上下文里没有 `ruleset_config_id`，教练只能让引擎用
        进程当前生效的 legacy 配置答 ⇒ 「这份配置没有声明天气层」。可玩家问的是游戏规则，
        那份口径登记在标准 PVP 模式绑定的配置里。这一条钉：报模式 ⇒ 引擎查登记表拿绑定，
        并且在回执里写明"这是照哪个模式选的"（不改任何数值）。
        """
        from roco_env.service import RocoService
        from roco_env import rule_config as rc
        service = RocoService()
        row = service._answer_policy(RS, {"name": "weather", "mode_id": "pvp-standard-six-pet"}).result
        bound = rc.bound_config_id_for_mode("pvp-standard-six-pet")
        self.assertEqual(row["ruleset_config_id"], bound)
        self.assertEqual(row["mode_id"], "pvp-standard-six-pet")
        self.assertEqual(row["ruleset_binding"], bound)
        # 值与「直接按配置问」逐字相同（同一个事实源，不许两条路各答一份）
        direct = service._answer_policy(RS, {"name": "weather", "ruleset_config_id": bound}).result
        self.assertEqual(row["effects"], direct["effects"])
        self.assertEqual(row["duration_turns"], direct["duration_turns"])
        print(f"\n[实际] 模式 pvp-standard-six-pet → 配置 {bound}；"
              f"雨天：{row['effects']['雨天']['text']}")

    def test_explicit_config_beats_mode_and_unknown_mode_is_refused(self):
        """两条边界：显式配置优先（不许被模式顶掉）；没登记的模式**不许猜**一份配置来答。"""
        from roco_env.service import RocoService
        service = RocoService()
        both = service._answer_policy(
            RS, {"name": "weather", "mode_id": "pvp-standard-six-pet", "ruleset_config_id": "legacy_sim_v1"}
        ).result
        self.assertEqual(both["ruleset_config_id"], "legacy_sim_v1", "显式给的配置优先")
        self.assertFalse(both["enabled"], "legacy 没声明天气层，这条口径不许被模式改掉")
        self.assertNotIn("mode_id", both, "没按模式解析就不该出现模式字段")
        bad = service._answer_policy(RS, {"name": "weather", "mode_id": "not-a-mode"})
        self.assertFalse(bad.result)
        self.assertIn("不在登记表", bad.error)
        empty = service._answer_policy(RS, {"name": "weather", "mode_id": ""})
        self.assertFalse(empty.result)

    def test_unknown_policy_name_is_refused(self):
        from roco_env.service import RocoService
        service = RocoService()
        answer = service._answer_policy(RS, {"name": "sunny"})
        self.assertFalse(answer.result)
        self.assertIn("未知的策略", answer.error)


class ReverseProofTest(unittest.TestCase):
    """⑦ 必红反证：把天气效果短路 ⇒ 同一批判据必须红。"""

    def test_short_circuiting_the_weather_layer_turns_the_checks_red(self):
        state = new_state()
        cfg = rc.get_rule_config(state.ruleset_config_id)
        water = RS.skills["skill_000421"]
        me, foe = state.player.field_pet, state.enemy.field_pet
        weather = {"name": "雨天", "turns_left": 8}

        # (a) 把「雨天威力系数」短路成 1.0：判据① 的 1.75 立刻不成立。
        real_power = fx.weather_power_multiplier

        def short_circuit(*_args, **_kwargs):
            return 1.0, ""

        with mock.patch.object(fx, "weather_power_multiplier", short_circuit):
            plain = fx.compute_damage(me, foe, water, RS, cfg=cfg, weather=weather)
            neutral = fx.compute_damage(me, foe, water, RS, cfg=cfg, weather=None)
            self.assertEqual(plain.damage, neutral.damage,
                             "短路之后雨天不再加成 —— 这正是判据① 会红的形态")
            self.assertNotEqual(plain.weather_multiplier, 1.75)
        boosted = fx.compute_damage(me, foe, water, RS, cfg=cfg, weather=weather)
        self.assertEqual(boosted.weather_multiplier, 1.75)
        self.assertGreater(boosted.damage, neutral.damage)

        # (b) 把「设天气」短路成 no-op：判据①②③ 依赖的 state.weather 一个都不会出现。
        with mock.patch.object(renv, "set_weather", lambda *a, **k: False):
            state = new_state()
            cast_weather(state, "player", SKILL_RAIN)
            self.assertIsNone(state.weather, "短路之后天气不该被设上")
            self.assertNotIn("weather", renv.serialize(state))
            self.assertTrue(any("天气" in str(u.get("what", "")) or "天气" in str(u.get("detail", ""))
                                for u in state.unsupported) or state.weather is None)
        state = new_state()
        cast_weather(state, "player", SKILL_RAIN)
        self.assertIsNotNone(state.weather, "真实现下天气必须被设上（反证的牙）")

        # (c) 把回合末结算短路：暴风雪不再叠冻结（判据①的层数断言会红）。
        with mock.patch.object(renv, "_end_turn_weather", lambda *a, **k: None):
            state = new_state()
            cast_weather(state, "player", SKILL_BLIZZARD)     # 开天气的是冰系（自己免疫）
            self.assertIsNone(state.enemy.field_pet.statuses.get("冻结"),
                              "短路之后对手也不该有冻结层数 —— 判据① 会红")
        state = new_state()
        cast_weather(state, "player", SKILL_BLIZZARD)
        self.assertEqual(state.enemy.field_pet.statuses["冻结"]["layers"], 2)


class ParserTest(unittest.TestCase):
    """解析层：四条造天气技能的「天气名 + 持续回合数」都要读得出来（数据驱动，不写死）。"""

    def test_four_weather_skills_are_parsed_from_their_frozen_descriptions(self):
        from roco_env import parse as parse_mod
        for skill_id, name in WEATHER_SKILL_EXPECTED.items():
            skill = RS.skills[skill_id]
            self.assertIn("持续8回合", skill.desc, f"{skill.name} 的描述里应当有回合数")
            parsed = parse_mod.parse_skill(skill)
            weathers = [e for e in parsed.effects if e.kind == "weather"]
            self.assertEqual([e.value["weather"] for e in weathers], [name], f"{skill.name} 的天气名")
            self.assertEqual([e.value["turns"] for e in weathers], [8], f"{skill.name} 的持续回合数")
            self.assertEqual(skill.element,
                             {"雨天": "水系", "沙暴": "地系", "暴风雪": "冰系", "雷鸣": "电系"}[name],
                             f"{skill.name} 的系别与天气对应（术语里逐字给了「X系环境」）")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
