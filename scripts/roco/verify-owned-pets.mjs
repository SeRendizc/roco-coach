#!/usr/bin/env node
// ── RC-203：OwnedPet / BattleBuild 校验器（fail closed，逐条说出「哪个实例哪个字段」）──
//
// 为什么判据单独成一份、而不是塞在生成器里：生成器与校验器各写一遍判据，
// 两份就会各自漂移，最后谁也不知道哪份算数。所以这里只有**一份**判据：
//   · 生成器（build-owned-pets.mjs）写盘前调用同一个 `runChecks`；
//   · 独立验收（tests/roco-owned-pets.test.js）也调用同一个 `runChecks`；
//   · 本 CLI 把结果写成 reports/roco/flagship-upgrade/rc-203-owned-pets.json。
//
// 判据（任一条不过 rc=1；每条都指名 instance_id / species_id / field）：
//   ① schema 合规：产物必须过 schema.json 声明的类型/必填/可空/enum/pattern/长度/唯一性，
//      且**磁盘上的 schema.json 与「现在重建」逐字节相同**（契约不许悄悄漂移）；
//   ② species 存在：species_id 必须在冻结目录 full-catalog.json **或** pack 的 pet 实体里，
//      且 species_name 与冻结目录里的名字逐字相同；
//   ③ 宇宙判据：≥80 实例、≥40 species、≥12 个 species **不在** layer-playable-48 里、
//      ≥20 组同种不同个体（且每组至少一项个体属性不同）；
//   ④ 技能来自 learnsets：四个技能**逐个**属于该 species 在该 learnsets.json 里的
//      native_skills，且四个技能都在全量 skills.json 里；
//   ⑤ 技能有序：`skills` 是数组、恰好 4 个、无重复，且 BattleBuild.ordered_skills
//      与之**逐位相同**（顺序敏感，不是集合相等）；
//   ⑥ instance_id 唯一、格式 own-NNNN、从 own-0001 起连续；
//   ⑦ 养成属性不许有公式：effect 必须是 UNKNOWN（或能在 evidence 索引里查到的 id）、
//      effect_reason 必须逐字等于 §13 那句话、microcase_id 必须是 null，
//      且属性对象里不许出现 formula/multiplier/modifier/percent/ratio/bonus 这类字段；
//   ⑧ unknown_fields 双向判红：有值却标 unknown → 红；该标没标 → 红；
//   ⑨ provenance 的 artifact_path 与 artifact_sha256 **真的对得上磁盘**，pointer 可解析；
//   ⑩ licence_ref 在 pack 的 source_registry 或 data/roco/sources.yaml 里找得到；
//   ⑪ build_hash / dataset_hash 可重算一致（产物被手改即红）；
//   ⑫ BattleBuild 与 OwnedPet 一一对应、derived_stats 恒为 null、置信度恒为 UNKNOWN；
//   ⑬ base_stats 与 provenance 指到的那份冻结产物里的 stats 逐字段相同；
//   ⑭ 确定性声明：generated_at 由 ruleset 推导、clock_fields 为空、全树没有挂钟字段；
//   ⑯ counts 声明与实际重算一致。
//
// 用法：
//   node scripts/roco/verify-owned-pets.mjs               # 校验（rc=0/1）
//   node scripts/roco/verify-owned-pets.mjs --json        # 额外把结果打到 stdout
//   node scripts/roco/verify-owned-pets.mjs --selftest    # 12 条注入反证，判据必须翻红
//   node scripts/roco/verify-owned-pets.mjs --selftest --json

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  CLOCK_FIELDS,
  FROZEN_FULL_CATALOG,
  FROZEN_IMPORT_REPORT,
  FROZEN_LAYER_LEARNSETS,
  FROZEN_LAYER_PETS,
  FROZEN_LAYER_SUPPORT,
  FROZEN_MAIN_LEARNSETS,
  FROZEN_SKILLS,
  FORBIDDEN_GROWTH_FIELD_PATTERN,
  GENERATED_AT,
  GROWTH_ATTRIBUTE_FIELDS,
  GROWTH_EFFECT_EVIDENCE_IDS,
  GROWTH_EFFECT_REASON,
  INSTANCE_TARGET,
  MIN_OUTSIDE_LAYER,
  MIN_SAME_SPECIES_GROUPS,
  MIN_SPECIES,
  OWNED_PETS_PATH,
  OWNED_SCHEMA_PATH,
  PACK_PATH,
  SOURCES_PATH,
  WALL_CLOCK_KEY_PATTERN,
  battleBuildHash,
  buildOwnedPetSchema,
  canonicalJson,
  datasetHash,
  deepClone,
  deepEqual,
  expectedBattleBuildUnknownFields,
  expectedInstanceUnknownFields,
  instanceBuildHash,
  isGrowthAttribute,
  resignDataset,
  sha256Hex,
  validateAgainstContract,
} from './owned-pets-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 判据分组名：报告里逐组给出 ok/problems，缺一组就等于「这条判据不存在」。 */
export const CHECK_NAMES = Object.freeze([
  'schema_compliance',
  'schema_file',
  'species_existence',
  'species_universe',
  'learnset_membership',
  'skill_order',
  'instance_identity',
  'growth_attributes',
  'unknown_fields',
  'provenance_on_disk',
  'licence_refs',
  'build_hashes',
  'battle_builds',
  'base_stats_pointers',
  'determinism_declaration',
  'declared_counts',
]);

/**
 * 判据文本 + 期望值 + 实际值口径：报告里逐条贴出来，免得「判据通过」和「没有这条判据」分不清。
 * `check` 指向 CHECK_NAMES 里的分组名，`actual` 是一个从 facts 里取实际值的纯函数。
 */
