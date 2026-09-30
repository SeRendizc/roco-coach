// ── RC-604：对手信念基线（uniform / frequency / 公开事实条件化） ─────────────────
//
// 三条基线（`docs/roadmap/FLAGSHIP-V3-CHECKLIST.md` 的 RC-604 那行：
// 「uniform / frequency / 规则策略混合」）：
//
//   ① `uniformBelief()`        均匀分布：分母 = **候选宇宙大小**（从注入数据数出来，
//                              不是写死的 48 / 600 / 622）。`expected_per_candidate = 1/N`
//                              这句话**只是无信息基线**，不是强度判断、不是胜率。
//   ② `revealedConditioned()`  条件在**已公开**的事实上（对手已亮明的场上精灵的系别 /
//                              速度档、我方阵容、模式规模），只做可复算的筛选 / 加权，
//                              每条权重规则写成 `{输入 → 输出 → 依据}` 的可核对形式。
//   ③ `frequencyBelief()`      需要**真实对局频次数据**。本仓没有这类数据 ⇒ `available:false`
//                              + `unknown_reason` 点名缺什么、去哪拿。**绝不用均匀分布冒充频次。**
//
// 三条共同纪律（每条都有机器判据，见 `STRUCTURAL_CRITERIA` 与
// `tests/roco-opponent-belief.test.js`）：
//   · 每个量都带 `available / unknown_reason / evidence / confidence`（口径与 RC-302/303/304 同形）；
//   · **不造胜率、不造伪精确百分数**：产出里不许出现 win_rate / 强度分 / 概率% 这类字段
//     （`BANNED_CLAIM_KEYS` / `BANNED_CLAIM_WORDS` / 量纲扫描），`%` 只允许出现在
//     「本模块不产出百分数」这种**声明边界**的句子里（`isNegatedClaim` 的否定语境豁免）；
//   · **不偷看**：信念只吃公开信息（对手**场上**那只的可见面板、已亮明的成员与已出招技能、
//     我方阵容、模式规模、版本先验）。配招 / 道具 / 性格 / 天赋 / 个体面板 / 后备血量一律不在公开面
//     —— 传进来就是**拒绝**，而不是静默过滤（静默过滤会让泄漏在报告里查不出来）。
//
//     公开性口径**按实测**（2026-09-30 本仓真引擎三公开面 dump；探针与原始读数：
//     `reports/roco/product-execution/03/probe-03-public-keys.py` / `probe-03-bench-keys.py`
//     + `raw-03.1-engine-public-keys.txt` / `raw-03.1-engine-bench-keys.txt`）：
//       · 对手**场上**那只（`ui_public_view.opponent.field` / `public_planner_state.opponent.field`
//         / `observation_for.opponent` 的场上行）：`hp`/`max_hp`/`energy`/`statuses`/`marks` 是公开的
//         （血条、能量、异常画在屏幕上）；UI 面另给 `name`/`types`/`stats` + `stats_source`
//         （**物种级**：`species-panel` / `species-race`）。`stats_source === 'individual-snapshot'`
//         才是个体真值 ⇒ **拒绝**。
//       · 对手**后备**（`bench[]`）：**未亮明**时只有 `{slot, fainted}`（**没有 `pet_id`**）；
//         亮明之后才追加 `pet_id`/`revealed_via`/`revealed_turn`/`revealed_event_seq`
//         （唯实现 `_bench_public_row()`，`env.py:4229-4250`）。⚠ 本文件旧版注释写着
//         「后备只有位次 / **id** / 是否倒下」—— 那是**错的**（登记为 G9），已按实测更正。
//       · **`speed` / `speed_band` 在三条公开投影里零命中**（探针 `token_scan`）：速度档是本模块调
//         RC-303 `speedBandFor()` 从公开物种速度**现算**的工程三分位构造，不是游戏字段；
//         裸 `speed` 可能是**个体真值** ⇒ 拒绝。只收 `spe` + `spe_source`（出处必须是物种级）。
//       · 已亮明行**必须带来源**（`revealed_via` ∈ opening_preview / switch / replacement，
//         外加 `revealed_turn`）：没有来源的「已亮明」可能是从私有 state 直读的真值。
//
// 数据全部**显式注入**（`catalog` 或注入的 `inputs`），本文件不读盘、不看时钟、不碰 DOM、
// 不调引擎、不起子进程。读盘只发生在 `loadOpponentBeliefInputs()`（离线入口）。
//
// 依赖：只 import 同仓纯函数模块。
//   · `./team-compare.mjs` —— 频次数据的**来源判定**沿用 RC-304 `resolveDistribution()` 的
//     同一条纪律（「标了 measured 却没有 url / 仓内文件 + 日期 ⇒ 不算来源」），
//     并通过 `evidence` / `formatAuditProblem` / `BANNED_UNIT_WORDS` 复用同一套证据形状、
//     审计问题格式与伪精确禁令（**词表只有一份**，不在这里抄第二份）；
//   · `./team-candidates.mjs` 的 `buildCandidateIndex` —— 候选宇宙与**属性相性表 / 速度档**
//     的唯一实现（本模块不复制第二套相性表，也不自己发明速度分档）。

import {fileURLToPath} from 'node:url';

import {
  CONFIDENCE_LEVELS, CONFIDENCE_RANK,
} from './team-gaps.js';
import {speedBandFor} from './team-candidates.mjs';
import {
  BANNED_UNIT_WORDS, evidence, formatAuditProblem,
} from './team-compare.mjs';

/** 报告路径（由 `beliefReport()` 生成，测试比对磁盘上的字节）。 */
export const RC604_REPORT_PATH = 'reports/roco/rc604/opponent-belief.json';
export const RC604_REPORT_VERSION = 'roco-rc604-opponent-belief-report/v1';

/** 三条基线的 ID 与顺序（顺序即输出键序 ⇒ 逐字节可复跑）。 */
export const BELIEF_IDS = Object.freeze(['uniform', 'revealed_conditioned', 'frequency']);

/**
 * 「这个信念有多可信」的分类。
 *
 * 注意它**不是**置信台账（那是 `confidence` 字段，六级）；它回答的是
 * 「这份权重是拿什么算出来的」：
 *   · `non_informative_baseline`：无信息基线（均匀），**不含**任何强度判断；
 *   · `public_fact_conditioned` ：只用已公开事实筛出来的池子 + 可复算权重；
 *   · `measured_frequency`      ：来自带来源的真实对局频次（本仓现在没有）；
 *   · `not_available`           ：算不出来（fail closed），见 `unknown_reason`。
 */
export const BELIEF_KINDS = Object.freeze([
  'non_informative_baseline', 'public_fact_conditioned', 'measured_frequency', 'not_available',
]);

/**
 * 权重依据的**词表**（R2）：任何带 `weights` 的产出都必须声明它是哪一种 ——
 * 少了这一栏，读的人只能自己猜「这一串 0.0068 到底是概率、是频次、还是基线」。
 *   · `non_informative_uniform_baseline`  均匀基线的 1/N（无信息）；
 *   · `uniform_over_pool_baseline`        公开事实筛出的池子内等权（**仅作基线**）；
 *   · `own_speed_tier_downweight`         层内等权 + 层间 2:1 降权（**声明过的假设**，不排除候选）；
 *   · `measured_frequency_distribution`   真实对局频次占比（带来源的计数比）。
 */
export const WEIGHT_BASES = Object.freeze([
  'non_informative_uniform_baseline', 'uniform_over_pool_baseline',
  'own_speed_tier_downweight', 'measured_frequency_distribution',
]);

/** 信念里用的「无信息」声明：给 `expected_per_candidate` 时必须同时给出这一句。 */
export const NON_INFORMATIVE_DECLARATION = '均匀分布的 1/N **是无信息基线**（每条候选一样重），'
  + '它**不是**强度判断、不是胜率、不是「谁更该带」：它唯一的用途是当对照基线，'
  + '让「加了公开事实之后权重变了多少」这件事可被量出来。';

/**
 * 公开性白名单（与 `roco/src/roco_env/env.py::public_planner_state` 逐条对齐）。
 *
 * 为什么是**白名单**而不是黑名单：信念是「我不知道对手要出什么」的形式化，
 * 只要有一个隐藏字段能混进输入，整个信念就变成了「偷看之后的答案」。
 * 白名单让「新字段默认不可用」，而不是「新字段默认可用」。
 */
export const PUBLIC_FACT_FIELDS = Object.freeze({
  // 对手**场上**那只：可见面板（血条 / 能量 / 异常 / 印记）+ 物种级属性与速度（带出处）。
  // 裸 `speed` / `speed_band` **不在**白名单里（见 HIDDEN_FACT_FIELDS.opponent 的注释）。
  opponent_active: Object.freeze(['pet_id', 'species_id', 'name', 'slot', 'types', 'stats', 'stats_source',
    'spe', 'spe_source', 'hp', 'max_hp', 'energy', 'statuses', 'marks', 'fainted', 'source']),
  // 已亮明的成员（= `view.seen_roster` 那一份）：身份 + **来源事件** + 物种级属性 / 速度。
  // 血量 / 能量**不在**这里：后备的血量不是公开信息（`bench[]` 连身份都要亮明后才有）。
  opponent_revealed: Object.freeze(['pet_id', 'species_id', 'name', 'slot', 'types', 'stats', 'stats_source',
    'spe', 'spe_source', 'revealed_via', 'revealed_turn', 'revealed_event_seq', 'fainted', 'source']),
  // 我方阵容：速度可以是个体面板（那是**自己的**信息），但配招 / 天赋 / 性格仍然不进输入面。
  own_team: Object.freeze(['key', 'pet_id', 'species_id', 'types', 'stats', 'stats_source',
    'spe', 'spe_source', 'source', 'slot']),
  mode: Object.freeze(['team_size', 'battle_mode', 'ruleset_config_id']),
  // 01.2 观察契约的三个公开字段：哪一个局面（match_id）/ 哪份规则（rules_version）/ 哪一次决策
  // （decision_id）。**没有就不写**（`provenance.* = null` + `unknowns` 里点名），不自己造。
  provenance: Object.freeze(['match_id', 'rules_version', 'decision_id']),
});

/** 物种级统计的**合法出处**（引擎 `pet_public()` 的 `stats_source` 词表）：是个体真值一律拒绝。 */
export const SPECIES_STAT_SOURCES = Object.freeze(['species-panel', 'species-race']);
/** 我方速度的合法出处：自己那只可以是**个体面板**（那是玩家自己的信息）。 */
export const OWN_SPEED_SOURCES = Object.freeze(['individual-snapshot', 'species-panel', 'species-race']);
/** 「已亮明」的合法来源事件（与引擎 `revealed_facts()` 的 `revealed_via` 同词表）。 */
export const REVEAL_SOURCES = Object.freeze(['opening_preview', 'switch', 'replacement']);
/** 场上那只的默认来源（它不需要亮明事件：名字与血条本来就画在屏幕上）。 */
export const ACTIVE_REVEAL_SOURCE = 'field_on_screen';

/**
 * 明确的**隐藏字段**清单（出现即拒绝）。
 *
 * 列出来的理由：拒绝时能点名「你泄漏的是哪一个」，而不是只说一句「形状不对」。
 * 口径按**实测**（见文件头的三条 + `reports/roco/product-execution/03/raw-03.1-engine-*.txt`）：
 *   · 对手**场上**那只的 `hp`/`max_hp`/`energy`/`statuses`/`marks` 是**公开**的（血条在屏幕上），
 *     所以它们**不在**这里的 `opponent` 行上；但 `stats` 只有在 `stats_source` 是物种级时才收，
 *     是 `individual-snapshot` ⇒ 拒绝（那条判在 `readPublicFacts()` 里，比一张静态名单更准）。
 *   · 裸 `speed` / `speed_band`：**任何一面都没有这两个字段**（探针 token_scan 零命中）。
 *     没有出处的裸速度既可能是个体真值、也可能与 `speedBandFor()` 的档不一致 ⇒ 拒绝，
 *     只收 `spe` + `spe_source`。
 *   · 对手**后备**：**未亮明**时只有 `{slot, fainted}`；身份只能走 `opponent.revealed_pets[]`
 *     （= `view.seen_roster`，自带 `revealed_via`/`revealed_turn`）。
 */
export const HIDDEN_FACT_FIELDS = Object.freeze({
  opponent: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items', 'nature',
    'talent', 'specialty', 'bloodline', 'panel_stats', 'derived_stats', 'build', 'builds',
    'speed', 'speed_band', 'individual_id', 'individual_level', 'panel', 'panel_projection',
    'buffs', 'entered_turn', 'bench', 'bench_details', 'bench_moves']),
  opponent_revealed: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items',
    'nature', 'talent', 'specialty', 'bloodline', 'hp', 'max_hp', 'energy', 'panel_stats',
    'derived_stats', 'build', 'builds', 'speed', 'speed_band', 'individual_id', 'individual_level',
    'panel', 'panel_projection', 'buffs', 'entered_turn']),
  own_team: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items', 'nature',
    'talent', 'specialty', 'bloodline', 'panel_stats', 'derived_stats', 'build', 'builds',
    'speed', 'speed_band', 'individual_id', 'panel', 'panel_projection']),
  root: Object.freeze(['opponent_bench', 'opponent_moves', 'opponent_team', 'opponent_loadout',
    'opponent_hidden', 'opponent_full', 'opponent_nature', 'opponent_items',
    'hidden_opponent', 'enemy_full', 'foe_bench']),
});

/** 规则 ID（`rule_ledger[].id`）与它们要读的公开事实字段。 */
export const RULES = Object.freeze([
  Object.freeze({
    id: 'filter.revealed_types',
    kind: 'filter',
    label: '按对手**已亮明**的场上系别筛候选',
    reads: Object.freeze(['opponent_active.types', 'opponent_revealed.types']),
    basis: '对手场上那只的属性是屏幕上写着的公开信息；候选的属性来自冻结图鉴。'
      + '「能不能接住」沿用 RC-302/303 的防御倍率表（整数标度 ×4，未登记的组合键 = unknown，不猜成 1）。',
  }),
  Object.freeze({
    id: 'filter.opponent_speed_tier',
    kind: 'filter',
    label: '按对手**已亮明**的那只的**物种速度**现算速度档，再分层',
    // ⚠ 2026-09-30（03.1 · H3）：账本的 `reads` 原先写 `...speed`，而实现读的是别人算好的
    // `speed_band` —— 自述与实现不一致（「可复算」就成了空话）。现在**两者取一**：
    // 实现真的去读 `spe` + `spe_source`，并**自己**调 RC-303 的 `speedBandFor()` 现算档位。
    reads: Object.freeze(['opponent_active.spe+spe_source', 'opponent_revealed.spe+spe_source']),
    basis: '**亮明的那只的物种速度**（`spe`，出处必须是 `species-panel` / `species-race`）是公开的'
      + '（引擎 `pet_public()` 的 `stats_source` 词表）；**速度档不是引擎字段** —— 三条公开投影里 '
      + '`speed_band` 零命中（探针 token_scan），它是本模块调 RC-303 `speedBandFor()` 在候选宇宙内'
      + '按三分位**现算**的工程构造（换一份图鉴，分位与档位都会变，所以账本里连着阈值一起留痕）。'
      + '应用口径：**只亮明单一档**时才收窄到同档；一条都没亮明、或快慢两端都亮明时都**不应用**'
      + '（两端亮明 ⇒ 速度对「他会出什么」不再有区分度；实测照两端留会把 mid 档 237 只全剔掉）。'
      + '速度值缺失 ⇒ 不应用（记 `not_applied`），池子因此更宽 —— 宽是安全的，窄才是编的。',
  }),
  Object.freeze({
    id: 'weight.own_speed_tier_match',
    kind: 'weight',
    label: '按**我方阵容**已有的速度档给候选**降权**（不排除）',
    reads: Object.freeze(['own_team.spe+spe_source']),
    basis: '这是玩家自己的信息（自家阵容的速度层次），与对手无关；用它把候选池按速度档**分层**。'
      + '⚠ 2026-09-30（03.1 · R4 裁决）：本规则**只降权、不把候选压 0** —— 「我方速度层次」'
      + '不构成任何一只对手候选「不可能上场」的证据，压 0 等于声称不可能，与「同一伤害由两种'
      + '配置都能解释时两者都留」直接冲突。权重是**声明过的假设**（选中层 : 其它层 = 2 : 1，'
      + '写进规则的 `assumption`），层内仍然等权。真正允许**排除**候选的只有公开证据'
      + '（已出技能 / 先手关系 / 可见伤害等）与它的证据 ID，见 `evidence_exclusions`。',
  }),
]);

export const RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));
const RULE_BY_ID = Object.freeze(Object.fromEntries(RULES.map((rule) => [rule.id, rule])));

/**
 * fail closed 的原因。**点名缺什么 / 去哪拿**，不是「差不多」。
 * 报告、文档与测试都引用这些常量，改一处不会三处漂移。
 */
export const FAIL_CLOSED_REASONS = Object.freeze({
  CATALOG_MISSING: '缺**候选宇宙**：没有注入 catalog（或注入的 catalog 里一条候选都数不出来）。'
    + '均匀分布的分母 = 候选宇宙大小，没有宇宙就没有分母；'
    + '本模块**不写死** 48 / 600 / 622 这类数字（写死分母 = 编数据）。'
    + '拿法：注入 `buildCandidateIndex(await loadTeamCandidatesInputs({root}))`（RC-303 的同一份索引）。',
  FREQUENCY_NO_DECLARED_SOURCE: '缺**频次数据的来源声明**：注入的频次数据没有声明它是从哪来的'
    + '（顶层 `declared_source` 必须是 "measured" 之类的实测声明，且每一行都要有 `scope` 与 `revision`）。'
    + '没有来源的数字 = 编出来的数字，所以整份输入被**拒绝**，退化成 available:false；'
    + '均匀分布**不会**被拿来顶替频次（那正是「用无信息基线冒充实测」这个错误的写法）。'
    + '去哪拿：① 实机对局统计（游戏内匹配记录 / 赛季数据面板导出，需 url 或仓内文件 + 日期）；'
    + '② 玩家自己提供的对局记录（匿名化的队伍-出场频次表，需说明样本量、时间窗与采集方式）；'
    + '③ 离线联赛 / 自博弈产物（本仓现在也**没有**，且 RC-601 的规则绑定还 BLOCKED）。',
  FREQUENCY_NO_MEASURED_SOURCE: '缺**逐条可核对的来源**：注入的频次数据标了实测，'
    + '但至少一行没有 url / 仓内文件 + 日期（RC-304 的 `resolveDistribution()` 用的是同一条纪律）。'
    + '本模块只检查「有没有来源」，**不联网核对来源真实性** —— 没有来源就 fail closed，'
    + '有来源也只声明「来源在场」，不声明「数字是对的」。',
  FREQUENCY_ROWS_UNUSABLE: '缺**可用的频次行**：注入的 `frequency[]` 是空的，或者每一行都缺'
    + ' `species_id` / 非负整数 `count` / 非空 `scope` / 非空 `revision`。'
    + '行数不足时整份拒绝（不许只挑能用的那几行算一个「看起来差不多」的分母）。',
  REVEALED_LEAKED_HIDDEN_FACTS: '公开事实的**输入越界**：注入的事实里出现了隐藏字段'
    + '（对手配招 / 后备身份 / 道具 / 性格天赋 / 构建 / 裸速度值等）。'
    + '这些不在公开面上（实测口径见文件头三条与 `reports/roco/product-execution/03/'
    + 'raw-03.1-engine-*.txt`：未亮明的后备只有 `{slot, fainted}`；`speed`/`speed_band` 三面零命中），'
    + '本模块**拒绝**整个输入而不是静默过滤 —— 静默过滤会让泄漏在报告里查不出来。'
    + '请只传 `PUBLIC_FACT_FIELDS` 里的字段。',
  REVEALED_NO_PROVENANCE: '缺**亮明来源**：某条「已亮明」的成员没有 `revealed_via`'
    + '（合法值：opening_preview / switch / replacement）或没有整数 `revealed_turn`。'
    + '没有来源的「已亮明」无法与「从私有 state 直读的整队」区分开 —— 前者是公开史，后者是偷看，'
    + '而两者在输入形状上一模一样。所以缺来源即**拒绝**，不给它一个「看起来也像公开」的位置。'
    + '拿法：`view.seen_roster[]` 逐行就是 `{slot, pet_id, name, revealed_via, revealed_turn}`。',
  REVEALED_INDIVIDUAL_FACTS: '**个体真值越界**：注入的速度 / 面板带的是个体口径的出处'
    + '（`stats_source` / `spe_source` 为 `individual-snapshot`，或干脆没有出处）。'
    + '对手的个体面板、天赋、性格、真实六维都不在公开面上（引擎 `pet_public()` 对对手只会给'
    + ' `species-panel` / `species-race`）；屏幕上看到的是**物种级**数值。'
    + '把个体真值喂进信念 = 直接偷看。收法：只传 `spe` + `spe_source`（物种级），'
    + '或在 `stats` 上带 `stats_source: species-panel | species-race`。',
  REVEALED_EMPTY_POOL: '缺**可用候选**：公开事实把候选池筛空了。'
    + '收窄到空集不是「更精确」，而是「没有可说的」；退回均匀分布同样是编 ——'
    + '空池必须如实报 available:false，并点名是哪几条规则把它筛空的。',
  REVEALED_EMPTY_STRATUM: '缺**非空速度层**：加权规则选中的速度档在候选池里一条都没有。'
    + '⚠ 2026-09-30（03.1 · R4 裁决）之后这一条是**防御性不变量**：本规则只降权、不压 0，'
    + '而且选中层是从「池子里真的存在的档」里挑的 ⇒ 正常路径上不会发生。'
    + '一旦发生就说明选择逻辑坏了，此时 fail closed 比交出一份全 0 权重诚实。',
  REVEALED_NO_RULE_APPLIED: '缺**可应用的规则**：公开事实一条规则都驱动不起来'
    + '（没有已亮明的对手系别、也没有任何候选 / 我方成员带速度值）。'
    + '这时「条件化」没有任何输入，均匀基线已经是全部能说的东西 —— '
    + '所以这一条**拒绝**，而不是把均匀分布换个名字交出去。',
});

/** 结构判据正文（报告里逐条贴出来，与实现同源；测试逐条注入反证）。 */
export const STRUCTURAL_CRITERIA = Object.freeze({
  denominator_from_data: '均匀基线的分母 = **从注入数据数出来的**候选宇宙大小：'
    + '同一份代码换一份更小的 catalog，`universe_size` 与 `expected_per_candidate.denominator` 必须跟着变，'
    + '`available:false` 与 `unknown_reason` 也必须跟着给出。分母写死（48 / 600 / 622）⇒ `DENOMINATOR_NOT_FROM_DATA`（红）。',
  non_informative_declared: '`uniformBelief()` 给出 `expected_per_candidate` 时**必须**同时给出'
    + ' `declared_semantics`（含「无信息基线 / 不是强度判断」）与 `red_lines[]`；'
    + '把 1/N 说成强度或期望胜率 ⇒ `NON_INFORMATIVE_NOT_DECLARED`（红）。',
  public_facts_only: '公开事实的键必须落在 `PUBLIC_FACT_FIELDS` 白名单里；出现 `HIDDEN_FACT_FIELDS`'
    + '（对手配招 / 后备身份 / 道具 / 性格天赋 / 构建 / 裸速度值）里任何一个键 ⇒ **拒绝整个输入**'
    + '（`available:false` + 点名路径）⇒ `PUBLIC_FACTS_BOUNDARY`（红）。静默忽略也算红：'
    + '「忽略」在产出里看不出来，「拒绝」才看得出来。口径不是抄来的：见 `03.1` 的真引擎三面 dump。',
  provenance_required: '公开事实里每一条「已亮明」的成员都必须带**来源事件**（`revealed_via` ∈ '
    + 'opening_preview / switch / replacement + 整数 `revealed_turn`），速度必须带**物种级出处**'
    + '（`spe_source` / `stats_source` ∈ species-panel / species-race）。缺来源 ⇒ 拒绝整个输入'
    + '（`REVEALED_NO_PROVENANCE` / `REVEALED_INDIVIDUAL_FACTS`）。为什么：输入形状上'
    + '「公开亮明的整队」与「从私有 state 直读的整队」长得一模一样，只有来源能区分它们。',
  no_assumption_zeroing: '条件化信念的逐条权重**不许出现 0**：仅凭「我方阵容的速度层次」这类'
    + '假设把候选压 0 = 声称这只「不可能上场」，而假设不是证据。允许的排除只有**公开证据**'
    + '（已出技能 / 先手关系 / 可见伤害…）并必须把证据 ID 写进排除理由；'
    + '违反 ⇒ `ASSUMPTION_ZEROES_CANDIDATE`（红）。权重还必须显式声明它是哪种基线'
    + '（`weights.basis` ∈ own_speed_tier_downweight / uniform_over_pool），缺声明 ⇒ '
    + '`WEIGHT_BASIS_NOT_DECLARED`（红）。',
  no_illegal_loadouts: '候选里的技能组合必须**合法**：`skills.legality.kept` 不超过四技能、无重复、'
    + '每条都在这只的可学池里，而且与 `legalSkillLoadout()` 的独立复算一致；'
    + '违反 ⇒ `ILLEGAL_LOADOUT_IN_CANDIDATES`（红）。已知不合法的组合**一个都不许进候选**，'
    + '被排除的必须逐条写出理由（不静默丢）。',
  no_probability_without_frequency: '没有真实频次数据时，三种表达（uniform / 情景集合 / 区间）'
    + '各自都必须带语义声明：`is_probability:false` + 「为什么它是基线/区间而不是概率」；'
    + '区间必须带量纲与语义、`best_scenario` 必须是 `null`（不给最优结论）；'
    + '违反 ⇒ `SCENARIO_SEMANTICS_NOT_DECLARED` / `SCENARIO_RANKS_A_SCENARIO`（红）。'
    + '降级（空候选 / 矛盾证据 / 预算裁剪）必须 `degraded:true` + 逐条原因，且每个情景标 `complete:false`；'
    + '`available:false` 时不许带任何情景或区间 ⇒ `OUTLOOK_DEGRADED_WITHOUT_REASON`（红）。',
  truncation_visible: '候选被预算裁剪时，产出必须带**完整的截断信息**：候选总数 / 可用总数 / 保留数 / '
    + '被截断数与其分布 / 截断依据（可解释规则）；缺项或与 `budget` 不一致 ⇒ `TRUNCATION_INFO_MISSING`（红）。'
    + '**被裁掉的重大威胁必须逐条点名**（candidate_id + threat_level + why + evidence_ids）：'
    + '缩减可以裁，但不许隐去重大威胁 ⇒ `THREAT_HIDDEN_BY_TRUNCATION`（红）。'
    + '「重大威胁」的口径只用公开数据（候选系别 × 我方阵容系别 × 冻结相性表），见 `THREAT_RULE`。',
  rules_recomputable: '每条规则必须给出 `{id, kind, reads[], inputs[], output, basis, applied}`；'
    + '`applied:true` 的规则必须给出非空的 `output`（匹配数 / 层大小）。'
    + '规则账本缺字段、或 `applied:true` 却没有输出 ⇒ `RULE_LEDGER_INCOMPLETE`（红）。',
  weights_sum_to_one: '`available:true` 的信念必须给出精确权重（分子 / 分母整数对），'
    + '归一化后必须**恰好**合计 1（分数运算，不是浮点近似）；`available:false` 的信念'
    + '必须 `weights:null` 且没有任何数值 / 量纲 ⇒ `AVAILABILITY_SHAPE`（红）。'
    + 'unknown 不许拿一个数（含 0）顶替。',
  frequency_needs_real_source: '`frequencyBelief()` 只在注入的频次数据**带可核对来源**'
    + '（顶层实测声明 + 每行 url / 仓内文件 + 日期 + scope + revision）时才 `available:true`；'
    + '没有来源 / 没有行标签的一律**拒绝**并在 `unknown_reason` 里写清「缺什么、去哪拿」。'
    + '用均匀分布冒充频次 ⇒ `FREQUENCY_FAKED`（红）—— 这是本 RC 最想防的那一个错误。',
  no_pseudo_precision: '产出与渲染文本里不许出现胜率 / 概率 / 百分数 / 强度分 / 榜单标签'
    + '（T0 / 强势 / 必带…）与 `BANNED_CLAIM_KEYS` 里的键名；命中即 `PSEUDO_PRECISION`（红）。'
    + '`weights[].unit` 里出现 `BANNED_UNIT_WORDS`（胜率 / 概率 / 百分比 / %）同样判红：'
    + '量纲是伪精确最常见的藏身处。扫描范围只排除 `definition` / `criteria` / `basis` 与反证留痕，'
    + '**键名检查不受豁免**。',
  evidence_and_confidence: '每份信念必须有非空 `evidence[]`（`source_file` + `pointer` + `field`），'
    + '`confidence` 必须命中台账六级；`available:false` 时 `confidence` 只能是 `UNKNOWN`，'
    + '否则 `EVIDENCE_MISSING` / `CONFIDENCE_NOT_IN_LEDGER`（红）。',
  online_no_engine: '把 `src/coach/opponent-belief.mjs` 的在线段（`ONLINE_SECTION_MARKER` **定义行之后**、'
    + '`OFFLINE_SECTION_MARKER` **之前**）逐行取出、剥掉行注释与块注释，再对每行做 '
    + '`FORBIDDEN_ONLINE_PATTERNS[].pattern` 的子串匹配：命中即 `ONLINE_ENGINE_CALL` / '
    + '`ONLINE_SUBPROCESS_CALL`（红）。判据是**源码结构**，不是注释声明。'
    + '⚠ 2026-09-30（F-03-1）：旧口径取的是标记串**第一次出现之前**的正文 —— 那正是定义行自己，'
    + '于是「在线段」只剩 69 行文件头，判据**覆盖为空**却显示干净（假绿）。现在还要查**覆盖**：'
    + '在线段必须定义全部 `ONLINE_ENTRYPOINTS`，缺一个 ⇒ `ONLINE_COVERAGE_INCOMPLETE`（红）。',
  deterministic: '同一份输入连续两次调用（含重新从同一份数据构造 catalog），'
    + '三条基线 + 报告正文的 `JSON.stringify` 必须逐字节相同（含 tie-break 与排序），'
    + '否则 `NONDETERMINISTIC`（红）。',
});

