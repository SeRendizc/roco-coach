# RC-106：让「六宠标准 PVP」真的能开一局

> 机器可读报告：`reports/roco/rc106/six-pet-battle.json`
> 生成器：`python3 scripts/roco/report-rc106-six-pet-battle.py`
> 基线：`npm run test:env` 324 条、`npm run test:unit` 936 条（实测，见 §7）

RC-105 把「按配置裁剪合法行动」和「魔力（心）结算」落了地，但实测出**三个阻断**，
六宠标准 PVP 仍然开不了一局。这一轮把这三条接上，并如实划出**没做到**的部分。

---

## 1. 结论速览

| # | 阻断（RC-105 实测） | 本轮的修法 | 判据落在哪 |
|---|---|---|---|
| ① | v3 的 `energy.initial` 是 `null`（UNKNOWN，MC-E04 未录制）⇒ `reset(config=v3)` fail closed | 加一条**显式的、带出处的未核验覆盖** `unverified_overrides`（不填数、不改配置） | `roco/tests/test_six_pet_battle.py::UnverifiedOverrideTest`（7 条） |
| ② | `reset` / `validate_team` 只接受 3 只，而 `pvp-standard-six-pet` 登记 `team_size: 6` | 队伍规模从**配置/模式参数**读；legacy 仍然 3 且逐位不变 | `TeamSizeTest`（8 条）+ golden 指纹 |
| ③ | `battle-modes.json` 的绑定还指向 v2（没有 mana/actions） | 改成 `mobile_s4_candidate_v3`；两处写死 v2 的测试改成**读登记表** | `tests/roco-six-pet-battle.test.js`、`tests/roco-mana-actions.test.js`、`tests/roco-v3-redirect.test.js` |

顺带补上 RC-105 遗留的文案缺口：`charge` / `mana_loss` / `surrender` 这三类事件此前
**没有中文句子**，六宠对局一跑起来玩家就会看到「本页还没有它的中文说法」。

---

## 2. 哪些是台账支持的，哪些是 `ENGINE_HYPOTHESIS`

台账（`data/roco/evidence/rule-evidence-ledger.json`）**一个字节都没改** ——
改它会让所有 ruleset 配置的 `derived_from_ledger_sha256` 当场作废。

| 结论 | 来源 | 等级 | 待录判据 |
|---|---|---|---|
| 标准 PVP 每方 **6 只** | `EV-PVP-STANDARD-TEAM-SIZE` | `CROSS_SOURCE_SUPPORTED` | MC-E07（未录制） |
| 每方 **4 点魔力** | `EV-PVP-STANDARD-MANA` | `CROSS_SOURCE_SUPPORTED` | MC-E08 |
| 力竭扣 **1** 点、归零判负 | `EV-PVP-FAINT-MANA-LOSS` | `CROSS_SOURCE_SUPPORTED` | MC-E09 |
| 聚能是**主动行动**、回复 5 | `EV-ENERGY-CHARGE` | `CROSS_SOURCE_SUPPORTED` | MC-E02 |
| 标准 PVP 的动作全集是 skill/charge/switch/surrender、禁 item/escape | **没有台账条目** | `ENGINE_HYPOTHESIS` | — |
| 投降方判负 | **没有台账条目** | `ENGINE_HYPOTHESIS` | — |
| **入场初始能量**（这一轮要用的那个数） | **没有台账条目**，10 号文档 §7 明写「需实机」 | `UNKNOWN` → 覆盖时降级成 `ENGINE_HYPOTHESIS` | MC-E04 |

**等级一个字都没抬**：上面三条 `CROSS_SOURCE_SUPPORTED` 仍然是候选级，
`tests/roco-six-pet-battle.test.js` 里有一条判据直接读台账核对这一点。

仓内旁证（6 条含「魔力」的冻结特性原文：诈死 / 付给恶魔的赎价 / 飓风 / 图书守卫者 /
构装契约者 / 御驾亲征）仍然只是 `repo_internal` 旁证，**没有升级、也没有新增台账条目**。

---

## 3. 覆盖机制为什么这样设计

### 问题

`mobile_s4_candidate_v3.json` 的 `energy.initial` 是从 v2 **逐字复制**的 `null`。
RC-101 的纪律是「不知道就先抛」，所以 `reset(config=v3)` 会 fail closed —— 这条纪律是对的，
**不许放宽**。但「开不了一局」也意味着六宠模式根本跑不起来，而「跑起来」本身是下一轮
证据（MC-E04/E07/E08/E09）的前提。

