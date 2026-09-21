# 旗舰 v3 checklist（RC 台账）

> 单一事实源：`08-IMPLEMENTATION-ROADMAP.md`（施工顺序）+ `09-CODING-AGENT-MASTER-PROMPT.md`（总合同）。
> 本文件只记**状态与证据**，不重复路线图里的验收标准。一次只做一个 RC。
> 每个 RC 的完成定义：代码 + 自动测试 + **负向验证（必红反证）** + 机器可读产物（+ 涉及 UI 时的浏览器证据）+ known limits。
> 更新纪律：改了状态就必须同时写证据路径；没有证据的项一律停在 `IN_PROGRESS`。

状态图例：`DONE`（有判据+反证+产物）/ `IN_PROGRESS` / `NOT_STARTED` / `BLOCKED`（外部依赖）/ `DEFERRED`（用户明确延后）

## Phase 0A：冻结基线与事实迁移框架

| RC | 内容 | 状态 | 证据 / 备注 |
|---|---|---|---|
| RC-000 | 当前 master 基线审计 | **DONE** | `scripts/roco/flagship-baseline.mjs`、`reports/roco/flagship-upgrade/baseline.json`（6/6 自检） |
| RC-101 | 版本化规则配置（`legacy_sim_v1` / `mobile_s4_candidate_v2`） | **DONE** | `data/roco/rulesets/{legacy-sim-v1,mobile-s4-candidate-v2}.json`、`roco/src/roco_env/rule_config.py`、`roco/tests/test_rule_config.py`（17）、`tests/roco-rule-config.test.js`（7）、结构判据「能量字面量只许住在配置里」（`structure-contract`，0 处违规 / 9 条反证全红）、`guard-selftest` 11 条全红、影响报告 `reports/roco/flagship-upgrade/rc-101-rule-config.json`、`docs/roco/RULE-CONFIG.md`。**默认逐位不变**（275 env / 715 unit 全绿）；candidate 只是登记，入场能量仍是 UNKNOWN（MC-E04 未录） |
| RC-102 | 能量证据与 microcase（candidate 只能进 candidate） | IN_PROGRESS（闸门 DONE / 录制待外部） | **promotion 闸门已可执行**：`scripts/roco/evaluate-rule-promotion.mjs` + `data/roco/evidence/microcase-recordings.json`（`recordings: []`，空表是正确状态）+ `tests/roco-rule-promotion.test.js`（8 条）+ `--selftest`（12 条 / 10 条反证）+ `docs/roco/RULE-PROMOTION.md`；当前 **9/9 NOT_PROMOTABLE**、`can_be_default = false`、`writes_config = false`。**缺**：实机录制（外部阻塞）；另报出一条结构事实 —— `battle_mode.team_size`/`active_count` **没有 microcase 落点**，要先立 case 并挂进台账。原记录：配置与 microcase 落点已就绪（`MC-E01/E02/E03/E04` + `data/roco/evidence/rule-evidence-microcase-records.json`）；**缺的是实机录制**（外部阻塞），录到之前 candidate 不得 promotion |
| RC-103 | 回合顺序与回合末登记表 | **DONE** | 两份 ruleset 补齐 `turn_order`（逐字段带 value/confidence/evidence_id/microcase）；引擎改按**配置声明的阶段顺序**结算、平手策略从配置读，**声明与实现多一个/少一个都抛** `UnsupportedEffect`（消息点名阶段与配置 id）；**速度平手不再用随机数假装知道规则**（UNKNOWN ⇒ 真平手时抛，含 MC-E05）；legacy 行为**逐位不变**（8 个 golden 指纹 + 既有 275 条 env 测试一条未改）；`roco/tests/test_turn_order_fail_closed.py` 20 条（每条带反证）、`reports/roco/flagship-upgrade/rc-103-turn-order.json`、`docs/roco/TURN-ORDER.md`。**仍差**：candidate 严格总序未确认（`switch` 折算进先手度）、`end_turn` 组内顺序无 case 可依 |
| RC-104 | 规则 → 产物失效图 | **DONE**（19 个主题 / 20 条产物，已覆盖 `turn_order.action_order` 与 `speed_tie`） | `data/roco/artifact-registry.json`、`scripts/roco/artifact-invalidation.mjs`、`reports/roco/flagship-upgrade/artifact-invalidation.json`（6/6 自检，13 条禁止重跑） |
| — | 规则证据台账（evidence ledger，贯穿所有 RC） | **DONE** | `data/roco/evidence/rule-evidence-ledger.json`（20 条：OFFICIAL 3 / COMMUNITY 7 / CROSS_SOURCE 7 / HYPOTHESIS 3 / RECORDED **0**）、`data/roco/evidence/rule-evidence-microcase-records.json`（14 条待录 MC-E**）、`scripts/roco/verify-evidence-ledger.mjs`（12 条自检）、`tests/roco-evidence-ledger.test.js`（17 条）、`docs/roco/RULE-EVIDENCE-LEDGER.md`；含一处对升级包来源指向的**证伪**（见 REDIRECT §7） |
| — | BattleMode 参数化登记 | **DONE**（登记）/ 待接代码 | `data/roco/battle-modes.json`（RC-101 消费它） |
| — | 六槽 UI 与 3 秒 Serving 拆分 | **DONE**（拆分文档 + **mockup 定稿**） | `docs/roadmap/FLAGSHIP-V3-REDIRECT.md` §5；mockup：`docs/roco/ui-mockup-six-slot.html` + `reports/roco/ui-mockup-six-slot-{1440x900,390x844}.png`（量测产物 `...-mockup.json`，0 问题） |

