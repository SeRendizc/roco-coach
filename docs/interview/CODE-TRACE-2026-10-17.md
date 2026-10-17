# CODE TRACE · 一条真实请求的 8 跳取证（「这回合我该换谁？」）

> **基线**：仓库 `/Users/serendizc/Developer/roco-coach`，`git log -1` 实测为
> `commit 2e62a73b82ecd0c998fca4ddcd1b7206e4570365`（2026-10-06，公开 commit）。
> **追踪对象**：六宠对局页（`/roco.html`）右下角小芽聊天里，玩家发一句 **「这回合我该换谁？」**。
>
> **证据等级（全文统一）**
> - **【实测】** 本机跑出来的输出（命令与截取见 §5，均可复现；不调用付费模型）。
> - **【读码】** 从当前 commit 源码读出来的行为（给出 `文件:行`，行号均为现查）。
> - **【文档】** 仓库既有文档的原话（**可能过期**，§7 专门记矛盾）。
>
> **只读承诺**：本文没有改任何源码；本任务只新增本文这一个文件（`docs/interview/` 下其他文件是队友产出）。
> 唯一的自制探针在 `/tmp/trace-roco-swap.mjs`（不在仓库、不发网络、不起服务端、provider 是本地假实现）。
>
> 与 `docs/interview/SECOND-ROUND-PACK-2026-10-17.md` §2 的分工：那份是 8 跳**概览**；
> 本文是**逐跳取证版**——每跳的输入/输出/失败语义/身份保证，加可复现输出与现场可改点，
> 用来扛「你顺着这个请求走一遍代码给我看」这一类追问。

---

## 0. 先给结论：6 个宏观跳（面试白板上就写这 6 行）

| # | 跳 | 一句话 | 主落点 |
|---|---|---|---|
| 1 | 浏览器提交 | 小芽聊天把玩家原话 + 六宠公开快照 + 局面身份发出去 | `src/client/roco.js:6213` → `:5917` → `:5985-5992` |
| 2 | HTTP 边界 | 来源/CSRF/会话 → 形状校验 → 身份（stateToken）判缓存/合并 | `src/server/index.js:964-971` → `:992-1013` |
| 3 | 装配 + 入口 | 服务端注入「按 battle_id 读引擎估值」的能力，再进 `runCoach` | `src/server/index.js:1067-1088` → `src/coach/runtime.js:2252` |
| 4 | 政策决定 | **该不该调工具由代码定**：六宠建议问句强制 `simulate_branch` | `src/coach/runtime.js:2678-2692` → `:2991` → `:3032-3034` |
| 5 | 工具循环 + 落地 | 首枪政策直调，模型最多再规划 2 次；工具到服务端会话取**引擎算的**走法结果 | `src/coach/runtime.js:4460-4561` → `src/coach/toolbox.js:557/591-612` → `src/server/index.js:1067-1077` → `src/server/roco-service.js:2920-2960` |
| 6 | 守卫 + 交付 + 渲染 | 三重核对 → 一次纠错 → 仍不过就回退已核验正文 → 前端复核身份再上屏 | `src/coach/runtime.js:2727-2748` → `:2777-2816` → `:2913-2919` → `src/server/index.js:1089-1098` → `src/client/roco.js:5993-6029` |

一句话版本：

> **页面送「局面 + 身份」→ 服务端校验形状与身份 → `runCoach` 里政策先决定必调 `simulate_branch`
> → 工具拿 `battle_id` 去服务端会话请引擎算 → 回执进证据包 → 模型只按回执措辞
> → 数字/引用/因果过不了守卫就整句降级 → 前端再核对一次局面身份才显示。**

---

## 1. 为什么选这一句：它同时命中「建议层」和「政策层」

**选句理由（实测过的三条）**

1. 它是六宠页真实会出现的问法，且**两层独立代码都认**：
   - 建议层：`rocoAdviceAsk('这回合我该换谁？') === true`（`src/coach/coach-advice.js:1027`）；
   - 政策层：`policyFor(...).need === 'simulate_branch'`，`reason === 'roco-battle-advice'`（`src/coach/runtime.js:2991` / `:3032-3034`）。
2. 它强迫走**完整工具链**：首枪不是模型挑的，是政策直调（`runtime.js:4489-4504`），
   且工具真的落到服务端会话/引擎（`src/server/index.js:1067-1077`）。
3. 它有**现成测试覆盖**（§5）：`tests/roco-battle-context.test.js` ⑥、`tests/coach.test.js:62`、
   `tests/roco-advice-u08.test.js` 的端到端 HTTP 用例。

**说法边界（现场最容易翻车的点，全部【实测】）**

| 玩家原话 | `policyFor().need` | `reason` | `rocoAdviceAsk` | 后果 |
|---|---|---|---|---|
| 这回合我该换谁？ | `simulate_branch` | `roco-battle-advice` | true | 政策首枪 + 建议层正文，**走完 8 跳** |
| 我现在该换谁？ | `simulate_branch` | `roco-battle-advice` | true | 同上 |
| 我该换谁？ | `null` | `state-in-packet` | true | 建议层仍给确定性首选；**工具 0 次**（`agentStop:'policy-no-tool'`） |
| **我只能回血吗** | `null` | `state-in-packet` | **false** | 建议层都不接，工具 0 次 |
| 这回合该怎么打？ | `simulate_branch` | `roco-battle-advice` | true | 同主链路 |

> **⚠ 文档矛盾 #1（面试可主动讲）**：`docs/INTERVIEW-GUIDE.md:17` 用「我只能回血吗」当 ReAct 例子，
> 说 Agent 会「先读双方状态 → 调用行动比较 → 必要时查防御例外」。**当前 commit 上这句话一次工具都不调**
> （实测 `policyFor` 判 `state-in-packet`，`rocoAdviceAsk` 为 false）。它只出现在两份面试文档里，
> 仓库里没有任何测试用这个原句。**别在面试里拿这句当工具链例子**；要讲工具链就讲本文这句
> （或「这回合该不该换宠？」「现在该防御还是出招？」）。

---

## 2. 八跳逐跳（每跳：输入 / 输出 / 失败 / 身份与版本）

### 跳 1 · 浏览器：提交与请求体（`src/client/roco.js`）

| 项 | 内容 |
|---|---|
| 入口 | `#say-form` 的 `submit` 监听 `:6213`；在飞时拒绝第二条并**不清输入框** `:6219-6221`；`say(typed)` `:6225` |
| 包装 | `say()` `:5901`：置 `state.coachInFlight`、按钮 disabled/aria-busy，`finally` 复位 `:5906-5914` |
| 主函数 | `sayOnce()` `:5917`；先算 `initialStamp` `:5918`，打开陪练栏 `:5921` |
| 本地兜底 | 先本地 `chatReply` 出一句离线回复 `:5934-5937`；接了模型时先显示「小芽在查证…」`:5945`；把玩家那句写进对话体 `:5947`；同步可见性 `:5954`（这是「回答必须看得见」的落点） |
| 请求体 | `:5973-5977` 取 `coachRocoBattle()`（六宠公开快照）与 `coachRocoPlan()`；`coachCampContext()` 作基底（`mode:'camp'`、`battle:null`，见 `:5532-5561`）；`:5983-5984` 挂当前聚焦对象；`:5985-5992` `POST /api/coach`：`{message, role:'companion', context, memory, conversation: 最近 6 条, stateToken}` |
| 传输 | `api()` `:317`：`fetch` + `X-Coach-CSRF` `:320-325`；403 时重新 bootstrap 并**重试一次** `:326-330`；非 2xx 抛错 `:332-334` |
| 输出 | 一个 HTTP POST（30s 超时，`AbortSignal.timeout(30000)` `:324`） |

**失败语义**

- 上一条还在飞：直接 `sayStatus('上一条还在查…')` 并保留输入，**不发第二个请求**（`:6219-6221`）。
- 服务端 403（会话失效）：`api()` 重新 bootstrap 后重试一次；仍失败 → 抛错 → `sayOnce` 的 `catch` `:6031-6037`
  把离线回复 + 「（模型这一步没答上来：…）」显示出来，并写 `dataset.rocoCompanionBoundary='model-failed'`。
- 没配模型密钥：**不再提前 return**（旧写法已废，`:5961-5968` 留档），只标 `boundary='no-model-credential'` `:5969`，
  请求照发（服务端本地档仍能查资料）。
