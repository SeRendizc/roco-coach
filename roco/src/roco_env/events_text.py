"""把引擎事件写成**自然中文句子**（第 42 轮 P0-2）。

为什么需要它
------------
页面原来是这样渲染的（`src/client/roco.js`）：

    `${event.side} ${event.kind} · ${JSON.stringify(event.detail)}`

于是玩家看到的是 `enemy damage · {"amount":25,"skill_id":"skill_000750",...}`。
`kind` 是**引擎内部标识符**，`detail` 是**内部数据结构**——两样都不该出现在玩家面前。

实现位置的选择
--------------
放在 Python 侧，而不是浏览器里：事件是引擎产出的，**只有引擎知道每个 detail 字段是什么意思**
（`power_used` 与 `conditional_power` 的区别、`type_multiplier` 是不是未核验的估值）。
放到浏览器里就得把这份知识再抄一遍，抄完两边必然漂移。

口径纪律
--------
  · **不补数字**：模板只使用 detail 里**真的存在**的键；缺了就换一种说法，
    绝不写「造成 0 点伤害」这类编出来的话。
  · **不猜机制**：`effect_support` 不是 `supported` 的效果一律说「未核验、本次不结算」。
  · **伤害要标来源**：`formula_verified` 为假时说「估值」，不写成一个确定的事实。
  · 每个 `kind` 都必须有句子；漏一个就让测试红（`test_event_text.py` 跑真对局收全集）。

    cd roco && PYTHONPATH=src python3 -m unittest tests.test_event_text -v
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: 事件里的 `side` 字段在不同 kind 上取值不一致（有的是 `"player"`，有的是 `Side.name`）。
#: 统一在这里翻译，避免每个模板各判一次。
_SIDE = {
    "player": "我方",
    "enemy": "对方",
    "Player": "我方",
    "Enemy": "对方",
}

#: 异常状态 / 印记 / 属性的中文名。规则集里没有专门的显示名表，
#: 这里只翻译**引擎确实会产生的那些键**；遇到没登记的键就原样显示（不猜）。
_STATUS = {
    "burn": "灼烧",
    "poison": "中毒",
    "paralysis": "麻痹",
    "freeze": "冰冻",
    "sleep": "睡眠",
    "confusion": "混乱",
    "seal": "封印",
}
_MARK = {
    "mark": "印记",
}
_STAT = {
    "atk": "攻击",
    "def": "防御",
    "spa": "魔攻",
    "spd": "魔防",
    "spe": "速度",
    "hp": "生命",
}
_ITEM = {
    "potion": "治疗药",
    "energy_fruit": "能量果",
    "cleanse": "净化药",
}
_CANCEL_REASON = {
    "fainted": "已经倒下",
}


def _side(value: Any) -> str:
    if value is None:
        return ""
    return _SIDE.get(str(value), str(value))


def _num(value: Any) -> Optional[str]:
    """把数值写成中文里顺眼的形状；不是数就返回 None（**不编 0**）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.1f}".rstrip("0").rstrip(".")
    return None


def _stat(value: Any) -> str:
    return _STAT.get(str(value), str(value))


