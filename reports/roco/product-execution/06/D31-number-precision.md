# D-31 · 复盘正文露出内部浮点：修复 + 守卫判据（窄例外）

**执行**：`plan06-recon` · **时间**：2026-09-30 23:4x · **性质**：**实现**（Lead 裁决 D-31；写域 = `src/coach/teacher.js` + 新判据文件 + 本目录）
**来源**：lead-mac 全功能审核 —— 「复盘正文露出 13 位浮点：`评分差 6523.247662596753`」

---

## 0 · 三条结论

1. **病灶确认，而且不是边角**：`src/coach/teacher.js:332` 直接内插 `decision.gap`。
   实测（改前）**7/7 个真种子**的整局复盘都露 ≥3 位小数（不是只有 lead-mac 遇到的那一局）：
   `4255.483230613136` / `6507.059589066636` / `930.0223059866958` / `7973.425277208171` /
   `6512.524209270239` / `7973.425277208171` / `57.37276392038296`。
2. **修法选 `toFixed(1)`，不删数字**：与同仓「给玩家看的分数」口径一致（`strategist.js:40` `toFixed(1)`），
   改动最小，且那句话本身已经写明「事前一回合的公开信息，不是结果反推」——数字留着仍可核对；
   取不到 ⇒ 如实写「未登记」（沿用该文件既有的 `?? '未登记'` 口径）。**没有**引入「很小/明显」这类新阈值
   （那要新定标定口径，超出这一刀）。
3. **守卫判据量的是行为**（不是扫源码）：`src/coach` 的源码里 `${d.gap}` 一个数字都没有，静态扫描看不见它。
   新判据 `tests/roco-player-number-precision.test.js` 真的跑生产者、读**玩家可见面**，
   断言 `!/\d+\.\d{3,}/`；6 条覆盖六个可见面，改前 2 红、改后 6 绿、去掉 `toFixed(1)` 后恰好那 2 条红。

---

## 1 · 改前 / 改后

**改前**（`src/coach/teacher.js:332`，原文逐字）：

```js
return `当时可比较的两个候选动作：${alts.slice(0,2).map(o=>`「${o.name}」`).join('与')}；评分差 ${decision.gap??'未登记'}（事前一回合的公开信息，不是结果反推）。`;
```

**改后**（`src/coach/teacher.js:332-340`）：

```js
const gapNumber=decision.gap===null||decision.gap===undefined||decision.gap===''?NaN:Number(decision.gap);
const gapText=Number.isFinite(gapNumber)?gapNumber.toFixed(1):'未登记';
return `当时可比较的两个候选动作：${alts.slice(0,2).map(o=>`「${o.name}」`).join('与')}；评分差 ${gapText}（事前一回合的公开信息，不是结果反推）。`;
```

**为什么这样写**（三点，都可核对）：
- `Number(...)` 而不是直接 `.toFixed`：`decision.gap` 来自 `turnDecision()`（`teacher.js:200`，`alternatives?.gap ?? null`），
  理论上可能是数字/数字字符串/null；`null` 经 `Number(null)` 会变 `0`，所以先显式把 `null/undefined/''` 归成 `NaN`
  ⇒ 落到「未登记」，不会把「没有这个数」印成「0.0」（那是编造）。
- `toFixed(1)` 与 `strategist.js:40` 同一精度；`roco-experience.js:1148/1150` 用 `toFixed(2)`、
  `coach-advice.js:695/719` 用 `toFixed(3)` —— 本刀**不**去动那三处（各自有口径，不在 D-31 范围）。
- 该文件另有一条既有判据「正文不得含裸 JS 值字面量（`undefined`/`null`/`NaN`）」
  （`tests/roco-teacher-review-text.test.js:8,17`）⇒ `未登记` 兜底同时守住它。

**diff 规模**：`src/coach/teacher.js` **+9 −1**（含 7 行注释，说明病灶、口径与理由）。

---

## 2 · 守卫判据（新增）

**文件**：`tests/roco-player-number-precision.test.js`（sha256 前 16 = `9A342BAB816F0BF5`，10 096 B）