- **迟到答案**：`:5993-5996` 用 `requestStamp` 与**当前** `coachBattleStamp` 比对，局面变了就丢弃并提示
  「局面已经变化，这条迟到的回答已作废」；catch 里再比一次 `initialStamp` `:6032`。

**谁保证身份/版本一致**

- `battle_id` 来自 `/api/roco/battle/new` 的响应（`:4945` `state.battleId = data.battle_id`）。
- `coachStateToken()` `:4966-4972`：`roco:<battleId>:<state_version>:<turn>`（`state.view.state_version` 优先，
  否则规划里的；都没有才用回合数兜底）→ 发给服务端的 `stateToken` 就是**局面身份**。
- `coachBattleStamp()`（`src/coach/coach-advice.js:1653-1657`）：`JSON.stringify([battle_id, state_version, turn,
  self_active, phase, result])` → 前端前后各比一次，防「答案换了局面」。

### 跳 2 · HTTP 边界：/api/coach（`src/server/index.js`）

| 项 | 内容 |
|---|---|
| 路由 | `:992` `if(path==='/api/coach')`；`/api/coach` 是 POST 分支，前面已过总闸 `:964-971` |
| 总闸 | 只收 POST `:964`；`Origin` 必须等于本机 origin 且 `Content-Type: application/json` `:965`；会话 + `X-Coach-CSRF` `:966-967`；`touchSession` `:970`；读 body `:971` |
| 形状 | `validateChat(b)` `:993`（定义 `:227`）：消息 1..1000、role ∈ {auto,strategist,teacher,companion} `:228`；`context.mode` ∈ {camp,pve,pvp-local,pvp-live} 且 `profile.pets` 存在、`memory.version===1` `:230`；**六宠战况**白名单校验 `:330-413`（错误一律带「六宠战况无效：…」）；**规划**校验 `:417-424`（`state_version` 必填，且与 `roco_battle.state_version` 不一致直接 400） |
| 身份 | `cacheIdentityOk = stateToken 非空` `:1002-1003`；缓存 key `answerCacheKey({stateToken, role, message, context, model, rulesVersion})` `:1004-1005`（实现 `src/coach/answer-cache.js:43-57`，只取 `context.mode/rulesetConfigId/rulesVersion` 等身份字段） |
| 缓存/合并 | 命中 → `:1008-1009` 直接回 `{...cached, cache:'hit'}`；同 key 在飞 → 等它（`:1011-1013`）；**没有 stateToken 不读缓存、不合并**（宁可多花一次钱）`：1006-1013`；不同 key 且有请求在飞 → 429 `:1015` |
| 输出 | 校验后的请求体 + 缓存命中结果（或进入跳 3） |

**失败语义**

- 403：来源/类型/会话/CSRF 任一不对（`:965-967`）。
- 400：`validateChat` 逐项点名（例：`六宠战况无效：battle_id`、`本回合规划无效：与战况不是同一版局面（规划 X / 战况 Y）`）。
- 429：已有请求在飞且不是同 key `:1015`。
- 同 key 首个请求失败：`finally` 里给等待者结算一条 `{ok:false,dedupFailed:true,...}`，**不让它挂到 45s 超时**（`:1099-1107`）。

**谁保证身份/版本一致**

- `stateToken` 是缓存/合并的唯一身份（缺它 fail closed，`：1002-1003`、`:1096`）。
- 跨字段版本：`roco_plan.state_version` 与 `roco_battle.state_version` 必须一致 `:417-424`。
- 响应体把 `stateToken` 原样回传 `:1089`，前端/评测可核对。

> **⚠ 读码发现**：`roco_battle` 的校验是「逐字段校验」而**不是未知键白名单**。
> 实测：`foe_bench` 里多带 `pet_id`、顶层多带 `evil_field`、pet 行多带 `pet_secret_stat` 三种输入
> `validateChat` **全部放行**（3/3）。文档 `tests/roco-battle-context.test.js:12` 说这条由「② 的未知键口径」守着，
> 但 ② 里没有未知键用例。这意味着：**新增字段不需要改白名单也会静默进包**——
> 见 §6 改点 ③ 与 §7 矛盾 #6。

### 跳 3 · 装配 + runCoach 入口（service → runtime）

| 项 | 内容 |
|---|---|
| 云端 provider | `:1022-1033`：`plan` 走 `complete(plannerSystem, JSON.stringify(task), 160, 2500)` `:1027`；`generate` 把系统提示 + 历史 + `{player_message, role, preference, recent_messages, game_evidence: packet}` 送给 `complete(messages, 320, 8000)` `:1029-1032` |
| 引擎读口 | `:1067-1077` `rocoPreview=async(battleId)=>rocoService.planBattle({battle_id:battleId})`；成功时只挑 12 个字段（`battle_id/state_version/recommendation/.../note`），失败返回 `{missing:true, reason}` |
| 兄弟读口 | `:1084-1085` `rocoActionView`（有 `battle_id` 才注入；`plan_actions` 工具用） |
| 合成上下文 | `:1086-1087` `coachedContext = {...attachIndividualsToContext(b.context), rocoPreview, ...(rocoActionView?{rocoActionView}:{})}` |
| 入口 | `:1088` `runCoach({message, role, context: coachedContext, memory, conversation: historyForModel(b.conversation), provider})` |
| runCoach 头 | `src/coach/runtime.js:2252`；`routingText` 只认玩家原话（`:2265-2268`）；`route` 初值 = role，auto 时按关键词/情绪判（`:2526`）；线上竞技硬拒在 `:2330` |

**输出**：`runCoach` 返回的 answer 对象（下一跳开始产生）。

**失败语义**：`runCoach` 抛错 → 外层 `catch` `:1183-1189`：带 `status` 的回状态码与消息；**无 status 一律 500**「本地服务无法完成请求」，堆栈只进服务端日志（详情不吐给玩家）。

**谁保证身份/版本一致**

- 规划与战况必须同版：`runtime.js:2570-2572` `planSameVersion`（`roco_plan` 或 `roco_battle` 缺 `state_version` 也视为一致；都有则必须相等），不同版则**整条丢规划、只用战况** `:2572`。
- `rocoPreview` 只信 `battle_id`，具体那一局由**服务端会话**决定（下一跳细讲），客户端塞不进私有 state。

### 跳 4 · 政策：该不该调工具（`src/coach/runtime.js`）

| 项 | 内容 |
|---|---|
| 触发条件 | `:2678` `if(useModel && provider.plan && (['strategist','teacher'].includes(route) || policyFor(message,context).need))` —— 路由决定语气，**证据需求由政策决定**（注释 `:2675-2677` 说明这里曾经漏过） |
| 政策函数 | `policyFor()` `:2991`；六宠建议分支 `:3032-3034`：`context.roco_battle` 存在 + `!isLiveMatch` + `battle_id` 是字符串 + 正则（`这回合|这一回合|现在该|该不该|该怎么打|怎么打|出招还是|防御还是|换宠还是|要不要换|该攻还是该守`）→ `{need:'simulate_branch', reason:'roco-battle-advice'}` |
| 参数构造 | `defaultArgsFor('simulate_branch',...)` `:4379`/`:4436-4443`：`resolveMentionedActions(text, context.battle)`；六宠页 `context.battle===null` ⇒ `{candidates:[], unresolved:['未识别的动作']}`（交给工具按 `battle_id` 走引擎） |
| 版本注入 | `withRuntimeStateVersion()` `:3166-3173`：只有**合同里声明了 `state_version`** 的工具才会补；`simulate_branch` 合同没有这个参数（`src/coach/toolbox.js:148`），所以此处原样返回 |
| 传给规划器 | `:4508` 的 plan task 里带 `hardRequired: requiredTool(message,context)`（`:3174` = `policyFor().need`）与 `hard: HARD_TOOLS`（`toolbox.js:22`，只含 `read_evidence/simulate_branch/read_match` 三个硬工具） |
| 输出 | 把 `{...,toolTrace,agentStop,toolPolicy}` 并进 packet `:2688-2689`；若政策说不用调 → `toolTrace:[]`, `agentStop:'policy-no-tool'` `:2690-2692` |

**失败语义**

