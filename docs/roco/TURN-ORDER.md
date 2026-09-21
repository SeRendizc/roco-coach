# 回合顺序与回合末登记表（RC-103）

> 一句话：**回合顺序**（谁先动、回合末按什么顺序结算）现在有一份**逐字段带证据的登记表**
> （`data/roco/rulesets/*.json` 的 `turn_order`），而且引擎**真的按它跑**：
> 配置说「不知道」时引擎**抛错**，不会用一个看起来合理的默认值把事情糊过去。
>
> **随机数决定同速平手是工程权宜（如实登记为 `ENGINE_HYPOTHESIS`），不是游戏规则。**

覆盖面：`turn_order.action_order` / `turn_order.speed_tie` / `turn_order.end_turn.order` /
`turn_order.end_turn.unknown_stages_allowed`。
能量那三件套仍见 `docs/roco/RULE-CONFIG.md`（RC-101），候选判决见 `docs/roco/RULE-PROMOTION.md`（RC-102）。

## 1. 登记表怎么读

每个字段都是一条**字段记录**，不是裸值：

| 键 | 含义 | 缺失/写错会怎样 |
| --- | --- | --- |
| `value` | 值本身。`null` = 不知道 | 必填字段缺了就 `RuleConfigError`（fail closed） |
| `confidence` | 这个值有多可信（见下面 6 级） | 不在这 6 级里就判红 |
| `evidence_id` | 台账条目 id（`data/roco/evidence/rule-evidence-ledger.json`） | 写了一个不存在的 id 就判红 |
| `evidence_role` | 该条目对**这个值**是 `supports` 还是 `refutes` | 有 id 却不写角色、或角色与台账置信等级不符，判红 |
| `reason` | 为什么是这个值 / 为什么没有引用 | 没有 `evidence_id` 时**必填** |
| `microcase_id` + `microcase_status` | 这个值卡在哪条待录的实机 case 上（`NOT_RECORDED` = 还没录） | 引用了「待验」台账条目却不写 case，判红 |
| `value_status` | `CANDIDATE_HYPOTHESIS` = 值只是候选假设，**没被验证过** | 引用了待验条目却带具体值、又不标这一项，判红 |

置信等级（从强到弱）：`OFFICIAL_CURRENT` → `RECORDED_IN_GAME` → `COMMUNITY_CURRENT` →
`CROSS_SOURCE_SUPPORTED` → `ENGINE_HYPOTHESIS` → `UNKNOWN`。

**「不知道」不许写成默认值。** 一个字段要么有台账支撑，要么明写 `null` + `reason` +
待录 case；`UNKNOWN` 的字段带一个「看起来合理」的数会被校验器直接判红。

## 2. 两份配置的 `turn_order`

### `legacy_sim_v1`（默认，逐位冻结的引擎快照）

| 字段 | 值 | confidence | evidence_id | microcase | 它到底在说什么 |
| --- | --- | --- | --- | --- | --- |
| `action_order` | `["respond","priority","speed"]` | `ENGINE_HYPOTHESIS` | —（不借别人的 id） | —（严格总序待 MC-E05） | **如实描述引擎现在真的在做什么**：排序键 = (应对成功, 先手度, 速度, seed 随机) |
| `speed_tie` | `"random_seeded"` | `ENGINE_HYPOTHESIS` | — | `MC-E05` / `NOT_RECORDED` | 同速时用 seed 驱动的确定性随机裁决 —— **工程权宜，不是规则** |
| `end_turn.order` | `["status_tick","regen"]` | `ENGINE_HYPOTHESIS` | —（台账没有这一条） | `null`（没有对应的 case，不借 MC-E03 凑引用） | 每只在场精灵内部：先算这只的状态伤害，再算这只的回能 |
| `end_turn.unknown_stages_allowed` | `false` | `ENGINE_HYPOTHESIS` | — | — | **引擎纪律开关**：声明的阶段是穷尽的，出现未声明阶段必须抛错 |

### `mobile_s4_candidate_v2`（候选，未取证前不得作默认）

