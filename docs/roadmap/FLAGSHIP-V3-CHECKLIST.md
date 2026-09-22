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
| RC-105 | **BattleMode 驱动的合法行动裁剪与魔力（心）结算**（v3 纠偏插入项；人类 P0：「技能/聚能/换精灵/投降，不要道具与逃跑」「4 心、心没输 PVP」） | **DONE（候选；六宠开局留给 RC-106）** | `data/roco/rulesets/mobile-s4-candidate-v3.json`（energy/turn_order 从 v2 深拷贝逐字复制；新增 `mana{pool 4,faint_cost 1,loss_when_zero,surrender}` 与 `actions{allowed:[skill,charge,switch,surrender], forbidden:[item,escape], unknown_kinds_allowed:false}`；`is_default:false`/`BLOCKED_UNTIL_MICROCASE`）+ 引擎 `ACTION_CHARGE`/`ACTION_SURRENDER`、按配置裁剪合法行动、力竭扣魔力、归零立即判负、mana 进序列化与两个公开视图 + `roco/tests/test_mana_actions.py`（29 条）、`tests/roco-mana-actions.test.js`（6 条）、`reports/roco/rc105/mode-actions-and-mana.json`（8 check + 每条反证原文 + 3 次源码突变复现）、`docs/roco/RC-105-MANA-AND-ACTIONS.md`。**实测**：`test:env` 295 → **324** 全绿、`test:unit` **936**、`build-rule-configs --selftest` 18/18；三条反证真变红（item 挪进 allowed / 扣减改 -0 / legacy 补假 mana:0 ⇒ 两条 golden 指纹不匹配）；**legacy 逐位不变**是硬门。**仓内证据**：冻结 `skills.json` 提到「魔力」的 desc 恰好 6 条全是特性（诈死/付给恶魔的赎价/飓风/图书守卫者/构装契约者/御驾亲征），逐字进配置的 `repo_internal_evidence`；台账未加条目未升降级。**已知阻断**：v3 的 `energy.initial` 仍是 UNKNOWN（MC-E04）⇒ `reset(config=v3)` fail closed，**六宠模式暂时开不了局** |
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
| RC-304 | 未知对手下的队伍比较（环境价值 / 最差体系 / matchup spread / 容错 / 覆盖置信） | **DONE（1/5 轴可算）** | `src/coach/team-compare.mjs`（`compareTeams` / `minimalReplacement`；五轴逐个 `available/unknown_reason/evidence/confidence`）+ 13 组测试（**8 条必红反证 + 1 条反向控制**）+ `reports/roco/flagship-upgrade/rc-304-team-compare.json` + `docs/roco/TEAM-COMPARE.md`。**实测**：`coverage_confidence` 0.851852/0.899225（真算）；环境价值/最差体系/spread/容错 **全 `available:false` + 点名缺什么**（`MetaPriorV1` distribution 全 unknown ⇒ 期望的分母不存在）；**注入 measured 分布后四轴真的亮起**（`environment_value=0.505` 与独立重算逐位相同）⇒ fail closed **不是**「永远 unknown」。**边界**：无真实对局数据前四轴永远 unknown；relative_score/tolerance 真实来源不存在；等权与 0.5 门槛是工程假设；**CVaR/robustness 未实现**；换下谁是结构启发式 |
| RC-305 | 阵容工坊 UI 与工具合同（`query_owned_roster` / `evaluate_team` / `compare_change`…） | **DONE** | `GET /api/roco/workshop`（只读、不经 Python；直连 RC-301 合同 → RC-302 七维 → RC-303 候选 → RC-304 五轴，前端无第二套模板/分数）+ `src/client/team-workshop.js`（`mountTeamWorkshop(rootEl,opts)`，shadow root 内渲染；`workshop.html` 降级为开发夹具）+ `tests/roco-workshop.test.js`（13 条）+ `scripts/roco/browser-workshop-acceptance.mjs`（**35/35 判据 + 15/15 必红反证**）+ `reports/roco/workshop-acceptance/`（6 张截图）+ `docs/roco/WORKSHOP.md`。**实测**：候选池 **622**、真实键鼠连续选入 2/5/6 只、评估随阵容变化、满编四轴 unknown + 覆盖置信可算、最小替换一个、零胜率零百分数、1440/390 无横向溢出。**集成**：六槽工作台按人类要求上移到 `#select-panel` 之前（先让玩家选）|
| RC-306 | 3 秒 Serving 合同（300ms 初判 / 3s 解释 / 分段延迟 / 超时保短结论）**+ 只发 BattleMode 合法行动** | **DONE** | `src/coach/team-serving.mjs`：`serveStages({stages,clock,budgets,withheldStages})` —— 初判只在**必需段全部成功且未踩过 300ms** 时给出（否则 null + 逐条 reason）；超时后不再开始新段；开始后跑过头的段记 `late`；短结论只用预算内成功的段拼；**「主动不要某段」与「超时降级」分开记录**（`full_withheld:"NOT_REQUESTED"` + `degraded:false`）；缺失恒 null、绝不补默认值。`modeActionProblems()` 是 serving 边界第二道闸（第一道在引擎 RC-105）。**接线（第 96 轮）**：`GET /api/roco/workshop?stage=first|full` —— first 只跑 `plan` 一段（`axes=null`、`axes_status=not_requested`，证据段**根本不跑**），非法 stage 400 点名；页面 `team-workshop.js` 两阶段取数（先初判渲染、再原地升级；第二段失败不清空已渲染的初判）。**实测**：契约 12 条单测 + 真实路由 6 条判据（`reports/roco/team-serving/serving.json` 的 `route_stages`）；初判 P95 **18.8ms** / 完整解释 P95 **37.5ms**；浏览器 **41/41 判据 + 27/27 必红反证**；门禁 **17/17** |
| RC-106 | **六宠标准 PVP 能真的开一局**（v3 动态开局 + 绑定改 v3 + 服务/入口按模式选配置） | **DONE** | 引擎：`overrides.py`（未核验覆盖，可覆盖 `energy.initial` 与 `turn_order.speed_tie`，值域/UNKNOWN 双重校验，不写回配置）+ `team_size` 按 `battle_mode` 读 + 绑定 v2→**v3** + charge/mana_loss/surrender 事件句子 + `/battle/new` 接受 `ruleset_config_id`/`unverified_overrides`。**接线**（第 95 轮）：`POST /api/roco/battle/new` 按 `mode` 从登记表取配置与规模、owned 个体→物种 id 换算、`publicView` 暴露 `mana`/`unverified_overrides`/`unverified_notes`；页面新增「开一局（标准 PVP · 六宠）」、资源条读引擎真值、行动坞补「聚能/投降」一级类。**实测**：`test:env` **362 OK**、六宠对局四种子跑完整局（52/49/49/49 回合，终局 0:2 / 3:0 / 0:3 / 3:0 —— **魔力归零判负**）、浏览器验收 **38/38 + 23/23 反证**（`mana=4/4 groups=skill:3,charge:1,switch:5,surrender:1 hidden=0`）、门禁 **17/17**；报告 `reports/roco/rc106/six-pet-battle.json`、文档 `docs/roco/RC-106-SIX-PET-BATTLE.md`（含接线附录）|

