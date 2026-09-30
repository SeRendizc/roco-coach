# 独立复验：04.3 冻结版 `3bb4356`（harness-verifier）· **合格** + O-36 **未能复现**

**冻结件 sha256（9 个路径，我逐一核过，与 Lead 声称全部吻合）**

| 文件 | sha16 | 字节 |
|---|---|---|
| `roco/src/roco_env/planner.py` | `9c2619403681509f` | 56736 |
| `roco/src/roco_env/service.py` | `670b299a805a89cc` | 202263 |
| `roco/tests/test_plan_budget.py`（新） | `03bce7429f646a9a` | 12895 |
| `roco/tests/test_plan_scenarios.py` | `3a4694493185a86b` | 66471 |
| `src/coach/toolbox.js` | `528216463b73f9f9` | 105984 |
| `src/coach/roco-client.js` | `949694b2df3769f3` | 50785 |
| `tests/roco-plan-context.test.js` | `c8660b074dcf3557` | 34146 |
| `reports/roco/product-execution/04/04.3-budget-truncation-cache.md` | `ae26d6db1d3997f6` | 18360 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `d581b307e7699157` | 31938 |

**方式**：`git archive 3bb4356` → `E:\roco-scratch\verify-043`（3516 文件）；只读探针；
Node 侧驱动**真** `executeTool('plan_actions')`（假桥 + 假规划器，不起 Python）；未改任何文件。

---

## §0 判定

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | R3 计数比（逐种子分子/分母，不是把握度） | **合格** | `by_seed{11,29,47}` 各给 `{numerator,denominator}`；`is_confidence:false` / `is_probability:false` |
| 2 | R5 束宽逐类留痕 | **合格** | `truncation{dropped_by_kind,dropped[],rule,kept_by_kind}` 齐；`dropped[]` 每条有 `action/kind/value/why` |
| 3 | R8 深度截断语义 + 服务侧 400 边界 | **合格** | 见 §3：服务侧超限 **400 不 clamp**；`depth_truncated` 只在直接调 `plan_actions()` 时成立，判据与实现一致 |
| 4 | P6 缓存七元组 | **合格** | 见 §4；**我自己构造了「少一项」场景** |
| 5 | D-27 读侧（缺/坏 ⇒ unknown，绝不当 0） | **合格** | 对象形给 `mean`；5 种坏形状全 `unknown` + `value:null`；合法 `mean=0` 仍 `known` |
| 6 | 金标刻意重算（旧字段零改动） | **合格** | 我独立按键路径 diff：`added=57/34/181/109 · removed=0 · changed=0` |
| 7 | `roco-client.js` 那 4 行仍走白名单 | **合格** | 白名单已含 `opponent_scenarios`；body ⊆ 白名单；空数组不带；`seed` 仍进不去 |
| — | **O-36**（Lead 那次 `failures=7` 未复现红） | **未能复现** | 5 次顺序 + 1 次与重活并发，**6/6 全绿 `Ran 56 · OK`** |

---

## §1 R3 计数比（`coverage_detail`）

```
service 级（analysis_seeds=[11,29,47]）:
{ "unit": …, "is_confidence": false, "is_probability": false,
  "by_seed": { "11": {"numerator": 4, "denominator": 4},
               "29": {"numerator": 4, "denominator": 4},
               "47": {"numerator": 4, "denominator": 4} },
  "meaning": "对手反制被枚举过的候选数 / 参与搜索的候选数（beam 裁剪**之后**的分母）",
  "excluded_from_denominator": "beam 之外的候选（见 truncation.dropped）",
  "note": "coverage 是计数比，**不是**「结论有多可靠」的把握度，也不是概率" }
⇒ 逐种子给分子/分母（**没有**合成一个假精确的单值）；无 confidence/probability/precision 字段
```
（我第一版探针找的是 `per_seed`，实际键名是 **`by_seed`** —— 这是我的探针写错，读数已按实际键名取。）

## §2 R5 束宽逐类留痕

```
service 级 truncation: {rule, candidates_total, candidates_kept, candidates_dropped,
                        dropped_by_kind, kept_by_kind, dropped[]}
planner 级（beam=1）truncation.dropped[0]:
  {action, kind, value, why} 四项齐  ⇒ 每条被裁的都能追到「谁、哪类、多少分、为什么」
```

