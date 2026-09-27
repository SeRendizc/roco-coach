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
//   · **不偷看**：信念只吃公开信息（对手场上/已亮明的那只、我方阵容、模式规模、版本先验）。
//     对手后备、配招、道具、体力数值、性格/天赋都不在公开面里 —— 传进来就是**拒绝**，
//     而不是静默过滤（静默过滤会让泄漏在报告里查不出来）。公开性口径与引擎
//     `roco/src/roco_env/env.py::public_planner_state` 逐条对齐（对手后备只有位次 / id / 是否倒下）。
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

/**
 * 在线段到此结束（审计扫的是它**之前**的正文）。
 *
 * 为什么边界常量写在最前面：下面每一次 `//` 注释里的「在线路径不…」都只是注释，
 * 判据必须落在**源码结构**上 —— 审计把这一段源码取出来逐行做禁止模式的子串匹配。
 */
export const ONLINE_SECTION_MARKER = '<!-- ONLINE-SECTION-END -->';

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
  opponent_active: Object.freeze(['species_id', 'types', 'speed', 'speed_band', 'source']),
  opponent_revealed: Object.freeze(['species_id', 'types', 'speed', 'speed_band', 'source',
    'revealed_as', 'revealed_turn', 'fainted']),
  own_team: Object.freeze(['key', 'species_id', 'types', 'speed', 'speed_band', 'source', 'slot']),
  mode: Object.freeze(['team_size', 'battle_mode', 'ruleset_config_id']),
});

/**
 * 明确的**隐藏字段**清单（出现即拒绝）。
 *
 * 列出来的理由：拒绝时能点名「你泄漏的是哪一个」，而不是只说一句「形状不对」。
 * 对手后备只允许「位次 / id / 是否倒下」（术语 3010 的公开部分）；手游里后备直到上场
 * 才亮明，所以名字、血量、配招、道具都不在公开面上。
 */
