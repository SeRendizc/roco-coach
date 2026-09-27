# 交接：下一会话从这里开始（2026-09-25 第二版·详细版）

> **这份文件是下一会话（或下一轮 goal）的唯一入口。** 第一版偏「行动项」，这一版把**背景知识、要读哪些文件、
> 短期与长期目标**都补齐。文中每条事实都标注来源：`[实测]` = 本会话真跑出来的数字；`[文档]` = 仓内已有文档写的；
> `[人类]` = 人类口述/批注。**不确定的地方明确写「不知道/待人类补」，不要当成事实。**

---

# 第 0 部分 · 一分钟读懂这个项目

- **产品**：《洛克王国：世界》的**嵌入式 AI 教练「小芽」**。玩家在网页上选六只精灵 → 打 PVP → 小芽在旁边
  给**基于规则的事实**（动作比较、未来后果、复盘教学），并且有一个**阵容工坊**帮玩家配队。
- **三条硬红线**（违反=白做）：
  1. **伤害与胜负永远由 Python 规则引擎算**，LLM 只做解释，**不许算伤害、不许编胜率**；
  2. **未知 fail closed**：读不出来的机制必须登记为 unsupported，不许近似成普通伤害；
  3. **保留资产不许退化**（`retained-assets` 套件会抓「判据还在不在、还接不接着跑」）。
- **技术栈**：Node/ESM 服务端（`src/server/`）+ 原生 JS/CSS 单页客户端（`src/client/`）+ Python 规则引擎
  （`roco/src/roco_env/`）+ 无头 Chrome 的 CDP 验收脚本（`scripts/roco/*.mjs`）。
- **当前交付形态**：`v3` 旗舰，人类口径是**只要桌面 demo**（窄屏不用管）。

---

# 第 1 部分 · 当前状态（冻结事实，`[实测]`）

| 项 | 值 | 怎么自己复核 |
|---|---|---|
| HEAD | `579ab2f`，工作树 292+ 条改动**全部未提交**（刻意） | `git rev-parse --short HEAD; git status --porcelain \| wc -l` |
| 门禁 | `verify-release.mjs` **24/24 全绿**（会话开始时实测）；**实测耗时约 25 分钟**（不是 9 分钟 —— `demo-acceptance` 单独 172s，再有并行任务时更慢） | `node scripts/roco/verify-release.mjs` |
| 最近全绿 | `reports/roco/verification/last-green.json`（head `579ab2f…`、24 套件） | `cat reports/roco/verification/last-green.json` |
| 状态文档一致性 | `verify-state-doc.mjs` 判「一致」 | `node scripts/roco/verify-state-doc.mjs` |
| 引擎 | `npm run test:env` → **479 OK（skipped=1）**（2026-09-25 天气回滚后；回滚前 511） | 同左 |
| 单元 | `npm run test:unit` → **1047/1047** | 同左 |
| 起服务（带 key 的正式姿势） | `./scripts/start.sh`（从 macOS 钥匙串读 `pet-coach-deepseek`，**会 kill 8765 旧进程再起**；日志 `tmp/server.log`） | `curl -s localhost:8765/api/bootstrap` 看有没有 `server` 块 + `configured/verified` |
| 云端模型 | **已实测真的通**（不是「configured:true」就算）：`POST /api/verify` 回执带 `usage` | 见 §8.4 的复算命令 |
| 门禁的 24 套 | env, unit, bridge, toolbox-roco, plan-e2e, trajectories, trajectories-model, sft-split, model-manifest, provenance, rag-eval, game-data-pack, reconciliation, sprite-identity, state-doc, guard-selftest, browser-acceptance, demo-acceptance, mobile-sweep, box-acceptance, workshop-acceptance, roco-ux-acceptance, **battle-feedback**（第 24，本会话新增）, retained-assets | `node -e "import('./scripts/roco/verify-release.mjs').then(m=>console.log(m.SUITES.map(s=>s.id).join(',')))"` |

**关键产物位置**（改相关代码前先看这些，别猜）：
`reports/roco/verification/{latest,last-green}.json`（门禁）、`reports/roco/verification/failures/*.log`（红了的全量日志）、
`reports/roco/demo-acceptance/{demo-acceptance.json,coach-positions-browser.json}`（演示链路 + 12 局面矩阵）、
`reports/roco/ux-acceptance/browser-roco-ux-acceptance.json`（39 条页面判据）、
`reports/roco/battle-feedback.json`（伤害数字/先后/灰置红⭐）、
`reports/roco/rc401/{weather-layer,effect-coverage,trait-worklist}.json`（天气与覆盖尺子）、
`reports/roco/rc404/regression-set.json`（回归集指纹）、`reports/roco/rc602/`、`reports/roco/rc604/`。

---

# 第 2 部分 · 要读哪些文件才能掌握全貌（按「先读什么」排序）

**A. 计划与状态（必读，1 小时内能读完）**
0. 本文件的 **§8 / §9**（文件末尾两节）——**2026-09-25 两轮口径与在办事项**，先读它。配套两份新方案：
   `docs/roadmap/MODEL-ROUTING-PLAN.md`（DeepSeek / Qwen3.5-4B / Qwen3.8-27B 三档分工 + 3 秒分段预算 + 8 条工程落点 + 三条「不许当卖点」的实测边界）、
   `docs/roadmap/CULTIVATION-PAGE-PLAN.md`（培养页 + 三级导航 + 换招 + 养成四项如实呈现）。
1. `docs/roadmap/HANDOFF-2026-09-23.md` — 人类上一版交接，产品意图与验收口径的源头。
2. `docs/roadmap/FLAGSHIP-V3-CHECKLIST.md` — **RC 台账**：每个 RC 的状态 + 证据路径 + 边界。看「IN_PROGRESS / NOT_STARTED / BLOCKED」三类就知道剩什么。
3. `docs/roadmap/PLAYER-LOOP-CHECKLIST.md` — **玩家闭环** P0/P1 + A1–A11/B1–B5 等条目（「培养机制」的原始条目就在 B1–B5，其中 **B5 = 换招/调序**）。
4. `docs/roadmap/DSH-EXECUTION-STATE.md` — 逐轮执行状态（**最新在文件末尾**）。本会话新增 **C6.63–C6.81**：
   立绘错位与重做、RC-401 三批、48 个体去重、v3h 收敛审计与处置台账（C6.73）、人类四条缺陷的真机复核（C6.74）、
   天气批次（C6.75）、**owned build 与实战配招 48/48 不一致**（C6.76）、门禁回绿的两条真因（C6.77）、
   灰置红⭐ 验证 + J6 判据（C6.78）、死代码清理批二（C6.79）、v3 验收「假点击」与物品屏口径冲突（C6.80）、
   人类五决策（C6.81）。