- `policy.need === null`：**根本不进工具循环**（`:2690-2692`），不是「模型不想调」。
- 政策判了工具但 `provider.plan` 不存在 / 非模型档：走 `policy-route-without-tools` `:2698`（旧 bug 的止血位，注释 `:2675-2677` 留档）。

**谁保证身份/版本一致**：`battle_id` 是强制前置（`:3032`）；线上竞技 `isLiveMatch` 双重排除（`:3032` 与 `:4461`）。

### 跳 5 · 工具循环：首枪政策、之后模型（`src/coach/runtime.js`）

| 项 | 内容 |
|---|---|
| 入口 | `gatherAgentEvidence` `:4583-4586`：默认 `limit=3`；`gatherAgentEvidenceOnce` `:4460`（同样默认 3） |
| 硬门控 | `:4461` `if(isLiveMatch(context))return {trace:[],stopped:'policy'}` |
| 纠错券 | `:4477-4487`：**全局 1 张**；失败做成错误回执（`chosenBy:'correction'`）再让规划器改一次 |
| 首枪（政策） | `:4489-4504`：合同存在性 `:4490`；`defaultArgsFor` + 版本注入 `:4491`；参数构造不出 → 写「无记录」回执（不伪造回合号）`:4492-4496`；`validToolArgs` `:4498`；`runTool` `:4499`；回执 >10KB → `receipt-budget` `:4500`；**`chosenBy:'policy'`** `:4501` |
| 循环 | `:4505` `for(let i=trace.length; i<Math.min(4,limit); i++)`；`:4508` 调 planner（task：`message/screen/tools/contracts/hard/hardRequired/receipts/remaining`） |
| 停止 | planner `stop:true` → `complete`；`planProvider.lastDecision.reason==='unparseable'` → `planner-json-invalid`（`:4516-4522`）；planner 抛错按 `error.code` 分 `planner-timeout/planner-cancelled/planner-failed`（`:4509-4515`） |
| 循环边界 | 工具名不存在 `:4528-4531`；参数非法 `:4533-4536`；重复 `(tool,args)` `:4538-4541`；工具执行抛错（`policy` 不纠错，其它给一次纠错）`:4543-4547`；回执预算 `:4558`；用满 → `tool-budget` `:4561` |
| 覆盖度强制 | `:4587` 默认关，仅 `ROCO_COVERAGE_FORCE=1` 时在模型停手后补缺的来源（`:4595-4614`） |
| 输出 | `{trace, stopped}`，并进 packet `toolTrace/agentStop/toolPolicy`（`:2688-2689`） |

**【实测】本句的循环（`/tmp` 探针 B 段）**

```
planner 被调用 2 次：[{"receipts":["simulate_branch"],"remaining":2,"hardRequired":"simulate_branch"},
                     {"receipts":["simulate_branch","read_state"],"remaining":1,"hardRequired":"simulate_branch"}]
stopped=complete  trace=2
  - tool:1 simulate_branch chosenBy=policy  args={"candidates":[],"unresolved":["未识别的动作"]}
    result.engine=six-pet-rules state_version=41 turn=8 recommendation=风刃
  - tool:2 read_state   chosenBy=undefined args={}
rocoPreview 被调用次数=1 参数=["s1-trace"]
```

要点：**首枪是政策（`chosenBy:'policy'`）**；模型只决定「还要不要查」（第 2 步它要了 `read_state`，第 3 步说停）。
`remaining` 从 2 → 1 正好对应「首枪之后最多再规划 2 次」。

**失败语义**：见 §3 总表。注意两种「不抛错」的失败——参数构造不出（写 `absentArgs` 回执）、
引擎算不了（回执 `missing:true`）——它们**不进纠错通道**，模型必须按已有事实回答。

**谁保证身份/版本一致**：合同白名单 `TOOL_CONTRACTS`（`toolbox.js:144`，12 个）；`validToolArgs`（`:429`）；
`seen` 去重；`receipt` 10KB 上限；`isLiveMatch` 硬门控。`simulate_branch` 不带 `state_version` 参数，
**版本一致性由「服务端会话 + 引擎回执里的 state_version」保证**（下一跳）。

### 跳 6 · 工具落地：从 `battle_id` 到引擎（`toolbox.js` → `server/index.js` → `roco-service.js`）

| 项 | 内容 |
|---|---|
| 分派 | `runTool` `runtime.js:4446-4458`（`search_rules` 可被注入 retrieve 短路；其余 `executeTool`）；`executeTool` `toolbox.js:557` 先 `isLiveMatch` 抛 `Error('policy')` `:558`、再 `validToolArgs` `:559` |
| 六宠读口 | `toolbox.js:591-612`：`if(!g && context.roco_battle.battle_id && typeof context.rocoPreview==='function')` → `context.rocoPreview(battleId)`；成功回执：`engine:'six-pet-rules'`、`battle_id`、`state_version`、`turn`、`recommendation`、`expected/worst`、`main_counter`、`first_second_margin`、`damage_preview`、`risk`、`coverage` + **`assumption`**（`:603-604`「这些是引擎按公开信息与固定分析种子算出来的估值（不是胜率…）；对手下一步仍是假设」） |
| 失败回执 | 同一段 `:607-611`：`{missing:true, battle_id, reason:'引擎没给出这一局的走法结果：…', available:[...], next:'先按快照事实说明并标注推断；修好服务端会话后再要模拟结果'}`；没有编号时走 `:618-624` 的「要在服务端会话里做」诚实边界（测试 ⑤/③ 钉着） |
| 服务端实现 | `src/server/index.js:1067-1077` → `src/server/roco-service.js:2920 planBattle`：`:2921-2922` `sessionOf(battle_id)`，没有 → 404「对局不存在或已失效」；`:2924` 规则服务没起 → 503；`:2926` 版本取**服务端会话**的 `session.state.state_version`；`:2926-2932` 用 `/battle/legal` **重算公开面**（注释「不接受调用方传进来的任何 state：否则浏览器就有机会把私有状态塞进教练请求」）；`:2934` 对局不匹配 → 409；`:2937-2945` `planActions`（depth 默认 2 / beam 默认 4 / 固定分析种子 + 伤害预览）；`:2948` 规划失败 → 502；成功 `:2952-2990` 才把 `state_version/recommendation/expected/worst/...` 回给教练 |
| 输出 | 一个 `toolTrace` 条目（`{id,tool,args,result,chosenBy}`），进证据包 |

**失败语义（这一跳最值得背）**

- 404/503/409/502 都**不是抛异常**：`planBattle` 返回 `{ok:false, reason/error}` → 服务端 `:1070` 包成 `{missing:true,reason}` →
  工具 `:607-611` 包成「引擎没给出…」回执。**模型不会拿到假数字，也不会触发纠错券**，必须按快照事实作答。
- 没有 `battle_id`：`:618-624` 明确说「分支模拟要在服务端对局会话里做，这份上下文只有公开快照」——
  不会说「当前没有进行中的对局」（那是第 42 轮实测抓到的假话，测试 ③ 钉着）。
- 规则服务不可用：503 一路变成回执里的 reason，玩家看到的是「引擎没给出…」而不是「模型胡说」。

**谁保证身份/版本一致**：`battle_id` → 服务端会话（唯一权威）；`:2926-2932` 服务端**重算公开面**
（客户端 fast-forward 不了局面）；回执里的 `state_version` 来自引擎 envelope `:2955`；
`assumption` 固定写明「估值不是胜率、对手下一步是假设」。

### 跳 7 · 模型生成（`src/server/index.js:1029-1032`）

| 项 | 内容 |
|---|---|
| 输入 | `runCoach` 的 `provider.generate(modelPacket(packet,{message}))`（`runtime.js:2721`；`modelPacket` `:1735-1740` 加 `message` 与 `prediction` 脚手架） |
| 提示 | 系统提示（`:1030`）：角色 + 180 字上限 + 数字/引用纪律 + 「publicState 是你已经看见的实时局面」「pet id 只是内部标识」等；用户消息 `:1031` 是 `JSON.stringify({player_message, role, preference, recent_messages, game_evidence: packet})` |
| 生成 | `complete(messages, 320, 8000, cancelled.signal)` `:1032`；`usage/tokenAudit` 记回执 |
| 输出 | 模型正文候选（字符串）；空/非字符串 → `runtime.js:2723` 抛错 → 500 |

