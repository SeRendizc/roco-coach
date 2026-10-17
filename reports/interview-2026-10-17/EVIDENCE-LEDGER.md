# EVIDENCE-LEDGER — 二面数字台账（2026-10-17 现场实测）

- 仓库：`/Users/serendizc/Developer/roco-coach`，HEAD = `2e62a73b82ecd0c998fca4ddcd1b7206e4570365`（2026-10-06，公开状态）
- 实测时间：2026-10-17 19:07–19:25（Asia/Shanghai）；环境：macOS / Node v24.20.0 / npm 11.19.0 / python3。
- 纪律：**0 次真实付费模型调用**；未占用/未杀 8765、8896、8899；自启服务只用 8910 且已清理；未改源码。
- 判定口径：
  - `verified` = 今天亲手复现（命令 + 输出在本目录 `TEST-RUN.txt` / `_raw-*`）；
  - `stale` = 旧文档数字/口径已过时，**不能当现状引用**（应改说今天的新值）；
  - `unverified` = 今天无法复现（如被禁止的真实付费调用、无独立盲标集）；
  - `retracted` = 原话拿到面试现场会当场翻车，**禁止按原话使用**。
- 每条“今天运行的命令”都是原文；完整输出见 `TEST-RUN.txt`、`TEST-RUN.json`、`_raw-*` 文件。

## A. 测试规模 / 门禁（最容易被要求现场复跑，优先背熟）

| # | 主张（可能被引用的原话） | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| A1 | “`npm run test:roco-quality` 应该 77/77” | 任务卡；`docs/roco/verification/2026-10-06-cloud-acceptance/wording/root-quality.tap` | `npm run test:roco-quality` | `tests 77 / pass 77 / fail 0 / skipped 0 / exit 0`，898.47ms | **verified** |
| A2 | “单元判据 **1714 条、1714/1714 全绿**” | `docs/README.md:13`；`docs/INTERVIEW-DRILL.md:32,34`；`docs/ARCHITECTURE-ONE-PAGER.md:77`；`docs/IMPLEMENTATION-STATUS.md:11` | `npm run test:unit` | `tests 2084 / pass 2068 / fail 15 / skipped 1 / exit 1`（229.8s，完整跑完非抽样） | **retracted**：数字与“全绿”都过时，一跑就红 15 条 |
| A3 | “判据 **157 个文件**” | `docs/README.md:13`；`docs/ARCHITECTURE-ONE-PAGER.md:77` | `node scripts/roco/status.mjs`；`node -e` 解析 `package.json` 的 `test:unit`；`git ls-files tests` | `test:unit` 手写清单 **187 个文件**；`tests/` 下已提交的 `*.test.js/*.test.mjs` 共 **204 个**；无缺失文件 | **stale**（口径：手写清单 187，不是 157） |
| A4 | “发版门禁 **27 套件**” | `docs/README.md:14`；`docs/roadmap/DSH-EXECUTION-STATE.md:729`；`scripts/roco/verify-release.mjs:44` | `node -e "import('./scripts/roco/verify-release.mjs').then(m=>console.log(m.SUITES.length))"` | `SUITES: 27`（env/unit/bridge/…/coverage-axes/retained-assets，逐项打印） | **verified（仅“清单条数”）**；见 A5 |
| A5 | “`verify:release` → **27/27 全绿**” | `docs/roadmap/DSH-EXECUTION-STATE.md:729,7391`；`docs/README.md:14` | 未跑（会写 `reports/roco/verification/latest.json` 到本目录外，违反审计写域；并且 unit 套件今天红） | `reports/roco/verification/latest.json` 现存状态是 `failed / unit`（2026-09-28）；`status.mjs` 也报 “发版门禁 failed — unit（2026-09-28 14:29）” | **stale/unverified**：今天**不能**说“27/27 全绿” |
| A6 | “注入自检：登记 15 条、红 15 条” | `docs/INTERVIEW-DRILL.md:33`；`scripts/roco/guard-selftest.mjs` | `node scripts/roco/guard-selftest.mjs --json` | `checked 15 / ok 15 / still_green [] / skipped [] / verdict pass`，exit 0 | **verified** |
| A7 | “`npm run test:unit` 全绿；并行跑才会假红” | `docs/PITFALLS-AND-STORIES.md:48`；`docs/roadmap/HANDOFF-2026-09-28.md:13,76`；`docs/INTERVIEW-DRILL.md:34` | `npm run test:unit`（单独串行跑；guard-selftest 等它结束后再跑） | 仍是 **15 条真红**（14 条公开树自带 + 1 条本机未跟踪 `pnpm-lock.yaml`）。不是“并发假红”，不是“旧产物过期”能解释完 | **retracted**：不能再用“单独重跑就全绿”解释 |
| A8 | “此前 **37 项基线失败**仍未解决” | `docs/roco/verification/2026-10-06-cloud-acceptance/README.md:9`；`docs/roco/verification/2026-10-06-continued/README.md:48` | `npm run test:unit` | 今天红 **15 条**（含 1 条环境红），不是 37；两个数出自不同日期/口径，不能互相替代 | **stale**（说 37 会被追问“为什么今天 15”） |
| A9 | “公开 HEAD 的定向修复都跑过判据” | HEAD commit `2e62a73b`（只记录云端样本与措辞验收）；`docs/roco/verification/2026-10-06-quality/` | `npm run test:unit`；`git status` | HEAD 自带的 `docs/roco/verification/2026-10-06-cloud-acceptance/capture-server.mjs` 的 `../src/server/index.js` 相对 import 指向不存在的 `docs/src/…` ⇒ structure-contract 红；state-doc 红（落后 187 提交）；README 命令块判据红 | **stale**：HEAD 不是“全绿提交”，demo 前先知道哪 3 条会红 |

