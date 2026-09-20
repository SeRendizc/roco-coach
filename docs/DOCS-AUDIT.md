# 文档声明与仓库实况全量核对（DOCS AUDIT）

核对时间：2026-09-17 晚间。核对对象：`docs/` 下全部 `.md`（24 份）+ 根目录 `README.md`，以及它们指向的产物（`reports/`、`knowledge/`、`src/game/content.js`、`checkpoints/`、`report/`、`output/pdf/`）。
核对方式：**只读**。产物是这份报告，没有修改任何其他文件，也没有改动 `docs/CHECKLIST.md` 的勾选状态。

> 写这份报告的起因：CHECKLIST 只覆盖它自己列出的项；清单之外反复出现"过时或错误的声明"。本报告把这一类全部找出来，而不是只复核已知的例子。

> **核对窗口（重要）**：核对期间**有另一个任务在并发修改同一工作区**。本报告的所有"实际"一栏，都是我在本次会话里现场跑出的；成稿前我复核了两条最关键的结论，它们**仍然成立但行号已移动**：
> - 陪练主动气泡**仍然已接线**（复核时 `src/client/app.js:347` 调 `notify(ev)`、`src/client/app.js:364` 定义 `notify`；核对时为 `:344`/`:360`），签名已扩为 `coachContext(game,profile,coachMemory)` 并改走 `queueCompanionCue`。
> - `docs/CHECKLIST.md` 的未勾项**仍是 9 项**。
> - **测试数变了两次**：核对时为 **251**（`npm test`，与 `reports/test-output.txt` 一致）；成稿前复核已涨到 **256 / 256 pass**（并发任务新增用例）。下文所有"实际 251"都指**核对时点**，请以现场重跑为准。这本身就是本报告第 10 节说的那类漂移，只不过这次漂移的是我自己的报告。
> - `docs/DOCS-AUDIT.md` 是本次唯一的新增文件；`git status` 里其它被修改的文件（`src/client/app.js`、`src/client/index.html`、`src/coach/companion.js`、`src/client/style.css` 等）**不是我改的**，来自那个并发任务。

---

## 0. 本次核对的基准（都是现场实跑/实读得到的）

| 事实 | 取值 | 我怎么得到的 |
|---|---|---|
| 自动化测试 | **tests 251 / pass 251 / fail 0**（核对时点；成稿前复核已因并发改动变为 256/256） | `npm test`（后台实跑，12.4s）；与 `reports/test-output.txt`（22:04，251/251）一致 |
| 逐文件测试数 | engine 10、rules 16、offline 5、mechanics 6、pvp 8、browser 4、features 24、coach 27、companion **13**、strategist 24、server 11、opponent 27、knowledge **11**、tests/evals/agent 37、tests/evals/regression 17、tests/evals/slow-model 6、wiring 3、tests/evals/player-copy 2 | 对 `package.json` 的 `test` 脚本里 18 个文件逐个 `node --test <file>` 取 `^ℹ tests` |
| UI / 后端 / 规则版本 | v0.11 / runtimeVersion `'0.11'` / `RULES_VERSION='0.6'` | `src/client/app.js:418,425`、`src/server/index.js:69`、`src/game/engine.js:1` |
| 宠物 / 关卡 / 难度 / 技能 / 道具 / 携带物 | 12 / 5 / 3 / 23 / 3 / 3（`none` 外 2 件可用） | `src/game/engine.js` 的 `SPECIES`/`SKILLS`/`ITEMS`/`HELD_ITEMS`/`DIFFICULTIES`；`src/game/content.js` 的 `STAGES` |
| 属性与倍率 | 7 属性，**同系 ×1**（`multiplier(a,a)===1`）；克制 1.5 / 被反克 0.75 | `src/game/engine.js:87-98` |
| 知识卡 | 90 张 = `knowledge/tactics.json` 49 + `knowledge/reference.generated.json` 41；`semantic-corpus.json` 也是 90 | `python3 -c` 读 JSON |
| 陪练主动气泡 | **已接线**：`src/client/app.js:342` 遍历 `companionEvents(...)`，`src/client/app.js:344` 调 `notify(ev)`，`notify` 定义在 `src/client/app.js:360` | `grep -rn "\bnotify\b" src/client/app.js` |
| 上下文预算 | 服务端精确计数 `window=200000, output=320, reserve=1024`；浏览器侧 `window=WORKING_CONTEXT(200000), output=OUTPUT_RESERVE(4096)`；`MODEL_CONTEXT=1000000` | `src/server/token-budget-server.js:11-16`、`src/coach/runtime.js:179-186` |
| 工具循环上限 | **最多 3 次工具调用**（`limit=3`，循环上限 4） | `src/coach/runtime.js:137,150` |
| CHECKLIST 未勾项 | **9 项**（U05、T04、R03、R09、F01b、E08、V08、W09、X06） | `grep -c '^- \[ \]' docs/CHECKLIST.md` |

---

## 1. 严重（会让人对"这个能力到底有没有"判断错误）

### F01 — 「陪练主动气泡在真实 UI 里不会弹出」：**已接线**，多份文档仍说没有调用点

| | |
|---|---|
| 位置 | `docs/COMPANION-IMPLEMENTATION.md:20`、`:170`（§8.1）、`:218`；`docs/COMPANION-DESIGN.md:32`、`:105`、`:293`、`:485`、`:542`、`:645`；`docs/DIFFICULTY-AND-SOLUTIONS.md:51`；`docs/CHECKLIST.md:78-79`（T05 第二条注释） |
| 声称 | 「`src/client/app.js` 里唯一的调用点 `notify()` **没有任何调用处**，所以气泡在真实 UI 中不会弹出」「全仓库检索 `notify` 只有这一处定义，没有任何调用处」 |
| 实际 | **已接线**。`grep -rn "\bnotify\b" --include=*.js .` → `src/client/app.js:344:  notify(ev);` 与 `src/client/app.js:360:function notify(event){...}`；调用点在 `src/client/app.js:342` 的 `if(!preview)for(const ev of companionEvents(game,{faintShown,resultAnnounced}))` 里。`tests/wiring.test.js:52` 已经把「陪练·主动气泡」列为必须接上的入口（`/companionEvents\(/`），`tests/companion.test.js:315` 是新增的第 13 条测试 `the proactive bubble fires on exactly two events, once each per match`。（成稿前复核：并发改动把调用点移到 `src/client/app.js:345/347`、定义移到 `:364`，并改走 `queueCompanionCue`；**结论不变**） |
| 判定 | **过时**（六处）。同一份 `COMPANION-DESIGN.md` 内部自相矛盾：`:283` 已经写「**主动通道已接线**——2026-09-17 补上 `src/client/app.js` 里 `notify()` 的调用点」，而 `:105`/`:293`/`:485`/`:542`/`:645` 仍写"没有调用点"。今天的提交 `c4a236d` 只改了 `:283` 与抬头，`COMPANION-IMPLEMENTATION.md` 整份没跟上 |
| 反向确认 | 已确认不是我看错文件：`tests/wiring.test.js:8` 把这条列为**历史缺陷**（"起因是……notify() 定义了但全仓库无调用点"），说明它是"曾经成立、现已修复"；`notify` 之外全仓库无第二处 `notify` 引用（除该注释）。用户举的第 1 个例子**只修了一半** |

### F02 — CHECKLIST G07 的头部证据数字**全部来自"旧相克表"那一轮**，当前产物不是这些数

| | |
|---|---|
| 位置 | `docs/CHECKLIST.md:142`（头部数字）、`:143`（同属性失衡）、`:144`（选择器等价性） |
| 声称 | 「胜 1959 / 负 3817 / 平 20 / 卡死 0 / 撤退 0；全局回合数均值 17.57、标准差 7.31、最长 80；**16 场打到 80 回合上限**（全部判平局）、另有 4 场双方同时全灭的平局，398 个 arm 里只有 4 个出现过上限平局（单臂最高 8/12）」「唯一统计显著的同属性失衡是雷系 鸣电雀 vs 伏光貂（21.7% vs 55.0%，Δ−33.3pp，置信区间不重叠）」「脚本自带选择器等价性校验：**1,416 个状态**上与线上 `chooseEnemy()` 不一致 0 次，含 **97 次**实际换宠决策」——并注明「全部可从 `reports/balance-matrix.md` 与 JSON 复算」 |
| 实际 | 当前 `reports/balance-matrix.json`（`generatedAt 13:12:52Z`）：胜 **1997** / 负 **3764** / 平 **35**，`meanRounds 17.84`、`sdRounds 8.119`、`capCount 18`，选择器等价性 **1345 状态 / 96 次换宠**，`capRate>0` 的 arm 是 **6 个**。CHECKLIST 引的那些数**逐项等于** `git show 3785cb4:reports/balance-matrix.json`（`generatedAt 11:27:10Z`，`durationMs 180635`）：胜 1959 / 负 3817 / 平 20、17.567±7.308、`capCount 16`、选择器 1416/97、`capRate>0` 的 arm 恰好 4 个且最高 8/12。`reports/balance-matrix.md:37`（§1.10）与 `:381`、`:474`、`:520` 明确把前者标为【旧JSON】/【STDOUT-旧】、后者标为【JSON】（新规则）；`:474` 原话：「旧数据里唯一"置信区间不重叠"的同属性宠物差距**消失了**：雷系鸣电雀 vs 伏光貂从 Δ−33.3pp 降到 Δ−8.3pp」，`:520` 说「伏光貂全面强于溪刃獭」的方向**与旧规则相反** |
| 判定 | **过时/错误**（三条注释整段引用了改表前那一轮）。这是"实验证据错配"：文档说"可从 JSON 复算"，但按它给的数字**复算不出来** |
| 反向确认 | 用 `git show 3785cb4:reports/balance-matrix.json` 取出被覆盖的旧 JSON，逐项比对 CHECKLIST 引用的 6 组数字，全部命中；再用当前 JSON 逐项比对，全部不符。另外独立确认当前 JSON 是"新相克表"那一轮：它的全局行与 `balance-matrix.md` §1.10 引的【JSON】完全一致（35 / 18 / 17.84±8.119） |

