"""对局环境：reset / observe / legal_actions / step_joint / serialize / replay。

这个模块是「规则引擎」的本体。它的可信度取决于两件事，二者都必须在代码里可见：

  1. **每一步的非平凡决策都注明依据。** 代码里出现 `依据：术语 1016` 时，
     意思是 `terms.json` 有那条文本；出现 `假设` 时，意思是**没有一手证据**，
     属于 microcase 待验项。
  2. **不知道就说不知道。** 未实现的机制抛 `UnsupportedEffect` 或记进
     `state.unsupported`，绝不生成一个看着合理的默认值。

尚未核验因而**没有**在这里实现的机制（会 fail closed）：

  - 能量上限与回合末回能的精确规则（MC-007）；**技能自带的「自己回复N能量」**
    会按描述结算，但「技能回能 vs 回合末回能 vs 能量上限」的先后顺序同样没有
    一手证据（MC-007），所以每一次都会写进 `state.unsupported`
  - 同速且同先手度时的裁决依据（MC-002 / MC-E05）。**策略来自规则配置**：
    `turn_order.speed_tie == "random_seeded"` 时用 seed 驱动的确定性随机 —— 这是**如实登记的
    工程权宜**，不是游戏规则；配置里是 UNKNOWN（null）时 `order_actions` 直接抛
    `UnsupportedEffect`，**不用随机数假装知道规则**
  - 回合末的**阶段顺序**（RC-103）：顺序本身没有一手证据，所以引擎**只**按配置声明的
    `turn_order.end_turn.order` 结算；声明与实现只要对不上（多一个、少一个）就抛
    `UnsupportedEffect`，不静默跳过、也不退回一个默认顺序
  - 印记的叠加/替换规则（MC-009）
  - 「传动」的技能位移动（术语 1033）
  - 天气、连击数、属性增减的层数语义
  - 特性效果：`traits.py` 已登记 12 条（FULL 6 / PARTIAL 2 / REFUSED 4），
    其余精灵的特性**未登记**（MC-014…019 仍未闭合；`engine-trait-status.json` 是账本）

**第 47 轮批 0 修掉的两处静默丢弃**（第 46 轮审计实测发现，用例见
`roco/tests/test_fail_closed_branches.py`）：

  - 攻击分支以前只算伤害，描述里被解析出的附带效果（例「造成魔伤，自己回复1能量」）
    **既不生效也不登记**；
  - 防御分支应用减伤后直接 `return`，「应对成功：自己获得魔攻+70%」同样静默消失。
  现在两条路径统一走「**要么真的生效、要么进 `state.unsupported` 并带原因**」，
  并额外把描述里**没有任何解析结果认领**的机制词片段登记出来
  （`parse.unclaimed_mechanic_spans`）。禁止把 unsupported 效果近似成普通伤害。
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import effects as fx
from . import parse
from . import traits as tr
from . import data as _data
from . import overrides as _overrides
from . import rule_config as _rule_config
from .data import Ruleset, load_ruleset
from .rule_config import RuleConfig, RuleConfigError
from .schema import (
    ACTION_CHARGE,
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SKILL,
    ACTION_SURRENDER,
    ACTION_SWITCH,
    Action,
    Event,
    GameState,
    PetState,
    SideState,
    observation_for,
)

# ── 规则常量：**唯一事实源是 data/roco/rulesets/*.json**（RC-101）──────────
#
# 以前这三个值写死在本文件里（能量上限 6 / 回合末回能 1 / 入场初始 2），
# JS 侧与页面文案各抄了一份；规则 candidate 一变，没有一个地方说得清谁跟着变。现在：
#
#   · 数值只存在于 `data/roco/rulesets/legacy-sim-v1.json`（默认）与
#     `data/roco/rulesets/mobile-s4-candidate-v2.json`（候选，未验证，**不得**当默认）；
#   · 这里只保留**默认配置的视图**，供给本模块内外既有调用点；要换配置走
#     `ROCO_RULE_CONFIG=mobile_s4_candidate_v2` 或 `reset(..., config=...)`。
#
# 下面几行是「读配置」，不是「再抄一份常量」：改 JSON 它们就跟着变，所以默认路径
# 依旧与当前引擎逐位相同（legacy 的 max/regen/initial 恒为 6/1/2）。
_RULE_CONFIG: RuleConfig = _rule_config.get_rule_config()
ENERGY_MAX: int = _RULE_CONFIG.energy_max
ENERGY_REGEN_PER_TURN: int = _RULE_CONFIG.energy_regen_per_turn
SWITCH_PRIORITY = 5         # 假设：主动换宠占整回合，且先于技能。数据未定义（MC-005）
ITEM_PRIORITY = 4           # 假设：道具先于技能

# ── 回合顺序登记表（RC-103）─────────────────────────────────────────────
#
# 这一节把「引擎到底认识哪些顺序维度/阶段」写成**代码里的唯一清单**，好让配置里
# 声明的顺序能被真正核对：`rule_config.py` 管「配置是不是一份合法登记表」，
# 这里管「引擎能不能按它跑」。对不上就抛 `fx.UnsupportedEffect`，绝不静默忽略。

#: 引擎**实现**的回合末阶段。配置声明的顺序必须与它双向覆盖（多一个/少一个都抛）。
#: 顺序的作用域是**每一只在场精灵内部**：先算这只的状态伤害、再算这只的回能 ——
#: 这正是 `turn_order.end_turn.order` 声明的语义（不是「全体先状态伤害、再全体回能」，
#: 后者会改变日志/事件顺序，也就是改变默认行为）。
END_TURN_STAGES_IMPLEMENTED: Tuple[str, ...] = ("status_tick", "regen")

#: 引擎认识的**行动排序维度**名。配置里出现别的名字就抛错。
#: 注意：`switch` 是「认识」但**不是独立比较维** —— 主动换宠被折算成固定先手度
#: （`SWITCH_PRIORITY`）后进 `priority` 那一维。这个差距如实登记在报告里，别当它不存在。
ACTION_ORDER_DIMENSIONS: Tuple[str, ...] = ("respond", "switch", "priority", "speed")

#: RC-105：引擎**真的会产出**的动作类。配置的 `actions.allowed_kinds` 里出现别的名字
#: （例如 `struggle` —— 它在 `VALID_KINDS` 里，但本引擎不会把它列进合法动作）就抛错：
#: 声明了一个引擎产不出的动作类，等于把「没实现」说成「已支持」。
ACTION_KINDS_IMPLEMENTED: Tuple[str, ...] = (
    ACTION_SKILL, ACTION_CHARGE, ACTION_SWITCH, ACTION_SURRENDER, ACTION_ITEM, ACTION_ESCAPE,
)

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
    loadouts: Optional[Dict[str, Sequence[str]]] = None,
    config: Optional[Any] = None,
    unverified_overrides: Optional[Sequence[Any]] = None,
) -> GameState:
    """开始一局。

    **队伍规模由规则配置决定**（RC-106）：`config.battle_mode.team_size`（v3 /
    `pvp-standard-six-pet` ⇒ 6；`legacy_sim_v1` / `demo-training-3v3` ⇒ 3，默认路径
    逐位不变）。以前这里写死 3 —— 那让「标准 PVP 六宠」永远开不了局。

    `loadouts` 是每只精灵**实际带上场的配招**。省略时用 M1 选定的规范配招
    （`Ruleset.candidate_moveset`）。图鉴说「学得到」不等于「这场带得上」：
    合法动作必须按配招算，否则分支在真实对局里根本不存在。

    `config` 是规则配置（id 字符串或 `RuleConfig`）。省略 = 当前生效配置，默认
    `legacy_sim_v1`（`ROCO_RULE_CONFIG` 可改）。这一局用过的配置 id 会写进
    `state.log` 与序列化结果，这样**旧 replay 才绑得住它当时用的那份规则**。

    `unverified_overrides` 是**显式的、带出处的未核验覆盖**（RC-106，见
    `overrides.py`）：候选配置里 `energy.initial` 是 `null`（UNKNOWN，MC-E04 未录制）。
    它**不写回配置**、**不改变 legacy 的回退链** —— 没有覆盖时这里依旧 fail closed。
    """
    cfg = _rule_config.get_rule_config(config)
    rs = rs or load_ruleset()
    # ── RC-106：模式规模来自配置（不再写死 3）；未核验覆盖开局前一次性校验 ──
    # `require_team_size()` 在配置缺这个值/不是正整数时抛错（不猜）；覆盖的判据在
    # `overrides.py`（必须带 {path, value, confidence:'ENGINE_HYPOTHESIS', reason,
    # microcase_id}，且只能落在配置声明为 UNKNOWN 的字段上）。
    team_size = cfg.require_team_size()
    resolved_overrides = _overrides.normalize_unverified_overrides(cfg, unverified_overrides)
    overrides_payload = _overrides.describe(resolved_overrides)
    # 上面那两行把「队伍规模」与「覆盖」都在开局前定死：模式规模来自配置，覆盖只能
    # 落在配置声明为 UNKNOWN 的字段上。下面的校验与建队因此只读这两个结果。

    if len(team) != team_size:
        raise ValueError(
            f"规则配置 {cfg.ruleset_config_id}（模式 {cfg.battle_mode_id}）每方需要恰好 "
            f"{team_size} 只精灵，实际 {len(team)} 只"
        )
    if len(set(team)) != team_size:
        raise ValueError(f"同一只精灵不能重复上场（每方 {team_size} 只，不许重复）")
    for pid in team:
        rs.pet(pid)                      # 不存在就抛 RulesetError

    enemy = list(enemy_team) if enemy_team else list(team)
    if len(enemy) != team_size:
        raise ValueError(
            f"对手也必须是 {team_size} 只（模式 {cfg.battle_mode_id}），实际 {len(enemy)} 只"
        )

    # 配招要**同时**对双方校验：`loadouts` 是一份合并的 {pet_id: [...]}，
    # 里面有对手那几只的配招。只按我方队伍校验会把它报成
    # 「配招提到了不在队伍里的 pet_xxx」——记录里带着两边配招时就会炸。
    problems = validate_team(rs, team, loadouts, also_in=list(enemy), team_size=team_size)
    if problems:
        raise ValueError("队伍不合法：" + "；".join(problems))

    state = GameState(
        ruleset_id=rs.ruleset_id,
        seed=seed,
        player=SideState(name="player", pets=[_make_pet(rs, p, i, 1) for i, p in enumerate(team)]),
        enemy=SideState(name="enemy", pets=[_make_pet(rs, p, i, 1) for i, p in enumerate(enemy)]),
    )
    # 这一局绑定的规则配置：写进 state，replay / 序列化 / 报告都读得到。
    state.ruleset_config_id = cfg.ruleset_config_id
    # 这一局用过的未核验覆盖：**如实带进状态**，公开面与 UI 都读它。
    # 空列表时序列化里不会出现这个键（legacy 逐位不变）。
    state.unverified_overrides = overrides_payload
    # 配招：显式给就用，否则用规范配招
    for side, ids in ((state.player, team), (state.enemy, enemy)):
        side.loadouts = {}
        for pid in ids:
            chosen = tuple(loadouts[pid]) if (loadouts and pid in loadouts) else rs.candidate_moveset(pid)
            side.loadouts[pid] = chosen

    # 入场初始能量来自配置。候选配置里它是 **UNKNOWN**（null）：那时**不许**回落到
    # legacy 的 2 —— 那是编数据。缺值就 fail closed，并指出待录的 microcase；
    # RC-106：除非调用方**显式**给了一条带出处的覆盖（它只覆盖这一个数）。
    try:
        initial_energy = _overrides.resolve_int(cfg, "energy.initial", resolved_overrides)
    except RuleConfigError as exc:
        raise fx.UnsupportedEffect("入场初始能量", str(exc)) from exc

    for side in (state.player, state.enemy):
        side.items = dict(DEFAULT_ITEM_STOCK)
        side.active = 0
        side.field_pet.energy = initial_energy
        side.field_pet.entered_turn = 1
        # RC-105：只有声明了 `mana` 的配置才给魔力。legacy / v2 里 `mana_pool is None`
        # → `SideState.mana` 保持 `None`（序列化里不会出现这个键，8 条 golden 指纹不变）；
        # 这里**不**回落到 0 —— 0 是「魔力归零、已经判负」，不是「没有这个概念」。
        if cfg.has_mana:
            if cfg.mana_pool is None:
                raise fx.UnsupportedEffect(
                    "开局魔力(mana.pool)",
                    f"规则配置 {cfg.ruleset_config_id} 声明了 mana，但 mana.pool 是 UNKNOWN(null) ——"
                    "引擎不知道该发多少点魔力，不许回落到 legacy 或任意数",
                )
            side.mana = int(cfg.mana_pool)
    # 首发入场：入场类特性（专注力/身经百练）在这里结算
    for side in ("player", "enemy"):
        events: List[Dict[str, Any]] = []
        tr.on_enter(rs, state, side, events)
        for e in events:
            _bump(state, e.pop("kind"), e)
    state.log.append(f"对局开始。规则集 {rs.ruleset_id}，规则配置 {cfg.ruleset_config_id}，seed {seed}。")
    return state


# ── 合法动作 ────────────────────────────────────────────────────────────


def require_declared_action_kinds(cfg: RuleConfig) -> Optional[Tuple[str, ...]]:
    """配置声明的合法动作类必须是引擎**真的会产出**的那些（RC-105）。

    与 `require_declared_action_order` / `require_declared_end_turn_stages` 同一条纪律：
    **不静默忽略**。引用了引擎产不出的动作类（例如 `struggle`）时抛 `UnsupportedEffect`，
    而不是「跳过它、按认识的几个发」—— 那等于把一条没实现的规则当成没发生。

    返回 `None` = 这份配置**没有**声明 `actions`（legacy / v2），调用方保持原行为。
    """
    if cfg.allowed_kinds is None:
        return None
    unknown = [kind for kind in cfg.allowed_kinds if kind not in ACTION_KINDS_IMPLEMENTED]
    if unknown:
        raise fx.UnsupportedEffect(
            f"动作类别「{'、'.join(unknown)}」",
            f"规则配置 {cfg.ruleset_config_id} 的 actions.allowed_kinds 声明了本引擎不会产出的动作类"
            f"（引擎会产出：{'、'.join(ACTION_KINDS_IMPLEMENTED)}）——"
            "不静默忽略，也不把它当成一个空集合里的成员",
        )
    return cfg.allowed_kinds


def legal_actions(state: GameState, rs: Ruleset, side: str,
                  config: Optional[Any] = None) -> List[Action]:
    """这一方现在能做什么。

    依据：
      - 技能可用条件：能量足够（能耗 ≤ 当前能量）——**假设**，数据未定义不足时的行为。
      - 防御冷却中不可再用（术语 1016）。
      - 主动换宠只在有存活后备时可用。

    RC-105：**按当前规则配置的 `actions` 裁剪**：
      - `allowed_kinds` 是**声明的**合法动作类（顺序 = 展示顺序，聚能是独立动作类）；
      - `forbidden_kinds` 里的类**一律不出现**（标准 PVP：道具与逃跑）；
      - `unknown_kinds_allowed: false` 时，若这里要产出一个**没在 `allowed_kinds` 里声明**的
        类，**抛错**而不是静默放过 —— 静默放过等于把配置的声明当成建议；
      - 没有声明 `actions` 的配置（legacy / v2）走原路径，道具与逃跑继续存在
        （legacy 是 PVE/练习局）。
    """
    cfg = _rule_config.get_rule_config(
        config if config is not None else (state.ruleset_config_id or None)
    )
    if state.result:
        return []
    me = getattr(state, side)
    pet = me.field_pet
    acts: List[Action] = []

    allowed = require_declared_action_kinds(cfg)
    forbidden = set(cfg.forbidden_kinds or ())

    def emit(action: Action) -> None:
        """把一个候选动作放进结果里（或者按配置拒绝它）。

        三档，顺序就是判据的顺序：
          1. `forbidden_kinds` → 静默丢弃（它**不得**出现在对外合法动作里）；
          2. 没声明 `actions` → 原样放行（legacy 行为）；
          3. 声明了但这一类不在 `allowed_kinds`：
             · `unknown_kinds_allowed: false` → **抛错**（不静默放过）；
             · `true` → 配置显式放行未声明的类，按配置走。
        """
        kind = action.kind
        if kind in forbidden:
            return
        if allowed is not None and kind not in allowed and not cfg.unknown_kinds_allowed:
            raise fx.UnsupportedEffect(
                f"动作类别「{kind}」",
                f"规则配置 {cfg.ruleset_config_id} 的 actions.allowed_kinds 没有声明它，"
                "且 actions.unknown_kinds_allowed=false —— 不许静默产出一个未声明的动作类",
            )
        acts.append(action)

    if state.phase == "replace":
        # 补位：只允许换人，且是强制的（术语 3009 把力竭下场与主动离场分开）
        for i in me.bench_indices():
            emit(Action(kind=ACTION_SWITCH, target_index=i))
        return acts

    if not pet.alive:
        for i in me.bench_indices():
            emit(Action(kind=ACTION_SWITCH, target_index=i))
        return acts

    # 按**配招**枚举，不是整个学习表（图鉴可学 ≠ 这场带得上）
    chosen = tuple(me.loadouts.get(pet.pet_id) or ()) or tuple(rs.learnsets.get(pet.pet_id, _EMPTY).all_skill_ids)
    for sid in sorted(chosen):
        skill = rs.skills.get(sid)
        if skill is None or skill.is_trait:
            continue
        if skill.energy > pet.energy:
            continue
        if skill.is_defense and pet.defense_cooldown > 0:
            continue          # 术语 1016
        emit(Action(kind=ACTION_SKILL, skill_id=sid))

    # RC-105：聚能只在这份配置**声明**它是合法动作类时出现。不声明（legacy / v2）时
    # 连尝试都不尝试 —— 否则 `emit` 会在 legacy 下把聚能加进去（凭空多一个动作）。
    if allowed is not None and ACTION_CHARGE in allowed:
        emit(Action(kind=ACTION_CHARGE))

    for i in me.bench_indices():
        emit(Action(kind=ACTION_SWITCH, target_index=i))

    for item_id, count in sorted(me.items.items()):
        if count > 0:
            emit(Action(kind=ACTION_ITEM, item_id=item_id, target_index=me.active))

    if allowed is not None and ACTION_SURRENDER in allowed:
        emit(Action(kind=ACTION_SURRENDER))

    emit(Action(kind=ACTION_ESCAPE))
    return acts


class _EmptyLearnset:
    native: Tuple[str, ...] = ()
    blood: Tuple[str, ...] = ()
    stones: Tuple[str, ...] = ()

    @property
    def all_skill_ids(self):
        return frozenset()


_EMPTY = _EmptyLearnset()


def validate_team(rs: Ruleset, team: Sequence[str],
                  loadouts: Optional[Dict[str, Sequence[str]]] = None,
                  also_in: Optional[Sequence[str]] = None,
                  team_size: int = 3) -> List[str]:
    """校验队伍与配招，返回问题列表（空 = 合法）。

    配招规则来自 M1 的数据：技能必须在该精灵的学习表里。
    「6 选 4」的形态属于 UI 约定，本函数只查**可学性**。

    `team_size` 是**这个模式每方上场几只**（RC-106）。默认 3 是给不经过 `reset()`
    的调用点（`service.team_evaluate` 的阵容评估、审计脚本）保持既有行为的：
    它们手上没有模式参数。正式开局路径上 `reset()` 一定传 `cfg.require_team_size()`。

    `also_in` 是「不在 team 里、但配招合法」的精灵 id（典型是**对手**那几只）：
    `loadouts` 常是一份合并了双方的 dict，只按我方队伍校验会把对手配招
    误报成「提到了不在队伍里的 pet」。
    """
    problems: List[str] = []
    if not isinstance(team_size, int) or isinstance(team_size, bool) or team_size <= 0:
        raise ValueError(f"team_size 必须是正整数，实际 {team_size!r}")
    if len(team) != team_size:
        problems.append(f"队伍必须是 {team_size} 只，实际 {len(team)}")
    if len(set(team)) != len(team):
        problems.append("队伍里有重复精灵")
    for pid in team:
        if pid not in rs.pets:
            problems.append(f"未知精灵 {pid}")
    if loadouts:
        allowed = set(team) | set(also_in or ())
        for pid, sids in loadouts.items():
            if pid not in allowed:
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


def require_declared_action_order(cfg: RuleConfig) -> Tuple[str, ...]:
    """配置声明的行动排序维度必须是引擎认识的名字（RC-103）。

    与 `require_declared_end_turn_stages` 同一条纪律：**不静默忽略**。
    引用了引擎不认识的维度名（例如 "weather"）时抛 `UnsupportedEffect`，
    而不是「跳过它、按认识的几个排」—— 那等于把一条没实现的规则当成没发生。
    """
    declared = tuple(cfg.action_order)
    unknown = [name for name in declared if name not in ACTION_ORDER_DIMENSIONS]
    if unknown:
        raise fx.UnsupportedEffect(
            f"行动排序维度「{'、'.join(unknown)}」",
            f"规则配置 {cfg.ruleset_config_id} 的 turn_order.action_order 声明了本引擎不认识的维度"
            f"（认识的：{'、'.join(ACTION_ORDER_DIMENSIONS)}）——"
            "不静默忽略，也不退回默认比较语义",
        )
    return declared


def _tie_is_decisive(entries: Sequence[Dict[str, Any]]) -> bool:
    """排序是不是**真的**要用到「平手」这一维。

    只看排序键的前三维 (respond, priority, speed)：只要有两个 entry 在这三维上完全相同，
    比较就会落到平手裁决上。这样「没有平手」的对局在 UNKNOWN 配置下仍然能跑 ——
    「不知道」只在**被问到**的时候才抛，不是一律抛。
    """
    keys = [(e["respond"], e["priority"], e["speed"]) for e in entries]
    return len(set(keys)) != len(keys)


def order_actions(
    state: GameState,
    rs: Ruleset,
    player_action: Action,
    enemy_action: Action,
    *,
    rng: random.Random,
    cfg: Optional[RuleConfig] = None,
) -> List[Tuple[str, Action]]:
    """把双方动作排成一个执行序列。

    排序键（从上到下）：
      1. 应对成功（术语 1015/1016/1017：「本次行动必定先手」）
      2. 先手度（术语 1020；主动换宠/道具折算成固定先手度，假设，MC-005）
      3. 速度（术语 1020 的补集：先手度相同时才比速度）
      4. 同速平手裁决 —— **策略来自配置**（MC-002 / MC-E05）

    第 4 维的纪律（RC-103）：
      · 配置写 `"random_seeded"` → 用 seed 驱动的确定性随机。这是**如实登记的工程权宜**，
        不是游戏规则（10 号文档 §8：speed tie = UNKNOWN）；
      · 配置写 `null`（UNKNOWN）→ **抛 `fx.UnsupportedEffect`**，而且只在排序真的需要
        这一维时抛（见 `_tie_is_decisive`）—— 不许用随机数假装知道规则。

    返回 [(side, action), ...]，按实际执行顺序。
    """
    cfg = cfg or _rule_config.get_rule_config()
    require_declared_action_order(cfg)
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
            "tie": None,
        })
    if _tie_is_decisive(entries):
        # 同速裁决策略：配置里的值优先；配置是 `null`（UNKNOWN，MC-E05 未录制）时
        # **只**接受本局显式声明的覆盖（`state.unverified_overrides`）——
        # 覆盖是带出处的引擎假设，会被一路带到公开面上让界面标「未核验」。
        # 没有覆盖就照旧抛错：这条 fail-closed 纪律一个字节都没放宽。
        from . import overrides as _ov_mod
        policy = _ov_mod.resolve_speed_tie(cfg, getattr(state, "unverified_overrides", None) or [])
        if policy in (None, "unknown"):
            raise fx.UnsupportedEffect(
                "速度平手裁决(speed_tie)",
                f"规则配置 {cfg.ruleset_config_id} 的 turn_order.speed_tie 是 UNKNOWN"
                f"（待录 microcase {cfg.speed_tie_microcase_id or '未登记'}）——"
                "本回合双方在 (应对成功, 先手度, 速度) 上完全相同，需要一个引擎没有依据的裁决；"
                "不许用随机数假装知道规则",
            )
        if policy not in _rule_config.SPEED_TIE_POLICIES:
            raise fx.UnsupportedEffect(
                "速度平手裁决(speed_tie)",
                f"规则配置 {cfg.ruleset_config_id} 的 turn_order.speed_tie={policy!r} 不是已知策略"
                f"（允许 {_rule_config.SPEED_TIE_POLICIES} 或 null）",
            )
    for e in entries:
        # 逐位不变：随机数的**消耗次数与顺序**（先 player 后 enemy）与改动前完全一致，
        # 不论上面走的是哪条策略分支。`random_seeded` 这个策略名是如实登记，不是规则。
        e["tie"] = rng.random()
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

    # 本回合按**这一局绑定的**规则配置结算（reset 时写进 state）。空串 = 老状态 /
    # 手工构造的状态，此时回落到当前生效配置（默认仍是 legacy）。
    cfg = _rule_config.get_rule_config(state.ruleset_config_id or None)

    for side, action in (("player", player_action), ("enemy", enemy_action)):
        if action not in legal_actions(state, rs, side):
            raise ValueError(f"{side} 的行动不合法：{action.label(rs)}")

    # 应对判定（术语 1015/1016/1017）需要知道对手这一手是什么。
    # 这两个字段只用于**结算**，绝不进入 observation（见 schema.observation_for）。
    setattr(state, "_pending_player", player_action)
    setattr(state, "_pending_enemy", enemy_action)

    rng = _rng_for(state)
    order = order_actions(state, rs, player_action, enemy_action, rng=rng, cfg=cfg)

    pre_player = observation_for(state, rs, "player")
    pre_enemy = observation_for(state, rs, "enemy")

    state.log.append(f"── 第 {state.turn} 回合 ──")
    _bump(state, "turn_start", {"turn": state.turn})

    # 回合开始时的特性：
    #   · 预警（黑猫巫师）—— 触发条件依赖未核验的伤害公式，只在显式驱动时生效；
    #   · 热成像 / 冷光源 —— 读**上回合记录**里有没有人用对应系别的技能（事实，不是推断）。
    # 先把「技能 id → 系别」缓存一次，特性判定要用；每回合重建，成本可忽略。
    tr.bind_skill_elements(rs)
    for side in ("player", "enemy"):
        evs: List[Dict[str, Any]] = []
        tr.on_turn_start(rs, state, side, evs)
        tr.element_trait(rs, state, side, evs)
        for e in evs:
            _bump(state, e.pop("kind"), e)

    # 冷却与临时标记在回合开始时递减/清除
    for side in (state.player, state.enemy):
        for p in side.pets:
            if p.defense_cooldown > 0:
                p.defense_cooldown -= 1
            # 防御技能的减伤只在**使用它的那个回合**有效（术语 1016 说
            # 防御技能进入 1 回合冷却，即下回合不能再用，而不是「减伤持续」）。
            # 这里曾经漏了清零：`_execute` 把 `_defense_reduction` 写在 PetState 上，
            # 而 PetState 是跨回合存活的，于是第 1 回合用过防御之后，
            # **之后每一个回合**受到的伤害都被再减一次（实测 -70%），
            # 而且它还会污染攻方自己的攻击（攻方行动时读的是它上一回合自己的减伤）。
            # 表现是伤害整体偏低、且与 buff 的预期倍率对不上。
            if getattr(p, "_defense_reduction", 0.0):
                setattr(p, "_defense_reduction", 0.0)

    for side, action in order:
        _execute(state, rs, side, action, cfg)

    _end_of_turn(state, rs, cfg)

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
    _advance_after_turn(state, cfg)

    return state


def _advance_after_turn(state: GameState, cfg: RuleConfig) -> None:
    """回合收尾：判胜负 / 进补位 / 推进回合（RC-105 抽出来的**同一个实现**）。

    语义与改动前**逐字相同**，只有一条新增分支：在**声明了 `mana` 或 `actions` 的配置**下，
    结算途中可能已经判出胜负（魔力归零、投降）——那时**不再覆盖**它。legacy / v2 没有这两块，
    `state.result` 只可能是结算途中的逃跑结果，走的仍然是原来那条路径，逐位不变。
    """
    if state.result is not None and (cfg.has_mana or cfg.allowed_kinds is not None):
        return
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


def _execute(state: GameState, rs: Ruleset, side: str, action: Action,
             cfg: Optional[RuleConfig] = None) -> None:
    # `cfg` 省略 = 手工/外部调用点：回落到当前生效配置（默认 legacy）。
    cfg = cfg or _rule_config.get_rule_config()
    me = getattr(state, side)
    foe_side = "enemy" if side == "player" else "player"
    foe = getattr(state, foe_side)
    pet = me.field_pet
    label = "你" if side == "player" else "对手"

    if not pet.alive:
        state.log.append(f"{label}的{rs.pet(pet.pet_id).name}已倒下，行动取消。")
        _bump(state, "action_cancelled", {"side": side, "reason": "fainted"})
        return

    if action.kind not in ACTION_KINDS_IMPLEMENTED:
        raise fx.UnsupportedEffect(
            f"动作类别「{action.kind}」",
            "本引擎没有这个动作类的结算实现（已知："
            f"{'、'.join(ACTION_KINDS_IMPLEMENTED)}）—— 不静默跳过",
        )
    # RC-105：声明了 `actions` 的配置下，一个**没被声明**的动作类不许被静默执行。
    # `step_joint` 的合法性检查通常已经挡住了这条路；这里再兜一层，因为 `_execute`
    # 也可以被直接调用（测试、脚本），而「配置写了 false 就必须抛」是配置层的承诺。
    if cfg.allowed_kinds is not None:
        if action.kind not in cfg.allowed_kinds and not cfg.unknown_kinds_allowed:
            raise fx.UnsupportedEffect(
                f"动作类别「{action.kind}」",
                f"规则配置 {cfg.ruleset_config_id} 的 actions.allowed_kinds 没有声明它，"
                "且 actions.unknown_kinds_allowed=false —— 不许静默执行未声明的动作类",
            )
    elif action.kind in (ACTION_CHARGE, ACTION_SURRENDER):
        # legacy / v2 **没有**声明 `actions`，因而也没有这两个动作类：它们只在 RC-105 的
        # 候选配置里存在（聚能是独立动作类、投降是标准 PVP 的退出方式）。
        # 没有声明就执行 = 凭空给默认路径加动作，所以这里 fail closed。
        raise fx.UnsupportedEffect(
            f"动作类别「{action.kind}」",
            f"规则配置 {cfg.ruleset_config_id} 没有声明 actions，因而也没有「{action.kind}」"
            "这个动作类（它是 RC-105 候选才引入的独立动作类）—— 不静默执行",
        )

    if action.kind == ACTION_SWITCH:
        target = me.pets[action.target_index or 0]
        pet.charge = None            # 主动离场会中断蓄力（术语 1007 的例外见 MC-021）
        me.active = action.target_index or 0
        target.entered_turn = state.turn
        target.used_burst = False
        state.log.append(f"{label}换上了{rs.pet(target.pet_id).name}。")
        _bump(state, "switch", {"side": side, "to_slot": target.slot}, evidence=("3009",))
        evs: List[Dict[str, Any]] = []
        tr.on_enter(rs, state, side, evs)
        for e in evs:
            _bump(state, e.pop("kind"), e)
        return

    if action.kind == ACTION_ESCAPE:
        state.result = "escaped"
        state.phase = "ended"
        state.log.append("你撤离了。")
        _bump(state, "escape", {"side": side})
        return

    if action.kind == ACTION_ITEM:
        _use_item(state, rs, side, action, cfg)
        return

    if action.kind == ACTION_CHARGE:
        _use_charge(state, rs, side, action, cfg)
        return

    if action.kind == ACTION_SURRENDER:
        _surrender(state, cfg, side)
        return

    skill = rs.skill(action.skill_id)
    pet.energy = max(0, pet.energy - skill.energy)   # 假设：消耗先扣（MC-007）

    # 出手前的特性（变形活画）：按对手增益层数给自己加威力与速度。
    act_evs: List[Dict[str, Any]] = []
    tr.on_action(rs, state, side, act_evs)
    for e in act_evs:
        _bump(state, e.pop("kind"), e)

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
        if succeeded:
            me._respond_count = int(getattr(me, "_respond_count", 0)) + 1
        _bump(state, "defense", {"side": side, "skill_id": skill.skill_id,
                                 "reduction": reduction, "respond": succeeded},
              evidence=("1015", "1016", "1017"))
        # 「应对攻击：自己获得魔攻+70%」这类**应对子句**：
        # 应对成功 → 真的应用（见 `_apply_effect_batch`）；
        # 应对失败 → **登记**为 unsupported，绝不能当成已生效。
        # 第 46 轮审计实测这一支以前直接 return：`buffs={}`、`unsupported=[]`，
        # 效果被静默丢弃。缺陷由 `roco/tests/test_fail_closed_branches.py` 钉住。
        parsed_def = parse.parse_skill(skill)
        if parsed_def.effects or parsed_def.unparsed:
            if succeeded:
                applied = _apply_effect_batch(state, rs, side, skill, parsed_def, cfg)
                state.log.append(
                    f"应对成功，{parsed_def.skill_name}的应对效果结算 {applied} 条。"
                )
            else:
                _register_parsed_effects(
                    state, rs, side, skill, parsed_def, applied=False,
                    reason="「应对成功」子句的条件没有成立（对手这一手不是该技能应对的类别）",
                )
            # 认不出来的机制词无论应对成不成功都要登记：它们不属于已结算的那部分。
            for span in parse.unclaimed_mechanic_spans(skill):
                _note_unsupported(
                    state, f"技能「{skill.name}」的附带机制",
                    f"描述里有引擎未认领的机制词 —— {span}；该段不在减伤与"
                    "「应对成功」子句的可结算范围内", skill.skill_id,
                )
        return

    if skill.is_status:
        applied = _apply_status_effects(state, rs, side, skill, cfg)
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

    # 伤害计算的全部细节都在 `effects.compute_damage` 里 —— **唯一实现**。
    # 这里以前是内联的一大段；抽出去的理由是 planner 的估值与服务端的伤害预览
    # 也需要算一个数，而内联版本逼得它们要么重复实现公式、要么索性不算
    # （结果是 planner 的启发式里根本没有伤害项，会把 40 威力排在 180 威力前面）。
    attacker_pet = rs.pet(pet.pet_id)
    defender_pet = rs.pet(defender.pet_id)
    outcome = fx.compute_damage(pet, defender, skill, rs,
                                attacker_species=attacker_pet,
                                defender_species=defender_pet)
    damage = outcome.damage
    actual = min(defender.hp, damage)
    defender.hp -= actual

    state.log.append(
        f"{label}的{attacker_pet.name}使用{skill.name}，对{defender_pet.name}造成 {actual} 伤害"
        f"{'（属性克制）' if outcome.type_multiplier > 1 else '（属性抵抗）' if outcome.type_multiplier < 1 else ''}"
        f"{'（防御减伤）' if outcome.defense_reduction else ''}。"
    )
    _bump(state, "damage", {
        "side": side,
        "skill_id": skill.skill_id,
        "target_slot": defender.slot,
        "damage": actual,
        "power_used": outcome.power,
        "conditional_power": outcome.conditional,
        "conditional_reason": outcome.conditional_reason,
        "type_multiplier": outcome.type_multiplier,
        "stab": outcome.stab,
        "ability_level": outcome.ability_level,
        "power_multiplier": outcome.power_multiplier,
        "damage_model": outcome.model,
        "formula_verified": outcome.verified,
    }, evidence=(skill.skill_id,))

    if defender.hp <= 0:
        defender.hp = 0
        defender.fainted = True
        defender.charge = None
        state.log.append(f"{defender_pet.name}倒下了。")
        _bump(state, "faint", {"side": foe_side, "slot": defender.slot}, evidence=("3009",))
        # RC-105：力竭 → 那一方扣魔力；归零就立即判负（只在声明了 mana 的配置下发生）
        _settle_faint_mana(state, rs, cfg, foe_side)

    # 附带效果：**先应用解析得出的部分，再登记认不出来的部分**。
    # 以前这里什么都没有 —— 「造成魔伤，自己回复1能量」被整条静默丢弃
    # （实测 energy 不变、events=['damage']、unsupported=[]）。纪律不允许：
    # 要么真的生效，要么如实登记。禁止把 unsupported 效果近似成普通伤害。
    parsed_atk = parse.parse_skill(skill)
    if parsed_atk.effects or parsed_atk.unparsed:
        applied = _apply_effect_batch(state, rs, side, skill, parsed_atk, cfg)
        if applied:
            state.log.append(f"{skill.name}的附带效果结算 {applied} 条。")
        # 解析不出来的、以及描述里没被任何解析结果认领的机制词，全部登记。
        _register_parsed_effects(
            state, rs, side, skill, parsed_atk, applied=True,
            reason="攻击分支只结算伤害、以及**已解析并已应用**的附带效果；"
                   "这一段没有对应的实现",
        )


def _apply_status_effects(state: GameState, rs: Ruleset, side: str, skill,
                          cfg: Optional[RuleConfig] = None) -> bool:
    cfg = cfg or _rule_config.get_rule_config()
    """应用一个状态技能被解析出来的效果。返回是否**至少应用了一条**。

    纪律：只有描述能被 `parse.py` 机械读出时才应用；解析出未覆盖机制时返回 False，
    由调用方登记为 unsupported。**不做部分应用**——半套效果比不支持更危险，
    因为它会让上层以为这个技能已经可用。
    """
    parsed = parse.parse_skill(skill)
    if not parsed.effects or parsed.unparsed:
        return False

    applied = _apply_effect_batch(state, rs, side, skill, parsed, cfg)

    if applied:
        me = getattr(state, side)
        label = "你" if side == "player" else "对手"
        state.log.append(
            f"{label}的{rs.pet(me.field_pet.pet_id).name}使用{skill.name}，应用 {applied} 条效果。"
        )
        _bump(state, "status_applied", {"side": side, "skill_id": skill.skill_id,
                                        "effects": applied})
        evs: List[Dict[str, Any]] = []
        tr.after_status_skill(rs, state, side, skill, evs)
        for e in evs:
            _bump(state, e.pop("kind"), e)
    return applied > 0


def _apply_effect_batch(state: GameState, rs: Ruleset, side: str, skill,
                        parsed, cfg: Optional[RuleConfig] = None) -> int:
    cfg = cfg or _rule_config.get_rule_config()
    """把 `parse.parse_skill` 解析出的一批效果应用到状态上，返回**应用成功的条数**。

    抽出来的理由（第 47 轮批 0）：攻击分支与防御分支以前完全不调用这段逻辑，
    于是描述里被解析出来的附带效果被**静默丢弃**——既没生效，也没进
    `state.unsupported`。两处缺陷由 `roco/tests/test_fail_closed_branches.py` 钉住。

    仍然不做部分应用：应用不了的（`escape` / `weather`）**登记**为 unsupported，
    计入返回值之外的 `state.unsupported`，绝不当成生效。
    「带假设的效果」（`self_energy`）会生效，但**同时**登记 assumption，
    让上层能说出「这个数字来自 MC-007 未定的时序」。
    """
    me = getattr(state, side)
    foe = getattr(state, "enemy" if side == "player" else "player")
    # RC-106：这一局用的是哪一份规则配置是**公开事实**（页面上就写着模式徽记），
    # 而且规划侧必须知道它——否则会拿 legacy 的口径去分析一份 v3 的局面。
    pet = me.field_pet
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
                # 未实现的持续状态：登记，不当成生效。
                _note_unsupported(
                    state, f"状态「{name}」", "该状态没有回合末结算实现（effects.py 未登记）",
                    skill.skill_id,
                )
                continue
            tgt = foe.field_pet
            tgt.statuses[name] = {
                "layers": tgt.statuses.get(name, {}).get("layers", 0) + int(v["layers"])
            }
            applied += 1
            _bump(state, "status_added", {"side": "enemy", "status": name,
                                          "layers": v["layers"]},
                  evidence=(spec.get("term", ""),))
            if name == "冻结":
                # 特性钩子（捉迷藏）。以前这一支永远不可达（前面的 elif 已经吃掉
                # 所有 `foe_status`），现在挂在同一个分支里。
                evs2: List[Dict[str, Any]] = []
                tr.after_freeze_applied(rs, state, side, evs2)
                for e in evs2:
                    _bump(state, e.pop("kind"), e)
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
        elif eff.kind == "self_energy":
            amount = int(v["amount"])
            before = pet.energy
            pet.energy = min(cfg.energy_max, pet.energy + amount)
            gained = pet.energy - before
            applied += 1
            # 时序未核验：能量上限 / 回合末回能 / 技能自带回能的先后顺序是 MC-007。
            # 这里选择「出手结算时立即回能」，并把**这个选择本身**登记出来。
            _note_unsupported(
                state, f"技能「{skill.name}」的自带回能时序",
                f"描述「{eff.evidence}」机械可读，因此按 {amount} 点结算；"
                "但「技能回能 vs 回合末回能 vs 能量上限」的先后顺序无一手证据（MC-007），"
                "本引擎按「出手结算时立即回能」处理",
                skill.skill_id,
            )
            _bump(state, "energy_gain", {
                "side": side, "skill_id": skill.skill_id, "amount": gained,
                "energy_after": pet.energy, "assumption": "MC-007",
                "evidence_text": eff.evidence,
            }, evidence=("MC-007",))
        elif eff.kind == "drain_energy":
            amount = int(v["amount"])
            taken = min(amount, foe.field_pet.energy)
            foe.field_pet.energy -= taken
            pet.energy = min(cfg.energy_max, pet.energy + taken)
            applied += 1
            _bump(state, "drain_energy", {"side": side, "taken": taken})
        elif eff.kind == "escape":
            # 术语 3003/3024：离场并换人。本引擎需要调用方决定换谁，所以登记为待处理。
            _note_unsupported(state, f"技能「{skill.name}」的离场效果",
                              "离场需要选择换上谁，属补位流程；引擎未自动代选", "3009")
        elif eff.kind == "weather":
            _note_unsupported(state, f"天气「{v['weather']}」", "引擎尚未实现天气层", "")
    return applied


def _register_parsed_effects(state: GameState, rs: Ruleset, side: str, skill,
                             parsed, *, applied: bool, reason: str) -> None:
    """攻击 / 防御分支的**登记**入口。

    这两个分支以前直接 `return`，描述里被解析出来却没被执行的效果连一条记录都没有。
    本函数把它们逐条登记进 `state.unsupported`，并附上**为什么没结算**。
    没有解析结果、也没有未认领机制词时它什么都不做（纯伤害技能不受影响）。

    `applied=True` 表示这批效果**刚刚被 `_apply_effect_batch` 处理过**：
    那时只登记「批量处理不了的那些」（离场 / 天气 / 未登记的状态），
    已经生效的不再重复登记。`applied=False` 表示一条都没结算（应对失败 / 攻击分支
    没吃下的部分），此时逐条登记。
    """
    unclaimed = parse.unclaimed_mechanic_spans(skill)
    handled_kinds = {
        "self_stat", "foe_stat", "self_mark", "foe_mark", "cleanse", "heal",
        "self_energy", "drain_energy",
    }
    for eff in parsed.effects:
        if applied and eff.kind in handled_kinds:
            continue
        if applied and eff.kind == "foe_status" and fx.END_OF_TURN_STATUS.get(str(eff.value["status"])):
            continue
        label = {
            "self_stat": "自己属性增减", "foe_stat": "敌方属性增减",
            "self_mark": "自己印记", "foe_mark": "敌方印记",
            "foe_status": "敌方持续状态", "cleanse": "驱散",
            "heal": "回复生命", "self_energy": "自带回能",
            "drain_energy": "偷取能量", "escape": "离场", "weather": "天气",
        }.get(eff.kind, eff.kind)
        _note_unsupported(
            state, f"技能「{skill.name}」的{label}",
            f"描述片段「{eff.evidence}」被解析出但未在此分支结算：{reason}",
            skill.skill_id,
        )
    for raw in getattr(parsed, "unparsed", ()) or ():
        _note_unsupported(
            state, f"技能「{skill.name}」的未解析机制",
            f"解析器没有覆盖这一段 —— {raw}；{reason}",
            skill.skill_id,
        )
    for span in unclaimed:
        _note_unsupported(
            state, f"技能「{skill.name}」的附带机制",
            f"描述里有引擎未认领的机制词 —— {span}；{reason}",
            skill.skill_id,
        )
    if parsed.effects or unclaimed or getattr(parsed, "unparsed", ()):
        _bump(state, "effects_registered_unsupported", {
            "side": side, "skill_id": skill.skill_id,
            "parsed_effects": len(parsed.effects), "unclaimed_spans": len(unclaimed),
            "unparsed_markers": len(getattr(parsed, "unparsed", ()) or ()),
            "reason": reason,
        })



def _opponent_action_of(state: GameState, side: str) -> Optional[Action]:
    """取对手本回合提交的动作——**仅用于结算判定**，不进入任何观察。"""
    return getattr(state, "_pending_" + ("enemy" if side == "player" else "player"), None)


# ── RC-105：魔力（心）结算 + 聚能 / 投降 ────────────────────────────────
#
# 只在**声明了 `mana`** 的配置下生效（`cfg.has_mana`）。legacy / v2 走这里每一处都会
# 立刻返回：那些模式里没有「魔力」这条概念，引擎不该凭空造出一个 0（0 = 已经判负）。


def _settle_faint_mana(state: GameState, rs: Ruleset, cfg: RuleConfig, fainted_side: str) -> None:
    """某方精灵力竭 → **那一方**扣 `mana.faint_cost`；魔力 ≤ 0 立即判负。

    依据：台账 EV-PVP-FAINT-MANA-LOSS（CROSS_SOURCE_SUPPORTED，MC-E09 未录制）——
    「目标是先让对方魔力归零，力竭通常扣 1 点魔力（而不是直接判负）」。
    等级是 CROSS_SOURCE_SUPPORTED 而不是官方原文，所以这是**候选口径**，不是已确认规则。
    """
    if not cfg.has_mana:
        return                      # legacy / v2：没有魔力这条概念，什么都不做
    if state.result:
        return                      # 已经判出胜负（例如另一方先归零）就不再扣
    side_state = getattr(state, fainted_side)
    if side_state.mana is None:
        return                      # 配置声明了 mana 但这一方没有 → 不该发生，别编一个数
    cost = cfg.mana_faint_cost
    if cost is None:
        raise fx.UnsupportedEffect(
            "力竭扣魔力的数额(mana.faint_cost)",
            f"规则配置 {cfg.ruleset_config_id} 声明了 mana，但 mana.faint_cost 是 UNKNOWN(null) ——"
            "不许按 0 或任意数处理",
        )
    side_state.mana = side_state.mana - int(cost)
    label = "你" if fainted_side == "player" else "对手"
    state.log.append(f"{label}的精灵力竭，{label}失去 {int(cost)} 点魔力（剩余 {side_state.mana}）。")
    _bump(state, "mana_loss", {
        "side": fainted_side,
        "faint_cost": int(cost),
        "mana": side_state.mana,
    }, evidence=("EV-PVP-FAINT-MANA-LOSS",))
    if cfg.mana_loss_when_zero:
        _finish_mana_depletion(state, cfg)


def _finish_mana_depletion(state: GameState, cfg: RuleConfig) -> None:
    """魔力 ≤ 0 → **立即**判负（另一方胜）。双方同时归零时判平局。

    依据：同上 EV-PVP-FAINT-MANA-LOSS 的 claim「目标是先让对方魔力归零」。
    「双方同一时刻归零怎么算」台账没有条目 —— 这里按平局处理，并把它登记为未知项
    （见报告 `unknowns`），**不**假装知道优先级。
    """
    player_mana = state.player.mana
    enemy_mana = state.enemy.mana
    if player_mana is None or enemy_mana is None:
        return
    player_out = player_mana <= 0
    enemy_out = enemy_mana <= 0
    if not player_out and not enemy_out:
        return
    if player_out and enemy_out:
        state.result = "draw"
    elif player_out:
        state.result = "loss"
    else:
        state.result = "win"
    state.phase = "ended"
    state.log.append({
        "win": "对手的魔力归零了，你赢了。",
        "loss": "你的魔力归零了。",
        "draw": "双方魔力同时归零。",
    }[state.result])
    _bump(state, "game_end", {
        "result": state.result,
        "reason": "mana_depleted",
        "player_mana": player_mana,
        "enemy_mana": enemy_mana,
    }, evidence=("EV-PVP-FAINT-MANA-LOSS",))


def _use_charge(state: GameState, rs: Ruleset, side: str, action: Action, cfg: RuleConfig) -> None:
    """聚能：回复 `energy.charge` 点能量（数值来自配置，**未知就抛**）。

    依据：台账 EV-ENERGY-CHARGE（CROSS_SOURCE_SUPPORTED，MC-E02 未录制）：
    「聚能是一个主动行动，回复 5」。台账同时明说**未定**的两件事 —— 可否突破上限、
    无合法技能时是否自动聚能 —— 所以这里只做「夹到上限」，并把这两条如实登记出来，
    绝不把它们当成已知规则。
    """
    me = getattr(state, side)
    pet = me.field_pet
    label = "你" if side == "player" else "对手"
    amount = cfg.energy_charge
    if amount is None:
        raise fx.UnsupportedEffect(
            "聚能的回能量(energy.charge)",
            f"规则配置 {cfg.ruleset_config_id} 的 energy.charge 是 UNKNOWN(null) ——"
            "引擎不知道聚能回多少能量，不许按 0 或任意数处理",
        )
    before = pet.energy
    pet.energy = min(cfg.energy_max, before + int(amount))
    gained = pet.energy - before
    state.log.append(
        f"{label}的{rs.pet(pet.pet_id).name}聚能，回复 {gained} 点能量（当前 {pet.energy}）。"
    )
    _note_unsupported(
        state, "聚能与能量上限的先后顺序",
        f"描述「聚能回复 {int(amount)} 点」按配置结算；但「聚能是否可突破上限」与"
        "「无合法技能时是否自动聚能」台账明说未定（MC-E02 未录制），"
        "本引擎按「夹到 energy.max」处理",
        "EV-ENERGY-CHARGE",
    )
    _bump(state, "charge", {
        "side": side, "energy_gained": gained, "energy": pet.energy,
    }, evidence=("EV-ENERGY-CHARGE",))


def _surrender(state: GameState, cfg: RuleConfig, side: str) -> None:
    """投降：**投降方判负**。

    台账里**没有**任何条目讲投降的语义（是否算判负、是否额外扣魔力、是否消耗回合），
    所以这是一个 `ENGINE_HYPOTHESIS`（配置 `mana.surrender` 的 reason 里写着同一件事），
    这里把它连同「本引擎按投降方判负处理」一起登记出来 —— 不假装它是已确认规则。
    """
    if state.result:
        return
    state.result = "loss" if side == "player" else "win"
    state.phase = "ended"
    state.log.append("你投降了，本局判负。" if side == "player" else "对手投降了，本局判胜。")
    _note_unsupported(
        state, "投降的结算语义",
        f"规则配置 {cfg.ruleset_config_id} 把投降列为合法动作类（mana.surrender），"
        "但台账与 10 号文档都没有条目定义它的语义（是否算判负、是否扣魔力、是否消耗回合）；"
        "本引擎按「投降方判负」处理，并把它登记为 ENGINE_HYPOTHESIS",
    )
    _bump(state, "surrender", {"side": side, "result": state.result})


def _use_item(state: GameState, rs: Ruleset, side: str, action: Action,
              cfg: Optional[RuleConfig] = None) -> None:
    cfg = cfg or _rule_config.get_rule_config()
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
        target.energy = min(cfg.energy_max, target.energy + amount)
        _bump(state, "item", {"side": side, "item": item_id, "energy_gained": target.energy - before})
    elif kind == "cleanse":
        cleared = list(target.statuses)
        target.statuses.clear()
        _bump(state, "item", {"side": side, "item": item_id, "cleared": cleared})
    else:
        _note_unsupported(state, f"道具「{item_id}」", "未实现", item_id)


def require_declared_end_turn_stages(cfg: RuleConfig) -> Tuple[str, ...]:
    """把配置声明的回合末阶段与引擎**实现**的阶段对一遍；任何一边对不上都抛错。

    RC-103 的核心纪律：**不静默跳过、不默认顺序**。
      · 配置声明了引擎没实现的阶段 → 引擎不知道怎么结算它 → 抛（消息点名阶段）；
      · 引擎需要结算的阶段没被声明 → 配置不完整 → 抛（消息点名阶段）。
    `turn_order.end_turn.unknown_stages_allowed` 为真时也抛：那等于允许「未知阶段」，
    与 fail closed 直接冲突（配置加载期已经拒过一次，这里再兜一层）。
    """
    if cfg.end_turn_unknown_stages_allowed:
        raise fx.UnsupportedEffect(
            "回合末未声明阶段放行(unknown_stages_allowed)",
            f"规则配置 {cfg.ruleset_config_id} 的 turn_order.end_turn.unknown_stages_allowed=true，"
            "等于允许回合末存在未知阶段 —— 本引擎不允许（不知道就先抛，RC-103）",
        )
    declared = tuple(cfg.end_turn_order)
    unknown = [name for name in declared if name not in END_TURN_STAGES_IMPLEMENTED]
    if unknown:
        raise fx.UnsupportedEffect(
            f"回合末阶段「{'、'.join(unknown)}」",
            f"规则配置 {cfg.ruleset_config_id} 的 turn_order.end_turn.order 声明了它，"
            f"但本引擎没有实现这个阶段（引擎实现：{'、'.join(END_TURN_STAGES_IMPLEMENTED)}）——"
            "不静默跳过，也不退回默认顺序",
        )
    missing = [name for name in END_TURN_STAGES_IMPLEMENTED if name not in declared]
    if missing:
        raise fx.UnsupportedEffect(
            f"回合末阶段「{'、'.join(missing)}」",
            f"规则配置 {cfg.ruleset_config_id} 的 turn_order.end_turn.order 没有声明它，"
            f"但引擎需要结算这个阶段（引擎实现：{'、'.join(END_TURN_STAGES_IMPLEMENTED)}）——"
            "少一个阶段就不许只按「剩下的」结算",
        )
    return declared


def _end_turn_status_tick(state: GameState, rs: Ruleset, side: SideState, pet: PetState,
                          cfg: Optional[RuleConfig] = None) -> None:
    """结算一只在场精灵身上的所有状态伤害（术语 1001/1002/1008）。"""
    cfg = cfg or _rule_config.get_rule_config(state.ruleset_config_id or None)
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
            # RC-105：被状态伤害打死同样触发「力竭扣魔力」（只在声明 mana 的配置下）
            _settle_faint_mana(state, rs, cfg, side.name)
            break


def _end_turn_regen(state: GameState, side: SideState, pet: PetState, cfg: RuleConfig) -> None:
    """回合末回能（数值来自配置：`energy.regen.per_turn` + `energy.max` 夹取）。"""
    before = pet.energy
    pet.energy = min(cfg.energy_max, pet.energy + cfg.energy_regen_per_turn)
    if pet.energy != before:
        _bump(state, "energy_regen", {"side": side.name, "energy": pet.energy})


def _end_of_turn(state: GameState, rs: Ruleset,
                 cfg: Optional[RuleConfig] = None) -> None:
    """回合末结算：**按配置声明的阶段顺序**逐个结算（RC-103）。

    依据：术语 1001/1002/1008 都写「回合结束时」造成百分比伤害；1002 额外衰减层数。
    **组内顺序本身没有一手证据**（台账没有登记这一条，10 号文档 §7 也这么说），
    所以这里不写死顺序，只做两件事：

      1. 按 `turn_order.end_turn.order` 声明的顺序结算（阶段名 → 下面的实现映射）；
      2. 声明与实现只要对不上就抛 `fx.UnsupportedEffect`（见 `require_declared_end_turn_stages`）。

    顺序的作用域是**每一只在场精灵内部**：先算这只的状态伤害，再算这只的回能。
    这正是 `["status_tick", "regen"]` 声明的语义；把它读成「全体先状态伤害、再全体回能」
    会改变日志与事件顺序，也就是改掉默认行为。
    """
    cfg = cfg or _rule_config.get_rule_config()
    stages = require_declared_end_turn_stages(cfg)
    for side in (state.player, state.enemy):
        # RC-105：魔力归零已经在结算途中判出胜负 —— 不再继续结算回合末，
        # 也不覆盖那个结果。legacy / v2 没有 mana（`has_mana=False`），这条不触发。
        if cfg.has_mana and state.result:
            return
        pet = side.field_pet
        if not pet.alive:
            continue
        for stage in stages:
            # 与改动前一致：被自己的状态伤害打死的那只不再回能（原来是 `if pet.alive:` 那道门）
            if not pet.alive:
                continue
            if stage == "status_tick":
                _end_turn_status_tick(state, rs, side, pet, cfg)
            elif stage == "regen":
                _end_turn_regen(state, side, pet, cfg)
            else:                                     # pragma: no cover - 上面已经挡过
                raise fx.UnsupportedEffect(
                    f"回合末阶段「{stage}」",
                    f"规则配置 {cfg.ruleset_config_id} 声明了它，但本引擎没有对应的实现 ——"
                    "不静默跳过",
                )


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


def deserialize(d: Dict[str, Any], rs: Optional[Ruleset] = None,
                config: Optional[Any] = None) -> GameState:
    """把私有序列化状态还原成 `GameState`。

    `config`：**这一份记录当时用的规则配置**。RC-106 起必须由调用方按记录里的
    `ruleset_config_id` 显式传入（`service._private_state` 就是这么做的）——
    否则标准 PVP 的存档会被拿去跟「当前默认的 legacy」比，然后被判成「不同配置不可混用」
    （真实的集成 bug：浏览器里点「开一局（标准 PVP）」之后，规划接口直接 502）。
    不传时退回旧口径（与当前默认配置比），legacy 行为逐位不变。
    """
    rs = rs or load_ruleset()
    if d.get("ruleset_id") != rs.ruleset_id:
        raise fx.UnsupportedEffect(
            f"规则集不匹配：记录是 {d.get('ruleset_id')}，当前是 {rs.ruleset_id}",
            "不同规则集的状态不可混用",
        )
    # 规则配置也必须是**同一份**：否则存档会在不知不觉间换掉能量上限这类基线。
    # 老存档没有这个字段（旧引擎没有它），此时按「未绑定」处理，由调用方决定。
    recorded = d.get("ruleset_config_id", "")
    current = getattr(config, "ruleset_config_id", None) or _rule_config.default_ruleset_config_id()
    if recorded and recorded != current:
        raise fx.UnsupportedEffect(
            f"规则配置不匹配：记录是 {recorded}，当前是 {current}",
            "不同规则配置的状态不可混用（RC-101）；要重放旧记录请显式选择它当时的那份配置",
        )
    return GameState.from_dict(d)


def replay(record: Dict[str, Any], rs: Optional[Ruleset] = None,
           config: Optional[Any] = None) -> GameState:
    """按记录重放一局，返回最终状态。

    记录格式::

        {"team": [...], "enemy_team": [...], "seed": int,
         "loadouts": {"pet_id": ["skill_id", ...]},   # 可选，但**必须**带上才能回放非规范配招
         "unverified_overrides": [...],               # 可选：这一局用过的未核验覆盖（RC-106）
         "actions": [[a, b], ...]}

    每一对是双方同一回合的联合动作。

    回放可复现的前提有两条：

    1. 本引擎里所有随机都来自 (seed, turn)，没有任何地方读时钟或全局随机；
    2. **配招要一起带上。** 合法动作是按配招枚举的（一只精灵只带 4 个技能），
       所以用非规范配招打出来的记录，若回放时不传 `loadouts`，
       `reset()` 会退回规范配招，那个技能就不再合法，回放直接抛
       「行动不合法」。这个 bug 是我写「状态技能增减能否重放」的测试时撞出来的。

    RC-106 补第 3 条：**覆盖也要一起带上**。六宠候选局的 `energy.initial` 是
    UNKNOWN，不带上那条覆盖，`reset()` 会 fail closed —— 那份记录就永远重放不了。
    """
    rs = rs or load_ruleset()
    # 规则配置可以来自调用方，也可以来自记录本身（记录里带了就用记录里那份：
    # 旧 replay 因此**绑死**在它当时的那份规则上，不会被当前默认配置悄悄改写）。
    chosen = config or record.get("ruleset_config_id") or None
    state = reset(record["team"], record.get("enemy_team"), seed=record["seed"], rs=rs,
                  loadouts=record.get("loadouts"), config=chosen,
                  unverified_overrides=record.get("unverified_overrides"))
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



# ── 公开 planner state（隐藏信息的第二道边界）────────────────────────────
#
# 为什么需要它：`serialize()` 是**引擎的完整内部状态**，里面有真实 seed、
# 对手本回合已提交的动作、对手后备的血量。把整份递给教练等于把隐藏信息递过去。
# 教练只能看公开信息（产品红线），所以规划请求走这个 schema。
#
# 与 observation 的区别：observation 是「玩家能看到什么」，
# 公开 planner state 是「规划器需要什么」——它多带 turn / phase / 后备存活情况，
# 但**没有** seed、没有 pending、没有对手后备的具体血量与配招。

PUBLIC_PLANNER_SCHEMA_VERSION = 1

# 重建搜索状态时对方后备的**未知量**怎么填。这些值不是「猜对手」，而是
# 「我们不知道，因此按名义值建模，并在 limitations 里写明」。
# 之所以可以这样：规划只用于给出取舍建议，任何依赖对手后备精确血量的结论
# 都会因为这次简化而偏乐观——所以必须如实标注，且分析要跨多个 analysis seed 聚合。
OPPONENT_BENCH_ASSUMPTION = "full_hp_nominal_loadout"


def public_planner_state(state: "GameState", rs: Ruleset, side: str = "player") -> Dict[str, Any]:
    """把对局状态裁剪成**可以安全交给教练**的规划输入。

    只保留公开字段：
      - 回合、阶段、结果、规则集 id、状态版本
      - 双方**场上**面板（生命、能量、公开状态与印记、防御冷却、蓄力与否、增益）
      - 己方后备的完整面板与配招（自己的信息）
      - 对手后备**只有**位次、精灵 id、是否倒下、现在的 active 位（术语 3010 的公开部分）
    绝不包含：seed、随机源、`_pending_*`、对手后备血量/能量/配招。
    """
    me = getattr(state, side)
    foe = getattr(state, "enemy" if side == "player" else "player")

    def own_pet(p: PetState) -> Dict[str, Any]:
        return {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "hp": p.hp,
            "max_hp": p.max_hp,
            "energy": p.energy,
            "fainted": p.fainted,
            "statuses": {k: dict(v) for k, v in p.statuses.items()},
            "marks": dict(p.marks),
            "buffs": dict(p.buffs),
            "defense_cooldown": p.defense_cooldown,
            "charging": bool(p.charge),
            "entered_turn": p.entered_turn,
        }

    def foe_field_pet(p: PetState) -> Dict[str, Any]:
        # 对手**场上**的面板是公开的：生命条、能量、异常与印记都写在屏幕上
        return {
            "slot": p.slot,
            "pet_id": p.pet_id,
            "hp": p.hp,
            "max_hp": p.max_hp,
            "energy": p.energy,
            "fainted": p.fainted,
            "statuses": {k: dict(v) for k, v in p.statuses.items()},
            "marks": dict(p.marks),
            "defense_cooldown": p.defense_cooldown,
            "charging": bool(p.charge),
        }

    return {
        "schema_version": PUBLIC_PLANNER_SCHEMA_VERSION,
        "ruleset_id": state.ruleset_id,
        # RC-106：这一局的规则配置也是公开事实（页面渲染模式徽记要用，规划侧要靠它选口径）。
        "ruleset_config_id": state.ruleset_config_id or None,
        "state_version": state.state_version,
        "side": side,
        "turn": state.turn,
        "phase": state.phase,
        "result": state.result,
        # RC-105：魔力是**公开**信息（它就是胜负判据，两边的界面都画着它）。
        # 只有声明了 mana 的配置才有这一个键：legacy / v2 里这条概念不存在，
        # 补一个 0 会被读成「已经判负」。
        **({"mana": {"self": me.mana, "opponent": foe.mana}}
           if (me.mana is not None or foe.mana is not None) else {}),
        # RC-106：这一局用过的**未核验覆盖**必须如实出现在公开面里 —— 它改变的是
        # **规则值本身**（例如入场初始能量），而规则值对双方一样、页面上也写着。
        # 藏起来会更坏：页面把「候选口径下的 2」显示成「标准 PVP 的入场能量」，
        # 也就是把一个假设说成事实。没有覆盖时这里是空数组（键始终在）。
        "unverified_overrides": list(state.unverified_overrides),
        "self": {
            "active": me.active,
            "items": dict(me.items),
            # 配招是自己的信息，可以给
            "loadouts": {k: list(v) for k, v in (me.loadouts or {}).items()},
            "pets": [own_pet(p) for p in me.pets],
        },
        "opponent": {
            "active": foe.active,
            "living_count": len(foe.living()),
            "field": foe_field_pet(foe.field_pet),
            # 后备：只有位次 / id / 是否倒下。**没有血量、没有配招。**
            "bench": [
                {"slot": p.slot, "pet_id": p.pet_id, "fainted": p.fainted}
                for i, p in enumerate(foe.pets) if i != foe.active
            ],
        },
        "assumptions": {
            "opponent_bench": OPPONENT_BENCH_ASSUMPTION,
            "note": "对手后备的血量与配招不在公开信息里，重建搜索状态时按满血 + 规范配招建模；"
                    "任何依赖对手后备精确血量的结论都会因此偏乐观。",
        },
    }


UI_PUBLIC_VIEW_SCHEMA_VERSION = 1


def ui_action_public(action: Dict[str, Any], rs: Ruleset) -> Dict[str, Any]:
    """合法动作补上 UI 需要的东西：技能名、系别、能耗、威力与**来源状态**。

    `power_status` 必须原样带出来：来源没给威力的技能，界面上要显示成
    「来源未给威力」，**不许**补一个数字（那是编数据）。

    这一处是**唯一实现**：`service._sim_envelope` 里给协议用的 `legal` 也走它
    （再剔掉 `skill` 那一段），避免两处各写一份、然后其中一处漏字段。
    """
    out = dict(action)
    skill_id = action.get("skill_id")
    if not skill_id:
        return out
    try:
        skill = rs.skill(skill_id)
    except Exception:  # noqa: BLE001
        return out
    out["skill"] = {
        "name": skill.name,
        "element": getattr(skill, "element", None),
        "category": getattr(skill, "category", None),
        "energy": getattr(skill, "energy", None),
        "power": getattr(skill, "power", None),
        "power_status": getattr(skill, "power_status", None),
        "damage_class": getattr(skill, "damage_class", None),
        "desc": getattr(skill, "desc", None),
        "is_trait": bool(getattr(skill, "is_trait", False)),
        "effect_support": getattr(skill, "effect_support", None),
    }
    return out


def ui_legal_actions(state: "GameState", rs: Ruleset, side: str) -> List[Dict[str, Any]]:
    """UI 用的合法动作：与协议 `legal` 同形，但每个技能动作带 `skill` 说明。"""
    out: List[Dict[str, Any]] = []
    for action in legal_actions(state, rs, side):
        d = action.to_dict()
        d["label"] = action.label(rs)
        if action.kind == "skill" and action.skill_id:
            d["skill_name"] = rs.skill(action.skill_id).name
        out.append(ui_action_public(d, rs))
    return out


def ui_public_view(state: "GameState", rs: Ruleset, side: str = "player") -> Dict[str, Any]:
    """**给浏览器 UI 看**的公开视图。与 `public_planner_state` 是**两条并行的协议**。

    为什么要分开（第 42 轮，用户实测反馈）
    ------------------------------------
    `public_planner_state` 是**交给模型规划用的最小协议**——它刻意不含 `name`，
    因为名字对搜索没有用、只是白烧 token。而页面一直拿它当 UI 状态用，于是玩家看到的是
    `pet_000225` 而不是「寂灭骨龙」。

    正确的修法**不是**给规划协议加 `name`（那会为了 UI 扩大模型协议，且每个 token 都要付钱），
    而是让 UI 有自己的视图：两边都从同一份权威状态生成，各自只带自己需要的东西。

    公开性口径（按手游里**屏幕上能看到的**）
    --------------------------------------
      · 己方全体：名字、系别、六维、血/能量、异常、印记、配招——都是自己的信息；
      · 对手**场上**：名字、系别、血/能量、异常、印记——血条与名字就画在屏幕上；
      · 对手**后备**：**只有位次与是否倒下**。手游里后备直到上场才亮明，
        所以这里不给名字、不给血、不给配招（与 `public_planner_state` 同一条公开性规则）；
      · `state_version` / `turn` / `phase` / `result` 与规划协议**必须一致**——
        两个视图描述的是同一时刻的同一局，不一致就是 bug。
    """
    view = public_planner_state(state, rs, side)
    me = getattr(state, side)
    foe = getattr(state, "enemy" if side == "player" else "player")

    def pet_public(pet_id: str) -> Dict[str, Any]:
        """从规则集取展示用的静态信息。查不到就如实留空，不猜。"""
        try:
            pet = rs.pet(pet_id)
        except Exception:  # noqa: BLE001 — 规则集里没有这只精灵时必须能降级
            return {"name": None, "types": [], "stats": None, "class": None, "stage": None}
        return {
            "name": pet.name,
            "types": list(getattr(pet, "types", []) or []),
            "stats": dict(getattr(pet, "stats", {}) or {}) or None,
            "class": getattr(pet, "pet_class", None),
            "stage": getattr(pet, "stage", None),
        }

    def decorate(panel: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(panel)
        out.update(pet_public(panel.get("pet_id")))
        return out

    # 能量上限：**从当前生效的规则配置里读**，不在这里写死。
    #
    # 为什么要放进公开视图：教练层（`src/coach/coach-advice.js` 的「对面能量快满了」）
    # 需要知道「离满还差多少」才有话可说。它以前自己抄了一份能量上限常量，
    # 于是规则一改就会漂；现在它只认这个字段，**读不到就沉默**（不猜默认值）。
    # 这属于「屏幕上看得见的信息」：手游里能量条的上限就画在血条旁边。
    cfg = _rule_config.get_rule_config(state.ruleset_config_id or None)
    energy_max = cfg.energy_max

    self_panel = dict(view["self"])
    self_panel["energy_max"] = energy_max
    self_panel["pets"] = [decorate(p) for p in view["self"]["pets"]]
    # 己方当前可用的技能（配招里那一套），UI 的技能面板直接用它
    self_panel["skills"] = [
        ui_action_public({"skill_id": sid, "kind": "skill"}, rs)
        for sid in sorted({sid for ids in (me.loadouts or {}).values() for sid in ids})
    ]
    # UI 自己的合法动作表（带技能说明）。协议那份 `legal` 在 service 里，
    # 字段一个都不变——两条链各取所需。
    ui_legal = {
        "player": ui_legal_actions(state, rs, "player"),
        "enemy": ui_legal_actions(state, rs, "enemy"),
    }

    foe_panel = dict(view["opponent"])
    # 对手的能量上限是**规则常量**（不是隐藏信息）：双方用同一份规则配置。
    foe_panel["energy_max"] = energy_max
    foe_panel["field"] = decorate(view["opponent"]["field"]) if view["opponent"]["field"] else None
    # 后备：**只给位次与是否倒下**，连 `pet_id` 都不给。
    #
    # 规划协议里后备是带 `pet_id` 的（重建搜索状态要用），但 UI 不该拿它：
    #   ① 手游里后备直到上场才亮明，提前给 id 等于泄露对手阵容；
    #   ② 就算给了，页面上也只能渲染成 `pet_000190` —— 又一个 ID 占位。
    # 所以 UI 这一侧只保留「这个位次还在不在」。这条是**公开性假设**，
    # 写进 `notes` 而不是当成既定事实。
    foe_panel["bench"] = [{"slot": b.get("slot"), "fainted": b.get("fainted")}
                          for b in view["opponent"]["bench"]]

    # RC-106：未核验覆盖在 UI 面里**两处都写**：机器可读的那份（与规划协议逐字相同）
    # 与一句可直接渲染的话（`notes.unverified_overrides`），后者让页面不必自己拼
    # 「哪个字段被假设成了多少」。句子只陈述事实（路径 / 值 / 不是实机结论）。
    unverified = [dict(entry) for entry in (view.get("unverified_overrides") or [])]
    notes_overrides = [
        f"候选规则：{e.get('path')} 按假设值 {e.get('value')}（{e.get('confidence')}，"
        f"待录 {e.get('microcase_id') or '未登记'}）开局 —— 不是实机结论，界面须标「未核验」"
        for e in unverified
    ] or ["本局没有使用任何未核验覆盖：规则值全部来自规则配置本身"]

    return {
        "schema_version": UI_PUBLIC_VIEW_SCHEMA_VERSION,
        "ruleset_id": view["ruleset_id"],
        # RC-106：模式徽记与规划口径都要它（与规划协议那一份逐字相同）。
        "ruleset_config_id": view.get("ruleset_config_id"),
        # 与规划协议同一时刻的同一局：这三个字段必须逐字相同
        "state_version": view["state_version"],
        "turn": view["turn"],
        "phase": view["phase"],
        "result": view["result"],
        "side": side,
        # RC-105：魔力（若这份配置声明了它）。两个视图描述同一时刻的同一局，
        # 所以这一块照抄规划协议那一份，不另算一遍。
        **({"mana": view["mana"]} if "mana" in view else {}),
        # RC-106：未核验覆盖同上，照抄规划协议那一份。
        "unverified_overrides": unverified,
        "self": self_panel,
        "opponent": foe_panel,
        "legal": ui_legal,
        "notes": {
            "opponent_bench": "后备只给位次与是否倒下：手游里后备直到上场才亮明",
            "coach_protocol": "教练/规划用的是另一份最小协议（public_planner_state），"
                              "两者描述同一时刻，字段各自独立",
            "unverified_overrides": notes_overrides,
        },
    }


def state_from_public_planner(
    public: Dict[str, Any],
    rs: Ruleset,
    *,
    analysis_seed: int,
) -> "GameState":
    """由**公开** planner state 重建一个用于分析的 `GameState`。

    重建规则（每一步都可解释）：
      - 真实 seed 不参与。`analysis_seed` 由调用方给出（固定值或由公开状态指纹派生），
        与真实对局 seed 无关。
      - 对手后备按 `OPPONENT_BENCH_ASSUMPTION` 建模：满血 + 规范配招。
      - 重建出来的状态**只用于规划与估值**，不是权威对局状态；回执里必须说明这一点。
    """
    if public.get("schema_version") != PUBLIC_PLANNER_SCHEMA_VERSION:
        raise ValueError(f"公开 planner state 版本不支持：{public.get('schema_version')}")
    if public.get("ruleset_id") != rs.ruleset_id:
        raise ValueError(f"规则集不匹配：{public.get('ruleset_id')} vs {rs.ruleset_id}")

    side = public.get("side", "player")
    other = "enemy" if side == "player" else "player"

    def mk_own(d: Dict[str, Any]) -> PetState:
        p = PetState(
            pet_id=d["pet_id"], slot=int(d["slot"]),
            hp=int(d["hp"]), max_hp=int(d["max_hp"]), energy=int(d.get("energy", 0)),
            statuses=dict(d.get("statuses") or {}), marks=dict(d.get("marks") or {}),
            buffs=dict(d.get("buffs") or {}),
            defense_cooldown=int(d.get("defense_cooldown", 0)),
            charge=d.get("charging") or None,
            entered_turn=d.get("entered_turn"),
            fainted=bool(d.get("fainted", False)),
        )
        return p

    def mk_foe_field(d: Dict[str, Any]) -> PetState:
        return PetState(
            pet_id=d["pet_id"], slot=int(d["slot"]),
            hp=int(d["hp"]), max_hp=int(d["max_hp"]), energy=int(d.get("energy", 0)),
            statuses=dict(d.get("statuses") or {}), marks=dict(d.get("marks") or {}),
            defense_cooldown=int(d.get("defense_cooldown", 0)),
            charge=d.get("charging") or None,
            fainted=bool(d.get("fainted", False)),
        )

    def mk_bench_assumed(pet_id: str, slot: int) -> PetState:
        """对手后备：满血 + 规范配招（公开信息里没有，按假设建模）。"""
        p = _make_pet(rs, pet_id, slot, 1)
        p.entered_turn = None
        return p

    own = public["self"]
    foe = public["opponent"]

    own_pets = [mk_own(p) for p in own["pets"]]
    own_active = int(own["active"])

    # 对手队列：先放场上那只，再把后备按位次补齐
    foe_slots: Dict[int, PetState] = {}
    field = mk_foe_field(foe["field"])
    foe_slots[int(field.slot)] = field
    for b in foe.get("bench", []):
        slot = int(b["slot"])
        assumed = mk_bench_assumed(b["pet_id"], slot)
        if b.get("fainted"):
            assumed.hp = 0
            assumed.fainted = True
        foe_slots[slot] = assumed
    n = max(foe_slots) + 1 if foe_slots else 1
    foe_pets = []
    for i in range(n):
        if i in foe_slots:
            foe_pets.append(foe_slots[i])
        else:
            # 公开信息里连位次都没给全时，用规范配招补一个占位（仍会被标注为假设）
            fallback_id = rs.candidate_movesets and next(iter(rs.candidate_movesets)) or None
            if fallback_id is None:
                raise ValueError("无法重建对手队伍：公开信息缺位次且规则集没有规范配招")
            foe_pets.append(mk_bench_assumed(fallback_id, i))

    state = GameState(
        ruleset_id=rs.ruleset_id,
        # 规则配置与未核验覆盖一样，属于「这一局的公开事实」：规划侧要靠它选对口径。
        ruleset_config_id=str(public.get("ruleset_config_id", "") or ""),
        seed=int(analysis_seed),          # 分析用的种子，与真实对局无关
        player=SideState(name=side, pets=own_pets, active=own_active,
                         items=dict(own.get("items") or {})),
        enemy=SideState(name=other, pets=foe_pets, active=int(foe["active"]),
                        items=dict(DEFAULT_ITEM_STOCK)),
        turn=int(public.get("turn", 1)),
        phase=str(public.get("phase", "battle")),
        result=public.get("result"),
        state_version=int(public.get("state_version", 0)),
    )
    # 己方配招来自公开信息；对手配招是假设值
    state.player.loadouts = {k: tuple(v) for k, v in (own.get("loadouts") or {}).items()}
    # RC-106：未核验覆盖是**公开事实**，重建时一并带过去（否则差分分析会以为
    # 这一局的入场能量来自配置，而配置里它是 UNKNOWN）。
    state.unverified_overrides = [dict(entry) for entry in (public.get("unverified_overrides") or [])]
    # RC-105：魔力（若公开面里带了）。缺键 → None（= 那份配置没有魔力系统），**不是 0**。
    mana_public = public.get("mana")
    if isinstance(mana_public, dict):
        state.player.mana = mana_public.get("self")
        state.enemy.mana = mana_public.get("opponent")
    if side != "player":
        # 保证 player/enemy 两个名字都可用（内部一律用 player/enemy 命名）
        state.player, state.enemy = state.enemy, state.player
    state.enemy.loadouts = {p.pet_id: rs.candidate_moveset(p.pet_id) for p in state.enemy.pets}
    return state

def observe(state: GameState, rs: Ruleset, side: str) -> Dict[str, Any]:
    """公开观察。隐藏信息的唯一边界。"""
    return observation_for(state, rs, side)
