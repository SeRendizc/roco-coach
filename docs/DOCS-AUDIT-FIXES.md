# DOCS-AUDIT 修复报告（`docs/DOCS-AUDIT.md` 的 43 条）

修复时间：2026-09-17 晚。工作方式：**每一条都自己复核一遍再改**，数字一律现场跑，不照抄审计报告。
本文件是这次修改的记录：**问题编号 / 原文 / 新文 / 核对命令 / 是否已改**。

---

## 0. 本次的基准（都是现场跑出来的，不是抄审计）

**核对窗口**：期间有另一个任务在并发改同一工作区（陪练角色改造 + 新增两只普通系宠物）。下面的数字是**我这次核对时点的实跑值**，过程中确实变过：测试数 257→255/2→257，引擎参考卡 41→43→44，规则页字符 4480→4440。**凡写进文档的数字都附了现场复算命令**，因为"人会漂，数字也会漂"。

| 事实 | 本次实跑值 | 命令 / 出处 |
|---|---|---|
| 自动化测试 | **tests 257 / pass 257 / fail 0** | `npm test`（核对过程中曾因并发改动短暂出现 255/2，最终全绿） |
| `reports/test-output.txt` | tests 251 / pass 251 / fail 0（mtime 22:04） | `tail -6 reports/test-output.txt` |
| 逐文件 | engine 10、rules 17、offline 5、mechanics 6、pvp 8、browser 5、features 24、coach 27、companion 17、strategist 24、server 11、opponent 27、knowledge 11、tests/evals/agent 37、tests/evals/regression 17、tests/evals/slow-model 6、wiring 3、tests/evals/player-copy 2（合计 257） | 逐个 `node --test <file> \| grep '^ℹ tests'` |
| 宠物 | **14 只**（新增 磐耳羊/普通、灵瞳猫/普通；此前 12） | `node --input-type=module -e "import {SPECIES} from './src/game/engine.js';console.log(SPECIES.length)"` |
| 技能 / 道具 / 携带物 / 关卡 / 难度 | 23 / 3 / 3 / 5 / 3 | `src/game/engine.js`、`src/game/content.js` |
| 属性 | 7 个（火水草普通岩雷风），两个独立三环，**同系 ×1** | `node -e "...E.multiplier('fire','fire')"` → 1 |
| 知识卡 | 49 战术卡 + 44 引擎参考卡（并发改动中，41→44） | `node -e "const t=require('./knowledge/tactics.json'),r=require('./knowledge/reference.generated.json');console.log(t.length,r.length)"` |
| 规则页 | 11 节 / 79 行正文 / 标题+正文 4440 字符（**随代码变动**） | `node -e "import('./src/game/rules.js').then(...)"`（命令写在 `docs/G08-RULES-IN-PLACE.md`） |
| 上下文预算 | 浏览器 `window=WORKING_CONTEXT(200000), output=OUTPUT_RESERVE(4096), system=4096, tools=2048`；服务端 `window=200000, output=320, reserve=1024`；`MODEL_CONTEXT=1000000` | `src/coach/runtime.js:179-186`、`src/server/token-budget-server.js:11-16` |
| 工具轮次 | **最多 3 次**（`limit=3`，循环上限 `Math.min(4,limit)`） | `src/coach/runtime.js:137,150` |
| CHECKLIST 未勾 / 已勾 | **9 / 139**（与审计一致，**勾选状态全程未动**） | `grep -c '^- \[ \]' docs/CHECKLIST.md` |
| balance-matrix.json | `generatedAt 13:12:52Z`、`durationMs 185314`、胜 1997 / 负 3764 / 平 35、`meanRounds 17.84`、`sd 8.119`、`capCount 18`、选择器 **1345 状态 / 96 次换宠 / mismatch 0**、`capRate>0` 的 arm **6 个** | `node -e "const j=require('./reports/balance-matrix.json');..."` |

**没有改动的东西（按任务要求）**：`report/`、`output/`、`docs/COMPANION-DESIGN.md`、`docs/COMPANION-IMPLEMENTATION.md`、所有游戏代码与测试断言（本次**一处测试断言都没改**）、`docs/CHECKLIST.md` 的复选框。

---

## 1. 逐条对照

> 状态标记：**已改** / **已改（部分）** / **不改（理由）** / **仅复核（审计判定正确、无需改动）** / **审计判定有误**

### F01 — 陪练主动气泡"没有调用点" — **已改（只改我能改的文件）**

| | |
|---|---|
| 位置 | `CHECKLIST.md` T05 注释；`COMPANION-DESIGN.md` 6 处、`COMPANION-IMPLEMENTATION.md` 3 处 |
| 复核命令 | `grep -n "notify" src/client/app.js` → `src/client/app.js:352: notify(ev);` + `src/client/app.js:369: function notify(event){...}`；`grep -n "companionEvents" src/client/app.js` → 导入 + `:350` 遍历；`tests/wiring.test.js` 把「陪练·主动气泡」列为必须接上的入口 |
| 结论 | **审计正确，实际已接线**。审计说"六处"里 `COMPANION-DESIGN.md:283` 已对、其余五处错——我复核后同意 |
| 原文（CHECKLIST T05） | 「**为什么不勾**：……而且主动通道在 `src/client/app.js` 里没有调用点（`notify()` 无调用处），气泡在真实 UI 中不会弹出。」 |
| 新文 | 「**当时为什么不勾**：T05 的验收口径包含真人语言评审（U07 当时未勾），本轮只有自动测试。⚠️ 原记录的后半句「主动通道……没有调用点」**当时就已不成立**：主动气泡是接线了的，`src/client/app.js` 里 `notify` 有定义也有调用……`tests/wiring.test.js` 把「陪练·主动气泡」列为必须接上的入口。」 |
| 状态 | `CHECKLIST.md` **已改**；`COMPANION-DESIGN.md` / `COMPANION-IMPLEMENTATION.md`（共 8 处）**跳过 — 文件被另一并发任务占用**，见第 2 节 |

### F02 — CHECKLIST G07 头部数字取自旧相克表那一轮 — **已改**

| | |
|---|---|
| 位置 | `docs/CHECKLIST.md` G07 的"头部数字"一行（原 142 行） |
| 复核命令 | 当前值：`node -e "const j=require('./reports/balance-matrix.json');const a=Object.values(j.arms);console.log(JSON.stringify(j.global),JSON.stringify(j.verification.chooserEquivalence))"`；旧值：`git show 3785cb4:reports/balance-matrix.json` |
| 结论 | **审计正确**。我逐项验了两轮：旧 JSON = 胜 1959/负 3817/平 20、17.567±7.308、`capCount 16`、选择器 1416/97、`capRate>0` 的 arm 恰好 4 个；当前 JSON = 胜 1997/负 3764/平 35、17.84±8.119、`capCount 18`、选择器 1345/96、6 个 arm。旧数字**逐项等于** `3785cb4` 那份 |
| 原文 | 「**胜 1959 / 负 3817 / 平 20**……全局回合数均值 **17.57**、标准差 7.31……**16 场打到 80 回合上限（全部判平局）、另有 4 场双方同时全灭的平局**，398 个 arm 里只有 4 个出现过上限平局……唯一统计显著的同属性失衡是雷系 **鸣电雀 vs 伏光貂**……**21.7% vs 55.0%，Δ−33.3pp，置信区间不重叠**……**1,416 个状态**……含 **97 次**实际换宠决策」 |
| 新文 | 先用当前 JSON 的数（1997/3764/35、17.84/8.119、18 场上限、35 平局、6 个 arm、鸣电雀 11.7% vs 伏光貂 20.0% = Δ−8.3pp 区间重叠、1,345 状态 / 96 次换宠），**再单列一条"原先引的是上一轮、已作废，保留仅供对照"**，把旧数字与 `3785cb4` 的 `generatedAt 11:27:10Z / durationMs 180635` 写清 |
| 状态 | **已改**（保留了旧值作为历史对照，没有删） |

