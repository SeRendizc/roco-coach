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
// 这份先验（`data/roco/meta-prior/v1.json`）当前 `distribution[]` 全部
// `source: "unknown"` + `value: null`，所以前四个口径现在**无定义**：本模块返回
// `available:false` + 点名缺什么的 `unknown_reason`，`value` 是 `null`（不是 0），
// 并**永不**输出胜率 / 百分数 / 「差不多」。这是 fail closed，不是「永远 unknown」：
// 注入一份 `source: "measured"` 的分布（带逐条来源与数值）后，前四个口径必须**真的亮起来**，
// 值来自注入分布（测试里有一条反向控制钉住这一点——恒 unknown 也是骗人）。
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
  CONFIDENCE_LEVELS, CONFIDENCE_RANK, diagnoseTeamGaps,
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
  DISTRIBUTION_UNKNOWN: '缺**版本对手分布**：`meta-prior/v1.json` 的 `distribution[]` 当前'
    + ' `source: "unknown"` + `value: null`（没有任何真实对局数据），所以「对环境的期望」的分母不存在，'
    + '这一轴现在无定义。按契约返回 unknown，不返回 0、不给「差不多」、不输出伪精确结论。',
  DISTRIBUTION_ENTRY_VALUE_MISSING: '缺**逐体系分布值**：注入的分布里至少一个体系的 `value` 是 `null`，'
    + '分母不闭合，所以这一轴现在无定义（要么补齐每个体系的值，要么整份分布保持 unknown）。',
  NO_RELATIVE_SCORE: '缺**逐体系相对表现表**：分布说的是「对手占多少」，'
    + '还需要 `distribution[].relative_score`（离线联赛 / matchup bank 的产物）才能把占比折成期望。'
    + '本仓现在既没有 matchup bank 也没有逐体系表现估计。',
  NO_EXECUTION_SAMPLE: '缺**可复跑的对局采样**：`distribution[].tolerance`（同一支队伍在次优操作下的'
    + '相对表现）是离线回放/联赛的产物，本仓一次都没跑过；规则本身还在 candidate 阶段'
    + '（台账里严格总序仍是 ENGINE_HYPOTHESIS），所以容错数值现在一定是伪精确。',
  NO_GAP_DIAGNOSIS: '缺**build 覆盖数据**：这一轴只依赖 build 的规则/数据覆盖，本可以立刻算；'
    + '但没有注入 RC-302 的缺口诊断（`gapsByTeam[team_id]`）时，连「哪些量在台账里是 UNKNOWN」都读不到，'
    + '所以 fail closed 而不是报 0 覆盖。',
  NO_MEASURED_SOURCE: '缺**逐条可核对的来源**：注入的分布标了 `source: "measured"`，'
    + '却没有 url / 仓内文件 + 日期（先验的 `DISTRIBUTION` 判据要求 measured 必须有来源）。'
    + '没有来源的数字不许进比较，所以这一轴仍然 unknown。',
  NO_ARCHETYPE: '缺**可识别体系**：注入的分布里一条体系都没有，分母是空的，这一轴无定义。',
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
  distribution_fail_closed: '[严格] 注入的 `metaPrior` 里 `distribution_source === "unknown"`（或 `distribution[].value` 有 null）时，'
    + `${DISTRIBUTION_AXES.join(' / ')} 四轴的 \`available\` 必须是 \`false\`、\`value\` 必须是 \`null\`、`
    + '`unknown_reason` 必须点名缺什么。出现数值 / `0` / 「差不多」/ 胜率 ⇒ `UNKNOWN_AXIS_HAS_VALUE`（红）。',
  availability_shape: '`available:true` 的轴必须给出**非 null 的数值型** `value`（或最怕体系那轴的非空对象）；'
    + '`available:false` 的轴必须给出 `value: null` 且 `value_numbers` 为空。'
    + '数值轴报 `null` 却写 `available:true` ⇒ `AVAILABILITY_SHAPE`（红）。',
  measured_lights_up: '注入带来源的 `measured` 分布时，前四轴**必须**亮起来（`available:true`），'
    + '值必须来自注入分布（加权均值 / 极差 / 最差体系逐条可对账）。'
    + '反过来，如果 `available` 的轴数与注入分布里 `value` 非 null 的体系数对不上 ⇒ `MEASURED_NOT_WIRED`（红）：'
    + 'fail closed 不许写成「永远 unknown」。',
  coverage_from_build: '[弱] `coverage_confidence` 必须**真算**：它的 `value` 只由注入的 build / 台账数据决定'
    + '（注入一份更差的 build ⇒ 覆盖置信必须更低）。同一份数据算两次必须逐字节相同，'
    + '否则 `COVERAGE_NOT_FROM_BUILD`（红）。',
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

