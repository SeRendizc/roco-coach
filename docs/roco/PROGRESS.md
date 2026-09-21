# 进度台账（路线图 vs 证据）

> 生成脚本：`scripts/roco/build-progress-dashboard.py`　（HEAD 与生成时间是易变字段，留在 `reports/roco/dashboard-run.json`）

- `DONE` 的意思是「有证据、且证据是可跑的」——每一行的证据路径都被本脚本检查过存在性。
- `NEEDS_HUMAN` 表示缺的是**用户本人**（实测数据 / 录屏 / 决策），不是还缺代码。
- `NEEDS_HARDWARE` 表示缺的是**特定硬件**，不是决策。目前**没有条目在用**它——W4-03/W4-04 曾经用它，理由是「本机不是 M5 Pro 48GB」，而那是读错了前提：本机就是 M5 Pro 48GB。
- `BLOCKED_BY_BOUNDARY` 只用于仍然有效的硬边界；旧的「不训练模型」在第 7 轮已被用户改写。
- 这份台账不判「质量好不好」，只判「证据在不在」。

## 汇总

- MVP 30 项中 `DONE`：**29 / 30**

| 状态 | 条数 |
|---|---:|
| `DONE` | 37 |
| `NEEDS_HUMAN` | 1 |
| `NOT_STARTED` | 4 |
| `PARTIAL` | 6 |

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
| C02 | 陪练闭环 | `DONE` | `src/coach/companion.js`、`tests/companion.test.js`、`docs/roco/COMPANION-NONINTRUSION.md`、`scripts/roco/verify-companion-nonintrusion.mjs`、`tests/evals/companion-nonintrusion.test.js` | 六个场景；显式记忆（称呼/偏好/里程碑）与低置信的推测状态分开。**不打扰验收（第 20 轮）**：预注册 P1—P7，在真实主动触发通道 `companionEvents` 上量 8 个固定种子的逐回合重放——该沉默 86 个窗口**沉默率 0.9884**、该说话 20 个窗口**开口率 1.0**、硬边界（PVP / 预制体验 / 刚被点掉 / 显式安静）**违反 0**、每局上限与去重**各 0 违规**、每条话都有真实素材且过克制扫描。**这不是真人验收**：机器判定通过 ≠ 玩家不烦，那一半是 W5-05。 |
| C03 | 记忆控制 | `DONE` | `src/coach/memory.js`、`tests/companion.test.js` | 查看 / 纠正 / 逐条删除 / 全部清除，保留 source 与 timestamp。 |
| F01 | 无聊天入口完整演示 | `DONE` | `src/client/roco.html`、`scripts/roco/demo-acceptance.mjs`、`reports/roco/demo-acceptance/demo-acceptance.json` | 16/16 通过；六条场景（无聊天框、危险时短提示、该沉默就不说、换阵容撤旧建议、局末一个教学入口、抱怨时先接情绪）。 |
| F02 | 全链路回归 | `DONE` | `reports/roco/regression/F02-REGRESSION-2026-09-21.md` | 人读报告 + JSON + 18 份原始日志；P50/P95 实测；四条发现修掉三条、一条（test:smoke 不自举）如实留作已知问题。 |
| F03 | MVP 材料 | `DONE` | `docs/roco/mvp/ARCHITECTURE.md`、`docs/roco/mvp/DATA-CARD.md`、`docs/roco/mvp/RULE-COVERAGE.md`、`docs/roco/mvp/STATUS-LABELS.md`、`docs/roco/mvp/DEMO-SCRIPT.md` | 架构图 / 数据卡 / 规则覆盖表 / 实现状态标签 / 录屏脚本。**录屏本身没做**，需要用户本人。 |
| W3-01 | 扩到 12—20 只精灵、40—60 技能 | `DONE` | `roco/src/roco_env/traits.py`、`data/roco/engine-trait-status.json`、`docs/roco/PET-SUPPORT-MATRIX.md` | 12/12 精灵接入（FULL 6 / PARTIAL 2 / REFUSED 4）；microcase 21 → 30；技能池 30 → 55（新开 `candidate_extras`，规范配招不动）。 |
| W3-02 | 数据增量与阵容合法性 | `DONE` | `data/roco/lineup-legality.jsonl`、`docs/roco/LINEUP-LEGALITY.md` | 169 套逐条台账；结论是 **0 套可原样执行**（名册只 12 只、快照 622 只、140/169 来自 2026-04 早于 S4）。模拟池因此从自己的 12 只组出来。 |
| W3-03 | 生成 1 万场以上轨迹 | `DONE` | `scripts/roco/build-trajectories.py`、`reports/roco/trajectories/manifest.json` | 12,000 局 / 234,058 transition；家族**先切分后生成**、三侧互不相交。91MB jsonl 不入库，靠 manifest 里的种子复现。 |
| W3-04 | 升级工具（重训 evaluate_team / plan_actions 风险分支） | `DONE` | `roco/src/roco_env/team_model.py`、`roco/src/roco_env/planner.py`、`tests/roco-experience.test.js` | 模型分只在**显式声明对手池**时给，门槛不过不加载、特征顺序不符不加载、没有模型不编概率；风险分支与伤害范围都上了页面。两次升级都过了同一个端到端演示。 |
| W4-01 | 固定 Agent 任务集 | `DONE` | `tests/evals/agent-tasks-v1.jsonl`、`scripts/roco/build-agent-tasks.py`、`scripts/roco/verify-agent-tasks.py`、`roco/tests/test_agent_tasks.py` | 288 条 / 8 类，按**家族、机制、表达模板**三重隔离切分；留出维度不进训练集，每类在 train/val/test 三侧都有样本。判定器自检两个方向都要对。 |
| W4-02 | 构造工具轨迹（原计划 2,000—5,000 条，实际按真实世界覆盖走） | `PARTIAL` | `tests/evals/agent-trajectories-v1.jsonl`、`scripts/roco/agent-trajectories.mjs`、`scripts/roco/build-agent-trajectories.mjs`、`scripts/roco/verify-agent-trajectories.mjs`、`docs/roco/AGENT-TRAJECTORIES.md` | 6,048 条 / 23 个世界 / 7 个 arm，**轨迹格式 + 判定器 + 离线回放**三件已完成，判定器两个方向都被测过（正向 864/864、反向 17,760 个变体全挂）；另有**生产者一致性**检查（生成器改了而产物没重建会判红）。条数超过当初估计的 5,000：第 37 轮修掉世界采样器之后每个任务真的能选到 2—9 个世界（那三个条件类目从 1 个变成 3 个），多出来的全是真实世界变体，不是灌水。缺的一半是**模型候选**：要 DeepSeek key，本机没有。 |
| W4-03 | Qwen3-4B profiling | `DONE` | `docs/roco/LOCAL-MODEL.md`、`scripts/model/local-gateway.mjs`、`scripts/model/healthcheck-mac.sh`、`reports/roco/local-model/bench.json`、`tests/evals/local-model.test.js` | 本机实测（MLX + Metal，Qwen3.5-4B-4bit）：首 token p50 **214.5 ms**、总延迟 p50 **~363 ms**、**29.8—32.9 tok/s**、推理峰值内存 **2.51 GB**、结构化输出合法 **8/8**。机器是 Apple M5 Pro / 15 核 / 48 GB，**就是路线图写的目标机器**（旧版本这里写「本机不是」，是读错了前提）。 |
| W4-04 | Qwen3-4B SFT | `PARTIAL` | `scripts/roco/build-agent-sft-data.mjs`、`scripts/roco/verify-sft-split.mjs`、`scripts/roco/build-agent-trajectories.mjs`、`docs/roco/W4-04-SFT-PREREGISTRATION.md`、`reports/roco/sft/dataset-report.json`、`reports/roco/sft/train.jsonl` | 数据/训练/评测闭环已跑通：1,752 条工具选择数据（train 1,395 / val 306 / test 51，**逐字节可复现**，由 `verify-sft-split.mjs` 在临时目录重跑后逐字节比对确认）、四轮 LoRA 微调、同一把 288 条尺子复测。**预注册判据 P1—P8 全部满足**（判据在跑之前写死在 `docs/roco/W4-04-SFT-PREREGISTRATION.md`）：v4 **275/288（0.9549）**，优于 v2 的 268/288；`roster_constraint` 8→**13/24**，`rules_lookup` 68→**70/72**，`invalid-arguments` 0，p50 435 ms / p95 1054 ms，family 外 0.9271；相对 v2 逐任务**退化 3、扳回 10**（那 3 条也如实写在报告里）。**未完成的是接入那一半**：适配器还没进默认链路（`ROCO_LOCAL_MODEL` 默认 `off`，`off` 下本地进程一次都不启动，有测试证明）——下一步是以 `shadow` 档接真实链路。 |
| W5-01 | Model gateway | `DONE` | `scripts/model/local-gateway.mjs`、`scripts/model/setup-mac.sh`、`scripts/model/start-mac.sh`、`scripts/model/stop-mac.sh`、`scripts/model/healthcheck-mac.sh`、`scripts/model/measure-arms.sh`、`docs/roco/LOCAL-MODEL.md`、`tests/evals/local-model.test.js` | OpenAI 兼容网关已落地并在跑：`/v1/chat/completions`、`/v1/models`、`/healthz`、`/metrics`；超时 504 / 忙 429 / 不可用 503、并发上限、取消、回退都有**一处**实现；一键 setup/start/healthcheck/stop，权重落在 gitignore 目录。第 37 轮修掉一个真缺陷：`stop` 原来找的 pid 文件名从来没被写过，所以「停网关」是个空操作——换适配器时会静默沿用旧权重。 |
| W4-05 | 同 Agent 回放门禁 | `PARTIAL` | `scripts/roco/shadow-replay.mjs`、`scripts/model/measure-arms.sh`、`docs/roco/SHADOW-REPLAY.md`、`docs/roco/W4-04-SFT-PREREGISTRATION.md`、`reports/roco/shadow-replay.json`、`reports/roco/shadow-replay-base.json`、`reports/roco/shadow-replay-sft-v4.json`、`tests/evals/shadow-replay.test.js`、`tests/evals/roco/model-arm-identity.test.js` | 门禁已建成并自证：同一任务集（288 条 / 8 类）、同一局面、同一判定器，只换 provider。规则臂 288/288；**五个 arm 在一条命令下重测完**（`scripts/model/measure-arms.sh`），每份产物都带适配器 sha256：基座 225/288（0.7813）、v1 229（0.7951）、v2 268（0.9306）、v3 204（0.7083）、**v4 275（0.9549）**。报告新增 family/机制/模板的**留出 vs 见过**切片（v4：family 外 0.9271）。第 38 轮查出并修掉**存档错位**：`-sft-v2.json` 里装的其实是 v1 的成绩、`-sft-v3.json` 里装的是 v2 的、真正的 v3 没有产物——旧存档已挪进 `reports/roco/invalidated/`，并加了「文件名 ↔ 适配器」守卫。缺的那一半仍是 DeepSeek 臂（要 key）。 |
| W5-02 | Shadow replay | `PARTIAL` | `scripts/roco/shadow-replay.mjs`、`docs/roco/SHADOW-REPLAY.md`、`tests/evals/shadow-replay.test.js` | 「把候选 provider 在**录制好的任务集**上重放、不与玩家交互地对比」已经可用：`npm run roco:shadow-replay -- --arm local_4b`。它只跑候选，不改玩家看到的任何东西。缺的是真实流量回放（要用线上录制的请求），目前重放的是构造任务集。 |
| W5-03 | 主动介入规则评分 | `DONE` | `src/coach/policy.js`、`src/coach/experience.js`、`tests/intervention.test.js` | 规则版已在链路里；W5-04 要做的是**替换它的一部分**，不是从零建。 |
| W5-04 | 主动介入成本敏感分类器 | `PARTIAL` | `docs/roco/W5-04-INTERVENTION-GATE.md`、`docs/roco/W5-04-INTERVENTION-GATE-V2.md`、`scripts/roco/build-roco-intervention-windows.py`、`scripts/roco/train-intervention-model.py`、`src/coach/intervention-model.js`、`tests/evals/intervention-layer.test.js` | 预注册 v2（H1—H8，误报上限改为**绝对值**）→ **手游引擎自己标定**的窗口集 2,544 条（seed family 切分 + family 外 OOD；边际量阈值 0.1465 只在训练侧估）→ 成本敏感分类器 → 只抑制的判定层 → 11 项守卫测试。**全部可判定判据通过**：H1 召回 0.900、H2 误报 0.0000、H3 ECE 0.0465、H4 在阈值 0.74 处 TPR 0.975/FPR 0.0162、H5 family 外 0.9097/0.0023。**判据有牙的证据**：对照臂（去掉边际量特征、与规则同信息）在同一套判据下挂掉 H1/H3/H4/H5。因此判定层获准进入 **shadow 可观测**（跑模型、记账、不改玩家看到的结果)；`on` 仍需真人审阅，尚未获准。 |
| W5-05 | 陪练盲评 | `NEEDS_HUMAN` | — | 这是外部阻塞，不是代码问题：没有真人评分就无法声称「陪练像不像人」。 |
| W6-01 | learned value | `NOT_STARTED` | — | 未开工；依赖 W4-02 的候选数据。 |
| W6-02 | Battle PPO | `NOT_STARTED` | — | 未开工；属训练，且需要 W4-04 的底座。 |
| W6-03 | LLM Agentic RL | `NOT_STARTED` | — | 未开工；属训练，依赖 W5-01 的 gateway。 |
| W6-04 | 最终交付 | `NOT_STARTED` | — | 未开工；依赖 W6-01—03。 |