### F03 — RAG 规则卡与引擎不符 — **开工前已由你修好，本次只补"测试没守住它"的记录**

| | |
|---|---|
| 复核命令 | `grep -n "七个技能属性" knowledge/tactics.json` → 卡片已写「当前有火、水、草、岩、雷、风七个技能属性，另有中性的普通系……环境机制是有的（细雨、山风……）」；`sed -n '272,290p' tests/rules.test.js` → `expected` 数组里只有 `克制1.5倍`、`中毒每次8伤害` 这类固定短语，**不含属性清单、也不含"没有天气"** |
| 结论 | **审计正确，且你已在 `2406bc6` 修好卡片正文**。我复核了产物三份（`knowledge/tactics.json`、`src/game/content.js` 的 `TACTIC_CARDS`、`knowledge/semantic-corpus.json`）都已是新文本 |
| 我做的补充 | 在 `docs/P05-RULES-SOURCE.md:119` 给"这条测试守住的是什么"加了边界说明：**它守的是数值短语，不守属性清单**，并写明这次漏网的经过与修复提交 |
| 状态 | 卡片本身**无需再改**；`P05-RULES-SOURCE.md` **已改**（补测试覆盖面缺口） |

### F04 — DIFFICULTY 说 A05 未勾 / 名称漂移未复验 / 第三层不存在 — **已改（第三层判为审计部分有误）**

| | |
|---|---|
| 复核命令 | `grep -n "A05" docs/CHECKLIST.md` → `35:- [x] A05 …`；`grep -n "item-name-drift\|causal-cancelled-action" src/coach/runtime.js` → `:219`、`:225`；`node -e "...require('./reports/live-model-eval.json').badAnswers"` → 无 `item-name-drift` |
| 结论 | **A05 与"名称漂移未复验"两处审计正确、已改**；**"第三层（未实现）"审计判定有误**——现在的 `item-name-drift` 是**写死的错名黑名单**（`解药\|解毒药\|以太\|回血药\|血瓶\|蓝瓶\|复活药\|清醒药`），不是"从规则数据源导出全部合法实体名再扫疑似实体词"，所以通用实体集合这一层**确实仍未实现** |
| 原文 | 「**名称约束补上之后尚未复验**……所以「名称漂移已经修好」这个说法在当前证据下不成立」「`docs/CHECKLIST.md:281` 明确：A05……**仍未勾**」「**第三层（未实现，是最该补的一层）**」 |
| 新文 | 前两条改为「当时……**2026-09-17 晚复核：已复验/A05 已勾选**」并给出测试名与轮次产物；第三条改为「**第三层（仍未实现）**……第二层新增的 `item-name-drift` 是这一层的**窄版**……『名称漂移完全没人管』现在不成立，而通用的实体集合校验确实还没有」 |
| 状态 | 前两条 **已改**；第三条 **已改（按复核后的措辞，不是照抄审计）** |

### F05 — 用户举的五个例子 — **仅复核，全部确认**

`COMPANION-DESIGN.md:10`「写作时 122、当前 251」在写作时正确（当前 257，已由本轮 F06 一并处理到其它文件）；`COACH-PLAN.md:17` 目标对照与代码一致；`DIFFICULTY:782` 小田改写正确、`docs/XIAOTIAN-RESEARCH.md` 存在（225 行）；`IMPLEMENTATION-STATUS:124` 的 v0.5 历史标注正确（我把里面的 12 宠/90 卡更新成了 14 宠与"随生成器重算"）。**状态：无需改动本项本身**。

### F06 — 测试数（127 / 122 / 191 / 177 / 249 / 114 / 100）— **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `IMPLEMENTATION-STATUS.md:6` | 「127项自动测试通过」 | 「**写作时为 127 项**……**已过时**：`reports/test-output.txt` 记录 251/251/0；本次核对现场 `npm test` 为 **257 项**」 | `npm test` |
| `EXPERIMENTS.md:60` | 「127项自动测试通过」 | 「**写作时为 127 项**……现场为 **257 项**」 | 同上 |
| `DIFFICULTY:6` | 「当前为 **127 项**（`reports/test-output.txt`）」 | 「写作时 122……此后 **127 → 251 → 257**；现场 `tests 257 / pass 257 / fail 0`」 | 同上 |
| `DIFFICULTY:681` | 「实跑 `npm test` → `tests 122 / pass 122 / fail 0`」 | 保留为"**当时**"，补「现在现场为 257 项」 | 同上 |
| `DIFFICULTY:11` | 「`reports/test-output.txt` ……（13:52，记录 114 项）」 | 补「该文件后来已被重写为 251/251/0（mtime 22:04，随 `50ec5fe` 入库）」 | `tail -6 reports/test-output.txt` |
| `P05:151,153` | 「191 通过」+ 逐文件分布合计 191 | 保留 191 为当时值，**补两行**：`reports/test-output.txt` = 251、现场 = 257；并点明原分布**漏了** strategist/opponent/wiring/evals/player-copy 四个文件；列出当前 18 个文件的逐文件数 | 逐个 `node --test` |
| `P05:162` | 注释「`npm test` # 全套 **189** 项」 | 「全套（本文原先写"189 项"，与上文 191 自相矛盾；当时实际 191，现在现场 257——以实跑输出为准）」 | `npm test` |
| `W10:58` | 「本轮改动后 191」 | 增加 251 与 257 两行，并注明 151 那行**未能核实** | 同上 |
| `CHECKLIST W12` | 「完整114项回归通过」 | 条目文字保留（`[x]` 不动），**新增注释**写明 114 → 251 → 257 的历史与现状 | `grep -n "W12" docs/CHECKLIST.md` |
| `CHECKLIST:334` | 「请求最多**两次**规划 + 一次生成」 | 「请求最多**三次**规划+一次生成（A10 把工具轮次由 2 提到 3）」 | `grep -n "limit=3" src/coach/runtime.js` |
| `CHECKLIST:118` | 「三轮数据见 `reports/live-model-eval.json`」 | 补：**该文件只存第 3 轮**（`unnecessaryToolCallRate 0.136`、`missedCallRate 0.7727`）；第 1 轮 `-before.json`（0.75/0）、第 2 轮 `-pass2.json`（0.3333/0.2188） | `node -e "...metrics"` |
| `reviews/2026-09-17-live-acceptance.md:30` | 「全套 **100** 项自动测试见 `reports/test-output.txt`」 | 「**该数字从未成立**：最早的 `reports/test-output.txt`（`git show e5417e8:...`）已经是 `tests 114`；该文件现在是 251/251/0」 | `git show e5417e8:reports/test-output.txt \| tail -6` |
| `report/sections/05-numbers.tex:19,65`「249 项」 | — | **不改 — `report/` 在禁改清单里** | 见第 2 节 |

