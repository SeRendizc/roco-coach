# 独立复验：04.3b 冻结版 `5449db7`（harness-verifier）· **合格**

**冻结件 sha256（4 个路径，我逐一核过，与 Lead 声称全部吻合）**

| 文件 | sha16 | 字节 |
|---|---|---|
| `src/coach/toolbox.js` | `298ecf8dabe934be` | 114408 |
| `tests/roco-plan-context.test.js` | `c9bf9033108061e3` | 46324（**20** 条 ✓） |
| `roco/tests/test_plan_scenarios.py` | `a6363554447d5bc4` | 94123 |
| `reports/roco/product-execution/04/04.3b-action-scenario-consumer.md` | `5ed01e73ba3af88f` | 8498 |

**方式**：`git archive 5449db7` → `E:\roco-scratch\verify-043b`（3533 文件）；只读；
Node 侧驱动**真** `executeTool('plan_actions')`（假桥 + 假规划器）；换人期望**我自己**从 `seen_roster` 现算；
改坏版只在副本内做，每轮还原并复核 sha（收尾 `298ecf8dabe934be` = 冻结件）。

---

## §0 判定：**合格**（6 项全过；2 条登记）

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | 消费纪律：原样传 + `slots:[]` 不猜 + `unavailable`（含 P3）照实传 | **合格** | 字段集合 = 引擎契约那 7 样；池情景 `slots:[]`；P3 行 + `limitations` 点名 |
| 2 | ⑨a 独立期望（不读 03b sources） | **合格** | 我现算 `[1,2,3,4,5]` == 实际换人位次；**N11 塌缩 ⇒ 必红** |
| 3 | 前置闸 fail-closed 两向 | **合格** | 客户端快照 ⇒ 不注入 + `view-missing-active` + 原因；完整视图 ⇒ 照常注入 |
| 4 | 裁剪 70 ⇒ 64 | **合格** | 发出 64 条（s000…s063）+ 6 条 `over_engine_limit:s064..s069` 逐条登记 |
| 5 | 真数据集成（03b 真产出 → 真引擎） | **合格** | 9/9 **全部接受**（无 400）；池情景**零分支**；逐条 `unavailable`；见 §5 两处数值差异 |
| 6 | Node N11/N12/N13/N14 有牙 | **合格** | 四条变异**各自必红**（都是 `⑨a`）；控制 20/20 |

---

## §1 消费纪律（原样传，不映射）

```
真 view（raw-03.3-view-pvp.json）⇒ 注入 9 条，实际发出的字段 =
  scenario_id, kind, slots, species_ids, skill_ids, evidence_basis, evidence_ids
  （就是引擎契约那 7 样；没有多余字段、也没有把 kind 映射成别的名字）
留场 = 4 · 换人 = 5 · 池情景 = 2
池情景：slots 一律 []（照传，不猜位次）· evidence_basis='learnable_pool_hypothesis' 保留
normalizeOpponentScenarioRows 直测：
  {scenario_id:'a',kind:'switch_in_seen',slots:[],…} ⇒ slots 仍是 []、kind 不被映射、basis 保留
  {…,slots:[2],…} ⇒ species_ids/skill_ids 原样
unavailable.what = [inferred_candidate_slots, opponent_will_switch, **bench_hp_and_moveset**,
                    unrevealed_skills_as_actions, range_or_weight_as_probability]
  P3 行 = {"what":"bench_hp_and_moveset",
           "why":"P3 残留：对手后备按满血 + 规范配招假设建模（引擎 state_from_public_planner），不是观察"}
limitations 里点名「P3 残留」 ✓
回执 counts = {"stay":4,"switch":5,"observed":7,"hypothesis":2}（与 03b 报告一致）· protocol/source 齐
```

## §2 ⑨a 的独立期望（关键判据）

```
我自己从公开面现算（排除场上位次 + 倒下位次 + 去重排序）:
  activeSlot = 0（view.opponent.field.slot）· fainted bench slots = [] ⇒ 期望位次 = [1,2,3,4,5]
实际发出的 switch_in_seen 位次 = [1,2,3,4,5]  ⇒ 数量与位次**逐个相等**
留场与换人**并存**（4 / 5）⇒ 没塌缩
变异 N11（把 switch_in_seen 全过滤掉）⇒ exit=1 · 19 pass / 1 fail · 红在
  「⑨a 消费真 view：留场与换人并存（不塌缩）· slots=[] 照传 · 池情景带假设标记 · P3 照报」
  ⇒ 这条判据读的是**公开面**，不是 03b 自己的 sources（否则塌缩时它自己也塌缩，判据就空了）
```

## §3 前置闸（两向）

```
① 客户端快照形状（foe / foe_bench，**没有 opponent.field**）
   ⇒ planner 收到的 opponentScenarios = undefined（不注入）
   ⇒ 回执 source='view-missing-active' · available=null（不是 false/true）
   ⇒ why = 「公开视图里没有 `opponent.field`（对手场上那只不可确定）⇒ 留场/换人无法区分，不注入情景」
② 完整视图（⑨a 那份）⇒ 照常注入 9 条  ⇒ **前置闸没把功能关掉**
③ 完全没有视图 ⇒ source='missing-view' 且不注入
```

## §4 裁剪（70 ⇒ 64）

