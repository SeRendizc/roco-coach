# BATCH-02 · B 段：全部已拥有实例的最小战斗冒烟（可玩 / 机制核验分开统计）

- 版本：HEAD `f30126a122d7438371cbd135c731247a3d9c8163`（工作区另有他人未提交改动，本批**不提交**）
- 时间：2026-09-29
- 规则集：`roco-world-s4-2026-09-10`　规则配置：`mobile_s4_candidate_v3`（标准 PVP 六宠，`pvp-standard-six-pet`）
- 范围：`data/roco/owned/owned-pets.json` 的全部 **542 实例 / 542 物种**
- 口径来源：《长线计划与监工规则》B 节 + 人类 2026-09-29 逐字
  「**每只的基础可玩与特殊机制/实机核验分开统计，不能只改标签宣布全可战斗**」
- 写域：只在 `scripts/roco/battle-smoke*`、`reports/roco/battle-smoke/**`、本文件、`docs/roco/review-2026-09-28/shots/battle/**`。
  **没有碰 `src/**`、`roco/**`、`data/**`、`tests/**`**，没有 `git add` / `git commit`。

---

## 1. 一句话结论

**基础可玩这一列现在是齐的**（引擎侧 542/542，HTTP 入口侧 542/542 一路打到结算，组合 12/12）；
**机制核验这一列远没有齐**：引擎侧实现状态 **FULL 8 / PARTIAL 3 / REFUSED 4 / 未登记 527**，
**实机核验 0/542**。两列分开，不许用①顶②。

另外闸到 **1 条用户可见的机制阻塞**（合法动作结算到一半变成非法 → 整局中断），
它记在②并配了自足复现；**没修**（写域外），报 Lead 决定。

---

## 2. ① 基础可玩

### 2.1 读数

| 量的是什么 | 读数 | 产物 |
| --- | --- | --- |
| 总实例数 | 542 | `data/roco/owned/owned-pets.json` |
| **引擎侧**：五步全过（选进队 → 合法六只 → 开局 → 出招/换人 → 结算） | **542/542** | `reports/roco/battle-smoke/engine-sweep.json` |
| 引擎侧：四个技能**全部**出过 | 536/542（其余 6 只缺 1 招，见 2.3） | 同上 |
| 引擎侧：主动换出 + 换入都做到 | 542/542 | 同上 |
| 引擎侧：受击 / 目标倒下 / 有结算 | 542 / 542 / 542 | 同上 |
| **HTTP 入口侧**：选进队（`GET /api/roco/box?detail=`） | **542/542** | `reports/roco/battle-smoke/entry-sweep.json` |
| 入口侧：合法六只 + 开局（`POST /api/roco/battle/new`） | **542/542** | 同上 |
| 入口侧：**配招随入口完整传递** | **542/542** | 同上 |
| 入口侧：打到结算（`POST /api/roco/battle/advance`） | **542/542** | 同上 |
| 组合：随机六只 ×10 + 玩家实际六只 + 形态/机制混合 | **12/12** | 同上 |

入口侧平均 24.9 回合结算（最短 6、最长 138）；结果分布 win 172 / loss 370。

### 2.2 「配招随战斗入口完整传递」是怎么判的（硬性要求 3）

对每一只单独组一队（这一只 + 5 只确定性补位），六只**每只都显式传四技能**，然后逐格比对：

1. `GET /api/roco/box?detail=own-XXXX` 的 `player.skills`（按 `order` 1→4，**详情页看到的那份**）；
2. 提交给 `POST /api/roco/battle/new` 的 `loadouts[species]`（Node 把 `own-XXXX` 换算成物种 id）；
3. 回执 `view.self.loadouts[species]`（**引擎这一局真正带上的那份**）。

判据：`view.loadout_origin` 六只**全是 `player`**，且六只的 `view.self.loadouts` 与提交的**逐位相同**，
且目标那一只**与详情页逐格同名**。542/542 全过。

「某技能跑不了 → 给准确原因 + 合法可运行替代」：本批里**没有**一只因为「学不到/不在技能表」被引擎拒
（`loadout_replaced = 0`），所以没有触发这条补救分支；四个技能里没出全的 6 只给的是**时序原因**：