## B. 数据口径（面试常问“到底多少只”）

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| B1 | 图鉴 **622 条** | `docs/README.md:10`；`docs/INTERVIEW-DRILL.md:29`；`docs/ARCHITECTURE-ONE-PAGER.md:55` | `node -e "console.log(require('./data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json').pets.length)"` | `622`；同文件 `coverage.pets_total=622` | **verified** |
| B2 | 可玩层 **530 只** | `docs/INTERVIEW-DRILL.md:29`；`docs/ARCHITECTURE-ONE-PAGER.md:61` | `node -e "…layer-playable-48/support-matrix.json…pet_count"`；`owned-pets.json.counts.species_in_layer_playable_48` | `pet_count=530`（`pets[]` 长度 530）；owned counts `species_in_layer_playable_48=530`。⚠ 目录名里的 “48” 只是名字（引擎 `LAYER_DIRNAME` 写死） | **verified** |
| B3 | 冻结档 **542 只**（530 + 基线 12） | `docs/INTERVIEW-DRILL.md:29,38`；`docs/ARCHITECTURE-ONE-PAGER.md:56` | `curl -s http://127.0.0.1:8910/api/roco/roster`（今天自起的 8910 服务）；`owned-pets.json.counts` | `total=542`（`/api/roco/roster`）；owned counts：`species=542`、`in_layer=530`、`outside_layer=12` | **verified** |
| B4 | 六维采用抓包 **540 只** | `docs/README.md:11`；`docs/IMPLEMENTATION-STATUS.md:10`；`docs/ARCHITECTURE-ONE-PAGER.md:55` | `node -e "…full-catalog.provenance.stats_override…"` | `stats_override.matched=540`（`matched_by {game_id:522, lord_name:18}`）；`coverage.stats_from_capture=540`、`stats_snapshot_only=82` | **verified** |
| B5 | 盒子 **542 个个体 / 542 物种** | `docs/INTERVIEW-DRILL.md:38` | `node -e "…owned-pets.json.counts…"` | `instances=542`、`species=542`、`battle_builds=542`、`same_species_groups=0` | **verified** |
| B6 | 按需推算档 **80 只**（原 574） | `docs/INTERVIEW-DRILL.md:29,38` | `node -e "…data/roco/derived/on-demand-builds.json.summary…"` | `species=622 / FULL_VERIFIED=542 / SIMULATABLE_UNVERIFIED=80 / skipped=0` | **verified**（注意其自报“未实机核验、工程启发式”，别当冻结数据） |
| B7 | “14 宠 / 48 只”旧口径 | `docs/INTERVIEW-DRILL.md:29`；`docs/roco/COACH-INTERVIEW-NARRATIVE.md:58`（1517 条 / 134 文件） | 同 B1–B6 | 现在能出战 542；1517/134 是 2026-09-26 的旧测试规模 | **stale** |

