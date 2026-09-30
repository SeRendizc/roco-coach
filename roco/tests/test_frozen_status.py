"""`冻结` 的两条**行为判据**（task-28 · 2026-09-30）。

## 为什么会有这个文件

`冻结` 是本会话**跨多轮的反假报证据**：11 条技能写「敌方获得 N 层冻结」，而
**术语 1004 逐字只有**「冻结5%生命，若当前生命低于冻结比例，则力竭。（冰系精灵免疫此效果）」——
**没写"层数"是干什么的**，而 11 条技能发的正是 **1~5 层** ✗。
⇒ 要"真做"就得**发明"每层 5%"还是"层数=回合数"** = **发明语义**（与 `267/679` 同型，人类裁决：不许发明）✗
⇒ 所以本族按 **(b) 如实收口**：**写入方不写、只登记**，判据如实说"未结算" ✓

⚠ **本文件钉的正是"别让它悄悄变成假绿"** ✓ —— `engine-damage` 的预警原话：
   「`冻结` **已写进状态却没任何效果** ⇒ **谁"顺手"加个 tick"而不做术语 1004 的结算，立刻变成静默假绿**」
   （实测：技能路径**根本没写** ✓，见下面三条路径判据 ✓）

## 两条判据（都在 `roco/tests/**`，只读引擎 ✓）

1. **`冻结` 不许出现在 `END_OF_TURN_STATUS`** —— 钉住"不许顺手加 tick" ✗
   （那张表里**只有** 中毒 / 灼烧 / 寄生 三个**真结算**的状态 ✓）
2. **技能路径施加冻结后 `statuses` 必须为空** —— 三条挂载路径（状态技 / 攻击附带 / 防御+应对）各一条 ✓
   **反证**：`530 暴风雪` 的 hp 变化**只来自它自己的伤害** ✗（用 `damage` 事件的读数和 hp 差**对齐**来钉，
   不是"hp 变了就算冻结生效" ✗）
3. 顺带钉住**已删掉的那支死代码**：技能路径**不许**触发特性钩子 `after_freeze_applied`
   （那是 `捉迷藏`/`抓到你了` 的钩子，**只有特性自己施加冻结时才该走** ✓）
"""

import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from roco_env import data as D  # noqa: E402
from roco_env import effects as FX  # noqa: E402
from roco_env import env as E  # noqa: E402
from roco_env import rule_config as RC  # noqa: E402
from roco_env.schema import ACTION_SKILL, Action  # noqa: E402

#: 三条挂载路径的样本（各自覆盖一种施加方式 ✓）
PATHS = (
    ("skill_000535", "状态技「敌方获得4层冻结」", None),
    ("skill_000530", "攻击附带「造成物伤，敌方获得1层冻结」", None),
    ("skill_000540", "防御+应对「减伤80%，应对攻击：敌方获得2层冻结」", "skill_000418"),
)

_PETS = ["pet_000190", "pet_000062", "pet_000445", "pet_000474",
         "pet_000001", "pet_000019", "pet_000601", "pet_000124"]
#: 判据用的未验证登记（与其它判据同一手法：先手平手按种子随机 ✓）
_OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
               "confidence": "ENGINE_HYPOTHESIS", "reason": "判据用", "microcase_id": "MC-E05"}]


def _owner(rs, sid: str) -> str:
    for pid, learn in rs.learnsets.items():
        if sid in learn.all_skill_ids and pid != "pet_000417":
            return pid
    raise AssertionError(f"{sid} 没有任何可学精灵")


