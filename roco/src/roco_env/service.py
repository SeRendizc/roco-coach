#!/usr/bin/env python3
"""roco_env 本地规则服务 —— Node↔Python 桥的 Python 端。

只用标准库（``http.server`` / ``json`` / ``hashlib`` / ``os`` / ``signal`` 等），
没有任何第三方依赖。默认只监听 ``127.0.0.1``：这是本机开发工具，不是网络服务。

端点
----

    GET  /health         服务与规则集身份：ruleset_id + snapshot_fingerprint
    GET  /rules/query    只读事实查询（也接受 POST）
    POST /rules/query    只读事实查询：精灵 / 技能 / 学习表 / 属性相性 / 术语
    POST /team/evaluate  队伍强度评估        —— 引擎逻辑未实现 → not_implemented
    POST /team/compare   换人前后对比        —— 引擎逻辑未实现 → not_implemented
    POST /battle/plan    回合行动规划        —— 引擎逻辑未实现 → not_implemented

统一响应信封（**每个**响应都有，成功失败都一样）
------------------------------------------------

    {
      "protocol_version": 1,
      "service": "roco_env",
      "service_version": "0.1.0",
      "ok": true|false,
      "ruleset_id": "roco-world-s4-2026-09-10",
      "state_version": 0,
      "snapshot_fingerprint": "<sha256(五份 normalized json 的内容)>",
      "coverage": 1.0,               # 这次请求要求的机制里，引擎能真正算出来的比例
      "evidence_ids": ["ev:<ruleset>:pets.json#pet_000225", ...],
      "unsupported": [{"code": ..., "reason": ...}],
      "latency_ms": 3.1,             # 服务端自测耗时；客户端还会再测一次往返
      "error_type": null|"...",
      "error": null|"...",
      "result": {...}|null
    }

``error_type`` 词汇表（HTTP 状态在 ``ERROR_HTTP_STATUS``）
--------------------------------------------------------

    bad_request          400  请求体不合法（缺 ruleset_id / state_version、未知 kind）
    hidden_information   400  请求里出现对手待执行动作或真实随机种子（MC-013 不变量）
    not_found            404  规则集内部查不到这个 id
    ruleset_unsupported  404  本服务**声明的那个**规则集加载不了（该有的数据缺失/损坏）
    version_mismatch     409  请求的规则集 id 不是本服务声明的版本；或快照指纹对不上
    unsupported_effect   422  机制未核验/未实现 —— fail closed，绝不给默认数值
    not_implemented      501  端点对应的引擎逻辑还没写
    internal_error       500  未预期异常

**一个服务进程只服务一个规则集版本**（构造函数/`--ruleset` 声明）。
请求别的 id 一律 `version_mismatch`，不会去装载调用方点名的版本 ——
否则「这份回执对应哪个快照」就不再确定。

fail closed 的三条纪律
----------------------

1. **静态图鉴字段是数据，不是结论。** 技能的 ``power`` 原样返回并标
   ``power_status``；``effective_power`` / ``damage`` 一律 ``null``，
   因为官方伤害公式与条件化威力的取值时机都还没有来源（MC-010）。
2. **未核验机制一律 ``unsupported_effect`` / ``not_implemented``，``coverage = 0``，
   ``result = null``。** 绝不退化成「默认 40 威力普通攻击」这类自创默认值。
3. **双属性相性只用快照里显式给出的行。** 快照 ``types.json`` 有 102 条双属性行；
   其余 67 种组合没有行，本服务返回 ``unsupported``，
   **不**用「两条单属性相乘」补 —— 实测该假设与快照 41 处不符（2×2 快照封顶为 3）。

需要另一侧配合的一处接口
------------------------

``data.py`` 的 ``TypeChart`` 只装载单属性行（构造时 ``if "|" in key: continue``），
显式双属性行被丢弃，而它自带的 ``multiplier()`` 用「相乘」代替。
本服务为了**不做那个假设**，需要读快照里显式的双属性行；在 ``data.py`` 补
``TypeChart.combined`` 之前，这里用 ``_type_rows()`` 读一次 ``types.json``，
并用 ``rs.files["types.json"]`` 的 sha256 校验它没有在加载后变动。
这是**临时**的第二处只读 I/O，接口落地后应当整段删掉。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs

try:  # 作为包导入：python3 -m roco_env.service
    from .data import DEFAULT_RULESET, Ruleset, RulesetError, load_ruleset
except ImportError:  # 直接当脚本跑：python3 roco/src/roco_env/service.py
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from roco_env.data import DEFAULT_RULESET, Ruleset, RulesetError, load_ruleset  # type: ignore


PROTOCOL_VERSION = 1
SERVICE_NAME = "roco_env"
SERVICE_VERSION = "0.1.0"
MAX_BODY_BYTES = 1 << 20            # 1 MiB：本机工具，超过就是调用方出错了
NORMALIZED_FILES = ("pets", "skills", "learnsets", "types", "terms")

# error_type → HTTP 状态。调用方应当以响应体里的 error_type 为准，状态码只是传输层提示。
ERROR_HTTP_STATUS: Dict[str, int] = {
    "bad_request": 400,
    "hidden_information": 400,
    "not_found": 404,
    "ruleset_unsupported": 404,
    "version_mismatch": 409,
    "unsupported_effect": 422,
    "not_implemented": 501,
    "internal_error": 500,
}

# 能力清单：true 表示这个能力**现在**就能给出可核验的答案。
# 引擎逻辑写完后把对应项改成 true，并同步补 microcase。
CAPABILITIES: Dict[str, bool] = {
    "rules.query_catalog": True,        # 精灵/技能/学习表/术语：纯静态数据
    "rules.query_type_chart": True,     # 相性：只用快照显式行
    "mechanics.resolve_effect": False,  # 效果原语（effects.py 尚在并行开发）
    "team.evaluate": False,
    "team.compare": False,
    "battle.plan": False,
}

# 未实现的能力 → 结构化拒绝理由（绝不返回编造的数值）
NOT_IMPLEMENTED: Dict[str, Dict[str, Any]] = {
    "/team/evaluate": {
        "code": "team_evaluation",
        "reason": (
            "队伍强度评估需要官方伤害公式、等级→面板换算与效果原语，"
            "三者都无一手来源（MC-010/MC-011，见 docs/roco/MICROCASE-PLAN.md §5）"
        ),
        "missing": ["official_damage_formula", "level_scaling_formula", "effect_primitives"],
    },
    "/team/compare": {
        "code": "team_comparison",
        "reason": "换人前后对比依赖与 /team/evaluate 相同的未核验机制，故同样 fail closed",
        "missing": ["official_damage_formula", "level_scaling_formula", "effect_primitives"],
    },
    "/battle/plan": {
        "code": "battle_planning",
        "reason": (
            "回合规划需要行动排序键、应对/蓄力时序与隐藏信息不变量全部落地"
            "（MC-001/MC-004/MC-013/MC-020/MC-021），当前未核验"
        ),
        "missing": ["action_order", "respond_mechanics", "charge_mechanics"],
    },
}

# 隐藏信息键（归一化后比较）：对手待执行动作、真实随机种子、私有状态。
# 依据 MC-013：教练观察面不得包含对手的未公开选择与真实随机种子。
HIDDEN_KEYS = frozenset(
    {
        "opponentaction",
        "opponentpendingaction",
        "opponentchoice",
        "opponentselection",
        "pendingaction",
        "hiddenaction",
        "hiddenstate",
        "privatestate",
        "opponentprivatestate",
        "trueseed",
        "rngseed",
        "randomseed",
        "seed",
    }
)

# 查询 kind → 是否需要引擎效果原语。需要的一律 unsupported_effect。
EFFECT_KINDS = frozenset({"effect", "power", "damage", "mechanic", "resolve"})


def _repo_root() -> str:
    """仓库根。本文件在 roco/src/roco_env/service.py：目录 → src/ → roco/ → 根。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def ev(ruleset_id: str, filename: str, key: Optional[str] = None) -> str:
    """证据 id：稳定、可回查、能钉到具体数据版本。

    形如 ``ev:<ruleset_id>:<file>`` 或 ``ev:<ruleset_id>:<file>#<record_key>``。
    它只标识「这条事实来自哪个文件的哪条记录」，不表示结论正确；
    配合信封里的 ``snapshot_fingerprint`` 可以钉死到具体快照。
    """
    base = f"ev:{ruleset_id}:{filename}"
    return f"{base}#{key}" if key else base