## C. Agent 链路（面试官最容易追问“到底哪里是 Agent”）

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| C1 | 工具循环上限：**3 次工具调用 / 4 轮**（`limit=3`，`for(i=trace.length;i<Math.min(4,limit);i++)`） | `docs/INTERVIEW-DRILL.md:78`；`src/coach/runtime.js:4460`（`limit=3`）、`:4595`（`budget=Math.min(4,limit)`） | 读源码 + `node --test tests/roco-agent-stops.test.js`（45 条里 pass 44/skip 1） | 代码与文档一致：默认 `limit=3`，循环硬顶 `Math.min(4,limit)`；`budget` 同式 | **verified（代码级）** |
| C2 | “`stopped` 有 **12 种**” | `docs/INTERVIEW-DRILL.md:78`（自注“六条这个数字已过时”，但接着写成了 12） | `node -e "import('./src/coach/runtime.js').then(m=>console.log(m.AGENT_STOPS.length))"` | **22** 种（`complete / policy* / planner-* / invalid-* / *-budget / policy-fact-* / policy-server-data-unavailable`），并由 `tests/roco-agent-stops.test.js` 双向钉住（无未登记值、无死值） | **stale**：今天说 12 会被当场纠正 |
| C3 | 规划器默认停止（“默认是停止，证据够了立刻 stop”） | `docs/INTERVIEW-DRILL.md:79,176`；`src/coach/planner-prompt.js:22`；`src/coach/local-model.js:386`；`src/coach/shadow-tools.js:52` | 读源码；离线重算第 2 轮自停率（见 C5） | prompt 原文含“**默认是停止。**…证据够了就立刻输出 `{"stop":true}`”；今天自停率仍是 30/31 | **verified** |
| C4 | “应调且调了之后，工具选择 **12/12**” | `docs/INTERVIEW-DRILL.md:84`；`reports/planner-tuning-log.md:52`；`reports/live-model-eval-before-after.md:42` | `RAW=reports/live-model-eval-pass2.json OUT=…/_analysis-pass2.json node scripts/analyze-live-eval.js`（离线重算，不调模型） | 预期应调 19 条 → 实际调了 12 条，其中工具选择正确 **12/12**（旧基线 16/19） | **verified（对归档 raw 的离线重算）**；口径是 2026-09-25 单次运行、无置信区间 |
| C5 | 多余工具调用率 **75% → 33.33%** | `docs/INTERVIEW-DRILL.md:79,84`；`reports/planner-tuning-log.md:7-14`；`reports/live-model-eval-before-after.md:34` | 同上两条 analyze（before / pass2） | `unnecessaryToolCallRate`：改前 **0.75（9/12）** → 改后 **0.3333（4/12）**；剔除 c44 的口径 72.73%→27.27% 也在报告里 | **verified（离线重算）** |
| C6 | 模型自停率 **3.23% → 96.77%** | `docs/INTERVIEW-DRILL.md:79,176`；`reports/live-model-eval-before-after.md:46` | 同上 | `plannerChoseToStopItself`：改前 **0.03226（1/31）** → 改后 **0.96774（30/31）** | **verified（离线重算）** |
| C7 | 漏调 **0/19 → 7/19**（可主动交代的权衡） | `docs/INTERVIEW-DRILL.md:79`；`reports/live-model-eval-before-after.md:100` | 同上 | `missedCallRate`：0 → **0.21875（7/19）**；拆分为 cat1 5/11、cat3 2/8 | **verified（离线重算）** |
| C8 | 首选工具在允许集合内 **90.63% → 78.13%**（改前值！） | `docs/INTERVIEW-DRILL.md:67,84`；`reports/live-model-eval-before-after.md:41` | 同上 | `toolChoiceCorrectRate`：**0.90625 → 0.78125**；文档已自注 90.63% 是**改前值**，不要当“当前值” | **verified**（引用时必须说“改前”）
| C9 | 44 条真实调用、成本 **$0.0335 → $0.0209**、延迟 p50 **4284→2798ms** | `reports/planner-tuning-log.md:7-14`；`reports/live-model-eval-before-after.md` | **未复跑**（需真实付费 DeepSeek 调用，本次审计禁止） | 只能确认归档比较报告与 raw 行存在（`reports/live-model-eval-before.json`、`…pass2.json` 各 44 行）；未产生新调用 | **unverified（archived）**：可讲“当时报告记的是”，不可讲“我今天量到” |

