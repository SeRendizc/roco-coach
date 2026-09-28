// ── RC-602：成对（pairwise）结构排序器 + 部分队伍补全价值 ────────────────────────
//
// 这一批要补的是 RC-303 `resolveRanker()` 里那个 `missing`：**一个排序器**。
// 但补它有一条线不许越：
//
//   · 本文件是**规则启发式**，不是学习模型。没有任何一条权重来自对局数据，
//     所以导出 `RANKER_STATUS` 机器可读地把这件事说死（`learned_weights: false`、
//     `calibrated: false`、`training_labels: 0`），并由 `auditWeightTable()` 钉住
//     「每条权重必须带 `provenance` + 理由」；
//   · **永不**产出胜负预测 / 概率 / 百分数。分数是 0～1 的**序数**标度
//     （`RANKER_UNITS.relative`），只在同一份注入特征内比大小，不代表「赢多少」；
//   · 未知就是未知：算不出的特征一律 `available:false` + `unknown_reason`，
//     不许拿 0 顶替、不许补默认值。一整条队伍只要有一个必算特征拿不到值，
//     这条队伍就进 `unranked[]`，**不参与排序**（不是 0 分混进去）；
//   · 面板值 / 养成效果（性格 / 资质 / 特长 / 血脉 / `panel_stats`）在冻结数据里
//     就是 `unknown`（见 `data/roco/owned/owned-pets.json` 的 `growth_attribute_policy`），
//     所以「关键速度线」这一项现在**算不出来**，只能给出速度档位层次；
//   · 纯函数：不读盘、不联网、不起进程、不模拟对局、不看时钟。数据全部显式注入
//     （`ctx.index` 或 `ctx.inputs`）。读盘只发生在测试/报告脚本里。
//
// 依赖：只 import 同仓纯函数模块 `./team-gaps.js`（RC-302 的属性倍率 / 能耗 / 应对 /
// 换入判据与索引）与 `./team-candidates.mjs`（RC-303 的队伍特征聚合与规则打分）。
// **不复制第二套语义**：属性组合行、应对词条、换入手段、队伍聚合都调用已有实现。

import {FROZEN_PATHS, RESPOND_VARIANTS, buildGapIndex, isPivotSkill, respondVariantsOf} from './team-gaps.js';
import {buildCandidateIndex, teamFeatures} from './team-candidates.mjs';

/** 报告路径（由 `scripts/roco/build-rc602-report.mjs` 生成）。 */
export const RC602_REPORT_PATH = 'reports/roco/rc602/team-ranker.json';
export const RC602_REPORT_VERSION = 'roco-rc602-team-ranker-report/v1';

/** 产出形状的版本（排序器自报的 `version`，RC-303 的 `resolveRanker` 要读它）。 */
export const RANKER_ID = 'roco-rule-pairwise-ranker';
export const RANKER_VERSION = 'rc602/1';

/**
 * 机器可读的诚实声明。别的模块与判据读这一个对象就知道
 * 「这个排序器是什么、不是什么、要亮起来还缺什么」。
 */
export const RANKER_STATUS = Object.freeze({
  schema: 'roco-team-ranker-status/v1',
  ranker_id: RANKER_ID,
  version: RANKER_VERSION,
  kind: 'rule_heuristic',
  // 学习产物：一条都没有。没有就是没有。
  learned_weights: false,
  trained_model_present: false,
  training_labels: 0,
  calibrated: false,
  // 产出语义：只排序，不预测。
  rank_only: true,
  emits_outcome_prediction: false,
  emits_win_rate: false,
  emits_percent: false,
  // 未知处理：不补 0、不补默认值。
  unknown_policy: 'fail_closed',
  // RC-303 `resolveRanker()` 的 `missing` 说的就是「没有 Team Ranker 产物」。
  // 本文件给的是一个**结构启发式**排序器：它的分数不是强度、也没有校准证据。
  fills_rc303_ranker_missing: 'heuristic_only',
  confidence: 'ENGINE_HYPOTHESIS',
  learned_ranker_unlock_requirements: Object.freeze([
    '对局标签：RC-601 的轨迹重建必须先产出（manifest 绑定 ruleset/engine/data pack/opponent policy/split/sha256），'
      + '现在 RC-601 是 BLOCKED、仓内也没有任何一局真实对局记录',
    '标签契约：每条样本至少要能回指具体 ruleset 版本 + 双方六宠 build + 出手序列；'
      + '现在 `data/roco/evidence/rule-evidence-ledger.json` 里没有任何一条与之对应的量',
    '划分：训练/验证/测试按赛季切分（不能同赛季泄漏）；现在连一个赛季的标签都没有',
    '校准证据：排序器要报 calibrated=true 必须先有 held-out 校准（本仓现在没有）',
    '特征可用性：面板值（level/nature/talent/specialty/bloodline 换算）至今 UNKNOWN —— '
      + '没有它，任何「关键速度线」类特征都建不起来',
  ]),
  not_available_reasons: Object.freeze({
    learned_weights: '本仓没有任何 train/val/test 对局标签（RC-601 BLOCKED、RC-603 由用户亲训）',
    // 注意键名：这里刻意不叫那个常见的伪精确字段名 —— `auditRanker()` 的扫描会（正确地）
    // 把那个键名判红，而这一条的语义是「不产出任何胜负预测、也不产出任何概率」。
    outcome_prediction: '红线：不许发明胜负预测；本排序器也不产出任何概率（`emits_outcome_prediction: false`）',
    panel_stats: '冻结数据里 542 个实例的 panel_stats 一律 null，养成效果 effect=UNKNOWN',
    key_speed_lines: '关键速度线要真实面板值（对手速度阈），面板换算公式未校准 ⇒ 现在算不出来',
    calibration: '没有 held-out 校准集，所以 calibrated 只能是 false',
  }),
});

/** 所有数值的单位口径。**没有一个是百分数**；0～1 是序数标度。 */
export const RANKER_UNITS = Object.freeze({
  relative: '0～1 的**序数**标度（只用于同一份注入特征内的相对排序；不预测胜负、不是强度分、不是任何比例）',
  count: '计数（个 / 只 / 条），不带分母时不构成任何比例',
  ratio: '0～1 的占比（分子分母都来自同一份注入数据，可逐条复算；不是百分数）',
  milliseconds: '毫秒（实测墙钟，只用于延迟报告）',
});

// ─────────────────────────────────────────────────────────────────────────
// 速度轴的数据来源（2026-09-28 换源：48 → 542）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 速度轴的两份冻结来源文件。`evidence()` 的 `source_file` 直接指这两份，
 * **不再**指 `roster-48.json`（那是 M1 的 48 只**选择登记层**，不是引擎认的冻结层）。
 *
 * 换源依据：人类 2026-09-28 逐字拍板「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。
 * 所有精灵实装，这样就不需要我的精灵了，直接全筛选」⇒ 冻结可玩层 48 → **542**
 * （基线 `pets.json` 12 只 + 抓包可玩层 `layer-playable-48/pets.json` 530 只；目录名里的
 * 「48」是引擎 `roco/src/roco_env/data.py` 的 `LAYER_DIRNAME` 写死的，不改）。
 *
 * 口径**一条都没放宽**：档位映射（`SPEED_TIER_THRESHOLDS`）、权重（`WEIGHTS.speed_layers`）、
 * unknown 判定（成员拿不到 `stats.spe` 才算 unknown）全部照旧；扩的只是**覆盖**。
 *
 * 轴上每只都有 `stats.spe` 与 5 档 `speed_tier`（`speed_tier` 在可玩层的
 * `role_annotations` 里）。轴**外**还有 80 只按需推算档（图鉴 622 − 542）：
 * 它们没有冻结速度值，只有 `full-catalog.json` 的 `stats.spe`（`knowledge_only`），
 * 照旧**不**升级成已验证，也**不**给 `speed_tier`（没有冻结声明值就留 null）。
 */
export const FROZEN_SPEED_SOURCES = Object.freeze({
  baseline: FROZEN_PATHS.pets,
  playable: FROZEN_PATHS.petsOverlay,
  /** 冻结速度轴里的物种数（与 `index.roster.size` 一致；报告里另有一份现算值）。 */
  species: 542,
  /** 轴外那一档（按需推算 / `SIMULATABLE_UNVERIFIED`）的物种数。 */
  species_outside: 80,
  /** 证据里原样使用的 `source_file` 串：**两份文件都写出来**。 */
  ref: `${FROZEN_PATHS.pets} + ${FROZEN_PATHS.petsOverlay}`,
  /** `speed_tier` 的所在位置（可玩层的 5 档声明值）。 */
  tier_pointer: 'role_annotations[pet_id].speed_tier',
});

// ─────────────────────────────────────────────────────────────────────────
// 权重：显式声明 + 逐条理由。**权重不可得就返回 available:false**
// ─────────────────────────────────────────────────────────────────────────

/**
 * 一条权重的形状（判据要能机器核对）：
 *   `{id, weight, feature, provenance, reason, direction, source_ref}`。
 *
 * `provenance` 目前**只允许** `ENGINE_HYPOTHESIS`：本仓拿不出第二条值——
 * 用 `COMMUNITY_CURRENT` 会假装有社区口径来源，用 `MEASURED_*` 会假装有对局数据。
 */
export const WEIGHT_PROVENANCE_LEVELS = Object.freeze(['ENGINE_HYPOTHESIS']);

/** 六个成对维度（顺序即输出键序 ⇒ 逐字节可复跑）。 */
export const FEATURE_IDS = Object.freeze([
  'type_coverage', 'weakness_exposure', 'speed_layers', 'respond_coverage', 'energy_curve', 'pivot_sustain',
]);

/**
 * 特征定义表：每个特征一条，写清它**从哪个已算好的聚合量**取数
 * （不复制 RC-302/RC-303 的第二套语义）。
 */
export const FEATURE_DEFINITIONS = Object.freeze({
  type_coverage: Object.freeze({
    label: '属性覆盖（队伍有抗性承接的攻击系别）',
    from: 'RC-303 teamFeatures().coverage',
    source_ref: `${FROZEN_PATHS.types}#types[组合键].resist`,
    unknown_when: '队伍里任何一个成员的属性组合行没登记（冻结相性表 120 行里查不到键）',
  }),
  weakness_exposure: Object.freeze({
    label: '弱点暴露面（未承接弱点越少越好）',
    from: 'RC-303 teamFeatures().synergy',
    source_ref: `${FROZEN_PATHS.types}#types[组合键].weak`,
    unknown_when: '同 type_coverage（弱点清单建立在同一张冻结相性表上）',
  }),
  speed_layers: Object.freeze({
    label: '速度层次（快/中/慢三档的分布离散度）',
    from: 'RC-303 teamFeatures().speed',
    source_ref: `${FROZEN_PATHS.pets}#pets[].stats.spe + `
      + `${FROZEN_PATHS.petsOverlay}#pets[].stats.spe 与 role_annotations[].speed_tier（冻结速度轴 542 只）`,
    unknown_when: '队伍里任何一个成员拿不到速度值（既不在冻结速度轴 542 只里，full-catalog 也没有该物种的 '
      + 'stats.spe）；轴外那 80 只按需推算档只有 full-catalog 的 knowledge_only 值，'
      + '会在成员自己的 unknown_reason 里点名，不升级成已验证',
  }),
  respond_coverage: Object.freeze({
    label: '应对词条覆盖（应对攻击 / 应对状态 / 应对防御 三类）',
    from: 'RC-303 teamFeatures().respond',
    source_ref: `${FROZEN_PATHS.skills}#skills[].desc（词条判定见 team-gaps.js respondVariantsOf）`,
    unknown_when: '队伍里任何一个成员没有具体 build（四个技能未知）或不在冻结学招表里',
  }),
  energy_curve: Object.freeze({
    label: '能耗曲线与聚能压力（0 费出口 + 超限技能）',
    from: 'RC-303 teamFeatures().energy',
    source_ref: `${FROZEN_PATHS.skills}#skills[].energy + ${FROZEN_PATHS.skills}#skills[].ruleset 能耗上限`,
    unknown_when: '队伍里任何一个成员没有具体 build，或规则配置的能耗上限解析不出来',
  }),
  pivot_sustain: Object.freeze({
    label: '换人（pivot）与续航（有换入/离场手段的成员占比）',
    from: 'RC-303 teamFeatures().pivot',
    source_ref: `${FROZEN_PATHS.skills}#skills[].desc（关键字见 team-gaps.js isPivotSkill）`,
    unknown_when: '队伍里任何一个成员没有具体 build 或不在冻结学招表里',
  }),
});

