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


def _read_json(rel: str) -> Optional[Dict[str, Any]]:
    try:
        with open(os.path.join(_ROOT, rel), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return None


def trajectory_stats() -> Dict[str, Any]:
    """轨迹集的**真实**规模，从产物清单与验证报告里读出来。

    为什么要读而不是抄：这段 note 原来写死「4,536 条 / 12 个世界」，写完当天就被
    第 37 轮的世界采样修复作废了（真值 6,048 条 / 23 个世界）——而文档不会自己更新，
    于是台账开始说谎。**凡是能从产物读出来的数字就不许抄进文档。**
    """
    manifest = _read_json(os.path.join("tests", "evals", "agent-trajectories-v1.manifest.json"))
    report = _read_json(os.path.join("reports", "roco", "agent-trajectories-verification.json"))
    if not manifest:
        return {"ok": False}
    header = manifest.get("header", {})
    totals = header.get("totals", {})
    replay = header.get("arms_summary", {}).get("replay", {})
    grader = (report or {}).get("grader", {})
    return {
        "ok": True,
        "trajectories": totals.get("trajectories"),
        "worlds": totals.get("worlds"),
        "cases": totals.get("cases"),
        "arms": len(header.get("arms", [])),
        "replay_passed": replay.get("passed"),
        "replay_total": replay.get("total"),
        "negative_total": grader.get("negative", {}).get("total"),
        "producer_passed": ((report or {}).get("producer") or {}).get("passed"),
    }


TRAJECTORY_STATS = trajectory_stats()


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
    {"id": "W4-02", "title": "构造工具轨迹（原计划 2,000—5,000 条，实际按真实世界覆盖走）", "status": PARTIAL,
     "evidence": ["tests/evals/agent-trajectories-v1.jsonl",
                  "tests/evals/agent-trajectories-model-v1.jsonl",
                  "tests/evals/roco/model-error-trajectories-v1.jsonl",
                  "tests/evals/roco/model-error-trajectories-v4.jsonl",
                  "scripts/roco/agent-trajectories.mjs",
                  "scripts/roco/build-agent-trajectories.mjs",
                  "scripts/roco/verify-agent-trajectories.mjs",
                  "docs/roco/AGENT-TRAJECTORIES.md",
                  "docs/roco/W4-02-MODEL-CANDIDATES.md"],
     "note": "{traj:,} 条 / {worlds} 个世界 / {arms} 个 arm，**轨迹格式 + 判定器 + 离线回放**三件已完成，"
             "判定器两个方向都被测过（正向 {pos}/{pos}、反向 {neg:,} 个变体全挂）；"
             "另有**生产者一致性**检查（生成器改了而产物没重建会判红）。"
             "条数超过当初估计的 5,000：第 37 轮修掉世界采样器之后每个任务真的能选到 2—9 个"
             "世界（那三个条件类目从 1 个变成 3 个），多出来的全是真实世界变体，不是灌水。"
             "**模型候选那一半已用本地模型补齐**（第 41 轮，`docs/roco/W4-02-MODEL-CANDIDATES.md`）："
             "`tests/evals/agent-trajectories-model-v1.jsonl` **1,752 条**（每任务取满 9 个可用世界，"
             "那是世界池决定的天花板），同一个判定器、结构 + 离线回放 1,752/1,752 全过、"
             "反向对照 5,988 个变体全挂；按类别 **1,617/1,752 = 0.9229**"
             "（`roster_constraint` 111/216 是唯一弱项，其余六类满分）。"
             "与规则臂在 864 个共同窗口上逐条配对：**退化 42、扳回 0**——"
             "用途是**候选与困难样本**，不是替换规则。"
             "**两条独立代码路径在同一批窗口上判定逐条一致**（轨迹生成器 vs 影子回放），有测试钉住。"
             "错误目录从这一份重建（`model-error-trajectories-v4.jsonl`，135 条，`source_sha256` 对上）："
             "SFT 把 `asked-nothing` 从 34 条**清零**，失败**换成了** `stopped-without-tool` 90 条。"
             "**不声称字节可复现**（靠身份摘要钉住）。".format(
                 traj=TRAJECTORY_STATS.get("trajectories") or 0,
                 worlds=TRAJECTORY_STATS.get("worlds") if TRAJECTORY_STATS.get("ok") else "未知",
                 arms=TRAJECTORY_STATS.get("arms"),
                 pos=TRAJECTORY_STATS.get("replay_total"),
                 neg=TRAJECTORY_STATS.get("negative_total") or 0)},
    # W4-03/W4-04 原来记的是 `NEEDS_HARDWARE`，理由是「本机不是 M5 Pro 48GB」。
    # 那**是个错的读数**：本机就是 Apple M5 Pro / 15 核 / 48 GB（`sysctl machdep.cpu.brand_string`、
    # `hw.memsize`），目标机器就是它。已实测跑通 profiling 与四轮 LoRA 微调，
    # 所以这里改成真实状态；「不租云 GPU」这条边界仍然有效，但它不构成这两项的阻塞。
    {"id": "W4-03", "title": "Qwen3-4B profiling", "status": DONE,
     "evidence": ["docs/roco/LOCAL-MODEL.md", "scripts/model/local-gateway.mjs",
                  "scripts/model/healthcheck-mac.sh", "reports/roco/local-model/bench.json",
                  "tests/evals/local-model.test.js"],
     "note": "本机实测（MLX + Metal，Qwen3.5-4B-4bit）：首 token p50 **214.5 ms**、"
             "总延迟 p50 **~363 ms**、**29.8—32.9 tok/s**、推理峰值内存 **2.51 GB**、"
             "结构化输出合法 **8/8**。机器是 Apple M5 Pro / 15 核 / 48 GB，"
             "**就是路线图写的目标机器**（旧版本这里写「本机不是」，是读错了前提）。"},
    {"id": "W4-04", "title": "Qwen3-4B SFT", "status": PARTIAL,
     "evidence": ["scripts/roco/build-agent-sft-data.mjs", "scripts/roco/verify-sft-split.mjs",
                  "scripts/roco/build-agent-trajectories.mjs",
                  "docs/roco/W4-04-SFT-PREREGISTRATION.md",
                  "reports/roco/sft/dataset-report.json", "reports/roco/sft/train.jsonl"],
     "note": "数据/训练/评测闭环已跑通：1,752 条工具选择数据（train 1,395 / val 306 / test 51，"
             "**逐字节可复现**，由 `verify-sft-split.mjs` 在临时目录重跑后逐字节比对确认）、"
             "四轮 LoRA 微调、同一把 288 条尺子复测。"
             "**预注册判据 P1—P8 全部满足**（判据在跑之前写死在 "
             "`docs/roco/W4-04-SFT-PREREGISTRATION.md`）：v4 **275/288（0.9549）**，"
             "优于 v2 的 268/288；`roster_constraint` 8→**13/24**，`rules_lookup` 68→**70/72**，"
             "`invalid-arguments` 0，p50 435 ms / p95 1054 ms，family 外 0.9271；"
             "相对 v2 逐任务**退化 3、扳回 10**（那 3 条也如实写在报告里）。"
             "**未完成的是接入那一半**：适配器还没进默认链路（`ROCO_LOCAL_MODEL` 默认 `off`，"
             "`off` 下本地进程一次都不启动，有测试证明）——下一步是以 `shadow` 档接真实链路。"},
    {"id": "W5-01", "title": "Model gateway", "status": DONE,
     "evidence": ["scripts/model/local-gateway.mjs", "scripts/model/setup-mac.sh",
                  "scripts/model/start-mac.sh", "scripts/model/stop-mac.sh",
                  "scripts/model/healthcheck-mac.sh", "scripts/model/measure-arms.sh",
                  "docs/roco/LOCAL-MODEL.md", "tests/evals/local-model.test.js"],
     "note": "OpenAI 兼容网关已落地并在跑：`/v1/chat/completions`、`/v1/models`、`/healthz`、`/metrics`；"
             "超时 504 / 忙 429 / 不可用 503、并发上限、取消、回退都有**一处**实现；"
             "一键 setup/start/healthcheck/stop，权重落在 gitignore 目录。"
             "第 37 轮修掉一个真缺陷：`stop` 原来找的 pid 文件名从来没被写过，"
             "所以「停网关」是个空操作——换适配器时会静默沿用旧权重。"},
    {"id": "W4-05", "title": "同 Agent 回放门禁", "status": PARTIAL,
     "evidence": ["scripts/roco/shadow-replay.mjs", "scripts/model/measure-arms.sh",
                  "docs/roco/SHADOW-REPLAY.md", "docs/roco/W4-04-SFT-PREREGISTRATION.md",
                  "reports/roco/shadow-replay.json", "reports/roco/shadow-replay-base.json",
                  "reports/roco/shadow-replay-sft-v4.json",
                  "tests/evals/shadow-replay.test.js",
                  "tests/evals/roco/model-arm-identity.test.js"],
     "note": "门禁已建成并自证：同一任务集（288 条 / 8 类）、同一局面、同一判定器，只换 provider。"
             "规则臂 288/288；**五个 arm 在一条命令下重测完**（`scripts/model/measure-arms.sh`），"
             "每份产物都带适配器 sha256：基座 225/288（0.7813）、v1 229（0.7951）、"
             "v2 268（0.9306）、v3 204（0.7083）、**v4 275（0.9549）**。"
             "报告新增 family/机制/模板的**留出 vs 见过**切片（v4：family 外 0.9271）。"
             "第 38 轮查出并修掉**存档错位**：`-sft-v2.json` 里装的其实是 v1 的成绩、"
             "`-sft-v3.json` 里装的是 v2 的、真正的 v3 没有产物——旧存档已挪进 "
             "`reports/roco/invalidated/`，并加了「文件名 ↔ 适配器」守卫。"
             "缺的那一半仍是 DeepSeek 臂（要 key）。"},
    {"id": "W5-02", "title": "Shadow replay", "status": PARTIAL,
     "evidence": ["scripts/roco/shadow-replay.mjs", "docs/roco/SHADOW-REPLAY.md",
                  "tests/evals/shadow-replay.test.js"],
     "note": "「把候选 provider 在**录制好的任务集**上重放、不与玩家交互地对比」已经可用："
             "`npm run roco:shadow-replay -- --arm local_4b`。它只跑候选，不改玩家看到的任何东西。"
             "缺的是真实流量回放（要用线上录制的请求），目前重放的是构造任务集。"},
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
             "不改玩家看到的结果)；`on` 仍需真人审阅，尚未获准。"
             "**第 39 轮量出两件必须先说的事**（`docs/roco/W5-04-SUPPRESSION-VS-RULE.md`）："
             "① 真实 bridge 把 `first_second_margin` 发成**对象** `{min,max,mean}`，"
             "而 `rocoPlanFeatures` 用 `Number.isFinite` 读它 → `margin = null` → "
             "判定层退回 sigmoid 兜底口径、**在页面上从来没生效过**（第 21/30 轮之后同一形状的"
             "第三次复现，而且被「本该抓住它的那条端到端守卫」盖住——那条守卫自己捏了一个"
             "服务端从不发的标量）。已修，守卫改成走真实路由；"
             "② 手游引擎上 `gap = expected.max - expected.min` **恒为 0**（三个分析种子给出"
             "逐位相同的 expected），所以规则的 `decisive-gap` 分支是**死代码**、"
             "规则在手游侧只按血量档位说话；2×2 实测：规则要开口的 78 个窗口里层抑制 54 个"
             "（那些窗口 margin 中位数 0.0363），两边都说的 24 个窗口 margin 中位数 0.8953。"
             "一局之内提示**条数不变**（24 vs 24）但换成了另外几条。"
             "**新增守卫**：真实路由上的 margin/`decided_by`、`gap ≡ 0`、门控反证 120/120、"
             "以及玩家可见的「期望」那行不再把点估计写成区间。"
             "**goal 要求的四项同时给出**：真规则 baseline（78 个开口窗口 / 层抑制 54）、family 外 TPR 0.9097·FPR 0.0023、ECE 0.0465、判定层延迟 p50 **0.022 ms** / p95 0.093 ms、回滚开关默认 `off` 且 `off` 下不加载模型。"
             "**第 40 轮仲裁分歧格**（`docs/roco/W5-04-ADJUDICATION.md`，判据跑前写死）："
             "用引擎自己的 `risk` 分支 + 深度 3 重规划当第三方——引擎标 `fragile` 且规则本来要开口的窗口"
             "**10 条全部落在被抑制一侧**（一致格 0 条），`downside_max` 中位数 0.33 vs 0.14；"
             "但**深度仲裁不成立**（推荐改变率 0.444 vs 0.417，差 1 个窗口），且 `margin` 与 `downside` "
             "在规则开口层几乎无关（ρ=−0.04）、在被抑制段强正相关（ρ=+0.77）——"
             "**「margin 小 ⇒ 推荐脆」是错的**。结论：**部分支持**，足够留在 shadow 可观测，"
             "**不足以**打开 `on`。另量出：推荐在深度 +1 后 **44% 会翻**。"},

    {"id": "W5-05", "title": "陪练盲评", "status": NEEDS_HUMAN, "evidence": [],
     "needs": "NEEDS_HUMAN：3—5 位真人玩家，对陪练回复做盲评打分（同一条回复随机标成不同来源）",
     "note": "这是外部阻塞，不是代码问题：没有真人评分就无法声称「陪练像不像人」。"},
    {"id": "W6-01", "title": "learned value", "status": NOT_STARTED, "evidence": [],
     "note": "未开工。**数据依赖已经具备**：W4-02 的候选数据（第 41 轮，"
             "`tests/evals/agent-trajectories-model-v1.jsonl` 1,752 条 + 错误目录）"
             "与本机 12,000 局的轨迹集（`reports/roco/trajectories/`，按种子可复现，不入库）都在。"
             "它是「不再手工调 `evaluate`，而是从真实 rollout 学一个价值函数」那条路，"
             "要单独预注册门槛（family 外指标、与现有 `evaluate` 的配对比较、回滚开关）。"},
    {"id": "W6-02", "title": "Battle PPO", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；属训练，且需要 W4-04 的底座。"},
    {"id": "W6-03", "title": "LLM Agentic RL", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；属训练，依赖 W5-01 的 gateway。"},
    {"id": "W6-04", "title": "最终交付", "status": NOT_STARTED, "evidence": [],
     "note": "未开工；依赖 W6-01—03。"},
    # ── 第 65 轮：适配契约 + mock-host 集成夹具 ───────────────────────────
    #
    # 这一段回答的是**可移植性**：小芽原来绑死在这台演示页上。现在核心只通过
    # `src/coach/game-adapter.js` 定义的契约取数据，并且有一份**不依赖演示页 DOM** 的
    # mock-host 夹具跨 48 只名册回放 ≥10 个真实场景。每个 tag 的证据路径都会被本脚本
    # 逐个检查存在性 —— 所以这里不能写「打算做」的路径。
    {"id": "A65-1", "title": "游戏适配契约（公开遥测/合法动作/生命周期/偏好与记忆/事件流/状态版本与取消）",
     "status": DONE,
     "evidence": ["src/coach/game-adapter.js", "docs/roco/GAME-ADAPTER.md",
                  "tests/evals/roco/game-adapter.test.js",
                  "tests/evals/roco/mock-host-integration.test.js"],
     "note": "运行时逐条校验，缺字段/错类型/隐藏信息泄漏/「有威力没出处」一律 fail closed"
             "（`GameAdapterContractError`）；宿主缺能力在**装配期**就抛。契约版本 1。"},
    {"id": "A65-2", "title": "快速检测器：纯函数、无浏览器可跑（P50/P95）",
     "status": DONE,
     "evidence": ["reports/roco/adapter-load/adapter-load.json", "scripts/roco/measure-adapter-load.mjs",
                  "tests/evals/roco/mock-host-integration.test.js"],
     "note": "48 只 × 各 5 次：P50 0.021 ms / P95 0.049 ms（n=240）；打完整局含状态异常那一路 P95 0.114 ms。"
             "命令 `npm run roco:adapter-load`。"},
    {"id": "A65-3", "title": "陈旧结果取消（迟到结果丢弃 + 记录原因）",
     "status": DONE,
     "evidence": ["src/coach/game-adapter.js", "tests/evals/roco/game-adapter.test.js"],
     "note": "丢弃理由分 `state-advanced` 与 `after-deadline` 两种并进 `lateDiscards()`；"
             "反证方向：版本没变时同一份结果**必须**被接受。"},
    {"id": "A65-4", "title": "建议总时限 ≈3 s + 立刻回退规则短提示",
     "status": DONE,
     "evidence": ["reports/roco/adapter-load/adapter-load.json", "src/coach/game-adapter.js"],
     "note": "正常路径完整 advice P50 64 ms / P95 76 ms（64 个窗口）；构造的挂起路径 24/24 在时限内回退"
             "（时限 1500 ms 时 P50 = 1502 ms）。"},
    {"id": "A65-5", "title": "未核验机制 fail closed（带原因，禁止近似成普通伤害）",
     "status": DONE,
     "evidence": ["src/coach/game-adapter.js", "reports/roco/adapter-load/adapter-load.json"],
     "note": "`power_status` 与数值必须成对，没数值必须带 `power_reason`。机制探测被引擎明确拒绝率 1.0"
             "（2/2，对照探针成功）。"},
    {"id": "A65-6", "title": "线上竞技 PVP 不给战术分析（含一处静默失效的修复）",
     "status": DONE,
     "evidence": ["src/coach/policy.js", "src/coach/roco-experience.js",
                  "tests/evals/roco/mock-host-integration.test.js"],
     "note": "`pvp-live` → silent + gate=pvp-live + 文案 null；同局面 PvE 对照必须能开口。"
             "顺带修掉 `rocoGameView` 把模式写死成 pve 导致门控永不命中的问题。"},
    {"id": "A65-7", "title": "规则引擎压过 LLM（模型只能提议工具）",
     "status": DONE,
     "evidence": ["src/coach/game-adapter.js", "tests/evals/roco/game-adapter.test.js"],
     "note": "工具提议只保留 {tool,args,stop}；模型编数字/编动作 → 丢弃模型正文并换回执那一句。"},
    {"id": "A65-8", "title": "mock-host 集成夹具（≥10 个真实场景、跨 48 只名册、不依赖演示页 DOM）",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host/host.mjs", "tests/evals/roco/mock-host/scenarios.mjs",
                  "tests/evals/roco/mock-host/run.mjs", "tests/evals/roco/mock-host-integration.test.js"],
     "note": "8 个对局场景 + 3 个非对局场景；双方阵容合计覆盖登记层 48/48（断言在测试里）。"
             "命令 `npm run test:mock-host`。"},
    {"id": "A65-9", "title": "每条行为配必红反证（贴实际报错）",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host/run.mjs", "tests/evals/roco/mock-host-integration.test.js"],
     "note": "10 条反证：隐藏信息泄漏、少 state_version、有威力没出处、未核验机制没原因、事件乱序/缺文案、"
             "拒绝无时效、宿主缺能力、模型与回执冲突、慢请求+状态已变、浏览器无 process 全局。"},
    {"id": "A65-10", "title": "多动作比较 + 未来 2—3 回合后果结构化（三档标签）",
     "status": DONE,
     "evidence": ["src/coach/compare-model.js",
                  "reports/roco/adapter-acceptance/browser-adapter-acceptance.json"],
     "note": "比较模型搬到核心，页面只渲染；mock 宿主与报告拿到的是同一份。浏览器实测 3 个并列动作 / "
             "5 条后续 / 三档标签齐全。"},
    {"id": "A65-11", "title": "RL 判定层浏览器 layer-error（已修 + 判据）",
     "status": DONE,
     "evidence": ["src/coach/intervention-model.js", "tests/evals/roco/mock-host-integration.test.js",
                  "docs/roco/W5-04-INTERVENTION-GATE.md"],
     "note": "根因是 `interventionModelMode(env = process.env)` 在浏览器里抛 ReferenceError，被 catch 吞成 "
             "layer-error（判定层从来没生效过）。现读 `globalThis.process?.env`，无 process 时返回 off 且不抛。"
             "**`on` 档仍需真人审阅，未获准。**"},
    {"id": "A65-12", "title": "负载与延迟证据落盘（48 只 + 复杂环境）",
     "status": DONE,
     "evidence": ["reports/roco/adapter-load/adapter-load.json", "docs/roco/GAME-ADAPTER.md"],
     "note": "检测器 / 完整 advice / 超时率 / unsupported 率 / 复杂环境逐项分开量，并写明**不声称**什么。"},
    {"id": "A65-13", "title": "浏览器可见行为验收（真实键鼠 + 截图 + clientW/scrollW）",
     "status": DONE,
     "evidence": ["reports/roco/adapter-acceptance/browser-adapter-acceptance.json",
                  "scripts/roco/browser-adapter-acceptance.mjs"],
     "note": "13/13 通过；两档布局 clientW == scrollW（1440/1440、390/390），浮条内部 360/360。"},
    {"id": "A65-14", "title": "陪练情绪 + 显式偏好记忆（拒绝有时效）",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host-integration.test.js"],
     "note": "偏好原话进记忆；拒绝的 expires_at 过期前后各判一次（1 → 0）。"},
    {"id": "A65-15", "title": "老师局末闭环（转折 + 改法 + 下一局目标 + 后续局核对）",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host/run.mjs", "src/coach/teacher-review.js"],
     "note": "真实对局：转折第 13 回合、改法「补位后先确认是谁再决定打谁」、目标 "
             "read-the-replacement-first；后续局核对 checked=true / improved=false"
             "（没出现不许说成做到了）。"},
    {"id": "A65-16", "title": "RAG 引用透传到宿主可见层",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host/scenarios.mjs",
                  "tests/evals/roco/roster-evidence.test.js",
                  "roco/tests/test_roster_evidence.py",
                  "src/server/roco-service.js"],
     "note": "事件级 evidence 真的到（形如行号）；精灵/技能级 evidence_ids 已逐只/逐招透到宿主可见层"
             "（`ev:<ruleset>:pets.json#<pet_id>` / `…skills.json#<skill_id>`），roster 映射层的"
             "**两个分支**（不传参数 / 分页）都搬，Answer 级那条走顶层 `evidence_ids`。"
             "三条判据都带反证（剥掉字段必红）：mock-host 场景 c3、Node 的 roster-evidence 测试、"
             "Python 的 test_roster_evidence。**如实记录**：事件级 evidence 仍是行号，"
             "不是 `…json#实体`（另见 GAME-ADAPTER §7 那一行）。"},
    {"id": "A65-17", "title": "Qwen 工具提议 + 受控回退（网关挂起时立刻回退）",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host-integration.test.js", "src/coach/shadow-tools.js"],
     "note": "网关可用解析出 search_rules；挂起时在总时限内回退规则短提示并记录迟到结果丢弃。"},
    {"id": "A65-18", "title": "RL shadow 档不得改变玩家看到的建议",
     "status": DONE,
     "evidence": ["tests/evals/roco/mock-host-integration.test.js", "src/coach/intervention-model.js"],
     "note": "off 与 shadow 两档正文逐字相同；shadow 照算（active=false、给概率与 margin）；"
             "**如实记录默认档位是 off、on 未获准**。"},
    {"id": "A65-19", "title": "人工评测与 Qwen 27B 部署/微调（延后，由用户自行恢复）",
     "status": NEEDS_HUMAN, "evidence": [],
     "needs": "用户本人：陪练盲评的真人评分（W5-05），以及按指南跑 27B 的部署/微调",
     "note": "两件都**不在本轮范围**：真人盲评需要人，27B 需要用户按 "
             "`docs/roco/QWEN-27B-USER-RUN-GUIDE.md` 跑。本轮只把「可移植性」做实，"
             "**不声称**模型效果或真人体验有任何变化。"},
    {"id": "A65-20", "title": "页面上陈旧**规划**必须整条丢弃（真实竞态，不是假想）",
     "status": DONE,
     "evidence": ["src/coach/roco-experience.js", "src/client/roco.js",
                  "tests/roco-experience.test.js", "scripts/roco/demo-acceptance.mjs"],
     "note": "`/api/roco/plan` 与 `/api/roco/battle/advance` 是两条独立往返。页面原来写 "
             "`state.planAtVersion = state.view?.state_version ?? plan.state_version` —— "
             "**优先取当前视图的版本号**，等于把旧规划盖上新的版本章，之后所有"
             "「版本一致 ⇒ 没陈旧」的判断都放行它。现在唯一判据是 `rocoPlanFreshness()`："
             "规划自己说属于哪一版才算哪一版，不一致就整条丢弃、记账"
             "（`state.planStaleDiscards`）、回退规则短提示。浏览器实测**自然竞态真的撞上**"
             "（局面 30 → 31、规划版本 30）：修复后丢弃；反证（把旧写法放回去）→ "
             "构造竞态 `plan 保留=true planAtVersion=37`、自然竞态 `plan 版本=30 保留=true`，"
             "`demo-acceptance` **117 通过 / 2 失败**。"},
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
            "`NEEDS_HARDWARE` 表示缺的是**特定硬件**，不是决策。目前**没有条目在用**它——W4-03/W4-04 曾经用它，理由是「本机不是 M5 Pro 48GB」，而那是读错了前提：本机就是 M5 Pro 48GB。",
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
    p("3. **一个 DeepSeek key**（或等价模型凭据）：W4-02 的「模型候选」那一半**已用本地模型补齐**，"
      "还要它的是**云端臂对照**（「本地模型 vs 云端模型谁更强」这个问题本机答不了）。另外需要它的有："
      "W4-05 的三条 arm 对比、W5-01 的 gateway 都要它。没有 key 时其余独立项继续做。")
    p("")
    os.makedirs(os.path.join(_ROOT, os.path.dirname(OUT_DOC)), exist_ok=True)
    with open(os.path.join(_ROOT, OUT_DOC), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
