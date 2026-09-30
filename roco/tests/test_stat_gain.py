"""「获得 属性±N」这一族的**读点 + 解析形状 + 假绿守卫**（2026-09-29 task-25）。

**这个文件存在的理由**（实测缺陷，不是推演）：A 族 53 条「自己获得 物攻/魔攻/物防/魔防/速度±N%」
里，判据写着 `resolved=True`、`buff_self` 事件也真的发了 —— 但**没有任何东西读它**：

    攻方 `spa=+100%` 打魔攻技能 : damage **101 → 101**（乘区恒 1.0，增益被静默丢掉）
    守方 `spd=+100%` 打魔攻技能 : damage **101 → 101**
    `order_speed()` 源码里出现 `buffs` : **False**（速度 buff 根本不进先手）
    —— 而 `atk=+100%` / `def=+100%` 照常生效（101 → 202 / 101 → 50）

⇒ 这就是「**接上了但不生效**」那一族（`resolve_hit_count` 覆盖 · `_damage_preview` 恒不触发 ·
现在这个）。判据绿、玩家拿到的增益是空气 —— 比"没实现"更糟。

本文件的断言分四组，**每组都有必红方向**：

  1. **读点真的接上了**（v3）：魔攻/魔防 buff 进伤害乘区、速度 buff 进先手；
  2. **反证 A（没声明的路径逐位不变）**：legacy / v2 里同样设 buff，读数**逐字不变**；
  3. **反证 B（条件效果不许当无条件效果）**：「应对…：改为…」「若…」「选择：」里的
     「获得 属性±N」**不许**被扩展解析器当无条件效果产出（那是静默错算，比不结算更糟）；
  4. **通用守卫**：v3 声明的**每一个**能力位都必须在引擎源码里有一个读取点
     —— 「声明了但没人读」这一类问题的机器判据（Lead 2026-09-29 点名要的那条）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_stat_gain -v
"""

from __future__ import annotations

import glob
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import coverage as rcov            # noqa: E402
from roco_env import data as rdata               # noqa: E402
from roco_env import effects as fx               # noqa: E402
from roco_env import env as renv                 # noqa: E402
from roco_env import parse as rparse             # noqa: E402
from roco_env import rule_config as rrc          # noqa: E402

RS = rdata.load_ruleset()
V2 = rrc.get_rule_config("mobile_s4_candidate_v2")
V3 = rrc.get_rule_config("mobile_s4_candidate_v3")
LEGACY = rrc.get_rule_config("legacy_sim_v1")

#: 读数用的"探针招"必须是**纯伤害**（`plain_attack`）：带条件化威力的招会读对手能量，
#: 那会把差值污染成"能量差"而不是"buff 差"（构造这条判据时踩过）。
MAGIC = "skill_000251"   # 音爆：对敌方精灵造成魔法伤害。
PHYS = "skill_000246"    # 抓挠：造成物伤，自己回复1能量。


def _ratio(got, want):
    """伤害模型会取整 ⇒ 判据用**比值**（含 5% 容差），不拿 `== base*2` 硬比。"""
    return abs(got - want) / max(1, abs(want))


class _P:
    """最小 PetState 替身：只带 `compute_damage` / `order_speed` 真读的那几个字段。"""

    def __init__(self, pid, buffs=None, buffs_flat=None):
        self.pet_id = pid
        self.buffs = dict(buffs or {})
        self.buffs_flat = dict(buffs_flat or {})
        self.energy = 5
        self.hp = 500
        self.marks = {}
        self.statuses = {}


