# 规则证据台账（Rule Evidence Ledger）

> 机器可读本体：`data/roco/evidence/rule-evidence-ledger.json`
> 实机 microcase 录屏清单：`data/roco/evidence/rule-evidence-microcase-records.json`
> 校验器：`node scripts/roco/verify-evidence-ledger.mjs`（`--json` / `--selftest`）
> 守卫测试：`node --test tests/roco-evidence-ledger.test.js`
>
> 规则集：`roco-world-s4-2026-09-10`　游戏：`roco_world_mobile`（只登记手游）
> 权威清单：`10-SOURCES-AND-CONFIDENCE.md`（本台账的每条 claim 与 confidence 都以它为准）
> 登记时间：2026-09-21　仓库 HEAD：`87d0eea`

## 0. 这份台账回答什么问题

一条规则只可能有六种状态，而这六种状态在仓库里**原先没有任何机器可检查的地方**记着。
没有台账时，施工口径只能靠记忆和单篇攻略——那正是 v3 纠偏指令要拦的行为。

| 等级 | 含义 | 能直接成为 current 规则吗 |
|---|---|---|
| `OFFICIAL_CURRENT` | 官方当前材料直接支持（官方公告 / 官方账号发布的内容） | **能** |
| `RECORDED_IN_GAME` | 项目自己保存的可复核实机 case（录屏 / 截图 / 实测记录） | **能** |
| `COMMUNITY_CURRENT` | 社区资料或社区归档当前可见（BWIKI、攻略、社区实测） | 不能 |
| `CROSS_SOURCE_SUPPORTED` | 至少两个独立来源指向同一结论，但没有一条是官方一手或可复核实机 | 不能 |
| `ENGINE_HYPOTHESIS` | 工程假设：为了让引擎有界运行而选定的值或语义 | 不能 |
| `UNKNOWN` | 当前无证据；不得据此施工，也不得用模型记忆补齐 | 不能 |

**只有前两级能直接 promotion 为 current rule。** 其余四级的用途是：
写 candidate ruleset、挂待录 microcase、把“我们其实不知道”这件事留在明面上。

## 1. 逐条台账（20 条）

“我们的施工口径”是该条 `claim` 的缩写；完整句子与 `notes` 见 JSON。

