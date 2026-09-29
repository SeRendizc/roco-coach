# DSH 阶段交接 · 2026-09-29（阶段 3 收工 → 新产品修复对话）

> **谁读这份**：接手的新 DSH 对话（以及 Codex 的逐图验收单）。
> **一句话**：上一程做的是「把每个结论都落到可复验读数上」；用户判定**够了**，
> 新目标是**把玩家看得见的问题真的修掉**，而且**与用户机器上正在跑的那一版对齐**。
>
> **本文档不替代真机读数**：凡我写"实测"的，都给了**可复跑命令**；凡我没跑的，一律写"没跑"。

---

## 0. 现在这一秒的状态（事实，不是叙述）

| 项 | 值 | 怎么核 |
|---|---|---|
| **仓库 HEAD** | **`84a68c8`**（WIP 快照，见 §2） | `git log --oneline -1` |
| **工作区** | **干净**（0 条未提交） | `git status --short` |
| **主服务 8765** | **在跑，且是"**旧代码**"**：`started_at = 2026-09-28T16:36:34.037Z`，**从那时起没重启过** | `curl -s http://127.0.0.1:8765/api/bootstrap` |
| ↳ 静态页 | `200` | `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/box.html` |
| ↳ 新会话 | `200`（**429 已自行解除**：会话表 8h TTL 自然到期；**不是重启**） | 同上 |
| **云端模型** | ⚠ **`configured=true` · `verified=true` · `provider=deepseek` · `model=deepseek-flash`** —— **用户已经把密钥配好了**（此前多轮记录的"云端降级"**已不成立**） | `curl -s http://127.0.0.1:8765/api/bootstrap \| head -c 200` |
| **本地模型网关 8766** | **关着**（`000`） | `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8766/healthz` |
| **后台任务** | **无运行中**（本会话所有 job 都是 completed/killed） | 见 §4 |
| **浏览器锁** | 空闲（最后一次是我清的**陈旧锁**：owner `kill -0` 已失败） | `cat tmp/browser-lock/owner` |

⚠ **密钥相关**：本文档**不含、也不得打印任何密钥**。上面只写"配好了"这个**状态**。
云端是哪一把 key、什么时候配的，都**不要去查**（`~/.zsh_history`、环境变量、`/connect` 的内存态都不许读）。

---

## 1. 🔴 新目标：用户截图上那批**玩家看得见的问题**

用户原话（逐字，作为新目标的输入）：

> 用户截图显示**天分认不出**、**技能两块重复且不解释效果**、**配队全是ID和工程文字**、
> **换人相性丢失**、**重复小芽按钮**、**面板挤且滚动跳**、**问怎么办却要玩家定**、
> **无用主动气泡**、**复盘长条在模态框外**、**格子不填满**、**铠甲虫多实例难读**。

明确的口径（Codex 转述）：
> **「新目标必须是这些玩家问题的实际解决与用户 8765 版本对齐，不是继续查报告数字。」**

### 1.1 逐条：我知道的落点（**给线索，不是给结论**）

| # | 用户看到的问题 | 我这一程查到过的相关事实（**都要重新真机确认**） |
|---|---|---|
| 1 | **天分认不出** | A7 那条修过：二级详情「性格与资质」原来读**服务端 `?detail=` 回执**、而"刷新"按钮写**本机记录** ⇒ 两份互不相干。`task-4` 之后声称"一处真值"。⚠ **但用户现在还看到"认不出"** ⇒ 说明**修得不够或没生效**（注意 8765 跑旧代码）。 |
| 2 | **技能两块重复且不解释效果** | 盒子详情页有四技能区；职业技能效果文案来自 `FROZEN_DESC`（引擎未登记 527/542）。**"两块重复"**很可能是**同一份技能在两个位置各画一遍**（本仓反复出现的"同一件东西两份"）。 |
| 3 | **配队全是 ID 和工程文字** | `team-workshop.js` 的候选行/格子会写 `own-XXXX` / `pet_XXXXXX` / `Lv.` 等工程串；`plain-speak` 判据只管一部分文案。 |
| 4 | **换人相性丢失** | ⚠ **可能与 `task-19`（G1）的修法相关**：`art-finish` 修了"本地那一支用战况"，但**速度/先手类没做**（视图里没有速度字段）。**"相性"**若指属性相性，要看换人建议里有没有带上属性关系。 |
| 5 | **重复小芽按钮** | ⚠ **高可能已修**：`task-12`/`task-13` 把 `#coach-entry` + `#companion-card` 与 `xiaoya.js` **两套小芽**合并；甲④-1（`5c1432f`）移除了 `#companion-card` 整块，实测 `#model-chip` 计数 **1**。**但 8765 未必吃到这版**（见 §3）。**先确认页面上到底还有几个入口**。 |
| 6 | **面板挤且滚动跳** | 没有任何一轮专门量过"面板挤压/滚动跳动"。**新对话要量的第一件事**：打开小芽/配队面板时 `scrollHeight` 变化、`scrollTop` 是否被重置、模态框内外滚动条。 |
| 7 | **问怎么办却要玩家定** | ⚠ **可能就是 `task-19` 修掉的那条**：局中问「我现在该换谁？」原来答 39 字「说一下你的队伍和对手，我按相性挑」= **要玩家先交代**；修后 **402 字**局面型回答（带回合/血量/引擎推荐/合法换人）。**但用户看到的可能还是旧的**（8765 旧代码 / 或还有别的入口）。 |
| 8 | **无用主动气泡** | `art-finish` 量过介入链路：开局 `below-threshold` / 第 2 手 `critical-risk` / 第 3 手 `#hint` 真上屏（`defer_to_review`「这一手值得留到局后看一眼」）。**"无用"**= 门控把不该说的也说出来了？**要把每条气泡和当时的局面一起截图**。 |
| 9 | **复盘长条在模态框外** | 局末复盘卡（`rocoMatchReview`）与模态框的层级/溢出。**没量过**。 |
| 10 | **格子不填满** | 六槽/网格有空格不填？`team-workshop` 的槽位与候选池布局。`build-snapshot` 量过"六格六只"，但**视觉是否填满**没量。 |
| 11 | **铠甲虫多实例难读** | 同一物种多只个体（例：千棘盔 `pet_000271`/`pet_000378`）在盒子/候选里**靠什么区分**。`0781ca0` 给图鉴行加了个体 id、`build-snapshot` 修了六格钩子按**物种**解析 —— 但**"难读"是信息设计问题**，不是钩子问题。 |

