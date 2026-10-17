# CV-CLAIMS-CHECK — `cv/CV2610-v2.tex` 数字/主张逐条核（2026-10-17 19:21–19:32）

- 核对对象：`cv/CV2610-v2.tex`（2026-10-17 版；同一内容的 `cv/CV2610-v2.md`、`cv/DIFF-NOTES.md`）。
- 依据：本目录 `EVIDENCE-LEDGER.md` / `TEST-RUN.txt` 的今日实测 + 本轮新增的 **288 窗口配对复算**（`_raw-cv-288-pairing.json`）。
- 判定：`verified`（今天亲手复现）/ `stale`（数字或口径已过时，不能当现状）/ `unverified`（今天无法复现，如仓库外信息）/ `retracted`（按原话用会当场翻车）。
- 纪律：仍只写本目录；0 次付费模型调用；未改源码。

## 一句话结论

CV 的五条 Roco bullet 里，**3 处必须改**：①「80.6%→100%（56 条）」在当前 HEAD 产物上**不成立**（那是被 09-29 重训取代的模型臂口径），②「6 条注入反证」与今天 runner 实际的 **7 条**不一致，③「27 套发布门禁 / 1,700+ 单测」只能作为**清单量**写、不能暗示全绿（今天 unit 15 条红）。其余（0 次模型调用、有界循环、grounded、45 held-out、三套检索器、13 探针、四臂 +2.68pp/p=0.45、1152/8→15）有据可写。

## 1. 必核清单（6 项）

### 1.1「288 个配对窗口 80.6%→100%（232/288→288/288，56 条由红转绿、0 条反翻）」— **stale / 当前产物不可复现**

| 项 | 内容 |
|---|---|
| 原文 | “把‘该不该调工具’移到策略层后，288 个配对窗口通过率 **80.6%→100%**（56 条由失败转通过、0 条反向）”（CV B2） |
| 证据 | `docs/roco/AGENT-POLICY-FIRST.md:3-4,32-33,45-47`：配对窗口 288 / 判定相同 232 / 挂→过 56 / 过→挂 0；232/288=80.6%、288/288=100%。**但**文档 §4 自己给的模型臂 sha256 是 `77a1c84f…`，当前 HEAD 的 `tests/evals/agent-trajectories-model-v1.jsonl` 已是 `c72d4edc…`（09-29 commit `84a68c84` 用 v8 适配器重出，整体 1695/1752=96.75%）。今天用 HEAD 产物按文档同一配对法复算：**288 对全配上；模型自决 283/288（98.3%）；policy-first run1 286/288、run2 288/288；失败→通过仅 3 / 5 条，通过→失败 0**。用 `git show 1ce56f01:…` 取出文档所述旧产物复算，则 **232/288、56、0、分类 rules_lookup 32 + roster_constraint 24 与文档逐项一致**。 |
| 判定 | **stale（对 HEAD 而言）/ retracted（不能按原话当“当前数字”）**。80.6%→100%（56 条）只在**已被取代的模型臂产物**上成立；`AGENT-POLICY-FIRST.md` §4 的模型文件哈希行已过期。另外文档 §5 自己承认两轮 policy-first 是 **286/288 与 288/288**，“100%”是较好的一轮。 |
| 建议改法（≤2 行） | 删掉「80.6%→100%/56 条」，改：“policy-first 消融：同一批 288 个 case×world 配对窗口两轮 **286–288/288**、**0 条由通过转失败**（仅 local_4b 单臂、单世界配对，方差大）”。若面试官追问旧 80.6%，再说明“那是 09-28 模型臂产物口径，09-29 模型臂已重训，当前 HEAD 同窗口模型自决 283/288”。 |

### 1.2「确定性快路径 0 次模型调用」— **verified（代码路径；占比类旧数字 unverified）**

| 项 | 内容 |
|---|---|
| 原文 | “合法行动、伤害与属性相性由规则引擎确定性计算，模型只做意图理解、按需查证与措辞（快路径 **0 次模型调用**）”（CV B1） |
| 证据 | `src/coach/runtime.js` 有 `pureFact` → `localFactAnswer` 分支，成功后 `agentStop:'policy-fact-local'`（`:2488`），注释多处写“**0 次模型调用**”（`:123,153,209,524,531,538`）；回执 `localOnly=deterministic`（`:2918`）。判据：`tests/roco-ask-coverage.test.js` 十余处断言 `agentStop==='policy-fact-local'`（`:329,404,473,547,573,639,725,763,785,824,838`）。今天 `tests/engine/test/rules/mechanics` 相关 33/33 过。 |
| 判定 | **verified（架构/代码级）**：该族问句不经规划器与模型正文。**unverified**：旧文“40 次真机里 16 次本地作答（0 模型调用）”（`docs/roco/COACH-INTERVIEW-NARRATIVE.md:19`）是 2026-09-26 归档、今天未重测；不要说具体比例。 |
| 建议改法（≤2 行） | 保留“快路径 0 次模型调用”，面试口径补一句：“指纯事实/参数化问句走 `policy-fact-local` 单发路径；具体占比今天没重测，旧数字是 09-26 的 16/40。” |

