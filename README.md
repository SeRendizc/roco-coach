# 小兽训练场 · 小芽

一个宠物对战游戏，以及一个住在游戏里的 AI Coach。

为腾讯 IEG 面试题「基于 LLM 的智能 AI Coach」所做。规则引擎、对战、成长、UI 都从零写，**没有第三方 npm 运行依赖**——`npm start` 就能玩。语义检索与离线模型实验另有 Python 与模型依赖（见文末）。

![营地](output/demo-live/01-营地.png)

> 🔴 **先读这一句**：`8765` 上的网页现在回 **200**，但 **Python 引擎侧是红的**（`coverage.py` 停在被 `git checkout` 抹掉之后的 HEAD 版本）。**"网页能打开"不等于"功能都好了"** —— 详见文末「当前状态」。
> 主交付物是 **[`docs/roco/coach-理想形态-计划书-2026-09-30.md`](docs/roco/coach-理想形态-计划书-2026-09-30.md)**（本机 `wc -l` = **7193 行** @ 2026-09-30 14:56 —— 该文件**仍在被追加**，行数以你跑的时刻为准）。

---

## 运行

**想跑已经完成的 v0.1（自创宠物 Demo + 小芽 Coach）：**

去 [Releases](https://github.com/SeRendizc/roco-coach/releases/tag/v0.1.0) 下载 `v0.1.0` 的源码包，
解压后 `npm start` 即可。不需要 Python、不需要下载模型、不需要 API Key。

当前 `master` 正在往《洛克王国：世界》手游方向演进（见下方「小芽 2.0：当前进度」），
游戏部分与 v0.1 暂时一致，但会继续改。

**在当前分支上开发/试跑 `master`：**

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

> **`master` 上的游戏部分与 v0.1 完全一致。**
> 「小芽 2.0」的手游规则域在当时只做到数据层（M0/M1），**没有接管默认 UI**，
> 所以启动方式、端口、玩法都和 v0.1 一样。见下方「小芽 2.0：当前进度」。

---

## 小芽 2.0：M0/M1 阶段的产物（**历史记录，非当前状态**）

项目正在从自创宠物 Demo 升级为《洛克王国：世界》**手游**内嵌主动 Coach。
下面这张表是 **M0（基线 + 仓库审计）** 与 **M1（数据快照）** 的产物，
当时**没有修改任何运行代码**——`src/game/engine.js`、`src/game/content.js`、`src/coach/*`、前端与全部既有测试
与本轮开始前的 commit 逐字节一致。

已完成的是**可信的数据地基**：

| 产物 | 内容 | 入口 |
|---|---|---|
| 来源与许可台账 | 3 份上游快照按 revision + SHA256 冻结；许可与再分发等级 | `data/roco/sources.yaml`、`docs/roco/LICENSE-MATRIX.md` |
| 规范化数据 | 12 只目标精灵、824 条技能记录（我现取：战斗技能 **579** / 特性 **245**）、120 组属性相性、**12 份**学招表 —— 上游快照里共 **312** 份，冻结目录只落了 12 份（`docs/roco/COVERAGE-LAYERS.md` 已标） | `data/roco/normalized/roco-world-s4-2026-09-10/` |
| 仓库审计 | 逐模块 KEEP / ADAPT / RETIRE / MISSING | `docs/roco/M0-REPO-AUDIT.md` |
| 冲突记录 | 26 处跨来源差异，全部分类，未解决 0 | `docs/roco/DATA-CONFLICTS.md` |
| 支持矩阵 | 12 只精灵的完整度、候选配招、缺口 | `docs/roco/PET-SUPPORT-MATRIX.md` |
| microcase 计划 | 21 条，供下一轮规则引擎实现 | `docs/roco/MICROCASE-PLAN.md` |
| 验收 checklist | 逐项打勾与证据 | `docs/roco/M0-M1-ACCEPTANCE.md` |

> ⚠ **上面那一段是 M1 当时的快照，不是今天的全貌。** 自那之后规则域已经继续往前推
> （效果覆盖台账 `docs/roco/RC-401-EFFECT-COVERAGE.md`、`roco/tests/` 下 70 个 `test_*.py`、
> 以及正在重建的 `coverage.py`）。**今天的真实状态以文末「当前状态」一节为准。**

复现数据管线（不联网、不执行第三方代码）：

```sh
npm run roco:pipeline     # 解析校验 → 交叉核验 → 导入 → 矩阵 → microcase → 文档
npm run test:roco         # 数据域验收（直接与原始 Lua 对拍）
npm run roco:acceptance   # 真实浏览器验收（含截图）
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

陪练的情绪有落点：可以说「可惜 / 漂亮 / 悬 / 憋屈 / 松口气」，但每一句都必须绑在一条真实读数上（第几回合收掉、哪一只顶了几个回合、这一局有几个回合贴着血皮撑过来），并且不允许播报它自己的感受——「我看得有点急」这类句子被 `src/coach/companion.js` 的扫描直接拦掉。闲聊、情绪、历史偏好三项各自都有覆盖测试。

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

代码按 `src/` 分层，测试在 `tests/`，约定与「新文件该放哪」见 **`docs/STRUCTURE.md`**。
顶层只有入口与配置，不放实现代码（这条有测试守着）。

- **`docs/roco/coach-理想形态-计划书-2026-09-30.md`** — **主交付物**：小芽"理想形态"的完整计划与实测记录（含编号纪律）
- **`docs/STRUCTURE.md`** — 目录结构与约定：新文件该放哪、为什么不那样做
- **`output/pdf/xiaoya-coach-report.pdf`** — 实施与实验报告（页数以构建产物为准，建议先看这个）
- `docs/CHECKLIST.md` — 逐项完成状态与验收证据
- `docs/IMPLEMENTATION-STATUS.md` — 当前能力、运行版本与限制
- `docs/DEMO-ACCEPTANCE.md` — 普通游玩、静默、条件提醒、异步与公平性演示
- `docs/EXPERIMENTS.md` — 完整实验与资源边界
- `docs/INTERVIEW-GUIDE.md` — 讲述与追问准备
- `docs/EVIDENCE-SCHEMA.md` — 事件、证据、任务状态与权限约定
- `docs/roco/RC-401-EFFECT-COVERAGE.md` — 效果覆盖台账与档位词汇
- `docs/roco/PROGRESS.md` — 路线图 vs 证据的进度台账

> 旧的 `docs/LEGACY.md`（版本、tag、以及「旧代码几个 G」的澄清）**当前不存在于仓库里** —— 本 README 原先指向它，现已移除该条，不做补链。

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

---

## 当前状态（2026-09-30，**必读**）

> 本节**每一个数字都是本机实测**，命令与读数汇总在最后「这一节的读数怎么来的」。
> 凡没核实过的，这里不写。

### 主交付物

**`docs/roco/coach-理想形态-计划书-2026-09-30.md`** —— 本机 `wc -l` 实测 **7193 行**（@ 2026-09-30 14:56）。
小芽"理想形态"的完整计划与实测记录：可见面读数、引擎各族盘点，以及一套编号纪律。

> ⚠ 计划书**仍在增长**（写这一节期间它从 6872 → 6968 → 7193），所以 **7193 这个数也只是采样值**，不当作常量引用；请以你本机 `wc -l` 为准。

### 🔴 引擎当前是红的

`roco/src/roco_env/coverage.py` 在工作区里被一次误操作（`git checkout`）抹掉了**整层未提交改动** ——
那条命令回滚到的是 **HEAD**，不是"改动前"。

**该文件目前停在 HEAD 版本**，整棵树是红的。三条实测：

1. `git hash-object roco/src/roco_env/coverage.py` = `git rev-parse HEAD:roco/src/roco_env/coverage.py` = **`0c9f6f14bab2`** ⇒ 工作区 == HEAD，一个字节都没多。
2. 该文件 **782 行**，但少了 3 个入口：**`settlement_verdict`** · **`classify_skill_declared`** · **`_CAPABILITY_TO_FLAG`**。
3. `roco/src/roco_env/service.py:112` 写着 `from .coverage import classify_skill_declared` ⇒ `import roco_env.service` **直接 `ImportError`**，引擎服务模块连 import 都过不去。
   影响面：`roco/tests/` 下 **19 个**测试文件引用了这些名字。
4. ⚠️ 这个"红"是**判据红，不是 git 脏**：我取到时 `git status --short` = **0 行**（代码与文档都已提交）⇒ **现在没有"未提交改动"可以回滚**，丢掉的那层只能重建 —— 它连 object store 都没进过（`git checkout` 是从 index 取 blob 覆盖工作区）。`git cat-file -t` 也查不到改动前的那一版。

**重建正在进行**，方式是：

- 重建稿写在 `tmp/coverage.rebuild.N.py`。**注意：最新稿 ≠ 最绿的稿** —— 我 14:56 采样时最新是**第 5 稿**（`tmp/coverage.rebuild.5.py`，56,620 字节），但它**目前跑不出绿**：`test_cond_self_debuff_power` 报 `NameError: name '_RESOLVER_BY_CAPABILITY' is not defined`（`coverage.rebuild.5.py:856`；该稿只*用*了这个名字、没有定义，而第 4 稿 `:59` 定义了）。**跑得出"单文件绿"的是第 4 稿**，见下表；
- 用**影子注入**验证：`importlib` 把 `sys.modules['roco_env.coverage']` 指向 `tmp/` 的稿子，**判据一行不改**；
- **正文一字未改** —— `shasum -a 256 roco/src/roco_env/coverage.py` 至今仍是 **`cc3de2ba09c8b5d1…`**。

**判据读数（本机实测）**：

| 跑法 | 目标 | 结果 |
|---|---|---|
| 直接跑（正文 = HEAD 版） | `tests.test_cond_self_debuff_power` | `Ran 7 tests` · 🔴 **`FAILED (errors=4)`** |
| 影子注入第 4 稿 | `tests.test_cond_self_debuff_power` | `Ran 7 tests` · ✅ **`OK`** |
| 影子注入第 4 稿 | `tests.test_effect_coverage` | `Ran 21 tests` · 🔴 **`FAILED (failures=10, errors=6)`** |
| 影子注入第 5 稿（我 14:56 采样时它在写稿中） | `tests.test_cond_self_debuff_power` | `Ran 7 tests` · 🔴 **`FAILED (errors=4)`**（`NameError: _RESOLVER_BY_CAPABILITY`） |
| 影子注入第 5 稿（同上） | `tests.test_effect_coverage` | `Ran 21 tests` · 🔴 **`FAILED (failures=2, errors=5)`**（问题数 16 ⇒ 7，比第 4 稿少 9 个） |

⇒ 🔴 **关键区别：`test_cond_self_debuff_power` 只在影子注入下是绿的；直接跑仍是红的。**
这就是"重建中"的确切含义 —— **绿还没有落到正文上**。

重建稿每版都复制进 `reports/roco/rc401/rebuild-drafts/` —— **过程本身也有备份**。

### 备份与远端

| 远端 | 用途 | 该分支最新已推（`git ls-remote` 实测） |
|---|---|---|
| **Gitee**（`https://gitee.com/serendizc/roco-coach.git`） | **优先** | 分支头 = `ae826e3` |
| GitHub（`https://github.com/SeRendizc/roco-coach.git`） | 大版本时推 | 分支头 = `b5a8d51`；`master` = `579ab2f` |

- 当前分支：**`wip/roco-coach-2026-09-30-1418`**；最新 commit **`ae826e3`**。
- 本地 `master` 未动，仍是 `51c04fb`。
- 另有轻量快照 **`refs/snapshots/wip-2026-09-30-1418`**（`git for-each-ref refs/snapshots/` 可见）：
  它是一个**双亲提交**（父 = `master` `51c04fb` 与 `57788b5`），形如 `git stash create` 的产物 —— **只建对象、不动工作区**。
  ⇒ 它存在的唯一目的，就是让"`git checkout` 抹掉未提交改动"这件事**不再发生第二次**。
  ⚠️ **一处必须说清的局限**（我核过）：这份快照里 `coverage.py` 与 HEAD 版本**逐位相同**（md5 `e2dab2b0ac393b3ec2c71ddc21063b34`、sha256 前缀 `cc3de2ba…`）—— **它保住了别的文件，没能保住 `coverage.py` 丢掉的那一层**（快照建于那次回滚之后）。它防的是**下一次**。

### 常用命令（可直接粘贴）

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:8765/roco.html        # 验活产品服务（期望 200）
cd roco && PYTHONPATH=src python3 -m unittest tests.test_cond_self_debuff_power   # 跑单个判据文件（当前：FAILED errors=4，这是"如实"的预期）
cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -q      # 跑全量 roco/tests（跑前先确认服务不需重启）
git for-each-ref refs/snapshots/                                        # 看安全网快照
git log --oneline -1 && git branch --show-current                       # 我在哪一版
```

**当前唯一能看到"绿"的跑法：影子注入**（判据一行不改；期望 `Ran 7 tests · OK` · `exit=0`）：

```sh
cd roco && PYTHONPATH=src:../tmp python3 - <<'PY'
import sys, importlib.util, unittest
sys.path.insert(0, '.')
import roco_env
spec = importlib.util.spec_from_file_location('roco_env.coverage', '../tmp/coverage.rebuild.4.py')
mod = importlib.util.module_from_spec(spec)
sys.modules['roco_env.coverage'] = mod
spec.loader.exec_module(mod)
unittest.main(module=None, argv=['shadow', 'tests.test_cond_self_debuff_power'], exit=True)
PY
# 换判据文件：把最后一行里的 tests.test_cond_self_debuff_power 换掉即可（例：tests.test_effect_coverage ⇒ Ran 21 · failures=10, errors=6）
# 注：tmp/shadow-inject.py 里写死的是第 1 稿；要跑最新稿，用上面这段。
```

> ⚠ **跑全量 `roco/tests` 之前，先确认 `8765` 上的服务不需要重启。**
> 这条是纪律，不是建议：全量会拉起大量 Python 子进程，而当前引擎侧本来就是红的，
> 把"跑测试"和"服务状态变了"两件事混在同一次读数里，就再也分不清是谁的锅。
> `npm run test:env` 就是上面那条全量命令。

### 🔴 服务现状：**"网页 200"不等于"一切正常"**

- `8765` 端口的 **node 层还活着**：`curl -s -o /dev/null -w '%{http_code}' localhost:8765/roco.html` 回 **`200`**（`lsof` 显示监听者是 node 进程）。
- **但 Python 引擎侧已经退化** —— 因为上面那条：`coverage.py` 停在 HEAD 版，缺 3 个入口，`roco_env/service.py` import 不过。

⇒ 🔴 **不要把 HTTP 200 读成"功能都好了"。** 网页是壳，引擎才是算的地方。

### 纪律（踩坑记录）

项目累积了一套编号纪律（我 14:55 读到的最新一条是 **`#181`**（附录 DR），**号还在涨**；顺带一条：计划书里**最小的纪律号是 `#10`**，所以别写"从 #1 起"）。入口：

```sh
grep -n '纪律' docs/roco/coach-理想形态-计划书-2026-09-30.md | tail -8
```

最该记住的五条（逐字取自计划书 CK5 那张「从**一次锚点错**长出来的纪律」表）：

| # | 纪律 | 防什么 |
|---|---|---|
| **`#132`** | 回滚要回**改前** | 防 `git checkout` |
| **`#134`** | 红了**先停** | 防三级放大 |
| **`#135`** | 未提交状态是**资产** | 防整层误删 |
| **`#142`** | 机制与结果**分开报** | 别把"搭好了"当"跑通了" |
| **`#143`** | **最少活动件** | 拼接式入侵 ⇒ 零输出 |

> 这五条不是格言，是**这次事故的直接产物**：第 1 条（`#132`）说的就是 `coverage.py` 被抹掉的那一下。

### 还没完成的（如实）

- 🔴 **重建没有落正文**：`coverage.py` 仍是 HEAD 版；只有影子注入下才绿。
- 🔴 **`test_effect_coverage` 仍是红的**（`10F + 6E`）。
- 🔴 **`roco_env/service.py` import 不过** ⇒ 引擎侧当前不可用。
- 🔴 计划书写明的下一步目标 —— **两个单文件绿 ⇒ 才落正文 ⇒ 全量 `Ran 846` / `OK (skipped=1)` / `exit=0`** —— **尚未达到**。

### 这一节的读数怎么来的（2026-09-30 采样）

```
《计划书》行数          wc -l                                    ⇒ 7193（@14:56 采样；仍在增长）
coverage.py            782 行 · git hash-object = HEAD blob      ⇒ 0c9f6f14bab2（工作区 == HEAD）
coverage.py            正文 sha256                               ⇒ cc3de2ba09c8b5d1…
分支 / commit          git branch --show-current / log -1        ⇒ wip/roco-coach-2026-09-30-1418 / ae826e3
本地 master            git log -1 master                         ⇒ 51c04fb
远端                   git ls-remote gitee / origin              ⇒ ae826e3 / b5a8d51（origin master 579ab2f）
快照                   git for-each-ref refs/snapshots/          ⇒ 1 条，双亲提交（stash 形）
8765                   curl -o /dev/null -w '%{http_code}'       ⇒ 200（监听者：node）
单判据（直接）          unittest tests.test_cond_self_debuff_power ⇒ Ran 7 · FAILED (errors=4)
单判据（影子第 4 稿）   同上（sys.modules 指向 tmp/ 稿）           ⇒ Ran 7 · OK
effect_coverage（影子） unittest tests.test_effect_coverage       ⇒ Ran 21 · FAILED (failures=10, errors=6)
roco/tests 规模         ls roco/tests/test_*.py | wc -l           ⇒ 70（另有 4 个辅助 .py，合计 74）
roco/tests 用例数       grep -h -c 'def test_' roco/tests/*.py     ⇒ 846（静态清点；未跑全量）
受影响判据文件          grep -rl <3 个缺失名> roco/tests/          ⇒ 19
纪律编号上限            grep -oE '`#[0-9]{1,3}`' 计划书            ⇒ #176
```

> 采样时间 2026-09-30；本仓库当时正在被**活跃编辑**（计划书与 README 都在改），
> 所以上表里的**行数**与 **commit** 是最易过期的两项 —— 其余几项（是否红、是否 200）是结构性的。
