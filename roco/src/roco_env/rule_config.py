"""版本化规则配置的加载与校验（RC-101）。

**唯一事实源是 `data/roco/rulesets/*.json`。** 本模块只读它们，不写、不内联任何
数值 —— 这是「JS/Python/UI 不重复常量」那条要求的 Python 侧一半。规则值本身来自
`data/roco/evidence/rule-evidence-ledger.json`（证据台账），配置文件里每个字段都带
`confidence` + `evidence_id`，由 `scripts/roco/build-rule-configs.mjs` 生成与核对。

纪律：

  · **默认必须是 `legacy_sim_v1`**：默认路径要跟当前引擎逐位相同，否则所有既有
    replay / 夹具 / 产物当场失效。
  · **fail closed**：缺字段、未知配置 id、台账指纹不符、confidence 与台账不一致、
    UNKNOWN 字段却带一个「看起来合理」的值 —— 全部抛 `RuleConfigError`，不猜默认值。
  · **unknown 就是 unknown**：`null` 不会被替换成任何数字；真要用到它的调用方必须显式
    处理（`require_energy_initial()` 会抛错，`require_team_size()` 会按模式参数校验）。

纯 stdlib，Python 3.9 兼容。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

#: 默认生效的配置 id。**改这一行等于改默认规则**，必须同时有迁移影响报告。
DEFAULT_RULE_CONFIG_ID = "legacy_sim_v1"

#: 候选配置 id（实机 microcase 支持前**不得**作为默认）。
CANDIDATE_RULE_CONFIG_ID = "mobile_s4_candidate_v2"

#: RC-105 的候选配置 id：第一个声明「魔力系统 + 合法动作裁剪」的配置。同样是候选。
MANA_ACTIONS_CANDIDATE_ID = "mobile_s4_candidate_v3"

#: 声明 `mana` / `actions` 的配置白名单（RC-105）。只有名单里的配置**必须**写全这两块；
#: legacy 与 v2 显式登记为「没有魔力系统、不裁剪合法动作」。把新字段塞进 `REQUIRED_PATHS`
#: 会让两份既有配置当场加载失败（等于改掉默认行为）或逼人给 legacy 补一个假 0。
MANA_ACTIONS_CONFIG_IDS = (MANA_ACTIONS_CANDIDATE_ID,)

#: RC-105：`mana` / `actions` 里每个字段都必须写全的路径。
MANA_REQUIRED_PATHS = (
    "mana.pool",
    "mana.faint_cost",
    "mana.loss_when_zero",
    "mana.surrender",
)
ACTIONS_REQUIRED_PATHS = (
    "actions.allowed_kinds",
    "actions.forbidden_kinds",
    "actions.unknown_kinds_allowed",
)

#: RC-105：配置里允许写的**动作类名**（配置 schema 的词汇表）。
#: 与 `schema.VALID_KINDS`（引擎白名单）分开登记：本模块刻意不 import `schema`/`data`，
#: 两边一致由 `roco/tests/test_mana_actions.py` 钉住。
KNOWN_ACTION_KINDS = (
    "skill", "charge", "switch", "surrender", "item", "escape", "struggle",
    # 2026-09-23：PVP 魔法（愿力强化）。与 `item` 分开：台账 EV-PVP-WISH-POWER-UP 写着
    # 「它不是普通道具」，而标准 PVP 的普通道具仍然是 forbidden。
    "magic",
)

#: RC-105：`actions.kinds.<kind>.value` 的合法取值。
ACTION_KIND_STATUSES = ("allowed", "forbidden")

#: 运行时选择配置的环境变量名。
ENV_VAR = "ROCO_RULE_CONFIG"

#: 配置文件所在目录（相对仓库根）。
RULESET_DIR = os.path.join("data", "roco", "rulesets")

#: 证据台账（配置里的 `derived_from_ledger_sha256` 必须等于它的 sha256）。
LEDGER_REL = os.path.join("data", "roco", "evidence", "rule-evidence-ledger.json")

#: BattleMode 登记表（配置里的 `battle_mode.id` 必须在里面）。
BATTLE_MODES_REL = os.path.join("data", "roco", "battle-modes.json")

#: 台账允许的置信等级。只有前两级能直接成为 current 规则（台账自带说明）。
CONFIDENCE_LEVELS = (
    "OFFICIAL_CURRENT",
    "RECORDED_IN_GAME",
    "COMMUNITY_CURRENT",
    "CROSS_SOURCE_SUPPORTED",
    "ENGINE_HYPOTHESIS",
    "UNKNOWN",
)

#: 台账条目对某个配置值是「支持」还是「反驳」。
EVIDENCE_ROLES = ("supports", "refutes")

#: `turn_order.speed_tie` 允许的取值（RC-103）。
#:
#: `"random_seeded"` = **如实登记的工程权宜**：引擎用 seed 驱动的确定性随机来裁决同速，
#: 这不是游戏规则，MC-E05 之前也没有任何证据支持它。`None` = UNKNOWN（引擎会 fail closed，
#: 绝不回落到随机数）。任何别的字符串都是**非法值**，加载期就该炸。
SPEED_TIE_POLICIES = ("random_seeded",)

#: 每个配置**必须**存在的字段路径（缺任何一个就 fail closed）。
REQUIRED_PATHS = (
    "energy.max",
    "energy.regen.per_turn",
    "energy.regen.applies_to",
    "energy.initial",
    "energy.charge",
    "turn_order.action_order",
    "turn_order.speed_tie",
    "turn_order.end_turn.order",
    "turn_order.end_turn.unknown_stages_allowed",
    "battle_mode.id",
    "battle_mode.team_size",
    "battle_mode.active_count",
)


class RuleConfigError(RuntimeError):
    """规则配置缺失/不一致/未核验。**加载期就该炸**，不要拖到对局中途。"""


# ── 路径 ────────────────────────────────────────────────────────────────


def _repo_root() -> str:
    """仓库根。本文件在 roco/src/roco_env/rule_config.py → 3 个 \"..\"。

    与 `data.py::_repo_root` 同一算法；这里不 import `data`，因为本模块要能
    在**不加载规则集**的情况下单独使用（例如配置审计脚本）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


#: 配置 id 允许的字符（它是文件名的一部分，必须挡住路径穿越）。
_SAFE_ID = re.compile(r"^[a-z0-9_]{1,64}$")


def rule_configs_dir() -> str:
    """配置文件目录（绝对路径）。"""
    return os.path.join(_repo_root(), RULESET_DIR)


def config_path(ruleset_config_id: str) -> str:
    """某个配置 id 对应的文件路径。

    不允许 `../` 这类越界片段：id 是**文件名的一部分**，路径穿越会变成任意文件读。
    """
    if not _SAFE_ID.match(ruleset_config_id or ""):
        raise RuleConfigError(f"非法的规则配置 id：{ruleset_config_id!r}（只允许小写字母/数字/下划线）")
    return os.path.join(rule_configs_dir(), ruleset_config_id.replace("_", "-") + ".json")


# ── 台账 / 登记表 ────────────────────────────────────────────────────────


def ledger_sha256() -> str:
    """证据台账文件的 sha256（配置必须引用这个值）。"""
    path = os.path.join(_repo_root(), LEDGER_REL)
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError as exc:
        raise RuleConfigError(f"读不到证据台账 {LEDGER_REL}：{exc}") from exc


def _load_ledger() -> Dict[str, Any]:
    path = os.path.join(_repo_root(), LEDGER_REL)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            ledger = json.load(fh)
    except OSError as exc:
        raise RuleConfigError(f"读不到证据台账 {LEDGER_REL}：{exc}") from exc
    except ValueError as exc:
        raise RuleConfigError(f"证据台账不是合法 JSON（{LEDGER_REL}）：{exc}") from exc
    entries = ledger.get("entries")
    if not isinstance(entries, list) or not entries:
        raise RuleConfigError(f"证据台账 {LEDGER_REL} 里没有 entries —— 没有台账就没法审计配置")
    return ledger