| 实例 | 缺哪一招 | 准确原因 | 合法可运行的替代 |
| --- | --- | --- | --- |
| `own-0013` 阿米亚特 | 魔爪 `skill_000766`（能耗 0） | 这一局**被引擎列进过合法动作**，但目标在被量到之前倒下了 ⇒ 时序没轮到，**不是这一招跑不了** | 这一只的引擎规范配招（`rs.candidate_moveset`），与本配招交集 4/4 |
| `own-0015` 罗隐 | 魔爪 `skill_000766` | 同上 | 同上 |
| `own-0019` 地鼠 | 抓挠 `skill_000246` | 同上 | 同上 |
| `own-0217` 呼呼猪 | 彗星 `skill_000321` | 同上 | 同上 |
| `own-0218` 獠牙猪 | 彗星 `skill_000321` | 同上 | 同上 |
| `own-0434` 棋棋 | 气波 `skill_000673` | 同上 | 同上 |

### 2.3 组合测试（含不同系别 / 不同形态 / 特殊机制）

| 组 | 六只（实例 → 物种） | 结算 | 回合 |
| --- | --- | --- | --- |
| random-six-1 | own-0511→pet_000516、own-0119→pet_000119、own-0369→pet_000371、own-0199→pet_000200、own-0169→pet_000170、own-0188→pet_000189 | loss | 16 |
| random-six-2 | own-0527→pet_000549、own-0320→pet_000322、own-0370→pet_000372、own-0064→pet_000064、own-0267→pet_000268、own-0495→pet_000499 | loss | 30 |
| random-six-3 | own-0329→pet_000331、own-0525→pet_000547、own-0040→pet_000040、own-0510→pet_000515、own-0260→pet_000261、own-0025→pet_000025 | win | 18 |
| random-six-4 | own-0188→pet_000189、own-0206→pet_000207、own-0477→pet_000480、own-0531→pet_000553、own-0458→pet_000461、own-0307→pet_000309 | loss | 22 |
| random-six-5 | own-0255→pet_000256、own-0310→pet_000312、own-0501→pet_000505、own-0208→pet_000209、own-0450→pet_000453、own-0215→pet_000216 | win | 21 |
| random-six-6 | own-0221→pet_000222、own-0382→pet_000384、own-0364→pet_000366、own-0163→pet_000164、own-0127→pet_000127、own-0136→pet_000136 | loss | 29 |
| random-six-7 | own-0225→pet_000226、own-0127→pet_000127、own-0143→pet_000144、own-0276→pet_000278、own-0125→pet_000125、own-0256→pet_000257 | loss | 29 |
| random-six-8 | own-0408→pet_000411、own-0129→pet_000129、own-0250→pet_000251、own-0308→pet_000310、own-0179→pet_000180、own-0285→pet_000287 | loss | 40 |
| random-six-9 | own-0218→pet_000219、own-0473→pet_000476、own-0247→pet_000248、own-0490→pet_000494、own-0337→pet_000339、own-0485→pet_000489 | win | 27 |
| random-six-10 | own-0052→pet_000052、own-0368→pet_000370、own-0459→pet_000462、own-0362→pet_000364、own-0502→pet_000506、own-0409→pet_000412 | win | 30 |
| player-actual-six | own-0224→pet_000225（寂灭骨龙）、own-0189→pet_000190（海豹船长）、own-0442→pet_000445（黑猫巫师）、own-0006→pet_000006、own-0008→pet_000008、own-0019→pet_000019 | loss | 22 |
| form-and-mechanism-mix | own-0270→**pet_000271 千棘盔（水系/毒系）**、own-0376→**pet_000378 千棘盔**、own-0006、own-0008、own-0019、own-0032 | loss | 19 |

「**玩家实际六只**」的口径（本仓里能找到的、不凭空编）：演示服务登记的默认队伍
`DEFAULT_TEAM = [pet_000225, pet_000190, pet_000445]`（`src/server/roco-service.js`）
对应的三个实例 + 盒子里**前 3 只 `locked: true`** 的实例，凑满六只。这一条写在 `entry-sweep.json` 的
`combos[label=player-actual-six]` 里，可原样复核。

### 2.4 精确失败 ID / 失败步骤 / 失败原文

**引擎侧：0 条；入口侧（选进队/开局/配招传递）：0 条；入口侧结算：0 条。**

这一版（修完脚本策略之后）确实一条不剩。上一版有两条，两条的归因都写在这里，**没有藏**：

| 实例 | 上一版现象 | 归因 | 处置 |
| --- | --- | --- | --- |
| `own-0007` 魔力猫 | 打到脚本上限 300 手仍未结算 | **冒烟脚本自己的策略**：四个技能出完之后无条件 `?? charge` 一直聚能，目标场上那一只再也不出招 ⇒ 两边都打不完。**不是引擎不会打**（同一条队在引擎侧 `weak-enemy-switch-cycle` 场景 **28 回合**就打赢了）。 | 已修脚本：四招出完**继续出招**，还没出过的技能**贵的先出**。修后 542/542 结算。 |
| `own-0442` 黑猫巫师 | 第 14 手 `HTTP 400：UnsupportedEffect … 技能「绞轮」的有效能耗` | **引擎/产品侧**（合法动作结算到一半变成非法 → 整局中断）。 | **没修**（写域外），记进②并写了自足复现，报 Lead。 |