### F07 — balance-matrix 耗时三个数 — **已改（文档侧）；生成产物侧不改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `CHECKLIST:140/141` | 「**181.6 秒**」×2 | 「**185.3 秒**（`durationMs` 185314）」；`reports/balance-matrix.md` 的大小也从「34.7KB」改为「58,229 字节 ≈ 56.9KB」 | `node -e "console.log(require('./reports/balance-matrix.json').durationMs)"`；`ls -la reports/balance-matrix.md` |
| `W10:21` | 「**180.6 秒**……（**16** 场到 80 回合上限）……（环境只有 **48** 场）」 | 改为 185.3 秒 / 18 场 / 24 场，并注明旧值来自被覆盖的 `3785cb4` 那份 JSON | 同上 |
| `reports/balance-matrix.md:6`（181.6s）与 `:10`（「G07 仍为未勾」） | — | **不改 — 见第 2 节**（生成产物） |
| `report/sections/05-numbers.tex:57` | — | **不改 — `report/` 禁改** | — |

### F08 — 环境维度 48 场 vs 24 场 — **已改**

| | |
|---|---|
| 复核命令 | `grep -n "24 场" reports/balance-matrix.md` → `:515`「只有 S8 的关卡 05（山风）带环境，两个臂、24 场」；S8 总数 = `grep -n "S8 关卡对照" reports/balance-matrix.md` → `:55` 的 48 场（2 阵容 × 2 关卡 × 12 种子） |
| 原文（G06:85） | 「只有 S8 的关卡 05（山风）带环境，**48 场**」 |
| 新文 | 引文改为「两个臂、**24 场**」，并单列一条 ⚠️ 引文更正说明 48 是 S8 总场次 |
| 原文（CHECKLIST:143/144） | 「环境维度几乎未覆盖（只有 S8 的关卡 05 山风 **48 场**）」「③ 环境维度只测了 **48 场**」 |
| 新文 | 均改为 **24 场**，并写明"两个臂 × 12 种子" |
| 状态 | **已改**（`CHECKLIST:141` 里"S8 关卡对照（48 场）"本来是对的，未动） |

### F09 — 规则页 4316 字符 — **已改（换了写法：不给会漂的绝对数当现状）**

| | |
|---|---|
| 复核命令 | `reports/p05-rules-browser-check.txt` → `"totalChars": 4316, "paragraphCount": 77, "sections": 11`；现场 `node -e "import('./src/game/rules.js').then(m=>{let t=0,c=0;for(const s of m.rulesSections()){t+=s.lines.length;c+=s.title.length+s.lines.join('').length}console.log(m.rulesSections().length,t,c)})"` |
| 结论 | **审计方向正确，但审计给的"4309"也不对**：我现场复算得到过 **4480**，几分钟后又变成 **4440**（并发改动）。所以任何写死的绝对数都会立刻过期 |
| 原文 | 「规则弹窗里生成 **11** 节、**77** 段、**4316** 字符」（`G08:53`、`P05:88`、`CHECKLIST:146/147`、`W10:70`） |
| 新文 | 保留 11 节 / 77 段 / 4316 字符为"**那次 DOM 快照的值**"，并写明它是 DOM `<p>` 计数；**再给出复算命令与写作时的现场值（11 节 / 79 行正文 / 标题+正文 4440 字符），并标注"这两个数随代码变动，务必现场跑"** |
| 状态 | **已改**（4 处：`CHECKLIST`、`G08`、`P05`、`W10`） |

### F10 — 抽查后仍正确的数字 — **仅复核**

复核了 90/92/93 卡的构成（现在是 49 + 44）、660 场、检索三组、四臂 128 条、干预 Q-learning、轨迹规模、工具路由 RL、五条真实调用的 token 差、裁剪实例 38 tokens、配招空间 C(6,4)=15、21+26 张截图。**除"知识卡数"因宠物扩展而变化（已按 F26 处理成"随生成器重算 + 复算命令"）外，其余仍正确。状态：除卡数外无需改动。**

### F11 — 上下文预算还写 32768 — **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `DIFFICULTY:593` | 「`window=32768, output=512, system=4096, tools=2048` → 可用预算 26112 字节」 | 「`window=200000（WORKING_CONTEXT）, output=4096（OUTPUT_RESERVE）, system=4096, tools=2048` → 可用预算约 189824 字节……**原写作 32768/512，是旧值**」 | `sed -n '179,186p' src/coach/runtime.js` |
| `DIFFICULTY:600` | 「`window=32768, output=320, reserve=1024`」 | 「`window=200000（WORKING_CONTEXT）, output=320, reserve=1024`（**原写作 32768，是旧值**）」 | `sed -n '11,16p' src/server/token-budget-server.js` |
| `DIFFICULTY:625`（两级预留口径） | 「浏览器侧预留 `output 512 + system 4096 + tools 2048 = 6656`」 | 改为 `output 4096 … = 10240` 并注明原值来自 32768 那一版 | 同上 |
| `EXPERIMENTS:50` | 「窗口32768，输出预留320，安全余量1024」 | 「**工作预算窗口 200000（`WORKING_CONTEXT`）**……**原写作 32768**」 | 同上 |
| `DEMO-ACCEPTANCE:35` | 「检查 **32K 装配用例**……预算目前是**保守 UTF-8 字节估计，不冒充 DeepSeek 精确 tokenizer**」 | 改为现场测试名「context assembly trims to an explicit budget…」；并写明**服务端走的是官方 tokenizer 精确计数**（`src/server/token-budget-server.js:10` 的注释），字节估计只剩浏览器侧第一级粗裁 | `grep -n "不是字节估算" src/server/token-budget-server.js` |
| `COACH-PLAN:95` 标题 | 「## 8 在 **32K** 上下文下工作」 | 「## 8 在 **200K 工作预算**下工作」+ 口径更正说明（引用第 2 节已有的"已被取代……工作预算改为 200K"） | `sed -n '17p' docs/COACH-PLAN.md` |
| `COACH-PLAN:99` | 「示例 **32K** 预算：……」 | 「示例 **200K（旧文写 32K）**预算……」并注明"这套分项是设计示意，不是代码里的实际切分" | 同上 |
| `RAG-LOCALIZATION:44` | 「外部记忆与 **32K** 测试」 | 「外部记忆与上下文预算测试（原文写"32K"，已过时……）」 | — |
| `DIFFICULTY:579` | 「32K 窗口听起来很宽」 | 「**工作预算 200K（`WORKING_CONTEXT`）**听起来很宽，但它的前身是 32K」 | — |

### F12 — 「最多两次规划工具调用」— **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `INTERVIEW-GUIDE:17` | 「当前最多**两次**规划工具调用」 | 「当前最多**三次**规划工具调用（`gatherAgentEvidence({limit=3})`；A10 后由 2 提到 3）」 | `grep -n "limit=3\|Math.min(4,limit)" src/coach/runtime.js` → `:137`、`:150` |
| `IMPLEMENTATION-STATUS:4` | 「**两步**按回执选工具」 | 「**最多三次**按回执选工具（A10 后由 2 提到 3）」 | 同上 |
| `CHECKLIST:334` | 「请求最多两次规划」 | 见 F06 表 | 同上 |

### F13 — 引擎机制描述仍正确 — **仅复核**

克制 1.5 / 抵抗 0.75 / 其余含同系 1、防御减伤 65%、碎岩/破甲穿透、强化每层 15% 最多 2 层、灼烧 6×2 中毒 8×3、环境 4 回合、速胜 10 回合、升级经验=等级×30、`EVIDENCE-SCHEMA` 的 matchId/epoch/journal 240 条等，逐条读了代码与 7 个属性的倍率表。**状态：无需改动。**