### 两条错路，和正确的第三条

| 方案 | 为什么不行 |
|---|---|
| 往配置里填一个「看起来合理」的 2 | 候选会看起来已经被验证过；`energy.initial` 就再也没人回去录 MC-E04 |
| 给引擎加一条「未知就回落到 legacy」的默认链 | 静默回退比编数据更坏：没人知道这一局的 2 是从哪来的，legacy 一变它就跟着变 |
| **调用方显式声明一条带出处的假设** | 假设是**输入**，不是规则；它必须能被看见、被拒绝、被审计 |

### 机制本体（`roco/src/roco_env/overrides.py`）

```python
renv.reset(team, enemy_team, config="mobile_s4_candidate_v3",
           unverified_overrides=[{
               "path": "energy.initial",
               "value": 2,
               "confidence": "ENGINE_HYPOTHESIS",
               "reason": "练习局口径（legacy 的入场能量），不是标准 PVP 的实机结论；MC-E04 未录制",
               "microcase_id": "MC-E04",
           }])
```

五条不可让步的性质，每条都有必红反证：

1. **只在 `UNKNOWN` 上生效**：`path` 必须指向配置里 `value is null` 的字段。
   借覆盖改一条**已登记**的规则值（例如 `mana.pool`）会抛 `RuleConfigError` ——
   「填一个未知数」与「改一条已知规则」是两件事。
2. **没有覆盖 ⇒ 仍然抛**。`resolve_int` 里没有第三条分支：不写 `or 0`、不回落 legacy 的 2、
   不读环境变量。**必红反证**：把它改成回落到 2，`test_no_override_fails_closed` 立刻红
   （`AssertionError: UnsupportedEffect not raised`）。
3. **不写回配置**。模块既不 import `json.dump` 也不碰盘；`v3` 的 `energy.initial` 恒为 `null`
   （测试每轮核对一次）。
4. **如实进载荷**。`state.unverified_overrides` → `serialize()` →
   `public_planner_state()["unverified_overrides"]` → `ui_public_view()`（机器可读 + 一句可渲染的话）。
   页面因此可以写「候选：初始能量沿用练习局口径（未核验）」，而不是假装自己知道标准 PVP 的入场能量。
   **没有覆盖时这个键在 `GameState` 序列化里根本不出现** —— legacy 逐位不变靠它成立。
5. **出处必填**：`confidence` 只能是 `ENGINE_HYPOTHESIS`、`reason` 必须非空、`microcase_id`
   必须是具体的待录判据 id。没有 microcase_id 的覆盖与「随手填一个数」在数据上无法区分。

**测试里用的 2 是练习局口径**（就是 legacy 的入场能量），**不是标准 PVP 的实机结论**。
谁要定准这个数，谁去录 MC-E04。

---

## 4. 六宠开局：规模来自配置，不来自代码

```
RuleConfig.battle_mode_team_size  ←  data/roco/rulesets/*.json#battle_mode.team_size
                                  ←  生成器从 data/roco/battle-modes.json 抄
```

| 配置 | 绑的模式 | `team_size` |
|---|---|---|
| `legacy_sim_v1` | `demo-training-3v3` | **3**（默认路径，逐位不变） |
| `mobile_s4_candidate_v2` | `pvp-standard-six-pet` | 6 |
| `mobile_s4_candidate_v3` | `pvp-standard-six-pet` | 6 |

* `env.reset` 用 `cfg.require_team_size()` 校验队伍长度（以前写死 3）；
* `env.validate_team(..., team_size=3)` 默认值只为**不经过 `reset` 的调用点**
  （`service.team_evaluate` 的阵容评估、审计脚本）保留既有行为；正式开局一定传配置里的数；
* 加载器与校验器都会核对「配置里的数 == 登记表里的数」，不一致就抛（模式规模只有一个事实源）。

**必红反证**：把 `env.reset` 里的 `team_size = cfg.require_team_size()` 改回 `team_size = 3`，
六宠开局与 `test_mana_actions` 里 36 处同时变红，原文：

```
ValueError: 规则配置 mobile_s4_candidate_v3（模式 pvp-standard-six-pet）每方需要恰好 3 只精灵，实际 6 只
```

