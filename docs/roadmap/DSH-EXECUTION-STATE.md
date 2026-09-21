# DSH 执行状态（断点续跑文件）

> 本文件是 DeepSeek Harness 接手本仓库时的**唯一断点状态**。
> 上下文压缩、进程重启或换 Agent 接手后，先读：
> `01-COLD-START-CONTEXT.md` → 本文件 → `git diff` → `reports/roco/m0-baseline/` 最近日志，
> 然后从下面「下一步」继续。**禁止重复已经验证过的工作。**
>
> 本文件不得写入 API key、完整模型响应或玩家隐私数据。

---

## 1. 当前目标与本轮范围

**产品目标**：把 `pet-game-coach` 从自创宠物对战 Demo 升级为《洛克王国：世界》**手游**内嵌主动 AI Coach「小芽 2.0」。

**本轮范围（严格执行，不多做）**：仅 **M0 + M1**。

| 编号 | 内容 | 状态 |
|---|---|---|
| M0-a | 固化当前仓库 / 测试 / 页面 / 性能基线 | 进行中 |
| M0-b | KEEP / ADAPT / RETIRE / MISSING 仓库审计 | 未开始 |
| M1-a | 版本化数据 schema、来源清单、许可状态 | 未开始 |
| M1-b | 导入 12 只手游精灵静态数据 | 未开始 |
| M1-c | 生成精灵支持矩阵 | 未开始 |
| M1-d | A 组 6 只候选配招（须有数据证据） | 未开始 |
| M1-e | 下一轮真实规则引擎 microcase 计划 | 未开始 |

**明确不在本轮做**：替换默认 UI、重写完整战斗引擎、下载/训练模型、租用云 GPU、安装任何 DSH 插件、
把规划和已实现混写、把页游数据混入手游规则域。

**验收方式**：每个完成项必须指向具体代码 / 数据文件 / 测试日志 / 浏览器证据；
未核验机制标 `unknown` / `unsupported`；测试通过不得替代数据真实性检查与真实页面验收。

---

## 1.45 第 45 轮交接断点（先读这一节，再读下文）

> 这一节是给「接手的人（或下一个我）」的**精确断点**：现在在哪、哪些文件还没提交、
> 最近一次全绿是什么、下一步做什么。上下文压缩后请从这一节继续。

### A. 现在在哪

| 项 | 值 |
|---|---|
| 已提交的 HEAD | 见下面 git log（本节写下时是 `22d2a4e`）——**所有代码与文档都已提交**，工作区里只剩运行产物 |
| 最近一次**全绿** gate | `9811f54`（**已过期**）。第 45 轮把 `state-doc` 的第二处自指死锁拆掉了（「全绿记录落后 >12 个提交」从硬失败改成警告），所以现在**可以**跑出一次新的全绿来刷新它 |
| 闸门现状 | 14 个套件里 13 个稳定绿。`unit` 在**有重活并行时**会偶发红（Python 后端的用例在 CPU 争抢下超时）——跑 gate 前先确认没有别的重任务在跑 |
| 未提交（运行产物，不是代码） | `reports/roco/demo-acceptance/coach-kind-coverage-scan.json`（后台 `bash-59` 正在跑全量 2640 局扫描，落盘后**必须一起提交**：矩阵产物要与它对账）、`reports/roco/verification/latest.json`、`reports/roco/acceptance/browser-acceptance.json`、`reports/roco/demo-acceptance/coach-positions-browser.json`（由最近一次运行重写） |
| 页面实测（最近一次） | `npm run roco:demo-acceptance` **75 通过 / 0 失败**（含 12 个真实局面的矩阵、真实鼠标/键盘交互） |

### B. 第 45 轮已完成（都有定向用例 + 反证）

1. 陪练三缺陷（情绪话换来战报 / 情绪与拒绝被复盘路由截走 / 静默偏好到不了聊天链路）。
2. 老师（老师=局末复盘）：从「一句话模板」改成按**可教性**选课（30 局实测：
   同一门课 30/30、其中 43% 是表扬 → 17/13 两门、表扬 0/30）；复盘接进页面；
   挂账回合改用**局面回合**；`git add -A` 误收的那一份用**原字节反证**钉死。
3. 浏览器局面矩阵：12 局面 / 11 开口 / 8 种 kind / 9 种形状 / DOM 与 Node 重算逐字一致。
4. P1-1 形象（自制 emoji 徽记 + 伤害浮层）、P1-2 开局引导、P1-4 手机可读性首版、
   P1-5 性能四条全测（首屏 154 ms / render p50 0.1 ms / 零外链 / 25 步堆 +0.48 MB）。
5. 记忆可见可纠正（「她记住了什么」+ 逐条忘掉）。
6. 阵容选择 UX hotfix（点不动的卡有状态与可执行提示、切侧可见、键鼠真实事件验收）。
7. 拆掉 `state-doc` 的第二处自指死锁。

### C. 下一步（监工最新指示，按优先级）

**C1 覆盖与规模（最高优先，先设计/审计再写实现）**
- 目标：**48 只**手游真实精灵全部在 Demo 里可浏览、可选择、可组成任意合法 3v3、
  可完整打一局、可被阵容评估/局内规划/局后复盘使用（可分页/筛选，不要挤在一屏）。
- 分层覆盖与**每层都要给 coverage/refused 原因**：全量图鉴检索层（622 只知识库）／
  ≥60 只的阵容评估与候选生成层／≥24 只的可模拟核心池／48 只进 Demo。
  **不许**把其余降成只读知识库来冒充完成。
- 每只 4 个**有证据**的可用技能；任何 48 只组合都走合法性检查。
- 先产出：48 只候选名单 + 每字段 provenance/版本 + 独特技能数/原语覆盖 +
  预计 unsupported 清单 + 实现批次。无法确认的机制 **fail closed** 并列入待实测，
  禁止近似成普通伤害；手游资料里没有的机制（举例里的天气/场地等）**禁止自行设计**。
- 解释并修正文档冲突：`PET-SUPPORT-MATRIX` 写 12 只全 `KNOWLEDGE_ONLY`，
  而 `PROGRESS` 写 FULL 6 / PARTIAL 2 / REFUSED 4——必须分别说明是**技能效果覆盖**、
  **特性覆盖**还是**Demo 替代规则**，不能混称「可模拟」。

**C2 大负载模拟基准（不把 400 只塞进一场战斗）**
- 离线阵容空间：按角色/属性/meta 先检索 Top-K，再组合评估；**禁止** C(400,3) 暴力枚举。
- 在线 3v3：只用双方已知 6 只 + 合法技能/换宠；beam/depth/timeout 继续；量 P50/P95 与超时覆盖。
- 隐藏阵容：belief/opponent pool 采样，planner **不许**读未知信息。
- 环境要素：只做**有手游证据**的机制，做机制交叉与 OOD 切分；没有证据的不做。
- 压测矩阵：≥100/250/400+ 可检索精灵、24/48/60+ 可模拟精灵、5 类对手策略、≥10000 局；
  报告吞吐、P50/P95、超时率、unsupported 率、推荐稳定性。

**C3 混合规划链（四臂对照）**
LLM 只提战略意图/候选动作/对手假设 → legal mask 过滤 → 引擎做真实转移 →
learned value 评叶节点 → beam/MCTS 比长期分支 → LLM 依回执解释。
评测 `rule-only` / `LLM-only`（负对照）/ `engine+value` / `LLM-prior+engine+value`，
报告正确性、非法率、延迟、长期回报。

**C4 训练教学（用户亲自执行）**
不要替用户训 Qwen3.8-27B。只准备可复现的**引导脚本 + 教学文档**：下载/基准/构造数据/
LoRA/评测每一步都由用户执行，程序只检查并解释。**现有 4B v4 保持不动**（它只代表
工具路由训练完成，不等于战斗策略模型/价值模型/27B 完成）。独立目录、检查点、逐步说明。

**C5 3060 Laptop**
预留给 PyTorch/CUDA 的 learned value、policy prior、PPO/离线 RL 与批量仿真。
先记录显存/内存/系统信息；**不要**把 Mac 与 3060 显存拼接，也不要强塞 27B。
Mac 负责 27B 量化推理/教学式 LoRA 与产品 Demo；两机靠版本化数据、checkpoint、评测报告协作。

**C6 界面（监工明确不满）**
「我之前给你留的 UI 框架你是一点不打算用吗？全部重新搭建啊？」——`src/client/roco.html`
现在自带一套 `roco.css`，与营地页的 `src/client/style.css` 是两套视觉。
下一轮按 P1-1/P1-4 做**玩家界面重排**：复用既有设计系统（配色/字体/组件/间距 token），
把「验收台」的观感换掉；先做一屏 mockup 截图给监工看过再铺开。

### C6.5 第 45 轮下半场新增完成项（接在 C1—C6 之后）

| 项 | 状态 | 证据 |
|---|---|---|
| **C4 用户亲训 27B 的引导**（`e851284`） | ✅ 交付 | `scripts/train/` 三个引导脚本 + 共享底座 + 夹具库；`docs/roco/QWEN-27B-USER-RUN-GUIDE.md`、`TRAINING-ROADMAP-4B-27B-VALUE.md`；`test --selftest` 共 **51 条断言全绿**（14/14 + 21/21 + 16/16），每套含必红反证；「脚本不能自己动手」是**可执行判据**（源码扫子进程/联网/写文件 API 即抛错）。**没有下载、没有训练、没有连 3060、4B v4 未动**。用户第一步：`npm run train:prereqs`（会给出 `must-measure`，不是 ready） |
| **C6 界面改用你留的框架**（`6581ae1`） | 🟡 第一步完成 | `roco.html` 现在先加载 `src/client/style.css`，`roco.css` 只留本页差异；伙伴卡/后备/阵容卡/两侧面板改用框架组件（`.pet-icon/.hp-track/.energy/.pet-option/.bench-pet/.combatant/.arena`）；**验收脚本依赖的类名一个没动**。从截图里看出并修掉 4 件（中间列文字竖排、误删 `.chip`、结算结果显示英文 `win`、窄卡折行与六维被裁）。`demo-acceptance` **75 通过 / 0 失败**。**仍缺**：整页信息层级与「像游戏而不是验收台」的进一步重排（下一轮先出 mockup 给监工看） |
| 全量 kind 覆盖扫描（2640 局） | ⏳ 后台在跑 | 产物 `reports/roco/demo-acceptance/coach-kind-coverage-scan.json`（当前盘上还是 330 局的抽样版本，落盘后要提交并与矩阵对账） |
| **批 0（子 agent `6c5a0d07`，进行中）** | ⏳ | 四件：① 修引擎两处 fail-closed 违规（先写必红用例再修，禁止把 unsupported 近似成普通伤害）；② **L1 全量图鉴导入**（622 只、独立只读层、逐字段 provenance、refused 原因码）；③ 48 只配招落库 + `/api/roco/roster` 扩到 48（分页/筛选、旧形状兼容、不许改界面样式）；④ 修 3 处会覆盖文档修正的过时句并重跑 `roco:docs`。**它报告前不要提交它新增的路径** |
| **C1 48 只覆盖与规模**（`7ff1705`） | ✅ 审计/设计交付 | 三份文档说的是三件事：`PET-SUPPORT-MATRIX` 的「12 只全 KNOWLEDGE_ONLY」=**支持等级**（microcase 通过 0，属实），`PROGRESS` 的 FULL6/PARTIAL2/REFUSED4=**特性覆盖**（同值，属实）；**写错的是 `PET-SUPPORT-MATRIX` 原第 32 行「本轮没有实现任何效果原语」**（同文件 §2 自己写着「引擎侧 ✅ FULL」）。已改文档并补「引擎侧特性状态」列；**同源过时句仍有 3 处**（`build-support-matrix-doc.mjs:56`、`build-support-matrix.mjs:8,199,345`），不改的话 `roco:docs` 会把修正覆盖回去。48 只名单：独特技能 **76**、属性 18/18、角色 5 类齐、速度五档齐、硬机制 8/8、**fail closed 9/76（命中 22/48）**；实测 **C(48,3)=17,296 全合法、1000/1000 完赛**（p50 13 ms/p95 29 ms）。四层：L1 622 **未交付**（`normalized/pets.json` 只有 12 只）／L2 60/60／L3 26/48、29/60／L4 可玩性过、**UI 未做**。**两个实测缺陷未修**：攻击分支丢弃附带效果、防御分支丢弃「应对成功」子句且都不登记（违反 fail-closed），落点 `env.py:535-592`、`env.py:510-524` |



| 子 agent | 任务要点 | 交付物（约定） | 边界 |
|---|---|---|---|
| 48 只覆盖与规模（只设计/审计） | ① 逐条查清并**修正** `PET-SUPPORT-MATRIX`(12 只全 KNOWLEDGE_ONLY) 与 `PROGRESS`(FULL 6/PARTIAL 2/REFUSED 4) 的冲突，分别说明技能效果覆盖／特性覆盖／Demo 替代规则；② 四层覆盖（622 图鉴检索 / ≥60 评估 / ≥24 可模拟 / **48 进 Demo，全部可浏览可选择可组任意合法 3v3 可打完可进评估·规划·复盘**）每层的进入条件与 refused 原因分类；③ **48 只候选名单**（真名/属性/面板/4 个有证据技能/特性/入选理由 + 独特技能数 + 原语覆盖 + unsupported 清单 + 3—4 个实现批次）；④ 压测与四臂规划链的**设计**（离线 Top-K 检索再组合、禁止 C(400,3)；在线只用已知 6 只；隐藏阵容走 belief 采样；环境机制只做有手游证据的） | 新文档 + `reports/roco/` 下的机器可读名单表 | 不改 `src/**`、`roco/src/**`；不实现，只设计；未核验机制 fail closed；手游没有的机制禁止自行设计 |
| 用户亲训 27B 的引导（只检查与解释） | 逐步骤教学文档（环境前置检查→下载→基准→构造数据→LoRA→评测→记录回滚）；`scripts/train/` 下的引导脚本（**离线、只检查状态、只打印该敲什么**，带 `--selftest` 与必红反证）；`docs/roco/TRAINING-ROADMAP-4B-27B-VALUE.md`（4B v4=工具路由已完成 ≠ 战斗策略；27B 用户亲训；learned value/policy prior 留给 3060） | 上述三类文件 + `package.json` 的 `train:*` 脚本 | **不下载、不训练**；4B v4 产物一动不动；不连 3060；不改依赖段 |

两个 agent 都在后台跑（各自会报告）。它们完成前**不要**跑 `npm run verify:release`：
`guard-selftest` 会临时改写仓库文件，而 `unit` 在重活并行时会假红。

### D. 交接纪律（这一轮踩过、不要再踩）

- **不要 `git add -A`**：子 agent 正在写的文件会被误收（`ff81037` 就是这么把
  `teacher-review.js` 的中间版本收进去的，那一份真的会把战绩安到另一只伙伴头上）。
  提交时**逐路径列出**。
- **重活不要并行**：全量扫描/浏览器验收与 `npm run test:unit` 同时跑，Python 后端的
  用例会超时假红；`guard-selftest` 会临时改写仓库文件，更要串行。
- 判据自己也会撒谎：性能脚本按文件名排除把 15 个同源模块报成外链；
  点击派发到视口外/被固定浮层盖住时**不报错**，只表现为「点了没反应」。

## 1.5 后续轮次（M0/M1 之后，同一会话继续）

M0/M1 完成后，用户要求「不定格在 M2，目标定高、一直做」。因此本文件继续作为断点记录，
范围扩到旗舰线的可独立完成部分（不需要真人实验、官方一手数据、云 GPU 的那些）。

已完成的后续工作：

| # | 工作 | 证据 |
|---|---|---|
| 1 | 文件结构整理：顶层 38 → 3 个文件；`src/{game,coach,server,client}`、`tests/`、`tools/` | `docs/STRUCTURE.md`、`tests/evals/structure-contract.test.js` |
| 2 | 结构守卫：6 项契约测试，含「顶层只允许约定条目」并反向验证过会红 | 同上 |
| 3 | **规则引擎 `roco_env` 建成**：完整 3v3、确定性回放、隐藏信息边界、fail closed | `roco/tests/test_microcases.py`（38/38 通过） |
| 4 | **关键数据发现**：站点快照的 `stats` 是**种族值**而非面板值；从社区快照 452 条记录反推出换算（hp/atk/def 零误差） | `roco/src/roco_env/data.py` 的 `PANEL_FORMULAS` |
| 5 | 伤害公式作为**可替换假设**落地（带来源/许可/未核验标记），不冒充官方 | `roco/src/roco_env/effects.py` |

**尚未核验、因而引擎 fail closed 的机制**（每条都有对应 microcase）：
能量上限与回能时机、同速裁决、印记叠加替换、传动、天气、连击数、
属性增减层数语义、12 只精灵的特性效果、状态类技能的具体效果原语。

## 1.6 第 1 轮 goal（30 项 MVP）——隐私边界修正与四条支线

**本轮最重要的一次纠偏（监工指出，我原判断错误）**：我曾给 `state.seed` 开了
「只允许 state 下一层」的例外，放行真实对局 seed。那是**错的方向**：
真实 seed 能预测同速裁决与后续伤害的随机结果，它就是隐藏信息；
toolbox 的 `plan_actions` 合同也明确禁止真实随机种子——开后门会让
客户端与服务端契约互相矛盾。已修正：

| 项 | 修正 |
|---|---|
| seed 例外 | **彻底移除**。任何深度、任何位置的 `seed`/`rng_seed`/`random_seed` 都被拒 |
| `_pending_enemy` 等内部字段 | 补进 HIDDEN_KEYS（归一化后比较），现已拦截 |
| `/battle/plan` 输入 | 改为**公开 planner state**（`env.public_planner_state`），不再接受 `env.serialize()` 私有状态 |
| 随机性 | 用与真实对局无关的 `DEFAULT_ANALYSIS_SEEDS=(11,29,47)`，并**跨种子聚合**给区间而非单点 |
| 反证测试 | 新增 `roco/tests/test_public_planner.py`（12 项）：同公开观察+不同真实 seed → 请求与推荐必须一致 |

**另一处真 bug（本轮修）**：`observation_for` 之前**连对手场上那只**都不给
`hp/max_hp/energy`——那不是安全取舍，是真漏：对手场上的血条与能量本来就画在屏幕上，
看不到反而无法判断「这一击够不够收」。现在场上给面板、**后备仍隐藏**（血量/配能/配招）。

**四条支线（子 agent）已交付**：

| 支线 | 任务 | 交付 |
|---|---|---|
| ① 对手池+先导 | S01/S02 | `opponents.py`（五策略，隐藏信息只读代理）+ `run_pilot.py`；**1000 局 49.3 局/秒，非法动作 0、截断 0、异常 0** |
| ② coach 工具接入 | T02/G03 | `toolbox.js` 五个新工具契约 + 陈旧状态拒绝 + `toolbox-roco.test.js` |
| ③ 老师陪练记忆 | C01/C02/C03 | `memory.js` 显式偏好层/低置信心情/记忆控制；`teacher.js`；`companion.js` 六场景 |
| ④ 主动介入 | P01/P02 | 四档动作 `silent/micro_hint/action_hint/defer_to_review` + 硬门控先于评分；30 窗口评测（precision 1.0、stale 0） |

**我这一轮自己做的**：planner（G04）`roco/src/roco_env/planner.py` +
`/battle/plan` 接上服务；隐藏信息边界收紧；`observation_for` 修复。

### 本轮结束时的测试现状（全部绿）

| 套件 | 结果 |
|---|---|
| Node 全量（unit + browser） | **421 + 18，0 失败** |
| Python（引擎 + 对局域 + 公开 schema + 增伤接线） | **141 / 141**（1 项按守卫 skip） |
| Node↔Python 桥契约 | **11 / 11** |
| coach 工具层（toolbox-roco） | **17 / 17** |
| 规划端到端（plan-e2e，真 Python 服务） | **8 / 8** |
| 结构契约（含多页面白名单） | **8 / 8** |
| 投影层（roco-experience） | **9 / 9** |
| **合计** | **610 项，0 失败**（browser 1 项按测试自身的前置守卫跳过） |

