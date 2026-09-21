#!/usr/bin/env node
// ── RC-203：OwnedPet / BattleBuild 的**共享纯逻辑**（比较器 + 契约 + 哈希） ──────
//
// 这个文件存在的理由和 verify-game-data-pack.mjs 一样：**判据只能有一份**。
// 生成器、校验器、单元测试三边各写一遍「怎么算 unknown_fields」「怎么算 build_hash」，
// 迟早三份各自漂移，最后谁也不知道哪份算数。所以这里只有一份：
//
//   · build-owned-pets.mjs   用 buildOwnedPetSchema() / instanceBuildHash() 产生产物；
//   · verify-owned-pets.mjs  用同一批函数**重算**并比对；
//   · tests/roco-owned-pets.test.js 用同一个 runChecks 跑必红反证。
//
// 这里的东西必须是**纯函数**（不读盘、不写盘、不看时钟），否则 determinism 无从谈起。
//
// 本文件导出：
//   compareOwnedPets(a, b)   同种个体比较；**不同物种直接抛错**，不静默比较
//   buildOwnedPetSchema()    OwnedPet / BattleBuild 的自描述 schema（写成 schema.json）
//   validateAgainstContract() 由 schema 驱动的通用结构校验（schema 是契约，不是装饰）
//   instanceBuildHash() / battleBuildHash() / datasetHash()
//   makeRng() / canonicalJson() / sha256Hex()
//   expectedUnknownFields()  「哪些字段确实不可得」的**唯一**判据
//
// 为什么 unknown_fields 要写成函数而不是人工列举：任务要求「有值却标 unknown、
// 或该标没标，都要红」。人工列举做不到双向判红——只有从实例本身**重算**一遍才行。

import {createHash} from 'node:crypto';

// ── 常量：路径 / 规则集 / 固定 seed ─────────────────────────────────────────

export const RULESET_ID = 'roco-world-s4-2026-09-10';
export const GAME = 'roco_world_mobile';

export const OWNED_DIR = 'data/roco/owned';
export const OWNED_PETS_PATH = `${OWNED_DIR}/owned-pets.json`;
export const OWNED_SCHEMA_PATH = `${OWNED_DIR}/schema.json`;
export const RC203_REPORT_PATH = 'reports/roco/flagship-upgrade/rc-203-owned-pets.json';

export const FROZEN_ROOT = `data/roco/normalized/${RULESET_ID}`;
export const FROZEN_MAIN_LEARNSETS = `${FROZEN_ROOT}/learnsets.json`;
export const FROZEN_LAYER_DIR = `${FROZEN_ROOT}/layer-playable-48`;
export const FROZEN_LAYER_LEARNSETS = `${FROZEN_LAYER_DIR}/learnsets.json`;
export const FROZEN_LAYER_PETS = `${FROZEN_LAYER_DIR}/pets.json`;
export const FROZEN_LAYER_SUPPORT = `${FROZEN_LAYER_DIR}/support-matrix.json`;
export const FROZEN_FULL_CATALOG = `${FROZEN_ROOT}/full-catalog.json`;
export const FROZEN_SKILLS = `${FROZEN_ROOT}/skills.json`;
export const FROZEN_IMPORT_REPORT = `${FROZEN_ROOT}/import-report.json`;
export const PACK_PATH = 'data/roco/game-data-pack/v2/pack.json';
export const SOURCES_PATH = 'data/roco/sources.yaml';

/** 固定 seed：同一个 seed + 同一份冻结目录 ⇒ 逐字节相同的 owned-pets.json。 */
export const SEED = 20301;
/** P0B 验收要求「80 个 owned 可持久化」；这里把它写成常量，判据才能引用同一个数字。 */
export const INSTANCE_TARGET = 80;
/** 判据下界（写死在这里，免得生成器把判据悄悄调松）。 */
export const MIN_SPECIES = 40;
export const MIN_OUTSIDE_LAYER = 12;
export const MIN_SAME_SPECIES_GROUPS = 20;

