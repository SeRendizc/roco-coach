# M0 仓库审计：KEEP / ADAPT / RETIRE / MISSING

> 类型：**只读审计结论 + 迁移边界建议**。本文件**不表示**任何 RETIRE 项已被执行。
> 本轮（M0+M1）**没有修改任何运行代码**，`engine.js` / `content.js` / `progression.js` / `coach/*`
> 与审计前逐字节一致。RETIRE 是**下一轮及以后**的动作建议，需要各自单独验收。
>
> 基准 commit：`1717cd515e8d900e6f2ccccb8707a0a85a809989`
> 审计时间（UTC）：2026-09-20T16:14Z 起
> 现场证据目录：`reports/roco/m0-baseline/`

---

## 0. 审计方法（以及为什么不能只读文档）

规则：**文档写了某功能，不等于当前运行态具备它。**

每一项都按下面三件事之一判定，并写下证据：

| 判定手段 | 含义 |
|---|---|
| **读码** | 直接读当前 commit 的源码，并引用文件与导出行 |
| **跑起来** | 实际执行命令 / 驱动浏览器，保留原始日志 |
| **只读文档** | **不作为**完成证据，只用于发现「文档与代码不一致」 |

本轮实际执行的三条验证命令与结果：

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm test` | **375/375 通过**（357 unit + 18 browser），0 失败 / 0 跳过 / 0 取消，退出码 0 | `reports/roco/m0-baseline/npm-test.log` |
| `npm run test:smoke` | **全部通过**（营地 14 张卡、属性筛选、进入对局、最快速度、16 次出招打到结束、无卡死、控制台零报错），退出码 0 | `reports/roco/m0-baseline/smoke.log` |
| `npm run eval:retrieval` + `eval:balance:quick` | 均退出码 0，产物 JSON 已落盘 | `reports/roco/m0-baseline/evals.log` |

**环境**：Node `v24.20.0`、npm `11.19.0`、系统 Python `3.9.6`、仓库 `.venv-agent` Python `3.9.6`、
`Darwin 27.0.0 arm64`。完整见 `reports/roco/m0-baseline/env.txt`。

---

## 1. 文档与运行态不一致（必须先记录，不得静默取一边）

| # | 文档说法 | 现场核对结果 | 影响 | 处理 |
|---|---|---|---|---|
| 1 | `docs/IMPLEMENTATION-STATUS.md` 顶部：「本次核对现场 `npm test` 为 **257 项**」 | 现场 **375 项**（357 unit + 18 browser），全通过 | 文档数字过时；若照抄会低估现有回归网 | 以现场日志为准。**本文件不改该文档**（属另一份交付物），只在此登记 |
| 2 | `03-IMPLEMENTATION-BRIEF.md` §2 称「现有 14 只自创宠物」 | 现场 `SPECIES.length === 14`，名称：烬尾狐、潮甲龟、芽角鹿、炽鬃狮、溪刃獭、苔盾菇、砾背獾、鸣电雀、岚翎隼、云绒蛾、晶角犀、伏光貂、磐耳羊、灵瞳猫 | 一致 | 无需处理 |
| 3 | `README.md` 称「**没有第三方 npm 运行依赖**」 | 现场 `package.json` 的 `dependencies` 与 `devDependencies` **都是空对象 `{}`** | 一致，且是重要的可移植性优势 | KEEP，后续不得为此引入运行时依赖 |
| 4 | `03-IMPLEMENTATION-BRIEF.md` §2 列举数据写在 `engine.js`/`content.js`/`progression.js`/`coach/*` | 四个文件均存在且非空，导出面与描述相符（见第 2 节） | 一致 | 无需处理 |
| 5 | 交接包记录的基线 commit `1717cd5` | `git rev-parse HEAD` = `1717cd515e8d...` | 一致 | 无需处理 |

> 结论：交接包对**代码结构**的描述是准确的；对**测试数量**的描述（经 `IMPLEMENTATION-STATUS.md`）
> 过时且偏低。因此后续任何「已有多少测试」的说法都必须现场复算。

---

## 2. 逐模块 KEEP / ADAPT / RETIRE / MISSING

判定口径：
- **KEEP**＝原样保留，新 ruleset 复用它，不改动；
- **ADAPT**＝保留主体，但需要增加 ruleset 分支 / 新数据源适配；
- **RETIRE**＝不再作为玩家可见的主路径；**先隔离、不删除**，保留回归价值；
- **MISSING**＝当前完全不存在，必须新建。

### 2.1 `engine.js`（355 行，自创规则唯一来源）

| 内容 | 现场事实 | 判定 | 理由与迁移动作 |
|---|---|---|---|
| `RULES_VERSION='0.6'` | 存在 | **KEEP** | 版本号单一来源机制本身要保留；新版需并列 `ruleset_id` |
| `RULES` 常量对象 | 存在，含伤害系数、能量、状态跳数、培养收益等 | **ADAPT** | 保留「数值只写一次」的设计；手游数值**不得**写进这里，应来自 `data/roco/normalized/` |
| `SKILLS`（23 条自创技能） | `Object.keys(SKILLS).length === 23` | **RETIRE**（隔离，不删） | 自创技能名与手游技能无来源关系。**禁止**把自创技能改个名字冒充手游技能（硬性边界） |
| `SPECIES`（14 只自创宠物） | `SPECIES.length === 14` | **RETIRE**（隔离，不删） | 同上。移入 `legacy-demo` ruleset；旧测试继续跑它们 |
| `TYPES`（7 属性）/ `TYPE_ADVANTAGES`（两个三环） | 火→草→水→火、岩→雷→风→岩 | **RETIRE** | 手游属性为 18 种且相性表已导入 `normalized/.../types.json`，**与自创表不兼容** |
| `HELD_ITEMS` / `ITEMS` / `ENVIRONMENTS` | 存在（3/3/2） | **RETIRE** | 自创道具与环境；手游对应机制尚无一手证据 |
| `multiplier()` | 自创：克制 1.5 / 被克 0.75 / 同系 1，无免疫、无本系加成 | **RETIRE** | 手游相性表是 `types.json` 里的 multiplier 数值，必须由它驱动 |
| `damage()` | `round((power+burnBonus+atk-def) × 相性 × 防御 × 环境 × 携带物)`，最低 1 | **RETIRE** | **这是自创公式，不是手游公式。**官方伤害公式**无来源**，已登记为 `unknown`。禁止把它当作手游公式 |
| `legalActions()` | 返回 `skill` / `switch` / `item` / `escape`，含能量、连续防御、满血治疗、无环境清风等约束 | **ADAPT** | 「合法动作由引擎枚举」这个**架构**是核心资产，要保留；具体约束需按手游机制重写 |
| `resolveTurn()` | 单方提交 + 对手行动 → 同回合结算；含优先级、速度、平速 tie、异常回合末、环境倒计时、补位 | **ADAPT** | 时序骨架可复用；**顺序细节未经手游证据核验**，必须由 microcase 重新确立 |
| `priority` 值 | `switch:5` / `item:4` / `guard:3` / `疾爪:1` / 普通:0 | **RETIRE（数值）** | 这些具体优先级是自创的。手游的出手顺序、换宠占不占回合、道具优先级**均无一手证据** → `unknown` |
| `evaluate()` / `rankEnemyActions()` / `chooseEnemy()` | 存在；`rankEnemyActions` 对每对（对手行动×玩家回应）双 tie 结算取均值，跳过不可结算组合 | **ADAPT** | 一回合分支枚举 + 最坏分支思路值得保留；但「没有胜率、只是局面评分」的诚实口径必须继承 |
| `step()` / `snapshot()` / `history` | 每次结算写入 `{before, action, opponent, events, after, result}` | **KEEP** | **这是最有价值的资产之一**：状态版本 + 事件溯源的骨架，M2 的 `replay` 直接建立在它上面 |
| `buildVersusOpponent()` | 同 seed 可复现地抽 3 只、配 4 技能与携带物 | **ADAPT** | 可复现抽样是好机制；精灵池要换成手游 12 只 |

**关键判断**：`engine.js` 的价值不在「规则对」，而在
**「合法动作枚举 + 状态版本 + 事件历史 + 可复现种子」这套骨架**。
手游规则必须走 `roco_env`（Python，见 MISSING），
**Node 不得再实现一套手游伤害公式**（避免两套规则漂移）。

### 2.2 `content.js`（关卡与预制场景）

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `STAGES`（5 个自创关卡） | 青芽草地 / 溪流浅滩 / 余烬山道 / 苔影密林 / 冠军高地 | **RETIRE** | 全部为自创名字与自创敌方阵容，属玩家可见内容，违反「不把自创内容当手游内容」。按实施书 §5.2 换成 `mechanics-tutorial` / `team-lab` / `s4-preview` 三类场景 |
| `stageOptions()` | 从 STAGES 派生选项 | **ADAPT** | 函数形态可留下，数据要换 |
| `SCENARIOS`（4 个预制体验） | hesitate / risk / loss / growth | **ADAPT** | 「预制体验不写真实进度」（`settle()` 里 `game.preview` 短路）这个设计要保留 |
| `TACTIC_CARDS`（49 张战术卡） | 全部 `game:'pet-coach'`、`rulesVersion:'0.6'`，`authority:['engine.js']` | **RETIRE** | 内容全部基于自创机制（灼烧 6 伤害、防御减伤 65%、**破甲重击**、**余烬追猎**…）。手游卡必须重建，且每条带来源 URL / 赛季 / 支持等级 |

> 注意：`TACTIC_CARDS` 属于**玩家可见**内容，且描述的是自创数值（如「余烬追猎增加 18 威力」）。
> 这是「旧宠物旧技能伪装成手游机制」风险最高的地方，必须整批替换而不是零星改写。

### 2.3 `progression.js`（43 行，成长与存档）

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `TRAINING = {hp:+12生命, atk:+4攻击, speed:+3速度}` | 与 `RULES.training` 一致，`rules.test.js` 逐字段断言 | **RETIRE** | 这是自创养成；手游的性格/天分/血脉/等级换算**均无来源**（已登记 `unknown`） |
| `MAX_STAT_TRAINING=5` / `trainingCapacity(level)=level+3` | 存在 | **RETIRE** | 自创上限 |
| `newProfile()` / `loadProfile()` | 含**逐字段校验 + 失败回退**；注释记录了一次真实事故：白名单漏改导致**整个存档被丢弃** | **KEEP（机制）** | 这是很重要的**防御式迁移**实践，必须继承到新版存档校验 |
| `settle()` | 胜/平/负给 xp 与 token；`preview` / `escape` / 重复 `claimed` 全部短路；速胜徽章 ≤10 回合 | **ADAPT** | 「预制体验不写真实进度」「同一局不重复结算」要保留；奖励数值需重定 |
| `configurePet()` | 校验 4 个**不同**且**在 learnset 内**的技能 + 合法携带物 | **KEEP（机制）** | 配招合法性校验的形态正确，手游版保留同一思路 |
| 存档 `version:1` | 单一版本号，不符则整体回退 | **ADAPT** | 新版必须加 `schemaVersion` + `rulesetId` + migration receipt（实施书 §5.2） |

### 2.4 `coach/toolbox.js`（260 行，本地 Agent 工具合同）

| 工具 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `read_state` | 无参数，返回当前公开局面；描述明确「不含电脑待执行动作或真实随机种子」 | **KEEP** | 公开信息边界写在合同里，应原样继承 |
| `search_rules` | `query` 1..180 字符 | **ADAPT** | 需加 `ruleset_id` 与赛季过滤 |
| `compare_actions` | 描述「非胜率」 | **ADAPT** | 手游版需返回 `coverage` / `evidence_ids` |
| `simulate_branch` | 候选用**稳定标识**（`skill:guard` / `switch:turtle` / `item:potion:turtle`）而非列表下标；支持 `unresolved` 标记 | **KEEP（接口设计）** | 「不用下标」是对抗模型幻觉的好设计，已由 R01/R02 参数缺陷用例守着 |
| `inspect_training` / `read_match` / `read_evidence` / `read_last_turn` | 分页 `offset/limit`、`matchId` 防跨局取同号回合 | **KEEP** | 同上 |
| `validToolArgs()` | 白名单参数 + 范围校验；拒绝额外字段 | **KEEP** | 「模型不能传任意路径或未声明参数」是核心边界 |
| `executeTool()` | 首行 `if(isLiveMatch(context))throw Error('policy')` | **KEEP** | PVP 熔断放在工具入口而非提示词里，是正确的位置 |
| —— | 缺少 `query_rules(ruleset)` / `evaluate_team` / `compare_team_change` / `plan_actions` / `summarize_battle` | **MISSING** | 实施书 §5.2 要求的 5 个新工具全部不存在 |

### 2.5 `coach/runtime.js`（377 行，上下文 / 模型调用 / 事实校验）

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `buildContext()` | 组装公开状态 + 培养 + 最近事件 + 检索证据 | **ADAPT** | 需加 `ruleset_id` / `state_version` |
| `runCoach()` | `role` 路由（军师/老师/陪练）+ provider 注入，`localProvider` 为默认 | **KEEP** | provider 可注入 = 未来 DeepSeek/Qwen 可 A/B，架构正确 |
| `gatherAgentEvidence({limit=3})` | 有界 ReAct：按回执选下一步，支持停止、非法工具、重复调用、超预算、失败分支 | **KEEP** | 有界只读工具循环是核心资产 |
| `checkReceiptConsistency()` / `checkGroundedAnswer()` | 校验答案数字与引用是否能在回执里找到；拦截 `unsupported-number` / `unsupported-citation` / `unsupported-certainty` / `simultaneous-action-order` / `item-name-drift` / `causal-cancelled-action` | **KEEP** | **这是本项目最有辨识度的部分**：模型说出的数字必须能在工具回执里找到 |
| `assembleContext()` / `fitModelMessages()` | 上下文裁剪 + token 预算 | **KEEP** | 与 ruleset 无关 |
| `policyFor()` / `requiredTool()` / `resolveEvidenceTurn()` | 由代码决定必须调哪个工具 | **ADAPT** | 规则版本变化后「必须查证」的条件要跟着变 |
| —— | 工具不支持时明确说「这个机制还没核验」 | **MISSING** | 实施书 §5.2 要求；当前无 `unsupported` 话术通路 |

### 2.6 `coach/scheduler.js` + `coach/policy.js`（主动介入）

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `CoachScheduler` | 请求合并（`pending`）、缓存带 `expires`、同请求复用 | **KEEP** | 并发与缓存机制与 ruleset 无关 |
| `isLiveMatch()` | **只**静音 `pvp-live`；`pvp-local` **不**静音 | **KEEP** | 注释记录了「静音本地对战是过度设计」的修正，理由充分（本地对战双方共用同一教练，且教练从不读对手待执行动作） |
| `isVersusMode()` | `pvp-local` / `pvp-live` | **KEEP** | 小工具函数 |
| 触发特征 | 现有：停留时长、悬停次数、关注动作变化、风险档位、每局次数上限、45 秒冷却 | **ADAPT** | 实施书要求新增：最佳/次佳动作差、致命风险、犹豫时间、来回悬停、最近提示数、玩家静默偏好 |
| 输出动作 | 现有：`silent` / `micro_hint` / `action_hint` / `defer_to_review` 的**近似**（`shouldNudge` 布尔门控 + 档位） | **ADAPT** | 需要显式四档动作，而不是布尔放行 |
| 硬约束 | 安静档短路、关闭后本场静默、失焦不触发、状态过期取消 | **KEEP** | 「硬约束不能被奖励交换掉」已正确实现 |

### 2.7 `coach/strategist.js` + `coach/retrieval.js` + `knowledge/`（RAG）

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `strategist.js` 导出面 | `strategist` / `searchKnowledge` / `applicability` / `resolveCitation` / `verifyCitations` / `buildKnowledgePacket` / `rosterAdvice` / 以及大量 `strategistSession` / `dwellSignal` / `strategistTrigger` 等介入函数 | **ADAPT** | 检索骨架与「引用回查」保留；内容与 ruleset 过滤要换 |
| `knowledge/tactics.json` | 49 条 | **RETIRE**（移入 `knowledge/legacy/`） | 与 `TACTIC_CARDS` 同源，全部自创机制 |
| `knowledge/reference.generated.json` | 44 条，由 `scripts/build-knowledge.js` 从 `engine.js` 的 `SPECIES`/`SKILLS` 生成 | **RETIRE** | 生成器读自创数据，改数据即改卡 |
| `knowledge/semantic-corpus.json` | 93 条（含语义检索语料） | **RETIRE** | 同上 |
| `cards` 总数 | **93** = 49 + 44 | **RETIRE** | 实施书要求旧卡移入 `knowledge/legacy/`，新卡带来源 URL/赛季/支持等级 |
| `searchKnowledge()` 版本过滤 | 按 `rulesVersion` 过滤，不符返回 0 卡 | **KEEP（机制）** | 「版本不符即阻断」是正确的 fail-closed 行为，新版扩展为按 `ruleset` + 赛季 + 支持等级三重过滤 |
| `resolveCitation()` / `verifyCitations()` | 引用必须能解析回具体卡 | **KEEP** | 引用回查是事实校验的一部分 |
| —— | `knowledge/roco/{rules,tactics,lineups}.jsonl` | **MISSING** | 手册 §5.1 要求，当前不存在 |

### 2.8 `coach/experience.js` / `teacher.js` / `companion.js` / `memory.js`

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `experience.js`（442 行） | `observe` / `trackAttention` / `shouldNudge` / `attentionText` / `watchCandidate` / `taskStamp` / `taskIsCurrent` / `markdown`（转义后才渲染有限 Markdown） | **ADAPT** | 注意力与任务新鲜度机制保留；`attentionText` 引用的自创技能名要换 |
| `memory.js`（148 行） | 显式偏好、事件、journal（≤240）、reflections（带 evidenceIds）、`adaptiveGate`、`teachingPlan`、`coachSelfAudit` | **KEEP** | 记忆架构与 ruleset 无关；`coachSelfAudit` 让教练复盘自己是否迟到/重复/出错，值得保留 |
| `teacher.js`（190 行） | 复盘 → 一个关键决策 → 相似练习 | **ADAPT** | 教学闭环保留；题目内容依赖自创机制 |
| `companion.js`（2252 行，最大模块） | `companionState` 派生 momentum/lossStreak，档位 R0–R3 在三处生效（模板、`replyConstraints`、生成后克制扫描）；`PREACH` 黑名单拦截说教 | **KEEP** | 与 ruleset 无关；陪练不应因换题材而重写 |
| —— | 陪练里写死的句子（如「我们已经练过速度判断了」） | **ADAPT** | 需改成不绑定具体自创机制的表述 |

### 2.9 `server.js`（19.9k）与前端

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| `server.js` | 静态服务 + `/api/*`；`publicAssets` 白名单（`rules.test.js` 有测试断言「每个浏览器 import 的模块都在白名单里」） | **KEEP** | 白名单机制防 404 事故，必须保留 |
| `app.js`（122k）/ `index.html` / `style.css`（53.8k） | 完整可玩 UI；`VOICE_FEATURE=false` | **KEEP** | 本轮**明确不替换默认 UI**（M0/M1 边界） |
| 浏览器验收脚本 | `scripts/browser-smoke.mjs`（Chrome CDP）、`opponent-smoke.mjs`、多个 `cdp-*.js` | **KEEP** | 页面验收不依赖任何额外插件 |

### 2.10 测试与评测资产

| 内容 | 现场事实 | 判定 | 动作 |
|---|---|---|---|
| 测试文件 | 19 个 unit 文件 + `browser.test.js` / `replace.test.js` | **KEEP** | **禁止为让新测试通过而删除旧测试** |
| 测试数量 | **375/375 通过** | **KEEP** | 这是回归网；新版必须与之并存而非替换 |
| `evals/regression-set.json`（16 条） | 覆盖并列合理/低置信/证据缺失/应沉默 | **KEEP** | 自有说明已声明「只是回归网，不是质量评测集」，口径诚实，保留 |
| `evals/tool-arguments.test.js` | 保留 R01「上一回合」/ R02 分支候选两个**已复现参数缺陷**作为回归 | **KEEP** | 回归样例化做得正确 |
| `benchmark.js` / `scripts/eval-*.js` | 检索四臂、平衡矩阵、live eval、semantic eval | **ADAPT** | 评测跑法保留；数据换成手游 ruleset 后需重跑建立新基线 |
| `evals/roco/cases/microcases-v1.jsonl` | **不存在** | **MISSING** | 下一轮核心产物 |
| `roco/`（Python `roco_env`） | **整个目录不存在** | **MISSING** | 规则唯一来源 |
| `data/roco/` | 本轮新建（M1） | **新增（M1）** | 见 `data/roco/sources.yaml` |
| `models/registry.yaml` | **不存在** | **MISSING**（后置） | M8 才需要，本轮不做 |

---

## 3. 汇总表

| 模块 | 决定 | 一句话理由 |
|---|---|---|
| `coach/runtime.js` 的**事实校验** | **KEEP** | 「模型说的数字必须能在回执里找到」是项目最有辨识度的资产 |
| `coach/runtime.js` 的**有界工具循环** | **KEEP** | 有界只读 ReAct + 停止/失败分支已实现并有测试 |
| `coach/toolbox.js` 的**合同与参数校验** | **KEEP** | 稳定标识不用下标；白名单参数；PVP 熔断在入口 |
| `coach/companion.js` / `memory.js` | **KEEP** | 与 ruleset 无关，换题材不应重写 |
| `coach/policy.js` 的 PVP 边界 | **KEEP** | 只静音 pvp-live，理由与测试都在 |
| `engine.js` 的**时序骨架 + 状态版本 + 事件历史** | **KEEP（架构）** | 状态机/回放底座是真正可复用的部分 |
| 全部 **375 项测试** | **KEEP** | 反向保护；删除即失去回归能力 |
| `engine.js` 的 `SKILLS` / `SPECIES` / `TYPES` / 伤害公式 / 优先级数值 | **RETIRE** | 自创机制，**与手游无来源关系**；先隔离不删 |
| `content.js` 的 `STAGES` / `TACTIC_CARDS` | **RETIRE** | 玩家可见的自创关卡与自创数值战术卡 |
| `knowledge/*.json`（93 卡） | **RETIRE** | 全部 `game:'pet-coach'`、`rulesVersion:'0.6'`，内容基于自创机制 |
| `progression.js` 的养成数值 | **RETIRE** | 手游性格/天分/血脉换算无来源 |
| `coach/scheduler.js` 的触发特征 | **ADAPT** | 需要显式四档动作与「最佳/次佳动作差」等新特征 |
| `coach/strategist.js` 的检索与引用回查 | **ADAPT** | 骨架保留，内容与三重过滤重做 |
| `roco/src/roco_env/**`（Python） | **MISSING** | 手游规则唯一来源，Node 不得再实现一套 |
| `data/roco/**` schema 与来源台账 | **MISSING → 本轮已建** | M1 产物 |
| `knowledge/roco/{rules,tactics,lineups}.jsonl` | **MISSING** | 手游知识卡 |
| `coach/roco-client.js` | **MISSING** | Node 调本地规则服务的唯一适配器 |
| `query_rules` / `evaluate_team` / `compare_team_change` / `plan_actions` / `summarize_battle` | **MISSING** | 5 个新工具全部不存在 |
| `evals/roco/cases/microcases-v1.jsonl` | **MISSING** | 下一轮产物 |
| 阵容模型 / planner / learned value / SFT / RL | **MISSING**（未开始） | **不得**在任何汇报里写成已实现 |

---

## 4. 本轮**实际执行**的改动边界（防止把建议当已做）

本轮（M0+M1）实际只做了下面这些，其余全部是**建议**：

| 类别 | 实际动作 |
|---|---|
| **新增** | `data/roco/**`（来源台账、原始快照归档、normalized 数据、provenance、conflicts）、`scripts/roco/**`（安全 Lua 解析、schema、importer、hash、cross-check、支持矩阵、microcase 生成、notify、浏览器验收）、`docs/roco/**`（本文件 + 许可矩阵 + 冲突记录 + 支持矩阵 + microcase 计划 + 验收 checklist）、`docs/roadmap/DSH-EXECUTION-STATE.md`、`reports/roco/**`、`evals/roco/**` |
| **修改** | ① `.gitignore`：追加忽略「解压后的第三方快照」「172MB 的 NRC_AI 归档」「本地 token 文件」；② `package.json`：`test:unit` **末尾追加**一个测试文件，并新增 `test:roco` 脚本（未改动任何既有脚本内容） |
| **未修改** | `engine.js`、`content.js`、`progression.js`、`rules.js`、`coach/*`、`knowledge/*`、`app.js`、`index.html`、`style.css`、`server.js`、**全部 375 项既有测试** |

验证方式：`git status --porcelain` 与 `git diff --stat` 现场可见（见第 5 节）。
其中 `reports/balance.json` 与 `reports/retrieval.json` 被改动，是**运行 `npm run eval:balance:quick` /
`eval:retrieval` 时脚本按设计原地写回**造成的，不是手工编辑；原始内容仍在 git 中可回退。

## 5. 复现命令

```sh
cd /Users/serendizc/Developer/roco-coach
git rev-parse HEAD                      # 1717cd515e8d900e6f2ccccb8707a0a85a809989
git status --porcelain                  # 开始时为空
npm test                                # 375/375，日志 reports/roco/m0-baseline/npm-test.log
npm run test:smoke                      # 需 8765 在跑；日志 reports/roco/m0-baseline/smoke.log
node scripts/roco/selftest-lua-parse.mjs # 13/13 上游 Lua 文件安全解析
```