另有两项**浏览器真机验收**（起真 Chrome、真 Python 引擎）：
`npm run roco:acceptance`（营地页 9/9）与 `npm run roco:demo-acceptance`（演示页 16/16）。

一条命令跑全部服务侧：`npm run test:roco-all`
（= `test:env` + `test:bridge` + `test:toolbox-roco` + `test:plan-e2e`）。

陪练支线那 3 条红已由该支线修好（都是它自己新加的场景测试里的 `undefined.some`
TypeError），**没有放宽任何既有断言**。

### 本轮收尾时补上的两处（监工纠偏的落地）

**① 两层隐藏信息边界曾经漏了一层（真漏洞，已修）。**
桥的 `HIDDEN_KEYS` 只有 13 个键，缺 `pendingenemy` / `pendingplayer` /
`pendingenemyaction` / `pendingplayeraction` / `replacequeue`。而
`env.serialize()` 里对手待执行动作的真实键名就是 `_pending_enemy`
（归一化 `pendingenemy`）——也就是说**私有状态能从桥本地穿过去**，
只剩 Python 服务端兜底。MC-013 要求两层都拦，桥是第一层，这个缺口必须补。

现在三份词汇表一一对应：Python `service.HIDDEN_KEYS`、Node 桥
`roco-client.HIDDEN_KEYS`、浏览器工具层镜像 `toolbox.ROCO_HIDDEN_KEYS`。
并且新增了**跨文件比对测试**（`plan-e2e.test.js` 最后一条）：直接读三个源文件
比对集合，任何一侧改单边都会变红——不靠注释约定。

**② 真链路能出计划这件事，此前没有任何测试证明。**
`bridge.test.js` 只证明了「缺 public 会被拒」；`toolbox-roco.test.js` 用的是假客户端。
两边都绿而真实链路对不上是完全可能的（T02 阶段就是这样：桥发 state、服务要 public）。
新增 `tests/evals/roco/plan-e2e.test.js`：

- 公开 planner state 由 **Python 引擎现场生成**
  （`scripts/roco/gen-plan-state.py`），不是测试里手抄的 fixture ——
  手抄的 fixture 会随引擎改动悄悄过期；
- 端到端：`toolbox → roco-client → HTTP → 真 Python 服务` 确实产出了计划
  （`planAvailable=true`、`search.completed=true`、推荐非空、有最坏尾部区间）；
- 反证：私有 `serialize()` 两层都被拒（客户端本地 + 绕过守卫的 raw POST）；
- 反证：`state.seed` / `state.foo.seed` / `state.history[0].seed` /
  对手待执行动作 / `rng_seed` 别名在客户端就拦下，用**记账 HTTP 端点**证明
  请求数为 0，并配一条「干净状态确实发得出请求」的对照组
  （没有对照组的话，「0 个请求」也可能只是端点根本打不通）；
- 反证：两个不同真实内部 seed（7 / 12345）的公开面逐字节一致、规划结论一致，
  且桥实际发出的请求体里连真实 seed 的**取值**都不出现；
  再加一条「真实 seed 恰好等于某个 analysis seed 时结论不变」。

同时把 `toolbox-roco.test.js` 里那条断言「已删除的补发兜底」的过时测试，
换成断言**直连契约**：一次调用、桥独占 `public` 键、私有传输层
（`_request` / `_payload`）不可达。

### 已知未完成（如实记录）

- **G02（阵容模型）**：**过了自己的门槛**（第二版）。
  第一版（6 只名册 / 360 家族 / 2,160 行）判定不过，结论是「扩阵容池而不是换模型」；
  第二版照做（12 只 / 3,960 家族 / 23,760 行）：
  log loss 0.6517 vs 规则分 0.6905 ✓、Brier 0.2303 vs 0.2486 ✓、**ECE 0.0335 ✓**，
  AUC 0.6588（规则分 0.5345）。两版报告都留着：`G02-MODEL-2026-09-21-v1.md`（不过）、
  `G02-MODEL-2026-09-21-v2.md`（过）。
  **接入 `evaluate_team` 仍待做（W3-04）**：只有「显式声明对手池」的用法被允许，
  默认行为不变，且不得向玩家做强度排序。标签是打 5 条启发式策略的结果，不是真人。
- `summarize_battle` 仍无服务端点，返回结构化 `not_implemented`（**现在回 501**，
  不再混进 404），**不编摘要**。
- microcase 的「12/12 通过」仍**做不到**：需要游戏内实测。
- **`npm run test:smoke` 不自举**：它要求 8765 上已有服务，否则退出码 2。
  M0/M1 遗留的冒烟脚本，属于独立工作量（未改）。
- 录屏（F03 里那一项）**需要人来做**：脚本已备好（`docs/roco/mvp/DEMO-SCRIPT.md`，
  2 分 30 秒，逐段写清「点什么、屏幕上出现什么、说哪句」）。

### W3-01（扩域）与监工复核（本轮）

**已做的**：12 只精灵全部接入特性系统（FULL 6 / PARTIAL 2 / REFUSED 4），
B/C 组 3v3 实战跑通；`parse` 覆盖率语义修正；G02 判定为不过门槛。

**监工复核后必须分清的两类问题**（这一区分写进代码注释、测试名与断点文件）：

| 类别 | 内容 | 状态 |
|---|---|---|
| **程序接线 / 生命周期 bug**（已证实，可用引擎不变量断言） | buff 写入后伤害入口硬编码 1.0；`_defense_reduction` 跨回合残留；`replay` 丢 `loadouts`；`reset` 只按我方校验配招 | **已修**，每一条都有会变红的测试 |
| **真实手游语义**（未证实，无一手来源） | `+100%` 是否恰为 ×2；攻防增减相加还是相乘；减伤比例与结算时机 | **仍是假设**，属 `COMMUNITY_HYPOTHESIS_V1`（MC-010/011/020），事件带 `formula_verified: false` |

折算逻辑收敛到唯一一处 `roco_env/effects.py::buff_damage_multiplier`，
面板值一律用未加成原始面板（两边同时乘会把增益精确抵消——这条有反例测试）。
测试分两组：**强断言**只用于程序不变量（零 buff 基线不变、单调、只生效一次、
下一回合清零、replay 两次一致、缺配招回放抛错）；
**与社区模型对齐**的那条在名字里写明它验证的是「模型被正确实现」，
不是「手游就是这么算的」。

### W3（旗舰版第一周）进度

| 任务 | 状态 | 证据 |
|---|---|---|
| **W3-01 扩到 12—20 只精灵、40—60 技能** | **完成** | 精灵 **12/12 接入引擎**（`roco/src/roco_env/traits.py`：FULL 6 / PARTIAL 2 / REFUSED 4）；microcase **21 → 30**；技能池 **30 → 55**（新增 `candidate_extras` 一栏，3 个/只，规范化配招**不动** —— 动它会作废 G02 已跑的 23,760 行）。55 个里解析层完全支持 **29**（其中 13 个纯伤害走 damage 路径），覆盖 52.7% |
| **W3-02 数据增量与阵容合法性** | **完成** | 169 套社区阵容逐条台账：`data/roco/lineup-legality.jsonl` + `docs/roco/LINEUP-LEGALITY.md`。结论：**0 套可原样执行**（名册只有 12 只，快照里 622 只；169 套里 140 套来自 2026-04，早于 S4）。模拟池因此**不是**从这 169 套里选的，而是从自己的 12 只组出来的 `C(12,3)=220` |
| **W3-03 生成 1 万场以上轨迹** | **完成** | `scripts/roco/build-trajectories.py` + `npm run roco:trajectories`：**12,000 局 / 234,058 条 transition**（目标 10 万级），115 秒、104 局/秒、截断 0、异常 0。家族**先切分后生成**：train 7,156 / val 2,394 / test 2,386 个家族，**三侧互不相交（已验）**。只写公开观察哈希，不含 `hp`/`max_hp`/`pending`/`replace_queue`（已验）。jsonl 共约 91MB **不入库**，入库的只有 `reports/roco/trajectories/manifest.json`（含种子与复现命令） |
| **W3-04 升级工具** | **完成** | ① `evaluate_team` 可叠一层**过门槛**的模型分（`roco/src/roco_env/team_model.py` + `opponent_pool`/`opponent_team`）；三条约束写在加载路径上：门槛不过**不加载**、特征顺序不符**不加载**、没有模型时**不编概率**。② `plan_actions` 新增**风险分支**：`risk.downside`（期望到最坏的距离）、`top_risks`（最差前三个对手动作）、`fragile`（超过产品阈值 `FRAGILE_DOWNSIDE=1.2`），页面据此把措辞从「可以优先考虑」降级为「这一手不稳」。两条都过了同一个端到端演示（demo-acceptance 16/16、browser-acceptance 9/9） |
| W4 / W5 / W6 | 未开始 | 依赖真人数据或本地模型训练，用户已明确不做（不下载/不训练模型） |

**W3-01 的扩法要说清**：技能池从 30 扩到 55，靠的是**新开一栏** `candidate_extras`
（每只再挑 3 个「机制覆盖最广」的技能），而不是把 `candidate_moveset.skills`
从 4 个改成 6 个。理由是后者会改变 G02 的家族定义（family key 含配招），
等于把已经跑过的 23,760 行数据作废 —— 扩域不该顺手作废既有结论。

`candidate_extras` 只按「未覆盖机制数 → 固有优先 → 威力 → 能耗 → 名字」排序，
**不是**推荐配招、不是最优解；报告与 JSON 里都这么写。
本轮的精灵数与技能数已满足 W3-01（12 只 / 55 技能，目标 12—20 / 40—60）。

### 本轮（第 4 轮）新增

| 交付 | 文件 | 结果 |
|---|---|---|
| microcase 执行台账 | `docs/roco/MICROCASE-HARNESS.md` + `reports/roco/microcases/harness.json` | 30 条里 **26 条**引擎有明确行为、**4 条**连前提都缺；`verification_passed` 恒为 false |
| 实测录入 | `scripts/roco/record-measurements.py` → `data/roco/measurements.jsonl` | 文件**为空**：仓库里不存在任何伪造实测；演练数据（`source != manual`）不升级状态 |
| 实测标定 | `docs/roco/CALIBRATION.md` + `reports/roco/microcases/calibration.json` | 容差**必须由人给**；标定只反解系数、不自动改公式 |
| E04/E05 验收不变量 | `roco/tests/test_replay_invariants.py` | 100 条回放逐事件一致、终止后不可行动、随机对局无非法状态、observation 零泄漏 |
| 伤害范围预览 | `/battle/plan` 的 `damage_preview` | 配招里每个攻击技能各试打一遍取 min/max；页面显示「按未核验公式估，能打出 130~425」 |
| 进度台账 | `docs/roco/PROGRESS.md` + `reports/roco/dashboard.json` | MVP **29/30 DONE**、1 PARTIAL（E03）、3 条落在用户边界内；证据路径逐个检查过存在性 |
| 文档追平代码 | `docs/roco/mvp/ARCHITECTURE.md` §4.5、`RULE-COVERAGE.md` | 把 W3 之后新增的三栏与三套「支持」口径写清 |

### 第 5 轮新增（一句话索引，细节在上面的小节里）

| 交付 | 一句话 | 验证 |
|---|---|---|
| `scripts/roco/benchmark-planner.py` | planner 的客观基准：拿合法动作的一步推演值当「正确答案」 | `npm run roco:benchmark-planner` |
| 候选筛选改为按一步推演值 | 量出**损失几乎全部来自候选裁剪**（60 局面里 41 个的最优不在候选里），改后 top1 0.27 → **0.59** | `roco/tests/test_planner.py` |
| `SEARCH_SEED` + `finally` 恢复 | 分析种子原本泄漏进搜索内部推演，导致服务端**不给推荐**（已修） | `TestSearchIsDeterministicAcrossAnalysisSeeds`（2 项） |
| `effects.compute_damage()` | 伤害抽成**唯一**实现，服务端预览不再克隆整份状态 | `TestDamageHasOneImplementation`（3 项） |
| rollout 接住 `UnsupportedEffect` | 修一个真 crash：「硬门」这类防御技能会让整次 `plan_actions` 失败 | 同上 |
| 负结论：即时伤害项 | 试过、量过（59% vs 57%，样本 100）、**撤了**；并记录一次错误的强结论 | `docs/roadmap/DSH-EXECUTION-STATE.md` |
| 证据产物可 diff | 四份生成产物的易变字段另存 `*-run.json` | `TestReportGeneratorsAreIdempotent` |

### 本轮的测试现状（更新）

| 套件 | 结果 |
|---|---|
| Node unit | **424 / 424** |
| Node browser | **18（17 通过 / 1 按测试自身守卫 skip）** |
| Python（引擎 + 服务 + 模型 + 回放 + planner + 台账守卫） | **181 / 181**（1 skip） |
| Node↔Python 桥契约 | **11 / 11** |
| coach 工具层 | **17 / 17** |
| 规划端到端（plan-e2e） | **10 / 10** |
| 结构契约 | **8 / 8** |
| 投影层（roco-experience） | **12 / 12** |
| **合计** | **680 项，0 失败**（1 项按守卫 skip） |

（核对：424 unit + 17 browser 通过 + 181 Python + 11 桥 + 17 工具层 + 10 plan-e2e
+ 8 结构 + 12 投影 = 680。）

浏览器真机验收两项：`npm run roco:acceptance` 9/9、`npm run roco:demo-acceptance` 16/16。

### 第 3—6 周旗舰版：W4/W5/W6 的阻塞（必须由用户决定，不是进度问题）

| 周 | 任务 | 为什么现在做不了 |
|---|---|---|
| W4 | 固定 Agent 任务集 / 2,000—5,000 条工具轨迹 / Qwen3-4B profiling / **SFT 训练** / 同 Agent replay 门槛 | 用户明确边界：**不下载模型、不训练模型、不租云 GPU**。前两项（任务集与工具轨迹）本机可做，但脱离了 SFT 用途没有独立价值，需要用户确认是否仍要做 |
| W5 | Model gateway / shadow replay / 有条件切换 / 训练主动介入模型 / 陪练盲评 | 「陪练盲评」需要**真人**评分；「训练主动介入模型」属训练，同上边界 |
| W6 | learned value 决策 / Battle PPO / LLM Agentic RL / 最终交付 | 全部依赖训练与真人数据 |

**因此这一轮到此为止是「能做而不能做的都做了」。** 需要用户提供或决策的三件事：

1. **一条游戏内实测**（技能名 + 双方面板 + 属性关系 + 是否防御）——
   有它才能把伤害公式从 `COMMUNITY_HYPOTHESIS_V1`（假设）推到标定，
   并让 30 条 microcase 里的一部分可以真的判定通过；
2. **录屏**（F03 那一项）——脚本已备好，我没有屏幕录制能力；
3. **W4/W5/W6 是否解除「不训练模型」的边界**——不解除就只能停在这里。

### 第二个口径：整局胜负（第 6 轮）

上一轮建的基准用**一步推演值**当正确答案，所以它偏向单步，
depth=2 在那把尺子上看起来更差。这一轮补上另一半：
`scripts/roco/benchmark-planner-matches.py`（`npm run roco:benchmark-matches`）
**让 planner 真的上场比赛**，对面是真实的对手策略，数胜负。

三条纪律写进脚本与报告：① 不是天梯强度（对手是启发式策略）；
② 同一批 fixture 同时量 planner 与 greedy 基线（只报前者没有信息量）；
③ **必须报 Wilson 95% 区间**（40 局里 ±15 个百分点是常态）。

> ### ⛔ 第 12 轮更正：这一节的结论整段作废（**INVALID / 不可解释**）
>
> 监工直接审了脚本，量具本身是错的：
>
> 1. `--swapped` 下 planner 打 **80** 局（正向 40 + 换边 40），但基线只有默认座位
>    **40** 局，而且 `use_planner=False` 那条路**完全忽略** `planner_side`。
>    于是「44/80 vs 18/40」不是同一批座位暴露 —— 一半样本多暴露了一次先手，
>    差值里混进了座位效应；`delta_win_rate` 因此不可解释。
> 2. 「区间几乎不重叠」是错的读法：planner (0.441, 0.654) 与基线 (0.307, 0.602)
>    的重叠区间是 **0.441~0.602**。而且**两个独立区间的重叠与否本来就不能替代
>    差异检验** —— 同一批 fixture 是配对试验，应该报配对差。
>
> 修正后的协议（写进产物 `comparison_protocol`）：配对键 `(fixture_id, seat)`；
> `--swapped` 时两侧都打两个座位且样本数相等（`2 × fixtures`）；
> 主比较 = McNemar 精确二项 + 配对 bootstrap；Wilson 只描述单方胜率；
> 分层列 `games / wins / fallbacks / timed_out`。
> 守卫测试：`roco/tests/test_benchmark_matches_pairing.py`（10 项，
> 含**反证**：把「基线只打一个座位」塞回去必须报错）。
> 旧产物留档 `reports/roco/invalidated/planner-matches-2026-09-21-invalid.json`。

**结果（第 12 轮重跑，40 fixtures × 2 座位 × 3 对手）**：见
`reports/roco/planner-matches.json`。汇总配对差：
`greedy_damage` **+0.050**（p=0.48）、`shallow_search` **−0.088**（p=0.14）、
`status_control` **−0.100**（p=0.057）—— **没有任何一格支持 planner 更好**。
分层后两半符号相反：`greedy_damage` 的 player 座位 +0.250（p=0.002）、
enemy 座位 −0.150（p=0.070）。座位效应成因**未查清**，不得读成「先手优势」。
下表是**作废前**的数字，仅作留痕，**不得引用**：

| 对手 | planner（作废） | CI95 | greedy 基线（作废） | CI95 |
|---|---|---|---|---|
| `greedy_damage` | ~~44/80 = 0.550~~ | (0.441, 0.654) | ~~18/40 = 0.450~~ | (0.307, 0.602) |
| `shallow_search` | ~~18/80 = 0.225~~ | (0.147, 0.328) | ~~13/40 = 0.325~~ | (0.201, 0.480) |
| `status_control` | ~~21/80 = 0.263~~ | (0.179, 0.368) | ~~15/40 = 0.375~~ | (0.242, 0.530) |

### 第 8 轮新增（W4-01 / W4-02，一句话索引）

| 交付 | 一句话 | 证据 |
|---|---|---|
| **W4-01 Agent 任务集**（288 条 / 8 类） | 按**阵容家族、机制、表达模板**三重隔离切分，留出维度不出现在训练集，每类在 train/val/test 三侧都有样本 | `tests/evals/agent-tasks-v1.jsonl`、`scripts/roco/{build,verify}-agent-tasks.py`、`roco/tests/test_agent_tasks.py`（12 项） |
| **任务集里有一个不可完成的参数**（真缺陷） | `query_rules` 的技能期望写成 `skill_name`，而工具契约只接受 `name`——任何 Agent 照做都会被 `validToolArgs` 判成非法参数。是「照期望重放」这一支 arm 把它撞出来的 | `test_expected_arguments_are_arguments_the_tool_actually_accepts`（从 `toolbox.js` 直接解析契约键） |
| **W4-02 轨迹格式 + 判定器 + 离线回放** | 6,048 条轨迹 / 23 个世界 / 7 个 arm（第 37 轮修掉世界采样器后重建；原为 4,536/12），全部由**真服务**产出的公开状态驱动，产物字节可复现 | `scripts/roco/agent-trajectories.mjs`、`docs/roco/AGENT-TRAJECTORIES.md` |
| **判定器两个方向都被测了** | 正向：对照 arm 864/864；反向：**每条通过的记录按自己的判据改坏一次**，17,760 个变体全部判挂；另有漂移检查与**生产者一致性**检查 | `reports/roco/agent-trajectories-verification.json` |
| **反向对照抓出判定器自身三个真缺陷** | ① 胜率判据整段扫描会被前面的否定词骗过；② 冲突判据把「两个来源**一致**」判成「说出了冲突」；③ 过期判据只卡正文、不卡那次被拒的调用 | 同上；`tests/evals/roco/agent-trajectories.test.js`（6 项） |
| **一个难查的串号 bug** | 构建器换世界时没清工具层的「见过的状态版本」，下一个世界拿自己的版本 0 去查被判成「版本倒退」——回执里写着「state_version 0 与当前状态 0 不一致」，两个数字一样却是过期错误 | `resetRocoTools()`；13 条冲突轨迹因此从「挂」变「过」 |

