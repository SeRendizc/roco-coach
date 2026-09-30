# 独立复核：03.3 冻结版 `0d96ce3`（harness-verifier）· **合格**

**冻结件 sha256（我亲自核过，与 Lead 声称逐一吻合）**

| 文件 | sha256 | 字节 |
|---|---|---|
| `src/coach/opponent-belief.mjs` | `4a1cbb779a5622e5…` | 203938 |
| `tests/roco-opponent-belief.test.js` | `2f51f3774afcb03a…` | 109844 |
| `reports/roco/rc604/opponent-belief.json` | `ce7ee2450293a0c7…` | 177014 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `8266449b75a087f6…` | 27647 |

**方式**：`git archive 0d96ce3` → `E:\roco-scratch\verify-03.3`（3454 文件）；引擎侧另在真引擎上跑我自己的探针；
所有改坏版只在副本内做，每轮 `restore` 后复核 sha256（收尾 `4a1cbb779a5622e5` / `2f51f3774afcb03a` 与冻结件一致）。

---

## §0 判定：**合格**（5 项全过；另登记 2 条观察）

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | 反例①（引擎 + Node）+ 反向控制 + **我自己造的相容却被误排除的坏版** | **合格** | 引擎 7 配置全 318、敏感组 320/321/325；Node 7 情景全留、`multi_solution=true`、未排除；反向控制才排除且带 `view.events[seq=7]`；我的坏版变异 ⇒ `03.3-E2` **红** |
| 2 | 证据观察器只吃 5 条公开路径 + 个体口径被拒 | **合格** | `evidence[].pointer` 逐条就是那 5 条；注入 `individual-snapshot` ⇒ `rejected[]` 有记录且 `turn_order=[]`；`species-race` ⇒ `turn_order=["t2:55/species-race"]` |
| 3 | 缺口#1 两向 + 两半按组 | **合格** | 死条目（A）与未入白名单的 key（B）**都红**（`exit=1 · 28/2`，失败用例 `03.3-缺口#1…`）；按组结构我独立 dump（见 §3） |
| 4 | 30 条用例 + 报告重生成逐字节 | **合格** | `exit=0 · tests 30 · pass 30 · fail 0`；`RC604_WRITE_REPORT=1` 后 sha16 `CE7EE245…` **与冻结件相同** |
| 5 | 先手速度「面板口径 ⇒ not_applied，不换算不排除」没被绕过 | **合格** | 真 view `applied=false`（reason：没有 `speed_provenance`）；注入同量纲 `species-race,55` ⇒ `applied=true · excluded=18` |

---

## §1 反例①（必做反例）——引擎侧（**我自己跑的真引擎**）

```
battle_new http=200 · 对手伤害出现在第 2 次推进 · public_damage = 319 · skill = skill_000340
foe = pet_000007 · base_panel_source = species-race · panel keys = [atk,def,hp,spa,spd,spe]
baseline_replay = 318            ← 与实战 319 差 1（与它登记的 ±1 保真度一致）
matching  = spa+4/spd-4→318 · spa-4/spd+4→318 · spd+6→318 · hp+10→318 · def+4→318 · def-4→318
sensitive = atk+1→320 · atk+2→321 · atk+4→325
CHECK1 匹配组全等基准 = True · CHECK2 敏感组确实变了 = True · CHECK3 相等不是恒等 = True
```
⇒ **逐字复现**它公布的三组数字，且这是**我自己的探针**（`E:\roco-scratch\vfy-033-replay2.py`）。

## §2 反例①——Node 侧（真 view 夹具 `raw-03.3-view-pvp.json`）

```
公开伤害读数 = t2:enemy:skill_000340:319@view.events[seq=7] · t2:player:skill_000246:28@view.events[seq=8]

[多解] 注入 7 个相容情景(318..319, 各带 source+assumption:true)
  candidate.multi_solution = true
  individual_range.scenarios n = 7 · known = false
  scenarios[0] = {"scenario_id":"sc1","config":{"stats_source":"individual-panel",...},
                  "damage":{"min":318,"max":319},"source":"engine-replay","assumption":true}
  unknowns = ["未核实：哪一种是真身 —— 同一份公开伤害由多种个体配置都能解释"]
  该候选被排除？= false     multi_solution 列表 = ["cand:pet_000007"]
[反向控制] exhaustive:true + 唯一情景不相容
  被排除 = true · rule_id = evidence.visible_damage_scenarios
  why = 「可见伤害 319 与全部情景都不相容，且情景集合声明**穷尽** ⇒ 排除这只（依据：伤害读数 + 情景来源）」
  evidence_ids = ["view.events[seq=7]","engine-replay-1"]   ← 含伤害事件 ID ✓
[我造的坏版] 变异：让「相容」也走排除分支（忽略 exhaustive）
  ⇒ exit=1 · 29 pass / 1 fail · 失败用例：03.3-E2（真引擎读数 · 反例①）…两者都保留   ← **相容却被误排除 ⇒ 必红** ✓
```