### F14 — EVIDENCE-SCHEMA 两处与实现不符 — **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `:26` | 「工具只读，固定白名单；search_rules只接受query，**其余工具参数为空**」 | 「**`search_rules` 只接受 `query`；`simulate_branch{actionIndex,opponentIndex}`、`read_match{offset,limit}`、`read_evidence{turn}` 也接受参数**（`src/coach/toolbox.js:15-24`……其余工具参数为空。原文与实现不符）」 | `sed -n '15,34p' src/coach/toolbox.js` |
| `:16` | 「hint：channel为inline、**attention**、endgame或watch」 | 改为 `inline`（`src/client/app.js:643`）/ `endgame`（`:721`）/ `watch`（`:830`）+ 动态 `role+'-'+reason`（`:497`），并写明 **`'attention'` 现在 0 命中**、基线 `e5417e8` 时存在 | `grep -rn "'attention'" src/client/app.js src/coach/ src/server/index.js` → 0 |

### F15 — 多份文档把已勾项写成"未勾/未完成" — **已改**

| 文档 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `CHECKLIST` 的 14 个 `[x]` 项注释 | 14 处仍写「仍未勾 / 未勾 / 不勾此项 / 未达成 / 未勾选」 | 逐处改为「**当时**仍未勾（该条此后已勾选，见上一条）」——**保留原记录不删，只把话说对**；涉及 P05、U07、T05、C05、S04、S05、G06、G07、G08、F07、V02、R10、C17、W10 | `awk '/^- \[[ x]\]/{...}' docs/CHECKLIST.md`（脚本见本文件第 3 节） |
| `CHECKLIST`「继续未勾的具体原因」 | 点名 19 项，其中 15 项后来已勾 | 重写为"**2026-09-17 晚更新**"：保留原句 + 每行补现状（~~已勾~~ / 仍未勾），末尾写「当前真正未勾只有 9 项」并列出 | `grep -c '^- \[ \]' docs/CHECKLIST.md` → 9 |
| `CHECKLIST`「未勾 8 项」标题 | 「未勾 **8** 项……这 8 项不会完成」 | 「未勾 **9** 项」，并说明原标题数错了（只数了 3+3+2，漏了第四节的 `R03`；`F01b` 也不在本节），现在 `S05` 已勾、本节实际未勾 8 项 + `F01b` = 9 | 同上 |
| `CHECKLIST:271` | 「RAG……因此 **A03 仍未勾**」 | 加「（**后续：A03 已勾选**）」 | `grep -n "^- \[x\] A03" docs/CHECKLIST.md` |
| `CHECKLIST:306` | 「神经语义检索、精确tokenizer、生产权威状态、LLM权重RL和独立大样本质量评测仍未完成」 | 加"现状更正"引用块：三项已落地（W03 / W04 / S04），**只剩 `生产权威状态` 与 `LLM权重RL` 两项** | `grep -n "^- \[x\] W03\|^- \[x\] W04\|^- \[x\] S04" docs/CHECKLIST.md` |
| `CHECKLIST` W10 两条注释 | 「PDF 未随本轮重新生成，这是当前唯一的交付面缺口」 | 加"**2026-09-17 晚复核：该缺口已关闭**——PDF 现 396,798 字节 / mtime 22:32；`report/sections/` 已重写" | `ls -la output/pdf/` |
| `DIFFICULTY:100/770` | 「长局浏览器真实触发**仍未完成**」「残局提示真实浏览器触发｜未完成（C17）」 | 改为"**当时**"，补「**C17 已勾选**（8 局长局、残局提示 8/8、26 张截图）」 | `grep -n "^- \[x\] C17" docs/CHECKLIST.md` |
| `DIFFICULTY:194/769` | 「S05……**仍是未勾项**」 | 改为"当时"，补「**S05 已勾选**；`W09` 仍未勾」 | `grep -n "^- \[x\] S05" docs/CHECKLIST.md` |
| `DIFFICULTY:335/768` | 「整局复盘质量未做独立评测（**S04 未勾**）」 | 改为"**该条已过时：S04 现已勾选**（三轮 132 次真实调用）" | `grep -n "^- \[x\] S04" docs/CHECKLIST.md` |
| `DIFFICULTY:775` | 「完整 3v3 配装与队伍组合平衡｜未完成（**G07**）」 | 改为「~~未完成~~ **已完成**……5,796 场 / 398 臂矩阵」 | `grep -n "^- \[x\] G07" docs/CHECKLIST.md` |
| `DIFFICULTY` 其它 4 处（`:148/:376/:445/:627`） | A05 未勾 / A04 未勾 / A03 未勾 / C05 保持未勾 | 逐处加"2026-09-17 晚复核：已勾选" | 同上 |
| `W10` 第一节表格 | 8 行写「未勾」 | 逐行加「（**现已勾选**）」 | 同上 |

**复选框本身一处没动**：`grep -c '^- \[ \]'` 与 `grep -c '^- \[x\]'` 在改动前后都是 **9 / 139**。

### F16 — W10-ACCEPTANCE-MAPPING 的 19 项 / PDF / test-output — **已改（含一处审计未列的算错）**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `:5,11,35,64,76` | 「仍为 **19 项未勾**」、自查命令注释「应为 19」 | 文首加**现状更正块**（19 → 9），正文逐处行内更正 | `grep -c '^- \[ \]' docs/CHECKLIST.md` |
| `:35` | 「其中 **6 项**（…列出 7 个名字）」 | 加「原句"6 项"与后面 7 个名字自相矛盾（实为 7 项）；这 7 项现在全部 `[x]`」 | 同上 |
| `:41` | 「规则数据源（P05）、规则页（G08）、语言评审（U07）**都不在报告正文里**」 | 加已过时说明 + 引 `report/sections/03-hard.tex:11/:52-62/:167-171` 的具体位置 | `grep -n "src/game/rules.js" report/sections/03-hard.tex` |
| `:42` | 「PDF **本轮未重新生成**」 | 加已过时说明（多次重生成；当前 396,798 字节、mtime 22:32） | `ls -la output/pdf/` |
| `:45,:51` | 「test-output.txt 本轮未改写」+ 待办第 3 条 | 加已过时说明（mtime 22:04、随 `50ec5fe` 入库、251/251/0），并标"待办第 3 条已完成" | `tail -6 reports/test-output.txt` |
| `:21` | 180.6 秒 / 34.7KB / 16 场 / 48 场 | 见 F07、F08 | — |
| `:18`（U07 行） | 「改了 5 处……报告 3 处未改」 | 改为「5 处替换串现存 4 处……原报的 3 处里 `src/coach/companion.js` 的两处已随重写消失，只剩 `src/coach/teacher.js:117` 与 `src/coach/experience.js:120`」 | `grep -rn "别等倒下再救" src/coach/teacher.js`；`grep -rn "先别只盯着回血" src/coach/experience.js` |
| `:57` | 基线表「151 / 151 通过 / 0 失败」 | 标注「**本文这一行未能核实**（需检出旧提交重跑）」 | 见第 4 节 |
| `CHECKLIST:322/:323`（W10 注释） | 「PDF 未随本轮重新生成，这是当前唯一的交付面缺口」 | 已过时更正（见 F15 表） | — |