5. `docs/roadmap/FLAGSHIP-V3-REDIRECT.md` — 为什么 v3 是现在这个形态（六槽、3 秒 Serving、候选规则）。
6. `docs/roadmap/SNAPSHOT-2026-09-22.md`、`MORNING-REPORT-2026-09-21*.md`、`handoff-revised-2026-09-21/` — 历史快照，**只在需要追溯某条口径的出处时读**。
7. `docs/roadmap/CROSS-MACHINE-COORDINATION.md` — Windows/训练侧协作边界（别把训练侧的东西做进本仓）。

**B. 产品与规则口径（改行为前必读）**
- `docs/roco/DEMO-PLAN.md`、`DEMO-PERF.md` — 五分钟 demo 的步骤与性能预算。
- `docs/roco/COACH-ADVICE-DESIGN.md` — 建议层检测器与优先级（页面提示的口径就在这份）。
- `docs/roco/RC-502-BATTLE-INFO.md`、`RC-503`（见 checklist）— 战斗页信息架构与 Coach 取舍。
- `docs/roco/RC-105-MANA-AND-ACTIONS.md`、`RC-106-SIX-PET-BATTLE.md` — 4 心/魔力、六宠开局。
- `docs/roco/RC-401-EFFECT-COVERAGE.md` — 效应原语三批（连击/特性层/**天气层**），覆盖尺子怎么读。
- `docs/roco/RC-402-ON-DEMAND-BUILDS.md`、`RC-403-SUPPORT-CLASSIFIER.md`、`RC-404-REGRESSION-SET.md` — 按需配招、支持度分档、回归集。
- `docs/roco/RC-602-TEAM-RANKER.md`、`RC-604-OPPONENT-BELIEF.md` — 本会话新落地的两个算法模块（都自报 `available:false` 的边界）。
- `docs/roco/RULE-CONFIG.md`、`RULE-EVIDENCE-LEDGER.md`、`TURN-ORDER.md` — 「能力必须由配置声明」「证据六级」「回合顺序」三条基础设施。
- `docs/roco/GAME-DATA-PACK.md`、`CATALOG-RECONCILIATION.md`、`FULL-CATALOG.md` — 数据包与 622/579/245 的对账口径。
- `docs/roco/OWNED-PETS.md`、`PET-SPRITES.md`、`PET-BOX.md`、`WORKSHOP.md` — 48 个体、立绘、盒子、工坊。
- `docs/roco/RC-501-RETAINED-ASSETS.md` — **保留资产**清单（13 条）与它怎么判「还在被判据守着」。

**C. 设计稿（UI 收敛的唯一标准）**
- `docs/roco/mockups/battle-v3h.html`（可交互稿）+ `docs/roco/mockups/battle-v3h-fragment.html`（片段版，判据读它）
- `docs/roco/mockups/v3h/*.png` — **1440×900 真图 7 张 + 390×844 一张**（`battle-v3-default/element/heart/items/log/switch/xiaoya`）。
  **UI 改动一律以这些图为准**，不许照旧渲染图另起炉灶（人类原话）。

**D. 代码地图（改哪里）**
- 客户端：`src/client/roco.{html,css,js}`（战斗/选人主页面，roco.js 4000+ 行）、`battle-v3.{css}`（v3h 战斗版式）、
  `team-workshop.js`（工坊，shadow DOM）、`box.{html,js,css}`（精灵盒子）、`index.html`（**现在的首页/营地**）、`connect.html`。
- 服务端：`src/server/index.js`（路由 + CSRF + 静态白名单）、`src/server/roco-service.js`（只读接口与对局编排）。
- 教练层：`src/coach/*.js`（`coach-advice.js` 建议检测器、`roco-experience.js` 介入层门控、`team-*.js` 工坊四件、
  `teacher-review.js` 复盘、`companion.js` 陪练、`rag-index.js` 检索、`team-ranker.mjs`/`opponent-belief.mjs` 本会话新增）。
- 引擎：`roco/src/roco_env/{env,schema,effects,parse,traits,events_text,coverage,support,regression,rule_config,data}.py`。
- 验收：`scripts/roco/*.mjs`（每个套件一个脚本，`--selftest-only` 时不开浏览器只验判据）。
- 判据：`tests/*.test.js`（单元）、`roco/tests/*.py`（引擎）、`tests/evals/**`（评测类）。

**E. 数据（大多**只读**，改动前先看纪律）**
- `data/roco/normalized/roco-world-s4-2026-09-10/**` — **冻结快照，一个字节都不许动**（进 `Ruleset.files` 指纹，
  尤其 `support-matrix.json`：改了会让已录制的 6048 条轨迹复验变红，本会话实测过）。
- `data/roco/rulesets/{legacy-sim-v1,mobile-s4-candidate-v2,mobile-s4-candidate-v3}.json` — 规则配置（**能力开关住在这里**）。
- `data/roco/owned/owned-pets.json`（48 个体/48 build）、`data/roco/derived/*.json`（派生产物，多数可由脚本重建）、
  `data/roco/battle-modes.json`、`data/roco/evidence/*.json`（证据台账 / microcase 记录表）。

---

# 第 3 部分 · 人类 2026-09-25 给的五个决策（**下一会话直接按这个做**）

| # | 人类口径 | 行动项 | 硬约束 / 判据 |
|---|---|---|---|
| 1 | **立绘框底边横线：可以的**（要处理） | `battle-v3.css` 的 `.b3-spritebox` 把底边接缝压掉（同族底色 `border-color` 或上下渐隐遮罩） | 给**同一张截图的改前/改后像素对照**；`roco-ux-acceptance` 39/39 不许掉 |
| 2 | **卡底三格不写标签**（维持现状）+ **战斗页横向太长，适当往里收** | ① 只把「与设计稿冲突」记档（`battle-v3.css:474` 有你 2026-09-23 的批注）；② 收窄战斗区 | 收窄前**先定目标宽度**（现在实测 `#battle-panel` 宽 **1440**、`.b3-wrap` `[1,88,1438,742]`、三列 `232/914/232`、内容盒 1406；设计稿是 1408）→ 改完必须重跑 `roco-ux-acceptance` + `demo-acceptance` + `mobile-sweep` |
| 3 | **owned build 与实战配招 48/48 不一致：单开子代理深入调研；培养页要能换招** | 派**只读**调研子代理（提示词骨架见 §5.1），查清「规范四技能到底是哪一份」；换招功能进培养页 | 调研产物落 `/tmp/`，**不改仓内文件**；结论必须给证据分级 + 「换招以哪一份为基准、要改哪几处」 |
| 4 | **物品屏「每局 2 次 · 冷却 3 回合」：确定的** | 按「是确定数值、允许显示」办：把 `browser-battle-v3-acceptance.mjs` 的 `item-no-definite-numbers` 前提改成「数字**必须**来自引擎/已登记证据（`data/roco/derived/pvp-magic.json`、`EV-PVP-WISH-POWER-UP`），**没登记才不许写**」+ 补反证 | ⚠ **动手前跟人类确认一句读法**（另一种读法是「确定性数字算违规 ⇒ 页面回未登记」） |
| 5 | **天气不用做可见；人类核实天气仅存在于 PvE ⇒ 这个天气系统可以删掉** | **回滚 RC-401 批次三**：`weather` 配置块、`env.py` 天气层与 7 个钩子、`traits.py` 5 条天气特性、`parse.py` 天气解析、`events_text.py` 天气句子、`coverage/support/regression` 天气口径、`roco/tests/test_weather_layer.py`（32 条）与 `reports/roco/rc401/weather-layer.json` | legacy/v2 **逐位不变**（8 条 golden 指纹 8/8）；`test:env` 从 511 回到相应条数；`reports/roco/rc404/regression-set.json` **必须重新生成**（否则 `DiskArtifactIsFreshTest` 红）；`data/roco/normalized/**`（含 `support-matrix.json`）**一个字节都不许动**；删完在 checklist 的 RC-401 行如实写「批三已按人类口径回滚（天气仅 PvE）」 |

---

# 第 4 部分 · 本会话已经做完的（**不要重做**；改到相关文件时别弄坏）

- **① 人类点名的四条战斗页缺陷 —— 全部真机复核**（真无头 Chrome + CDP 真鼠标）：
  顶栏点组随引擎存活数 **6→5**、对手侧**镜像**取自 `opponent.living_count`（`env.py` 里就是 `len(foe.living())`）；
  对手第 6 回合倒下后**零点击自动补位**（`phase=battle`、`needs_replacement=[]`、新宠满血 442）；
  投降 ⇒ `result=loss` + 结算浮层 ⇒「回主页」战斗面板 hidden、回到选阵容屏；
  愿力链路 **PASS 47 / FAIL 1**，那条 FAIL（用别的攻击技会静默收回愿力冲击）已修并复核、restore 文案按 `reason` 分支、
  「应对状态 2.5 倍」实测 `power_used 200.0`。
- **② v3h 收敛**：审计 A 档 9 条逐条归宿 = **6 修 / 1 触发验证 / 2 复核不采纳**（理由逐字在 C6.73）。
  实测：解除 `main{max-width:1240px}` 枷锁 ⇒ `#battle-panel` **1440**；三列 **232/914/232**、我方卡 452、顶栏点组 x=**21**、
  徽章圆角 8px 且 14 枚零溢出；**灰置+红⭐** 在能量 1 时真的触发（`short=yes`+`b3-slot--grey`+不可点+⭐ `rgb(255,154,154)`）。
- **③ 判据**：新增门禁套件 **`battle-feedback`**（6 判据 + 11 反证：浮字可见性 40/40 帧命中自身、出手→受击 **+449.6ms**、
  J6 灰置红⭐）；`demo-acceptance` 局面矩阵修好（12/12 到位、11 开口、两遍逐字节相同、加 `ROCO_MATRIX_DUMP` 诊断钩子）；
  `test:unit` 新增 `roco-team-ranker` / `roco-opponent-belief` / `roco-role-label-consistency`。
- **④ 死代码清理两批**：工坊 8 个幻影 id + 16 条死样式；两条点已删元素的验收脚本；`ROLE_CN` 译法统一；
  `roco.js` 5 处假落点（`#turn-chip`/`#phase-chip`/`#act-escape*`/`#act-surrender`）+ `roco.css` 2 条死规则。
- **⑤ 算法线**：RC-602 排序器（1128 对全可算、P95 0.065ms、`calibrated:false` 钉住置信等级）、RC-604 对手信念三条基线
  （频次如实 `available:false`）。
- **⑥ 引擎线**：RC-401 批三天气层（464→511 OK、可模拟实体 344→**350**、8 条 golden 指纹 8/8 不变）——**即将按决策 5 回滚**。

**踩过的五个坑（别重犯）**：① 采样前清会话要连 `said` 一起清；② 等待提示落定期间**不要**反复催 `plan`（第二次会落在 60s 冷却+去重窗口里，把刚开口的气泡藏回去）；③ 对手补位后页面挂着 `state.foeReplaceTimer`，会在采样窗口里再推进一手 ⇒ plan 被判过期（采样前先等 `state_version` 稳定 ≥150ms）；④ 确定性判据必须排除易变字段（`pass`/`screenshot`/`hint_wait_ms` 及其在 `probe`、`silent_reason` 字符串里的副本、`battle_id_digest`）；⑤ **改了 ruleset 配置要重建 `reports/roco/rag/rag-eval.json`**（RAG 语料按 ruleset 配置计数，否则 `unit` 红——本会话就红过一次）。

---

# 第 5 部分 · 短期任务（下一会话 1–3 轮内）

**顺序（前两步不要颠倒）**
1. **先跑基线**：`node scripts/roco/verify-release.mjs`（**实测约 25 分钟**）——**24/24 才是起点**；红了先看 `reports/roco/verification/failures/*.log`。
   ⚠ **门禁必须在冻结树上跑**：先确认没有别的 agent 在写仓（本轮就因为引擎被改到一半，浏览器判据量出全 0）。
2. **看 §8（本轮交接补充）**：它会告诉你 2026-09-25 这一轮已经落地了什么（立绘接缝 / 战斗区收窄 / 物品屏判据 / 天气回滚 / DS API 真通），
   以及**下一会话该从哪继续**（换招基准、愿力强化「不占行动」的引擎通道、培养页/三级战斗）。
2. **派只读调研子代理（决策 3）**，提示词骨架：
   > 只读调研，产物落 `/tmp/`，**不要改仓内任何文件**。问题：48 只精灵的**规范四技能**到底应该是哪一份？
   > 三条来源链逐条读出来并给证据：① `data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json#pets[].candidate_moveset`（12 只 baseline，冻结、进 `Ruleset.files` 指纹）；② overlay `layer-playable-48/learnsets.json`（36 只）+ 引擎选招规则；③ RC-203 `scripts/roco/{build-owned-pets,owned-pets-lib}.mjs` 的选择规则。
   > 交付：每条链的**选择规则原文**、48 只逐只对照表、差异分类（顺序不同/集合不同/来源不同）、
   > 「引擎实战真正用的是哪一条链」的代码证据（`Ruleset.build_support_of` / `data.py` 的载入点）、
   > 以及「培养页换招应以哪一份为基准、改哪几处（引擎/工坊/盒子/判据）」。**不许猜，读不出来的写读不出来。**
3. **天气回滚（决策 5）**：顺序 = 先删测试与配置 → 再删引擎层 → 重生成 `regression-set.json` → `npm run test:env` → 门禁。
4. **立绘接缝（决策 1）** 与 **物品屏判据前提（决策 4，先跟人类确认读法）**。
5. **战斗区收窄（决策 2）**：先量设计稿 + 定目标宽度 → 改 → 三套浏览器判据全跑。
6. **培养页 / 三级战斗（§6）**：等人类补一句「三级具体指哪三级」。

**方法纪律（本会话验证有效）**：能分就分（子代理并行、主线程只做集成与判据）；不要空等后台任务；
一个文件同一时间只一个写者；改完必贴实测数字；判据不许放松；门禁必须在**冻结树**上跑。

---

# 第 6 部分 · 中长期目标 / 路线

**人类新提的产品方向（原话）**：「培养页和培养机制什么时候做？我还想把首页改成培养页，然后现在的首页改成进入 pvp 后，战斗的做成三级。」

**我的理解（待人类确认）**：
- `src/client/index.html`（现在的首页/营地）→ **改成「培养页」**，成为养成入口（练哪只 / 换招 / 资质·性格·血脉 / 资源成本预览 / 教练建议）。
- 现在首页承载的内容 → 挪成**进入 PvP 之后**看到的一屏。
- 「战斗做成三级」= 把「进入 PvP → 选阵容/工坊 → 开打」拆成**三级页面**；**具体三级是什么要人类补一句**（我不知道）。

**依赖链（不能并行硬做）**：
`换招` → 依赖决策 3 的调研结论（现在两份配招在打架；不先定基准会做出「换了一套、打的是另一套」）
→ `培养页` → 依赖「换招」与养成四项（资质/性格/特长/血脉，它们的**效果在冻结数据里全是 UNKNOWN**，
`data/roco/owned/schema.json` 的 `growth_attribute_policy` 只用标签存，**评估不得当加成**）
→ `三级战斗` → 依赖人类的定义 + 现有页面判据的重写。

**中长期路线（按 `FLAGSHIP-V3-CHECKLIST.md` 的 RC 台账）**
- **近期（有明确判据、可做）**：RC-802 四类证据逐类判据（ruleset/support/latency/digest）、RC-801「五分钟时间预算」判据、
  批一扫剩的死代码（`team-workshop.js` 的 `cycle()`、`tw-group-note`、旧行动坞「逃跑」页签无落点、
  `browser-battle-v3-acceptance.mjs` 已修但 `#turn-chip` 这类**同类**还可能有）。
- **中期（要人类输入或外部条件）**：RC-601 轨迹重建（**BLOCKED**：候选规则未定）、RC-605 SFT 重建（依赖 RC-601）、
  RC-704 介入学习开 `on`（**BLOCKED**：需 3–5 人盲评）、RC-504 真人盲评（**BLOCKED**：需 3–5 人）、
  RC-102 candidate promotion（**BLOCKED**：需一次实机录制，清单见 `data/roco/evidence/rule-evidence-microcase-records.json`）。
- **中期（算法线，可做但收益取决于数据）**：RC-401 覆盖继续（`effect_unparsed 31` / `trigger_unknown 192`）、
  RC-702/703 自博弈与 Agentic RL（**前置**：RC-601/605 与可独立判 reward）、RC-603 Learned Value（**DEFERRED 给人类亲训**）。
- **长期（旗舰交付）**：RC-801 五分钟 Demo 剩余段（锁定进交接已完成一段；**局末教学端到端**与**时间预算**还差）、
  RC-803 面试报告（**NOT_STARTED**，需要人类给受众与口径）。

**外部阻塞（不改代码能解决的只有三件，来自 checklist）**：① 一个 DeepSeek key（云臂对照，当前 `configured:true / verified:false`）；
② 3–5 个真人（盲评）；③ 一次实机录制（`MC-E08` 标准 PVP 魔力/力竭优先级最高）。

---

# 第 7 部分 · 红线与常用命令（速查）

**红线**：先测量再改；改完贴实测数字；门禁在冻结树上跑；未知 fail closed；不造胜率/概率/百分数；
保留资产不退化；`data/roco/normalized/**` 与 `data/roco/rulesets/legacy-sim-v1.json`、`mobile-s4-candidate-v2.json`
非必要不动（前者进指纹）；**不要管窄屏**（但 `mobile-sweep` 在门禁里，别弄红）；不许为了让门禁变绿而放松判据。

```bash
# 门禁（24 套，约 9 分钟）
node scripts/roco/verify-release.mjs
# 只看某些套件
npm run test:env          # 引擎 511
npm run test:unit         # 单元 1047
node scripts/roco/browser-roco-ux-acceptance.mjs      # 页面 39/39
node scripts/roco/browser-battle-feedback-acceptance.mjs   # 伤害数字/先后/灰置红⭐ 6/6
npm run roco:demo-acceptance                          # 演示链路 121/121
node scripts/roco/browser-battle-feedback-acceptance.mjs --selftest-only   # 不开浏览器，只验判据+反证
node scripts/roco/verify-state-doc.mjs                # 状态文档与现实一致
# 起服务（真机探针）
PORT=8899 node src/server/index.js
# 覆盖尺子（**必须用显式路径**，默认 --out 是 CWD 相对，写错过一次）
cd roco && python3 -m roco_env.coverage --out ../reports/roco/rc401/effect-coverage.json --traits-out ../reports/roco/rc401/trait-worklist.json
# 回归集（改引擎行为后必须重生成，否则 DiskArtifactIsFreshTest 红）
cd roco && python3 -m roco_env.regression --out ../reports/roco/rc404/regression-set.json
```

**遇到门禁红时的第一动作**：`reports/roco/verification/failures/<suite>-<时间>.log`（全量输出；`latest.json` 只留尾部几行，
第 81 轮吃过「unit 红但单跑绿却查不出是哪个用例」的亏）。

---

# 第 8 部分 · 2026-09-25 会话交接补充（**下一会话先读这一节**）

## 8.1 本轮已落地（都有实测数字）

| # | 事 | 状态 / 实测 |
|---|---|---|
| 1 | 门禁基线 | `verify-release.mjs` → `verdict:"pass"`、**24/24 全绿**（会话第一件事） |
| 2 | **立绘框底边接缝**（决策 1） | 已改 `src/client/battle-v3.css`（底边改卡片底色 + `::after` 底衬 34px + 立绘 32px 渐隐）：**框底那一行 y=715 跳变 46.4 → 0.8**、跨框底亮度差 **23.4 → 0.0**、几何**逐位相同**。产物 `reports/roco/seam-fix/`（`REPORT.md` + 改前/改后图 + `compare.txt` + `width.json`）；工具 `scripts/roco/measure-spritebox-seam.mjs`。**如实记档**：立绘素材自己画的地面那条横线（y=690–697）只是被削弱（45.0→37.7），没消掉 —— 那是素材不是画框 |
| 3 | **战斗区收窄**（决策 2） | 面板 **1440 → 1408**（两侧各 16px，= 设计稿总宽）、三列 232/**882**/232；**立绘两次都是 347×463**（高度约束 ⇒ 收窄不会把立绘变小，占框宽 0.826→0.859）。落点 `src/client/roco.css` 末尾 |
| 4 | **物品屏判据**（决策 4） | 新前提「数字必须来自引擎实数或已登记证据，**同时该显示的必须显示**」：门禁套件 `battle-feedback` 新增 **J7**（实测 **7/7 + 12/12 反证**）；`browser-battle-v3-acceptance.mjs` 判据改名 `item-numbers-must-be-registered` |
| 5 | **天气回滚**（决策 5） | `test:env` **511 → 479 OK**；legacy/v2 **sha256 与回滚前逐字节相同**；`data/roco/normalized/**` 一字节未动；golden **14 个 digest 逐位不变**；回归集 `unreachable` 回到 **3**；覆盖 **344/824**；RAG 1694/77。详见 DSH `C6.82` |
| 6 | **配招来源调研**（决策 3，只读） | 结论写进 RC-203 与 B5 行；`owned.ordered_skills` 是 `shuffle(rng,pool).slice(0,4)` **伪随机抽样**；规范四技能 = 引擎 loadout（合并 `data.py:515-535`、读点 `env.py:231`） |
| 7 | **DS API 真通** | `./scripts/start.sh` 把 8765 换成当前树 + 一次真调用 `/api/verify` → `usage:{prompt_tokens:9,completion_tokens:2}` |
| 8 | 文档 | `docs/roadmap/DSH-EXECUTION-STATE.md` 的 **C6.82** 是这一轮的完整台账（含踩坑 3 条） |

