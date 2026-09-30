# P1-C 只读复核 + 修法方案：「下一局练一件事」空目标

**执行**：`plan06-recon`（task-45） · **时间**：2026-10-01 05:1x · **性质**：**只读复核 + 方案**（未改任何代码；等 Lead 批）
**来源**：跨机伙伴 lead-mac 的审计（OPEN-ITEMS §P1-C，锚点 `f6fd3b4`；根因 `9823ec9`）
**本步读数**：`reports/roco/product-execution/06/probe-06.5-p1c-next-step.mjs`（exit 0，原文见 §2）

> ⚠ 行号与 lead-mac 的锚点不同：`src/client/roco.js` 正被 **task-44（P1-A）** 改，现在该栏的两处在
> **`:5166`**（review 分支）与 **`:5201`**（兜底分支），不是 5151-5152/5186。**我按当前树读的**，未动该文件。

---

## 0 · 三条结论

1. **空的成因确认是「规则表不覆盖」，不是数据没到。** 手搓夹具（换宠 → 288 伤害 → 撤退）里
   `facts` 明明有料：`player_switches=1`、`heaviest-blow` 事实原文
   「关键片段：全场最重的一次伤害在第 1 回合——我方那一手打出约 288 点（用的是「甩水」），打在对方第 1 位身上。」；
   而 `next_step = null` —— 三条规则**一条都不中**（命中矩阵见 §2）。
2. **空栏有两条独立路径，都要堵**：
   - 路径 A（lead-mac 报的那一局走的就是这条）：`review === null`（这一局没有转折点/没挑出课）⇒
     页面走**兜底分支** `:5201` `depth?.next_step?.text ?? ''` ⇒ 空串 ⇒ 只剩 `roco.html:196` 的静态标签
     「**下一局练一件事**」；
   - 路径 B：`review` 非 null 但 `review.learning` 为空 **且** `next_step` 为空 ⇒ `:5167-5170` 的
     `[…].filter(Boolean).join(' ')` 也是空串。
   实测：夹具在**两条路径下都空**（`row_empty_review_branch=true` · `row_empty_fallback_branch=true`）。
3. **真局对照**：我手上两局真引擎读数（06.1 的 `raw-06.1-timeline.json`）里 `next_step` **都命中**
   `enemy-type-advantage-hit`、该栏 82/84 字符 ⇒ 缺陷是**局面相关**的（正面/中性局才空），不是每次都空 ——
   这也解释了为什么它活到今天。

---

## 1 · 复核：规则表逐条 + 页面取值口径

### 1.1 `depthNextStep`（`src/coach/roco-experience.js:734-789`）

`DEPTH_NEXT_STEP_ORDER = ['enemy-type-advantage-hit', 'our-resist-repeat', 'enemy-replacement-first']`
（`:350`，注释逐字：「次序＝产品口径：挨打最贵」）。三条全是**挑错向**：

| # | 规则 | 命中条件（逐字核对） | 产出 | 在本夹具（换宠+288+撤退）下 |
|---|---|---|---|---|
| ① | `enemy-type-advantage-hit` | `facts.blows` 里**对方**打出 `multiplier > 1` 且伤害可读（`:738-740`） | 「下一次…先换掉挨打的那一只再打」（`:744-754`） | **不中**（夹具里对方那一击是中性的 30 点） |
| ② | `our-resist-repeat` | **我方**连着两个回合 `multiplier < 1`（`:757-761`） | 「换一个系别的技能或者换人」（`:763-770`） | **不中**（我方只有 1 次出手，且是 1 倍） |
| ③ | `enemy-replacement-first` | `facts.replacements` 里有**对方**补位（`:773`） | 「补位之后先确认它是谁」（`:776-785`） | **不中**（没有补位） |
| — | 都不中 | — | `return null`（`:788`，注释：「没有本局事实支撑的『下次要……』就是套话」） | **null** ✓（正是缺陷） |

⇒ 规则表**没有一条**覆盖「换宠接应成功」「收尾打对了」「主动撤退」这类**正面/中性**事件。

### 1.2 页面两条分支（`src/client/roco.js`，当前行号）

| 分支 | 行 | 取值 | 空的条件 |
|---|---|---|---|
| review 非 null | `:5162-5175` | `const nextStep = review.depth?.next_step?.text ?? null`（`:5166`）→ `[review.learning ? '这一局学到一件事：…' : '', nextStep].filter(Boolean).join(' ')`（`:5167-5170`） | `learning` 与 `next_step` **同时**为空 |
| review === null | `:5193-5205` | `$('lesson-learning').textContent = depth?.next_step?.text ?? ''`（`:5201`） | `next_step` 为空 |