/** 养成属性的面板换算公式**未校准**：这是全仓唯一一处「效果」措辞。 */
export const GROWTH_EFFECT_REASON = '面板换算公式未校准（见 10 号文档 §13）';
/**
 * 养成属性 `effect` 允许引用的**证据 id** 白名单。
 *
 * 纪律原文是「effect 必须是 UNKNOWN 或带证据 id」。本仓目前**没有任何**一条
 * 「面板换算」证据（10 号文档 §13 说得很清楚：公式待校准），所以这里是空的——
 * 任何非 UNKNOWN 的 effect 都会判红。将来校准之后，把 microcase / evidence
 * 的 id 加进来即可，判据不用改。
 */
export const GROWTH_EFFECT_EVIDENCE_IDS = Object.freeze([]);

/** 被明令禁止的「发明公式」字段名（只扫养成属性对象内部，避免误伤）。 */
export const FORBIDDEN_GROWTH_FIELD_PATTERN = '(formula|multiplier|modifier|percent|ratio|coefficient|bonus|公式|系数|加成值)';

/**
 * `generated_at` 是**确定性**的，不是挂钟时间。
 *
 * 任务要求「同输入两次逐字节相同；generated_at 之外不许有挂钟字段」。
 * 与其让 `--check` 去豁免一个字段，不如让这个字段本身没有挂钟性：
 * 它由 ruleset_id 推导（roco-world-s4-2026-09-10 → 2026-09-10T00:00:00.000Z），
 * 于是产物里**一个挂钟字段都没有**，`--check` 可以逐字节比对，不需要任何豁免。
 */
export const GENERATED_AT = `${RULESET_ID.slice(-10)}T00:00:00.000Z`;
/** 机器可读声明：本产物里的挂钟字段清单（空）。 */
export const CLOCK_FIELDS = Object.freeze([]);
/** 疑似挂钟字段名：出现即红。 */
export const WALL_CLOCK_KEY_PATTERN = /(timestamp|updated_at|created_at|fetched_at|checked_at|run_at)/i;

export const SOURCE_MODE = 'repo_generator_fixed_seed';
export const LICENCE_REF = 'wiki-rocom-snapshot';

// ── 基础工具（全纯函数） ────────────────────────────────────────────────────

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 规范 JSON：对象键排序、丢弃 undefined、无空白。
 * 逐字节复跑与哈希都靠它——`JSON.stringify` 的键序取决于插入顺序，不能用来算哈希。
 */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** mulberry32：纯整数运算，跨 Node 版本逐位可复现。 */
export function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 深比较：只看 JSON 可表达的值（本产物没有别的值）。 */
export function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── 养成属性 ────────────────────────────────────────────────────────────────

/**
 * 一个养成属性。
 *
 * 形状是任务钉死的：`{value, effect: "UNKNOWN", reason, microcase_id: null}`。
 * 本仓把它拆成 `effect_reason`（语义更明确：说明的是 effect 为什么未知），
 * 并额外带上 `value_source`，让「这个标签从哪来」也有出处。
 *
 * @param {object} args
 * @param {string|null} args.value           标签值；null 表示游戏真值不可得
 * @param {string|null} args.valueSource     取值出处；value 为 null 时必须是 null
 * @param {object} [args.extra]              额外字段（血脉要带 skill id / pointer）
 */
export function growthAttribute({value = null, valueSource = null, extra = {}} = {}) {
  if (value === null && valueSource !== null) throw new Error('growthAttribute: value 为 null 时 value_source 必须是 null');
  if (value !== null && !valueSource) throw new Error('growthAttribute: 有值就必须给出 value_source');
  return {
    value,
    value_source: value === null ? null : valueSource,
    effect: 'UNKNOWN',
    effect_reason: GROWTH_EFFECT_REASON,
    microcase_id: null,
    ...extra,
  };
}

/** 判断一个值是不是养成属性对象（不是靠 key 名字猜，是靠形状）。 */
export function isGrowthAttribute(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'effect')
    && Object.prototype.hasOwnProperty.call(value, 'microcase_id');
}

export const GROWTH_ATTRIBUTE_FIELDS = Object.freeze(['nature', 'talent', 'specialty', 'bloodline']);

// ── unknown_fields 的唯一判据 ───────────────────────────────────────────────

/** 这些是**元数据**，不参与「值可得/不可得」的判断。 */
const NON_ATTRIBUTE_INSTANCE_KEYS = Object.freeze([
  'unknown_fields', 'build_hash', 'provenance', 'licence_ref', 'skills_source',
]);
const NON_ATTRIBUTE_BUILD_KEYS = Object.freeze([
  'unknown_fields', 'build_hash', 'form_sources',
]);