### F16b — 两处文件归属错误 — **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `G06:91` | 「改的是 `scripts/build-knowledge.js` **前半段的 `STAGES` 手写前缀**」 | 「改的是 **`src/game/content.js` 手写前缀里的 `STAGES`**（`src/game/content.js:3`；`scripts/build-knowledge.js` 全文 25 行，里面**没有** `STAGES`/`grove`/`summit`）」 | `wc -l scripts/build-knowledge.js`；`grep -n "STAGES\|grove\|summit" scripts/build-knowledge.js` → 0 |
| `P05:140` | 表格行「`src/coach/strategist.js`｜`'回复药优先级4'` 之类出现在检索词里」 | 「**本条归属点错了文件**……`grep -rn "回复药优先级" src/coach/` → **0 命中**，该串实际在 `knowledge/tactics.json:91`」 | `grep -rn "回复药优先级" src/coach/ knowledge/tactics.json` |

### F16c — G06 引的校准数字早于相克表改动 — **已改**

| | |
|---|---|
| 原文（`G06:29`） | 「≤10 回合获胜 48 场全部来自第 1 关，第 4 关最快 15 回合、第 5 关最快 19 回合（超额培养队也是 0 场）」 |
| 新文 | 保留原数字，**加 ⚠️ 时序提醒**：该轮校准跑在相克表重写之前；用当前引擎复跑得 grove 16–17、summit 16、≤10 回合 0 场，**结论仍成立、数字已过时**；并补一句界面文案已改由 `ruleFacts().swiftTurnLimit` 生成 |
| 核对命令 | `grep -n "最快" reports/balance-calibration-summary.md`；`grep -n "swiftTurnLimit" src/client/app.js` |
| 附带 | `CHECKLIST:138` 与 `:140` 也引了同一组数字，同样加了时序提醒 |
| 状态 | **已改** |

### F17 — 被引用的测试名/文件归属 — **已改（10 行逐条）**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `DIFFICULTY:618`、`CHECKLIST:91` | 「**32K assembly handles huge history, preserves exact current facts and does not mutate archive**」 | 改为真名「**context assembly trims to an explicit budget, preserves current facts and does not mutate the archive**」，并注明原名的存在与改名事实 | `sed -n '24p' tests/evals/agent.test.js` |
| `DIFFICULTY:513` | 「`docs/COACH-PLAN.md:78`：『明确不是训练敌方电脑……』」 | 改为「**属错误引用**：该句不在 `COACH-PLAN.md`（全文 grep「敌方电脑」无命中），实际出自 `docs/CHECKLIST.md` 的 R01 行」 | `grep -n "敌方电脑" docs/COACH-PLAN.md docs/CHECKLIST.md` |
| `DIFFICULTY:397` | 「`docs/reviews/2026-09-17-diagnosis-response.md:26`」 | 改为 `:25`，注明是**行号笔误**（该文件自入库未被改过） | `sed -n '25p' docs/reviews/2026-09-17-diagnosis-response.md` |
| `INTERVIEW-DRILL:51` | 「六条退出路径（`tests/evals/agent.test.js` 覆盖）……断言了 `search_rules → compare_actions → read_state`」 | 「**"六条"已过时**：现在有 **12 种 `stopped` 值**；该断言在 **`tests/coach.test.js:61`**（本文原写 `tests/evals/agent.test.js`）」 | `grep -c "search_rules\|compare_actions" tests/evals/agent.test.js` → **0**；`sed -n '61p' tests/coach.test.js` |
| `CHECKLIST:118` | 「三轮数据见 `reports/live-model-eval.json`」 | 见 F06 表 | `node -e "...unnecessaryToolCallRate"` |
| `INTERVIEW-DRILL:40,:57` | 「44 条真实调用、首选工具正确率 **90.63%**、严格正确率 31.25%→50.00%」并列 | 拆开写：**90.63% 是改前值，改后 78.13%**（"预期应调且确实调了"的 12 条上是 12/12）；并注明"把 90.63% 当当前值是错的" | `sed -n '41p' reports/live-model-eval-before-after.md` |
| `INTERVIEW-DRILL:74` | 「混合（**词项+语义 RRF**）90.18%」 | 改为「**已上线的 `searchKnowledge`：IDF 词项 + 领域概念扩展**（`src/coach/strategist.js:73` 自报 `method`）90.18%」，并注明 RRF 只在语义那一轮的 `fusion` 臂 | `grep -n "method:" src/coach/strategist.js` |
| `P05:140` | 见 F16b | 同 | `grep -rn "回复药优先级" src/coach/` → 0 |
| `P05:76` | 引 `tests/browser.test.js`「`the server allowlist covers every browser module`」 | 补全为「… **plus the page shell**」，标注"本文原引的是前缀、未加省略号" | `sed -n '42p' tests/browser.test.js` |
| `LANGUAGE-REVIEW:112` | 「`src/coach/strategist.js:100` 与 **`src/coach/runtime.js`** 的模型约束」 | 改为 **`src/coach/client.js:3`** 的 `RESPONSE_INSTRUCTIONS`（`src/coach/runtime.js` 里 0 命中） | `grep -n "不要向玩家报内部局面评分" src/coach/client.js src/coach/runtime.js` |
| `INTERVIEW-DRILL:34` | 「**`src/coach/client.js`** 的 `checkGroundedAnswer`」 | 改为「定义在 **`src/coach/runtime.js:207`**；`src/coach/client.js:4` 只是 import、`:29` 调用」 | `grep -n "checkGroundedAnswer" src/coach/runtime.js src/coach/client.js` |

### F18 — 被引用的路径与命令全部存在 — **仅复核**（抽查 `scripts/` 与 `reports/` 产物存在性，未发现反例）

### F19 — "零命中"复查命令不再零命中 — **已改**

| | |
|---|---|
| 原文（`LANGUAGE-REVIEW:127,147`；`CHECKLIST:58`） | 「全库检索 `你应该 / 你必须 / 你最好 / 下次别 / 别再 / 不要再`：**0 命中**」＋命令注释「期望 0 命中」 |
| 现场实跑 | `grep -rn "你应该\|你必须\|你最好\|下次别\|别再\|不要再" src/client/app.js src/client/index.html src/coach/*.js` → **3 处**：`src/coach/companion.js:243`（`PREACH` 黑名单正则）、`src/coach/experience.js:190`（注释）、`src/coach/teacher.js:40`（注释） |
| 新文 | 改为「写作时 0 命中；**2026-09-17 实跑为 3 处命中，全在注释/黑名单检测器里**」，并保留实质结论「**玩家可见文案里 0 命中仍成立**」；命令注释同步改写 |
| 状态 | **已改**（`LANGUAGE-REVIEW` 表格 + 命令块 + `CHECKLIST:58`）；第二条命令仍只命中检测器（`src/coach/companion.js:259`），如实保留 |

### F20 — 评审规模"约 960 处" — **已改**

| | |
|---|---|
| 原文 | 「`src/client/app.js` **247** 条、`src/coach/*.js` 合计 **420** 条、`src/game/engine.js` **160** 条、`src/client/index.html` 118 处 + 18 个属性值，合计约 **960** 处」 |
| 现场实跑（文档自带的命令） | `src/client/app.js` **254**、`src/game/engine.js` **166**、`src/coach/*.js` **512**（用 `node /tmp/count-cn.cjs`，脚本内容就是文档第六节那条） |
| 新文 | 保留旧数字并标注为旧值，写入现场值；**`src/game/engine.js` 的 160 仍正确**这一条也写明 |
| `src/client/index.html` 的 118 | **未能复现**（文档没给计数方法，审计也没复现出来）→ 在报告里列为"未核实"，文档里保留原数与"方法未给出"的说明 |
| 状态 | **已改**（`LANGUAGE-REVIEW` 文首 + 命令块 + `CHECKLIST:58`） |

