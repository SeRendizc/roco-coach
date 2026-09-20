# 小芽 · v0.1

**一个宠物对战游戏，以及一个住在游戏里的 AI Coach「小芽」。**

这是第一版完成品：规则引擎、对战、成长、UI 全部从零写，
**没有任何第三方 npm 运行依赖**，不接模型也能完整游玩。

- 界面版本：营地 `v0.11`
- 引擎版本：`RULES_VERSION = 0.6`
- commit：`1717cd515e8d900e6f2ccccb8707a0a85a809989`
- 测试：**375 / 375 通过**（357 unit + 18 browser）

---

## 直接运行

```sh
git clone https://github.com/SeRendizc/roco-coach.git
cd roco-coach
./run-v0.1.sh
```

脚本会自动取出一份 v0.1 检出、选一个空闲端口、起服务并打开浏览器。
不需要 Python，不需要下载模型，不需要 API Key。

其他用法：

```sh
./run-v0.1.sh --port 9000   # 指定端口
./run-v0.1.sh --no-open     # 不自动打开浏览器
./run-v0.1.sh --stop        # 停掉 v0.1 服务
./run-v0.1.sh --clean       # 移除 v0.1 检出
```

也可以手动跑：

```sh
git worktree add ../roco-v0.1 v0.1.0
cd ../roco-v0.1 && npm start          # http://127.0.0.1:8765/
```

---

## 这一版有什么

### 三种角色，都做成可运行的闭环

| | 做什么 | 怎么出现 |
|---|---|---|
| **军师** | 单回合候选排序前后一致、依据可查的决策建议（不是胜率，也不是全局最优） | 顶部一句话，「看看原因」展开依据 |
| **老师** | 复盘、讲解、循序渐进 | 整局结束后的复盘与阶段小测 |
| **陪练** | 能闲聊、有情绪、记得历史与偏好 | 左下角独立气泡，带头像与名字 |

### 核心设计：把「算」和「说」分开

**引擎负责对，模型负责讲。**

- 伤害、克制、命中、胜负一律由引擎算
- 「该不该调工具」由代码判断，不由模型自由发挥
- 模型说出的话要经过多条校验，越界就回退到本地模板
- 模型说出的每个数字都必须能在工具回执里找到

### 玩法

14 只宠物、23 个技能、7 种属性（两个独立三环相克）、6 选 4 配招、
3 件携带物、2 种环境、强化/驱散、异常状态（灼烧/中毒/减速）、
倒下补位与主动换宠、5 个关卡、培养加点与存档迁移。

---

## 主动介入（不需要玩家打开聊天）

- 前台对战等待 20 秒，或 8 秒以上在不同可用动作间来回关注 → 产生候选提示
- 每个决策最多一次，每局最多两次停留/关注提示，两次至少间隔 45 秒
- 不在后台、动画中、聊天中、预制体验、结束后或 PVP 触发
- 三档偏好：适度 / 仅关键风险 / 安静；关闭一条提示后本场抑制
- 出招时立即隐藏旧提示
- **当前是可测的规则门控，还没有训练用户习惯模型**；hover 不表示玩家水平低

---

## 测试

```sh
npm test              # 375 项全量自动测试，约一分钟
npm run test:smoke    # 真实 Chrome 冒烟（需要本机有 Chrome）
```

另外还有一组离线实验与评测，产物写在 `reports/`：

```sh
npm run build:knowledge      # 从 tactics.json 与引擎生成知识卡（纯 Node）
npm run eval:retrieval       # 检索四臂对照（纯 Node，几秒）
npm run eval:balance:quick   # 单宠胜率对照（纯 Node，几秒）
npm run eval:balance         # 平衡矩阵：5,796 场无头仿真（纯 Node，约 3 分钟）
npm run train:intervention   # Q-learning 干预时机（纯 Node，约 1 分钟）
```

工具评测（判模型该调哪个工具、以及**参数对不对**）：

```sh
npm run eval:live:selftest   # 判分自检：不需要网络与额度
npm run eval:live:dry-run    # 用例彩排：不调模型
npm run eval:live            # 真实调用：会消耗额度
```

---

## 可选：接入模型

不接模型也能完整游玩。想接 DeepSeek，启动后打开
`http://127.0.0.1:8765/connect.html` 填入 API Key
（**只留在服务端进程内存里，不落盘、不写日志**）。

也可以用 macOS 钥匙串：

```sh
./scripts/start.sh --save-key   # 存一次
./scripts/start.sh              # 以后直接启动，自动读取
```

---

## 可选：Python 与离线模型实验

游戏与上面「实验」一节的全部命令**只需 Node**。
语义检索与离线工具路由头实验需要 Python，且首次要联网下载模型：

```sh
.venv-agent/bin/python -m pip install -r requirements-agent.lock.txt
node scripts/eval-semantic.js                                        # 多语嵌入模型，约 458MB
.venv-agent/bin/python scripts/train-tool-router.py                  # SmolLM2-135M，约 260MB
```

Python 环境或模型缺失时**不会报错中断**：语义检索自动退回词项检索。

---

## 边界（说清楚没做什么）

- **本地对战是同一台设备分屏同屏，不是联网 PVP。** 服务端仍接受客户端提交的快照，
  不是权威状态；客户端快照不构成生产环境的权限边界。
- **一回合搜索不是全局最优。**
- 浏览器语音已停用（`VOICE_FEATURE = false`）：本机 macOS Chrome 上无论指定哪个
  zh-CN 声音都会播成粤语并伴随结尾爆音，触发点是 `speechSynthesis.cancel()`。
  代码保留在开关后，查明原因前不宣称有语音能力。
- 上下文先保守裁剪，再用官方 tokenizer 计数。
- **真人学习收益、生产模型的权重训练、生产权限认证与独立大样本评测尚未完成。**
- 两条训练都是离线的：Q-learning 学干预时机；SmolLM2 冻结骨干后训练两个工具输出行
  （实际更新 1152 个参数）。**生产用的 DeepSeek / 主模型没有训练过，线上一直用基座模型。**

---

## 接下来

项目下一阶段的唯一记录入口是
[`docs/roadmap/DSH-EXECUTION-STATE.md`](https://github.com/SeRendizc/roco-coach/blob/master/docs/roadmap/DSH-EXECUTION-STATE.md)，
以及 [`LEGACY.md`](https://github.com/SeRendizc/roco-coach/blob/master/LEGACY.md)。

本项目正在继续升级为《洛克王国：世界》**手游**内嵌 Coach「小芽 2.0」，
但**数据层（M0/M1）尚未接管这个可玩 Demo 的 UI 与引擎**——
也就是说 `master` 上的游戏部分与 v0.1 完全一致，启动方式与玩法都一样。
