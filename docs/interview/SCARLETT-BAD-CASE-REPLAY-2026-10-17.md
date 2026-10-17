# 官方「斯嘉丽」公开 Bad Case × 小芽三层口径对账（2026-10-17）

> **这份文件解决什么问题**：二面部门就是做「斯嘉丽」的团队。他们在 2026-08-15 的公开采访里
> 亲口讲了两个真实 Bad Case（电系打翠顶夫人、虫队打火神）。这两题是**他们最可能拿来试探候选人
> 懂不懂游戏规则**的地方，也恰好是对本仓「规则真值由程序算」这一核心主张的**外部对账题**。
> 本文只写能复现的事实：每条都附命令、文件:行、出处；做不到的写「未验证」。
>
> 复现器：`node scripts/interview/replay-scarlett-bad-cases.mjs`（只读，今天实测输出见 §2）。
> 修复分支：`fix/typechart-official-3x` @ `f9ac7e06`（**未合入主干**；patch 已导出到
> `docs/interview/patches/typechart-official-3x.patch`，见 §5）。

---

## 1. 官方公开的事实（一手/二手分开）

| 事实 | 原文/来源 | 可信度 |
|---|---|---|
| 电系打翠顶夫人（翼系+水系）= **三倍**；AI 分不清「克制」与「强力克制」 | 游戏葡萄《腾讯财报认证的2026第一国产新游，把AI用得太「刁钻」了》，2026-08-15，36氪转载：<https://www.36kr.com/p/3939411707919744> | 【媒体采访·官方项目组受访】 |
| 虫队打火神：AI 让花衣蝶用灼烧逼退火神，但**花衣蝶被火神三倍克制、火神也不吃灼烧** | 同上 | 同上 |
| 双属性均弱 = **3×（强力克制，非乘算的 4×）** | 上游社区模拟器 `data/roco/raw/extracted/rocom-data/sim/damage_calc.py:92-107`（注释逐字） | 【第三方实现·与本仓快照一致】 |
| 灼烧：「回合结束时，造成2%生命的火系伤害，并衰减一半层数。（**火系精灵免疫此效果**）」 | `data/roco/normalized/roco-world-s4-2026-09-10/terms.json:19`（术语 1002） | 【本仓冻结术语表】 |
| 双属性组合的倍率在游戏数据里**预先算好并封顶在 3** | `data/roco/normalized/roco-world-s4-2026-09-10/types.json`（18 单属性 + 102 条双属性键；`翼系|水系` 受电系 = 3） | 【上游 `Types.lua` 机械转录】 |

**一句话**：官方口径、游戏数据、第三方模拟器三处**一致指向 3× 与「火系免疫灼烧」**；
只有本仓 2026-09-25 的一次人类裁决（改用社区源相乘 4×）与之相反。

---

## 2. 今天实测：同一格，三个层给出三个答案

运行 `node scripts/interview/replay-scarlett-bad-cases.mjs`（2026-10-17 实测）：

| 官方 Bad Case | 官方 | 引擎（真打结算） | RAG 语料（讲课/检索） | 客户端（页面承伤提示） | 判定 |
|---|---|---|---|---|---|
| 电系打翠顶夫人（翼+水） | ×3 | **×4** | **×4** | **×3** | 不一致 |
| 火系打花衣蝶（虫+草） | ×3 | **×4** | **×4** | **×3** | 不一致 |

来源：
- 引擎：`roco/src/roco_env/data.py:188` `TypeChart.multiplier()` —— 双属性走 `fallback_multiplier()`（两系相乘），见 `:157-164` 的 2026-09-25 裁决注释。
- RAG 语料：`src/coach/rag-index.js:506` `typeChartBody()` —— 双属性正文按两条单属性相乘写 ×4，见 `:497-505` 的裁决注释；`tests/roco-rag-typechart.test.js` 的 `FORTY_ONE_CELLS` 把它钉住。
- 客户端：`src/client/type-affinity.js:68` `defenceMultiplier()` —— **逐字读 `types.json`**，所以给 3；`tests/roco-client-type-affinity.test.js` 逐格对账真值。
- 官方采访与上游注释：见 §1。

**这不是文案差异，是同一个系统里「结算层 / 教学层 / 展示层」三套口径。**
对面试的杀伤力在于：面试官只需要问一句「电系打翠顶夫人几倍」，就能看到候选人自己的系统给出
三个答案；而这道题正是他们公开讲过的、AI 曾经答错的那道题。

### 2.5 第三处（今天实测）：grounded 守卫拦不住「等级词」错误 —— 恰好是官方 Bad Case 的形状

官方采访里那个错误的本质是「**有依据，但事实错**」：AI 从资料里读到了电系/翼/水的相性，却把
「克制」与「强力克制」写错。今天直接调用本仓守卫（`src/coach/runtime.js:4770` `checkGroundedAnswer`）实测：