export const CRITERIA = Object.freeze([
  {id: 'C01', check: 'schema_file', text: '磁盘 schema.json 与「现在重建」逐字节相同', expected: 'byte-identical', actual: (f) => (f.schemaOnDiskOk ? 'byte-identical' : 'DIFFERENT')},
  {id: 'C02', check: 'schema_compliance', text: '每个 OwnedPet / BattleBuild / 顶层字段都过 schema 声明的类型与必填', expected: '0 违规', actual: (f) => `结构违规 ${f.schemaStructureProblems} 条`},
  {id: 'C03', check: 'species_existence', text: 'species_id 在冻结 full-catalog 或 pack 的 pet 实体里真实存在，且 species_name 逐字相同', expected: '0 违规', actual: (f) => `违规 ${f.speciesExistenceViolations} 条`},
  {id: 'C04', check: 'species_universe', text: `实例数 >= ${INSTANCE_TARGET}`, expected: `>= ${INSTANCE_TARGET}`, actual: (f) => String(f.instances)},
  {id: 'C05', check: 'species_universe', text: `不同 species_id 数 >= ${MIN_SPECIES}`, expected: `>= ${MIN_SPECIES}`, actual: (f) => String(f.species)},
  {id: 'C06', check: 'species_universe', text: `不在 layer-playable-48 里的 species 数 >= ${MIN_OUTSIDE_LAYER}`, expected: `>= ${MIN_OUTSIDE_LAYER}`, actual: (f) => String(f.speciesOutsideLayerPlayable48)},
  {id: 'C07', check: 'species_universe', text: `同种不同个体组数 >= ${MIN_SAME_SPECIES_GROUPS}（每组至少一项个体属性不同）`, expected: `>= ${MIN_SAME_SPECIES_GROUPS}`, actual: (f) => `${f.sameSpeciesGroups}（其中有差异 ${f.sameSpeciesGroupsWithDifference}）`},
  {id: 'C08', check: 'learnset_membership', text: '四个技能逐个属于该 species 的 learnsets.json native_skills（习得等级 <= 实例等级），且都在 skills.json 里', expected: '0 违规', actual: (f) => `违规 ${f.learnsetViolations} 条，引用技能 ${f.skillsReferenced} 个`},
  {id: 'C09', check: 'skill_order', text: 'skills 是有序数组：恰好 4 个、无重复，且 BattleBuild.ordered_skills 逐位相同', expected: '0 违规', actual: (f) => `顺序违规 ${f.skillOrderViolations} 条`},
  {id: 'C10', check: 'instance_identity', text: 'instance_id 唯一、形如 own-NNNN、从 own-0001 起连续', expected: '0 违规', actual: (f) => `违规 ${f.instanceIdentityViolations} 条`},
  {id: 'C11', check: 'growth_attributes', text: `养成属性 effect 只能是 UNKNOWN / 证据 id，reason 逐字为 §13 那句，microcase_id 为 null，且无公式字段（禁 ${FORBIDDEN_GROWTH_FIELD_PATTERN}）`, expected: '0 违规', actual: (f) => `违规 ${f.growthAttributeViolations} 条`},
  {id: 'C12', check: 'unknown_fields', text: 'unknown_fields 与「确实不可得」双向一致（有值却标 unknown / 该标没标 都红）', expected: '0 违规', actual: (f) => `违规 ${f.unknownFieldViolations} 条`},
  {id: 'C13', check: 'provenance_on_disk', text: 'provenance 的 artifact_path 存在且 artifact_sha256 与磁盘一致、pointer 可解析', expected: '0 失配', actual: (f) => `条目 ${f.provenanceEntries}，sha 失配 ${f.provenanceMismatches}，pointer 失配 ${f.pointerMismatches}`},
  {id: 'C14', check: 'licence_refs', text: 'licence_ref 在 pack.source_registry 或 data/roco/sources.yaml 里找得到', expected: '0 未解析', actual: (f) => `未解析 ${f.licenceRefUnresolved} 条`},
  {id: 'C15', check: 'build_hashes', text: 'instance/build/dataset 三级 build_hash 可重算一致', expected: '0 失配', actual: (f) => `失配 ${f.hashMismatches} 条`},
  {id: 'C16', check: 'battle_builds', text: 'BattleBuild 与 OwnedPet 一一对应，derived_stats=null，derived_stats_confidence=UNKNOWN', expected: '0 违规', actual: (f) => `battle_builds=${f.battleBuilds}，违规 ${f.battleBuildViolations} 条`},
  {id: 'C17', check: 'base_stats_pointers', text: 'base_stats 与 provenance 指向的冻结 full-catalog stats 逐字段相同', expected: '0 失配', actual: (f) => `失配 ${f.baseStatsMismatches} 条`},
  {id: 'C18', check: 'determinism_declaration', text: '确定性：generated_at 由 ruleset 推导、clock_fields 为空、全树无挂钟字段', expected: '0 挂钟字段', actual: (f) => `挂钟字段 ${f.wallClockFields} 个`},
  {id: 'C19', check: 'declared_counts', text: 'counts 声明与实际重算一致', expected: '0 漂移', actual: (f) => `漂移 ${f.countsDrift} 条`},
]);

/** 把判据文本 + 实际值 + 是否通过组装成报告里那一节。 */
export function criteriaReport(facts) {
  return CRITERIA.map((criterion) => ({
    id: criterion.id,
    check: criterion.check,
    text: criterion.text,
    expected: criterion.expected,
    actual: criterion.actual(facts),
  }));
}

// ── 磁盘读取缓存（一次 runChecks 一份；反证可复用同一份） ────────────────────

export function createCaches() {
  return {files: new Map(), json: new Map(), sha: new Map()};
}

function fileOf(store, root, path) {
  if (!store.files.has(path)) {
    const absolute = join(root, path);
    store.files.set(path, existsSync(absolute) && statSync(absolute).isFile()
      ? {exists: true, bytes: readFileSync(absolute), absolute}
      : {exists: false, bytes: null, absolute});
  }
  return store.files.get(path);
}

function shaOf(store, root, path) {
  if (!store.sha.has(path)) {
    const file = fileOf(store, root, path);
    store.sha.set(path, file.exists ? createHash('sha256').update(file.bytes).digest('hex') : null);
  }
  return store.sha.get(path);
}

function jsonOf(store, root, path) {
  if (!store.json.has(path)) {
    const file = fileOf(store, root, path);
    let parsed = null;
    if (file.exists) {
      try {
        parsed = JSON.parse(file.bytes.toString('utf8'));
      } catch {
        parsed = null;
      }
    }
    store.json.set(path, parsed);
  }
  return store.json.get(path);
}

/** JSON pointer：只支持本产物用到的两种写法（`.` 与 `[i]`）。 */
export function resolvePointer(doc, pointer) {
  const tokens = String(pointer).replace(/\[(\d+)\]/g, '.$1').split('.').filter((t) => t !== '');
  let cursor = doc;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return {found: false, value: undefined};
    cursor = cursor[token];
  }
  return {found: cursor !== undefined, value: cursor};
}

/** artifact_path 必须是仓库内的相对路径：绝对路径与 `..` 一律判红。 */
function isSafeArtifactPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..');
}

// ── 冻结目录的只读装载 ──────────────────────────────────────────────────────

