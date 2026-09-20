#!/usr/bin/env python3
"""W4-01 —— 固定 Agent 任务集。

要解决的问题
------------

到目前为止，「小芽这个 Agent 做得好不好」只靠两个东西判断：
`tests/evals/` 里几十条冒烟断言，和模型自己的回答看起来像不像。
两者都不能回答「换了模型之后，主任务成功率有没有变」。

W4-01 要的是一份**固定任务集**：每条任务都有
  ① 一个明确的类别（八类，见下）；
  ② 可判定的成功判据（谁该被调用、参数对不对、该不该沉默）；
  ③ 三重隔离的家族标签（阵容家族 / 机制 / 表达模板），供 train/val/test 切分。

八类任务（与路线图一致）
------------------------

  1. `rules_lookup`      规则补查 —— 该调 `query_rules`，参数（kind/id）要对
  2. `roster_constraint` 阵容约束 —— 该调 `evaluate_team` / `compare_team_change`，锁定伙伴不能换掉
  3. `continue_stop`     继续/停止 —— 该继续查证，还是已经够了
  4. `tool_failure`      工具失败 —— 引擎回答不了时该如实说，不得编数
  5. `stale_state`       状态过期 —— `state_version` 变了，旧结果必须作废
  6. `evidence_conflict` 证据冲突 —— 两条来源不一致时该指出冲突而不是二选一
  7. `silence`           静默 —— 该**不调用任何工具**、也不主动开口
  8. `brief_explain`     简短解释 —— 调用数受限（≤1 次）且正文不超过 180 字

**任务集不是给人读的文档，是给门禁用的数据。** 所以每条都必须**可程序化判定**：
`expect.tool` 允许/禁止哪些工具、`expect.args` 里哪些字段必须精确匹配、
`expect.max_tool_calls`、`expect.must_not_fabricate`。
判定器在 `scripts/roco/verify-agent-tasks.py`。

三重隔离切分
------------

切分**不按条随机**，而是按三个维度整体切：
  · `family`：阵容家族（涉及哪些精灵 / 有没有锁定伙伴）
  · `mechanism`：涉及哪条机制（术语 id 或机制名）
  · `template`：表达模板（同一意思的句式）

随机按条切会把同一家族的近义句分散到两侧，测出来的泛化是假的。
切分单位是 **(family, mechanism, template) 三元组**的哈希，写在每条任务上，
切分函数只读这个哈希。

跑法::

    python3 scripts/roco/build-agent-tasks.py            # 写文件
    python3 scripts/roco/build-agent-tasks.py --print     # 只看统计
"""

from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

OUT = os.path.join("tests", "evals", "agent-tasks-v1.jsonl")

#: 切分种子。**写死**：换一批切分得出的指标不可比。
SPLIT_SEED = 20260921

#: **三个维度各自整体留出一部分**，而不是把三元组哈希成一个家族。
#:
#: 为什么改：第一版把 `(family, mechanism, template)` 拼成一个键去切分，
#: 结果 29 条任务就有了 29 个「家族」—— 因为每条任务的组合都不同，
#: 于是「家族隔离」这个说法在数据上根本不成立（每条自成一族），
#: 而 train/val/test 变成 21/4/4 的随机分配，测出来的泛化是假的。
#:
#: 正确的做法是**维度级留出**：整类阵容家族、整类机制、整类表达模板分别留一部分，
#: 测试集的每一条都至少有一个维度是训练时没见过的。
#: 路线图说的「阵容家族、机制、表达模板全部隔离」就是这件事。
#: 留出比例。实测 0.25 在 3 个家族上会留 1 个（33%），
#: 在 6 个机制上留 2 个 —— 于是 `stale_state` 与 `brief_explain` 的 val 变成 0。
#: 0.34 让「留出集约为三分之一」，各类别都还能有 val 样本。
HOLDOUT_RATIO = 0.34


