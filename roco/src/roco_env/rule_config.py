"""版本化规则配置的加载与校验（RC-101）。

**唯一事实源是 `data/roco/rulesets/*.json`。** 本模块只读它们，不写、不内联任何
数值 —— 这是「JS/Python/UI 不重复常量」那条要求的 Python 侧一半。规则值本身来自
`data/roco/evidence/rule-evidence-ledger.json`（证据台账），配置文件里每个字段都带
`confidence` + `evidence_id`，由 `scripts/roco/build-rule-configs.mjs` 生成与核对。

纪律：

  · **默认必须是 `legacy_sim_v1`**：默认路径要跟当前引擎逐位相同，否则所有既有
    replay / 夹具 / 产物当场失效。（`env.py` 的默认行为由 `ROCO_RULE_CONFIG` 或显式
    参数改动，**不做**自动探测。）
  · **fail closed**：缺字段、未知配置 id、台账指纹不符、confidence 与台账不一致、
    UNKNOWN 字段却带一个「看起来合理」的值 —— 全部抛 `RuleConfigError`，不猜默认值。
  · **unknown 就是 unknown**：`null` 不会被替换成任何数字；真要用到它的调用方
    必须显式处理（例如 `require_energy_initial()` 会抛错并指向待录 microcase）。

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

#: 声明 `mana` / `actions` 的配置白名单（RC-105）。
#:
#: 只有名单里的配置**必须**写全这两块；legacy 与 v2 显式登记为「没有魔力系统、不裁剪
#: 合法动作」。把新字段直接塞进 `REQUIRED_PATHS` 会让两份既有配置当场加载失败（等于改掉
#: 默认行为）或逼人给 legacy 补一个假 0 —— 所以「谁必须有」是一份显式名单。
#: 名单之外的配置**如果**写了这两块，一样会被逐字段校验。
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


def _battle_mode_ids() -> set:
    path = os.path.join(_repo_root(), BATTLE_MODES_REL)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            registry = json.load(fh)
    except OSError as exc:
        raise RuleConfigError(f"读不到 BattleMode 登记表 {BATTLE_MODES_REL}：{exc}") from exc
    except ValueError as exc:
        raise RuleConfigError(f"BattleMode 登记表不是合法 JSON：{exc}") from exc
    ids = {mode.get("id") for mode in registry.get("modes", []) if mode.get("id")}
    if not ids:
        raise RuleConfigError("BattleMode 登记表里一个模式都没有")
    return ids


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
    _validate_mana(config, bad)
    _validate_actions(config, bad)

    # BattleMode 必须是登记表里真实存在的模式
    mode_id = _dig(config, "battle_mode.id")
    if mode_id is not _MISSING and mode_id not in _battle_mode_ids():
        bad(f"battle_mode.id={mode_id!r} 不在 BattleMode 登记表里")

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
    energy_max: int
    energy_regen_per_turn: int
    #: `None` = **未知**（不是 0）。要用的调用方必须显式处理。
    energy_initial: Optional[int]
    energy_charge: Optional[int]
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
    path: str
    raw: Dict[str, Any] = dc_field(repr=False, default_factory=dict)

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
        energy_max=_leaf_value(config, "energy.max"),
        energy_regen_per_turn=_leaf_value(config, "energy.regen.per_turn"),
        energy_initial=_leaf_value(config, "energy.initial"),
        energy_charge=_leaf_value(config, "energy.charge"),
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
    """清掉进程内缓存（测试与切换配置时用）。"""
    _CACHE.clear()


def summarize(config: RuleConfig) -> Dict[str, Any]:
    """把一份配置摊平成便于人读/进报告的摘要（不含 live 对象）。"""
    return {
        "ruleset_config_id": config.ruleset_config_id,
        "is_default": config.is_default,
        "path": config.path,
        "status": config.status,
        "battle_mode_id": config.battle_mode_id,
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


def selftest() -> int:
    """`python3 -m roco_env.rule_config` 的自检（含反向控制）。"""
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
    push("candidate 的入场能量是 unknown（null）而不是一个数", candidate.energy_initial is None,
         repr(candidate.energy_initial))

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
        push("v3 的 allowed_kinds 顺序即展示顺序，且聚能是独立动作类",
             mana_cfg.allowed_kinds == ("skill", "charge", "switch", "surrender"),
             str(mana_cfg.allowed_kinds))
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

    # 反证③：UNKNOWN 字段补一个「看起来合理」的数 → 必须被判红
    invented = json.loads(json.dumps(candidate.raw))
    invented["energy"]["initial"]["value"] = 2
    problems3 = validate_config(invented, _load_ledger())
    push("反证③：给 UNKNOWN 的入场能量补 2 必须被判红",
         any("energy.initial" in p and "UNKNOWN" in p for p in problems3), str(problems3)[:160])

    failed = [c for c in checks if not c[1]]
    for name, ok, actual in checks:
        print(f"{'✔' if ok else '✖'} {name} — 实际：{actual}")
    print(f"自检：{len(checks) - len(failed)}/{len(checks)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":  # pragma: no cover - 手工跑
    import sys

    sys.exit(selftest())
