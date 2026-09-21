# 老师（teacher）：局末复盘与学习闭环

日期：2026-09-21（第 45 轮）
代码：`src/coach/teacher-review.js`（判定与记账）、`src/coach/roco-experience.js` 的
`rocoMatchReview`（装配）、`src/client/roco.js` 的 `finishMatch`（页面）
验收：`tests/evals/teacher-review.test.js`（14 项，构造的真实事件形状）、
`tests/evals/roco/teacher-match-review.test.js`（3 项，**真服务打完整局**）

---

## 0. 这一角要对上的是哪几条要求

用户对「老师」的定义（原文口径）：

| 要求 | 现在落在哪 | 可核对的东西 |
|---|---|---|
| 局末**自动**给一段自然语言复盘 | 页面 `finishMatch`（对局一结束就调，不需要玩家开口） | `demo-acceptance` 的局末判据、`data-roco-lesson="shown"` |
| 一个**关键转折点** | `chooseTurningPoint`：`first-faint` / `damage-lead-flip`，返回 `rule` 说明为什么挑这一回合 | `review.turning_point.{turn,rule,candidates,what}` |
| 一条**可执行**的学习点 | `GOAL_LESSON[goal]`，每门课一句能照做的做法 | `review.learning`；用例断言它不是「要更小心」这类空话 |
| 在**后续对局**里验证有没有改善 | `checkLearningProgress` + `recordTeacherReview` / `recordLearningCheck` | `progress.{checked,recurred,improved,note}`；页面局末显示「上一次那一课的核对」 |

**域边界**：这一套只吃手游规则引擎（`roco_env`）的事件与公开视图。
仓库里另有一个**同名**的 `src/coach/teacher.js` 的 `reviewMatch`，那是早期自创对战
Demo（`src/game/engine.js`）的聊天复盘，数据模型完全不同。两套**不许互相喂数据**——
用户明确要求只用手游数据，所以 `runtime.js` 那条聊天链路保持原样，本文件不涉及它。

---

## 1. 判定：讲哪一门课

`TEACHER_GOALS` 五门，每门都是一个**能照做的做法**：

| goal | 什么时候够得上 | 一句改法 |
|---|---|---|
| `use-item-before-danger-line` | 我方有伙伴倒下，且这一局有可用回复药（用过、或背包里还有） | 血线掉下一半时先把回复药吃掉，再决定继续输出还是换人 |
| `switch-out-of-the-bad-matchup` | 倒下之前吃到过属性克制的伤害 | 吃到一次克制伤害之后，下一回合先换掉这一只 |
| `treat-status-before-it-stacks` | 我方身上的异常状态在回合末扣过血 | 开始扣异常伤害之后，下一回合就处理掉 |
| `read-the-replacement-first` | 对面有伙伴倒下（补位不消耗回合） | 对面补位之后先确认它是谁、什么系，再决定打谁 |
| `stop-attacking-into-resistance` | 我方打在属性抵抗上过 | 打在抵抗上的那一手不要连着出 |

「够得上」= `evaluateGoal(...).applies === true`。`applies === false` 的候选
**不能讲**：例如背包里根本没有药，就不能教人吃药。没有一门够得上就返回 `null`（沉默）。

### 1.1 挑课的顺序（第 45 轮改过，这是本轮最重要的一处）

**改之前**：按 `TEACHER_GOALS` 的固定优先级取第一门够得上的。
**问题（实测，见 §3）**：30 个固定种子里 **30/30** 都是同一门，其中 **13 局**玩家其实
已经做对了——他这一局唯一的学习点被花在了一句表扬上。

**改之后**：按**可教性**排，四条规则写在 `reviewMatch` 里：

1. 处理方式**做错了**的课优先（`HANDLING_RANK` 里排 1 的那些）；
2. 都是错的时候，仍按 `TEACHER_GOALS` 的优先级（顺序没被推翻，只是不再压过「有没有要改的」）；
3. 这一课以前讲过、而同一档里还有没讲过的 → 先讲没讲过的（不把同一课念第二遍）；
4. 一句错都没有（全做对了）才讲「做对了」那一门——那时它确实是这一局最值得看的地方。

