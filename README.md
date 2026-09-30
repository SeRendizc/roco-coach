# 小芽 · 宠物对战 AI Coach

一个宠物对战游戏，外加一个住在游戏里的 AI 教练。**引擎算事实，模型只负责说话。**

![营地](output/demo-live/01-营地.png)

小芽来自腾讯 IEG 的「基于 LLM 的智能 AI Coach」面试题：玩家在对局里做取舍时，教练要给出**有依据、可核对**的建议。

难点不在「接一个模型」，而在两件事同时成立——数字必须对，话必须像人话。所以链路被拆成两层：规则引擎负责合法动作、伤害、顺序与状态计时；模型只负责理解问题、按需查证、把算好的事实讲出来。

游戏、规则引擎、成长、页面、教练链路都在本仓库里，**零 npm 运行依赖**，`npm start` 就能玩；不接模型也有本地结论可看，接上模型后同一批事实改由模型表述。

仓库里有两条产品线：

| 线 | 是什么 | 页面 |
|---|---|---|
| **小兽训练场** | 自研宠物：营地 PVE 关卡、同屏本地对战、培养与阶段小测 | `/` |
| **《洛克王国：世界》训练场** | 手游数据层 + Python 规则引擎 + 六宠标准 PVP 与局面教练 | `/roco.html` |

## 核心特性

- **算与说分离**：伤害、克制、命中、胜负由引擎结算；模型正文里的数字与技能名必须能在证据包里找到，找不到就整句丢弃回退到本地结论（`src/coach/runtime.js` 的 `checkGroundedAnswer`）。
- **有界多步**：第一步由政策直接调工具，之后模型才能提议再查什么；工具回执数量有上限，超限即停。
- **该沉默就沉默**：开口与否按重要性、置信度、是否还来得及、打扰量判定；线上竞技模式（`pvp-live`）直接静音（`src/coach/policy.js`）。
- **过期结果整条丢弃**：局面版本一推进，迟到的模型回答不再采用，并记录原因（`stale_result_discarded`）。
- **三种角色**：军师（局中建议）、老师（复盘与阶段小测）、陪练（有情绪、有记忆）（`docs/COACH-PLAN.md` §1）。
- **情绪挂在读数上**：陪练可以说「可惜 / 漂亮 / 悬 / 憋屈 / 松口气」，但每种情绪都要绑定一条真实对局读数（`src/coach/companion.js`）。
- **记忆在本机**：偏好、教训、事件与条件提醒存在浏览器 localStorage；清空记忆不影响游戏成长。
- **数据可复算**：图鉴、技能、学习表、相性都带来源与 SHA256；第三方 Lua 只做文本解析，不执行。
- **零 npm 依赖**：`package.json` 里 `dependencies` 与 `devDependencies` 都是空的，不需要 `npm install`。

## 快速开始

需要 Node.js（判据用内置的 `node --test` 跑；本机在 v24.20.0 上实测）。仓库没有 npm 依赖，克隆后直接启动：

```sh
npm start            # → http://127.0.0.1:8765/
PORT=8899 npm start  # 换端口
```

| 路径 | 页面 |
|---|---|
| `/` | 营地：PVE 关卡、培养、同屏对战练习 |
| `/roco.html` | 《洛克王国：世界》训练场：选边选队、六宠标准 PVP、局中教练与局末复盘 |
| `/box.html` | 精灵盒子：全部精灵 / 我的盒子，逐只的性格、资质、天分与配招 |
| `/xiaoya.html` | 单独的小芽页面 |
| `/connect.html` | 加密录入 DeepSeek API Key（只留在服务进程内存，不落盘） |

**不接模型也能用**：建议、复盘、培养建议与小测由本地链路给出。想接模型，在 `/connect.html` 填入 Key；macOS 也可以用钥匙串启动：

```sh
./scripts/start.sh --save-key   # 存一次
./scripts/start.sh              # 以后直接启动
```

## 怎么用

1. **打一局营地 PVE**：打开 `/` → 「⚔ 训练 · PVE」→ 选关卡与队伍 → 局中看小芽的短提示，结束后看复盘。
2. **打一局标准 PVP**：打开 `/roco.html` → 选边与阵容 → 开局；行动面板给出合法动作与依据，结束后出「✦ 局末复盘」。
3. **直接问小芽**：点页面上的「✦ 小芽」入口或打开 `/xiaoya.html`；问题会连同相关游戏依据一起交给模型，回答受同一条证据校验约束。

## 项目结构

```
src/game/     规则引擎、对战结算、关卡内容、成长（纯 Node，零依赖）
src/coach/    教练链路：政策与门控、有界多步、工具合同、回答守卫、记忆、陪练、检索
src/server/   HTTP 服务与 API（默认 127.0.0.1:8765）
src/client/   页面（营地 / roco / box / xiaoya / connect）与样式
roco/         Python 规则引擎（roco/src/roco_env/）与它自己的判据（roco/tests/）
data/roco/    数据层：原始快照、归一化图鉴、抓包派生层、台账
scripts/      数据管线、离线评测、浏览器验收脚本
tests/        Node 判据（183 个 *.test.js，其中 146 个平铺在根上，其余在 tests/evals/）
docs/         设计与验收文档；手游那一档在 docs/roco/
knowledge/    知识卡与语义语料（由 npm run build:knowledge 生成）
reports/      实验与验收产物（JSON / Markdown / 日志）
output/       截图与 PDF 报告
```