**P0A 验收**：双规则并存；旧 replay 可重放；candidate 差异报告可复现；未验证规则没有被静默 promotion。

## Phase 0B：全量数据包、RAG 与 OwnedPet

| RC | 内容 | 状态 |
|---|---|---|
| RC-201 | 公网 621/579/242 与仓库 622/824 的对账（不删记录凑数） | **DONE** | `scripts/roco/fetch-live-snapshot.mjs` + `scripts/roco/reconcile-catalog.mjs` + `data/roco/live/2026-09-21/public-index.json` + `reports/roco/reconciliation/catalog-reconciliation.json` + `tests/roco-catalog-reconciliation.test.js`（8 条 / 6 个注入全红）+ `docs/roco/CATALOG-RECONCILIATION.md`。**实测三张页 http 200、计数与页面声明逐一对齐（621/579/242）**；**824 = 579 战斗技能 + 245 特性**（口径，非缺数据）；622 vs 621 = `pet_000532`（公网并进基础卡分组）；245 vs 242 = `skill_000164/165/166`（公网索引侧不存在）。四桶：only_in_frozen 4 / only_in_live 0 / changed 0 / unresolved 4。**边界**：公网页是导航页，无数值 → 未做字段级校验。**许可闭环**（`8162a3b` + `7cbc4d2`）：快照 `metadata.licence` 从 `sources.yaml` 搬运（`CC-BY-NC-SA-4.0` / `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` / 证据文件路径 / `fetched_content_committed_to_git: false`），报告顶层 `licence_ok` 且 `inputs.live.licence` 与快照逐字一致；判据 8 → **10** 条，4 条必红反证（抹掉许可 / 再把分发改成 UNLIMITED / 证据指向不存在文件 / HTML 路径挪出忽略目录） |
| RC-202 | 统一 GameDataPack（catalog/skills/traits/learnsets/…/battle_modes/source manifest） | **DONE（包已出，就绪 draft 8/9）** | `data/roco/game-data-pack/v2/{pack.json,schema.json}`（1446 实体 / 2888 条 provenance / 99 条冲突）、`scripts/roco/{build,verify}-game-data-pack.mjs`（17 组判据、`--selftest` 10/10 与 11/11）、`reports/roco/reconciliation/game-data-pack-readiness.json`、`tests/roco-game-data-pack.test.js`（16 条 / 8 反证）、`docs/roco/GAME-DATA-PACK.md`；已接进闸门（`ffae367`）。**仍差**：第 6 项字段级覆盖证明（需数据导出）+ 4 条未解决冲突 | 对账已就绪（RC-201）；`docs/roco/CATALOG-RECONCILIATION.md` §9 列出从 `draft` → `ready` 还缺的 9 项：统一 schema、逐实体许可、逐实体 provenance、冲突处理策略、形态口径统一、字段级覆盖证明、ruleset 绑定、不可得字段清单、把对账接进 verify-release |
| RC-203 | OwnedPet / BattleBuild（同种多实例、有序四技能、锁定、约 80 个 Demo 个体） | **DONE（覆盖受 learnset 限制）** | `data/roco/owned/{schema.json,owned-pets.json}`（80 实例 / 48 species / 80 BattleBuild / 189 技能引用）、`scripts/roco/{build-owned-pets,verify-owned-pets,owned-pets-lib}.mjs`（16 组判据、`--check` 逐字节相同）、`tests/roco-owned-pets.test.js`（17 条 / 13 条必红反证）、`reports/roco/flagship-upgrade/rc-203-owned-pets.json`、`docs/roco/OWNED-PETS.md`。**边界（已机器化）**：可出战子集**恰好等于** roster-48 —— 48 是**冻结 learnset 覆盖**的上限（12 基线 + 36 overlay，上游另有 264 份未导入），不是白名单；`buildability_ceiling.proves_600_buildable=false`、`candidates_without_frozen_learnset=574`；养成属性**效果全部 UNKNOWN**（只存标签），阵容评估不得当加成。要突破需导入其余 learnset 或 RC-402 按需编译 |
| RC-204 | RAG 索引与 held-out 评测（Recall@K / MRR / 版本命中 / grounding / 冲突弃答） | **DONE** | `data/roco/rag/heldout-queries.json`（五类 45 条 + 13 条探针 + 清单 sha256）、`src/coach/rag-index.js`（1678 文档）、`scripts/roco/eval-rag-retrieval.mjs`（13 组判据 + 6 条反证 + 三套基线）、`tests/roco-rag-eval.test.js`（21 条）、`reports/roco/rag/rag-eval.json`、`docs/roco/RAG-EVAL.md`；已接进闸门（**17 套件**）。**实测**：新版 R@1..@10 1.000 / MRR 1.000 / grounded 1.000 / 冲突弃答 1.000；同语料基线B R@1 0.706、版本命中 0.333、弃答 0（②类与基线打平，如实报）。**诚实边界**：1.000 是**开发集**数字；13 条探针中 1 条**保留失败**（「冰系被哪些属性克制」召回而非弃答，语料无克制表）；向量检索未做 |
| RC-205 | 精灵盒子 UI（我的/全图鉴、搜索、个体比较） | **DONE** | `src/client/box.{html,js,css}`（新页面，进 `PAGE_ALIASES`/`publicAssets`/模块图）+ `GET /api/roco/box`（只读、不经 Python；`catalog=622` / `mine=80` / `detail=` / `compare=` 同种比较，不同种 400；非法参数 400 不取整）+ `tests/roco-box.test.js`（11 条 / 6 反证）+ `scripts/roco/browser-box-acceptance.mjs`（**22/22 判据 + 5/5 反证**，真实键鼠、7 张截图、`clientW==scrollW` 1440/1440 与 390/390、390px 91 个可点元素 0 个不达标）+ `docs/roco/PET-BOX.md`。**边界**：622 里只有 48 只显示种族值与四技能；面板数值为 null **绝不补 0**；养成取值全空按未知呈现；图片/向量未做；`support` 暂只有 `KNOWLEDGE_ONLY` |