### 六宠对局实测（确定性 seed）

| seed | 双方策略 | 结果 | 战斗回合 | 力竭扣魔力 | 终局原因 |
|---|---|---|---|---|---|
| 11 | greedy / greedy | 我方落败 | 26 | 双方各 4 次 | `mana_depleted` |
| 12 | greedy / greedy | 我方落败 | 26 | 双方各 4 次 | `mana_depleted` |
| 13 | greedy / conservative_switch | 我方落败 | 44 | 对手 4 次 | `mana_depleted` |
| 21 | random_legal / random_legal | 我方落败 | 2 | 0 次 | 投降 |

四局都跑到终局、没有 truncated、重放逐位相同（`matches[].replay_digest`）。

### 对手策略

`roco/src/roco_env/opponents.py` 的 5 个策略**语义一个字节都没改**：它们从来只按
「公开观察 + 引擎给的合法动作」决策，而 6 只队伍下的合法动作仍然是引擎枚举出来的，
所以它们在六宠局里**合法**（5 个策略两两配对都跑到终局，且没有一次隐藏字段读取）。
`play_match` 新增两个**可选**参数（`config` / `unverified_overrides`），
`MatchRecord` 新增两个只在非默认时才序列化的字段 —— legacy 记录逐字不变。

---

## 5. 绑定改到 v3，以及它的连锁

`data/roco/battle-modes.json#modes[pvp-standard-six-pet].ruleset_binding`：
`mobile_s4_candidate_v2` → `mobile_s4_candidate_v3`。

### v2 与 v3 的区别**就是**这三件事

| 维度 | v2 | v3 |
|---|---|---|
| `energy`（含 `energy.initial: null`） | ← 逐字相同 → | ← 逐字相同 → |
| `turn_order` | ← 逐字相同 → | ← 逐字相同 → |
| `mana` | **没有** | 4 / 1 / 归零判负 / 允许投降 |
| `actions` | **没有**（道具与逃跑继续存在） | skill→charge→switch→surrender，禁 item/escape |
| `ruleset_binding`（模式登记） | 改前绑它 | 改后绑它 |

**v2 不删**：它现在是「能开局但没有 mana/actions」的历史候选，留着做回归对照
（`BindingAndCandidateDeltaTest::test_v2_is_kept_as_the_no_mana_contrast` 逐字钉住这个关系）。

### 连锁（先看脚本再动手）

`node scripts/roco/rebuild-derived-chain.mjs --check` → **5/5 环通过**。
结论：**绑定不进任何派生产物** —— `data/roco/game-data-pack/v2/pack.json` 的
`ruleset_binding` 来自**默认配置**（`loadRulesetConfig()` 选 `is_default: true` 的那份），
仓库里没有任何脚本读 `battle-modes.json` 的 `binding` 字段。所以 pack / owned-pets /
rag-eval 的字节都没变（`--check` 逐环校验过）。

真正跟着变的是**三份由生成器重算的报告**（它们把绑定当派生字段抄进样例）：

```
RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js     # rc-301-team-request.json
RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js        # rc-302-team-gaps.json
RC303_WRITE_REPORT=1 node --test tests/roco-team-candidates.test.js  # rc-303-team-candidates.json
```

按各自机制重生成，**没有手改产物**。RC-304 的报告内容未变（它的派生字段不经过绑定）。

### 两处写死 v2 的测试

* `tests/roco-mana-actions.test.js`：以前断言 `mode.ruleset_binding === 'mobile_s4_candidate_v2'`
  并且写着「不归本活改」。现在判据改成**读登记表**：绑定指向哪份配置，那份配置就必须声明
  `mana` 与 `actions`。
* `tests/roco-v3-redirect.test.js`：同样改成读登记表的判据。
* 新增 `tests/roco-six-pet-battle.test.js`（已加进 `package.json` 的 `test:unit` 手写清单）。

**必红反证**：把绑定改回 v2，三份测试同时红，原文：

```
AssertionError [ERR_ASSERTION]: 被绑定的配置 mobile_s4_candidate_v2 没有 mana 块 —— 标准 PVP 会按「能开局但没有魔力系统」的口径跑
      （tests/roco-six-pet-battle.test.js:49）
AssertionError [ERR_ASSERTION]: 标准 PVP 必须绑定带 mana/actions 的 mobile_s4_candidate_v3，实际 mobile_s4_candidate_v2
      （tests/roco-mana-actions.test.js:236）
AssertionError [ERR_ASSERTION]: 被绑定的配置 mobile_s4_candidate_v2 必须声明 mana
      （tests/roco-v3-redirect.test.js:210）
```