/**
 * 重算「哪些字段确实不可得」。规则只有两条：
 *   ① 实例顶层字段值为 null ⇒ 该字段不可得，必须列入 unknown_fields；
 *   ② 实例顶层字段是养成属性且 `value === null` ⇒ 游戏真值不可得，必须列入。
 * 反向由调用方比对（集合相等），因此「有值却标 unknown」同样判红。
 */
export function expectedUnknownFields(record, {keys = null} = {}) {
  const skip = new Set(keys ?? NON_ATTRIBUTE_INSTANCE_KEYS);
  const out = [];
  for (const key of Object.keys(record)) {
    if (skip.has(key)) continue;
    const value = record[key];
    if (value === null) {
      out.push(key);
      continue;
    }
    if (isGrowthAttribute(value) && value.value === null) out.push(key);
  }
  return out.sort();
}

export function expectedInstanceUnknownFields(instance) {
  return expectedUnknownFields(instance, {keys: NON_ATTRIBUTE_INSTANCE_KEYS});
}

export function expectedBattleBuildUnknownFields(build) {
  return expectedUnknownFields(build, {keys: NON_ATTRIBUTE_BUILD_KEYS});
}

// ── 哈希 ────────────────────────────────────────────────────────────────────

/** 逐条哈希：把 `build_hash` 本身摘掉再算，否则自指。 */
export function hashWithout(record, key) {
  const copy = {...record};
  delete copy[key];
  return sha256Hex(canonicalJson(copy));
}

export function instanceBuildHash(instance) {
  return hashWithout(instance, 'build_hash');
}

export function battleBuildHash(build) {
  return hashWithout(build, 'build_hash');
}

/**
 * 重签整条哈希链（实例 → build → dataset）。
 *
 * 反证（--selftest）用它：反证要证明的是**某一组判据**有牙，不是证明「改一个字节
 * 哈希就对不上」——那是同一组判据在每一条反证里重复刷屏。注入之后重签一遍，
 * 每一条反证的红色就只来自它真正想证明的那一组判据。
 */
export function resignDataset(dataset) {
  for (const instance of dataset.instances ?? []) instance.build_hash = instanceBuildHash(instance);
  for (const build of dataset.battle_builds ?? []) build.build_hash = battleBuildHash(build);
  dataset.dataset_hash = datasetHash(dataset);
  return dataset;
}

/** 数据集哈希：只覆盖 80 条实例 + 80 条 build，不含报告性字段。 */
export function datasetHash(dataset) {
  return sha256Hex(canonicalJson({
    instances: dataset.instances,
    battle_builds: dataset.battle_builds,
  }));
}

// ── 同种个体比较（任务点名要的纯函数） ──────────────────────────────────────

/** 不同物种的比较是**编程错误**，不是「结果为空」——必须抛错，不许静默。 */
export class OwnedPetSpeciesMismatchError extends Error {
  constructor(a, b) {
    super(`compareOwnedPets 只接受同一 species_id 的两个个体：a=${a} b=${b}`);
    this.name = 'OwnedPetSpeciesMismatchError';
    this.speciesA = a;
    this.speciesB = b;
  }
}

const COMPARISON_FIELDS = Object.freeze([
  'level', 'nature', 'talent', 'specialty', 'bloodline', 'skills', 'favourite', 'locked',
]);

function compareScalar(field, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) {
    const detail = a === null || a === undefined
      ? (b === null || b === undefined ? '双方取值均不可得' : 'a 取值不可得')
      : 'b 取值不可得';
    return {field, status: 'unknown', a: a ?? null, b: b ?? null, detail};
  }
  return {field, status: deepEqual(a, b) ? 'same' : 'different', a, b};
}

function compareGrowthAttribute(field, a, b) {
  const label = compareScalar(field, a?.value ?? null, b?.value ?? null);
  const out = {...label, effect: 'unknown', effect_reason: GROWTH_EFFECT_REASON};
  if (field === 'bloodline') {
    // 血脉还带一条 (blood → skill_id) 的静态映射；这一条是**冻结目录里真有的**，可比。
    out.blood_skill_id = compareScalar(`${field}.blood_skill_id`, a?.blood_skill_id ?? null, b?.blood_skill_id ?? null).status;
  }
  return out;
}