## Phase 0C：阵容工坊与 Agent 约束理解

| RC | 内容 | 状态 |
|---|---|---|
| RC-301 | RecommendationRequest 合同（六宠、锁定、must include/exclude、`UNKNOWN_PREMATCH`） | **DONE** | `src/coach/team-request.js`（13 字段 / 27 错误码 / 7 信息码 / 归一化 / 自然语言抽取）+ `toolbox.js` 增量工具合同 + `tests/roco-team-request.test.js`（17 条 / 8 组反证）+ `reports/roco/flagship-upgrade/rc-301-team-request.json` + `docs/roco/TEAM-REQUEST.md`。**要点**：mode/规则集不许自创、`team_size` 由模式推导、默认 `UNKNOWN_PREMATCH` 且标明是代入值、未知字段不静默丢弃、`ok:false` 时 request 恒 null。**两条边界**：工具**故意未进** `TOOL_CONTRACTS`（会牵动已发布评测的提示摘要与 13 个工具名 → 排进 RC-305）；抽取器朴素，新增 `MENTION_WITHOUT_FIELD` 信息码让「点了名但没落进 schema」**不再静默** |
| RC-302 | 缺口诊断（coverage/speed/energy/respond/pivot/synergy/cost，每条带证据与置信） | **DONE** | `src/coach/team-gaps.js`（七维可复算判据；每条 gap 强制带 `machine_evidence[]` + **台账六级** `confidence` + `unverified[]`；不可满足 → `ok:false`）+ `tests/roco-team-gaps.test.js`（16 条 / **8 条必红反证**）+ `reports/roco/flagship-upgrade/rc-302-team-gaps.json` + `docs/roco/TEAM-GAPS.md`。**实测**：能抗龙系仅 6 只；8 个技能槽超 legacy 上限 6、0 个超 candidate 上限 10；**152/320 技能槽无静态威力 → fail closed**；23/80 build 无应对词条；全箱 304 弱点。**边界**：速度/面板只有 48 只有验证值（其余 574 只大面积 unknown）；synergy 只算属性相性；cost 是工程算术；respond/pivot 是词条判定 |
| RC-303 | 候选生成（全量 600+ → 召回 20～50 → Beam 补全六宠 → Completion Value / Ranker） | **DONE** | `src/coach/team-candidates.mjs`（召回/Beam/Top-K/渐进推荐；纯函数 + 显式注入数据）+ `scripts/roco/measure-team-candidates.mjs` → `reports/roco/team-candidates/latency.json` + `reports/roco/flagship-upgrade/rc-303-team-candidates.json` + `tests/roco-team-candidates.test.js`（12 条 / **8 类反证**）+ `docs/roco/TEAM-CANDIDATES.md`。**实测**：候选宇宙 702（owned 80 ∪ pack 622）、召回 50、三段延迟 P95 召回 21.5ms / Beam+排序 24.8ms / 首屏四段 27.8ms（预算 150/300/800，`over_budget: []`）；**在线禁止模拟是结构判据**（扫源码，94 行命中 0）；**排序器不存在 → `missing` + 规则降级 + 无胜率**（有注入通路测试）。**边界**：Top-K 只是规则启发式（非强度排序）；Beam+Ranker 那格是下界；574 只图鉴精灵的配招合法性未校验 |
| RC-304 | 未知对手下的队伍比较（环境价值 / 最差体系 / 容错 / 覆盖置信） | NOT_STARTED |
| RC-305 | 阵容工坊 UI 与工具合同（`query_owned_roster` / `evaluate_team` / `compare_change`…） | NOT_STARTED |
| RC-306 | 3 秒 Serving 合同（300ms 初判 / 3s 解释 / 分段延迟 / 超时保短结论） | NOT_STARTED |