`roco.html:196`：`<div class="result-goal"><b>下一局练一件事</b><span id="lesson-learning"></span></div>`
—— 标签是**静态**的，`<span>` 空 ⇒ 玩家看到一个**没有内容的栏目标题**（lead-mac 的截图形态）。
（该 div 目前**没有 id**，但 `.result-goal` 这个 class 就在 `#lesson-learning` 的最近祖先上，隐藏它不需要改 HTML。）

---

## 2 · 实测读数（`probe-06.5-p1c-next-step.mjs`，exit 0）

### 2.1 真局对照（2 局，第三局在 06.1 里没留完整视图）

| 局 | 事件 | 结果 | `review` | `learning` | `next_step.rule` | 该栏字符数 | 规则命中 |
|---|---|---|---|---|---|---|---|
| `base` | 126 | null（未打完） | 非 null | 「打在抵抗上的那一手不要连着出…」 | `enemy-type-advantage-hit` | 82 | ① |
| `replace_diverged` | 127 | loss | 非 null | 「对面补上新的一只之后…」 | `enemy-type-advantage-hit` | 84 | ① |

### 2.2 P1-C 夹具（手搓：`switch` → 我方 `damage` 288 → 敌方 `damage` 30 → `escape`）

```json
"next_step_rule": null,
"next_step_text": null,
"review_null": true,
"row_text_review_branch": "",
"row_empty_review_branch": true,
"row_text_fallback_branch": "",
"row_empty_fallback_branch": true,
"data_present": {
  "player_switches": 1,
  "heaviest_blow_text": "关键片段：全场最重的一次伤害在第 1 回合——我方那一手打出约 288 点（用的是「甩水」），打在对方第 1 位身上。"
},
"facts_available": ["heaviest-blow", "worst-turn-taken", "switch-ledger"],
"hits_on_synthetic": {"enemy-type-advantage-hit": false, "our-resist-repeat": false, "enemy-replacement-first": false}
```
⇒ **数据在、规则不覆盖**：这就是 ① 要证的结论，不是「事件没送到」。

---

## 3 · 修法方案（推荐 + 取舍）

### 3.1 空兜底（UI，两处都做）

**推荐**：两条分支都先算出「这一栏要写什么」，**为空就隐藏整行**（`#lesson-learning` 的最近 `.result-goal`）；
有内容才显示。**不写「继续加油」这类占位文案** —— 与 lead-mac 的验收一致（「要么有内容、要么整行不显示」）。

```js
// 两条分支共用一个收口（放在 finishMatch 里，分支之前）
const setGoalRow = (content) => {
  const line = String(content ?? '').trim();
  const row = $('lesson-learning')?.closest('.result-goal') ?? null;
  if ($('lesson-learning')) $('lesson-learning').textContent = line;
  if (row) row.hidden = line.length === 0;
};
```
- review 分支：`setGoalRow([review.learning ? `这一局学到一件事：${review.learning}` : '', nextStep].filter(Boolean).join(' '))`
- 兜底分支：`setGoalRow(depth?.next_step?.text ?? '')`
- **不需要改 `roco.html`**（用 `closest('.result-goal')`），也不新增 id。
- 取舍：行隐藏后，「一个关键点 + 下一局练一件事」这个副标题（`roco.html:194`）会与内容略不匹配 ⇒
  建议**不动副标题**（它描述的是这一块的用途，不是这一行的存在性）；若 Lead 要求完全一致，另一方案是
  副标题也跟着变 —— 那要动 HTML，**超出我声明的写域**，请单独授权。

### 3.2 规则表双向（数据层，`roco-experience.js` 的 `depthNextStep`）

**次序不动**（挑错优先：`enemy-type-advantage-hit` → `our-resist-repeat` → `enemy-replacement-first`），
在**末尾追加两条正面规则**（只有挑错都不中时才轮到它们）：