---

## 3. ② 特殊机制核验

**这一列与①无关。** 一只精灵可以「能开局、四招都出得来、打到结算」，而它的决定性特性在引擎里一行都没实现。

### 3.1 引擎实现状态（每只的**决定性特性**）

来源：`data/roco/engine-trait-status.json`（引擎侧实现状态；与数据侧 `skills.json` 的
`effect_support` 是两件事 —— 后者 824/824 全是 `unsupported`）。

| 状态 | 只数 | 含义 |
| --- | --- | --- |
| FULL | **8** | 按原语完整实现 |
| PARTIAL | **3** | 部分实现，仍有登记的缺口 |
| REFUSED | **4** | 明确拒绝并给了理由（依赖引擎做不到的前提） |
| 引擎未登记 | **527** | 这份产物里根本没有它 ⇒ 没实现 |

这 15 只的逐行明细（其余 527 只**未登记 ⇒ 没实现**）：

| 实例 | 精灵 | 特性 | 状态 |
| --- | --- | --- | --- |
| `own-0009` | 恶魔叮 | 渴求 | FULL |
| `own-0062` | 音速犬 | 专注力 | FULL |
| `own-0112` | 雪影娃娃 | 捉迷藏 | PARTIAL |
| `own-0124` | 化蝶 | 化茧 | REFUSED |
| `own-0189` | 海豹船长 | 身经百练 | FULL |
| `own-0224` | 寂灭骨龙 | 不朽 | REFUSED |
| `own-0414` | 圆号鱼 | 泛音列 | PARTIAL |
| `own-0442` | 黑猫巫师 | 预警 | PARTIAL |
| `own-0448` | 秩序鱿墨 | 绝对秩序 | REFUSED |
| `own-0471` | 画间沉铁兽 | 变形活画 | FULL |
| `own-0472` | 书魔虫 | 图书守卫者 | FULL |
| `own-0475` | 古卷匣魔像 | 构装契约者 | FULL |
| `own-0540` | 圣凯布米龙 | 热成像 | FULL |
| `own-0541` | 银月狼王 | 铭记于月亮 | REFUSED |
| `own-0542` | 月使鹭纳 | 冷光源 | FULL |

（完整原文含每条的 `hook` / `gaps` / `reason`，见 `battle-smoke-summary.json` 的
`column_2_mechanism.trait_rows`。）

**⇒ 引擎侧「决定性机制已实现」＝ 8/542（FULL）。**

### 3.2 实机核验

**0/542。** `data/roco/derived/pet-mechanisms.json` 里这 542 只的 `mechanism_status` **全部**是
`FROZEN_DESC`，每只都带两条 `unverified`：
「技能/特性效果未实机核验（MC-E08 等 microcase 未录制）」「desc 文字来自冻结导入，触发条件与时序未验证」。
本仓**没有任何一只**被标记成实机核验过 —— 所以这一列写 0，不写 542。

### 3.3 战斗中「引擎登记了未结算的效果」的证据（不是推测）

引擎遇到没实现的子效果**不静默**：它写进 `state.unsupported` 并发一条
`effects_registered_unsupported` 事件（中文句子 + 原始 JSON）。
逐只统计「这一只**自己出手**时出现的」：**295/542**。样例原文（`own-0001` 喵喵，技能 `skill_000246` 抓挠）：

> 我方的抓挠有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。

同一只在别处还留下过一条更长的登记（说明「哪些部分算了、哪些没算」是逐条写清楚的）：

> 技能「抓挠」的自带回能时序 —— 描述「自己回复1能量」机械可读，因此按 1 点结算；
> 但「技能回能 vs 回合末回能 vs 能量上限」的先后顺序无一手证据（MC-007），本引擎按「出手结算时立即回能」处理

这就是②要的口径：**它仍然结算了伤害，但那一条效果没被结算，引擎只是如实记账。**

### 3.4 阻塞性机制缺口：绞轮负能耗 → 整局中断（**用户可见**）

