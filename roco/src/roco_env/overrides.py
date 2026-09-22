"""**显式的、带出处的未核验覆盖**（RC-106）。

问题
----
`mobile_s4_candidate_v3.json` 的 `energy.initial` 是从 v2 逐字复制的 `null`
（`confidence: UNKNOWN`，判据 MC-E04 未录制）。RC-101 的纪律是**不知道就先抛**，
所以 `reset(config=v3)` 会 fail closed —— 这条纪律是对的，不要放宽。

但「开不了一局」也意味着六宠标准 PVP **根本没法跑**，而「跑起来」这件事本身
是下一轮证据（MC-E04/E07/E08/E09）的前提。两难的正确解法**不是**往配置里填一个
看起来合理的数（那会让候选看起来已经被验证过），而是让调用方**显式地**、
**带着出处地**声明「这一步我按假设走」：

    reset(..., unverified_overrides=[{
        "path": "energy.initial",
        "value": 2,
        "confidence": "ENGINE_HYPOTHESIS",
        "reason": "练习局口径，不是标准 PVP 的实机结论（MC-E04 未录制）",
        "microcase_id": "MC-E04",
    }])

三条不可让步的性质（每一条都有对应的必红反证）
--------------------------------------------

1. **没有覆盖、配置又是 `null` ⇒ 仍然抛错。** 本模块不提供任何默认值；
   `RuleConfig.require_energy_initial()` 一个字节都没改。覆盖是**外部输入**，
   不是新的回落链。
2. **覆盖不写回配置文件。** 本模块只读 `RuleConfig`，既不 import `json` 也不写盘；
   `data/roco/rulesets/mobile-s4-candidate-v3.json` 的 `energy.initial` 永远是 `null`。
3. **覆盖必须如实出现在对外载荷里。** 它被挂到 `GameState.unverified_overrides`，
   经 `serialize()` / `public_planner_state()` / `ui_public_view()` 一路带出去，
   页面因此可以写「候选：初始能量沿用练习局口径（**未核验**）」，
   而不是假装自己知道标准 PVP 的入场能量。

为什么覆盖只允许落在 `UNKNOWN` 的字段上
--------------------------------------

「填一个未知数」与「改一条已知规则」是两件完全不同的事。前者是把
`UNKNOWN` 显式降级成 `ENGINE_HYPOTHESIS`；后者是**篡改已登记的规则值**
（例如把 `mana.pool` 的 4 覆盖成 2），那会让配置的 `derived_from_ledger_sha256`
与台账之间的关系变成一句空话。所以 `is_unknown()` 为假的路径一律拒收 ——
这条判据本身就是「配置是唯一事实源」的执行方式。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .rule_config import RuleConfig, RuleConfigError

#: 覆盖必须声明的置信等级。只允许这一个：能被覆盖的字段本来就是 `UNKNOWN`，
#: 覆盖不可能把它变成「有证据」的东西 —— 它只能是引擎侧假设。
OVERRIDE_CONFIDENCE = "ENGINE_HYPOTHESIS"

#: 一条覆盖**必须**带齐的键（少一个就抛，不许省）。
REQUIRED_KEYS: Tuple[str, ...] = ("path", "value", "confidence", "reason", "microcase_id")

#: 本引擎**认识**的、可被覆盖的规则字段路径。
#:
#: 为什么是一份白名单而不是「任何叶子都能覆盖」：`RuleConfig` 里带类型的字段
#: 都已经被读进 dataclass（`mana_pool` / `action_order` / `team_size` …），
#: 覆盖它们意味着要回头改那些字段的语义；而 `energy.initial` 是**唯一**一个
#: 「读的时候才要求非空」的未知字段，所以它是唯一一个能被安全地外部补齐的。
#: 加新路径时必须同时加一条测试说明「它为什么不会影响 legacy」。
OVERRIDABLE_PATHS: Tuple[str, ...] = ("energy.initial", "turn_order.speed_tie")

#: 覆盖值必须是非负整数（`energy.initial` 的取值域，与配置校验器同一条）。
_INT_PATHS: Tuple[str, ...] = ("energy.initial",)

#: 覆盖值必须落在 `SPEED_TIE_POLICIES` 里的路径（`turn_order.speed_tie`）。
#:
#: 为什么它也能被覆盖（RC-106 补）：候选配置 `mobile_s4_candidate_v3` 把 `speed_tie`
#: 如实登记成 `null`（MC-E05 未录制）——按 RC-103 的纪律，真撞上同速时**必须抛错**。
#: 那条纪律不改：`null` 仍然是 `null`，没有覆盖时照样抛。但「撞上同速就打不下去」意味着
#: 六宠标准 PVP 还是没法跑到力竭/扣魔力那一步。所以这里给调用方一个**显式**的、
#: 带出处的旁路：声明「这一步我按 `random_seeded` 这条**已登记的工程权宜**走」。
#: 它不改变配置文件里的 `null`，也不升级任何证据等级，并且会如实出现在对外载荷里
#: （页面因此能标「未核验」）。legacy 不受影响：它的配置本来就写着 `random_seeded`，
#: 覆盖只在 `is_unknown()` 为真（即 `null`）的路径上才被接受。
_SPEED_TIE_PATHS: Tuple[str, ...] = ("turn_order.speed_tie",)


@dataclass(frozen=True)
class UnverifiedOverride:
    """一条**已核验形状**的未核验覆盖。可 JSON 往返（进 `GameState` 的载荷）。"""

    path: str
    value: Any
    confidence: str
    reason: str
    microcase_id: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        """对外载荷那一份。键与顺序固定，页面可以照着渲染。"""
        return {
            "path": self.path,
            "value": self.value,
            "confidence": self.confidence,
            "reason": self.reason,
            "microcase_id": self.microcase_id,
            # 机器可读的提示：页面据此写「未核验」，不需要自己判断 confidence 的名字
            "unverified": True,
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "UnverifiedOverride":
        return UnverifiedOverride(
            path=d["path"],
            value=d.get("value"),
            confidence=d.get("confidence"),
            reason=d.get("reason"),
            microcase_id=d.get("microcase_id"),
        )


def is_unknown(config: RuleConfig, path: str) -> bool:
    """配置里这条路径是不是**显式的 UNKNOWN**（`value: null`）。

    只认「叶子存在、且 value 是 null」这一种形状：路径不存在（配置坏了）
    由 `_leaf_value` 在加载期报，不该在这里被当成「未知」而悄悄放行。
    """
    node = _dig(config.raw, path)
    if not isinstance(node, dict) or "value" not in node:
        raise RuleConfigError(
            f"规则配置 {config.ruleset_config_id} 里没有可覆盖的字段 {path} ——"
            "覆盖只能落在配置显式声明为 UNKNOWN 的字段上"
        )
    return node["value"] is None


def _dig(node: Any, path: str) -> Any:
    cur: Any = node
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _require_microcase_id(value: Any) -> str:
    """`microcase_id` 必须是一个**具体**的待录判据 id。

    为什么不允许 null / 空串：覆盖的全部意义就是「把这个未知数绑在一条证据待办上」。
    一条没有 microcase 的覆盖与「随手填一个数」在数据上完全无法区分，
    而后者正是这条纪律要挡掉的东西。
    """
    if not isinstance(value, str) or not value.strip():
        raise RuleConfigError(
            "未核验覆盖必须给出 microcase_id（待录判据的 id）——"
            "没有它，这条覆盖与「随手填一个数」在数据上无法区分"
        )
    return value.strip()


def normalize_unverified_overrides(
    config: RuleConfig,
    entries: Optional[Iterable[Any]],
) -> Tuple[UnverifiedOverride, ...]:
    """校验并规范化覆盖清单；任何一条不合法都抛 `RuleConfigError`（fail closed）。

    判据（每一条都对应报告里的一条必红反证）：

      · 每一条**必须**是 dict，且带齐 `path / value / confidence / reason / microcase_id`；
      · `confidence` **只能**是 `ENGINE_HYPOTHESIS`（覆盖不可能凭空变成有证据的）；
      · `reason` 必须是非空字符串（**说出这是假设**，而不是留白）；
      · `path` 必须在 `OVERRIDABLE_PATHS` 里；
      · `path` 在配置里必须是 `UNKNOWN`（`null`）—— 不许借覆盖改一条已知规则；
      · 同一个路径不许覆盖两次（后面那一条会静默压掉前面那条）。
    """
    if entries is None:
        return ()
    if isinstance(entries, (str, bytes)) or not isinstance(entries, (list, tuple)):
        raise RuleConfigError(
            "unverified_overrides 必须是「覆盖条目」的数组"
            "（每项 {path, value, confidence:'ENGINE_HYPOTHESIS', reason, microcase_id}）"
        )
    out: List[UnverifiedOverride] = []
    seen: Dict[str, int] = {}
    for index, raw in enumerate(entries):
        where = f"unverified_overrides[{index}]"
        if isinstance(raw, UnverifiedOverride):
            entry = raw
        elif isinstance(raw, dict):
            missing = [k for k in REQUIRED_KEYS if k not in raw]
            if missing:
                raise RuleConfigError(
                    f"{where} 缺字段 {'、'.join(missing)} ——"
                    f"一条覆盖必须写全 {list(REQUIRED_KEYS)}"
                )
            entry = UnverifiedOverride.from_dict(raw)
        else:
            raise RuleConfigError(f"{where} 必须是对象（dict），实际 {type(raw).__name__}")

        if entry.confidence != OVERRIDE_CONFIDENCE:
            raise RuleConfigError(
                f"{where}.confidence 只能是 {OVERRIDE_CONFIDENCE}，实际 {entry.confidence!r} ——"
                "覆盖就是把 UNKNOWN 显式降级成引擎假设，不可能凭空变成有证据的值"
            )
        if not isinstance(entry.reason, str) or not entry.reason.strip():
            raise RuleConfigError(f"{where}.reason 必须是非空字符串：必须说清「为什么这是假设」")
        microcase_id = _require_microcase_id(entry.microcase_id)
        if entry.path not in OVERRIDABLE_PATHS:
            raise RuleConfigError(
                f"{where}.path={entry.path!r} 不可覆盖（可覆盖：{'、'.join(OVERRIDABLE_PATHS)}）——"
                "「填一个未知数」与「改一条已登记的规则」是两件事，后者必须回到配置与台账"
            )
        if entry.path in seen:
            raise RuleConfigError(
                f"{where}.path={entry.path!r} 被覆盖了两次（前一条在 {seen[entry.path]}）——"
                "后一条会静默压掉前一条，不许这样表达"
            )
        seen[entry.path] = index
        if not is_unknown(config, entry.path):
            raise RuleConfigError(
                f"{where}.path={entry.path!r} 在配置 {config.ruleset_config_id} 里不是 UNKNOWN"
                f"（当前值 {_dig(config.raw, entry.path).get('value')!r}）——"
                "覆盖只用于把 UNKNOWN 显式假设掉，不许拿它改一条已登记的值"
            )
        if entry.path in _SPEED_TIE_PATHS:
            from . import rule_config as _rc
            if entry.value not in _rc.SPEED_TIE_POLICIES:
                raise RuleConfigError(
                    f"{where}.value={entry.value!r} 不是已知的同速裁决策略"
                    f"（允许 {list(_rc.SPEED_TIE_POLICIES)}）——"
                    "覆盖只能选一条**已登记**的工程权宜，不许现场发明一个策略名"
                )
        if entry.path in _INT_PATHS:
            value = entry.value
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise RuleConfigError(
                    f"{where}.value 必须是 >= 0 的整数，实际 {value!r}"
                    f"（{entry.path} 的取值域与配置校验器相同）"
                )
        out.append(UnverifiedOverride(
            path=entry.path,
            value=entry.value,
            confidence=entry.confidence,
            reason=entry.reason.strip(),
            microcase_id=microcase_id,
        ))
    return tuple(out)


def find_override(
    overrides: Sequence[UnverifiedOverride], path: str
) -> Optional[UnverifiedOverride]:
    """按路径取一条覆盖；没有就 `None`（调用方自己决定怎么 fail closed）。"""
    for entry in overrides:
        if entry.path == path:
            return entry
    return None


def resolve_int(
    config: RuleConfig,
    path: str,
    overrides: Sequence[UnverifiedOverride],
) -> int:
    """取一个整数规则值：未知时**只**接受显式覆盖，否则抛错。

    这是 `RuleConfig.require_energy_initial()` 的「可带覆盖」版本。两条分支：

      · 配置里有值 → 用它（覆盖在这里**不可能**发生：`normalize_*` 已经挡住
        「覆盖一个非 UNKNOWN 字段」）；
      · 配置里是 `null` → 只在有覆盖时返回覆盖值，否则抛 `RuleConfigError`。

    注意**没有第三条分支**：这里不写 `or 0`、不回落 legacy 的 2、不读环境变量。
    """
    node = _dig(config.raw, path)
    if not isinstance(node, dict) or "value" not in node:
        raise RuleConfigError(f"规则配置 {config.ruleset_config_id} 缺字段 {path}")
    if node["value"] is not None:
        return int(node["value"])
    entry = find_override(overrides, path)
    if entry is None:
        reason = node.get("reason")
        micro = node.get("microcase_id")
        if not micro:
            micro = next(
                (u.get("microcase_id") for u in config.unknowns if u.get("path") == path), None)
        raise RuleConfigError(
            f"规则配置 {config.ruleset_config_id} 的 {path} 是 UNKNOWN"
            f"（{reason or '无 reason'}；待录 microcase {micro or '未登记'}）——"
            "不许用 legacy 的值代替；要按其假设跑，必须显式给出 unverified_overrides"
        )
    return int(entry.value)


def describe(overrides: Sequence[UnverifiedOverride]) -> List[Dict[str, Any]]:
    """对外载荷用的一份副本（`GameState` 里存的就是这个形状）。"""
    return [entry.to_dict() for entry in overrides]


def selftest() -> int:
    """`python3 -m roco_env.overrides` 的自检（含反向控制）。"""
    from . import rule_config as rc

    checks: List[Tuple[str, bool, str]] = []

    def push(name: str, ok: bool, actual: str) -> None:
        checks.append((name, bool(ok), actual))

    cfg = rc.load_config(rc.MANA_ACTIONS_CANDIDATE_ID)
    good = [{
        "path": "energy.initial", "value": 2, "confidence": OVERRIDE_CONFIDENCE,
        "reason": "练习局口径（未核验）", "microcase_id": "MC-E04",
    }]
    entries = normalize_unverified_overrides(cfg, good)
    push("合法覆盖被接受，且解析出配置缺失的那个数",
         len(entries) == 1 and resolve_int(cfg, "energy.initial", entries) == 2,
         f"{describe(entries)}")
    try:
        resolve_int(cfg, "energy.initial", ())
        push("反证①：没有覆盖时 UNKNOWN 必须抛错", False, "没有抛错")
    except RuleConfigError as exc:
        push("反证①：没有覆盖时 UNKNOWN 必须抛错",
             "UNKNOWN" in str(exc) and "MC-E04" in str(exc), str(exc)[:140])

    bad_cases = {
        "反证②：缺 microcase_id": {**good[0], "microcase_id": None},
        "反证③：confidence 不是 ENGINE_HYPOTHESIS": {**good[0], "confidence": "OFFICIAL_CURRENT"},
        "反证④：没有 reason": {**good[0], "reason": ""},
        "反证⑤：覆盖一个不在白名单里的路径": {**good[0], "path": "mana.pool", "value": 2},
        "反证⑥：值不是非负整数": {**good[0], "value": -1},
    }
    for name, entry in bad_cases.items():
        try:
            normalize_unverified_overrides(cfg, [entry])
            push(name + " 必须抛错", False, "没有抛错")
        except RuleConfigError as exc:
            push(name + " 必须抛错", True, str(exc)[:120])

    # 反证⑦：覆盖一条**已知**的字段必须抛（借覆盖改规则）
    legacy = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID)
    try:
        normalize_unverified_overrides(legacy, good)
        push("反证⑦：覆盖已知字段（legacy 的 energy.initial=2 不是 UNKNOWN）必须抛错", False, "没有抛错")
    except RuleConfigError as exc:
        push("反证⑦：覆盖已知字段（legacy 的 energy.initial=2 不是 UNKNOWN）必须抛错",
             "不是 UNKNOWN" in str(exc), str(exc)[:140])

    failed = [name for name, ok, _ in checks if not ok]
    for name, ok, actual in checks:
        print(f"{'✔' if ok else '✖'} {name}｜{actual}")
    print(f"overrides selftest：{len(checks) - len(failed)}/{len(checks)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":  # pragma: no cover - 手工自检入口
    import sys

    sys.exit(selftest())


def resolve_speed_tie(
    config: RuleConfig,
    overrides: Optional[Sequence[Any]] = None,
) -> Optional[str]:
    """取同速裁决策略：配置里有值就用它；配置是 `null` 时**只**接受显式覆盖。

    与 `resolve_int` 同一套三条分支（配置值 / 显式覆盖 / 抛错），只是这里返回
    `Optional[str]`：`None` 表示「没有任何依据」，调用方**必须** fail closed
    （`env.order_actions` 只在真的需要这一维时才抛，见 `_tie_is_decisive`）。

    覆盖项既接受 `UnverifiedOverride`，也接受**载荷里的 dict**（状态经
    `serialize()` / `public_planner_state()` 往返之后就是 dict）——两种形状都要认，
    否则「同一局在开新局与推进回合两条路径上行为不同」，那是最难查的一类不一致。
    """
    # 先读**字段**（不是 `.raw`）：`dataclasses.replace(cfg, speed_tie=...)` 只改字段、
    # 不改 `.raw`，读 raw 会让「显式构造一份 speed_tie=None 的配置」被误判成有策略
    # （RC-103 的 fail-closed 测试就是这么构造的，实测把它弄红了）。
    policy = getattr(config, "speed_tie", None)
    if policy is not None:
        return policy
    for raw in overrides or ():
        if isinstance(raw, UnverifiedOverride):
            path, value = raw.path, raw.value
        elif isinstance(raw, dict):
            path, value = raw.get("path"), raw.get("value")
        else:
            continue
        if path == "turn_order.speed_tie":
            return value
    return None