**失败语义**：超时/取消（`cancelled` 由 `res.once('close')` 触发，`:993`）→ 抛错 → 500；正文空 → 500。
模型这一步失败**不会**把状态写坏（无 game mutation 工具）。

**谁保证身份/版本一致**：模型包里的 `game_evidence` 就是服务端装配的那一份（`rocoBattle` 已按 `:2659` 原样进包），
不是模型自己去取；`packet.prediction` 强制「标推断就要给依据」。

### 跳 8 · 守卫、纠错、降级、交付、渲染

| 项 | 内容 |
|---|---|
| 三重核对 | `checkAnswerText` `runtime.js:2727-2748`：`checkReceiptConsistency`（只判模型正文）`:2728`；`checkGroundedAnswer` `:2737-2739`（数字/引用/因果/确定性/道具名漂移等，facts 见 `:4775`）；`checkPredictionLabel` `:2743-2745`（「不许只交一句不知道」）；超长 `:2746` |
| 长文压缩 | `:2762-2774`：`too-long` 先结构化压缩再重过同一批核对，过了交压缩稿，否则回退 |
| 一次纠错 | `:2777-2816`：**答案层也只有一张券**（`:2785` `answerCorrectionBudget`，工具层用掉就没得给）；同一会话同一原因已经试过 → 不再试（`:2786-2794`）；重写一次再判（`:2810-2815`），还错就降级 |
| 降级正文 | `:2818-2836`：被拒时交 `scrubbedText`（本地已核验结论）；陪练路由 + 玩家在提问 → 换一句诚实说明（不端「我在。」） |
| 交付前建议闸 | `:2842-2859`：`speakPlainly` 换词（`plain-words.js`，数字序列不许变）；`gateAdviceDelivery`（数字同源 + 对照收益）；`enforceBattleAdvice`（必须点出当前合法首选行动，否则换确定性建议） |
| 回执 | `:2871-2889` `validation`：`valid/checked_by/checkedText/deliveredText/rejectedReason/reasons/attempts/adviceNumberFixes/adviceEnforced/...`；`:2913-2919` 返回 `text/localText/route/provider/verified/validation/fallbackReason/...` |
| 服务端回包 | `server/index.js:1089-1098`：`payload={...answer, usage, tokenAudit, stateToken}`；`:1094` `shouldCache`（只缓存「云端 + 通过守卫 + 非降级」，`answer-cache.js:103-110`）；`:1096` 写缓存；`:1098` `{...payload, cache:'miss'}` |
| 渲染 | `client/roco.js:5993-5996` 身份复核；`:5997-6029` `markdown(text)` + `activityLine` 段 + `dataset`（route/provider/verified/evidence/activity）；`:6031-6037` 失败兜底 |

**【实测】正常链路（`/tmp` 探针 C 段）**

```
packet.toolTrace 长度=1  agentStop=complete
packet.toolPolicy={"need":"simulate_branch","reason":"roco-battle-advice"}
packet.rocoAdvice.actionLabel=风刃 legalActionId=skill#风刃
answer.route=strategist provider=fake-cloud verified=false
answer.validation.valid=true checkedText=model-answer deliveredText=model-answer rejectedReason=null
answer.text=这一手按引擎估值先出「风刃」；这是引擎按公开信息算的估值，不是胜率，也不会替你出招。
```

**【实测】失败链路（模型编了一个不在证据包里的数）**

```
generate 调用次数=2（答案层纠错券：全局 1 张）
rejectedReason=ungrounded attempts=2
validation.reasons=["unsupported-certainty","unsupported-number:9999"]
provider=local-fallback deliveredText=local-template
fallbackReason=模型回答里有未经登记的数字或引用，显示已核验的本局分析
```

**失败语义**

- `ungrounded` → 回退「已核验的本局分析」（`provider:'local-fallback'`、`validation.deliveredText='local-template'`、`fallbackReason` 说清）。
- `receipt-inconsistent` / `unlabeled-unknown` / `too-long` → 各自的可读原因（`:2919`；玩家话映射 `src/coach/activity.js:36-38`）。
- `adviceEnforced`（模型没点出合法首选）→ 换确定性建议，回执带 `adviceEnforced.reason/actionLabel/legalActionId`（`:2854-2859`、`:2916-2917`）。
- 模型抛错 → 500；前端 catch 显示离线正文 + 原因。
- 迟到/局面已变 → 前端 `:5993-5996` 丢弃。

**谁保证身份/版本一致**

1. 前端两道 stamp（`:5918` 前、`:5993` 后）；
2. 服务端 `stateToken` 身份 + 缓存/合并 fail closed（`index.js:1002-1013`）；
3. 工具回执带引擎 `state_version`（`toolbox.js:598`）；
4. 守卫把正文里的数字/引用绑回 `packet`（`runtime.js:4775`，含 `rocoBattle`）。

---

## 3. 失败语义总表（现场被问「这里挂了会怎样」就按这张答）

| 失败点 | 触发 | 谁接住 | 玩家看到 | 回执字段 |
|---|---|---|---|---|
| 输入为空/重复点击 | 前端 | `sayOnce`/`say` `roco.js:5902-5903`、`:6219-6221` | 不回复 / 「上一条还在查」 | — |
| CSRF/会话/来源 | 前端/服务端 | `index.js:965-967` | HTTP 403「会话已失效，请刷新页面」 | — |
| 形状非法（战况/规划/阵容） | 服务端 | `validateChat` `:227-424` | HTTP 400 + 点名原因 | `error` 文本 |
| 同 key 有请求在飞 | 服务端 | `:1011-1013` 合并；不同 key `:1015` 429 | 合并则等到同一答案；否则 429 | `dedup:'joined'` / `error` |
| 线上竞技（pvp-live） | 工具/运行时 | `runtime.js:2330`、`:4461`、`toolbox.js:558` | 拒答「线上竞技 PVP 赛中不提供战术分析」 | `agentStop:'policy'` |
| 工具名/参数/重复 | 循环 | `runtime.js:4528-4541` | 一次纠错后仍错才 `invalid-tool/invalid-arguments/repeated-tool` | `agentStop` + 错误回执 |
| 工具执行抛错 | 循环 | `:4543-4547` | `policy` 直接停；其它一次纠错，再错 `invalid-arguments` | 错误回执 `chosenBy:'correction'` |
| 回执 >10KB | 工具/循环 | `:4500`、`:4558` | 拒绝超大回执，`stopped:'receipt-budget'` | `agentStop` |
| 规划器超时/取消/非 JSON | 规划器 | `:4508-4522` | `planner-timeout/-cancelled/-failed`；非 JSON 记 `planner-json-invalid` | `agentStop` |
| 引擎会话 404/503/409/502 | 服务端/工具 | `roco-service.js:2922/2924/2934/2948` → `index.js:1070` → `toolbox.js:607-611` | 回执「引擎没给出…」，模型按快照答（不给假数字） | `result.missing:true` |
| 无 `battle_id` | 工具 | `toolbox.js:618-624` | 「分支模拟要在服务端对局会话里做…」（不说「没有进行中」） | `result.missing:true` + `unavailable` |
| 模型正文编数字/引用 | 守卫 | `runtime.js:2737-2739`、`:4770-4897` | 只改一次；还错 → 本地已核验正文 + `fallbackReason` | `validation.rejectedReason:'ungrounded'` |
| 模型只说「不知道」 | 守卫 | `:2743-2745`、`:4960-4983` | 一次纠错；还错 → 降级（原因 `unlabeled-unknown`） | `validation.rejectedReason` |
| 模型正文 >360 字 | 守卫 | `:2762-2774` | 结构化压缩后再核；过不了才降级 | `validation.rejectedReason:'too-long'` 或压缩成功 |
| 模型没点出合法首选 | 交付闸 | `:2854-2859` | 换确定性建议（同一份局面算出来的） | `adviceEnforced` + `provider:'local-fallback'` |
| 模型调用抛错/超时 | 服务端 | `runtime.js:2721-2723` → `index.js:1183-1189` | HTTP 500「本地服务无法完成请求」；前端 catch 显示离线正文 | `error` |
| 答案迟到（局面已变） | 前端 | `roco.js:5993-5996` | 「局面已经变化，这条迟到的回答已作废」 | — |

---

## 4. 身份/版本一致：三道锁（现场追问「怎么防串局/串答案」）