| # | 新规则 | 命中条件（精确、无魔数） | 产出（`text` 必带本局回合号与事实） | anchors / fields |
|---|---|---|---|---|
| ④ | `our-switch-then-hit` | 存在我方 `switch` 事件 `s` 与我方 `damage` 事件 `b`：`b.index > s.index`、`b.turn ∈ {s.turn, s.turn+1}`、且 `b` 是**这一局我方最重的一击**（`b.damage === max(我方伤害)`） | `下一次换上来的那一只先按对位打出一手（这一局第 N 回合换上来就打出约 D 点）；换人前先把「上来先打谁」想好。` | `[s.index, b.index]` / `{turn, damage, skill_id}` |
| ⑤ | `our-finish-ko` | 存在我方 `damage` 事件 `b` 与 `faint` 事件 `f`（`f.side === 'enemy'`）：`f.index > b.index`、同回合、`b.target_slot` 与 `f.slot` 对得上（拿不到 slot 时**不**放宽） | `下一次对手剩这么一点血时，先算够不够收尾再出手（这一局第 N 回合你算对了）。` | `[b.index, f.index]` / `{turn, damage}` |

**为什么这两条不是万金油**（写进判据）：
- 每条都必须**引用本局的两个事件下标**（`anchors` 长度 ≥2 且指向真实存在的事件）；
- `text` 必须含**本局回合号**（+伤害数字/技能名），两句不同局面的 `text` **不许逐字相同**；
- 反例判据：把 `text` 换成固定一句「继续加油」⇒ **必红**（相关性 + anchors + 回合号三条同时抓）。

**取舍（要 Lead 拍板）**：
- (a) 正面规则只在**没有挑错**时出现 —— 与 06 的「先讲要改的」一致，但玩家做得好时会得到一句肯定+巩固建议；
- (b) 正面规则优先 —— 不建议：会把「该改的那一处」挤掉；
- (c) 只加 `our-switch-then-hit` 一条（最小覆盖 lead-mac 的场景）vs 加两条（也覆盖收尾）—— 我倾向**两条**，
  因为 `our-finish-ko` 同样是「正面事件→下一步练什么」的典型，且判据可以共用一套。

### 3.3 明确**不做**的

- 不做「任何局面都给一句泛泛的下一步」——那就是把空栏换成套话，正是本仓反复禁止的。
- 不在数据层给「空兜底」文案：`depthNextStep` 该返回 `null` 就返回 `null`；由 UI 决定隐藏整行。

---

## 4 · 判据（两向）+ 变异

**落点建议**：加进 `tests/roco-match-review-depth.test.js`（**已登记**、已在 `test:unit` 里，避免新孤儿文件）；
UI 那一条若要做，需要页面层判据（`tests/roco-experience.test.js` 那族是**读源码正则**的静态判据，可直接扩展）。

| # | 判据 | 两向变异 |
|---|---|---|
| ① | 夹具（换宠 → 288 → 撤退）⇒ `next_step` **非 null**、`rule === 'our-switch-then-hit'`、`anchors` 指向那两个事件、`text` 含回合号与 288 | 把规则表改回**单向**（删掉新规则）⇒ **必红** |
| ② | 空局面（无可总结事件，如只有一条 `turn_start`）⇒ 纯函数 `next_step === null`；页面层 `.result-goal` **hidden**（不是空串） | 把兜底改成硬编码一句 ⇒ **必红**（且 `text` 不含本局事实） |
| ③ | 非恒真：两个不同正面局面（换宠打出重击 vs 收尾击倒）⇒ 两条 `text` **不相同**、各自含本局回合号 | 把两条 `text` 写成同一句 ⇒ **必红** |
| ④ | 回归：既有三条挑错规则**次序与产出不变**（`enemy-type-advantage-hit` 优先于新规则） | 把新规则插到最前 ⇒ 既有 `:369` 的 `enemy-replacement-first` 用例 + 先后次序判据红 |

**变异执行方式**：临时副本（`git archive`）+ 改坏源码再跑，沿用 06/H1 那一套；每轮还原并复核 hash。

---

## 5 · 需要动的文件（**超出我声明的写域，先报批**）

| 文件 | 改动 | 在 task-45 声明写域里？ | 阻碍 |
|---|---|---|---|
| `src/coach/roco-experience.js` | `depthNextStep` 追加两条正面规则（`:734-789`）+ 常量表 `:350` | ❌ **不在**（声明写域是 `roco.js` / `teacher.js`）⇒ **请批** | 无（该文件当前无在飞写入者，我先确认） |
| `src/client/roco.js` | 两处收口改成「空则隐藏整行」（`:5166-5170`、`:5201`） | ✅ 在 | **task-44 占用中**，等你通知 |
| `tests/roco-match-review-depth.test.js` | 加 ①③④ 三条判据 | ✅「相关判据」 | 无 |
| `tests/roco-experience.test.js` | 若要在页面层钉「空则隐藏」，改/加一条静态判据 | ✅「相关判据」 | 与 task-44 改同一文件？需错峰（它改 `roco.js`，这条判据也读 `roco.js` 源码） |
| `reports/roco/product-execution/06/` | 本报告 + 探针 | ✅ | — |

