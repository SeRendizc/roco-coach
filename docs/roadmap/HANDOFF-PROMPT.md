# 交接提示（HANDOFF-PROMPT）

> ⚠️ **先读 `docs/roadmap/HANDOFF-COMPLETE.md`（2026-09-25 会话末写，自足、完整）**。
# 交接 prompt（直接复制给新会话 / 新 agent）

> 用法：把下面 fenced block 里的全文复制粘贴给新会话的第一条消息即可。
> **每次交接都要更新到当时的实测数字**（上一版停在 24 套门禁 / C6.81，已过期；本版对到 C6.127）。
> 详细背景见 `docs/roadmap/HANDOFF-NEXT-SESSION.md`（2026-09-24 的，当背景读；**冲突时以台账末尾为准**）。

```text
你在 /Users/serendizc/Developer/roco-coach 接手《洛克王国：世界》嵌入式 AI 教练「小芽」的 v3 旗舰目标。

【先读三份，再动手】
1) docs/roadmap/DSH-EXECUTION-STATE.md 的**文件末尾**（C6.10x–C6.12x 是本阶段逐轮记录：每轮实测数字、撤回的尝试、踩过的坑）——**唯一权威**
2) reports/roco/progress-2026-09-25/REPORT.md（人类要过的进度汇报：三个交付现状 + 还没做到的清单）
3) docs/roadmap/HANDOFF-NEXT-SESSION.md（背景/红线/常用命令；日期较早）

【当前状态（2026-09-25 晚，实测）】
· 门禁 **25 套**：`npm run verify:release`（约 10–20 分钟，必须在**冻结且安静**的树上跑）。
  最近一次全绿见 reports/roco/verification/last-green.json（head 与套件清单在里面）。单测 **1217**、引擎 `test:env` **505**。
· 交付 1 判定回路：**已完成并收敛** —— 49 例上 (乙) 28/49 vs (甲) 27/49（甲对乙错 8、乙对甲错 9）⇒「默认是停止」的争议变成一个数；
  真短板是 `cat3-cross-tool`（跨工具）。工具选择 .388 → **.449**，不该查却查了 **.045 不变**。
· 交付 2 agent 真的会用工具：全图鉴 622 · 云端 agent 臂 **120/120**（改前 0/120）；**生产提示**契约 B **40/40**（改前 0/40）；
  288 条集 `rules_lookup` **12 → 46/72**、`roster_constraint` **3 → 12/24**。本阶段补齐：术语按名字查、学习表按名字查、
  两只对比（各查一次）、六维进包、换人对比政策。本地 4B 仍 **0/622**（缺口在训练数据；提示与编排两条路都被实测证伪，不要再试）。
· 交付 3 玩家看得见：等待态「小芽在查证…」+ 答复后一行**依据**（查了图鉴/术语表/比了换人前后 · 本回合的规划（引擎算的））；
  被守卫拦下时如实说「已换成引擎结论」。验收：`roco:coach-agent-acceptance` **8/8**、`roco:battle-coach-acceptance` **14/14**。
· 已落地不要重做（压缩）：五决策、配招显示链（owned=引擎 loadout 48/48 逐位 + C08）、愿力强化=自由动作（`/battle/free` + J9）、
  服务端事实守卫、27B 面板诚实性、换招玩家路径（含六槽逐只对齐 05f）、战斗页红绿标记改为**引擎倍率驱动**。

【流程纪律（人类反复强调，必须遵守）】
1. **用 goal**：开工第一件事把目标写进 objective；每轮推进；全部达成才 complete；同一阻塞条件连续 3 轮以上才 blocked。
2. **禁止任何硬等待**：后台任务/子代理起完**立刻去做别的**；禁止 sleep 轮询、禁止守着日志等、禁止反复 job_output。
   子代理完成会通知你。（人类 2026-09-25 明确批评过"等待"这件事：「哪儿有那么多休息、等待时间？」）
3. **能分就分**：能独立完成的事一律派 subagent（只读调研、写判据、跑验收、查数据、做新页面都算），
   主线程只做集成、判据、门禁与文档。**一个文件同一时间只允许一个写者** —— 派活时把"禁区文件"写清楚。
4. 先测量再改、改完贴**实测数字**；未知一律 fail closed；**不造胜率/概率/百分数**；伤害与胜负只由 Python 引擎算；
   `data/roco/normalized/**`、legacy-sim-v1.json、mobile-s4-candidate-v2.json 非必要不动；不为让门禁变绿放松判据；只要桌面 demo。

【这个阶段反复踩到的六个坑（每条都有实测代价）】
1. **期望值恒为假/恒真的判据**：`CODEX_FIELD` 原是非捕获组 ⇒ `m[2]` 恒 undefined ⇒「威力/能耗 → kind=skill」那段分支
   从来没生效过；判据里写"自己和自己比"的断言等于没写。**每条判据都要配必红反证**。
2. **判据读取点 ≠ 玩家真正看的像素**：49 例的 `groundedAnswerPassRate` 把"回退后的模板"也算有据，
   量不到"正确答案被打成模板"这类玩家可见的伤害 ⇒ 要另外在产品路径上量（见 reports/roco/rules-numbers-2026-09-25/）。
3. **模板里的设计稿静态值**：`src/client/roco.html` 里写死的 `data-b3-rel="up/down"`、`class="b3-dmg--up"`，
   而 JS 只写 data 属性、CSS 认 class ⇒ 那一格永远是设计稿的"绿色优势"（人类报的"红绿不实时"就是这个）。
   **改任何"应该实时"的显示前，先 grep 模板里有没有静态值。**
4. **只设 `process.exitCode` 不显式退出**：浏览器验收跑完不退，门禁干等 30 分钟才杀（咬了三轮）。
   收尾统一 `flushThenExit()`：先 `process.stdout.write('', cb)` 冲干净管道，再 `process.exit(code)`。
5. **提示里的约束叠多了会把答案压没**：给"阵容观察"加两条禁令后，模型两次实测都从"给观察"退化成**整段拒答** ⇒ 撤回。
   加规则要一次一条、量一次。
6. **拿旧提交当生产代码**：`git show HEAD:src/server/index.js` 是**旧版本**（少 100+ 行），照它抽提示会生成过时提示而无人报错。
   读工作区文件。

【常用命令】
· 门禁：`npm run verify:release`（全量）／`node scripts/roco/verify-state-doc.mjs`（只查台账一致性）
· 单测/引擎：`npm run test:unit` ／ `npm run test:env`
· 产品路径验收（要钥匙串里的 key，**不进离线门禁**）：
  `npm run roco:coach-agent-acceptance`、`npm run roco:battle-coach-acceptance`、`npm run roco:loadout-acceptance`
· 探针（真服务 + 真模型，逐条打印工具轨迹/依据行/回答）：
  reports/roco/six-pet-stats-2026-09-25/gap-probe.mjs（六问）、
  reports/roco/compare-pets-2026-09-25/compare-probe.mjs（两只对比）、
  reports/roco/swap-compare-2026-09-25/swap-probe.mjs（换人）
  跑法：`PORT=8970 DEEPSEEK_API_KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)" node src/server/index.js &`
        `ROCO_EVAL_ORIGIN=http://127.0.0.1:8970 node <探针>`

【还没做（按优先级，2026-09-25 晚）】
1. 六只阵容的「换人对比 / 阵容评估」：**引擎只支持 3 只**（引擎原文「训练场评估按 3 只队伍进行；完整 6 只阵容在第 5 周扩展」）
   —— 要不要做，**等人类定**。
2. 「复盘太浅」与「队伍卡片重叠」：本阶段已派子代理（`src/coach/roco-experience.js`、`src/client/team-workshop.js`）；
   落地后要**自己复核**（判据 + 真机截图 + 反证），别只看子代理自述。
3. 培养页 + 三级导航：已派子代理（新开 `src/client/nurture.*`）；落地后需要在 `roco.js` 里加入口（一处小改）。
4. 两处**等人类口径**：`pet_id`/`term_id` 写法要不要当能力修；金标与证据包冲突 4 条（c01/c02/c10/c11）。
5. 「阵容观察」偶发拒答（模型侧不稳定）：人类若要"一定有观察"，那是**产品设计题**（例如在 UI 上给一块由包里六维算的结构块），
   不要再往提示里叠禁令（见坑 5）。

【第一步（不要跳过）】
`node -e "const r=require('./reports/roco/verification/latest.json');console.log(r.verdict,r.failed)"` 看最近一次门禁，
再 `npm run test:unit` 确认本地绿；然后**先派子代理去干独立的事**，主线程同时开工。
```

---

## 2026-09-25 第 36 轮追加（接手前必读）

- **本轮做成的能力**：「下一个该带谁／推荐哪只」这类问句现在**必须先查引擎**：
  `src/coach/runtime.js` 的 `LINEUP_PICK_ASK` + `lineupPickAsk()`/`lineupPickEnabled()` 接进 `policyFor`
  （`reason:'lineup-pick-ask'` → `query_rules`），参数是 `{kind:'type_chart'}`（**不吃参数，一次拿到整张相性表**）。
  真机前后：**0 次调用**（凭模型记忆推荐）→ **1 次调用**，军师角色给出「圆号鱼（水系）最稳，喵喵也能打；
  音速犬别拿去顶火」＋提醒先确认对面具体是哪只；依据行变成「查了属性表」。
  判据 `tests/roco-lineup-pick.test.js` 5/5，其中一条**从 `scripts/eval-live-s04.js` 抽真实 49 例问句，
  逐条确认不被新政策抢走**（写新政策一定要带这条，compareAsk 当年抢走 R02 就是栽在这）。
- **陪练仍不给战术方向**（`src/coach/companion.js:2240` 的 `forbid` 含「战术指挥」）——这是**记录在案的人类口径**，
  要放开是口径决定，不是 bug。页面里：聊天=companion（`roco.js:4111`），战斗提示=strategist（`app.js:999`）。
- **门禁纪律（血的教训）**：r44 因为我在它跑动时编辑 `runtime.js` 而**判据无效**。
  **只在最后一次编辑之后启动门禁；跑动期间一个字都不改。**
- **"某套红但日志里判据全过"→ 先看日志尾部**：r45 的红是 `rmSync(profile)` 的 `ENOTEMPTY` 收尾竞态，
  已统一加 `maxRetries/retryDelay` 并有结构契约钉着。
- 未做（按人类优先级排队）：① 陪练是否也放开推荐（口径）；② 重名「棋契陛下」的换招按名字解析会被
  `roco.js:4424` 静默过滤，修法是换招时记槽位实例；③ `evaluate_team`/`compare_team_change` **只收 3 只**
  （`roco/src/roco_env/team.py:256` 硬判 `len(team)!=3`；而特征函数本身是按队伍长度聚合的，
  扩到 6 只主要是口径 + 判据，不是重写）。

---

## 2026-09-25 第 37–49 轮追加（接手前必读）

**门禁**：`r52 verdict: pass | failed: [] | 套数: 25`（22:17:50→22:27:33），`last-green.json` = 当前树。
单测 71 个文件、引擎 505 全过。

**这一段做完的玩家能力（都真机测过，不是"判据绿"就算）**：
1. **六只阵容**：`evaluate_team` / `compare_team_change` 现在按**登记表里各模式声明的规模**收队伍
   （`team.py` 的 `declared_team_sizes()` = 2/3/6，`pvp-standard-six-pet` 就是 6），不再是写死 3 只。
   真机：「我这六只怎么样？」→ 1 次 `evaluate_team`（6 个 id）；「第三只换成圆号鱼好不好？」→ 1 次对比。
   路上修掉三个真拦路虎：JS 侧 `validToolArgs` 写死 3 只、**回执被塞两遍**超 10 KB（`result` + `evaluation`）、
   对比回执自带两整份特征（11019 字节 → 加 `projectCompareResult()` 投影）。
2. **小芽（陪练）也会推荐**：`askingPick` 一路传进 `replyConstraints`，放开"队伍推荐"、**守住"战斗动作指挥"**。
3. **换招不再静默丢**：重名物种（48 只 / 47 个唯一名字）按名字解析会丢配招 ⇒ 改成按**持有实例**解析物种
   （`battleLoadouts()` + 工坊 emit 的 `teamSpecies`）。
4. **自然说法覆盖**（这是本仓最容易吃亏的一类）：营地 24 句 + 对局 10 句 + 培养 7 句逐条审计并钉进
   `tests/roco-ask-coverage.test.js`；修掉「我这**套**阵容」「把第三只换成…**会怎样**」等 6 处漏接；
   并修掉**规则卡路径吞掉"比较/计算"类问句**（c05：0 次调用被卡答掉 → 1 次 `simulate_branch`）。
5. **指标拆解**：`scripts/roco/analyze-missed-calls.mjs` 把 49 例欠调用 16 条分成
   「金标过期 13 / 真缺口 0 / 模型自己没调 2 / 记账缺 1」；改后工具选择 **.469**、
   不该查却查 **.045（未涨）**、答复有据 **.918**。

**下一轮直接可做的三件（按价值排序）**：
1. **金标按「包里有没有」更新**（`reports/roco/packet-vs-gold-2026-09-25/packet-inventory-49-fields.json`
   是逐字段清单）—— 这件要人类点头，因为它定义 `missedCallRate` 的含义；
2. 按同一份清单修正 `state-in-packet` 的适用范围（该查的必须查、包里有的不许白查）；
3. **`scripts/roco/refresh-receipts.mjs` 尚未完整跑过一次**（第 45 轮写的：按**已录参数**重放、
   只刷新回执指纹、不改模型决策；那次录制件最后由**标准构建**写好，所以它没派上用场就被停了）。
   要用它之前先小样本验证（`--trajectories <文件>` 会**原地回写**，先 `cp` 备份）。
4. **跨工具多步**（c25/c27：金标要 2 次、模型只调 1 次）—— 第 35 轮试过"全局加强制"实测更差，
   所以只能**针对"一句话问两件事"**（含「另外/并且/再/还要/结合」）单独试，并且必须测 49 例确认没把
   `.045` 的不该查率抬上去。

**踩过的坑（别重复）**：① 改**回执形状**要同时重录两份录制件（规则臂 7 个 arm + 模型臂 `local_4b` 单独那份），
   否则 `trajectories` / `trajectories-model` 会红；② 录制件的 arm 集不许默认带上 `local_4b`；
   ③ 怀疑"编数"之前**先读完依据数组**（第 43 轮我差点把 `strategist.js:39` 的引擎分数记成幻觉）；
   ④ 这个仓库的 CSS 有些写在 **JS 模板字符串**里，注释里出现反引号会截断模板（`node --check` 必跑）。