## D. RAG 四臂

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| D1 | 四臂 Hit@3：none 0% / lexical **88.39%** / hybrid **90.18%** / counterexample **91.07%** | `docs/INTERVIEW-DRILL.md:101`；`reports/retrieval-extended-summary.md:43-48` | `node -e` 读 `reports/retrieval-extended.json`；复跑 `cd /tmp/roco-audit-rag && node scripts/eval-retrieval-extended.js` | 产物与总结逐项一致（0.8839285714 / 0.9017857143 / 0.9107142857，n=128，112 正/16 负）；但复跑脚本 **exit 1**：`未知检索策略 hybrid：searchKnowledge 只实现 lexical / semantic / fusion`（`src/coach/strategist.js:160`） | **stale（产物一致但今天不可复现）**：现场不要跑这条命令 |
| D2 | 反例臂 vs lexical：+2.68pp，McNemar 精确 **p=0.4531**，bootstrap 95% CI [−1.79,+7.14] | `docs/INTERVIEW-DRILL.md:101`；`reports/retrieval-extended-summary.md:54` | 读 `reports/retrieval-extended.json` 的 `significance.tests.counterexample_vs_lexical` | `hitAt3_difference=0.0267857`、`p=0.453125`、`ci95=[-0.0178569, 0.0714286]` — 与总结一致 | **verified（仅产物内部一致）**；**unverified（今天无法重新推导）** |
| D3 | 负例拒答率三臂都只有 **56.25%（9/16）**，7 条越界仍召回 | `docs/INTERVIEW-DRILL.md:102`；`reports/retrieval-extended-summary.md:56` | 读 `reports/retrieval-extended.json.results` | `lexical/hybrid/counterexample` 的 `negativeRejection` 均 = 0.5625、`negativeFalsePositives=7` | **verified（产物）** / today 不可复跑（同 D1） |
| D4 | “语料 **1975 份**；检索判据 **14/14**，Recall@1/MRR/层级命中率全 **1.000**” | `docs/roco/COACH-INTERVIEW-NARRATIVE.md:24` | `node scripts/roco/eval-rag-retrieval.mjs --json` | 当前 **rag_index**：Recall@1/3/10 = **1.0**、MRR=1.0、entity/version=1.0；但语料已是 **2489** 篇、held-out 45 条（34 可答/11 弃答），不是 1975/14 | **stale**：数字/口径都变了；说“我今天的 held-out 45 条上 Recall@1=1.0” |
| D5 | 磁盘 RAG 门禁产物与现在一致 | `reports/roco/rag/rag-eval.json`；`scripts/roco/eval-rag-retrieval.mjs --check` | `node scripts/roco/eval-rag-retrieval.mjs --check` | **exit 1 FAIL**：`baseline_lexical_pack Recall@10 磁盘=0.9117647 重算=0.8823529`；unit 里 `tests/roco-rag-eval.test.js:66` 同因红 | **retracted**：不能现场跑 `verify:release` 否则 rag-eval/unit 红 |

## E. RL 与干预

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| E1 | 工具路由实验：**1152 个可训练参数** | `docs/COACH-PLAN.md:17`；`docs/INTERVIEW-DRILL.md:119`；`reports/tool-router-rl.json` | 读产物 + 沙箱复跑 `cd /tmp/roco-audit-rl && /Users/…/.venv-agent/bin/python scripts/train-tool-router.py` | `trainableParameters=1152`；=2 个输出行 × SmolLM2-135M hidden 576；复跑产物逐项一致（21.9s，本地 CPU，无付费 API） | **verified（今天确定性复跑）** |
| E2 | 留出 **16 条：8 → 15 正确** | `docs/INTERVIEW-DRILL.md:119`；`reports/tool-router-summary.txt` | 同上（复跑） | 未训练 `accuracy=0.5`（8/16）→ 三个种子 test 均 `0.9375`（**15/16**），selected epoch 50/60/50；test predictions 与归档逐位相同 | **verified（今天确定性复跑）** |
| E3 | 干预策略 **5.89 → 1.70 次/局** | `docs/INTERVIEW-DRILL.md:124`；`reports/intervention.json` | `node -e` 读 `reports/intervention.json.results`（模拟，不调模型） | `rule` 策略 5.89 hints/ep（三训练种子相同）；`q-learning` **仅 selectedSeed=71** 是 1.704；另两个种子为 2.318 / 1.978 | **stale（需加限定）**：应说“在选中的种子 71 上 5.89→1.70（三种子 1.70–2.32）”，且是**模拟**不是真人 |
| E4 | 增量帮助 **1.38 → 0.86** | 同上 | 同上 | `rule` = 1.382；`q-learning` seed 71 = **0.862**（另两种子 1.158 / 0.924） | **stale（需加限定）** |
| E5 | “干预策略是 RL 训练出来的 Q 表，奖励显式罚打扰” | `docs/INTERVIEW-DRILL.md:118,121`；`reports/intervention.json.simulation` | 读产物 `simulation` 字段与 `rewardAudits` | 自报：`Explicit intervention MDP v2 … simplified player model, NOT human outcomes or LLM training`；`testSeeds 1000000–1000499`、6000 episodes/seed | **verified（有产物）**；边界必须一起说 |