export function loadFrozen(root, store) {
  const mainLearnsets = jsonOf(store, root, FROZEN_MAIN_LEARNSETS);
  const layerLearnsets = jsonOf(store, root, FROZEN_LAYER_LEARNSETS);
  const layerPets = jsonOf(store, root, FROZEN_LAYER_PETS);
  const layerSupport = jsonOf(store, root, FROZEN_LAYER_SUPPORT);
  const fullCatalog = jsonOf(store, root, FROZEN_FULL_CATALOG);
  const skillsDoc = jsonOf(store, root, FROZEN_SKILLS);
  const pack = jsonOf(store, root, PACK_PATH);
  const importReport = jsonOf(store, root, FROZEN_IMPORT_REPORT);

  const catalogById = new Map();
  (fullCatalog?.pets ?? []).forEach((pet, index) => catalogById.set(pet.pet_id, {pet, index}));

  const packEntities = (pack?.sections?.distributable?.entities ?? []).filter((e) => e.group === 'pet');
  const packById = new Map(packEntities.map((entity, index) => [entity.id, {entity, index}]));

  const layerPetIds = new Set([
    ...Object.keys(layerPets?.pets ?? {}),
    ...Object.keys(layerLearnsets?.learnsets ?? {}),
    ...Object.keys(layerSupport?.pets ?? {}),
  ]);

  const skillIds = new Set(Object.keys(skillsDoc?.skills ?? {}));

  return {
    mainLearnsets,
    layerLearnsets,
    layerPets,
    layerSupport,
    fullCatalog,
    skillsDoc,
    pack,
    importReport,
    catalogById,
    packById,
    packPetIds: new Set(packById.keys()),
    layerPetIds,
    skillIds,
    sha: {
      [FROZEN_MAIN_LEARNSETS]: shaOf(store, root, FROZEN_MAIN_LEARNSETS),
      [FROZEN_LAYER_LEARNSETS]: shaOf(store, root, FROZEN_LAYER_LEARNSETS),
      [FROZEN_FULL_CATALOG]: shaOf(store, root, FROZEN_FULL_CATALOG),
      [PACK_PATH]: shaOf(store, root, PACK_PATH),
    },
  };
}

/** 该 species 的 learnset 出处：baseline 用主 learnsets.json，overlay 用 layer 那份。 */
export function resolveLearnset(frozen, speciesId) {
  if (frozen.mainLearnsets?.learnsets?.[speciesId]) {
    return {artifact_path: FROZEN_MAIN_LEARNSETS, pointer: `learnsets.${speciesId}.native_skills`, entry: frozen.mainLearnsets.learnsets[speciesId]};
  }
  if (frozen.layerLearnsets?.learnsets?.[speciesId]) {
    return {artifact_path: FROZEN_LAYER_LEARNSETS, pointer: `learnsets.${speciesId}.native_skills`, entry: frozen.layerLearnsets.learnsets[speciesId]};
  }
  return null;
}