### F21 — 「改 5 处」作为当前陈述不成立 — **已改**

| | |
|---|---|
| 原文 | 「最终结果：**改 5 处**、报告 3 处未改……第 3 处改为『…先比较对方留场和换宠两种分支。』」 |
| 现场实跑 | `grep -n "先比较对方留场和换宠两种分支" src/client/app.js` → **0 命中**；`src/client/app.js` 现在是「…先看对手是留在场上还是换人。」（被 `b2cd1f6` 改掉）。另外 4 处替换串仍在 |
| 新文 | 在"最终结果"后加复核块：说明第 3 处的字面已被替换；改动 3 的表格行与命令块分别加注与修正 |
| 状态 | **已改** |

### F22 — 「玩家可见的问句只剩 3 类」不成立 — **已改**

| | |
|---|---|
| 原文 | 「玩家可见的问句只剩 3 类：首次偏好选择、场景设置、小测题目，均属必要交互」 |
| 新文 | 「改后**部分**达标……**这个断言不成立**：至少还有 `src/client/app.js` 的『离开会结束本次训练且没有奖励，返回营地吗？』与 `src/coach/companion.js` 的『这句我还没接准。你说的是哪一处？』，两处在评审当时（`3db30c5`）就已存在，属漏检」，并保留"2 处多余反问已改陈述" |
| 状态 | **已改** |

### F23 — §A 引的"HEAD 版本"文本在 HEAD 里不存在 — **已改**

| | |
|---|---|
| 原文 | 「### A. `src/coach/companion.js`（**HEAD 版本**）· 空泛安慰 + 无依据的断言」＋三段代码 |
| 新文 | 在标题下加复核块：三段在写入本文档的提交 `3db30c5` 里 `grep -c` 均为 0，只存在于其**父提交**——"（HEAD 版本）"这个标注是错的；`:84` 提到的 `companionFacts`/`decideRegister`/`checkCompanionRestraint` **已经存在**（现场行号为 `src/coach/companion.js:44/:115/:250`，不是审计写的 39/110/230） |
| 核对命令 | `git show 3db30c5:coach/companion.js \| grep -c "可以先缓一缓"`；`grep -n "export function companionFacts\|export function decideRegister\|export function checkCompanionRestraint" src/coach/companion.js` |
| 状态 | 另在第二节抬头补「A 的三段引用在当前 HEAD 里都不存在；**B、C 两处仍在**（行号漂移到 `src/coach/teacher.js:117`、`src/coach/experience.js:120`）」 |

### F24 — RAG-LOCALIZATION 整份"当前落地"过时 — **已改（7 处）**

| 行 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `:3` | 「**当前交付**：……**尚未接入线上聊天/自动提示**」 | 删除线 + 文首"现状更正"块：检索**早已接入**军师与局内提示（`src/client/app.js` import `src/coach/strategist.js`） | `grep -n "strategist" src/client/app.js` |
| `:13` | 「`knowledge/tactics.json`：**11 张卡**」 | 「**49 张卡**（原文 11，后来依次扩到 30、45、49）」 | `node -e "console.log(require('./knowledge/tactics.json').length)"` |
| `:15` | 「`src/coach/retrieval.js`：中文双字切分……」 | 「**该文件现在只有 2 行**（转发到 `src/coach/strategist.js`），行为描述正确但**归属错了文件**」 | `wc -l src/coach/retrieval.js` → 2 |
| `:17,:19` | 「`tests/knowledge.test.js`：**6 个测试**」「当前 **6 项通过**」 | 均改为 **11**，并列出多出的覆盖面 | `node --test tests/knowledge.test.js \| grep '^ℹ tests'` → 11 |
| `:39` | 「当前卡片的 `requiredEvidence` 是文字声明。**下一步**转为明确字段」 | 改为「~~下一步~~ **已做**」＋现状：**全部卡都带 `conditions` 数组**（现场 93/93）、`applicability()` 返回三态、`src/coach/runtime.js` 在给模型前剔掉 `conditions-not-met` | `node -e "[...require('./knowledge/tactics.json'),...require('./knowledge/reference.generated.json')].filter(c=>Array.isArray(c.conditions)).length"` |
| `:44` | 「外部记忆与 **32K 测试**」 | 改为「上下文预算测试」（写明现为 200K） | `src/coach/runtime.js:186` |
| `:63` | 「知识卡扩至 **30 张**……**真实 DeepSeek 质量尚未测量**」 | 「**现为 49 张战术卡 + 引擎参考卡**」「**已测量**（三轮 132 次真实调用）」；"实现移至 `src/coach/strategist.js`、`src/coach/retrieval.js` 保留兼容导出"仍正确并补上"现在只有 2 行" | 同 `:13` |
| `:69` | 「下一步优先对 **30 张**……并将固定检索**升级为有界工具选择**」 | 改为 49 张；「**有界工具选择已实现**（最多 3 次工具调用 + 适用条件执行校验）」；并保留"单纯增加知识数量无法证明增益"这一仍然成立的结论 | `src/coach/runtime.js:137` |

### F25 — README「8 只基础伙伴与 4 只战术伙伴分组展示」— **已改**

| | |
|---|---|
| 原文（`README.md:57`） | 「配招位于培养栏折叠项；不花训练点，下一场生效。**8只基础伙伴与4只战术伙伴分组展示**，均可直接体验。」 |
| 新文 | 改为「**全部伙伴按属性筛选展示**（营地与出征页都走 `filteredSpecies()` + `renderTypeFilter()`）」，并加更正块说明：该分组在 **`cf841c6`（2026-09-17 14:32）删除**，提交信息写明它 "read as a gameplay distinction that does not exist"；营地导航现在是 `aria-label="按属性筛选伙伴"`；伙伴数已 12 → **14** |
| 核对命令 | `git log -S"战术伙伴" -- app.js index.html README.md`；`grep -rn "战术伙伴\|基础伙伴" src/client/app.js src/client/index.html` → 0 |
| 状态 | **已改** |

### F26 — README 其余声明仍正确 — **仅复核（除宠物数与卡片数）**

复核了 UI v0.11 / 规则 v0.6 / 5 关 / 3 档难度 / 脚本存在性 / 240 条教练事件 / 6 选 4 / 携带物 / 语音停用 / 1152 参数。**其中"12 只宠物"与"90 条本地知识"随本轮宠物扩展变化**：已把 `README.md:3` 与 `docs/README.md:3` 改成 **14 宠**、卡片数改成"49 张战术卡 + 由引擎生成的参考卡（原 41，随生成器重算）"并附复算命令。