### F03 — 喂给模型的 RAG 地面事实卡与引擎不符（少一个属性、声称"没有天气"），而文档声称这张表已被测试守住

| | |
|---|---|
| 位置 | `knowledge/tactics.json` 的 `tactic:rules-boundary`（同步生成进 `src/game/content.js` 的 `TACTIC_CARDS` 与 `knowledge/semantic-corpus.json`）；相关声称在 `docs/EXPERIMENTS.md:7`（卡片带规则版本/来源/反例，引用按 ID 回查）、`docs/CHECKLIST.md:19-21`（P05 "数值修改不会造成提示与结算不一致"）、`docs/P05-RULES-SOURCE.md:119` |
| 声称 | 卡片正文：「当前有**火、水、草、岩、雷和普通**技能属性。克制 1.5 倍；打向克制你的属性 0.75 倍；其余含同系一律 1 倍；没有本系加成、双属性、**天气**。」；P05 声称有测试 `the tactics knowledge base states the same numbers as the engine` 把引擎字段拼成句子去 90 张卡里找，找不到就失败 |
| 实际 | 引擎 `TYPES` 有 **7** 个属性（`src/game/engine.js:28`：火/水/草/**普通**/岩/雷/**风**）——卡片漏了**风**；引擎有 `ENVIRONMENTS`（`src/game/engine.js:76`：细雨 rain、山风 gale，4 回合，水系/风系 ×1.1），规则页也在讲环境——卡片却写「没有……天气」，而同一批卡里另有一张 `tactic:weather`「细雨与山风」在讲环境，两张卡互相矛盾。`tests/rules.test.js:272` 的测试只断言一份**固定的数值短语清单**（`克制1.5倍`、`中毒每次8伤害`……），**不含属性清单、也不含"没有天气"这句**，所以这张卡**能通过测试** |
| 判定 | **错误**（模型可见的地面事实与引擎不符；且"已被测试守住"这个声明在这一条上不成立） |
| 反向确认 | 直接读三份产物（`knowledge/tactics.json`、`src/game/content.js` 的 `TACTIC_CARDS`、`knowledge/semantic-corpus.json`）都含同一段文本；读 `tests/rules.test.js:272-311` 确认断言清单里没有属性列表；`git log -S"含同系"` 显示这张卡在 `b6a5b42` 被改过一次倍率表述（只改了倍率，没补风系/环境）。这正好是 `report/sections/03-hard.tex:167` 自己承认过的失败形态（"六张由脚本生成的属性卡里仍写着同属性或被反克时 0.75"）再次出现 |

### F04 — DIFFICULTY 说「输出校验 A05 仍未勾、名称漂移没修、第三层不存在」

| | |
|---|---|
| 位置 | `docs/DIFFICULTY-AND-SOLUTIONS.md:752`、`:753`、`:738`（另见 `:802` 速查表） |
| 声称 | 「名称约束补上之后**尚未复验**……**所以「名称漂移已经修好」这个说法在当前证据下不成立**」「`docs/CHECKLIST.md:281` 明确：A05（输出校验）**仍未勾**」「**第三层（未实现）**：从规则数据源导出全部合法实体名……本文不宣称这一层存在」 |
| 实际 | `docs/CHECKLIST.md:31` 的 **A05 是 `[x]`**，注释写「本轮补上最后两块——**道具名称漂移**（`item-name-drift`）与**因果语义**（`causal-cancelled-action`）」。代码：`src/coach/runtime.js:219` 有 `item-name-drift`（拦截 解药/以太/血瓶… 等非本作道具名）、`:225` 有 `causal-cancelled-action`；测试 `tests/evals/agent.test.js:254`「item-name drift is rejected even when every number is grounded」与 `:281`「an action recorded as cancelled cannot be described as having hit」。第三轮 44 条真实调用（`reports/live-model-eval.json`）的 `badAnswers` 里**没有任何 item-name-drift** |
| 判定 | **过时**（三处）。同一文档 `:752` 依赖的 `docs/EXPERIMENTS.md:54`「已补名称约束，仍需复验」也一起过时了 |
| 反向确认 | 检查了"会不会是我把 [ ]/[x] 看错"：`grep -n "A05" docs/CHECKLIST.md` → `31:- [x] A05 输出校验…`；`grep -n "item-name-drift\|causal-cancelled-action" --include=*.js .` → 实现与两条测试都在。`docs/CHECKLIST.md:281` 现在是 N05（`:753` 引用的行号来自基线提交，见 F30） |

### F05 — 用户举的五个例子：三个已修好，一个只修了一半，一个仍在

| 用户举的例子 | 现状 | 证据 |
|---|---|---|
| `COMPANION-DESIGN.md` 说主动通道未接线 | **只修了一半**（见 F01） | `:283` 已更正；`:105/:293/:485/:542/:645` 未改 |
| 同文件开头 `tests 122 / pass 122` | **已修** | `docs/COMPANION-DESIGN.md:10`：「写作时为 `tests 122 / pass 122`。**当前是 251 项全绿**」——251 与实跑一致 |
| `COACH-PLAN.md` 九个"尚未达到目标" | **已修** | `docs/COACH-PLAN.md:17` 已逐项对照（已做/部分/仍未做），与代码一致 |
| `DIFFICULTY-AND-SOLUTIONS.md` 说小田"完全未调研" | **已修** | `docs/DIFFICULTY-AND-SOLUTIONS.md:782` 已改写为"机制层细节仍未取得"，并指向 `docs/XIAOTIAN-RESEARCH.md`（该文件确实存在，225 行） |
| `IMPLEMENTATION-STATUS.md` v0.5 段落说 6 选 4 / 携带物 / 风系与天气未实施 | **已修** | `docs/IMPLEMENTATION-STATUS.md:124` 已加「（以下为 v0.5 时期记录，其中多数已不成立）……这四项现在都已实现」 |

结论：**这一类（"没做的其实做了"）仍在复发**——今天的修复是逐条打的补丁，没有形成"改代码时同步扫文档"的机制。

---

## 2. 数字类（测试数 / 卡片数 / 场次 / 耗时 / 上限）

### F06 — 测试数：文档写 127 / 122 / 191 / 177 / 249，实际 251（成稿时 256）

> 下表"实际"一栏是**核对时点**的实跑值 251。成稿前复核已因并发任务新增 5 条用例变为 256/256；无论取哪个值，下列文档里的数字都远低于它。

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/IMPLEMENTATION-STATUS.md:6` | 「**127 项**自动测试通过」 | 251 |
| `docs/EXPERIMENTS.md:60` | 「**127 项**自动测试通过，含新增 6 项机制回归」 | 251 |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:6` | 「写作时 122 项全部通过；**当前为 127 项**（`reports/test-output.txt`）」 | 251；它点名的 `reports/test-output.txt` 自己写着 251 |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:681` | 「实跑 `npm test` → tests **122** / pass 122 / fail 0」当作"本次写作时的实测" | 251/251/0 |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:11` | 「`reports/test-output.txt` 是更早一次运行的产物（13:52，记录 **114** 项）」 | 该文件 mtime 22:04，内容是 251/251 |
| `docs/P05-RULES-SOURCE.md:151,153` | 「改动后 191 通过」+ 逐文件分布合计 191 | 同 14 个文件的实测合计 **195**；逐文件 **browser 3→4、coach 25→27、knowledge 10→11**；且该清单**漏掉**了现在也在 `npm test` 里的 strategist 24、opponent 27、wiring 3、tests/evals/player-copy 2；全套合计 251 |
| `docs/P05-RULES-SOURCE.md:162` | 复现命令的注释写「`npm test` # 全套 **189** 项」 | 251；**并且与同一文件 `:151`/`:153` 的 191 自相矛盾**——同一个文件里两个不同的总数 |
| `docs/W10-ACCEPTANCE-MAPPING.md:58` | 「本轮改动后 191」 | 251 |
| `docs/COMPANION-IMPLEMENTATION.md:5,191,192` | 「改动后 tests 177 / pass 177」「`npm test` 全量：177 项」「`npm run test:companion` 只跑陪练：12 项」 | 251；`tests/companion.test.js` 实际 **13 条**（多出 `the proactive bubble fires on exactly two events, once each per match`） |
| `docs/COMPANION-DESIGN.md:29,154,195` | 「`tests/companion.test.js`（**12** 条测试）」 | 13 条 |
| `docs/CHECKLIST.md:343`（W12，已勾） | 「完整 **114** 项回归通过，`reports/test-output.txt` 更新」 | 它点名的产物是 251 |
| `docs/CHECKLIST.md:334` | 「请求最多**两次**规划 + 一次生成」 | 工具轮次上限已是 3（`src/coach/runtime.js:137 limit=3`） |
| `report/sections/05-numbers.tex:19,65` | 「自动测试 **249** 项通过（`npm test`，18 个测试文件）」 | 251；文件数 18 正确 |
| `docs/reviews/2026-09-17-live-acceptance.md:30` | 「全套 **100** 项自动测试见 `reports/test-output.txt`」 | 现在是 251；而且**该产物从来没有 100 过**——最早入库的版本（`git show e5417e8:reports/test-output.txt`）就已经是 `tests 114` |

判定：**过时**（除最后一条是**错误**：引用了一个从未存在过的数值）。

### F07 — `reports/balance-matrix` 的耗时：同一份产物被三份文档写成三个数

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/CHECKLIST.md:141` | 「5,796 场、398 个 arm、`partial:false`、`RULES_VERSION=0.6`，**用时 181.6 秒**」 | 当前 JSON：`matchCount 5796`✓、`armCount 398`✓、`partial false`✓、`rulesVersion 0.6`✓、**`durationMs 185314`（185.3s）** |
| `docs/W10-ACCEPTANCE-MAPPING.md:21` | 「5,796 场 / 398 个 arm / **180.6 秒**」 | 180.6s = 被覆盖的旧 JSON（`git show 3785cb4:… durationMs 180635`） |
| `reports/balance-matrix.md:6` | 「耗时 181.6 s …… `durationMs` = 181586」 | 该 md 描述的是 12:48 那一轮；当前 JSON 是 13:12 那一轮（`reports/balance-matrix-stdout.txt` 亦写 185.3s） |
| `report/sections/05-numbers.tex:57`（PDF 正文源） | 「用新的相克表重跑：5{,}796 场、398 个臂、**181.6 秒**……胜负平是 **1997 / 3764 / 35**」 | 胜负平与当前 JSON **一致**（1997/3764/35 ✓），但耗时 181.6s 是 12:48 那一轮的值；当前 JSON 是 `durationMs 185314`。即：**同一句话里对了一半** |

判定：**过时**（场次/臂数仍正确，耗时三处不一致）。另：`reports/balance-matrix.md:10` 仍写「G07 **仍为未勾**」，而 `docs/CHECKLIST.md:139` 的 G07 已是 `[x]`。

### F08 — 环境维度场次 48 vs 24（引用时把总数当成了环境臂的数）

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/G06-LATE-GAME-DESIGN.md:85` | 引用 `reports/balance-matrix.md` 第 10 节第 7 条为「只有 S8 的关卡 05（山风）带环境，**48 场**」 | 原文是「两个臂、**24 场**」；`reports/balance-matrix.json` 里 S8 共 4 个 arm / 48 场，其中带环境的只有 summit 的 2 个 arm × 12 种子 = **24 场** |
| `docs/CHECKLIST.md:144` | 「环境维度几乎未覆盖（只有 S8 的关卡 05 山风 **48 场**）」 | 同上，应为 24 |

判定：**错误**（引文失真，把 S8 总场次当成了环境臂场次）。`docs/CHECKLIST.md:141` 里"S8 关卡对照（48 场）"是对的。

### F09 — 规则页字数：4316 → 4309

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/G08-RULES-IN-PLACE.md:53`、`docs/P05-RULES-SOURCE.md:88`、`docs/CHECKLIST.md:147`、`docs/W10-ACCEPTANCE-MAPPING.md:70` | 规则弹窗「11 节 / 77 段 / **4316** 字符」 | 用文档自己给的命令 `node -e "import('./src/game/rules.js')…"`：**11 节 ✓、77 行 ✓**，标题+正文合计 **4309** 字符（正文 4245）。该数字由 `reports/p05-rules-browser-check.txt`（11:21）记录，而 `src/game/rules.js:124` 的属性克制那句在 **20:50** 被 `b6a5b42` 重写过（新增"其余（含同系）一律 ×1；没有属性免疫，也没有本系加成"） |

判定：**过时**（节数/段数仍正确，字符数已变）。这一条本身无害，但它说明"实测快照"会被之后的编辑悄悄作废。

### F10 — 已确认正确的数字（抽查后仍正确，供对照）

- 知识卡 90 = 49 战术卡 + 41 引擎参考卡（`docs/EXPERIMENTS.md:7`、`docs/README.md:3`、根 `README.md:27`）✓
- `660 场等等级单宠对照`（`docs/EXPERIMENTS.md:60`、CHECKLIST W13）→ `reports/balance.json` 的 `games: 660` ✓
- 检索三组：词项 11/14 MRR 0.667、纯语义 9/14 MRR 0.536、RRF 11/14 MRR 0.750、负例 1/2、2/2、1/2（`docs/EXPERIMENTS.md:11-15`、`docs/DIFFICULTY-AND-SOLUTIONS.md:419-427`）→ `reports/retrieval-summary.txt` / `semantic-summary.txt` 逐项吻合 ✓
- 四臂 128 条查询：0.00% / 88.39% / 90.18% / 91.07%，MRR 0.8007 / 0.7996 / 0.8244，+2.68pp、p=0.4531、CI[−1.79,+7.14]、负例 56.25%（`docs/CHECKLIST.md:201-204`、`docs/INTERVIEW-DRILL.md:74`）→ `reports/retrieval-extended-summary.md` ✓
- 干预 Q-learning：0 / −1.113 / −0.770 / 1.116，提示 0 / 5.89 / 4.55 / 1.70，增量帮助 0 / 1.38 / 1.16 / 0.86，偏移下 0.581 vs −2.330（`docs/EXPERIMENTS.md:25-32`、`docs/DIFFICULTY-AND-SOLUTIONS.md:479-486`）→ `reports/intervention-summary.txt` ✓
- 轨迹规模 18000/432000/11277057 字节等 → `reports/trajectory-audit.json` ✓
- 工具路由 RL：SmolLM2-135M、1152 参数、24/8/16、未训练 8/16、三种子均 15/16、L2 0.9149–0.9744 → `reports/tool-router-summary.txt` ✓
- 五条真实调用 3134–3722ms、tokenizer 与 API `prompt_tokens` 差 2–3（2682/2684、4552/4554、5608/5611、4978/4980、4904/4906）、PVP 本地拒绝 3ms → `reports/live-model-v10.json` 逐行 ✓
- 裁剪实例 38 tokens / totalBudget 1382 → `reports/token-budget.json` ✓
- 配招空间 C(6,4)=15、技能/道具/携带物 23/3/3、宠物/关卡/难度 12/5/3、属性 7 个两环（`report/sections/05-numbers.tex:13-19`）✓
- `output/demo/` 21 张截图、`reports/c17/*.png` 26 张、`docs/DEMO-WALKTHROUGH.md` 引用的 21 个路径全部存在 ✓

---

## 3. 机制与规则描述类

### F11 — 上下文预算窗口：文档仍写 32768

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/DIFFICULTY-AND-SOLUTIONS.md:593` | 「`window=32768, output=512, system=4096, tools=2048` → 可用预算 26112 字节」 | `src/coach/runtime.js:186`：`{window=WORKING_CONTEXT, output=OUTPUT_RESERVE, system=4096, tools=2048}`，即 **200000 / 4096** |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:600` | 「`window=32768, output=320, reserve=1024`」 | `src/server/token-budget-server.js:13`：`{window=WORKING_CONTEXT, output=320, reserve=1024}`，即 **200000 / 320 / 1024** |
| `docs/EXPERIMENTS.md:50` | 「官方 DeepSeek V4 tokenizer……**窗口 32768**，输出预留 320，安全余量 1024」 | 同上，`window=200000`；output/reserve 仍对 |
| `docs/DEMO-ACCEPTANCE.md:35` | 「检查 **32K 装配用例**……预算目前是**保守 UTF-8 字节估计，不冒充 DeepSeek 精确 tokenizer**」 | 服务端走的就是官方 tokenizer 精确计数（`src/server/index.js:1,74` 的 `fitTokenBudget`；`src/server/token-budget-server.js:10`「这里用真实 tokenizer（不是字节估算）计数」）；`docs/IMPLEMENTATION-STATUS.md:4` 与 `docs/EXPERIMENTS.md:50` 也都说"官方 token 计数"。字节估计只剩浏览器侧的第一级粗裁 |
| `docs/COACH-PLAN.md:95,99` | 第 8 节标题仍是「在 **32K** 上下文下工作」，正文写「示例 **32K** 预算：指令与工具 4K……」 | 同一份文件 `:17` 已经写「32K 上下文压缩验收**已被取代**……工作预算改为 200K」——**文件自相矛盾** |

判定：**过时**（`DIFFICULTY:593/600`、`EXPERIMENTS:50`、`DEMO-ACCEPTANCE:35`、`COACH-PLAN §8`）。`docs/IMPLEMENTATION-STATUS.md:4` 的"官方 token 计数"是对的。

### F12 — 「最多两次规划工具调用」：上限已是 3

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/INTERVIEW-GUIDE.md:17` | 「当前最多**两次**规划工具调用」 | `src/coach/runtime.js:137` `gatherAgentEvidence({..., limit=3, ...})`；`:150` `for(let i=trace.length;i<Math.min(4,limit);i++)` → 最多 3 条工具回执。`docs/CHECKLIST.md:119` 自己记录了「A10 把工具轮次由 2 提到 3」 |
| `docs/IMPLEMENTATION-STATUS.md:4` | 「**两步**按回执选工具」 | 同上（"两步"是旧上限） |

判定：**过时**（`docs/IMPLEMENTATION-STATUS.md:107` 的同句在 v0.5 历史段落里，属历史记录，不计）。

### F13 — 引擎机制：文档与 `RULES` 一致的部分（抽查后仍正确）

- 克制 1.5 / 抵抗 0.75 / 其余含同系 1：`src/game/rules.js:124` 与 `src/game/engine.js:90-98` 一致；`docs/G08-RULES-IN-PLACE.md:25,44` 的描述仍成立（只是没提"同系 ×1"这句新增文字）✓
- 防御减伤 65%、回 2 能量、不可连用、碎岩冲击/破甲重击穿透 → `RULES.guard`、`SKILLS.stonebreak/crush.pierce` ✓
- 强化每层 15%、最多 2 层、3 次在场回合末到期 → `RULES.buff` ✓
- 灼烧 6×2、中毒 8×3、施加当回合结算 → `RULES.status` + `src/game/rules.js` ✓
- 环境 4 回合、清风可移除、对双方生效 → `ENVIRONMENTS` + `coach` 无涉 ✓
- 速胜阈值 10 回合、每级 +5 生命/+1 攻防、升级经验 = 等级×30、上限 Lv.5 → `src/game/progression.js`/`tests/rules.test.js` ✓
- `docs/G06-LATE-GAME-DESIGN.md:29` 的「第 4 关最快 15 回合、第 5 关最快 19 回合、≤10 回合获胜 48 场全部来自第 1 关」→ `reports/balance-calibration-summary.md:127,130` 逐项吻合 ✓；`:37-38` 的环境倍率与 `ENVIRONMENTS` 一致 ✓
- `docs/EVIDENCE-SCHEMA.md` 的 matchId/epoch/journal 240 条/watch 1 条 10 回合/种子替换为 0/PVP-live 前置检查 → 代码逐条吻合 ✓

### F14 — `EVIDENCE-SCHEMA.md` 两处与实现不符

| 位置 | 声称 | 实际 | 判定 |
|---|---|---|---|
| `docs/EVIDENCE-SCHEMA.md:26` | 「工具只读，固定白名单；`search_rules` 只接受 `query`，**其余工具参数为空**」 | `src/coach/toolbox.js:15-24` 的 `TOOL_CONTRACTS`：除 `search_rules{query}` 外，**`simulate_branch{actionIndex,opponentIndex}`、`read_match{offset,limit}`、`read_evidence{turn}` 也接受参数**（`validToolArgs` 逐个校验范围） | **错误** |
| `docs/EVIDENCE-SCHEMA.md:16` | 「`hint`：channel 为 inline、**attention**、endgame 或 watch」 | `grep -rn "'attention'" src/client/app.js src/coach/ src/server/index.js` → **0 命中**；现存 channel 是 `inline`、`endgame`、`watch`，外加动态的 `role+'-'+reason`。基线提交 `e5417e8` 时 `'attention'` 确实存在，属漂移 | **过时** |

---

## 4. "未做 / 已完成"类（清单状态与文档互不一致）

### F15 — 多份文档把已勾项写成"未勾/未完成"

| 位置 | 声称 | 实际（`docs/CHECKLIST.md` 现行状态） |
|---|---|---|
| `docs/DIFFICULTY-AND-SOLUTIONS.md:100`、`:770` | 「长局浏览器真实触发**仍未完成**」「长局残局提示的真实浏览器触发｜未完成（C17）」 | **C17 = `[x]`**（`:235`），注释记录 8 局全部打完整场、残局提示 8/8 各触发 1 次，产物 `reports/c17-endgame-browser.md` + 26 张截图 |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:194`、`:769` | 「S05 慢模型演示**仍是未勾项**」 | **S05 = `[x]`**（`:121`） |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:335`、`:768` | 「整局复盘质量未做独立评测（**S04 未勾**）」「独立大样本质量评测｜未完成」 | **S04 = `[x]`**（`:117`，44 条真实调用 + 三轮对比） |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:775` | 「完整 3v3 配装与队伍组合平衡｜未完成（**G07**）」 | **G07 = `[x]`**（`:139`） |
| `docs/COMPANION-DESIGN.md:32,36` | 「T05 **仍然是一个未勾项**」并引用 `- [ ] T05`（`docs/CHECKLIST.md:70`） | **T05 = `[x]`**（`:76`）；引用的行号 `:70` 现在是 M04 |
| `docs/COMPANION-DESIGN.md:271`、`:501` | 「**U07 仍未勾**」（`:501` 引 `docs/CHECKLIST.md:44`） | **U07 = `[x]`**（`:56`）；`:44` 现在是空行 |
| `docs/COMPANION-DESIGN.md:332` | 「`docs/CHECKLIST.md:53` 的 **M03……是未勾项**」 | **M03 = `[x]`**（`:68`） |
| `docs/COMPANION-DESIGN.md:559` | 「因此 **T05 与 U07 都不勾**」 | 两项都是 `[x]` |
| `docs/W10-ACCEPTANCE-MAPPING.md:17,18,19,20,21,22,30` | 逐项写「**未勾**」/「仍未勾」（P05、U07、G08、S05、G07、C17、T05） | 全部已是 `[x]` |
| `docs/CHECKLIST.md:346-355`「继续未勾的具体原因」 | 列出 P02/P05/P06/A04/A05/U04/U05/U07/M03/T04/R09/R03/S04/G02/G06/G07/F04/F07 | 其中 **P05、A04、A05、U04、U07、M03、S04、G06、G07、F04、F07、P02、P06 都已是 `[x]`**（只剩 U05/T04/R09/R03 仍未勾） |
| `docs/CHECKLIST.md:349`（v0.7 段落后注） | 「RAG 本轮没有通过'比基线更好'的验收，因此 **A03 仍未勾**」 | **A03 = `[x]`** |

判定：**过时**。这批是"清单翻了勾、引用它的文档没跟着改"。

### F16 — `W10-ACCEPTANCE-MAPPING.md` 的"未勾 19 项"、"报告/PDF 未更新"、"test-output.txt 未改写"都已过时

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/W10-ACCEPTANCE-MAPPING.md:5,11,35,64,76` | 「`docs/CHECKLIST.md` 当前仍为 **19 项未勾**」；第五节给出的自查命令注释写「应为 19」 | `grep -c '^- \[ \]' docs/CHECKLIST.md` → **9** |
| `docs/W10-ACCEPTANCE-MAPPING.md:35` | 「其中 **6 项**（`P05`/`U07`/`G08`/`S05`/`G07`/`C17`/`W10` 中的 **7 项**）」 | 同一句话里"6 项"和列出的 7 个名字自相矛盾；这 7 项现在全是 `[x]` |
| `docs/W10-ACCEPTANCE-MAPPING.md:41` | 「规则数据源（P05）、规则页（G08）、语言评审（U07）**都不在报告正文里**」 | `report/sections/` 在 W10 之后被重写（提交 `4135779`、`b37f9fb`、`fb5e92a`）：`03-hard.tex:11` 记的正是 `src/game/rules.js` 没进白名单导致 `/rules.js` 404、整页白屏这一 P05 事件；`:167-171` 讲军师/经验层/规则页同源取数以及"把规则抄成自然语言副本"的教训；`:52-62` 讲文案/术语问题与新增的静态文案检查（`tests/evals/player-copy.test.js`）。**该声明已不成立** |
| `docs/W10-ACCEPTANCE-MAPPING.md:42` | 「`output/pdf/xiaoya-coach-report.pdf` **本轮未重新生成**……不能当作包含本轮结果的提交稿」 | 该 PDF 之后被多次重新生成（`git log` 含 `b37f9fb` 的 `Bin 344947 -> 375293 bytes`）；当前文件 **396,798 字节、mtime 22:09**，且相对 HEAD 有改动 |
| `docs/W10-ACCEPTANCE-MAPPING.md:45`、`:51`（待办第 3 条） | 「`reports/test-output.txt` **本轮未改写**」，并把"更新 test-output.txt"列为仍待办 | 该文件 mtime 22:04、已随 `50ec5fe` 提交，内容正是当前 18 个文件的 `tests 251 / pass 251 / fail 0`；**待办第 3 条已完成** |
| `docs/W10-ACCEPTANCE-MAPPING.md:21` | 「`reports/balance-matrix.md`（**34.7KB**）……**180.6 秒**……拖延上限（**16** 场到 80 回合上限）……（环境只有 **48** 场）」 | `ls -la reports/balance-matrix.md` → **58,229 字节**（34.7KB 是旧版 `4a66d50` 的大小）；当前 JSON `durationMs 185314`、`capCount 18`、`drawCount 35`；带环境的场次 = S8 summit 两个臂 × 12 = **24**。仍正确：5,796 场 ✓、398 arm ✓、11 个 study ✓、每臂 Wilson 95% CI（子代理重算 n=12/wins=9 → [0.4677,0.9111] 与产物一致）✓ |
| `docs/W10-ACCEPTANCE-MAPPING.md:18` | U07 行「**改了 5 处**……报告 3 处未改（在 `src/coach/*.js`）」 | 5 处替换串现存 4 处（见 F21）；原报的"3 处未改"里 `src/coach/companion.js` 的两处**已随陪练重写消失**，只剩 `src/coach/teacher.js:117`「别等倒下再救」与 `src/coach/experience.js:120`「先别只盯着回血」仍在（行号已从 61/66 漂移）。判定：**部分过时** |
| `docs/W10-ACCEPTANCE-MAPPING.md:57` | 基线表「151 / 151 通过 / 0 失败」 | 151 那一行是历史基线，**未能核实**（需要检出旧提交重跑）；同表的 191 行过时（见 F06） |

判定：**过时**（并含一处内部数字矛盾）。`docs/CHECKLIST.md:322`、`:323`（W10 注释）里"PDF 未随本轮重新生成，这是当前唯一的交付面缺口"同样过时。

### F16b — G06、P05 里的**文件归属错误**（不是行号漂移，是点名点错了文件）

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/G06-LATE-GAME-DESIGN.md:91` | 「若加（第 6 关），改的是 `scripts/build-knowledge.js` **前半段的 `STAGES` 手写前缀**，改完必须 `npm run build:knowledge`」 | `scripts/build-knowledge.js` 全文 **25 行**，`grep -n "STAGES\|grove\|summit"` **0 命中**；它只从 `SKILLS`/`SPECIES`/`TYPE_ADVANTAGES`/`knowledge/tactics.json` 生成。`STAGES` 现在在 `src/game/content.js`（该文件 `:7` 也把 `src/game/content.js` 列为核查依据；`docs/P05-RULES-SOURCE.md:141` 的"`src/game/content.js` 手写前缀（`STAGES`/`SCENARIOS`）"才是对的）。后半句（`npm run build:knowledge` + `tests/knowledge.test.js`）仍有效 |
| `docs/P05-RULES-SOURCE.md:140` | 表格行「`src/coach/strategist.js`｜`'回复药优先级4'` 之类出现在检索词里」 | `grep -rn "回复药优先级" src/coach/` → **0 命中**；该串在 `knowledge/tactics.json:91`（并同步进 `src/game/content.js`/语义语料）。基线提交 `e5417e8` 的 `src/coach/strategist.js` 同样没有。见 F17 表内该行 |

判定：**错误**（两处都是"点名的文件里没有这个东西"）。

### F16c — G06 引用的校准数字**早于**相克表改动（结论仍成立，依据的那一轮已过期）

| | |
|---|---|
| 位置 | `docs/G06-LATE-GAME-DESIGN.md:29` |
| 声称 | 「第 4 关最快 15 回合、第 5 关最快 19 回合（超额培养队也是 0 场）」，据此得出"速胜在 04/05 关写得出、拿不到" |
| 实际 | 这两个数字与 `reports/balance-calibration-summary.md:130` **逐字吻合**（高速队第 4 关 15、第 5 关 19），"≤10 回合 48 场全部来自第 1 关"与 `:127` 吻合；但该批校准跑在**属性表改动之前**（`balance-calibration.json` 与相克表重写之间相隔约 2 小时）。用**当前引擎**重跑同一问题（12 种子 × 3 策略 × 4 支满培养队，`stageOptions` 的 grove/summit）：最快胜利回合 grove 16–17、summit 16，**≤10 回合 0 场** |
| 判定 | 引用的数字**过时于当前引擎**，但**结论仍成立**（子代理独立复现）。同时 `src/client/app.js:518` 的界面文案已改为由 `ruleFacts().swiftTurnLimit` 生成，不再是手写 |

---

## 5. 路径 / 测试名 / 命令类

### F17 — 被引用的测试名已被改名，按文档 grep 不到

| 位置 | 声称 | 实际 |
|---|---|---|
| `docs/DIFFICULTY-AND-SOLUTIONS.md:618`、`docs/CHECKLIST.md:91` | `tests/evals/agent.test.js:24`「**32K assembly handles huge history, preserves exact current facts and does not mutate archive**」 | 该位置现在的测试名是「**context assembly trims to an explicit budget, preserves current facts and does not mutate the archive**」。旧名字在基线提交 `849e131` 确实存在（`git show 849e131:evals/agent.test.js \| sed -n 24p` 命中），属**改名后未同步**。断言内容仍成立（`:29` 仍以 `window:32768` 显式调用） |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:513` | 「`docs/COACH-PLAN.md:78`：『明确不是训练敌方电脑，也不是 DeepSeek 权重更新。』」 | **COACH-PLAN 全文没有这句话**（`grep -n "敌方电脑" docs/COACH-PLAN.md` 无命中），`:78` 在基线与当前都是空行；这句实际出自 `docs/CHECKLIST.md:99`（R01）。属**错误引用**（不是行号漂移：`docs/COACH-PLAN.md` 自基线以来只改了 1 行） |
| `docs/DIFFICULTY-AND-SOLUTIONS.md:397` | 「`docs/reviews/2026-09-17-diagnosis-response.md:26`」引"关键词与概念扩展在 14 条正例中相差 1 条……" | 该句在 **`:25`**；`:26` 是关于 Q 表实验的。该文件自基线以来**未被修改过**，所以这是原始的行号笔误 |
| `docs/INTERVIEW-DRILL.md:51` | 把「断言 `search_rules → compare_actions → read_state`」算在「`tests/evals/agent.test.js` 覆盖」 | 该断言在 **`tests/coach.test.js:61`**；`grep -c "search_rules\|compare_actions" tests/evals/agent.test.js` → **0**。同句「六条退出路径」也已过时：`gatherAgentEvidence` 现在有 12 种 `stopped` 值 |
| `docs/CHECKLIST.md:118` | 「再补 `requiredTool` 程序化硬需求后**三轮数据见 `reports/live-model-eval.json`**」 | 该文件只存**第 3 轮**（`unnecessaryToolCallRate 0.136`、`missedCallRate 0.7727`）；第 1 轮在 `reports/live-model-eval-before.json`（0.75 / 0）、第 2 轮在 `reports/live-model-eval-pass2.json`（0.3333 / 0.2188），对比在 `reports/live-model-eval-before-after.md` |
| `docs/INTERVIEW-DRILL.md:40`、`:57` | 「44 条真实调用、**首选工具正确率 90.63%**、严格正确率 31.25%→50.00%」并列，读起来像当前值 | `reports/live-model-eval-before-after.md:41` 的表写明「首选工具在允许集合内（全 32 条）｜**90.63%**（改前）｜**78.13%**（改后）」；`reports/planner-tuning-log.md:52` 也写「第 1 轮 90.63%」。31.25%→50.00% 正确（`live-model-eval-before.json` 0.3125、`live-model-eval-pass2.json` 0.5）。**把改前值当成了当前值** |
| `docs/INTERVIEW-DRILL.md:74` | 「混合（**词项+语义 RRF**）90.18%」 | 该臂是**已上线的 `searchKnowledge`**，`src/coach/strategist.js:73` 自报 `method: 'IDF lexical + domain concept expansion'`；RRF（`rrf:60`）只出现在语义那一轮的 `fusion` 臂（`scripts/eval-semantic.js`、`reports/semantic-retrieval.json`）。这正是 `docs/DIFFICULTY-AND-SOLUTIONS.md:429` 自己指出的"两个都叫混合的东西算法不同"陷阱，在 `INTERVIEW-DRILL` 里又踩了一次（Hit@3 四个数字本身正确） |
| `docs/P05-RULES-SOURCE.md:140` | 表格行「`src/coach/strategist.js`｜`'回复药优先级4'` 之类出现在检索词里」 | `grep -rn "回复药优先级" src/coach/` → **0 命中**；该串实际在 `knowledge/tactics.json:91`（并同步进 `src/game/content.js`/语义语料）。基线提交 `e5417e8` 的 `src/coach/strategist.js` 也没有过（`grep -c` = 0）。**文件归属错误** |
| `docs/P05-RULES-SOURCE.md:76` | 引 `tests/browser.test.js` 的测试名「`the server allowlist covers every browser module`」 | 真名是「`the server allowlist covers every browser module **plus the page shell**`」（`tests/browser.test.js:42`）。引的是前缀、未加省略号；它引的失败信息原文正确。**属引文精度**（同类：`docs/G08-RULES-IN-PLACE.md:42,45,46` 也是截断引用，但都指向唯一存在的测试） |
| `docs/LANGUAGE-REVIEW.md:112` | 「`src/coach/strategist.js:100` 与 **`src/coach/runtime.js`** 的模型约束（……`不要向玩家报内部局面评分`）」 | 该句在 **`src/coach/client.js:3`**（`RESPONSE_INSTRUCTIONS`）；`src/coach/runtime.js` 里 0 命中 |
| `docs/INTERVIEW-DRILL.md:34` | 「**`src/coach/client.js`** 的 `checkGroundedAnswer`」 | 定义在 **`src/coach/runtime.js:207`**；`src/coach/client.js:4` 只是 import、`:29` 调用 |

判定：**过时/错误**。所有这些都可由读者按文档里的路径现场 grep 到反例。

### F18 — 被引用的路径与命令：全部存在（抽查后仍正确）

`scripts/` 下被文档点名的 22 个脚本全部存在（`eval-live-model.js`、`eval-semantic.js`、`eval-balance.js`、`train-tool-router.py`、`eval-retrieval.js`、`train-intervention.js`、`build-knowledge.js`、`count-tokens.py`、`build-report.py`、`eval-balance-calibration.js`、`eval-swift-threshold.js`、`eval-balance-matrix.js`、`cdp-long-game.js`、`cdp-rules-check.js`、`build-demo.mjs`、`browser-smoke.mjs`、`opponent-smoke.mjs`、`eval-live-s04.js`、`analyze-live-eval.js`、`eval-retrieval-extended.js`、`semantic-worker.py`、`eval-opponent-agent.js`）；被点名的 36 个 `reports/`、`checkpoints/`、`tests/evals/`、`docs/reviews/` 产物也全部存在。`docs/LANGUAGE-REVIEW.md:147-148` 的两条 grep 复现命令中，第二条**仍正确**（只命中 `src/coach/companion.js:237` 的黑名单检测器）。

---

## 6. 自我指涉类（"仓库内检索 X 零命中"这类断言现在是否还成立）

### F19 — 「无水平羞辱 / 不空泛安慰」的"零命中"复查命令已不再零命中

| | |
|---|---|
| 位置 | `docs/LANGUAGE-REVIEW.md:127`、`:147`（命令注释写「期望 0 命中」）；`docs/CHECKLIST.md:58` |
| 声称 | 「全库检索 `你应该 / 你必须 / 你最好 / 下次别 / 别再 / 不要再`：**0 命中**」 |
| 实际 | 按文档给的原命令 `grep -rn "你应该\|你必须\|你最好\|下次别\|别再\|不要再" src/client/app.js src/client/index.html src/coach/*.js` → **2 处命中**：`src/coach/experience.js:190`（注释：「点掉就是「这局别再打断我」」）与 `src/coach/teacher.js:40`（注释：「也不出现「你应该点这个」」） |
| 判定 | **过时**（作为"可现场复现的检查"）。但**实质结论仍成立**：两处都在代码注释里，不是玩家可见文案；`:147` 第二条命令（没关系/别灰心/加油…）依然只命中检测器 |

### F20 — 语言评审规模「约 960 处」现场复算对不上

| | |
|---|---|
| 位置 | `docs/LANGUAGE-REVIEW.md:7`（并明说"可用第六节的命令现场复算"）、`docs/CHECKLIST.md:58` |
| 声称 | 「`src/client/app.js` **247** 条、`src/coach/*.js` 合计 **420** 条、`src/game/engine.js` **160** 条、`src/client/index.html` 118 处 + 18 个属性值，合计约 **960** 处」 |
| 实际 | 按文档自己的命令实跑：`src/client/app.js 253`、`src/game/engine.js 160`、`src/coach/*.js 487`。（`src/coach/*.js` 增长主要来自 `src/server/opponent.js` 等新增文件与 `src/coach/companion.js`/`src/coach/experience.js` 的重写。）`src/client/index.html` 的"118"文档没给方法，我用汉字串计数得到 145 个 run，**未能按原方法复现**；"+18 个含中文属性值"可复现 |
| 判定 | **过时**（至少 src/client/app.js 与 src/coach/*.js 两处）；`src/game/engine.js 160` 仍正确 |

### F21 — 「改 5 处」作为当前陈述已不成立

| | |
|---|---|
| 位置 | `docs/LANGUAGE-REVIEW.md:15`（并列出 5 处改动）、`docs/CHECKLIST.md:58` |
| 声称 | 「最终结果：**改 5 处**、报告 3 处未改、其余保持原样」，其中第 3 处改为「这一回合没有明显更优的选择：**先比较对方留场和换宠两种分支**。」 |
| 实际 | `src/client/app.js:320` 现在是「这一回合没有明显更优的选择：**先看对手是留在场上还是换人**。」；用文档里的复查命令 `grep -n "先比较对方留场和换宠两种分支" src/client/app.js` → **0 命中**（被 `b2cd1f6` 的文案清扫改掉）。另外 4 处替换串仍在：`src/client/index.html:4`「展开这回合的取舍」、`src/client/app.js:526`「本场已结束。下面有一个值得回看的关键回合。」与「先按这个打，出招后我按新局面重算。」、`src/client/app.js:610`「加错了可以免费重置」 |
| 判定 | **过时**（"改 5 处"中的 1 处已被后续清扫替换） |

### F22 — 「玩家可见的问句只剩 3 类」不成立

| | |
|---|---|
| 位置 | `docs/LANGUAGE-REVIEW.md:129` |
| 声称 | 「玩家可见的问句只剩 3 类：首次偏好选择、场景设置、小测题目」 |
| 实际 | 至少还有 `src/client/app.js:418` 的「离开会结束本次训练且没有奖励，返回营地吗？」与 `src/coach/companion.js:195` 的「这句我还没接准。你说的是哪一处？」，两处在评审当时（`3db30c5`）就已存在 |
| 判定 | **错误**（断言"只剩 3 类"时漏掉了两处既存问句） |

### F23 — `LANGUAGE-REVIEW` §A 引的"HEAD 版本"文本在 HEAD 里不存在

| | |
|---|---|
| 位置 | `docs/LANGUAGE-REVIEW.md:68-84`（标题写「三处都在 `src/coach/*.js` 里」、`:72` 起标"（HEAD 版本）"） |
| 声称 | 引用了 `可以先缓一缓…`、`${memory.lessons.length?'我们已经练过速度判断了。'…}`、`memory.events.at(-1)` 三段"当前代码" |
| 实际 | 三段在 `3db30c5`（写入本文档的那次提交）里 `grep -c` 均为 0，只存在于其父提交。`:84` 说「并行任务正在把该文件重写……新增 `companionFacts` / `decideRegister` / `checkCompanionRestraint`」——这三者**已经存在**（`src/coach/companion.js:39/:110/:230`），即重写与本文档同批落地 |
| 判定 | **过时**（"HEAD 版本"的标注与实际不符；列出的三个问题现在仓库里都已不存在） |

### F24 — `RAG-LOCALIZATION.md` 整份"当前落地"已过时

| 位置 | 声称 | 实际 | 判定 |
|---|---|---|---|
| `:3` | 「**当前交付**：离线检索工具基础与测试；**尚未接入线上聊天/自动提示**，不代表完整 RAG 或 ReAct 已验收」 | 检索早已接入军师与局内提示（`src/client/app.js` import `src/coach/strategist.js`）；同文件 `:63` 自己写「以上"离线未接入"的描述是首轮状态」 | 过时 |
| `:13` | 「`knowledge/tactics.json`：**11 张卡**」 | **49 张** | 过时 |
| `:15` | 「`src/coach/retrieval.js`：中文双字切分……加权词项匹配」 | `src/coach/retrieval.js` 现在只有 2 行（转发到 `src/coach/strategist.js`）；行为描述本身正确但**归属错了文件** | 过时 |
| `:17`、`:19` | 「`tests/knowledge.test.js`：**6 个测试**」「当前 **6 项通过**」 | **11 条**（多出 switch-loop 反例、军师包、`src/game/content.js` 一致性、引擎参考卡、语义语料生成） | 过时 |
| `:39` | 「当前卡片的 `requiredEvidence` 是文字声明。**下一步**转为明确字段，检查是否有灼烧、是否有技能、资源是否足够」 | 已经做了：90/90 张卡都有 `conditions` 数组，`src/coach/strategist.js:75` 的 `applicability()` 返回 `candidate / conditions-not-met / reference-only`，`src/coach/runtime.js:161-169` 在把回执交给模型**之前**剔掉 `conditions-not-met` 的卡 | 过时 |
| `:44` | 「外部记忆与 **32K 测试**」 | 预算已是 200K（见 F11） | 过时 |
| `:63` | 「本轮知识卡扩至 **30 张**……**真实 DeepSeek 质量尚未测量**」 | 90 张；质量已测（44×3 轮 + 5 条 v0.10 调用）；前半句"实现移至 `src/coach/strategist.js`、`src/coach/retrieval.js` 保留兼容导出"仍正确 | 过时 |
| `:69` | 「下一步优先对 **30 张**知识卡编写适用/不适用测试，并将固定检索**升级为有界工具选择**」 | 90 张；有界工具选择已实现（`gatherAgentEvidence`，现为 3 轮） | 过时 |

---

## 7. 根目录 `README.md` 与 "交付入口"

### F25 — README 的「8 只基础伙伴与 4 只战术伙伴分组展示」在代码里不存在

| | |
|---|---|
| 位置 | `README.md:57` |
| 声称 | 「配招位于培养栏折叠项；不花训练点，下一场生效。**8 只基础伙伴与 4 只战术伙伴分组展示**，均可直接体验。」 |
| 实际 | 这个分页（`基础伙伴 · 8` / `战术伙伴 · 4`，`SPECIES.slice(0,8)` / `slice(8,12)`）在 **`cf841c6`（2026-09-17 14:32）被删除**，提交信息写明它"read as a gameplay distinction that does not exist"，改成按属性筛选全部 12 只。现在 `src/client/app.js:48`（营地）与 `:64`（出征页）都走 `filteredSpecies()` + `renderTypeFilter()`，`src/client/index.html` 的 nav 是 `aria-label="按属性筛选伙伴"`；全仓库 `grep -rn "战术伙伴\|基础伙伴"` 只剩 README 这一行与 COMPANION-DESIGN 里一句无关引用 |
| 判定 | **错误**（README 未被同步；该段落所在文件的 mtime 是 16:21，晚于删除该分组的 14:32） |
| 反向确认 | 用 `git log -S"战术伙伴" -- app.js index.html README.md` 找到引入/移除的两个提交，再用 `git show 849e131:app.js \| grep 战术伙伴` 确认基线时确实存在、`grep -c 战术伙伴 src/client/app.js src/client/index.html` 现在为 0 |

### F26 — README 其余可核对的声明仍正确

UI v0.11 / 规则 v0.6 / 12 宠 / 5 关 / 3 档难度 ✓；`npm start`、`npm test`、`npm run build:knowledge`、`npm run eval:retrieval`、`npm run train:intervention` 脚本都存在 ✓；「最多 240 条教练事件」→ `src/coach/memory.js` `slice(-240)` ✓；「已实现 6 选 4 配招、两种一次性携带物、强化/驱散和后期环境」✓（`HELD_ITEMS` 除 `none` 外 2 件；`SKILLS.dispel` 存在）；「语音已暂停使用」→ `src/client/app.js:620 VOICE_FEATURE=false` ✓；「实际更新 1152 个参数」✓；「90 条本地知识」✓。

### F27 — `GAME-EXPANSION-PROPOSAL.md` 的"尚未实现"整体过时

| 位置 | 声称 | 实际 |
|---|---|---|
| `:3` | 「本文其余内容仍是草案……**驱散强化**/蓄电特性等提案尚未实现」 | **驱散已实现**：`src/game/engine.js` 的 `SKILLS.dispel`（破势，命中后清除目标攻防强化、可被防御挡），并进了多只宠的 learnset（`extraSkills` 里 11 只带 `dispel`） |
| `:68` | 「克制 1.5、逆向抗性暂定 0.75，其余 1.0；**同系关系与现有实现需统一决策**」 | 已决策并落地：`src/game/engine.js:90-98` 同系 ×1，两个对称三环；`src/game/rules.js:124` 同步说明 |
| `:144` | 「本预案的**宠物、倍率、属性表、环境和关卡均为设计提议，尚未实现或验证**」 | 四项全部实现：12 宠（`SPECIES`）、1.5/0.75 倍率（`RULES.typeAdvantage/typeResist`）、属性表（`TYPE_ADVANTAGES` 两个三环）、环境（`ENVIRONMENTS` 细雨/山风，且在 04/05 关在线）、5 个关卡（`src/game/content.js STAGES`） |

