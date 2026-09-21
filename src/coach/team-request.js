// ── RC-301：`RecommendationRequest` 合同（六宠 / 未知对手 / LLM 只出 schema） ─────
//
// 这个模块是**纯函数 + 零依赖**的：不读盘、不看时钟、不碰 DOM、顶层不 import 任何
// `node:` 内建（数据一律由调用方以参数注入；需要读文件时用动态 `import()` 的
// `loadRecommendationInputs()`，它只在 Node 侧可用，浏览器里会抛，由调用方接住）。
//
// 它解决的是**一件事**：把「玩家想要一套怎样的阵容」变成一份**可校验的请求对象**。
// 它**不**产生任何推荐结果——候选生成与排序是 RC-303，缺口诊断是 RC-302，
// 未知对手下的队伍比较是 RC-304。这条边界写在报告的
// `does_not_produce_recommendations` 里，也写在 `docs/roco/TEAM-REQUEST.md`。
//
// 为什么要有这个合同
// ------------------
// 「标准 PVP 六宠、匹配前不知道对手」是产品前提（13 号设计文档 §1/§2/§4）。如果让模型
// 直接把自然语言变成「一队六只」，它会做三件本仓明令禁止的事：
//   ① 把没说过的约束补成一个默认值（「随便配一队」→ 编出六只名单）；
//   ② 把不存在的精灵/模式/规则集当成存在的（幻觉 id 直接进下游）；
//   ③ 在匹配前假设已知对手（用具体敌队算胜负）。
// 所以分工是：**LLM 只负责「自然语言 → 候选 schema」**，schema 的对错由这里的程序
// 判据决定；说不清就 `ok:false` + 缺什么，绝不猜、绝不补默认值。
//
// Fail closed 的四条纪律
// ----------------------
//   1. **未知字段一律拒**（UNKNOWN_FIELD），不静默丢弃——静默丢弃会让人以为约束生效了；
//   2. **引用必须真实存在**：instance_id / species_id 对着 owned 与 pack 查，
//      mode 对着 `data/roco/battle-modes.json` 查，ruleset_config_id 对着
//      `data/roco/rulesets/*.json` 查，**不许自创**；
//   3. **矛盾即拒**：must_include ∩ must_exclude、locked ⊄ must_include ∪ selected、
//      team_size 与 mode 参数不一致、KNOWN_SCENARIO 却不给对手信息；
//   4. **自然语言抽取器很朴素**：只认出一组固定说法；认不出的名字进 UNRESOLVED_MENTION，
//      一句话里没有任何可落到 schema 的约束就 NO_REQUEST_INTENT。两者都是 ok:false。

/** 报告路径（由 `buildRc301Report()` 生成，测试比对磁盘上的字节）。 */
export const RC301_REPORT_PATH = 'reports/roco/flagship-upgrade/rc-301-team-request.json';
export const RC301_REPORT_VERSION = 'roco-rc301-team-request-report/v1';

/** 标准 PVP 模式的 id。它**必须**同时存在于 `data/roco/battle-modes.json`，本文件不复制参数。 */
export const STANDARD_PVP_MODE = 'pvp-standard-six-pet';
/** 标准 PVP 的六个队伍槽位。它是注册表里的值，这里只作为**判据**（对不上就红）。 */
export const STANDARD_PVP_TEAM_SIZE = 6;
/** 标准 PVP 默认且首选的可见性：匹配前不知道对手。 */
export const DEFAULT_VISIBILITY = 'UNKNOWN_PREMATCH';

export const VISIBILITIES = Object.freeze(['UNKNOWN_PREMATCH', 'VISIBLE_ROSTER_IN_BATTLE', 'KNOWN_SCENARIO']);
export const PREFERENCES = Object.freeze(['gentle', 'brief', 'detailed']);

/** 数据登记的相对路径（读盘的是 `loadRecommendationInputs()`，本文件其余部分是纯函数）。 */
export const DATA_PATHS = Object.freeze({
  ownedPets: 'data/roco/owned/owned-pets.json',
  pack: 'data/roco/game-data-pack/v2/pack.json',
  battleModes: 'data/roco/battle-modes.json',
  rulesets: 'data/roco/rulesets',
});

// ── 字段表：字段的**唯一**事实源 ─────────────────────────────────────────────
// `kind`      值的形状（用于逐字段校验与错误码）
// `required`  归一化之后是否必须存在（缺了就是 MISSING_FIELD，不补默认值）
// `semantics` 这个字段在**下游**是什么意思（RC-302/303/304 读它时必须知道的事）
// `default`   `null` 表示**没有默认值**；只有少数字段有显式、可追溯的默认/推导规则
export const REQUEST_FIELDS = Object.freeze([
  Object.freeze({
    name: 'mode',
    kind: 'enum-registry-id',
    required: true,
    enumSource: 'data/roco/battle-modes.json 的 modes[].id',
    semantics: '要按哪套 BattleMode 参数配队。不许自创：注册表里没有的 id 一律拒。'
      + '标准 PVP 六宠阵容工坊是本阶段核心模式，没给模式时按它代入并在 info/DEFAULTED_FIELD 里写明。',
    default: STANDARD_PVP_MODE,
    default_reason: '13 号设计文档 §2：核心模式是标准化六宠 PVP 阵容工坊。代入会被记为 DEFAULTED_FIELD，不假装是调用方给的。',
  }),
  Object.freeze({
    name: 'team_size',
    kind: 'enum-derived-integer',
    required: true,
    enumSource: 'battle-modes.json 的 mode.parameters.team_size',
    semantics: '目标队伍槽位数。它**必须**等于 mode 注册表里该模式的 team_size；标准 PVP 是 6，极速对决是 3。'
      + '注册表没写这个数时判红（不许当 6 用）。',
    default: null,
    derived_from: 'mode.parameters.team_size（调用方没给时按模式注册表代入，并在 info/DERIVED_FIELD 里写明）',
  }),
  Object.freeze({
    name: 'visibility',
    kind: 'enum',
    required: true,
    enum: VISIBILITIES,
    semantics: '这次配队能不能看到对手。标准 PVP 匹配前是 UNKNOWN_PREMATCH（只有版本 Meta prior）；'
      + 'VISIBLE_ROSTER_IN_BATTLE 表示入局后看得见对方精灵但配招/策略未知；'
      + 'KNOWN_SCENARIO 表示对手阵容已知——这时**必须**给出 opponent_roster，否则拒。',
    default: DEFAULT_VISIBILITY,
    default_reason: '匹配前不知道对手是产品场景（13 号设计文档 §1/§4）；标准 PVP 下默认且首选 UNKNOWN_PREMATCH。',
  }),
  Object.freeze({
    name: 'must_include',
    kind: 'reference-list',
    required: false,
    enumSource: 'owned-pets.json 的 instance_id 或 pack 的 pet species_id',
    semantics: '必须出现在最终队伍里的条目；每项是 owned 的 instance_id 或 pack 的 pet species_id。',
    default: [],
  }),
  Object.freeze({
    name: 'must_exclude',
    kind: 'reference-list',
    required: false,
    enumSource: 'owned-pets.json 的 instance_id 或 pack 的 pet species_id',
    semantics: '不得出现在最终队伍里的条目；与 must_include 有交集即拒（矛盾约束不许带下去）。',
    default: [],
  }),
  Object.freeze({
    name: 'locked',
    kind: 'instance-id-list',
    required: false,
    enumSource: 'owned-pets.json 的 instance_id',
    semantics: '玩家钉死不许替换的**实例**（只能是 instance_id，且必须在 owned 里）；'
      + 'locked ⊆ must_include ∪ selected——锁定一个既没入选也没进 must_include 的实例是说不通的。',
    default: [],
  }),
  Object.freeze({
    name: 'selected',
    kind: 'instance-id-list',
    required: false,
    enumSource: 'owned-pets.json 的 instance_id',
    semantics: '已经选进队伍槽位的实例（0～team_size 个）。RC-303 的渐进推荐以它为基础补全。',
    default: [],
  }),
  Object.freeze({
    name: 'max_replacements',
    kind: 'non-negative-integer',
    required: false,
    semantics: '相对 selected 最多允许替换几只。没给就是 null——表示**未指定**，不是 0（0 与「没限制」是两件事）。',
    default: null,
  }),
  Object.freeze({
    name: 'favourites_only',
    kind: 'boolean',
    required: false,
    semantics: 'true 时候选池只含 owned 里 favourite 的实例；与「必须带一只非收藏」的约束不可同时满足时判红。',
    default: false,
  }),
  Object.freeze({
    name: 'preference',
    kind: 'enum-optional',
    required: false,
    enum: PREFERENCES,
    semantics: '解释口吻偏好（温和/简短/详细）。它只影响措辞，不影响候选与排序。',
    default: null,
  }),
  Object.freeze({
    name: 'ruleset_config_id',
    kind: 'registry-id',
    required: true,
    enumSource: 'data/roco/rulesets/*.json 的 ruleset_config_id',
    semantics: '用哪份版本化规则配置算。候选规则（CANDIDATE_NOT_FOR_DEFAULT）只在显式选择时生效。',
    default: null,
    derived_from: 'registry.mode_default(mode.ruleset_binding)——只认模式注册表绑定的那一个；'
      + '注册表里没有那份配置时**拒**，不在调用方静默挑一份。',
  }),
  Object.freeze({
    name: 'opponent_roster',
    kind: 'reference-list',
    required: 'conditional:visibility=KNOWN_SCENARIO',
    enumSource: 'owned-pets.json 的 instance_id 或 pack 的 pet species_id',
    semantics: '已知对手时的对手条目（species_id / instance_id）。只有 KNOWN_SCENARIO 允许非空，'
      + '且 KNOWN_SCENARIO 必须非空；UNKNOWN_PREMATCH 下给出具体对手即拒（那是把匹配前当成匹配后）。',
    default: null,
  }),
  Object.freeze({
    name: 'constraints',
    kind: 'known-key-boolean-object',
    required: false,
    knownKeys: Object.freeze(['no_duplicate_instances', 'species_unique', 'avoid_unknown_mechanics']),
    semantics: '额外的硬约束开关。**键集合固定**，未知键按 UNKNOWN_CONSTRAINT_KEY 拒——'
      + '否则「约束」会变成模型随手加字段的口袋。',
    default: null,
  }),
]);

/** name → 字段表条目。 */
export const FIELD_BY_NAME = Object.freeze(Object.fromEntries(REQUEST_FIELDS.map((f) => [f.name, f])));
/** 合同允许的键集合（未知字段的判据）。 */
export const ALLOWED_FIELDS = Object.freeze(REQUEST_FIELDS.map((f) => f.name));
/** `constraints` 的子键白名单。 */
export const CONSTRAINT_KEYS = Object.freeze([...FIELD_BY_NAME.constraints.knownKeys]);
/** 自然语言抽取器**唯一**允许产出的键（就是合同键集合，不许另造）。 */
export const NATURAL_LANGUAGE_OUTPUT_FIELDS = ALLOWED_FIELDS;