**P0C 验收**：六宠队伍；600+ 可检索；选 2～5 只时推荐会变；偏好真的改变候选；硬约束零违反；P95 < 3s；页面先诊断后推荐。

## Phase 1A：Capability Compiler 与代表性 Simulator

| RC | 内容 | 状态 |
|---|---|---|
| RC-401 | Effect/Trigger IR 增量迁移（按覆盖收益，不一次重写 68 个原语） | NOT_STARTED |
| RC-402 | 按需 Build Compiler（48 只只是夹具；第 49/301 只复用原语即可进入模拟层） | NOT_STARTED |
| RC-403 | Support Classifier v2（FULL_VERIFIED / SIMULATABLE_UNVERIFIED / PARTIAL / KNOWLEDGE_ONLY / REFUSED） | NOT_STARTED |
| RC-404 | 代表性回归集（18 属性 + 角色 + 速度 + 资源 + 换入离场 + 应对 + 印记 + 天气 + 迅捷 + 传动） | NOT_STARTED |

## Phase 1B：战斗 UX 与 Coach 主链路（**KEEP + revalidate，不许重写**）

| RC | 内容 | 状态 |
|---|---|---|
| RC-501 | 保留并重新验证既有产品资产（多动作比较/未来后果/stale-plan 丢弃/PVP 门控/RAG 证据/mock host） | IN_PROGRESS（规则 candidate 落定后逐项 revalidate） |
| RC-502 | 战斗信息架构（HP、能量/上限、魔力、可见状态、印记、天气、公开后备、四技能） | NOT_STARTED |
| RC-503 | Coach 比较与后果（两个合法动作 + 下一回合机会 + 最大下行 + 规则置信；不展示伪精确胜率） | 已具备（KEEP）/ 待接候选规则 |
| RC-504 | 三角色产品闭环（军师/陪练/老师）+ **真人盲评** | 已具备（KEEP）；盲评 `BLOCKED`（需 3—5 人） |
| RC-505 | 移动端验收（390px 无横向溢出、触控目标、短提示不遮挡） | 已具备（119 条浏览器判据）；六槽改造后需重跑 |