def _normalize_key(key: str) -> str:
    return "".join(ch for ch in key.lower() if ch.isalnum())


def find_hidden_keys(payload: Any, prefix: str = "") -> List[str]:
    """递归找出请求/回执里的隐藏信息键，返回可读路径列表。

    这是 MC-013 不变量在桥上的落地位置：宁可拒绝一个请求，也不让对手的
    未公开选择或真实随机种子穿过去。
    """
    hits: List[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if _normalize_key(str(key)) in HIDDEN_KEYS:
                hits.append(path)
            hits.extend(find_hidden_keys(value, path))
    elif isinstance(payload, list):
        for i, item in enumerate(payload):
            hits.extend(find_hidden_keys(item, f"{prefix}[{i}]"))
    return hits


def engine_modules_present() -> Dict[str, bool]:
    """报告同目录下引擎模块的存在情况（**只报告，不导入**）。

    这些模块由另一条工作线并行编写（effects.py / env.py / schema.py）。
    本服务不与它们耦合：耦合会在它们变动时把桥一起弄坏。
    要让某个端点真正接上引擎，见 ``NOT_IMPLEMENTED`` 与模块 docstring 末尾的接口说明。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    return {name: os.path.exists(os.path.join(here, f"{name}.py")) for name in ("schema", "effects", "env", "ruleset")}


# ── 规则集缓存 ──────────────────────────────────────────────────────────


class RulesetCache:
    """规则集加载缓存。**只缓存成功**：失败可能是引擎刚写好、数据刚导入，不该被记住。"""

    def __init__(self, repo_root: Optional[str] = None):
        self.repo_root = repo_root
        self._loaded: Dict[str, Ruleset] = {}

    def get(self, ruleset_id: str) -> Tuple[Optional[Ruleset], Optional[str]]:
        cached = self._loaded.get(ruleset_id)
        if cached is not None:
            return cached, None
        try:
            rs = load_ruleset(ruleset_id, self.repo_root)
        except RulesetError as exc:
            return None, str(exc)
        except Exception as exc:  # 文件缺失/JSON 坏掉等，一律算「这个版本加载不了」
            return None, f"{type(exc).__name__}: {exc}"
        self._loaded[ruleset_id] = rs
        return rs, None


# ── 单个查询的答案 ─────────────────────────────────────────────────────


@dataclass
class Answer:
    result: Any = None
    coverage: float = 1.0
    evidence_ids: List[str] = field(default_factory=list)
    unsupported: List[Dict[str, Any]] = field(default_factory=list)
    error_type: Optional[str] = None
    error: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)


def _bad_request(msg: str) -> Answer:
    return Answer(error_type="bad_request", error=msg, coverage=0.0)


def _not_found(msg: str) -> Answer:
    return Answer(error_type="not_found", error=msg, coverage=0.0)


def _unsupported(code: str, reason: str, **extra: Any) -> Answer:
    return Answer(
        error_type="unsupported_effect",
        error=reason,
        coverage=0.0,
        unsupported=[dict(code=code, reason=reason, **extra)],
    )


# ── 服务本体 ────────────────────────────────────────────────────────────


class RocoService:
    """无状态查询服务。唯一的状态是「装载了哪个规则集」，且只缓存成功结果。"""

    def __init__(
        self,
        *,
        served_ruleset_id: str = DEFAULT_RULESET,
        repo_root: Optional[str] = None,
        verbose: bool = False,
    ):
        self.served_ruleset_id = served_ruleset_id
        self.repo_root = repo_root or _repo_root()
        self.verbose = verbose
        self.cache = RulesetCache(self.repo_root)
        self._type_rows_cache: Dict[str, Tuple[Optional[Dict[str, Any]], Optional[str]]] = {}
        self.started_at = time.time()
        self.started_monotonic = time.monotonic()

    # ── 信封 ────────────────────────────────────────────────────────────

    def _envelope(
        self,
        *,
        started: float,
        ruleset_id: Optional[str] = None,
        state_version: Any = None,
        snapshot_fingerprint: Optional[str] = None,
        coverage: Optional[float] = None,
        evidence_ids: Optional[List[str]] = None,
        unsupported: Optional[List[Dict[str, Any]]] = None,
        error_type: Optional[str] = None,
        error: Optional[str] = None,
        result: Any = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        env: Dict[str, Any] = {
            "protocol_version": PROTOCOL_VERSION,
            "service": SERVICE_NAME,
            "service_version": SERVICE_VERSION,
            "ok": error_type is None,
            "ruleset_id": ruleset_id,
            "state_version": state_version,
            "snapshot_fingerprint": snapshot_fingerprint,
            "coverage": coverage,
            "evidence_ids": list(evidence_ids or []),
            "unsupported": list(unsupported or []),
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "error_type": error_type,
            "error": error,
            "result": result,
        }
        env.update(extra)
        return env

    # ── 规则集解析 ──────────────────────────────────────────────────────

    def resolve_ruleset(
        self, requested: Any
    ) -> Tuple[Optional[Ruleset], Optional[str], Optional[str], Optional[str]]:
        """返回 (ruleset, error_type, error, fingerprint)。

        **一个服务进程 = 一个规则集版本。** 本服务只回答它声明的那个版本，
        不去装载调用方点名的别的版本 —— 否则「规则集身份」就不再是钉死的，
        调用方也就无法确定自己拿到的是哪个快照。

        三种结局必须能分开：

          * 请求的 id == 本服务声明的 id，且装载成功 → 正常服务
          * 请求的 id != 本服务声明的 id             → version_mismatch（409）
          * 请求的 id == 声明的 id，但数据装载不了   → ruleset_unsupported（404）

        后两条的区别是实质性的：前者是「你要的版本，我这份引擎没有」，
        后者是「我该有的那份数据坏了/缺了」。调用方的处置完全不同。
        """
        if not isinstance(requested, str) or not requested.strip():
            return None, "bad_request", "缺少 ruleset_id", None
        requested = requested.strip()
        if requested != self.served_ruleset_id:
            return (
                None,
                "version_mismatch",
                f"请求的规则集「{requested}」不是本引擎持有的版本：本服务声明持有「{self.served_ruleset_id}」。"
                "一个服务进程只服务一个规则集版本，需要别的版本请另起一个服务",
                None,
            )
        rs, why = self.cache.get(requested)
        if rs is not None:
            return rs, None, None, rs.snapshot_fingerprint()
        return (
            None,
            "ruleset_unsupported",
            f"本引擎持有的规则集「{self.served_ruleset_id}」加载失败：{why}",
            None,
        )

    def _resolve_or_envelope(
        self, body: Dict[str, Any], started: float
    ) -> Tuple[Optional[Ruleset], Optional[Tuple[int, Dict[str, Any]]], Optional[str], Any]:
        """把「校验 ruleset + 指纹」收成一处，返回 (rs, 错误响应, 状态版本, 指纹)。"""
        hidden = find_hidden_keys(body)
        if hidden:
            reason = (
                "请求里出现了隐藏信息字段："
                + ", ".join(hidden)
                + "。依据 MC-013，教练观察面不得包含对手待执行动作或真实随机种子"
            )
            env = self._envelope(
                started=started,
                ruleset_id=self.served_ruleset_id,
                state_version=body.get("state_version"),
                error_type="hidden_information",
                error=reason,
                coverage=0.0,
            )
            return None, (ERROR_HTTP_STATUS["hidden_information"], env), None, None

        state_version, sv_err = _coerce_state_version(body.get("state_version"))
        if sv_err is not None:
            env = self._envelope(
                started=started,
                ruleset_id=self.served_ruleset_id,
                state_version=body.get("state_version"),
                error_type="bad_request",
                error=sv_err,
                coverage=0.0,
            )
            return None, (ERROR_HTTP_STATUS["bad_request"], env), None, None

        requested = body.get("ruleset_id") or self.served_ruleset_id
        rs, error_type, error, fingerprint = self.resolve_ruleset(requested)
        if rs is None:
            env = self._envelope(
                started=started,
                ruleset_id=requested if isinstance(requested, str) else None,
                state_version=state_version,
                error_type=error_type,
                error=error,
                coverage=0.0,
                served_ruleset_id=self.served_ruleset_id,
            )
            return None, (ERROR_HTTP_STATUS.get(error_type or "internal_error", 500), env), state_version, None

        expected = body.get("expected_fingerprint")
        if isinstance(expected, str) and expected and expected != fingerprint:
            env = self._envelope(
                started=started,
                ruleset_id=rs.ruleset_id,
                state_version=state_version,
                snapshot_fingerprint=fingerprint,
                error_type="version_mismatch",
                error="快照指纹与调用方钉住的不一致：数据版本已经变了",
                coverage=0.0,
                expected_fingerprint=expected,
            )
            return None, (ERROR_HTTP_STATUS["version_mismatch"], env), state_version, fingerprint

        return rs, None, state_version, fingerprint

    # ── /health ─────────────────────────────────────────────────────────

    def health(self) -> Dict[str, Any]:
        started = time.perf_counter()
        rs, why = self.cache.get(self.served_ruleset_id)
        if rs is None:
            return self._envelope(
                started=started,
                ruleset_id=self.served_ruleset_id,
                state_version=0,
                coverage=0.0,
                error_type="ruleset_unsupported",
                error=f"本引擎持有的规则集「{self.served_ruleset_id}」加载失败：{why}",
                result={"loaded": False, "capabilities": dict(CAPABILITIES)},
            )
        return self._envelope(
            started=started,
            ruleset_id=rs.ruleset_id,
            state_version=0,
            snapshot_fingerprint=rs.snapshot_fingerprint(),
            coverage=1.0,
            evidence_ids=[ev(rs.ruleset_id, f"{name}.json") for name in NORMALIZED_FILES],
            result={
                "loaded": True,
                "game": rs.game,
                "source_revision": rs.source_revision,
                "counts": {
                    "pets": len(rs.pets),
                    "skills": len(rs.skills),
                    "learnsets": len(rs.learnsets),
                    "type_rows": len(rs.type_chart.single),
                    "terms": len(rs.terms),
                },
                "capabilities": dict(CAPABILITIES),
                "mechanics_coverage": 0.0,
                "engine_modules": engine_modules_present(),
                "pid": os.getpid(),
                "uptime_s": round(time.monotonic() - self.started_monotonic, 3),
            },
        )

    # ── /rules/query ────────────────────────────────────────────────────

    def rules_query(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        started = time.perf_counter()
        rs, early, state_version, fingerprint = self._resolve_or_envelope(body, started)
        if early is not None:
            return early
        assert rs is not None

        query = body.get("query") if isinstance(body.get("query"), dict) else body
        kind = str(query.get("kind") or "ruleset").strip().lower()

        try:
            if kind in ("ruleset", "meta", "stats"):
                answer = self._answer_ruleset(rs)
            elif kind == "pet":
                answer = self._answer_pet(rs, query)
            elif kind == "skill":
                answer = self._answer_skill(rs, query)
            elif kind == "learnset":
                answer = self._answer_learnset(rs, query)
            elif kind == "term":
                answer = self._answer_term(rs, query)
            elif kind in ("type_row", "type_chart"):
                answer = self._answer_type_row(rs, query) if kind == "type_row" else self._answer_type_chart(rs)
            elif kind == "type_multiplier":
                answer = self._answer_type_multiplier(rs, query)
            elif kind in EFFECT_KINDS:
                answer = self._answer_effect(rs, query, kind)
            else:
                answer = _bad_request(f"未知的查询 kind：{kind}")
        except Exception as exc:  # 任何意外都不许悄悄吞掉
            answer = Answer(
                error_type="internal_error",
                error=f"{type(exc).__name__}: {exc}",
                coverage=0.0,
                extra={"traceback": traceback.format_exc().splitlines()[-4:]} if self.verbose else {},
            )

        env = self._envelope(
            started=started,
            ruleset_id=rs.ruleset_id,
            state_version=state_version,
            snapshot_fingerprint=fingerprint,
            coverage=answer.coverage,
            evidence_ids=answer.evidence_ids,
            unsupported=answer.unsupported,
            error_type=answer.error_type,
            error=answer.error,
            result=answer.result,
            **answer.extra,
        )
        status = ERROR_HTTP_STATUS.get(answer.error_type or "", 200)
        return status, env

    def _answer_ruleset(self, rs: Ruleset) -> Answer:
        return Answer(
            result={
                "record": "ruleset",
                "game": rs.game,
                "source_revision": rs.source_revision,
                "counts": {
                    "pets": len(rs.pets),
                    "skills": len(rs.skills),
                    "learnsets": len(rs.learnsets),
                    "type_rows": len(rs.type_chart.single),
                    "terms": len(rs.terms),
                },
                "files": rs.files,
                "capabilities": dict(CAPABILITIES),
                "engine_modules": engine_modules_present(),
                # 提醒调用方：数据齐全 ≠ 机制可模拟。
                "mechanics_coverage": 0.0,
            },
            evidence_ids=[ev(rs.ruleset_id, f"{name}.json") for name in NORMALIZED_FILES],
        )

    def _pet_record(self, rs: Ruleset, pet: Any) -> Dict[str, Any]:
        ls = rs.learnsets.get(pet.pet_id)
        record: Dict[str, Any] = {
            "record": "pet",
            "pet_id": pet.pet_id,
            "name": pet.name,
            "title": pet.title,
            "types": list(pet.types),
            "stats": dict(pet.stats),
            "stat_total": pet.stat_total,
            "feature_skill_id": pet.feature_skill_id,
            "learnset_id": pet.learnset_id,
            "release_date": pet.release_date,
            "game_id": pet.game_id,
        }
        if ls is not None:
            record["learnset_summary"] = {
                "native": len(ls.native),
                "blood": len(ls.blood),
                "stones": len(ls.stones),
                "total": len(ls.all_skill_ids),
            }
        else:
            record["learnset_summary"] = None
        return record

    def _answer_pet(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        ref = query.get("pet_id") or query.get("id")
        name = query.get("name")
        if isinstance(ref, str) and ref:
            pet = rs.pets.get(ref)
            if pet is None:
                return _not_found(f"未知精灵 id：{ref}")
            return Answer(
                result=self._pet_record(rs, pet),
                evidence_ids=[ev(rs.ruleset_id, "pets.json", pet.pet_id)],
            )
        if isinstance(name, str) and name:
            hits = rs.pets_by_name(name)
            if not hits:
                return _not_found(f"未知精灵名：{name}")
            evidence = [ev(rs.ruleset_id, "pets.json", p.pet_id) for p in hits]
            if len(hits) > 1:
                # 同名异形态必须显式登记，不得静默取第一只（对应 import 阶段的同名规则）
                return Answer(
                    result={
                        "record": "pet",
                        "ambiguous": True,
                        "matches": [self._pet_record(rs, p) for p in hits],
                    },
                    evidence_ids=evidence,
                )
            return Answer(result=self._pet_record(rs, hits[0]), evidence_ids=evidence)
        return _bad_request("查精灵需要 pet_id / id 或 name")

    def _skill_record(self, rs: Ruleset, skill: Any) -> Dict[str, Any]:
        resolved = skill.effect_support == "supported"
        return {
            "record": "skill",
            "skill_id": skill.skill_id,
            "name": skill.name,
            "category": skill.category,
            "element": skill.element,
            "energy": skill.energy,
            "damage_class": skill.damage_class,
            # power 是**来源字段**，不是最终伤害：标 power_status 让调用方自己判断口径。
            "power": skill.power,
            "power_status": "static_value_present" if skill.power is not None else "not_provided_by_source",
            "has_static_power": skill.has_static_power,
            "is_trait": skill.is_trait,
            "effect_support": skill.effect_support,
            "desc": skill.desc,
            # 这两个键永远为 null：引擎没有实现效果原语前，不许出现「最终数值」。
            "effective_power": None,
            "damage": None,
            "mechanics": {
                "resolved": resolved,
                "coverage": 1.0 if resolved else 0.0,
                "reason": None
                if resolved
                else "效果原语尚未核验/实现（skills.json 的 effect_support = unsupported）",
            },
        }

    def _answer_skill(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        ref = query.get("skill_id") or query.get("id")
        name = query.get("name")
        skill = None
        if isinstance(ref, str) and ref:
            skill = rs.skills.get(ref)
            if skill is None:
                return _not_found(f"未知技能 id：{ref}")
        elif isinstance(name, str) and name:
            try:
                skill = rs.skill_by_name(name)
            except RulesetError as exc:
                return _not_found(str(exc))
        else:
            return _bad_request("查技能需要 skill_id / id 或 name")

        record = self._skill_record(rs, skill)
        answer = Answer(
            result=record,
            evidence_ids=[ev(rs.ruleset_id, "skills.json", skill.skill_id)],
        )
        if skill.effect_support != "supported":
            answer.unsupported = [
                {
                    "code": "effect_resolution",
                    "skill_id": skill.skill_id,
                    "reason": "该技能的效果原语未实现；静态 power 只登记来源字段，不能当最终伤害",
                }
            ]
        return answer

    def _answer_learnset(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        pet_id = query.get("pet_id") or query.get("id")
        if not isinstance(pet_id, str) or not pet_id:
            return _bad_request("查学习表需要 pet_id")
        ls = rs.learnsets.get(pet_id)
        if ls is None:
            return _not_found(f"未知学习表或精灵 id：{pet_id}")
        include = bool(query.get("include_records", True))

        def records(ids: Tuple[str, ...]) -> List[Any]:
            if not include:
                return list(ids)
            out = []
            for sid in ids:
                skill = rs.skills.get(sid)
                if skill is None:
                    # 学习表里的孤儿引用在加载期就该炸；这里若真出现，如实上报而不是跳过
                    out.append({"skill_id": sid, "missing_in_skills_json": True})
                else:
                    out.append(self._skill_record(rs, skill))
            return out

        return Answer(
            result={
                "record": "learnset",
                "pet_id": pet_id,
                "native": records(ls.native),
                "blood": records(ls.blood),
                "stones": records(ls.stones),
                "total": len(ls.all_skill_ids),
            },
            evidence_ids=[
                ev(rs.ruleset_id, "learnsets.json", pet_id),
                ev(rs.ruleset_id, "skills.json"),
            ],
        )

    def _answer_term(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        term_id = query.get("term_id") or query.get("id")
        if term_id is None:
            return _bad_request("查术语需要 term_id / id")
        term = rs.term(str(term_id))
        if term is None:
            return _not_found(f"未知术语 id：{term_id}")
        return Answer(
            result={"record": "term", "term_id": term.term_id, "note": term.note, "desc": term.desc},
            evidence_ids=[ev(rs.ruleset_id, "terms.json", term.term_id)],
        )

    # ── 属性相性 ────────────────────────────────────────────────────────

    def _type_rows(self, rs: Ruleset) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """读快照里**显式**的相性行（单属性 + 双属性）。

        临时接口：``data.py`` 的 ``TypeChart`` 只留单属性行，双属性行被丢掉。
        在 ``data.py`` 补上 ``TypeChart.combined`` 之前，这里读一次原始 JSON，
        并用 ``rs.files["types.json"]`` 的 sha256 校验它没在加载后变动。
        """
        cached = self._type_rows_cache.get(rs.ruleset_id)
        if cached is not None:
            return cached
        path = os.path.join(self.repo_root, "data", "roco", "normalized", rs.ruleset_id, "types.json")
        try:
            with open(path, "rb") as fh:
                raw_bytes = fh.read()
        except OSError as exc:
            result: Tuple[Optional[Dict[str, Any]], Optional[str]] = (None, f"读不到 {path}：{exc}")
            self._type_rows_cache[rs.ruleset_id] = result
            return result
        digest = hashlib.sha256(raw_bytes).hexdigest()
        expected = rs.files.get("types.json")
        if expected and digest != expected:
            result = (None, "types.json 在规则集加载之后发生变化（快照指纹对不上）")
            self._type_rows_cache[rs.ruleset_id] = result
            return result
        try:
            doc = json.loads(raw_bytes.decode("utf-8"))
            rows = doc["types"]
            if not isinstance(rows, dict):
                raise ValueError("types 不是字典")
        except Exception as exc:
            result = (None, f"解析 types.json 失败：{type(exc).__name__}: {exc}")
            self._type_rows_cache[rs.ruleset_id] = result
            return result
        result = (rows, None)
        self._type_rows_cache[rs.ruleset_id] = result
        return result

    @staticmethod
    def _row_lookup(row: Dict[str, Any], element: str) -> Tuple[Optional[float], bool]:
        """在一条相性行里查倍率。返回 (倍率, 是否来自表项)。"""
        for entry in row.get("weak") or []:
            if entry.get("type") == element:
                return float(entry["multiplier"]), True
        for entry in row.get("resist") or []:
            if entry.get("type") == element:
                return float(entry["multiplier"]), True
        return None, False

    def _find_type_row(self, rows: Dict[str, Any], defender_types: List[str]) -> Optional[Dict[str, Any]]:
        """按键查显式行。双属性两种顺序都试，**不**做相乘。"""
        if len(defender_types) == 1:
            return rows.get(defender_types[0])
        if len(defender_types) == 2:
            a, b = defender_types
            return rows.get(f"{a}|{b}") or rows.get(f"{b}|{a}")
        return None

    def _answer_type_row(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        key = query.get("type") or query.get("id") or query.get("key")
        if not isinstance(key, str) or not key:
            return _bad_request("查相性行需要 type（如「龙系」或「龙系|幽系」）")
        rows, why = self._type_rows(rs)
        if rows is None:
            return _bad_request(f"相性表不可用：{why}")
        row = rows.get(key)
        if row is None:
            if "|" in key:
                return _unsupported(
                    "type_row_missing",
                    f"快照没有给出双属性组合「{key}」的相性行；本服务不用「单属性相乘」补（该假设与快照 41 处不符）",
                    combination=key,
                )
            return _not_found(f"未知属性：{key}")
        return Answer(
            result={
                "record": "type_row",
                "key": row.get("key", key),
                "weak": row.get("weak") or [],
                "resist": row.get("resist") or [],
                "neutral_default": 1.0,
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json", key)],
        )

    def _answer_type_multiplier(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        element = query.get("attack_element") or query.get("element")
        defenders = query.get("defender_types") or query.get("types")
        if isinstance(defenders, str):
            defenders = [t for t in defenders.replace(",", "|").split("|") if t]
        if not isinstance(element, str) or not element:
            return _bad_request("查相性倍率需要 attack_element")
        if not isinstance(defenders, list) or not defenders:
            return _bad_request("查相性倍率需要 defender_types（数组，1 或 2 个属性）")
        # 去重但保持顺序
        uniq: List[str] = []
        for t in defenders:
            if not isinstance(t, str) or not t:
                return _bad_request("defender_types 里有非字符串项")
            if t not in uniq:
                uniq.append(t)
        if len(uniq) > 2:
            return _bad_request("属性最多两种")

        rows, why = self._type_rows(rs)
        if rows is None:
            if len(uniq) == 1:
                # 单属性仍可从已加载的 TypeChart 取（data.py 保留的那部分）
                table = rs.type_chart.single.get(uniq[0])
                if table is None:
                    return _not_found(f"未知属性：{uniq[0]}")
                return Answer(
                    result={
                        "record": "type_multiplier",
                        "defender_types": uniq,
                        "attack_element": element,
                        "multiplier": float(table.get(element, 1.0)),
                        "neutral_inferred": element not in table,
                        "source": "data.TypeChart（单属性）",
                        "assumption_free": True,
                    },
                    evidence_ids=[ev(rs.ruleset_id, "types.json", uniq[0])],
                )
            return _bad_request(f"相性表不可用：{why}")

        row = self._find_type_row(rows, uniq)
        if row is None:
            return _unsupported(
                "type_combination_missing",
                "快照没有给出该双属性组合的显式相性行；"
                "「两条单属性相乘」是未核验假设（且与快照 41 处不符：2×2 快照封顶为 3），故不返回倍率",
                defender_types=uniq,
            )
        value, from_table = self._row_lookup(row, element)
        if not from_table:
            value = 1.0
        return Answer(
            result={
                "record": "type_multiplier",
                "defender_types": uniq,
                "attack_element": element,
                "multiplier": float(value),
                # 未列出的攻击属性按「中性 1.0」处理；这是表的口径，不是新数值。
                "neutral_inferred": not from_table,
                "source": f"types.json#{row.get('key')}",
                # 关键：双属性来自快照显式行，没有用相乘假设。
                "assumption_free": True,
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json", str(row.get("key")))],
        )

    def _answer_type_chart(self, rs: Ruleset) -> Answer:
        """相性表自检：把「相乘假设」与快照显式行对拍，暴露差异（只报告，不补数）。"""
        rows, why = self._type_rows(rs)
        if rows is None:
            return _bad_request(f"相性表不可用：{why}")
        singles = [k for k in rows if "|" not in k]
        duals = [k for k in rows if "|" in k]
        checked = 0
        mismatches: List[Dict[str, Any]] = []

        def single_mult(type_key: str, element: str) -> float:
            value, _ = self._row_lookup(rows[type_key], element)
            return 1.0 if value is None else value

        for key in duals:
            a, b = key.split("|", 1)
            if a not in rows or b not in rows:
                continue
            for element in singles:
                checked += 1
                product = single_mult(a, element) * single_mult(b, element)
                actual, _ = self._row_lookup(rows[key], element)
                actual = 1.0 if actual is None else actual
                if abs(product - actual) > 1e-9 and len(mismatches) < 8:
                    mismatches.append(
                        {
                            "row": key,
                            "attack_element": element,
                            "product_of_singles": product,
                            "snapshot_value": actual,
                        }
                    )
        # 统计全部差异（示例只留 8 条）
        total_mismatch = 0
        for key in duals:
            a, b = key.split("|", 1)
            if a not in rows or b not in rows:
                continue
            for element in singles:
                product = single_mult(a, element) * single_mult(b, element)
                actual, _ = self._row_lookup(rows[key], element)
                actual = 1.0 if actual is None else actual
                if abs(product - actual) > 1e-9:
                    total_mismatch += 1
        return Answer(
            result={
                "record": "type_chart",
                "singles": len(singles),
                "dual_rows_in_snapshot": len(duals),
                "consistency_vs_product_assumption": {
                    "checked": checked,
                    "mismatches": total_mismatch,
                    "examples": mismatches,
                    "note": (
                        "data.py 的 TypeChart.multiplier 假设「双属性 = 两条单属性相乘」；"
                        "快照的显式双属性行在 2×2 处一律给 3.0（封顶），故该假设会高估。"
                        "本服务的 type_multiplier 只用显式行，缺失组合返回 unsupported。"
                    ),
                },
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json")],
        )

    # ── 效果原语：一律 fail closed ──────────────────────────────────────

    def _answer_effect(self, rs: Ruleset, query: Dict[str, Any], kind: str) -> Answer:
        skill_ref = query.get("skill_id") or query.get("id")
        detail = ""
        if isinstance(skill_ref, str) and skill_ref:
            skill = rs.skills.get(skill_ref)
            if skill is None:
                return _not_found(f"未知技能 id：{skill_ref}")
            detail = f"技能「{skill.name}」的 effect_support = {skill.effect_support}"
        return _unsupported(
            "effect_resolution",
            (
                f"kind={kind} 需要效果原语（伤害公式、条件化威力取值时机、应对/蓄力时序），"
                "当前未核验/未实现。"
                + ("；" + detail if detail else "")
                + " 依据 MC-010/MC-011/MC-020/MC-021，本服务不给默认数值。"
            ),
            requested_kind=kind,
            skill_id=skill_ref if isinstance(skill_ref, str) else None,
        )

    # ── 尚未实现的引擎端点 ──────────────────────────────────────────────

    def not_implemented(self, path: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        started = time.perf_counter()
        rs, early, state_version, fingerprint = self._resolve_or_envelope(body, started)
        if early is not None:
            return early

        spec = NOT_IMPLEMENTED.get(path, {"code": "unknown", "reason": "端点未实现", "missing": []})
        reason = spec["reason"]
        env = self._envelope(
            started=started,
            ruleset_id=rs.ruleset_id if rs else self.served_ruleset_id,
            state_version=state_version,
            snapshot_fingerprint=fingerprint,
            coverage=0.0,
            error_type="not_implemented",
            error=reason,
            unsupported=[dict(code=spec["code"], reason=reason, missing=list(spec["missing"]))],
            result=None,
            endpoint=path,
        )
        return ERROR_HTTP_STATUS["not_implemented"], env

    def unknown_path(self, path: str) -> Tuple[int, Dict[str, Any]]:
        started = time.perf_counter()
        env = self._envelope(
            started=started,
            ruleset_id=self.served_ruleset_id,
            state_version=None,
            coverage=0.0,
            error_type="not_found",
            error=f"未知端点：{path}",
            routes=["/health", "/rules/query", "/team/evaluate", "/team/compare", "/battle/plan"],
        )
        return ERROR_HTTP_STATUS["not_found"], env


def _coerce_state_version(value: Any) -> Tuple[Optional[int], Optional[str]]:
    """state_version 必须显式携带：它是「这条事实对应哪个状态」的钉子。"""
    if value is None:
        return None, "缺少 state_version（每个调用都必须携带它，用于判定事实是否过期）"
    if isinstance(value, bool):
        return None, "state_version 必须是整数"
    if isinstance(value, int):
        if value < 0:
            return None, "state_version 不能为负"
        return value, None
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip()), None
    return None, "state_version 必须是整数"


# ── HTTP 层 ────────────────────────────────────────────────────────────


class RocoHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], service: RocoService):
        super().__init__(address, RocoRequestHandler)
        self.service = service


class RocoRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"{SERVICE_NAME}/{SERVICE_VERSION}"
    server: RocoHTTPServer  # type: ignore[assignment]

    # ── 工具 ────────────────────────────────────────────────────────────

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if self.server.service.verbose:
            sys.stderr.write("[roco_env] " + (fmt % args) + "\n")
            sys.stderr.flush()

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[int, Dict[str, Any]]]]:
        service = self.server.service
        started = time.perf_counter()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, (400, service._envelope(
                started=started, ruleset_id=service.served_ruleset_id, state_version=None,
                coverage=0.0, error_type="bad_request", error="Content-Length 不是整数",
            ))
        if length > MAX_BODY_BYTES:
            return None, (413, service._envelope(
                started=started, ruleset_id=service.served_ruleset_id, state_version=None,
                coverage=0.0, error_type="bad_request", error=f"请求体超过 {MAX_BODY_BYTES} 字节",
            ))
        raw = self.rfile.read(length) if length else b""
        if not raw.strip():
            return {}, None
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return None, (400, service._envelope(
                started=started, ruleset_id=service.served_ruleset_id, state_version=None,
                coverage=0.0, error_type="bad_request", error=f"请求体不是合法 JSON：{exc}",
            ))
        if not isinstance(body, dict):
            return None, (400, service._envelope(
                started=started, ruleset_id=service.served_ruleset_id, state_version=None,
                coverage=0.0, error_type="bad_request", error="请求体必须是 JSON 对象",
            ))
        return body, None

    def _dispatch(self, path: str, body: Dict[str, Any]) -> None:
        service = self.server.service
        try:
            if path == "/rules/query":
                status, env = service.rules_query(body)
            elif path in NOT_IMPLEMENTED:
                status, env = service.not_implemented(path, body)
            else:
                status, env = service.unknown_path(path)
        except Exception as exc:  # 兜底：任何异常都要变成结构化响应，不能把连接挂死
            traceback.print_exc(file=sys.stderr)
            started = time.perf_counter()
            status = ERROR_HTTP_STATUS["internal_error"]
            env = service._envelope(
                started=started,
                ruleset_id=service.served_ruleset_id,
                state_version=body.get("state_version"),
                coverage=0.0,
                error_type="internal_error",
                error=f"{type(exc).__name__}: {exc}",
            )
        self._send(status, env)

    # ── 路由 ────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802
        path, _, qs = self.path.partition("?")
        if path == "/health":
            self._send(200, self.server.service.health())
            return
        if path == "/rules/query":
            params: Dict[str, Any] = {}
            for key, values in parse_qs(qs).items():
                params[key] = values[0] if len(values) == 1 else values
            if "defender_types" in params and isinstance(params["defender_types"], str):
                params["defender_types"] = [t for t in params["defender_types"].replace(",", "|").split("|") if t]
            # GET 只用于手工排查；state_version 缺失时给 0，避免 curl 每次都要带
            params.setdefault("state_version", 0)
            self._dispatch(path, params)
            return
        status, env = self.server.service.unknown_path(path)
        self._send(status, env)

    def do_POST(self) -> None:  # noqa: N802
        path, _, _ = self.path.partition("?")
        if path not in ROUTES:
            status, env = self.server.service.unknown_path(path)
            self._send(status, env)
            return
        body, error = self._read_json()
        if error is not None:
            status, env = error
            self._send(status, env)
            return
        assert body is not None
        self._dispatch(path, body)


ROUTES = ("/health", "/rules/query", "/team/evaluate", "/team/compare", "/battle/plan")


# ── 进程入口 ────────────────────────────────────────────────────────────


def _watch_parent(parent_pid: int) -> None:
    """父进程（Node）死掉后自己退出，避免留下孤儿监听进程。"""

    while True:
        time.sleep(1.0)
        try:
            os.kill(parent_pid, 0)
        except OSError:
            os._exit(0)


def build_server(
    *, host: str = "127.0.0.1", port: int = 0, ruleset_id: str = DEFAULT_RULESET,
    repo_root: Optional[str] = None, verbose: bool = False,
) -> Tuple[RocoHTTPServer, RocoService]:
    service = RocoService(served_ruleset_id=ruleset_id, repo_root=repo_root, verbose=verbose)
    server = RocoHTTPServer((host, port), service)
    return server, service


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="roco_env 本地规则服务（只用标准库）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认只监听本机")
    parser.add_argument("--port", type=int, default=0, help="端口，0 = 由系统分配并在就绪行里报告")
    parser.add_argument("--ruleset", default=DEFAULT_RULESET, help="本服务持有并对外声明的规则集 id")
    parser.add_argument("--repo-root", default=None, help="仓库根（默认按本文件位置推断）")
    parser.add_argument("--parent-pid", type=int, default=None, help="父进程 pid，父进程退出后本进程自动退出")
    parser.add_argument("--verbose", action="store_true", help="把每个请求打到 stderr")
    args = parser.parse_args(argv)

    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()

    try:
        server, service = build_server(
            host=args.host, port=args.port, ruleset_id=args.ruleset,
            repo_root=args.repo_root, verbose=args.verbose,
        )
    except OSError as exc:
        # 端口占用等启动失败：用结构化一行告诉客户端，不要只留一句 Python traceback
        sys.stdout.write(
            "ROCO_SERVICE_FAILED "
            + json.dumps(
                {
                    "error_type": "internal_error",
                    "error": f"无法监听 {args.host}:{args.port}：{exc}",
                    "protocol_version": PROTOCOL_VERSION,
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        sys.stdout.flush()
        return 2

    bound_host, bound_port = server.server_address[0], server.server_address[1]
    rs, why = service.cache.get(args.ruleset)
    ready = {
        "protocol_version": PROTOCOL_VERSION,
        "service": SERVICE_NAME,
        "service_version": SERVICE_VERSION,
        "host": bound_host,
        "port": bound_port,
        "pid": os.getpid(),
        "ruleset_id": args.ruleset,
        "ruleset_ok": rs is not None,
        "ruleset_error": why,
        "snapshot_fingerprint": rs.snapshot_fingerprint() if rs is not None else None,
    }
    sys.stdout.write("ROCO_SERVICE_READY " + json.dumps(ready, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    def _stop(signum: int, frame: Any) -> None:  # noqa: ARG001
        # shutdown() 不能在 serve_forever 的同一线程里调用，所以另起一条线程
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
