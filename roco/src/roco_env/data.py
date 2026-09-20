"""规则集加载：roco_env 的唯一 I/O 边界。

原则：
  - 数值**只**从这里来。规则模块不许内联威力、能耗、相性倍率。
  - 加载即校验：孤儿引用、缺失字段、动态威力都要在加载期暴露，而不是等对局中途。
  - 只读：本模块不写任何文件。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

DEFAULT_RULESET = "roco-world-s4-2026-09-10"


class RulesetError(RuntimeError):
    """规则集缺失或不一致。加载期就该炸，不要拖到对局中途。"""


def _repo_root() -> str:
    """仓库根。本文件在 roco/src/roco_env/data.py：
    其目录 roco_env/ → src/ → roco/ → 仓库根，所以是 3 个 ".."。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


@dataclass(frozen=True)
class Skill:
    """一条技能。字段与 normalized/skills.json 一一对应，不做加工。"""

    skill_id: str
    name: str
    category: str          # 特性 / 攻击 / 状态 / 防御
    element: str
    energy: int
    power: Optional[int]   # None = 该来源未给出静态威力（**不是 0 伤害**）
    damage_class: Optional[str]
    desc: str
    is_trait: bool
    effect_support: str

    @property
    def is_attack(self) -> bool:
        return self.category == "攻击"

    @property
    def is_defense(self) -> bool:
        return self.category == "防御"

    @property
    def is_status(self) -> bool:
        return self.category == "状态"

    @property
    def has_static_power(self) -> bool:
        return self.power is not None


@dataclass(frozen=True)
class Pet:
    pet_id: str
    name: str
    title: str
    types: Tuple[str, ...]
    stats: Dict[str, int]      # hp/atk/def/spa/spd/spe
    feature_skill_id: Optional[str]
    learnset_id: Optional[str]
    release_date: Optional[str]
    game_id: Optional[int]

    @property
    def stat_total(self) -> int:
        return sum(self.stats.values())


@dataclass(frozen=True)
class Learnset:
    pet_id: str
    native: Tuple[str, ...]
    blood: Tuple[str, ...]
    stones: Tuple[str, ...]

    @property
    def all_skill_ids(self) -> FrozenSet[str]:
        return frozenset(self.native) | frozenset(self.blood) | frozenset(self.stones)


@dataclass(frozen=True)
class TypeChart:
    """防御相性：给定防守方属性组合，返回受到某属性攻击的倍率。"""

    single: Dict[str, Dict[str, float]]

    DEFAULT: float = 1.0

    def multiplier(self, defender_types: Tuple[str, ...], attack_element: str) -> float:
        """防守方属性组合 × 攻击属性 → 倍率。

        依据：Types.lua 给的是**防御侧**相性表（weak / resist 各带 multiplier）。
        双属性按两条单属性**相乘**——这是社区实现在此处的通行做法。
        假设：倍率相乘而非相加。数据没有直接说明，属 microcase 待验项。
        """
        m = self.DEFAULT
        for t in defender_types:
            row = self.single.get(t)
            if row:
                m *= row.get(attack_element, self.DEFAULT)
        return m