⚠ **第 5/7 条我怀疑"已经修了但用户那版没吃到"** —— 参见 §3 的**未部署**清单。
**这决定了新对话的第一件事：确认用户看到的到底是哪一版。**

### 1.2 ⚠ 两条**已经被实测推翻**的旧判断（别再把它们当待修问题）

1. **「记忆丢失 / 她记不住我说的话」—— 不成立。**
   `coach-context` 停手前的最终读数：气泡 `3→5`，`stated=1`、`rows:["称呼：老王"]` ⇒
   **服务端那份记忆照旧记进去了**。早先的 `stated=0` 是他**探针没把第二条发出去**（气泡 `3→3`）。
   ⇒ **记忆的写入者仍然只有服务端那一份**（没有第二个来源，也没有"功能丢失"）。
2. **「她说不出局面」—— 一半已解决。** `task-19` 之后局中问「我现在该换谁？」是 **402 字场面型回答**
   （回合/血量/能量/对手/引擎推荐/合法换人），不再是 39 字反问；**但用户那版可能没吃到**（见 §3）。

---

## 2. WIP 归属（本轮已全部提交为 `84a68c8`，工作区干净）

> 提交它是为了**不丢**，**不是**说它们"做完了"。逐条状态如下。

| 归属 | 文件（要点） | 改到哪一步 | 能不能跑 |
|---|---|---|---|
| **coach-context**（`task-13` **in_progress**） | `src/client/xiaoya.js`、`scripts/roco/demo-acceptance.mjs` 等 6 个脚本 | 甲①②③ 已入库；**④-2 进行中**：脚本改钉（把旧选择器指到活着的那一处）、`xiaoya.js` 的「先判在飞 → 说人话 → **不清空输入框**」；**并撤回了抢跑的记忆写入者**（恢复 `state.memory = answer.memory ?? state.memory;`） | 单测 `roco-xiaoya-context` 27/27；**浏览器读数部分未完成** |
| **build-snapshot**（`task-18` **in_progress**） | `scripts/roco/browser-live-acceptance.mjs`、`browser-mobile-sweep.mjs`、`browser-roco-ux-acceptance.mjs`、`reports/roco/build-snapshot/{scan-probe-lifecycle,verify-probe-session-tool}.mjs` + 两个 json | 探针生命周期（会话有效性/引擎热/宿主 API 就绪/命中测试）**改到一半** | 有 `after-mobile.log` / `after-roco-ux.log` 读数，但**未收口** |
| **battle-smoke**（`task-17` 已交付，本轮入库） | `scripts/roco/agent-trajectories.mjs`、`build-agent-trajectories.mjs`、`shadow-replay.mjs`、两份产物、`shadow-replay-consistency-proof.json`、`BATCH-10` | **完整**：两份产物 header 都有 `policy_first`/引擎版本/源码 hash；一致性证明 **0/288** | ✅ 可跑；`model-trajectories` 6/6、`roco-agent-metrics` 7/7 |
| **art-finish**（`task-16`/`task-19` 已完成） | `reports/roco/art-finish/**`（`inbattle-*`、`G1-局中问答-修前修后.md`）、截图 | **完整** | ✅ 秒级复现：`node reports/roco/art-finish/inbattle-ask-repro.mjs [--drop roco_battle]` |
| **Lead** | `scripts/roco/verify-report-claims.mjs`、`review-candidates.mjs`、`sft-v9-candidates/**`、`scripts/model/train_v9_aligned.py`、`regression-key-questions.mjs` | **完整**（判据 17/17） | ✅ 可跑 |
| **别人的在飞（我未逐行背书）** | `src/client/roco.js`（甲④-1/④-2 相关）、`scripts/roco/battle-smoke.mjs` | 混合 | 以本表与 §5 为准 |