判定：**过时**（该文件带 `日期：2026-09-16` 且自称草案，但 `:3` 的"尚未实现"与 `:144` 的"均为设计提议"读起来是当前状态）。

### F28 — `P05-RULES-SOURCE.md` 与 `G08-RULES-IN-PLACE.md` 的"硬编码副本"清单仍正确

`docs/P05-RULES-SOURCE.md:137-139` 列的 `src/coach/runtime.js` 的 `energyLimit:6`、`src/coach/experience.js` 的「额外回2豆」「等回合末回1豆」、`src/coach/teacher.js` 的「一次培养：生命 +12 / 攻击 +4 / 速度 +3」**三处都还在**（`src/coach/runtime.js:20`、`src/coach/experience.js:106,108`、`src/coach/teacher.js:17`）✓。`docs/G08-RULES-IN-PLACE.md:64` 的说法同样成立。

---

## 8. 其余文档的抽查结果

### F29 — `DEMO-WALKTHROUGH.md` 两处被后续提交作废

| 位置 | 声称 | 实际 | 判定 |
|---|---|---|---|
| `:56` | 「右侧培养面板：……**四项加点**（耐久/力量/敏捷）」 | `src/game/progression.js:4` 的 `TRAINING` 只有 **3** 项（耐久/力量/敏捷），`src/client/app.js:84` 也是遍历它 | **错误**。该句由生成脚本硬编码：`scripts/build-demo.mjs:489` 的 `expect` 里写着"四项加点"——**重跑脚本会把这个错误原样再生成一次** |
| `:57` | 「点击第 2 只伙伴的「培养」后，右栏培养面板**没有变化**……营地名册的「培养」分支（**src/client/app.js 第 38 行**）只调用 `showCamp()`，没有重新渲染 `#cultivation`」 | 现在 `src/client/app.js:50` 是 `advanceContext();focus=b.dataset.focus;showCamp();cultivation();`——**面板会重绘**。该观察在生成时刻（`生成时间 2026-09-17 18:41:31`）是真实的，`d4ecd67`（18:42:25，晚 1 分钟）修掉了它 | **过时**。这段文字在 `scripts/build-demo.mjs:486` 是**运行期分支**（`before===after` 才输出那段），所以重跑脚本会输出另一条正确分支 |
| `:256` | 「脚本只写 `output/demo/` 与 `docs/DEMO-WALKTHROUGH.md`，不修改任何现有源码」 | 脚本还会创建/清理 `tmp/demo-profile`（`build-demo.mjs:922-923`，且本文档 `:16` 的启动参数里就写着它） | 轻微不准 |
| `:204` | 「AI 对手……『已独立出招（看不到你的选择）』」 | 该面板后来被改成**毛玻璃遮挡**（`src/client/app.js:311-314`，`0781da2`），句子不再完整描述现状 | 轻微过时 |
| 其余 | 生成时间、8765、v0.11 徽标、启动参数、视口 1440×813（PNG 尺寸吻合）、21 张截图、`#coach-welcome`、关卡按钮、`#round-coach`、`即时`=`value 0`、整局复盘按钮文案等 | 逐条核对**仍正确** | — |

