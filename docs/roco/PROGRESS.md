# 进度台账（路线图 vs 证据）

> 生成时间：2026-09-20T20:20:28+00:00　HEAD：`5a329f8a6d0c`　未提交文件：8
> 生成脚本：`scripts/roco/build-progress-dashboard.py`

- `DONE` 的意思是「有证据、且证据是可跑的」——每一行的证据路径都被本脚本检查过存在性。
- `NEEDS_HUMAN` 表示缺的是**用户本人**（实测数据 / 录屏 / 决策），不是还缺代码。
- `BLOCKED_BY_BOUNDARY` 表示它落在用户明说的硬边界里（不训练模型、不租 GPU）。
- 这份台账不判「质量好不好」，只判「证据在不在」。

## 汇总

- MVP 30 项中 `DONE`：**29 / 30**

| 状态 | 条数 |
|---|---:|
| `BLOCKED_BY_BOUNDARY` | 3 |
| `DONE` | 33 |
| `PARTIAL` | 1 |

## 逐项

| # | 任务 | 状态 | 证据 | 说明 |
|---|---|---|---|---|
| M01 | 记录当前基线 | `DONE` | `reports/roco/m0-baseline/`、`docs/roadmap/DSH-EXECUTION-STATE.md` | HEAD / 环境 / 基线测试逐项落盘；后续每轮都在同一个文件里续写。 |
| M02 | KEEP / ADAPT / RETIRE / MISSING 审计 | `DONE` | `docs/roco/M0-REPO-AUDIT.md` | 每个现有模块都有去向，含 5 条文档与运行态不一致。 |
| D01 | 建立数据来源清单 | `DONE` | `data/roco/sources.yaml`、`docs/roco/LICENSE-MATRIX.md` | 三个来源的 revision / sha256 / 许可 / 再分发等级。 |
| D02 | 冻结第一条规则域 | `DONE` | `data/roco/normalized/roco-world-s4-2026-09-10/` | `roco-world-s4-2026-09-10`，快照指纹进每个回执。 |
| D03 | 编写安全 importer | `DONE` | `scripts/roco/import-snapshot.mjs`、`scripts/roco/lua-safe-parse.mjs` | 第三方 Lua **只作文本解析、不执行**（有自检脚本）。 |
| D04 | 建立数据质量报告 | `DONE` | `data/roco/conflicts.jsonl`、`docs/roco/DATA-CONFLICTS.md` | 26 处差异全部分类，未解决 = 0。 |
| E01 | 编写首批 12 个机制案例 | `DONE` | `tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md` | 已扩到 **30** 条（W3-01 的目标是 30—50）。不能确认的字段写 unknown，不猜。 |
| E02 | 定义环境合同 | `DONE` | `roco/src/roco_env/env.py`、`roco/tests/test_replay_invariants.py` | reset/observe/legal_actions/step_joint/serialize/replay；「双方基于同一事前状态」由 history 里的 observation 哈希钉住。 |
| E03 | 实现已验证效果原语 | `PARTIAL` | `roco/src/roco_env/effects.py`、`docs/roco/MICROCASE-HARNESS.md`、`scripts/roco/record-measurements.py` | **这一项只完成了一半，必须说清楚**：引擎侧对每条待验机制都有明确行为并登记成假设（30 条里 26 条），未知机制一律 fail closed；但「已验证」那一半需要游戏内实测，当前 **0 条通过**。实测入口与标定管线已建好，文件是空的。 |
| E04 | 实现 joint-step 与确定性回放 | `DONE` | `roco/tests/test_replay_invariants.py` | 100 个固定 seed、每条重放两次逐事件一致；终止后再行动抛错。顺带修掉一个真 bug：`replay()` 不读记录里的 `loadouts`。 |
| E05 | 隐藏信息和不变量测试 | `DONE` | `roco/tests/test_replay_invariants.py`、`roco/tests/test_public_planner.py` | 120 局随机对局的不变量 + 60 局 observation 泄漏扫描（按字符串扫，不按字段读）。 |
| T01 | 实现本地规则服务 | `DONE` | `roco/src/roco_env/service.py`、`tests/evals/roco/bridge.test.js` | 六个端点：/health、/rules/query、/team/evaluate、/team/compare、/battle/plan，以及本地对局域的 /battle/new\|legal\|advance。每个回执都带 ruleset_id / state_version / coverage / evidence_ids / latency_ms / error_type；四类失败可区分。 |
| T02 | 接入 `coach/toolbox.js` | `DONE` | `src/coach/toolbox.js`、`tests/evals/roco/toolbox-roco.test.js` | 五个工具契约；路径/URL/代码/未声明参数在到达引擎之前被拒；状态变化后旧结果被丢弃。 |
| S01 | 实现五类对手策略 | `DONE` | `roco/src/roco_env/opponents.py`、`roco/tests/test_opponents.py` | 五条策略 + 只读观察代理（拿不到 state）+ 策略版本号。 |
| S02 | 跑 1,000 场 pilot | `DONE` | `roco/run_pilot.py`、`reports/roco/pilot-1000/` | 1000 局、非法动作 0、截断 0、异常 0；报告明写「这是环境自检，不是胜率」。 |
| G01 | 规则评分 baseline | `DONE` | `roco/src/roco_env/team.py`、`docs/roco/mvp/RULE-COVERAGE.md` | 六个分项特征（类型/角色/速度/伤害/能量/缺口），**不输出胜率**。 |
| G02 | 训练逻辑回归/LightGBM 候选 | `DONE` | `reports/roco/g02-team/G02-MODEL-2026-09-21-v2.md`、`reports/roco/g02-team/model.json` | **过门槛**：未见家族上 log loss 0.6517 vs 规则分 0.6905、Brier 0.2303 vs 0.2486、ECE 0.0335 ≤ 0.05，AUC 0.6588。没做 LightGBM 对照，理由写在报告 §7（同规模下只会更快过拟合）。 |
| G03 | 接入 `evaluate_team` | `DONE` | `roco/src/roco_env/team.py`、`tests/evals/roco/toolbox-roco.test.js` | 锁定伙伴后只返回满足约束的候选；解释含「改善什么 / 牺牲什么 / 适用哪个对手池」。 |
| G04 | 实现 2—3 回合联合动作搜索 | `DONE` | `roco/src/roco_env/planner.py`、`roco/tests/test_planner.py` | 可替换启发式，超时如实上报；**风险分支**（downside/top_risks/fragile）与**原始伤害范围**（damage_preview）都在这条路径上。 |
| G05 | 接入 `plan_actions` | `DONE` | `src/coach/toolbox.js`、`tests/evals/roco/toolbox-roco.test.js` | 桥只发公开 planner state；规划器未接入或搜索未完成时明确说出来。 |
| A01 | 更新 Agent system / tool contract | `DONE` | `src/coach/runtime.js`、`src/coach/toolbox.js`、`tests/evals/tool-arguments.test.js` | 工具参数按契约校验；证据包是事实依据；不编造数值。 |
| A02 | 打通三个真实场景 | `DONE` | `src/client/roco.js`、`scripts/roco/demo-acceptance.mjs` | 配队页 → evaluate_team / compare_team_change；对局中 → plan_actions；局后 → 教学入口。三个场景都在 `/roco.html` 上跑通。 |
| P01 | 重写 `should_intervene` 特征 | `DONE` | `src/coach/experience.js`、`src/coach/roco-experience.js`、`tests/roco-experience.test.js` | 四档动作 + 硬门控先于评分；阈值是产品参数而不是游戏机制。 |
| P02 | 事件回放验收 | `DONE` | `tests/evals/intervention-windows.json`、`tests/intervention.test.js` | 30 个窗口（15 该提示 / 15 不该）；P01 精度 1.0、过期 0；报告明写这是离线 fixture 而不是人体实验。 |
| C01 | 老师闭环 | `DONE` | `src/coach/teacher.js`、`tests/coach.test.js` | 每局默认只给一个关键决策；参数变化的相似题；不把一次答对写成掌握。 |
| C02 | 陪练闭环 | `DONE` | `src/coach/companion.js`、`tests/companion.test.js` | 六个场景；显式记忆（称呼/偏好/里程碑）与低置信的推测状态分开。 |
| C03 | 记忆控制 | `DONE` | `src/coach/memory.js`、`tests/companion.test.js` | 查看 / 纠正 / 逐条删除 / 全部清除，保留 source 与 timestamp。 |
| F01 | 无聊天入口完整演示 | `DONE` | `src/client/roco.html`、`scripts/roco/demo-acceptance.mjs`、`reports/roco/demo-acceptance/demo-acceptance.json` | 16/16 通过；六条场景（无聊天框、危险时短提示、该沉默就不说、换阵容撤旧建议、局末一个教学入口、抱怨时先接情绪）。 |
| F02 | 全链路回归 | `DONE` | `reports/roco/regression/F02-REGRESSION-2026-09-21.md` | 人读报告 + JSON + 18 份原始日志；P50/P95 实测；四条发现修掉三条、一条（test:smoke 不自举）如实留作已知问题。 |
| F03 | MVP 材料 | `DONE` | `docs/roco/mvp/ARCHITECTURE.md`、`docs/roco/mvp/DATA-CARD.md`、`docs/roco/mvp/RULE-COVERAGE.md`、`docs/roco/mvp/STATUS-LABELS.md`、`docs/roco/mvp/DEMO-SCRIPT.md` | 架构图 / 数据卡 / 规则覆盖表 / 实现状态标签 / 录屏脚本。**录屏本身没做**，需要用户本人。 |
| W3-01 | 扩到 12—20 只精灵、40—60 技能 | `DONE` | `roco/src/roco_env/traits.py`、`data/roco/engine-trait-status.json`、`docs/roco/PET-SUPPORT-MATRIX.md` | 12/12 精灵接入（FULL 6 / PARTIAL 2 / REFUSED 4）；microcase 21 → 30；技能池 30 → 55（新开 `candidate_extras`，规范配招不动）。 |
| W3-02 | 数据增量与阵容合法性 | `DONE` | `data/roco/lineup-legality.jsonl`、`docs/roco/LINEUP-LEGALITY.md` | 169 套逐条台账；结论是 **0 套可原样执行**（名册只 12 只、快照 622 只、140/169 来自 2026-04 早于 S4）。模拟池因此从自己的 12 只组出来。 |
| W3-03 | 生成 1 万场以上轨迹 | `DONE` | `scripts/roco/build-trajectories.py`、`reports/roco/trajectories/manifest.json` | 12,000 局 / 234,058 transition；家族**先切分后生成**、三侧互不相交。91MB jsonl 不入库，靠 manifest 里的种子复现。 |
| W3-04 | 升级工具（重训 evaluate_team / plan_actions 风险分支） | `DONE` | `roco/src/roco_env/team_model.py`、`roco/src/roco_env/planner.py`、`tests/roco-experience.test.js` | 模型分只在**显式声明对手池**时给，门槛不过不加载、特征顺序不符不加载、没有模型不编概率；风险分支与伤害范围都上了页面。两次升级都过了同一个端到端演示。 |
| W4 | Agent SFT 数据与本地训练 | `BLOCKED_BY_BOUNDARY` | — | 用户的硬边界：**不下载模型、不训练模型、不租云 GPU**。SFT 训练与 Qwen3-4B profiling 都落在里面。 |
| W5 | Model gateway / shadow replay / 主动介入模型 / 陪练盲评 | `BLOCKED_BY_BOUNDARY` | — | 训练类任务同 W4 的边界；**陪练盲评需要真人评分**，不属于边界但同样做不到。 |
| W6 | learned value / Battle PPO / LLM Agentic RL / 最终交付 | `BLOCKED_BY_BOUNDARY` | — | 全部依赖训练与真人数据，都落在「**不下载模型、不训练模型、不租云 GPU**」这条边界里；PPO / Agentic RL 属训练，最终交付依赖它们。 |