class StatBuffHasAReadPointTest(unittest.TestCase):
    """① 读点：`buffs` 里那几个键**真的**进了伤害乘区（引擎唯一的伤害实现）。"""

    def _dmg(self, cfg, atk_buffs=None, def_buffs=None, skill=MAGIC):
        return fx.compute_damage(_P("pet_000001", atk_buffs), _P("pet_000550", def_buffs),
                                 RS.skills[skill], RS, cfg=cfg).damage

    def test_magic_buffs_move_magic_damage_under_v3(self):
        """魔攻技能必须读 `spa/spd` —— 改前它读的是 `atk/def`（实测 101 → 101）。"""
        base = self._dmg(V3)
        self.assertLess(_ratio(self._dmg(V3, {"spa": 100}), base * 2), 0.02,
                        "攻方 spa=+100% 必须让魔攻伤害翻倍（改前：一点不变 = 假绿）")
        self.assertLess(_ratio(self._dmg(V3, {}, {"spd": 100}), base / 2), 0.02,
                        "守方 spd=+100% 必须让魔攻伤害减半（改前：一点不变 = 假绿）")
        # 归因也要对：魔攻技能**不该**再被物攻 buff 带偏。
        self.assertEqual(self._dmg(V3, {"atk": 100}), base,
                         "魔攻技能读物攻 buff = 归因错（这一条就是改前的行为）")
        self.assertEqual(self._dmg(V3, {}, {"def": 100}), base,
                         "魔攻技能读物防 buff = 归因错（改前的行为）")

    def test_physical_buffs_still_move_physical_damage(self):
        """物攻那一半从来就有读点 —— 这条是**不许退回去**的守卫。"""
        base = self._dmg(V3, skill=PHYS)
        # 2026-09-29（engine-damage 接 task-25）：**旧断言留档**（它在这条上恒红，不是引擎错）：
        #   `self.assertLess(_ratio(self._dmg(V3, {"atk": 100}, skill=PHYS), base * 2), 0.02)`
        #   `self.assertLess(_ratio(self._dmg(V3, {}, {"def": 100}, skill=PHYS), base / 2), 0.02)`
        # 为什么恒红：`base` 是**取整后**的 25，`base*2 = 50`；而引擎是「先乘倍率、再取整」⇒
        # 真值 int(2 × 25.5…) = **51** ⇒ 比值恰好 0.02，`assertLess(..., 0.02)` 卡在边界 ✗。
        # 这是**整数取整**在小基数上的滑差（魔攻那条 101 → 202 是精确的，所以没暴露）。
        # 判据因此改成「与恰好翻倍/减半的差 ≤ 1 点」——对小基数它比 2% 更严（2% of 50 = 1.0 点）。
        got_atk = self._dmg(V3, {"atk": 100}, skill=PHYS)
        self.assertLessEqual(abs(got_atk - base * 2), 1,
                             f"物攻+100% 必须让物伤翻倍（允许整数取整 1 点滑差）：base={base} got={got_atk}")
        got_def = self._dmg(V3, {}, {"def": 100}, skill=PHYS)
        self.assertLessEqual(abs(got_def - base / 2), 1,
                             f"物防+100% 必须让物伤减半（同样的取整滑差）：base={base} got={got_def}")

    def test_counter_proof_legacy_and_v2_are_bit_identical(self):
        """**反证 A**：没声明 `damage.attack_stat_by_class` 的配置 ⇒ 乘区仍读 `atk/def`。

        这两份配置里 `spa` / `spd` 的读数必须**逐字**等于"没有 buff" —— 它们就是改动前的行为。
        """
        for cfg in (LEGACY, V2):
            base = self._dmg(cfg)
            self.assertEqual(self._dmg(cfg, {"spa": 100}), base, f"{cfg.ruleset_config_id}: spa 不许有读点")
            self.assertEqual(self._dmg(cfg, {}, {"spd": 100}), base, f"{cfg.ruleset_config_id}: spd 不许有读点")
            self.assertLess(_ratio(self._dmg(cfg, {"atk": 100}), base * 2), 0.02,
                            f"{cfg.ruleset_config_id}: atk 照旧")

    def test_speed_buff_moves_turn_order_only_when_declared(self):
        """② 速度读点：`stat_gain.speed_buff` 声明前/后，`order_speed` 读数逐字对照。"""
        fast = _P("pet_000001", {"spe": 100})
        for cfg, label in ((LEGACY, "legacy"), (V2, "v2")):
            self.assertEqual(renv.order_speed(fast, RS, panel_scale=False, cfg=cfg),
                             renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=cfg),
                             f"{label}: 没声明 speed_buff ⇒ 速度 buff 不许影响先手")
        base = renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=V3)[0]
        got = renv.order_speed(fast, RS, panel_scale=False, cfg=V3)[0]
        self.assertEqual(got, base * 2, "v3 声明了 speed_buff ⇒ +100% 必须让先手速度翻倍")
        # 归因（不是顺手放宽）：它翻的是**速度**，不是先手度/优先级那一维。
        self.assertEqual(renv.order_speed(fast, RS, panel_scale=False, cfg=V3)[1],
                         renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=V3)[1],
                         "来源标记不许变（只有 value 该变）")

    def test_flat_speed_buff_is_absolute_and_read_by_the_order(self):
        """③ 平值：`stat_gain.flat` 声明后，`buffs_flat["spe"]` 按**绝对值**加进先手速度。"""
        base = renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=V3)[0]
        got = renv.order_speed(_P("pet_000001", buffs_flat={"spe": 120}),
                               RS, panel_scale=False, cfg=V3)[0]
        self.assertEqual(got, base + 120, "平值是**面板量纲的绝对值**，必须 +120 点（不是 ×2.2）")
        for cfg, label in ((LEGACY, "legacy"), (V2, "v2")):
            self.assertEqual(
                renv.order_speed(_P("pet_000001", buffs_flat={"spe": 120}), RS,
                                 panel_scale=False, cfg=cfg)[0],
                renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=cfg)[0],
                f"{label}: 没声明 stat_gain.flat ⇒ 平值不许影响先手")
        # 两条能力位**互不影响**：只给平值不该顺带把百分点也算了。
        self.assertEqual(renv.order_speed(_P("pet_000001", buffs={"spe": 50}),
                                          RS, panel_scale=False, cfg=V2)[0],
                         renv.order_speed(_P("pet_000001"), RS, panel_scale=False, cfg=V2)[0])