### F30 — 行号漂移：一份**已声明**的、但影响面很大的问题

- `docs/DIFFICULTY-AND-SOLUTIONS.md:11` 与 `docs/COMPANION-DESIGN.md:5` 都声明「行号与 commit `849e131` 一致」。
- 我按该提交逐个核对，**声明是诚实的**：`src/coach/runtime.js:139/118/88-89/97`、`src/server/index.js:27`、`docs/CHECKLIST.md:281/210/83/86/196/70/267/276/279/285/94/176/239/208`、`docs/COACH-PLAN.md` 多数引用，在 `849e131` 处**全部命中**。
- 但 `docs/CHECKLIST.md` 此后被追加/改勾，`docs/DIFFICULTY-AND-SOLUTIONS.md` 里所有 `docs/CHECKLIST.md:NNN` 引用**现在都指向别的行**（例如 `:753` 引的 `:281` 现在是 N05，A05 的括注在 `:346-355` 的列表里）。
- 唯一一处**与漂移无关**的错误引用是 F17 里的 `docs/COACH-PLAN.md:78`。
- 判定：**过时（已声明，但读者按引用找会落空）**。建议把它当成"引用格式"问题、而不是内容问题。

### F31 — `S05-W09-SLOW-MODEL.md`：未发现过时/错误

