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
    POST /battle/free    一个**不占行动**的自由动作（PVP 魔法 / 背包物品，**私有域**）

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
3. **双属性相性是「两系相乘」，组合可查性以快照的行集为界。** 2026-09-25 人类裁决
   （台账 ``EV-TYPE-MULTIPLIER``，RECORDED_IN_GAME）：「快照 3×（现用）vs 两个社区源 4×，
   差 41 格。**使用社区源**」⇒ 倍率 = 两条单属性行相乘（与 ``data.TypeChart.multiplier``
   同口径）。快照 ``types.json`` 有 86 个不同的双属性组合（102 条键、16 对互为反写），
   18 选 2 的其余 67 种组合没有行 ⇒ ``unsupported``（该组合不可查，不猜中性值）。
   **旧口径留痕**：本条原文写「只用快照里显式给出的行，不用相乘补 —— 该假设与快照 41 处
   不符」；那句话在裁决之前成立，现在被人类裁决取代，历史不抹掉。

需要另一侧配合的一处接口
------------------------

``data.py`` 的 ``TypeChart`` 现在**两种行都装载**（单属性行用于结算，双属性行用于说明
「这个组合有没有数据」）。本服务仍然用 ``_type_rows()`` 读一次原始 ``types.json``：
它要回答的是「快照原文怎么说」（``type_row``）与「快照与裁决口径差在哪 41 格」
（``type_chart`` 对账表），并顺手用 ``rs.files["types.json"]`` 的 sha256 校验快照
没有在加载后变动。这是**明确的只读 I/O**，不是绕过 ``TypeChart``。
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

from . import events_text
from . import coverage as coverage_mod
from . import effects as fx
from .coverage import classify_skill_declared
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs

try:  # 作为包导入：python3 -m roco_env.service
    from .data import (DEFAULT_RULESET, SUPPORT_SIMULATABLE_UNVERIFIED, Ruleset, RulesetError,
                       load_ruleset)
    from . import team as team_mod
    from . import env as env_mod
    from . import opponents as opp
    from . import team_model as tm
    from .schema import Action
except ImportError:  # 直接当脚本跑：python3 roco/src/roco_env/service.py
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from roco_env.data import (DEFAULT_RULESET, SUPPORT_SIMULATABLE_UNVERIFIED, Ruleset,  # type: ignore
                               RulesetError, load_ruleset)
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


# ── 04.2：对手依据分开写（scenario-driven vs assumption-driven）──────────────
#
# 为什么必须分两栏：注入的情景目前只**筛**可枚举技能/位次，
# `OPPONENT_BENCH_ASSUMPTION`（对手后备满血 + 规范配招 + 未亮明用占位物种）
# 仍然生效。把两者混写成一句「对手按情景建模」，读者会以为对手侧已经按可学池
# 重建了 —— 那是**没做**的事。这里一栏一栏分开写，并把没做的登记成残留（P3）。

#: 显式残留登记（P3）：**不做**「用情景可学池替换对手配招假设」，只登记 + 自带两条判据。
OPPONENT_BASIS_RESIDUALS: List[Dict[str, Any]] = [
    {
        "id": "P3",
        "what": "用情景可学池（03 的 buildOpponentCandidates → skills.possible）替换对手配招假设",
        "replaces": "rs.candidate_moveset(pet_id)（重建状态里对手的 loadouts）",
        "status": "not_done",
        "planned": "04.2b 或 05 专项（另开切片，需 Lead 裁决）",
        "why_not_here": "替换会改**对手侧结算语义**（对手能出什么 = 我方估值的分母与合法动作集），"
                        "与「把情景当筛子」不是一个量级；04.2 的边界是只筛不改假设。",
        "criteria": [
            "判据①（隐藏真值不变）：固定同一份公开面，只改隐藏的真实对手配招/后备血量 ⇒ "
            "确定性推荐逐字段不变；",
            "判据②（只吃公开面）：注入的可学池必须来自公开事实（已见技能 / 冻结学招表）；替换后"
            "引擎枚举出的对手技能集合 ⊆ 可学池 ∪ 公开已见技能；任何 private serialize() 字段仍被 400 拒绝。",
        ],
    },
]