// ─────────────────────────────────────────────────────────────────────────
// 在线 / 离线边界：在线段不许出现引擎、子进程、引擎客户端
// ─────────────────────────────────────────────────────────────────────────

/**
 * 在线段禁止出现的调用模式（与 RC-303/304 同形：命中一条就是**结构判据失败**）。
 *
 * 注意 `'frequency'` 这类词不在表里：本模块的在线段必须能讨论频次数据。
 * 表里只放「一旦出现就说明有人在信念里跑模拟」的东西。
 */
export const FORBIDDEN_ONLINE_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL', pattern: 'step_joint',
    detail: '在线信念里出现引擎的联合推进入口：信念只吃公开事实，跑模拟是离线产标签的事',
  }),
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL', pattern: 'plan_actions',
    detail: '在线信念里出现引擎的规划入口：那属于离线 league / 自博弈（RC-702）',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'child_process',
    detail: '在线信念里出现子进程模块：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'spawn',
    detail: '在线信念里出现 spawn：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'roco-client',
    detail: '在线信念里出现 Python 引擎客户端：在线路径不连接引擎',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'RocoClient',
    detail: '在线信念里出现 Python 引擎客户端类：在线路径不连接引擎',
  }),
]);

/** 哪些是**离线**入口（读盘 / 报告生成）；在线路径不许调用。 */
export const OFFLINE_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    id: 'loadOpponentBeliefInputs',
    what: '读盘加载 RC-303 的候选索引输入；**在线路径不许调用**（在线只用注入的 catalog）。',
    caller: '测试与报告生成（Node 侧）',
  }),
  Object.freeze({
    id: 'beliefReport',
    what: '生成机器可读报告；纯函数，不做在线信念计算。',
    caller: 'tests/roco-opponent-belief.test.js',
  }),
  Object.freeze({
    id: 'buildMeasuredFrequencySample',
    what: '构造一份**带来源**的频次对照样例（证明接口不是恒 unknown，同时不冒充已测数据）。',
    caller: '测试与报告生成',
  }),
]);

/** 哪些是**在线**入口。审计逐条扫它们的源码段。 */
export const ONLINE_ENTRYPOINTS = Object.freeze([
  'uniformBelief', 'revealedConditioned', 'frequencyBelief', 'auditOpponentBelief',
  'readPublicFacts', 'buildCandidateUniverse', 'normalizeFrequencyInput', 'applyRules',
  'collectClaimText', 'renderBeliefText', 'exact',
  'readOpponentView', 'buildOpponentCandidates', 'legalSkillLoadout',
]);

/**
 * **在线段的起点**（审计扫的是这一行**之后**、`OFFLINE_SECTION_MARKER` **之前**的正文）。
 *
 * ⚠ 2026-09-30（F-03-1 修复）：这个常量原先写在文件最前面，而 `onlineSectionOf()` 用
 * `text.indexOf(ONLINE_SECTION_MARKER)` 找边界 —— 命中的正是**这一行定义自己**，
 * 于是「在线段」只剩文件头注释（实测 69 行），**所有在线函数一行都没被扫**：
 * 审计声称覆盖在线路径，实际覆盖为空（判据假绿）。
 *
 * 现在边界写在这里（判据 / 白名单 / 词表这些**声明**之后，纯在线代码之前），
 * 并且 `onlineSectionOf()` 从**定义行的行尾**开始切，不再命中定义本身。
 * 判据不只看命中数，还要求**覆盖到全部 `ONLINE_ENTRYPOINTS`**（见 `onlineSectionCoverage()`）——
 * 段子再变空 ⇒ `ONLINE_COVERAGE_INCOMPLETE`（红），不会再静默通过。
 */
export const ONLINE_SECTION_MARKER = '<!-- ONLINE-SECTION-END -->';

// ─────────────────────────────────────────────────────────────────────────
// 小工具（确定性优先：分数用整数运算，绝不靠浮点近似）
// ─────────────────────────────────────────────────────────────────────────

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const arr = (value) => (Array.isArray(value) ? value : []);
const stableJson = (value) => JSON.stringify(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const sortedKeys = (object) => Object.keys(object ?? {}).sort((a, b) => (a < b ? -1 : 1));

const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/**
 * 精确分数：`{numerator, denominator, value}`。
 *
 * 为什么不用裸浮点：均匀分布的 `1/N` 用浮点写出来是 `0.0016077170418006431`，
 * 两个这样数相加不等于 `2/N`，于是「权重合计 = 1」这条判据只能靠容差，
 * 而容差正是伪精确的温床。这里权重全程用整数分子 / 分母，只在**展示**时给小数。
 */
export function exact(numerator, denominator = 1) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return {numerator: null, denominator: null, value: null};
  }
  const sign = d < 0 ? -1 : 1;
  const g = gcd(Math.abs(Math.round(n)), Math.abs(Math.round(d))) || 1;
  const num = (Math.round(n) * sign) / g;
  const den = (Math.round(d) * sign) / g;
  return {numerator: num, denominator: den, value: Number((num / den).toFixed(12))};
}

/** 分数相加（整数运算，不做浮点累加）。 */
const addExact = (a, b) => exact(a.numerator * b.denominator + b.numerator * a.denominator,
  a.denominator * b.denominator);
const compareExact = (a, b) => (a.numerator * b.denominator) - (b.numerator * a.denominator);

/** 序列化一条精确权重（键序固定 ⇒ 逐字节可复跑）。 */
const weightRow = (key, weight, unit, note) => ({
  key,
  numerator: weight.numerator,
  denominator: weight.denominator,
  value: weight.value,
  unit,
  note: note ?? null,
});

/** 审计问题：`{code, where, detail}`（与 RC-302/303/304 同形）。 */
const auditProblem = (code, where, detail) => ({code, where, detail});
export {formatAuditProblem};

export const WEIGHT_UNIT = '信念权重（0～1 的**非负权重**，同一份信念内合计恰好 1；不是胜率、不是概率预测）';
export const EXPECTED_UNIT = '均匀分布的期望权重 = 1 / 候选宇宙大小（**无信息基线**，不是强度、不是胜率）';
export const POOL_UNIT = '候选池占比（入选候选数 / 候选宇宙大小；是计数比，不是把握度）';
export const COUNT_UNIT = '计数（条）';

/**
 * 让任意文本里的禁止词**不可见**：判据扫的是产出的**结构**，而不是用来测试判据的样本。
 *
 * 为什么不直接删掉这些反证样本：报告要留痕「这条判据真的会红」，
 * 所以测试的改坏动作是「往产出里塞一个 win_rate 键」，样本本身必须存在。
 * 这里在写入报告前把它拆成 `w''in_rate` 的形式 —— 结构判据（键名精确匹配）不受影响，
 * 而「报告正文不许出现胜率字样」这条人读判据仍然成立。实现与测试用同一个函数，不会各自漂。
 */