/**
 * 逐字段给出 `same / different / unknown`。
 *
 * 分类规则（写死在注释里，免得以后有人改成「看起来更合理」的样子）：
 *   · 双方都有值且相等 → same
 *   · 双方都有值且不等 → different
 *   · 任一方为 null   → unknown（不可比，而不是「不同」）
 *
 * 技能是**有序数组**：顺序不同也算 different；另外单独给一条 `skills_as_set`，
 * 让「同技能不同顺序」和「技能不同」能被区分开。
 *
 * @throws {OwnedPetSpeciesMismatchError} 两个个体的 species_id 不同
 */
export function compareOwnedPets(a, b) {
  if (!a || typeof a !== 'object') throw new TypeError('compareOwnedPets: a 必须是 OwnedPet 对象');
  if (!b || typeof b !== 'object') throw new TypeError('compareOwnedPets: b 必须是 OwnedPet 对象');
  const speciesA = a.species_id ?? null;
  const speciesB = b.species_id ?? null;
  if (speciesA === null || speciesB === null) {
    throw new TypeError('compareOwnedPets: 两个个体都必须有 species_id');
  }
  if (speciesA !== speciesB) throw new OwnedPetSpeciesMismatchError(speciesA, speciesB);

  const fields = {};
  for (const field of COMPARISON_FIELDS) {
    if (GROWTH_ATTRIBUTE_FIELDS.includes(field)) {
      fields[field] = compareGrowthAttribute(field, a[field], b[field]);
      continue;
    }
    if (field === 'skills') {
      const ordered = compareScalar('skills', a.skills ?? null, b.skills ?? null);
      const setA = Array.isArray(a.skills) ? [...a.skills].sort() : null;
      const setB = Array.isArray(b.skills) ? [...b.skills].sort() : null;
      fields.skills = {
        ...ordered,
        order_sensitive: true,
        skills_as_set: compareScalar('skills_as_set', setA, setB).status,
      };
      continue;
    }
    fields[field] = compareScalar(field, a[field] ?? null, b[field] ?? null);
  }

  const different = Object.values(fields).filter((f) => f.status === 'different').map((f) => f.field);
  const unknown = Object.values(fields).filter((f) => f.status === 'unknown').map((f) => f.field);
  return {
    kind: 'owned-pet-comparison',
    comparable: true,
    same_species: true,
    species_id: speciesA,
    instance_a: a.instance_id ?? null,
    instance_b: b.instance_id ?? null,
    fields,
    different_fields: different,
    unknown_fields: unknown,
    /** 「同种不同个体」的机器判据：至少一项个体属性不同。 */
    differs_in_at_least_one_attribute: different.length > 0,
    identical_in_known_attributes: different.length === 0,
  };
}

// ── 契约（schema.json 的构建函数） ──────────────────────────────────────────

const PROVENANCE_ENTRY = {
  type: 'object',
  additionalProperties: true,
  required: ['source_id', 'source_scope', 'artifact_path', 'artifact_sha256'],
  properties: {
    source_id: {type: 'string', minLength: 1},
    source_scope: {type: 'string', minLength: 1},
    artifact_path: {type: 'string', minLength: 1},
    artifact_sha256: {type: 'string', pattern: '^[0-9a-f]{64}$'},
    pointer: {type: 'string'},
    note: {type: 'string'},
  },
};