| 项 | 内容 |
| --- | --- |
| 技能 | `skill_000494` **「绞轮」**，基础能耗 5，持有者 `pet_000482` **溯源钟**（实例 `own-0479` / `own-0478` 不咕钟同族） |
| 描述原文 | 「造成物伤，每受到1次抵抗的技能攻击（不含连击），本技能能耗永久-1。」 |
| 触发条件 | 该技能 ramp 累到 **有效能耗 = 0**（此时它**仍在合法动作列表里**）；同一回合里**先出手的一方**用一次**属性抵抗**命中持有者，把 ramp 再 -1 ⇒ 轮到它结算时能耗 = 5+(-6) = **-1** |
| 引擎回执原文 | `UnsupportedEffect: 未支持的机制：技能「绞轮」的有效能耗（能耗修正把它压到 -1（基础 5）—— 负能耗的下限在术语里没有定义（MC-018），不猜一个 0，也不按负数回能）` |
| 出口 | 服务层兜底 `internal_error` → Node 报 **HTTP 400**；**重试必复现**（确定性） |
| 是「引擎没这条机制」吗 | **不是**。机制实现了一半：能耗永久-1 的累加是真的（`skill_ramps` 逐回合涨），降到 0 也照常出招；缺的是「被压到 0 以下怎么办」的依据（MC-018），引擎按纪律 fail closed、不猜 0 |
| 真正的缺陷 | **接口不自洽**：合法动作在结算中途变成非法，且以「未处理异常」把整局炸掉，而不是把这一手作废/改成聚能继续打 |
| 自足复现逐回合读数 | 第 1~6 回合 ramp = —/-1/-2/-3/-4/-5，有效能耗 = 5/4/3/2/1/**0**，**每一回合都被引擎列为合法**；第 6 回合结算到一半 → 异常 |
| 复现命令 | `python3 scripts/roco/battle-smoke-repro-negative-cost.py` |
| 产物 | `reports/roco/battle-smoke/negative-energy-cost-repro.json`（含逐回合 timeline 与 traceback） |
| 该改哪里 | `roco/src/roco_env/env.py`（`legal_actions` 与 `_execute` 的能耗口径要对齐）+ `service.py` 与 `src/server/roco-service.js` 的错误分类 |
| 风险面 | 描述里带「能耗永久±N」的技能共 **15 条**；已拥有实例里配招含这类技能的有 **61 只**；本次 542 局里**双方任一方带这类技能的 365 局**。本次实测炸掉 1 局（`own-0442` 那一局），自足复现可稳定打出 |

#### 3.4.1 task-5 修前 → 修后（逐回合对照）

| | 修前 | 修后 |
| --- | --- | --- |
| 第 1~6 回合 ramp / 有效能耗 | —/-1/-2/-3/-4/-5 → 5/4/3/2/1/**0**，**每一回合都在合法动作列表里** | 同左（合法表本来就是回合开始时算的） |
| 第 6 回合结算中途 | 我方先出手的属性抵抗命中 ⇒ ramp -6 ⇒ 结算时 5+(-6)=**-1** ⇒ `UnsupportedEffect` ⇒ 服务层 `internal_error` ⇒ Node **HTTP 400**，**重试必复现** | 同一位置被 `_cancel_unresolvable_skill` 拦下：这一手**不结算** + 如实登记 + 一条可结算事件 `对方这一手没有打出去（这一手的能耗解不出来（负能耗下限未定义，MC-018））`，事件里带 `{reason: energy_cost_unresolved, skill_id: skill_000494, base_energy: 5, effective_cost: -1, microcase_id: MC-018}` |
| 第 7 回合起 | （已经打不下去） | `legal_actions` **不再提供这一手**（`rampled_in_enemy_legal` 由 true 翻成 false）—— ① 的两处口径现在读同一个 `resolved_skill_cost` |
| 整局结果 | 第 6 回合**中断** | **打到结算**：37 回合、`loss`、**0 未处理异常**、4 条 `action_cancelled`（其中 1 条是负能耗，另 3 条是既有的「已倒下」） |

读数出处：`reports/roco/battle-smoke/negative-energy-cost-repro.json`（修后，`outcome: settled`）
与 `…-repro.before.json`（修前快照，`outcome: crash`，第 6 回合 `UnsupportedEffect`）。
复现命令：`python3 scripts/roco/battle-smoke-repro-negative-cost.py`。

#### 3.4.2 按**机制**全扫（不是只堵这一只）

修一只最怕「只堵这一只」。入口是一**类**：有效能耗 = 基础 + 逐技能 ramp + 每条能耗修正 +
每层中毒 + 天气。`scripts/roco/battle-smoke-negative-cost-scan.py` 逐类当场打：

| 类 | 覆盖面 | 判据 | 读数 |
| --- | --- | --- | --- |
| ① `skill_ramps`（「本技能能耗永久-N」） | 12 条会**减**的技能逐条 | A/B/C | 全过 |
| ② `energy_cost_mods`（能耗修正能把基础 0 的技能压成 -1） | 1 条 | A/B/C | 过 |
| ③ 组合（ramp 一半 + 修正一半，单看每项都不为负） | 1 条 | A/B/C | 过 |
| 附：残留 unsupported（**非能耗**） | 「硬门」`skill_000671` | 玩家路径 vs planner | 过 |

判据：**A** 有效能耗 < 0 时 `legal_actions` 不提供这一手；**B** 直接 `_execute` 仍
`UnsupportedEffect`（fail closed，**且没扣能量**）；**C** 执行前的守卫把它变成 1 条可结算事件。
另有 2 条技能（`skill_000037` 洄游、`skill_000105` 机械变式）**规则集里没有任何物种学得到**
（`is_learnable` 全 False）⇒ 不可能进配招、够不到这条入口，如实记为 `skipped` 而不是判过。

产物：`reports/roco/battle-smoke/negative-cost-scan.json`（14 例：ok 12 / skipped 2 / failed 0）。

#### 3.4.3 缺口计数**没有降**

这一条**仍然**记在②机制核验那一列：引擎依旧**没有**给「能耗被压到 0 以下」定任何下限
（MC-018 没定义就是没定义）。task-5 修的是「别把死局递给玩家 / 别炸整局」，
**不是**「这条机制现在支持了」。证据：`negative-cost-scan.json` 里 12 条技能的机制缺口一条没少；
`battle-smoke-summary.json` 的 `blocking_mechanism_gaps` 由 1 条变 **2 条**（新增全类扫描那条），
②的死结计数只增不减。

**口径声明**：**没有**为了让数字好看删掉那一局的用例、**没有**改契约、
**没有**给负能耗设任何默认值或缺依据的下限。

---

### 3.5 task-6：机制没实现的那一手，在玩家花掉之前看得出来

`legal_actions` 只管「能耗上付不付得起」；「硬门」`skill_000671` 那种**决定性效果**
（描述里读不出减伤比例）引擎算不出来，它**仍然是合法动作** —— 点下去白搭一手。
Lead 2026-09-29 定的口径：**不动引擎语义**（那会让引擎发明一条新规则，连带影响
planner / opponents / regression），把事实标在界面上。

#### 3.5.1 第一步：先量「回执里有没有」

`scripts/roco/battle-smoke-unsupported-flag.py` 量的是**开局的 battle view 回执**：

| 项 | 改前（`unsupported-flag-probe.before.json`） | 改后 |
| --- | --- | --- |
| `view.legal[]` 的键 | `item_id / kind / label / magic_id / skill / skill_id / skill_name / target_index` | 多一个 **`support`** |
| 有没有「这一手结算不了」的专门字段 | **没有**（`dedicated_marker_keys: []`） | 有：`support.tier` + `support.note` |
| 唯一沾边的 | `skill.effect_support`，对**全部 824 条技能**都是 `unsupported` ⇒ 分辨不出哪一手会白搭 | 同上（这一条仍在，只是不再被当成判据） |
| 同一份回执里的 `unsupported_seen` | 0 条（它是**用完之后**才有的运行时记录，管不了「点之前」） | 同 |

⇒ 结论是「**回执里没有**」，于是按 Lead 的口径在**服务层只读地补上**。

#### 3.5.2 来源：引擎**已有的**逐技能档位，不是新造判据

服务层调的是既有只读接口 `RocoClient.skillTier()` → `POST /rules/query
{kind:'skill', with_tier:true}` → 引擎**唯一分类器** `coverage.classify_skill`。实测全库分布：

| 档位 | 条数 | 含义 |
| --- | --- | --- |
| `SIMULATABLE_UNVERIFIED` | 290 | 引擎会结算（**不标**） |
| `PARTIAL` | 313 | 读出了一部分，还有未认领片段（**标出来**） |
| `KNOWLEDGE_ONLY` | 12 | 只有资料，引擎不结算（**标出来**） |

服务端只做「档位 → 一句人话」的转写（`skillSupportFact`），**不新造判据、不硬编名单**；
技能档位是静态属性，进程内按 `skill_id` 缓存，每回合只对当前场上的技能查一次。

#### 3.5.3 第二步：改了什么

- `src/server/roco-service.js`：`attachSkillSupport(view)` 在 `startBattle` / `advanceBattle` /
  `freeAction` 组装 view 之后，给**每个技能动作**挂 `support:{tier,note}`（只挂在引擎说
  「还算不出来」的那些上）。**不改 `kind`、不删动作、不置灰**。
- `src/client/roco.js`：两条渲染路径都加了一行警示 —— 玩家真正点的那一格（b3 技能格，
  `data-b3-skill-support="yes"`）与旧的行动坞（`data-roco-skill-support="yes"`）。
  **不加 `disabled`**：引擎说它合法，界面就让它可点。

文案示例（都是**事实**，不是建议）：`这招有一部分引擎还不会算：每回合随机变成自己未携带的技能`、
`这招有一部分效果引擎还不会算`、`这招的效果引擎还不会算，点了不会生效`。
工程词（`UnsupportedEffect` / `skill_` / `效果原语` / `未识别机制` …）由服务端**过滤**，
命中就退回一句通用说法。

#### 3.5.4 判据 + 必红反证

`scripts/roco/battle-smoke-support-marker.mjs`（判据是**导出的纯函数**，可单独 import）：

| 判据 | 咬什么 |
| --- | --- |
| ① 该标的必须标 | 引擎说「还算不出来」的那一手，回执里必须有 `support.note` |
| ② 文案不许有工程词 | `note` 里出现 `UnsupportedEffect`/`skill_000671`/`效果原语`… 即红 |
| ③ 不许变成建议 | `note` 以「别用/不要用/建议/推荐」开头即红 |
| ④ 不许替引擎做决定 | 标记过的动作带 `disabled` 即红；档位是「会结算」却被标也红 |

必红反证 **5 条**（每条都把判据该咬的东西摘掉/弄脏）：摘掉标记、塞工程词、塞技能 id、
把那一手变灰、改写成建议 —— 判据必须报错。读数：**自检 + 反证 6/6 过**
（`support-marker.json` 的 `selftest`）。

#### 3.5.5 真机截图

`scripts/roco/battle-smoke-support-marker-browser.mjs`（真 Chrome + 真鼠标，**自起进程内服务**，
不重启 8765）：六槽选「板板壳」→ 该槽「换招」里把**硬门**选进四个技能 →
`#start-standard-pvp` → 那一格上出现红字标记，且 `data-b3-action=3` ⇒ **仍然可点**。
读数 **5/5 步过**（`support-marker-browser.json`）。

截图：`docs/roco/review-2026-09-28/shots/battle/browser-04-skill-support-marker-1440x900.png`
（**不放 `reports/roco/**`**：那里的 PNG 被 `.gitignore` 吃掉）。

#### 3.5.6 回归读数

| 套件 | 读数 |
| --- | --- |
| `node --test tests/roco-page-ux.test.js tests/roco-battle-context.test.js tests/roco-standard-pvp-battle.test.js tests/evals/player-copy.test.js tests/evals/structure-contract.test.js` | **92/92 过** |
| `node --test tests/roco-battle-panel-static.test.js tests/roco-team-serving.test.js` | **19/19 过** |
| `node scripts/roco/battle-smoke.mjs` | **7/7 OK**（+support-marker 步，112s） |
| `npm run test:unit`（全量） | 5 红。**逐条做了基线对照**（`git archive b592e36` 到 `/tmp` 后用同一份 `node_modules` 跑）：4 条在基线**就已经红**（`roco-experience` 系别配色、`model-trajectories` 双路径一致、`roco-team-cards-layout` 两个视口）⇒ **不是本轮引入**；第 5 条 `tests/server.test.js` R8① **是我 task-5 引入的**，见 3.5.7 |

#### 3.5.7 **我（task-5）留下的一个测试红：要 Lead 在 `tests/` 里改一行**

`npm run test:unit` 里 `tests/server.test.js` 的「R8①」红了：

```
assert.equal((src.match(/unavailable'?503/g) ?? []).length, 2, '开局与出招两处都要把 unavailable 映成 503');
actual: 3   expected: 2
```

- **归因**：task-5 按 Lead 的口径把 `advanceBattle` 的「一律 400」也改成
  `unavailable→503 / unsupported_effect→422`，于是源码里这个模式从 **2 处变成 3 处**（`grep -o` 实测 = 3）。
- **代码是对的**（那正是 task-5 要求的行为，也与 `startBattle`/`freeAction` 对齐）；**是这条计数判据的期望值过期了**。
- 基线对照：`git archive b592e36`（task-5 之前）跑 `tests/server.test.js` **不红** ⇒ 确认是本轮引入的红。
- **修法**（在 `tests/**`，我这一轮的写域外，**没有动**）：把那句的 `2` 改成 `3`，并把注释放成
  「开局 / 出招 / 自由动作三处」。task-5 当时的回归清单只要求 `test:env` + `structure-contract`，
  **是我漏跑了 Node 全量**，这条由我负责报出来。

#### 3.5.8 顺带发现（**未改**，报 Lead）

旧行动坞 `#actions`（`skillSlots`）**按名册的冻结配招画四格，不看引擎这一局的实时配招**
（`view.self.loadouts`）。实测：把「硬门」换进配招后，那一坞画的是
`气波/防御/后发制人/复写`，其中 3 格 `legal=no`，而真正合法的 4 手**一格都没有**。
本页玩家实际点的是 b3 那一套（已按实时配招对齐），所以不影响本次交付；
但两套渲染器的口径不一致本身是个缺陷 —— 与 2026-09-23 在另一个面板修过的
「引擎实时配招是权威」是同一类。**没有动它**：那超出 task-6 的范围，且要先确认这一坞
在当前版式里到底还可见不可见。

---

## 4. 浏览器入口（只验「那几个按钮真的点得动」）

浏览器只做入口那一段（逐只全量在引擎侧与 HTTP 入口侧，见上）。
跑之前按 `tmp/BROWSER-LOCK.md` 抢锁（写 owner、只删自己的锁）。

| 步 | 读数 |
| --- | --- |
| 六槽工作台挂上 | OK（`#team-workshop` shadow root 在） |
| 真鼠标点 6 只候选 | OK，六槽 `filled = 6` |
| 点「开一局（标准 PVP · 六宠）」`#start-standard-pvp` | OK，开局后技能按钮 **4** 个、动作分组 `skill:4,charge:1,switch:5,surrender:1,magic:1,item:0,escape:0` |
| 点第一个技能 | OK，「🌟 0 抓挠 普通系 · 攻击 预计 28（未核验）」，回合 **第 1 回合 → 第 2 回合** |
| 页面异常 | 0 条 |

结论 JSON：`reports/roco/battle-smoke/browser-entry.json`（5/5 步过）。
截图（**按 Lead 口径放 docs，不放被 gitignore 的 `reports/roco/**/*.png`**）：
`docs/roco/review-2026-09-28/shots/battle/browser-01-six-slots-1440x900.png`、
`…-02-battle-opened-1440x900.png`、`…-03-after-action-1440x900.png`。

---

## 5. 可复验命令（一条命令 + 分段）

```bash
node scripts/roco/battle-smoke.mjs                    # 一条命令跑完 ①~⑥（≈2min）
python3 scripts/roco/battle-smoke-engine.py            # ① 引擎侧全量 542（≈40s）
node scripts/roco/battle-smoke-entry.mjs --settle=all  # ② HTTP 入口侧全量 542（≈80s）
python3 scripts/roco/battle-smoke-summary.py           # ③ 合成清单 + 人读 md
python3 scripts/roco/battle-smoke-repro.py             # ④ 打不完的局逐手复现（带 traceback）
python3 scripts/roco/battle-smoke-repro-negative-cost.py   # ⑤ 绞轮自足复现：修后必须 settled + 原因可读
python3 scripts/roco/battle-smoke-negative-cost-scan.py    # ⑥ 负能耗入口全扫 + 残留 unsupported 探针
node scripts/roco/battle-smoke-support-marker.mjs           # ⑦ task-6 读数 + 判据 + 必红反证（自起进程内服务）
node scripts/roco/battle-smoke-support-marker-browser.mjs   # ⑦ 真机截图（先抢浏览器锁）
node scripts/roco/battle-smoke-browser.mjs --base=http://127.0.0.1:8765 --shots  # 先抢锁
```

产物：

- `reports/roco/battle-smoke/engine-sweep.json`（引擎侧逐只原始记录，含每一步的引擎原文）
- `reports/roco/battle-smoke/entry-sweep.json`（HTTP 入口侧逐只 + 12 组组合，含逐手 trace）
- `reports/roco/battle-smoke/battle-smoke-summary.json` / `battle-smoke.md`（两列清单）
- `reports/roco/battle-smoke/negative-energy-cost-repro.json`（绞轮缺口自足复现）
- `reports/roco/battle-smoke/repro-failures.json`（trace 逐手复现，含活对象状态）
- `reports/roco/battle-smoke/negative-cost-scan.json`（负能耗入口全扫 + 残留 unsupported 探针）
- `reports/roco/battle-smoke/support-marker.json`（task-6：step1 读数 + 判据 + 6 条自检/反证）
- `reports/roco/battle-smoke/support-marker-browser.json`（task-6：真机 5/5 步）
- `reports/roco/battle-smoke/unsupported-flag-probe.before.json`（**改前**的 step1 读数：回执里没有这个字段）
- `reports/roco/battle-smoke/negative-energy-cost-repro.before.json`（**修前**快照：第 6 回合炸局）
- `reports/roco/battle-smoke/test-env-baseline.log` / `test-env-after.log`（改前/改后 636 条 Python 套件）
- `reports/roco/battle-smoke/browser-entry.json` + `docs/roco/review-2026-09-28/shots/battle/*.png`

---

## 6. 修了什么 / 没修什么（含 task-5）

**修了（只在冒烟脚本这一层，没碰产品代码）**

1. 入口侧策略的「聚能死循环」：四招出完后无条件聚能 → 改成继续出招（`own-0007` 卡上限的根因）。
2. 还没出过的技能**贵的先出**（能量有限、精灵可能中途倒下；引擎侧与入口侧同一口径）。
3. `battle-smoke-repro.py` 改成在**活着的那份 `GameState`** 上重放失败那一手 ——
   `battle_advance` 内部 `deserialize` 出的对象抛错后就没了，只看入参字典会以为状态没变。
4. 结构契约两条（Lead 2026-09-29 核实）：
   - `battle-smoke-browser.mjs` 收尾删临时 profile 改成带重试
     （`rmSync(..., {maxRetries: 10, retryDelay: 100})`）；
   - `battle-smoke-engine.py` 里的能量上限 `10` 改成**从规则配置读**
     （`rule_config.get_rule_config(CONFIG_ID).energy_max`），不再抄常数（RC-101）。
   读数：`node --test tests/evals/structure-contract.test.js` → **28 pass / 0 fail**。

**task-5 修了（`roco/src/roco_env/**` + `src/server/roco-service.js`）**

1. **① 口径自洽**：`legal_actions` 与 `_execute` 现在读**同一个** `resolved_skill_cost`。
   解不出有效能耗（负值 / 缺口径）的招式**根本不提供** —— 不再「算不出就退回基础能耗、
   照样列成合法」（这正是 CLAUDE 那句注释早就写了、代码却没做到的地方）。
2. **② 执行前守卫** `_cancel_unresolvable_skill`：合法动作表是回合开始时算的，
   同一回合里先出手的一方可以改掉另一方的能耗 ⇒ 存在「列表里合法 → 结算时解不出」的真实窗口。
   这一手在 `_execute` 之前被拦下：不结算 + 如实登记进 `state.unsupported` +
   一条**能结算的** `action_cancelled{reason: energy_cost_unresolved}`（带玩家可读原因），**回合继续走完**。
3. **② 玩家路径兜底**：`step_joint(..., tolerate_unsupported=True)`（**只有 `service.battle_advance` 传**）——
   任何残留 unsupported 也变成可结算事件。搜索/推演那条路不传，`planner` 的 `-inf` 契约逐位不变
   （`roco/tests/test_planner.py` 的「硬门 = -inf」那条仍然绿）。
4. **② 错误分类**：`service.battle_advance` 接住 `UnsupportedEffect` → 422 `unsupported_effect`；
   `src/server/roco-service.js` 的 `advanceBattle` 不再**一律 400**（`unavailable`→503 /
   `unsupported_effect`→422），与 `startBattle` / `freeAction` 对齐。
5. **也没有**给负能耗定任何默认值/下限、**没有**删用例、**没有**改契约。

**这一轮没做 / 缺口**

1. 逐只全量只在**标准 PVP 六宠**（`mobile_s4_candidate_v3`）跑；`legacy_sim_v1`（3v3 练习局）没跑全量。
2. 机制那一列只核到「引擎实现了没有」；**实机核验 0/542**，所以 B 节现在只能说到
   「基础可玩覆盖齐了、决定性机制实现 8/542、实机核验 0」。
3. 组合测试是 10 组随机 + 2 组指定，不是穷举（`C(542,6)` 量级未跑）。
4. 浏览器只验了入口那 5 步，没有逐只过浏览器（口径如此，且有串行锁约束）。

## 7. 下一项（按影响排序）

1. **同类残留**：`legal_actions` 会把**机制没实现**的技能也列成合法（样例「硬门」`skill_000671`，
   描述里读不出减伤比例）。现在玩家路径不会炸整局了（变成一条可读的 `action_cancelled`），
   但玩家点下去还是白搭一手 —— 要不要在列表层就标出来/不提供，是一个**产品口径**决定，
   需要 Lead 定（`legal_actions` 得先有一个「这一手结算得了吗」的判据）。
2. **机制那一列**：把 527 只「引擎未登记」的决定性特性排一个补建顺序（先高频使用 / 先能定义触发条件的）。
3. **实机核验**：这一列要动需要 microcase 录制，属于另一条线。
4. `legacy_sim_v1`（3v3 练习局）没跑全量；组合测试是 10 随机 + 2 指定，非穷举。