**本仓基线红**（**不是**谁的错，别往人头上挂）：`roco-experience`（12 系别配色）、`roco-team-cards-layout`（1440×900 / 1536×684 两个视口 + wrapper）。**真机/单测里看到这 4 条红 = 基线。**

---

## 3. ⚠ **8765 跑的是旧代码** —— 未部署的修复清单（新对话第一件要确认的事）

**8765 自 `2026-09-28T16:36:34.037Z` 起没重启过** ⇒ **仓库里已修好、但主服务进程里没有的**：

| 修复 | 入库提交 | 8765 吃到了吗 |
|---|---|---|
| 会话表 LRU（满了不再只能重启，`task-15`） | `e227a56` | ❌ **没有** |
| 甲④-1：`roco.html` 移除 `#companion-card`（**只剩一套小芽**） | `5c1432f` | ⚠ **静态文件按请求读盘 ⇒ 这一条很可能已经生效**（HTML/JS 是静态的） |
| `task-19` G1：局中问答用战况（`runtime.js`） | `2dd98a4` | ⚠ **`src/**` 也是静态服务的** ⇒ 大概率已生效（**但要真机确认**） |
| 立绘/P0-04 等更早的修复 | 更早 | 同"静态"逻辑 |

**这里必须分清两类**：
- **静态文件**（`src/client/**`、`src/coach/**`）：服务端**每次请求读盘** ⇒ **改了就可能已经生效**，不需要重启；
- **服务进程内存里的东西**（**会话表**、启动时缓存的 `sessions`/`capabilities` 等）：**必须重启才生效**。

⇒ **新对话第一步（只读，不重启）**：
```sh
# 1) 页面上到底还有几个小芽入口？（重复小芽按钮那条）
#    真机打开 http://127.0.0.1:8765/roco.html，数 #coach-entry / .xy-fab / #xiaoya-open
# 2) 局中问「我现在该换谁？」看回答是 39 字旧句还是 402 字场面型（问怎么办那条）
# 3) 盒子详情「性格与资质」那栏到底显示什么（天分认不出那条）
```
**不要**为了"让修复生效"就重启 8765 —— 用户明确要求**不重启**；
如果新对话判断必须重启，**先问用户**（重启会清掉会话表，也会中断用户正在开着的页面）。

---

## 4. 团队 / 任务卡 / 后台进程（交接时的真实状态）

### 4.1 成员（4 个 durable teammate + Lead）

| 成员 | 角色（本程） | 状态 | 写域（本轮） |
|---|---|---|---|
| `coach-context` | P0-01/P0-05、甲①②③④ | 已收到停止通知 | `src/client/xiaoya.js`、`roco.html`、`roco.js`、`tests/roco-page-ux.test.js`、`tests/roco-xiaoya-context.test.js`、`reports/roco/xiaoya-context/**` |
| `build-snapshot` | 培养贯通、迪莫 6×4、深链、判据修复、会话表、探针生命周期 | 已收到停止通知 | `src/client/box.js`、`team-workshop.js`、`src/coach/individuals.js`、`talent.js`、`scripts/roco/browser-*.mjs`、`scripts/roco/lib/**` |
| `battle-smoke` | B 段冒烟、绞轮负能耗、行动坞一致、B5、产物身份 | 已收到停止通知 | `roco/src/roco_env/**`、`src/server/roco-service.js`、`src/client/roco.js`、`scripts/roco/battle-smoke*`、`scripts/roco/agent-trajectories.mjs` |
| `art-finish` | 立绘收尾、D 组独立验收、G1 | 已收到停止通知 | 只读产品代码；`reports/roco/art-finish/**`、`docs/.../shots/**` |
| **Lead** | 4B 前置、候选审核、跨模块、回归、护栏 | — | 全仓（**提交由 Lead 独占**） |

### 4.2 任务卡

