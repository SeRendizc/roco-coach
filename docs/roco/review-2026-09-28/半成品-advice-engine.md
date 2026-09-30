# 半成品排查 · advice-engine（coach 层 `src/coach/**`）

**审的是哪一版**：HEAD `51c04fb1488c` + WIP（**只读**，本次一个字没改 ✓）
**范围**：`src/coach/**` 共 50 个文件；**逐文件 hash 见本文末**（审前记录 ✓）
**口径**：任务书 §0 的六形态 ⓐ–ⓕ；**"完成"要五条齐**（能跑通 / 判据绿 / 运行时报据 / 反证 / 对照实验）
**审计边界（如实）**：下面每条都带**我实际跑的命令或读到的行** ✓；**没读到的文件我列在"未审"里，不猜** ✗

## 一张表

| # | 模块/文件:行 | 现象（一句话） | 证据（逐字/读数） | 判定 | 修复成本 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `src/coach/roco-client.js:996,1053` | **工具描述说 `evaluate_team` 未实现**，但引擎实测**能算** | 逐字：`description: '队伍强度评估。引擎逻辑未实现（缺官方伤害公式与等级→面板换算），当前返回 not_implemented。'`；而实测回执 `ok=true · coverage=1 · evidence_ids=3 · engine_latency=3.15ms`（`tmp/training-prep/three-receipts.json`） | **半成品（ⓓ 占位/过时文案）** —— 会**误导模型不调它** | 低（改一段文案 + 补判据） | **高** |
| 2 | `src/client/team-workshop.js:1770` | `state.evalOpponent` **只被读、从不被赋值** ⇒ 「针对某个对手」那一整套判断**恒不触发** | 命令：`grep -n "evalOpponent" src/client/team-workshop.js` ⇒ **只有 1 处**（第 1770 行的读）；`team-plan.js` 里 `opponent` 为 null 时如实退化成"要指定对手才说" ⇒ 玩家**永远看不到**对手口径的强度判断/克制招/最怕什么 | **半成品（ⓑ 恒不触发）** | 中（页面给个选对手入口 + 一行接线） | **高** |
| 3 | ~~`src/coach/intervention-model.js:38,62,70` 三个导出外部读点 0~~ **【本条已撤回 ✗ 见文末更正】** | ~~ⓐ 写了没人读~~ | 我第一版只 grep 了 `src/coach` + `src/client` ⇒ **漏了 `scripts/`** ✗。**重扫（含 scripts/ 与 tests/）**：`interventionModelMode` **14** · `isValidInterventionModel` **3** · `loadInterventionModel` **12** · `interventionModelDecision` **12** ⇒ **不是死代码** ✓；只剩 `INTERVENTION_MODEL` 外部读点 **0**，但它在**本文件 :85** 被用 ⇒ **过度导出**（不是ⓐ） | **改判：过度导出（低危）** | 低（去掉 export 或加注） | **低** |
| 4 | `src/coach/nature-advice.js:112-116` | 天分/性格缺失时**按 0/中性参与面板计算**，只在 `caveats` 里提一句 | 逐字：`caveats.push(\`${label}的天分是 0（缺数值时的占位）⇒ 天分那一半比不出高低\`)` 之后**照常** `panelOf({race, talent: a.talent, nature: a.nature})` 并给出对比结论 | **半成品（ⓓ 缺值当默认值参与判断）** | 低（缺值就只比另一半，或明写"这一半不比"） | 中 |
| 5 | `src/coach/team-gaps.js:151,949,979` | 「第一回合能不能出手」被**占位值/工程假设**挡住 | 逐字：`入场初始能量还是占位值时，第一回合能做什么无法判定` · `未核实：能耗能不能付得起——入场初始能量是占位值，回能是工程假设` | **未实现（如实报不支持 ✓ 不算半成品）** | 中（等 microcase） | 中 |
| 6 | `src/coach/team-plan.js`（判断层） | 判断层读的是**注入的真数据**（属性相性函数/能耗/速度/真实学招表），**依据链逐条在回执里** | `evidence` 字段逐字：`attackElements / sharedWeaknesses / matchup / energy`；反证脚本 `tmp/r02-r03/verify.mjs` **exit 0**（含"未结算效果不许当能力"三类反证） | **已完成（在它拿到的输入范围内 ✓）** —— 但上限被 #2 压住 | — | — |
| 7 | `src/coach/memory.js` | 抽样 10 个记忆键**都有读点**（未见 ⓐ） | 命令 + 计数：`turnLog 4 · journal 18 · reflections 6 · watches 9 · stated 11 · mood 3 · quizLog 5 · habits 2 · skill 45 · acceptance 1 · lastTopic 28`（`grep -rn "memory\.<k>" src/coach src/client`） | **抽样未见半成品**（不是全量结论） | — | — |
| 8 | `src/coach/teacher-review.js` | 「猜的归因」按词表扫**0 命中** | 命令：`grep -n "白送\|击倒\|失误\|打不过\|太贪\|保守"` ⇒ 唯一命中是第 1497 行的**注释**（`记成 reasonable:false 会把「什么都没发生」算成一次失误`） | **本次未见**（**只扫了词，没做语义审计** ⇒ 置信度中） | — | — |
| 9 | `src/coach/**` 全目录 | **同名重复定义 0 处** | 命令：逐文件 `grep -oE "^\s*(export )?(async )?function [A-Za-z0-9_]+" \| sed \| sort \| uniq -d` ⇒ **全空**（ⓒ 在这一目录已清 ✓） | **未见半成品** | — | — |
| 10 | `src/coach/companion.js`（偏好/情绪/追问分支） | 我这一轮修过的那三支**都有真读点与判据** | `chatStyle/preference` 读点见 `style=` 那一行；`tests/companion.test.js` **90/90**；`tests/evals/companion-contract.test.js` **15/15**（含"拒绝优先于复盘路由"） | **已完成** | — | — |

