// ── RC-304：未知对手下的队伍比较（五个口径，能算的算、算不出的 fail closed） ────────
//
// 13 号设计文档 §4 说：匹配前没有具体敌队，评价的是六宠队伍**对版本环境分布**的表现。
// 它列了六个口径，本 RC 落五个（CVaR 与 robustness 在文档里写成一格，见 §边界）：
//
//   environment_value    对版本对手分布的期望表现        ← 需要「分布」
//   worst_archetype      最怕的主流体系                 ← 需要「分布」
//   matchup_spread       是否严重依赖撞到特定阵容        ← 需要「分布」
//   execution_tolerance  次优操作下掉多少               ← 需要「分布」
//   coverage_confidence  六宠 build 的规则与数据覆盖     ← **不依赖分布，现在就能算**
//
// 这三个口径的三档输入，本模块都认（`resolveDistribution()` 是唯一的判定点）：
//
//   · `measured`   逐条带可核对来源（url / 仓内文件 + 日期）+ 数值 ⇒ 前四轴亮起来，值来自注入分布；
//   · `assumption` **声明假设**：逐条带 `basis`（`kind` + `denominator > 0` + `recomputable_from`）、
//                  `confidence: "ENGINE_HYPOTHESIS"`、`unit: "share"`，且**不许挂 sources**；
//                  占比构成一次划分（合计 = 1）。这时「对环境的期望」有分母了，但
//                  `relative_score` / `tolerance` 不是离线联赛产物——它们由**本模块**按体系自己声明的
//                  `archetypes[].feature_axes[].criterion` 从 RC-302 的缺口诊断里**结构性**算出来，
//                  每个判据的分母随证据一起写进产出（见 `structuralScoresForTeam()`），
//                  置信等级是 `ENGINE_HYPOTHESIS`，四轴必须 `available:true` 并对分母敏感；
//   · `unknown`    没有可用分母 ⇒ `available:false` + 点名缺什么的 `unknown_reason` + `value: null`（不是 0）。
//
// 三档都**永不**输出胜率 / 百分数 / 「差不多」。一个不带 `basis` 的裸数字不是 assumption，是编造：
// 它让整份分布退回 unknown（判据 ⑨ 的反证钉住这一点）。
//
// 它**不做**的事（边界同 RC-303，报告与 `docs/roco/TEAM-COMPARE.md` 里各写一遍）：
//   · 在线路径不跑模拟、不调引擎、不起进程（结构判据扫源码，见 ONLINE_SECTION_MARKER）；
//   · 不产出胜率、强度分、榜单名次、伪精确概率（`BANNED_CLAIM_KEYS` / `BANNED_CLAIM_WORDS`）；
//   · 不训练、不假装有排序器：注入的 `ranker` 不存在时 `ranker_status: 'missing'`；
//   · `minimalReplacement()` 只给**恰好一个**替换方案；分布 unknown 时不许写「换谁更好」，
//     只能给**结构理由**（例如补上队里没人能接的弱点）并明确说不知道。
//
// 数据全部**显式注入**（teamA / teamB / metaPrior / gapsByTeam / ranker / candidates），
// 本文件不读盘、不看时钟、不碰 DOM。读盘只发生在 `loadTeamCompareInputs()`（离线段）。
//
// 依赖：只 import 同仓纯函数模块 `./team-gaps.js`（RC-302 的台账六级、缺口索引与诊断）。
// **不复制第二套语义**：置信等级、判据 ID、缺口诊断都调用 RC-302 的实现。
// （队伍规模常量在这里没用到：六宠口径出现在文档与报告样例形状里，本模块不校验人数。）

import {
  CONFIDENCE_LEVELS, CONFIDENCE_RANK, RESPOND_VARIANTS, diagnoseTeamGaps,
} from './team-gaps.js';

/**
 * 在线段到此结束（审计扫的是它**之前**的正文）。
 *
 * 为什么边界常量写在最前面：下面每一次 `//` 注释里的「在线路径不…」都只是注释，
 * 判据必须落在**源码结构**上——审计把这一段源码取出来，逐行做禁止模式的子串匹配。
 */
export const ONLINE_SECTION_MARKER = '<!-- ONLINE-SECTION-END -->';

/** 报告路径（由测试与 `buildRc304Report()` 生成，逐字节可复跑）。 */
export const RC304_REPORT_PATH = 'reports/roco/flagship-upgrade/rc-304-team-compare.json';
export const RC304_REPORT_VERSION = 'roco-rc304-team-compare-report/v1';

/**
 * 五轴的 ID 与顺序（顺序即输出键序 ⇒ 逐字节可复跑）。
 *
 * `environment_value` 是 13 号文档 §4 的 `expected_meta_value`；先验
 * `usage.inputs` 用的也是后者。两个名字指的是同一件事，这里用前者做键、
 * 把后者写进 `prior_field` 与证据里，不假装是两个口径。
 */
export const AXES = Object.freeze([
  Object.freeze({
    id: 'environment_value', prior_field: 'expected_meta_value', label: '环境价值',
    definition: '队伍对**版本对手分布**的期望表现：对每个可识别体系求相对表现的加权均值，权重 = 该体系在环境里的占比。',
  }),
  Object.freeze({
    id: 'worst_archetype', prior_field: 'worst_archetype', label: '最怕的体系',
    definition: '逐体系相对表现里**最差**的那一个（含它的占比）：它回答「撞到谁最吃亏」。',
  }),
  Object.freeze({
    id: 'matchup_spread', prior_field: 'matchup_spread', label: '对局离散度',
    definition: '逐体系相对表现的极差（最好 − 最差）：越大越说明这支队伍严重依赖撞到特定阵容。',
  }),
  Object.freeze({
    id: 'execution_tolerance', prior_field: 'execution_tolerance', label: '操作容错',
    definition: '次优操作下的相对表现（1 = 与最优操作同分，0 = 完全崩掉）在分布上的加权均值。',
  }),
  Object.freeze({
    id: 'coverage_confidence', prior_field: 'coverage_confidence', label: '覆盖置信',
    definition: '六宠 **build 的规则与数据覆盖**：七维判据里有多少在台账里是 UNKNOWN、有多少条缺口带着 UNKNOWN、'
      + '有多少成员没有具体 build 数据。它是对**自己**知道多少的描述，不是实力判断，也**不依赖**对手分布。',
  }),
]);
export const AXIS_IDS = Object.freeze(AXES.map((axis) => axis.id));
const AXIS_BY_ID = Object.freeze(Object.fromEntries(AXES.map((axis) => [axis.id, axis])));

/** 前四轴：它们都需要「版本对手分布」，分布 unknown 时一律 fail closed。 */
export const DISTRIBUTION_AXES = Object.freeze(
  ['environment_value', 'worst_archetype', 'matchup_spread', 'execution_tolerance']);

/** 相对表现的口径：0～1 的相对分，**不是**胜率、不是百分数。 */
export const RELATIVE_SCORE_RANGE = Object.freeze({min: 0, max: 1});

/** 数值精度：固定小数位，避免浮点噪声让同一输入产生不同字节。 */
const SCORE_DECIMALS = 6;
const round = (value, decimals = SCORE_DECIMALS) => (Number.isFinite(value)
  ? Number(value.toFixed(decimals)) : value);

/** 排序器的状态（与 RC-303 同义：没有产物就是 `missing`，不许假装有）。 */
export const RANKER_STATUSES = Object.freeze(['ready', 'missing', 'invalid']);

/**
 * fail closed 的原因文本。**点名缺什么**，不是「差不多」。
 * 报告、文档与测试都引用这些常量，改一处不会三处漂移。
 */
export const FAIL_CLOSED_REASONS = Object.freeze({
  DISTRIBUTION_UNKNOWN: '缺**版本对手分布**：注入的 `distribution[]` 是 `source: "unknown"` + `value: null`'
    + '（没有任何真实对局数据，也没有声明假设的分母），所以「对环境的期望」的分母不存在，'
    + '这一轴现在无定义。按契约返回 unknown，不返回 0、不给「差不多」、不输出伪精确结论。',
  DISTRIBUTION_ENTRY_VALUE_MISSING: '缺**逐体系分布值**：注入的分布里至少一个体系的 `value` 是 `null`，'
    + '分母不闭合，所以这一轴现在无定义（要么补齐每个体系的值，要么整份分布保持 unknown）。',
  NO_RELATIVE_SCORE: '缺**逐体系相对表现表**：分布说的是「对手占多少」，'
    + '还需要每行的 `relative_score` 才能把占比折成期望。measured 档的 `relative_score` 是离线联赛 / '
    + 'matchup bank 的产物，本仓没有这份产物；assumption 档的行由本模块从 RC-302 结构性算出（见 NO_STRUCTURAL_SIGNAL）。',
  NO_EXECUTION_SAMPLE: '缺**可复跑的对局采样**：`distribution[].tolerance`（同一支队伍在次优操作下的'
    + '相对表现）是离线回放/联赛的产物，本仓一次都没跑过；规则本身还在 candidate 阶段'
    + '（台账里严格总序仍是 ENGINE_HYPOTHESIS），所以容错数值现在一定是伪精确。'
    + 'assumption 档下这一轴用的是**结构短板**（该体系所声明判据里的最小结构分，见产出里的 structural_basis），'
    + '它是下界代理，不是回放测量。',
  NO_GAP_DIAGNOSIS: '缺**build 覆盖数据**：这一轴只依赖 build 的规则/数据覆盖，本可以立刻算；'
    + '但没有注入 RC-302 的缺口诊断（`gapsByTeam[team_id]`）时，连「哪些量在台账里是 UNKNOWN」都读不到，'
    + '所以 fail closed 而不是报 0 覆盖。',
  NO_MEASURED_SOURCE: '缺**逐条可核对的来源**：注入的分布标了 `source: "measured"`，'
    + '却没有 url / 仓内文件 + 日期（先验的 `DISTRIBUTION` 判据要求 measured 必须有来源）。'
    + '没有来源的数字不许进比较，所以这一轴仍然 unknown。',
  NO_ARCHETYPE: '缺**可识别体系**：注入的分布里一条体系都没有，分母是空的，这一轴无定义。',
  ASSUMPTION_BASIS_MISSING: '缺**声明假设的可复算依据**：分布里有 `source: "assumption"` 的行，'
    + '但 `basis` 不完整（`kind` / `denominator > 0` / `recomputable_from` 缺一，或 `confidence` 不是 '
    + '`ENGINE_HYPOTHESIS`、`notes` 太短、`unit` 不是 `share`）。**一个不带依据的数字就是编的**，'
    + '所以这一轴回到 unknown，而不是照用这个数。',
  ASSUMPTION_CARRIES_SOURCE: '**声明假设不许挂来源**：`source: "assumption"` 的行上带了 `sources[]`——'
    + '这是把假设伪装成实测。要么撤掉来源保留 `basis`，要么拿真的可核对来源并把 `source` 改成 `measured`。',
  NO_PARTITION: '**占比不闭合**：`distribution[].value` 的合计不等于 1（容差 0.001）。'
    + '权重只有在构成一次划分时才有分母含义；合计不是 1 就说明这不是一次划分，这一轴无定义。',
  NO_STRUCTURAL_SIGNAL: '缺**该体系所声明判据的结构输入**：assumption 档下这一轴的相对表现要按体系自己的 '
    + '`archetypes[].feature_axes[].criterion` 从 RC-302 的缺口诊断里算（每个判据的分子 / 分母都写进 `evidence[]`），'
    + '但诊断里没有这些字段，或者这一队没有注入 `gapsByTeam`。本模块不拿别的数据顶替、不给 0：回到 unknown。',
});

// ─────────────────────────────────────────────────────────────────────────
// 在线 / 离线边界：在线段不许出现引擎、子进程、引擎客户端
// ─────────────────────────────────────────────────────────────────────────

/**
 * 在线段（`ONLINE_SECTION_MARKER` 之前）禁止出现的调用模式。
 * 与 RC-303 同形：命中一条就是**结构判据失败**，不是风格问题。
 */
export const FORBIDDEN_ONLINE_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL', pattern: 'step_joint',
    detail: '在线队伍比较里出现引擎的联合推进入口：比较只读注入数据，跑模拟是离线产标签的事',
  }),
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL', pattern: 'plan_actions',
    detail: '在线队伍比较里出现引擎的规划入口：那属于离线 league / 自博弈',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'child_process',
    detail: '在线队伍比较里出现子进程模块：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'spawn',
    detail: '在线队伍比较里出现 spawn：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'roco-client',
    detail: '在线队伍比较里出现 Python 引擎客户端：在线路径不连接引擎',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL', pattern: 'RocoClient',
    detail: '在线队伍比较里出现 Python 引擎客户端类：在线路径不连接引擎',
  }),
]);

/** 哪些是**离线**入口，谁调用它们。报告与文档共用这一份声明。 */
export const OFFLINE_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    id: 'loadTeamCompareInputs',
    what: '读盘加载 RC-302 的索引与诊断输入；**在线路径不许调用**（在线只用注入数据）。',
    caller: '测试与报告生成（Node 侧）',
  }),
  Object.freeze({
    id: 'buildRc304Report',
    what: '生成机器可读报告；纯函数，不做在线比较。',
    caller: 'tests/roco-team-compare.test.js',
  }),
  Object.freeze({
    id: 'buildMeasuredDistributionSample',
    what: '构造一份 `measured` 分布的**对照样例**（证明接口是活的，不是恒 unknown）。',
    caller: '报告生成与测试',
  }),
]);

/** 哪些是**在线**入口。审计逐条扫它们的源码段。 */
export const ONLINE_ENTRYPOINTS = Object.freeze([
  'compareTeams', 'minimalReplacement', 'auditTeamCompare',
  'resolveDistribution', 'coverageConfidence', 'compareAxisValues',
  'renderCompareText', 'collectClaimText', 'resolveRanker', 'formatRelative',
]);

