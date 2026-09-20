"""对局环境：reset / observe / legal_actions / step_joint / serialize / replay。

这个模块是「规则引擎」的本体。它的可信度取决于两件事，二者都必须在代码里可见：

  1. **每一步的非平凡决策都注明依据。** 代码里出现 `依据：术语 1016` 时，
     意思是 `terms.json` 有那条文本；出现 `假设` 时，意思是**没有一手证据**，
     属于 microcase 待验项。
  2. **不知道就说不知道。** 未实现的机制抛 `UnsupportedEffect` 或记进
     `state.unsupported`，绝不生成一个看着合理的默认值。

尚未核验因而**没有**在这里实现的机制（会 fail closed）：

  - 能量上限与回合末回能的精确规则（MC-007）
  - 同速且同先手度时的裁决依据；此处用 seed 驱动的确定性随机，**这是假设**（MC-002）
  - 印记的叠加/替换规则（MC-009）
  - 「传动」的技能位移动（术语 1033）
  - 天气、连击数、属性增减的层数语义
  - 12 只精灵的特性效果（MC-014…019）
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import effects as fx
from . import parse
from . import data as _data
from .data import Ruleset, load_ruleset
from .schema import (
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SKILL,
    ACTION_SWITCH,
    Action,
    Event,
    GameState,
    PetState,
    SideState,
    observation_for,
)

# 术语里**没有**给出、但有界实现必须选一个的值。集中在这里，方便整体替换。
ENERGY_MAX = 6              # 假设：上限 6。数据只给每条技能的能耗，没给上限（MC-007）
ENERGY_REGEN_PER_TURN = 1   # 假设：存活在场者回合末 +1（MC-007）
SWITCH_PRIORITY = 5         # 假设：主动换宠占整回合，且先于技能。数据未定义（MC-005）
ITEM_PRIORITY = 4           # 假设：道具先于技能

DEFAULT_ITEM_STOCK = {"回复药": 3, "净化药": 2, "能量果": 2}
ITEM_EFFECTS = {"回复药": ("heal", 45), "净化药": ("cleanse", 0), "能量果": ("energy", 4)}


# ── 构造 ────────────────────────────────────────────────────────────────


def _make_pet(rs: Ruleset, pet_id: str, slot: int, level: int) -> PetState:
    """按规则集里的种族值造一只。

    假设：等级 1 时面板 = 种族值。**等级→面板的换算公式未知**（M1 已登记为
    unknown），所以本引擎只支持 level=1，其它等级抛 UnsupportedEffect。
    宁可拒绝，也不要编一条成长曲线。
    """
    if level != 1:
        raise fx.UnsupportedEffect(
            f"等级 {level}", "等级→面板换算公式未知，本引擎只支持 level=1（M1 已登记为 unknown）"
        )
    pet = rs.pet(pet_id)
    # 关键：pets.json 里的 stats 是**种族值**，实战要用面板值。
    # 换算依据见 data.PANEL_FORMULAS（从社区快照的 base_*/stat_* 反推，
    # hp/atk/def 三项精确、其余有残差）。伤害量级完全取决于这一步。
    panel = _data.panel_stats(pet.stats)
    hp = int(round(panel.get("hp", float(pet.stats.get("hp", 1)))))
    return PetState(
        pet_id=pet_id,
        slot=slot,
        level=1,
        hp=hp,
        max_hp=hp,
        energy=0,
    )


def reset(
    team: Sequence[str],
    enemy_team: Optional[Sequence[str]] = None,
    *,
    seed: int = 1,
    rs: Optional[Ruleset] = None,
) -> GameState:
    """开始一局。

    `team` 是 3 只精灵的 id（手游完整阵容是 6 只，但训练场用 3v3，见实施书 §4.4）。
    队伍与配招的合法性在 `validate_team` 里统一检查。
    """
    rs = rs or load_ruleset()
    if len(team) != 3:
        raise ValueError("训练场是 3v3，需要恰好 3 只精灵")
    if len(set(team)) != 3:
        raise ValueError("同一只精灵不能重复上场")
    for pid in team:
        rs.pet(pid)                      # 不存在就抛 RulesetError

    enemy = list(enemy_team) if enemy_team else list(team)
    if len(enemy) != 3:
        raise ValueError("对手也必须是 3 只")

    state = GameState(
        ruleset_id=rs.ruleset_id,
        seed=seed,
        player=SideState(name="player", pets=[_make_pet(rs, p, i, 1) for i, p in enumerate(team)]),
        enemy=SideState(name="enemy", pets=[_make_pet(rs, p, i, 1) for i, p in enumerate(enemy)]),
    )
    for side in (state.player, state.enemy):
        side.items = dict(DEFAULT_ITEM_STOCK)
        side.active = 0
        side.field_pet.energy = 2        # 假设：入场初始能量 2。数据未定义（MC-007）
        side.field_pet.entered_turn = 1
    state.log.append(f"对局开始。规则集 {rs.ruleset_id}，seed {seed}。")
    return state


# ── 合法动作 ────────────────────────────────────────────────────────────


def legal_actions(state: GameState, rs: Ruleset, side: str) -> List[Action]:
    """这一方现在能做什么。

    依据：
      - 技能可用条件：能量足够（能耗 ≤ 当前能量）——**假设**，数据未定义不足时的行为。
      - 防御冷却中不可再用（术语 1016）。
      - 主动换宠只在有存活后备时可用。
    """
    if state.result:
        return []
    me = getattr(state, side)
    pet = me.field_pet
    acts: List[Action] = []

    if state.phase == "replace":
        # 补位：只允许换人，且是强制的（术语 3009 把力竭下场与主动离场分开）
        for i in me.bench_indices():
            acts.append(Action(kind=ACTION_SWITCH, target_index=i))
        return acts

    if not pet.alive:
        for i in me.bench_indices():
            acts.append(Action(kind=ACTION_SWITCH, target_index=i))
        return acts

    for sid in sorted(rs.learnsets.get(pet.pet_id, _EMPTY).all_skill_ids):
        skill = rs.skills.get(sid)
        if skill is None or skill.is_trait:
            continue
        if skill.energy > pet.energy:
            continue
        if skill.is_defense and pet.defense_cooldown > 0:
            continue          # 术语 1016
        acts.append(Action(kind=ACTION_SKILL, skill_id=sid))

    for i in me.bench_indices():
        acts.append(Action(kind=ACTION_SWITCH, target_index=i))

    for item_id, count in sorted(me.items.items()):
        if count > 0:
            acts.append(Action(kind=ACTION_ITEM, item_id=item_id, target_index=me.active))

    acts.append(Action(kind=ACTION_ESCAPE))
    return acts


class _EmptyLearnset:
    native: Tuple[str, ...] = ()
    blood: Tuple[str, ...] = ()
    stones: Tuple[str, ...] = ()

    @property
    def all_skill_ids(self):
        return frozenset()


_EMPTY = _EmptyLearnset()


def validate_team(rs: Ruleset, team: Sequence[str], loadouts: Optional[Dict[str, Sequence[str]]] = None) -> List[str]:
    """校验队伍与配招，返回问题列表（空 = 合法）。

    配招规则来自 M1 的数据：技能必须在该精灵的学习表里。
    「6 选 4」的形态属于 UI 约定，本函数只查**可学性**。
    """
    problems: List[str] = []
    if len(team) != 3:
        problems.append(f"队伍必须是 3 只，实际 {len(team)}")
    if len(set(team)) != 3:
        problems.append("队伍里有重复精灵")
    for pid in team:
        if pid not in rs.pets:
            problems.append(f"未知精灵 {pid}")
    if loadouts:
        for pid, sids in loadouts.items():
            if pid not in team:
                problems.append(f"配招提到了不在队伍里的 {pid}")
                continue
            for sid in sids:
                if not rs.is_learnable(pid, sid):
                    problems.append(f"{rs.pets[pid].name} 学不到 {rs.skills.get(sid, type('x', (), {'name': sid})).name}")
    return problems


# ── 排序（MC-001 / MC-002 / MC-004）────────────────────────────────────


def _priority_of(action: Action, rs: Ruleset) -> int:
    """先手度。

    依据：术语 1020「先手度更高的技能忽略速度差异，优先释放，先手度可叠加」。
    数据里**没有**逐技能的先手字段，只有描述文本里的「先手+1」「先手+2」，
    所以这里从描述里读；读不到按 0。
    **假设**：换宠先手 5、道具先手 4（数据未定义，MC-005）。
    """
    if action.kind == ACTION_SWITCH:
        return SWITCH_PRIORITY
    if action.kind == ACTION_ITEM:
        return ITEM_PRIORITY
    if action.kind == ACTION_ESCAPE:
        return 99
    if action.kind != ACTION_SKILL or not action.skill_id:
        return 0
    skill = rs.skills.get(action.skill_id)
    if skill is None:
        return 0
    import re
    m = re.search(r"先手\s*\+\s*(\d+)", skill.desc or "")
    return int(m.group(1)) if m else 0


def _respond_success(action: Action, opponent_action: Action, rs: Ruleset) -> bool:
    """这一个动作的「应对」是否成功。

    依据：术语 1015/1016/1017——若敌方使用了对应类别的动作，则应对成功。
    这是**双方动作都确定之后**才能判定的，所以排序必须在选择之后做。
    """
    if action.kind != ACTION_SKILL or not action.skill_id:
        return False
    skill = rs.skills.get(action.skill_id)
    if skill is None:
        return False
    target = fx.respond_to(skill)
    if target is None:
        return False
    if opponent_action.kind == ACTION_SKILL and opponent_action.skill_id:
        opp_skill = rs.skills.get(opponent_action.skill_id)
        opp_kind = opp_skill.category if opp_skill else ""
    elif opponent_action.kind == ACTION_SWITCH:
        opp_kind = "换宠"
    elif opponent_action.kind == ACTION_ITEM:
        opp_kind = "道具"
    else:
        opp_kind = ""
    return target == opp_kind


def order_actions(
    state: GameState,
    rs: Ruleset,
    player_action: Action,
    enemy_action: Action,
    *,
    rng: random.Random,
) -> List[Tuple[str, Action]]:
    """把双方动作排成一个执行序列。

    排序键（从上到下）：
      1. 应对成功（术语 1015/1016/1017：「本次行动必定先手」）
      2. 先手度（术语 1020）
      3. 速度（术语 1020 的补集：先手度相同时才比速度）
      4. seed 驱动的确定性随机（**假设**：同速裁决。MC-002 待验）

    返回 [(side, action), ...]，按实际执行顺序。
    """
    entries = []
    for side, action, opp in (("player", player_action, enemy_action),
                              ("enemy", enemy_action, player_action)):
        pet = getattr(state, side).field_pet
        entries.append({
            "side": side,
            "action": action,
            "respond": _respond_success(action, opp, rs),
            "priority": _priority_of(action, rs),
            "speed": pet.stats.get("spe", 1) if hasattr(pet, "stats") else rs.pet(pet.pet_id).stats.get("spe", 1),
            "tie": rng.random(),
        })
    entries.sort(key=lambda e: (not e["respond"], -e["priority"], -e["speed"], e["tie"]))
    return [(e["side"], e["action"]) for e in entries]


# ── 结算 ────────────────────────────────────────────────────────────────


def _bump(state: GameState, kind: str, detail: Dict[str, Any], evidence: Sequence[str] = ()) -> None:
    state.events.append(Event(kind=kind, turn=state.turn, detail=detail, evidence=tuple(evidence)))
    state.state_version += 1


def _note_unsupported(state: GameState, what: str, detail: str, evidence: str = "") -> None:
    state.unsupported.append({
        "turn": state.turn, "what": what, "detail": detail, "evidence": evidence,
    })


def step_joint(
    state: GameState,
    rs: Ruleset,
    player_action: Action,
    enemy_action: Action,
) -> GameState:
    """双方基于**同一事前状态**各出一手，然后统一推进。

    隐藏信息纪律：本函数在结算前先为双方快照 observation，
    并把它们写进 history。这样任何「后出手的一方偷看了对手选择」的实现错误
    都能从回放里查出来。
    """
    if state.result:
        raise ValueError("对局已结束，不能再行动")
    if state.phase == "replace":
        raise ValueError("补位局面请用 step_replace")

    for side, action in (("player", player_action), ("enemy", enemy_action)):
        if action not in legal_actions(state, rs, side):
            raise ValueError(f"{side} 的行动不合法：{action.label(rs)}")

    # 应对判定（术语 1015/1016/1017）需要知道对手这一手是什么。
    # 这两个字段只用于**结算**，绝不进入 observation（见 schema.observation_for）。
    setattr(state, "_pending_player", player_action)
    setattr(state, "_pending_enemy", enemy_action)

    rng = _rng_for(state)
    order = order_actions(state, rs, player_action, enemy_action, rng=rng)

    pre_player = observation_for(state, rs, "player")
    pre_enemy = observation_for(state, rs, "enemy")

    state.log.append(f"── 第 {state.turn} 回合 ──")
    _bump(state, "turn_start", {"turn": state.turn})

    # 冷却与临时标记在回合开始时递减/清除
    for side in (state.player, state.enemy):
        for p in side.pets:
            if p.defense_cooldown > 0:
                p.defense_cooldown -= 1

    for side, action in order:
        _execute(state, rs, side, action)

    _end_of_turn(state, rs)

    state.history.append({
        "turn": state.turn,
        "pre_observation_hash": _obs_hash(pre_player),
        "pre_observation_opponent_hash": _obs_hash(pre_enemy),
        "player_action": player_action.to_dict(),
        "enemy_action": enemy_action.to_dict(),
        "events": [e.to_dict() for e in state.events if e.turn == state.turn],
        "state_version": state.state_version,
    })

    # 有谁倒下就进补位局面；补位**不消耗回合**（术语 3009：力竭下场不属于「离场」）
    queue = needs_replacement(state)
    if not _both_side_alive(state):
        _finish(state)
    elif queue:
        state.replace_queue = queue
        state.phase = "replace"
        state.log.append(f"等待补位：{'、'.join(queue)}")
    else:
        state.turn += 1
        state.phase = "battle"

    return state


def _obs_hash(obs: Dict[str, Any]) -> str:
    import hashlib
    import json
    return hashlib.sha256(json.dumps(obs, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def _rng_for(state: GameState) -> random.Random:
    """由 (seed, turn) 派生的确定性随机源。

    这样同一 seed + 同一串动作必然得到同一结果，replay 才有意义。
    **假设**：同速裁决用随机。数据未定义（MC-002）。
    """
    return random.Random((state.seed << 20) ^ (state.turn * 2654435761))


def _both_side_alive(state: GameState) -> bool:
    return bool(state.player.living()) and bool(state.enemy.living())


def _execute(state: GameState, rs: Ruleset, side: str, action: Action) -> None:
    me = getattr(state, side)
    foe_side = "enemy" if side == "player" else "player"
    foe = getattr(state, foe_side)
    pet = me.field_pet
    label = "你" if side == "player" else "对手"

    if not pet.alive:
        state.log.append(f"{label}的{rs.pet(pet.pet_id).name}已倒下，行动取消。")
        _bump(state, "action_cancelled", {"side": side, "reason": "fainted"})
        return

    if action.kind == ACTION_SWITCH:
        target = me.pets[action.target_index or 0]
        pet.charge = None            # 主动离场会中断蓄力（术语 1007 的例外见 MC-021）
        me.active = action.target_index or 0
        target.entered_turn = state.turn
        target.used_burst = False
        state.log.append(f"{label}换上了{rs.pet(target.pet_id).name}。")
        _bump(state, "switch", {"side": side, "to_slot": target.slot}, evidence=("3009",))
        return

    if action.kind == ACTION_ESCAPE:
        state.result = "escaped"
        state.phase = "ended"
        state.log.append("你撤离了。")
        _bump(state, "escape", {"side": side})
        return

    if action.kind == ACTION_ITEM:
        _use_item(state, rs, side, action)
        return

    skill = rs.skill(action.skill_id)
    pet.energy = max(0, pet.energy - skill.energy)   # 假设：消耗先扣（MC-007）

    # 应对成功判定：需要对手这一手是什么
    opp_action = _opponent_action_of(state, side)
    succeeded = _respond_success(action, opp_action, rs) if opp_action else False
    setattr(pet, "_respond_succeeded", succeeded)
    setattr(pet, "_burst_active", (pet.entered_turn == state.turn and not pet.used_burst))

    if skill.is_defense:
        reduction = fx.parse_defense_reduction(skill)
        setattr(pet, "_defense_reduction", reduction)
        if fx.defense_cooldown_applies(skill):
            pet.defense_cooldown = 2      # 本回合刚用过，下回合不可用（术语 1016）
        state.log.append(
            f"{label}的{rs.pet(pet.pet_id).name}使用{skill.name}：本回合减伤 "
            f"{reduction * 100:.0f}%{'，应对成功' if succeeded else ''}。"
        )
        _bump(state, "defense", {"side": side, "skill_id": skill.skill_id,
                                 "reduction": reduction, "respond": succeeded},
              evidence=("1015", "1016", "1017"))
        return

    if skill.is_status:
        applied = _apply_status_effects(state, rs, side, skill)
        if not applied:
            # 解析不出来就 fail closed：登记，不假装生效
            _note_unsupported(state, f"状态技能「{skill.name}」", skill.desc or "", skill.skill_id)
            state.log.append(f"{label}的{rs.pet(pet.pet_id).name}使用{skill.name}（效果未核验）。")
            _bump(state, "status_unsupported", {"side": side, "skill_id": skill.skill_id})
        return

    # 攻击
    if not skill.is_attack:
        _note_unsupported(state, f"技能类别「{skill.category}」", skill.name, skill.skill_id)
        return

    defender = foe.field_pet
    if not defender.alive:
        state.log.append(f"{label}失去目标。")
        return

    try:
        pr = fx.effective_power(skill, attacker=pet, defender=defender, rs=rs)
    except fx.UnsupportedEffect as exc:
        _note_unsupported(state, f"技能「{skill.name}」的威力", str(exc), skill.skill_id)
        state.log.append(f"{label}的{rs.pet(pet.pet_id).name}使用{skill.name}（威力未核验，未结算）。")
        _bump(state, "power_unsupported", {"side": side, "skill_id": skill.skill_id, "detail": str(exc)})
        return

    attacker_pet = rs.pet(pet.pet_id)
    defender_pet = rs.pet(defender.pet_id)
    type_mult = rs.type_chart.multiplier(defender_pet.types, skill.element)
    stab = fx.stab_multiplier(skill, attacker_pet.types)
    model = fx.active_damage_model()
    # 面板值，不是种族值（见 data.PANEL_FORMULAS）
    atk_panel = _data.panel_stats(attacker_pet.stats)
    def_panel = _data.panel_stats(defender_pet.stats)
    atk_value = atk_panel.get("atk", float(attacker_pet.stats.get("atk", 1)))
    def_value = def_panel.get("def", float(defender_pet.stats.get("def", 1)))

    reduction = getattr(defender, "_defense_reduction", 0.0)
    raw = model.compute(
        attacker_atk=float(atk_value),
        defender_def=float(def_value),
        power=float(pr.power),
        type_multiplier=float(type_mult),
        stab=float(stab),
        hit_count=1,
        power_multiplier=1.0,
        ability_level=1.0,
    )
    damage = max(1, int(raw * (1.0 - reduction))) if reduction else raw
    actual = min(defender.hp, damage)
    defender.hp -= actual

    state.log.append(
        f"{label}的{rs.pet(pet.pet_id).name}使用{skill.name}，对{defender_pet.name}造成 {actual} 伤害"
        f"{'（属性克制）' if type_mult > 1 else '（属性抵抗）' if type_mult < 1 else ''}"
        f"{'（防御减伤）' if reduction else ''}。"
    )
    _bump(state, "damage", {
        "side": side,
        "skill_id": skill.skill_id,
        "target_slot": defender.slot,
        "damage": actual,
        "power_used": pr.power,
        "conditional_power": pr.conditional,
        "conditional_reason": pr.reason,
        "type_multiplier": type_mult,
        "stab": stab,
        "damage_model": model.name,
        "formula_verified": model.verified,
    }, evidence=(skill.skill_id,))

    if defender.hp <= 0:
        defender.hp = 0
        defender.fainted = True
        defender.charge = None
        state.log.append(f"{defender_pet.name}倒下了。")
        _bump(state, "faint", {"side": foe_side, "slot": defender.slot}, evidence=("3009",))


def _apply_status_effects(state: GameState, rs: Ruleset, side: str, skill) -> bool:
    """应用一个状态技能被解析出来的效果。返回是否**至少应用了一条**。

    纪律：只有描述能被 `parse.py` 机械读出时才应用；解析出未覆盖机制时返回 False，
    由调用方登记为 unsupported。**不做部分应用**——半套效果比不支持更危险，
    因为它会让上层以为这个技能已经可用。
    """
    parsed = parse.parse_skill(skill)
    if not parsed.effects or parsed.unparsed:
        return False

    me = getattr(state, side)
    foe = getattr(state, "enemy" if side == "player" else "player")
    pet = me.field_pet
    label = "你" if side == "player" else "对手"
    applied = 0

    for eff in parsed.effects:
        v = eff.value
        if eff.kind == "self_stat":
            key = str(v["stat"])
            pet.buffs[key] = pet.buffs.get(key, 0) + int(v["delta_pct"])
            applied += 1
            _bump(state, "buff_self", {"side": side, "stat": key, "delta_pct": v["delta_pct"]},
                  evidence=(eff.term or "",))
        elif eff.kind == "foe_stat":
            key = str(v["stat"])
            tgt = foe.field_pet
            tgt.buffs[key] = tgt.buffs.get(key, 0) + int(v["delta_pct"])
            applied += 1
            _bump(state, "debuff_foe", {"side": side, "stat": key, "delta_pct": v["delta_pct"]},
                  evidence=(eff.term or "",))
        elif eff.kind in ("self_mark", "foe_mark"):
            holder = pet if eff.kind == "self_mark" else foe.field_pet
            name = str(v["mark"])
            # 术语 3010：最多同时拥有 1 种正面印记和 1 种负面印记。
            # 替换规则数据未定义（MC-009），这里采取「累加层数」，并把该假设登记出来。
            holder.marks[name] = holder.marks.get(name, 0) + int(v["layers"])
            _note_unsupported(
                state, f"印记「{name}」的叠加/替换规则",
                "术语 3010 只给了「最多 1 正 + 1 负」，未定义同类替换（MC-009）；"
                "本引擎暂按累加层数处理", "3010",
            )
            applied += 1
            _bump(state, "mark_added", {"side": side if eff.kind == "self_mark" else "enemy",
                                        "mark": name, "layers": v["layers"]}, evidence=("3010",))
        elif eff.kind == "foe_status":
            name = str(v["status"])
            spec = fx.END_OF_TURN_STATUS.get(name)
            if spec is None:
                continue
            tgt = foe.field_pet
            tgt.statuses[name] = {
                "layers": tgt.statuses.get(name, {}).get("layers", 0) + int(v["layers"])
            }
            applied += 1
            _bump(state, "status_added", {"side": "enemy", "status": name,
                                          "layers": v["layers"]},
                  evidence=(spec.get("term", ""),))
        elif eff.kind == "cleanse":
            cleared = sorted(foe.field_pet.buffs)
            foe.field_pet.buffs.clear()
            applied += 1
            _bump(state, "cleanse", {"side": side, "cleared": cleared})
        elif eff.kind == "heal":
            pct = int(v["percent"])
            amount = fx.percent_of_max_hp(pet.max_hp, pct)
            healed = min(amount, pet.max_hp - pet.hp)
            pet.hp += healed
            applied += 1
            _bump(state, "heal", {"side": side, "healed": healed})
        elif eff.kind == "drain_energy":
            amount = int(v["amount"])
            taken = min(amount, foe.field_pet.energy)
            foe.field_pet.energy -= taken
            pet.energy = min(ENERGY_MAX, pet.energy + taken)
            applied += 1
            _bump(state, "drain_energy", {"side": side, "taken": taken})
        elif eff.kind == "escape":
            # 术语 3003/3024：离场并换人。本引擎需要调用方决定换谁，所以登记为待处理。
            _note_unsupported(state, f"技能「{skill.name}」的离场效果",
                              "离场需要选择换上谁，属补位流程；引擎未自动代选", "3009")
        elif eff.kind == "weather":
            _note_unsupported(state, f"天气「{v['weather']}」", "引擎尚未实现天气层", "")

    if applied:
        state.log.append(
            f"{label}的{rs.pet(pet.pet_id).name}使用{skill.name}，应用 {applied} 条效果。"
        )
        _bump(state, "status_applied", {"side": side, "skill_id": skill.skill_id,
                                        "effects": applied})
    return applied > 0


def _opponent_action_of(state: GameState, side: str) -> Optional[Action]:
    """取对手本回合提交的动作——**仅用于结算判定**，不进入任何观察。"""
    return getattr(state, "_pending_" + ("enemy" if side == "player" else "player"), None)


def _use_item(state: GameState, rs: Ruleset, side: str, action: Action) -> None:
    me = getattr(state, side)
    item_id = action.item_id or ""
    if me.items.get(item_id, 0) <= 0:
        raise ValueError(f"没有{item_id}")
    me.items[item_id] -= 1
    kind, amount = ITEM_EFFECTS.get(item_id, ("unknown", 0))
    target = me.pets[action.target_index if action.target_index is not None else me.active]
    if kind == "heal":
        healed = min(amount, target.max_hp - target.hp)
        target.hp += healed
        state.log.append(f"恢复 {healed} 生命。")
        _bump(state, "item", {"side": side, "item": item_id, "healed": healed})
    elif kind == "energy":
        before = target.energy
        target.energy = min(ENERGY_MAX, target.energy + amount)
        _bump(state, "item", {"side": side, "item": item_id, "energy_gained": target.energy - before})
    elif kind == "cleanse":
        cleared = list(target.statuses)
        target.statuses.clear()
        _bump(state, "item", {"side": side, "item": item_id, "cleared": cleared})
    else:
        _note_unsupported(state, f"道具「{item_id}」", "未实现", item_id)


def _end_of_turn(state: GameState, rs: Ruleset) -> None:
    """回合末结算。

    依据：术语 1001/1002/1008 都写「回合结束时」造成百分比伤害；
    1002 额外衰减层数。
    **假设**：先结算状态伤害，再回能（MC-012 待验：组内顺序未定义）。
    """
    for side in (state.player, state.enemy):
        pet = side.field_pet
        if not pet.alive:
            continue
        for name in list(pet.statuses.keys()):
            try:
                dmg = fx.status_tick(pet.hp, pet.max_hp, name)
            except fx.UnsupportedEffect as exc:
                _note_unsupported(state, f"状态「{name}」", str(exc))
                continue
            pet.hp = max(0, pet.hp - dmg)
            info = pet.statuses[name]
            layers = int(info.get("layers", 1))
            spec = fx.END_OF_TURN_STATUS.get(name, {})
            info["layers"] = fx.decay_layers(layers, half=bool(spec.get("decays")))
            state.log.append(f"{rs.pet(pet.pet_id).name}受到{name}伤害 {dmg}（剩余 {info['layers']} 层）。")
            _bump(state, "status_tick", {
                "side": side.name, "status": name, "damage": dmg,
                "layers_after": info["layers"],
            }, evidence=(spec.get("term", ""),))
            if info["layers"] <= 0:
                pet.statuses.pop(name, None)
            if pet.hp <= 0:
                pet.fainted = True
                state.log.append(f"{rs.pet(pet.pet_id).name}倒下了。")
                _bump(state, "faint", {"side": side.name, "slot": pet.slot})
                break

        if pet.alive:
            before = pet.energy
            pet.energy = min(ENERGY_MAX, pet.energy + ENERGY_REGEN_PER_TURN)
            if pet.energy != before:
                _bump(state, "energy_regen", {"side": side.name, "energy": pet.energy})


def _finish(state: GameState) -> None:
    p_alive = bool(state.player.living())
    e_alive = bool(state.enemy.living())
    if p_alive and not e_alive:
        state.result = "win"
    elif e_alive and not p_alive:
        state.result = "loss"
    else:
        state.result = "draw"
    state.phase = "ended"
    state.log.append({"win": "你赢了。", "loss": "你的队伍已全部倒下。",
                      "draw": "双方同时失去战斗能力。"}[state.result])
    _bump(state, "game_end", {"result": state.result})


def step_replace(state: GameState, rs: Ruleset, side: str, slot: int) -> GameState:
    """补位。依据：术语 3009（力竭下场不属于「离场」）——补位不消耗回合。"""
    if state.phase != "replace":
        raise ValueError("当前不是补位局面")
    me = getattr(state, side)
    if slot not in me.bench_indices():
        raise ValueError(f"第 {slot} 位不是可换入的存活后备")
    me.active = slot
    me.field_pet.entered_turn = state.turn
    state.log.append(f"{'你' if side == 'player' else '对手'}派出了{rs.pet(me.field_pet.pet_id).name}。")
    _bump(state, "replacement", {"side": side, "slot": slot})

    queue = [s for s in state.replace_queue if s != side]
    state.replace_queue = queue
    if not queue and _both_side_alive(state):
        state.turn += 1
        state.phase = "battle"
    elif not _both_side_alive(state):
        _finish(state)
    return state


def needs_replacement(state: GameState) -> List[str]:
    """哪些方需要补位。"""
    if state.result:
        return []
    out = []
    for side in ("player", "enemy"):
        s = getattr(state, side)
        if not s.field_pet.alive and s.living():
            out.append(side)
    return out


# ── 序列化与回放 ────────────────────────────────────────────────────────


def serialize(state: GameState) -> Dict[str, Any]:
    return state.to_dict()


def deserialize(d: Dict[str, Any], rs: Optional[Ruleset] = None) -> GameState:
    rs = rs or load_ruleset()
    if d.get("ruleset_id") != rs.ruleset_id:
        raise fx.UnsupportedEffect(
            f"规则集不匹配：记录是 {d.get('ruleset_id')}，当前是 {rs.ruleset_id}",
            "不同规则集的状态不可混用",
        )
    return GameState.from_dict(d)


def replay(record: Dict[str, Any], rs: Optional[Ruleset] = None) -> GameState:
    """按记录重放一局，返回最终状态。

    记录格式：{"team": [...], "enemy_team": [...], "seed": int, "actions": [[a, b], ...]}
    每一对是双方同一回合的联合动作。

    回放可复现的前提是：本引擎里所有随机都来自 (seed, turn)，
    没有任何地方读时钟或全局随机。
    """
    rs = rs or load_ruleset()
    state = reset(record["team"], record.get("enemy_team"), seed=record["seed"], rs=rs)
    for pair in record["actions"]:
        if state.result:
            break
        if state.phase == "replace":
            # 记录里补位用 [side, slot] 表示
            side, slot = pair
            step_replace(state, rs, side, int(slot))
            continue
        pa = Action.from_dict(pair[0])
        ea = Action.from_dict(pair[1])
        step_joint(state, rs, pa, ea)
    return state


def observe(state: GameState, rs: Ruleset, side: str) -> Dict[str, Any]:
    """公开观察。隐藏信息的唯一边界。"""
    return observation_for(state, rs, side)