## Phase 1C：算法旗舰线

| RC | 内容 | 状态 |
|---|---|---|
| RC-601 | 规则绑定的轨迹重建（manifest 强制绑 ruleset/engine/data pack/opponent policy/split/sha256） | **BLOCKED**（规则 candidate 未定；且人类明令先不要用旧规则生成轨迹） |
| RC-602 | Team Pairwise Ranker + Partial-team Completion Value | NOT_STARTED |
| RC-603 | Learned Value（P1 必做；由用户在 RTX 3060 亲训） | **DEFERRED 给用户** |
| RC-604 | 对手信念基线（uniform / frequency / 规则策略混合） | NOT_STARTED |
| RC-605 | 工具使用 SFT 重建（含 owned pet compare / team gap / stale / 失败恢复） | **BLOCKED**（依赖 RC-601） |

## Phase 2：可选 RL

| RC | 内容 | 状态 |
|---|---|---|
| RC-701 | 战斗 BC / Policy Prior | NOT_STARTED |
| RC-702 | Self-play 与 RL（需独立 evaluator + reward 审计） | NOT_STARTED |
| RC-703 | Agentic RL（需 SFT 强基线 + 可独立判 reward） | NOT_STARTED |
| RC-704 | 介入学习（规则硬门控不动；3—5 人盲评通过后才能开 `on`） | **BLOCKED**（人在环） |

## Phase 3：旗舰交付

| RC | 内容 | 状态 |
|---|---|---|
| RC-801 | 五分钟 Demo（盒子 → 个体比较 → 锁定 → 补队 → 战斗 → 主动提示 → 展开取舍 → 局末教学） | NOT_STARTED |
| RC-802 | 开发者证据抽屉（默认隐藏 ruleset/support/latency/digest/evidence） | 已具备雏形（`#about-drawer`）；六槽改造后需 revalidate |
| RC-803 | 面试报告 | NOT_STARTED |

## 外部阻塞（不改代码能解决的只有这三件）

1. **一个 DeepSeek key** —— 云臂对照。
2. **3—5 个真人** —— W5-05 陪练盲评、RC-704 开 `on` 的前置。
3. **一次实机录制** —— 优先级最高的几个：**`MC-E08`（标准 PVP 的魔力/力竭，目前证据最弱）**、`MC-E01`（能量上限与聚能）、`MC-E07`（六只上限）、领地试炼 `MC-BM04`；完整清单见 `data/roco/evidence/rule-evidence-microcase-records.json`。

**用户明确延后**：RC-603 Learned Value 训练（用户亲训）、Qwen 27B 部署/微调。

## 最近更新

- 2026-09-21（v3 纠偏第一批）：RC-000、RC-104、BattleMode 登记、六槽 UI 与 3s Serving 拆分、长期 goal 更新。

## 本轮附带修掉的两处真实缺陷（都不是计划，是实测踩到的）

