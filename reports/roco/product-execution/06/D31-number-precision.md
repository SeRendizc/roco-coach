# D-31 · 玩家可见文本的三处收口：内部浮点（D-31）· 裸 null（H1）· 精度口径（H3）+ 禁用词改词（D-2）

**执行**：`plan06-recon` · **时间**：2026-09-30（**第二版**，同刀并入 H1 / H3 / D-2）· **性质**：**实现**（Lead 裁决的窄例外）
**写域**：`src/coach/teacher.js` · `tests/roco-player-number-precision.test.js`（新增）·
`tests/roco-review-body-fallback.test.js`（**只改钉 ③ 的那一句**）· `reports/roco/product-execution/06/`
**来源**：lead-mac 全功能审核（D-31 浮点）· plan00-closer 横切文本审计（H1 脏值 · H3 精度口径）· Lead 裁决 D-2（禁用词）

---

## 0 · 六条结论

1. **D-31 病灶确认，而且不是边角**：`src/coach/teacher.js` 的「评分差」原来直接内插 `decision.gap`。
   改前实测 **7/7 个真种子**的整局复盘都露 ≥3 位小数：
   `4255.483230613136` / `6507.059589066636` / `930.0223059866958` / `7973.425277208171` /
   `6512.524209270239` / `7973.425277208171` / `57.37276392038296`。
2. **H1 确认**：`skillLesson` 对**无威力技能**（防御/蓄势/苔息/清风）也照拼
   「伤害来自 engine.damage（不防御 **null**／防御 **null**）」——实测 **4/4 无威力技能全中**，有威力技能正常。
   改前渲染原句：`伤害来自 engine.damage（不防御 null／防御 null），只按当前面板计算，不预测对手这一回合做什么。`
3. **精度口径按裁决收成 `show()` 那一套**（H3）：**整数原样、非整数 1 位、脏值写「未登记」**。
   实证：`评分差 930`（不是 `930.0`）· `评分差 6523.2` · `评分差 未登记`。
4. **D-2 改词已做**：三句玩家可见文案由「分支记录」→「候选记录」；
   `tests/evals/player-copy.test.js`（禁用词闸）与 `tests/roco-review-body-fallback.test.js` ③（逐字钉子）**同时绿**。
5. **守卫判据 = 7 条**（真跑生产者、读玩家可见面；`scan()` 同时查「≥3 位小数」与「裸 null/undefined/NaN」）。
6. **四个方向的变异都验过**（临时副本，不动工作树）：
   评分差回原始内插 ⇒ 红 ①②；整数退回裸 `toFixed(1)` ⇒ 红 ②⑦；H1 回无条件拼伤害面板 ⇒ 红 ⑦（只它）；
   文案改回「分支记录」⇒ `player-copy` + `roco-review-body-fallback` **两条一起红**；还原后 7/7 绿。

---

## 1 · D-31（浮点）改前 / 改后

**改前**（原文逐字）：

```js
return `当时可比较的两个候选动作：${alts.slice(0,2).map(o=>`「${o.name}」`).join('与')}；评分差 ${decision.gap??'未登记'}（事前一回合的公开信息，不是结果反推）。`;
```

**改后**（`src/coach/teacher.js`，用文件上方的 `showNumber()`）：

```js
return `当时可比较的两个候选动作：${alts.slice(0,2).map(o=>`「${o.name}」`).join('与')}；评分差 ${showNumber(decision.gap)}（事前一回合的公开信息，不是结果反推）。`;
```

**为什么是 `showNumber()` 而不是裸 `toFixed(1)`**（H3 裁决）：
`toFixed(1)` 会把整数写成 `930.0`，而同屏别处（军师/复盘统计）写 `930` ⇒ 同一个数两种写法。
`showNumber()` 与 `coach-advice.js:106-110` 的 `show()` 同一套：**整数原样、非整数 1 位**；
取不到（`null`/`undefined`/`''`/`NaN`/`Infinity`）⇒ 显式占位「未登记」
（`show()` 那边写 `—`，两处都是显式占位，都不装成 0）。只用于显示，不用于判断。

