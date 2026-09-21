// ── RC-303：候选生成（召回 20～50 → Beam 补全六宠 → Top-K 排序） ────────────────
//
// 这个模块只做**在线**那一半：玩家已经选了 0～5 只，我们从全量候选宇宙里
//   ① 便宜特征召回 20～50 个候选（`recallCandidates`）；
//   ② 确定性 Beam 补全到六只（`beamComplete`）；
//   ③ Top-K 逐队打分（`scoreTeams`）；
//   ④ 已选 2～5 只时给恰好三个下一只候选（`progressiveNext`）。
//
// 它**不做**的事（边界都在报告与 `docs/roco/TEAM-CANDIDATES.md` 里）：
//   · 不跑任何对局模拟、不调用 Python 引擎、不起子进程（判据见下面的「在线/离线边界」一节，
//     由 `auditTeamCandidates()` 的 `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL` 钉住）；
//   · 不训练、不假装有排序器：注入的 `ranker` 不存在时 `ranker_status: 'missing'`，
//     退化成规则打分并标 `confidence: ENGINE_HYPOTHESIS`；
//   · 不写胜率、不写强度分、不引用社区榜单标签（T0/强势/必带 等）；
//   · 不枚举全组合：`C(622, 6)` 不可枚举（见 `docs/roco/TEAM-CANDIDATES.md` §组合爆炸），
//     只做「召回 → 束搜索 → 排序」三层收窄。
//
// 数据全部**显式注入**（owned / pack / frozen / gaps / policy / budgets / ranker），
// 本文件不读盘、不看时钟、不碰 DOM。读盘只在 `loadTeamCandidatesInputs()`（动态 import，
// 只在 Node 侧可用）。延迟与预算的实测由 `scripts/roco/measure-team-candidates.mjs` 产出。
//
// 依赖：只 import 同仓纯函数模块 `./team-request.js`（RC-301 的引用解析）与
// `./team-gaps.js`（RC-302 的索引、属性倍率、能耗/应对/换入手段判据）。
// **不复制第二套语义**：属性倍率、技能能耗、应对词条、换入/离场词条都调用 RC-302 的实现。

import {STANDARD_PVP_TEAM_SIZE, resolveReference} from './team-request.js';
import {
  CONFIDENCE_LEVELS, CONFIDENCE_RANK, FROZEN_PATHS, buildGapIndex, costSatisfiability,
  diagnoseTeamGaps, isPivotSkill, ledgerQuantities, respondVariantsOf,
} from './team-gaps.js';

/** 报告路径（由 `buildRc303Report()` 生成，测试比对磁盘上的字节）。 */
export const RC303_REPORT_PATH = 'reports/roco/flagship-upgrade/rc-303-team-candidates.json';
export const RC303_REPORT_VERSION = 'roco-rc303-team-candidates-report/v1';

/** 13 号设计文档 §5 的延迟预算（毫秒）。判据拿实测值与它**逐项对照**。 */
export const LATENCY_BUDGET_MS = Object.freeze({
  state_and_version: 50,
  recall: 150,
  beam_and_ranker: 300,
  evidence_and_counterfactual: 300,
  first_screen: 800,
  total_with_llm: 3000,
});

/** 召回数量的上下界（13 号文档 §5.2「从 600+ 召回 20～50 个候选」）。 */
export const RECALL_MIN = 20;
export const RECALL_MAX = 50;

/** 排序器的状态。**没有注入排序器就是 `missing`**，不许假装有训练好的模型。 */
export const RANKER_STATUSES = Object.freeze(['ready', 'missing', 'invalid']);

/** 一种候选属于哪个候选宇宙。`owned` = 玩家箱子里的实例；`catalog` = pack 图鉴物种。 */
export const CANDIDATE_KINDS = Object.freeze(['owned', 'catalog']);

/** 渐进推荐的三个取舍口径（是**决策口径**，不是胜率）。 */
export const PROGRESSIVE_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'strength',
    label: '强度',
    tradeoff: '边际收益最高：补的是队伍现在最缺的那一类结构（系别承接 / 应对 / 换入手段），代价是可能挤掉偏好位。',
    intent: '选**边际评分增益最大**的那只。增益 = 加入后的队伍规则分 − 当前队伍规则分；评分只做相对排序，不是胜率。',
  }),
  Object.freeze({
    id: 'stability',
    label: '稳定',
    tradeoff: '稳定优先：把队里「没有任何队友能接」的弱点数量压到最低，代价是单点强度不如强度口径。',
    intent: '选**把未承接弱点数减到最少**（同分再看弱点总数）的那只；这是可复算的鲁棒性口径，不是胜率。',
  }),
  Object.freeze({
    id: 'preference',
    label: '偏好保留',
    tradeoff: '偏好保留：优先用玩家收藏 / 已锁定的精灵，代价是结构增益可能不如前两者。',
    intent: '在 favourite / locked 里选边际增益最大的那只；一只收藏都没有时如实回落到强度口径，并写明回落原因。',
  }),
]);

/** 数值精度：所有分数保留固定小数位，避免浮点噪声让同一输入产生不同字节。 */
const SCORE_DECIMALS = 4;

// ─────────────────────────────────────────────────────────────────────────
// 在线 / 离线边界（**结构判据**，不是注释）
// ─────────────────────────────────────────────────────────────────────────
//
// 在线路径不许调用引擎或子进程。这件事不能只写在注释里：下面的 `FORBIDDEN_ONLINE_PATTERNS`
// 是判据的唯一事实源，`auditTeamCandidates()` 用它扫**在线导出段**（由
// `ONLINE_SECTION_MARKER` 标出），测试再把正确的段改坏来证明判据有牙。
//
// 本文件的分段约定：
//   · 从顶部到 `OFFLINE_SECTION_MARKER` 之前的**全部导出**都必须是无引擎、无子进程的纯函数；
//   · `OFFLINE_SECTION_MARKER` 之后只放**离线入口**（目前是 `buildOfflineLabelPlan()`），
//     它产出的只是「离线要跑什么」的工作单与版本号，**同样不在这里跑模拟**；
//     真正跑引擎的离线产标签流程是外部步骤，谁调用写在 `OFFLINE_ENTRYPOINTS` 与文档里。
export const ONLINE_SECTION_MARKER = '<!-- ONLINE-SECTION-END -->';
export const OFFLINE_SECTION_MARKER = '<!-- OFFLINE-SECTION-BEGIN -->';

/** 在线导出段禁止出现的调用模式。命中一条就是结构判据失败，不是风格问题。 */
export const FORBIDDEN_ONLINE_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL',
    pattern: 'step_joint',
    detail: '在线候选生成里出现引擎的联合推进入口：候选生成只读静态数据，跑模拟是离线产标签的事',
  }),
  Object.freeze({
    id: 'ONLINE_ENGINE_CALL',
    pattern: 'plan_actions',
    detail: '在线候选生成里出现引擎的规划入口：那属于离线 league/自博弈，不属于 300ms 的在线预算',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL',
    pattern: 'child_process',
    detail: '在线候选生成里出现子进程模块：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL',
    pattern: 'spawn',
    detail: '在线候选生成里出现 spawn：在线路径不 spawn 任何进程',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL',
    pattern: 'roco-client',
    detail: '在线候选生成里出现 Python 引擎客户端：在线路径不连接引擎',
  }),
  Object.freeze({
    id: 'ONLINE_SUBPROCESS_CALL',
    pattern: 'RocoClient',
    detail: '在线候选生成里出现 Python 引擎客户端类：在线路径不连接引擎',
  }),
]);

/** 哪些是**离线**入口、谁调用它们。报告与文档共用这一份声明。 */
export const OFFLINE_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    id: 'buildOfflineLabelPlan',
    what: '产出「离线要跑什么」的工作单：版本化产物名、需要的标签、训练/校准步骤；**它自己不跑模拟**。',
    caller: 'scripts/roco/measure-team-candidates.mjs 之外的离线流程（人工/后续 RC），本 RC 只钉边界',
    writes: ['data/roco/ranker/team-ranker-v1.json（未来产物，现在不存在）'],
    engine_use: '真正的标签由离线 league / 自博弈产生（13 号文档 §5.1），不在本模块内执行',
  }),
]);

/** 哪些是**在线**入口。这份清单是「在线导出」的结构定义，审计逐条扫它们的源码段。 */
export const ONLINE_ENTRYPOINTS = Object.freeze([
  'recallCandidates', 'beamComplete', 'scoreTeams', 'progressiveNext',
  'buildTeamCandidatePlan', 'auditTeamCandidates', 'loadTeamCandidatesInputs',
]);