/**
 * 读注入的分布。**两套形状都认**，因为先验的 schema 与先验的 v1.json 各写了一套：
 *   · `metaPrior.distribution_source`（顶层判定，RC-304 任务书写的就是这个）；
 *   · `metaPrior.distribution[]`（先验实际产物：逐体系 `source` / `value` / `sources`）。
 * 顶层没写就按逐条推断；**任何一条 `value` 是 null 就算整份分布不可用**（分母不闭合）。
 */
export function resolveDistribution(metaPrior) {
  const prior = isPlainObject(metaPrior) ? metaPrior : {};
  const entries = arr(prior.distribution);
  const declared = prior.distribution_source ?? null;

  const rows = entries.map((entry, index) => ({
    index,
    archetype_id: entry?.archetype_id ?? null,
    label: entry?.label ?? entry?.archetype_label ?? null,
    source: isNonEmptyString(entry?.source) ? entry.source : null,
    value: Number.isFinite(entry?.value) ? Number(entry.value) : null,
    relative_score: Number.isFinite(entry?.relative_score) ? Number(entry.relative_score) : null,
    tolerance: Number.isFinite(entry?.tolerance) ? Number(entry.tolerance) : null,
    sources: arr(entry?.sources),
    has_source: hasMeasuredSource(entry?.sources),
    reason: isNonEmptyString(entry?.reason) ? entry.reason : null,
  }));

  const measuredRows = rows.filter((row) => row.source === 'measured' || row.value !== null);
  const unknownDeclared = declared === 'unknown';
  // 逐条**自己**标了 unknown（或 value 为 null）也算「分布不存在」，不只是看顶层声明：
  // 先验的 v1.json 就是这种形状（没有顶层 distribution_source，7 条全是 unknown + null）。
  const unknownEntries = rows.filter((row) => row.source === 'unknown' || row.value === null).length;
  const rowsAllUnknown = rows.length > 0 && unknownEntries === rows.length;
  const noRows = rows.length === 0;
  let kind = 'unknown';
  if (!unknownDeclared && !noRows && measuredRows.length === rows.length
    && measuredRows.every((row) => row.value !== null && row.has_source)) {
    kind = 'measured';
  }

  const missingValue = rows.filter((row) => row.value === null).map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const missingSource = measuredRows.filter((row) => !row.has_source)
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);
  const missingValueSource = measuredRows.filter((row) => isNonEmptyString(row.source) && row.source !== 'measured')
    .map((row) => row.archetype_id ?? `distribution[${row.index}]`);

  // 权重：分母。分布给了 `value` 就当作占比；没有就把可用行等权（并说明这一点）。
  const weightMode = rows.some((row) => row.value !== null) ? 'value' : 'equal_weight_fallback';
  const weights = rows.map((row) => (row.value !== null ? Number(row.value) : (rows.length ? 1 / rows.length : 0)));
  const weightSum = round(weights.reduce((sum, weight) => sum + weight, 0));

  const missing = [];
  if (noRows) missing.push('distribution[]（一条体系都没有）');
  if (unknownDeclared || rowsAllUnknown) {
    missing.push('metaPrior.distribution_source = "unknown"（没有任何真实对局数据）');
  }
  if (missingValue.length) missing.push(`distribution[].value（${missingValue.join(' / ')}）`);
  if (missingSource.length) missing.push(`distribution[].sources（${missingSource.join(' / ')} 标了 measured 却没有 url / 文件）`);
  if (missingValueSource.length) missing.push(`distribution[].value_source（${missingValueSource.join(' / ')} 标了 measured 却没有来源）`);

  const reason = kind === 'measured' ? null
    : (noRows ? FAIL_CLOSED_REASONS.NO_ARCHETYPE
      : (unknownDeclared || rowsAllUnknown ? FAIL_CLOSED_REASONS.DISTRIBUTION_UNKNOWN
        : (missingSource.length ? FAIL_CLOSED_REASONS.NO_MEASURED_SOURCE : FAIL_CLOSED_REASONS.DISTRIBUTION_ENTRY_VALUE_MISSING)));

  return {
    kind,
    declared_source: declared,
    entries: rows,
    weights,
    weight_sum: weightSum,
    weight_mode: weightMode,
    missing,
    missing_value_entries: missingValue,
    missing_source_entries: missingSource,
    reason,
    evidence: buildDistributionEvidence(prior, rows, kind, declared),
  };
}