## §3 缺口#1（白名单逐项覆盖）——两向 + 我独立的结构 dump

**两向变异（副本内，我都跑了）**
```
gap1A（往 opponent_active 白名单塞死条目 bogus_dead_field_F032_MUTATION_A）
   ⇒ exit=1 · 28 pass / 2 fail · 红：03.3-缺口#1（F-03-2 清单）：白名单每一项都必须被夹具或适配器用到（穷尽覆盖）
gap1B（往测试夹具 publicPet() 塞未入白名单的键 bogus_fixture_key_F032_MUTATION_B）
   ⇒ exit=1 · 28 pass / 2 fail · 同一用例红
```

**我独立 dump 的结构（按组）**
```
白名单 opponent_active  : pet_id species_id name slot types stats stats_source spe spe_source
                          hp max_hp energy statuses marks fainted source
白名单 opponent_revealed: pet_id species_id name slot types stats stats_source spe spe_source
                          revealed_via revealed_turn revealed_event_seq fainted source
OPTIONAL opponent_active: species_id source   ·  opponent_revealed: species_id revealed_event_seq source
按组判（判定 C）：hp/max_hp/energy 在「场上那只」白名单里，**不在**「已亮明后备行」白名单里
                  ⇒ 两组交集里这类键 = []  ⇒ 跨组取交集会判错口径这条**成立**
判定 A（用到 ⊆ 白名单）：我用报告里的 public_facts 能读到的组（own_team / mode）逐键核对 ⇒ 未在白名单 = []
```

**如实登记的探针局限**：判定 B（「白名单每项要么被用到、要么在 OPTIONAL 点名」）我用**报告产物**里的键集合去算，
覆盖面太窄（报告只带 own_team/mode 等），**算不出它的 26 used** ⇒ 这一半我**没有**用独立计算证实，
改用「两向变异都红」证明**该判据有牙**。这条算我探针的局限，不算它的缺口。

## §4 30 条用例 + 报告重生成

```
[ctl]   exit=0 · tests 30 · pass 30 · fail 0
[regen] RC604_WRITE_REPORT=1 ⇒ exit=0 · 30/30 ；重生成 sha16 = CE7EE2450293A0C7 = 冻结件 ⇒ 逐字节相同
[final] restore 后 exit=0 · 30/30 ；impl=4a1cbb779a5622e5 / test=2f51f3774afcb03a（与冻结件一致）
```

## §5 先手速度门（没被悄悄绕过）

```
真 view（无 speed_provenance）    : applied=false · reason「这一份证据里没有 speed_provenance：引擎只在面板口径下发它」
注入 species-race / 55（同量纲）  : applied=true  · output {applied:true, excluded:18}
注入 individual-snapshot          : 该观察进 rejected[] 且 turn_order 为空（不使用）
```
⇒ 「面板量纲不可比 ⇒ 不换算、不排除；同量纲才用」这条**在代码里真的拦着**，不是文档话术。

## §6 登记 2 条观察（不影响合格判定）

1. **多解时「不许凭空冒出矛盾」这条没被断言**：我的变异把「相容也走排除分支」的**外层**放宽（`matches.length === 0` → `>= 0`，
   但不改 `exhaustive` 判定）后，套件 **仍然 30/30 全绿** —— 因为多解夹具是 `exhaustive:false`，
   那时只会多推一条**假矛盾** `DAMAGE_UNEXPLAINED_BY_SCENARIOS`（而它是假的：7 条情景都相容）。
   ⇒ 建议给多解用例补一句「相容时 `contradictions` 里不许出现 `DAMAGE_UNEXPLAINED_BY_SCENARIOS`」。
   （同一变异改成「忽略 exhaustive」后就会红 —— 说明**排除**那条有牙，**假矛盾**那条没牙。）
2. `readOpponentEvidence` 返回的 5 条 `evidence[]` 用的键是 `{source_file,pointer,field,value,note}`；
   我在报告里按 `pointer` 引用（首版探针读错了键名，已改）。

## §7 复跑

```powershell
git archive 0d96ce3 | tar -x -C <副本>
node scripts/roco/verify-03.3-evidence2.mjs <副本>   # 5 路径 / 个体拒绝 / 多解 / 反向控制 / 量纲门
node scripts/roco/verify-03.3-gap1.mjs <副本>        # 白名单按组结构
# 变异：E:\roco-scratch\vfy-033-mutate.sh {gap1A|gap1B|wrongexclude|wrongexclude2|restore}
# 引擎侧：wsl … PYTHONPATH=src python3 E:\roco-scratch\vfy-033-replay2.py
```