/** 特征 id → RC-303 队伍特征里的字段名（唯一一份映射，打分与排序共用）。 */
export const FEATURE_SOURCE_KEYS = Object.freeze({
  type_coverage: 'coverage',
  weakness_exposure: 'synergy',
  speed_layers: 'speed',
  respond_coverage: 'respond',
  energy_curve: 'energy',
  pivot_sustain: 'pivot',
});

/** 分数在 `available:true` 之前必须六个维度全部算得出的那些特征（fail closed 的边界）。 */
export const REQUIRED_FEATURE_IDS = Object.freeze([...FEATURE_IDS]);

const W = (id, weight, reason) => Object.freeze({
  id,
  weight,
  feature: id,
  provenance: 'ENGINE_HYPOTHESIS',
  reason,
  direction: id === 'weakness_exposure' ? 'lower_is_better（取 1 − 未承接占比，已翻正）' : 'higher_is_better',
  source_ref: FEATURE_DEFINITIONS[id].source_ref,
});

/**
 * 权重表。**每一条都带理由与 `ENGINE_HYPOTHESIS` 标记**，没有魔数藏在函数体里。
 *
 * 数值本身是工程判断：属性相性有冻结相性表可复算，给最高；速度/应对/能耗都有冻结
 * 字段支撑，给中档；换人手段靠技能描述关键字（较弱），给最低。它们**不代表强度**。
 */
export const WEIGHTS = Object.freeze({
  type_coverage: W('type_coverage', 0.24,
    '冻结相性表（120 行，含 102 行组合）逐条可复算，是六个维度里证据最硬的一项'),
  weakness_exposure: W('weakness_exposure', 0.20,
    '与属性覆盖同源（同一张相性表），但方向相反：未承接弱点越少越好；权重略低于覆盖因为它对队伍人数更敏感'),
  speed_layers: W('speed_layers', 0.16,
    '只用冻结速度轴 542 只（基线 pets.json 12 + 抓包可玩层 layer-playable-48/pets.json 530）的 stats.spe 与 '
    + 'role_annotations[].speed_tier，542/542 有值（2026-09-28 前的旧口径只读 roster-48.json 的 48 只）；'
    + '轴外那 80 只按需推算档没有冻结速度值（只有 full-catalog 的 knowledge_only 种族值），不计入；'
    + '但真实面板值未知 ⇒ 权重不给最高，避免把「种族值层次」读成「实战先手」'),
  respond_coverage: W('respond_coverage', 0.16,
    '应对三类词条由冻结 skills[].desc 判定（RC-302 判据），542 只有冻结学招表（基线 12 + 可玩层 530）、'
    + '图鉴里另外 80 只按需推算档没有 ⇒ 中档'),
  energy_curve: W('energy_curve', 0.14,
    '能耗来自冻结 skills[].energy 与注入规则配置的上限；上限本身在候选规则版本里（RC-601 未定）⇒ 中低档'),
  pivot_sustain: W('pivot_sustain', 0.10,
    '换入/离场只靠技能描述关键字（迅捷 / 自己脱离 / 立即替换），是六个维度里最弱的一条判据 ⇒ 最低'),
});