这轮同样**没有**声称模型能力：`baseline` / `blind` 是写在代码里的规则，
不是模型。W4-02 的「2,000—5,000 条**模型候选**」这一半仍缺 DeepSeek key。

### 第 7 轮新增（一句话索引）

| 交付 | 一句话 | 证据 |
|---|---|---|
| **失败分支不再被打分**（基准侧 + planner 侧） | `_safe_step` 推不动时原样返回输入状态，被当成「什么都没做」的分数 —— 某些局面上 40+ 个算不出来的动作共享同一个分数，可能恰好高于可行动作 | `TestFailedBranchesAreNotScored`（3 项，用真实触发点「硬门」构造） |
| **撤回一次 experiment** | rollout 改成对对手分布取期望：top1 0.667→0.684（噪声内）、整局胜负 44/80→**41/80**、延迟 146→**186 ms**。撤回后三格精确复原 | `docs/roco/BENCHMARKS.md` |

这轮**没有让任何指标变好**，这一点要写清楚。两个清理是正确性修复
（「执行不了的选项不该因为失败而得分」），撤回的那件事是**受控 A/B 说不值得**。
两件事的价值都在于：以后再有人想动这两处，能先看到已经量过。

### 第 6 轮新增（一句话索引）

| 交付 | 一句话 | 证据 |
|---|---|---|
| `benchmark-planner-matches.py` | 整局胜负口径：planner 真的上场比赛，带 Wilson 区间与换边 | `npm run roco:benchmark-matches` |
| **修 `plan_actions` 的 side 参数** | 它以前被完全忽略（候选写死取 player），换边那一半 89% 静默回落成基线 | `TestPlannerIsSideAware`（3 项） |
| 胜负口径统一 | `play_match` 用 `player`/`enemy`、自己驱动用 `win`/`loss`；第一版没映射，基线显示「0 胜 0 负」 | `to_engine_result()` |
| 回落率守卫 | 任何对手回落率 > 25% 就在 stderr 警告并在 JSON 标记 —— 静默退化的基准必须自己喊 | 同上 |
| `check-planner-calibration.py` | 量 `expected` 与胜负的关系：**不显著**（Welch t=0.873）→ 不能当信心代理 | `npm run roco:planner-calibration` |
| `docs/roco/BENCHMARKS.md` | 三个基准摆在一起，含它们各自偏差与「骗过我三次」的记录 | 该文件 |
| 幂等测试补盲区 | 原来只比 git status（基线脏就看不出来）；现在比产物 SHA256 | `TestReportGeneratorsAreIdempotent` |

### `expected` 能不能当信心用？量过了：**不能**（第 6 轮）

`expected` / `worst` 是规划回执里最像「信心」的两个数，很容易被上层
（页面、工具、模型）当成「这一手好不好」的代理。这件事值得量一次：
`scripts/roco/check-planner-calibration.py`（`npm run roco:planner-calibration`）
—— 开局时 planner 报的 `expected`，对那一局最终的胜负。

| 样本 | 胜局 expected 均值 | 非胜局 expected 均值 | 差值 | Welch t | 95% 显著 |
|---|---|---|---|---|---|
| 30 局 | — | — | **−0.130** | — | — |
| **80 局** | 0.5467 | 0.4365 | **+0.110** | **0.873** | **否** |

**两次都没到显著水平，而且第一次符号还是反的。** 结论：
在这个口径下（开局一次 `expected` 对整局胜负），
`expected` **不能**当作「这一手好不好」的信心代理。

`worst` 也一样（胜局 0.227 vs 非胜局 0.169，同样没做显著性检验，但量级不足以支撑用法）。

这条结论对上层有直接影响：**页面与工具不该把 `expected` 说成胜率或把握**，
现在它们确实也没这么说（回执里带 `not_a_winrate`），但那是靠约定；
现在多了一条「量过、不显著」的证据。脚本里也把「差值必须带显著性」
写成了硬要求 —— 只看均值差会把噪声读成结论，这一轮我自己就差点这么干。

### 这个基准当场暴露的两个 bug（都是真的）

**① `plan_actions(side=...)` 根本不看 side。** `_my_candidates` 把
`legal_actions(..., "player")` 写死在函数体里。于是 `side="enemy"` 时，
候选来自**玩家**的合法动作、估值也按玩家视角算，返回的推荐
几乎必然不在对手的合法动作集合里。

发现方式很间接：我加「换边」是为了排除先手优势，结果换边那一半
**182 次决策里 162 次回落到贪心（89%）** —— 也就是说那一半量的其实是基线。
**一个会静默退化成基线的基准比没有基准更糟：它给出的数字看起来像结论。**
修法：候选函数接受 `side`；补位分支也从写死的 `"player"/"enemy"` 改成 `side/opponent`。
现在 112 次双侧推荐里 0 次非法，回落率两半都是 0。

**② 两个口径的胜负字符串不一样。** `play_match` 的 `winner` 用
`player`/`enemy`，而自己驱动那条路拿到的是引擎的 `state.result`（`win`/`loss`）。
第一版没做映射，基线在报告里显示「0 胜 0 负」——
差一点被我读成「基线很弱」。现在两边共用 `to_engine_result()`。

另外加了**回落率守卫**：任何一个对手的回落率超过 25% 就在 stderr 警告、
并在 JSON 里标记 `warning`。理由就是上面那句 ——
静默退化的基准必须自己喊出来。

### 让证据产物「可 diff」（第 5 轮收尾）

四份由脚本生成的产物（microcase 台账、标定报告、进度台账，各一对 md+json）
原本都带易变字段：生成时间、HEAD、未提交文件数。后果是**每次跑完
`git status` 都显示「文档被改了」**，久了就没人看它的 diff —— 而 diff 正是这些
文档唯一的用处。

改法与浏览器验收报告一致：**稳定字段入库，易变字段另存 `*-run.json`**（已 gitignore）。
新增一条测试（`TestReportGeneratorsAreIdempotent`）连跑两次生成器、
断言 `git status` 不出现新条目 —— 纪律由测试执行，不靠人记得。

### 一个客观基准，和它量出来的两个真 bug（第 5 轮）

改 planner 时最尴尬的状态是「我觉得这样更好」——因为没有可比的数字。
新增 `scripts/roco/benchmark-planner.py`：对每个局面枚举**合法**动作、
按对手分布做一次真实推演、用同一个 `evaluate()` 给推演后的局面打分，
基准值最高的动作就是这一局的**基准最优**。于是「推荐得准不准」变成可算的数字。

它测什么要说清：**它测「搜索有没有找到估值函数最偏好的那一手」，
不测「估值函数本身对不对」**（那需要真人或天梯数据，本项目没有）。
三条使用边界写在脚本 docstring 里，避免后人拿它下错误结论：

1. 测的是搜索与估值函数的一致性，不是估值函数的正确性；
2. **不能用来比较不同搜索深度** —— 基准是单步推演，depth=2 在权衡两回合后的位置，
   与单步基准不同是预期行为（实测：预算从 200ms 提到 8000ms，数字完全不变）；
3. **不要为了刷这个数字去改 `evaluate()`** —— 基准与 planner 用同一个估值函数，
   改它会同时移动两边，数字变好只代表两者更一致，不代表推荐变好。

**第一次跑出来：planner 的 top1 只有 27%，而朴素的一步贪心是 87%。** 查下去：

| 诊断 | 结果 |
|---|---|
| 推荐在**全量合法动作**里的排名中位 | 4 |
| 推荐在**planner 候选集合**里的排名中位 | **1** |
| 全量基准最优**不在**候选列表里的局面数 | **41 / 60** |

结论很清楚：**搜索本身没问题（候选内它就选中最好的那一个），
损失几乎全部来自候选裁剪** —— 原版按**静态威力**排序，把最优那一手筛掉了。

改成按**一步推演值**挑候选（`one_ply_value`，与基准同一把尺子）之后：

| 指标 | 改前 | 改后 |
|---|---|---|
| top1（推荐=基准最优） | 0.27 | **0.59** |
| median rank | 3 | **1** |
| mean regret | 0.26 | **0.15** |

仍然保留**类别保底**（技能/换宠/道具各留一个）：只按值排序很可能留下四个攻击技能，
于是「换宠承伤」「防御等一轮」永远进不了搜索 —— 而多回合规划存在的理由正是这两类。
rollout 内部仍用便宜版 `_quick_candidates`（每层都做一步推演会爆预算）。

**剩下那 0.59 vs 0.88 的差距不是 bug。** 用 200ms / 2000ms / 8000ms 三档预算跑，
数字**完全相同**（0.6842 / 0.6842 / 0.6842）—— 说明不是超时截断。
多回合搜索在权衡「两回合后的位置」，本来就允许与单步基准不同；
基准偏向单步，这一点写在脚本的 docstring 里。要判断谁真的更好，
需要一个「整局结果」口径的基准，而那个需要真人样本，本项目没有。

### 顺带修掉的回归：分析种子泄漏进搜索内部

改完候选筛选后，**服务端开始不给推荐**了：三个分析种子（11/29/47）给出
「穿膛 / 使用能量果 / 穿膛」，聚合判定 `recommendation_stable=false`，于是回 `null`。
原因不是候选筛选本身，而是它暴露出来的一个既有问题：

引擎把同速裁决建模成 seed 驱动的随机（`env._rng_for` 由 `(state.seed, turn)` 派生），
而规划时状态是从公开面**重建**的、带着分析种子 —— 于是搜索里推演出来的后续回合
也用分析种子裁决同速。**换个分析种子推荐就变，而变的原因只是搜索内部掷了几次骰子**，
不是「我们对局面知道多少」。

修法：搜索内部固定用一个 `SEARCH_SEED`，并在 `plan_actions` 的 `finally` 里
把调用方的 `state.seed` 还回去（**不能靠「每个 return 前记得写一行」**，
那种约定迟早漏；异常路径也要恢复）。修完三个种子给出同一个推荐、
同一个期望值，服务端恢复稳定推荐。

新增 2 项测试钉住：同一公开面在四个分析种子下推荐必须一致；
规划不许改动调用方 state 的 seed（含异常路径）。

`scripts/roco/benchmark-planner.py` 也接了 `npm run roco:benchmark-planner`。

### 一条负结论：planner 的「即时伤害项」（第 5 轮）

**试过、量过、撤了。** 记在这里是因为「撤掉一个看起来显然该加的东西」比加上它更需要理由。

起因：planner 的 `evaluate()` 只有四项（存活差、生命差、能量差、对位相性差），
**没有任何伤害量级**。看起来是明显缺口，于是做了两件事：

1. 在 `evaluate()` 里加「即时伤害差」与「击杀奖励」；
2. 在候选筛选里为**必杀**开特例（担心条件化威力让必杀被 `beam` 挡掉）。

**A/B 的结论（同一批 100 个固定局面，避免采样噪声）：**

| 变体 | 选中「最高伤害合法动作」的比例 | 伤害排名中位 | 合法必杀可用 / 选中 |
|---|---|---|---|
| 加上伤害项 + 击杀奖励 | 59% | 1 | 8 / 6 |
| 原版（都不加） | 57% | 1 | 8 / 5 |

差 2 个百分点、样本 100；必杀那一项差**一个样本**。这落在噪声里，不是改善。
**证据不足就不加复杂度**，所以两项都撤了；只留下一段注释，写清「试过、为什么撤」。

更该记的是**我中途得出过一个错误的强结论**：我一度测出「80 个局面里 13 个存在必杀，
planner 一次都没选中」，并按这个结论动手改了候选筛选。那个测量是错的 ——
它按**配招表**算伤害，没有检查**能量够不够**，于是把「这一步根本打不出去的招」
当成了可用必杀。改成只统计 `legal_actions` 里的攻击技能后，数字变成「8 个必杀、原版选中 5 个」，
结论从「完全不工作」变成「本来就基本工作」。

教训写在这里：**「引擎能算出某个数」不等于「这个动作此刻可执行」**。
值域类统计必须走 `legal_actions`，不能走配招表 ——
同一个坑在伤害预览上也踩过一次（见 `damage_preview` 那条：用 `legal_actions` 筛会低估上界，
用配招表筛会高估可执行性；两处的正确做法不同，各自的注释里都写了原因）。

### 保留的改动：伤害只剩一份实现

同一轮里做了一件**有独立价值**的重构：把伤害计算从 `env._execute` 内联的那一大段
抽成 `effects.compute_damage()`。理由不是好看 ——
内联版本逼得「只想算一个数」的地方（planner 估值、服务端伤害预览）
要么重复实现公式、要么用「克隆整份状态 + 跑一次 `_execute` + 从事件里读伤害」这种昂贵办法。
现在服务端的伤害预览直接调它，不再克隆状态。

新增 3 项测试钉住等价性（`roco/tests/test_replay_invariants.py::TestDamageHasOneImplementation`）：
`compute_damage` 算出的伤害与 `env._execute` 实际扣掉的血**必须一致**；
`max_raw_damage` 报的上界必须真的打得出来；打不出伤害时返回 `(0, None, None)`
而**不是**一个默认值。

### 进度台账：路线图 vs 证据（本轮新增）

`scripts/roco/build-progress-dashboard.py` → `docs/roco/PROGRESS.md` + `reports/roco/dashboard.json`。

它回答的是最容易失真的那个问题：**路线图上被划掉多少项，其中多少项真的拿得出证据。**

| 状态 | 条数 | 含义 |
|---|---|---|
| `DONE` | **33** | 有证据，且每个证据路径都被脚本 `os.path.exists` 检查过 |
| `PARTIAL` | **1** | **E03**：引擎侧对每条待验机制有明确行为并登记为假设，但「已验证」需要实测 |
| `BLOCKED_BY_BOUNDARY` | **3** | W4 / W5 / W6，落在「不下载模型、不训练模型、不租云 GPU」这条边界里 |

**MVP 30 项：`DONE` 29 / 30。** 唯一没 `DONE` 的是 **E03**，
因为它的验收是「12/12 microcase 通过」，而那需要游戏内实测 —— 当前 0 条。

台账的守卫（`roco/tests/test_microcase_harness.py` 里的 `TestProgressDashboard`，4 项）：
每条 `DONE` 的每个证据路径必须存在、非 `DONE` 必须写清原因、
`NEEDS_HUMAN` 必须点出缺的是谁、`BLOCKED_BY_BOUNDARY` 必须写明是哪条边界。
**写台账的脚本自己也会被测试**，否则它就成了最不可核对的一份文档。

### E04/E05 的验收不变量落地（本轮新增）

路线图里 E04 的验收原文是「固定 seed 的 100 条回放逐事件一致；终止后不能继续行动」，
E05 是「随机 1,000 场无非法状态；双方 observation 泄漏测试为 0」。
这一轮把四条都写成会变红的断言（`roco/tests/test_replay_invariants.py`，7 项）：

| 验收条目 | 现在怎么测 |
|---|---|
| 100 条回放逐事件一致 | **100 个固定 seed**、12 只名册随机组队、五种策略轮换；每条重放**两次**比事件序列与最终状态，并验证回放能复现记录里的结局与回合数 |
| 终止后不能继续行动 | 打到结束；断言双方 `legal_actions` 为空，且再 `step_joint` 抛 `ValueError` |
| 随机对局无非法状态 | 120 局随机对局、每条动作先断言在 `legal_actions` 里；每个回合检查生命/能量范围、`fainted` 与生命一致、精灵 id 在规则集里、队伍恒为 3 只（>200 个回合状态） |
| observation 泄漏为 0 | 60 局随机对局 + 60 个公开 planner state，按**字符串扫描**隐藏标记（不是按字段读：泄漏往往出现在没想到的新字段上） |

### E03 的「实测那一半」：台账 + 录入 + 标定（本轮新增）

30 条 microcase 一条都没通过，原因只有一个：**没有任何游戏内实测**。
但「引擎什么都没做」与「引擎已经对了」都不成立 —— 真实情况是第三种：
引擎对每条待验机制都选了一个明确行为，并把它登记成假设。

| 新增 | 做什么 | 结果 |
|---|---|---|
| `scripts/roco/run-microcase-harness.py` → `docs/roco/MICROCASE-HARNESS.md` | 逐条**真的跑一遍引擎**，记录「引擎现在怎么做 / 引用了哪条术语 / 未核验的那一点是什么」 | 30 条里 **26 条**有明确行为（`ENGINE_ASSUMPTION`）、**4 条**连前提都缺（`NOT_EXECUTABLE`：MC-014/023/024/025）。`verification_passed` **恒为 false** |
| `scripts/roco/record-measurements.py` → `data/roco/measurements.jsonl`（追加式） | 实测录入：`damage` / `speed_tie` / `buff` 三种。必填字段缺一个就**拒收**，`damage=0` 也拒收 | 目前**文件为空** —— 仓库里不存在任何伪造的实测 |
| `scripts/roco/calibrate-from-measurements.py` → `docs/roco/CALIBRATION.md` | 实测 vs 引擎：**容差必须由人给**（不给就只报告差异）；标定只反解系数并报出与假设的偏离，**不自动改公式** | 用一条演练数据跑通整条管线后即删除 |

配套守卫（`roco/tests/test_microcase_harness.py`，7 项）：台账不许自称「通过」、
每条必须有明确状态、`NOT_EXECUTABLE` 必须写清缺什么、探针必须有结构化字段。

**伤害预览**（W3-04 延伸）：`/battle/plan` 新增可选 `damage_preview`，给出
**原始伤害范围**（配招里所有攻击技能逐个试打）、`lethal`（够不够一击收掉）、
`lethal_stable`（结论是否随分析种子变化）、以及 `formula_verified: false`。
页面把「按未核验公式估，这一步能打出 130~425 点伤害；够收掉」直接显示在提示里。
第一版采样用 `legal_actions` + planner beam，导致值域只有 130（漏掉了 425 的那一击）——
改为遍历**配招里全部攻击技能**，并把这个错误写进测试名与注释。

### F01 / F02 / F03 交付（本轮完成）

| 任务 | 交付 | 证据 |
|---|---|---|
| **F01 无聊天入口演示** | `/roco.html`（无聊天框；主动短提示、阵容变化重判、局末一个教学入口、陪练先接情绪） | `npm run roco:demo-acceptance` → **16/16**，6 张截图；`tests/roco-experience.test.js` 9 项 |
| **F02 全链路回归** | 人读报告 + JSON + 18 份原始日志 | `reports/roco/regression/F02-REGRESSION-2026-09-21.md`（含协调者补记） |
| **F03 MVP 材料** | 架构图 / 数据卡 / 规则覆盖表 / 实现状态标签 / 录屏脚本 | `docs/roco/mvp/`（5 份，每节标了证据来源） |

F02 报的四条问题，三条已修（能力表说假话、`NOT_IMPLEMENTED` 空字典导致 501 不可达、
补位局面的规划实际上从未算过），一条留作已知问题（test:smoke 不自举）。

## 1.7 边界更正与 goal 重写（第 7 轮，用户指令）

**旧目标里的一条边界作废了。** 旧 goal 写着「不下载或训练模型、不租云 GPU」——
那是 **M0/M1 阶段**的约束，不是旗舰项目的永久禁令。用户已明确要求继续完整旗舰路线，
且所有 SFT/RL/本地模型模块必须**真实接入 Agent、有明确分工与产品用途**，否则不做。
active goal 已按此重写（revision 2）。

| 旧表述 | 现在 |
|---|---|
| 不下载模型 / 不训练模型 | **作废**。W4/W5/W6 要做；但每个模型必须有 baseline、family/时间切分、校准/OOD、fail-closed 回滚开关、**真实调用链** |
| 不租云 GPU | **保留**（这条只是「不去租」，不是「本机做不到」）。~~本机没有 M5 Pro 48GB，所以 W4-03/W4-04 是硬件阻塞~~ —— **第 41 轮更正：这条前提是错的。** `sysctl machdep.cpu.brand_string` = `Apple M5 Pro`、`hw.model` = `Mac17,9`、`hw.ncpu` = 15、`hw.memsize` = 48 GB —— **本机就是目标机器**。W4-03（profiling）与 W4-04（SFT）**都不是硬件阻塞**，而且都已经在本机做完（见 §2.1 的模型身份与 SFT v4 一栏） |
| 不提前替换默认 UI | **保留**。可以新增页面，不替换营地页 |
| 其余（只用手游数据、fail closed、不把频次/模型分当胜率、Lua 只作文本解析、不删旧测试、不覆盖用户改动、不提交密钥、不装多余依赖） | **全部保留** |