## 更正（2026-09-30，我自己扫错了一处 ✗）
```
第 3 行原判「3 个导出外部读点 0」**是我 grep 范围太窄**（只扫了 `src/coach` + `src/client`，**没扫 `scripts/`**）✗
⇒ 重扫（`grep -rn "\b<name>\b" src/ scripts/ tests/`，排除定义文件）：
   `interventionModelMode` **14** 个外部读点（`scripts/roco/browser-product-wiring.mjs:40` 就 import 了它）
   `isValidInterventionModel` **3** · `loadInterventionModel` **12** · `interventionModelDecision` **12**
⇒ ⇒ 这一条**撤回**（不是半成品）：模块真接线在 `src/coach/experience.js:149,296` ✓
   唯一站得住的小事：`INTERVENTION_MODEL` 外部读点 0（文件内 :85 用）⇒ **过度导出**，建议去掉 export 或加注释 ✓
⇒ 教训：**"0 命中先怀疑自己"**（任务书 §3 原话）—— 我这一条正是范围没扫全 ✗
```

## 一句话总结
**coach 层我查到 4 个半成品**（另 1 条是如实标注的"未实现" ✓ 不算半成品），**最严重两条**：
① `roco-client.js` 把**已经能算**的 `evaluate_team` 描述成"未实现"（ⓓ 过时占位 ⇒ **会让模型不去调它**）；
② 工坊里 `evalOpponent` **只读不写**（ⓑ 恒不触发 ⇒ 「针对某个对手」的一整套判断玩家**永远看不到**）。

