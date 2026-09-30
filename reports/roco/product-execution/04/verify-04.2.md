# 独立复验：04.2 冻结版 `da6e970`（harness-verifier）· **合格**

**冻结件 sha256（我逐一核过，与 Lead 声称全部吻合）**

| 文件 | sha16 | 字节 |
|---|---|---|
| `roco/src/roco_env/planner.py` | `b4ee5c1b4f99d2a3` | 48812 |
| `roco/src/roco_env/service.py` | `a8c994abb7f832d8` | 197208 |
| `roco/tests/test_plan_scenarios.py` | `a636ea24535359d3` | 47919 |
| `tests/roco-plan-context.test.js` | `2f29f6a37a6ac6bc` | 17884 |
| `reports/roco/product-execution/04/04.2-scenarios.md` | `9af03557c54b4992` | 21862 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `f63cd7102194be8c` | 31080 |

**方式**：`git archive da6e970` → `E:\roco-scratch\verify-042`（3491 文件）；改坏版只在副本内做，
每轮 `restore` 后复核 sha（收尾 `roco-client.js` `9364f5fb41865b17` / `service.py` `a8c994abb7f832d8` 与冻结件一致）。

---

## §0 判定：**合格**（7 项全过；3 条措辞按实测补精确）

| # | 判据 | 判定 | 关键读数 |
|---|---|---|---|
| ① | 缺省逐位不变（金标 20 键 / 空数组 vs 不注入） | **合格（含 1 处措辞更正）** | planner 级 `to_dict()` **恰好 20 键 = DEFAULT_KEYS**；空数组 ⇒ 计划数值全同、**多 1 键** |
| ② | 注入**有牙** | **合格** | 变异「忽略注入」⇒ `test_plan_scenarios` **25 条 5 红** |
| ③ | 8 类坏形状 fail closed + 概率性字段一律拒 | **合格** | 我造 **12 类**坏形状 ⇒ **12/12 全 400**；`probability/weight/share/p` 各自点名拒绝 |
| ④ | 注入不得读到隐藏真值 | **合格** | `public._pending_enemy` ⇒ 400；planner 级两状态只差 `_pending_enemy` ⇒ 计划逐字段**相同**（带噪声地板） |
| ⑤ | 回执能区分「注入情景 / 规范配招假设」 | **合格** | `source=injected_scenarios` vs `default_candidate_moveset`；`scenario_ids` 按 id 定序 |
| ⑥ | P3 残留如实 + 两栏键集不相交 | **合格** | 两栏交集 = `[]`；`residuals[P3].status="not_done"` 且写明 why/criteria |
| ⑦ | 新增「请求体白名单」断言（假客户端抓包） | **合格** | body 键集 ⊆ 白名单；**新透传字段（名字无 seed）⇒ 必红**；两个入口都钉 |

---

## §1 ① 缺省逐位不变

```
planner 级 PlanResult.to_dict()（`roco/tests/test_plan_scenarios.py` 的 DEFAULT_KEYS 逐字对照）
  缺省  : n=20  | 与 DEFAULT_KEYS 完全相同 = True · 多出 [] · 缺 []
  注入  : n=21  | 新键 = ['opponent_model_detail'] · 丢键 = []
  ⇒ 「新键只许在注入时出现」成立

service 级回执（另一层投影，26 键）
  不注入     : 26 键，**没有** opponent_basis
  注入空数组 : 27 键，多出的正是 opponent_basis =
               {"source":"default_candidate_moveset","label":"本次对手依据 = 规范配招假设(缺省)",
                "is_probability":false,"scenario_driven":null, ...}
               其余全部逐字段相同（去 latency_ms）
```
**⚠ 措辞更正（我上一轮清单里也沿用过的说法）**：「注入空数组 == 不注入**逐字段相同**」**不准确** ——
plan 数值确实逐字段相同，但**键集多 1 个** `opponent_basis`。准确的写法是：
「**不带**该键 ⇒ 回执与 04.2 之前逐字段相同（26 键）；**带空数组** ⇒ 计划数值相同 + 多一栏
`opponent_basis`（`source=default_candidate_moveset`、`scenario_driven=null`）」。代码注释本身写的是前者，没问题。

## §2 ② 注入有牙 + ③ 坏形状 fail closed