**与 06.2 的折入方式**（Lead 要求「别让它变成孤儿改动」）：
- 06.2 §2.6（06.4a 四段正文）里补一行：**「下一局练一件事」一栏的取值规则 = 06.2 §1.2 的 `next_step` 规则表**，
  并在 06.2 的「必做反例」里加一条 **E-X3**：**无本局事实支撑的「下一步」不许出现（宁可不显示整行）**；
- 06.2 §1.2 的 A20/A21（四段正文判据）旁加交叉引用：本栏的空/非空口径由 P1-C 统一。

---

## 6 · 建议的执行顺序（等你批）

1. `roco-experience.js`：加两条正面规则（纯函数、无 UI 依赖）⇒ 跑 `tests/roco-match-review-depth.test.js`（应绿）；
2. `tests/roco-match-review-depth.test.js`：加判据 ①③④ + 两向变异读数；
3. 等 **task-44 提交后**再动 `roco.js` 的两处收口（②的页面层），并补页面层判据；
4. 报冻结（每次改动都给 hash + 命令 + 退出码 + 变异读数）。

**阻塞**：`roco.js` 被 task-44 占用（我按你指示先不动）；`roco-experience.js` 是否批准我动，等你一句话。

---

# §7 · 实施记录（数据层已落地 · 2026-10-01，Lead 三件全批之后）

## 7.1 改了什么（`src/coach/roco-experience.js`，只动 `depthNextStep` 与其常量段）

1. `DEPTH_NEXT_STEP_ORDER`：三条挑错向**之后**追加 `'our-switch-then-hit', 'our-finish-ko'`（次序＝**挑错优先、正面殿后**）；
2. 新 helper `depthHeaviestPlayerBlow(facts)`：我方可读伤害里最重的一次（并列取先发生的 ⇒ 次序稳定）；
3. 规则 ④ `our-switch-then-hit`：我方**主动换人**（`index < 那一击`、`turn ∈ {hit.turn, hit.turn−1}`、两者回合号都得是整数）
   之后打出**这一局我方最重的一击** ⇒ 下一步「换上新的一只先按对位打一手，换人前先想好『上来先打谁』」；
   `anchors=[switch.index, hit.index]`、`fields={turn, damage, skill_id, to_slot}`；
4. 规则 ⑤ `our-finish-ko`：我方那一手**同回合**把对方某一位打到倒下，且 `target_slot === faint.slot`
   （**拿不到 slot 就不放宽**）⇒ 下一步「对手剩这么点血时先算够不够收尾（这一局你算对了）」；
   `anchors=[hit.index, faint.index]`、`fields={turn, damage, slot}`；
5. 一条都不中仍然 `return null`（**没有**在数据层加占位句；隐藏整行是 UI 的事）。

## 7.2 读数（命令 + 退出码）

| # | 命令 | 退出码 | 原文 |
|---|---|---|---|
| 1 | `node reports/roco/product-execution/06/probe-06.5-p1c-next-step.mjs`（**改后**） | 0 | P1-C 夹具：`next_step_rule: "our-switch-then-hit"` · `next_step_text: "下一次换上新的一只之后，先按对位打出一手（这一局第 1 回合换上来，就打出了约 288 点）；换人前先把「上来先打谁」想好。"` · `row_empty_review_branch: false` · `row_empty_fallback_branch: false`（**改前两条都是 true**）；两局真引擎对照仍走 `enemy-type-advantage-hit`（次序未变） |
| 2 | `node --test --test-concurrency=1 tests/roco-match-review-depth.test.js` | **0** | `ℹ tests 14 / pass 13 / fail 0 / skipped 1`；新增三条用例：`P1-C ①`（正面局面必须给相关下一步）· `P1-C ②`（四条反证：删掉那一击/换人在后/目标位次对不上/只有换人 ⇒ 都不许命中）· `P1-C ④`（次序 + 既有三条**逐字**产出回归） |
| 3 | 同组回归：`tests/roco-match-review-depth.test.js tests/roco-experience.test.js tests/roco-review-u10.test.js tests/roco-review-body-fallback.test.js` | **0** | `ℹ tests 50 / pass 49 / fail 0 / skipped 1` |

## 7.3 两向变异（临时副本 `E:\roco-scratch\plan07\p1c`，`git archive HEAD src tests scripts package.json`）