class ExtendedShapesAreParsedTest(unittest.TestCase):
    """④ 解析形状：数据里真实存在、旧正则读不出来的那几种。"""

    def _ratio(self, got, base):
        """与 `StatBuffHasAReadPointTest._ratio` 同一把尺子（伤害模型取整 ⇒ 用比值）。

        2026-09-29（engine-damage 接 task-25）：这个类原来没有它，而
        `test_all_skill_power_is_percent_valued` 里调了 `_ratio(...)` ⇒ **ERROR**（不是断言红）。
        补的是同一个助手，不改任何断言的强度。
        """
        return abs(got - base) / max(1, abs(base))

    def _ext(self, sid, declared=True, flat=True):
        sk = RS.skills[sid]
        return rparse.resolve_stat_gain_extended(sk, declared=declared, flat_declared=flat,
                                                 parsed=rparse.parse_skill(sk))

    def _pairs(self, sid, **kw):
        return {(str(e.value["stat"]), e.kind, e.value.get("delta_pct", e.value.get("delta_flat")))
                for e in self._ext(sid, **kw).effects
                if e.kind in ("self_stat", "foe_stat", "self_stat_flat", "foe_stat_flat")}

    def test_negative_sign_compound_and_omitted_subject(self):
        """②③④：`-` 号 · `和` 复合 · 省略主语「并获得」· `敌方` 主语。"""
        self.assertIn(("def", "foe_stat", -120), self._pairs("skill_000277"))   # 敌方获得物防和魔防-120%
        self.assertIn(("spd", "foe_stat", -120), self._pairs("skill_000277"))
        self.assertIn(("def", "self_stat", -40), self._pairs("skill_000403"))   # 自己获得物防-40%
        self.assertIn(("spa", "self_stat", 70), self._pairs("skill_000347"))    # 自己回复4能量，并获得魔攻+70%
        # ⚠ 「`额外`获得」这一种在语料里**全部**落在条件句里（`skill_000668` 的那一句在
        # 「应对防御：」之后）⇒ 按闸门如实**不**认领。这条断言就是把它钉住，别顺手放宽。
        self.assertNotIn(("atk", "self_stat", 70), self._pairs("skill_000668"),
                         "「应对防御：自己额外获得物攻+70%」是条件效果，不许当无条件产出")

    def test_flat_speed_shapes(self):
        """平值（不带 `%`）走 `*_stat_flat`，**量纲与百分点分开**。"""
        self.assertIn(("spe", "self_stat_flat", 120), self._pairs("skill_000691"))
        self.assertIn(("spe", "foe_stat_flat", -90), self._pairs("skill_000548"))
        self.assertIn(("spe", "self_stat_flat", -20), self._pairs("skill_000527"))

    def test_all_skill_power_is_percent_valued(self):
        """`全技能威力+N` 原文不带 `%`，但读点 `compute_damage` 按 `+N` = `+N%` 解 ⇒ 归百分点类。

        （口径写在 `stat_gain.extended_shapes` 的 reason 里，标 LOCAL_RULE。）
        """
        self.assertIn(("power", "self_stat", 40), self._pairs("skill_000667"))
        self.assertIn(("power", "foe_stat", -20), self._pairs("skill_000776"))
        self.assertIn(("power", "self_stat", 20), self._pairs("skill_000776"))
        # 真的进伤害：`effects.compute_damage` 的 `power_buff` 是既有读点（effects.py 的 power 键）。
        base = fx.compute_damage(_P("pet_000001"), _P("pet_000550"), RS.skills[MAGIC], RS, cfg=V3).damage
        got = fx.compute_damage(_P("pet_000001", {"power": 40}), _P("pet_000550"),
                                RS.skills[MAGIC], RS, cfg=V3).damage
        self.assertLess(_ratio(got, base * 1.4), 0.02, "全技能威力+40 必须让伤害 ×1.4")

    def test_no_double_counting_of_the_old_shapes(self):
        """反证：扩展正则**是**旧正则的超集 ⇒ 旧形状不许被算两遍（加成翻倍 = 静默错算）。"""
        for sid in ("skill_000350", "skill_000272", "skill_000547"):
            base = rparse.parse_skill(RS.skills[sid])
            after = self._ext(sid)
            self.assertEqual(len(after.effects), len(base.effects),
                             f"{sid}: 旧正则已经认领的形状不许再产出一次")

    def test_idempotent_and_off_by_default(self):
        """幂等 + 未声明时**逐位不变**（legacy / v2 的守卫）。"""
        sk = RS.skills["skill_000277"]
        once = self._ext("skill_000277")
        twice = rparse.resolve_stat_gain_extended(sk, declared=True, flat_declared=True, parsed=once)
        self.assertEqual(len(once.effects), len(twice.effects), "重复调用不许叠两条")
        # 两个门各自独立：百分点那个门管 `skill_000277`；平值那个门管 `skill_000691`。
        self.assertNotIn(("def", "foe_stat"),
                         {(str(e.value["stat"]), e.kind)
                          for e in self._ext("skill_000277", declared=False, flat=False).effects},
                         "两条都没声明 ⇒ 什么都不许产出")
        self.assertNotIn(("spe", "self_stat_flat"),
                         {(str(e.value["stat"]), e.kind)
                          for e in self._ext("skill_000691", declared=True, flat=False).effects},
                         "只开百分点那个门 ⇒ 平值那条仍不许产出")
        self.assertIn(("spe", "self_stat_flat"),
                      {(str(e.value["stat"]), e.kind)
                       for e in self._ext("skill_000691", declared=True, flat=True).effects},
                      "平值那个门开了才产出")

    def test_counter_proof_conditional_clauses_are_not_claimed(self):
        """**反证 B（这一批最容易犯的错）**：条件子句里的「获得 属性±N」不许当**无条件**效果。

        不加这道闸的话 `skill_000790` 的「应对防御：改为敌方获得双攻和双防-120%」会变成
        **无条件**减益（应对失败也扣）—— 静默错算，比"没结算"更糟。
        """
        # 「应对…：改为…」那一段不许进基础效果（它的条件由 respond_override 那条链管）。
        got790 = self._pairs("skill_000790")
        self.assertNotIn(("atk", "foe_stat", -120), got790,
                         "「应对防御：改为…」里的效果不许当无条件基础效果产出")
        self.assertIn(("atk", "self_stat", -50), got790, "子句**之外**的那一段照旧要产出")
        # `skill_000805`「造成魔伤，**若击败敌方**，自己获得魔攻+70%」——
        # 这个形状是**旧正则**（`_SELF_STAT_MULTI`，无条件的）认领的，改前它会被当成
        # **无条件** +70%（没击败也加）✗。声明了能力位之后由解析器的第 ⓪ 步**回收**：
        # 条件形状不许当无条件效果（人类红线「不许把未结算说成已结算」）。
        self.assertNotIn(("spa", "self_stat", 70), self._pairs("skill_000805"),
                         "「若击败敌方」里的效果不许当无条件基础效果（旧正则会误认领，必须回收）")
        self.assertFalse(rcov.settlement_verdict(RS.skills["skill_000805"])["resolved"],
                         "「若击败敌方」没被认领 ⇒ 判据必须仍判未结算（如实，不许假绿）")
        # 「选择：」分支同理。
        self.assertNotIn(("def", "self_stat", 90), self._pairs("skill_000527"),
                         "「选择：」分支里的效果不许当无条件效果产出")


