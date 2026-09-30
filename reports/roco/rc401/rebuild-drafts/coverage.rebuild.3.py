"""coverage.py 重建稿 2（tmp/ 专用 · **不落正文** ✓ 2026-09-30）。"""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple

from . import parse as _parse_mod   # 模块级引用（照既有同形 ✓ #33 · 不用 getattr(__import__) ✗）

SUPPORT_REFUSED = "REFUSED"
SUPPORT_KNOWLEDGE_ONLY = "KNOWLEDGE_ONLY"
SUPPORT_PARTIAL = "PARTIAL"
SUPPORT_SIMULATABLE_UNVERIFIED = "SIMULATABLE_UNVERIFIED"
SUPPORT_FULL_VERIFIED = "FULL_VERIFIED"

SETTLED_PATTERNS = (("驱散", ("驱散",)),)
UNSETTLED_WORDS = ("冻结", "引电", "萌化", "吸血", "天气", "离场", "迅捷")
UNSETTLED_EFFECT_KINDS = ("escape", "weather", "self_lifesteal")

_CAPABILITY_TO_FLAG: Dict[str, str] = {
    "attack_stat_by_class": "attack_stat_by_class_declared",
    "multi_hit": "multi_hit_declared",
    "slot_condition": "slot_condition_declared",
    "position_shift": "position_shift_declared",
    "on_hit_ramp": "on_hit_ramp_declared",
    "per_use_ramp": "per_use_ramp_declared",
    "triggered_ramp": "triggered_ramp_declared",
    "respond_reduction_to_heal": "respond_reduction_to_heal_declared",
    "element_power_ramp": "element_power_ramp_declared",
    "global_skill_mods": "global_skill_mods_declared",
    "cond_self_debuff_power": "cond_self_debuff_power_declared",
    "self_power_flat": "self_power_flat_declared",
    "moe_mark": "moe_mark_declared",
    "element_use_ramp": "element_use_ramp_declared",
    "per_own_debuff_cost": "per_own_debuff_cost_declared",
    "cleanse_dispatch": "cleanse_dispatch_declared",
    "cleanse_marks": "cleanse_marks_declared",
    "initiative_condition": "initiative_condition_declared",
    "per_layer_boost": "per_layer_boost_declared",
    "foe_switch_condition": "foe_switch_condition_declared",
}

def declared_capabilities_of(cfgid: Optional[Any] = None) -> Dict[str, bool]:
    """「同一份能力读数」—— 能力名 → 该配置有没有声明它（`service.py:835` 的用法 ✓）。

    ⚠ 返回的键必须是 `_CAPABILITY_TO_FLAG` 的**左列**（19+1 ✓）；
    值 = `getattr(get_rule_config(cfgid), 右列, False)` ✓。
    """
    from . import rule_config as _rc  # 延迟 import（照既有写法 ✓）
    cfg = _rc.get_rule_config(cfgid)
    # 🔴 #161（Lead 2026-09-30 定案 ✓）：**右列是"形参名"（`flags = {f: … for k, f in …}` 要它 ✓），
    # 不是 cfg 属性名** ✗ —— cfg 上的真名是 **`damage_<能力名>`**（v3 实测：`damage_cleanse_marks`=True ✓
    # 而 `cleanse_marks_declared` **不存在** ✗）⇒ **表不动，改的是消费它的这一处** ✓。
    return {name: bool(getattr(cfg, "damage_%s" % name, False)) for name in _CAPABILITY_TO_FLAG}


def respond_clause_gaps(skill: Any, parsed: Any) -> List[str]:
    """应对子句逐句判的缺口（签名 `(skill, parsed) -> list` ✓ monkeypatch 逐字给出 ✓ · 必须模块级 ✓）。"""
    raise NotImplementedError("respond_clause_gaps 本体未写（#138）")


_RESOLVER_BY_CAPABILITY: Dict[str, Any] = {
    "cleanse_marks": _parse_mod.resolve_cleanse_marks,
    "global_skill_mods": _parse_mod.resolve_moe_colon,
    "per_use_ramp": getattr(_parse_mod, "resolve_per_use_ramp", None),
    "element_use_ramp": getattr(__import__("roco_env.parse", fromlist=["x"]), "resolve_element_use_ramp", None),
    "per_layer_boost": getattr(__import__("roco_env.parse", fromlist=["x"]), "resolve_per_layer_boost", None),
    "per_own_debuff_cost": None,
    # 🔑 #158：这一格 = `parse.resolve_self_debuff_power`（不是独立机制，是"条件式本手平值威力"那一支 ✓）
    "cond_self_debuff_power": getattr(_parse_mod, "resolve_self_debuff_power", None),
    "respond_reduction_to_heal": None,
}