## 8.2 人类这一轮给的新口径（原话要点）

- **物品屏**：「每局可用 2 次 · 冷却 3 回合 · **不占行动**；首领化一样不占行动……这是我确认过的！！以我为准」。
  **但与 2026-09-23 台账原文「占一次行动」直接冲突**，且**引擎今天按「占一手」实现**（`step_joint` 每方每回合一手）。
  ⚠ **页面文案本轮故意没改**（改了就是让页面说谎）—— 见 §8.7 待人类一句话。
  人类另补一句：「『愿力冲击』**就是个技能，这个算行动**」（即：道具不占行动、换上来的技能照常占）。
- **三级战斗**：「首页是培养页面（或者可以加个启动页），然后**点 pvp 功能进入现在的首页选配队**，然后进入战斗页面」。
- **战斗区宽度**：「考虑一下**立绘的适配程度**，不用完全对齐设计稿，往回收收」。
- **流程**：「不要 timeout 硬等输出」；「尽可能中文显示」；「做点 agentic 的东西而不是一直做游戏」。

## 8.3 下一会话的顺序（前两步别颠倒）

1. **先跑门禁**（约 25 分钟，冻结树）确认 24/24。
2. **换招（B5）+ 培养页**：先按 §8.5 的结论定「规范四技能基准 = 引擎 loadout」，
   再决定用哪条路（A 重生成 owned / B 对局接受 `loadouts` 覆盖）—— **B 的代码通道只差一行**
   （`src/server/roco-service.js:1897`），但**不先定基准就是"把随机噪声上线"**。
