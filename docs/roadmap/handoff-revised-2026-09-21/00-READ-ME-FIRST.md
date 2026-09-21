# Roco Coach 旗舰项目升级包：先读这份

> 日期：2026-09-21  
> 目标仓库：`SeRendizc/roco-coach`  
> 面向：继续开发本项目的 Coding Agent / Codex / 人类开发者  
> 核心原则：**不要推倒重写。以当前 `master` 的真实代码、测试与 release guard 为事实源，在此基础上升级。**

## 0. 一句话目标

把当前项目从“一个能玩的《洛克王国：世界》训练场 + 小芽 Coach Demo”，升级成：

> **一个可移植到官方游戏宿主的主动式 AI Coach 研究原型：全量图鉴负责知识与筛选，经过证据门槛的规则引擎负责确定性结算，策略层负责复杂决策，LLM 负责工具使用、约束理解与解释；战前配队、局中建议、局后复盘形成完整闭环。**

这不是“给 48 只精灵写规则”的小玩具，也不是“让 LLM 猜伤害”的聊天机器人。

## 1. 当前仓库已经不是从零状态

截至本轮检查，仓库已经具备：

- Roco 专用前端：`src/client/roco.html / roco.js / roco.css`
- Python 规则环境：`roco/src/roco_env/`
- joint-step、合法动作、公开观察、确定性 replay
- Node ↔ Python bridge / tool contracts
- 48 只 Demo 阵容池
- 622 只冻结快照的 L1 图鉴层
- 阵容评估、2–3 回合 planner
- 小芽三角色闭环：军师 / 老师 / 陪练
- 主动提醒门控、过期规划丢弃、PVP 公平门控
- 本地 Qwen3.5-4B 对照、SFT 实验、shadow replay
- release guard、浏览器验收、mock host
- 数据 provenance / license / conflict / coverage 文档

因此禁止把项目重新改成一个新 React/FastAPI 项目，禁止“为了漂亮”绕开现有规则引擎和验收体系。

## 2. 当前最重要的新增发现：能量规则基线很可能错了

当前 `master` 的 `roco/src/roco_env/env.py` 仍明确写着假设：

```text
ENERGY_MAX = 6
ENERGY_REGEN_PER_TURN = 1
入场初始 2
```

而现行公开资料多处支持：

```text
常规能量上限 10
聚能是一个主动行动，回复 5
并非“每回合天然 +1”
```

并且当前技能图鉴存在能耗 8 的真实技能；现有 `ENERGY_MAX=6` 会把它们永久判成不可用。这会污染：

- 当前 Demo build 与全量候选排序；
- 能量曲线；
- 行动合法性；
- Coach “对手高能量”建议；
- planner；
- 轨迹；
- team model；
- SFT 数据；
- UI。

**所以新阶段第一件事不是继续加宠，而是把“真实基础规则校准”设为 P0。**

## 3. “621 vs 622”“579 vs 824”不要强行抹平

当前外部 BWIKI（2026-09-09）展示：

- 621 个精灵形态关联公开特性；
- 579 个战斗技能；
- 18 个系别；
- 242 个公开特性。

仓库冻结快照 `roco-world-s4-2026-09-10` 当前是：

- 622 条精灵记录；
- 824 条技能记录。

这两个数字**不是简单谁对谁错**，可能由形态口径、隐藏/未实装记录、技能记录类型、来源版本差异造成。

正确做法：

1. 保留 frozen snapshot，不偷偷改旧数据；
2. 新增 `source_scope` / `record_kind` / `live_public_count`；
3. 做差异报告；
4. 产品层说“600+ 精灵”，不要硬宣称仓库的 824 条 = 824 个当前战斗技能。

## 4. 这套文档怎么读

| 文档 | 解决的问题 |
|---|---|
| `01-PROJECT-POSITIONING-AND-SCOPE.md` | 项目应该是什么、求职价值、风险与边界 |
| `02-DATA-SCALE-AND-CULTIVATION.md` | 600+ 精灵工作量、全量数据、个体养成、盒子筛选 |
| `03-BATTLE-RULES-AND-TURN-RESOLUTION.md` | 战斗状态、行动、时序、特殊机制、未核实项 |
| `04-SIMULATOR-ARCHITECTURE.md` | 规则引擎如何从 48 扩到 600+，而不是堆 if-else |
| `05-TEAM-BUILDING-AND-COACH.md` | 锁定 0/1/3 只、盒子个体有好坏时怎么配队 |
| `06-UI-UX-REDESIGN.md` | 大厅 / 精灵盒子 / 阵容工坊 / 战斗 / 复盘长什么样 |
| `07-AI-TRAINING-AND-EVALUATION.md` | Search / BC / SFT / RL / Agentic RL 怎么拆 |
| `08-IMPLEMENTATION-ROADMAP.md` | 直接施工的 P0/P1/P2 任务与验收标准 |
| `09-CODING-AGENT-MASTER-PROMPT.md` | 可以直接交给 Coding Agent 的总 Prompt |
| `10-SOURCES-AND-CONFIDENCE.md` | 外部来源、置信度、实机待验证项 |
| `11-CURRENT-REPO-GAP-AUDIT.md` | KEEP / FIX / ADD / DEFER 当前差距审计 |
| `12-REVISION-NOTES.md` | 本次复核发现的问题、修改决策与给 DSH 的使用说明 |
| `13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` | 六宠标准 PVP、未知对手、600+ 候选与 3 秒阵容工坊 |