| # | 条目 id | topic | 我们的施工口径 | 置信等级 | 需要实机 microcase | 来源 |
|---|---|---|---|---|---|---|
| 1 | `EV-ENERGY-MAX` | `energy.max` | 按 candidate 施工“常规上限 10”；引擎的 `ENERGY_MAX=6` 只是占位 | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E01` | 知乎专栏、抖音视频（社区两源） |
| 2 | `EV-ENERGY-CHARGE` | `energy.charge` | 按 candidate 施工“聚能是主动行动、回复 5” | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E02` | 同上两源 |
| 3 | `EV-ENERGY-ENDTURN-REGEN` | `energy.regen` | 按“默认无自然回能”建模，回能视为技能/特性/道具效果 | `ENGINE_HYPOTHESIS` | ✅ `MC-E03` | `env.py#L59`（假设）、`MICROCASE-PLAN.md`、17173 官方公告转载（特性回能，用作反证） |
| 4 | `EV-ENERGY-INITIAL` | `energy.initial` | 只把“入场初始 2”当占位值，不写进对外文案 | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E04` | `env.py#L60`（假设）、抖音视频 |
| 5 | `EV-ENERGY-COST8-EXISTS` | `energy.max` | 承认“上限 6 会让高能耗技能永久不可用”，这是建 candidate 的理由 | `COMMUNITY_CURRENT` | — | BWIKI 技能图鉴（+ 快照 `skills.json` 逐条核对） |
| 6 | `EV-PVP-STANDARD-TEAM-SIZE` | `pvp.standard.team_size` | 建 candidate 支持六只编队；**禁止**写“官方已确认” | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E07` | TapTap 社区攻略、17173 官方公告转载 |
| 7 | `EV-PVP-STANDARD-MANA` | `battle_mode.standard_pvp` | 按 candidate 施工“通常 4 点魔力”；UI 标候选 | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E08` | 17173 官方公告转载、TapTap 社区攻略（**间接引句**，见 §7） |
| 8 | `EV-PVP-FAINT-MANA-LOSS` | `battle_mode.standard_pvp` | 按 candidate 施工“力竭通常扣 1 魔力”，胜负判据可切换 | `CROSS_SOURCE_SUPPORTED` | ✅ `MC-E09` | 17173 官方公告转载（“额外损失1点魔力”）、GameRes 拆解文 |
| 9 | `EV-PVP-SPEED-DUEL-MODE` | `battle_mode.speed_duel` | 实现成独立 BattleMode：3v3、2 点魔力 | `OFFICIAL_CURRENT` | — | TapTap 官方公告（极速对决） |
| 10 | `EV-PVP-UNKNOWN-OPPONENT` | `pvp.fairness` | 阵容工坊固定 `UNKNOWN_PREMATCH`（**产品场景**，不是游戏规则） | `ENGINE_HYPOTHESIS` | ✅ `MC-E11` | `microcases-v1.jsonl`（MC-013）+ 13 号文档 |
| 11 | `EV-PVP-OPPONENT-ROSTER-VISIBLE` | `pvp.fairness` | 可见 roster 与隐藏 build 分开建模，隐藏部分 fail closed | `COMMUNITY_CURRENT` | ✅ `MC-E12` | TapTap 社区攻略（单源） |
| 12 | `EV-SWIFT-INJECTION` | `swift.injection` | 主动换入 + 槽内顺序 + 自动注入动作 + 能量合法性一起建模 | `COMMUNITY_CURRENT` | ✅ `MC-E13` | BWIKI 小鹬页面 |
| 13 | `EV-MARKS-PERSISTENCE` | `marks.persistence` | 印记建模成 `SideState`，不是精灵 buff | `COMMUNITY_CURRENT` | ✅ `MC-E14` | BWIKI 印记页面 |
| 14 | `EV-TYPE-MULTIPLIER` | `type.multiplier` | 用 ×3/×2/×0.5/×0.25 四档，**不再**沿用“双弱 ×4” | `COMMUNITY_CURRENT` | — | BWIKI 深渊罗隐 / 溯源钟（两源） |
| 15 | `EV-TURN-ORDER-MECHANISMS-EXIST` | `turn_order.priority` | 应对、先手 +1、主动换人、速度参与先后——按真实机制实现 | `CROSS_SOURCE_SUPPORTED` | — | 17173 官方公告转载（先手+1）、TapTap 社区攻略 |
| 16 | `EV-TURN-ORDER-STRICT` | `turn_order.priority` | 引擎可有一套确定性排序键，但**不得**当游戏规则对外解释 | `ENGINE_HYPOTHESIS` | ✅ `MC-E05` | 本台账（10 号文档 §8 登记）、`MICROCASE-PLAN.md` |
| 17 | `EV-LEAVE-SEMANTICS` | `leave.semantics` | `ACTIVE_SWITCH != SKILL_LEAVE != FAINT_REPLACEMENT` 三个独立事件 | `COMMUNITY_CURRENT` | ✅ `MC-E16` | BWIKI 邪眼巨魔页面 |
| 18 | `EV-TRAITS-TRIGGER-COMPLEXITY` | `traits.triggers` | 主要工作量在 trigger/effect 语义，不在精灵表行数 | `COMMUNITY_CURRENT` | ✅ `MC-E17` | BWIKI 特性列表 |
| 19 | `EV-OFFICIAL-PAIRING-AI` | `product.pairing_ai` | 配队助手不能是唯一创新点；卖点在局中决策与规则可验证 | `OFFICIAL_CURRENT` | — | 官方 B 站账号发布（2026-08-07） |
| 20 | `EV-BATTLEMODE-PARAMETERIZED` | `battle_mode.territory_trial` | `team_size / active_count / trait_sharing / boss_form` 全部参数化 | `OFFICIAL_CURRENT` | — | TapTap 官方公告（领地试炼 2v2 / 特性共享 / 首领化） |