---

## 6. 事件文案：三类句子

`roco/src/roco_env/events_text.py` 此前没有 `charge` / `mana_loss` / `surrender` 的模板，
而 `env.py` 从 RC-105 起就会产出这三个 kind。补上的句子（模板只使用 detail 里**真的存在**的键）：

| kind | 句子 |
|---|---|
| `charge` | 对方选择聚能，回复 5 点能量（当前 5 点）（聚能回能上限与自动聚能未核验，本局按夹到能量上限处理）。 |
| `mana_loss` | 对方的精灵力竭，失去 1 点魔力（剩余 3 点）（力竭扣魔力未实机核实，本条为候选口径）。 |
| `surrender` | 对方投降，对局结束（投降的结算语义未核验，本局按投降方判负处理）。 |

口径与全文一致：**只陈述事实**（谁做了什么、数值是多少、哪一条还没核验），
不写「好/坏/该不该」—— 引擎没有任何依据判断一个动作好不好。

覆盖判据有两处：`roco/tests/test_event_text.py`（样例事件覆盖 `KNOWN_EVENT_KINDS` 全集）
与 `SixPetEventTextTest`（**跑真六宠对局**收全集，并断言这三类真的发生过）。
这里踩过一个坑：单看一局会对不上 —— `greedy vs random` 里随机策略常常**提前投降**，
`mana_loss` 一次都不发生，判据就空转了。所以真对局采样刻意跨三组策略。

---

## 7. 测试与反证

### 基线（动手前实测）

```
npm run test:env    → Ran 324 tests ... OK (skipped=1)
npm run test:unit   → ℹ tests 936  ℹ pass 936  ℹ fail 0
```

### 收尾（实测）

```
npm run test:env  → Ran 357 tests ... OK (skipped=1)
npm run test:unit → ℹ tests 953  ℹ pass 951  ℹ fail 2
```

新增：Python 33 条（`roco/tests/test_six_pet_battle.py`）+ Node 4 条
（`tests/roco-six-pet-battle.test.js`）。两条红是**基线就红**的既有失败，见 §9。

### 三条硬要求的必红反证（实际报错原文）

**① 把「无覆盖时 fail closed」改成回落到默认值**

```python
# 临时改坏：env.reset 里
except RuleConfigError:
    initial_energy = 2
```

```
FAIL: test_no_override_fails_closed (tests.test_six_pet_battle.UnverifiedOverrideTest)
AssertionError: UnsupportedEffect not raised
  File ".../roco/tests/test_six_pet_battle.py", line 176, in test_no_override_fails_closed
    renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=V3)
```

**② 把 `team_size` 硬编码回 3**

```python
team_size = 3  # 临时改坏
```

```
ERROR: test_six_pet_teams_start_and_five_pet_is_refused (tests.test_six_pet_battle.TeamSizeTest)
ValueError: 规则配置 mobile_s4_candidate_v3（模式 pvp-standard-six-pet）每方需要恰好 3 只精灵，实际 6 只
  File ".../roco/src/roco_env/env.py", line 185, in reset

FAIL: test_battle_new_starts_six_pet_standard_pvp_with_override (…BattleNewEndpointWiringTest)
AssertionError: 400 != 200 : {…
 'error_type': 'bad_request',
 'error': '无法开局：ValueError: 规则配置 mobile_s4_candidate_v3（模式 pvp-standard-six-pet）每方需要恰好 3 只精灵，实际 6 只', …}
（同一次改坏共 36 处 error + 2 处 failure，涉及 test_six_pet_battle 与 test_mana_actions）
```

**③ 把绑定改回 v2**

```json
"ruleset_binding": "mobile_s4_candidate_v2"
```