def _holdout(names: List[str], ratio: float = HOLDOUT_RATIO) -> set:
    """从一组维度值里按种子挑出留出集。**确定性**，不依赖字典顺序。"""
    ranked = sorted(names, key=lambda n: hashlib.sha256(
        f"{SPLIT_SEED}:{n}".encode("utf-8")).hexdigest())
    keep = max(1, int(round(len(ranked) * ratio)))
    return set(ranked[:keep])

CATEGORIES = (
    "rules_lookup", "roster_constraint", "continue_stop", "tool_failure",
    "stale_state", "evidence_conflict", "silence", "brief_explain",
)

#: 五个工具的名字（与 `src/coach/roco-client.js` 的 ROCO_TOOLS 一致）。
TOOLS = ("query_rules", "evaluate_team", "compare_team_change",
         "plan_actions", "summarize_battle")

#: 读状态的工具（`read_state`）不算 roco 工具，但静默类任务要允许它为空。
READ_TOOLS = ("read_state", "read_match", "read_evidence", "search_rules")


def family_key(family: str, mechanism: str, template: str) -> str:
    raw = f"{family}|{mechanism}|{template}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


#: 各维度的留出集合。由 `build()` 先收集全部维度值、再算出留出集，
#: 然后才生成任务 —— 所以它是模块级状态，但**只在 build 期间**被写入。
HOLDOUT: Dict[str, set] = {"family": set(), "mechanism": set(), "template": set()}


def split_of(family: str, mechanism: str, template: str) -> Tuple[str, List[str]]:
    """按**维度留出**定侧：返回 `(侧, 命中的留出维度列表)`。

    规则：
      · 命中 **family** 留出 → `test`（最难：整个阵容家族没见过）
      · 命中 **mechanism** 或 **template** 留出 → `val`
      · 都没命中 → `train`

    一条任务可以同时命中多个留出维度，那时取**最难**的那一档（test），
    并把命中的维度都记下来，便于事后按维度拆开看指标。
    """
    hits: List[str] = []
    if family in HOLDOUT["family"]:
        hits.append("family")
    if mechanism in HOLDOUT["mechanism"]:
        hits.append("mechanism")
    if template in HOLDOUT["template"]:
        hits.append("template")
    if "family" in hits:
        return "test", hits
    if hits:
        return "val", hits
    return "train", []


def task(case_id: str, category: str, message: str, *, family: str, mechanism: str,
         template: str, context: Dict[str, Any], expect: Dict[str, Any],
         why: str) -> Dict[str, Any]:
    key = family_key(family, mechanism, template)
    side, hits = split_of(family, mechanism, template)
    return {
        "record_type": "agent_task",
        "case_id": case_id,
        "category": category,
        "message": message,
        "context": context,
        "expect": expect,
        "why": why,
        "split": {
            "family": family,
            "mechanism": mechanism,
            "template": template,
            "key": key,
            "side": side,
            "held_out_dimensions": hits,
        },
    }


# ── 任务库 ────────────────────────────────────────────────────────────────
#
# 三条纪律写在生成器里，而不是留给读者去猜：
#   ① 每条任务的成功判据都是**可程序化判定**的（工具名 / 参数 / 次数 / 禁止编造）；
#   ② `why` 说明这条任务在防什么，而不是复述题面；
#   ③ 家族/机制/模板三个标签必须**真的不同**，否则切分是假的。