| 变异 | 做了什么 | 读数 |
|---|---|---|
| ① 副本基线 | 未变异 | **exit 0 · 14/13/0/1** |
| ② **A 退回单向** | `DEPTH_NEXT_STEP_ORDER` 删掉两条正面向规则 | **exit 1 · 12 pass / 1 fail**，红的是 `P1-C ①`（正面局面给不出下一步） |
| ③ **B 兜底硬编码套话** | `depthNextStep` 末尾 `return null` → 恒返回「下一局继续加油。」 | **exit 1 · 10 pass / 3 fail**，红的是 `P1-C ②` + 既有两条 fail-closed 判据 |
| ④ **C 正面规则插到最前** | 次序改成 `our-*` 在前 | **exit 1 · 11 pass / 2 fail**，红的是**既有 ①**（三条规则次序）+ `P1-C ④`（次序回归判据有牙） |
| ⑤ 还原 | 把工作树那份覆盖回去 | **exit 0 · 14/13/0/1** |

## 7.4 状态与未竟事项

- **数据层（本步）**：已落地 + 判据 + 三向变异，全部绿。
- **UI 层（未做，等解锁）**：`src/client/roco.js` 的 `:5166-5170`（review 分支）与 `:5201`（兜底分支）改成同一收口
  「内容为空 ⇒ `$('lesson-learning').closest('.result-goal').hidden = true`，有内容才显示」；
  **副标题与 HTML 不动**（Lead 已批）。改完补页面层判据（静态正则 / 或 `roco-experience.test.js` 那族）。
- **折进 06.2** 已完成：§2.6 加了「下一局练一件事」一栏的取值行 + 必做反例 **E-X3**（三向判据 + 变异 B 已验红）。
- **不在本刀范围**（留给 task-33 的共用件迁移）：`roco-experience.js` 的玩家可见数字仍走内联整数插值
  （与既有 5 条规则的写法一致）；迁移到 `playerNumber/playerQuantity` 时应与整个深度层一起做，避免同一文件两套口径。
- **未跑**：浏览器级验收（`roco.js` 未改，且 8765 不重启）——留给 Lead 的玩家侧复验。

---

# §8 · UI 层准备（判据的**决策逻辑**已落地；页面两处补丁等解锁）

## 8.1 为什么把「这一栏该不该显示」抽成纯函数

这一栏有**两条独立入口**（`review` 非 null 的主分支、`review === null` 的兜底分支）。若两处各自拼字符串，
「只堵一条」是迟早的事 —— lead-mac 报的那一局走的正是兜底那条。所以先落一个纯函数
**`lessonGoalRow({review, depth}) → {text, visible}`**（`src/coach/roco-experience.js`，加性导出）：

```js
const learning = review?.learning ? `这一局学到一件事：${review.learning.trim()}` : '';
const nextStep = typeof depth?.next_step?.text === 'string' ? depth.next_step.text.trim() : '';
const text = [learning, nextStep].filter(Boolean).join(' ');
return {text, visible: text.length > 0};     // 空 ⇒ visible:false ⇒ 页面隐藏整行
```
文本口径与页面原来**逐字一致**（`这一局学到一件事：X` + 空格 + `next_step.text`），所以主分支不会因为这次收口改文案。

## 8.2 判据（已落地、已绿；两向变异已跑）

`tests/roco-experience.test.js` 新增 `P1-C：lessonGoalRow —— 空就 visible:false`，覆盖：
两条路径各自为空 ⇒ `{text:'',visible:false}`（**不是空串**）· 路径 A 有 `next_step` ⇒ 可见且文本含「约 288 点」·
只有 `learning` ⇒ 仍可见（不许把老师那句也藏掉）· 两段都有 ⇒ 逐字等于原拼法 · 非恒真（两个不同输入不许同一句话）。

| 读数 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 工作树 + 副本基线 | `node --test --test-concurrency=1 tests/roco-experience.test.js` | 0 | `tests 18 / pass 18 / fail 0` |
| **变异 D（页面口径）** | 把 `lessonGoalRow` 改成「空也返回一句套话且 `visible:true`」 | **1** | `17 pass / 1 fail` —— **只红那条 P1-C 判据**（定向，不误伤） |
| 还原 | — | 0 | `18/18` |

## 8.3 解锁后要落的页面补丁（**已备好，等 task-44 提交**）