| 卡 | 主题 | 状态 | 负责人 |
|---|---|---|---|
| `task-1` … `task-12` | 立绘 / B 段 / P0-05 / 培养贯通 / 绞轮 / 界面标记 / P0-01 / 迪莫 6×4 / 行动坞 / D 独立验收 / B5 / D①-a | **completed** | 各自 |
| **`task-13`** | 甲：`xiaoya.js` 成**唯一实现**、退役 `#companion-card` | **in_progress**（①②③ + ④-1 已入库；**④-2 未完成**） | `coach-context` |
| `task-14` | `browser-workshop-acceptance` 判据漂移 | completed | `build-snapshot` |
| `task-15` | 会话表满 100 ⇒ 429（LRU 修复） | completed | `build-snapshot` |
| `task-16` | D·独立复验（局中上下文/提示 + 关键 UI） | completed | `art-finish` |
| `task-17` | 产物身份（`policy_first` + 版本）+ 机制缺口 | completed | `battle-smoke` |
| **`task-18`** | 探针生命周期四项 | **in_progress**（改到一半） | `build-snapshot` |
| `task-19` | G1：局中问答不接战况 | completed（**已入库 `2dd98a4`**） | `art-finish` |

### 4.3 后台进程 / 锁

- **本会话所有 bash job：completed 或 killed，无运行中**；
- **`tmp/browser-lock`：空闲**（最后清的是陈旧锁，owner `kill -0` 已失败才清）；
- **8766 网关：关着**（`000`）；**8765：在跑，不许动**；
- ⚠ **浏览器测试前置（用户要求，仍然有效）**：
  ① **不得跑旧 HEAD**（不许 `git show HEAD:` 取旧脚本跑）；
  ② **禁后台联网**（`--disable-background-networking` / `--disable-component-update`）；
  ③ **异常时必须收尾**（`try/finally` 里 `browser.close()`）。
  （我自己的 `scripts/roco/regression-key-questions.mjs` 已按这三条改好，可参考。）

---

## 5. 完成证据（**已入库、可复跑**）与仍未完成

### 5.1 已入库且有读数的（挑与新目标相关的）

| 事 | 提交 | 读数 / 复跑 |
|---|---|---|
| **P0-01**：无密钥也走服务端真资料 | `06b6c51` `3c3cfa9` | `/api/coach` **0 次 → 200**；独立实例 **16/16**；red-proof **11/16（正好红 3 条）** |
| **P0-05/甲**：两套小芽合一 | `ce0332c` `64c64e4` `5c1432f` | 产品页第二套小芽 **2/5 → 6/6**；`#companion-card` **不在页面里**、`#model-chip` 计数 **1**；局中 **`roco_battle=true turn=1`** |
| **G1**：局中问答用战况 | `2dd98a4` | 39 字 → **402 字**；判据 **1/4 红 → 0/4**；反证藏 `state.view` ⇒ 逐字退回旧句 |
| **迪莫 6×4 + 深链** | `8da40b9` | **11 + 4 条判据 0 红**；进战斗那份与屏幕**逐值一致**；`?pet=pet_000112` 256×256 |
| **行动坞与 b3 一致** | `b6043da` | 合法格 **1/4 → 4/4**；反证在真实 DOM 上做（红 5 条逐条点名） |
| **会话表 LRU** | `e227a56` | **26/26** + 必红反证（**未部署到 8765**） |
| **兜底回归修复** | `af1406f` | 未过守卫的模型正文不再端给玩家；玩家路径判据 4/4 |
| **重点失败问句回归** | `ee5abab` | **4/4**（真机 + 网络取证） |
| **跨模块集成** | `83add95` | 一份配招一个事实源 **6/6** |
| **4B 前置** | `fbc29bd` `49f1bb8` `ef6b329` `f49c2a1` `70017cc` `1595584` | 见 §6 |

**截图**：`docs/roco/review-2026-09-28/shots/{coach-context,art-finish,battle,build-snapshot,ui-context}/`
（⚠ `reports/roco/**/*.png` 被 gitignore ⇒ **PNG 一律放 `docs/`**）。

### 5.2 仍未完成（一条不含糊）

1. **`task-13` ④-2**：清旧面板死代码、**真的删掉 `retiredStub` 替身**、`roco-page-ux` 字面量改钉；**6 个脚本的改钉**；
2. **`task-18`**：探针生命周期收口 + 三个脚本的改前/改后读数；
3. **`task-16` 留的三条缺口**：① 有模型那一档**没实测**（**现在用户配好密钥了 ⇒ 这一条现在可测**）；② 速度/先手类建议**没做**（视图没给字段）；③ **G2**：`#plan`/`#auto-turn` 在 DOM 里**不存在** ⇒ **玩家没有手动叫出"这一手怎么打"的入口**；
4. **机制**：实机核验 **0/542**（542 只全 `FROZEN_DESC`）、已实现 **8/542**、战斗中未结算 **295/542**；技能档位（玩家够得到的 181 条）**75/181（41.4%）不是全可模拟**；
5. **`audit-roster-48.py` 已腐烂**（`build_ruleset` 对不上当前 `Ruleset` 签名）—— 本轮**没修**，只记录；
6. **8765 未部署**（§3）；
7. **4B**：候选集**待用户审**；**训练链未接上包装**（§6）。