## 证据路径检查

所有 `DONE` 条目的证据路径都存在（本脚本在建表时逐个检查过）。

## 还没做完的，以及缺的是谁

- **E03 实现已验证效果原语**（`PARTIAL`）
  - **这一项只完成了一半，必须说清楚**：引擎侧对每条待验机制都有明确行为并登记成假设（30 条里 26 条），未知机制一律 fail closed；但「已验证」那一半需要游戏内实测，当前 **0 条通过**。实测入口与标定管线已建好，文件是空的。
  - **缺的是谁**：NEEDS_HUMAN：一次游戏内伤害实测（技能名 + 双方面板 + 属性关系 + 是否防御）
- **W4-02 构造工具轨迹（原计划 2,000—5,000 条，实际按真实世界覆盖走）**（`PARTIAL`）
  - 6,048 条 / 23 个世界 / 7 个 arm，**轨迹格式 + 判定器 + 离线回放**三件已完成，判定器两个方向都被测过（正向 864/864、反向 17,760 个变体全挂）；另有**生产者一致性**检查（生成器改了而产物没重建会判红）。条数超过当初估计的 5,000：第 37 轮修掉世界采样器之后每个任务真的能选到 2—9 个世界（那三个条件类目从 1 个变成 3 个），多出来的全是真实世界变体，不是灌水。缺的一半是**模型候选**：要 DeepSeek key，本机没有。