**planner 调优到此收口**：不再为了刷同一套内部 `evaluate` 指标改搜索，
只保留有明确正确性理由的修复。三个基准的结论、偏差与「骗过我」的记录在
`docs/roco/BENCHMARKS.md`；本轮验证日志在 `reports/roco/verification/`。

---

### C6.6 第 47—49 轮（UI 阶段开头）的断点与两个卡住的 agent

| 项 | 状态 | 说明 |
|---|---|---|
| HEAD | `ffa2a2d` | 已提交：`a44563d`（修掉会覆盖文档修正的过时句）、`ffa2a2d`（`roster-48.json` 去掉生成时间戳 → 连跑两次 sha256 相同） |
| 工具链可复现性 | ✅ 已验证 | `export-full-catalog.mjs` → **pets=622 / learnsets=312**；`build-roster-48.mjs` → **48 只 / 独特技能 76 / 属性 18 / 硬机制 8/8** |
| **批 0 `6c5a0d07`** | ⛔ **已中断** | 连跑约 2.5 小时、两次清空自己的中间产物，盘上从未留下可复核成品 → L1 图鉴与 48 只落库**改由主线程自己做** |
| **矩阵重新定位 `edd4b551`** | ⏳ 仍在跑 | 目标：让 12 个局面跟上 `36832d1`（引擎 fail-closed 修复改变了战斗走向）。三轮检查均只见重跑产物，**`scripts/roco/demo-acceptance.mjs` 的期望值尚未落盘** |
| 我红跑留下的 3 个产物 | 未提交（故意） | `reports/roco/demo-acceptance/{coach-positions-browser,demo-acceptance,demo-dom-snapshots}.json` 是失败那次跑的产物；矩阵回绿时一并提交 |
| 门禁 | **未全绿** | `latest.json` 仍 `unit` 红；`demo-acceptance` 仍 3 条红（三个局面 kind 失配 + 形状最大重复 3 > 上限 2）。**全绿前不得宣称稳定** |

**下一轮第一件事**（不依赖任何 agent）：把 `tmp/roco-full-catalog.json` 归一成
`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`（新 schema 版本，
不污染现有 12 只那份；逐字段 provenance + `unknown` 清单 + refused 原因码 R1—R8），
再让 `/api/roco/roster` 支持分页/筛选并扩到 48 只（旧响应形状向后兼容）；
两项都要配 `verify`（带必红反证）与真服务抽样（任意合法 3v3 开局并能打完）。

## 2. 当前 HEAD 与工作区

### 2.1 第 11 轮结束时的可恢复断点（每次压缩前更新）