## 证据路径检查

所有 `DONE` 条目的证据路径都存在（本脚本在建表时逐个检查过）。

## 还没做完的，以及缺的是谁

- **E03 实现已验证效果原语**（`PARTIAL`）
  - **这一项只完成了一半，必须说清楚**：引擎侧对每条待验机制都有明确行为并登记成假设（30 条里 26 条），未知机制一律 fail closed；但「已验证」那一半需要游戏内实测，当前 **0 条通过**。实测入口与标定管线已建好，文件是空的。
  - **缺的是谁**：NEEDS_HUMAN：一次游戏内伤害实测（技能名 + 双方面板 + 属性关系 + 是否防御）
- **W4 Agent SFT 数据与本地训练**（`BLOCKED_BY_BOUNDARY`）
  - 用户的硬边界：**不下载模型、不训练模型、不租云 GPU**。SFT 训练与 Qwen3-4B profiling 都落在里面。
- **W5 Model gateway / shadow replay / 主动介入模型 / 陪练盲评**（`BLOCKED_BY_BOUNDARY`）
  - 训练类任务同 W4 的边界；**陪练盲评需要真人评分**，不属于边界但同样做不到。
- **W6 learned value / Battle PPO / LLM Agentic RL / 最终交付**（`BLOCKED_BY_BOUNDARY`）
  - 全部依赖训练与真人数据，都落在「**不下载模型、不训练模型、不租云 GPU**」这条边界里；PPO / Agentic RL 属训练，最终交付依赖它们。

## 需要用户的三件事（唯一阻塞）

1. **一条游戏内伤害实测**：技能名 + 双方精灵名 + 是否防御 + 实际伤害数字。
   有它就能把 E03 的「已验证」那一半推进，并标定 MC-008/010/011。
   录入：`python3 scripts/roco/record-measurements.py --interactive`
2. **录屏**（F03 的第二项）：脚本 `docs/roco/mvp/DEMO-SCRIPT.md` 已备好。
3. **是否解除「不训练模型」的边界**：解除才有 W4/W5/W6；不解除就只能停在这里。