3. **愿力强化「不占行动」的引擎通道**（若人类点头）：给引擎加「出手前自由动作」+ 让
   `magic_policy.occupies_action=false` 成为**配置声明的能力**（`overrides.py` 白名单不覆盖它），
   然后页面文案才改；判据：用掉愿力强化后**回合数不变**、技能仍可点；反证：把它当那一手 ⇒ 红。
4. **培养页 / 三级战斗**（人类已给定义）：`index.html` → 培养页（核心能力 = 换招 + 养成四项；
   ⚠ 资质/性格/特长/血脉的**效果在冻结数据里全是 UNKNOWN**，不得当加成）→ 点 PvP → 选配队（现 `roco.html`）→ 战斗页。
5. **AGENTIC 线**（人类明确想要，别再只做游戏）：见 §8.4。

## 8.4 DS API / agentic（人类本轮最关心的一条）

**结论：不用等 key。** 钥匙串里已有 `pet-coach-deepseek`（`scripts/start.sh:17/33/47`），
2026-09-17 真跑过 **44/44**（`reports/live-model-eval.json`）。本轮已实测真通（见 8.1 #7）。
复算命令（一条，成本 ≈ 11 token）：
```bash
CSRF=$(curl -c /tmp/ck.txt -s http://127.0.0.1:8765/api/bootstrap | python3 -c "import sys,json;print(json.load(sys.stdin)['csrf'])")
curl -b /tmp/ck.txt -H "x-coach-csrf: $CSRF" -H "Origin: http://127.0.0.1:8765" -H "Content-Type: application/json" \
     -X POST -d '{}' http://127.0.0.1:8765/api/verify     # 回执里必须有 usage 才算真通
```
**代码级现状（决定「为什么一直在做游戏」）**：
- `/api/roco/*`（战斗/工坊/盒子）**全程不碰云端模型**；云臂只在 `/api/coach`（聊天/复盘/陪练）。
- 仓里**只有一处真 agent 循环**：`src/coach/runtime.js:244-288`（政策打第一枪 → 每轮喂回执问下一步 →
  **3 步上限** → `agentStop` 落回执）；`localModelPlanner:570-611` 是单发，不算循环。
  差四件才算真 agentic：**失败纠错**（一次非法参数就终止）、跨请求状态、工具可写、模型能决定「要不要开始」。
