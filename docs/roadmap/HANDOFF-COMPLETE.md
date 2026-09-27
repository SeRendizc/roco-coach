# 「小芽」v3 完整交接（2026-09-25 会话末 · 写给下一个接手 agent）

> 🚩 **必读第一份：`docs/roadmap/HUMAN-RULINGS-2026-09-25.md`**
> —— 人类 2026-09-25 的**全部裁决**（格式化条目 + **原话逐字留档**）、**c21 重点**（预制规则知识库进 RAG）、
> **Agent 技术工作清单**（带 ★ 的是人类点名必做）、以及**下一个对话按顺序的"必须做"六条**。
> 那份文档里标「必做」的，不许跳过；标「待人类确认」的，不许自己拍板。

> 读这一份就够。读完你应该能：知道**主任务是什么**、**现在做到哪**、**下一步做什么**、
> **这个仓库与 DSH 的坑在哪**。所有数字都是实测，出处都写了路径。

---

## 0. 三十秒速览

- **是什么**：《洛克王国：世界》的嵌入式 AI 教练「小芽」。本项目 = Node/ESM 服务 + 原生 JS 前端 demo +
  **Python 规则引擎**（`roco/src/roco_env/`）+ 大量**判据/验收脚本**。
- **主任务**：600 只规模、**agent-first** 的教练闭环 —— 靠**检索、工具调用、判定回路、自我纠错**，
  **不靠脚本预计算与预制数据**冒充能力；配额优先花在**玩家看得见的 agent 能力**。
- **当前状态**：门禁 **pass / failed: []**（25 套）。单测 71 个文件、引擎 **510** 全过（`npm run test:env`）。
- **⚠️ 2026-09-25 接手轮的进展（本节写于 r54 之后，最新以 `docs/roadmap/DSH-EXECUTION-STATE.md` 的 §C6.149–C6.151 为准）**：
  - **T8 完成**：金标送审闸门（`scripts/roco/gold-review.mjs` + `data/roco/gold/review-state.json`（**54 条全 draft**）+
    `tests/roco-gold-review-gate.test.js` + `guard-selftest` 3 条必红注入）。**未审阅的金标一律不得当能力结论**：
    报告里 `capabilityConclusive=false`，带 `--require-approved` 跑会**退出码 3**。
  - **T4 完成**：人类实机口径落地 —— 双方**各编入 6 只**（`fill_required: true`）、**每方 4 点魔力**（4 颗心）、**自己配队**；
    台账 23 → **27 条**（新增 `EV-PVP-STANDARD-FILL-SIX` / `EV-PVP-STANDARD-SELF-BUILT-TEAM` /
    `EV-NATURE-BALANCE-PVP`（OFFICIAL_CURRENT）/ `EV-TURN-LIMIT-EXISTS-PVP`，`EV-PVP-STANDARD-MANA` 升 RECORDED_IN_GAME）；
    **三处改钉**（`tests/roco-v3-redirect.test.js` / `scripts/roco/build-rule-configs.mjs` / `roco/tests/test_mana_actions.py`），
    反证比原来**更强**（值不算证据：`true` 必须由一条带 `recorded_gameplay` 的 RECORDED_IN_GAME 条目撑着）。
  - **只读调研汇总**见 `docs/roadmap/RECON-DIGEST-2026-09-25.md`（7 个子代理；含**推翻**上一轮 B站/百科/贴吧"取不到"的实测更正）。
  - **T9 进行中**：`scripts/roco/verify-rules-corpus.mjs`（语料本身对不对：双源/出处可解/版本/删条反证/来源日期与适用模式）。
  - **T1/T3/T2 进行中**（RAG 分库 + 玩家数据分离 + 接进 `search_rules`，开关 `ROCO_RAG_MODE` 默认 shadow）。
- **两种最该先知道的口径**：① **伤害/胜负永远由 Python 引擎算，LLM 只解释**；
  ② **不许造胜率/概率/百分数**；③ 判据不许为"变绿"放松（口径变了要**改钉**，不是删断言）。
- **等你（人类）拍板的三件**：① **天气**——官方一手（闪耀大赛语境）说 PVP 有天气效果，与你此前「仅 PvE ⇒ 可删」冲突（两侧原话都在
  `docs/roadmap/AGENT-TECH-INSTALL-TABLE.md` §1.3(c-2)）；② 属性相性**双属性叠加**是"相加=3×"（快照）还是"相乘=4×"（两个社区源），差异 **41 格**；
  ③ 金标按「包里有没有」更新 + `state-in-packet` 的适用范围。