- **W4-04 Qwen3-4B SFT**（`PARTIAL`）
  - 数据/训练/评测闭环已跑通：1,752 条工具选择数据（train 1,395 / val 306 / test 51，**逐字节可复现**，由 `verify-sft-split.mjs` 在临时目录重跑后逐字节比对确认）、四轮 LoRA 微调、同一把 288 条尺子复测。**预注册判据 P1—P8 全部满足**（判据在跑之前写死在 `docs/roco/W4-04-SFT-PREREGISTRATION.md`）：v4 **275/288（0.9549）**，优于 v2 的 268/288；`roster_constraint` 8→**13/24**，`rules_lookup` 68→**70/72**，`invalid-arguments` 0，p50 435 ms / p95 1054 ms，family 外 0.9271；相对 v2 逐任务**退化 3、扳回 10**（那 3 条也如实写在报告里）。**未完成的是接入那一半**：适配器还没进默认链路（`ROCO_LOCAL_MODEL` 默认 `off`，`off` 下本地进程一次都不启动，有测试证明）——下一步是以 `shadow` 档接真实链路。
- **W4-05 同 Agent 回放门禁**（`PARTIAL`）
  - 门禁已建成并自证：同一任务集（288 条 / 8 类）、同一局面、同一判定器，只换 provider。规则臂 288/288；**五个 arm 在一条命令下重测完**（`scripts/model/measure-arms.sh`），每份产物都带适配器 sha256：基座 225/288（0.7813）、v1 229（0.7951）、v2 268（0.9306）、v3 204（0.7083）、**v4 275（0.9549）**。报告新增 family/机制/模板的**留出 vs 见过**切片（v4：family 外 0.9271）。第 38 轮查出并修掉**存档错位**：`-sft-v2.json` 里装的其实是 v1 的成绩、`-sft-v3.json` 里装的是 v2 的、真正的 v3 没有产物——旧存档已挪进 `reports/roco/invalidated/`，并加了「文件名 ↔ 适配器」守卫。缺的那一半仍是 DeepSeek 臂（要 key）。