等级分布：`OFFICIAL_CURRENT` 3 · `RECORDED_IN_GAME` **2** · `COMMUNITY_CURRENT` 7 ·
`CROSS_SOURCE_SUPPORTED` 7 · `ENGINE_HYPOTHESIS` 3 · `UNKNOWN` 0。
`RECORDED_IN_GAME` 是 0 不是遗漏：本轮**没有录到任何实机**，所以一条都不许写成已录。

## 2. 哪些结论现在**不许**写进代码或文档当事实

1. **能量上限 10 与聚能 +5 只能进 candidate ruleset。**
   它们是 `CROSS_SOURCE_SUPPORTED`（两处社区来源），不是官方结论。
   仓库现有 `ENERGY_MAX = 6` 是 `ENGINE_HYPOTHESIS`；**两边都不是事实**，
   所以两者只允许以“候选规则 A / 候选规则 B”并存对照，任何一处（含界面文案）都不许出现
   “能量上限是 10”或“能量上限是 6”这种断言。
2. **标准 PVP 六宠、通常 4 点魔力、力竭扣 1 是 `CROSS_SOURCE_SUPPORTED`，禁止写成官方已确认。**
   10 号文档 §12.1 的工程结论原文就是：在录制标准 PVP 的编队、匹配、开场、力竭和结算
   microcase 之前，不把 4 点魔力写成官方已确认事实。
3. **应对/先手/换人/速度的严格总序是 `ENGINE_HYPOTHESIS`。**
   社区常把它概括成“应对 > 换宠 > 先手 > 速度”，但本轮没有同等强度的官方文字。
   引擎里的排序键（应对成功, 先手度, 速度, seed 随机）是**有界实现**，
   不得写进文档当规则，也不得用它对外解释“为什么这样排”。
4. **同速平手是 `UNKNOWN`。** 现有引擎用 seed 随机裁决，那只是可复现性手段，不是游戏规则。
5. **“回合末自然回能 +1”是被多源材料反驳的假设。**
   17173 转载的官方更新公告里出现的“回合结束时回复 4→3 能量”是**特性**（奇丽花/奇丽果），
   不是默认回能。不得把现有假设写成机制。
6. **匹配前未知对手是产品场景，不是游戏规则。** 领地试炼公告里“提前查看敌方词条”
   说的是活动 PVE，不能拿来证明标准 PVP 的可见性。
7. **`RECORDED_IN_GAME` 目前一条都没有。** 任何“已实测确认”的表述在本轮都不成立。

> 反过来说，也**不许**因为没录实机就直接删掉现有实现：那会让 `verify:release` 与
> 一批已交付产物失去对象。正确做法是 candidate ruleset + 双规则对照 + 逐条 microcase，
> 由录到的观测值决定哪一套成为 current。

## 3. 待录实机 microcase 清单（14 条）

完整字段（逐条录制清单、通过判据、交付形式）在
`data/roco/evidence/rule-evidence-microcase-records.json`。