- **数字守卫第二层只在浏览器里**（`src/coach/client.js:34/38` 调 `runtime.js:361-404`）；
  `/api/coach` 的服务端回执**没有 `validation`** ⇒ headless/curl 调用方拿到的是没被守卫筛过的正文。
**不需要 key 就能做的 7 条**（详见 `/tmp/roco-ds-api/REPORT.md` §4，每条带必红反证）：
A1 把 44 条预注册判据做成**离线录制回放门禁**（推荐先做）→ A2 把 `checkGroundedAnswer` 搬到服务端 →
A3 给 `src/coach/coach-advice.js` 接页面出口（纯规则零模型、玩家可见）→ A4 循环加**一次纠错** →
A5 stale 作废贯通到聊天域 → A6 加 `deepseek` 轨迹臂空壳 → A7 `/api/models` 的 `verified` 加 `verified_source`。

## 8.5 其余新发现（别重复踩）

1. **8765 上原本跑的不是这棵树**（旧进程 PID 62505，形状早于 2026-09-22，来自 `.v0.1-run` worktree）——
   本轮已用 `./scripts/start.sh` 换成当前树。**以后人类说「我没看到」先查这个**。
2. **配招有四条链**（详 RC-203 行）：引擎 loadout / `sorted(skill_id)` 的**合法动作表**（C6.76 当时量错的就是它）/
   owned 的伪随机抽样 / `roster-48.json`（盒子页读，与引擎 **2/48 不一致**，真 bug）。