```text
node -e "...checkGroundedAnswer({text:'造成 999 伤害', evidence:[...], toolTrace:[]})"
⇒ {valid:false, reasons:['unsupported-number:999']}          # 有明显数字错，拦得住

text='电系打翠顶夫人是 2 倍伤害'   ⇒ {valid:true, reasons:[]}  # 与证据 ×3 矛盾，放行
text='电系打翠顶夫人是两倍伤害'   ⇒ {valid:true, reasons:[]}  # 中文「两倍」也放行
text='电系强力克制翠顶夫人'       ⇒ {valid:true, reasons:[]}  # 没有数字，更放行
text='电系打翠顶夫人是 3 倍伤害'   ⇒ {valid:true, reasons:[]}  # 正确说法也放行
```

**根因有三层**（读码核对，不是猜）：
1. 校验只认「数字是否在事实集/规则常量里」。`2`、`3` 是规则常量（`ruleConstantNumbers()` 的常用小整数），
   所以「2 倍」和「3 倍」都过——**数值有出处 ≠ 语义正确**。
2. 中文数字正则只翻「紧挨量词（个/只/次/回合/层…）」的数字（`runtime.js:4864`），**量词表里没有「倍」**。
3. 「强力克制」这类**等级词本身没有数字**，守卫完全看不见。

守卫自己的 `scope` 字段也写明：`'Narrow numeric/citation/certainty guard; not a proof of all natural
language correctness'`。这说明项目是**知道**这个边界的——但官方 Bad Case 恰好落在这个盲区，
面试里必须主动讲清，而不是被问出来。

**可讲的下一步（也是最好的"如果我进组"答案）**：把「属性等级词」做成一条独立判据——
从 `types.json` 取该格的倍率，规定 3× 只能说「强力克制/三倍」，2× 只能说「克制/两倍」，
两者互串即红；再把这条判据接进 `checkGroundedAnswer` 的证据链（先 red 后 green）。这正是
「把'有依据但事实错'变成可回归的测试」的最小样例。

### 第三类：火神不吃灼烧 —— 引擎只对了一半

- 术语 1002 明写「火系精灵免疫此效果」；`roco/src/roco_env/effects.py:620` 也把
  `immune_element: "火系"` 声明进了 `END_OF_TURN_STATUS`。
- 但真正**消费**这个字段的只有天气路径（`roco/src/roco_env/env.py:3691`）；
  技能施加状态的分支（`env.py:2044-2075` `elif eff.kind == "foe_status"`）**没有读免疫字段**。
- 结论：**技能挂上去的灼烧不会免疫**；只有天气挂的会。官方第二个 Bad Case
  （「火神也不吃灼烧」）在本仓会算成「可以烧」。
- 这条同样可复现：`grep -n "immune_element" roco/src/roco_env/env.py` 只有 3691 一处消费点。

---

## 3. 根因：一次被新证据推翻的人类裁决

2026-09-25 的项目裁决原文（逐字保留在 `data.py:157`、`roco/tests/test_type_multiplier_ruling.py:1`）：

> 「属性双属性叠加：快照 3×（现用）vs 两个社区源 4×，差 41 格。**使用社区源**」

当时的证据是「快照 1 票 vs 社区源 2 票」。**今天多出的三份证据全部支持快照 3×**：
1. 官方 2026-08-15 采访：玩家答「三倍」，AI 答错被点名；
2. 上游模拟器 `damage_calc.py` 注释：双弱 = 3x（强力克制，非乘算的 4x）；
3. 游戏数据 `types.json` 本身就是把双属性预先算好并封顶 3 的那份转写。

而本仓客户端层（`type-affinity.js`）从一开始就是**逐字读快照**（3×）——也就是说，
2026-09-25 的裁决让「结算层和教学层」偏离了「展示层和游戏数据」。这不是新功能问题，
是**真源层级放错了**。

---

## 4. 为什么必须在面试前处理（三种处理方式与对应话术）

### 方式 A：面试前合入修复（推荐，工作量已量清）

- 修复分支已提交（从公开 commit `2e62a73b` 拉出，3 个提交：3× 规则、免疫、守卫）；
  patch 文件 `docs/interview/patches/typechart-official-3x.patch` 为第一笔（3× 规则），可用 `git am` 重放。
- 已改两处：`data.py::TypeChart.multiplier()` 双属性改读快照逐字值（双弱 3×）；
  `rag-index.js::typeChartBody()` 双属性正文改逐字照抄（不再写 ×4 与「按两系相乘」）。
- 已验证：`电系×翼|水 = 3`、`火系×虫|草 = 3`；Python 全量套件当前 **6 个失败**（含 3 条旧裁决判据、
  1 条金标逐位一致、1 条派生件新鲜度、1 条 tier 判据），Node 套件影响正在测。
- 剩余工作：把 `test_type_multiplier_ruling.py` / `tests/roco-rag-typechart.test.js` 按「改钉不删」
  改成新裁决（保留 41 格旧账与反证），重建派生件，再走一次全量套件。**预计 2-4 小时**——
  这正是可以讲给面试官听的「我如何安全地改一条规则」。