| 项 | 值 |
|---|---|
| HEAD | `e851284`（`feat(train): Qwen3.8-27B 的**用户亲训**引导脚本与教学文档（C4，不代跑）`）。（按本文件 §2.1 的口径，文档声明的 HEAD 落后一两个提交是正常的：写文档本身也要一次提交。**但落后 >12 个提交会判红**——这一行要跟着阶段的最后一个提交走。） |
| 工作区 | **干净**（`git status --porcelain` 为空） |
| 验证 | **一条命令可复现**：`npm run verify:release` → **14 个套件全绿**（env / unit / bridge / toolbox-roco / plan-e2e / trajectories / **trajectories-model** / sft-split / model-manifest / provenance / state-doc / guard-selftest / 浏览器 9-9 / demo 产品判据），产物 `reports/roco/verification/latest.json`。另有 `reports/roco/verification/last-green.json`：**最近一次全绿运行**的记录（`latest.json` 可能是红的，这一份只有全绿才写）。**判据条数以产物为准**（`demo-acceptance.json` 的 `summary.passed/total`），不在这里手抄 |
| 日志 | `reports/roco/verification/round8..round30-*.log` + `latest.json` |
| 守卫自检 | `npm run guard:selftest`：7 条注入，**7/7 全部变红**；另有各自带反证的检查：`verify-agent-trajectories --selftest` 3/3、`verify-sft-split --selftest` 7/7、`model-arm-identity` 正反两向 |
| 文档一致性 | `npm run verify:state-doc`：声明的 HEAD 仍在历史里、验证产物在、没有引用不存在的路径。**第 38 轮改掉了它的自指死锁**：原来它要求「最近一次 verify:release 必须是 pass」，而 `verify:release` 里又有 `unit`包含这条断言——一次失败之后每次跑都会因为上一次红而红，唯一出路是手改 `latest.json`。现在硬判据是 `last-green.json`（必须存在一次全绿、verdict=pass、套件数够、它记的 HEAD 仍在当前历史里），`latest.json` 红了只报**警告**。**第 45 轮又拆掉同形状的第二处死锁**：「落后 >12 个提交」原来是硬失败，而这条断言同时长在 `unit` 里——一个阶段提交超过 12 次之后，`last-green` 追不上、`verify:release` 永远绿不了，也永远写不出新的 `last-green`（实测 19 个提交时 14 个套件里只有 `unit` 与 `state-doc` 红，两条红的是同一条断言）。现在落后只报警告，`tests/evals/state-doc.test.js` 有一条正反两向的回归（反证：把警告改回硬失败，立刻红） |
| 本轮**保留**的实验 | 无（本轮交付与实验分离，没有为刷指标改动过搜索或评分） |
| 本轮**撤回/修正**的 | ① `skill_name` 参数键（工具不接受，任务不可完成）；② 判定器胜率判据整段扫描；③ 判定器冲突判据把「一致」判成「冲突」；④ 过期判据只卡正文；⑤ 换世界不清工具层状态版本导致串号；⑥ 给 `receiptSummary` 加注释时误删 `export`（测试全绿但生成器已不能跑） |
| **第 14 轮已完成** | **Mac 本地模型部署**：M5 Pro 48GB preflight；`.venv-mlx`（Python 3.12 + mlx-lm 0.31.3，GPU 后端）；`mlx-community/Qwen3.5-4B-4bit`（2.9 GB，revision `0e7ffd5c62`，apache-2.0）已下载到 `.models/mlx/`（gitignore）；manifest 逐文件 SHA256 校验通过；一键 setup/start/healthcheck/stop；OpenAI-compatible 网关；feature flag 真实接入 Agent（默认 off）；21 项失败降级测试 | `docs/roco/LOCAL-MODEL.md`、`models/registry.json`、`reports/roco/verification/round14-mac-local-model.log` |
| 第 14 轮实测 | 固定提示集 8 次调用：首 token p50/p95 **214.5 / 318.1 ms**，总延迟 p50/p95 **362.9 / 470.5 ms**，29.8 tok/s，峰值内存 **2.51 GB**，结构化输出合法率 **1.0（8/8）** | `reports/roco/local-model/bench.json` |
| 本轮**待验**（外部依赖） | ① 与 DeepSeek 的质量对照要 key（没有就不声称可替代云端）；② `short`/`refuse` 的「说得好不好」要人工审阅或盲评（程序合法率不等于质量） | `docs/CHECKLIST.md` 的 MP11/MP12 |
| **第 15 轮（W5-04）** | **主动介入判定层**：预注册（`docs/roco/W5-04-INTERVENTION-GATE.md`）先写判据；窗口集从 30 条扩到 **3,740 条**（按 seed family 切分 + family 外 OOD）；成本敏感分类器（`sklearn`，cost FN:FP = 3:1）；判定层只做**抑制**、默认关闭、可逐位回滚 | `scripts/roco/{build-intervention-windows.mjs,train-intervention-model.py}`、`src/coach/intervention-model.js`、`tests/evals/intervention-layer.test.js`（10 项） |
| **第 17 轮（W5-04 v2）** | 按「纯决策前观察量」**重新定义问题**后重跑：标签 = 必须补位 / 血量≤35% / 枚举 top1−top2 边际 > 5；特征 7 维全部决策前可得。**离线 G1—G5 全过**（召回 1.0、误报 0.0、ECE 0.0070、family 外同样过、三个固定阈值都过）。**消融臂**（去掉 `planner_margin_norm`，特征与规则同信息）误报率塌成 1.0 → 证明通过来自「特征终于覆盖了标签依赖的量」，不是多塞了特征 | `reports/roco/intervention-model-report.json`、预注册文档 §10 |
| **第 38 轮（shadow 档其实改过行为：工具选择被本地模型接管）** | 修存档错位时顺手读了 `src/server/index.js` 的 `applyLocalModel`，发现它**无论 shadow 还是 on** 都把 `wrapped.plan` 换成本地规划器。而 `runtime.js` 正是用 `provider.plan` 决定去查哪些工具——于是 shadow 档下「查什么」被本地模型改掉了：证据不同、答案就可能不同，而 shadow 的契约是「跑本地但**不改变玩家看到的结果**」。同一形状的坑第 15 轮在介入层上也踩过一次。已改成：**只有 `on` 档**才接管 `plan`；shadow 档照跑本地规划器（可观测），但决定仍来自 base，且 base 本来没有 `plan` 时**不凭空加一个**（那本身就会改变证据收集路径）。守卫是 `tests/server.test.js` 里一条只看**两次真实请求返回是否逐字相同**的测试（正文 / provider / 路由 / 证据 deepEqual）。**顺便修掉一个测试自伤**：`createCoachServer` 没有本地模型注入点，第一次写这条测试时真的拉起了 3 GB 的 MLX 子进程，把测试挂到超时还留下孤儿进程——现在有 `localModelFactory` 注入点 | `src/server/index.js`、`tests/server.test.js` |
| **第 45 轮（老师那一角原来也是「同一个模板」：30 局 30/30 同一门课，43% 是表扬）** | 用户对 P1 的原话是「不能是同一个模板换名字换数字」。第 43 轮修了局内气泡，这一轮**量了老师那一角**——真服务按 30 个固定种子打完整局（30 局 / 平均 13.0 回合 / 15 胜 15 负 / 0 局讲不出话）：修复前 `use-item-before-danger-line` **30/30**，其中 **13 局（43%）** 玩家其实已经做对了（`healed-before-faint`，正文是「这一步的先后顺序是对的」），而同一局里真做错了的课一句都没提。根因是结构：`reviewMatch` 按 `TEACHER_GOALS` 的固定优先级取第一门够得上的，而「有药可用 + 有人倒下」在收官对局里几乎恒成立，于是永远压过其余四门。修法：按**可教性**排（先讲处理方式做错了的课；都是错时才按原优先级；同一档里有没讲过的先讲没讲过的；一句错都没有才讲「做对了」那门），返回值加 `mistake_available` / `teaching_a_mistake` 两个可核对记号。修复后 **17/13** 两门课、**表扬 0/30**。**两条负结论如实记**：① 转折点 `damage-lead-flip` 30/30 没用上——3v3 打完必然有人倒下而 `first-faint` 先命中，所以它在收官对局里**实际不可达**（与第 39 轮 `decisive-gap` 死分支同形状；没删它，构造用例仍能触发）；② 五门课只有两门在这批对局里够得上，其余三门真实可达性是 `unknown` 而不是「不可达」 | `src/coach/teacher-review.js`、`tests/evals/teacher-review.test.js`、`tests/evals/roco/teacher-match-review.test.js`、`docs/roco/TEACHER-REVIEW.md` |
| **第 45 轮（老师的局末复盘接进页面：两个输入错了都不报错）** | 局末原来只给「一个决策点问题」（`rocoLessonEntry`）。现在接上第 43 轮写好的 `teacher-review.js`：页面局末卡片给出**真实复盘**——一个转折点 + 一条可执行的改法 + **上一次那一课有没有改善**。这一轮真正修的是**两个错了不会报错的输入**：① 服务端每次推进只回**这一次**产生的事件（`service.py:1860` 的 `state.events[events_from:]`），而页面原来把 `view.events` 直接赋值给 `state.events`（渲染用），复盘若也用它就只剩最后一回合——实测整局 **70** 条事件、最后一次推进只有 **6** 条（差 11.7×）；② 终局视图的 `legal` 是**空的**，而 `rocoGameView` 的 `player.items` 是从 legal 里的道具动作数出来的，拿终局视图做复盘等于告诉复盘「这一局没有药可用」——实测 seed 5 因此**换了一门课**（`use-item-before-danger-line` → `switch-out-of-the-bad-matchup`），而前者才是它真正该学的。所以页面现在留两份快照：`matchEvents`（整局累计）与 `lastLiveView`（最后一个还能行动的局面），并**先核对上一课再记这一课的账**（反过来的话 `latestTeaching` 拿到的是刚写进去的那条，等于自己跟自己比）。**装配逻辑抽成 `rocoMatchReview`**（纯函数、不碰 DOM），Node 侧才能用真对局验同一段代码——「页面和验收共用同一个可能写错的实现」这件事由测试文件里**再写一遍收集顺序**来挡住。**验收**：`tests/evals/roco/teacher-match-review.test.js` 真服务打完整局 2 条用例；反证两条——只给最后一次推进的事件，三个 seed 结论全都变；对手倒下那一只只写「对方第 N 位」，手工把名字塞进后备位次后判定立刻看得见（证明这条不是空的）。第二局的核对语义也钉住了：同一局面同样处理 → `improved:false` 且写进账本；`improved:null`（局面没重复）**一行都不写**，不把「什么都没发生」算成失误 | `src/client/roco.js`、`src/coach/roco-experience.js`、`tests/evals/roco/teacher-match-review.test.js`、`docs/roco/DEMO-PLAN.md` |
| **第 45 轮（孤儿守卫：绿着但永远不会跑）** | 顺手做了一次机械扫描：全仓 63 个测试文件里，**16 个**没有被任何 npm script 直接引用。逐个核过之后，Python 那 12 个由 `test:env` 的 `unittest discover` 覆盖（不是孤儿），真正没被跑的是 **4 个 Node 测试文件 / 20 条用例**：`tests/evals/coach-advice.test.js`（14 条，P1 建议层的守卫！）、`tests/evals/guard-selftest.test.js`（6 条）、`tests/evals/roco/coach-positions.test.js`（10 个真实局面的 P1 证据）、以及本轮新建的 teacher 那条。这正是我们反复踩过的同一形状（第 41/44 轮各一次）。**两件事都做**：把四个文件显式加进 `test:unit`（列表是枚举式的，不加就等于没有），并加一条**结构契约**——`tests/**/*.test.js` 的每一个都必须出现在某个 npm script 或 `guard-selftest` 登记表里，**不认文档或注释里的提及**（那正是「写了但没跑」的来源）。反证：把 `coach-advice` 从 `test:unit` 里拿掉，这条契约立刻报 `tests/evals/coach-advice.test.js`。`test:unit` 580 → **604** | `package.json`、`tests/evals/structure-contract.test.js` |
| **第 45 轮（P1 剩下的四块：形象／引导／可读性／性能，以及记忆可见可纠正）** | 用户的目标里 P1 还剩「能拿去给别人演示」的那几块，本轮把能自己做完的四块做掉，每块都留了实测或守卫：① **形象体系（P1-1 首版）**：`TYPE_EMOJI` 给 12 个系别各一个自制 emoji 徽记（🐾🔥💧🥊🪶❄️🐉👻🎀🐛✨🌿），与既有 `TYPE_COLOR` 一一对应，渲染成阵容卡与场上伙伴卡的头像块——**零外链、零 `<img>`**（官方立绘许可不明，不抓；emoji 是字体自带字符，放大不糊、离线可用）；色盲友好靠三信号叠加（emoji + 色块 + 系别文字）。浏览器实测 12 张阵容卡全部有头像、0 空 emoji、页面 `<img>` 数 0。守卫逐键比对两张表（反证：删掉「自然系」的 emoji 立刻红）。② **开局引导**：正文上方三步条「选阵容 → 开一局 → 她自己会说话」，`data-roco-onboard` 断言的**是步数**。③ **可读性（P1-4 首版）**：窄屏触控目标 44px 下限、基础字号 15px、动作区单列、长句行距放宽、`:focus-visible` 焦点可见、`prefers-reduced-motion` 关装饰过渡。④ **性能（P1-5 完成）**：新增 `scripts/roco/measure-demo-perf.mjs` → `reports/roco/demo-perf.json`，四个量全部实测达标——首屏 ready **154 ms**（要求 <1500；DOMContentLoaded 47 / load 48，差额是必须等到位的精灵名单与规则服务状态）、`render()` p50 **0.1 ms** / p95 0.3（要求 <100）、**外部来源资源 0**（20 个请求全同源，合计 655,947 B）、25 步 JS 堆 +0.48 MB 且后两档持平、DOM 293 节点。⑤ **记忆可见可纠正（P1-3）**：页面新增「小芽记住的」面板，只列玩家自己说过的那几条（**故意不列对局记录**——把战绩摘要和长期偏好混成一张单子就是「拿摘要冒充记忆」），「忘掉」走既有 `deleteMemoryItem` 且**只在真的删掉时才改页面**；浏览器实测 初始 none → 说「以后叫我老王」→ 1 条「称呼：老王」→ 忘掉 → 刷新仍是 none。顺带修掉两处标签本身读不通（`memory.js`：`怎么称呼你：X` → `称呼：X`；本命标签原来只有伙伴名）。**两处判据自身的错误也留痕**：性能脚本的「非本机资源」原来按文件名排除，把 15 个同源模块误报成外链，改成按**来源**比较后报 0 | `src/client/{roco.js,roco.html,roco.css}`、`src/coach/memory.js`、`scripts/roco/measure-demo-perf.mjs`、`reports/roco/demo-perf.json`、`docs/roco/DEMO-PERF.md`、`tests/roco-experience.test.js` |
| **第 45 轮（陪练审计点名的三个缺陷：情绪话换来战报、拒绝被记录了却不执行、静默偏好到不了聊天链路）** | 第 43 轮的审计（`docs/roco/COMPANION-GAP-AUDIT.md`）点名三处，本轮按它自己写的「最小修复方向」逐个修好，并把三条「记录当前行为」的 TODO 用例改成正向断言 + 反向对照。① **判成情绪却接不住**：`输了/好菜/气死/崩了/好难` 在 `EMOTION_WORDS` 里却不在 `MOOD_WORD_RE`/`MOOD_ECHO` 里，于是 R2 落到 `pick(CLASSES)`，玩家说「输了」收到的是「最近3局里，最先倒下的都是…」——产品明令禁止的「把战绩摘要冒充共情」。改法：情绪字面量收敛成 `EMOTION_WORDS_LIST` 一处，五个补充词进心情词表与三张文案表，并加**加载期自检**（判得成情绪的词取不到词/拼不出整句就抛错）。⚠ 一处**有意保留的不对称**：状态词（累了/没睡好/状态不好）在心情出口里但**不**进情绪表——否则档位从 R1 抬到 R2、第一轮就讲对局（`tests/companion.test.js` 4 条用例实测变红，这就是没把两张表并成一张的原因）。② **情绪与拒绝被复盘路由截走**：`输了` 在 `situational` 里，于是「打完一局 + 一句情绪」让 `matchRequest` 成立 → `route='teacher'`；`别复盘了` 也因句子里有「复盘」两个字被送进复盘通道，而 `memory.stated` 的 `refusal:review` 没有任何路由读它。改法：`situational` 只留真正的分析问法（`输在哪/哪里出/问题出在/为什么输/怎么办`），复盘请求拆成显式与推断两支，推断那支要 `!playerWishes(next).refusedReview`（**显式请求优先于旧拒绝**，玩家改主意要照办），拒绝按**整句**判（别复盘/不想复盘/别回顾…）同时挡住两个分支。③ **静默偏好到不了聊天链路**：`decideRegister` 的 `context.preference==='quiet'` 闸门在聊天链路上永远不命中（`buildContext` 只有 `profile.coach.mode`）——同一句「安静」管得住局内气泡、管不住聊天回话。改法：`runCoach` 把档位透传下去，**不复用**同名的 `context.mode`（那是 `game.mode`）。**验证**：`companion-contract` 13/13、`companion.test.js` 87/87、`test:unit` 580/580。**反证**：撤回两个源文件后同一套用例 **4 条变红**；删掉 `MOOD_ECHO` 的「好难」，`import('./src/coach/companion.js')` 立即抛 `Error: 心情文案分叉：好难 拼不出整句`。**顺带**修掉 `COMPANION-NONINTRUSION.md` 的 P1 旁注自相矛盾（原文写「20 个里最多 2 个开口」，而同一张表的窗口数是「该沉默 86」——20 是**该说话**那一列的数，已改成 86 → 最多 8，并写明绝对条数跟着窗口数走） | `src/coach/companion.js`、`src/coach/runtime.js`、`tests/evals/companion-contract.test.js`、`docs/roco/COMPANION-GAP-AUDIT.md` §10 |
| **第 44 轮（P0-4 开发者抽屉）** | 导语只留人话；工程说明 / 数据版本 / `data-roco-*` 验收钩子 / 验收清单全部移进**默认收起**的 `#about-drawer`；顶部状态与规划状态里的「状态版本 / 覆盖 / 超时」清出玩家区。**判据口径的关键取舍**：折叠的证据区与抽屉都被排除出「玩家可见区域」，但排除之前**先断言它们真的默认收起**——否则「排除」就成了放过。`demo-acceptance` 新增 4 条判据 | `src/client/roco.html`、`src/client/roco.js` |
| **第 44 轮（P0-5 本机模型对照面板，真实链路）** | 抽屉内「问一次本机小模型」→ `/api/roco/shadow`；面板并列**规则引擎的行动建议**与**本地模型的工具提议**（真实 v4 适配器，实测 ~435 ms），并显示提示摘要钉子。**纪律**：面板用的是**发布评测那一份提示**（`shadow-tools.js` 把 SHA-256 钉成 `PROMPT_DIGEST_PIN`，改一个字符就红），否则是另一个实验挂着同一个名字。**我自己第一版错了**：给规则侧硬塞了 `tool:'query_rules'`，模型若也选它就会显示「一致」——那是**编出来的一致**（规则引擎从不选工具，它选动作）。现在两侧标注 kind 不同、`comparable: false`，note 按真实语义另写 | `src/coach/shadow-tools.js`、`src/server/roco-service.js`、`tests/evals/shadow-tools.test.js` |
| **第 44 轮（P0-6 口径诚实性审计 + 一处真违规）** | `tests/evals/claim-honesty.test.js` 扫 **90 个文件**，判「数字怎么用」而不是「有没有」；**6 类窄放行**各注明理由，且断言**每条放行至少被实际用到一次**（防「空检查器全绿」）。宽口径在位断言：`1,617/1,752` + `退化 42` + `扳回 0`。玩家页面无法打开 `on`（直接执行 `localModelMode()` 验证 `{}`/`''`/`'OFF'`/`'莫名其妙'` 全部 → `off`）。**扫出并修好一处过期陈述**：`AGENT-TRAJECTORIES.md` §5 仍写「模型候选那一半仍未完成、需要 DeepSeek key」，与台账及 W4-02 §5 直接矛盾——已改为 1,752 口径 + 配对结果 | `tests/evals/claim-honesty.test.js`、`docs/roco/AGENT-TRAJECTORIES.md` |
| **第 44 轮（提示常量去重）** | `LOCAL_TOOL_SYSTEM` 原来在 `scripts/roco/agent-trajectories.mjs` 与 `src/coach/` 各有一份；两份漂了会让「面板里的模型」与「评测里的模型」不是同一个实验，而**看不出来**。现只在 `src/coach/shadow-tools.js` 定义，脚本 import 后原样 re-export（保持 5 个调用点的命名导出不变）。摘要逐字节不变，仍被已发布产物钉着 | `scripts/roco/agent-trajectories.mjs`、`src/coach/shadow-tools.js` |
| **第 43 轮（P1 真实失败样例：气泡是同一个句式换数字）** | 用户实测原话：气泡反复只说「某技能这一手不稳…先看区间再定（最坏尾部…）」，**明确感知为没用**。机制定位：`rocoHintText(plan)` **只拿得到 planner 结果**，看不到局面，于是每一手「脆」都落到同一句。旧函数**已删除**，改为 `src/coach/coach-advice.js`：11 个局面检测器按优先级取第一个成立的，**没有局面事实就沉默**（产品口径：无稳定优势时可沉默），每条给「做什么 / 为什么是现在 / 一个关键风险」，工程术语只进展开证据。**引擎层验收**：`tests/evals/roco/coach-positions.test.js` —— 10 个**隔离**的真实局面，逐例断言期望 kind，绿；**7 种形状 / 6 种 kind**。**浏览器验收**：`demo-acceptance` 跑 6 局真实对局、从 DOM 收 23 次气泡 → **6 种形状、最大占比 35%、无工程术语** | `src/coach/coach-advice.js`、`docs/roco/COACH-ADVICE-DESIGN.md`、`tests/evals/roco/coach-positions.test.js` |
| **第 43 轮（追伤害预览为什么一直是空 → 三个真 bug）** | ① **`SideState.to_dict()` 不序列化 `loadouts`**，而 `from_dict` 一直读它 → 私有域每次往返都丢配招；页面的 plan 路径先走 `/battle/legal` 反序列化一遍，于是规划器**退回「全部可学技能」当候选池**（与真实合法动作不是同一套），伤害预览也永远找不到攻击技能。守卫 `roco/tests/test_state_roundtrip.py`（整份字典比对 + 反向对照）。② `RocoClient.planActions` **从不转发 `damagePreview`**，而桥一直在传——「接上了但不生效」第 4 次；顺带把 `reason` 带出去，不可用时页面能说清为什么。③ 两个基准脚本的**测试写到入库路径**：自第 11 轮起 `--positions 6` 的自检就把完整样本覆盖了。已加 `--out` 让测试写临时路径，并加**入库样本下限守卫**；两份产物在修好的引擎上重建（benchmark 6 → **191** 个局面）。数字变化是**输入变了**，不是调搜索 | `roco/src/roco_env/schema.py`、`src/coach/roco-client.js`、`roco/tests/test_microcase_harness.py`、`reports/roco/planner-benchmark.json` |
| **第 43 轮（Git 提交者身份）** | 用户问「为啥提交者是 pet-coach-game」。查明：**仓库本地** `user.name/user.email` 覆盖了全局身份（`SeRendizc <serendizc@gmail.com>`）。已改回本地配置与全局一致；本轮的提交已用用户账号署名。**历史提交不重写**（已推送，重写要 force push，风险大于收益） | `git config --local` |
| **⏩ 优先级切换（第 42 轮，用户指令）** | release gate 收尾后**立刻切到「玩家可试玩的旗舰 Demo」**，**暂停继续扩模型 / 刷内部评测**。原因：用户实测 `/roco.html` 反馈「非常差」，复核属实——**这页目前是验收夹具，不是产品 Demo**。分阶段计划与工期见 `docs/roco/DEMO-PLAN.md`：**P0 可玩 ≈ 7—9 轮**（数据面分离 / 事件中文化 / 战斗 UI / 开发者抽屉 / shadow 对照 / 诚实口径 / 产品验收）、**P1 可展示 ≈ 5—7 轮**、**P2 旗舰 ≈ 6—10 轮**（多块被外部条件卡住，不计入 P0 工期）。模型与评测线**暂停但不回滚**，产物与原位文档保留 |
| **P0 的 7 条问题（都已定位到代码）** | ① `pet_000225` 占位：`_sim_envelope` 把 `public_planner_state`（Agent 最小协议，**刻意不含 name**）同时当浏览器 UI 状态 → 新增并行的 `ui_public_view`，**不动** `coach_planner_state`；② 事件把 `kind`+JSON 搬给玩家（`roco.js:140`）→ 中文化 + 原始 JSON 进默认隐藏的调试折叠区；③ 无形象/系别/技能说明/阵容选择 → 把规范化数据里的 **12 只精灵 + 824 个技能**真正用起来（**不抓官方图**，用自制色块/剪影/emoji）；④ 面向玩家的 `fail closed` 工程话与 `data-roco-*` 验收钩子 → 移进开发者抽屉；⑤ 看不到本地模型选工具 → 抽屉里加 shadow 对照面板（明确**不替代 planner**）；⑥ 口径只能用 **1,752 = 92.29%**、共同 864 窗口**退化 42/扳回 0**，**不得**用单世界 275/288 掩盖，**不开 `on`**；⑦ 补产品验收（无 ID 占位 / 无裸 JSON / 能打完一局 / 提示自动出现·可静默·旧建议失效 / 局末教学 / 陪练自然 + 截图） |
| **机器（第 41 轮更正）** | `sysctl`：`machdep.cpu.brand_string` = **Apple M5 Pro**、`hw.model` = `Mac17,9`、`hw.ncpu` = **15**、`hw.memsize` = **48 GB**（统一内存，无独立显存）。`models/registry.json` 的 `device` 段记的是同一组值。**这就是路线图写的目标机器**——旧断点里「本机不是 M5 Pro 48GB，所以 W4-03/W4-04 硬件阻塞」是**读错了前提**，已更正（§1.7） |
| **模型身份（可核对锚点）** | 基座 `mlx-community/Qwen3.5-4B-4bit`（`Qwen/Qwen3.5-4B` 的 4bit 量化，revision `0e7ffd5c62`，apache-2.0），落在 gitignore 的 `.models/mlx/`；`npm run model:verify`：**逐文件 SHA256 校验 11/11 通过**。适配器 `.models/adapters/qwen35-4b-tool-v4/adapters.safetensors`（16,247,908 字节），**sha256 `362cc02087177eb5b61e185d324630aa8319408ebb2b64ff1c37c9c5bd9e33d6`**；工具选择提示摘要 `a5cb0fbcc53fbecd…`。运行时 `.venv-mlx`（Python 3.12.14 + **mlx-lm 0.31.3**，Metal GPU） | `models/registry.json`、`reports/roco/shadow-replay-sft-v4.json` 的 `identity` |
| **网关健康（活体实测，第 41 轮）** | `/healthz`：`ready true`、`ok true`；并发上限 **1**（active 0 / queued 0）；最近一次 首 token **293.7 ms**、总 **371 ms**、**16.17 tok/s**、峰值内存 **3.37 GB**；进程生命周期 **requests 1970 / timeouts 0 / cancelled 0**。第 14 轮冷启动基准（更干净的口径，无并发噪声）：首 token p50 **214.5 ms** / p95 318.1，总 p50 **362.9 ms** / p95 470.5，**29.8 tok/s**，峰值 **2.51 GB**，结构化输出合法 **8/8** | `/healthz`、`reports/roco/local-model/bench.json` |
| **失败降级（`off`/`shadow`/`on` 三档）** | 22 项测试（`tests/evals/local-model.test.js`）逐条覆盖：**`off` 档本地进程一次都不启动**（回滚开关的证明，不是「默认值对了」）、超时到点 reject 并计 `timeout`、推理进程崩溃时在途请求**立刻**失败（不各自等满超时）、`AbortSignal` 取消立刻释放、上游 `ok=false` 不许拿空字符串冒充成功、provider **一定**回退且把原因留在 `lastFallback`、没有 fallback 就**不允许**构造 provider、网关 504/429/**501 stream** 各返回正确形状。`shadow` 档还有一条只看「两次真实请求返回是否逐字相同」的契约测试 | `tests/evals/local-model.test.js`、`tests/server.test.js`、`docs/roco/LOCAL-MODEL.md` |
| **SFT v4（本机训完、过预注册门槛）** | 数据 1,752 条（train 1,395 / val 306 / test 51，`strict` 机制留出；**逐字节可复现**，由 `verify-sft-split.mjs` 在临时目录重跑比对）。LoRA r=8 / 8 层 / 900 iters / lr 1e-5 / mask-prompt / seed 20260921；train loss **0.001**、val loss **0.003**、峰值内存 **16.13 GB**、可训练参数 0.096%。**288 条门禁 275/288 = 0.9549**（`p50 435 ms` / `p95 1054 ms`、`invalid-arguments` **0**）；**family 留出 0.9271、机制留出 0.9259**；相对 v2 逐任务**退化 3、扳回 10**。预注册 P1—P8 **八条全过**（判据跑前写死） | `docs/roco/W4-04-SFT-PREREGISTRATION.md` §6、`reports/roco/shadow-replay-sft-v4.json`、`reports/roco/sft/train-v4.log` |
| **本轮轨迹验收（两条链，同一把尺子）** | **规则臂** `agent-trajectories-v1.jsonl`：6,048 条 / 23 个世界 / 7 arm，结构 + 离线回放 **6,048/6,048**，正向对照 `replay` **864/864**，反向 **17,760 个变体全部判挂**（11 条判据覆盖），另有**生产者一致性**检查（3/3 注入判红 + 真实旧选法快照反例）。**模型臂** `agent-trajectories-model-v1.jsonl`（v4 适配器）：**1,752 条**（每任务取满 9 个可用世界 = 世界池决定的天花板），结构 + 离线回放 **1,752/1,752**，反向 **5,988 个变体全部判挂**，按类别 **1,617/1,752 = 0.9229**（`roster_constraint` 111/216 是唯一弱项）。**逐条配对**：与规则臂共享的 864 个窗口上**退化 42、扳回 0**。**两条独立代码路径在同一批 288 个窗口上判定逐条一致**（轨迹生成器 vs 影子回放），且适配器 sha256 相同 | `reports/roco/agent-trajectories-verification.json`、`reports/roco/agent-trajectories-verification-model.json`、`tests/evals/roco/model-trajectories.test.js` |
| **Windows 3060（明天处理）** | 用户指令：本轮只做 Mac。3060 那台负责 LightGBM / 小网络 / 环境 profiling / rollout，**不与 Mac 拼显存**。本轮的模型训练与推理**全部在 Mac 上完成**，没有依赖 3060 | — |
| **第 41 轮（W4-02 的第二半用本地模型补齐，不再等 key）** | W4-02 的「模型候选轨迹」一直记成「要 DeepSeek key」。第 39 轮之后这个前提不成立了：本机有真的接进链路的工具选择模型（v4 适配器，288 条门禁 275/288）。本轮把 arm 扩成**模型臂**（`ARMS.local_4b`，`makePlanner` 注入 `ask`，没有注入就**抛**——不许安静退化成一个规则臂），用同一套判定器、同一个回执摘要、同一套 `(任务, 世界)` 选择产出 `tests/evals/agent-trajectories-model-v1.jsonl`：**1,752 条**（每任务取满 9 个可用世界；**天花板就是 1,752**，由世界池决定）。**结构 + 离线回放 1,752/1,752 全过**，反向对照 5,988 个变体全挂；按类别 **1,617/1,752 = 0.9229**（`roster_constraint` 111/216 唯一弱项）。**与规则臂在 864 个共同窗口上逐条配对：退化 42、扳回 0**——所以用途是候选与困难样本，不是替换规则。**最有价值的守卫**：轨迹生成器与影子回放是两条独立链，在 288 个共同窗口上**判定逐条一致**（第一版按类别总数比，红了——但那不是尺子分叉，是窗口集不同（9 世界 vs 1 世界）。教训：比数字前先确认两个数字量的是同一批东西）。**预注册订正**：M1 原来抄了 W4-02 的「≥2,000」，跑前量天花板发现只有 1,752，已可见订正为 ≥1,700。**顺带**：`start-mac.sh` 原来只看 pidfile 就打印「已在运行」并退出 0，而实测网关进程活着、MLX 子进程已死（`/healthz` 503）——已改成以 `ready:true` 为准并自动重启；`gatewayAsk`/`modelIdentity` 抽成共用模块（两处各写一遍必然漂移，且两者互相 import 会成环）。**抽的时候自己犯了个错**：按注释边界剪切，把夹在两个注释之间的 `pickFreePort`/`replayTask`/`summarise`/`bySplit`/`compare` 一起删了（230 行）——`tests/evals/shadow-replay.test.js` 几秒内就报了 `compare is not a function`。按 git 里的原文逐段补回后全绿。**这正是那批测试存在的意义**：模块被搬动时，先说清楚哪些东西不该跟着走 | `docs/roco/W4-02-MODEL-CANDIDATES.md`、`tests/evals/agent-trajectories-model-v1.jsonl`、`tests/evals/roco/model-trajectories.test.js`、`scripts/model/start-mac.sh` |
| **第 41 轮（SFT 把失败换了一种形状）** | 同一套失败分类器在两个来源上的对比：基座 63 条错（`asked-nothing` **34**、`wrong-args` 15、`wrong-tool` 13、`stopped-without-tool` 1）→ SFT v4 之后 **135** 条错（`asked-nothing` **0**、`stopped-without-tool` **90**、`wrong-args` 36、`wrong-tool` 9）。**读法**：SFT 把「连合法输出都给不出」清零了（与 `invalid-arguments` 93→0 一致），但失败**搬到了另一处**——模型现在格式全对、却**选择停下不查**（90 条，其中 `roster_constraint` 占 105 条）。**下一步该补的数据因此很明确**：不是继续教格式，而是教「有具体事实问题时不要停」+ `roster_constraint` 这一类。目录溯源：`source_sha256` 与产物逐字节对得上；`build-model-error-trajectories.mjs` 现在两种源形状都认（`shadow-replay-*.json` 与 `agent-trajectories-*.jsonl`） | `tests/evals/roco/model-error-trajectories-v4.jsonl`、`scripts/roco/build-model-error-trajectories.mjs` |
| **第 40 轮（分歧格仲裁：部分支持，且否掉一个看似自然的读法）** | 第 39 轮把「规则要开口 vs 判定层抑制」的分歧量成 54 条，但没判谁对。本轮用**引擎自己的风险分支**（`risk.fragile` / `risk.downside_max`，规则与判定层**都没用**它）加「深度 3 / beam 8 重规划」（引擎的 MAX_DEPTH/MAX_BEAM，取满）当第三方，判据跑前写死在 `docs/roco/W5-04-ADJUDICATION.md`。结果：**A1/A2 成立**——引擎标 `fragile` 且规则本来要开口的窗口**10 条全部落在被抑制一侧**（一致格 0 条），`downside_max` 中位数 0.33 vs 0.14；**A3 不成立**（深度改变推荐率 0.444 vs 0.417，差 1 个窗口，不当作支持）；**A4 给出反向的复杂性**：`margin` 与 `downside` 在规则开口层几乎无关（ρ=−0.04）、在被抑制段强正相关（ρ=+0.77）→ **「margin 小 ⇒ 推荐脆」是错的**，层的阈值只是在**这一批样本**上恰好把 fragile 排除在外。结论记成**部分支持**：够留在 shadow 可观测，**不足以**打开 `on`（仍需 W5-05 真人盲评）。顺带量出两件要一起报的事：规则的 44 条 fragile 里有 **34 条落在「规则根本不说话」的血量档**；**推荐在深度 +1 后 44% 会翻**（页面把 `recommendation` 当结论展示，这是产品口径问题，另开预注册再改） | `docs/roco/W5-04-ADJUDICATION.md`、`reports/roco/intervention-agreement.json`、`scripts/roco/check-intervention-agreement.mjs` |
| **第 39 轮（判定层在真实链路上从来没生效过：第三次「接上了但不生效」）** | 用**真实 bridge 产物**量了一次：`/api/roco/plan` 把 `first_second_margin` 发成**对象** `{min,max,mean,scale,note}`，而 `rocoPlanFeatures` 用 `Number.isFinite` 读它 → `Number.isFinite({...}) === false` → `margin = null` → 判定层退回 sigmoid 兜底口径（概率恒 0.95、`threshold 0.88`）→ **永远放行**。也就是说第 21、30 轮之后这一层**又一次**没生效，而第 30 轮那条「端到端守卫」是绿的——因为**它自己捏了一个标量** `first_second_margin: mean`，服务端从来不这么发。已修：`firstSecondMarginOf()` 认对象（取 `mean`）也认标量；守卫改成走**真实路由**，并新增 `firstSecondMarginOf` 的正反两向断言 | `src/coach/roco-experience.js`、`tests/evals/roco/intervention-margin-chain.test.js` |
| **第 39 轮（量出规则的 `decisive-gap` 分支是死代码）** | 修完之后量 2×2，发现 `gap = expected.max - expected.min` 在 **192/192 个运行时窗口里恒为 0**（直接量引擎也一样：3 个分析种子 × 11 个局面，`expected` 与 `first_second_margin` 逐位相同）。原因是服务端跨种子聚合时 `plan_actions` 在重建状态上是确定性的 → 区间宽度恒 0。后果：`decisive = (gap>5) || risk>=0.8` 只剩右边；`value = 3*risk + 1.2*min(gap/5,1)` 第二项恒 0；**规则在手游侧只按血量档位说话**（`speaks ⟺ hp_ratio <= 0.6`）。这把 §12.4 的「两个量同源不同义」修正为更强的一句：**规则侧根本没有这个量**。顺带修掉面向玩家的失真——页面原来写「期望区间：0.58 ~ 0.58」，现在按真实形状说话 | `docs/roco/W5-04-SUPPRESSION-VS-RULE.md`、`src/coach/roco-experience.js` 的 `expectedLine`、`tests/evals/roco/intervention-agreement.test.js` |
| **第 39 轮（把「抑制 ≠ 规则犯错」量出来）** | 那个开放问题原来的答案是「一致性没有被验证过」。现在用真实链路量出 2×2（240 个窗口 / 192 进评分）：规则要开口的 **78** 个窗口里，判定层抑制 **54** 个（69%），这些窗口 `margin` 中位数 **0.0363**（阈值 0.1465）；两边都说的 **24** 个窗口 `margin` 中位数 **0.8953**。**准确含义**：规则仅凭血量说「该提醒」时，层追问「规划器分得开这两手吗」，分不开就不给具体推荐——不是规则算错了，是两类证据在争谁说了算。**一局之内提示条数不变（24 vs 24），但两个窗口集合完全不相交**：层把预算从「只按血量触发的窗口」挪到了「边际量分得开的窗口」。契约检查：只抑制违反 0、门控反证 **120/120 命中且开口 0**（5 类门控 × 24 局）。**S6 第一版是空过的**：我把 `dismissed` 放进了 `host`，而代码读 `session.dismissed`，门控没触发却被算成通过——空过的检查比没有检查更危险 | `reports/roco/intervention-agreement.json`、`scripts/roco/check-intervention-agreement.mjs` |
| **第 39 轮（两条守卫没接进任何套件）** | `test:unit` 用的是**显式文件清单**，而第 38 轮新加的 `model-arm-identity.test.js`（以及本轮的 `intervention-agreement.test.js`）**不在里面**——也就是那两条守卫从来没在任何套件里跑过。守卫不跑等于没有守卫。已接进 `test:unit`，并补了两个入口脚本 `roco:intervention-agreement`、`model:measure-arms` | `package.json`、`tests/evals/roco/model-arm-identity.test.js` |
| **第 38 轮（模型臂成绩存档错位：一处「文档说得通、产物对不上」的事故）** | 给轨迹集补「生产者一致性」检查时顺手查了模型臂的存档，发现 **`-sft-v2.json` 里装的其实是 v1 的成绩、`-sft-v3.json` 里装的是 v2 的、真正的 v3 一个产物都没留下**——而文档与台账一直照着这组对不上号的数字往下走。根因三条：① 报告里**没有模型身份**（只有 arm/gateway/prompt_digest），错位看不出来；② 运行器每次写到同一个 `-local_4b.json` 再由人工改名；③ `stop-mac.sh` 找的 pid 文件名（`serve.pid`）**从来没被写过**，所以「停网关」是空操作——换适配器时旧权重还在跑。**根因修复**：报告加 `identity`（模型/适配器/权重 sha256/提示摘要）、`--out` 显式产物路径、`stop` 改认 `gateway.pid` 并按端口兜底、一键重测脚本 `measure-arms.sh`、守卫 `model-arm-identity.test.js`（正反两向）；报告另加 `by_split`（家族/机制/模板的留出 vs 见过切片——原来只有总分，泛化差被盖住）。**重测（判据跑前写死在预注册文档）**：基座 225/288、v1 229、v2 268、v3 **204**、**v4 275/288（0.9549）**；v4 相对 v2 逐任务**退化 3、扳回 10**；`roster_constraint` 8→**13/24**、`rules_lookup` 68→**70/72**、`invalid-arguments` 0、family 外 **0.9271**。**预注册 P1—P8 八条全过**。旧错位存档挪进 `reports/roco/invalidated/` 并写明每一份实际是什么 | `docs/roco/W4-04-SFT-PREREGISTRATION.md`、`docs/roco/SHADOW-REPLAY.md` §7、`reports/roco/invalidated/README.md`、`tests/evals/roco/model-arm-identity.test.js` |
| **第 38 轮（SFT 数据的自我描述说错了，并补上缺失的验证器）** | `build-agent-sft-data.mjs` 的 `split_rule` 是一句**写死的话**（「留出表达模板，每个家族与每个机制都在训练侧」），而实际用的是 `strict`（**留出机制**）——报告在描述另一种切分，且没有任何检查会发现；`holdout_leak` 字段装的其实是「实际不在训练侧的值」，把**留出成功**报成泄漏，还让脚本在正常配置下返回退出码 1；`counts.families_by_side` 存的是 `Set`，JSON 序列化成 `{}`，那一栏永远像空的。另：文件里引用的 `verify-sft-split.mjs` **根本不存在**（注释声称「独立复核」是假的）。三处都修，并**真的写了**那个验证器：按报告声明的模式重算全部样本、与盘上三份 jsonl 逐项对账、检查目标工具在契约内、三侧无重复，最后在临时目录**重跑生成器并逐字节比对**（1,752 条数据 + 报告全部逐字节可复现）；`--selftest` 7 个注入全被抓住。已进 `verify:release` | `scripts/roco/verify-sft-split.mjs`、`scripts/roco/build-agent-sft-data.mjs`、`reports/roco/sft/dataset-report.json` |
| **第 38 轮（轨迹集按修好的采样器重建 + 生产者一致性检查）** | 第 37 轮修了 `worldsFor` 的步长 bug，但**轨迹产物没重建**：产物内部完全自洽（结构全过、回放全过、判定器两向都对），却仍是旧采样器选的世界——三个条件类目每个任务只覆盖 **1** 个世界。重建后 **4,536 → 6,048 条**、世界 **12 → 23**，三条反证臂的通过率随之变化（`stubborn` 0.889→0.750 等，原因是那三类的分母从 36 涨到 108）。新增 `producerCheck`：把生成器的世界选法重算一遍与产物逐对比较，并核对 `manifest` 与 `jsonl` 两份产物的头部一致；`--selftest` 3/3 注入判红，另用**真实旧选法快照**（`tests/evals/roco/producer-drift-v1.json`，287/288 个任务不一致）当反例。**顺带修掉一个自伤**：`worldsFor` 返回的是世界对象、产物里记的是 `world.id`，第一版拿对象比字符串，于是 288 个任务全报「不一致」——检查红了，但红的原因是检查自己写错了 | `scripts/roco/verify-agent-trajectories.mjs`、`tests/evals/roco/agent-trajectories.test.js`（9 项）、`docs/roco/AGENT-TRAJECTORIES.md` |
| **第 38 轮（台账里两条不实陈述）** | ① W4-03/W4-04 记的是 `NEEDS_HARDWARE`，理由是「本机不是 M5 Pro 48GB」——**本机就是 Apple M5 Pro / 15 核 / 48 GB**（`sysctl`）。profiling 与四轮 LoRA 都在本机跑通了，于是改成 DONE / PARTIAL；② W5-01 记的是 `NOT_STARTED`，而 OpenAI 兼容网关早已落地并在跑。两处都按证据改写。台账里凡是能**从产物读出来**的数字（轨迹条数、世界数、反例变体数）已改成运行时读取，不再手抄 | `scripts/roco/build-progress-dashboard.py`、`docs/roco/PROGRESS.md` |
| **第 37 轮（找到「加不出数据」的真因：取样取模 bug）** | 第 36 轮加世界池后 `tool_failure`/`stale_state` 仍只有 1 个可选世界——原因不在过滤器，在取样：`(seed + i * 3) % eligible.length` 在 `eligible.length` 也是 3 的倍数时（这三个条件世界恰好各有 3 个变体），`i*3` 模 3 **恒为 0**，每个 i 都取同一个世界。改步长为 1 后：普通类别 4→**9**、三个条件类别 1→**3**。**288 条任务可产出窗口 828→1,752**；SFT 训练侧 **552→1,395**。这个 bug **同时影响轨迹集与 SFT 数据**（共用 `worldsFor`），也是前三次切分对比里「留出总要牺牲覆盖率」的一半原因 | `scripts/roco/agent-trajectories.mjs` 的 `worldsFor`、`docs/roco/SHADOW-REPLAY.md` §5.5 |
| **第 35 轮（v3 模板留出：**更差**，负结论留痕）** | 按「留出维度该选模型能泛化的那个」试了 v3：只留出**表达模板**（`直问`+`背景`，42% 任务），家族与机制在训练侧全部出现；留出集是**穷举**出来的（约束：每个机制在训练侧至少留 2 条）。结果 **205/288（0.7118），比基座还差**：`rules_lookup` 13/72、`roster_constraint` 0/24。两个原因如实写：① 训练样本被砍到 **306**（v2 是 552），**所以 v2/v3 不是干净对照**——同时改了两个变量，不能把差异全归给切分维度；② 留出的 `直问`+`背景` 是最常见的两种问法，最典型句式一次都没练过。**v2 仍是最佳**（0.9306），保留为当前最佳适配器；v3 的产物与负结论都留着。真正的下一步是**把训练数据做大**（现在只有 288 任务 ×4 局面），而不是继续换切分维度 | `reports/roco/shadow-replay-sft-v3.json`、`docs/roco/SHADOW-REPLAY.md` §5.4 |
| **第 34 轮（换切分重训：0.7813 → 0.9306）** | 按上一轮写好的下一步做了：SFT 改用**专属切分**（留出**机制与模板**，每个家族都进训练）。评测口径一个字没改。数据 828 条中 train **552**/val 177/test 99；600 iters，**val loss 1.214 → 0.005**。结果：通过 **268/288（0.9306）**、`invalid-arguments` **93 → 0**、`rules_lookup` 32→**68**/72、`roster_constraint` 3→8/24、p50 401 ms。**剩余 20 条退化全在两处**：roster 16 条（全落在被留出的 `阵容诊断` 机制，只输出 stop——正是「留出机制」该有的表现）、rules_lookup 4 条（参数仍不对）。即：**上一轮缺一个家族，这一轮缺一个机制**。要可部署需要在机制维度补数据，不是继续调参 | `reports/roco/shadow-replay-sft-v2.json`、`docs/roco/SHADOW-REPLAY.md` §5.2–5.4 |
| **第 33 轮（第一次真的 SFT：本机跑通，但结论是不能上线）** | 用 mlx-lm 在本机（M5 Pro 48GB）跑完第一次 LoRA：828 条数据（目标来自**任务期望**）、r=8/8 层/300 iters、13 分钟、峰值内存 **16.1 GB**、train loss 0.029、适配器 16MB。**W4-04 的「硬件阻塞」在这台机器上并不成立**——之前把「目标机器是 M5 Pro 48GB」误读成「本机做不了」。同一把尺子量：通过 **225→229**、`invalid-arguments` **93→20**、p50 延迟 **575→407 ms**；但 **`roster_constraint` 3/24→0/24 归零**。**原因是切分设计**：那 24 条全在 test 家族，而 SFT 的 train/val 里没有这个家族（训练数据每条都带 team/locked_pet），模型在该家族上 24/24 只输出 stop。family 隔离把这一点如实暴露出来了——**适配器不可部署**，但管线（数据→训练→接适配器→同一把尺子）全部跑通 | `reports/roco/shadow-replay-sft-v1.json`、`docs/roco/SHADOW-REPLAY.md` §5 |
| **第 32 轮（数据溯源从散文变成检查）** | 目标里「所有数据必须记录版本/赛季/来源/抓取时间/revision/SHA256/许可与核验状态」此前只靠人眼看。新增 `verify:provenance`：核对每条来源的**可核对锚点**（独立归档→archive_sha256 且能在 raw/ 里对上；子文件→逐文件清单里的 sha256；其余→许可与核验状态）、逐实体 `provenance.jsonl` 台账的必填字段、规范化数据的 ruleset_id 与来源指向。**真实数据现状：溯源完整**（8 份规范化文件、4 条来源、3 个归档哈希对上、18 条台账记录）。**过程教训**：这个检查器自己出了 **5 个 bug**，每个都把完整清单报成残缺——字段名写成 `id`/`sha256`（真实是 `source_id`/`archive_sha256`）、块标量续行没处理、「缩进更深」写成「≥」、字段名正则漏数字（`archive_sha256` 含 256）、把末尾 `license_summary` 的条目当成来源。**手写解析器必须用真实文件验证**，不能靠推理 | `scripts/roco/verify-provenance.mjs`、`tests/evals/provenance.test.js`（6 项） |
| **第 31 轮（状态文档与现实的一致性检查）** | 第 30 轮的教训是「文档说生效、实际没生效」，而文档漂了之后每个读它的人都在错的前提上做事。这轮把**机器可核对**的几项做成检查：声明的 HEAD 必须仍是当前历史的祖先（允许落后，但落后 >12 个提交要报）、`latest.json` 必须是 pass、文档引用的每条 `reports/...` 路径必须真的存在。**第一次跑就抓到一个**：变更记录引用的 `G02-MODEL-2026-09-21.md` 不存在（实际是 `-v1.md` 与 `-v2.md`）。进 `verify:release` 清单；带反证（假 HEAD、缺失产物路径都必须被判出来）。**明确它不核对散文里的技术断言**——那些只能靠代码与量测 | `scripts/roco/verify-state-doc.mjs`、`tests/evals/state-doc.test.js`（5 项） |
| **第 30 轮（把判定层真正接通：两个真缺陷，都在搬运环节）** | 第 21 轮只让它在**测试路径**上生效。去量**真实页面路径**发现它一直没生效，两个缺陷都不报错：① Node 桥（`src/server/roco-service.js`）组装 plan 响应时**没透传** `first_second_margin`；② 同一个量两侧**命名不同**——工具回执用 camelCase `firstSecondMargin`，页面 plan 用 snake_case `first_second_margin`，而 `rocoPlanFeatures` 只认前者，于是页面上永远返回 null。两处都修；**用真服务的端到端证据**：引擎 0.0293 → `rocoPlanFeatures().margin` 0.0293 → 判定层 `decided_by: margin-quantile`、`suppress: true`（修前是退回 sigmoid 口径、永远放行）。补一条专门守卫：断言最终的 `decided_by`，而不是断言某个中间字段存在 | `tests/evals/roco/intervention-margin-chain.test.js`、预注册文档 §13 |
| **第 29 轮（把假绿的教训变成约定 + 静态守卫）** | 第 28 轮的成因是「起子进程要清 `NODE_TEST_*`」只活在一次调试记忆里。这轮做成三件可检查的东西：① `tests/helpers/subprocess.mjs` 的 `cleanEnv()` / `runNodeSync()`；② 新增静态守卫 `subprocess-env.test.js`——扫所有测试文件，凡起 `node --test` 必须显式清环境，带反证；③ `verify:release` 也走同一套清理（它本身可能被测试调用）。**顺手修掉两个自伤**：扫描会把**注释里**的示例当调用（先剥注释）、会扫到**自己**的反证样例（跳过本文件）；注入登记表里那行 import 文本被仓库的「相对 import 必须存在」契约扫到 → 改成在函数体里插 import 调用。另：注入点的写法本身也成了约束——登记表不能往文本里塞相对 import | `tests/helpers/subprocess.mjs`、`tests/evals/subprocess-env.test.js`、`reports/roco/verification/round29-*.log` |
| **第 28 轮（把守卫自检自动化，并在自动化过程中又踩到一个真缺陷）** | 手工抽样变成登记表 `npm run guard:selftest`：**7 条注入**，每条写明抓的是什么，跑完无论成败都恢复；复验 **7/7 全红**。加进 `verify:release`（8 秒），**刻意不放进 `test:unit`**——它逐个改写仓库文件，与并行单测放一起会互相读到注入中的状态（实测把结构契约搞成偶发红）。**自动化过程中又发现一个真缺陷**：从 `node --test` 里再 `execFileSync('node',['--test',…])` 时，子进程继承 `NODE_TEST_CONTEXT=child-v8`，于是**不按参数跑那个文件、永远 exit 0**，自检把 7 条注入**全部报成「仍绿」**——真红被假绿盖住，而它出现在「用来发现假绿」的工具自己身上。修法 `childEnv()` 清掉那两个变量，并有测试钉住 | `scripts/roco/guard-selftest.mjs`、`tests/evals/guard-selftest.test.js`、`docs/roco/GUARD-SELFTEST.md` §3 |
| **第 27 轮（守卫自检：注入违规，看测试会不会红）** | 对 4 条守卫做机械注入自检（结构契约 / 报告装配 / 分类判据 / 判定层激活），**其中两条原本是绿的**——两个真实盲点：①「生成器改了但产物没重跑」没有任何守卫（其余用例在内存里重新 build，下游读的是文件）→ 新增子进程重生成 + 逐条摘要比对，并发现 `build()` **非幂等**（模块级累加器），所以必须走子进程；②「报告装配逻辑改坏」没有守卫（测试只读落盘报告）→ 把装配抽成纯函数 `buildShadowReport()` 直接测。修完复验：4/4 注入都变红。**如实记录这只是抽样**，不是「全部守卫都会红」 | `docs/roco/GUARD-SELFTEST.md`、`reports/roco/verification/round27-guard-selftest.log` |
| **第 26 轮（模型错误轨迹目录，并抓出一个不在模型身上的真问题）** | W4-02 的另一半：把模型臂失败的 **61 条**逐条给出程序可判定的失败分类与**候选**修复（`asked-nothing` 34、`wrong-args` 13、`wrong-tool` 13、`stopped-without-tool` 1），每条 `verified:false`——没有任何一条被重新执行验证过。**目录抓出一个真问题**：2 条 `tool_failure` 失败账面像模型文案问题，实际是 `finalAnswer()` 的模板在「引擎答不了」这一支上不诚实（模型查到了 ok 回执就转通用回答，没先说清答不了）。修模板后 `tool_failure` 34/36 → **36/36**，模型臂 **0.7813 → 0.7882**。分类全部落到已知类（0 unclassified），且有一条守卫要求**每个分类都必须能被构造样本触发**（空桶 = 判据写错） | `tests/evals/roco/model-error-trajectories-v1.jsonl`、`scripts/roco/build-model-error-trajectories.mjs`、`tests/evals/roco/model-error-trajectories.test.js`（6 项） |
| **第 25 轮（把「单测绿、页面挂」变成结构契约）** | 第 24 轮那个回归（浏览器模块图里出现静态 `node:*`）只被浏览器验收抓到，`test:unit` 完全看不见。这轮把它前移成静态检查：**扫每个页面入口的模块图，禁止静态 `import` Node 内置模块**，允许动态 import（浏览器根本不会执行它）。带**反证**：同一段扫描逻辑对「静态 node:fs / node:path / 相对 import / 动态 import」四种输入逐一断言，并核对仓库里那处动态 import **不会**被判违规——否则守卫会把正确写法判成错的。11 项结构契约全过 | `tests/evals/structure-contract.test.js`、`reports/roco/verification/round25-browser-guard.log` |
| **第 24 轮（修一个单测全绿、浏览器全挂的回归）** | 第 21 轮把 `experience.js` 接到 `intervention-model.js`，而后者顶层 `import node:fs` —— 该模块**在浏览器模块图里**，浏览器解不出 `node:*`，`app.js` 的整条 import 链静默断掉：页面标题与按钮都在，但开不了局。症状是 **demo-acceptance 失败、浏览器验收 3/9（原 9/9）**，而 `test:unit` 全绿（Node 里 `node:fs` 存在）。修法：把标定好的系数**当源码发布**（训练脚本同时生成 `src/coach/intervention-model.generated.js`），读盘只保留给 Node 侧工具的**动态** import。修后 9/9 + 16/16 | `reports/roco/verification/round24-browser-recheck.log`、`src/coach/intervention-model.generated.js` |
| **第 22 轮（同 Agent 回放门禁 W4-05 / W5-02，并用真模型跑出第一份对照）** | 门禁建成：同一任务集（288 条 / 8 类）、同一时代、同一判定器，**只换 provider**；模型只选工具、参数照常走引擎、状态版本由运行时覆盖、只问一次、拿不到模型就失败不回退。**用本机 Qwen3.5-4B-4bit 实跑**：规则臂 **288/288**，模型臂 **225/288（0.7813）**，p50 **574–585 ms**；逐任务对比**退化 62 / 扳回 0**，退化**全部集中在两类**——`rules_lookup` 41、`roster_constraint` 21，其余六类与规则臂持平；`invalid-arguments` **93** 次；重复性：同提示连跑两次逐项相同，首跑 226/288 → 抖动 **±1 条**。
**附一次失败的提示实验**：把契约参数名逐条写进提示后通过率反而 0.7813→0.7326
（`rules_lookup` 32/72→13/72，「什么都不查」多 27 次），默认保留 v1，负结论留痕。**这条结论直接指出 W4-04 该训什么**：不是教说话，是教把参数填对 | `scripts/roco/shadow-replay.mjs`、`docs/roco/SHADOW-REPLAY.md`、`tests/evals/shadow-replay.test.js`（12 项） |
| **第 21 轮（判定层接进真实页面路径，量出两处「接上了但不生效」）** | ① 判定层的 `phase/turn/legalCount` 只读调用方传的 `f.*`，而 `rocoIntervention` 不传这三个——手游链路上它们恒为 `null/0/0`，模型拿**残缺特征**给出概率且不报错。改成优先从投影局面读。② 修完特征后在真实路径上量：40 个运行时形状输入的概率**全是 1.000**，抑制一次都没触发（系数 8.2，边际量 0.01 就饱和）。把 `C` 压到 0.05 能缓解但召回 0.900→0.675、ECE 0.047→0.120，三条判据挂掉——**不拿更差的模型换更好看的行为**。改用**相对刻度**：边际量 < 训练侧 75 分位（0.1465，随模型落盘）即抑制，sigmoid 降级为诊断量；同一批输入抑制 16/40，判定层真的会动。③ 又踩一次 `Number(null) === 0`：「没有边际量」被当成「边际量 0」→ 永远抑制。已修。④ 写清口径差：判定层用**枚举 top1−top2**，规则用**期望区间宽度**，同源不同义，抑制 ≠ 规则犯错 | `docs/roco/W5-04-INTERVENTION-GATE.md` §12、`tests/evals/intervention-layer.test.js`（12 项） |
| **第 20 轮（陪练不打扰验收）** | 目标第 6 条那一半「不打扰验收」落地：预注册 `docs/roco/COMPANION-NONINTRUSION.md` 的 P1—P7，被测对象是**真实主动触发通道** `companionEvents`（不另写判定）。8 个固定种子逐回合重放：该沉默 86 个窗口**沉默率 0.9884**、该说话 20 个窗口**开口率 1.0**、硬边界（PVP / 预制体验 / 刚被点掉 / 显式安静）**违反 0**、每局上限 0 违规、同事实不重复 0 违规、每条话都有真实素材且过克制扫描、气泡时序 0 违规。**验收量出一个真缺陷**：`companionCueSlot` 把 `hold` 挂在 `queuedAt` 上，于是「上一条刚显示过、当前没有新消息排队」返回 `idle` 而不是 `hold`——防「一闪一闪」的机制被一个与之无关的条件短路了。已修并加测试。**这不是真人验收**：真人那一半仍是 W5-05（外部阻塞） | `reports/roco/companion-nonintrusion.json`、`tests/evals/companion-nonintrusion.test.js`（7 项） |
| **第 19 轮（判据重写 v2：全部通过）** | 第 18 轮的两条失败来自**判据退化**（规则在手游口径下几乎不开口，FPR=0，于是「误报 ≤ 0.75×0」恒假）。这一轮据此重写判据：`docs/roco/W5-04-INTERVENTION-GATE-V2.md` 的 H1—H8，把误报上限改成**绝对值**，并新增 H4（扫阈值找可达工作点）与 H8（判据自身必须有必过/必挂样例）。结果：**H1 TPR 0.900、H2 FPR 0.0000、H3 ECE 0.0465、H4 阈值 0.74 处 TPR 0.975/FPR 0.0162、H5 OOD TPR 0.9097/FPR 0.0023、H8 全部可判别 —— 全部通过**。**判据有牙的证据**：对照臂（去掉边际量特征、与规则同信息）在同一套 H 判据下挂掉 H1/H3/H4/H5。判定层因此获准进入 **shadow 可观测**；`on` 仍需真人审阅 | `reports/roco/intervention-model-roco-report.json`、预注册 v2 文档 |
| **第 18 轮（手游标定 v3）** | 用手游引擎自己的边际量重建窗口集（**2,544 条**，边际量 75 分位 **0.1465** 为阈值），重训并重过门槛：**G1 召回 0.900 vs 规则 0.075**、G3 校准 ECE 0.0465、family 外召回 0.9097；**G4/G5 未过**，但原因是**判据在本输入上退化**——手游口径下规则误报率是 **0**（389 个测试窗口只提示 6 个），「误报 ≤ 0.75×0」不可能成立。真实 2×2：规则 6 命中 / 74 漏掉，模型 **72 命中 / 8 漏掉**，两侧误报都是 0。消融去掉边际量后召回塌回 0.075 = 规则，说明这个量就是全部信息量。**判定层仍默认关闭** | `reports/roco/intervention-model-roco-report.json`、预注册文档 §10.5 |
| **第 18 轮（接通 + 发现不可通约）** | 把 `first_second_margin` 从 `PlanResult` 一路接到判定层（服务回执 → 工具回执 `firstSecondMargin` → `rocoPlanFeatures().margin` → `planner_margin_norm`），并用 plan-e2e 断言钉住它真的穿过真链路。**但量了两边分布后发现两把尺子不可通约**：旧演示引擎的一手推演分差中位数 **3.06**（37% 超 5），手游引擎的边际量 n=120 落在 **0.024—0.082**（100% 小于 0.5），**差约 100 倍**。所以 v2 模型的系数与 `GAP_SCALE=5` **不能**搬到手游链路上；要么重训，要么判定层在手游侧永不触发（当前就是后者）。**不改阈值去凑数** | `docs/roco/W5-04-INTERVENTION-GATE.md` §10.4、`tests/evals/roco/plan-e2e.test.js` |
| 第 17 轮**未接上的那一环（如实写）** | `planner_margin_norm` 在运行期**拿不到**：规划器回执 `PlanResult` 只有 `expected/worst/best`，没有「枚举第二名」。所以 v2 的通过是**离线**的，判定层在真实链路上**不会生效**（`rocoPlanFeatures` 只能传 null）。要生效必须先改 Python 服务让回执带出这个边际量——独立改动，本轮不做 | 预注册文档 §10.3 |
| 第 15 轮**结论：gate_failed** | G1 召回、G2 误报、G5 family 外通过；**G3 校准（ECE 0.1546 > 0.10）与 G4 阈值稳健未通过**。结构性原因：标签依赖**决策后**才有的分差，而特征只能用决策前的量，天花板本就低。**判定层不进入产品路径，保持默认关闭** | `reports/roco/intervention-model-report.json`、预注册文档 §8.1 |
| 第 15 轮修的两个真缺陷 | ① 第一次训练误用决策后方可得的分差当特征（口径错误，重训并留痕）；② shadow 模式**真的改了行为**——`interventionScore` 只看 `layer.suppress` 没看 `layer.active` | 同上；`tests/evals/intervention-layer.test.js` 的 shadow 用例 |
| 下一步（最高优先，不依赖外部条件） | **查清整局基准里的座位效应**（第 12 轮发现）：`greedy_damage` 的 player 座位配对差 **+0.250（p=0.002）**、enemy 座位 **−0.150（p=0.070）**。`step_joint` 是同时结算，所以不是「先手优势」；嫌疑是自驱动循环在补位顺序 / 合法动作枚举 / `PlannerPlayer` 持有的 state 视角上两侧不对称。**查清之前不得把座位效应写进任何产品结论** |
| ~~下一步：W5-04「抑制 = 规则犯错」的验证~~ | **第 39 轮已量、第 40 轮已仲裁**（`docs/roco/W5-04-SUPPRESSION-VS-RULE.md`）：规则要开口的 78 个窗口里层抑制 54 个，那些窗口 margin 中位数 0.0363；两边都说的 24 个窗口 margin 中位数 0.8953；一局内提示条数不变（24 vs 24）但窗口集合不相交。**同时发现规则的 `decisive-gap` 分支在手游引擎上是死代码**（192/192 个窗口 `gap = 0`），以及判定层此前**从未在真实页面生效**（第 21/30 轮之后第三次同形状复现）。都已修并加了守卫 |
| 再下一步（不依赖外部条件） | **重做 W5-04 的标签口径**：把标签从「玩家随后会怎么选（决策后）」改成**纯决策前的观察量**（例如「风险 ≥ 0.8 或必须补位」＝规则里的 `decisive`）。这是**重新定义问题**，要重写预注册再跑；不能在失败之后回头改口径。改之前判定层保持默认关闭 |
| 第 14 轮已交付（Mac） | 本地模型：manifest 可校验、一键 setup/start/healthcheck/stop、OpenAI-compatible 网关、feature flag 接入、21 项失败降级测试；实测首 token p50 ~214 ms、总 p50 ~363 ms、合法率 8/8。**待验**：与 DeepSeek 的质量对照（要 key）、人工审阅（要真人） |
| 外部依赖（不影响上面继续做） | **一个 DeepSeek key**——现在缺的不是「候选数据」（第 41 轮已用本地模型补齐 1,752 条），而是**云端臂对照**（「本地 vs 云端谁更强」本机答不了）；**3—5 位真人**（W5-05 盲评）；**一次游戏内实测 + 录屏**（E03 已验证那一半 / F03）。~~M5 Pro 48GB~~ ——**本机就是**，已从外部依赖里移除 |