def cross(base: str, category: str, *, family: str, mechanism: str,
          templates: List[Tuple[str, str]], expect_of, why: str,
          context: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """把一件事实 × 若干表达模板展开成多条任务。

    **为什么要展开成叉积**：第一版每个类别只写 3—6 条，29 条任务做维度留出之后
    测试集只剩 6 条 —— 样本量根本不足以支撑一个门禁（6 条里错 1 条就是 17 个百分点）。
    叉积把「同一件事实的不同问法」变成多条任务，于是留出某个模板时，
    测试集里仍有足够多的**同一机制、不同说法**的样本。

    注意 `template` 是**维度**不是文案：留出它测的是「换个问法还认不认得」。
    """
    out = []
    prefix = FAMILY_PREFIX.get(family, "")
    for index, (template, message) in enumerate(templates, 1):
        out.append(task(
            f"{base}-{index:02d}", category, prefix + message,
            family=family, mechanism=mechanism, template=template,
            context=dict(context or {}),
            expect=expect_of(template, message),
            why=why,
        ))
    return out


#: 三个「阵容家族」维度值 —— 留出其中一个时，整族都不在训练集里。
#:
#: **家族必须体现在句子里。** 第一版只是给消息贴了个家族标签，同一句话在三个家族
#: 下重复了三遍 —— 于是「留出家族」测的是同一句话，而且数据里有 96 条重复消息。
#: 现在每个家族带一个**背景前缀**，句子真的不同：
#:   · 无锁定：练习场里随口问
#:   · 锁定寂灭骨龙：玩家已经说了锁定谁
#:   · 含 B 组：队伍里有另一只精灵
FAMILY_PREFIX = {
    "A组三人-无锁定": "",
    "A组三人-锁定寂灭骨龙": "我锁定寂灭骨龙，",
    "混编三人-含B组": "我队里带了画间沉铁兽，",
}
FAMILIES = tuple(FAMILY_PREFIX)

#: 通用表达模板（每个类别自己的模板集见各类别）。留出某个模板时，
#: 测试集里同机制但不同说法的样本仍在 —— 那正是要测的泛化。
#: 问法的模板。**每条模板的成品句子必须互不相同** —— 否则「留出模板」这个维度
#: 量的是同一句话，测不出任何泛化。`assert_templates_are_distinct()` 会检查这一点。
TEMPLATES_ASK = [
    ("直问", "{q}？"),
    ("口语", "{q}啊？"),
    ("追问", "再确认一下，{q}？"),
    ("背景", "我在练习场，想问下：{q}？"),
]
TEMPLATES_YESNO = [
    ("封闭", "{q}？"),
    ("确认", "是不是{q}？"),
    ("质疑", "你确定{q}吗？"),
    ("对比", "跟别的比，{q}？"),
]


def tasks_rules_lookup() -> List[Dict[str, Any]]:
    """该调 `query_rules`，且 kind/id 要对。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("rl-pet", "寂灭骨龙的种族值是多少", "pet", {"pet_id": "pet_000225"},
         "图鉴字段", "FAMILIES[0]"),
        ("rl-skill", "坟场搏击的静态威力是多少", "skill", {"name": "坟场搏击"},
         "技能静态威力", "FAMILIES[0]"),
        ("rl-type", "龙系打幽系是几倍", "type_multiplier",
         {"attack_element": "龙系", "defender_types": ["幽系"]},
         "属性相性", "FAMILIES[0]"),
        ("rl-learn", "海豹船长学得到哪些技能", "learnset", {"pet_id": "pet_000190"},
         "学习表", "FAMILIES[2]"),
        ("rl-term", "「应对」这条术语是怎么定义的", "term", {"term_id": "1015"},
         "应对机制", "FAMILIES[1]"),
        ("rl-ruleset", "这份规则集是哪个版本", "ruleset", {},
         "版本指纹", "FAMILIES[2]"),
    ]
    for base, question, kind, args, mechanism, fam in specs:
        phrase = question + "？"
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_ASK]
            out.extend(cross(
                f"{base}-f{fi}", "rules_lookup",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m, kind=kind, args=args: {
                    "tool": "query_rules",
                    "args_must_match": {"kind": kind, **args},
                    "must_not_fabricate": True,
                    "max_tool_calls": 2,
                },
                why="规则事实必须来自引擎；编一个数值比说「查不到」更糟。",
                context={"mode": "camp"},
            ))
    return out


def tasks_roster_constraint() -> List[Dict[str, Any]]:
    """阵容约束：锁定伙伴不能被换掉。"""
    out: List[Dict[str, Any]] = []
    team = ["pet_000225", "pet_000190", "pet_000445"]
    variants = [
        ("rc-eval", "评一下这套阵容", "evaluate_team", "阵容评分"),
        ("rc-swap", "第三只换成圆号鱼好不好", "compare_team_change", "换人对比"),
    ]
    for base, question, tool, mechanism in variants:
        for fi, family in enumerate(FAMILIES):
            locked = "pet_000225" if "锁定" in family else None
            args: Dict[str, Any] = {"team": team}
            if tool == "compare_team_change":
                args = {"team_before": team, "team_after": [team[0], team[1], "pet_000417"]}
            if locked:
                args["locked_pet"] = locked
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_ASK]
            out.extend(cross(
                f"{base}-f{fi}", "roster_constraint",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m, tool=tool, args=args, locked=locked: {
                    "tool": tool,
                    "args_must_match": args,
                    "must_keep_locked": locked,
                    "must_not_claim_winrate": True,
                    "max_tool_calls": 2,
                },
                why="锁定伙伴是玩家明确表达的偏好；换掉它等于无视玩家说的约束。",
                context={"mode": "camp", "locked_pet": locked, "team": team},
            ))
    return out


def tasks_continue_stop() -> List[Dict[str, Any]]:
    """继续查证还是已经够了 —— 判据是调用数的上界。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("cs-answered", "寂灭骨龙是什么属性", "单一事实", "already-answered", 1),
        ("cs-lastturn", "我刚才那回合做了什么", "回看记录", "needs-one-more", 2),
        ("cs-diagnose", "这套阵容为什么坦度不够", "阵容诊断", "needs-one-more", 2),
    ]
    CS_TEMPLATES = [("直问", "{q}？"), ("口语", "{q}呢？"),
                    ("委托", "帮我看看{q}？"), ("背景", "我在练习场，{q}？")]
    for base, question, mechanism, template, cap in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in CS_TEMPLATES]
            out.extend(cross(
                f"{base}-f{fi}", "continue_stop",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m, cap=cap: {
                    "tool": None, "max_tool_calls": cap, "must_not_fabricate": True,
                },
                why=f"{question}：查够了还继续调工具是浪费，没查够就下结论是编造。",
                context={"mode": "camp"},
            ))
    return out