`:41-46` 六行测试名、断言与 `tests/evals/slow-model.test.js` **逐字吻合**（250ms/40ms→AbortError、交付列表为空；120ms/20ms→`stateToken===1`；同局面合并为 1 次；三次快速出招只补发最后一条；静态"无语音"断言；600ms 不复活）✓；`:48` 6/6 通过 ✓；`:63` 语音已停用与 `U05/V08/E08` 未勾一致 ✓；`:72-74` 三条复现命令都能跑 ✓。判为**仍正确**。

### F32 — `XIAOTIAN-RESEARCH.md`：未发现硬错误

`:137`「`src/coach/companion.js`（274 行）」→ `wc -l` = 274 ✓；`:143` 主动通道由 `companionEvents()` 的 `first-faint` / `result` 触发 → `src/coach/companion.js:269-274` ✓；`:145` R2 是唯一 `advice:true` 的档位 → `src/coach/companion.js:12-17` ✓；`:146` 5 个门控 → `src/coach/session.js:9-11` ✓；`:154` 引的两条正则行为正确（第二条略去部分分支，未加省略号——属引文精度问题，不是错误）；`:179/:198` 对 `COMPANION-DESIGN.md` §9 的交叉引用准确 ✓。判为**仍正确**（1 处引文精度提示）。**注意**：该文件正确地说主动气泡会触发，而它指向的两份文档（F01）是错的。