**P0C 验收**：六宠队伍；600+ 可检索；选 2～5 只时推荐会变；偏好真的改变候选；硬约束零违反；P95 < 3s；页面先诊断后推荐。

## Phase 1A：Capability Compiler 与代表性 Simulator

| RC | 内容 | 状态 |
|---|---|---|
| RC-401 | Effect/Trigger IR 增量迁移（按覆盖收益，不一次重写 68 个原语） | **IN_PROGRESS（2 条原语 + 2 条特性已落地）** | **尺子**：`coverage.py` → `effect-coverage.json`（579 技能 + 245 特性四档定档、未实现原因按频次排序；覆盖率 = 数据 × **已声明能力**：未声明连击 473/824，声明连击 **507/824**）。**批次一 = 连击**（67 条技能）：静态「N连击」结算、动态写法如实登记、`damage.multi_hit` 只在 v3 声明（legacy 恒定 1 次）；实测 3 连击 19→**57**，46 条技能被结算。**批次二 = 特性层**：新增 `trait-worklist.json`（245 条按技能 id 全覆盖，按「能解锁多少只精灵」排序；触发词只认映射到真实钩子的闭集）；就绪度 registered 14 / ready 2 / effect_unparsed 32 / trigger_unknown 197；入库两条**条件可判**的入场特性（图书守卫者 / 构装契约者，条件 = 魔力值是否为 1，legacy 无魔力 ⇒ 不结算）⇒ 可模拟精灵 **8 → 12 只**，唯特性阻塞 485 → **481 只**。守卫：`test_effect_coverage`(5) + `test_multi_hit`(7) + `test_trait_worklist`(7)；文档 `docs/roco/RC-401-EFFECT-COVERAGE.md`。**下一批**：ready 剩 2 条 → effect_unparsed 32 → trigger_unknown 197（要先有时点证据/钩子）|
| RC-402 | 按需 Build Compiler（48 只只是夹具；第 49/301 只复用原语即可进入模拟层） | **DONE** | `data/roco/derived/on-demand-builds.json`：**622 只 = 冻结已核验 48 + 按需推算 574，跳过 0**。关键事实：全量图鉴每只都带 `learnable_skills`（实测 622/622、**8787 条引用全部**能在冻结 `skills.json` 里解析）——之前「574 只没有配招」不是数据缺失，是没人编。三条纪律：不许发明技能（必须在学额表里且在冻结 skills.json 可解析）、不许冒充已核验（冻结 48 只 `FULL_VERIFIED` 且带 `frozen_build` 对账，推算的 574 只 `SIMULATABLE_UNVERIFIED`）、不许声称最优（选择规则 = 威力降序 → 能耗升序 → skill_id，`ENGINE_HYPOTHESIS`，实测**不复现**冻结那一份：`compiled_matches_frozen=0`）。构建/检查 `scripts/roco/{on-demand-builds-lib,build-on-demand-builds,verify-on-demand-builds}.mjs`（`--check` 逐字节、`--selftest` 9 条必红）；判据 `tests/roco-on-demand-builds.test.js`（9 条）+ `roco/tests/test_on_demand_builds.py`（8 条）；报告 `reports/roco/rc402/on-demand-builds.json`；文档 `docs/roco/RC-402-ON-DEMAND-BUILDS.md`。**引擎**：`data.py` 以叠加方式载入（冻结物种一个字节不动），`Ruleset.build_support_of()` 是唯一读法；roster 默认仍给已核验 48 只（练习局口径，逐位不变），`?support=all` 给全量 622，`evidence_ids` 按档指向 `pets.json#…` / `on-demand-builds.json#…`。**顺带修掉一个真停滞**：`greedy_damage` 把聚能当成换人 → 付不起技能时双方无限换人（200 回合无人力竭、魔力 4/4）。修完图鉴队与 RC-106 队都在 **26 回合**打到魔力归零。**实测**：`test:env` **371 OK**、门禁 **17/17**、轨迹复验 **6048/6048**（派生数据不许进冻结指纹、版本回执描述冻结快照）|
| RC-403 | Support Classifier v2（FULL_VERIFIED / SIMULATABLE_UNVERIFIED / PARTIAL / KNOWLEDGE_ONLY / REFUSED） | **DONE** | `roco/src/roco_env/support.py`（`python3 -m roco_env.support`）→ `reports/roco/rc403/support-classification.json`：按**部件**（配招来源 + 特性 + 四个技能）定档，精灵档描述「作为一只可上场的单位有多少行为真的按规则走」。**刻意不用最坏件规则**——239/245 条特性没登记，最坏件会把 599 只明明能上场、四个技能也都能结算的精灵判成 `KNOWLEDGE_ONLY`。两个清单分开：`unverified_pieces`（结算了但没证据）/ `unsimulated_pieces`（根本不在按规则走）/ `refused_pieces`（明确拒绝的部件）。**实测 622 只**：FULL_VERIFIED **0**、SIMULATABLE_UNVERIFIED **8**、PARTIAL **614**、KNOWLEDGE_ONLY 0；卡点主要在特性（609 只）。守卫 `roco/tests/test_support_classifier.py`（7 条）；文档 `docs/roco/RC-403-SUPPORT-CLASSIFIER.md`。**接口未改**（roster 回执被禁止重跑的轨迹钉着）|
| RC-404 | 代表性回归集（18 属性 + 速度层次 + 资源 + 换入离场 + 应对 + 印记 + 天气 + 迅捷 + 传动） | **DONE（29 条 / 29 维度，3 条不可达已登记）** | `roco/src/roco_env/regression.py`（`python3 -m roco_env.regression [--check]`）→ `reports/roco/rc404/regression-set.json`。**为什么需要**：镜像对局只能压出 14 种事件，印记/天气/应对/持续状态根本不会出现——「引擎支持这些机制」在回归集之前没有证据。**三条判据**：① 空转不算通过（`expect_kinds` 逐条核对；声明「找一条带某机制的精灵」时那条技能必须真的用出来过；自动选首发按**解析出的效果类型**找而不是 desc 里的词——按词会命中「驱散印记」这种反着的机制）；② 不可达如实登记进**顶层** `unreachable`（踩过的坑：这个键被重复赋值，探针结果只活在子结构里，顶层根本看不见）；③ 理由**现算**（`probe_unreachable()` 现场数规范配招里提到该术语的 desc 条数与解析器建模数，不手写借口）。**速度层次**：`speed-order`（冻结层最快 秩序鱿墨 spe130 对最慢 女王蜂 spe40）逐回合记 `first_damage_by_turn`，`expect_first_damage` 要求声明侧过半回合先手；反证=**对调两边先手必须整体翻转**（实测 15/21 → 15/21 翻转，不翻转就说明这条量的不是速度）；`speed-tie` 只要求**可复现**（`random_seeded` 是 MC-E05 未录制的工程权宜，不承诺公平）。**实测**：29 条场景 0 条空转；damage 30 / faint 7 / mana_loss 7 / replacement 6 / **mark_added 1** / **status_added 1 + status_tick 10**；**属性扫描** 18 条，相性倍率分布 1.0×93 / 2.0×11 / 0.5×13 / 3.0×5 / 0.25×18；**不可达 3 条**：天气（没有精灵的规范配招带 weather）、迅捷（31 条 desc 提到、解析器 0 条建模）、传动（57 / 0）；指纹 = 终局摘要 + 事件分布 + 不可达清单，`--check` 与磁盘一致，`check_against()` 也抓「不可达新出现/悄悄消失」；守卫 `roco/tests/test_regression_set.py`（**17 条**，6 条必红方向）；`test:env` **414 OK**；文档 `docs/roco/RC-404-REGRESSION-SET.md`。**边界**：速度只覆盖极端一对（中间档位、先手度、换人后顺序无场景）；同速平手口径等实机录制后重判；引擎一改指纹就该红 |