1. **前端身份**：`battleId`（`:4945`）+ `state_version/turn` → `coachStateToken`（`:4966-4972`）；
   前后两次 `coachBattleStamp`（`coach-advice.js:1653-1657`）夹住整个 await，局面变了就丢答案。
2. **服务端身份**：`stateToken` 非空才允许缓存/合并（`index.js:1002-1013`）；缓存 key 含
   `stateToken/role/message/context/mode/model/rulesVersion/promptDigest`（`answer-cache.js:43-57`）；
   跨字段版本检查 `roco_plan.state_version === roco_battle.state_version`（`index.js:417-424`）。
3. **证据身份**：工具回执带引擎算的 `state_version`（`toolbox.js:598`）；模型正文里的数字/引用要能在
   `packet` 的 facts 里找到（`runtime.js:4775`，含 `rocoBattle`/`toolTrace`）；
   查不到 → `ungrounded` → 降级（§5 F 段实测：不带 `rocoBattle` 时 88/107/120/150 全部判凭空）。

> 补充（读码）：`simulate_branch` 的合同**没有** `state_version` 参数（`toolbox.js:148`），
> 所以这条链的版本一致不是靠「模型传版本号」，而是靠 ①服务端按 `battle_id` 找会话（`roco-service.js:2921`）、
> ②服务端重算公开面（`:2926-2932`）、③回执带引擎 `state_version`（`:2955`）。
> 带 `state_version` 参数的是 `query_rules` 这类（`withRuntimeStateVersion` `runtime.js:3166-3173`）。

---

## 5. 实测记录（可复现；先看这一节，别信文档里的旧行号）

### 5.1 测试（命令 + 结果，均为本机实测）

| # | 命令 | 结果 | 它覆盖链路的哪一段 |
|---|---|---|---|
| 1 | `node --test --test-name-pattern='agent planner can adapt' tests/coach.test.js` | ✅ 1/1 pass | 工具循环：按回执换手 `search_rules → compare_actions → read_state`，`stopped='tool-budget'`；无效工具走一次纠错；`pvp-live` 时 planner 0 次调用（`tests/coach.test.js:62-81`） |
| 2 | `node --test --test-name-pattern='① 透传\|② 加性校验\|⑤ 六宠快照带对局编号\|⑥ 六宠对局里的建议问句\|⑧ 结构性' tests/roco-battle-context.test.js` | ✅ 5/5 pass | 六宠快照进包、`validateChat`、`executeTool('simulate_branch')` 经 `rocoPreview` 拿引擎回执、`policyFor` 强制、结构性接线 |
| 3 | `node --test tests/roco-advice-u08.test.js` | ✅ 16/16 pass | **真 HTTP 端到端**：临时实例 `listen(0)`（不碰 8765/8896/8899），无模型凭据，`POST /api/coach` 200 + `rocoAdvice` 结构 + 首选行动回指合法集合；反证：撤掉 `roco_battle` 后该键不出现 |
| 4 | `node --test tests/evals/coach-advice.test.js` | ✅ 14/14 pass | 建议层纯函数（不含 HTTP） |

**复跑片段（实测，节选）**

```text
# 命令 1
✔ agent planner can adapt to tool receipts and invalid tools never execute (151.027083ms)
ℹ tests 1 / pass 1 / fail 0

# 命令 2
✔ ① 透传：带 roco_battle 时原样进包，不带时这个键不出现
✔ ② 加性校验：合法形状放行，畸形一律 400 并点名
✔ ⑤ 六宠快照带对局编号 ⇒ 工具回执是**引擎**算的走法结果（含反证：没编号时说清算不了）
✔ ⑥ 六宠对局里的建议问句**强制**先取引擎估值；没有编号或线上竞技时不许强制
✔ ⑧ 结构性：客户端快照真的带编号、服务端真的注入读口、工具真的用它
ℹ tests 5 / pass 5 / fail 0

# 命令 3
ℹ tests 16 / pass 16 / fail 0
```

### 5.2 自制只读探针（把「每一跳的中间值」打印出来）

- 路径：`/tmp/trace-roco-swap.mjs`（**不在仓库**；只 import `runtime.js / memory.js / coach-advice.js`，
  provider 全是本地假实现，无网络、无服务端、无付费模型）。
- 命令：`node /tmp/trace-roco-swap.mjs`（输出已存 `/tmp/trace-roco-swap.out`）。

**关键输出（逐跳对应 §2）**

```text
A. policyFor + rocoAdviceAsk（代码决定「该不该调」）
   policyFor -> need=simulate_branch reason=roco-battle-advice
   rocoAdviceAsk -> true
   defaultArgsFor('simulate_branch') -> {"candidates":[],"unresolved":["未识别的动作"]}

B. gatherAgentEvidence：首枪政策，第 2 步模型决定
   planner 被调用 2 次：[{"receipts":["simulate_branch"],"remaining":2,"hardRequired":"simulate_branch"},
                        {"receipts":["simulate_branch","read_state"],"remaining":1,...}]
   stopped=complete  trace=2
   - tool:1 simulate_branch chosenBy=policy  result.engine=six-pet-rules state_version=41 turn=8 recommendation=风刃
   - tool:2 read_state       chosenBy=undefined
   rocoPreview 被调用次数=1 参数=["s1-trace"]

C. runCoach 全链路（假云端 provider）
   packet.toolTrace 长度=1 agentStop=complete toolPolicy={"need":"simulate_branch",...}
   packet.rocoAdvice.actionLabel=风刃 legalActionId=skill#风刃
   answer.route=strategist provider=fake-cloud
   answer.validation.valid=true checkedText=model-answer deliveredText=model-answer rejectedReason=null

D. 失败语义（模型编 9999 + 稳赢）
   generate 调用次数=2（答案层纠错券：全局 1 张）
   rejectedReason=ungrounded attempts=2
   validation.reasons=["unsupported-certainty","unsupported-number:9999"]
   provider=local-fallback deliveredText=local-template
   fallbackReason=模型回答里有未经登记的数字或引用，显示已核验的本局分析

E. 边界：循环上限
   limit=3 -> trace=3 stopped=tool-budget
   limit=2 -> trace=2 stopped=tool-budget
   AGENT_STOPS 取值域大小=22

F. checkGroundedAnswer 的数字溯源集合包含 packet.rocoBattle
   带 rocoBattle -> valid=true reasons=[]
   不带 rocoBattle -> valid=false reasons=["unsupported-number:88","unsupported-number:107","unsupported-number:120","unsupported-number:150"]
```

### 5.3 当前 commit 上的既有红（**别对面试官说「全绿」**）

| 测试 | 结果 | 说明 |
|---|---|---|
| `tests/coach.test.js` | 37 tests / 36 pass / **1 fail** | `tests/coach.test.js:9`「strategist gives a legal action grounded in current state」：`answer.actions` 为 undefined（`TypeError: Cannot read properties of undefined (reading '0')`） |
| `tests/roco-battle-context.test.js` | 19 tests / 18 pass / **1 fail** | `:455` ⑪ B2②：`unknown` 里没有「潮甲龟」，实际文本是「请点名公开队伍中要比较的两只…」 |
| `tests/evals/coach-advice.test.js` | 14/14 pass | — |
| `tests/roco-advice-u08.test.js` | 16/16 pass | — |

这两条红**与本文追踪的六宠链路无关**（一个是 legacy strategist 回执字段，一个是建议层比较问句的
「不知道」通道），但现场如果要跑测试，先跑 §5.1 的三条，并主动说「仓库当前有两处既有红，我定位过，
不是这条链」——比说「全绿」被当场戳穿强。

---

## 6. 三个现场可改点（面试官说「你现在改一下」时的落点）

> 以下**只给落点与影响面，我没有改任何源码**。行号均为当前 commit `2e62a73b`。

### 改点 ①：把工具循环上限从 3 改成 2

**怎么改（两种，面试时按「影响面」选）**

- **最小生产改动**：`src/coach/runtime.js:2682` 的 `gatherAgentEvidence({...})` 里加 `limit:2`。
  只影响 `/api/coach` 生产链；`runCoach` 调 `gatherAgentEvidence` 时**不传 limit**（`:2682` 现文没有 limit），
  所以这是「改一处、只影响生产」的做法。
- **改默认值**：`src/coach/runtime.js:4584` 的 `limit=3` → `limit=2`（内层 `:4460` 同样默认 3）。
  影响所有直接调用 `gatherAgentEvidence` 的测试/脚本（更广）。