---

## 6. 4B 训练（**只准备，没训练**）—— 一句话状态

- **四项前置**：1 共享工具集 ✅ · 2 清失效 `inspect_training` ✅ · 3 候选集 🟡**待审** · 4 token 模板 🟡**修法已验证**；
- **候选集**（`reports/roco/sft-v9-candidates/`）：正向 **69**（4 种工具）+ 负向 **24** 隔离 + 派生 **96**（单独放）；
  语义族跨片 **0**；机械 FAIL **0**；**真引擎 49/49 份队伍接受**；输入已带局面（`world`）；
- **模板对齐**：`scripts/model/train_v9_aligned.py`（包装 `enable_thinking=False`）⇒
  `verify-template-consistency.py --with-wrapper` **退出码 0**；入口集成检查 + 参数兼容都过；
  ⚠ **`train_v9.sh` 仍走未包装入口** ⇒ **训练链还没接上**（要用户把入口换掉，**我没改他的脚本**）；
- **没有**：启动训练 / 下载模型 / 改主服务模型 / 生成 `READY.json`。

---

## 7. 🚫 禁止覆盖 / 只能追加的存档

| 路径 | 为什么 |
|---|---|
| `data/**`（尤其 `data/roco/normalized/**`、`data/roco/assets/**`，**864MB**） | 真值数据 + 立绘资产；**只读** |
| `roco/**`（Python 引擎） | 机制真值；改动要走 `npm run test:env` |
| `docs/roco/review-2026-09-28/shots/**` | 真机截图（**PNG 的唯一合法落点**） |
| `reports/roco/**` | 读数产物；**已被提交进 git，别删** |
| `docs/roadmap/DSH-EXECUTION-STATE.md`、`PHASE-2-CHECKPOINT.md` | 台账与断点；`| HEAD |` 行落后 >12 笔会判红（`tests/evals/state-doc.test.js`） |
| `tests/evals/agent-trajectories-*.jsonl`(+manifest) | 轨迹产物（带身份块）；**重建要两份一起**，否则又是两个口径 |
| `docs/roco/review-2026-09-28/codex-healthcheck/巡检记录/**` | Codex 的监工记录，**不要改** |

**"改钉不删"是硬规矩**：改判据时**旧断言原文留在注释里** + 日期 + 依据。

---

## 8. 下一步（新对话建议顺序，**都与玩家问题对齐**）

1. **先确认用户看到的是哪一版**（§3 的三条只读命令）—— 因为第 5/7 条问题**可能已经修好但没生效**；
2. **按 Codex 的逐图验收单**逐条复现用户的 11 个问题，**每条都要：截图 + 当时的状态 + 是不是当前 HEAD 的行为**；
3. 修的时候守住本仓的规矩：**判据量屏幕**、**反证必须实测会响**、**改钉不删**、
   **同一件东西只有一份实现/一个名字**（这一程最贵的债就是"两套"）、**不重启 8765**、
   **浏览器测试前置三条**（不跑旧 HEAD / 禁后台联网 / 异常必收尾）；
4. **新目标要"可证伪"**：每条问题以**用户能重新截图确认**为完成标准，不以"判据绿"为准。

---

## 9. 交给新对话时的三条提醒（我这边的教训，别重复）

1. **"看起来在检查"和"真的会响"是两件事** —— 我这一程造过一条**摆设护栏**（用 `doc.includes(数字)` 核文档，
   把数字改旧它照样绿），是**反证**把它抓出来的；
2. **写"实测"就要能当场复跑出那个数** —— 我至少 6 次把"看起来应该"写成"实测"
   （只读一个文件就断言"给不出"、只验一半、把两个集合当一个）；
3. **交付分两类写清楚**：**静态文件改了就可能已生效**；**进程内存里的必须重启才生效**。
   别把"仓库修好了"说成"用户的页面好了"—— 这一条用户最在意。


---

## 10. 团队**自报**的断点状态（收到谁就写谁；没回的如实标"未回"）

### 10.1 `battle-smoke`（`task-17` 已交付；**已停手**）

- **残留**：**8766 已停回原状**（`/healthz` → `000`，`gateway.pid` 不存在，无 `local-gateway`/`serve_mlx`/`roco_env` 进程）；
  **8765 一个请求都没发过**；**后台任务 0 个**。
- **他的未提交（本轮已由我一起提交为 `84a68c8`）**：`agent-trajectories.mjs`（身份块**共用一处实现**）、
  `build-agent-trajectories.mjs`、`shadow-replay.mjs`、**两份产物重建**、`agent-metrics.json`（派生重算）、
  `BATCH-10`、`shadow-replay-consistency-proof.json`、两份**改前留档**、`shadow-replay-proof-generator-1world.jsonl`(+manifest)。
