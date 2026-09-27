# 阵容问题交回引擎 + 「名单从未进包」这个真 bug（2026-09-25）

**一句话**：问「帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？」时小芽答
「**这仨我手头没数据，不好瞎评。**」——查下去发现**那句话是真的**：
页面一直把名单送进 `context.profile`，**服务端从来没转给模型**。
修完之后同一个问题会真的调 `evaluate_team`（引擎算），回答有依据了。

## 一、改前实测（真机）

| 问题 | 改前 | 改后 |
|---|---|---|
| 帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？ | 0 次调用 · **「这仨我手头没数据，不好瞎评。」** | `evaluate_team({"team":["pet_000225","pet_000190","pet_000445"]})` · 「骨龙幽龙能打、潮甲龟水盾、芽角鹿草系…缺控制和驱散，也怕幽系这类。」 |
| …这三只里哪只适合首发？ | 0 次调用 · 「我这边没有首发的依据」 | `evaluate_team(...)` · 「首发我更倾向潮甲龟，水系只被少数属性克制…」 |
| 我这三只搭不搭？ | 0 次调用 | 0 次调用（**设计如此**：没点名就不替玩家猜），回答说「得看你想打什么方向」 |

三条改前都是 `agentStop: policy-route-without-tools`。

## 二、两个根因（第二个是这轮真正的发现）

### 1. 名单从来没进过证据包（**真 bug**，与开关无关）

页面 `coachCampContext()` 把最多 12 只（名字/系别/定位/种族值/机制）放进 `context.profile`，
运行时却只把它用在**本地模板**里，**没有转给模型**。进程内实测证据包键名：

```
text,evidence,register,companionState,replyConstraints,intent,chatThread,
chatContinued,silent,publicState,latestEvents,playerMessage,conversation,
taskState,interfaceContext,toolTrace,agentStop,toolPolicy      ← 没有 profile / roster
```

⇒ 模型说「我手头没数据」不是偷懒，是**它确实没有**。

### 2. 阵容问句没有走引擎

阵容评估是**规则计算**（红线：计算归引擎，模型只解释），而这类问句
`policyFor` 判成 `need:null` ⇒ 工具循环整段不执行。

## 三、改动（`src/coach/runtime.js`）

| 件 | 作用 | 开关 |
|---|---|---|
| 名单进包 | `context.profile.pets` → `packet.roster`（**加性**：没有 pets 就不出现这个键） | 无（修 bug） |
| 守卫认得名单 | `checkGroundedAnswer` 的可追溯数字集合加入 `roster` —— 与上一轮 `rocoBattle` **同一个坑**：不改的话模型引用真数据会被判 `unsupported-number` 并硬回退 | 无（修 bug） |
| `teamAsk()` | 消息里**恰好点名三只**、且都能在名单里按名字对上 ⇒ 返回那三只 | — |
| `policyFor` 新增一支 | 阵容问句 ⇒ `{need:'evaluate_team'}` | `ROCO_TEAM_LOOKUP=1` |
| `defaultArgsFor('evaluate_team')` | 三只名字 → 页面名单里的 id（对不上返回 `null`，不猜阵容） | 同上 |

`state_version` 由运行时补（上一轮已落地的 `withRuntimeStateVersion`），否则 `evaluate_team` 过不了合同校验。

## 四、回归：49 例同代码对照（开关全关，隔离"名单进包"）

| 层 / 指标 | 加名单前 | 加名单后 |
|---|---|---|
| `answerConsistency` | 47/49 | **48/49** |
| `toolSelectionCorrectnessRate` | 0.429 | **0.449** |
| `callCountCorrectRate` | 0.592 | **0.612** |
| `missedCallRate` / `unnecessaryToolCallRate` | 0.556 / 0.045 | 0.556 / 0.045（未变差） |

调用行为只有 `c31` 变了（1 → 2 次；它是 cat3，金标本来要 2 次）。
回答一致性的失败集合在 c25/c45/c46 之间抖动（同族 `receipt-action-mismatch`，模型抖动）。

## 五、判据

`tests/roco-team-advice.test.js` **5/5**：
① 名单进包（带则原样、不带则键不存在）；② 守卫必须认得名单数字（反证：不带名单时 `unsupported-number:120`）；
③ 恰好三只 ⇒ `evaluate_team` 参数就是那三只的 id，且补 `state_version` 后过得了合同校验；
③b 多一只/少一只/没点名/名字对不上/名单为空 —— **一律 fail closed**；③c 开关两态。

## 六、边界与下一步

- 「我这三只搭不搭？」（**没点名**）现在是 fail closed：不调工具、回答偏空。
  更好的行为是**反问「哪三只？」**——那是下一步（澄清式追问），不是本轮范围。
- 名单是**客户端送来的 profile 数据**（与教练上下文其余部分同等信任级别），
  不是权威竞技状态；排位 PvP 那条路照旧直接拒绝。
- 本轮只证「引擎被调用了、数字可追溯」；**没有**评测回答质量（第一条回答的措辞仍偏生硬）。

## 七、复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
ROCO_CODEX_LOOKUP=1 ROCO_TEAM_LOOKUP=1 DEEPSEEK_API_KEY="$KEY" node src/server/index.js &
node /tmp/roco-recon/team-advice-probe.mjs
node --test tests/roco-team-advice.test.js
```