返回值里多了两个**可核对的记号**：`mistake_available`（这一局有没有做错的地方）与
`teaching_a_mistake`（讲的这门是不是那一处）。它们不是给玩家看的文案，是给验收用的口径。

---

## 2. 转折点：两条规则，其中一条在当前对局里几乎不可达（如实写）

`TEACHER_TURNING_POINT_RULES = ['first-faint', 'damage-lead-flip']`。

- `first-faint`：全场第一次减员那一回合；
- `damage-lead-flip`：**没有减员**时，按累计伤害差翻盘的那一回合
  （用「我方打出 − 我方承受」当血量差的代理，依据里把两个数字写出来，玩家自己能核对；
  这是产品口径的代理量，不是引擎的结算量）。

**实测（30 局，见 §3）**：`first-faint` **30/30**，`damage-lead-flip` 一次都没用上。
原因不是代码写错，而是**结构**：一局 3v3 打到分出胜负，必然有人倒下，而
`chooseTurningPoint` 先看第一次减员。也就是说在「打完了的对局」里
`damage-lead-flip` 是**实际不可达**的——它与第 39 轮发现的 `decisive-gap` 死分支同形状。
**没有删它**（构造用例 `matchF()` 仍然能触发它，删了会把「没有减员时怎么办」这条
路径变成没有验收的黑洞），但**任何「两条规则都在用」的说法都是错的**。

---

## 3. 实测：30 局真实对局（修复前 → 修复后）

怎么量：真服务（真 Python 规则引擎 + 真 HTTP 路由）按固定种子打完整局，
`auto: true` 推进，事件按页面同样的方式累计，复盘走页面用的同一个 `rocoMatchReview`。
脚本是临时探针（`/tmp/sweep-teacher-goals.mjs`，与 `teacher-match-review.test.js` 同一套调用），
种子 `1,2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109`。

样本事实：**30 局 / 平均 13.0 回合 / 15 胜 15 负 / 0 局讲不出话**。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 讲出的课 | `use-item-before-danger-line` **30/30** | `use-item-before-danger-line` **17**、`switch-out-of-the-bad-matchup` **13** |
| 处理方式 | `healed-before-faint` **13**（做对了）、`no-heal-before-faint` 17 | `no-heal-before-faint` **17**、`stayed-in-after-bad-hit` **13** |
| 把学习点花在表扬上 | **13/30（43%）** | **0/30** |
| 转折点规则 | `first-faint` 30/30 | `first-faint` 30/30 |

读法：修复后**每一局讲的都是这一局真做错的那一处**，而且真实对局里出现了两门课
（不再是同一个模板换数字）。这正好对应用户对 P1 的原话——「不能是同一个模板换名字换数字」，
在本轮之前，**老师这一角恰好就是那个模板**，只是之前没人量过。

**没到 5 门课**：这一批 30 局只够得上两门。另外三门
（`treat-status-before-it-stacks` / `read-the-replacement-first` / `stop-attacking-into-resistance`）
在构造用例里都能触发，但 `auto: true` 的贪心驱动很少留下「异常状态连着扣血」「连着两回合打抵抗」
「只对面倒人」的形状。所以它们的**真实可达性是 `unknown`，不是「不可达」**——
要下结论得换一批更长的对局或别的驱动策略，那是另一件事，本轮没做。

---

## 4. 两个输入错了都不会报错（本轮的第二个真缺陷）

页面 `finishMatch` 交给复盘的两份输入，各有一条**不许弄错、错了也不报错**的规则：

1. **事件必须是整局的**。服务端每次推进只回**这一次**产生的事件
   （`roco/service.py:1860` 的 `state.events[events_from:]`），而页面渲染用的是
   `state.events = data.view.events`。复盘若也用它，就只剩最后一回合。
   实测：整局 **70** 条事件，最后一次推进只有 **6** 条（差 11.7×）。