/** 结构判据的文本（报告里逐条贴出来，与实现同源）。 */
export const STRUCTURAL_CRITERIA = Object.freeze({
  distribution_fail_closed: '[严格] 注入的 `metaPrior` 是 `unknown` 档（`distribution_source === "unknown"`，'
    + '或 `distribution[].value` 有 null，或没有任何可用分母）时，'
    + `${DISTRIBUTION_AXES.join(' / ')} 四轴的 \`available\` 必须是 \`false\`、\`value\` 必须是 \`null\`、`
    + '`unknown_reason` 必须点名缺什么。出现数值 / `0` / 「差不多」/ 胜率 ⇒ `UNKNOWN_AXIS_HAS_VALUE`（红）。',
  assumption_needs_basis: '[严格] `source: "assumption"` 的行必须带**可复算的声明依据**：'
    + '`basis.kind === "uniform-over-candidate-universe"`、`basis.denominator > 0`、'
    + '`basis.recomputable_from` 非空、`unit === "share"`、`confidence === "ENGINE_HYPOTHESIS"`、'
    + '`notes` 足够长，**且不许挂 `sources[]`**；全部分布的 `value` 合计 = 1（容差 0.001，一次划分）。'
    + '任一条不满足 ⇒ 四轴必须回到 `available:false` + `value:null` 并点名缺什么；'
    + '照用这个裸数字 ⇒ `UNKNOWN_AXIS_HAS_VALUE`（红）——「硬编码样例数字」就是从这儿进来的。',
  assumption_structural_scores: '[严格] assumption 档下的 `relative_score` / `tolerance` 不许直接抄注入值，'
    + '必须由**体系自己声明的** `archetypes[].feature_axes[].criterion` 从 RC-302 的登记字段结构性算出：'
    + '每个判据的分子 / 分母 / 依据缺口写进 `evidence[]` 与 `structural_basis`（等权、分母 = 判据条数），'
    + '`relative_score` = 判据结构分的等权均值，`tolerance` = 其中的最小值（结构短板），'
    + '轴的 `confidence` 必须是 `ENGINE_HYPOTHESIS`。缺任一判据的输入 ⇒ 整轴 fail closed（`NO_STRUCTURAL_SIGNAL`），'
    + '不拿别的数据顶替、不给 0。把裸数字当相对分、或绕开 `feature_axes` 另设权重表 ⇒ 红。',
  measured_lights_up: '注入带来源的 `measured` 分布时，前四轴**必须**亮起来（`available:true`），'
    + '值必须来自注入分布（加权均值 / 极差 / 最差体系逐条可对账）。'
    + '反过来，如果 `available` 的轴数与注入分布里 `value` 非 null 的体系数对不上 ⇒ `MEASURED_NOT_WIRED`（红）：'
    + 'fail closed 不许写成「永远 unknown」。',
  coverage_from_build: '[弱] `coverage_confidence` 必须**真算**：它的 `value` 只由注入的 build / 台账数据决定'
    + '（注入一份更差的 build ⇒ 覆盖置信必须更低）。同一份数据算两次必须逐字节相同，'
    + '否则 `COVERAGE_NOT_FROM_BUILD`（红）。',
  availability_shape: '`available:true` 的轴必须给出**非 null 的数值型** `value`（或最怕体系那轴的非空对象）；'
    + '`available:false` 的轴必须给出 `value: null` 且 `value_numbers` 为空。'
    + '数值轴报 `null` 却写 `available:true` ⇒ `AVAILABILITY_SHAPE`（红）。',
  no_pseudo_precision: '产出与渲染文本里不许出现胜率 / 概率 / 百分数 / 强度分 / 榜单标签（T0 / 强势 / 必带…）；'
    + '命中即 `PSEUDO_PRECISION`（红）。`value_numbers`（单位与量纲）必须逐条声明，'
    + '`unit` 与 `value_numbers[].unit` 里出现 `BANNED_UNIT_WORDS`（胜率 / 概率 / 百分比 / %）'
    + '⇒ `PSEUDO_PRECISION`（红）：量纲是伪精确最常见的藏身处。'
    + '扫描范围只排除 `definition` 与判据正文，**键名检查不受豁免**。',
  evidence_and_confidence: '每一轴必须有非空 `evidence[]`（`source_file` + `pointer` + `field`），'
    + '`confidence` 必须命中台账六级；`available:false` 时 `confidence` 只能是 `UNKNOWN`，'
    + '否则 `EVIDENCE_MISSING` / `CONFIDENCE_NOT_IN_LEDGER`（红）。',
  online_no_engine: '把 `src/coach/team-compare.mjs` 的在线段（`ONLINE_SECTION_MARKER` 之前）逐行取出、'
    + '剥掉行注释与块注释，再对每行做 `FORBIDDEN_ONLINE_PATTERNS[].pattern` 的子串匹配：'
    + '命中即 `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL`（红）。判据是**源码结构**，不是注释声明。',
  one_replacement: '`minimalReplacement()` 必须给**恰好一个**方案（`replacement.out` + `replacement.in` 各恰好一个），'
    + '且必须带非空的 `why` 与 `evidence[]`；返回数组 / 多方案 / 没有 `why` ⇒ `REPLACEMENT_SHAPE`（红）。',
  replacement_honesty: '分布 unknown 时 `minimalReplacement()` **不许**写「换谁更好」：`confirmed_by_distribution` 必须是 '
    + '`false`，并必须给出结构理由。写成 `true` 或给出「更优」结论 ⇒ `REPLACEMENT_OVERCLAIM`（红）。',
  deterministic: '同一份输入连续两次调用，五个口径 + 最小替换 + 渲染文本的 `JSON.stringify` 结果必须逐字节相同'
    + '（含 tie-break），否则 `NONDETERMINISTIC`（红）。',
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const arr = (value) => (Array.isArray(value) ? value : []);
const stableJson = (value) => JSON.stringify(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/** 证据项：与 RC-302 / RC-303 同形（`source_file` / `pointer` / `field` / `value` / `note`）。 */
export const evidence = (sourceFile, pointer, field, value, note = null) => ({
  source_file: sourceFile, pointer, field, value, note,
});

/** `value_numbers`：每个数值的**单位与量纲**，避免「一个裸数字被读成胜率」。 */
export const valueNumber = (name, unit) => ({name, unit});
export const RELATIVE_UNIT = '相对分（0～1 的序数标度，不预测胜负）';
export const SHARE_UNIT = '环境权重（0～1，逐条来源可核对）';
export const SPREAD_UNIT = '相对分极差（0～1 的序数标度，不预测胜负）';

/** 审计问题：`{code, where, detail}`（与 RC-302/303 同形）。 */
const auditProblem = (code, where, detail) => ({code, where, detail});
export const formatAuditProblem = (problem) => `[${problem.code}] ${problem.where}：${problem.detail}`;

// ─────────────────────────────────────────────────────────────────────────
// 注入数据的形状
// ─────────────────────────────────────────────────────────────────────────

/** 队伍成员引用：`{key}`（`instance:own-0001` / `species:pet_000012` 都行）或 `{team_id}`。 */
const memberKeys = (team) => arr(team?.members)
  .map((member) => member?.key ?? member?.instance_id ?? member?.candidate_key ?? null)
  .filter(isNonEmptyString);

const teamLabel = (team) => (isNonEmptyString(team?.team_id) ? team.team_id : null);

/** 一条注入分布是否带「可核对的来源」（url 或仓内文件）。 */
const hasMeasuredSource = (sources) => arr(sources).some((source) => (isPlainObject(source)
  && (isNonEmptyString(source.ref) || isNonEmptyString(source.path))
  && (isNonEmptyString(source.date) || isNonEmptyString(source.as_of))));

const sourceRefs = (sources) => arr(sources)
  .map((source) => source?.ref ?? source?.path ?? null)
  .filter(isNonEmptyString);

/** 声明假设的 `basis.kind`：均匀铺在候选宇宙上——分母必须能被第三方**重算**出来。 */
export const ASSUMPTION_BASIS_KIND = 'uniform-over-candidate-universe';
/** 占比合计的容差：`distribution[].value` 是一次划分，合计必须落在 1 ± 这个值里。 */
export const PARTITION_TOLERANCE = 0.001;
/** `notes` 的长度下限（与 `scripts/roco/meta-prior-lib.mjs` 的校验器同一条）。 */
const ASSUMPTION_NOTES_MIN = 12;

/**
 * 一条 `source: "assumption"` 的行缺什么。返回 `[]` 就是「依据齐全」。
 *
 * 校验与 `scripts/roco/meta-prior-lib.mjs` 的校验器**同形**（那边是产出侧的闸门，这边是消费侧的闸门）：
 * 少了这边，一个手写的裸数字只要标成 assumption 就能进比较——那正是「硬编码样例数字」的入口。
 */
export function assumptionBasisProblems(entry) {
  const problems = [];
  const basis = isPlainObject(entry?.basis) ? entry.basis : null;
  if (basis === null) problems.push('basis');
  else {
    if (basis.kind !== ASSUMPTION_BASIS_KIND) problems.push('basis.kind');
    if (!(Number.isFinite(basis.denominator) && Number(basis.denominator) > 0)) problems.push('basis.denominator');
    if (!isNonEmptyString(basis.recomputable_from)) problems.push('basis.recomputable_from');
  }
  if (!Number.isFinite(entry?.value) || Number(entry.value) < 0 || Number(entry.value) > 1) problems.push('value(0～1)');
  if (entry?.unit !== 'share') problems.push('unit=share');
  if (entry?.confidence !== 'ENGINE_HYPOTHESIS') problems.push('confidence=ENGINE_HYPOTHESIS');
  if (!isNonEmptyString(entry?.notes) || entry.notes.trim().length < ASSUMPTION_NOTES_MIN) problems.push('notes');
  return problems;
}

/**
 * 读注入的分布。**两套形状都认**，因为先验的 schema 与先验的 v1.json 各写了一套：
 *   · `metaPrior.distribution_source`（顶层判定，RC-304 任务书写的就是这个）；
 *   · `metaPrior.distribution[]`（先验实际产物：逐体系 `source` / `value` / `sources` / `basis`）。
 * 顶层没写就按逐条推断。三档判定，任何一档都不许「差不多」：
 *   · `measured`   每行都有可核对来源 + 数值；
 *   · `assumption` 每行都有可复算 `basis` + `unit: share` + ENGINE_HYPOTHESIS、**不许挂来源**、占比合计 = 1；
 *   · `unknown`    其余情况（含任何一条 `value` 是 null、任何一条 basis 不全）。
 */
export function resolveDistribution(metaPrior) {
  const prior = isPlainObject(metaPrior) ? metaPrior : {};
  const entries = arr(prior.distribution);
  const declared = prior.distribution_source ?? null;

  const rows = entries.map((entry, index) => {
    const source = isNonEmptyString(entry?.source) ? entry.source : null;
    const value = Number.isFinite(entry?.value) ? Number(entry.value) : null;
    const basisProblems = source === 'assumption' ? assumptionBasisProblems(entry) : [];
    const sources = arr(entry?.sources);
    // 展示用 label：分布行自己没有就回落到 `archetypes[]` 的同一个体系（只是名字，不产生任何数）。
    const metaLabel = arr(prior.archetypes)
      .find((item) => item?.archetype_id === entry?.archetype_id)?.label ?? null;
    return {
      index,
      archetype_id: entry?.archetype_id ?? null,
      label: entry?.label ?? entry?.archetype_label ?? metaLabel,
      source,
      value,
      relative_score: Number.isFinite(entry?.relative_score) ? Number(entry.relative_score) : null,
      tolerance: Number.isFinite(entry?.tolerance) ? Number(entry.tolerance) : null,
      basis: isPlainObject(entry?.basis) ? entry.basis : null,
      basis_problems: basisProblems,
      notes: isNonEmptyString(entry?.notes) ? entry.notes : null,
      confidence: isNonEmptyString(entry?.confidence) ? entry.confidence : null,
      unit: isNonEmptyString(entry?.unit) ? entry.unit : null,
      sources,
      has_source: hasMeasuredSource(sources),
      reason: isNonEmptyString(entry?.reason) ? entry.reason : null,
    };
  });

  const measuredRows = rows.filter((row) => row.source === 'measured' || row.value !== null);
  const unknownDeclared = declared === 'unknown';
  // 逐条**自己**标了 unknown（或 value 为 null）也算「分布不存在」，不只是看顶层声明：
  // 先验的 v1.json 早期形状就是这种（没有顶层 distribution_source，全部 unknown + null）。
  const unknownEntries = rows.filter((row) => row.source === 'unknown' || row.value === null).length;
  const rowsAllUnknown = rows.length > 0 && unknownEntries === rows.length;
  const noRows = rows.length === 0;

  // 三档的判据，逐条都要过：
  const measuredOk = !unknownDeclared && !noRows && measuredRows.length === rows.length
    && measuredRows.every((row) => row.value !== null && row.has_source && row.source === 'measured');
  // 假设档：每行都自报 assumption、basis 齐全、不挂来源；且占比合计 = 1（一次划分）。
  const assumptionRows = rows.filter((row) => row.source === 'assumption');
  const weightSumForPartition = round(rows.reduce((sum, row) => sum + (row.value ?? 0), 0));
  const partitionOk = rows.length > 0
    && Math.abs(weightSumForPartition - 1) <= PARTITION_TOLERANCE;
  const basisOk = rows.every((row) => row.source === 'assumption' && row.basis_problems.length === 0);
  const noSourcesOnAssumption = rows.every((row) => row.sources.length === 0);
  const assumptionOk = !unknownDeclared && !noRows && assumptionRows.length === rows.length
    && rows.every((row) => row.value !== null) && basisOk && noSourcesOnAssumption && partitionOk;

  let kind = 'unknown';
  if (measuredOk) kind = 'measured';
  else if (assumptionOk) kind = 'assumption';

  const missingValue = rows.filter((row) => row.value === null).map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const missingSource = measuredRows.filter((row) => !row.has_source)
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const missingValueSource = measuredRows.filter((row) => isNonEmptyString(row.source) && row.source !== 'measured'
    && row.source !== 'assumption')
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const basisProblemRows = rows.filter((row) => row.source === 'assumption' && row.basis_problems.length > 0)
    .map((row) => `${row.archetype_id ?? `distribution[${row.index}]`}（缺 ${row.basis_problems.join(' / ')}）`);
  const sourcedAssumptionRows = rows.filter((row) => row.source === 'assumption' && row.sources.length > 0)
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const unlabelledValueRows = rows.filter((row) => row.value !== null
    && row.source !== 'measured' && row.source !== 'assumption')
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);

  // 权重：分母。分布给了 `value` 就当作占比；没有就把可用行等权（并说明这一点）。
  const weightMode = rows.some((row) => row.value !== null) ? 'value' : 'equal_weight_fallback';
  const weights = rows.map((row) => (row.value !== null ? Number(row.value) : (rows.length ? 1 / rows.length : 0)));
  const weightSum = round(weights.reduce((sum, weight) => sum + weight, 0));

  const missing = [];
  if (noRows) missing.push('distribution[]（一条体系都没有）');
  if (unknownDeclared || rowsAllUnknown) {
    missing.push('metaPrior.distribution_source = "unknown"（没有任何真实对局数据，也没有声明假设的分母）');
  }
  if (missingValue.length) missing.push(`distribution[].value（${missingValue.join(' / ')}）`);
  if (missingSource.length) missing.push(`distribution[].sources（${missingSource.join(' / ')} 标了 measured 却没有 url / 文件）`);
  if (missingValueSource.length) missing.push(`distribution[].value_source（${missingValueSource.join(' / ')} 标了 measured 却没有来源）`);
  if (basisProblemRows.length) missing.push(`distribution[].basis（${basisProblemRows.join(' / ')}）`);
  if (sourcedAssumptionRows.length) missing.push(`distribution[].sources（${sourcedAssumptionRows.join(' / ')} 标了 assumption 却挂了来源）`);
  if (unlabelledValueRows.length) missing.push(`distribution[].source（${unlabelledValueRows.join(' / ')} 有 value 却没写 source=measured / assumption）`);
  if (!noRows && rows.every((row) => row.value !== null) && !partitionOk) {
    missing.push(`distribution[].value 合计 = ${weightSum}（不是 1，分布不是一次划分）`);
  }

  const reason = kind !== 'unknown' ? null
    : (noRows ? FAIL_CLOSED_REASONS.NO_ARCHETYPE
      : (unknownDeclared || rowsAllUnknown ? FAIL_CLOSED_REASONS.DISTRIBUTION_UNKNOWN
        : (basisProblemRows.length ? FAIL_CLOSED_REASONS.ASSUMPTION_BASIS_MISSING
          : (sourcedAssumptionRows.length ? FAIL_CLOSED_REASONS.ASSUMPTION_CARRIES_SOURCE
            : (!partitionOk ? FAIL_CLOSED_REASONS.NO_PARTITION
              : (missingSource.length ? FAIL_CLOSED_REASONS.NO_MEASURED_SOURCE
                : FAIL_CLOSED_REASONS.DISTRIBUTION_ENTRY_VALUE_MISSING))))));

  return {
    kind,
    declared_source: declared,
    entries: rows,
    weights,
    weight_sum: weightSum,
    weight_mode: weightMode,
    partition_ok: partitionOk,
    assumption_rows: assumptionRows.length,
    missing,
    missing_value_entries: missingValue,
    missing_source_entries: missingSource,
    missing_basis_entries: basisProblemRows,
    reason,
    evidence: buildDistributionEvidence(prior, rows, kind, declared),
  };
}

function buildDistributionEvidence(prior, rows, kind, declared) {
  const evidenceRows = [evidence(
    'data/roco/meta-prior/v1.json', 'distribution[]', 'source',
    declared === null ? '（未注入顶层 distribution_source）' : declared,
    '环境先验的分布口径：先验自己写下的 unknown / assumption / measured 判定',
  )];
  for (const row of rows) {
    evidenceRows.push(evidence(
      'injected:metaPrior.distribution[]', `distribution[${row.index}]`, 'value',
      row.value === null ? null : row.value,
      `体系 ${row.archetype_id ?? `#${row.index}`}：source=${stableJson(row.source)}、`
      + `relative_score=${stableJson(row.relative_score)}、tolerance=${stableJson(row.tolerance)}、`
      + `basis=${row.basis === null ? '（没有）' : stableJson({kind: row.basis.kind, denominator: row.basis.denominator,
        recomputable_from: row.basis.recomputable_from})}、`
      + `来源 ${sourceRefs(row.sources).join(' / ') || '（没有）'}`,
    ));
  }
  if (kind === 'assumption') {
    const denominators = uniqueSorted(rows.map((row) => row.basis?.denominator)
      .filter((value) => Number.isFinite(value)).map((value) => String(value)));
    evidenceRows.push(evidence(
      'data/roco/meta-prior/v1.json', 'distribution[].basis', 'kind',
      rows[0]?.basis?.kind ?? null,
      `占比是**声明假设**（不是实测分布）：${rows.length} 个体系各 1/${denominators.join(' / ') || '?'}，`
      + '分母可由 `basis.recomputable_from` 指向的脚本重算；合计 = 1（一次划分）。'
      + '这条分布只提供**分母**，不提供任何体系的强弱结论。置信等级：ENGINE_HYPOTHESIS。',
    ));
    evidenceRows.push(evidence(
      'data/roco/meta-prior/v1.json', 'distribution[].basis.recomputable_from', 'recomputable_from',
      uniqueSorted(rows.map((row) => row.basis?.recomputable_from).filter(isNonEmptyString)),
      '重算通道：拿这个脚本跑一遍就能得出同一组占比（K 或等级变了，占比随之变）',
    ));
    evidenceRows.push(evidence(
      'data/roco/meta-prior/v1.json', 'distribution[].basis.replace_with', 'replace_with',
      rows[0]?.basis?.replace_with ?? null,
      '替换通道：拿到带 url / 仓内文件 + 日期 + 台账等级的来源后，把 source 改成 measured，'
      + '相对表现改用离线联赛 / matchup bank 的产物（本模块的 measured 通路已经就位）',
    ));
  }
  if (kind === 'unknown') {
    evidenceRows.push(evidence(
      'data/roco/meta-prior/v1.json', 'claim.does_not_contain', 'claim',
      '任何体系的占比数值：这份分布没有可用分母（unknown 或 value: null 或 basis 不全）',
      '先验自己声明它不产出占比：所以本模块不能从这里读出一个分母',
    ));
    const firstReason = rows.find((row) => isNonEmptyString(row.reason))?.reason ?? null;
    if (firstReason !== null) {
      evidenceRows.push(evidence(
        'data/roco/meta-prior/v1.json', 'distribution[].reason', 'reason', firstReason.slice(0, 400),
        '先验逐条写下的 unknown 原因（本模块的 unknown_reason 引用同一条事实，不自己编）',
      ));
    }
  }
  return evidenceRows;
}

// ─────────────────────────────────────────────────────────────────────────
// assumption 档的「队伍 × 体系」结构分：分母全部来自 RC-302 的登记字段
// ─────────────────────────────────────────────────────────────────────────

/**
 * 七个判据各自的**结构分**，每一项都只读 RC-302 缺口诊断里已登记的字段，
 * 分子 / 分母都是可复算计数（没有阈值、没有权重、没有拟合参数）：
 *
 *   coverage  `1 − Σ|weak_members| / Σ(|resisting|+|weak|+|neutral|+|unknown|)`（`coverage.unresisted.*`）
 *   synergy   `1 − summary.unanswered_weaknesses / summary.weaknesses_total`（`synergy.summary`）
 *   respond   `|variants_in_team_learnsets| / |RESPOND_VARIANTS|`（3 种应对，`respond.effect_unverified`）
 *   energy    `|{成员 : zero_cost_moves ≥ 1}| / |members|`（`energy.build_curve`）
 *   speed     `|distinct speed_tier| / |members|`（`speed.team_tiers`）
 *   pivot     `|members_with_tool_in_build| / |队伍成员|`（`pivot.tool_coverage`）
 *   cost      `validated_members / team_size`（`cost.build_support`）
 *
 * 缺任何一个字段 ⇒ `null`（**不猜、不用别的字段顶替**）⇒ 整条 assumption 分布 fail closed。
 * 这些分数是**结构描述**，不是对局结果：它们和胜负无关，只回答「这一队的这一环铺开了多少」。
 */
const CRITERION_SCORERS = Object.freeze({
  coverage: ({gaps, entry, members}) => {
    const rows = gaps.filter((gap) => gap?.dimension === 'coverage'
      && isNonEmptyString(gap?.id) && gap.id.startsWith('coverage.unresisted.'));
    const slots = rows.reduce((sum, gap) => sum + arr(gap.value?.resisting_members).length
      + arr(gap.value?.weak_members).length + arr(gap.value?.neutral_members).length
      + arr(gap.value?.unknown_members).length, 0);
    const weak = rows.reduce((sum, gap) => sum + arr(gap.value?.weak_members).length, 0);
    if (rows.length === 0) {
      // 一条 `coverage.unresisted.*` 都没有 = 每个已登记系别都有成员能接。这只有在**扫描确实跑过**时才算数。
      if (members.length === 0 || !(Number(entry?.facts?.registered_attack_types) > 0)) return null;
      return {value: 1, numerator: 0, denominator: 0, fields: ['facts.registered_attack_types'],
        gap_ids: [], note: '没有任何 coverage.unresisted 缺口 ⇒ 每个已登记系别都有成员能接（分子 0，分母 0）'};
    }
    if (slots === 0) return null;
    return {value: 1 - weak / slots, numerator: weak, denominator: slots,
      fields: ['coverage.unresisted.*.value.weak_members', 'coverage.unresisted.*.value.{resisting,neutral,unknown}_members'],
      gap_ids: rows.map((gap) => gap.id), note: '被克制成员数 / 全部成员槽位'};
  },
  synergy: ({gaps, entry}) => {
    const summary = gaps.find((gap) => gap?.id === 'synergy.summary')?.value ?? null;
    if (!isPlainObject(summary) || !(Number(summary.members_known) > 0)) return null;
    const total = Number(summary.weaknesses_total);
    const unanswered = Number(summary.unanswered_weaknesses);
    if (!Number.isFinite(total) || !Number.isFinite(unanswered) || total < 0 || unanswered < 0) return null;
    if (total === 0) {
      return {value: 1, numerator: 0, denominator: 0, fields: ['synergy.summary.value.weaknesses_total'],
        gap_ids: ['synergy.summary'], note: '全队没有任何弱点 ⇒ 没有「无人能接」的弱点（分子 0，分母 0）'};
    }
    // 独立复算：`synergy.unanswered_weakness.*` 的条数必须与 summary 里的数一致，否则不猜。
    const listed = gaps.filter((gap) => isNonEmptyString(gap?.id) && gap.id.startsWith('synergy.unanswered_weakness.')).length;
    if (listed !== unanswered) return null;
    return {value: 1 - unanswered / total, numerator: unanswered, denominator: total,
      fields: ['synergy.summary.value.unanswered_weaknesses', 'synergy.summary.value.weaknesses_total'],
      gap_ids: ['synergy.summary'], note: '无人能接的弱点数 / 弱点总数（与逐条缺口条数交叉核对过）'};
  },
  respond: ({gaps}) => {
    const row = gaps.find((gap) => gap?.id === 'respond.effect_unverified')?.value ?? null;
    const present = arr(row?.variants_in_team_learnsets).filter(isNonEmptyString);
    if (!isPlainObject(row) || !Array.isArray(row.variants_in_team_learnsets)) return null;
    const missing = gaps.filter((gap) => isNonEmptyString(gap?.id) && gap.id.startsWith('respond.variant_missing.')).length;
    if (missing + present.length !== RESPOND_VARIANTS.length) return null;
    return {value: present.length / RESPOND_VARIANTS.length, numerator: present.length,
      denominator: RESPOND_VARIANTS.length,
      fields: ['respond.effect_unverified.value.variants_in_team_learnsets'],
      gap_ids: ['respond.effect_unverified'], note: `学招表里有的应对种类 / ${RESPOND_VARIANTS.length} 种应对`};
  },
  energy: ({gaps}) => {
    const curve = gaps.find((gap) => gap?.id === 'energy.build_curve')?.value ?? null;
    const members = arr(curve?.members).filter((member) => Number.isFinite(member?.zero_cost_moves));
    if (!isPlainObject(curve) || members.length === 0) return null;
    const cheap = members.filter((member) => Number(member.zero_cost_moves) >= 1).length;
    return {value: cheap / members.length, numerator: cheap, denominator: members.length,
      fields: ['energy.build_curve.value.members[].zero_cost_moves'],
      gap_ids: ['energy.build_curve'], note: '四个技能里带 0 费技能的成员数 / 有 build 数据的成员数'};
  },
  speed: ({gaps}) => {
    const tiers = gaps.find((gap) => gap?.id === 'speed.team_tiers')?.value ?? null;
    const members = arr(tiers?.members).filter((member) => isNonEmptyString(member?.speed_tier));
    if (!isPlainObject(tiers) || members.length === 0) return null;
    const distinct = uniqueSorted(members.map((member) => member.speed_tier)).length;
    return {value: distinct / members.length, numerator: distinct, denominator: members.length,
      fields: ['speed.team_tiers.value.members[].speed_tier'],
      gap_ids: ['speed.team_tiers'], note: '速度档的种类数 / 有速度档的成员数（梯度铺开程度）'};
  },
  pivot: ({gaps, members}) => {
    const tools = gaps.find((gap) => gap?.id === 'pivot.tool_coverage')?.value ?? null;
    if (!isPlainObject(tools) || members.length === 0) return null;
    const inBuild = arr(tools.members_with_tool_in_build).length;
    return {value: inBuild / members.length, numerator: inBuild, denominator: members.length,
      fields: ['pivot.tool_coverage.value.members_with_tool_in_build'],
      gap_ids: ['pivot.tool_coverage'], note: '配招里带换入/离场手段的成员数 / 队伍成员数'};
  },
  cost: ({gaps}) => {
    const support = gaps.find((gap) => gap?.id === 'cost.build_support')?.value ?? null;
    if (!isPlainObject(support)) return null;
    const teamSize = Number(support.team_size);
    const validated = Number(support.validated_members);
    if (!(teamSize > 0) || !Number.isFinite(validated) || validated < 0) return null;
    return {value: validated / teamSize, numerator: validated, denominator: teamSize,
      fields: ['cost.build_support.value.validated_members', 'cost.build_support.value.team_size'],
      gap_ids: ['cost.build_support'], note: '有冻结配招数据的成员数 / 队伍规模'};
  },
});

export const STRUCTURAL_CRITERION_IDS = Object.freeze(Object.keys(CRITERION_SCORERS));

/** 一支队伍的七个结构分（缺一个就把它的 id 记进 `missing_criteria`，不猜）。 */
export function structuralCriteriaScores(team, gapsByTeam) {
  const teamId = teamLabel(team);
  const entry = isPlainObject(gapsByTeam) && teamId !== null ? gapsByTeam[teamId] : null;
  const members = memberKeys(team);
  const gaps = arr(entry?.gaps);
  if (!isPlainObject(entry) || gaps.length === 0 || members.length === 0) {
    return {ok: false, scores: {}, missing_criteria: [...STRUCTURAL_CRITERION_IDS],
      reason: FAIL_CLOSED_REASONS.NO_STRUCTURAL_SIGNAL, gaps_length: gaps.length};
  }
  const scores = {};
  const missing = [];
  for (const criterion of STRUCTURAL_CRITERION_IDS) {
    const scored = CRITERION_SCORERS[criterion]({gaps, entry, members});
    if (scored === null || !Number.isFinite(scored.value) || scored.value < 0 || scored.value > 1) {
      missing.push(criterion);
      continue;
    }
    scores[criterion] = {...scored, criterion, value: round(scored.value)};
  }
  return {ok: missing.length === 0, scores, missing_criteria: missing,
    reason: missing.length === 0 ? null : FAIL_CLOSED_REASONS.NO_STRUCTURAL_SIGNAL, gaps_length: gaps.length};
}

/**
 * 把「队伍 × 体系」的结构分填进分布：`relative_score` = 该体系**自己声明的**
 * `archetypes[].feature_axes[].criterion` 上结构分的等权均值；`tolerance` = 这些结构分里的最小值
 * （**结构短板**：面对这个体系时最先崩的一环，作为次优操作余量的下界代理）。
 *
 * 权重是等权，分母 = 该体系的 `feature_axes[].length`（体系自己声明的判据条数），
 * 所以每一个数都能被第三方从 `meta-prior/v1.json` + RC-302 重算出来。
 */
export function structuralScoresForTeam(team, gapsByTeam, metaPrior) {
  const base = structuralCriteriaScores(team, gapsByTeam);
  if (!base.ok) return {...base, archetypes: []};
  const prior = isPlainObject(metaPrior) ? metaPrior : {};
  const archetypes = arr(prior.archetypes);
  const rows = [];
  const problems = [];
  for (const entry of arr(prior.distribution)) {
    const archetypeId = entry?.archetype_id ?? null;
    const meta = archetypes.find((item) => item?.archetype_id === archetypeId) ?? null;
    const criteria = uniqueSorted(arr(meta?.feature_axes).map((axis) => axis?.criterion ?? axis?.axis)
      .filter(isNonEmptyString));
    if (meta === null || criteria.length === 0) {
      problems.push(`${archetypeId ?? '(无 archetype_id)'} 在 meta-prior 的 archetypes[] 里找不到 feature_axes`);
      continue;
    }
    const unavailable = criteria.filter((criterion) => !isPlainObject(base.scores[criterion]));
    if (unavailable.length > 0) {
      problems.push(`${archetypeId} 声明的判据 ${unavailable.join(' / ')} 没有结构分`);
      continue;
    }
    const values = criteria.map((criterion) => base.scores[criterion].value);
    rows.push({
      archetype_id: archetypeId,
      criteria,
      criterion_values: Object.fromEntries(criteria.map((criterion, index) => [criterion, values[index]])),
      relative_score: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      tolerance: round(Math.min(...values)),
      weakest_criterion: criteria[values.indexOf(Math.min(...values))],
      worst_criterion: criteria[values.indexOf(Math.min(...values))],
    });
  }
  if (problems.length > 0 || rows.length === 0) {
    return {...base, ok: false, archetypes: rows, problems,
      missing_criteria: uniqueSorted([...base.missing_criteria, ...problems])};
  }
  return {...base, ok: true, archetypes: rows, problems: []};
}

/** 把结构分挂到分布的行上（**只补 null 的字段**：注入方自己给的 relative_score / tolerance 优先）。 */
export function applyStructuralScores(distribution, structural) {
  const byId = new Map(arr(structural?.archetypes).map((row) => [row.archetype_id, row]));
  return {
    ...distribution,
    structural_used: true,
    entries: arr(distribution?.entries).map((row) => {
      const scored = byId.get(row.archetype_id) ?? null;
      if (scored === null) return row;
      return {
        ...row,
        relative_score: row.relative_score === null ? scored.relative_score : row.relative_score,
        tolerance: row.tolerance === null ? scored.tolerance : row.tolerance,
        structural: scored,
      };
    }),
  };
}


// ─────────────────────────────────────────────────────────────────────────
// 第五轴：coverage_confidence（唯一现在就能算的一轴）
// ─────────────────────────────────────────────────────────────────────────

const gapText = (gap) => `${gap?.id ?? ''} ${gap?.why ?? ''} ${stableJson(gap?.value ?? null)}`;
const GAP_UNKNOWN_PATTERN = /未核实|UNKNOWN|unknown/;
const gapHasEvidence = (gap) => arr(gap?.machine_evidence).length > 0
  && arr(gap?.machine_evidence).every((item) => isNonEmptyString(item?.source_file)
    && isNonEmptyString(item?.pointer) && isNonEmptyString(item?.field));

/**
 * 从 RC-302 的缺口里读「哪些成员有具体 build 数据」。
 *
 * 数据形状以 RC-302 的实际产出为准（**不自己另立一套**）：
 *   · `energy.build_curve.value.members[].key` = 有具体四个技能 build 的成员（实例登记键）；
 *   · `cost.build_support.value.validated_members` = **计数**（不是数组），
 *     `unvalidated_members` 是「在队里但没有冻结层配招数据」的成员。
 * 没有 build 的成员按 build_data = 0 计，绝不拿图鉴信息冒充「有 build」。
 */
function memberBuildsOf(gaps) {
  const energyBuilds = gaps.find((gap) => gap?.id === 'energy.build_curve');
  const buildKeys = uniqueSorted(arr(energyBuilds?.value?.members)
    .map((row) => row?.key).filter(isNonEmptyString));
  const cost = gaps.find((gap) => gap?.id === 'cost.build_support');
  const rawValidated = cost?.value?.validated_members;
  const validatedKeys = Array.isArray(rawValidated)
    ? uniqueSorted(rawValidated.map((row) => (typeof row === 'string' ? row : row?.key)).filter(isNonEmptyString))
    : [];
  const validatedCount = Number.isInteger(rawValidated) ? rawValidated : validatedKeys.length;
  const unvalidated = uniqueSorted(arr(cost?.value?.unvalidated_members)
    .map((row) => (typeof row === 'string' ? row : row?.key)).filter(isNonEmptyString));
  return {
    with_build: buildKeys,
    validated_keys: validatedKeys,
    validated_count: validatedCount,
    unvalidated,
    build_skills_present: buildKeys,
    source_pointer: energyBuilds ? 'energy.build_curve' : (cost ? 'cost.build_support' : null),
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
}

/**
 * 覆盖置信：**只**依赖 build 的规则与数据覆盖，不依赖对手分布，所以现在就能算。
 *
 * 三个可复算因子（都要能落到实例 / 行 / 缺口上）：
 *   · `criterion`  = 七维判据里，该队没有一条缺口被标 UNKNOWN 的维度比例；
 *   · `evidence`   = 带非空且字段齐全的 `machine_evidence[]` 的缺口比例；
 *   · `build_data` = 有具体 build 数据的成员比例（冻结迁移层 48 只口径，不拿 622 条图鉴冒充）。
 *
 * `value` 是**自描述**（我们知道自己知道多少），不是实力判断：`confidence` 取三个因子里最弱的那一档。
 */
export function coverageConfidence(team, gapsByTeam) {
  const teamId = teamLabel(team);
  const entry = isPlainObject(gapsByTeam) && teamId !== null ? gapsByTeam[teamId] : null;
  const gaps = arr(entry?.gaps);
  const members = memberKeys(team);

  if (!isPlainObject(entry) || gaps.length === 0) {
    return {
      axis: 'coverage_confidence',
      available: false,
      value: null,
      unit: null,
      unknown_reason: FAIL_CLOSED_REASONS.NO_GAP_DIAGNOSIS,
      evidence: [evidence(
        'injected:gapsByTeam', teamId === null ? 'gapsByTeam' : `gapsByTeam[${teamId}]`, 'gaps',
        gaps.length,
        '覆盖置信吃 RC-302 的缺口诊断：没有诊断就没有「哪些量是 UNKNOWN」这件事',
      )],
      confidence: 'UNKNOWN',
      unverified: [
        '未核实：本队的 build 覆盖 —— 没有注入 RC-302 的缺口诊断，覆盖置信 fail closed 而不是报 0',
      ],
      missing: ['gapsByTeam[team_id].gaps'],
    };
  }

  const dimensionsWithGaps = uniqueSorted(gaps.map((gap) => gap?.dimension).filter(isNonEmptyString));
  const unknownDimensions = uniqueSorted(gaps
    .filter((gap) => gap?.confidence === 'UNKNOWN' || GAP_UNKNOWN_PATTERN.test(gapText(gap)))
    .map((gap) => gap?.dimension).filter(isNonEmptyString));
  // `criterion` 用**缺口条数**的比例，不用维度个数：六个队都有同样的七个维度，
  // 按维度算会让所有队伍都得到同一个数——那样它就不是「这一队知道多少」的描述。
  // 逐条判「这一条缺口上有没有被台账标 UNKNOWN 的量」，再取比例。
  const unknownGapCount = gaps.filter((gap) => gap?.confidence === 'UNKNOWN'
    || GAP_UNKNOWN_PATTERN.test(gapText(gap))).length;
  const criterion = gaps.length === 0 ? 0 : round((gaps.length - unknownGapCount) / gaps.length);
  const evidenced = gaps.filter(gapHasEvidence).length;
  const evidenceScore = round(evidenced / gaps.length);
  const builds = memberBuildsOf(gaps);
  const membersWithoutBuild = members.filter((key) => !builds.with_build.includes(key));
  const buildData = members.length === 0 ? 0
    : round(members.filter((key) => builds.with_build.includes(key)).length / members.length);

  const parts = {criterion, evidence: evidenceScore, build_data: buildData};
  const value = round((criterion + evidenceScore + buildData) / 3);
  const weakest = Object.keys(parts).sort((a, b) => (parts[a] - parts[b])
    || (a < b ? -1 : 1))[0];
  const rank = Math.min(
    CONFIDENCE_RANK.COMMUNITY_CURRENT,
    CONFIDENCE_RANK.ENGINE_HYPOTHESIS + (parts[weakest] >= 0.5 ? 1 : 0),
  );
  const confidence = CONFIDENCE_LEVELS.find((level) => CONFIDENCE_RANK[level] === rank) ?? 'ENGINE_HYPOTHESIS';

  const unverified = [
    '未核实：全量 622 只的 build 覆盖 —— 冻结迁移层只有 48 只（RC-302 的域上限），其余只能是 unknown',
  ];
  if (unknownDimensions.length > 0) {
    unverified.push(`未核实：${unknownDimensions.join(' / ')} 维度里有被台账标 UNKNOWN 的量`
      + `（共 ${unknownGapCount} / ${gaps.length} 条缺口），已按条数计入覆盖置信的扣分`);
  }
  if (membersWithoutBuild.length > 0) {
    unverified.push(`未核实：成员 ${membersWithoutBuild.join(' / ')} 没有具体 build 数据`
      + '（RC-302 的 energy.build_curve 里没有它们的 key），已按 build_data = 0 计入扣分');
  }
  if (builds.unvalidated.length > 0) {
    unverified.push(`未核实：诊断点名了 ${builds.unvalidated.join(' / ')} 缺冻结层配招数据，已计入扣分`);
  }
  const insufficient = gaps.filter((gap) => !gapHasEvidence(gap)).map((gap) => gap?.id);
  if (insufficient.length > 0) {
    unverified.push(`未核实：缺口 ${insufficient.join(' / ')} 的机器证据字段不齐，已计入扣分`);
  }
  if (!gaps.some((gap) => gap?.id === 'cost.build_support')) {
    unverified.push('未核实：诊断里没有 cost.build_support 这条，成员 build 覆盖按 0 计（不猜）');
  }

  return {
    axis: 'coverage_confidence',
    available: true,
    value,
    unit: RELATIVE_UNIT,
    unknown_reason: null,
    value_parts: parts,
    weakest_part: weakest,
    evidence: [
      evidence('injected:gapsByTeam', `gapsByTeam[${teamId}].gaps`, 'length', gaps.length,
        '覆盖置信的输入是 RC-302 的缺口诊断条数'),
      evidence('injected:gapsByTeam', `gapsByTeam[${teamId}].gaps[].confidence`, 'dimensions_with_unknown',
        unknownDimensions, '台账标 UNKNOWN 的维度：这些量我们**不知道**，必须计入扣分'),
      evidence('injected:gapsByTeam', `gapsByTeam[${teamId}].gaps[].machine_evidence`, 'gaps_with_evidence',
        evidenced, '带完整机器证据的缺口条数'),
      evidence('injected:gapsByTeam',
        builds.source_pointer === null ? 'gapsByTeam' : `gapsByTeam[${teamId}].${builds.source_pointer}`,
        'members_with_build', builds.with_build,
        `有具体 build 数据的成员登记键（RC-302 的 cost.build_support 记 validated_members = `
        + `${builds.validated_count} 只；其余成员按 build_data = 0 计，不猜）`),
    ],
    confidence,
    unverified,
    missing: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 前四轴：没有分布就 fail closed，有 measured 分布就真的算
// ─────────────────────────────────────────────────────────────────────────

const axisRow = (team, axisId, gapsByTeam) => (axisId === 'coverage_confidence'
  ? coverageConfidence(team, gapsByTeam)
  : null);

/** 把逐体系相对表现折成一轴的 `value`（**只有** measured 分布才走到这里）。 */
export function compareAxisValues(axisId, distribution) {
  const rows = distribution.entries.filter((row) => row.relative_score !== null);
  const totalWeight = distribution.weights.reduce((sum, weight) => sum + weight, 0);
  if (rows.length === 0 || totalWeight <= 0) return null;
  switch (axisId) {
    case 'environment_value': {
      const weighted = distribution.entries.reduce((sum, row) => (row.relative_score === null
        ? sum : sum + row.relative_score * distribution.weights[row.index]), 0);
      return round(weighted / totalWeight);
    }
    case 'worst_archetype': {
      const sorted = [...rows].sort((a, b) => (a.relative_score - b.relative_score)
        || ((a.archetype_id ?? '') < (b.archetype_id ?? '') ? -1 : 1));
      const worst = sorted[0];
      return {
        archetype_id: worst.archetype_id,
        label: worst.label,
        relative_score: round(worst.relative_score),
        weight: round(distribution.weights[worst.index]),
      };
    }
    case 'matchup_spread': {
      const scores = rows.map((row) => row.relative_score);
      return round(Math.max(...scores) - Math.min(...scores));
    }
    case 'execution_tolerance': {
      const withTolerance = distribution.entries.filter((row) => row.tolerance !== null);
      if (withTolerance.length === 0) return null;
      const toleranceWeight = withTolerance.reduce((sum, row) => sum + distribution.weights[row.index], 0);
      if (toleranceWeight <= 0) return null;
      const weighted = withTolerance.reduce((sum, row) => sum
        + row.tolerance * distribution.weights[row.index], 0);
      return round(weighted / toleranceWeight);
    }
    default:
      return null;
  }
}

function axisUnit(axisId) {
  switch (axisId) {
    case 'environment_value': return RELATIVE_UNIT;
    case 'execution_tolerance': return RELATIVE_UNIT;
    case 'matchup_spread': return SPREAD_UNIT;
    case 'worst_archetype': return '体系（archetype_id + 该体系在环境里的权重 0～1 + 它的相对分 0～1）';
    default: return null;
  }
}

const axisValueNumbers = (axisId) => {
  switch (axisId) {
    case 'environment_value': return [valueNumber('value', RELATIVE_UNIT)];
    case 'execution_tolerance': return [valueNumber('value', RELATIVE_UNIT)];
    case 'matchup_spread': return [valueNumber('value', SPREAD_UNIT)];
    case 'worst_archetype': return [valueNumber('relative_score', RELATIVE_UNIT), valueNumber('weight', SHARE_UNIT)];
    default: return [valueNumber('value', RELATIVE_UNIT)];
  }
};

function singleAxis(axisId, team, metaPrior, gapsByTeam) {
  const axis = AXIS_BY_ID[axisId];
  const teamId = teamLabel(team);

  if (axisId === 'coverage_confidence') {
    const row = axisRow(team, axisId, gapsByTeam);
    return {
      ...row,
      axis: axisId,
      prior_field: axis.prior_field,
      label: axis.label,
      unit: row.available ? row.unit : null,
      value_numbers: row.available ? [valueNumber('value', RELATIVE_UNIT)] : [],
      definition: axis.definition,
    };
  }

  const distribution = resolveDistribution(metaPrior);
  const base = {
    axis: axisId,
    prior_field: axis.prior_field,
    label: axis.label,
    definition: axis.definition,
    unit: axisUnit(axisId),
    value_numbers: axisValueNumbers(axisId),
  };

  if (distribution.kind === 'unknown') {
    return {
      ...base,
      available: false,
      value: null,
      unknown_reason: distribution.reason,
      evidence: distribution.evidence,
      confidence: 'UNKNOWN',
      unverified: [
        `未核实：${axis.label} —— 分布 ${distribution.kind}，缺 ${distribution.missing.join(' / ') || '可核对来源'}`
          + '（细节见 unknown_reason 与 evidence[]）',
      ],
      missing: distribution.missing,
      value_mask: null,
      distribution_kind: distribution.kind,
      team_id: teamId,
    };
  }

  // assumption 档：占比只是**分母**（声明假设），相对表现由本模块按体系自己声明的判据
  // 从 RC-302 结构性地算。缺任何一个判据的输入就整轴 fail closed——不拿别的数据顶替、不给 0。
  const structural = distribution.kind === 'assumption'
    ? structuralScoresForTeam(team, gapsByTeam, metaPrior) : null;
  if (structural !== null && !structural.ok) {
    const detail = [...structural.missing_criteria].slice(0, 8).join(' / ');
    return {
      ...base,
      available: false,
      value: null,
      unknown_reason: `${FAIL_CLOSED_REASONS.NO_STRUCTURAL_SIGNAL}（缺：${detail || 'gapsByTeam'}）`,
      evidence: [...distribution.evidence, evidence(
        'injected:gapsByTeam', teamId === null ? 'gapsByTeam' : `gapsByTeam[${teamId}].gaps`, 'gaps',
        structural.gaps_length,
        'assumption 档的结构分只读 RC-302 已登记的缺口字段；这里缺口诊断没到位，所以不给数',
      )],
      confidence: 'UNKNOWN',
      unverified: [`未核实：${axis.label} —— 占比到位了（声明假设），但结构分算不出来：${detail}`],
      missing: structural.missing_criteria.length > 0 ? structural.missing_criteria : ['gapsByTeam[team_id].gaps'],
      value_mask: null,
      distribution_kind: distribution.kind,
      structural_ok: false,
      team_id: teamId,
    };
  }
  const effective = structural === null ? distribution : applyStructuralScores(distribution, structural);

  const value = compareAxisValues(axisId, effective);
  if (value === null) {
    const reason = axisId === 'execution_tolerance'
      ? FAIL_CLOSED_REASONS.NO_EXECUTION_SAMPLE : FAIL_CLOSED_REASONS.NO_RELATIVE_SCORE;
    return {
      ...base,
      available: false,
      value: null,
      unknown_reason: reason,
      evidence: effective.evidence,
      confidence: 'UNKNOWN',
      unverified: [`未核实：${axis.label} —— 分布是 ${effective.kind}，但${reason}`],
      missing: [axisId === 'execution_tolerance' ? 'distribution[].tolerance' : 'distribution[].relative_score'],
      distribution_kind: effective.kind,
      team_id: teamId,
    };
  }

  const bootstrap = effective.evidence.some((item) => typeof item.note === 'string'
    && item.note.includes('ENGINE_HYPOTHESIS'));
  const structuralUsed = structural !== null && structural.ok;
  const structuralEvidence = structuralUsed ? [
    evidence('data/roco/meta-prior/v1.json', 'archetypes[].feature_axes[].criterion', 'criterion',
      uniqueSorted(structural.archetypes.flatMap((row) => row.criteria)),
      'assumption 档下相对表现的**权重来源**：每个体系按它自己声明的判据等权（分母 = feature_axes[].length），'
      + '本模块不另设权重表'),
    ...structural.archetypes.map((row) => evidence(
      'injected:gapsByTeam', teamId === null ? 'gapsByTeam' : `gapsByTeam[${teamId}].gaps`, 'dimension',
      {...row.criterion_values, relative_score: row.relative_score, tolerance: row.tolerance},
      `体系 ${row.archetype_id} 的结构分：判据 ${row.criteria.join(' / ')} 各自 0～1（分子 / 分母见 `
      + '`structuralCriteriaScores()` 的判据表），等权均值为相对分，最小值为**结构短板**（= tolerance）',
    )),
    evidence('injected:gapsByTeam', teamId === null ? 'gapsByTeam' : `gapsByTeam[${teamId}].gaps`, 'machine_evidence',
      structural.scores ? Object.fromEntries(Object.entries(structural.scores)
        .map(([criterion, scored]) => [criterion, {numerator: scored.numerator, denominator: scored.denominator,
          gaps: scored.gap_ids, fields: scored.fields}])) : null,
      '每个结构分的分子 / 分母 / 依据缺口（全部是 RC-302 的登记计数；这一档的置信等级是 ENGINE_HYPOTHESIS）'),
  ] : [];
  return {
    ...base,
    available: true,
    value,
    unknown_reason: null,
    evidence: [
      ...effective.evidence,
      ...structuralEvidence,
      evidence('injected:metaPrior.distribution[]', 'distribution[].relative_score',
        axisId === 'worst_archetype' ? 'min(relative_score)'
          : (axisId === 'matchup_spread' ? 'max(relative_score) - min(relative_score)'
            : (axisId === 'execution_tolerance' ? 'Σ(tolerance × weight) / Σweight' : 'Σ(relative_score × weight) / Σweight')),
        value,
        '值来自注入分布：权重 = distribution[].value（占比），逐条可对账；'
        + (structuralUsed ? '相对分 / 容错这一档是 RC-302 结构分（ENGINE_HYPOTHESIS），不是对局测量' : '')
        + '如果权重是等权回落，另见 weight_mode'),
      evidence('injected:metaPrior.distribution[]', 'distribution[].value', 'weight_mode', effective.weight_mode,
        effective.weight_mode === 'value' ? '权重直接用注入的占比值'
          : '注入分布没有给占比值，四轴按逐体系等权回落并在 unverified 点名'),
    ],
    confidence: (structuralUsed || bootstrap) ? 'ENGINE_HYPOTHESIS' : 'CROSS_SOURCE_SUPPORTED',
    unverified: structuralUsed ? [
      '未核实：这一档的**占比**是声明假设（均匀铺在已识别体系上），不是实测版本分布；'
        + '相对分是**结构分**（RC-302 的登记计数按体系自己声明的判据合成），不是对局结果，也不是任何胜负结论',
      '未核实：容错这一档用的是**结构短板**（该体系判据里的最小结构分），是次优操作余量的下界代理；'
        + '真的「次优操作下掉多少」要离线回放 / 联赛采样，本仓一次都没跑过',
      '替换通道：拿到带 url / 仓内文件 + 日期 + 台账等级的来源后，把先验的 `distribution[].source` 改成 '
        + '`measured` 并给出 `relative_score` / `tolerance`（measured 通路已就位，值优先用注入的那份）',
      ...(effective.weight_mode === 'value' ? []
        : ['未核实：环境占比 —— 注入分布没有 value，四轴按逐体系等权回落']),
    ] : [
      '未核实：相对表现本身的正确性 —— 它来自注入的离线产物（league / matchup bank），'
        + '本仓现在**没有**这份产物；这条通路是为了让「分布到位后接口是活的」这件事可验证',
      ...(effective.weight_mode === 'value' ? []
        : ['未核实：环境占比 —— 注入分布没有 value，四轴按逐体系等权回落']),
    ],
    missing: [],
    distribution_kind: effective.kind,
    // 结构分的可对账形状抬到轴上来（与 coverage_confidence 的 value_parts 同一个理由）：
    // 只报一个数，读的人没法核它是怎么来的。
    structural_basis: structuralUsed ? {
      kind: effective.entries[0]?.basis?.kind ?? null,
      denominator: effective.entries[0]?.basis?.denominator ?? null,
      recomputable_from: effective.entries[0]?.basis?.recomputable_from ?? null,
      criteria: uniqueSorted(structural.archetypes.flatMap((row) => row.criteria)),
      per_archetype: Object.fromEntries(structural.archetypes.map((row) => [row.archetype_id, {
        criteria: row.criteria, criterion_values: row.criterion_values,
        relative_score: row.relative_score, tolerance: row.tolerance,
      }])),
    } : null,
    team_id: teamId,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 五轴比较
// ─────────────────────────────────────────────────────────────────────────

/** 判据正文里的 `[严格]` / `[弱]` 标签是给审计读的，比较结构里统一剥掉（判据只有一份）。 */
const stripCriterionTags = (text) => String(text ?? '').replace(/\[(严格|弱)\]/gu, '');

/** 四轴的判据文本按**档位**（unknown / assumption / measured）选，三档各有一条判据。 */
const AXIS_TIER_CRITERIA = Object.freeze({
  unknown: STRUCTURAL_CRITERIA.distribution_fail_closed,
  assumption: `${STRUCTURAL_CRITERIA.assumption_needs_basis} ${STRUCTURAL_CRITERIA.assumption_structural_scores}`,
  measured: STRUCTURAL_CRITERIA.measured_lights_up,
});
const tierCriterionFor = (kind) => AXIS_TIER_CRITERIA[kind] ?? AXIS_TIER_CRITERIA.unknown;

const AXIS_CRITERIA_TEXT = Object.freeze({
  // 四轴的判据文本**随档位变**（unknown / assumption / measured 三档各一条），
  // 由 `compareTeams()` 里的 `axisCriterion()` 按注入分布的档位选，这里只留覆盖置信这一条固定判据。
  coverage_confidence: STRUCTURAL_CRITERIA.coverage_from_build,
});

/**
 * 五轴比较。**在线路径**：只读注入数据，不调引擎、不起进程、不看时钟。
 *
 * 每一轴是**自包含**的（`{value, unit, available, unknown_reason, evidence[], confidence, unverified[]}`），
 * 既可以直接读那一轴的形状，也可以往下读两个分视角：
 *   · 队伍视角：`axis.teams[team_id]` = 该队在这一轴上的值；
 *   · 比较视角：`axis.comparison` = `{delta, winner, why, criterion}`（**不排名**，只说哪一边在这一轴上更有利）。
 * `axis.value` 是三态：`null`（unknown）| 数值（可用且**两队在该轴上同值**）| 比较结构 `{criterion, delta, winner}`。
 *
 * @param {object} input
 * @param {object} input.teamA          队伍 A（`{team_id, members:[{key}]}`）
 * @param {object} input.teamB          队伍 B
 * @param {object} input.metaPrior      版本环境先验（`meta-prior/v1.json` 或同形注入）
 * @param {object} [input.gapsByTeam]   `team_id → RC-302 诊断`（覆盖置信的唯一输入）
 * @param {object} [input.ranker]       版本化排序器（没有就 `missing`，如实降级）
 */
export function compareTeams({teamA, teamB, metaPrior, gapsByTeam = {}, ranker = null} = {}) {
  const distribution = resolveDistribution(metaPrior);
  const ranker_ = resolveRanker(ranker);
  // 判据文本随**这一档输入**走：unknown 档的判据是 fail closed，assumption 档的判据是
  // 「带 basis 的声明假设 + 结构分」，measured 档的判据是「注入值必须真的被用上」。
  const tierCriterion = tierCriterionFor(distribution.kind);
  const axisCriterion = (axisId) => (axisId === 'coverage_confidence'
    ? STRUCTURAL_CRITERIA.coverage_from_build : tierCriterion);
  const axes = {};
  for (const axis of AXES) {
    const a = singleAxis(axis.id, teamA, metaPrior, gapsByTeam);
    const b = singleAxis(axis.id, teamB, metaPrior, gapsByTeam);
    // 「这一轴可比较」= 两队的**输入**都在，且至少一边真的给出了值（value === null 是 unknown，不是 0）。
    const bothAvailable = a.available === true && b.available === true
      && (a.value !== null || b.value !== null);
    const sameValue = bothAvailable && stableJson(a.value) === stableJson(b.value);
    const comparisonRaw = compareAxisValuesForAxis(axis.id, a, b, tierCriterion);
    const comparison = sameValue
      ? {...comparisonRaw,
        value: {criterion: stripCriterionTags(axisCriterion(axis.id)), delta: 0, winner: null},
        delta: 0, winner: null}
      : comparisonRaw;
    // worst_archetype 的**值本身**就是一个对象（`{archetype_id, relative_score, weight}`），
    // 不能把「两队不同」时的比较结构直接塞进 `value`——那会与「同值」时的对象撞形。
    // 所以这一轴的 `value` 永远是那个对象（取更差的一边），差值只在 `comparison` / `value.delta` 里。
    const worstArchetypeObject = bothAvailable
      ? (a.value.relative_score <= b.value.relative_score ? a.value : b.value) : null;
    axes[axis.id] = {
      axis: axis.id,
      prior_field: axis.prior_field,
      label: axis.label,
      definition: axis.definition,
      available: bothAvailable,
      // `value` 的三态按轴的性质分：
      //   · `worst_archetype` 的**值本身就是对象** ⇒ 永远是那个对象（取更差的一边），差值只在 comparison 里；
      //   · `coverage_confidence` 是**自我描述的一个数** ⇒ 取两队的下界（较保守的那一边），不是比较结构；
      //   · 其余数值轴：同值就是那个数，不同值给比较结构（`comparison` 里有同样的 delta / winner）。
      value: !bothAvailable ? null
        : (axis.id === 'worst_archetype'
          ? {...worstArchetypeObject, criterion: stripCriterionTags(axisCriterion(axis.id)),
            structural: axisCriterion(axis.id)}
          : (axis.id === 'coverage_confidence'
            ? Math.min(Number(a.value), Number(b.value))
            : (sameValue ? a.value : comparison.value))),
      unit: bothAvailable ? a.unit : null,
      value_numbers: bothAvailable ? a.value_numbers : [],
      unknown_reason: bothAvailable ? null : (a.available ? b.unknown_reason : a.unknown_reason),
      evidence: [...a.evidence, ...b.evidence],
      confidence: bothAvailable
        ? (CONFIDENCE_RANK[a.confidence] <= CONFIDENCE_RANK[b.confidence] ? a.confidence : b.confidence)
        : 'UNKNOWN',
      unverified: [...a.unverified, ...b.unverified],
      missing: uniqueSorted([...arr(a.missing), ...arr(b.missing)]),
      // 覆盖置信是**自我描述**：把可对账的分项与最弱因子抬到这一轴上来（两队的都留，不合并），
      // 否则 `available:true` 的轴只剩一个数，读的人没法核对它是怎么来的。
      value_parts: bothAvailable ? {[teamLabel(teamA) ?? 'teamA']: a.value_parts ?? null,
        [teamLabel(teamB) ?? 'teamB']: b.value_parts ?? null} : null,
      weakest_part: bothAvailable && isPlainObject(a.value_parts) && isPlainObject(b.value_parts)
        ? {[teamLabel(teamA) ?? 'teamA']: a.weakest_part ?? null,
          [teamLabel(teamB) ?? 'teamB']: b.weakest_part ?? null} : null,
      // 分布档位与结构分依据也抬上来（同样是「只报一个数没法对账」的理由）：
      // 页面要能一眼看出「这个数是**声明假设的分母** × RC-302 的结构分」，而不是实测环境分布。
      distribution_kind: bothAvailable ? (a.distribution_kind ?? b.distribution_kind ?? null) : null,
      structural_basis: bothAvailable
        ? {[teamLabel(teamA) ?? 'teamA']: a.structural_basis ?? null,
          [teamLabel(teamB) ?? 'teamB']: b.structural_basis ?? null} : null,
      comparison,
      teams: {
        [teamLabel(teamA) ?? 'teamA']: publicTeamAxis(a),
        [teamLabel(teamB) ?? 'teamB']: publicTeamAxis(b),
      },
      criteria: stripCriterionTags(axisCriterion(axis.id)),
    };
  }
  const availability = Object.fromEntries(AXIS_IDS.map((axisId) => [axisId, axes[axisId].available]));
  return {
    schema: 'roco-team-compare/v1',
    axes,
    axis_order: AXIS_IDS,
    availability,
    available_axis_count: AXIS_IDS.filter((axisId) => axes[axisId].available).length,
    unknown_axis_count: AXIS_IDS.filter((axisId) => !axes[axisId].available).length,
    distribution: {
      kind: distribution.kind,
      declared_source: distribution.declared_source,
      entries: distribution.entries.length,
      weight_mode: distribution.weight_mode,
      weight_sum: distribution.weight_sum,
      partition_ok: distribution.partition_ok,
      missing: distribution.missing,
      reason: distribution.reason,
      // 逐体系 relative_score / tolerance 的**作用域**：measured 档它们在分布里（离线联赛产物）；
      // assumption 档先验只带占比，相对分是**队伍级**结构分（看 `axes[*].structural_basis`），
      // 所以这里如实写 null + 作用域，不把队伍级的东西塞进版本先验（先验只带占比）。
      relative_score_scope: distribution.kind === 'measured' ? 'distribution-level（注入分布自带）'
        : (distribution.kind === 'assumption' ? 'team-level（见 axes[*].structural_basis）' : null),
      basis: distribution.entries[0]?.basis === undefined || distribution.entries[0]?.basis === null ? null : {
        kind: distribution.entries[0].basis.kind ?? null,
        denominator: distribution.entries[0].basis.denominator ?? null,
        recomputable_from: distribution.entries[0].basis.recomputable_from ?? null,
        replace_with: distribution.entries[0].basis.replace_with ?? null,
      },
      archetypes: distribution.entries.map((row) => ({
        archetype_id: row.archetype_id, source: row.source, value: row.value,
        relative_score: row.relative_score, tolerance: row.tolerance,
      })),
    },
    ranker: ranker_,
    online_path: {
      engine_calls: 0,
      subprocess_calls: 0,
      note: '在线比较只读注入数据：不跑模拟、不调引擎、不起进程（结构判据扫源码，见 ONLINE_SECTION_MARKER）',
    },
    no_win_rate: true,
    unverified: [
      '未核实：任何**胜率 / 强度分** —— 13 号文档 §4 的五个口径都不是胜率，本模块也不产出胜率',
      '未核实：相对表现的绝对含义 —— 0～1 的相对分只在**同一份注入分布**内可比（谁高谁低），不是「赢多少」',
      ...(distribution.kind === 'measured' ? [
        '未核实：注入分布的来源真实性 —— 本模块只检查「有没有 url / 仓内文件 + 日期」，不联网核对',
      ] : []),
      ...(distribution.kind === 'assumption' ? [
        '未核实：四轴的**分母**是声明假设（均匀铺在已识别体系上，逐条带 basis，可复算、可替换），'
          + '不是实测版本分布；相对分 / 容错是 RC-302 的**结构分**（ENGINE_HYPOTHESIS），不是对局结果，也不预测胜负',
      ] : []),
    ],
  };
}

/** 对外暴露的单队单轴投影：去掉内部输入，只留可对账的部分。 */
const publicTeamAxis = (row) => ({
  team_id: row.team_id,
  available: row.available,
  value: row.value,
  unit: row.unit ?? null,
  value_numbers: arr(row.value_numbers),
  weakest_part: row.weakest_part ?? null,
  value_parts: row.value_parts ?? null,
  unknown_reason: row.unknown_reason,
  confidence: row.confidence,
  unverified: row.unverified,
  missing: arr(row.missing),
});

function compareAxisValuesForAxis(axisId, a, b, tierCriterion = STRUCTURAL_CRITERIA.distribution_fail_closed) {
  // 四轴的判据文本随档位走（unknown / assumption / measured），由 `compareTeams()` 传进来；
  // 覆盖置信不吃分布，判据固定。
  const criterion = stripCriterionTags(axisId === 'coverage_confidence'
    ? AXIS_CRITERIA_TEXT.coverage_confidence : tierCriterion);
  const structural = axisId === 'coverage_confidence'
    ? STRUCTURAL_CRITERIA.coverage_from_build : tierCriterion;
  if (!a.available || !b.available) {
    return {
      available: false,
      value: null,
      delta: null,
      winner: null,
      unknown_reason: a.available ? b.unknown_reason : a.unknown_reason,
      criterion,
      structural,
      why: `不比较：两轴里至少一轴的${axisId === 'coverage_confidence' ? ' build 覆盖数据' : '版本对手分布'}没到位，`
        + '所以不给「谁更好」（不返回 0，也不给「差不多」）',
    };
  }
  if (axisId === 'worst_archetype') {
    const aScore = a.value.relative_score;
    const bScore = b.value.relative_score;
    const delta = round(aScore - bScore);
    if (delta === 0) {
      return {
        available: true, value: {criterion, delta: 0, winner: null}, delta, winner: null, criterion, structural,
        why: `最吃亏的体系相同（都是 ${a.value.archetype_id}，相对分相同）：不给「谁更好」`,
      };
    }
    const winner = delta > 0 ? b.team_id : a.team_id;
    return {
      available: true,
      value: {criterion, delta, winner},
      delta,
      winner,
      criterion,
      structural,
      why: `最吃亏的体系相对分：${a.team_id} ${a.value.archetype_id} = ${aScore}，`
        + `${b.team_id} ${b.value.archetype_id} = ${bScore}；相对分只在**同一份注入分布**内可比，不是对胜负的预测`,
    };
  }
  const delta = round(a.value - b.value);
  if (delta === 0) {
    return {
      available: true, value: {criterion, delta: 0, winner: null}, delta: 0, winner: null, criterion, structural,
      why: '两队在**这一份注入分布**上的值相同：不给「谁更好」（相同 ≠ 差不多，是同一个数）',
    };
  }
  const higherIsBetter = axisId !== 'matchup_spread';
  const winner = (delta > 0) === higherIsBetter ? a.team_id : b.team_id;
  return {
    available: true,
    value: {criterion, delta, winner},
    delta,
    winner,
    criterion,
    structural,
    why: `${axisId} 的差 = ${a.team_id} − ${b.team_id} = ${delta}；`
      + `${axisId === 'matchup_spread' ? '离散度越小越不依赖撞到特定阵容' : '相对分越高越好'}，`
      + '相对分只在**同一份注入分布**内可比，不是对胜负的预测',
  };
}

/** 排序器状态：没有注入 / 形状不对就如实说 `missing` / `invalid`，不假装有。 */
export function resolveRanker(ranker) {
  if (ranker === null || ranker === undefined) {
    return {
      status: 'missing',
      ranker_id: null,
      reason: '没有注入版本化 Team Ranker 产物（13 号文档 §5.1 的离线链路还没产出标签）：'
        + '比较退化成注入分布上的相对分，排序不可用',
      criteria: STRUCTURAL_CRITERIA.distribution_fail_closed,
    };
  }
  const hasId = isNonEmptyString(ranker.ranker_id);
  const calibrated = ranker.calibrated === true;
  const usable = hasId && typeof ranker.compare === 'function';
  return {
    status: usable ? (calibrated ? 'ready' : 'invalid') : 'invalid',
    ranker_id: ranker.ranker_id ?? null,
    calibrated,
    reason: usable
      ? (calibrated ? '注入的 ranker 自称已校准' : '注入的 ranker 没有标 calibrated，按 invalid 处理（不假装它校准过）')
      : '注入的 ranker 缺 ranker_id 或 compare：形状不对就是 invalid，不猜',
    criteria: STRUCTURAL_CRITERIA.distribution_fail_closed,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 最小替换：恰好一个方案，分布 unknown 时只说结构理由
// ─────────────────────────────────────────────────────────────────────────

const uncoveredTypesOf = (entry) => uniqueSorted(arr(entry?.gaps)
  .filter((gap) => gap?.dimension === 'coverage' && isNonEmptyString(gap?.value?.attack_type))
  .map((gap) => gap.value.attack_type));

const unansweredByMember = (entry) => {
  const counts = new Map();
  for (const gap of arr(entry?.gaps)) {
    if (gap?.dimension !== 'synergy' || !isNonEmptyString(gap?.id)) continue;
    if (!gap.id.startsWith('synergy.unanswered_weakness.')) continue;
    const member = gap?.value?.member;
    if (!isNonEmptyString(member)) continue;
    counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  return counts;
};

/** 候选能补上哪些「全队没人接」的攻击系别：读候选自己声明的 `covers_types`，不自己算第二套属性表。 */
const candidateCovers = (candidate, uncovered) => uniqueSorted(arr(candidate?.covers_types)
  .filter((type) => uncovered.includes(type)));

const candidateKey = (candidate) => candidate?.candidate_key ?? candidate?.species_id ?? candidate?.instance_id ?? null;

const candidateBuildPresence = (candidate) => (candidate?.has_build === true
  || (isPlainObject(candidate?.axes) && Number.isFinite(candidate.axes.coverage_confidence)));

/**
 * 最小替换（13 号文档 §6 的「一个最小替换方案」）。
 *
 * 判据：
 *   · **恰好一个**方案：`out` 一只、`in` 一只（一次替换 = 一个槽位，见 13 号文档 §6 的渐进推荐）；
 *   · `why` 必须点名**哪一轴**改善，`evidence[]` 必须逐条指向注入数据；
 *   · 分布 unknown 时**不许**判「哪个更好」：`confirmed_by_distribution: false`，
 *     `why` 只写结构理由（例如补上没人能接的弱点），并显式说「不知道换谁更强」。
 */
export function minimalReplacement({team, metaPrior, candidates = [], gapsByTeam = {}} = {}) {
  const teamId = teamLabel(team);
  const entry = isPlainObject(gapsByTeam) && teamId !== null ? gapsByTeam[teamId] : null;
  const distribution = resolveDistribution(metaPrior);
  const gaps = arr(entry?.gaps);
  const uncovered = uncoveredTypesOf(entry);
  const counts = unansweredByMember(entry);
  const members = memberKeys(team);

  const evidenceRows = [
    evidence('injected:gapsByTeam', teamId === null ? 'gapsByTeam' : `gapsByTeam[${teamId}].gaps`, 'length', gaps.length,
      '最小替换的结构输入是 RC-302 的缺口诊断'),
    evidence('data/roco/meta-prior/v1.json', 'distribution[]', 'kind', distribution.kind,
      distribution.kind === 'measured'
        ? '注入分布是 measured：可以按注入分布判「哪一边更好」'
        : '注入分布是 unknown：**不能**据此判哪个候选更好，只能给结构理由（fail closed）'),
  ];

  if (members.length === 0) {
    return {
      schema: 'roco-minimal-replacement/v1',
      team_id: teamId,
      replacement: null,
      confirmed_by_distribution: false,
      why: '队伍里一个成员都没有：没有可换下的槽位，所以不给替换方案（不编一个假方案）',
      evidence: evidenceRows,
      confidence: 'UNKNOWN',
      unverified: ['未核实：任何替换收益 —— 没有成员就没有结构基线'],
      criteria: STRUCTURAL_CRITERIA.one_replacement,
    };
  }

  const ranked = arr(candidates)
    .map((candidate) => {
      const covers = candidateCovers(candidate, uncovered);
      const builds = candidateBuildPresence(candidate);
      return {candidate, covers, builds, key: candidateKey(candidate)};
    })
    .filter((row) => isNonEmptyString(row.key))
    .sort((a, b) => (b.covers.length - a.covers.length)
      || ((a.key < b.key) ? -1 : 1));

  // 换下谁：优先换「贡献最多无人承接弱点」的那只；没有 synergy 明细时用字典序最小的成员（确定性 tie-break）。
  const memberOrder = [...members].sort((a, b) => ((counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    || (a < b ? -1 : 1));
  const out = memberOrder[0];

  const best = ranked[0] ?? null;
  if (best === null || best.covers.length === 0) {
    const structural = uncovered.length > 0
      ? `注入的候选里没有一只声明能接住队里无人承接的 ${uncovered.join(' / ')}：给不出一个能改结构的最小替换`
      : '注入的候选里没有一只声明了可对接的系别（covers_types）：给不出一个**可归因**的最小替换';
    return {
      schema: 'roco-minimal-replacement/v1',
      team_id: teamId,
      replacement: null,
      confirmed_by_distribution: false,
      why: `${structural}。结构理由之外的结论（换谁更强）现在**没有**依据：`
        + `${distribution.kind === 'measured' ? '分布是 measured 但候选没有可对接的结构声明' : '版本对手分布是 unknown'}，`
        + '所以这里明确说不知道，不编一个「更优」结论',
      evidence: [...evidenceRows,
        evidence('injected:candidates', 'candidates[].covers_types', 'count', 0,
          `注入候选 ${arr(candidates).length} 个，无人承接弱点 ${uncovered.length} 个（${uncovered.join(' / ') || '无'}）`)],
      confidence: 'UNKNOWN',
      unverified: [
        '未核实：哪个候选更好 —— 候选没有结构声明（covers_types）或没有可对接的缺口，本模块不替它编一个',
      ],
      criteria: STRUCTURAL_CRITERIA.one_replacement,
    };
  }

  const measured = distribution.kind === 'measured';
  const whyParts = [
    `结构理由（可复算计数，不是强度判断）：把 ${out} 换成 ${best.key}，`
      + `它声明能接住队里现在**没有人接**的 ${best.covers.join(' / ')}（${best.covers.length} 个）`,
  ];
  if (best.builds) {
    whyParts.push('这一只还有具体 build 数据 ⇒ 覆盖置信（coverage_confidence）不会因为换它而降档');
  } else {
    whyParts.push('注入里这一只没有标 build 数据 ⇒ 换它不会改善覆盖置信，所以 why 不把 coverage_confidence 算成收益');
  }
  if (measured) {
    whyParts.push('分布是 measured：收益判据按注入分布，但本模块只给**一个**最小替换方案，不做多方案排序');
  } else {
    whyParts.push('版本对手分布是 unknown：**不知道**换谁在这个版本里更强，这里的「换它」只因为它补的是结构缺口；'
      + '不返回「更优」结论、不给收益数值');
  }

  return {
    schema: 'roco-minimal-replacement/v1',
    team_id: teamId,
    candidate_universe_size: arr(candidates).length,
    replacement: {
      out: {key: out, unanswered_weaknesses: counts.get(out) ?? 0},
      in: {key: best.key, covers_types: best.covers, has_build: best.builds},
    },
    why: whyParts.join('；'),
    why_axes: measured
      ? ['coverage_confidence', ...(best.builds ? [] : []), 'environment_value（仅按注入分布，不做多方案）']
      : ['coverage_confidence'],
    confirmed_by_distribution: measured,
    evidence: [...evidenceRows,
      evidence('injected:gapsByTeam', `gapsByTeam[${teamId}].gaps`, 'uncovered_attack_types', uncovered,
        `队里没有任何成员有抗性的攻击系别（来自 RC-302 的 coverage 缺口）`),
      evidence('injected:gapsByTeam', `gapsByTeam[${teamId}].gaps`, 'unanswered_weaknesses_by_member',
        Object.fromEntries([...counts.entries()].sort()), '换下谁的可复算依据：每人贡献的「无人承接弱点」条数'),
      evidence('injected:candidates', 'candidates[].covers_types', 'covers_types', best.covers,
        `候选 ${best.key} 声明的可对接系别与队里缺口求交集的结果`),
      evidence('injected:candidates', 'candidates[].has_build', 'has_build', best.builds,
        '这一只有没有具体 build 数据（决定覆盖置信会不会降档）'),
    ],
    confidence: 'ENGINE_HYPOTHESIS',
    unverified: [
      '未核实：替换后的实际表现 —— 这是一次**结构**替换建议，本仓没有对局数据可以证明它更好',
      ...(measured ? [] : ['未核实：哪个替换更优 —— 版本对手分布 unknown，本模块明确说不知道，不编「更优」结论']),
    ],
    criteria: STRUCTURAL_CRITERIA.one_replacement,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 审计：把每条纪律变成机器判据（必红方向）
// ─────────────────────────────────────────────────────────────────────────

/** 伪精确 / 榜单禁令：这些键与词不许出现在产出里（与 RC-303 同一份语义）。 */
export const BANNED_CLAIM_KEYS = Object.freeze([
  'win_rate', 'winrate', 'win_probability', 'win_rate_smoothed', 'strength_score', 'power_score',
  'rank_score', 'tier', 'rating', 'elo', 'meta_share', 'usage_rate', 'pick_rate', 'ban_rate',
  '胜率', '强度分', '期望值', '评分',
]);
export const BANNED_CLAIM_WORDS = Object.freeze([
  'T0', 'T1', 'T2', 'T3', 'S级', 'A级', 'B级', '强势', '必带', '梯队', '幻神', '超模', '版本之子', '上分首选',
  '胜率', '强度分', '强度值', '期望值', '差不多',
]);
/** 被禁止的**量纲**：`value_numbers[].unit` 里出现这些词，等于把相对分伪装成概率。 */
export const BANNED_UNIT_WORDS = Object.freeze(['胜率', '概率', '百分比', '%']);

export const NEGATION_MARKERS = Object.freeze([
  '不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '不是伪', '而非', '绝非', '不知道',
]);

/**
 * 「最弱因子」的声明形状：单队时是一个因子名（字符串），比较两支队时是
 * `{team_id: 因子名}`（两队的都留，不合并成一个）。两种都算声明过。
 */
const weakestPartDeclared = (value) => isNonEmptyString(value)
  || (isPlainObject(value) && Object.keys(value).length > 0
    && Object.values(value).every((item) => isNonEmptyString(item)));

/**
 * 否定语境：窗口取命中点**前 18 个字符**。
 *
 * 为什么是 18 而不是 RC-303 的 12：本模块的值承载字段里会出现「相同 ≠ 差不多」「不预测胜负」
 * 这类更长的声明边界句，12 个字会把「这**不是**差不多」也判红——判据一旦逼着实现方
 * 删掉「我不产出这种东西」这句话，它就把最该留的那句删了。
 * 判据仍然有牙：直接写「这套的胜率是 62%」前面没有任何否定词，照样红。
 */
function isNegatedClaim(text, at) {
  const window = String(text).slice(Math.max(0, at - 18), at);
  return NEGATION_MARKERS.some((marker) => window.includes(marker));
}

function collectBannedText(value, path, hits, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const word of BANNED_CLAIM_WORDS) {
      const at = value.indexOf(word);
      if (at < 0 || isNegatedClaim(value, at)) continue;
      hits.push({code: 'PSEUDO_PRECISION', path, word, text: value.slice(0, 120)});
    }
    const pct = value.match(/%/);
    if (pct && /(胜|概率|强|率|覆盖)/.test(value) && !isNegatedClaim(value, pct.index)) {
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
}

/**
 * 量纲的禁令：`unit` / `value_numbers[].unit` 里出现被禁词或百分号就是「把相对分伪装成概率」。
 * 判据是**结构**的（`BANNED_UNIT_WORDS` + 字面 `%`），所以审计既扫产出也扫被改坏的产出。
 */
export const unitProblems = (unit) => (typeof unit !== 'string' ? []
  : [...(unit.includes('%') ? ['%'] : []),
    ...BANNED_UNIT_WORDS.filter((word) => unit.includes(word))]);

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
 * 伪精确扫描的范围：**每一轴的完整字段**（含 `value` / `unit` / `value_numbers` / `unknown_reason` /
 * `comparison` / `teams` / `unverified` / `missing`）+ 分布 + 最小替换，**只排除两样**：
 *
 *   · `definition`：口径的**定义**（「对版本对手分布的期望表现」这句话本身没有数字）；
 *   · `criteria`  / `structural_criteria`：判据正文，它必须能写出「本模块不产出胜率」这类
 *     **声明边界**的句子——整份扫会把最该保留的那句话判红
 *     （RC-302/303 用否定语境处理这件事，这里用范围 + 否定语境两条一起用）。
 *
 * 关键是：**键名检查不受豁免**。所以「把胜率藏在一个自定义键里」照样红——那是必红方向 ③ 的核心。
 */
const CLAIM_EXCLUDED_FIELDS = Object.freeze([
  'definition', 'criteria', 'structural_criteria',
  // 比较结构里的 criterion / structural 是**判据文本的两份引用副本**，不是结论：
  // 扫它们等于扫判据正文本身（而判据正文必须能写「这不是胜率」）。
  'criterion', 'structural',
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

/** 从一份产出里抽出「要按伪精确判据扫」的字段。 */
export function collectClaimText(result) {
  const out = {};
  const compare = result?.compare;
  if (isPlainObject(compare)) {
    out.axes = withoutExcluded(compare.axes ?? null);
    out.distribution = withoutExcluded(compare.distribution ?? null);
    out.ranker = withoutExcluded(compare.ranker ?? null);
    out.unverified = compare.unverified ?? null;
    out.no_win_rate = compare.no_win_rate ?? null;
    out.online_path = withoutExcluded(compare.online_path ?? null);
  }
  const replacement = result?.replacement;
  if (isPlainObject(replacement)) {
    out.replacement = withoutExcluded({
      why: replacement.why ?? null,
      why_axes: replacement.why_axes ?? null,
      replacement: replacement.replacement ?? null,
      unverified: replacement.unverified ?? null,
      confirmed_by_distribution: replacement.confirmed_by_distribution ?? null,
    });
  }
  return out;
}

/** 扫描的**口径**：默认只扫在线段——离线段允许读盘、允许子进程。 */
export const SCAN_SCOPES = Object.freeze(['online', 'whole']);

const sourceText = (source, scope) => (typeof source !== 'string' ? null
  : (scope === 'online' ? onlineSectionOf(source) : source));

/**
 * 审计一份产出（`compareTeams()` / `minimalReplacement()` 的返回值）**或**把正确产出改坏后的版本。
 * 每条判据都有必红方向，测试逐条改坏、必须变红，并把实际输出原文打出来。
 *
 * @param {object} result  `{compare, replacement}`（或其被改坏的版本）
 * @param {object} [options]
 * @param {string} [options.source]  `src/coach/team-compare.mjs` 的源码（结构判据）
 * @param {string} [options.scope]   扫描口径（默认 `online`）
 * @param {object} [options.snapshot] 同一输入第二次运行的结果（确定性判据）
 * @param {string} [options.text]    渲染文本（伪精确判据连同它一起扫）
 */
export function auditTeamCompare(result, options = {}) {
  const problems = [];
  const push = (code, where, detail) => problems.push(auditProblem(code, where, detail));
  const scope = SCAN_SCOPES.includes(options.scope) ? options.scope : 'online';
  const compare = result?.compare ?? null;
  const replacement = result?.replacement ?? null;

  // ── ① 五轴形状 + 可用性 ──
  if (!isPlainObject(compare) || !isPlainObject(compare.axes)) {
    push('AXIS_SHAPE', 'compare.axes', '缺 axes：五轴比较必须逐轴给出 {value, unit, available, unknown_reason, evidence, confidence, unverified}');
  } else {
    for (const axisId of AXIS_IDS) {
      const axis = compare.axes[axisId];
      const where = `compare.axes.${axisId}`;
      if (!isPlainObject(axis)) {
        push('AXIS_SHAPE', where, `缺 ${axisId} 这一轴`);
        continue;
      }
      for (const field of ['value', 'unit', 'available', 'unknown_reason', 'evidence', 'confidence', 'unverified']) {
        if (!(field in axis)) push('AXIS_SHAPE', `${where}.${field}`, `缺字段 ${field}`);
      }
      if (typeof axis.available !== 'boolean') {
        push('AXIS_SHAPE', `${where}.available`, `available 必须是布尔，实际 ${stableJson(axis.available)}`);
      }
      if (!Array.isArray(axis.evidence) || axis.evidence.length === 0) {
        push('EVIDENCE_MISSING', `${where}.evidence`, '轴没有 evidence[]：没有证据的结论不许出现');
      } else if (axis.evidence.some((item) => !item?.source_file || !item?.pointer || !item?.field)) {
        push('EVIDENCE_MISSING', `${where}.evidence`, '证据项缺 source_file / pointer / field');
      } else if (axis.evidence.some((item) => typeof item.source_file === 'string'
        && /^injected:/u.test(item.source_file))) {
        // 注入来源合法；但**不允许**引用一个既不是注入也不是仓内真实文件的东西——由测试另行核对。
      }
      if (!CONFIDENCE_LEVELS.includes(axis.confidence)) {
        push('CONFIDENCE_NOT_IN_LEDGER', `${where}.confidence`, `confidence ${stableJson(axis.confidence)} 不在台账六级里`);
      }
      if (!Array.isArray(axis.unverified)) {
        push('EVIDENCE_MISSING', `${where}.unverified`, '轴缺 unverified[]');
      }

      const hasValue = axis.value !== null && axis.value !== undefined;
      const numeric = typeof axis.value === 'number';
      if (axis.available === true && !hasValue) {
        push('AVAILABILITY_SHAPE', `${where}.value`,
          'available:true 却给了 null：算不出来就 available:false + unknown_reason，不许用 null 充当「已知」');
      }
      if (axis.available === false) {
        if (hasValue) {
          push('UNKNOWN_AXIS_HAS_VALUE', `${where}.value`,
            `available:false 却给了值 ${stableJson(axis.value)}：unknown 不许拿一个数（含 0）顶替`);
        }
        if (numeric) {
          push('UNKNOWN_AXIS_HAS_VALUE', `${where}.value`, `available:false 却给了数值 ${axis.value}`);
        }
        if (arr(axis.value_numbers).length > 0) {
          push('UNKNOWN_AXIS_HAS_VALUE', `${where}.value_numbers`,
            'available:false 却声明了量纲：没有值就没有量纲');
        }
        if (!isNonEmptyString(axis.unknown_reason)) {
          push('AVAILABILITY_SHAPE', `${where}.unknown_reason`, 'available:false 必须点名缺什么（unknown_reason）');
        }
        if (axis.confidence !== 'UNKNOWN') {
          push('CONFIDENCE_NOT_IN_LEDGER', `${where}.confidence`,
            `available:false 的轴 confidence 只能是 UNKNOWN，实际 ${stableJson(axis.confidence)}`);
        }
      }
      if (axis.available === true) {
        if (!isPlainObject(axis.value) && !Number.isFinite(axis.value)) {
          push('AVAILABILITY_SHAPE', `${where}.value`,
            `available:true 的轴必须给数值型 value 或比较结构，实际 ${stableJson(axis.value)}`);
        }
        // 覆盖置信的 value 是一**个数**（自我描述），不是比较结构：null 在这里就是「没有值」。
        if (axisId === 'coverage_confidence' && !Number.isFinite(axis.value)) {
          push('AVAILABILITY_SHAPE', `${where}.value`,
            `覆盖置信声称可用，value 却不是有限数（实际 ${stableJson(axis.value)}）：`
            + '算不出来就必须 available:false + unknown_reason，null 不许冒充「已知」');
        }
        const comparison = axis.comparison;
        if (isPlainObject(axis.value) && axis.value.criterion !== undefined) {
          const criterion = stripCriterionTags(axis.criteria);
          const structural = axis.value.structural ?? null;
          if (axis.value.criterion !== criterion && axis.value.criterion !== axis.criteria
            && axis.value.criterion !== structural) {
            push('AVAILABILITY_SHAPE', `${where}.value.criterion`,
              '比较结构里的 criterion 必须与该轴的判据文本**同源**（判据只有一份）：'
              + `实际 ${stableJson(axis.value.criterion)}，轴判据 ${stableJson(criterion)}，结构性判据 ${stableJson(structural)}`);
          }
        }
        if (isPlainObject(comparison) && Number.isFinite(axis.value?.delta)
          && (comparison.delta !== axis.value.delta || comparison.winner !== axis.value.winner)) {
          push('AVAILABILITY_SHAPE', `${where}.comparison`,
            'axis.value 与 axis.comparison 的 delta / winner 必须一致（同一个比较只有一份结论）：'
            + `value=${stableJson({delta: axis.value.delta, winner: axis.value.winner})} `
            + `comparison=${stableJson({delta: comparison.delta, winner: comparison.winner})}`);
        }
        // 量纲检查对**两个量纲字段**做：`unit` 与 `value_numbers[].unit` 都不许把相对分伪装成概率。
        for (const [where2, unit] of [['unit', axis.unit],
          ...arr(axis.value_numbers).map((number, index) => [`value_numbers[${index}].unit`, number?.unit])]) {
          // 默认口径是「值承载字段」——**可用轴的数字就是值**；`auditTeamCompare(mutated)` 这种
          // 「把正确产出改坏」的场景没有产出源码，所以额外把轴上的两个量纲字段也扫一遍。
          for (const word of unitProblems(unit)) {
            push('PSEUDO_PRECISION', `${where}.${where2}`,
              `量纲里出现被禁止的词 ${stableJson(word)}（${stableJson(unit)}）：`
              + '本模块不产出胜率 / 概率 / 百分数');
          }
        }
        if (axisId === 'coverage_confidence' && (!isPlainObject(axis.value_parts)
          || !weakestPartDeclared(axis.weakest_part))) {
          push('COVERAGE_NOT_FROM_BUILD', `${where}`,
            '覆盖置信声称可用，却没有 value_parts / weakest_part：它必须能指到自己最弱的那个因子');
        }
      }
      for (const number of arr(axis.value_numbers)) {
        for (const word of BANNED_UNIT_WORDS) {
          if (typeof number?.unit === 'string' && number.unit.includes(word)) {
            push('PSEUDO_PRECISION', `${where}.value_numbers`,
              `量纲里出现被禁止的词 ${word}（${stableJson(number.unit)}）：本模块不产出胜率 / 概率 / 百分数`);
          }
        }
      }
      if (isPlainObject(axis.comparison) && axis.comparison.winner !== null
        && typeof axis.comparison.delta !== 'number') {
        push('AVAILABILITY_SHAPE', `${where}.comparison.delta`, '有 winner 就必须有数值型 delta');
      }
    }

    // ── ② measured 必须真的点亮前四轴（反向控制） ──
    const distributionKind = compare?.distribution?.kind ?? 'unknown';
    const measuredEntries = arr(compare?.distribution?.archetypes)
      .filter((row) => row?.value !== null && row?.value !== undefined && row?.relative_score !== null).length;
    if (distributionKind === 'measured') {
      if (measuredEntries === 0) {
        push('MEASURED_NOT_WIRED', 'compare.distribution',
          '分布标了 measured，却没有任何一条带 value + relative_score：这份「measured」是空的');
      }
      for (const axisId of DISTRIBUTION_AXES) {
        const axis = compare.axes[axisId];
        if (isPlainObject(axis) && axis.available !== true) {
          push('MEASURED_NOT_WIRED', `compare.axes.${axisId}`,
            `注入的分布是 measured，这一轴却仍然 unknown（${stableJson(axis.unknown_reason)}）：`
            + 'fail closed 不许写成「永远 unknown」');
        }
      }
    }
    // 反向：unknown 分布下前四轴必须全部 unknown
    if (distributionKind === 'unknown') {
      for (const axisId of DISTRIBUTION_AXES) {
        const axis = compare.axes[axisId];
        if (isPlainObject(axis) && axis.available === true) {
          push('UNKNOWN_AXIS_HAS_VALUE', `compare.axes.${axisId}`,
            `分布是 ${distributionKind}，这一轴却 available:true：没有分布就没有期望`);
        }
      }
    }
    // ③ assumption 档：有可复算分母 ⇒ 前四轴必须真的算出来，且必须带队伍级结构依据。
    // 「声明假设 + 结构分」与「恒 unknown」都不许冒充对方：一个是在骗人，一个是把能算的写成算不出来。
    if (distributionKind === 'assumption') {
      for (const axisId of DISTRIBUTION_AXES) {
        const axis = compare.axes[axisId];
        if (!isPlainObject(axis) || axis.available !== true) {
          push('NO_STRUCTURAL_SIGNAL', `compare.axes.${axisId}`,
            `分布是 assumption（逐条带 basis 的可复算分母），这一轴却 unknown`
            + `（${stableJson(axis?.unknown_reason ?? null)}）：能算的必须算出来，缺结构输入才允许 fail closed`);
          continue;
        }
        if (axis.confidence !== 'ENGINE_HYPOTHESIS') {
          push('STRUCTURAL_BASIS_MISSING', `compare.axes.${axisId}.confidence`,
            `assumption 档的结构分必须以 ENGINE_HYPOTHESIS 出账，实际 ${stableJson(axis.confidence)}`);
        }
        if (!isPlainObject(axis.structural_basis)
          || !Object.values(axis.structural_basis).some((basis) => isPlainObject(basis?.per_archetype))) {
          push('STRUCTURAL_BASIS_MISSING', `compare.axes.${axisId}.structural_basis`,
            'assumption 档的轴必须带 structural_basis（逐体系的判据、分子 / 分母与重算入口）；'
            + '只给一个数，读的人没法对账');
        }
      }
    }
  }

  // ── ③ 在线段不许出现引擎 / 子进程调用 ──
  const section = sourceText(options.source, scope);
  if (typeof section === 'string') {
    for (const hit of scanForbiddenPatterns(section)) {
      push(hit.code, `src/coach/team-compare.mjs:${hit.line}（scanned=${scope}）`,
        `出现 ${hit.pattern}：${hit.detail}（实际源码 ${stableJson(hit.text)}）`);
    }
    if (scope === 'online') {
      for (const entry of OFFLINE_ENTRYPOINTS) {
        if (section.includes(entry.id)) {
          push('OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION', 'src/coach/team-compare.mjs',
            `离线入口 ${entry.id} 出现在在线段里：离线与在线入口必须分开导出`);
        }
      }
    }
  }

  // ── ④ 最小替换：恰好一个方案 + 必须带 why ──
  if (replacement !== null && replacement !== undefined) {
    const shape = replacement.replacement;
    if (shape === null) {
      if (!isNonEmptyString(replacement.why)) {
        push('REPLACEMENT_SHAPE', 'replacement.why', '给不出方案时必须写清为什么（why 不许为空）');
      }
      if (!Array.isArray(replacement.evidence) || replacement.evidence.length === 0) {
        push('EVIDENCE_MISSING', 'replacement.evidence', '给不出方案也要有 evidence[]');
      }
    } else if (Array.isArray(shape)) {
      push('REPLACEMENT_SHAPE', 'replacement.replacement',
        `最小替换必须**恰好一个**方案，实际返回了 ${shape.length} 个：多方案是排序，不是「最小替换」`);
    } else if (isPlainObject(shape)) {
      const outCount = Array.isArray(shape.out) ? shape.out.length : (shape.out ? 1 : 0);
      const inCount = Array.isArray(shape.in) ? shape.in.length : (shape.in ? 1 : 0);
      if (outCount !== 1 || inCount !== 1) {
        push('REPLACEMENT_SHAPE', 'replacement.replacement',
          `一次替换必须换掉**恰好一只**、换成**恰好一只**，实际 out=${outCount} in=${inCount}`);
      }
      if (!isNonEmptyString(shape.out?.key) || !isNonEmptyString(shape.in?.key)) {
        push('REPLACEMENT_SHAPE', 'replacement.replacement', 'out / in 都必须点名具体成员（key）');
      }
      if (!isNonEmptyString(replacement.why)) {
        push('REPLACEMENT_SHAPE', 'replacement.why', '替换方案必须带非空 why（哪一轴改善 / 为什么给不出）');
      }
      if (!Array.isArray(replacement.evidence) || replacement.evidence.length === 0) {
        push('EVIDENCE_MISSING', 'replacement.evidence', '替换方案没有 evidence[]');
      }
      const declaredKind = result?.compare?.distribution?.kind ?? 'unknown';
      if (declaredKind !== 'measured' && replacement.confirmed_by_distribution !== false) {
        push('REPLACEMENT_OVERCLAIM', 'replacement.confirmed_by_distribution',
          `分布是 ${declaredKind} 却宣称替换结论已由分布确认：分布 unknown 时不许判「哪个更好」`);
      }
      if (declaredKind !== 'measured' && !/不知道|没有依据|不判/u.test(String(replacement.why))) {
        push('REPLACEMENT_OVERCLAIM', 'replacement.why',
          '分布 unknown 时 why 必须明说「不知道换谁更强」，只给结构理由；实际 why 里没有这句话');
      }
    } else {
      push('REPLACEMENT_SHAPE', 'replacement.replacement', 'replacement 段形状不对');
    }
  }

  // ── ⑤ 伪精确：只扫**值承载字段** + 渲染文本 ──
  const hits = [];
  collectBannedText(collectClaimText({compare, replacement}), 'claims', hits);
  if (typeof options.text === 'string') {
    for (const word of BANNED_CLAIM_WORDS) {
      const at = options.text.indexOf(word);
      if (at >= 0 && !isNegatedClaim(options.text, at)) {
        hits.push({code: 'PSEUDO_PRECISION', path: 'text', word, text: options.text.slice(0, 120)});
      }
    }
    const pct = options.text.match(/%/);
    if (pct && /(胜|概率|强|率|覆盖)/.test(options.text) && !isNegatedClaim(options.text, pct.index)) {
      hits.push({code: 'PSEUDO_PRECISION', path: 'text', word: '%（伪精确百分数）', text: options.text.slice(0, 120)});
    }
  }
  for (const hit of hits) push(hit.code, hit.path, `出现 ${hit.word}：${stableJson(hit.text)}`);

  // ── ⑥ 覆盖置信必须来自 build：两次运行必须一致 ──
  if (isPlainObject(compare?.axes?.coverage_confidence)) {
    const axis = compare.axes.coverage_confidence;
    if (axis.available === true && !weakestPartDeclared(axis.weakest_part)) {
      push('COVERAGE_NOT_FROM_BUILD', 'compare.axes.coverage_confidence.weakest_part',
        '覆盖置信必须给出最弱因子（它是自我描述，要能指到具体因子）');
    }
    if (axis.available === true && !isPlainObject(axis.value_parts)) {
      push('COVERAGE_NOT_FROM_BUILD', 'compare.axes.coverage_confidence.value_parts',
        '覆盖置信必须给出可对账的分项（criterion / evidence / build_data）');
    }
  }

  // ── ⑦ 确定性 ──
  if (options.snapshot !== undefined) {
    // 渲染文本也参与对照，但**只有快照真的带了 text 才比**：调用方常常只做「两次纯函数调用」，
    // 没必要为了确定性判据再渲染一遍文本。
    const pairs = [['compare', compare, options.snapshot?.compare ?? null],
      ['replacement', replacement, options.snapshot?.replacement ?? null]];
    if (typeof options.text === 'string' && typeof options.snapshot?.text === 'string') {
      pairs.push(['text', options.text, options.snapshot.text]);
    }
    for (const [where, first, second] of pairs) {
      if (stableJson(first) !== stableJson(second)) {
        push('NONDETERMINISTIC', `compareTeams/minimalReplacement:${where}`,
          `同一输入两次运行的 JSON.stringify 不一致（含 tie-break）：`
          + `${stableJson(first).slice(0, 160)} vs ${stableJson(second).slice(0, 160)}`);
      }
    }
  }

  return {ok: problems.length === 0, problems};
}

// ─────────────────────────────────────────────────────────────────────────
// 人读的短结论：只是措辞，不新增任何数值
// ─────────────────────────────────────────────────────────────────────────

/** 数值文本：`0.5`（**不加百分号**，本模块不产出百分数）。 */
export const formatRelative = (value) => (Number.isFinite(value) ? String(round(value)) : 'unknown');

/**
 * 把比较渲染成短结论。**只重排已有字段**，不新增数值、不写胜率。
 */
export function renderCompareText(result) {
  const lines = [];
  const availability = result?.availability ?? {};
  lines.push(`五轴可用性：${AXIS_IDS.map((axisId) => `${axisId}=${availability[axisId] ? 'available' : 'unknown'}`).join(' / ')}`);
  for (const axisId of AXIS_IDS) {
    const axis = result?.axes?.[axisId];
    if (!axis) continue;
    if (axis.available) {
      const comparison = axis.comparison ?? {};
      lines.push(`${axisId}：${comparison.winner === null || comparison.winner === undefined
        ? '两队在这一份注入分布上相同（不排名）'
        : `更有利的是 ${comparison.winner}（差 ${formatRelative(comparison.delta)}，相对分，不是胜率）`}`);
    } else {
      lines.push(`${axisId}：unknown —— ${axis.unknown_reason}`);
    }
  }
  const replacement = result?.replacement?.replacement ?? null;
  lines.push(replacement === null
    ? '最小替换：给不出（见 why）'
    : `最小替换（恰好一个）：换下 ${replacement.out.key}，换上 ${replacement.in.key}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// 离线段：读盘 / 报告 / 对照样例（在线路径不许调用这里的任何入口）
// ─────────────────────────────────────────────────────────────────────────

/** 离线段从此开始（审计的分界线）。 */
export const OFFLINE_SECTION_MARKER = '<!-- OFFLINE-SECTION-BEGIN -->';

/**
 * 构造一份 `measured` 分布的**对照样例**：证明「分布到位后前四轴会亮」，不是恒 unknown。
 *
 * 它是**构造**的，不是测出来的：`measured: false` 会写进每一条来源的 note，
 * 报告里也明确写「这是接线的对照样例，不是版本数据」。**不许**把它当版本环境先验用。
 */
export function buildMeasuredDistributionSample({archetypes = [], note = null} = {}) {
  const rows = arr(archetypes).map((row, index) => ({
    archetype_id: row.archetype_id ?? `sample_archetype_${index}`,
    label: row.label ?? null,
    source: 'measured',
    value: Number.isFinite(row.value) ? Number(row.value) : null,
    relative_score: Number.isFinite(row.relative_score) ? Number(row.relative_score) : null,
    tolerance: Number.isFinite(row.tolerance) ? Number(row.tolerance) : null,
    sources: [{
      ref: row.ref ?? 'injected:rc-304-control-sample',
      date: row.date ?? '2026-09-21',
      note: note ?? '**对照样例**（constructed sample）：它不是版本数据，只用来证明「分布到位后接口是活的」',
      measured: false,
    }],
  }));
  return {
    schema: 'roco-meta-prior/v1',
    meta_prior_id: 'roco-meta-prior/rc304-control-sample#constructed',
    distribution_source: 'measured',
    distribution: rows,
    note: '本对象是 **RC-304 的接线对照样例**：源数据是构造的（每条 sources[].measured = false），'
      + '只用于验证 fail closed 不是「永远 unknown」。任何把它当版本环境先验的做法都越过了它的边界。',
  };
}

/**
 * 离线：读盘加载 RC-302 的诊断输入（与 `loadTeamGapsInputs` 同源，不复制第二套读盘逻辑）。
 * **在线路径不许调用**（`OFFLINE_ENTRYPOINTS` 钉住这一点）。
 */
export async function loadTeamCompareInputs({root = null, cache = true} = {}) {
  const {loadTeamGapsInputs} = await import('./team-gaps.js');
  return loadTeamGapsInputs({root, cache});
}

/** 离线：对一支队伍跑一遍 RC-302 诊断，再挂到 `gapsByTeam` 上。 */
export function diagnoseForCompare(teamId, request, inputs) {
  return {[teamId]: diagnoseTeamGaps(request, inputs)};
}

const reportVerdict = (label, criteria, actual, ok) => ({label, criteria, actual, ok});

/** 报告里的一支队伍：只留评审要看的东西，逐条带证据。 */
const reportTeam = (team, gapsByTeam) => {
  const entry = gapsByTeam[team?.team_id] ?? null;
  return {
    team_id: team?.team_id ?? null,
    members: memberKeys(team),
    member_count: memberKeys(team).length,
    ok: entry?.ok ?? null,
    gap_count: arr(entry?.gaps).length,
    dimension_unknown_counts: DIMENSION_UNKNOWN_COUNTS(entry),
    coverage_confidence: coverageConfidence(team, gapsByTeam),
    dimension_gap_counts: DIMENSION_GAP_COUNTS(entry),
    uncovered_attack_types: uncoveredTypesOf(entry),
    unanswered_weaknesses: Object.fromEntries([...unansweredByMember(entry).entries()].sort()),
    criteria: STRUCTURAL_CRITERIA.coverage_from_build,
  };
};

const DIMENSION_UNKNOWN_COUNTS = (entry) => {
  const counts = {};
  for (const gap of arr(entry?.gaps)) {
    if (!isNonEmptyString(gap?.dimension)) continue;
    if (gap?.confidence !== 'UNKNOWN' && !GAP_UNKNOWN_PATTERN.test(gapText(gap))) continue;
    counts[gap.dimension] = (counts[gap.dimension] ?? 0) + 1;
  }
  return Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));
};

const DIMENSION_GAP_COUNTS = (entry) => {
  const counts = {};
  for (const gap of arr(entry?.gaps)) {
    if (!isNonEmptyString(gap?.dimension)) continue;
    counts[gap.dimension] = (counts[gap.dimension] ?? 0) + 1;
  }
  return Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));
};

/**
 * 生成 `rc-304-team-compare.json` 的内容。
 *
 * 纯函数：同一份输入两次调用逐字节相同（没有挂钟字段、没有随机数）。
 *
 * @param {object} input
 * @param {object} input.inputs       `loadTeamCompareInputs()` 的返回值（RC-302 诊断输入）
 * @param {object} input.metaPrior    版本环境先验（磁盘上的 `meta-prior/v1.json`）
 * @param {Array}  input.teams        `[{team_id, request, team}]`
 * @param {Array}  input.pairings     至少 6 组 `[teamIdA, teamIdB]`
 * @param {Array}  input.candidates   注入的候选（供最小替换用）
 * @param {object} [input.measured]   `buildMeasuredDistributionSample()` 的产物（对照样例）
 * @param {string} [input.source]     `src/coach/team-compare.mjs` 的源码（结构判据）
 */
export function buildRc304Report(input) {
  const {
    inputs, metaPrior, teams = [], pairings = [], candidates = [],
    measured = null, source = null, ranker = null, red_proofs = [],
  } = input ?? {};

  const gapsByTeam = {};
  const teamRecords = [];
  for (const row of teams) {
    const diagnosis = diagnoseTeamGaps(row.request, inputs);
    gapsByTeam[row.team_id] = diagnosis;
    teamRecords.push(reportTeam({team_id: row.team_id, members: row.team?.members}, gapsByTeam));
  }

  const pairRows = pairings.map(([teamIdA, teamIdB]) => {
    const teamARef = {team_id: teamIdA, members: teams.find((row) => row.team_id === teamIdA)?.team?.members ?? []};
    const teamBRef = {team_id: teamIdB, members: teams.find((row) => row.team_id === teamIdB)?.team?.members ?? []};
    const comparison = compareTeams({teamA: teamARef, teamB: teamBRef, metaPrior, gapsByTeam, ranker});
    const replacement = minimalReplacement({team: teamARef, metaPrior, candidates, gapsByTeam});
    // 确定性判据：同一输入再跑一遍（**两个函数都跑**），逐字节对照。
    const second = compareTeams({teamA: teamARef, teamB: teamBRef, metaPrior, gapsByTeam, ranker});
    const secondReplacement = minimalReplacement({team: teamARef, metaPrior, candidates, gapsByTeam});
    const text = renderCompareText({...comparison, replacement});
    const secondText = renderCompareText({...second, replacement: secondReplacement});
    const audit = auditTeamCompare({compare: comparison, replacement}, {
      source, snapshot: {compare: second, replacement: secondReplacement, text: secondText}, text,
    });
    return {
      teams: [teamIdA, teamIdB],
      availability: comparison.availability,
      unknown_reasons: Object.fromEntries(AXIS_IDS
        .filter((axisId) => !comparison.availability[axisId])
        .map((axisId) => [axisId, comparison.axes[axisId].unknown_reason])),
      values: Object.fromEntries(AXIS_IDS.map((axisId) => [axisId,
        comparison.axes[axisId].available ? comparison.axes[axisId].value : null])),
      comparison_winners: Object.fromEntries(AXIS_IDS.map((axisId) => [axisId,
        comparison.axes[axisId].comparison?.winner ?? null])),
      minimal_replacement: replacement.replacement,
      minimal_replacement_why: replacement.why,
      minimal_replacement_confirmed_by_distribution: replacement.confirmed_by_distribution,
      audit_ok: audit.ok,
      audit_problems: audit.problems.map(formatAuditProblem),
      text: renderCompareText({...comparison, replacement}),
    };
  });

  const controlTeams = teams.slice(0, 2);
  const control = measured === null || controlTeams.length < 2 ? null : (() => {
    const [rowA, rowB] = controlTeams;
    const teamARef = {team_id: rowA.team_id, members: rowA.team?.members ?? []};
    const teamBRef = {team_id: rowB.team_id, members: rowB.team?.members ?? []};
    const comparison = compareTeams({teamA: teamARef, teamB: teamBRef, metaPrior: measured, gapsByTeam, ranker});
    const replacement = minimalReplacement({team: teamARef, metaPrior: measured, candidates, gapsByTeam});
    const audit = auditTeamCompare({compare: comparison, replacement}, {
      source, scope: 'online', text: renderCompareText({...comparison, replacement}),
    });
    const weightedMean = compareAxisValues('environment_value', resolveDistribution(measured));
    return {
      sample: {
        note: measured.note,
        distribution_source: measured.distribution_source,
        entries: resolveDistribution(measured).entries.map((row) => ({
          archetype_id: row.archetype_id, source: row.source, value: row.value,
          relative_score: row.relative_score, tolerance: row.tolerance,
        })),
      },
      teams: [rowA.team_id, rowB.team_id],
      availability: comparison.availability,
      values: Object.fromEntries(AXIS_IDS.map((axisId) => [axisId,
        comparison.axes[axisId].available ? comparison.axes[axisId].value : null])),
      environment_value_recomputed_from_injected_distribution: weightedMean,
      environment_value_matches_weighted_mean: comparison.axes.environment_value.value === weightedMean,
      coverage_confidence_unchanged: comparison.axes.coverage_confidence.value
        === compareTeams({teamA: teamARef, teamB: teamBRef, metaPrior, gapsByTeam, ranker}).axes.coverage_confidence.value,
      minimal_replacement: replacement.replacement,
      minimal_replacement_confirmed_by_distribution: replacement.confirmed_by_distribution,
      audit_ok: audit.ok,
      audit_problems: audit.problems.map(formatAuditProblem),
      text: renderCompareText({...comparison, replacement}),
    };
  })();

  const currentComparisons = pairings.slice(0, 2).map(([teamIdA, teamIdB]) => {
    const teamARef = {team_id: teamIdA, members: teams.find((row) => row.team_id === teamIdA)?.team?.members ?? []};
    const teamBRef = {team_id: teamIdB, members: teams.find((row) => row.team_id === teamIdB)?.team?.members ?? []};
    return compareTeams({teamA: teamARef, teamB: teamBRef, metaPrior, gapsByTeam, ranker});
  });
  const currentDistribution = currentComparisons.length > 0 ? currentComparisons[0].distribution : null;
  const currentKind = currentDistribution?.kind ?? 'unknown';
  const negTeams = teams.slice(0, 2);
  const negRefs = negTeams.length < 2 ? null : negTeams.map((row) => ({
    team_id: row.team_id, members: row.team?.members ?? [],
  }));

  /**
   * 负向控制：全部**由注入的 metaPrior 派生**（纯函数、不读盘、不看时钟）。
   * 每一条都对应一条必红方向：改了那一处，四轴就必须回到 `available:false`（或随分母变），
   * 而不是照用一个「看起来像数」的东西。这些控制本身也是报告的一部分（评审可复跑）。
   */
  const derivePrior = (mutate) => ({
    ...metaPrior,
    archetypes: arr(metaPrior?.archetypes),
    distribution: arr(metaPrior?.distribution).map((row, index) => mutate({...row}, index)),
  });
  const negativePriors = {
    unknown: derivePrior((row) => ({...row, source: 'unknown', value: null, basis: null, sources: [],
      reason: '（负向控制：整份降级成 unknown + value: null）'})),
    basis_missing: derivePrior((row) => ({...row, basis: null})),
    assumption_with_sources: derivePrior((row) => ({...row,
      sources: [{ref: 'injected:rc-304-negative-control', date: '2026-09-25'}]})),
    partition_broken: derivePrior((row, index) => (index === 0 ? {...row, value: 0.5} : row)),
  };
  const negativeControls = negRefs === null ? {} : Object.fromEntries(
    Object.entries(negativePriors).map(([name, variantPrior]) => {
      const comparison = compareTeams({teamA: negRefs[0], teamB: negRefs[1],
        metaPrior: variantPrior, gapsByTeam, ranker});
      return [name, {
        distribution_kind: comparison.distribution.kind,
        distribution_reason: comparison.distribution.reason,
        availability: Object.fromEntries(DISTRIBUTION_AXES.map((axisId) => [axisId, comparison.availability[axisId]])),
        values: Object.fromEntries(DISTRIBUTION_AXES.map((axisId) => [axisId, comparison.axes[axisId].value])),
        unknown_reasons: Object.fromEntries(DISTRIBUTION_AXES
          .map((axisId) => [axisId, comparison.axes[axisId].unknown_reason])),
      }];
    }),
  );

  /**
   * 分母敏感性控制：把体系数从 K 改成 K + 1（每行 1/(K+1) + 一条合成体系），
   * 占比与权重必须随之变、四轴仍必须可用。这一条钉住「四轴真的吃分母」，而不是恒定的手写数。
   */
  const universeControl = (() => {
    if (negRefs === null || currentKind !== 'assumption' || currentDistribution === null) return null;
    // 用**注入的先验原始行**（带 basis / notes）来派生，而不是比较结果里的公开投影（那里只有占比）。
    const rows = arr(metaPrior?.distribution).filter((row) => row?.source === 'assumption');
    if (rows.length === 0) return null;
    const widerK = rows.length + 1;
    const syntheticId = 'rc304-synthetic-universe';
    const widerPrior = {
      ...metaPrior,
      distribution: [
        ...rows.map((row) => ({
          archetype_id: row.archetype_id,
          source: 'assumption', unit: 'share', confidence: 'ENGINE_HYPOTHESIS',
          value: Number((1 / widerK).toFixed(6)),
          notes: row.notes ?? '（分母敏感性控制：均匀铺在 K+1 个体系上）',
          basis: {...row.basis, denominator: widerK,
            value_rule: `每个体系 1/K，K = ${widerK}（分母敏感性控制：K 从 ${rows.length} 改成 ${widerK}）`},
        })),
        {
          archetype_id: syntheticId, source: 'assumption', unit: 'share', confidence: 'ENGINE_HYPOTHESIS',
          value: Number((1 / widerK).toFixed(6)),
          notes: '（分母敏感性控制用的合成体系：只改分母，不带任何真实体系含义）',
          basis: {...(rows[0]?.basis ?? {}), denominator: widerK,
            value_rule: `每个体系 1/K，K = ${widerK}（分母敏感性控制）`},
        },
      ],
      archetypes: [...arr(metaPrior?.archetypes),
        {archetype_id: syntheticId, label: '（合成体系）', feature_axes: [{criterion: 'coverage'}]}],
    };
    const comparison = compareTeams({teamA: negRefs[0], teamB: negRefs[1],
      metaPrior: widerPrior, gapsByTeam, ranker});
    const baselineWeight = currentComparisons.length > 0
      ? currentComparisons[0].axes.worst_archetype.value?.weight ?? null : null;
    return {
      denominator_before: rows.length,
      denominator_after: widerK,
      partition_ok: comparison.distribution.partition_ok,
      weight_before: baselineWeight,
      weight_after: comparison.axes.worst_archetype.value?.weight ?? null,
      environment_value_before: currentComparisons.length > 0
        ? currentComparisons[0].axes.environment_value.value : null,
      environment_value_after: comparison.axes.environment_value.value,
      availability: comparison.availability,
      weight_changed: baselineWeight !== null
        && comparison.axes.worst_archetype.value?.weight !== baselineWeight,
      value_changed: currentComparisons.length > 0
        && stableJson(comparison.axes.environment_value.value)
          !== stableJson(currentComparisons[0].axes.environment_value.value),
    };
  })();

  const unknownReasonRows = AXIS_IDS.map((axisId) => ({
    axis: axisId,
    prior_field: AXIS_BY_ID[axisId].prior_field,
    available_now: currentComparisons.length > 0
      ? currentComparisons.every((comparison) => comparison.availability[axisId]) : false,
    unknown_reason: currentComparisons.length > 0
      ? (currentComparisons[0].axes[axisId].unknown_reason ?? null) : FAIL_CLOSED_REASONS.DISTRIBUTION_UNKNOWN,
    missing: currentComparisons.length > 0 ? arr(currentComparisons[0].axes[axisId].missing) : [],
    lights_up_when: axisId === 'coverage_confidence' ? '现在就是 available（只依赖 build 的规则/数据覆盖）'
      : '现在就是 available（assumption 档：占比 = 声明假设的分母，相对分 / 容错 = RC-302 结构分）；'
        + '换成带来源的 measured 分布后改用注入的 relative_score / tolerance',
  }));

  const auditAll = [...pairRows.map((row) => row.audit_ok), ...(control ? [control.audit_ok] : [])];
  const criteria = [
    reportVerdict('真实数据下五轴全部可用（coverage_confidence 真算 + 四轴 assumption 结构分）',
      STRUCTURAL_CRITERIA.assumption_structural_scores,
      currentComparisons.map((comparison) => `available=${comparison.available_axis_count}/5 kind=${comparison.distribution.kind} `
        + DISTRIBUTION_AXES.map((axisId) => `${axisId}=${stableJson(comparison.axes[axisId].value)?.slice(0, 48)}`
          + `/${comparison.axes[axisId].confidence}`).join(' ')
        + ` coverage=${comparison.axes.coverage_confidence.value}/${comparison.axes.coverage_confidence.confidence}`),
      currentComparisons.length > 0 && currentComparisons.every((comparison) => comparison.available_axis_count === 5
        && DISTRIBUTION_AXES.every((axisId) => comparison.availability[axisId] === true
          && comparison.axes[axisId].confidence === 'ENGINE_HYPOTHESIS')
        && comparison.availability.coverage_confidence === true
        && Number.isFinite(comparison.axes.coverage_confidence.value))),
    reportVerdict('把分布降级成 unknown ⇒ 前四轴必须 available:false + value:null + 点名缺什么（负向控制）',
      STRUCTURAL_CRITERIA.distribution_fail_closed,
      Object.entries(negativeControls).map(([name, row]) => `${name}: kind=${row.distribution_kind} `
        + DISTRIBUTION_AXES.map((axisId) => `${axisId}=${row.availability[axisId]}`).join(' ')),
      ['unknown'].every((name) => negativeControls[name] !== undefined
        && DISTRIBUTION_AXES.every((axisId) => negativeControls[name].availability[axisId] === false
          && negativeControls[name].values[axisId] === null
          && typeof negativeControls[name].unknown_reasons[axisId] === 'string'))),
    reportVerdict('assumption 行缺 basis / 挂 sources / 占比不闭合 ⇒ 前四轴必须 fail closed（裸数字不许进）',
      STRUCTURAL_CRITERIA.assumption_needs_basis,
      Object.entries(negativeControls).map(([name, row]) => `${name}: kind=${row.distribution_kind} reason=${String(row.distribution_reason).slice(0, 60)}`),
      ['basis_missing', 'assumption_with_sources', 'partition_broken'].every((name) => negativeControls[name] !== undefined
        && DISTRIBUTION_AXES.every((axisId) => negativeControls[name].availability[axisId] === false
          && negativeControls[name].values[axisId] === null))),
    reportVerdict('四轴对**分母**敏感：K → K+1（每行 1/(K+1)）⇒ 权重与加权值随之变，且仍然可用',
      STRUCTURAL_CRITERIA.assumption_structural_scores,
      universeControl === null ? '未做分母敏感性控制'
        : `K ${universeControl.denominator_before} → ${universeControl.denominator_after}、`
          + `weight ${universeControl.weight_before} → ${universeControl.weight_after}、`
          + `environment_value ${stableJson(universeControl.environment_value_before)} → `
          + `${stableJson(universeControl.environment_value_after)}、partition_ok=${universeControl.partition_ok}`,
      universeControl !== null && universeControl.partition_ok === true
        && universeControl.weight_changed === true && universeControl.value_changed === true
        && DISTRIBUTION_AXES.every((axisId) => universeControl.availability[axisId] === true)),
    reportVerdict('注入 measured 分布后前四轴必须亮起来（反向控制：fail closed ≠ 恒 unknown）',
      STRUCTURAL_CRITERIA.measured_lights_up,
      control === null ? '未注入对照样例' : Object.entries(control.availability)
        .map(([axisId, available]) => `${axisId}=${available}`),
      control !== null && AXIS_IDS.every((axisId) => control.availability[axisId] === true)),
    reportVerdict('measured 分布下的环境价值必须等于按注入占比的加权均值（值真的来自分布）',
      STRUCTURAL_CRITERIA.measured_lights_up,
      control === null ? '未注入对照样例'
        : `value=${control.values.environment_value} 重算=${control.environment_value_recomputed_from_injected_distribution} `
          + `matches=${control.environment_value_matches_weighted_mean}`,
      control !== null && control.environment_value_matches_weighted_mean === true),
    reportVerdict('在线段没有引擎 / 子进程调用（源码结构判据）',
      STRUCTURAL_CRITERIA.online_no_engine,
      typeof source === 'string' ? scanForbiddenPatterns(onlineSectionOf(source)).map((hit) => hit.pattern) : '未注入源码',
      typeof source === 'string' && scanForbiddenPatterns(onlineSectionOf(source)).length === 0),
    reportVerdict('最小替换恰好一个方案且带 why；分布 unknown 时只给结构理由',
      STRUCTURAL_CRITERIA.one_replacement,
      pairRows.map((row) => `${row.teams.join(' vs ')}: `
        + (row.minimal_replacement === null ? '给不出（why 已写）'
          : `${row.minimal_replacement.out.key} → ${row.minimal_replacement.in.key}`)
        + ` confirmed_by_distribution=${row.minimal_replacement_confirmed_by_distribution}`),
      pairRows.every((row) => row.audit_ok === true)),
    reportVerdict('没有胜率 / 百分数 / 榜单词（产出与渲染文本一起扫）',
      STRUCTURAL_CRITERIA.no_pseudo_precision,
      pairRows.map((row) => `audit_ok=${row.audit_ok}`),
      auditAll.every((ok) => ok === true)),
    reportVerdict('没有排序器时如实降级（ranker_status = missing）',
      STRUCTURAL_CRITERIA.distribution_fail_closed,
      currentComparisons.map((comparison) => `ranker=${comparison.ranker.status}`),
      currentComparisons.every((comparison) => comparison.ranker.status === 'missing')),
  ];

  return {
    report_version: RC304_REPORT_VERSION,
    rc: 'RC-304',
    title: '未知对手下的队伍比较：能算的算、算不出的 fail closed 返回 unknown',
    axes: AXES.map((axis) => ({...axis, criteria: axis.id === 'coverage_confidence'
      ? AXIS_CRITERIA_TEXT.coverage_confidence : tierCriterionFor(currentKind)})),
    fail_closed_reasons: FAIL_CLOSED_REASONS,
    structural_criteria: STRUCTURAL_CRITERIA,
    distribution_now: {
      source: currentKind,
      declared_source: currentDistribution?.declared_source ?? null,
      entries: currentDistribution?.entries ?? 0,
      partition_ok: currentDistribution?.partition_ok ?? null,
      value_sum: currentDistribution?.weight_sum ?? null,
      basis: currentDistribution?.basis ?? null,
      relative_score_source: '**队伍级**结构分：按每个体系自己声明的 `archetypes[].feature_axes[].criterion` '
        + '从 RC-302 的缺口诊断算出（等权、分母 = 判据条数），置信等级 ENGINE_HYPOTHESIS；'
        + '它不是离线联赛 / matchup bank 的产物，也不预测胜负',
      reason: currentDistribution?.reason ?? null,
      evidence: currentDistribution?.evidence ?? [],
    },
    availability_now: {
      available: AXIS_IDS.filter((axisId) => unknownReasonRows.find((row) => row.axis === axisId)?.available_now === true),
      unknown: AXIS_IDS.filter((axisId) => unknownReasonRows.find((row) => row.axis === axisId)?.available_now !== true),
      note: currentKind === 'assumption'
        ? '5 轴全部可用：coverage_confidence 只依赖 build 的规则/数据覆盖；四轴的分母来自**声明假设**'
          + '（先验里逐条带 basis，可复算、可替换），相对分 / 容错来自 RC-302 的结构分（ENGINE_HYPOTHESIS）'
        : '按注入分布的档位：unknown ⇒ 四轴 fail closed；assumption ⇒ 四轴用声明假设的分母 + RC-302 结构分；'
          + 'measured ⇒ 四轴用注入的 relative_score / tolerance',
    },
    unknown_reasons: unknownReasonRows,
    /**
     * 反证留痕：每条必红方向的**实际输出原文**（由 `tests/roco-team-compare.test.js` 收集后注入）。
     * 报告与测试都不复述判据，只贴「改坏之后审计真正说了什么」。
     */
    red_proofs: arr(red_proofs).map((row) => ({
      where: row?.where ?? null,
      mutation: row?.mutation ?? null,
      criterion: row?.criterion ?? null,
      expect_code: row?.expect_code ?? null,
      actual: typeof row?.actual === 'string' ? row.actual : stableJson(row?.actual ?? null),
    })),
    measured_control_sample: control,
    negative_controls: negativeControls,
    denominator_sensitivity_control: universeControl,
    criteria,
    teams: teamRecords,
    comparisons: pairRows,
    ranker: currentComparisons.length > 0 ? currentComparisons[0].ranker : resolveRanker(null),
    does_not_do: [
      '不产出胜率 / 强度分 / 榜单名次 / 伪精确概率：13 号文档 §4 的五个口径都不是胜率',
      '不在在线路径跑模拟、调引擎、起进程（在线只读注入分布 + 注入 build 覆盖）',
      '不把 `unknown` 写成 0 / 「差不多」：算不出来就 available:false + 点名缺什么',
      '不拿第 13 号文档 §4 的 CVaR / robustness 冒充已实现：本 RC 落的是 environment_value / worst_archetype / '
        + 'matchup_spread / execution_tolerance / coverage_confidence 五个口径（CVaR 需要尾部收益分布，见文档 §边界）',
      '不把对照样例当版本数据：`measured_control_sample.sample` 是**构造**的，每条来源都标 measured=false',
      '不给多方案排序：`minimalReplacement` 恰好一个方案；选哪一个候选本身不是排序任务',
    ],
    generated_by: 'src/coach/team-compare.mjs#buildRc304Report（跑 tests/roco-team-compare.test.js 重新生成）',
  };
}

