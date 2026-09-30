"""个体层（Q8）：把产品发下来的**个体快照**换算成战斗面板 —— 与列表/详情读**同一份投影**。

人类逐字（要求④）：「**同一个体**列表详情 / 培养刷新 / **战斗实际 stats** / 小芽工具 / 推荐
读同一规则同一投影」，而且「**必须把选中的 instanceID 和培养快照连入规则投影**，
实例重复物种时**不能只靠 speciesID 推断来源**」。

数字的唯一来源（这一条是纪律，不是注释）：
  · **种族值**：规则集里的 `pets.json`（引擎本来就用它，`rs.pet(pid).stats`）；
  · **性格 → 系数**：`data/roco/systems/natures.json` —— 与前端的
    `src/coach/natures-data.js` 是**同一份源**（前端那份由 `scripts/roco/sync-browser-data.mjs`
    从这个 JSON 生成），所以这里直接读同一个文件，不抄第二份性格表；
  · **面板公式**：前端 `src/coach/talent.js` 的 `LEVEL_FORMULA` + `STAR_BREAKTHROUGH`
    （PVP 档 = 满级 60 + 满突破 5 星 + 资质 ×6）。

⚠ **公式在 JS 与 Python 各有一份实现**（前端要能在浏览器里算，引擎要能在服务端算）。
这是本仓最忌讳的"第二个真相"，所以：
  · 这里逐行照抄 `panelOf()` 的**取整顺序**（`round(内层) → +base → ×性格 → round → +add`），
    不是"看起来差不多"；
  · 判据 `roco/tests/test_individual_panel.py` 用**前端算出来的固定数值**逐项钉住两侧相同
    （那些数值是拿 `node -e` 跑 `panelOfIndividual` 得到的，见该测试文件顶部）；
  · 任何一侧改公式，那个测试必须红 —— 红了就回来同步这一份。
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Tuple

#: 这一份投影的**版本号**（正例要求「两侧逐字相同 **+ 版本号一致**」）。
#: 口径变了就改它，并在回执里带出去 —— 让调用方能判断"这份数字是哪条口径算的"。
PROJECTION_VERSION = "panel-pvp-60-5star/v1"

#: 六维顺序与中文名（与 `natures.json` 的 `stat_order` / `stat_names` 同源；
#: 这里只作为**缺文件时的兜底**，正常路径一律读文件）。
_STAT_ORDER_FALLBACK = ("hp", "atk", "spa", "def", "spd", "spe")

#: 前端 `LEVEL_FORMULA`（`src/coach/talent.js:168`）逐值照抄。
#: ⚠ 生命的 race/talent 系数与其它项**相同**（1 / 3），区别只在括号外：
#: 生命 `(L+25)/50 + 70 + 100`，其它 `(L+50)/100 + 10 + 50`。历史上一度把生命写成 2/6，
#: 那会让 120 种族值的生命在 60 级算出 622（正确 425）—— 前端判据里钉着这条。
LEVEL_FORMULA: Dict[str, Dict[str, float]] = {
    "hp": {"race": 1.0, "talent": 3.0, "level": 25.0, "base": 70.0, "add": 100.0, "divisor": 50.0},
    "other": {"race": 1.0, "talent": 3.0, "level": 50.0, "base": 10.0, "add": 50.0, "divisor": 100.0},
}

#: PVP 归一化档：满级（官方口径等级上限 60）+ 5 星资质放大 6 倍。
PVP_LEVEL = 60
PVP_STARS = 5
STAR_TALENT_FACTOR = 6.0
#: ⚠ **突破次数默认 0**（不是 5）—— 这一点是拿前端实测出来的，别按直觉改：
#: 列表/详情那一侧用的是 `panelOfIndividual()` → `panelOf({scope:'pvp'})`，而 `panelOf`
#: 的 `breakthrough` **缺省是 `null`** ⇒ 性格增益按**零突破下界 +10%** 算（并把这件事写进
#: `unknown`）。`pvpPanelOf()` 才传满突破 5（+20%），但**盒子页面那条路径不走它**。
#: 2026-09-29 实测（喵喵/寂灭骨龙三个样例）：按 5 算速度会给 379，前端给 351 = 按 0 算。
#: 两侧要"逐字相同"，就只能照前端的口径来 —— 这一条写在这里，免得下一个人"顺手修正"。
PVP_BREAKTHROUGH = 0

#: 快照里六维的取值范围（天分那一档是 0–10；`talent.js` 的 `TALENT_RANGE`）。
TALENT_MIN, TALENT_MAX = 0, 10


def _repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def natures_path() -> str:
    return os.path.join(_repo_root(), "data", "roco", "systems", "natures.json")


_NATURES_CACHE: Optional[Dict[str, Any]] = None


def load_natures() -> Dict[str, Any]:
    """读性格表（`data/roco/systems/natures.json`，与前端同一份源）。

    返回 `{"order": (...), "names": {...}, "modifier": {...}, "natures": {name: {"up","down"}}}`。
    读不到就抛 —— **不许**拿一份内置表兜底：兜底表就是第二个真相。
    """
    global _NATURES_CACHE
    if _NATURES_CACHE is not None:
        return _NATURES_CACHE
    with open(natures_path(), "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    order = tuple(str(x) for x in (raw.get("stat_order") or _STAT_ORDER_FALLBACK))
    table: Dict[str, Dict[str, Optional[str]]] = {}
    for row in raw.get("natures") or []:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        table[name] = {"up": row.get("up"), "down": row.get("down")}
    if not table:
        raise ValueError(f"{natures_path()} 里没有性格数据")
    _NATURES_CACHE = {
        "order": order,
        "names": {str(k): str(v) for k, v in (raw.get("stat_names") or {}).items()},
        "modifier": dict(raw.get("modifier") or {}),
        "natures": table,
    }
    return _NATURES_CACHE


def js_round(value: float) -> int:
    """JavaScript 的 `Math.round`（.5 向 +∞；Python 的 `round` 是银行家取整，不能用）。

    面板里所有参与取整的量都是非负数（种族值/天分/等级/性格系数），所以
    `floor(x + 0.5)` 与 JS 逐值相同。
    """
    return int(math.floor(value + 0.5))


def _num_or_null(value: Any) -> Optional[float]:
    """照抄前端的 `numOrNull`：`null`/空串/非数值都是 **None**（不是 0）。

    ⚠ `Number(null) === 0`、`Number('') === 0` —— 直接把"没这一项"当成 0 会算出偏低的面板，
    前端判据⑤当场抓到过这一条。
    """
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def nature_factor(name: Optional[str], stat: str, *, breakthrough: Optional[int] = PVP_BREAKTHROUGH
                  ) -> Tuple[float, bool, str]:
    """性格对某一项的系数（未知性格 = 中性 1.0，并如实记原因）。

    PVP 档按**满突破 5**：提升侧 `min(0.10 + 0.02×5, 0.20) = +20%`、降低侧固定 `−10%`；
    与 `natures.json` 的 `modifier`（up 0.2 / down −0.1 / neutral 1.0）一致 ——
    这里仍按"初始 +10%、每突破 +2%"算一遍，是为了与前端的 `natureFactor` **同一条算式**，
    参数一变（例如以后拿到每只的突破次数）两边一起动。
    """
    table = load_natures()
    row = table["natures"].get(str(name or "").strip())
    modifier = table["modifier"]
    if row is None:
        return 1.0, False, (f"认不出性格「{name}」" if name else "这一只还没填性格")
    steps = 0 if breakthrough is None else max(0, min(5, int(breakthrough)))
    up = min(0.10 + 0.02 * steps, float(modifier.get("up", 0.20)))
    down = float(modifier.get("down", -0.10))
    neutral = float(modifier.get("neutral", 1.0))
    if row.get("up") == stat:
        return 1.0 + up, True, f"{name}：{stat} 是长处（+{js_round(up * 100)}%）"
    if row.get("down") == stat:
        return 1.0 + down, True, f"{name}：{stat} 是短处（{js_round(down * 100)}%）"
    return neutral, True, f"{name}：{stat} 不受影响"


def panel_from_snapshot(race: Dict[str, Any], snapshot: Dict[str, Any], *,
                        level: int = PVP_LEVEL, breakthrough: Optional[int] = PVP_BREAKTHROUGH,
                        stars: int = PVP_STARS) -> Dict[str, Any]:
    """个体快照 → 六维面板（**与前端 `panelOfIndividual` 逐值相同**）。

    `race` 用规则集里的种族值（六项）；`snapshot` 用产品发下来的个体快照
    （`individualFromInstance` 的产物：`talent` 六项 0–10、`nature` 性格名）。

    返回 `{"panel": {...}, "unknown": [...], "sources": [...], "projection": ...}`：
      · 算得出的项进 `panel`；算不出的项**不出现**（不是 0 —— 0 会被下游当成真值）；
      · `unknown` 逐条写清缺什么。
    """
    unknown: List[str] = []
    if breakthrough is None:
        # 与前端 `panelOf()` 逐字同一条提示：不知道这只突破到第几段 ⇒ 按零突破下界算。
        unknown.append("不知道这只突破到第几段 ⇒ 性格增益按**零突破下界**算"
                       "（初始 +10%、每突破 +2%、满 +20%）")
    if stars != PVP_STARS:
        raise ValueError(f"只支持 PVP 档 {PVP_STARS} 星（实际 {stars!r}）—— 1–4 星的资质上限本仓没有数据")
    if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= PVP_LEVEL:
        raise ValueError(f"等级 {level!r} 不在 1–{PVP_LEVEL} 之内（等级上限 60 是官方口径）")
    if not isinstance(race, dict) or not race:
        return {"panel": {}, "unknown": ["没有种族值 ⇒ 面板算不出来（不拿 0 顶）"],
                "sources": [], "projection": PROJECTION_VERSION}
    talent = snapshot.get("talent") if isinstance(snapshot, dict) else None
    if not isinstance(talent, dict):
        unknown.append("这一只还没填天分（个体值）⇒ 按 0 计入，面板偏低，别当成实测值")
        talent = {}
    nature = snapshot.get("nature") if isinstance(snapshot, dict) else None

    table = load_natures()
    panel: Dict[str, int] = {}
    for stat in table["order"]:
        race_value = _num_or_null(race.get(stat))
        if race_value is None:
            unknown.append(f"种族值缺「{stat}」⇒ 这一项不算")
            continue
        talent_value = _num_or_null(talent.get(stat))
        talent_value = 0.0 if talent_value is None else talent_value
        shape = LEVEL_FORMULA["hp" if stat == "hp" else "other"]
        factor, known, reason = nature_factor(nature, stat, breakthrough=breakthrough)
        if not known:
            unknown.append(f"性格：{reason}")
        coefficient = shape["talent"] * STAR_TALENT_FACTOR
        scaled = (shape["race"] * race_value + coefficient * talent_value) \
            * (level + shape["level"]) / shape["divisor"]
        panel[stat] = js_round((js_round(scaled) + shape["base"]) * factor) + int(shape["add"])
    return {
        "panel": panel,
        "unknown": list(dict.fromkeys(unknown)),
        "sources": ["ruleset:pets.json（种族值）", "data/roco/systems/natures.json（性格）",
                    "src/coach/talent.js LEVEL_FORMULA + STAR_BREAKTHROUGH（面板公式，Python 侧照抄）"],
        "projection": PROJECTION_VERSION,
        "level": level,
        "breakthrough": 0 if breakthrough is None else breakthrough,
        "stars": stars,
    }


# ── 快照的接入与校验（`/battle/new` 的 `individuals`）────────────────────────


def _snapshot_problems(instance_id: str, row: Any) -> List[str]:
    """一条快照的形状问题（**说清哪里不对**，不静默忽略）。"""
    problems: List[str] = []
    where = f"individuals[{instance_id!r}]"
    if not isinstance(row, dict):
        return [f"{where} 必须是对象（个体快照），实际 {type(row).__name__}"]
    species = row.get("species_id")
    if not isinstance(species, str) or not species.strip():
        problems.append(f"{where}.species_id 必须是非空字符串 —— 引擎靠它把这只要和队伍里的位次对上")
    level = row.get("level")
    if level is not None and (not isinstance(level, int) or isinstance(level, bool)
                              or not 1 <= level <= PVP_LEVEL):
        problems.append(f"{where}.level 必须是 1–{PVP_LEVEL} 的整数或省略（实际 {level!r}）")
    nature = row.get("nature")
    if nature is not None and not isinstance(nature, str):
        problems.append(f"{where}.nature 必须是字符串或 null（实际 {type(nature).__name__}）")
    talent = row.get("talent")
    if talent is not None:
        if not isinstance(talent, dict):
            problems.append(f"{where}.talent 必须是六维（hp/atk/spa/def/spd/spe）的对象或 null")
        else:
            for key, value in talent.items():
                if key not in _STAT_ORDER_FALLBACK:
                    problems.append(f"{where}.talent 里有引擎不认识的一项 {key!r}")
                    continue
                num = _num_or_null(value)
                if num is None or not TALENT_MIN <= num <= TALENT_MAX:
                    problems.append(f"{where}.talent.{key} 必须是 {TALENT_MIN}–{TALENT_MAX} 的数字"
                                    f"（实际 {value!r}）")
    return problems


def resolve_snapshots(raw: Any, team: List[str]) -> Tuple[Dict[int, Dict[str, Any]], List[str]]:
    """把 `individuals` 对到队伍**位次**上，返回 `({slot: 快照}, 问题列表)`。

    为什么按位次而不是物种：产品那一跳（`src/server/roco-service.js`）把
    `individuals` 按 `resolvedTeam` **原顺序**塞进 map（键 = 实例 id，如 `own-0001`），
    而 `team` 已经被换算成物种 id。同一物种可以出现两次 ⇒ **只按 species_id 找会串位**
    （人类逐字：「实例重复物种时不能只靠 speciesID 推断来源」）。
    所以这里的规则是：**按插入顺序逐位对齐，并用 `species_id` 交叉核对**；
    对不上的那一条**报出来**（点名实例 id、它的物种、队伍里的物种），不猜、不静默丢。
    """
    if raw is None:
        return {}, []
    if not isinstance(raw, dict):
        return {}, [f"individuals 必须是 {{实例 id: 个体快照}} 的对象，实际 {type(raw).__name__}"]
    problems: List[str] = []
    rows: List[Tuple[str, Dict[str, Any]]] = []
    for instance_id, row in raw.items():
        found = _snapshot_problems(str(instance_id), row)
        if found:
            problems.extend(found)
            continue
        rows.append((str(instance_id), row))
    if problems:
        return {}, problems

    out: Dict[int, Dict[str, Any]] = {}
    used: set = set()
    for instance_id, row in rows:
        species = str(row["species_id"])
        # 先按"下一个还没被占、且物种相同"的位次对齐（同一物种重复时按插入顺序取下一个）
        slot = next((i for i, pid in enumerate(team)
                     if i not in used and pid == species), None)
        if slot is None:
            problems.append(
                f"individuals[{instance_id!r}] 的物种 {species} 在己方队伍 {team} 里没有还没配对的位置"
                " —— 实例与位次对不上（不许按物种猜一个）")
            continue
        used.add(slot)
        out[slot] = dict(row, individual_id=str(row.get("individual_id") or instance_id))
    return out, problems