| # | 用例 | 量的可见面 | 改前 | 改后 |
|---|---|---|---|---|
| ① | 真对局的整局复盘：玩家可见面里不许出现 ≥3 位小数 | `reviewMatch({lastMatch})` 的 `text + brief + evidence[] + choices[]`，**7 个真种子**（1/2/3/5/11/17/24，真引擎 `step` 跑完整局） | **红（7/7 命中）** | 绿 |
| ② | 关键回合那一句的评分差：浮点必须被格式化（D-31 正主） | 同一可见面 + 强制 `gap = 6523.247662596753` 的夹具；并额外断言「评分差后面那一段」形如 `^\d+\.\d$|^\d+$|^未登记$` | **红** | 绿 |
| ③ | 军师那一侧（同一类内部评分） | `strategist({...ctx, query:'这回合怎么打'})` 的 `text + evidence[] + knowledge[]` | 绿 | 绿 |
| ④ | 六宠局末复盘（另一条入口） | `rocoMatchReview(...)` 的 `review.text + review.evidence[]`（合成但形状真实的六宠输入） | 绿 | 绿 |
| ⑤ | 局内建议（高压反例那一局） | `battleAdvice({battle, plan:null})` 的 `headline/risk/why/text` | 绿 | 绿 |
| ⑥ | 陪练的一句人话 | `companion({mode:'camp'}, freshMemory(), 四句)` 的 `text` | 绿 | 绿 |

**白名单机制**（Lead 要求「确有高精度需求要显式登记 + 理由」）：判据里有一个 `ALLOW` 数组
（`{surface, test, reason}` 形状），**当前为空** —— 玩家可见面里没有任何一处需要 ≥3 位小数。
需要高精度的**非玩家可见**字段（内部诊断、调试字段）根本不进 `scan()` 的入参，因此不需要登记；
将来若有玩家可见处确实要 ≥3 位小数，必须往 `ALLOW` 里加一行并写理由，否则守卫红。

**测试口径**：`node --test --test-concurrency=1`（本仓 `test:unit` 的既定串行口径）。

---

## 3 · 读数（命令 + 退出码 + 原文）

| # | 命令 | 退出码 | 原文 |
|---|---|---|---|
| 1 | `node --test --test-concurrency=1 tests/roco-player-number-precision.test.js`（**改前**，4 条版本） | **1** | `ℹ tests 4 / pass 2 / fail 2`；命中清单原文：`复盘 seed 1: …「回复药 → 潮甲龟」与「撞击」；评分差 4255.483230613136（事前一回合的公开信息，…` / `seed 2 … 6507.059589066636` / `seed 3 … 930.0223059866958` / `seed 5 … 7973.425277208171` / `seed 11 … 6512.524209270239` / `seed 17 … 7973.425277208171` / `seed 24 … 57.37276392038296`；② `关键回合评分差: …评分差 6523.247662596753（…` |
| 2 | 同上（**改后**，6 条版本） | **0** | `ℹ tests 6 / pass 6 / fail 0 / skipped 0` |
| 3 | 同组回归：`node --test --test-concurrency=1 tests/copy.test.js tests/coach.test.js tests/roco-teacher-review-text.test.js tests/roco-review-body-fallback.test.js tests/roco-teaching-loop.test.js tests/roco-xiaoya-context.test.js tests/roco-plain-speak.test.js` | **0** | `ℹ tests 126 / pass 126 / fail 0`（含 `roco-plain-speak`：它把 `src/coach/teacher.js` 列在扫描清单里，teacher.js 目前 hard/soft 欠账表里**没有**条目 ⇒ 新增/改动的字面量必须保持 0 命中） |
| 4 | **两向变异①（已修）**：临时副本 `E:\roco-scratch\plan06\mut`（`git archive HEAD src package.json` + 工作树那份已修 `teacher.js` + 守卫） | **0** | `FIXED_EXIT=0` · `ℹ tests 6 / pass 6 / fail 0` |
| 5 | **两向变异②（去掉 `toFixed(1)` 回到原始内插）**：同副本，只改那一个表达式 | **1** | `MUTATED_EXIT=1` · `ℹ tests 6 / pass 4 / fail 2`，红的两条**恰好**是 ① 与 ②（`✖ ① 真对局的整局复盘…`、`✖ ② 关键回合那一句的评分差…`），其余四条不受影响 ⇒ 守卫有牙且不误伤 |