2. **局面必须是「最后一个还能行动的局面」**（`state.lastLiveView`），不是终局视图。
   终局视图的 `legal` 是空的，而 `rocoGameView` 的 `player.items` 是从 legal 里的
   道具动作数出来的——拿终局视图做复盘，等于告诉复盘「这一局没有药可用」。
   实测 seed 5：终局视图让那一门课从 `use-item-before-danger-line`
   （「背包里的回复药一直没有用过」）变成 `switch-out-of-the-bad-matchup`，**换了一门课**。
   终局视图里对手场上也已经是补位上来的那一只，拿它去认「倒下的那一只」就是张冠李戴。

这两条与「先核对上一课、再记这一课的账」一起收在 `rocoMatchReview` 里（纯函数、不碰 DOM），
所以 Node 侧的验收能用真对局跑同一段代码；而测试文件里**再写一遍收集顺序**，
否则「页面和验收共用同一个可能写错的实现」就白验了。

---

## 5. 学习闭环：`improved` 是三态，不是布尔

`checkLearningProgress({memory, match})` 只用 `memory.journal` 里 `kind:'teach'` 的最后一条，
`evaluateGoal` 重算这一局有没有**同一类局面**，再比两次的**处理方式档位**：

**挂账的回合是「这门课的局面」那一回合，不是转折点那一回合**（第 45 轮浏览器实测抓到的）：
一局 19 回合的真实对局里，转折点是**对方**第 10 回合第一次减员，而这门课讲的是**我方**
第 15 回合才倒下。原来存的是转折点回合，下一局的核对就写成
「对比第 10 回合（上一次：倒下之前还有回复药但没有用）与第 15 回合（这一次：…）」——
两个数字量的不是同一件事，读起来却像同一次对比。现在 `turn` 存**局面**回合（对比用）、
转折点回合另存 `pointTurn`（依据用），用例 `matchSplit` 专门造了「两个回合不同」的夹具，
反证：改回转折点回合，那条断言立刻变红。

| 情况 | `checked` | `recurred` | `improved` | 记账（`recordLearningCheck`） |
|---|---|---|---|---|
| 从没讲过课 | false | false | null | **不记** |
| 局面没再出现 | true | false | **null** | **不记**（没出现既不是做到也不是没做到） |
| 局面重复、前提不在 | true | true | **null** | **不记** |
| 局面重复、处理方式一样 | true | true | **false** | 记一条 `decision`（`reasonable:false`） |
| 局面重复、处理方式变好 | true | true | **true** | 记一条 `decision`（`reasonable:true`） |

「没法比较就不下结论、也不记账」是刻意的：把 `improved === null` 记成
`reasonable:false`，等于把「什么都没发生」算成一次失误。
`recordTeacherReview` 在没有整数回合时**拒绝写入**——挂不上回合的账，下一局没法拿两次回合做对比。

---

## 6. 怎么复现

```bash
# 判定层（构造的真实事件形状，14 项）
node --test tests/evals/teacher-review.test.js

# 真实链路（真服务打完整局：整局事件 / 可行动局面 / 反模板 / 学习闭环，3 项）
node --test tests/evals/roco/teacher-match-review.test.js

# 页面侧（局末卡片真的显示了什么）
npm run roco:demo-acceptance
```

---

## 7. 这份文档不声称什么

- 不声称这套复盘「教得好」——那要真人判据（W5-05 盲评），本轮只声称
  「讲的必须是这一局真做错的那一处」以及「真实对局里不再是一句话」。
- 不声称五门课在真实对局里都可达（§3 末尾：只有两门被实际触发，其余 `unknown`）。
- 不声称转折点选得「对」——两条规则都是产品口径的约定（第一次减员、
  累计伤害差翻盘），不是引擎的结算结论。
- 不声称 `damage-lead-flip` 有用：在有减员的收官对局里它实际不可达（§2）。
- 不声称这些文案经过真人可读性验证；`demo-acceptance` 只挡工程术语与内部 id。