// ── 错误码表：每条判据一个稳定码 ────────────────────────────────────────────
// `direction` 是**必红方向**（改坏了哪一边必须红），报告里逐条贴出来。
export const ERROR_CODES = Object.freeze([
  Object.freeze({code: 'INVALID_TYPE', direction: '请求不是普通对象 / 字段形状不对（team_size 不是整数、列表里有非字符串…）必须判红', detail: '点名字段与期望形状'}),
  Object.freeze({code: 'UNKNOWN_FIELD', direction: '传入合同没登记的字段（例如 selected_pets）必须判红，且不许静默丢弃', detail: '点名是哪个字段'}),
  Object.freeze({code: 'UNKNOWN_CONSTRAINT_KEY', direction: 'constraints 里出现未登记子键必须判红', detail: '点名是哪个子键'}),
  Object.freeze({code: 'MISSING_FIELD', direction: '必填字段缺失（且无法由注册表推导）必须判红，不补默认值', detail: '点名缺哪个字段'}),
  Object.freeze({code: 'INVALID_ENUM', direction: 'visibility / preference 取值不在枚举里必须判红', detail: '点名字段与实际值'}),
  Object.freeze({code: 'UNKNOWN_MODE', direction: 'mode 不在 battle-modes.json 注册表里（自创模式）必须判红', detail: '点名 id'}),
  Object.freeze({code: 'MODE_TEAM_SIZE_UNKNOWN', direction: '所选模式在注册表里没有 team_size（例如 PVE 营地），无法判 team_size 时必须判红', detail: '不许当 6 处理'}),
  Object.freeze({code: 'MODE_TEAM_SIZE_MISMATCH', direction: 'team_size 与 mode 注册表参数不一致（标准 PVP 传 3）必须判红', detail: '报出注册表值与实际值'}),
  Object.freeze({code: 'UNKNOWN_RULESET', direction: '自创 ruleset_config_id 必须判红', detail: '点名 id'}),
  Object.freeze({code: 'UNKNOWN_INSTANCE_ID', direction: '引用了 owned-pets.json 里不存在的 instance_id（或把 species_id 塞进 locked/selected）必须判红', detail: '点名 id'}),
  Object.freeze({code: 'UNKNOWN_SPECIES_ID', direction: '引用了 pack 里不存在的 species_id 必须判红', detail: '点名 id'}),
  Object.freeze({code: 'LOCKED_NOT_SELECTED', direction: 'locked 里的实例既不在 selected 也不在 must_include 必须判红', detail: 'locked ⊆ must_include ∪ selected'}),
  Object.freeze({code: 'LOCKED_EXCLUDED_CONFLICT', direction: '同一项既被锁定又被排除（锁定的必须留下、被排除的不许进队）必须判红', detail: '不可满足的约束组合'}),
  Object.freeze({code: 'TEAM_CONSTRAINT_WITHOUT_NAMES', direction: '只给了「不重复」这类**队内**约束却没点名任何一只（无法评估的请求）必须判红', detail: '不许当成可满足'}),
  Object.freeze({code: 'FAVOURITES_ONLY_EMPTY_POOL', direction: 'favourites_only=true 但 owned 里一只是收藏都没有（空池不可满足）必须判红', detail: '不许当成可满足'}),
  Object.freeze({code: 'MUST_INCLUDE_EXCLUDE_OVERLAP', direction: 'must_include 与 must_exclude 有交集必须判红', detail: '报出交集'}),
  Object.freeze({code: 'SELECTED_OVER_TEAM_SIZE', direction: 'selected 超过 team_size 个槽位必须判红', detail: '报出两个数'}),
  Object.freeze({code: 'SELECTED_HAS_EXCLUDED', direction: 'selected 里出现 must_exclude 条目必须判红', detail: '报出被排除的那项'}),
  Object.freeze({code: 'MUST_INCLUDE_HAS_UNOWNED_SPECIES', direction: 'favourites_only=true 时 must_include 里出现未拥有/非收藏的 species_id 必须判红', detail: '报出该项'}),
  Object.freeze({code: 'LOCKED_FAVOURITES_ONLY_CONFLICT', direction: 'favourites_only=true 但 must_include/locked 里一只收藏都没有，约束不可同时满足时必须判红', detail: '不许当成可满足'}),
  Object.freeze({code: 'UNKNOWN_OPPONENT', direction: 'opponent_roster 引用了不存在或未拥有的条目必须判红', detail: '点名 id'}),
  Object.freeze({code: 'OPPONENT_INFO_REQUIRED', direction: 'visibility=KNOWN_SCENARIO 却不给对手信息必须判红', detail: '缺 opponent_roster'}),
  Object.freeze({code: 'OPPONENT_INFO_NOT_ALLOWED', direction: 'visibility=UNKNOWN_PREMATCH 却给出具体对手必须判红', detail: '那是把匹配前当成匹配后'}),
  Object.freeze({code: 'MODE_SIZE_WITHOUT_MODE', direction: '自然语言只说了「N 只」却没说模式时必须判红', detail: '标准 PVP 是 6、极速对决是 3，不许挑一个当默认'}),
  Object.freeze({code: 'UNRESOLVED_MENTION', direction: '自然语言里点名了宠物/模式，但登记表里查不到必须判红', detail: '点名原文，不许猜成某一只'}),
  Object.freeze({code: 'NO_REQUEST_INTENT', direction: '一句话里没有任何能落进 schema 的约束（「随便配一队」）必须判红', detail: '应说明缺什么，而不是编六只名单'}),
  Object.freeze({code: 'CONTRADICTORY_FLAGS', direction: '同一份文本里同时给出互斥的信号（既说匹配前又说对面已定）必须判红', detail: '不许任选一个'}),
]);

/** 信息码：不是错误，但下游/玩家必须知道这件事是怎么来的。 */
export const INFO_CODES = Object.freeze([
  Object.freeze({code: 'DEFAULTED_FIELD', detail: '某字段是代入的默认值（不是调用方给的），点名并说明来源'}),
  Object.freeze({code: 'MENTION_WITHOUT_FIELD', detail: '原话点了名，但句子没说拿它做什么（带上/排除/锁定），所以它没落进任何字段——调用方必须回头看原话，不要只看 schema'}),
  Object.freeze({code: 'DERIVED_FIELD', detail: '某字段由注册表推导（team_size / ruleset_config_id ← mode 注册表）'}),
  Object.freeze({code: 'SORTED_LIST', detail: '列表被规范化去重排序，改动的是**编码**不是**语义**'}),
  Object.freeze({code: 'EMPTY_LIST', detail: '某个列表字段给了空数组：等于没给（空数组不算「约束成立」）'}),
  Object.freeze({code: 'VISIBILITY_NOT_DEFAULT', detail: '标准 PVP 下用了非首选的可见性，调用方应知道这不是匹配前口径'}),
  Object.freeze({code: 'CONSTRAINT_NOTE', detail: '已采纳的硬约束清单（自然语言里的「不重复」等落在这里）'}),
  Object.freeze({code: 'MODE_NOTE', detail: '模式注册表里该模式自身的 unknowns，或抽取器映射了哪个说法'}),
]);

/** 一条问题：`{code, field, detail, value?}`。`detail` 是要**逐条点名**的那句话。 */
const problem = (code, field, detail, value) => (
  value === undefined ? {code, field, detail} : {code, field, detail, value}
);

/** 校验结果的可读行（测试打印 / 报告里的「实际输出原文」都用它）。 */
export const formatProblem = (p) => `[${p.code}] ${p.field}：${p.detail}${p.value === undefined ? '' : `（实际值 ${JSON.stringify(p.value)}）`}`;

// ── 基础工具（纯函数） ──────────────────────────────────────────────────────

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uniqueSorted = (values) => [...new Set(values)].sort();
const sortedEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 登记表：把「真实存在的东西」装成查表结构。它**只**由注入的数据构造，
 * 缺哪一份就在 `missing` 里如实写出来——校验时按「查不到 ⇒ 拒」处理，
 * 而不是「查不到 ⇒ 放行」。
 */
export function buildRegistry({owned, pack, modes, rulesets} = {}) {
  const instances = new Map();
  for (const instance of owned?.instances ?? []) {
    if (typeof instance?.instance_id === 'string') instances.set(instance.instance_id, instance);
  }
  const species = new Map();   // species_id → {species_id, in_owned, in_pack, favourite, name}
  const addSpecies = (id, patch) => {
    if (typeof id !== 'string' || id.length === 0) return;
    const current = species.get(id) ?? {species_id: id, in_owned: false, in_pack: false, favourite: false, name: null};
    species.set(id, {...current, ...patch(current)});
  };
  for (const instance of instances.values()) {
    addSpecies(instance.species_id, (current) => ({
      in_owned: true,
      favourite: current.favourite || instance.favourite === true,
      name: current.name ?? instance.species_name ?? null,
    }));
  }
  for (const entity of packPetEntities(pack)) {
    addSpecies(entity.id, (current) => ({in_pack: true, name: current.name ?? entity.name ?? null}));
  }
  const modeById = new Map();
  for (const mode of modes?.modes ?? []) if (typeof mode?.id === 'string') modeById.set(mode.id, mode);
  const rulesetById = new Map();
  for (const ruleset of rulesets ?? []) {
    const id = ruleset?.ruleset_config_id;
    if (typeof id === 'string') rulesetById.set(id, ruleset);
  }
  const missing = [];
  if (instances.size === 0) missing.push('owned.instances');
  if (species.size === 0) missing.push('pack.pet entities');
  if (modeById.size === 0) missing.push('modes.modes');
  return {instances, species, modeById, rulesetById, missing};
}

/** 从 pack 里取「精灵」实体。兼容 `entities` 与 `sections.*.entities` 两种存放方式。 */
export function packPetEntities(pack) {
  const collected = [];
  const push = (list) => {
    for (const entity of list ?? []) {
      const kind = String(entity?.record_kind ?? '');
      if (kind.startsWith('pet') && typeof entity.id === 'string') collected.push(entity);
    }
  };
  push(pack?.entities);
  for (const section of Object.values(pack?.sections ?? {})) push(section?.entities);
  return collected;
}

/** 某个 mode 注册表里的 team_size；注册表没写（或写了 null）时返回 null，**不**替它补一个数。 */
export function modeTeamSize(registry, modeId) {
  const value = registry.modeById.get(modeId)?.parameters?.team_size;
  return Number.isInteger(value) ? value : null;
}

/**
 * 一个条目的解析结果。三种可能，**互斥**：
 *   instance_id 命中 owned  → {kind:'instance', instance_id, species_id}
 *   species_id  命中 pack    → {kind:'species', species_id}
 *   都不命中                → null（调用方按对应错误码判红，绝不猜）
 *
 * 注意顺序：先查实例再查物种。这样 `own-0001` 不会被当成某个 species_id，
 * 而 `pet_000012`（既是 pack 物种、也可能被写成引用条目）也不会被误判成实例。
 */
export function resolveReference(registry, value) {
  if (typeof value !== 'string') return null;
  if (registry.instances.has(value)) {
    return {kind: 'instance', instance_id: value, species_id: registry.instances.get(value).species_id};
  }
  if (registry.species.has(value)) return {kind: 'species', species_id: value};
  return null;
}

/**
 * 规范化：形状与编码层面的稳定化。**它不判对错，也不补没有依据的值。**
 *   · 字符串去首尾空白；
 *   · 列表去重并排序（同一集合不许因为顺序不同产出不同回执）；
 *   · 去掉值为 `undefined` 的键（`undefined` 不是「给了 null」）；
 *   · `max_replacements` 上的 `"2"` 或 `2.5` **不**被夹紧/取整，留给校验判红。
 * 返回 `{request, info}`：info 记录「这次规范化改了什么」，供回执与报告引用。
 */