## 5. “622 只都做”到底意味着什么

不要把三个概念混在一起：

```text
Data coverage      数据里知道这只精灵是谁
        ≠
Knowledge coverage 能回答它的图鉴/技能/养成问题
        ≠
Simulation coverage 能精确执行它携带的所有技能、特性、时序
```

建议长期保持四层：

```text
L1 全量知识层
622 条冻结记录 / 当前公开约 621 形态
所有精灵都能查、筛、展示、进入“我的盒子”
        ↓
L2 阵容评估层
只需要静态信息、合法技能、角色/速度/属性/资源特征
默认覆盖全部 600+
        ↓
L3 可模拟层
技能 + 特性 + 时序全部达到机制覆盖门槛
按“效果原语覆盖”扩，不按宠物数量硬扩
        ↓
L4 验证与回归集
按机制维护固定 microcase，并从全量图鉴分层抽样 build；当前 48 个 Demo build 只作迁移夹具
```

**不再把 48～60 只精灵当作未来产品层级。** 所有精灵来自同一份版本化数据包。玩家选中某个精灵与配招时，系统按需编译它依赖的技能、特性、时序和规则：

```text
PetDefinition + OwnedPet + BattleBuild
→ 收集 required primitives / triggers / rules
→ Capability Compiler
→ FULL_VERIFIED / SIMULATABLE_UNVERIFIED / PARTIAL / KNOWLEDGE_ONLY / REFUSED
→ 可模拟则进入战斗；否则解释缺少什么，并推荐兼容配招或替代精灵
```

因此第 49 或第 301 只精灵只要复用已支持原语，就能自动进入可模拟层，不需要手写新的宠物分支。回归体系改成“固定规则 microcase + 全量目录分层抽样 + 历史失败样本”；当前 48 个 Demo build 只用于迁移期间防回归，不定义产品边界。

**结论：622 条都进入 UI、知识/RAG、OwnedPet 和阵容候选层；精确战斗资格由 build 依赖的能力门槛动态决定。**

## 6. 本阶段必须保持的红线

1. **只做《洛克王国：世界》手游。** 不把页游规则混入。
2. **不知道的规则不猜。** `verified / empirical / hypothesis / unknown` 必须留痕。
3. **LLM 不算伤害、不决定合法动作。**
4. **模拟“官方内嵌宿主”**：结构化事件/状态 API；不做抓包、内存读写、自动点击、排位自动化。
5. **不把“能跑”写成“真实准确”。** 当前伤害公式、若干时序仍待实机校准。
6. **不因为全量图鉴就宣称全量模拟。**
7. **UI 中工程字段默认隐藏。** provenance、state_version、coverage、digest 放开发者抽屉。
8. **现有成功的 runtime / replay / stale-result guard / test guard 不重写。**
9. **新的真实规则证据优先于旧模拟轨迹。** 基础规则一旦修正，旧轨迹必须标 invalidated/rebuild。
10. **每次规则改动都要有 migration impact report。**

## 7. 项目对外名称与一句话

中文：

> **小芽 Roco Coach：面向复杂回合制游戏的可训练、可验证主动式 AI Coach**

英文简历：

> **Roco Coach — A Verifiable Proactive Game Coach with a Deterministic Simulator and Trainable Decision Policies**

明确它是非官方研究原型。

## 8. 开发者开始前的最短检查

```bash
git status
git log -1 --oneline
npm test
node scripts/roco/verify-release.mjs
```

然后读取：

```text
docs/roco/PROGRESS.md
docs/roadmap/DSH-EXECUTION-STATE.md
docs/roco/FULL-CATALOG.md
docs/roco/COVERAGE-LAYERS.md
docs/roco/EFFECT-PRIMITIVES.md
docs/roco/COACH-ADVICE-DESIGN.md
docs/roco/GAME-ADAPTER.md
```

若本文与仓库当前事实冲突，**先以当前代码 + 可跑测试为准，再更新本文档；不要静默选择自己更喜欢的版本。**