def _ledger_index(ledger: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for entry in ledger.get("entries", []):
        entry_id = entry.get("id")
        if not entry_id:
            raise RuleConfigError("证据台账里有条目没有 id")
        index[entry_id] = entry
    return index


def _read_battle_modes() -> Dict[str, Any]:
    path = os.path.join(_repo_root(), BATTLE_MODES_REL)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            registry = json.load(fh)
    except OSError as exc:
        raise RuleConfigError(f"读不到 BattleMode 登记表 {BATTLE_MODES_REL}：{exc}") from exc
    except ValueError as exc:
        raise RuleConfigError(f"BattleMode 登记表不是合法 JSON：{exc}") from exc
    if not registry.get("modes"):
        raise RuleConfigError("BattleMode 登记表里一个模式都没有")
    return registry


#: 登记表的进程内缓存：它是仓库里的静态事实，而 RC-106 起 `validate_config` 每次都要问
#: 它模式的 team_size —— 不缓存的话审计路径会退化成 N 次文件读。
_BATTLE_MODES_CACHE: Dict[str, Any] = {}


def battle_mode_registry() -> Dict[str, Any]:
    """BattleMode 登记表原文（只读）。"""
    if "registry" not in _BATTLE_MODES_CACHE:
        _BATTLE_MODES_CACHE["registry"] = _read_battle_modes()
    return _BATTLE_MODES_CACHE["registry"]


def _battle_mode_ids() -> set:
    modes = battle_mode_registry().get("modes", []) or []
    return {mode.get("id") for mode in modes if mode.get("id")}


def battle_mode_entry(mode_id: str) -> Dict[str, Any]:
    """按 id 取一条模式登记；不存在就抛错（不返回 None 让调用方自己猜）。"""
    for mode in battle_mode_registry().get("modes", []) or []:
        if mode.get("id") == mode_id:
            return mode
    raise RuleConfigError(f"BattleMode {mode_id!r} 不在登记表 {BATTLE_MODES_REL} 里")


def bound_config_id_for_mode(mode_id: str) -> Optional[str]:
    """登记表给这个模式登记的 `ruleset_binding`（这个模式按哪份规则配置结算）。

    **为什么引擎要读它**：带 mana/actions 的是 v3 —— 绑定一旦落后（RC-105 时它指向
    v2），服务端与页面就会按「能开局但没有魔力系统」的口径去开标准 PVP 的局。
    读成**唯一可核对的那一处**，两侧测试因此断言同一个事实，而不是各抄一份字面量。

    它**不**参与 `reset()` 的配置选择：显式传入的 `config` 永远优先。
    """
    entry = battle_mode_entry(mode_id)
    binding = entry.get("ruleset_binding")
    return str(binding) if binding else None


def mode_team_size(mode_id: str) -> Optional[int]:
    """登记表里这个模式的 `team_size`（`None` = 登记为「不适用」，例如 PVE）。"""
    entry = battle_mode_entry(mode_id)
    value = (entry.get("parameters") or {}).get("team_size")
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise RuleConfigError(
            f"BattleMode {mode_id} 的 parameters.team_size 不是正整数（实际 {value!r}）"
        )
    return value


# ── 叶子 / 值 ───────────────────────────────────────────────────────────


def _iter_leaves(node: Any, prefix: str = "") -> List[Tuple[str, Dict[str, Any]]]:
    """遍历配置里所有 `{value, confidence, evidence_id}` 叶子。

    只看带 `value` **且**带 `confidence` 的字典：这是配置格式的硬约定，别的地方
    （`unknowns` / `notes`）不该被误当成叶子。
    """
    out: List[Tuple[str, Dict[str, Any]]] = []
    if isinstance(node, dict):
        if "value" in node and "confidence" in node:
            out.append((prefix, node))
            return out
        for key, child in node.items():
            out.extend(_iter_leaves(child, f"{prefix}.{key}" if prefix else str(key)))
    return out


def _dig(config: Dict[str, Any], path: str) -> Any:
    """按点号路径取值；缺任何一段返回 `_MISSING`。"""
    node: Any = config
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return _MISSING
        node = node[part]
    return node


class _Missing:
    def __repr__(self) -> str:  # pragma: no cover - 只为调试好看
        return "<缺字段>"


_MISSING = _Missing()


def _optional_policy_bool(config: Dict[str, Any], path: str) -> Optional[bool]:
    """策略里的可选布尔：缺字段 / null = `None`（**UNKNOWN，不是 False**）。

    与 `_optional_leaf_true` 的区别就在「缺字段」：那条是**能力声明**（缺了 = 没这个能力），
    这条是**策略取值**（缺了 = 没核验过 ⇒ 调用方必须 fail closed，不许当 False 用）。
    形状允许裸布尔（`policies` 里就是这么写的）与叶子 `{"value": …}`。
    """
    node = _dig(config, path)
    if node is _MISSING or node is None:
        return None
    if isinstance(node, bool):
        return node
    if isinstance(node, dict):
        value = node.get("value")
        return value if isinstance(value, bool) or value is None else _bad_policy_value(config, path, value)
    raise RuleConfigError(
        f"规则配置 {config.get('ruleset_config_id')} 的 {path} 必须是布尔 / 叶子对象 / null，"
        f"实际 {type(node).__name__}")


def _bad_policy_value(config: Dict[str, Any], path: str, value: Any) -> None:
    raise RuleConfigError(
        f"规则配置 {config.get('ruleset_config_id')} 的 {path}.value 必须是布尔或 null，实际 {value!r}")


def _optional_raw_str(config: Dict[str, Any], path: str) -> Optional[str]:
    """策略里的可选字符串（证据等级等）：缺字段 / null → None，只用于诊断。"""
    node = _dig(config, path)
    if isinstance(node, dict):
        node = node.get("value")
    return None if node is _MISSING or node is None else str(node)


def _optional_policy_dict(config: Dict[str, Any], path: str) -> Optional[Dict[str, Any]]:
    """策略里的可选**对象**（整份政策子树）：缺字段 / null → None = **没声明**。

    与 `_optional_policy_bool` 同一条纪律：`None` 不是「值为空」，而是「这份配置没有这个概念」，
    调用方遇到它必须 fail closed，不许回落到别的配置或一个看起来合理的默认值。
    """
    node = _dig(config, path)
    if node is _MISSING or node is None:
        return None
    if not isinstance(node, dict):
        raise RuleConfigError(
            f"规则配置 {config.get('ruleset_config_id')} 的 {path} 必须是对象 / null，"
            f"实际 {type(node).__name__}")
    return dict(node)


def _optional_leaf_true(config: Dict[str, Any], path: str) -> bool:
    """可选布尔能力：**缺字段 = False**；存在时必须是 `{value: true/false, ...}`。

    与 `_leaf_value` 的区别是「缺字段」的语义：必填项缺了要炸（那是纪律），
    而 RC-401 的能力声明是**增量**的——legacy 里根本没有这一块，缺了就是「没这个能力」。
    """
    node = _dig(config, path)
    if node is _MISSING:
        return False
    if not isinstance(node, dict):
        raise RuleConfigError(f"规则配置 {config.get('ruleset_config_id')} 的 {path} 必须是对象")
    return node.get("value") is True


def _leaf_value(config: Dict[str, Any], path: str) -> Any:
    """取叶子路径的 `value`；路径不存在或不是叶子就抛错（fail closed）。"""
    node = _dig(config, path)
    if node is _MISSING:
        raise RuleConfigError(f"规则配置 {config.get('ruleset_config_id')} 缺字段 {path}")
    if not isinstance(node, dict) or "value" not in node:
        raise RuleConfigError(f"规则配置 {config.get('ruleset_config_id')} 的 {path} 不是带 value 的字段记录")
    return node["value"]


# ── 校验 ────────────────────────────────────────────────────────────────


def _validate_mana(config: Dict[str, Any], bad) -> None:
    """RC-105：`mana` 块的形状与取值域。没写 `mana`（legacy / v2）直接跳过。

    只判「配置是不是一份合法可读的登记表」；「引擎能不能按它跑」是 `env.py` 的事。
    """
    node = config.get("mana")
    if node is None:
        return
    if not isinstance(node, dict):
        bad("mana 必须是对象（pool / faint_cost / loss_when_zero / surrender）")
        return
    for key in ("pool", "faint_cost"):
        leaf = node.get(key)
        if not isinstance(leaf, dict) or "value" not in leaf:
            continue                       # 缺字段由白名单那条报，别报两遍
        value = leaf["value"]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            bad(f"mana.{key} 必须是 >= 0 的整数，实际 {value!r}")
        elif key == "pool" and value == 0:
            bad("mana.pool 必须 > 0：魔力池为 0 等于开局即判负，那不是一份可玩的模式")
    for key in ("loss_when_zero", "surrender"):
        leaf = node.get(key)
        if not isinstance(leaf, dict) or "value" not in leaf:
            continue
        if not isinstance(leaf["value"], bool):
            bad(f"mana.{key} 必须是布尔（机器可读的开关），实际 {leaf['value']!r}")


def _validate_actions(config: Dict[str, Any], bad) -> None:
    """RC-105：`actions` 块的形状、取值域与两张清单的自洽性。

    判据：两张清单非空无重复、元素是已知动作类、**不许有交集**；`unknown_kinds_allowed`
    是布尔；`actions.kinds` **恰好**覆盖两张清单里的每个 kind 且每个都带
    `confidence` / `evidence_id`（没台账支撑就 ENGINE_HYPOTHESIS + reason）。
    """
    node = config.get("actions")
    if node is None:
        return
    if not isinstance(node, dict):
        bad("actions 必须是对象（allowed_kinds / forbidden_kinds / unknown_kinds_allowed / kinds）")
        return

    def kind_list(key: str) -> Optional[List[str]]:
        leaf = node.get(key)
        if not isinstance(leaf, dict) or "value" not in leaf:
            return None                    # 缺字段由白名单那条报
        seq = leaf["value"]
        if not isinstance(seq, list) or not seq:
            bad(f"actions.{key} 必须是非空数组（顺序就是展示顺序），实际 {seq!r}")
            return None
        if any(not isinstance(x, str) or not x for x in seq):
            bad(f"actions.{key} 的元素必须是非空字符串，实际 {seq!r}")
            return None
        if len(set(seq)) != len(seq):
            bad(f"actions.{key} 里有重复项：{seq!r}")
        unknown = [x for x in seq if x not in KNOWN_ACTION_KINDS]
        if unknown:
            bad(f"actions.{key} 里有引擎不认识的动作类 {'、'.join(unknown)}"
                f"（已知：{'、'.join(KNOWN_ACTION_KINDS)}）")
            return None
        return seq

    allowed = kind_list("allowed_kinds")
    forbidden = kind_list("forbidden_kinds")
    if allowed is not None and forbidden is not None:
        overlap = sorted(set(allowed) & set(forbidden))
        if overlap:
            bad(f"actions.allowed_kinds 与 actions.forbidden_kinds 有交集 {overlap} ——"
                "同一个动作类不可能既合法又禁止")

    flag = node.get("unknown_kinds_allowed")
    if flag is not None and (not isinstance(flag, dict) or "value" not in flag):
        bad("actions.unknown_kinds_allowed 不是带 value 的字段记录")
    elif isinstance(flag, dict) and "value" in flag and not isinstance(flag["value"], bool):
        bad(f"actions.unknown_kinds_allowed 必须是布尔，实际 {flag['value']!r}")

    kinds = node.get("kinds")
    if not isinstance(kinds, dict):
        bad("actions.kinds 必须是「动作类 → 登记」的对象（每个 kind 都要写 confidence/evidence_id）")
        return
    if allowed is not None and forbidden is not None:
        wanted = set(allowed) | set(forbidden)
        missing = sorted(wanted - set(kinds))
        extra = sorted(set(kinds) - wanted)
        if missing:
            bad(f"actions.kinds 少了这些动作类：{missing}（每个 kind 都要有登记）")
        if extra:
            bad(f"actions.kinds 里有 allowed/forbidden 两张清单都没提到的动作类：{extra}")
    for kind, leaf in kinds.items():
        if kind not in KNOWN_ACTION_KINDS:
            bad(f"actions.kinds 里有引擎不认识的动作类 {kind!r}")
            continue
        if not isinstance(leaf, dict) or "value" not in leaf:
            bad(f"actions.kinds.{kind} 不是带 value 的字段记录")
            continue
        status = leaf["value"]
        if status not in ACTION_KIND_STATUSES:
            bad(f"actions.kinds.{kind}.value 必须是 {'/'.join(ACTION_KIND_STATUSES)}，实际 {status!r}")
            continue
        if allowed is not None and forbidden is not None:
            expected = "allowed" if kind in allowed else "forbidden"
            if status != expected:
                bad(f"actions.kinds.{kind}.value={status!r} 与两张清单不一致（按清单应为 {expected}）")


def _optional_status_rules(config: Dict[str, Any]) -> Optional[Dict[str, Dict[str, Any]]]:
    """读 `status_rules.end_of_turn`（2026-09-29 新增；顶层键叫 `status_rules`，**不能**叫 `status` —— 那是配置自身的晋级状态字符串）。

    **缺这一块 = `None`**（legacy / v2 没有这个概念）⇒ 引擎不得改变行为。
    形状由 `_validate_status()` 在加载期把关；这里只做「取出来 + 去引用」，
    不补任何默认值 —— 少一个键就在校验期炸，而不是在这里猜一个数。
    """
    node = _dig(config, "status_rules.end_of_turn")
    if node is _MISSING or node is None:
        return None
    if not isinstance(node, dict):
        raise RuleConfigError("status_rules.end_of_turn 必须是对象")
    out: Dict[str, Dict[str, Any]] = {}
    for name, leaf in node.items():
        if not isinstance(leaf, dict) or not isinstance(leaf.get("value"), dict):
            raise RuleConfigError(f"status_rules.end_of_turn.{name} 必须是 {{value, confidence, reason?}} 形状的对象")
        out[str(name)] = dict(leaf["value"])
    return out


def _validate_status(config: Dict[str, Any], bad) -> None:
    """`status_rules.end_of_turn` 的形状校验（**fail closed**）。

    为什么要单独的校验：这一块是新加的**本地规则**入口（人类 2026-09-29 授权），
    值会一版一版改。形状不严就会把「每层 1%」写成字符串、把 `max_layers` 写成 0，
    然后在对局里静默错算 —— 那是这个仓库最不能接受的一类缺陷。
    """
    node = _dig(config, "status_rules.end_of_turn")
    if node is _MISSING or node is None:
        return
    if not isinstance(node, dict) or not node:
        bad("status_rules.end_of_turn 必须是非空对象（要么整块不写，要么逐个状态写全）")
        return
    note = _dig(config, "status_rules.note")
    if note is _MISSING or not isinstance(note, str) or not note.strip():
        bad("写了 status_rules.end_of_turn 就必须写 status_rules.note（说明这是本地规则、不是原始资料）")
    for name, leaf in node.items():
        where = f"status_rules.end_of_turn.{name}"
        if not isinstance(leaf, dict) or "value" not in leaf:
            bad(f"{where} 必须是 {{value, confidence, reason?}} 形状的对象")
            continue
        value = leaf.get("value")
        if not isinstance(value, dict):
            bad(f"{where}.value 必须是对象")
            continue
        for key in ("base_percent", "per_layer_percent"):
            v = value.get(key)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                bad(f"{where}.value.{key} 必须是 ≥0 的数字（实际 {v!r}）")
        for key in ("max_layers", "duration_turns"):
            v = value.get(key)
            if not isinstance(v, int) or isinstance(v, bool) or v < 1:
                bad(f"{where}.value.{key} 必须是 ≥1 的整数（实际 {v!r}）")
        if not isinstance(value.get("decays"), bool):
            bad(f"{where}.value.decays 必须是布尔（实际 {value.get('decays')!r}）")
        if value.get("decay") not in ("none", "half_ceil", "half_floor"):
            bad(f"{where}.value.decay 必须是 none/half_ceil/half_floor 之一（实际 {value.get('decay')!r}）")
        if value.get("tick_damage_basis") != "max_hp":
            bad(f"{where}.value.tick_damage_basis 目前只支持 max_hp（实际 {value.get('tick_damage_basis')!r}）")
        if value.get("rounding") not in ("floor", "ceil", "round"):
            bad(f"{where}.value.rounding 必须是 floor/ceil/round 之一（实际 {value.get('rounding')!r}）")
        if value.get("decays") is False and value.get("decay") not in (None, "none"):
            bad(f"{where}.value.decays=false 与 decay={value.get('decay')!r} 自相矛盾")


def validate_config(config: Any, ledger: Dict[str, Any], *, expected_id: Optional[str] = None) -> List[str]:
    """校验一份配置，返回问题列表（空 = 合规）。

    抽成**导出的纯函数**是为了让测试能直接对规则本体做反证（构造一份坏配置），
    而不是抄一份实现 —— 抄一份就会漂一份。
    """
    problems: List[str] = []
    if not isinstance(config, dict):
        return ["配置不是一个 JSON 对象"]
    where = config.get("ruleset_config_id") or "（没有 ruleset_config_id）"

    def bad(msg: str) -> None:
        problems.append(f"{where}：{msg}")

    for key in ("schema", "ruleset_config_id", "game", "source_id", "derived_from_ledger_sha256"):
        if not config.get(key):
            bad(f"缺顶层字段 {key}")
    if config.get("schema") != "roco-ruleset-config/v1":
        bad(f"schema 必须是 roco-ruleset-config/v1，实际 {config.get('schema')!r}")
    if expected_id is not None and config.get("ruleset_config_id") != expected_id:
        bad(f"ruleset_config_id 与文件名应当一致（期望 {expected_id}，实际 {config.get('ruleset_config_id')!r}）")
    if not isinstance(config.get("is_default"), bool):
        bad("缺 is_default（哪一份是默认必须机器可读）")

    want_ledger = ledger_sha256()
    if config.get("derived_from_ledger_sha256") != want_ledger:
        bad("derived_from_ledger_sha256 与台账当前指纹不一致 —— 台账改了就必须重新生成配置")

    # 必填字段路径（缺字段 fail closed，而不是用 .get 兜一个默认值）
    for path in REQUIRED_PATHS:
        if _dig(config, path) is _MISSING:
            bad(f"缺字段 {path}")

    # ── RC-105：mana / actions 只有**白名单配置**才必填 ─────────────────────
    #
    # 不做成无条件 REQUIRED_PATHS：legacy 必须逐位不变，而它（以及 v2）里根本没有
    # 「魔力」这条概念。无条件要求 `mana.pool` 只有两个后果 —— 给 legacy 补一个假 0
    # （编规则：0 的意思是「已经判负」），或让默认路径当场加载失败。
    requires_mana_actions = config.get("ruleset_config_id") in MANA_ACTIONS_CONFIG_IDS
    if requires_mana_actions:
        for path in MANA_REQUIRED_PATHS + ACTIONS_REQUIRED_PATHS:
            if _dig(config, path) is _MISSING:
                bad(f"缺字段 {path}（声明了 mana/actions 的配置必须把这两块写全）")
    # RC-401：`damage.multi_hit` 是**可选**能力声明。存在时必须是布尔（不给「看起来
    # 像真」的字符串）；不存在时不校验——legacy 根本没有这一块。
    # C1（第 139 轮）：`damage.slot_condition` / `damage.position_shift` 与 multi_hit 同一套形状规则。
    # RC-401 批次八（2026-09-25）：`damage.initiative_condition`（「若先于敌方攻击」）
    # 与上面三条同一套形状规则。
    for _cap in ("slot_condition", "position_shift", "initiative_condition", "foe_switch_condition",
                 "per_use_ramp", "on_hit_ramp",
                 # task-25 B 族：与上面几条同一套形状规则（缺了它，写错的叶子会静默当 False）
                 "element_use_ramp"):
        node_cap = _dig(config, f"damage.{_cap}")
        if node_cap is _MISSING:
            continue
        if not isinstance(node_cap, dict) or "value" not in node_cap:
            bad(f"damage.{_cap} 必须是 {{value, confidence, reason?}} 形状的对象")
        elif not isinstance(node_cap.get("value"), bool):
            bad(f"damage.{_cap}.value 必须是 true/false（实际 {node_cap.get('value')!r}）")
    node_by_class = _dig(config, "damage.attack_stat_by_class")
    # `_dig` 缺字段返回的是 `_MISSING` 哨兵，不是 None（第一版写成 `is not None`，
    # 于是「没声明」的 legacy 也被判成形状不对 → 加载期直接抛）。
    if node_by_class is not _MISSING:
        if not isinstance(node_by_class, dict) or "value" not in node_by_class:
            bad("damage.attack_stat_by_class 必须是 {value, confidence, reason?} 形状的对象")
        elif not isinstance(node_by_class.get("value"), bool):
            bad(f"damage.attack_stat_by_class.value 必须是 true/false（实际 {node_by_class.get('value')!r}）")
    node_multi = _dig(config, "damage.multi_hit")
    if node_multi is not _MISSING:
        if not isinstance(node_multi, dict) or "value" not in node_multi:
            bad("damage.multi_hit 必须是 {value, confidence, reason?} 形状的对象")
        elif not isinstance(node_multi.get("value"), bool):
            bad(f"damage.multi_hit.value 必须是 true/false（实际 {node_multi.get('value')!r}）")

    _validate_mana(config, bad)
    _validate_actions(config, bad)
    # 2026-09-29：本地规则入口 `status_rules.end_of_turn`（层数/持续回合）的**形状**校验。
    # 语义（百分比怎么算）在引擎里；这里只保证「数值是数值、范围合理、自相矛盾要炸」。
    _validate_status(config, bad)

    # BattleMode 必须是登记表里真实存在的模式；模式规模也以登记表为唯一事实源
    mode_id = _dig(config, "battle_mode.id")
    if mode_id is not _MISSING and mode_id not in _battle_mode_ids():
        bad(f"battle_mode.id={mode_id!r} 不在 BattleMode 登记表里")
    elif mode_id is not _MISSING:
        # RC-106：配置里的模式规模必须与登记表一致 —— 这条判据放在校验器里（生成器与
        # 测试共用那一份），坏值因此根本落不了盘。
        declared = _dig(config, "battle_mode.team_size")
        expected = mode_team_size(str(mode_id)) if isinstance(declared, dict) else None
        if expected is not None and declared.get("value") != expected:
            bad(f"battle_mode.team_size={declared.get('value')!r} 与 BattleMode 登记表里 "
                f"{mode_id} 的 parameters.team_size={expected} 不一致 —— 模式规模只有一个"
                "事实源（登记表），配置必须跟着它生成")

    # 逐叶子核对台账引用
    index = _ledger_index(ledger)
    leaves = _iter_leaves(config)
    if not leaves:
        bad("一个带 confidence 的字段都没有 —— 那这份配置就没法审计")
    #: `FROZEN_BIT_EXACT_BASELINE` 是唯一的例外：它存在的全部意义就是「与当前引擎逐位相同」，
    #: 所以它引用的台账条目即使写着「待实机验证」，值也必须是当时引擎里那个数。
    frozen_baseline = config.get("promotion_policy") == "FROZEN_BIT_EXACT_BASELINE"
    if config.get("promotion_policy") not in ("FROZEN_BIT_EXACT_BASELINE", "BLOCKED_UNTIL_MICROCASE"):
        bad(f"promotion_policy 必须是 FROZEN_BIT_EXACT_BASELINE 或 BLOCKED_UNTIL_MICROCASE，"
            f"实际 {config.get('promotion_policy')!r}")
    for path, leaf in leaves:
        confidence = leaf.get("confidence")
        evidence_id = leaf.get("evidence_id")
        role = leaf.get("evidence_role")
        if confidence not in CONFIDENCE_LEVELS:
            bad(f"{path}：confidence={confidence!r} 不在台账允许的等级里")
        if evidence_id in (None, ""):
            if role not in (None, ""):
                bad(f"{path}：没有 evidence_id 却有 evidence_role={role!r}")
            if confidence not in ("ENGINE_HYPOTHESIS", "UNKNOWN"):
                bad(f"{path}：confidence={confidence} 却没有 evidence_id")
            if not leaf.get("reason"):
                bad(f"{path}：没有 evidence_id 时必须有 reason")
        else:
            if role not in EVIDENCE_ROLES:
                bad(f"{path}：有 evidence_id 时 evidence_role 必须是 {EVIDENCE_ROLES} 之一，实际 {role!r}")
            entry = index.get(evidence_id)
            if entry is None:
                bad(f"{path}：evidence_id={evidence_id} 不在台账里")
            elif role == "supports" and entry.get("confidence") != confidence:
                bad(f"{path}：confidence={confidence} 与台账 {evidence_id}={entry.get('confidence')} 不一致"
                    "（不许静默升降级）")
            if role == "refutes" and not leaf.get("reason"):
                bad(f"{path}：把台账条目当反证用时必须写 reason")
            # 台账说「这条要实机 microcase」时：引它的字段必须把待录 case 带出来；
            # 带具体值时只能是 candidate 假设（`value_status: CANDIDATE_HYPOTHESIS`）。
            if not frozen_baseline and entry and entry.get("needs_microcase") and role == "supports":
                if not leaf.get("microcase_id"):
                    bad(f"{path}：引用了待验条目 {evidence_id}，却没有 microcase_id")
                value_is_concrete = leaf.get("value") not in (None, "unknown")
                if value_is_concrete and leaf.get("value_status") != "CANDIDATE_HYPOTHESIS":
                    bad(f"{path}：{evidence_id} 还没有实机 microcase"
                        f"（{entry.get('microcase_id') or '未登记'}），带具体值时必须标"
                        f" value_status=CANDIDATE_HYPOTHESIS，实际 {leaf.get('value_status')!r}")
        if confidence == "UNKNOWN" and leaf.get("value") not in (None, "unknown"):
            bad(f"{path}：confidence=UNKNOWN 时 value 必须是 null 或 \"unknown\"，"
                f"实际 {leaf.get('value')!r}")
        if leaf.get("value_status") == "CANDIDATE_HYPOTHESIS" and frozen_baseline:
            bad(f"{path}：冻结的逐位基线不该出现「候选假设」这种状态")

    # 数值字段的取值域（叶子路径直接是字段记录，分支路径要先取出 value）
    for path in ("energy.max", "energy.regen.per_turn"):
        node = _dig(config, path)
        if node is _MISSING or not isinstance(node, dict):
            continue
        inner = node["value"] if "value" in node else None
        if inner is None:
            bad(f"{path} 不是字段记录（缺 value）")
        elif not isinstance(inner, int) or isinstance(inner, bool) or inner < 0:
            bad(f"{path} 必须是 >= 0 的整数，实际 {inner!r}")
    initial = _dig(config, "energy.initial")
    if initial is not _MISSING and isinstance(initial, dict) and "value" in initial:
        inner = initial["value"]
        if inner is not None and (not isinstance(inner, int) or isinstance(inner, bool) or inner < 0):
            bad(f"energy.initial 必须是 >= 0 的整数或 null（未知），实际 {inner!r}")

    # ── turn_order（RC-103）：顺序登记表只判**形状**与**合法取值** ──────────
    #
    # 「这个阶段引擎实不实现得了」是引擎侧的事（`env.py` 遇到未声明/未实现阶段会抛
    # `UnsupportedEffect`）—— 两处判据各管一段，谁也不替谁兜底：这里管「配置是不是
    # 一份合法可读的登记表」，引擎管「我能不能按它跑」。
    for path in ("turn_order.action_order", "turn_order.end_turn.order"):
        node = _dig(config, path)
        if node is _MISSING:
            continue                      # 缺字段已经由 REQUIRED_PATHS 报过，别报两遍
        if not isinstance(node, dict) or "value" not in node:
            bad(f"{path} 不是带 value 的字段记录")
            continue
        seq = node["value"]
        if not isinstance(seq, list) or not seq:
            bad(f"{path} 必须是非空数组（顺序本身就是它的内容），实际 {seq!r}")
            continue
        if any(not isinstance(x, str) or not x for x in seq):
            bad(f"{path} 的元素必须是非空字符串，实际 {seq!r}")
            continue
        if len(set(seq)) != len(seq):
            bad(f"{path} 里有重复项（同一个阶段不许声明两次）：{seq!r}")

    tie_node = _dig(config, "turn_order.speed_tie")
    if tie_node is not _MISSING:
        if not isinstance(tie_node, dict) or "value" not in tie_node:
            bad("turn_order.speed_tie 不是带 value 的字段记录")
        else:
            tie = tie_node["value"]
            if tie not in (None, "unknown") and tie not in SPEED_TIE_POLICIES:
                bad(f"turn_order.speed_tie 只允许 {SPEED_TIE_POLICIES} 或 null（UNKNOWN），实际 {tie!r}"
                    "—— 平手裁决没有任何实机证据（MC-E05），不许填一个「看起来合理」的策略")

    stages_node = _dig(config, "turn_order.end_turn.unknown_stages_allowed")
    if stages_node is not _MISSING:
        if not isinstance(stages_node, dict) or "value" not in stages_node:
            bad("turn_order.end_turn.unknown_stages_allowed 不是带 value 的字段记录")
        else:
            allowed = stages_node["value"]
            if not isinstance(allowed, bool):
                bad(f"turn_order.end_turn.unknown_stages_allowed 必须是布尔，实际 {allowed!r}")
            elif allowed:
                bad("turn_order.end_turn.unknown_stages_allowed=true 不被本引擎支持："
                    "那等于允许回合末存在未声明阶段，与「不知道就先抛」直接冲突")

    for item in config.get("unknowns", []) or []:
        if not isinstance(item, dict) or not item.get("path") or not item.get("reason"):
            bad(f"unknowns 条目必须有 path 与 reason，实际 {item!r}")

    # ── policies.weather_policy（2026-09-25）：只判**形状与合法取值** ──────────
    #
    # 「引擎能不能按它结算」由引擎那一侧判（`env.py` 遇到没声明的天气抛
    # `UnsupportedEffect`）；这里管「这份声明是不是一份合法可读的登记」。
    # **缺整块 = 合法**（legacy / v2 没有天气层），只是引擎会 fail closed。
    weather = _dig(config, "policies.weather_policy")
    if weather is not _MISSING and weather is not None:
        if not isinstance(weather, dict):
            bad(f"policies.weather_policy 必须是对象 / null，实际 {type(weather).__name__}")
        else:
            if weather.get("value") != "enabled":
                bad(f"policies.weather_policy.value 只允许 'enabled'，实际 {weather.get('value')!r}"
                    "（要关掉天气层就整块不声明，而不是写一个别的取值）")
            if weather.get("max_concurrent") != 1:
                bad("policies.weather_policy.max_concurrent 必须是 1"
                    "（官方逐字「但天气只能存在一种」）")
            duration = weather.get("duration_turns")
            if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
                bad(f"policies.weather_policy.duration_turns 必须是正整数，实际 {duration!r}")
            effects = weather.get("effects")
            if not isinstance(effects, dict) or not effects:
                bad("policies.weather_policy.effects 必须是非空对象（四种天气各自的结算口径）")
            else:
                for name, spec in effects.items():
                    if not isinstance(spec, dict) or not spec.get("kind"):
                        bad(f"policies.weather_policy.effects[{name!r}] 必须带 kind，实际 {spec!r}")
                        continue
                    kind = spec.get("kind")
                    if kind == "end_turn_status":
                        if not spec.get("status") or not spec.get("immune_element"):
                            bad(f"天气「{name}」的 end_turn_status 必须声明 status 与 immune_element")
                        layers = spec.get("layers")
                        if not isinstance(layers, int) or isinstance(layers, bool) or layers <= 0:
                            bad(f"天气「{name}」的 layers 必须是正整数，实际 {layers!r}")
                    elif kind in ("skill_power_multiplier", "skill_energy_cost_multiplier"):
                        if not spec.get("element") or not isinstance(spec.get("value"), (int, float)):
                            bad(f"天气「{name}」必须声明 element 与数值 value，实际 {spec!r}")
                    else:
                        bad(f"天气「{name}」的 kind={kind!r} 不是本引擎认识的取值"
                            "（skill_power_multiplier / skill_energy_cost_multiplier / end_turn_status）")
            for item in weather.get("unknowns") or []:
                if not isinstance(item, dict) or item.get("value") is not None \
                        or item.get("status") != "UNVERIFIED" or not item.get("why"):
                    bad("policies.weather_policy.unknowns 的每一条都必须 "
                        f"value=null + status=UNVERIFIED + why，实际 {item!r}")
    return problems


# ── 加载 ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RuleConfig:
    """一份已校验的规则配置（加载即校验，之后只读）。"""

    ruleset_config_id: str
    is_default: bool
    schema: str
    game: str
    source_id: str
    derived_from_ledger_sha256: str
    status: str
    battle_mode_id: str
    #: RC-106：这个模式**每方上场的精灵数**（生成器从 `battle-modes.json` 抄进来）。
    #: 于是「引擎按几宠开局」是**模式参数**：v3 / `pvp-standard-six-pet` ⇒ 6，
    #: `legacy_sim_v1` / `demo-training-3v3` ⇒ 3。`None` = 配置没声明（不该发生）。
    battle_mode_team_size: Optional[int]
    energy_max: int
    energy_regen_per_turn: int
    #: `None` = **未知**（不是 0）。要用的调用方必须显式处理。
    energy_initial: Optional[int]
    energy_charge: Optional[int]
    #: RC-401：是否按描述里的「N 连击」结算伤害（`damage.multi_hit`）。
    #: **没声明就是 False** —— legacy / v2 里这条概念不存在，行为逐位不变。
    damage_multi_hit: bool
    #: 2026-09-23：**开局能量发给每一只精灵**（`energy.initial_for_all_pets`），还是只发给场上那只。
    #: 人类口径：每只精灵的能量（星）是**独立**的、开局都是满的 10 星。
    #: **没声明就是 False** —— legacy / v2 保持「只给场上那只」，golden 指纹逐位不变。
    energy_initial_for_all_pets: bool
    #: RC-401 批三（2026-09-23）：**技能能耗修正**（`energy.cost_modifier`）。
    #: 声明为真时：合法动作的可付性判定与出手扣费都按「基础能耗 + 该精灵身上的修正」算，
    #: 修正来源是特性（捉迷藏 / 抓到你了 / 聒噪…）。**没声明就是 False** ——
    #: legacy / v2 里没有这条机制，动作与扣费逐位不变（术语 1012/1013 只说能耗会增减，
    #: 复合顺序与下限是 MC-018 待验项，所以本机制只在候选配置里开着）。
    energy_cost_modifier: bool
    #: RC-401 批次九（2026-09-25）：**动态能耗修正**（`energy.per_layer_cost`）——
    #: 「敌方每有 N 层中毒效果，本技能能耗 -M」。**没声明就是 False**：legacy / v2 里这段文本
    #: 继续按"未认领机制"登记，可付性与扣费一个字都不变。
    energy_per_layer_cost: bool
    #: RC-401 批次六（2026-09-25）：**「敌方失去 N 能量」**（`energy.foe_energy_loss`）。
    #: 声明为真时，`parse.py` 读出的 `foe_energy_loss` / `foe_team_energy_loss` 会被结算
    #: （对手场上那只 / 全队逐只扣，**没有任何一方获得** —— 与「偷取」严格分开）。
    #: **没声明就是 False** —— 效果在解析层就被收回（连未认领标记都不补），
    #: legacy / v2 的 `unsupported` 与结算逐位不变。
    energy_foe_energy_loss: bool
    #: RC-401 批次十四（2026-09-29 task-20）：**「应对X：改为…」的覆盖语义**
    #: （`energy.respond_override`）。声明为真时，`parse.resolve_respond_override()`
    #: 会把「改为**获得N层**」读成"替换被覆盖那条基础效果的层数"，由 `env` 在**应对成功**
    #: 那一支落地（状态支 / 防御支 / 攻击支三处）。**没声明就是 False** —— legacy / v2 里
    #: 这一段继续什么都不产出（连结构都没有）⇒ `unsupported`、`unclaimed` 与判据逐位不变。
    energy_respond_override: bool
    #: RC-401 批次十六（2026-09-29 task-20 批四）：**「敌方每有 N 层<中毒效果|印记|星陨印记>，
    #: 本次技能威力/连击数 +M」**（`damage.per_layer_boost`）。声明为真时，这一手的
    #: 威力/连击入参按**对手场上那只的当前层数**加成（读法是"当前层数"，不是历史累计）。
    #: **没声明就是 False** —— legacy / v2 里那一段继续算未认领机制，结算逐位不变。
    damage_per_layer_boost: bool
    #: 2026-09-23：**伤害按技能的伤害类别取面板**（`damage.attack_stat_by_class`）。
    #: 声明为真时：`魔攻` 类技能用 `spa/spd` 结算、其余用 `atk/def`；
    #: **没声明就是 False** —— legacy / v2 里这条概念不存在，结算逐位不变
    #: （它们继续用 `atk/def`；`test_turn_order_fail_closed` 的 golden 指纹就是这条的守卫）。
    damage_attack_stat_by_class: bool
    #: C1（第 139 轮）：号位条件 / 传动（`damage.slot_condition` / `damage.position_shift`）。
    damage_slot_condition: bool
    damage_position_shift: bool
    #: RC-401 批次八：「若先于敌方攻击，本次技能威力+N%」（冻结语料 1 条战斗技能 + 2 条特性）。
    #: **没声明就是 False** —— legacy / v2 里那段文本继续按"未认领机制"登记，一个字节不变。
    damage_initiative_condition: bool
    #: RC-401 批次十一：「**若敌方本回合更换精灵**，<效果>」（12 条技能 / 46 只精灵带得上）。
    #: 同样是"没声明就是 False"：legacy / v2 里那一段继续算未认领机制。
    damage_foe_switch_condition: bool
    #: RC-401 批次十二：「**每次使用后，本技能<威力|能耗|连击数>永久±N**」（7 条技能 / 25 只带 `水炮`）。
    #: 没声明就是 False：legacy / v2 里那一段继续算未认领机制，`PetState.skill_ramps` 也不会被写。
    damage_per_use_ramp: bool
    #: task-25 B 族（2026-09-30）：**「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，
    #: 本技能<属性>永久±N」**（3 条技能：`270 蓄能轰击` · `343 光能聚集` · `450 过曝`）。
    #: 与 `damage_per_use_ramp` / `damage_triggered_ramp` **同一套写点**（`PetState.skill_ramps`）——
    #: 本批只加**触发器**（数"别的技能用了几次"，落在 `PetState.skill_use_elems`）。
    #: 没声明就是 False：legacy / v2 里那几段继续算未认领机制，`skill_ramps`/`skill_use_elems` 都不会被写。
    damage_element_use_ramp: bool
    #: task-26 P0（2026-09-30）：**驱散按 `what` 分派**的开关。
    #: 没声明（legacy / v2）⇒ 走**原来那一支**（逐字不变 ⇒ golden 指纹守住 ✓）；
    #: 声明了 ⇒ 「增益/减益」按**符号**清，**认不出的 `what` fail closed**（不执行 + 如实登记 ✓）。
    #: RC-401 批次十八（2026-09-30 **E 族缺口二** `446 清洗`）：「**自己**每有 N 层减益，本技能能耗 -M」。
    #: ⚠ **命名空间必须是 `damage.*`，不能是 `energy.*`** ✗ —— 判据
    #: `test_v3_energy_and_turn_order_are_verbatim_copies_of_v2` 要求 **v3 的 `energy:` 块与 v2 逐字相同**
    #: ⇒ 在 `energy.*` 下新开位会被判据禁止（2026-09-30 实测踩到 ✓）。照 `damage.cleanse_dispatch` 等先例 ✓。
    damage_per_own_debuff_cost: bool
    damage_cleanse_dispatch: bool
    #: task-27（2026-09-30）：**印记的驱散**（`damage.cleanse_marks`）。
    #: 与 `damage_cleanse_dispatch`（增益/减益，清 `buffs` 键名）**分开**：印记有**层数**维度
    #: （`marks = {"星陨印记": 3}`），两个量纲混在一起必然出错。
    #: **没声明就连结构都不产出**（`resolve_cleanse_marks(declared=False)` 什么都不加）⇒
    #: legacy / v2 的 `state.unsupported` 与 golden 指纹逐位不变。
    damage_cleanse_marks: bool
    #: RC-401 批次十七（2026-09-30 task-26 H 族批一）：**「每应对成功1次 / 应对X：…本技能<属性>永久±N」**
    #: 与「**每次击败敌方，本技能<属性>永久±N**」（6 条技能）。与 `damage_per_use_ramp` /
    #: `damage_on_hit_ramp` **同一套写点**（`PetState.skill_ramps`），本批只加**触发器**。
    #: 没声明就是 False：legacy / v2 里那几段继续算未认领机制，`skill_ramps` 也不会被写。
    damage_triggered_ramp: bool
    #: task-28（2026-09-30 · 427 并集 D 族余项）：**「应对X：减免的伤害变为回复自己生命」**
    #: （实测 `skill_000289 无畏之心`）。语义：**被减伤挡下来的那部分**转成回复 ✓，
    #: 穿过去的那点残余伤害照旧结算 ✓（289 减伤 100% 时仍有 1 的下限伤害）。
    #: 数值口径 = `DamageOutcome.raw − DamageOutcome.damage`（两个量在 `effects.py` 现成 ✓，
    #: **不新增伤害管线、不在这里猜比例** ✓）。
    #: 没声明就是 False ⇒ `resolve_respond_reduction_to_heal(declared=False)` **什么都不产出**，
    #: legacy / v2 的 `unsupported` 与 golden 指纹逐位不变 ✓。
    damage_respond_reduction_to_heal: bool
    #: task-28（2026-09-30 · D 族 `462 放晴`）：**「<系>技能威力永久±N%」**。
    #: 写进 `PetState.element_power_mods`（系别 → 百分比），读点在 `effects.compute_damage`
    #: （按 `skill.element` 取 ✓ **已就绪**，本批只补**写入方**）。
    #: 「应对防御：改为永久+100%」是它的**覆盖体** ⇒ 走 `energy.respond_override` 那条链替换 ✓
    #: （`mode="element_power"`：应对成功时**基础那条被摘掉**、只留改为值 ⇒ 不是相加 ✓）。
    #: 没声明就是 False ⇒ `resolve_element_power_ramp(declared=False)` **连 effect 都不产出** ⇒
    #: legacy / v2 的 `unsupported` 与 golden 指纹逐位不变 ✓。
    damage_element_power_ramp: bool
    #: task-28（H 族 `285 退化`）：**「萌化」= 带层数的标记**（写 `PetState.marks` ✓ 复用现成字段 ✗ 不新造）。
    #: 语料逐字依据：`285`/`732` 写「**1层**萌化」⇒ 带层数 ✓；10 条里没有一条让萌化自己造成效果 ✓
    #: ⇒ 它**不进** `END_OF_TURN_STATUS`（进了就是凭空 tick ⇒ 假绿 ✗，与 `冻结` 同型的坑 ✓）。
    #: 没声明就是 False ⇒ `env` 那条路由**一个字都不写** ⇒ legacy / v2 逐位不变 ✓。
    damage_moe_mark: bool
    #: task-28（第 2 批 `717 超级糖果`）：**本手无条件平值威力**「本次技能威力+N」。
    #: 语义 = `skill.power += N`（与 `foe_switch_power_flat` **同一手法** ✓ 不动伤害公式 ✓）。
    #: ⚠ 与"**全技能**威力永久"（`721`/`728`）**作用域不同** ✗：那个是持久、这是本手 ✓
    #: 未声明 ⇒ resolver **整条不产出** ⇒ legacy / v2 逐位不变 ✓。
    damage_self_power_flat: bool
    #: task-28（第 2 批 `724 破罐破摔`）：**「（自己）有减益时，本次技能威力+N」的条件门**。
    #: **加成那半复用 `damage.self_power_flat`** ✓（同一个 kind `self_power_flat` ✓）；本叶子只管**条件** ✓。
    #: **"减益"口径**（Lead 裁决 ✓）：只算 `buffs`/`buffs_flat` 的**负值** ✓；**状态层数不算** ✓（算进来=发明语义 ✗）。
    #: 未声明 ⇒ resolver **整条不产出** ⇒ legacy / v2 逐位不变 ✓。
    damage_cond_self_debuff_power: bool
    #: task-28（H 族 `721`/`728`）：**"全技能"级持久修正**（写 `PetState.global_skill_mods` ✓）。
    #: 覆盖两条：`721`「全技能**能耗**永久-2」· `728`「全技能**威力**永久+10」✓（**一个字段两个方向** ✓）。
    #: ⚠ **作用域 = 所有技能** ✗ —— 与 `skill_ramps`（逐技能 ✗）/`buffs`（属性 ✗）/`element_power_mods`（按系别 ✗）都不同 ✓。
    #: ⚠ **能耗下界口径**（Lead 2026-09-30 裁决 ✓）：**能减多少减多少、但不为负** ⇒ `max(0, base+delta)` ✓
    #:   ⇒ **不改 MC-018 的既有守卫** ✗ · **改点**：若人类改判 ⇒ 只改 `env.effective_skill_cost` 那一处 ✓。
    #: ⚠ **产品后果（如实登记 ✓ 不藏在代码里）**：全库 **140 条能耗 ≤1 的技能**（**427 并集内 104 条**）
    #:   在本叶子声明后会变成 **cost 0** ✓（"全技能-2"照字面的必然结果 ✓ 不是 bug ✓）。
    #: 未声明 ⇒ resolver **整条不产出** ⇒ legacy / v2 逐位不变 ✓。
    damage_global_skill_mods: bool
    #: **没声明 ⇒ `resolve_global_skill_mod(declared=False)` 什么都不产出** ⇒ legacy 逐位不变 ✓。
    #: RC-401 批次十三：「**每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N**」
    #: （3 条技能 / 37 只带得上，含 `skill_000500 岩土暴击` 的 35 只）。
    damage_on_hit_ramp: bool
    #: 2026-09-29（task-25，A 族「获得 属性±N」的**读点**，`stat_gain.speed_buff`）：
    #: **「自己获得速度±N%」进先手速度**。在此之前 `env.order_speed()` **完全不读 `pet.buffs`**
    #: ⇒ 「自己获得速度+30」发出 `buff_self{stat:"spe"}` 事件、判据判 `resolved=True`，
    #: 但先手顺序一点不变（**假绿**：事件发了、没人读）。声明为真后 ×`(1 + buffs["spe"]/100)`，
    #: 并在 `turn_start.speed_provenance` 登记 `speed_buff_pct`。术语 1020 没写这个折法
    #: ⇒ 乘算是**引擎假设**（evidence_id 留空）。**没声明**（legacy / v2）⇒ 逐位不变。
    stat_gain_speed_buff: bool
    #: 2026-09-29（task-25，A 族「获得 属性±N」的**解析形状**，`stat_gain.extended_shapes`）：
    #: 从「`自己`获得`单/双属性``+`N`%`」放宽到数据里真实出现的：主语可为 `敌方`（⇒ `foe_stat`）、
    #: 符号可为 `-`、`自己` 可省（「并获得魔攻+70%」）、`和` 复合与 `额外` 前缀；另含
    #: `全技能威力`（`buffs["power"]` **已有读点**；原文一律不带 `%`，读点按 `+N` = `+N%` 解）。
    #: **只补无条件形状** —— 落在「若/选择/应对/期间/每/或」条件句里的仍如实报未结算。
    #: **没声明就是 False** ⇒ 解析层连这些效果都不产出，`unsupported` 与判据逐位不变。
    stat_gain_extended: bool
    #: 2026-09-29（task-25，A 族）：**平值属性修正**（`stat_gain.flat`）—— 解析**与读点同一把开关**。
    #: 声明为真时「（自己|敌方）获得<属性>±N」（**不带 `%`**）读成 `self_stat_flat` /
    #: `foe_stat_flat` ⇒ 写进 `PetState.buffs_flat`（面板量纲），由 `env.order_speed()` **真的读**
    #: （+N 点加到先手速度上；全库实测平值只出现在速度上，14 处）。
    #: ⚠ 解析与读点**共用一位**（不像 `speed_buff` 拆两个）：拆开就能合法造出「解析开了、
    #: 读点没开」的假绿配置；合成一位后「声明了就有读点」是**结构上成立**的，不靠人记得。
    #: 原始资料没有「平值如何进面板」的口径 ⇒ 加法是**本地规则**。**没声明** ⇒ 逐位不变。
    stat_gain_flat: bool
    #: 2026-09-29（第三轮⑥「还没做出来的机制叫你队友做」）：**回合末持续状态的显式本地规则**。
    #:
    #: 形状：`{状态名: {"base_percent": float, "per_layer_percent": float, "max_layers": int,
    #: "duration_turns": int, "decays": bool, "decay": "none"|"half_ceil"|"half_floor",
    #: "tick_damage_basis": "max_hp", "rounding": "floor"|"ceil"|"round", "source": str}}`。
    #:
    #: **缺字段 = `None` = 这份配置没有声明层数/持续回合**（legacy / v2）⇒ 引擎回到
    #: `effects.END_OF_TURN_STATUS` 的老口径（固定百分比、层数只影响衰减、无持续回合），
    #: 逐位不变。声明了的配置（v3）才走「基础% + 每层% × (层数−1)」与持续回合终止条件。
    #:
    #: 为什么放在规则配置里而不是写死在引擎：这些数字**不是真游戏数据**（人类 2026-09-29 逐字
    #: 「所有不冲突规则都列为引擎有效规则」「我本身就是个模拟，不需要那么严谨」），
    #: 必须与冻结资料区分开、可审计、一版一版可改；写死就变成第二个真相。
    status_end_of_turn: Optional[Dict[str, Dict[str, Any]]]
    #: 行动排序的**声明维度**（RC-103）。legacy 是引擎现状（respond/priority/speed）；
    #: candidate 声明的是社区口径的总序（respond/switch/priority/speed），引擎只实现了其中一部分。
    action_order: Tuple[str, ...]
    #: 同速平手策略（RC-103）。`None` = UNKNOWN：引擎必须抛错，不许用随机数假装知道规则。
    speed_tie: Optional[str]
    #: 平手策略卡在哪条 microcase 上（错误信息里要点名，救命用）。
    speed_tie_microcase_id: Optional[str]
    end_turn_order: Tuple[str, ...]
    #: 配置是否允许回合末存在**未声明**的阶段。`True` 会被加载期拒掉；引擎再兜一层。
    end_turn_unknown_stages_allowed: bool
    # ── RC-105：魔力（心）与合法动作裁剪 ──────────────────────────────────
    #
    # legacy / v2 里这七个数全是 `None` —— **不是 0、也不是空列表**：`None` 的意思是
    # 「这份配置没有声明这个概念」，那一刻不该出现 mana 字段、也不该裁剪任何动作类。
    #: 每方开局的魔力（心）。`None` = 本配置没有魔力系统。
    mana_pool: Optional[int]
    #: 某方精灵力竭时该方扣多少魔力。
    mana_faint_cost: Optional[int]
    #: 魔力 ≤ 0 是否**立即**判负（另一方胜）。
    mana_loss_when_zero: Optional[bool]
    #: 本候选是否把「投降」当成一个合法动作类。
    mana_surrender: Optional[bool]
    #: 合法动作的**声明清单**（顺序 = 展示顺序）。`None` = 不裁剪（legacy 行为）。
    allowed_kinds: Optional[Tuple[str, ...]]
    #: 一律不得出现在合法动作里的动作类。
    forbidden_kinds: Tuple[str, ...]
    #: `False` 时，产出未在 `allowed_kinds` 里声明的动作类必须**抛错**，不许静默放过。
    unknown_kinds_allowed: Optional[bool]
    #: 「PVP 魔法 / 背包物品是否占一次行动」（人类 2026-09-25）。`False` = 声明了**不占行动**
    #: ⇒ `env.step_free()` 才收自由动作；`True` = 旧口径「占一手」；`None` = 没声明/未核验
    #: ⇒ **fail closed**。读 `policies.magic_policy.occupies_action`（生成器从登记表照抄）。
    magic_occupies_action: Optional[bool] = None
    #: 上面那条取值的证据等级，只用于诊断与报告。
    magic_occupies_action_status: Optional[str] = None
    #: 2026-09-25（人类裁决「那你就做！」）：**天气层**。
    #:
    #: `None` = **这份配置没有声明天气层**（legacy / v2）⇒ 引擎**不许**自己发明天气行为：
    #: 技能里的「将天气改为…」照旧登记成 unsupported，回合末也不结算任何天气效果。
    #: 声明时是 `policies.weather_policy` 的**整份**（四种天气的效果 / 数值 / 免疫属性 /
    #: 只存在一种 / 持续回合数 / 仍未核验的那几条）—— 由生成器从 `battle-modes.json` 照抄，
    #: 所以「天气有哪些、各是多少」只有登记表一个事实源。
    weather_policy: Optional[Dict[str, Any]] = None
    path: str = ""
    raw: Dict[str, Any] = dc_field(repr=False, default_factory=dict)

    @property
    def weather_enabled(self) -> bool:
        """这份配置是否**声明**了天气层（不是「现在场上有天气」）。"""
        return (isinstance(self.weather_policy, dict)
                and self.weather_policy.get("value") == "enabled")

    def weather_effect(self, name: str) -> Optional[Dict[str, Any]]:
        """某个天气声明的效果；**没声明就是 None**（调用方必须 fail closed）。

        注意：这里只回答「配置怎么说」。天气名不在声明表里（例如自造的「晴天」）
        与「没声明天气层」是两件事，但对调用方而言都只能是「不可结算」。
        """
        if not self.weather_enabled:
            return None
        effects = self.weather_policy.get("effects")
        spec = effects.get(name) if isinstance(effects, dict) else None
        return dict(spec) if isinstance(spec, dict) else None

    def require_weather_effect(self, name: str) -> Dict[str, Any]:
        """拿某个天气的效果；**没声明就抛**，绝不回落到一个默认效果。"""
        spec = self.weather_effect(name)
        if spec is None:
            raise RuleConfigError(
                f"规则配置 {self.ruleset_config_id} 没有声明天气「{name}」的结算口径"
                f"（policies.weather_policy{' 未声明' if not self.weather_enabled else ' 里没有这一条'}）"
                "—— 引擎不发明天气行为（fail closed）"
            )
        return spec

    @property
    def has_mana(self) -> bool:
        """这份配置是否声明了魔力系统（看原始 JSON 里有没有 `mana` 块）。

        不用 `mana_pool is not None` 判断：`pool` 本身可以是 UNKNOWN(null)，
        「声明了 mana 但值未知」与「没有 mana 这个概念」必须能分辨。
        """
        return isinstance(self.raw.get("mana"), dict)

    @property
    def has_actions(self) -> bool:
        """这份配置是否声明了合法动作裁剪（看原始 JSON 里有没有 `actions` 块）。"""
        return isinstance(self.raw.get("actions"), dict)

    @property
    def requires_microcase_before_default(self) -> bool:
        return bool(self.raw.get("requires_microcase_before_default", False))

    @property
    def unknowns(self) -> List[Dict[str, Any]]:
        return list(self.raw.get("unknowns", []) or [])

    def energy_leaf(self, path: str) -> Dict[str, Any]:
        """取某个能量字段的完整记录（值 + 置信 + 台账引用）。"""
        node = _dig(self.raw, path)
        if not isinstance(node, dict) or "value" not in node:
            raise RuleConfigError(f"规则配置 {self.ruleset_config_id} 的 {path} 不是字段记录")
        return dict(node)

    def require_energy_initial(self) -> int:
        """拿入场初始能量；**未知就抛错**，绝不回落到 legacy 的 2。

        一个「看起来合理的数」比一个错误更坏：它会让 candidate 看起来已经被验证过。
        """
        if self.energy_initial is None:
            reason = next((u.get("reason") for u in self.unknowns if u.get("path") == "energy.initial"), None)
            micro = next((u.get("microcase_id") for u in self.unknowns if u.get("path") == "energy.initial"), None)
            raise RuleConfigError(
                f"规则配置 {self.ruleset_config_id} 的 energy.initial 是 UNKNOWN"
                f"（{reason or '无 reason'}；待录 microcase {micro or '未登记'}）——"
                "不许用 legacy 的值代替"
            )
        return self.energy_initial

    def require_team_size(self) -> int:
        """这个模式每方上场几只（RC-106）：来自配置的 `battle_mode.team_size`。

        缺失或非正整数一律抛错 —— 「这个模式打几 v 几」不能靠猜，否则标准 PVP 会被
        静默地按训练场的 3v3 跑（那正是 RC-106 要修的阻断③）。
        """
        value = self.battle_mode_team_size
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise RuleConfigError(
                f"规则配置 {self.ruleset_config_id} 的 battle_mode.team_size 不是正整数"
                f"（实际 {value!r}）—— 引擎不能靠猜「这个模式打几 v 几」"
            )
        return value

    def require_speed_tie(self) -> str:
        """拿同速平手策略；**UNKNOWN 就抛错**，绝不回落到随机数。

        与 `require_energy_initial()` 同一条纪律：一个「看起来合理」的策略比一个错误更坏 ——
        它会让「用随机数决定的先后」看起来像一条已被验证的规则（10 号文档 §8 明确 speed tie = UNKNOWN）。
        """
        if self.speed_tie is None or self.speed_tie == "unknown":
            raise RuleConfigError(
                f"规则配置 {self.ruleset_config_id} 的 turn_order.speed_tie 是 UNKNOWN"
                f"（待录 microcase {self.speed_tie_microcase_id or '未登记'}）——"
                "同速平手判据没有实机证据，引擎不许用随机数假装知道规则"
            )
        return self.speed_tie

    def fingerprint(self) -> str:
        """配置内容的 sha256（供报告与 replay 绑定用）。"""
        payload = json.dumps(self.raw, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()


def load_config(ruleset_config_id: str) -> RuleConfig:
    """加载并校验一份配置；任何问题都抛 `RuleConfigError`（fail closed）。"""
    if not isinstance(ruleset_config_id, str) or not ruleset_config_id:
        raise RuleConfigError(f"没有给出规则配置 id（{ruleset_config_id!r}）")
    path = config_path(ruleset_config_id)
    if not os.path.exists(path):
        raise RuleConfigError(
            f"未知的规则配置 id：{ruleset_config_id!r}（找不到 {os.path.relpath(path, _repo_root())}）"
        )
    try:
        with open(path, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except ValueError as exc:
        raise RuleConfigError(f"规则配置不是合法 JSON（{ruleset_config_id}）：{exc}") from exc
    except OSError as exc:
        raise RuleConfigError(f"读不到规则配置 {ruleset_config_id}：{exc}") from exc

    problems = validate_config(config, _load_ledger(), expected_id=ruleset_config_id)
    if problems:
        raise RuleConfigError("规则配置不合规：\n  - " + "\n  - ".join(problems))

    end_turn = _leaf_value(config, "turn_order.end_turn.order")
    if not isinstance(end_turn, list) or not end_turn:
        raise RuleConfigError(f"规则配置 {ruleset_config_id} 的 turn_order.end_turn.order 必须是非空数组")

    action_order = _leaf_value(config, "turn_order.action_order")
    if not isinstance(action_order, list) or not action_order:
        raise RuleConfigError(f"规则配置 {ruleset_config_id} 的 turn_order.action_order 必须是非空数组")

    speed_tie = _leaf_value(config, "turn_order.speed_tie")
    if speed_tie not in (None, "unknown") and speed_tie not in SPEED_TIE_POLICIES:
        raise RuleConfigError(
            f"规则配置 {ruleset_config_id} 的 turn_order.speed_tie={speed_tie!r} 不是已知策略"
            f"（允许 {SPEED_TIE_POLICIES} 或 null）—— 不许用随机数假装知道规则"
        )
    tie_microcase = None
    tie_leaf = _dig(config, "turn_order.speed_tie")
    if isinstance(tie_leaf, dict):
        tie_microcase = tie_leaf.get("microcase_id") or None
    if not tie_microcase:
        tie_microcase = next(
            (u.get("microcase_id") for u in config.get("unknowns", []) or []
             if u.get("path") == "turn_order.speed_tie"), None)

    allowed_unknown_stages = _leaf_value(config, "turn_order.end_turn.unknown_stages_allowed")
    if not isinstance(allowed_unknown_stages, bool):
        raise RuleConfigError(
            f"规则配置 {ruleset_config_id} 的 turn_order.end_turn.unknown_stages_allowed "
            f"必须是布尔，实际 {allowed_unknown_stages!r}"
        )
    if allowed_unknown_stages:
        raise RuleConfigError(
            f"规则配置 {ruleset_config_id} 的 turn_order.end_turn.unknown_stages_allowed=true "
            "不被本引擎支持：那等于允许回合末存在未声明阶段（RC-103 fail closed）"
        )

    # ── RC-106：模式规模（team_size）必须是正整数 ─────────────────────────
    # 「引擎按几宠开局」从这一版起由**模式参数**决定。与登记表的一致性由
    # `validate_config` 判（生成器与测试共用的那份判据），这里只判形状。
    team_size = _leaf_value(config, "battle_mode.team_size")
    if not isinstance(team_size, int) or isinstance(team_size, bool) or team_size <= 0:
        raise RuleConfigError(
            f"规则配置 {ruleset_config_id} 的 battle_mode.team_size 必须是正整数，实际 {team_size!r}"
        )

    # ── RC-105：mana / actions（只有声明了它们的配置才有值，其余一律 None）──
    # 取值域判据上面已经把关过；这一段只管读成字段，尤其要保住 None 与 0 的区别。
    raw_mana = config.get("mana")
    has_mana = isinstance(raw_mana, dict)
    mana_pool = _leaf_value(config, "mana.pool") if has_mana else None
    mana_faint_cost = _leaf_value(config, "mana.faint_cost") if has_mana else None
    mana_loss_when_zero = _leaf_value(config, "mana.loss_when_zero") if has_mana else None
    mana_surrender = _leaf_value(config, "mana.surrender") if has_mana else None

    raw_actions = config.get("actions")
    has_actions = isinstance(raw_actions, dict)
    allowed_kinds: Optional[Tuple[str, ...]] = None
    forbidden_kinds: Tuple[str, ...] = ()
    unknown_kinds_allowed: Optional[bool] = None
    if has_actions:
        allowed_kinds = tuple(str(x) for x in _leaf_value(config, "actions.allowed_kinds"))
        forbidden_kinds = tuple(str(x) for x in _leaf_value(config, "actions.forbidden_kinds"))
        unknown_kinds_allowed = _leaf_value(config, "actions.unknown_kinds_allowed")

    return RuleConfig(
        ruleset_config_id=config["ruleset_config_id"],
        is_default=bool(config["is_default"]),
        schema=config["schema"],
        game=config["game"],
        source_id=config["source_id"],
        derived_from_ledger_sha256=config["derived_from_ledger_sha256"],
        status=str(config.get("status", "")),
        battle_mode_id=config["battle_mode"]["id"],
        battle_mode_team_size=_leaf_value(config, "battle_mode.team_size"),
        energy_max=_leaf_value(config, "energy.max"),
        energy_regen_per_turn=_leaf_value(config, "energy.regen.per_turn"),
        energy_initial=_leaf_value(config, "energy.initial"),
        energy_charge=_leaf_value(config, "energy.charge"),
        # 可选能力：**缺字段就是 False**（legacy / v2 里没有这一块），不能借用
        # `_leaf_value`——它对缺字段是抛错（那条纪律是给必填项用的）。
        damage_multi_hit=_optional_leaf_true(config, "damage.multi_hit"),
        energy_initial_for_all_pets=_optional_leaf_true(config, "energy.initial_for_all_pets"),
        energy_cost_modifier=_optional_leaf_true(config, "energy.cost_modifier"),
        energy_foe_energy_loss=_optional_leaf_true(config, "energy.foe_energy_loss"),
        energy_respond_override=_optional_leaf_true(config, "energy.respond_override"),
        energy_per_layer_cost=_optional_leaf_true(config, "energy.per_layer_cost"),
        damage_attack_stat_by_class=_optional_leaf_true(config, "damage.attack_stat_by_class"),
        damage_slot_condition=_optional_leaf_true(config, "damage.slot_condition"),
        damage_position_shift=_optional_leaf_true(config, "damage.position_shift"),
        damage_initiative_condition=_optional_leaf_true(config, "damage.initiative_condition"),
        damage_foe_switch_condition=_optional_leaf_true(config, "damage.foe_switch_condition"),
        damage_per_use_ramp=_optional_leaf_true(config, "damage.per_use_ramp"),
        # task-25 B 族：与 `per_use_ramp` **同一形状、同一读法**（没声明 = False ⇒ 逐位不变）。
        damage_element_use_ramp=_optional_leaf_true(config, "damage.element_use_ramp"),
        # task-26 P0：与上面几条同一形状（没声明 = False ⇒ legacy 逐位不变 ✓）。
        damage_per_own_debuff_cost=_optional_leaf_true(config, "damage.per_own_debuff_cost"),
        damage_cleanse_dispatch=_optional_leaf_true(config, "damage.cleanse_dispatch"),
        damage_cleanse_marks=_optional_leaf_true(config, "damage.cleanse_marks"),
        damage_triggered_ramp=_optional_leaf_true(config, "damage.triggered_ramp"),
        damage_respond_reduction_to_heal=_optional_leaf_true(
            config, "damage.respond_reduction_to_heal"),
        damage_element_power_ramp=_optional_leaf_true(config, "damage.element_power_ramp"),
        damage_moe_mark=_optional_leaf_true(config, "damage.moe_mark"),
        damage_self_power_flat=_optional_leaf_true(config, "damage.self_power_flat"),
        damage_cond_self_debuff_power=_optional_leaf_true(
            config, "damage.cond_self_debuff_power"),
        damage_global_skill_mods=_optional_leaf_true(config, "damage.global_skill_mods"),
        damage_on_hit_ramp=_optional_leaf_true(config, "damage.on_hit_ramp"),
        damage_per_layer_boost=_optional_leaf_true(config, "damage.per_layer_boost"),
        # 2026-09-29（task-25）：A 族「获得 属性±N」的解析形状 / 平值，与两条速度读点。
        # **整块都在 v3 新增的 `stat_gain` 下** —— 为什么不去借 `turn_order`：`test_six_pet_battle`
        # 判据要求 v3 的 `turn_order` 与 v2 **逐字相同**（整块 json.dumps 相比），
        # 借它就会被判红；`damage` 虽已是 v3 独有块，但这一族不只有伤害（还有先手速度）。
        stat_gain_extended=_optional_leaf_true(config, "stat_gain.extended_shapes"),
        stat_gain_flat=_optional_leaf_true(config, "stat_gain.flat"),
        stat_gain_speed_buff=_optional_leaf_true(config, "stat_gain.speed_buff"),
        # 2026-09-29：回合末持续状态的显式本地规则（`status.end_of_turn`）。
        # **缺字段 = None**（legacy / v2）⇒ 引擎走老口径，逐位不变。
        status_end_of_turn=_optional_status_rules(config),
        action_order=tuple(str(x) for x in action_order),
        speed_tie=None if speed_tie == "unknown" else speed_tie,
        speed_tie_microcase_id=tie_microcase,
        end_turn_order=tuple(str(x) for x in end_turn),
        end_turn_unknown_stages_allowed=allowed_unknown_stages,
        mana_pool=mana_pool,
        mana_faint_cost=mana_faint_cost,
        mana_loss_when_zero=mana_loss_when_zero,
        mana_surrender=mana_surrender,
        allowed_kinds=allowed_kinds,
        forbidden_kinds=forbidden_kinds,
        unknown_kinds_allowed=unknown_kinds_allowed,
        # 2026-09-25：「背包物品不占行动」是配置声明。**缺字段 = None = UNKNOWN** ⇒ 自由动作拒绝。
        magic_occupies_action=_optional_policy_bool(config, "policies.magic_policy.occupies_action"),
        magic_occupies_action_status=_optional_raw_str(
            config, "policies.magic_policy.occupies_action_status"),
        # 2026-09-25：天气层整份从配置读（生成器从 battle-modes.json 照抄）。
        # **缺字段 = None = 没声明** ⇒ 引擎里天气路径全部 fail closed（legacy / v2 逐位不变）。
        weather_policy=_optional_policy_dict(config, "policies.weather_policy"),
        path=os.path.relpath(path, _repo_root()),
        raw=config,
    )


_CACHE: Dict[str, RuleConfig] = {}


def available_rule_configs() -> List[str]:
    """磁盘上所有配置 id（磁盘顺序排序）。"""
    directory = rule_configs_dir()
    if not os.path.isdir(directory):
        raise RuleConfigError(f"规则配置目录不存在：{RULESET_DIR}")
    ids = []
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            ids.append(os.path.basename(name)[: -len(".json")].replace("-", "_"))
    if not ids:
        raise RuleConfigError(f"规则配置目录 {RULESET_DIR} 里没有任何 .json")
    return ids


def default_ruleset_config_id() -> str:
    """**默认仍然是 legacy**，除非环境变量显式指定。

    环境变量选到的 id 必须在磁盘上真实存在；选错就抛错（fail closed），
    绝不在「用户写错了」的时候悄悄退回 legacy —— 那会让一次误配置看起来像成功。
    """
    chosen = os.environ.get(ENV_VAR, "").strip() or DEFAULT_RULE_CONFIG_ID
    if chosen not in available_rule_configs():
        raise RuleConfigError(
            f"{ENV_VAR}={chosen!r} 不是已知的规则配置（磁盘上有：{', '.join(available_rule_configs())}）"
        )
    return chosen


def get_rule_config(override: Optional[Any] = None) -> RuleConfig:
    """取当前生效的配置。

    `override` 可以是：
      · `None` —— 用 `ROCO_RULE_CONFIG`（默认 `legacy_sim_v1`）；
      · 配置 id 字符串；
      · 已经加载好的 `RuleConfig` 实例（对局内部传递用）。
    """
    if isinstance(override, RuleConfig):
        return override
    ruleset_config_id = override or default_ruleset_config_id()
    if ruleset_config_id not in _CACHE:
        _CACHE[ruleset_config_id] = load_config(ruleset_config_id)
    return _CACHE[ruleset_config_id]


def clear_cache() -> None:
    """清掉进程内缓存（测试与切换配置时用；登记表缓存一起清）。"""
    _CACHE.clear()
    _BATTLE_MODES_CACHE.clear()


def summarize(config: RuleConfig) -> Dict[str, Any]:
    """把一份配置摊平成便于人读/进报告的摘要（不含 live 对象）。"""
    return {
        "ruleset_config_id": config.ruleset_config_id,
        "is_default": config.is_default,
        "path": config.path,
        "status": config.status,
        "battle_mode_id": config.battle_mode_id,
        "battle_mode_team_size": config.battle_mode_team_size,
        "energy_max": config.energy_max,
        "energy_regen_per_turn": config.energy_regen_per_turn,
        "energy_initial": config.energy_initial,
        "energy_charge": config.energy_charge,
        "action_order": list(config.action_order),
        "speed_tie": config.speed_tie,
        "speed_tie_microcase_id": config.speed_tie_microcase_id,
        "end_turn_order": list(config.end_turn_order),
        "end_turn_unknown_stages_allowed": config.end_turn_unknown_stages_allowed,
        # RC-105：魔力与合法动作裁剪。没有声明的配置这里是 null / 空，**不是 0**。
        "has_mana": config.has_mana,
        "mana_pool": config.mana_pool,
        "mana_faint_cost": config.mana_faint_cost,
        "mana_loss_when_zero": config.mana_loss_when_zero,
        "mana_surrender": config.mana_surrender,
        "has_actions": config.has_actions,
        "allowed_kinds": list(config.allowed_kinds) if config.allowed_kinds is not None else None,
        "forbidden_kinds": list(config.forbidden_kinds),
        "unknown_kinds_allowed": config.unknown_kinds_allowed,
        # 2026-09-25：PVP 魔法 / 背包物品「占不占一次行动」。`None` = 没声明 ⇒ 自由动作 fail closed。
        "magic_occupies_action": config.magic_occupies_action,
        "magic_occupies_action_status": config.magic_occupies_action_status,
        "ledger_sha256": config.derived_from_ledger_sha256,
        "fingerprint": config.fingerprint(),
        "unknowns": config.unknowns,
    }


def describe_fields(config: RuleConfig) -> List[Dict[str, Any]]:
    """逐字段列出 值 / 置信 / 台账引用 / 角色（报告与文档用）。"""
    rows: List[Dict[str, Any]] = []
    for path, leaf in _iter_leaves(config.raw):
        if path.startswith("battle_mode.") and path not in ("battle_mode.id", "battle_mode.team_size",
                                                            "battle_mode.active_count"):
            continue
        rows.append({
            "path": path,
            "value": leaf.get("value"),
            "confidence": leaf.get("confidence"),
            "evidence_id": leaf.get("evidence_id"),
            "evidence_role": leaf.get("evidence_role"),
            "reason": leaf.get("reason"),
            # RC-103：待录 microcase 与「值本身还没被验证」这层登记也要进报告 ——
            # 只有值没有 case 的话，「缺哪一条证据」就只能靠人去翻配置。
            "microcase_id": leaf.get("microcase_id"),
            "microcase_status": leaf.get("microcase_status"),
            "value_status": leaf.get("value_status"),
        })
    return rows


def selftest(*, quiet: bool = False) -> Tuple[int, int]:
    """`python3 -m roco_env.rule_config` 的自检（含反向控制）。

    返回 `(failed, total)`，不再返回 exit code：SELF-01 之后它由
    `roco/tests/test_rule_config_selftest.py` 在 `npm run test:env` 里直接调用，
    调用方要同时拿到「几条红」与「一共几条」（只拿布尔的话，「全绿」与「删掉几条断言」
    长得一样）。`quiet=True` 只关打印，计数一字不差。
    """
    checks: List[Tuple[str, bool, str]] = []

    def push(name: str, ok: bool, actual: str) -> None:
        checks.append((name, bool(ok), actual))

    configs = {cid: load_config(cid) for cid in available_rule_configs()}
    push("磁盘上每份配置都通过校验", len(configs) >= 2, ", ".join(configs))
    legacy = configs[DEFAULT_RULE_CONFIG_ID]
    push("默认仍是 legacy，且它 is_default=true", legacy.is_default and os.environ.get(ENV_VAR, "") == "",
         f"{legacy.ruleset_config_id} is_default={legacy.is_default}")
    push("legacy 的能量三件套与当前引擎逐位相同",
         (legacy.energy_max, legacy.energy_regen_per_turn, legacy.energy_initial) == (6, 1, 2),
         f"max={legacy.energy_max} regen={legacy.energy_regen_per_turn} initial={legacy.energy_initial}")
    push("legacy 没有魔力系统、也不裁剪合法动作（mana/actions 都不存在）",
         legacy.has_mana is False and legacy.has_actions is False
         and legacy.mana_pool is None and legacy.allowed_kinds is None,
         f"has_mana={legacy.has_mana} has_actions={legacy.has_actions} "
         f"mana_pool={legacy.mana_pool!r} allowed={legacy.allowed_kinds!r}")
    candidate = configs[CANDIDATE_RULE_CONFIG_ID]
    push("candidate 的上限是 10、自然回能是 0", (candidate.energy_max, candidate.energy_regen_per_turn) == (10, 0),
         f"max={candidate.energy_max} regen={candidate.energy_regen_per_turn}")
    # 2026-09-25（审计 SELF-01）口径变更：原断言写死「candidate 的入场能量必须是 UNKNOWN」，
    # 那是 2026-09-23 之前的世界。依据：mobile-s4-candidate-v2.json 的 energy.initial 现为
    # {value:10, confidence:RECORDED_IN_GAME, evidence_id:EV-ENERGY-INITIAL}（持有者实机读数）。
    # 改成不变量：UNKNOWN(null) 仍合法；是数就必须由实机口径支撑。
    _initial = candidate.raw.get("energy", {}).get("initial", {})
    push("candidate 的入场能量：要么 UNKNOWN(null)，要么由实机口径（RECORDED_IN_GAME/MICROCASE）支撑",
         candidate.energy_initial is None or _initial.get("confidence") in ("RECORDED_IN_GAME", "MICROCASE"),
         f"initial={candidate.energy_initial!r} confidence={_initial.get('confidence')!r} "
         f"evidence={_initial.get('evidence_id')!r}")

    # ── RC-105：v3 的 mana / actions ──────────────────────────────────────
    mana_cfg = configs.get(MANA_ACTIONS_CANDIDATE_ID)
    push("v3 在磁盘上、且是候选（is_default=false，不得作为默认）",
         mana_cfg is not None and mana_cfg.is_default is False, repr(mana_cfg and mana_cfg.is_default))
    if mana_cfg is not None:
        push("v3 的魔力池是 4、力竭扣 1、归零判负、允许投降",
             (mana_cfg.mana_pool, mana_cfg.mana_faint_cost,
              mana_cfg.mana_loss_when_zero, mana_cfg.mana_surrender) == (4, 1, True, True),
             f"pool={mana_cfg.mana_pool} faint={mana_cfg.mana_faint_cost} "
             f"loss_when_zero={mana_cfg.mana_loss_when_zero} surrender={mana_cfg.mana_surrender}")
        # 2026-09-25（审计 SELF-01）口径变更：原断言是等值元组（没有 "magic"），那是
        # 2026-09-23 之前的世界。依据：mobile-s4-candidate-v3.json 的 allowed_kinds 现含
        # "magic"，由台账 EV-PVP-WISH-POWER-UP（RECORDED_IN_GAME）登记为合法动作类。
        # 改成不变量：聚能是独立动作类且在换人/投降之前（顺序即展示顺序），magic 必须在。
        _acts = mana_cfg.raw.get("actions", {})
        _kinds = tuple(mana_cfg.allowed_kinds or ())
        _declared = tuple(_acts.get("allowed_kinds", {}).get("value", ()) or ())
        _charge_kind = _acts.get("kinds", {}).get("charge", {}).get("value")
        push("v3 的 allowed_kinds 顺序即展示顺序，聚能是独立动作类、magic（PVP 魔法）已登记",
             _kinds == _declared and "magic" in _kinds and "charge" in _kinds
             and _kinds.index("charge") < _kinds.index("switch") < _kinds.index("surrender")
             and _charge_kind != "skill",
             f"allowed_kinds={_kinds} 与声明顺序一致={_kinds == _declared} charge.kind={_charge_kind!r}")
        # 2026-09-25：这条期望值原来写成 `("item", "escape", "反证故意改错")` ——
        # 多出来的第三项让断言**永远为假**（写必红反证时改错了地方：该改**输入**，却改了**期望**）。
        # 后果是自检长期 27/28、`test:env` 长期红，而门禁没在冻结树上跑过就没人发现。
        # 口径本身没变：标准 PVP 无道具与逃跑，配置里就是这两项（与上面 allowed_kinds 互不重叠、
        # 与下面的「交集非空必须判红」反证一致）。
        push("v3 的 forbidden_kinds 是 item/escape（标准 PVP 无道具与逃跑）",
             mana_cfg.forbidden_kinds == ("item", "escape"), str(mana_cfg.forbidden_kinds))
        push("v3 不放行未声明的动作类", mana_cfg.unknown_kinds_allowed is False,
             repr(mana_cfg.unknown_kinds_allowed))
        # 反证⑨：把 item 塞进 allowed_kinds（两张清单交集非空）必须被判红
        overlap = json.loads(json.dumps(mana_cfg.raw))
        overlap["actions"]["allowed_kinds"]["value"].append("item")
        overlap["actions"]["kinds"]["item"]["value"] = "allowed"
        problems9 = validate_config(overlap, _load_ledger())
        push("反证⑨：把 item 同时写进 allowed 与 forbidden 必须被判红",
             any("交集" in p for p in problems9), str(problems9)[:160])
        # 反证⑩：自造一个引擎不认识的动作类必须被判红
        invented_kind = json.loads(json.dumps(mana_cfg.raw))
        invented_kind["actions"]["allowed_kinds"]["value"].append("fuse")
        invented_kind["actions"]["kinds"]["fuse"] = {
            "value": "allowed", "confidence": "ENGINE_HYPOTHESIS",
            "evidence_id": None, "evidence_role": None, "reason": "自造动作类",
        }
        problems10 = validate_config(invented_kind, _load_ledger())
        push("反证⑩：自造动作类 fuzz 必须被判红（不许写引擎不认识的 kind）",
             any("不认识的动作类" in p for p in problems10), str(problems10)[:160])
        # 反证⑪：力竭扣减写成负数必须被判红
        negative = json.loads(json.dumps(mana_cfg.raw))
        negative["mana"]["faint_cost"]["value"] = -1
        problems11 = validate_config(negative, _load_ledger())
        push("反证⑪：mana.faint_cost=-1 必须被判红（负数不是一份可读的登记）",
             any("faint_cost" in p and ">= 0" in p for p in problems11), str(problems11)[:160])
        # 反证⑫：白名单配置缺 mana.loss_when_zero 必须被判红
        dropped_mana = json.loads(json.dumps(mana_cfg.raw))
        dropped_mana["mana"].pop("loss_when_zero")
        problems12 = validate_config(dropped_mana, _load_ledger())
        push("反证⑫：v3 缺 mana.loss_when_zero 必须被判红",
             any("mana.loss_when_zero" in p for p in problems12), str(problems12)[:160])

    # ── RC-103：turn_order 三件套 ─────────────────────────────────────────
    push("legacy 的 action_order 如实等于引擎现状",
         legacy.action_order == ("respond", "priority", "speed"), str(legacy.action_order))
    push("legacy 的 speed_tie 是「如实登记的工程权宜」random_seeded",
         legacy.speed_tie == "random_seeded", repr(legacy.speed_tie))
    push("legacy 的回合末阶段顺序是 status_tick → regen",
         legacy.end_turn_order == ("status_tick", "regen"), str(legacy.end_turn_order))
    push("两份配置的 unknown_stages_allowed 都是 false（放行未知阶段 = 与 fail closed 冲突）",
         legacy.end_turn_unknown_stages_allowed is False
         and candidate.end_turn_unknown_stages_allowed is False,
         f"legacy={legacy.end_turn_unknown_stages_allowed} candidate={candidate.end_turn_unknown_stages_allowed}")
    push("candidate 的 speed_tie 是 UNKNOWN（null）而不是一个策略", candidate.speed_tie is None,
         repr(candidate.speed_tie))
    try:
        candidate.require_speed_tie()
        push("反证④：candidate 取平手策略必须抛错（UNKNOWN 不许回落到随机数）", False, "没有抛错")
    except RuleConfigError as exc:
        push("反证④：candidate 取平手策略必须抛错（UNKNOWN 不许回落到随机数）",
             "speed_tie" in str(exc) and "MC-E05" in str(exc), str(exc)[:140])

    # 反证⑤：非法平手策略（看起来很像那么回事的 "speed_first"）必须在加载期被判红
    bad_tie = json.loads(json.dumps(legacy.raw))
    bad_tie["turn_order"]["speed_tie"]["value"] = "speed_first"
    problems5 = validate_config(bad_tie, _load_ledger())
    push("反证⑤：speed_tie='speed_first' 这种自造策略必须被判红",
         any("speed_tie" in p for p in problems5), str(problems5)[:160])

    # 反证⑥：删掉 turn_order.action_order 必须被判红（缺字段不许静默跳过）
    missing_action = json.loads(json.dumps(legacy.raw))
    del missing_action["turn_order"]["action_order"]
    problems6 = validate_config(missing_action, _load_ledger())
    push("反证⑥：删掉 turn_order.action_order 必须被判红",
         any("turn_order.action_order" in p for p in problems6), str(problems6)[:160])

    # 反证⑦：未知阶段开关被打开必须被判红
    allowed = json.loads(json.dumps(legacy.raw))
    allowed["turn_order"]["end_turn"]["unknown_stages_allowed"]["value"] = True
    problems7 = validate_config(allowed, _load_ledger())
    push("反证⑦：unknown_stages_allowed=true 必须被判红",
         any("unknown_stages_allowed" in p for p in problems7), str(problems7)[:160])

    # 反证⑧：回合末阶段列表里出现重复项必须被判红（同一个阶段声明两次 = 双重结算）
    dup = json.loads(json.dumps(legacy.raw))
    dup["turn_order"]["end_turn"]["order"]["value"] = ["status_tick", "regen", "regen"]
    problems8 = validate_config(dup, _load_ledger())
    push("反证⑧：end_turn.order 里重复的阶段必须被判红",
         any("重复" in p for p in problems8), str(problems8)[:160])

    # 反证①：未知配置 id 必须抛错
    try:
        load_config("no_such_ruleset_v9")
        push("反证①：未知配置 id 必须抛错", False, "没有抛错")
    except RuleConfigError as exc:
        push("反证①：未知配置 id 必须抛错", "未知的规则配置 id" in str(exc), str(exc)[:120])

    # 反证②：从合规配置里删掉一个必填字段 → validate_config 必须报出来
    broken = json.loads(json.dumps(candidate.raw))
    del broken["energy"]["max"]
    problems = validate_config(broken, _load_ledger())
    push("反证②：删掉 energy.max 必须被判红", any("energy.max" in p for p in problems),
         str(problems)[:160])

    # 反证③：给一份**合成**的 UNKNOWN 字段补一个「看起来合理」的数 → 必须被判红
    # 2026-09-25（审计 SELF-01）：原构造改的是真配置，而真配置已有实机依据 ⇒ 反证失去对象。
    # 不再依赖「真配置恰好是 UNKNOWN」这种会漂的前提，所以自己合成一份。
    invented = json.loads(json.dumps(candidate.raw))
    invented["energy"]["initial"] = {"value": None, "confidence": "UNKNOWN", "evidence_id": None,
                                     "evidence_role": None, "reason": "反证③：合成 UNKNOWN 入场能量"}
    clean3 = validate_config(invented, _load_ledger())
    invented["energy"]["initial"]["value"] = 2
    problems3 = validate_config(invented, _load_ledger())
    push("反证③：给 UNKNOWN 的入场能量补 2 必须被判红",
         not clean3 and any("energy.initial" in p and "UNKNOWN" in p for p in problems3),
         f"合成 UNKNOWN 配置本身应无问题={clean3}；补 2 后={str(problems3)[:160]}")

    failed = [c for c in checks if not c[1]]
    if not quiet:
        for name, ok, actual in checks:
            print(f"{'✔' if ok else '✖'} {name} — 实际：{actual}")
        print(f"自检：{len(checks) - len(failed)}/{len(checks)} 通过")
    return len(failed), len(checks)


if __name__ == "__main__":  # pragma: no cover - 手工跑
    import sys

    _failed, _total = selftest()
    sys.exit(0 if _failed == 0 else 1)   # 退出码语义不变：全绿 = 0