## §3 R8 深度截断语义（**重点：边界与判据一致**）

```
service 级 budget 字段（比清单更全）:
  depth_requested/depth_effective/depth_max/depth_searched_max/depth_truncated/depth_capped_by_max
  beam_requested/beam_effective/beam_max/beam_truncated/budget_ms/nodes/timed_out/note

服务侧对超上限 depth/beam **直接 400，不静默 clamp**（我实测）:
  depth=4  ⇒ 400「depth 必须是 1..3 之间的整数」
  depth=99 ⇒ 400（同上）      beam=9  ⇒ 400「beam 必须是 1..8 之间的整数」
  beam=99  ⇒ 400（同上）
⇒ 所以**服务回执里** `depth_truncated` 恒 false（调用方根本递不进超限值）；
  它只在**直接调 `plan_actions()`** 时有意义（我实测）:
  depth=1/2 ⇒ truncated=false, capped=false
  depth=3   ⇒ truncated=false, capped=**true**（到引擎上限，不是「没算完」）
  depth=4   ⇒ truncated=**true**,  effective=3
  depth=99  ⇒ truncated=**true**,  effective=3
  beam=99   ⇒ beam_truncated=**true**, beam_effective=8
  超时（注入确定性时钟 budget_ms=1）⇒ depth_searched=0 < depth_effective=3,
       depth_truncated=false, timed_out=true     ← 与 note 里那条语义（「只可能是 timed_out」）一致
⇒ **判据与实现一致**：三种「没走完」被分成 `depth_truncated`（被上限截）、`depth_capped_by_max`
  （到顶但完整）、`timed_out`（没算完），互不冒充。
```

## §4 P6 缓存七元组

```
键格式（rocoPlanCacheKey）: m-043|v7|rv-1|d2|b4|t2000|s11.29   （7 段）
逐项拿掉:
  -match_id / -state_version / -rules_version ⇒ **null（不进缓存）**
  -depth / -beam / -budget_ms / -analysis_seeds ⇒ 该段回落 `ddefault|bdefault|tdefault|sdefault`（**仍可缓存**，键不同）
  ⚠ 精确化：「身份缺一不进缓存」准确说是**三个身份项**（match_id / state_version / rules_version）；
     另外 4 项是参数，缺失走 `default` 占位（不会静默与「显式给值」的调用撞键）。
工具级（真 executeTool('plan_actions')，假桥）:
  第1次 cache = {hit:false, stored:true,  key:"m-043|v7|rv-1|ddefault|bdefault|tdefault|sdefault",
                 keyParts:{match_id,state_version,rules_version,depth,beam,budget_ms,analysis_seeds}}
  第2次 cache = {hit:true,  stored:false, key:同上, keyParts:同上, ageMs:0}   ⇐ 命中回执带 hit/key/keyParts/ageMs
【我自己构造的「少一项」场景】把 state.rules_version 删掉再跑两次:
  两次都是 {hit:false, stored:false, key:null}，缓存条数 **0**  ⇒ 身份不全 ⇒ 既不读也不写缓存
【未完成不缓存】engine 报 timed_out ⇒ stored=false，缓存条数 0（没把「没算完」永久化）
```

## §5 D-27 读侧（这是我上一轮抓的那条缺口）

```
readFirstSecondMargin（真 export，逐形状）:
  对象形 {min:0.01,max:0.09,mean:0.0732,scale,note} ⇒ status=known, value=0.0732
  缺字段 / 标量形 0.0732 / 缺 mean / mean=null / 数组 ⇒ status=unknown, value=**null**（绝不当 0）
  合法 {min:0,max:0,mean:0} ⇒ status=known, value=0     ← 「真的是 0」与「拿不到」分得开
  available=false ⇒ status=not_applicable, value=null
工具回执层（缺字段）:
  firstSecondMargin = null
  firstSecondMarginDetail.status = unknown
  limitations = ["引擎自报的限制", "边际量不可用：first_second_margin 不是 {min,max,mean} 对象（实际 缺失）：
                 不产出数字，也**不当 0**"]     ⇒ 点名了，且引擎自己的 limitations 原样保留
```

