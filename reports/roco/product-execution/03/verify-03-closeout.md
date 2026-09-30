# 03 收口独立验收（harness-verifier）：`2e241d0` · **合格**（03 分计划级通过条件总账 3/3 满足）

**冻结件 sha256（我亲自核过，与 Lead 声称逐一吻合）**

| 文件 | sha256 | 字节 |
|---|---|---|
| `src/coach/opponent-belief.mjs` | `ee12d3a08a7a2bf6…` | 228862 |
| `tests/roco-opponent-belief.test.js` | `19bb8492735b2e6a…` | 130783 |
| `reports/roco/rc604/opponent-belief.json` | `cbcbab97b843d6a1…` | 246658 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `ebec55f34e87d4b7…` | 30180 |

**方式**：`git archive 2e241d0` → `E:\roco-scratch\verify-03-closeout`（3472 文件）；改坏版只在副本内做，
每轮 `restore` 后复核三文件 sha256（收尾 `ee12d3a0…` / `19bb8492…` / `cbcbab97…` 与冻结件一致）。

---

## §0 判定

| 块 | 判定 | 一句话依据 |
|---|---|---|
| 1 · 03.5 预算与威胁 | **合格** | `truncation` 11 字段齐；重大威胁逐条点名；`observed_first` 成立（limit=2 时 6/6 全留 + `limit_exceeded_by_observed=true`）；limit 8→30 两组读数符合声明；**关掉威胁优先 ⇒ 必红** |
| 2 · F-03-3（我上次抓的） | **合格** | 相容 7 情景 ⇒ `contradictions=[]`（无假矛盾）；放宽排除外层 ⇒ `exit=1` · 红在 `03.3-E2` |
| 3 · F-03-4（我上次抓的） | **合格** | fail-closed ⇒ `available=false` + `degraded=true` + 每条 reason 非空非空白；清空 reasons ⇒ `exit=1` · 红在 `F-03-4` |
| 4 · 降级分支全表抽样 | **合格** | 抽 4 条做变异：`applied:false` 缺 reason / `!read.ok` 假装可用 / 降级仍标 complete / 降级清空原因 —— **四条全红** |
| 5 · 37 条 + 报告重生成 | **合格** | `exit=0 · tests 37 · pass 37 · fail 0`；重生成 sha16 `CBCBAB97B843D6A1` = 冻结件 |
| **03-PLAN ①** 来源可追溯、观察/推测不混用 | **满足** | 见 §4① |
| **03-PLAN ②** 隐藏真值变化不改公开史输出 | **满足** | 见 §4②（候选与情景产出**逐字段相同**） |
| **03-PLAN ③** 降级明确、不生成伪精确概率 | **满足** | 见 §4③ |

---

## §1 03.5 预算与截断（真 view）

```
limit=8 : kept=8  dropped=614  dropped_by_threat={"high":264,"none":350}  threats_kept=4   limit_exceeded_by_observed=false
limit=30: kept=30 dropped=592  dropped_by_threat={"high":242,"none":350}  threats_kept=26  limit_exceeded_by_observed=false
limit=2 : kept=6  dropped=616  dropped_by_threat={"high":266,"none":350}  threats_kept=2   limit_exceeded_by_observed=true
truncation 必备 11 字段在每个 limit 下都齐（missing=[]）
被裁重大威胁逐条点名，例：{"candidate_id":"cand:pet_000125","species_id":"pet_000125","threat_level":4,
                            "why":"被预算裁掉，但它是**重大威胁**（…克制…）","evidence_ids":[…]}
observed_first：limit=2 时 observed_kept=6/6 ⇒ **已见永不裁剪**，且 limit_exceeded_by_observed=true
两组读数：放宽 limit ⇒ 保留更多（8→30）、裁掉更少（614→592） ✓
```

**独立复现「加宽后有牙」**（Lead 点名）：
```
变异：关掉 inferred 排序里的「重大威胁优先」
⇒ exit=1 · tests 37 · pass 35 / fail 2
   失败用例：03.5-E7：上限带完整截断信息，缩减规则可解释，重大威胁点名
             RC-604 报告：机器可读产物与生成逻辑逐字节一致
```
**关于「没牙那次」**：它的 `03.5-budget-and-threats.md` §3 自己写着「第一次只用 limit:8 的夹具，变异**没被抓到**
（自然序恰好也是威胁序）… 加宽到 limit:30 后断言才真的有牙。这条过程如实留档」⇒ **没有把没牙那次当成功**，
且我这次的变异（在 limit=30 夹具下）**确实被抓到** ⇒ 声明成立。

## §2 F-03-3（多解假矛盾）

```
相容 7 情景（exhaustive:false）: contradictions=[] · multi_solution=["cand:pet_000007"]
  ⇒ 不出现 DAMAGE_UNEXPLAINED_BY_SCENARIOS，也没有任何 UNEXPLAINED/INCOMPATIBLE 类条目 ✓
变异（放宽排除外层 matches.length===0 → >=0）⇒ exit=1 · 36 pass / 1 fail
  失败用例：03.3-E2（真引擎读数 · 反例①）：同一公开伤害由两种个体配置都能解释 ⇒ 两者都保留
```

## §3 F-03-4（fail-closed 必给原因）

