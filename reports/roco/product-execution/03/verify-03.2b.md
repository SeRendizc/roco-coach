# 独立复核：03.2b 冻结版 `b744739`（F-03-1 + F-03-2）（harness-verifier）

**冻结件 sha256（我亲自核过，与 Lead 声称逐一吻合）**

| 文件 | sha256 | 字节 |
|---|---|---|
| `src/coach/opponent-belief.mjs` | `9fbfb083ac3f65b8d2147276…` | 180508 |
| `tests/roco-opponent-belief.test.js` | `386538327aedb7c2d42b2367…` | 96009 |
| `reports/roco/rc604/opponent-belief.json` | `063816f40fea6c17526aecf3…` | 177014 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `e3ae43e3457fd731b86078ad…` | 26160 |

**方式**：`git archive b744739` → `E:\roco-scratch\verify-03.2b`（3440 文件），**全部读数在该不可变副本上**；
改坏版只在副本内做，每次做完 `restore` 并复核 sha256。
F-03-1 的两向用**内存改写源码文本**（`auditOpponentBelief(..., {scope:'online', source})`）⇒ **不碰盘上文件**。

---

## §0 判定：**合格**（4 项全过）

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | F-03-1 覆盖读数 + 两向 | **合格** | `online_lines=2079` · `scanned=14/14` · `missing=[]` · `hits=[]`；注入 ⇒ 红且**不缩水**；压空 ⇒ `ONLINE_COVERAGE_INCOMPLETE` 红 |
| 2 | F-03-2 两向（条件③补断言） | **合格** | 注释掉 push ⇒ `exit=1 · 24 pass / 2 fail`（红的正是新断言 + 报告一致性）；还原 ⇒ `26/26` + sha 复原 |
| 3 | 我**自己**挑的新断言变异 | **合格** | 旧口径回退 ⇒ 新覆盖断言红；`individual_range.known=true` ⇒ 反例①断言红 |
| 4 | 「只打印不断言」24 处清单抽样 | **合格（自称属实）** | 抽 3 处：2 处自报缺口**真是缺口**、1 处自报已覆盖**真被断言** |

---

## §1 F-03-1（在线段判据真覆盖在线函数）

### ① 覆盖读数（我自己算的两套口径 + 他们的函数）
```
他们的 onlineSectionCoverage(真实源码): online_lines=2079 · online_chars=83135
                                        scanned=14/14 · missing=[] · hits=[] · 审计 ok=true
我自己按「标记定义行之后 → 离线标记之前」算:  lines=2278 · hits=[] · 覆盖 14/14 · 缺 []
我自己按**旧口径**（标记第一次出现之前）算:  lines=399  · 覆盖 **5/14**
  旧口径的 hits=[step_joint, plan_actions, child_process, spawn, roco-client, RocoClient]
  ← 这些是**判据自己的模式串声明**，不是在线函数体：正是「声明被当成在线代码」的老毛病
```
⇒ 与它声称的 `2079 / 14-14 / hits[]` 一致；旧口径确实是假覆盖（且命中的是声明本身）。

### ② 两向 red-proof（内存改写，出处 `verify-f031-twoway.mjs`）
```
控件（未改写）                codes=[]                     ok=true
A 在 readPublicFacts() 体首行插 const engineTick = step_joint(0);
    hits=["ONLINE_ENGINE_CALL:step_joint"]   online_lines=2080（基线 2079 ⇒ **未缩水**）
    审计 codes=["ONLINE_ENGINE_CALL"]（detail 含实际源码）
    旧算法对照：旧口径扫描区间终点 offset=19970，注入行 offset=28816
      ⇒ **旧算法扫不到这一行** = true     ← 证明修的是**覆盖**，不是把判据调松
B 把在线段压成 1 行
    online_lines=2 · scanned=0 · missing=14
    审计 codes=["ONLINE_COVERAGE_INCOMPLETE"]   ← 「扫了个空」不再能显示干净
```