const GROWTH_ATTRIBUTE = {
  type: 'object',
  additionalProperties: true,
  required: ['value', 'value_source', 'effect', 'effect_reason', 'microcase_id'],
  properties: {
    value: {type: 'string', nullable: true},
    value_source: {type: 'string', nullable: true},
    effect: {type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'},
    effect_reason: {type: 'string', const: GROWTH_EFFECT_REASON},
    microcase_id: {type: 'null'},
  },
};

const BLOODLINE_ATTRIBUTE = {
  ...GROWTH_ATTRIBUTE,
  required: [...GROWTH_ATTRIBUTE.required, 'value_pointer', 'blood_skill_id'],
  properties: {
    ...GROWTH_ATTRIBUTE.properties,
    value_pointer: {type: 'string', nullable: true},
    blood_skill_id: {type: 'string', pattern: '^skill_[0-9]{6}$', nullable: true},
  },
};

const STATS = {
  type: 'object',
  additionalProperties: false,
  required: ['hp', 'atk', 'def', 'spa', 'spd', 'spe'],
  properties: {
    hp: {type: 'integer', minimum: 1},
    atk: {type: 'integer', minimum: 1},
    def: {type: 'integer', minimum: 1},
    spa: {type: 'integer', minimum: 1},
    spd: {type: 'integer', minimum: 1},
    spe: {type: 'integer', minimum: 1},
  },
};

const SKILLS_SOURCE = {
  type: 'object',
  additionalProperties: false,
  required: ['artifact_path', 'artifact_sha256', 'pointer'],
  properties: {
    artifact_path: {type: 'string', minLength: 1},
    artifact_sha256: {type: 'string', pattern: '^[0-9a-f]{64}$'},
    pointer: {type: 'string', minLength: 1},
  },
};

const OWNED_PET = {
  type: 'object',
  additionalProperties: false,
  required: [
    'instance_id', 'species_id', 'species_name', 'species_tier', 'level',
    'nature', 'talent', 'specialty', 'bloodline', 'skills', 'skills_source',
    'base_stats', 'panel_stats', 'source', 'favourite', 'locked',
    'provenance', 'licence_ref', 'unknown_fields', 'build_hash',
  ],
  properties: {
    instance_id: {type: 'string', pattern: '^own-[0-9]{4}$'},
    species_id: {type: 'string', pattern: '^pet_[0-9]{6}$'},
    species_name: {type: 'string', minLength: 1},
    species_tier: {type: 'string', enum: ['baseline', 'overlay']},
    level: {type: 'integer', minimum: 1, maximum: 100},
    nature: GROWTH_ATTRIBUTE,
    talent: GROWTH_ATTRIBUTE,
    specialty: GROWTH_ATTRIBUTE,
    bloodline: BLOODLINE_ATTRIBUTE,
    skills: {type: 'array', items: {type: 'string', pattern: '^skill_[0-9]{6}$'}, minItems: 4, maxItems: 4, uniqueItems: true},
    skills_source: SKILLS_SOURCE,
    base_stats: STATS,
    panel_stats: {type: 'null', nullable: true},
    source: {type: 'string', const: SOURCE_MODE},
    favourite: {type: 'boolean'},
    locked: {type: 'boolean'},
    provenance: {type: 'array', items: PROVENANCE_ENTRY, minItems: 1},
    licence_ref: {type: 'string', minLength: 1},
    unknown_fields: {type: 'array', items: {type: 'string'}},
    build_hash: {type: 'string', pattern: '^[0-9a-f]{64}$'},
  },
};

const BATTLE_BUILD = {
  type: 'object',
  additionalProperties: false,
  required: [
    'build_id', 'owned_pet_instance_id', 'species_id', 'effective_form', 'form_sources',
    'ordered_skills', 'effective_bloodline', 'derived_stats', 'derived_stats_confidence',
    'ruleset_id', 'unknown_fields', 'build_hash',
  ],
  properties: {
    build_id: {type: 'string', pattern: '^build-own-[0-9]{4}$'},
    owned_pet_instance_id: {type: 'string', pattern: '^own-[0-9]{4}$'},
    species_id: {type: 'string', pattern: '^pet_[0-9]{6}$'},
    effective_form: {type: 'string', minLength: 1},
    form_sources: {type: 'array', items: PROVENANCE_ENTRY, minItems: 1},
    ordered_skills: {
      type: 'array',
      items: {type: 'string', pattern: '^skill_[0-9]{6}$'},
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
    },
    effective_bloodline: BLOODLINE_ATTRIBUTE,
    derived_stats: {type: 'null', nullable: true},
    derived_stats_confidence: {type: 'string', const: 'UNKNOWN'},
    ruleset_id: {type: 'string', const: RULESET_ID},
    unknown_fields: {type: 'array', items: {type: 'string'}},
    build_hash: {type: 'string', pattern: '^[0-9a-f]{64}$'},
  },
};

const COUNTS = {
  type: 'object',
  additionalProperties: false,
  required: [
    'instances', 'species', 'species_in_layer_playable_48', 'species_outside_layer_playable_48',
    'same_species_groups', 'same_species_groups_with_difference', 'battle_builds', 'skills_referenced',
  ],
  properties: {
    instances: {type: 'integer', minimum: 0},
    species: {type: 'integer', minimum: 0},
    species_in_layer_playable_48: {type: 'integer', minimum: 0},
    species_outside_layer_playable_48: {type: 'integer', minimum: 0},
    same_species_groups: {type: 'integer', minimum: 0},
    same_species_groups_with_difference: {type: 'integer', minimum: 0},
    battle_builds: {type: 'integer', minimum: 0},
    skills_referenced: {type: 'integer', minimum: 0},
  },
};

const DATASET = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version', 'ruleset_id', 'game', 'generated_by', 'generated_at', 'clock_fields',
    'seed', 'source', 'licence_ref', 'unknown_fields_allowlist', 'counts',
    'candidate_universe', 'skips', 'growth_attribute_policy', 'provenance',
    'instances', 'battle_builds', 'dataset_hash',
  ],
  properties: {
    schema_version: {type: 'string', const: 'roco-owned-pets/v1'},
    ruleset_id: {type: 'string', const: RULESET_ID},
    game: {type: 'string', const: GAME},
    generated_by: {type: 'string', const: 'scripts/roco/build-owned-pets.mjs'},
    generated_at: {type: 'string', const: GENERATED_AT},
    clock_fields: {type: 'array', items: {type: 'string'}, maxItems: 0},
    seed: {type: 'integer', const: SEED},
    source: {type: 'string', const: SOURCE_MODE},
    licence_ref: {type: 'string', minLength: 1},
    unknown_fields_allowlist: {type: 'array', items: {type: 'string'}},
    counts: COUNTS,
    candidate_universe: {type: 'object', additionalProperties: true, required: ['pack_pet_entities', 'with_frozen_learnset']},
    skips: {type: 'object', additionalProperties: true, required: ['no_frozen_learnset', 'insufficient_learnable_skills']},
    growth_attribute_policy: {type: 'object', additionalProperties: true, required: ['effect', 'reason']},
    provenance: {type: 'array', items: PROVENANCE_ENTRY, minItems: 1},
    instances: {type: 'array', items: OWNED_PET, minItems: INSTANCE_TARGET},
    battle_builds: {type: 'array', items: BATTLE_BUILD, minItems: INSTANCE_TARGET},
    dataset_hash: {type: 'string', pattern: '^[0-9a-f]{64}$'},
  },
};