### 1.3「45 条 held-out 上三套检索器同台对照，配 13 条探针与 6 条注入反证」— **三套/45/13 verified；「6」与 runner 现状不一致**

| 项 | 内容 |
|---|---|
| 原文 | “45 条 held-out 上三套检索器同台对照，配 13 条探针与 6 条注入反证”（CV B4） |
| 证据 | `_raw-rag-eval-current.json`：`heldout.total=45`（34 可答 / 11 应弃答）；`metadata.evaluators=[baseline_searchKnowledge, baseline_lexical_pack, rag_index]` 三套同台；`probe.count=13`（探针集另写、`probe.failures=[]`，文档里 2 条初轮失败已登记：P13 修复、P10 保留/后由语料补齐解决）。**注入反证**：runner `--selftest` 今天实际 **7 条**（`selftest().cases.length=7`，R1–R7，7/7 翻红、base_ok=true）；`tests/roco-rag-eval.test.js` 里是 **6 条必红反证**（反证①–⑥）。另：闸门 checks 今天 **14** 项（不是 13）。 |
| 判定 | **verified（45 / 三套 / 13 探针 / 6 条必红反证在单测里）**；**stale（“6 条注入反证”若指 runner --selftest，则已是 7 条；旧注释 `eval-rag-retrieval.mjs:14` 也写 6，已过时）**。 |
| 建议改法（≤2 行） | 改为：“45 条 held-out 三套检索器同台对照 + **13 条探针** + **6 条必红反证（单测）/ 7 条注入自检（runner，今日 7/7）**”。面试别把“13 条探针”说成“13 组判据”（闸门 14 项）。 |

### 1.4「128 条四臂对照中最佳臂仅 +2.68pp、不显著（p=0.45）」— **verified（“最佳臂”= counterexample，措辞准确；但只能讲产物）**

| 项 | 内容 |
|---|---|
| 原文 | “128 条四臂对照中最佳臂仅 +2.68pp、不显著（p=0.45），保留关键词基线并公开未胜结论”（CV B4） |
| 证据 | `reports/retrieval-extended.json`：`results` Hit@3 none 0 / lexical 0.8839285714 / hybrid 0.9017857143 / **counterexample 0.9107142857**；`bestArm='counterexample'`；`significance.tests.counterexample_vs_lexical`：Δ=0.0267857（+2.68pp）、McNemar 精确 **p=0.453125**、bootstrap CI [−1.79,+7.14]pp；`reports/retrieval-extended-summary.md:43-54` 一致。**“最佳臂”就是 counterexample 91.07%，不是 hybrid 90.18%**。⚠ 该脚本在 HEAD 上跑不起来：`searchKnowledge('hybrid')` 抛“未知检索策略 hybrid”（策略已改为 lexical/semantic/fusion）——只能引用 2026-09-17 产物。 |
| 判定 | **verified（产物内部一致，措辞准确）**；**stale（复现命令不可用）**：现场不要跑 `scripts/eval-retrieval-extended.js`。 |
| 建议改法（≤2 行） | 保留数字，补“（2026-09-17 归档产物；今日四臂脚本已不可复跑）”；或把“最佳臂”写成“反例加权臂”。不要说“RAG 显著提升”。 |

### 1.5「27 套发布门禁」— **清单 27 个 verified；不得写“全绿/全部通过”**

| 项 | 内容 |
|---|---|
| 原文 | “把主链路接进 **27 套发布门禁**”（CV B5） |
| 证据 | `node -e "import('./scripts/roco/verify-release.mjs').then(m=>console.log(m.SUITES.length))"` → **27**（env/unit/bridge/…/coverage-axes/retained-assets，逐项打印）。但今天 `npm run test:unit` **15 条红 / exit 1**；`reports/roco/verification/latest.json` 现存状态 `failed / unit`（2026-09-28）；`rag-eval --check` 也红。本次**没有**跑 `verify:release`（会写本目录外的产物）。 |
| 判定 | **verified（仅“清单 27 个套件”这一事实）**；**retracted（若暗示 27/27 全绿）**。 |
| 建议改法（≤2 行） | 写“接入 **27 套发布门禁清单**”就成立；不要写“27 套全绿/门禁随意跑”。面试主动说：“今天 unit 套件 15 条红，门禁产物停在 09-28。” |

### 1.6「2,084 条单测 / 187 判据文件」→ 简历写「2,000+ 条自动化判据」— **数量 verified；作为“全绿”不安全**

