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
#: PVP 魔法的 id → 中文名。读不到就写「PVP 魔法」（不编一个名字）。
_MAGIC = {
    "wish_power_up": "愿力强化",
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
        # 2026-09-24（824 条技能名全量扫描发现）：技能名直接接动词时会被读成叠词 ——
        # 实测「奔波命」「蒸汽革命」渲染成「我方的奔波命命中，…」。技能名一律加「」
        # 括起来（与本文件 magic 分支的写法一致），这类叠词在结构上就不可能再出现。
        parts = [f"{who}「{skill_name()}」命中"]
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
            # 同上：技能名加「」。这一支更彻底 —— 技能「回收」原来的渲染是
            # 「我方用回收回收了 1 点能量」，两个「回收」挨着读起来像结巴；
            # 动词换成「获得」之后连字符都不再重复（`self_energy` 的语义本来就是
            # 「自己回复/获得N能量」，见 parse.py 的 `_SELF_ENERGY`）。
            return f"{side}用「{skill_name()}」获得 {amount} 点能量{tail}。"
        return f"{side}用「{skill_name()}」回能，但已达上限{tail}。"

    # ── RC-106 补的三类：六宠标准 PVP 局里真的会出现，但一直没有句子 ──────────
    #
    # 口径与全文一致：只陈述**事实**（做了哪个动作、数值是多少、哪一条还没核验），
    # 不写「好/坏/该不该」—— 引擎没有依据判断一个动作好不好，页面也不该替它判断。

    if kind == "charge":
        # `env._use_charge` 的 detail：{side, energy_gained, energy}
        gained = _num(detail.get("energy_gained"))
        now = _num(detail.get("energy"))
        if gained is not None and now is not None:
            body = f"{side}选择聚能，回复 {gained} 点能量（当前 {now} 点）"
        elif now is not None:
            body = f"{side}选择聚能（当前 {now} 点能量）"
        else:
            body = f"{side}选择聚能"
        # 「聚能是否可突破上限 / 无合法技能时是否自动聚能」是 MC-E02 未解项：
        # 引擎按「夹到能量上限」处理，这一点必须写在句子里，不许说成规则。
        return body + "（聚能回能上限与自动聚能未核验，本局按夹到能量上限处理）。"

    if kind == "slot_condition_applied":
        # C1（第 139 轮）位置子系统：`env._execute` 的 detail：
        # {side, skill_id, position, power_delta, combo_bonus, evidence}
        pos = _num(detail.get("position"))
        power = _num(detail.get("power_delta"))
        combo = _num(detail.get("combo_bonus"))
        bits = []
        if power:
            bits.append(f"威力 +{int(power)}")
        if combo:
            bits.append(f"连击 +{int(combo)}")
        where = f"{side}这一手用的是第 {int(pos)} 号位技能" if pos is not None else f"{side}触发了号位条件"
        return f"{where}，{'、'.join(bits) if bits else '获得加成'}（号位条件按描述原文结算，未实机核实）。"

    if kind == "position_shift":
        # C1：传动 —— 用后这个技能在配招里移位（位置变了，号位条件也随之变）。
        shift = _num(detail.get("shift"))
        # ⚠ 玩家句子里**不许出现技能 id**（`test_event_text` 有专门的判据）。
        # 新顺序留在事件的 `detail.order` 里（开发者抽屉读它），句子里只说「顺序变了」。
        return (f"{side}这一手用完后，技能在配招里传动了 "
                f"{int(shift) if shift is not None else '?'} 位（顺序已变，新顺序见调试信息）"
                "（传动语义按描述原文结算，未实机核实）。")

    if kind == "mana_loss":
        # `env._settle_faint_mana` 的 detail：{side, faint_cost, mana}
        # 注意这里的 side 是**力竭的那一方**，不是视角方 —— 与 faint 事件同一口径。
        cost = _num(detail.get("faint_cost"))
        left = _num(detail.get("mana"))
        if cost is not None and left is not None:
            head = f"{side}的精灵力竭，失去 {cost} 点魔力（剩余 {left} 点）"
        elif cost is not None:
            head = f"{side}的精灵力竭，失去 {cost} 点魔力"
        elif left is not None:
            head = f"{side}的精灵力竭，魔力剩余 {left} 点"
        else:
            head = f"{side}的精灵力竭，魔力发生变化"
        # 台账等级是 CROSS_SOURCE_SUPPORTED（不是官方原文），所以句子标出来。
        return head + "（力竭扣魔力未实机核实，本条为候选口径）。"

    if kind == "surrender":
        # `env._surrender` 的 detail：{side, result}
        # 句子只说「哪一方投降、对局结束」——**不**把 result 翻成「我方获胜/落败」：
        # 那是视角相关的话，而这个模板拿不到安全的视角（side 是投降的那一方）。
        # 「投降方判负」这条语义本身是 ENGINE_HYPOTHESIS（台账没有条目），
        # 所以也不在这里把它说成规则。
        return f"{side}投降，对局结束（投降的结算语义未核验，本局按投降方判负处理）。"

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

    if kind == "magic":
        # 2026-09-23：PVP 魔法（愿力强化）。两种模式：转换第一个技能 / 解除还原。
        # 文案只说**己方**看得到的事（人类口径：对手看不见你用了这件道具；
        # 而这条事件本来就只进玩家自己的战报）。
        magic_name = _MAGIC.get(str(detail.get("magic")), "PVP 魔法")
        # 精灵名来自 detail（引擎给的），没有就退回「场上精灵」——**不**把内部 id 印给玩家。
        who = detail.get("pet_name") or "场上精灵"
        if detail.get("mode") == "restore":
            # ⚠ 2026-09-24（真页面抓到的文案缺陷）：`restore` 有**两个**来源，不能一律说成
            # 「用愿力强化解除…（进入冷却）」——
            #   · `reason == "consumed"`：这一手把愿力冲击**打了出去**，第一个技能自动还回去。
            #     玩家根本没点愿力强化、也没进冷却（次数在换的时候已经扣过）；
            #   · 其余（手动解除，`reason == "manual"` 或没有 reason）：才是「再用一次愿力强化解除」。
            if str(detail.get("reason") or "") == "consumed":
                return f"{who}的愿力冲击已打出，第一个技能自动还原。"
            return f"{side}用{magic_name}解除了{who}的技能转换，第一个技能还原（不消耗次数，进入冷却）。"
        skill_name = detail.get("skill_name") or None
        if skill_name:
            return f"{side}用{magic_name}把{who}的第一个技能换成了「{skill_name}」。"
        return f"{side}用了一次{magic_name}。"

    if kind == "switch":
        slot = detail.get("to_slot")
        target = f"第 {int(slot) + 1} 位" if isinstance(slot, int) else "另一只"
        return f"{side}换上{target}精灵。"

    if kind == "replacement":
        slot = detail.get("slot")
        target = f"第 {int(slot) + 1} 位" if isinstance(slot, int) else "一只"
        return f"{side}补上了{target}精灵。"

    if kind == "defense":
        # 2026-09-24（真页面战报抓到两处）：这一句原来写成
        #     f"{side}用{skill_name()}防御，减伤约 {reduction}{hand}。"
        # 两个毛病：
        #   ① 技能名后面**硬写**「防御」二字 —— 技能本身叫「防御」时读成「用防御防御」；
        #   ② 把**减伤比例**（0.7）直接印出来，而引擎自己的 `state.log` 与页面盾浮字
        #      都是 70% —— 同一个数三处口径不一致，玩家看到的那一处是错的。
        # 现在统一到百分比，且技能名后面不再接「防御」二字。
        reduction = detail.get("reduction")
        pct = None
        if isinstance(reduction, (int, float)) and not isinstance(reduction, bool):
            pct = f"{float(reduction) * 100:.0f}%"
        hand = "，并作出应对" if detail.get("respond") else ""
        if pct is not None:
            # 「约」字保留：减伤来自未核验的公式，不写成一个确定的事实。
            return f"{side}使用{skill_name()}，本回合减伤约 {pct}{hand}。"
        return f"{side}使用{skill_name()}，转入防御{hand}。"

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

    if kind == "lifesteal":
        amount = _num(detail.get("healed"))
        pct = _num(detail.get("percent"))
        tail = "（已满血，回复溢出）" if detail.get("overhealed") else ""
        return f"{side}吸血回复了 {amount} 点生命（{pct}%）{tail}。"

    if kind == "overheal_to_stat":
        stat = _stat(detail.get("stat"))
        gain = _num(detail.get("gain_pct"))
        return f"{side}把过量回复转化成了{stat} +{gain}%。"

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

    # ── 天气（2026-09-25 裁决 B：天气进标准 PVP）──────────────────────────────
    # 引擎从 `env.set_weather` / `_end_turn_weather` 产出这 5 个 kind。它们的模板一度缺席：
    # 因为**规范配招里没有任何一只是造天气的**，真对局根本跑不出天气，`test_event_text`
    # 的「真对局收 kind」那条判据也就照不到它们。主线程用 `loadouts` 给圆号鱼显式换上
    # 「落雨」之后，才在真服务里打出 `weather_set` / `weather_tick`（记载见 §C6.176）。
    # 玩家面前不能出现「本页还没有它的中文说法」，所以逐条给句子并进 KNOWN_EVENT_KINDS。
    if kind == "weather_set":
        name = str(detail.get("weather") or "")
        turns = _num(detail.get("turns_left"))
        who = _side(detail.get("side"))
        replaced = detail.get("replaced")
        body = f"{who}把天气改成了{name}" if name else "天气发生了变化"
        note = []
        if turns:
            note.append(f"持续 {turns} 回合")
        if replaced and replaced != name:
            note.append(f"{replaced}结束")
        if note:
            body += f"（{'，'.join(note)}）"
        return body + "。"

    if kind == "weather_tick":
        name = str(detail.get("weather") or "")
        turns = _num(detail.get("turns_left"))
        if not name:
            return "天气的剩余回合数在走。"
        # 引擎给的是**减 1 之后**的剩余回合数：0 表示这一回合末就到点（随后会有 weather_end），
        # 所以 0 不能念成「还剩 0 回合」。
        if turns and turns != "0":
            return f"{name}还剩 {turns} 回合。"
        return f"{name}到点了。" if turns == "0" else f"{name}这一回合结束。"

    if kind == "weather_end":
        name = str(detail.get("weather") or "")
        return f"{name}结束了。" if name else "天气结束了。"

    if kind == "weather_status":
        name = str(detail.get("weather") or "")
        status = _STATUS.get(str(detail.get("status")), str(detail.get("status") or "异常状态"))
        layers = _num(detail.get("layers"))
        after = _num(detail.get("layers_after"))
        who = _side(detail.get("side"))
        if not layers:
            return f"{who}因为{name}获得了{status}。" if name else f"{who}获得了{status}。"
        tail = f"（共 {after} 层）" if after else ""
        return f"{who}因为{name}获得 {layers} 层{status}{tail}。"

    if kind == "weather_immune":
        name = str(detail.get("weather") or "")
        status = _STATUS.get(str(detail.get("status")), str(detail.get("status") or "异常状态"))
        element = str(detail.get("immune_element") or "")
        who = _side(detail.get("side"))
        why = f"{element}系" if element else "该属性"
        return f"{who}是{why}，免疫{name}的{status}。"

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
    # RC-401 批四：吸血 / 过量回复转属性（`env._settle_sustain`）。
    "lifesteal", "overheal_to_stat",
    # RC-106 补：`env.py` 在 RC-105 就产出了这三个 kind（聚能 / 力竭扣魔力 / 投降），
    # 但模板一直缺席 —— 六宠标准 PVP 局跑起来时它们会以「本页还没有它的中文说法」
    # 出现在玩家面前。补模板的同时把这三个名字登记进来，测试因此才咬得住。
    "charge", "mana_loss", "surrender",
    # C1（第 139 轮）位置子系统：号位条件 + 传动。
    "slot_condition_applied", "position_shift",
    # 2026-09-23：PVP 魔法（愿力强化）转换/解除第一个技能
    # （台账 EV-PVP-WISH-POWER-UP；`env._use_magic`）。
    "magic",
    # 2026-09-25 裁决 B：天气进标准 PVP（`env.set_weather` / `_end_turn_weather`）。
    # 这五个 kind 曾经「引擎会发、模板缺席」，而且**判据照不到**（真对局跑不出天气，
    # 因为规范配招里没有造天气技能）——是主线程用 loadouts 显式换招才打出来的。
    "weather_set", "weather_tick", "weather_end", "weather_status", "weather_immune",
})