3. **立绘接缝的两条线要分清**：画框底边（CSS，已压掉）vs 素材地面（PNG 自带，只能削弱）。
4. **门禁耗时 ≈ 25 分钟**（`demo-acceptance` 172s），文档里旧的「9 分钟」是错的。

## 8.6 本轮新增/改动的命令

```bash
./scripts/start.sh                                   # 带 key 起服务（kill 8765 旧进程；日志 tmp/server.log）
node scripts/roco/measure-spritebox-seam.mjs --capture --out reports/roco/seam-fix/<tag>
node scripts/roco/measure-spritebox-seam.mjs --compare reports/roco/seam-fix/before reports/roco/seam-fix/after
node scripts/roco/browser-battle-feedback-acceptance.mjs --selftest-only   # 7 判据 + 12 反证（J7 在内）
```

## 8.7 待人类一句话的两件事

1. **愿力强化「不占行动」**：现在做「出手前自由动作」这个引擎 RC，还是先记账（页面文案保持现状）？
2. **换招基准**：认不认「**引擎 loadout = 规范四技能**」，并按它重生成 `owned-pets.json`
   （代价：owned 的 16 组判据里有一条只认 `native_skills`，链① 有 39/48 含血统/石系技能 ⇒ 那条判据的口径要一并对齐到引擎的 `is_learnable`）？

---

# 第 9 部分 · 2026-09-25 第二轮口径与在办事项（人类睡前下达）

## 9.1 口径（原话要点，逐条对应行动）

| # | 人类口径 | 落地动作 |
|---|---|---|
| 1 | 「立绘素材自己画的地面那条横线**不用管了，不重要**」 | 该遗留项**关闭**（`reports/roco/seam-fix/REPORT.md` §6 保留记录，但不再是待办） |
| 2 | 「**配招这个你得修好**」「对齐洛手的真实技能，我不清楚那个是真的对的，**你最好还是再核验一下**」 | 子代理：先独立复核四条链并给证据分级（**有没有一份能证明是游戏真实配招**要如实回答），再把 `owned.ordered_skills` 修到与引擎 loadout 逐位一致 + 修 `roster-48` 的 2/48 漂移 + 判据与反证 |
| 3 | 「**愿力强化不占行动**……**背包物品都不占行动**」「不占行动，自由动作，然后再返回背包使用一次能解除这个变招状态，**不恢复消耗次数**，进入 3 回合冷却」「愿力冲击就是个技能，**这个算行动**」 | 子代理：引擎「出手前自由动作」通道 + 配置声明（未声明 fail closed）+ 页面文案改「不占行动」+ 四条语义各一条判据 + 两条必红反证 |
| 4 | 「规划是 **deepseek api + qwen3.5-4B + qwen3.8-27B**（27B 还没训，我想自己实操）——帮我规划怎么分配；**响应速度要快**，配队评估尽量 **3s 左右**」 | `docs/roadmap/MODEL-ROUTING-PLAN.md`（在写）＋ 主线程实测（见 9.2） |
| 5 | 「**无预算限制，但也不要浪费**」「所有 agent、coach、llm 的都是重中之重……**不能偷工减料**」 | 云臂离线录制回放门禁（在办）＋ 真模型轨迹臂（排队，等 runtime.js 空出） |
| 6 | 「**尽可能不做任何类型的硬等待**，尽可能在等待的同时做别的事情」 | 全部后台活改成「后台跑 + 日志落文件 + 非阻塞读」；**`sleep` 轮询也算硬等待** |
| 7 | 「agent 主线优先，但**养成关系到 coach 的效果和 coach 需要解决的核心功能问题**」 | `docs/roadmap/CULTIVATION-PAGE-PLAN.md`（已落）：三级导航 + 换招（B5）+ 养成四项如实呈现 + coach 接线 |