### 2.2 交接基线（第 7 轮，保留原样）

| 项 | 值 |
|---|---|
| 仓库 | `/Users/serendizc/Developer/roco-coach` |
| 分支 | `master` |
| **HEAD（本轮开始时）** | `1717cd515e8d900e6f2ccccb8707a0a85a809989` |
| 交接包记录的基线 commit | `1717cd5` —— **一致**，无差异需要说明 |
| 开始时工作区 | **干净**（`git status --porcelain` 为空，0 条未提交修改） |
| 用户未提交修改 | 无。因此本轮不涉及「保护用户改动」的冲突场景 |

基线证据：`reports/roco/m0-baseline/HEAD.txt`、`reports/roco/m0-baseline/git-status.txt`。

**环境**（完整见 `reports/roco/m0-baseline/env.txt`）：

| 项 | 值 |
|---|---|
| Node | `v24.20.0` |
| npm | `11.19.0` |
| 系统 python3 | `3.9.6` |
| 仓库 `.venv-agent` python | `3.9.6` |
| OS | `Darwin 27.0.0 arm64`（Apple Silicon） |

---

## 3. 已完成事项及证据

| # | 事项 | 证据 |
|---|---|---|
| 1 | 读完交接包全部 8 份材料 + 仓库 README / IMPLEMENTATION-STATUS | 见本文件第 5 节「已读材料」 |
| 2 | 核对 Git HEAD、分支、工作区状态 | `reports/roco/m0-baseline/HEAD.txt`、`git-status.txt` |
| 3 | 记录 Node / npm / Python / OS 版本 | `reports/roco/m0-baseline/env.txt` |
| 4 | **全量基线测试通过 375/375** | `reports/roco/m0-baseline/npm-test.log`（详见第 6 节） |
| 5 | 下载并固定 3 份上游快照 revision + SHA256 | `data/roco/raw/*.tar.gz`、`reports/roco/m1-data/raw-sha256.txt` |
| 6 | 逐文件 SHA256 清单（603 文件 / 205.9 MB） | `reports/roco/m1-data/snapshot-file-inventory.json` |
| 7 | 许可状态台账 | `data/roco/sources.yaml` |
| 8 | 安全 Lua 文本解析器（**不执行**第三方 Lua），13/13 数据文件解析通过 | `scripts/roco/lua-safe-parse.mjs`、`scripts/roco/selftest-lua-parse.mjs` |
| 9 | normalized 数据：622 精灵 / 824 技能 / 312 学习表 / 120 属性组合 / 54 术语 | `data/roco/normalized/roco-world-s4-2026-09-10/` |
| 10 | 12/12 目标精灵解析成功，**孤儿技能引用 = 0** | `import-report.json` |
| 11 | 三来源交叉核验：24 处差异**全部**有解释，未解决冲突 = 0 | `data/roco/conflicts.jsonl`、`reports/roco/m1-data/cross-check.json` |
| 12 | 建立断点状态文件 | 本文件 |
| 13 | 页面/性能基线：`npm run test:smoke` 全部通过（14 张卡、属性筛选、进对局、16 次出招、无卡死、控制台零报错） | `reports/roco/m0-baseline/smoke.log` |
| 14 | 离线 eval 基线：`eval:retrieval`、`eval:balance:quick` 退出码 0 | `reports/roco/m0-baseline/evals.log` |
| 15 | **M0 仓库审计完成**（逐模块 KEEP/ADAPT/RETIRE/MISSING，含 5 条文档与运行态不一致） | `docs/roco/M0-REPO-AUDIT.md` |
| 16 | **许可矩阵完成**：3 个来源的许可、再分发等级、署名要求、禁用场景 | `docs/roco/LICENSE-MATRIX.md` |
| 17 | **冲突记录完成**：25 处差异全部分类，**未解决 = 0** | `docs/roco/DATA-CONFLICTS.md`、`data/roco/conflicts.jsonl` |
| 18 | **12 只精灵支持矩阵完成**，含当前支持等级与下一轮目标等级 | `docs/roco/PET-SUPPORT-MATRIX.md`、`.../support-matrix.json` |
| 19 | **A 组 6 只候选配招**：每只 4 技能，含角色、候选数、来源池与备选清单 | 同上 `candidate_moveset.selection_evidence` |
| 20 | **microcase 计划完成**：21 条，覆盖任务书要求的全部 11 个方向 + 应对/蓄力 2 组 | `tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md` |
| 21 | 通知通道接通（PushPlus），阶段完成自动推送 | `scripts/roco/notify.mjs`、`reports/roco/notify-log.jsonl`（均已忽略入库） |