export const obscureBannedWords = (text) => {
  let out = String(text ?? '');
  for (const word of [...BANNED_CLAIM_WORDS, ...BANNED_UNIT_WORDS, '%']) {
    if (word.length === 0) continue;
    out = out.split(word).join(`\u2039${word}\u203A`);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────
// 候选宇宙：分母从数据数出来
// ─────────────────────────────────────────────────────────────────────────

/**
 * 数出候选宇宙（**分母**）。只认注入数据里真的有的东西，数不出来就是 0（不是 48、不是 622）。
 *
 * 认两种形状：
 *   · RC-303 的 `buildCandidateIndex()` 产物（`packPetEntities` / `universeSpecies` /
 *     `speciesFeature` / `instances`）—— 报告与测试走这条；
 *   · 朴素对象（`{pets:[{species_id,types,speed,...}], owned:[...]}`）—— 小夹具走这条。
 *
 * 去重口径：**物种**（owned 的 48 个物种在 pack 的 622 只里全都存在 ⇒ 本仓实测并集 = 622；
 * 这行注释不是断言，判据是从注入数据现算的，换一份数据分母就跟着变）。
 */
export function buildCandidateUniverse(catalog) {
  const list = [];
  const seen = new Set();
  const extraKeys = [];
  const push = (speciesId, source, types, speed, note) => {
    if (!isNonEmptyString(speciesId) || seen.has(speciesId)) return;
    seen.add(speciesId);
    list.push({
      key: speciesId,
      species_id: speciesId,
      types,
      speed,
      // 速度档：**只调用 RC-303 的 `speedBandFor()`**（候选宇宙内三分位），
      // 本模块不另立一套分档 —— 两套分档会让「速度层次」这件事有两个答案。
      speed_band: speedBandOf(catalog, speed),
      source,
      note: note ?? null,
    });
  };

  const isIndex = isPlainObject(catalog) && typeof catalog.featureFor === 'function';

  if (isIndex) {
    // ① RC-303 的 `buildCandidateIndex()` 产物：候选宇宙 = `universeSpecies`，
    //    属性 / 速度从 `featureFor()` 取（**唯一**的特征实现，不自己再读一遍盘）。
    for (const speciesId of [...(catalog.universeSpecies ?? [])].sort((a, b) => (a < b ? -1 : 1))) {
      const feature = catalog.featureFor(speciesId) ?? {};
      push(speciesId,
        feature.evidence?.types?.source_file ?? feature.types_source ?? 'injected:catalog',
        Array.isArray(feature.types) ? [...feature.types] : null,
        Number.isFinite(feature.spe) ? Number(feature.spe) : null,
        Number.isFinite(feature.spe) ? `spe_status=${feature.spe_status}` : '速度值缺失 ⇒ 不进速度层');
    }
  } else if (isPlainObject(catalog)) {
    for (const row of arr(catalog.packPetEntities)) {
      push(row?.entity?.id ?? row?.species_id ?? null,
        isNonEmptyString(row?.pointer) ? `data/roco/game-data-pack/v2/pack.json#${row.pointer}` : 'pack',
        arr(row?.entity?.tags?.types).length ? [...row.entity.tags.types] : null,
        Number.isFinite(row?.entity?.stats?.spe) ? Number(row.entity.stats.spe) : null,
        'pack 图鉴物种');
    }
    for (const row of arr(catalog.pets)) {
      push(row?.species_id ?? row?.pet_id ?? row?.id ?? null, row?.source ?? catalog.source ?? 'injected:catalog.pets',
        arr(row?.types).length ? [...row.types] : null,
        Number.isFinite(row?.speed) ? Number(row.speed) : (Number.isFinite(row?.spe) ? Number(row.spe) : null),
        row?.note ?? null);
    }
    for (const row of arr(catalog.owned)) {
      push(row?.species_id ?? row?.pet_id ?? row?.id ?? null, row?.source ?? 'injected:catalog.owned',
        arr(row?.types).length ? [...row.types] : null,
        Number.isFinite(row?.speed) ? Number(row.speed) : null, '箱子实例（按物种去重）');
    }
    for (const key of sortedKeys(catalog)) {
      if (!['packPetEntities', 'pets', 'owned', 'source', 'note'].includes(key)) extraKeys.push(key);
    }
  }

  list.sort((a, b) => (a.species_id < b.species_id ? -1 : 1));
  const withTypes = list.filter((row) => arr(row.types).length > 0);
  const withSpeed = list.filter((row) => Number.isFinite(row.speed));
  return {
    size: list.length,
    members: list,
    members_with_types: withTypes.length,
    members_with_speed: withSpeed.length,
    ignored_catalog_keys: extraKeys.sort((a, b) => (a < b ? -1 : 1)),
    // 相性判定器：只复用 RC-303 索引里的 `scaleByCombo`（整数标度 ×4，未登记 = null）。
    // 本模块**不复制第二张相性表** —— 相性只有一份实现（`buildGapIndex()` 从冻结 types.json 预计算）。
    scale_lookup: isIndex ? scaleLookup(catalog) : null,
    evidence: [
      evidence('injected:catalog', isIndex ? 'catalog.universeSpecies' : 'catalog', 'universe_size', list.length,
        '均匀基线的分母：从注入数据现数（pack 物种 ∪ owned 物种，按物种去重），不是写死的 48 / 600 / 622'),
      evidence('injected:catalog', isIndex ? 'catalog.featureFor()' : 'catalog', 'members_with_types', withTypes.length,
        '带属性数据的候选数（属性相性规则只能在这部分上判；缺属性的候选按「不知道」处理，不猜成 1 倍）'),
      evidence('injected:catalog', isIndex ? 'catalog.featureFor()' : 'catalog', 'members_with_speed', withSpeed.length,
        '带速度值的候选数（速度规则只能在这部分上分层；缺速度的候选不进速度层）'),
    ],
  };
}

/** 相性判定器的**唯一**入口：拿 RC-303 的 `scaleByCombo`，不自己造表。 */
function scaleLookup(catalog) {
  const table = catalog?.scaleByCombo;
  if (!(table instanceof Map)) return null;
  return (types, attackType) => {
    const row = table.get(arr(types).join('|'));
    if (!row) return null;
    return row.has(attackType) ? row.get(attackType) : 4;
  };
}

/**
 * 速度档：**只**调用 RC-303 的 `speedBandFor()`（它按候选宇宙的三分位分档），
 * 本模块不另立一套分档 —— 两套分档会让「速度层次」有两个答案。
 * 没有速度值（或索引里没有分位表）就是 `null`：**不进速度层**，也不猜一个档。
 */
function speedBandOf(catalog, speed) {
  if (!Number.isFinite(speed)) return null;
  const index = isPlainObject(catalog) && typeof catalog.featureFor === 'function' ? catalog : null;
  if (index === null || typeof speedBandFor !== 'function') return null;
  const band = speedBandFor(index, speed);
  return isNonEmptyString(band) ? band : null;
}

// ─────────────────────────────────────────────────────────────────────────
// 公开事实：只认白名单；隐藏字段出现即**拒绝**（不是忽略）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 读公开事实。**白名单 + 越界即拒绝 + 来源必填**（2026-09-30 · 03.1 的 H1/H2/H4/H5）。
 *
 * 拒绝（而不是忽略）的理由：忽略在产出里看不出来（池子只是小了一点），
 * 拒绝会在 `available:false` + `unknown_reason` 里逐条点名 —— 泄漏必须可见。
 *
 * 三类问题各有**类别码**（`leaked[].code`），调用方据此挑 `unknown_reason`，不靠字符串猜：
 *   · `HIDDEN_FIELD`    —— 键名本身在隐藏清单里（配招 / 道具 / 天赋 / 裸速度…）；
 *   · `NO_PROVENANCE`   —— 「已亮明」却没有来源事件（无法与私有 state 直读区分）；
 *   · `INDIVIDUAL_FACTS`—— 速度 / 面板带的是个体口径出处（`individual-snapshot` 或没出处）；
 *   · `BENCH_IDENTITY`  —— 未亮明的后备里出现了身份 / 面板（`bench[]` 只该有 `{slot, fainted}`）。
 *
 * @returns {{ok:boolean, leaked:Array<{path:string,field:string,why:string,code:string}>,
 *   ignored:Array<string>, facts:object, evidence:Array<object>}}
 */
export function readPublicFacts(publicFacts) {
  const leaked = [];
  const ignored = [];
  const facts = isPlainObject(publicFacts) ? publicFacts : {};
  const pushLeak = (path, field, why, code) => leaked.push({path, field, why, code});

  // ① 顶层：隐藏键即拒绝；白名单外的未知键记账（不静默丢）。
  const ROOT_ALLOWED = ['opponent', 'own_team', 'mode', 'provenance'];
  for (const key of sortedKeys(facts)) {
    if (HIDDEN_FACT_FIELDS.root.includes(key)) {
      pushLeak(key, key, '顶层隐藏字段（对手的完整队伍 / 后备 / 配招）', 'HIDDEN_FIELD');
    } else if (!ROOT_ALLOWED.includes(key)) {
      ignored.push(key);
    }
  }

  const opponent = isPlainObject(facts.opponent) ? facts.opponent : {};
  // ② `opponent` 的子键也只认三个：多出来的（含 bench 的别名、私有块）记账，不静默丢。
  for (const key of sortedKeys(opponent)) {
    if (!['active', 'revealed_pets', 'bench'].includes(key)) ignored.push(`opponent.${key}`);
  }
  // ③ 后备行：**未亮明**只有 `{slot, fainted}`（实测 `_bench_public_row()`；探针 raw-03.1-engine-bench-keys）。
  arr(opponent.bench).forEach((row, index) => {
    if (!isPlainObject(row)) return;
    for (const key of sortedKeys(row)) {
      const at = `opponent.bench[${index}].${key}`;
      if (['slot', 'fainted'].includes(key)) continue;
      if (['pet_id', 'species_id', 'name', 'types', 'stats', 'stats_source', 'spe', 'spe_source',
        'hp', 'max_hp', 'energy', 'statuses', 'marks', 'revealed_via', 'revealed_turn',
        'revealed_event_seq'].includes(key)) {
        pushLeak(at, key, '未亮明的后备只有位次与是否倒下（`_bench_public_row()` 在这一档**没有 pet_id**）：'
          + '身份只能走 `opponent.revealed_pets[]`（= `view.seen_roster`，自带来源事件）', 'BENCH_IDENTITY');
      } else {
        ignored.push(at);
      }
    }
  });

  /** 逐行检查：先按键名判（隐藏 / 未知），再按**出处**判（物种级 vs 个体级 / 来源是否必填）。 */
  const checkRow = (path, row, allowFields, hiddenFields, hiddenWhy) => {
    if (!isPlainObject(row)) return;
    for (const key of sortedKeys(row)) {
      const at = `${path}.${key}`;
      if (hiddenFields.includes(key)) pushLeak(at, key, hiddenWhy, 'HIDDEN_FIELD');
      else if (!allowFields.includes(key)) ignored.push(at);
    }
  };

  const opponentActive = isPlainObject(opponent.active) ? opponent.active : null;
  const revealedRows = arr(opponent.revealed_pets);

  if (opponentActive) {
    checkRow('opponent.active', opponentActive, PUBLIC_FACT_FIELDS.opponent_active,
      HIDDEN_FACT_FIELDS.opponent,
      '对手场上的配招 / 道具 / 天赋 / 个体面板不在公开面里；可见的只有血条 / 能量 / 异常 / 印记'
      + '与**物种级**属性速度（要带 stats_source / spe_source）');
  }
  revealedRows.forEach((row, index) => checkRow(`opponent.revealed_pets[${index}]`, row,
    PUBLIC_FACT_FIELDS.opponent_revealed, HIDDEN_FACT_FIELDS.opponent_revealed,
    '对手**未亮明**的信息（手游里后备直到预览展示 / 换上场才亮明）'));

  /** 物种级速度：`spe` + 出处，或从 `stats.spe` + `stats_source` 取；个体口径 ⇒ 越界。 */
  const readSpeciesSpeed = (row, at) => {
    const statsSpe = Number.isFinite(row?.stats?.spe) ? Number(row.stats.spe) : null;
    const hasStats = isPlainObject(row?.stats);
    const statsSource = isNonEmptyString(row?.stats_source) ? row.stats_source : null;
    if (hasStats && !SPECIES_STAT_SOURCES.includes(statsSource)) {
      pushLeak(`${at}.stats_source`, 'stats_source',
        `面板出处 ${stableJson(statsSource)} 不是物种级（${SPECIES_STAT_SOURCES.join(' / ')}）：`
        + '`individual-snapshot` 是个体真值，不在对手的公开面上', 'INDIVIDUAL_FACTS');
    }
    const spe = Number.isFinite(row?.spe) ? Number(row.spe) : statsSpe;
    if (!Number.isFinite(spe)) return {spe: null, spe_source: null};
    const speSource = isNonEmptyString(row?.spe_source) ? row.spe_source
      : (hasStats ? statsSource : null);
    if (!SPECIES_STAT_SOURCES.includes(speSource)) {
      pushLeak(`${at}.spe_source`, 'spe_source',
        `速度出处 ${stableJson(speSource)} 缺失或不是物种级（${SPECIES_STAT_SOURCES.join(' / ')}）：`
        + '裸速度值可能是个体真值（`speed` / `speed_band` 在三条公开投影里零命中）', 'INDIVIDUAL_FACTS');
      return {spe: null, spe_source: null};
    }
    return {spe, spe_source: speSource};
  };

  // ④ 场上那只：公开面板 + 物种级属性 / 速度。**不需要亮明事件**（名字与血条画在屏幕上）。
  const active = (() => {
    if (!opponentActive) return null;
    const speciesId = opponentActive.pet_id ?? opponentActive.species_id ?? null;
    if (!isNonEmptyString(speciesId)) return null;
    const {spe, spe_source: speSource} = readSpeciesSpeed(opponentActive, 'opponent.active');
    return {
      species_id: speciesId,
      name: isNonEmptyString(opponentActive.name) ? opponentActive.name : null,
      slot: Number.isInteger(opponentActive.slot) ? opponentActive.slot : null,
      types: arr(opponentActive.types).length ? [...opponentActive.types] : null,
      spe,
      spe_source: speSource,
      // 可见面板（公开）：血条 / 能量 / 异常 / 印记 / 是否倒下。
      hp: Number.isFinite(opponentActive.hp) ? Number(opponentActive.hp) : null,
      max_hp: Number.isFinite(opponentActive.max_hp) ? Number(opponentActive.max_hp) : null,
      energy: Number.isFinite(opponentActive.energy) ? Number(opponentActive.energy) : null,
      statuses: isPlainObject(opponentActive.statuses) ? {...opponentActive.statuses} : null,
      marks: isPlainObject(opponentActive.marks) ? {...opponentActive.marks} : null,
      fainted: opponentActive.fainted === true,
      revealed_via: ACTIVE_REVEAL_SOURCE,
      revealed_turn: null,
      source: isNonEmptyString(opponentActive.source) ? opponentActive.source : 'injected:publicFacts.opponent.active',
    };
  })();

  // ⑤ 已亮明名单：**来源必填**（H1）——没有来源的「已亮明」与私有 state 直读无法区分。
  const revealed = [];
  const seen = new Set();
  const pushRevealed = (row, where) => {
    if (!isPlainObject(row)) return;
    const speciesId = row.pet_id ?? row.species_id ?? null;
    const at = `${where}`;
    if (!isNonEmptyString(speciesId)) {
      pushLeak(at, 'pet_id', '已亮明的成员没有 pet_id / species_id：无法定位是哪一只', 'NO_PROVENANCE');
      return;
    }
    const via = isNonEmptyString(row.revealed_via) ? row.revealed_via : null;
    const turn = Number.isInteger(row.revealed_turn) ? row.revealed_turn : null;
    if (via === null || !REVEAL_SOURCES.includes(via)) {
      pushLeak(`${at}.revealed_via`, 'revealed_via',
        `亮明来源 ${stableJson(via)} 缺失或不在 ${REVEAL_SOURCES.join(' / ')}：`
        + '没有来源的「已亮明」可能是从私有 state 直读的整队（两者输入形状一样）', 'NO_PROVENANCE');
      return;
    }
    if (turn === null) {
      pushLeak(`${at}.revealed_turn`, 'revealed_turn',
        '亮明回合缺失（必须是整数）：来源事件与回合是「这是公开史」的唯一凭据', 'NO_PROVENANCE');
      return;
    }
    if (seen.has(speciesId)) return;
    seen.add(speciesId);
    const {spe, spe_source: speSource} = readSpeciesSpeed(row, at);
    revealed.push({
      species_id: speciesId,
      name: isNonEmptyString(row.name) ? row.name : null,
      slot: Number.isInteger(row.slot) ? row.slot : null,
      types: arr(row.types).length ? [...row.types] : null,
      spe,
      spe_source: speSource,
      revealed_via: via,
      revealed_turn: turn,
      // 血量 **不进**这里：后备血量不是公开信息（见 HIDDEN_FACT_FIELDS.opponent_revealed）。
      source: isNonEmptyString(row.source) ? row.source : where,
    });
  };
  revealedRows.forEach((row, index) => pushRevealed(row, `injected:publicFacts.opponent.revealed_pets[${index}]`));

  // 场上那只并进「已亮明」名单（规则 1/2 对两者一视同仁）；同一只只留一条。
  if (active && !seen.has(active.species_id)) {
    seen.add(active.species_id);
    revealed.push({...active, source: active.source});
  }

  // ⑥ 我方阵容：速度可以是**个体面板**（自己的信息），配招 / 天赋 / 性格仍然不进输入面。
  const ownTeam = arr(facts.own_team?.pets).map((row, index) => {
    const at = `own_team.pets[${index}]`;
    checkRow(at, row, PUBLIC_FACT_FIELDS.own_team, HIDDEN_FACT_FIELDS.own_team,
      '我方配招 / 天赋 / 性格不进信念的输入面（只用阵容级事实做分层）');
    const spe = Number.isFinite(row?.spe) ? Number(row.spe)
      : (Number.isFinite(row?.stats?.spe) ? Number(row.stats.spe) : null);
    const speSource = isNonEmptyString(row?.spe_source) ? row.spe_source
      : (isNonEmptyString(row?.stats_source) ? row.stats_source : null);
    if (Number.isFinite(spe) && !OWN_SPEED_SOURCES.includes(speSource)) {
      pushLeak(`${at}.spe_source`, 'spe_source',
        `我方速度出处 ${stableJson(speSource)} 缺失或不在 ${OWN_SPEED_SOURCES.join(' / ')}：`
        + '自己的速度可以来自个体面板，但必须写明出处（不许裸值）', 'INDIVIDUAL_FACTS');
    }
    return {
      key: isNonEmptyString(row?.key) ? row.key
        : (isNonEmptyString(row?.pet_id) ? row.pet_id
          : (isNonEmptyString(row?.species_id) ? row.species_id : `own[${index}]`)),
      species_id: row?.pet_id ?? row?.species_id ?? null,
      types: arr(row?.types).length ? [...row.types] : null,
      spe: Number.isFinite(spe) ? spe : null,
      spe_source: Number.isFinite(spe) && OWN_SPEED_SOURCES.includes(speSource) ? speSource : null,
      slot: Number.isInteger(row?.slot) ? row.slot : null,
    };
  });

  const mode = {
    team_size: Number.isInteger(facts.mode?.team_size) ? facts.mode.team_size : null,
    battle_mode: isNonEmptyString(facts.mode?.battle_mode) ? facts.mode.battle_mode : null,
    ruleset_config_id: isNonEmptyString(facts.mode?.ruleset_config_id) ? facts.mode.ruleset_config_id : null,
  };
  // ⑦ 契约出处（H5）：三件套**原样转发**，缺就是 null + 在 unknowns 里点名（不自己造）。
  const provenance = {
    match_id: isNonEmptyString(facts.provenance?.match_id) ? facts.provenance.match_id : null,
    rules_version: isNonEmptyString(facts.provenance?.rules_version) ? facts.provenance.rules_version : null,
    decision_id: isNonEmptyString(facts.provenance?.decision_id) ? facts.provenance.decision_id : null,
  };

  const dedupIgnored = [...new Set(ignored)].sort((a, b) => (a < b ? -1 : 1));
  return {
    ok: leaked.length === 0,
    leaked,
    ignored: dedupIgnored,
    facts: {active, revealed_pets: revealed, own_team: ownTeam, mode, provenance},
    evidence: [
      evidence('injected:publicFacts', 'publicFacts.opponent.revealed_pets', 'revealed_pets',
        revealed.map((row) => row.species_id),
        '对手**已亮明**的精灵（场上那只 + 预览 / 换人亮明的）：身份 + 来源事件（revealed_via / revealed_turn）'
        + ' + 物种级属性与速度（带 spe_source），**没有**配招 / 道具 / 后备血量'),
      evidence('injected:publicFacts', 'publicFacts.opponent.active', 'visible_panel',
        {hp: active?.hp ?? null, max_hp: active?.max_hp ?? null, energy: active?.energy ?? null,
          statuses: active?.statuses ?? null, marks: active?.marks ?? null},
        '场上那只的**可见面板**（血条 / 能量 / 异常 / 印记）：三公开投影里都属于公开面'
        + '（`raw-03.1-engine-public-keys.txt`）；这里只登记读数，本模块不用它做任何强度判断'),
      evidence('injected:publicFacts', 'publicFacts.own_team.pets', 'own_team_size', ownTeam.length,
        '我方阵容（自己的信息）：信念用它做速度档分层，不用它推断对手'),
      evidence('injected:publicFacts', 'publicFacts.mode', 'team_size', mode.team_size,
        '模式规模（公开规则常量）：六宠口径来自调用方，不在本模块写死'),
      evidence('injected:publicFacts', 'publicFacts.provenance', 'rules_version', provenance.rules_version,
        '01.2 观察契约的规则版本（还有 match_id / decision_id）：原样转发，缺就是 null（不自己造）'),
      evidence('injected:publicFacts', 'publicFacts', 'ignored_public_keys', dedupIgnored,
        '白名单外的未知键：不进信念（记在这里，不静默丢弃）'),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ① 均匀基线
// ─────────────────────────────────────────────────────────────────────────

/**
 * 均匀分布基线：分母 = 候选宇宙大小（从注入数据数出来）。
 *
 * 它**不是**强度判断、**不是**胜率：它回答的是「在完全不知道对手要出什么的时候，
 * 每条候选一样重」这件事。`expected_per_candidate` 给的是 **1/N**，
 * 并且**必须**同时给出它是无信息基线这句话（`declared_semantics` + `red_lines[]`）。
 *
 * @param {object} input
 * @param {object} input.catalog  RC-303 的候选索引，或 `{pets:[...], owned:[...]}` 形状的数据
 */
export function uniformBelief({catalog = null} = {}) {
  const universe = buildCandidateUniverse(catalog);
  if (universe.size === 0) {
    return {
      belief: 'uniform',
      label: '均匀分布（无信息基线）',
      available: false,
      kind: 'not_available',
      informativeness: null,
      universe_size: 0,
      expected_per_candidate: null,
      weights: null,
      declared_semantics: NON_INFORMATIVE_DECLARATION,
      red_lines: uniformRedLines(),
      unknown_reason: FAIL_CLOSED_REASONS.CATALOG_MISSING,
      missing: ['catalog（候选宇宙）'],
      evidence: universe.evidence,
      confidence: 'UNKNOWN',
      unverified: ['未核实：候选宇宙 —— 没有候选就没有分母，本模块不写死一个数字来「凑出」1/N'],
      criteria: STRUCTURAL_CRITERIA.denominator_from_data,
    };
  }

  const expected = exact(1, universe.size);
  return {
    belief: 'uniform',
    label: '均匀分布（无信息基线）',
    available: true,
    kind: 'non_informative_baseline',
    informativeness: 'non_informative_baseline',
    universe_size: universe.size,
    expected_per_candidate: {
      numerator: 1,
      denominator: universe.size,
      value: expected.value,
      unit: EXPECTED_UNIT,
      applies_to: '候选宇宙里的**每一条**候选（等权）',
    },
    weights: {
      normalization: 'exact_fraction',
      total: exact(1, 1),
      per_candidate: exact(1, universe.size),
      unit: WEIGHT_UNIT,
      // 670 行 × 4 字段的明细会把报告撑大又什么都不多说（等权就是等权），
      // 所以这里只给**精确的**每候选权重 + 显式条目数；明细由 `weightsFor()` 按需展开。
      candidate_count: universe.size,
      entries_omitted: 'per-candidate 明细（等权时逐条列 622 行只是噪声；需要明细就调 weightsFor()）',
      // R2（任何带 `weights` 的产出都必须声明「这份权重是拿什么算出来的」）：
      // 均匀基线同样要写，而且写的正是它最容易被人读错的那件事。
      basis: 'non_informative_uniform_baseline',
      is_probability: false,
      baseline_declaration: NON_INFORMATIVE_DECLARATION,
    },
    declared_semantics: NON_INFORMATIVE_DECLARATION,
    red_lines: uniformRedLines(),
    unknown_reason: null,
    missing: [],
    evidence: [
      ...universe.evidence,
      evidence('src/coach/opponent-belief.mjs', 'uniformBelief()', 'expected_per_candidate', 1 / universe.size,
        '期望权重 = 1 / 候选宇宙大小：**无信息基线**，不是强度判断、不是胜率（分母来自注入数据，改数据分母就变）'),
    ],
    confidence: 'ENGINE_HYPOTHESIS',
    unverified: [
      '未核实：任何候选的相对强弱 —— 均匀基线刻意不含这类信息（这就是它叫无信息基线的原因）',
      '未核实：候选宇宙之外还有没有可出战精灵 —— 分母只数注入数据里有的东西',
    ],
    criteria: STRUCTURAL_CRITERIA.denominator_from_data,
  };
}

function uniformRedLines() {
  return [
    '不是强度判断：等权意味着**没有**任何「谁更强 / 谁更该带」的信息',
    '不是胜率、不是对局预测：1/N 只是权重分母',
    '不是版本环境占比：环境占比要真实对局频次数据（见 frequencyBelief()，本仓现在没有）',
    '用途只有一个：当对照基线，量「加了公开事实之后权重变了多少」',
  ];
}

/** 把等权基线展开成逐条明细（需要落到具体候选时才调，避免报告里堆 600+ 行噪声）。 */
export function weightsFor(belief, keys = null) {
  // 边界：不接受 `keys = null`（没有候选键就没有明细 —— 凭空造 key 就是编候选）。
  const universe = arr(keys);
  if (!isPlainObject(belief) || belief.available !== true || !isPlainObject(belief.weights)) return [];
  const rows = arr(belief.weights.rows);
  if (rows.length > 0) return rows;
  const per = belief.weights.per_candidate ?? null;
  const list = universe.length > 0 ? universe : null;
  if (per === null) return [];
  if (list === null) return [];
  return list.map((key) => weightRow(key, per, WEIGHT_UNIT, '均匀基线：每条候选同权'));
}

// ─────────────────────────────────────────────────────────────────────────
// ② 公开事实条件化
// ─────────────────────────────────────────────────────────────────────────

/**
 * 条件在**已公开**事实上的信念：筛选 / 加权都只做可复算的事。
 *
 * 三条规则（`RULES`），每条写成 `{输入 → 输出 → 依据}`：
 *   · `filter.revealed_types`         对手已亮明的系别 → 能接住它的候选（相性表口径同 RC-302/303）；
 *   · `filter.opponent_speed_tier`    对手已亮明的那只的速度档 → 同档候选；
 *   · `weight.own_speed_tier_match`   我方阵容已有的速度档 → 该层候选等权（权重只有 0 / 1）。
 *
 * 规则**逐条应用**；任何一条把池子筛空 ⇒ `available:false`（空池不是「更精确」）。
 * 一条规则因为缺数据应用不了 ⇒ 记 `not_applied` + 原因，池子更宽（宽是安全的，窄才是编的）。
 *
 * @param {object} input
 * @param {object} input.catalog      候选索引 / 朴素数据（同 `uniformBelief`）
 * @param {object} input.publicFacts  公开事实（`{opponent:{active,revealed_pets}, own_team:{pets}, mode}`）
 */
export function revealedConditioned({catalog = null, publicFacts = null} = {}) {
  const universe = buildCandidateUniverse(catalog);
  const read = readPublicFacts(publicFacts);
  const base = {
    belief: 'revealed_conditioned',
    label: '公开事实条件化（对手已亮明的那只 + 我方阵容 + 模式规模）',
    kind: 'not_available',
    universe_size: universe.size,
    pool_size: 0,
    pool_ratio: null,
    rule_ledger: [],
    weights: null,
    // fail closed 时也要有这一句：它说明「这份信念本来打算吃什么」，
    // 而 `unknown_reason` 说明「为什么这顿没吃上」。两者缺一，读的人就只能猜。
    declared_semantics: '这份信念只吃**已公开**的事实（对手已亮明的那只的系别 / 速度档、我方阵容、模式规模）'
      + '做可复算的筛选与分层；公开事实不够就 fail closed，不产出任何权重。',
    public_facts: read.facts,
    ignored_public_keys: read.ignored,
    red_lines: revealedRedLines(),
    criteria: STRUCTURAL_CRITERIA.public_facts_only,
  };

  // ① 越界优先：隐藏字段 / 缺来源 / 个体真值一旦出现，**整个输入被拒绝**（不是忽略）。
  //    原因按**类别码**挑（最严重的一类先报），并且 `leaked_fields[]` 逐条带 code —— 不靠字符串猜。
  if (!read.ok) {
    const codes = new Set(read.leaked.map((row) => row.code));
    const reason = codes.has('INDIVIDUAL_FACTS') ? FAIL_CLOSED_REASONS.REVEALED_INDIVIDUAL_FACTS
      : (codes.has('NO_PROVENANCE') ? FAIL_CLOSED_REASONS.REVEALED_NO_PROVENANCE
        : FAIL_CLOSED_REASONS.REVEALED_LEAKED_HIDDEN_FACTS);
    return {
      ...base,
      available: false,
      informativeness: null,
      unknown_reason: reason,
      leaked_fields: read.leaked,
      missing: read.leaked.map((row) => row.path),
      evidence: [...universe.evidence, ...read.evidence,
        evidence('injected:publicFacts', 'publicFacts', 'leaked_fact_fields',
          read.leaked.map((row) => `${row.code}:${row.path}`),
          '越界的公开事实（含缺来源 / 个体口径）：拒绝整个输入，而不是静默过滤'
          + '（过滤会让泄漏在报告里查不出来）')],
      confidence: 'UNKNOWN',
      unverified: ['未核实：任何结论 —— 输入越界即整份拒绝，这里不产出权重'],
    };
  }
  if (universe.size === 0) {
    return {
      ...base,
      available: false,
      informativeness: null,
      pool_size: 0,
      unknown_reason: FAIL_CLOSED_REASONS.CATALOG_MISSING,
      leaked_fields: [],
      missing: ['catalog（候选宇宙）'],
      evidence: [...universe.evidence, ...read.evidence],
      confidence: 'UNKNOWN',
      unverified: ['未核实：候选池 —— 没有候选宇宙就没有池子'],
    };
  }

  const rules = applyRules(universe, read.facts, {catalog});
  const appliedCount = rules.ledger.filter((row) => row.applied).length;
  if (appliedCount === 0) {
    return {
      ...base,
      available: false,
      informativeness: null,
      // 池子还是宇宙那么大（没有规则收窄）—— fail closed 也要如实报池子的实况，
      // 否则读的人会以为「池子是空的」，而真正的问题是「没有可用的条件」。
      pool_size: rules.pool.length,
      unknown_reason: FAIL_CLOSED_REASONS.REVEALED_NO_RULE_APPLIED,
      leaked_fields: [],
      missing: rules.not_applied_reasons,
      rule_ledger: rules.ledger,
      evidence: [...universe.evidence, ...read.evidence],
      confidence: 'UNKNOWN',
      unverified: ['未核实：条件化 —— 公开事实一条规则都驱动不起来；把均匀基线换个名字交出去就是编'],
    };
  }
  if (rules.pool.length === 0) {
    return {
      ...base,
      available: false,
      informativeness: null,
      pool_size: 0,
      unknown_reason: FAIL_CLOSED_REASONS.REVEALED_EMPTY_POOL,
      leaked_fields: [],
      missing: rules.ledger.filter((row) => row.applied && row.output.matched === 0).map((row) => row.id),
      rule_ledger: rules.ledger,
      evidence: [...universe.evidence, ...read.evidence],
      confidence: 'UNKNOWN',
      unverified: ['未核实：池子 —— 公开事实把候选筛空了，空池不是「更精确」，如实报 unknown'],
    };
  }
  // 防御性不变量（03.1 · R4 之后正常路径**不可达**）：选中层是从「池子里真的存在的档」里挑的
  // （见 `applyRules()` 的 `usableBands`）；一旦它空了，说明选择逻辑坏了 —— 这时 fail closed
  // 比交出一份全 0 权重诚实。
  if (rules.stratum !== null && rules.stratum_size === 0) {
    return {
      ...base,
      available: false,
      informativeness: null,
      // 池子**不为空**（它是被筛过、但选中层里没有候选）——这个区别必须在产出里看得见。
      pool_size: rules.pool.length,
      stratum: rules.stratum,
      stratum_size: 0,
      unknown_reason: FAIL_CLOSED_REASONS.REVEALED_EMPTY_STRATUM,
      leaked_fields: [],
      missing: [rules.stratum_rule_id ?? 'weight.own_speed_tier_match'],
      rule_ledger: rules.ledger,
      evidence: [...universe.evidence, ...read.evidence],
      confidence: 'UNKNOWN',
      unverified: ['未核实：权重 —— 选中的速度层在候选池里一条都没有（权重全 0 的向量没有意义）'],
    };
  }

  // 权重：**层内等权、层间降权（默认 2 : 1）、任何一行都不为 0**。
  // R4 裁决：仅凭「我方阵容的速度层次」把候选压 0 = 声称这只不可能上场，而假设不是证据；
  // 真正的排除只能来自公开证据（03.3 的 `evidence_exclusions`）。
  const baselineOnly = rules.stratum === null;
  const rows = rules.pool.map((row) => weightRow(row.key,
    exact(row.weight_units, rules.weight_total), WEIGHT_UNIT,
    baselineOnly
      ? '池内等权（**仅作基线**：公开事实只筛到池子这一层，没有更多区分依据）'
      : (row.weight_units === rules.weight_ratio[0]
        ? `落在速度层 ${rules.stratum} 内（假设层：相对权重 ${rules.weight_ratio[0]}:${rules.weight_ratio[1]}）`
        : `外层候选（**降权不排除**：相对权重 ${rules.weight_ratio[0]}:${rules.weight_ratio[1]}，权重仍大于 0）`)));
  const total = rows.reduce((sum, row) => addExact(sum,
    exact(row.numerator, row.denominator)), exact(0, 1));

  return {
    ...base,
    available: true,
    kind: 'public_fact_conditioned',
    informativeness: 'public_fact_conditioned',
    pool_size: rules.pool.length,
    stratum: rules.stratum,
    stratum_size: rules.stratum_size,
    pool_ratio: {
      numerator: rules.pool.length,
      denominator: universe.size,
      value: Number((rules.pool.length / universe.size).toFixed(12)),
      unit: POOL_UNIT,
    },
    rule_ledger: rules.ledger,
    weights: {
      normalization: 'exact_fraction',
      total,
      stratum_sum: exact(rules.stratum_size || rules.pool.length, rules.stratum_size || rules.pool.length),
      unit: WEIGHT_UNIT,
      candidate_count: rows.length,
      // R2 / R4：**这份权重是拿什么算出来的**必须在场，且必须说清它是基线还是假设。
      // 缺这两个标记 ⇒ `WEIGHT_BASIS_NOT_DECLARED`（红）。
      basis: baselineOnly ? 'uniform_over_pool_baseline' : 'own_speed_tier_downweight',
      uniform_within: baselineOnly ? 'pool' : 'stratum',
      weight_ratio: [...rules.weight_ratio],
      weight_total: rules.weight_total,
      stratum_size: rules.stratum_size,
      other_size: rules.pool.length - rules.stratum_size,
      is_probability: false,
      assumption: baselineOnly ? null
        : '假设：对手这一只要出场的速度层，与我方阵容里最常见的那一层相同。这是**声明过的工程假设**，'
          + '不是证据；它只把该层候选的相对权重调到 2:1，**不排除**任何候选。',
      baseline_declaration: '这些权重**仅作基线**：它们是「公开事实筛出的池子 + 一条声明过的分层假设」的'
        + '归一化结果，**不是**「他会出哪只」的把握度，也不是概率预测；层内候选完全等权。',
      rows,
    },
    provenance: {...read.facts.provenance},
    leaked_fields: [],
    declared_semantics: '这些权重只由**已公开**的事实决定（对手已亮明的那只的系别 / 物种速度、我方阵容、模式规模），'
      + '是「筛 + 分层」的计数结果，不是强度排序、不是胜率：'
      + '同一层内的候选**完全等权**；层与层之间只有一条**声明过的假设**造成的降权（2 : 1），'
      + '**没有任何候选被压到 0**（假设不是证据）。',
    unknown_reason: null,
    missing: [],
    evidence: [
      ...universe.evidence,
      ...read.evidence,
      evidence('injected:publicFacts', 'publicFacts', 'applied_rules',
        rules.ledger.filter((row) => row.applied).map((row) => row.id),
        '真正驱动了条件化的规则（应用不了的记 not_applied + 原因，池子因此更宽）'),
      evidence('injected:catalog', 'catalog', 'pool_size', rules.pool.length,
        `候选池 ${rules.pool.length} / 宇宙 ${universe.size}（分母来自数据；规则逐条可复算，见 rule_ledger）`),
      evidence('injected:publicFacts', 'publicFacts.provenance', 'rules_version',
        read.facts.provenance.rules_version,
        '这些候选属于哪一局 / 哪份规则 / 哪一次决策（01.2 契约三件套，原样转发）'),
    ],
    confidence: 'ENGINE_HYPOTHESIS',
    unverified: [
      '未核实：候选之间的强弱 —— 条件化只按公开事实筛 / 分层，层内等权，不含强度判断',
      '未核实：层间的 2:1 降权 —— 它来自**声明过的假设**（我方最常见的速度层更可能出场），'
      + '不是从对局频次估出来的；也没有任何证据因此被排除',
      '未核实：对手**后备**要出什么 —— 后备（未亮明时只有位次与是否倒下）不在公开面里，'
      + '本模块明确说不知道（这也是 available 的原因不是「我们很确定」）',
      '未核实：速度档本身 —— 它是 RC-303 `speedBandFor()` 在候选宇宙内按三分位**现算**的工程构造'
      + '（阈值见规则账本 `output.band_thresholds`），不是官方档位表；换一份图鉴它会变',
      ...(read.facts.provenance.rules_version === null
        ? ['未核实：规则版本 —— 公开事实里没有 `rules_version`（01.2 契约字段），'
          + '所以这份候选没法绑定到具体规则版本；拿到 `view.rules_version` 就必须带上'] : []),
      ...rules.unverified,
    ],
  };
}

function revealedRedLines() {
  return [
    '只看公开面：对手**场上**那只的可见面板与所属物种、**已亮明**的成员与来源事件、我方阵容、模式规模',
    '不看隐藏面：对手配招 / 道具 / 天赋性格 / 个体面板 / 后备身份与血量一律不进输入'
    + '（传进来即拒绝；缺来源的「已亮明」也拒绝）',
    '不给强度结论：过滤与分层是计数，不是排序；层内等权',
    '**不把候选压 0**：只有公开证据（已出技能 / 先手关系 / 可见伤害）才能排除候选，'
    + '且必须写清证据 ID；仅凭我方速度层次只降权',
    '不产出胜率 / 概率 / 百分数：权重合计 1 只是归一化，不是「赢面」',
  ];
}

/**
 * 逐条应用规则。返回 `{pool, ledger, stratum, stratum_size, weight_units, weight_total,
 * weight_ratio, stratum_rule_id, not_applied_reasons, unverified}`。
 *
 * 规则账本每一条都是**可核对**的：`inputs[]`（读了哪几条公开事实）+ `output`（匹配数 / 层大小）
 * + `basis`（依据）。同一份输入两次调用必须逐字节相同（没有随机、没有遍历顺序依赖）。
 *
 * ⚠ 2026-09-30（03.1）：规则 2 的 `reads` 与实现**取一**（H3）——公开事实只给 `spe` + `spe_source`，
 * 档位由本模块调 RC-303 `speedBandFor()` **现算**；`speed_band` 不是游戏字段（三面零命中）。
 * 规则 3 只**降权不压 0**（R4），且只在**同量纲**时应用（见下面的 `ownBands`）。
 */
export function applyRules(universe, facts, options = {}) {
  const ledger = [];
  const notApplied = [];
  const unverified = [];
  const catalog = options?.catalog ?? null;
  let pool = universe.members.map((row) => ({...row}));

  /**
   * 速度档：**本模块现算**（H3）——公开事实只带 `spe` + 出处，档位一律走 RC-303 的
   * `speedBandFor()`（候选宇宙三分位）。这里**不复制**分位算法：只把「谁算的、算在多少条
   * 速度值上」留痕（R5），档位本身仍由那一个实现给。
   */
  const bandOf = (row) => speedBandOf(catalog, row?.spe);
  const bandSource = () => {
    const values = Array.isArray(catalog?.speedValues) ? catalog.speedValues : null;
    return {
      implementation: 'RC-303 speedBandFor()（候选宇宙内三分位，工程构造）',
      universe_values: values ? values.length : 0,
      is_game_field: false,
      note: '`speed_band` 在三条公开投影里零命中（探针 token_scan）：它是本模块现算的工程分档，'
        + '换一份图鉴，分位与档位都会变',
    };
  };

  // ── 规则 1：对手已亮明的系别 → 能接住它的候选 ──
  const revealedWithTypes = arr(facts?.revealed_pets).filter((row) => arr(row.types).length > 0);
  const checkScale = universe.scale_lookup ?? null;
  const typeRule = {
    id: 'filter.revealed_types',
    kind: 'filter',
    reads: [...RULE_BY_ID['filter.revealed_types'].reads],
    inputs: revealedWithTypes.map((row) => ({
      species_id: row.species_id, types: [...row.types], source: row.source,
    })),
    output: {matched: 0, before: pool.length, after: pool.length},
    basis: RULE_BY_ID['filter.revealed_types'].basis,
    applied: false,
  };
  if (revealedWithTypes.length === 0 || checkScale === null) {
    typeRule.reason = revealedWithTypes.length === 0
      ? '对手还没有任何**已亮明**的系别（公开面为空）：没有可用的系别条件'
      : '冻结相性表不可用（没有 scaleByCombo）：不敢自己造一张相性表';
    notApplied.push(typeRule.reason);
  } else {
    const before = pool.length;
    const kept = [];
    for (const row of pool) {
      if (!arr(row.types).length) { kept.push(row); continue; } // 属性未知的候选不因此被剔除（不猜）
      const answers = revealedWithTypes.some((foe) => revealedWithTypes
        .length > 0 && foe.types.some((attackType) => {
          const scale = checkScale(row.types, attackType);
          return scale !== null && scale <= 4; // ≤ 基准 = 至少不被这只的打点克制
        }));
      if (answers) kept.push(row);
    }
    pool = kept;
    typeRule.applied = true;
    typeRule.output = {matched: pool.length, before, after: pool.length};
    typeRule.unverified = ['未核实：候选能不能真的接住 —— 判定只看**属性相性表**（冻结数据），'
      + '不看具体配招 / 特性（那些不在公开面，也不在候选宇宙的属性数据里）'];
    unverified.push(typeRule.unverified[0]);
  }
  ledger.push(typeRule);

  // ── 规则 2：对手**已亮明**的那只的物种速度 → 现算速度档 → 同档候选 ──
  //
  // 三种情形（第三种是实测踩出来的）：
  //   · 一条速度档都算不出来 ⇒ **不应用**（缺物种速度，不自己编一个档）；
  //   · 只亮明单一档        ⇒ 收窄到同一档；
  //   · **快慢两端都亮明**   ⇒ 也**不应用**：对手快慢都见过，速度这件事对「他会出什么」不再有区分度。
  //     实测：早先的写法在两端亮明时照两端留，把 mid 档 **237 只全剔掉**，
  //     于是自家是 mid 档的队伍拿到空层 → fail closed；反过来硬选一头又会造出一个
  //     看着精确、实际任意的池子。所以这一条在两端亮明时不应用 —— 池子更宽是安全的，窄才是编的。
  const revealedWithSpeed = arr(facts?.revealed_pets).map((row) => ({
    species_id: row.species_id,
    spe: Number.isFinite(row.spe) ? row.spe : null,
    spe_source: row.spe_source ?? null,
    band: bandOf(row),
    revealed_via: row.revealed_via ?? null,
  }));
  const revealedBands = [...new Set(revealedWithSpeed.map((row) => row.band).filter(isNonEmptyString))]
    .sort((a, b) => (a < b ? -1 : 1));
  const bothExtremesRevealed = revealedBands.includes('fast') && revealedBands.includes('slow');
  const speedRule = {
    id: 'filter.opponent_speed_tier',
    kind: 'filter',
    reads: [...RULE_BY_ID['filter.opponent_speed_tier'].reads],
    inputs: [{
      revealed: revealedWithSpeed,
      speed_bands: revealedBands,
      band_source: bandSource(),
      applied_when: '恰好算得出单一速度档',
      not_applied_when: '一个档都算不出来 / 快慢两端都亮明',
    }],
    output: {matched: 0, before: pool.length, after: pool.length},
    basis: RULE_BY_ID['filter.opponent_speed_tier'].basis,
    applied: false,
  };
  if (revealedBands.length === 0 || bothExtremesRevealed) {
    speedRule.reason = revealedBands.length === 0
      ? (revealedWithSpeed.some((row) => Number.isFinite(row.spe))
        ? '候选宇宙里没有速度值可用（没有分位表 ⇒ 算不出档位）：这一条不应用，池子因此更宽'
        : '对手已亮明的那几只都没有**物种速度**（`spe` + 物种级出处）：不自己编一个档位，'
          + '这一条不应用，池子因此更宽')
      : `对手已亮明的速度档覆盖了快慢两端（${revealedBands.join(' / ')}）：`
        + '速度这件事对「他会出什么」不再有区分度，硬选一头会造出一个看着精确、实际任意的池子，'
        + '所以这一条不应用（池子因此更宽）';
    notApplied.push(speedRule.reason);
  } else {
    const before = pool.length;
    const kept = pool.filter((row) => row.speed_band === null || revealedBands.includes(row.speed_band));
    pool = kept;
    speedRule.applied = true;
    speedRule.output = {matched: pool.length, before, after: pool.length,
      kept_bands: [...new Set(pool.map((row) => row.speed_band))].filter(isNonEmptyString).sort((a, b) => (a < b ? -1 : 1)),
      band_thresholds: bandSource()};
    speedRule.unverified = ['未核实：速度档本身 —— 档位来自 RC-303 speedBandFor()（候选宇宙内三分位），'
      + '是工程分档，不是官方档位表'];
    unverified.push(speedRule.unverified[0]);
  }
  ledger.push(speedRule);

  // ── 规则 3：我方阵容的速度档 → 分层**降权**（2 : 1，绝不压 0） ──
  //
  // ⚠ 同量纲门槛（03.1 新增）：档位是「候选宇宙的物种速度三分位」，所以只有**物种级**的我方速度
  // 才与它可比。个体面板速度是另一套量纲（面板口径 275 vs 种族值 51 是**同一个物种**的两套数），
  // 拿它去套物种分位会把自家每只都算成 fast —— 那正是引擎登记 `speed_provenance` 要防的
  // 「一侧面板、一侧种族值，先手被静默带偏」。所以个体口径的我方速度**不进这一条**，
  // 记 `not_applied` + 原因（要么给物种级 spe，要么这条规则不应用）。
  const ownRows = arr(facts?.own_team);
  const ownSpeciesRows = ownRows.filter((row) => SPECIES_STAT_SOURCES.includes(row?.spe_source)
    && Number.isFinite(row?.spe));
  const mixedScaleRows = ownRows.filter((row) => Number.isFinite(row?.spe)
    && !SPECIES_STAT_SOURCES.includes(row?.spe_source));
  const ownBands = ownSpeciesRows.map((row) => bandOf(row)).filter(isNonEmptyString);
  const counts = new Map();
  for (const band of ownBands) counts.set(band, (counts.get(band) ?? 0) + 1);
  // 选中层：①自己队里出现最多 **且在池子里真的存在** 的档；并列时 ②按档名定序。
  //
  // 为什么要「且在池子里真的存在」：只按自家阵容投票会选出空层（实测：自家 6 只 → mid 3 / fast 2 / slow 1，
  // 而对手只亮明 slow、池子只剩 slow 146 只 ⇒ 选 mid 就是空层）。但这只是**选层**的工程口径，
  // 不再意味着「选不中就 fail closed」：选层失败时退回池内等权基线（见下）。
  const poolByBand = new Map();
  for (const row of pool) {
    if (!isNonEmptyString(row.speed_band)) continue;
    poolByBand.set(row.speed_band, (poolByBand.get(row.speed_band) ?? 0) + 1);
  }
  const usableBands = [...counts.keys()].filter((band) => (poolByBand.get(band) ?? 0) > 0);
  const candidateBands = (usableBands.length > 0 ? usableBands : [...counts.keys()])
    .sort((a, b) => ((counts.get(b) - counts.get(a)) || (a < b ? -1 : 1)));
  const stratum = candidateBands[0] ?? null;
  const weightRule = {
    id: 'weight.own_speed_tier_match',
    kind: 'weight',
    reads: [...RULE_BY_ID['weight.own_speed_tier_match'].reads],
    inputs: [{
      own_team_bands: Object.fromEntries([...counts.entries()].sort()),
      own_team_size: ownRows.length,
      own_team_species_level_spe: ownSpeciesRows.length,
      mixed_scale_spe_excluded: mixedScaleRows.length,
      pool_bands: Object.fromEntries([...poolByBand.entries()].sort()),
      usable_bands: usableBands,
      weight_ratio: [2, 1],
      tie_break: ['own_team_band_count desc', 'band_name asc'],
      band_source: bandSource(),
    }],
    output: {stratum, stratum_size: 0, before: pool.length, after: pool.length, weight_ratio: [2, 1]},
    basis: RULE_BY_ID['weight.own_speed_tier_match'].basis,
    assumption: '对手出场的那只的速度层，与我方阵容里最常见的一层相同 —— **声明过的工程假设**，'
      + '不是证据：它只把该层候选的相对权重调到 2 : 1，**不排除**任何候选（权重都不为 0）',
    applied: false,
  };
  let stratumSize = 0;
  let weightUnits = new Map();
  if (stratum === null) {
    weightRule.reason = ownRows.length === 0
      ? '我方阵容里没有一个成员带速度值：没有可用的分层依据（速度值缺失就不自己算档位）'
      : (ownSpeciesRows.length === 0
        ? '我方阵容的速度都是**个体面板口径**（`individual-snapshot`），与候选的物种速度分位不是'
          + '同一套量纲（同一物种的面板值与种族值差一个量级）：不换算、不硬套，这一条不应用，'
          + '退回池内等权基线（要它生效就传物种级 `spe` + `spe_source`）'
        : '我方阵容没有一个成员的速度档落在池子里（选层失败）：这一条不应用，退回池内等权基线');
    notApplied.push(weightRule.reason);
    for (const row of pool) weightUnits.set(row.key, 1);
  } else {
    for (const row of pool) weightUnits.set(row.key, row.speed_band === stratum ? 2 : 1);
    stratumSize = pool.filter((row) => row.speed_band === stratum).length;
    weightRule.applied = true;
    weightRule.output = {stratum, stratum_size: stratumSize, before: pool.length, after: pool.length,
      weight_ratio: [2, 1]};
    weightRule.unverified = ['未核实：为什么以我方**最多且池子里存在**的速度档为层 —— 这是工程假设'
      + '（对齐自家最常见、并且真的还有候选可挑的那一层），不是强度结论；'
      + '并列时按档名定序（tie-break 写在 inputs 里）。它只降权，不排除任何候选'];
    unverified.push(weightRule.unverified[0]);
  }
  if (mixedScaleRows.length > 0) {
    unverified.push('未核实：我方阵容里 ' + mixedScaleRows.length + ' 只的速度是个体面板口径'
      + '（`individual-snapshot`）—— 与候选宇宙的物种速度不可比，所以它们没有参与分层；'
      + '这不是「它们更快」或「更慢」，是**量纲不同**');
  }
  ledger.push(weightRule);

  const weightTotal = [...weightUnits.values()].reduce((sum, value) => sum + value, 0);
  for (const row of pool) row.weight_units = weightUnits.get(row.key) ?? 1;
  return {
    pool,
    ledger,
    stratum,
    stratum_size: stratumSize,
    weight_units: Object.fromEntries([...weightUnits.entries()].sort()),
    weight_total: weightTotal,
    weight_ratio: stratum === null ? [1, 1] : [2, 1],
    stratum_rule_id: weightRule.applied ? weightRule.id : null,
    not_applied_reasons: notApplied,
    unverified,
  };
}

/**
 * 取属性相性判定器：**只复用** RC-303 索引里的 `scaleByCombo`（整数标度 ×4，未登记 = null）。
 * 本模块不复制第二张相性表 —— 相性只有一份实现（`buildGapIndex()` 从冻结 types.json 预计算）。
 */

// ─────────────────────────────────────────────────────────────────────────
// ②′ 候选协议（03.2）：view → 公开事实；公开事实 + 技能池 → 候选集合
// ─────────────────────────────────────────────────────────────────────────

/** 候选的两条腿：`observed` = 公开史里真的见过；`inferred` = 规则从公开事实推出来的。 */
export const CANDIDATE_BASES = Object.freeze(['observed', 'inferred']);

/** 技能池的**等级词表**（与冻结层 / RC-402 的同名等级一致）。 */
export const SKILL_POOL_GRADES = Object.freeze(['FULL_VERIFIED', 'SIMULATABLE_UNVERIFIED', 'UNKNOWN']);

/** 四技能上限（游戏规则；配置里没给别的数就不自己发明）。 */
export const FOUR_SKILL_LIMIT = 4;

/** 候选预算默认值；`rule` 必须是**可解释、可复算**的一条。 */
export const DEFAULT_CANDIDATE_BUDGET = Object.freeze({
  limit: 24,
  rule: 'observed_first（按 slot 升序）→ inferred（①**重大威胁**优先 ②有冻结学招表 ③与已亮明速度档同档 '
    + '④species_id 升序）；**已见永不裁剪**，被裁掉的重大威胁必须点名',
});

/** 「重大威胁」的口径（只用公开数据：候选的物种系别 × 我方阵容系别 × 冻结相性表）。 */
export const THREAT_RULE = Object.freeze({
  id: 'threat.super_effective_against_own_team',
  rule: '候选的某个系别对我方某只成员**克制**（相性表标度 ≥ 8，即 ≥2 倍）⇒ 计 1 点；'
    + '点数 = 被我方阵容里多少只「怕」它。`threat_level >= 2` 记为重大威胁。',
  why: '只用公开事实：候选系别来自冻结图鉴、我方系别是自己的信息、相性表是冻结数据；'
    + '不引入「谁强谁弱」的强度判断，只回答「它能不能打我队里的谁」',
});

/**
 * 四技能合法性：**已知不合法的组合绝不进候选**（03 的必做反例②）。
 *
 * 三条不合法：①技能不在这只的可学池里；②同一个技能出现两次；③超过四技能上限。
 * 返回 `{ok, kept, excluded:[{skill_id, why}]}` —— 被排除的**逐条写出理由**，不静默丢。
 */
export function legalSkillLoadout({pool = [], proposed = [], limit = FOUR_SKILL_LIMIT} = {}) {
  const legal = arr(pool).filter(isNonEmptyString);
  const kept = [];
  const excluded = [];
  for (const raw of arr(proposed)) {
    const skillId = isNonEmptyString(raw) ? raw : (isNonEmptyString(raw?.skill_id) ? raw.skill_id : null);
    if (skillId === null) {
      excluded.push({skill_id: null, why: '技能行没有 skill_id：无名无据的技能不进候选'});
      continue;
    }
    if (!legal.includes(skillId)) {
      excluded.push({skill_id: skillId, why: '不在这只的**可学池**里（冻结学招表 / on-demand-builds）：带不出来的技能不进候选'});
      continue;
    }
    if (kept.includes(skillId)) {
      excluded.push({skill_id: skillId, why: '同一个技能出现两次：四技能不许重复'});
      continue;
    }
    kept.push(skillId);
  }
  const over = kept.slice(limit);
  if (over.length > 0) {
    for (const skillId of over) {
      excluded.push({skill_id: skillId, why: `超过四技能上限（${limit}）：多出来的不进候选`});
    }
  }
  return {ok: excluded.length === 0, limit, kept: kept.slice(0, limit), excluded};
}

/** 把注入的技能池统一成 Map（认 Map / 朴素对象 / 不注入）。 */
const tableOf = (source, key) => {
  const raw = isPlainObject(source) || source instanceof Map ? source?.[key] : null;
  if (raw instanceof Map) return raw;
  if (isPlainObject(raw)) return new Map(Object.entries(raw));
  return new Map();
};

/**
 * 候选人自己那一份**技能池**（03.2 的 Q3 裁决）：
 *   ① 冻结 `learnsets`（基线 + `layer-playable-48` 覆盖，542 只）⇒ `FULL_VERIFIED`；
 *   ② 没有冻结学招表时才用 `on-demand-builds`（622 只；等级**原样**取它的 `support`）；
 *   ③ 两份都没有 ⇒ `UNKNOWN` + 空池（**不猜**）。
 * **未验证的绝不与已验证的同权呈现**：每条技能都带自己的 `grade`。
 */
function skillPoolFor(speciesId, {learnsets, skills, onDemandBuilds}) {
  const nameOf = (skillId) => {
    const row = skills.get(skillId);
    return isNonEmptyString(row?.name) ? row.name : null;
  };
  const learnset = learnsets.get(speciesId) ?? null;
  if (learnset && arr(learnset.skill_ids).length > 0) {
    const sourceFile = isNonEmptyString(learnset.source_file) ? learnset.source_file : 'data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json';
    return {
      tier: 'frozen_learnset',
      grade: 'FULL_VERIFIED',
      source_file: sourceFile,
      pointer: isNonEmptyString(learnset.pointer) ? learnset.pointer : `learnsets.${speciesId}`,
      note: '冻结学招表（native + blood + stones 的并集）：判据最硬的一份',
      skills: [...learnset.skill_ids].sort().map((skillId) => ({skill_id: skillId, name: nameOf(skillId),
        grade: 'FULL_VERIFIED', source_file: sourceFile, pointer: `${isNonEmptyString(learnset.pointer) ? learnset.pointer : `learnsets.${speciesId}`}`})),
    };
  }
  const derived = isPlainObject(onDemandBuilds?.builds) ? onDemandBuilds.builds[speciesId] : null;
  if (derived) {
    const grade = SKILL_POOL_GRADES.includes(derived.support) ? derived.support : 'SIMULATABLE_UNVERIFIED';
    const rows = arr(derived.skills).filter((row) => isNonEmptyString(row?.skill_id));
    return {
      tier: 'on_demand_builds',
      grade,
      source_file: 'data/roco/derived/on-demand-builds.json',
      pointer: `builds.${speciesId}`,
      note: derived.support === 'FULL_VERIFIED'
        ? '工程启发式配招（RC-402 选择规则），本只标记为已核验档'
        : '工程启发式配招（RC-402 选择规则）——**未实机核验**，只有这一档可用',
      skills: rows.map((row) => ({skill_id: row.skill_id, name: isNonEmptyString(row.name) ? row.name : nameOf(row.skill_id),
        grade, source_file: 'data/roco/derived/on-demand-builds.json', pointer: `builds.${speciesId}.skills`})),
    };
  }
  return {tier: 'none', grade: 'UNKNOWN', source_file: null, pointer: null,
    note: '这只既没有冻结学招表、也没有 on-demand-builds：可学技能**不知道**（不猜）', skills: []};
}

/**
 * **观察契约适配器**（03.2）：`view` → `publicFacts`。只读下面这几个白名单路径，别的一个都不碰：
 *   · `seen_roster[]`（身份 + 来源事件 + 回合）· `opponent.field`（场上那只：可见面板 + 物种级 stats/source）
 *   · `opponent.revealed_skills`（已出招）· `self.pets[]`（我方阵容）· `mode_id` / `ruleset_config_id`
 *   · `match_id` / `rules_version` / `decision_id`（01.2 契约三件套）
 * 产出的形状**直接可喂** `readPublicFacts()`（它才是判据所在）。对手后备一律只取 `{slot, fainted}`。
 *
 * 为什么要它：输入形状上「公开亮明的整队」与「从私有 state 直读的整队」长得一模一样，
 * 只有**来源**能区分。适配器把「从哪读的」写死在这几行里，调用方就没有机会偷偷换源。
 */
export function readOpponentView(view) {
  const doc = isPlainObject(view) ? view : {};
  const opponent = isPlainObject(doc.opponent) ? doc.opponent : {};
  const field = isPlainObject(opponent.field) ? opponent.field : null;
  const notes = [];
  const unknowns = [];

  const active = field ? {
    pet_id: field.pet_id ?? null,
    name: isNonEmptyString(field.name) ? field.name : null,
    slot: Number.isInteger(field.slot) ? field.slot : null,
    types: arr(field.types).length ? [...field.types] : null,
    stats: isPlainObject(field.stats) ? {...field.stats} : null,
    stats_source: isNonEmptyString(field.stats_source) ? field.stats_source : null,
    hp: Number.isFinite(field.hp) ? field.hp : null,
    max_hp: Number.isFinite(field.max_hp) ? field.max_hp : null,
    energy: Number.isFinite(field.energy) ? field.energy : null,
    statuses: isPlainObject(field.statuses) ? {...field.statuses} : null,
    marks: isPlainObject(field.marks) ? {...field.marks} : null,
    fainted: field.fainted === true,
    source: 'view.opponent.field',
  } : null;
  if (field === null) unknowns.push('未核实：对手场上那只 —— `view.opponent.field` 不在（战况快照形状或对局未开始）');

  // `seen_roster` 实测**没有** types / stats（02 留档 `raw-view-preview.json`）⇒ 属性与速度由候选自己从冻结图鉴补。
  const revealed_pets = arr(doc.seen_roster).map((row) => ({
    pet_id: row?.pet_id ?? null,
    name: isNonEmptyString(row?.name) ? row.name : null,
    slot: Number.isInteger(row?.slot) ? row.slot : null,
    revealed_via: isNonEmptyString(row?.revealed_via) ? row.revealed_via : null,
    revealed_turn: Number.isInteger(row?.revealed_turn) ? row.revealed_turn : null,
    source: 'view.seen_roster',
  }));
  if (revealed_pets.length === 0) {
    notes.push('这一份 view 里没有 `seen_roster`（无预览 / 旧存档 / 练习局）⇒ 已见阵容为空，'
      + '候选只能靠公开事实推（observed=0）');
  }

  const ownPets = arr(doc.self?.pets);
  const own_team = {
    pets: ownPets.map((row) => ({
      key: isNonEmptyString(row?.pet_id) ? row.pet_id : null,
      pet_id: row?.pet_id ?? null,
      types: arr(row?.types).length ? [...row.types] : null,
      stats: isPlainObject(row?.stats) ? {...row.stats} : null,
      stats_source: isNonEmptyString(row?.stats_source) ? row.stats_source : null,
      slot: Number.isInteger(row?.slot) ? row.slot : null,
    })),
  };
  if (ownPets.length === 0) unknowns.push('未核实：我方阵容 —— `view.self.pets` 不在 ⇒ 速度分层规则无法应用（池子更宽）');

  const revealedSkillsRaw = isPlainObject(opponent.revealed_skills) ? opponent.revealed_skills : {};
  const revealed_skills = {};
  for (const petId of sortedKeys(revealedSkillsRaw)) {
    const rows = arr(revealedSkillsRaw[petId]);
    if (rows.length === 0) continue;
    revealed_skills[petId] = rows.map((row) => (isPlainObject(row)
      ? {skill_id: isNonEmptyString(row.skill_id) ? row.skill_id : null,
        name: isNonEmptyString(row.name) ? row.name : null}
      : {skill_id: null, name: isNonEmptyString(row) ? row : null}))
      .sort((a, b) => ((a.skill_id ?? '') < (b.skill_id ?? '') ? -1 : 1));
  }
  if (Object.keys(revealed_skills).length === 0) {
    notes.push('这一份 view 里没有 `revealed_skills`（对手还没出过招，或这一面没有该键）⇒ 已知技能为空');
  }

  const provenance = {
    match_id: isNonEmptyString(doc.match_id) ? doc.match_id : null,
    rules_version: isNonEmptyString(doc.rules_version) ? doc.rules_version : null,
    decision_id: isNonEmptyString(doc.decision_id) ? doc.decision_id : null,
  };
  if (provenance.rules_version === null) unknowns.push('未核实：规则版本 —— `view.rules_version` 不在（01.2 契约字段）');

  const publicFacts = {
    opponent: {
      active,
      revealed_pets,
      // 后备**只取**位次与是否倒下：身份走 `seen_roster` 那条路（`_bench_public_row()` 同口径）。
      bench: arr(opponent.bench).map((row) => ({slot: Number.isInteger(row?.slot) ? row.slot : null,
        fainted: row?.fainted === true})),
    },
    own_team,
    mode: {
      team_size: Number.isInteger(doc.team_size) ? doc.team_size : null,
      battle_mode: isNonEmptyString(doc.mode_id) ? doc.mode_id : null,
      ruleset_config_id: isNonEmptyString(doc.ruleset_config_id) ? doc.ruleset_config_id : null,
    },
    provenance,
  };

  return {
    ok: true,
    publicFacts,
    revealed_skills,
    notes,
    unknowns,
    shapes: {
      has_seen_roster: Array.isArray(doc.seen_roster),
      has_opponent_field: field !== null,
      has_revealed_skills: Object.keys(revealed_skills).length > 0,
      own_team_size: ownPets.length,
    },
    evidence: [
      evidence('view', 'view.seen_roster', 'revealed_pets', revealed_pets.map((row) => row.pet_id),
        '已见阵容（身份 + 来源事件 + 回合）：适配器只取这四个公开字段，不补 types / stats / 面板'),
      evidence('view', 'view.opponent.field', 'visible_panel', active === null ? null
        : {pet_id: active.pet_id, hp: active.hp, max_hp: active.max_hp, energy: active.energy,
          statuses: active.statuses, marks: active.marks, stats_source: active.stats_source},
        '场上那只的可见面板与**物种级** stats（出处 stats_source 原样带出，个体口径会被下一条判据拒绝）'),
      evidence('view', 'view.opponent.revealed_skills', 'revealed_skills',
        Object.entries(revealed_skills).map(([petId, rows]) => `${petId}:${rows.length}`),
        '对手**真的打出来**的技能（公开事实）：只登记，不从这里推强度'),
      evidence('view', 'view.match_id/rules_version/decision_id', 'provenance', provenance,
        '01.2 观察契约三件套：原样转发，缺就是 null（不自己造版本号）'),
    ],
  };
}

/**
 * **候选集合**（03.2 的交付）：已见物种 + 可能技能 + 可支持的个体范围 + 动作，
 * 每条候选都带 `{来源, 等级, 规则版本, 证据, 未知项}` —— 03 / 04 / 06 都消费这份**机器可读**结构。
 *
 * 语义边界（写死在这里，避免下游各自解释）：
 *   · `basis: 'observed'` = 公开史里出现过（`seen_roster` / 场上那只）；`'inferred'` = 只是规则推的；
 *   · **已观察事实与推测不混用**：技能池是「这只**可能**会什么」（物种级、冻结数据），
 *     已出招是「它**已经**打了什么」（公开事实），两者分字段、各带来源；
 *   · 候选**只增不减地如实登记**：已见的候选即便被规则筛掉也保留，并把矛盾写进 `contradictions`；
 *   · 数量超预算时按**可解释规则**缩减（`budget.rule`），并留下被丢掉那部分的**分布**（`pool_summary`），
 *     不隐去重大威胁（威胁保留策略在 03.5 细化）。
 *
 * @param {object} input
 * @param {object} input.catalog           RC-303 索引 / 朴素数据（同 `revealedConditioned`）
 * @param {object} [input.publicFacts]     公开事实（`readPublicFacts()` 的形状）
 * @param {object} [input.view]            或直接给 `view`（内部走 `readOpponentView()`）
 * @param {object} [input.skillPool]       `{learnsets, skills, onDemandBuilds}`（或直接给 RC-303 索引）
 * @param {object} [input.proposedLoadouts] `{species_id: [skill_id...]}`：要**验合法性**的配招（可选）
 * @param {object} [input.budget]          `{limit, rule}`（缺省见 `DEFAULT_CANDIDATE_BUDGET`）
 */
export function buildOpponentCandidates(input = {}) {
  const {catalog = null, publicFacts = null, view = null, skillPool = null,
    proposedLoadouts = null, budget = null} = input ?? {};
  const adapted = view !== null && publicFacts === null ? readOpponentView(view) : null;
  const read = readPublicFacts(publicFacts ?? adapted?.publicFacts ?? null);
  const universe = buildCandidateUniverse(catalog);
  const limit = Number.isInteger(budget?.limit) && budget.limit > 0 ? budget.limit : DEFAULT_CANDIDATE_BUDGET.limit;
  const rule = isNonEmptyString(budget?.rule) ? budget.rule : DEFAULT_CANDIDATE_BUDGET.rule;
  const base = {
    protocol: 'rc604-opponent-candidates/v1',
    available: false,
    unknown_reason: null,
    universe_size: universe.size,
    provenance: read.facts.provenance,
    budget: {limit, rule, kept: 0, observed_kept: 0, inferred_kept: 0, truncated: false,
      dropped_count: 0, pool_summary: null, truncation: null},
    candidates: [],
    contradictions: [],
    rule_ledger: [],
    leaked_fields: [],
  };

  if (!read.ok) {
    const codes = new Set(read.leaked.map((row) => row.code));
    return {
      ...base,
      unknown_reason: codes.has('INDIVIDUAL_FACTS') ? FAIL_CLOSED_REASONS.REVEALED_INDIVIDUAL_FACTS
        : (codes.has('NO_PROVENANCE') ? FAIL_CLOSED_REASONS.REVEALED_NO_PROVENANCE
          : FAIL_CLOSED_REASONS.REVEALED_LEAKED_HIDDEN_FACTS),
      leaked_fields: read.leaked,
      // 降级也要说清「本来要生成什么」，而不是交一个空数组就完事。
      degraded_to: 'no_candidates',
      unverified: ['未核实：候选集合 —— 输入越界即整份拒绝，这里一个候选都不生成（不拿空数组冒充「没有威胁」）'],
      evidence: [...universe.evidence, ...read.evidence, ...(adapted?.evidence ?? [])],
    };
  }

  const learnsets = tableOf(skillPool, 'learnsets').size > 0 ? tableOf(skillPool, 'learnsets')
    : tableOf(catalog, 'learnsets');
  const skills = tableOf(skillPool, 'skills').size > 0 ? tableOf(skillPool, 'skills')
    : tableOf(catalog, 'skills');
  const onDemandBuilds = isPlainObject(skillPool?.onDemandBuilds) ? skillPool.onDemandBuilds : null;
  const rules = applyRules(universe, read.facts, {catalog});
  const memberById = new Map(universe.members.map((row) => [row.key, row]));

  // ── 03.5：重大威胁（只用公开数据算；见 `THREAT_RULE`） ──
  const checkScale = universe.scale_lookup ?? null;
  const ownTypes = arr(read.facts.own_team).map((row) => arr(row.types)).filter((types) => types.length > 0);
  const threatLevelOf = (candidateTypes) => {
    if (checkScale === null || !arr(candidateTypes).length || ownTypes.length === 0) return 0;
    let hits = 0;
    for (const types of ownTypes) {
      const hitsThis = arr(candidateTypes).some((attackType) => {
        const scale = checkScale(types, attackType);
        return scale !== null && scale >= 8;
      });
      if (hitsThis) hits += 1;
    }
    return hits;
  };

  const observedRows = arr(read.facts.revealed_pets);
  const observedIds = new Set(observedRows.map((row) => row.species_id));
  const poolIds = new Set(rules.pool.map((row) => row.key));

  const makeCandidate = (speciesId, basis, observed, rank) => {
    const member = memberById.get(speciesId) ?? null;
    const feature = typeof catalog?.featureFor === 'function' ? catalog.featureFor(speciesId) : null;
    const types = member?.types ?? (arr(feature?.types).length ? [...feature.types] : null);
    const spe = member?.speed ?? (Number.isFinite(feature?.spe) ? Number(feature.spe) : null);
    const band = member?.speed_band ?? speedBandOf(catalog, spe);
    const pool = skillPoolFor(speciesId, {learnsets, skills, onDemandBuilds});
    const used = arr(adapted?.revealed_skills?.[speciesId]).map((row) => ({
      skill_id: row.skill_id, name: row.name,
      in_learnable_pool: row.skill_id === null ? null : pool.skills.some((item) => item.skill_id === row.skill_id),
      source: 'view.opponent.revealed_skills',
    }));
    const proposed = arr(proposedLoadouts?.[speciesId]);
    const legality = proposed.length > 0
      ? legalSkillLoadout({pool: pool.skills.map((row) => row.skill_id), proposed})
      : {ok: true, limit: FOUR_SKILL_LIMIT, kept: [], excluded: []};
    const unknowns = [
      '未核实：这只的个体面板 / 天赋 / 性格 / 真实六维 —— 不在公开面（对手只展示物种级数值）',
    ];
    if (pool.tier === 'none') unknowns.push('未核实：可学技能 —— 冻结学招表与 on-demand-builds 都没有这一只');
    if (basis === 'inferred') unknowns.push('未核实：这只是否真的在对手队里 —— 公开史里没有它（规则推的）');
    if (used.some((row) => row.in_learnable_pool === false)) {
      unknowns.push('**矛盾**：已出招的技能不在这只的可学池里 —— 要么学招表不全、要么形态/物种对不上（两条都留着，不猜）');
    }
    const sources = [
      ...(member ? [evidence('injected:catalog', `catalog.featureFor(${speciesId})`, 'types/spe',
        {types, spe}, '物种级属性与速度：冻结图鉴（公开数据）')] : []),
      ...(pool.source_file ? [evidence(pool.source_file, pool.pointer, 'skill_pool', pool.skills.map((row) => row.skill_id),
        `可学技能池（等级 ${pool.grade}）：${pool.note}`)] : []),
      ...(used.length > 0 ? [evidence('view', `view.opponent.revealed_skills.${speciesId}`, 'used_skills',
        used.map((row) => row.skill_id ?? row.name), '这只**已经打出来**的技能（公开事实）')] : []),
    ];
    return {
      candidate_id: `cand:${speciesId}`,
      species_id: speciesId,
      name: feature?.species_name ?? observed?.name ?? null,
      basis,
      types,
      spe,
      spe_source: spe === null ? null : 'catalog:species-race（冻结图鉴的物种值）',
      spe_status: feature?.spe_status ?? null,
      speed_band: band,
      band_source: band === null ? null : 'RC-303 speedBandFor()（工程三分位构造，不是游戏字段）',
      in_filtered_pool: poolIds.has(speciesId),
      inferred_rank: rank,
      threat_level: threatLevelOf(types),
      threat_rule: THREAT_RULE.id,
      observed: observed === null ? null : {
        slots: [observed.slot].filter(Number.isInteger),
        reveals: [{revealed_via: observed.revealed_via, revealed_turn: observed.revealed_turn,
          source: observed.source}],
        visible_panel: observed.revealed_via === ACTIVE_REVEAL_SOURCE ? {
          hp: observed.hp, max_hp: observed.max_hp, energy: observed.energy,
          statuses: observed.statuses, marks: observed.marks, fainted: observed.fainted,
        } : null,
      },
      skills: {
        known_used: used,
        possible: pool.skills,
        possible_count: pool.skills.length,
        pool_tier: pool.tier,
        grade: pool.grade,
        grade_legend: 'FULL_VERIFIED（冻结学招表）> SIMULATABLE_UNVERIFIED（工程启发式，未实机核验）> UNKNOWN（没有池）',
        legality: {...legality, proposed},
      },
      individual_range: {
        known: false,
        observed_stats_source: observed?.spe_source ?? null,
        observed_spe: Number.isFinite(observed?.spe) ? observed.spe : null,
        individual_values_visible: false,
        scenarios: Number.isFinite(observed?.spe) ? [{id: observed.spe_source ?? 'unknown',
          stats_source: observed.spe_source ?? null, source: observed.source,
          note: '这是**物种级**数值（引擎公开投影给的），不是这只的个体真值'}] : [],
        note: '个体面板 / 天赋 / 性格不在公开面：同一份可见伤害可能由多种个体配置解释 ⇒ 保留多解（03.3）',
      },
      actions: {
        observed: used.filter((row) => row.skill_id !== null).map((row) => ({kind: 'skill',
          skill_id: row.skill_id, name: row.name, source: row.source})),
        plausible_kinds: ['skill', 'switch'],
        note: '对手**下一手**不在公开面：这里只登记已打出来的技能与可能出现的动作类别，不预测具体动作',
      },
      sources,
      unknowns,
      rules_version: read.facts.provenance.rules_version,
      evidence: [
        evidence('injected:publicFacts', 'publicFacts.opponent.revealed_pets', 'basis',
          observed === null ? null : {species_id: speciesId, revealed_via: observed.revealed_via,
            revealed_turn: observed.revealed_turn},
          basis === 'observed' ? '这条候选来自**公开史**（已亮明 / 场上）' : null),
        ...sources,
      ],
    };
  };

  // ① 已见候选：永远保留（哪怕被规则筛掉 —— 那是矛盾，要报出来，不是丢掉）
  const observedCandidates = [];
  const seenCandidateIds = new Set();
  for (const row of observedRows) {
    if (seenCandidateIds.has(row.species_id)) continue;
    seenCandidateIds.add(row.species_id);
    observedCandidates.push(makeCandidate(row.species_id, 'observed', row, null));
  }
  observedCandidates.sort((a, b) => ((a.observed?.slots?.[0] ?? 99) - (b.observed?.slots?.[0] ?? 99))
    || (a.species_id < b.species_id ? -1 : 1));

  // ② 推出来的候选：只从**规则筛过的池子**里取，按可解释规则排序（03.5：重大威胁优先）
  const bandMatches = (row) => rules.stratum === null ? false : (row.speed_band === rules.stratum);
  const inferredPool = rules.pool.filter((row) => !observedIds.has(row.key)).sort((a, b) => {
    const aThreat = threatLevelOf(a.types);
    const bThreat = threatLevelOf(b.types);
    if (aThreat !== bThreat) return bThreat - aThreat;
    const aTier = skillPoolFor(a.key, {learnsets, skills, onDemandBuilds}).tier === 'frozen_learnset' ? 0 : 1;
    const bTier = skillPoolFor(b.key, {learnsets, skills, onDemandBuilds}).tier === 'frozen_learnset' ? 0 : 1;
    if (aTier !== bTier) return aTier - bTier;
    const aBand = bandMatches(a) ? 0 : 1;
    const bBand = bandMatches(b) ? 0 : 1;
    if (aBand !== bBand) return aBand - bBand;
    return a.key < b.key ? -1 : 1;
  });

  const remaining = Math.max(0, limit - observedCandidates.length);
  const inferredCandidates = inferredPool.slice(0, remaining)
    .map((row, index) => makeCandidate(row.key, 'inferred', null, index + 1));
  const dropped = inferredPool.slice(remaining);
  const droppedByBand = {};
  for (const row of dropped) {
    const band = row.speed_band ?? 'unknown';
    droppedByBand[band] = (droppedByBand[band] ?? 0) + 1;
  }
  // 03.5：**被裁掉的重大威胁必须点名**（不许隐去）
  const droppedThreats = dropped.filter((row) => threatLevelOf(row.types) >= 2).map((row) => ({
    candidate_id: `cand:${row.key}`,
    species_id: row.key,
    threat_level: threatLevelOf(row.types),
    why: `被预算裁掉，但它是**重大威胁**（${THREAT_RULE.rule.slice(0, 40)}…）：`
      + '名单在这里点名，不许静默丢掉',
    evidence_ids: [`catalog.featureFor(${row.key}).types`, `catalog.scaleByCombo`, 'publicFacts.own_team[].types'],
  }));
  const threatsKept = [...observedCandidates, ...inferredCandidates].filter((row) => row.threat_level >= 2).length;

  // ③ 矛盾（不静默）：已亮明却被规则筛掉、已出招却不在可学池里
  const contradictions = [];
  for (const row of observedRows) {
    if (!poolIds.has(row.species_id)) {
      contradictions.push({code: 'OBSERVED_NOT_IN_FILTERED_POOL', species_id: row.species_id,
        detail: '这只**已经亮明**（公开史里有），却被「已亮明系别 / 速度档」规则筛出了池子：'
          + '规则与观察冲突 ⇒ 候选保留、矛盾如实报出（以观察为准）'});
    }
  }
  for (const candidate of [...observedCandidates, ...inferredCandidates]) {
    const bad = candidate.skills.known_used.filter((row) => row.in_learnable_pool === false);
    for (const row of bad) {
      contradictions.push({code: 'USED_SKILL_NOT_LEARNABLE', species_id: candidate.species_id,
        skill_id: row.skill_id,
        detail: '已出招的技能不在这只的可学池里：学招表不全或形态对不上（两条都留着，不猜）'});
    }
  }

  const allCandidates = [...observedCandidates, ...inferredCandidates];
  const poolSummary = {
    by_band: Object.fromEntries([...rules.pool.reduce((map, row) => {
      const band = row.speed_band ?? 'unknown';
      map.set(band, (map.get(band) ?? 0) + 1);
      return map;
    }, new Map()).entries()].sort()),
    observed: observedCandidates.length,
    inferred_available: inferredPool.length,
    dropped_by_band: Object.fromEntries(Object.entries(droppedByBand).sort()),
  };

  return {
    ...base,
    available: true,
    unknown_reason: null,
    kind: 'public_fact_conditioned',
    candidates: allCandidates,
    budget: {
      limit, rule, kept: allCandidates.length, observed_kept: observedCandidates.length,
      inferred_kept: inferredCandidates.length,
      truncated: dropped.length > 0, dropped_count: dropped.length, pool_summary: poolSummary,
      // 03.5：**截断信息**（总数 / 保留数 / 被截断数与分布 / 截断依据），且重大威胁必须点名
      truncation: {
        total_candidates: allCandidates.length,
        total_available: observedCandidates.length + inferredPool.length,
        limit, kept: allCandidates.length, dropped: dropped.length,
        rule,
        dropped_by_band: Object.fromEntries(Object.entries(droppedByBand).sort()),
        dropped_by_threat: {high: droppedThreats.length,
          none: dropped.length - droppedThreats.length},
        dropped_threats: droppedThreats,
        threats_kept: threatsKept,
        limit_exceeded_by_observed: observedCandidates.length > limit,
        threat_rule: {...THREAT_RULE},
        note: dropped.length === 0
          ? '没有候选被裁掉（在预算之内）'
          : `裁掉 ${dropped.length} 条（分布见 dropped_by_band）；其中重大威胁 ${droppedThreats.length} 条`
            + '逐条点名在 dropped_threats 里 —— 缩减按可解释规则，不隐去重大威胁',
      },
    },
    contradictions,
    rule_ledger: rules.ledger,
    leaked_fields: [],
    evidence: [
      ...universe.evidence,
      ...read.evidence,
      ...(adapted?.evidence ?? []),
      evidence('injected:publicFacts', 'publicFacts', 'candidate_counts',
        {observed: observedCandidates.length, inferred: inferredCandidates.length, dropped: dropped.length},
        '候选集合：已见（observed）与推出来的（inferred）分开计数；缩减只按 budget.rule，且留下被丢那部分的分布'),
    ],
    unverified: [
      ...(adapted?.unknowns ?? []),
      '未核实：对手**下一手** —— 动作不在公开面，候选只说明「可能是谁 / 可能带什么」，不预测出招',
      '未核实：候选之间的强弱 —— 本协议不给排序、不给权重（权重在 `revealedConditioned()` 里，且只是基线）',
      ...(dropped.length > 0 ? [`未核实：被预算裁掉的 ${dropped.length} 只（按 ${rule}）`
        + '—— 它们的分布留在 budget.pool_summary.dropped_by_band 里，没有消失'] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ③′ 证据更新（03.3）：已出技能 / 先手关系 / 可见伤害 / 可见状态 ⇒ 更新候选
// ─────────────────────────────────────────────────────────────────────────

/** 证据更新的协议版本（03/04/06 都按这一份解析）。 */
export const EVIDENCE_UPDATE_PROTOCOL = 'rc604-opponent-candidate-update/v1';

/**
 * 白名单里**允许不被夹具直接用到**的键（每一项都要写清为什么）——
 * 「白名单每一项都必须被用上」这条判据据此不会被死条目糊过去（见测试 ③ 的逐项覆盖断言）。
 */
export const PUBLIC_FACT_FIELDS_OPTIONAL = Object.freeze({
  opponent_active: Object.freeze(['species_id', 'source']),
  opponent_revealed: Object.freeze(['species_id', 'revealed_event_seq', 'source']),
  own_team: Object.freeze(['species_id', 'stats', 'stats_source', 'source']),
  mode: Object.freeze([]),
  provenance: Object.freeze([]),
});

/**
 * **证据观察器**（03.3）：从 `view` 里取**公开**证据。只读这几条路径，别的一律不碰：
 *   · `opponent.revealed_skills`  —— 对手已经**打出来**的技能（谁打的、什么技能）；
 *   · `events[].kind === 'turn_start'` 的 `detail.speed_provenance` —— 这一回合两侧用的速度**与出处**；
 *   · `events[].kind === 'damage'`      —— 可见伤害（谁打谁、什么技能、多少点）；
 *   · `events[].detail.side` 的**先后** —— 这一回合谁先动（先手关系的可见读数）；
 *   · `opponent.field`                  —— 场上那只的可见面板（血条 / 能量 / 异常 / 印记）。
 *
 * `individual-*` 出处**一律拒绝**（它是个体真值）：出现在 `speed_provenance` 里就记进 `rejected[]`
 * 并且**不使用**。每一条观察都带 `evidence_id`，指回公开载荷里的位置。
 */
export function readOpponentEvidence(view) {
  const doc = isPlainObject(view) ? view : {};
  const opponent = isPlainObject(doc.opponent) ? doc.opponent : {};
  const rejected = [];
  const notes = [];
  const unknowns = [];
  const used_skills = [];
  const turn_order = [];
  const visible_damage = [];

  for (const petId of sortedKeys(opponent.revealed_skills ?? {})) {
    arr(opponent.revealed_skills[petId]).forEach((row, index) => {
      const skillId = isPlainObject(row) ? row.skill_id ?? null : null;
      if (skillId === null && !isNonEmptyString(row?.name)) return;
      used_skills.push({
        pet_id: petId,
        skill_id: skillId,
        name: isPlainObject(row) && isNonEmptyString(row.name) ? row.name : null,
        evidence_id: `view.opponent.revealed_skills[${petId}][${index}]`,
      });
    });
  }

  const events = arr(doc.events);
  const perTurn = new Map();
  events.forEach((event, index) => {
    if (!isPlainObject(event)) return;
    const detail = isPlainObject(event.detail) ? event.detail : {};
    const seq = Number.isInteger(event.seq) ? event.seq : (Number.isInteger(event.extra?.seq) ? event.extra.seq : null);
    const evidenceId = `view.events[seq=${seq ?? `#${index}`}]`;
    const turn = Number.isInteger(event.turn) ? event.turn : null;
    if (event.kind === 'turn_start' && isPlainObject(detail.speed_provenance)) {
      const speeds = isPlainObject(detail.speed_provenance.speeds) ? detail.speed_provenance.speeds : {};
      const enemy = isPlainObject(speeds.enemy) ? speeds.enemy : null;
      const source = isNonEmptyString(enemy?.source) ? enemy.source : null;
      if (source !== null && source.startsWith('individual')) {
        rejected.push({path: `${evidenceId}.detail.speed_provenance.speeds.enemy`, why:
          `速度出处是 ${source}（个体真值）：不在对手的公开面上 ⇒ 这条观察**不使用**`});
      } else if (enemy !== null && Number.isFinite(enemy.value)) {
        turn_order.push({turn, enemy_speed: {value: Number(enemy.value), source},
          panel_scale: detail.speed_provenance.panel_scale === true, evidence_id: evidenceId});
      } else {
        unknowns.push(`未核实：第 ${turn ?? '?'} 回合对手的先手速度 —— \`speed_provenance\` 里没有可用的出处/数值`);
      }
    }
    if (isNonEmptyString(detail.side) && turn !== null) {
      if (!perTurn.has(turn)) perTurn.set(turn, {first_side: detail.side, evidence_id: evidenceId});
    }
    if (event.kind === 'damage' && Number.isFinite(detail.damage)) {
      visible_damage.push({turn, attacker_side: isNonEmptyString(detail.side) ? detail.side : null,
        skill_id: isNonEmptyString(detail.skill_id) ? detail.skill_id : null,
        amount: Number(detail.damage), evidence_id: evidenceId});
    }
  });
  const firstSides = [...perTurn.entries()].sort((a, b) => a[0] - b[0])
    .map(([turn, row]) => ({turn, first_side: row.first_side, evidence_id: row.evidence_id}));

  const field = isPlainObject(opponent.field) ? opponent.field : null;
  const visible_state = field === null ? null : {
    species_id: field.pet_id ?? null,
    hp: Number.isFinite(field.hp) ? field.hp : null,
    max_hp: Number.isFinite(field.max_hp) ? field.max_hp : null,
    energy: Number.isFinite(field.energy) ? field.energy : null,
    statuses: isPlainObject(field.statuses) ? {...field.statuses} : null,
    marks: isPlainObject(field.marks) ? {...field.marks} : null,
    evidence_id: 'view.opponent.field',
  };
  if (turn_order.length === 0) {
    notes.push('这一份 view 的 `events` 里没有 `speed_provenance`（引擎只在**面板口径**下发它）'
      + '⇒ 先手速度这条证据没有读数，规则会记 not_applied，不自己换算');
  }
  if (visible_damage.length === 0) notes.push('这一份 view 里没有 damage 事件 ⇒ 可见伤害为空，不拿别的数顶');

  const contract = {
    match_id: isNonEmptyString(doc.match_id) ? doc.match_id : null,
    rules_version: isNonEmptyString(doc.rules_version) ? doc.rules_version : null,
    decision_id: isNonEmptyString(doc.decision_id) ? doc.decision_id : null,
  };
  return {
    ok: true,
    observations: {used_skills, turn_order, first_sides: firstSides, visible_damage, visible_state, contract},
    rejected,
    notes,
    unknowns,
    evidence: [
      evidence('view', 'view.opponent.revealed_skills', 'used_skills',
        used_skills.map((row) => `${row.pet_id}:${row.skill_id ?? row.name}`),
        '**已经打出来**的技能（公开事实）：只登记，不从它推强度'),
      evidence('view', 'view.events[].detail.speed_provenance', 'turn_order',
        turn_order.map((row) => `t${row.turn}:${row.enemy_speed.value}/${row.enemy_speed.source}`),
        '这一回合两侧用的速度与**出处**（引擎只在面板口径下发；individual-* 会被拒绝）'),
      evidence('view', 'view.events[].kind=damage', 'visible_damage',
        visible_damage.map((row) => `t${row.turn}:${row.attacker_side}:${row.skill_id}:${row.amount}`),
        '可见伤害（屏幕上的数字）：只登记原始读数，不在信念里重算伤害公式（唯一实现在引擎）'),
      evidence('view', 'view.opponent.field', 'visible_state', visible_state,
        '场上那只的可见面板（血条 / 能量 / 异常 / 印记）——公开；状态本身不指向某个物种'),
      evidence('view', 'view.match_id/rules_version/decision_id', 'contract', contract,
        '01.2 契约三件套：原样转发，缺就是 null'),
    ],
  };
}

/**
 * **候选更新**（03.3）：证据 ⇒ 收窄候选 / 保留多解 / 逐条写排除理由。
 *
 * 四条规则（账本逐条可核对）：
 *   ① `evidence.used_skill_presence`  打过技能的宠物**一定在对手队里**（公开事实）⇒ 升级/新增 observed 候选；
 *   ② `evidence.used_skill_learnability` 已出技能必须在候选的可学池里（冻结学招表）——
 *      不在 ⇒ 记矛盾（**不排除**：学招表可能不全、形态可能对不上，两条都留）；
 *   ③ `evidence.visible_damage_scenarios` 可见伤害只能由**注入的引擎情景**解释（不在这里重算公式）：
 *      多条情景都解释得通 ⇒ **全部保留**（`multi_solution`）；一条都不解释得上且情景声明**穷尽** ⇒ 排除；
 *      没声明穷尽 ⇒ 保留 + 记矛盾；
 *   ④ `evidence.turn_order_speed` 先手速度：**只有同量纲才用**（出处必须是 `species-race`，
 *      与候选宇宙的物种速度可比）；引擎只在面板口径下发 `speed_provenance`（`species-panel`）
 *      ⇒ 本仓实测不可比，规则记 `not_applied` + 原因，**不换算、不排除**。
 *
 * @param {object} input
 * @param {Array|object} input.candidates  `buildOpponentCandidates()` 的产出（或它的 `candidates[]`）
 * @param {object} input.observations      `readOpponentEvidence().observations`
 * @param {object} [input.scenarioTable]   `{candidate_id: {exhaustive, source, rows:[{scenario_id, config, damage:{min,max}}]}}`
 * @param {object} [input.catalog]         RC-303 索引（判速度量纲要用它的 `spe`）
 */
export function updateOpponentCandidates(input = {}) {
  const {candidates = null, observations = null, scenarioTable = null, catalog = null} = input ?? {};
  const list = arr(Array.isArray(candidates) ? candidates : candidates?.candidates);
  const obs = isPlainObject(observations) ? observations : {};
  const ledger = [];
  const excluded = [];
  const contradictions = [];
  const unverified = [];
  const evidenceIds = new Set();
  // 观察里如果混进了 individual-* 出处 ⇒ 整份拒绝（03.2 立的规矩，更新这一层同样不许破）
  const badObservations = arr(obs.rejected).length > 0 ? arr(obs.rejected) : [];
  const individualInScenarios = [];
  for (const [candidateId, table] of Object.entries(isPlainObject(scenarioTable) ? scenarioTable : {})) {
    for (const row of arr(table?.rows)) {
      if (isNonEmptyString(row?.config?.stats_source) && row.config.stats_source.startsWith('individual')) {
        // 个体出处在这里是**允许的**：情景本来就是「对手可能是什么个体配置」的假设，不是观测。
        // 但必须写明它是假设（assumption），不能当成公开事实。
        if (row.assumption !== true) individualInScenarios.push({candidate_id: candidateId, scenario_id: row.scenario_id});
      }
    }
  }

  const observedIds = new Set(list.filter((row) => row?.basis === 'observed').map((row) => row.species_id));
  const usedSkills = arr(obs.used_skills);
  const petsWithSkills = [...new Set(usedSkills.map((row) => row.pet_id).filter(isNonEmptyString))].sort();

  // ── ① 已出技能 ⇒ 这只在队里（升级为 observed / 新增） ──
  const promoted = [];
  const added = [];
  const updated = list.map((row) => ({...row}));
  for (const petId of petsWithSkills) {
    const into = updated.find((row) => row.species_id === petId);
    const skillRows = usedSkills.filter((row) => row.pet_id === petId);
    skillRows.forEach((row) => evidenceIds.add(row.evidence_id));
    if (!into) {
      added.push({candidate_id: `cand:${petId}`, species_id: petId, basis: 'observed',
        why: '已出招 ⇒ 一定在对手队里（公开事实）', evidence_ids: skillRows.map((row) => row.evidence_id),
        skills: {known_used: skillRows.map((row) => ({skill_id: row.skill_id, name: row.name,
          source: 'view.opponent.revealed_skills'}))}});
      observedIds.add(petId);
      continue;
    }
    if (into.basis !== 'observed') {
      into.basis = 'observed';
      into.promoted_by_evidence = skillRows.map((row) => row.evidence_id);
      promoted.push({candidate_id: into.candidate_id, from: 'inferred', to: 'observed',
        evidence_ids: skillRows.map((row) => row.evidence_id)});
    }
  }
  ledger.push({
    id: 'evidence.used_skill_presence', kind: 'promote',
    reads: ['opponent.revealed_skills', 'view.events[].detail.skill_id'],
    inputs: [{pets_with_used_skills: petsWithSkills}],
    output: {promoted: promoted.length, added: added.length, already_observed: petsWithSkills.length - promoted.length - added.length},
    basis: '「这只打出了技能」是公开事实 ⇒ 它一定在对手队里；这条只**升级/新增**，不排除任何候选',
    applied: petsWithSkills.length > 0,
    ...(petsWithSkills.length === 0 ? {reason: '这一份证据里没有任何已出技能'} : {}),
  });

  // ── ② 已出技能 vs 可学池（只记矛盾，不排除） ──
  let checkedPools = 0;
  let contradictory = 0;
  for (const petId of petsWithSkills) {
    const candidate = updated.find((row) => row.species_id === petId);
    if (!candidate) continue;
    const poolIds = arr(candidate.skills?.possible).map((row) => row.skill_id);
    if (candidate.skills?.pool_tier !== 'frozen_learnset' || poolIds.length === 0) {
      unverified.push(`未核实：${petId} 的可学池不是冻结学招表（${candidate.skills?.pool_tier ?? 'none'}）`
        + '⇒ 不能拿它判「已出技能是否合法」');
      continue;
    }
    checkedPools += 1;
    const bad = usedSkills.filter((row) => row.pet_id === petId && row.skill_id !== null
      && !poolIds.includes(row.skill_id));
    if (bad.length > 0) {
      contradictory += 1;
      for (const row of bad) {
        contradictions.push({code: 'USED_SKILL_NOT_IN_FROZEN_LEARNSET', species_id: petId, skill_id: row.skill_id,
          evidence_ids: [row.evidence_id, candidate.skills.source_file ?? 'learnsets'],
          detail: '已出招的技能不在这只的**冻结学招表**里：学招表不全或形态对不上（候选保留，不排除）'});
      }
    }
  }
  ledger.push({
    id: 'evidence.used_skill_learnability', kind: 'check',
    reads: ['opponent.revealed_skills', 'candidates[].skills.possible'],
    inputs: [{pets: petsWithSkills, frozen_pools_checked: checkedPools}],
    output: {checked: checkedPools, contradictory},
    basis: '冻结学招表（542 只）是这一层最硬的依据；但它**可能不全**（80 只没有冻结表）'
      + '⇒ 冲突只记矛盾、不排除候选（不然会把真身冤杀）',
    applied: checkedPools > 0,
    ...(checkedPools === 0 ? {reason: '没有一只候选有冻结学招表可比（或没有已出技能）'} : {}),
    unverified: ['未核实：学招表完整性 —— 冻结层 542 只，其余只有工程启发式；冲突不排除候选'],
  });

  // ── ③ 可见伤害 ⇒ 情景集合（多解保留；穷尽时才排除） ──
  const active = isPlainObject(obs.visible_state) ? obs.visible_state : null;
  const enemyDamage = arr(obs.visible_damage).filter((row) => row.attacker_side === 'enemy');
  enemyDamage.forEach((row) => evidenceIds.add(row.evidence_id));
  const scenarioReport = [];
  let damageApplied = false;
  if (active !== null && enemyDamage.length > 0) {
    const candidate = updated.find((row) => row.species_id === active.species_id);
    const table = isPlainObject(scenarioTable) ? scenarioTable[active.species_id] : null;
    if (candidate && table) {
      damageApplied = true;
      const rows = arr(table.rows);
      const matches = rows.filter((row) => enemyDamage.every((obsRow) => {
        const range = row?.damage;
        if (Number.isFinite(range)) return range === obsRow.amount;
        const min = Number.isFinite(range?.min) ? range.min : null;
        const max = Number.isFinite(range?.max) ? range.max : null;
        return min !== null && max !== null && obsRow.amount >= min && obsRow.amount <= max;
      }));
      candidate.individual_range = {
        ...(candidate.individual_range ?? {}),
        known: false,
        scenarios: matches.map((row) => ({scenario_id: row.scenario_id, config: row.config ?? null,
          damage: row.damage ?? null, source: isNonEmptyString(row.source) ? row.source : (table.source ?? null),
          assumption: row.assumption === true})),
        note: matches.length >= 2
          ? `公开伤害解释了 ${matches.length} 种个体配置 ⇒ **多解全保留**（不强行猜中真实配装）`
          : '公开伤害与情景集合的相容情况见 update 账本',
      };
      candidate.multi_solution = matches.length >= 2;
      if (matches.length >= 2) {
        candidate.individual_range.unknowns = ['未核实：哪一种是真身 —— 同一份公开伤害由多种个体配置都能解释'];
      }
      if (matches.length === 0) {
        if (table.exhaustive === true) {
          excluded.push({candidate_id: candidate.candidate_id, rule_id: 'evidence.visible_damage_scenarios',
            why: `可见伤害 ${enemyDamage.map((row) => row.amount).join(' / ')} 与全部情景都不相容，`
              + '且情景集合声明**穷尽** ⇒ 排除这只（依据：伤害读数 + 情景来源）',
            evidence_ids: [...enemyDamage.map((row) => row.evidence_id), table.source ?? 'scenarioTable']});
        } else {
          contradictions.push({code: 'DAMAGE_UNEXPLAINED_BY_SCENARIOS', species_id: active.species_id,
            evidence_ids: enemyDamage.map((row) => row.evidence_id),
            detail: '可见伤害与已知情景都不相容，但情景集合**没声明穷尽** ⇒ 候选保留（多解可能还没列全）'});
        }
      }
      scenarioReport.push({candidate_id: candidate.candidate_id,
        observed: enemyDamage.map((row) => row.amount), scenarios: rows.length,
        matching: matches.length, multi_solution: matches.length >= 2,
        exhaustive: table.exhaustive === true});
    }
  }
  ledger.push({
    id: 'evidence.visible_damage_scenarios', kind: 'filter',
    reads: ['events[].kind=damage', 'opponent.field', 'scenarioTable（注入的引擎情景）'],
    inputs: [{active_species: active?.species_id ?? null,
      enemy_damage: enemyDamage.map((row) => ({turn: row.turn, skill_id: row.skill_id, amount: row.amount})),
      scenario_table: isPlainObject(scenarioTable) ? sortedKeys(scenarioTable) : []}],
    output: {applied: damageApplied, candidates: scenarioReport},
    basis: '伤害公式的**唯一实现**在引擎里（`effects.compute_damage`）：信念不重算，只拿注入的引擎情景'
      + '与公开伤害比相容性；多条相容 ⇒ 全保留（多解），一条都不相容且情景穷尽 ⇒ 才排除',
    applied: damageApplied,
    ...(damageApplied ? {} : {reason: enemyDamage.length === 0
      ? '这一份证据里没有对手打出来的伤害读数'
      : '没有「当前场上那只」的候选或没有注入情景集合 ⇒ 不敢用伤害排除任何候选'}),
    unverified: ['未核实：情景集合是否穷尽 —— 只有调用方显式声明 exhaustive:true 时才拿它排除候选'],
  });

  // ── ④ 先手速度（同量纲才用） ──
  const comparable = arr(obs.turn_order).filter((row) => row?.enemy_speed?.source === 'species-race');
  const incomparable = arr(obs.turn_order).length - comparable.length;
  let speedExcluded = 0;
  if (comparable.length > 0 && catalog) {
    for (const row of comparable) {
      const value = row.enemy_speed.value;
      for (const candidate of [...updated]) {
        const feature = typeof catalog?.featureFor === 'function' ? catalog.featureFor(candidate.species_id) : null;
        if (!Number.isFinite(feature?.spe)) continue;
        if (Number(feature.spe) === Number(value)) continue;
        if (candidate.basis === 'observed') continue;      // 已见的永不被排除（以观察为准）
        const at = updated.indexOf(candidate);
        if (at >= 0) updated.splice(at, 1);
        excluded.push({candidate_id: candidate.candidate_id, rule_id: 'evidence.turn_order_speed',
          why: `第 ${row.turn} 回合的公开先手速度是 ${value}（出处 species-race），与候选的物种速度 `
            + `${feature.spe} 不同 ⇒ 排除`,
          evidence_ids: [row.evidence_id]});
        speedExcluded += 1;
      }
    }
  }
  ledger.push({
    id: 'evidence.turn_order_speed', kind: 'filter',
    reads: ['events[].detail.speed_provenance.speeds.enemy'],
    inputs: [{comparable: comparable.length, incomparable}],
    output: {applied: comparable.length > 0, excluded: speedExcluded},
    basis: '先手速度只有在**同量纲**时才能跟候选比：出处 `species-race` 与候选宇宙的物种速度同一套；'
      + '`species-panel` 是面板量纲（本模块没有它的换算表）⇒ **不换算、不排除**（宽是安全的，窄才是编的）',
    applied: comparable.length > 0,
    ...(comparable.length > 0 ? {} : {reason: arr(obs.turn_order).length === 0
      ? '这一份证据里没有 `speed_provenance`：引擎只在面板口径下发它 ⇒ 先手速度没有读数'
      : `先手速度的出处是面板量纲（species-panel），与候选宇宙的物种速度不可比 ⇒ 不换算、不排除`
        + `（实测 ${incomparable} 条）`}),
  });

  const beforeIds = new Set(list.map((row) => row.species_id));
  const afterIds = new Set(updated.map((row) => row.species_id));
  const multiSolution = updated.filter((row) => row.multi_solution === true)
    .map((row) => ({candidate_id: row.candidate_id, options: arr(row.individual_range?.scenarios)
      .map((row2) => row2.scenario_id)}));
  return {
    protocol: EVIDENCE_UPDATE_PROTOCOL,
    available: true,
    unknown_reason: null,
    kept: updated,
    excluded,
    multi_solution: multiSolution,
    contradictions,
    observations: obs,
    observations_rejected: [...badObservations,
      ...(individualInScenarios.length > 0 ? individualInScenarios.map((row) => ({path: `scenarioTable.${row.candidate_id}.${row.scenario_id}`,
        why: '情景带 individual 出处却**没标 assumption:true**：那会被读成公开事实'})) : [])],
    rule_ledger: ledger,
    diff: {
      before: beforeIds.size,
      after: afterIds.size,
      promoted: promoted.map((row) => row.candidate_id),
      added: added.map((row) => row.candidate_id),
      excluded: excluded.map((row) => row.candidate_id),
      multi_solution: multiSolution.map((row) => row.candidate_id),
      evidence_ids_used: [...evidenceIds].sort(),
    },
    provenance: obs.contract ?? null,
    evidence: [
      evidence('view', 'view.opponent.revealed_skills', 'used_skill_presence',
        petsWithSkills, '已出技能 ⇒ 这只在队里（只升级，不排除）'),
      evidence('view', 'view.events[].kind=damage', 'visible_damage_scenarios',
        scenarioReport, '可见伤害与注入情景的相容性（多解全留；只有声明穷尽才排除）'),
      evidence('view', 'view.events[].detail.speed_provenance', 'turn_order_speed',
        {comparable: comparable.length, incomparable}, '先手速度只在同量纲时参与排除'),
    ],
    unverified: [
      '未核实：对手**真实个体配置** —— 公开面只到物种级；同一份伤害可能由多种配置解释（多解全保留）',
      '未核实：情景集合的完整性 —— 由调用方声明是否穷尽，本模块不自己补情景',
      ...unverified,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ③″ 情景集合与范围（03.4）：没有真实频率数据时**不许装概率**
// ─────────────────────────────────────────────────────────────────────────

/** 情景集合/范围输出的协议版本。 */
export const OUTLOOK_PROTOCOL = 'rc604-opponent-outlook/v1';

/** 范围的量纲：闭区间，**不是**概率、不是把握度。 */
export const RANGE_UNIT = '权重闭区间 [min, max]（同一情景内成员权重的取值范围；'
  + '**不是概率**、不是把握度、不是预测：它只说明「这些成员在这份基线里各占多少」）';

/**
 * 三种表达各自的**语义声明**（03.4 的核心：没有频率数据时不许把基线读成概率）。
 * 每一种都必须带 `is_probability:false` 与「为什么」，缺一个 ⇒ `SCENARIO_SEMANTICS_NOT_DECLARED`（红）。
 */
export const EXPRESSION_SEMANTICS = Object.freeze({
  uniform: Object.freeze({
    expression: 'uniform_weight',
    is_probability: false,
    why: '候选宇宙内每条候选一样重（1/N）：这是**无信息基线**，不是强度、不是胜率，'
      + '也不是版本环境占比 —— 本仓没有任何真实对局频次数据',
  }),
  conditioned: Object.freeze({
    expression: 'conditioned_weight',
    is_probability: false,
    why: '权重只由**已公开**事实（已亮明系别 / 物种速度、我方阵容、模式规模）筛 + 分层得到；'
      + '层内等权、层间只有一条声明过的假设（2:1 降权），**没有候选被压 0**',
  }),
  scenario_set: Object.freeze({
    expression: 'scenario_set',
    is_probability: false,
    why: '把候选按**速度档**分成若干个情景（每组可解释、可复算）：它回答「哪些候选在一起」，'
      + '不回答「哪一个更可能」—— 情景之间**不给优先级**、不给最优结论',
  }),
  range: Object.freeze({
    expression: 'range',
    is_probability: false,
    why: '每个情景给成员权重的**闭区间**（不是点估计）：区间宽度就是「这份基线只到这个精度」的如实表达；'
      + '均匀时 min == max，那是**基线退化**，不是「很确定」',
  }),
});

/**
 * **情景集合 + 范围**（03.4）：没有真实频率数据时的表达方式。
 *
 * 三条纪律：
 *   · **不装概率**：`declarations.is_probability === false` + 每种表达各自的 `why`；产出里没有任何
 *     「概率 / 把握度 / 最优 / 排名」字段；
 *   · **降级要明说**：候选为空、或证据自相矛盾时 `degraded:true` + `degrade_reasons[]`，
 *     并且**不给**单一最优情景（`best_scenario: null`）；
 *   · **频次缺就是缺**：`frequency.available === false` 时逐字带上缺什么 / 去哪拿
 *     （复用 `frequencyBelief()` 的 fail-closed 文本，不另写一套）。
 *
 * @param {object} input
 * @param {object} input.catalog           RC-303 索引 / 朴素数据
 * @param {object} [input.publicFacts]     公开事实；或给 `view` 让适配器搬
 * @param {object} [input.view]            真 `view`
 * @param {object} [input.skillPool]       技能池（同 `buildOpponentCandidates`）
 * @param {object} [input.observations]    证据观察（同 `updateOpponentCandidates`）
 * @param {object} [input.scenarioTable]   引擎情景（同 `updateOpponentCandidates`）
 * @param {number} [input.member_limit]    每个情景里列几个成员（默认 8；被裁掉的记 `members_omitted`）
 */
export function buildScenarioOutlook(input = {}) {
  const {catalog = null, publicFacts = null, view = null, skillPool = null,
    observations = null, scenarioTable = null, member_limit = 8} = input ?? {};
  const candidatesBuilt = buildOpponentCandidates({catalog, publicFacts, view, skillPool});
  const believed = revealedConditioned({catalog, publicFacts:
    publicFacts ?? (view !== null ? readOpponentView(view).publicFacts : null)});
  const frequency = frequencyBelief({});
  const weightByKey = new Map(arr(believed.weights?.rows).map((row) => [row.key, row]));
  const base = {
    protocol: OUTLOOK_PROTOCOL,
    available: false,
    degraded: true,
    degrade_reasons: [],
    frequency: {
      available: frequency.available,
      reason_code: frequency.available ? null : frequencyReasonCode(frequency),
      unknown_reason: frequency.available ? null : frequency.unknown_reason,
      note: '没有真实对局频次 ⇒ 不给概率预测；用情景集合与范围如实表达「我们知道到哪一层」',
    },
    declarations: {
      is_probability: false,
      not_a_prediction: '这不是「他会出哪只」的概率预测，也不是最优结论：没有频次数据时本模块'
        + '只给候选集合、情景分组与权重区间',
      uniform_is_baseline_only: true,
      expressions: EXPRESSION_SEMANTICS,
    },
    scenarios: [],
    ranges: null,
    members_total: 0,
    contradictions: [],
    evidence: [],
    unverified: [],
  };

  if (!candidatesBuilt.available) {
    return {...base,
      unknown_reason: candidatesBuilt.unknown_reason ?? FAIL_CLOSED_REASONS.REVEALED_EMPTY_POOL,
      degrade_reasons: [candidatesBuilt.unknown_reason?.slice(0, 48) ?? '候选集合不可用'],
      degraded_input: candidatesBuilt.leaked_fields?.length > 0 ? 'input_rejected' : 'no_candidates',
      best_scenario: null,
      unverified: ['未核实：任何情景 —— 候选集合本身不可用（空池或输入越界），这里一个情景都不给'],
    };
  }

  const rows = arr(candidatesBuilt.candidates);
  // 候选为空 ⇒ 明确降级（一个情景都不给）：空不是「更精确」，是「没有可说的」
  if (rows.length === 0) {
    return {...base,
      unknown_reason: FAIL_CLOSED_REASONS.REVEALED_EMPTY_POOL,
      degrade_reasons: ['候选集合为空（公开事实一条候选都推不出来）'],
      degraded_input: 'no_candidates',
      best_scenario: null,
      unverified: ['未核实：任何情景 —— 一条候选都没有，这里一个情景都不给'],
    };
  }
  const byBand = new Map();
  for (const row of rows) {
    const band = isNonEmptyString(row.speed_band) ? row.speed_band : 'unknown';
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(row);
  }
  const scenarios = [...byBand.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([band, members]) => {
    const weights = members.map((row) => weightByKey.get(row.species_id)).filter(Boolean);
    const values = weights.map((row) => row.value).filter(Number.isFinite);
    const observed = members.filter((row) => row.basis === 'observed').length;
    return {
      scenario_id: `band:${band}`,
      label: `速度档 ${band} 的候选（${members.length} 条，其中已见 ${observed} 条）`,
      basis: '按**速度档**分组（RC-303 speedBandFor 现算的工程三分位；分档口径见 rule_ledger）',
      member_count: members.length,
      observed_count: observed,
      inferred_count: members.length - observed,
      members: members.slice(0, member_limit).map((row) => row.species_id),
      members_omitted: Math.max(0, members.length - member_limit),
      range: values.length === 0 ? null : {
        min: Math.min(...values), max: Math.max(...values), unit: RANGE_UNIT,
        semantics: EXPRESSION_SEMANTICS.range,
      },
      complete: true,
      evidence: [evidence('injected:publicFacts', 'publicFacts', 'scenario_members', members.length,
        `情景 ${band} 的成员数（按物种；observed/inferred 分列）`)],
    };
  });

  // 证据矛盾 ⇒ 降级：情景标 incomplete、不给最优情景
  const update = observations === null && scenarioTable === null ? null
    : updateOpponentCandidates({catalog, candidates: candidatesBuilt, observations, scenarioTable});
  const contradictions = [...arr(candidatesBuilt.contradictions), ...arr(update?.contradictions)];
  const rejected = arr(update?.observations_rejected);
  const degradeReasons = [];
  if (candidatesBuilt.universe_size === 0) degradeReasons.push('候选宇宙为空（没有注入 catalog）');
  if (believed.available === false) {
    degradeReasons.push(`条件化信念不可用：${String(believed.unknown_reason ?? '').slice(0, 40)}`);
  }
  if (contradictions.length > 0) degradeReasons.push(`${contradictions.length} 条证据矛盾未消解`);
  if (rejected.length > 0) degradeReasons.push(`${rejected.length} 条观察越界（individual-*）被拒绝`);
  if (candidatesBuilt.budget?.truncated) degradeReasons.push(`候选被预算裁掉 ${candidatesBuilt.budget.dropped_count} 条（分布留在 budget.pool_summary）`);
  const degraded = degradeReasons.length > 0;
  if (degraded) {
    for (const scenario of scenarios) scenario.complete = false;
  }
  const allValues = arr(believed.weights?.rows).map((row) => row.value).filter(Number.isFinite);
  const observedRows = rows.filter((row) => row.basis === 'observed');
  const ranges = {
    pool: believed.pool_ratio === null || believed.pool_ratio === undefined ? null : {
      numerator: believed.pool_ratio.numerator, denominator: believed.pool_ratio.denominator,
      unit: believed.pool_ratio.unit,
    },
    weight: allValues.length === 0 ? null : {
      min: Math.min(...allValues), max: Math.max(...allValues), unit: RANGE_UNIT,
      semantics: EXPRESSION_SEMANTICS.range,
      degenerate: Math.min(...allValues) === Math.max(...allValues),
      degenerate_note: Math.min(...allValues) === Math.max(...allValues)
        ? '区间退化成一点 = 这一层里所有候选**同样重**（基线），不是「很确定」' : null,
    },
    observed_vs_inferred: {
      observed: observedRows.length, inferred: rows.length - observedRows.length,
      unit: '计数（条）',
      note: '「已见」与「推出来的」分开计数：已观察事实与推测不混用',
    },
  };

  return {
    ...base,
    available: true,
    degraded,
    degrade_reasons: degradeReasons,
    unknown_reason: believed.available === false ? believed.unknown_reason : null,
    best_scenario: null,
    best_scenario_reason: '本模块**不给最优情景**：没有频次数据时「哪个情景更好」没有依据；'
      + (degraded ? '而且当前存在未消解的降级原因' : '即使没有降级原因，情景之间也不排序'),
    candidates_budget: candidatesBuilt.budget,
    candidates_available: candidatesBuilt.available,
    beliefs: {
      uniform: {kind: 'non_informative_baseline', is_probability: false,
        semantics: EXPRESSION_SEMANTICS.uniform},
      conditioned: {available: believed.available, kind: believed.kind,
        pool_size: believed.pool_size, basis: believed.weights?.basis ?? null,
        is_probability: false, semantics: EXPRESSION_SEMANTICS.conditioned,
        unknown_reason: believed.unknown_reason ?? null},
      frequency: {available: false, semantics: EXPRESSION_SEMANTICS.scenario_set,
        note: '频次基线缺数据 ⇒ 用情景集合代替，且**不**把它展示成概率'},
    },
    scenarios,
    ranges,
    members_total: rows.length,
    contradictions,
    observations_rejected: rejected,
    update_diff: update?.diff ?? null,
    evidence: [
      ...candidatesBuilt.evidence.slice(0, 2),
      evidence('injected:publicFacts', 'publicFacts', 'scenario_set', scenarios.map((row) => row.scenario_id),
        '情景集合：按速度档分组（可解释、可复算）；情景之间不排序、不给最优'),
      evidence('injected:publicFacts', 'publicFacts', 'weight_range', ranges.weight,
        '权重区间：不是点估计；均匀时区间退化，那是基线而不是「确定」'),
      evidence('injected:publicFacts', 'frequencyData', 'frequency_available', frequency.available,
        '频次基线：本仓没有真实频次 ⇒ available:false（用情景集合与范围表达，不装概率）'),
    ],
    unverified: [
      '未核实：情景之间的优劣 —— 不给优先级、不给最优结论（没有频次数据就没有比较的依据）',
      '未核实：区间之外的候选 —— 被预算裁掉的部分只留分布（budget.pool_summary），没被算成 0',
      ...(degraded ? ['未核实：当前产出**已降级** —— 情景标 complete:false，降级原因见 degrade_reasons'] : []),
      ...(update?.unverified ?? []).slice(0, 2),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ③ 频次信念：需要真实对局数据（本仓没有 ⇒ fail closed）
// ─────────────────────────────────────────────────────────────────────────
/**
 * 归一化注入的频次数据。**没有来源就整份拒绝**（不是「退化成均匀」）。
 *
 * 认两种形状（都要求来源在场）：
 *   · 朴素：`[{species_id, count, sources:[{ref|path, date}], scope, revision}]`；
 *   · RC-304 的 `meta-prior` 形状：`{distribution_source:'measured', distribution:[{archetype_id, value, sources[]}]}`
 *     —— 复用同一条纪律：标了 measured 就必须有 url / 仓内文件 + 日期。
 *
 * @returns {{kind:'unavailable'|'measured', available:boolean, entries:Array, reason:string|null,
 *   missing:Array<string>, evidence:Array<object>}}
 */
export function normalizeFrequencyInput(frequencyData) {
  const raw = frequencyData;
  const rows = Array.isArray(raw) ? raw
    : arr(raw?.frequency).length ? arr(raw.frequency)
      : arr(raw?.distribution);
  const declared = (Array.isArray(raw) ? 'rows' : (raw?.declared_source ?? raw?.distribution_source ?? null));
  const declaredMeasured = declared === 'measured';
  const sourceRows = rows.map((row, index) => ({
    index,
    species_id: row?.species_id ?? row?.archetype_id ?? null,
    count: Number.isInteger(row?.count) ? row.count : null,
    scope: isNonEmptyString(row?.scope) ? row.scope : null,
    revision: isNonEmptyString(row?.revision) ? row.revision : null,
    sources: arr(row?.sources),
    has_source: arr(row?.sources).some((source) => isPlainObject(source)
      && (isNonEmptyString(source.ref) || isNonEmptyString(source.path))
      && (isNonEmptyString(source.date) || isNonEmptyString(source.as_of))),
    constructed: arr(row?.sources).some((source) => isPlainObject(source) && source.measured === false),
  }));

  const evidenceRows = [
    evidence('injected:frequencyData', 'frequencyData.declared_source', 'declared_source',
      declared === null ? null : declared,
      '频次数据的来源声明：没有它就没有「这份数字从哪来」这件事 —— 本模块不看声明就拒绝'),
    evidence('data/roco/meta-prior/v1.json', 'distribution[]', 'source', 'unknown（本仓现状）',
      '版本环境先验的分布全部 unknown + value:null：仓库里没有任何真实对局数据，'
      + '所以这里没有可以读出来的频次'),
  ];
  for (const row of sourceRows) {
    evidenceRows.push(evidence('injected:frequencyData', `frequency[${row.index}]`, 'count', row.count,
      `candidate=${row.species_id ?? '（缺）'}、scope=${row.scope ?? '（缺）'}、revision=${row.revision ?? '（缺）'}、`
      + `来源 ${arr(row.sources).map((source) => source?.ref ?? source?.path ?? '（无）').join(' / ') || '（无）'}`));
  }

  // 顺序是有意的：先问「这份数据自己说是从哪来的」，再问「它的行齐不齐」。
  // 反过来的话，一份裸数组会先拿到「行不可用」的理由，读的人就看不到最关键的那句
  // ——「你根本没告诉我这份数字从哪来」。
  if (!declaredMeasured) {
    return {kind: 'unavailable', available: false, entries: [], declared_source: declared,
      reason: FAIL_CLOSED_REASONS.FREQUENCY_NO_DECLARED_SOURCE,
      missing: ['frequencyData.declared_source = "measured"（或同义的实测声明）'],
      evidence: evidenceRows};
  }
  if (rows.length === 0) {
    return {kind: 'unavailable', available: false, entries: [], declared_source: declared,
      reason: FAIL_CLOSED_REASONS.FREQUENCY_ROWS_UNUSABLE, missing: ['frequency[]（一行都没有）'],
      evidence: evidenceRows};
  }
  const unusable = sourceRows.filter((row) => !isNonEmptyString(row.species_id) || row.count === null
    || row.count < 0 || !isNonEmptyString(row.scope) || !isNonEmptyString(row.revision));
  if (unusable.length > 0) {
    return {kind: 'unavailable', available: false, entries: [], declared_source: declared,
      reason: FAIL_CLOSED_REASONS.FREQUENCY_ROWS_UNUSABLE,
      missing: unusable.map((row) => `frequency[${row.index}]（缺 species_id / count / scope / revision）`),
      evidence: evidenceRows};
  }
  const unmeasured = sourceRows.filter((row) => !row.has_source);
  if (unmeasured.length > 0) {
    return {kind: 'unavailable', available: false, entries: [], declared_source: declared,
      reason: FAIL_CLOSED_REASONS.FREQUENCY_NO_MEASURED_SOURCE,
      missing: unmeasured.map((row) => `frequency[${row.index}].sources（缺 url / 仓内文件 + 日期）`),
      evidence: evidenceRows};
  }

  const total = sourceRows.reduce((sum, row) => sum + row.count, 0);
  return {
    kind: 'measured',
    available: true,
    declared_source: declared,
    // 构造样例（sources[].measured === false）的来源**结构**是完整的，所以通路会亮；
    // 这个计数是给报告读的：「这份 measured 里有几行其实是接线对照样例」必须看得见。
    constructed_rows: sourceRows.filter((row) => row.constructed).map((row) => row.species_id),
    entries: sourceRows.map((row) => ({
      species_id: row.species_id, count: row.count, scope: row.scope, revision: row.revision,
      sources: arr(row.sources).map((source) => ({ref: source?.ref ?? null, path: source?.path ?? null,
        date: source?.date ?? source?.as_of ?? null})),
      share: exact(row.count, total),
    })),
    total_count: total,
    reason: null,
    missing: [],
    evidence: evidenceRows,
  };
}

/**
 * 频次信念。**必须有真实对局频次数据**（带可核对来源）才 `available:true`。
 *
 * 本仓现在没有这类数据 ⇒ 默认 `available:false` + `unknown_reason` 点名「缺什么、去哪拿」。
 * **绝不用均匀分布冒充频次**：那不是「近似」，那是把无信息基线说成实测。
 *
 * @param {object} input
 * @param {object} [input.frequencyData]  带来源的频次数据（没有 ⇒ fail closed）
 */
export function frequencyBelief({frequencyData = null} = {}) {
  const normalized = normalizeFrequencyInput(frequencyData);
  const base = {
    belief: 'frequency',
    label: '对局频次基线（实测）',
    universe_size: null,
    weights: null,
    // 不可用时也要写清「这份信念本来要吃什么」：真实对局的候选出现频次（带来源）。
    declared_semantics: '这份信念的权重 = 真实对局里每个候选**出现次数 / 总次数**：'
      + '它是「见过多少次」的计数比，是实测数据的归一化；它**不是**本模块的均匀基线（等权不等于实测）。',
    red_lines: [
      '均匀分布**不是**频次的替身（无信息基线冒充实测＝编数据）',
      '没有 url / 仓内文件 + 日期的频次不进信念（来源在场也不代表数字是对的）',
      '频次本身是计数、是「见过多少次」，本模块不把它折成胜负结论',
    ],
    criteria: STRUCTURAL_CRITERIA.frequency_needs_real_source,
  };
  if (!normalized.available) {
    return {
      ...base,
      available: false,
      kind: 'not_available',
      informativeness: null,
      // 短码：报告与测试用它做稳定断言（完整原因仍在 unknown_reason 里，短码不是它的替代）
      reason_code: frequencyReasonCode({unknown_reason: normalized.reason}),
      unknown_reason: normalized.reason,
      missing: normalized.missing,
      declared_source: normalized.declared_source,
      evidence: normalized.evidence,
      confidence: 'UNKNOWN',
      unverified: [
        '未核实：对手出什么 —— 没有真实对局频次数据，本模块明确说不知道',
        '未核实：去哪拿 —— ① 实机对局统计（游戏内匹配记录 / 赛季数据面板导出，需 url 或仓内文件 + 日期）；'
          + '② 玩家提供的匿名化对局记录（需样本量 / 时间窗 / 采集方式）；'
          + '③ 离线联赛 / 自博弈产物（本仓没有，且 RC-601 规则绑定还 BLOCKED）',
      ],
    };
  }

  const total = exact(normalized.total_count, normalized.total_count);
  return {
    ...base,
    available: true,
    kind: 'measured_frequency',
    informativeness: 'measured_frequency',
    reason_code: null,
    declared_source: normalized.declared_source,
    total_count: normalized.total_count,
    distinct_candidates: normalized.entries.length,
    // 有几行是**接线对照样例**（来源结构完整、但不是实机统计）：报告里必须看得见。
    constructed_rows: normalized.constructed_rows,
    weights: {
      normalization: 'exact_fraction',
      total,
      unit: WEIGHT_UNIT,
      candidate_count: normalized.entries.length,
      // R2：带 weights 就必须声明依据。「这是实测频次占比」与「这是无信息基线」是**两回事**，
      // 所以这里给的是第三档，而不是复用基线那两档。
      basis: 'measured_frequency_distribution',
      is_probability: false,
      baseline_declaration: '这些权重是**实测频次占比**（带来源的计数比）：不是胜率、不是本局预测，'
        + '也不是「没出现过的候选不可能上场」——样本里没有的候选不在权重表里，不等于它的概率是 0。',
      rows: normalized.entries.map((row) => weightRow(row.species_id, row.share, WEIGHT_UNIT,
        `实测频次 ${row.count} / ${normalized.total_count}（scope=${row.scope}、revision=${row.revision}）`)),
    },
    declared_semantics: '这些权重 = 真实对局里每个候选**出现次数 / 总次数**。'
      + '它是「见过多少次」的计数比，**不是**强度、不是胜率、不是环境占比的结论：'
      + '样本量、时间窗、段位与采集方式都在 scope / revision / sources 里逐条可查。',
    unknown_reason: null,
    missing: [],
    evidence: normalized.evidence,
    confidence: 'CROSS_SOURCE_SUPPORTED',
    unverified: [
      '未核实：注入频次的真实性 —— 本模块只检查「有没有来源 + 样本标签」，**不联网核对**、也不重算频次',
      '未核实：频次能不能推广到当前匹配环境 —— 时间窗与段位口径由调用方负责（本模块不推断）',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 人读短结论：只重排已有字段，不新增任何数值
// ─────────────────────────────────────────────────────────────────────────

/** 数值文本：`0.5`（**不加百分号**，本模块不产出百分数）。 */
const formatWeight = (value) => (Number.isFinite(value) ? String(value) : 'unknown');

/** 把三份信念渲染成短结论。**只重排已有字段**，不新增数值、不写胜率。 */
export function renderBeliefText(beliefs) {
  const lines = [];
  for (const belief of arr(beliefs)) {
    if (belief.available) {
      lines.push(`${belief.belief}：available（kind=${belief.kind}）`);
    } else {
      lines.push(`${belief.belief}：unknown —— ${String(belief.unknown_reason ?? '').slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// 审计：把每条纪律变成机器判据（必红方向）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 伪精确 / 榜单禁令（与 RC-303/304 同一份语义）。
 *
 * 与 RC-304 的差别只有一处：**「期望值」不再整条禁掉**，而是要求它必须带
 * 「无信息基线」声明（`non_informative_declared`）—— RC-604 的任务书就是
 * 「给期望值 = 1/N 时必须同时说明它是无信息基线」，一句禁掉会让这条要求无法实现。
 * 胜率 / 概率 / 强度这些词照旧一个都不许出现。
 */
export const BANNED_CLAIM_KEYS = Object.freeze([
  'win_rate', 'winrate', 'win_probability', 'win_rate_smoothed', 'strength_score', 'power_score',
  'rank_score', 'tier', 'rating', 'elo', 'meta_share', 'usage_rate', 'pick_rate', 'ban_rate',
  '胜率', '强度分', '评分', 'hash',
]);
/** 榜单词与伪精确词（量纲里出现同样判红，见 `BANNED_UNIT_WORDS`）。 */
export const BANNED_CLAIM_WORDS = Object.freeze([
  'T0', 'T1', 'T2', 'T3', 'S级', 'A级', 'B级', '强势', '必带', '梯队', '幻神', '超模', '版本之子', '上分首选',
  '胜率', '强度分', '强度值', '差不多',
]);

/**
 * 否定语境标记（在 RC-304 的表上补两个：`不产出` / `不预测`）。
 *
 * 为什么补：本模块的量纲字段必须能写「信念权重（……不是胜率、不是概率预测）」——
 * 这句话是**声明边界**，把量纲写成「胜率（%）」才是伪精确。
 * 判据仍然有牙：直接写「胜率 62%」前面没有任何否定词，照样红。
 */
export const NEGATION_MARKERS = Object.freeze(['不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '而非', '绝非', '不知道', '不产出', '不预测']);

const isNegatedClaim = (text, at) => {
  const window = String(text).slice(Math.max(0, at - 18), at);
  return NEGATION_MARKERS.some((marker) => window.includes(marker));
};

/**
 * 伪精确扫描的范围：信念的**值承载字段**（`declared_semantics` / `weights` / `pool_ratio` /
 * `expected_per_candidate` / `rule_ledger[].basis` / `unverified` / `red_lines` …），
 * 只排除判据正文与反证留痕（`criteria` / `definition` / `basis` 的判据副本 / `red_proofs`）。
 * **键名检查不受豁免**：把胜率藏在一个自定义键里照样红。
 */
const CLAIM_EXCLUDED_FIELDS = Object.freeze([
  'criteria', 'definition', 'red_proofs', 'structural',
  // `declared_semantics` / `red_lines` / `does_not_do` 是**边界声明**：它们必须能写
  // 「这不是胜率、不产出百分数」；整条扫会把最该留的那句判红（否定语境仍在，双保险）。
  'declared_semantics', 'red_lines', 'does_not_do',
]);

const withoutExcluded = (value) => {
  if (Array.isArray(value)) return value.map(withoutExcluded);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (CLAIM_EXCLUDED_FIELDS.includes(key)) continue;
    out[key] = withoutExcluded(item);
  }
  return out;
};

/**
 * 从一份产出里抽出「要按伪精确判据扫」的字段。
 *
 * ⚠ 这里**不能**手挑字段白名单：早先只挑了 `declared_semantics` / `weights` / `rule_ledger` 等字段，
 * 于是 `beliefs[0].win_rate = 0.62` 这种注入**根本不在扫描范围内** —— 判据是绿的，
 * 但「键名检查不受豁免」这句话已经失效了（实测踩到）。所以整条信念都进扫描，
 * 由 `withoutExcluded` 按字段名递归剔除判据正文与边界声明这几类**值**（键名永远不剔除）。
 */
export function collectClaimText(result) {
  const out = {};
  for (const belief of arr(result?.beliefs)) {
    out[belief?.belief ?? 'belief'] = withoutExcluded(belief ?? null);
  }
  return out;
}

/**
 * 取源码的**在线段**：`ONLINE_SECTION_MARKER` **定义行之后**、`OFFLINE_SECTION_MARKER` **之前**的正文，
 * 剥掉行注释与块注释。
 *
 * ⚠ 2026-09-30（F-03-1）：旧实现是 `text.indexOf(ONLINE_SECTION_MARKER)` 之后 `slice(0, at)` ——
 * 命中的是**常量定义那一行自己**，于是「在线段」只剩文件头注释（69 行），在线函数一行都没扫。
 * 现在两处都按**结构**切：
 *   ① 起点 = 标记字符串所在行的**行尾之后**（定义行不算在线代码）；
 *   ② 终点 = 离线段标记所在位置（它之前全是在线段）。
 */
export function onlineSectionOf(source) {
  const text = String(source ?? '');
  const offlineAt = text.indexOf(OFFLINE_SECTION_MARKER);
  const head = offlineAt >= 0 ? text.slice(0, offlineAt) : text;
  const markerAt = head.indexOf(ONLINE_SECTION_MARKER);
  const lineEnd = markerAt >= 0 ? head.indexOf('\n', markerAt) : -1;
  const body = markerAt >= 0 ? head.slice(lineEnd >= 0 ? lineEnd + 1 : markerAt) : head;
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/**
 * **在线段的覆盖读数**（F-03-1）：光看 `hits=[]` 分不清「扫过、干净」与「扫了个空」。
 *
 * 返回在线段长度 + **真的被扫到的在线入口** + 缺失的入口。审计把「缺失」判红
 * （`ONLINE_COVERAGE_INCOMPLETE`），这样「段子变空」这种假绿不可能再通过。
 */
export function onlineSectionCoverage(source, options = {}) {
  const section = typeof options.section === 'string' ? options.section : onlineSectionOf(source);
  const defined = (name) => new RegExp(`(function|const|let|class)\\s+${name}\\b`, 'u').test(section);
  const scanned = ONLINE_ENTRYPOINTS.filter(defined);
  const missing = ONLINE_ENTRYPOINTS.filter((name) => !defined(name));
  const hits = scanForbiddenPatterns(section, options.patterns ?? FORBIDDEN_ONLINE_PATTERNS);
  return {
    online_lines: section.split('\n').length,
    online_chars: section.length,
    scanned_online_entrypoints: scanned,
    missing_online_entrypoints: missing,
    hits: hits.map((hit) => `${hit.code}:${hit.pattern}`),
  };
}

/** 取源码的**离线段**：`OFFLINE_SECTION_MARKER` 之后的正文（不剥注释，边界要看得见）。 */
export function offlineSectionOf(source) {
  const text = String(source ?? '');
  const markerAt = text.indexOf(OFFLINE_SECTION_MARKER);
  return markerAt >= 0 ? text.slice(markerAt) : '';
}

/** 在一个源码段里找禁止的调用模式。 */
export function scanForbiddenPatterns(sectionText, patterns = FORBIDDEN_ONLINE_PATTERNS) {
  const hits = [];
  const lines = String(sectionText ?? '').split('\n');
  lines.forEach((line, index) => {
    for (const spec of patterns) {
      if (!line.includes(spec.pattern)) continue;
      hits.push({code: spec.id, pattern: spec.pattern, line: index + 1, text: line.trim(), detail: spec.detail});
    }
  });
  return hits;
}

/**
 * 量纲的禁令：`unit` 里出现被禁词或字面百分号就是「把权重伪装成概率」。
 *
 * `negationAware`（默认 true）：否定语境里的量纲词放行 —— 量纲必须能写
 * 「**不是**胜率、**不是**概率预测」这句边界声明。关闭它就等于「量纲里一个词都不许有」，
 * 那样实现方只能把那句话删掉，反而更坏。
 */
export const unitProblems = (unit, {negationAware = true} = {}) => {
  if (typeof unit !== 'string') return [];
  const hits = [];
  const find = (word) => {
    let at = unit.indexOf(word);
    while (at >= 0) {
      if (!(negationAware && isNegatedClaim(unit, at))) hits.push(word);
      at = unit.indexOf(word, at + word.length);
    }
  };
  for (const word of BANNED_UNIT_WORDS) find(word);
  find('%');
  return hits;
};

const collectBannedText = (value, path, hits, depth = 0) => {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const word of BANNED_CLAIM_WORDS) {
      const at = value.indexOf(word);
      if (at < 0 || isNegatedClaim(value, at)) continue;
      hits.push({code: 'PSEUDO_PRECISION', path, word, text: value.slice(0, 120)});
    }
    const pct = value.match(/%/);
    if (pct && !isNegatedClaim(value, pct.index)) {
      hits.push({code: 'PSEUDO_PRECISION', path, word: '%（伪精确百分数）', text: value.slice(0, 120)});
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBannedText(item, `${path}[${index}]`, hits, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (BANNED_CLAIM_KEYS.includes(key)) {
        hits.push({code: 'PSEUDO_PRECISION', path: `${path}.${key}`, word: `键 ${key}`, text: stableJson(item).slice(0, 120)});
      }
      collectBannedText(item, `${path}.${key}`, hits, depth + 1);
    }
  }
};

/** 扫描的**口径**：默认只扫在线段 —— 离线段允许读盘、允许动态 import。 */
export const SCAN_SCOPES = Object.freeze(['online', 'whole']);
const sourceText = (source, scope) => (typeof source !== 'string' ? null
  : (scope === 'online' ? onlineSectionOf(source) : source));

/**
 * 审计一份产出（`beliefReport()` 的返回值，或把它改坏后的版本）。
 * 每条判据都有必红方向，测试逐条改坏、必须变红，并把实际输出原文打出来。
 *
 * @param {object} result   `{beliefs:[...], ...}`（或其被改坏的版本）
 * @param {object} [options]
 * @param {string} [options.source]   `src/coach/opponent-belief.mjs` 的源码（结构判据）
 * @param {string} [options.scope]    扫描口径（默认 `online`）
 * @param {object} [options.snapshot] 同一输入第二次运行的结果（确定性判据）
 * @param {string} [options.text]     渲染文本（伪精确判据连同它一起扫）
 */
export function auditOpponentBelief(result, options = {}) {
  const problems = [];
  const push = (code, where, detail) => problems.push(auditProblem(code, where, detail));
  const scope = SCAN_SCOPES.includes(options.scope) ? options.scope : 'online';
  const beliefs = arr(result?.beliefs);
  // 分母复核：注入 catalog 时**直接从数据现数一遍**，与信念声明的 universe_size 对照。
  // 这是「分母来自数据」这条判据唯一不可能被自洽伪造的查法。
  const auditedUniverse = options.catalog === undefined || options.catalog === null
    ? null : buildCandidateUniverse(options.catalog);

  if (beliefs.length === 0) {
    push('BELIEF_SHAPE', 'beliefs', '产出一份信念都没有：三条基线必须逐条给形状（含 fail closed 的那两条）');
  }

  for (const belief of beliefs) {
    const where = `beliefs.${belief?.belief ?? '?'}`;
    for (const field of ['available', 'kind', 'evidence', 'confidence', 'unknown_reason',
      'declared_semantics', 'red_lines', 'weights']) {
      if (!isPlainObject(belief) || !(field in belief)) {
        push('BELIEF_SHAPE', `${where}.${field}`, `缺字段 ${field}：每个量都要有 available / unknown_reason / evidence / confidence`);
      }
    }
    if (!isPlainObject(belief)) continue;
    if (typeof belief.available !== 'boolean') {
      push('BELIEF_SHAPE', `${where}.available`, `available 必须是布尔，实际 ${stableJson(belief.available)}`);
    }
    if (!BELIEF_KINDS.includes(belief.kind)) {
      push('BELIEF_SHAPE', `${where}.kind`, `kind ${stableJson(belief.kind)} 不在 ${BELIEF_KINDS.join(' / ')}`);
    }
    if (!Array.isArray(belief.evidence) || belief.evidence.length === 0) {
      push('EVIDENCE_MISSING', `${where}.evidence`, '信念没有 evidence[]：没有证据的结论不许出现');
    } else if (belief.evidence.some((item) => !item?.source_file || !item?.pointer || !item?.field)) {
      push('EVIDENCE_MISSING', `${where}.evidence`, '证据项缺 source_file / pointer / field');
    }
    if (!CONFIDENCE_LEVELS.includes(belief.confidence)) {
      push('CONFIDENCE_NOT_IN_LEDGER', `${where}.confidence`, `confidence ${stableJson(belief.confidence)} 不在台账六级里`);
    }
    if (!Array.isArray(belief.red_lines) || belief.red_lines.length === 0) {
      push('NON_INFORMATIVE_NOT_DECLARED', `${where}.red_lines`,
        '信念没有 red_lines[]：必须写清「这份权重不能用来做什么」');
    }

    // ── 可用性形状：available:false 不许带任何数值 / 量纲 ──
    if (belief.available === true) {
      if (!isPlainObject(belief.weights)) {
        push('AVAILABILITY_SHAPE', `${where}.weights`, 'available:true 却没有 weights：算不出来就 available:false + unknown_reason');
      } else {
        if (belief.weights.normalization !== 'exact_fraction') {
          push('AVAILABILITY_SHAPE', `${where}.weights.normalization`,
            '权重必须用精确分数归一化（exact_fraction）：浮点累加会逼出容差，容差是伪精确的温床');
        }
        const total = belief.weights.total;
        if (!isPlainObject(total) || total.numerator !== total.denominator || total.numerator === null) {
          push('AVAILABILITY_SHAPE', `${where}.weights.total`,
            `权重合计必须**恰好**等于 1（分数形式 n/n），实际 ${stableJson(total)}`);
        }
        for (const [where2, unit] of [['unit', belief.weights.unit],
          ...arr(belief.weights.rows).map((row, index) => [`rows[${index}].unit`, row?.unit])]) {
          for (const word of unitProblems(unit)) {
            push('PSEUDO_PRECISION', `${where}.weights.${where2}`,
              `量纲里出现被禁止的词 ${stableJson(word)}（${stableJson(unit)}）：本模块不产出胜率 / 概率 / 百分数`);
          }
        }
        const rows = arr(belief.weights.rows);
        for (const row of rows) {
          if (!isNonEmptyString(row?.key)) {
            push('AVAILABILITY_SHAPE', `${where}.weights.rows`, '权重行必须点名具体候选（key）');
          }
          if (!Number.isInteger(row?.numerator) || !Number.isInteger(row?.denominator) || row.denominator === 0) {
            push('AVAILABILITY_SHAPE', `${where}.weights.rows`,
              `权重必须是整数分子 / 分母对，实际 ${stableJson(row)}`);
          } else if (row.numerator < 0 || row.numerator > row.denominator) {
            push('AVAILABILITY_SHAPE', `${where}.weights.rows`,
              `权重必须落在 [0, 1]（非负、不超过 1），实际 ${row.numerator}/${row.denominator}`);
          }
        }
        if (rows.length > 0) {
          const sum = rows.reduce((acc, row) => addExact(acc, exact(row.numerator, row.denominator)), exact(0, 1));
          const delta = compareExact(sum, exact(1, 1));
          if (delta !== 0) {
            push('AVAILABILITY_SHAPE', `${where}.weights.rows`,
              `逐条权重合计必须恰好 = 1（分数），实际 ${sum.numerator}/${sum.denominator}`);
          }
        }
      }
      if (isNonEmptyString(belief.unknown_reason)) {
        push('AVAILABILITY_SHAPE', `${where}.unknown_reason`,
          'available:true 却带着 unknown_reason：可用与未知不能同时声明');
      }
    } else if (belief.available === false) {
      if (belief.weights !== null && belief.weights !== undefined) {
        push('UNKNOWN_BELIEF_HAS_VALUE', `${where}.weights`,
          'available:false 却给了权重：unknown 不许拿一个数（含 0）顶替');
      }
      if (belief.expected_per_candidate !== null && belief.expected_per_candidate !== undefined) {
        push('UNKNOWN_BELIEF_HAS_VALUE', `${where}.expected_per_candidate`,
          'available:false 却给了期望权重：没有分母就没有 1/N');
      }
      if (belief.pool_ratio !== null && belief.pool_ratio !== undefined) {
        push('UNKNOWN_BELIEF_HAS_VALUE', `${where}.pool_ratio`, 'available:false 却给了池子占比');
      }
      if (!isNonEmptyString(belief.unknown_reason)) {
        push('AVAILABILITY_SHAPE', `${where}.unknown_reason`, 'available:false 必须点名缺什么（unknown_reason）');
      }
      if (belief.confidence !== 'UNKNOWN') {
        push('CONFIDENCE_NOT_IN_LEDGER', `${where}.confidence`,
          `available:false 的信念 confidence 只能是 UNKNOWN，实际 ${stableJson(belief.confidence)}`);
      }
    }

    // ── R2（**任何**带 `weights` 的信念）：必须声明这份权重是拿什么算出来的 ──
    // 早先这条只挂在 `revealed_conditioned` 的「rows 非空」分支里 ⇒ `uniform` 信念（有 weights、
    // 没有 rows）把 `basis` 改坏根本不触发 —— 那是缺口，不是豁免。现在按「有没有 weights」判。
    if (isPlainObject(belief.weights)) {
      if (!WEIGHT_BASES.includes(belief.weights.basis)) {
        push('WEIGHT_BASIS_NOT_DECLARED', `${where}.weights.basis`,
          `权重依据 ${stableJson(belief.weights.basis)} 不在 ${WEIGHT_BASES.join(' / ')}：`
          + '凡带 weights 的产出都必须声明它是哪种基线 / 假设 / 实测（否则读的人只能自己猜那串小数是什么）');
      }
      if (belief.weights.is_probability !== false) {
        push('WEIGHT_BASIS_NOT_DECLARED', `${where}.weights.is_probability`,
          '权重必须显式声明 is_probability:false（权重合计 1 只是归一化，不是概率预测）');
      }
      if (!isNonEmptyString(belief.weights.baseline_declaration)) {
        push('WEIGHT_BASIS_NOT_DECLARED', `${where}.weights.baseline_declaration`,
          '权重必须带一句人读的边界声明（baseline_declaration）：这份权重能用来做什么、不能用来做什么');
      }
    }

    // ── 均匀基线：分母来自数据 + 无信息声明 ──
    if (belief.belief === 'uniform' && belief.available === true) {
      const expected = belief.expected_per_candidate;
      if (!isPlainObject(expected) || expected.denominator !== belief.universe_size
        || expected.numerator !== 1 || !Number.isInteger(belief.universe_size) || belief.universe_size <= 0) {
        push('DENOMINATOR_NOT_FROM_DATA', `${where}.expected_per_candidate`,
          `期望权重必须是 1 / universe_size（分母 = 从数据数出来的候选宇宙大小），`
          + `实际 ${stableJson(expected)}、universe_size=${stableJson(belief.universe_size)}`);
      }
      // 分母还必须与同一份信念里**其它声明的分母**一致（weights.candidate_count / 逐条明细条数）：
      // 只查 1/N 与 universe_size 自洽会漏掉「把两处一起改成写死的 48」这种改法。
      const declaredCounts = [['weights.candidate_count', belief.weights?.candidate_count ?? null],
        ['weights.rows', Array.isArray(belief.weights?.rows) ? belief.weights.rows.length : null]];
      for (const [where2, count] of declaredCounts) {
        if (count === null) continue;
        if (count !== belief.universe_size) {
          push('DENOMINATOR_NOT_FROM_DATA', `${where}.${where2}`,
            `声明的候选数 ${count} 与 universe_size ${belief.universe_size} 不一致：`
            + '同一份信念里同一个分母只能有一个值');
        }
      }
      const semantics = String(belief.declared_semantics ?? '');
      if (!/无信息基线/u.test(semantics) || !/不是/u.test(semantics)) {
        push('NON_INFORMATIVE_NOT_DECLARED', `${where}.declared_semantics`,
          '给 expected_per_candidate 时必须同时声明它是**无信息基线**、**不是**强度判断 / 胜率');
      }
      if (isNonEmptyString(expected?.unit) && !/无信息基线/u.test(expected.unit)) {
        push('NON_INFORMATIVE_NOT_DECLARED', `${where}.expected_per_candidate.unit`,
          '期望权重的量纲里必须写明「无信息基线」');
      }
      if (auditedUniverse !== null && belief.universe_size !== auditedUniverse.size) {
        push('DENOMINATOR_NOT_FROM_DATA', `${where}.universe_size`,
          `声明的分母 ${stableJson(belief.universe_size)} 与从注入数据现数的候选宇宙 ${auditedUniverse.size} 不一致：`
          + '分母只能来自数据（写死 48 / 600 / 622 都会被这一条抓住）');
      }
    }

    // ── 条件化：规则账本可复算 + 公开性边界 + 「假设不许排除候选」 ──
    if (belief.belief === 'revealed_conditioned') {
      const leaked = arr(belief.leaked_fields);
      if (leaked.length > 0 && belief.available === true) {
        push('PUBLIC_FACTS_BOUNDARY', `${where}.leaked_fields`,
          `公开事实越界（${leaked.map((row) => `${row?.code ?? 'HIDDEN_FIELD'}:${row?.path ?? row}`).join(' / ')}）`
          + '却仍然 available:true：越界必须拒绝整个输入，不许静默过滤后照样出权重');
      }
      if (belief.available === true) {
        const ledger = arr(belief.rule_ledger);
        if (ledger.length < RULE_IDS.length) {
          push('RULE_LEDGER_INCOMPLETE', `${where}.rule_ledger`,
            `规则账本必须逐条列出 ${RULE_IDS.length} 条规则（含 not_applied 的），实际 ${ledger.length} 条`);
        }
        for (const row of ledger) {
          const at = `${where}.rule_ledger[${row?.id ?? '?'}]`;
          if (!isNonEmptyString(row?.id) || !RULE_IDS.includes(row.id)) {
            push('RULE_LEDGER_INCOMPLETE', at, `规则 id ${stableJson(row?.id)} 不在 ${RULE_IDS.join(' / ')}`);
          }
          if (!isNonEmptyString(row?.basis)) {
            push('RULE_LEDGER_INCOMPLETE', at, '规则缺 basis（依据）：输入 → 输出 → 依据 三样缺一不可');
          }
          if (!Array.isArray(row?.reads) || row.reads.length === 0) {
            push('RULE_LEDGER_INCOMPLETE', at, '规则缺 reads[]（它读哪几个公开事实字段）');
          }
          if (row?.applied === true && (!isPlainObject(row.output)
            || Object.values(row.output).every((item) => item === null))) {
            push('RULE_LEDGER_INCOMPLETE', at, 'applied:true 的规则必须给出非空 output（匹配数 / 层大小）');
          }
          if (row?.applied !== true && !isNonEmptyString(row?.reason)) {
            push('RULE_LEDGER_INCOMPLETE', at, 'not_applied 的规则必须写清原因（缺哪个字段）');
          }
        }
        if (!arr(belief.weights?.rows).length) {
          push('RULE_LEDGER_INCOMPLETE', `${where}.weights.rows`,
            '条件化信念必须给出逐条权重（它是可复算的规则跑出来的，不是等权）');
        }
        // ── R4：假设不许把候选压 0（只有公开证据才能排除候选） ──
        const zeroed = arr(belief.weights?.rows).filter((row) => row?.numerator === 0);
        if (zeroed.length > 0) {
          push('ASSUMPTION_ZEROES_CANDIDATE', `${where}.weights.rows`,
            `有 ${zeroed.length} 条候选权重为 0（例如 ${stableJson(zeroed[0]?.key)}）：`
            + '仅凭假设（我方速度层次等）把候选压 0 = 声称这只不可能上场；'
            + '排除只能来自公开证据并写明证据 ID');
        }
      }
      // ── 来源必填（H1/H2/H5）：缺来源 / 个体口径 / 缺规则版本都要在产出里看得见 ──
      const prov = belief.provenance;
      if (!isPlainObject(prov)) {
        push('PROVENANCE_MISSING', `${where}.provenance`,
          '条件化信念必须带 provenance（match_id / rules_version / decision_id，缺就是 null）：'
          + '每项候选都要能说清它属于哪一局、哪份规则');
      } else if (!isNonEmptyString(prov.rules_version)) {
        push('PROVENANCE_MISSING', `${where}.provenance.rules_version`,
          '没有规则版本（01.2 契约的 rules_version）：候选无法绑定到具体规则版本 ⇒ 必须在 unverified 里点名');
      }
    }

    // ── 频次：不许用均匀分布冒充 ──
    if (belief.belief === 'frequency') {
      if (belief.available === true) {
        if (belief.kind !== 'measured_frequency') {
          push('FREQUENCY_FAKED', `${where}.kind`,
            `频次信念可用时 kind 必须是 measured_frequency，实际 ${stableJson(belief.kind)}`);
        }
        if (!isNonEmptyString(belief.declared_source)) {
          push('FREQUENCY_FAKED', `${where}.declared_source`,
            '频次信念可用却没有来源声明：没有来源的频次就是编的数据');
        }
        if (!Number.isInteger(belief.total_count) || belief.total_count <= 0) {
          push('FREQUENCY_FAKED', `${where}.total_count`,
            `频次信念必须给出正整数样本量，实际 ${stableJson(belief.total_count)}`);
        }
        const sources = arr(belief.evidence).filter((row) => /frequency/iu.test(String(row?.source_file ?? ''))
          && String(row?.source_file ?? '').startsWith('injected:'));
        if (sources.length === 0) {
          push('FREQUENCY_FAKED', `${where}.evidence`,
            '频次信念的证据必须至少有一条指向**注入的频次数据**（injected:frequencyData…）：'
            + '没有来源在场的频次信念就是编的');
        }
      } else if (/均匀|uniform/iu.test(String(belief.declared_semantics ?? ''))
        && !/不是|不许|不用/u.test(String(belief.declared_semantics ?? ''))) {
        push('FREQUENCY_FAKED', `${where}.declared_semantics`,
          '频次不可用时不许把均匀分布写成它的替身');
      }
    }
  }

  // ── 在线段不许出现引擎 / 子进程调用；**并且在线段必须真的覆盖到在线入口**（F-03-1） ──
  const section = sourceText(options.source, scope);
  if (typeof section === 'string') {
    for (const hit of scanForbiddenPatterns(section)) {
      push(hit.code, `src/coach/opponent-belief.mjs:${hit.line}（scanned=${scope}）`,
        `出现 ${hit.pattern}：${hit.detail}（实际源码 ${stableJson(hit.text)}）`);
    }
    if (scope === 'online') {
      // 覆盖判据：`hits=[]` 分不清「扫过、干净」与「扫了个空」。段子变空必须判红。
      // （旧口径下在线段只有 69 行文件头 ⇒ 所有在线函数都没被扫，却一路显示干净。）
      const coverage = onlineSectionCoverage(options.source, {section, patterns: options.patterns});
      if (coverage.missing_online_entrypoints.length > 0) {
        push('ONLINE_COVERAGE_INCOMPLETE', 'src/coach/opponent-belief.mjs',
          `在线段只覆盖了 ${coverage.scanned_online_entrypoints.length} / ${ONLINE_ENTRYPOINTS.length} 个在线入口`
          + `（扫过的行数 ${coverage.online_lines}）；缺 ${coverage.missing_online_entrypoints.join(' / ')}：`
          + '「没扫到」与「扫过、没问题」必须分得开 —— 覆盖为空时判据是假绿');
      }
      for (const entry of OFFLINE_ENTRYPOINTS) {
        if (section.includes(entry.id)) {
          push('OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION', 'src/coach/opponent-belief.mjs',
            `离线入口 ${entry.id} 出现在在线段里：离线与在线入口必须分开导出`);
        }
      }
    }
  }

  // ── 伪精确：值承载字段 + 渲染文本 ──
  const hits = [];
  collectBannedText(collectClaimText(result), 'claims', hits);
  if (typeof options.text === 'string') {
    for (const word of BANNED_CLAIM_WORDS) {
      const at = options.text.indexOf(word);
      if (at >= 0 && !isNegatedClaim(options.text, at)) {
        hits.push({code: 'PSEUDO_PRECISION', path: 'text', word, text: options.text.slice(0, 120)});
      }
    }
    const pct = options.text.match(/%/);
    if (pct && !isNegatedClaim(options.text, pct.index)) {
      hits.push({code: 'PSEUDO_PRECISION', path: 'text', word: '%（伪精确百分数）', text: options.text.slice(0, 120)});
    }
  }
  for (const hit of hits) push(hit.code, hit.path, `出现 ${hit.word}：${stableJson(hit.text)}`);

  // ── 确定性 ──
  if (options.snapshot !== undefined) {
    const pairs = [['beliefs', beliefs, arr(options.snapshot?.beliefs)]];
    if (typeof options.text === 'string' && typeof options.snapshot?.text === 'string') {
      pairs.push(['text', options.text, options.snapshot.text]);
    }
    for (const [where, first, second] of pairs) {
      if (stableJson(first) !== stableJson(second)) {
        push('NONDETERMINISTIC', `opponentBelief:${where}`,
          `同一输入两次运行的 JSON.stringify 不一致（含 tie-break）：`
          + `${stableJson(first).slice(0, 160)} vs ${stableJson(second).slice(0, 160)}`);
      }
    }
  }

  // ── 候选协议（03.2）：已知不合法的技能组合**一个都不许进候选**（必做反例②，独立复算） ──
  for (const candidate of arr(result?.candidates)) {
    const where = `candidates.${candidate?.candidate_id ?? '?'}`;
    const legality = isPlainObject(candidate?.skills?.legality) ? candidate.skills.legality : null;
    if (legality === null) {
      push('ILLEGAL_LOADOUT_IN_CANDIDATES', where,
        '候选没有 skills.legality：技能组合的合法性没有登记 ⇒ 无法证明「不合法组合没进候选」');
      continue;
    }
    const conflicts = [];
    const kept = arr(legality.kept);
    const poolIds = arr(candidate?.skills?.possible).map((row) => row?.skill_id).filter(isNonEmptyString);
    if (kept.length > FOUR_SKILL_LIMIT) conflicts.push(`超过四技能上限（${kept.length}）`);
    if (new Set(kept).size !== kept.length) conflicts.push('kept 里有重复技能');
    if (poolIds.length > 0 && kept.some((id) => !poolIds.includes(id))) conflicts.push('kept 里有不在可学池里的技能');
    const proposed = arr(legality.proposed);
    if (proposed.length > 0 && poolIds.length > 0) {
      const recheck = legalSkillLoadout({pool: poolIds, proposed});
      if (stableJson(recheck.kept) !== stableJson(kept)) {
        conflicts.push('legality.kept 与独立复算不一致（可复算性失败）');
      }
      if (recheck.ok !== legality.ok) conflicts.push('legality.ok 与独立复算不一致');
      if (kept.some((id) => !recheck.kept.includes(id))) conflicts.push('不合法组合混进了 kept');
    }
    if (conflicts.length > 0) {
      push('ILLEGAL_LOADOUT_IN_CANDIDATES', where,
        `${conflicts.join(' / ')}：已知不合法的技能组合不得进入候选`);
    }
  }

  // ── 03.4：情景集合 / 范围的**语义声明**与**降级如实** ──
  const outlook = result?.outlook ?? null;
  if (isPlainObject(outlook)) {
    const declarations = outlook.declarations;
    if (!isPlainObject(declarations) || declarations.is_probability !== false) {
      push('SCENARIO_SEMANTICS_NOT_DECLARED', 'outlook.declarations',
        '情景集合/范围必须显式声明 is_probability:false（没有频次数据时不许把它读成概率预测）');
    }
    if (isPlainObject(declarations)) {
      for (const key of ['uniform', 'conditioned', 'scenario_set', 'range']) {
        const one = declarations.expressions?.[key];
        if (!isPlainObject(one) || one.is_probability !== false || !isNonEmptyString(one.why)) {
          push('SCENARIO_SEMANTICS_NOT_DECLARED', `outlook.declarations.expressions.${key}`,
            `表达「${key}」缺语义声明（is_probability:false + 为什么它是基线/区间而不是概率）`);
        }
      }
      if (!isNonEmptyString(declarations.not_a_prediction)) {
        push('SCENARIO_SEMANTICS_NOT_DECLARED', 'outlook.declarations.not_a_prediction',
          '缺「这不是预测 / 不是最优结论」这一句');
      }
    }
    if (outlook.available === true) {
      for (const scenario of arr(outlook.scenarios)) {
        const range = scenario?.range;
        if (!isPlainObject(range) || range.is_probability === true
          || !isNonEmptyString(range.unit) || !isPlainObject(range.semantics)) {
          push('SCENARIO_SEMANTICS_NOT_DECLARED', `outlook.scenarios.${scenario?.scenario_id ?? '?'}.range`,
            '情景的权重区间必须带 unit + semantics（闭区间，不是概率/把握度）');
        }
      }
      if ('best_scenario' in outlook && outlook.best_scenario !== null) {
        push('SCENARIO_RANKS_A_SCENARIO', 'outlook.best_scenario',
          `没有频次数据时不许给「最优情景」，实际 ${stableJson(outlook.best_scenario)}`);
      }
      // 频次不可用时不许出现任何像概率的数值字段
      if (outlook.frequency?.available === false) {
        for (const key of ['probability', 'posterior', 'confidence_score', 'best_guess']) {
          if (key in outlook) {
            push('SCENARIO_SEMANTICS_NOT_DECLARED', `outlook.${key}`,
              `频次不可用时不许出现 ${key} 这类数值结论`);
          }
        }
      }
    }
    if (outlook.degraded === true && arr(outlook.degrade_reasons).length === 0) {
      push('OUTLOOK_DEGRADED_WITHOUT_REASON', 'outlook.degrade_reasons',
        'degraded:true 却没说清降级原因：降级必须点名（空候选 / 矛盾证据 / 预算裁剪）');
    }
    if (outlook.degraded === true && arr(outlook.scenarios).some((row) => row?.complete !== false)) {
      push('OUTLOOK_DEGRADED_WITHOUT_REASON', 'outlook.scenarios',
        '降级时每个情景都必须标 complete:false（不许把不完整的情景当完整的给人）');
    }
    if (outlook.available === false && (arr(outlook.scenarios).length > 0 || outlook.ranges?.weight)) {
      push('OUTLOOK_DEGRADED_WITHOUT_REASON', 'outlook',
        'available:false 却带着情景或区间：算不出来就什么都不给，不许拿空数据冒充');
    }
  }

  // ── 03.5：截断信息必须齐全；被裁掉的重大威胁必须点名 ──
  const budget = result?.budget ?? null;
  if (isPlainObject(budget) && budget.truncated === true) {
    const truncation = budget.truncation;
    const required = ['total_available', 'limit', 'kept', 'dropped', 'rule', 'dropped_by_band',
      'dropped_by_threat', 'dropped_threats'];
    const missing = required.filter((key) => !(key in (truncation ?? {})));
    if (!isPlainObject(truncation) || missing.length > 0) {
      push('TRUNCATION_INFO_MISSING', 'budget.truncation',
        `截断了 ${stableJson(budget.dropped_count)} 条却没有完整的截断信息（缺 ${missing.join(' / ')}）：`
        + '总数 / 保留数 / 被截断数与分布 / 截断依据都要在产出里');
    } else {
      if (truncation.dropped !== budget.dropped_count || truncation.kept !== budget.kept) {
        push('TRUNCATION_INFO_MISSING', 'budget.truncation',
          `截断信息与 budget 不一致（kept ${truncation.kept} vs ${budget.kept}、`
          + `dropped ${truncation.dropped} vs ${budget.dropped_count}）`);
      }
      if (truncation.dropped_by_threat?.high > 0 && arr(truncation.dropped_threats).length === 0) {
        push('THREAT_HIDDEN_BY_TRUNCATION', 'budget.truncation.dropped_threats',
          `有 ${truncation.dropped_by_threat.high} 条**重大威胁**被裁掉却没有点名：`
          + '缩减可以裁，但不许隐去重大威胁（逐条写 candidate_id / threat_level / why / evidence_ids）');
      }
      for (const row of arr(truncation.dropped_threats)) {
        if (!isNonEmptyString(row?.candidate_id) || !isNonEmptyString(row?.why)
          || arr(row?.evidence_ids).length === 0) {
          push('THREAT_HIDDEN_BY_TRUNCATION', `budget.truncation.dropped_threats.${row?.candidate_id ?? '?'}`,
            '点名的重大威胁必须带 why 与 evidence_ids（没有依据的「点名」等于没点）');
        }
      }
    }
  }
  if (isPlainObject(budget) && budget.kept !== arr(result?.candidates).length) {
    push('TRUNCATION_INFO_MISSING', 'budget.kept',
      `budget.kept ${stableJson(budget.kept)} 与候选数 ${arr(result?.candidates).length} 不一致`);
  }

  return {ok: problems.length === 0, problems};
}

// ─────────────────────────────────────────────────────────────────────────
// 产出：机器可读报告
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// 离线段：报告生成 / 读盘 / 对照样例（在线路径不许调用这里的任何入口）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 离线段从此开始（审计的分界线）。
 *
 * ⚠ 2026-09-30（F-03-1）：这个常量原先放在 `beliefReport()` **之后** —— 而 `beliefReport`
 * 在 `OFFLINE_ENTRYPOINTS` 里，于是「以离线段标记为界」的在线段会把它的定义也扫进去，
 * 触发 `OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION`（假红）。所以边界必须落在**离线入口之前**。
 */
export const OFFLINE_SECTION_MARKER = '<!-- OFFLINE-SECTION-BEGIN -->';

/**
 * 三条基线的机器可读产物。
 *
 * 纯函数：同一份输入两次调用逐字节相同（没有挂钟字段、没有随机数）。
 *
 * @param {object} input
 * @param {object} input.catalog          候选宇宙（RC-303 索引或朴素数据）
 * @param {object} input.publicFacts      公开事实
 * @param {object} [input.frequencyData]  注入的频次数据（没有 ⇒ fail closed）
 * @param {object} [input.frequencyRejected] 被拒绝的频次输入的**原始文本**（报告里要贴出来）
 * @param {Array}  [input.red_proofs]     必红方向的**实际输出原文**（由测试收集）
 * @param {string} [input.generated_by]   生成者（默认本模块 + 测试）
 * @param {Array}  [input.input_sources]  输入来源清单
 */
export function beliefReport(input = {}) {
  const {
    catalog = null, publicFacts = null, frequencyData = null, frequencyRejected = null,
    source = null, skillPool = null, candidateBudget = null,
    red_proofs = [], generated_by = 'src/coach/opponent-belief.mjs 的 beliefReport()，'
      + '由 tests/roco-opponent-belief.test.js 复跑比对',
    input_sources = [],
  } = input ?? {};

  const uniform = uniformBelief({catalog});
  const conditioned = revealedConditioned({catalog, publicFacts});
  const frequency = frequencyBelief({frequencyData});
  const beliefs = [uniform, conditioned, frequency];
  const candidateSample = isPlainObject(skillPool)
    ? buildOpponentCandidates({catalog, publicFacts, skillPool, budget: candidateBudget}) : null;
  // 03.4：情景集合与范围的样本（同样只在注入技能池时生成，保持报告体积可控）
  const outlookSample = isPlainObject(skillPool)
    ? buildScenarioOutlook({catalog, publicFacts, skillPool}) : null;
  // F-03-1：在线段的**覆盖读数**（判据「在线段干净」必须同时证明「真的扫到了在线函数」）。
  const onlineCoverage = typeof input.source === 'string' ? onlineSectionCoverage(input.source) : null;

  const universe = buildCandidateUniverse(catalog);
  const second = [uniformBelief({catalog}), revealedConditioned({catalog, publicFacts}),
    frequencyBelief({frequencyData})];
  const text = renderBeliefText(beliefs);
  const secondText = renderBeliefText(second);
  const audit = auditOpponentBelief({beliefs}, {
    source,
    snapshot: {beliefs: second, text: secondText},
    text,
  });

  const criteria = [
    {
      label: '均匀基线的分母来自数据（改数据 ⇒ 分母与 1/N 跟着变）',
      criteria: STRUCTURAL_CRITERIA.denominator_from_data,
      actual: `universe_size=${uniform.universe_size}、expected=1/${uniform.universe_size}、`
        + `available=${uniform.available}`,
      ok: uniform.available === true && uniform.expected_per_candidate?.denominator === universe.size,
    },
    {
      label: '均匀基线同时声明「无信息基线，不是强度判断」',
      criteria: STRUCTURAL_CRITERIA.non_informative_declared,
      actual: `${uniform.declared_semantics?.slice(0, 80)}…（red_lines ${arr(uniform.red_lines).length} 条）`,
      ok: /无信息基线/u.test(String(uniform.declared_semantics ?? ''))
        && /不是/u.test(String(uniform.declared_semantics ?? '')),
    },
    {
      label: '公开事实越界（隐藏字段）必须拒绝整个输入',
      criteria: STRUCTURAL_CRITERIA.public_facts_only,
      actual: conditioned.available === false && arr(conditioned.leaked_fields).length > 0
        ? `available=false、leaked=${conditioned.leaked_fields.map((row) => row.path).join(' / ')}`
        : (conditioned.available === true
          ? `available=true、applied=${arr(conditioned.rule_ledger).filter((row) => row.applied).length} 条规则`
          : `available=false、unknown_reason=${conditioned.unknown_reason?.slice(0, 60)}…`),
      ok: conditioned.available === false || arr(conditioned.leaked_fields).length === 0,
    },
    {
      label: '公开事实条件化的每条规则都可复算（输入 → 输出 → 依据）',
      criteria: STRUCTURAL_CRITERIA.rules_recomputable,
      actual: arr(conditioned.rule_ledger).map((row) => `${row.id}: applied=${row.applied} `
        + `matched=${row.output?.matched ?? row.output?.stratum_size ?? 'null'}`),
      ok: arr(conditioned.rule_ledger).every((row) => isNonEmptyString(row.basis)
        && Array.isArray(row.reads) && (row.applied ? isPlainObject(row.output) : isNonEmptyString(row.reason))),
    },
    {
      label: '「已亮明」必带来源事件、速度必带物种级出处（缺来源即拒绝）',
      criteria: STRUCTURAL_CRITERIA.provenance_required,
      actual: conditioned.available === false
        ? `available=false、reason=${String(conditioned.unknown_reason ?? '').slice(0, 60)}…、`
          + `leaked=${arr(conditioned.leaked_fields).map((row) => `${row.code}:${row.path}`).join(' / ') || '（无）'}`
        : `available=true、provenance=${stableJson(conditioned.provenance)}、`
          + `已亮明 ${arr(conditioned.public_facts?.revealed_pets).length} 只（各带 revealed_via / spe_source）`,
      ok: conditioned.available === true
        ? arr(conditioned.leaked_fields).length === 0 && isPlainObject(conditioned.provenance)
        : arr(conditioned.leaked_fields).some((row) => ['NO_PROVENANCE', 'INDIVIDUAL_FACTS'].includes(row.code))
          || arr(conditioned.leaked_fields).length > 0,
    },
    {
      label: '假设不许把候选压 0；权重必须声明它是基线还是假设',
      criteria: STRUCTURAL_CRITERIA.no_assumption_zeroing,
      actual: conditioned.available === true
        ? `basis=${conditioned.weights?.basis}、zero_rows=${arr(conditioned.weights?.rows)
          .filter((row) => row.numerator === 0).length}、ratio=${stableJson(conditioned.weights?.weight_ratio)}`
        : `available=false（${String(conditioned.unknown_reason ?? '').slice(0, 40)}…）`,
      ok: conditioned.available !== true
        || (['uniform_over_pool_baseline', 'own_speed_tier_downweight'].includes(conditioned.weights?.basis)
          && conditioned.weights?.is_probability === false
          && arr(conditioned.weights?.rows).every((row) => Number.isInteger(row.numerator) && row.numerator > 0)),
    },
    {
      label: '候选不许带已知不合法的技能组合（独立复算 legality）',
      criteria: STRUCTURAL_CRITERIA.no_illegal_loadouts,
      actual: candidateSample === null
        ? '（本次报告没有注入技能池：候选协议只声明、不生成样本）'
        : `候选 ${candidateSample.candidates.length} 条、` + `不合法组合 ${candidateSample.candidates
          .filter((row) => row.skills.legality.ok === false).length} 条（都不进 kept）`,
      ok: candidateSample === null
        || auditOpponentBelief({beliefs, candidates: candidateSample.candidates}).problems
          .every((problem) => problem.code !== 'ILLEGAL_LOADOUT_IN_CANDIDATES'),
    },

    {
      label: '没有频率数据时三种表达都声明「不是概率」，且降级如实（03.4）',
      criteria: STRUCTURAL_CRITERIA.no_probability_without_frequency,
      actual: outlookSample === null ? '（本次报告没有注入技能池：情景集合只声明、不生成样本）' : {
        available: outlookSample.available,
        degraded: outlookSample.degraded,
        degrade_reasons: outlookSample.degrade_reasons,
        is_probability: outlookSample.declarations.is_probability,
        best_scenario: outlookSample.best_scenario,
        scenarios: outlookSample.scenarios.length,
      },
      ok: outlookSample === null || (outlookSample.declarations.is_probability === false
        && outlookSample.best_scenario === null
        && arr(outlookSample.scenarios).every((row) => row.range === null || isPlainObject(row.range.semantics))
        && (outlookSample.degraded === false || arr(outlookSample.degrade_reasons).length > 0)),
    },
    {
      label: '频次信念必须有真实来源；没有来源一律拒绝（不用均匀冒充）',
      criteria: STRUCTURAL_CRITERIA.frequency_needs_real_source,
      actual: frequency.available === true
        ? `available=true、declared_source=${frequency.declared_source}、样本量=${frequency.total_count}`
        : `available=false、reason_code=${frequencyReasonCode(frequency)}`,
      ok: frequency.available === false || (frequency.kind === 'measured_frequency'
        && isNonEmptyString(frequency.declared_source)),
    },
    {
      label: '产出与渲染文本里零伪精确（键名与量纲一起扫）',
      criteria: STRUCTURAL_CRITERIA.no_pseudo_precision,
      actual: audit.problems.map(formatAuditProblem),
      ok: audit.ok,
    },
    {
      label: '在线段没有引擎 / 子进程调用，**而且判据真的覆盖到在线入口**（F-03-1）',
      criteria: STRUCTURAL_CRITERIA.online_no_engine,
      actual: onlineCoverage === null ? '未注入源码' : {
        online_lines: onlineCoverage.online_lines,
        scanned_online_entrypoints: onlineCoverage.scanned_online_entrypoints.length,
        missing_online_entrypoints: onlineCoverage.missing_online_entrypoints,
        hits: onlineCoverage.hits,
      },
      ok: onlineCoverage !== null && onlineCoverage.hits.length === 0
        && onlineCoverage.missing_online_entrypoints.length === 0 && onlineCoverage.online_lines > 0,
    },
    {
      label: '同一份输入两次运行逐字节相同（含 tie-break）',
      criteria: STRUCTURAL_CRITERIA.deterministic,
      actual: `identical=${stableJson(beliefs) === stableJson(second) && text === secondText}`,
      ok: stableJson(beliefs) === stableJson(second) && text === secondText,
    },
  ];

  return {
    report_version: RC604_REPORT_VERSION,
    rc: 'RC-604',
    title: '对手信念基线：uniform / 公开事实条件化 / frequency（缺数据就 fail closed，绝不用均匀冒充）',
    generated_by,
    generated_from: [
      'src/coach/opponent-belief.mjs（beliefReport()）',
      'tests/roco-opponent-belief.test.js（复跑比对磁盘字节）',
    ],
    input_sources: arr(input_sources).length > 0 ? arr(input_sources) : [
      'data/roco/game-data-pack/v2/pack.json#sections.distributable.entities[group=pet]（图鉴物种：属性 / 指针）',
      'data/roco/owned/owned-pets.json#instances（箱子实例；数量从数据现数 —— 本模块不写死 48 / 542）',
      'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json（速度 stats.spe）',
      'data/roco/normalized/roco-world-s4-2026-09-10/types.json（属性相性表：唯一实现在 RC-302/303 的 buildGapIndex()）',
      'data/roco/meta-prior/v1.json#distribution[]（版本先验：全部 source=assumption + 均匀假设 ⇒ 没有频次可用）',
      'roco/src/roco_env/env.py#_bench_public_row() + #foe_field_pet()（公开性口径**实测**：'
      + '未亮明的后备只有 {slot, fainted}；场上那只的 hp/max_hp/energy/statuses/marks 公开）',
      'reports/roco/product-execution/03/raw-03.1-engine-public-keys.txt + raw-03.1-engine-bench-keys.txt'
      + '（真引擎三公开面 dump：键路径与「speed / speed_band 零命中」的原始读数）',
    ],
    public_fact_boundary: {
      allowed: PUBLIC_FACT_FIELDS,
      hidden: HIDDEN_FACT_FIELDS,
      // 口径不是抄来的：三面 dump 见 input_sources 最后两条。
      species_level_sources: SPECIES_STAT_SOURCES,
      own_speed_sources: OWN_SPEED_SOURCES,
      reveal_sources: REVEAL_SOURCES,
      policy: '隐藏字段出现 / 「已亮明」缺来源事件 / 速度带个体口径出处 ⇒ **拒绝整个输入**'
        + '（available:false + 逐条点名 code:path），不静默过滤：过滤会让泄漏查不出来。',
      source: 'roco/src/roco_env/env.py#_bench_public_row()（未亮明 ⇒ {slot, fainted}，**没有 pet_id**）'
        + ' + #foe_field_pet()（场上那只是公开面板）；`speed` / `speed_band` 三面零命中（工程现算，不是游戏字段）',
    },
    provenance: {
      ...conditioned.provenance,
      policy: '01.2 观察契约三件套（match_id / rules_version / decision_id）**原样转发**：'
        + '缺就是 null 并在 unverified 里点名，本模块不自己派生一个「看起来像」的版本号。',
    },
    universe: {
      size: universe.size,
      members_with_types: universe.members_with_types,
      members_with_speed: universe.members_with_speed,
      ignored_catalog_keys: universe.ignored_catalog_keys,
      note: '分母从注入数据现数（按物种去重）；本仓实测 622（pack 622 ∪ owned 48，owned 全部落在 pack 内）。'
        + '这个数字**不是**写死的常量：换一份 catalog，判据要求分母跟着变（见 criteria[0]）。',
    },
    rules: RULES.map((rule) => ({...rule})),
    beliefs,
    availability: {
      available: beliefs.filter((belief) => belief.available).map((belief) => belief.belief),
      unknown: beliefs.filter((belief) => !belief.available).map((belief) => belief.belief),
      note: '预计：uniform 与 revealed_conditioned 可用（只吃公开数据），frequency 恒 unknown'
        + '（仓库没有真实对局频次数据，这是 fail closed 而不是「永远 unknown」：注入带来源的频次后它会亮）。',
    },
    unknown_reasons: beliefs.filter((belief) => !belief.available).map((belief) => ({
      belief: belief.belief,
      reason_code: frequencyReasonCode(belief),
      unknown_reason: belief.unknown_reason,
      missing: arr(belief.missing),
    })),
    frequency_input_audit: {
      injected: frequencyData !== null,
      rejected: frequencyRejected === null ? null : obscureBannedWords(
        typeof frequencyRejected === 'string' ? frequencyRejected : stableJson(frequencyRejected)),
      note: '喂进来的频次数据如果没有来源声明，报告里贴的是**被拒绝的那份输入**（含拒绝理由），'
        + '而不是把均匀分布当成它的替身。',
    },
    measured_control: buildMeasuredControl(),
    // 候选协议（03.2）的**机器可读**声明：03 / 04 / 06 都按这一份解析，避免下游各自解释字段。
    candidate_protocol: {
      version: 'rc604-opponent-candidates/v1',
      fields: ['candidate_id', 'species_id', 'name', 'basis', 'types', 'spe', 'spe_source', 'spe_status',
        'speed_band', 'band_source', 'in_filtered_pool', 'inferred_rank', 'observed', 'skills',
        'individual_range', 'actions', 'sources', 'unknowns', 'rules_version', 'evidence'],
      bases: CANDIDATE_BASES,
      grades: SKILL_POOL_GRADES,
      grade_legend: 'FULL_VERIFIED（冻结学招表 learnsets.json + layer-playable-48 覆盖）'
        + ' > SIMULATABLE_UNVERIFIED（on-demand-builds 的工程启发式，**未实机核验**）'
        + ' > UNKNOWN（没有池，可学技能不知道）—— 未验证的不与已验证的同权呈现',
      four_skill_limit: FOUR_SKILL_LIMIT,
      default_budget: DEFAULT_CANDIDATE_BUDGET,
      degrade_policy: '输入越界 / 缺来源 ⇒ available:false 且**一个候选都不生成**（不拿空数组冒充「没有威胁」）；'
        + '候选为空或与观察矛盾 ⇒ 明确降级并逐条写 `contradictions[]`（不静默丢）',
    },
    candidate_sample: candidateSample === null ? null : {
      ...candidateSample,
      candidates: candidateSample.candidates.slice(0, 2).map((row) => ({
        ...row,
        skills: {...row.skills, possible: row.skills.possible.slice(0, 6),
          possible_omitted: Math.max(0, row.skills.possible.length - 6),
          possible_omitted_note: '报告里只贴前 6 条可学技能（省体积）；完整池在 buildOpponentCandidates() 的返回值里'},
        evidence: row.evidence.slice(0, 4),
      })),
      sample_note: `报告只贴前 ${Math.min(2, candidateSample.candidates.length)} 条候选`
        + `（共 ${candidateSample.candidates.length} 条）：完整候选集合由 buildOpponentCandidates() 返回，`
        + '报告不复制整份（否则 24 × 45 条技能会把报告变成噪声）',
    },
    outlook_protocol: {
      version: OUTLOOK_PROTOCOL,
      expressions: EXPRESSION_SEMANTICS,
      range_unit: RANGE_UNIT,
      degrade_policy: '空候选 / 输入越界 / 证据矛盾 / 预算裁剪 ⇒ degraded:true + degrade_reasons[]，'
        + '每个情景标 complete:false，**不给**最优情景（best_scenario:null）',
      audit_codes: ['SCENARIO_SEMANTICS_NOT_DECLARED', 'SCENARIO_RANKS_A_SCENARIO',
        'OUTLOOK_DEGRADED_WITHOUT_REASON'],
    },
    outlook_sample: outlookSample === null ? null : {
      ...outlookSample,
      evidence: arr(outlookSample.evidence).slice(0, 3),
      unverified: arr(outlookSample.unverified).slice(0, 3),
    },
    criteria,
    red_proofs: arr(red_proofs).map((row) => ({
      where: row?.where ?? null,
      mutation: obscureBannedWords(row?.mutation ?? null),
      criterion: row?.criterion ?? null,
      expect_code: row?.expect_code ?? null,
      actual: obscureBannedWords(typeof row?.actual === 'string' ? row.actual : stableJson(row?.actual ?? null)),
    })),
    audit: {
      ok: audit.ok,
      problems: audit.problems.map(formatAuditProblem),
      scanned_scope: 'online',
    },
    does_not_do: [
      '不产出胜率 / 概率 / 百分数 / 强度分 / 榜单名次：本模块的权重是信念权重与计数比',
      '不偷看：对手配招 / 道具 / 天赋性格 / 个体面板 / 后备身份与血量不进输入（传进来即拒绝）',
      '不吃没来源的「已亮明」：`revealed_via` + `revealed_turn` 缺一个就拒绝整个输入（那可能是私有 state 直读）',
      '不用假设排除候选：只有公开证据（已出技能 / 先手关系 / 可见伤害）能排除且要写证据 ID；'
      + '我方速度层次只降权（2 : 1），权重一个都不为 0',
      '不用均匀分布冒充频次：没有真实对局数据就 available:false + 点名缺什么',
      '不在线跑模拟 / 不调引擎 / 不起子进程：信念只读注入的公开数据（结构判据扫源码）',
      '不训练、不假装有学出来的模型：小型 learned model 属于后续 RC（不在本轮）',
    ],
  };
}

/** 频次信念的**原因代码**：报告里用短码，人读时再展开成完整 unknown_reason。 */
export function frequencyReasonCode(belief) {
  const reason = String(belief?.unknown_reason ?? '');
  if (reason.length === 0) return null;
  for (const [code, text] of Object.entries(FAIL_CLOSED_REASONS)) {
    if (reason === text) return code;
  }
  if (reason.includes('来源声明')) return 'FREQUENCY_NO_DECLARED_SOURCE';
  if (reason.includes('来源真实性') || reason.includes('url / 仓内文件 + 日期')) return 'FREQUENCY_NO_MEASURED_SOURCE';
  if (reason.includes('频次行') || reason.includes('frequency[]')) return 'FREQUENCY_ROWS_UNUSABLE';
  return 'UNCLASSIFIED';
}

// ─────────────────────────────────────────────────────────────────────────
// 离线段（续）：读盘 / 对照样例
// ─────────────────────────────────────────────────────────────────────────

/**
 * 离线：读盘加载 RC-303 的候选索引输入，并现建一份 `buildCandidateIndex()`。
 * **在线路径不许调用**（`OFFLINE_ENTRYPOINTS` 钉住这一点）。
 *
 * 为什么不在这里自己读 pack.json：候选宇宙、属性相性表、速度档都只能有一份实现
 * （RC-302/303），本模块只消费它的产物。
 */
export async function loadOpponentBeliefInputs({root = null, cache = true} = {}) {
  const {buildCandidateIndex, loadTeamCandidatesInputs} = await import('./team-candidates.mjs');
  const inputs = await loadTeamCandidatesInputs({root, cache});
  return {inputs, index: buildCandidateIndex(inputs)};
}

/**
 * 构造一份**带来源**的频次对照样例：证明「有来源时接口会亮」，同时**不冒充**已测数据。
 *
 * 每一行的 `sources[].measured = false` 会写进来源里，报告也明确写「这是接线的对照样例」。
 * 真实频次只能来自实机统计 / 用户提供的对局记录（见 `FAIL_CLOSED_REASONS`）。
 */
export function buildMeasuredFrequencySample({rows = [], note = null} = {}) {
  return {
    declared_source: 'measured',
    frequency: arr(rows).map((row, index) => ({
      species_id: row.species_id ?? `sample_species_${index}`,
      count: Number.isInteger(row.count) ? row.count : null,
      scope: row.scope ?? 'rc604-control-sample',
      revision: row.revision ?? 'rc604-control-sample#constructed',
      sources: [{
        ref: row.ref ?? 'injected:rc604-control-sample',
        date: row.date ?? '2026-09-21',
        // `measured: false` 是**接线对照样例**的机器可读标记：
        // 它满足「有来源」的结构要求（所以通路会亮），但任何把它读成实机统计的做法都越界。
        measured: false,
        note: note ?? '**对照样例**（constructed sample）：它不是版本数据，只用来证明「有来源时接口是活的」',
      }],
    })),
    note: note ?? '**RC-604 的接线对照样例**：源数据是构造的（每行的 sources[].measured = false），'
      + '只用于验证 fail closed 不是「永远 unknown」。任何把它当版本频次数据的做法都越过了它的边界。',
  };
}

/** 本模块的离线段到此结束（在线 / 离线的显式标记见文件上方两处 `*_SECTION_MARKER`）。 */
export const MODULE_PATH = fileURLToPath(import.meta.url);

/**
 * 报告里的**接线对照**：一份带来源的**构造**样例 → 跑 `frequencyBelief()`。
 *
 * 为什么要它：`frequencyBelief()` 默认永远 `available:false`（仓库没有真实对局数据），
 * 但「永远 unknown」和「fail closed」在产物里长得一样。这份对照证明通路是活的：
 * 有来源时它会亮（`available:true` + `kind: measured_frequency`）。
 *
 * **它不是版本数据**：每行的 `sources[].measured = false`，`revision` 里写着 `constructed`，
 * 报告正文也照写一遍。任何把它当环境频次的用法都越过了它的边界。
 */
export function buildMeasuredControl() {
  const sample = buildMeasuredFrequencySample({
    rows: [
      {species_id: 'pet_000001', count: 12},
      {species_id: 'pet_000062', count: 7},
    ],
    note: '接线对照样例：证明 frequency 的接口在**有来源**时会亮，而不是恒 unknown。'
      + '每一行的 sources[].measured = false：它是**构造**的，不是测出来的。',
  });
  const belief = frequencyBelief({frequencyData: sample});
  return {
    note: sample.note,
    sample: {declared_source: sample.declared_source,
      rows: sample.frequency.map((row) => ({species_id: row.species_id, count: row.count,
        scope: row.scope, revision: row.revision}))},
    belief: {
      available: belief.available,
      kind: belief.kind,
      total_count: belief.total_count,
      declared_source: belief.declared_source,
      weights: belief.weights,
      // 每行来源的 `measured:false` 必须原样带出来（它是「这是构造样例」的机器可读标记）。
      sources_measured_flags: sample.frequency.map((row) => row.sources.map((source) => source.measured)),
    },
    lights_up: belief.available === true && belief.kind === 'measured_frequency',
  };
}