- 面试话术（可直接用）：
  > 官方采访里那道「电系打翠顶夫人」，我拿自己的仓库对账，发现我们结算层和教学层用的是社区
  > 相乘口径 4×，客户端和游戏数据是 3×。我先把上游模拟器和官方采访作为新证据，把裁决改回 3×，
  > 同时保留了 41 格旧账和一条「改回旧口径必红」的反证。规则改动我不直接改判据让测试变绿，
  > 而是改钉 + 留痕，因为这类改动最怕的就是「测试绿了但数字错了」。

### 方式 B：不合入，但把「发现 + 方案 + 影响面」讲出来（保底，今天就能用）

> 我在对账官方公开 Bad Case 时发现我们自己有一次裁决把双弱倍率从 3× 改成了 4×；
> 新证据（官方采访 + 上游实现）说明 3× 才对。我已经把修复分支和受影响的 6 条判据量出来了，
> 但因为它会动到金标和台账，我按项目纪律没有在面试前偷偷合入，而是把它列为最高优先级。
> 这件事让我更确信：规则真值必须单源，任何一次「按社区口径」的裁决都要能被官方一手证据推翻。

### 方式 C：什么都不做（不推荐）

只要面试官问这道题，候选人要现场解释「为什么你的页面说 3 倍、你的引擎说 4 倍」。
这与项目最核心的卖点（事实由程序算、模型不编）直接冲突。

---

## 5. 修复分支实测记录（2026-10-17）

| 项 | 结果 | 命令/位置 |
|---|---|---|
| 提交 | `81ec0d45` 3× 规则 → `a972f57b` 状态免疫 → `f9ac7e06` 等级词守卫（分支，未合入主干） | `git log --oneline fix/typechart-official-3x` |
| 规则修复验证 | Python 全量仅 1 条 pre-existing 红（tier）；Node 2091/2075/15/1，失败集合与基线**逐条相同** | `npm run test:env`；`npm run test:unit`（日志 /tmp/goal-unit-fix3.log） |
| 官方 Bad Case 判据 | Python `tests.test_scarlett_bad_cases` 6/6；Node `tests/roco-scarlett-tier-grounding` 7/7 | 两文件直接 `run` |
| 状态免疫 | 火/毒/草分别免疫灼烧/中毒/寄生（术语 1001/1002/1008），技能路径 + 每驱散层路径都消费 | `_status_immune`（env.py） |
| 引擎行为 | 双弱 3×（翼+水受电、虫+草受火） | `.work/typechart-3x/roco` 下 `python3` 直接调 `TypeChart.multiplier` |
| RAG 正文 | 改后写 ×3（不再写 ×4） | `rag-index.js::typeChartBody` |
| Python 全量套件 | `failures=6, skipped=2` | `npm run test:env`（worktree） |
| Node 全量套件 | 不可用作判据：worktree 里 `node --test` 的子进程 spawn 大面积 ENOENT（环境问题，主树同期无此现象）；定向 `roco-rag-typechart` 红 3 条（预期） | `npm run test:unit`（worktree，结果作废）；主树：2084 条/15 红 |
| 金标/派生件 | 预期变红：规则改动必须走「改钉 + 重建派生件 + 金标送审」 | `test_turn_order_fail_closed.LegacyBitExactGoldenTest`、`test_regression_set.DiskArtifactIsFreshTest` 等 |

**结论：修复的技术路线成立、影响面可控（Python 侧 6 条），但「改钉」本身是一个需要人类确认的
治理动作**——这正是本项目一直坚持的纪律，不应该由 agent 在面试前夜偷偷改掉。

---

## 6. 面试前 10 分钟要背下的三句话

1. **官方口径**：电系打翠顶夫人（翼+水）是 **3 倍**，游戏里叫「强力克制」；双弱不是两系简单相乘的 4 倍。
2. **我自己的系统**：引擎和 RAG 语料曾经按社区口径算 4 倍，客户端和游戏数据是 3 倍——**三层不一致，
   我先统一真源再改判据**，修复分支和影响面已量清。
3. **方法论**：这类问题不是「改个数字」，而是「谁是规则真源、改动如何留痕、旧断言怎么改钉」；
   我把它当成一次小型的规则治理，而不是一次文案修复。

---

## 7. 参考与证据索引

- 复现器：`scripts/interview/replay-scarlett-bad-cases.mjs`
- 引擎：`roco/src/roco_env/data.py:154-240`（`TypeChart`）；`roco/tests/test_type_multiplier_ruling.py`
- RAG：`src/coach/rag-index.js:480-560`（`typeChartBody`）；`tests/roco-rag-typechart.test.js`
- 客户端：`src/client/type-affinity.js:68`；`tests/roco-client-type-affinity.test.js`
- 状态免疫：`roco/src/roco_env/effects.py:619-621`；`roco/src/roco_env/env.py:2044-2075`（技能施加）、
  `:3691`（天气免疫消费点）；术语 `terms.json:19`（1002）
- 上游证据：`data/roco/raw/extracted/rocom-data/sim/damage_calc.py:92-107`
- 官方采访：<https://www.36kr.com/p/3939411707919744>