- `task-9` 遗留：`scripts/roco/battle-smoke.mjs`（**+7 行**，把 `--dock-parity` 做成默认不跑的可选步）。
- ⚠ **他明确更正**：**工作区里 `src/client/roco.js` 那点改动不是他的**
  （是 `demo-acceptance` 实测抓到的**替身游离树**缺陷修复：`sayWritePlayerLine` 的 `insertBefore` 会抛 `NotFoundError`）。
  **别记到他头上。**
- **五条未完成（照抄）**：
  1. `policy_first` **只做到"记下来"**，两份都是 `false`；政策覆盖面（**918/1752** 有意见、**404** 落在"零调用判失败"512 条里）
     是 `policyFor` **静态算的，不是通过率**；
  2. `engine_modules` 本机 `/health` 不报 ⇒ 如实写 `null`（没编空数组）；
  3. 两份产物都是 **`dirty: true`**（未提交工作区跑的）⇒ 入库后重跑会翻 `false`；
  4. **实机核验仍是 `0/542`**；
  5. 新列两类缺口（`EV-ENERGY-CHARGE`、`skill_000246/000378/000418` 自带回能时序）
     **只给了"引擎按什么口径兜底"，没核这两个口径本身对不对**（`MC-E02` / `MC-007` 未录制）。
- **底账**：① **542/542**（引擎侧）· **542/542**（入口侧）｜② 已实现 **8/542**、**实机核验 0/542**、
  未结算 **295/542**｜技能档位全库 860 条 `539/305/16`、**玩家够得到的 181 条 `72/3/106`（41.4% 不是全可模拟）**｜
  一致性证明 **重建前 0/288、重建后 0/288**（断言一字未改）｜roco 子集 **1281/1285**，**4 条全是基线红**。

### 10.2 `art-finish`（`task-16`/`task-19` 已完成；**已停手**）

- **没有一行未提交的代码**：`src/ scripts/ tests/` 工作区干净（G1 在 `2dd98a4`，立绘在 `1424eb3`）。
- **未提交的只有 5 个 PNG**（最终一轮重跑的截图，**已随 `84a68c8` 入库**）：
  `shots/art-finish/inbattle-01-coach-ask.png`、`inbattle-01b-coach-ask-after-red-control.png`（新增）、
  `inbattle-02-battle-hint.png`、`shots/ui-context/ui-06-mobile-workshop.png`、`ui-07-xiaoya-answers.png`。
- **进程/端口**：他的脚本与 Chrome **0 残留**；他起过的 8 个独立实例端口
  （61234/60896/59778/56813/56400/55929/55321/54715）**全部已关闭**。
- **⚠ 诚实补充**：整个会话里 **task-1 时期**按当时规程用 `serve.mjs --restart` **重启过一次 8765**，
  **此后一次都没有**。（也就是说：8765 的 `started_at` 是那次之后的值。）
- **五条未完成（照抄）**：
  1. **有模型那一档没实测**（当时云端未连）—— ⚠ **现在用户已配好密钥 ⇒ 这一条现在可测**；
  2. **速度/先手类建议没做**（`roco_battle` 视图里**没有速度字段**，不编）；
  3. **G2 没动**：`#plan` / `#auto-turn` 在现版 DOM 里**不存在** ⇒ 玩家**仍无"手动叫出提示"的入口**；
  4. **「无用主动气泡」只量到行为、没做成判据或修复**（他记了门控三种表现：
     `below-threshold` 静默 / `critical-risk` / `defer_to_review` 上屏）；
  5. **8765 主服务本身没验**（task-16 边界：读数全来自独立实例）；云端档下 ④ 相关性无法验。
- **复核入口**：`node reports/roco/art-finish/inbattle-ask-repro.mjs`（含 `--drop roco_battle` 红方向）；
  交接材料 `reports/roco/art-finish/G1-局中问答-修前修后.md`、`BATCH-07`、`BATCH-09`。

### 10.3 `coach-context`（`task-13` in_progress）—— **已停手并报全**（含一条**推翻性更正**）

**工作区 0 条未提交**（他的改动都在 `84a68c8` / `f490412` / `f5dafee` 里）。逐条：