### F27 — GAME-EXPANSION-PROPOSAL 的"尚未实现"整体过时 — **已改**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `:3` | 「**驱散强化**/蓄电特性等提案尚未实现」 | 抬头加"2026-09-17 现状更正"块：**驱散已实现**（`SKILLS.dispel`，破势；**现场 14 只宠里 13 只 learnset 带 `dispel`**），并列出其余已实现项 | `node --input-type=module -e "import {SPECIES} from './src/game/engine.js';console.log(SPECIES.filter(s=>s.learnset.includes('dispel')).length)"` → 13 |
| `:68` | 「同系关系与现有实现**需统一决策**」 | 「**已决策并落地**：`src/game/engine.js:90-98` 两个独立三环 + **同系 ×1**」；并写明**上文提的"交叉克制"最终没有采用**（环间中性） | `node -e "...multiplier('fire','fire')"` → 1 |
| `:144` | 「宠物、倍率、属性表、环境和关卡均为设计提议，**尚未实现或验证**」 | 改为"**当时**均为设计提议……**这四项现在都已实现**（14 宠、1.5/0.75、两个三环、细雨/山风、5 关）"，并保留真正的限定：**"已实现"不等于"已验证平衡"** | `node -e "console.log(require('./src/game/content.js'))"`（STAGES 5 个） |

### F28 — P05/G08 的"硬编码副本"清单仍正确 — **仅复核**（`src/coach/runtime.js` 的 `energyLimit:6`、`src/coach/experience.js` 的「额外回2豆」「等回合末回1豆」、`src/coach/teacher.js` 的「生命 +12 / 攻击 +4 / 速度 +3」三处都还在，逐条 grep 命中）

### F29 — DEMO-WALKTHROUGH 两处被后续提交作废 — **已改（只改文档）**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `:56` | 「四项加点（耐久/力量/敏捷）」 | 改为「**三项加点**（耐久/力量/敏捷）」＋更正说明：`src/game/progression.js:4` 的 `TRAINING` 只有 3 项；**该句由 `scripts/build-demo.mjs:489` 的 `expect` 硬编码，重跑脚本会把错误再生成一次** | `node --input-type=module -e "import {TRAINING} from './src/game/progression.js';console.log(Object.keys(TRAINING))"` → 3 |
| `:57` | 「点击第 2 只伙伴的「培养」后，右栏培养面板**没有变化**……（src/client/app.js 第 38 行）」 | 保留原观察并加更正：该行为在生成后约 1 分钟被 `d4ecd67` 修掉，现在 `src/client/app.js:50` 是 `…showCamp();cultivation();`，面板会重绘；这段文字在 `build-demo.mjs:486` 是运行期分支，重跑会输出另一条正确分支 | `sed -n '50p' src/client/app.js` |
| `:256` | 「脚本只写 `output/demo/` 与 `docs/DEMO-WALKTHROUGH.md`，不修改任何现有源码」 | 「……**并会创建/清理 `tmp/demo-profile`**（`build-demo.mjs:922-923`）」 | `grep -n "tmp/demo-profile" scripts/build-demo.mjs` |
| `:204` | 「AI 对手……『已独立出招（看不到你的选择）』」 | 加"轻微过时"：该面板后来改成毛玻璃遮挡（`src/client/app.js:311-314`、`0781da2`） | `sed -n '311,314p' src/client/app.js` |
| 其余（生成时间、8765、v0.11、视口、21 张截图等） | — | 审计说仍正确，我抽查了生成时间与截图数，**未动** | — |

**注**：`scripts/build-demo.mjs` 里那两处硬编码/分支我**没有改**（属代码，且本任务限定"改文档不改代码"）——下一次重跑脚本时，"四项加点"会原样再生成，这是已知的待修项。

### F30 — 行号漂移 — **已改（按"引用格式问题"处理，没有逐行重写）**

| | |
|---|---|
| 原文 | `DIFFICULTY:11`「本文所有行号与该提交一致」+ 大量 `docs/CHECKLIST.md:NNN` 引用 |
| 新文 | 在 `DIFFICULTY:11` 的基线块加一条 ⚠️ 提示：**CHECKLIST 此后被大量追加，本文所有 `docs/CHECKLIST.md:NNN` 现在都指向别的行，请按条目编号（A05 / C05 / G07 / S04…）检索**。同时把已经明显指错的几处（`:55`→T01、`:70-71`→C05、`:205`→E05、`:210`→A03、`:281`→A05/A04、`:275`→W12）改成"按条目编号引用" |
| 核对命令 | `sed -n '281p' docs/CHECKLIST.md`（现在是 N05，不是 A05） |
| 状态 | **已改**；其余几十处仍按 `849e131` 的旧行号，但已被文首提示覆盖（这是审计建议的处理方式：当"引用格式"问题，不当"内容"问题） |

### F31 — S05-W09-SLOW-MODEL — **仅复核**（六条测试名与断言逐条比对 `tests/evals/slow-model.test.js`，仍吻合；未改动）

### F32 — XIAOTIAN-RESEARCH — **仅复核**（`src/coach/companion.js` 行数、`companionEvents` 触发点、R2 档位、5 个门控逐条核对；未改动。**注**：该文件正确地说主动气泡会触发，而它指向的 `COMPANION-DESIGN.md` / `COMPANION-IMPLEMENTATION.md` 当时是错的——见 F01，本次跳过）

### F33 — 其余文档 — **已改（4 处）**

| 位置 | 原文 | 新文 | 核对命令 |
|---|---|---|---|
| `RESEARCH-NOTES.md:41` | 「小芽**还需自行实现**证据 ID、版本与删除同步」 | 「**2026-09-17 更正：这三项都已实现**」+ 三处代码位置（`src/coach/runtime.js:16`、`src/coach/experience.js:153-154`、`src/coach/memory.js:126-129`）与断言 | `grep -n "deleteMemoryEvidence" src/coach/memory.js` |
| `INTERVIEW-GUIDE.md:47` | 「## **v0.10** 更值得被追问的数字」 | 「## **v0.11** …（原标题写的是 v0.10，当时仓库已是 v0.11……标题已改，下面四个数字经复核仍正确）」 | `grep -n "0.11" src/server/index.js README.md docs/README.md` |
| `reviews/2026-09-17-live-acceptance.md:3` | 「UI v0.9；运行后端 v0.8」 | 加"当时"与已过时说明（现在都是 v0.11，`src/server/index.js:69` 是 `'0.11'`）；并在文首列出语音停用、100 项错引、首次倒下气泡三处更正 | `grep -n "runtimeVersion" src/server/index.js` |
| `reviews/2026-09-17-diagnosis-response.md:9/:12/:33` | 「runtimeVersion=**0.8**」「**不再叠加**无信息的首次倒下安慰气泡」「v0.8 真实 DeepSeek 复盘质量仍待……验证」 | 逐处加"2026-09-17 晚更正"：runtimeVersion 现为 0.11；首次倒下气泡**现在存在且已接线**（只是改成引用真实事实）；复盘质量**其后已测**（`live-model-v08/v10`、三轮 132 次调用） | `grep -n "notify" src/client/app.js`；`ls reports/live-model-v08.json reports/live-model-v10.json` |

---

## 2. 明确"不改"的条目与理由