/** 结构判据的文本（报告里逐条贴出来，与实现同源）。 */
export const STRUCTURAL_CRITERIA = Object.freeze({
  online_no_engine: '把 `src/coach/team-candidates.mjs` 的在线段（`ONLINE_SECTION_MARKER` 之前）'
    + '逐行取出、剥掉行注释与块注释，再对每一行做 `FORBIDDEN_ONLINE_PATTERNS[].pattern` 的子串匹配：'
    + '命中任意一条即 `ONLINE_ENGINE_CALL` / `ONLINE_SUBPROCESS_CALL`（红）。'
    + '判据是**源码结构**，不是注释声明；测试把在线段替换成含引擎调用的版本再跑同一判据，必须红。',
  offline_separated: '离线入口必须在 `OFFLINE_SECTION_MARKER` 之后导出，且出现在 `OFFLINE_ENTRYPOINTS` 里；'
    + '在线段里出现离线入口名即 `OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION`（红）。',
  recall_bounds: `召回数量必须落在 [${RECALL_MIN}, ${RECALL_MAX}]；`
    + '越界时**必须**同时给出 `shortfall_reason` / `overflow_reason`（为什么凑不出来 / 为什么多），'
    + '否则 `RECALL_COUNT_UNEXPLAINED`（红）。已经选满六只、剩余槽位为 0 时召回数按剩余槽位如实报告。',
  deterministic: '同一份输入连续两次调用，`recallCandidates` / `beamComplete` / `scoreTeams` /'
    + ' `progressiveNext` 的 `JSON.stringify` 结果必须逐字节相同（含固定 tie-break），否则 `NONDETERMINISTIC`（红）。',
  constraints: '`must_include` 必须在队里、`must_exclude` 不许在队里、`locked` 必须在队里，'
    + '违反任意一条即 `CONSTRAINT_VIOLATED`（红）。',
  ranker_honesty: "没有注入可用 `ranker` 时 `ranker_status` 只能是 `missing`，`confidence` 必须是 "
    + '`ENGINE_HYPOTHESIS`；出现 `win_rate` / 伪精确百分数 / 社区榜单标签即 `PSEUDO_PRECISION`（红）。',
  progressive_three: `\`progressiveNext\` 在已选 2～5 只时必须返回**恰好** ${PROGRESSIVE_STRATEGIES.length} 个候选，`
    + '每个带一个 `tradeoff_label`（强度 / 稳定 / 偏好保留三选一），否则 `PROGRESSIVE_NOT_THREE`（红）。',
  candidate_universe: '候选宇宙来自注入的 owned + pack（`facts.candidate_universe`），'
    + '不是硬编码白名单：审计要求 `universe_size` 与注入数据一致，且 `pool_size` 可以为任意值'
    + '（测试把注入池换成更小的/更大的子集，输出必须跟着变）——否则 `WHITELIST_FIXED_POOL`（红）。',
  evidence: '每个候选与每支队伍都必须带非空 `machine_evidence[]`（source_file + pointer + field）'
    + '与 `unverified[]`，否则 `EVIDENCE_MISSING`（红）。',
  latency: '延迟报告必须把实测 P50/P95 与 `LATENCY_BUDGET_MS` 逐项对照；'
    + '超预算却写 `within_budget: true` 即 `LATENCY_BUDGET_FALSE_PASS`（红）。',
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const arr = (value) => (Array.isArray(value) ? value : []);
const stableJson = (value) => JSON.stringify(value);
const uniqueSorted = (values) => [...new Set(values)].sort();
const round = (value, decimals = SCORE_DECIMALS) => (Number.isFinite(value)
  ? Number(value.toFixed(decimals)) : value);

/** 证据项：与 RC-302 同形（source_file / pointer / field / value / note）。 */
export const evidence = (sourceFile, pointer, field, value, note = null) => ({
  source_file: sourceFile, pointer, field, value, note,
});

/** 审计问题：`{code, where, detail}`。 */
const auditProblem = (code, where, detail) => ({code, where, detail});
export const formatAuditProblem = (p) => `[${p.code}] ${p.where}：${p.detail}`;

// ─────────────────────────────────────────────────────────────────────────
// 规则打分：权重是**公开的工程假设**，不是训练出来的模型
// ─────────────────────────────────────────────────────────────────────────

/**
 * 规则打分权重。它们**没有任何对局数据支持**（台账里没有对应条目），所以一律标
 * `ENGINE_HYPOTHESIS`。数值只用来做**相对排序**，不许读成强度分/胜率。
 */
export const RULE_SCORE_WEIGHTS = Object.freeze({
  coverage: 0.30,      // 队伍对 18 个攻击系别有没有抗性承接
  synergy: 0.20,       // 未承接弱点数（越少越好）
  speed: 0.15,         // 速度层次是否分散（只用冻结档位值）
  energy: 0.10,        // 能耗曲线：有没有 0 费出口、超限技能少
  respond: 0.10,       // 学招池里的应对种类覆盖
  pivot: 0.05,         // 学招池里的换入/离场手段
  preference: 0.05,    // favourite / locked 等玩家偏好
  evidence: 0.05,      // 证据层级（冻结层 > 图鉴推测）
});

/** 规则打分的原始分项 → 0～100 的**排序用**分数（不是胜率、不是强度分）。 */
export function ruleScore(features) {
  const weights = RULE_SCORE_WEIGHTS;
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const parts = {};
  for (const [key, weight] of Object.entries(weights)) {
    const value = Number(features?.[key]);
    parts[key] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    parts[`${key}_weight`] = weight;
  }
  const raw = Object.keys(weights).reduce((sum, key) => sum + parts[key] * weights[key], 0) / total;
  return {score: round(raw * 100), parts, raw: round(raw)};
}

// ─────────────────────────────────────────────────────────────────────────
// 索引：候选宇宙的廉价特征（一次构建，反复用）
// ─────────────────────────────────────────────────────────────────────────

/** 图鉴 tier 的应对种类只认 `native_skills`（血脉/技能石不在冻结数据里，不推断）。 */
const CATALOG_TIER_LEARNSET_TIER = 'native_only';

/**
 * 建候选索引。**只读**注入的数据；缺哪一份在 `missing` 里如实写出来。
 * 属性倍率、能耗、应对词条、换入/离场词条全部**复用 RC-302 的判据函数**，不另写一套。
 */
export function buildCandidateIndex(inputs = {}) {
  const index = buildGapIndex(inputs);
  const fullCatalog = index.fullCatalog;
  const learnsets = index.learnsets;
  const packPets = index.packPetEntities;
  const ownedById = index.instances;
  const ownedSpecies = new Set([...ownedById.values()].map((i) => i.species_id));
  const catalogSpeciesInOwned = new Set([...ownedSpecies]);
  // owned 实例按 instance_id 排好的数组：召回建池时按它的顺序遍历（顺序固定 ⇒ 输出确定）。
  const ownedSorted = [...ownedById.values()].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
  // 每个物种在 owned 里 instance_id 最小的实例（硬要求要判断「这个物种有没有实例版」）。
  const firstInstanceBySpecies = new Map();
  for (const instance of ownedSorted) {
    if (!firstInstanceBySpecies.has(instance.species_id)) firstInstanceBySpecies.set(instance.species_id, instance);
  }

  const missing = [...index.missing];
  const petTypeMissing = packPets.filter((row) => arr(row.entity?.tags?.types).length === 0);
  const attackTypes = index.attackTypes;
  // 物种 → pack 实体指针的查表（`packPets` 是数组，逐候选线性扫会变成 O(池子 × 实体数)）。
  const packBySpecies = new Map();
  for (const row of packPets) {
    if (typeof row?.entity?.id === 'string' && !packBySpecies.has(row.entity.id)) packBySpecies.set(row.entity.id, row);
  }

  // 每个物种的**廉价特征**（一份，实例与图鉴共用）。
  //
  // 「应对种类」与「换入/离场手段」要用到 `respondVariantsOf` / `isPivotSkill` 逐技能扫描述，
  // 对 600+ 个物种全算一遍会白烧掉召回预算。它们不是召回特征，所以做成**惰性取值器**：
  // 只有真的被读（进候选记录、进队伍特征）时才建，建完缓存进 `speciesTools`。
  const speciesTools = new Map();
  const learnsetToolsFor = (speciesId) => {
    if (speciesTools.has(speciesId)) return speciesTools.get(speciesId);
    const learnset = learnsets.get(speciesId) ?? null;
    const poolSkills = learnset ? learnset.skill_ids.map((id) => index.skills.get(id)).filter(Boolean) : null;
    const tools = poolSkills ? {
      respond_variants: uniqueSorted(poolSkills.flatMap(respondVariantsOf)),
      pivot_tools: uniqueSorted(poolSkills.filter(isPivotSkill).map((s) => s.skill_id)),
      learnset_tier: learnset?.source_file?.includes('layer-playable-48') ? 'frozen_overlay' : 'frozen_baseline',
    } : {respond_variants: null, pivot_tools: null, learnset_tier: null};
    speciesTools.set(speciesId, tools);
    return tools;
  };
  const speciesFeature = new Map();
  const featureFor = (speciesId) => {
    if (speciesFeature.has(speciesId)) return speciesFeature.get(speciesId);
    const roster = index.roster.get(speciesId) ?? null;
    const catalog = fullCatalog.get(speciesId) ?? null;
    const pack = packBySpecies.get(speciesId) ?? null;
    const types = arr(roster?.types).length ? [...roster.types]
      : (arr(pack?.entity?.tags?.types).length ? [...pack.entity.tags.types]
        : (arr(catalog?.types).length ? [...catalog.types] : null));
    const learnset = learnsets.get(speciesId) ?? null;
    const know = {
      species_id: speciesId,
      species_name: roster?.name ?? catalog?.name ?? pack?.entity?.name ?? null,
      types,
      types_source: roster?.types ? `${FROZEN_PATHS.roster48}#pets[pet_id=${speciesId}].types`
        : (arr(pack?.entity?.tags?.types).length ? `data/roco/game-data-pack/v2/pack.json#${pack.pointer}.tags.types`
          : (catalog?.types ? `${FROZEN_PATHS.fullCatalog}#pets[pet_id=${speciesId}].types` : null)),
      validated: Boolean(roster) || learnset !== null,
      has_frozen_learnset: learnset !== null,
      learnset_skill_count: learnset ? learnset.skill_ids.length : 0,
      // 速度：冻结层有 speed_tier；否则只能用 full-catalog 的 stats.spe（knowledge_only）。
      spe: typeof roster?.stats?.spe === 'number' ? roster.stats.spe
        : (typeof catalog?.stats?.spe === 'number' ? catalog.stats.spe : null),
      spe_status: typeof roster?.stats?.spe === 'number' ? 'validated'
        : (typeof catalog?.stats?.spe === 'number' ? 'knowledge_only' : 'unknown'),
      speed_tier: typeof roster?.speed_tier === 'string' ? roster.speed_tier : null,
      role: typeof roster?.role === 'string' ? roster.role : null,
      // 应对 / 换入手段：惰性（见上面的 `learnsetToolsFor`）。读它们就等于付一次建表成本。
      get respond_variants() {return learnsetToolsFor(speciesId).respond_variants;},
      get pivot_tools() {return learnsetToolsFor(speciesId).pivot_tools;},
      get learnset_tier() {return learnsetToolsFor(speciesId).learnset_tier;},
      evidence: {
        types: roster?.types ? {source_file: FROZEN_PATHS.roster48, pointer: `pets[pet_id=${speciesId}].types`}
          : (arr(pack?.entity?.tags?.types).length ? {source_file: 'data/roco/game-data-pack/v2/pack.json', pointer: `${pack.pointer}.tags.types`}
            : (catalog?.types ? {source_file: FROZEN_PATHS.fullCatalog, pointer: `pets[pet_id=${speciesId}].types`} : null)),
        speed: typeof roster?.stats?.spe === 'number'
          ? {source_file: FROZEN_PATHS.roster48, pointer: `pets[pet_id=${speciesId}].stats.spe`}
          : (typeof catalog?.stats?.spe === 'number'
            ? {source_file: FROZEN_PATHS.fullCatalog, pointer: `pets[pet_id=${speciesId}].stats.spe`} : null),
        pool: learnset ? {source_file: learnset.source_file, pointer: `learnsets.${speciesId}`} : null,
      },
    };
    speciesFeature.set(speciesId, know);
    return know;
  };

  // 候选宇宙的规模：owned 实例 + 图鉴物种（去重）。
  const universeSpecies = new Set([...ownedSpecies]);
  for (const row of packPets) universeSpecies.add(row.entity.id);

  const speedValues = [];
  for (const speciesId of universeSpecies) {
    const feature = featureFor(speciesId);
    if (typeof feature.spe === 'number') speedValues.push(feature.spe);
  }
  speedValues.sort((a, b) => a - b);

  return {
    gapIndex: index,
    registry: index.registry,
    skills: index.skills,
    types: index.types,
    attackTypes,
    scaleByCombo: index.scaleByCombo,
    roster: index.roster,
    learnsets,
    fullCatalog,
    instances: ownedById,
    packPetEntities: packPets,
    ownedSpecies,
    universeSpecies,
    ownedSorted,
    firstInstanceBySpecies,
    packBySpecies,
    speciesFeature,
    featureFor,
    speedValues,
    missing: uniqueSorted(missing),
    facts: {
      owned_instances: ownedById.size,
      owned_species: ownedSpecies.size,
      catalog_pet_entities: packPets.length,
      catalog_species: universeSpecies.size,
      validated_species: index.roster.size,
      species_with_frozen_learnset: learnsets.size,
      registered_attack_types: attackTypes.length,
      pets_without_type_tags: petTypeMissing.length,
      catalog_tier_learnset_tier: CATALOG_TIER_LEARNSET_TIER,
      speed_values_available: speedValues.length,
      speed_validated: [...universeSpecies].filter((id) => featureFor(id).spe_status === 'validated').length,
      speed_knowledge_only: [...universeSpecies].filter((id) => featureFor(id).spe_status === 'knowledge_only').length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 便宜特征：属性互补 / 速度层次 / 能耗曲线 / synergy answers / 偏好
// ─────────────────────────────────────────────────────────────────────────

/** 一个成员对某个攻击系别的防御倍率（整数标度 ×4）；组合键没登记 ⇒ null（未知，不猜成 1）。 */
export function defenceScale(index, types, attackType) {
  if (!Array.isArray(types) || types.length === 0) return null;
  const table = index.scaleByCombo.get(types.join('|'));
  if (!table) return null;
  return table.has(attackType) ? table.get(attackType) : 4;
}

/** 弱点 / 抗性清单（倍率 > 4 是弱，< 4 是抗；未登记的组合键整体 unknown）。 */
export function weaknessProfile(index, types) {
  const weak = [];
  const resist = [];
  for (const attackType of index.attackTypes) {
    const scale = defenceScale(index, types, attackType);
    if (scale === null) continue;
    if (scale > 4) weak.push(attackType);
    else if (scale < 4) resist.push(attackType);
  }
  return {weak, resist, known: Array.isArray(types) && types.length > 0 && index.scaleByCombo.has(types.join('|'))};
}

/** 速度层次：在**候选宇宙内**按三分位分档（fast / mid / slow）；没有速度值的记 null。 */
export function speedBandFor(index, spe) {
  if (typeof spe !== 'number' || index.speedValues.length === 0) return null;
  const values = index.speedValues;
  const third = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  const low = third(1 / 3);
  const high = third(2 / 3);
  if (spe <= low) return 'slow';
  if (spe <= high) return 'mid';
  return 'fast';
}

/** 一个成员的能耗曲线（只从它自己的**具体 build** 算；没有 build 就是 unknown）。 */
function energyCurve(index, skillIds, rulesetEnergyCap) {
  const ids = arr(skillIds).filter((id) => typeof id === 'string');
  if (ids.length === 0) {
    return {known: false, min: null, max: null, sum: null, zero_cost: null, over_cap: null, skills: []};
  }
  const energies = ids.map((id) => index.skills.get(id)?.energy ?? null);
  const numbers = energies.filter((e) => typeof e === 'number');
  return {
    known: numbers.length === ids.length,
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
    sum: numbers.length ? numbers.reduce((a, b) => a + b, 0) : null,
    zero_cost: numbers.filter((e) => e === 0).length,
    over_cap: typeof rulesetEnergyCap === 'number' ? numbers.filter((e) => e > rulesetEnergyCap).length : null,
    skills: ids.map((id, i) => ({skill_id: id, energy: energies[i]})),
  };
}

/**
 * 队伍（或部分队伍）的结构特征。它是在线打分的**唯一**输入形状，
 * 也是 `scoreTeams` 里 `ranker.features` 的契约。
 */
export function teamFeatures(index, members, context = {}) {
  const rulesetEnergyCap = Number.isFinite(context.ruleset_energy_cap) ? context.ruleset_energy_cap : null;
  const profiles = members.map((member) => (member.profile ? member.profile
    : profileOf(index, member.ref ?? member, {rulesetEnergyCap})));
  return featuresOfProfiles(index, profiles, context);
}

/** 从成员画像算队伍特征。 */
function featuresOfProfiles(index, profiles, context = {}) {
  const attackTypes = index.attackTypes;
  const known = profiles.filter((p) => p.weakness.known);
  const unknownMembers = profiles.filter((p) => !p.weakness.known);

  // coverage：对每个攻击系别，队伍里有没有**抗性**承接（倍率 < 1）
  const resistedTypes = uniqueSorted(known.flatMap((p) => p.weakness.resist));
  const coverage = attackTypes.length ? resistedTypes.length / attackTypes.length : 0;
  const uncovered = attackTypes.filter((t) => !resistedTypes.includes(t));

  // synergy：每个成员每个弱点的 answers 计数（队友里能接 T 的个数）
  const answers = [];
  const shared = new Map();
  for (const attackType of attackTypes) {
    shared.set(attackType, known.filter((p) => p.weakness.weak.includes(attackType)).length);
  }
  let unanswered = 0;
  const unansweredList = [];
  for (const profile of known) {
    for (const attackType of profile.weakness.weak) {
      const answerCount = known.filter((other) => other !== profile
        && (defenceScale(index, other.types, attackType) ?? 4) < 4).length;
      answers.push({key: profile.key, attack_type: attackType, answers: answerCount, shared: shared.get(attackType)});
      if (answerCount === 0) {
        unanswered += 1;
        unansweredList.push({key: profile.key, attack_type: attackType, shared: shared.get(attackType)});
      }
    }
  }
  const weaknessTotal = known.reduce((sum, p) => sum + p.weakness.weak.length, 0);
  const synergy = weaknessTotal === 0 ? 1 : 1 - unanswered / weaknessTotal;

  // speed：速度层次的分散度（只有拿到速度值的成员参与）
  const bands = uniqueSorted(profiles.map((p) => p.speed_band).filter(Boolean));
  const withSpeed = profiles.filter((p) => p.speed_band).length;
  const speed = withSpeed === 0 ? 0 : Math.min(1, bands.length / Math.min(3, Math.max(1, profiles.length)));

  // energy：最低费越低越好 + 超限技能越少越好
  const curves = profiles.map((p) => p.energy).filter((c) => c.known);
  const zeroCost = curves.reduce((sum, c) => sum + c.zero_cost, 0);
  const overCap = curves.reduce((sum, c) => sum + (c.over_cap ?? 0), 0);
  const energy = curves.length === 0 ? 0
    : Math.max(0, Math.min(1, 0.5 * (zeroCost > 0 ? 1 : 0) + 0.5 * (1 - overCap / (curves.length * 4))));

  // respond：应对种类覆盖（学招池口径）
  const respondVariants = uniqueSorted(profiles.flatMap((p) => p.respond_variants ?? []));
  const respond = respondVariants.length / 3;

  // pivot：有换入/离场手段的成员占比
  const pivotHolders = profiles.filter((p) => (p.pivot_tools ?? []).length > 0).length;
  const pivot = profiles.length ? pivotHolders / profiles.length : 0;

  // preference：收藏 / 锁定
  const favourites = profiles.filter((p) => p.favourite === true).length;
  const locked = profiles.filter((p) => p.locked === true).length;
  const preference = profiles.length ? Math.min(1, (favourites + locked) / profiles.length) : 0;

  // evidence：验证层成员占比 + 有具体 build 的占比
  const validated = profiles.filter((p) => p.validated === true).length;
  const withBuild = profiles.filter((p) => p.build_known === true).length;
  const evidenceScore = profiles.length ? 0.5 * (validated / profiles.length) + 0.5 * (withBuild / profiles.length) : 0;

  const typesMultiset = uniqueSorted(known.flatMap((p) => p.types));
  return {
    size: profiles.length,
    coverage,
    synergy,
    speed,
    energy,
    respond,
    pivot,
    preference,
    evidence: evidenceScore,
    counts: {
      members: profiles.length,
      members_type_known: known.length,
      members_type_unknown: unknownMembers.length,
      resisted_attack_types: resistedTypes.length,
      uncovered_attack_types: uncovered.length,
      weakness_total: weaknessTotal,
      unanswered_weaknesses: unanswered,
      shared_weakness_types: [...shared.entries()].filter(([, count]) => count >= 3).map(([t]) => t).sort(),
      zero_cost_moves: zeroCost,
      moves_over_ruleset_cap: overCap,
      respond_variants: respondVariants,
      pivot_holders: pivotHolders,
      favourites,
      locked,
      validated_members: validated,
      members_with_build: withBuild,
    },
    types_multiset: typesMultiset,
    speed_bands: bands,
    unanswered_weaknesses: unansweredList,
    answers,
    ruleset_energy_cap: context.ruleset_energy_cap ?? null,
  };
}

/** 成员画像：候选（实例或图鉴物种）的廉价特征集合。 */
function profileOf(index, ref, {rulesetEnergyCap = null} = {}) {
  const kind = ref.kind === 'catalog' ? 'catalog' : (ref.kind === 'owned' ? 'owned' : (ref.kind === 'species' ? 'catalog' : 'owned'));
  const speciesId = ref.species_id ?? (kind === 'owned'
    ? index.instances.get(ref.instance_id ?? ref.id)?.species_id
    : (ref.id ?? ref.species_id));
  const feature = index.featureFor(speciesId);
  const instance = kind === 'owned'
    ? (index.instances.get(ref.instance_id ?? ref.id) ?? null) : null;
  const skillIds = instance ? arr(instance.skills) : [];
  const buildKnown = skillIds.length > 0;
  const energy = energyCurve(index, skillIds, rulesetEnergyCap);
  const key = `${kind}:${instance?.instance_id ?? speciesId}`;
  return {
    key,
    kind,
    namespace: kind === 'owned' ? 'owned_instance' : 'catalog_species',
    instance_id: instance?.instance_id ?? null,
    species_id: speciesId,
    species_name: instance?.species_name ?? feature.species_name,
    types: feature.types ? [...feature.types] : null,
    types_source: feature.types_source,
    weakness: weaknessProfile(index, feature.types),
    spe: feature.spe,
    spe_status: feature.spe_status,
    speed_tier: feature.speed_tier,
    speed_band: speedBandFor(index, feature.spe),
    role: feature.role,
    favourite: instance?.favourite === true,
    locked: instance?.locked === true,
    validated: feature.validated,
    has_frozen_learnset: feature.has_frozen_learnset,
    learnset_skill_count: feature.learnset_skill_count,
    respond_variants: feature.respond_variants ? [...feature.respond_variants] : null,
    pivot_tools: feature.pivot_tools ? [...feature.pivot_tools] : null,
    learnset_tier: feature.learnset_tier,
    build_known: buildKnown,
    skill_ids: buildKnown ? [...skillIds] : null,
    energy,
    evidence: feature.evidence,
    unknown_reason: [
      !feature.types ? '属性未知（冻结 roster / pack tags / full-catalog 三处都没有）' : null,
      !feature.has_frozen_learnset ? '没有冻结学招表（四技能与合法性未校验）' : null,
      !buildKnown ? '没有具体 build（四个技能未知，能耗曲线不可算）' : null,
      feature.spe_status === 'knowledge_only' ? '速度只有 full-catalog 的 base stats（knowledge_only，面板换算公式未知）' : null,
      feature.spe_status === 'unknown' ? '速度未知' : null,
    ].filter(Boolean),
  };
}

/** 注入的 policy 默认值：本次请求是按「我的箱子」还是按「全量图鉴」召回。 */
export function resolvePolicy(policy = {}) {
  const universe = policy.candidate_universe === 'owned' ? 'owned' : 'catalog';
  return {
    candidate_universe: universe,
    allow_unowned: policy.allow_unowned === true,
    species_unique: policy.species_unique === true,
    include_catalog_species: policy.include_catalog_species !== false && universe === 'catalog',
    max_catalog_share: Number.isFinite(policy.max_catalog_share) ? policy.max_catalog_share : 0.5,
  };
}

/** 请求里哪些条目是**硬要求**（locked ∪ must_include，实例或物种都算）。 */
function hardRequirements(request, index) {
  const required = [];
  const locked = new Set(arr(request?.locked));
  for (const value of uniqueSorted([...arr(request?.locked), ...arr(request?.must_include)])) {
    const resolved = resolveReference(index.registry, value);
    if (!resolved) continue;
    const speciesId = resolved.kind === 'instance'
      ? index.instances.get(resolved.instance_id)?.species_id : resolved.species_id;
    if (!speciesId) continue;
    const instance = resolved.kind === 'instance' ? index.instances.get(resolved.instance_id) : null;
    required.push({
      raw: value,
      kind: instance ? 'owned' : 'catalog',
      id: instance ? instance.instance_id : speciesId,
      instance_id: instance?.instance_id ?? null,
      species_id: speciesId,
      locked: locked.has(value),
      via: locked.has(value) ? 'locked' : 'must_include',
    });
  }
  return required;
}

/** 请求里「已经在队里」的实例（locked ∪ selected），去重且顺序稳定。 */
function teamRefs(request, index) {
  const out = [];
  const seen = new Set();
  for (const [via, list] of [['locked', arr(request?.locked)], ['selected', arr(request?.selected)]]) {
    for (const value of uniqueSorted(list)) {
      const resolved = resolveReference(index.registry, value);
      if (!resolved || resolved.kind !== 'instance') continue;
      if (seen.has(resolved.instance_id)) continue;
      seen.add(resolved.instance_id);
      out.push({kind: 'owned', id: resolved.instance_id, instance_id: resolved.instance_id, species_id: resolved.species_id, via});
    }
  }
  for (const item of hardRequirements(request, index)) {
    if (item.kind !== 'owned') continue;
    if (seen.has(item.instance_id)) continue;
    seen.add(item.instance_id);
    out.push({kind: 'owned', id: item.instance_id, instance_id: item.instance_id, species_id: item.species_id, via: item.via});
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// ① 召回（在线：只读静态数据 + 便宜特征）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 召回 20～50 个候选。排序依据全部是**便宜特征**：
 *   属性互补（能不能接队伍现在没接住的系别）× 速度层次 × 能耗曲线 × `synergy` 的 answers
 *   计数 × favourite / locked 约束 × 证据层级。
 *
 * @param {object} request  RC-301 校验过的请求（`docs/roco/TEAM-REQUEST.md`）
 * @param {object} inputs
 * @param {object} inputs.owned   `data/roco/owned/owned-pets.json`
 * @param {object} inputs.pack    `data/roco/game-data-pack/v2/pack.json`
 * @param {object} [inputs.frozen] 冻结迁移层（roster-48 / skills / learnsets / types / full-catalog）
 * @param {object} [inputs.gaps]  RC-302 的 `diagnoseTeamGaps()` 结果（可选：只用来标记「要接的弱点」）
 * @param {object} [inputs.policy] `{candidate_universe, allow_unowned, species_unique, include_catalog_species, max_catalog_share}`
 * @param {object} [inputs.limits] `{min, max}`（默认 20 / 50）
 * @returns {{ok:boolean, candidates:Array, count:number, ...}}
 */
export function recallCandidates(request, inputs = {}) {
  const index = inputs.__index ?? buildCandidateIndex(inputs);
  const policy = resolvePolicy(inputs.policy);
  const limits = {
    min: Number.isInteger(inputs.limits?.min) ? inputs.limits.min : RECALL_MIN,
    max: Number.isInteger(inputs.limits?.max) ? inputs.limits.max : RECALL_MAX,
  };
  const teamSize = Number.isInteger(request?.team_size) ? request.team_size : null;
  const reasons = [];

  const mustExclude = new Set(arr(request?.must_exclude));
  const excludeSpecies = new Set();
  for (const value of mustExclude) {
    const resolved = resolveReference(index.registry, value);
    if (!resolved) continue;
    excludeSpecies.add(resolved.kind === 'instance'
      ? index.instances.get(resolved.instance_id)?.species_id : resolved.species_id);
  }
  const inTeam = teamRefs(request, index);
  const inTeamIds = new Set(inTeam.map((row) => row.id));
  const inTeamSpecies = new Set(inTeam.map((row) => row.species_id));
  const required = hardRequirements(request, index);
  const requiredSpecies = new Set(required.map((row) => row.species_id));

  // 硬约束一致性的结构性检查（真正的可满足性算术在 RC-302；这里只做「候选宇宙够不够」）。
  if (!index.instances.size && !index.packPetEntities.length) {
    reasons.push('owned 与 pack 都没有候选：候选宇宙为空，无法召回');
  }
  const rulesetEnergyCap = Number.isFinite(inputs.ruleset_energy_cap) ? inputs.ruleset_energy_cap : null;

  // 队伍当前特征（用已选成员算；没有成员时是空队特征）。
  const currentProfiles = inTeam.map((row) => profileOf(index, row.ref ?? row, {rulesetEnergyCap}));
  const currentFeatures = featuresOfProfiles(index, currentProfiles, {ruleset_energy_cap: rulesetEnergyCap});
  // 要接住的系别：已诊断出的未承接弱点；没有 gaps 时用「队伍目前没有任何抗性的系别」。
  const gapIndexRows = arr(inputs.gaps?.gaps);
  const targetTypes = uniqueSorted(gapIndexRows.length
    ? gapIndexRows.filter((g) => g.dimension === 'synergy' && g.id.startsWith('synergy.unanswered_weakness.'))
      .map((g) => g.value?.attack_type).filter((t) => typeof t === 'string')
    : currentFeatures.unanswered_weaknesses.map((row) => row.attack_type));
  const uncoveredTypes = index.attackTypes.filter((t) => !currentFeatures.types_multiset.length
    ? true : !currentProfiles.some((p) => (defenceScale(index, p.types, t) ?? 4) < 4));

  // ── 候选宇宙：owned 实例 +（可选）图鉴物种 ──
  //
  // 硬要求（locked / must_include）是**必须进队**的条目：只要它在 owned 里有实例，
  // 就用实例版进池（实例有具体 build，能耗曲线才算得出）；owned 里没有才用图鉴物种版。
  // 这条规则保证召回里一定包含硬要求，否则束搜索只能补空槽、补不出满足约束的队伍。
  const requiredInstance = index.firstInstanceBySpecies;   // species_id → owned 里 instance_id 最小的实例
  const requiredOwnedInstanceIds = new Set();
  const requiredCatalogSpecies = new Set();
  for (const row of required) {
    if (inTeamSpecies.has(row.species_id)) continue;
    if (row.instance_id) requiredOwnedInstanceIds.add(row.instance_id);
    else if (requiredInstance.has(row.species_id)) requiredOwnedInstanceIds.add(requiredInstance.get(row.species_id).instance_id);
    else {
      requiredCatalogSpecies.add(row.species_id);
      if (!requiredSpecies.has(row.species_id)) requiredSpecies.add(row.species_id);
    }
  }

  const pool = [];
  for (const instance of index.ownedSorted) {
    if (mustExclude.has(instance.instance_id) || excludeSpecies.has(instance.species_id)) continue;
    if (inTeamIds.has(instance.instance_id)) continue;
    const isRequired = requiredOwnedInstanceIds.has(instance.instance_id);
    if (!isRequired) {
      if (policy.species_unique && inTeamSpecies.has(instance.species_id)) continue;
      if (policy.species_unique
        && [...requiredOwnedInstanceIds].some((id) => index.instances.get(id)?.species_id === instance.species_id)) continue;
    }
    pool.push({kind: 'owned', required: isRequired, ref: {
      kind: 'owned', id: instance.instance_id, instance_id: instance.instance_id, species_id: instance.species_id,
    }});
  }
  for (const speciesId of [...requiredCatalogSpecies].sort()) {
    pool.push({kind: 'catalog', required: true, ref: {kind: 'catalog', id: speciesId, species_id: speciesId}});
  }
  if (policy.include_catalog_species) {
    for (const row of [...index.packPetEntities].sort((a, b) => (a.entity.id < b.entity.id ? -1 : 1))) {
      const speciesId = row.entity.id;
      if (mustExclude.has(speciesId) || excludeSpecies.has(speciesId)) continue;
      if (inTeamSpecies.has(speciesId)) continue;                       // 已在队里的物种不再召回
      if (requiredSpecies.has(speciesId)) continue;                     // 硬要求已经按上面两条路径进池
      // 玩家已经拥有这个物种的实例 ⇒ 实例版已经在池里，图鉴版不再重复（避免同一物种两次）。
      if (index.ownedSpecies.has(speciesId)) continue;
      if (policy.candidate_universe !== 'catalog') continue;
      pool.push({kind: 'catalog', required: false, ref: {kind: 'catalog', id: speciesId, species_id: speciesId}});
    }
  }

  // ── 打分：全部是便宜特征 ──
  const scored = pool.map((row) => {
    const profile = profileOf(index, row.ref, {rulesetEnergyCap});
    const scores = recallScores(index, profile, currentProfiles, currentFeatures, {targetTypes, uncoveredTypes});
    return {profile, scores, required: row.required === true,
      total: round(Object.values(scores.parts).reduce((sum, v) => sum + v, 0))};
  });

  // 硬要求优先（它们必须在队里，召回必须先把它们摆在前面）。
  const requiredFirst = (row) => (row.required ? 1 : 0);
  scored.sort((a, b) => {
    const req = requiredFirst(b) - requiredFirst(a);
    if (req !== 0) return req;
    if (b.total !== a.total) return b.total - a.total;
    const ka = `${a.profile.kind}|${a.profile.species_id}|${a.profile.instance_id ?? ''}`;
    const kb = `${b.profile.kind}|${b.profile.species_id}|${b.profile.instance_id ?? ''}`;
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });

  // 「policy 收窄后真正可用的条目」：
  //   · candidate_universe = owned ⇒ 图鉴物种不算数；
  //   · favourites_only = true    ⇒ 非收藏实例不算数；
  //   · species_unique            ⇒ 已在队里/已被硬要求占用的物种不再算第二个。
  // 它同时是**召回数的上限**和**有效下界的上限**：用宽松的 `scored.length` 会让
  // 「凑不满」被图鉴规模掩盖，那是自欺欺人。
  const favOnly = request?.favourites_only === true;
  const eligibleSpecies = new Set();
  for (const row of index.ownedSorted) {
    if (favOnly && row.favourite !== true) continue;
    if (mustExclude.has(row.instance_id) || excludeSpecies.has(row.species_id)) continue;
    if (inTeamIds.has(row.instance_id)) continue;
    if (policy.species_unique
      && (inTeamSpecies.has(row.species_id) || eligibleSpecies.has(row.species_id))) continue;
    eligibleSpecies.add(row.species_id);
  }
  if (policy.include_catalog_species) {
    for (const speciesId of requiredCatalogSpecies) eligibleSpecies.add(speciesId);
    if (policy.candidate_universe === 'catalog') {
      for (const speciesId of index.universeSpecies) {
        if (index.ownedSpecies.has(speciesId)) continue;
        if (mustExclude.has(speciesId) || excludeSpecies.has(speciesId)) continue;
        if (inTeamSpecies.has(speciesId) || requiredSpecies.has(speciesId)) continue;
        eligibleSpecies.add(speciesId);
      }
    }
  }

  // 数量：召回**不**按剩余槽位收窄——候选数是「从候选宇宙里挑出多少个值得看的」，
  // 不是「还要填几个槽」。剩余槽位只影响束搜索要补几层，以及有多少候选真的能被用上。
  const remainingSlots = teamSize === null ? null : Math.max(0, teamSize - inTeam.length);
  const wanted = Math.min(rowCountFor(scored.length, limits), Math.max(0, eligibleSpecies.size));
  const selected = applyCatalogShare(scored, wanted, policy);

  const count = selected.length;
  let shortfallReason = null;
  let overflowReason = null;
  // 下界判定用**名义下界** `limits.min`（默认 20）：契约就是 20～50，凑不满就必须解释，
  // 不许用「policy 收窄后可用条目更少」把门槛悄悄降下来（那正是自欺欺人）。
  // `eligible_after_policy` 照实报告，用来解释「为什么池子里只有这么多」。
  const nominalMin = limits.min;
  if (count < nominalMin) {
    shortfallReason = buildShortfallReason({
      count, effectiveMin: eligibleSpecies.size, limits, remainingSlots, pool: scored.length,
      excludedByPolicy: poolSizeRaw(index) - pool.length, index, policy, teamSize, inTeam,
    });
  }
  if (count > limits.max) {
    overflowReason = `${count} 个超过上界 ${limits.max}：预算参数 limits.max 被显式调大（默认 ${RECALL_MAX}），`
      + '不是候选宇宙真的需要这么多';
  }
  // 剩余槽位不足时，召回照样给足，但**必须**说清「其中只有几个真的补得进队」。
  const usableForSlots = remainingSlots === null ? count : Math.min(count, remainingSlots);
  const slotNote = remainingSlots !== null && remainingSlots < count
    ? `队伍已经有 ${inTeam.length} / ${teamSize} 只：召回 ${count} 个候选，其中最多 ${usableForSlots} 个能被补进剩下的槽位；`
      + '其余候选仍然是「可选目标」（玩家换掉某一只时用得上），本条不把它们当成已选'
    : null;

  const candidates = selected.map((row, rank) => candidateRecord(index, row, rank, {policy, rulesetEnergyCap, targetTypes}));
  const ok = count >= nominalMin && count <= limits.max;
  return {
    ok,
    candidates,
    count,
    limits: {...limits, eligible_after_policy: eligibleSpecies.size},
    remaining_slots: remainingSlots,
    usable_for_slots: usableForSlots,
    slot_note: slotNote,
    shortfall_reason: shortfallReason,
    overflow_reason: overflowReason,
    // 召回段自己也有「补齐不了」的情形（候选宇宙为空、请求说不上槽位）：与 beam 的 problems 同形，
    // 由 `buildTeamCandidatePlan` 汇总。空数组表示这一段没有意见。
    problems: reasons.map((detail) => auditProblem('RECALL_UNSATISFIABLE', 'recall', detail)),
    pool: {
      universe: policy.candidate_universe,
      pool_size: pool.length,
      universe_size: index.facts.owned_instances + index.facts.catalog_pet_entities,
      owned_pool: pool.filter((row) => row.kind === 'owned').length,
      catalog_pool: pool.filter((row) => row.kind === 'catalog').length,
      eligible_after_policy: eligibleSpecies.size,
      favourites_only: favOnly,
      excluded_by_constraints: mustExclude.size + excludeSpecies.size,
    },
    policy,
    features: currentFeatures,
    target_types: targetTypes,
    uncovered_types: uncoveredTypes,
    facts: index.facts,
    unverified: recallUnverified(index, policy),
    machine_evidence: [
      evidence('data/roco/owned/owned-pets.json', 'instances', 'count', index.facts.owned_instances,
        '玩家箱子口径的候选来源（实例级：有具体 build 才算得出能耗曲线）'),
      evidence('data/roco/game-data-pack/v2/pack.json', 'sections.distributable.entities[record_kind^=pet]', 'count',
        index.facts.catalog_pet_entities, '候选宇宙是 pack 的 600+ 宠物实体，不是当前 48 只迁移夹具'),
      evidence(FROZEN_PATHS.types, 'types', 'keys', index.attackTypes.length,
        '召回用的属性互补判据：18 个单系攻击系别'),
      evidence(FROZEN_PATHS.roster48, 'pets[].speed_tier', 'count_with_value', index.facts.speed_validated,
        '速度层次只认冻结档位；其余用 full-catalog 的 base stats 并标 knowledge_only'),
      evidence(FROZEN_PATHS.skills, 'skills[].energy', 'values',
        uniqueSorted(selected.flatMap((row) => arr(row.profile.energy?.skills).map((s) => s.energy)).filter((e) => typeof e === 'number')),
        '能耗曲线只从候选自己的 build 四个技能算'),
      evidence(RC303_REPORT_PATH, 'policy.candidate_universe', 'value', policy.candidate_universe,
        '候选宇宙口径是 policy，不是写死的白名单'),
    ],
    criteria: STRUCTURAL_CRITERIA.recall_bounds,
  };
}

const poolSizeRaw = (index) => index.facts.owned_instances + index.facts.catalog_pet_entities;

/** 召回数量：先满足下界，再不超过上界；池子不够就按池子大小如实给（另写短欠原因）。 */
function rowCountFor(poolLength, limits) {
  if (poolLength === 0) return 0;
  return Math.max(0, Math.min(poolLength, Math.max(limits.min, Math.min(limits.max, poolLength))));
}

/** 图鉴物种占比上限：`max_catalog_share` 是 policy 参数（默认 0.5），不是写死的名单。 */
function applyCatalogShare(rows, wanted, policy) {
  if (wanted >= rows.length) return rows.slice(0, wanted);
  if (!policy.include_catalog_species || policy.max_catalog_share >= 1) return rows.slice(0, wanted);
  const out = [];
  const deferred = [];
  let owned = 0;
  for (const row of rows) {
    if (out.length >= wanted) break;
    // 硬要求（must_include / locked）**永远不因为占比被挤掉**：挤掉它队伍就不满足约束了。
    if (row.required) {
      owned += 1;
      out.push(row);
      continue;
    }
    const ownedLimit = Math.max(0, wanted - Math.floor(wanted * policy.max_catalog_share));
    if (row.profile.kind === 'owned') {
      if (owned >= ownedLimit) { deferred.push(row); continue; }
      owned += 1;
      out.push(row);
    } else {
      if (out.filter((r) => r.profile.kind === 'catalog').length >= Math.floor(wanted * policy.max_catalog_share)) {
        deferred.push(row);
        continue;
      }
      out.push(row);
    }
  }
  // 名额没用满时按原顺序补齐（补齐只影响「多给哪些候选」，不影响硬约束）。
  if (out.length < wanted) {
    for (const row of [...deferred, ...rows]) {
      if (out.length >= wanted) break;
      if (!out.includes(row)) out.push(row);
    }
  }
  return out.slice(0, wanted);
}

function buildShortfallReason({count, effectiveMin, limits, remainingSlots, pool, excludedByPolicy, index, policy, teamSize, inTeam}) {
  const pieces = [`候选池打分后有 ${pool} 个可召回（下界 ${limits.min}、上界 ${limits.max}）`];
  if (pool === 0) {
    pieces.push(`候选池是空的：队伍已有 ${inTeam.length} / ${teamSize} 只，`
      + `${excludedByPolicy} 个条目被 must_exclude / 已选 / species_unique 排除之后，没有剩下可召回的条目`);
  } else {
    pieces.push(`按 policy 收窄后只有 ${effectiveMin} 个可用条目（打分池 ${pool} 个）：`
      + '这已经是从注入的候选宇宙里、在当前约束下能拿出的全部');
  }
  if (policy.candidate_universe === 'owned' && index.facts.catalog_pet_entities > 0) {
    pieces.push(`当前 candidate_universe = owned（玩家箱子口径）：只有 ${index.facts.owned_instances} 个实例可召回；`
      + `要按 600+ 图鉴召回请显式给 policy.candidate_universe = 'catalog'`);
  }
  pieces.push('宁可如实报「凑不满」，也不用不满足硬约束的条目凑数');
  return `${count} 个 < 下界 ${limits.min}（按 policy 收窄后可用 ${effectiveMin} 个）：${pieces.join('；')}`;
}

/** 一个候选分项的判据文本（报告里逐条贴出来）。 */
export const RECALL_SCORE_CRITERIA = Object.freeze({
  type_complement: '对每个「队伍现在没有抗性」的攻击系别 T：候选对 T 的登记倍率 < 1 记 1 分、= 1 记 0.25、'
    + '> 1 记 0（未登记组合键记 0 并标 unknown）；再对「已诊断出的未承接弱点」T 加倍权重。'
    + '全部用整数标度（×4）比较，不做浮点倍率运算。',
  speed_band: '速度按**候选宇宙内三分位**分 fast / mid / slow；候选补上队伍里还没有的档位记 1 分，'
    + '重复档位记 0.3，没有速度值记 0（unknown，不猜档位）。',
  energy_curve: '只看候选自己的**具体 build** 四个技能的能耗：有 0 费技能 +0.5、无超限技能 +0.3、'
    + '能耗合计落在候选中位数附近 +0.2；没有 build 的候选记 0 并在 unverified 里点名。',
  synergy_answers: '用 RC-302 §synergy 的 answers 计数：候选能接住队伍里「没有人接」的弱点 T ⇒ 按接住的条数计分'
    + '（每条 1 / 条数归一）；某系别全队 ≥ 3 只都弱时再加权 —— 这是可复算计数，不是体系强弱判断。',
  preference: 'favourite = true 记 1 分、locked = true 记 1 分（已在队里的不会进候选），'
    + '其余记 0；请求里的 preference（温和/简短/详细）**不影响**候选与排序，只影响措辞。',
  evidence_tier: '在冻结迁移层（48 只，有面板/配招/学招表）记 1 分；只有 pack 图鉴信息记 0.3 分，'
    + '并在 unverified 里点名「四技能与合法性未校验」。',
});

function recallScores(index, profile, currentProfiles, currentFeatures, {targetTypes, uncoveredTypes}) {
  // ① 属性互补
  const typesToAnswer = uniqueSorted([...targetTypes, ...uncoveredTypes]);
  let complement = 0;
  const answered = [];
  for (const attackType of typesToAnswer) {
    const scale = defenceScale(index, profile.types, attackType);
    const weight = targetTypes.includes(attackType) ? 2 : 1;
    if (scale === null) continue;
    const value = scale < 4 ? 1 : (scale === 4 ? 0.25 : 0);
    if (value === 1) answered.push(attackType);
    complement += value * weight;
  }
  const complementMax = typesToAnswer.reduce((sum, t) => sum + (targetTypes.includes(t) ? 2 : 1), 0) || 1;
  const typeComplement = Math.min(1, complement / complementMax);

  // ② 速度层次
  const band = profile.speed_band;
  const speedBand = band === null ? 0 : (currentFeatures.speed_bands.includes(band) ? 0.3 : 1);

  // ③ 能耗曲线
  const curve = profile.energy;
  let energyCurve = 0;
  if (curve.known) {
    energyCurve += curve.zero_cost > 0 ? 0.5 : 0;
    energyCurve += (curve.over_cap ?? 0) === 0 ? 0.3 : 0;
    energyCurve += curve.min !== null && curve.min <= 2 ? 0.2 : 0;
  }

  // ④ synergy answers
  const weaknessRows = currentFeatures.unanswered_weaknesses;
  let answers = 0;
  const answeredKeys = [];
  for (const row of weaknessRows) {
    const scale = defenceScale(index, profile.types, row.attack_type);
    if (scale === null || scale >= 4) continue;
    answers += row.shared >= 3 ? 2 : 1;
    answeredKeys.push(row.attack_type);
  }
  const synergyAnswers = weaknessRows.length === 0 ? (currentFeatures.size === 0 ? 0.5 : 1)
    : Math.min(1, answers / (weaknessRows.length * 2));

  // ⑤ 偏好
  const preference = Math.min(1, (profile.favourite ? 1 : 0) + (profile.locked ? 1 : 0));

  // ⑥ 证据层级
  const evidenceTier = profile.validated ? 1 : 0.3;

  return {
    parts: {
      type_complement: round(typeComplement), speed_band: round(speedBand), energy_curve: round(energyCurve),
      synergy_answers: round(synergyAnswers), preference: round(preference), evidence_tier: round(evidenceTier),
    },
    detail: {
      answered_attack_types: uniqueSorted(answered),
      answered_unanswered_weaknesses: uniqueSorted(answeredKeys),
      speed_band: band,
      speed_band_is_new: band !== null && !currentFeatures.speed_bands.includes(band),
      energy: {known: curve.known, min: curve.min, zero_cost: curve.zero_cost, over_cap: curve.over_cap},
      target_types: typesToAnswer,
    },
  };
}

/** 候选记录：`machine_evidence[]` + `confidence` + `unverified[]` 是硬要求。 */
function candidateRecord(index, row, rank, {policy, rulesetEnergyCap, targetTypes}) {
  const p = row.profile;
  const evidenceRows = [];
  if (p.evidence.types) {
    evidenceRows.push(evidence(p.evidence.types.source_file, p.evidence.types.pointer, 'types', p.types,
      '候选的属性组合（属性互补判据的输入）'));
  }
  if (p.evidence.speed) {
    evidenceRows.push(evidence(p.evidence.speed.source_file, p.evidence.speed.pointer, 'spe', p.spe,
      `速度档位口径 = ${p.spe_status}`));
  }
  if (p.kind === 'owned') {
    evidenceRows.push(evidence('data/roco/owned/owned-pets.json',
      `instances[instance_id=${p.instance_id}]`, 'skills', p.skill_ids,
      p.build_known ? '能耗曲线只从这组有序四个技能算' : '这个实例没有配招：能耗曲线记为 unknown'));
  } else if (p.evidence.pool) {
    evidenceRows.push(evidence(p.evidence.pool.source_file, p.evidence.pool.pointer, 'skills',
      {learnset_skill_count: p.learnset_skill_count, tier: p.learnset_tier},
      '图鉴候选的应对/换入手段只从冻结学招表读；没有冻结学招表时记 unknown'));
  }
  evidenceRows.push(evidence(RC303_REPORT_PATH, 'recall.policy.candidate_universe', 'value', policy.candidate_universe,
    `这个候选来自 ${policy.candidate_universe} 口径的召回池（${p.namespace}）`));

  const unverified = [];
  if (!p.has_frozen_learnset) {
    unverified.push('未核实：四技能与配招合法性 —— 这只不在冻结迁移层（learnsets.json 只有 48 只条目），'
      + '图鉴口径只登记名称与系别');
  }
  if (p.spe_status === 'knowledge_only') {
    unverified.push('未核实：实战速度 —— 只有 full-catalog 的 base stats（面板换算公式未知），'
      + '速度层次只作相对分档用');
  } else if (p.spe_status === 'unknown') {
    unverified.push('未核实：速度 —— 这只没有任何来源的速度值，不参与速度层次判据');
  }
  if (!p.build_known) {
    unverified.push('未核实：能耗曲线 —— 没有具体 build 的四个技能，本条不给任何能耗结论');
  }
  if (!p.weakness.known) {
    unverified.push('未核实：属性倍率 —— 这只的属性组合键在 types.json 里没有登记，属性互补判据跳过它');
  }
  if (!policy.allow_unowned && p.kind === 'catalog') {
    unverified.push('未核实：这只（图鉴物种）在玩家箱子里还没有实例 —— 要真正上场需要先获得；'
      + 'policy.allow_unowned = false 时它只是「可以考虑的目标」，不是可执行的槽位');
  }
  if (targetTypes.length) {
    unverified.push(`未核实：这些系别能不能真的靠它接住 —— 属性倍率是静态登记（台账 type.multiplier = COMMUNITY_CURRENT），`
      + `技能/特性层面的补救没有实现（effect_support = unsupported）`);
  }

  return {
    candidate_key: p.key,
    rank: rank + 1,
    // `required = true` 表示这条候选来自 locked / must_include：束搜索**必须先给它占位**，
    // 不许在束宽竞争里被纯结构分挤掉。
    required: row.required === true,
    required_via: row.required ? 'locked|must_include' : null,
    namespace: p.namespace,
    kind: p.kind,
    instance_id: p.instance_id,
    species_id: p.species_id,
    species_name: p.species_name,
    types: p.types,
    spe: p.spe,
    spe_status: p.spe_status,
    speed_tier: p.speed_tier,
    speed_band: p.speed_band,
    favourite: p.favourite,
    locked: p.locked,
    validated: p.validated,
    has_frozen_learnset: p.has_frozen_learnset,
    build_known: p.build_known,
    skill_ids: p.skill_ids,
    energy: p.energy,
    respond_variants: p.respond_variants,
    pivot_tools: p.pivot_tools,
    weakness: p.weakness,
    recall_score: row.total,
    recall_parts: row.scores.parts,
    recall_detail: row.scores.detail,
    recall_criteria: RECALL_SCORE_CRITERIA,
    confidence: p.validated ? 'COMMUNITY_CURRENT' : 'UNKNOWN',
    machine_evidence: evidenceRows,
    unverified: uniqueSorted(unverified),
    ruleset_energy_cap: rulesetEnergyCap,
  };
}

function recallUnverified(index, policy) {
  const out = [
    '未核实：任何「强度」判断 —— 召回分数只是便宜特征的相对排序，不是胜率、不是强度分',
    '未核实：属性倍率的逐条正确性（台账 type.multiplier = COMMUNITY_CURRENT，明确写「不再沿用旧资料双弱 ×4」）',
    `未核实：图鉴口径候选（${index.facts.catalog_pet_entities - index.facts.species_with_frozen_learnset} 只没有冻结学招表）`
      + '的四技能与配招合法性；它们只按系别/速度/学招表关键词参与召回',
  ];
  if (policy.candidate_universe === 'owned') {
    out.push(`未核实：全量图鉴 —— 本次 candidate_universe = owned，只在 ${index.facts.owned_instances} 个实例里召回`);
  }
  return uniqueSorted(out);
}

// ─────────────────────────────────────────────────────────────────────────
// ② Beam 补全（确定性 + 显式预算）
// ─────────────────────────────────────────────────────────────────────────

/** Beam 的默认预算。三个上限**都是参数**，实际值进报告的 `beam.budgets`。 */
export const DEFAULT_BEAM_BUDGETS = Object.freeze({
  beamWidth: 4,
  nodeBudget: 2000,
  timeBudgetMs: 50,
  maxTeams: 24,
});

/**
 * 用束搜索把部分阵容补全到 `team_size` 只。
 *
 * 确定性保证：
 *   · 候选顺序固定（`recallCandidates` 的输出顺序，本身含 id 级 tie-break）；
 *   · 每层扩展后按 `(score, key)` **字典序**排序，分数相同用 `key` 字符串比较 break tie；
 *   · 扩展时只取每个候选键的**唯一代表**，同一 key 不会因为输入顺序不同而出现两次；
 *   · 达到 `nodeBudget` / `timeBudgetMs` / `maxTeams` 任一时**记录截断原因**并停止扩展，
 *     已完成的部分队伍照常返回（并如实标 `truncated`）。
 *
 * @param {object} request
 * @param {Array} recalled `recallCandidates().candidates`
 * @param {object} [options] `{beamWidth, nodeBudget, timeBudgetMs, maxTeams, now, policy}`
 */
export function beamComplete(request, recalled, options = {}) {
  const inputs = options.inputs ?? {};
  const index = options.__index ?? buildCandidateIndex(inputs);
  const budgets = {
    beamWidth: Number.isInteger(options.beamWidth) ? options.beamWidth : DEFAULT_BEAM_BUDGETS.beamWidth,
    nodeBudget: Number.isInteger(options.nodeBudget) ? options.nodeBudget : DEFAULT_BEAM_BUDGETS.nodeBudget,
    timeBudgetMs: Number.isInteger(options.timeBudgetMs) ? options.timeBudgetMs : DEFAULT_BEAM_BUDGETS.timeBudgetMs,
    maxTeams: Number.isInteger(options.maxTeams) ? options.maxTeams : DEFAULT_BEAM_BUDGETS.maxTeams,
  };
  const now = typeof options.now === 'function' ? options.now : null;
  const clock = now ? () => now() : () => null;
  const startedAt = clock();
  const rulesetEnergyCap = Number.isFinite(options.ruleset_energy_cap) ? options.ruleset_energy_cap
    : (Number.isFinite(request?.ruleset_energy_cap) ? request.ruleset_energy_cap : null);

  const teamSize = Number.isInteger(request?.team_size) ? request.team_size : STANDARD_PVP_TEAM_SIZE;
  const policy = resolvePolicy(options.policy);
  const problems = [];
  const truncated = [];

  // 已经在队里的成员是 `locked ∪ selected`（RC-301 保证 locked ⊆ selected ∪ must_include）。
  // **`must_include` 只是「必须出现在最终队伍里」，不是「现在就在队里」**：束搜索负责给它占位。
  // 所以这里只在**锁定/已选**这一侧判红；must_include 的最终是否落位由补全后的审计判（见
  // `auditTeamCandidates` 的 CONSTRAINT_VIOLATED）。
  const inTeam = teamRefs(request, index);
  const inTeamIds = new Set(inTeam.map((row) => row.instance_id).filter(Boolean));
  const inTeamSpecies = new Set(inTeam.map((row) => row.species_id));
  const missingLocked = arr(request?.locked).filter((id) => !inTeamIds.has(id));
  if (missingLocked.length) {
    problems.push(auditProblem('CONSTRAINT_VIOLATED', 'request.locked',
      `locked 里的 ${missingLocked.join('、')} 不在当前队伍里：锁定意味着它必须在队里，`
      + '束搜索只补空槽，不许拿别的成员替换它'));
  }
  if (inTeam.length > teamSize) {
    problems.push(auditProblem('CONSTRAINT_VIOLATED', 'request.selected',
      `已在队里的成员有 ${inTeam.length} 个，超过 team_size=${teamSize}`));
  }

  const candidates = arr(recalled);
  const remaining = Math.max(0, teamSize - inTeam.length);
  const alreadyComplete = remaining === 0 && inTeam.length > 0;
  if (candidates.length < remaining) {
    problems.push(auditProblem('CONSTRAINT_VIOLATED', 'recall.candidates',
      `还差 ${remaining} 个槽位，但召回只有 ${candidates.length} 个候选：补不出完整队伍，`
      + '按 fail closed 如实报，不拿不满足硬约束的条目凑数'));
  }
  // 硬要求必须**够得着**：`must_include` 的物种既不在队里、也不在召回里（例如它没被拥有，
  // 而 policy 只让从 owned 里召回）⇒ 补不出满足约束的队伍，必须 fail closed 并点名。
  const recalledSpecies = new Set(candidates.map((c) => c.species_id));
  const unreachable = hardRequirements(request, index)
    .filter((row) => !inTeamSpecies.has(row.species_id) && !recalledSpecies.has(row.species_id));
  if (unreachable.length) {
    problems.push(auditProblem('CONSTRAINT_VIOLATED', 'request.must_include',
      `硬要求 ${unreachable.map((r) => r.raw).join('、')} 既不在当前队伍里、也不在召回池里：`
      + `按 policy.candidate_universe=${policy.candidate_universe}`
      + `${policy.include_catalog_species ? '' : '（未启用图鉴物种召回）'}，补不出满足约束的队伍。`
      + '请把它放进 selected / locked，或放开 policy 让图鉴物种参与召回'));
  }
  if (alreadyComplete) {
    // 六只已经满了：没有空槽可补，这不是失败，是「当前请求没有可补的位置」。
    return {
      ok: problems.length === 0,
      teams: [],
      team_count: 0,
      budgets: {...budgets, actual_nodes: 0, actual_elapsed_ms: 0},
      truncated: [],
      stop_reason: 'already_complete',
      remaining_slots: 0,
      already_complete: true,
      note: `队伍已经有 ${inTeam.length} / ${teamSize} 只，没有空槽可补：束搜索不替换已选成员`
        + '（要换人请显式给 max_replacements 并走「反事实替换」那条线，那是 RC-304 的范围）',
      criteria: STRUCTURAL_CRITERIA.deterministic,
      problems,
      unverified: [],
      machine_evidence: [
        evidence('data/roco/owned/owned-pets.json', 'instances', 'count', index.facts.owned_instances,
          '候选宇宙来源（本条没有补全动作）'),
      ],
    };
  }

  const candidateProfiles = new Map(candidates.map((c) => [c.candidate_key, c]));
  const baseMembers = inTeam.map((row) => profileOf(index, row, {rulesetEnergyCap}));
  const baseKeys = baseMembers.map((p) => p.key);
  // 硬要求（召回里 `required = true` 的那些）**必须先占位**：否则它们会在束宽竞争里被
  // 纯结构分挤掉，补出来的队伍就不满足 must_include / locked。这不是「偏好」，是约束。
  const requiredKeys = candidates.filter((c) => c.required === true).map((c) => c.candidate_key)
    .filter((key) => !baseKeys.includes(key)).sort();
  const optionalKeys = candidates.map((c) => c.candidate_key)
    .filter((key) => !baseKeys.includes(key) && !requiredKeys.includes(key)).sort();
  const requiredToPlace = Math.min(requiredKeys.length, remaining);
  if (requiredKeys.length > remaining) {
    problems.push(auditProblem('CONSTRAINT_VIOLATED', 'recall.candidates',
      `硬要求（must_include / locked）里有 ${requiredKeys.length} 个条目要占位，但只剩 ${remaining} 个槽位：`
      + '约束不可满足，按 fail closed 如实报（RC-302 的 cost 维度会给出 blocking）'));
  }

  const teams = [];
  const seenTeamKeys = new Set();
  // 成员画像缓存：同一个 key 在一次束搜索里会被反复求值（每个节点 × 每个候选），
  // 不缓存就是 O(节点 × 候选 × 候选) 的重算。缓存只影响耗时，不影响输出（纯函数）。
  const profileCache = new Map();
  const cachedProfile = (key) => {
    if (!profileCache.has(key)) profileCache.set(key, profileFor(index, key, candidateProfiles, rulesetEnergyCap));
    return profileCache.get(key);
  };
  let nodes = 0;
  let stopReason = null;

  // 初始束：一个节点（当前队伍）。
  let beam = [{keys: baseKeys, score: partialScore(index, baseMembers, {
    profiles: candidateProfiles, rulesetEnergyCap, policy,
  })}];

  for (let step = 0; step < remaining; step += 1) {
    const expanded = [];
    // 还有硬要求没占位时，这一层**只能**从硬要求里选；占满之后才开放给普通候选。
    // 束里每个节点在这一层要占的硬要求集合是相同的（占位发生在最早的那几层，且是强制的），
    // 所以用 `beam[0]` 的键算一次就够，不依赖节点遍历顺序。
    const placedKeys = new Set(beam[0]?.keys ?? []);
    const unplacedRequired = requiredKeys.filter((key) => !placedKeys.has(key));
    const mustPlaceNow = step < requiredToPlace;
    const choiceKeys = mustPlaceNow ? unplacedRequired : [...unplacedRequired, ...optionalKeys];
    for (const node of beam) {
      if (stopReason !== null) break;
      if (nodes >= budgets.nodeBudget) { stopReason = 'node_budget'; break; }
      nodes += 1;
      const usedSpecies = new Set(node.keys.map((key) => keyToSpecies(index, key)));
      for (const key of choiceKeys) {
        if (node.keys.includes(key)) continue;
        const candidate = candidateProfiles.get(key);
        if (!candidate) continue;
        if (policy.species_unique && usedSpecies.has(candidate.species_id)) continue;
        const profiles = node.keys.map(cachedProfile);
        profiles.push(cachedProfile(key));
        expanded.push({
          keys: [...node.keys, key],
          score: partialScore(index, profiles, {profiles: candidateProfiles, rulesetEnergyCap, policy}),
        });
      }
      if (now && budgets.timeBudgetMs > 0 && startedAt !== null && clock() - startedAt > budgets.timeBudgetMs) {
        stopReason = 'time_budget';
        break;
      }
    }
    if (expanded.length === 0) { stopReason = stopReason ?? 'no_expansion'; break; }
    expanded.sort(compareNodes);
    beam = expanded.slice(0, Math.max(1, budgets.beamWidth));
    if (step === remaining - 1) {
      for (const node of beam) {
        // 去重：同一支队伍（成员集合相同）只保留分数最高的那一个，避免 Top-K 里出现重复队。
        if (seenTeamKeys.has(node.keys.join('+'))) continue;
        if (teams.length >= budgets.maxTeams) { stopReason = stopReason ?? 'max_teams'; break; }
        seenTeamKeys.add(node.keys.join('+'));
        teams.push(node);
      }
    }
  }
  if (stopReason) truncated.push(stopReason);
  const elapsedMs = startedAt === null ? null : clock() - startedAt;

  const teamRecords = teams
    .map((node, indexInBeam) => {
      const members = node.keys.map(cachedProfile);
      const features = featuresOfProfiles(index, members, {ruleset_energy_cap: rulesetEnergyCap});
      return {
        team_id: `beam-${indexInBeam + 1}`,
        team_key: node.keys.join('+'),
        members: members.map((p) => memberRecord(p)),
        member_keys: [...node.keys],
        utility: round(ruleScore(features).score),
        features: compactFeatures(features),
        machine_evidence: [
          ...members.map((p) => evidence(
            p.kind === 'owned' ? 'data/roco/owned/owned-pets.json' : 'data/roco/game-data-pack/v2/pack.json',
            p.kind === 'owned' ? `instances[instance_id=${p.instance_id}]` : `${packPointerFor(index, p.species_id)}`,
            'types', p.types, `成员 ${p.key} 的属性组合`)),
          evidence(FROZEN_PATHS.types, 'types', 'keys', index.attackTypes.length,
            '队伍结构分（coverage / synergy / speed）用的属性倍率表'),
          evidence(RC303_REPORT_PATH, 'beam.budgets', 'value', budgets,
            '束搜索的显式预算：宽度/节点上限/时间上限/队伍上限都是参数'),
        ],
        unverified: uniqueSorted([
          ...members.flatMap((p) => p.unknown_reason.map((r) => `${p.key}：${r}`)),
          '未核实：束搜索的分数只是**结构分**（工程假设），不是对局期望值',
        ]),
        confidence: 'ENGINE_HYPOTHESIS',
      };
    })
    .sort((a, b) => (b.utility - a.utility) || (a.team_key < b.team_key ? -1 : 1))
    .map((row, rank) => ({...row, rank: rank + 1}));

  return {
    ok: teamRecords.length > 0 && problems.length === 0,
    teams: teamRecords,
    team_count: teamRecords.length,
    budgets: {...budgets, actual_nodes: nodes, actual_elapsed_ms: elapsedMs === null ? null : round(elapsedMs, 3)},
    truncated: uniqueSorted(truncated),
    stop_reason: stopReason,
    remaining_slots: remaining,
    criteria: STRUCTURAL_CRITERIA.deterministic,
    problems,
    unverified: uniqueSorted([
      '未核实：束搜索有没有漏掉更好的组合 —— 宽度与节点上限是**工程预算**，不是最优性证明',
      '未核实：同一物种的多个实例之间如何取舍 —— 召回里实例是一等公民，束搜索按结构分排',
    ]),
    machine_evidence: [
      evidence('src/coach/team-candidates.mjs', 'beamComplete(options)', 'budgets', budgets,
        '束搜索的四个上限都是显式参数（报告里给实际值）'),
      evidence('data/roco/owned/owned-pets.json', 'instances', 'count', index.facts.owned_instances,
        '补全用的是实例级成员（有具体 build）'),
    ],
  };
}

const compareNodes = (a, b) => (b.score - a.score) || (a.keys.join('+') < b.keys.join('+') ? -1 : 1);

/**
 * 部分队伍的结构分：队伍特征分 + 覆盖/互补加权 − 重复物种惩罚。
 *
 * 为什么要有「完成度折扣」：特征分里的 coverage/synergy 是**占比**，一只精灵的队伍
 * 也能拿到很高的占比。如果直接拿占比当路径分，束搜索会一直偏爱「小队伍」，补全出来的
 * 队伍就不是「最有希望补成强队的那些」。折扣 = 已完成槽位 / 总槽位，是对**完成度**的
 * 线性加权，不是胜率；`totalSlots` 由调用方给（默认按 6 宠口径）。
 */
function partialScore(index, profiles, {rulesetEnergyCap, policy, totalSlots = STANDARD_PVP_TEAM_SIZE}) {
  const features = featuresOfProfiles(index, profiles, {ruleset_energy_cap: rulesetEnergyCap});
  const base = ruleScore(features).score;
  const completion = totalSlots > 0 ? Math.min(1, profiles.length / totalSlots) : 1;
  const species = profiles.map((p) => p.species_id);
  const duplicates = species.length - new Set(species).size;
  const duplicatePenalty = policy?.species_unique ? duplicates * 25 : duplicates * 4;
  const catalogPenalty = profiles.filter((p) => p.kind === 'catalog').length * 6;
  return round(base * completion - duplicatePenalty - catalogPenalty);
}

/** `owned:own-0001` / `catalog:pet_000012` → 该成员的成员画像（候选表里没有就重新算）。 */
function profileFor(index, key, candidateProfiles, rulesetEnergyCap) {
  if (candidateProfiles?.has(key)) {
    const c = candidateProfiles.get(key);
    return profileOf(index, c.kind === 'owned'
      ? {kind: 'owned', id: c.instance_id, instance_id: c.instance_id, species_id: c.species_id}
      : {kind: 'catalog', id: c.species_id, species_id: c.species_id}, {rulesetEnergyCap});
  }
  const [kind, id] = key.split(':');
  return profileOf(index, kind === 'owned'
    ? {kind: 'owned', id, instance_id: id, species_id: index.instances.get(id)?.species_id}
    : {kind: 'catalog', id, species_id: id}, {rulesetEnergyCap});
}

const keyToSpecies = (index, key) => {
  const [kind, id] = key.split(':');
  return kind === 'owned' ? (index.instances.get(id)?.species_id ?? id) : id;
};

const packPointerFor = (index, speciesId) => (index.packBySpecies.get(speciesId)?.pointer ?? 'sections.distributable.entities');

/** 成员记录（队伍里逐只展示用）。 */
function memberRecord(profile) {
  return {
    key: profile.key,
    kind: profile.kind,
    namespace: profile.namespace,
    instance_id: profile.instance_id,
    species_id: profile.species_id,
    species_name: profile.species_name,
    types: profile.types,
    spe: profile.spe,
    spe_status: profile.spe_status,
    speed_tier: profile.speed_tier,
    speed_band: profile.speed_band,
    favourite: profile.favourite,
    locked: profile.locked,
    validated: profile.validated,
    has_frozen_learnset: profile.has_frozen_learnset,
    build_known: profile.build_known,
    skill_ids: profile.skill_ids,
    respond_variants: profile.respond_variants,
    pivot_tools: profile.pivot_tools,
    weak_attack_types: profile.weakness.weak,
    resist_attack_types: profile.weakness.resist,
    unknown_reason: profile.unknown_reason,
  };
}

/** 队伍特征的精简形态（报告/排序器输入用，不塞整个 options 数组）。 */
const compactFeatures = (features) => ({
  size: features.size,
  coverage: round(features.coverage),
  synergy: round(features.synergy),
  speed: round(features.speed),
  energy: round(features.energy),
  respond: round(features.respond),
  pivot: round(features.pivot),
  preference: round(features.preference),
  evidence: round(features.evidence),
  counts: features.counts,
  types_multiset: features.types_multiset,
  speed_bands: features.speed_bands,
  unanswered_weaknesses: features.unanswered_weaknesses,
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 排序（读来的，不是编的）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 判定注入的排序器能不能用。**没有就是没有**：
 *   · `null` / `undefined`            → `{status:'missing'}`
 *   · 普通对象但没有 `score` 方法     → `{status:'invalid'}`（写清缺什么）
 *   · `{ranker_id, version, score}`   → `{status:'ready'}`（版本化产物，`score` 是纯函数）
 *   · 直接给一个函数                  → `{status:'ready'}`，`ranker_id` 由调用方自己声明（这里记 `anonymous`）
 */
export function resolveRanker(ranker) {
  if (ranker === null || ranker === undefined) {
    return {
      status: 'missing', ranker: null, ranker_id: null, version: null,
      reason: '调用方没有注入排序器：本仓现在**没有**训练好的 Team Ranker 产物（13 号文档 §5.1 的离线链路尚未产出），'
        + '所以不能假装有模型。排序退化成规则打分，并按台账标 confidence = ENGINE_HYPOTHESIS。',
    };
  }
  if (typeof ranker === 'function') {
    return {status: 'ready', ranker, ranker_id: 'anonymous', version: null, reason: '调用方注入了一个打分函数（无版本标识）'};
  }
  if (isPlainObject(ranker) && typeof ranker.score === 'function') {
    const version = typeof ranker.version === 'string' ? ranker.version : null;
    const rankerId = typeof ranker.ranker_id === 'string' ? ranker.ranker_id : null;
    const invalid = [];
    if (!rankerId) invalid.push('缺 ranker_id');
    if (!version) invalid.push('缺 version（版本化产物必须能指出版本）');
    if (typeof ranker.calibrated !== 'boolean') invalid.push('缺 calibrated（有没有校准证据）');
    if (invalid.length) {
      return {
        status: 'invalid', ranker: null, ranker_id: rankerId, version,
        reason: `注入的排序器不是可用的版本化产物：${invalid.join('、')}。按「读来的，不是编的」的纪律，`
          + '读不到完整产物就不使用它，退化成规则打分。',
      };
    }
    return {status: 'ready', ranker, ranker_id: rankerId, version, reason: `版本化排序器产物 ${rankerId}@${version}`};
  }
  return {
    status: 'invalid', ranker: null, ranker_id: null, version: null,
    reason: `注入的 ranker 形状不认识（${typeof ranker}）：要么给 {ranker_id, version, calibrated, score(features)}，要么给函数，要么不给`,
  };
}

/**
 * Top-K 逐队打分。`K ≤ 10`。
 *
 * 排序口径只有两种，报告里**必须**能区分：
 *   · `ranker_status: 'ready'` → 用注入的版本化排序器（`score(teamFeatures)`）；
 *   · `ranker_status: 'missing' | 'invalid'` → 退化成规则打分（`ruleScore`），
 *     `confidence: 'ENGINE_HYPOTHESIS'`，`unverified[]` 里点名「没有排序器」。
 *
 * @param {Array} teams `beamComplete().teams`（或任何带 `features` 的队伍记录）
 * @param {object} [options] `{ranker, k, inputs, index}`
 */
export function scoreTeams(teams, options = {}) {
  const resolved = resolveRanker(options.ranker);
  const index = options.__index ?? buildCandidateIndex(options.inputs ?? {});
  const k = Number.isInteger(options.k) ? Math.max(0, Math.min(10, options.k)) : 10;
  const rows = arr(teams);
  const scored = [];

  for (const team of rows) {
    const features = team.features ?? null;
    let score = null;
    let scoreParts = null;
    let rankerError = null;
    if (resolved.status === 'ready') {
      try {
        const raw = resolved.ranker.score(features, {team, index_facts: index.facts});
        if (isPlainObject(raw)) {
          score = Number.isFinite(raw.score) ? round(raw.score) : null;   // 归一化 0～1
          scoreParts = isPlainObject(raw.parts) ? raw.parts : null;
        } else if (Number.isFinite(raw)) {
          score = round(raw);
        } else {
          rankerError = `排序器返回的形状不认识：${typeof raw}`;
        }
      } catch (error) {
        rankerError = `排序器抛错：${error?.message ?? String(error)}`;
      }
      if (rankerError) resolved.status = 'invalid';
    }
    if (score === null) {
      const rule = ruleScore(features ?? {});
      score = rule.raw;
      scoreParts = rule.parts;
    }
    scored.push({
      ...team,
      ranker_score: score,
      ranker_score_parts: scoreParts,
      ranker_error: rankerError,
      score_source: resolved.status === 'ready' && !rankerError ? 'ranker' : 'rule_score',
    });
  }

  scored.sort((a, b) => (b.ranker_score - a.ranker_score) || (a.team_key < b.team_key ? -1 : 1));
  const top = scored.slice(0, k).map((row, rank) => ({
    ...row,
    rank: rank + 1,
    score_scale: '0～1 的**排序用**效用值（不是胜率、不是强度分；没有校准证据）',
    confidence: row.score_source === 'ranker' && resolved.ranker?.calibrated === true
      ? 'COMMUNITY_CURRENT' : 'ENGINE_HYPOTHESIS',
    unverified: uniqueSorted([
      ...arr(row.unverified),
      ...(row.score_source === 'rule_score'
        ? ['未核实：这只队伍的排序 —— 没有注入版本化 Team Ranker，分数是**规则打分**（权重是工程假设），'
          + '只做相对排序']
        : ['未核实：排序器的校准 —— 排序器自报 calibrated=' + String(resolved.ranker?.calibrated) + '；没有校准证据时不当成对局期望值']),
    ]),
  }));

  return {
    ok: resolved.status !== 'invalid' || rows.length === 0,
    ranker_status: resolved.status,
    ranker_id: resolved.ranker_id,
    ranker_version: resolved.version,
    // `ranker_injected` 是评审必须看的一件事：产出里报 `ready` **必须**同时说明这次真的注入了排序器。
    // 只报状态不报来源，就给了「事后把 missing 改成 ready」留门——审计的 RANKER_OVERCLAIM 靠这个字段判。
    ranker_injected: resolved.status === 'ready',
    ranker_reason: resolved.reason,
    score_source: resolved.status === 'ready' ? 'ranker' : 'rule_score',
    k,
    team_count: rows.length,
    teams: top,
    confidence: resolved.status === 'ready' && resolved.ranker?.calibrated === true ? 'COMMUNITY_CURRENT' : 'ENGINE_HYPOTHESIS',
    no_win_rate: true,
    criteria: STRUCTURAL_CRITERIA.ranker_honesty,
    machine_evidence: [
      evidence('src/coach/team-candidates.mjs', 'resolveRanker(ranker)', 'status', resolved.status, resolved.reason),
      ...(resolved.status === 'ready'
        ? [evidence(`data/roco/ranker/${resolved.ranker_id}.json`, 'version', 'value', resolved.version,
          '版本化排序器产物（由离线链路产出）')]
        : [evidence(RC303_REPORT_PATH, 'ranker.status', 'value', 'missing',
          '本仓当前没有 Team Ranker 产物：排序退回规则打分并标 ENGINE_HYPOTHESIS')]),
      evidence('src/coach/team-candidates.mjs', 'RULE_SCORE_WEIGHTS', 'weights', RULE_SCORE_WEIGHTS,
        '规则打分的权重是公开的工程假设，只做相对排序'),
    ],
    unverified: uniqueSorted([
      ...(resolved.status === 'ready' ? [] : ['未核实：排序器不存在 —— Top-K 只是启发式排序，不是对局期望值']),
      '未核实：队伍强度 —— 13 号文档 §4 的 expected_meta_value / CVaR / matchup_spread 都需要离线联赛标签（RC-304 之前不存在）',
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ④ 渐进推荐（已选 2～5 只时给恰好三个下一只候选）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 已选 2～5 只时，给出**恰好三个**下一只候选，分别带取舍标签
 * （强度 / 稳定 / 偏好保留）。这三个标签是**决策口径**，不是胜率。
 *
 * @param {object} request
 * @param {object} inputs 与 `recallCandidates` 相同，另可给 `{ranker, budgets}`
 * @param {Array} [inputs.selected] 已选实例 id 列表（也可以直接从 request.selected 读）
 */
export function progressiveNext(request, options = {}) {
  const inputs = options.inputs ?? {};
  const index = options.__index ?? buildCandidateIndex(inputs);
  const policy = resolvePolicy(options.policy ?? inputs.policy);
  const teamSize = Number.isInteger(request?.team_size) ? request.team_size : STANDARD_PVP_TEAM_SIZE;
  const inTeam = teamRefs(request, index);
  const rulesetEnergyCap = Number.isFinite(options.ruleset_energy_cap) ? options.ruleset_energy_cap : null;
  const problems = [];

  const recall = options.recall ?? recallCandidates(request, {...inputs, __index: index, policy});
  const candidates = arr(recall.candidates);
  const baseProfiles = inTeam.map((row) => profileOf(index, row, {rulesetEnergyCap}));
  const baseFeatures = featuresOfProfiles(index, baseProfiles, {ruleset_energy_cap: rulesetEnergyCap});
  const baseScore = ruleScore(baseFeatures).score;

  const inTeamCount = inTeam.length;
  // 13 号文档 §6：只有 2～5 只时才推荐「下一只」。0～1 只是体系入口、6 只是完整队评估，
  // 它们**不是**本函数的口径——如实返回 `applies:false`，不硬凑三个假候选。
  // 这不是「问题」，是口径外：所以记在 `notes` 里，不污染 `problems`（审计按 applies 判）。
  const applicable = inTeamCount >= 2 && inTeamCount <= 5;
  const notes = applicable ? [] : [
    `渐进推荐只适用于已选 2～5 只（13 号文档 §6）；当前已选 ${inTeamCount} 只，`
    + `所以本函数返回 applies:false 与 0 个候选（${inTeamCount <= 1 ? '0～1 只按体系入口口径处理' : '6 只按完整队伍评估口径处理'}）`,
  ];

  const evaluations = candidates.map((candidate) => {
    const profile = profileOf(index, candidate.kind === 'owned'
      ? {kind: 'owned', id: candidate.instance_id, instance_id: candidate.instance_id, species_id: candidate.species_id}
      : {kind: 'catalog', id: candidate.species_id, species_id: candidate.species_id}, {rulesetEnergyCap});
    const features = featuresOfProfiles(index, [...baseProfiles, profile], {ruleset_energy_cap: rulesetEnergyCap});
    const score = ruleScore(features).score;
    return {
      candidate,
      profile,
      features,
      gain: round(score - baseScore),
      unanswered: features.counts.unanswered_weaknesses,
      weakness_total: features.counts.weakness_total,
      favourite: candidate.favourite === true,
      locked: candidate.locked === true,
    };
  });

  const picks = [];
  if (applicable && evaluations.length > 0) {
    const picksWithReason = [];
    // 强度：边际增益最大
    picksWithReason.push({
      strategy: 'strength',
      row: [...evaluations].sort((a, b) => (b.gain - a.gain)
        || (a.unanswered - b.unanswered) || (a.candidate.candidate_key < b.candidate.candidate_key ? -1 : 1))[0],
      reasonFor: null,
    });
    // 稳定：未承接弱点最少（同分再看弱点总数，再看增益）
    picksWithReason.push({
      strategy: 'stability',
      row: [...evaluations].sort((a, b) => (a.unanswered - b.unanswered)
        || (a.weakness_total - b.weakness_total) || (b.gain - a.gain)
        || (a.candidate.candidate_key < b.candidate.candidate_key ? -1 : 1))[0],
      reasonFor: null,
    });
    // 偏好保留：收藏/锁定里增益最大；一只都没有时如实回落到强度口径
    const favouritePool = evaluations.filter((row) => row.favourite || row.locked);
    picksWithReason.push({
      strategy: 'preference',
      row: favouritePool.length
        ? [...favouritePool].sort((a, b) => (b.gain - a.gain)
          || (a.candidate.candidate_key < b.candidate.candidate_key ? -1 : 1))[0]
        : [...evaluations].sort((a, b) => (b.gain - a.gain)
          || (a.candidate.candidate_key < b.candidate.candidate_key ? -1 : 1))[0],
      reasonFor: favouritePool.length ? null
        : '候选池里没有任何 favourite / locked 的实例：偏好保留口径如实回落到强度口径（原因写在这里，不假装是偏好命中）',
    });

    // 三个口径允许指向同一只（这本身就是一条信息：它同时最优），但每个口径都要有自己的口径说明。
    for (const {strategy, row, reasonFor} of picksWithReason) {
      const spec = PROGRESSIVE_STRATEGIES.find((s) => s.id === strategy);
      picks.push({
        tradeoff_label: spec.label,
        tradeoff_id: spec.id,
        tradeoff_intent: spec.intent,
        tradeoff_note: spec.tradeoff,
        fallback_reason: reasonFor,
        candidate_key: row.candidate.candidate_key,
        instance_id: row.candidate.instance_id,
        species_id: row.candidate.species_id,
        species_name: row.candidate.species_name,
        types: row.candidate.types,
        favourite: row.favourite,
        locked: row.locked,
        expected_marginal_gain: row.gain,
        unanswered_weaknesses_after: row.unanswered,
        weakness_total_after: row.weakness_total,
        score_scale: '边际增益 = 加入后的**规则结构分** − 当前结构分（0～100 排序用效用值，不是胜率）',
        machine_evidence: [
          evidence('src/coach/team-candidates.mjs', 'PROGRESSIVE_STRATEGIES', 'id', spec.id,
            `本候选是按「${spec.label}」口径选出的：${spec.intent}`),
          evidence('src/coach/team-candidates.mjs', 'ruleScore(features)', 'weights', RULE_SCORE_WEIGHTS,
            '边际增益用的是同一套公开权重的规则结构分'),
          ...(row.candidate.machine_evidence ?? []).slice(0, 2),
        ],
        unverified: uniqueSorted([
          ...(row.candidate.unverified ?? []),
          '未核实：这三个口径的取舍代价 —— 标签是决策口径，没有对局数据支持（ENGINE_HYPOTHESIS）',
        ]),
        confidence: 'ENGINE_HYPOTHESIS',
      });
    }
  }

  return {
    ok: applicable
      ? (picks.length === PROGRESSIVE_STRATEGIES.length && problems.length === 0)
      : (picks.length === 0 && problems.length === 0),
    applies: applicable,
    not_applicable_reason: applicable ? null
      : `已选 ${inTeamCount} 只：渐进推荐只在已选 2～5 只时给「下一只」（13 号文档 §6）`,
    notes,
    selected_count: inTeamCount,
    picks,
    pick_count: picks.length,
    strategies: PROGRESSIVE_STRATEGIES.map((s) => ({id: s.id, label: s.label, intent: s.intent, tradeoff: s.tradeoff})),
    base_score: baseScore,
    base_features: compactFeatures(baseFeatures),
    problems,
    criteria: STRUCTURAL_CRITERIA.progressive_three,
    confidence: 'ENGINE_HYPOTHESIS',
    machine_evidence: [
      evidence(RC303_REPORT_PATH, 'labels.progressive_strategies', 'value', PROGRESSIVE_STRATEGIES.map((s) => s.id),
        '三个标签是决策口径（强度 / 稳定 / 偏好保留），不是胜率'),
      evidence('data/roco/owned/owned-pets.json', 'instances[].favourite', 'count',
        [...index.instances.values()].filter((i) => i.favourite === true).length,
        '偏好保留口径只看这个字段，不引用社区榜单'),
      evidence(FROZEN_PATHS.roster48, 'pets[].stats.spe', 'count_with_value', index.facts.speed_validated,
        '稳定口径里的速度层次只用冻结档位'),
    ],
    unverified: uniqueSorted([
      '未核实：推荐的第六只（或第 N 只）在对局里值多少 —— 没有 Completion Value 训练产物，'
        + '这里只有规则结构分的边际增益',
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 一条龙：召回 → Beam → 排序（在线入口）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 在线一条龙。**它只用静态数据**：不跑模拟、不起进程、不读盘。
 *
 * @returns {{ok, recall, beam, ranking, progressive, confidence, unverified, machine_evidence, segment_latency_ms}}
 */
export function buildTeamCandidatePlan(request, inputs = {}) {
  const index = inputs.__index ?? buildCandidateIndex(inputs);
  const policy = resolvePolicy(inputs.policy);
  const recall = recallCandidates(request, {...inputs, __index: index, policy});
  const beam = beamComplete(request, recall.candidates, {
    ...(inputs.budgets ?? {}), inputs: {...inputs, __index: index}, policy, __index: index,
  });
  const ranking = scoreTeams(beam.teams, {ranker: inputs.ranker ?? null, k: inputs.k ?? 10, inputs: {...inputs, __index: index}});
  const progressive = progressiveNext(request, {...inputs, __index: index, policy, recall});
  const problems = [...recall.problems ?? [], ...beam.problems, ...progressive.problems];
  return {
    ok: recall.ok && beam.ok && problems.length === 0,
    recall, beam, ranking, progressive,
    recall_count: recall.count,
    team_count: beam.team_count,
    top_k: ranking.teams.length,
    ranker_status: ranking.ranker_status,
    confidence: CONFIDENCE_RANK[ranking.confidence] <= CONFIDENCE_RANK[recall.candidates?.[0]?.confidence ?? 'UNKNOWN']
      ? ranking.confidence : recall.candidates?.[0]?.confidence ?? 'UNKNOWN',
    problems,
    unverified: uniqueSorted([...recall.unverified, ...beam.unverified, ...ranking.unverified, ...progressive.unverified]),
    machine_evidence: [
      ...recall.machine_evidence.slice(0, 3),
      ...beam.machine_evidence.slice(0, 2),
      ...ranking.machine_evidence.slice(0, 2),
    ],
    online_boundary: {
      engine_calls: 0,
      subprocess_calls: 0,
      simulations: 0,
      criteria: STRUCTURAL_CRITERIA.online_no_engine,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 审计：把每条纪律变成机器判据（必红方向）
// ─────────────────────────────────────────────────────────────────────────

/** 伪精确 / 榜单禁令：这些键与词一律不许出现在输出里。 */
export const BANNED_CLAIM_KEYS = Object.freeze([
  'win_rate', 'winrate', 'win_probability', 'win_rate_smoothed', 'strength_score', 'power_score',
  'rank_score', 'tier', 'rating', 'elo', '胜率', '强度分', '期望值', '评分',
]);
export const BANNED_CLAIM_WORDS = Object.freeze([
  'T0', 'T1', 'T2', 'T3', 'S级', 'A级', 'B级', '强势', '必带', '梯队', '幻神', '超模', '版本之子', '上分首选',
  '胜率', '强度分', '强度值', '期望值',
]);

/**
 * 否定语境：本仓的 `unverified[]` 里大量出现「不是胜率 / 不是强度分 / 不许给期望值」这类
 * **声明边界**的句子。判据若把它们也判红，就会逼着实现方不再写「我不输出胜率」——
 * 那正好把最该保留的一句话删掉了。
 *
 * 所以判据是：禁词命中时看它**前面 12 个字符**里有没有否定词；有就算「这是一句否定声明」，
 * 不判红。判据仍然有牙：直接写「这只的胜率是 62%」没有否定词，照样红；
 * 而**键名**（`win_rate` 等）不受这个豁免（见 `collectBannedText` 的键检查）。
 */
export const NEGATION_MARKERS = Object.freeze(['不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '不是伪', '而非', '绝非']);

function isNegatedClaim(text, at) {
  const window = String(text).slice(Math.max(0, at - 12), at);
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
    if (pct && /(胜|概率|强|率)/.test(value) && !isNegatedClaim(value, pct.index)) {
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
 * 审计一份在线产出（`buildTeamCandidatePlan()` 的返回值）**或**把正确的产出改坏后的版本。
 * 每条判据都有必红方向，测试逐条改坏、必须变红，并把实际输出原文打出来。
 *
 * @param {object} plan 产出（或其被改坏的版本）
 * @param {object} [options]
 * @param {string} [options.source]      `src/coach/team-candidates.mjs` 的源码（用于结构判据）
 * @param {object} [options.snapshot]    同一输入**第二次**运行的结果（用于确定性判据）
 * @param {object} [options.expect]      期望值：`{universe_size, pool_size, min, max, latency}`
 * @param {object} [options.latency]     延迟报告（用于预算判据）
 * @param {Array}  [options.forbidden_plans] 额外要扫的产出数组（同一份 plan 的多次运行）
 */
export function auditTeamCandidates(plan, options = {}) {
  const problems = [];
  const push = (code, where, detail) => problems.push(auditProblem(code, where, detail));
  const recall = plan?.recall ?? null;
  const beam = plan?.beam ?? null;
  const ranking = plan?.ranking ?? null;
  const progressive = plan?.progressive ?? null;

  // ── ① 候选数必须 20～50，越界必须解释 ──
  if (!isPlainObject(recall)) {
    push('RECALL_SHAPE', 'recall', '缺 recall 段');
  } else {
    const count = Number.isInteger(recall.count) ? recall.count : arr(recall.candidates).length;
    const limits = recall.limits ?? {};
    const min = Number.isInteger(limits.min) ? limits.min : RECALL_MIN;
    if (count < min && !recall.shortfall_reason) {
      push('RECALL_COUNT_UNEXPLAINED', 'recall.count',
        `召回 ${count} 个 < 下界 ${min}，却没有 shortfall_reason：凑不满也要说明为什么，不许凑数，也不许沉默`);
    }
    if (count > (limits.max ?? RECALL_MAX)) {
      if (!recall.overflow_reason) {
        push('RECALL_COUNT_UNEXPLAINED', 'recall.count',
          `召回 ${count} 个 > 上界 ${limits.max ?? RECALL_MAX}，却没有 overflow_reason`);
      }
    }
    if (count !== arr(recall.candidates).length) {
      push('RECALL_SHAPE', 'recall.count', `count=${count} 与 candidates.length=${arr(recall.candidates).length} 不一致`);
    }
    for (const candidate of arr(recall.candidates)) {
      if (!Array.isArray(candidate.machine_evidence) || candidate.machine_evidence.length === 0) {
        push('EVIDENCE_MISSING', `recall.candidates[${candidate?.candidate_key ?? '?'}]`, '候选没有 machine_evidence');
      } else if (candidate.machine_evidence.some((item) => !item?.source_file || !item?.pointer || !item?.field)) {
        push('EVIDENCE_MISSING', `recall.candidates[${candidate?.candidate_key ?? '?'}].machine_evidence`,
          '证据项缺 source_file / pointer / field');
      }
      if (!Array.isArray(candidate.unverified)) {
        push('EVIDENCE_MISSING', `recall.candidates[${candidate?.candidate_key ?? '?'}]`, '候选缺 unverified[]');
      }
      if (!CONFIDENCE_LEVELS.includes(candidate.confidence)) {
        push('CONFIDENCE_NOT_IN_LEDGER', `recall.candidates[${candidate?.candidate_key ?? '?'}].confidence`,
          `confidence ${stableJson(candidate.confidence)} 不在台账六级里`);
      }
    }
    // 候选宇宙必须跟着注入数据走，不能是写死的白名单。
    const facts = recall.facts ?? {};
    const expected = options.expect ?? {};
    if (Number.isInteger(expected.universe_size) && Number.isInteger(facts.catalog_pet_entities)
      && facts.catalog_pet_entities !== expected.universe_size) {
      push('WHITELIST_FIXED_POOL', 'recall.facts.catalog_pet_entities',
        `注入的 pack 有 ${expected.universe_size} 个 pet 实体，产出却写 ${facts.catalog_pet_entities}：候选宇宙没有跟着注入数据走`);
    }
    if (Number.isInteger(expected.owned_instances) && Number.isInteger(facts.owned_instances)
      && facts.owned_instances !== expected.owned_instances) {
      push('WHITELIST_FIXED_POOL', 'recall.facts.owned_instances',
        `注入的 owned 有 ${expected.owned_instances} 个实例，产出却写 ${facts.owned_instances}`);
    }
    if (Number.isInteger(expected.pool_size) && Number.isInteger(recall.pool?.pool_size)
      && recall.pool.pool_size > expected.pool_size) {
      push('WHITELIST_FIXED_POOL', 'recall.pool.pool_size',
        `产出的候选池（${recall.pool.pool_size}）比注入的候选宇宙（${expected.pool_size} 个条目）还大：`
        + '候选不可能凭空出现');
    }
  }

  // ── ② 在线段不许出现引擎 / 子进程调用 ──
  const section = options.online_section ?? (typeof options.source === 'string' ? onlineSectionOf(options.source) : null);
  if (typeof section === 'string') {
    for (const hit of scanForbiddenPatterns(section)) {
      push(hit.code, `src/coach/team-candidates.mjs:${hit.line}`,
        `在线段出现 ${hit.pattern}：${hit.detail}（实际源码 ${stableJson(hit.text)}）`);
    }
    for (const name of OFFLINE_ENTRYPOINTS) {
      if (section.includes(name.id)) {
        push('OFFLINE_ENTRYPOINT_IN_ONLINE_SECTION', `src/coach/team-candidates.mjs`,
          `离线入口 ${name.id} 出现在在线段里：离线与在线入口必须分开导出`);
      }
    }
  }

  // ── ③ 没有排序器就必须 missing，且不许出现胜率 ──
  if (!isPlainObject(ranking)) {
    push('RANKER_SHAPE', 'ranking', '缺 ranking 段');
  } else {
    if (!RANKER_STATUSES.includes(ranking.ranker_status)) {
      push('RANKER_SHAPE', 'ranking.ranker_status', `ranker_status ${stableJson(ranking.ranker_status)} 不在 ${RANKER_STATUSES.join('/')} 里`);
    }
    if (ranking.ranker_status !== 'ready') {
      if (ranking.confidence !== 'ENGINE_HYPOTHESIS') {
        push('RANKER_OVERCLAIM', 'ranking.confidence',
          `ranker_status=${ranking.ranker_status} 时 confidence 必须是 ENGINE_HYPOTHESIS，实际 ${stableJson(ranking.confidence)}`);
      }
      if (arr(ranking.teams).some((team) => team.score_source !== 'rule_score')) {
        push('RANKER_OVERCLAIM', 'ranking.teams[].score_source',
          'ranker_status 不是 ready，却有队伍的 score_source 不是 rule_score：在假装有排序器');
      }
    } else {
      if (ranking.ranker_injected !== true) {
        push('RANKER_OVERCLAIM', 'ranking.ranker_injected',
          'ranker_status=ready，但 ranker_injected 不是 true：报「有排序器」就必须同时说明这次真的注入了它，'
          + '否则就是把 missing 事后改成 ready');
      }
      if (!ranking.ranker_id || !ranking.ranker_version) {
        push('RANKER_SHAPE', 'ranking.ranker_id',
          'ranker_status=ready 却没有 ranker_id/version：版本化产物必须能指出版本');
      }
    }
    if (arr(ranking.teams).length > 10) {
      push('RANKER_SHAPE', 'ranking.teams', `Top-K 最多 10 支，实际 ${arr(ranking.teams).length} 支`);
    }
    for (const team of arr(ranking.teams)) {
      if (!Array.isArray(team.machine_evidence) || team.machine_evidence.length === 0) {
        push('EVIDENCE_MISSING', `ranking.teams[${team?.team_key ?? '?'}]`, '队伍没有 machine_evidence');
      }
      if (!Array.isArray(team.unverified)) {
        push('EVIDENCE_MISSING', `ranking.teams[${team?.team_key ?? '?'}]`, '队伍缺 unverified[]');
      }
    }
  }

  // ── ④ 硬约束 ──
  const request = options.request ?? null;
  if (request && isPlainObject(beam)) {
    const mustInclude = arr(request.must_include);
    const mustExclude = arr(request.must_exclude);
    const locked = arr(request.locked);
    for (const id of mustInclude) {
      const member = arr(beam.teams).some((team) => arr(team.members).some((m) =>
        m.instance_id === id || m.species_id === id || m.key === `owned:${id}` || m.key === `catalog:${id}`));
      if (!member) {
        push('CONSTRAINT_VIOLATED', 'beam.teams',
          `must_include 里的 ${id} 在补全结果里找不到：约束被违反，或者根本补不出队伍`);
      }
    }
    for (const id of mustExclude) {
      const hit = arr(beam.teams).flatMap((team) => arr(team.members))
        .find((m) => m.instance_id === id || m.species_id === id);
      if (hit) push('CONSTRAINT_VIOLATED', 'beam.teams', `must_exclude 里的 ${id} 出现在队伍成员 ${hit.key} 里`);
    }
    for (const id of locked) {
      const member = arr(beam.teams).some((team) => arr(team.members).some((m) => m.instance_id === id));
      if (!member) push('CONSTRAINT_VIOLATED', 'beam.teams', `locked 的实例 ${id} 不在任何补全队伍里`);
    }
  }

  // ── ⑤ 确定性 ──
  if (options.snapshot) {
    const pairs = [
      ['recall', recall, options.snapshot.recall],
      ['beam', beam, options.snapshot.beam],
      ['ranking', ranking, options.snapshot.ranking],
      ['progressive', progressive, options.snapshot.progressive],
    ];
    for (const [name, a, b] of pairs) {
      if (a === undefined || b === undefined) continue;
      if (stableJson(a) !== stableJson(b)) {
        push('NONDETERMINISTIC', name, '同一输入两次运行的输出不是逐字节相同（含 tie-break）');
      }
    }
  }

  // ── ⑥ 三个口径 ──
  if (!isPlainObject(progressive)) {
    push('PROGRESSIVE_SHAPE', 'progressive', '缺 progressive 段');
  } else {
    const selectedCount = Number.isInteger(progressive.selected_count) ? progressive.selected_count : null;
    const shouldApply = selectedCount !== null && selectedCount >= 2 && selectedCount <= 5;
    if (shouldApply !== (progressive.applies === true)) {
      push('PROGRESSIVE_NOT_THREE', 'progressive.applies',
        `已选 ${selectedCount} 只时 applies 应当是 ${shouldApply}，实际是 ${progressive.applies}：`
        + '2～5 只必须给恰好三个候选，其它只数不许硬凑三个');
    }
    if (progressive.applies) {
      if (arr(progressive.picks).length !== PROGRESSIVE_STRATEGIES.length) {
        push('PROGRESSIVE_NOT_THREE', 'progressive.picks',
          `已选 ${selectedCount} 只时下一只候选必须是恰好 ${PROGRESSIVE_STRATEGIES.length} 个，实际 ${arr(progressive.picks).length} 个`);
      }
      const labels = new Set(PROGRESSIVE_STRATEGIES.map((s) => s.label));
      const seen = new Set();
      for (const pick of arr(progressive.picks)) {
        if (!labels.has(pick?.tradeoff_label)) {
          push('PROGRESSIVE_NOT_THREE', `progressive.picks[${pick?.candidate_key ?? '?'}]`,
            `取舍标签 ${stableJson(pick?.tradeoff_label)} 不是 强度 / 稳定 / 偏好保留 之一`);
        }
        if (seen.has(pick?.tradeoff_id)) {
          push('PROGRESSIVE_NOT_THREE', 'progressive.picks', `口径 ${pick?.tradeoff_id} 出现了两次：三个候选必须覆盖三个口径`);
        }
        seen.add(pick?.tradeoff_id);
        if (!Array.isArray(pick?.machine_evidence) || pick.machine_evidence.length === 0) {
          push('EVIDENCE_MISSING', `progressive.picks[${pick?.candidate_key ?? '?'}]`, '候选缺 machine_evidence');
        }
      }
    } else if (arr(progressive.picks).length !== 0) {
      push('PROGRESSIVE_NOT_THREE', 'progressive.picks',
        `applies=false 时不该给出 next 候选，实际有 ${arr(progressive.picks).length} 个`);
    }
  }

  // ── ⑦ 延迟预算 ──
  if (options.latency) {
    const budget = options.latency.budget_comparison ?? null;
    if (isPlainObject(budget)) {
      for (const [key, row] of Object.entries(budget)) {
        if (row?.p95_ms === null || row?.p95_ms === undefined) continue;
        const within = row.p95_ms <= row.budget_ms;
        if (within !== row.within_budget) {
          push('LATENCY_BUDGET_FALSE_PASS', `latency.budget_comparison.${key}`,
            `实测 P95 ${row.p95_ms}ms 与预算 ${row.budget_ms}ms 的关系是 within=${within}，报告却写 within_budget=${row.within_budget}`);
        }
      }
    }
  }

  // ── ⑧ 文本禁令 ──
  const hits = [];
  collectBannedText({
    recall: recall ? {count: recall.count, shortfall_reason: recall.shortfall_reason, overflow_reason: recall.overflow_reason,
      unverified: recall.unverified} : null,
    beam: beam ? {truncated: beam.truncated, unverified: beam.unverified} : null,
    ranking: ranking ? {ranker_reason: ranking.ranker_reason, unverified: ranking.unverified,
      teams: arr(ranking.teams).map((t) => ({unverified: t.unverified}))} : null,
    progressive: progressive ? {picks: arr(progressive.picks).map((p) => ({tradeoff_note: p.tradeoff_note, unverified: p.unverified}))} : null,
  }, 'plan', hits);
  for (const hit of hits) push(hit.code, hit.path, `${hit.word}：${hit.text}`);
  // 键级禁令要扫**整份产出**：伪精确数值最容易藏进队伍/候选的自定义字段里（`win_rate` 之类）。
  // 这里只判键，不看语句（语句的否定语境由上面的 `collectBannedText` 处理）。
  const keyHits = [];
  const walkKeys = (node, path, depth = 0) => {
    if (depth > 10 || node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walkKeys(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (BANNED_CLAIM_KEYS.includes(key)) keyHits.push({path: `${path}.${key}`, key});
      walkKeys(item, `${path}.${key}`, depth + 1);
    }
  };
  walkKeys(plan, 'plan');
  for (const hit of keyHits) {
    push('PSEUDO_PRECISION', hit.path,
      `键 ${hit.key}：伪精确数值（胜率/强度分/评分/期望值一类）不许出现在产出里，任何层级都不行`);
  }

  return {ok: problems.length === 0, problems, banned_hits: [...hits, ...keyHits]};
}

// ─────────────────────────────────────────────────────────────────────────
// 读盘（只在 Node 侧；动态 import）
// ─────────────────────────────────────────────────────────────────────────

let cachedCandidateInputs = null;

/** 读取候选生成所需的全部数据（RC-301 四份 + 冻结迁移层 + 台账）。**只读**。 */
export async function loadTeamCandidatesInputs({root = null, cache = true} = {}) {
  if (cache && cachedCandidateInputs) return cachedCandidateInputs;
  const {loadTeamGapsInputs} = await import('./team-gaps.js');
  const inputs = await loadTeamGapsInputs({root, cache: false});
  const {readFileSync} = await import('node:fs');
  const {join, resolve} = await import('node:path');
  const base = resolve(root ?? inputs.root ?? process.cwd());
  const ledger = inputs.ledger ?? JSON.parse(readFileSync(join(base, FROZEN_PATHS.ledger), 'utf8'));
  const enriched = {...inputs, ledger, root: base};
  if (cache) cachedCandidateInputs = enriched;
  return enriched;
}

/** 清掉缓存（测试用）。 */
export function resetTeamCandidatesInputsCache() {
  cachedCandidateInputs = null;
}

// ─────────────────────────────────────────────────────────────────────────
// RC-303 机器可读报告
// ─────────────────────────────────────────────────────────────────────────

/** 报告用的样例形态：每种一个**经 RC-301 校验过**的真实请求。 */
export const SAMPLE_SHAPES = Object.freeze([
  Object.freeze({id: 'empty-team', note: '一只都没选：按目标给体系入口式的候选', pick: () => ({})}),
  Object.freeze({id: 'two-selected', note: '已选 2 只：渐进推荐三个下一只', pick: (ids) => ({selected: ids.slice(0, 2)})}),
  Object.freeze({id: 'five-selected', note: '已选 5 只：只差第六只', pick: (ids) => ({selected: ids.slice(0, 5)})}),
  Object.freeze({
    id: 'favours-only-three', note: '已选 3 只收藏：候选池收窄到收藏',
    pick: (ids, inputs) => ({
      selected: [...inputs.owned.instances].filter((i) => i.favourite === true).map((i) => i.instance_id).sort().slice(0, 3),
      favourites_only: true,
    }),
  }),
  Object.freeze({
    id: 'must-include-species', note: '锁定一只 + must_include 一个图鉴物种',
    // 注意：这里给的只是「请求的补丁」，**渐进推荐的只数按这个补丁算**（selected 是它自己的字段）。
    // 所以要凑出「已选 2 只 ⇒ 渐进推荐生效」的形状，就得把两只都写进 selected。
    pick: (ids, inputs, index) => ({
      locked: [ids[0]], selected: ids.slice(0, 2),
      must_include: [[...index.packPetEntities].map((row) => row.entity.id).sort()[0]],
    }),
  }),
  Object.freeze({
    id: 'must-exclude-three', note: '已选 3 只并排除两只：候选池被硬约束收窄',
    pick: (ids) => ({selected: ids.slice(0, 3), must_exclude: ids.slice(6, 8)}),
  }),
  Object.freeze({
    id: 'full-six', note: '六只完整队伍：召回只剩 0 个槽位，如实报告',
    pick: (ids) => ({selected: ids.slice(0, 6)}),
  }),
]);

/** 报告样例用的束宽：比在线默认宽，为了在样例里给出 ≥6 支**不同**的完整队伍供人看。
 *  它同样是显式参数，报告里写出实际值；不改变在线默认预算（见 DEFAULT_BEAM_BUDGETS）。 */
export const REPORT_BEAM_WIDTH = 8;

/**
 * 报告里的队伍投影：保留评审需要看的东西（成员、分数、证据、未核实、特征计数），
 * 去掉**逐成员重复且体积大**的部分（`recall_parts` / `recall_detail` / `recall_criteria`）。
 * 去掉的是冗余，不是证据：`machine_evidence` 与 `unverified` 一个都不删。
 */
const compactTeam = (team) => ({
  ...team,
  members: arr(team.members).map((m) => {
    const {recall_parts, recall_detail, recall_criteria, ...rest} = m;
    return rest;
  }),
});

const verdict = (label, criteria, actual, ok) => ({label, criteria, actual, ok});

/**
 * 生成 `reports/roco/flagship-upgrade/rc-303-team-candidates.json` 的内容。
 *
 * 纯函数：同一份输入两次调用逐字节相同（没有挂钟字段；延迟由独立的测量脚本产出后合并）。
 */
export function buildRc303Report(inputs = {}, options = {}) {
  const index = buildCandidateIndex(inputs);
  const ids = [...index.instances.keys()].sort();
  const rulesetEnergyCap = options.ruleset_energy_cap ?? null;
  const budgets = {...DEFAULT_BEAM_BUDGETS, beamWidth: REPORT_BEAM_WIDTH, ...(options.budgets ?? {})};
  const source = options.source ?? null;

  const samples = SAMPLE_SHAPES.map((shape) => {
    const raw = {mode: 'pvp-standard-six-pet', team_size: STANDARD_PVP_TEAM_SIZE, ...shape.pick(ids, inputs, index)};
    const request = options.validated?.(raw) ?? raw;
    const plan = buildTeamCandidatePlan(request, {...inputs, __index: index, rulesetEnergyCap, budgets});
    const second = buildTeamCandidatePlan(request, {...inputs, __index: index, rulesetEnergyCap, budgets});
    const audit = auditTeamCandidates(plan, {
      source, snapshot: second, request,
      expect: {universe_size: index.facts.catalog_pet_entities, owned_instances: index.facts.owned_instances},
    });
    return {
      id: shape.id,
      note: shape.note,
      request,
      recall_count: plan.recall_count,
      recall_limits: plan.recall.limits,
      shortfall_reason: plan.recall.shortfall_reason,
      overflow_reason: plan.recall.overflow_reason,
      team_count: plan.team_count,
      top_k: plan.top_k,
      ranker_status: plan.ranker_status,
      confidence: plan.confidence,
      deterministic: audit.problems.every((p) => p.code !== 'NONDETERMINISTIC'),
      audit_ok: audit.ok,
      audit_problems: audit.problems.map(formatAuditProblem),
      beam_budgets: plan.beam.budgets,
      top_teams: plan.ranking.teams.slice(0, 10).map(compactTeam),
      progressive: {
        applies: plan.progressive.applies,
        pick_count: plan.progressive.pick_count,
        picks: plan.progressive.picks,
      },
    };
  });

  const criteria = [
    verdict('召回数量落在 [20, 50] 或给出短欠原因',
      STRUCTURAL_CRITERIA.recall_bounds,
      samples.map((s) => `${s.id}: ${s.recall_count}${s.shortfall_reason ? '（有 shortfall_reason）' : ''}`),
      samples.every((s) => (s.recall_count >= s.recall_limits.min && s.recall_count <= s.recall_limits.max) || Boolean(s.shortfall_reason))),
    verdict('在线段没有引擎 / 子进程调用',
      STRUCTURAL_CRITERIA.online_no_engine,
      typeof source === 'string' ? scanForbiddenPatterns(onlineSectionOf(source)).map((h) => h.pattern) : '未注入源码',
      typeof source === 'string' && scanForbiddenPatterns(onlineSectionOf(source)).length === 0),
    verdict('没有排序器时 ranker_status = missing 且排序标 ENGINE_HYPOTHESIS',
      STRUCTURAL_CRITERIA.ranker_honesty,
      samples.map((s) => `${s.id}: ${s.ranker_status}`),
      samples.every((s) => s.ranker_status === 'missing')),
    verdict('候选能用到注入宇宙（600+）里的实体，不是固定白名单',
      STRUCTURAL_CRITERIA.candidate_universe,
      {
        universe_size: index.facts.catalog_pet_entities,
        owned_instances: index.facts.owned_instances,
        catalog_namespaces_in_top_teams: uniqueSorted(samples.flatMap((s) => s.top_teams.flatMap((t) => t.members.map((m) => m.namespace)))),
        catalog_species_seen: uniqueSorted(samples.flatMap((s) => s.top_teams.flatMap((t) => t.members
          .filter((m) => m.namespace === 'catalog_species').map((m) => m.species_id)))),
      },
      index.facts.catalog_pet_entities > index.facts.validated_species),
    verdict('硬约束零违反（must_include / must_exclude / locked）',
      STRUCTURAL_CRITERIA.constraints,
      samples.map((s) => ({id: s.id, audit_ok: s.audit_ok,
        constraint_problems: s.audit_problems.filter((line) => line.startsWith('[CONSTRAINT_VIOLATED]'))})),
      samples.every((s) => s.audit_ok)),
    verdict('确定性：两次运行逐字节相同',
      STRUCTURAL_CRITERIA.deterministic,
      samples.map((s) => `${s.id}: deterministic=${s.deterministic}`),
      samples.every((s) => s.deterministic)),
    verdict(`渐进推荐恰好 ${PROGRESSIVE_STRATEGIES.length} 个候选且带取舍标签`,
      STRUCTURAL_CRITERIA.progressive_three,
      samples.map((s) => `${s.id}: applies=${s.progressive.applies} picks=${s.progressive.pick_count}`),
      samples.every((s) => (s.progressive.applies ? s.progressive.pick_count === PROGRESSIVE_STRATEGIES.length : true))),
    verdict('每个候选与每支队伍都有机器证据',
      STRUCTURAL_CRITERIA.evidence,
      samples.map((s) => `${s.id}: audit_ok=${s.audit_ok}`),
      samples.every((s) => s.audit_ok)),
  ];

  // 真实样例挑「队伍最多的那一个」，保证报告里有 ≥6 支不同的队伍逐条带证据。
  const realSample = [...samples].sort((a, b) => (b.top_teams.length - a.top_teams.length))[0];
  return {
    report_version: RC303_REPORT_VERSION,
    rc: 'RC-303',
    title: '候选生成：离线产标签、在线只召回 + Beam + 排序',
    candidate_universe: {
      definition: 'pack.json 的 pet 实体（600+ 候选宇宙）∪ owned 实例；**不是**写死的白名单',
      catalog_pet_entities: index.facts.catalog_pet_entities,
      owned_instances: index.facts.owned_instances,
      owned_species: index.facts.owned_species,
      species_with_frozen_learnset: index.facts.species_with_frozen_learnset,
      registered_attack_types: index.facts.registered_attack_types,
      note: '召回默认按 policy.candidate_universe = catalog（全量图鉴 + 玩家箱子）；'
        + 'catalog 候选被标 namespace = catalog_species 并在 unverified 里点名「四技能与合法性未校验」',
    },
    recall: {
      min: RECALL_MIN,
      max: RECALL_MAX,
      criteria: STRUCTURAL_CRITERIA.recall_bounds,
      score_criteria: RECALL_SCORE_CRITERIA,
    },
    beam: {
      budgets,
      report_beam_width: REPORT_BEAM_WIDTH,
      criteria: STRUCTURAL_CRITERIA.deterministic,
      note: '束搜索不枚举全组合：宽度 × 层高 × 候选数是有界工作，节点上限与时间上限是硬参数',
    },
    ranker: {
      status: 'missing',
      reason: '本仓现在**没有**版本化 Team Ranker 产物（13 号文档 §5.1 的离线链路还没产出标签）。'
        + '按「读来的，不是编的」的纪律：没有产物就报 missing，排序退化成规则打分并标 ENGINE_HYPOTHESIS。',
      degrade_to: 'rule_score',
      rule_score_weights: RULE_SCORE_WEIGHTS,
      no_win_rate: true,
      how_to_make_it_ready: '离线跑 league / 自博弈 → matchup bank → Team Pairwise Ranker → 落 '
        + '`data/roco/ranker/team-ranker-v1.json`（含 ranker_id / version / calibrated），再作为 `ranker` 注入本模块',
      criteria: STRUCTURAL_CRITERIA.ranker_honesty,
    },
    offline_online_boundary: {
      online_entrypoints: ONLINE_ENTRYPOINTS,
      offline_entrypoints: OFFLINE_ENTRYPOINTS,
      forbidden_online_patterns: FORBIDDEN_ONLINE_PATTERNS,
      online_section_marker: ONLINE_SECTION_MARKER,
      offline_section_marker: OFFLINE_SECTION_MARKER,
      scan_result: source === null ? null : {
        online_section_lines: onlineSectionOf(source).split('\n').length,
        forbidden_hits: scanForbiddenPatterns(onlineSectionOf(source)),
      },
      why_no_online_simulation: [
        '13 号文档 §5：模拟器的价值是离线产标签、发现反例、做回归、训练 Value；在线批量 rollout 放不进 300ms 预算',
        '一次完整对局要跑规则引擎（Python）→ 起进程 + 序列化 + 多回合搜索，量级在百毫秒到秒级，且 P95 不可控',
        '在线只需要「静态特征 → 相对排序」：属性倍率/速度档/能耗/应对/换入都是读表 O(1) 的事',
        '把模拟放在在线会让 P95 变成硬件与对手策略的函数，而不是数据的函数',
      ],
    },
    latency_budget: LATENCY_BUDGET_MS,
    latency: options.latency ?? {
      available: false,
      reason: '延迟实测由 `node scripts/roco/measure-team-candidates.mjs` 产出，报告生成时未合并',
      report_path: 'reports/roco/team-candidates/latency.json',
    },
    progressive: {
      applicable_when: '已选 2～5 只（13 号文档 §6）',
      strategies: PROGRESSIVE_STRATEGIES,
      criteria: STRUCTURAL_CRITERIA.progressive_three,
      note: '三个标签是**决策口径**（强度 / 稳定 / 偏好保留），不是胜率；三个口径允许指向同一只',
    },
    criteria,
    samples,
    real_sample: {
      id: realSample.id,
      note: realSample.note,
      request: realSample.request,
      recall_count: realSample.recall_count,
      team_count: realSample.team_count,
      top_teams: realSample.top_teams.slice(0, 6).map(compactTeam),
      progressive: realSample.progressive,
    },
    does_not_do: [
      '不跑任何对局模拟、不调用 Python 引擎、不起子进程（在线段结构判据钉住）',
      '不训练模型，也不假装有排序器：没有注入 ranker 就 ranker_status = missing',
      '不输出胜率 / 强度分 / 社区榜单标签',
      '不枚举 C(622, 6)（见 docs/roco/TEAM-CANDIDATES.md §组合爆炸）',
    ],
    unverified: [
      '未核实：任何「强度」结论 —— 13 号文档 §4 的 expected_meta_value / CVaR / matchup_spread 都需要离线联赛标签，RC-304 之前不存在',
      '未核实：候选与排序的权重 —— RULE_SCORE_WEIGHTS 是工程假设（台账里没有对应条目）',
      `未核实：${index.facts.catalog_pet_entities - index.facts.species_with_frozen_learnset} 只图鉴精灵的四技能与配招合法性`,
      '未核实：属性倍率逐条正确性（台账 type.multiplier = COMMUNITY_CURRENT）',
    ],
    generated_by: 'src/coach/team-candidates.mjs#buildRc303Report（纯函数，不读时钟）',
  };
}

// ── 下面的内容属于离线入口：在线路径**不**使用它们 ──────────────────────────
/* OFFLINE-SECTION-BEGIN */

/**
 * 离线产标签的**工作单**（不是一个跑模拟的函数）。
 *
 * 为什么只给工作单：本模块的在线段必须保持「无引擎、无子进程」的结构（见
 * `FORBIDDEN_ONLINE_PATTERNS`）。真正跑 league / 自博弈的是离线流程（13 号文档 §5.1），
 * 它由人工或后续 RC 单独驱动；本 RC 只把「离线该产出什么、在线该读什么」钉成声明，
 * 好让 `ranker_status = missing` 这件事有明确的解除条件。
 *
 * 调用方：离线流程 / 文档维护者。**在线路径不得调用它**（`OFFLINE_ENTRYPOINTS` 里登记）。
 */
export function buildOfflineLabelPlan({ruleset_version = null, seasons = [], archetypes = []} = {}) {
  return {
    plan_version: 'roco-rc303-offline-label-plan/v1',
    runs_simulations: false,
    note: '这是工作单不是执行器：本模块不跑模拟、不起进程。执行由离线流程负责。',
    steps: [
      {id: 'league', what: '用规则引擎 + 多种 opponent policy 跑离线联赛，产 synthetic label', engine: 'offline'},
      {id: 'selfplay', what: '自博弈发现反制阵容，产 exploration sample', engine: 'offline'},
      {id: 'counterfactual', what: '反事实替换生成「为什么」与边际贡献', engine: 'offline'},
      {id: 'matchup_bank', what: '把对局结果折成 matchup bank（按 archetype / 赛季 / 规则版本分桶）', engine: 'offline'},
      {id: 'completion_value', what: '训练 Partial-team Completion Value（支持 0～5 只部分阵容）', engine: 'offline'},
      {id: 'ranker', what: '训练 Team Pairwise Ranker（GBDT 基线 → DeepSets/Set Transformer）', engine: 'offline'},
      {id: 'calibration', what: '在 held-out 家族/体系上做校准，写出 calibrated 字段', engine: 'offline'},
      {id: 'publish', what: '落盘为版本化产物并把 ranker_id/version/calibrated 告知在线入口', engine: 'offline'},
    ],
    outputs: [
      {path: 'data/roco/ranker/team-ranker-v1.json', exists: false, consumed_by: 'scoreTeams({ranker})'},
      {path: 'data/roco/ranker/completion-value-v1.json', exists: false, consumed_by: 'progressiveNext（未来）'},
      {path: 'reports/roco/team-candidates/matchup-bank.json', exists: false, consumed_by: 'RC-304'},
    ],
    context: {ruleset_version, seasons: [...seasons].sort(), archetypes: [...archetypes].sort()},
  };
}
