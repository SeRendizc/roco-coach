# 小兽训练场 · 小芽

一个宠物对战游戏，以及一个住在游戏里的 AI Coach。

为腾讯 IEG 面试题「基于 LLM 的智能 AI Coach」所做。规则引擎、对战、成长、UI 都从零写，**没有第三方 npm 运行依赖**——`npm start` 就能玩。语义检索与离线模型实验另有 Python 与模型依赖（见文末）。

![营地](output/demo-live/01-营地.png)

---

## 运行

需要 Node.js 20+。

```sh
npm start          # http://127.0.0.1:8765/
npm test           # 全量自动测试，约一分钟；项数以实际输出为准
```

端口可用环境变量覆盖（默认 8765）。如果 8765 已被占用又不方便停掉它：

```sh
PORT=8899 npm start    # http://127.0.0.1:8899/
```

**从零克隆就能跑，不需要 Python，也不需要下载任何模型。** 仓库没有 npm 依赖，
语义检索与那个离线工具路由头实验才需要 Python（见文末「可选：本地模型」）；
Python 环境或模型缺失时语义检索自动退回词项检索，不会报错中断。

**不接模型也能完整游玩**：规则建议、复盘、培养建议和小测都由本地引擎给出。接上模型之后，这些解释改由模型生成。