| 项 | 内容 |
|---|---|
| 原文 | CV 现写“**1,700+ 条单测**”（旧 1714 口径）；lead 提议“2,000+ 条自动化判据 / 187 判据文件” |
| 证据 | 今天 `npm run test:unit`：**tests 2084 / pass 2068 / fail 15 / skipped 1 / exit 1**（229.8s）；`test:unit` 手写清单 **187 个文件**（`node scripts/roco/status.mjs` 也报 187；`tests/` 下已提交 `*.test.js/*.test.mjs` 共 204 个）。因此“2,000+ 条”作为**判据清单量**成立；“187 判据文件”也成立。 |
| 判定 | **verified（数量）**；**stale（“1,700+” 是 09-28 旧口径，且容易被读成“单测全绿”）**。 |
| 建议改法（≤2 行） | CV 可写：“接入 27 套发布门禁清单与 **2,000+ 条自动化判据**（含 15 条注入自检）”——只报清单量、不加“全部通过”。面试被问就答：“2,084 条里 2,068 过、15 红、1 skip（今天实测）。” |

## 2. Roco 其余主张逐条

| 原文（CV 摘录） | 证据 | 判定 | 建议改法（≤2 行） |
|---|---|---|---|
| “军师、老师、陪练三角色” | `src/server/index.js:228` role 白名单 `auto/strategist/teacher/companion`；README 三角色；`src/coach/teacher.js`、`companion.js`、`strategist.js` 实文件存在 | **verified** | 保留。 |
| “合法行动、伤害与属性相性由规则引擎确定性计算” | 今天 `node --test tests/engine.test.js tests/rules.test.js tests/mechanics.test.js` → **33/33 pass, exit 0**；`data/roco/rulesets/*.json` + `src/game/engine.js` | **verified** | 保留；可加“引擎判据 33/33（今天）”。 |
| “有界工具循环：首步由政策强制、模型最多再规划 2 次、回执上限 3” | `src/coach/runtime.js:4460`（`limit=3`）、`:4595`（`min(4,limit)`）、mustCall 政策首枪路径（`:4480-4515`）；`docs/ARCHITECTURE-ONE-PAGER.md:27`、`docs/INTERVIEW-GUIDE.md:17`。今天 `tests/roco-agent-stops.test.js` 过（22 种停止值双向钉住） | **verified** | 保留；主动补一句“真实模型 44+4 条记录里最多 1 次调用，多步链未被真实模型观察到”（`reports/react-evidence-check.json`、`INTERVIEW-GUIDE:17`）。 |
| “模型输出逐句做 grounded 校验：数字、技能名与行动必须命中证据包，否则整句丢弃并降级本地结论” | `src/coach/runtime.js:4770 checkGroundedAnswer`；rejected→`local-fallback` + `fallbackReason`（`:2918`）；`tests/evals/agent.test.js` 的 unsupported-number/citation/item-drift 用例；今日 `tests/rules` 等无红 | **verified（措辞偏强）** | 去掉“逐句”，改“对回答做 grounded 校验（数字/技能名/行动必须命中证据包），不过则**整条**降级本地结论”——实现是整条校验/整条降级。 |
| “建议绑定局面版本，出招或换宠即失效、迟到结果整条丢弃” | `stateToken`/`taskIsCurrent`/scheduler（`src/coach/scheduler.js`、`src/client/app.js`）；服务端断连中止上游：`tests/server.test.js:36` “client disconnect aborts the upstream model request”；缓存反证 `:227` | **verified** | 保留。 |
| “宿主适配契约在装配期拒绝缺失权限与隐藏信息泄露” | `src/coach/game-adapter.js:37 HIDDEN_FIELD:'hidden_field_leaked'`、`:176` 装配期 violation；`tests/evals/roco/bridge.test.js:399` “桥：拒绝携带隐藏信息，连发都不发”；`src/coach/roco-client.js:111 HIDDEN_KEYS` | **verified** | 保留。 |
| “RL 只做两个窄实验（表格 Q-learning 干预策略、1,152 参数工具路由头，16 条留出 8→15）” | 今天沙箱复跑 `scripts/train-tool-router.py`：**1152 参数、24/8/16、8/16→15/16 三种子逐位一致**（21.9s，无付费 API）；`reports/intervention.json`：rule 5.89 hints/ep、1.382 help/ep；q-learning **selectedSeed=71** 1.704/0.862（另两种子 1.70–2.32 / 0.86–1.16，模拟非真人） | **verified（数字）** | 保留；若讲干预数字，加“选中种子 71、模拟口径、非真人学习收益”。 |
| “以 AI 协作构建…” | 叙事性表述，不可/无需核 | n/a | 保留。 |

