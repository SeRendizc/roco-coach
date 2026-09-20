#!/usr/bin/env python3
"""roco_env 本地规则服务 —— Node↔Python 桥的 Python 端。

只用标准库（``http.server`` / ``json`` / ``hashlib`` / ``os`` / ``signal`` 等），
没有任何第三方依赖。默认只监听 ``127.0.0.1``：这是本机开发工具，不是网络服务。

端点
----

    GET  /health         服务与规则集身份：ruleset_id + snapshot_fingerprint
    GET  /rules/query    只读事实查询（也接受 POST）
    POST /rules/query    只读事实查询：精灵 / 技能 / 学习表 / 属性相性 / 术语
    POST /team/evaluate  队伍规则特征评估（类型/角色/速度/伤害/能量/缺口，不给胜率）
    POST /team/compare   换人前后对比：改善什么、代价什么、哪个对手池
    POST /battle/plan    回合行动规划（**只接受公开 planner state**）
    POST /battle/new     开一局本地练习对局（**私有域**，见下）
    POST /battle/legal   列出私有一局里双方的合法动作（**私有域**）
    POST /battle/advance 推进一个回合或一次补位（**私有域**）

两个信任域（这是本服务最重要的一条边界）
----------------------------------------

``/battle/plan`` 属于**教练域**：教练只该看见公开信息，所以它只接受
``env.public_planner_state()`` 的产物，请求里出现真实 seed / 对手待执行动作
一律 ``hidden_information`` 拒绝——**连发都不发**（客户端也会先拦一次）。

``/battle/new|legal|advance`` 属于**本地对局域**：它们由本机的 Node 服务调用，
用来驱动一局本地练习对局，输入输出都含完整私有状态（含真实 seed）。回执里显式
带 ``trust_domain: "local_sim"``。私有状态**不得返回浏览器**：浏览器只拿
``public``（公开面）与事件摘要。教练侧请求也**不得**用这里的 state——
那正是 ``/battle/plan`` 会拒绝的东西。两个域分开，而不是把边界放松。

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
import re
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
    from . import team as team_mod
    from . import env as env_mod
    from . import opponents as opp
    from . import team_model as tm
    from .schema import Action
except ImportError:  # 直接当脚本跑：python3 roco/src/roco_env/service.py
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from roco_env.data import DEFAULT_RULESET, Ruleset, RulesetError, load_ruleset  # type: ignore
    from roco_env import team as team_mod  # type: ignore
    from roco_env import env as env_mod  # type: ignore
    from roco_env import opponents as opp  # type: ignore
    from roco_env import team_model as tm  # type: ignore
    from roco_env.schema import Action  # type: ignore


# 分析用种子：与真实对局 seed 无关的固定集合。
# 固定是为了可复现；跨种子聚合是为了让结论不依赖任何单一随机序列
# （同速裁决在真实对局里可能任一结果，所以给区间而不是单点）。
DEFAULT_ANALYSIS_SEEDS = (11, 29, 47)

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
#: 能力声明。**必须与实际接线一致**：报 false 而端点可用，会让调用方
#: 以为「这条路没接上」而绕过它；报 true 而端点是空的，就是谎报。
#: 这一张表由 test_sim_endpoints.py 的 capabilities 测试钉住，
#: 加了端点却忘了改这里会变红（上一次就是这么被抓到的）。
CAPABILITIES: Dict[str, bool] = {
    "rules.query_catalog": True,        # 精灵/技能/学习表/术语：纯静态数据
    "rules.query_type_chart": True,     # 相性：只用快照显式行
    "mechanics.resolve_effect": False,  # 效果原语：按技能逐条判定，未核验的一律 422
    "team.evaluate": True,              # 规则 baseline 六特征（不输出胜率）
    "team.compare": True,               # 换人前后对比：改善什么、代价什么
    "battle.plan": True,                # 2—3 回合联合搜索（只收公开 planner state）
    "battle.local_sim": True,           # 本地练习对局的私有域端点（Node 专用）
}

#: 未实现的端点 → 结构化 not_implemented 的业务含义。
#: 字典为空时 `not_implemented()` 不可达，任何未登记路径都会退化成 404 not_found
#: ——「这个功能没做」与「没有这个地址」是两回事，前者要能给调用方一个明确的 501。
#: 所以保留一条目前确实还没做的能力：复盘摘要（实施书只定义了 5 个工具里的 4 个端点）。
NOT_IMPLEMENTED: Dict[str, Dict[str, Any]] = {
    "/battle/summary": {
        "code": "battle_summary",
        "reason": "复盘摘要需要事件序列与伤害结算；两者的结算时序尚未核验（MC-010/MC-012）",
        "missing": ["event_ordering", "official_damage_formula"],
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
        # env/schema 内部字段：对手本回合**已提交**的动作与换人队列。
        # 归一化会去掉下划线，所以这里写 pendingenemy / pendingplayer /
        # replacequeue 等真实会被序列化出来的键名。
        # 这一组必须与 src/coach/roco-client.js 的 HIDDEN_KEYS 一一对应：
        # 桥是第一层，少一个键就会让私有 serialize() 从桥本地穿过去、
        # 只剩服务端兜底，而 MC-013 要求两层都拦。
        "pendingenemy",
        "pendingplayer",
        "pendingenemyaction",
        "pendingplayeraction",
        # 换人队列说明「谁被迫换人」，是待执行状态，不是公开观察。
        "replacequeue",
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


#: 允许以**纯标记字段**出现的键名：它们不是在携带隐藏信息，而是在说
#: 「这一项讲的是对手的某个动作」。风险分支（W3-04）的回执里有
#: `risk.worst_seed_risks[].opponent_action`，值是「诡刺」这样的动作名字串，
#: 按名字扫会把它判成违规、整份回执丢掉 —— 这是加风险分支时撞出来的真实误报。
#:
#: 纪律：只在这些**分析结果**父路径下放行，且值必须是字符串。
#: `state.opponent_action` 这种状态字段照样拦。
VALUE_MARKER_KEYS = frozenset({"opponentaction", "opponentchoice", "opponentselection"})
VALUE_MARKER_PARENTS = frozenset({"risk", "toprisks", "worstseedrisks", "perseed", "branches"})


def _parent_segment(prefix: str) -> str:
    """取父路径最后一段并归一化：`risk.worst_seed_risks[0]` → `worstseedrisks`。"""
    if not prefix:
        return ""
    last = prefix.split(".")[-1]
    last = re.sub(r"\[\d+\]$", "", last)
    return _normalize_key(last)


def find_hidden_keys(payload: Any, prefix: str = "") -> List[str]:
    """递归找出请求/回执里的隐藏信息键，返回可读路径列表。

    这是 MC-013 不变量在桥上的落地位置：宁可拒绝一个请求，也不让对手的
    未公开选择或**真实随机种子**穿过去。

    **没有例外。** 我一开始给 `state.seed` 开了一个「只允许 state 下一层」的口子，
    那是错的：真实 seed 能预测同速裁决与后续伤害的随机结果，它就是隐藏信息，
    而且 toolbox 的 `plan_actions` 合同明确禁止真实随机种子——开后门会让
    客户端与服务端契约互相矛盾。现在任何深度、任何位置的 seed 都会被拒。

    教练侧要规划，走的是**公开 schema**（见 `public_planner_state`），
    而不是把对局私有状态整份递进来。
    """
    hits: List[str] = []
    if isinstance(payload, dict):
        under_marker_parent = _parent_segment(prefix) in VALUE_MARKER_PARENTS
        for key, value in payload.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            normalized = _normalize_key(str(key))
            is_marker = (
                under_marker_parent
                and normalized in VALUE_MARKER_KEYS
                and isinstance(value, str)
            )
            if normalized in HIDDEN_KEYS and not is_marker:
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
    #: 可选的模型分（W3-04）。`None` = 本次请求没要模型分。
    #: 有值时是一个完整信封：`available` / `probability` / `opponent_pool` /
    #: `not_a_winrate` / `limitations`，缺一不可。
    model_score: Optional[Dict[str, Any]] = None
    #: 这条答案属于哪个信任域。默认 ``"coach"``：**不含**真实 seed 与对手待执行动作，
    #: 因此收尾时仍走隐藏信息扫描。只有本地对局域（``/battle/new|legal|advance``）
    #: 显式写成 ``"local_sim"``，那些端点的请求体本来就带私有状态。
    #: 这**不是**给 seed 开例外：教练域任何路径下的 seed 仍然一律被拒。
    trust_domain: str = "coach"
    extra: Dict[str, Any] = field(default_factory=dict)


#: 允许携带私有状态的信任域。仅本机 Node 调用，且回执不返回浏览器。
PRIVATE_TRUST_DOMAIN = "local_sim"


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
        self, body: Dict[str, Any], started: float, trust_domain: str = "coach"
    ) -> Tuple[Optional[Ruleset], Optional[Tuple[int, Dict[str, Any]]], Optional[str], Any]:
        """把「校验 ruleset + 指纹」收成一处，返回 (rs, 错误响应, 状态版本, 指纹)。

        ``trust_domain`` 决定要不要扫隐藏信息。默认**要扫**；只有本地对局域
        （``PRIVATE_TRUST_DOMAIN``）跳过，因为那些端点按设计就带私有状态。
        跳过的是「这次请求的整体判定」，**不是**某个键的例外——教练域的
        扫描函数 `find_hidden_keys` 仍然是「没有例外、任意深度」。
        """
        if trust_domain != PRIVATE_TRUST_DOMAIN:
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
                    "type_rows": len(rs.type_chart.rows),
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
            **(dict(model_score=answer.model_score) if answer.model_score is not None else {}),
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
                    "type_rows": len(rs.type_chart.rows),
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
                table = rs.type_chart.rows.get((uniq[0],))
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

    def _ruleset_ok(
        self, body: Dict[str, Any], trust_domain: str = "coach"
    ) -> Tuple[Optional[Ruleset], Optional[Tuple[int, Dict[str, Any]]]]:
        """复用既有的 ruleset/指纹/隐藏信息校验，只取 rs 与可能的错误响应。

        ``trust_domain`` 必须由调用方**显式**给出：默认是教练域（扫隐藏信息）。
        只有本地对局域才传 ``PRIVATE_TRUST_DOMAIN``，因为那些端点按设计就带私有状态。
        """
        rs, early, _sv, _fp = self._resolve_or_envelope(body, time.perf_counter(), trust_domain)
        return rs, early

    def _answer_envelope(
        self, answer: Answer, body: Dict[str, Any], started: float
    ) -> Tuple[int, Dict[str, Any]]:
        """把 Answer 包成契约信封。与 rules_query 的收尾保持一致，
        这样 team 端点也自动带上 ruleset_id / coverage / evidence_ids / latency_ms。

        信任域取自 ``Answer.trust_domain``：默认 ``"coach"`` 会再扫一次隐藏信息。
        本地对局域要显式声明，否则它自己的私有状态会被自己的收尾扫描拒掉。
        """
        _rs, _early, state_version, fingerprint = self._resolve_or_envelope(
            body, started, answer.trust_domain
        )
        env = self._envelope(
            started=started,
            ruleset_id=self.served_ruleset_id,
            state_version=state_version,
            snapshot_fingerprint=fingerprint,
            coverage=answer.coverage,
            evidence_ids=answer.evidence_ids,
            unsupported=answer.unsupported,
            error_type=answer.error_type,
            error=answer.error,
            result=answer.result,
            **(dict(model_score=answer.model_score) if answer.model_score is not None else {}),
            **answer.extra,
        )
        return ERROR_HTTP_STATUS.get(answer.error_type or "", 200), env

    def team_evaluate(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """规则 baseline 阵容评估，**可选**再叠一层过门槛的模型分。

        注意它**不输出胜率**：只给分项特征与文字结论。
        如果请求里带了 loadouts，就用它；否则用固有技能。
        队伍合法性先按规则集校验，非法直接 400，不猜。

        关于模型分（W3-04）——三条约束，缺一就不给模型分：

        1. 请求必须显式带 `opponent_pool` **与** `opponent_team`：模型的特征里
           有 6 维是对手的，没有对手就没有输入，也就没有可解释的适用范围；
        2. 模型必须是**过门槛**的那一个（`team_model.load_team_model()` 会检查
           `gate.passed`），没过门槛就返回 None，这里直接不加模型分；
        3. 回执里必须带 `not_a_winrate` / `calibration` / `limitations`：
           「在指定对手池下的模拟期望」与「胜率」是两件事，不能只给一个数。

        默认行为**不变**：不带对手池时，回执与之前逐字节一致（只有规则分）。
        """
        started = time.perf_counter()
        rs, early = self._ruleset_ok(body)
        if early is not None:
            return early
        squad = body.get("team")
        if not isinstance(squad, list) or not all(isinstance(x, str) for x in squad):
            return self._answer_envelope(_bad_request("team 必须是精灵 id 的数组"), body, started)
        loadouts = body.get("loadouts")
        if loadouts is not None and not isinstance(loadouts, dict):
            return self._answer_envelope(_bad_request("loadouts 必须是 {pet_id: [skill_id...]}"), body, started)

        problems = env_mod.validate_team(rs, squad, loadouts)
        if problems:
            return self._answer_envelope(_bad_request("队伍不合法：" + "；".join(problems)), body, started)

        try:
            score = team_mod.evaluate_team(squad, rs=rs, loadouts=loadouts)
        except ValueError as exc:
            return self._answer_envelope(_bad_request(str(exc)), body, started)

        payload = score.to_dict()
        evidence = sorted({e for f in score.features for e in f.evidence})

        # ── 可选的模型分（W3-04）────────────────────────────────────────
        model_score = None
        opponent_pool = body.get("opponent_pool")
        opponent_team = body.get("opponent_team")
        if opponent_pool is not None or opponent_team is not None:
            if not isinstance(opponent_pool, list) or not opponent_pool or not all(
                    isinstance(x, str) and x for x in opponent_pool):
                return self._answer_envelope(_bad_request(
                    "opponent_pool 必须是非空的策略名数组（模型分只在声明的对手池下有效）"),
                    body, started)
            known = {s["name"] for s in opp.list_strategies()}
            unknown = [x for x in opponent_pool if x not in known]
            if unknown:
                return self._answer_envelope(_bad_request(
                    f"未知对手策略 {unknown}；可选：{sorted(known)}"), body, started)
            if not isinstance(opponent_team, list) or len(opponent_team) != 3 or not all(
                    isinstance(x, str) for x in opponent_team):
                return self._answer_envelope(_bad_request(
                    "opponent_team 必须是 3 个精灵 id 的数组（模型的 6 维特征来自对手阵容）"),
                    body, started)
            model = tm.load_team_model()
            if model is None:
                # 没有过门槛的模型：明确说「规则分是唯一评分」，不编一个默认概率。
                model_score = {
                    "available": False,
                    "reason": "没有过门槛的阵容模型（门槛：未见家族上优于规则分且校准合理）",
                    "fallback": "evaluate_team 继续使用规则评分",
                }
            else:
                try:
                    foe_score = team_mod.evaluate_team(opponent_team, rs=rs)
                except ValueError as exc:
                    return self._answer_envelope(_bad_request(f"对手阵容不合法：{exc}"), body, started)
                mine_features = {f.name: f.value for f in score.features}
                foe_features = {f.name: f.value for f in foe_score.features}
                model_score = {
                    "available": True,
                    **tm.score_team(model, mine_features, foe_features, opponent_pool=opponent_pool),
                }

        return self._answer_envelope(Answer(
            result=payload,
            model_score=model_score,
            # coverage 表示「这些特征有多少来自真实数据」：全部来自规则集，故 1.0；
            # 但它**不代表**评估的准确性——准确性取决于未核验的伤害公式。
            coverage=1.0,
            evidence_ids=[f"ev:{rs.ruleset_id}:pets.json#{p}" for p in squad],
            extra={
                "evidence_skill_ids": evidence,
                "calibration": payload.get("calibration"),
                "limitations": [
                    "不输出胜率：没有样本量、段位与版本可信的真人数据",
                    "特征由规则与数据算出，不经过模拟对局",
                    "面板值换算与伤害公式仍属未核验假设（MC-010/MC-011）",
                ],
            },
        ), body, started)

    def team_compare(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """换人前后对比：报告**改善什么、牺牲什么**。"""
        started = time.perf_counter()
        rs, early = self._ruleset_ok(body)
        if early is not None:
            return early
        # 契约形状：工具声明与 JS 客户端都用 team_before / team_after
        # （见 src/coach/roco-client.js 的 ROCO_TOOLS）。服务端接受它，
        # 自己算出换出了谁、换入了谁——调用方说的是「换成什么样」，
        # 而不是「用谁换谁」，让服务端做这个 diff 可以少一个出错的地方。
        before = body.get("team_before")
        after = body.get("team_after")
        if not isinstance(before, list) or not all(isinstance(x, str) for x in before):
            return self._answer_envelope(_bad_request("team_before 必须是精灵 id 的数组"), body, started)
        if not isinstance(after, list) or not all(isinstance(x, str) for x in after):
            return self._answer_envelope(_bad_request("team_after 必须是精灵 id 的数组"), body, started)
        if len(before) != len(after):
            return self._answer_envelope(
                _bad_request("team_before 与 team_after 长度必须相同（只做等量换人比较）"), body, started)

        dropped = [p for p in before if p not in after]
        added = [p for p in after if p not in before]
        if len(dropped) != 1 or len(added) != 1:
            return self._answer_envelope(
                _bad_request(f"两支队伍应当只差一只（实际换出 {len(dropped)}、换入 {len(added)}）"),
                body, started)
        drop, replacement = dropped[0], added[0]
        for pid in (drop, replacement):
            if pid not in rs.pets:
                return self._answer_envelope(_not_found(f"未知精灵：{pid}"), body, started)

        try:
            comp = team_mod.compare_team_change(
                before, replacement, drop=drop, rs=rs,
                loadouts=body.get("loadouts"),
            )
        except ValueError as exc:
            return self._answer_envelope(_bad_request(str(exc)), body, started)

        return self._answer_envelope(Answer(
            result=comp,
            coverage=1.0,
            evidence_ids=[f"ev:{rs.ruleset_id}:pets.json#{p}" for p in after],
            extra={"calibration": comp.get("calibration")},
        ), body, started)

    def battle_plan(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """2—3 回合联合动作搜索。

        **输入是公开 planner state，不是 `env.serialize()` 的私有状态。**
        用公开 schema 而不是整份内部状态，是因为内部状态带真实 seed、
        对手本回合已提交的动作与对手后备血量——那些都是隐藏信息。

        随机性：真实对局 seed 不参与。分析用 `DEFAULT_ANALYSIS_SEEDS` 固定集合
        （也可由请求显式给定，用于复现），并**跨种子聚合**期望与最差尾部，
        所以结论不依赖任何一个特定随机序列。同速裁决在真实对局里可能任一结果，
        聚合后给出的是分布区间，而不是「按某个 seed 会怎样」。
        """
        started = time.perf_counter()
        from . import planner as pm

        rs, early = self._ruleset_ok(body)
        if early is not None:
            return early

        public = body.get("public") if isinstance(body.get("public"), dict) else None
        if public is None:
            return self._answer_envelope(_bad_request(
                "缺少 public：规划请求必须用 env.public_planner_state() 产出的公开 state，"
                "而不是 env.serialize() 的私有状态（后者含真实 seed 与对手待执行动作）"
            ), body, started)
        # 形状先校验，再进引擎。不校验的话，字段缺失会在重建时抛异常，
        # 变成 500 internal_error——那是**调用方的错**，应当明确报 400。
        # （这条是被 bridge 的一条测试逼出来的：它传 {turn:3} 期望 400 而不是 500。）
        if public.get("schema_version") != env_mod.PUBLIC_PLANNER_SCHEMA_VERSION:
            return self._answer_envelope(_bad_request(
                f"public.schema_version 必须是 {env_mod.PUBLIC_PLANNER_SCHEMA_VERSION}，"
                f"实际 {public.get('schema_version')!r}；"
                "这个对象应当来自 env.public_planner_state()"
            ), body, started)
        for required in ("self", "opponent"):
            if not isinstance(public.get(required), dict):
                return self._answer_envelope(_bad_request(
                    f"public.{required} 必须是对象（来自 env.public_planner_state()）"), body, started)
        if not isinstance(public["self"].get("pets"), list) or not public["self"]["pets"]:
            return self._answer_envelope(_bad_request("public.self.pets 必须是非空数组"), body, started)
        if not isinstance(public["opponent"].get("field"), dict):
            return self._answer_envelope(_bad_request("public.opponent.field 必须是对象"), body, started)

        raw_seeds = body.get("analysis_seeds", list(DEFAULT_ANALYSIS_SEEDS))
        if not isinstance(raw_seeds, list) or not raw_seeds:
            return self._answer_envelope(_bad_request("analysis_seeds 必须是非空整数数组"), body, started)
        if len(raw_seeds) > 8:
            return self._answer_envelope(_bad_request("analysis_seeds 最多 8 个"), body, started)
        for sv in raw_seeds:
            if not isinstance(sv, int) or sv < 0:
                return self._answer_envelope(_bad_request("analysis_seeds 必须是非负整数"), body, started)

        # 伤害预览（W3-04 延伸）：只在请求显式要求时算，且**只走公开状态**。
        # 为什么要它：玩家脑子里记的那个数字就是「这一下打多少」，而
        # `expected`/`worst` 是估值口径，看不出够不够收。这里给的是**原始伤害范围**
        # 与「能不能一击收掉」，并明确标注它是未核验公式的输出。
        damage_preview = body.get("damage_preview") is True

        depth = body.get("depth", pm.DEFAULT_DEPTH)
        beam = body.get("beam", pm.DEFAULT_BEAM)
        budget = body.get("budget_ms", pm.DEFAULT_BUDGET_MS)
        for name, val, lo, hi in (("depth", depth, 1, pm.MAX_DEPTH),
                                  ("beam", beam, 1, pm.MAX_BEAM),
                                  ("budget_ms", budget, 10, 10000)):
            if not isinstance(val, int) or not (lo <= val <= hi):
                return self._answer_envelope(
                    _bad_request(f"{name} 必须是 {lo}..{hi} 之间的整数"), body, started)

        # 跨种子聚合：每个 analysis seed 重建一次搜索状态
        per_seed = []
        previews: List[Dict[str, Any]] = []
        unsupported_total = 0
        for sv in raw_seeds:
            try:
                state = env_mod.state_from_public_planner(public, rs, analysis_seed=sv)
            except (ValueError, KeyError, TypeError) as exc:
                return self._answer_envelope(_bad_request(
                    f"public 无法重建为分析状态：{type(exc).__name__}: {exc}"), body, started)
            if state.result:
                return self._answer_envelope(Answer(
                    result=None, coverage=1.0,
                    unsupported=[{"reason": "对局已结束，没有可规划的动作"}],
                ), body, started)
            plan = pm.plan_actions(state, rs, depth=depth, beam=beam, budget_ms=budget)
            unsupported_total += plan.unsupported_seen
            per_seed.append(plan.to_dict())
            if damage_preview:
                # 只在**第一个**种子采样：伤害不依赖 analysis seed 之外的随机吗？
                # 依赖。所以这里对每个种子都采，最后取包络（见下面的聚合）。
                previews.append(self._damage_preview(state, rs))

        # 推荐必须跨种子一致才敢说「推荐」；不一致就如实说「随随机性变化」
        labels = {p["recommended_label"] for p in per_seed}
        expectations = [p["expected"] for p in per_seed]
        worsts = [p["worst"] for p in per_seed]
        bests = [p["best"] for p in per_seed]
        timed_out = any(p["timed_out"] for p in per_seed)
        coverage = sum(p["coverage"] for p in per_seed) / len(per_seed)

        payload = {
            "schema_version": public.get("schema_version"),
            "state_version": public.get("state_version"),
            "turn": public.get("turn"),
            "analysis_seeds": raw_seeds,
            "recommendation_stable": len(labels) == 1,
            "recommended_label": per_seed[0]["recommended_label"] if len(labels) == 1 else None,
            "recommended_by_seed": {
                sv: p["recommended_label"] for sv, p in zip(raw_seeds, per_seed)
            },
            "expected": {"min": min(expectations), "max": max(expectations),
                         "mean": sum(expectations) / len(expectations)},
            "worst": {"min": min(worsts), "max": max(worsts)},
            "best": {"min": min(bests), "max": max(bests)},
            "main_counter": per_seed[0]["main_counter"],
            "counter_note": per_seed[0]["counter_note"],
            "branches_evaluated": sum(p["branches_evaluated"] for p in per_seed),
            "depth_searched": max(p["depth_searched"] for p in per_seed),
            "beam": beam,
            "coverage": coverage,
            "timed_out": timed_out,
            "unsupported_seen": unsupported_total,
            "opponent_model": per_seed[0]["opponent_model"],
            # 风险分支（W3-04）：把每个分析种子的 downside 聚成区间，
            # 并给出最差的那个种子的 top_risks（它们描述的才是真实的对手动作名）。
            "risk": {
                "downside_min": round(min(p["risk"].get("downside", 0.0) for p in per_seed), 4),
                "downside_max": round(max(p["risk"].get("downside", 0.0) for p in per_seed), 4),
                "fragile": any(p["risk"].get("fragile") for p in per_seed),
                "threshold": per_seed[0]["risk"].get("threshold"),
                "worst_seed_risks": max(
                    per_seed, key=lambda p: p["risk"].get("downside", 0.0)
                )["risk"].get("top_risks", []),
                "note": (
                    "risk 只描述推荐那一手的落差：`downside` 是期望到最坏的举例，"
                    "`fragile` 表示落差超过产品阈值（用于措辞分级，不是游戏机制）。"
                    "对手仍是启发式分布建模，不是真人行为。"
                ),
            },
            "damage_preview": self._merge_previews(previews) if damage_preview else None,
            "per_seed": per_seed,
        }

        unsupported = []
        if timed_out:
            unsupported.append({"reason": "至少一个 analysis seed 未在预算内搜完，结果不是完整搜索",
                                "coverage": coverage})
        if unsupported_total:
            unsupported.append({"reason": f"搜索中共遇到 {unsupported_total} 条未核验机制登记（fail closed）"})
        if len(labels) != 1:
            unsupported.append({
                "reason": "推荐动作随 analysis seed 变化，说明它不是一个稳健结论；请把 expected/worst 区间当作结论",
                "labels": sorted(labels),
            })

        return self._answer_envelope(Answer(
            result=payload,
            coverage=coverage,
            evidence_ids=[f"ev:{rs.ruleset_id}:public-state@{public.get('state_version')}"],
            unsupported=unsupported,
            extra={"limitations": [
                "估值是启发式局面分，**不是胜率**；expected 不能读成「赢的概率」",
                "对手后备血量与配招不在公开信息里，按满血+规范配招建模（见 public.assumptions）",
                "随机性用与真实对局无关的 analysis_seeds，并跨种子聚合；结论不依赖真实 seed",
                "对手按启发式分布建模，不是真实对手行为模型",
                "这是**分析**状态，不是权威对局状态；实际结算以游戏内为准",
            ]},
        ), body, started)

    # ── 本地对局驱动（与教练规划属于**两个信任域**）─────────────────────
    #
    # `/battle/plan` 只接受**公开** planner state：那是教练侧，真实 seed 与对手
    # 待执行动作都是隐藏信息，桥连发都不发。
    #
    # 下面这三个端点不一样：它们由本机的 Node 服务调用，作用是**驱动一局本地
    # 练习对局**（演示页用），输入输出都包含完整私有状态 —— 含真实 seed。
    # 这不是把隐藏信息边界放松了，而是把两个域分开：
    #
    #   · 教练域：浏览器 → Node → /battle/plan，只带公开面。真实 seed 永远不出 Node。
    #   · 对局域：Node → /battle/new|legal|advance，带私有状态。私有状态**不返回浏览器**，
    #     浏览器拿到的只有 public_planner_state 与摘要事件。
    #
    # 因此这三个端点的回执里显式写着 `trust_domain: "local_sim"`，
    # 并且它们的输出**不允许**直接塞进教练请求（教练请求由 public_planner_state 产出）。

    def battle_new(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """开一局本地练习对局，返回初始私有状态 + 公开面 + 双方合法动作。"""
        started = time.perf_counter()
        from . import env as env_mod

        rs, early = self._ruleset_ok(body, PRIVATE_TRUST_DOMAIN)
        if early is not None:
            return early

        team = body.get("team")
        if not isinstance(team, list) or len(team) != 3 or not all(isinstance(x, str) for x in team):
            return self._answer_envelope(_bad_request("team 必须是 3 个精灵 id 的数组"), body, started)
        enemy_team = body.get("enemy_team", team)
        if not isinstance(enemy_team, list) or len(enemy_team) != 3 or not all(isinstance(x, str) for x in enemy_team):
            return self._answer_envelope(_bad_request("enemy_team 必须是 3 个精灵 id 的数组"), body, started)
        seed = body.get("seed", 1)
        if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
            return self._answer_envelope(_bad_request("seed 必须是非负整数"), body, started)
        loadouts = body.get("loadouts")
        if loadouts is not None and not isinstance(loadouts, dict):
            return self._answer_envelope(_bad_request("loadouts 必须是 {pet_id: [skill_id...]}"), body, started)

        try:
            state = env_mod.reset(list(team), list(enemy_team), seed=seed, rs=rs, loadouts=loadouts)
        except (ValueError, KeyError) as exc:
            return self._answer_envelope(_bad_request(f"无法开局：{type(exc).__name__}: {exc}"), body, started)

        strategy, why = self._sim_strategy(body, started)
        if why is not None:
            return why
        return self._sim_envelope(state, rs, strategy, body, started, event="battle_new")

    def battle_legal(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """列出私有一局里双方当前的合法动作（私有域，见上）。"""
        started = time.perf_counter()
        state, rs, early = self._private_state(body, started)
        if early is not None:
            return early
        strategy, why = self._sim_strategy(body, started)
        if why is not None:
            return why
        return self._sim_envelope(state, rs, strategy, body, started, event="battle_legal")

    def battle_advance(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """推进一个回合（或一次补位）。

        对手那一手由服务端按策略决定，且**在双方行动都提交之后**才结算 ——
        策略只拿得到公开 observation（`opponents.wrap_observation` 是只读代理），
        拿不到玩家的选择。
        """
        started = time.perf_counter()
        from . import env as env_mod
        from . import opponents as opp

        state, rs, early = self._private_state(body, started)
        if early is not None:
            return early

        strategy, why = self._sim_strategy(body, started)
        if why is not None:
            return why

        raw_action = body.get("action")
        player_strategy, player_why = self._player_strategy(body, started)
        if player_why is not None:
            return player_why
        if raw_action is None and player_strategy is None:
            return self._answer_envelope(_bad_request(
                "必须给出 action（玩家这一手），或者给出 player_strategy 让策略代打"), body, started)
        if raw_action is not None and not isinstance(raw_action, dict):
            return self._answer_envelope(_bad_request("action 必须是对象（玩家这一手）"), body, started)
        player_action = None
        if isinstance(raw_action, dict):
            try:
                player_action = Action.from_dict(raw_action)
            except (ValueError, RulesetError) as exc:
                return self._answer_envelope(_bad_request(f"动作不合法：{exc}"), body, started)

        # 事件要在推进**之前**记下长度：引擎的 state.events 只保留当前回合的，
        # 回合末会清空（_end_of_turn），推进完再按 turn 过滤会拿到空数组。
        # 这里取的是「这次推进新产生的那些事件」。
        events_before = len(state.events)
        try:
            if state.phase == "replace":
                # 补位可能**两边都要**补：对手倒下也要由本服务替它补位，
                # 否则 state 会永远停在 phase=replace（真出现过：对手 0 号位倒下后
                # 只补玩家一侧，推进 400 次还在同一回合）。
                # 顺序按 `needs_replacement` 给的队列，和 `play_match` 一致；
                # 每次补位只让那一方按策略选，不把对手换了谁告诉另一方。
                if player_action is not None:
                    if player_action.kind != "switch" or player_action.target_index is None:
                        return self._answer_envelope(_bad_request(
                            "当前是补位阶段，action 必须是 kind=switch 且带 target_index"), body, started)
                queue = env_mod.needs_replacement(state)
                if player_action is not None and "player" not in queue:
                    queue = ["player"] + list(queue)
                for side in queue:
                    if state.phase != "replace":
                        break
                    if side == "player" and player_action is not None:
                        env_mod.step_replace(state, rs, "player", int(player_action.target_index))
                        player_action = None
                        continue
                    legal_side = env_mod.legal_actions(state, rs, side)
                    switch = [a for a in legal_side if a.kind == "switch"]
                    if not switch:
                        continue
                    chooser = player_strategy if side == "player" else strategy
                    if chooser is None:
                        return self._answer_envelope(_bad_request(
                            "补位阶段需要 player_strategy（或显式 action）才能替玩家补位"), body, started)
                    slot = chooser.act(
                        env_mod.observe(state, rs, side), switch, int(state.seed), int(state.turn)
                    ).target_index
                    env_mod.step_replace(state, rs, side, int(slot))
            else:
                legal_enemy = env_mod.legal_actions(state, rs, "enemy")
                if not legal_enemy:
                    return self._answer_envelope(_bad_request("对手没有合法动作，无法推进"), body, started)
                if player_action is None:
                    legal_me = env_mod.legal_actions(state, rs, "player")
                    if not legal_me:
                        return self._answer_envelope(_bad_request("玩家没有合法动作，无法推进"), body, started)
                    player_action = player_strategy.act(
                        env_mod.observe(state, rs, "player"), legal_me, int(state.seed), int(state.turn)
                    )
                # 策略只能看 observation 代理；真实 seed 只用于它自己的确定性随机源。
                obs = env_mod.observe(state, rs, "enemy")
                enemy_action = strategy.act(obs, legal_enemy, int(state.seed), int(state.turn))
                env_mod.step_joint(state, rs, player_action, enemy_action)
        except (ValueError, RulesetError) as exc:
            return self._answer_envelope(_bad_request(f"无法推进：{exc}"), body, started)

        return self._sim_envelope(
            state, rs, strategy, body, started, event="battle_advance", events_from=events_before
        )

    def _damage_preview(self, state, rs) -> Dict[str, Any]:
        """对**公开状态重建出来的**局面采样一次原始伤害。

        做法是「配招里每个攻击技能各算一遍」——用的是 `effects.compute_damage`，
        也就是引擎**唯一**的那份伤害实现（`env._execute` 走同一条路）。
        对手这一手不参与：伤害预览只回答「我这一下打多少、够不够收」，
        不是一次联合结算的预测。

        **用配招表而不是 `legal_actions`**：后者会被能量与先手度过滤掉，
        拿它当值域会系统性低估上界（实测漏掉过 425 的那一击，只看到 130）。
        代价是列表里可能包含能量不够、这一步打不出的技能 ——
        所以每个样本都带 `energy`，让人自己判断这一步够不够用。

        覆盖不到的地方如实登记：条件化威力读不出来的技能进 `skipped_skills`，
        不猜、不填默认值。
        """
        from . import effects as fx_mod

        foe_hp = state.enemy.field_pet.hp
        pet = state.player.field_pet
        foe_pet = state.enemy.field_pet
        attacks = []
        for skill_id in (state.player.loadouts.get(pet.pet_id) or ()):
            skill = rs.skills.get(skill_id)
            if skill is None or not skill.is_attack:
                continue
            attacks.append(skill)
        if not attacks:
            return {"available": False, "reason": "我方场上这只没有带任何攻击技能",
                    "skipped_skills": []}

        # 用 `effects.compute_damage` —— 那是引擎**唯一**的伤害实现
        # （`env._execute` 也走它）。以前这里是「克隆整份状态 + 跑一次 _execute +
        # 从事件里读伤害」，能算但代价大得多，而且要求被算的局面必须是可执行的。
        damages: List[Dict[str, Any]] = []
        skipped: List[str] = []
        for skill in attacks:
            try:
                outcome = fx_mod.compute_damage(pet, foe_pet, skill, rs)
            except fx_mod.UnsupportedEffect:
                # fail closed：条件化威力读不出来的技能不猜，如实登记
                skipped.append(skill.skill_id)
                continue
            damages.append({
                "label": skill.name,
                "kind": "skill",
                "skill_id": skill.skill_id,
                "damage": outcome.damage,
                "energy": skill.energy,
                "formula_verified": outcome.verified,
            })
        if not damages:
            return {"available": False,
                    "reason": "配招里没有任何攻击技能能算出伤害（可能全部被 fail closed 拦下）",
                    "skipped_skills": skipped}
        low = min(d["damage"] for d in damages)
        high = max(d["damage"] for d in damages)
        best = max(damages, key=lambda d: d["damage"])
        return {
            "available": True,
            "min": low,
            "max": high,
            "best_label": best["label"],
            "lethal": high >= foe_hp,
            "foe_hp": foe_hp,
            "samples": damages,
            "skipped_skills": skipped,
            "candidates": len(attacks),
            "formula_verified": fx_mod.active_damage_model().verified,
            "damage_model": fx_mod.active_damage_model().name,
        }

    @staticmethod
    def _merge_previews(previews: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """把多个 analysis seed 的预览合并成**包络**。

        不同的分析种子会重建出不同的分析状态（对手后备按满血建模，但同速裁决
        等随机不同），所以伤害也不完全一样。合并口径：min 取最小、max 取最大、
        `lethal` 取「**任何**一个种子都能收掉」——那是可以行动的结论；
        反过来「有的种子收不掉」必须让人看见，所以另给 `lethal_stable`。
        """
        usable = [p for p in previews if p and p.get("available")]
        if not usable:
            return previews[0] if previews else {"available": False, "reason": "没有可用的预览"}
        lethal_flags = [bool(p["lethal"]) for p in usable]
        # 合并每个技能的伤害：同一个技能在不同分析种子下可能略有差异，
        # 取**最小与最大**作为它的区间——不平均掉，因为玩家要的是「打多少」的界。
        merged: Dict[str, Dict[str, Any]] = {}
        for preview in usable:
            for sample in preview.get("samples", []):
                label = sample["label"]
                entry = merged.setdefault(label, {"label": label, "min": sample["damage"],
                                                  "max": sample["damage"]})
                entry["min"] = min(entry["min"], sample["damage"])
                entry["max"] = max(entry["max"], sample["damage"])
        return {
            "available": True,
            "min": min(p["min"] for p in usable),
            "max": max(p["max"] for p in usable),
            "best_label": max(usable, key=lambda p: p["max"])["best_label"],
            "lethal": all(lethal_flags),
            "lethal_stable": len(set(lethal_flags)) == 1,
            "foe_hp": usable[0]["foe_hp"],
            "skipped_skills": sorted({k for p in usable for k in p.get("skipped_skills", [])}),
            "candidates": max(p.get("candidates", 0) for p in usable),
            "formula_verified": usable[0]["formula_verified"],
            "damage_model": usable[0]["damage_model"],
            "seeds_merged": len(usable),
            "samples": sorted(merged.values(), key=lambda x: -x["max"]),
            "note": (
                "原始伤害范围：**未核验公式**的输出（COMMUNITY_HYPOTHESIS_V1），"
                "不是游戏内实测值。`lethal` 表示所有分析种子都能一击收掉；"
                "`lethal_stable` 为假表示结论随分析种子变化，别当保证。"
                "状态技能/道具/换人不产生伤害，列在 skipped_kinds 里。"
            ),
        }

    def _sim_strategy(self, body: Dict[str, Any], started: float):
        """解析并绑定对手策略。名字必须在注册表里，绝不静默退回默认策略。"""
        from . import opponents as opp

        name = body.get("strategy", "greedy_damage")
        if not isinstance(name, str):
            return None, self._answer_envelope(_bad_request("strategy 必须是字符串"), body, started)
        try:
            return opp.get_strategy(name), None
        except KeyError:
            return None, self._answer_envelope(_bad_request(
                f"未知策略 {name!r}；可选：{[s['name'] for s in opp.list_strategies()]}"), body, started)

    def _player_strategy(self, body: Dict[str, Any], started: float):
        """可选的「玩家一侧也交给策略」开关，用于自动演示与批量推演。

        没给就是 None（正常玩法：玩家自己出招）。
        """
        from . import opponents as opp

        name = body.get("player_strategy")
        if name is None:
            return None, None
        if not isinstance(name, str):
            return None, self._answer_envelope(_bad_request("player_strategy 必须是字符串"), body, started)
        try:
            return opp.get_strategy(name), None
        except KeyError:
            return None, self._answer_envelope(_bad_request(
                f"未知 player_strategy {name!r}；可选：{[s['name'] for s in opp.list_strategies()]}"),
                body, started)

    def _private_state(self, body: Dict[str, Any], started: float):
        """把 body 里的私有状态还原成 GameState。缺 state 就是调用方的错（400）。

        顺带把规则集绑到策略的线程本地（`opponents.bind_ruleset`）：策略的启发式要读
        技能表与属性相性，没绑定就会抛 `RulesetNotBound`。绑定放在这一处而不是每个
        端点各写一次，是为了让「忘了绑定」不可能发生。
        """
        from . import env as env_mod
        from . import opponents as opp

        rs, early = self._ruleset_ok(body, PRIVATE_TRUST_DOMAIN)
        if early is not None:
            return None, None, early
        raw = body.get("state")
        if not isinstance(raw, dict):
            return None, None, self._answer_envelope(_bad_request(
                "state 必须是 env.serialize() 产出的私有状态（本地对局域专用）"), body, started)
        try:
            state = env_mod.deserialize(raw, rs)
        except (ValueError, KeyError, TypeError) as exc:
            return None, None, self._answer_envelope(_bad_request(
                f"state 无法还原：{type(exc).__name__}: {exc}"), body, started)
        opp.bind_ruleset(rs)
        return state, rs, None

    def _sim_envelope(
        self, state, rs, strategy, body: Dict[str, Any], started: float, *, event: str,
        events_from: int = 0,
    ):
        """本地对局域的统一回执：私有状态 + 公开面 + 双方合法动作 + 本回合事件。

        ``events_from`` 是推进前 `state.events` 的长度，用来切出「这次新产生的事件」。
        """
        from . import env as env_mod

        def acts(side: str) -> List[Dict[str, Any]]:
            out = []
            for action in env_mod.legal_actions(state, rs, side):
                d = action.to_dict()
                d["label"] = action.label(rs)
                if action.kind == "skill" and action.skill_id:
                    skill = rs.skill(action.skill_id)
                    d["skill_name"] = skill.name
                out.append(d)
            return out

        unsupported: List[Dict[str, Any]] = []
        if state.unsupported:
            unsupported.append({
                "code": "unverified_mechanics_seen",
                "reason": f"本局已登记 {len(state.unsupported)} 条未核验机制（fail closed，不生成默认值）",
                "entries": list(state.unsupported)[:20],
            })

        return self._answer_envelope(Answer(
            trust_domain=PRIVATE_TRUST_DOMAIN,
            result={
                "trust_domain": PRIVATE_TRUST_DOMAIN,
                "note": (
                    "这是**本地练习对局**的私有状态，含真实 seed；只允许留在本机 Node 里。"
                    "教练侧请求必须用 public_planner_state 产出的公开面，不要把这个对象传过去。"
                ),
                "event": event,
                "state": env_mod.serialize(state),
                "state_version": state.state_version,
                "phase": state.phase,
                "turn": state.turn,
                "result": state.result,
                "public": env_mod.public_planner_state(state, rs, "player"),
                "legal": {"player": acts("player"), "enemy": acts("enemy")},
                "needs_replacement": env_mod.needs_replacement(state),
                "events": [e.to_dict() for e in state.events[events_from:]] if event == "battle_advance" else [],
                "strategy": {"name": strategy.name, "version": strategy.version},
                "unsupported_seen": list(state.unsupported),
            },
            coverage=1.0 if not state.unsupported else 0.0,
            evidence_ids=[ev(rs.ruleset_id, "public-state", str(state.state_version))],
            unsupported=unsupported,
        ), body, started)

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
            routes=list(ROUTES),
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
            elif path == "/team/evaluate":
                status, env = service.team_evaluate(body)
            elif path == "/team/compare":
                status, env = service.team_compare(body)
            elif path == "/battle/plan":
                status, env = service.battle_plan(body)
            elif path == "/battle/new":
                status, env = service.battle_new(body)
            elif path == "/battle/legal":
                status, env = service.battle_legal(body)
            elif path == "/battle/advance":
                status, env = service.battle_advance(body)
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
            # 未登记路径分两种，必须分得开：
            #   · 说得出「这个能力没做」的（在 NOT_IMPLEMENTED 里）→ 501 not_implemented；
            #   · 其余 → 404 not_found。
            # 之前 NOT_IMPLEMENTED 是空字典，任何路径都退化成 404，
            # 「还没做」与「地址写错了」在回执里完全看不出区别。
            if path in NOT_IMPLEMENTED:
                self._dispatch(path, {})
                return
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


ROUTES = ("/health", "/rules/query", "/team/evaluate", "/team/compare", "/battle/plan",
          "/battle/new", "/battle/legal", "/battle/advance")


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