想接模型，在 http://127.0.0.1:8765/connect.html（换端口时用对应端口）填入 DeepSeek API Key（只留在服务端进程内存里，不落盘、不写日志）。也可以用 macOS 钥匙串启动：```sh
./scripts/start.sh --save-key   # 存一次
./scripts/start.sh              # 以后直接启动，自动读取
```

> **`npm start` 现在跑的还是上面这个自创宠物 Demo。**
> 「小芽 2.0」的手游规则域目前只做到数据层（M0/M1），**没有接管默认 UI**，
> 所以启动方式、端口、玩法都和以前完全一样。见下方「小芽 2.0：当前进度」。

---

## 小芽 2.0：当前进度

项目正在从自创宠物 Demo 升级为《洛克王国：世界》**手游**内嵌主动 Coach。
当前只完成了 **M0（基线 + 仓库审计）** 与 **M1（数据快照）**，
**没有修改任何运行代码**——`engine.js`、`content.js`、`coach/*`、前端与全部既有测试
与本轮开始前的 commit 逐字节一致。

已完成的是**可信的数据地基**：

| 产物 | 内容 | 入口 |
|---|---|---|
| 来源与许可台账 | 3 份上游快照按 revision + SHA256 冻结；许可与再分发等级 | `data/roco/sources.yaml`、`docs/roco/LICENSE-MATRIX.md` |
| 规范化数据 | 12 只目标精灵、824 条技能、312 张学习表、120 组属性相性 | `data/roco/normalized/roco-world-s4-2026-09-10/` |
| 仓库审计 | 逐模块 KEEP / ADAPT / RETIRE / MISSING | `docs/roco/M0-REPO-AUDIT.md` |
| 冲突记录 | 26 处跨来源差异，全部分类，未解决 0 | `docs/roco/DATA-CONFLICTS.md` |
| 支持矩阵 | 12 只精灵的完整度、候选配招、缺口 | `docs/roco/PET-SUPPORT-MATRIX.md` |
| microcase 计划 | 21 条，供下一轮规则引擎实现 | `docs/roco/MICROCASE-PLAN.md` |
| 验收 checklist | 逐项打勾与证据 | `docs/roco/M0-M1-ACCEPTANCE.md` |

**12 只精灵当前支持等级一律是 `KNOWLEDGE_ONLY`**：本轮没有实现任何效果原语，
824 条技能的 `effect_support` 全是 `unsupported`。字段齐全是数据完整度，
不等于机制可模拟——这两件事在文档里被强制分开。

复现数据管线（不联网、不执行第三方代码）：

```sh
npm run roco:pipeline     # 解析校验 → 交叉核验 → 导入 → 矩阵 → microcase → 文档
npm run test:roco         # 15 项数据域验收（直接与原始 Lua 对拍）
npm run roco:acceptance   # 9 项真实浏览器验收（含 4 张截图）
```

> 注：`data/roco/raw/extracted/` 不入库。新克隆的仓库需要先从
> `data/roco/raw/*.tar.gz` 解压（归档本身已入库且带 SHA256），
> 否则数据域验收测试会**显式 skip 并说明原因**，不会假装通过。

---

## 三种角色

| | 做什么 | 怎么出现 |
|---|---|---|
| **军师** | 单回合候选排序前后一致、依据可查的决策建议（不是胜率，也不是全局最优） | 顶部一句话，「看看原因」展开依据 |
| **老师** | 复盘、讲解、循序渐进 | 整局结束后的复盘与阶段小测 |
| **陪练** | 能闲聊、有情绪、记得历史与偏好 | 左下角独立气泡，带头像与名字 |

三种角色都做成了可运行的闭环，不是只有设计。

陪练的情绪有落点：可以说「可惜 / 漂亮 / 悬 / 憋屈 / 松口气」，但每一句都必须绑在一条真实读数上（第几回合收掉、哪一只顶了几个回合、这一局有几个回合贴着血皮撑过来），并且不允许播报它自己的感受——「我看得有点急」这类句子被 `coach/companion.js` 的扫描直接拦掉。闲聊、情绪、历史偏好三项各自都有覆盖测试。

![对局](output/demo-live/04-局内战斗.png)

---

## 一句话说清设计

**把「算」和「说」分开——引擎负责对，模型负责讲。**

伤害、克制、命中、胜负一律由引擎算。程序规定权限与必须查证的条件；模型理解玩家的问题，在已有证据之上决定是否再补一次查询，然后把结论讲成简短的取舍。所有取舍都是这条的推论：

- 模型不参与伤害计算；对手的出招由**模型**从引擎给出的合法行动表里选，引擎负责限定合法集合、结算，并在选到非法行动、超时或网络失败时兜底
- 「该不该调工具」由代码判断，不由模型自由发挥
- 模型说出的话要经过三条校验，越界就回退到本地模板
- 代码规定的首步流程不冒充模型自主规划；模型决定补查也不等于拥有任意操作权限

同一个道理在开发过程里又验证了一次：**agent 负责具体实现，我负责架构、验收与关键修复**。多次「测试全绿但功能没生效」都是在这一层被拦下的——详见报告第 3 节。

---

## 目录

- **`output/pdf/xiaoya-coach-report.pdf`** — 实施与实验报告（页数以构建产物为准，建议先看这个）
- `docs/CHECKLIST.md` — 逐项完成状态与验收证据
- `docs/IMPLEMENTATION-STATUS.md` — 当前能力、运行版本与限制
- `docs/DEMO-ACCEPTANCE.md` — 普通游玩、静默、条件提醒、异步与公平性演示
- `docs/EXPERIMENTS.md` — 完整实验与资源边界
- `docs/INTERVIEW-GUIDE.md` — 讲述与追问准备
- `docs/EVIDENCE-SCHEMA.md` — 事件、证据、任务状态与权限约定

---

## 实验

```sh
npm run build:knowledge      # 从 tactics.json 与引擎生成知识卡（纯 Node）
npm run eval:retrieval       # 检索四臂对照（纯 Node，几秒）
npm run eval:balance:quick   # 单宠胜率对照（纯 Node，几秒）
npm run eval:balance         # 平衡矩阵：5,796 场无头仿真（纯 Node，约 3 分钟）
npm run train:intervention   # Q-learning 干预时机（纯 Node，约 1 分钟）
```

产物写在 `reports/`。以上都不需要 Python，也不调用模型。

工具评测（判模型该调哪个工具、以及**参数对不对**）：

```sh
npm run eval:live:selftest   # 判分自检：拿修复前/后的回执各跑一遍，不需要网络与额度
npm run eval:live:dry-run    # 用例彩排：构造每条用例的真实局面，走真实政策与工具，不调模型
npm run eval:live            # 真实调用：一条用例一次 POST /api/coach，会消耗额度
```

`eval:live` 需要 8765 上已配置密钥的服务（`./scripts/start.sh`）；没配置时它直接退出，不发出任何请求。
它按五层算分：工具选择、参数、证据匹配、回答依据一致、过期/跨局拦截，并保留两个已复现的参数缺陷用例（R01「上一回合」、R02 分支候选）作为回归样例。

真实模型联调也可以用 `node scripts/eval-live-model.js`（3 条用例，写 `reports/live-model.json`），同样需要已配置的服务、会消耗少量额度，不读取也不打印密钥。

实验有两条，都是离线的：Q-learning 学干预时机；SmolLM2 冻结骨干后训练两个工具输出行，实际更新 1152 个参数。**生产用的 DeepSeek / 主模型没有训练过，线上一直用基座模型**；后者只是一个二选一的小型工具路由头实验，不是 DeepSeek 微调。

---

## 边界

**本地对战是同一台设备分屏同屏，不是联网 PVP。** 服务端仍接受客户端提交的快照，不是权威状态；客户端快照不构成生产环境的权限边界。

一回合搜索不是全局最优。浏览器语音已停用——在本机 macOS Chrome 上，无论指定哪个 zh-CN 声音都会播成粤语并伴随结尾爆音，触发点是 `speechSynthesis.cancel()`；代码保留在 `VOICE_FEATURE` 开关后，查明原因前不宣称有语音能力。上下文先保守裁剪，再用官方 tokenizer 计数。

真人学习收益、生产模型的权重训练、生产权限认证与独立大样本评测尚未完成。

---

## 可选：本地模型

基础游戏与上面「实验」一节的全部命令只需 Node。语义检索与那个离线工具路由头实验需要 Python，且首次要联网下载模型：

```sh
.venv-agent/bin/python -m pip install -r requirements-agent.lock.txt  # 建 Python 环境（本机已有 .venv-agent，Python 3.9）
node scripts/eval-semantic.js                                        # 首次下载多语嵌入模型（约 458MB，落在 .models/）
.venv-agent/bin/python scripts/train-tool-router.py                  # 首次下载 SmolLM2-135M-Instruct（约 260MB）
```

`node scripts/eval-balance.js`（即 `npm run eval:balance:quick`）不需要 Python。
Python 环境或模型缺失时不会报错中断：语义检索预热失败会自动退回词项检索，精确 token 计数则由 `.venv-agent/bin/python scripts/count-tokens.py` 提供。

---

## 存档

成长、偏好、会话与最近 3 场完整对局存在本机 localStorage。刷新可以复盘，但不会把进行中的对战恢复到可继续操作的状态——旧版没存下来的历史无法补造。AI Coach 事件最多 240 条；清除记忆会同时删除 AI Coach 档案，游戏成长保留。预制体验不写真实进度。