function resolvableLicenceRefs(frozen, store, root) {
  const refs = new Set();
  for (const entry of frozen.pack?.source_registry ?? []) {
    if (entry.licence_ref) refs.add(entry.licence_ref);
    if (entry.source_id) refs.add(entry.source_id);
  }
  // sources.yaml 是一个够用的 YAML 子集：这里只认 `- source_id: xxx` 那一行。
  const sourcesFile = fileOf(store, root, SOURCES_PATH);
  if (sourcesFile.exists) {
    for (const line of sourcesFile.bytes.toString('utf8').split('\n')) {
      const match = /^\s*-\s*source_id:\s*(.+?)\s*$/.exec(line);
      if (match) refs.add(match[1].replace(/^["']|["']$/g, ''));
    }
  }
  return refs;
}

// ── 主校验 ──────────────────────────────────────────────────────────────────

/**
 * 对一份 dataset（可以是内存副本）跑全部判据。
 *
 * @param {object} dataset  roco-owned-pets/v1 文档
 * @param {object} options
 * @param {string} options.root    仓库根（测试可换成只读副本）
 * @param {object} options.schema  契约（默认取磁盘，取不到就用 buildOwnedPetSchema()）
 * @param {object} options.caches  反证可复用同一份只读缓存
 * @returns {{ok: boolean, problems: string[], facts: object, checks: Array}}
 */
export function runChecks(dataset, {root = ROOT, schema = null, caches = null} = {}) {
  const problems = [];
  const facts = {
    instances: 0,
    species: 0,
    speciesInLayerPlayable48: 0,
    speciesOutsideLayerPlayable48: 0,
    sameSpeciesGroups: 0,
    sameSpeciesGroupsWithDifference: 0,
    battleBuilds: 0,
    skillsReferenced: 0,
    speciesExistenceViolations: 0,
    learnsetViolations: 0,
    skillOrderViolations: 0,
    instanceIdentityViolations: 0,
    growthAttributeViolations: 0,
    unknownFieldViolations: 0,
    provenanceEntries: 0,
    provenanceMismatches: 0,
    pointerMismatches: 0,
    licenceRefUnresolved: 0,
    hashMismatches: 0,
    battleBuildViolations: 0,
    baseStatsMismatches: 0,
    wallClockFields: 0,
    countsDrift: 0,
    schemaStructureProblems: 0,
    schemaOnDiskOk: true,
    outsideLayerSpecies: [],
    growthUnknownFields: [],
  };
  const checkProblems = new Map(CHECK_NAMES.map((name) => [name, []]));
  const add = (check, message) => {
    problems.push(`[${check}] ${message}`);
    if (!checkProblems.has(check)) checkProblems.set(check, []);
    checkProblems.get(check).push(message);
  };
  /** 每组判据都要在报告里出现（通过的也要出现，否则「没有这条判据」和「判据通过」分不清）。 */
  const collectChecks = () => [...checkProblems.entries()]
    .map(([check, list]) => ({check, ok: list.length === 0, problems: list.length}));

  const store = caches ?? createCaches();
  const builtSchema = buildOwnedPetSchema();
  const contract = schema ?? builtSchema;
  const frozen = loadFrozen(root, store);

  if (!dataset || typeof dataset !== 'object') {
    add('schema_compliance', '产物不是对象，无法校验');
    return {ok: false, problems, facts, checks: collectChecks()};
  }

  const instances = Array.isArray(dataset.instances) ? dataset.instances : [];
  const builds = Array.isArray(dataset.battle_builds) ? dataset.battle_builds : [];
  facts.instances = instances.length;
  facts.battleBuilds = builds.length;

  // ① schema 合规（类型 / 必填 / 可空 / enum / pattern / 长度 / 唯一性）
  const structural = validateAgainstContract(dataset, contract.contracts.OwnedPetDataset, 'dataset');
  facts.schemaStructureProblems = structural.length;
  for (const problem of structural) add('schema_compliance', problem);

  // ①b 契约文件本身不许漂移：磁盘上的 schema.json 必须与「现在重建」逐字节相同
  const schemaFile = fileOf(store, root, OWNED_SCHEMA_PATH);
  const builtSchemaText = `${JSON.stringify(builtSchema, null, 2)}\n`;
  if (!schemaFile.exists) {
    facts.schemaOnDiskOk = false;
    add('schema_file', `缺契约文件 ${OWNED_SCHEMA_PATH}：先跑 node scripts/roco/build-owned-pets.mjs`);
  } else if (schemaFile.bytes.toString('utf8') !== builtSchemaText) {
    facts.schemaOnDiskOk = false;
    add('schema_file', `磁盘上的 ${OWNED_SCHEMA_PATH} 与「现在重建」不同：契约漂移了（重建后 sha256=${sha256Hex(builtSchemaText).slice(0, 16)}…）`);
  }

  // ② species 存在 + 名字一致
  for (const instance of instances) {
    const id = instance?.instance_id ?? '(缺 instance_id)';
    const speciesId = instance?.species_id ?? null;
    if (speciesId === null) {
      add('species_existence', `${id} 没有 species_id`);
      facts.speciesExistenceViolations += 1;
      continue;
    }
    const inCatalog = frozen.catalogById.get(speciesId);
    const inPack = frozen.packById.get(speciesId);
    if (!inCatalog && !inPack) {
      add('species_existence', `${id} 的 species_id=${speciesId} 在冻结 full-catalog 与 pack 里都找不到`);
      facts.speciesExistenceViolations += 1;
      continue;
    }
    const truthName = inCatalog?.pet?.name ?? inPack?.entity?.name ?? null;
    if (truthName !== null && instance.species_name !== truthName) {
      add('species_existence', `${id} 的 species_name=${JSON.stringify(instance.species_name)}，冻结目录里 ${speciesId} 叫 ${JSON.stringify(truthName)}`);
      facts.speciesExistenceViolations += 1;
    }
  }

  // ③ 宇宙判据
  const bySpecies = new Map();
  for (const instance of instances) {
    const key = instance?.species_id ?? '(无)';
    if (!bySpecies.has(key)) bySpecies.set(key, []);
    bySpecies.get(key).push(instance);
  }
  facts.species = bySpecies.size;
  const outside = [...bySpecies.keys()].filter((id) => !frozen.layerPetIds.has(id)).sort();
  facts.speciesOutsideLayerPlayable48 = outside.length;
  facts.speciesInLayerPlayable48 = facts.species - outside.length;
  facts.outsideLayerSpecies = outside.map((id) => ({
    species_id: id,
    species_name: frozen.catalogById.get(id)?.pet?.name ?? frozen.packById.get(id)?.entity?.name ?? null,
    instances: bySpecies.get(id).map((instance) => instance.instance_id),
  }));

  if (instances.length < INSTANCE_TARGET) {
    add('species_universe', `实例只有 ${instances.length} 个 < ${INSTANCE_TARGET}`);
  }
  if (facts.species < MIN_SPECIES) {
    add('species_universe', `只跨了 ${facts.species} 个 species_id < ${MIN_SPECIES}`);
  }
  if (outside.length < MIN_OUTSIDE_LAYER) {
    add('species_universe', `不在 layer-playable-48 里的 species 只有 ${outside.length} 个 < ${MIN_OUTSIDE_LAYER}（逐只点名见报告）`);
  }
  for (const [speciesId, group] of bySpecies) {
    const expectTier = frozen.layerPetIds.has(speciesId) ? 'overlay' : 'baseline';
    for (const instance of group) {
      if (instance?.species_tier !== expectTier) {
        add('species_universe', `${instance?.instance_id} 声明 species_tier=${instance?.species_tier}，但按 layer-playable-48 重算应为 ${expectTier}`);
      }
      const resolved = resolveLearnset(frozen, speciesId);
      if (!resolved) continue;
      if (instance?.skills_source?.artifact_path !== resolved.artifact_path) {
        add('species_universe', `${instance?.instance_id} 的 skills_source.artifact_path=${instance?.skills_source?.artifact_path}，但 ${speciesId} 的 learnset 在 ${resolved.artifact_path}`);
      }
      if (instance?.skills_source?.pointer !== resolved.pointer) {
        add('species_universe', `${instance?.instance_id} 的 skills_source.pointer=${instance?.skills_source?.pointer}，应为 ${resolved.pointer}`);
      }
    }
  }

  // ③b 同种不同个体
  const sameSpeciesGroups = [];
  let withDifference = 0;
  for (const [speciesId, group] of [...bySpecies.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const other of rest) {
      const differing = [];
      const unknowns = [];
      for (const field of ['level', 'nature', 'talent', 'specialty', 'bloodline', 'skills']) {
        const av = GROWTH_ATTRIBUTE_FIELDS.includes(field) ? first?.[field]?.value ?? null : first?.[field] ?? null;
        const bv = GROWTH_ATTRIBUTE_FIELDS.includes(field) ? other?.[field]?.value ?? null : other?.[field] ?? null;
        if (av === null || bv === null) {
          unknowns.push(field);
          continue;
        }
        if (!deepEqual(av, bv)) differing.push(field);
      }
      if (differing.length > 0) withDifference += 1;
      sameSpeciesGroups.push({
        species_id: speciesId,
        species_name: first?.species_name ?? null,
        instances: [first?.instance_id, other?.instance_id],
        different_fields: differing,
        unknown_fields: unknowns,
      });
    }
  }
  facts.sameSpeciesGroups = sameSpeciesGroups.length;
  facts.sameSpeciesGroupsWithDifference = withDifference;
  if (sameSpeciesGroups.length < MIN_SAME_SPECIES_GROUPS) {
    add('species_universe', `同种个体组只有 ${sameSpeciesGroups.length} 组 < ${MIN_SAME_SPECIES_GROUPS}`);
  }
  if (withDifference < MIN_SAME_SPECIES_GROUPS) {
    add('species_universe', `其中「至少一项个体属性不同」的只有 ${withDifference} 组 < ${MIN_SAME_SPECIES_GROUPS}`);
  }
  facts.sameSpeciesGroupDetails = sameSpeciesGroups;

  // ④ + ⑤ 技能来自 learnsets / 有序
  const referencedSkills = new Set();
  for (const instance of instances) {
    const id = instance?.instance_id ?? '(缺 instance_id)';
    const speciesId = instance?.species_id ?? null;
    const skills = instance?.skills;
    if (!Array.isArray(skills)) {
      add('learnset_membership', `${id} 的 skills 不是数组（实际 ${typeof skills}）——有序技能位必须是有序数组`);
      continue;
    }
    if (skills.length !== 4) {
      add('learnset_membership', `${id} 的 skills 有 ${skills.length} 个（要求恰好 4 个）: ${JSON.stringify(skills)}`);
    }
    const resolved = speciesId ? resolveLearnset(frozen, speciesId) : null;
    if (!resolved) {
      add('learnset_membership', `${id} 的 species_id=${speciesId} 在冻结 learnsets.json 里没有条目——不能给这只配技能`);
      continue;
    }
    const learnable = new Set((resolved.entry.native_skills ?? []).map((s) => s.skill_id));
    // 习得等级一致性：技能在 native_skills 里的习得等级不能高于实例等级
    // （等级是 Demo 值，但「这个等级学不学得到这个技能」是冻结目录能回答的问题）。
    const learnLevel = new Map((resolved.entry.native_skills ?? []).map((s) => [s.skill_id, s.level]));
    for (const skill of skills) {
      referencedSkills.add(skill);
      const level = learnLevel.get(skill);
      if (typeof level === 'number' && typeof instance.level === 'number' && level > instance.level) {
        add('learnset_membership', `${id} 等级 ${instance.level}，但 ${skill} 要等级 ${level} 才学得到（${resolved.artifact_path}）`);
        facts.learnsetViolations += 1;
      }
      if (!learnable.has(skill)) {
        add('learnset_membership', `${id}（${speciesId}）的 ${skill} 不在该 species 的 ${resolved.artifact_path} native_skills 里`);
        facts.learnsetViolations += 1;
      }
      if (!frozen.skillIds.has(skill)) {
        add('learnset_membership', `${id} 的 ${skill} 在全量 skills.json 里不存在`);
        facts.learnsetViolations += 1;
      }
    }
    for (const [i, build] of builds.entries()) {
      if (build?.owned_pet_instance_id !== id) continue;
      const ordered = build?.ordered_skills;
      if (!Array.isArray(ordered) || ordered.length !== 4) {
        add('skill_order', `build ${build?.build_id ?? i} 的 ordered_skills 不是 4 项有序数组：${JSON.stringify(ordered)}`);
      } else if (ordered.some((skill, k) => skill !== skills[k])) {
        add('skill_order', `${id} 的 skills=${JSON.stringify(skills)}，但 battle_build.ordered_skills=${JSON.stringify(ordered)}——技能位顺序被改动了`);
        facts.skillOrderViolations += 1;
      }
    }
  }
  facts.skillsReferenced = referencedSkills.size;

  // ⑥ instance_id 唯一 / 连续
  const seenIds = new Set();
  for (const [index, instance] of instances.entries()) {
    const id = instance?.instance_id ?? '(缺)';
    if (seenIds.has(id)) {
      add('instance_identity', `instance_id=${id} 重复出现`);
      facts.instanceIdentityViolations += 1;
    }
    seenIds.add(id);
    const expected = `own-${String(index + 1).padStart(4, '0')}`;
    if (id !== expected) {
      add('instance_identity', `第 ${index + 1} 个实例的 instance_id=${id}，按顺序应为 ${expected}`);
      facts.instanceIdentityViolations += 1;
    }
  }

  // ⑦ + ⑧ 养成属性 / unknown_fields
  const declaredAllowlist = new Set(dataset.unknown_fields_allowlist ?? []);
  const growthUnknown = new Map();
  for (const instance of instances) {
    const id = instance?.instance_id ?? '(缺)';
    for (const field of GROWTH_ATTRIBUTE_FIELDS) {
      const attribute = instance?.[field];
      if (!isGrowthAttribute(attribute)) {
        add('growth_attributes', `${id}.${field} 不是养成属性对象（缺 effect / microcase_id）`);
        facts.growthAttributeViolations += 1;
        continue;
      }
      // 「effect 必须是 UNKNOWN 或带证据 id」：证据 id 必须在白名单里查得到。
      // 白名单当前为空（面板换算证据一条都没有），所以任何具体数值/臆造 id 都红。
      const isUnknown = attribute.effect === 'UNKNOWN';
      const isKnownEvidence = GROWTH_EFFECT_EVIDENCE_IDS.includes(attribute.effect);
      if (!isUnknown && !isKnownEvidence) {
        add('growth_attributes', `${id}.${field}.effect=${JSON.stringify(attribute.effect)} 既不是 UNKNOWN 也不在证据 id 白名单 ${JSON.stringify(GROWTH_EFFECT_EVIDENCE_IDS)} 里——这是被发明的养成公式`);
        facts.growthAttributeViolations += 1;
      }
      if (attribute.effect_reason !== GROWTH_EFFECT_REASON) {
        add('growth_attributes', `${id}.${field}.effect_reason=${JSON.stringify(attribute.effect_reason)}，必须逐字是 ${JSON.stringify(GROWTH_EFFECT_REASON)}`);
        facts.growthAttributeViolations += 1;
      }
      if (attribute.microcase_id !== null) {
        add('growth_attributes', `${id}.${field}.microcase_id=${JSON.stringify(attribute.microcase_id)}，未校准前必须是 null`);
        facts.growthAttributeViolations += 1;
      }
      if ((attribute.value === null) !== (attribute.value_source === null)) {
        add('growth_attributes', `${id}.${field} 的 value/value_source 不一致：value=${JSON.stringify(attribute.value)} value_source=${JSON.stringify(attribute.value_source)}`);
        facts.growthAttributeViolations += 1;
      }
      const forbidden = Object.keys(attribute).filter((key) => new RegExp(FORBIDDEN_GROWTH_FIELD_PATTERN, 'i').test(key));
      for (const key of forbidden) {
        add('growth_attributes', `${id}.${field} 出现了被发明的公式字段 ${key}`);
        facts.growthAttributeViolations += 1;
      }
      if (attribute.value === null) {
        if (!growthUnknown.has(field)) growthUnknown.set(field, {field, value: null, instances: 0, effect: attribute.effect});
        growthUnknown.get(field).instances += 1;
      }
    }

    const expectedUnknown = expectedInstanceUnknownFields(instance);
    const declaredUnknown = [...(instance?.unknown_fields ?? [])].sort();
    if (!deepEqual(expectedUnknown, declaredUnknown)) {
      const missing = expectedUnknown.filter((f) => !declaredUnknown.includes(f));
      const extra = declaredUnknown.filter((f) => !expectedUnknown.includes(f));
      if (missing.length) add('unknown_fields', `${id}.unknown_fields 漏报 ${JSON.stringify(missing)}（这些字段确实不可得）`);
      if (extra.length) add('unknown_fields', `${id}.unknown_fields 多报 ${JSON.stringify(extra)}（这些字段是有值的，不能标 unknown）`);
      facts.unknownFieldViolations += 1;
    }
    for (const field of declaredUnknown) {
      if (!declaredAllowlist.has(field)) {
        add('unknown_fields', `${id}.unknown_fields 里的 ${field} 不在 dataset.unknown_fields_allowlist 里`);
        facts.unknownFieldViolations += 1;
      }
    }
  }
  facts.growthUnknownFields = [...growthUnknown.values()].sort((a, b) => a.field.localeCompare(b.field));

  // ⑨ provenance 对得上磁盘 + pointer 可解析
  const checkProvenance = (entries, owner) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      add('provenance_on_disk', `${owner} 没有 provenance 条目`);
      facts.provenanceMismatches += 1;
      return;
    }
    for (const entry of entries) {
      facts.provenanceEntries += 1;
      if (!isSafeArtifactPath(entry?.artifact_path)) {
        add('provenance_on_disk', `${owner} 的 artifact_path=${JSON.stringify(entry?.artifact_path)} 不是仓库内相对路径`);
        facts.provenanceMismatches += 1;
        continue;
      }
      const file = fileOf(store, root, entry.artifact_path);
      if (!file.exists) {
        add('provenance_on_disk', `${owner} 的 artifact_path=${entry.artifact_path} 在磁盘上不存在`);
        facts.provenanceMismatches += 1;
        continue;
      }
      const actualSha = shaOf(store, root, entry.artifact_path);
      if (actualSha !== entry.artifact_sha256) {
        add('provenance_on_disk', `${owner} 的 ${entry.artifact_path} artifact_sha256=${entry.artifact_sha256}，磁盘实际=${actualSha}`);
        facts.provenanceMismatches += 1;
      }
      if (entry.pointer) {
        const doc = jsonOf(store, root, entry.artifact_path);
        const resolved = resolvePointer(doc, entry.pointer);
        if (!resolved.found) {
          add('provenance_on_disk', `${owner} 的 pointer=${entry.pointer} 在 ${entry.artifact_path} 里解析不到`);
          facts.pointerMismatches += 1;
        }
      }
    }
  };
  checkProvenance(dataset.provenance, 'dataset');
  for (const instance of instances) checkProvenance(instance?.provenance, instance?.instance_id ?? '(缺)');
  for (const build of builds) checkProvenance(build?.form_sources, build?.build_id ?? '(缺 build_id)');

  // ⑩ licence_ref
  const licenceRefs = resolvableLicenceRefs(frozen, store, root);
  const checkLicence = (value, owner) => {
    if (!licenceRefs.has(value)) {
      add('licence_refs', `${owner} 的 licence_ref=${JSON.stringify(value)} 在 pack.source_registry 与 data/roco/sources.yaml 里都找不到`);
      facts.licenceRefUnresolved += 1;
    }
  };
  checkLicence(dataset.licence_ref, 'dataset');
  for (const instance of instances) checkLicence(instance?.licence_ref, instance?.instance_id ?? '(缺)');

  // ⑪ build_hash
  for (const instance of instances) {
    const actual = instanceBuildHash(instance);
    if (actual !== instance?.build_hash) {
      add('build_hashes', `${instance?.instance_id} 的 build_hash=${instance?.build_hash}，重算=${actual}`);
      facts.hashMismatches += 1;
    }
  }
  for (const build of builds) {
    const actual = battleBuildHash(build);
    if (actual !== build?.build_hash) {
      add('build_hashes', `${build?.build_id} 的 build_hash=${build?.build_hash}，重算=${actual}`);
      facts.hashMismatches += 1;
    }
  }
  const actualDatasetHash = datasetHash(dataset);
  if (actualDatasetHash !== dataset.dataset_hash) {
    add('build_hashes', `dataset_hash=${dataset.dataset_hash}，重算=${actualDatasetHash}`);
    facts.hashMismatches += 1;
  }

  // ⑫ BattleBuild 一一对应
  if (builds.length !== instances.length) {
    add('battle_builds', `battle_builds 有 ${builds.length} 条，instances 有 ${instances.length} 条——必须一一对应`);
    facts.battleBuildViolations += 1;
  }
  const buildsByInstance = new Map(builds.map((build) => [build?.owned_pet_instance_id, build]));
  for (const instance of instances) {
    const id = instance?.instance_id;
    const build = buildsByInstance.get(id);
    if (!build) {
      add('battle_builds', `${id} 没有对应的 BattleBuild`);
      facts.battleBuildViolations += 1;
      continue;
    }
    if (build.build_id !== `build-${id}`) {
      add('battle_builds', `${id} 的 build_id=${build.build_id}，应为 build-${id}`);
      facts.battleBuildViolations += 1;
    }
    if (build.species_id !== instance.species_id) {
      add('battle_builds', `${build.build_id} 的 species_id=${build.species_id} 与实例的 ${instance.species_id} 不一致`);
      facts.battleBuildViolations += 1;
    }
    if (build.derived_stats !== null) {
      add('battle_builds', `${build.build_id}.derived_stats=${JSON.stringify(build.derived_stats)}，未校准前面板必须为 null`);
      facts.battleBuildViolations += 1;
    }
    if (build.derived_stats_confidence !== 'UNKNOWN') {
      add('battle_builds', `${build.build_id}.derived_stats_confidence=${JSON.stringify(build.derived_stats_confidence)}，必须是 UNKNOWN`);
      facts.battleBuildViolations += 1;
    }
    if (!deepEqual(build.effective_bloodline, instance.bloodline)) {
      add('battle_builds', `${build.build_id}.effective_bloodline 与实例 bloodline 不一致`);
      facts.battleBuildViolations += 1;
    }
    const expectedUnknown = expectedBattleBuildUnknownFields(build);
    if (!deepEqual(expectedUnknown, [...(build.unknown_fields ?? [])].sort())) {
      add('battle_builds', `${build.build_id}.unknown_fields=${JSON.stringify(build.unknown_fields)}，重算应为 ${JSON.stringify(expectedUnknown)}`);
      facts.battleBuildViolations += 1;
    }
    const structuralBuild = validateAgainstContract(build, contract.contracts.BattleBuild, `battle_builds[${id}]`);
    for (const problem of structuralBuild) add('battle_builds', problem);
  }

  // ⑬ base_stats 与冻结产物一致
  for (const instance of instances) {
    const id = instance?.instance_id ?? '(缺)';
    const statsEntry = (instance?.provenance ?? []).find((entry) => typeof entry?.pointer === 'string' && entry.pointer.endsWith('.stats'));
    if (!statsEntry) {
      add('base_stats_pointers', `${id} 的 provenance 里没有指向冻结 stats 的条目`);
      facts.baseStatsMismatches += 1;
      continue;
    }
    const doc = jsonOf(store, root, statsEntry.artifact_path);
    const resolved = resolvePointer(doc, statsEntry.pointer);
    if (!resolved.found) {
      add('base_stats_pointers', `${id} 的 stats pointer=${statsEntry.pointer} 解析不到`);
      facts.baseStatsMismatches += 1;
      continue;
    }
    if (!deepEqual(resolved.value, instance.base_stats)) {
      add('base_stats_pointers', `${id} 的 base_stats=${canonicalJson(instance.base_stats)}，冻结目录 ${statsEntry.pointer}=${canonicalJson(resolved.value)}`);
      facts.baseStatsMismatches += 1;
    }
  }

  // ⑭ 确定性声明
  if (!deepEqual(dataset.clock_fields, [...CLOCK_FIELDS])) {
    add('determinism_declaration', `clock_fields=${JSON.stringify(dataset.clock_fields)}，本产物应为空数组`);
    facts.wallClockFields += 1;
  }
  if (dataset.generated_at !== GENERATED_AT) {
    add('determinism_declaration', `generated_at=${JSON.stringify(dataset.generated_at)}，应由 ruleset_id 推导为 ${JSON.stringify(GENERATED_AT)}（本产物没有任何挂钟字段）`);
    facts.wallClockFields += 1;
  }
  const scanWallClock = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => scanWallClock(item, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (WALL_CLOCK_KEY_PATTERN.test(key)) {
        add('determinism_declaration', `${path}.${key} 像是挂钟字段（只允许由 ruleset 推导的 generated_at）`);
        facts.wallClockFields += 1;
      }
      scanWallClock(child, `${path}.${key}`);
    }
  };
  scanWallClock(dataset, 'dataset');

  // ⑯ counts 声明一致
  const recomputedCounts = {
    instances: instances.length,
    species: facts.species,
    species_in_layer_playable_48: facts.speciesInLayerPlayable48,
    species_outside_layer_playable_48: facts.speciesOutsideLayerPlayable48,
    same_species_groups: facts.sameSpeciesGroups,
    same_species_groups_with_difference: facts.sameSpeciesGroupsWithDifference,
    battle_builds: builds.length,
    skills_referenced: facts.skillsReferenced,
  };
  facts.recomputedCounts = recomputedCounts;
  for (const [key, value] of Object.entries(recomputedCounts)) {
    if (dataset?.counts?.[key] !== value) {
      add('declared_counts', `counts.${key} 声明为 ${JSON.stringify(dataset?.counts?.[key])}，实际重算 ${value}`);
      facts.countsDrift += 1;
    }
  }

  return {ok: problems.length === 0, problems, facts, checks: collectChecks()};
}