```
[②] 变异：service 里 opponent_scenarios=(raw if parsed else None) → None（忽略注入）
    ⇒ Ran 25 tests · FAILED (failures=5)   ← 注入不是装饰
[③] 我自造的 12 类坏形状，逐条 400：
    整体不是数组 · >64 条 · 行不是对象 · 缺 scenario_id · scenario_id 重复 · kind 不在词表 ·
    probability · weight · share · p · slots 非整数数组 · species_ids 非字符串数组
    合法情景（控件）⇒ 200
    例：｢opponent_scenarios[0] 不许带 weight：情景集合不是概率分布｣
```

## §3 ④ 注入不得读到隐藏真值

```
service 级：public 里种 _pending_enemy ⇒ 400「请求里出现了隐藏信息字段：public._pending_enemy」（拒 = 安全）
planner 级：两个 state_from_public_planner 出来的状态，**只差** _pending_enemy
   ⇒ 注入 3 情景后计划 **逐字段相同** = True
   噪声地板：同一状态跑两次也相同 = True（否则上面的「相同」没意义）
对照：不注入 vs 注入 ⇒ 计划**不同**（证明注入真的进了搜索）
```

## §4 ⑤ 依据可区分 + 缺项如实

```
注入: opponent_basis.source = injected_scenarios
      label = 「本次对手依据 = 注入情景」
      scenario_driven.scenario_ids = ['s1','s2','s3']（我按 s3,s1,s2 注入 ⇒ **按 id 定序**，不按权重）
      kinds = ['stay_attack','stay_defense','switch_in_seen'] · weights='uniform_baseline' · is_probability=False
      enumerated_by_seed = {"11":1,"29":1,"47":1}（service 级）
缺省: source = default_candidate_moveset · scenario_driven = null
缺项: 用真实技能 id ⇒ enumerated_by_scenario={"s1":1,"s2":1,"s3":0}，
      s3 如实进 unavailable[]：「这条情景点名到的动作都在束宽外（按 scenario_id 定序截断，不按权重）」
      用**不存在的**技能 id ⇒ unavailable[] 两条，逐条写 skill_id 与原因（「不假装能算」）
```

## §5 ⑥ P3 残留与两栏键集

```
scenario_driven  keys = [actions_by_seed, basis, dropped, enumerated_by_scenario, enumerated_by_seed,
                         evidence_ids, is_probability, kinds, note, scenario_ids, unavailable, weights]
assumption_driven keys = [assumption_note, opponent_bench, opponent_moveset, public_assumptions,
                          still_in_effect, unrevealed_species]
交集 = []                                        ← 「两栏键集互不相交」成立
residuals = [{id:"P3", what:"用情景可学池…替换对手配招假设", status:"not_done",
              planned:"04.2b 或 05 专项（另开切片，需 Lead 裁决）", why_not_here:"…会改对手侧结算语义…",
              criteria:[判据①隐藏真值不变…, 判据②只吃公开面…]}]   ← 如实写明未做
```

## §6 ⑦ 请求体白名单（我独立抓包）

```
我自己的探针（假 `_http` 抓「实际会发出去的 body」并计数；src/coach/roco-client.js:676 是传输层）
  planActions(public, {stateVersion, depth, beam, budgetMs, analysisSeeds, damagePreview,
                       seed: 424242, opponentHint: 'X'})
    body keys = ruleset_id,state_version,public,depth,beam,budget_ms,analysis_seeds,damage_preview
    ⊆ 白名单 ✓ · 含 seed? False · 含 opponentHint? False · HTTP 次数 = 1
  隐藏键本地拒绝（**0 次 HTTP**，即「连发都不发」）：
    public.seed                    code=hidden_information  http=0
    public.self.seed（深层）        code=hidden_information  http=0
    public.history[0].seed         code=hidden_information  http=0
    public.opponent._pending_enemy code=hidden_information  http=0
    public.rng_seed（别名）         code=hidden_information  http=0
  控件：干净 public ⇒ 1 次 HTTP、path=/battle/plan、无 error
两向变异（Node 测试 tests/roco-plan-context.test.js，各跑一次、每轮还原）：
  M-⑦a  body = {public, ...options}      ⇒ exit=1 · 8 pass / 2 fail
        红：⑦ 请求体白名单… · ⑦b 工具层同样只发公开面（planActionsViaPlanner 不给请求体加料）
  M-⑦b  **新透传字段**（body.opponent_hint='MUTATED-NEW-PASSTHROUGH'，名字里没有 seed）
         ⇒ exit=1 · 8 pass / 2 fail（同样两条红）    ← 这正是新断言要拦的东西
  还原后 ⇒ 10/10 绿
```
⇒ ⑦ 不只是「钉住 seed 这个词」，而是**钉住键集白名单**，能拦住将来的静默透传；**两个入口都覆盖**。