def event_text(event: Dict[str, Any], rs: Any = None) -> str:
    """一条事件 → 一句话。**必须**对每个 kind 都给出句子。"""
    kind = str(event.get("kind") or "")
    # **两种形状都要认**。`_bump` 产出的是 `Event(kind, turn, detail, evidence)`，
    # 而效果层/特性层（`traits.py`）直接往列表里塞**扁平字典**
    # （`{"kind":"trait","trait":"专注力","side":"player","effect":"atk +100%"}`）。
    # 只认前一种的话，特性那一类事件会走进兜底话——而它恰恰是玩家最需要看懂的
    # （「为什么这只精灵一上场就更强了」）。所以这里把顶层字段也并进 detail。
    detail: Dict[str, Any] = dict(event.get("detail") or {})
    for key, value in event.items():
        if key not in ("kind", "turn", "evidence", "text", "detail") and key not in detail:
            detail[key] = value
    side = _side(detail.get("side"))
    turn = event.get("turn")

    def skill_name() -> str:
        sid = detail.get("skill_id")
        if not sid:
            return "一个技能"
        if rs is not None:
            try:
                return rs.skill(sid).name
            except Exception:  # noqa: BLE001 — 规则集里没有就退回通用说法，不猜名字
                return "一个技能"
        return "一个技能"

    if kind == "turn_start":
        return f"第 {turn} 回合开始。"

    if kind == "trait":
        trait = detail.get("trait") or "特性"
        effect = detail.get("effect")
        stacks = _num(detail.get("stacks"))
        tail = f"（已叠 {stacks} 层）" if stacks else ""
        if effect:
            return f"{side}的{trait}触发：{effect}{tail}。"
        return f"{side}的{trait}触发了{tail}。"

    if kind == "damage":
        amount = _num(detail.get("damage"))
        who = f"{side}的" if side else ""
        parts = [f"{who}{skill_name()}命中"]
        if amount is not None:
            parts.append(f"，造成约 {amount} 点伤害")
        # 伤害公式未核验时必须标出来：这是估值，不是实测值
        if detail.get("formula_verified") is not True:
            parts.append("（伤害公式未核验，这是引擎估值）")
        mult = detail.get("type_multiplier")
        if isinstance(mult, (int, float)) and mult > 1.0:
            parts.append("，属性克制")
        elif isinstance(mult, (int, float)) and 0 < mult < 1.0:
            parts.append("，属性抗性")
        return "".join(parts) + "。"

    if kind == "faint":
        return f"{side}的精灵倒下了。"

    if kind == "heal":
        amount = _num(detail.get("healed"))
        return f"{side}回复了 {amount} 点生命。" if amount else f"{side}回复了生命。"

    if kind == "energy_regen":
        amount = _num(detail.get("energy"))
        return f"{side}的能量回到 {amount}。" if amount else f"{side}回复了能量。"

    if kind == "drain_energy":
        amount = _num(detail.get("taken"))
        return f"{side}被抽走 {amount} 点能量。" if amount else f"{side}的能量被抽走。"

    if kind == "energy_gain":
        amount = _num(detail.get("amount"))
        # 回能时序是 MC-007 未解项（`env.py` 里登记了 assumption），所以要标出来。
        tail = "（回能时序未核验，按出手时立即回能处理）" if detail.get("assumption") else ""
        if amount:
            return f"{side}用{skill_name()}回收了 {amount} 点能量{tail}。"
        return f"{side}用{skill_name()}回收能量，但已达上限{tail}。"

    if kind == "effects_registered_unsupported":
        effect_count = detail.get("parsed_effects")
        span_count = detail.get("unclaimed_spans")
        marker_count = detail.get("unparsed_markers")
        parts = []
        if effect_count:
            parts.append(f"{effect_count} 条已解析效果")
        if marker_count:
            parts.append(f"{marker_count} 处未解析机制")
        if span_count:
            parts.append(f"{span_count} 处未认领机制词")
        what = "、".join(parts) if parts else "附加效果"
        return f"{side}的{skill_name()}有{what}**没有结算**（未核验，不猜数值），已如实登记。"

    if kind == "item":
        item = _ITEM.get(str(detail.get("item")), "道具")
        if detail.get("healed") is not None:
            return f"{side}使用了{item}，回复 {_num(detail.get('healed'))} 点生命。"
        if detail.get("energy_gained") is not None:
            return f"{side}使用了{item}，获得 {_num(detail.get('energy_gained'))} 点能量。"
        if detail.get("cleared"):
            return f"{side}使用了{item}，清除了身上的异常。"
        return f"{side}使用了{item}。"

    if kind == "switch":
        slot = detail.get("to_slot")
        target = f"第 {int(slot) + 1} 位" if isinstance(slot, int) else "另一只"
        return f"{side}换上{target}精灵。"

    if kind == "replacement":
        slot = detail.get("slot")
        target = f"第 {int(slot) + 1} 位" if isinstance(slot, int) else "一只"
        return f"{side}补上了{target}精灵。"

    if kind == "defense":
        reduction = _num(detail.get("reduction"))
        hand = "并作出应对" if detail.get("respond") else ""
        if reduction:
            return f"{side}用{skill_name()}防御，减伤约 {reduction}{hand}。"
        return f"{side}用{skill_name()}进入防御{hand}。"

    if kind == "buff_self":
        delta = _num(detail.get("delta_pct"))
        return f"{side}的{_stat(detail.get('stat'))}提高了 {delta}%。"

    if kind == "debuff_foe":
        delta = _num(detail.get("delta_pct"))
        return f"{side}的{_stat(detail.get('stat'))}下降了 {delta}%。"

    if kind == "mark_added":
        layers = _num(detail.get("layers"))
        name = _MARK.get(str(detail.get("mark")), str(detail.get("mark") or "印记"))
        return f"{side}获得了{name}" + (f"（{layers} 层）。" if layers else "。")

    if kind == "status_added":
        name = _STATUS.get(str(detail.get("status")), str(detail.get("status") or "异常状态"))
        layers = _num(detail.get("layers"))
        return f"{side}陷入{name}" + (f"（{layers} 层）。" if layers else "。")

    if kind == "status_applied":
        return f"{side}用{skill_name()}施加了效果。"

    if kind == "status_tick":
        name = _STATUS.get(str(detail.get("status")), str(detail.get("status") or "异常状态"))
        amount = _num(detail.get("damage"))
        if amount:
            return f"{side}因{name}损失约 {amount} 点生命。"
        return f"{side}受到{name}影响。"

    if kind == "cleanse":
        cleared = detail.get("cleared")
        n = len(cleared) if isinstance(cleared, (list, tuple)) else None
        return f"{side}清除了 {n} 个异常。" if n else f"{side}清除了异常。"

    if kind == "escape":
        return f"{side}选择逃跑。"

    if kind == "action_cancelled":
        reason = _CANCEL_REASON.get(str(detail.get("reason")), "行动无法执行")
        return f"{side}这一手没有打出去（{reason}）。"

    if kind == "game_end":
        result = detail.get("result")
        if result == "win":
            return "对局结束：我方获胜。"
        if result == "loss":
            return "对局结束：我方落败。"
        if result == "draw":
            return "对局结束：平局。"
        return "对局结束。"

    if kind == "power_unsupported":
        return f"{side}的{skill_name()}这次**没有结算**：引擎不支持这条效果（未核验，不猜数值）。"

    if kind == "status_unsupported":
        return f"{side}的{skill_name()}附加效果**没有结算**（未核验，不猜时序）。"

    if kind == "unsupported":
        what = detail.get("what") or detail.get("reason") or "一条未核验的机制"
        return f"这里有一条未核验的机制「{what}」，引擎按 fail closed 没有结算它。"

    # 未知 kind **不静默**：交给测试去红，运行时给一句诚实的兜底
    return f"发生了一件事（引擎事件 {kind or '未知'}，本页还没有它的中文说法）。"


#: 引擎可能产出的**全部** kind。`test_event_text.py` 会跑真对局收一遍，
#: 与这个集合对不上就红——漏一个 kind 就意味着玩家会看到一句兜底话。
KNOWN_EVENT_KINDS = frozenset({
    "turn_start", "damage", "faint", "heal", "energy_regen", "drain_energy", "item",
    "switch", "replacement", "defense", "buff_self", "debuff_foe", "mark_added",
    "status_added", "status_applied", "status_tick", "cleanse", "escape",
    "action_cancelled", "game_end", "power_unsupported", "status_unsupported", "unsupported",
    # 第 47 轮批 0 补：攻击/防御分支的附带效果现在「生效或登记」，
    # 于是多出这两个 kind（`env._apply_effect_batch` / `env._register_parsed_effects`）。
    "energy_gain", "effects_registered_unsupported",
    # 效果层/特性层直接塞进事件列表的那一类（扁平形状，没有 `detail`）
    "trait",
})