- 上限的实际执行点：`:4505` `for(let i=trace.length; i<Math.min(4,limit); i++)`；
  覆盖度预算同源：`:4595` `Math.min(4,limit)`。

**【实测】效果**：`limit=3 → trace=3, stopped='tool-budget'`；`limit=2 → trace=2, stopped='tool-budget'`。
本句（政策首枪 1 条）的 `remaining` 会从 2 变 1，即「首枪后模型只能再规划 1 次」。

**影响测试清单（grep 反查）**

| 测试/脚本 | 期望 | 改默认值后会怎样 |
|---|---|---|
| `tests/coach.test.js:62-71` | 直接调 `gatherAgentEvidence`，默认 limit=3，断言 trace 恰为 3 条 + `tool-budget` | **必红**（trace 只有 2 条）——这是唯一钉死「默认 3」的测试 |
| `tests/roco-coverage-force.test.js:55-80` | 覆盖度开档、默认 limit，断言 ≥2 条 + 补出的族 | 需复跑（limit=2 时预算也变 2，多数断言仍可绿，但不是显然） |
| `tests/roco-coverage-force.test.js:88` | 显式 `limit:3` | 不受影响 |
| `tests/evals/roco/agent-loop-correction.test.js:39` | 显式 `limit:3` | 不受影响 |
| `tests/roco-planner-attribution.test.js:78-85` | 只断言 `Math.min(\d+,limit)` 里的数字 ≤4 | 仍绿，但语义是「别加大」，减小不违背 |
| `scripts/eval-live-s04.js:536` | 不传 limit，跑真实/回放评测 | 结果会变（`stopped` 分布、planner 次数）；**不要现场跑**（可能付费） |
| `docs/INTERVIEW-GUIDE.md:17`、`docs/INTERVIEW-DRILL.md:78` | 口径写着 3 | 需同步；否则面试口径与代码打架 |

**不要顺手**：`AGENT_STOPS` 无需改（`tool-budget` 仍在）；`scripts/analyze-live-eval.js:20` 的
`plannerCallCount` 公式不用改，但统计口径会变，跑完要对得上。

### 改点 ②：新增一个 `stopped` 原因（例：给「规划器返回空对象」单独记 `planner-empty`）

**必改两处**

1. **取值域**：`src/coach/runtime.js:2933-2961` `AGENT_STOPS` 里加值（必须放在合适分组附近，注释写清含义）。
2. **真正产生它的返回点**：例如 `:4508-4515`（planner 抛错分类处）或 `:4516-4522`（stop/非 JSON 处），
   把新原因作为 `stopped` 返回；若要让它出现在 `/api/coach` 回执，`runCoach` `:2688-2689` 已把
   `result.stopped` 写进 `packet.agentStop`，**不用另改**；若新原因产生在答案层（不在工具层），
   则要显式 `packet={...packet,agentStop:'x'}`（`tests/roco-agent-stops.test.js:27` 会扫 `agentStop:'…'` 字面量）。

**影响测试清单（grep 反查）**

| 测试/脚本 | 会怎样 |
|---|---|
| `tests/roco-agent-stops.test.js:36-42` ① | 源码里每个 `stopped:'x'`/`agentStop:'x'` 必须在 `AGENT_STOPS` 里 ⇒ 不登记必红 |
| 同文件 `:44-52` ② | 集合里不许有**死值**：新值必须在源码里真出现；若由模板字符串拼出（`${kind}-no-tools`），要把前缀加进 `dynamicPrefixes`（`:47`） |
| 同文件 `:54-64` ③ | **命名必须落进四组之一**：`policy-*` / `planner-*` / 循环边界五值 / `complete`。新名字若叫 `planner-empty` 绿；叫 `empty-plan` **红**（要么改名，要么改判据——改判据=改测试，面试要说清） |
| `tests/coach.test.js:76-80` | 若改的是 `invalid-tool` 那条分支才会受影响；新增独立原因不受影响 |
| `scripts/eval-live-s04.js:846`、`scripts/analyze-live-eval.js:20` | 消费侧有 `modelStops` 计数表：新值不会报错，但**不会进统计**（要么加表项，要么明确说「不进旧口径」） |
| `docs/roco/AGENT-TRAJECTORIES.md` 的 `stopped` 分布 | 旧产物不含新值，回放判据读旧产物 ⇒ 不会红；但文档数字要按「产物为准」更新 |

### 改点 ③：在证据包里加一个字段（照 B3 `roco_battle.affinity` 的现成先例）

**要动的三层（以「页面把某个公开读数随 `roco_battle` 上传」为例）**

1. **客户端投影**：`src/client/roco.js:5630-5722` `coachRocoBattle()` 里往 `snapshot` 加键。
   纪律照 `:5597-5628` `affinityReadingsOf()` / `:5717-5720`：**拿不到就不加这个键**；
   `:5652-5653` 是现成的 fail closed 先例（我方缺 id ⇒ 整条不发）。
2. **服务端白名单/形状**：`src/server/index.js:330-413` 的 `roco_battle` 校验块加显式分支
   （若要限长/限枚举就照 `affinity` 的写法 `:383-412`；**注意实测：不加分支也不会 400，未知键会被放行**，
   见 §7 矛盾 #6——所以「忘了改服务端」的表现是静默通过，不是红）。
3. **运行时证据包 + 数字溯源**：`src/coach/runtime.js:2659` `...(context.roco_battle?{rocoBattle:...}:{})`
   会原样进包；**数字可溯源**靠 `:4775` 的 facts（其中已有 `rocoBattle`）。
   如果新字段是**顶层**字段（不在 `roco_battle` 里），必须同时加进 `:4775` 的 JSON，否则
   模型引用它的数字会被判 `unsupported-number`（§5 F 段的反证）。
4. **若字段要参与建议**：`src/coach/coach-advice.js:1406 battleAdvice()` 消费；只加字段不消费不会报错。

**影响测试清单（grep 反查 `roco_battle|rocoBattle|validateChat`）**

- `tests/roco-battle-context.test.js`：① 透传、② 加性校验、④ 结构性、⑥ 数字守卫（带/不带字段的对照）；
- `tests/roco-plan-context.test.js`、`tests/roco-coach-context-contract.test.js`、`tests/roco-plan-projection.test.js`；
- `tests/roco-advice-u08.test.js`（端到端 HTTP 会真的走 `validateChat`）；
- `tests/roco-xiaoya-context.test.js`、`tests/roco-active-match-priority.test.js`（上下文透传类）；
- 必须新增一条**加性反证**（不带新键时老路径逐字节不变），仓内先例是
  `tests/roco-battle-context.test.js:411-417`（⑩ B3④）。

**安全影响（要主动说）**：`checkGroundedAnswer` 的可溯源数字集合 = `JSON.stringify(rocoBattle)`，
所以**任何**能进 `roco_battle` 的数字都会成为「可引用数字」。新增字段时要问自己：
「这个数字该不该允许模型引用？」如果出现 `validateChat` 未知键被放行（§7 #6），这是一条真实的信任边界，
面试官若问「客户端能不能伪造证据」，答案就在这里：**能扩展数字集合，所以服务端白名单是必须补的**。

---

## 7. 文档 vs 代码矛盾（发现即是面试素材，但要分清「我实测」）