```
走 03b 路径（actionScenarioBuilder 注入 70 条）:
  发出 = **64** 条，首/末 id = s000 / s063（按 scenario_id 定序）
  over_engine_limit 登记 = 6 条，样例：
    {"what":"over_engine_limit:s064","why":"引擎 opponent_scenarios 上限 64 条；按 scenario_id 定序截断","evidence_ids":["x"]}
  登记的正是被裁那 6 条（s064..s069）
⚠ 登记（不是缺陷，但值得记）：**截断只发生在 03b 路径**；`configureRocoTools({opponentOutlook})`
   那条**测试用** provider 路径不截断（我实测发出 70 条）。生产走 03b，所以风险有限；
   但若将来有产品代码去配 `opponentOutlook`，70 条会被引擎 400。
```

## §5 真数据集成（03b 真产出 → 真引擎）

我把**实际会发出去的那 9 条 rows**从真消费侧导出（`E:\roco-scratch\043b-sent-rows.json`），
喂给冻结副本的真引擎（`battle_new` → `public_planner_state` → `/battle/plan`）：

```
battle_new http = 200 · battle_plan http = 200 · error = None        ⇒ **9/9 全部接受，无 400**
source = injected_scenarios · scenario_ids = 9 条（逐条回显）
enumerated_by_seed = {"11":4,"29":4,"47":4}    实际动作 = [仙人掌刺击, 防御, 换上第2位, 换上第3位]
weights = uniform_baseline · basis = 「…**不是概率**…」
unavailable（引擎侧逐条）= 8 条「枚举不出这个技能」+ 2 条「这条情景一个动作都枚举不出来（不假装能算）」
                          + 3 条「都在束宽外（按 scenario_id 定序截断，不按权重）」
dropped（引擎侧）= [换上第4位, 换上第5位]（都注明「束宽 4 之外，按 scenario_id 定序截断，不按权重」）
**池情景产生的动作 = {"stay:pool:pet_000239": [], "stay:pool:pet_000242": []}** ⇒ **零分支** ✓
coverage_detail.by_seed = {"11":{4,4},"29":{4,4},"47":{4,4}}（分母 4 = beam 裁剪之后）
```

**两处数值与它报告的差异（如实登记，不是矛盾）**

| 项 | 它报告 | 我实测 | 说明 |
|---|---|---|---|
| `engine_enumerated` | 3（`[防御, 换上第2位, 换上第3位]`） | **4**（多一个 `仙人掌刺击`） | 我那一局的公开面与它那局不同 ⇒ 重建状态里「那只的技能池」不同 |
| `dropped_by_engine` | `[]` | **2**（换上第4位/第5位） | 同上（束宽 4 下位次 3/4/5 落在束宽外） |

⇒ 这两处**都是探针局面决定的**，它的文档 §2.1 已自述「这一份 03b view 来自另一局留档，与本探针的公开面不是同一局面」；
**结论性的东西两边一致**：全部接受、无 400、池情景零分支、逐条 unavailable、`coverage 4/4`。
⚠ 建议：报告里把 3 / `[]` 标成「**本例读数**」而不是稳定属性，免得后人拿它当基线。

**P3 残留的翻转面**（它要求确认「如实登记、没被悄悄说成已支持」）：
```
引擎侧对两条池情景给出「一个动作都枚举不出来（不假装能算）」+ 逐技能点名；
消费侧把 03b 的 P3 行原样带出并在 limitations 点名；
03b 把它们标 learnable_pool_hypothesis（假设 ≠ 观察）⇒ **三处口径一致，没有宣称已支持**
```

## §6 Node 侧变异（我自己造的等价版，各一条）

```
控制（未变异）⇒ exit=0 · tests 20 · pass 20 · fail 0
N11 03b 塌缩（过滤掉 switch_in_seen）        ⇒ exit=1 · 19/1 · 红：⑨a
N12 猜位次（池情景空 slots 补 [0]）          ⇒ exit=1 · 19/1 · 红：⑨a
N13 抹掉假设标记（丢 evidence_basis）        ⇒ exit=1 · 19/1 · 红：⑨a
N14 吞掉 P3 残留（过滤 bench_hp_and_moveset）⇒ exit=1 · 19/1 · 红：⑨a
每轮还原后 sha16 = 298ecf8dabe934be（与冻结件一致）
```

## §7 诚实边界

- Python 侧我只跑了**定向**命令（`test_plan_scenarios` 相关由 04.2/04.4 轮次覆盖；本轮我只跑真引擎集成探针），
  **没有**在 `/mnt/e` 副本上跑全量 `discover`（O-38：本机不收敛）。
- Node 侧只跑 `tests/roco-plan-context.test.js`（20/20），未跑全量 Node 套件（O-42）。
- 我的第 4 项第一版走错了注入点（用了测试用的 `opponentOutlook`，那条不截断）⇒ 已改走 `actionScenarioBuilder` 重测，
  并把「两条路径行为不同」如实登记（见 §4）。

## §8 复跑

```powershell
git archive 5449db7 | tar -x -C E:\roco-scratch\verify-043b
node E:\roco-coach\scripts\roco\verify-043b-consumer.mjs            # 消费侧四项（会落盘 rows）
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-043b/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-043b-engine.py"
# 变异：E:\roco-scratch\vfy-043b-mutate.sh {n11|n12|n13|n14|restore}
```