**改动文件的树读数**：

| 文件 | 状态 | sha256 前 16 | 字节 |
|---|---|---|---|
| `src/coach/teacher.js` | `M`（+9 −1） | `B55A3930E66ADA7C` | 47 933 |
| `tests/roco-player-number-precision.test.js` | 新增（未跟踪） | `9A342BAB816F0BF5` | 10 096 |
| `package.json` | `M` —— **不是我改的**（task-27 / plan05-recon 正在登记孤儿判据）；本刀一个字都没动它 | — | — |

---

## 4 · 覆盖面（照实写：扫了什么、没扫什么）

**已扫（判据里真的跑了）**：营地整局复盘（7 真种子）· 六宠局末复盘 · 军师（含知识卡原文）·
局内建议 · 陪练回复。

**未扫（登记为缺口，别当成已覆盖）**：
- **模型生成的回答**（DeepSeek/本地模型）—— 不在源码里，也不在本地纯函数范围；`/api/coach` 的回答要另设运行时探针。
- `src/client/**` 的页面内联文案（`roco.js` / `app.js` 等）—— 页面渲染出来的数字要浏览器探针才算数；
  本轮只覆盖「进页面前的那一层」（这些字符串的来源函数）。
- `roco-experience.js` 的 `rocoDamagePreviewText` / `depth` 的估计值 —— 它已用 `toFixed(2)`，
  但本轮**没有**为它单独写断言（若要，可并入 ④ 的可见面扫描，成本很低）。
- `toolbox.js` 的工具回执（它进模型上下文，不进玩家视野，按 `player-copy.test.js:68-74` 的既有豁免口径不算玩家文案）。

---

## 5 · 需 Lead 裁决

| # | 问题 | 我的处置 / 倾向 |
|---|---|---|
| D31-Q1 | **量级口径**：`toFixed(1)` 之后仍会读到「评分差 7973.4」这种四位数 —— 观感上像分数，而 `src/coach/client.js:3` 的 `RESPONSE_INSTRUCTIONS` 明确要求「不要向玩家报内部局面评分」 | 本刀只做**精度**（D-31 原文），没改口径。若要改成定性描述（「两手差别明显」），需要先定阈值与措辞 ⇒ **另开一刀**，请 Lead 定 |
| D31-Q2 | 新判据文件的**登记**：结构契约要求每个 `tests/**/*.test.js` 被某个 npm script 或 `guard-selftest.mjs` 引用；本刀不碰 `package.json`（task-27 独占） | 文件名报给 Lead 转 task-27；在登记落地前，`tests/evals/structure-contract.test.js` 的孤儿数会从 9 → 10（**已知的过渡态**，不是我引入的机制问题） |
| D31-Q3 | 是否把 §4「未扫」的两项（模型回答、页面渲染）也纳入守卫 | 建议另立运行时探针（浏览器/`/api/coach`），不塞进这条纯函数判据 |

---

## 附录 · 复跑命令

```sh
# 守卫判据
node --test --test-concurrency=1 tests/roco-player-number-precision.test.js      # 期望 exit 0 · 6/6

# 受影响的既有判据（改文案必跑）
node --test --test-concurrency=1 tests/copy.test.js tests/coach.test.js \
  tests/roco-teacher-review-text.test.js tests/roco-review-body-fallback.test.js \
  tests/roco-teaching-loop.test.js tests/roco-xiaoya-context.test.js tests/roco-plain-speak.test.js
# 期望 exit 0 · 126/126

# 两向变异（临时副本，不动工作树）
bash /mnt/e/roco-scratch/plan06/prep-d31-mutation.sh
# 然后在 E:\roco-scratch\plan06\mut 里：
#   ① node --test --test-concurrency=1 tests/roco-player-number-precision.test.js   → 6/6 绿
#   ② 把 teacher.js 里 `gapNumber.toFixed(1)` 改回 `gapNumber`                       → 4/6，红的是 ①②
```