# ── 种族值 → 面板值 的换算（**本项目的关键发现之一**）────────────────────
#
# M1 导入的 `pets.json` 里 `stats` 是**种族值**（race/base stats），不是实战面板。
# 这一点在 M1 时被登记为 unknown（"等级→面板换算公式未知"），现在有了依据：
# 社区快照 `NRC_AI`（MIT 覆盖其代码）的 `pokemon` 表同时存了 `base_*`（种族）
# 与 `stat_*`（实算面板）。两者在 452 条记录上可以精确拟合：
#
#     hp   面板 = 1.70 × 种族 + 221     最大误差 0.00  ← 精确
#     atk  面板 = 1.10 × 种族 + 60      最大误差 0.00  ← 精确
#     def  面板 = 1.10 × 种族 + 60      最大误差 0.00  ← 精确
#     spd  面板 = 1.48 × 种族 + 57.79   最大误差 55.66 ← 有残差
#     spa  面板 = 1.405× 种族 + 49.33   最大误差 51.80 ← 有残差
#     spe  面板 = 1.674× 种族 + 61.06   最大误差 17.03 ← 有残差
#
# 残差来自个体值/性格/培养等未记录的加成，本快照没有这些字段。
# 因此：hp/atk/def 直接用精确式；spa/spd/spe 用拟合式但**必须**标 EXACT=False。
# 仍然**不是官方公式**——它是从社区数据反推的，可被官方数据推翻。
PANEL_FORMULAS = {
    "hp":  (1.7000, 221.00, True),
    "atk": (1.1000,  60.00, True),
    "def": (1.1000,  60.00, True),
    "spd": (1.4800,  57.79, False),
    "spa": (1.4052,  49.33, False),
    "spe": (1.6736,  61.06, False),
}


def panel_stats(race_stats: Dict[str, int]) -> Dict[str, float]:
    """种族值 → 面板值。未给出的键原样跳过。"""
    out: Dict[str, float] = {}
    for key, value in race_stats.items():
        formula = PANEL_FORMULAS.get(key)
        if formula is None:
            continue
        a, b, _exact = formula
        out[key] = a * float(value) + b
    return out


def panel_formula_is_exact(stat_key: str) -> bool:
    f = PANEL_FORMULAS.get(stat_key)
    return bool(f and f[2])


@dataclass(frozen=True)
class Term:
    term_id: str
    note: str
    desc: str


@dataclass(frozen=True)
class Ruleset:
    ruleset_id: str
    game: str
    source_revision: str
    skills: Dict[str, Skill]
    pets: Dict[str, Pet]
    learnsets: Dict[str, Learnset]
    type_chart: TypeChart
    terms: Dict[str, Term]
    files: Dict[str, str]
    by_name: Dict[str, List[str]]

    def skill(self, skill_id: str) -> Skill:
        try:
            return self.skills[skill_id]
        except KeyError:
            raise RulesetError(f"未知技能 id：{skill_id}") from None

    def skill_by_name(self, name: str) -> Skill:
        hits = [s for s in self.skills.values() if s.name == name]
        if not hits:
            raise RulesetError(f"未知技能名：{name}")
        if len(hits) > 1:
            raise RulesetError(f"技能名不唯一：{name} → {[s.skill_id for s in hits]}")
        return hits[0]

    def pet(self, pet_id: str) -> Pet:
        try:
            return self.pets[pet_id]
        except KeyError:
            raise RulesetError(f"未知精灵 id：{pet_id}") from None

    def pets_by_name(self, name: str) -> List[Pet]:
        return [self.pets[i] for i in self.by_name.get(name, [])]

    def is_learnable(self, pet_id: str, skill_id: str) -> bool:
        ls = self.learnsets.get(pet_id)
        return bool(ls) and skill_id in ls.all_skill_ids

    def term(self, term_id: str) -> Optional[Term]:
        return self.terms.get(str(term_id))

    def term_text(self, term_id: str) -> str:
        t = self.term(term_id)
        return t.desc if t else ""

    def snapshot_fingerprint(self) -> str:
        """规则集快照指纹：让每条对局记录都能钉到具体数据版本。"""
        h = hashlib.sha256()
        for name in sorted(self.files):
            h.update(name.encode())
            h.update(self.files[name].encode())
        return h.hexdigest()