export function normaliseRecommendationRequest(raw) {
  const info = [];
  if (!isPlainObject(raw)) {
    return {request: raw ?? null, info: [problem('INVALID_TYPE', 'request', '请求必须是一个普通对象（不是数组、不是 null）', raw ?? null)]};
  }
  const request = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    request[key] = typeof value === 'string' ? value.trim() : value;
  }
  for (const field of ['must_include', 'must_exclude', 'locked', 'selected', 'opponent_roster']) {
    const value = request[field];
    if (!Array.isArray(value)) continue;
    const cleaned = value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => (typeof item === 'string' ? item.trim() : item));
    const sorted = uniqueSorted(cleaned);
    if (!sortedEqual(sorted, value)) {
      info.push(problem('SORTED_LIST', field,
        `列表已去重排序：${JSON.stringify(value)} → ${JSON.stringify(sorted)}（只改编码，不改语义）`, sorted));
    }
    request[field] = sorted;
    if (sorted.length === 0) {
      info.push(problem('EMPTY_LIST', field, `${field} 是空数组：等于没给，不会被当成「这条约束成立」`, []));
    }
  }
  return {request, info};
}

// ── 校验：fail closed，逐条点名 ─────────────────────────────────────────────

/**
 * 校验并归一化一份 `RecommendationRequest`。
 *
 * @param {object} raw                调用方/模型给的请求（合同见 REQUEST_FIELDS）
 * @param {object} inputs
 * @param {object} inputs.owned       `data/roco/owned/owned-pets.json` 的内容
 * @param {object} inputs.pack        `data/roco/game-data-pack/v2/pack.json` 的内容
 * @param {object} inputs.modes       `data/roco/battle-modes.json` 的内容
 * @param {Array}  inputs.rulesets    `data/roco/rulesets/*.json` 的内容
 * @returns {{ok:boolean, request:object|null, problems:Array, info:Array, registry:object}}
 *   `request` 只在 ok 时非 null，且**已是规范化后的对象**（调用方直接用它，不要再加工）。
 */
export function validateRecommendationRequest(raw, {owned, pack, modes, rulesets} = {}) {
  const registry = buildRegistry({owned, pack, modes, rulesets});
  const problems = [];
  const info = [];

  if (!isPlainObject(raw)) {
    problems.push(problem('INVALID_TYPE', 'request', '请求必须是一个普通对象（不是数组、不是 null）', raw ?? null));
    return {ok: false, request: null, problems, info, registry};
  }
  for (const field of registry.missing) {
    problems.push(problem('MISSING_FIELD', 'registry', `登记表缺少 ${field}：查不到就拒，不用「查不到就放行」代替校验`));
  }

  const normalised = normaliseRecommendationRequest(raw);
  const draft = normalised.request;
  info.push(...normalised.info);
  if (!isPlainObject(draft)) {
    problems.push(problem('INVALID_TYPE', 'request', '规范化之后不是对象', draft));
    return {ok: false, request: null, problems, info, registry};
  }

  // ① 未知字段一律拒（不静默丢弃）。
  for (const key of Object.keys(draft)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      problems.push(problem('UNKNOWN_FIELD', key,
        `合同没有登记这个字段：它不会被采纳，也不会被忽略——请改用 ${ALLOWED_FIELDS.join(' / ')} 之一`, draft[key]));
    }
  }
  // ② constraints 的子键白名单（同样不静默丢弃）。
  if (draft.constraints !== undefined && draft.constraints !== null) {
    if (!isPlainObject(draft.constraints)) {
      problems.push(problem('INVALID_TYPE', 'constraints', 'constraints 必须是普通对象', draft.constraints));
    } else {
      for (const [key, value] of Object.entries(draft.constraints)) {
        if (!CONSTRAINT_KEYS.includes(key)) {
          problems.push(problem('UNKNOWN_CONSTRAINT_KEY', `constraints.${key}`,
            `未登记的约束键；已登记的只有 ${CONSTRAINT_KEYS.join(' / ')}`, value));
        } else if (typeof value !== 'boolean') {
          problems.push(problem('INVALID_TYPE', `constraints.${key}`, '约束开关必须是布尔', value));
        }
      }
    }
  }

  const clean = {};
  for (const [key, value] of Object.entries(draft)) if (ALLOWED_FIELDS.includes(key)) clean[key] = value;

  // ③ mode：必须来自 battle-modes.json；缺了就代入标准 PVP 并写明。
  if (clean.mode === undefined) {
    clean.mode = STANDARD_PVP_MODE;
    info.push(problem('DEFAULTED_FIELD', 'mode',
      `没给 mode：代入标准 PVP 六宠阵容工坊（${STANDARD_PVP_MODE}），这是本阶段核心模式（13 号设计文档 §2）`, clean.mode));
  }
  const modeKnown = typeof clean.mode === 'string' && registry.modeById.has(clean.mode);
  if (typeof clean.mode !== 'string') {
    problems.push(problem('INVALID_TYPE', 'mode', 'mode 必须是字符串 id', clean.mode));
  } else if (!modeKnown) {
    problems.push(problem('UNKNOWN_MODE', 'mode',
      `battle-modes.json 里没有这个 id：模式不许自创（现有 ${registry.modeById.size} 个：${[...registry.modeById.keys()].join(' / ')}）`, clean.mode));
  }
  // ④ ruleset_config_id：必须来自 rulesets/*.json；没给就只认模式注册表绑定的那一个。
  if (clean.ruleset_config_id === undefined) {
    const binding = registry.modeById.get(clean.mode)?.ruleset_binding;
    if (typeof binding === 'string' && registry.rulesetById.has(binding)) {
      clean.ruleset_config_id = binding;
      info.push(problem('DERIVED_FIELD', 'ruleset_config_id',
        `没给 ruleset_config_id：按模式 ${clean.mode} 的 ruleset_binding 代入 ${binding}`, binding));
    } else {
      problems.push(problem('MISSING_FIELD', 'ruleset_config_id',
        '必须给出规则集 id，且它要出现在 rulesets/*.json 里'
        + (binding ? `（模式 ${clean.mode} 绑定的是 ${binding}，但登记表里没有这份配置）` : `（模式 ${clean.mode} 没有 ruleset_binding）`),
        clean.ruleset_config_id ?? null));
    }
  } else if (typeof clean.ruleset_config_id !== 'string') {
    problems.push(problem('INVALID_TYPE', 'ruleset_config_id', 'ruleset_config_id 必须是字符串 id', clean.ruleset_config_id));
  } else if (!registry.rulesetById.has(clean.ruleset_config_id)) {
    problems.push(problem('UNKNOWN_RULESET', 'ruleset_config_id',
      `rulesets/*.json 里没有这份配置：不许自创（现有 ${[...registry.rulesetById.keys()].join(' / ') || '（空）'}）`, clean.ruleset_config_id));
  }
  // ⑤ team_size：必须由 mode 的注册表参数推导/一致；注册表没写数就拒。
  const registryTeamSize = modeKnown ? modeTeamSize(registry, clean.mode) : null;
  if (clean.team_size === undefined) {
    if (modeKnown) {
      if (registryTeamSize === null) {
        problems.push(problem('MODE_TEAM_SIZE_UNKNOWN', 'team_size',
          `模式 ${clean.mode} 在 battle-modes.json 里没有 team_size：不给默认值，请显式给出或换一个有登记的模式`, null));
      } else {
        clean.team_size = registryTeamSize;
        info.push(problem('DERIVED_FIELD', 'team_size',
          `没给 team_size：按模式 ${clean.mode} 的注册表参数代入 ${registryTeamSize}`, registryTeamSize));
      }
    }
  } else if (!Number.isInteger(clean.team_size)) {
    problems.push(problem('INVALID_TYPE', 'team_size', 'team_size 必须是整数（不做取整、不做夹紧）', clean.team_size));
  } else if (registryTeamSize !== null && clean.team_size !== registryTeamSize) {
    problems.push(problem('MODE_TEAM_SIZE_MISMATCH', 'team_size',
      `与模式 ${clean.mode} 的注册表参数不一致：注册表是 ${registryTeamSize}，请求是 ${clean.team_size}。`
      + '标准 PVP 是 6 个槽位；要 3 只请用极速对决/练习局这类独立模式', clean.team_size));
  }
  // ⑥ visibility / preference 枚举。
  if (clean.visibility === undefined) {
    clean.visibility = DEFAULT_VISIBILITY;
    info.push(problem('DEFAULTED_FIELD', 'visibility',
      `没给 visibility：代入 ${DEFAULT_VISIBILITY}（匹配前不知道对手；13 号设计文档 §1/§4）`, clean.visibility));
  }
  if (!VISIBILITIES.includes(clean.visibility)) {
    problems.push(problem('INVALID_ENUM', 'visibility',
      `visibility 必须是 ${VISIBILITIES.join(' / ')} 之一`, clean.visibility));
  }
  if (clean.preference !== undefined && clean.preference !== null && !PREFERENCES.includes(clean.preference)) {
    problems.push(problem('INVALID_ENUM', 'preference', `preference 必须是 ${PREFERENCES.join(' / ')} 之一`, clean.preference));
  }
  if (clean.preference === undefined) clean.preference = null;
  // 标准 PVP 的默认且首选是 UNKNOWN_PREMATCH。用别的口径**不是错误**，但必须被记下来：
  // 「以为自己在按匹配前口径算，其实用的是具名对手」这种事不能悄悄发生。
  if (clean.mode === STANDARD_PVP_MODE && clean.visibility !== DEFAULT_VISIBILITY && VISIBILITIES.includes(clean.visibility)) {
    info.push(problem('VISIBILITY_NOT_DEFAULT', 'visibility',
      `标准 PVP 的首选口径是 ${DEFAULT_VISIBILITY}（匹配前不知道对手）；本次用的是 ${clean.visibility}，下游不得把它当成匹配前口径`, clean.visibility));
  }

  // ⑦ 各列表字段的形状。
  for (const field of ['must_include', 'must_exclude', 'locked', 'selected', 'opponent_roster']) {
    if (clean[field] !== undefined && !Array.isArray(clean[field])) {
      problems.push(problem('INVALID_TYPE', field, `${field} 必须是数组`, clean[field]));
      delete clean[field];      // 形状都不对，后面的引用检查没有意义（问题已经点名了）
    }
  }
  // ⑧ 引用真实性：instance_id 只能来自 owned，species_id 只能来自 pack。
  const references = {};
  for (const field of ['must_include', 'must_exclude', 'opponent_roster']) {
    if (!Array.isArray(clean[field])) continue;
    references[field] = clean[field].map((value) => {
      const resolved = resolveReference(registry, value);
      if (!resolved) {
        const code = field === 'opponent_roster' ? 'UNKNOWN_OPPONENT'
          : (typeof value === 'string' && value.startsWith('own-') ? 'UNKNOWN_INSTANCE_ID' : 'UNKNOWN_SPECIES_ID');
        problems.push(problem(code, field,
          `${field} 里的 ${JSON.stringify(value)} 在登记表里查不到：`
          + 'instance_id 必须来自 owned-pets.json，species_id 必须来自 pack 的 pet 实体——不许猜', value));
      }
      return resolved;
    });
  }
  // locked / selected 只能是**实例**（同一只精灵有多个个体，物种没法锁）。
  for (const field of ['locked', 'selected']) {
    if (!Array.isArray(clean[field])) continue;
    references[field] = clean[field].map((value) => {
      const resolved = resolveReference(registry, value);
      if (!resolved) {
        problems.push(problem('UNKNOWN_INSTANCE_ID', field,
          `${field} 里的 ${JSON.stringify(value)} 不是 owned-pets.json 里的实例：`
          + '锁定/已选都指向个体，species_id 在这里无效——不许猜', value));
      } else if (resolved.kind !== 'instance') {
        problems.push(problem('UNKNOWN_INSTANCE_ID', field,
          `${field} 要求 instance_id，但 ${JSON.stringify(value)} 是 species_id（owned 里没有这个实例）`, value));
      }
      return resolved;
    });
  }
  // ⑨ locked ⊆ must_include ∪ selected
  if (Array.isArray(clean.locked)) {
    const allows = new Set([...(clean.must_include ?? []), ...(clean.selected ?? [])]);
    for (const id of clean.locked) {
      if (!allows.has(id)) {
        problems.push(problem('LOCKED_NOT_SELECTED', 'locked',
          `锁定的 ${id} 既不在 selected 也不在 must_include：locked ⊆ must_include ∪ selected`, id));
      }
    }
  }
  // ⑩ must_include ∩ must_exclude 非空即拒
  if (Array.isArray(clean.must_include) && Array.isArray(clean.must_exclude)) {
    const overlap = clean.must_include.filter((id) => clean.must_exclude.includes(id));
    if (overlap.length) {
      problems.push(problem('MUST_INCLUDE_EXCLUDE_OVERLAP', 'must_include/must_exclude',
        `同一条目既必须包含又必须排除：${overlap.join('、')}（矛盾约束不许带到下游）`, overlap));
    }
  }
  // ⑩b 「锁定」要求它在队里，「排除」要求它不在队里：同一项同时出现就是不可满足。
  if (Array.isArray(clean.locked) && Array.isArray(clean.must_exclude)) {
    for (const id of clean.locked) {
      if (clean.must_exclude.includes(id)) {
        problems.push(problem('LOCKED_EXCLUDED_CONFLICT', 'locked',
          `锁定的 ${id} 又在 must_exclude 里：锁定的必须留在队里，被排除的不许进队，二者不可同时成立`, id));
      }
    }
  }
  // ⑪ selected 的长度与排除项
  if (Array.isArray(clean.selected)) {
    if (Number.isInteger(clean.team_size) && clean.selected.length > clean.team_size) {
      problems.push(problem('SELECTED_OVER_TEAM_SIZE', 'selected',
        `已选 ${clean.selected.length} 只，超过 team_size=${clean.team_size}`, clean.selected.length));
    }
    if (Array.isArray(clean.must_exclude)) {
      const bad = clean.selected.filter((id) => clean.must_exclude.includes(id));
      if (bad.length) problems.push(problem('SELECTED_HAS_EXCLUDED', 'selected', `已选里出现了被排除的条目：${bad.join('、')}`, bad));
    }
  }
  // ⑫ max_replacements / favourites_only
  if (clean.max_replacements !== undefined && clean.max_replacements !== null
    && !(Number.isInteger(clean.max_replacements) && clean.max_replacements >= 0)) {
    problems.push(problem('INVALID_TYPE', 'max_replacements', 'max_replacements 必须是非负整数（不夹紧、不取整）', clean.max_replacements));
  }
  if (clean.max_replacements === undefined) clean.max_replacements = null;
  if (clean.favourites_only === undefined) clean.favourites_only = false;
  if (typeof clean.favourites_only !== 'boolean') {
    problems.push(problem('INVALID_TYPE', 'favourites_only', 'favourites_only 必须是布尔', clean.favourites_only));
  }
  if (clean.favourites_only === true && Array.isArray(clean.must_include)) {
    for (const [index, value] of clean.must_include.entries()) {
      const resolved = references.must_include?.[index];
      if (!resolved) continue;      // 引用不存在时上面已经判红，不在这里重复
      const entry = registry.species.get(resolved.species_id);
      if (!entry?.in_owned) {
        problems.push(problem('MUST_INCLUDE_HAS_UNOWNED_SPECIES', 'must_include',
          `favourites_only=true，但 ${value} 对应的物种 ${resolved.species_id} 不在 owned 里`, value));
      } else if (!entry.favourite) {
        problems.push(problem('MUST_INCLUDE_HAS_UNOWNED_SPECIES', 'must_include',
          `favourites_only=true，但 ${value} 对应的物种 ${resolved.species_id} 没有任何一只收藏个体`, value));
      }
    }
  }
  if (clean.favourites_only === true) {
    const forced = [...(clean.must_include ?? []), ...(clean.locked ?? [])];
    if (forced.length) {
      const anyFavourite = forced.some((value) => {
        const resolved = resolveReference(registry, value);
        if (!resolved) return false;
        if (resolved.kind === 'instance') return registry.instances.get(resolved.instance_id)?.favourite === true;
        return registry.species.get(resolved.species_id)?.favourite === true;
      });
      if (!anyFavourite) {
        problems.push(problem('LOCKED_FAVOURITES_ONLY_CONFLICT', 'favourites_only',
          `favourites_only=true，但 must_include/locked 里 ${JSON.stringify(forced)} 没有一只是收藏：约束不可同时满足`, forced));
      }
    }
    // 收藏池为空却要求只从收藏里选：空池不可满足，不能假装成立（空集合会让「无约束」看起来像「已满足」）。
    const favouritePool = [...registry.instances.values()].filter((i) => i.favourite === true).length;
    if (favouritePool === 0) {
      problems.push(problem('FAVOURITES_ONLY_EMPTY_POOL', 'favourites_only',
        'favourites_only=true，但 owned 里一只收藏都没有：候选池为空，约束不可满足', true));
    }
  }
  // 「队内」约束（不重复 / 每只不一样）在没有任何对象时无从评估：这不是一个可执行的请求。
  // 对象可以是点名的精灵、已选槽位，或者 favourites_only 这种**收窄后的候选池**；
  // 三者都没有时，「不要重复」只是句口头话（空集合会让「无约束」看起来像「已满足」）。
  if (isPlainObject(clean.constraints)
    && (clean.constraints.species_unique === true || clean.constraints.no_duplicate_instances === true)
    && (clean.selected ?? []).length === 0
    && (clean.must_include ?? []).length === 0
    && (clean.locked ?? []).length === 0
    && clean.favourites_only !== true) {
    problems.push(problem('TEAM_CONSTRAINT_WITHOUT_NAMES', 'constraints',
      '只给了队内约束（不重复/每只不一样），却没点名任何一只、没有已选槽位、也没有收窄候选池：'
      + '没有任何可评估的对象，这不是一份可执行的请求。请至少点名一只（或给出 selected / favourites_only）', clean.constraints));
  }
  // ⑬ visibility / opponent_roster 的一致性
  if (clean.visibility === 'KNOWN_SCENARIO') {
    if (!Array.isArray(clean.opponent_roster) || clean.opponent_roster.length === 0) {
      problems.push(problem('OPPONENT_INFO_REQUIRED', 'opponent_roster',
        'visibility=KNOWN_SCENARIO 却没有任何对手信息：已知场景必须给出对手条目，否则请用 UNKNOWN_PREMATCH',
        clean.opponent_roster ?? null));
    }
  } else if (Array.isArray(clean.opponent_roster) && clean.opponent_roster.length > 0) {
    problems.push(problem('OPPONENT_INFO_NOT_ALLOWED', 'opponent_roster',
      `visibility=${clean.visibility} 下不允许给出具体对手：匹配前不知道对手，不能把匹配前当成匹配后`, clean.opponent_roster));
  }
  // ⑭ 信息：模式注册表自己的 unknowns、已采纳的硬约束——原样带出，不替它补充。
  const modeRecord = registry.modeById.get(clean.mode);
  if (Array.isArray(modeRecord?.unknowns) && modeRecord.unknowns.length) {
    info.push(problem('MODE_NOTE', 'mode',
      `模式 ${clean.mode} 在注册表里有 ${modeRecord.unknowns.length} 条未核实项（未实机核对前不得当官方事实）`, modeRecord.unknowns.length));
  }
  if (isPlainObject(clean.constraints)) {
    const accepted = Object.entries(clean.constraints).filter(([key, value]) => CONSTRAINT_KEYS.includes(key) && value === true).map(([key]) => key);
    info.push(problem('CONSTRAINT_NOTE', 'constraints',
      `已采纳的硬约束：${accepted.join('、') || '（全为 false）'}`, clean.constraints));
  }
  // 键序固定：回执可逐字节比对（报告的新鲜度判据靠这个）。
  const ordered = {};
  for (const field of ALLOWED_FIELDS) if (clean[field] !== undefined) ordered[field] = clean[field];
  return {ok: problems.length === 0, request: problems.length === 0 ? ordered : null, problems, info, registry};
}

