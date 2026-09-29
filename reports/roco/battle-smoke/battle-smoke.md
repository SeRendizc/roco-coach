# B 段 · 全部已拥有实例的最小战斗冒烟（可玩与机制核验**分开**统计）

生成：2026-09-29T09:38:23+0800　规则集：`roco-world-s4-2026-09-10`　范围：data/roco/owned/owned-pets.json 的全部实例（= 当前已拥有清单）

口径来自《长线计划与监工规则》B 节与人类 2026-09-29 的补充：
**「每只的基础可玩与特殊机制/实机核验分开统计，不能只改标签宣布全可战斗」**。
能开局就只写「能开局」；引擎没实现的效果不许伪装结算。

## ① 基础可玩（能不能被选进队 → 合法六只 → 开局 → 出四技能/换人 → 结算）

| 量的是什么 | 读数 | 出处 |
| --- | --- | --- |
| 总实例数 | 542 | `data/roco/owned/owned-pets.json` |
| 引擎侧：完成全部五步 | **542/542** （结算 542） | `engine-sweep.json` |
| 引擎侧：四技能**全部**出过 | **536/542** | 同上 |
| 引擎侧：换出 + 换入都做到 | **542/542** | 同上 |
| 引擎侧：受击 / 目标倒下 | 542 / 542 | 同上 |
| 入口侧（HTTP `battle/new`）：选进队 | 542/542 | `entry-sweep.json` |
| 入口侧：合法六只 + 开局 | 542/542 | 同上 |
| 入口侧：**配招随入口完整传递** | 542/542 | 同上 |
| 入口侧：打到结算 | 542/542 | 同上 |
| 组合测试（随机六只 ×10 + 玩家实际六只 + 形态/机制混合） | 12/12 | 同上 |

**精确失败 ID**：引擎侧 0 条，入口侧 0 条，入口侧结算 0 条。
- 无。（不是「没查」，是逐只五步全过；判据见上面几行）

**四个技能没全出（6 只）** —— 逐条给准确原因，并给合法可运行的替代（这只的引擎规范配招）：
- `own-0013` 阿米亚特：缺 魔爪（`skill_000766`） —— 魔爪：「魔爪」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**
- `own-0015` 罗隐：缺 魔爪（`skill_000766`） —— 魔爪：「魔爪」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**
- `own-0019` 地鼠：缺 抓挠（`skill_000246`） —— 抓挠：「抓挠」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**
- `own-0217` 呼呼猪：缺 彗星（`skill_000321`） —— 彗星：「彗星」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**
- `own-0218` 獠牙猪：缺 彗星（`skill_000321`） —— 彗星：「彗星」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**
- `own-0434` 棋棋：缺 气波（`skill_000673`） —— 气波：「气波」可学、能耗 0、这一局也被引擎列进过合法动作，但目标精灵在被量到之前就倒下了 / 回合用完了 ⇒ **是这一局的时序没轮到，不是这一招跑不了**

### 组合测试逐条

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
| player-actual-six | own-0224→pet_000225、own-0189→pet_000190、own-0442→pet_000445、own-0006→pet_000006、own-0008→pet_000008、own-0019→pet_000019 | loss | 22 |
| form-and-mechanism-mix | own-0270→pet_000271、own-0376→pet_000378、own-0006→pet_000006、own-0008→pet_000008、own-0019→pet_000019、own-0032→pet_000032 | loss | 19 |

## ② 特殊机制核验（引擎实现了没有 / 实机核验过没有）

**这一列与①无关。** 一只精灵可以「能开局、四技能都出得来、打到结算」，而它的决定性特性在引擎里**一行都没实现** —— 那种情况在这里写「没实现」，不写「全可战斗」。

| 引擎侧特性实现状态 | 只数 |
| --- | --- |
| FULL（按原语完整实现） | 8 |
| PARTIAL（部分实现，有登记缺口） | 3 |
| REFUSED（明确拒绝并给理由） | 4 |
| 引擎未登记 ⇒ 没实现 | 527 |
| **实机核验过** | **0** |