| # | 文档说法 | 代码/实测 | 面试怎么处理 |
|---|---|---|---|
| 1 | `docs/INTERVIEW-GUIDE.md:17` 用「我只能回血吗」当 ReAct 例子：先读状态 → 调行动比较 → 查防御例外 | **实测**：`policyFor` 判 `need:null reason:'state-in-packet'`；`rocoAdviceAsk=false` ⇒ **0 次工具**。该原句只出现在两份面试文档，无测试覆盖 | 别拿这句当工具链例子；讲本文这句，并把「说法边界」当加分项 |
| 2 | `docs/INTERVIEW-DRILL.md:78`「现在有 **12 种** `stopped` 值」 | **实测** `AGENT_STOPS.length === 22`（`runtime.js:2933-2961`） | 说 22，并说「文档里的 12 是旧值」——展示你以代码为准 |
| 3 | 同文档「循环上限 3 次工具调用 / **4 轮**（`limit=3`，`Math.min(4,limit)`）」 | **实测** `limit=3` 时最多 3 条回执；`Math.min(4,limit)` 里的 4 只在调用方传 `limit≥4` 时出现，生产 `runCoach` 不传 | 说「3 条回执；首枪后模型最多再规划 2 次；`4` 是函数字面上限，生产取不到」 |
| 4 | 同文档「退出路径的测试在 `tests/coach.test.js:61`」 | 实际测试函数在 `:62`（行号漂移） | 现场 grep 现查，别背行号 |
| 5 | `runtime.js:3031` 注释、`tests/roco-battle-context.test.js:241` 都说线上竞技婉拒在 `runtime.js:1151` | **实测/读码**：真正的 `isLiveMatch` 早退在 `runtime.js:2330`；`:1151` 是六维合并代码 | 这条本身就是「文档行号会漂」的活教材；面试可主动说「我追行号用 grep，不信旧引用」 |
| 6 | `tests/roco-battle-context.test.js:12` 说「对手后备不许带 id，由 ② 的未知键口径守」 | **实测** `validateChat` 对 `roco_battle` 的未知键 **3/3 放行**（`foe_bench` 带 `pet_id`、顶层 `evil_field`、pet 行未知键都 200） | 主动说「服务端对六宠快照是逐字段校验、不是白名单；新增字段会静默通过，这是要补的」 |
| 7 | `tests/roco-battle-context.test.js:434-437` 已登记「120/180 血」会被 `findNumberSourceProblems` 误判（既有行为） | **实测**：误判的**额外后果**是玩家可见文本被摘成残句。真 HTTP 端到端测试的输出第一行就是「能量 3），对手是鸭吉吉…」（`tests/roco-advice-u08.test.js` 的 ① 普通回合）；测试只断言 `actionLabel/legalActionId` 所以是绿的 | 这是「测试绿 ≠ 玩家文本对」的现成例子；可讲「要加的是一条不出现残句的判据」 |
| 8 | `docs/roco/AGENT-TRAJECTORIES.md:9` 写「6,912 条 / 23 个世界 / 8 个 arm」（与产物 header 一致），但同文 `:19/:136/:137/:208/:218` 仍写 6,048 | **实测** 产物 header：`totals.trajectories=6912, worlds=23, arms=8`；测试只钉第 9 行那个形状 | 引数字前跑 `head -1 tests/evals/agent-trajectories-v1.jsonl`；这也是仓库自己「数字以产物为准」纪律的反例 |

> 另外两条**行号漂移**：`src/coach/profile-shape.js:12` 写 `runCoach (runtime.js:1146)`（实际 `:2252`）；
> `docs/roadmap/AGENT-TECH-SURVEY.md` 里 `runtime.js:972/1048` 等引用是旧版本行号。
> 结论写在方法论里：**行号一律 `grep -n` 现查**，这也是本次追踪的第一条纪律。

---

## 8. ASCII 白板（60 秒能画完）

```text
玩家：「这回合我该换谁？」  (roco.html 小芽聊天)
          │
          ▼
roco.js:6213 submit → :5901 say → :5917 sayOnce
          │  message + context.roco_battle(公开快照) + stateToken + CSRF
          │  （coachRocoBattle :5630 / coachStateToken :4966）
          ▼
server/index.js:992 /api/coach
   :964-971 CSRF/会话 → :993 validateChat → :1002-1013 身份/缓存/合并
          │
          ▼
server:1067-1088 rocoPreview(battle_id) + coachedContext → runCoach
          │
          ▼
runtime.js:2252 runCoach
   :2678 政策闸 → policyFor(:2991) → :3032 need=simulate_branch（强制！）
          │
          ▼
runtime.js:4460 有界循环（首枪政策；之后模型；上限 3 条回执）
          │  tool:1 = simulate_branch  (chosenBy:'policy')
          ▼
toolbox.js:557 executeTool → :591 rocoPreview(battle_id)
          │
          ▼
server:1067-1077 → roco-service.js:2920 planBattle（服务端会话+引擎重算公开面）
          │  回执：engine=six-pet-rules / state_version / recommendation / expected / risk
          ▼
回到 runCoach：toolTrace 进证据包 → 模型 generate(server:1029-1032)
          │
          ▼
runtime.js:2727 三重核对（回执一致 / 数字与引用 / 不许只说不知道）
   ├─ 不过 → :2777 一次纠错 → 还不过 → :2919 降级 local-fallback
   └─ 过/降级 → :2854 enforceBattleAdvice → :2913 返回
          │
          ▼
server:1089-1098 payload(cache:'miss') → roco.js:5993 再验局面身份 → :6011 markdown 上屏
```

---

## 9. 60 秒口述版（照意思讲，别背）

> 玩家在六宠对局页问「这回合我该换谁？」，前端把公开快照和局面身份（`battle_id + state_version + turn`）
> 发到 `/api/coach`。服务端先校验形状，再用 `stateToken` 判缓存和合并，然后进 `runCoach`。
> 第一件不是问模型，是**政策函数**先判断该不该调工具：六宠建议问句强制调 `simulate_branch`，
> 模型只负责后面「还要不要查」——首枪之后最多再规划两次，总回执上限 3 条。
> 工具拿着 `battle_id` 去服务端会话里让引擎重算公开面、给出推荐/预期/最坏/伤害范围；
> 回执进证据包，模型只按回执措辞。正文回来要过三道核对：跟回执一致、数字和引用能在证据包里查到、
> 不许只回一句「不知道」。不通过先给一次纠错机会，还不通过就整句降级成引擎算的那份结论，
> 并写明降级原因。最后前端再对一次局面身份，局变了就把迟到的答案扔掉。
> 一句话：**该不该查由代码定，查到的算引擎，模型只解释；说错了就降级，不把编的数给玩家。**

---

## 10. 面试官追问速答（都可落到本文行号）

1. **「循环为什么是 3，不是更多？」**
   `:4505` `Math.min(4,limit)`，生产 `limit=3`（`:4584` 默认、`:2682` 不传）；
   外部与本仓实测都指向「小模型多步是负收益」：`tests/roco-planner-attribution.test.js:78-85` 把上限 ≤4 钉住；
   `reports/react-evidence-check.json` 记录 44 条真实轨迹最大长度 1。
2. **「如果模型第一次就想停？」**
   政策首枪已经先执行了（`:4489-4504`），模型停只会让 trace 停在 1 条、`stopped:'complete'`。
3. **「政策判断错了怎么办（该调没调）？」**
   这是已知权衡：`docs/INTERVIEW-DRILL.md:78` 记录「该调不调 0/19 → 7/19」的代价；
   代码侧的补救是 `HARD_TOOLS` + `hardRequired`（`:4508`）与覆盖度强制（`:4587`，默认关）。
4. **「工具能改游戏状态吗？」**
   不能。`TOOL_CONTRACTS` 12 个全是读（`toolbox.js:144`）；`planBattle` 只算法（`roco-service.js:2920`）；
   执行动作是 `/api/roco/battle/advance`（`api()` 的另一条路，`roco.js:5009`），教练链不碰。
5. **「线上竞技为什么不给建议？」**
   `runtime.js:2330` 硬拒 + `policyFor` `:3032` 显式排除 + `gatherAgentEvidenceOnce` `:4461` +
   `executeTool` `:558` 四层。注意：六宠页 `mode` 恒为 `camp`（`roco.js:5548`），这条链是 AI 模拟局，
   不经过那几层；公平性门在 legacy/线上那条路。
6. **「模型编数字怎么防？」**
   `checkGroundedAnswer`（`:4770`）：数字必须出现在 facts（`:4775`，含 `rocoBattle/toolTrace`）或规则常量里；
   中文数字也翻（`:4865-4874`）；引用/道具名/因果/确定性各有分支（`:4776-4896`）。
   实测反证：不带 `rocoBattle` 时 88/107/120/150 全部判凭空（§5 F）。
7. **「降级后玩家看到什么？」**
   `text` 换成 `localText`（引擎已核验结论）；`provider:'local-fallback'`、
   `validation.deliveredText:'local-template'`、`fallbackReason` 写明原因（`:2913-2919`）。
8. **「并发同一句会花两次钱吗？」**
   同 `stateToken+message+...` 的 key 会合并（`index.js:1011-1013`），不同 key 才是 429（`:1015`）；
   没有 `stateToken` 不缓存不合并（`:1002-1013`）。