### 3.2 本轮的关键数据结论（每条都有落盘证据）

| 结论 | 证据 |
|---|---|
| 主快照 `terms.json` 含 **54 条机制文本定义**，是本轮能区分「文本说了什么」与「没说什么」的依据 | `data/roco/normalized/.../terms.json` |
| 12 只精灵全部解析成功，**孤儿技能引用 = 0** | `.../import-report.json` |
| 跨来源 25 处差异**全部有解释**，其中 13 处是**版本重平衡**（由主快照自带的 S1—S4 改动记录解释） | `data/roco/conflicts.jsonl` |
| 4 只精灵（黑猫巫师/圆号鱼/音速犬/画间沉铁兽）在 2026-05→09 之间被改过数值；若直接采用旧快照会得到**过时的种族值** | `.../history.json`、`docs/roco/DATA-CONFLICTS.md` §4.1 |
| 化蝶有 **4 个同名形态**，目标形态由 `title`「化蝶（平常的样子）」唯一确定为 `pet_000124` | `docs/roco/DATA-CONFLICTS.md` §5 |
| C 组 3 只是 S4 新精灵（2026-09-10 发布），**不在**任何历史阵容快照里，**单一来源无交叉核验** | `docs/roco/PET-SUPPORT-MATRIX.md` §1 |
| 全部 12 只当前支持等级 = `KNOWLEDGE_ONLY`（未实现任何效果原语，未通过任何 microcase） | `.../support-matrix.json` |

### 3.1 本轮发现并必须留痕的副作用

| 现象 | 原因 | 处理 |
|---|---|---|
| `reports/balance.json`、`reports/retrieval.json` 被改写 | 运行 `npm run eval:balance:quick` 与 `eval:retrieval` 时，脚本按设计把结果**原地写回**这两个**已入库**文件 | 这是既有行为，不是我手改。原始内容仍在 git 中（`git diff` 可回退）。**未删除、未 reset、未覆盖其他改动** |
| `reports/roco/m0-baseline/server.log` 内容为「端口被占用」 | 8765 上**已有**一个先前启动的服务在跑（`runtimeVersion 0.11 / configured true`），我方重复启动被拒 | 直接复用现有服务做页面验收，**不重启、不读取钥匙串**。日志中无任何密钥材料（已 grep 核验，0 命中） |
| `NRC_AI.tar.gz`（172MB）不随仓库分发 | 大文件进 git 会永久留在历史中 | `.gitignore` 已忽略；由「固定 revision + 归档 SHA256 + 逐文件 SHA256 + 交叉核验结果」四级保证复现。入库总量因此为 **8.7MB / 60 个文件** |

### 3.2 仓库文档与现状的差异（必须记录，不得静默取一边）

| 文档说法 | 现场核对结果 | 处理 |
|---|---|---|
| `docs/IMPLEMENTATION-STATUS.md` 顶部写「现场 `npm test` 为 **257 项**」 | 本轮开始时现场为 **375 项**（357 unit + 18 browser），全通过；本轮结束后为 **390 项** | 文档数字过时。以现场日志为准，**本文件不改该文档**（属 M0 审计发现，已登记在 `M0-REPO-AUDIT.md` §1） |
| `README.md` 称 14 宠 | 代码/测试中确认 14 只自创宠物（含磐耳羊、灵瞳猫） | 一致 |
| 交接包称基线 commit `1717cd5` | HEAD = `1717cd5…` | 一致 |
| `03-IMPLEMENTATION-BRIEF.md` §2 称数据写在 `src/game/engine.js` / `src/game/content.js` / `src/game/progression.js` 等 | 已核对文件确实存在且非空（见 M0 审计） | 一致 |
| `README.md` 称「没有第三方 npm 运行依赖」 | `dependencies` 与 `devDependencies` **均为空对象** | 一致，且是重要优势；本轮未引入任何 npm 依赖 |

---

## 4. 状态：本轮已完成 / 下一步 / 阻塞

### ✅ 本轮（M0 + M1）状态：**已全部完成，等待人工审阅**

逐项验收结果见 `docs/roco/M0-M1-ACCEPTANCE.md`（A—L 共 12 节，每项带证据）。
**7 项有明确证据的未完成项**（§J）全部属于「需要游戏内实测或官方资料才能确定」的机制，
本轮**没有**用默认值补齐，而是转成了 21 条 microcase 与 74 个未解问题。

### 最终验证结果（本轮结束时）

| 项 | 结果 | 日志 |
|---|---|---|
| 全量回归 | **390/390 通过**（372 unit + 18 browser），0 失败 / 0 跳过 | `reports/roco/m1-data/npm-test-final.log` |
| 数据域验收 | **15/15 通过** | `reports/roco/m1-data/`（`npm run test:roco`） |
| 浏览器验收 | **9/9 通过**，4 张互不相同的截图 | `reports/roco/acceptance/browser-acceptance.json` |
| Lua 安全解析 | **13/13 文件解析成功**，无执行 | `reports/roco/m1-data/lua-parse-selftest.log` |
| 数据管线可整体重跑 | 通过 | `reports/roco/m1-data/{cross-check,import}.log` |

### 下一步（M2，需人工审阅后再启动）