## Phase 1B：战斗 UX 与 Coach 主链路（**KEEP + revalidate，不许重写**）

| RC | 内容 | 状态 |
|---|---|---|
| RC-501 | 保留并重新验证既有产品资产（多动作比较/未来后果/stale-plan 丢弃/PVP 门控/RAG 证据/mock host） | **DONE（13 条保留资产全绿 + 9 条自检必红）** | 红线写着「不得重写或退化」，但**「保留」两个字本身没有牙**：资产可能悄悄失去判据（脚本被删、产物不再生成、从套件清单里掉出去），而「没红」与「没在跑」在 CI 里长得一样（第 39 轮真的踩过：两条守卫从来没进过 `test:unit` 的显式清单）。所以本轮交付 **`scripts/roco/revalidate-retained-assets.mjs`**：每条资产必须同时具备四样，缺一样就红 —— ① 判据在磁盘上；② **接线**：套件必须在**门禁脚本自己**的清单里（不是「最近一次产物里有」——门禁有 `--quick`，产物天然会缺套件）、`test:unit` 的文件必须在显式清单里、npm 脚本必须真的存在；③ **证据**：机器可读产物在场且满足声明的断言（`exists/verdict_pass/zero_failed/all_ok/`batch_zero_failed`/`all_values_true`/`gate_zero_violations`，取值走点号路径）+ **条数下限**；④ **必红方向**：`--selftest` 入口 / 负数样本 / 报告自己声明每条阈值都能红。**13 条**：Agent 轨迹与工具协议（6048 条回放，structural/replay/grader 三层零失败，**17760 条负数样本全被抓到**）、RAG 证据、Memory 偏好、军师（多动作比较+未来后果）、陪练小芽（三个阈值门全过 + 报告自己声明 `*_can_fail`）、老师复盘、game adapter、mock host、stale-result guard（「版本对不上就作废」）、release guard、PVP 门控（工作台验收逐条全过）、用户 P0 页面能力（39 条真实键鼠判据）、介入层硬门控（**门控窗口里开口 0 次**）。**自检 9 条必红方向**：判据文件消失 / 判据没接线 / 套件掉出门禁脚本 / 套件跑红 / 条数下限抬高 / 批次里有失败 / 缺必红方向 / 字段期望写反 / 负数样本太少。接进门禁成为第 **19** 个套件（`--check --selftest`）；产物 `reports/roco/rc501/revalidation.json`；文档 `docs/roco/RC-501-RETAINED-ASSETS.md`。**边界**：这一层验的是「还在被判据守着」，**不是**「行为一定对」（行为对错由各自判据负责）；证据是最近一次跑出来的，产物陈旧它看不出来；`min_checks` 是手写下限，删掉几条看不出来 |
| RC-502 | 战斗信息架构（HP、能量/上限、魔力、可见状态、印记、天气、公开后备、四技能） | **DONE** | **为什么**：引擎的公开视图**一直在给**印记/增益/防御冷却/能量上限，页面一个都没画；另一个真缺口是引擎按需推算的 574 只（RC-402）在页面上**根本够不到**（选宠页只列冻结 48 只），而 v3 的口径是「候选宇宙全量 600+，48 只只是迁移夹具」。**客户端** `src/client/roco.js`：`fieldFactsHtml()` 逐项只在引擎给了的时候才画 —— 能量「当前 / 上限」（上限读 `energy_max`，拿不到就**只写当前值、不画豆子**）、异常、**印记**（名字是数据里的中文名 + 层数，空集合不写「无」）、**增益**（中文名闭集：`atk/def/spa/spd/spe/power` + 四条属性威力键 `power_water|fight|bug|ice`，闭集外的键显示「未知增益」且原始键只进 `data-ff-unknown-keys`）、蓄力中、防御冷却；`data-roco-field-facts` 把「这一张卡真的渲染了哪些事实」写成属性（DOM 与 `state.view` 靠它对齐）；换人卡补上**换上谁**（`self.pets[target_index].name`，没有就只留位次）；对手那一栏写明「对手的增益不在公开视图里」（不写会把我方那一行读成双方都标了）。**服务端** `publicView()` 原来把引擎已经给的 `defense_cooldown`/`charging` 丢了，现在**只在引擎给了的时候**带出去（旧 fixture 形状不变）。**全量视野开关**（默认关，逐字节不变）：勾上才发 `support=all`（服务端白名单新增这一个取值，别的 400），48 → 622 只；按需推算的卡写明「按需推算的配招 · 未核验」；全量视野下搜索取数上限 200 → 700。**浏览器实测（真实键鼠，7 条判据 + 2 条必红反证）**：默认 `frozen/48/4 页` 且搜不到幽星光 → 真鼠标勾开关 `all/622/52 页` → 真键盘搜「幽星光」卡上「按需推算的配招 · 未核验」→ 真鼠标选进队并开局 → 能量行「能量 ●●2 / 6」与引擎 `self=6 foe=6` 一致 → 真鼠标点「错乱」→ 引擎 `{星陨印记:3}`、页面「印记 星陨印记 ×3」、钩子 `marks=星陨印记:3` → 真鼠标「换上第2位 · 雪影娃娃」再点「防御」→ 引擎 `defense_cooldown=2`、页面「防御冷却 2」。反证：去掉「未核验」标记 / 删掉印记那一行，同一条判据必须红。**并把它接进门禁**：`roco-ux-acceptance` 成为第 **18** 个套件（用户 P0 第 8 条：页面看不到或点不动的能力不得仅凭单元测试标记完成）。单元判据 `tests/roco-page-ux.test.js`（RC-502 共 10 条，含 4 条必红）；文档 `docs/roco/RC-502-BATTLE-INFO.md`。**天气**这一项本轮**不做假的**：引擎里根本没有天气层（`env.py` 把天气效果登记为 `unsupported`），公开视图里也没有这个字段 ⇒ 页面整条不画、也不补一个「无天气」；要等引擎实现天气层之后再说。**边界**：蓄力中（术语 1007）引擎里没有任何技能会置位 ⇒ 浏览器里**驱动不出来**，代码留着但不声称验过；印记只覆盖「技能直接加印记」这一路（特性/回合末那 31 条里的多数在冻结 48 只里驱动不出来）；增益只有己方（对手的增益不在公开视图里，页面照实说明）；全量视野里 574 只配招是推算的，「未核验」只表示能进引擎跑，不等于按规则结算过 |
| RC-503 | Coach 比较与后果（两个合法动作 + 下一回合机会 + 最大下行 + 规则置信；不展示伪精确胜率） | **DONE（v3 候选规则下已有真实键鼠证据）** | 「待接候选规则」这件事本轮落地：标准 PVP 六宠战斗用的是 `mobile_s4_candidate_v3`，教练层的取舍区由 `/api/roco/plan` 现算（公开面 + 固定分析种子，规划侧不碰私有状态）。在工坊验收里新增判据 **36-候选规则下的 Coach 取舍**（真实鼠标点「让小芽看一眼」）：**并列比较 ≥2 条且逐条都是引擎给的合法动作**（`data-cmp-action` 的标签必须逐字出现在 `state.view.legal` 的 label 里 —— 建议不许凭空造动作）、**未来 2—3 回合 ≥2 条**、如实标出置信/未核验、**可见文本里不出现胜率或百分数**。**实测**（v3 六宠局）：并列 **3** 条（`防御`/`啃咬`/`换上第2位`，三条都是引擎当时给的动作）、未来 **5** 条、规则配置 `mobile_s4_candidate_v3`、控制台零报错。**反证 2 条**：建议里混进一个引擎没给的动作（`旋风无敌斩`）必须被抓住；把「胜率 58%」写进取舍区必须被抓住。工坊验收 **42/42 判据 + 29/29 反证**；接进门禁成为第 **21** 个套件。**边界**：「最大下行」是启发式估值（未核验伤害公式），页面照实标「未核验」而不是给一个像胜率的数字；非标准模式（练习局）下的取舍沿用同一套口径，但本轮只对 v3 六宠局留了证据 |
| RC-504 | 三角色产品闭环（军师/陪练/老师）+ **真人盲评** | 已具备（KEEP）；盲评 `BLOCKED`（需 3—5 人） |
| RC-505 | 移动端验收（390px 无横向溢出、触控目标、短提示不遮挡） | **DONE（五个页面 × 两档窄屏 × 同一把尺子；10/10 + 5/5 反证）** | **为什么**：窄屏判据此前**散在四个脚本里**（`roco.html` 在 UX 验收、工坊模块在工坊验收、盒子页在盒子验收、营地页在 M0 验收），**没有任何一处**回答得了「这一版**每一页**在手机上都不横向溢出吗」；而且某一段版式被改坏时只有正好跑那一个脚本才看得见。新增 `scripts/roco/browser-mobile-sweep.mjs`（`npm run roco:mobile-sweep`）：五个公开页面（`index/connect/roco/box/workshop`）× 两档窄屏（**390×844** 与 **360×640**，后者是用户点名之外多加的一档，用途是抓「只在 390 刚好不溢出」的脆弱版式）× 五条判据（不横向溢出 / **声明的**可点控件 ≥44×44 / 主操作在首屏 / 页面真的渲染了（**含 shadow root 文本**）/ 控制台干净）。**筛选菜单是打开着量的** —— 那个状态此前没有任何判据覆盖，而它真的坏过。**实测找到并修掉三个真缺陷**：① 模式徽记写死 `nowrap`，360px 上 `#prematch-chip` 宽 355px ⇒ 整页横向溢出 **7px**，窄屏改成折行；② 筛选菜单是绝对定位浮层，`roco.html` 360px 上菜单一打开 `scrollWidth` **471 > 360**（溢出 111px），贴右又会让左边出屏 ⇒ 窄屏改成**就地展开**；③ 盒子页同样的浮层，390px 上打开后 `scrollWidth` **530 > 390**（溢出 140px）⇒ `box.css` 同一修法。顺带把拇指目标补齐：`#coach-entry` 35px、`.side-tab` 38px、`.filter-reset` 29px ⇒ 窄屏统一 `min-height:44px`（踩坑记录：`.seg .side-tab` 是两个类，单写 `.side-tab` 会被压住，第一版实测仍然 38px）。**修完**：`roco.html` 上声明的 **35 个**可点控件在 390 与 360 上都 ≥44×44；判据 **10/10**；反证 **5/5**（横向溢出 / 控件缩到 30×30 / 主操作推到视口下 / 白屏 / 控制台报错，反证没命中也算失败）。接进门禁成为第 **20** 个套件（14 秒）；产物 `reports/roco/rc505/mobile-sweep.json` + 10 张截图；文档 `docs/roco/RC-505-MOBILE.md`。**边界**：只量**版式**（功能正确性归各自验收脚本）；触控目标**只对声明的范围**判红，整页其它小于 44px 的**只记账**（营地页 36 个、加密配置页 2 个 —— 这两个是 KEEP 老页面，红线不许重写，本轮不为它们改版式；`roco.html` 上还有 21 个，主要是开发者抽屉与默认收起的折叠区）；主操作是逐页**显式声明**的，不是自动猜的；局部 `overflow:auto` 滚动区里的横向溢出不在判据里 |

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
| RC-801 | 五分钟 Demo（盒子 → 个体比较 → 锁定 → 补队 → 战斗 → 主动提示 → 展开取舍 → 局末教学） | **IN_PROGRESS（第 1 段交接已通并进判据）** | **为什么先做这一步**：这条路径的每一段都各自有验收（盒子 22 条、工坊 42 条、UX 39 条、demo 119 条），但**没有任何一条**量过「从盒子走到配队」——实测那里真的是断的：比完两只之后玩家得回产品页按名字再找一遍，「锁定」这一步根本没有出口。**本轮补上交接**：`box.html` 比较栏新增「带上这两只去配队」（对任意两只可用，不要求同种 —— 配队看的是六只互补），真鼠标点一下跳到 `roco.html?team=own-…,own-…`；`team-workshop.js` 接受 `opts.initialSelected` （**只认 `own-\d+` 形状**，认不出的丢掉且不补位），`roco.js` 的 `teamFromUrl()` 只做搬运、不下任何结论；工作台把交接数量写在 `data-tw-handoff` 上，开局按钮读到的规模与带过来的一致，文案如实说「选满六只才能开局（当前 2 只）」。**实测**（真键鼠，盒子验收新增两条 + 两条反证）：入口可用且 138×44；点它 → URL `team=own-0001,own-0002`、工作台 `selected=2 handoff=2`、开局按钮规模 2；反证：把入口禁用 / 把交接数量改成 0，同一条判据必须红。盒子验收 **24/24 + 7/7**，并接进门禁成为第 **22** 个套件。**还差**（下一步）：锁定（盒子里的 `locked` 标记目前只是筛选条件，没有进交接）、局末教学段在这一条链路上的端到端证据，以及「五分钟」这条**时间预算**的判据（目前只判步骤到位、不判耗时）|
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