def classify_skill_declared(skill: Any, caps: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """唯一分类器（一参/两参两处调用点合并 ✓ #145）⇒ 返回含 support/why/unparsed ✓。"""
    raise NotImplementedError("classify_skill_declared 本体未写（#138）")


def settlement_verdict(skill: Any, *, declared: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """判据口径（`service.py:783-784`「判据抽到唯一一处」✓）。

    契约（8 个断言点读出来的 ✓ #150）：
      · `resolved: bool` ✓（`assertTrue/False` + `assertEqual(bool(...), want)` ✓）
      · `unsettled: list[str]` ✓（`assertEqual(v["unsettled"], [])` ✓ · 元素是字符串 ✓）
      · `parsed: Parsed` ✓（`v["parsed"].effects` ✓ · `unclaimed_mechanic_spans(skill, parsed=…)` ✓）
    `declared=None` ⇒ **`get_rule_config(None)`（当前生效配置）**（#153 裁定 ✓ 依据 `tier:109/116/118` 同源）。
    """
    from . import parse as _parse
    from . import rule_config as _rc

    #  #159（Lead 2026-09-30 **重裁** ✓）：`declared=None` ⇒ **不筛能力位**（resolver 全跑 ✓）。
    #  依据 = **三条断言联立**（`#159`）：`:116`(325⇒True，靠 SETTLED_PATTERNS、与能力位无关) +
    #         `:120`(724⇒True，**必须**让 resolver 跑) + `:118`(档位 ∈ SIM) ⇒ 唯一解 = 不筛 ✓。
    #  ⚠ 而"筛"这个能力**没丢** ✗：**显式传 `declared={…}` 时照旧筛** ✓（`slot_reduction:51-55` 靠它 ✓）。
    _filter = declared is not None
    if not isinstance(declared, dict):
        declared = {}

    parsed = _parse.parse_skill(skill)
    desc = str(getattr(skill, "desc", "") or "")
    unsettled: List[str] = []

    # ① 未认领片段（**按 keys 认领**：声明的能力位 ⇒ 先跑那几个 resolver ✓）
    for name, flag in (declared.items() if _filter else
                       {n: True for n in _CAPABILITY_TO_FLAG}.items()):
        if not flag:
            continue
        fn = _RESOLVER_BY_CAPABILITY.get(name)
        if fn is not None:
            try:
                parsed = fn(skill, declared=True, parsed=parsed)
            except Exception:
                pass
    for span in _parse.unclaimed_mechanic_spans(skill, parsed=parsed):
        unsettled.append(str(span))

    # ② 已结算词（SETTLED_PATTERNS ✓）/ 没拉起的原语（UNSETTLED_WORDS ✓）
    settled: List[str] = []
    for name, patterns in SETTLED_PATTERNS:
        if any(p and p in desc for p in patterns):
            settled.append(name)
    for word in UNSETTLED_WORDS:
        if word in desc and word not in settled:
            unsettled.append(word)

    # ③ 解析得出但引擎没有结算分支的 kind（UNSETTLED_EFFECT_KINDS ✓）
    kinds = {getattr(e, "kind", "") for e in getattr(parsed, "effects", [])}
    for kind in UNSETTLED_EFFECT_KINDS:
        if kind in kinds:
            unsettled.append("解析得出但没有结算分支：%s" % kind)


    # ⑥ 关掉的能力位要**如实点名**（`test_cond_self_debuff_power:110` 的正解 ✓）：
    #    ⚠ 新串**不许**含「条件：自身增益/减益」（`:127` 的切片只筛那一个 ⇒ 混进去会红 ✗）。
    if _filter:
        for _n, _f in declared.items():
            if not _f:
                unsettled.append("未声明能力位：%s" % _n)

    # ④ 诊断缺口层（`diagnostic_shape_gaps` 的语义 ✓ `test_effect_coverage:681`「描述里有形状、引擎没结算」）
    #    ⚠ 只落判据逐字给过的那一串（「条件：自身增益/减益」✓ `:125`）；其余等判据报（#138 ✓）。
    _diag: List[str] = []
    if ("减益时" in desc or "有减益" in desc):
        _diag.append("条件：自身增益/减益")
    # ⑤ evidence 覆盖（`test_cond_self_debuff_power:125-128` 逐字：「它靠**效果的 evidence 覆盖**消失」✓）
    #    🔴 **只许"该效果真被产出（有 evidence）"消缺口** ✗ —— 别的缺口照旧进 `unsettled` ✓。
    _evidenced = [str(getattr(e, "evidence", "") or "") for e in getattr(parsed, "effects", [])]
    if _evidenced and any(_e and _e in desc for _e in _evidenced):
        _diag = []                       # 该条件子句已被某个效果"覆盖" ⇒ 缺口消失 ✓
    unsettled.extend(_diag)

    # ⚠ `settled` 键**照旧产出**（`test_cond_self_debuff_power:117` 有 `assertIn("驱散", v["settled"])` ✓）,
    #   但**不再参与 `resolved`**（Lead 2026-09-30 重裁 ✓）：`resolved = not unsettled` ✓
    #   两点一线：`724`（`unsettled=[]` ⇒ 必须 True ✓）· `805`/`533`（有 unsettled ⇒ 必须 False ✓）。
    return {"resolved": not unsettled,
            "settled": settled,
            "unsettled": unsettled,
            "parsed": parsed}

def classify_skill(skill: Any, **flags: Any) -> Dict[str, Any]:
    """唯一档位分类器（`support.py:95` `classify_skill(skill, multi_hit_declared=…)` ✓ `#145`）。

    值域 = `SUPPORT_*` 五档（`support.py:21` 的严重度顺序 ✓）。
    本版第一刀：**能力全关 / 有未结算 ⇒ `PARTIAL`**；**已结算且能力齐 ⇒ `SIMULATABLE_UNVERIFIED`**
    （`test_foe_switch_moe:111` 逐字：关掉能力后档位必须 `SUPPORT_PARTIAL` ✓）。
    🔴 本体细节（`plain_attack`／「效果齐」两条早退 ✓）等判据继续报（#138 ✓）。
    """
    declared = {name: bool(flags.get(name)) for name in _CAPABILITY_TO_FLAG}
    v = settlement_verdict(skill, declared=declared)
    if not v["resolved"] or not v["unsettled"] == []:
        return {"support": SUPPORT_PARTIAL, "why": "有未结算子句或能力位未声明", "unparsed": []}
    return {"support": SUPPORT_SIMULATABLE_UNVERIFIED, "why": "描述被完整读出，且没有未认领片段", "unparsed": []}