def _battle(rs, cfg, sid: str, enemy_sid):
    """建一局：我方首发带 `sid` 的那只，敌方是 `pet_000417`（带 `enemy_sid`）。"""
    mine = _owner(rs, sid)
    pool = [p for p in dict.fromkeys([mine, "pet_000417"] + _PETS) if p != mine]
    team_p, team_e = [mine] + pool[:5], list(dict.fromkeys(["pet_000417"] + pool))[:6]
    loadouts = {p: tuple(rs.candidate_moveset(p)) for p in set(team_p + team_e)}
    loadouts[mine] = tuple([sid] + [s for s in rs.candidate_moveset(mine) if s != sid][:3])
    if enemy_sid:
        loadouts["pet_000417"] = tuple(
            [enemy_sid] + [s for s in rs.candidate_moveset("pet_000417") if s != enemy_sid][:3])
    for pid, moves in loadouts.items():
        assert len(moves) == 4, f"{pid} 配招不是 4 个：{moves}"
        assert all(m in rs.learnsets[pid].all_skill_ids for m in moves), f"{pid} 配招不在学习表里"
    return E.reset(team_p, team_e, seed=11, rs=rs, loadouts=loadouts,
                   config=cfg, unverified_overrides=_OVERRIDES)


def _play(rs, cfg, sid: str, enemy_sid=None):
    """我方出 `sid`，敌方出一手合法技能 ⇒ 返回 (出手后状态, 事件列表, 出手前敌方 hp)。"""
    state = _battle(rs, cfg, sid, enemy_sid)
    hp_before = state.enemy.field_pet.hp
    mine = Action(ACTION_SKILL, skill_id=sid)
    assert mine in E.legal_actions(state, rs, "player"), f"{sid} 在我方不合法"
    if enemy_sid:
        foe = Action(ACTION_SKILL, skill_id=enemy_sid)
        assert foe in E.legal_actions(state, rs, "enemy"), f"{enemy_sid} 在敌方不合法"
    else:
        foe = next(a for a in E.legal_actions(state, rs, "enemy")
                   if a.kind == ACTION_SKILL and a.skill_id)
    return E.step_joint(state, rs, mine, foe), hp_before


class FrozenIsNotSettledTest(unittest.TestCase):
    """判据 1：**不许给冻结加回合末结算**（钉住"顺手加个 tick" ✗）。"""

    def test_frozen_is_not_an_end_of_turn_status(self):
        # 改钉不删：现存三个**真结算**的状态先钉住（它们的层数/衰减在 RC-401 批次九就做了 ✓）
        for name in ("中毒", "灼烧", "寄生"):
            self.assertIn(name, FX.END_OF_TURN_STATUS,
                          f"{name} 的回合末结算被删了？那是回归，不是本判据要的")
        # 本判据要钉的：**冻结**不许进来
        # 理由（逐字）：术语 1004「冻结5%生命，若当前生命低于冻结比例，则力竭。（冰系精灵免疫此效果）」
        #   —— 没写"层数"干什么；而 11 条技能发的是 1~5 层 ⇒ 要真做就得**发明语义** ✗
        # 加进这张表 = 引擎会在回合末对冻结做结算（tick）⇒ 而结算规则**不存在** ⇒ **静默假绿** ✗
        self.assertNotIn(
            "冻结", FX.END_OF_TURN_STATUS,
            "`冻结` 被加进 END_OF_TURN_STATUS 了 ✗ —— 术语 1004 没定义层数语义，"
            "这一加就是「凭空 tick ⇒ 静默假绿」。要真做请先按人类口径把「缺参数」显式定义并登记 ENGINE_HYPOTHESIS，"
            "再改成判据 + 实现 + 反证三件套（见 task-28 的记录）")