| 条目 | 位置 | 为什么没改 |
|---|---|---|
| **F01 的 8 处** | `docs/COMPANION-DESIGN.md:32/:105/:293/:485/:542/:645`、`docs/COMPANION-IMPLEMENTATION.md:20/:170/:218` | **任务明确要求跳过**——另一并发任务正在改这两个文件。**我本想改的处**：把这 8 处"陪练主动气泡没有调用点"改成"已接线（`src/client/app.js` 的 `notify(ev)`；`tests/wiring.test.js` 把它列为必须接上的入口）"，并把 `COMPANION-IMPLEMENTATION.md` 的测试数 177→257、`tests/companion.test.js` 12 条→**17 条**、`COMPANION-DESIGN.md:29/:154/:195` 的 12 条→17 条一起更新。**建议由占用这两个文件的任务或下一轮补上。** |
| **F07 的 `reports/balance-matrix.md:6/:10`** | 「耗时 181.6 s …… `durationMs` = 181586」「G07 **仍为未勾**」 | 该文件是 `scripts/eval-balance-matrix.js` 的**生成产物**。它描述的是自己那一轮（12:48）的运行，对它自己而言是自洽的；真正的问题是"JSON 被 13:12 那一轮覆盖后 md 没重生成"。**手改生成物会在下次重跑时被抹掉**，正确修法是重跑 `node scripts/eval-balance-matrix.js`（本机数分钟）。已在 `CHECKLIST`、`W10`、`G06` 三处文档里把引用改成当前 JSON 的值。 |
| **F06/F07 的 `report/sections/05-numbers.tex`** | 「自动测试 **249** 项」（`:19,:65`）、「181.6 秒」（`:57`） | **`report/` 在禁改清单里。** 这是本次唯一**已知但仍存在**的数字不一致。 |
| **F20 的 `src/client/index.html` 118 处** | `LANGUAGE-REVIEW.md:7` | **未能复现**：文档没给这个数的计数方法，我按"汉字 run"数得到 145，与 118 对不上。已在文档里标注"方法未给出、未能复现"，没有用一个自己编的口径替换它。 |
| **F29 的生成脚本** | `scripts/build-demo.mjs:489/:486` | 属**代码**，任务限定"改文档不改代码"。已把"重跑会再生成这个错误"写进 `DEMO-WALKTHROUGH.md`，作为待修项暴露出来。 |
| **F16 `:57` 的「151 / 151」** | `W10-ACCEPTANCE-MAPPING.md:57` | **未能核实**（需要 `git stash` / 检出旧提交重跑，会动工作区且有并发任务在跑）。已在文档里就地标注"本文这一行未能核实"。 |

---

## 3. 复核用的两条脚本

```bash
# 1) 找出"已勾选、注释写着未勾、但没标明这是当时状态"的清单项
#    （改写后命中 0；改写前命中 14 项）
awk '
/^- \[[ x]\]/ { itemline=NR; item=$0; sub(/^- \[[ x]\] /,"",item); sub(/[ 　].*/,"",item); checked=($0 ~ /^- \[x\]/) }
/^ +- / { if (checked && ($0 ~ /不勾|未勾/) && ($0 !~ /当时|现已|此后|现在|已勾选/)) print "item "itemline" ("item") -> line "NR": "substr($0,1,70) }
' docs/CHECKLIST.md

# 注意：上面这条**不筛掉**形如"当时仍未勾（该条此后已勾选）"的行——那是本次故意保留的历史记录。
# 所以"命中 0"只说明"没有未标注的陈旧注释"，不说明"文件里不再出现'未勾'三个字"。

# 2) 勾选状态未被改动（本次修复前后都应是 9 / 139）
echo "unchecked=$(grep -c '^- \[ \]' docs/CHECKLIST.md) checked=$(grep -c '^- \[x\]' docs/CHECKLIST.md)"
```

---

## 4. 本次**没能现场核实**的数字（及核实需要什么）

| 事项 | 为什么没核实 | 需要什么 |
|---|---|---|
| `report/sections/05-numbers.tex` 写的 249 项、181.6 秒 | `report/` 禁改，只读了源码文本 | 允许改 `report/` 后同步为现场值（当前 257 / 185.3 秒） |
| `W10:57` 的「改动前 151 项全绿」 | 要 `git stash` 或检出 `849e131` 之前的提交重跑，会动工作区，且期间有并发任务在写 | 一个干净的工作区 + `git checkout <旧提交> && npm test` |
| `P05:127`「把 `RULES.guard.reduction` 从 .65 改成 .6，会有 4 项测试同时失败」 | 需要临时改 `src/game/engine.js` 常量再跑，属改代码 | 临时改常量跑 `npm run test:rules` 再改回 |
| `src/client/index.html` 的「118 处中文文本片段」 | 文档没给计数方法；我按"汉字 run"得到 145 | 原作者补上当时的命令 |
| `output/pdf/xiaoya-coach-report.pdf` 的**正文内容**（它写的是哪一版测试数） | 子集化 CJK 字体，纯文本抽取不可靠；本次只核到文件元信息（396,798 字节、mtime 22:32） | `pdftotext` / `pdftoppm` 逐页读，或直接看 `report/` 源 |
| `reports/intervention.json` 的 `rewardAudits` 四行与轨迹字节数 | 未重跑训练（要跑 `npm run train:intervention`） | 重跑训练 |
| `reports/tool-router-rl.json` 的 750 行轨迹与检查点 | 未重跑训练（要 `.venv-agent/bin/python scripts/train-tool-router.py`） | 重跑训练 |
| 所有需要真实 API 额度的数字（44 条 S04 的逐条指标、五条 v0.10 调用的延迟与 token 差、$0.0335 成本、p50/p90） | 本次不消耗 API 额度 | 用已连接密钥跑 `node scripts/eval-live-s04.js` 并重跑 `scripts/analyze-live-eval.js` |
| 浏览器侧实测（规则弹窗当前的真实 DOM 段数/字符数、五种视口走查、21 张截图内容） | 需要 8765 在跑 + headless Chrome，本次只核对保存下来的产物（`reports/p05-rules-browser-check.txt` 记录的是 19:21 那次） | 服务在跑时执行 `node scripts/cdp-rules-check.js`、`node scripts/cdp-long-game.js`、`node scripts/browser-smoke.mjs` |
| 外部世界事实（小田 2026-05-28 上线、灵宝发布会数字） | 仓库外事实，本次未联网 | 复查 `docs/XIAOTIAN-RESEARCH.md` / `docs/LINGBAO-RESEARCH.md` 里列的原始链接 |
| `docs/CHECKLIST.md` 的行号引用（`DIFFICULTY` 里几十处） | 只改了明显指错的几处；逐行重定位要对着 `849e131` 全量重算 | 一个"引用按条目 ID 而非行号"的统一改写 |

---

## 5. 结论

- **审计的判定绝大多数正确**：43 条里我复核后认定需要改的，除下面几条外都改了。
- **审计判错/判偏的 3 处**（已按复核后的措辞写，没有照抄）：
  1. **F04 的 `DIFFICULTY:738`「第三层（未实现）」**：审计把它算进"已过时"，但现在的 `item-name-drift` 是硬编码错名黑名单，不是"从规则数据源导出全部合法实体名"。**这一层确实仍未实现**，我保留了"未实现"并补上"窄版已做"。
  2. **F09 的 `4309`**：审计给的替换值（标题+正文 4309）我现场复算对不上（先得 4480、几分钟后 4440，并发改动中）。**把任何一个写死的数当"现值"都会立刻过期**，所以我改成"快照值 + 复算命令 + 现场值并标注会漂"。
  3. **F23 的行号**：审计给的 `src/coach/companion.js:39/:110/:230` 与现场不符（实际 `:44/:115/:250`）；我用现场值。
- **另有 1 处审计未列、我顺手修了的**：`W10:35` 那句"其中 6 项（…7 个名字）"的内部矛盾（审计在 F16 里提到了它，但归在"19 项未勾"那条下）。
- **本次没有改任何代码，也没有改任何测试断言**（任务允许的唯一例外没有用到）。
