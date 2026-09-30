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
  - 连击数、属性增减的层数语义
  - **天气**：2026-09-25 人类裁决后，天气**在标准 PVP 里存在**（官方一手 4/14《洛个明白》
    闪耀大赛入门篇逐字「天气是常驻在全场的效果…但天气只能存在一种」）—— 本节上面那条
    旧口径「天气」已作废，实现见 `set_weather` / `_end_turn_weather`。
    **但天气是配置声明的能力**：规则集没声明 `policies.weather_policy` 时，引擎
    **不发明**任何天气行为（技能里的「将天气改为…」照旧登记 unsupported）。
    仍未实现、如实登记的三处：冻结层数的结算（术语 1004）、引电 2 层的立即结算（3022）、
    「能耗减半」遇奇数能耗的取整。
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

import dataclasses
import math
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import effects as fx
from . import parse
from . import traits as tr
from . import data as _data
from . import overrides as _overrides
from . import rule_config as _rule_config
from . import individuals as _individuals
from .data import Ruleset, load_ruleset
from .rule_config import RuleConfig, RuleConfigError
from .schema import (
    ACTION_CHARGE,
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_MAGIC,
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
# ⚠ 下面两个常量**有意冻结默认（legacy）配置** = `6` / `1`
#   （`roco/tests/test_rule_config.py:210-211` 逐字钉着 ✓ —— 15 处读者全在 `roco/tests` ✓）；
#   v3 是 `10` / `0` ✓（同文件 `:295` 逐字钉着「两者不同」✓）⇒ **它们只服务于「默认 / legacy 口径」** ✓。
#   ⚠ **若将来在「对局路径」上要用（v3 的 `10`/`0`）⇒ 必须按 #49 从 `cfg` 取** ✗（不许直接读这两个常量 ✗）。
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

#: task-28（H 族 `285 退化`「敌方获得1层萌化」）：**「萌化」是带层数的标记**（`PetState.marks` ✓），
#: **不是回合末状态** ✗ ⇒ 它**不进** `END_OF_TURN_STATUS`（进了就是"凭空 tick" ⇒ **假绿** ✗）。
#: 语义依据（语料逐字）：`285`/`732` 都写「**1层**萌化」⇒ 带层数 ✓；10 条里**没有一条**让萌化自己造成效果 ✓
#: ⚠ 本表**只放"标记化"的状态名**；`foe_status` 里其余的（中毒/灼烧/寄生）**照旧**走 `END_OF_TURN_STATUS` ✓
STATUS_AS_MARK: Tuple[str, ...] = ("萌化",)

#: RC-105：引擎**真的会产出**的动作类。配置的 `actions.allowed_kinds` 里出现别的名字
#: （例如 `struggle` —— 它在 `VALID_KINDS` 里，但本引擎不会把它列进合法动作）就抛错：
#: 声明了一个引擎产不出的动作类，等于把「没实现」说成「已支持」。
ACTION_KINDS_IMPLEMENTED: Tuple[str, ...] = (
    ACTION_SKILL, ACTION_CHARGE, ACTION_SWITCH, ACTION_SURRENDER, ACTION_ITEM, ACTION_ESCAPE,
    # 2026-09-23：`magic`（PVP 魔法：愿力强化）真的会被产出（见 `_use_magic` 与
    # `legal_actions` 的 magic 分支），所以必须列进来 —— 否则配置一旦声明它，
    # 加载期就会按「声明了引擎产不出的动作类」抛错。
    ACTION_MAGIC,
)

DEFAULT_ITEM_STOCK = {"回复药": 3, "净化药": 2, "能量果": 2}
ITEM_EFFECTS = {"回复药": ("heal", 45), "净化药": ("cleanse", 0), "能量果": ("energy", 4)}


# ── 构造 ────────────────────────────────────────────────────────────────


def _make_pet(rs: Ruleset, pet_id: str, slot: int, level: int,
              snapshot: Optional[Dict[str, Any]] = None) -> PetState:
    """按规则集里的种族值造一只；**有个体快照时**用快照算六维（Q8，2026-09-29）。

    两条路径**必须能分辨**（人类逐字：「不许把两种情况说成一样」）：

      · `snapshot is None`（默认，legacy / v2 / 不传 individuals 的调用方）：
        老路径，逐位不变 —— 等级 1 时面板 = 种族值经 `data.panel_stats` 换算（M1 的
        「等级→面板」公式未知），所以 **level != 1 一律抛 `UnsupportedEffect`**。
      · `snapshot` 有值：六维由 `individuals.panel_from_snapshot()` 现算 —— 与列表/详情
        **同一份投影**（PVP 档：满级 60 + 5 星 ×6；`panel_projection` 带版本号）。
        等级由**快照**说了算（`individualFromInstance` 默认 60，人类 2026-09-27 拍板
        「pvp 没有的话就默认都 60 级别吧」），所以这一支**不再按 level=1 拦** ——
        再拦就等于挡住"同一个体"的唯一正例。
    """
    pet = rs.pet(pet_id)
    if snapshot is None:
        if level != 1:
            raise fx.UnsupportedEffect(
                f"等级 {level}", "等级→面板换算公式未知，本引擎只支持 level=1（M1 已登记为 unknown）；"
                "要按个体快照的等级结算，请走 `/battle/new` 的 individuals（Q8）"
            )
        # 关键：pets.json 里的 stats 是**种族值**，实战要用面板值。
        # 换算依据见 data.PANEL_FORMULAS（从社区快照的 base_*/stat_* 反推，
        # hp/atk/def 三项精确、其余有残差）。伤害量级完全取决于这一步。
        panel = _data.panel_stats(pet.stats)
        hp = int(round(panel.get("hp", float(pet.stats.get("hp", 1)))))
        return PetState(pet_id=pet_id, slot=slot, level=1, hp=hp, max_hp=hp, energy=0)

    # ── Q8：按个体快照算六维（与列表/详情同一份投影）─────────────────────
    result = _individuals.panel_from_snapshot(pet.stats, snapshot)
    panel = dict(result.get("panel") or {})
    if "hp" not in panel:
        raise fx.UnsupportedEffect(
            f"个体快照的面板（{pet.name}）",
            "快照 + 种族值算不出生命这一项 ⇒ 开局就没有血量上限；"
            f"缺什么：{'；'.join(result.get('unknown') or []) or '（未说明）'}",
        )
    hp = int(panel["hp"])
    level_from_snapshot = snapshot.get("level")
    level_value = int(level_from_snapshot) if isinstance(level_from_snapshot, int) \
        and not isinstance(level_from_snapshot, bool) else _individuals.PVP_LEVEL
    return PetState(
        pet_id=pet_id,
        slot=slot,
        level=level_value,
        hp=hp,
        max_hp=hp,
        energy=0,
        panel=panel,
        individual_source="individual-snapshot",
        individual_id=str(snapshot.get("individual_id") or "") or None,
        individual_level=level_value,
        panel_projection=result.get("projection"),
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
    individuals: Optional[Dict[str, Any]] = None,
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

    # ── Q8（2026-09-29）：个体快照 → 队伍**位次** ──────────────────────────
    # 形状问题与"实例对不上位次"都在这里一次性报出来（说清哪里不对，不静默忽略）。
    # `individuals=None` ⇒ 空字典 ⇒ 每一只都走种族值路径（老行为逐位不变）。
    snapshots, snapshot_problems = _individuals.resolve_snapshots(individuals, list(team))
    if snapshot_problems:
        raise ValueError("individuals 不合法：" + "；".join(snapshot_problems))

    # 配招要**同时**对双方校验：`loadouts` 是一份合并的 {pet_id: [...]}，
    # 里面有对手那几只的配招。只按我方队伍校验会把它报成
    # 「配招提到了不在队伍里的 pet_xxx」——记录里带着两边配招时就会炸。
    problems = validate_team(rs, team, loadouts, also_in=list(enemy), team_size=team_size)
    if problems:
        raise ValueError("队伍不合法：" + "；".join(problems))

    state = GameState(
        ruleset_id=rs.ruleset_id,
        seed=seed,
        player=SideState(name="player", pets=[
            _make_pet(rs, p, i, 1, snapshots.get(i)) for i, p in enumerate(team)]),
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

    # 2026-09-23（人类口径）：「每只精灵的能量（星）是**独立**的、开局都是满的 10 星」。
    # 老行为只把入场能量发给**场上那只**，换人上来的是 0 星 —— 页面按能量判可点性，
    # 于是换上来之后四格技能全灰（实测：开局 view.self.pets 能量 = [10,0,0,0,0,0]）。
    # 这条同样是**配置声明**（`energy.initial_for_all_pets`）：legacy / v2 不声明 →
    # 保持「只给场上那只」，`test_turn_order_fail_closed` 的 golden 指纹逐位不变。
    for side in (state.player, state.enemy):
        side.items = dict(DEFAULT_ITEM_STOCK)
        side.active = 0
        if bool(getattr(cfg, "energy_initial_for_all_pets", False)):
            for p in side.pets:
                p.energy = initial_energy
        else:
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
        # 2026-09-23：PVP 魔法（愿力强化）同样**只在配置声明了 magic 这一类时**初始化。
        # legacy / v2 没声明 → `side.magic` 保持 None（序列化里不出现这个键，指纹不变）。
        _init_pvp_magic(side, rs, cfg)
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
        # RC-401 批三：可付性按**有效能耗**（基础 + 能耗修正）。声明了机制才不一样。
        # 负值 / 解不出定价（MC-018）都**不提供这一手** —— 拿不到定价就不报合法动作，
        # 而不是猜一个 0、也不是退回基础能耗（2026-09-29 绞轮炸局的根因之一）。
        # 与 `_execute` 读的是**同一个** `resolved_skill_cost`。
        cost = resolved_skill_cost(state, side, skill, cfg)
        if cost is None:
            continue
        if cost < 0:
            continue
        if cost > pet.energy:
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

    # 2026-09-23：PVP 魔法（愿力强化）。只在**配置声明**了 magic 这一类时出现。
    # 两种情形都能出这个动作：
    #   · 这一只的第一个技能已经被换过 → 这一下是**解除**（人类口径：不消耗次数）；
    #   · 还有次数、且不在冷却里        → 这一下是**转换**（消耗一次）。
    # 只剩「没次数又没换过」时才不出现 —— 那时它确实无事可做。
    if allowed is not None and ACTION_MAGIC in allowed and isinstance(me.magic, dict):
        magic = pvp_magic_of(rs)
        if magic is not None:
            swapped = me.magic.get("swapped") or {}
            # 2026-09-23（人类实测）：「冷却」必须**真的锁住这个动作**，两支都锁 ——
            # 冷却的本义是「这件道具现在不能用」，而「解除」也是用这件道具。
            # 之前只有转换那一支看冷却（而且它自己还不设冷却），解除那一支完全不看，
            # 于是冷却形同虚设。现在：在冷却里 → 这个动作整支不出现。
            on_cooldown = int(me.magic.get("cooldown") or 0) > 0
            can_restore = pet.pet_id in swapped and not on_cooldown
            can_transform = (int(me.magic.get("uses_left") or 0) > 0
                             and not on_cooldown
                             and wish_impact_skill_id(rs, pet) is not None)
            if can_restore or can_transform:
                emit(Action(kind=ACTION_MAGIC, magic_id=str(magic.get("magic_id"))))

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


# ── 先手用的速度：**同一个体投影**（Q8 收口，task-23）───────────────────────
#
# 人类逐字：「**肯定要按照最终结算出来应该怎么样就怎么样啊，不能偷懒**」。
# 在这之前 `order_actions` 读的是 `rs.pet(pet_id).stats["spe"]` —— **种族值**
# （`PetState` 没有 `stats` 字段 ⇒ `hasattr` 恒 False ⇒ 走回落）。
# 实测同一个体：列表/详情侧速度 **275** · 物种面板 116.29 · 先手判定实际用 **33** ✗。
#
# ⚠ 这一处**不能逐只接**（那是"假接上"）：先手是**两侧比大小**，一侧拿面板、另一侧拿种族值
# 就是两套量纲（实测 275 vs 130 ⇒ 先手被系统性偏向有快照的一方，而且**不报错**）。
# 所以规则是**整局口径**：
#   · 本局**任一只**带个体快照 ⇒ 面板口径：有快照的用**个体面板**，同局没快照的用**物种面板**
#     （`data.panel_stats(race)`）—— 两侧同为"面板"量纲，可以比；
#   · 整局**没有**快照（legacy / v2 / 回归集 / 产品无实例开局）⇒ **逐字**仍是种族值
#     ⇒ golden 指纹一个字节不动。

#: 先手速度的来源：个体快照投影（与列表/详情同一份）。
SPEED_SOURCE_INDIVIDUAL = "individual-panel"
#: 先手速度的来源：物种面板（本局走面板口径、但这一只没有快照）。
SPEED_SOURCE_SPECIES_PANEL = "species-panel"
#: 先手速度的来源：种族值（整局没有快照时的老路径）。
SPEED_SOURCE_SPECIES_RACE = "species-race"


def battle_uses_panel_scale(state: GameState) -> bool:
    """**这一局**是不是在「面板口径」下结算：双方任一只带个体快照 ⇒ 是。

    「同一个体投影」一旦进了这一局，**所有**速度都得换成面板量纲（见上面那段注释）；
    整局没有快照就整个口径关掉 —— 这是 legacy / v2 / 回归集逐位不变的前提。
    """
    for side in ("player", "enemy"):
        for pet in getattr(getattr(state, side, None), "pets", None) or ():
            if getattr(pet, "panel", None):
                return True
    return False


def order_speed(pet: Any, rs: Ruleset, *, panel_scale: bool,
                cfg: Optional[RuleConfig] = None) -> Tuple[Any, str]:
    """先手判定要用的速度 + 它的**来源**（`order_actions` 与回执共用这一处）。

    返回 `(速度, 来源)`，来源取 `SPEED_SOURCE_*` 三态之一。三条路径：
      · `pet.panel` 非空 ⇒ **个体面板的 spe**（与列表/详情同一份投影）；
      · 空 + `panel_scale`（本局有快照）⇒ **物种面板** `data.panel_stats(race)["spe"]`；
      · 空 + 整局没快照 ⇒ **逐字** `species.stats["spe"]`（老路径，种族值）。

    ⚠ 2026-09-29（task-25，A 族「获得 属性±N」的读点）**改钉**：这个函数过去**完全不读
    `pet.buffs`** ⇒ 「自己获得速度+30」（A 族 53 条里的一整类）会发出 `buff_self{stat:"spe"}`
    事件、判据也判 `resolved=True`，但**先手顺序一点都不变** = 假绿。
    实测（改前）：`spe` buff 设成 +100% 与不设，`order_actions` 的执行顺序逐字相同。

    现在按**能力位**读两个来源（没声明就一个都不读 ⇒ legacy / v2 逐位不变）：
      · `stat_gain.speed_buff` ⇒ `buffs["spe"]` 是**百分点**（`+30` = 先手速度 ×1.30）；
      · `stat_gain.flat`       ⇒ `buffs_flat["spe"]` 是**面板量纲的绝对值**（`+120` = +120 点）。
    （平值的**解析与读点共用**`stat_gain.flat`**一个**能力位 —— 拆开就能合法地造出
      "解析开了、读点没开"的假绿配置，见 `rule_config` 里那条注释。）
    两条的量纲分开，见 `PetState.buffs_flat` 的 docstring。
    """
    panel = getattr(pet, "panel", None)
    if isinstance(panel, dict) and panel:
        value = panel.get("spe")
        # 布尔是 int 的子类 —— 面板里出现 true/false 是形状错误，不许当 1/0 用。
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return _speed_with_buffs(pet, value, cfg), SPEED_SOURCE_INDIVIDUAL
    # 老调用方可能传的是**自带 `stats` 的对象**（不是 PetState）⇒ 逐字沿用老读法
    # （这种对象没有 `buffs`，`_speed_with_buffs` 读到空 ⇒ 值逐字不变）。
    if hasattr(pet, "stats"):
        return _speed_with_buffs(pet, pet.stats.get("spe", 1), cfg), SPEED_SOURCE_SPECIES_RACE
    species = rs.pet(pet.pet_id)
    if panel_scale:
        import roco_env.data as _data  # 局部导入：data 与 env 互相引用，模块级会成环
        species_panel = _data.panel_stats(species.stats)
        if "spe" in species_panel:
            return _speed_with_buffs(pet, float(species_panel["spe"]), cfg), SPEED_SOURCE_SPECIES_PANEL
    # ⚠ 最后这条**也要**过一遍 `_speed_with_buffs`：第一版漏了它，于是"整局没有快照"的
    # 候选局（v3 + 种族值路径）速度增减照样不生效 —— 读数上表现成 buff 设了没用
    # （实测 `order_speed(P(spe_buff=100), cfg=v3)` 与不设都返回 `(33, 'species-race')`）。
    return _speed_with_buffs(pet, species.stats.get("spe", 1), cfg), SPEED_SOURCE_SPECIES_RACE


def _speed_with_buffs(pet: Any, value: float, cfg: Optional[RuleConfig]) -> float:
    """把「获得速度±N%」（`buffs`）与「获得速度±N」（`buffs_flat`）折进先手速度。

    **两个能力位各自独立**：没声明的那一条不生效（`cfg is None` = 两条都不生效 ——
    判据里的历史调用方就是这么调的，逐位不变）。
    """
    if cfg is None:
        return value
    if bool(getattr(cfg, "stat_gain_speed_buff", False)):
        pct = float((getattr(pet, "buffs", None) or {}).get("spe", 0) or 0.0)
        if pct:
            value = float(value) * (1.0 + pct / 100.0)
    if bool(getattr(cfg, "stat_gain_flat", False)):
        flat = float((getattr(pet, "buffs_flat", None) or {}).get("spe", 0) or 0.0)
        if flat:
            value = float(value) + flat
    return value


def order_speed_provenance(state: GameState, rs: Ruleset,
                           cfg: Optional[RuleConfig] = None) -> Dict[str, Any]:
    """这一回合**两侧各自用的速度与来源**（进 `turn_start` 回执，只在面板口径下出现）。

    与 `order_actions` 读**同一个** `order_speed()` —— 不是第二份算法，只是把同一份读数
    登记出来，让「有没有假接上」可审计（人类口径：不许把两种情况说成一样）。

    2026-09-29（task-25）：把**两条速度修正的原始量**也登记出来（只在非零 + 能力位声明时），
    这样「先手翻了」这个读数可以直接归因到「哪一条修正改了多少」，不用反推。
    """
    panel_scale = battle_uses_panel_scale(state)
    speeds: Dict[str, Any] = {}
    for side in ("player", "enemy"):
        pet = getattr(state, side).field_pet
        value, source = order_speed(pet, rs, panel_scale=panel_scale, cfg=cfg)
        row: Dict[str, Any] = {
            "value": value,
            "source": source,
            "pet_id": pet.pet_id,
            # 有快照就把"是哪一只"带上（人类逐字：「实例重复物种时不能只靠 speciesID 推断来源」）。
            **({"individual_id": pet.individual_id} if source == SPEED_SOURCE_INDIVIDUAL else {}),
        }
        if cfg is not None:
            _pct = float((getattr(pet, "buffs", None) or {}).get("spe", 0) or 0.0)
            _flat = float((getattr(pet, "buffs_flat", None) or {}).get("spe", 0) or 0.0)
            if _pct and bool(getattr(cfg, "stat_gain_speed_buff", False)):
                row["speed_buff_pct"] = _pct
            if _flat and bool(getattr(cfg, "stat_gain_flat", False)):
                row["speed_buff_flat"] = _flat
        speeds[side] = row
    return {"panel_scale": panel_scale, "speeds": speeds}


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
    # 这一局的速度口径（Q8 收口，task-23）：整局有任何一只带快照就按"面板"比，否则逐字老路径。
    panel_scale = battle_uses_panel_scale(state)
    entries = []
    for side, action, opp in (("player", player_action, enemy_action),
                              ("enemy", enemy_action, player_action)):
        pet = getattr(state, side).field_pet
        # 2026-09-29（task-25）：把 `cfg` 传下去 —— 「获得速度±N% / ±N」两个能力位
        # 就挂在这一跳上（见 `_speed_with_buffs`）。不传 = 两条都不生效 = 改动前逐位相同。
        _speed, _speed_source = order_speed(pet, rs, panel_scale=panel_scale, cfg=cfg)
        entries.append({
            "side": side,
            "action": action,
            "respond": _respond_success(action, opp, rs),
            "priority": _priority_of(action, rs),
            # 2026-09-30（Q8 收口，task-23）：速度也读**同一个体投影**（三态见 `order_speed`）。
            # 留一栏 `speed_source` 只为可审计/调试；排序键只用 `speed` 本身，没变。
            "speed": _speed,
            "speed_source": _speed_source,
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


def resolved_skill_cost(state: GameState, side: str, skill, cfg: RuleConfig) -> Optional[int]:
    """这一手**现在**要付多少能量；**解不出定价时返回 `None`**（不猜、也不回落到基础能耗）。

    `legal_actions`（可付性）与 `_execute`（扣费）**必须**读这**一个**入口 ——
    2026-09-29 的实战缺陷（`skill_000494`「绞轮」炸局）就是两处口径各算各的：
    列表那边算不出就退回基础能耗、照样把这一手列为合法，扣费那边算不出就抛异常。
    """
    try:
        return effective_skill_cost(getattr(state, side).field_pet, skill, cfg,
                                    weather=state.weather,
                                    foe_status_layers=_poison_layers(state, side),
                                    own_debuff_layers=_own_debuff_layers(state, side),
                                    slot_cost_delta=_slot_cost_delta(state, side, skill, cfg))
    except RuleConfigError:
        return None


def _cancel_unresolvable_skill(state: GameState, rs: Ruleset, side: str,
                               action: Action, cfg: RuleConfig) -> bool:
    """**执行前再判一次**：这一手现在还解不解得出有效能耗？解不出就不结算，但**回合照走完**。

    为什么必须再判一次：合法动作表是**回合开始时**按当时的状态算出来的，而同一回合里
    先出手的一方可以改掉另一方的能耗（`绞轮` `skill_000494`：「每受到1次抵抗的技能攻击，
    本技能能耗永久-1」）。于是存在一个真实窗口：**列表里合法 → 结算到一半解不出**。

    MC-018 没有定义负能耗的下限，所以引擎**不猜 0**（那是编数据）；但也不能把整局炸掉 ——
    这一手不结算、如实登记进 `state.unsupported`、并产出一条可结算的 `action_cancelled` 事件。
    这与既有的「精灵已倒下 → `action_cancelled`」是同一形态，不是新发明。
    """
    if action.kind != ACTION_SKILL or not action.skill_id:
        return False
    pet = getattr(state, side).field_pet
    if not pet.alive:
        return False          # 倒下那一条走 `_execute` 既有的守卫（逐位不变）
    skill = rs.skills.get(action.skill_id)
    if skill is None or skill.is_trait:
        return False
    cost = resolved_skill_cost(state, side, skill, cfg)
    if cost is not None and cost >= 0:
        return False
    label = "你" if side == "player" else "对手"
    name = rs.pet(pet.pet_id).name
    what = f"技能「{skill.name}」的有效能耗"
    if cost is None:
        detail = (f"规则配置 {cfg.ruleset_config_id} 里算不出这一手的有效能耗"
                  "（能耗修正/天气口径不齐）—— 不猜一个数，这一手不结算")
    else:
        detail = (f"能耗修正把它压到 {cost}（基础 {skill.energy}）—— 负能耗的下限在术语里没有定义"
                  "（MC-018），不猜一个 0、也不按负数回能；这一手不结算")
    _note_unsupported(state, what, detail, skill.skill_id)
    state.log.append(f"{label}的{name}的{skill.name}没有结算：{detail}。")
    _bump(state, "action_cancelled", {
        "side": side, "reason": "energy_cost_unresolved", "skill_id": skill.skill_id,
        "base_energy": int(skill.energy), "effective_cost": cost, "microcase_id": "MC-018",
    }, evidence=(skill.skill_id,))
    return True


def step_joint(
    state: GameState,
    rs: Ruleset,
    player_action: Action,
    enemy_action: Action,
    *,
    tolerate_unsupported: bool = False,
) -> GameState:
    """双方基于**同一事前状态**各出一手，然后统一推进。

    隐藏信息纪律：本函数在结算前先为双方快照 observation，
    并把它们写进 history。这样任何「后出手的一方偷看了对手选择」的实现错误
    都能从回放里查出来。

    `tolerate_unsupported`（2026-09-29 加，**默认 False = 逐位不变**）：
      一手的机制解不出时，`_execute` 会抛 `fx.UnsupportedEffect`。这是引擎的
      **既有契约**，而且是被依赖的：`planner._safe_step` 就是靠它把「推不动的动作」
      记成 `-inf`（`roco/tests/test_planner.py` 钉着这一条）。所以**默认不改**。
      **玩家路径**（`service.battle_advance`）显式传 `True`：那一层要的是
      「别把整局炸掉」—— 解不出的那一手变成一条**能结算的** `action_cancelled` 事件
      （带玩家可读的原因），回合照常走完。搜索/推演那条路不传，语义不变。
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

    # 投降是**立即生效的弃权**：不参与速度排序，也不受「我方场上精灵已经倒下」影响。
    # 真缺陷（人类 2026-09-25 实测「投降只会扣一颗心，为啥退出不出来」）：投降原本跟普通
    # 动作一样进 `order_actions` 排序，当对手更快、且它这一手正好打倒我方当前精灵时，
    # `_execute` 的第一道守卫（`if not pet.alive` → `action_cancelled`）会把投降**静默吞掉**：
    # 本局继续、白扣 1 点魔力、玩家被拖进补位 —— 而投降是屏幕上唯一的出口。
    # 投降没有速度，也不该以「还站着」为前提，所以在这里先结。
    pre_surrender: Optional[str] = None
    for side, action in (("player", player_action), ("enemy", enemy_action)):
        if action.kind == ACTION_SURRENDER:
            pre_surrender = side
            break

    # 应对判定（术语 1015/1016/1017）需要知道对手这一手是什么。
    # 这两个字段只用于**结算**，绝不进入 observation（见 schema.observation_for）。
    setattr(state, "_pending_player", player_action)
    setattr(state, "_pending_enemy", enemy_action)

    rng = _rng_for(state)
    order = order_actions(state, rs, player_action, enemy_action, rng=rng, cfg=cfg)
    # RC-401 批次八：「若先于敌方攻击」这条**条件**要读执行序列（谁排在前面）。
    # 只放在 state 上给结算用，**不进 observation**（与 `_pending_*` 同一条纪律）。
    setattr(state, "_order_index", {side: index for index, (side, _action) in enumerate(order)})

    pre_player = observation_for(state, rs, "player")
    pre_enemy = observation_for(state, rs, "enemy")

    state.log.append(f"── 第 {state.turn} 回合 ──")
    # 2026-09-30（Q8 收口，task-23）：回执里登记**这一回合两侧各自用的速度与来源**
    # （`individual-panel` / `species-panel` / `species-race`）。为什么要有这一栏：
    # 「先手按面板比」如果只改排序、不写出来，就没人看得出**有没有假接上**
    # （一侧面板、一侧种族值 = 两套量纲，先手会被静默带偏）。
    # **只在面板口径下多这一把键**：整局没快照（legacy / v2 / 回归集）时 `turn_start` 逐位不变。
    _speed_prov = order_speed_provenance(state, rs, cfg=cfg)
    _bump(state, "turn_start", {
        "turn": state.turn,
        **({"speed_provenance": _speed_prov} if _speed_prov["panel_scale"] else {}),
    })

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

    if pre_surrender is not None:
        # 投降方判负 ⇒ 这一回合**任何一手都不再结算**（对手那一手也不结算：本局已经结束了）。
        _surrender(state, cfg, pre_surrender)
    else:
        for side, action in order:
            # ① 执行前再判一次能耗口径（绞轮那一类：列表里合法 → 结算时解不出）。
            # 解不出就不结算，但**回合继续走完**，不再是未处理异常炸整局。
            if _cancel_unresolvable_skill(state, rs, side, action, cfg):
                continue
            # ② 兜底：只有**玩家路径**（`tolerate_unsupported=True`）才把残留的
            # unsupported 变成可结算的事件 —— 玩家那里「点得动的动作把整局炸掉」不可接受。
            # 搜索/推演那条路（planner / opponents / regression）不传这个开关，
            # 保持「抛异常 ⇒ 这个动作推不动 ⇒ -inf」的既有契约（`test_planner.py` 钉着）。
            # ⚠ 「这一手真的打出去了吗」= **从事件流里读事实**，不是"代码执行到了" ✗：
            # `_execute` 的第一道守卫（精灵已倒下）会 `action_cancelled{reason:"fainted"}` 后 return，
            # 而下面的累加块**照样会被执行到** —— 那些手**没有打出去**，不许计数（人类口径）。
            _events_before = len(state.events)
            if not tolerate_unsupported:
                _execute(state, rs, side, action, cfg)
            else:
                try:
                    _execute(state, rs, side, action, cfg)
                except fx.UnsupportedEffect as exc:
                    _note_unsupported(state, exc.what, exc.detail or str(exc), exc.evidence or "")
                    state.log.append(
                        f"{'你' if side == 'player' else '对手'}的这一手没有结算：{exc}")
                    _bump(state, "action_cancelled", {
                        "side": side, "reason": "unsupported_effect",
                        "action_kind": action.kind, "skill_id": action.skill_id,
                        "what": exc.what, "detail": exc.detail,
                    }, evidence=(exc.evidence or "",))
                    continue
            _went_off = not any(
                ev.kind == "action_cancelled" and ev.detail.get("side") == side
                for ev in state.events[_events_before:])
            # RC-401 批次十二：「每次使用后，本技能<属性>永久±N」在**成功出手之后**累加。
            # 放在 `_execute` 之后、且只对技能类动作做（换人/聚能/道具没有这条属性）。
            if action.kind == ACTION_SKILL and action.skill_id:
                _skill = rs.skills.get(action.skill_id)
                if _skill is not None:
                    _pet = getattr(state, side).field_pet
                    _parsed_ramp = parse.resolve_per_use_ramp(
                        _skill, declared=bool(getattr(cfg, "damage_per_use_ramp", False)))
                    _accumulate_per_use_ramp(state, _pet, _skill, _parsed_ramp, cfg,
                                             happened=_went_off)
                    # task-25 B 族（2026-09-30）：「**每使用1次其他<本系>技能 /
                    # 每使用过1个其他系别技能**，本技能<属性>永久±N」—— 触发点就在**这一手**：
                    # 只有"别的技能"打出去了才动 B 族那条技能的永久修正（本技能自己不算 ✗）。
                    _accumulate_element_use_ramp(state, rs, _pet, _skill, cfg,
                                                 happened=_went_off)
                    # RC-401 批次十七（task-26 H 族批一）：「每应对成功1次 / 应对X：…永久±N」。
                    # ⚠ 触发判据读的是 `_execute` 里设好的 `_respond_succeeded`（**真的应对成功**才为真）——
                    # 不成立时 `_accumulate_triggered_ramp` 里那条 `trigger` 对不上 ⇒ 什么都不做 ✓
                    _parsed_trig = parse.resolve_triggered_ramp(
                        _skill, declared=bool(getattr(cfg, "damage_triggered_ramp", False)))
                    _accumulate_triggered_ramp(
                        state, _pet, _skill, _parsed_trig, trigger="respond_success",
                        # ⚠ **事实从状态里读**，不是"代码执行到了"：`_respond_succeeded` 由 `_execute`
                        # 按「本技能应对的类别 == 对手那一手的类别」算出（对手不是那一类 ⇒ False）。
                        happened=bool(getattr(_pet, "_respond_succeeded", False)), cfg=cfg)

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


def step_free(state: GameState, rs: Ruleset, side: str, action: Action) -> GameState:
    """**不占行动的自由动作**（人类 2026-09-25：「PVP 魔法 / 背包物品不占行动」）。

    只结算这一方的这一个动作：`state.turn` 不变、对手这一手不结算、这一方随后照常出这一手
    （「愿力冲击」就是个技能，用它照常占一手 ⇒ 仍走 `step_joint`）。
    事件与日志照常产生（页面靠 `magic` 事件点灯），但**不进 joint history**（那不是一回合）。

    能力**由配置声明**：`cfg.magic_occupies_action is False` 才放行；`True`（旧口径）或 `None`
    （没声明 / 未核验）一律抛 `UnsupportedEffect` —— 没声明就当它不占行动等于白送一个能力。
    边界：只在 `battle` 阶段、且动作在这一方合法动作表里；「本回合用过没有」不由引擎记账
    （由道具自己的次数与冷却挡住），次序由调用方负责。
    """
    cfg = _rule_config.get_rule_config(state.ruleset_config_id or None)
    if cfg.magic_occupies_action is not False:
        raise fx.UnsupportedEffect(
            "背包物品不占行动",
            f"规则配置 {cfg.ruleset_config_id} 没有声明这条能力"
            f"（policies.magic_policy.occupies_action={cfg.magic_occupies_action!r}，"
            f"status={cfg.magic_occupies_action_status!r}）—— 未声明的配置一律 fail closed，"
            "照旧按「占一手」走 step_joint",
        )
    if state.result:
        raise ValueError("对局已结束，不能再行动")
    if state.phase != "battle":
        raise ValueError(f"当前阶段是 {state.phase!r}：自由动作只在 battle 阶段可用（补位请用 step_replace）")
    if action.kind != ACTION_MAGIC:
        raise fx.UnsupportedEffect(
            f"自由动作({action.kind})",
            "目前只有 PVP 魔法 / 背包物品这一类是自由动作；技能与换人照旧占这一手（step_joint）",
        )
    if action not in legal_actions(state, rs, side):
        raise ValueError(f"{side} 的自由动作不合法：{action.label(rs)}")
    # 自由动作不是联合结算 ⇒ 没有本回合执行序列，清掉上回合留下的（避免条件读到陈旧值）。
    setattr(state, "_order_index", None)
    _execute(state, rs, side, action, cfg)
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

    if action.kind == ACTION_MAGIC:
        _use_magic(state, rs, side, action, cfg)
        return

    if action.kind == ACTION_CHARGE:
        _use_charge(state, rs, side, action, cfg)
        return

    if action.kind == ACTION_SURRENDER:
        _surrender(state, cfg, side)
        return

    skill = rs.skill(action.skill_id)
    # RC-401 批三：扣的是**有效能耗**（特性可以增减它）。
    # 两条路径（可付性与扣费）都走 `resolved_skill_cost` 这**一个读点**。
    cost = resolved_skill_cost(state, side, skill, cfg)
    if cost is None:
        # 直接调用 `_execute`（测试、脚本）时也要 fail closed：算不出定价就不结算，不猜。
        # 走 `step_joint` 的那条路更早一步就会被 `_cancel_unresolvable_skill` 拦下。
        raise fx.UnsupportedEffect(
            f"技能「{skill.name}」的有效能耗",
            f"规则配置 {cfg.ruleset_config_id} 里算不出这一手的能耗（能耗修正/天气口径不齐）"
            "—— 不猜一个数",
        )
    if cost < 0:
        raise fx.UnsupportedEffect(
            f"技能「{skill.name}」的有效能耗",
            f"能耗修正把它压到 {cost}（基础 {skill.energy}）—— 负能耗的下限在术语里没有定义"
            "（MC-018），不猜一个 0，也不按负数回能",
        )
    if cost > pet.energy:
        raise ValueError(f"能量不足：这一手要 {cost}，只有 {pet.energy}")
    pet.energy = max(0, pet.energy - cost)   # 假设：消耗先扣（MC-007）

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
        # RC-401 批次十八（F 族第五种形状）：**号位带来的额外减伤** ⇒ 与基础减伤**相加** ✓。
        # ⚠ **本地规则**：原始资料与代码**均未定义复合口径**（`_defense_reduction` 是单值 ✗）⇒ 本地取**加法** ✓；
        #   未声明号位能力 ⇒ 额外值为 0 ⇒ 与原行为**逐字相同** ✓（legacy 不变 ✓）。
        reduction = fx.parse_defense_reduction(skill) \
            + _slot_extra_reduction(state, side, skill, cfg) / 100.0
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
        # RC-401 批次六：这两条读法只在**配置声明**（`energy.foe_energy_loss`）时落地；
        # 未声明 ⇒ 效果被解析层收回（连未认领标记也不补），legacy 的 unsupported 与批六之前逐位相同。
        parsed_def = parse.resolve_foe_energy_loss(
            skill, declared=bool(getattr(cfg, "energy_foe_energy_loss", False)))
        parsed_def = parse.resolve_cleanse_marks(
            skill, declared=bool(getattr(cfg, "damage_cleanse_marks", False)), parsed=parsed_def)
        parsed_def = parse.resolve_global_skill_mod(
            skill, declared=bool(getattr(cfg, "damage_global_skill_mod_text", False)), parsed=parsed_def)
        # RC-401 批次十四（2026-09-29 task-20）：防御支也接同一条覆盖语义
        #（描述「…，应对防御：改为…」的技能若本身是防御招，走的就是这一支）。
        parsed_def = parse.resolve_respond_override(
            skill, declared=bool(getattr(cfg, "energy_respond_override", False)),
            parsed=parsed_def)
        # 2026-09-29（task-25）：A 族「获得 属性±N」的扩展形状 / 平值（同上）。
        # 这一支的附带效果**只在应对成功那一步**应用（下面 `if succeeded:`），所以
        # 「应对攻击：自己获得魔防+70%」这类由这一支正确处理。
        parsed_def = parse.resolve_stat_gain_extended(
            skill, declared=bool(getattr(cfg, "stat_gain_extended", False)),
            flat_declared=bool(getattr(cfg, "stat_gain_flat", False)), parsed=parsed_def)
        # ── task-28（本件）：**补上防御支缺的两个 resolver** ✗（今天第 6 次"只接一半"的形态 ✓）
        # ⚠ **两个一起接** ✗（别修一个漏一个 ✓）：
        #   ① `element_power_ramp`（`463 点亮` 落这 ✓）② `moe_colon`（攻击/状态支有、防御支没有 ✗）
        # ⚠ **顺序照抄上面 4 个的写法与位置** ✓（`grep` 数过它现在正好调 4 个 ✓ 不猜 ✓）
        # ⚠ **条件门不用新造** ✓ —— 本支的效果**只在应对成功时** `_apply_effect_batch` ✓
        #   （段内注释逐字：「应对成功 → 真的应用／应对失败 → **登记**为 unsupported，绝不能当成已生效」✓）
        #   ⇒ ⇒ 但**我没把"结构如此"当成"行为如此"** ✗ —— 真打一手两向**照样做** ✓
        # ⚠ 2026-09-30 **回滚留档**（改钉不删 ✓）：这里曾传 `allow_respond_clause=True` ✓
        #   ⇒ 运行时 `463` 真的会在应对成立时加 ✓（真打一手实测：对手出攻击 ⇒ `{'光系': 50}` ✓）
        #   ⇒ ⚠ **但判据侧没跟上** ✗ ⇒ 变成「**运行时算了、判据说没算**」✗✗（本阶段最不许的方向 ✗）
        #   ⇒ ⇒ 按纪律**回滚** ✓，恢复"闸在 + 判据 False"的一致状态 ✓
        #   ▶ 重新放开的前置条件（下一轮就绪后再做 ✓）：
        #     `coverage` 的**三条链**都要加 `allow_respond_clause=_is_defense_skill(skill)` ✓
        #     （助手的 docstring 已写好 ✓ 但三处调用**形态不一** ⇒ 我的正则只改到 2 处 ✗ 别再用正则 ✓
        #      逐处 `grep -n` 手工改 ✓）· 并同步改钉 `test_element_power_ramp_defense_transition.py` ✓
        # ⚠ 2026-09-30 **已重开** ✓（前置条件已满足 ✓）：`coverage` 三条链已逐处对齐 ✓
        #   （`allow_respond_clause=_is_defense_skill(skill)` ✓ 链 A/B/C 各一处 ✓）
        #   ⇒ 现在两边一起认"防御技的应对子句" ✓ ⇒ 不再是「运行时算了、判据说没算」✗
        parsed_def = parse.resolve_element_power_ramp(
            skill, declared=bool(getattr(cfg, "damage_element_power_ramp", False)),
            parsed=parsed_def, allow_respond_clause=True)
        parsed_def = parse.resolve_moe_colon(
            skill, declared=bool(getattr(cfg, "damage_moe_mark", False)), parsed=parsed_def,
            flat_declared=bool(getattr(cfg, "stat_gain_flat", False)),
            power_declared=bool(getattr(cfg, "damage_self_power_flat", False)),
            global_declared=bool(getattr(cfg, "damage_global_skill_mods", False)))
        if parsed_def.effects or parsed_def.unparsed or parsed_def.respond_override:
            if succeeded:
                if getattr(parsed_def, "respond_override", None) is not None:
                    parsed_def, _ = _apply_respond_override(
                        state, rs, side, skill, parsed_def, succeeded=True, cfg=cfg)
                applied = _apply_effect_batch(state, rs, side, skill, parsed_def, cfg)
                state.log.append(
                    f"应对成功，{parsed_def.skill_name}的应对效果结算 {applied} 条。"
                )
            else:
                _register_parsed_effects(
                    state, rs, side, skill, parsed_def, applied=False,
                    reason="「应对成功」子句的条件没有成立（对手这一手不是该技能应对的类别）",
                    cfg=cfg,
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
    # RC-401 连击：判据在 `parse.resolve_hit_count`（见那里的注释）。
    hit_count, parsed_atk = parse.resolve_hit_count(
        skill, declared=bool(getattr(cfg, "damage_multi_hit", False)))
    parsed_atk = parse.resolve_cleanse_marks(
        skill, declared=bool(getattr(cfg, "damage_cleanse_marks", False)), parsed=parsed_atk)
    parsed_atk = parse.resolve_global_skill_mod(
        skill, declared=bool(getattr(cfg, "damage_global_skill_mod_text", False)), parsed=parsed_atk)
    # RC-401 批次八：先手条件（「若先于敌方攻击，本次技能威力+N%」）。
    # **只有配置声明了这条能力**才认领那段文本（未声明时它照旧是"未认领机制"）。
    parsed_atk = parse.resolve_initiative_condition(
        skill, declared=bool(getattr(cfg, "damage_initiative_condition", False)), parsed=parsed_atk)
    parsed_atk = parse.resolve_foe_switch_condition(
        skill, declared=bool(getattr(cfg, "damage_foe_switch_condition", False)), parsed=parsed_atk)
    parsed_atk = parse.resolve_per_use_ramp(
        skill, declared=bool(getattr(cfg, "damage_per_use_ramp", False)), parsed=parsed_atk)
    # RC-401 批次十二：本技能累计出来的永久威力 / 连击数（在条件加成之前先加上）。
    if bool(getattr(cfg, "damage_per_use_ramp", False)):
        _ramp_power = _skill_ramp(pet, skill.skill_id, "power")
        if _ramp_power:
            skill = dataclasses.replace(skill, power=int(skill.power or 0) + _ramp_power)
        _ramp_hits = _skill_ramp(pet, skill.skill_id, "hits")
        if _ramp_hits and hit_count:
            hit_count = int(hit_count) + _ramp_hits
    # RC-401 批次十一：「若敌方本回合更换精灵，<效果>」——先按条件把条件效果筛一遍，
    # 再把**结构性**的那几条（威力平加/翻倍、连击加成）用到这一手上。
    parsed_atk, _foe_switched = _gate_foe_switch_effects(state, side, skill, parsed_atk, cfg)
    # RC-401 批次十四（2026-09-29 task-20）：攻击技带「应对X：改为…」时走**同一条覆盖语义**
    # （实测 `skill_000611 毒囊`「造成物伤，敌方获得2层中毒，应对状态：改为获得6层」——
    # 基础 foe_status 在**攻击支**的附带效果里结算，所以这一支也必须接，否则应对成功仍是 2 层）。
    # ⚠ 放在 `_gate_foe_switch_effects` **之后**：`replaces_index` 是解析那一刻在同一个
    # effects 列表上算出来的，gate 可能摘掉几条，先算下标就会错位。
    parsed_atk = parse.resolve_respond_override(
        skill, declared=bool(getattr(cfg, "energy_respond_override", False)), parsed=parsed_atk)
    # RC-401 批次十六（task-20 批四）：读敌方层数改**本手**威力/连击。
    parsed_atk = parse.resolve_per_layer_boost(
        skill, declared=bool(getattr(cfg, "damage_per_layer_boost", False)), parsed=parsed_atk)
    # task-28（第 2 批 `717`）：「<谁>获得萌化：<效果>」在**攻击支**也要接 ✗
    # ⚠ 我第一版**只接了状态支** ⇒ 实测 `717`（攻击技）**一个字都没生效** ✗
    #   （无事件 · `power_used=100` 没加 · `marks={}` ✓ —— 这正是"漏一条链"的形态 ✓ 与 `462` 那次同型 ✓）
    # task-28（`724`）：**条件式**本手威力（"自己有减益时" ✓ 与 `717` 共用同一 kind ✓ 只多一个条件门 ✓）
    # ⚠ **三条支都要接** ✗ —— `717` 那次**只接状态支** ⇒ 攻击技一个字没生效 ✗（真打一手才抓到 ✓）
    parsed_atk = parse.resolve_self_debuff_power(
        skill, declared=bool(getattr(cfg, "damage_cond_self_debuff_power", False)
                              and getattr(cfg, "damage_self_power_flat", False)), parsed=parsed_atk)
    parsed_atk, _ = _gate_self_debuff_effects(state, side, skill, parsed_atk, cfg)
    parsed_atk = parse.resolve_moe_colon(
        skill, declared=bool(getattr(cfg, "damage_moe_mark", False)), parsed=parsed_atk,
        flat_declared=bool(getattr(cfg, "stat_gain_flat", False)),
        power_declared=bool(getattr(cfg, "damage_self_power_flat", False)),
        global_declared=bool(getattr(cfg, "damage_global_skill_mods", False)))
    # 2026-09-29（task-25）：A 族「获得 属性±N」的扩展形状 / 平值（同上，放在覆盖语义之后）。
    parsed_atk = parse.resolve_stat_gain_extended(
        skill, declared=bool(getattr(cfg, "stat_gain_extended", False)),
        flat_declared=bool(getattr(cfg, "stat_gain_flat", False)), parsed=parsed_atk)
    if getattr(parsed_atk, "respond_override", None) is not None:
        parsed_atk, _ov_landed = _apply_respond_override(
            state, rs, side, skill, parsed_atk, succeeded=bool(succeeded), cfg=cfg)
        # RC-401 批次十五（2026-09-29 task-20 批二）：**连击数覆盖**。
        # `hit_count` 是这一支的**局部变量**（伤害路径与 `damage` 事件的 `hits` 都读它），
        # 所以覆盖值由这里取用 —— `_apply_respond_override` 只负责"判条件 + 登记"，
        # 不越界去改它拿不到的局部量（成功时它在 `applied_hits` 上留数）。
        _ov_hits = int(parsed_atk.respond_override.get("applied_hits") or 0) if _ov_landed else 0
        if _ov_hits > 0:
            hit_count = _ov_hits
    for _eff in parsed_atk.effects:
        if _eff.kind == "foe_switch_power_flat":
            skill = dataclasses.replace(skill, power=int(skill.power or 0) + int(_eff.value["amount"]))
            _bump(state, "foe_switch_power_applied", {"side": side, "skill_id": skill.skill_id,
                                                      "kind": "flat", "amount": int(_eff.value["amount"])})
        elif _eff.kind == "foe_switch_power_mult":
            skill = dataclasses.replace(skill, power=int((skill.power or 0) * int(_eff.value["multiplier"])))
            _bump(state, "foe_switch_power_applied", {"side": side, "skill_id": skill.skill_id,
                                                      "kind": "mult", "multiplier": int(_eff.value["multiplier"])})
    # RC-401 批次十六（2026-09-29 task-20 批四）：「敌方每有 N 层<中毒效果|印记|星陨印记>，
    # 本次技能威力/连击数 +M」。读的是**对手场上那只的当前层数**（`_foe_layer_count`）。
    # 加成加在 `power` 或 `hit_count` 上 —— 它们是本仓伤害公式**唯一**读的两个入参。
    for _eff in parsed_atk.effects:
        if _eff.kind != "per_layer_boost":
            continue
        _src = str(_eff.value.get("source") or "")
        _step = max(1, int(_eff.value.get("layer_step") or 1))
        _layers = _foe_layer_count(state, side, _src)
        _steps = _layers // _step
        _amt = _steps * int(_eff.value.get("delta") or 0)
        _field = str(_eff.value.get("field") or "")
        if _amt and _field == "power":
            skill = dataclasses.replace(skill, power=int(skill.power or 0) + _amt)
        elif _amt and _field == "hits":
            hit_count = (hit_count or 1) + _amt
        _bump(state, "per_layer_boost_applied" if _amt else "per_layer_boost_skipped", {
            "side": side, "skill_id": skill.skill_id, "field": _field, "source": _src,
            "layers": _layers, "steps": _steps, "delta": _amt if _amt else 0,
            "reason": None if _amt else "no_layers",
            "evidence": _eff.evidence,
        })
    # task-28（第 2 批 `717 超级糖果`）：**本手无条件平值威力** ——
    # ⚠ **照上面两个先例的同一手法**：直接改 `skill.power`（`foe_switch_power_flat` 就是这么做的 ✓）
    #   ⇒ **不动伤害公式、不加旋钮** ✗（`power` 是公式唯一读的入参之一 ✓）
    for _eff in parsed_atk.effects:
        if _eff.kind != "self_power_flat":
            continue
        _amt = int(_eff.value.get("amount") or 0)
        if _amt:
            skill = dataclasses.replace(skill, power=int(skill.power or 0) + _amt)
        _bump(state, "self_power_flat_applied" if _amt else "self_power_flat_skipped", {
            "side": side, "skill_id": skill.skill_id, "amount": _amt,
            "power_after": int(skill.power or 0), "evidence": _eff.evidence,
        })
    # task-28（`728 撒娇`）：**全技能威力永久+N** 的本手读取 —— 读 `global_skill_mods["power_pct"]` ✓
    # ⚠ **口径**（Lead 裁决 ✓）：**"永久"指之后 ⇒ 本手不吃自己这次的永久** ✓
    #   ⇒ 位置在 `compute_damage` **之前**、而**本手自己的写入在伤害之后**（效果在攻击支末尾才施加 ✓）
    #     ⇒ ⇒ **天然满足**"不吃自己这次的" ✓（不需要额外排除逻辑 ✓）
    if bool(getattr(cfg, "damage_global_skill_mods", False)):
        _pct = int((getattr(me.field_pet, "global_skill_mods", None) or {}).get("power_pct", 0) or 0)
        if _pct:
            skill = dataclasses.replace(skill, power=int((skill.power or 0) * (1 + _pct / 100.0)))
            _bump(state, "global_power_applied", {
                "side": side, "skill_id": skill.skill_id, "power_pct": _pct,
                "power_after": int(skill.power or 0),
            })
    _initiative = next((e for e in parsed_atk.effects if e.kind == "initiative_power"), None)
    if _initiative is not None:
        _applied, _why = _initiative_condition_holds(state, rs, side)
        if _applied:
            _pct = int(_initiative.value.get("power_pct") or 0)
            # task-28（2026-09-30）：**「改为N连击」**（`skill_000689 疾风刺`）—— 与上面同一个 effect kind，
            # 只多读一个键 ✓。⚠ **条件不成立时这一支根本不会执行** ⇒ 连击数照基础值（1 连击）✓
            _hits = int(_initiative.value.get("hits") or 0)
            if _hits:
                hit_count = _hits
            # 加成加在**威力**上（本仓唯一的伤害公式读 power）。
            skill = dataclasses.replace(skill, power=int((skill.power or 0) * (100 + _pct) / 100))
            _bump(state, "initiative_condition_applied", {
                "side": side, "skill_id": skill.skill_id, "power_pct": _pct,
                "hits": _hits,
                "evidence": _initiative.evidence})
        else:
            # 条件不成立 ⇒ 如实记一条（不是未实现，是**这次没满足**）。
            _bump(state, "initiative_condition_skipped", {
                "side": side, "skill_id": skill.skill_id, "reason": _why})
    # ── C1（第 139 轮）：位置子系统 —— 号位条件 + 传动 ─────────────────────────
    # 位置在构建时已知（`me.loadouts[pet_id]` 是有序元组），所以这是**确定性**条件。
    # 两条能力**只有配置声明了才生效**：legacy / v2 没声明 → 一个字节都不变。
    slot_declared = bool(getattr(cfg, "damage_slot_condition", False))
    shift_declared = bool(getattr(cfg, "damage_position_shift", False))
    if slot_declared or shift_declared:
        parsed_pos = parse.resolve_position_mechanics(
            skill, slot_declared=slot_declared, shift_declared=shift_declared)
        loadout = list(me.loadouts.get(pet.pet_id) or ())
        try:
            position = loadout.index(skill.skill_id) + 1
        except ValueError:
            position = None
        if slot_declared and position is not None:
            for cond in parsed_pos.slot_conditions:
                if position not in cond.get("slots", []):
                    continue
                if cond.get("power_delta"):
                    # 加在**威力**上（引擎唯一的伤害公式读 power），不是直接改伤害。
                    skill = dataclasses.replace(skill, power=(skill.power or 0) + int(cond["power_delta"]))
                if cond.get("combo_bonus"):
                    hit_count = (hit_count or 1) + int(cond["combo_bonus"])
                # task-28（2026-09-30）：第三种形状「额外获得<属性>+N%」（`skill_000483 啮合传递`）——
                # **读点走现成的 `buffs`**（与 `self_stat` 那一支**同一条写点**：`pet.buffs[key] += delta_pct` ✓
                # ⇒ 伤害按伤害类别读、先手读 `spe` ✓ 引擎不必新增任何读点 ✓）。
                if cond.get("stat") and cond.get("delta_pct"):
                    _key = str(cond["stat"])
                    _st_pet.buffs[_key] = _st_pet.buffs.get(_key, 0) + int(cond["delta_pct"])
                _bump(state, "slot_condition_applied", {
                    "side": side, "skill_id": skill.skill_id, "position": position,
                    "power_delta": int(cond.get("power_delta") or 0),
                    "combo_bonus": int(cond.get("combo_bonus") or 0),
                    "stat": cond.get("stat"), "delta_pct": int(cond.get("delta_pct") or 0),
                    "evidence": cond.get("evidence"),
                })
                break
        if shift_declared and parsed_pos.position_shift and loadout:
            # 传动：用后把这个技能移动 N 位（超界就环回），位置变了号位条件也随之变。
            n = int(parsed_pos.position_shift)
            if skill.skill_id in loadout:
                idx = loadout.index(skill.skill_id)
                loadout.pop(idx)
                loadout.insert((idx + n) % (len(loadout) + 1), skill.skill_id)
                me.loadouts[pet.pet_id] = tuple(loadout)
                _bump(state, "position_shift", {
                    "side": side, "skill_id": skill.skill_id, "shift": n,
                    "order": list(loadout),
                })

    outcome = fx.compute_damage(pet, defender, skill, rs,
                                attacker_species=attacker_pet,
                                defender_species=defender_pet,
                                hit_count=hit_count,
                                cfg=cfg,   # 伤害按类别取面板与否，由**这一局**的配置说了算
                                # 2026-09-25：天气是**场地级**的威力加成（雨天水系 +75%），
                                # 只按配置声明的口径加；没声明就什么都不加。
                                weather=state.weather)
    damage = outcome.damage
    actual = min(defender.hp, damage)
    defender.hp -= actual

    state.log.append(
        f"{label}的{attacker_pet.name}使用{skill.name}"
        f"{'（' + str(hit_count) + ' 连击）' if hit_count > 1 else ''}，对{defender_pet.name}造成 {actual} 伤害"
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
        # RC-401：只在这一手真的按连击结算时才带 `hits`——legacy 的事件一个字节都不动。
        **({"hits": hit_count} if hit_count > 1 else {}),
        # 2026-09-30（Q8 收口）：伤害用的是哪一套六维（攻/防分别登记，带整份面板）。
        # **只在真的用了个体快照时出现**这把键 —— 没有快照的老路径事件逐位不变，
        # 与 `hits` / `energy_cost_mods` 同一条能力位纪律。
        **({"individual_panel": outcome.panel_provenance}
           if outcome.individual_panel_used() else {}),
    }, evidence=(skill.skill_id,))

    # ── task-28（2026-09-30 · 427 并集 D 族余项）：`skill_000289 无畏之心` ──────────────
    # 「减伤100%，**应对攻击：减免的伤害变为回复自己生命**，且本技能能耗永久+2。」
    # ⚠ 能力位门控（`damage.respond_reduction_to_heal`）：没声明（legacy / v2）⇒ **一段都不产出** ✓
    # ⚠ **判据与结算共用同一个 resolver**（`parse.resolve_respond_reduction_to_heal`）✓ —— 不各写一份 ✗
    # ⚠ **只转"被减伤挡掉的那部分"** ✓：`减免量 = outcome.raw − damage`（`effects.py:550` 两个量现成 ✓）；
    #    **穿过去的那点残余伤害照旧结算** ✓（289 减伤 100% 时仍有 1 的下限 ⇒ 不是"整下都不吃" ✗）。
    # ⚠ 只在该**防守方这一手真的应对成功**时转 ✓（`_respond_succeeded` 由防御支写 ✓）
    if bool(getattr(cfg, "damage_respond_reduction_to_heal", False)) and outcome.defense_reduction > 0:
        _opp = _opponent_action_of(state, side)
        if (_opp is not None and getattr(_opp, "kind", "") == ACTION_SKILL and _opp.skill_id
                and bool(getattr(defender, "_respond_succeeded", False))):
            _dsk = rs.skills.get(_opp.skill_id)
            if _dsk is not None:
                _dp = parse.resolve_respond_reduction_to_heal(_dsk, declared=True)
                if any(getattr(e, "kind", "") == "respond_reduction_to_heal" for e in _dp.effects):
                    _mitigated = max(0, int(outcome.raw) - int(damage))
                    _healed = min(_mitigated, max(0, int(defender.max_hp) - int(defender.hp)))
                    if _healed > 0:
                        defender.hp += _healed
                        _bump(state, "heal", {
                            "side": "enemy" if side == "player" else "player",
                            "healed": _healed, "skill_id": _dsk.skill_id,
                            "from": "respond_reduction_to_heal", "mitigated": _mitigated,
                        })

    if defender.hp <= 0:
        defender.hp = 0
        defender.fainted = True
        defender.charge = None
        state.log.append(f"{defender_pet.name}倒下了。")
        _bump(state, "faint", {"side": foe_side, "slot": defender.slot}, evidence=("3009",))
        # RC-401 批次十七（task-26 H 族批一）：「**每次击败敌方，本技能<属性>永久±N**」。
        # 落点就在**真的把对手打倒下**这一支里（`faint` 事件旁边）⇒ 触发器与事实同源 ✓
        # （`skill_000382 流星火雨` 威力+85 · `skill_000792 趁火打劫` 连击数+2）
        _parsed_defeat = parse.resolve_triggered_ramp(
            skill, declared=bool(getattr(cfg, "damage_triggered_ramp", False)))
        _accumulate_triggered_ramp(state, pet, skill, _parsed_defeat,
                                   trigger="defeat_foe", happened=True, cfg=cfg)
        # RC-105：力竭 → 那一方扣魔力；归零就立即判负（只在声明了 mana 的配置下发生）
        _settle_faint_mana(state, rs, cfg, foe_side)

    # 2026-09-24（人类口径 B）：**愿力冲击用掉之后第一个技能自动还原**。
    # 旧读法是「替换持续到再用一次愿力强化解除」（人类更早的口述），新口径是**一次性**：
    # 借来的那一招打出去之后就还回去。这里在**伤害结算完成之后**还原（先结算再还原，
    # 否则会把同一回合的连击/传动/号位条件读错），并且**不动次数与冷却** ——
    # 愿力强化在用它的时候就已经扣过次数、进过冷却了。
    # ⚠ 必须把**这一手打出去的那个技能**传进去：不传就等于「任何攻击技能都会把愿力冲击
    # 收回」（BUG-1，2026-09-24 真机复现）。
    consumed_wish = _restore_if_wish_impact(state, rs, side, skill)

    # RC-401 批四：造成伤害之后的吸血 / 过量回复转化（没有 `sustain` 时一步都不做）。
    _settle_sustain(state, rs, side, actual)

    # RC-401 批次十三：**挨打的那一方**的「每被攻击1次…永久±N」在这里累加
    #（「不含连击」⇒ 一次攻击只算一次，不看 hit_count）。
    _accumulate_on_hit_ramps(state, rs, defender, "enemy" if side == "player" else "player",
                             skill, outcome, cfg)

    # 附带效果：**先应用解析得出的部分，再登记认不出来的部分**。
    # 以前这里什么都没有 —— 「造成魔伤，自己回复1能量」被整条静默丢弃
    # （实测 energy 不变、events=['damage']、unsupported=[]）。纪律不允许：
    # 要么真的生效，要么如实登记。禁止把 unsupported 效果近似成普通伤害。
    if parsed_atk.effects or parsed_atk.unparsed:
        applied = _apply_effect_batch(state, rs, side, skill, parsed_atk, cfg)
        if applied:
            state.log.append(f"{skill.name}的附带效果结算 {applied} 条。")
        # 解析不出来的、以及描述里没被任何解析结果认领的机制词，全部登记。
        _register_parsed_effects(
            state, rs, side, skill, parsed_atk, applied=True,
            reason="攻击分支只结算伤害、以及**已解析并已应用**的附带效果；"
                   "这一段没有对应的实现",
            cfg=cfg,
        )


def _apply_respond_override(state: GameState, rs: Ruleset, side: str, skill, parsed,
                            *, succeeded: bool, cfg: Optional[RuleConfig] = None):
    """RC-401 批次十四（2026-09-29 task-20）：「应对X：**改为** …」的**覆盖语义**落地。

    返回 `(parsed, landed)`。`landed=True` 表示**覆盖真的生效了**：被覆盖的那条基础效果已经
    从 `parsed.effects` 里**摘掉**，换成「改为」派生的那一条 —— 是**替换**，不是追加
    （「敌方获得3层中毒，应对防御：改为获得8层」里 3 与 8 互斥；`_RESPOND_OVERRIDE` 的
    旧注释早就写了这条读法，只是此前没有任何一处真的实现它）。

    没生效的三种情形都要**如实登记**，一条都不许静默（这是本批的全部理由 ——
    实测 `skill_000616` 应对成功那一手照样读 3 层，而 `unsupported` 里一条都没有）：
      ① 应对没成功 ⇒ 基础值照旧（「改为」那一支的条件确实没成立，不是"未实现"）；
      ② 子句在、但本引擎读不出来（`leftover` 非空）⇒ 基础值照旧 + 点名那段原文；
      ③ 覆盖目标找不到 ⇒ 一条都不动（**绝不"既留基础又加改为"**，那等于把覆盖当追加）。
    描述里根本没有这条子句时（`respond_override is None`）本函数什么都不做。
    """
    ov = getattr(parsed, "respond_override", None)
    if not ov:
        return parsed, False
    evidence_text = str(ov.get("evidence") or "")
    override_effects = list(ov.get("effects") or [])
    if not override_effects:
        # ② 读不出来：基础值照旧，但**点名**这一段，不许静默（fail closed，不猜一个数）。
        _note_unsupported(
            state, f"技能「{skill.name}」的应对覆盖子句",
            f"描述片段「{evidence_text or ov.get('body')}」："
            f"{ov.get('leftover') or '本引擎还没有实现这一种覆盖写法'}"
            "—— 该段不结算，基础效果按原文照旧",
            skill.skill_id,
        )
        _bump(state, "respond_override_unsupported", {
            "side": side, "skill_id": skill.skill_id,
            "body": ov.get("body"), "reason": str(ov.get("leftover") or "not_implemented"),
        })
        return parsed, False
    if not succeeded:
        # ① 条件没成立：基础值照旧（这一步的读法与防御支既有那条逐字一致）。
        _note_unsupported(
            state, f"技能「{skill.name}」的应对覆盖子句",
            f"描述片段「{evidence_text}」只在应对成功时生效，这一手没有应对成功"
            f"（要应对的类别：{ov.get('respond_to')}）⇒ 基础效果照旧结算，「改为」的值未生效",
            skill.skill_id,
        )
        _bump(state, "respond_override_skipped", {
            "side": side, "skill_id": skill.skill_id,
            "respond_to": ov.get("respond_to"), "reason": "respond_failed",
        })
        return parsed, False
    # ③ `mode="hits"`（RC-401 批次十五）：覆盖的是**这一手结算几次**，不是某条 Effect ——
    #    没有"被替换的基础效果"可摘。命中数由调用方（攻击支）从 `applied_hits` 取走，
    #    这里只负责判条件、留数、登记；**顺序必须在"定位基础效果"之前**，
    #    否则会被当成"认不出被覆盖的基础效果"而一条都不结算 ✗。
    if ov.get("mode") == "hits":
        hits = int(ov.get("hits") or 0)
        if hits <= 0:
            _note_unsupported(
                state, f"技能「{skill.name}」的应对覆盖子句",
                f"描述片段「{evidence_text}」读出来的连击数是 {hits}（≤0 无意义）⇒ 不结算，等核对",
                skill.skill_id,
            )
            return parsed, False
        ov["applied_hits"] = hits
        _bump(state, "respond_override_applied", {
            "side": side, "skill_id": skill.skill_id,
            "respond_to": ov.get("respond_to"), "mode": "hits",
            "replaced": {"hits": int(ov.get("base_hits") or 1)},
            "with": {"hits": hits, "multiplier": ov.get("hit_multiplier")},
            "evidence": evidence_text,
        }, evidence=("1017", "3005"))
        return parsed, True
    # ③′ 定位被覆盖的那条基础效果：先用解析时记下的下标（带原文双重校验），退化到按原文找。
    idx = ov.get("replaces_index")
    want = str(ov.get("replaces_evidence") or "")
    removed, where = None, None
    effects = list(parsed.effects)
    if isinstance(idx, int) and 0 <= idx < len(effects) and effects[idx].evidence == want:
        removed, where = effects[idx], idx
    else:
        for i, eff in enumerate(effects):
            if want and eff.evidence == want:
                removed, where = eff, i
                break
    if removed is None:
        # 一条都不动 —— 找不到被覆盖的那条，就无法把守卫替换掉；"既留基础又加改为"就是追加 ✗
        _note_unsupported(
            state, f"技能「{skill.name}」的应对覆盖子句",
            f"描述片段「{evidence_text}」认不出被覆盖的基础效果"
            f"（原记：{want!r}）⇒ 基础效果与改为值都不结算，等核对",
            skill.skill_id,
        )
        return parsed, False
    parsed.effects = effects[:where] + effects[where + 1:] + override_effects
    _bump(state, "respond_override_applied", {
        "side": side, "skill_id": skill.skill_id,
        "respond_to": ov.get("respond_to"),
        "replaced": {"kind": removed.kind, "value": dict(removed.value)},
        "with": [{"kind": e.kind, "value": dict(e.value)} for e in override_effects],
        "evidence": evidence_text,
    }, evidence=("1017",))
    return parsed, True


def _apply_status_effects(state: GameState, rs: Ruleset, side: str, skill,
                          cfg: Optional[RuleConfig] = None) -> bool:
    cfg = cfg or _rule_config.get_rule_config()
    """应用一个状态技能被解析出来的效果。返回是否**至少应用了一条**。

    纪律：只有描述能被 `parse.py` 机械读出时才应用；解析出未覆盖机制时返回 False，
    由调用方登记为 unsupported。**不做部分应用**——半套效果比不支持更危险，
    因为它会让上层以为这个技能已经可用。
    """
    parsed = parse.resolve_foe_energy_loss(
        skill, declared=bool(getattr(cfg, "energy_foe_energy_loss", False)))
    # task-28（2026-09-30）：**号位 / 传动**（`483 啮合传递`「本技能位于1号或3号位时额外获得物攻+80%，传动1」）。
    # 状态链过去**缺这一个 resolver** ⇒ `unparsed` 里永远留着「号位」「传动」两条标记 ⇒
    # 末尾那道闸 `if not parsed.effects or parsed.unparsed: return False` **整条 bail**
    # ⇒ 外层报 `status_unsupported`（实测 483 真打一手：零 buff 事件 ✗ —— 连它**已经能算**的
    # 「自己获得速度+30」也一起被挡住）。
    # 位置**照 `coverage.resolve_claims` 的顺序**：它是第 2 位（紧跟 `foe_energy_loss` 之后）。
    # 签名与别的 resolver 不同：**没有 `declared=`**，要传 `slot_declared=` / `shift_declared=` ✓
    parsed = parse.resolve_position_mechanics(
        skill, slot_declared=bool(getattr(cfg, "damage_slot_condition", False)),
        shift_declared=bool(getattr(cfg, "damage_position_shift", False)), parsed=parsed)
    # task-27：印记的驱散（没声明能力位就什么都不加 ⇒ legacy 逐字不变）
    # task-28（2026-09-30）**号位消费者**（`483 啮合传递` 的另一半）。
    # 上一半只让那道闸开了（`unparsed` 被清空），但 `slot_conditions` 在**状态支没有消费者**
    # ⇒ 位号 1/3 的「额外获得物攻+80%」一个字都不落（实测：只有 `buff_self_flat{spe+30}`）。
    # 这一节**整段照攻击支（`env.py:1440-1487`）的形状搬**，读法/事件/能力位都与它一致：
    #   · 位次**只能**从 `me.loadouts[pet_id]` 的 index 读（技能对象上没有"位次"字段 ✓）
    #   · `stat/delta_pct` ⇒ 走**现成的 `pet.buffs` 写点**（与 `self_stat` 同一处）
    #   · 两处**状态支特有**的差异如实处理、不静默丢：没有威力/连击可改 ⇒ `power_delta`/`combo_bonus`
    #     仍照实写进事件（值如实），且**不做** `dataclasses.replace(skill, power=…)`
    _slot_declared = bool(getattr(cfg, "damage_slot_condition", False))
    _shift_declared = bool(getattr(cfg, "damage_position_shift", False))
    if _slot_declared or _shift_declared:
        # ⚠ 这里**不能**用 `me`/`pet`：它们在 `_apply_status_effects` 里**稍后**才绑定
        #   （第一版搬过来直接用 ⇒ `UnboundLocalError` 把**所有状态技**打崩 —— `ast.parse` 照样过 ✗，
        #    靠"真打一手"才抓到 ✓）。所以就地取这一方的状态。
        _st_side = getattr(state, side)
        _st_pet = _st_side.field_pet
        loadout = list(_st_side.loadouts.get(_st_pet.pet_id) or ())
        try:
            position = loadout.index(skill.skill_id) + 1
        except ValueError:
            position = None
        if _slot_declared and position is not None:
            for cond in getattr(parsed, "slot_conditions", ()) or ():
                if position not in cond.get("slots", []):
                    continue
                if cond.get("stat") and cond.get("delta_pct"):
                    _key = str(cond["stat"])
                    _st_pet.buffs[_key] = _st_pet.buffs.get(_key, 0) + int(cond["delta_pct"])
                _bump(state, "slot_condition_applied", {
                    "side": side, "skill_id": skill.skill_id, "position": position,
                    "power_delta": int(cond.get("power_delta") or 0),
                    "combo_bonus": int(cond.get("combo_bonus") or 0),
                    "stat": cond.get("stat"), "delta_pct": int(cond.get("delta_pct") or 0),
                    "evidence": cond.get("evidence"),
                    "note": "状态技没有威力/连击可改 ⇒ 只落 stat/delta_pct（其余字段如实报 0）",
                })
                break
        if _shift_declared and getattr(parsed, "position_shift", None) and loadout:
            _n = int(parsed.position_shift)
            if skill.skill_id in loadout:
                _idx = loadout.index(skill.skill_id)
                loadout.pop(_idx)
                loadout.insert((_idx + _n) % (len(loadout) + 1), skill.skill_id)
                _st_side.loadouts[_st_pet.pet_id] = tuple(loadout)
                _bump(state, "position_shift", {
                    "side": side, "skill_id": skill.skill_id, "shift": _n, "order": list(loadout)})

    parsed = parse.resolve_cleanse_marks(
        skill, declared=bool(getattr(cfg, "damage_cleanse_marks", False)), parsed=parsed)
    parsed = parse.resolve_global_skill_mod(
        skill, declared=bool(getattr(cfg, "damage_global_skill_mod_text", False)), parsed=parsed)
    parsed = parse.resolve_foe_switch_condition(
        skill, declared=bool(getattr(cfg, "damage_foe_switch_condition", False)), parsed=parsed)
    parsed = parse.resolve_per_use_ramp(
        skill, declared=bool(getattr(cfg, "damage_per_use_ramp", False)), parsed=parsed)
    # RC-401 批次十一：条件效果先按"对手这回合有没有换人"筛一遍（不成立就摘掉、如实记 skipped）。
    parsed, _ = _gate_foe_switch_effects(state, side, skill, parsed, cfg)
    # task-28（H 族 `720 示弱`）：「<谁>获得萌化：<效果>」⇒ **两条效果**（各有各的门 ✓）
    # ⚠ 复用**现成**写点：`self_mark`/`foe_mark`（`marks` ✓）· `self_stat_flat`（`buffs_flat` ✓）—— **不新开分支** ✗
    # task-28（`724`）：同上（状态支也接 ✓）
    parsed = parse.resolve_self_debuff_power(
        skill, declared=bool(getattr(cfg, "damage_cond_self_debuff_power", False)
                              and getattr(cfg, "damage_self_power_flat", False)), parsed=parsed)
    parsed, _ = _gate_self_debuff_effects(state, side, skill, parsed, cfg)
    parsed = parse.resolve_moe_colon(
        skill, declared=bool(getattr(cfg, "damage_moe_mark", False)), parsed=parsed,
        flat_declared=bool(getattr(cfg, "stat_gain_flat", False)),
        power_declared=bool(getattr(cfg, "damage_self_power_flat", False)),
        global_declared=bool(getattr(cfg, "damage_global_skill_mods", False)))
    # task-28（`722 反弹`）：**自己有标记才生效**的条件门（与上面那条**同形** ✓）
    parsed = parse.resolve_mark_transfer(
        skill, declared=bool(getattr(cfg, "damage_moe_mark", False)), parsed=parsed)
    parsed, _ = _gate_self_mark_effects(state, side, skill, parsed, cfg)
    # RC-401 批次十四（2026-09-29 task-20）：**「应对X：改为…」的覆盖语义**。
    # ⚠ 状态支**以前完全没接这一支** —— 实测 `skill_000616 剧毒`（category=状态、
    # `is_defense=False` ⇒ 永远进不了防御支）应对成功那一手照样读 `status_added{layers:3}`，
    # 而说明写的是 8，且 `unsupported` 里一条都没有（静默错值）。
    # `_respond_succeeded` 在 `_execute` 第 1079 行就已设好，状态支读得到。
    # task-28（2026-09-30 · D 族 `462 放晴`）：**基础子句**「<系>技能威力永久±N%」先产出一条 effect ✓
    # ⚠ **必须在 `resolve_respond_override` 之前** —— 覆盖要"有东西可覆盖" ✗
    #   （既有纪律逐字：「③ 覆盖目标找不到 ⇒ **一条都不动**，绝不'既留基础又加改为'」✓
    #     顺序反了 ⇒ 覆盖只会留残余 ⇒ 462 永远结算不了 ✗）
    parsed = parse.resolve_element_power_ramp(
        skill, declared=bool(getattr(cfg, "damage_element_power_ramp", False)), parsed=parsed)
    parsed = parse.resolve_respond_override(
        skill, declared=bool(getattr(cfg, "energy_respond_override", False)), parsed=parsed)
    # 2026-09-29（task-25）：A 族「获得 属性±N」的扩展形状 / 平值。
    # ⚠ 放在 `resolve_respond_override` **之后**，与 `coverage.resolve_claims` 同位置 ——
    # 本解析器会跳过"已被别的效果认领的区间"，覆盖语义先认领掉「应对…：改为…」那一段，
    # 这里就不会把条件效果当成无条件效果产出（实测 `skill_000790` 的那一段就是它）。
    parsed = parse.resolve_stat_gain_extended(
        skill, declared=bool(getattr(cfg, "stat_gain_extended", False)),
        flat_declared=bool(getattr(cfg, "stat_gain_flat", False)), parsed=parsed)
    if getattr(parsed, "respond_override", None) is not None:
        _me = getattr(state, side)
        parsed, _ = _apply_respond_override(
            state, rs, side, skill, parsed,
            succeeded=bool(getattr(_me.field_pet, "_respond_succeeded", False)), cfg=cfg)
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
    #: 「每驱散 1 层，<效果>」的层数传递（上一条 `cleanse_marks` 写、下一条消费）
    pending_cleansed_layers: Optional[int] = None

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
        # 2026-09-29（task-25）：**平值**属性修正（描述里不带 `%` 的那一类）。
        # 与 `self_stat` / `foe_stat` **分开记账**：那两个是百分点（`buffs`），
        # 这两个是面板量纲的绝对值（`buffs_flat`）。目前唯一读点是先手速度
        # （`order_speed` 的 `_speed_with_buffs`），全库实测平值只出现在速度上。
        # 事件名也分开（`buff_self_flat` / `debuff_foe_flat`）—— 上层能一眼看出量纲，
        # 不会把「+120 点速度」读成「+120%」。
        elif eff.kind in ("self_stat_flat", "foe_stat_flat"):
            key = str(v["stat"])
            # ⚠ 2026-09-29（Lead 批准 engin-mechanics 的盘点）：**键白名单 + fail closed**。
            # 读取方全仓只有 `env.order_speed` 两处、**都只认 `spe`**（见 `parse.BUFFS_FLAT_READ_KEYS`）；
            # 不筛键地写进去 = **事件发了、状态被静默忽略**（"写了没人读"，与 task-25 的 11 条假绿同一族）。
            # 未筛键 ⇒ **不静默写**，如实走 `_note_unsupported`（也不静默丢弃 —— 那是另一种假绿）。
            if key not in parse.BUFFS_FLAT_READ_KEYS:
                _note_unsupported(
                    state, f"技能「{skill.name}」的平值属性修正（{key}）",
                    f"`buffs_flat` 目前只有 {'、'.join(parse.BUFFS_FLAT_READ_KEYS)} 有读点；"
                    f"把 {key} 写进去会**静默失效**（事件照发、没人读）⇒ 这里 fail closed：不写、如实登记",
                    skill.skill_id)
                continue
            holder = pet if eff.kind == "self_stat_flat" else foe.field_pet
            holder.buffs_flat[key] = holder.buffs_flat.get(key, 0) + int(v["delta_flat"])
            applied += 1
            _bump(state, "buff_self_flat" if eff.kind == "self_stat_flat" else "debuff_foe_flat",
                  {"side": side, "stat": key, "delta_flat": v["delta_flat"]},
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
        elif eff.kind in ("global_cost_delta", "global_power_pct"):
            # task-28（`721`/`728`）：**全技能级**持久修正 ⇒ 写 `PetState.global_skill_mods` ✓
            # ⚠ **作用域 = 所有技能** ✗（**不是** `skill_ramps` ✗ 那是逐技能 ✓）
            _key = "cost_delta" if eff.kind == "global_cost_delta" else "power_pct"
            _val = int(v.get("delta") or 0)
            _mods = dict(getattr(pet, "global_skill_mods", None) or {})
            _before = int(_mods.get(_key, 0) or 0)
            _mods[_key] = _before + _val
            pet.global_skill_mods = _mods
            applied += 1
            _bump(state, "global_skill_mod_applied", {
                "side": side, "skill_id": skill.skill_id, "key": _key,
                "delta": _val, "total": _before + _val, "evidence": eff.evidence,
            })
        elif eff.kind == "transfer_mark":
            # task-28（`722 反弹`）：**搬家** —— `self → foe`，**自己那份清零** ✗ **不是复制** ✗
            # ⚠ 层数 = "自己现有的层数"（描述没写层数 ✓）；条件门已在 `_gate_self_mark_effects` 里筛过 ✓
            _mk = str(v.get("mark") or "")
            _n = int((pet.marks or {}).get(_mk, 0) or 0)
            if _n > 0:
                pet.marks[_mk] = 0                      # 自己清零 ✓
                tgt = foe.field_pet
                tgt.marks[_mk] = tgt.marks.get(_mk, 0) + _n
                applied += 1
                _bump(state, "mark_transferred",
                      {"side": side, "mark": _mk, "layers": _n}, evidence=("task-28",))
            continue
        elif eff.kind == "foe_status":
            name = str(v["status"])
            # task-28（H 族 285）：**标记化的状态**（萌化）路由到 `marks` ✓ —— 复用下面
            # `self_mark`/`foe_mark` 支**同一写法**（`marks[name] += layers` ✓ 不新造字段 ✗）
            # ⚠ **能力位门控**：没声明（legacy / v2）⇒ **一个字都不写** ✓（逐位不变 ✓）
            # ⚠ 顺序：**在** `END_OF_TURN_STATUS` 之前判 ✓ —— 否则 `spec is None` 那条
            #   `_note_unsupported + continue` 会先把这一手吃掉 ✗（实测：285 现在只登记、空转 ✓）
            if name in STATUS_AS_MARK and bool(getattr(cfg, "damage_moe_mark", False)):
                tgt = foe.field_pet
                tgt.marks[name] = tgt.marks.get(name, 0) + int(v["layers"])
                applied += 1
                _bump(state, "mark_added", {"side": "enemy", "mark": name,
                                            "layers": int(v["layers"])}, evidence=("task-28",))
                continue
            spec = fx.END_OF_TURN_STATUS.get(name)
            if spec is None:
                # 未实现的持续状态：登记，不当成生效。
                _note_unsupported(
                    state, f"状态「{name}」", "该状态没有回合末结算实现（effects.py 未登记）",
                    skill.skill_id,
                )
                continue
            tgt = foe.field_pet
            prev = tgt.statuses.get(name, {})
            added = int(v["layers"])
            # 2026-09-29（第三轮⑥）：**声明了本地规则**的状态才有层数上限与持续回合。
            # `local_rule=None`（legacy / v2）⇒ 事件 detail 与状态形状**逐位不变**：
            # 老路径的 `status_added` 只有 `{side, status, layers}` 三个键
            #（`test_turn_order_fail_closed` 的 golden 指纹就钉着它）。
            local_rule = (getattr(cfg, "status_end_of_turn", None) or {}).get(name)
            total = int(prev.get("layers", 0)) + added
            detail_added: Dict[str, Any] = {"side": "enemy", "status": name, "layers": added}
            if local_rule is not None:
                cap = int(local_rule.get("max_layers", total))
                # RC-401 批次十七（2026-09-29，人类逐字：「为什么不行，**针对这一个技能改一下**不行吗？」）：
                # 「应对X：**改为获得N层**」是**这一条技能明写的数值** ⇒ 允许突破本地规则的
                # **全局**层数上限；**普通路径（没有这一支）照旧被夹住** ✓
                # `cap_override` 只由 `parse.resolve_respond_override` 的派生效果带上，
                # 而它只在**配置声明了能力位**时才存在 ⇒ legacy / v2 一个字节都不变。
                cap_override = v.get("cap_override")
                if cap_override:
                    tgt.statuses[name] = {"layers": total,
                                          "turns_left": int(local_rule.get("duration_turns", 1))}
                    detail_added["layers_total"] = total
                    detail_added["turns_left"] = int(local_rule.get("duration_turns", 1))
                    detail_added["damage_rule"] = "LOCAL_RULE"
                    # 透明记录保留：说清「这个值为什么没被全局上限夹住」。
                    detail_added["cap_override"] = str(cap_override)
                    detail_added["max_layers"] = cap
                else:
                    capped_from = total if total > cap else None
                    total = min(total, cap)
                    # 重复施加：层数继续叠（封顶），**持续回合按新的一次刷新**。
                    tgt.statuses[name] = {"layers": total,
                                          "turns_left": int(local_rule.get("duration_turns", 1))}
                    detail_added["layers_total"] = total
                    detail_added["turns_left"] = int(local_rule.get("duration_turns", 1))
                    detail_added["damage_rule"] = "LOCAL_RULE"
                    if capped_from is not None:
                        detail_added["capped_from"] = capped_from
                        detail_added["max_layers"] = int(local_rule.get("max_layers", total))
            else:
                tgt.statuses[name] = {"layers": total}
            applied += 1
            _bump(state, "status_added", detail_added,
                  evidence=(spec.get("term", ""),))
            # ⚠ 2026-09-30（task-28）**删掉了一支死代码，改钉不删**：
            #   原文逐字（删除前就在这个位置）——
            #       if name == "冻结":
            #           # 特性钩子（捉迷藏）。以前这一支永远不可达（前面的 elif 已经吃掉
            #           # 所有 `foe_status`），现在挂在同一个分支里。
            #           evs2: List[Dict[str, Any]] = []
            #           tr.after_freeze_applied(rs, state, side, evs2)
            #           for e in evs2:
            #               _bump(state, e.pop("kind"), e)
            #   **为什么删**（两条，都是实测/裁决，不是"看着没用"）：
            #     ① **它其实仍不可达** ✗ —— 这一支在 `spec = fx.END_OF_TURN_STATUS.get(name)` 的
            #        `if spec is None: … continue` **之后**，而 `冻结` 恰恰**不在**那张表里
            #        （表里只有 中毒/灼烧/寄生）⇒ 技能路径永远到不了这里。
            #        上一版注释写「以前这一支永远不可达 ⇒ **现在挂在同一个分支里**」是**错的** ✗
            #        （那次只挪了位置、没注意 `continue` 在前面）—— 留着它就是**第二个陷阱** ✗。
            #     ② **就算可达，语义也不对** ✗ —— `after_freeze_applied` 是**特性**的钩子
            #        （`捉迷藏` / `抓到你了`：使敌方获得冻结时自己全技能能耗 +1）。
            #        **技能施加冻结 ≠ 触发那个特性** ✓ ⇒ 技能路径**不该**调它。
            #        特性自己的路径在 `traits.py` 里**直调**同一个钩子 ✓（`traits.py:438`，那是对的 ✓）。
            #   ⚠ 风险留档：谁哪天把 `冻结` 加进 `END_OF_TURN_STATUS`，这一支若还在就会突然变活、
            #     与特性路径**双触发** ✗ ⇒ 已由 `roco/tests/test_frozen_status.py` 两条判据钉住 ✓
        elif eff.kind == "cleanse":
            # task-26 P0 **止血**（2026-09-30）：**按 `what` 分派** ——
            # 过去这一支**不看 `what`、无差别清 `foe.field_pet.buffs`** ✗ ⇒
            # 「驱散**双方所有印记**」（`what=None`）会**清掉敌方的增益**、而**双方 `marks` 一层没动** ✗✗
            # ⇒ 玩家看到的副作用**与描述无关** ✗（`engine-mechanics` 实测：408 焚烧烙印
            #    `cleanse{cleared:["spa"]}` + 我方 `{"风起印记":2}` 敌方 `{"星陨印记":3}` 都还在 ·
            #    332 倾泻 `cleared:[]` 只是"对手当时没有 buffs"**碰巧没副作用** ✗）。
            # 口径：**认得出的照做；认不出的 fail closed**（不执行 + 如实登记 + **不计 applied**）——
            # 宁可什么都不做并报不支持，也**不许做错另一件事** ✗。
            _what = str(v.get("what") or "")
            if not bool(getattr(cfg, "damage_cleanse_dispatch", False)):
                # ⚠ **没声明这个能力位**（legacy / v2）⇒ **走原来那一支，逐字不变** ✓
                # （`test_turn_order_fail_closed` 的 golden 指纹钉着它 ⇒ 不许动 ✗）
                cleared = sorted(foe.field_pet.buffs)
                foe.field_pet.buffs.clear()
                applied += 1
                _bump(state, "cleanse", {"side": side, "cleared": cleared})
                continue
            if _what in ("增益", "减益"):
                _buffs = dict(getattr(foe.field_pet, "buffs", None) or {})
                _hit = sorted(k for k, n in _buffs.items()
                              if (int(n or 0) > 0) == (_what == "增益") and int(n or 0) != 0)
                for _k in _hit:
                    _buffs.pop(_k, None)
                foe.field_pet.buffs = _buffs
                applied += 1
                _bump(state, "cleanse", {"side": side, "what": _what, "cleared": _hit})
            else:
                _note_unsupported(
                    state, "驱散",
                    f"「{eff.evidence}」这一种驱散（`what`={_what or 'None'}）没有实现 ⇒ **不执行**"
                    "（以免出现与描述无关的副作用）", eff.evidence or "")
                _bump(state, "cleanse_unsupported", {
                    "side": side, "what": (_what or None), "evidence": eff.evidence})
        elif eff.kind == "cleanse_marks":
            # task-27（2026-09-30）：**印记的驱散**。与上面那一支（清 `buffs` 键名）分开：
            # 印记有**层数**维度，事件里必须把 `{印记名: 层数}` 带出来 ——
            # 下游「每驱散 1 层，<效果>」就吃这个层数（`per_cleansed_layer`，紧随其后）。
            _m_side = str(v.get("side") or "foe")
            _m_scope = str(v.get("scope") or "all")
            _targets = []
            if _m_side in ("foe", "both"):
                _targets.append(("enemy", foe.field_pet))
            if _m_side in ("self", "both"):
                _targets.append((side, pet))
            _cleared_all = {}
            for _who, _tg in _targets:
                _marks = dict(getattr(_tg, "marks", None) or {})
                if not _marks:
                    continue
                if _m_scope == "all":
                    _hit = {str(k): int(n) for k, n in _marks.items()}
                    _tg.marks = {}
                else:   # 「驱散敌方印记」（没有「所有」）⇒ 按**层数最多**的一个（局部规则，见 reason）
                    _k = max(_marks, key=lambda k: int(_marks[k]))
                    _hit = {str(_k): int(_marks[_k])}
                    _marks.pop(_k, None)
                    _tg.marks = _marks
                _cleared_all[_who] = _hit
                applied += 1
            _total = sum(sum(h.values()) for h in _cleared_all.values())
            pending_cleansed_layers = _total
            _bump(state, "marks_cleansed", {
                "side": side, "marks_side": _m_side, "scope": _m_scope,
                "cleared": _cleared_all, "total_layers": _total,
                "picked": ("most_layers" if _m_scope == "one" else "all"),
                "basis": ("没有「所有」⇒ 清层数最多的那一个（本地规则：ENGINE_HYPOTHESIS，"
                          "若日后定为别的选法只改这一处）" if _m_scope == "one"
                          else "描述写「所有」⇒ 全清"),
            }, evidence=(eff.evidence or "",))
        elif eff.kind == "per_cleansed_layer":
            # 「每驱散 1 层，<效果>」的**消费者**：层数来自上一条 `cleanse_marks`
            # （解析层把它们产出成相邻两条 ⇒ 顺序有意义）。**0 层 ⇒ 一次都不触发** ✓
            _n = int(pending_cleansed_layers or 0)
            pending_cleansed_layers = None
            inner = dict(v.get("effect") or {})
            if _n <= 0:
                _bump(state, "per_cleansed_layer_skipped",
                      {"side": side, "layers": 0, "why": "没有驱散到任何一层 ⇒ 不触发（对照实验）"})
            elif inner.get("kind") == "foe_status":
                _name = str(inner.get("status"))
                _each = int(inner.get("layers") or 0)
                _give = _each * _n
                _spec = fx.END_OF_TURN_STATUS.get(_name)
                if _spec is None:
                    _note_unsupported(state, f"状态「{_name}」", "该状态没有回合末结算实现（effects.py 未登记）",
                                      eff.evidence or "")
                else:
                    _local = (getattr(cfg, "status_end_of_turn", None) or {}).get(_name)
                    _tg = foe.field_pet
                    _prev = int((_tg.statuses.get(_name) or {}).get("layers", 0))
                    _total_l = _prev + _give
                    if _local:
                        _cap = int(_local.get("max_layers", _total_l))
                        _total_l = min(_total_l, _cap)
                        _tg.statuses[_name] = {"layers": _total_l,
                                               "turns_left": int(_local.get("duration_turns", 1))}
                    else:
                        _tg.statuses[_name] = {"layers": _total_l}
                    applied += 1
                    _bump(state, "status_added", {"side": "enemy", "status": _name, "layers": _give,
                                                  "layers_total": _total_l,
                                                  "from": "per_cleansed_layer",
                                                  "per_layer": _each, "cleansed_layers": _n},
                          evidence=(_spec.get("term", ""),))
            elif inner.get("kind") == "self_stat":
                _delta = int(inner.get("delta_pct") or 0) * _n
                for _stat in (inner.get("stats") or []):
                    pet.buffs[_stat] = pet.buffs.get(_stat, 0) + _delta
                    applied += 1
                    _bump(state, "buff_self", {"side": side, "stat": _stat, "delta_pct": _delta,
                                               "from": "per_cleansed_layer",
                                               "per_layer": int(inner.get("delta_pct") or 0),
                                               "cleansed_layers": _n})
            elif inner.get("kind") == "heal":
                _pct = int(inner.get("percent") or 0) * _n
                _amount = fx.percent_of_max_hp(pet.max_hp, _pct)
                _healed = min(_amount, pet.max_hp - pet.hp)
                pet.hp += _healed
                applied += 1
                _bump(state, "heal", {"side": side, "healed": _healed, "from": "per_cleansed_layer",
                                      "per_layer": int(inner.get("percent") or 0),
                                      "cleansed_layers": _n})
            else:
                _note_unsupported(state, "「每驱散1层」的跟随效果",
                                  f"认不出这一种跟随效果：{inner!r} ⇒ 不猜、不结算", eff.evidence or "")
        elif eff.kind == "cleanse_buffs_one":
            # task-27 D 形状：「驱散敌方 1 种增益」。**量纲是键名**（buffs），不是层数 ⇒ 复用
            # 既有 `cleanse` 事件并补 `picked`/`basis`（**不许悄悄选** ✗）。
            # 选法（本地规则，ENGINE_HYPOTHESIS）：清**绝对增幅最大**的那一个 ——
            # 原始资料只写「驱散 1 种增益」，没写选哪一种；**若日后定为别的选法 ⇒ 只改这一处** ✓
            _pol = str(v.get("polarity") or "增益")
            _want_positive = (_pol == "增益")
            _b = dict(getattr(foe.field_pet, "buffs", None) or {})
            _cands = [(k, int(n or 0)) for k, n in _b.items()
                      if int(n or 0) != 0 and (int(n or 0) > 0) == _want_positive]
            if _cands:
                _pick = max(_cands, key=lambda kv: abs(kv[1]))
                _b.pop(_pick[0], None)
                foe.field_pet.buffs = _b
                applied += 1
                _bump(state, "cleanse", {"side": side, "what": _pol, "cleared": [_pick[0]],
                                         "picked": _pick[0], "picked_delta": _pick[1],
                                         "basis": "清绝对增幅最大的那一个（本地规则：ENGINE_HYPOTHESIS；"
                                                  "原始资料只写「1 种」，没写选哪一种 ⇒ 若日后定别的选法只改这一处）",
                                         "from": "cleanse_buffs_one"})
            else:
                # 对照：没有任何可驱散的（增益|减益）⇒ **Δ=0** 且如实说"什么都没发生"
                _bump(state, "cleanse", {"side": side, "what": _pol, "cleared": [],
                                         "picked": None, "basis": "对手身上没有这一极性的增益/减益",
                                         "from": "cleanse_buffs_one"})
        elif eff.kind == "cleanse_buffs_layers":
            # RC-401 批次十八（2026-09-30 **E 族缺口一**：322 消毒法「驱散敌方5层增益」）。
            # **量纲是层数** —— 与上面 `cleanse_buffs_one` 的「N 种」**分开** ✗（那一个量的是**键名**）。
            # ⚠ 原始资料**没有定义「一层」是多少**（`buffs` 是 `{键名: 百分比}`，没有层数字段）⇒
            #   **本地规则（ENGINE_HYPOTHESIS）**：**一个非零键 = 一层**，按 `abs(百分比)` 从大到小
            #   依次清除，最多清 `layers` 层。事件带 `basis` **如实标注、与原始资料区分** ✓
            #   ⇒ **若日后定为别的定义 ⇒ 只改这一处** ✓
            _pol = str(v.get("polarity") or "增益")
            _want_positive = (_pol == "增益")
            _want_layers = int(v.get("layers") or 0)
            _b = dict(getattr(foe.field_pet, "buffs", None) or {})
            _cands = sorted(((k, int(n or 0)) for k, n in _b.items()
                             if int(n or 0) != 0 and (int(n or 0) > 0) == _want_positive),
                            key=lambda kv: -abs(kv[1]))
            _taken = _cands[:_want_layers] if _want_layers > 0 else []
            if _taken:
                for _k, _n in _taken:
                    _b.pop(_k, None)
                foe.field_pet.buffs = _b
                applied += 1
                _bump(state, "cleanse", {"side": side, "what": _pol,
                                         "cleared": [_k for _k, _n in _taken],
                                         "layers_requested": _want_layers,
                                         "layers_cleared": len(_taken),
                                         "picked_deltas": [_n for _k, _n in _taken],
                                         "basis": "一层 = 一个非零增益键，按 abs(百分比) 从大到小最多清 N 层"
                                                  "（本地规则：ENGINE_HYPOTHESIS；原始资料只写「N 层」，"
                                                  "没定义一层是多少 ⇒ 若日后定别的定义只改这一处）",
                                         "from": "cleanse_buffs_layers"})
            else:
                # 对照（Δ=0）：没有任何可驱散的增益层 ⇒ **一个键都不动**、如实说"什么都没发生" ✓
                _bump(state, "cleanse", {"side": side, "what": _pol, "cleared": [],
                                         "layers_requested": _want_layers, "layers_cleared": 0,
                                         "picked_deltas": [],
                                         "basis": "对手身上没有这一极性的增益/减益层",
                                         "from": "cleanse_buffs_layers"})
        elif eff.kind == "cleanse_self_debuffs":
            # task-27 C 形状：清**自己**身上值为负的 buffs（减益）。量纲是**键名**，不是层数
            # （所以复用既有的 `cleanse` 事件 —— 它已经有中文说法、也已登记）。
            _b = dict(getattr(pet, "buffs", None) or {})
            _hit = sorted(k for k, n in _b.items() if int(n or 0) < 0)
            for _k in _hit:
                _b.pop(_k, None)
            pet.buffs = _b
            applied += 1
            _bump(state, "cleanse", {"side": side, "what": "减益", "cleared": _hit,
                                     "target": "self", "from": "cleanse_self_debuffs"})
        elif eff.kind == "heal":
            pct = int(v["percent"])
            amount = fx.percent_of_max_hp(pet.max_hp, pct)
            healed = min(amount, pet.max_hp - pet.hp)
            pet.hp += healed
            applied += 1
            _bump(state, "heal", {"side": side, "healed": healed})
        elif eff.kind == "element_power_ramp":
            # ── task-28（2026-09-30 · D 族 `462 放晴`）：**系别级持久威力修正** ──────────────
            # 写点就是这一处：`PetState.element_power_mods[系别] += N` ✓
            # 读点**已就绪**（`effects.compute_damage` 按 `skill.element` 取 ✓ —— 本批只补写入方 ✓）。
            # ⚠ 系别名从**解析结果**取（描述里读到的全名，如「光系」）⇒ 与读点 key 同一口径 ✓
            # ⚠ 事件里带 `delta` 与 `total` 两个量 —— 判据要能**按事件逐条数**
            #   （"应对成功时只该有一条 delta=100 的事件、**不许有 delta=50 的**" ✓
            #    只断言最终值会被"先 +50 再覆盖"骗过 ✗）
            _elem = str(v.get("element") or "")
            _delta = int(v.get("delta") or 0)
            _mods = dict(getattr(pet, "element_power_mods", None) or {})
            _before = int(_mods.get(_elem, 0) or 0)
            _mods[_elem] = _before + _delta
            pet.element_power_mods = _mods
            applied += 1
            _bump(state, "element_power_ramp", {
                "side": side, "skill_id": skill.skill_id,
                "element": _elem, "delta": _delta, "total": _before + _delta,
                "cap_override": v.get("cap_override", ""),
            }, evidence=(skill.skill_id,))
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
        elif eff.kind == "foe_energy_loss":
            # 「敌方失去 N 能量」= **扣掉就没了**（不是偷取：没有任何一方获得）。
            # 依据：描述字面（术语表里没有单独的条目）；下限 0 由 `min` 保证，不出现负能量。
            amount = int(v["amount"])
            taken = min(amount, foe.field_pet.energy)
            foe.field_pet.energy -= taken
            applied += 1
            _bump(state, "foe_energy_loss", {"side": side, "lost": taken},
                  evidence=(eff.term or "",))
        elif eff.kind == "foe_team_energy_loss":
            # 「敌方队伍中所有精灵失去 N 能量」：**全队**（不只场上那只）。
            # 假设（本条是引擎假设，不是数据给的）：力竭的队员也照扣 —— 描述写的是"所有精灵"，
            # 而引擎对力竭个体仍保留 energy 字段；这一条需要实机/官方文字确认（MC 待立）。
            amount = int(v["amount"])
            lost: List[Dict[str, Any]] = []
            for mate in foe.pets:
                taken = min(amount, int(mate.energy))
                if taken:
                    mate.energy -= taken
                lost.append({"pet_id": mate.pet_id, "lost": taken})
            applied += 1
            _bump(state, "foe_team_energy_loss",
                  {"side": side, "lost": lost, "amount": amount}, evidence=(eff.term or "",))
            _note_unsupported(
                state, f"技能「{skill.name}」的全队扣能",
                "「敌方队伍中所有精灵」是否包含力竭个体没有一手证据（本引擎按「所有」照扣）—— MC 待立",
                skill.skill_id,
            )
        elif eff.kind == "escape":
            # 术语 3003/3024：离场并换人。本引擎需要调用方决定换谁，所以登记为待处理。
            _note_unsupported(state, f"技能「{skill.name}」的离场效果",
                              "离场需要选择换上谁，属补位流程；引擎未自动代选", "3009")
        elif eff.kind == "weather":
            # 2026-09-25：天气层由**配置声明**才存在。没声明 ⇒ 照旧登记为 unsupported
            # （旧消息「引擎尚未实现天气层」改成「这份配置没声明天气层」，
            #  因为现在不是引擎没有这个能力，而是这一局没有这条规则）。
            if apply_weather_effect(state, rs, side, skill, v, cfg):
                applied += 1
    return applied


def _register_parsed_effects(state: GameState, rs: Ruleset, side: str, skill,
                             parsed, *, applied: bool, reason: str,
                             cfg: Optional[RuleConfig] = None) -> None:
    """攻击 / 防御分支的**登记**入口。

    这两个分支以前直接 `return`，描述里被解析出来却没被执行的效果连一条记录都没有。
    本函数把它们逐条登记进 `state.unsupported`，并附上**为什么没结算**。
    没有解析结果、也没有未认领机制词时它什么都不做（纯伤害技能不受影响）。

    `applied=True` 表示这批效果**刚刚被 `_apply_effect_batch` 处理过**：
    那时只登记「批量处理不了的那些」（离场 / 天气 / 未登记的状态），
    已经生效的不再重复登记。`applied=False` 表示一条都没结算（应对失败 / 攻击分支
    没吃下的部分），此时逐条登记。
    """
    # ⚠ 传 `parsed`：调用方可能已经把**声明了的能力**（先手条件 / 选择）补成效果了，
    # 重新 `parse_skill` 会把那份认领丢掉，于是已结算的机制**又被登记成未认领**。
    unclaimed = parse.unclaimed_mechanic_spans(skill, parsed=parsed)
    handled_kinds = {
        "self_stat", "foe_stat", "self_stat_flat", "foe_stat_flat",
        "self_mark", "foe_mark", "cleanse", "heal",
        "self_energy", "drain_energy",
        # 2026-09-25（RC-401 批次六）：两条"敌方失去能量"也在 `_apply_effect_batch` 里结算了，
        # 漏登记会让它们**每次都被写成 unsupported**（判据 test_energy_loss_effects 会红）。
        "foe_energy_loss", "foe_team_energy_loss",
        # 2026-09-25（RC-401 批次八）：「若先于敌方攻击」的威力加成在伤害路径里真的加了，
        # 漏登记会让它每次都被写成 unsupported。
        "initiative_power",
        # 2026-09-25（RC-401 批次九）：动态能耗修正在 `effective_skill_cost` 里真的算了。
        "per_layer_cost",
        # 2026-09-29（task-20 批四）：读敌方层数改**本手**威力/连击，在伤害路径里真的加了。
        "per_layer_boost",
        # 2026-09-25（RC-401 批次十一）：条件威力加成在伤害路径里真的加了（不是"未实现"）。
        "foe_switch_power_flat", "foe_switch_power_mult",
        # 2026-09-25（RC-401 批次十二）：「每次使用后永久±N」在出手后真的累加了。
        "per_use_ramp",
        # 2026-09-25（RC-401 批次十三）：挨打累加在 `_accumulate_on_hit_ramps` 里真的做了。
        "on_hit_ramp",
        # 2026-09-29（task-18 A 批）：这两条是**认领标记**，不是新机制 ——
        # `hit_count` 由 `hit_count` 变量与 `damage` 事件的 `hits` 用掉，
        # `respond_power_mult` 由 `effects.compute_damage` 的应对分支用掉（power×mult）。
        # 漏登记会让它们每次都被写成 unsupported（判据 test_parse_claims 会红）。
        "hit_count",
        # task-27：印记驱散 + 「每驱散 1 层」消费者（都在本文件新的 `cleanse_marks` 支里结算）
        "cleanse_marks", "per_cleansed_layer", "cleanse_self_debuffs", "cleanse_buffs_one",
    }
    for eff in parsed.effects:
        if applied and eff.kind in handled_kinds:
            continue
        if applied and eff.kind == "foe_status" and fx.END_OF_TURN_STATUS.get(str(eff.value["status"])):
            continue
        label = {
            "self_stat": "自己属性增减", "foe_stat": "敌方属性增减",
            "self_stat_flat": "自己属性平值增减", "foe_stat_flat": "敌方属性平值增减",
            "self_mark": "自己印记", "foe_mark": "敌方印记",
            "foe_status": "敌方持续状态", "cleanse": "驱散",
            "heal": "回复生命", "self_energy": "自带回能",
            "drain_energy": "偷取能量", "foe_energy_loss": "敌方失去能量",
            "foe_team_energy_loss": "敌方全队失去能量", "escape": "离场", "weather": "天气",
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



def _initiative_condition_holds(state: GameState, rs: Ruleset, side: str):
    """「若先于敌方攻击」这次成立吗？返回 `(成立, 不成立的原因)`。

    口径（配置里登记为 `ENGINE_HYPOTHESIS`，见 `damage.initiative_condition` 的 reason）：
      · **我这一手排在敌方那一手之前**：读 `order_actions()` 排出的执行序列
        （`state._order_index`，只用于结算、不进观察）；
      · **敌方那一手是攻击**：描述写的是「先于敌方**攻击**」，所以敌方换人 / 聚能 /
        道具时**不加成**；敌方动作拿不到时也不加成（不猜）。
    """
    other = "enemy" if side == "player" else "player"
    index = getattr(state, "_order_index", None)
    if not index:
        return False, "没有本回合的执行序列（不在联合结算里）"
    if index.get(side, 99) > index.get(other, -1):
        return False, "敌方那一手排在前面"
    action = _opponent_action_of(state, side)
    if action is None:
        return False, "拿不到敌方这一手的动作"
    if action.kind != ACTION_SKILL:
        return False, f"敌方这一手不是攻击（{action.kind}）"
    opp_skill = rs.skills.get(action.skill_id or "")
    if opp_skill is None or not getattr(opp_skill, "is_attack", False):
        return False, "敌方这一手不是攻击技能"
    return True, ""


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


# ── PVP 魔法（愿力强化）────────────────────────────────────────────────────
#
# 依据：台账 EV-PVP-WISH-POWER-UP（RECORDED_IN_GAME，人类口述）+ 派生产物
# `data/roco/derived/pvp-magic.json`（生成器：scripts/roco/build-pvp-magic.mjs）。
# 人类口径原文（要点）：占一次行动；每局两次；冷却三回合；目标是自己场上那只；
# 把它的**最上面（第一个）技能**换成「愿力冲击」；再用一次「愿力强化」解除这次转换
# （**不消耗次数**、自动进入冷却）；愿力冲击的属性 = 该精灵的**愿力属性**（默认第一个属性）、
# 能耗 2、威力 80、物攻/魔攻取该精灵更高的那一项、对「应对状态」额外 150% 伤害。
#
# 本引擎**不**发明上面没写的部分（改名道具的消耗、冷却与换人的交互、换场后是否还原）：
# 那些留在 `magic_policy.unknowns` 里，代码遇到就按「不知道」处理。

def pvp_magic_of(rs: Ruleset) -> Optional[Dict[str, Any]]:
    """这一份规则集的 PVP 魔法声明（没有这份派生产物就返回 None）。"""
    doc = rs.pvp_magic or {}
    magic = doc.get("magic")
    return magic if isinstance(magic, dict) else None


def wish_impact_skill_id(rs: Ruleset, pet: PetState) -> Optional[str]:
    """这只精灵该换成哪一条「愿力冲击」。

    属性 = 它的**愿力属性**（人类：默认取第一个属性；改成任意属性的道具属于未核验，本实现
    只走默认那条）；类别 = 物攻 / 魔攻里**更高**的那一项（人类口径）。
    **拿不到就返回 None** —— 调用方 fail closed，不许猜一个属性或一个类别。
    """
    magic = pvp_magic_of(rs)
    if magic is None:
        return None
    pet_row = rs.pets.get(pet.pet_id)
    if pet_row is None or not pet_row.types:
        return None
    element = pet_row.types[0]
    stats = pet_row.stats or {}
    atk = stats.get("atk")
    spa = stats.get("spa")
    if not isinstance(atk, int) or not isinstance(spa, int):
        return None                      # 攻/魔攻缺一就不猜：类别是按这两个数比的
    damage_class = "物攻" if atk >= spa else "魔攻"
    sid = f"magic_wish_impact__{element}__{damage_class}"
    return sid if sid in rs.skills else None


def _init_pvp_magic(side: "SideState", rs: Ruleset, cfg: RuleConfig) -> None:
    """按配置声明初始化这一方的魔法状态（没声明就保持 None）。"""
    if not cfg.allowed_kinds or ACTION_MAGIC not in cfg.allowed_kinds:
        return
    magic = pvp_magic_of(rs)
    if magic is None:
        raise fx.UnsupportedEffect(
            "PVP 魔法(愿力强化)",
            f"规则配置 {cfg.ruleset_config_id} 声明了 magic 这一类，但规则集里没有 PVP 魔法产物"
            "（data/roco/derived/pvp-magic.json 缺失或 ruleset_id 对不上）—— 不许凭空造一个",
        )
    uses = magic.get("per_battle_uses")
    if not isinstance(uses, int) or uses <= 0:
        raise fx.UnsupportedEffect(
            "PVP 魔法(每局次数)",
            "愿力强化的 per_battle_uses 不是正整数 —— 次数未核验时不许回落到任意值",
        )
    side.magic = {"uses_left": int(uses), "cooldown": 0, "swapped": {}, "cooldown_set_turn": None}


#: 能耗修正的作用域 → 哪些技能算「命中」。术语 1012/1013 只说「技能能耗增加/降低」，
#: 没有分档；这三个作用域是**本引擎的词汇表**（特性文本里出现的「全技能 / 攻击技能 / 防御技能」
#: 各有对应），字面量与 trait spec 里的写法一一对应。
ENERGY_COST_SCOPES = ("all", "attack", "defense", "status")


def _cost_mod_applies(mod: Dict[str, Any], skill) -> bool:
    scope = str(mod.get("scope") or "all")
    if scope == "all":
        return True
    if scope == "attack":
        return bool(skill.is_attack)
    if scope == "defense":
        return bool(skill.is_defense)
    if scope == "status":
        return not skill.is_attack and not skill.is_defense
    return False


def _global_cost_delta(pet, cfg: Optional[RuleConfig]) -> int:
    """`721` 的**全技能能耗永久-N**（task-28）—— 读 `PetState.global_skill_mods["cost_delta"]` ✓。

    ⚠ **唯一读点** ✓（`effective_skill_cost` ✓ —— 而它是 `resolved_skill_cost`（`:834`）的唯一实现 ✓
      ⇒ ⇒ `:427`/`:869`/`:1228` **三个调用点自动一致** ✓：**预览与真出手读的是同一个数** ✓）。
    ⚠ **下界口径**（Lead 2026-09-30 裁决 ✓）：**能减多少减多少、但不为负** ⇒ 由调用方 `max(0, …)` ✓
      ⇒ **不改 MC-018 的既有守卫** ✗（那条守卫是别人立的、明确写了"不猜一个 0" ✓）。
      ⇒ ⚠ **产品后果如实登记**（不藏在 `max(0,…)` 里 ✓）：全库 **140 条能耗 ≤1 的技能**（**427 内 104 条**）
        在本叶子声明后会变成 **cost 0** ✓ —— "全技能-2"照字面的必然结果 ✓ 不是 bug ✓。
    """
    if not bool(getattr(cfg, "damage_global_skill_mods", False)):
        return 0
    return int((getattr(pet, "global_skill_mods", None) or {}).get("cost_delta", 0) or 0)


def _slot_extra_reduction(state: GameState, side: str, skill,
                          cfg: Optional[RuleConfig] = None) -> int:
    """号位条件带来的**额外减伤百分点**（第五种形状）。未声明号位能力 ⇒ 恒 0 ⇒ legacy 逐字不变 ✓。

    ⚠ **复合口径：原始资料与代码均未定义**（`pet._defense_reduction` 是**单值** ✗）⇒
    **本地取加法** ✓（人类授权「缺参数在本地规则显式定义并与原始资料区分」✓）。
    """
    # ⚠ **#49**：**不许在链路中间无参自取配置**（那会拿到**默认配置（非 v3）**⇒ 表现为**恒 0** ✗）。
    #   照仓库约定（`_execute`/`effective_skill_cost` 等 20+ 处逐字同形 ✓）：**由调用方传 cfg，缺省才回落** ✓。
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_slot_condition", False)):
        return 0
    pos = _slot_of(state, side, skill)
    if not pos:
        return 0
    try:
        p = parse.resolve_position_mechanics(skill, slot_declared=True, shift_declared=False)
    except Exception:
        return 0
    return sum(int(c.get("reduction_pct") or 0) for c in (getattr(p, "slot_conditions", ()) or ())
               if pos in (c.get("slots") or []))


def _slot_of(state: GameState, side: str, skill) -> int:
    """这个技能在这一方配招里的**号位**（1 起；查不到 0）。照 `loadouts.get(pet_id)` + `index()` 既有读法 ✓。"""
    try:
        ss = getattr(state, side)
        return list(ss.loadouts.get(ss.field_pet.pet_id) or ()).index(skill.skill_id) + 1
    except Exception:
        return 0


def _slot_cost_delta(state: GameState, side: str, skill, cfg) -> int:
    """号位条件带来的**能耗修正**（第四种形状）。未声明号位能力 ⇒ 恒 0 ⇒ legacy 逐字不变 ✓。"""
    if not bool(getattr(cfg, "damage_slot_condition", False)):
        return 0
    pos = _slot_of(state, side, skill)
    if not pos:
        return 0
    try:
        p = parse.resolve_position_mechanics(skill, slot_declared=True, shift_declared=False)
    except Exception:
        return 0
    return sum(int(c.get("cost_delta") or 0) for c in (getattr(p, "slot_conditions", ()) or ())
               if pos in (c.get("slots") or []))


def _own_debuff_layers(state: GameState, side: str) -> int:
    """**自己**身上值为负的 buff **键数**（= 「一层」的定义）。

    与 `cleanse_self_debuffs` 那一支**逐字同一条谓词**（`int(n or 0) < 0`）—— **不许另立第二套定义** ✗。
    """
    try:
        pet = getattr(state, side).field_pet
        return sum(1 for _k, _n in dict(getattr(pet, "buffs", None) or {}).items() if int(_n or 0) < 0)
    except Exception:
        return 0


def effective_skill_cost(pet: PetState, skill, cfg: Optional[RuleConfig] = None,
                         *, weather: Optional[Dict[str, Any]] = None,
                         foe_status_layers: int = 0,
                         own_debuff_layers: int = 0,
                         slot_cost_delta: int = 0) -> int:
    """这一手要付多少能量 = 基础能耗 + 这只精灵身上的能耗修正 + **天气修正**。

    **只在配置声明了对应机制时才算**（legacy / v2 两条都不声明 → 原样返回基础值，
    行为与指纹逐位不变）：
      · `energy.cost_modifier`：特性带来的能耗增减（捉迷藏 / 抓到你了 / 聒噪），
        每条形如 `{"scope": …, "delta": int, "until_turn": int|None, "source": str}`；
      · `policies.weather_policy`（2026-09-25 人类裁决）：**沙暴**让**双方的地系技能**
        能耗减半（术语 3006）。系数与适用系别**从配置读**，引擎不写死。

    「多条修正的复合顺序」「下限」「减半遇奇数的取整」都没有定义：
      · 只做**加法**（加法可交换，顺序问题不在这里假装解决），天气的乘法**最后**作用；
      · **不设下限** —— 结果为负时返回负数，由调用方 fail closed（`legal_actions` 不提供这一手、
        扣费处抛错），而不是编一个「最低 0 能耗」；
        ⚠ **本条（"不设下限"）已被 `:2798-2800`（2026-09-30 Lead 裁决：能减多少减多少、但不为负）取代** ——
        见 task-28（`721`）。**后来者优先**：有日期/署名的那条才是现行裁决；本条只作历史留档，**别照它写** ✗。
      · 「减半」按**向下取整**（奇数值的取整口径未核验，登记在 battle-modes 的 unknowns
        `energy_cost_halving_rounding` 里）。
    """
    cfg = cfg or _rule_config.get_rule_config()
    base = int(skill.energy)
    total = base
    # RC-401 批次九（2026-09-25）：「**敌方每有 N 层中毒效果，本技能能耗 -M**」。
    # 与静态能耗修正分开算：它的修正量**取决于局面**（对手场上那只的中毒层数），
    # 所以只有调用方显式把层数传进来才算 —— 没传（`foe_status_layers=0`）等于条件不成立。
    # 只在配置声明了能力时看这条（legacy / v2 里那段文本照旧是"未认领机制"）。
    # RC-401 批次十二：「每次使用后，本技能能耗永久±N」（只对本技能生效）。
    if bool(getattr(cfg, "damage_per_use_ramp", False)):
        total += _skill_ramp(pet, skill.skill_id, "cost")
    if bool(getattr(cfg, "energy_per_layer_cost", False)) and int(foe_status_layers) > 0:
        parsed_plc = parse.resolve_per_layer_cost(skill, declared=True)
        eff = next((e for e in parsed_plc.effects if e.kind == "per_layer_cost"), None)
        if eff is not None:
            step = max(1, int(eff.value.get("layer_step") or 1))
            units = int(foe_status_layers) // step
            total += int(eff.value.get("delta") or 0) * units
    # RC-401 批次十八（2026-09-30 E 族缺口二 `446 清洗`）：「**自己**每有 N 层减益，本技能能耗 -M」。
    # 与批次九同形（数层数改费用），但**数自己身上的减益**（状态量 ✓ 算费那刻读得到 ✓）。
    # ⚠ 摆在天气乘法**之前**（`:2792-2799` 是最后一步 ✓）；**夹照 `:2805-2807` 的纪律**：只对 `total >= 0` 夹。
    if bool(getattr(cfg, "damage_per_own_debuff_cost", False)) and int(own_debuff_layers) > 0:
        _parsed_cpod = parse.resolve_cost_per_own_debuff_layer(skill, declared=True)
        _eff_cpod = next((x for x in _parsed_cpod.effects
                          if x.kind == "cost_per_own_debuff_layer"), None)
        if _eff_cpod is not None:
            _step = max(1, int(_eff_cpod.value.get("layer_step") or 1))
            _units = int(own_debuff_layers) // _step
            if total >= 0:
                total = max(0, total + int(_eff_cpod.value.get("delta") or 0) * _units)
    # RC-401 批次十八（2026-09-30 F 族第四种形状）：**号位条件带来的能耗修正**。
    # 由调用方就地算好按名传（照 `own_debuff_layers` 同形 ✓）；**不塞进 `energy_cost_mods`** ✗
    # （那条是精灵级 + 有 `until_turn` 到期语义；号位条件是每手重算的静态条件）。夹照既有纪律：只对 `total >= 0` 夹 ✓。
    if int(slot_cost_delta) and total >= 0:
        total = max(0, total + int(slot_cost_delta))
    if bool(getattr(cfg, "energy_cost_modifier", False)):
        for mod in pet.energy_cost_mods or ():
            if isinstance(mod, dict) and _cost_mod_applies(mod, skill):
                total += int(mod.get("delta") or 0)
    if isinstance(weather, dict):
        name = str(weather.get("name") or "")
        read_effect = getattr(cfg, "weather_effect", None)
        spec = read_effect(name) if callable(read_effect) else None
        if isinstance(spec, dict) and spec.get("kind") == "skill_energy_cost_multiplier" \
                and str(spec.get("element") or "") == str(getattr(skill, "element", "") or ""):
            factor = float(spec.get("value") or 1.0)
            total = int(math.floor(total * factor))
    # task-28（`721`）：**全技能能耗永久-N 的唯一读点** ✓（本函数是 `resolved_skill_cost` 的唯一实现 ✓
    # ⇒ `:427`/`:869`/`:1228` 自动一致 ⇒ **预览与真出手读同一个数** ✓）
    # ⚠ **下界口径**（Lead 2026-09-30 裁决 ✓）：**能减多少减多少、但不为负** ✓
    #   ⚠ **只对"total ≥ 0"夹** ✗ —— 若 total 已被**别的**修正压成负数 ⇒ **原样交给下面 MC-018 的既有守卫** ✓
    #     （**别人的守卫是约束、不是障碍** ✓ 我不把它变宽 ✓）
    _gd = _global_cost_delta(pet, cfg)
    if _gd and total >= 0:
        total = max(0, total + _gd)
    return total


def _skill_ramp(pet: PetState, skill_id: str, field_name: str) -> int:
    """这只精灵用这个技能累计出来的永久修正量（RC-401 批次十二）。

    数据形状：`PetState.skill_ramps = {skill_id: {"power": int, "cost": int, "hits": int}}`。
    **只在配置声明了 `damage.per_use_ramp` 时才会被写**；没写就是 0（legacy / v2 行为不变）。
    """
    row = (getattr(pet, "skill_ramps", None) or {}).get(skill_id) or {}
    try:
        return int(row.get(field_name) or 0)
    except (TypeError, ValueError):
        return 0


def _accumulate_on_hit_ramps(state: GameState, rs: Ruleset, defender: PetState,
                             defender_side: str, attacker_skill, outcome,
                             cfg: Optional[RuleConfig] = None) -> None:
    """被打之后：把这只精灵身上带「每被攻击1次…永久±N」的技能各累加一次（RC-401 批次十三）。

    口径（配置的 `reason` 里逐条登记）：
      · 只有**技能攻击**算（`attacker_skill` 一定是攻击技能，调用点在攻击分支里）；
      · `requires_resisted` 的那些只在**被抵抗**时算 —— 用本引擎的相性倍率 `< 1` 判；
      · **一次攻击只算一次**（「不含连击」）—— 连击数不参与计数。
    只翻这只精灵**配招里真的带着的**技能（没带在身上的技能不该被强化）。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_on_hit_ramp", False)):
        return
    side_state = getattr(state, defender_side)
    loadout = tuple(side_state.loadouts.get(defender.pet_id) or ())
    if not loadout:
        return
    resisted = float(getattr(outcome, "type_multiplier", 1.0) or 1.0) < 1.0
    for sid in loadout:
        skill = rs.skills.get(sid)
        if skill is None:
            continue
        parsed = parse.resolve_on_hit_ramp(skill, declared=True)
        eff = next((e for e in parsed.effects if e.kind == "on_hit_ramp"), None)
        if eff is None:
            continue
        if bool(eff.value.get("requires_resisted")) and not resisted:
            continue
        field_name = str(eff.value.get("field") or "")
        delta = int(eff.value.get("delta") or 0)
        if field_name not in ("power", "cost", "hits") or not delta:
            continue
        ramps = dict(getattr(defender, "skill_ramps", None) or {})
        row = dict(ramps.get(sid) or {})
        row[field_name] = int(row.get(field_name) or 0) + delta
        ramps[sid] = row
        defender.skill_ramps = ramps
        _bump(state, "on_hit_ramp", {"side": defender_side, "skill_id": sid,
                                     "field": field_name, "delta": delta, "total": row[field_name],
                                     "resisted": resisted})


def _accumulate_triggered_ramp(state: GameState, pet: PetState, skill, parsed, *,
                               trigger: str, happened: bool,
                               cfg: Optional[RuleConfig] = None) -> None:
    """**真的应对成功** / **真的把对手打倒下**之后，把「…本技能<属性>永久±N」累加一次。

    RC-401 批次十七（2026-09-30 task-26 H 族批一）。与 `_accumulate_per_use_ramp` 共用
    **同一套写点**（`PetState.skill_ramps` ⇒ `_skill_ramp` 在出手读威力/连击、
    `effective_skill_cost` 读能耗时自动生效），本函数只负责**判触发器**。

    ⚠ `happened` 是**调用方观测到的事实**，不是"这段代码被执行到了"：
      · `trigger="respond_success"` ⇒ 只有 `pet._respond_succeeded` 为真才算（`_execute` 里设的，
        判据是 `fx.respond_to(skill) == 对手那一手的类别`）；
      · `trigger="defeat_foe"`      ⇒ 只有这一手**真的把对手打到 0 血**（`defender.hp <= 0` 那一支）才算。
    **这一层是刻意的**：第一版把 `trigger=` 直接当事实用（调用方无条件传 `"respond_success"`），
    实测**对手出攻击招、`_respond_succeeded=False` 也照样累加**（`skill_000422` 对照实验当场抓到 ✗）——
    那正是"把没发生的说成发生了"。现在事实必须**从状态里读出来再传进来** ⇒ 不成立就什么都不做 ✓
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_triggered_ramp", False)):
        return
    if not happened:
        return
    eff = next((e for e in getattr(parsed, "effects", ()) if e.kind == "triggered_ramp"), None)
    if eff is None or str(eff.value.get("trigger") or "") != str(trigger):
        return
    field_name = str(eff.value.get("field") or "")
    delta = int(eff.value.get("delta") or 0)
    if field_name not in ("power", "cost", "hits") or not delta:
        return
    ramps = dict(getattr(pet, "skill_ramps", None) or {})
    row = dict(ramps.get(skill.skill_id) or {})
    row[field_name] = int(row.get(field_name) or 0) + delta
    ramps[skill.skill_id] = row
    pet.skill_ramps = ramps
    _bump(state, "triggered_ramp", {"side": None, "skill_id": skill.skill_id,
                                    "trigger": str(trigger), "field": field_name,
                                    "delta": delta, "total": row[field_name]})


def _accumulate_per_use_ramp(state: GameState, pet: PetState, skill, parsed,
                             cfg: Optional[RuleConfig] = None, *,
                             happened: bool) -> None:
    """一次**成功出手**之后，把「每次使用后永久±N」累加到这只精灵身上。

    只改**这个技能**（不影响同一只精灵的别的技能）；数值来自解析结果，不写死。

    ⚠ `happened` **必传**（task-25 B 族批，2026-09-30 改钉）：它必须是**调用方观测到的事实**
    （「这一手没被 `action_cancelled` 取消」），不是"这段代码被执行到了" ✗ ——
    `_execute` 的第一道守卫（精灵已倒下）会 `_bump(action_cancelled{reason:"fainted"})` 后 return，
    那一手**没有打出去**，不许累加（与 `_accumulate_triggered_ramp` 的 `happened` 同一条纪律）。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_per_use_ramp", False)):
        return
    if not happened:
        return
    eff = next((e for e in getattr(parsed, "effects", ()) if e.kind == "per_use_ramp"), None)
    if eff is None:
        return
    field_name = str(eff.value.get("field") or "")
    delta = int(eff.value.get("delta") or 0)
    if field_name not in ("power", "cost", "hits") or not delta:
        return
    ramps = dict(getattr(pet, "skill_ramps", None) or {})
    row = dict(ramps.get(skill.skill_id) or {})
    row[field_name] = int(row.get(field_name) or 0) + delta
    ramps[skill.skill_id] = row
    pet.skill_ramps = ramps
    _bump(state, "per_use_ramp", {"side": None, "skill_id": skill.skill_id,
                                  "field": field_name, "delta": delta,
                                  "total": row[field_name]})


def _element_ramp_should_fire(prior_uses: int) -> bool:
    """B 族触发一次的判据 —— **口径的唯一改点**（task-25，2026-09-30）。

    `prior_uses` = **这一手之前**，这一只已经用过多少次「命中该系别」的技能。

    当前口径 = **次数**（人类授权「缺参数就在本地规则里显式定义」；生成器
    `damage.element_use_ramp` 的 `reason` 里登记 `ENGINE_HYPOTHESIS`）：
    每匹配一次就加一次 `delta`。

    ⚠ **若日后定为「不同系别个数」**（即 `skill_000450 过曝`「每使用过1个其他系别技能」
    读成"每多一个**没见过的**系别"）⇒ **只改这一个函数**：`return prior_uses == 0` ✓
    （`PetState.skill_use_elems` 本来就按系别分开记账 ⇒ 个数口径读得出来 ✓）。
    """
    return True


def _accumulate_element_use_ramp(state: GameState, rs: Ruleset, pet: PetState, used_skill,
                                 cfg: Optional[RuleConfig] = None, *,
                                 happened: bool) -> None:
    """task-25 B 族：把「**每使用1次其他<本系>技能 / 每使用过1个其他系别技能**，
    本技能<属性>永久±N」按**触发**累加一次。

    语义核心是**「其他」**（三条技能的共同点）⇒ 两处都必须排除本技能自己：
      · 记账时：这一手用的就是**它自己** ⇒ 既不加 `skill_ramps[S]`，也不让它进自己的计数；
      · `scope="same_element"`（270 蓄能轰击 / 343 光能聚集）⇒ 只有**同系**的**别的**技能才算；
      · `scope="other_element"`（450 过曝）⇒ 只有**异系**技能才算（本技能自己是那个系 ⇒ 天然被排除）。

    `happened=False`（这一手被取消）⇒ **既不记账也不累加** ✓（人类口径：不许把没打出去的算成打出去了）。
    读数落在**现成**的 `PetState.skill_ramps`（与 `per_use_ramp`/`on_hit_ramp`/`triggered_ramp` 同一个写点），
    系别计数落在 `PetState.skill_use_elems`（既是审计读数，也是"次数/个数"口径的读点）。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_element_use_ramp", False)):
        return
    if not happened:
        return
    used_elem = str(getattr(used_skill, "element", "") or "")
    if not used_elem:
        return
    # ⚠ **先看这只精灵身上到底有没有 B 族技能**：一条都没有 ⇒ **什么都不写** ✓
    # 为什么（2026-09-30 实测）：记账写在 `PetState` 上 ⇒ 一旦写进去，**序列化摘要就变了** ⇒
    # 全部 28/29 个回归场景的终局指纹都会动（行为没变，但指纹变了）✗。
    # 只有"身上真有 B 族技能"的精灵才需要这份账 ⇒ 其余逐位不变（golden 指纹守住 ✓）。
    loadout_all: Dict[str, list] = {}
    for _side in ("player", "enemy"):
        _s = getattr(state, _side, None)
        for pid, ids in ((getattr(_s, "loadouts", None) or {}).items() if _s else ()):
            loadout_all.setdefault(str(pid), list(ids or ()))
    loadout = loadout_all.get(str(pet.pet_id)) or []
    ramps: List["tuple[str, Dict[str, Any], str]"] = []
    _seen_sids: set = set()
    for sid in loadout:
        sid = str(sid)
        # ⚠ **同一个技能 id 出现两次也只能加一次**（实测：配招里有重复 id 时过去会加两遍 ✗）——
        # 这是"每使用1次 ⇒ 加 1 次 delta"的语义底线，按 id 去重。
        if sid in _seen_sids:
            continue
        _seen_sids.add(sid)
        if sid == str(used_skill.skill_id):
            continue                      # 「其他」⇒ 本技能自己不算 ✗
        other = rs.skills.get(sid)
        if other is None:
            continue
        info = getattr(parse.resolve_element_use_ramp(other, declared=True), "element_ramp", None)
        if info:
            # ⚠ 元素要**跟着这条 ramp 一起存下来**：过去在匹配循环里读的是**上一个循环残留的
            # `other`**（stale loop variable）⇒ 比的是"最后一支技能"的元素 ⇒
            # 用**本系**技能也会触发「其他系别」那条 ✗（实测：用光系的 skill_000448 触发了 450）。
            ramps.append((sid, info, str(getattr(other, "element", "") or "")))
    if not ramps:
        return
    # ① 记账：这一手用掉的**系别**（按系别累计；「其他」的排除在下面的匹配里做）
    uses = {str(k): int(v or 0) for k, v in (getattr(pet, "skill_use_elems", None) or {}).items()}
    prior = int(uses.get(used_elem, 0) or 0)
    uses[used_elem] = prior + 1
    pet.skill_use_elems = uses
    # ② 触发：这一手是不是"别的技能"，让身上某条 B 族技能的永久修正 ±delta
    for sid, info, own_element in ramps:
        scope = str(info.get("scope") or "")
        if scope == "same_element":
            # 同系：这一手用的系别 == 那条写着 的系别（且上面已排除"本技能自己"✓）
            if str(info.get("element") or "") != used_elem:
                continue
        elif scope == "other_element":
            # 异系：这一手用的系别 ≠ **这条 ramp 所属技能**的系别（不是别的技能的元素 ✗）
            if used_elem == own_element:
                continue
        else:
            continue
        field_name = str(info.get("field") or "")
        delta = int(info.get("delta") or 0)
        if field_name not in ("power", "cost", "hits") or not delta:
            continue
        if not _element_ramp_should_fire(prior):
            continue
        ramps = dict(getattr(pet, "skill_ramps", None) or {})
        row = dict(ramps.get(sid) or {})
        row[field_name] = int(row.get(field_name) or 0) + delta
        ramps[sid] = row
        pet.skill_ramps = ramps
        _bump(state, "element_use_ramp", {
            "side": None, "skill_id": sid, "field": field_name, "delta": delta,
            "total": row[field_name], "element": used_elem,
            "by_skill_id": str(used_skill.skill_id), "scope": scope,
            "uses_of_element": int(uses.get(used_elem, 0) or 0),
        })


def _foe_switched_this_turn(state: GameState, side: str) -> bool:
    """对手**这一回合提交的**动作是不是主动换人（RC-401 批次十一的条件）。

    口径：读 `state._pending_*` 里对手那一手（同一个函数 `_opponent_action_of` 也是应对判定用的）。
    换人与补位分开（术语 3009）：补位不是"主动离场"，所以这里只认 `ACTION_SWITCH` 的**主动**换人
    —— 补位那一手在引擎里走 `step_replace`，不经过 `step_joint`，因此不会出现在这里。
    """
    action = _opponent_action_of(state, side)
    return bool(action is not None and action.kind == ACTION_SWITCH)


def _gate_foe_switch_effects(state: GameState, side: str, skill,
                             parsed, cfg: Optional[RuleConfig] = None):
    """把「若敌方本回合更换精灵才生效」的那几条效果**按条件筛一遍**。

    返回 `(parsed, switched)`：
      · 条件成立 ⇒ 原样返回（那几条效果照常结算）；
      · 条件不成立 ⇒ 把它们从 `effects` 里**摘掉**（并在事件里记一条 `foe_switch_condition_skipped`），
        剩下的无条件效果照常结算 —— 这是"条件效果"与本文件里那些"未实现效果"的区别：
        前者条件不满足是**正常局面**，不该进 `state.unsupported`。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_foe_switch_condition", False)):
        return parsed, False
    if not any(isinstance(getattr(e, "value", None), dict)
               and e.value.get("requires") == "foe_switch" for e in parsed.effects):
        return parsed, False
    switched = _foe_switched_this_turn(state, side)
    if switched:
        return parsed, True
    kept = [e for e in parsed.effects
            if not (isinstance(getattr(e, "value", None), dict)
                    and e.value.get("requires") == "foe_switch")]
    _bump(state, "foe_switch_condition_skipped", {
        "side": side, "skill_id": skill.skill_id,
        "dropped": len(parsed.effects) - len(kept),
        "reason": "对手这一回合没有更换精灵",
    })
    return dataclasses.replace(parsed, effects=kept), False


def _gate_self_mark_effects(state: GameState, side: str, skill, parsed, cfg=None):
    """把「**自己有某个标记**才生效」的效果按条件筛一遍（task-28 · `722 反弹`）。

    与 `_gate_foe_switch_effects` **同形**（同一套"条件效果"与"未实现效果"的区分 ✓）：
      · 条件成立（自己那个标记**层数 > 0**）⇒ 原样返回 ✓；
      · 不成立 ⇒ 把它们**摘掉** + 记一条 `self_mark_condition_skipped` ✓（**正常的局面**，
        不该进 `state.unsupported` ✗）—— 剩下的无条件效果照常结算 ✓。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_moe_mark", False)):
        return parsed, False
    cond = [e for e in parsed.effects
            if isinstance(getattr(e, "value", None), dict)
            and e.value.get("requires") == "self_has_mark"]
    if not cond:
        return parsed, False
    me = getattr(state, side)
    pet = me.field_pet
    # 一律**逐个效果**判：不同的标记可以有不同的层数 ✓（今天只有「萌化」一种 ✓）
    kept = []
    dropped = 0
    for e in parsed.effects:
        if (isinstance(getattr(e, "value", None), dict)
                and e.value.get("requires") == "self_has_mark"
                and int((pet.marks or {}).get(str(e.value.get("mark") or ""), 0) or 0) <= 0):
            dropped += 1
            continue
        kept.append(e)
    if not dropped:
        return parsed, True
    _bump(state, "self_mark_condition_skipped", {
        "side": side, "skill_id": skill.skill_id, "dropped": dropped,
        "reason": "自己身上没有这个标记（0 层）",
    })
    return dataclasses.replace(parsed, effects=kept), False


def _gate_self_debuff_effects(state: GameState, side: str, skill, parsed, cfg=None):
    """把「**自己有减益**才生效」的效果按条件筛一遍（task-28 · `724 破罐破摔`）。

    与 `_gate_foe_switch_effects` / `_gate_self_mark_effects` **同形** ✓：
    条件成立 ⇒ 原样 ✓；不成立 ⇒ **摘掉** + 记 `self_debuff_condition_skipped` ✓（**正常局面** ✓ 不进 unsupported ✗）。
    ⚠ **"减益"口径**（Lead 2026-09-30 裁决 ✓）：**只算 `buffs`/`buffs_flat` 的负值** ✓ · **状态层数不算** ✓。
      ⇒ ⚠ **改点**：若人类改判为"含状态层数" ⇒ **只改这一处**（把下面 `any(...)` 扩成也看 `pet.statuses`）✓。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_cond_self_debuff_power", False)):
        return parsed, False
    if not any(isinstance(getattr(e, "value", None), dict)
               and e.value.get("requires") == "self_has_debuff" for e in parsed.effects):
        return parsed, False
    pet = getattr(state, side).field_pet
    has_debuff = any(float(v or 0) < 0 for v in (pet.buffs or {}).values()) or \
        any(float(v or 0) < 0 for v in (pet.buffs_flat or {}).values())
    if has_debuff:
        return parsed, True
    kept = [e for e in parsed.effects
            if not (isinstance(getattr(e, "value", None), dict)
                    and e.value.get("requires") == "self_has_debuff")]
    _bump(state, "self_debuff_condition_skipped", {
        "side": side, "skill_id": skill.skill_id,
        "dropped": len(parsed.effects) - len(kept),
        "reason": "自己身上没有减益（buffs/buffs_flat 里没有负值）",
    })
    return dataclasses.replace(parsed, effects=kept), False


def _poison_layers(state: GameState, side: str) -> int:
    """对手**场上那只**的中毒层数（RC-401 批次九的动态能耗修正要用）。

    口径：只读公开状态里那条 `中毒` 的层数；没有这条状态就是 0。
    「每有 1 层中毒效果」按**当前层数**读（不是历史累计）—— 这条口径写在配置的 `reason` 里。
    """
    foe = getattr(state, "enemy" if side == "player" else "player")
    pet = getattr(foe, "field_pet", None)
    if pet is None:
        return 0
    row = (pet.statuses or {}).get("中毒") or {}
    try:
        return int(row.get("layers") or 0)
    except (TypeError, ValueError):
        return 0


def _foe_layer_count(state: GameState, side: str, source: str) -> int:
    """对手**场上那只**身上某一类「层数」的当前值（RC-401 批次十六，task-20 批四）。

    三种来源，都只读**公开状态**上的当前值（不是历史累计）：
      · `中毒`   —— `statuses["中毒"].layers`（与批次九 `_poison_layers` 同一口径）；
      · `星陨印记` —— `marks["星陨印记"]`（具名印记）；
      · `印记`   —— **所有**印记层数之和（描述写的是泛指的「印记」）。

    读不到就返回 0（"没有层数" ⇒ 加成 0，由调用方如实记 `per_layer_boost_skipped`）。
    """
    foe = getattr(state, "enemy" if side == "player" else "player")
    pet = getattr(foe, "field_pet", None)
    if pet is None:
        return 0
    if source == "中毒":
        row = (pet.statuses or {}).get("中毒") or {}
        try:
            return int(row.get("layers") or 0)
        except (TypeError, ValueError):
            return 0
    marks = pet.marks or {}
    if source == "星陨印记":
        try:
            return int(marks.get("星陨印记", 0) or 0)
        except (TypeError, ValueError):
            return 0
    if source == "印记":
        total = 0
        for value in marks.values():
            try:
                total += int(value or 0)
            except (TypeError, ValueError):
                continue
        return total
    return 0


def _settle_sustain(state: GameState, rs: Ruleset, side: str, dealt: int) -> None:
    """造成伤害之后的**吸血**与**过量回复转化**（RC-401 批四，数据驱动）。

    参数来自特性入场时写进 `PetState.sustain` 的**解析值**（`parse.py` 的
    `self_lifesteal` / `overheal_to_stat`），这里只负责结算，不认字面量：
      · 吸血：回复 `造成伤害 × lifesteal_pct / 100`（向下取整），上限是最大生命；
      · 过量回复转化：**溢出**部分按最大生命的百分比累计，每满 `chunk_pct`（如 5%）
        转化为 `gain_pct`（如 10%）的属性增益，余数**留到下一次**（`carry_pct`）。

    ⚠ 两条**假设**（数据里没有写，如实登记在事件与 `state.unsupported` 里）：
      ① 溢出的**累计口径**：按「多次回复的溢出累加、满 5% 才转化」实现，
         而不是「每次回复各自向下取整」（两种读法在多次小额回复下结果不同）；
      ② 转化出来的属性增益**持续到本局结束**（数据没说持续多久）。
    """
    pet = getattr(state, side).field_pet
    sus = pet.sustain or {}
    if not sus:
        return
    label = "你" if side == "player" else "对手"
    name = rs.pet(pet.pet_id).name if pet.pet_id in rs.pets else pet.pet_id
    pct = int(sus.get("lifesteal_pct") or 0)
    if pct > 0 and dealt > 0:
        want = max(0, dealt * pct // 100)
        room = max(0, pet.max_hp - pet.hp)
        healed = min(want, room)
        overheal = want - healed
        pet.hp += healed
        _bump(state, "lifesteal", {
            "side": side, "percent": pct, "damage": dealt,
            "healed": healed, "overhealed": max(0, overheal),
        }, evidence=("1012",))
        if healed:
            state.log.append(
                f"{label}的{name}吸血回复了 {healed} 点生命。")
        conv = sus.get("overheal") or {}
        chunk = int(conv.get("chunk_pct") or 0)
        gain = int(conv.get("gain_pct") or 0)
        stats = list(conv.get("stats") or ())
        if overheal > 0 and chunk > 0 and gain > 0 and stats and pet.max_hp > 0:
            # 溢出换算成「最大生命的百分比」，余数留在 carry_pct 里（假设①）
            carried = float(conv.get("carry_pct") or 0.0) + (overheal * 100.0 / pet.max_hp)
            chunks = int(carried // chunk)
            conv["carry_pct"] = carried - chunks * chunk
            sus["overheal"] = conv
            pet.sustain = sus
            if chunks:
                for key in stats:
                    pet.buffs[key] = pet.buffs.get(key, 0) + gain * chunks
                _bump(state, "overheal_to_stat", {
                    "side": side, "stat": stats[0], "stats": stats,
                    "gain_pct": gain * chunks, "chunks": chunks,
                    "carry_pct": round(float(conv["carry_pct"]), 4),
                }, evidence=("1012",))
                state.log.append(
                    f"{label}的{name}把过量回复转化成了{'、'.join(stats)} +{gain * chunks}%。")
            _note_unsupported(
                state, "「过量回复转化」的累计口径与持续时间",
                "数据只写「每过量回复 5% 生命转化为 10% 物攻」：溢出的累计方式"
                "（累加满档 vs 每次各自取整）与转化出来的增益持续多久都没有一手证据。"
                "本引擎按**累加满档**、增益**持续到本局结束**处理（ENGINE_HYPOTHESIS）", "1012",
            )


def _tick_energy_cost_mods(state: GameState) -> None:
    """回合末清掉到期的能耗修正（`until_turn` 是本引擎的回合号；None = 一直在）。

    与 `_tick_magic_cooldowns` 同一条纪律：这是**引擎级计数器**，不是
    `turn_order.end_turn.order` 里声明的游戏阶段。
    """
    for side in (state.player, state.enemy):
        for pet in side.pets:
            mods = pet.energy_cost_mods
            if not mods:
                continue
            kept = [m for m in mods
                    if not isinstance(m, dict) or m.get("until_turn") is None
                    or int(m["until_turn"]) >= state.turn]
            if len(kept) != len(mods):
                pet.energy_cost_mods = kept


def _tick_magic_cooldowns(state: GameState) -> None:
    """回合末递减魔法冷却。

    注意：这是**引擎级的计数器**，不是 `turn_order.end_turn.order` 里声明的游戏阶段
    （那份清单被 `require_declared_end_turn_stages` 逐项对过，不许往里塞东西）。

    对齐方式（人类只说「冷却三回合」，没说与回合边界怎么对齐 —— 仍登记在 `unknowns` 里）：
    本实现取「**接下来三个回合不能用**」：设成 3 的那一回合**不**递减
    （否则当回合就被减掉 1，实际只锁两个回合 —— 实测过），之后每过一个回合减 1，
    减到 0 才重新可用。`cooldown_set_turn` 就是为此记的。
    """
    for side in (state.player, state.enemy):
        st = side.magic
        if not isinstance(st, dict):
            continue
        if int(st.get("cooldown") or 0) <= 0:
            continue
        if st.get("cooldown_set_turn") == state.turn:
            continue                      # 设定冷却的那一回合不递减
        st["cooldown"] = int(st["cooldown"]) - 1


def _use_magic(state: GameState, rs: Ruleset, side: str, action: Action,
               cfg: Optional[RuleConfig] = None) -> None:
    """用一次 PVP 魔法。目前只有「愿力强化」这一条（口径见上面那段注释）。

    两条分支：
      · 这一只**已经换过** → 这一下是**解除**：还原第一个技能、**不消耗次数**、开始冷却；
      · 否则 → **转换**：消耗一次、把第一个技能换成对应属性的「愿力冲击」。

    可见性口径（人类：「能看见你使用这个技能，道具应该看不见」）：转换这件事**不**出现在
    对手的观察里 —— 而这是**天然成立**的，因为 `observation_for` 只给对手「场上面板」，
    从不给对手的技能表（`loadouts` 只在 `self` 那一侧）。使用「愿力冲击」本身照常公开。
    """
    cfg = cfg or _rule_config.get_rule_config()
    me = getattr(state, side)
    magic = pvp_magic_of(rs)
    if magic is None:
        raise fx.UnsupportedEffect("PVP 魔法", "这份规则集没有 PVP 魔法产物")
    if action.magic_id != magic.get("magic_id"):
        raise ValueError(f"未知的 PVP 魔法：{action.magic_id!r}")
    if not isinstance(me.magic, dict):
        raise fx.UnsupportedEffect(
            "PVP 魔法",
            f"规则配置 {cfg.ruleset_config_id} 没有声明 magic 这一类 —— 配置之外不许出现这个动作",
        )
    pet = me.field_pet
    swapped = me.magic.setdefault("swapped", {})

    # ① 解除：还原成原来的第一个技能。**不消耗次数**（人类口径），但开始冷却。
    # 冷却里两支都不许用（同 `legal_actions` 的判据）；这里再挡一层，是因为动作也可能
    # 从不走 `legal_actions` 的地方来（手搓动作 / 旧客户端）——两层判据各管一段。
    if int(me.magic.get("cooldown") or 0) > 0:
        raise ValueError(f"愿力强化还在冷却（还剩 {me.magic['cooldown']} 回合）")
    if pet.pet_id in swapped:
        original = swapped.pop(pet.pet_id)
        row = list(me.loadouts.get(pet.pet_id) or ())
        if row:
            row[0] = original
            me.loadouts[pet.pet_id] = tuple(row)
        cooldown = int(magic.get("cooldown_turns") or 0)
        me.magic["cooldown"] = cooldown
        me.magic["cooldown_set_turn"] = state.turn     # 这一回合不递减（见 _tick_magic_cooldowns）
        original_name = rs.skills[original].name if original in rs.skills else original
        state.log.append(f"愿力强化解除：{_pet_name(rs, pet)}的第一个技能还原成「{original_name}」。")
        _bump(state, "magic", {"side": side, "magic": action.magic_id, "mode": "restore",
                               "pet": pet.pet_id, "pet_name": _pet_name(rs, pet),
                               "restored": original,
                               "restored_name": original_name, "cooldown": cooldown})
        return

    # ② 转换：要次数、要不在冷却里。
    if int(me.magic.get("uses_left") or 0) <= 0:
        raise ValueError("愿力强化这一局的次数已经用完了")
    if int(me.magic.get("cooldown") or 0) > 0:
        raise ValueError(f"愿力强化还在冷却（还剩 {me.magic['cooldown']} 回合）")
    sid = wish_impact_skill_id(rs, pet)
    if sid is None:
        raise fx.UnsupportedEffect(
            "愿力冲击",
            f"拿不到 {_pet_name(rs, pet)} 的愿力属性 / 攻与魔攻，或该变体不在技能表里 ——"
            "属性与伤害类别都必须有出处，不许猜",
        )
    row = list(me.loadouts.get(pet.pet_id) or ())
    if not row:
        raise ValueError("这只精灵没有配招，无法替换第一个技能")
    swapped[pet.pet_id] = row[0]
    row[0] = sid
    me.loadouts[pet.pet_id] = tuple(row)
    me.magic["uses_left"] = int(me.magic["uses_left"]) - 1
    # 2026-09-23（人类实测报的真 bug）：「用了愿力强化没进冷却」—— 转换这一支原来只扣了次数，
    # **没有设冷却**，于是下一回合它立刻又能用（两次次数可以连着用两个回合），
    # 与人类口径「每局两次、冷却三回合」直接冲突。设冷却的口径与「解除」那一支完全一致：
    # `cooldown_turns` 个回合，且设冷却的当回合不递减（见 `_tick_magic_cooldowns`）。
    cooldown = int(magic.get("cooldown_turns") or 0)
    me.magic["cooldown"] = cooldown
    me.magic["cooldown_set_turn"] = state.turn
    state.log.append(
        f"愿力强化：{_pet_name(rs, pet)}的第一个技能换成了「{rs.skills[sid].name}」"
        f"（本局还能用 {me.magic['uses_left']} 次；冷却 {cooldown} 回合）。"
    )
    _bump(state, "magic", {"side": side, "magic": action.magic_id, "mode": "transform",
                           "pet": pet.pet_id, "pet_name": _pet_name(rs, pet),
                           "skill": sid, "skill_name": rs.skills[sid].name,
                           "uses_left": me.magic["uses_left"], "cooldown": cooldown})


def _restore_if_wish_impact(state: GameState, rs: Ruleset, side: str,
                            used_skill: Any = None) -> bool:
    """这一手如果是「愿力冲击」，用完就把第一个技能**还回去**（人类 2026-09-24 口径）。

    返回是否真的还原了。四条边界：
      · **必须真的是这一手打出的愿力冲击**（`used_skill.skill_id == 换上的那个 id`）——
        否则「用任何一招攻击技能都会把愿力冲击静默收回」：实测（2026-09-24 真机复现）
        用第一格以外的攻击技能（例：翅刃 `skill_000650`）打出去时，事件里多出一条
        `magic/restore/reason=consumed`，而这一手的 `damage.skill_id` 是 `skill_000650`
        —— 愿力冲击被**凭空吃掉**（次数白扣、冷却照走）。docstring 一直写着「这一手如果是
        愿力冲击」，实现漏了这条比较。
      · 只还原**被替换过的**那一只（`swapped[pet_id]` 里有原始技能）；
      · 还原**不消耗次数、不改冷却**（愿力强化在使用时已经扣过）；
      · 事件写成 `kind=magic, mode=restore, reason=consumed`，页面据此把技能格改回来。
    """
    me = getattr(state, side)
    st = me.magic
    if not isinstance(st, dict):
        return False
    pet = me.field_pet
    swapped = st.get("swapped") or {}
    original = swapped.get(pet.pet_id)
    if not original:
        return False
    row = list(me.loadouts.get(pet.pet_id) or ())
    if not row:
        return False
    wish = wish_impact_skill_id(rs, pet)
    if wish is None or row[0] != wish:
        return False
    # ⚠ 这一条是 BUG-1 的修复点：**这一手打出的必须是愿力冲击本人**。
    # 借用「愿力冲击」的那一只可能同时带着别的攻击技能，那些技能打出去**不该**触发还原。
    used_id = getattr(used_skill, "skill_id", None)
    if not used_id or used_id != wish:
        return False
    swapped.pop(pet.pet_id, None)
    row[0] = original
    me.loadouts[pet.pet_id] = tuple(row)
    original_name = rs.skills[original].name if original in rs.skills else original
    state.log.append(
        f"愿力冲击用掉了：{_pet_name(rs, pet)}的第一个技能还原成「{original_name}」。"
    )
    _bump(state, "magic", {"side": side, "magic": "wish_power_up", "mode": "restore",
                           "reason": "consumed", "pet": pet.pet_id,
                           "pet_name": _pet_name(rs, pet), "restored": original,
                           "restored_name": original_name})
    return True


def _pet_name(rs: Ruleset, pet: PetState) -> str:
    row = rs.pets.get(pet.pet_id)
    return row.name if row is not None else pet.pet_id


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


# ── 天气（2026-09-25 人类裁决「那你就做！」）──────────────────────────────
#
# 官方一手（腾讯新闻·官方号《洛个明白》闪耀大赛入门篇 2026-04-14）逐字：
#   「天气是常驻在全场的效果，让对战双方都能获得相应的加成，但天气只能存在一种。」
#   「场上的天气效果还将受到回合数的限制…对局战报查看当前天气的剩余回合数！」
#
# 三条纪律：
#   ① **效果与数值全部从规则配置读**（`policies.weather_policy`，生成器从 battle-modes.json
#      照抄；数值口径是当前规则集 S4 术语表 3006/3007/3008/3021）。引擎里**没有**任何
#      写死的天气数值 —— 「雨天 +75%」这类数字只出现在数据/配置里。
#   ② **规则集没声明天气层时，引擎不发明任何天气行为**：技能里的「将天气改为…」照旧
#      登记成 unsupported，回合末也不结算（legacy / v2 的结算与 golden 指纹逐位不变）。
#   ③ 回合数是**技能的属性**（描述里的「持续N回合」）：读不到就不接受这一手，
#      不拿配置里的默认值去顶技能描述。
#
# 天气**不是** `turn_order.end_turn.order` 里声明的逐宠阶段：那个清单的语义是
# 「每一只在场精灵内部」的结算顺序（见 `_end_of_turn`），而天气是场地级、双方一起结算。
# 顺序（声明阶段之后、回合数递减之前）没有一手证据，登记在 battle-modes 的 unknowns 里。


def _weather_effect_of(cfg: RuleConfig, name: str) -> Optional[Dict[str, Any]]:
    """配置里声明的某种天气的结算口径；没声明/没开天气层 ⇒ `None`（调用方 fail closed）。"""
    read_effect = getattr(cfg, "weather_effect", None)
    return read_effect(name) if callable(read_effect) else None


def _pet_types(rs: Ruleset, pet: PetState) -> Tuple[str, ...]:
    species = rs.pets.get(pet.pet_id)
    return tuple(species.types) if species is not None else ()


def _pet_display_name(rs: Ruleset, pet: PetState) -> str:
    species = rs.pets.get(pet.pet_id)
    return species.name if species is not None else pet.pet_id


def set_weather(state: GameState, rs: Ruleset, name: str, turns: Optional[int], *,
                side: str, skill_id: str, cfg: Optional[RuleConfig] = None) -> bool:
    """把天气改成 `name`，剩余 `turns` 回合。返回「是否真的设上了」。

    官方逐字「但天气只能存在一种」⇒ **替换**，不叠加（旧天气的信息进事件，不留在状态上）。
    三种情形一律**不设天气**、只登记（fail closed，绝不发明天气行为）：
      · 配置没声明天气层；
      · 配置声明了天气层，但没声明这一种天气的结算口径；
      · 技能描述里读不到「持续N回合」（回合数是技能属性，不拿配置默认值顶）。
    """
    cfg = cfg or _rule_config.get_rule_config(state.ruleset_config_id or None)
    if not cfg.weather_enabled:
        _note_unsupported(
            state, f"天气「{name}」",
            f"规则配置 {cfg.ruleset_config_id} 没有声明天气层（policies.weather_policy）——"
            "引擎不发明天气行为（fail closed）", skill_id)
        return False
    spec = _weather_effect_of(cfg, name)
    if spec is None:
        _note_unsupported(
            state, f"天气「{name}」",
            f"规则配置 {cfg.ruleset_config_id} 声明了天气层，但没有声明「{name}」这一种的结算口径 ——"
            "不套用别的天气、也不猜一个默认效果", skill_id)
        return False
    if not isinstance(turns, int) or isinstance(turns, bool) or turns <= 0:
        _note_unsupported(
            state, f"天气「{name}」的持续回合数",
            "技能描述里读不到「持续N回合」—— 回合数是**技能的属性**，不拿配置里的默认值顶；"
            "这一手因此不改变天气", skill_id)
        return False
    previous = str((state.weather or {}).get("name") or "")
    state.weather = {
        "name": name,
        "turns_left": int(turns),
        "duration_turns": int(turns),
        "set_turn": int(state.turn),
        "set_by": side,
        "source_skill_id": skill_id,
        "term_id": spec.get("term_id"),
    }
    label = "你" if side == "player" else "对手"
    state.log.append(f"{label}把天气改成了{name}（持续 {turns} 回合）。"
                     + (f"（{previous}结束）" if previous and previous != name else ""))
    _bump(state, "weather_set", {
        "side": side, "weather": name, "turns_left": int(turns),
        "replaced": previous or None,
    }, evidence=(str(spec.get("term_id") or ""),))
    return True


def apply_weather_effect(state: GameState, rs: Ruleset, side: str, skill,
                         value: Dict[str, Any], cfg: RuleConfig) -> bool:
    """把技能描述里的「将天气改为X」应用到场上。返回是否生效。"""
    return set_weather(state, rs, str(value.get("weather") or ""), value.get("turns"),
                       side=side, skill_id=skill.skill_id, cfg=cfg)


def _end_turn_weather(state: GameState, rs: Ruleset, cfg: RuleConfig) -> None:
    """天气的**回合末**结算：效果（暴风雪 / 雷鸣）→ 回合数递减 → 到期清除。

    它**不是** `turn_order.end_turn.order` 声明的逐宠阶段（那个清单是「每只在场精灵内部」的顺序），
    而是场地级、双方一起结算；调用点因此是 `_end_of_turn` 里声明阶段跑完之后。
    「先结算效果、再递减回合数」这条顺序没有一手证据（官方只说「每回合结束时」），
    登记在 battle-modes 的 unknowns `end_turn_order_vs_status_tick` 里。
    """
    weather = state.weather
    if not isinstance(weather, dict):
        return
    name = str(weather.get("name") or "")
    spec = _weather_effect_of(cfg, name)
    if spec is None:
        # 场上有个没声明的天气（不可能由本引擎设出）——不动它、也不算它的回合数。
        _note_unsupported(
            state, f"天气「{name}」的回合末结算",
            f"规则配置 {cfg.ruleset_config_id} 没有声明这一种天气 —— 不结算、也不递减它的回合数", "")
        return
    if spec.get("kind") == "end_turn_status":
        status = str(spec.get("status") or "")
        layers = int(spec.get("layers") or 0)
        immune = str(spec.get("immune_element") or "")
        for side in (state.player, state.enemy):
            if cfg.has_mana and state.result:
                return
            pet = side.field_pet
            if not pet.alive:
                continue
            pet_name = _pet_display_name(rs, pet)
            if immune and immune in _pet_types(rs, pet):
                state.log.append(f"{pet_name}是{immune}，免疫{name}的{status}。")
                _bump(state, "weather_immune", {
                    "side": side.name, "weather": name, "status": status,
                    "immune_element": immune,
                }, evidence=(str(spec.get("term_id") or ""),))
                continue
            info = pet.statuses.get(status)
            if not isinstance(info, dict):
                info = {"layers": 0}
            info["layers"] = int(info.get("layers", 0)) + layers
            info.setdefault("source", f"天气{name}")
            pet.statuses[status] = info
            state.log.append(f"{pet_name}获得 {layers} 层{status}（共 {info['layers']} 层）。")
            _bump(state, "weather_status", {
                "side": side.name, "weather": name, "status": status,
                "layers": layers, "layers_after": info["layers"],
            }, evidence=(str(spec.get("term_id") or ""),))
            # 术语 3022：引电满 2 层要立刻结算 —— 但**它没实现**，而且「天气给的层数算不算触发」
            # 没有一手证据。这里如实登记，不猜一个伤害、也不静默把层数扣掉。
            if status == "引电" and info["layers"] >= 2:
                _note_unsupported(
                    state, "引电达到 2 层的立即结算",
                    "术语 3022 写「获得2层引电时，立即受到25%生命的电系伤害，并失去2层引电」，"
                    "但本引擎没有实现这条触发，且「天气给的层数是否触发它」没有一手证据 —— 不猜", "3022")
    elif spec.get("kind") in ("skill_power_multiplier", "skill_energy_cost_multiplier"):
        # 这两类在**出手时**结算（伤害 / 能耗），回合末没有事情要做。
        pass
    _bump(state, "weather_tick", {
        "weather": name, "turns_left": int(weather.get("turns_left", 0)) - 1,
    }, evidence=(str(spec.get("term_id") or ""),))
    weather["turns_left"] = int(weather.get("turns_left", 0)) - 1
    if weather["turns_left"] <= 0:
        state.weather = None
        state.log.append(f"{name}结束了。")
        _bump(state, "weather_end", {"weather": name})


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
    """结算一只在场精灵身上的所有状态伤害（术语 1001/1002/1008）。

    ⚠ 2026-09-29（第三轮⑥）：**两条口径按配置分流**，不许混：
      · 配置声明了 `status.end_of_turn[状态]`（v3）⇒ 走**本地规则**：
        伤害 = 最大生命 × (base% + per_layer% × (层数−1))，层数按 `decay` 衰减，
        并**倒数持续回合**；「层数归零**或**回合用尽」即移除。
        （老口径下 灼烧 的 ceil(1/2)=1 ⇒ **永远不归零**，这是本轮实测到的真缺陷。）
      · 没声明（legacy / v2）⇒ 走 `fx.status_tick` + `fx.decay_layers` 的**老口径**，逐位不变。
    """
    cfg = cfg or _rule_config.get_rule_config(state.ruleset_config_id or None)
    local_rules = getattr(cfg, "status_end_of_turn", None) or {}
    for name in list(pet.statuses.keys()):
        info = pet.statuses[name]
        layers = int(info.get("layers", 1))
        rule = local_rules.get(name)
        if rule is not None:
            try:
                dmg = fx.layered_status_tick(pet.hp, pet.max_hp, name, layers, rule)
            except fx.UnsupportedEffect as exc:
                _note_unsupported(state, f"状态「{name}」", str(exc))
                continue
        else:
            try:
                dmg = fx.status_tick(pet.hp, pet.max_hp, name)
            except fx.UnsupportedEffect as exc:
                _note_unsupported(state, f"状态「{name}」", str(exc))
                continue
        pet.hp = max(0, pet.hp - dmg)
        spec = fx.END_OF_TURN_STATUS.get(name, {})
        if rule is not None:
            after = fx.layer_decay_by_rule(layers, rule)
            turns_after = fx.status_turns_left_after(after, int(info.get("turns_left", rule["duration_turns"])))
            info["layers"] = after
            info["turns_left"] = turns_after
            expired = after <= 0 or turns_after <= 0
        else:
            info["layers"] = fx.decay_layers(layers, half=bool(spec.get("decays")))
            expired = info["layers"] <= 0
        detail: Dict[str, Any] = {
            "side": side.name, "status": name, "damage": dmg,
            "layers_after": info["layers"],
        }
        if rule is not None:
            detail["turns_left_after"] = int(info.get("turns_left", 0))
            detail["damage_rule"] = "LOCAL_RULE"
        if expired:
            state.log.append(
                f"{rs.pet(pet.pet_id).name}受到{name}伤害 {dmg}（状态结束）。"
            )
        else:
            state.log.append(
                f"{rs.pet(pet.pet_id).name}受到{name}伤害 {dmg}"
                f"（剩余 {info['layers']} 层"
                + (f"、{int(info.get('turns_left', 0))} 回合" if rule is not None else "")
                + "）。"
            )
        _bump(state, "status_tick", detail, evidence=(spec.get("term", ""),))
        if expired:
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
    # 引擎级计数器（不是声明里的游戏阶段）：PVP 魔法的冷却每回合减 1。见 `_tick_magic_cooldowns`。
    _tick_magic_cooldowns(state)
    # 同一条纪律：能耗修正的到期（`until_turn`）也在回合末清。见 `_tick_energy_cost_mods`。
    _tick_energy_cost_mods(state)
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
        # RC-401 批次十七（task-26 H 族批二）：「**回合结束时，本技能<属性>永久±N**」。
        # 触发条件**确定可判**（回合末一定会到）⇒ `happened=True` ✓
        # 只翻这只精灵**配招里真的带着的**技能（与 `_accumulate_on_hit_ramps` 同一口径）✓
        # ⚠ 放在**阶段循环之外**：它不是 `turn_order.end_turn.order` 里声明的游戏阶段
        #   （那是"每只在场精灵内部"的伤害/回能顺序），借它当阶段会改掉那条声明的语义 ✗。
        if pet.alive:
            _accumulate_end_of_turn_ramps(state, rs, side, pet, cfg)
    # 天气的回合末结算（场地级，双方一起）：**在声明阶段之后**。
    # 它不算 `turn_order.end_turn.order` 里的阶段（那是「每只在场精灵内部」的顺序），
    # 所以放在这个循环外面；顺序本身没有一手证据，登记在 battle-modes 的 unknowns 里。
    _end_turn_weather(state, rs, cfg)


def _accumulate_end_of_turn_ramps(state: GameState, rs: Ruleset, side_state,
                                  pet: PetState,
                                  cfg: Optional[RuleConfig] = None) -> None:
    """回合结束时：把这只精灵配招里带「**回合结束时，本技能<属性>永久±N**」的技能各累加一次。

    RC-401 批次十七（task-26 H 族批二 · 3 条：`skill_000432 水波术` 威力+20 ·
    `skill_000252 冲撞` 能耗-1 · `skill_000503 抛石` 能耗-5）。
    与 `_accumulate_triggered_ramp` **共用同一套写点与同一个能力位**（`damage.triggered_ramp`）：
    这里只负责"回合末到了"这个**确定事实** ⇒ `happened=True` ✓

    ⚠ `side_state` 是 `SideState` **对象**（`_end_of_turn` 的 `for side in (state.player, state.enemy)`
    里那个 `side`）—— 第一版按字符串用 `getattr(state, side)` 直接 `TypeError`（当场抓到 ✓）。
    """
    cfg = cfg or _rule_config.get_rule_config()
    if not bool(getattr(cfg, "damage_triggered_ramp", False)):
        return
    loadout = tuple(side_state.loadouts.get(pet.pet_id) or ())
    for sid in loadout:
        skill = rs.skills.get(sid)
        if skill is None:
            continue
        parsed = parse.resolve_triggered_ramp(skill, declared=True)
        _accumulate_triggered_ramp(state, pet, skill, parsed,
                                   trigger="end_of_turn", happened=True, cfg=cfg)


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
        row = {
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
        # 2026-09-30（Q8 收口，task-22）：己方这一只有个体快照时，把**同一份投影**一并带进公开面。
        #
        # 为什么必须带（实测的链条）：`/battle/plan` 的**伤害预告**与规划搜索都跑在
        # `state_from_public_planner()` 重建出来的状态上 —— 不带这个键，重建出来的
        # `PetState.panel` 就是空 ⇒ 预告按**种族值**算、真结算按**个体面板**算：
        # 「页面预告一个数，打出来另一个数」（人类逐字：「肯定要按照最终结算出来应该怎么样
        # 就怎么样啊，不能偷懒」）。
        #
        # 与 `ui_public_view` 的己方那四个键**同一套词**（有快照才出现）：它是**已有事实的转发**
        # （引擎已经算好的那一份面板 + 实例 id + 投影版本），不是新算的、不是猜的。
        # **没有快照时这四个键一个都不出现** ⇒ legacy / 无快照对局的协议与推荐逐位不变。
        #
        # ⚠ 体积换算（2026-09-30 实测，真实 tokenizer）：六宠全带快照时这条协议
        #   937 → 1333 token（**+396 / +42.3%**）。**现在不瘦身**：这份协议只走
        #   **Node→引擎的本地 stdio**（`/battle/plan` 的请求体），不进模型上下文；
        #   `plan_actions` 的工具契约上限 8000 字节也装得下（实测 3794 字符）。
        #   ⇒ **若将来把整份 state 发给模型（当工具参数 / 进 prompt）⇒ 必须先瘦身**
        #     （那时 +396 token 才是真花钱）。可选瘦身：只留 `panel` + `individual_id`、
        #     去掉 `panel_projection` / `individual_level`、`panel` 压成有序数组（约 +20%）。
        if p.panel:
            row.update({
                "panel": dict(p.panel),
                "individual_source": p.individual_source or "individual-snapshot",
                "individual_id": p.individual_id,
                "panel_projection": p.panel_projection,
                "individual_level": p.individual_level,
            })
        return row

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

    # `mana.pool`（这一局每人几颗心）是**规则常量**，与 `energy_max` 同一性质 ——
    # 页面的掉心动效靠它把「掉了的」画成空心的 ♡。读不到就是 None，界面不画（不编总数）。
    # ⚠ 2026-09-23：这里原先把 `cfg` 当成本函数的局部变量用，而它并不存在（`cfg` 只绑在
    # `ui_public_view` 里）→ 每次构造公开视图都抛 `NameError: name 'cfg' is not defined`，
    # 标准 PVP **根本开不了局**（实测：单元测试 6 条红、页面按钮点下去没反应）。
    # 就地读一次当前生效的规则配置即可（与 `ui_public_view` 用的是同一个入口）。
    cfg = _rule_config.get_rule_config(state.ruleset_config_id or None)
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
        # `pool` 是**规则常量**（这一局每人几颗心），与 `energy_max` 同一性质：
        # 它是公开的，页面的掉心动效要靠它把「掉了的」画成空心的 ♡。
        **({"mana": {"self": me.mana, "opponent": foe.mana,
                     "pool": getattr(cfg, "mana_pool", None)}}
           if (me.mana is not None or foe.mana is not None) else {}),
        # RC-106：这一局用过的**未核验覆盖**必须如实出现在公开面里 —— 它改变的是
        # **规则值本身**（例如入场初始能量），而规则值对双方一样、页面上也写着。
        # 藏起来会更坏：页面把「候选口径下的 2」显示成「标准 PVP 的入场能量」，
        # 也就是把一个假设说成事实。没有覆盖时这里是空数组（键始终在）。
        "unverified_overrides": list(state.unverified_overrides),
        # 2026-09-25：**天气也是公开事实**（官方逐字：「天气是常驻在全场的效果，让对战双方
        # 都能获得相应的加成」「对局战报查看当前天气的剩余回合数」）⇒ 规划侧必须看得到
        # 当前天气与剩余回合数（雨天 +75% / 沙暴能耗减半会直接改变最优手）。
        # **没有天气时这个键不出现**：没开天气的对局（含全部 legacy 调用点）逐位不变。
        **({"weather": dict(state.weather)} if isinstance(state.weather, dict) else {}),
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
    #: 己方这一侧"哪只带了哪个个体快照"（Q8）：有快照的用面板，没快照的用种族值。
    own_by_pet = {pet.pet_id: pet for pet in me.pets}
    #: 这一局的速度/伤害口径（Q8 收口，task-23）：整局任一只带快照 ⇒ 面板口径。
    #: **展示必须跟着它走**：本局按面板结算，屏幕上就不能写种族值
    #: （否则「对手显示速度 130、先手却按 278.63 比」＝屏幕上两套数）。
    panel_scale = battle_uses_panel_scale(state)

    def pet_public(pet_id: str) -> Dict[str, Any]:
        """从规则集取展示用的静态信息。查不到就如实留空，不猜。

        2026-09-29（Q8）：**己方**这一只如果有个体快照，六维就用快照算出来的面板
        （`PetState.panel`，与列表/详情同一份投影），并带 `stats_source` /
        `individual_id` / `panel_projection` 三个键 —— 让"有快照 / 没快照"两种情况
        **能分辨**（人类逐字：「不许把两种情况说成一样」）。

        2026-09-30（Q8 收口，task-23）：**这一局走面板口径时，没快照的那一侧展示的也是面板**
        （`data.panel_stats(race)`，`stats_source='species-panel'`）—— 它没有个体快照，
        物种面板就是它在结算里真用的那一份（伤害、生命、先手都按它算）。
        **整局没有快照** ⇒ 逐字仍旧是种族值（`species-race`）⇒ 回执逐位不变。
        """
        try:
            pet = rs.pet(pet_id)
        except Exception:  # noqa: BLE001 — 规则集里没有这只精灵时必须能降级
            return {"name": None, "types": [], "stats": None, "class": None, "stage": None,
                    "stats_source": "unknown"}
        own = own_by_pet.get(pet_id)
        if own is not None and own.panel:
            return {
                "name": pet.name,
                "types": list(getattr(pet, "types", []) or []),
                "stats": dict(own.panel),
                "class": getattr(pet, "pet_class", None),
                "stage": getattr(pet, "stage", None),
                "stats_source": "individual-snapshot",
                "individual_id": own.individual_id,
                "individual_level": own.individual_level,
                "panel_projection": own.panel_projection,
            }
        if panel_scale:
            import roco_env.data as _data  # 局部导入：与 effects 同一理由，避免模块级成环
            species_panel = _data.panel_stats(dict(getattr(pet, "stats", {}) or {}))
            if species_panel:
                return {
                    "name": pet.name,
                    "types": list(getattr(pet, "types", []) or []),
                    "stats": {k: v for k, v in species_panel.items()},
                    "class": getattr(pet, "pet_class", None),
                    "stage": getattr(pet, "stage", None),
                    "stats_source": "species-panel",
                    "panel_projection": _individuals.PROJECTION_VERSION,
                }
        return {
            "name": pet.name,
            "types": list(getattr(pet, "types", []) or []),
            "stats": dict(getattr(pet, "stats", {}) or {}) or None,
            "class": getattr(pet, "pet_class", None),
            "stage": getattr(pet, "stage", None),
            "stats_source": "species-race",
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
    # 2026-09-22（人类战斗页 v2 R3）：聚能**回复多少**也是屏幕上的规则常量
    # （「聚能 → 10 / 10」要算得出来）。同样只给配置里的登记值，读不到就不写。
    self_panel["energy_charge"] = getattr(cfg, "energy_charge", None)
    self_panel["pets"] = [decorate(p) for p in view["self"]["pets"]]
    # 己方当前可用的技能（配招里那一套），UI 的技能面板直接用它
    self_panel["skills"] = [
        ui_action_public({"skill_id": sid, "kind": "skill"}, rs)
        for sid in sorted({sid for ids in (me.loadouts or {}).values() for sid in ids})
    ]
    # 2026-09-23：**己方的实时配招**（pet_id -> [技能 id]），按位次给。
    # 为什么必须带出来：PVP 魔法「愿力强化」会把**第一个技能**换掉（human 口径），
    # 而页面的四格技能原来只读客户端名册里的 `moveset` → 换完之后格子还写着旧技能名，
    # 引擎却在发「愿力冲击」这个动作（名字与可点性对不上）。视图给按位次的真值，
    # 页面就能逐格对齐。**只给己方**：对手的技能表从来不在公开视图里（`observation_for` 同一口径）。
    self_panel["loadouts"] = {pid: list(ids) for pid, ids in (me.loadouts or {}).items()}
    # PVP 魔法状态（次数 / 冷却 / 换过谁）——同样**只给己方**：
    # 人类口径「对手看不见你用了这件道具」（愿力冲击本身照常公开）。
    self_panel["magic"] = dict(me.magic) if isinstance(me.magic, dict) else None
    # UI 自己的合法动作表（带技能说明）。协议那份 `legal` 在 service 里，
    # 字段一个都不变——两条链各取所需。
    ui_legal = {
        "player": ui_legal_actions(state, rs, "player"),
        "enemy": ui_legal_actions(state, rs, "enemy"),
    }

    foe_panel = dict(view["opponent"])
    # 对手的能量上限是**规则常量**（不是隐藏信息）：双方用同一份规则配置。
    foe_panel["energy_max"] = energy_max
    foe_panel["energy_charge"] = getattr(cfg, "energy_charge", None)
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
        # 2026-09-25：天气照抄规划协议那一份（同一时刻的同一局，不另算一遍）。
        # 页面上它就是要画在战报里的那条「当前天气（还剩 N 回合）」。
        **({"weather": view["weather"]} if "weather" in view else {}),
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
            # 2026-09-30（Q8 收口）：公开面里有快照那一份就还原回 `PetState` ——
            # 规划搜索与伤害预告都跑在重建出来的状态上，不还原就等于"协议带下来了、
            # 算的时候又丢了"（伤害预告会退回种族值）。没有快照 ⇒ `{}`，与改动前逐位相同。
            panel={k: int(v) for k, v in (d.get("panel") or {}).items()},
            individual_source=str(d.get("individual_source") or ""),
            individual_id=d.get("individual_id"),
            individual_level=d.get("individual_level"),
            panel_projection=d.get("panel_projection"),
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