class FrozenWriteIsRefusedTest(unittest.TestCase):
    """判据 2：三条挂载路径**都不许写** `statuses['冻结']`（只登记为不支持 ✓）。"""

    def _check(self, sid: str, label: str, enemy_sid):
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, hp_before = _play(rs, cfg, sid, enemy_sid)
        foe = after.enemy.field_pet
        # ① 状态**没被写进去**（这是本判据的核心：空转不许装成生效 ✓）
        self.assertEqual(dict(foe.statuses), {},
                         f"{label}：技能施加冻结后 statuses 应保持为空（只登记不写）✗")
        # ② 事件是**未支持**，不是 `status_added`
        added = [e for e in after.events if e.kind == "status_added" and e.detail.get("status") == "冻结"]
        self.assertEqual(added, [], f"{label}：不该发 status_added（那等于宣布它生效了）✗")
        unsup = [e for e in after.events if e.kind == "status_unsupported"]
        # ③ **必须登记成"未支持"** —— 两条路都算数（如实按实际分支写 ✓）：
        #    · **状态技**路径发 `status_unsupported` 事件（`env.py:1319`）✓
        #    · **攻击附带 / 防御+应对**路径走 `_note_unsupported` **登记**（不发那个事件 ✓）
        #    ⚠ 第一版我写成"必须发 status_unsupported 事件" ⇒ `530`/`540` **假红** ✗
        #      （实测那两条只在 `state.unsupported` 里登记 ✓）—— 本判据要钉的是**"登记到了"** ✓，
        #      不是"发的是哪个事件" ✗（那是实现细节，写死会把正确的实现判红 ✗）
        whats = [str(u.get("what", "")) for u in after.unsupported]
        self.assertTrue(unsup or any("冻结" in w for w in whats),
                        f"{label}：冻结必须被登记为未支持（事件或 unsupported 登记），"
                        f"实际 事件={unsup} · 登记={whats}")
        # ④ 事件里**不许**出现任何"冻结造成的伤害"（它是 0 效果，不是小效果 ✓）
        frozen_dmg = [e for e in after.events if e.kind == "damage"
                      and "冻结" in str(e.detail.get("source", "")) + str(e.detail.get("status", ""))]
        self.assertEqual(frozen_dmg, [], f"{label}：冻结不该造成任何伤害 ✗")
        return after, hp_before, foe

    def test_status_skill_does_not_write_frozen(self):
        self._check("skill_000535", "状态技 535 霜降", None)

    def test_attack_attached_frozen_does_not_write_it(self):
        self._check("skill_000530", "攻击附带 530 暴风雪", None)

    def test_defense_respond_frozen_does_not_write_it(self):
        self._check("skill_000540", "防御+应对 540 冰墙", "skill_000418")

    def test_counter_proof_530_hp_drop_is_its_own_damage_not_frozen(self):
        """**反证**：`530` 的 hp 变化**只来自它自己的伤害** ✗（别把"它自己打的血"记成"冻结生效" ✗）。"""
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, hp_before = _play(rs, cfg, "skill_000530", None)
        foe = after.enemy.field_pet
        deltas = [e.detail.get("damage", 0) for e in after.events
                  if e.kind == "damage" and e.detail.get("side") == "player"]
        self.assertTrue(deltas, "530 是攻击技，应有它自己的伤害事件")
        # hp 差 **恰好等于**那些伤害事件的和 ⇒ 没有"多出来的那部分"可以归给冻结 ✓
        self.assertEqual(hp_before - foe.hp, sum(deltas),
                         "530 的 hp 差与自身伤害事件之和不符 ⇒ 有别的来源（冻结？）在改血 ✗")

    def test_skill_path_does_not_fire_the_trait_hook(self):
        """**已删死代码的判据**：技能施加冻结**不许**触发特性钩子 `after_freeze_applied` ✓。

        `after_freeze_applied` 是 `捉迷藏` / `抓到你了` 的钩子（使敌方获得冻结时，自己全技能能耗 +1），
        **只有特性自己施加冻结时才该走** ✓ ⇒ 技能路径调它是**错的** ✗（task-28 已删那支死代码 ✓）。
        """
        rs, cfg = D.load_ruleset(), RC.get_rule_config("mobile_s4_candidate_v3")
        after, _ = _play(rs, cfg, "skill_000535", None)
        hooked = [e for e in after.events
                  if e.kind == "trait" and "能耗" in str(e.detail.get("effect", ""))]
        self.assertEqual(hooked, [],
                         f"技能路径触发了特性钩子（全技能能耗 +1）✗ ⇒ 死代码又回来了？{hooked}")


if __name__ == "__main__":
    unittest.main()