- **W5-02 Shadow replay**（`PARTIAL`）
  - 「把候选 provider 在**录制好的任务集**上重放、不与玩家交互地对比」已经可用：`npm run roco:shadow-replay -- --arm local_4b`。它只跑候选，不改玩家看到的任何东西。缺的是真实流量回放（要用线上录制的请求），目前重放的是构造任务集。
- **W5-04 主动介入成本敏感分类器**（`PARTIAL`）
  - 预注册 v2（H1—H8，误报上限改为**绝对值**）→ **手游引擎自己标定**的窗口集 2,544 条（seed family 切分 + family 外 OOD；边际量阈值 0.1465 只在训练侧估）→ 成本敏感分类器 → 只抑制的判定层 → 11 项守卫测试。**全部可判定判据通过**：H1 召回 0.900、H2 误报 0.0000、H3 ECE 0.0465、H4 在阈值 0.74 处 TPR 0.975/FPR 0.0162、H5 family 外 0.9097/0.0023。**判据有牙的证据**：对照臂（去掉边际量特征、与规则同信息）在同一套判据下挂掉 H1/H3/H4/H5。因此判定层获准进入 **shadow 可观测**（跑模型、记账、不改玩家看到的结果)；`on` 仍需真人审阅，尚未获准。
- **W5-05 陪练盲评**（`NEEDS_HUMAN`）
  - 这是外部阻塞，不是代码问题：没有真人评分就无法声称「陪练像不像人」。
  - **缺的是谁**：NEEDS_HUMAN：3—5 位真人玩家，对陪练回复做盲评打分（同一条回复随机标成不同来源）
