# 判定口径的影子档：49 例实测（2026-09-25）

> 人类要求：「**把口径钉死在代码上** → 落 `ROCO_JUDGE=shadow`（只记录不改行为）→ **真跑那 49 例** →
> 两套口径各自与金标的一致数 + 分歧 case id 清单 + 一条判据一条必红反证」。
> 本文件只写实测数字，不写过程。

## 0. 先纠正一处前提（任务书里的）
那 49 例的金标在 **`scripts/eval-live-s04.js` 的 `CASES`（`:136` 起）**，**不在** `scripts/roco/shadow-replay.mjs`
（后者是 288 条**本地臂**回放，金标走 `checkTask`）。两者不是同一个评测。

## 1. 口径在代码里具体是哪一处（逐行）
| 口径 | 位置 | 它决定什么 |
|---|---|---|
| **(乙)** | `src/coach/runtime.js:179-188` `policyFor()`：末行默认 `{need:null, reason:'state-in-packet'}`；只有包里结构上没有的四类（指定回合 / 分支模拟 / 整局分页 / 战术规则）才要工具 | 「该不该调」由**代码**判：实时状态**从 receipts 答** |
| **(乙) 同党（提示词）** | `src/server/index.js:442-447`：「**默认是停止**……不需要调用的情况：……任何你已经能从 receipts 答出来的问题」「**receipts 里已经有的事实不要再调工具去确认**」 | 模型的「该不该调」也按 (乙) |
| **(甲)** | `scripts/eval-live-s04.js:136+` `CASES` 的 `cat1-needs-lookup`，`expect.calls:[1,1]` | 金标：问当前局面事实**必须查证** |

⇒ **是两方冲突（代码 + 提示词 一致地站在 (乙)，金标站在 (甲)），不是三方。**
另外：`:289-301` 那段是 **selftest**（桩 planner），真跑 49 例走 **HTTP** `POST /api/coach`（`:345` 一带）。

## 2. 实现（`ROCO_JUDGE` 默认 `off`）
- `src/coach/runtime.js` 新增 `judgeMode()`（默认 `off`；未知值 fail closed 当 `off`）与 `judgeToolNeed(message, context)`：
  只回答「(乙) 怎么判 / (甲) 会怎么判 / 一致吗」，字段 `{mode, policy, alternative, agree, basis, note}`。
- `runCoach` 的返回**只在开关不是 off 时**多挂一个 `judgment` 字段；**行为一个字没改**（`mustCall` 仍取 `policy.need`，见 §4 结构钉）。
- `scripts/eval-live-s04.js` 两处**加性**改动：`ORIGIN` 允许用 `ROCO_EVAL_ORIGIN` 覆盖（影子档要在自己的服务上跑，别占人类在看的 8765）+ 记录 `answer.judgment`。

## 3. 实测数字（49 例真跑，云臂 deepseek-flash，0 报错）
| 量 | 实测 |
|---|---|
| 执行 / 报错 | **49 / 0** |
| **(乙) 现行为 vs 金标** | **28 / 49 符合** |
| **(甲) 替代判定 vs 金标** | **27 / 49 符合** |
| 两者都对 | 19 |
| **甲对/乙错** | **8**（全部 `cat1-needs-lookup`：c01 c02 c05 c07 c08 c09 c10 c11） |
| **乙对/甲错** | **9**（`cat2-parametric` c13 c15 c16 c17 c18 c20 c22 c23 + `cat4` c38） |
| **两者都错** | **13**（`cat3-cross-tool` c25–c34 共 10 + `cat1` c12 + `cat2` c21 + `control-locked` c44） |
| `judgment` 覆盖 | 48/49；缺 `c43` —— 见下 |

**`c43` 为什么没有 judgment**：它是 `control-policy` 用例（「线上竞技这回合我该不该用防御？」），
`route:'policy'`、**在进入工具循环之前就早返回**（PVP 限制那条路径），所以根本不存在"该不该调"的决策。
**这是正确行为**，不是漏记。

### 关键读法（比"哪边赢"更重要）
1. **(甲) 不是无条件的更好**：它把 8 条 `cat1`（该查的局面问题）修好，**代价是把 9 条本来不该查的弄坏**
   （8 条 `cat2-parametric` + 1 条 `cat4-should-stop`）——那些问题 receipts 里真有答案，强调查证是浪费、且可能引来错误引用。
2. **净效果几乎打平（28 : 27）** ⇒ **现状口径在金标上并不更差**；争议的正确解法**不是选一边**。
3. **真正的短板不是口径，是 `cat3-cross-tool`（10 条两方都错）**：金标要求**两个不同证据源**，
   而两条口径都只会在"要不要调一次"上做文章 ⇒ **跨工具/多步能力缺失**，与口径无关。
4. 由此得出设计结论：**分辨甲/乙不能靠"这句话在问什么"**（`cat1` 与 `cat2` 的字面高度重叠，我的 (甲) 规则
   `LIVE_STATE_ASK` 正是在这里把 `cat2` 误伤 9 条）——正确判据是**"这份 receipts 里到底有没有这个事实"**。
   这也是把 (甲)/(乙) 之争变成可判定问题的唯一路径。

## 4. 判据 + 必红反证（`tests/roco-judge-shadow.test.js`，已进 `test:unit`，实测 4/4）
- ① **off 档**：回执里没有 `judgment`；**shadow 档去掉 `judgment` 之后与 off 档逐字节相同**（证明只多字段、不改行为）。
- ② **shadow/on 档**：逐例都带替代判定，且四类问题（局面 / 指定回合 / 寒暄 / 战术）的 `policy.reason`、`alternative.reason`、`agree` 与口径定义一致；`judgeMode({})==='off'`、未知值 fail closed。
- ③ **结构钉**：`runtime.js` 里 `mustCall` 必须取自 `policy.need`，**不许出现 `judgment`/`alternative`**。
- ④ **必红反证**：把 (甲) 写进行为（`mustCall: judgment.alternative.need`）⇒ 必须报；off 档多出字段 ⇒ 必须报；采样失败 ⇒ 必须报（**读不到不算验过**）；健康输入必须判空（判据不是恒假）。
- 回归：`tests/coach.test.js` + `tests/roco-server-side-guard.test.js` **41/41 绿**（改 `runtime.js` 后没碰坏既有链路）。

## 5. 复现命令
```bash
# 1) 起影子档服务（随机端口，别占 8765/8766）
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
PORT=8931 ROCO_JUDGE=shadow DEEPSEEK_API_KEY="$KEY" node src/server/index.js &
# 2) 真跑 49 例（指向影子服务）
ROCO_EVAL_ORIGIN=http://127.0.0.1:8931 node scripts/eval-live-s04.js
# 3) 判据与反证
node --test tests/roco-judge-shadow.test.js
```
产物：`reports/live-model-eval-raw.json`（49 行，含 `judgment`）、本目录 `rows-49-with-judgment.json`。