| 文件 | 说明 | 状态 |
|---|---|---|
| `src/client/roco.html` | 甲④-1：移除 `#companion-card` 整块，入口保留 | 能跑（boot 干净） |
| `src/client/roco.js` | `mountRocoXiaoya({contextProvider})`、入口开/关浮层、`rocoDemo.companionVisibility()/renderCompanion()` 按 (i) 转真实状态、旧面板 6 个画法早退守卫、`retiredStub` 替身（**已改成同一棵游离树**，修掉 `insertBefore` 崩溃）、审计高 11 那套仍在（**死绑定**） | 能跑（**局中 9/9**，独立实例） |
| `src/client/xiaoya.js` | 甲②①/②②/③ 搬迁 + 宿主 `contextProvider` 口 + `handle{isOpen,open,close,render}` + 审计高 11 飞行守卫；**记忆那处抢跑修改已撤回**（审计过程留注释） | 能跑，单测 27/27 |
| `scripts/roco/demo-acceptance.mjs` | 旧面板选择器改钉到**活着的浮层**、禁浏览器缓存、**加前置读数「气泡数必须涨」** + `--red-proof` | **128 通过 / 2 失败** |
| `tests/roco-battle-panel-static.test.js` | 审计高 11 判据**改钉不删** | 7/7 |
| `tests/roco-xiaoya-context.test.js` | ⑯–⑳ 结构钉 + 两处改钉 | 27/27 |
| `reports/roco/xiaoya-context/*.mjs` | 探针：`--own-server`、持久 profile、每轮清 cookie、等引擎热 | 能跑 |

**跑法**：`node scripts/roco/demo-acceptance.mjs` —— 它自己 `createCoachServer + listen(0)`（随机端口，如 `127.0.0.1:59363`）；**独立实例；8765 全程未碰**。

#### ⚠⚠ **最重要的一条更正读数**（他停手前刚拿到，**推翻了我 §1.1 与之前的判断**）

```
⓪ 前置：气泡 3→5 ✔
记忆：「玩家说过的话会出现在『她记住了什么』里」ok=true
      detail={"hook":"1","rows":["称呼：老王"],"stated":1,"statedLabels":["称呼：老王"]}
```
⇒ **「真功能丢失」完全不成立**：走浮层说「以后叫我老王」，**服务端那份记忆照旧记进去了**。
早先的 `stated=0` 是**他的探针把浮层 toggle 关了**导致第二条没发出去（`气泡 3→3` 就是证据）。
⇒ **他据此撤回那处抢跑的产品修改是对的**；**记忆的写入者仍然只有服务端那一份**（没有第二个 remembered 来源）。

#### 他没做完的（照抄，一条不含糊）

1. `demo-acceptance` 剩 **2 条红**：①「忘掉一条之后列表里真的没有了」（忘掉那步要改钉到浮层）；
   ②「④ 真鼠标打开小芽弹窗 + 按原路径要一份建议」（**`#plan` 那条老链路，链接在已被删的 `#plan`/`.battle-tools` 上**）；
2. **前置读数的必红反证没跑**（`--red-proof` 开关已写好、**未执行**）；
3. **其余 5 个浏览器脚本未改**（`browser-coach-agent-acceptance` / `browser-battle-coach-acceptance` /
   `browser-battle-feedback-acceptance` / `capture-battle-evidence` / `eval-five-minute-chain` / `cdp-companion-lines.js`）；
   三个 `tests/`（companion-contract 9 / coach-activity 2 / page-ux 1）**未逐个核实**"注释 vs 真读 DOM"；
4. **④-2 未做完**：旧面板死代码未清、**`retiredStub` 替身必须删掉**（它现在不抛了，但按纪律要清）、
   `roco-page-ux` 字面量钉未改；
5. `task-19`(G1) 不在他这儿。

#### 残留

**他无后台任务**；**`tmp/browser-lock` 现在不存在**（无锁）；**机器上有 26 个 headless Chrome** ——
他**无法归属**（可能是队友在跑或历史残留）⇒ **没杀**，留给接手人按人核实。

### 10.4 `build-snapshot`（`task-18` in_progress）—— **已停手并报全**（含**接手关键信息**）

**工作区 0 条未提交**（他的改动都在 `84a68c8` 里）。

| 路径 | 一句话 | 能不能跑 |
|---|---|---|
| `scripts/roco/lib/probe-session.mjs`（**新，311 行**） | 共用探针工具：专用 profile 守卫 / 页面侧会话握手（**形状分类**）/ 宿主 API 就绪 / 命中测试 | **能跑**，A–E 五条自证全绿 |
| `scripts/roco/browser-mobile-sweep.mjs` | 改用共用工具 | **能跑到底**：判据 8/10、反证 9/9 |
| `scripts/roco/browser-roco-ux-acceptance.mjs` | 同上 + 命中测试从"只记录"升级成"断言" | **跑不到底**：握手 OK 后死在 **`#say-input`** |
| `scripts/roco/browser-live-acceptance.mjs` | 同上 | **跑不到底**：死在 **`#compare-lock-team`** |
| `reports/roco/build-snapshot/{scan-probe-lifecycle.mjs, probe-lifecycle.json}` | **四项中招表**（**35 个文件**逐脚本） | 完成 |
| `reports/roco/build-snapshot/{verify-probe-session-tool.mjs, probe-session-tool.json, verify.log}` | 工具 A–E 自证（含"故意造错"） | 完成 |
| `reports/roco/build-snapshot/{after-mobile.log, after-roco-ux.log}` | 三个脚本改后读数 | 完成 |
| 重新生成的 `reports/roco/rc505/mobile-sweep.json`、`reports/roco/live/live-acceptance.json` | 带 `probe` 块 / 判据 2/3 fatal | 已落盘 |

