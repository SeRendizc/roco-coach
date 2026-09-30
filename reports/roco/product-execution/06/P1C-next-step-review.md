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