def tasks_tool_failure() -> List[Dict[str, Any]]:
    """引擎回答不了时必须如实说。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("tf-damage", "坟场搏击打海豹船长具体多少伤害", "damage", "条件化威力"),
        ("tf-plan", "第 3 回合如果我先防御会怎样", "plan", "推演"),
        ("tf-summary", "把这局写个复盘摘要", "summary", "复盘"),
    ]
    for base, question, kind, mechanism in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_ASK]
            out.extend(cross(
                f"{base}-f{fi}", "tool_failure",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m: {
                    "tool": None, "must_mention_limitation": True,
                    "must_not_fabricate": True, "max_tool_calls": 2,
                },
                why="引擎答不了时必须出现「未核验 / 没有端点 / 不支持」这类措辞，"
                    "且不许给出具体数字型结论 —— 编一个数字比说「算不了」严重得多。",
                context={"mode": "battle", "forced_failure": kind},
            ))
    return out


def tasks_stale_state() -> List[Dict[str, Any]]:
    """状态过期：旧结果必须作废。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("ss-plan", "现在该出什么招", "轮次推进"),
        ("ss-hp", "我这只还剩多少血", "面板变化"),
        ("ss-hint", "刚才那个建议现在还算数吗", "建议失效"),
    ]
    for base, question, mechanism in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_ASK]
            out.extend(cross(
                f"{base}-f{fi}", "stale_state",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m: {
                    "tool": None, "must_not_use_stale": True,
                    "must_not_fabricate": True, "max_tool_calls": 2,
                },
                why="状态已推进；拿旧状态算出来的结论必须作废，而不是继续讲。",
                context={"mode": "battle", "state_version_bumped": True},
            ))
    return out