## §6 金标「旧字段零改动」（独立按键路径 diff）

```
把 da6e970 与 3bb4356 两版 test_plan_scenarios.py 里的四块金标抽出来，递归展平成键路径后比对：
  PLANNER_DEFAULT_GOLDEN_TEXT        added=57   removed=0  changed=0
  PLANNER_DEFAULT_BEAM8_GOLDEN_TEXT  added=34   removed=0  changed=0
  SERVICE_DEFAULT_GOLDEN_TEXT        added=181  removed=0  changed=0
  SERVICE_DEFAULT_BEAM8_GOLDEN_TEXT  added=109  removed=0  changed=0
新增键全是 04.3 的 budget./truncation./coverage_detail. 一族（样例 budget.depth_truncated、
budget.beam_effective、budget.nodes…）
⇒ 与 Lead 声称的 57/34/181/109 · removed=0 · changed=0 **逐数吻合**；**旧字段零改动**这半成立
（test_plan_budget.py 在 04.2 版不存在 ⇒ 新文件，不参与比对）
```

## §7 `roco-client.js` 那 4 行：没开新口子

```
白名单（tests/roco-plan-context.test.js 的 PLAN_BODY_KEYS，9 项）:
  analysis_seeds, beam, budget_ms, damage_preview, depth, opponent_scenarios, public, ruleset_id, state_version
传给 planActions({opponentScenarios:[{scenario_id:'s1',kind:'stay_attack'}]}) ⇒
  body keys = ruleset_id,state_version,public,opponent_scenarios     ⊆ 白名单 ✓
传 opponentScenarios: [] + seed: 424242 ⇒
  body keys = ruleset_id,state_version,public   ⇒ 空数组不带该键；**seed 仍进不去** ✓
```

## §8 O-36：**未能复现**（附我这次的长跑读数）

```
命令: python3 -m unittest tests.test_planner tests.test_plan_scenarios tests.test_plan_budget
[seq1] exit=0  Ran 56 tests in 19.018s OK
[seq2] exit=0  Ran 56 tests in 18.346s OK
[seq3] exit=0  Ran 56 tests in 18.837s OK
[seq4] exit=0  Ran 56 tests in 18.046s OK
[seq5] exit=0  Ran 56 tests in 22.561s OK
[load1] exit=0 Ran 56 tests in 24.764s OK      ← 与「全量 discover」重活并发
```
- **6/6 全绿**（5 顺序 + 1 并发），**没有**复现 Lead 那次 `Ran 56 · FAILED (failures=7)`；
  因为没红，**没有 FAIL 用例名可抓**（我器材这次能抓 `^FAIL: `，是「无红可抓」）。
- ⚠ **第 7 次（load2）没能跑完**：我用来制造负载的伴跑进程（`unittest discover` 全量）在本机
  **归档副本上卡住不收敛**（这是**第二次**出现，04.2 报告也记过），把 load2 饿死了 ⇒ 我 kill 了。
  不影响结论（6 次已足以说「不是稳定红」），但**请把它当作环境事实**：
  跨机/跨路径比对全量数字前，先确认 `unittest discover` 在这条路径上是否正常收敛。

## §9 诚实边界

- 我只验 04.3 点名的判据；`tests/evals/structure-contract.test.js`（11 未登记 + 1 judge 指向不存在）
  按你的交代**未动**。
- R3 的 `by_seed` 键名起初被我写成 `per_seed`（探针错，已按实际键名重取）。
- 「身份缺一不进缓存」我按实测补精确：**3 个身份项**才导致不缓存，4 个参数项回落 `default`。
- 全量套件我**未复跑**（该命令在本机归档副本上卡住，见 §8）。

## §10 复跑

```powershell
git archive 3bb4356 | tar -x -C E:\roco-scratch\verify-043
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-043/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-043-probe.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-043/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-043-probe2.py"
node E:\roco-coach\scripts\roco\verify-043-cache-d27.mjs
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch && python3 vfy-043-golden.py"     # 金标零改动
wsl -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-043-o36.sh                            # O-36 长跑
```