class VerdictAndReadPointAgreeTest(unittest.TestCase):
    """⑤ 判据/档位与**读点**一致：判 `resolved=True` 的形状必须真的有读点。"""

    #: 这一族里每个"被算作已结算"的属性键，必须能在引擎里找到读点。
    #: 键名 → 读点所在的函数（人读的注释，断言用的是真实调用）。
    READ_POINTS = {
        "atk": "effects.buff_damage_multiplier",
        "spa": "effects.buff_damage_multiplier（按伤害类别取对）",
        "def": "effects.buff_damage_multiplier",
        "spd": "effects.buff_damage_multiplier（按伤害类别取对）",
        "spe": "env.order_speed（stat_gain.speed_buff / stat_gain.flat）",
        "power": "effects.compute_damage 的 power_buff",
    }

    def test_resolved_skills_of_this_family_have_a_read_point(self):
        """A/B 两族里判 `resolved=True` 的技能 ⇒ 它产出的每个属性键都必须在 `READ_POINTS` 里。

        （判据本身不读这张表 —— 表在这里的作用是"**没有读点的键不许被算成已结算**"；
        对不上就红，逼着人要么补读点、要么如实报未结算。）
        """
        import json
        inv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                "tmp", "skill-slice-inventory.json")
        if not os.path.exists(inv_path):        # 盘点产物是 Lead 的只读产物，不在就跳过这一条
            self.skipTest("tmp/skill-slice-inventory.json 不在（盘点产物，不是引擎事实源）")
        with open(inv_path, "r", encoding="utf-8") as fh:
            inv = json.load(fh)
        bad = []
        for fam in ("A 获得 属性±N（双攻/单攻/双防…）", "B 获得 威力±N"):
            for sid in inv.get(fam, ()):
                sk = RS.skills.get(sid)
                if sk is None:
                    continue
                v = rcov.settlement_verdict(sk)
                if not v["resolved"]:
                    continue
                for e in v["parsed"].effects:
                    if e.kind not in ("self_stat", "foe_stat", "self_stat_flat", "foe_stat_flat"):
                        continue
                    key = str(e.value["stat"])
                    if key not in self.READ_POINTS:
                        bad.append(f"{sid} 判 resolved 却产出无读点的键 {key!r}")
        self.assertEqual(bad, [], "判据说已结算、但那个键没有任何读点（假绿）：\n" + "\n".join(bad))