## 9.2 主线程实测：配队评估现在多快（3s 口径的基线）

真服务（`127.0.0.1:8765`，当前树，带 key），`GET /api/roco/workshop?selected=own-0001..own-0006`，
各 5 次，产物 `reports/roco/team-serving/latency-live-2026-09-25.json`：

| stage | min | 中位 | max |
|---|---|---|---|
| `first`（初判） | 10.49 ms | **10.99 ms** | 12.08 ms |
| `full`（完整解释） | 10.52 ms | **12.18 ms** | 12.95 ms |

⇒ **规则段（召回/Beam/诊断/候选/五轴 + 50 条候选、294 KB 回执）约 11–13 ms**，
远超「3s」要求；**3 秒预算实际上是留给 LLM 解释段的**（RC-306 的 `budgets = {first_answer_ms:300, full_answer_ms:3000}`
在 `reports/roco/team-serving/serving.json` 里就是这么定的）。设计 LLM 段时按
「规则段先出结论（≤300ms）→ LLM 解释增量替换（≤3s，超时保短结论）」写。

## 9.3 现在的服务与演示

- **`http://127.0.0.1:8765/` 起的是当前树**（带 key，`configured/verified=true`）。
  之前那个跑了几天的旧进程（早于 2026-09-22 的另一棵树）已经换掉 —— **人类说「我没看到」时先查这个**。
- 起服务两条路：`./scripts/start.sh`（从钥匙串读 key）或
  `DEEPSEEK_API_KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)" node src/server/index.js`。
- **健康检查**：`GET /api/bootstrap` 必须有 `server` 块（没有就是旧树）；`GET /api/roco/status` 必须 200。

## 9.4 排队中（等文件空出来就派）

1. **A4 · agent 循环加一次纠错**（`src/coach/runtime.js` 的 `gatherAgentEvidence`：现在**一次非法工具参数就终止**；
   改成允许一次带错误回执的重规划，步数上限照旧硬；判据 + 必红反证）。
2. **A6 · 真 DeepSeek 轨迹臂**（`scripts/roco/agent-trajectories.mjs` 的 ARMS 加 `deepseek` 臂，
   拿真 key 跑出真实数字；注意 `reports/roco/shadow-replay-*.json` 命名空间不能写 DeepSeek 报告，
   否则 `model-arm-identity` 守卫会红）。
3. **换招接线**（`src/server/roco-service.js` 传 `loadouts`）—— 依赖第 2 条口径的核验结论。
4. **培养页骨架 + 三级导航**（`src/client/index.html`/`app.js` 是**单写者**的活，要单开一轮）。
5. **门禁**：上面每批落地后都要在**冻结树**上重跑 `node scripts/roco/verify-release.mjs`（约 25 分钟）。

## 9.5 人类睡前追加（2026-09-25 更晚，**9 点前不因需他处理的问题中断**）

1. 「最近 **agenticjev 和 jev** 很火，看看是否有用，我不太熟，提供个思路」「**千万不要因为我的消息就中断现有工作**」
   ⇒ 已派只读调研：`docs/roadmap/AGENTIC-TECH-IDEAS.md`（候选至少 6 条 + 推荐 ≤3 条 + 劝退清单 + 架构级思路）。
2. 「**4b 那个模型之前据称已经训练好了，你可以测试一下**，我不清楚，我没自己测试过」
   ⇒ 已派实测：产物 `reports/roco/local-4b-test-2026-09-25/**` + `docs/roco/LOCAL-4B-TEST.md`（权重在不在 / 怎么跑 / 真延迟与合法率 / 与规则 baseline 和 DeepSeek 的可比性）。
3. **产品/架构口径（重要，后续所有 agent 工作按这个来）**：
   「我希望模拟的是**600 只精灵、数据量很大、机制很复杂**的情况；**尽可能不要只依赖脚本计算和预制数据，更多依赖模型和 agent 本身**，
   当然可以结合（RAG 等），但**重心在 agent 上，不在游戏系统**。」
   ⇒ 解读与边界（写进 `AGENTIC-TECH-IDEAS.md` 第 4 节，实现前不再改口径）：
   **规则引擎仍然算事实与胜负**（红线不变、不许编胜率），但**决策/检索/组合/弃答的主动权交给 agent**：
   预制数据降级为「**证据源**」而不是「答案源」；agent 自己决定查什么、组合多个工具、对不确定弃答；
   600 只规模下不靠人工预编配招，而靠 agent + RAG 在**受约束的工具面**上工作。
4. **需要人类 9 点后一句话的两件**（已记档，不阻塞）：
   ① 云臂「工具选择」口径选（甲）实时状态必须查证 /（乙）不浪费调用 + 数字必须被证据守住（主线程倾向乙）；
   ② `roster-48.json` 与引擎的 2/48 漂移：改盒子页读点，还是授权动冻结层。

---

# 第 10 部分 · 2026-09-25 睡前追加口径（人类，未做，别丢）