// ── 自然语言 → 候选 schema（LLM/规则抽取器**唯一**允许做的事） ───────────────
//
// 抽取器只做**映射**：把玩家话里出现的、本仓登记表里真实存在的条目，落成合同字段。
// 它不会：补默认值、猜名字、发明 mode/ruleset、把「随便配一队」变成一份六只名单。
// 认不出来的名字 → UNRESOLVED_MENTION（ok:false）；一句话里没有任何可落 schema 的
// 约束 → NO_REQUEST_INTENT（ok:false）。产出的对象**必须**再走一遍 validate。

// 出现这些词就等于点名了某个 BattleMode。值必须能在 battle-modes.json 里查到。
const MODE_PHRASES = Object.freeze([
  [/(?:标准\s*(?:PVP|pvp)|标准六宠|六宠标准|六宠|6v6|6V6|排位)/, 'pvp-standard-six-pet'],
  [/(?:极速对决|3v3|3V3)/, 'pvp-speed-duel-3v3'],
  [/(?:领地试炼|2v2|2V2)/, 'pvp-territory-trial-2v2'],
  [/(?:练习局|演示局|当前\s*Demo)/i, 'demo-training-3v3'],
]);
const VISIBILITY_PHRASES = Object.freeze([
  [/(?:匹配前|还没匹配|没匹配|不知道对面|未知对手|随机匹配|没有具体对手|不看对手)/, 'UNKNOWN_PREMATCH'],
  [/(?:入局后|局内(?:看|能看)到|打到一半|对局中(?:看|能看)到)/, 'VISIBLE_ROSTER_IN_BATTLE'],
  [/(?:已知对手|对手已知|对面(?:是|确定|已经)|对手(?:是|确定)|针对(?:对面|对手)|对面阵容(?:是|已))/, 'KNOWN_SCENARIO'],
]);
const PREFERENCE_PHRASES = Object.freeze([
  [/(?:温和|别太冲|客气|委婉)/, 'gentle'],
  [/(?:简短|一句话|简洁|三句话|别啰嗦)/, 'brief'],
  [/(?:详细|展开|说清楚|讲透|全面)/, 'detailed'],
]);
const SIZE_WORDS = Object.freeze({'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6});
const CN_NUM = '[0-9一二两三四五六七八九十]+';
const FAVOURITES_ONLY = /(?:只(?:从|在)?(?:收藏|喜欢|心水)|只要(?:收藏|喜欢)的|收藏优先)/;
const SPECIES_UNIQUE = /(?:不(?:要)?重复|不许重复|别重复|不重样|不同种(?:类)?|每只都不(?:能)?一样|避免重复)/;
/** 名字前面（最多 8 个字符内）的动词决定它落在哪个字段；没有动词时不落字段。 */
/** 连接词：要认领，但**不**决定字段归属。 */
const CONNECTORS = Object.freeze(['还有', '并且', '而且', '以及', '同时', '另外']);
const FIELD_TRIGGER = Object.freeze([
  [/(?:锁定|钉死|不许换|不能换|别换|保留)/, 'locked', '原话锁定'],
  [/(?:不要用|不要|别带|排除|去掉|不带|换掉)/, 'must_exclude', '原话排除'],
  [/(?:必须有|必须带|带上|要有|留着|配上|搭配|加入|要)/, 'must_include', '原话必须包含'],
  [/(?:对面|对手|敌方)/, 'opponent_roster', '原话点名对手'],
]);
const STOPWORDS = Object.freeze([
  '随便', '配一队', '配一', '配队', '组队', '帮我', '帮忙', '帮', '我', '一下', '一个', '一队', '队伍', '阵容',
  '看看', '给个', '来个', '推荐', '优化', '调整', '版本', '环境', '现在', '当前', '这局', '对手', '对面', '敌方',
  '标准', '模式', '精灵', '宠物', '伙伴', '带上', '带', '不要', '别', '必须', '有', '喜欢', '收藏', '锁定', '钉死',
  '不许换', '不能换', '别换', '保留', '排除', '去掉', '不带', '换掉', '要有', '留着', '配上', '搭配', '加入',
  '每只', '都', '的', '了', '吧', '吗', '呢', '和', '还有', '都带上', '带上', '以及', '都换掉', '换', '把', '一下',
]);

/** 中文数词 → 整数；认不出来返回 null（不猜）。 */
export function parseChineseNumber(text) {
  const token = String(text ?? '').trim();
  if (/^\d+$/.test(token)) return Number(token);
  if (token.length === 1 && Object.hasOwn(SIZE_WORDS, token)) return SIZE_WORDS[token];
  if (token === '十') return 10;
  const ten = /^十([一二三四五六七八九])$/.exec(token);
  if (ten) return 10 + SIZE_WORDS[ten[1]];
  const tens = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(token);
  if (tens) return SIZE_WORDS[tens[1]] * 10 + (tens[2] ? SIZE_WORDS[tens[2]] : 0);
  return null;
}

/** 引出名字的动词/助词。它们既用来判定字段，也用来切出「疑似点名」的候选。 */
const TRIGGER_WORDS = Object.freeze([
  '锁定', '钉死', '不许换', '不能换', '别换', '保留',
  '不要用', '不要', '别带', '排除', '去掉', '不带', '换掉',
  '必须有', '必须带', '带上', '要有', '留着', '配上', '搭配', '加入',
  '对面', '对手', '敌方',
  // 连接词也在动词表里：它们不是「字段动词」，但落在「动词 → 名字」之间时同样要认领，
  // 否则「必须有 A 并且锁定 B」里的「并且」会被当成认不出的点名。它们不参与字段判定。
  '还有', '并且', '而且', '以及', '同时', '另外',
]);
const TRIGGER_HEAD = new RegExp(`(?:${[...TRIGGER_WORDS].sort((a, b) => b.length - a.length).join('|')})[\\u4e00-\\u9fa5]{2,6}`);
/** 两次点名之间的连接词：它们不是名字，认领掉它们才不会被当成「认不出的点名」。 */
const JOINERS = Object.freeze(['还有', '并且', '而且', '以及', '同时', '另外', '和', '与', '、', '，', ',', '都', '也']);
const TRIGGER_TAIL = new RegExp(`[\\u4e00-\\u9fa5]{2,6}(?:${[...TRIGGER_WORDS].sort((a, b) => b.length - a.length).join('|')})`);

/**
 * 把一个候选片段里**紧贴两端**的停用词剥掉（那些就是引出名字的动词本身）。
 * 返回 `{middle, blocked}`：`middle` 是剥完之后剩下的汉字串；`blocked` 表示
 * 「剥完之后内部还夹着停用词」，也就是说它是句子的片段而不是一个名字。
 */
function stripStopwords(fragment) {
  let middle = fragment;
  let moved = true;
  while (moved) {
    moved = false;
    for (const word of STOPWORDS) {
      if (middle.startsWith(word)) {middle = middle.slice(word.length); moved = true;}
      if (middle.endsWith(word)) {middle = middle.slice(0, -word.length); moved = true;}
    }
  }
  const blocked = STOPWORDS.some((word) => middle.includes(word));
  return {middle, blocked};
}

/**
 * 找出「看起来在点名某个宠物、但登记表里没有这个名字」的片段。
 *
 * 判据刻意收得很紧：只在**动词引出名字的位置**上找（`必须有…` / `…锁定` 等），
 * 再把停用词剥掉，剩下 2～6 个汉字才当候选，且候选不能是登记表里任何名字的片段。
 * 宁可漏报一次错别字，也不要把「帮我看下阵容」这种正常句子报成 UNRESOLVED_MENTION——
 * 那一来正常请求全被拒，判据就变成了噪音。
 *
 * @param {string} text          被认领片段已用占位符覆盖过的原文（占位符已去掉）
 * @param {Set<string>} tokenSet 登记表里所有名字（species_name / species_id / instance_id）
 */
const isJoinerOnly = (text) => {
  let rest = text;
  let moved = true;
  while (moved) {
    moved = false;
    for (const word of JOINERS) {
      if (rest.startsWith(word)) {rest = rest.slice(word.length); moved = true;}
    }
  }
  return rest.length === 0;
};

export function mentionCandidates(text, tokenSet = new Set()) {
  const out = [];
  const tokens = [...tokenSet].filter((token) => token.length >= 2).sort((a, b) => b.length - a.length);
  const push = (candidate, {followedByToken = false} = {}) => {
    if (candidate.length < 2 || candidate.length > 6) return;
    const {middle, blocked} = stripStopwords(candidate);
    if (blocked || middle.length < 2) return;
    // 纯连接词（「并且」「还有」「以及」）不是名字：它们是句子结构，剥掉就不该再报。
    if (isJoinerOnly(middle)) return;
    for (const token of tokens) if (token.includes(middle) || middle.includes(token)) return;
    // 候选后面紧跟着一个**登记表里的 id**（`必须有 own-0001`）：中间那几个汉字是连接词，不是名字。
    if (followedByToken) return;
    // 候选本身就是「名字 + 助词」（`铠甲虫配` / `有喷火驼`）：拆出来的名字已经在登记表里，
    // 这段就不是「认不出的点名」。
    for (let take = middle.length - 1; take >= 2; take -= 1) if (tokenSet.has(middle.slice(0, take))) return;
    for (let from = 1; from <= middle.length - 2; from += 1) if (tokenSet.has(middle.slice(from))) return;
    out.push(middle);
  };
  for (const match of text.matchAll(new RegExp(TRIGGER_HEAD.source, 'g'))) {
    const end = match.index + match[0].length;
    push(match[0], {followedByToken: tokens.some((token) => text.startsWith(token, end))});
  }
  for (const match of text.matchAll(new RegExp(TRIGGER_TAIL.source, 'g'))) push(match[0]);
  return [...new Set(out)];
}

/**
 * `at` 处的名字是不是一次**独立**的点名。
 *
 * 中文没有空格，所以这里用「登记表里有没有更长的名字压在同一位置」来判断：
 *   · 左边还是汉字、且以它结尾的名字在登记表里更短地存在 ⇒ 说明匹配落在名字中段（拒绝）；
 *   · 右边还能拼出登记表里的更长名字 ⇒ 只是某个长名字的前缀（拒绝）。
 */
function isStandaloneName(text, at, token, registryTokens) {
  const before = at === 0 ? '' : text[at - 1];
  if (/[\u4e00-\u9fa5]/.test(before)) {
    const left = text.slice(Math.max(0, at - 6), at);
    for (let length = 1; length <= left.length; length += 1) {
      if (registryTokens.has(left.slice(-length) + token)) return false;
    }
  }
  const after = text[at + token.length] ?? '';
  if (/[\u4e00-\u9fa5]/.test(after)) {
    for (let length = 1; length <= 5 && at + token.length + length <= text.length; length += 1) {
      if (registryTokens.has(token + text.slice(at + token.length, at + token.length + length))) return false;
    }
  }
  return true;
}

/**
 * 自然语言 → 候选 schema。**只做映射，不做判断**；产出的对象必须再过 validate。
 *
 * @param {string} text 玩家原话
 * @param {object} inputs 与 `validateRecommendationRequest` 同一份数据（owned / pack / modes / rulesets）
 * @returns {{ok:boolean, request:object|null, problems:Array, info:Array, validation:object|null}}
 *   `ok:true` 表示「抽取 + 校验」都通过；`ok:false` 时 `problems` 会点明**缺什么**。
 *   `request` 是**候选 schema**（已规范化），不是推荐结果。
 */
export function requestFromNaturalLanguage(text, inputs = {}) {
  const source = typeof text === 'string' ? text : '';
  const raw = {};
  const problems = [];
  const info = [];
  // 被认领的片段用占位符覆盖，剩下的就是「没被任何规则读到」的部分。
  let rest = source;
  const consume = (from, to) => {
    const length = Math.max(1, to - from);
    rest = rest.slice(0, from) + '\u0000'.repeat(length) + rest.slice(to);
  };
  const registry = buildRegistry(inputs);

  if (source.trim().length === 0) {
    problems.push(problem('NO_REQUEST_INTENT', 'text', '原文是空的：没有任何可以映射进 schema 的信息', source));
    return {ok: false, request: null, problems, info, validation: null};
  }

  // ① BattleMode（值必须能在注册表里查到，查不到就由 validate 按 UNKNOWN_MODE 判红）
  const modeHits = [];
  for (const [re, id] of MODE_PHRASES) {
    const m = re.exec(source);
    if (m) modeHits.push({id, match: m});
  }
  const modeIds = [...new Set(modeHits.map((h) => h.id))];
  if (modeIds.length > 1) {
    problems.push(problem('CONTRADICTORY_FLAGS', 'mode',
      `同一句话里出现了互斥的模式说法：${modeHits.map((h) => h.match[0]).join('、')}——不替你选一个`, modeIds));
  } else if (modeIds.length === 1) {
    raw.mode = modeIds[0];
    consume(modeHits[0].match.index, modeHits[0].match.index + modeHits[0].match[0].length);
  }

  // ② 队伍规模（「N 只」）。模式没说时**不**在旁边补一个默认数——那正是要避免的猜。
  const sizeHits = [];
  const sizeRe = new RegExp(`(${CN_NUM})\\s*只`, 'g');
  let sizeMatch;
  while ((sizeMatch = sizeRe.exec(source)) !== null) {
    const value = parseChineseNumber(sizeMatch[1]);
    if (value !== null) sizeHits.push({value, match: sizeMatch});
  }
  const sizeValues = [...new Set(sizeHits.map((h) => h.value))];
  if (sizeValues.length > 1) {
    problems.push(problem('CONTRADICTORY_FLAGS', 'team_size',
      `同一句话里出现了互斥的队伍规模：${sizeHits.map((h) => `${h.match[1]}只`).join('、')}——不替你选一个`, sizeValues));
  } else if (sizeValues.length === 1) {
    raw.team_size = sizeValues[0];
    consume(sizeHits[0].match.index, sizeHits[0].match.index + sizeHits[0].match[0].length);
  }
  if (raw.team_size !== undefined && raw.mode === undefined) {
    problems.push(problem('MODE_SIZE_WITHOUT_MODE', 'mode',
      `只说了「${raw.team_size} 只」，没说模式：标准 PVP 是 6、极速对决是 3、领地试炼是 2，`
      + '不许挑一个当默认。请补上模式（例如「标准PVP」）', raw.team_size));
  }

  // ③ 可见性
  const visibilityHits = [];
  for (const [re, value] of VISIBILITY_PHRASES) {
    const m = re.exec(source);
    if (m) visibilityHits.push({value, match: m});
  }
  const visibilityValues = [...new Set(visibilityHits.map((h) => h.value))];
  if (visibilityValues.length > 1) {
    problems.push(problem('CONTRADICTORY_FLAGS', 'visibility',
      `同一句话里出现了互斥的可见性说法：${visibilityHits.map((h) => h.match[0]).join('、')}——不替你选一个`, visibilityValues));
  } else if (visibilityValues.length === 1) {
    raw.visibility = visibilityValues[0];
    consume(visibilityHits[0].match.index, visibilityHits[0].match.index + visibilityHits[0].match[0].length);
  }

  // ④ 口吻偏好
  for (const [re, value] of PREFERENCE_PHRASES) {
    const m = re.exec(source);
    if (m && raw.preference === undefined) {
      raw.preference = value;
      consume(m.index, m.index + m[0].length);
    }
  }

  // ⑤ favourites_only / 不重复
  const fav = FAVOURITES_ONLY.exec(source);
  if (fav) {
    raw.favourites_only = true;
    consume(fav.index, fav.index + fav[0].length);
  }
  const uniq = SPECIES_UNIQUE.exec(source);
  if (uniq) {
    raw.constraints = {...(raw.constraints ?? {}), species_unique: true};
    consume(uniq.index, uniq.index + uniq[0].length);
  }

  // ⑥ 逐字扫描原话，把「动词 → 名字」的配对一次读出来。
  //
  // 为什么不是「先找名字再看它前面 8 个字」：那样会把「并且」这类连接词算成名字的
  // 前缀（`必须有 own-0001 并且锁定 own-0001` 里的「并且锁定」会被当成候选）。这里改成
  // 单趟左到右：记录每个动词出现的位置，遇到名字时取**最近的**那个动词决定字段归属，
  // 并把动词到名字之间的连接词一并认领（它们不属于任何名字）。取最近而不是取前 8 个字，
  // 是因为「先说一遍再补一句」的句子很常见，窗口法必然误判。
  const names = [];
  const registryTokens = new Set();
  const pushName = (token, kind, id) => {
    if (typeof token !== 'string' || token.length < 2) return;
    registryTokens.add(token);
    names.push({token, kind, id});
  };
  for (const instance of registry.instances.values()) {
    pushName(instance.instance_id, 'instance', instance.instance_id);
    pushName(instance.species_name, 'species', instance.species_id);
  }
  for (const entry of registry.species.values()) {
    pushName(entry.species_id, 'species', entry.species_id);
    pushName(entry.name, 'species', entry.species_id);
  }
  names.sort((a, b) => (b.token.length - a.token.length) || a.token.localeCompare(b.token));

  const add = (field, value, at, len, why) => {
    // 认领成功才记账：`value` 拿不到说明映射链自己坏了，那就**当没认领**——
    // 留下一个 null 元素会被当成「这条约束成立」，比不认领更坏。
    if (typeof value !== 'string' || value.length === 0) return;
    if (raw[field] === undefined) raw[field] = [];
    if (!raw[field].includes(value)) raw[field].push(value);
    consume(at, at + len);
    info.push(problem('MODE_NOTE', field, `${why}：${value}`, value));
  };
  const claimed = [];
  // 「点了名、但句子里没说拿它做什么」的名字：**不许静默丢**（第 88 轮实测到的缺口：
  // 「铠甲虫还有熔岩巨兽都带上，标准PVP」会 ok:true 而 must_include 为空，调用方以为收下了名字）。
  const ownerless = [];
  let lastMentionEnd = 0;
  const findTokenAt = (at) => names.find((name) => rest.startsWith(name.token, at));
  const TRIGGER_ANY = new RegExp(`^(?:${[...TRIGGER_WORDS].sort((a, b) => b.length - a.length).join('|')})`);
  // 文本里所有动词的位置（按出现顺序）；`end` 是动词结束处，用来判断「名字归哪个动词」。
  const triggerAt = [];
  const TRIGGER_SCAN = new RegExp(`(?:${[...TRIGGER_WORDS].sort((a, b) => b.length - a.length).join('|')})`, 'g');
  for (const match of source.matchAll(TRIGGER_SCAN)) {
    const hit = FIELD_TRIGGER.find(([re]) => re.test(match[0]));
    triggerAt.push({
      at: match.index, end: match.index + match[0].length,
      field: hit ? hit[1] : null, why: hit ? hit[2] : null, connector: !hit,
    });
  }
  let nextTrigger = 0;
  for (let at = 0; at < rest.length;) {
    // 跳过已经落在某个动词内部的字符（例如「必须有」中间的「须」）。
    const covering = triggerAt[nextTrigger];
    if (covering && at >= covering.at && at < covering.end) {at = covering.end; continue;}
    const name = findTokenAt(at);
    if (!name) {at += 1; continue;}
    if (!isStandaloneName(source, at, name.token, registryTokens)) {at += 1; continue;}
    while (nextTrigger < triggerAt.length && triggerAt[nextTrigger].end <= at) nextTrigger += 1;
    // 只有「名字前面那个动词到名字之间没有任何**别的**动词」时，归属才是确定的：
    // 中间还夹着另一个动词（`必须有 A 并锁定 B`）说明这句话在说两件事，不能拿最近的那个硬套。
    let owner = null;
    for (let index = nextTrigger - 1; index >= 0; index -= 1) {
      const candidate = triggerAt[index];
      if (candidate.end > at) continue;
      if (candidate.field !== null) owner = candidate;   // 连接词不决定归属
      break;
    }
    // 「A 还有 B 都带上」：名字后面跟着连接词、再后面才是动词时，归属由那个动词决定。
    // 只认连接词 + 「（也）带上」这一种，别的一律不推——推多了就是猜。
    if (!owner && /^(?:还有|以及|和|、|,|，)\s*(?:也)?带上/.test(source.slice(at + name.token.length, at + name.token.length + 8))) {
      owner = {field: 'must_include', why: '原话必须包含'};
    }
    // 前面没有动词时，再看名字**后面紧邻**的「（也）带上」（「X 也带上」）。
    if (!owner && /^(?:都|也|全)?带上/.test(source.slice(at + name.token.length, at + name.token.length + 5))) {
      owner = {field: 'must_include', why: '原话必须包含'};
    }
    claimed.push([at, at + name.token.length]);
    if (!owner) ownerless.push({name: name.token.text ?? name.token.name ?? name.id, id: name.id});
    if (owner) {
      add(owner.field, name.id, at, name.token.length, owner.why);
      // 前一次点名到这一次点名之间的连接词（「并且」「还有」「、」）不属于任何名字，
      // 但在叙述上确实连着两次点名，所以一并认领——否则它们会被当成「认不出的点名」。
      for (const [from, to] of claimed) {
        if (to > lastMentionEnd && to <= at) lastMentionEnd = to;
      }
      for (let k = lastMentionEnd; k < at;) {
        const token = findTokenAt(k);
        if (token) {k += token.token.length; continue;}
        const trigger = TRIGGER_ANY.exec(source.slice(k, k + 4));
        if (trigger) {k += trigger[0].length; continue;}
        const joiner = JOINERS.find((word) => source.startsWith(word, k));
        if (joiner) {claimed.push([k, k + joiner.length]); k += joiner.length; continue;}
        k += 1;
      }
      lastMentionEnd = at + name.token.length;
    }
    at += name.token.length;
  }

  // ⑥.5 点了名、但句子里没有任何字段能接住它 ⇒ **必须报出来**，不许静默丢进 ok:true。
  // 判据：宁可让调用方回头看原话，也不要给他一份「看起来成功、其实少了名字」的 schema。
  if (ownerless.length) {
    // **不阻塞**（否则「给铠甲虫配一队」这种正常句子会被判死），但**必须可见**：
    // 这是「解析没闭合」而不是「省略」，调用方拿到 ok:true 时也要看这条 info。
    info.push(problem('MENTION_WITHOUT_FIELD', 'text',
      `原话点了名，但句子没说拿这些精灵做什么（带上 / 排除 / 锁定），所以它们没落进任何字段：「`
      + `${ownerless.map((row) => row.name).join('、')}」。`
      + 'schema 仍然有效，但**名字少了**：请回头看原话，或改成「必须带上 X／排除 Y／锁定 Z」',
      ownerless.map((row) => row.name)));
  }
  // ⑦ 动词位置上出现了名字样子、但登记表里查不到的片段 ⇒ 「认不出的点名」（不猜是哪一只）。
  const leftovers = mentionCandidates(rest.replace(/\u0000/g, ''), registryTokens);
  if (leftovers.length) {
    problems.push(problem('UNRESOLVED_MENTION', 'text',
      `原话里这些片段出现在「点名」的位置上，但没能对应到登记表里的精灵：「${leftovers.join('、')}」。`
      + '别名、简称、错别字一律**不猜**是哪一只：请改成登记表里的完整名字或 instance_id', leftovers));
  }
  // ⑧ 一句话里没有任何能落进 schema 的约束 ⇒ 这是「帮我配一队」，不是一份请求。
  const hasConcrete = ['mode', 'team_size', 'visibility', 'must_include', 'must_exclude', 'locked',
    'favourites_only', 'max_replacements', 'preference', 'opponent_roster', 'constraints']
    .some((field) => raw[field] !== undefined && !(Array.isArray(raw[field]) && raw[field].length === 0));
  if (!hasConcrete) {
    problems.push(problem('NO_REQUEST_INTENT', 'text',
      '这句话里没有任何能落进 RecommendationRequest 的约束（既没说模式，也没说必须带谁/排除谁/锁定谁）。'
      + '它是在要推荐结果（那是 RC-303 的事），不是一份配队请求：请至少给出 '
      + 'mode / must_include / must_exclude / locked / favourites_only / max_replacements 之一', source));
  }
  if (problems.length) return {ok: false, request: null, problems, info, validation: null};

  const validation = validateRecommendationRequest(raw, inputs);
  for (const p of validation.info) info.push(p);
  if (!validation.ok) return {ok: false, request: null, problems: [...validation.problems], info, validation};
  // 标准 PVP 加非首选可见性：可解析，但必须留痕（不阻断）。
  if (validation.request.mode === STANDARD_PVP_MODE && validation.request.visibility !== DEFAULT_VISIBILITY) {
    info.push(problem('VISIBILITY_NOT_DEFAULT', 'visibility',
      `原话把标准 PVP 的可见性说成 ${validation.request.visibility}（不是首选的 ${DEFAULT_VISIBILITY}）；下游不得当成匹配前口径`,
      validation.request.visibility));
  }
  return {ok: true, request: validation.request, problems: [], info, validation};
}

// ── 读盘（只在 Node 侧，且是**动态** import：浏览器里这个模块不会被打包失败） ──

let cachedInputs = null;

/**
 * 读取校验所需的四份登记数据。**只在 Node 侧可用**：`toolbox.js` 进浏览器模块图，
 * 所以那边不能静态 import `node:fs`；这里用动态 import + 运行时读取。
 *
 * @param {object} [options]
 * @param {string} [options.root] 仓库根目录（默认 `process.cwd()`，与其它脚本口径一致）
 * @param {boolean} [options.cache] 是否复用进程内缓存（默认复用）
 */
export async function loadRecommendationInputs({root = null, cache = true} = {}) {
  if (cache && cachedInputs) return cachedInputs;
  const [{readFileSync, readdirSync}, {join, resolve}] = await Promise.all([
    import('node:fs'), import('node:path'),
  ]);
  const base = resolve(root ?? (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'));
  const readJson = (relative) => JSON.parse(readFileSync(join(base, relative), 'utf8'));
  const rulesetDir = join(base, DATA_PATHS.rulesets);
  const rulesets = readdirSync(rulesetDir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(rulesetDir, name), 'utf8')));
  const inputs = {
    owned: readJson(DATA_PATHS.ownedPets),
    pack: readJson(DATA_PATHS.pack),
    modes: readJson(DATA_PATHS.battleModes),
    rulesets,
    root: base,
  };
  if (cache) cachedInputs = inputs;
  return inputs;
}

/** 清掉缓存（测试用）。 */
export function resetRecommendationInputsCache() {
  cachedInputs = null;
}

// ── RC-301 机器可读报告 ────────────────────────────────────────────────────

/** 自然语言映射的样例：`ok` 组必须能过，`red` 组必须红——两边都要能被复跑脚本重现。 */
export const NL_EXAMPLE_TEXTS = Object.freeze({
  ok: Object.freeze([
    '给铠甲虫配一队标准PVP',
    '标准PVP，队伍里必须有铠甲虫',
    '标准PVP，队伍里必须有 own-0001 并且锁定 own-0001',
    '标准PVP，别带铠甲虫，队伍里必须有音速犬',
    '帮我配一队，只要收藏的，注意不要重复',
    '极速对决，带上铠甲虫',
    '标准PVP，别带铠甲虫',
    '标准PVP，说详细一点',
    '标准PVP，对手是 pet_000012，针对一下',
  ]),
  red: Object.freeze([
    '随便配一队',
    '帮我配一队',
    '标准PVP，队伍里必须有喷火驼',
    '标准PVP，锁定喷火驼',
    '极速对决，标准PVP，带铠甲虫',
    '六只，带铠甲虫',
    '标准PVP，不要重复，每只都要不一样，配一队',
    '把对面的精灵都换掉吧',
  ]),
});

const nlCases = (inputs, texts) => texts.map((text) => {
  const result = requestFromNaturalLanguage(text, inputs);
  return {
    text,
    ok: result.ok,
    request: result.request,
    code: result.problems[0]?.code ?? null,
    problems: result.problems.map(formatProblem),
    missing: result.ok ? [] : [...new Set(result.problems.map((p) => p.field))],
    info: result.info.map(formatProblem),
  };
});

/**
 * 生成 `reports/roco/flagship-upgrade/rc-301-team-request.json` 的内容。
 * 纯函数：同一份输入两次调用逐字节相同（报告里没有任何挂钟字段）。
 */
export function buildRc301Report({owned, pack, modes, rulesets} = {}) {
  const inputs = {owned, pack, modes, rulesets};
  const registry = buildRegistry(inputs);
  const standard = registry.modeById.get(STANDARD_PVP_MODE);
  const ownedInstances = [...registry.instances.values()];
  const ownedSpecies = new Set(ownedInstances.map((i) => i.species_id));
  const sampleInstance = [...registry.instances.keys()].sort()[0] ?? null;
  const sampleInstanceSpecies = registry.instances.get(sampleInstance)?.species_id ?? null;
  const favouriteInstance = ownedInstances.find((i) => i.favourite === true)?.instance_id ?? null;
  const packOnlySpecies = [...registry.species.values()]
    .filter((s) => s.in_pack && !ownedSpecies.has(s.species_id)).map((s) => s.species_id).sort()[0] ?? null;
  const ownedSpeciesSorted = [...ownedSpecies].sort();
  const secondOwnedSpecies = ownedSpeciesSorted.find((id) => {
    const entry = registry.species.get(id);
    return entry && entry.in_owned && entry.favourite === false;
  }) ?? ownedSpeciesSorted[1] ?? null;

  // 「默认 UNKNOWN_PREMATCH」的证据：一份**只给了 mode** 的最小请求，走完整校验。
  const minimal = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, inputs);
  const knownScenarioNoOpponent = validateRecommendationRequest({mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO'}, inputs);
  const namedOpponentUnderUnknown = validateRecommendationRequest({mode: STANDARD_PVP_MODE, opponent_roster: [sampleInstanceSpecies]}, inputs);
  const visibilityEvidence = {
    claim: '标准 PVP 在调用方没有给出 visibility 时，默认且首选 UNKNOWN_PREMATCH',
    input: {mode: STANDARD_PVP_MODE},
    actual_visibility: minimal.request?.visibility ?? null,
    actual_team_size: minimal.request?.team_size ?? null,
    from: minimal.info.find((p) => p.code === 'DEFAULTED_FIELD' && p.field === 'visibility')?.detail ?? null,
    default_is_preferred: minimal.request?.visibility === DEFAULT_VISIBILITY,
    registry_evidence: {
      mode_id: STANDARD_PVP_MODE,
      registry_team_size: modeTeamSize(registry, STANDARD_PVP_MODE),
      registry_status: standard?.status ?? null,
      registry_confidence: standard?.confidence ?? null,
    },
    scale_evidence: '13 号设计文档 §1「匹配前不知道对手阵容」/§4「匹配前没有具体敌队，评价的是对版本环境分布的表现」',
    known_scenario_requires_opponent: {
      ok: knownScenarioNoOpponent.ok,
      code: knownScenarioNoOpponent.problems[0]?.code ?? null,
      detail: knownScenarioNoOpponent.problems[0] ? formatProblem(knownScenarioNoOpponent.problems[0]) : null,
    },
    unknown_prematch_rejects_named_opponent: {
      ok: namedOpponentUnderUnknown.ok,
      code: namedOpponentUnderUnknown.problems[0]?.code ?? null,
      detail: namedOpponentUnderUnknown.problems[0] ? formatProblem(namedOpponentUnderUnknown.problems[0]) : null,
    },
    non_default_is_recorded_not_silent: (() => {
      const r = validateRecommendationRequest({
        mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO', opponent_roster: [sampleInstanceSpecies],
      }, inputs);
      const note = r.info.find((p) => p.code === 'VISIBILITY_NOT_DEFAULT');
      return {ok: r.ok, info_code: note?.code ?? null, detail: note ? formatProblem(note) : null};
    })(),
  };

  return {
    report_version: RC301_REPORT_VERSION,
    task: 'RC-301 RecommendationRequest 合同（六宠、未知对手、LLM 只出 schema、程序校验）',
    generated_by: 'src/coach/team-request.js 的 buildRc301Report()，由 tests/roco-team-request.test.js 复跑比对',
    clock_fields: [],
    artifact: {
      module: 'src/coach/team-request.js',
      tool_entry: 'src/coach/toolbox.js 的 request_team_recommendation',
      docs: 'docs/roco/TEAM-REQUEST.md',
      paths: DATA_PATHS,
    },
    data_basis: {
      owned_instances: registry.instances.size,
      owned_species: ownedSpecies.size,
      pack_pet_entities: packPetEntities(pack).length,
      battle_modes: [...registry.modeById.keys()],
      rulesets: [...registry.rulesetById.keys()],
      missing: registry.missing,
      sample_instance_id: sampleInstance,
      sample_species_id: sampleInstanceSpecies,
      favourite_instance_id: favouriteInstance,
      pack_only_species_id: packOnlySpecies,
      second_owned_species_id: secondOwnedSpecies,
    },
    contract: {
      allowed_fields: ALLOWED_FIELDS,
      constraint_keys: CONSTRAINT_KEYS,
      fields: REQUEST_FIELDS.map((f) => ({
        name: f.name,
        kind: f.kind,
        required: f.required,
        enum: f.enum ?? null,
        enum_source: f.enumSource ?? null,
        known_keys: f.knownKeys ? [...f.knownKeys] : null,
        default: f.default === undefined ? null : f.default,
        default_reason: f.default_reason ?? null,
        derived_from: f.derived_from ?? null,
        semantics: f.semantics,
      })),
      standard_pvp: {
        mode_id: STANDARD_PVP_MODE,
        team_size_from_registry: modeTeamSize(registry, STANDARD_PVP_MODE),
        team_size_expected: STANDARD_PVP_TEAM_SIZE,
        registry_status: standard?.status ?? null,
        registry_confidence: standard?.confidence ?? null,
        unknown_count: Array.isArray(standard?.unknowns) ? standard.unknowns.length : null,
        note: '标准 PVP 六宠的参数只从 battle-modes.json 读；注册表里它有未核实项，报告不替它补事实。',
      },
    },
    error_codes: ERROR_CODES,
    info_codes: INFO_CODES,
    unknown_prematch_is_default: visibilityEvidence,
    natural_language_mapping: {
      extractor: 'requestFromNaturalLanguage()：纯规则抽取，只做映射；产出必须再过 validateRecommendationRequest()',
      output_fields: NATURAL_LANGUAGE_OUTPUT_FIELDS,
      can: [
        '把原话里出现的 BattleMode 说法映射成注册表 id（标准PVP / 极速对决 / 领地试炼 / 练习局）',
        '把「N 只」映射成 team_size（阿拉伯数字与中文数词）',
        '把「匹配前/不知道对面」「入局后看到」「对手是…」映射成三种 visibility',
        '把「带上/必须有 X」「别带/排除 X」「锁定/不许换 X」映射成 must_include / must_exclude / locked',
        '把「只要收藏的」「不要重复」「说详细一点」映射成 favourites_only / constraints.species_unique / preference',
        '把「对手是 X」映射成 opponent_roster（并因此落到 KNOWN_SCENARIO）',
      ],
      cannot: [
        '不补默认值：没说的字段不写进候选 schema（mode/visibility 的默认由 validate 代入并记进 info，且写明这是代入的）',
        '不猜名字：认不出的宠物名/别名词进 UNRESOLVED_MENTION，ok:false，不映射成任何一只',
        '不发明 id：mode / ruleset_config_id 只能来自注册表；抽取器不生产任何登记表以外的 id',
        '不选一边：同一句话里出现互斥信号（两种模式 / 两种可见性 / 两个队伍规模）时 CONTRADICTORY_FLAGS',
        '不产出推荐：它只输出候选 schema；队伍名单、排序、解释都不是它的事（RC-303）',
        '不做同义词消解：断词、简称、错别字、方言说法覆盖有限，覆盖不到就如实报「认不出」',
        '不做全句语义解析：「铠甲虫还有熔岩巨兽都带上」这种「多个名字 + 连接词 + 后置动词」的句子，'
        + '后半段可能既没被映射、也报不出 UNRESOLVED_MENTION（于是 ok:true 但 must_include 比人少）——'
        + '这是已知覆盖缺口：调用方必须把原话与 schema 一起看，不要只信 schema',
      ],
      ok_cases: nlCases(inputs, NL_EXAMPLE_TEXTS.ok),
      red_cases: nlCases(inputs, NL_EXAMPLE_TEXTS.red),
      coverage_note: '抽取器只认登记表里逐字存在的名字（species_name / species_id / instance_id）与上表列出的固定说法；'
        + '别名、简称、错别字一律落到 UNRESOLVED_MENTION，不猜。',
    },
    does_not_produce_recommendations: {
      statement: '本 RC **不产生**推荐结果。`request_team_recommendation` 的返回值只有「经校验的请求对象 + 校验问题 + 信息」，'
        + '既没有队伍名单，也没有排序、分值、胜率或解释。',
      tool_return_shape: ['ok', 'request', 'problems', 'info', 'doesNotRecommend', 'needs', 'contract'],
      forbidden_in_this_rc: [
        '六宠候选名单 / Top-K 排序（RC-303）',
        '缺口诊断 coverage / speed / energy / respond / pivot / synergy / cost（RC-302）',
        '未知对手下的 expected value / worst archetype / matchup spread（RC-304）',
        '任何胜率或伪精确数值（本仓在取得校准证据之前一律不给）',
      ],
      enforced_by: 'tests/roco-team-request.test.js 有一条判据逐键比对工具回执的键集合，'
        + '并断言回执里不出现 candidates / ranking / recommendation / win_rate 这类字段。',
    },
    // 逐条判据：`{id, text, expected, actual, ok, actual_output}`。
    // `actual_output` 是**实际调用的原文**（问题行 / 回执对象），报告里直接可见，
    // 不需要再去翻测试日志；测试里对同一组判据也打印同样的原文。
    criteria: buildCriteria({
      inputs, registry, minimal,
      sampleInstance, sampleInstanceSpecies, secondOwnedSpecies, favouriteInstance, packOnlySpecies,
    }),
    problems: [],
  };
}

/** 逐条判据：`{id, text, expected, actual, ok}` —— 与 rc-203 报告同一种形状。 */
function buildCriteria({inputs, registry, minimal, sampleInstance, sampleInstanceSpecies, secondOwnedSpecies, favouriteInstance, packOnlySpecies}) {
  const check = (raw) => validateRecommendationRequest(raw, inputs);
  const code = (result) => result.problems[0]?.code ?? null;
  const ruleset = [...registry.rulesetById.keys()][0] ?? null;
  const base = {mode: STANDARD_PVP_MODE, ruleset_config_id: ruleset};
  // 每条判据都带 `actual_output`：这是**实际调用的原文**（问题行或回执对象），
  // 判据红了就地能看出差在哪，不用再去翻测试日志。
  const judge = (id, text, expected, actual, actualOutput = null) => ({
    id, text, expected: String(expected), actual: String(actual), ok: `${actual}` === `${expected}`,
    actual_output: actualOutput,
  });
  const problemsOf = (result) => result.problems.map(formatProblem);
  const unknownField = check({...base, selected_pets: [sampleInstance]});
  const overlap = check({...base, must_include: [sampleInstance], must_exclude: [sampleInstance]});
  const ghostInstance = check({...base, must_include: ['own-9999']});
  const ghostSpecies = check({...base, must_include: ['pet_999999']});
  const ghostMode = check({mode: 'pvp-standard-eight-pet'});
  const ghostRuleset = check({mode: STANDARD_PVP_MODE, ruleset_config_id: 'made_up_ruleset_v9'});
  const sizeThree = check({mode: STANDARD_PVP_MODE, team_size: 3});
  const knownNoOpponent = check({mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO'});
  const lockedOutside = check({...base, locked: [sampleInstance]});
  const namedOpponentUnderUnknown = check({mode: STANDARD_PVP_MODE, opponent_roster: [sampleInstanceSpecies]});
  const nlVague = requestFromNaturalLanguage('随便配一队', inputs);
  const nlTypo = requestFromNaturalLanguage('标准PVP，队伍里必须有喷火驼', inputs);
  const knownWithOpponent = check({mode: STANDARD_PVP_MODE, visibility: 'KNOWN_SCENARIO', opponent_roster: [sampleInstanceSpecies]});
  const speedDuelThree = check({mode: 'pvp-speed-duel-3v3', team_size: 3, ruleset_config_id: ruleset});
  const favouritesConflict = favouriteInstance && secondOwnedSpecies
    ? check({...base, favourites_only: true, must_include: [secondOwnedSpecies]})
    : null;
  const twoOrder = (() => {
    const a = check({...base, must_include: [sampleInstance, secondOwnedSpecies]});
    const b = check({...base, must_include: [secondOwnedSpecies, sampleInstance]});
    return {ok: a.ok && b.ok && JSON.stringify(a.request?.must_include) === JSON.stringify(b.request?.must_include),
      a: a.request?.must_include, b: b.request?.must_include};
  })();
  return [
    judge('C01', '合同字段表覆盖 REQUEST_FIELDS 的每一个字段，且每个字段都有 kind / semantics 与可追溯的默认/推导说明',
      REQUEST_FIELDS.length,
      REQUEST_FIELDS.filter((f) => f.semantics && f.kind && (f.default !== undefined || f.derived_from || f.required === 'conditional:visibility=KNOWN_SCENARIO')).length,
      REQUEST_FIELDS.map((f) => `${f.name}:${f.kind}${f.default_reason ? `（默认来自：${f.default_reason.slice(0, 24)}…）` : ''}`)),
    judge('C02', '① 未知字段（selected_pets）被判 UNKNOWN_FIELD，而不是静默丢弃',
      'UNKNOWN_FIELD', code(unknownField), problemsOf(unknownField)),
    judge('C03', '② must_include 与 must_exclude 有交集时判 MUST_INCLUDE_EXCLUDE_OVERLAP',
      'MUST_INCLUDE_EXCLUDE_OVERLAP', code(overlap), problemsOf(overlap)),
    judge('C04', '③ 不存在的 instance_id 判 UNKNOWN_INSTANCE_ID',
      'UNKNOWN_INSTANCE_ID', code(ghostInstance), problemsOf(ghostInstance)),
    judge('C05', '③b 不存在的 species_id 判 UNKNOWN_SPECIES_ID',
      'UNKNOWN_SPECIES_ID', code(ghostSpecies), problemsOf(ghostSpecies)),
    judge('C06', '④ 自创 mode 判 UNKNOWN_MODE',
      'UNKNOWN_MODE', code(ghostMode), problemsOf(ghostMode)),
    judge('C07', '⑤ 自创 ruleset_config_id 判 UNKNOWN_RULESET',
      'UNKNOWN_RULESET', code(ghostRuleset), problemsOf(ghostRuleset)),
    judge('C08', '⑥ 标准 PVP 传 team_size=3 判 MODE_TEAM_SIZE_MISMATCH',
      'MODE_TEAM_SIZE_MISMATCH', code(sizeThree), problemsOf(sizeThree)),
    judge('C09', '⑦ KNOWN_SCENARIO 又不给对手信息判 OPPONENT_INFO_REQUIRED',
      'OPPONENT_INFO_REQUIRED', code(knownNoOpponent), problemsOf(knownNoOpponent)),
    judge('C10', 'locked 不在 must_include ∪ selected 时判 LOCKED_NOT_SELECTED',
      'LOCKED_NOT_SELECTED', code(lockedOutside), problemsOf(lockedOutside)),
    judge('C11', '只给 mode 的请求默认 visibility = UNKNOWN_PREMATCH',
      DEFAULT_VISIBILITY, minimal.request?.visibility,
      {request: minimal.request, info: minimal.info.map(formatProblem)}),
    judge('C12', '只给 mode 的请求由注册表推导 team_size（标准 PVP = 6）',
      STANDARD_PVP_TEAM_SIZE, minimal.request?.team_size,
      {request: minimal.request, info: minimal.info.map(formatProblem)}),
    judge('C13', '⑧ 「随便配一队」判 NO_REQUEST_INTENT（ok:false，且说明缺什么）',
      'NO_REQUEST_INTENT', code(nlVague),
      {ok: nlVague.ok, request: nlVague.request, problems: problemsOf(nlVague)}),
    judge('C14', '自然语言里的错别字名字判 UNRESOLVED_MENTION，不猜成某一只',
      'UNRESOLVED_MENTION', code(nlTypo),
      {ok: nlTypo.ok, request: nlTypo.request, problems: problemsOf(nlTypo)}),
    judge('C15', 'KNOWN_SCENARIO + opponent_roster 通过校验，且被记成「不是首选口径」（不静默）',
      'true',
      knownWithOpponent.ok && knownWithOpponent.info.some((p) => p.code === 'VISIBILITY_NOT_DEFAULT'),
      {request: knownWithOpponent.request, info: knownWithOpponent.info.map(formatProblem)}),
    judge('C16', '极速对决 3v3 在自身模式下通过（3 只不是标准 PVP 的规模）',
      'true', speedDuelThree.ok, {request: speedDuelThree.request, problems: problemsOf(speedDuelThree)}),
    judge('C17', 'UNKNOWN_PREMATCH 下给出具体对手判 OPPONENT_INFO_NOT_ALLOWED',
      'OPPONENT_INFO_NOT_ALLOWED', code(namedOpponentUnderUnknown), problemsOf(namedOpponentUnderUnknown)),
    judge('C18', '登记表齐全（owned / pack / modes 三项都在）', '0', registry.missing.length, registry.missing),
    judge('C19', 'pack 里有 owned 之外的物种（用作「存在但不拥有」的反证材料）',
      'true',
      typeof packOnlySpecies === 'string' && ![...registry.instances.values()].some((i) => i.species_id === packOnlySpecies),
      {pack_only_species_id: packOnlySpecies}),
    judge('C20', 'favourites_only 与不收藏的 must_include 冲突时判红',
      'MUST_INCLUDE_HAS_UNOWNED_SPECIES', favouritesConflict ? code(favouritesConflict) : 'no-material',
      favouritesConflict ? problemsOf(favouritesConflict) : {favouriteInstance, secondOwnedSpecies}),
    judge('C21', '空列表被如实记成 EMPTY_LIST（不把空数组当约束成立）',
      'true', normaliseRecommendationRequest({must_include: []}).info.some((p) => p.code === 'EMPTY_LIST'),
      normaliseRecommendationRequest({must_include: []}).info.map(formatProblem)),
    judge('C22', '规范化只去重排序，不改语义（同一集合不同顺序 → 同一回执）',
      'true', twoOrder.ok, {forward: twoOrder.a, backward: twoOrder.b}),
    judge('C23', '自然语言说了「N 只」却没说模式时判 MODE_SIZE_WITHOUT_MODE（不许挑一个模式当默认）',
      'MODE_SIZE_WITHOUT_MODE', code(requestFromNaturalLanguage('六只，带铠甲虫', inputs)),
      problemsOf(requestFromNaturalLanguage('六只，带铠甲虫', inputs))),
    judge('C24', '自然语言里的模式说法与登记表 id 一致（标准PVP → pvp-standard-six-pet）',
      STANDARD_PVP_MODE, requestFromNaturalLanguage('标准PVP，带上铠甲虫', inputs).request?.mode ?? 'n/a',
      requestFromNaturalLanguage('标准PVP，带上铠甲虫', inputs).request),
    judge('C25', '`get_team_recommendation` 这类未登记名字不会被当成合同字段',
      'false', Object.hasOwn(FIELD_BY_NAME, 'get_team_recommendation'), ALLOWED_FIELDS),
  ];
}