### F33 — `LINGBAO-RESEARCH.md`、`RESEARCH-NOTES.md`、`INTERVIEW-GUIDE.md`、`EVIDENCE-SCHEMA.md` 其余部分

- `docs/LINGBAO-RESEARCH.md`：`:7/:13/:23/:29` 与代码/其他文档对得上；`:27`「不能只靠停留 20 秒就判定玩家需要答案」经代码走查成立（裸 20 秒分支只能经 `hesitationSignal`(≥2 选项/≥3 悬停/≥8 秒) 或 `dwellSignal`(≥10 秒且有游标) 到达）✓。判为**仍正确**。
- `docs/RESEARCH-NOTES.md:41`「小芽**还需自行实现**证据 ID、版本与删除同步」→ 三项都已实现：`src/coach/runtime.js:16` 生成 `…:turn:N` 证据 ID；`src/coach/experience.js:153-154` 的 `taskStamp/taskIsCurrent` 校验 epoch+matchId+rulesVersion+TTL；`src/coach/memory.js:126-129` 的 `deleteMemoryEvidence` 级联删除引用它的反思（`tests/evals/agent.test.js:16` 有断言）。判为**过时**。
- `docs/INTERVIEW-GUIDE.md:47`「## **v0.10** 更值得被追问的数字」→ 仓库处处是 v0.11（`src/server/index.js:69`、`src/client/app.js` 三处徽标、`README.md:3,14`、`docs/README.md:3`）。标题过时；其下四个数字经复核**全部仍正确**。判为**过时（仅版本标签）**。
- `docs/reviews/2026-09-17-live-acceptance.md:3`「UI v0.9；运行后端 v0.8」、`:26/:28` 关于语音试听与自动语音的观察 → 现在 v0.11 且语音已停用（`src/client/app.js:620-631`）。判为**过时**（作为"当时记录"可接受，但 `:28` 读起来像当前能力）。
- `docs/reviews/2026-09-17-diagnosis-response.md:9`「重启后 bootstrap 提供 runtimeVersion=**0.8**」→ `src/server/index.js:69` 是 `'0.11'`；`:12`「**不再叠加**无信息的首次倒下安慰气泡」→ 首次倒下气泡**现在存在且已接线**（`src/client/app.js:342-344`、模板在 `src/coach/companion.js:252-256`），只是改成了引用真实事实而非空泛安慰；`:33`「v0.8 真实 DeepSeek 复盘质量仍待……验证」→ 其后已测（`reports/live-model-v08.json`、`live-model-v10*.json`、三轮 44 条）。判为**过时**。
- `docs/COMPANION-IMPLEMENTATION.md:5`「改动前 tests 150 / pass 149 / fail 1」这类**明确标注时点的历史记录**，不计为错误。