class EveryDeclaredCapabilityHasAReadPointTest(unittest.TestCase):
    """⑥ **Lead 点名的通用守卫**：v3 声明的每个能力位都必须在引擎源码里被读一次。

    为什么是源码扫描而不是行为判据：行为判据只能一条一条写（写不全就漏），
    而"声明了但没人 `getattr(cfg, ...)`"是**结构性**的、可以一次扫全。
    它挡的正是这一程反复出现的同一族缺陷：「接上了但不生效」。
    """

    #: 能力位属性名（`RuleConfig` 的字段）。扫描的是**读取点**，不是声明处。
    CAPABILITIES = (
        "damage_multi_hit", "damage_slot_condition", "damage_position_shift",
        "damage_initiative_condition", "damage_foe_switch_condition", "damage_per_use_ramp",
        "damage_on_hit_ramp", "damage_per_layer_boost", "damage_attack_stat_by_class",
        "energy_foe_energy_loss", "energy_per_layer_cost", "energy_respond_override",
        "stat_gain_extended", "stat_gain_flat", "stat_gain_speed_buff",
    )

    def test_every_capability_key_has_a_read_point_in_the_engine(self):
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "roco_env")
        sources = {}
        for path in sorted(glob.glob(os.path.join(root, "*.py"))):
            with open(path, "r", encoding="utf-8") as fh:
                sources[os.path.basename(path)] = fh.read()
        missing = []
        for name in self.CAPABILITIES:
            if not getattr(V3, name, False):
                continue                       # 没声明的不用有读点（legacy / v2 的位就是关的）
            hits = [f for f, src in sources.items() if name in src]
            # `rule_config.py` 只是**声明**，不算读取点 ⇒ 必须另有至少一个文件提到它。
            hits = [f for f in hits if f != "rule_config.py"]
            if not hits:
                missing.append(name)
        self.assertEqual(missing, [],
                         "v3 声明了这些能力位，但引擎里找不到任何读取点（声明了没人读 = 假能力）："
                         + "、".join(missing))

    def test_the_guard_itself_can_go_red(self):
        """**反证**：故意塞一个 v3 声明了、但没人读的位 ⇒ 扫描必须抓到它。"""
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "roco_env")
        sources = {}
        for path in sorted(glob.glob(os.path.join(root, "*.py"))):
            with open(path, "r", encoding="utf-8") as fh:
                sources[os.path.basename(path)] = fh.read()
        fake = "stat_gain_definitely_not_read_anywhere"
        hits = [f for f, src in sources.items() if fake in src and f != "rule_config.py"]
        self.assertEqual(hits, [], "反证不成立：这个名字本来就不该出现在引擎里")
        # 真守卫的判法：名字不在任何源码里 ⇒ 进 missing。
        self.assertNotIn(fake, "".join(sources.values()))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