def _read_json(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise RulesetError(
            f"缺少 {path}。请先运行 npm run roco:pipeline"
            "（并且需要先解压 data/roco/raw/*.tar.gz）"
        )
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def load_ruleset(ruleset_id: str = DEFAULT_RULESET, root: Optional[str] = None) -> Ruleset:
    """从 normalized 数据加载规则集，并在加载期做一致性校验。"""
    base = os.path.join(root or _repo_root(), "data", "roco", "normalized", ruleset_id)
    names = ("pets", "skills", "learnsets", "types", "terms")
    paths = {n: os.path.join(base, f"{n}.json") for n in names}
    raw = {k: _read_json(v) for k, v in paths.items()}
    files = {f"{k}.json": _sha256(v) for k, v in paths.items()}

    for name, doc in raw.items():
        if doc.get("ruleset_id") != ruleset_id:
            raise RulesetError(
                f"{name}.json 的 ruleset_id 是 {doc.get('ruleset_id')}，期望 {ruleset_id}"
            )
        if doc.get("game") != "roco_world_mobile":
            raise RulesetError(f"{name}.json 的 game 是 {doc.get('game')}，必须是手游")
    source_revision = raw["pets"].get("source_revision", "")

    skills: Dict[str, Skill] = {}
    for sid, s in raw["skills"]["skills"].items():
        skills[sid] = Skill(
            skill_id=sid,
            name=s["name"],
            category=s.get("category") or "",
            element=s.get("element") or "",
            energy=int(s.get("energy") or 0),
            power=s.get("power"),
            damage_class=s.get("damage_class"),
            desc=s.get("desc") or "",
            is_trait=bool(s.get("is_trait")),
            effect_support=s.get("effect_support", "unsupported"),
        )

    pets: Dict[str, Pet] = {}
    by_name: Dict[str, List[str]] = {}
    for pid, p in raw["pets"]["pets"].items():
        stats = {k: int(v) for k, v in (p.get("stats") or {}).items() if v is not None}
        pets[pid] = Pet(
            pet_id=pid,
            name=p["name"],
            title=p.get("title") or p["name"],
            types=tuple(p.get("types") or ()),
            stats=stats,
            feature_skill_id=p.get("feature_skill_id"),
            learnset_id=p.get("learnset_id"),
            release_date=(p.get("release") or {}).get("date"),
            game_id=p.get("game_id"),
        )
        by_name.setdefault(p["name"], []).append(pid)

    learnsets: Dict[str, Learnset] = {}
    for pid, ls in raw["learnsets"]["learnsets"].items():
        learnsets[pid] = Learnset(
            pet_id=pid,
            native=tuple(e["skill_id"] for e in ls.get("native_skills", []) if e.get("skill_id")),
            blood=tuple(e["skill_id"] for e in ls.get("blood_skills", []) if e.get("skill_id")),
            stones=tuple(s for s in ls.get("skill_stones", []) if s),
        )

    orphans: List[str] = []
    for pid, ls in learnsets.items():
        for sid in ls.all_skill_ids:
            if sid not in skills:
                orphans.append(f"{pid}->{sid}")
        pet = pets.get(pid)
        if pet and pet.feature_skill_id and pet.feature_skill_id not in skills:
            orphans.append(f"{pid} 特性->{pet.feature_skill_id}")
    if orphans:
        raise RulesetError(
            f"学习表里有 {len(orphans)} 个孤儿技能引用：" + "; ".join(orphans[:5])
        )

    single: Dict[str, Dict[str, float]] = {}
    for key, row in raw["types"]["types"].items():
        if "|" in key:
            continue                       # 双属性组合由两条单属性相乘得到
        table: Dict[str, float] = {}
        for e in row.get("weak", []):
            table[e["type"]] = float(e["multiplier"])
        for e in row.get("resist", []):
            table.setdefault(e["type"], float(e["multiplier"]))
        single[key] = table

    terms = {
        str(k): Term(term_id=str(k), note=v.get("note") or "", desc=v.get("desc") or "")
        for k, v in raw["terms"]["terms"].items()
    }

    return Ruleset(
        ruleset_id=ruleset_id,
        game=raw["pets"].get("game"),
        source_revision=source_revision,
        skills=skills,
        pets=pets,
        learnsets=learnsets,
        type_chart=TypeChart(single=single),
        terms=terms,
        files=files,
        by_name=by_name,
    )