### ③ 口径变化与「既有断言未改钉」
- `onlineSectionCoverage` 只认 `(function|const|let|class) <name>` 形式的**定义**，
  且入参 `section` 来自 `onlineSectionOf()`（定义行之后）⇒ 判据/白名单/词表那些**声明**不参与在线扫描
  （旁证：旧口径的 hits 全是声明里的模式串，新口径 `hits=[]`）。
- **既有断言未改钉**：我的「旧口径回退」变异让 **`RC-604 结构：在线段没有引擎 / 子进程调用…`** 与
  新的 `F-03-1：在线段判据必须真的覆盖在线函数…` **同时**变红（§2），说明老断言仍活着、只是**加了**覆盖断言。

## §2 变异矩阵（全部在副本内做，做完还原）

| 变异 | 套件读数 | 红的是哪些用例 | 说明 |
|---|---|---|---|
| 控件（未变异） | `exit=0 · 26/26` | — | 基线 |
| **F-03-2**：删掉 `contradictions.push({code:'OBSERVED_NOT_IN_FILTERED_POOL'})` | `exit=1 · 26 tests · 24 pass / 2 fail` | `03.2-S2（真 view · 无预览）…`、`RC-604 报告：…逐字节一致` | **我上一轮报的缺口已闭**：行为没了 ⇒ 判据红 |
| **我的变异A**：`onlineSectionOf` 退回旧口径 | `exit=1 · 23 pass / 3 fail` | `F-03-1：在线段判据必须真的覆盖在线函数…`、`RC-604 结构…`、报告一致性 | 新覆盖断言 `missing===0` **有牙** |
| **我的变异B**：`individual_range.known` → `true` | `exit=1 · 23 pass / 3 fail` | `03.2-反例①（协议前提）…`、`03.2-S1…`、报告一致性 | 反例①断言**有牙** |
| 还原后收尾 | `exit=0 · 26/26` | — | impl `9fbfb083ac3f65b8` / test `386538327aedb7c2` **与冻结件一致** |

⇒ 我不只复跑了它给的 red-proof，还**自己挑了 2 条新断言**（覆盖断言、反例①）做变异，都红。

## §3 「只打印不断言」清单抽样（抽 3 处，自己看代码）

| 抽样 | 它的自报 | 我看到的原文 | 判定 |
|---|---|---|---|
| **#2 判据③ 白名单**（L334–343） | 「缺口」 | 注释写「公开事实字段清单里的**每一项**都必须出现在上面测试用到的字段里」，但断言只有 `PUBLIC_FACT_FIELDS[group].length > 0` 与「隐藏清单覆盖 moves」⇒ **注释承诺 > 断言实际** | **自报属实**：真缺口 |
| **#10 S1 预算**（L1011） | 「部分缺口」 | `raw('S1 候选预算', built.budget)` 之后，本用例只断言 `available` 与 `budget.observed_kept`；`truncated/dropped_count/pool_summary` 的断言在**手工栏**那条 | **自报属实**：本用例内确实没钉 |
| **#12 S2 预算与首条来源**（L1040–1047） | 「已覆盖」 | `raw` 打印 `first_via`，紧随其后 `assert.ok(... revealed_via === 'field_on_screen')`；预算由 `observed_kept` 钉住 | **自报属实**：确被断言 |

⇒ 这份清单**不是自夸**：两处缺口它自己点了名，一处「已覆盖」经我核对成立。

## §4 诚实边界

- 我只抽样 3 处（其余 21 处未逐条核）；抽样偏向「raw 与断言相隔较远」的两处，结论不推广到全部。
- F-03-1 的两向是**文本级**（内存 source）验证；真文件级的等价性由套件里那两条用例覆盖（我已用变异证明它们有牙）。
- 副本内所有变异已还原，收尾三文件 sha256 与冻结件一致；未改工作树任何文件。

## §5 复跑

```powershell
# 建议先整仓归档再跑（避免工作树漂移）
git archive b744739 | tar -x -C <副本>
node scripts/roco/verify-f031-coverage.mjs <副本>     # 覆盖两套口径
node scripts/roco/verify-f031-twoway.mjs  <副本>      # 控件 + 注入 + 压空
# 变异：E:\roco-scratch\vfy-032b-mutate.sh {disablepush|oldcoverage|knowntrue|restore}
```