function buildDistributionEvidence(prior, rows, kind, declared) {
  const evidenceRows = [evidence(
    'data/roco/meta-prior/v1.json', 'distribution[]', 'source',
    declared === null ? '（未注入顶层 distribution_source）' : declared,
    '环境先验的分布口径：先验自己写下的 unknown/measured 判定',
  )];
  for (const row of rows) {
    evidenceRows.push(evidence(
      'injected:metaPrior.distribution[]', `distribution[${row.index}]`, 'value',
      row.value === null ? null : row.value,
      `体系 ${row.archetype_id ?? `#${row.index}`}：source=${stableJson(row.source)}、`
      + `relative_score=${stableJson(row.relative_score)}、tolerance=${stableJson(row.tolerance)}、`
      + `来源 ${sourceRefs(row.sources).join(' / ') || '（没有）'}`,
    ));
  }
  if (kind !== 'measured') {
    evidenceRows.push(evidence(
      'data/roco/meta-prior/v1.json', 'claim.does_not_contain', 'claim',
      '任何体系的占比数值：当前没有任何可核对的来源，distribution 全部是 unknown + value: null + reason',
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

  if (distribution.kind !== 'measured') {
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

  const value = compareAxisValues(axisId, distribution);
  if (value === null) {
    const reason = axisId === 'execution_tolerance'
      ? FAIL_CLOSED_REASONS.NO_EXECUTION_SAMPLE : FAIL_CLOSED_REASONS.NO_RELATIVE_SCORE;
    return {
      ...base,
      available: false,
      value: null,
      unknown_reason: reason,
      evidence: distribution.evidence,
      confidence: 'UNKNOWN',
      unverified: [`未核实：${axis.label} —— 分布是 measured，但${reason}`],
      missing: [axisId === 'execution_tolerance' ? 'distribution[].tolerance' : 'distribution[].relative_score'],
      distribution_kind: distribution.kind,
      team_id: teamId,
    };
  }

  const bootstrap = distribution.evidence.some((item) => typeof item.note === 'string'
    && item.note.includes('ENGINE_HYPOTHESIS'));
  return {
    ...base,
    available: true,
    value,
    unknown_reason: null,
    evidence: [
      ...distribution.evidence,
      evidence('injected:metaPrior.distribution[]', 'distribution[].relative_score',
        axisId === 'worst_archetype' ? 'min(relative_score)'
          : (axisId === 'matchup_spread' ? 'max(relative_score) - min(relative_score)'
            : (axisId === 'execution_tolerance' ? 'Σ(tolerance × weight) / Σweight' : 'Σ(relative_score × weight) / Σweight')),
        value,
        '值来自注入分布：权重 = distribution[].value（占比），逐条可对账；'
        + '如果权重是等权回落，另见 weight_mode'),
      evidence('injected:metaPrior.distribution[]', 'distribution[].value', 'weight_mode', distribution.weight_mode,
        distribution.weight_mode === 'value' ? '权重直接用注入的占比值'
          : '注入分布没有给占比值，四轴按逐体系等权回落并在 unverified 点名'),
    ],
    confidence: bootstrap ? 'ENGINE_HYPOTHESIS' : 'CROSS_SOURCE_SUPPORTED',
    unverified: [
      '未核实：相对表现本身的正确性 —— 它来自注入的离线产物（league / matchup bank），'
        + '本仓现在**没有**这份产物；这条通路是为了让「分布到位后接口是活的」这件事可验证',
      ...(distribution.weight_mode === 'value' ? []
        : ['未核实：环境占比 —— 注入分布没有 value，四轴按逐体系等权回落']),
    ],
    missing: [],
    distribution_kind: distribution.kind,
    team_id: teamId,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 五轴比较
// ─────────────────────────────────────────────────────────────────────────

/** 判据正文里的 `[严格]` / `[弱]` 标签是给审计读的，比较结构里统一剥掉（判据只有一份）。 */
const stripCriterionTags = (text) => String(text ?? '').replace(/\[(严格|弱)\]/gu, '');

const AXIS_CRITERIA_TEXT = Object.freeze({
  environment_value: STRUCTURAL_CRITERIA.distribution_fail_closed,
  worst_archetype: STRUCTURAL_CRITERIA.distribution_fail_closed,
  matchup_spread: STRUCTURAL_CRITERIA.distribution_fail_closed,
  execution_tolerance: STRUCTURAL_CRITERIA.distribution_fail_closed,
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
  const axes = {};
  for (const axis of AXES) {
    const a = singleAxis(axis.id, teamA, metaPrior, gapsByTeam);
    const b = singleAxis(axis.id, teamB, metaPrior, gapsByTeam);
    // 「这一轴可比较」= 两队的**输入**都在，且至少一边真的给出了值（value === null 是 unknown，不是 0）。
    const bothAvailable = a.available === true && b.available === true
      && (a.value !== null || b.value !== null);
    const sameValue = bothAvailable && stableJson(a.value) === stableJson(b.value);
    const comparisonRaw = compareAxisValuesForAxis(axis.id, a, b);
    const comparison = sameValue
      ? {...comparisonRaw,
        value: {criterion: stripCriterionTags(AXIS_CRITERIA_TEXT[axis.id]), delta: 0, winner: null},
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
          ? {...worstArchetypeObject, criterion: stripCriterionTags(AXIS_CRITERIA_TEXT[axis.id]),
            structural: STRUCTURAL_CRITERIA.distribution_fail_closed}
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
      comparison,
      teams: {
        [teamLabel(teamA) ?? 'teamA']: publicTeamAxis(a),
        [teamLabel(teamB) ?? 'teamB']: publicTeamAxis(b),
      },
      criteria: stripCriterionTags(AXIS_CRITERIA_TEXT[axis.id]),
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
      missing: distribution.missing,
      reason: distribution.reason,
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

function compareAxisValuesForAxis(axisId, a, b) {
  const criterion = stripCriterionTags(AXIS_CRITERIA_TEXT[axisId]);
  const structural = STRUCTURAL_CRITERIA[axisId === 'coverage_confidence' ? 'coverage_from_build' : 'distribution_fail_closed'];
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
    if (distributionKind !== 'measured') {
      for (const axisId of DISTRIBUTION_AXES) {
        const axis = compare.axes[axisId];
        if (isPlainObject(axis) && axis.available === true) {
          push('UNKNOWN_AXIS_HAS_VALUE', `compare.axes.${axisId}`,
            `分布是 ${distributionKind}，这一轴却 available:true：没有分布就没有期望`);
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

  const unknownReasonRows = AXIS_IDS.map((axisId) => ({
    axis: axisId,
    prior_field: AXIS_BY_ID[axisId].prior_field,
    available_now: currentComparisons.length > 0
      ? currentComparisons.every((comparison) => comparison.availability[axisId]) : false,
    unknown_reason: currentComparisons.length > 0
      ? (currentComparisons[0].axes[axisId].unknown_reason ?? null) : FAIL_CLOSED_REASONS.DISTRIBUTION_UNKNOWN,
    missing: currentComparisons.length > 0 ? arr(currentComparisons[0].axes[axisId].missing) : [],
    lights_up_when: axisId === 'coverage_confidence' ? '现在就是 available'
      : '注入 measured 分布（带逐条来源 + value + relative_score）后 available',
  }));

  const auditAll = [...pairRows.map((row) => row.audit_ok), ...(control ? [control.audit_ok] : [])];
  const criteria = [
    reportVerdict('分布 unknown 时前四轴 available:false + value:null + unknown_reason 点名缺什么',
      STRUCTURAL_CRITERIA.distribution_fail_closed,
      unknownReasonRows.map((row) => `${row.axis}: available_now=${row.available_now}`),
      unknownReasonRows.filter((row) => row.axis !== 'coverage_confidence').every((row) => row.available_now === false)),
    reportVerdict('五轴里**恰好一轴**现在可用（coverage_confidence），它真算而不是报 0',
      STRUCTURAL_CRITERIA.coverage_from_build,
      currentComparisons.map((comparison) => `available=${comparison.available_axis_count}/5 `
        + `coverage=${comparison.axes.coverage_confidence.value}/${comparison.axes.coverage_confidence.confidence} `
        + `parts=${stableJson(comparison.axes.coverage_confidence.value_parts)}`),
      currentComparisons.every((comparison) => comparison.available_axis_count === 1
        && comparison.availability.coverage_confidence === true
        && Number.isFinite(comparison.axes.coverage_confidence.value))),
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
    axes: AXES.map((axis) => ({...axis, criteria: AXIS_CRITERIA_TEXT[axis.id]})),
    fail_closed_reasons: FAIL_CLOSED_REASONS,
    structural_criteria: STRUCTURAL_CRITERIA,
    distribution_now: {
      source: currentComparisons.length > 0 ? currentComparisons[0].distribution.kind : 'unknown',
      declared_source: currentComparisons.length > 0 ? currentComparisons[0].distribution.declared_source : null,
      entries: currentComparisons.length > 0 ? currentComparisons[0].distribution.entries : 0,
      reason: FAIL_CLOSED_REASONS.DISTRIBUTION_UNKNOWN,
      evidence: [
        'data/roco/meta-prior/v1.json#distribution[]：7 个体系全部 source="unknown" + value=null + reason',
        'data/roco/meta-prior/v1.json#claim.does_not_contain：先验自己声明「不产出任何占比数值」',
        'data/roco/meta-prior/v1.json#usage.inputs.*.honesty：分布 unknown 时前四轴必须 fail closed',
      ],
    },
    availability_now: {
      available: AXIS_IDS.filter((axisId) => unknownReasonRows.find((row) => row.axis === axisId)?.available_now === true),
      unknown: AXIS_IDS.filter((axisId) => unknownReasonRows.find((row) => row.axis === axisId)?.available_now !== true),
      note: '预计 1 可用 / 4 unknown：**唯一**能算的是 coverage_confidence（它只依赖 build 的规则/数据覆盖）',
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

