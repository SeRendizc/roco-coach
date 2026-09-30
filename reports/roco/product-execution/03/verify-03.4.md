# 独立复核：03.4 冻结版 `a821fe2`（harness-verifier）· **合格**（附 1 条覆盖缺口登记）

**冻结件 sha256（我亲自核过，与 Lead 声称逐一吻合）**

| 文件 | sha256 | 字节 |
|---|---|---|
| `src/coach/opponent-belief.mjs` | `013515cad96a73bf…` | 222541 |
| `tests/roco-opponent-belief.test.js` | `8b188badd940deb6…` | 121440 |
| `reports/roco/rc604/opponent-belief.json` | `d1b83b883d1a0738…` | 196354 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `1e6b0cb509d9a6ce…` | 29213 |

**方式**：`git archive a821fe2` → `E:\roco-scratch\verify-03.4`（3463 文件）；改坏版只在副本内做，
每轮 `restore` 后复核 sha（收尾 `013515cad96a73bf` / `8b188badd940deb6` / `d1b83b883d1a0738` 与冻结件一致）。

---

## §0 判定：**合格**（5 项全过 + 1 条缺口登记）

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | 三种/四种表达 `is_probability:false` + why；`best_scenario` 恒 null + reason；**我造的「给最优情景」坏版必红** | **合格** | 四种表达 why 长度 67/84/77/82；`best_scenario=null` + reason；坏版 ⇒ `exit=1 · 29/5` |
| 2 | 三条降级 + 矛盾时每情景 `complete:false`；**我造的「降级却标完整」必红** | **合格** | 见 §2；坏版 ⇒ `exit=1 · 29/5`；**另发现「降级却清空原因」的那条分支无断言**（§4） |
| 3 | 反例② 回归 | **合格** | 合法产出不误判（`ok=true`）；重复技能 / 池外技能 / 抹掉 legality **三版全红** |
| 4 | 我自己挑的实现级变异 | **合格（2 红 1 存活）** | `bestscenario` 红、`completetrue` 红、`noreason` **存活** ⇒ 见 §4 |
| 5 | 34 条用例 + 报告重生成逐字节 | **合格** | `exit=0 · tests 34 · pass 34 · fail 0`；重生成 sha16 `D1B83B883D1A0738` = 冻结件 |

---

## §1 语义声明（真 view）

```
declarations.is_probability = false
 - uniform      expression=uniform_weight      is_probability=false  why=67 字
 - conditioned  expression=conditioned_weight  is_probability=false  why=84 字
 - scenario_set expression=scenario_set        is_probability=false  why=77 字
 - range        expression=range               is_probability=false  why=82 字
best_scenario = null · best_scenario_reason = 「本模块**不给最优情景**：没有频次数据时「哪个情景更好」没有依据…」
scenarios n = 3 · complete = [false,false,false]
ranges = {pool:{622/622, unit:「候选池占比（入选候选数 / 候选宇宙大小；是计数比，不是把握度）」},
          weight:{min:0.001162790698, max:…}}
```
**我的坏版**（把主返回的 `best_scenario: null` 改成「给第一个情景」）⇒ `exit=1 · 29 pass / 5 fail`
（红：`03.4-E4`、`03.4-E5`、`03.4-M`、`03.4-E6`）✓

## §2 三条降级 + 矛盾

| 场景 | 我的输入 | 读数 |
|---|---|---|
| (a) 空宇宙 | `{catalog:null, view}` | `available=true · degraded=true` · `degrade_reasons` 3 条（含「候选宇宙为空（没有注入 catalog）」）· `best_scenario=null` · `scenarios complete=[false]` |
| (b) 一条候选都没有 | `{catalog:null, skillPool}` | `available=false` · `degrade_reasons=["候选集合为空（公开事实一条候选都推不出来）"]` · `best=null` · `ranges=null` |
| (c) 矛盾证据 | S2 无预览真 view | `contradictions=["OBSERVED_NOT_IN_FILTERED_POOL"]` · `scenarios complete=[false]` · `degrade_reasons=["1 条证据矛盾未消解", …]` · `best_scenario=null` |
| (d) 可达性 | 故意注入隐藏字段（配招） | `available=false` · reason=「公开事实的**输入越界**…」 ⇒ **那条早返回分支确实可达**（不是死码） |

**我的坏版**（降级但仍把情景标 `complete:true`）⇒ `exit=1 · 29 pass / 5 fail` ✓（审计码 `SCENARIO_RANKS_A_SCENARIO`/`…COMPLETE` 那条链有牙）

## §3 反例② 回归（我自己复算）

```
CTL(报告里的合法候选)  ILLEGAL_LOADOUT_IN_CANDIDATES = false · ok = true     ← 新逻辑没把合法产出弄红
B1 kept 里塞重复技能      = true（"kept 里有重复技能 / 与独立复算不一致"）
B2 kept 里放池外技能      = true（"不在可学池里 / ok 与独立复算不一致 / 混进了 kept"）
B3 抹掉 skills.legality   = true（"没有 skills.legality ⇒ 无法证明"）
⇒ LEGALITY REDPROOF PASS
```

## §4 **覆盖缺口登记**：降级「清空原因」那条分支没有断言

```
变异：把「候选集合不可用」早返回分支（模块 ≈2401 行）的
      degrade_reasons: [candidatesBuilt.unknown_reason?.slice(0,48) ?? '候选集合不可用']
      改成 degrade_reasons: []
⇒ 套件 exit=0 · 34 pass / 0 fail   ← **存活**
而该分支 **可达**（§2 (d)：注入隐藏字段即走这里，正常产出 reason）
```
⇒ 现状是：**「降级必须逐条给原因」这条纪律，在「候选集合不可用」这条路径上没有断言守护** ——
把原因清空，34/34 依旧全绿。（对照：同为降级的 (a)/(c) 路径有断言，见 §2。）
**建议**（供 Lead 派单，我不改）：补一条用例，用 fail-closed 输入（如注入 `moves`）走
`buildScenarioOutlook`，断言 `available===false` + `degrade_reasons.length > 0` + 每条非空。

## §5 诚实边界

- 我挑的 3 条变异里 2 红 1 存活；它自报的「5 条红」我**没有**逐条复跑（只做了自己的 3 条）。
- 报告里其它字段（`evidence[]`、`protocol`、`measured_control`）本次未逐项复核，只覆盖本报告点名的判据。
- 副本内变异全部已还原，收尾三文件 sha256 与冻结件一致；未改工作树任何文件。

## §6 复跑

```powershell
git archive a821fe2 | tar -x -C <副本>
node scripts/roco/verify-03.4-semantics.mjs <副本>    # 语义 / 降级 / 矛盾 / 可达性
node scripts/roco/verify-03.2-legality.mjs <副本>     # 反例② 回归
# 变异：E:\roco-scratch\vfy-034-mutate.sh {bestscenario|noreason|completetrue|restore}
```