```
注入 moves（隐藏字段）⇒ buildScenarioOutlook: available=false · degraded=true
  degrade_reasons = ["公开事实的**输入越界**：注入的事实里出现了隐藏字段（对手配招 / 后备身份 / 道具 / 性…）"]
  每条非空非空白 ✓
变异（清空该分支 degrade_reasons）⇒ exit=1 · 36/1 · 红在
  F-03-4：候选集合不可用（fail-closed 输入）也必须逐条给出降级原因
```

## §4 03-PLAN 通过条件总账（分计划级，之前没人做过）

### ① 候选来源可追溯、已观察与推测不混用 —— **满足**
```
basis 取值 = ["observed","inferred"]（只有这两类）
候选 30 条：每条都有 evidence[] 或 sources[] 可追溯
inferred 24 条：每条都有非空 unknowns（不许冒充已知）
observed  6 条：每条带 observed.reveals 来源（field_on_screen / opening_preview）
```

### ② 隐藏真值变化不改变「相同公开史」的候选 —— **满足**（我自己构造的对照）
```
做法：拿真 view，把**隐藏面**全部改坏——
  self.field.panel={atk:999,spa:999} / talent='HIDDEN_TALENT' / nature='HIDDEN_NATURE' / individual_values={atk:31}
  self.team[*] 每行加 panel/talent/nature
  opponent.bench[*] 每行加 panel/talent/nature/moves=['skill_999999']，并加 opponent.hidden_note
结果：buildOpponentCandidates(...,budget:{limit:30}) 输出 **JSON 逐字段相同 = true**
      buildScenarioOutlook(...) 输出 **逐字段相同 = true**
```
**新公开证据能合理更新**（03.3 已验，此处回归）：S2 真 view 上矛盾 `OBSERVED_NOT_IN_FILTERED_POOL` 仍如实报出；
7 情景相容 ⇒ `multi_solution` 保留全部。

### ③ 候选为空或矛盾时明确降级、不生成伪精确概率 —— **满足**
```
declarations.is_probability = false；四种表达 uniform/conditioned/scenario_set/range
  各自 is_probability:false + why（67/84/77/82 字）
best_scenario = null（恒不给最优）· 产出里无 win_rate/probability/odds 类字段
降级路径（空宇宙 / 无候选 / 矛盾 / fail-closed / 预算截断）都带 degrade_reasons，且情景 complete:false
```

## §5 降级分支全表抽样（抽 4 条，各做一次变异）

| 抽的判据 | 变异 | 结果 | 红的用例 |
|---|---|---|---|
| `rule_ledger[].applied:false` 必须带非空 reason | 让 turn_order 规则 not_applied 却不带 reason | `exit=1 · 36/1` | `03.3-E3：…先手速度只在同量纲时排除，且排除都带证据 ID` |
| `!read.ok` 早返回（输入越界） | 把该分支改成 `available:true` | `exit=1 · 35/2` | `F-03-4：候选集合不可用…` + 报告一致性 |
| 降级 ⇒ 情景 `complete:false` | 降级仍保留 complete:true | `exit=1 · 32/5` | `03.4-E4 / E5 / M / E6` |
| 降级必须给原因 | 清空该分支 `degrade_reasons` | `exit=1 · 36/1` | `F-03-4：…` |

⇒ 它声称的「已无未断言的可达降级分支」在我抽的这 4 条上**成立**。

## §6 我自己犯的一次无效变异（如实登记）

第一次测 `!read.ok` 分支时，我只往那段返回对象里**加了一个没人看的键**（`available_override: true`），
`available` 仍是 `false` ⇒ 套件 37/37 全绿。**那是我变异无效（no-op），不是缺口**；
改成真正把 `available` 置 `true` 后立刻红（见 §5 第 2 行）。

## §7 03 整体结论

**03（对手候选与证据更新）分计划级验收：通过。**
- 五批冻结件（`2e30a4f` 系 → `2253c2e` → `b744739` → `0d96ce3` → `a821fe2` → `2e241d0`）我逐批独立复验，
  累计**抓到 3 条真缺口**并全部在后续冻结件里闭合：
  ① 条件③降级无断言（我变异删 `contradictions.push` 仍全绿 → F-03-2 修）；
  ② 多解时「假矛盾」无断言（我变异放宽外层仍全绿 → F-03-3 修）；
  ③ 「候选集合不可用」降级分支无断言（我变异清空 reasons 仍全绿 → F-03-4 修）。
- 本轮收口 6 条变异 **5 红 1 无效（我方 no-op）**，无存活缺口。
- 03-PLAN 三条通过条件（来源可追溯 / 隐藏真值不改公开史输出 / 降级明确且不装概率）**逐条满足**。
- 仍**未**证明的事：用户自有长期部署的行为（03 全链在冻结副本与真引擎上验，与常驻实例的 02 验收是两件事）。

## §8 复跑

```powershell
git archive 2e241d0 | tar -x -C <副本>
node scripts/roco/verify-03-closeout.mjs <副本>     # 03.5 + F-03-3 + F-03-4 + 03-PLAN 三条
node scripts/roco/verify-03.4-semantics.mjs <副本>  # 语义/降级/矛盾（回归）
# 变异：E:\roco-scratch\vfy-close-mutate.sh {threatsort|f033|f034|ledgerreason|readnotok2|completetrue|restore}
```