## 未审（不猜 ✗）
```
其余 ~40 个文件我只做了**机械扫描**（重复定义 / 占位词 / 等权假设词），**没有逐入口读**：
team-candidates / team-compare / team-ranker / team-request / team-serving / rag-index / opponent-belief /
planner-prompt / policy / local-model / shadow-tools / strategist / toolbox / coach-advice / experience /
roco-experience / intervention-model.generated / individuals* / box-* / nature-* / plain-words / …
⇒ 结论：本表只覆盖**我读到的那 10 条**；`src/coach/**` 的**逐入口四问**还差一次系统走查（下一批）。
```

## 附：审前 hash（`src/coach/**`，50 个文件）
```
c887de3a84  src/coach/activity.js
e08e69cba5  src/coach/answer-cache.js
b09174364c  src/coach/client.js
d45523fb1f  src/coach/coach-advice.js
2cc1dbe142  src/coach/companion.js
df5a95bc6a  src/coach/compare-model.js
1cb7332ece  src/coach/env.js
70d1fae169  src/coach/evidence-levels.js
af045e1b0e  src/coach/evidence-lines.js
d9b1da858d  src/coach/evolution-advice.js
20aedf8ede  src/coach/experience.js
babbdb9e57  src/coach/game-adapter.js
8f63b64db6  src/coach/individuals-context.js
3234ce44bc  src/coach/individuals.js
a616786781  src/coach/intervention-model.generated.js
03f888c034  src/coach/intervention-model.js
0886e5eb97  src/coach/local-model.js
374e225245  src/coach/memory.js
49214b0709  src/coach/model-routing.js
0e33fcef52  src/coach/nature-advice.js
5753ed652a  src/coach/natures-data.js
49c9bbdc10  src/coach/pet-mechanisms.js
4ee513d678  src/coach/pet-names-data.js
fb0c6ecaa7  src/coach/plain-words.js
7fb3334138  src/coach/planner-prompt.js
073cfcb45d  src/coach/policy.js
53f9a1b725  src/coach/profile-shape.js
c625244077  src/coach/rag-index.js
3d196f309b  src/coach/rag-libs.js
cd1645dc55  src/coach/retrieval.js
6c1c1bc512  src/coach/roco-client.js
69a6034e75  src/coach/roco-experience.js
62640a0f5d  src/coach/runtime.js
3d5c9c93b9  src/coach/scheduler.js
df3c0642cf  src/coach/session.js
ac9abf79c6  src/coach/shadow-tools.js
2d3f9da787  src/coach/strategist.js
5cbb20ad41  src/coach/talent.js
b0cac45a66  src/coach/teacher-review.js
625454b958  src/coach/teacher.js
ad3c80bde0  src/coach/team-gaps.js
a93a590d45  src/coach/team-plan.js
183d3bf117  src/coach/team-request.js
29dca534eb  src/coach/toolbox.js
d4c244623b  src/coach/cloud-replay.mjs
1f5362ab5a  src/coach/opponent-belief.mjs
e6b142e9af  src/coach/team-candidates.mjs
d16e3d5b02  src/coach/team-compare.mjs
7ac0a943e2  src/coach/team-ranker.mjs
b20e5d04bb  src/coach/team-serving.mjs
```


---

# D 批：其余 ~40 个文件（机械扫描 + 少数逐条读，**只读** ✓）

**口径（先说清，免得把"嫌疑"当"半成品"）**：
- 机械信号只写**嫌疑** ✓；**只有我逐行读过的才判"半成品"** ✓
- 扫描命令（可复跑）：
  `node /tmp/scan-coach.mjs`（逐文件：死导出 / `?? 0`·`|| 0` 兜底 / 占位词）
  `node /tmp/dead-internal.mjs`（把"外部读点 0"再分成 **真死** 与 **过度导出**）

## 表（D 批）

| # | 模块/文件:行 | 现象（一句话） | 证据（逐字/读数） | 判定 | 修复成本 | 优先级 |
|---|---|---|---|---|---|---|
| D1 | `src/coach/talent.js:462` | **缺的天分逐项被当成 0** 进面板公式 | 逐字：`const talentValue = numOrNull(talent?.[stat]) ?? 0;` ⇒ 下一行 `const scaled = (shape.race * raceValue + talentCoefficient * talentValue)` 直接用它算面板 | **半成品（ⓓ 缺值当默认值）** —— 与 `nature-advice` 的 C **同一族** ✗ · ⚠ **但修法不是局部的（我试过并撤回，见下方"D1 实测"）** | **中→高（需产品级决定）** | **高** |
| D2 | `src/coach/rag-libs.js:163,168` | `readyLibs` / `selectLibs` **本文件与全库都无读点** | `node /tmp/dead-internal.mjs` ⇒ 两条都在"**真死**（本文件也没用，外部读点 0）"名单里；而 `rag-index.js:32` 只 import 了 `LIB_BY_RECORD_KIND/LIB_SCOPE/LIBS_PATH/assertLib/buildLibKindMap/loadLibs` ✓ | **嫌疑（ⓐ 可能没接线）** —— 多库（RAG 分库）选择器**没有任何调用方**；不下"半成品"结论 ✗（要再查 `rag-index` 是否自己选了库） | 中（先查再定） | 中 |
| D3 | `src/coach/teacher-review.js:64,1523,1528` | 3 个导出**无人使用**：`TEACHER_TURNING_POINT_RULES` · `teacherGoalLesson` · `teacherLabel` | 同上是"真死"名单；但 `first-faint` 的**真实逻辑在别处**（`companion.js:2550 if(sg.lastFallen&&sayable('first-faint'))`）⇒ **能力在、常量没接线** | **过度导出（低危 ✓ 不算半成品）** | 低（删导出或加注） | 低 |
| D4 | `src/coach/policy.js:24` | `isVersusMode()` 无读点，**同一判断在三处被内联** | 逐字：`policy.js:24 export function isVersusMode(mode){return mode==='pvp-local'||mode==='pvp-live';}`；而 `experience.js:13/114/381` 各写 `['pve','pvp-local'].includes(game.mode)` ⇒ 同一语义两套写法 | **重复实现（低危 ✓）** | 低（统一到一处） | 低 |
| D5 | `src/coach/**`（全目录） | **真死导出 30 个 / 过度导出 166 个**（量） | `node /tmp/dead-internal.mjs` 读数：真死 30（逐条列表见命令输出）· 过度导出 166 | **未使用的 API 面（低危）** —— 我**没有**逐个当半成品 ✓（只读了上面 4 条） | 低 | 低 |
| D6 | `src/coach/**` 的 `?? 0`/`|| 0` 兜底（38 个文件里有信号） | 抽样看**绝大多数是合法累加器**（`reduce((s,x)=>s+(x??0),0)`）✓ | 例：`team-candidates.mjs:482 overCap = curves.reduce((sum, c) => sum + (c.over_cap ?? 0), 0)` ✓ 不是ⓓ | **未见半成品（抽样）** | — | — |

## D 批一句话
**逐条核实到的半成品只有 1 条**（`talent.js:462` 缺值当 0，**高优先**，与已修的 `nature-advice` 同族）；
另 **1 条嫌疑**（`rag-libs` 的多库选择器无调用方，需再查）；其余是**未使用的导出面**（30 真死 / 166 过度导出，低危）。
**边界**：D 批是**机械扫描 + 4 条逐行读**；`src/coach/**` 剩下约 30 个文件的"逐入口四问"仍**未做** ✗（不写成已完成）。


## D1 实测：**我先修了，又撤回了**（同一行改不动整条链 ✗）

**试的修法**（C 同款）：缺的那一项 `continue` 掉、不进公式、`unknown` 里明说「不按 0 计」。
**实测读数**（`node /tmp/d1-ab.mjs`）——修法本身是**有效**的 ✓：
```
① 天分齐全 ⇒ panel 6 项（hp,atk,spa,def,spd,spe）· atk=566 · unknown []
② 天分整份缺 ⇒ panel **0 项**（旧行为：6 项都有数、按 0 算 ✗）· unknown 逐项列出「天分缺「物攻」⇒ 这一项不算（不按 0 计）」
③ 只缺 atk ⇒ panel 5 项、**atk 不参与** ✓ · unknown 只有物攻那一条
```
**但它打红 6 条既有判据** ✗（`node --test tests/roco-talent-nature.test.js tests/roco-nature-advice.test.js`）：
```
✖ ③ 「换来什么 + 牺牲什么」两边都必须是现算的面板差值
✖ ④ 防止纯机器算：每条建议都必须带"代价"
✖ ⑥ 比两个个体：缺数据必须留白
✖ ⑦ 防过拟合：种族值随机生成，建议必须跟着变
✖ ⑩ 端到端：本地成句、0 次规划器调用
✖ talent-nature ⑤ 缺输入不许拿 0 冒充：种族值缺 ⇒ 不算；天分缺 ⇒ 计入 0 但必须说出来
```
⇒ **根因（决定性的一件事）**：**整条产品链是按"面板算得出来"设计的** —— 天分缺失时若面板为空 ⇒
   性格建议 / 两体对比 / 端到端**全都给不出结论**（比"按 0 算 + 明说偏低"更糟 ✗）。
⇒ ⇒ **所以 D1 的修法要产品级决定**（不是这一行能收口的）✓ **我已撤回**（旧写法原样恢复 ✓
   `node --check` ✓ · 两个判据文件回到 **24/24** ✓）。可选方案（供 Lead 排）：
   · (a) 面板照算，但把"含 0 计入"这件事**写进每一条结论的正文**（不是只进 unknown）✓ —— 改动小、不破链
   · (b) 面板算**两个版本**（含/不含天分）⇒ 结论只在两者同向时给（成本中）
   · (c) 面板为空 + 结论层显式降级（成本高：要动 ③④⑥⑦⑩ 五条判据的语义）
**⚠ 三态**：`talent.js` **被服务端 import**（`src/server/roco-service.js:27`）⇒ 任何改动**要重启才生效**（**我没有重启** ✓）


## D1 定案：走口径 (a)（Lead 2026-09-30 裁决）—— **已做完，两态都钉**

**口径逐字**：「缺天分时产品**要给结论**；但『这一半按 0 计入』**必须写进每一条结论的正文**」✓
（(b)/(c) 不做 ✗：(c) 要改 5 条判据语义 = "为了让实现好看而改判据" ✗）

**改了什么**（`src/coach/nature-advice.js`，**面板照算** ✓ 不动 `talent.js` ✗）：
- 新增 `zeroTalentNote(talent)`：天分齐 ⇒ `null`；缺 ⇒ 那句免责话 ✓
- `explainNature`、`adviceFor`（每条候选走 `explainNature`）、`compareIndividuals` 的**正文**都接上它 ✓
- 「面板呈现」那条**本来就有**（`talentNote = '**天分按 0 计**（没拿到这只的天分 ⇒ 面板偏低）'` 已在正文里 ✓）

**两态逐字读数**（`node /tmp/d1a.mjs`）：
```
天分齐全 ⇒ explainNature「…代价是魔攻掉 -10%（247 → 227）。」          含「按 0 计入」= ✘ 无 ✓
          adviceFor   「「急躁」把速度抬 +10%（185 → 199）…」           = ✘ 无 ✓
          compareIndividuals「第一个个体在物攻上更高，在魔攻上更低。」   = ✘ 无 ✓
天分缺   ⇒ 三条正文**每条末尾**都带「（天分没填：这条里天分那一半按 0 计入，面板偏低，别当实测值）」= ✔ 有 ✓
```

**判据**：`tests/roco-nature-advice.test.js` 新增 **⑥c**（两态：齐⇒必无 / 缺⇒必有，三条结论都覆盖 ✓ 反证 ✓）
⇒ `tests/roco-talent-nature.test.js` + `tests/roco-nature-advice.test.js` = **25/25** ✓（**原有 24 条一条没红** ✓ 硬闸过 ✓）

**三态**：`代码已改` ✓（`nature-advice.js` + 判据）｜`临时实例/直调验收` ✓（上面两态 + 25/25）｜
**`8765 生效` ❌ 待重启**：`grep -rn "nature-advice" src/coach/runtime.js` ⇒ **`runtime.js:27` import 了它** ✓
⇒ 而 `runtime.js` 是**服务端启动时 import** 的 ⇒ ⇒ **改完必须重启才生效** ✓（**我没有重启** ✗ 等 Lead ✓）


## 我停手时的状态（2026-09-30）
```
已做完（本轮）：D 批盘点表 ✓ · D1 试修→撤回→定案 (a) 并落地 ✓（含两态判据 ⑥c，25/25 ✓）
               C（nature-advice 缺值不比那一半）✓ · A（选对手下拉 + 两态判据）✓ · 证据区引导句 ✓
**待重启才生效**：`nature-advice.js`（runtime.js:27 import ⇒ 服务端）· `team-plan.js`（服务端 import）
**未做完**：① 剩下 ~30 个文件的"逐入口四问" ② `rag-libs` 的 `readyLibs/selectLibs` 只查不改（嫌疑 ⓐ）
          ③ A 的**真机可见面**读数 —— 探针回 undefined 的根因已由 Lead 定位（`lib.mjs:41` 包成 `(async()=>{EXPR})()` 没有 return）
            ⇒ 通道已修 ⇒ **再跑一次就能出读数**（我没跑 ✗）
**没有留下坏状态**：每处 `node --check` ✓ · `roco-workshop+roco-page-ux` 77/77 ✓ ·
  `roco-talent-nature+roco-nature-advice` 25/25 ✓ · `verify.mjs` exit 0 ✓ · 未提交 git ✓ · 未重启服务 ✓
```


---

# E 批：剩下 39 个文件的四问（**机械代理 + 抽看**，只读 ✓）

**口径**：这 39 个文件我**没有逐入口读** ⇒ 下面**只写"未见 / 嫌疑"**，**不写"半成品"** ✗
（沿用 D 批规则：只有逐条核实过的才判半成品 ✓）

**扫描口径（可复跑）**：
```
node /tmp/e-scan.mjs     # 每文件：依据链字段(evidence/basis/trace) · 诚实说缺(不猜/如实/拿不到/unknown) ·
                         #          默认值(?? 0/|| 0/?? ''/?? []) · 顶层常量 · policy 读点 · 引擎 import
node /tmp/e-wired.mjs    # 每文件：导出数 · 死导出数（"被 import 文件数"那一列**我的 grep 写错了** ✗
                         #          ⇒ 全是 0 ⇒ **该列作废、不用于任何结论** ✓ —— "0 命中先怀疑自己" ✓）
```

## 表（E 批）
| # | 文件 | 现象（读数） | 判定 | 优先级 |
|---|---|---|---|---|
| E1 | `plain-words.js`（90 行 · 6 导出 · **死导出 0**） | 我原本怀疑它随「让小芽说人话」按钮一起变孤儿 ✗ ⇒ **数据否掉了我的猜测**：导出**都有读点** ✓ | **未见半成品** | — |
| E2 | `evidence-levels.js`(29) · `env.js`(27) · `scheduler.js`(33) · `model-routing.js`(70) · `activity.js`(152) · `shadow-tools.js`(336) · `individuals-context.js`(132) · `natures-data.js`/`pet-names-data.js`(数据) · `intervention-model.generated.js`(生成物) · `retrieval.js`(3 行，纯 re-export 垫片 ✓) | 都有**明确契约注释**（`env.js`：浏览器不许裸用 `process`，有判据钉 ✓；`evidence-levels.js`：与 `evidence-ledger-lib.mjs` 逐字一致 ✓；`retrieval.js`：兼容入口 ✓）· **死导出 0** | **未见半成品（抽看）** | — |
| E3 | `evidence-lines.js`（81 行 · 5 导出 · **死导出 3**，含 `splitEvidenceLines`） | 依据行（引用/依据文本）那一层的导出**三个没读点** | **嫌疑（未使用导出面 / 可能没接线）** | 中 |
| E4 | `planner-prompt.js`（130 行 · 8 导出 · **死导出 4**） | 云端规划提示词里有 4 个导出无读点（提示词是"模型行为"的直接来源 ⇒ 值得下一步查） | **嫌疑** | 中 |
| E5 | 大批文件的**死导出**（低危 · 与 D3/D5 同族）：`team-gaps.js` 13 · `team-compare.mjs` 12 · `opponent-belief.mjs` 12 · `team-request.js` 11 · `game-adapter.js` 6 · `rag-index.js` 6 · `team-ranker.mjs` 6 · `client.js`/`cloud-replay.mjs`/`team-candidates.mjs` 各 5 · `local-model.js`/`planner-prompt.js` 各 4 · … | 同一个"未使用的导出面"形状 | **未使用导出（低危 ✓）** | 低 |
| E6 | 依据链读数（②）：`team-compare.mjs` 27 · `opponent-belief.mjs` 23 · `team-candidates.mjs` 16 · `team-ranker.mjs` 15 · `team-gaps.js` 8 · `team-request.js` 3 · `experience.js` 9 · `strategist.js` 6 | 这些文件**普遍带 `evidence/basis/trace` 字段** ⇒ 结论有依据链的形状（不是"只有一段话"）✓ | **未见半成品（形状层面）** | — |

## D2 只查不改：`rag-libs.js` 的 `readyLibs` / `selectLibs` —— **查完了**
```
① `grep -n "selectLibs\|readyLibs" src/coach/rag-index.js` ⇒ **0 处** ✓（`rag-index.js:32` 只 import 了
   `LIB_BY_RECORD_KIND, LIB_SCOPE, LIBS_PATH, assertLib, buildLibKindMap, loadLibs`）
② `rag-index.js` 自己是这样拿库的：**3 处** `const registry = libs ?? loadLibs({root}).libs;`（:139/:151/:163）
   再按查询里的显式词做 `source_scope` **硬过滤**（:8 注释）
③ `rag-libs.js:163 readyLibs(libs) = libs.filter((lib) => lib.status === 'ready')`
   「pending 库没有 inputs，建不出索引，也不该假装有」
④ `rag-libs.js:168 selectLibs(libs, libIds) = libIds.map((id) => assertLib(id, {libs}))`（未知就抛，不静默丢）
⇒ **结论**：这两个导出是**"只用某几个库 / 只取 ready 库"的接口，当前没有调用方** ✗
   ⇒ **不是死代码**（语义清楚、有注释 ✓）⇒ 判**未使用导出（低危）** ✓
   ⇒ ⚠ 我**一度**怀疑「`rag-index` 没有 ready 过滤」✗ ⇒ **当场被代码否掉** ✓：
     `grep -n "status !== 'ready'" src/coach/rag-index.js` ⇒ **:141 / :153 / :165 三处都有**
     （逐字 `if (!spec || spec.status !== 'ready') return null;` · :136 注释「库不存在 / 还没 ready / 没写 inputs
       一律返回 null —— 不假装有语料（fail closed）」）⇒ **它自己 fail-closed 了** ✓
     ⇒ ⇒ **RAG 这条没有半成品**（`readyLibs/selectLibs` 只是"未使用的导出面" ✓ 低危）
     ⇒ 这一格留个教训：**"我怀疑"也要被代码否掉才算量过** ✓（与"0 命中先怀疑自己"是一对 ✓）
```