| 字段 | 值 | confidence | evidence_id | microcase | 它到底在说什么 |
| --- | --- | --- | --- | --- | --- |
| `action_order` | `["respond","switch","priority","speed"]` | `ENGINE_HYPOTHESIS` | `EV-TURN-ORDER-STRICT`（supports） | `MC-E05` / `NOT_RECORDED` | 社区口径「应对 > 换宠 > 先手 > 速度」；**严格总序没有同等强度官方文字**，所以标 `CANDIDATE_HYPOTHESIS` |
| `speed_tie` | **`null`** | `UNKNOWN` | — | `MC-E05` / `NOT_RECORDED` | 同速平手判据 UNKNOWN：引擎会**抛错**，不许用随机数假装知道规则 |
| `end_turn.order` | `["status_tick","regen"]` | `ENGINE_HYPOTHESIS` | —（台账没有这一条） | `null`（`unknowns` 里指向 MC-E03，但那条只回答「有没有默认回能」，不是顺序判据） | 候选沿用 legacy 的组内顺序，只是**有界占位** |
| `end_turn.unknown_stages_allowed` | `false` | `ENGINE_HYPOTHESIS` | — | — | 候选**不允许**用它放宽任何未知阶段 |

### 两份的差别

```text
action_order                      ["respond","priority","speed"]  →  ["respond","switch","priority","speed"]
speed_tie                         "random_seeded"（如实登记）      →  null（UNKNOWN → 引擎抛错）
end_turn.order                    相同（都是 ENGINE_HYPOTHESIS + 有界占位）
end_turn.unknown_stages_allowed   相同（都是 false）
```

注意 `action_order` 的差别**不是**「候选更对」：candidate 声明的是**社区口径的总序**，
而引擎目前只实现 legacy 那一条（把换宠/道具折算成固定先手度）。这个差距是**如实登记的差距**，
不是已经实现的功能，详见第 4 节。

## 3. fail closed 在哪几处

配置层（`roco/src/roco_env/rule_config.py`，加载期就炸，不拖到对局中途）：

1. 缺 `turn_order.action_order` / `speed_tie` / `end_turn.order` / `end_turn.unknown_stages_allowed`
   → `RuleConfigError`（`REQUIRED_PATHS`）；
2. 顺序列表不是「非空 + 元素是非空字符串 + 不重复」→ `RuleConfigError`；
3. `speed_tie` 不是 `null` 或 `"random_seeded"`（例如自造的 `"speed_first"`）→ `RuleConfigError`；
4. `end_turn.unknown_stages_allowed=true` → `RuleConfigError`（放行未知阶段与 fail closed 冲突）。

引擎层（`roco/src/roco_env/env.py`，运行期 `fx.UnsupportedEffect`，消息里点名**阶段/维度名 + 配置 id**）：

| 在哪 | 触发条件 | 抛什么 |
| --- | --- | --- |
| `require_declared_end_turn_stages()`（`_end_of_turn` 入口） | 配置声明了引擎**没实现**的阶段（例：`weather_tick`） | `未支持的机制：回合末阶段「weather_tick」（规则配置 legacy_sim_v1 …）` |
| 同上 | 引擎**需要结算**的阶段没被声明（例：少了 `regen`） | `未支持的机制：回合末阶段「regen」（…没有声明它，但引擎需要结算这个阶段…）` |
| 同上 | `unknown_stages_allowed=true`（绕过加载期时兜底） | `未支持的机制：回合末未声明阶段放行(unknown_stages_allowed)（…）` |
| `require_declared_action_order()` | 声明了引擎不认识的排序维度（例：`weather`） | `未支持的机制：行动排序维度「weather」（…）` |
| `order_actions()` | `speed_tie` 是 UNKNOWN（`null`）**且本回合真的出现平手** | `未支持的机制：速度平手裁决(speed_tie)（…是 UNKNOWN（待录 microcase MC-E05）…不许用随机数假装知道规则）` |

关键细节：**平手策略只在排序真的需要它时才抛**。没有平手的回合在 UNKNOWN 配置下照样能排
（`_tie_is_decisive` 只看排序键前三维是否完全相同）——否则「不知道就抛」会退化成「一律抛」，
那就不是在诚实报告，而是在拒绝服务。

回合末的顺序作用域是**每一只在场精灵内部**：先算这只的状态伤害，再算这只的回能
（配置声明为 `["status_tick","regen"]` 就是这个意思）。它**不是**「全体先状态伤害、再全体回能」——
后者会改变日志与事件顺序，也就是改掉默认行为。

## 4. 引擎实现 vs 配置声明（一致性检查）