/**
 * schema.json 的内容。**这是契约**：verify-owned-pets.mjs 用同一函数重建，
 * 与磁盘逐字节比对；磁盘上的契约不许悄悄漂移。
 */
export function buildOwnedPetSchema() {
  return {
    schema_version: 'roco-owned-pets-schema/v1',
    ruleset_id: RULESET_ID,
    game: GAME,
    generated_by: 'scripts/roco/build-owned-pets.mjs',
    generator_version: 'rc203-owned-pets/1',
    note: [
      '这是 OwnedPet / BattleBuild 的**自描述**契约，不是装饰：build-owned-pets.mjs 按它产出，',
      'verify-owned-pets.mjs 用同一个 buildOwnedPetSchema() 重建并与磁盘逐字节比对。',
      '养成属性（nature/talent/specialty/bloodline）只存**标签**：effect 恒为 UNKNOWN，',
      'reason 恒为「面板换算公式未校准（见 10 号文档 §13）」，microcase_id 恒为 null。',
      '本仓没有任何一处声称知道这些标签换算成面板数值的公式。',
    ],
    contracts: {
      OwnedPetDataset: DATASET,
      OwnedPet: OWNED_PET,
      BattleBuild: BATTLE_BUILD,
      GrowthAttribute: GROWTH_ATTRIBUTE,
      BloodlineAttribute: BLOODLINE_ATTRIBUTE,
      ProvenanceEntry: PROVENANCE_ENTRY,
      StatVector: STATS,
      Counts: COUNTS,
    },
    policies: {
      unknown_fields_rule: [
        'unknown_fields 必须**恰好等于**按实例本身重算出来的集合：',
        '① 顶层字段值为 null；② 顶层字段是养成属性且 value === null。',
        '反向也判红：把有值的字段塞进 unknown_fields（例如 level）同样不允许。',
      ],
      growth_effect_rule: [
        'effect 只能是 "UNKNOWN"，或者一个在 GROWTH_EFFECT_EVIDENCE_IDS 里能查到的证据 id'
          + '（本仓该白名单当前为空，所以任何非 UNKNOWN 的 effect 都会红）。',
        '禁止出现 formula / multiplier / modifier / percent / ratio / coefficient / bonus 这类被发明的字段。',
      ],
      forbidden_growth_field_pattern: FORBIDDEN_GROWTH_FIELD_PATTERN,
      determinism_rule: [
        '固定 seed=20301；除了由 ruleset_id 推导的 generated_at 之外没有任何挂钟字段（clock_fields 恒为空）。',
        '同输入两次运行逐字节相同；build-owned-pets.mjs --check 逐字节比对，不做任何字段豁免。',
      ],
      learnset_rule: [
        '四个技能必须逐个属于该 species 在冻结目录 learnsets.json 里的 native_skills。',
        '凑不出四个技能（或任何技能查不到）的精灵一律跳过，不补、不改、不猜。',
      ],
      layer_rule: [
        'layer-playable-48 目录（36 只 overlay）只是迁移夹具的一层；',
        'baseline 层（主 learnsets.json 的 12 只）在该目录之外，判据要求这类 species 至少 12 个。',
      ],
      battle_build_rule: [
        'ordered_skills 是**有序**数组，必须与 OwnedPet.skills 逐位相同（顺序敏感）。',
        'derived_stats 恒为 null：面板换算未校准，所以不给数。',
      ],
    },
    x_roco_contract: {
      instance_target: INSTANCE_TARGET,
      min_species: MIN_SPECIES,
      min_outside_layer_playable_48: MIN_OUTSIDE_LAYER,
      min_same_species_groups: MIN_SAME_SPECIES_GROUPS,
      seed: SEED,
    },
  };
}