/** 排序口径：同分必须有**稳定** tie-break（默认按 team_id 字典序）。 */
export const TIE_BREAKS = Object.freeze(['team_id_lexicographic', 'input_order']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const arr = (value) => (Array.isArray(value) ? value : []);
const uniqueSorted = (values) => [...new Set(values)].sort();
const stableJson = (value) => JSON.stringify(value);
const SCORE_DECIMALS = 4;
const round = (value, decimals = SCORE_DECIMALS) => (Number.isFinite(value)
  ? Number(value.toFixed(decimals)) : value);
/** 字典序比较器（确定性 tie-break 的地基，不依赖 locale）。 */
const byLex = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

const auditProblem = (code, where, detail) => ({code, where, detail});
export const formatRankerProblem = (p) => `[${p.code}] ${p.where}：${p.detail}`;

/** 证据项：与 RC-302 / RC-303 / RC-304 同形（source_file / pointer / field / value / note）。 */
export const evidence = (sourceFile, pointer, field, value, note = null) => ({
  source_file: sourceFile, pointer, field, value, note,
});

// ─────────────────────────────────────────────────────────────────────────
// 索引：全部复用 RC-302/RC-303，不另写一套
// ─────────────────────────────────────────────────────────────────────────

/**
 * 解析注入的上下文。
 *
 * 允许两种注入方式（都不读盘）：
 *   · `ctx.index`  —— RC-303 `buildCandidateIndex()` 的返回值（推荐，调用方建一次反复用）；
 *   · `ctx.inputs` —— RC-302 `loadTeamGapsInputs()` 的返回值（这里现建索引）。
 * 两者都没有 ⇒ `ok:false` + 点名缺什么（不静默用一个空索引算出全 0）。
 */
export function resolveRankerContext(ctx = {}) {
  if (isPlainObject(ctx.index) && typeof ctx.index.featureFor === 'function') {
    return {
      ok: true,
      index: ctx.index,
      gapsIndex: ctx.index.gapIndex,
      ruleset_energy_cap: Number.isFinite(ctx.ruleset_energy_cap) ? ctx.ruleset_energy_cap : null,
      source: 'ctx.index',
      reason: '调用方注入了 RC-303 的候选索引',
    };
  }
  if (isPlainObject(ctx.inputs)) {
    const index = buildCandidateIndex(ctx.inputs);
    return {
      ok: true,
      index,
      gapsIndex: index.gapIndex,
      ruleset_energy_cap: Number.isFinite(ctx.ruleset_energy_cap) ? ctx.ruleset_energy_cap : null,
      source: 'ctx.inputs',
      reason: '调用方注入了 RC-302 的原始输入，这里现建一次 RC-303 索引',
    };
  }
  if (isPlainObject(ctx.gapsIndex) && ctx.gapsIndex.scaleByCombo instanceof Map) {
    return {
      ok: true, index: buildCandidateIndex({}), gapsIndex: ctx.gapsIndex,
      ruleset_energy_cap: Number.isFinite(ctx.ruleset_energy_cap) ? ctx.ruleset_energy_cap : null,
      source: 'ctx.gapsIndex',
      reason: '只注入了 RC-302 的缺口索引（没有 RC-303 的候选特征层）',
    };
  }
  return {
    ok: false,
    index: null,
    gapsIndex: null,
    ruleset_energy_cap: null,
    source: null,
    reason: '既没有注入 `ctx.index`（RC-303 buildCandidateIndex 的返回值），也没有注入 `ctx.inputs`'
      + '（RC-302 的输入）：本模块不读盘，缺索引就只能 fail closed，不拿空索引算出全 0',
  };
}

/**
 * 内核：把「解析出来的 RC-303 索引 + 注入的规则配置能耗上限」打成一个不可变小对象。
 *
 * 为什么不把这些挂到 `index` 上：`index` 是 RC-303 的所有物，往别人的对象上写字段
 * 会让两次调用互相污染（第一次注入 cap、第二次不注入时读到的还是上一次的）。
 */
const kernelOf = (resolved) => Object.freeze({
  index: resolved.index,
  rulesetEnergyCap: resolved.ruleset_energy_cap,
});

/** 队伍成员的引用形状：接受 RC-301/302 的登记键（`instance:own-0001` / `catalog:pet_000001`）。 */
const memberRefOf = (member) => {
  if (isNonEmptyString(member)) {
    // 裸字符串：`instance:own-0001` → owned 实例；`catalog:pet_000001` → 图鉴物种；
    // 没带命名空间时按 RC-301/302 的默认口径当 owned 实例。
    const sep = member.indexOf(':');
    const ns = sep >= 0 ? member.slice(0, sep) : null;
    const bare = sep >= 0 ? member.slice(sep + 1) : member;
    const kind = ns === 'catalog' || ns === 'species' ? 'catalog' : 'owned';
    return {key: member, kind, instance_id: kind === 'owned' ? bare : null,
      species_id: kind === 'catalog' ? bare : null};
  }
  if (!isPlainObject(member)) return null;
  // 严格：普通对象必须至少声明一个标识（key / instance_id / id / species_id）。
  // 否则 `{nonsense: true}` 这种形状会被当成「没有 id 的 owned 实例」，静默溜进解析流程。
  const declared = ['key', 'instance_id', 'id', 'species_id'].some((field) => isNonEmptyString(member[field]));
  if (!declared) return null;
  const rawKey = isNonEmptyString(member.key) ? member.key : null;
  const [ns, id] = rawKey && rawKey.includes(':') ? [rawKey.slice(0, rawKey.indexOf(':')), rawKey.slice(rawKey.indexOf(':') + 1)] : [null, null];
  const explicitKind = isNonEmptyString(member.kind) ? member.kind : null;
  const kind = explicitKind === 'catalog' || explicitKind === 'species' ? 'catalog'
    : (explicitKind === 'owned' || explicitKind === 'instance' ? 'owned' : (ns === 'catalog' ? 'catalog' : 'owned'));
  const instanceId = isNonEmptyString(member.instance_id) ? member.instance_id
    : (kind === 'owned' ? (id ?? (isNonEmptyString(member.id) ? member.id : null)) : null);
  const speciesId = isNonEmptyString(member.species_id) ? member.species_id
    : (kind === 'catalog' ? (id ?? (isNonEmptyString(member.id) ? member.id : null)) : null);
  return {
    key: rawKey ?? (instanceId ? `instance:${instanceId}` : (speciesId ? `catalog:${speciesId}` : null)),
    kind,
    instance_id: instanceId,
    species_id: speciesId,
  };
};

/**
 * 把注入索引里的物种特征拼成 RC-303 的**成员画像**形状（`teamFeatures()` 的输入契约）。
 *
 * 为什么在这里拼：RC-303 的 `profileOf()` 是模块私有的，而 `teamFeatures()` 是公开的
 * 且接受**现成画像**。属性/速度取 `index.featureFor()`（唯一的物种特征来源），
 * 弱点取 `team-gaps.js` 的相性表（组合行优先），能耗/应对/换入取注入的技能表。
 */
function profileFromIndex(kernel, ref) {
  const index = kernel.index;
  const speciesId = ref.species_id
    ?? (ref.instance_id ? index.instances.get(ref.instance_id)?.species_id : null)
    ?? null;
  if (!speciesId) {
    return {
      key: ref.key ?? 'unknown', kind: ref.kind, instance_id: ref.instance_id ?? null,
      species_id: null, species_name: null, types: null, types_source: null,
      weakness: {weak: [], resist: [], known: false},
      spe: null, spe_status: 'unknown', speed_tier: null, speed_band: null, role: null,
      favourite: false, locked: false, validated: false, has_frozen_learnset: false,
      learnset_skill_count: 0, respond_variants: null, pivot_tools: null, learnset_tier: null,
      build_known: false, skill_ids: null,
      energy: {known: false, min: null, max: null, sum: null, zero_cost: null, over_cap: null, skills: []},
      energy_over_cap_known: false,
      evidence: {types: null, speed: null, pool: null},
      unknown_reason: `成员引用解析不出 species_id（key=${ref.key ?? 'null'}）：既不是 owned 实例、也没有 species_id`,
    };
  }
  const feature = index.featureFor(speciesId);
  const instance = ref.instance_id ? (index.instances.get(ref.instance_id) ?? null) : null;
  const skillIds = instance ? arr(instance.skills).filter(isNonEmptyString) : [];
  const buildKnown = skillIds.length > 0;
  const weakness = weaknessProfileOf(index, feature.types);

  // 能耗曲线：只从**这一只自己的具体 build** 算。任何一条技能查不到 energy ⇒ 整条曲线 unknown。
  const energies = skillIds.map((id) => index.skills.get(id)?.energy ?? null);
  const numbers = energies.filter((value) => typeof value === 'number');
  const overCapKnown = Number.isFinite(kernel.rulesetEnergyCap) && energies.length > 0;
  const energy = {
    known: buildKnown,
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
    sum: numbers.length ? numbers.reduce((a, b) => a + b, 0) : null,
    zero_cost: numbers.filter((value) => value === 0).length,
    over_cap: overCapKnown ? numbers.filter((value) => value > kernel.rulesetEnergyCap).length : null,
    skills: skillIds.map((id, i) => ({skill_id: id, energy: energies[i]})),
  };

  return {
    key: ref.key ?? `instance:${instance?.instance_id ?? speciesId}`,
    kind: ref.kind,
    namespace: ref.kind === 'owned' ? 'owned_instance' : 'catalog_species',
    instance_id: instance?.instance_id ?? null,
    species_id: speciesId,
    species_name: instance?.species_name ?? feature.species_name,
    types: feature.types ? [...feature.types] : null,
    types_source: feature.types_source,
    weakness,
    spe: feature.spe,
    spe_status: feature.spe_status,
    speed_tier: feature.speed_tier,
    speed_band: speedBandOf(feature.spe, feature.speed_tier),
    role: feature.role,
    favourite: instance?.favourite === true,
    locked: instance?.locked === true,
    validated: feature.validated === true,
    has_frozen_learnset: feature.has_frozen_learnset === true,
    learnset_skill_count: feature.learnset_skill_count ?? 0,
    respond_variants: feature.respond_variants ? [...feature.respond_variants] : null,
    pivot_tools: feature.pivot_tools ? [...feature.pivot_tools] : null,
    learnset_tier: feature.learnset_tier ?? null,
    build_known: buildKnown,
    skill_ids: buildKnown ? [...skillIds] : null,
    energy,
    evidence: feature.evidence ?? {types: null, speed: null, pool: null},
    unknown_reason: [
      !feature.types ? '属性未知（冻结 pets 层（基线 + 可玩层）/ pack tags / full-catalog 三处都没有）' : null,
      feature.types && !weakness.known ? `属性组合行没登记（${(feature.types ?? []).join('|')} 不在冻结相性表 120 行里）` : null,
      !feature.has_frozen_learnset ? '没有冻结学招表（四技能与合法性未校验）' : null,
      !buildKnown ? '没有具体 build（四个技能未知，能耗曲线与应对/换入手段不可算）' : null,
      feature.spe_status === 'knowledge_only' ? '速度只有 full-catalog 的种族值（knowledge_only，面板换算公式未知）' : null,
      feature.spe_status === 'unknown' ? '速度未知' : null,
    ].filter(Boolean),
  };
}

/** 弱点 / 抗性清单：**组合行优先**（多属性精灵按显式组合键查，不看 `types[0]`）。 */
function weaknessProfileOf(index, types) {
  const list = arr(types).filter(isNonEmptyString);
  if (list.length === 0) return {weak: [], resist: [], known: false, combo_key: null};
  const comboKey = list.join('|');
  const table = index.scaleByCombo.get(comboKey);
  if (!table) return {weak: [], resist: [], known: false, combo_key: comboKey};
  const weak = [];
  const resist = [];
  for (const attackType of index.attackTypes) {
    const scale = table.has(attackType) ? table.get(attackType) : 4;
    if (scale > 4) weak.push(attackType);
    else if (scale < 4) resist.push(attackType);
  }
  return {weak, resist, known: true, combo_key: comboKey};
}

/**
 * 速度档位：用**冻结速度轴**自己声明的 `speed_tier`（5 档，取自可玩层
 * `layer-playable-48/pets.json#role_annotations`）映射到 3 档层次。
 * 传字符串档位（有冻结声明）就按声明的档算；只拿得到数字时按同一份档位边界兜底。
 * 两者都拿不到 ⇒ null（不猜）。
 */
export const SPEED_TIER_THRESHOLDS = Object.freeze([
  Object.freeze({tier: '<=50', max: 50, band: 'slow'}),
  Object.freeze({tier: '51-70', max: 70, band: 'slow'}),
  Object.freeze({tier: '71-90', max: 90, band: 'mid'}),
  Object.freeze({tier: '91-110', max: 110, band: 'mid'}),
  Object.freeze({tier: '>=111', max: null, band: 'fast'}),
]);
export const SPEED_TIERS = Object.freeze(SPEED_TIER_THRESHOLDS.map((row) => row.tier));
const SPEED_BAND_BY_TIER = new Map(SPEED_TIER_THRESHOLDS.map((row) => [row.tier, row.band]));

export function speedBandOf(spe, speedTier = null) {
  if (typeof speedTier === 'string' && SPEED_BAND_BY_TIER.has(speedTier)) return SPEED_BAND_BY_TIER.get(speedTier);
  if (typeof spe !== 'number') return null;
  if (spe <= 50) return 'slow';
  if (spe <= 90) return 'mid';
  return 'fast';
}

// ─────────────────────────────────────────────────────────────────────────
// 成对结构特征
// ─────────────────────────────────────────────────────────────────────────

/**
 * 六个维度里每一项的**可算性**：只要输入缺一环就 `available:false` + 点名缺什么。
 *
 * 注意速度这一项：算得出「快/中/慢层次」，但**关键速度线**（对手速度阈之上的先手关系）
 * 需要真实面板值 —— 冻结数据里 `panel_stats` 一律 null、养成效果 `effect=UNKNOWN`，
 * 所以 `key_speed_lines` 永远是 `available:false`。这是诚实的算不出来，不是 bug。
 */
function featureAvailability(kernel, profiles) {
  const index = kernel.index;
  const known = profiles.filter((p) => p.weakness.known);
  const noCombo = profiles.filter((p) => !p.weakness.known);
  const noSpeed = profiles.filter((p) => typeof p.spe !== 'number');
  const noBuild = profiles.filter((p) => !p.build_known);
  const noPool = profiles.filter((p) => !Array.isArray(p.respond_variants) || !Array.isArray(p.pivot_tools));
  const overCapKnown = Number.isFinite(kernel.rulesetEnergyCap);
  const noEnergyCap = !overCapKnown;

  const row = (available, reason, extra = {}) => ({available, unknown_reason: available ? null : reason, ...extra});

  // 键与 FEATURE_IDS 一一对应：打分器只认这六个键的 available，读的人一眼能对上。
  // 「关键速度线」不是第七个打分维度，而是速度这一维**内部**再分一层（层次算得出、先手关系算不出）。
  return {
    type_coverage: row(known.length > 0 && noCombo.length === 0,
      noCombo.length === 0
        ? (known.length === 0 ? '队伍里一个成员的属性都没拿到：属性相性无从算起' : null)
        : `成员 ${noCombo.map((p) => p.key).join(' / ')} 的属性组合行没登记在冻结相性表（${index.scaleByCombo.size} 行）里`,
      {members_known: known.length, members_unknown: noCombo.length}),
    weakness_exposure: row(known.length > 0 && noCombo.length === 0,
      noCombo.length === 0
        ? (known.length === 0 ? '队伍里一个成员的属性都没拿到：弱点清单与覆盖同源，一起 fail closed' : null)
        : `成员 ${noCombo.map((p) => p.key).join(' / ')} 的属性组合行没登记 ⇒ 弱点清单不完整，这一维不参与打分`,
      {members_known: known.length, members_unknown: noCombo.length}),
    speed_layers: row(noSpeed.length === 0,
      noSpeed.length === 0 ? null
        : `成员 ${noSpeed.map((p) => p.key).join(' / ')} 没有速度值（既不在冻结速度轴 `
          + `${index.roster?.size ?? 0} 只［基线 12 + 可玩层 530］里、full-catalog 也没有 stats.spe）`,
      {members_with_speed: profiles.length - noSpeed.length, members_without_speed: noSpeed.length,
        key_speed_lines: row(false,
          '关键速度线要真实面板值（等级/性格/资质/特长/血脉换算后）才能判先手关系；'
          + '冻结数据里 542 个实例的 `panel_stats` 一律 null、养成效果 `effect=UNKNOWN`（见 owned-pets.json 的 growth_attribute_policy），'
          + '**现在算不出来**；这里只给速度档位层次（`speed_layers`），不给先手结论',
          {required: 'panel_stats（等级换算后的面板值）', panel_stats_present: false})}),
    respond_coverage: row(noPool.length === 0,
      noPool.length === 0 ? null
        : `成员 ${noPool.map((p) => p.key).join(' / ')} 没有冻结学招池（应对词条只能从学招池或具体 build 数）`,
      {members_with_pool: profiles.length - noPool.length, members_without_pool: noPool.length}),
    energy_curve: row(noBuild.length === 0 && !noEnergyCap,
      noBuild.length > 0
        ? `成员 ${noBuild.map((p) => p.key).join(' / ')} 没有具体 build（四个技能未知 ⇒ 能耗曲线不可算）`
        : (noEnergyCap
          ? '规则配置的能耗上限没注入（`ctx.ruleset_energy_cap`）：超限技能数不可算，'
            + '所以能耗这一项 fail closed 而不是只算 0 费出口'
          : null),
      {members_with_build: profiles.length - noBuild.length, members_without_build: noBuild.length,
        ruleset_energy_cap: overCapKnown ? kernel.rulesetEnergyCap : null}),
    pivot_sustain: row(noPool.length === 0,
      noPool.length === 0 ? null
        : `成员 ${noPool.map((p) => p.key).join(' / ')} 没有冻结学招池（换入/离场手段数不出来）`,
      {members_with_pool: profiles.length - noPool.length, members_without_pool: noPool.length}),
  };
}

/**
 * 一支队伍能否进入成对计算：`{ok, profiles, problems, availability}`。
 * 空队伍**不算**成对特征（fail closed，不是「全 0 的队」）。
 */
function teamSide(kernel, team, label) {
  const members = arr(team?.members);
  const problems = [];
  if (!isPlainObject(team)) {
    problems.push(auditProblem('INVALID_TEAM', label, `队伍不是普通对象（${typeof team}）`));
    return {ok: false, profiles: [], problems, availability: null};
  }
  if (members.length === 0) {
    problems.push(auditProblem('EMPTY_TEAM', label,
      '队伍成员为 0：空队伍没有成对结构特征可算（不返回全 0 的特征包）'));
    return {ok: false, profiles: [], problems, availability: null};
  }
  const profiles = [];
  const seen = new Set();
  for (const member of members) {
    const ref = memberRefOf(member);
    if (ref === null) {
      problems.push(auditProblem('INVALID_MEMBER', `${label}.members`,
        `成员形状不认识（${typeof member}）：给 RC-301/302 的登记键（instance:own-0001）或 {key|instance_id|species_id}`));
      continue;
    }
    const profile = profileFromIndex(kernel, ref);
    if (profile.species_id === null) {
      problems.push(auditProblem('UNRESOLVED_MEMBER', `${label}.members[${ref.key ?? 'null'}]`, profile.unknown_reason));
      continue;
    }
    const dedupeKey = ref.kind === 'owned' ? (profile.instance_id ?? profile.species_id) : profile.species_id;
    if (seen.has(dedupeKey)) {
      problems.push(auditProblem('DUPLICATE_MEMBER', `${label}.members[${dedupeKey}]`,
        '同一只被登记了两次：同一只上两次不构成第二层覆盖，按重复拒绝而不是算两遍'));
      continue;
    }
    seen.add(dedupeKey);
    profiles.push(profile);
  }
  if (profiles.length === 0) {
    problems.push(auditProblem('NO_RESOLVED_MEMBERS', label,
      '一个成员都没解析出来：没有可算的结构基线（不返回全 0）'));
    return {ok: false, profiles: [], problems, availability: null};
  }
  return {ok: true, profiles, problems, availability: featureAvailability(kernel, profiles)};
}

/**
 * 成对结构特征。
 *
 * 每一维都**双侧各算一次**，方向固定为「A 相对 B」，所以 `pairwiseFeatures(a, b)` 与
 * `pairwiseFeatures(b, a)` 的 `advantage` 互为镜像（判据里有对称性检查）。
 *
 * @param {object} teamA `{team_id, members: [...]}`
 * @param {object} teamB 同上
 * @param {object} ctx   `{index|inputs, ruleset_energy_cap}`
 */
export function pairwiseFeatures(teamA, teamB, ctx = {}) {
  const resolved = resolveRankerContext(ctx);
  if (!resolved.ok) {
    return {
      schema: 'roco-team-pairwise-features/v1',
      available: false,
      unknown_reason: resolved.reason,
      team_a: teamA?.team_id ?? null,
      team_b: teamB?.team_id ?? null,
      features: null,
      evidence: [evidence('injected:ctx', 'ctx', 'index', null, resolved.reason)],
      unverified: ['未核实：成对特征 —— 索引没注入，一项都算不出来'],
    };
  }
  const kernel = kernelOf(resolved);
  const index = kernel.index;
  const a = teamSide(kernel, teamA, 'teamA');
  const b = teamSide(kernel, teamB, 'teamB');
  const problems = [...a.problems, ...b.problems];
  const teamAId = teamA?.team_id ?? null;
  const teamBId = teamB?.team_id ?? null;

  if (!a.ok || !b.ok) {
    return {
      schema: 'roco-team-pairwise-features/v1',
      available: false,
      unknown_reason: problems.map(formatRankerProblem).join('；') || '至少一侧的队伍没有可算的结构基线',
      team_a: teamAId,
      team_b: teamBId,
      features: null,
      availability: {teamA: a.availability, teamB: b.availability},
      evidence: [
        evidence('injected:teams', `${teamAId ?? 'teamA'}.members`, 'resolved_members', a.profiles.length,
          'A 侧解析出来、能参与结构计算的成员数（解析不出的会被点名，不是丢弃）'),
        evidence('injected:teams', `${teamBId ?? 'teamB'}.members`, 'resolved_members', b.profiles.length,
          'B 侧解析出来、能参与结构计算的成员数'),
      ],
      problems,
      unverified: ['未核实：成对特征 —— 至少一侧解析不出可算的结构基线，所以一项都不给'],
    };
  }

  const featuresA = teamFeatures(index, a.profiles, {ruleset_energy_cap: resolved.ruleset_energy_cap});
  const featuresB = teamFeatures(index, b.profiles, {ruleset_energy_cap: resolved.ruleset_energy_cap});
  const availability = {teamA: a.availability, teamB: b.availability};

  // 每维一次：双侧各一个值 + 方向化的「谁占优」计数（都是可复算的计数/占比，不是预测）。
  const axisRows = {};
  for (const id of FEATURE_IDS) {
    const sourceKey = FEATURE_SOURCE_KEYS[id];
    // 可算性是**唯一**判据：`availability.X.available` 为 false 时值一律 null。
    // 不直接看聚合值是否为有限数 —— 那样「成员速度未知」会被 RC-303 聚合成一个数
    // （它按能拿到的成员算），可算性说不可算、值却给出一个数，读的人会被误导。
    const okSide = (availability, key) => availability?.[key]?.available === true;
    const values = {
      teamA: okSide(availability.teamA, id) && Number.isFinite(featuresA?.[sourceKey]) ? round(featuresA[sourceKey]) : null,
      teamB: okSide(availability.teamB, id) && Number.isFinite(featuresB?.[sourceKey]) ? round(featuresB[sourceKey]) : null,
    };
    const has = values.teamA !== null && values.teamB !== null;
    axisRows[id] = {
      id,
      definition: FEATURE_DEFINITIONS[id].label,
      from: FEATURE_DEFINITIONS[id].from,
      values,
      advantage: has ? round(Math.abs(values.teamA - values.teamB)) : null,
      leads: has ? (values.teamA === values.teamB ? null : (values.teamA > values.teamB ? 'teamA' : 'teamB')) : null,
      higher_is_better: true,
      available: has,
      unknown_reason: has ? null : `${id} 至少一侧的值不可算（见 availability）`,
      unit: RANKER_UNITS.relative,
      evidence: [evidence(FEATURE_DEFINITIONS[id].source_ref, `teamFeatures().${sourceKey}`, id,
        values, `来自 RC-303 的队伍特征聚合（本模块不重算这一项）`)],
    };
  }

  // 属性侧的可复算明细（弱点暴露面 + 谁接得住对面接不住的东西）。
  const resistA = uniqueSorted(a.profiles.flatMap((p) => p.weakness.known ? p.weakness.resist : []));
  const resistB = uniqueSorted(b.profiles.flatMap((p) => p.weakness.known ? p.weakness.resist : []));
  const weakA = uniqueSorted(a.profiles.flatMap((p) => p.weakness.known ? p.weakness.weak : []));
  const weakB = uniqueSorted(b.profiles.flatMap((p) => p.weakness.known ? p.weakness.weak : []));
  const resistOnlyA = resistA.filter((type) => !resistB.includes(type));
  const resistOnlyB = resistB.filter((type) => !resistA.includes(type));
  // 共享弱点：两队都有人怕的系别（对称量，方向无关）。
  const sharedWeaknesses = weakA.filter((type) => weakB.includes(type));

  // 速度层次侧：档位分布 + 谁多占一个档位（档位来自冻结速度轴 542 只的 speed_tier，不是面板值）。
  const bandsA = uniqueSorted(a.profiles.map((p) => p.speed_band).filter(Boolean));
  const bandsB = uniqueSorted(b.profiles.map((p) => p.speed_band).filter(Boolean));
  const bandsOnlyA = bandsA.filter((band) => !bandsB.includes(band));
  const bandsOnlyB = bandsB.filter((band) => !bandsA.includes(band));
  // 速度档位覆盖（用 5 档声明本身，逐条可复算；不是先手结论）。
  const tierOrderA = uniqueSorted(a.profiles.map((p) => p.speed_tier).filter(isNonEmptyString));
  const tierOrderB = uniqueSorted(b.profiles.map((p) => p.speed_tier).filter(isNonEmptyString));

  // 能耗侧：0 费出口与超限技能（超限要规则配置的上限，拿不到就是 null）。
  const energyRow = (side, features) => ({
    zero_cost_moves: features?.counts?.zero_cost_moves ?? null,
    moves_over_ruleset_cap: features?.counts?.moves_over_ruleset_cap ?? null,
    cap: resolved.ruleset_energy_cap,
    members_with_build: features?.counts?.members_with_build ?? null,
    members_without_build: features?.counts?.members_without_build ?? null,
  });
  const energyA = energyRow('teamA', featuresA);
  const energyB = energyRow('teamB', featuresB);

  // 换人/续航侧：有换入/离场手段的成员占比（分子分母都是计数，可逐条复算）。
  const pivotRow = (features, profiles) => ({
    holders: features?.counts?.pivot_holders ?? null,
    members: profiles.length,
    ratio: profiles.length ? round((features?.counts?.pivot_holders ?? 0) / profiles.length) : null,
  });
  const pivotA = pivotRow(featuresA, a.profiles);
  const pivotB = pivotRow(featuresB, b.profiles);

  const unverified = [
    '未核实：面板值与养成效果 —— 冻结数据里 542 个实例的 `panel_stats` 一律 null，'
      + 'nature / talent / specialty / bloodline 的 `effect` 都是 UNKNOWN，所以「关键速度线」与任何依赖面板值的结论都算不出来',
    '未核实：这些特征与实战结果的关联 —— 权重是工程假设（ENGINE_HYPOTHESIS），没有任何对局数据证明它们与胜负相关',
    '未核实：速度档位的实战含义 —— 档位只来自冻结速度轴 542 只的 `speed_tier` 与种族值'
      + '（基线 pets.json 12 + 抓包可玩层 layer-playable-48/pets.json 530；图鉴里另外 80 只按需推算档没有冻结速度值），'
      + '不是等级换算后的面板速度',
    ...(resolved.ruleset_energy_cap === null
      ? ['未核实：超限技能数 —— 没有注入规则配置的能耗上限，所以这一项是 null（不是 0）'] : []),
  ];
  if (sharedWeaknesses.length > 0) {
    unverified.push(`未核实：共享弱点的实际影响 —— 两队都有人怕 ${sharedWeaknesses.join(' / ')}，`
      + '这是集合求交的计数结果，不代表对局里真的会被抓');
  }

  return {
    schema: 'roco-team-pairwise-features/v1',
    available: true,
    unknown_reason: null,
    team_a: teamAId,
    team_b: teamBId,
    size: {teamA: a.profiles.length, teamB: b.profiles.length},
    availability,
    features: {
      // 六个打分维度：值直接来自 RC-303 的聚合，不在这里重算。
      type_coverage: {
        ...axisRows.type_coverage,
        detail: {resisted_attack_types: {teamA: resistA.length, teamB: resistB.length},
          attack_types_total: index.attackTypes.length,
          resist_only: {teamA: resistOnlyA, teamB: resistOnlyB}},
      },
      weakness_exposure: {
        ...axisRows.weakness_exposure,
        detail: {
          unanswered_weaknesses: {teamA: featuresA.counts.unanswered_weaknesses, teamB: featuresB.counts.unanswered_weaknesses},
          weakness_total: {teamA: featuresA.counts.weakness_total, teamB: featuresB.counts.weakness_total},
          shared_weakness_types: sharedWeaknesses,
          weak_multiset: {teamA: weakA, teamB: weakB},
        },
      },
      speed_layers: {
        ...axisRows.speed_layers,
        detail: {
          bands: {teamA: bandsA, teamB: bandsB},
          bands_only: {teamA: bandsOnlyA, teamB: bandsOnlyB},
          speed_tiers: {teamA: tierOrderA, teamB: tierOrderB},
          speed_tier_order: [...SPEED_TIERS],
          members_without_speed: {
            teamA: availability.teamA.speed_layers.members_without_speed,
            teamB: availability.teamB.speed_layers.members_without_speed,
          },
          // 关键速度线：需要面板值，现在算不出来。这里是显式的 unknown，不是 0。
          key_speed_lines: {
            available: false,
            unknown_reason: availability.teamA.speed_layers.key_speed_lines.unknown_reason,
            values: {teamA: null, teamB: null},
          },
        },
      },
      respond_coverage: {
        ...axisRows.respond_coverage,
        detail: {
          variants_by_side: {
            teamA: uniqueSorted(a.profiles.flatMap((p) => p.respond_variants ?? [])),
            teamB: uniqueSorted(b.profiles.flatMap((p) => p.respond_variants ?? [])),
          },
          declared_variants: [...RESPOND_VARIANTS],
        },
      },
      energy_curve: {...axisRows.energy_curve, detail: {teamA: energyA, teamB: energyB}},
      pivot_sustain: {...axisRows.pivot_sustain, detail: {teamA: pivotA, teamB: pivotB}},
    },
    evidence: [
      evidence('injected:teams', `${teamAId ?? 'teamA'}.members`, 'resolved_members', a.profiles.length,
        'A 侧参与结构计算的成员数（重复/解析不出的已点名，见 problems）'),
      evidence('injected:teams', `${teamBId ?? 'teamB'}.members`, 'resolved_members', b.profiles.length,
        'B 侧参与结构计算的成员数'),
      evidence(FROZEN_PATHS.types, 'types[组合键].weak / .resist', 'combos_registered', index.scaleByCombo.size,
        '属性相性**组合行优先**：多属性精灵按显式组合键查表（没有该键就整体 unknown，不回退到 types[0]）'),
      evidence(FROZEN_SPEED_SOURCES.ref,
        'pets[].stats.spe（基线 12）+ pets[].stats.spe 与 role_annotations[].speed_tier（可玩层 530）', 'speed_bands',
        {teamA: bandsA, teamB: bandsB},
        `速度层次只从冻结速度轴 ${FROZEN_SPEED_SOURCES.species} 只取（本次注入索引里 `
          + `${index.roster?.size ?? 0} 只有值）；档位是 5 档声明值，轴外 ${FROZEN_SPEED_SOURCES.species_outside} 只按需推算档没有冻结速度值`),
      evidence(FROZEN_PATHS.skills, 'skills[].energy', 'ruleset_energy_cap', resolved.ruleset_energy_cap,
        '超限技能数要用注入的规则配置上限；没注入就是 null（不是 0）'),
    ],
    problems,
    unverified,
    criteria: '成对特征的每一维都双侧各算一次、方向固定为 A 相对 B；算不出的维度 available:false 且带原因，不补 0',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 打分：权重显式、形状可审计、不可得就 fail closed
// ─────────────────────────────────────────────────────────────────────────

/** 抽取一条权重的合法性问题（判据的必红方向就靠它）。 */
function weightProblems(weights) {
  const problems = [];
  if (!isPlainObject(weights)) {
    problems.push(auditProblem('WEIGHTS_NOT_OBJECT', 'weights',
      `权重表不是普通对象（${typeof weights}）：没有权重就没有分数，不内置默认值`));
    return problems;
  }
  const ids = Object.keys(weights);
  if (ids.length === 0) {
    problems.push(auditProblem('WEIGHTS_EMPTY', 'weights', '权重表是空的：没有任何一条权重可用'));
    return problems;
  }
  let sum = 0;
  for (const id of ids.sort(byLex)) {
    const entry = weights[id];
    if (!isPlainObject(entry)) {
      problems.push(auditProblem('WEIGHT_NOT_OBJECT', `weights.${id}`, `权重项不是普通对象（${typeof entry}）`));
      continue;
    }
    if (!Number.isFinite(entry.weight)) {
      problems.push(auditProblem('WEIGHT_NOT_NUMBER', `weights.${id}.weight`, `权重不是有限数（${stableJson(entry.weight)}）`));
    } else if (entry.weight < 0 || entry.weight > 1) {
      problems.push(auditProblem('WEIGHT_OUT_OF_RANGE', `weights.${id}.weight`,
        `权重 ${entry.weight} 不在 [0, 1] 里：打分是 0～1 序数标度上的加权平均，越界就没有口径`));
    } else {
      sum += entry.weight;
    }
    if (!WEIGHT_PROVENANCE_LEVELS.includes(entry.provenance)) {
      problems.push(auditProblem('WEIGHT_PROVENANCE_MISSING', `weights.${id}.provenance`,
        `provenance = ${stableJson(entry.provenance ?? null)}，不在允许集合 ${WEIGHT_PROVENANCE_LEVELS.join(' / ')} 里：`
        + '每条权重都必须自报来源等级，没有来源的权重就是魔数'));
    }
    if (!isNonEmptyString(entry.reason)) {
      problems.push(auditProblem('WEIGHT_REASON_MISSING', `weights.${id}.reason`,
        '权重没有写理由：没有理由的数值就是藏在函数体里的魔数'));
    }
    if (!isNonEmptyString(entry.feature)) {
      problems.push(auditProblem('WEIGHT_FEATURE_MISSING', `weights.${id}.feature`, '权重没有点名它乘的是哪个特征'));
    }
    if (!FEATURE_IDS.includes(entry.feature)) {
      problems.push(auditProblem('WEIGHT_FEATURE_UNKNOWN', `weights.${id}.feature`,
        `特征 ${stableJson(entry.feature ?? null)} 不在 FEATURE_IDS 里（${FEATURE_IDS.join(' / ')}）`));
    }
  }
  if (sum <= 0) {
    problems.push(auditProblem('WEIGHTS_SUM_ZERO', 'weights', '所有可用权重加起来是 0：加权平均的分母为 0，分数无定义'));
  }
  return problems;
}

/**
 * 权重表审计：把「每条权重都要有理由与 `ENGINE_HYPOTHESIS` 标记」变成机器判据。
 *
 * 这是**审计器**（喂坏权重必须判红），不是打分器：`pairwiseScore` 自己也会独立校验，
 * 两者都不许放行无来源的权重。
 */
export function auditWeightTable(weights = WEIGHTS) {
  const problems = weightProblems(weights);
  const usable = Object.keys(isPlainObject(weights) ? weights : {}).sort(byLex);
  return {
    ok: problems.length === 0,
    schema: 'roco-team-ranker-weights-audit/v1',
    provenance_levels: [...WEIGHT_PROVENANCE_LEVELS],
    weight_count: usable.length,
    problems,
    criteria: '每条权重必须是 `{id, weight ∈ [0,1], feature ∈ FEATURE_IDS, provenance ∈ WEIGHT_PROVENANCE_LEVELS, reason}`；'
      + '缺 provenance 或 reason 即判红（`WEIGHT_PROVENANCE_MISSING` / `WEIGHT_REASON_MISSING`）',
    status: RANKER_STATUS,
  };
}

/**
 * 打分：`score = Σ(weight_i × feature_i) / Σ(weight_i)`，只对**六个维度全部可算**的特征包打分。
 *
 * 为什么不做「缺哪维就用剩下几维重归一」：那会静默改变量纲，读的人没法把两次分数放在一起比。
 * 六个维度是一个整体契约（见 `REQUIRED_FEATURE_IDS`）——缺一个就 `available:false`，
 * 排序时进 `unranked[]`，不参与排序。
 */
export function pairwiseScore(features, weights = WEIGHTS) {
  const problems = weightProblems(weights);
  if (problems.length > 0) {
    return {
      schema: 'roco-team-pairwise-score/v1',
      available: false,
      score: null,
      unknown_reason: `权重表不可用：${problems.map(formatRankerProblem).join('；')}`,
      weight_problems: problems,
      parts: null,
      weights_used: null,
      unit: RANKER_UNITS.relative,
      status: RANKER_STATUS,
      unverified: ['未核实：分数 —— 权重表自己就不合法，所以不给分数（也不是 0）'],
    };
  }
  if (!isPlainObject(features)) {
    return {
      schema: 'roco-team-pairwise-score/v1',
      available: false,
      score: null,
      unknown_reason: `特征包不是普通对象（${typeof features}）`,
      weight_problems: [],
      parts: null,
      weights_used: null,
      unit: RANKER_UNITS.relative,
      status: RANKER_STATUS,
      unverified: ['未核实：分数 —— 没有特征包就没有分数'],
    };
  }
  if (features.available !== true) {
    return {
      schema: 'roco-team-pairwise-score/v1',
      available: false,
      score: null,
      unknown_reason: isNonEmptyString(features.unknown_reason)
        ? `特征包自报不可算：${features.unknown_reason}`
        : '特征包自报 available 不为 true，且没有给出 unknown_reason（拒绝打分，不补 0）',
      weight_problems: [],
      parts: null,
      weights_used: null,
      unit: RANKER_UNITS.relative,
      status: RANKER_STATUS,
      unverified: ['未核实：分数 —— 特征包不可算'],
    };
  }

  const ids = FEATURE_IDS;
  const missing = [];
  const parts = {};
  let numerator = 0;
  let denominator = 0;
  for (const id of ids) {
    const row = features?.features?.[id] ?? null;
    const entry = weights[id];
    if (!isPlainObject(row)) { missing.push(`${id}（特征包缺这一维）`); continue; }
    if (row.available !== true) { missing.push(`${id}（${row.unknown_reason ?? 'available 不为 true'}）`); continue; }
    // 分数的输入是**成对的方向差**：`advantage` 是 |A − B|，`leads` 说谁占优。
    // 只取 advantage 会让 (A 0.4, B 0.4) 与 (A 0.9, B 0.9) 同分；所以打分的取值是
    // 双侧值里**更占优**的那一侧（等价于 max），它守恒「A 与 B 互换后分数不变」。
    const values = row.values ?? {};
    const a = Number.isFinite(values.teamA) ? values.teamA : null;
    const b = Number.isFinite(values.teamB) ? values.teamB : null;
    if (a === null || b === null) { missing.push(`${id}（至少一侧的值不是有限数）`); continue; }
    const raw = Math.max(0, Math.min(1, Math.max(a, b)));
    const weight = entry.weight;
    const contribution = round(weight * raw);
    parts[id] = {
      raw: round(raw), weight, contribution,
      from: entry.from ?? entry.feature ?? id,
      provenance: entry.provenance,
      reason: entry.reason,
      values: {teamA: round(a), teamB: round(b)},
      leads: row.leads ?? null,
    };
    numerator += weight * raw;
    denominator += weight;
  }
  if (missing.length > 0 || denominator <= 0) {
    return {
      schema: 'roco-team-pairwise-score/v1',
      available: false,
      score: null,
      unknown_reason: `六个维度必须全部可算才算分，现在缺：${missing.join('；') || '可用权重和为 0'}`,
      weight_problems: [],
      parts,
      weights_used: null,
      unit: RANKER_UNITS.relative,
      status: RANKER_STATUS,
      unverified: ['未核实：分数 —— 至少一维不可算，所以不给分数（不用剩余维度重归一，也不返回 0）'],
    };
  }
  const score = round(numerator / denominator);
  return {
    schema: 'roco-team-pairwise-score/v1',
    available: true,
    score,
    unknown_reason: null,
    weight_problems: [],
    parts,
    weights_used: ids,
    weight_sum: round(denominator),
    unit: RANKER_UNITS.relative,
    status: RANKER_STATUS,
    score_range: {min: 0, max: 1},
    evidence: [
      evidence('src/coach/team-ranker.mjs', 'WEIGHTS', 'weights', Object.fromEntries(
        ids.map((id) => [id, weights[id].weight])), '权重表逐条带 provenance=ENGINE_HYPOTHESIS 与理由'),
      evidence('injected:pairwise_features', 'features[].values', 'score_inputs', Object.fromEntries(
        ids.map((id) => [id, parts[id].raw])), '每一维的取值都来自 RC-303 的队伍特征（可逐条复算）'),
    ],
    unverified: [
      '未核实：分数的实战含义 —— 0～1 是**序数**标度，只在同一份注入特征内比大小，不是任何比例、不是强度分，也不预测胜负',
      '未核实：权重数值本身 —— 六条权重全是 ENGINE_HYPOTHESIS（没有对局数据支持），换一组权重排序会变',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 确定性排序
// ─────────────────────────────────────────────────────────────────────────

const tieBreakKey = (team, tieBreak, index) => {
  if (tieBreak === 'input_order') return String(index).padStart(8, '0');
  return String(team?.team_id ?? '');
};

/**
 * 确定性排序。
 *
 * 口径：
 *   · 只有 `available:true` 且六个维度全部可算的队伍进入 `ranked[]`；
 *   · 分数**不可算**的队伍进 `unranked[]`（带原因），**不参与排序**——
 *     不用 0 混进排序，也不给它们假名次；
 *   · 同分按 `TIE_BREAKS` 里声明的一条稳定 tie-break 决定（默认 `team_id_lexicographic`），
 *     再同则按输入下标兜底（保证**全序**，两次运行逐位相同）。
 *
 * @param {Array}  teams `[{team_id, members: [...]}]`
 * @param {object} ctx   `{index|inputs, ruleset_energy_cap}`
 * @param {object} [opts] `{weights, tie_break, opponent}`
 */
export function rankTeams(teams, ctx = {}, opts = {}) {
  const weights = opts.weights ?? WEIGHTS;
  const tieBreak = TIE_BREAKS.includes(opts.tie_break) ? opts.tie_break : 'team_id_lexicographic';
  const rows = arr(teams);
  const weightProblemsNow = weightProblems(weights);
  const resolved = resolveRankerContext(ctx);
  const kernel = resolved.ok ? kernelOf(resolved) : null;
  const rowsOut = [];
  const problems = [];
  if (!resolved.ok) {
    problems.push(auditProblem('NO_INDEX', 'ctx', resolved.reason));
  }

  // 单队口径：`rankTeams` 排的是「每支队伍自己的结构特征」。
  // 成对口径（A 相对 B）走 `pairwiseFeatures()`：那里有明确的对手，这里没有。
  for (let i = 0; i < rows.length; i += 1) {
    const team = rows[i];
    const teamId = isNonEmptyString(team?.team_id) ? team.team_id : null;
    if (teamId === null) {
      problems.push(auditProblem('TEAM_ID_MISSING', `teams[${i}].team_id`,
        '队伍没有 team_id：tie-break 与结果对账都靠它，没有就不排（fail closed）'));
      rowsOut.push({team_id: null, input_index: i, available: false, score: null,
        unknown_reason: '队伍没有 team_id（tie-break 与对账都要它）', sort_key: null});
      continue;
    }
    const side = kernel === null
      ? {ok: false, profiles: [], problems: [auditProblem('NO_INDEX', `teams[${i}]`, resolved.reason)], availability: null}
      : teamSide(kernel, team, teamId);
    const selfFeatures = side.ok
      ? teamFeatures(kernel.index, side.profiles, {ruleset_energy_cap: kernel.rulesetEnergyCap})
      : null;
    const bundle = selfBundle(selfFeatures, side.availability, team);
    const scored = pairwiseScore(bundle, weights);
    if (side.ok && side.problems.length > 0) problems.push(...side.problems);
    rowsOut.push({
      team_id: teamId,
      input_index: i,
      available: scored.available,
      score: scored.score,
      unknown_reason: scored.unknown_reason,
      parts: scored.parts,
      unit: RANKER_UNITS.relative,
      member_count: arr(team?.members).length,
      resolved_member_count: side.profiles.length,
      availability: side.availability,
      unavailable_dimensions: bundle.unavailable_dimensions,
      evidence: [
        evidence('injected:teams', `teams[${i}]`, 'team_id', teamId, '被排序的队伍'),
        ...arr(scored.evidence),
        ...arr(side.problems).map((p) => evidence('injected:teams', `teams[${i}].members`, 'problem',
          p.code, formatRankerProblem(p))),
      ],
      unverified: [
        ...arr(scored.unverified),
        '未核实：名次 —— 名次只在**本次注入的队伍集合**内有意义；换一批队伍进来，名次会变',
      ],
      sort_key: {score: scored.score, tie: tieBreakKey(team, tieBreak, i)},
    });
  }

  const ranked = rowsOut.filter((row) => row.available === true);
  const unranked = rowsOut.filter((row) => row.available !== true);
  ranked.sort((x, y) => (y.sort_key.score - x.sort_key.score)
    || byLex(x.sort_key.tie, y.sort_key.tie)
    || (x.input_index - y.input_index));
  unranked.sort((x, y) => byLex(String(x.team_id ?? ''), String(y.team_id ?? '')) || (x.input_index - y.input_index));

  const withRank = ranked.map((row, i) => ({
    ...row,
    rank: i + 1,
    // 同分是**真的同分**（不是「差不多」）：标出来，读的人知道 tie-break 参与了决定。
    tied_with_previous: i > 0 && ranked[i - 1].score === row.score,
  }));

  return {
    schema: 'roco-team-ranker-ranking/v1',
    available: withRank.length > 0,
    unknown_reason: withRank.length > 0 ? null
      : (weightProblemsNow.length > 0
        ? `权重表不可用：${weightProblemsNow.map(formatRankerProblem).join('；')}`
        : '注入的队伍里没有一支六个维度全部可算：全部进 unranked（不是全 0 分排序）'),
    ranker_id: RANKER_ID,
    ranker_version: RANKER_VERSION,
    tie_break: tieBreak,
    tie_break_order: [...TIE_BREAKS],
    weight_problems: weightProblemsNow,
    weights: Object.fromEntries(FEATURE_IDS.map((id) => [id, weights?.[id]?.weight ?? null])),
    team_count: rows.length,
    ranked_count: withRank.length,
    unranked_count: unranked.length,
    ranked: withRank,
    unranked,
    unit: RANKER_UNITS.relative,
    score_range: {min: 0, max: 1},
    no_win_rate: true,
    status: RANKER_STATUS,
    problems,
    evidence: [
      evidence('src/coach/team-ranker.mjs', 'rankTeams(teams, ctx, opts)', 'tie_break', tieBreak,
        '同分的稳定 tie-break：默认按 team_id 字典序，再同则按输入下标（全序 ⇒ 逐位可复跑）'),
      evidence('src/coach/team-ranker.mjs', 'WEIGHTS', 'weight_sum', round(FEATURE_IDS
        .reduce((sum, id) => sum + (Number.isFinite(weights?.[id]?.weight) ? weights[id].weight : 0), 0)),
        '加权平均的分母；六条权重全部 ENGINE_HYPOTHESIS'),
    ],
    unverified: [
      '未核实：排序的预测能力 —— 这是一个**结构启发式**排序器，没有任何对局数据支持「排前面的更可能赢」',
      ...(withRank.length === 0 ? [] : ['未核实：跨运行可比性 —— 分数只在同一份注入数据与同一份权重下可比']),
    ],
    criteria: '同名次必须由稳定 tie-break 决定；任何一维不可算的队伍进 unranked 且带原因，不用 0 混进排序',
  };
}

/** 把单侧队伍特征包成 `pairwiseScore` 认得的成对形状（自己 VS 空对手）。 */
function selfBundle(features, availability, team) {
  const dashes = availability === null;
  const unavailable = [];
  const emptyRow = (available, unknownReason) => ({
    id: null, values: {teamA: null, teamB: null}, available, unknown_reason: unknownReason, leads: null,
  });
  const out = {};
  for (const id of FEATURE_IDS) {
    const source = FEATURE_SOURCE_KEYS[id];
    const available = !dashes && availability[id]?.available === true;
    const value = available && Number.isFinite(features?.[source]) ? round(features[source]) : null;
    // 单队口径下「对手」是不存在的：所以两侧都给同一个值（A 与 B 都是这一队），
    // 打分取 max 后等于这一队自己的值。这样排序器与成对打分器共用同一套口径。
    // 可算性只看 `availability[id].available`：聚合值可能是「按能拿到的成员算出来的数」，
    // 而可算性说不可算时那个数不能拿来打分（否则未知会被静默当成一个值）。
    const ok = available && value !== null;
    if (!ok) unavailable.push(id);
    out[id] = {
      ...emptyRow(ok, ok ? null
        : (dashes ? '队伍没有可算的结构基线' : (availability[id]?.unknown_reason ?? `${id} 的值不可算`))),
      values: {teamA: value, teamB: value},
      leads: null,
    };
  }
  return {
    schema: 'roco-team-pairwise-features/v1',
    available: unavailable.length === 0,
    unknown_reason: unavailable.length === 0 ? null
      : `单队口径下有维度不可算：${unavailable.join(' / ')}`,
    team_a: team?.team_id ?? null,
    team_b: team?.team_id ?? null,
    features: out,
    availability,
    unavailable_dimensions: unavailable,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Partial-team Completion Value：补满六只还能补到什么（结构价值，不是预测）
// ─────────────────────────────────────────────────────────────────────────

const TARGET_TEAM_SIZE = 6;

/**
 * 已选 k 只时，「补满六只还能补到什么」的**结构**价值。
 *
 * 口径（每一项都是可复算的计数或占比，**没有一项是概率**）：
 *   · `coverage_resistable_types` —— 现在能抗住多少个攻击系别（冻结相性表，组合行优先）；
 *   · `speed_bands_covered`      —— 现在占了几个速度档位（3 档，来自冻结速度轴 542 只的 speed_tier）；
 *   · `respond_variants_covered` —— 现在覆盖了几类应对词条（3 类，来自冻结技能描述）；
 *   · `pool_fillable_slots`      —— 候选池里还有几只能补进剩下的槽位（去重、去已在队里的）；
 *   · `uncertainty`              —— 候选池规模、池里 unknown 成员占比、缺口条数、以及由占比算出的分数区间。
 *
 * 边界（fail closed，全部有测试钉住）：
 *   · `k=0`  → `available:false` + 原因「一只都没选」；
 *   · `k>6`  → `available:false` + 原因「超过标准六宠」；
 *   · 非法 id / 重复 id → 进 `problems` 点名，不静默丢弃；重复 id 整体 `available:false`
 *     （同一只算两次会虚增覆盖）；
 *   · `k=6`  → 仍然算（`remaining_slots = 0`、`pool_fillable_slots = 0`），语义是「已经补满」。
 *
 * @param {object} partial `{team_id, members: [...]}`
 * @param {object} ctx `{index|inputs, ruleset_energy_cap, candidates: [{kind,id|species_id,instance_id}]}`
 */
export function partialCompletionValue(partial, ctx = {}) {
  const resolved = resolveRankerContext(ctx);
  if (!resolved.ok) {
    return {
      schema: 'roco-partial-completion-value/v1',
      available: false,
      unknown_reason: resolved.reason,
      chosen_count: null,
      remaining_slots: null,
      criteria: PARTIAL_CRITERIA,
      status: RANKER_STATUS,
      unverified: ['未核实：补全结构价值 —— 索引没注入，一项都算不出来'],
    };
  }
  const kernel = kernelOf(resolved);
  const index = kernel.index;
  const members = arr(partial?.members);
  const problems = [];
  const chosenCount = members.length;

  if (chosenCount === 0) {
    return {
      schema: 'roco-partial-completion-value/v1',
      available: false,
      unknown_reason: '一只都没选（k = 0）：没有已选结构，覆盖/速度/应对缺口都无从谈起，所以不给价值（也不给 0）',
      team_id: partial?.team_id ?? null,
      chosen_count: 0,
      remaining_slots: TARGET_TEAM_SIZE,
      criteria: PARTIAL_CRITERIA,
      status: RANKER_STATUS,
      evidence: [evidence('injected:partial', 'partial.members', 'length', 0, 'k = 0：没有已选结构')],
      unverified: ['未核实：补全结构价值 —— k = 0 时没有已选结构可作为基线'],
    };
  }
  if (chosenCount > TARGET_TEAM_SIZE) {
    return {
      schema: 'roco-partial-completion-value/v1',
      available: false,
      unknown_reason: `已选 ${chosenCount} 只 > 标准六宠：超出槽位数没有定义（不给「多出来的算不算」这种猜测）`,
      team_id: partial?.team_id ?? null,
      chosen_count: chosenCount,
      remaining_slots: 0,
      criteria: PARTIAL_CRITERIA,
      status: RANKER_STATUS,
      evidence: [evidence('injected:partial', 'partial.members', 'length', chosenCount,
        '超过标准六宠：超出部分语义未定义，所以整体 fail closed')],
      unverified: ['未核实：补全结构价值 —— 超出六宠的语义在本仓没有依据'],
    };
  }

  const side = teamSide(kernel, partial, partial?.team_id ?? 'partial');
  const resolvedProfiles = side.profiles;
  const duplicateProblems = side.problems.filter((p) => p.code === 'DUPLICATE_MEMBER');
  const invalidProblems = side.problems.filter((p) => p.code !== 'DUPLICATE_MEMBER');
  problems.push(...side.problems);
  if (duplicateProblems.length > 0) {
    return {
      schema: 'roco-partial-completion-value/v1',
      available: false,
      unknown_reason: `重复的成员 id：${duplicateProblems.map(formatRankerProblem).join('；')}`,
      team_id: partial?.team_id ?? null,
      chosen_count: chosenCount,
      remaining_slots: Math.max(0, TARGET_TEAM_SIZE - chosenCount),
      criteria: PARTIAL_CRITERIA,
      status: RANKER_STATUS,
      problems,
      evidence: [evidence('injected:partial', 'partial.members', 'duplicate_count', duplicateProblems.length,
        '同一只登记两次：覆盖类指标会被虚增，所以整体 fail closed 而不是算两遍')],
      unverified: ['未核实：补全结构价值 —— 成员里有重复 id，任何覆盖类计数都不可信'],
    };
  }
  if (resolvedProfiles.length === 0) {
    return {
      schema: 'roco-partial-completion-value/v1',
      available: false,
      unknown_reason: `已选的 ${chosenCount} 只一个都解析不出来：${invalidProblems.map(formatRankerProblem).join('；') || '没有可解析的成员'}`,
      team_id: partial?.team_id ?? null,
      chosen_count: chosenCount,
      remaining_slots: Math.max(0, TARGET_TEAM_SIZE - chosenCount),
      criteria: PARTIAL_CRITERIA,
      status: RANKER_STATUS,
      problems,
      evidence: [evidence('injected:partial', 'partial.members', 'resolved_members', 0,
        '非法 id：解析不出来就不算（不跳过、不猜物种）')],
      unverified: ['未核实：补全结构价值 —— 已选成员全部解析失败'],
    };
  }

  const remainingSlots = Math.max(0, TARGET_TEAM_SIZE - resolvedProfiles.length);
  const attackTypes = index.attackTypes;
  const resistable = uniqueSorted(resolvedProfiles.flatMap((p) => p.weakness.known ? p.weakness.resist : []));
  const typesUnknown = resolvedProfiles.filter((p) => !p.weakness.known).map((p) => p.key);
  const bandsCovered = uniqueSorted(resolvedProfiles.map((p) => p.speed_band).filter(Boolean));
  const speedUnknown = resolvedProfiles.filter((p) => typeof p.spe !== 'number').map((p) => p.key);
  const respondCovered = uniqueSorted(resolvedProfiles.flatMap((p) => p.respond_variants ?? []));
  const respondUnknown = resolvedProfiles.filter((p) => !Array.isArray(p.respond_variants)).map((p) => p.key);
  const pivotHolders = resolvedProfiles.filter((p) => (p.pivot_tools ?? []).length > 0);
  const uncoveredTypes = attackTypes.filter((type) => !resistable.includes(type));

  // 候选池：可补的下一只（去重 + 去掉已在队里的）。`partial.members` 的实例 id 与物种 id 都算「已在队里」。
  const inTeamInstance = new Set(resolvedProfiles.map((p) => p.instance_id).filter(isNonEmptyString));
  const inTeamSpecies = new Set(resolvedProfiles.map((p) => p.species_id).filter(isNonEmptyString));
  const candidates = arr(ctx.candidates);
  const usable = [];
  const candidateProblems = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const ref = memberRefOf(candidates[i]);
    if (ref === null) {
      candidateProblems.push(auditProblem('INVALID_CANDIDATE', `ctx.candidates[${i}]`, `候选形状不认识（${typeof candidates[i]}）`));
      continue;
    }
    const profile = profileFromIndex(kernel, ref);
    if (profile.species_id === null) {
      candidateProblems.push(auditProblem('UNRESOLVED_CANDIDATE', `ctx.candidates[${i}]`, profile.unknown_reason));
      continue;
    }
    const already = (profile.instance_id && inTeamInstance.has(profile.instance_id)) || inTeamSpecies.has(profile.species_id);
    if (already) { candidateProblems.push(auditProblem('CANDIDATE_ALREADY_IN_TEAM', `ctx.candidates[${i}]`, `${profile.key} 已经在队里`)); continue; }
    usable.push(profile);
  }
  const uniqueUsable = [];
  const seenCandidate = new Set();
  for (const profile of usable.sort((x, y) => byLex(x.key, y.key))) {
    const key = profile.instance_id ?? profile.species_id;
    if (seenCandidate.has(key)) continue;
    seenCandidate.add(key);
    uniqueUsable.push(profile);
  }
  const poolUnknown = uniqueUsable.filter((p) => p.unknown_reason.length > 0).length;
  const poolFillable = Math.min(remainingSlots, uniqueUsable.length);
  const poolFullyKnown = uniqueUsable.filter((p) => p.unknown_reason.length === 0).length;
  const gapCount = uncoveredTypes.length
    + Math.max(0, 3 - bandsCovered.length)
    + Math.max(0, RESPOND_VARIANTS.length - respondCovered.length);

  // 分数：结构覆盖的**计数**占满目标位（分母是声明的目标，不是编出来的概率）。
  const parts = {
    coverage_resistable_types: {value: resistable.length, target: attackTypes.length,
      ratio: attackTypes.length ? round(resistable.length / attackTypes.length) : null,
      gap_count: uncoveredTypes.length, gap_types: uncoveredTypes, unknown_members: typesUnknown},
    speed_bands_covered: {value: bandsCovered.length, target: 3, bands: bandsCovered,
      gap_count: Math.max(0, 3 - bandsCovered.length), unknown_members: speedUnknown},
    respond_variants_covered: {value: respondCovered.length, target: RESPOND_VARIANTS.length,
      variants: respondCovered, gap_count: Math.max(0, RESPOND_VARIANTS.length - respondCovered.length),
      unknown_members: respondUnknown},
    pivot_holders: {value: pivotHolders.length, target: resolvedProfiles.length,
      holders: pivotHolders.map((p) => p.key),
      ratio: resolvedProfiles.length ? round(pivotHolders.length / resolvedProfiles.length) : null},
    pool_fillable_slots: {value: poolFillable, remaining_slots: remainingSlots,
      pool_size: uniqueUsable.length, pool_fully_known: poolFullyKnown,
      pool_unknown: poolUnknown, raw_pool_size: candidates.length},
  };
  const parts_scored = ['coverage_resistable_types', 'speed_bands_covered', 'respond_variants_covered'];
  const ratios = parts_scored.map((key) => parts[key].ratio
    ?? (parts[key].target > 0 ? parts[key].value / parts[key].target : null));
  const usableRatios = ratios.filter((value) => Number.isFinite(value));
  const score = usableRatios.length === 0 ? null : round(usableRatios.reduce((a, b) => a + b, 0) / usableRatios.length);
  const weakest = parts_scored
    .map((key) => ({key, ratio: parts[key].ratio ?? (parts[key].target > 0 ? parts[key].value / parts[key].target : null)}))
    .filter((row) => Number.isFinite(row.ratio))
    .sort((a, b) => (a.ratio - b.ratio) || byLex(a.key, b.key))[0]?.key ?? null;

  // uncertainty：候选池越小 / unknown 越多，分数能覆盖的区间越宽。它是**区间**，不是概率。
  const poolRatio = remainingSlots > 0
    ? Math.min(1, uniqueUsable.length / Math.max(1, remainingSlots)) : 1;
  const unknownRatio = uniqueUsable.length > 0 ? round(poolUnknown / uniqueUsable.length) : 0;
  const knownRatio = uniqueUsable.length > 0 ? round(poolFullyKnown / uniqueUsable.length) : 0;
  const halfWidth = score === null ? null : round((1 - knownRatio) * 0.5 + (1 - poolRatio) * 0.5);
  const uncertainty = {
    // 全部是计数与占比：池子多大、池里多少只带 unknown、区间多宽。没有一项是概率。
    available_pool_size: uniqueUsable.length,
    raw_candidate_count: candidates.length,
    pool_unknown_members: poolUnknown,
    pool_unknown_ratio: unknownRatio,
    pool_fully_known_ratio: knownRatio,
    fillability_ratio: round(poolRatio),
    structural_gap_count: gapCount,
    score_band: score === null ? null : {low: round(Math.max(0, score - (halfWidth ?? 0))),
      high: round(Math.min(1, score + (halfWidth ?? 0)))},
    band_half_width: halfWidth,
    unit: RANKER_UNITS.relative,
    why: '区间宽度只由「候选池能填满几个剩余槽位」与「池里有多少只带 unknown」决定；'
      + '它描述的是**我们不知道多少**，不是任何意义上的可能性',
  };

  return {
    schema: 'roco-partial-completion-value/v1',
    available: true,
    unknown_reason: null,
    team_id: partial?.team_id ?? null,
    chosen_count: resolvedProfiles.length,
    rejected_count: chosenCount - resolvedProfiles.length,
    remaining_slots: remainingSlots,
    target_team_size: TARGET_TEAM_SIZE,
    score,
    weakest_part: weakest,
    parts,
    uncertainty,
    unit: RANKER_UNITS.relative,
    // 结构价值会随补入的成员单调改善：这是**设计判据**（测试里对覆盖类分做单调性检查）。
    monotone_in_parts: parts_scored,
    problems: [...problems, ...candidateProblems],
    status: RANKER_STATUS,
    evidence: [
      evidence('injected:partial', 'partial.members', 'resolved_members', resolvedProfiles.length,
        '已选 k 只里解析得出、参与结构计算的只数（重复/非法 id 已点名，见 problems）'),
      evidence(FROZEN_PATHS.types, 'types[组合键].resist', 'resistable_attack_types', resistable,
        '能抗住的攻击系别（组合行优先；没登记的成员整体算 unknown，不回退 types[0]）'),
      evidence(FROZEN_SPEED_SOURCES.ref, 'pets[].stats.spe + role_annotations[].speed_tier', 'speed_bands_covered', bandsCovered,
        `占了几个速度档位（3 档：slow/mid/fast，来自冻结速度轴 ${FROZEN_SPEED_SOURCES.species} 只的 speed_tier）`),
      evidence(FROZEN_PATHS.skills, 'skills[].desc', 'respond_variants_covered', respondCovered,
        `覆盖了几类应对词条（共 ${RESPOND_VARIANTS.length} 类）`),
      evidence('injected:ctx', 'ctx.candidates', 'available_pool_size', uniqueUsable.length,
        `注入候选 ${candidates.length} 个，去掉重复/已在队里的之后剩 ${uniqueUsable.length} 个`),
    ],
    unverified: [
      '未核实：补入某一只之后的实战表现 —— 这是**结构**价值（覆盖缺口 / 速度缺口 / 应对缺口 / 弱点暴露面），不是预测',
      '未核实：候选是否真的能拿到 —— 本模块只看注入的候选形状与冻结数据，不检查玩家的获取条件',
      ...(poolUnknown > 0 ? [`未核实：候选池里 ${poolUnknown} / ${uniqueUsable.length} 只带 unknown（缺冻结面板/学招表），`
        + '它们能补上什么只能按已知部分算'] : []),
      ...(typesUnknown.length > 0 ? [`未核实：成员 ${typesUnknown.join(' / ')} 的属性组合行没登记，覆盖类计数把它们排除在外`] : []),
      ...(invalidProblems.length > 0 || candidateProblems.length > 0
        ? ['未核实：被拒绝的成员/候选 —— 非法或解析不出的条目已点名，没有静默丢弃'] : []),
    ],
    criteria: PARTIAL_CRITERIA,
  };
}

/** Partial-team Completion Value 的判据原文（测试与报告引用同一份）。 */
export const PARTIAL_CRITERIA = 'k∈[1,6] 才算；k=0、k>6、重复 id、非法 id 一律 fail closed（available:false + 原因）；'
  + '所有金额都是可复算的计数或占比，`uncertainty` 只描述候选池规模与 unknown 占比，不含任何概率；'
  + '补入严格更好的成员时覆盖类分不许下降';

// ─────────────────────────────────────────────────────────────────────────
// 与 RC-303 的接线：一个能被 `resolveRanker()` 认下的版本化排序器对象
// ─────────────────────────────────────────────────────────────────────────

/**
 * RC-303 `scoreTeams()` 会调 `ranker.score(features, {team, index_facts})`，
 * 这里的 `features` 是 RC-303 的 `teamFeatures()` 形状（不是成对特征）。
 * 这个适配器把它直接折成同一个加权平均，**形状与口径与 `pairwiseScore` 一致**。
 *
 * `calibrated: false` 是有意的：RC-303 的 `resolveRanker()` 在 `calibrated !== false`
 * 时会报 `ready`，而 `scoreTeams()` 只把 `calibrated === true` 当成 `COMMUNITY_CURRENT`。
 * 本排序器没有校准证据，所以**必须**传 false —— 它保证置信等级停在 `ENGINE_HYPOTHESIS`。
 */
export const RULE_PAIRWISE_RANKER = Object.freeze({
  ranker_id: RANKER_ID,
  version: RANKER_VERSION,
  calibrated: false,
  kind: 'rule_heuristic',
  status: RANKER_STATUS,
  weights: WEIGHTS,
  /**
   * @param {object} features RC-303 `teamFeatures()` 的返回值
   * @returns {{score: number|null, parts: object|null, available: boolean, unknown_reason: string|null}}
   */
  score(features) {
    const problems = weightProblems(WEIGHTS);
    if (problems.length > 0 || !isPlainObject(features)) {
      return {
        score: null, parts: null, available: false,
        unknown_reason: problems.length > 0
          ? `权重表不可用：${problems.map(formatRankerProblem).join('；')}`
          : `特征不是普通对象（${typeof features}）`,
        status: RANKER_STATUS,
      };
    }
    const missing = [];
    const parts = {};
    let numerator = 0;
    let denominator = 0;
    for (const id of FEATURE_IDS) {
      const source = FEATURE_SOURCE_KEYS[id];
      const value = Number(features?.[source]);
      if (!Number.isFinite(value)) { missing.push(`${source}（RC-303 队伍特征缺这一项）`); continue; }
      const raw = Math.max(0, Math.min(1, value));
      const weight = WEIGHTS[id].weight;
      parts[id] = {raw: round(raw), weight, contribution: round(weight * raw),
        from: `teamFeatures().${source}`, provenance: WEIGHTS[id].provenance, reason: WEIGHTS[id].reason};
      numerator += weight * raw;
      denominator += weight;
    }
    if (missing.length > 0 || denominator <= 0) {
      return {
        score: null, parts, available: false,
        unknown_reason: `RC-303 队伍特征缺项：${missing.join('；') || '可用权重和为 0'}`,
        status: RANKER_STATUS,
      };
    }
    return {
      score: round(numerator / denominator),
      parts,
      available: true,
      unknown_reason: null,
      unit: RANKER_UNITS.relative,
      status: RANKER_STATUS,
      unverified: [
        '未核实：排序的实战含义 —— 规则启发式排序器（权重 ENGINE_HYPOTHESIS），不是强度分、不预测胜负',
      ],
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 结构判据（必红方向）：无胜率 / 无百分数 / 无概率
// ─────────────────────────────────────────────────────────────────────────

/** 禁止出现在产出里的键（与 RC-303 / RC-304 同一份语义）。 */
export const BANNED_CLAIM_KEYS = Object.freeze([
  'win_rate', 'winrate', 'win_probability', 'win_rate_smoothed', 'strength_score', 'power_score',
  'rank_score', 'tier', 'rating', 'elo', 'meta_share', 'usage_rate', 'pick_rate', 'ban_rate',
  'probability', 'probability_win', 'odds', 'chance', 'expected_win', '胜率', '强度分', '期望值', '评分',
]);

/**
 * 禁止出现在产出**字符串**里的词/模式。`%` 单独一条：任何百分号都是伪精确。
 *
 * 为什么这里没有那个最显眼的伪精确字段名（`w` + `in_rate` 那个词）：它同时也是
 * `BANNED_CLAIM_KEYS` 的一条**键名**判据，而本仓的诚实声明字段 `no_win_rate: true`
 * 天然包含它 —— 若把那个词当字符串模式，声明的正文里就会出现它自己，判据会自咬。
 * 键名那头照旧一条不漏（`BANNED_CLAIM_KEYS` 里那条仍在，注入同名字段必红）。
 */
export const BANNED_CLAIM_PATTERNS = Object.freeze([
  Object.freeze({code: 'PSEUDO_PRECISION', label: '中文伪精确词', pattern: '胜率'}),
  Object.freeze({code: 'PSEUDO_PRECISION', label: 'winrate（无下划线写法）', pattern: 'winrate'}),
  Object.freeze({code: 'PSEUDO_PRECISION', label: 'win rate（带空格写法）', pattern: 'win rate'}),
  Object.freeze({code: 'PSEUDO_PRECISION', label: 'win-rate（带连字符写法）', pattern: 'win-rate'}),
  Object.freeze({code: 'PSEUDO_PRECISION', label: 'probability', pattern: 'probability'}),
  Object.freeze({code: 'PSEUDO_PRECISION', label: '百分号', pattern: '%'}),
]);

/**
 * 扫一个产出对象：任何键或字符串命中 `BANNED_CLAIM_KEYS` / `BANNED_CLAIM_PATTERNS` 即报红。
 *
 * 这条判据的必红方向是「注入一个假胜率字段必须被同一条判据抓到」——测试里就是这么做的。
 * 唯一豁免：以 `no_win_rate` 开头的键（它的值是 `true`，是在**声明没有**胜率字段）。
 */
export function scanBannedClaims(value, path = '$') {
  const problems = [];
  /** 这条路（一串字段名）是不是登记在 `SCAN_EXEMPT_PATHS` 里。 */
  const exemptAt = (trail) => trail.length > 0 && SCAN_EXEMPT_PATHS.some((rule) => {
    if (!rule.top.includes(trail[0])) return false;
    return trail.every((key, i) => (i === 0 ? rule.top.includes(key) : rule.fields.includes(key)));
  });
  const visit = (node, where, trail) => {
    const exempt = exemptAt(trail);
    if (process.env.RC602_TRACE) console.log('TRACE', JSON.stringify(trail), 'exempt=', exempt, 'type=', typeof node);
    if (typeof node === 'string') {
      if (exempt) return;
      for (const rule of BANNED_CLAIM_PATTERNS) {
        if (node.includes(rule.pattern)) {
          problems.push(auditProblem(rule.code, where, `字符串出现「${rule.label}」（${rule.pattern}）：${node.slice(0, 200)}`));
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      // 数组下标不进 trail：路径比对的是**字段名序列**（`red_proofs.actual`），
      // 下标只是位置，混进来会让前缀匹配断在 `red_proofs[0].actual` 上。
      node.forEach((item, i) => visit(item, `${where}[${i}]`, trail));
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node).sort(byLex)) {
        // 豁免是**按路径**判的（见 `SCAN_EXEMPT_PATHS`）：同一个字段名挂在别处照样扫。
        const childTrail = [...trail, key];
        const childExempt = exemptAt(childTrail);
        if (!childExempt && BANNED_CLAIM_KEYS.includes(key) && !key.startsWith('no_win_rate')) {
          problems.push(auditProblem('PSEUDO_PRECISION', `${where}.${key}`,
            `键名 ${key} 是禁止的伪精确字段名（不许发明胜负 / 概率 / 榜单字段）`));
        }
        visit(node[key], `${where}.${key}`, childTrail);
      }
    }
  };
  // `path` 只是**报错用的标签**（例如 `$.report`），它不参与路径匹配：
  // trail 从空开始，只装真正走过的字段名。
  visit(value, path, []);
  return {ok: problems.length === 0, problems, criteria: WEIGHT_SCAN_CRITERIA,
    exempt_keys: [...SCAN_EXEMPT_KEYS],
    exempt_paths: SCAN_EXEMPT_PATHS.map((rule) => `${rule.top.join(' / ')} 下的 ${rule.fields.join(' / ')}`)};
}

/** 扫描判据原文。 */
export const WEIGHT_SCAN_CRITERIA = '对模块导出的对象做深度遍历：任何键名命中 BANNED_CLAIM_KEYS（`no_win_rate` 前缀豁免）'
  + '或任何字符串命中 BANNED_CLAIM_PATTERNS（伪精确词表里的每一个模式，含百分号）即判红；'
  + '判据同时喂一个带伪精确字段名的对象做反证，必须被同一条判据抓到。'
  + '唯一豁免：`SCAN_EXEMPT_KEYS` 里那几个**证据留痕**字段 —— 必红反证的实际输出原文里'
  + '必然出现被禁词本身（那正是「判据抓住了它」的证据）；豁免是**按字段名逐层判**的，不是整棵树放行。';

/**
 * 扫描豁免的字段名（只有这几个，且是按名逐层判）。
 *
 * 为什么必须开这个口子：必红反证要留**实际输出原文**，而那些原文里天然带着被禁词
 * （`[PSEUDO_PRECISION] $.score.win_rate：...` 就是「判据抓住了注入字段」的证据）。
 * 若不豁免，产物会因为**贴了证据**而判红，那就逼着人删掉证据 —— 正好反了。
 * 除这几个字段名之外，其余任何键与字符串都照扫不误（测试里注入假字段必须判红）。
 */
export const SCAN_EXEMPT_KEYS = Object.freeze(['red_proofs', 'actual', 'mutation']);

/**
 * 路径豁免规则：一条路径要豁免，**每一个字段名都必须落在登记的集合里**，
 * 且至少要有一个字段名来自 `top`（子树入口）。
 *
 * 为什么不能只按字段名豁免：`actual` / `mutation` 是很常见的字段名，若按名裸豁免，
 * 任何地方挂一个 `{actual: '...'}` 就绕过了扫描 —— 那判据就没牙了。
 * 所以要求路径的**第一段**必须是登记过的子树入口（`red_proofs` / `proofs`），
 * 其余段只能是留痕字段名。于是：
 *   · `red_proofs[0].actual`      → 豁免（证据原文，本来就带被禁词）
 *   · `other[0].actual`           → **不豁免**（挂到别处照样扫出来）
 *   · `red_proofs_extra[0].actual`→ **不豁免**（入口名不同）
 */
export const SCAN_EXEMPT_PATHS = Object.freeze([
  Object.freeze({top: Object.freeze(['red_proofs', 'proofs']),
    fields: Object.freeze(['criterion', 'mutation', 'actual']),
    why: '必红反证留痕：原文必然带被禁词，那正是「判据抓住了它」的证据'}),
]);

/**
 * 整个排序器的一次性健康检查：权重表 + `RANKER_STATUS` 声明 + 无胜率扫描。
 * 线上调用方与报告都可以用它做一次自检。
 */
export function auditRanker({weights = WEIGHTS, status = RANKER_STATUS, extra = null} = {}) {
  const weightAudit = auditWeightTable(weights);
  const statusScan = scanBannedClaims(status, '$.RANKER_STATUS');
  const extraScan = extra === null ? {ok: true, problems: []} : scanBannedClaims(extra, '$.extra');
  const problems = [...weightAudit.problems, ...statusScan.problems, ...extraScan.problems];
  if (status.learned_weights !== false) {
    problems.push(auditProblem('STATUS_OVERCLAIM', 'status.learned_weights',
      `RANKER_STATUS.learned_weights = ${stableJson(status.learned_weights)}：本仓没有任何学习权重，只能是 false`));
  }
  if (status.calibrated !== false) {
    problems.push(auditProblem('STATUS_OVERCLAIM', 'status.calibrated',
      `RANKER_STATUS.calibrated = ${stableJson(status.calibrated)}：没有 held-out 校准集，只能是 false`));
  }
  if (status.emits_win_rate !== false || status.emits_outcome_prediction !== false) {
    problems.push(auditProblem('STATUS_OVERCLAIM', 'status.emits_win_rate',
      '`emits_win_rate` / `emits_outcome_prediction` 必须是 false：本排序器不产出任何预测'));
  }
  return {
    ok: problems.length === 0,
    schema: 'roco-team-ranker-audit/v1',
    problems,
    weight_audit: weightAudit,
    criteria: `${weightAudit.criteria}；${WEIGHT_SCAN_CRITERIA}；RANKER_STATUS 的 learned_weights / calibrated / emits_* 必须都是 false`,
  };
}