---

## 1. 环境与"哪些东西在跑"

| 东西 | 说明 |
|---|---|
| 工作区 | `/Users/serendizc/Developer/roco-coach` |
| **8765 = 人类在看的演示实例** | 静态文件**按请求读盘**（改了源码刷新即生效）；**服务端路由表只有重启才更新**。别乱动；要重启就用托管后台 job（我上次的做法：`lsof -ti:8765` 杀旧 → 用钥匙串里的 key 起新进程） |
| 8766 = 本地 4B 网关 | `node scripts/model/local-gateway.mjs`，`/v1/models` 可探活 |
| 探针服务 | **一律用 8930–8999 的空闲端口**，按 PID 关（`lsof -nP -iTCP:89xx -sTCP:LISTEN`）。**不要** `pkill`/`pgrep` 大范围杀 |
| 沙箱 | `ps` 被禁（用 `lsof`）；文件策略 workspace-write；网络可用 |

---

## 2. 主任务与红线（**不可协商**）

1. 伤害、胜负、概率**只能来自 Python 规则引擎**；LLM 只解释。
2. **不造胜率/概率/百分数**；拿不到数据就 **fail closed**（写「引擎没给」/不画），不许补默认值。
3. `data/roco/normalized/**`、`roco/rulesets/legacy-sim-v1.json`、`mobile-s4-candidate-v2.json`
   **非必要不动**（已知：前两个的 `derived_from_ledger_sha256` 会随台账追加被**机械重算** 1 行，
   那是 `build-rule-configs.mjs:1001` 强制的，**回滚反而会判红**）。
4. **不为让门禁变绿放松判据**；口径变了 → **改钉**（加更强的断言），**不删**。
5. 只要**桌面 demo**。
6. 流程：**禁一切硬等待**；主线程手里必须一直有活；**先测量再改并贴实测数字**。

---

## 3. 三个交付与当前实测

| 交付 | 现状 |
|---|---|
| 1) **判定回路** | (甲)/(乙) 之争已量化：49 例上 (甲) 27/49、(乙) 28/49。**欠调用 16 条已逐条归类**（`scripts/roco/analyze-missed-calls.mjs`）：**金标过期 13 / 真缺口 0 / 模型自己没调 2 / 记账缺 1**。改后指标：工具选择 **.469**、不该查却查 **.045（未涨）**、答复有据 **.918** |
| 2) **agent 真的会用工具** | 全图鉴 622：云端 agent 臂 **120/120**、生产提示契约 B **40/40**；288 条集 `rules_lookup` **46/72**、`roster_constraint` **12/24**；本地 4B 全图鉴 **0/622**（缺口在训练数据，不在提示 —— 已实测证伪） |
| 3) **玩家看得见** | 等待态「小芽在查证…」、答复后**一行依据**（「查了属性表 · 你选的六只 · 你的名单」）、被守卫拦下时如实说「模型那句话没过核对，已换成引擎结论」；`roco:coach-agent-acceptance` 8/8、`roco:battle-coach-acceptance` 14/14 |

---

## 4. 这个会话做完的玩家能力（都在真机测过；判据都登记进 `test:unit`）

1. **六只阵容评估 + 换人对比**（第 39 轮）
   - 口径改成**按登记表里各模式声明的规模收队伍**：`roco/src/roco_env/team.py` 的
     `declared_team_sizes()` = **[2,3,6]**（`pvp-standard-six-pet=6`、`pvp-territory-trial-2v2=2`、
     营地是 null 不算规模）；`service.team_evaluate` 入口同步。**特征函数本来就按队伍长度聚合**。
   - 真机：「我这六只怎么样？」→ 1 次 `evaluate_team`（6 个 id）；「第三只换成圆号鱼好不好？」→ 1 次 `compare_team_change`。
   - 路上修掉三个真拦路虎：① JS 侧 `validToolArgs` 写死 3 只；② 回执里同一份结果被塞**两遍**
     （`result` + `evaluation`）⇒ 六只时 >10 KB 被 `runtime.js:895` 的 `receipt-budget` 拦下
     （现象：看起来"0 次调用"）—— **留 `result`、去掉没有读者的 `evaluation`**；
     ③ 对比回执自带**两整份**特征（实测 3 只 7165、6 只 11019 字节）⇒ 加纯函数
     `projectCompareResult()`（留结论与特征**值**、丢 evidence/detail 并记账）。
   - 判据：`roco/tests/test_team_six_pet.py` **5/5**（含**3 只结果逐位不变**的回归钉、非胜率红线、
     其它规模被拒且**列出支持哪些**）；`tests/roco-swap-compare.test.js` **7/7**（含投影的"不投影就超预算"反证）。