---

## 9. 未能核实（以及复现需要什么）

| 事项 | 为什么没核实 | 复现需要什么 |
|---|---|---|
| 所有需要真实 API 调用的数字（44 条 S04 的逐条指标、五条 v0.10 调用的延迟与 token 差、$0.0335 成本、p50/p90） | 只读任务，不花 API 额度、不改运行态 | 用已连接密钥跑 `node scripts/eval-live-s04.js`（会消耗额度）并重跑 `scripts/analyze-live-eval.js`；或重新执行 `scripts/eval-v10-model.js` |
| 浏览器侧实测（C17 的 8 局长局、规则弹窗 DOM 尺寸与字符数、五种视口尺寸走查、21 张演示截图的真实性） | 需要启动/使用本机 8765 与 headless Chrome，且本任务限定只读；我**只核对了保存下来的产物**（`reports/c17-endgame-browser.md`、`reports/p05-rules-browser-check.txt`、形如 1440×813 的 PNG 尺寸、21/26 张截图确实存在），没有重跑 | 服务在跑时执行 `node scripts/cdp-rules-check.js`、`node scripts/cdp-long-game.js`、`node scripts/browser-smoke.mjs` |
| `reports/balance-matrix.md` 里各 study 的逐格数字（972/864/288/1200/720/192/216/48/216/1080 场） | 只复算了总数（`arms` 聚合 = 5796 / 398，且逐 study 场次与文档一致），没有逐格重算胜率 | 重跑 `node scripts/eval-balance-matrix.js`（本机数分钟） |
| `reports/intervention.json` 的 `rewardAudits` 四行（−2.2197 / 0 / −0.8892 / +0.7295）与轨迹字节数 | 读了 `intervention-summary.txt` 与 `trajectory-audit.json`，未重跑训练 | `npm run train:intervention` |
| `reports/tool-router-rl.json` 的 750 行轨迹与检查点 | 读了 summary，未重跑训练 | `.venv-agent/bin/python scripts/train-tool-router.py` |
| 「改动前 151 项全绿」这类**历史基线**（`docs/P05-RULES-SOURCE.md:41,150,157`、`docs/W10-ACCEPTANCE-MAPPING.md:57`） | 要证明它需要检出旧提交并重跑，与"只读"约束冲突 | `git stash`/`git checkout <旧提交>` 后跑 `npm test`（会改动工作区） |
| `docs/P05-RULES-SOURCE.md:127`「把 `RULES.guard.reduction` 从 .65 改成 .6，会有 **4 项测试同时失败**」 | 需要修改 `src/game/engine.js` 才能验证；只读约束不允许 | 临时改常量后跑 `npm run test:rules`，再改回 |
| 外部世界事实（小田 2026-05-28 上线、灵宝公告原文与链接、1.1 亿/1770 万等发布会数字） | 仓库外事实，且不联网 | 复查 `docs/XIAOTIAN-RESEARCH.md` / `docs/LINGBAO-RESEARCH.md` 里列的原始链接 |
| `src/client/index.html` 的「118 处中文文本片段」 | 文档没给计数方法，我按"汉字 run"数得到 145，无法复现 | 需要文档作者补上原命令 |
| `output/pdf/xiaoya-coach-report.pdf` 的内部正文（例如它写的是哪一版测试数） | PDF 用子集化 CJK 字体，纯文本抽取不可靠；只能确认 mtime 22:09 晚于 `report/sections/` 的 21:38–21:54，即 tex 改动后重新生成过 | `pdftotext`/`pdftoppm` 逐页读，或看 `report/` 源 |