## F. 真实云端样本（2026-10-06 三轮）

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| F1 | 三个 UI 提问、三个真实 deepseek-flash 请求，**HTTP 200**；**原始正文与页面最终正文逐字一致**；provider=deepseek；**无拒绝、无回退** | `docs/roco/verification/2026-10-06-cloud-acceptance/README.md:5` | `node -e` 对账 `real-cloud-results.json` + `round{1,2,3}-ui.txt` | 3/3 `httpStatus=200`、`provider=deepseek`、`validation.rejected=false`；`rawModelText===deliveredText` 3/3；交付文字逐字出现在 UI txt 3/3；`totals.fallback=0` | **verified（归档记录 + 今天文件对账；未重发请求——付费调用被禁）** |
| F2 | 用量：prompt **40549** / completion **257**（三样本合计，不是通用基准） | `…cloud-acceptance/README.md:11` | 同上 | `totals={realModelRequests:3, modelAnswerAccepted:3, fallback:0, promptTokens:40549, completionTokens:257}`；逐轮 13000+12862+14687=40549、84+100+73=257 | **verified（归档）** |
| F3 | 三轮回执与页面文字没有回退（回复内容：火系比较 水蓝蓝0.5/喵喵2；光系 喵喵0.5/水蓝蓝1；首选「防御」） | 同上 README:5-8 | 读 `real-cloud-results.json.rounds[].rawModelText` + `round3-ui.txt` | 三轮 raw 文本与 UI 文案一致；第 3 轮含「首选是『防御』…主要风险…光凭能量10不能断定会不会击倒」原文 | **verified（归档）**；live 页未今日重放（禁止付费） |
| F4 | 样本生成于生产提交 `7aa338ee`，当前 HEAD `2e62a73b` | `real-cloud-results.json.productCommit`；HEAD | `git merge-base --is-ancestor 7aa338ee… HEAD && echo IS_ANCESTOR` | **IS_ANCESTOR**：7aa338ee 是 HEAD 祖先；两者差异只是记录/文档提交 | **verified** |
| F5 | 措辞修复后的源码就是样本验收的源码（`wording/source-manifest.sha256`） | `…cloud-acceptance/wording/source-manifest.sha256` | `shasum -a 256 src/client/roco.js tests/roco-skill-support-wording.test.js` | 两个 sha256 与 manifest **逐字节一致**（e68a43cf… / 5549e84f…） | **verified** |

## G. 演示 / 延迟 / 环境

| # | 主张 | 出处 | 今天运行的命令（原文） | 实测输出摘要 | 判定 |
|---|---|---|---|---|---|
| G1 | 现有演示服务 8765 可用 | `README`；`scripts/roco/status.mjs` | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/api/bootstrap`（只读，未杀） | `200`；全程 8765 HTTP 200（未触碰其进程） | **verified** |
| G2 | 备用端口 8910 能起、页面能开 | 任务卡；`README.md:53`（写法 `PORT=… npm start`） | `PORT=8910 npm start` + `curl` | `/api/bootstrap` 2 次轮询内 READY；`/` `/roco.html` `/box.html` `/workshop.html` `/xiaoya.html` `/connect.html` 全 **200**（16880/62575/9453/1993/3662/2468 bytes）；未知路径 404 | **verified** |
| G3 | 规则服务健康 | `README.md:70`；`src/server/index.js:931` | `curl -s http://127.0.0.1:8910/api/roco/status` | `available=true`、`health.ruleset_id=roco-world-s4-2026-09-10`、`snapshot_fingerprint=4d5c169f…`、`protocol_version=1` | **verified** |
| G4 | 对局链路（开局→规划→推进）可跑 | `src/server/roco-service.js:163`（publicView）；`tests/evals/roco/intervention-agreement.test.js:55` | `node /tmp/roco-audit-demo.mjs`（POST battle/new → plan → advance） | battle/new：`ok=true turn=1 phase=battle`，六只含 寂灭骨龙/海豹船长/黑猫巫师；plan：`ok=true recommendation=使用能量果 branches=96 depth=2 stable=true`；advance：`ok=true turn=2` + 3 条中文事件 | **verified（API 级）** |
| G5 | 离线回退延迟 | 任务卡 §4 | `node /tmp/roco-audit-8910.mjs`（12 次 `POST /api/coach`，无 key） | `n=12 ok=12 provider=local`；**p50=8.71ms p95=15.96ms** mean=9.41ms；cache 全 miss；不含规则服务、不含模型 | **verified（仅本地回退；不是真实模型延迟）** |
| G6 | 局内问“该换谁”在**无 key** 时可用 | 任务卡演示动线 | `node /tmp/roco-audit-inbattle.mjs` | HTTP 200 但回答为 fail-closed「这一局的当前合法行动或公开场上状态读不到…」；引擎 plan 正常（使用能量果）。**没有**伪造建议 | **verified（如实降级）**：无 key 不要在面试里演“局中问该换谁”这一步 |
| G7 | `npm run test:unit` 无副作用 | — | 跑完后 `git status` | 仓库自带测试改写 tracked 产物 `reports/live-model-eval-only.json`、`reports/roco/agent-trajectories-verification.json` 并生成 `.work/`；已 `git checkout --` 恢复并删 `.work/`。**测试还对本机 8765 发过一次只读 `GET /api/bootstrap`**（`--from-raw` 分支不生成） | **verified（已清理；付费调用 0）** |