2. **小芽（陪练）也会推荐**（第 37 轮）：`askingPick` 从 `runtime.js` 一路传进 `replyConstraints`；
   **放开"队伍推荐"、守住"战斗动作指挥"**（`src/coach/companion.js` 的 `forbid`）。
3. **换招不再静默丢**（第 38 轮）：名单 48 只/**47 个唯一名字**（「棋契陛下」两只）⇒ 原来按名字解析会丢配招。
   改成工坊 emit `teamSpecies`（按**持有实例**解析）+ 纯函数 `battleLoadouts()`（在 `src/coach/roco-experience.js`）。
4. **自然说法覆盖**（第 40/44/47/53/54/55 轮）：营地 24 句 + 对局 10 句 + 培养 7 句 + 相性表 3 句已钉进
   `tests/roco-ask-coverage.test.js`（**7 条判据**，含反证）。修掉「我这**套**阵容」「把第三只换成…**会怎样**」
   「火花威力**多大**」「水系克什么」等缺口；修掉**规则卡路径吞掉"比较/计算"类问句**（c05 由"被一张卡答掉"
   → 1 次 `simulate_branch`）。
5. **负面结果也留着**：培养族 7 句、对局族 8 句的"不查"经查**是有据的**（包里的依据数组带着
   **引擎算好的结论**，例：`src/coach/strategist.js:39` 的「多数情况下是 20.9 分…（**分数只用来排序，不是胜率**）」），
   所以**不要**把它们强行改成"必须查"（会把 `unnecessaryToolCallRate` 抬上去）。

---

## 5. 下一轮直接可做（按价值，都已定位到"改哪一行"）

0. **C6.144 五条"说法缺口"已全部做完**（第 53–61 轮，均已真机验证 + 判据 + 门禁 r57b 全绿）：
   技能字段变体（威力**多大**）、相性表（**水系克什么**）、学习表变体（**有什么技能**）、
   反向形状（**是哪个系**，含宠物/技能分流）、概念对比（**有什么区别** ⇒ 先测出引擎术语表 54 条里
   没有「特攻/物攻」，改走**知识卡检索** `search_rules`）。判据在 `tests/roco-ask-coverage.test.js`
   （⑧⑨⑩ 及 ①②③④⑤⑥⑦，共 **41/41**，每条都带"不许抢邻近问句"的反证）。
   **不要再重做这一族**；下面第 1 条是它的历史留痕。
1. ~~**`TERM_PATTERNS` 那半条**~~（历史）：`termAsk` 的粗筛已补 `有什么区别`，
   但**第二关 `TERM_PATTERNS` 不认「A和B有什么区别」的形状** ⇒ 仍走"不查"。
   先确认 `特攻`/`物攻` 在术语表里：有 → 加形状；没有 → **如实说"引擎没有这条术语"**。
2. **学习表变体**：「喵喵**有什么技能**？」。要加常量
   `LEARNSET_VARIANT_ASK=/(?:有什么|会什么|有哪些|都有什么|都有哪些)(?:的)?(?:技能|招式|招)/`
   并接进 `learnsetAsk` **函数体**的返回行。
   ⚠ **锚点坑**：`LEARNSET_ASK.test(t)` 在 `learnsetTarget` 里也出现；用"函数体上下文"定位时
   正则窗口要放到 **600 字符**（我两次用宽锚点都没中）。
3. **反向形状**：「叶绿光束**是哪个系**的？」（字段在「是」**后面**，与现有 `SKILL_FIELD_ASK` 方向相反）
   ⇒ 单独一条 `NAME_IS_ELEMENT_ASK`，然后走 `query_rules{kind:'skill'|'pet',name}`。
4. **跨工具多步**（c25/c27：金标要 2 次、模型只调 1 次）：第 35 轮试过"全局加强制"**实测更差**，
   所以只能**针对"一句话问两件事"**（含「另外/并且/再/还要/结合」）试，并且**必须回归 49 例**
   确认没把 `.045` 的不该查率抬上去。
5. **两件等人类点头**：金标按「包里有没有」更新（逐字段清单已产出：
   `reports/roco/packet-vs-gold-2026-09-25/packet-inventory-49-fields.json`）；
   按同一份清单修正 `state-in-packet` 的适用范围。

---

## 6. DSH（你自己）运行注意点 —— **这一节最重要**

### 6.1 时间与等待
- **禁一切硬等待**：不要 `sleep N` 当"等结果"用；**不要死盯门禁**。
- 正确姿势：耗时的活（门禁 25 套 ~10 分钟、云臂评测、本地模型重录）**丢后台 job**，
  然后**立刻去做别的**（审代码、写判据、改文档、给子代理派活）。
- 只有**下一步真的依赖它**时才用 `job_output(wait:true)` 收；收不到就继续干别的，下轮再收。
- 后台 job 的输出常被 `| tail` 缓冲 ⇒ **看不到进度是正常的**；产物文件 mtime 才是可靠进度指针。

### 6.2 并发与"编辑窗口污染"（我踩过两次）
- **门禁/验收跑动期间，一个字都不要改树**。我在 r44 边跑边改 `runtime.js` ⇒ 判据无效。
- **规矩**：只在**最后一次编辑之后**启动门禁；跑完再改。
- **一个文件只能有一个写者**。要动手前先 `ls -lt` 看 mtime、看子代理是否还在跑。
- **子代理也会写树**：它们写完要 `git status` + 单跑它们的判据验一遍；它们报的"我这边绿了"要自己复跑。

### 6.3 派活给子代理（人类明确要求）
- 用 `subagent`（自足 prompt）或 `subagent_fork`（继承本会话上下文）。**默认后台**，主线程继续干活。
- Prompt 必须**自足**：子代理看不到本会话 —— 写清仓库路径、目标、**硬约束**（只读/不写文件、
  不许碰 8765、自己起的 Chrome/服务用完即关、探针端口用 8930+、不许大范围 pkill）、
  要它回报什么（文件:行号 + 原始数字 + 没验证的部分）。
- **对抗性复核**很值：派一个只读子代理去挑刺（假判据、判据点≠玩家像素、红线违反、死代码），
  它会给你"文件:行号"级的证据；这一会话靠它挖出过真缺陷（重名配招被静默丢）。
- 子代理的结论**必须自己复跑**再采信（我遇到过一次它 3 次都红、其实是并发环境下的偶发）。

### 6.4 端口与服务
- 探针**一律用 8930–8999 空闲端口**；起之前先查端口是否被占，结束按 PID 关。
- **8765 是人类的演示实例**：多用只读请求（`curl`），要重启就走托管 job。
- 收尾时 `lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /:(89[3-9][0-9])$/'` 确认没留残留。

### 6.5 编辑与锚点（本仓特有）
- 这批 JS 是**单空格缩进**；用 python 脚本批量改时，**锚点尽量不含前导空白**（用唯一子串），
  且**先 assert 命中数再写盘**（我靠这条避免了两次半成品写入）。
- 有些文件的 **CSS 写在 JS 模板字符串里**（如 `src/client/team-workshop.js`）：
  注释里出现**反引号**会把模板截断 ⇒ 改完必跑 `node --check`。
- 判据若断言**产物/文档里的数字**（例：`docs/roco/AGENT-TRAJECTORIES.md` 的「N 条 / M 个世界 / K 个 arm」），
  产物一变就要同步文档 —— 那类判据是故意的。

### 6.6 门禁机制（25 套，`npm run verify:release`）
- `last-green.json` **只在全绿时写**；`latest.json` 可能是红的。
- `retained-assets` 读的是**若干固定产物各自的 verdict**（不是上一次的 `latest.json`），
  所以某套红了会连带它红一次，修好后自愈。
- **录制件**（`tests/evals/agent-trajectories-v1.jsonl`、`…-model-v1.jsonl`）：
  **回执形状一变，指纹就过期**，必须重录。规则臂用**那 7 个 arm**（`--arms replay,baseline,stubborn,stop_now,no_rules,drop_args,blind`），
  **默认 arm 集会多带 `local_4b`**（模型臂单独录到 `-model-v1.jsonl`，用
  `ROCO_TRAJ_WORLDS=9 --arms local_4b`）⇒ 带错了产物条数会变、文档判据会红。
- `tests/evals/structure-contract.test.js` 有**孤儿守卫**：每个 `*.test.js` 必须被 `package.json`
  或 `guard-selftest` 引用 ⇒ 新判据文件**必须登记**。
- 浏览器套件曾因"只设 `exitCode` 不退"卡死门禁（已统一 `flushThenExit`），
  也曾因 `rmSync(profile)` 的 `ENOTEMPTY` 把绿判据判红（已统一加 `maxRetries/retryDelay`，
  并有结构契约钉住）。**遇到"某套红但日志里判据全过" → 先看日志尾部**（teardown/退出路径），别先怀疑产品。

### 6.7 诚实纪律（这个项目吃这一套）
- **负面结果也要写进台账**（"没找到缺口""这条规则实测更差、已撤回"）。
- **口径变了就改钉**，不要删断言；**不要为了让门禁变绿而放松判据**（人类明确禁止）。
- **怀疑"编数"之前，先把依据数组整条读完** —— 我第 43 轮差点把 `strategist.js:39` 的引擎分数
  记成幻觉，后来发现是逐字引用（已在台账里更正留痕）。
- 报告里**贴原始数字与出处路径**，不说"看起来没问题"。

---

## 7. 文件地图（按"你会用到"排序）

| 关注点 | 文件 |
|---|---|
| 政策/路由/参数（最常改） | `src/coach/runtime.js`（`policyFor` / `defaultArgsFor` / `absentArgsFor`，各 `*_ASK` 正则都在这里） |
| 工具合同 + 参数校验 + 回执 | `src/coach/toolbox.js`（`TOOL_CONTRACTS`、`validToolArgs`、`LINEUP_SIZES`、`rocoReceipt`、`projectCompareResult`） |
| 陪练约束 | `src/coach/companion.js`（`replyConstraints` 的 `forbid`/`allow`/instruction） |
| 复盘/阵容纯函数 | `src/coach/roco-experience.js`（`battleLoadouts`、`rocoMatchDepth`、`rocoMatchReview`） |
| 页面 | `src/client/roco.js`（大）、`team-workshop.js`（Shadow DOM）、`roco.html`、`battle-v3.css`、`nurture.*` |
| 引擎 | `roco/src/roco_env/{team.py,service.py,rule_config.py,env.py,data.py}` |
| 路由/检索判据 | `tests/roco-ask-coverage.test.js`、`roco-lineup-pick`、`roco-swap-compare`、`roco-team-advice`、`roco-codex-lookup`、`roco-learnset-lookup`、`roco-term-lookup`、`roco-loadout-ui`、`roco-battle-panel-static` |
| 测量/运维脚本 | `scripts/roco/{verify-release.mjs,analyze-missed-calls.mjs,refresh-receipts.mjs,build-agent-trajectories.mjs,verify-agent-trajectories.mjs,revalidate-retained-assets.mjs}`、`scripts/eval-live-s04.js`（`--dump-packet` 不调模型） |
| 台账/报告 | `docs/roadmap/DSH-EXECUTION-STATE.md`（C6.132–C6.144 是这一会话的）、`reports/roco/progress-2026-09-25/REPORT.md`、`docs/roadmap/HANDOFF-PROMPT.md` |

---

## 8. 人类口径原话（照着做）

- 「**可以给推荐的下一个精灵呀**，我不太清楚你这里纠结的是什么。记住还是以我们的主线以及 **agent、llm 为主**哈」
- 「尽可能不要随便 timeout 或等待，很浪费时间的，你可以做别的事情呀：**分配工作给子代理**，
  你自己手里工作也不断，哪儿有那么多休息、等待时间？？」
- 「一直在底层、agent 没做多少、token 烧了好多」⇒ **配额花在玩家看得见的 agent 能力上**，低层支线只收口。
- 「**不用加训**，用检索+工具补」（交付 2）。
- 红线四条见第 2 节。

---

## 9. 已知未验证/未完成（**别当成已完成**）

1. `scripts/roco/refresh-receipts.mjs`（按已录参数重放、只刷新回执指纹）**从未完整跑过一次**；
   它**原地回写**，用前先 `cp` 备份。
2. C6.144 的 4 条里：术语形状（半条）、学习表变体、反向形状**都还没做**（形状与锚点坑见第 5 节）。
3. 引擎也收 **2 只**（双打模式），但教练路由目前只走 **3/6**（`LINEUP_SIZES`）。
4. `gaps` 特征**三只时也不带 evidence**（既有，不是这几轮引入的；已有判据把现状钉住）。
5. `evaluate_team` 的对手侧模型路径（`opponent_team`）**仍然是 3 只专属**（它喂一个 6 维特征模型），
   六只阵容下不要传对手队。