def tasks_evidence_conflict() -> List[Dict[str, Any]]:
    """证据冲突：指出冲突，不许二选一。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("ec-value", "黑猫巫师的物攻到底是多少", "跨来源数值"),
        ("ec-form", "化蝶是哪一只", "同名形态"),
        ("ec-strength", "音速犬现在算强吗", "强度口径"),
    ]
    for base, question, mechanism in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_YESNO]
            out.extend(cross(
                f"{base}-f{fi}", "evidence_conflict",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m: {
                    "tool": None, "must_surface_conflict": True,
                    "must_not_claim_winrate": True, "max_tool_calls": 2,
                },
                why="替玩家挑一个来源，等于把不确定性藏起来；" 
                    "社区阵容频次不是胜率，不能拿它当强度结论。",
                context={"mode": "camp", "conflict": True},
            ))
    return out


def tasks_silence() -> List[Dict[str, Any]]:
    """该沉默：不调用任何工具、也不主动开口。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("si-submitted", "（玩家刚出完招，界面在等待）", "回合已提交"),
        ("si-quiet", "（玩家在安静档下自己操作）", "偏好设置"),
        ("si-noaction", "（当前没有可行动作）", "局面状态"),
        ("si-refuse", "不用了，谢谢。", "拒绝"),
    ]
    for base, message, mechanism in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(base, message)]   # 沉默类**刻意**只有一种输入：那是条件，不是问法
            out.extend(cross(
                f"{base}-f{fi}", "silence",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m: {
                    "tool": None, "max_tool_calls": 0, "must_not_speak": True,
                },
                why="该沉默时开口是这个产品最容易犯的错。",
                context={"mode": "battle", "expect_silence": True},
            ))
    return out


def tasks_brief_explain() -> List[Dict[str, Any]]:
    """简短解释：调用数受限，正文不超过 180 字。"""
    out: List[Dict[str, Any]] = []
    specs = [
        ("be-defense", "为什么这一手要防御", "行动解释"),
        ("be-energy", "能量和威力是什么关系", "能量机制"),
        ("be-loss", "我这局输在哪", "复盘"),
    ]
    for base, question, mechanism in specs:
        for fi, family in enumerate(FAMILIES):
            templates = [(t, m.format(q=question)) for t, m in TEMPLATES_ASK]
            out.extend(cross(
                f"{base}-f{fi}", "brief_explain",
                family=family, mechanism=mechanism, templates=templates,
                expect_of=lambda _t, _m: {
                    "tool": None, "max_tool_calls": 1,
                    "max_reply_chars": 180, "must_not_fabricate": True,
                },
                why="180 字是硬上限，超了玩家就不看了。",
                context={"mode": "battle"},
            ))
    return out


BUILDERS = (tasks_rules_lookup, tasks_roster_constraint, tasks_continue_stop,
            tasks_tool_failure, tasks_stale_state, tasks_evidence_conflict,
            tasks_silence, tasks_brief_explain)