`reports/roco/flagship-upgrade/rc-103-turn-order.json` 的 `engine_vs_config_consistency` 是逐条判据，
`registered_gaps` 是「已登记但还没实现的差距」。当前结果：

| 判据 | legacy | candidate |
| --- | --- | --- |
| 声明的排序维度名引擎都认识 | ✔ | ✔ |
| 每个声明的维度都是**独立比较维** | ✔ | ✖ **已登记差距**：`switch` 被折算成固定先手度（`SWITCH_PRIORITY=5`，假设，MC-005），引擎没有第四维 |
| 回合末声明的阶段与引擎实现双向覆盖 | ✔ | ✔ |
| `unknown_stages_allowed=false` | ✔ | ✔ |

## 5. legacy 逐位不变

改动引擎默认路径是大忌，所以「改完还一样」必须是**会变红的判据**，不是一句承诺：

* `roco/tests/test_turn_order_fail_closed.py::LegacyBitExactGoldenTest` 拿改动前抓下来的
  sha256 指纹（6 局固定 seed 的整局 + 1 段固定动作序列，状态与事件序列各一份）比对当前引擎；
* 生成器 `scripts/roco/build-rule-configs.mjs` 里的 `LEGACY_TURN_ORDER_BIT_EXACT` 把 legacy 的
  `turn_order` 声明冻结成判据 —— 坏值**落不了盘**（不只是测试会红，是根本写不进去）；
* 既有 275 条 env 测试仍是回归网，RC-103 之后 `python3 -m unittest discover -s tests` 是
  295 条（275 + 20 条新用例）全过。

## 6. 还缺哪些 microcase

| 问题 | 待录 case | 通过判据（`data/roco/evidence/rule-evidence-microcase-records.json` 原文摘要） |
| --- | --- | --- |
| 应对 / 先手 / 换人 / 速度的**严格总序** | `MC-E05`（计划 case `MC-004`） | 四段录像（应对 vs 先手+1、换人 vs 先手+1、先手+1 vs 高速、同速）各指出谁先动；四段互不矛盾时严格总序成立 |
| **同速平手**到底有没有确定性规则 | `MC-E05`（同上，第四段录像） | 同速那段「先手方是否固定」：多次录像总是同一侧先动 → 存在确定性规则；随机 → **仍属 UNKNOWN，不得写成规则** |
| 回合末是否存在**默认自然回能** | `MC-E03`（计划 case `MC-007`） | 无特性组每回合末读数是否变化；变化量就是回能值（与特性回能区分） |
| 回合末的**阶段顺序**（状态伤害 vs 回能谁先） | **没有**已登记的 case | 台账没有这一条；`MC-E03` 只回答「有没有回能」。想关掉这个 `ENGINE_HYPOTHESIS` 得先登记一条能回答顺序的 case |
| 主动换宠 / 道具的**先手度具体值**（5 / 4） | `MC-005` | 数据未定义，引擎里是假设值 |

`MC-E05` 录完之前，`action_order`（candidate 口径）与 `speed_tie` 都**不得**被当作已验证规则，
也不得据此对外解释「为什么这样排」（台账 `EV-TURN-ORDER-STRICT` 的原话）。

## 7. 一句话说清「随机数」

> **同速平手用 seed 驱动的随机数裁决，是我们的工程权宜：它让对局可复现，但它没有任何一手证据。
> 登记表把它写成 `ENGINE_HYPOTHESIS` 的 `"random_seeded"`，就是为了让人一眼看出
> 「这是实现，不是规则」；换成 `null`（UNKNOWN）时引擎宁可抛错，也不拿随机数冒充规则。**

## 8. 怎么复跑

```bash
# 1. 配置生成与校验（唯一写入方；台账一改就必须重新生成）
node scripts/roco/build-rule-configs.mjs --check

# 2. 引擎与登记表的判据（含必红反证与 golden 逐位指纹）
cd roco; PYTHONPATH=src python3 -m unittest discover -s tests; cd ..
npm run test:env

# 3. 证据台账校验
node scripts/roco/verify-evidence-ledger.mjs

# 4. RC-103 报告（退出码 = 四条自检是否全过）
PYTHONPATH=roco/src python3 scripts/roco/report-rc103-turn-order.py
```

报告里的 `fail_closed_triggers` 是**实际触发记录**（用哪份配置、抛了什么原文），
不是「按代码应该会抛」的描述。