| case | 要录什么 | 录到什么程度算通过 | 挂在哪条台账上 |
|---|---|---|---|
| `MC-E01` | 能量读数的最大值；接近上限时执行聚能的前后读数 | 录到的**最大读数本身就是答案**：≥10 则证伪 6；9 点聚能停在 10 则“+5 且不突破”成立；超过 10 则“可突破”成立。三段（前值/动作/后值）必须在同一次录制里 | `EV-ENERGY-MAX` |
| `MC-E02` | 一次聚能的能量差值；满能量时再聚能；聚能能否与出招同回合 | 一次聚能的差值**就是答案**（+5 或其它）；满能量时读数不变则“不能突破上限”成立 | `EV-ENERGY-CHARGE` |
| `MC-E03` | 无任何回能特性/技能的精灵连续 3 回合逐回合读数；带“回合结束回复能量”特性的对照 | 对照组的差值**就是答案**：无特性组读数不变 → 默认回能被证伪；有稳定增量 → 该增量即默认回能值 | `EV-ENERGY-ENDTURN-REGEN` |
| `MC-E04` | 开场首只、主动换入、力竭补位、同一只第二次入场四个读数 | 四段给出四个具体整数；“入场初始 2”只在第一段确为 2 时成立 | `EV-ENERGY-INITIAL` |
| `MC-E05` | 应对 vs 先手+1、换人 vs 先手+1、先手+1 vs 高速、双方同速各一段 | 每段能指出谁先动**就是**两两强弱的判据；四段互不矛盾则总序成立；同速若先手方固定则存在确定性规则，随机则仍属 `UNKNOWN` | `EV-TURN-ORDER-STRICT` |
| `MC-E07` | 标准模式编队界面槽位；放第 7 只的反应；开场可上阵/待命数量 | 编队界面能放进去的最大只数**就是答案**；版本更新后必须重录 | `EV-PVP-STANDARD-TEAM-SIZE` |
| `MC-E08` | 开局双方魔力读数、任一变化帧、结算文案 | 开局读出的数字**就是答案**（4 或其它）。本台账降级风险最高的一条 | `EV-PVP-STANDARD-MANA` |
| `MC-E09` | 击败瞬间前后魔力读数；同回合双力竭；补位是否占行动 | 击败瞬间的前后差值**就是答案**；差值 0 则“力竭扣魔力”证伪，胜负判据必须重写 | `EV-PVP-FAINT-MANA-LOSS` |
| `MC-E11` | 从点击匹配到开场的未剪辑录屏 | 全过程**判据是**“有没有出现过对方信息”：没有则 `UNKNOWN_PREMATCH` 成立；出现则必须记录位置与时点 | `EV-PVP-UNKNOWN-OPPONENT` |
| `MC-E12` | 开场对方面板、换入时新解锁的信息、详情面板 | **判据**是逐字段的可见/不可见清单；技能不可见则 fail-closed 成立，可见则观察面定义必须放宽 | `EV-PVP-OPPONENT-ROSTER-VISIBLE` |
| `MC-E13` | 带两个以上迅捷技能、能量只够其一的精灵主动换入 | 自动放出的那一个**就是答案**；若按能耗排序而非槽位顺序，模型必须重写 | `EV-SWIFT-INJECTION` |
| `MC-E14` | 正负印记各一后主动换人；再挂同类；力竭补位 | 换人后仍能看到同样印记**判据是**“下场不消失、入场继承”；同类层数变化决定替换/叠加 | `EV-MARKS-PERSISTENCE` |
| `MC-E16` | 同一只带离场触发的精灵分别制造三种离场 | 三次触发次数**就是答案**；与预期不符必须改写语义表 | `EV-LEAVE-SEMANTICS` |
| `MC-E17` | 按触发面各挑一只代表精灵，录制触发时刻与结算数值 | 每条给出（触发时刻/次数/数值）三元组，与文本一致才算通过 | `EV-TRAITS-TRIGGER-COMPLEXITY` |
| `MC-E20` | 官方配队 AI「斯嘉丽」一次完整使用（产品验收，非规则 case） | 必须录到“六只 + 每只配招 + 可导入对局”三段证据**才算通过** | `EV-OFFICIAL-PAIRING-AI` |

总数对齐关系：台账里 `needs_microcase=true` 的条目共 **14** 条，对应上面前 14 行（`MC-E01`…`MC-E17`）；
`MC-E20` 不是游戏规则 case，因此它服务的 `EV-OFFICIAL-PAIRING-AI` 的 `needs_microcase=false`，
但它是 `for_rule=EV-OFFICIAL-PAIRING-AI` 的验收记录，所以仍写进清单。
`MC-E15`、`MC-E18`、`MC-E19` 未启用：本轮没有需要它们回答的问题，编号留空比补一条凑数的 case 诚实。