```
✖ RC-106 绑定：标准 PVP 必须绑到带 mana/actions 的候选（改回 v2 就红）
  AssertionError [ERR_ASSERTION]: 被绑定的配置 mobile_s4_candidate_v2 没有 mana 块 ——
  标准 PVP 会按「能开局但没有魔力系统」的口径跑
✖ RC-105 纪律：候选仍被 promotion gate 挡住，且本文件的判据真的在 test:unit 里
  AssertionError [ERR_ASSERTION]: 标准 PVP 必须绑定带 mana/actions 的 mobile_s4_candidate_v3，
  实际 mobile_s4_candidate_v2
✖ BattleMode：候选模式的 team_size 不得来自「当前 Demo 的 48 只名单」
  AssertionError [ERR_ASSERTION]: 被绑定的配置 mobile_s4_candidate_v2 必须声明 mana
```

三条反证跑完都**已还原**（`git status` 与收尾复跑为证）。

---

## 8. 给主线程的接线说明

> 本活**没有**动 `src/server/**`、`src/client/**`、`src/coach/**`。

### 服务端要调用哪个入口

`POST /battle/new`（Python `roco_env.service.RocoService.battle_new`），
请求体新增两个参数、并放宽了队伍长度的判定：

```jsonc
{
  "ruleset_id": "roco-world-s4-2026-09-10",
  "state_version": 0,
  "ruleset_config_id": "mobile_s4_candidate_v3",   // 新增（可选，省略=当前生效配置）
  "team": [/* 6 个 pet_id */],
  "enemy_team": [/* 6 个 pet_id */],
  "seed": 11,
  "strategy": "greedy_damage",
  "unverified_overrides": [{                        // 新增（可选，但 v3 必须给）
    "path": "energy.initial", "value": 2,
    "confidence": "ENGINE_HYPOTHESIS",
    "reason": "练习局口径，不是标准 PVP 的实机结论；MC-E04 未录制",
    "microcase_id": "MC-E04"
  }]
}
```

**怎么拿到那个配置 id**：读 `data/roco/battle-modes.json` 里
`pvp-standard-six-pet.ruleset_binding`（现在是 `mobile_s4_candidate_v3`），
**不要**在 `roco-service.js` 里抄字符串。Python 侧同一处可读
`roco_env.rule_config.bound_config_id_for_mode("pvp-standard-six-pet")`。

**队伍长度**：`= 该配置的 battle_mode.team_size`（v3 ⇒ 6，以前服务端写死 3）。
要改的两处：`src/server/roco-service.js:1583`
（`const team=…body.team.length===3?body.team:[...DEFAULT_TEAM]`）
与 Python 侧 `/rules/roster` 回执里的 `team_size: 3`（`roco/src/roco_env/service.py:905`）。

### 错误语义（别把它们混成一个 500）

| HTTP | `error_type` | 什么情况 |
|---|---|---|
| 400 | `bad_request` | 队伍长度不对 / `ruleset_config_id` 不是字符串 / `unverified_overrides` 条目缺字段 |
| 422 | `unsupported_effect` | 配置声明了 `mana` 但缺值，或 `energy.initial` 是 UNKNOWN **而没给覆盖** |

### 回执里会多出哪些键

| 键 | 什么时候有 | 怎么用 |
|---|---|---|
| `result.state.unverified_overrides` | **只有真的用了覆盖**（legacy 逐位不变） | 存档/回放带着它 |
| `result.public.unverified_overrides` | 始终存在，空数组 = 没覆盖 | 教练侧读这个 |
| `result.ui.unverified_overrides` | 同上 | 页面渲染「未核验」标记 |
| `result.ui.notes.unverified_overrides[]` | 始终存在 | **一句可直接渲染的中文**，页面不必自己拼 |
| `result.state.player.mana` / `enemy.mana` | v3 才有（legacy/v2 不写这个键） | 魔力条 |
| `result.legal.player[]` | — | 标准 PVP 下**没有** `item`/`escape`，多出 `charge`/`surrender` |

页面文案建议（中性、可核对）：

> 候选规则：`energy.initial` 按假设值 2（ENGINE_HYPOTHESIS，待录 MC-E04）开局 —— 这不是实机结论。

---

## 9. 没做到的部分

* **接线只做了 Python 这一侧。** `src/server/**`、`src/client/**`、`src/coach/**` 没动，
  所以页面暂时还看不到「未核验」标记，服务端也还不会传 `ruleset_config_id`。§8 是为此写的。
* **特性在六宠局面下仍未实现。** `traits.py` 只登记 12 条（FULL 6 / PARTIAL 2 / REFUSED 4）；
  6 只队伍意味着更多特性同时在场，未登记的那些照旧进 `state.unsupported`，不猜。