| # | 缺陷 | 判据与证据 |
|---|---|---|
| 1 | **第二个陈旧规划洞**：`autoTurn` 不经过 `requestPlan` 的丢弃路径，于是「计划先到、局面后动」时旧规划会被拿去说话 | `demo-acceptance` 实测红（`plan 版本=30 保留=true`，当前 31）→ 修法放在 `refreshHint` 唯一入口 → 复跑 **119/0** |
| 2 | **按真实时钟算天数的测试**（预存在）：`replay()` 注入 now=今天 22:00 而事件时间戳来自真实时钟，22:00 之后「6 天前」被 floor 成 5 天 | 22:06 实测红（`你上次来是5天前…`）→ 新增 `backdateFrom()` 按注入时钟锚定 + 对 6 个整点验一遍 + 一个两个时间戳都由测试给定的反向控制 |
| 3 | 门禁失败**不可诊断**：`latest.json` 只留尾部 4 行，本轮碰到「`unit` 门禁红、单跑 715/715 绿」却查不出是哪个用例 | 现在每次失败落 `reports/roco/verification/failures/<suite>-<时间>.log`（完整输出） |

## 一条如实登记的语义分歧（留给后面决定，不偷偷选一边）

`companion.js` 里 `daysAgo` 用**毫秒差取整**（`floor((now-t)/DAY)`），而同一份账本里的
`todayCount` / 会话分组用的是**本地日历日**（`dayKeyOf`）。两者对「跨午夜但不足 24 小时」的情形给出不同答案
（昨晚 22:00 → 今晚 21:00：毫秒差算「今天」，日历日算「昨天」）。
修复 #2 时只把**测试**钉成确定性，**没有**改产品语义；要不要统一成日历日语义需要单独一个 RC（有玩家可感知的影响）。

## RC-202 前置条件（`GameDataPackV2` 从 `draft` → `ready` 的 9 项，逐条来自 `CATALOG-RECONCILIATION.md` §9）

| # | 缺什么 | 算做完的标准 |
|---|---|---|
| 1 | 统一 schema（现在三份不同形状的产物，没有共同命名空间） | 带版本号与字段级必填/可空声明的 schema；`record_kind` 词表进 enum；同一校验器校验冻结与派生快照 |
| 2 | 许可逐条落到实体 | 每条（至少每个 `source_scope`）带 `license` + `redistribution`；`REFERENCE_ONLY` **不得**进可分发产物，且有守卫 |
| 3 | 逐实体 provenance（冻结侧目前是层内统一，公网侧已逐条） | 冻结侧补到 `{source_id, artifact_path, artifact_sha256, pointer}`，两侧同一结构 |
| 4 | 冲突处理策略（现在只有「如实记」） | 冲突分类 + 判定（`IDENTITY_CONFLICT` / `VALUE_CONFLICT` / `GRANULARITY_CONFLICT`），未解决时生成器**拒绝**产出 `ready` |
| 5 | 形态口径统一（实测 34 条标注不一致） | 一份两侧都能映射的「形态轴」对照表 + 34 条逐条落表 |
| 6 | 覆盖证明（只比了名字/编号/属性标签） | 字段级逐字段比对（含「快照没有这个字段」的显式分支）+ 覆盖率与冲突数 |
| 7 | 版本/新鲜度绑定 | 数据包带 `ruleset_id` 与 `as_of`；跨来源时间一致性守卫（公网快照早于冻结 revision 则标 `STALE`） |
| 8 | 不可得字段的显式清单 | 契约级 `contains / does_not_contain`，消费侧 fail closed（`FULL-CATALOG.md` 的 `claims.is/is_not` 先例提到契约层） |
| 9 | 对账自动化进闸门（**已完成**：`reconciliation` + `game-data-pack` 两条套件已在闸门登记表里，由 `releaseGateSatisfied()` 判定） | `fetch --check --offline` + `reconcile` + 判据进 `verify-release.mjs` 登记表（由主线程串行维护） |

**纪律**：这 9 项没有全部满足之前，`CONTRACTS.md` 里的 `GameDataPackV2` **保持 `draft`**，
Windows 侧不得据此开始正式训练。