export const HIDDEN_FACT_FIELDS = Object.freeze({
  opponent: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items', 'nature',
    'talent', 'specialty', 'bloodline', 'hp', 'max_hp', 'energy', 'bench_details',
    'bench_moves', 'stats', 'panel_stats', 'derived_stats', 'build', 'builds']),
  opponent_revealed: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items',
    'nature', 'talent', 'specialty', 'bloodline', 'hp', 'max_hp', 'energy', 'stats',
    'panel_stats', 'derived_stats', 'build', 'builds']),
  own_team: Object.freeze(['moves', 'skills', 'loadout', 'loadouts', 'item', 'items', 'nature',
    'talent', 'specialty', 'bloodline', 'hp', 'max_hp', 'energy', 'stats', 'panel_stats',
    'derived_stats', 'build', 'builds']),
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
    label: '按对手**已亮明**的那只的速度档分层',
    reads: Object.freeze(['opponent_active.speed', 'opponent_revealed.speed']),
    basis: '速度档来自 RC-303 的 `speedBandFor()`（在候选宇宙内按三分位分档），本模块不另立分档。'
      + '应用口径：**只亮明单一档**时才收窄到同档；一条都没亮明、或快慢两端都亮明时都**不应用**'
      + '（两端亮明 ⇒ 速度对「他会出什么」不再有区分度；实测照两端留会把 mid 档 237 只全剔掉）。'
      + '速度值缺失 ⇒ 不应用（记 `not_applied`），池子因此更宽 —— 宽是安全的，窄才是编的。',
  }),
  Object.freeze({
    id: 'weight.own_speed_tier_match',
    kind: 'weight',
    label: '按**我方阵容**已有的速度档给候选加权',
    reads: Object.freeze(['own_team.speed']),
    basis: '这是玩家自己的信息（自家阵容的速度层次），与对手无关；'
      + '用它把候选池按速度档**分层**（同一层的候选等权），权重只有 0 / 1 两种取值，'
      + '不引入任何「哪种速度更好」的强度判断。',
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
    + '（对手配招 / 后备 / 道具 / 体力数值 / 性格天赋 / 构建等）。'
    + '这些不在公开面上（引擎口径见 `roco/src/roco_env/env.py::public_planner_state`：'
    + '对手后备只有位次 / id / 是否倒下），本模块**拒绝**整个输入而不是静默过滤 ——'
    + '静默过滤会让泄漏在报告里查不出来。请只传 `PUBLIC_FACT_FIELDS` 里的字段。',
  REVEALED_EMPTY_POOL: '缺**可用候选**：公开事实把候选池筛空了。'
    + '收窄到空集不是「更精确」，而是「没有可说的」；退回均匀分布同样是编 ——'
    + '空池必须如实报 available:false，并点名是哪几条规则把它筛空的。',
  REVEALED_EMPTY_STRATUM: '缺**非空速度层**：加权规则选中的速度档在候选池里一条都没有。'
    + '权重全 0 的分布没有意义（它不是概率向量），所以 fail closed 而不是把权重原样交出去。',
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
    + '（对手配招 / 后备 / 道具 / 体力数值 / 性格天赋 / 构建）里任何一个键 ⇒ **拒绝整个输入**'
    + '（`available:false` + 点名路径）⇒ `PUBLIC_FACTS_BOUNDARY`（红）。静默忽略也算红：'
    + '「忽略」在产出里看不出来，「拒绝」才看得出来。',
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
  online_no_engine: '把 `src/coach/opponent-belief.mjs` 的在线段（`ONLINE_SECTION_MARKER` 之前）'
    + '逐行取出、剥掉行注释与块注释，再对每行做 `FORBIDDEN_ONLINE_PATTERNS[].pattern` 的子串匹配：'
    + '命中即 `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL`（红）。判据是**源码结构**，不是注释声明。',
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
]);

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
 * 读公开事实。**白名单 + 越界即拒绝**。
 *
 * 拒绝（而不是忽略）的理由：忽略在产出里看不出来（池子只是小了一点），
 * 拒绝会在 `available:false` + `unknown_reason` 里逐条点名 —— 泄漏必须可见。
 *
 * @returns {{ok:boolean, leaked:Array<{path:string,field:string,why:string}>, ignored:Array<string>,
 *   facts:object, evidence:Array<object>}}
 */