## H. 面试杀伤力排序：最危险的 stale / retracted 主张

1. **“单元判据 1714 条、1714/1714 全绿”**（A2/A7）——面试官让你跑 `npm run test:unit`，4 分钟内出现 **15 条红**，且其中 state-doc/README/capture-server 是公开树自带。**这是第一杀手**。
2. **“`verify:release` 27/27 全绿 / 门禁随时能跑”**（A5/D5）——今天 unit 红、rag-eval `--check` 红、state-doc 红；当场跑门禁必翻车。
3. **“stopped 有 12 种”**（C2）——现在是 **22** 种；代码里一 import 就能数。
4. **四臂 RAG 是“可复现实验”**（D1）——`scripts/eval-retrieval-extended.js` 在 HEAD 上**直接抛错**（`hybrid` 策略已退役）；只能在报告层面引用 2026-09-17 的产物，且必须主动说“脚本今天不可复跑”。
5. **“27 套件” 与 “1714/157 文件数”**（A3/A4）——文件数已是 187（手写清单）/204（tests/ 全量）；套件数 27 仍对，但“全绿”不对。
6. **“37 项基线失败”**（A8）——今天 15 条，两个数混用会被追问到底。
7. **RL/干预数字的种子挑选**（E3/E4）——5.89→1.70、1.38→0.86 只在 selectedSeed=71 成立；三种子范围 1.70–2.32 / 0.86–1.16，且是模拟非真人。
8. **“语料 1975 份 / 14 条 held-out / 全 1.000”**（D4）——现在是 2489 篇 / held-out 45 条；Recall@1=1.0 仍成立，但要换成新口径。
9. **把 90.63% 当“当前值”**（C8）——它是**改前**值；改后 78.13%，文档自己已标注，别说反。
10. **“48 只 / 14 宠”旧口径**（B7）——现在冻结 542，且目录名 `layer-playable-48` 只是名字。

## I. 今天可以放心说的“一句一数”（全部 verified）

- `npm run test:roco-quality`：**77/77，exit 0**（0.9s）。
- 数据：图鉴 **622** / 可玩层 **530** / 冻结档 **542**（=530+12）/ 六维抓包 **540** / 盒子 **542** 个体 / 按需推算 **80**。
- 注入自检：**15 条登记、15 条翻红、still_green=0**。
- Agent：`stopped` 取值域 **22**；默认停止写在 `src/coach/planner-prompt.js:22`；改前→改后 多余调用 **75%→33.33%**、自停 **3.23%→96.77%**、漏调 **0/19→7/19**、应调且调后工具选择 **12/12**（均为 2026-09-25 单次运行、今天离线重算）。
- RL：**1152** 参数、留出 **8/16→15/16**（三种子一致，今天沙箱复跑逐位一致）。
- 云端样本：3 次真实请求、HTTP 200、`raw==delivered==UI`、`fallback=0`、provider=deepseek（归档 2026-10-06，今天只对账不重发）。
- 演示服务：`PORT=8910 npm start` 起得来、5 个页面 200、规则服务 `available=true`、开局/规划/推进 API 链跑通；离线回退 p50 **8.71ms** / p95 **15.96ms**（n=12，非模型）。