---

## 10. 结论：清单本身的覆盖度

**覆盖度评估：清单覆盖"任务项"，不覆盖"声明与仓库的一致性"。**

- `docs/CHECKLIST.md` 有 148 个勾选行（139 已勾 / 9 未勾），每一项都有可核查产物，注释写得比大多数项目都诚实——这一层是可靠的。
- 但它有两个结构性缺口，本次查出的问题**几乎全部落在缺口里**：
  1. **清单只审计自己列出的项**。像 `README.md:57`（分组展示）、`EVIDENCE-SCHEMA.md:26`（工具参数）、`RAG-LOCALIZATION.md` 的卡片数、`knowledge/tactics.json` 的地面事实卡、`DEMO-WALKTHROUGH.md` 的"四项加点"、`INTERVIEW-GUIDE.md:17`（两次工具调用）——**没有一个在清单里有对应条目**，因此永远不会被"逐项验收"扫到。
  2. **清单自己也会漂移**：14 个 `[x]` 项的注释里仍留着"仍未勾/未勾原因"（P05:19/21、U07:56/58、T05:76/78-79、C05:89/92、S04:117/119、S05:121/123、G06:136/138、G07:139/141/144、G08:145/147、F07:169/171、R10:200/204、C17:235/237、W10:321/323），`未勾 8 项` 一节（`:376`）把已经是 `[x]` 的 S05 仍算作未勾、而实际未勾是 9 项，`继续未勾的具体原因`（`:346-355`）里 13 个被点名的项已有 8 个翻成了勾。**引用清单的下游文档（DIFFICULTY、COMPANION-DESIGN、W10-MAPPING）因此集体失真**——F15/F16 那一整批都是这么来的。
- **会不会再出现？会。** 本次修好的五个例子里，`COMPANION-DESIGN` 的 notify 只改了抬头与一处（F01），`COMPANION-IMPLEMENTATION` 整份没动；`CHECKLIST` 的 G07 数字错配（F02）来自"换了一张规则表后重跑了仿真、但清单引用的是上一轮"。只要仍然是"人手写数字 + 无自动校验"，这两类（跨文档引用、产物被重跑后引用失效）就会继续复发。
- **能一次性挡住一大半的两条低成本措施**（供参考，本次未实施）：
  1. 把每个"数字断言"标上**产物路径 + 现场复算命令**，并让 `npm test` 里加一条"文档引用的产物存在且关键字段一致"的测试（`tests/wiring.test.js` 已经证明这类机械检查在本仓库可行）；
  2. 把 CHECKLIST 的勾选与注释拆开：注释只写"本条范围内的证据"，"是否勾选"单独一处维护，避免 `[x]` 与"未勾原因"共存。

---

## 附：逐份文档的覆盖面索引（`docs/` 下 24 份 + 根 `README.md`，共 25 份）

| 文档 | 核对结论 | 见 |
|---|---|---|
| `docs/CHECKLIST.md` | 一半可靠一半漂移：勾选与产物基本可信；14 个 `[x]` 项的注释仍写"仍未勾"，"未勾 8 项"实为 9 项，G07 证据数字取自旧轮次，W12 的 114 项过时 | F02、F06、F15、F16 |
| `docs/COACH-PLAN.md` | 主体已更正且与代码一致；§8 标题与"示例 32K 预算"与 §2 自相矛盾 | F11 |
| `docs/COMPANION-DESIGN.md` | 内部自相矛盾：`:283` 说已接线，`:105/:293/:485/:542/:645` 说没接线；T05/U07/M03 的"未勾"三处过时；`tests/companion.test.js` 条数 12→13 | F01、F06、F15 |
| `docs/COMPANION-IMPLEMENTATION.md` | 整份未跟上接线；测试数 177→251、12 条→13 条 | F01、F06 |
| `docs/DEMO-ACCEPTANCE.md` | 「保守 UTF-8 字节估计，不冒充精确 tokenizer」与实现相反；"32K 装配用例"框架过时 | F11 |
| `docs/DEMO-WALKTHROUGH.md` | "四项加点"错误（实为 3 项）；"培养面板不重绘"的实测观察在 1 分钟后被修掉；两处轻微不准 | F29 |
| `docs/DIFFICULTY-AND-SOLUTIONS.md` | 结构最严谨的一份，但测试数（122/127）、预算窗口（32768）、A05/名称漂移、C17/S05/S04/G07 的状态、一处错误引用（COACH-PLAN:78）均过时 | F04、F06、F11、F15、F17 |
| `docs/EVIDENCE-SCHEMA.md` | 主体与代码吻合；工具参数与 `attention` 频道两处不符 | F14 |
| `docs/EXPERIMENTS.md` | 全部实验数字（检索/干预/工具路由/延迟/token 差）逐项核实**仍正确**；只有测试数 127 与"窗口 32768""名称约束仍需复验"过时 | F06、F10、F11、F04 |
| `docs/G06-LATE-GAME-DESIGN.md` | 现状核查与结论仍成立；`:85` 引文失真（48→24）、`:91` 点错文件、`:29` 依据的那轮校准早于相克表改动 | F08、F16b、F16c |
| `docs/G08-RULES-IN-PLACE.md` | 规则页结构、测试名、命令基本仍正确；只有字符数 4316→4309 | F09 |
| `docs/GAME-EXPANSION-PROPOSAL.md` | 自称草案，但"驱散未实现""同系关系需统一决策""宠物/倍率/属性表/环境/关卡均未实现"三处已被实现 | F27 |
| `docs/IMPLEMENTATION-STATUS.md` | 顶部"当前状态"块两处过时（127 项、"两步"工具）；历史段落标了时点，不计 | F06、F12 |
| `docs/INTERVIEW-DRILL.md` | 大部分数字可核实；`checkGroundedAnswer` 归属、90.63% 混用改前值、`tests/evals/agent.test.js` 归属、`live-model-eval.json` 指针、hybrid≠RRF 五处需修 | F17 |
| `docs/INTERVIEW-GUIDE.md` | 四个数字**全部仍正确**；"最多两次规划工具调用"过时，标题停在 v0.10 | F12 |
| `docs/LANGUAGE-REVIEW.md` | 结论（无水平羞辱/不空泛安慰）仍成立；但"0 命中"复查命令、评审规模、改 5 处、问句只剩 3 类、§A 的"HEAD 版本"引用、模型约束归属六处过时 | F19-F23、F17 |
| `docs/LINGBAO-RESEARCH.md` | 未发现硬错误 | F33 |
| `docs/P05-RULES-SOURCE.md` | 方法学与"硬编码副本"清单仍正确；测试数（191/189 两处且互相矛盾）、字符数、`:140`/`:76` 的归属与引名需修 | F06、F09、F16b、F17 |
| `docs/RAG-LOCALIZATION.md` | 整份"当前落地"过时（11/30→49/90 张卡、6→11 测试、"尚未接入"、"下一步转字段"其实已做、32K） | F24 |
| `docs/README.md` | 12 宠 / 90 条知识（49+41） / v0.11 / v0.6 **全部正确** | F10、F26 |
| `docs/RESEARCH-NOTES.md` | 外部资料部分不可核（未联网）；`:41`"还需自行实现"三项其实都已实现 | F33 |
| `docs/S05-W09-SLOW-MODEL.md` | **未发现过时或错误**：六条测试名与断言、只读约束、复现命令逐项吻合 | F31 |
| `docs/W10-ACCEPTANCE-MAPPING.md` | "19 项未勾""report/PDF 未更新""test-output.txt 未改写""180.6 秒/34.7KB/16 场/48 场"及 8 行"未勾"全部过时；另含一处 6-vs-7 内部矛盾 | F16、F16b、F07 |
| `docs/XIAOTIAN-RESEARCH.md` | **未发现硬错误**；代码级引用逐条吻合；仅 1 处引文省略号缺失 | F32 |
| 根 `README.md` | 除"8 只基础伙伴与 4 只战术伙伴分组展示"外，其余可核对声明全部正确 | F25、F26 |

**判定分布**：明确过时/错误的文档 18 份；抽查后未发现问题的 5 份（`EXPERIMENTS.md` 的实验数字部分、`S05-W09-SLOW-MODEL.md`、`XIAOTIAN-RESEARCH.md`、`LINGBAO-RESEARCH.md`、`docs/README.md`）。共记录 **44 条**具体问题（含同一条在多份文档重复出现的，按发现编号计）。

---

## 附：判定分布

| 判定 | 条数（按发现编号计） |
|---|---|
| 过时 | 主要：F01、F02、F04、F06(部分)、F07、F09、F11、F12、F14(第二处)、F15、F16、F17、F19、F20、F21、F23、F24、F25(错误)、F27、F29(第 2 处)、F30、F33 多份 |
| 错误 | F02（数字错配）、F03、F08、F14(第一处)、F17（`COACH-PLAN:78`）、F22、F25、F29(第 1 处)、`docs/reviews/2026-09-17-live-acceptance.md:30`（100 项） |
| 仍正确（抽查确认） | F10、F13、F18、F26、F28、F31、F32，以及 `docs/EVIDENCE-SCHEMA.md` 主体、`docs/S05-W09-SLOW-MODEL.md` 全部、`docs/G06-LATE-GAME-DESIGN.md` 除 `:85` 引文外全部、`docs/LINGBAO-RESEARCH.md`、`docs/XIAOTIAN-RESEARCH.md` |
| 未能核实 | 见第 9 节（9 类） |

**没有修改任何其他文件；`docs/CHECKLIST.md` 的勾选状态保持原样（`grep -c '^- \[ \]'` 仍为 9）。**