**工具自证读数（A–E）**：A profile 守卫 **2/2** 非法路径被拒（含**用户真实 Chrome 路径**）；
B 正常握手 `ok`（引擎等 **234ms**）；C **故意留旧 cookie + 旧 csrf** ⇒ 报 **`session-invalid`**
（bootstrap 200 自愈、**POST 403**）；D 允许自愈 ⇒ `ok` + `stale-cookie-cleared`；
E 宿主 API 不存在的超时**如实报 712ms**；
**被盖住的按钮退回 `via=js-click hit=false`（记账，不假装真鼠标）**、正常按钮 `via=mouse hit=true`。

#### ⚠ 接手最关键的一条：**两个脚本跑不到底，根因是产品侧 DOM 早改了、探测点没重钉**

| 旧探测点 | 现状 | 影响的脚本 |
|---|---|---|
| `#say-input` / `#say-form button` | 已被 `RETIRED_COMPANION_IDS` 退役；**新的是 `#xiaoya-input` / `#xiaoya-form`** | `roco-ux` 死在 `#say-input`；`mobile-sweep` 的 `tapScope` 下限 4 也因它消失而红 2 条 |
| `#compare-lock-team` | 比较 UI 早在 **`49e7c50`** 整个拆掉 | `live-acceptance` **第一步就死** |

**他做了对照证明与他的改动无关**：把 HEAD 版脚本复制到 `tmp/probe-before/` 镜像里各跑一遍，
**红的一模一样**（8/10、同样死在 `#say-input`）；`live-acceptance` 是文本证据
（HEAD 版 `:405/:408` 就在点它，产品里只剩一句"已删掉"的注释）。
⚠ **`tmp/probe-before/` 他已删除**（避免以后有人跑旧 HEAD —— 符合"不得跑旧 HEAD"）。

#### 他没做完的（照抄）

1. **两个脚本的探测点没重钉**（`#say-input`/`#say-form button` → `#xiaoya-input`/`#xiaoya-form`；
   `#compare-lock-team` 已不存在）—— **修这三处（改钉不删）就能给 `coach-context` 的 (i) 取证**；
2. **`launchProbeChrome` 还没加测试前置两条**（`--disable-background-networking` / `--disable-component-update`）；
3. **异常路径的 Chrome 收尾还没兜底**（`main()` 抛错时不保证 `browser.close()`；工具里也**没有** `finally`）
   —— 他这次 `roco-ux` 崩溃就留下过一个用专用 profile 的 Chrome（**已手动清掉**）；
4. `BATCH-11-探针生命周期.md` **没写**（被叫停）；
5. **四项中招表已出（35 个文件）**：①临时 profile **30**、②无会话握手 **29**、③不等宿主 API **13**、④无命中测试 **12**
   （判定用的是**写明在报告里的正则启发式**）；但**只改了这三个脚本**，其余 32 个（含他自己那 3 个真机判据脚本）没动；
6. `tests/` 里**没有**给这个工具补单测（靠 A–E 自证覆盖）。

#### 他自己在自证过程中**抓到并修掉的三个工具坑**（下一程直接用得上）

1. **Node `fetch` 不带浏览器 cookie** ⇒ 会造出**假阴性**（以为会话无效）；
2. **持久 profile 里残留 `DevToolsActivePort`** ⇒ `ECONNREFUSED`；
3. **残留 `SingletonLock`** ⇒ Chrome **直接拒启**。

⇒ 也就是说："持久 profile"这条路**还有别的脏东西**要清 —— 不只是 cookie 与 localStorage。
接手时若看到类似的怪失败，**先怀疑这三样**。

#### 残留

node 进程 **0**（早前一个 detached 残壳 `42356` 已 `kill -9`）；
用他专用 profile 的 Chrome **0**；`tmp/browser-lock` **空**；
⚠ 他如实记了一次：**有一次 `mobile-sweep` 是在无锁状态下跑的**（他的锁中途被人当陈旧锁清过）。
**别人的 Chrome 一律没碰；8765 未重启、未清数据。**

### 10.5 锁与环境（交接时）

- `tmp/browser-lock`：**owner `44129`，`kill -0` 已失败 ⇒ 陈旧锁**（`art-finish` 按"只删自己的"没删）。
- `pgrep` 能看到**约 28 个 headless Chrome**（**归属不明**，`art-finish` 分辨不出、没碰）。
  ⚠ 新对话**接手时先看这批 Chrome 是不是残留**（`ps -o ppid= -p <pid>` 看父进程），
  **不要盲目 kill**（可能有队友的实例在里面；但若父进程是 1 且没有对应端口，就是孤儿）。