def build() -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    # 两遍：先收集三个维度的全部取值，算出留出集，再生成任务。
    # 一遍是做不了的 —— 留出集必须建立在**全量维度值**上，否则先建的先拿到名额。
    global HOLDOUT
    probe: List[Dict[str, Any]] = []
    for builder in BUILDERS:
        probe.extend(builder())
    HOLDOUT = {
        dim: _holdout(sorted({row["split"][dim] for row in probe}))
        for dim in ("family", "mechanism", "template")
    }

    rows: List[Dict[str, Any]] = []
    for builder in BUILDERS:
        rows.extend(builder())

    # ── 保证**每个类别在 train/val/test 三侧都有样本** ────────────────────
    #
    # 为什么需要这一步：维度留出会让某些类别整类落在一侧。
    # 实测 `stale_state` 与 `brief_explain` 的 val 是 0 —— 因为它们的机制与模板
    # 恰好都被留出了。一个类别如果在某侧没有样本，那一侧就没法评估它，
    # 而「某类完全没评估过」在门禁里等于「不知道」而不是「通过」。
    #
    # 修法是**在留出之外再补一次确定性分配**：对每个侧为空的 (类别, 侧)，
    # 从样本最多的那一侧按 case_id 顺序搬一条过去。搬运是**明确的**，
    # 并在 header 里记账（`side_backfill`），不假装它是留出产生的。
    backfill: List[Dict[str, str]] = []
    for category in sorted({r["category"] for r in rows}):
        for side in ("val", "test"):
            members = [r for r in rows if r["category"] == category and r["split"]["side"] == side]
            if members:
                continue
            donors = sorted([r for r in rows if r["category"] == category
                             and r["split"]["side"] == "train"], key=lambda r: r["case_id"])
            if len(donors) <= 1:
                continue                      # 不够搬，宁可留着 0 也不清空 train
            donor = donors[-1]
            donor["split"]["side"] = side
            donor["split"]["held_out_dimensions"] = []
            donor["split"]["backfilled"] = True
            backfill.append({"case_id": donor["case_id"], "category": category, "to": side})

    ids = [r["case_id"] for r in rows]
    dupes = [k for k, v in collections.Counter(ids).items() if v > 1]
    if dupes:
        raise SystemExit(f"case_id 重复：{dupes}")

    by_category = collections.Counter(r["category"] for r in rows)
    by_side = collections.Counter(r["split"]["side"] for r in rows)
    # 切分单位是家族键；同键必须同侧 —— 这是三重隔离的**唯一**保证
    sides_by_key: Dict[str, set] = {}
    for row in rows:
        sides_by_key.setdefault(row["split"]["key"], set()).add(row["split"]["side"])
    leak = {k: sorted(v) for k, v in sides_by_key.items() if len(v) > 1}

    # 切分单位是**维度留出**：同一条任务只会落在它命中的最难那一档。
    # 这里的「泄漏检查」改成检查**维度**没有跨侧：
    # 一个留出的 mechanism 不该在 train 里出现。
    leaked: Dict[str, List[str]] = {}
    for dim in ("family", "mechanism", "template"):
        trained = {row["split"][dim] for row in rows if row["split"]["side"] == "train"}
        bad = sorted(HOLDOUT[dim] & trained)
        if bad:
            leaked[dim] = bad

    header = {
        "record_type": "agent_task_set_header",
        "set_id": "agent-tasks-v1",
        "built_by": "scripts/roco/build-agent-tasks.py",
        "ruleset_id": "roco-world-s4-2026-09-10",
        "split_seed": SPLIT_SEED,
        "split_mode": "dimension_holdout",
        "holdout_ratio": HOLDOUT_RATIO,
        "holdout": {k: sorted(v) for k, v in HOLDOUT.items()},
        "categories": list(CATEGORIES),
        "tools": list(TOOLS),
        "counts": {"total": len(rows), "by_category": dict(by_category),
                   "by_side": dict(by_side),
                   "by_held_out_dimension": dict(collections.Counter(
                       dim for row in rows for dim in row["split"]["held_out_dimensions"]))},
        "leak_check": {"holdout_dimensions_leaking_into_train": leaked,
                       "detail": leak},
        "side_backfill": backfill,
        "disciplines": [
            "切分按 **(family, mechanism, template) 三元组**整体切，不按条随机。",
            "每条的成功判据都是**可程序化判定**的（工具 / 参数 / 次数 / 禁止编造）。",
            "任务集是**门禁数据**，不是给人读的文档；`why` 说明它在防什么。",
            "这些用例由本仓库作者编写，**不是第三方标注**；它只能用于回归与门禁，"
            "不能当作「小芽在真人身上效果如何」的评测集。",
        ],
    }
    return rows, header


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="W4-01 Agent 任务集")
    parser.add_argument("--print", action="store_true", dest="print_only")
    args = parser.parse_args(argv)

    rows, header = build()
    text = json.dumps(header, ensure_ascii=False)
    for row in rows:
        text += "\n" + json.dumps(row, ensure_ascii=False)
    text += "\n"

    if not args.print_only:
        path = os.path.join(_ROOT, OUT)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {OUT}")

    print(json.dumps(header["counts"], ensure_ascii=False, indent=1))
    print(f"留出维度泄漏进 train：{header['leak_check']['holdout_dimensions_leaking_into_train']}"
          f"（必须是空）")
    if header["side_backfill"]:
        print(f"为保证每类三侧都有样本，补搬了 {len(header['side_backfill'])} 条："
              + ", ".join(f"{b['case_id']}→{b['to']}" for b in header["side_backfill"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