// ── 必红反证（--selftest 与单元测试共用同一批） ──────────────────────────────

/**
 * 每条反证都写明「期望哪一组判据翻红」。--selftest 会逐条跑，并把实际输出原文打出来：
 * 反证如果**没**翻红，就是判据失效，直接算失败（不许「反证通过」这种话说反）。
 */
export const SELFTEST_MUTATIONS = Object.freeze([
  {
    id: 'R01',
    title: '抽掉一个实例的 provenance',
    expect: 'provenance_on_disk',
    apply: (dataset) => {
      dataset.instances[0].provenance = [];
    },
  },
  {
    id: 'R02',
    title: '把 artifact_sha256 改成与磁盘不符',
    expect: 'provenance_on_disk',
    apply: (dataset) => {
      dataset.instances[1].provenance[0].artifact_sha256 = '0'.repeat(64);
    },
  },
  {
    id: 'R03',
    title: '把一个技能换成该精灵学不到的技能（全量 skills.json 里真实存在，但不在该 species 的 learnset 里）',
    expect: 'learnset_membership',
    apply: (dataset, ctx) => {
      const instance = dataset.instances[2];
      const build = dataset.battle_builds[2];
      const resolved = resolveLearnset(ctx.frozen, instance.species_id);
      const learnable = new Set((resolved?.entry?.native_skills ?? []).map((skill) => skill.skill_id));
      // 从**全量 skills.json** 里挑一个真实存在、但这只学不到的技能：这样反证证明的是
      // 「learnset 成员资格」这条判据，而不是「技能 id 存不存在」。
      const foreign = [...ctx.frozen.skillIds].sort().find((skill) => !learnable.has(skill));
      if (!foreign) throw new Error('反证 R03 失败：找不到任何该 species 学不到的真实技能');
      instance.skills[0] = foreign;
      build.ordered_skills = [...instance.skills];
    },
  },
  {
    id: 'R04',
    title: '把四个技能改成三个',
    expect: 'learnset_membership',
    apply: (dataset) => {
      const instance = dataset.instances[3];
      const build = dataset.battle_builds[3];
      instance.skills = instance.skills.slice(0, 3);
      build.ordered_skills = [...instance.skills];
    },
  },
  {
    id: 'R05',
    title: '把某只的 species_id 改成不存在的',
    expect: 'species_existence',
    apply: (dataset) => {
      dataset.instances[4].species_id = 'pet_999999';
    },
  },
  {
    id: 'R06',
    title: '给 nature.effect 填一个具体数值（发明公式）',
    expect: 'growth_attributes',
    apply: (dataset) => {
      dataset.instances[5].nature.effect = 0.2;
    },
  },
  {
    id: 'R07',
    title: '实例降到 79 个',
    expect: 'species_universe',
    apply: (dataset) => {
      const dropped = dataset.instances.pop();
      dataset.battle_builds = dataset.battle_builds.filter((build) => build.owned_pet_instance_id !== dropped.instance_id);
    },
  },
  {
    id: 'R08',
    title: '把有值的字段塞进 unknown_fields（level）',
    expect: 'unknown_fields',
    apply: (dataset) => {
      dataset.instances[6].unknown_fields = [...dataset.instances[6].unknown_fields, 'level'].sort();
    },
  },
  {
    id: 'R09',
    title: '把 BattleBuild 的技能位顺序反转',
    expect: 'skill_order',
    apply: (dataset) => {
      const build = dataset.battle_builds[7];
      build.ordered_skills = [...build.ordered_skills].reverse();
    },
  },
  {
    id: 'R10',
    title: '把 licence_ref 改成查不到的来源',
    expect: 'licence_refs',
    apply: (dataset) => {
      dataset.instances[8].licence_ref = 'licence-not-registered-anywhere';
    },
  },
  {
    id: 'R11',
    title: '给养成属性加一个被发明的公式字段',
    expect: 'growth_attributes',
    apply: (dataset) => {
      dataset.instances[9].talent.formula = 'base * 1.1 + level * 2';
    },
  },
  {
    id: 'R13',
    title: '给 effect 编一个查不到的证据 id',
    expect: 'growth_attributes',
    apply: (dataset) => {
      dataset.instances[9].talent.effect = 'microcase:panel-formula-v1';
    },
  },
  {
    id: 'R12',
    title: '把 base_stats 改成与冻结目录不符',
    expect: 'base_stats_pointers',
    apply: (dataset) => {
      dataset.instances[10].base_stats.hp += 1;
    },
  },
]);