1. 按 `docs/roco/MICROCASE-PLAN.md` §6 的顺序实现 `roco_env`：
   `MC-001→004`（先手度与排序键）→ `MC-003`（joint-step）→ `MC-013`（隐藏信息）→ `MC-005→007`（换宠/补位/能量）→ `MC-020→021`（应对/蓄力）→ `MC-008→012`（状态/印记/取整/事件序）→ `MC-010`（动态威力）→ `MC-014→019`（A 组特性）。
2. **每一步必须 fail closed**：未核验机制返回 `unsupported_effect`，禁止退化成自创默认值。
3. A 组 6 只所选 4 技能的效果原语通过 microcase 后，才可从 `KNOWLEDGE_ONLY` 升到 `SIM_PARTIAL`。

### 阻塞与未知

- **无硬阻塞**：M0/M1 范围内可验证的项目已全部完成。
- **7 项机制性未完成**（详见 `M0-M1-ACCEPTANCE.md` §J）：官方伤害公式、等级→面板换算、
  同速裁决、能量上限与回能时机、印记替换规则、百分比取整方向、A 组 6 只特性结算细节。
  它们**只能**通过游戏内实测或官方资料解决；本轮已转成 microcase，**未补默认值**。
- **本轮范围外**（未被要求、也未做）：阵容模型、planner、SFT、RL、云 GPU。

---

## 5. 已读材料（本轮）

交接包（只读副本在 `~/.dsh/attachments/v1/files/`，原始路径 `~/Codex/Internship/roco-coach-dsh-handoff-2026-09-21/`）：
`00-START-HERE.md`、`01-COLD-START-CONTEXT.md`、`02-DSH-MASTER-PROMPT.md`、`03-IMPLEMENTATION-BRIEF.md`、
`04-DSH-PLUGIN-DECISION.md`、`05-MODEL-GROUP-AND-TASK-MATRIX.md`、`06-INTEGRATED-BUILD-ROADMAP.md`、
`07-FINAL-DECISION-AND-EXECUTION-PLAN.md`。
仓库：`README.md`、`docs/IMPLEMENTATION-STATUS.md`、`docs/CHECKLIST.md`、`package.json`。
（仓库内**不存在** `AGENTS.md`，已用 glob 全仓确认。）

---

## 6. 最近一次验证命令与结果

### 6.1 M0/M1 基线（保留原样，不要覆盖——它是「开始时的样子」）

| 项 | 值 |
|---|---|
| 命令 | `npm test` |
| 等价于 | `npm run test:unit && npm run test:browser` |
| 运行时间 | 2026-09-20T16:14Z（UTC） |
| 结果 | **357/357 unit 通过，18/18 browser 通过，合计 375/375 通过，0 fail / 0 cancelled / 0 skipped / 0 todo** |
| unit 耗时 | 13 720 ms |
| browser 耗时 | 71 105 ms |
| 退出码 | `0` |
| **原始日志** | `reports/roco/m0-baseline/npm-test.log` |

> 注意：`npm test` 的 `test:browser` 部分会真实启动 Chrome 并驱动页面，因此
> 「浏览器验收」与「单元回归」在本仓库是**两件事**：前者证明页面可交互，
> 后者证明逻辑不变量。M0/M1 结束时两者都要有本轮日志。

### 6.2 第 1 轮 goal（MVP）收尾时的验证（追加，不覆盖 6.1）

| 项 | 值 |
|---|---|
| 命令 | `npm run test:unit` |
| 结果 | **410 / 410 通过**，0 fail / 0 skipped，13.8 s |
| 命令 | `npm run test:browser` |
| 结果 | **17 通过 / 1 按设计 skip**（skip 原因：20 步内对手 0 号位未倒下，场景前置不成立） |
| 命令 | `npm run test:env` |
| 结果 | **111 / 111 通过**（引擎 + 先导 + 公开 schema 隐私），1.0 s |
| 命令 | `npm run test:bridge` |
| 结果 | **11 / 11 通过**，3.6 s |
| 命令 | `npm run test:toolbox-roco` |
| 结果 | **17 / 17 通过**，0.05 s |
| 命令 | `npm run test:plan-e2e` |
| 结果 | **6 / 6 通过**，1.5 s（真 Python 服务，包含本文件 1.6 节所述的隐藏信息反证） |
| 命令 | `npm run test:roco-all` |
| 结果 | 上述四项服务侧套件一次跑完：**145 / 145 通过** |

运行时间 2026-09-21（本地）。这些是**逻辑与契约**证据；「页面真的能用」仍以
`npm run roco:acceptance` 的浏览器证据为准，两者不可互相替代。

---

## 7. 变更记录（每次完成一个可验收步骤就追加一行）

| 时间（UTC） | 动作 | 证据 |
|---|---|---|
| 2026-09-20T16:14Z | 建立本状态文件；记录 HEAD / 环境 / 基线测试 | `reports/roco/m0-baseline/` |
| 2026-09-20T16:16Z | 三份上游快照按固定 revision 冻结 + SHA256 + 逐文件清单 | `data/roco/raw/*.tar.gz`、`reports/roco/m1-data/` |
| 2026-09-20T16:20Z | 安全 Lua 文本解析器（不执行第三方代码），13/13 文件通过 | `scripts/roco/lua-safe-parse.mjs` |
| 2026-09-20T16:25Z | 三来源交叉核验：26 处冲突全部分类，未解决 0 | `data/roco/conflicts.jsonl` |
| 2026-09-20T16:30Z | M0 仓库审计完成 | `docs/roco/M0-REPO-AUDIT.md` |
| 2026-09-20T16:33Z | 许可矩阵完成（主来源 CC BY-NC-SA 4.0，两个 REFERENCE_ONLY） | `docs/roco/LICENSE-MATRIX.md` |
| 2026-09-20T16:36Z | 12 只精灵支持矩阵 + A 组候选配招 + 冲突记录文档 | `docs/roco/{PET-SUPPORT-MATRIX,DATA-CONFLICTS}.md` |
| 2026-09-20T16:39Z | microcase 计划 21 条（覆盖 11 个方向 + 应对/蓄力 2 组） | `tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md` |
| 2026-09-20T16:41Z | 新增 15 项数据域验收测试并接入 `test:unit`（追加，不删旧测试） | `tests/evals/roco/data-acceptance.test.js` |
| 2026-09-20T16:42Z | 浏览器验收脚本 + 4 张互不相同截图，9/9 通过 | `reports/roco/acceptance/` |
| 2026-09-20T16:43Z | 全量回归 **390/390 通过**（372 unit + 18 browser），0 跳过 | `reports/roco/m1-data/npm-test-final.log` |
| 2026-09-20T16:43Z | M0/M1 验收 checklist 完成（A—L，每项带证据） | `docs/roco/M0-M1-ACCEPTANCE.md` |
| 2026-09-20T16:43Z | **本轮结束，等待人工审阅。未提交 git（保持工作区可见，便于审阅 diff）** | `git status --porcelain` |
| 2026-09-21 | 第 1 轮 goal（30 项 MVP）启动：隐私边界收紧（移除 `state.seed` 后门、`/battle/plan` 改用公开 schema、对手后备不再暴露血量） | `roco/tests/test_public_planner.py`、`tests/evals/roco/bridge.test.js` |
| 2026-09-21 | **补上二层隐藏信息边界缺口**：桥的 `HIDDEN_KEYS` 缺 `pendingenemy/pendingplayer/replacequeue`，私有 `serialize()` 能从第一层穿过 | commit `8e79a6f`；新增三条词汇表跨文件比对测试 |
| 2026-09-21 | **新增规划端到端测试**（真 Python 服务）：证明正确公开状态确实产出计划，并反证真实 seed 不影响结论 | `tests/evals/roco/plan-e2e.test.js`、`scripts/roco/gen-plan-state.py`、`npm run test:plan-e2e` |
| 2026-09-21 | **F01 无聊天入口演示页** `/roco.html` + 浏览器验收 16/16 | `src/client/roco.{html,js,css}`、`src/coach/roco-experience.js`、`scripts/roco/demo-acceptance.mjs` |
| 2026-09-21 | **F02 全链路回归**：604 项去重合计，0 失败；P50/P95 实测 | `reports/roco/regression/`（含 18 份原始日志） |
| 2026-09-21 | **F03 MVP 材料**：架构图 / 数据卡 / 规则覆盖表 / 状态标签 / 录屏脚本 | `docs/roco/mvp/` |
| 2026-09-21 | 按 F02 的四条发现修掉三条（能力表、501 不可达、补位规划从未算过） | commit `44b4e92`；`roco/tests/test_sim_endpoints.py` |
| 2026-09-21 | **G02 阵容模型：不过门槛**，`evaluate_team` 继续用规则评分 | `reports/roco/g02-team/G02-MODEL-2026-09-21-v1.md`（不过）、`-v2.md`（过）；目录里没有不带后缀的那一份 |
| 2026-09-21 | **属性增减真的进伤害了**（此前入口硬编码 1.0）、防御减伤不再跨回合残留 | commit `35d7120`；`TestBuffDamageWiring` |
| 2026-09-21 | **W3-01：12 只精灵全部接入特性**（FULL 6 / PARTIAL 2 / REFUSED 4） | commit `2231191`；`roco/src/roco_env/traits.py` |
| 2026-09-21 | 监工复核后：折算收敛到唯一函数、语义标注为假设、测试改按不变量写 | commit `9085af2`；`TestReplayCarriesLoadouts` |
| 2026-09-21 | **W4-01 任务集**：288 条 / 8 类，三重维度隔离切分 + 判定器自检（两个方向） | commit `10325dd`；`roco/tests/test_agent_tasks.py` |
| 2026-09-21 | 修掉任务集里 `skill_name` 这个不存在的参数键（照期望重放撞出来的） | `tools_argument_keys()` 合同比对 |
| 2026-09-21 | **W4-02 轨迹集**：6,048 条 / 23 世界 / 7 arm + 离线回放 + 双向对照（第 37 轮重建） | `docs/roco/AGENT-TRAJECTORIES.md`、`reports/roco/agent-trajectories-verification.json` |
| 2026-09-21 | 反向对照抓出判定器三个真缺陷（胜率/冲突/过期各一），全部修掉 | 同上；本轮验证日志 |
| 2026-09-21 | 第 9 轮验证：Python 195（1 skip）/ Node 430 / bridge 11 / toolbox 17 / plan-e2e 10；demo 16/16、浏览器 9/9；轨迹判定 verdict=true | `reports/roco/verification/round9-agent-trajectories.log` |
| 2026-09-21 | **第 12 轮（P0）量具修正**：`--swapped` 下基线也打两个座位；主比较改为配对 McNemar 精确二项 + 配对 bootstrap；分层 (opponent × seat) 报告；新增 10 项校准测试（含反证） | `roco/tests/test_benchmark_matches_pairing.py`、`reports/roco/verification/round12-benchmark-pairing.log` |
| 2026-09-21 | 旧整局胜负结论标 **INVALID**（80 对 40 + 用区间重叠当差异检验）；旧产物留档 | `reports/roco/invalidated/planner-matches-2026-09-21-invalid.json` |
| 2026-09-21 | 修正后重跑：**没有任何一格支持 planner 更好**（+0.050 / −0.088 / −0.100）；分层后两半符号相反 | `reports/roco/planner-matches.json`、`docs/roco/BENCHMARKS.md` §2.1–2.2 |
| 2026-09-21 | 第 10 轮修一个「测试全绿但生成器已经不能跑」的漏洞：给 `receiptSummary` 加注释时把 `export` 一起删了，盘上还有旧产物所以测试照样过；新增加载守卫 + 重算 `bytes`（剔除延迟） | commit 见下；`reports/roco/verification/round10-agent-trajectories.log` |

---

## 8. 下一步（旗舰版，按用户指令重排）

| # | 任务 | 依赖 | 现在能不能做 |
|---|---|---|---|
| 1 | **W4-01 固定 Agent 任务集**（八类：规则补查 / 阵容约束 / 继续停止 / 工具失败 / 状态过期 / 证据冲突 / 静默 / 简短解释；按**阵容家族、机制、表达模板**三重隔离切分） | 无 | **能**。现有 `tests/evals/*`、`tool-router.json`、`regression-set.json` 是起点 |
| 2 | **W4-02 构造 2,000—5,000 条工具轨迹** | W4-01 | **一半已完成**：轨迹格式 / 判定器 / 离线回放 / 6,048 条**规则 arms** 轨迹已落地（`docs/roco/AGENT-TRAJECTORIES.md`）。剩下一半是**模型候选**，要 DeepSeek key |
| 2b | **W4-05 同 Agent 回放门禁** | W4-02 | **能起步**：判定器与回放已经是可复用门禁（6,048 条 + 17,760 个反例变体）。等有 key 时把「固定 pipeline / 模型 / SFT」三条 arm 接进同一套判据即可 |
| 3 | **W5-04 主动介入模型**（成本敏感分类器，替换规则打分的**一部分**，硬门控不变） | 30+ 窗口的标签扩充 | **能起步**：先建标签扩充与评测闭环，再训模型 |
| 4 | ~~W4-03 / W4-04 Qwen3-4B profiling 与 SFT~~ | 无 | **已完成，不是硬件阻塞**（第 41 轮更正）：本机 = Apple M5 Pro / 15 核 / 48 GB，profiling 与四轮 LoRA 都在本机跑过。模型身份、SFT v4 结果与网关指标见 §2.1。剩下的是「接进默认链路」，不是硬件 |
| 5 | W5-05 陪练盲评 | **3—5 位真人** | **外部阻塞** |
| 6 | E03 的「已验证」那一半 | **一次游戏内实测** | **外部阻塞** |

**每个模型类交付的硬要求**（写进 goal，不再重复）：
预注册门槛（跑之前先把判据写进文件）、规则 baseline、family/时间切分、
校准与 OOD、fail-closed 回滚开关、真实调用链。
报告必须同时给：baseline、family 外指标、校准、延迟、回滚开关状态。

**数据不足时的正确做法**：先建**数据 / 评测 / 接口闭环**，
不得用合成轨迹声称真人效果，不得把模型分数叫胜率。

### 第 12 轮的决定：先修尺子，不动 planner

按监工指令，量具修正优先于继续调 planner。跑完之后的处置：

| 决定 | 依据 |
|---|---|
| **保留** planner 代码，不因这份基准撤回 | 报告没有说 planner 坏了：回落率 0.0、超时 0，说明它确实在决策。它只是**没有比 greedy 基线更好**，这不是撤回理由（greedy 是启发式，planner 是产品要求的可解释规划器） |
| **不**因为「44/80 看着更好」而继续调参 | 那个数字来自错量具。修正后汇总差为 +0.050（p=0.48），不支持任何调参 |
| 下一项独立工作：**查清座位效应** | `player` 座位 +0.250（p=0.002）、`enemy` 座位 −0.150。`step_joint` 是同时结算，所以不是「先手优势」，更可能是自驱动循环/补位顺序/state 视角在两侧不对称。查清前不得把座位效应解释成任何产品结论 |
| 报告口径 | 以后引用这份基准**必须带座位**，且必须带配对检验的 p 与不一致格 b/c |


### C6.7 矩阵重新定位协议（下一个接手的人照这个做，不用再想）

**背景**：`36832d1` 修了引擎两处 fail-closed 违规（附带效果、防御分支的「应对成功」子句
不再被静默丢弃），战斗走向因此改变 → 12 个写死局面里有 3 个的实际开口 kind 与登记不符。
被停掉的子 agent 最后留下的实测结论值得记下来：**对固定阵容来说种子几乎不改变结果，
真正的杠杆是「阵容 + 推进手数」**（它原话：Seed barely changes outcomes for a fixed lineup —
the real lever is lineup + advances）。所以重新定位要换**阵容**，不要指望换种子。

**当前三条失配（实测，2026-09-21）**：
| 局面 | 期望 kind | 实际 kind | 该局面原本要隔离的事实 |
|---|---|---|---|
| `02-ko-now-mid` | `ko-now` | `switch-low-hp` | 这一击**能收掉**对面（先于「我方残血该换人」成立） |
| `08-switch-low-hp-mid` | `switch-low-hp` | `type-resisted` | 我方残血、换人是**最优先**该做的事 |
| `11-speed-slower-defend` | `speed-decides` | `switch-low-hp` | 速度更慢，先手判断决定这一手怎么打 |

**协议（逐步照做，不许跳步）**：
1. 对每条失配，先用**真服务**跑该局面，记录两组量：①「原本要隔离的事实」在那一刻是否
   仍然成立（血量/能量/速度/属性倍率/合法动作/回执估算里能核对的量）；② 实际开口的 kind
   与它依据的公开事实。
2. 分三种情况处理：
   - **事实仍成立但被更高优先级压住** → 这是矩阵的隔离失败：换**阵容**（必要时 ±1 手）
     直到该事实真的是那一刻最优先的事实；**期望 kind 不变**。
   - **事实本身不成立**（引擎修复后这一手不再构成该事实，例如附带效果生效后对面没倒）
     → 登记为**漂移**（把实测数字写进 `docs/roco/BROWSER-POSITION-MATRIX.md`），
     然后用别的阵容重新构造同一事实；期望 kind 仍不变。
   - **真的不可达** → 进不可达清单（带命中数），**不许**用别的 kind 顶替。
3. 每次改完都要满足：12 个局面全部推进到位、互不相同 kind **≥8**、形状 **≥9** 且
   最大重复 **≤2**、DOM 上那一句与 Node 侧重算**逐字相同**、两遍**逐字节可复现**。
4. **反证**：把某条 expected_kind 改成另一个值，`demo-acceptance` 必须变红；改回后必须绿。
5. 跑 `node scripts/roco/demo-acceptance.mjs`（要 0 失败）与
   `node --test tests/evals/roco/browser-position-matrix.test.js`，然后才提交那 3 个产物。
6. 严禁为了让验收变绿去改 `src/coach/coach-advice.js`（建议层判据）；若失败其实源于
   建议层，停下来报告。


### C6.8 「48 只可选」的确切根因与最小改法（第 58 轮实测定位）

监工要求先做到「服务可启动、名单可加载、可玩 48 只 3v3」。**服务侧已经是好的**，
卡点在名单只出 12 只，根因已逐行定位：

- 页面/接口链路：`src/client/roco.js` → `GET /api/roco/roster`（`src/server/index.js:213`）
  → `rocoService.roster()`（`src/server/roco-service.js:382`）→ Python `kind:'roster'`
  → `_answer_roster`（`roco/src/roco_env/service.py:776`）。
- **根因**：`_answer_roster` 遍历的是 `sorted(rs.pets)`，而 Ruleset 加载的宠物来自
  `data/roco/normalized/roco-world-s4-2026-09-10/pets.json`——那份目前只有 **12 只**
  （实测 `curl /api/roco/roster` → `count:12, usable_count:12`）。
  所以不是接口过滤掉了，而是**引擎的候选池里只有 12 只**。
- 现有的 `limit = query.get("limit")`（`service.py:780`）只是截断参数，Node 侧
  `client.query({kind:'roster'},{})` 也没传——**分页/筛选要从这里接**。

**最小改法（下一轮，按顺序）**：
1. 让 Ruleset 的候选池扩到 48：把上一轮落库的
   `data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json`（48 只 + 各自 4 个有证据技能
   + `support: simulable_core_pool`）作为**叠加层**接进加载期；**不替换**现有 12 只那份
   （它带着引擎侧 4 技能与合法性校验，是基线）。加载期要断言：叠加后每只仍有 4 个技能、
   且 `candidate_moveset` 非空——否则 fail closed，不许静默跳过。
2. `_answer_roster` 支持 `offset/limit/type/role` 四个查询参数（`limit` 已存在），
   并在返回里带 `total`/`offset`/`limit`；Node `roster()` 原样转发这些参数，
   **不传参数时行为与现在一致**（旧形状向后兼容：`ok/count/usable_count/team_size/note/pets`）。
3. 验收（缺一不可）：① `/api/roco/roster?limit=48` 返回 48、`?type=草系` 只出草系、
   `?offset=24&limit=12` 出第 25—36 只；② 真服务抽样：跨批次任取 3 只组任意合法 3v3
   **能开局并打完**（给出局数与失败样本）；③ `npm run test:env` 与 `test:unit` 全绿；
   ④ 页面端分页/搜索接上后才谈 UI 重排（监工要求：绿基线再动结构）。