实机核验 = 0/542：`data/roco/derived/pet-mechanisms.json` 里这 542 只的 mechanism_status **全部**是 FROZEN_DESC，且每只都带两条 unverified（「技能/特性效果未实机核验（MC-E08 等 microcase 未录制）」、「desc 文字来自冻结导入，触发条件与时序未验证」）。本仓没有任何一只被标记成实机核验过 —— 所以这一列是 0，不是 542。

引擎侧的实现状态**只覆盖 17 只精灵**（`data/roco/engine-trait-status.json`，其中 15 只在已拥有清单里）：

| 实例 | 精灵 | 特性 | 状态 | 挂钩 | 已登记的缺口 |
| --- | --- | --- | --- | --- | --- |
| `own-0009` | 恶魔叮 | 渴求 | FULL | on_enter | — |
| `own-0062` | 音速犬 | 专注力 | FULL | on_enter | — |
| `own-0112` | 雪影娃娃 | 捉迷藏 | PARTIAL | after_freeze_applied | — |
| `own-0124` | 化蝶 | 化茧 | REFUSED | — | — |
| `own-0189` | 海豹船长 | 身经百练 | FULL | on_enter | — |
| `own-0224` | 寂灭骨龙 | 不朽 | REFUSED | — | — |
| `own-0414` | 圆号鱼 | 泛音列 | PARTIAL | after_status_skill | 敌方全攻击技能能耗 +2 未接线（`after_status_skill` 只挂 `聒噪` 印记）；「持续 3 回合」与回合边界的对齐未定（MC-018 同族） |
| `own-0442` | 黑猫巫师 | 预警 | PARTIAL | on_turn_start | — |
| `own-0448` | 秩序鱿墨 | 绝对秩序 | REFUSED | — | — |
| `own-0471` | 画间沉铁兽 | 变形活画 | FULL | on_action | — |
| `own-0472` | 书魔虫 | 图书守卫者 | FULL | on_enter | — |
| `own-0475` | 古卷匣魔像 | 构装契约者 | FULL | on_enter | — |
| `own-0540` | 圣凯布米龙 | 热成像 | FULL | on_turn_start | — |
| `own-0541` | 银月狼王 | 铭记于月亮 | REFUSED | — | — |
| `own-0542` | 月使鹭纳 | 冷光源 | FULL | on_turn_start | — |

**战斗中「自己出手、引擎登记了未结算效果」的：295/542**。这是②的直接证据 —— 引擎如实记账，没有伪装结算：

抓挠 —— 我方的抓挠有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
甩水- `own-0002` 水蓝蓝：3 条，技能 、水炮- `own-0002` 水蓝蓝：3 条，技能 、多维击打 —— 我方的水炮有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
抽枝 —— 我方的抽枝有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
甩水- `own-0005` 水灵：3 条，技能 、水炮- `own-0005` 水灵：3 条，技能 、多维击打 —— 我方的水炮有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
火苗 —— 我方的火苗有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
抓挠 —— 我方的抓挠有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
抓挠- `own-0009` 恶魔叮：3 条，技能 、连续毒针- `own-0009` 恶魔叮：3 条，技能 、扇风 —— 我方的扇风有1 条已解析效果**没有结算**（未核验，不猜数值），已如实登记。
啃咬 —— 我方的啃咬有1 处未解析机制、5 处未认领机制词**没有结算**（未核验，不猜数值），已如实登记。
- …（其余 287 只见 `battle-smoke-summary.json` 的 `column_2_mechanism.in_battle_unsupported`）

### 阻塞性机制缺口（**记在②，不算①**）

下面这条**不是**「没实现所以不出这一手」，而是「这一手已经被引擎列为合法、
结算到一半却变成非法」。它**不因为①的 542/542 而消失** ——
①的读数是在**这一版冒烟脚本的策略**下取的，换一串动作顺序就会踩到；
所以它按口径记在②，并配一条**自足复现**（不依赖任何一次冒烟的轨迹）。