export function runSelftest(dataset, {root = ROOT, caches = null, onResult = null} = {}) {
  const store = caches ?? createCaches();
  const baseline = runChecks(dataset, {root, caches: store});
  const results = [];
  if (!baseline.ok) {
    return {
      ok: false,
      baseline,
      results: [{id: 'BASELINE', title: '未注入任何违规的基线必须通过', expect: '-', caught: false, problems: baseline.problems}],
      message: '基线产物本身就没过校验：先修产物，再谈反证',
    };
  }
  for (const mutation of SELFTEST_MUTATIONS) {
    const mutated = deepClone(dataset);
    // 反证需要冻结目录才能构造「真实存在但学不到」的技能，所以把 frozen 作为上下文传进去。
    const frozen = loadFrozen(root, store);
    mutation.apply(mutated, {frozen, resolveLearnset: (speciesId) => resolveLearnset(frozen, speciesId)});
    // 注入后重签哈希链：让每条反证的红色只来自它真正想证明的那一组判据。
    resignDataset(mutated);
    // 反证复用同一份**只读**磁盘缓存：既不改磁盘，也不会把校验拖慢 12 倍。
    const result = runChecks(mutated, {root, caches: store});
    const check = result.checks.find((entry) => entry.check === mutation.expect);
    const caught = !result.ok && Boolean(check && !check.ok);
    const entry = {
      id: mutation.id,
      title: mutation.title,
      expect: mutation.expect,
      caught,
      expectedCheckProblems: check ? check.problems : null,
      problems: result.problems.filter((problem) => problem.startsWith(`[${mutation.expect}]`)),
    };
    results.push(entry);
    if (onResult) onResult(entry);
  }
  return {ok: results.every((entry) => entry.caught), baseline, results, message: null};
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `用法：node scripts/roco/verify-owned-pets.mjs [--json] [--selftest]

  （无参数）  校验 ${OWNED_PETS_PATH}，rc=0/1
  --json      额外把结果打到 stdout
  --selftest  ${SELFTEST_MUTATIONS.length} 条注入反证：把产物改坏，对应判据必须翻红

退出码：0=全部判据通过；1=有判据不通过或反证没抓住；2=运行异常`;

function main(argv) {
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const store = createCaches();
  const datasetFile = fileOf(store, ROOT, OWNED_PETS_PATH);
  if (!datasetFile.exists) {
    process.stderr.write(`缺产物 ${OWNED_PETS_PATH}：先跑 node scripts/roco/build-owned-pets.mjs\n`);
    return 1;
  }
  const dataset = JSON.parse(datasetFile.bytes.toString('utf8'));
  const result = runChecks(dataset, {caches: store});

  process.stdout.write(`RC-203 OwnedPet 校验：${result.ok ? 'PASS' : 'FAIL'}\n`);
  for (const check of result.checks) {
    process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.check}${check.ok ? '' : `（${check.problems} 条）`}\n`);
  }
  const f = result.facts;
  process.stdout.write('实际值：\n');
  process.stdout.write(`  实例数=${f.instances} species 数=${f.species}`
    + `（layer-playable-48 内 ${f.speciesInLayerPlayable48} / 外 ${f.speciesOutsideLayerPlayable48}）`
    + ` 同种组=${f.sameSpeciesGroups}（其中有差异 ${f.sameSpeciesGroupsWithDifference}）`
    + ` battle_builds=${f.battleBuilds} 引用技能=${f.skillsReferenced}\n`);
  process.stdout.write(`  不在 layer-playable-48 的 species：${(f.outsideLayerSpecies ?? []).map((s) => s.species_id).join(',')}\n`);
  if (f.growthUnknownFields?.length) {
    process.stdout.write(`  仍是 UNKNOWN 的个体属性：${f.growthUnknownFields.map((g) => `${g.field}(×${g.instances})`).join(', ')}\n`);
  }
  const problems = result.problems;
  if (problems.length) {
    process.stdout.write(`问题 ${problems.length} 条：\n`);
    for (const problem of problems.slice(0, 40)) process.stdout.write(`  ${problem}\n`);
    if (problems.length > 40) process.stdout.write(`  …还有 ${problems.length - 40} 条（完整清单见 --json）\n`);
  }

  if (argv.includes('--selftest')) {
    process.stdout.write(`\n必红反证（${SELFTEST_MUTATIONS.length} 条）：\n`);
    const selftest = runSelftest(dataset, {
      caches: store,
      onResult: (entry) => {
        process.stdout.write(`  ${entry.caught ? '红  ' : '没红'} ${entry.id} ${entry.title} → 期望 ${entry.expect}\n`);
        for (const problem of entry.problems.slice(0, 2)) process.stdout.write(`        实际输出：${problem}\n`);
      },
    });
    if (selftest.message) {
      process.stderr.write(`${selftest.message}\n`);
      return 1;
    }
    process.stdout.write(`反证结论：${selftest.ok ? `全部 ${SELFTEST_MUTATIONS.length} 条都翻红` : '有反证没翻红——判据失效'}\n`);
    if (json) {
      process.stdout.write(`${JSON.stringify({checks: result.checks, facts: result.facts, selftest: selftest.results}, null, 2)}\n`);
    }
    return selftest.ok ? 0 : 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ok: result.ok, checks: result.checks, facts: result.facts, problems}, null, 2)}\n`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