9. **「服务端没有这一局/规则服务没起？」**
   `planBattle` 404/503/409/502（`roco-service.js:2922/2924/2934/2948`）→ 服务端包 `{missing:true}`（`index.js:1070`）
   → 工具回执说清「引擎没给出」（`toolbox.js:607-611`），**不抛错、不触发纠错**，模型按快照答。
10. **「怎么保证不是拿上一局的答案糊弄？」**
    前端 stamp 前后夹（`:5918/:5993`）；服务端 `stateToken` 身份；`planSameVersion`（`:2570-2572`）；
    回执带引擎 `state_version`（`toolbox.js:598`）。
11. **「这套链路有没有真模型的多步证据？」**
    没有。44 条真实记录 `toolTrace` 最大 1（`reports/react-evidence-check.json`）；
    多步由确定性测试证明（`tests/coach.test.js:62-81`），不是模型行为——这条要主动说。
12. **「你现场能改什么？」**
    见 §6 三个改点：循环上限、新增 `stopped`、证据包加字段；每条都有落点与影响测试清单。

---

## 附录 A · 定位命令（本次实际用到的，按这个顺序即可）

```bash
git log -1 --format='%H %ad'          # 确认 commit：2e62a73b… 2026-10-06
grep -n "say-form" src/client/roco.js
grep -n "path==='/api/coach'" src/server/index.js
grep -n "export async function runCoach" src/coach/runtime.js
grep -n "export function policyFor" -A 60 src/coach/runtime.js
grep -n "roco-battle-advice" src/coach/runtime.js
grep -n "async function gatherAgentEvidenceOnce" src/coach/runtime.js
grep -n "Math.min(4,limit)" src/coach/runtime.js
grep -n "export function checkGroundedAnswer" src/coach/runtime.js
grep -n "export function executeTool" src/coach/toolbox.js
grep -n "rocoPreview(battleId)" src/coach/toolbox.js
grep -n "async function planBattle" src/server/roco-service.js
grep -n "function coachStateToken" -A 8 src/client/roco.js
grep -n "export function coachBattleStamp" -A 5 src/coach/coach-advice.js
```

## 附录 B · 行号索引（本文引用过的落点，按文件）

**`src/client/roco.js`**
`:317` api；`:4944-4945` battle/new 与 battleId；`:4966-4972` coachStateToken；`:5532-5561` coachCampContext（`:5548` mode:'camp'、`:5559` battle:null）；`:5597-5628` affinityReadingsOf；`:5630-5722` coachRocoBattle（`:5658` battle_id、`:5661` state_version、`:5677-5681` bench、`:5686-5708` seen/revealed、`:5709-5716` legal、`:5717-5720` affinity）；`:5889-5899` coachRocoPlan；`:5901` say；`:5917` sayOnce；`:5918` initialStamp；`:5924` 离线 context；`:5934-5937` chatReply；`:5945` 「小芽在查证…」；`:5947` 玩家行；`:5954` 可见性；`:5969` no-model-credential；`:5973-5984` 请求上下文；`:5985-5992` POST；`:5993-5996` 迟到作废；`:5997-6029` 渲染；`:6031-6037` 失败兜底；`:6213` submit；`:6219-6221` 在飞拒绝；`:6225` say。

**`src/server/index.js`**
`:227-230` validateChat 头；`:330-413` roco_battle 校验；`:417-424` roco_plan 与跨字段版本；`:552` createCoachServer；`:596-597` answerCache；`:964-971` POST/来源/CSRF/会话/body；`:992` /api/coach；`:993` validateChat；`:1002-1013` 身份/缓存/合并；`:1015` 429；`:1022-1033` provider（`:1027` planner complete、`:1031` game_evidence、`:1032` generate complete(320,8000)）；`:1067-1077` rocoPreview；`:1084-1087` rocoActionView + coachedContext；`:1088` runCoach；`:1089-1098` payload/cache；`:1099-1107` 合并失败结算；`:1183-1189` 500 兜底。

**`src/coach/runtime.js`**
`:1735-1740` modelPacket；`:1754+` predictionScaffold；`:1906-1941` localRocoBattleReply；`:2107-2122` findNumberSourceProblems；`:2131-2150` dropClausesWithProblems；`:2198-2230` enforceBattleAdvice；`:2241+` gateAdviceDelivery；`:2252` runCoach；`:2265-2268` routingText；`:2330` live 拒答；`:2526-2537` 路由/本地六宠回复；`:2568-2616` rocoAdvice 与 packet.text/route；`:2633-2641` judgement/useModel；`:2654-2674` packet 投影（`:2659` rocoBattle、`:2663` rocoLineup、`:2674` publicState）；`:2678-2692` 政策+工具循环入口；`:2721-2723` generate/空正文；`:2727-2748` 三重核对；`:2762-2774` 压缩；`:2777-2816` 一次纠错；`:2818-2836` 降级正文；`:2842-2859` speakPlainly/gate/enforce；`:2871-2889` validation；`:2900-2905` activity；`:2913-2919` 返回；`:2933-2961` AGENT_STOPS（22）；`:2991-3127` policyFor（`:3032-3034` roco-battle-advice、`:3127` state-in-packet）；`:3166-3173` withRuntimeStateVersion；`:3174-3176` requiredTool；`:4379` defaultArgsFor；`:4436-4443` simulate_branch 参数；`:4446-4458` runTool；`:4460-4562` gatherAgentEvidenceOnce（`:4461` live、`:4489-4504` 首枪、`:4505` 循环、`:4508` planner、`:4516-4522` stop、`:4528-4547` 边界、`:4558` 回执预算、`:4561` tool-budget）；`:4583-4587` gatherAgentEvidence；`:4595-4614` coverage；`:4770-4897` checkGroundedAnswer（`:4775` facts）；`:4960-4983` checkPredictionLabel。

**`src/coach/toolbox.js`**
`:22-26` HARD_TOOLS；`:144-164` TOOL_CONTRACTS（12 个；`:148` simulate_branch）；`:182` LOCAL_PLAN_TOOLS；`:429-...` validToolArgs（`:437-445` simulate_branch）；`:557-679` executeTool（`:558` live、`:559` args、`:564-566` search_rules、`:567` compare_actions、`:586` 手游工具、`:591-612` rocoPreview 桥、`:618-624` 无编号诚实边界、`:669-677` 多候选回执）；`:998-1009` rocoStateVersionOf；`:1019-1026` checkRocoFreshness。

**`src/server/roco-service.js`**
`:2920-2990` planBattle（`:2921-2922` session/404、`:2924` 503、`:2926` 版本、`:2926-2932` 服务端重算公开面、`:2934` 409、`:2937-2945` planActions、`:2948` 502、`:2952-2990` 成功回执）。

**`src/coach/coach-advice.js`**
`:187` legalActionIdOf；`:1027-1048` rocoAdviceAsk；`:1406+` battleAdvice；`:1653-1657` coachBattleStamp。

**`src/coach/answer-cache.js`**：`:43-57` answerCacheKey；`:103-110` shouldCache。
**`src/coach/activity.js`**：`:36-38` 降级原因 → 玩家话。

## 附录 C · 探针说明（`/tmp/trace-roco-swap.mjs`）

- 用途：把 §2/§5 里那些「中间值」打印出来（政策结论、planner 调用序列、packet 键、validation、降级、limit 边界、说法边界）。
- 约束：只 import 仓库的 `runtime.js`/`memory.js`/`coach-advice.js`；provider 是手写假对象（`name:'fake-cloud'`），
  **不调用任何付费模型**；不启动服务器；不改仓库文件。
- 跑法：`node /tmp/trace-roco-swap.mjs`；输出 `node /tmp/trace-roco-swap.mjs > /tmp/trace-roco-swap.out 2>&1`。
- 若 `/tmp` 被清理：按 §5.2 的六段（A 政策 / B 循环 / C runCoach / D 失败 / E 边界 / F 溯源）重写即可，
  核心只有三个构造：① 与 `coachRocoBattle()` 同形的 `BATTLE` 快照；② 返回 `PREVIEW` 的 `rocoPreview`；
  ③ 带 `name/plan/generate` 的假 provider。

---

*本文行号均以 commit `2e62a73b` 现查（`grep -n`）。若后续 commit 变了，先跑附录 A 的命令重定位，别用旧行号。*
