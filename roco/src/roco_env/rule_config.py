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

#: 每个配置**必须**存在的字段路径（缺任何一个就 fail closed）。
REQUIRED_PATHS = (
    "energy.max",
    "energy.regen.per_turn",
    "energy.regen.applies_to",
    "energy.initial",
    "energy.charge",
    "turn_order.end_turn.order",
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
    end_turn_order: Tuple[str, ...]
    path: str
    raw: Dict[str, Any] = dc_field(repr=False, default_factory=dict)

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
        end_turn_order=tuple(str(x) for x in end_turn),
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
        "end_turn_order": list(config.end_turn_order),
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
        })
    return rows


def selftest() -> int:
    """`python3 -m roco_env.rule_config` 的自检（含反向控制）。"""
    checks: List[Tuple[str, bool, str]] = []

    def push(name: str, ok: bool, actual: str) -> None:
        checks.append((name, bool(ok), actual))

    configs = {cid: load_config(cid) for cid in available_rule_configs()}
    push("磁盘上两份配置都通过校验", len(configs) >= 2, ", ".join(configs))
    legacy = configs[DEFAULT_RULE_CONFIG_ID]
    push("默认仍是 legacy，且它 is_default=true", legacy.is_default and os.environ.get(ENV_VAR, "") == "",
         f"{legacy.ruleset_config_id} is_default={legacy.is_default}")
    push("legacy 的能量三件套与当前引擎逐位相同",
         (legacy.energy_max, legacy.energy_regen_per_turn, legacy.energy_initial) == (6, 1, 2),
         f"max={legacy.energy_max} regen={legacy.energy_regen_per_turn} initial={legacy.energy_initial}")
    candidate = configs[CANDIDATE_RULE_CONFIG_ID]
    push("candidate 的上限是 10、自然回能是 0", (candidate.energy_max, candidate.energy_regen_per_turn) == (10, 0),
         f"max={candidate.energy_max} regen={candidate.energy_regen_per_turn}")
    push("candidate 的入场能量是 unknown（null）而不是一个数", candidate.energy_initial is None,
         repr(candidate.energy_initial))

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