## 3. 非本仓库可核的主张（不评真伪，只标证据状态）

| 原文 | 证据 | 判定 | 建议改法（≤2 行） |
|---|---|---|---|
| 华为 AI Arena：“约 **2,100 行** Python 脚本”“初赛**满分**晋级”“**24/24** 任务通过、**100 分**” | 本仓库无任何该项目的独立证据（`cv/DIFF-NOTES.md` 也注明沿用原简历口径） | **unverified（仓库外）** | 保留需本人能核对；面试口径“这是另一项目的平台评测结果，材料不在本仓库”。 |
| Agent Runtime Lab 两条（Python+SQLite、三边界注入崩溃等） | 独立仓库（GitHub 链接），本工作区无该仓库 | **unverified（仓库外）** | 同上；若面试官点开链接，确保仓库可访问、描述一致。 |
| 论文 AIP Conference Proceedings Vol. 3480, 990003（DOI 10.1063/12.0043543） | 仓库外；今天未联网核 DOI | **unverified（仓库外）** | 保留；提交前自己点一次 DOI 确认卷期/文章号。 |
| TEM-8 / TOEFL 105 / CATTI 国家一等奖 / 学历课程与荣誉 / 每周 5 个完整工作日 | 个人信息，仓库无证据 | **unverified（仓库外）** | 保持真实即可；本台账不对个人经历做真伪判断。 |

## 4. 建议的 Roco 五条最终写法（可直接替换 CV B1–B5，仍一页）

1. **定位**：以 AI 协作构建《洛克王国：世界》六宠对战 Coach Agent，落地军师/老师/陪练三角色；合法行动、伤害与属性相性由规则引擎确定性计算（引擎判据 33/33），模型只做意图理解、按需查证与措辞；纯事实快路径 **0 次模型调用**（`policy-fact-local`，有单测断言）。
2. **Agent**：实现有界工具循环（首步由政策强制、模型最多再规划 2 次、工具回执上限 3、异常即止损）；把“该不该调工具”移到策略层后，**288 个配对窗口两轮 286–288/288、0 条由通过转失败**（仅 local_4b 单臂/单世界配对，方差大）。
3. **证据与边界**：模型回答做 grounded 校验（数字/技能名/行动必须命中证据包，否则整条降级本地结论）；建议绑定局面版本、出招/换宠即失效、迟到结果丢弃；宿主适配契约在装配期拒绝缺失权限与隐藏信息泄露。
4. **可弃答 RAG**：别名 + 结构化过滤 + BM25 索引；**45 条 held-out 三套检索器同台对照**，配 **13 条探针**与 6 条必红反证（runner 另有 7 条注入自检）；128 条四臂对照中最佳臂仅 **+2.68pp、p=0.45 不显著**，保留关键词基线并公开未胜结论。
5. **工程与训练**：接入 **27 套发布门禁清单**与 **2,000+ 条自动化判据**，以 **15 条注入自检**验证守卫真会红；RL 只做两个窄实验（表格 Q-learning 干预策略、**1,152 参数**工具路由头，**16 条留出 8→15**），不声称完整 Agentic RL。

> CV 只写“接入/清单/数量”，不写“全绿”。面试问答版再补：`test:roco-quality` 77/77；`test:unit` 2,084 条里 2,068 过 / 15 红 / 1 skip（今天实测）；`verify:release` 今天不跑。

## 5. 今天用到的命令（可复现）

```sh
# 288 配对复算（当前 HEAD 产物 vs 文档所述旧产物）
node -e "…按 traj_id 配对 288 条，比较 checks.passed…"   # 结果：_raw-cv-288-pairing.json
git show 1ce56f01:tests/evals/agent-trajectories-model-v1.jsonl > /tmp/model-77a1.jsonl   # 旧产物 sha16=77a1c84f…
node -e "…selftest().cases…"   # 7 条 R1–R7 全红
npm run test:unit              # 2084 / 2068 过 / 15 红 / 1 skip / exit 1
node scripts/roco/status.mjs   # 187 个判据文件
node --test tests/engine.test.js tests/rules.test.js tests/mechanics.test.js   # 33/33 exit 0
node scripts/roco/guard-selftest.mjs --json                   # 15/15 pass
node scripts/roco/eval-rag-retrieval.mjs --json               # heldout 45 / 三套检索器 / probe 13 / gates 14
node -e "import('./scripts/roco/verify-release.mjs').then(m=>console.log(m.SUITES.length))"  # 27
```

**原始证据**：`_raw-cv-288-pairing.json`、`_raw-rag-eval-current.json`、`_raw-test-unit.log`、`_raw-test-roco-quality.log`、`_raw-guard-selftest.json`；完整清单见同目录 `EVIDENCE-LEDGER.md` / `TEST-RUN.json`。