## 文档索引

| 想知道什么 | 看哪 |
|---|---|
| 主链路 30 秒看懂（架构一页图） | `docs/ARCHITECTURE-ONE-PAGER.md` |
| 新文件该放哪、目录约定 | `docs/STRUCTURE.md` |
| 教练方案、三种角色、展示原则 | `docs/COACH-PLAN.md` |
| 证据、事件、任务状态与权限约定 | `docs/EVIDENCE-SCHEMA.md` |
| 实验与资源边界 | `docs/EXPERIMENTS.md` |
| 当前能力、运行版本与限制 | `docs/IMPLEMENTATION-STATUS.md` |
| 逐项完成状态与验收证据 | `docs/CHECKLIST.md` |
| 演示与验收脚本 | `docs/DEMO-ACCEPTANCE.md` |
| 讲述与追问准备 | `docs/INTERVIEW-GUIDE.md`、`docs/INTERVIEW-DRILL.md` |
| 手游数据层怎么分层 | `data/roco/README.md` |
| 数据来源、revision 与许可等级 | `data/roco/sources.yaml`、`docs/roco/LICENSE-MATRIX.md` |
| 进度台账（路线图 vs 证据） | `docs/roco/PROGRESS.md` |
| 逐轮执行台账 | `docs/roadmap/DSH-EXECUTION-STATE.md` |
| 判据怎么找、怎么加 | `tests/README.md` |
| 小芽「理想形态」计划书与实测记录 | `docs/roco/coach-理想形态-计划书-2026-09-30.md` |
| 实施与实验报告（PDF） | `output/pdf/xiaoya-coach-report.pdf` |
| 已完成的第一版说明 | `docs/RELEASE-v0.1.md` |

## 开发

```sh
npm run test:unit      # Node 判据（package.json 里的手写清单，171 个文件）
npm run test:browser   # 真实 Chrome 无头验收（脚本自己找本机 Chrome）
npm test               # 上面两条
npm run test:env       # Python 引擎判据：cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
npm run roco:status    # 只读现状：判据数、最近一次门禁、服务端口、工作区
npm run verify:release # 发版门禁（27 套，含浏览器验收与 Python 引擎）
```

数据管线（读 `data/roco/` 的原始快照，产出归一化与文档；`data/roco/raw/extracted/` 不入库，新克隆要先解压 `data/roco/raw/*.tar.gz`）：

```sh
npm run roco:pipeline    # 解析校验 → 交叉核验 → 导入 → 支持矩阵 → microcase → 文档
npm run test:roco        # 数据域验收
npm run roco:acceptance  # 真实浏览器验收（含截图）
```

离线实验（纯 Node，产物写在 `reports/`）：

```sh
npm run build:knowledge      # 从规则与知识卡生成可检索语料
npm run eval:retrieval       # 检索对照
npm run eval:balance:quick   # 单宠胜率对照
npm run eval:balance         # 平衡矩阵（大规模无头仿真）
npm run train:intervention   # Q-learning 学干预时机
```

可选依赖：语义检索与精确 token 计数需要 `.venv-agent/bin/python`（缺失时语义检索自动退回词项检索，不报错中断）；本地小模型实验另需 MLX 环境与权重（`scripts/model/`）。

## 边界

- **本地对战是同一台设备上的同屏对战，不是联网 PVP**；也还没有生产级权威对局与认证（`docs/CHECKLIST.md`）。
- **一回合搜索不是全局最优**：给出的是启发式局面评分，不是胜率。
- **不给胜率、不给伪精确百分数**：阵容与培养建议只讲结构与依据（`docs/roco/WORKSHOP.md`）。
- **浏览器语音暂停使用**：`src/client/app.js` 里 `VOICE_FEATURE = false`，只保留文字提示。
- **不是 DeepSeek 微调**：离线只训过一个二选一的工具路由头，线上用的是基座模型（`docs/CHECKLIST.md`）。
- 真人学习收益、生产模型权重训练与独立大样本评测尚未完成。

## 当前进度

- **游戏侧可用**（2026-09-30 实测）：`npm start` 后 `/`、`/roco.html`、`/box.html`、`/connect.html`、`/xiaoya.html` 都返回 200；营地 PVE、同屏对战、精灵盒子与阵容工坊都在。
- **数据层已冻结**：622 条图鉴、12 只基线精灵、530 只抓包精灵（目录名仍叫 `layer-playable-48`，"48" 是名字不是数量，合计 542 只）。
- **规则引擎侧在重建**：`roco/src/roco_env/service.py` 目前 import 不通（`coverage.py` 缺入口），所以引擎相关判据与发版门禁尚未全绿；最近一次登记的门禁结果是 2026-09-28 的 `unit` 未通过（`reports/roco/verification/latest.json`）。
- **还没做完**：真人学习收益、生产权威状态、生产模型权重训练。
- 已打过 tag 的完成版本是 `v0.1.0`；一条命令看现状用 `npm run roco:status`（只读）。

## 数据与出处

上游数据的来源、revision 与再分发等级记在 `data/roco/sources.yaml` 与 `docs/roco/LICENSE-MATRIX.md`；对战设计的灵感来源逐条记在知识卡的 `inspiration` 字段里（`knowledge/tactics.json`），外部资料调研见 `docs/LINGBAO-RESEARCH.md`。