- **W6-01 learned value**（`NOT_STARTED`）
  - 未开工；依赖 W4-02 的候选数据。
- **W6-02 Battle PPO**（`NOT_STARTED`）
  - 未开工；属训练，且需要 W4-04 的底座。
- **W6-03 LLM Agentic RL**（`NOT_STARTED`）
  - 未开工；属训练，依赖 W5-01 的 gateway。
- **W6-04 最终交付**（`NOT_STARTED`）
  - 未开工；依赖 W6-01—03。

## planner 的三个基准（结论见 `docs/roco/BENCHMARKS.md`）

| 命令 | 口径 | 量出来的结论 |
|---|---|---|
| `npm run roco:benchmark-planner` | 一步推演值当正确答案 | top1 0.27 → **0.59**（修掉候选裁剪之后）；**不能**比较搜索深度 |
| `npm run roco:benchmark-matches` | 整局胜负 | ⛔ **量具被判定为错，结论 INVALID / 不可解释**（80 对 40、且用区间重叠当差异检验）。修正后协议：两个座位样本数相等 + 配对检验。见 `docs/roco/BENCHMARKS.md` 第 2 节 |
| `npm run roco:planner-calibration` | `expected` 对整局胜负 | **不显著**（Welch t=0.873）→ `expected` **不能**当信心代理 |

最后一条（`planner-calibration`）是**否定结论**，也是最有行动价值的一个：它挡住了
「把 `expected` 当胜率展示给玩家」这条看起来顺理成章的用法。

## 需要用户的三件事（唯一阻塞）

1. **一条游戏内伤害实测**：技能名 + 双方精灵名 + 是否防御 + 实际伤害数字。
   有它就能把 E03 的「已验证」那一半推进，并标定 MC-008/010/011。
   录入：`python3 scripts/roco/record-measurements.py --interactive`
2. **录屏**（F03 的第二项）：脚本 `docs/roco/mvp/DEMO-SCRIPT.md` 已备好。
3. **一个 DeepSeek key**（或等价模型凭据）：W4-02 的「模型候选」那一半、W4-05 的三条 arm 对比、W5-01 的 gateway 都要它。没有 key 时其余独立项继续做。