// ── 由 schema 驱动的通用结构校验 ────────────────────────────────────────────

function typeMatches(value, type) {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

/**
 * schema 是契约：这里按 schema 里写的 type/required/nullable/enum/pattern/长度/唯一性逐条核。
 * 加字段必须同时改 schema —— 改完这里自动生效，不会出现「契约写了但没人查」。
 *
 * @returns {string[]} 逐条问题（空数组=通过）
 */
export function validateAgainstContract(value, spec, path = '$', problems = []) {
  if (!spec || typeof spec !== 'object') return problems;
  if (value === undefined) {
    problems.push(`${path} 缺失（契约 required）`);
    return problems;
  }
  if (value === null) {
    if (spec.nullable || spec.type === 'null') return problems;
    problems.push(`${path} 为 null，但契约不允许 null（type=${show(spec.type)}）`);
    return problems;
  }
  const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    problems.push(`${path} 类型不符：实际 ${show(value)}，契约要求 ${types.join('|')}`);
    return problems;
  }
  if (spec.const !== undefined && !deepEqual(value, spec.const)) {
    problems.push(`${path} 必须恒为 ${show(spec.const)}，实际 ${show(value)}`);
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((item) => deepEqual(item, value))) {
    problems.push(`${path}=${show(value)} 不在 enum ${JSON.stringify(spec.enum)} 里`);
  }
  if (typeof value === 'string') {
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${path}=${show(value)} 不匹配 pattern ${spec.pattern}`);
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      problems.push(`${path} 长度 ${value.length} < minLength ${spec.minLength}`);
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      problems.push(`${path} 长度 ${value.length} > maxLength ${spec.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) problems.push(`${path}=${value} < minimum ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${path}=${value} > maximum ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      problems.push(`${path} 只有 ${value.length} 项 < minItems ${spec.minItems}`);
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      problems.push(`${path} 有 ${value.length} 项 > maxItems ${spec.maxItems}`);
    }
    if (spec.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) problems.push(`${path} 有重复项 ${show(item)}`);
        seen.add(key);
      }
    }
    if (spec.items) value.forEach((item, i) => validateAgainstContract(item, spec.items, `${path}[${i}]`, problems));
  }
  if (typeMatches(value, 'object')) {
    for (const field of spec.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) problems.push(`${path}.${field} 缺失（契约 required）`);
    }
    const properties = spec.properties ?? {};
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          problems.push(`${path}.${key} 是契约外的字段（additionalProperties=false）`);
        }
      }
    }
    for (const [key, childSpec] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateAgainstContract(value[key], childSpec, `${path}.${key}`, problems);
      }
    }
  }
  return problems;
}