---

## 2 · H1（裸 null）改前 / 改后

**改前**（`skillLesson` 的第三条依据，**无条件**拼）：

```js
`伤害来自 engine.damage（不防御 ${hit}／防御 ${guarded}），只按当前面板计算，不预测对手这一回合做什么。`
```
其中 `hit`/`guarded` 在 `const hit=sk.power?damage(p,q,sk):null, guarded=sk.power?damage(p,q,sk,true):null;`
里对无威力技能就是 `null` ⇒ 玩家可见文本里出现两个 `null`。

**改后**（按 `sk.power` 分岔；有威力那一支**逐字不变**）：

```js
const damageLine=sk.power&&hit!==null&&guarded!==null
 ? `伤害来自 engine.damage（不防御 ${showNumber(hit)}／防御 ${showNumber(guarded)}），只按当前面板计算，不预测对手这一回合做什么。`
 : '它不造成伤害：这一手没有威力，不按伤害面板计算，也不预测对手这一回合做什么。';
```

**真读数**（`reports/roco/product-execution/06/probe-06.4-h1-skill-lesson.mjs`，走真生产者 `skillLesson`；
它在 `experience.js:623-629` 被当 `text`/`evidence` 直接交给提示包，再经 `roco.js:3532` 进提示展开区）：

| 技能 | `power` | 改前 `evidence[2]` | 改后 `evidence[2]` |
|---|---|---|---|
| 防御 `guard` | null | `伤害来自 engine.damage（不防御 null／防御 null），只按当前面板计算，不预测对手这一回合做什么。` | `它不造成伤害：这一手没有威力，不按伤害面板计算，也不预测对手这一回合做什么。` |
| 蓄势 `focus` | null | 同上一格（`null／null`） | 同上（不造成伤害） |
| 苔息 `moss` | null | 同上 | 同上 |
| 清风 `clearwind` | null | 同上 | 同上 |
| 火花 `ember` | 27 | `…（不防御 27／防御 10）…` | **逐字不变** |
| 破甲重击 `crush` | 30 | `…（不防御 39／防御 39）…` | **逐字不变** |

---

## 3 · D-2（禁用词）改词 + 改钉

**改词**（`src/coach/teacher.js` 三处玩家可见文案 + 一处注释）：「分支记录」→「候选记录」；
语义不变（都是"当时还有哪些合法选择"的记录），玩家更读得懂，且不再命中
`tests/evals/player-copy.test.js:14-18` 的禁用词表（表里有「分支」）。

**改钉**（`tests/roco-review-body-fallback.test.js` ③，按改钉规矩：旧断言逐字留档 + 理由 + 两向变异）：

```js
//   旧断言原文（**逐字留档，别删**）：
//     assert.match(text, /缺当时的分支记录/, '要如实点名"缺当时的分支记录"');
//   为什么改：`tests/evals/player-copy.test.js:14-18` 的**玩家禁用词表**里有「分支」……
assert.match(text, /缺当时的候选记录/, '要如实点名"缺当时的候选记录"');
```
反证那一句（有 decision 时不许再说缺）同步改成 `/缺当时的候选记录/`。**意图一个字没变**：缺口必须如实点名。

---

## 4 · 守卫判据（7 条）

**文件**：`tests/roco-player-number-precision.test.js`（新增；文件名保持不变，避免与 task-27 的登记错位）