- **`own-0442（冒烟里踩到的那一只）/ 自足复现配方：pet_000446 + pet_000482`（溯源钟（持有「绞轮」））· 结算中途（自足复现；修前炸在第 6 回合，修后整局打到第 37 回合结算）**
  - **缺口状态**：**缺口仍在，一个字都没降**：引擎**没有**给负能耗定下限（MC-018 没定义），`skill_000494` 依旧列在②机制核验的缺口里。这次修的只有「别炸整局 / 别把死局递给玩家」。
  - 引擎回执：修前：UnsupportedEffect: 未支持的机制：技能「绞轮」的有效能耗（能耗修正把它压到 -1（基础 5）—— 负能耗的下限在术语里没有定义（MC-018），不猜一个 0，也不按负数回能）　⇒ 服务层 internal_error ⇒ Node HTTP 400，重试必复现。
修后：不抛异常 —— 这一手变成 `action_cancelled{reason: energy_cost_unresolved}`
  - 做了什么：**两层都做了**：① `legal_actions` 与 `_execute` 现在读**同一个** `resolved_skill_cost`，解不出定价（含负值）就**不提供这一手**，不再「算不出就退回基础能耗」；② 执行前再判一次（`_cancel_unresolvable_skill`）—— 合法动作表是回合开始时算的，中途被压负的那一手变成一条**能结算的** `action_cancelled` 事件、回合继续走完。另外玩家路径（`service.battle_advance`）对任何残留 unsupported 都兜底成可结算事件，错误分类改成 422 `unsupported_effect`（不再是 500 `internal_error` / HTTP 400）。
  - 修前/修后：{"before": {"outcome": "crash", "turn": 6, "exception_type": "UnsupportedEffect"}, "after": {"outcome": "settled", "battle_result": "loss", "turns": 37, "cancellations": 4, "unsupported_entries": 28}}
  - 触发条件与根因：「绞轮」的基础能耗 5，描述是「造成物伤，每受到1次抵抗的技能攻击（不含连击），本技能能耗永久-1」。修前逐回合：ramp = —/-1/-2/-3/-4/-5，有效能耗 5/4/3/2/1/**0**，**每一回合它都在合法动作列表里**（引擎自己列的）。到 0 那一回合，同一回合里我方先出手的一次**属性抵抗**命中让它再 -1（ramp -6），随后轮到它结算时 `_execute` 重算能耗 = 5 + (-6) = **-1** ⇒ 抛 UnsupportedEffect。
    - 第 1 回合：ramp=None 有效能耗=5 被列为合法=True
    - 第 2 回合：ramp=-1 有效能耗=4 被列为合法=True
    - 第 3 回合：ramp=-2 有效能耗=3 被列为合法=True
    - 第 4 回合：ramp=-3 有效能耗=2 被列为合法=True
    - 第 5 回合：ramp=-4 有效能耗=1 被列为合法=True
    - 第 6 回合：ramp=-5 有效能耗=0 被列为合法=True
    - 第 7 回合：ramp=-6 有效能耗=-1 被列为合法=False
    - 第 8 回合：ramp=-6 有效能耗=-1 被列为合法=False
  - 复现：`python3 scripts/roco/battle-smoke-repro-negative-cost.py`　产物：`reports/roco/battle-smoke/negative-energy-cost-repro.json`
- **`全类扫描（不是单只）`（负能耗入口 + 残留 unsupported（12 条「能耗永久-N」技能逐条打））· 机制级判据 A/B/C**
  - **缺口状态**：这 12 条技能的**机制缺口一条都没变**：引擎仍然没有给「能耗被压到 0 以下」定任何下限。补的是「拿不到定价就不提供 / 不炸局」，不是「这条机制支持了」。
  - 引擎回执：cases=14 ok=12 skipped=2 failed=0；残留 unsupported 探针（skill_000671「硬门」）：in_player_legal=True、默认 step_joint 仍抛=True、玩家路径=200 ['我方这一手没有打出去（这条机制还没有实现）。']
  - 做了什么：按**机制**而不是按技能名扫：① ramp（12 条会减的技能逐条）；② 能耗修正（能把基础能耗 0 的技能也压成 -1）；③ 组合（单看每项都不为负）。每条都判三件事：A 有效能耗<0 时不出现在合法动作里；B 直接 `_execute` 仍 fail closed 且**没扣能量**；C 执行前守卫把它变成 1 条可结算事件。另有一条残留 unsupported（非能耗，样例「硬门」）证明：搜索/推演那条路仍然抛（planner 的 -inf 信号不丢），玩家路径能结算。
  - 修前/修后：{"before": {"outcome": "crash"}, "after": {"outcome": "settled", "cases_ok": 12, "cases_skipped": 2, "cases_failed": 0}}
  - 复现：`python3 scripts/roco/battle-smoke-negative-cost-scan.py`　产物：`reports/roco/battle-smoke/negative-cost-scan.json`

## 没修的 / 缺口 / 下一项

**修了什么**（都只在 `scripts/roco/battle-smoke*` 这一层，没有碰产品代码）：
- 冒烟脚本自己的策略：四个技能出完之后**继续出招**（原来会 `?? charge` 一直聚能，`own-0007` 卡到脚本上限就是这么来的 —— 同一条队在引擎侧 30 回合内就结算了）；还没出过的技能**贵的先出**。
- `battle-smoke-repro.py` 现在能拿**活着的那份 GameState** 重放失败那一手（`battle_advance` 内部 deserialize 出的对象抛错后就没了，只看入参字典会以为状态没变）。

**task-5 修了什么（`roco/src/roco_env/**` + `src/server/roco-service.js`）**：
- ① `legal_actions` 与 `_execute` 读**同一个** `resolved_skill_cost`：解不出有效能耗（负值 / 缺口径）就**不提供这一手**，不再「算不出就退回基础能耗、照样列成合法」。
- ② `_cancel_unresolvable_skill`：合法动作表是回合开始时算的，中途被压负的那一手在执行前被拦下 ⇒ 不结算 + 如实登记 + **一条可结算的 `action_cancelled{energy_cost_unresolved}`** + 回合走完。
- ② `step_joint(tolerate_unsupported=True)`（**只在玩家路径开**）：任何残留的 unsupported 也变成可结算事件；搜索/推演那条路不传，`planner` 的 `-inf` 契约逐位不变。
- ② 错误分类：`service.battle_advance` 接住 `UnsupportedEffect` → 422 `unsupported_effect`；`src/server/roco-service.js` 的 `advanceBattle` 不再一律 400（unavailable→503 / unsupported_effect→422）。
- **没有**给负能耗定任何默认值/下限，**没有**删用例、**没有**改契约。

**这一轮没做的**：
- 逐只全量只在**标准 PVP 六宠**（`mobile_s4_candidate_v3`）这一份配置上跑；`legacy_sim_v1`（3v3 练习局）没跑全量。
- 特殊机制那一列只核到「引擎实现了没有」；**实机核验是 0**（本仓没有一只被标成实机核验过），所以 B 节的「全部已拥有精灵能进行本地训练战斗」现在只能说到「基础可玩覆盖齐了、机制实现 11/542 只、实机核验 0」。
- 组合测试是 10 组随机 + 2 组指定，不是穷举；`C(542,6)` 量级的组合没跑。

## 可复验命令

```bash
node scripts/roco/battle-smoke.mjs                    # 一条命令跑完下面四段（≈3min）
python3 scripts/roco/battle-smoke-engine.py            # ① 引擎侧全量 542（≈40s）
node scripts/roco/battle-smoke-entry.mjs --settle=all  # ② HTTP 入口侧全量 542（≈90s）
python3 scripts/roco/battle-smoke-summary.py           # ③ 合成清单 + 人读 md
python3 scripts/roco/battle-smoke-repro.py             # ④ 把打不完的那几局逐手复现（带 traceback）
python3 scripts/roco/battle-smoke-repro.py --only own-0442   # 只复现绞轮那一条
node scripts/roco/battle-smoke-browser.mjs --base=http://127.0.0.1:8765 --shots  # 浏览器入口（先按 tmp/BROWSER-LOCK.md 抢锁）
```

演示服务已跑着（`http://127.0.0.1:8765/`）时，入口侧那一条直接量它；`--base=` 可以换成别的实例。引擎侧不依赖服务，进程内直调同一份 `RocoService`。