## §7 读数对齐（我复跑，全部与 Lead 一致）

```
Python（冻结副本，逐条）
  tests.test_plan_scenarios   exit=0  Ran 25 tests  OK
  tests.test_planner          exit=0  Ran 21 tests  OK
  test_planner+test_plan_scenarios  Ran 46 tests  OK
  tests.test_sim_endpoints    exit=0  Ran 36 tests  OK
  tests.test_public_planner   exit=0  Ran 28 tests  OK
  tests.test_individual_panel exit=0  Ran 28 tests  OK
Node
  tests/roco-plan-context.test.js        exit=0  tests 10  pass 10  fail 0
  tests/evals/roco/plan-e2e.test.js      exit=0  tests 10  pass 5   （另 5 条本机 skip）
全量：见 §9（后台跑，若未及时完成则以 Lead 的 Ran 900 · 1F + 2S 为准并注明我没复跑）
```

## §8 我上一轮 O-21 两处措辞的**更正**（按实测重写）

我 04.1 报告里写「`planActions` 没有这个显式拒绝」「测试里没有任何断言」——**两句都要按实测更正**：

1. **本地拒绝确实存在**，位置在 `src/coach/roco-client.js:574-585` 的 `_request` 里（`findHiddenKeys` 扫描
   + `ROCO_ERROR.HIDDEN_INFORMATION`），**不在** `planActions`/`_payload`。
   我这次实测 5 种隐藏键形状 ⇒ `code=hidden_information` 且 **HTTP 次数 = 0** ⇒ 「连发都不发」成立。
   （我上轮只读了 `planActions` 与 `_payload` 就下了结论，**查漏了一层**。）
2. **测试本来就有** seed/请求体的断言，在 `tests/evals/roco/plan-e2e.test.js`（③④：客户端拦截 + HTTP 0 次、
   两个不同内部 seed 的公开面逐字节一致），只是**本机 5 条 skip**（没有 python3 时明确 skip 并给原因，
   不假装通过）。我上轮 grep 只查了 `tests/*.test.js` 一层，**漏了 `tests/evals/roco/`**。
   ⇒ 新增 ⑦ 的真实增量 = 不需 python3、永不 skip、钉**键集白名单**、**两个入口都钉**（⑦ 与 ⑦b）。

## §9 诚实边界

- **全量套件我没复跑成功**：我在归档副本里起了一次 `unittest discover`，**十余分钟仍未收敛**
  （stdout 0 字节；stderr 最后一条是 `test_agent_tasks.py:141` 的 `ResourceWarning`，90 秒内无任何增长）
  ⇒ 我把它 kill 了，**不主张**该读数。全量的 `Ran 900 · 1F + 2S` 以 **Lead 的读数为准**（我方未复现）。
  本轮我复跑成功的是 §7 列出的**逐文件定向读数**（全部与 Lead 一致）。
  ⚠ 提醒：归档副本走 `/mnt/e`（drvfs）比工作树慢，且个别用例可能依赖本机产物；
  跨机比对全量数字前，先确认这份差异不是环境造成的（我这台就是反例）。
- `tmp/skill-slice-inventory.json` 本机不存在 ⇒ skip=2 这条跨机比对前需先声明（与我方一致）。
- 我只验了 04.2 点名的判据；`04.3+` 的 `toolbox.js/truncation/缓存键` 不在本轮。
- 我的两次变异第一版都有缺陷（⑦b 塞的是 `options.opponentHint` ⇒ 调用方没传 ⇒ 被 `JSON.stringify` 丢掉；
  ② 在 Python 表达式里插了 C 风格注释 ⇒ 语法错），**已修正并重跑**，上面给的是修正后的读数。

## §10 复跑

```powershell
git archive da6e970 | tar -x -C E:\roco-scratch\verify-042
# 引擎侧
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-042/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-042-probe.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-042/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-042-probe2.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-042/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-042-probe3.py"
# 桥侧
node E:\roco-coach\scripts\roco\verify-042-body.mjs
# 变异：E:\roco-scratch\vfy-042-mutate.sh {spread|newfield|ignoreinj|restore}
```