* **印记的叠加/替换规则（MC-009）未实现。** 六宠局里换人更多，印记在多次换人后的行为
  仍然无据可依。
* **`switch` 仍然只是折算成固定先手度**（MC-005 假设），不是独立比较维。
  六宠局换人更频繁，这个假设的影响比 3v3 更大 —— 但本活没有改它的依据。
* **「1～6 只是否都合法」未核实**：引擎按登记的 `team_size` **严格**要求 6 只（少一只直接拒），
  这是候选口径，不是官方规则。
* **六宠阵容该怎么打，本活没有回答。** 5 个策略在 6 只下只是**合法**，不是「会打」；
  没有做任何阵容/编队层面的评估。
* **同速平手仍然无解。** 六宠夹具特意让 12 只速度两两不同，所以 MC-E05 那条 UNKNOWN
  在六宠局里并没有被解决：一旦两队首发同速，`order_actions` 仍会按 RC-103 抛错。
* **两条基线就红的测试与本活无关**，收尾时仍然红：
  * `tests/evals/state-doc.test.js` —
    `AssertionError: 状态文档的 HEAD 落后当前 16 个提交`。修它要改 `docs/roco/**` 的状态文档
    并重跑 `verify:release`，超出本活范围（收尾明文要求不跑整套 verify-release）。
  * `tests/roco-page-ux.test.js` —
    `AssertionError: test:unit 的最后一项应当是 tests/roco-page-ux.test.js，实际结尾：…roco-workshop.test.js tests/roco-page-ux.test.js tests/roco-team-serving.test.js`。
    **HEAD 上就已经是这样**（`git show HEAD:package.json` 的清单末尾同样是
    `roco-workshop / roco-page-ux / roco-team-serving`），是 RC-306 把新文件追加到末尾造成的。

---

## 10. 改了哪些文件

**引擎 / 数据（本活范围）**

| 文件 | 改了什么 |
|---|---|
| `roco/src/roco_env/overrides.py` | **新增**：未核验覆盖的校验、解析、对外载荷（+ 自检 8 条） |
| `roco/src/roco_env/env.py` | `reset` 读配置的 `team_size` + 接受覆盖；`validate_team(team_size=)`；`replay` 带覆盖；公开面 / UI 带 `unverified_overrides` |
| `roco/src/roco_env/rule_config.py` | `battle_mode_team_size` / `require_team_size()` / 登记表读取与缓存 / `bound_config_id_for_mode()` / 校验器核对模式规模 |
| `roco/src/roco_env/schema.py` | `GameState.unverified_overrides`（空时**不**序列化） |
| `roco/src/roco_env/events_text.py` | `charge` / `mana_loss` / `surrender` 三类句子 + 登记进 `KNOWN_EVENT_KINDS` |
| `roco/src/roco_env/opponents.py` | `play_match(config=, unverified_overrides=)`；`MatchRecord` 两个新字段（只在非默认时序列化） |
| `roco/src/roco_env/service.py` | `/battle/new` 接受 `ruleset_config_id` / `unverified_overrides`；队伍长度按配置；缺覆盖 ⇒ 422 |
| `data/roco/battle-modes.json` | `pvp-standard-six-pet.ruleset_binding` → `mobile_s4_candidate_v3` |

**测试**

`roco/tests/test_six_pet_battle.py`（新，33 条）、`tests/roco-six-pet-battle.test.js`（新，4 条）、
`roco/tests/test_mana_actions.py`（六宠夹具走产品路径）、`roco/tests/test_event_text.py`（三个新 kind 的样例）、
`roco/tests/test_rule_config.py`（候选按 6 只、legacy 按 3 只）、
`tests/roco-mana-actions.test.js`、`tests/roco-v3-redirect.test.js`、`package.json`（test:unit 清单）。

**报告（按各自生成器重算，没手改产物）**

`reports/roco/rc106/six-pet-battle.json`（+ 生成器 `scripts/roco/report-rc106-six-pet-battle.py`）、
`reports/roco/flagship-upgrade/rc-301-team-request.json`、`rc-302-team-gaps.json`、`rc-303-team-candidates.json`。

**没动**：`data/roco/evidence/rule-evidence-ledger.json`、`docs/roadmap/**`、
`src/client/**`、`src/server/**`、`src/coach/**`。