export function readPublicFacts(publicFacts) {
  const leaked = [];
  const ignored = [];
  const facts = isPlainObject(publicFacts) ? publicFacts : {};

  for (const key of sortedKeys(facts)) {
    if (HIDDEN_FACT_FIELDS.root.includes(key)) {
      leaked.push({path: key, field: key, why: '顶层隐藏字段（对手的完整队伍 / 后备 / 配招）'});
    }
  }
  const check = (path, rows, allowFields, hiddenFields, hiddenWhy) => {
    arr(rows).forEach((row, index) => {
      if (!isPlainObject(row)) return;
      for (const key of sortedKeys(row)) {
        const at = `${path}[${index}].${key}`;
        if (hiddenFields.includes(key)) {
          leaked.push({path: at, field: key, why: hiddenWhy});
        } else if (!allowFields.includes(key)) {
          // 白名单外的**未知**字段：既不进信念，也不当作泄漏 —— 但必须记账（不静默丢弃）。
          ignored.push(at);
        }
      }
    });
  };
  const opponent = isPlainObject(facts.opponent) ? facts.opponent : {};
  check('opponent.revealed_pets', opponent.revealed_pets, PUBLIC_FACT_FIELDS.opponent_revealed,
    HIDDEN_FACT_FIELDS.opponent_revealed, '对手**未亮明**的信息（手游里后备直到上场才亮明）');
  const activeRow = isPlainObject(opponent.active) ? [opponent.active] : [];
  check('opponent.active', activeRow, PUBLIC_FACT_FIELDS.opponent_active,
    HIDDEN_FACT_FIELDS.opponent, '对手场上的配招 / 道具 / 体力数值不在公开面里（只有名字、属性、血量条）');
  check('own_team.pets', facts.own_team?.pets, PUBLIC_FACT_FIELDS.own_team,
    HIDDEN_FACT_FIELDS.own_team, '我方配招虽然是我方信息，但信念的输入面只收阵容级公开事实（属性 / 速度档）');

  // 已亮明的那只：`opponent.active` 与 `opponent.revealed_pets[]` 合并去重（同一只可能两处都有）。
  const revealed = [];
  const seen = new Set();
  const pushRevealed = (row, where) => {
    if (!isPlainObject(row)) return;
    const speciesId = row.species_id ?? null;
    if (!isNonEmptyString(speciesId) || seen.has(speciesId)) return;
    seen.add(speciesId);
    revealed.push({
      species_id: speciesId,
      types: arr(row.types).length ? [...row.types] : null,
      speed: Number.isFinite(row.speed) ? Number(row.speed) : null,
      speed_band: isNonEmptyString(row.speed_band) ? row.speed_band : null,
      source: isNonEmptyString(row.source) ? row.source : where,
    });
  };
  pushRevealed(opponent.active, 'injected:publicFacts.opponent.active');
  arr(opponent.revealed_pets).forEach((row) => pushRevealed(row, 'injected:publicFacts.opponent.revealed_pets[]'));

  const ownTeam = arr(facts.own_team?.pets).map((row, index) => ({
    key: isNonEmptyString(row?.key) ? row.key : (isNonEmptyString(row?.species_id) ? row.species_id : `own[${index}]`),
    species_id: row?.species_id ?? null,
    types: arr(row?.types).length ? [...row.types] : null,
    speed: Number.isFinite(row?.speed) ? Number(row.speed) : null,
    speed_band: isNonEmptyString(row?.speed_band) ? row.speed_band : null,
  }));

  const mode = {
    team_size: Number.isInteger(facts.mode?.team_size) ? facts.mode.team_size : null,
    battle_mode: isNonEmptyString(facts.mode?.battle_mode) ? facts.mode.battle_mode : null,
    ruleset_config_id: isNonEmptyString(facts.mode?.ruleset_config_id) ? facts.mode.ruleset_config_id : null,
  };

  return {
    ok: leaked.length === 0,
    leaked,
    ignored,
    facts: {revealed_pets: revealed, own_team: ownTeam, mode},
    evidence: [
      evidence('injected:publicFacts', 'publicFacts.opponent', 'revealed_pets', revealed.map((row) => row.species_id),
        '对手**已亮明**的精灵（场上那只 + 已换上来过的）：只有位次性的事实 —— 属性、速度档，没有配招 / 道具 / 后备详情'),
      evidence('injected:publicFacts', 'publicFacts.own_team.pets', 'own_team_size', ownTeam.length,
        '我方阵容（自己的信息）：信念用它做速度档分层，不用它推断对手'),
      evidence('injected:publicFacts', 'publicFacts.mode', 'team_size', mode.team_size,
        '模式规模（公开规则常量）：六宠口径来自调用方，不在本模块写死'),
      evidence('injected:publicFacts', 'publicFacts', 'ignored_public_keys', ignored,
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

  // ① 越界优先：隐藏字段一旦出现，**整个输入被拒绝**（不是忽略）。
  if (!read.ok) {
    return {
      ...base,
      available: false,
      informativeness: null,
      unknown_reason: FAIL_CLOSED_REASONS.REVEALED_LEAKED_HIDDEN_FACTS,
      leaked_fields: read.leaked,
      missing: read.leaked.map((row) => row.path),
      evidence: [...universe.evidence, ...read.evidence,
        evidence('injected:publicFacts', 'publicFacts', 'leaked_hidden_fields', read.leaked.map((row) => row.path),
          '越界的隐藏字段：拒绝整个输入，而不是静默过滤（过滤会让泄漏在报告里查不出来）')],
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

  const rules = applyRules(universe, read.facts);
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
  if (rules.stratum_size === 0) {
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

  const rows = rules.pool.map((row) => weightRow(row.key,
    row.stratum_weight === 1 ? exact(1, rules.stratum_size) : exact(0, 1), WEIGHT_UNIT,
    row.stratum_weight === 1 ? `落在速度层 ${rules.stratum} 内` : '不在选中的速度层内（权重 0，不是「差」的意思）'));
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
      stratum_sum: exact(rules.stratum_size, rules.stratum_size),
      unit: WEIGHT_UNIT,
      candidate_count: rows.length,
      rows,
    },
    leaked_fields: [],
    declared_semantics: '这些权重只由**已公开**的事实决定（对手已亮明的那只的系别 / 速度档、我方阵容、模式规模），'
      + '是「筛 + 分层」的计数结果，不是强度排序、不是胜率：'
      + '同一层内的候选**完全等权**，本模块不区分它们的强弱。',
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
    ],
    confidence: 'ENGINE_HYPOTHESIS',
    unverified: [
      '未核实：候选之间的强弱 —— 条件化只按公开事实筛 / 分层，层内等权，不含强度判断',
      '未核实：对手**后备**要出什么 —— 后备不在公开面里，本模块明确说不知道（这也是 available 的原因不是「我们很确定」）',
      ...rules.unverified,
    ],
  };
}

function revealedRedLines() {
  return [
    '只看公开面：对手**场上 / 已亮明**的那只的属性与速度档、我方阵容、模式规模',
    '不看隐藏面：对手后备、配招、道具、体力数值、性格天赋一律不进输入（传进来即拒绝）',
    '不给强度结论：过滤与分层是计数，不是排序；层内等权',
    '不产出胜率 / 概率 / 百分数：权重合计 1 只是归一化，不是「赢面」',
  ];
}

/**
 * 逐条应用规则。返回 `{pool, ledger, stratum, stratum_size, stratum_rule_id, not_applied_reasons, unverified}`。
 *
 * 规则账本每一条都是**可核对**的：`inputs[]`（读了哪几条公开事实）+ `output`（匹配数 / 层大小）
 * + `basis`（依据）。同一份输入两次调用必须逐字节相同（没有随机、没有遍历顺序依赖）。
 */
export function applyRules(universe, facts) {
  const ledger = [];
  const notApplied = [];
  const unverified = [];
  let pool = universe.members.map((row) => ({...row}));

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

  // ── 规则 2：对手已亮明的那只的速度档 → 同档候选 ──
  //
  // 三种情形（第三种是实测踩出来的）：
  //   · 一条速度档都没亮明 ⇒ **不应用**（缺数据，不自己算档位）；
  //   · 只亮明单一档      ⇒ 收窄到同一档；
  //   · **快慢两端都亮明** ⇒ 也**不应用**：对手快慢都见过，速度这件事对「他会出什么」不再有区分度。
  //     实测：早先的写法在两端亮明时照两端留，把 mid 档 **237 只全剔掉**，
  //     于是自家是 mid 档的队伍拿到空层 → fail closed；反过来硬选一头又会造出一个
  //     看着精确、实际任意的池子。所以这一条在两端亮明时不应用 —— 池子更宽是安全的，窄才是编的。
  const revealedBands = [...new Set(arr(facts?.revealed_pets)
    .map((row) => row.speed_band)
    .filter(isNonEmptyString))].sort((a, b) => (a < b ? -1 : 1));
  const bothExtremesRevealed = revealedBands.includes('fast') && revealedBands.includes('slow');
  const speedRule = {
    id: 'filter.opponent_speed_tier',
    kind: 'filter',
    reads: [...RULE_BY_ID['filter.opponent_speed_tier'].reads],
    inputs: [{speed_bands: revealedBands, species: arr(facts?.revealed_pets).map((row) => row.species_id),
      applied_when: '恰好亮明单一速度档',
      not_applied_when: '一条都没亮明 / 快慢两端都亮明'}],
    output: {matched: 0, before: pool.length, after: pool.length},
    basis: RULE_BY_ID['filter.opponent_speed_tier'].basis,
    applied: false,
  };
  if (revealedBands.length === 0 || bothExtremesRevealed) {
    speedRule.reason = revealedBands.length === 0
      ? '对手已亮明的那只没有速度档（速度值缺失 ⇒ 不自己算一个档位）：这一条不应用，池子因此更宽'
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
      kept_bands: [...new Set(pool.map((row) => row.speed_band))].filter(isNonEmptyString).sort((a, b) => (a < b ? -1 : 1))};
    speedRule.unverified = ['未核实：速度档本身 —— 档位来自 RC-303 的 speedBandFor()（候选宇宙内三分位），'
      + '是工程分档，不是官方档位表'];
    unverified.push(speedRule.unverified[0]);
  }
  ledger.push(speedRule);

  // ── 规则 3：我方阵容的速度档 → 分层权重（0 / 1） ──
  const ownBands = arr(facts?.own_team).map((row) => row.speed_band).filter(isNonEmptyString);
  const counts = new Map();
  for (const band of ownBands) counts.set(band, (counts.get(band) ?? 0) + 1);
  // 选中层：①自己队里出现最多 **且在池子里真的存在** 的档；并列时 ②按档名定序。
  //
  // 为什么要「且在池子里真的存在」：只按自家阵容投票会选出空层（实测：自家 6 只 → mid 3 / fast 2 / slow 1，
  // 而对手只亮明 slow、池子只剩 slow 146 只 ⇒ 选 mid 就是空层 → 整条信念 fail closed）。
  // 「自家最常见的**可用**层次」才是这一条规则真正想说的话；层内仍然等权，不引入强度判断。
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
    inputs: [{own_team_bands: Object.fromEntries([...counts.entries()].sort()),
      own_team_size: arr(facts?.own_team).length,
      pool_bands: Object.fromEntries([...poolByBand.entries()].sort()),
      usable_bands: usableBands,
      tie_break: ['own_team_band_count desc', 'band_name asc']}],
    output: {stratum, stratum_size: 0, before: pool.length, after: pool.length},
    basis: RULE_BY_ID['weight.own_speed_tier_match'].basis,
    applied: false,
  };
  let stratumSize = 0;
  if (stratum === null) {
    weightRule.reason = '我方阵容里没有一个成员带速度档：没有可用的分层依据'
      + '（速度值缺失就不自己算档位）';
    notApplied.push(weightRule.reason);
    for (const row of pool) row.stratum_weight = 0;
  } else {
    for (const row of pool) row.stratum_weight = row.speed_band === stratum ? 1 : 0;
    stratumSize = pool.filter((row) => row.stratum_weight === 1).length;
    weightRule.applied = true;
    weightRule.output = {stratum, stratum_size: stratumSize, before: pool.length, after: pool.length};
    weightRule.unverified = ['未核实：为什么以我方**最多且池子里存在**的速度档为层 —— 这是工程假设'
      + '（对齐自家最常见、并且真的还有候选可挑的那一层），不是强度结论；'
      + '并列时按档名定序（tie-break 写在 inputs 里）'];
    unverified.push(weightRule.unverified[0]);
  }
  ledger.push(weightRule);

  return {
    pool,
    ledger,
    stratum,
    stratum_size: stratumSize,
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

/** 取源码的**在线段**：`ONLINE_SECTION_MARKER` 之前的正文，剥掉注释。 */
export function onlineSectionOf(source) {
  const text = String(source ?? '');
  const markerAt = text.indexOf(ONLINE_SECTION_MARKER);
  const head = markerAt >= 0 ? text.slice(0, markerAt) : text;
  return head
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
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

    // ── 条件化：规则账本可复算 + 公开性边界 ──
    if (belief.belief === 'revealed_conditioned') {
      const leaked = arr(belief.leaked_fields);
      if (leaked.length > 0 && belief.available === true) {
        push('PUBLIC_FACTS_BOUNDARY', `${where}.leaked_fields`,
          `公开事实越界（${leaked.map((row) => row?.path ?? row).join(' / ')}）却仍然 available:true：`
          + '越界必须拒绝整个输入，不许静默过滤后照样出权重');
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

  // ── 在线段不许出现引擎 / 子进程调用 ──
  const section = sourceText(options.source, scope);
  if (typeof section === 'string') {
    for (const hit of scanForbiddenPatterns(section)) {
      push(hit.code, `src/coach/opponent-belief.mjs:${hit.line}（scanned=${scope}）`,
        `出现 ${hit.pattern}：${hit.detail}（实际源码 ${stableJson(hit.text)}）`);
    }
    if (scope === 'online') {
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

  return {ok: problems.length === 0, problems};
}

// ─────────────────────────────────────────────────────────────────────────
// 产出：机器可读报告
// ─────────────────────────────────────────────────────────────────────────

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
    source = null,
    red_proofs = [], generated_by = 'src/coach/opponent-belief.mjs 的 beliefReport()，'
      + '由 tests/roco-opponent-belief.test.js 复跑比对',
    input_sources = [],
  } = input ?? {};

  const uniform = uniformBelief({catalog});
  const conditioned = revealedConditioned({catalog, publicFacts});
  const frequency = frequencyBelief({frequencyData});
  const beliefs = [uniform, conditioned, frequency];

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
      label: '每条规则给出 {输入 → 输出 → 依据}，且可复算',
      criteria: STRUCTURAL_CRITERIA.rules_recomputable,
      actual: arr(conditioned.rule_ledger).map((row) => `${row.id}: applied=${row.applied} `
        + `matched=${row.output?.matched ?? row.output?.stratum_size ?? 'null'}`),
      ok: arr(conditioned.rule_ledger).every((row) => isNonEmptyString(row.basis)
        && Array.isArray(row.reads) && (row.applied ? isPlainObject(row.output) : isNonEmptyString(row.reason))),
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
      label: '在线段没有引擎 / 子进程调用（源码结构判据）',
      criteria: STRUCTURAL_CRITERIA.online_no_engine,
      actual: typeof input.source === 'string'
        ? scanForbiddenPatterns(onlineSectionOf(input.source)).map((hit) => hit.pattern) : '未注入源码',
      ok: typeof input.source === 'string'
        && scanForbiddenPatterns(onlineSectionOf(input.source)).length === 0,
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
      'data/roco/game-data-pack/v2/pack.json#sections.distributable.entities[group=pet]（622 个图鉴物种：属性 / 指针）',
      'data/roco/owned/owned-pets.json#instances（48 个箱子实例；物种与 pack 的交集 = 48 ⇒ 实测并集 = 622）',
      'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json（速度 stats.spe，622 只全有）',
      'data/roco/normalized/roco-world-s4-2026-09-10/types.json（属性相性表：唯一实现在 RC-302/303 的 buildGapIndex()）',
      'data/roco/meta-prior/v1.json#distribution[]（版本先验：全部 source=unknown + value=null ⇒ 没有频次可用）',
      'roco/src/roco_env/env.py#public_planner_state（公开性口径：对手后备只有位次 / id / 是否倒下）',
    ],
    public_fact_boundary: {
      allowed: PUBLIC_FACT_FIELDS,
      hidden: HIDDEN_FACT_FIELDS,
      policy: '隐藏字段出现 ⇒ **拒绝整个输入**（available:false + 点名路径），不静默过滤：'
        + '过滤会让泄漏查不出来。口径与引擎 public_planner_state 对齐。',
      source: 'roco/src/roco_env/env.py#public_planner_state（对手场上公开；后备只有位次 / id / 是否倒下）',
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
      '不偷看：对手后备、配招、道具、体力数值、性格天赋不进输入（传进来即拒绝）',
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
// 离线段：读盘 / 对照样例（在线路径不许调用这里的任何入口）
// ─────────────────────────────────────────────────────────────────────────

/** 离线段从此开始（审计的分界线）。 */
export const OFFLINE_SECTION_MARKER = '<!-- OFFLINE-SECTION-BEGIN -->';

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

/** 本模块的在线段到此结束（给审计看的显式标记；`ONLINE_SECTION_MARKER` 在文件上方）。 */
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