| # | 用例 | 量的可见面 | 改前 | 改后 |
|---|---|---|---|---|
| ① | 真对局的整局复盘：可见面不许出现 ≥3 位小数 / 裸 JS 值 | `reviewMatch({lastMatch})` 的 `text + brief + evidence[] + choices[]`，**7 个真种子**（真引擎跑完整局） | **红（7/7）** | 绿 |
| ② | 关键回合那一句的评分差（D-31 正主 + H3 整数口径） | 同一可见面 + `gap=6523.247662596753` / `gap=930` / `gap=null` 三个夹具；断言渲染成 `6523.2` / `930`（**不是 `930.0`**）/ `未登记` | **红** | 绿 |
| ③ | 军师那一侧（同一类内部评分） | `strategist({...})` 的 `text + evidence[] + knowledge[]` | 绿 | 绿 |
| ④ | 六宠局末复盘（另一条入口） | `rocoMatchReview(...)` 的 `review.text + review.evidence[]` | 绿 | 绿 |
| ⑤ | 局内建议（高压反例那一局） | `battleAdvice({battle, plan:null})` 的 `headline/risk/why/text` | 绿 | 绿 |
| ⑥ | 陪练的一句人话 | `companion({mode:'camp'}, freshMemory(), 四句)` 的 `text` | 绿 | 绿 |
| ⑦ | **技能讲解（H1）** | `skillLesson` 对 `guard/focus/moss/clearwind`（无威力）+ `ember`（有威力正对照）的 `text + evidence[]`；无威力不许出现「不防御 X」、有威力仍给两个整数 | **红（4/4 命中 null）** | 绿 |

**白名单机制**：`ALLOW`（`{surface, test, reason}`）**当前为空** —— 玩家可见面里没有任何一处需要
≥3 位小数或裸 JS 值。需要高精度的**非玩家可见**字段根本不进 `scan()` 入参；将来确有玩家可见处需要，
必须往 `ALLOW` 加一行并写理由。

**扫描口径**：`PRECISE = /\d+\.\d{3,}/`（内部精度）· `DIRTY = /\bnull\b|\bundefined\b|\bNaN\b/`（裸 JS 值）；
命中只记前后各 24 字，便于人工核对。

---

## 5 · 读数（命令 + 退出码 + 原文）

| # | 命令 | 退出码 | 原文 |
|---|---|---|---|
| 1 | `node --test --test-concurrency=1 tests/roco-player-number-precision.test.js`（**改前**） | **1** | `tests 4 / pass 2 / fail 2`；7/7 真种子命中清单见 §0.1；② 命中 `6523.247662596753` |
| 2 | 同上（**改后**，7 条） | **0** | `tests 7 / pass 7 / fail 0 / skipped 0` |
| 3 | `node reports/roco/product-execution/06/probe-06.4-h1-skill-lesson.mjs`（**改前**） | 0 | `guard/focus/moss/clearwind` 四行 `evidence_2` 均为 `…（不防御 null／防御 null）…`，`dirty: true`；`ember/crush` `dirty: false` |
| 4 | 同上（**改后**） | 0 | 四行均为 `它不造成伤害：这一手没有威力，不按伤害面板计算，也不预测对手这一回合做什么。`，`dirty: false`；`ember` `不防御 27／防御 10` 逐字不变 |
| 5 | `node --test --test-concurrency=1 tests/evals/player-copy.test.js tests/roco-review-body-fallback.test.js`（**改后**） | **0** | `tests 6 / pass 6 / fail 0`（**改前**：`player-copy` 单跑 `tests 2 / pass 1 / fail 1`，红在 `teacher.js:329/342/350` 的「分支」） |
| 6 | `node --test --test-concurrency=1 tests/roco-plain-speak.test.js` | **0** | `tests 12 / pass 12 / fail 0`（棘轮只许降：teacher.js 仍在欠账表外 ⇒ 0，未升） |
| 7 | **变异 A**（临时副本：评分差回原始内插） | **1** | `tests 7 / pass 5 / fail 2` —— 红 ① ② |
| 8 | **变异 B**（临时副本：`showNumber` 整数分支退回裸 `toFixed(1)`） | **1** | `tests 7 / pass 5 / fail 2` —— 红 ②（`930.0`）⑦（整数伤害写成 `27.0`） |
| 9 | **变异 C**（临时副本：H1 回无条件拼伤害面板） | **1** | `tests 7 / pass 6 / fail 1` —— **只红 ⑦** |
| 10 | **变异 D**（临时副本：候选记录 → 分支记录） | **1** | `tests 6 / pass 4 / fail 2` —— 红 `player-copy` 的禁用词用例 + `roco-review-body-fallback` ③（D-2 的两条判据一起红） |
| 11 | 变异副本还原后复跑 | **0** | `tests 7 / pass 7 / fail 0` |
| 12 | 受影响的既有判据（9 文件） | 见 §5.1 | `tests 158 / pass 157 / fail 0 / skipped 1`（1 skip = 需 `ROCO_PYTHON` 的真服务用例） |