## 4. 来源可用性与本轮核对结果（如实登记）

### 4.1 URL 探活（2026-09-21，`curl -s -o /dev/null -w '%{http_code}' -L`）

| HTTP | URL | 说明 |
|---|---|---|
| 200 | `https://www.taptap.cn/moment/838434682965067210` | 极速对决官方公告：3v3、每方 2 点魔力、至少上阵 1 只主题精灵——引句逐字核对通过 |
| 200 | `https://www.taptap.cn/moment/849700086890891385` | 领地试炼官方公告（S4 期）：特性共享、首领信物 → 首领化——引句逐字核对通过 |
| 200 | `https://www.taptap.cn/moment/809020453778620585` | 领地试炼官方公告（往期）：“高难度2v2挑战来啦”+ 特性共享 + 进化之力首领化——引句逐字核对通过 |
| 200 | `https://www.taptap.cn/moment/843861121864568519` | S4「月涌狂想」赛季时间 2026-09-10 04:00 — 2026-11-05 04:00——与 10 号文档 §1 一致 |
| 200 | `https://www.taptap.cn/moment/808879358071540062` | TapTap 社区 PVP 攻略：应对优先、速度决定先后、六只职能构成——引句逐字核对通过 |
| 200 | `https://news.17173.com/content/03182026/104940843.shtml` | 17173 全文转载官方更新公告（S1）：随机精灵最多携带 6 只、“每场战斗只能使用 1 次，但会回复 10 点能量”、特性“回合结束时回复能量”、“下一次行动获得先手+1” |
| 200 | `https://www.gameres.com/forum/t/917446` | 产品拆解文（原文来自知乎专栏）：**没有**逐字写出魔力扣减规则，只作背景 |
| 200 | `https://www.bilibili.com/video/BV1iMuh66EiP/` | 官方 B 站账号视频；用 `web-interface/view` 接口核对：标题含“智能配队 AI 伙伴「斯嘉丽」”，up 主“洛克王国世界”（mid 626796832），pubdate 2026-08-07T13:11:12Z |
| 200 | `https://www.douyin.com/video/7489841837251857673` | 社区视频（10 号文档 §7 引用） |
| 403 | `https://zhuanlan.zhihu.com/p/2040741873246024568` | 社区专栏：无浏览器 cookie 时 403，无法从命令行核对正文；等级因此只能停在 `COMMUNITY_CURRENT` |
| 567 | `https://wiki.biligame.com/nrc/技能图鉴`、`/小鹬`、`/印记`、`/深渊罗隐`、`/溯源钟`、`/邪眼巨魔`、`/特性列表` | 探活当时 BWIKI 对这些页面返回 567 + 反爬空壳页（同站其它路径曾返回 200，故为站点侧拦截而非链接失效）。**其内容只能用 10 号文档抄下的原文摘句**，本轮无法从命令行二次核对 |

### 4.2 本轮对 10 号文档的一处**证伪**（必须留档）

10 号文档 §12.1 把「官方 PVP 更新：随机精灵最多携带 6 只」列为 `OFFICIAL_CURRENT`，
来源写的是 `https://www.taptap.cn/moment/838434682965067210`。
本轮实测该 URL 打开后是 **「极速对决」活动公告**（精灵 3v3、每方 2 点魔力、主题精灵限制），
**不含**任何“最多可携带 6 只”的文字。

处理方式：`EV-PVP-STANDARD-TEAM-SIZE` **不升**为 `OFFICIAL_CURRENT`，
登记为 `CROSS_SOURCE_SUPPORTED`（TapTap 社区攻略 + 17173 官方公告转载两源），
并在台账 `notes` 里写明这次证伪。宁可把等级留在 lower，也不让一条来源指向它不支撑的结论。