```js
// finishMatch() 内、两条分支之前：一个收口
const applyGoalRow = ({text, visible}) => {
  const line = $('lesson-learning');
  if (line) line.textContent = text;
  const row = line?.closest('.result-goal') ?? null;
  if (row) row.hidden = !visible;      // 空 ⇒ 整行不显示（不是留一个空标签）
};
// 主分支（现 :5166-5170）
applyGoalRow(lessonGoalRow({review, depth: review.depth}));
// 兜底分支（现 :5201）
applyGoalRow(lessonGoalRow({review: null, depth}));
```
**副标题与 HTML 不动**（Lead 已批：那是这一块的用途说明）。同批加一条**静态判据**（放 `tests/roco-experience.test.js`，
与既有的页面接线判据同族）：`roco.js` 必须调用 `lessonGoalRow(`，且两处 `$('lesson-learning').textContent` 都要经
`applyGoalRow`（**不许**再出现 `= depth?.next_step?.text ?? ''` 这种「空串写进去」的写法）；
其两向变异 = 把兜底改回写空串 ⇒ 该静态判据必红（与 §8.2 的行为判据互补）。

> 为什么这条静态判据**现在不加**：加在页面补丁之前它会立刻红（树里不留红），所以与补丁同批落；
> 而「决策逻辑」那一半已经用纯函数判据在今天钉住了。

---

# §9 · E-X3 与 06 阶段裁决的一致性核对

| 06 裁决 | 与 E-X3 / 本刀的关系 | 判定 |
|---|---|---|
| **Q1** 判定/叙述边界（`decisions[]` 冻结当时信息 + `narrative` + 每条陈述 `basis`） | 本栏属于**叙述侧**（用的是整局事件，允许 `after_the_fact`）⇒ 06.4 拼正文时这一句必须标 `basis:'after_the_fact'` | **不冲突**，补一条口径 |
| **Q2** 快照按 `decision_id` / 对不上 ⇒ `absent` | 本栏不读快照（只读本局事件） | 无关 |
| **Q3** 适配器两步（先文本逐字不变） | 本刀改的是**页面渲染**（哪一行显示什么），`teacher.js` 的输出文本一字未动 | 不冲突 |
| **Q4** `grade.kind` 枚举 + journal 可统计副本 | `next_step` 不是 `grade`；若 06.4 让本栏改读 `decisions[]`，E-X3 仍需成立（两条判据可并存） | 不冲突 |
| **Q5** 判据登记归 task-27 | 新判据放进**已登记**的 `tests/roco-experience.test.js` 与 `tests/roco-match-review-depth.test.js` ⇒ **不新增孤儿文件** | 一致 |
| **Q6** 干净树复跑基线 | 全部加性改动，当前全绿；冻结时按干净树复跑 | 一致 |
| **D-31 / H3**（数字口径：整数原样、非整数 1 位、脏值占位） | 新规则文本里的数字是**整数**（`约 288 点`），未引入长浮点；整个 `roco-experience.js` 迁到 `playerNumber/playerQuantity` 时这几句要一起迁（§7.4） | 不冲突 |
| **H1**（裸 null/undefined/NaN） | 新文案只有中文 + 整数，无裸字面量 | 不冲突 |
| **D-2**（玩家禁用词） | 新文案未引入禁词；但注意 `player-copy` / `plain-speak` **不扫** `roco-experience.js`（见 §10） | 不冲突，另登记缺口 |

---

# §10 · 新登记的覆盖面缺口（同族「门外文案」）

**读数**（grep，0 命中）：`reports/roco/product-execution/crosscut/player-text-corpus.mjs` 里
**没有** `rocoMatchDepth` / `rocoMatchReview` / `next_step` —— 也就是说**整个深度层 + 复盘装配层的玩家可见文本**
（5 条 `next_step`、6 条 `facts`、`summary`、复盘正文与依据）都**不在** `player-text-gate` 的语料里；
而 `player-copy` / `plain-speak` 的扫描清单也不含 `roco-experience.js`。
⇒ 这一层的文案目前**没有任何自动化门禁**（与 `practiceQuestion` 静默 0 条同族）。
**建议**（等 Lead 定，我不跨域改）：与 `compareTurnAlternatives` / `coachSelfAudit` 同批把
`rocoMatchDepth`（含 `next_step`）与 `rocoMatchReview` 的可见字段补进语料并登记进 `CORPUS_PRODUCERS`；
在此之前，本刀的新文案由 `tests/roco-match-review-depth.test.js` 的 `assertNoForbidden`（禁词）与
`P1-C ①②④`（事实相关性）守着。