1. **「agenticjev / jev 很火，看看有没有用」**：已查明 Jev = **TypeSafe AI 的「System One」模型，定位是「判断与决策」而不是聊天**
   （LangChain 有 harness 文章；36kr / digitaltoday 有报道）。**与本仓最弱的环节正好对上**：工具该不该调（真臂 33/49）、
   教练该不该开口、planner「默认是停止」的偏置。→ 已派只读调研，产物**应落** `docs/roadmap/JEV-AND-SYSTEM1-DECISIONS.md`
   （含「值得试 / 只值得借鉴 / 不值得」的明确结论 + 最小可验证实验 + 判据与反证）。
2. **「4B 那个模型据称已经训练好了，你测试一下」**：已派测量子代理（**只读、不改仓、不下载**）：先找 `ROCO_LOCAL_MODEL_4B_PATH`
   权重与运行时，能跑就跑 `scripts/roco/agent-trajectories.mjs` 的本地臂 / `local-model-ask.mjs`，
   给「能不能加载 / 延迟 / 合法率 / 与规则 baseline 的配对退化扳回 / 与真 DeepSeek 的可比性」；
   若本机没有权重就如实报「缺什么」。**已知旧结论（`docs/roco/W4-02-MODEL-CANDIDATES.md`）：4B 相对规则 baseline 退化 42、扳回 0**
   —— 新测量要与之对照，不许当成「已经好了」。
3. **产品重心（人类原话）**：「我希望模拟的是**600 只精灵、数据量很大、机制很复杂**的情况，**尽可能不要只依赖脚本计算和预制数据，
   更多依赖模型和 agent 本身**，当然可以结合，以及加上 **RAG** 等，但是**依旧重心在 agent 上不在游戏系统**。」
   ⇒ 这条与 `MODEL-ROUTING-PLAN.md` 的三档分工一致（规则算事、模型说话/判定、RAG 供证据）；落地时**新增能力优先走
   「agent + 检索 + 判定」**，而不是「再手写一批规则覆盖」。**红线不动**：伤害与胜负仍由 Python 引擎算、LLM 只解释、不造胜率。
4. **流程**：「**不要因为我的消息中断现有工作**」「**9 点前不要因为必须我处理的问题中断运行**，先记下我起来后一起处理」
   ⇒ 待人类回答的问题一律**记档不阻塞**（当前攒了两条：① 云臂工具选择口径选「必须查证」还是「不浪费调用+数字被守卫守住」；
   ② roster-48 与引擎的 2/48 漂移要不要改盒子页读点）。

**本轮结束时仍未跑的一步（下一个接手的人第一件事）**：等 `src/coach/team-gaps.js` 与 `src/client/roco.js` 两处写者停手后，
在**冻结树**上跑 `node scripts/roco/verify-release.mjs`（约 25 分钟，日志落文件、**不要**用 sleep/`job_output --wait` 硬等），
再看 `reports/roco/verification/{latest,last-green}.json` 与 `reports/roco/verification/failures/*.log`。

---

# 第 10 部分 · 人类 2026-09-25 睡前补充（**9 点前不要因为「必须人类处理」的问题中断运行**）

> 人类原话要点：①「最近 **agenticjev 和 jev** 很火，你可以看看是否有用，但我不是太熟，提供个思路」；
> ②「**千万不要因为我的消息就中断现有工作**」；③「好像 **4b 那个模型之前据称已经训练好了**，你可以测试一下，我不清楚我没自己测试过」；
> ④「我希望模拟的是 **600 只精灵数据量很大机制很复杂**的情况，**尽可能不要只依赖脚本计算和预制数据，更多依赖模型和 agent 本身**，
> 当然可以结合，**以及加上 RAG 等**，但是**依旧重心在 agent 上不在游戏系统**」；
> ⑤「我真睡了，**9 点前不要因为必须我处理的问题中断运行**，可以先记下我起来后一起处理」。

**已按此派工（不占在办主线）**：一个子代理做「4B 实测 + agentic RAG 调研 + 600 只量级 agent 优先路线」，
产物 `docs/roco/AGENTIC-RAG-AND-4B-PLAN.md`（进行中；人类对那两个词的理解不确定，报告里会显式写出它采用的解释）。

## 10.1 「起床后一起处理」清单（**9 点前不阻塞运行，已记档**）

| # | 待人类一句话 | 为什么需要人 | 现状 |
|---|---|---|---|
| 1 | **云臂工具选择口径**：选（甲）「实时状态必须查证」，还是（乙）「不浪费调用 + 数字必须被证据守住」 | 两条都自洽，但会改变 planner 提示与评测期望；不许工程侧偷偷选一边 | 已实测 33/49；两条出路与证据都写在 `reports/roco/agent-line-2026-09-25/REPORT.md` §二 |
| 2 | **roster-48 与引擎的 2/48 漂移**（`pet_000451` / `pet_000474`）怎么修 | 两侧都在 `data/roco/normalized/**`（红线）；要么改盒子页读点、要么授权改冻结层 | 已在测试里钉成已知集合；`docs/roco/OWNED-PETS.md` 有记录 |
| 3 | **换招基准确认**：认不认「引擎 loadout = 规范四技能」 | 影响培养页与换招接线 | **已按此修好 owned（48/48 逐位一致）**；人类只需确认口径 |
| 4 | **培养页里 PVE 营地内容的去处**（练习局入口 / 并入培养页 / 暂收） | 产品取舍 | 方案默认按「留在 L2 当练习局入口」，动手前会问（`CULTIVATION-PAGE-PLAN.md` §1） |
| 5 | 4B 若不可用（缺权重/缺算力）需要人类提供什么 | 只有人类知道权重在哪 | 子代理实测中 |

## 10.2 为什么「少依赖预制数据、重心在 agent」这条**不会**踩红线

- **伤害与胜负永远由 Python 规则引擎算**，LLM 只解释 —— 这条不因为「少用脚本」而改变；
- 「少依赖预制数据」在本仓的可行形态是：**让 agent 决定查什么/查几次（工具化检索 + RAG）**、
  用 622 只的按需推算（`on-demand-builds.json`）替代「只覆盖 48 只的预制配招」、
  以及把「支持度未知」显式**弃答**而不是近似；
- 具体路线由子代理给（要求：每条带判据与必红反证），落地前仍走「先测量再改 + 贴实测数字」。