def _dedup_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 canonical JSON 去重（同一缺项会在多个分析种子下重复出现）。"""
    out: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        key = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def opponent_basis_block(
    per_seed: List[Dict[str, Any]],
    seeds: List[int],
    parsed: List[Any],
    *,
    public_assumptions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """04.2：「本次对手依据」写成机器可检的一栏，**两类依据分开**。

    只在请求显式带了 `opponent_scenarios` 时调用 —— 不带这个键的缺省路径回执
    与 04.2 之前**逐字段相同**（键集金标在 `roco/tests/test_plan_scenarios.py`）。

    四栏：
      · `source` / `label`  —— 本次用的是哪种依据（注入情景 / 规范配招假设缺省）；
      · `scenario_driven`   —— **情景点名**并在重建状态里枚举出来的动作（逐种子）+ 截断 + 缺项；
      · `assumption_driven` —— 本步**仍然生效**的假设（后备满血 + 规范配招 + 占位物种）；
      · `residuals`         —— 显式残留登记（P3：还没用可学池替换规范配招假设）。
    两类依据都不产出概率：`is_probability` 一律 false。
    """
    details = [(p.get("opponent_model_detail") or {}) for p in per_seed]
    first = details[0] if details else {}
    injected = bool(parsed)
    scenario_driven: Optional[Dict[str, Any]] = None
    if injected:
        actions_by_seed: Dict[str, List[Dict[str, Any]]] = {}
        enumerated_by_seed: Dict[str, Any] = {}
        enumerated_by_scenario: Dict[str, Any] = {}
        unavailable: List[Dict[str, Any]] = []
        dropped: List[Dict[str, Any]] = []
        for sv, detail in zip(seeds, details):
            key = str(sv)
            actions_by_seed[key] = [dict(row) for row in (detail.get("enumerated_actions") or [])]
            enumerated_by_seed[key] = detail.get("enumerated", 0)
            enumerated_by_scenario[key] = dict(detail.get("enumerated_by_scenario") or {})
            unavailable.extend(detail.get("unavailable") or [])
            dropped.extend(detail.get("dropped") or [])
        scenario_driven = {
            "scenario_ids": list(first.get("scenario_ids") or []),
            "kinds": list(first.get("kinds") or []),
            "actions_by_seed": actions_by_seed,
            "enumerated_by_seed": enumerated_by_seed,
            "enumerated_by_scenario": enumerated_by_scenario,
            "dropped": _dedup_rows(dropped),
            "unavailable": _dedup_rows(unavailable),
            "evidence_ids": sorted({e for d in details for e in (d.get("evidence_ids") or [])}),
            "weights": first.get("weights") or "uniform_baseline",
            "basis": first.get("basis") or "",
            "is_probability": False,
            "note": ("scenario-driven = 情景点名、并在重建状态里枚举出来的动作；只筛、按 scenario_id "
                     "定序、不当概率；枚举不出来的在 unavailable[] 里逐条点名"),
        }
    return {
        "source": "injected_scenarios" if injected else "default_candidate_moveset",
        "label": ("本次对手依据 = 注入情景" if injected
                  else "本次对手依据 = 规范配招假设(缺省)"),
        "is_probability": False,
        "scenario_driven": scenario_driven,
        "assumption_driven": {
            "opponent_bench": env_mod.OPPONENT_BENCH_ASSUMPTION,
            "opponent_moveset": "rs.candidate_moveset(pet_id)（规范配招假设）",
            "unrevealed_species": "占位物种（未亮明的后备不含物种身份）",
            "still_in_effect": True,
            "public_assumptions": (dict(public_assumptions)
                                   if isinstance(public_assumptions, dict) else None),
            # 键名与 scenario_driven 的 `note` **不同名**：两栏的键集必须互不相交，
            # 这样「有没有把两类依据混写」可以被机器判死（见 test_p3_separates_*）。
            "assumption_note": ("注入情景只**筛**可枚举技能/位次：对手后备仍按满血 + 规范配招 + "
                                "占位物种建模。情景点名但枚举不出来的技能/位次/物种如实记在 "
                                "scenario_driven.unavailable[]"),
        },
        "residuals": [dict(row) for row in OPPONENT_BASIS_RESIDUALS],
        "note": ("两类依据分开写：scenario_driven 是情景点名并枚举出来的，assumption_driven 是"
                 "本步仍然生效的假设；两者都不是概率、不是频率"),
    }


# ── 04.3：逐种子的 R3/R5/R8 三块聚合成回执级三栏 ─────────────────────────────


def aggregate_plan_traces(
    per_seed: List[Dict[str, Any]], seeds: List[int]
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """把逐种子的 `coverage_detail` / `truncation` / `budget` 聚合成回执级三栏。

    口径（逐条可核对）：
      · `coverage_detail` —— **计数比**：逐种子分子/分母 + 单位 + `is_confidence:false`。
        不给「一个数」代表所有种子：分析种子之间分母可能不同（重建状态可能不同）。
      · `truncation` —— 候选层裁剪：逐种子计数 + **并集**的逐条缺谁 + 规则。
      · `budget` —— 深度/束宽/预算：请求级参数（各种子相同）+ `depth_searched_max`
        （取最大）+ `nodes`（求和）+ `timed_out`（任一）。
    """
    coverage_rows = [(p.get("coverage_detail") or {}) for p in per_seed]
    trunc_rows = [(p.get("truncation") or {}) for p in per_seed]
    budget_rows = [(p.get("budget") or {}) for p in per_seed]
    first_cov = coverage_rows[0] if coverage_rows else {}
    first_trunc = trunc_rows[0] if trunc_rows else {}
    first_budget = budget_rows[0] if budget_rows else {}

    dropped: List[Dict[str, Any]] = []
    seen = set()
    for row in trunc_rows:
        for item in row.get("dropped") or []:
            key = json.dumps(item, ensure_ascii=False, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            dropped.append(item)

    coverage_detail = {
        "unit": first_cov.get("unit") or "count_ratio",
        "is_confidence": False,
        "is_probability": False,
        "by_seed": {str(sv): {"numerator": (row or {}).get("numerator"),
                              "denominator": (row or {}).get("denominator")}
                    for sv, row in zip(seeds, coverage_rows)},
        "meaning": first_cov.get("meaning"),
        "excluded_from_denominator": first_cov.get("excluded_from_denominator"),
        "note": first_cov.get("note"),
    }
    truncation = {
        "rule": first_trunc.get("rule"),
        "is_probability": False,
        "by_seed": {
            str(sv): {
                "candidates_total": (row or {}).get("candidates_total"),
                "candidates_kept": (row or {}).get("candidates_kept"),
                "candidates_dropped": (row or {}).get("candidates_dropped"),
                "kept_by_kind": (row or {}).get("kept_by_kind"),
                "dropped_by_kind": (row or {}).get("dropped_by_kind"),
                "uncomputable": (row or {}).get("uncomputable"),
            } for sv, row in zip(seeds, trunc_rows)
        },
        "dropped": dropped,
        "note": ("逐条列出被「类别保底 + 束宽」规则裁掉的候选（缺谁、按什么规则）；"
                 "搜索分支层面的丢弃（非法/机制未核验）见 per_seed[].dropped_branches"),
    }
    depths = [row.get("depth_searched") for row in budget_rows
              if isinstance((row or {}).get("depth_searched"), int)]
    budget = {
        "depth_requested": first_budget.get("depth_requested"),
        "depth_effective": first_budget.get("depth_effective"),
        "depth_max": first_budget.get("depth_max"),
        "depth_searched_max": max(depths) if depths else None,
        "depth_truncated": any((row or {}).get("depth_truncated") for row in budget_rows),
        "depth_capped_by_max": any((row or {}).get("depth_capped_by_max") for row in budget_rows),
        "beam_requested": first_budget.get("beam_requested"),
        "beam_effective": first_budget.get("beam_effective"),
        "beam_max": first_budget.get("beam_max"),
        "beam_truncated": any((row or {}).get("beam_truncated") for row in budget_rows),
        "budget_ms": first_budget.get("budget_ms"),
        "nodes": sum((row or {}).get("nodes") or 0 for row in budget_rows),
        "timed_out": any((row or {}).get("timed_out") for row in budget_rows),
        "note": first_budget.get("note"),
    }
    return coverage_detail, truncation, budget


# ── 04.4：稳健排序与「不是概率」声明的逐种子聚合 ─────────────────────────────


def aggregate_plan_robustness(
    per_seed: List[Dict[str, Any]], seeds: List[int]
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """把逐种子的 `robustness` / `declarations` 聚合成回执级两栏。

    · `robustness` —— 排序规则与阈值取第一个种子（请求级常量）；**并列**给「稳定并列」
      （每个分析种子都并列才算，避免把某一次搜索的巧合说成产品的两难）；
      重大损失动作给**并集**并标出它出现在哪些种子。
    · `declarations` —— 逐种子的声明做 canonical 比较，`by_seed_consistent` 如实报一致与否。
    """
    rob_rows = [(p.get("robustness") or {}) for p in per_seed]
    dec_rows = [(p.get("declarations") or {}) for p in per_seed]
    first = rob_rows[0] if rob_rows else {}

    by_seed: Dict[str, Any] = {}
    material: List[Dict[str, Any]] = []
    seen = set()
    for sv, row in zip(seeds, rob_rows):
        tied = [t.get("action") for t in (row.get("tied_with_top") or [])]
        lost = [a.get("action") for a in (row.get("material_loss_actions") or [])]
        by_seed[str(sv)] = {
            "top": (row.get("top") or {}).get("action"),
            "primary_rule_applied": bool(row.get("primary_rule_applied")),
            "tied_with_top": tied,
            "material_loss_actions": lost,
        }
        for entry in (row.get("material_loss_actions") or []):
            key = json.dumps(entry, ensure_ascii=False, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            material.append({**entry, "seeds": [str(sv)]})
    tie_sets = [{t.get("action") for t in (row.get("tied_with_top") or [])} for row in rob_rows]
    stable_ties = set.intersection(*tie_sets) if tie_sets else set()
    robustness = {
        "ordering": first.get("ordering"),
        "material_loss_threshold": first.get("material_loss_threshold"),
        "tie_epsilon": first.get("tie_epsilon"),
        "primary_rule_applied": any(bool(row.get("primary_rule_applied")) for row in rob_rows),
        "material_loss_actions": material,
        "tied_with_top_stable": sorted(stable_ties),
        "by_seed": by_seed,
        "is_probability": False,
        "note": (first.get("note") or "") + "；并列只报**每个分析种子都并列**的那些"
                "（tied_with_top_stable），逐种子的并列见 by_seed",
    }
    canon = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True)
    declarations = dict(dec_rows[0] if dec_rows else {})
    if declarations:
        declarations["by_seed_consistent"] = (
            len({canon(row) for row in dec_rows}) == 1
        )
    return robustness, declarations


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
        #: 规划搜索的**时钟接缝**（默认 `None` = 用真实时钟，行为与改动前逐位相同）。
        #:
        #: 为什么要有它：`plan_actions` 早就支持注入 `clock`（「方便测试用一个确定性时钟
        #: 验证超时后如实上报」），但 `/battle/plan` 这条路上测试注入不进去 ⇒ service 级
        #: 判据只能靠「预算开得足够大」躲挂钟（O-36：负载下会随机红）。给它一个接缝，
        #: 判据就能像 planner 级那样**完全确定**，而不是靠余量赌。
        self.plan_clock: Optional[Callable[[], float]] = None
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
                    # 这两个数是**冻结快照**的规模（回执回答的是「这份规则集是哪个版本」）。
                    # 按需推算的那 574 只不在冻结快照里，它们走 `build_support` 与产物本身
                    # （`data/roco/derived/on-demand-builds.json`）——把派生数据混进版本回执，
                    # 会让已录制且禁止重跑的 agent 轨迹全部对不上（实测踩到）。
                    "pets": getattr(rs, "frozen_pet_count", len(rs.pets)) or len(rs.pets),
                    # 2026-09-23：`skills` 也走同一条纪律。PVP 魔法「愿力强化」换进来的
                    # 36 条「愿力冲击」会进 `rs.skills` 供引擎解析，但**不许**改变这份回执 ——
                    # 已录制的 agent 轨迹靠回执摘要比对，而那份轨迹是**禁止重跑**的
                    # （实测：直接数 len(rs.skills) 会让 824 → 860，轨迹校验当场红）。
                    "skills": getattr(rs, "frozen_skill_count", 0) or len(rs.skills),
                    "learnsets": getattr(rs, "frozen_learnset_count", len(rs.learnsets)) or len(rs.learnsets),
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
            elif kind == "roster":
                # 给 UI 用的**可选用精灵名单**：真名、系别、六维、规范配招的四个技能。
                # 走 `rules_query` 而不是新开端点，是为了不碰信任域的路径白名单
                # （那条白名单有专门的测试钉着，动它得先想清楚）。
                answer = self._answer_roster(rs, query)
            elif kind == "term":
                answer = self._answer_term(rs, query)
            elif kind in ("type_row", "type_chart"):
                answer = self._answer_type_row(rs, query) if kind == "type_row" else self._answer_type_chart(rs)
            elif kind == "type_multiplier":
                answer = self._answer_type_multiplier(rs, query)
            elif kind == "policy":
                # 2026-09-25（人类点名「雨天水系伤害加多少」这类问法答不了）：**规则策略读口**。
                # 逐字回配置里声明的那一份，不改口径、不补默认、不替玩家算别的。
                answer = self._answer_policy(rs, query)
            elif kind == "catalog":
                # 2026-09-25（agent 主线 P0-a）：**按属性检索精灵**。
                # 真机实测「我想练一只抗龙系的伙伴，配哪四招？」agent 一次工具都没调
                # —— 因为 622 只里"谁抗龙系"根本没有读口：`pet` 只能按 id/名字查一只。
                answer = self._answer_catalog(rs, query)
            elif kind == "weakness_summary":
                # 2026-09-25（真机实测：「我这 48 只里整体最怕什么属性？」答成了"进入一场 PVE 对战后…"）：
                # **名单级**的相性汇总 —— 逐属性数"怕它的有几只"，口径就是引擎自己的相乘规则。
                answer = self._answer_weakness_summary(rs, query)
            elif kind == "legality":
                # 2026-09-25（agent 主线 P0-a 的最后一块）：**这份配招它学得到吗**。
                # `catalog` 答"该找谁"、`learnset` 答"它能学什么"，而玩家/模型手里常是
                # 一份**具体配招**（「带 火花、藤鞭、防御、休息回复」）—— 过去只能靠
                # `team/evaluate`（要凑满模式声明的队伍规模）或让模型自己比学习表。
                answer = self._answer_legality(rs, query)
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
                    # 同 `/status`：这两个数是**冻结快照**的规模（回执回答的是「这份规则集
                    # 是哪个版本」），按需推算的 574 只不在冻结快照里（见 Ruleset 上的注释）。
                    "pets": getattr(rs, "frozen_pet_count", len(rs.pets)) or len(rs.pets),
                    # 2026-09-23：`skills` 也走同一条纪律。PVP 魔法「愿力强化」换进来的
                    # 36 条「愿力冲击」会进 `rs.skills` 供引擎解析，但**不许**改变这份回执 ——
                    # 已录制的 agent 轨迹靠回执摘要比对，而那份轨迹是**禁止重跑**的
                    # （实测：直接数 len(rs.skills) 会让 824 → 860，轨迹校验当场红）。
                    "skills": getattr(rs, "frozen_skill_count", 0) or len(rs.skills),
                    "learnsets": getattr(rs, "frozen_learnset_count", len(rs.learnsets)) or len(rs.learnsets),
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

    def _skill_record(self, rs: Ruleset, skill: Any,
                      *, with_tier: bool = False) -> Dict[str, Any]:
        """技能记录。

        2026-09-22（C3-a：第 118 轮回退之后的**附加式**重做）：
        冻结数据里的 `effect_support` 是一刀切旧标记（实测 579 个进覆盖统计的技能全是
        `unsupported`，连纯伤害技能也是），拿它当判据会一律报「未核验/未实现」；
        逐技能的真实档位来自唯一分类器 `coverage.classify_skill`。

        **但默认回执一个键都不加**：Agent 的工具回执被钉死的轨迹摘要比着，多一个键就变，
        那等于悄悄改了模型看到的东西。所以档位只在调用方**显式索要**（`with_tier=True`）时才带出来。
        """
        # ── 2026-09-29（第三轮要求⑤）**按类判定"引擎到底结不结算"**，不再读静态 effect_support ──
        # 旧写法：`resolved = skill.effect_support == "supported"` —— 而 `effect_support` 是**冻结数据的
        # 一刀切旧标记**（本函数自己的 docstring 上一段就写着「连纯伤害技能也是 unsupported」），
        # ⇒ 拿它当判据会**把已经结算的也说成没结算**。真机实测（`docs/roco/review-2026-09-28/
        # BATCH-1-产品修复实测-2026-09-29.md` §145/§146/§148）：
        #   ✅ 已结算：伤害（`damage` 事件）· 减伤与应对（`defense` 事件带 `reduction`/`respond`，
        #              连打 40 手 ×27 次 `reduction=0.7`）· 聚能（`charge.energy_gained`）·
        #              能量回复（`energy_gain.amount`/`energy_after`）
        #   ❌ 未结算：持续·层数状态 / 双攻升降（把「引燃/毒孢子/腐蚀酸液」装上真打一局 ⇒ **零状态事件**，
        #              引擎改报 `effects_registered_unsupported`）
        # 判据（**严格口径**）：把 desc 里写明的效果**逐条**归类，**只要有明说未结算的那一类**，
        # 整条就按"没结算"报，并在 reason 里说清**哪一部分结算了、哪一部分没有** —— 不许一刀切，
        # 也不许含糊其辞。这条规则随 `LOCAL_SETTLEMENT_RULE` 版本化（要求④同一份本地训练规则）。
        # 2026-09-29（task-18 A 批）：**判据抽到唯一一处**（`coverage.settlement_verdict`）。
        # 此前这里一套按类判定、`coverage.classify_skill` 另一套 ⇒ 同一招在产品回执里说"已结算"、
        # 在工具回执里说"PARTIAL"（人类口径「同一规则同一投影」的同一条技能版本）。
        # 现在两处调同一个函数：改口径只改那一处，这个回执跟着动。
        _verdict = coverage_mod.settlement_verdict(skill)
        _settled = list(_verdict["settled"])
        _unsettled = list(_verdict["unsettled"])
        resolved = bool(_verdict["resolved"])
        _reason = None
        if not resolved:
            if _unsettled:
                _reason = ("这条技能里还有本机训练规则尚未拉起的原语（"
                           + "；".join(_unsettled[:3])
                           + ("…" if len(_unsettled) > 3 else "") + "）：本局不会按说明生效")
                if _settled:
                    _reason += "；其中「" + "、".join(_settled) + "」这一部分引擎照常结算"
            else:
                _reason = ("这条技能的效果本机训练规则还没有对应原语（"
                           + str(getattr(skill, "category", "") or "未分类") + "类）")
        # 旧实现留档（改钉不删）：这里原来内联着 `_UNSETTLED_WORDS = ("冻结","引电","萌化","印记",
        # "星陨","吸血","天气","离场")` 与 `_settled` 四条文本判据（伤害/减伤/应对/能量回复），
        # 另加 2026-09-29 本轮补的三类（持续状态层数/回合、双攻升降、印记层数累加）。
        # 全部搬进 `coverage.SETTLED_PATTERNS` / `coverage.UNSETTLED_WORDS`，**判据一条没放宽**：
        # 仍然是「只要有明说没结算的那一类，整条就按没结算报」。
        out = {
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
                # 旧文案留档（改钉不删）："效果原语尚未核验/实现（skills.json 的 effect_support = unsupported）"
                # —— 那句话把"静态导入标记"当成了"引擎执行真相"，正是第三轮要求⑤点名的错。
                "reason": _reason,
            },
        }
        if with_tier:
            # 逐技能的真实档位（唯一分类器）；只在显式索要时附加，默认回执不含这三个键。
            # 档位要按**同一份能力读数**算（`coverage.declared_capabilities_of()`）：以前这里
            # 写死 `multi_hit_declared=True`，后面几条能力一条都没传 ⇒ 教练的工具回执与覆盖
            # 台账各说各话（第 38 轮实测：扇风在这儿是 PARTIAL、在台账里是可模拟）。
            # 2026-09-30（task-25）：**这一段手抄清单已删** —— 改成走
            # `coverage.classify_skill_declared()`（唯一入口，映射表在 `_CAPABILITY_TO_FLAG`）。
            # 为什么删：这张手抄表**漏过三次**（第 38 轮 / 第 45 轮 / task-25 的 `stat_gain.*`），
            # 每次都是"同一招两处两个档位"；映射表化之后漏一条是**四个调用方一起漏**，
            # 而 `tests/test_stat_gain.py` 的「声明的能力位必须有读点」会当场红。
            tier = classify_skill_declared(skill, coverage_mod.declared_capabilities_of())
            out["support_tier"] = tier["support"]
            out["support_why"] = tier["why"]
            out["support_unparsed"] = list(tier.get("unparsed") or [])
        return out

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

        # 只有显式 `with_tier: true` 才带档位；默认回执保持逐字不变（轨迹摘要钉着它）。
        record = self._skill_record(rs, skill, with_tier=query.get("with_tier") is True)
        answer = Answer(
            result=record,
            evidence_ids=[ev(rs.ruleset_id, "skills.json", skill.skill_id)],
        )
        # 2026-09-29（第三轮⑤⑥）**按类判定**，不再读静态 `effect_support`：
        # 旧写法 `if skill.effect_support != "supported"` 是**数据层的一刀切旧标记**
        # （579 个进覆盖统计的技能全带 unsupported，连纯伤害技能也是），
        # 于是回执里会出现自相矛盾：`mechanics.resolved=True` 而 `unsupported` 说"效果原语未实现"。
        # 现在两者读**同一份**判据（`_skill_record` 里那段按类判定）。
        _mech = record.get("mechanics") or {}
        if not _mech.get("resolved"):
            answer.unsupported = [
                {
                    "code": "effect_resolution",
                    "skill_id": skill.skill_id,
                    # 旧文案留档（改钉不删）："该技能的效果原语未实现；静态 power 只登记来源字段，不能当最终伤害"
                    # —— 它把**静态导入标记**当成了"引擎执行真相"，正是第三轮⑤点名的错。
                    "reason": _mech.get("reason")
                    or "该技能的效果原语未实现；静态 power 只登记来源字段，不能当最终伤害",
                }
            ]
        return answer

    @staticmethod
    def _active_team_size() -> int:
        """当前生效配置每方几只（RC-106）。

        读的是**配置**（`battle_mode.team_size`，经登记表校验），不是字面量：
        `ROCO_RULE_CONFIG` 一改，这份名单的 `team_size` 就跟着改，页面不会按 3 只去限制
        一个 6 只的模式。配置缺失/非法时抛 `RuleConfigError`——宁可 500 也不要给一个错的规模。
        """
        from . import rule_config as rc_mod
        return rc_mod.get_rule_config(None).require_team_size()

    @staticmethod
    def _pet_evidence(rs: Ruleset, pet_id: str) -> str:
        """一只精灵的出处 id —— **按支持等级**指向真正记录了它的那份产物（RC-402）。

        为什么不能一律写 `pets.json`：按需推算出来的 574 只**不在**冻结 `pets.json` 里，
        给它们挂一条 `pets.json#pet_000001` 是**编出处**——那正是这一层要防的事。
        出处必须能被核对：冻结的指 `pets.json`，推算的指 `on-demand-builds.json`。
        """
        if rs.build_support_of(pet_id) == SUPPORT_SIMULATABLE_UNVERIFIED:
            return ev(rs.ruleset_id, "on-demand-builds.json", pet_id)
        return ev(rs.ruleset_id, "pets.json", pet_id)

    def _answer_roster(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """可选用精灵名单（第 42 轮 P0-3：阵容选择要真数据）。

        每只给：真名、系别、六维、**规范配招的四个技能**（含说明与威力来源状态）。
        配招用 `rs.candidate_moveset()`——那是引擎真正会带上场的那一套，
        所以页面上展示的技能就是这一局实际能用的技能，不是另编一份。

        第 60 轮：候选池扩到 48 只之后名单要能分页/筛选，否则页面一次渲染 48 张卡、
        也没法按系别找。四个查询参数的语义都写在这里，调用方不必猜：

          · `limit` / `offset`：正整数分页；回执里带 `total`/`offset`/`limit`，
            所以「拿到第 25—36 只」这件事是可核对的，而不是靠调用方自己记账。
          · `type`：按系别筛。`草系` 与 `草` 都认（缺后缀时补一次 `系`），
            但**只做精确匹配**，不做包含/模糊推断——筛不出来就是 0 条，不假装命中。
          · `role`：按角色筛。role 来自 48 只登记层的**标注**（`roster-48.json`），
            不是引擎数值；没有标注的精灵 role 是 null，按 role 筛时不会被算进来。

        **不传这四个参数时**，返回的旧键与加参数之前一致：同样按 pet_id 升序、同样全量，
        `ok/count/usable_count/team_size/note/pets` 的语义一个没动。

        第 61 轮起这是一次**加性的 schema 变更**（有意为之，不是「形状不变」）：

          · `pets[]` 每个元素多一个 `evidence_ids`，钉到它自己的那张图鉴记录
            （`ev:<ruleset>:pets.json#<pet_id>`）；
          · `pets[].moveset[]` 每个技能多一个 `evidence_ids`，钉到它自己的技能记录
            （`ev:<ruleset>:skills.json#<skill_id>`）；
          · 孤儿技能（`missing_in_skills_json: true`，`skills.json` 里查不到这条）
            **不编出处**，`evidence_ids` 是空数组——找不到就是找不到；
          · roster 级那条（`Answer.evidence_ids`）保持原样，它只说明「这份名单是哪一次
            查询（total/offset/limit）」，钉不到具体某只精灵。

        只读旧键的调用方不受影响；要出处就得读新键。
        """
        limit = query.get("limit")
        offset = query.get("offset", 0)
        type_filter = query.get("type")
        role_filter = query.get("role")
        # RC-402：名单的**默认视野**是冻结已核验的那一档（练习局/迁移夹具口径，逐位不变；
        # 2026-09-28 扩到 542 只，见人类「所有精灵实装」）；
        # `support=all` 时给全量 622（配队与检索口径）。这不是白名单——引擎两种都收，
        # 只是这一份名单默认只列已核验档；非法取值一律 400，不静默当默认。
        support_filter = query.get("support")
        if support_filter in (None, ""):
            include_on_demand = False
        elif support_filter == "all":
            include_on_demand = True
        else:
            # 2026-09-28：这句话里原来写死「那 48 只」—— 扩容之后就成了给玩家看的错数。
            # 改成一档的说法（**不写死数字**，免得下次再漂）；具体只数以回执里的 total 为准。
            return _bad_request(f"support 只能是 all（实际 {support_filter!r}）："
                               "默认名单只给冻结已核验的那一档（要全量请传 support=all）")

        if type_filter is not None and (not isinstance(type_filter, str) or not type_filter.strip()):
            return _bad_request("type 必须是非空字符串（例如 草系）")
        if role_filter is not None and (not isinstance(role_filter, str) or not role_filter.strip()):
            return _bad_request("role 必须是非空字符串（例如 attacker）")
        for key, value in (("limit", limit), ("offset", offset)):
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                return _bad_request(f"{key} 必须是非负整数，实际 {value!r}")
        if limit is not None and limit == 0:
            return _bad_request("limit 必须是正整数（limit=0 要不到任何一只）")

        wanted_type = type_filter.strip() if isinstance(type_filter, str) else None
        wanted_role = role_filter.strip() if isinstance(role_filter, str) else None

        def type_matches(pet: Any) -> bool:
            if wanted_type is None:
                return True
            types = list(getattr(pet, "types", ()) or ())
            if wanted_type in types:
                return True
            return f"{wanted_type}系" in types

        def role_matches(pet: Any) -> bool:
            if wanted_role is None:
                return True
            return getattr(pet, "role", None) == wanted_role

        selected = []
        for pet_id in sorted(rs.pets):
            pet = rs.pets[pet_id]
            if not type_matches(pet) or not role_matches(pet):
                continue
            if not include_on_demand and rs.build_support_of(pet_id) == SUPPORT_SIMULATABLE_UNVERIFIED:
                continue
            moveset = list(rs.candidate_moveset(pet_id) or ())
            moves = []
            for sid in moveset:
                skill = rs.skills.get(sid)
                if skill is None:
                    # 学习表里的孤儿引用在加载期就该炸；真出现就如实上报，不跳过。
                    # **不编出处**：`skills.json` 里根本没有这条记录，任何 id 都是编的，
                    # 所以 evidence 只能是空数组，具体原因由 missing_in_skills_json 说明。
                    moves.append({
                        "skill_id": sid,
                        "missing_in_skills_json": True,
                        "evidence_ids": [],
                    })
                else:
                    moves.append({
                        **self._skill_record(rs, skill),
                        # 每一招自己的出处：skills.json 里那一条。roster 级那条钉不到它。
                        "evidence_ids": [ev(rs.ruleset_id, "skills.json", skill.skill_id)],
                    })
            selected.append({
                "pet_id": pet_id,
                "name": pet.name,
                "types": list(getattr(pet, "types", []) or []),
                "stats": dict(getattr(pet, "stats", {}) or {}),
                "pet_class": getattr(pet, "pet_class", None),
                "stage": getattr(pet, "stage", None),
                # role/speed_tier 是登记层的**标注**（不是引擎数值），按 role 筛时界面要能显示它
                "role": getattr(pet, "role", None),
                "speed_tier": getattr(pet, "speed_tier", None),
                # 有没有可用技能是这个名单能不能真上场的硬条件：
                # 空配招的精灵在引擎里连合法动作都出不来。
                "moveset_size": len(moves),
                "moveset": moves,
                # RC-402：这一只的配招是哪一档（FULL_VERIFIED / SIMULATABLE_UNVERIFIED）。
                # 页面与训练数据生成器都要能一眼看出「这条结论站在哪份数据上」。
                "build_support": rs.build_support_of(pet_id),
                # 每只精灵自己的出处。**按支持等级分两种**（RC-402）：
                #   · 冻结覆盖的 48 只 → `pets.json` 里那一条图鉴记录；
                #   · 按需推算的 574 只 → `on-demand-builds.json` 里那一条（它在冻结
                #     `pets.json` 里**根本不存在**，写 pets.json 就是编出处）。
                # roster 级那条只说明「这份名单是哪一次查询」，钉不到具体某只，所以逐只再给。
                "evidence_ids": [self._pet_evidence(rs, pet_id)],
            })

        total = len(selected)
        start = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
        if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
            pets = selected[start:start + limit]
        elif start:
            pets = selected[start:]
        else:
            pets = selected
        usable = [p for p in pets if p["moveset_size"] > 0]
        result: Dict[str, Any] = {
            "record": "roster",
            "ruleset_id": rs.ruleset_id,
            "count": len(pets),
            "usable_count": len(usable),
            # 分页账目：调用方不该自己数「第 25—36 只」到底对应哪一段
            "total": total,
            "offset": start,
            "limit": limit if isinstance(limit, int) and not isinstance(limit, bool) else None,
            "pets": pets,
            # 每方几只**由当前生效的规则配置决定**（RC-106）：默认 legacy 是 3，
            # 换成标准 PVP 的候选配置就是 6。页面按这个数限制选择——写死 3 的那一版
            # 正是「标准 PVP 被静默按训练场跑」的成因。
            "team_size": self._active_team_size(),
            "note": "配招是引擎的规范配招（candidate_moveset），即这一局实际能用的技能；"
                    "威力按来源如实标注，`not_provided_by_source` 表示来源没给，不是 0。",
        }
        if wanted_type is not None or wanted_role is not None:
            result["filters"] = {"type": wanted_type, "role": wanted_role}
        return Answer(
            result=result,
            coverage=1.0,
            evidence_ids=[ev(rs.ruleset_id, "roster", f"total={total};offset={start};limit={result['limit']}")],
        )

    def _answer_learnset(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        pet_id = query.get("pet_id") or query.get("id")
        name = query.get("name")
        # 2026-09-25：学习表也接受**精灵名**（与 `_answer_term` 同一条理由：玩家说不出 pet_id）。
        # 唯一命中 ⇒ 用它的 pet_id 走下面同一条路；重名 ⇒ 显式列候选（照 `_answer_pet` 的纪律，不猜）。
        if not isinstance(pet_id, str) or not pet_id:
            if isinstance(name, str) and name:
                hits = rs.pets_by_name(name)
                if not hits:
                    return _not_found(f"未知精灵名：{name}")
                if len(hits) > 1:
                    return Answer(
                        result={"record": "learnset", "ambiguous": True, "queried_name": name,
                                "matches": [{"pet_id": p.pet_id, "name": p.name} for p in hits],
                                "note": "这个名字对应多只精灵，学习表各不相同；要哪一只请按 pet_id 再查。"},
                        evidence_ids=[ev(rs.ruleset_id, "pets.json", p.pet_id) for p in hits],
                    )
                pet_id = hits[0].pet_id
            else:
                return _bad_request("查学习表需要 pet_id / id 或 name")
        ls = rs.learnsets.get(pet_id)
        if ls is None:
            return _not_found(f"未知学习表或精灵 id：{pet_id}")
        include = bool(query.get("include_records", True))
        # 2026-09-25：`compact` = **精简投影**（只给配招建议要用的字段）。
        # 为什么要有：真机实测「雪影娃娃的配招怎么选？」—— 它的学习表 50 条、完整回执 23 064 字节，
        # 超过教练侧 10 000 字节的中转上限 ⇒ 模型一条技能都拿不到，只能凭记忆说方向。
        # 精简投影**不新增事实**：字段全部来自同一份 `_skill_record`，只是把长描述等裁掉。
        compact = query.get("compact") is True
        # 字段集刻意瘦：配招建议只需要"名字/属性/类别/能耗/威力"。
        # `power_status`/`is_trait` 在 294 条那只是压垮中转上限的那部分，去掉后最坏情况仍有余量。
        COMPACT_FIELDS = ("skill_id", "name", "category", "element", "energy", "damage_class", "power")
        # `limit` = **每一栏**最多回几条（默认 60，上限 60）。学习表的规模差异极大：
        # 实测最大的一只是 294 条（学院呱呱），精简投影也有 56 KB —— 超过教练侧 10 KB 的中转上限。
        # 所以紧凑模式必须能截断，并且**如实报出** truncated（模型据此知道自己只看到一部分）。
        raw_limit = query.get("limit", 60)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int) or not 1 <= raw_limit <= 60:
            return _bad_request("limit 必须是 1..60 的整数（默认 60；只作用于 compact 模式）")
        limit = raw_limit if compact else None

        def records(ids: Tuple[str, ...]) -> List[Any]:
            if not include:
                return list(ids)
            out = []
            for sid in (ids[:limit] if limit is not None else ids):
                skill = rs.skills.get(sid)
                if skill is None:
                    # 学习表里的孤儿引用在加载期就该炸；这里若真出现，如实上报而不是跳过
                    out.append({"skill_id": sid, "missing_in_skills_json": True})
                else:
                    record = self._skill_record(rs, skill)
                    if compact:
                        record = {key: record[key] for key in COMPACT_FIELDS if key in record}
                    out.append(record)
            return out

        return Answer(
            result={
                "record": "learnset",
                "pet_id": pet_id,
                "native": records(ls.native),
                "blood": records(ls.blood),
                "stones": records(ls.stones),
                "total": len(ls.all_skill_ids),
                **(dict(compact=True, compact_fields=list(COMPACT_FIELDS), limit=limit,
                        returned={"native": min(len(ls.native), limit), "blood": min(len(ls.blood), limit),
                                  "stones": min(len(ls.stones), limit)},
                        truncated=(len(ls.native) > limit or len(ls.blood) > limit or len(ls.stones) > limit))
                   if compact else {}),
            },
            evidence_ids=[
                ev(rs.ruleset_id, "learnsets.json", pet_id),
                ev(rs.ruleset_id, "skills.json"),
            ],
        )

    def _term_record(self, term: Any) -> Dict[str, Any]:
        return {"record": "term", "term_id": term.term_id, "note": term.note, "desc": term.desc}

    def _answer_term(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """按 id 或**按名字**查术语（2026-09-25 新增名字路径）。

        为什么必须补名字路径：玩家问的是「『应对』这条术语是怎么定义的？」，而工具合同与这里
        原来都只认 `term_id` —— 模型不可能猜到 `1015`，于是这类问题**只能靠编**。
        名字路径的两段行为（照 `_answer_pet` 的既有纪律，不自己发明）：

          · **精确命中**（`note` 等于查的名字，实测唯一）⇒ 返回定义，出处钉到 `terms.json#<id>`；
          · **精确不中但名字里含这段文字** ⇒ 返回**候选**（`candidates: true` + 每条自己的 id/名字/描述），
            并**明确不是定义** —— 玩家说「应对」而册子上是「应对状态 / 应对攻击 / 应对防御」三条时，
            替玩家挑一条就是拿另一条规则的定义骗人；
          · 一条都不含 ⇒ `not_found`；既没 id 也没名字 ⇒ `bad_request`。
        """
        term_id = query.get("term_id") or query.get("id")
        name = query.get("name")
        if isinstance(term_id, str) and term_id:
            term = rs.term(str(term_id))
            if term is None:
                return _not_found(f"未知术语 id：{term_id}")
            return Answer(
                result=self._term_record(term),
                evidence_ids=[ev(rs.ruleset_id, "terms.json", term.term_id)],
            )
        if isinstance(name, str) and name:
            exact = rs.terms_by_name(name)
            if len(exact) == 1:
                return Answer(
                    result=self._term_record(exact[0]),
                    evidence_ids=[ev(rs.ruleset_id, "terms.json", exact[0].term_id)],
                )
            if len(exact) > 1:
                # 重名：显式登记为候选，不得静默取第一条（与 `_answer_pet` 的同名纪律一致）。
                return Answer(
                    result={"record": "term", "ambiguous": True,
                            "matches": [self._term_record(t) for t in exact]},
                    evidence_ids=[ev(rs.ruleset_id, "terms.json", t.term_id) for t in exact],
                )
            near = rs.terms_matching(name)
            if not near:
                return _not_found(f"未知术语名：{name}")
            return Answer(
                result={"record": "term", "candidates": True,
                        "queried_name": name,
                        "note": "册子上没有与这个名字完全一致的术语；下面是名字里含它的候选，"
                                "**它们不是这个名字的定义**，要哪一条请按 term_id 再查或让玩家确认。",
                        "matches": [self._term_record(t) for t in near]},
                evidence_ids=[ev(rs.ruleset_id, "terms.json", t.term_id) for t in near],
            )
        return _bad_request("查术语需要 term_id / id 或 name")

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
        """按键查显式行（双属性两种顺序都试）。

        它只回答「快照里有没有这一组合的行」—— **值不再用于结算**：
        2026-09-25 人类裁决后，双属性倍率 = 两系相乘（见 `_answer_type_multiplier`）。
        """
        if len(defender_types) == 1:
            return rows.get(defender_types[0])
        if len(defender_types) == 2:
            a, b = defender_types
            return rows.get(f"{a}|{b}") or rows.get(f"{b}|{a}")
        return None

    def _resolve_pet_ref(self, rs: Ruleset, query: Dict[str, Any]):
        """把 `pet_id` / `name` 解析成一只精灵。返回 `(pet, error_answer)`（二选一非空）。

        与 `_answer_learnset` 同一条路：id 优先；名字**唯一命中**才用；重名就列候选让调用方挑
        （不静默取第一条）。抽出来是为了让 `learnset` 与 `legality` 两条读口用**同一套**纪律 ——
        抄一份就会出现"学习表认名字、合法性不认"这种漂移。
        """
        ref = query.get("pet_id") or query.get("id")
        if isinstance(ref, str) and ref:
            pet = rs.pets.get(ref)
            if pet is None:
                return None, _not_found(f"未知精灵 id：{ref}")
            return pet, None
        name = query.get("name")
        if isinstance(name, str) and name:
            hits = rs.pets_by_name(name)
            if not hits:
                return None, _not_found(f"未知精灵名：{name}")
            if len(hits) > 1:
                return None, Answer(
                    result={"record": "pet", "ambiguous": True, "queried_name": name,
                            "matches": [{"pet_id": item.pet_id, "name": item.name} for item in hits],
                            "note": "这个名字对应多只精灵（形态不同、学习表也不同）；要哪一只请按 pet_id 再问。"},
                    evidence_ids=[ev(rs.ruleset_id, "pets.json", item.pet_id) for item in hits],
                )
            return hits[0], None
        return None, _bad_request("需要 pet_id / id 或 name")

    def _answer_legality(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """「这几招它学得到吗」—— 配招的**可学性**读口（P0-a）。

        为什么要有：`catalog` 答"该找谁"、`learnset` 答"它能学什么"，但玩家/模型手里经常是
        一份**具体配招**（「带 火花、藤鞭、防御、休息回复」）。过去这一问只能靠
        `team/evaluate`（要凑满模式声明的队伍规模，凑不齐就进不去）或让模型自己比对学习表
        （会猜）。这里逐招对照 `learnsets.json`，把**来源列**（native/blood/stones）如实写出来。

        口径（三条）：
          · 技能可以用 id，也可以用**名字**（名字走 `skill_by_name`：重名/查不到都不猜）；
          · `legal` 是**三态**：全学得到 `true` / 有学不到的 `false` / 有认不出来的技能 `null`
            （"查不到这个技能"与"学不到这个技能"是两件事，不许混成一句"不合法"）；
          · 只查**可学性**（与 `env.validate_team` 的配招那一段同一条判据），
            「6 选 4」「这四招强不强」不在这一层。
        """
        pet, error = self._resolve_pet_ref(rs, query)
        if error is not None:
            return error
        skills = query.get("skills")
        if not isinstance(skills, list) or not skills:
            return _bad_request("查配招合法性需要 skills（1..6 个技能 id 或名字）")
        if len(skills) > 6:
            return _bad_request(f"一次最多查 6 个技能，实际 {len(skills)} 个")
        learnset = rs.learnsets.get(pet.pet_id)
        if learnset is None:
            return _not_found(f"这只精灵没有学习表：{pet.pet_id}")

        rows: List[Dict[str, Any]] = []
        for raw in skills:
            if not isinstance(raw, str) or not raw.strip():
                return _bad_request("skills 里必须是非空字符串（技能 id 或名字）")
            ref = raw.strip()
            item: Dict[str, Any] = {"ref": ref}
            skill = rs.skills.get(ref) if ref.startswith("skill_") else None
            if skill is None and not ref.startswith("skill_"):
                try:
                    skill = rs.skill_by_name(ref)
                except RulesetError:
                    skill = None
            if skill is None:
                item["unknown_skill"] = True
                item["learnable"] = False
                item["note"] = "引擎没有这个技能（id 与名字都没命中）—— 这不等于「学不到」，先把名字核准"
            else:
                via = [label for label, ids in (("native", learnset.native),
                                                ("blood", learnset.blood),
                                                ("stones", learnset.stones))
                       if skill.skill_id in ids]
                item.update({"skill_id": skill.skill_id, "name": skill.name,
                             "element": skill.element, "category": skill.category,
                             "learnable": bool(via), "via": via})
            rows.append(item)

        unknown = [row["ref"] for row in rows if row.get("unknown_skill")]
        learnable = [row["ref"] for row in rows if row.get("learnable")]
        legal = None if unknown else len(learnable) == len(rows)
        return Answer(
            result={
                "record": "legality",
                "pet_id": pet.pet_id,
                "pet_name": pet.name,
                "pet_types": list(pet.types),
                "requested": len(rows),
                "learnable": len(learnable),
                "all_learnable": not unknown and len(learnable) == len(rows),
                "unknown_skills": unknown,
                "legal": legal,
                "skills": rows,
                "note": "逐招对照 learnsets.json：`via` 是来源列（native 本系 / blood 血脉 / stones 技能石），"
                        "三个来源都学得到才算 legal。`legal: null` = 有技能引擎认不出来（名字不对或没这个技能），"
                        "**不是**不合法。这里只查可学性，不评价配招强弱、也不判「6 选 4」的形态。",
            },
            evidence_ids=[ev(rs.ruleset_id, "learnsets.json", pet.pet_id),
                          ev(rs.ruleset_id, "pets.json", pet.pet_id)],
        )

    def _answer_weakness_summary(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """「我这份名单**整体最怕**什么属性」—— 逐属性统计怕它的只数。

        为什么要有：真机实测（2026-09-25，手游那一档）「我这 48 只里整体最怕什么属性？」落到
        `policy-no-tool`，玩家拿到的是一句"进入一场 PVE 对战后…"（等于没答）。而这个汇总是**纯读**：
        名单里的属性 × 快照相性表，逐属性数一遍就行 —— 数字全部来自引擎，不涉及概率。

        口径：
          · **倍率 > 1.0 才算"怕"**（快照的 2×、双属性相乘的 4×……），且用的是 `_single_multiplier`
            与 `type_multiplier` **同一套**乘法（不另立一份算术）；
          · 双属性组合**快照没有那一行**时（18 选 2 里缺 67 个）⇒ 那只**不计入**任何一栏，
            整只列进 `unknown_combination_pet_ids`（fail closed，不猜中性值）；
          · 不认识的 id 列进 `unknown_pet_ids`；每栏的宠物清单最多给 12 个（计数仍然是全量）。
        """
        raw_ids = query.get("pet_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            return _bad_request("查名单弱点汇总需要 pet_ids（非空数组，≤60 个稳定 id）")
        if len(raw_ids) > 60:
            return _bad_request(f"pet_ids 一次最多 60 个，实际 {len(raw_ids)} 个")
        for item in raw_ids:
            if not isinstance(item, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", item):
                return _bad_request(f"pet_ids 里有非法 id：{item!r}")
        rows, why = self._type_rows(rs)
        if rows is None:
            return _bad_request(f"相性表不可用：{why}")
        singles = {key: row for key, row in rows.items() if "|" not in str(key)}
        elements = sorted(str(key) for key in singles)
        ids = [str(item) for item in raw_ids]
        unknown_pet_ids = sorted({pid for pid in ids if pid not in rs.pets})

        counts: Dict[str, Dict[str, Any]] = {element: {"element": element, "count": 0, "pet_ids": []}
                                             for element in elements}
        unknown_combos: List[str] = []
        counted = 0
        for pid in ids:
            pet = rs.pets.get(pid)
            if pet is None:
                continue
            types = [str(t) for t in pet.types]
            if len(types) == 2 and self._find_type_row(rows, types) is None:
                unknown_combos.append(pid)
                continue
            if not types:
                unknown_combos.append(pid)
                continue
            counted += 1
            for element in elements:
                value = 1.0
                for type_name in types:
                    value *= self._single_multiplier(rows, type_name, element)
                if value > 1.0:
                    row = counts[element]
                    row["count"] += 1
                    if len(row["pet_ids"]) < 12:
                        row["pet_ids"].append(pid)
        by_element = sorted(counts.values(), key=lambda row: (-row["count"], row["element"]))
        present = [row for row in by_element if row["count"] > 0]
        return Answer(
            result={
                "record": "weakness_summary",
                "pet_ids": ids,
                "counted": counted,
                "unknown_pet_ids": unknown_pet_ids,
                "unknown_combination_pet_ids": sorted(unknown_combos),
                "by_element": present,
                "top": present[:5],
                "list_cap_per_element": 12,
                "multiplier_rule": "怕 = 该属性打这只的倍率 > 1.0；双属性按两系**相乘**"
                                   "（人类裁决 2026-09-25，台账 EV-TYPE-MULTIPLIER）——"
                                   "与 type_multiplier 用的是同一套乘法",
                "note": "这是**名单级的相性计数**（几只怕哪个属性），不是胜率、不是强度排序；"
                        "双属性组合在快照里没有那一行的，整只不计入（列在 unknown_combination_pet_ids），"
                        "不猜一个中性值。每栏的宠物清单最多 12 个，计数是全部。",
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json", "weakness_summary"),
                          ev(rs.ruleset_id, "pets.json", "weakness_summary")],
        )

    def _answer_catalog(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """按**属性**检索精灵（不是按名字查一只）—— 600 只规模下的第一个"该找谁"读口。

        为什么必须有：真机实测（2026-09-25，8765 接了 key）「我想练一只抗龙系的伙伴，
        配哪四招？」→ agent **一次工具都没调**就答了（含糊、无依据）。原因是全量 622 只里
        「谁抗龙系」过去没有读口：`pet` 只按 id/名字查一只，`type_row` 只回属性层面的相性表，
        谁都没把「属性 → 精灵列表」连起来。

        口径（三条，与 `type_row` / `_pet_record` 同一条纪律）：
          · 三个**只读**筛法，方向按快照原文，不做任何推断：
            `element`（**属于**这个属性的精灵）、
            `resist`（**抗**这个属性的精灵 —— 谁的相性行 `resist` 里有它）、
            `weak`（**怕**这个属性的精灵 —— 谁的 `weak` 里有它）、
            `beats`（**克制**这个属性的精灵 —— 它那一行的 `weak` 里列出的攻击属性就是答案）；
            同时给多个筛法时取**交集**（例："龙系里抗火的"）。
          · `pet_ids`（可选，≤60 个稳定 id）：**只在给定 id 里找** —— 「我这几只里谁抗龙系」这一问
            必须能一次问清；否则分页只取前 N 只，答案会随分页变化（"你队里 0 只"可能是假的）。
            给不出的 id 不静默丢掉：逐个列进 `unknown_pet_ids`。
            ⚠ `weak` 与 `beats` 是**两个方向**，别混：`weak: 龙系` = 怕龙系的精灵；
            `beats: 龙系` = 打龙系有克制的精灵（= `row(龙系).weak` 的那几个属性）。
          · 只用**单属性行**判方向（与 `type_row` 的 `offense` 同一条：双属性组合行在快照里
            只说明"这个组合有没有数据"，它不是第二种口径）。
          · 名字/属性/面板逐字来自快照，**不回任何伤害/胜率数字**；分页显式（默认 20，上限 50），
            `total_matched` 与 `truncated` 如实写出来，免得调用方把"这一页"当成"全部"。
        """
        element = query.get("element") or query.get("type")
        resist = query.get("resist")
        weak = query.get("weak")
        beats = query.get("beats")
        raw_ids = query.get("pet_ids")
        if raw_ids is not None:
            if not isinstance(raw_ids, list) or not raw_ids:
                return _bad_request("pet_ids 必须是非空数组（≤60 个稳定 id）")
            if len(raw_ids) > 60:
                return _bad_request(f"pet_ids 一次最多 60 个，实际 {len(raw_ids)} 个")
            for item in raw_ids:
                if not isinstance(item, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", item):
                    return _bad_request(f"pet_ids 里有非法 id：{item!r}")
        for name, value in (("element", element), ("resist", resist), ("weak", weak), ("beats", beats)):
            if value is not None and (not isinstance(value, str) or not value.strip()):
                return _bad_request(f"{name} 必须是非空属性名（如「龙系」）")
        if element is None and resist is None and weak is None and beats is None:
            return _bad_request("按属性检索至少要给 element / resist / weak / beats 之一")
        key_of = lambda raw: self._normalize_element(str(raw).strip())  # noqa: E731
        element_key = key_of(element) if element is not None else None
        resist_key = key_of(resist) if resist is not None else None
        weak_key = key_of(weak) if weak is not None else None
        beats_key = key_of(beats) if beats is not None else None

        rows, why = self._type_rows(rs)
        if rows is None:
            return _bad_request(f"相性表不可用：{why}")
        singles = {key: row for key, row in rows.items() if "|" not in str(key)}
        for label, key in (("element", element_key), ("resist", resist_key), ("weak", weak_key),
                           ("beats", beats_key)):
            if key is not None and key not in singles:
                return _not_found(f"未知属性：{key}（{label}）")

        # 每个筛选条件算出一组"满足条件的**属性**"，再落到精灵身上（精灵可以双属性）。
        wanted: List[Tuple[str, List[str]]] = []
        if element_key is not None:
            wanted.append((f"type={element_key}", [element_key]))
        if resist_key is not None:
            wanted.append((f"resist {resist_key}",
                           self._types_with_entry(singles, resist_key, "resist")))
        if weak_key is not None:
            wanted.append((f"weak to {weak_key}",
                           self._types_with_entry(singles, weak_key, "weak")))
        if beats_key is not None:
            # **进攻向**：克制 `beats_key` 的攻击属性 = 它那一行 weak 里列出的属性（逐字读，不推断）。
            wanted.append((f"beats {beats_key}",
                           [str(e.get("type")) for e in singles[beats_key].get("weak") or []
                            if e.get("type")]))

        wanted_ids = None
        unknown_pet_ids: List[str] = []
        if raw_ids is not None:
            wanted_ids = {str(item) for item in raw_ids}
            unknown_pet_ids = sorted(pid for pid in wanted_ids if pid not in rs.pets)

        matched: List[Dict[str, Any]] = []
        for pet in rs.pets.values():
            if wanted_ids is not None and pet.pet_id not in wanted_ids:
                continue
            pet_types = [str(t) for t in pet.types]
            reasons: List[str] = []
            ok = True
            for label, types in wanted:
                hit = [t for t in pet_types if t in types]
                if not hit:
                    ok = False
                    break
                reasons.append(f"{label} via {'/'.join(hit)}")
            if not ok:
                continue
            matched.append({
                "pet_id": pet.pet_id,
                "name": pet.name,
                "types": pet_types,
                "stats": dict(pet.stats),
                "role": pet.role,
                "speed_tier": pet.speed_tier,
                "matched": reasons,
            })
        matched.sort(key=lambda item: item["pet_id"])

        raw_limit = query.get("limit", 20)
        raw_offset = query.get("offset", 0)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int) or not 1 <= raw_limit <= 50:
            return _bad_request("limit 必须是 1..50 的整数（默认 20）")
        if isinstance(raw_offset, bool) or not isinstance(raw_offset, int) or raw_offset < 0:
            return _bad_request("offset 必须是非负整数（默认 0）")
        page = matched[raw_offset:raw_offset + raw_limit]
        filters = {k: v for k, v in (("element", element_key), ("resist", resist_key),
                                     ("weak", weak_key), ("beats", beats_key)) if v is not None}
        if wanted_ids is not None:
            filters["pet_ids"] = sorted(wanted_ids)
        evidence_types = sorted({t for _label, types in wanted for t in types})
        return Answer(
            result={
                "record": "catalog",
                "filters": filters,
                "matched_types": evidence_types,
                "total_matched": len(matched),
                **(dict(unknown_pet_ids=unknown_pet_ids) if raw_ids is not None else {}),
                "offset": raw_offset,
                "limit": raw_limit,
                "returned": len(page),
                "truncated": raw_offset + len(page) < len(matched),
                "pets": page,
                "note": "按属性**检索**精灵：筛法与方向逐字来自 types.json（单属性行），"
                        "名字/属性/面板逐字来自 pets.json。这里**不含**伤害、胜率、强度排序 —— "
                        "谁更合适要接着查学习表/相性倍率，或让引擎算。"
                        "「抗 X」= 相性行 resist 里有 X；「怕 X」= weak 里有 X；"
                        "「克制 X」= X 那一行的 weak 里列出的属性（**与「怕 X」是两个方向**）；"
                        "给多个筛法时是**交集**；给了 `pet_ids` 就只在这些 id 里找"
                        "（`unknown_pet_ids` 是不认识的 id，逐个列出、不静默丢）。",
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json",
                             element_key or resist_key or weak_key or beats_key),
                          ev(rs.ruleset_id, "pets.json", "catalog")],
        )

    @staticmethod
    def _normalize_element(raw: str) -> str:
        """把玩家/模型嘴里的属性名收敛成快照里的键（`龙` → `龙系`；已经带「系」的原样）。

        只做这一种收敛：**不**翻译别称（「龙属性」不认），也**不**猜错别字 ——
        认不出来就是未知属性，由调用方拿到 404。快照里的键一律是「X系」。
        """
        text = raw.strip()
        if not text:
            return text
        if text.endswith("系"):
            return text
        return text + "系"

    @staticmethod
    def _types_with_entry(singles: Dict[str, Any], element: str, field: str) -> List[str]:
        """单属性表里哪些属性的 `field`（weak/resist）里有 `element`。逐字读数，不推断。"""
        out: List[str] = []
        for key, row in singles.items():
            for entry in row.get(field) or []:
                if entry.get("type") == element:
                    out.append(str(key))
                    break
        return sorted(out)

    def _answer_policy(self, rs: Ruleset, query: Dict[str, Any]) -> Answer:
        """规则**策略**读口（目前只有 `weather`）。

        为什么要有：`kind:"ruleset"` 只回 counts/files/capabilities，**不含** `weather_policy`
        —— 教练因此答不了「雨天水系伤害加多少」（真机实测：那句落到 `state-in-packet`，
        模型没有事实可引）。而那个数字只有一个事实源：配置里从登记表照抄的那一份。

        口径（三条）：
          · **逐字回配置**，不重算、不换算、不补默认（`effects` 原样带出）；
          · `ruleset_config_id` 可选，省略 = 进程当前生效的配置（`ROCO_RULE_CONFIG`）；
            回执里**写明答的是哪一份**，免得把 legacy（没声明天气层）当成"天气不存在"；
          · 没声明就是没声明：`enabled:false` + 一句 `note`，不抛错（legacy/v2 是合法状态）。
        """
        from . import rule_config as rc_mod

        name = str(query.get("name") or query.get("policy") or "").strip().lower()
        if not name:
            return _bad_request("查策略需要 name（目前支持 weather）")
        if name != "weather":
            return _not_found(f"未知的策略：{name}")
        raw_id = query.get("ruleset_config_id")
        if raw_id is not None and (not isinstance(raw_id, str) or not raw_id):
            return _bad_request("ruleset_config_id 必须是非空字符串（或省略 = 当前生效配置）")
        # `mode_id`：**按模式**问策略（比配置 id 稳，因为「哪个模式绑哪份配置」只有登记表
        # 一处事实源）。2026-09-25：营地里的玩家问「雨天水系伤害加多少」，而营地用的
        # legacy 配置根本没声明天气层 ⇒ 教练只能回"没声明"。但玩家问的是**游戏规则**，
        # 那份口径登记在标准 PVP 模式的绑定配置里 —— 让调用方指名模式，由引擎查登记表
        # 解析，双方都不用各抄一份 id。
        mode_id = query.get("mode_id")
        if mode_id is not None and (not isinstance(mode_id, str) or not mode_id):
            return _bad_request("mode_id 必须是登记表里的模式 id（非空字符串）")
        bound_from_mode = None
        if mode_id and raw_id is None:
            try:
                bound_from_mode = rc_mod.bound_config_id_for_mode(mode_id)
            except Exception as exc:  # 没登记的模式**不许**猜一份配置来答
                return _bad_request(f"模式 {mode_id!r} 不在登记表里：{exc}")
            if not bound_from_mode:
                return _not_found(f"模式 {mode_id!r} 在登记表里没有 ruleset_binding（不知道该按哪份配置答）")
            raw_id = bound_from_mode
        try:
            cfg = rc_mod.get_rule_config(raw_id or None)
        except Exception as exc:  # 配置加载失败**照实说**，不给一个假答案
            return _bad_request(f"取不到规则配置 {raw_id!r}：{exc}")
        # 回执里写明"这份配置是照哪个模式选的"，玩家话里才能标出处（不改一个数）。
        from_mode = ({"mode_id": mode_id, "ruleset_binding": bound_from_mode}
                     if bound_from_mode else None)
        policy = cfg.weather_policy if isinstance(cfg.weather_policy, dict) else None
        if not policy:
            return Answer(
                result={
                    "record": "policy",
                    "name": "weather",
                    "ruleset_config_id": cfg.ruleset_config_id,
                    "enabled": False,
                    **(from_mode or {}),
                    "note": "这份配置**没有声明**天气层（legacy / v2 是合法状态）：引擎遇到「把天气改为…」"
                            "的技能只会登记成 unsupported，不结算任何天气效果。",
                },
                evidence_ids=[ev(rs.ruleset_id, "rulesets", f"{cfg.ruleset_config_id}.json")],
            )
        return Answer(
            result={
                "record": "policy",
                "name": "weather",
                "ruleset_config_id": cfg.ruleset_config_id,
                "enabled": cfg.weather_enabled,
                **(from_mode or {}),
                "value": policy.get("value"),
                "confidence": policy.get("confidence"),
                "evidence_id": policy.get("evidence_id"),
                "max_concurrent": policy.get("max_concurrent"),
                "duration_turns": policy.get("duration_turns"),
                "duration_source": policy.get("duration_source"),
                # 四种天气的效果逐字带出（`kind` / `term_id` / 免疫属性 / 数值都在里面）
                "effects": policy.get("effects"),
                "unknowns": policy.get("unknowns"),
                "reason": policy.get("reason"),
                "note": "本记录是规则配置里 `policies.weather_policy` 的逐字转录（生成器从登记表照抄）。"
                        "数值以「当前规则集」为准；更早版本的口径登记在 `unknowns` 里，不改写。",
            },
            evidence_ids=[ev(rs.ruleset_id, "rulesets", f"{cfg.ruleset_config_id}.json")],
        )

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
                    f"快照没有给出双属性组合「{key}」的相性行（18 选 2 共 153 个组合，快照只给了 86 个）"
                    "—— 该组合不可查，不用别的组合顶、也不猜一个中性值",
                    combination=key,
                )
            return _not_found(f"未知属性：{key}")
        # 2026-09-25（人类：「不要说不知道！预测就说预测」+ 教练侧实测）：
        # `weak`/`resist` 是**防守向**（「这个属性怕什么/抗什么」）。玩家问的
        # 「火系**克制**什么属性」是**进攻向** —— 逐字读快照回答不了那个问题
        # （过去要么让模型去猜，要么拿防守向的列表答错方向）。进攻向 = 谁的 weak 里
        # 有它：在**引擎里**算一遍（单属性 18 行，值逐字来自快照，不做推断）。
        offense = []
        for other_key, other_row in rows.items():
            if "|" in str(other_key):
                continue
            for entry in other_row.get("weak") or []:
                if entry.get("type") == row.get("key", key):
                    offense.append({"type": other_key, "multiplier": float(entry.get("multiplier"))})
        offense.sort(key=lambda item: (-item["multiplier"], item["type"]))
        return Answer(
            result={
                "record": "type_row",
                "key": row.get("key", key),
                "weak": row.get("weak") or [],
                "resist": row.get("resist") or [],
                # 进攻向：这个属性打哪些属性是几倍（单属性表里逐行数出来的）
                "offense": offense,
                "neutral_default": 1.0,
                # 这条记录是**快照原文**（数据查询）。引擎结算用的倍率见 type_multiplier：
                # 双属性按两系相乘（2026-09-25 人类裁决），与快照的封顶行在 41 格上不同。
                "note": "本记录是 types.json 的逐字转录（数据面）；**结算**用 type_multiplier，"
                        "双属性按两系相乘（台账 EV-TYPE-MULTIPLIER，2026-09-25 人类裁决）。"
                        "`weak`/`resist` 是防守向（怕什么/抗什么），`offense` 是进攻向（克制谁）。",
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
                "快照没有给出该双属性组合的显式相性行（18 选 2 共 153 个组合，快照只给了 86 个）——"
                "该组合不可查：不用别的组合顶、也不猜一个中性值（fail closed）",
                defender_types=uniq,
            )
        if len(uniq) == 2:
            # 2026-09-25 人类裁决：「属性双属性叠加：快照 3×（现用）vs 两个社区源 4×，差 41 格。
            # **使用社区源**」⇒ 双属性 = 两系相乘（台账 EV-TYPE-MULTIPLIER，RECORDED_IN_GAME）。
            # 快照那一行的值只用来做**对照**，不作为结算口径。
            a, b = uniq
            value = self._single_multiplier(rows, a, element) * self._single_multiplier(rows, b, element)
            snapshot_value, snapshot_from_table = self._row_lookup(row, element)
            return Answer(
                result={
                    "record": "type_multiplier",
                    "defender_types": uniq,
                    "attack_element": element,
                    "multiplier": float(value),
                    "combination_rule": "multiply",
                    "combination_rule_source": "人类裁决 2026-09-25（台账 EV-TYPE-MULTIPLIER，RECORDED_IN_GAME）",
                    "neutral_inferred": False,
                    "source": f"types.json 的单属性行相乘（{a} × {b}）；组合可查性来自 {row.get('key')}",
                    # 快照的封顶值一并给出：41 格上它与裁决口径不同（3 vs 4），差异要看得见。
                    "snapshot_value": float(snapshot_value) if snapshot_from_table else 1.0,
                    "snapshot_agrees": abs((snapshot_value if snapshot_from_table else 1.0) - value) < 1e-9,
                    # 相乘口径**不是**未核验假设：它是人类裁决（RECORDED_IN_GAME）。
                    "assumption_free": True,
                },
                evidence_ids=[ev(rs.ruleset_id, "types.json", str(row.get("key")))],
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
                # 单属性来自快照显式行，没有用相乘假设。
                "assumption_free": True,
            },
            evidence_ids=[ev(rs.ruleset_id, "types.json", str(row.get("key")))],
        )

    @staticmethod
    def _single_multiplier(rows: Dict[str, Any], type_key: str, element: str) -> float:
        """单属性行的倍率（未列出 = 中性 1.0）。相乘口径的**唯一**取数口。"""
        row = rows.get(type_key)
        if row is None:
            return 1.0
        value, _ = RocoService._row_lookup(row, element)
        return 1.0 if value is None else float(value)

    def _answer_type_chart(self, rs: Ruleset) -> Answer:
        """相性表自检：把「两系相乘」与快照显式行对拍，把差异**暴露出来**（只报告，不改数）。

        2026-09-25 之前这条自检是「证明快照才对、相乘是假设」；人类裁决改用社区源的相乘
        口径之后，它反过来变成「快照有 41 格与我们的结算口径不同」的**对账表** ——
        数字一个字没改，读法变了：那 41 格是**快照**的偏差，不是引擎的。
        """
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
                        "2026-09-25 人类裁决改用社区源的**相乘**口径（台账 EV-TYPE-MULTIPLIER，"
                        "RECORDED_IN_GAME）：「快照 3×（现用）vs 两个社区源 4×，差 41 格。使用社区源」。"
                        "所以 data.py 的 TypeChart.multiplier 双属性分支就是两系相乘，"
                        "上面这 41 处不一致是**快照封顶行**与结算口径的差（快照在 2×2 处给 3.0）。"
                        "本服务的 type_multiplier 与引擎同口径（相乘），并把快照值放在 snapshot_value 里对账。"
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
        # 2026-09-25（人类：「我这六只怎么样」问不出来）：队伍规模按**登记表里各模式声明的值**收
        # （`demo-training-3v3`=3 / `pvp-standard-six-pet`=6 / `pvp-territory-trial-2v2`=2），
        # 不在其中的一律 refuse。原来这里靠 `validate_team` 的默认 3（RC-106 的注释写着
        # 「默认 3 是给不经过 reset() 的调用点」）⇒ 六只阵容连评估都进不去。
        sizes = team_mod.declared_team_sizes()
        if len(squad) not in sizes:
            return self._answer_envelope(_bad_request(
                f"队伍规模必须是 {sizes} 之一（各模式在 battle-modes.json 的 parameters.team_size 里声明）；"
                f"实际 {len(squad)} 只"), body, started)
        problems = env_mod.validate_team(rs, squad, loadouts, team_size=len(squad))
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

        # 04.2：**可选**的对手情景注入（来自 03 的 `buildScenarioOutlook`，协议
        # `rc604-opponent-outlook/v1`）。两条纪律：
        #   ① **加性可选**：不带 `opponent_scenarios` 这个键 ⇒ 缺省路径逐字段不变；
        #   ② **形状不对就 400 fail closed**，错误里点名坏在哪一条（不猜一个）。
        # 概率性字段一律拒绝：情景集合没有频次数据，不许长得像概率分布。
        scenarios_given = "opponent_scenarios" in body
        raw_scenarios = body.get("opponent_scenarios")
        try:
            parsed_scenarios = pm.parse_opponent_scenarios(
                raw_scenarios if scenarios_given else None)
        except pm.ScenarioShapeError as exc:
            return self._answer_envelope(_bad_request(
                f"opponent_scenarios 形状不合法：{exc}。"
                "情景集合只描述「对手可能做什么」，不许带 probability/weight/share/p；"
                "形状不对就拒绝，不猜一个"
            ), body, started)

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
            plan = pm.plan_actions(state, rs, depth=depth, beam=beam, budget_ms=budget,
                                   opponent_scenarios=(raw_scenarios if parsed_scenarios else None),
                                   # 时钟接缝：默认不传 ⇒ 用 `plan_actions` 的真实时钟（逐位不变）
                                   **({"clock": self.plan_clock} if self.plan_clock else {}))
            unsupported_total += plan.unsupported_seen
            per_seed.append(plan.to_dict())
            if damage_preview:
                # 只在**第一个**种子采样：伤害不依赖 analysis seed 之外的随机吗？
                # 依赖。所以这里对每个种子都采，最后取包络（见下面的聚合）。
                previews.append(self._damage_preview(state, rs))

        # 推荐必须跨种子一致才敢说「推荐」；不一致就如实说「随随机性变化」
        labels = {p["recommended_label"] for p in per_seed}
        expectations = [p["expected"] for p in per_seed]
        # 枚举第一与第二名的估值差（一手推演尺度）。产品侧用它判断「这一手是不是真的两难」：
        # 咬得紧才值得提示。⚠️ 它的**量纲与旧演示引擎不同**（旧引擎的 evaluate 分数
        # 中位数是 3 量级，这里是 0.04 量级），所以任何阈值都必须按这一把尺子重新标定，
        # 不能照搬旧引擎的「>5」。见 docs/roco/W5-04-INTERVENTION-GATE.md §10.4。
        margins = [p.get("first_second_margin") for p in per_seed
                   if p.get("first_second_margin") is not None]
        worsts = [p["worst"] for p in per_seed]
        bests = [p["best"] for p in per_seed]
        timed_out = any(p["timed_out"] for p in per_seed)
        coverage = sum(p["coverage"] for p in per_seed) / len(per_seed)

        # 04.2：只有在请求**显式带了** `opponent_scenarios` 时才组装「本次对手依据」，
        # 于是缺省回执的键集与 04.2 之前逐字段相同（金标比对在 test_plan_scenarios）。
        opponent_basis = (opponent_basis_block(per_seed, raw_seeds, parsed_scenarios,
                                              public_assumptions=public.get("assumptions"))
                          if scenarios_given else None)
        # 04.3：R3（coverage 计数比）/ R5（候选裁剪留痕）/ R8（深度与预算截断语义）
        coverage_detail, truncation, budget_detail = aggregate_plan_traces(per_seed, raw_seeds)
        # 04.4：稳健排序留痕 + 「不是概率」的机器可检声明
        robustness, declarations = aggregate_plan_robustness(per_seed, raw_seeds)

        payload = {
            "schema_version": public.get("schema_version"),
            # 01.2：契约字段**原样回吐**调用方给的那份公开面里的三个键（缺就不出现）。
            # 为什么不在这里重算：规划侧手里只有公开面，没有对局状态，重算只能靠猜；
            # 回吐才能保证「同一 decision_id 的 UI、工具输入与回放」是同一个键。
            **{k: public[k] for k in ("match_id", "rules_version", "decision_id")
               if k in public},
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
            "first_second_margin": {
                "min": min(margins) if margins else None,
                "max": max(margins) if margins else None,
                "mean": (sum(margins) / len(margins)) if margins else None,
                "scale": "one-ply-value",
                "note": ("枚举第一与第二名的估值差（一手推演尺度）。只用于判断「这一手"
                         "是不是真的两难」，**不是胜率、不是游戏机制的分差**。"
                         "量纲按本引擎标定，不要与旧演示引擎的分数直接比较。"),
            },
            "main_counter": per_seed[0]["main_counter"],
            "counter_note": per_seed[0]["counter_note"],
            "branches_evaluated": sum(p["branches_evaluated"] for p in per_seed),
            "depth_searched": max(p["depth_searched"] for p in per_seed),
            "beam": beam,
            "coverage": coverage,
            # 04.3（R3）：coverage 的计数比口径（不是把握度、不是概率）
            "coverage_detail": coverage_detail,
            # 04.3（R5）：候选层被裁掉谁、按什么规则（束宽与类别保底）
            "truncation": truncation,
            # 04.3（R8）：深度/束宽/预算的截断语义（请求截断 vs 到达引擎上限）
            "budget": budget_detail,
            # 04.4：稳健排序的留痕（规则/阈值/被压下去的动作/稳定并列）
            "robustness": robustness,
            # 04.4（R1/R2）：每个数字的口径声明（`is_probability:false` 等，机器可检）
            "declarations": declarations,
            "timed_out": timed_out,
            "unsupported_seen": unsupported_total,
            "opponent_model": per_seed[0]["opponent_model"],
            # 04.2：只在请求带 `opponent_scenarios` 时出现（缺省键集逐字段不变）
            **({"opponent_basis": opponent_basis} if opponent_basis else {}),
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
        if opponent_basis and opponent_basis["scenario_driven"]:
            missing = opponent_basis["scenario_driven"]["unavailable"]
            if missing:
                unsupported.append({
                    "reason": f"注入情景里有 {len(missing)} 条点名的技能/位次/物种在重建状态里"
                              "枚举不出来（不假装能算；逐条见 result.opponent_basis）",
                    "unavailable": missing,
                })
        if len(labels) != 1:
            unsupported.append({
                "reason": "推荐动作随 analysis seed 变化，说明它不是一个稳健结论；请把 expected/worst 区间当作结论",
                "labels": sorted(labels),
            })

        limitations = [
            "估值是启发式局面分，**不是胜率**；expected 不能读成「赢的概率」",
            "对手后备血量与配招不在公开信息里，按满血+规范配招建模（见 public.assumptions）",
            "随机性用与真实对局无关的 analysis_seeds，并跨种子聚合；结论不依赖真实 seed",
            "对手按启发式分布建模，不是真实对手行为模型",
            "这是**分析**状态，不是权威对局状态；实际结算以游戏内为准",
            "coverage 是**计数比**（见 coverage_detail.by_seed 的分子/分母），不是「结论有多可靠」的"
            "把握度；被束宽裁掉的候选逐条见 truncation.dropped，深度/预算是否到顶见 budget",
            "排序是**稳健优先**（见 robustness.ordering）：先避「有证据的重大损失」，再比期望"
            "（资源与后手都在期望里）；相近动作并列列出（`tied_with_top_stable`），不假装一条严格更优",
            "expected/worst/first_second_margin/coverage 的口径见 declarations：**不是胜率、"
            "不是概率、不是把握度**（启发式估值 + 计数比）",
        ]
        if opponent_basis:
            limitations.append(
                "本次对手依据见 result.opponent_basis：scenario-driven（情景点名的技能/位次）与 "
                "assumption-driven（后备满血 + 规范配招）**分开写**；注入情景只当筛子（等权基线，"
                "不是概率），对手配招假设**仍然生效**，P3 残留在 residuals 里显式登记"
            )

        return self._answer_envelope(Answer(
            result=payload,
            coverage=coverage,
            evidence_ids=[f"ev:{rs.ruleset_id}:public-state@{public.get('state_version')}"],
            unsupported=unsupported,
            extra={"limitations": limitations},
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
        """开一局本地练习对局，返回初始私有状态 + 公开面 + 双方合法动作。

        RC-106：**每方上场几只、按哪份规则结算、哪些未知值按假设走**，都由请求显式给出：

          · `ruleset_config_id`（可选）：这一局用的规则配置。省略 = 当前生效配置
            （默认仍是 legacy）。标准 PVP 六宠要传 `mobile_s4_candidate_v3`；
            `data/roco/battle-modes.json` 里 `pvp-standard-six-pet.ruleset_binding`
            就是它 —— 调用方应当读登记表，而不是在自己那里抄一个字符串。
          · `team` / `enemy_team`：长度 = **该配置的 `battle_mode.team_size`**（v3 ⇒ 6）。
            这里不再写死 3：长度不对时 `env.reset` 会按配置给出可读的错误。
          · `unverified_overrides`（可选）：显式的、带出处的未核验覆盖
            （v3 的 `energy.initial` 是 UNKNOWN，不给覆盖就 fail closed ⇒ 422）。

        错误分类沿用既有口径：**请求形状**不对是 400；**机制未核验**（缺覆盖、配置里
        是 UNKNOWN）是 422 `unsupported_effect` —— 那不是调用方写错了请求，
        而是引擎没有依据。
        """
        started = time.perf_counter()
        from . import env as env_mod
        from . import overrides as ov_mod
        from . import rule_config as rc_mod

        rs, early = self._ruleset_ok(body, PRIVATE_TRUST_DOMAIN)
        if early is not None:
            return early

        # 规则配置：显式给就从这里选；不给就沿用当前生效配置（逐位不变的默认路径）。
        raw_config_id = body.get("ruleset_config_id")
        if raw_config_id is not None and (not isinstance(raw_config_id, str) or not raw_config_id):
            return self._answer_envelope(
                _bad_request("ruleset_config_id 必须是非空字符串（或省略 = 当前生效配置）"),
                body, started)
        try:
            cfg = rc_mod.get_rule_config(raw_config_id)
        except rc_mod.RuleConfigError as exc:
            return self._answer_envelope(_bad_request(f"规则配置不可用：{exc}"), body, started)

        team = body.get("team")
        if not isinstance(team, list) or not all(isinstance(x, str) and x for x in team):
            return self._answer_envelope(
                _bad_request("team 必须是精灵 id 的数组"), body, started)
        enemy_team = body.get("enemy_team", team)
        if not isinstance(enemy_team, list) or not all(isinstance(x, str) and x for x in enemy_team):
            return self._answer_envelope(
                _bad_request("enemy_team 必须是精灵 id 的数组"), body, started)
        # 队伍规模来自**配置**（不是这里的字面量）：长度不对时给出可读的 400，
        # 而不是让 reset 抛一个没上下文的异常。
        try:
            team_size = cfg.require_team_size()
        except rc_mod.RuleConfigError as exc:
            return self._answer_envelope(_unsupported("ruleset_config_error", str(exc)), body, started)
        if len(team) != team_size or len(enemy_team) != team_size:
            return self._answer_envelope(_bad_request(
                f"规则配置 {cfg.ruleset_config_id}（模式 {cfg.battle_mode_id}）每方需要 "
                f"{team_size} 只精灵，实际 team={len(team)} / enemy_team={len(enemy_team)}"),
                body, started)

        seed = body.get("seed", 1)
        if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
            return self._answer_envelope(_bad_request("seed 必须是非负整数"), body, started)
        loadouts = body.get("loadouts")
        if loadouts is not None and not isinstance(loadouts, dict):
            return self._answer_envelope(_bad_request("loadouts 必须是 {pet_id: [skill_id...]}"), body, started)

        # 2026-09-29（Q8「同一规则同一投影」）：个体快照。形状问题**说清哪里不对**
        # （逐条的判据在 `individuals._snapshot_problems`，由 `env.reset` 抛成 400）。
        # `individuals=None` ⇒ 每一只都走种族值路径（老行为逐位不变）。
        individuals = body.get("individuals")
        if individuals is not None and not isinstance(individuals, dict):
            return self._answer_envelope(
                _bad_request("individuals 必须是 {实例 id: 个体快照} 的对象"
                             "（每项至少要有 species_id；可选 level/nature/talent）"), body, started)


        overrides = body.get("unverified_overrides")
        if overrides is not None:
            try:
                ov_mod.normalize_unverified_overrides(cfg, overrides)
            except rc_mod.RuleConfigError as exc:
                return self._answer_envelope(_bad_request(f"unverified_overrides 不合法：{exc}"),
                                             body, started)

        try:
            state = env_mod.reset(list(team), list(enemy_team), seed=seed, rs=rs, loadouts=loadouts,
                                  config=cfg, unverified_overrides=overrides,
                                  individuals=individuals)
        except (ValueError, KeyError) as exc:
            return self._answer_envelope(_bad_request(f"无法开局：{type(exc).__name__}: {exc}"),
                                         body, started)
        except env_mod.fx.UnsupportedEffect as exc:
            # 机制未核验（例如 v3 的 energy.initial 是 UNKNOWN 且没给覆盖）：
            # 这不是请求写错了，而是引擎没有依据 —— 422，不是 400。
            return self._answer_envelope(_unsupported("unverified_rule_value", str(exc)), body, started)

        # 01.3：**本模式展示了开局预览**时，调用方显式说出来（省略 / false = 不展示）。
        #
        # 为什么由调用方说、引擎不自己决定：页面有没有弹那个 5–6 秒的预览层，
        # 只有页面/Node 知道；引擎替它猜，就等于把「没展示」说成「展示了」（或反过来）。
        # 说了之后引擎做的事很小：把**预览实际展示的那一份**（位次 + 物种 id + 名字）
        # 记成 `opening_roster_revealed` 事件 —— 于是它同时进入
        # `state.events`（同源记录）、下一个回执、以及三个公开面的「已亮明」块。
        opening_preview = body.get("opening_preview", False)
        if not isinstance(opening_preview, bool):
            return self._answer_envelope(
                _bad_request("opening_preview 必须是布尔值（省略 = 本模式不展示开局预览）"),
                body, started)
        if opening_preview:
            env_mod.opening_roster_reveal(state, rs)

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

        # 2026-09-25：这份配置声明了「背包物品**不占行动**」时，`/battle/advance` **不接受**把它
        # 当成这一手交上来 —— 那样回合照走，玩家白搭一个回合。它必须走 `/battle/free`。
        # 引擎的 `step_joint` 本身**不拦**（机器人推演 `opponents.play_match` 走同一条路：
        # 那里「这一手用了道具」只是推演里少出一招，不是玩家可见的规则违规）；
        # 拦截点放在**玩家可达到的 API 边界**上，这也是页面唯一会走的那条路。
        from . import rule_config as rc_mod
        cfg_adv = rc_mod.get_rule_config(state.ruleset_config_id or None)
        free_declared = cfg_adv.magic_occupies_action is False

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
                if free_declared and player_action.kind == "magic":
                    return self._answer_envelope(_bad_request(
                        "「愿力强化」不占行动（自由动作）：请走 POST /battle/free，"
                        "把它当成这一手交上来会白搭一个回合（这一手仍然照常要出一个技能）"),
                        body, started)
                # `tolerate_unsupported=True`：**玩家路径**要的是「别把整局炸掉」——
                # 一手的机制解不出就变成一条能结算的 action_cancelled 事件、回合走完。
                # 搜索/推演那条路（planner / opponents）**不传**这个开关，语义逐位不变
                #（`planner._safe_step` 靠 `UnsupportedEffect` 把推不动的动作记成 -inf）。
                env_mod.step_joint(state, rs, player_action, enemy_action,
                                   tolerate_unsupported=True)
        except env_mod.fx.UnsupportedEffect as exc:
            # 2026-09-29（绞轮 skill_000494 实测）：`step_joint` 现在会把**能结算的**那种
            # unsupported 变成事件、把回合走完；但**残留**的仍可能从结算里冒出来。
            # 那种情况必须是 422 `unsupported_effect`（「机制未定义」），
            # **不许**落进 `_dispatch` 的兜底变成 500 `internal_error` ——
            # 那会让页面把它显示成「规则服务出问题了」，而真相是「这条机制没有依据」。
            return self._answer_envelope(
                _unsupported("unverified_mechanics_seen", str(exc)), body, started)
        except (ValueError, RulesetError) as exc:
            return self._answer_envelope(_bad_request(f"无法推进：{exc}"), body, started)

        return self._sim_envelope(
            state, rs, strategy, body, started, event="battle_advance", events_from=events_before
        )

    def battle_free(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """一个**不占行动**的自由动作（人类 2026-09-25：「PVP 魔法 / 背包物品不占行动」）。

        与 ``/battle/advance`` 只差一件事，但那是全部意义所在：**它不推进回合**。
        对手这一手不在这一次调用里结算（也不给它任何信息），玩家随后照常出这一手。
        「『愿力冲击』就是个技能，这个算行动」——换上来的技能仍然走 ``/battle/advance``。

        能力是**配置声明**的（``policies.magic_policy.occupies_action === false``）：
        没声明 / 未核验的配置在这里 **fail closed**（422 ``unsupported_effect``），
        绝不静默降级成「占一手」，也绝不静默放行。
        """
        started = time.perf_counter()
        from . import env as env_mod

        state, rs, early = self._private_state(body, started)
        if early is not None:
            return early

        raw_action = body.get("action")
        if not isinstance(raw_action, dict):
            return self._answer_envelope(
                _bad_request("必须给出 action（这一下自由动作）；自由动作不替玩家出这一手"),
                body, started)
        try:
            action = Action.from_dict(raw_action)
        except (ValueError, RulesetError) as exc:
            return self._answer_envelope(_bad_request(f"动作不合法：{exc}"), body, started)

        # 事件要在结算**之前**记长度：`_end_of_turn` 会清空当前回合的事件，
        # 但自由动作不结束回合，所以这里切出来的是「这一下新产生的那些」。
        events_before = len(state.events)
        try:
            env_mod.step_free(state, rs, "player", action)
        except env_mod.fx.UnsupportedEffect as exc:
            # 两种来源要分清（2026-09-29）：
            #   ① 配置没声明这条能力（`free_action_not_declared`）；
            #   ② 结算里残留的未核验机制（`unverified_mechanics_seen`，例如某技能的有效能耗）。
            # 混成同一个 code 会让「配置问题」与「机制缺依据」分不开。
            declared = "没有声明" in str(exc) or "fail closed" in str(exc)
            return self._answer_envelope(
                _unsupported("free_action_not_declared" if declared else "unverified_mechanics_seen",
                             str(exc)),
                body, started)
        except (ValueError, RulesetError) as exc:
            return self._answer_envelope(_bad_request(f"自由动作被拒绝：{exc}"), body, started)

        strategy, why = self._sim_strategy(body, started)
        if why is not None:
            return why
        return self._sim_envelope(
            state, rs, strategy, body, started, event="battle_free", events_from=events_before
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
        from . import rule_config as rc_mod

        # 这一局生效的规则配置：伤害类别要不要按 `spa/spd` 取面板，是它的声明说了算。
        # 原来的预览只按物攻算，修正之后必须与真结算读同一份声明（否则页面预览与打出来的数不一致）。
        cfg = rc_mod.get_rule_config(state.ruleset_config_id or None)
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
                # 2026-09-23：把**这一局的配置**传进去 —— 「伤害按类别取面板」是配置声明，
                # 预览与真结算读同一份声明，否则页面上预览的数与打出来的数会不一样。
                outcome = fx_mod.compute_damage(pet, foe_pet, skill, rs, cfg=cfg)
            except fx_mod.UnsupportedEffect:
                # fail closed：条件化威力读不出来的技能不猜，如实登记
                skipped.append(skill.skill_id)
                continue
            # 2026-09-25：**把属性倍率一并给出来** —— 页面 v3h 的「克制三角」与「预期伤害」颜色
            # 要靠它，而在此之前页面里的那两个标记是**设计稿写死的静态值**（换屏五行永远是
            # up/none/up/down/none，从来不变；人类实测：「优势突然变劣势了，显示还是绿色的优势」）。
            # **用结算用的那一份表**（`effects.compute_damage` 内部就是这一句：
            # `rs.type_chart.multiplier(defender_species.types, skill.element)`）——
            # 提示的职责是"预告玩家真会看到什么"，不是另立一套规则口径；来源写进 `multiplier_source`。
            # 拿不到对手的属性就给 None（页面据此**不画**，而不是画一个"无影响"）。
            defender_types = None
            try:
                defender_types = rs.pet(foe_pet.pet_id).types
            except Exception:
                defender_types = None
            multiplier = None
            if defender_types:
                try:
                    multiplier = float(rs.type_chart.multiplier(defender_types, skill.element))
                except Exception:
                    multiplier = None
            damages.append({
                "label": skill.name,
                "kind": "skill",
                "skill_id": skill.skill_id,
                "damage": outcome.damage,
                "energy": skill.energy,
                "formula_verified": outcome.verified,
                # 2026-09-30（Q8 收口）：这一下用的是哪一套六维（攻/防分别登记 + 整份面板）。
                # 只在**真的用了个体快照**时出现 —— 「同一个体：列表/详情 vs 伤害里用的面板」
                # 这条验收要靠它逐值对照（人类逐字：「不能偷懒」）。
                **({"attacker_atk": round(outcome.attacker_atk, 4),
                    "defender_def": round(outcome.defender_def, 4),
                    "individual_panel": outcome.panel_provenance}
                   if outcome.individual_panel_used() else {}),
                "multiplier": multiplier,
                "multiplier_element": skill.element,
                "multiplier_defender_types": list(defender_types) if defender_types else None,
                "multiplier_source": "effects.compute_damage 用的同一份 TypeChart（预告「这一下打多少」的口径）",
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
                                                  "max": sample["damage"],
                                                  # 2026-09-25：**倍率要跟着合并走**，否则页面拿不到它
                                                  #（`_damage_preview` 里算好了，但计划这条路读的是合并结果，
                                                  # 不在这里带出来就等于没做 —— 实测踩到过一次）。
                                                  "multiplier": sample.get("multiplier"),
                                                  "multiplier_element": sample.get("multiplier_element"),
                                                  "multiplier_defender_types": sample.get("multiplier_defender_types")})
                entry["min"] = min(entry["min"], sample["damage"])
                entry["max"] = max(entry["max"], sample["damage"])
                # 倍率与伤害无关，各分析种子应给出同一个值；不一致就**不写**（fail closed，不挑一个）。
                for key in ("multiplier", "multiplier_element", "multiplier_defender_types"):
                    if sample.get(key) != entry.get(key):
                        entry[key] = None
                # 2026-09-30（Q8 收口）：**面板来源也要跟着合并走** —— `_damage_preview` 里算好了，
                # 不在这里带出来就等于没做（「倍率」那条就是这么踩过一次的，注释还在上面）。
                # 口径与倍率一致：各分析种子该给同一个值（同一个体的面板与分析种子无关），
                # 不一致就**不挑一个**。
                # ⚠ 只在样本**真的带**这把键时才写：没有快照的对局，合并结果与改动前逐位相同。
                for key in ("attacker_atk", "defender_def", "individual_panel"):
                    if key not in sample:
                        continue
                    if key not in entry:
                        entry[key] = sample[key]
                    elif entry[key] != sample[key]:
                        entry[key] = None
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
        # RC-106：这份记录**自己带着**它是用哪份规则配置跑的（`ruleset_config_id`）。
        # 必须按记录那份还原：否则标准 PVP 的存档会被拿去跟「当前默认的 legacy」比，
        # 于是点完「开一局（标准 PVP）」再取合法动作就直接 502（浏览器里实测踩到）。
        from . import rule_config as rc_mod
        try:
            recorded_cfg = rc_mod.get_rule_config(raw.get("ruleset_config_id") or None)
        except rc_mod.RuleConfigError as exc:
            return None, None, self._answer_envelope(_bad_request(
                f"记录里的 ruleset_config_id 不可用：{exc}"), body, started)
        try:
            state = env_mod.deserialize(raw, rs, config=recorded_cfg)
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
            # **同一个实现**（`env.ui_action_public`），再把 UI 专用的 `skill`
            # 那一段剔掉——协议这里的字段形状一个都不变，两条链因此不可能漂移。
            out = []
            for action in env_mod.ui_legal_actions(state, rs, side):
                out.append({k: v for k, v in action.items() if k != "skill"})
            return out

        unsupported: List[Dict[str, Any]] = []
        if state.unsupported:
            unsupported.append({
                "code": "unverified_mechanics_seen",
                "reason": f"本局已登记 {len(state.unsupported)} 条未核验机制（fail closed，不生成默认值）",
                "entries": list(state.unsupported)[:20],
            })

        # 01.3：开局预览事件**同源**带出 —— 回执里这一份就是 `state.events` 里那条事件
        # （同一个对象序列化而来，`seq` 由同一口径派生），不是另造一份。
        # 为什么单独给一个键而不是塞进 `events`：`events` 只在推进类端点下发（见下面），
        # 而预览发生在 `battle_new`；且这条事实要在**之后每一份回执**里都还在
        # （页面「已见阵容」入口要读它），所以按「有才出现」的键一路带着。
        # 没有预览 ⇒ 没有这个键（不补空占位）。
        opening_reveal: Optional[Dict[str, Any]] = None
        # ⚠ 循环变量**不许**叫 `event`：那会遮住本函数的参数 `event`（端点名），
        # 于是下面的 `if event in (...)` 恒假、事件列表整批变空，而 `"event"` 那一格
        # 会变成一个 `Event` 对象（实测踩到：预览局推进后 `events == []`）。
        for index, row_event in enumerate(state.events):
            if row_event.kind == env_mod.OPENING_REVEAL_KIND:
                opening_reveal = dict(row_event.to_dict(),
                                      seq=env_mod.event_seq_of(state, index))
                opening_reveal["text"] = events_text.event_text(opening_reveal, rs)
                break

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
                # 01.2 观察契约：与 `public` / `ui` 里那三个字段**同一份派生**
                # （`env.observation_contract` 是唯一实现），这里只是把它们也放到
                # 回执顶层，让 Node 不必先钻进投影里取。
                **env_mod.observation_contract(state, rs),
                # 01.3：开局预览的「实际展示字段」（有才出现）。
                **({"opening_reveal": opening_reveal} if opening_reveal else {}),
                "public": env_mod.public_planner_state(state, rs, "player"),
                # **并行**的 UI 视图：带真名与系别。刻意**不**给 `public` 加名字——
                # 那是交给模型规划的最小协议，名字对搜索没用、只是白烧 token。
                # 两个视图描述同一时刻的同一局，`state_version` 必须一致。
                "ui": env_mod.ui_public_view(state, rs, "player"),
                "legal": {"player": acts("player"), "enemy": acts("enemy")},
                "needs_replacement": env_mod.needs_replacement(state),
                # 事件带**中文句子**（`text`）与原始 JSON（`detail` 保留原样）。
                # 句子在 Python 侧生成：只有引擎知道每个 detail 键是什么意思，
                # 放到浏览器里再抄一份必然漂移。原始 JSON 一并带出去，
                # 但页面把它收进默认隐藏的调试区（玩家只该看到句子）。
                # 01.2：每行带 `seq`（= 它在 `state.events` 里的 0-based 追加序号）。
                # 为什么必须写进事件行：`events_from` 会把事件**切片**下发，
                # 消费方按数组位置猜序号，一过滤/一分页就与真实序号脱钩。
                # 序号由 `env.event_seq_of` 从既有 `state_version` 口径派生（不新造计数器）。
                "events": [dict(e.to_dict(), seq=env_mod.event_seq_of(state, i),
                                text=events_text.event_text(e.to_dict(), rs))
                           for i, e in enumerate(state.events) if i >= events_from]
                          if event in ("battle_advance", "battle_free") else [],
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
            elif path == "/battle/free":
                status, env = service.battle_free(body)
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
          "/battle/new", "/battle/legal", "/battle/advance", "/battle/free")


# ── 进程入口 ────────────────────────────────────────────────────────────


#: Windows 探测用到的常量：`OpenProcess` 的访问权 / `WaitForSingleObject` 的返回码 /
#: 「pid 不存在」的 `GetLastError`。
_WIN_SYNCHRONIZE = 0x00100000
_WIN_WAIT_OBJECT_0 = 0x00000000
_WIN_WAIT_TIMEOUT = 0x00000102
_WIN_ERROR_INVALID_PARAMETER = 87
_WIN_KERNEL32: Optional[Tuple[Any, Any]] = None


def _win_kernel32() -> Tuple[Any, Any]:
    """惰性加载 kernel32，并**一次性钉死参数/返回类型**（返回 `(kernel32, ctypes)`）。

    ⚠ 必须设 `restype`：`OpenProcess` 返回的是 `HANDLE`（指针量纲），不设时 ctypes 默认按
    `c_int`（32 位）截断 ⇒ 句柄失效 ⇒ `WaitForSingleObject` 恒 `WAIT_FAILED`
    ⇒ 探测**永远"问不出来"**（那会让看门狗要么恒活、要么恒死，两种都是假读数）。
    """
    global _WIN_KERNEL32
    if _WIN_KERNEL32 is None:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        k32.WaitForSingleObject.restype = wintypes.DWORD
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        k32.CloseHandle.restype = wintypes.BOOL
        _WIN_KERNEL32 = (k32, ctypes)
    return _WIN_KERNEL32


def _win_parent_is_alive(parent_pid: int) -> bool:
    """Windows 存活探测：`OpenProcess(SYNCHRONIZE)` 取句柄 + `WaitForSingleObject(h, 0)` 看有没有 signal。

    **零副作用**：只开/等/关一个进程句柄，不发任何控制台事件、不碰目标进程。

    判定（只在**拿到明确证据**时才敢说"死"）：
      · 句柄打不开且 `GetLastError == ERROR_INVALID_PARAMETER`(87) ⇒ 这个 pid 不存在 ⇒ **已死**；
      · 句柄打不开的其它错误（如 `ERROR_ACCESS_DENIED`）⇒ **当作还活着**（问不出来就不误杀）；
      · `WAIT_OBJECT_0` ⇒ 进程对象已 signal（进程已结束）⇒ **已死**；
      · `WAIT_TIMEOUT` ⇒ 还在跑 ⇒ **活着**；
      · `WAIT_FAILED` ⇒ **当作还活着**（同上）。
    """
    k32, ctypes = _win_kernel32()
    handle = k32.OpenProcess(_WIN_SYNCHRONIZE, False, int(parent_pid))
    if not handle:
        return int(ctypes.get_last_error()) != _WIN_ERROR_INVALID_PARAMETER
    try:
        rc = int(k32.WaitForSingleObject(handle, 0))
    finally:
        k32.CloseHandle(handle)
    if rc == _WIN_WAIT_TIMEOUT:
        return True
    if rc == _WIN_WAIT_OBJECT_0:
        return False
    return True                       # WAIT_FAILED 等：问不出来 ⇒ 不误杀


def _parent_is_alive(parent_pid: int) -> bool:
    """父进程还在吗？——**平台必须分开**，这不是优化，是正确性。

    ⚠ **为什么 Windows 上不能写 `os.kill(pid, 0)`**（P0 · 2026-09-30 实测 + A/B）：
    CPython 在 Windows 上把 `sig=0` 当作 `signal.CTRL_C_EVENT`（**它的值就是 0**）⇒ 走
    `GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` ⇒ **向同 console 的进程组广播 Ctrl+C**
    ⇒ 整棵树以 `0xC000013A`（`STATUS_CONTROL_C_EXIT`）退出。
    服务是 `src/coach/roco-client.js:381` 用 `--parent-pid <node pid>` 起的 ⇒
    Windows 侧**任何经它起服务的调用方都会被误杀**（就是 02 夹具"跑到开一局整树原子中断"的真因）。
    ⇒ Windows 走 `_win_parent_is_alive()`（`OpenProcess`+`WaitForSingleObject`，零副作用）。

    POSIX 分支**逐字保留原行为**（`os.kill(pid, 0)` 只探测；任何 `OSError` ⇒ 视为父进程没了）。
    """
    if os.name == "nt":
        return _win_parent_is_alive(parent_pid)
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError:
        return False


def _watch_parent(parent_pid: int) -> None:
    """父进程（Node）死掉后自己退出，避免留下孤儿监听进程。

    ⚠ 探测**必须走 `_parent_is_alive()`**：Windows 上原来的 `os.kill(parent_pid, 0)`
    不是探测，是**广播 Ctrl+C**（见那个函数的注释与 `plan02-p0-watch-parent.md` 的 A/B 读数）。
    探测本身出异常 ⇒ **当作还活着**（不误杀），下一轮再试 —— 看门狗线程不许因此死掉。
    """

    while True:
        time.sleep(1.0)
        try:
            alive = _parent_is_alive(parent_pid)
        except Exception:                       # noqa: BLE001 —— 不误杀优先
            alive = True
        if not alive:
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
