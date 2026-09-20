#!/usr/bin/env python3
"""把「路线图上被划掉多少项」和「真的能跑出证据的多少项」并排列出来。

为什么需要它
------------

一份 30 项的路线图，做到第 27 项时最容易出现两种失真：

  · **把勾当成绩**：`[x]` 只说明「我认为做完了」，不说明证据在哪；
  · **把没做藏起来**：做不到的项被含糊带过，读的人以为都做完了。

这份台账对每一项给出：状态、**证据在哪**（文件或命令）、
以及「缺的是谁」——`NEEDS_HUMAN` 表示需要用户本人（实测数据、录屏、决策），
不是还需要写代码。

跑法::

    python3 scripts/roco/build-progress-dashboard.py
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
OUT_JSON = os.path.join("reports", "roco", "dashboard.json")
OUT_DOC = os.path.join("docs", "roco", "PROGRESS.md")

DONE = "DONE"
PARTIAL = "PARTIAL"
NEEDS_HUMAN = "NEEDS_HUMAN"
NOT_STARTED = "NOT_STARTED"
NEEDS_HARDWARE = "NEEDS_HARDWARE"
#: 旧的「不训练模型」边界已经被用户重写（见 docs/roadmap/DSH-EXECUTION-STATE.md §1.7）。
#: 这个状态只保留给**真的**由边界挡住、且边界仍然有效的条目；目前没有条目再用它，
#: 但枚举保留，免得历史报告里的取值变成「未知」。
BLOCKED_BY_BOUNDARY = "BLOCKED_BY_BOUNDARY"


def git(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=_ROOT, text=True).strip()
    except Exception:  # noqa: BLE001
        return ""


#: 30 项 MVP + 旗舰版条目。每一项都写清：证据在哪、缺什么。
#: `evidence` 里的路径在执行时会被逐个 `os.path.exists` 检查 ——
#: 写了不存在的路径会在报告里被标红，所以这一栏不能编。
ITEMS: List[Dict[str, Any]] = [
    # ── Day 1–2：基线与数据 ──────────────────────────────────────────────
    {"id": "M01", "title": "记录当前基线", "status": DONE,
     "evidence": ["reports/roco/m0-baseline/", "docs/roadmap/DSH-EXECUTION-STATE.md"],
     "note": "HEAD / 环境 / 基线测试逐项落盘；后续每轮都在同一个文件里续写。"},
    {"id": "M02", "title": "KEEP / ADAPT / RETIRE / MISSING 审计", "status": DONE,
     "evidence": ["docs/roco/M0-REPO-AUDIT.md"],
     "note": "每个现有模块都有去向，含 5 条文档与运行态不一致。"},
    {"id": "D01", "title": "建立数据来源清单", "status": DONE,
     "evidence": ["data/roco/sources.yaml", "docs/roco/LICENSE-MATRIX.md"],
     "note": "三个来源的 revision / sha256 / 许可 / 再分发等级。"},
    {"id": "D02", "title": "冻结第一条规则域", "status": DONE,
     "evidence": ["data/roco/normalized/roco-world-s4-2026-09-10/"],
     "note": "`roco-world-s4-2026-09-10`，快照指纹进每个回执。"},
    {"id": "D03", "title": "编写安全 importer", "status": DONE,
     "evidence": ["scripts/roco/import-snapshot.mjs", "scripts/roco/lua-safe-parse.mjs"],
     "note": "第三方 Lua **只作文本解析、不执行**（有自检脚本）。"},
    {"id": "D04", "title": "建立数据质量报告", "status": DONE,
     "evidence": ["data/roco/conflicts.jsonl", "docs/roco/DATA-CONFLICTS.md"],
     "note": "26 处差异全部分类，未解决 = 0。"},
    # ── Day 3–4：microcase 与合同 ────────────────────────────────────────
    {"id": "E01", "title": "编写首批 12 个机制案例", "status": DONE,
     "evidence": ["tests/evals/roco/cases/microcases-v1.jsonl", "docs/roco/MICROCASE-PLAN.md"],
     "note": "已扩到 **30** 条（W3-01 的目标是 30—50）。不能确认的字段写 unknown，不猜。"},
    {"id": "E02", "title": "定义环境合同", "status": DONE,
     "evidence": ["roco/src/roco_env/env.py", "roco/tests/test_replay_invariants.py"],
     "note": "reset/observe/legal_actions/step_joint/serialize/replay；"
             "「双方基于同一事前状态」由 history 里的 observation 哈希钉住。"},
    {"id": "E03", "title": "实现已验证效果原语", "status": "PARTIAL",
     "evidence": ["roco/src/roco_env/effects.py", "docs/roco/MICROCASE-HARNESS.md",
                  "scripts/roco/record-measurements.py"],
     "note": "**这一项只完成了一半，必须说清楚**：引擎侧对每条待验机制都有明确行为"
             "并登记成假设（30 条里 26 条），未知机制一律 fail closed；"
             "但「已验证」那一半需要游戏内实测，当前 **0 条通过**。"
             "实测入口与标定管线已建好，文件是空的。",
     "needs": "NEEDS_HUMAN：一次游戏内伤害实测（技能名 + 双方面板 + 属性关系 + 是否防御）"},
    {"id": "E04", "title": "实现 joint-step 与确定性回放", "status": DONE,
     "evidence": ["roco/tests/test_replay_invariants.py"],
     "note": "100 个固定 seed、每条重放两次逐事件一致；终止后再行动抛错。"
             "顺带修掉一个真 bug：`replay()` 不读记录里的 `loadouts`。"},
    {"id": "E05", "title": "隐藏信息和不变量测试", "status": DONE,
     "evidence": ["roco/tests/test_replay_invariants.py", "roco/tests/test_public_planner.py"],
     "note": "120 局随机对局的不变量 + 60 局 observation 泄漏扫描（按字符串扫，不按字段读）。"},
    # ── Day 7：服务与工具 ────────────────────────────────────────────────
    {"id": "T01", "title": "实现本地规则服务", "status": DONE,
     "evidence": ["roco/src/roco_env/service.py", "tests/evals/roco/bridge.test.js"],
     "note": "六个端点：/health、/rules/query、/team/evaluate、/team/compare、"
             "/battle/plan，以及本地对局域的 /battle/new|legal|advance。"
             "每个回执都带 ruleset_id / state_version / coverage / evidence_ids / "
             "latency_ms / error_type；四类失败可区分。"},
    {"id": "T02", "title": "接入 `coach/toolbox.js`", "status": DONE,
     "evidence": ["src/coach/toolbox.js", "tests/evals/roco/toolbox-roco.test.js"],
     "note": "五个工具契约；路径/URL/代码/未声明参数在到达引擎之前被拒；"
             "状态变化后旧结果被丢弃。"},
    # ── 对手与先导 ──────────────────────────────────────────────────────
    {"id": "S01", "title": "实现五类对手策略", "status": DONE,
     "evidence": ["roco/src/roco_env/opponents.py", "roco/tests/test_opponents.py"],
     "note": "五条策略 + 只读观察代理（拿不到 state）+ 策略版本号。"},
    {"id": "S02", "title": "跑 1,000 场 pilot", "status": DONE,
     "evidence": ["roco/run_pilot.py", "reports/roco/pilot-1000/"],
     "note": "1000 局、非法动作 0、截断 0、异常 0；报告明写「这是环境自检，不是胜率」。"},
    # ── Game Intelligence ───────────────────────────────────────────────
    {"id": "G01", "title": "规则评分 baseline", "status": DONE,
     "evidence": ["roco/src/roco_env/team.py", "docs/roco/mvp/RULE-COVERAGE.md"],
     "note": "六个分项特征（类型/角色/速度/伤害/能量/缺口），**不输出胜率**。"},
    {"id": "G02", "title": "训练逻辑回归/LightGBM 候选", "status": DONE,
     "evidence": ["reports/roco/g02-team/G02-MODEL-2026-09-21-v2.md",
                  "reports/roco/g02-team/model.json"],
     "note": "**过门槛**：未见家族上 log loss 0.6517 vs 规则分 0.6905、"
             "Brier 0.2303 vs 0.2486、ECE 0.0335 ≤ 0.05，AUC 0.6588。"
             "没做 LightGBM 对照，理由写在报告 §7（同规模下只会更快过拟合）。"},
    {"id": "G03", "title": "接入 `evaluate_team`", "status": DONE,
     "evidence": ["roco/src/roco_env/team.py", "tests/evals/roco/toolbox-roco.test.js"],
     "note": "锁定伙伴后只返回满足约束的候选；解释含「改善什么 / 牺牲什么 / 适用哪个对手池」。"},
    {"id": "G04", "title": "实现 2—3 回合联合动作搜索", "status": DONE,
     "evidence": ["roco/src/roco_env/planner.py", "roco/tests/test_planner.py"],
     "note": "可替换启发式，超时如实上报；**风险分支**（downside/top_risks/fragile）"
             "与**原始伤害范围**（damage_preview）都在这条路径上。"},
    {"id": "G05", "title": "接入 `plan_actions`", "status": DONE,
     "evidence": ["src/coach/toolbox.js", "tests/evals/roco/toolbox-roco.test.js"],
     "note": "桥只发公开 planner state；规划器未接入或搜索未完成时明确说出来。"},
    # ── Agent 合同 ──────────────────────────────────────────────────────
    {"id": "A01", "title": "更新 Agent system / tool contract", "status": DONE,
     "evidence": ["src/coach/runtime.js", "src/coach/toolbox.js",
                  "tests/evals/tool-arguments.test.js"],
     "note": "工具参数按契约校验；证据包是事实依据；不编造数值。"},
    {"id": "A02", "title": "打通三个真实场景", "status": DONE,
     "evidence": ["src/client/roco.js", "scripts/roco/demo-acceptance.mjs"],
     "note": "配队页 → evaluate_team / compare_team_change；对局中 → plan_actions；"
             "局后 → 教学入口。三个场景都在 `/roco.html` 上跑通。"},
    # ── 主动介入 ────────────────────────────────────────────────────────
    {"id": "P01", "title": "重写 `should_intervene` 特征", "status": DONE,
     "evidence": ["src/coach/experience.js", "src/coach/roco-experience.js",
                  "tests/roco-experience.test.js"],
     "note": "四档动作 + 硬门控先于评分；阈值是产品参数而不是游戏机制。"},
    {"id": "P02", "title": "事件回放验收", "status": DONE,
     "evidence": ["tests/evals/intervention-windows.json", "tests/intervention.test.js"],
     "note": "30 个窗口（15 该提示 / 15 不该）；P01 精度 1.0、过期 0；"
             "报告明写这是离线 fixture 而不是人体实验。"},
    # ── 老师与陪练 ──────────────────────────────────────────────────────
    {"id": "C01", "title": "老师闭环", "status": DONE,
     "evidence": ["src/coach/teacher.js", "tests/coach.test.js"],
     "note": "每局默认只给一个关键决策；参数变化的相似题；不把一次答对写成掌握。"},
    {"id": "C02", "title": "陪练闭环", "status": DONE,
     "evidence": ["src/coach/companion.js", "tests/companion.test.js",
                  "docs/roco/COMPANION-NONINTRUSION.md",
                  "scripts/roco/verify-companion-nonintrusion.mjs",
                  "tests/evals/companion-nonintrusion.test.js"],
     "note": "六个场景；显式记忆（称呼/偏好/里程碑）与低置信的推测状态分开。"
             "**不打扰验收（第 20 轮）**：预注册 P1—P7，在真实主动触发通道 "
             "`companionEvents` 上量 8 个固定种子的逐回合重放——"
             "该沉默 86 个窗口**沉默率 0.9884**、该说话 20 个窗口**开口率 1.0**、"
             "硬边界（PVP / 预制体验 / 刚被点掉 / 显式安静）**违反 0**、"
             "每局上限与去重**各 0 违规**、每条话都有真实素材且过克制扫描。"
             "**这不是真人验收**：机器判定通过 ≠ 玩家不烦，那一半是 W5-05。"},

    {"id": "C03", "title": "记忆控制", "status": DONE,
     "evidence": ["src/coach/memory.js", "tests/companion.test.js"],
     "note": "查看 / 纠正 / 逐条删除 / 全部清除，保留 source 与 timestamp。"},
    # ── 端到端 ──────────────────────────────────────────────────────────
    {"id": "F01", "title": "无聊天入口完整演示", "status": DONE,
     "evidence": ["src/client/roco.html", "scripts/roco/demo-acceptance.mjs",
                  "reports/roco/demo-acceptance/demo-acceptance.json"],
     "note": "16/16 通过；六条场景（无聊天框、危险时短提示、该沉默就不说、"
             "换阵容撤旧建议、局末一个教学入口、抱怨时先接情绪）。"},
    {"id": "F02", "title": "全链路回归", "status": DONE,
     "evidence": ["reports/roco/regression/F02-REGRESSION-2026-09-21.md"],
     "note": "人读报告 + JSON + 18 份原始日志；P50/P95 实测；四条发现修掉三条、"
             "一条（test:smoke 不自举）如实留作已知问题。"},
    {"id": "F03", "title": "MVP 材料", "status": DONE,
     "evidence": ["docs/roco/mvp/ARCHITECTURE.md", "docs/roco/mvp/DATA-CARD.md",
                  "docs/roco/mvp/RULE-COVERAGE.md", "docs/roco/mvp/STATUS-LABELS.md",
                  "docs/roco/mvp/DEMO-SCRIPT.md"],
     "note": "架构图 / 数据卡 / 规则覆盖表 / 实现状态标签 / 录屏脚本。"
             "**录屏本身没做**，需要用户本人。",
     "needs": "NEEDS_HUMAN：2—3 分钟录屏（脚本已备好，我没有屏幕录制能力）"},
    # ── 旗舰版 Week 3 ───────────────────────────────────────────────────
    {"id": "W3-01", "title": "扩到 12—20 只精灵、40—60 技能", "status": DONE,
     "evidence": ["roco/src/roco_env/traits.py", "data/roco/engine-trait-status.json",
                  "docs/roco/PET-SUPPORT-MATRIX.md"],
     "note": "12/12 精灵接入（FULL 6 / PARTIAL 2 / REFUSED 4）；microcase 21 → 30；"
             "技能池 30 → 55（新开 `candidate_extras`，规范配招不动）。"},
    {"id": "W3-02", "title": "数据增量与阵容合法性", "status": DONE,
     "evidence": ["data/roco/lineup-legality.jsonl", "docs/roco/LINEUP-LEGALITY.md"],
     "note": "169 套逐条台账；结论是 **0 套可原样执行**（名册只 12 只、快照 622 只、"
             "140/169 来自 2026-04 早于 S4）。模拟池因此从自己的 12 只组出来。"},
    {"id": "W3-03", "title": "生成 1 万场以上轨迹", "status": DONE,
     "evidence": ["scripts/roco/build-trajectories.py", "reports/roco/trajectories/manifest.json"],
     "note": "12,000 局 / 234,058 transition；家族**先切分后生成**、三侧互不相交。"
             "91MB jsonl 不入库，靠 manifest 里的种子复现。"},
    {"id": "W3-04", "title": "升级工具（重训 evaluate_team / plan_actions 风险分支）", "status": DONE,
     "evidence": ["roco/src/roco_env/team_model.py", "roco/src/roco_env/planner.py",
                  "tests/roco-experience.test.js"],
     "note": "模型分只在**显式声明对手池**时给，门槛不过不加载、特征顺序不符不加载、"
             "没有模型不编概率；风险分支与伤害范围都上了页面。"
             "两次升级都过了同一个端到端演示。"},
    # ── 旗舰版 Week 4—6 ──────────────────────────────────────────────────
    #
    # 这一段的边界在第 7 轮被用户改写：旧的「不训练模型」是**早期阶段边界**，
    # 不是长期禁令。改写后的规则是：每个模型类模块都必须真的接进 Agent 并有分工，
    # 否则不做；硬件不够的条目按 `NEEDS_HARDWARE` 记，不记成「边界挡住」。
    {"id": "W4-01", "title": "固定 Agent 任务集", "status": DONE,
     "evidence": ["tests/evals/agent-tasks-v1.jsonl", "scripts/roco/build-agent-tasks.py",
                  "scripts/roco/verify-agent-tasks.py", "roco/tests/test_agent_tasks.py"],
     "note": "288 条 / 8 类，按**家族、机制、表达模板**三重隔离切分；留出维度不进训练集，"
             "每类在 train/val/test 三侧都有样本。判定器自检两个方向都要对。"},
    {"id": "W4-02", "title": "构造 2,000—5,000 条工具轨迹", "status": PARTIAL,
     "evidence": ["tests/evals/agent-trajectories-v1.jsonl",
                  "scripts/roco/agent-trajectories.mjs",
                  "scripts/roco/build-agent-trajectories.mjs",
                  "scripts/roco/verify-agent-trajectories.mjs",
                  "docs/roco/AGENT-TRAJECTORIES.md"],
     "note": "4,536 条 / 12 个世界 / 7 个 arm，**轨迹格式 + 判定器 + 离线回放**三件已完成，"
             "判定器两个方向都被测过（正向 648/648、反向 13,656 个变体全挂）。"
             "缺的一半是**模型候选**：要 DeepSeek key，本机没有。"},
    {"id": "W4-03", "title": "Qwen3-4B profiling", "status": NEEDS_HARDWARE,
     "evidence": [], "note": "目标机器是 M5 Pro 48GB；本机不是，且用户不租云 GPU。"
                             "属于硬件阻塞，不是产品决策阻塞。"},
    {"id": "W4-04", "title": "Qwen3-4B SFT", "status": NEEDS_HARDWARE,
     "evidence": [], "note": "同 W4-03；另外它依赖 W4-02 的模型候选那一半。"},
    {"id": "W4-05", "title": "同 Agent 回放门禁", "status": PARTIAL,
     "evidence": ["scripts/roco/verify-agent-trajectories.mjs",
                  "tests/evals/roco/agent-trajectories.test.js"],
     "note": "门禁本身已经可用且自己被验证过（两个方向 + 漂移检查）。"
             "「固定 pipeline / 模型 / SFT」三条 arm 的对比要等有 key 才能真正跑。"},
    {"id": "W5-01", "title": "Model gateway", "status": NOT_STARTED, "evidence": [],
     "note": "未开工。它要连真实模型，和 W4-02 的模型候选同一前置。"},
    {"id": "W5-02", "title": "Shadow replay", "status": NOT_STARTED, "evidence": [],
     "note": "未开工。W4-02 的离线回放是它的雏形，但还没有影子流量。"},
    {"id": "W5-03", "title": "主动介入规则评分", "status": DONE,
     "evidence": ["src/coach/policy.js", "src/coach/experience.js", "tests/intervention.test.js"],
     "note": "规则版已在链路里；W5-04 要做的是**替换它的一部分**，不是从零建。"},
    {"id": "W5-04", "title": "主动介入成本敏感分类器", "status": PARTIAL,
     "evidence": ["docs/roco/W5-04-INTERVENTION-GATE.md",
                  "docs/roco/W5-04-INTERVENTION-GATE-V2.md",
                  "scripts/roco/build-roco-intervention-windows.py",
                  "scripts/roco/train-intervention-model.py",
                  "src/coach/intervention-model.js",
                  "tests/evals/intervention-layer.test.js"],
     "note": "预注册 v2（H1—H8，误报上限改为**绝对值**）→ **手游引擎自己标定**的窗口集 2,544 条"
             "（seed family 切分 + family 外 OOD；边际量阈值 0.1465 只在训练侧估）→ "
             "成本敏感分类器 → 只抑制的判定层 → 11 项守卫测试。"
             "**全部可判定判据通过**：H1 召回 0.900、H2 误报 0.0000、H3 ECE 0.0465、"
             "H4 在阈值 0.74 处 TPR 0.975/FPR 0.0162、H5 family 外 0.9097/0.0023。"
             "**判据有牙的证据**：对照臂（去掉边际量特征、与规则同信息）在同一套判据下"
             "挂掉 H1/H3/H4/H5。因此判定层获准进入 **shadow 可观测**（跑模型、记账、"
             "不改玩家看到的结果)；`on` 仍需真人审阅，尚未获准。"},

    {"id": "W5-05", "title": "陪练盲评", "status": NEEDS_HUMAN, "evidence": [],
     "needs": "NEEDS_HUMAN：3—5 位真人玩家，对陪练回复做盲评打分（同一条回复随机标成不同来源）",
     "note": "这是外部阻塞，不是代码问题：没有真人评分就无法声称「陪练像不像人」。"},
    {"id": "W6-01", "title": "learned value", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；依赖 W4-02 的候选数据。"},
    {"id": "W6-02", "title": "Battle PPO", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；属训练，且需要 W4-04 的底座。"},
    {"id": "W6-03", "title": "LLM Agentic RL", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；属训练，依赖 W5-01 的 gateway。"},
    {"id": "W6-04", "title": "最终交付", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；依赖 W6-01—03。"},
]


def check_evidence(paths: List[str]) -> List[Dict[str, Any]]:
    out = []
    for path in paths:
        full = os.path.join(_ROOT, path.rstrip("/"))
        out.append({"path": path, "exists": os.path.exists(full)})
    return out


def main() -> int:
    items = []
    for item in ITEMS:
        entry = dict(item)
        entry["evidence_checked"] = check_evidence(item.get("evidence") or [])
        entry["evidence_missing"] = [e["path"] for e in entry["evidence_checked"] if not e["exists"]]
        items.append(entry)

    counts: Dict[str, int] = {}
    for item in items:
        counts[item["status"]] = counts.get(item["status"], 0) + 1

    mvp = [i for i in items if i["id"][0] in "MDETGSAPCF" and not i["id"].startswith("W")]
    payload = {
        # 易变字段（时间戳、HEAD、未提交文件数）**不进稳定产物**：
        # 这份台账的用处就是让人看 diff，每次跑都变就没人看了。
        # 它们另存 `dashboard-run.json`（已 gitignore）。
        "generated_by": "scripts/roco/build-progress-dashboard.py",
        "important": [
            "`DONE` 的意思是「有证据、且证据是可跑的」——每一行的证据路径都被本脚本检查过存在性。",
            "`NEEDS_HUMAN` 表示缺的是**用户本人**（实测数据 / 录屏 / 决策），不是还缺代码。",
            "`NEEDS_HARDWARE` 表示缺的是**特定硬件**（M5 Pro 48GB），不是决策。",
            "`BLOCKED_BY_BOUNDARY` 只用于仍然有效的硬边界；旧的「不训练模型」在第 7 轮已被用户改写。",
            "这份台账不判「质量好不好」，只判「证据在不在」。",
        ],
        "counts": counts,
        "mvp_total": len(mvp),
        "mvp_done": sum(1 for i in mvp if i["status"] == DONE),
        "items": items,
    }
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_JSON)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_JSON), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    run_path = os.path.join(_ROOT, os.path.dirname(OUT_JSON), "dashboard-run.json")
    with open(run_path, "w", encoding="utf-8") as fh:
        json.dump({
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "head": git("rev-parse", "HEAD"),
            "dirty_files": len([x for x in git("status", "--porcelain").splitlines() if x.strip()]),
        }, fh, ensure_ascii=False, indent=2)
    write_doc(payload)
    print(json.dumps({"counts": counts, "mvp_done": payload["mvp_done"],
                      "mvp_total": payload["mvp_total"],
                      "evidence_missing": [i["id"] for i in items if i["evidence_missing"]]},
                     ensure_ascii=False, indent=2))
    print(f"wrote {OUT_JSON} and {OUT_DOC}")
    return 0


def write_doc(payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    p = lines.append
    p("# 进度台账（路线图 vs 证据）")
    p("")
    # 时间戳/HEAD/未提交数都是易变字段，不写进这份文档（否则每次跑都显示改动）。
    # 它们留在 `reports/roco/dashboard-run.json` 里。
    p("> 生成脚本：`scripts/roco/build-progress-dashboard.py`"
      "　（HEAD 与生成时间是易变字段，留在 `reports/roco/dashboard-run.json`）")
    p("")
    for line in payload["important"]:
        p(f"- {line}")
    p("")
    p("## 汇总")
    p("")
    p(f"- MVP 30 项中 `DONE`：**{payload['mvp_done']} / {payload['mvp_total']}**")
    p("")
    p("| 状态 | 条数 |")
    p("|---|---:|")
    for status, count in sorted(payload["counts"].items()):
        p(f"| `{status}` | {count} |")
    p("")
    p("## 逐项")
    p("")
    p("| # | 任务 | 状态 | 证据 | 说明 |")
    p("|---|---|---|---|---|")
    for item in payload["items"]:
        ev = "、".join(f"`{e['path']}`" for e in item["evidence_checked"]) or "—"
        note = (item.get("note") or "—").replace("|", "\\|")
        p(f"| {item['id']} | {item['title']} | `{item['status']}` | {ev} | {note} |")
    missing = [i for i in payload["items"] if i["evidence_missing"]]
    p("")
    p("## 证据路径检查")
    p("")
    if missing:
        p("以下条目的证据路径**不存在**（说明写错了或文件被移走）：")
        p("")
        for item in missing:
            p(f"- `{item['id']}`：{', '.join(item['evidence_missing'])}")
    else:
        p("所有 `DONE` 条目的证据路径都存在（本脚本在建表时逐个检查过）。")
    p("")
    p("## 还没做完的，以及缺的是谁")
    p("")
    todo = [i for i in payload["items"] if i["status"] != DONE]
    if not todo:
        p("（没有未完成项。）")
    else:
        for item in todo:
            p(f"- **{item['id']} {item['title']}**（`{item['status']}`）")
            p(f"  - {item.get('note')}")
            if item.get("needs"):
                p(f"  - **缺的是谁**：{item['needs']}")
    p("")
    p("## planner 的三个基准（结论见 `docs/roco/BENCHMARKS.md`）")
    p("")
    p("| 命令 | 口径 | 量出来的结论 |")
    p("|---|---|---|")
    p("| `npm run roco:benchmark-planner` | 一步推演值当正确答案 | top1 0.27 → **0.59**（修掉候选裁剪之后）；**不能**比较搜索深度 |")
    p("| `npm run roco:benchmark-matches` | 整局胜负 | ⛔ **量具被判定为错，结论 INVALID / 不可解释**（80 对 40、且用区间重叠当差异检验）。"
      "修正后协议：两个座位样本数相等 + 配对检验。见 `docs/roco/BENCHMARKS.md` 第 2 节 |")
    p("| `npm run roco:planner-calibration` | `expected` 对整局胜负 | **不显著**（Welch t=0.873）→ `expected` **不能**当信心代理 |")
    p("")
    p("最后一条（`planner-calibration`）是**否定结论**，也是最有行动价值的一个：它挡住了")
    p("「把 `expected` 当胜率展示给玩家」这条看起来顺理成章的用法。")
    p("")
    p("## 需要用户的三件事（唯一阻塞）")
    p("")
    p("1. **一条游戏内伤害实测**：技能名 + 双方精灵名 + 是否防御 + 实际伤害数字。")
    p("   有它就能把 E03 的「已验证」那一半推进，并标定 MC-008/010/011。")
    p("   录入：`python3 scripts/roco/record-measurements.py --interactive`")
    p("2. **录屏**（F03 的第二项）：脚本 `docs/roco/mvp/DEMO-SCRIPT.md` 已备好。")
    p("3. **一个 DeepSeek key**（或等价模型凭据）：W4-02 的「模型候选」那一半、"
      "W4-05 的三条 arm 对比、W5-01 的 gateway 都要它。没有 key 时其余独立项继续做。")
    p("")
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_DOC)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_DOC), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