> 变异脚本：`E:\roco-scratch\plan06\mutate.py`（A/B/C/D 四个方向）+ `prep-mut2.sh`（`git archive HEAD src package.json` 造副本）；
> 全程**不动工作树**，每个方向跑完立刻还原并复跑确认（#11）。

**改动文件的树读数**：

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/coach/teacher.js` | `M` | 新增 `showNumber()`；D-31 评分差；H1 `damageLine` 分岔；D-2 三处改词 |
| `tests/roco-player-number-precision.test.js` | 新增 | 7 条守卫（登记报 Lead 转 task-27） |
| `tests/roco-review-body-fallback.test.js` | `M` | **只改 ③ 的那一句钉子**（旧断言逐字留档在注释里） |
| `package.json` | `M` —— **不是我改的**（task-27） | 本刀一个字没碰 |

---

## 6 · 覆盖面（照实写：扫了什么、没扫什么）

**已扫（判据里真的跑了）**：营地整局复盘（7 真种子）· 关键回合评分差（浮点/整数/脏值三种）·
军师（含知识卡原文）· 六宠局末复盘 · 局内建议 · 陪练回复 · 技能讲解（无威力 + 有威力正对照）。

**未扫（登记为残留）**：
- **模型生成的回答** —— 不在源码/纯函数范围；要另立运行时探针（Lead 已登记 D31-Q3）。
- `src/client/**` 的页面渲染结果（含 `#hint` 展开区实际 DOM）—— 本轮只覆盖"进页面之前那一层"的字符串来源。
- `roco-experience.js` 的 `rocoDamagePreviewText` / `depth` 的估计值（已用 `toFixed(2)`，但未单独断言）。
- `toolbox.js` 的工具回执（进模型上下文，不进玩家视野）。

---

## 7 · 后续（不在本刀）

- `decisions[]` 落地时，`grade.evidence[].text` 也必须过这条守卫（06.2c 判据里带上 `DIRTY`）。
- **D31-Q1**（四位数仍像分数）：Lead 已裁决放进 **06.4 改文案**那一步（换定性描述），本刀 `showNumber()` 守门够用。
- 判据登记：`tests/roco-player-number-precision.test.js` 已报 Lead 转 task-27（与 `roco-plan-projection.test.js` 一起）。

## 附录 · 复跑命令

```sh
# 守卫（7 条）
node --test --test-concurrency=1 tests/roco-player-number-precision.test.js        # 期望 7/7 · exit 0

# D-2 的两条判据（必须同时绿）
node --test --test-concurrency=1 tests/evals/player-copy.test.js tests/roco-review-body-fallback.test.js

# 工程语气棘轮（只许降）
node --test --test-concurrency=1 tests/roco-plain-speak.test.js                    # 期望 12/12 · exit 0

# H1 渲染原句（改前/改后同一个探针）
node reports/roco/product-execution/06/probe-06.4-h1-skill-lesson.mjs

# 两向变异（临时副本，不动工作树）
bash /mnt/e/roco-scratch/plan06/prep-mut2.sh
# 在 E:\roco-scratch\plan06\mut2 里：
#   python3 /mnt/e/roco-scratch/plan06/mutate.py <teacher.js> A|B|C|D   → 各自必红的方向见 §5
```