### 4.3 仓库内可核对的两个数字

- `data/roco/normalized/roco-world-s4-2026-09-10/skills.json`：能耗 > 6 的技能 **20 条**
  （7 点 11 条；8 点 3 条：过山车 / 岩土暴击 / 隐藏条款；10 点 3 条：地震 / 气沉丹田 / 彼岸之手；
  另有 1 条记为 30 点，数值本身可疑）。这 20 条在 `ENERGY_MAX=6` 下会被永久判成不可用。
- `docs/roco/MICROCASE-PLAN.md`：仓库已有 30 条规则 microcase 计划（`MC-001`…`MC-030`），
  本台账的 `MC-E**` 逐条挂接在它们的 `plan_case` 上，不另起一套规则问题。

## 6. 怎么跑（可重跑，退出码 0/1）

```bash
node scripts/roco/verify-evidence-ledger.mjs            # 人读模式，rc=0 表示三栏都写清
node scripts/roco/verify-evidence-ledger.mjs --json      # 机器可读；rc 同上
node scripts/roco/verify-evidence-ledger.mjs --selftest  # 检查器自带正反用例（12 条）
node --test tests/roco-evidence-ledger.test.js           # 守卫测试（17 条，含必红反证）
npm run test:unit                                        # 全量单测里已含上面的测试文件
```

取证用的开关（反证不写盘：把改坏的副本写到 `/tmp`，再指过去看真实报错原文）：

```bash
node scripts/roco/verify-evidence-ledger.mjs --ledger /tmp/tampered.json
```

## 7. 已知风险与没做到的事

1. **`EV-PVP-STANDARD-MANA` 的引句是间接的。** 两份来源里**没有任何一处**逐字写出
   “标准 PVP 每方 4 点魔力”；17173 那条引句是特性回能里的“4能量”。
   这条等级来自 10 号文档的转述，本台账照抄未升等级，但它的支撑强度低于其它
   `CROSS_SOURCE_SUPPORTED` 条目——`MC-E08` 因此是本批优先级最高的录制项。
2. **`EV-PVP-FAINT-MANA-LOSS` 第二来源（GameRes）实际不含该规则**，只作背景。
   该条实质上接近单源 + 一处间接引句。
3. **BWIKI 内容本轮无法二次核对**（567 反爬），只能依赖 10 号文档抄下的摘句。
   台账里所有 BWIKI 来源的 `quote` 都是**10 号文档的原文**，不是本文件从页面新抓的。
4. **`RECORDED_IN_GAME` 为 0**：本批没有录制任何实机。所有“需实机”的条目都还是计划。
5. **`UNKNOWN` 为 0 是刻意的**：10 号文档只把“同速平手”判成 UNKNOWN，
   而它属于 `EV-TURN-ORDER-STRICT` 的一部分，已写进该条 `claim` 与 `notes`。
   不为了凑出一个 `UNKNOWN` 条目而把别的东西降级。
6. **台账不会自己变绿。** 它只保证“来源、等级、microcase 三栏写清了”。
   规则对不对，只能由 §3 那张表里的录屏回答。

## 2026-09-23 追加（人类口径）

- `EV-PVP-BOSS-FORM-STANDARD`（topic `battle_mode.standard_pvp`，`RECORDED_IN_GAME`）：首领化在闪耀大赛式标准 PVP 中**存在**，
  建模为策略 `allowed_if_eligible`（不是 forbidden、不是 required）；首领信物 / 进化之力 = 资格或触发条件，**不叫普通 item**；
  次数 / 冷却 / 是否占行动 / 持续 / 倍率一律 `null + UNVERIFIED`（引擎 fail closed）。
- `topic_crosswalk.ledger_extensions` 补 `battle_mode.boss_duel` → maps_to `battle_mode.standard_pvp`（主题 PVP 复用标准模式，只改 theme 那一块）。
- 台账现有 **21** 条，其中 `RECORDED_IN_GAME` **2** 条。
